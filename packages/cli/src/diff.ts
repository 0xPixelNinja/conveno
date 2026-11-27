import type { Theme } from "@0xpixelninja/conveno-brand";

type Op = { t: " " | "-" | "+"; line: string };

const splitLines = (s: string): string[] => {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Line diff through the longest common subsequence. Fine for config files. */
function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const mid: Op[] = [];
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (x.length * y.length > 4_000_000) {
    for (const line of x) mid.push({ t: "-", line });
    for (const line of y) mid.push({ t: "+", line });
  } else {
    const w = y.length + 1;
    const lcs = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        lcs[i * w + j] =
          x[i] === y[j]
            ? (lcs[(i + 1) * w + j + 1] as number) + 1
            : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        mid.push({ t: " ", line: x[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
        mid.push({ t: "-", line: x[i++] as string });
      } else {
        mid.push({ t: "+", line: y[j++] as string });
      }
    }
    while (i < x.length) mid.push({ t: "-", line: x[i++] as string });
    while (j < y.length) mid.push({ t: "+", line: y[j++] as string });
  }
  return [
    ...a.slice(0, start).map((line): Op => ({ t: " ", line })),
    ...mid,
    ...a.slice(endA).map((line): Op => ({ t: " ", line })),
  ];
}

/** Unified diff body (hunks only) between two texts, `before` null meaning a new file. */
export function unifiedDiff(before: string | null, after: string, context = 2): string[] {
  const ops = diffOps(splitLines(before ?? ""), splitLines(after));
  const changed = ops.flatMap((o, i) => (o.t === " " ? [] : [i]));
  if (changed.length === 0) return [];

  // Group changed indexes into hunks that keep `context` lines around them.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context);
    const hi = Math.min(ops.length, i + context + 1);
    const last = ranges.at(-1);
    if (last && lo <= last[1]) last[1] = hi;
    else ranges.push([lo, hi]);
  }

  const out: string[] = [];
  for (const [lo, hi] of ranges) {
    let oldStart = 1;
    let newStart = 1;
    for (const o of ops.slice(0, lo)) {
      if (o.t !== "+") oldStart++;
      if (o.t !== "-") newStart++;
    }
    const slice = ops.slice(lo, hi);
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    const oldFrom = oldCount === 0 ? oldStart - 1 : oldStart;
    out.push(`@@ -${oldFrom},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
  }
  return out;
}

/** Colour diff lines with brand roles: added `ok`, removed `error`, hunk headers `quiet`. */
export function paintDiff(theme: Theme, lines: string[], indent = "    "): string[] {
  return lines.map((l) => {
    const role = l.startsWith("@@")
      ? "quiet"
      : l.startsWith("+")
        ? "ok"
        : l.startsWith("-")
          ? "error"
          : null;
    return indent + (role ? theme.paint(role, l) : l);
  });
}
