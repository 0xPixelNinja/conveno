import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcErrorCode } from "@conveno/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./test-utils.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

describe("daemon log", () => {
  it("records an unexpected error and the reply names the log file", async () => {
    const c = await h.authed();
    // Break the database underneath the daemon so the next request fails with a SQL error.
    const db = new DatabaseSync(join(h.dir, "conveno.db"));
    db.exec("DROP TABLE sessions");
    db.close();
    const r = await c.rpc("session.list", {});
    const logPath = join(h.dir, "logs", "daemon.log");
    expect(r.error?.code).toBe(RpcErrorCode.InternalError);
    expect(r.error?.message).toContain(logPath);
    const text = readFileSync(logPath, "utf8");
    expect(text).toContain("internal error in session.list");
    expect(text).toContain("sessions");
  });

  it("does not log errors the daemon reports on purpose", async () => {
    const c = await h.authed();
    const r = await c.rpc("message.inbox", { sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(r.error).toBeDefined();
    expect(existsSync(join(h.dir, "logs", "daemon.log"))).toBe(false);
  });
});
