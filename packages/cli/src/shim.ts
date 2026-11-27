// Windows shim detection: is the `conveno` that PATH finds a launcher for this very install?
// npm (cmd-shim) and pnpm (@zkochan/cmd-shim) both write a `conveno.cmd` and a `conveno.ps1` that
// name the target script. Reading that target is the only way to compare a shim with `bin.js`.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { type Env, resolveWindowsCommand } from "./win-spawn.js";

/** File access for shim detection, injected so tests need no Windows disk. */
export interface ShimIo {
  isFile(path: string): boolean;
  readFile(path: string): string | undefined;
  realpath(path: string): string | undefined;
}

export const defaultShimIo: ShimIo = {
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return undefined;
    }
  },
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  },
};

/** The last quoted script path in a shim: the one handed to node (earlier ones are node.exe). */
function lastMatch(text: string, re: RegExp): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(re)) last = m;
  return last;
}

/**
 * Target script of a `.cmd` shim, relative to the shim's directory (or absolute). Handles
 * `"%dp0%\..\x\bin.js"` (npm, cmd-shim) and `"%~dp0\..\x\bin.js"` (pnpm). Undefined when the text
 * is not a recognisable node shim.
 */
export function parseCmdShimTarget(text: string): string | undefined {
  const m = lastMatch(text, /"(%dp0%|%~dp0)?([^"\r\n]*?\.[cm]?js)"/gi);
  return m && (m[1] ? m[2]?.replace(/^[\\/]+/, "") : m[2]);
}

/** Target script of a `.ps1` shim: `"$basedir/../x/bin.js"`, as written by both managers. */
export function parsePs1ShimTarget(text: string): string | undefined {
  const m = lastMatch(text, /"(\$basedir)?([^"\r\n]*?\.[cm]?js)"/gi);
  return m && (m[1] ? m[2]?.replace(/^[\\/]+/, "") : m[2]);
}

const norm = (p: string): string =>
  win32
    .normalize(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase();

/** Does the shim file at `shimPath` start `binPath`? */
export function shimPointsAt(
  shimPath: string,
  binPath: string,
  io: ShimIo = defaultShimIo,
): boolean {
  const text = io.readFile(shimPath);
  if (text === undefined) return false;
  const ext = win32.extname(shimPath).toLowerCase();
  const target = ext === ".ps1" ? parsePs1ShimTarget(text) : parseCmdShimTarget(text);
  if (!target) return false;
  const full = win32.resolve(win32.dirname(shimPath), target);
  const same = (a: string, b: string): boolean => norm(a) === norm(b);
  if (same(full, binPath)) return true;
  const a = io.realpath(full);
  const b = io.realpath(binPath);
  return a !== undefined && b !== undefined && same(a, b);
}

/** First `conveno.ps1` on PATH, for shells where PATHEXT does not list .PS1. */
function findPs1(env: Env, io: ShimIo): string | undefined {
  const path = Object.entries(env).find(([k]) => k.toLowerCase() === "path")?.[1] ?? "";
  for (const raw of path.split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (dir && io.isFile(win32.join(dir, "conveno.ps1"))) return win32.join(dir, "conveno.ps1");
  }
  return undefined;
}

/**
 * Windows form of "the first `conveno` on PATH is this install". The command is resolved with
 * the PATH and PATHEXT rules of cmd.exe (`conveno.cmd`), falling back to `conveno.ps1`; the shim
 * is then read and its target compared with `binPath`.
 */
export function windowsConvenoIsThisInstall(
  env: Env,
  binPath: string,
  io: ShimIo = defaultShimIo,
): boolean {
  const found = resolveWindowsCommand("conveno", env, io.isFile);
  const shim = found && /\.(cmd|bat)$/i.test(found) ? found : findPs1(env, io);
  return shim !== undefined && shimPointsAt(shim, binPath, io);
}
