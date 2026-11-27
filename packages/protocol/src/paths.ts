export type PathEnv = Readonly<Record<string, string | undefined>>;

const trimTrailingSlashes = (p: string) => p.replace(/\/+$/, "");

/**
 * Default daemon endpoint. Pure: takes the platform and environment explicitly.
 *
 * - posix: `$XDG_RUNTIME_DIR/caucus/caucusd.sock`, else `~/.caucus/run/caucusd.sock`
 *   (`~` is `env.HOME`, else the `homedir` argument).
 * - win32: the named pipe `\\.\pipe\caucusd-<username>` (`env.USERNAME`, characters outside
 *   `[A-Za-z0-9._-]` replaced by `_`).
 *
 * Note: Unix socket paths are limited to ~104 bytes on macOS and ~108 on Linux.
 */
export function defaultSocketPath(platform: string, env: PathEnv, homedir?: string): string {
  if (platform === "win32") {
    const user = (env.USERNAME ?? env.USER ?? "user").replace(/[^A-Za-z0-9._-]/g, "_") || "user";
    return `\\\\.\\pipe\\caucusd-${user}`;
  }
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg?.startsWith("/")) {
    return `${trimTrailingSlashes(xdg)}/caucus/caucusd.sock`;
  }
  const home = env.HOME || homedir;
  if (!home) throw new Error("cannot determine home directory for default socket path");
  return `${trimTrailingSlashes(home)}/.caucus/run/caucusd.sock`;
}
