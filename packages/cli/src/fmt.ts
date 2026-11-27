import type { Theme } from "@0xpixelninja/conveno-brand";

/** Shorten the home directory to `~`. */
export function tilde(path: string, home: string): string {
  if (path === home) return "~";
  for (const sep of ["/", "\\"]) {
    if (path.startsWith(home + sep)) return `~${sep}${path.slice(home.length + 1)}`;
  }
  return path;
}

/** Length of a string without ANSI escapes. */
export const visibleLength = (s: string): number => s.replace(/\u001b\[[0-9;]*m/g, "").length;

export const padEnd = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - visibleLength(s)));

/** Pad every column to its widest cell. The last column is left unpadded. */
export function columns(rows: string[][], gap = 2): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, i) => (i === row.length - 1 ? cell : padEnd(cell, (widths[i] ?? 0) + gap)))
      .join("")
      .trimEnd(),
  );
}

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `2026-11-27 14:02:11` in the machine's local time. */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** `1.2s` between two times. */
export const seconds = (from: Date, to: Date): string =>
  `${(Math.max(0, to.getTime() - from.getTime()) / 1000).toFixed(1)}s`;

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (row[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}

/** The closest candidate within two edits, or undefined. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = levenshtein(word.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

export interface Failure {
  what: string;
  detail?: string[];
  fix?: string;
  /** Exit code, also printed on the closing line. */
  exit: number;
  /** Stable reference for support, such as `e_usage`. */
  ref: string;
  /** A suggestion line, such as `Did you mean init?`. */
  didYouMean?: string;
}

/** Error block: what happened, detail, fix, then `exit N · ref e_code`. Goes to stderr. */
export function errorBlock(theme: Theme, f: Failure): string {
  const lines = [`${theme.status("error")} ${f.what}`];
  for (const d of f.detail ?? []) lines.push(`  ${d}`);
  if (f.fix) lines.push(`  ${theme.paint("quiet", "fix")}  ${f.fix}`);
  if (f.didYouMean) lines.push(`  ${f.didYouMean}`);
  lines.push("", theme.paint("quiet", `exit ${f.exit} ${theme.glyph("bullet")} ref ${f.ref}`));
  return `${lines.join("\n")}\n`;
}

/** Print an error block on stderr and return its exit code. */
export function fail(ctx: { theme: Theme; err(text: string): void }, f: Failure): number {
  ctx.err(errorBlock(ctx.theme, f));
  return f.exit;
}

/**
 * A message safe to show a user. Errors raised by Node get a plain sentence; errors we wrote
 * pass through. Never a stack trace or a bare `EACCES: ...`.
 */
export function plainError(e: unknown): string {
  if (!(e instanceof Error)) return "Something unexpected stopped the command.";
  const code = (e as NodeJS.ErrnoException).code;
  const path = (e as NodeJS.ErrnoException).path;
  const named = path ?? "a file it needs";
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Conveno has no permission to use ${named}.`;
    case "ENOENT":
      return `${path ?? "A file or folder"} does not exist.`;
    case "ENOSPC":
      return "The disk is full.";
    case "EROFS":
      return `${path ?? "The location"} is read-only.`;
    case "EISDIR":
    case "ENOTDIR":
      return `${path ?? "A path"} is not the kind of entry Conveno expected.`;
    case "EMFILE":
      return "Too many files are open.";
  }
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) {
    return `The system refused an operation (${code}).`;
  }
  if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) {
    return "Conveno hit an internal error.";
  }
  // Library hints about options a user of this command cannot set.
  return e.message.replace(/,? or enable autoStart\.?/i, ".").replace(/\.\.$/, ".");
}

export function warnBlock(theme: Theme, what: string, fix: string, why?: string): string {
  const lines = [`${theme.status("warn")} ${what}`];
  if (why) lines.push(`  ${theme.paint("quiet", "why")}  ${why}`);
  lines.push(`  ${theme.paint("quiet", "fix")}  ${fix}`);
  return `${lines.join("\n")}\n`;
}

/** A command to run, in bold ink. */
export const cmd = (theme: Theme, text: string): string => theme.bold(text);
