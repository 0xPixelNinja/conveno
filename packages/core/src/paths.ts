import { posix, win32 } from "node:path";
import type { PathEnv } from "@conveno/protocol";

const pathApi = (platform: string) => (platform === "win32" ? win32 : posix);

/**
 * Conveno data directory. Pure: platform, environment and home directory are arguments.
 *
 * - linux and other posix: `$XDG_DATA_HOME/conveno` (absolute only), else `~/.local/share/conveno`
 * - darwin: `~/Library/Application Support/conveno`
 * - win32: `%LOCALAPPDATA%\conveno`, else `<home>\AppData\Local\conveno`
 */
export function dataDir(platform: string, env: PathEnv, homedir?: string): string {
  const p = pathApi(platform);
  const home = platform === "win32" ? (env.USERPROFILE ?? homedir) : env.HOME || homedir;
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local) return p.join(local, "conveno");
    if (!home) throw new Error("cannot determine LOCALAPPDATA or home directory for the data dir");
    return p.join(home, "AppData", "Local", "conveno");
  }
  if (platform === "darwin") {
    if (!home) throw new Error("cannot determine home directory for the data dir");
    return p.join(home, "Library", "Application Support", "conveno");
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg?.startsWith("/")) return p.join(xdg, "conveno");
  if (!home) throw new Error("cannot determine home directory for the data dir");
  return p.join(home, ".local", "share", "conveno");
}

/** Files and folders inside the data dir, joined with the platform's separator. */
export function dataPaths(platform: string, dir: string) {
  const p = pathApi(platform);
  return {
    dir,
    token: p.join(dir, "daemon.token"),
    database: p.join(dir, "conveno.db"),
    lock: p.join(dir, "daemon.lock"),
    backups: p.join(dir, "backups"),
    /** The CLI writes its error logs here, and the daemon writes `daemon.log`. */
    logs: p.join(dir, "logs"),
    daemonLog: p.join(dir, "logs", "daemon.log"),
    /** What the daemon printed to stdout and stderr, from the last time a client started it. */
    daemonStartLog: p.join(dir, "logs", "daemon-start.log"),
    manifest: p.join(dir, "install-manifest.json"),
  };
}
