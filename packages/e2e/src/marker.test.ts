import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CleanupDeps,
  type CommandResult,
  cleanupStale,
  markerPath,
  readMarker,
  writeMarker,
} from "../real-cli/marker.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cvn-marker-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const marker = {
  nonce: "cvn-1234abcd",
  pid: 4242,
  startedAt: "2026-11-27T10:00:00.000Z",
  platform: "win32 x64",
  targets: ["claude", "codex"],
  conveno: "conveno",
};

function deps(over: Partial<CleanupDeps> = {}) {
  const calls: string[][] = [];
  const lines: string[] = [];
  const ok: CommandResult = { code: 0, out: "", err: "" };
  const d: CleanupDeps = {
    markerFile: markerPath(join(dir, "data")),
    conveno: (...a) => {
      calls.push(a);
      return ok;
    },
    approved: false,
    ask: async () => null,
    log: (l) => lines.push(l),
    ...over,
  };
  return { d, calls, lines };
}

describe("run marker", () => {
  it("lives in the data dir and round-trips", () => {
    const file = markerPath(join(dir, "data"));
    expect(readMarker(file)).toEqual({ kind: "none" });
    writeMarker(file, marker);
    expect(readMarker(file)).toEqual({ kind: "found", marker });
  });
  it("treats a file it cannot parse as a marker", () => {
    const file = markerPath(dir);
    writeFileSync(file, "{ not json");
    expect(readMarker(file).kind).toBe("unreadable");
  });
});

describe("cleanupStale", () => {
  it("does nothing when there is no marker", async () => {
    const { d, calls } = deps();
    expect(await cleanupStale(d)).toBe("none");
    expect(calls).toEqual([]);
  });

  it("shows the marker, then stops the daemon and uninstalls once approved", async () => {
    const { d, calls, lines } = deps({ approved: true });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("cleaned");
    expect(calls).toEqual([
      ["daemon", "stop"],
      ["uninstall", "--yes"],
    ]);
    expect(lines.join("\n")).toContain("cvn-1234abcd");
    expect(existsSync(d.markerFile)).toBe(false);
  });

  it("asks when it can and cleans up on yes", async () => {
    const { d, calls } = deps({ ask: async () => "y" });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("cleaned");
    expect(calls).toHaveLength(2);
  });

  it("changes nothing without a terminal and without approval", async () => {
    const { d, calls } = deps();
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("no-approval");
    expect(calls).toEqual([]);
    expect(existsSync(d.markerFile)).toBe(true);
  });

  it("changes nothing when the user says no", async () => {
    const { d, calls } = deps({ ask: async () => "n" });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("declined");
    expect(calls).toEqual([]);
    expect(existsSync(d.markerFile)).toBe(true);
  });

  it("keeps the marker when uninstall fails, so the next run tries again", async () => {
    const { d } = deps({
      approved: true,
      conveno: (...a) =>
        a[0] === "uninstall" ? { code: 1, out: "", err: "boom" } : { code: 0, out: "", err: "" },
    });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("failed");
    expect(existsSync(d.markerFile)).toBe(true);
  });

  it("still cleans up when the daemon was not running", async () => {
    const { d } = deps({
      approved: true,
      conveno: (...a) => ({ code: a[0] === "daemon" ? 1 : 0, out: "", err: "" }),
    });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("cleaned");
  });
});
