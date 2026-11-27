import { access, readFile, rm } from "node:fs/promises";
import { dataPaths } from "@conveno/core";
import { type Ctx, connectOpts } from "./ctx.js";
import { daemonProblem } from "./daemonError.js";
import { closest, cmd, fail, plainError, warnBlock } from "./fmt.js";

async function lockPid(ctx: Ctx): Promise<number | null> {
  try {
    const raw = await readFile(dataPaths(ctx.platform, ctx.dataDir).lock, "utf8");
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Does something on the socket answer the Conveno handshake? */
async function reachable(ctx: Ctx): Promise<boolean> {
  try {
    const c = await ctx.connect(connectOpts(ctx, false));
    await c.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

const lockExists = (ctx: Ctx): Promise<boolean> =>
  access(dataPaths(ctx.platform, ctx.dataDir).lock).then(
    () => true,
    () => false,
  );

/** Poll until `done()` holds or `ms` pass. Returns whether it held. */
async function waitFor(done: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

const norm = (text: string): string => text.replaceAll("\\", "/").toLowerCase();

/**
 * Does this command line belong to the Conveno daemon? It must run the daemon's entry script:
 * the one this install resolved, or any `@conveno/daemon` package's `bin.js`.
 */
export function isConvenoDaemonCommand(commandLine: string, daemonEntry?: string): boolean {
  const line = norm(commandLine);
  if (daemonEntry !== undefined && line.includes(norm(daemonEntry))) return true;
  return /@conveno\/daemon\/(?:[^ ]+\/)?bin\.js/.test(line);
}

const STOP_FIX = (t: Ctx["theme"]) => `then run ${cmd(t, "conveno daemon status")}`;

/**
 * `conveno daemon stop`. The normal path asks the daemon to shut itself down over the control
 * channel (`daemon.shutdown`), the way Docker and pm2 do. That needs no signal and no external
 * tool, so it works for a normal user in a Windows SSH session. Only when the daemon does not answer,
 * and its lock pid is verified to be the daemon, is the process ended directly.
 */
async function stopDaemon(ctx: Ctx): Promise<number> {
  const t = ctx.theme;
  const lock = dataPaths(ctx.platform, ctx.dataDir).lock;
  const pid = await lockPid(ctx);
  const named = pid === null ? "" : ` (pid ${pid})`;

  let client: Awaited<ReturnType<Ctx["connect"]>> | undefined;
  try {
    client = await ctx.connect(connectOpts(ctx, false));
  } catch {
    client = undefined;
  }

  if (client) {
    try {
      await client["daemon.shutdown"]({});
    } catch (e) {
      await client.close().catch(() => undefined);
      return fail(ctx, {
        what: `The daemon${named} did not accept the stop request`,
        detail: [plainError(e)],
        fix: `${pid === null ? "Stop the process that owns the daemon socket yourself" : `Stop pid ${pid} yourself`}, ${STOP_FIX(t)}.`,
        exit: 1,
        ref: "e_daemon_stop",
      });
    }
    await client.close().catch(() => undefined);
    // Stopped means the process has exited, not only that it let go of the socket and the lock:
    // until it exits it can still hold files open (on Windows that blocks deleting them).
    const gone = await waitFor(
      async () =>
        !(await reachable(ctx)) && !(await lockExists(ctx)) && (pid === null || !ctx.isAlive(pid)),
      ctx.stopTimeoutMs,
    );
    if (!gone) {
      return fail(ctx, {
        what: `The daemon${named} is still running after ${Math.round(ctx.stopTimeoutMs / 1000)}s`,
        detail: [
          "It accepted the stop request, but its process, socket or lock file is still there.",
        ],
        fix: `${pid === null ? "Stop the process that owns the daemon socket yourself" : `Stop pid ${pid} yourself`}, ${STOP_FIX(t)}.`,
        exit: 1,
        ref: "e_daemon_stop",
      });
    }
    ctx.out(`${t.status("ok")} Stopped the daemon${named}.\n`);
    return 0;
  }

  // Nothing answers the Conveno handshake. The lock file may be stale, and its pid may have been
  // reused by an unrelated process, so a process is ended only when it is shown to be the daemon.
  if (pid === null) {
    ctx.out(`${t.status("info")} The daemon is not running. Nothing to stop.\n`);
    return 0;
  }
  const stale = async (): Promise<number> => {
    await rm(lock, { force: true }).catch(() => undefined);
    ctx.out(
      `${t.status("info")} Nothing answered as the Conveno daemon, so no process was stopped. Removed the stale lock file (it named pid ${pid}).\n`,
    );
    return 0;
  };
  if (!ctx.isAlive(pid)) return stale();
  const commandLine = await ctx.commandLineOf(pid);
  if (commandLine === null) {
    return fail(ctx, {
      what: `The daemon did not answer, and pid ${pid} could not be checked`,
      detail: [
        "Conveno could not read that process's command line, so it cannot tell whether it is the daemon. It stopped nothing.",
      ],
      fix: `If pid ${pid} is the Conveno daemon, end it yourself (Task Manager on Windows, \`kill ${pid}\` elsewhere), ${STOP_FIX(t)}.`,
      exit: 1,
      ref: "e_daemon_lock",
    });
  }
  if (!isConvenoDaemonCommand(commandLine, ctx.daemonEntry)) return stale();

  try {
    ctx.kill(pid);
  } catch (e) {
    return fail(ctx, {
      what: `Could not stop the daemon (pid ${pid})`,
      detail: [plainError(e)],
      fix: `Stop that process yourself, ${STOP_FIX(t)}.`,
      exit: 1,
      ref: "e_daemon_stop",
    });
  }
  if (!(await waitFor(() => !ctx.isAlive(pid), ctx.stopTimeoutMs))) {
    return fail(ctx, {
      what: `The daemon (pid ${pid}) is still running after ${Math.round(ctx.stopTimeoutMs / 1000)}s`,
      detail: ["It did not answer, was ended, and has not exited."],
      fix: `Stop that process yourself, ${STOP_FIX(t)}.`,
      exit: 1,
      ref: "e_daemon_stop",
    });
  }
  // An ended daemon cannot clean up after itself (TerminateProcess gives it no chance).
  await rm(lock, { force: true }).catch(() => undefined);
  ctx.out(
    `${t.status("ok")} Stopped the daemon (pid ${pid}). It was not answering, so it was ended directly.\n`,
  );
  return 0;
}

const SUBCOMMANDS = ["start", "stop", "status"];

export async function runDaemon(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const sub = argv[0];
  if (sub === "start") {
    try {
      const c = await ctx.connect(connectOpts(ctx, true));
      await c.close().catch(() => undefined);
    } catch (e) {
      const problem = daemonProblem(t, e);
      return fail(ctx, {
        what: "The Conveno daemon did not start",
        detail: [problem.why],
        // A start that fails because no daemon is running is a start failure: doctor is the next step.
        fix: problem.notRunning
          ? `Run ${cmd(t, "conveno doctor")} to check the install, then try again.`
          : problem.fix,
        exit: 1,
        ref: "e_daemon_start",
      });
    }
    const pid = await lockPid(ctx);
    ctx.out(`${t.status("ok")} Daemon running${pid ? `, pid ${pid}` : ""}.\n`);
    return 0;
  }

  if (sub === "status") {
    const pid = await lockPid(ctx);
    try {
      const c = await ctx.connect(connectOpts(ctx, false));
      await c.close().catch(() => undefined);
      ctx.out(`${t.status("ok")} daemon running${pid ? `, pid ${pid}` : ""}\n`);
      return 0;
    } catch (e) {
      const problem = daemonProblem(t, e);
      if (problem.notRunning) {
        ctx.out(`${t.glyph("offline")} daemon not running\n`);
      } else {
        ctx.out(`${t.status("error")} daemon cannot be reached\n`);
        ctx.err(warnBlock(t, "The Conveno daemon cannot be reached.", problem.fix, problem.why));
      }
      return 1;
    }
  }

  if (sub === "stop") return stopDaemon(ctx);

  const suggestion = sub ? closest(sub, SUBCOMMANDS) : undefined;
  return fail(ctx, {
    what: sub ? `Unknown daemon command "${sub}"` : "conveno daemon needs a command",
    fix: `Run ${cmd(t, "conveno daemon start")}, ${cmd(t, "conveno daemon stop")} or ${cmd(t, "conveno daemon status")}.`,
    ...(suggestion ? { didYouMean: `Did you mean ${suggestion}?` } : {}),
    exit: 2,
    ref: "e_usage",
  });
}
