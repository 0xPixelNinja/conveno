import type { EventPayload, IpcParams, IpcResult, ipcMethods } from "@conveno/protocol";
import type { z } from "zod";

/** IPC methods a client can call after the handshake (`hello` is the client's own business). */
export type ClientMethodName =
  | "session.register"
  | "session.heartbeat"
  | "session.unregister"
  | "session.rename"
  | "session.setStatus"
  | "session.byHost"
  | "session.forget"
  | "daemon.shutdown"
  | "session.list"
  | "orchestrator.claim"
  | "message.send"
  | "message.inbox"
  | "message.deliver"
  | "message.ack"
  | "events.subscribe";

/** Params as the caller writes them: schema defaults (such as `includeOffline`) may be omitted. */
export type ClientParams<M extends ClientMethodName> = z.input<(typeof ipcMethods)[M]["params"]>;
export type ClientResult<M extends ClientMethodName> = IpcResult<M>;
export type ClientWireParams<M extends ClientMethodName> = IpcParams<M>;

export type ConvenoClientMethods = {
  [M in ClientMethodName]: (params: ClientParams<M>) => Promise<IpcResult<M>>;
};

/** Typed view of the daemon IPC. Implemented by `packages/client`. */
export interface ConvenoClient extends ConvenoClientMethods {
  /** Listen for daemon event notifications. Returns an unsubscribe function. */
  onEvent(handler: (event: EventPayload) => void): () => void;
  close(): Promise<void>;
}
