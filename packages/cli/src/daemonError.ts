import type { Theme } from "@conveno/brand";
import { ClientError } from "@conveno/client";
import { cmd, plainError } from "./fmt.js";

export interface DaemonProblem {
  /** What went wrong, as a sentence. */
  why: string;
  /** What to do about it. Always matches `why`. */
  fix: string;
  /** True when the only trouble is that no daemon is running. */
  notRunning: boolean;
}

/**
 * Explain a failed connection to the daemon, with a fix that fits the cause. `start` is the command
 * that fixes a daemon that is merely not running.
 */
export function daemonProblem(t: Theme, e: unknown): DaemonProblem {
  const why = plainError(e);
  const kind = e instanceof ClientError ? e.kind : undefined;
  const start = cmd(t, "conveno daemon start");
  const status = cmd(t, "conveno daemon status");
  switch (kind) {
    case "socket_path_too_long":
      return {
        why,
        fix: `Set ${cmd(t, "XDG_RUNTIME_DIR")} to a shorter directory, then run ${start}. Use the same value everywhere you run Conveno and your AI CLIs.`,
        notRunning: false,
      };
    case "permission":
      return {
        why,
        fix: `Check who owns the socket named above. If it is not yours, remove it, then run ${start}.`,
        notRunning: false,
      };
    case "not_daemon":
      return {
        why,
        fix: `Stop the process that owns the socket, or remove the socket, then run ${start}.`,
        notRunning: false,
      };
    case "token_empty":
      return {
        why,
        fix: `Run ${cmd(t, "conveno daemon stop")}, then ${start}.`,
        notRunning: false,
      };
    case "daemon_missing":
      return {
        why,
        fix: `Reinstall Conveno (${cmd(t, "npm install -g @conveno/cli")}), then run ${start}.`,
        notRunning: false,
      };
    case "start_timeout":
      return {
        why,
        fix: `Run ${status} to see whether it came up, or ${cmd(t, "conveno doctor")} to check the install.`,
        notRunning: false,
      };
    case "start_exited":
      return {
        why,
        fix: `Fix what its output above shows, then run ${start}. If it is unclear, report it with that output.`,
        notRunning: false,
      };
    case "connection":
      return { why, fix: `Run ${status}, then try again.`, notRunning: false };
    case "no_daemon":
      return {
        why,
        fix: `Run ${start}. It also starts when a CLI opens the Conveno MCP server.`,
        notRunning: true,
      };
    default:
      return {
        why,
        fix: `Run ${cmd(t, "conveno doctor")} to check the install, then try again.`,
        notRunning: false,
      };
  }
}
