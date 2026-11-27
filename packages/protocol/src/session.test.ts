import { describe, expect, it } from "vitest";
import { sessionFixture } from "./fixtures.js";
import { newSessionId } from "./ids.js";
import { CLI_KINDS, SessionName } from "./primitives.js";
import { Session } from "./session.js";

describe("SessionName", () => {
  it.each(["a", "claude@repo-1", "codex.2", "0abc", "a_b", "x".repeat(64)])("accepts %s", (n) => {
    expect(SessionName.safeParse(n).success).toBe(true);
  });

  it.each([
    "",
    "-leading-dash",
    ".leading-dot",
    "@leading-at",
    "Upper",
    "has space",
    "slash/name",
    "x".repeat(65),
    "ünï",
    "line\nbreak",
    "orchestrator",
    "conveno",
    "system",
    "user",
  ])("rejects %j", (n) => {
    expect(SessionName.safeParse(n).success).toBe(false);
  });

  it("never collides with a ULID", () => {
    expect(SessionName.safeParse(newSessionId()).success).toBe(false);
  });
});

describe("Session", () => {
  it("accepts a minimal session", () => {
    expect(Session.safeParse(sessionFixture()).success).toBe(true);
  });

  it("accepts every optional field", () => {
    const r = Session.safeParse(
      sessionFixture({
        cliVersion: "2.1.0",
        repo: { root: "/home/u/repo", remoteUrlHash: "a".repeat(64) },
        pid: 4242,
        statusText: "refactoring auth",
        spawnedBy: newSessionId(),
        spawnDepth: 1,
      }),
    );
    expect(r.success).toBe(true);
  });

  it.each(CLI_KINDS)("accepts cli %s", (cli) => {
    expect(Session.safeParse(sessionFixture({ cli })).success).toBe(true);
  });

  it("rejects unknown cli, status and tier", () => {
    expect(Session.safeParse(sessionFixture({ cli: "vim" })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ status: "sleeping" })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ deliveryTier: "carrier-pigeon" })).success).toBe(
      false,
    );
  });

  it("enforces statusText <= 200 chars", () => {
    expect(Session.safeParse(sessionFixture({ statusText: "x".repeat(200) })).success).toBe(true);
    expect(Session.safeParse(sessionFixture({ statusText: "x".repeat(201) })).success).toBe(false);
  });

  it("enforces spawnDepth to be a non-negative integer", () => {
    expect(Session.safeParse(sessionFixture({ spawnDepth: -1 })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ spawnDepth: 1.5 })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ spawnDepth: 2 })).success).toBe(true);
  });

  it("rejects bad timestamps, ids, hashes and pid", () => {
    expect(Session.safeParse(sessionFixture({ startedAt: "yesterday" })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ lastSeenAt: "2026-11-27" })).success).toBe(false);
    expect(Session.safeParse(sessionFixture({ id: "nope" })).success).toBe(false);
    expect(
      Session.safeParse(sessionFixture({ repo: { root: "/r", remoteUrlHash: "XYZ" } })).success,
    ).toBe(false);
    expect(Session.safeParse(sessionFixture({ pid: 0 })).success).toBe(false);
  });

  it("requires core fields", () => {
    for (const k of [
      "id",
      "name",
      "cli",
      "deviceId",
      "cwd",
      "status",
      "isOrchestrator",
      "deliveryTier",
      "spawnDepth",
      "startedAt",
      "lastSeenAt",
    ]) {
      const s = sessionFixture() as Record<string, unknown>;
      delete s[k];
      expect(Session.safeParse(s).success, k).toBe(false);
    }
  });
});
