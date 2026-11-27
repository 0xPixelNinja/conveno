import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClientMethodName,
  type ConvenoClient,
  ConvenoError,
  dataDir,
  dataPaths,
} from "@0xpixelninja/conveno-core";
import {
  type ClientKind,
  createLineDecoder,
  defaultSocketPath,
  EVENT_NOTIFICATION_METHOD,
  EventPayload,
  encodeFrame,
  ipcMethods,
  PROTOCOL_VERSION,
  RpcErrorCode,
  RpcResponse,
} from "@0xpixelninja/conveno-protocol";

export interface ConnectOptions {
  kind: ClientKind;
  /** Data directory holding `daemon.token`. Default: core's `dataDir` for this platform. */
  dataDir?: string;
  /** Daemon endpoint. Default: protocol's `defaultSocketPath` for this platform. */
  socketPath?: string;
  /** Spawn the daemon when nothing is listening. Default true. */
  autoStart?: boolean;
  /** Path to the daemon's entry script. Default: resolve `@0xpixelninja/conveno-daemon/bin`. */
  daemonEntry?: string;
  /** Per-request timeout in milliseconds. Default 5000. */
  requestTimeoutMs?: number;
  /** Total time to keep retrying after auto-start, in milliseconds. Default 3000. */
  startTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 3_000;
const LOCK_STALE_MS = 10_000;

const CLIENT_METHODS = [
  "session.register",
  "session.heartbeat",
  "session.unregister",
  "session.rename",
  "session.setStatus",
  "session.byHost",
  "session.list",
  "orchestrator.claim",
  "message.send",
  "message.inbox",
  "message.deliver",
  "message.ack",
  "events.subscribe",
] as const satisfies readonly ClientMethodName[];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const isMissingDaemon = (e: unknown) => errCode(e) === "ENOENT" || errCode(e) === "ECONNREFUSED";

function rpcErrorCode(code: number): RpcErrorCode {
  const known: number[] = Object.values(RpcErrorCode);
  return (known.includes(code) ? code : RpcErrorCode.InternalError) as RpcErrorCode;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const onError = (e: Error) => reject(e);
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function readToken(tokenPath: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(tokenPath, "utf8");
  } catch (e) {
    if (errCode(e) === "ENOENT") {
      throw Object.assign(
        new Error(
          `Daemon token file not found at ${tokenPath}. Start the daemon with convenod, then retry.`,
        ),
        { code: "ENOENT" },
      );
    }
    throw e;
  }
  const token = text.trim();
  if (!token) throw new Error(`Daemon token file ${tokenPath} is empty. Restart the daemon.`);
  return token;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Set<(e: EventPayload) => void>();
  private readonly decoder = createLineDecoder();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (chunk) => {
      for (const r of this.decoder.push(chunk)) if (r.ok) this.onMessage(r.value);
    });
    socket.on("error", (e) => this.failAll(e));
    socket.on("close", () => this.failAll(new Error("Connection to the Conveno daemon closed.")));
  }

  private onMessage(value: unknown): void {
    if ((value as { method?: unknown } | null)?.method === EVENT_NOTIFICATION_METHOD) {
      const parsed = EventPayload.safeParse((value as { params?: unknown }).params);
      if (!parsed.success) return;
      for (const h of [...this.handlers]) {
        try {
          h(parsed.data);
        } catch {
          // A throwing listener must not break the connection.
        }
      }
      return;
    }
    const res = RpcResponse.safeParse(value);
    if (!res.success || typeof res.data.id !== "number") return;
    const p = this.pending.get(res.data.id);
    if (!p) return;
    this.pending.delete(res.data.id);
    clearTimeout(p.timer);
    if ("error" in res.data) {
      p.reject(new ConvenoError(rpcErrorCode(res.data.error.code), res.data.error.message));
    } else {
      p.resolve(res.data.result);
    }
  }

  private failAll(e: Error): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(e);
    }
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Connection to the Conveno daemon is closed. Reconnect."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Request ${method} timed out after ${this.timeoutMs} ms. Check that the daemon is running.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  onEvent(handler: (e: EventPayload) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  close(): Promise<void> {
    this.failAll(new Error("Client closed."));
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once("close", () => resolve());
      this.socket.destroy();
    });
  }
}

async function typedCall(conn: Connection, method: string, params: unknown): Promise<unknown> {
  const schemas = ipcMethods[method as keyof typeof ipcMethods];
  const parsed = schemas.params.safeParse(params ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "params"}: ${i.message}`)
      .join("; ");
    throw new ConvenoError(RpcErrorCode.InvalidParams, `Invalid params for ${method}: ${detail}`);
  }
  const result = await conn.call(method, parsed.data as Record<string, unknown>);
  const r = schemas.result.safeParse(result);
  if (!r.success) {
    throw new ConvenoError(
      RpcErrorCode.InternalError,
      `The daemon returned an unexpected result for ${method}. Update the daemon and client to the same version.`,
    );
  }
  return r.data;
}

async function handshake(
  socketPath: string,
  tokenPath: string,
  kind: ClientKind,
  timeoutMs: number,
): Promise<Connection> {
  const socket = await openSocket(socketPath);
  const conn = new Connection(socket, timeoutMs);
  try {
    const authToken = await readToken(tokenPath);
    await typedCall(conn, "hello", { protocolVersion: PROTOCOL_VERSION, client: kind, authToken });
    return conn;
  } catch (e) {
    await conn.close();
    throw e;
  }
}

function resolveDaemonEntry(explicit?: string): string {
  if (explicit) return explicit;
  try {
    return fileURLToPath(import.meta.resolve("@0xpixelninja/conveno-daemon/bin"));
  } catch {
    throw new Error(
      "Cannot find the daemon entry (@0xpixelninja/conveno-daemon/bin). Pass daemonEntry to connect(), or start convenod yourself.",
    );
  }
}

function spawnDaemon(entry: string): void {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // A failed spawn surfaces as a start timeout in the retry loop.
  });
  child.unref();
}

/** Take the start lock. Returns a release function, or null if another client holds it. */
async function acquireStartLock(path: string): Promise<(() => Promise<void>) | null> {
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await open(path, "wx");
      await fh.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if (errCode(e) !== "EEXIST") throw e;
      try {
        const s = await stat(path);
        if (Date.now() - s.mtimeMs < LOCK_STALE_MS) return null;
        await rm(path, { force: true });
      } catch {
        // The holder released it between our calls; try again.
      }
    }
  }
  return null;
}

async function startAndConnect(
  entry: string,
  dir: string,
  attempt: () => Promise<Connection>,
  socketPath: string,
  startTimeout: number,
): Promise<Connection> {
  await mkdir(dir, { recursive: true });
  const release = await acquireStartLock(join(dir, "client-start.lock"));
  // Only the lock holder spawns. Other clients just wait for the daemon to appear.
  if (release) spawnDaemon(entry);
  const deadline = Date.now() + startTimeout;
  let delay = 25;
  let last: unknown;
  try {
    for (;;) {
      await sleep(delay);
      delay = Math.min(delay * 2, 250);
      try {
        return await attempt();
      } catch (e) {
        if (!isMissingDaemon(e)) throw e;
        last = e;
      }
      if (Date.now() >= deadline) break;
    }
  } finally {
    await release?.();
  }
  throw new Error(
    `The Conveno daemon did not start within ${startTimeout} ms (socket ${socketPath}). Run convenod in a terminal to see why.`,
    { cause: last },
  );
}

/**
 * Connect to the daemon, complete `hello`, and return a typed client. When nothing is listening
 * and `autoStart` is not false, spawns the daemon detached and retries with backoff.
 */
export async function connect(opts: ConnectOptions): Promise<ConvenoClient> {
  const platform = process.platform;
  const dir = opts.dataDir ?? dataDir(platform, process.env, homedir());
  const socketPath = opts.socketPath ?? defaultSocketPath(platform, process.env, homedir());
  const tokenPath = dataPaths(platform, dir).token;
  const timeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const attempt = () => handshake(socketPath, tokenPath, opts.kind, timeout);

  let conn: Connection;
  try {
    conn = await attempt();
  } catch (e) {
    if (!isMissingDaemon(e)) throw e;
    if (opts.autoStart === false) {
      throw new Error(
        `No Conveno daemon is listening at ${socketPath}. Start convenod or enable autoStart.`,
        { cause: e },
      );
    }
    conn = await startAndConnect(
      resolveDaemonEntry(opts.daemonEntry),
      dir,
      attempt,
      socketPath,
      opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    );
  }

  const client: Record<string, unknown> = {
    onEvent: (handler: (e: EventPayload) => void) => conn.onEvent(handler),
    close: () => conn.close(),
  };
  for (const method of CLIENT_METHODS) {
    client[method] = (params: unknown) => typedCall(conn, method, params);
  }
  return client as unknown as ConvenoClient;
}
