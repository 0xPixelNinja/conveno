import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";

/** Thrown when another Conveno daemon already owns the lock file or answers on the socket. */
export class DaemonAlreadyRunningError extends Error {
  constructor(detail: string) {
    super(
      `The Conveno daemon is already running (${detail}). Run "conveno daemon status" to see it.`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

/** `kill(pid, 0)` liveness: EPERM means the process exists but belongs to someone else. */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True when something accepts connections on the socket or pipe. */
export function probeSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(socketPath);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** A lock younger than this is trusted even if the socket does not answer yet (daemon booting). */
const LOCK_GRACE_MS = 5_000;

/**
 * Create the lock file exclusively. The lock records the pid and the socket path of its owner.
 * An existing lock is stale unless its pid is alive and either the socket recorded in the lock
 * answers or the lock is brand new. The recorded socket is probed, not the new daemon's own, so
 * a daemon started with a different socket path is still seen as running. Returns a function that
 * releases the lock.
 */
export async function acquireLock(lockPath: string, socketPath: string): Promise<() => void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, socketPath }), {
        flag: "wx",
        mode: 0o600,
      });
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = 0;
    let lockedSocket = socketPath;
    let ageMs = Number.POSITIVE_INFINITY;
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        pid?: number;
        socketPath?: string;
      };
      pid = lock.pid ?? 0;
      if (typeof lock.socketPath === "string" && lock.socketPath !== "") {
        lockedSocket = lock.socketPath;
      }
      ageMs = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // unreadable or corrupt lock: treat as stale
    }
    if (
      pid > 0 &&
      defaultIsAlive(pid) &&
      (ageMs < LOCK_GRACE_MS || (await probeSocket(lockedSocket)))
    ) {
      throw new DaemonAlreadyRunningError(`pid ${pid}`);
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // someone else removed it first; retry
    }
  }
  throw new DaemonAlreadyRunningError("could not take the lock file");
}

/**
 * POSIX only: remove a leftover socket file, but only after confirming no live daemon answers on it.
 * Named pipes on Windows vanish with their owner, so there is nothing to remove.
 */
export async function clearStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === "win32" || socketPath.startsWith("\\\\")) return;
  if (!existsSync(socketPath)) return;
  if (await probeSocket(socketPath)) throw new DaemonAlreadyRunningError(`socket ${socketPath}`);
  try {
    unlinkSync(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Read the auth token, creating it (32 random bytes, hex) with mode 0600 on first start.
 * On Windows the mode is ignored; the file inherits the ACL of the per-user data directory.
 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const t = readFileSync(tokenPath, "utf8").trim();
    if (t.length >= 32) {
      if (process.platform !== "win32") chmodSync(tokenPath, 0o600);
      return t;
    }
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tokenPath, 0o600);
  return token;
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
