import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRUNE_MISSING_FOLDER_AFTER_MS } from "./server.js";
import { type Harness, type RawClient, register, startHarness } from "./test-utils.js";

const HOUR = 3_600_000;
const gone = new Set<string>();

let h: Harness;
let c: RawClient;
beforeEach(async () => {
  gone.clear();
  h = await startHarness({ pathExists: (p) => !gone.has(p) });
  c = await h.authed();
});
afterEach(async () => {
  await h.stop();
});

/** Register a session hosted by a fake pid. */
const make = async (name: string, hostPid: number, over: Record<string, unknown> = {}) =>
  (await register(c, { name, hostPid, ...over })).session;

/** Kill the host and sweep so the session goes offline. */
function takeOffline(hostPid: number): void {
  h.dead.add(hostPid);
  h.clock.ms += 1_000;
  h.daemon.sweep();
}

/** Let the missing-folder grace pass, then sweep. */
function sweepAfterGrace(): void {
  h.clock.ms += PRUNE_MISSING_FOLDER_AFTER_MS;
  h.daemon.sweep();
}

const listed = async (): Promise<string[]> =>
  (await c.call("session.list", { includeOffline: true })).sessions.map((s) => s.name).sort();

describe("session.forget", () => {
  it("removes offline sessions by name and never an online one", async () => {
    await make("old", 7001);
    await make("live", 7002);
    takeOffline(7001);
    const r = await c.call("session.forget", { names: ["old", "live"] });
    expect(r.forgotten.map((s) => s.name)).toEqual(["old"]);
    expect(r.skippedOnline.map((s) => s.name)).toEqual(["live"]);
    expect(await listed()).toEqual(["live"]);
  });

  it("selects by id, and reports an online id as skipped", async () => {
    const a = await make("a", 7001);
    const b = await make("b", 7002);
    takeOffline(7001);
    const r = await c.call("session.forget", { ids: [a.id, b.id] });
    expect(r.forgotten).toEqual([{ id: a.id, name: "a" }]);
    expect(r.skippedOnline).toEqual([{ id: b.id, name: "b" }]);
  });

  it("matches * globs and exact names alike", async () => {
    await make("conveno-real-1", 7001);
    await make("conveno-real-2", 7002);
    await make("keep-me", 7003);
    for (const pid of [7001, 7002, 7003]) takeOffline(pid);
    const r = await c.call("session.forget", { names: ["conveno-real-*"] });
    expect(r.forgotten.map((s) => s.name).sort()).toEqual(["conveno-real-1", "conveno-real-2"]);
    expect(await listed()).toEqual(["keep-me"]);
    expect((await c.call("session.forget", { names: ["keep-me"] })).forgotten).toHaveLength(1);
  });

  it("forgets every offline session when only olderThanMs: 0 is given, and ignores online ones", async () => {
    await make("a", 7001);
    await make("b", 7002);
    await make("live", 7003);
    takeOffline(7001);
    takeOffline(7002);
    const r = await c.call("session.forget", { olderThanMs: 0 });
    expect(r.forgotten.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(r.skippedOnline).toEqual([]);
    expect(await listed()).toEqual(["live"]);
  });

  it("honours olderThanMs against the time the session was last seen", async () => {
    await make("early", 7001);
    takeOffline(7001);
    h.clock.ms += 5 * HOUR;
    await make("late", 7002);
    takeOffline(7002);
    h.clock.ms += HOUR;
    const r = await c.call("session.forget", { olderThanMs: 3 * HOUR });
    expect(r.forgotten.map((s) => s.name)).toEqual(["early"]);
    expect(await listed()).toEqual(["late"]);
  });

  it("combines names with olderThanMs", async () => {
    await make("x-1", 7001);
    takeOffline(7001);
    h.clock.ms += 2 * HOUR;
    await make("x-2", 7002);
    takeOffline(7002);
    const r = await c.call("session.forget", { names: ["x-*"], olderThanMs: HOUR });
    expect(r.forgotten.map((s) => s.name)).toEqual(["x-1"]);
  });

  it("changes nothing with dryRun but reports the same result", async () => {
    await make("old", 7001);
    await make("live", 7002);
    takeOffline(7001);
    const dry = await c.call("session.forget", { names: ["*"], dryRun: true });
    expect(await listed()).toEqual(["live", "old"]);
    const real = await c.call("session.forget", { names: ["*"] });
    expect(real).toEqual(dry);
    expect(await listed()).toEqual(["live"]);
  });

  it("deletes the mailbox of a forgotten session but keeps what it sent", async () => {
    const a = await make("alpha", 7001);
    const b = await make("beta", 7002);
    // Mail to alpha, and mail from alpha that sits in beta's mailbox.
    await c.call("message.send", {
      sessionId: b.id,
      to: "alpha",
      kind: "text",
      body: { text: "to alpha" },
    });
    await c.call("message.send", {
      sessionId: a.id,
      to: "beta",
      kind: "text",
      body: { text: "from alpha" },
    });
    takeOffline(7001);
    await c.call("session.heartbeat", { sessionId: b.id });
    expect((await c.call("session.forget", { names: ["alpha"] })).forgotten).toHaveLength(1);
    const inbox = await c.call("message.inbox", { sessionId: b.id, unreadOnly: false });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({ fromName: "alpha", body: { text: "from alpha" } });
    // The mail addressed to alpha is gone: a new session with that name starts empty.
    const again = await make("alpha", 7003);
    expect(
      (await c.call("message.inbox", { sessionId: again.id, unreadOnly: false })).messages,
    ).toEqual([]);
  });

  it("leaves an online orchestrator alone", async () => {
    const a = await make("boss", 7001);
    await c.call("orchestrator.claim", { sessionId: a.id });
    const r = await c.call("session.forget", { names: ["boss"] });
    expect(r.forgotten).toEqual([]);
    expect(r.skippedOnline).toHaveLength(1);
    expect((await c.call("session.list", {})).sessions[0]?.isOrchestrator).toBe(true);
  });

  it("refuses a call with no selector", async () => {
    const r = await c.rpc("session.forget", { dryRun: true });
    expect(r.error?.code).toBe(-32602);
  });

  it("needs the handshake", async () => {
    const raw = await h.client();
    const r = await raw.rpc("session.forget", { olderThanMs: 0 });
    expect(r.error?.code).toBe(-32001);
  });
});

describe("auto-forget of a missing folder", () => {
  it("forgets an offline session whose cwd is gone", async () => {
    await make("ghost", 7001, { cwd: "/tmp/ghost-repo" });
    await make("home", 7002, { cwd: "/tmp/home-repo" });
    takeOffline(7001);
    takeOffline(7002);
    gone.add("/tmp/ghost-repo");
    sweepAfterGrace();
    expect(await listed()).toEqual(["home"]);
  });

  it("forgets an offline session whose repo root is gone, even when its cwd is not", async () => {
    await make("ghost", 7001, {
      cwd: "/tmp/repo/sub",
      repo: { root: "/tmp/repo" },
    });
    takeOffline(7001);
    gone.add("/tmp/repo");
    sweepAfterGrace();
    expect(await listed()).toEqual([]);
  });

  it("waits out the grace before forgetting, so a briefly missing drive is harmless", async () => {
    await make("ghost", 7001, { cwd: "/tmp/ghost-repo" });
    takeOffline(7001);
    gone.add("/tmp/ghost-repo");
    h.daemon.sweep();
    expect(await listed()).toEqual(["ghost"]);
    gone.delete("/tmp/ghost-repo");
    sweepAfterGrace();
    expect(await listed()).toEqual(["ghost"]);
  });

  it("keeps an offline session with unread mail, leaving it to the unread rule", async () => {
    const ghost = await make("ghost", 7001, { cwd: "/tmp/ghost-repo" });
    const sender = await make("sender", 7002, { cwd: "/tmp/home-repo" });
    await c.call("message.send", {
      sessionId: sender.id,
      to: ghost.name,
      kind: "text",
      body: { text: "still for you" },
    });
    takeOffline(7001);
    gone.add("/tmp/ghost-repo");
    sweepAfterGrace();
    expect(await listed()).toEqual(["ghost", "sender"]);
  });

  it("keeps an offline session whose folder still exists", async () => {
    await make("stay", 7001, { cwd: "/tmp/present" });
    takeOffline(7001);
    sweepAfterGrace();
    expect(await listed()).toEqual(["stay"]);
  });

  it("never forgets an online session, whatever its folder", async () => {
    await make("live", 7001, { cwd: "/tmp/ghost-repo" });
    gone.add("/tmp/ghost-repo");
    sweepAfterGrace();
    expect(await listed()).toEqual(["live"]);
  });

  it("keeps an offline session whose host still runs, since it can come back", async () => {
    await make("slow", 7001, { cwd: "/tmp/ghost-repo" });
    // Missed heartbeats, but the host process is alive.
    h.clock.ms += 60_000;
    sweepAfterGrace();
    expect((await c.call("session.list", { includeOffline: true })).sessions[0]?.status).toBe(
      "offline",
    );
    gone.add("/tmp/ghost-repo");
    sweepAfterGrace();
    expect(await listed()).toEqual(["slow"]);
  });
});
