import { NO_ORCHESTRATOR_MESSAGE } from "@0xpixelninja/conveno-core";
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
  waitFor,
} from "./harness.js";

// The daemon sweeps every 15 s, so these tests wait for a real sweep (up to ~20 s, 45 s cap).
describe("liveness when a host CLI dies", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let doomed: FakeSession;
  let survivor: FakeSession;
  let doomedName = "";

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    doomed = await startFakeSession(t, "claude", makeRepo(t, "doomed"));
    survivor = await startFakeSession(t, "codex", makeRepo(t, "survivor"));
    doomedName = nameOf((await doomed.call("whoami")).text);
  });

  afterAll(async () => {
    await Promise.all([doomed?.close(), survivor?.close()]);
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("goes offline within the sweep window, vacates the orchestrator role, and refuses sends", async () => {
    expect((await doomed.call("orchestrate")).isError).toBe(false);
    expect((await survivor.call("send", { to: "orchestrator", text: "alive?" })).isError).toBe(
      false,
    );

    // Crash the host CLI and its MCP server: no unregister, so only the sweep can notice.
    const killedAt = Date.now();
    doomed.killHost();

    await waitFor("the dead host's session to leave list_sessions", async () => {
      const r = await survivor.call("list_sessions");
      return !r.text.includes(doomedName);
    });

    // One sweep period is 15 s; allow a little more.
    expect(Date.now() - killedAt).toBeLessThan(25_000);

    const all = await survivor.call("list_sessions", { include_offline: true });
    const row = all.text.split("\n").find((l) => l.startsWith(doomedName));
    expect(row).toMatch(/\boffline\b/);
    expect(row).not.toMatch(/\byes\b/);

    const toOrch = await survivor.call("send", { to: "orchestrator", text: "anyone?" });
    expect(toOrch.isError).toBe(true);
    expect(toOrch.text).toBe(NO_ORCHESTRATOR_MESSAGE);

    const toDead = await survivor.call("send", { to: doomedName, text: "you there?" });
    expect(toDead.isError).toBe(true);
    expect(toDead.text).toBe(
      `Session "${doomedName}" is offline. Run list_sessions to see who is available.`,
    );
  });

  it("a replacement session reuses the freed name", async () => {
    const again = await startFakeSession(t, "claude", makeRepo(t, "doomed2"));
    try {
      expect(nameOf((await again.call("whoami")).text)).toBe("claude@doomed2-1");
    } finally {
      await again.close();
    }
  });
});
