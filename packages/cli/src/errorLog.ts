import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "./ctx.js";
import { VERSION } from "./version.js";

/** The message of an unexpected error, as it is. Not the softened text `plainError` gives. */
export function rawMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/**
 * Write the full stack of an unexpected error to `<data dir>/logs/<timestamp>-error.log`, readable
 * by the user only. Returns the path, or undefined when the log could not be written (the error is
 * still reported, just without a log).
 */
export async function writeErrorLog(
  ctx: Ctx,
  argv: string[],
  e: unknown,
): Promise<string | undefined> {
  try {
    const dir = join(ctx.dataDir, "logs");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = ctx.now().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}-error.log`);
    // Only the command name and subcommand: arguments can hold paths or message text.
    const command = argv.slice(0, 2).join(" ");
    const text = [
      `conveno ${VERSION} ${command}`,
      "ref       e_internal",
      `time      ${ctx.now().toISOString()}`,
      `platform  ${ctx.platform}, node ${process.version}`,
      "",
      e instanceof Error ? (e.stack ?? rawMessage(e)) : rawMessage(e),
      e instanceof Error && e.cause !== undefined
        ? `\nCaused by: ${e.cause instanceof Error ? (e.cause.stack ?? rawMessage(e.cause)) : String(e.cause)}`
        : "",
      "",
    ].join("\n");
    await writeFile(file, text, { mode: 0o600 });
    await chmod(file, 0o600).catch(() => undefined);
    return file;
  } catch {
    return undefined;
  }
}
