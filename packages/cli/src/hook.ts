import type { ConvenoClient } from "@conveno/core";
import { type Ctx, connectOpts } from "./ctx.js";

/**
 * Time allowed for the one process-table query behind the host pid. It runs beside reading
 * stdin and connecting, so it fits well inside the 2 s hook budget. When it fails or runs out, the
 * hook falls back to its direct parent as the host.
 */
export const HOOK_ANCESTRY_TIMEOUT_MS = 1_200;

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
  // Start the process-table query first so it overlaps with reading stdin and connecting.
  const ancestry = ctx.ancestry(HOOK_ANCESTRY_TIMEOUT_MS);
  const work = (async (): Promise<string> => {
    let input: unknown = {};
    try {
      const raw = await ctx.readStdin();
      if (raw.trim() !== "") input = JSON.parse(raw);
    } catch {
      input = {};
    }
    client = await ctx.connect(connectOpts(ctx, false));
    const { hostPid } = await ancestry;
    if (hostPid === undefined) return "";
    const out = await adapter.hook(event, input, { client, hostPid });
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
