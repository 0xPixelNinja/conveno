// Windows command resolution and cmd.exe quoting. Plain TypeScript with erasable syntax only, no
// imports from this package, so packages/e2e/real-cli/run.mjs can load this file directly.
import { statSync } from "node:fs";
import { win32 } from "node:path";

export type Env = Readonly<Record<string, string | undefined>>;

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Pass to spawn/execFile: the cmd.exe command line is already quoted. */
  windowsVerbatimArguments?: true;
}

/** Is this path a regular file. Injected so tests need no Windows disk. */
export type IsFile = (path: string) => boolean;

const defaultIsFile: IsFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Environment variable lookup that ignores case, as Windows does (`Path`, `PATH`, `PathExt`). */
function envGet(env: Env, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === want && v !== undefined) return v;
  }
  return undefined;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** Only these can be started safely: other PATHEXT entries (.JS, .VBS) open Windows Script Host. */
const LAUNCHABLE = new Set([".com", ".exe", ".bat", ".cmd"]);

/**
 * Find `command` the way cmd.exe does: each PATH directory in order, each PATHEXT extension in
 * order. A name that already ends in a launchable extension is tried as written first. Returns
 * undefined when nothing matches.
 */
export function resolveWindowsCommand(
  command: string,
  env: Env,
  isFile: IsFile = defaultIsFile,
): string | undefined {
  const exts = (envGet(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim())
    .filter((e) => LAUNCHABLE.has(e.toLowerCase()));
  const own = win32.extname(command).toLowerCase();
  const candidatesIn = (base: string): string[] => [
    ...(LAUNCHABLE.has(own) ? [base] : []),
    ...exts.map((e) => base + e),
  ];
  const hasDir = /[\\/]/.test(command) || win32.isAbsolute(command);
  const dirs = hasDir
    ? [""]
    : (envGet(env, "PATH") ?? "")
        .split(";")
        .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of candidatesIn(dir === "" ? command : win32.join(dir, command))) {
      if (isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Characters cmd.exe treats specially, plus the ones cross-spawn escapes defensively. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** The program name part of a cmd.exe command line: escape only, never wrap in quotes. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * Quote one argument for a `cmd.exe /d /s /c "..."` command line, the way cross-spawn does:
 * make it safe for the program's own parser (backslashes before a quote are doubled, the quote
 * is backslash-escaped, the whole thing is wrapped in quotes), then caret-escape every
 * character cmd.exe would act on, including the quotes themselves.
 */
export function escapeCmdArg(arg: string): string {
  let a = `${arg}`;
  a = a.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, "$1$1");
  a = `"${a}"`;
  return a.replace(CMD_META, "^$1");
}

/** `cmd.exe /d /s /c "<command line>"` for a .cmd or .bat file. */
export function cmdShimPlan(file: string, args: string[], env: Env): SpawnPlan {
  const line = [escapeCmdCommand(file), ...args.map(escapeCmdArg)].join(" ");
  return {
    file: envGet(env, "ComSpec") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * What to spawn for `command args...`. On Windows the command is resolved on PATH: .exe and .com
 * run directly, .cmd and .bat (npm shims) go through cmd.exe with one quoted command line. Never
 * uses a shell option with an args array. Elsewhere, and when nothing is found, the command is
 * returned unchanged so the caller sees the normal ENOENT.
 */
export function planSpawn(
  command: string,
  args: string[],
  opts: { platform?: string; env?: Env; isFile?: IsFile } = {},
): SpawnPlan {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { file: command, args };
  const env = opts.env ?? process.env;
  const found = resolveWindowsCommand(command, env, opts.isFile);
  if (!found) return { file: command, args };
  const ext = win32.extname(found).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return cmdShimPlan(found, args, env);
  return { file: found, args };
}
