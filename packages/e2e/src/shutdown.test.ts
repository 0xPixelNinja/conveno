import { existsSync } from "node:fs";
import { join } from "node:path";
import { dataPaths } from "@conveno/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliClient,
  type DaemonProc,
  type FakeSession,
  makeEnv,
  makeRepo,
  removeEnv,
  startDaemonProc,
  startFakeSession,
  type TestEnv,
  waitFor,
} from "./harness.js";

describe("daemon.shutdown against the real convenod", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let session: FakeSession;

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    session = await startFakeSession(t, "claude", makeRepo(t, "repo"));
  });

  afterAll(async () => {
    await session?.close();
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("registers the MCP server's real ancestor chain, nearest first", async () => {
    const client = await cliClient(t);
    try {
      const { sessions } = await client["session.list"]({});
      const mine = sessions.find((s) => s.pid !== undefined);
      // The fake host is the MCP server's parent; the test process spawned the host.
      expect(mine?.hostPids?.[0]).toBe(session.hostPid);
      if (process.platform !== "win32") expect(mine?.hostPids?.[1]).toBe(process.pid);
      expect((mine?.hostPids ?? []).length).toBeLessThanOrEqual(8);
    } finally {
      await client.close();
    }
  });

  it("exits 0 after the reply, and leaves no lock and no socket behind", async () => {
    const lock = dataPaths(process.platform, t.dataDir).lock;
    expect(existsSync(lock)).toBe(true);
    const exited = new Promise<number | null>((resolve) =>
      daemon.child.once("exit", (code) => resolve(code)),
    );
    const client = await cliClient(t);
    try {
      expect(await client["daemon.shutdown"]({})).toEqual({ ok: true });
    } finally {
      await client.close().catch(() => undefined);
    }
    expect(await exited).toBe(0);
    await waitFor("the lock file to disappear", () => !existsSync(lock));
    if (process.platform !== "win32") expect(existsSync(t.socketPath)).toBe(false);
    expect(existsSync(join(t.dataDir, "daemon.token"))).toBe(true);
  });
});
