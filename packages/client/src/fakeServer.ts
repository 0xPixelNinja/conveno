import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientProof, daemonProof, newAuthNonce, proofsMatch } from "@0xpixelninja/conveno-core";
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
  /** Everything every client sent, as raw lines, to check the token never appears. */
  raw: string[];
  /** Params of every events.subscribe received. */
  subscribes: Record<string, unknown>[];
  /** Answer hello with a proof made from the wrong token, like a squatter on the socket. */
  impostor: boolean;
  /** Stop listening and drop every connection; the socket path stays reusable. */
  stop(): Promise<void>;
  /** Listen again on the same socket path with the same token. */
  start(): Promise<void>;
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

/** Minimal NDJSON daemon: mutual handshake, session.list, session.heartbeat, one event, a few error cases. */
export async function startFakeServer(): Promise<FakeServer> {
  const dir = await tempDataDir();
  const socketPath = tempSocketPath(dir);
  await writeFile(join(dir, "daemon.token"), `${TOKEN}\n`);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  const state: FakeServer = {
    socketPath,
    dataDir: dir,
    hellos: [],
    raw: [],
    subscribes: [],
    impostor: false,
    ignore: new Set(),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        if (!server) return resolve();
        const s = server;
        server = undefined;
        s.close(() => resolve());
      }),
    start: async () => {
      const srv = createServer(onConnection);
      server = srv;
      await new Promise<void>((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(socketPath, () => resolve());
      });
    },
    close: () => state.stop(),
  };

  function onConnection(socket: Socket): void {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = createLineDecoder();
    const challenge = newAuthNonce();
    let helloDone = false;
    let authed = false;
    const send = (o: unknown) => socket.write(encodeFrame(o));
    socket.on("data", (chunk) => {
      state.raw.push(chunk.toString());
      for (const r of decoder.push(chunk)) {
        if (!r.ok) continue;
        const req = r.value as { id: number; method: string; params: Record<string, unknown> };
        if (state.ignore.has(req.method)) continue;
        if (req.method === "hello") {
          state.hellos.push(req.params);
          helloDone = true;
          const proof = daemonProof(
            state.impostor ? "not the token" : TOKEN,
            String(req.params.nonce),
          );
          send(
            makeResult(req.id, {
              protocolVersion: PROTOCOL_VERSION,
              daemonVersion: "0.0.0",
              proof,
              challenge,
            }),
          );
        } else if (req.method === "auth") {
          if (helloDone && proofsMatch(String(req.params.proof), clientProof(TOKEN, challenge))) {
            authed = true;
            send(makeResult(req.id, { ok: true }));
          } else {
            send(makeError(req.id, RpcErrorCode.Unauthorized, "Invalid proof."));
          }
        } else if (!authed) {
          send(makeError(req.id, RpcErrorCode.Unauthorized, "Finish the handshake first."));
        } else if (req.method === "session.list") {
          send(makeResult(req.id, { sessions: [sessionFixture()] }));
        } else if (req.method === "session.heartbeat") {
          send(makeResult(req.id, { lastSeenAt: NOW }));
        } else if (req.method === "orchestrator.claim") {
          send(makeError(req.id, RpcErrorCode.Conflict, "Another session holds the role."));
        } else if (req.method === "session.unregister") {
          send(makeResult(req.id, { ok: "not-true" }));
        } else if (req.method === "events.subscribe") {
          state.subscribes.push(req.params);
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
  }

  await state.start();
  return state;
}
