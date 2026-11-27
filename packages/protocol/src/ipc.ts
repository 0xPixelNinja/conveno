import { z } from "zod";
import { MessageId, SessionId, TicketId } from "./ids.js";
import {
  AnswerContent,
  HandoffContent,
  Message,
  messageEnvelopeShape,
  QuestionContent,
  SystemContent,
  TextContent,
} from "./message.js";
import {
  CliKind,
  DeliveryTier,
  IsoTimestamp,
  SessionName,
  SessionNameInput,
  SessionStatus,
  Sha256Hex,
} from "./primitives.js";
import type { RpcErrorObject } from "./rpc.js";
import { makeError, RpcErrorCode, RpcId, RpcRequestEnvelope } from "./rpc.js";
import { HostPids, RepoInfo, Session, STATUS_TEXT_MAX } from "./session.js";
import { Ticket } from "./ticket.js";
import { PROTOCOL_VERSION } from "./version.js";

/* ---------- handshake ---------- */

export const CLIENT_KINDS = ["mcp", "cli", "adapter"] as const;
export const ClientKind = z.enum(CLIENT_KINDS);
export type ClientKind = z.infer<typeof ClientKind>;

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32 bytes as lowercase hex");

const HelloParams = z.object({
  protocolVersion: z.string().min(1),
  client: ClientKind,
  /** 32 random bytes, hex. The daemon proves it knows the token by signing this. */
  nonce: Hex32,
});
const HelloResult = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  daemonVersion: z.string().min(1),
  /** `HMAC-SHA256(token, "conveno/1 daemon " + nonce)`, hex. */
  proof: Sha256Hex,
  /** 32 random bytes, hex. The client signs this in `auth`. */
  challenge: Hex32,
});
const AuthParams = z.object({
  /** `HMAC-SHA256(token, "conveno/1 client " + challenge)`, hex. */
  proof: Sha256Hex,
});

/* ---------- sessions ---------- */

const sid = { sessionId: SessionId };
const SessionResult = z.object({ session: Session });

const RegisterParams = z.object({
  /** Requested name. If omitted the daemon assigns one such as `claude@repo-1`. */
  name: SessionNameInput.optional(),
  cli: CliKind,
  cliVersion: z.string().min(1).max(64).optional(),
  cwd: z.string().min(1),
  repo: RepoInfo.optional(),
  pid: z.number().int().positive().optional(),
  /** The CLI process hosting the session. See `Session.hostPid`. */
  hostPid: z.number().int().positive().optional(),
  /** The MCP server's raw ancestor chain, nearest first (1 to 8 pids). */
  hostPids: HostPids.optional(),
  /** Set by the daemon when it spawned this session itself. */
  spawnedBy: SessionId.optional(),
});

const SetStatusParams = z
  .object({
    ...sid,
    status: SessionStatus.optional(),
    /** `null` clears the status line. */
    statusText: z.string().max(STATUS_TEXT_MAX).nullable().optional(),
  })
  .refine((p) => p.status !== undefined || p.statusText !== undefined, {
    message: "provide status and/or statusText",
  });

const ListParams = z.object({
  repo: z.string().min(1).optional(),
  cli: CliKind.optional(),
  includeOffline: z.boolean().default(false),
});

/* ---------- messages ---------- */

const sendShape = {
  ...sid,
  to: messageEnvelopeShape.to,
  urgent: messageEnvelopeShape.urgent,
  replyTo: messageEnvelopeShape.replyTo,
};
const SendParams = z.discriminatedUnion("kind", [
  TextContent.extend(sendShape),
  HandoffContent.extend(sendShape),
  QuestionContent.extend(sendShape),
  AnswerContent.extend(sendShape),
  SystemContent.extend(sendShape),
]);

export const INBOX_DEFAULT_LIMIT = 50;
export const INBOX_MAX_LIMIT = 200;
export const DELIVER_DEFAULT_LIMIT = 20;
export const ACK_MAX_IDS = 100;

/* ---------- peek ---------- */

export const PEEK_MODES = ["recent", "full", "summary"] as const;
export const PeekMode = z.enum(PEEK_MODES);
export type PeekMode = z.infer<typeof PeekMode>;

export const Turn = z.object({
  role: z.enum(["user", "assistant", "tool", "system"]),
  text: z.string(),
  ts: IsoTimestamp.optional(),
});
export type Turn = z.infer<typeof Turn>;

/* ---------- spawn ---------- */

export const SPAWN_MODES = ["visible", "headless"] as const;
export const SpawnMode = z.enum(SPAWN_MODES);
export type SpawnMode = z.infer<typeof SpawnMode>;

/* ---------- events ---------- */

export const EVENT_NAMES = [
  "message.received",
  "ticket.created",
  "ticket.answered",
  "session.updated",
  "orchestrator.changed",
] as const;
export const EventName = z.enum(EVENT_NAMES);
export type EventName = z.infer<typeof EventName>;

/** Method name used for every daemon-to-client event notification. */
export const EVENT_NOTIFICATION_METHOD = "event";

export const EventPayload = z.discriminatedUnion("event", [
  z.object({ event: z.literal("message.received"), data: z.object({ message: Message }) }),
  z.object({ event: z.literal("ticket.created"), data: z.object({ ticket: Ticket }) }),
  z.object({ event: z.literal("ticket.answered"), data: z.object({ ticket: Ticket }) }),
  z.object({
    event: z.literal("session.updated"),
    data: z.object({
      session: Session,
      change: z.enum(["registered", "updated", "unregistered", "offline"]),
    }),
  }),
  z.object({
    event: z.literal("orchestrator.changed"),
    data: z.object({ orchestrator: SessionId.nullable(), previous: SessionId.nullable() }),
  }),
]);
export type EventPayload = z.infer<typeof EventPayload>;

export const EventNotification = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal(EVENT_NOTIFICATION_METHOD),
  params: EventPayload,
});
export type EventNotification = z.infer<typeof EventNotification>;

export function makeEventNotification(payload: EventPayload): EventNotification {
  return { jsonrpc: "2.0", method: EVENT_NOTIFICATION_METHOD, params: payload };
}

/* ---------- method table ---------- */

export const ipcMethods = {
  hello: { params: HelloParams, result: HelloResult },
  auth: { params: AuthParams, result: z.object({ ok: z.literal(true) }) },
  "session.register": { params: RegisterParams, result: SessionResult },
  "session.heartbeat": {
    params: z.object(sid),
    result: z.object({ lastSeenAt: IsoTimestamp }),
  },
  "session.unregister": { params: z.object(sid), result: z.object({ ok: z.literal(true) }) },
  "session.rename": {
    params: z.object({ ...sid, name: SessionNameInput }),
    result: SessionResult,
  },
  "session.setStatus": { params: SetStatusParams, result: SessionResult },
  "session.byHost": {
    // The hook's own host pid. Matches by equality with an online session's `hostPid`; none or
    // several give null.
    params: z.object({ pid: z.number().int().positive() }),
    result: z.object({ session: Session.nullable() }),
  },
  "daemon.shutdown": { params: z.object({}), result: z.object({ ok: z.literal(true) }) },
  "session.list": { params: ListParams, result: z.object({ sessions: z.array(Session) }) },
  "orchestrator.claim": {
    params: z.object(sid),
    result: z.object({ orchestrator: SessionId, previous: SessionId.nullable() }),
  },
  "message.send": {
    params: SendParams,
    result: z.object({
      message: Message,
      delivery: DeliveryTier,
      deliveredTo: z.object({ id: SessionId, name: SessionName }),
    }),
  },
  "message.inbox": {
    params: z.object({
      ...sid,
      unreadOnly: z.boolean().default(true),
      limit: z.number().int().min(1).max(INBOX_MAX_LIMIT).default(INBOX_DEFAULT_LIMIT),
    }),
    result: z.object({
      messages: z.array(Message),
      unreadCount: z.number().int().min(0),
    }),
  },
  "message.deliver": {
    params: z.object({
      ...sid,
      limit: z.number().int().min(1).max(INBOX_MAX_LIMIT).default(DELIVER_DEFAULT_LIMIT),
    }),
    // Atomically returns not-yet-delivered messages (urgent first, then createdAt) and marks them delivered, not read.
    result: z.object({ messages: z.array(Message), remaining: z.number().int().min(0) }),
  },
  "message.ack": {
    params: z.object({ ...sid, ids: z.array(MessageId).min(1).max(ACK_MAX_IDS) }),
    result: z.object({ acked: z.number().int().min(0) }),
  },
  "ticket.create": {
    params: z.object({
      ...sid,
      question: z.string().min(1).max(8_000),
      options: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
    }),
    result: z.object({ ticket: Ticket }),
  },
  "ticket.answer": {
    params: z.object({ ...sid, ticketId: TicketId, response: z.string().min(1).max(65_536) }),
    result: z.object({ ticket: Ticket }),
  },
  "spawn.request": {
    params: z.object({
      ...sid,
      cli: CliKind,
      prompt: z.string().min(1).max(65_536),
      cwd: z.string().min(1).optional(),
      mode: SpawnMode.default("visible"),
      name: SessionNameInput.optional(),
    }),
    // The new session registers itself later; `sessionId` is present only once it has.
    result: z.object({
      requestId: z.string().min(1),
      mode: SpawnMode,
      sessionId: SessionId.optional(),
    }),
  },
  "peek.request": {
    params: z.object({
      ...sid,
      session: z.union([SessionId, SessionName]),
      mode: PeekMode,
      n: z.number().int().min(1).max(500).optional(),
    }),
    result: z.object({
      session: SessionId,
      mode: PeekMode,
      turns: z.array(Turn),
      /** Present for `summary` mode when the target produced one. */
      summary: z.string().optional(),
      truncated: z.boolean(),
      /** Always true on the wire: redaction is mandatory and not configurable per request. */
      redacted: z.literal(true),
    }),
  },
  "events.subscribe": {
    params: z.object({ ...sid, topics: z.array(EventName).min(1).optional() }),
    result: z.object({ subscribed: z.array(EventName) }),
  },
} as const;

export type IpcMethodName = keyof typeof ipcMethods;
export const IPC_METHOD_NAMES = Object.keys(ipcMethods) as IpcMethodName[];

export type IpcParams<M extends IpcMethodName> = z.infer<(typeof ipcMethods)[M]["params"]>;
export type IpcResult<M extends IpcMethodName> = z.infer<(typeof ipcMethods)[M]["result"]>;

export type ParsedIpcRequest = {
  [M in IpcMethodName]: { id: RpcId; method: M; params: IpcParams<M> };
}[IpcMethodName];

export type ParseRequestResult =
  | { ok: true; request: ParsedIpcRequest }
  | { ok: false; id: RpcId | null; error: RpcErrorObject };

function isMethod(name: string): name is IpcMethodName {
  return Object.hasOwn(ipcMethods, name);
}

/**
 * Validate a decoded JSON value as a Conveno IPC request: JSON-RPC envelope first, then the
 * params schema for the named method. Never throws; failures carry a ready-to-send error object.
 */
export function parseIpcRequest(input: unknown): ParseRequestResult {
  const env = RpcRequestEnvelope.safeParse(input);
  if (!env.success) {
    const rawId = (input as { id?: unknown } | null)?.id;
    const id = RpcId.safeParse(rawId);
    return {
      ok: false,
      id: id.success ? id.data : null,
      error: {
        code: RpcErrorCode.InvalidRequest,
        message: "Invalid Request",
        data: env.error.issues,
      },
    };
  }
  const { id, method, params } = env.data;
  if (!isMethod(method)) {
    return {
      ok: false,
      id,
      error: { code: RpcErrorCode.MethodNotFound, message: `Method not found: ${method}` },
    };
  }
  const parsed = ipcMethods[method].params.safeParse(params ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      id,
      error: {
        code: RpcErrorCode.InvalidParams,
        message: "Invalid params",
        data: parsed.error.issues,
      },
    };
  }
  return { ok: true, request: { id, method, params: parsed.data } as ParsedIpcRequest };
}

/** Build the JSON-RPC error response for a failed `parseIpcRequest`. */
export function errorResponseFor(r: Extract<ParseRequestResult, { ok: false }>) {
  return makeError(r.id, r.error.code, r.error.message, r.error.data);
}
