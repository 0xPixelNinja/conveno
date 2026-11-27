import { NO_ORCHESTRATOR_MESSAGE, NOT_FROM_USER_NOTICE } from "@conveno/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DaemonProc,
  type FakeSession,
  makeEnv,
  makeRepo,
  nameOf,
  removeEnv,
  startDaemonProc,
  startFakeSession,
  type TestEnv,
} from "./harness.js";

/**
 * Three fake CLIs against one real convenod process. Tests run in order and share state on purpose:
 * each scenario builds on the previous one, like a real working session.
 */
describe("three sessions on one daemon", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let a: FakeSession; // claude in alpha
  let b: FakeSession; // claude in alpha again
  let c: FakeSession; // codex in beta
  let nameA = "";
  let nameB = "";
  let nameC = "";

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    const alpha = makeRepo(t, "alpha");
    const beta = makeRepo(t, "beta");
    a = await startFakeSession(t, "claude", alpha);
    b = await startFakeSession(t, "claude", alpha);
    c = await startFakeSession(t, "codex", beta);
  });

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close(), c?.close()]);
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("whoami and list_sessions show all three with repo-based names", async () => {
    nameA = nameOf((await a.call("whoami")).text);
    nameB = nameOf((await b.call("whoami")).text);
    nameC = nameOf((await c.call("whoami")).text);
    expect(nameA).toBe("claude@alpha-1");
    expect(nameB).toBe("claude@alpha-2");
    expect(nameC).toBe("codex@beta-1");

    const list = await a.call("list_sessions");
    expect(list.isError).toBe(false);
    for (const n of [nameA, nameB, nameC]) expect(list.text).toContain(n);

    const onlyCodex = await a.call("list_sessions", { cli: "codex" });
    expect(onlyCodex.text).toContain(nameC);
    expect(onlyCodex.text).not.toContain(nameB);
  });

  it("send by name arrives framed as not from the user", async () => {
    const sent = await a.call("send", { to: nameB, text: "please review the parser" });
    expect(sent.isError).toBe(false);
    expect(sent.text).toContain(nameB);

    const inbox = await b.call("inbox");
    expect(inbox.text).toContain(`Message from ${nameA} (claude)`);
    expect(inbox.text).toContain(NOT_FROM_USER_NOTICE);
    expect(inbox.text).toContain("please review the parser");
    expect(inbox.text).toContain("Unread remaining: 0");

    // Read messages are not returned again as unread.
    expect((await b.call("inbox")).text).toContain("No new messages");
  });

  it("send to orchestrator with no holder fails with the fix in the text", async () => {
    const r = await a.call("send", { to: "orchestrator", text: "anyone?" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(NO_ORCHESTRATOR_MESSAGE);
  });

  it("send to an unknown name fails with a pointer to list_sessions", async () => {
    const r = await a.call("send", { to: "nobody@nowhere-9", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("list_sessions");
  });

  it("orchestrate takes the role and send to orchestrator reaches the holder", async () => {
    const o = await c.call("orchestrate");
    expect(o.isError).toBe(false);
    expect(o.text).toContain("no previous holder");

    const list = await a.call("list_sessions");
    const row = list.text.split("\n").find((l) => l.startsWith(nameC));
    expect(row).toMatch(/\byes\b/);

    const sent = await a.call("send", { to: "orchestrator", text: "need a decision" });
    expect(sent.isError).toBe(false);
    expect(sent.text).toContain(nameC);
    const inbox = await c.call("inbox");
    expect(inbox.text).toContain("need a decision");
  });

  it("orchestrate handover sends system messages to old and new holder", async () => {
    const o = await b.call("orchestrate");
    expect(o.text).toContain(`Previous holder: ${nameC}`);

    const oldHolder = await c.call("inbox", { unread_only: false });
    expect(oldHolder.text).toContain("(system)");
    expect(oldHolder.text).toContain(NOT_FROM_USER_NOTICE);
    const newHolder = await b.call("inbox", { unread_only: false });
    expect(newHolder.text).toContain("(system)");
  });

  it("urgent messages are read before normal ones, and ack works", async () => {
    // c sends two messages to a: a normal one first, then an urgent one.
    await c.call("send", { to: nameA, text: "normal-first" });
    await c.call("send", { to: nameA, text: "urgent-second", urgent: true });
    const inbox = await a.call("inbox");
    const iNormal = inbox.text.indexOf("normal-first");
    const iUrgent = inbox.text.indexOf("urgent-second");
    expect(iNormal).toBeGreaterThan(-1);
    expect(iUrgent).toBeGreaterThan(-1);
    expect(iUrgent).toBeLessThan(iNormal);
    expect(inbox.text).toContain("Marked urgent by the sender.");

    const ids = [...inbox.text.matchAll(/Message id: (\S+)/g)].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const ack = await a.call("ack", { ids });
    expect(ack.text).toBe(`Acknowledged ${ids.length} messages.`);
  });

  it("rename works, rejects conflicts and bad names", async () => {
    const ok = await a.call("rename", { name: "api-worker" });
    expect(ok.text).toBe("Renamed to api-worker.");
    expect(nameOf((await a.call("whoami")).text)).toBe("api-worker");

    const clash = await b.call("rename", { name: "api-worker" });
    expect(clash.isError).toBe(true);
    expect(clash.text).toContain("already used");

    const bad = await b.call("rename", { name: "Not Valid!" });
    expect(bad.isError).toBe(true);
    // Known gap (mcp/client): the client's schema check answers first, so the friendlier core
    // message ("Use 1 to 64 characters: ...") never reaches the agent.
    expect(bad.text.toLowerCase()).toContain("invalid");

    // Sending by the new name works.
    const sent = await c.call("send", { to: "api-worker", text: "by new name" });
    expect(sent.isError).toBe(false);
    nameA = "api-worker";
  });

  it("set_status is visible to the other sessions and can be cleared", async () => {
    expect((await a.call("set_status", { text: "refactoring the parser" })).text).toBe(
      "Status set.",
    );
    const seen = await c.call("list_sessions");
    const row = seen.text.split("\n").find((l) => l.startsWith(nameA));
    expect(row).toContain("refactoring the parser");

    await a.call("set_status", { text: "" });
    const after = await c.call("list_sessions");
    expect(after.text).not.toContain("refactoring the parser");
  });
});
