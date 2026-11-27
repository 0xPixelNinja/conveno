import { describe, expect, it } from "vitest";
import {
  evaluateLiveness,
  HEARTBEAT_INTERVAL_MS,
  OFFLINE_AFTER_MS,
  statusAfterLiveness,
} from "./liveness.js";

const alive = () => true;
const dead = () => false;

describe("evaluateLiveness", () => {
  it("has the spec timings", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
    expect(OFFLINE_AFTER_MS).toBe(45_000);
  });
  it("is alive within the window", () => {
    expect(evaluateLiveness({ lastSeenMs: 0, hostPid: 1 }, 44_999, alive)).toEqual({ alive: true });
  });
  it("goes offline at 45s without a heartbeat", () => {
    expect(evaluateLiveness({ lastSeenMs: 0 }, 45_000, alive)).toEqual({
      alive: false,
      reason: "heartbeat_timeout",
    });
  });
  it("goes offline at once when the host pid is dead", () => {
    expect(evaluateLiveness({ lastSeenMs: 1000, hostPid: 42 }, 1001, dead)).toEqual({
      alive: false,
      reason: "host_dead",
    });
  });
  it("skips the pid check when no pid is known", () => {
    expect(evaluateLiveness({ lastSeenMs: 0 }, 10, dead)).toEqual({ alive: true });
  });
  it("passes the pid to isAlive", () => {
    const seen: number[] = [];
    evaluateLiveness({ lastSeenMs: 0, hostPid: 77 }, 1, (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual([77]);
  });
  it("maps verdicts to status", () => {
    expect(statusAfterLiveness("busy", { alive: true })).toBe("busy");
    expect(statusAfterLiveness("busy", { alive: false, reason: "host_dead" })).toBe("offline");
  });
});
