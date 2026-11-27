import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import claudeAdapter from "@conveno/adapter-claude";
import { createTheme } from "@conveno/brand";
import { connect } from "@conveno/client";
import { type Adapter, type Ancestry, type ProcessIo, readAncestry } from "@conveno/core";
import { type DaemonHandle, startDaemon } from "@conveno/daemon";
import type { Ctx } from "./ctx.js";

export const FIXED_NOW = new Date("2026-11-27T14:02:11.000Z");

export interface TestCtx extends Ctx {
  stdout: string[];
  stderr: string[];
  /** All stdout joined, with the temp home replaced by `<home>`. */
  outText(): string;
  errText(): string;
  root: string;
  cleanup(): Promise<void>;
}

export const plainTheme = () =>
  createTheme({ env: { NO_COLOR: "1", LANG: "en_US.UTF-8" }, isTTY: true, platform: "linux" });

const socketIn = (dir: string): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\conveno-cli-test-${randomBytes(6).toString("hex")}`
    : join(dir, "d.sock");

/** A context rooted in fresh temp directories, with every side effect captured. */
export async function testCtx(over: Partial<Ctx> = {}): Promise<TestCtx> {
  // Resolve symlinks and 8.3 short names (macOS /var, Windows RUNNER~1) so paths match what the code sees.
  const root = await realpath(await mkdtemp(join(tmpdir(), "conveno-cli-")));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  // The socket is a named pipe on Windows, outside the temp root; show both as `<tmp>/d.sock`.
  const norm = (s: string) =>
    s
      .split(ctx.socketPath ?? "\0")
      .join(`${root}/d.sock`)
      .split(root)
      .join("<tmp>")
      .replaceAll("\\", "/");
  const ctx: TestCtx = {
    home,
    // Output and plans are pinned to one platform so snapshots match on every OS. Tests that
    // cover Windows behaviour pass platform "win32" themselves.
    platform: "linux",
    cwd: home,
    env: {},
    dataDir: join(home, ".conveno-data"),
    socketPath: socketIn(root),
    conveno: { command: ["conveno"] },
    adapters: [claudeAdapter],
    exec: async () => ({ code: 0, stdout: "2.1.0 (Claude Code)\n" }),
    theme: plainTheme(),
    out: (s) => void stdout.push(s),
    err: (s) => void stderr.push(s),
    interactive: false,
    confirm: async () => true,
    now: () => FIXED_NOW,
    readStdin: async () => "",
    connect,
    ancestry: async () => ({
      entries: [{ pid: process.pid }],
      pids: [process.pid],
      hostPid: process.pid,
      complete: true,
    }),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    commandLineOf: async () => null,
    kill: () => {
      throw new Error("test context: kill was not expected");
    },
    stopTimeoutMs: 1_000,
    runMcp: async () => undefined,
    hookTimeoutMs: 2_000,
    ...over,
    stdout,
    stderr,
    outText: () => norm(stdout.join("")),
    errText: () => norm(stderr.join("")),
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  return ctx;
}

export async function seed(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

export interface TestDaemon {
  handle: DaemonHandle;
  stop(): Promise<void>;
}

/** An in-process daemon on the context's data dir and socket, with a fixed clock. */
export async function startTestDaemon(ctx: Ctx): Promise<TestDaemon> {
  const handle = await startDaemon({
    dataDir: ctx.dataDir,
    ...(ctx.socketPath ? { socketPath: ctx.socketPath } : {}),
    idleExitMs: Number.POSITIVE_INFINITY,
    now: () => FIXED_NOW,
    sweepIntervalMs: 3_600_000,
  });
  return { handle, stop: () => handle.close() };
}

/** A fake adapter whose plan, uninstall plan and hook are plain functions. */
export function fakeAdapter(over: Partial<Adapter> & { cli?: Adapter["cli"] } = {}): Adapter {
  return {
    cli: "opencode",
    displayName: "Fake CLI",
    deliveryTier: "inbox",
    detect: async () => ({ installed: true, version: "1.0.0", binary: "fake", configPaths: [] }),
    plan: async () => [],
    uninstallPlan: async () => [],
    hook: async () => ({ stdout: "", exitCode: 0 }),
    ...over,
  };
}

/** A fake process table: pid -> [ppid, command line]. */
export type FakeProcs = Record<number, [ppid: number, command: string]>;

/** OS access over a fake table, for Windows and macOS style queries (one spawn, whole table). */
export function tableIo(platform: NodeJS.Platform, procs: FakeProcs, denied = false): ProcessIo {
  return {
    platform,
    readFile: async () => {
      throw new Error("ENOENT");
    },
    run: async () =>
      denied
        ? null
        : Object.entries(procs)
            .map(([pid, [ppid, command]]) => `${pid} ${ppid} ${command}`)
            .join("\r\n"),
  };
}

/**
 * A context `ancestry` that reads the real launcher logic over a fake table, as the process
 * `pid` whose direct parent is `ppid`.
 */
export function ancestryOf(
  procs: FakeProcs,
  self: { pid: number; ppid: number },
  opts: { platform?: NodeJS.Platform; denied?: boolean; launcherPaths?: string[] } = {},
): (timeoutMs: number) => Promise<Ancestry> {
  return (timeoutMs) =>
    readAncestry({
      pid: self.pid,
      ppid: self.ppid,
      timeoutMs,
      io: tableIo(opts.platform ?? "win32", procs, opts.denied),
      ...(opts.launcherPaths ? { launcherPaths: opts.launcherPaths } : {}),
    });
}
