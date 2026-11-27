import { posix, win32 } from "node:path";

/** The only file system question core asks: does this path exist (file or directory)? */
export interface RepoFs {
  exists(path: string): boolean | Promise<boolean>;
}

export interface RepoDetection {
  /** Git root, or null when `cwd` is not inside a git repository. */
  root: string | null;
  /** Basename of the git root, else of `cwd`. Never empty. */
  basename: string;
}

const WIN_PATH = /^[A-Za-z]:[\\/]|^\\\\/;
const pathApi = (p: string) => (WIN_PATH.test(p) ? win32 : posix);

/** Last path segment, tolerating trailing separators. Falls back to "workspace" for roots. */
export function baseName(path: string): string {
  const b = pathApi(path).basename(path);
  return b === "" ? "workspace" : b;
}

/**
 * Walk up from `cwd` looking for `.git` (a directory, or a file for worktrees and submodules).
 * Windows-style paths are handled on any host, so this can be tested everywhere.
 */
export async function detectRepo(cwd: string, fs: RepoFs): Promise<RepoDetection> {
  const p = pathApi(cwd);
  let dir = p.resolve(cwd);
  for (;;) {
    if (await fs.exists(p.join(dir, ".git"))) return { root: dir, basename: baseName(dir) };
    const parent = p.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: null, basename: baseName(cwd) };
}
