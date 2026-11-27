import type { HookContext } from "./adapter.js";
import { formatHookContext } from "./message-format.js";

/**
 * The text a CLI hook adds to the next turn: the messages waiting for the session that owns the
 * hook's host process, framed as data from peers. Null when there is nothing to add, when no
 * session owns the process, or on any failure. It never throws, so a hook can never break the CLI.
 */
export async function pendingHookContext(ctx: HookContext): Promise<string | null> {
  try {
    const { session } = await ctx.client["session.byHost"]({ pid: ctx.hostPid });
    if (!session) return null;
    const { messages } = await ctx.client["message.deliver"]({ sessionId: session.id });
    const text = formatHookContext(messages);
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
