import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLineDecoder,
  encodeFrame,
  makeError,
  makeEventNotification,
  makeResult,
  newDeviceId,
  newSessionId,
  PROTOCOL_VERSION,
  RpcErrorCode,
} from "@0xpixelninja/conveno-protocol";

export const TOKEN = "test-token-123";
const NOW = "2026-11-27T09:30:00.000Z";

export const sessionFixture = (overrides: Record<string, unknown> = {}) => ({
  id: newSessionId(),
  name: "claude@repo-1",
  cli: "claude",
  deviceId: newDeviceId(),
  cwd: "/home/u/repo",
  status: "idle",
  isOrchestrator: false,
  deliveryTier: "inbox",
  spawnDepth: 0,
  startedAt: NOW,
  lastSeenAt: NOW,
  ...overrides,
});

export interface FakeServer {
  socketPath: string;
  dataDir: string;
  hellos: unknown[];
  /** Methods the server stays silent on, to exercise timeouts. */
  ignore: Set<string>;
  close(): Promise<void>;
}

export async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "conveno-client-"));
}

/** Endpoint for this platform: a named pipe on win32, a short unix socket path elsewhere. */
export function tempSocketPath(dir: string, tag = "s"): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\conveno-test-${tag}-${Math.random().toString(36).slice(2)}`;
  }
  return join(dir, `${tag}.sock`);
}

/** Minimal NDJSON daemon: hello, session.list, session.heartbeat, one event, a few error cases. */
export async function startFakeServer(): Promise<FakeServer> {
  const dir = await tempDataDir();
  const socketPath = tempSocketPath(dir);
  await writeFile(join(dir, "daemon.token"), `${TOKEN}\n`);
  const sockets = new Set<Socket>();
  const state: FakeServer = {
    socketPath,
    dataDir: dir,
    hellos: [],
    ignore: new Set(),
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = createLineDecoder();
    let authed = false;
    const send = (o: unknown) => socket.write(encodeFrame(o));
    socket.on("data", (chunk) => {
      for (const r of decoder.push(chunk)) {
        if (!r.ok) continue;
        const req = r.value as { id: number; method: string; params: Record<string, unknown> };
        if (state.ignore.has(req.method)) continue;
        if (req.method === "hello") {
          state.hellos.push(req.params);
          if (req.params.authToken !== TOKEN) {
            send(makeError(req.id, RpcErrorCode.Unauthorized, "Invalid token."));
          } else {
            authed = true;
            send(makeResult(req.id, { protocolVersion: PROTOCOL_VERSION, daemonVersion: "0.0.0" }));
          }
        } else if (!authed) {
          send(makeError(req.id, RpcErrorCode.Unauthorized, "Call hello first."));
        } else if (req.method === "session.list") {
          send(makeResult(req.id, { sessions: [sessionFixture()] }));
        } else if (req.method === "session.heartbeat") {
          send(makeResult(req.id, { lastSeenAt: NOW }));
        } else if (req.method === "orchestrator.claim") {
          send(makeError(req.id, RpcErrorCode.Conflict, "Another session holds the role."));
        } else if (req.method === "session.unregister") {
          send(makeResult(req.id, { ok: "not-true" }));
        } else if (req.method === "events.subscribe") {
          send(makeResult(req.id, { subscribed: ["session.updated"] }));
          send(
            makeEventNotification({
              event: "orchestrator.changed",
              data: { orchestrator: null, previous: null },
            }),
          );
        } else {
          send(makeError(req.id, RpcErrorCode.MethodNotFound, `Method not found: ${req.method}`));
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return state;
}
