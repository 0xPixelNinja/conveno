import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nameMatchesPattern } from "@conveno/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CleanupDeps,
  type CommandResult,
  cleanupStale,
  forgetArgs,
  markerPath,
  readMarker,
  sessionPattern,
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

describe("sessionPattern", () => {
  it("matches the sessions of one run and no other run", () => {
    const pattern = sessionPattern("cvn-1234abcd");
    expect(pattern).toBe("*@conveno-real-*-1234abcd-*");
    // The same rule the daemon uses: `*` is any run of characters, the rest is literal.
    expect(nameMatchesPattern(pattern, "claude@conveno-real-ccr-1234abcd-1")).toBe(true);
    expect(nameMatchesPattern(pattern, "codex@conveno-real-m1-1234abcd-2")).toBe(true);
    expect(nameMatchesPattern(pattern, "claude@conveno-real-ccr-99999999-1")).toBe(false);
    expect(nameMatchesPattern(pattern, "claude@my-project-1")).toBe(false);
  });
  it("is passed to conveno forget with --yes", () => {
    expect(forgetArgs("cvn-1234abcd")).toEqual(["forget", "*@conveno-real-*-1234abcd-*", "--yes"]);
  });
});

describe("cleanupStale", () => {
  it("does nothing when there is no marker", async () => {
    const { d, calls } = deps();
    expect(await cleanupStale(d)).toBe("none");
    expect(calls).toEqual([]);
  });

  it("shows the marker, forgets the run's sessions, stops the daemon and uninstalls once approved", async () => {
    const { d, calls, lines } = deps({ approved: true });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("cleaned");
    expect(calls).toEqual([
      ["forget", "*@conveno-real-*-1234abcd-*", "--yes"],
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
    expect(calls).toHaveLength(3);
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

  it("still cleans up when forget fails because the daemon was not running", async () => {
    const seen: string[] = [];
    const { d } = deps({
      approved: true,
      conveno: (...a) => {
        seen.push(a[0] ?? "");
        return { code: a[0] === "uninstall" ? 0 : 1, out: "", err: "not running" };
      },
    });
    writeMarker(d.markerFile, marker);
    expect(await cleanupStale(d)).toBe("cleaned");
    expect(seen).toEqual(["forget", "daemon", "uninstall"]);
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
