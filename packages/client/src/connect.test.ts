import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConvenoError } from "@0xpixelninja/conveno-core";
import { type EventPayload, newSessionId, RpcErrorCode } from "@0xpixelninja/conveno-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type FakeServer, startFakeServer, tempDataDir, tempSocketPath } from "./fakeServer.js";
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
  it("sends hello with protocol version, kind and token", async () => {
    const s = await setup();
    await client(s);
    expect(s.hellos).toEqual([
      { protocolVersion: "conveno/1", client: "cli", authToken: "test-token-123" },
    ]);
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

  it("surfaces a rejected token as a ConvenoError", async () => {
    const s = await setup();
    await writeFile(join(s.dataDir, "daemon.token"), "wrong");
    await expect(client(s)).rejects.toMatchObject({ code: RpcErrorCode.Unauthorized });
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
    ).rejects.toThrow(/No Conveno daemon is listening/);
  });
});

describe("auto-start", () => {
  it("spawns the daemon once for two concurrent clients", async () => {
    const dir = await tempDataDir();
    const socketPath = tempSocketPath(dir, "auto");
    const countFile = join(dir, "starts.log");
    const entry = join(dir, "fake-daemon.mjs");
    await writeFile(join(dir, "daemon.token"), "test-token-123\n");
    // Stand-in daemon: records its start, listens after a delay, answers every request with a hello result.
    await writeFile(
      entry,
      `import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
appendFileSync(${JSON.stringify(countFile)}, "start\\n");
setTimeout(() => {
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\\n").filter(Boolean)) {
        const req = JSON.parse(line);
        const result = { protocolVersion: "conveno/1", daemonVersion: "0.0.0" };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }) + "\\n");
      }
    });
  });
  server.listen(${JSON.stringify(socketPath)});
  setTimeout(() => process.exit(0), 4000);
}, 300);
`,
    );
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
