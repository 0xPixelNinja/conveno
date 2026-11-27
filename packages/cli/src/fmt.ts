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

/** Error block: what happened, detail, fix. Goes to stderr. */
export function errorBlock(theme: Theme, what: string, detail: string[], fix?: string): string {
  const lines = [`${theme.status("error")} ${what}`];
  for (const d of detail) lines.push(`  ${d}`);
  if (fix) lines.push(`  ${theme.paint("quiet", "fix")}  ${fix}`);
  return `${lines.join("\n")}\n`;
}

export function warnBlock(theme: Theme, what: string, fix: string, why?: string): string {
  const lines = [`${theme.status("warn")} ${what}`];
  if (why) lines.push(`  ${theme.paint("quiet", "why")}  ${why}`);
  lines.push(`  ${theme.paint("quiet", "fix")}  ${fix}`);
  return `${lines.join("\n")}\n`;
}

/** A command to run, in bold ink. */
export const cmd = (theme: Theme, text: string): string => theme.bold(text);
