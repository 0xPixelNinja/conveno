import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientProof, daemonProof, newAuthNonce, proofsMatch } from "@0xpixelninja/conveno-core";
import {
  createLineDecoder,
  type EventPayload,
  encodeFrame,
  PROTOCOL_VERSION,
} from "@0xpixelninja/conveno-protocol";
import { type DaemonHandle, type DaemonOptions, startDaemon } from "./server.js";

export interface RpcReply {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** A bare socket client: no schema validation, so tests can send anything. */
export class RawClient {
  readonly replies: RpcReply[] = [];
  readonly events: EventPayload[] = [];
  closed = false;
  private nextId = 1;
  private readonly waiters: (() => void)[] = [];
  private readonly decoder = createLineDecoder(16 * 1024 * 1024);

  private constructor(readonly socket: Socket) {
    socket.on("data", (chunk) => {
      for (const f of this.decoder.push(chunk)) {
        if (!f.ok) continue;
        const v = f.value as { id?: unknown; method?: string; params?: EventPayload };
        if (v.method === "event" && v.id === undefined) this.events.push(v.params as EventPayload);
        else this.replies.push(v as RpcReply);
      }
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    });
    socket.on("error", () => {});
  }

  static connect(path: string): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const s = connect(path);
      s.once("connect", () => resolve(new RawClient(s)));
      s.once("error", reject);
    });
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  /** Write a raw string (no framing added). */
  raw(text: string): void {
    this.socket.write(text);
  }

  async nextReply(): Promise<RpcReply> {
    while (this.replies.length === 0) {
      if (this.closed) throw new Error("socket closed before a reply arrived");
      await this.wait();
    }
    return this.replies.shift() as RpcReply;
  }

  /** Send a request and return the full JSON-RPC reply (result or error). */
  async rpc(method: string, params?: Record<string, unknown>): Promise<RpcReply> {
    const id = this.nextId++;
    this.socket.write(encodeFrame({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
    const r = await this.nextReply();
    if (r.id !== id) throw new Error(`reply id ${String(r.id)} does not match request ${id}`);
    return r;
  }

  /** Send a request and return its result; throws on a JSON-RPC error. */
  async call(method: string, params?: Record<string, unknown>): Promise<any> {
    const r = await this.rpc(method, params);
    if (r.error) throw new Error(`${method} failed: ${r.error.code} ${r.error.message}`);
    return r.result;
  }

  async waitForEvents(count: number): Promise<EventPayload[]> {
    while (this.events.length < count) {
      if (this.closed) throw new Error("socket closed before events arrived");
      await this.wait();
    }
    return this.events;
  }

  async waitClosed(): Promise<void> {
    while (!this.closed) await this.wait();
  }

  close(): void {
    this.socket.destroy();
  }
}

/** Run the full mutual handshake on a raw client, verifying the daemon's proof. */
export async function handshake(c: RawClient, token: string): Promise<void> {
  const nonce = newAuthNonce();
  const hello = await c.call("hello", { protocolVersion: PROTOCOL_VERSION, client: "cli", nonce });
  if (!proofsMatch(hello.proof, daemonProof(token, nonce)))
    throw new Error("daemon proof is wrong");
  await c.call("auth", { proof: clientProof(token, hello.challenge) });
}

export interface Harness {
  dir: string;
  socketPath: string;
  daemon: DaemonHandle;
  token(): string;
  clock: { ms: number };
  dead: Set<number>;
  clients: RawClient[];
  client(): Promise<RawClient>;
  /** A client that already completed `hello`. */
  authed(): Promise<RawClient>;
  restart(over?: Partial<DaemonOptions>): Promise<void>;
  stop(): Promise<void>;
}

const START = Date.parse("2026-11-27T09:00:00.000Z");

export function socketIn(dir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\convenod-test-${randomBytes(6).toString("hex")}`;
  }
  return join(dir, "d.sock");
}

/** Start a daemon in a fresh temp dir with a fake clock and a fake `isAlive`. */
export async function startHarness(over: Partial<DaemonOptions> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "convenod-"));
  const socketPath = socketIn(dir);
  const clock = { ms: START };
  const dead = new Set<number>();
  const clients: RawClient[] = [];
  const base = (): DaemonOptions => ({
    dataDir: dir,
    socketPath,
    now: () => new Date(clock.ms),
    isAlive: (pid) => !dead.has(pid),
    idleExitMs: Number.POSITIVE_INFINITY,
    sweepIntervalMs: 3_600_000,
    ...over,
  });
  const h: Harness = {
    dir,
    socketPath,
    daemon: await startDaemon(base()),
    token: () => readFileSync(join(dir, "daemon.token"), "utf8").trim(),
    clock,
    dead,
    clients,
    async client() {
      const c = await RawClient.connect(socketPath);
      clients.push(c);
      return c;
    },
    async authed() {
      const c = await h.client();
      await handshake(c, h.token());
      return c;
    },
    async restart(next = {}) {
      for (const c of clients.splice(0)) c.close();
      await h.daemon.close();
      h.daemon = await startDaemon({ ...base(), ...next });
    },
    async stop() {
      for (const c of clients.splice(0)) c.close();
      await h.daemon.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export const register = (c: RawClient, over: Record<string, unknown> = {}) =>
  c.call("session.register", { cli: "claude", cwd: join(tmpdir(), "proj"), ...over }) as Promise<{
    session: { id: string; name: string } & Record<string, any>;
  }>;
