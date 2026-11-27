import { readFile, rm } from "node:fs/promises";
import { dataPaths } from "@0xpixelninja/conveno-core";
import { type Ctx, connectOpts } from "./ctx.js";
import { closest, cmd, fail, plainError } from "./fmt.js";

async function lockPid(ctx: Ctx): Promise<number | null> {
  try {
    const raw = await readFile(dataPaths(ctx.platform, ctx.dataDir).lock, "utf8");
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
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

const SUBCOMMANDS = ["start", "stop", "status"];

export async function runDaemon(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const sub = argv[0];
  if (sub === "start") {
    try {
      const c = await ctx.connect(connectOpts(ctx, true));
      await c.close().catch(() => undefined);
    } catch (e) {
      return fail(ctx, {
        what: "The Conveno daemon did not start",
        detail: [plainError(e)],
        fix: `Run ${cmd(t, "conveno doctor")} to check the install, then try again.`,
        exit: 1,
        ref: "e_daemon_start",
      });
    }
    const pid = await lockPid(ctx);
    ctx.out(`${t.status("ok")} Daemon running${pid ? `, pid ${pid}` : ""}.\n`);
    return 0;
  }

  if (sub === "status") {
    const up = await reachable(ctx);
    const pid = await lockPid(ctx);
    if (up) ctx.out(`${t.status("ok")} daemon running${pid ? `, pid ${pid}` : ""}\n`);
    else ctx.out(`${t.glyph("offline")} daemon not running\n`);
    return up ? 0 : 1;
  }

  if (sub === "stop") {
    const pid = await lockPid(ctx);
    // The lock file can outlive the daemon, and its pid can be reused by an unrelated process.
    // Only a process that answers the Conveno handshake on the socket is ever signalled.
    if (!(await reachable(ctx))) {
      if (pid !== null) {
        await rm(dataPaths(ctx.platform, ctx.dataDir).lock, { force: true }).catch(() => undefined);
        ctx.out(
          `${t.status("info")} Nothing answered as the Conveno daemon, so no process was stopped. Removed the stale lock file (it named pid ${pid}).\n`,
        );
      } else {
        ctx.out(`${t.status("info")} The daemon is not running. Nothing to stop.\n`);
      }
      return 0;
    }
    if (pid === null || !alive(pid)) {
      return fail(ctx, {
        what: "The daemon is running, but its lock file does not name a live process",
        detail: ["Conveno will not guess which process to stop."],
        fix: `Stop the process that owns the daemon socket yourself, then run ${cmd(t, "conveno daemon status")}.`,
        exit: 1,
        ref: "e_daemon_lock",
      });
    }
    try {
      if (ctx.platform === "win32") {
        const r = await ctx.exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
        if (r.code !== 0) throw new Error(`taskkill exited with code ${r.code}`);
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (e) {
      return fail(ctx, {
        what: `Could not stop the daemon (pid ${pid})`,
        detail: [plainError(e)],
        fix: `Stop that process yourself, then run ${cmd(t, "conveno daemon status")}.`,
        exit: 1,
        ref: "e_daemon_stop",
      });
    }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    if (alive(pid)) {
      return fail(ctx, {
        what: `The daemon (pid ${pid}) is still running after 5s`,
        detail: ["It was sent a stop signal but has not exited."],
        fix: `Stop that process yourself, then run ${cmd(t, "conveno daemon status")}.`,
        exit: 1,
        ref: "e_daemon_stop",
      });
    }
    ctx.out(`${t.status("ok")} Stopped the daemon (pid ${pid}).\n`);
    return 0;
  }

  const suggestion = sub ? closest(sub, SUBCOMMANDS) : undefined;
  return fail(ctx, {
    what: sub ? `Unknown daemon command "${sub}"` : "conveno daemon needs a command",
    fix: `Run ${cmd(t, "conveno daemon start")}, ${cmd(t, "conveno daemon stop")} or ${cmd(t, "conveno daemon status")}.`,
    ...(suggestion ? { didYouMean: `Did you mean ${suggestion}?` } : {}),
    exit: 2,
    ref: "e_usage",
  });
}
