import type { ConvenoClient } from "@0xpixelninja/conveno-core";
import { type Ctx, connectOpts } from "./ctx.js";

/**
 * `conveno hook <cli> <event>`: reads the CLI's hook JSON on stdin and prints what the adapter
 * returns. Never starts a daemon, never writes to stderr, always exits 0, gives up after the
 * context's timeout (2 s). A hook that fails or stalls must not hold the CLI up.
 */
export async function runHook(ctx: Ctx, argv: string[]): Promise<number> {
  const [cli, event] = argv;
  const adapter = ctx.adapters.find((a) => a.cli === cli);
  if (!adapter || !event) return 0;

  let client: ConvenoClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  const work = (async (): Promise<string> => {
    let input: unknown = {};
    try {
      const raw = await ctx.readStdin();
      if (raw.trim() !== "") input = JSON.parse(raw);
    } catch {
      input = {};
    }
    client = await ctx.connect(connectOpts(ctx, false));
    const out = await adapter.hook(event, input, { client, hostPid: ctx.ppid });
    return out.stdout;
  })();
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), ctx.hookTimeoutMs);
  });

  try {
    const stdout = await Promise.race([work, timeout]);
    if (stdout) ctx.out(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  } catch {
    // no daemon, bad payload, adapter failure: deliver nothing
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
    await Promise.race([
      client?.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 100)),
    ]);
  }
  return 0;
}
