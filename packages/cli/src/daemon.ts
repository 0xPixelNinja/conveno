import { readFile } from "node:fs/promises";
import { dataPaths } from "@0xpixelninja/conveno-core";
import { type Ctx, connectOpts } from "./ctx.js";
import { cmd, errorBlock } from "./fmt.js";

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

async function reachable(ctx: Ctx): Promise<boolean> {
  try {
    const c = await ctx.connect(connectOpts(ctx, false));
    await c.close().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function runDaemon(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const sub = argv[0];
  if (sub === "start") {
    try {
      const c = await ctx.connect(connectOpts(ctx, true));
      await c.close().catch(() => undefined);
    } catch (e) {
      ctx.err(
        errorBlock(
          t,
          "The Conveno daemon did not start",
          [e instanceof Error ? e.message : String(e)],
          `Run ${cmd(t, "conveno doctor")} to check the install, then try again.`,
        ),
      );
      return 1;
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
    if (pid === null || !alive(pid)) {
      ctx.out(`${t.status("info")} The daemon is not running. Nothing to stop.\n`);
      return 0;
    }
    try {
      if (ctx.platform === "win32") {
        const r = await ctx.exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
        if (r.code !== 0) throw new Error(`taskkill exited with code ${r.code}`);
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch (e) {
      ctx.err(
        errorBlock(
          t,
          `Could not stop the daemon (pid ${pid})`,
          [e instanceof Error ? e.message : String(e)],
          `Stop that process yourself, then run ${cmd(t, "conveno daemon status")}.`,
        ),
      );
      return 1;
    }
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    if (alive(pid)) {
      ctx.err(
        errorBlock(
          t,
          `The daemon (pid ${pid}) is still running after 5s`,
          ["It was sent a stop signal but has not exited."],
          `Stop that process yourself, then run ${cmd(t, "conveno daemon status")}.`,
        ),
      );
      return 1;
    }
    ctx.out(`${t.status("ok")} Stopped the daemon (pid ${pid}).\n`);
    return 0;
  }

  ctx.err(
    errorBlock(
      t,
      sub ? `Unknown daemon command "${sub}"` : "conveno daemon needs a command",
      [],
      `Run ${cmd(t, "conveno daemon start")}, ${cmd(t, "conveno daemon stop")} or ${cmd(t, "conveno daemon status")}.`,
    ),
  );
  return 2;
}
