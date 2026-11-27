import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliClient,
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

describe("daemon restart", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let a: FakeSession;
  let b: FakeSession;

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    a = await startFakeSession(t, "claude", makeRepo(t, "first"));
    b = await startFakeSession(t, "codex", makeRepo(t, "second"));
  });

  afterAll(async () => {
    await Promise.all([a?.close(), b?.close()]);
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("keeps sessions, names, the orchestrator and undelivered messages across a restart", async () => {
    const nameA = nameOf((await a.call("whoami")).text);
    const nameB = nameOf((await b.call("whoami")).text);
    await b.call("orchestrate");
    await a.call("send", { to: nameB, text: "survives restarts" });

    await daemon.stop();
    daemon = await startDaemonProc(t);

    const client = await cliClient(t);
    try {
      const { sessions } = await client["session.list"]({ includeOffline: true });
      const names = sessions.map((s) => s.name).sort();
      expect(names).toEqual([nameA, nameB].sort());
      const holder = sessions.find((s) => s.name === nameB);
      expect(holder?.isOrchestrator).toBe(true);

      const inbox = await client["message.inbox"]({
        sessionId: holder?.id as NonNullable<typeof holder>["id"],
        unreadOnly: true,
        limit: 20,
      });
      expect(inbox.messages.map((m) => m.kind === "text" && m.body.text)).toContain(
        "survives restarts",
      );
    } finally {
      await client.close();
    }
  });
});
