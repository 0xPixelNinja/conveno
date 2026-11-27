import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@conveno/client";
import { type ConvenoClient, dataDir } from "@conveno/core";
import { type CliKind, defaultSocketPath } from "@conveno/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const DAEMON_BIN = join(here, "..", "..", "daemon", "dist", "bin.js");
const HOST = join(here, "fixtures", "host.mjs");
const MCP_ENTRY = join(here, "fixtures", "mcp-entry.mjs");

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns a truthy value, or fail with `what`. */
export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | false | undefined | null> | T | false | undefined | null,
  timeoutMs = 45_000,
  stepMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await sleep(stepMs);
  }
}

/** An isolated machine: own HOME, data dir and socket, so nothing touches the real install. */
export interface TestEnv {
  root: string;
  dataDir: string;
  socketPath: string;
  env: Record<string, string>;
}

export async function makeEnv(): Promise<TestEnv> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cvn-")));
  const home = join(root, "home");
  const run = join(root, "run");
  mkdirSync(home, { recursive: true });
  mkdirSync(run, { recursive: true });
  const user = `e2e${Math.random().toString(36).slice(2, 10)}`;
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(root, "local"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_RUNTIME_DIR: run,
    // The Windows pipe name is derived from the user name.
    USERNAME: user,
    USER: user,
  };
  const merged = { ...process.env, ...env } as Record<string, string>;
  return {
    root,
    dataDir: dataDir(process.platform, merged, home),
    socketPath: defaultSocketPath(process.platform, merged, home),
    env,
  };
}

export async function removeEnv(t: TestEnv): Promise<void> {
  await rm(t.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** `git init` a temp repo called `name` under the test root. */
export function makeRepo(t: TestEnv, name: string): string {
  const dir = join(t.root, "repos", name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  return dir;
}

export interface DaemonProc {
  child: ChildProcess;
  stop(): Promise<void>;
}

/** Run the real `convenod` (dist/bin.js) with the isolated environment. */
export async function startDaemonProc(t: TestEnv): Promise<DaemonProc> {
  if (!existsSync(DAEMON_BIN)) {
    throw new Error(`${DAEMON_BIN} is missing. Run "pnpm build" first.`);
  }
  const child = spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, ...t.env },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let log = "";
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stderr?.on("data", (d: Buffer) => {
      log += d.toString();
      if (log.includes("listening on")) resolve();
    });
    child.once("exit", (code) => reject(new Error(`convenod exited early (${code}): ${log}`)));
    child.once("error", reject);
  });
  return {
    child,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

/** A CLI-kind client for assertions and hook calls. */
export function cliClient(t: TestEnv, kind: "cli" | "adapter" = "cli"): Promise<ConvenoClient> {
  return connect({ kind, dataDir: t.dataDir, socketPath: t.socketPath, autoStart: false });
}

export interface FakeSession {
  cli: CliKind;
  repo: string;
  client: Client;
  transport: StdioClientTransport;
  /** Pid of the fake host CLI process (the MCP server's parent). */
  hostPid: number;
  /** Call an MCP tool; returns its text and whether it was an error. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** SIGKILL the host and the MCP server it spawned, like a crash. */
  killHost(): void;
  close(): Promise<void>;
}

/** Spawn fake host -> MCP server (stdio) in `repo`, and drive it with the SDK client. */
export async function startFakeSession(
  t: TestEnv,
  cli: CliKind,
  repo: string,
  extraEnv: Record<string, string> = {},
): Promise<FakeSession> {
  const pidFile = join(t.root, `mcp-${Math.random().toString(36).slice(2)}.pid`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [HOST, MCP_ENTRY],
    cwd: repo,
    env: { ...process.env, ...t.env, FAKE_CLI: cli, FAKE_PIDFILE: pidFile, ...extraEnv } as Record<
      string,
      string
    >,
    stderr: "pipe",
  });
  const client = new Client({ name: `fake-${cli}`, version: "0.0.0" });
  await client.connect(transport);
  const hostPid = transport.pid;
  if (hostPid === null) throw new Error("fake host has no pid");
  const s: FakeSession = {
    cli,
    repo,
    client,
    transport,
    hostPid,
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      const text = res.content.map((c) => c.text ?? "").join("\n");
      return { text, isError: res.isError === true };
    },
    killHost() {
      // A crash: no clean shutdown, so the MCP server never unregisters. Kill the server first so
      // it cannot notice the host exit and unregister itself.
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Already gone.
      }
      process.kill(hostPid, "SIGKILL");
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
  // Registration happens on `initialized`; whoami forces it and returns the name.
  await s.call("whoami");
  return s;
}

export const nameOf = (whoami: string): string => /^Name: (.+)$/m.exec(whoami)?.[1] ?? "";
export const idOf = (whoami: string): string => /^Session id: (.+)$/m.exec(whoami)?.[1] ?? "";
