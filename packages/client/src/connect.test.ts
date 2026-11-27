import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConvenoError } from "@conveno/core";
import { type EventPayload, newSessionId, RpcErrorCode } from "@conveno/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  type FakeServer,
  startFakeServer,
  TOKEN,
  tempDataDir,
  tempSocketPath,
} from "./fakeServer.js";
import { connect } from "./index.js";

const servers: FakeServer[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const s of servers.splice(0)) await s.close();
});

async function setup() {
  const s = await startFakeServer();
  servers.push(s);
  return s;
}
async function client(s: FakeServer, extra: { requestTimeoutMs?: number } = {}) {
  const c = await connect({
    kind: "cli",
    dataDir: s.dataDir,
    socketPath: s.socketPath,
    autoStart: false,
    ...extra,
  });
  closers.push(() => c.close());
  return c;
}
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("connect", () => {
  it("sends hello with protocol version, kind and a nonce, never the token", async () => {
    const s = await setup();
    await client(s);
    expect(s.hellos).toEqual([
      {
        protocolVersion: "conveno/1",
        client: "cli",
        nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
    expect(s.raw.join("")).not.toContain(TOKEN);
  });

  it("refuses a daemon that cannot prove it knows the token", async () => {
    const s = await setup();
    s.impostor = true;
    const err = await connect({
      kind: "cli",
      dataDir: s.dataDir,
      socketPath: s.socketPath,
      autoStart: false,
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(
      `The process on ${s.socketPath} is not the Conveno daemon. Stop it, or remove the socket, and try again.`,
    );
    // It never got a proof from us either.
    expect(s.raw.join("")).not.toContain('"method":"auth"');
  });

  it("returns typed results, with schema defaults optional for the caller", async () => {
    const s = await setup();
    const c = await client(s);
    const { sessions } = await c["session.list"]({});
    expect(sessions[0]?.name).toBe("claude@repo-1");
  });

  it("rejects invalid params before sending", async () => {
    const s = await setup();
    const c = await client(s);
    const bad = { sessionId: "nope" } as unknown as { sessionId: ReturnType<typeof newSessionId> };
    await expect(c["session.heartbeat"](bad)).rejects.toMatchObject({
      code: RpcErrorCode.InvalidParams,
    });
  });

  it("names the field and the rule, not zod's raw output", async () => {
    const s = await setup();
    const c = await client(s);
    const bad = { sessionId: newSessionId(), name: "Bad Name" } as unknown as Parameters<
      (typeof c)["session.rename"]
    >[0];
    const err = await c["session.rename"](bad).catch((e: Error) => e);
    expect((err as Error).message).toBe('Invalid "name": invalid session name.');
  });

  it("maps JSON-RPC errors to ConvenoError with code and message", async () => {
    const s = await setup();
    const c = await client(s);
    const err = await c["orchestrator.claim"]({ sessionId: newSessionId() }).catch((e) => e);
    expect(err).toBeInstanceOf(ConvenoError);
    expect(err.code).toBe(RpcErrorCode.Conflict);
    expect(err.message).toBe("Another session holds the role.");
  });

  it("fails when the daemon returns a result that breaks the schema", async () => {
    const s = await setup();
    const c = await client(s);
    await expect(c["session.unregister"]({ sessionId: newSessionId() })).rejects.toMatchObject({
      code: RpcErrorCode.InternalError,
    });
  });

  it("treats a daemon with a different token as not the daemon", async () => {
    const s = await setup();
    await writeFile(join(s.dataDir, "daemon.token"), "wrong");
    await expect(client(s)).rejects.toThrow(/is not the Conveno daemon/);
  });

  it("times out requests the daemon never answers", async () => {
    const s = await setup();
    const c = await client(s, { requestTimeoutMs: 100 });
    s.ignore.add("session.heartbeat");
    await expect(c["session.heartbeat"]({ sessionId: newSessionId() })).rejects.toThrow(
      /timed out/,
    );
  });

  it("delivers event notifications and supports unsubscribe", async () => {
    const s = await setup();
    const c = await client(s);
    const seen: EventPayload[] = [];
    const off = c.onEvent((e) => seen.push(e));
    await c["events.subscribe"]({ sessionId: newSessionId() });
    await settle();
    expect(seen.map((e) => e.event)).toEqual(["orchestrator.changed"]);
    off();
    await c["events.subscribe"]({ sessionId: newSessionId() });
    await settle();
    expect(seen).toHaveLength(1);
  });

  it("rejects calls after close", async () => {
    const s = await setup();
    const c = await client(s);
    await c.close();
    await expect(c["session.list"]({})).rejects.toThrow(/closed/);
  });

  it("reports a missing daemon when autoStart is off", async () => {
    const dir = await tempDataDir();
    await expect(
      connect({ kind: "cli", dataDir: dir, socketPath: tempSocketPath(dir), autoStart: false }),
    ).rejects.toThrow(/No Conveno daemon is listening.*conveno daemon start/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a socket path that is too long before connecting",
    async () => {
      const dir = await tempDataDir();
      const err = await connect({
        kind: "cli",
        dataDir: dir,
        socketPath: join(dir, `${"x".repeat(120)}.sock`),
        autoStart: false,
      }).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/too long.*XDG_RUNTIME_DIR/);
      expect((err as NodeJS.ErrnoException).code).toBeUndefined();
    },
  );
});

describe("reconnect", () => {
  it("reconnects after the daemon restarts and the call succeeds", async () => {
    const s = await setup();
    const c = await client(s);
    expect((await c["session.list"]({})).sessions).toHaveLength(1);
    await s.stop();
    await s.start();
    expect((await c["session.list"]({})).sessions).toHaveLength(1);
    expect(s.hellos).toHaveLength(2);
  });

  it("keeps heartbeating through a restart", async () => {
    const s = await setup();
    const c = await client(s);
    const sessionId = newSessionId();
    await c["session.heartbeat"]({ sessionId });
    await s.stop();
    await s.start();
    await expect(c["session.heartbeat"]({ sessionId })).resolves.toMatchObject({
      lastSeenAt: expect.any(String),
    });
    await s.stop();
    await s.start();
    await expect(c["session.heartbeat"]({ sessionId })).resolves.toBeDefined();
  });

  it("fails with a plain error when the daemon is gone and autoStart is off", async () => {
    const s = await setup();
    const c = await client(s);
    await s.stop();
    const err = await c["session.list"]({}).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/No Conveno daemon is listening.*conveno daemon start/);
    expect((err as NodeJS.ErrnoException).code).toBeUndefined();
  });

  it("subscribes again on the new connection and keeps delivering events", async () => {
    const s = await setup();
    const c = await client(s);
    const seen: EventPayload[] = [];
    c.onEvent((e) => seen.push(e));
    const sessionId = newSessionId();
    await c["events.subscribe"]({ sessionId });
    await settle();
    expect(seen).toHaveLength(1);
    await s.stop();
    await s.start();
    await c["session.list"]({});
    await settle();
    expect(s.subscribes).toHaveLength(2);
    expect(s.subscribes[1]).toMatchObject({ sessionId });
    expect(seen).toHaveLength(2);
  });

  it("does not reconnect after close", async () => {
    const s = await setup();
    const c = await client(s);
    await c.close();
    await expect(c["session.list"]({})).rejects.toThrow(/closed/);
    expect(s.hellos).toHaveLength(1);
  });

  it("shares one reconnect between concurrent calls", async () => {
    const s = await setup();
    const c = await client(s);
    await s.stop();
    await s.start();
    const all = await Promise.all([1, 2, 3, 4].map(() => c["session.list"]({})));
    expect(all.every((r) => r.sessions.length === 1)).toBe(true);
    expect(s.hellos).toHaveLength(2);
  });
});

/** Stand-in daemon source: records its start, listens after `delayMs`, speaks the handshake, answers the rest with `{}`. */
function fakeDaemonScript(socketPath: string, countFile: string, delayMs: number): string {
  return `import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { createHmac } from "node:crypto";
const hmac = (role, value) =>
  createHmac("sha256", "test-token-123").update("conveno/1 " + role + " " + value).digest("hex");
appendFileSync(${JSON.stringify(countFile)}, "start\\n");
setTimeout(() => {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\\n").filter(Boolean)) {
        const req = JSON.parse(line);
        const challenge = "ab".repeat(32);
        const result =
          req.method === "hello"
            ? { protocolVersion: "conveno/1", daemonVersion: "0.0.0", proof: hmac("daemon", req.params.nonce), challenge }
            : req.method === "auth"
              ? { ok: true }
              : { lastSeenAt: "2026-11-27T09:30:00.000Z" };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
      }
    });
  });
  server.listen(${JSON.stringify(socketPath)});
  setTimeout(() => process.exit(0), 4000);
}, ${delayMs});
`;
}

describe("auto-start", () => {
  it("spawns the daemon once for two concurrent clients", async () => {
    const dir = await tempDataDir();
    const socketPath = tempSocketPath(dir, "auto");
    const countFile = join(dir, "starts.log");
    const entry = join(dir, "fake-daemon.mjs");
    await writeFile(join(dir, "daemon.token"), "test-token-123\n");
    // Stand-in daemon: records its start, listens after a delay, answers every request with a hello result.
    await writeFile(entry, fakeDaemonScript(socketPath, countFile, 300));
    const open = () =>
      connect({ kind: "mcp", dataDir: dir, socketPath, daemonEntry: entry, startTimeoutMs: 3000 });
    const [a, b] = await Promise.all([open(), open()]);
    closers.push(
      () => a.close(),
      () => b.close(),
    );
    const starts = (await readFile(countFile, "utf8")).trim().split("\n");
    expect(starts).toHaveLength(1);
  });

  it("gives up with a clear error when the daemon never appears", async () => {
    const dir = await tempDataDir();
    const entry = join(dir, "noop.mjs");
    await writeFile(entry, "process.exit(0);\n");
    await expect(
      connect({
        kind: "cli",
        dataDir: dir,
        socketPath: tempSocketPath(dir, "never"),
        daemonEntry: entry,
        startTimeoutMs: 400,
      }),
    ).rejects.toThrow(/did not start within 400 ms/);
  });
});
