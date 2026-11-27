import { chmodSync, existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  ackEntries,
  baseName,
  ConvenoError,
  claimOrchestrator,
  clientProof,
  daemonProof,
  dataPaths,
  detectRepo,
  effectiveHolder,
  evaluateLiveness,
  generateSessionName,
  holderAfterDeparture,
  isOnline,
  type MailboxEntry,
  markDelivered,
  type NamedSession,
  newAuthNonce,
  pendingForInjection,
  proofsMatch,
  RESPONSE_BUDGET_BYTES,
  readInbox,
  resolveRecipient,
  statusAfterLiveness,
  takeWithinBytes,
  tooManyUnreadMessage,
  validateRename,
} from "@conveno/core";
import {
  createLineDecoder,
  type DeliveryTier,
  defaultSocketPath,
  EVENT_NAMES,
  type EventName,
  type EventPayload,
  encodeFrame,
  type IpcParams,
  isSocketPathTooLong,
  type Message,
  makeError,
  makeEventNotification,
  makeResult,
  newMessageId,
  newSessionId,
  type ParsedIpcRequest,
  PROTOCOL_VERSION,
  parseIpcRequest,
  RpcErrorCode,
  type RpcId,
  type Session,
  SessionId,
  sanitizeLine,
  socketPathTooLongMessage,
} from "@conveno/protocol";
import {
  acquireLock,
  clearStaleSocket,
  DaemonAlreadyRunningError,
  defaultIsAlive,
  ensureDir,
  loadOrCreateToken,
} from "./lifecycle.js";
import { createDaemonLog, type DaemonLog } from "./log.js";
import { type SessionRow, Store, toSession } from "./store.js";

export const DAEMON_VERSION = "0.1.1-rc.1";
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 15_000;
/** A connection that has not finished the handshake by then is closed. */
export const AUTH_TIMEOUT_MS = 5_000;
/** Unread messages one session may hold. */
export const MAX_UNREAD_PER_SESSION = 1000;
/**
 * How long an offline session stays listed (`conveno status --all`) before the sweep deletes it.
 * A closed session does not come back after a day: it returns only while its host process is alive,
 * and a new run of the CLI registers as a new session. 24 h keeps a working day's history visible
 * without piling up months of test sessions. It applies only when nothing is waiting for it.
 */
export const PRUNE_OFFLINE_AFTER_MS = 24 * 3_600_000;
/**
 * An offline session that a newer live session has replaced (same name, CLI and repo) is deleted
 * after this grace. It cannot come back: a heartbeat is refused while another live session holds
 * its name.
 */
export const PRUNE_SUPERSEDED_AFTER_MS = 5 * 60_000;
/**
 * An offline session with unread (queued) messages keeps them this long, whatever the other rules
 * say, so mail sent to a closed session survives a weekend. Then the session and its mailbox go.
 */
export const PRUNE_UNREAD_AFTER_MS = 7 * 24 * 3_600_000;

/** Sender id on `system` messages made by the daemon itself (no session sent them). */
export const DAEMON_SENDER_ID = SessionId.parse("0".repeat(26));

export interface DaemonOptions {
  dataDir: string;
  socketPath?: string;
  /** Exit after this long with no online sessions. Default 10 minutes; `Infinity` disables. */
  idleExitMs?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  /** Liveness sweep period. Default 15 s. Mostly useful in tests. */
  sweepIntervalMs?: number;
  /** Called after the daemon shut itself down because it was idle. */
  onIdleExit?: () => void;
  /** Called after the daemon shut down because a client sent `daemon.shutdown`. */
  onShutdown?: () => void;
  /** Close connections that have not finished the handshake after this long. Default 5 s. */
  authTimeoutMs?: number;
}

export interface DaemonHandle {
  socketPath: string;
  close(): Promise<void>;
  /** Run one liveness and idle check now. Meant for tests with a fake clock. */
  sweep(): void;
}

interface Subscription {
  sessionId: SessionId;
  topics: Set<EventName>;
}

interface Conn {
  socket: Socket;
  /** Set once `hello` has succeeded: the challenge the client must sign in `auth`. */
  challenge?: string;
  authed: boolean;
  sub?: Subscription;
  queue: Promise<void>;
}

const CLI_TIER: Record<string, DeliveryTier> = { claude: "next_turn", codex: "next_turn" };

class Daemon {
  readonly conns = new Set<Conn>();
  private readonly deviceId;
  private idleSince: number;
  private readonly startedMs: number;

  constructor(
    readonly store: Store,
    private readonly token: string,
    private readonly now: () => Date,
    private readonly isAlive: (pid: number) => boolean,
    private readonly idleExitMs: number,
    private readonly requestIdleExit: () => void,
    private readonly requestShutdown: () => void,
    private readonly log: DaemonLog,
    private readonly authTimeoutMs: number = AUTH_TIMEOUT_MS,
  ) {
    this.deviceId = store.deviceId();
    this.startedMs = now().getTime();
    this.idleSince = this.startedMs;
  }

  private iso = () => this.now().toISOString();

  /* ---- connection handling ---- */

  attach(socket: Socket): void {
    const conn: Conn = { socket, authed: false, queue: Promise.resolve() };
    this.conns.add(conn);
    const authTimer = setTimeout(() => {
      if (!conn.authed) socket.destroy();
    }, this.authTimeoutMs);
    authTimer.unref();
    const decoder = createLineDecoder();
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(chunk)) {
        conn.queue = conn.queue.then(() => this.onFrame(conn, frame));
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      this.conns.delete(conn);
    });
    socket.on("error", () => socket.destroy());
  }

  private send(conn: Conn, obj: unknown, flushed?: () => void): void {
    if (conn.socket.destroyed) {
      flushed?.();
      return;
    }
    try {
      conn.socket.write(encodeFrame(obj), flushed);
    } catch {
      // The frame could not be encoded (too large). Answer the same request with an error so
      // the caller is not left waiting; notifications have no id and are dropped.
      const id = (obj as { id?: unknown } | null)?.id;
      if (typeof id === "string" || typeof id === "number") {
        conn.socket.write(
          encodeFrame(
            makeError(id, RpcErrorCode.InternalError, "The response was too large to send."),
          ),
        );
      }
    }
  }

  private async onFrame(
    conn: Conn,
    frame: ReturnType<ReturnType<typeof createLineDecoder>["push"]>[number],
  ): Promise<void> {
    if (!frame.ok) {
      if (frame.error.code === "invalid_json") {
        this.send(
          conn,
          makeError(null, RpcErrorCode.ParseError, "Parse error: line is not valid JSON."),
        );
      } else {
        this.send(
          conn,
          makeError(
            null,
            RpcErrorCode.InvalidRequest,
            "Line is longer than 1 MiB. Send smaller requests.",
          ),
        );
      }
      return;
    }
    const parsed = parseIpcRequest(frame.value);
    if (!parsed.ok) {
      const method = (frame.value as { method?: unknown } | null)?.method;
      const needsAuth = !conn.authed && method !== "hello" && method !== "auth";
      const code = parsed.error.code;
      if (
        needsAuth &&
        (code === RpcErrorCode.MethodNotFound || code === RpcErrorCode.InvalidParams)
      ) {
        this.send(conn, makeError(parsed.id, RpcErrorCode.Unauthorized, unauthorizedMessage));
      } else {
        this.send(conn, makeError(parsed.id, code, parsed.error.message, parsed.error.data));
      }
      return;
    }
    const req = parsed.request;
    if (!conn.authed && req.method !== "hello" && req.method !== "auth") {
      this.send(conn, makeError(req.id, RpcErrorCode.Unauthorized, unauthorizedMessage));
      return;
    }
    try {
      const result = await this.dispatch(conn, req);
      // The shutdown reply must reach the client before the connection is torn down.
      const flushed = req.method === "daemon.shutdown" ? this.requestShutdown : undefined;
      this.send(conn, makeResult(req.id, result), flushed);
    } catch (e) {
      this.sendError(conn, req.id, req.method, e);
      if (req.method === "hello" || req.method === "auth") conn.socket.end();
    }
  }

  private sendError(conn: Conn, id: RpcId, method: string, e: unknown): void {
    if (e instanceof ConvenoError) {
      this.send(conn, makeError(id, e.code, e.message));
    } else {
      this.log.error(`internal error in ${method}`, e);
      this.send(
        conn,
        makeError(
          id,
          RpcErrorCode.InternalError,
          `The Conveno daemon hit an internal error. Check the daemon log at ${this.log.path}, then run "conveno daemon stop" and try again.`,
        ),
      );
    }
  }

  /* ---- dispatch ---- */

  private dispatch(conn: Conn, req: ParsedIpcRequest): unknown | Promise<unknown> {
    switch (req.method) {
      case "hello":
        return this.hello(conn, req.params);
      case "auth":
        return this.auth(conn, req.params);
      case "session.register":
        return this.registerAsync(req.params);
      case "session.heartbeat":
        return this.heartbeat(req.params.sessionId);
      case "session.unregister":
        return this.unregister(req.params.sessionId);
      case "session.rename":
        return this.rename(req.params);
      case "session.setStatus":
        return this.setStatus(req.params);
      case "session.list":
        return this.list(req.params);
      case "session.byHost":
        return this.byHost(req.params.pid);
      case "daemon.shutdown":
        return { ok: true as const };
      case "orchestrator.claim":
        return this.claim(req.params.sessionId);
      case "message.send":
        return this.sendMessage(req.params);
      case "message.inbox":
        return this.inbox(req.params);
      case "message.deliver":
        return this.deliver(req.params);
      case "message.ack":
        return this.ack(req.params);
      case "events.subscribe":
        return this.subscribe(conn, req.params);
      default:
        throw new ConvenoError(
          RpcErrorCode.MethodNotFound,
          `Method not found: ${req.method}. This version of the Conveno daemon does not support it. Run "conveno daemon status" to see which version is running.`,
        );
    }
  }

  private hello(conn: Conn, p: IpcParams<"hello">) {
    if (conn.challenge !== undefined) {
      throw new ConvenoError(
        RpcErrorCode.Conflict,
        "The handshake already started on this connection.",
      );
    }
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      throw new ConvenoError(
        RpcErrorCode.VersionMismatch,
        `Protocol version "${p.protocolVersion}" is not supported. This daemon speaks "${PROTOCOL_VERSION}". Update the client or the daemon so the versions match.`,
      );
    }
    conn.challenge = newAuthNonce();
    return {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: DAEMON_VERSION,
      proof: daemonProof(this.token, p.nonce),
      challenge: conn.challenge,
    };
  }

  private auth(conn: Conn, p: IpcParams<"auth">) {
    if (conn.challenge === undefined) {
      throw new ConvenoError(RpcErrorCode.Unauthorized, unauthorizedMessage);
    }
    if (!proofsMatch(p.proof, clientProof(this.token, conn.challenge))) {
      throw new ConvenoError(
        RpcErrorCode.Unauthorized,
        "The auth proof is wrong. The client must use the token in daemon.token in the Conveno data directory.",
      );
    }
    conn.authed = true;
    return { ok: true as const };
  }

  /* ---- helpers ---- */

  private named(rows: SessionRow[]): NamedSession[] {
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status }));
  }

  private requireSession(id: string): SessionRow {
    const row = this.store.getSession(id);
    if (!row) {
      throw new ConvenoError(
        RpcErrorCode.NotFound,
        `No session with id ${id}. Register the session again.`,
      );
    }
    return row;
  }

  private view(row: SessionRow): Session {
    const holder = effectiveHolder(this.store.holder(), this.named([row]));
    return toSession(row, holder?.id === row.id);
  }

  /* ---- events ---- */

  private emit(payload: EventPayload, onlyTo?: SessionId): void {
    for (const c of this.conns) {
      const sub = c.sub;
      if (!sub?.topics.has(payload.event)) continue;
      if (onlyTo !== undefined && sub.sessionId !== onlyTo) continue;
      this.send(c, makeEventNotification(payload));
    }
  }

  private emitSession(id: string, change: "registered" | "updated" | "unregistered" | "offline") {
    const row = this.store.getSession(id);
    if (row) this.emit({ event: "session.updated", data: { session: this.view(row), change } });
  }

  private emitMessage(m: Message, recipient: SessionId): void {
    this.emit({ event: "message.received", data: { message: m } }, recipient);
  }

  /* ---- sessions ---- */

  private async detect(p: IpcParams<"session.register">) {
    if (p.repo) return p.repo;
    const found = await detectRepo(p.cwd, { exists: (path) => existsSync(path) });
    return found.root ? { root: found.root } : undefined;
  }

  register(p: IpcParams<"session.register">, repo?: { root: string; remoteUrlHash?: string }) {
    const id = newSessionId();
    const at = this.iso();
    const row = this.store.tx(() => {
      const named = this.named(this.store.allSessions());
      const base = baseName(repo?.root ?? p.cwd);
      const name =
        p.name !== undefined
          ? validateRename(id, p.name, named)
          : generateSessionName(p.cli, base, named);
      const parent = p.spawnedBy ? this.store.getSession(p.spawnedBy) : undefined;
      const r: SessionRow = {
        id,
        name,
        cli: p.cli,
        deviceId: this.deviceId,
        cwd: p.cwd,
        status: "idle",
        deliveryTier: CLI_TIER[p.cli] ?? "inbox",
        spawnDepth: parent ? parent.spawnDepth + 1 : 0,
        startedAt: at,
        lastSeenAt: at,
      };
      if (p.cliVersion !== undefined) r.cliVersion = p.cliVersion;
      if (repo) {
        r.repoRoot = repo.root;
        if (repo.remoteUrlHash !== undefined) r.repoRemoteUrlHash = repo.remoteUrlHash;
      }
      if (p.pid !== undefined) r.pid = p.pid;
      if (p.hostPid !== undefined) r.hostPid = p.hostPid;
      if (p.hostPids !== undefined) r.hostPids = p.hostPids;
      if (p.spawnedBy !== undefined) r.spawnedBy = p.spawnedBy;
      this.store.insertSession(r);
      return r;
    });
    this.emitSession(row.id, "registered");
    return { session: this.view(row) };
  }

  async registerAsync(p: IpcParams<"session.register">) {
    return this.register(p, await this.detect(p));
  }

  private heartbeat(sessionId: SessionId) {
    const row = this.requireSession(sessionId);
    const at = this.iso();
    if (row.status !== "offline") {
      this.store.updateSession(sessionId, { lastSeenAt: at });
      return { lastSeenAt: at };
    }
    // An offline session that heartbeats again comes back, unless its host died or its name was taken.
    const named = this.named(this.store.allSessions());
    const taken = named.some((s) => s.id !== sessionId && isOnline(s) && s.name === row.name);
    if ((row.hostPid !== undefined && !this.isAlive(row.hostPid)) || taken) {
      throw new ConvenoError(
        RpcErrorCode.NotFound,
        `Session "${row.name}" is offline and cannot come back. Register the session again.`,
      );
    }
    this.store.updateSession(sessionId, { status: "idle", lastSeenAt: at });
    this.emitSession(sessionId, "updated");
    return { lastSeenAt: at };
  }

  private depart(sessionId: SessionId, change: "unregistered" | "offline"): void {
    const before = this.store.holder();
    const after = holderAfterDeparture(before, sessionId);
    this.store.tx(() => {
      this.store.updateSession(sessionId, { status: "offline" });
      if (after !== before) this.store.setHolder(after);
    });
    this.emitSession(sessionId, change);
    if (after !== before) {
      this.emit({
        event: "orchestrator.changed",
        data: { orchestrator: after, previous: before },
      });
    }
  }

  private unregister(sessionId: SessionId) {
    const row = this.requireSession(sessionId);
    if (row.status !== "offline") this.depart(sessionId, "unregistered");
    return { ok: true as const };
  }

  private rename(p: IpcParams<"session.rename">) {
    const row = this.requireSession(p.sessionId);
    const name = validateRename(p.sessionId, p.name, this.named(this.store.allSessions()));
    if (name !== row.name) {
      this.store.updateSession(p.sessionId, { name });
      this.emitSession(p.sessionId, "updated");
    }
    return { session: this.view(this.requireSession(p.sessionId)) };
  }

  private setStatus(p: IpcParams<"session.setStatus">) {
    const row = this.requireSession(p.sessionId);
    if (row.status === "offline") {
      throw new ConvenoError(
        RpcErrorCode.NotFound,
        `Session "${row.name}" is offline. Register the session again.`,
      );
    }
    if (p.status === "offline") {
      throw new ConvenoError(
        RpcErrorCode.InvalidParams,
        'Status "offline" is set by the daemon. Use idle, busy or waiting_on_question, or unregister the session.',
      );
    }
    const fields: { status?: typeof row.status; statusText?: string | null } = {};
    if (p.status !== undefined) fields.status = p.status;
    if (p.statusText !== undefined) {
      // One line of plain text: control characters and newlines would break the listing.
      const clean = p.statusText === null ? "" : sanitizeLine(p.statusText);
      fields.statusText = clean === "" ? null : clean;
    }
    this.store.updateSession(p.sessionId, fields);
    this.emitSession(p.sessionId, "updated");
    return { session: this.view(this.requireSession(p.sessionId)) };
  }

  private list(p: IpcParams<"session.list">) {
    const rows = this.store.allSessions().filter((r) => {
      if (!p.includeOffline && r.status === "offline") return false;
      if (p.cli && r.cli !== p.cli) return false;
      if (p.repo && r.repoRoot !== p.repo && baseName(r.repoRoot ?? r.cwd) !== p.repo) return false;
      return true;
    });
    return { sessions: rows.map((r) => this.view(r)) };
  }

  /**
   * Find the session a hook belongs to: the one online session whose `hostPid` equals `pid`.
   * Exact equality only, with no walk to farther ancestors, so a hook from a CLI that has no
   * session matches nothing. Two sessions under one CLI process are ambiguous, so the result is
   * null; the daemon never guesses.
   */
  private byHost(pid: number) {
    const holders = this.store
      .allSessions()
      .filter((r) => r.status !== "offline" && r.hostPid === pid);
    const only = holders.length === 1 ? holders[0] : undefined;
    return { session: only ? this.view(only) : null };
  }

  /* ---- orchestrator ---- */

  private claim(sessionId: SessionId) {
    this.requireSession(sessionId);
    const rows = this.store.allSessions();
    const holder = this.store.holder();
    const res = claimOrchestrator(holder, sessionId, this.named(rows));
    const at = this.iso();
    const sent: Message[] = [];
    this.store.tx(() => {
      this.store.setHolder(res.orchestrator);
      for (const n of res.notices) {
        const m: Message = {
          id: newMessageId(),
          from: DAEMON_SENDER_ID,
          to: n.to,
          kind: "system",
          body: { event: n.event, detail: n.detail },
          urgent: false,
          createdAt: at,
        };
        this.store.insertMessage(m, n.to, at);
        sent.push(m);
      }
    });
    if (res.notices.length > 0) {
      this.emit({
        event: "orchestrator.changed",
        data: { orchestrator: res.orchestrator, previous: res.previous },
      });
      this.emitSession(sessionId, "updated");
      if (res.previous) this.emitSession(res.previous, "updated");
      for (const m of sent) this.emitMessage(m, m.to as SessionId);
    }
    return { orchestrator: res.orchestrator, previous: res.previous };
  }

  /* ---- messages ---- */

  private sendMessage(p: IpcParams<"message.send">) {
    const sender = this.requireSession(p.sessionId);
    if (sender.status === "offline") {
      throw new ConvenoError(
        RpcErrorCode.NotFound,
        `Session "${sender.name}" is offline. Register the session again before sending.`,
      );
    }
    if (p.kind === "system") {
      throw new ConvenoError(
        RpcErrorCode.InvalidParams,
        'Messages of kind "system" are made by the Conveno daemon only. Send kind "text" instead.',
      );
    }
    if (p.replyTo !== undefined && !this.store.hasMessage(p.replyTo)) {
      throw new ConvenoError(
        RpcErrorCode.NotFound,
        `Message ${p.replyTo} does not exist, so it cannot be replied to. Check the message id.`,
      );
    }
    const rows = this.store.allSessions();
    const target = resolveRecipient(p.to, this.named(rows), this.store.holder());
    const targetRow = rows.find((r) => r.id === target.id) as SessionRow;
    if (this.store.unreadCount(targetRow.id) >= MAX_UNREAD_PER_SESSION) {
      throw new ConvenoError(
        RpcErrorCode.LimitExceeded,
        tooManyUnreadMessage(targetRow.name, MAX_UNREAD_PER_SESSION),
      );
    }
    const at = this.iso();
    const message = {
      id: newMessageId(),
      from: sender.id,
      to: p.to,
      kind: p.kind,
      body: p.body,
      urgent: p.urgent,
      createdAt: at,
      fromName: sender.name,
      fromCli: sender.cli,
      ...(p.replyTo !== undefined ? { replyTo: p.replyTo } : {}),
    } as Message;
    this.store.insertMessage(message, targetRow.id, at);
    this.emitMessage(message, targetRow.id);
    return {
      message,
      delivery: targetRow.deliveryTier,
      deliveredTo: { id: targetRow.id, name: targetRow.name },
    };
  }

  private inbox(p: IpcParams<"message.inbox">) {
    this.requireSession(p.sessionId);
    const at = this.iso();
    return this.store.tx(() => {
      const entries = this.store.entries(p.sessionId, p.unreadOnly ? { states: ["queued"] } : {});
      const res = readInbox(
        entries,
        { unreadOnly: p.unreadOnly, limit: p.limit, maxBytes: RESPONSE_BUDGET_BYTES },
        at,
      );
      const changed = new Set(res.returned.map((e) => e.message.id));
      for (const e of res.entries)
        if (changed.has(e.message.id)) this.store.saveEntry(p.sessionId, e);
      // With unreadOnly only unread entries were loaded, so unreadCount is complete either way.
      return { messages: res.returned.map((e) => e.message), unreadCount: res.unreadCount };
    });
  }

  private deliver(p: IpcParams<"message.deliver">) {
    this.requireSession(p.sessionId);
    const at = this.iso();
    return this.store.tx(() => {
      const pending = pendingForInjection(this.store.entries(p.sessionId, { states: ["queued"] }));
      const taken = takeWithinBytes(pending.slice(0, p.limit), RESPONSE_BUDGET_BYTES);
      const updated = markDelivered(
        taken,
        taken.map((e) => e.message.id),
        at,
      );
      for (const e of updated) this.store.saveEntry(p.sessionId, e);
      return { messages: updated.map((e) => e.message), remaining: pending.length - taken.length };
    });
  }

  private ack(p: IpcParams<"message.ack">) {
    this.requireSession(p.sessionId);
    const at = this.iso();
    return this.store.tx(() => {
      const entries: MailboxEntry[] = this.store.entries(p.sessionId, { ids: p.ids });
      const res = ackEntries(entries, p.ids, at);
      for (const e of res.entries) this.store.saveEntry(p.sessionId, e);
      return { acked: res.acked };
    });
  }

  /* ---- events ---- */

  private subscribe(conn: Conn, p: IpcParams<"events.subscribe">) {
    this.requireSession(p.sessionId);
    const topics = p.topics ?? [...EVENT_NAMES];
    conn.sub = { sessionId: p.sessionId, topics: new Set(topics) };
    return { subscribed: topics };
  }

  /* ---- liveness and idle ---- */

  /**
   * Prune rules for an offline session, in order:
   * 1. With unread messages waiting, keep it for PRUNE_UNREAD_AFTER_MS, then delete it and its mail.
   * 2. Replaced by a newer live session with the same name, CLI and repo: delete after
   *    PRUNE_SUPERSEDED_AFTER_MS.
   * 3. Otherwise delete after PRUNE_OFFLINE_AFTER_MS.
   */
  private shouldPrune(row: SessionRow, all: SessionRow[], nowMs: number): boolean {
    const offlineMs = nowMs - Date.parse(row.lastSeenAt);
    if (this.store.unreadCount(row.id) > 0) return offlineMs >= PRUNE_UNREAD_AFTER_MS;
    const place = (r: SessionRow) => r.repoRoot ?? r.cwd;
    const superseded = all.some(
      (o) =>
        o.id !== row.id &&
        o.status !== "offline" &&
        o.name === row.name &&
        o.cli === row.cli &&
        place(o) === place(row) &&
        Date.parse(o.startedAt) > Date.parse(row.startedAt),
    );
    return offlineMs >= (superseded ? PRUNE_SUPERSEDED_AFTER_MS : PRUNE_OFFLINE_AFTER_MS);
  }

  sweep(): void {
    const nowMs = this.now().getTime();
    let online = 0;
    const rows = this.store.allSessions();
    for (const row of rows) {
      if (row.status === "offline") {
        if (this.shouldPrune(row, rows, nowMs)) {
          this.store.tx(() => this.store.deleteSession(row.id));
        }
        continue;
      }
      // Sessions that outlived a daemon restart get one full window to heartbeat again.
      const lastSeenMs = Math.max(Date.parse(row.lastSeenAt), this.startedMs);
      const verdict = evaluateLiveness({ lastSeenMs, hostPid: row.hostPid }, nowMs, this.isAlive);
      if (statusAfterLiveness(row.status, verdict) === "offline") this.depart(row.id, "offline");
      else online++;
    }
    if (online > 0) {
      this.idleSince = nowMs;
    } else if (nowMs - this.idleSince >= this.idleExitMs) {
      this.requestIdleExit();
    }
  }
}

const unauthorizedMessage =
  "Finish the handshake first: call hello, then auth. Both use the token in daemon.token in the Conveno data directory.";

/** Start convenod: take the lock, open the database, listen on the socket. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const platform = process.platform;
  const paths = dataPaths(platform, opts.dataDir);
  const socketPath = opts.socketPath ?? defaultSocketPath(platform, process.env, homedir());
  if (isSocketPathTooLong(socketPath, platform)) {
    throw new Error(socketPathTooLongMessage(socketPath, platform));
  }
  const now = opts.now ?? (() => new Date());
  const isAlive = opts.isAlive ?? defaultIsAlive;

  ensureDir(opts.dataDir);
  const releaseLock = await acquireLock(paths.lock, socketPath);
  let store: Store | undefined;
  let server: Server | undefined;
  try {
    const token = loadOrCreateToken(paths.token);
    store = new Store(paths.database);
    if (platform !== "win32" && !socketPath.startsWith("\\\\")) ensureDir(dirname(socketPath));
    await clearStaleSocket(socketPath);

    let closing: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined;
    const daemon = new Daemon(
      store,
      token,
      now,
      isAlive,
      opts.idleExitMs ?? DEFAULT_IDLE_EXIT_MS,
      () => {
        void close().then(() => opts.onIdleExit?.());
      },
      () => {
        void close().then(() => opts.onShutdown?.());
      },
      createDaemonLog(paths.daemonLog, { now }),
      opts.authTimeoutMs ?? AUTH_TIMEOUT_MS,
    );

    const srv = createServer((socket) => daemon.attach(socket));
    server = srv;
    await new Promise<void>((resolve, reject) => {
      srv.once("error", (e: NodeJS.ErrnoException) =>
        reject(e.code === "EADDRINUSE" ? new DaemonAlreadyRunningError(`socket ${socketPath}`) : e),
      );
      srv.listen(socketPath, () => resolve());
    });
    if (platform !== "win32" && !socketPath.startsWith("\\\\")) chmodSync(socketPath, 0o600);

    timer = setInterval(() => daemon.sweep(), opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    timer.unref();

    const liveStore = store;
    function close(): Promise<void> {
      closing ??= (async () => {
        if (timer) clearInterval(timer);
        // Stop accepting first, then drop the open connections, then let go of the files.
        const stopped = new Promise<void>((resolve) => srv.close(() => resolve()));
        for (const c of daemon.conns) c.socket.destroy();
        await stopped;
        liveStore.close();
        if (platform !== "win32" && !socketPath.startsWith("\\\\"))
          rmSync(socketPath, { force: true });
        releaseLock();
      })();
      return closing;
    }

    return { socketPath, close, sweep: () => daemon.sweep() };
  } catch (e) {
    server?.close();
    store?.close();
    releaseLock();
    throw e;
  }
}
