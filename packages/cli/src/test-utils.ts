import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import claudeAdapter from "@0xpixelninja/conveno-adapter-claude";
import { createTheme } from "@0xpixelninja/conveno-brand";
import { connect } from "@0xpixelninja/conveno-client";
import type { Adapter } from "@0xpixelninja/conveno-core";
import { type DaemonHandle, startDaemon } from "@0xpixelninja/conveno-daemon";
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
  const root = await mkdtemp(join(tmpdir(), "conveno-cli-"));
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const norm = (s: string) => s.split(root).join("<tmp>").replaceAll("\\", "/");
  const ctx: TestCtx = {
    home,
    platform: process.platform,
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
    ppid: process.pid,
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
