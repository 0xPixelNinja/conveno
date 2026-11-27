import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** A log file is rotated to `<path>.1` once it reaches this size, so it never grows without bound. */
export const LOG_MAX_BYTES = 1024 * 1024;

export interface DaemonLog {
  /** Where the log is written. */
  readonly path: string;
  /** Record an unexpected error with its stack. Never throws. */
  error(what: string, e: unknown): void;
}

export interface DaemonLogOptions {
  maxBytes?: number;
  now?: () => Date;
}

const describeError = (e: unknown): string =>
  e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e);

/**
 * The daemon's own log, for errors it did not expect. One file, readable by the user only, with one
 * older generation kept: when the file reaches `maxBytes` it replaces `<path>.1` and a new file
 * starts. Request parameters are never logged, since they can hold message text.
 */
export function createDaemonLog(path: string, opts: DaemonLogOptions = {}): DaemonLog {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  return {
    path,
    error(what, e) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        let size = 0;
        try {
          size = statSync(path).size;
        } catch {
          // No log yet.
        }
        if (size >= maxBytes) {
          rmSync(`${path}.1`, { force: true });
          renameSync(path, `${path}.1`);
        }
        appendFileSync(path, `${now().toISOString()} ${what}\n${describeError(e)}\n\n`, {
          mode: 0o600,
        });
        if (process.platform !== "win32") chmodSync(path, 0o600);
      } catch {
        // Logging must never take the daemon down.
      }
    },
  };
}
