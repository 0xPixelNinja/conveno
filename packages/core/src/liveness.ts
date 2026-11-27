import type { SessionStatus } from "@conveno/protocol";

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const OFFLINE_AFTER_MS = 45_000;

export interface LivenessInput {
  /** Epoch milliseconds of the last heartbeat (or registration). */
  lastSeenMs: number;
  /**
   * The first entry of the session's `hostPids`: the process that launched the MCP server. When
   * it dies the MCP server is orphaned and the session is over. The farther entries (the CLI, a
   * shell, a terminal) are only used to match hooks. Some of them outlive the session, so they
   * say nothing about whether it is alive.
   */
  hostPid?: number | undefined;
}

export type LivenessVerdict =
  | { alive: true }
  | { alive: false; reason: "heartbeat_timeout" | "host_dead" };

/**
 * A session is offline once 45 s pass without a heartbeat, or as soon as its host process is gone.
 * `isAlive` is injected so the check stays pure and testable.
 */
export function evaluateLiveness(
  input: LivenessInput,
  nowMs: number,
  isAlive: (pid: number) => boolean,
): LivenessVerdict {
  if (input.hostPid !== undefined && !isAlive(input.hostPid)) {
    return { alive: false, reason: "host_dead" };
  }
  if (nowMs - input.lastSeenMs >= OFFLINE_AFTER_MS) {
    return { alive: false, reason: "heartbeat_timeout" };
  }
  return { alive: true };
}

/** Status after a liveness check: dead sessions are `offline`, live ones keep their status. */
export function statusAfterLiveness(
  current: SessionStatus,
  verdict: LivenessVerdict,
): SessionStatus {
  if (!verdict.alive) return "offline";
  return current;
}

export const isOnline = (s: { status: SessionStatus }): boolean => s.status !== "offline";
