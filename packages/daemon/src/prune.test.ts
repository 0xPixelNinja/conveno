import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRUNE_OFFLINE_AFTER_MS,
  PRUNE_SUPERSEDED_AFTER_MS,
  PRUNE_UNREAD_AFTER_MS,
} from "./server.js";
import { type Harness, register, startHarness } from "./test-utils.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

const HOUR = 3_600_000;

/** Make a session offline by killing its host, then sweep. */
async function goOffline(hostPid: number): Promise<void> {
  h.dead.add(hostPid);
  h.clock.ms += 1_000;
  h.daemon.sweep();
}

const ids = async (): Promise<string[]> => {
  const c = await h.authed();
  const { sessions } = await c.call("session.list", { includeOffline: true });
  return sessions.map((s: { id: string }) => s.id);
};

describe("pruning offline sessions", () => {
  it("keeps an offline session for a day, then deletes it", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPid: 7001 })).session;
    await goOffline(7001);
    h.clock.ms += PRUNE_OFFLINE_AFTER_MS - 2_000;
    h.daemon.sweep();
    expect(await ids()).toEqual([a.id]);
    h.clock.ms += 2_000;
    h.daemon.sweep();
    expect(await ids()).toEqual([]);
  });

  it("deletes a session sooner once a newer live one has its name, CLI and repo", async () => {
    const c = await h.authed();
    const old = (await register(c, { hostPid: 7001, cwd: "/work/api" })).session;
    await goOffline(7001);
    const fresh = (await register(c, { hostPid: 7002, cwd: "/work/api" })).session;
    expect(fresh.name).toBe(old.name);
    h.clock.ms += PRUNE_SUPERSEDED_AFTER_MS - 2_000;
    h.daemon.sweep();
    expect(await ids()).toEqual(expect.arrayContaining([old.id, fresh.id]));
    h.clock.ms += 2_000;
    // The live session keeps heartbeating.
    await c.call("session.heartbeat", { sessionId: fresh.id });
    h.daemon.sweep();
    expect(await ids()).toEqual([fresh.id]);
  });

  it("does not treat a session in another repo or CLI as a replacement", async () => {
    const c = await h.authed();
    const old = (await register(c, { hostPid: 7001, cwd: "/work/api" })).session;
    await goOffline(7001);
    const otherRepo = (await register(c, { hostPid: 7002, cwd: "/work/docs" })).session;
    const otherCli = (await register(c, { hostPid: 7003, cwd: "/work/api", cli: "codex" })).session;
    h.clock.ms += PRUNE_SUPERSEDED_AFTER_MS + 1_000;
    await c.call("session.heartbeat", { sessionId: otherRepo.id });
    await c.call("session.heartbeat", { sessionId: otherCli.id });
    h.daemon.sweep();
    expect(await ids()).toContain(old.id);
  });

  it("keeps an offline session that has unread messages until the unread limit", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPid: 7001, name: "alpha" })).session;
    const b = (await register(c, { hostPid: 7002, name: "beta" })).session;
    await c.call("message.send", {
      sessionId: b.id,
      to: "alpha",
      kind: "text",
      body: { text: "do not lose me" },
    });
    await goOffline(7001);
    // Past the day limit, and a newer session has even taken the name.
    await register(c, { hostPid: 7003, name: "alpha" });
    h.clock.ms += PRUNE_OFFLINE_AFTER_MS + HOUR;
    await c.call("session.heartbeat", { sessionId: b.id });
    h.daemon.sweep();
    expect(await ids()).toContain(a.id);
    h.clock.ms += PRUNE_UNREAD_AFTER_MS - PRUNE_OFFLINE_AFTER_MS;
    h.daemon.sweep();
    expect(await ids()).not.toContain(a.id);
  });

  it("does not hold mail that was already read", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPid: 7001, name: "alpha" })).session;
    const b = (await register(c, { hostPid: 7002, name: "beta" })).session;
    await c.call("message.send", {
      sessionId: b.id,
      to: "alpha",
      kind: "text",
      body: { text: "seen" },
    });
    await c.call("message.inbox", { sessionId: a.id });
    await goOffline(7001);
    h.clock.ms += PRUNE_OFFLINE_AFTER_MS;
    await c.call("session.heartbeat", { sessionId: b.id });
    h.daemon.sweep();
    expect(await ids()).not.toContain(a.id);
  });

  it("never deletes an online session", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    for (let i = 0; i < 100; i++) {
      h.clock.ms += ((6 * HOUR) / 100) * 10;
      await c.call("session.heartbeat", { sessionId: a.id });
      h.daemon.sweep();
    }
    expect(await ids()).toEqual([a.id]);
  });
});
