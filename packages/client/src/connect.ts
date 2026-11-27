import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ClientMethodName,
  type ConvenoClient,
  ConvenoError,
  clientProof,
  daemonProof,
  dataDir,
  dataPaths,
  newAuthNonce,
  proofsMatch,
} from "@conveno/core";
import {
  type ClientKind,
  createLineDecoder,
  defaultSocketPath,
  EVENT_NOTIFICATION_METHOD,
  EventPayload,
  encodeFrame,
  ipcMethods,
  isSocketPathTooLong,
  PROTOCOL_VERSION,
  RpcErrorCode,
  RpcResponse,
  socketPathTooLongMessage,
} from "@conveno/protocol";

export interface ConnectOptions {
  kind: ClientKind;
  /** Data directory holding `daemon.token`. Default: core's `dataDir` for this platform. */
  dataDir?: string;
  /** Daemon endpoint. Default: protocol's `defaultSocketPath` for this platform. */
  socketPath?: string;
  /** Spawn the daemon when nothing is listening, at first connect and when reconnecting. Default true. */
  autoStart?: boolean;
  /** Path to the daemon's entry script. Auto-start needs it: without one, a missing daemon is an error. */
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
  "session.forget",
  "daemon.shutdown",
  "session.list",
  "orchestrator.claim",
  "message.send",
  "message.inbox",
  "message.deliver",
  "message.ack",
  "events.subscribe",
] as const satisfies readonly ClientMethodName[];

/**
 * Methods that must not be sent twice. If the connection drops after one of these went out, the
 * daemon may have acted on it, so the caller gets an error instead of a silent retry.
 */
const NOT_REPLAYABLE = new Set<string>(["message.send", "session.register", "daemon.shutdown"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errCode = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;
const isMissingDaemon = (e: unknown) => errCode(e) === "ENOENT" || errCode(e) === "ECONNREFUSED";

/**
 * Why a connection failed, so a caller can pick the matching fix instead of parsing the message.
 * - `no_daemon`: nothing is listening, and the client was told not to start one.
 * - `socket_path_too_long`: the Unix socket path is over the OS limit.
 * - `permission`: the socket exists but this user may not use it.
 * - `not_daemon`: something else is listening on the socket.
 * - `token_empty`: the daemon token file exists but is empty.
 * - `daemon_missing`: the daemon program could not be found.
 * - `start_timeout`: a daemon was started and did not come up in time.
 * - `connection`: the connection broke or timed out.
 */
export type ClientErrorKind =
  | "no_daemon"
  | "socket_path_too_long"
  | "permission"
  | "not_daemon"
  | "token_empty"
  | "daemon_missing"
  | "start_timeout"
  | "connection";

/** An error whose message is already written for the user. Never remapped. */
export class ClientError extends Error {
  constructor(message: string, options?: ErrorOptions & { kind?: ClientErrorKind }) {
    super(message, options);
    this.name = "ConvenoClientError";
    this.kind = options?.kind;
  }
  readonly kind: ClientErrorKind | undefined;
}

/** The socket broke or closed. `sent` tells whether the request may have reached the daemon. */
class ConnectionLost extends Error {
  constructor(
    message: string,
    readonly sent: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConnectionLost";
  }
}

const noDaemonMessage = (socketPath: string) =>
  `No Conveno daemon is listening at ${socketPath}. Run "conveno daemon start", or enable autoStart.`;

/** Turn a Node socket error into a message that says what happened and what to do. */
function plainError(e: unknown, socketPath: string): Error {
  if (e instanceof ClientError || e instanceof ConvenoError) return e;
  const code = errCode(e) ?? errCode((e as Error | undefined)?.cause);
  switch (code) {
    case "ECONNREFUSED":
    case "ENOENT":
      return new ClientError(noDaemonMessage(socketPath), { cause: e, kind: "no_daemon" });
    case "EACCES":
    case "EPERM":
      return new ClientError(
        `Permission denied on the Conveno daemon socket at ${socketPath}. It may belong to another user. Check who owns it, or remove it and run "conveno daemon start".`,
        { cause: e, kind: "permission" },
      );
    case "EPIPE":
    case "ECONNRESET":
      return new ClientError(
        `The connection to the Conveno daemon at ${socketPath} broke. Run "conveno daemon status", then try again.`,
        { cause: e, kind: "connection" },
      );
    case "ENAMETOOLONG":
      return new ClientError(socketPathTooLongMessage(socketPath, process.platform), {
        cause: e,
        kind: "socket_path_too_long",
      });
    default:
      if (code !== undefined) {
        return new ClientError(
          `Could not talk to the Conveno daemon at ${socketPath} (${code}). Run "conveno daemon status", then try again.`,
          { cause: e, kind: "connection" },
        );
      }
      return e instanceof Error ? e : new Error(String(e));
  }
}

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
        new ClientError(
          `The Conveno daemon token file is missing at ${tokenPath}. Run "conveno daemon start", then try again.`,
          { kind: "no_daemon" },
        ),
        { code: "ENOENT" },
      );
    }
    throw e;
  }
  const token = text.trim();
  if (!token) {
    throw new ClientError(
      `The Conveno daemon token file ${tokenPath} is empty. Run "conveno daemon stop", then "conveno daemon start".`,
      { kind: "token_empty" },
    );
  }
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
  private readonly decoder = createLineDecoder();
  private closed = false;

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
    private readonly onEvent: (e: EventPayload) => void = () => {},
  ) {
    socket.on("data", (chunk) => {
      for (const r of this.decoder.push(chunk)) if (r.ok) this.onMessage(r.value);
    });
    socket.on("error", (e) => this.failAll(new ConnectionLost(e.message, true, { cause: e })));
    socket.on("close", () =>
      this.failAll(new ConnectionLost("Connection to the Conveno daemon closed.", true)),
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private onMessage(value: unknown): void {
    if ((value as { method?: unknown } | null)?.method === EVENT_NOTIFICATION_METHOD) {
      const parsed = EventPayload.safeParse((value as { params?: unknown }).params);
      if (parsed.success) this.onEvent(parsed.data);
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
      return Promise.reject(
        new ConnectionLost("Connection to the Conveno daemon is closed.", false),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ClientError(
            `Request ${method} timed out after ${this.timeoutMs} ms. Check that the daemon is running with "conveno daemon status".`,
            { kind: "connection" },
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

  close(): Promise<void> {
    this.failAll(new ClientError("The Conveno client is closed."));
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once("close", () => resolve());
      this.socket.destroy();
    });
  }
}

function validate(method: string, params: unknown): Record<string, unknown> {
  const schemas = ipcMethods[method as keyof typeof ipcMethods];
  const parsed = schemas.params.safeParse(params ?? {});
  if (!parsed.success) {
    // Field and rule only, not zod's raw output: `Invalid "name": invalid session name.`
    const detail = parsed.error.issues
      .map((i) => (i.path.length > 0 ? `"${i.path.join(".")}": ${i.message}` : i.message))
      .join("; ");
    const lead = parsed.error.issues.every((i) => i.path.length > 0)
      ? "Invalid "
      : "Invalid request: ";
    throw new ConvenoError(RpcErrorCode.InvalidParams, `${lead}${detail}.`);
  }
  return parsed.data as Record<string, unknown>;
}

function checkResult(method: string, result: unknown): unknown {
  const schemas = ipcMethods[method as keyof typeof ipcMethods];
  const r = schemas.result.safeParse(result);
  if (!r.success) {
    throw new ConvenoError(
      RpcErrorCode.InternalError,
      `The daemon returned an unexpected result for ${method}. Update the daemon and client to the same version.`,
    );
  }
  return r.data;
}

/** One typed call on one connection. Used for the handshake and by `Link`. */
async function typedCall(conn: Connection, method: string, params: unknown): Promise<unknown> {
  const wire = validate(method, params);
  return checkResult(method, await conn.call(method, wire));
}

/**
 * Open a socket and run the mutual handshake. The token never crosses the wire: the daemon must
 * prove it knows it before the client proves the same back.
 */
async function handshake(
  socketPath: string,
  tokenPath: string,
  kind: ClientKind,
  timeoutMs: number,
  onEvent: (e: EventPayload) => void,
): Promise<Connection> {
  const socket = await openSocket(socketPath);
  const conn = new Connection(socket, timeoutMs, onEvent);
  try {
    const token = await readToken(tokenPath);
    const nonce = newAuthNonce();
    const hello = (await typedCall(conn, "hello", {
      protocolVersion: PROTOCOL_VERSION,
      client: kind,
      nonce,
    })) as { proof: string; challenge: string };
    if (!proofsMatch(hello.proof, daemonProof(token, nonce))) {
      throw new ClientError(
        `The process on ${socketPath} is not the Conveno daemon. Stop it, or remove the socket, and try again.`,
        { kind: "not_daemon" },
      );
    }
    await typedCall(conn, "auth", { proof: clientProof(token, hello.challenge) });
    return conn;
  } catch (e) {
    await conn.close();
    throw e;
  }
}

function requireDaemonEntry(entry: string | undefined): string {
  if (entry) return entry;
  throw new ClientError(
    'Cannot find the Conveno daemon program. Pass daemonEntry to connect(), or run "conveno daemon start" yourself.',
    { kind: "daemon_missing" },
  );
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
  throw new ClientError(
    `The Conveno daemon did not start within ${startTimeout} ms (socket ${socketPath}). Run "conveno daemon status" to check it.`,
    { cause: last, kind: "start_timeout" },
  );
}

/**
 * The client's one logical connection. When the socket breaks, for instance because the daemon
 * restarted, the next call reconnects, redoes the handshake (starting the daemon when allowed),
 * re-subscribes to events, and retries once.
 */
class Link {
  conn!: Connection;
  private reconnecting?: Promise<void>;
  private closed = false;
  private subscription?: Record<string, unknown>;
  private readonly handlers = new Set<(e: EventPayload) => void>();

  constructor(
    private readonly dial: (onEvent: (e: EventPayload) => void) => Promise<Connection>,
    private readonly socketPath: string,
  ) {}

  readonly dispatch = (e: EventPayload): void => {
    for (const h of [...this.handlers]) {
      try {
        h(e);
      } catch {
        // A throwing listener must not break the connection.
      }
    }
  };

  async open(): Promise<void> {
    this.conn = await this.dial(this.dispatch);
  }

  onEvent(handler: (e: EventPayload) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const wire = validate(method, params);
    if (this.closed) throw new ClientError("The Conveno client is closed.");
    const used = this.conn;
    let result: unknown;
    try {
      result = await used.call(method, wire);
    } catch (e) {
      if (!(e instanceof ConnectionLost) || this.closed) throw plainError(e, this.socketPath);
      if (e.sent && NOT_REPLAYABLE.has(method)) {
        // The daemon may have handled it. Bring the link back for the next call, but do not resend.
        await this.reconnect(used).catch(() => {});
        throw new ClientError(
          `The connection to the Conveno daemon was lost while sending ${method}. It may or may not have gone through. Check, then try again.`,
          { cause: e },
        );
      }
      await this.reconnect(used);
      try {
        result = await this.conn.call(method, wire);
      } catch (e2) {
        throw plainError(e2, this.socketPath);
      }
    }
    if (method === "events.subscribe") this.subscription = wire;
    return checkResult(method, result);
  }

  private reconnect(failed: Connection): Promise<void> {
    if (this.conn !== failed) return Promise.resolve(); // Another call already replaced it.
    this.reconnecting ??= (async () => {
      try {
        const next = await this.dial(this.dispatch);
        if (this.closed) {
          await next.close();
          return;
        }
        this.conn = next;
        if (this.subscription) {
          // Subscriptions belong to a connection. Best effort: a failure here is not fatal.
          await typedCall(next, "events.subscribe", this.subscription).catch(() => {});
        }
      } finally {
        this.reconnecting = undefined;
      }
    })();
    return this.reconnecting;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.conn.close();
  }
}

/**
 * Connect to the daemon, complete the mutual handshake, and return a typed client. When nothing is
 * listening and `autoStart` is not false, spawns the daemon detached and retries with backoff. A
 * later call that finds the connection broken reconnects the same way and retries once.
 */
export async function connect(opts: ConnectOptions): Promise<ConvenoClient> {
  const platform = process.platform;
  const dir = opts.dataDir ?? dataDir(platform, process.env, homedir());
  const socketPath = opts.socketPath ?? defaultSocketPath(platform, process.env, homedir());
  if (isSocketPathTooLong(socketPath, platform)) {
    throw new ClientError(socketPathTooLongMessage(socketPath, platform), {
      kind: "socket_path_too_long",
    });
  }
  const tokenPath = dataPaths(platform, dir).token;
  const timeout = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const dial = async (onEvent: (e: EventPayload) => void): Promise<Connection> => {
    const attempt = () => handshake(socketPath, tokenPath, opts.kind, timeout, onEvent);
    try {
      try {
        return await attempt();
      } catch (e) {
        if (!isMissingDaemon(e)) throw e;
        if (opts.autoStart === false)
          throw new ClientError(noDaemonMessage(socketPath), { cause: e, kind: "no_daemon" });
        return await startAndConnect(
          requireDaemonEntry(opts.daemonEntry),
          dir,
          attempt,
          socketPath,
          opts.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        );
      }
    } catch (e) {
      throw plainError(e, socketPath);
    }
  };

  const link = new Link(dial, socketPath);
  await link.open();

  const client: Record<string, unknown> = {
    onEvent: (handler: (e: EventPayload) => void) => link.onEvent(handler),
    close: () => link.close(),
  };
  for (const method of CLIENT_METHODS) {
    client[method] = (params: unknown) => link.call(method, params);
  }
  return client as unknown as ConvenoClient;
}
