import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonLog } from "./log.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cvlog-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("daemon log", () => {
  it("creates the folder and writes the time, the context and the stack", () => {
    const path = join(dir, "logs", "daemon.log");
    const log = createDaemonLog(path, { now: () => new Date("2026-11-27T10:00:00.000Z") });
    log.error("internal error in message.send", new Error("boom"));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("2026-11-27T10:00:00.000Z internal error in message.send");
    expect(text).toContain("Error: boom");
  });

  it.skipIf(process.platform === "win32")("is readable by the user only", () => {
    const path = join(dir, "daemon.log");
    createDaemonLog(path).error("x", new Error("y"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rotates to one older generation when the size cap is reached", () => {
    const path = join(dir, "daemon.log");
    const log = createDaemonLog(path, { maxBytes: 200 });
    for (let i = 0; i < 20; i++) log.error(`entry ${i}`, "x".repeat(40));
    expect(existsSync(`${path}.1`)).toBe(true);
    expect(existsSync(`${path}.2`)).toBe(false);
    expect(statSync(path).size).toBeLessThan(400);
    expect(readFileSync(path, "utf8")).toContain("entry 19");
  });

  it("never throws, even when the folder cannot be created", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const log = createDaemonLog(join(blocker, "sub", "daemon.log"));
    expect(() => log.error("x", "y")).not.toThrow();
  });
});
