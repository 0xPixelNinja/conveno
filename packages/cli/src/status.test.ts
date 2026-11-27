import { connect } from "@conveno/client";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { startTestDaemon, type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

/** A daemon with one online session and two that have gone offline. */
async function withSessions(run: (c: TestCtx) => Promise<void>): Promise<void> {
  const c = await testCtx();
  ctxs.push(c);
  const d = await startTestDaemon(c);
  const client = await connect({
    kind: "mcp",
    dataDir: c.dataDir,
    socketPath: c.socketPath as string,
    autoStart: false,
  });
  try {
    const reg = (cwd: string) =>
      client["session.register"]({ cli: "claude", cwd, repo: { root: cwd } } as never);
    await reg("/work/live");
    const gone1 = await reg("/work/old-1");
    const gone2 = await reg("/work/old-2");
    await client["session.unregister"]({ sessionId: gone1.session.id });
    await client["session.unregister"]({ sessionId: gone2.session.id });
    await run(c);
  } finally {
    await client.close();
    await d.stop();
  }
}

describe("status and offline sessions", () => {
  it("lists only online sessions by default and says how many are hidden", async () => {
    await withSessions(async (c) => {
      expect(await main(["status"], c)).toBe(0);
      const out = c.outText();
      expect(out).toContain("claude@live-1");
      expect(out).not.toContain("old-1");
      expect(out).not.toContain("old-2");
      expect(out).toContain("1 session in 1 repo");
      expect(out).toContain("2 offline hidden, conveno status --all shows them");
    });
  });

  it("--all lists offline sessions too, and hides nothing", async () => {
    await withSessions(async (c) => {
      expect(await main(["status", "--all"], c)).toBe(0);
      const out = c.outText();
      expect(out).toContain("claude@old-1-1");
      expect(out).toContain("claude@old-2-1");
      expect(out).toContain("offline");
      expect(out).not.toContain("hidden");
    });
  });

  it("says so when everything is offline", async () => {
    const c = await testCtx();
    ctxs.push(c);
    const d = await startTestDaemon(c);
    const client = await connect({
      kind: "mcp",
      dataDir: c.dataDir,
      socketPath: c.socketPath as string,
      autoStart: false,
    });
    try {
      const a = await client["session.register"]({ cli: "claude", cwd: "/work/x" } as never);
      await client["session.unregister"]({ sessionId: a.session.id });
      expect(await main(["status"], c)).toBe(0);
      expect(c.outText()).toContain("No sessions online. 1 offline hidden");
    } finally {
      await client.close();
      await d.stop();
    }
  });
});
