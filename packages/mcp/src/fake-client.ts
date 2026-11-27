import type { ConvenoClient } from "@conveno/core";
import {
  ackEntries,
  ConvenoError,
  claimOrchestrator,
  createEntry,
  generateSessionName,
  type MailboxEntry,
  readInbox,
  resolveRecipient,
  validateRename,
} from "@conveno/core";
import {
  type DeviceId,
  type Message,
  newDeviceId,
  newMessageId,
  newSessionId,
  RpcErrorCode,
  type Session,
  type SessionId,
} from "@conveno/protocol";

/** In-memory ConvenoClient for tests: daemon behaviour built from core's rules. One instance can serve several sessions. */
export class FakeDaemon {
  readonly sessions = new Map<SessionId, Session>();
  readonly mailboxes = new Map<SessionId, MailboxEntry[]>();
  readonly calls: { method: string; params: unknown }[] = [];
  holder: SessionId | null = null;
  readonly deviceId: DeviceId = newDeviceId();
  now = (): string => new Date().toISOString();

  private all = (): Session[] => [...this.sessions.values()];
  private need(id: SessionId): Session {
    const s = this.sessions.get(id);
    if (!s) throw new ConvenoError(RpcErrorCode.NotFound, "This session is not registered.");
    return s;
  }
  private withOrch(s: Session): Session {
    return { ...s, isOrchestrator: this.holder === s.id };
  }

  client(): ConvenoClient {
    const rec =
      <P, R>(method: string, fn: (p: P) => R) =>
      async (params: P): Promise<R> => {
        this.calls.push({ method, params });
        return fn(params);
      };
    const notImpl = async () => {
      throw new Error("not implemented in FakeDaemon");
    };
    return {
      "session.register": rec(
        "session.register",
        (p: Parameters<ConvenoClient["session.register"]>[0]) => {
          const at = this.now();
          const session: Session = {
            id: newSessionId(),
            name:
              p.name ??
              generateSessionName(
                p.cli,
                p.repo?.root.split(/[\\/]/).pop() ?? "workspace",
                this.all(),
              ),
            cli: p.cli,
            ...(p.cliVersion ? { cliVersion: p.cliVersion } : {}),
            deviceId: this.deviceId,
            cwd: p.cwd,
            ...(p.repo ? { repo: p.repo } : {}),
            ...(p.pid ? { pid: p.pid } : {}),
            ...(p.hostPids ? { hostPids: p.hostPids } : {}),
            status: "idle",
            isOrchestrator: false,
            deliveryTier: "inbox",
            spawnDepth: 0,
            startedAt: at,
            lastSeenAt: at,
          };
          this.sessions.set(session.id, session);
          this.mailboxes.set(session.id, []);
          return { session };
        },
      ),
      "session.heartbeat": rec("session.heartbeat", (p: { sessionId: SessionId }) => {
        const s = this.need(p.sessionId);
        const lastSeenAt = this.now();
        this.sessions.set(s.id, { ...s, lastSeenAt });
        return { lastSeenAt };
      }),
      "session.unregister": rec("session.unregister", (p: { sessionId: SessionId }) => {
        const s = this.need(p.sessionId);
        this.sessions.set(s.id, { ...s, status: "offline" });
        if (this.holder === s.id) this.holder = null;
        return { ok: true as const };
      }),
      "session.rename": rec("session.rename", (p: { sessionId: SessionId; name: string }) => {
        const s = this.need(p.sessionId);
        const name = validateRename(s.id, p.name, this.all());
        const next = { ...s, name };
        this.sessions.set(s.id, next);
        return { session: this.withOrch(next) };
      }),
      "session.setStatus": rec(
        "session.setStatus",
        (p: { sessionId: SessionId; statusText?: string | null | undefined }) => {
          const { statusText: _old, ...rest } = this.need(p.sessionId);
          const next: Session = { ...rest, ...(p.statusText ? { statusText: p.statusText } : {}) };
          this.sessions.set(next.id, next);
          return { session: this.withOrch(next) };
        },
      ),
      "session.byHost": rec("session.byHost", (p: { pids: number[] }) => {
        const online = this.all().filter((s) => s.status !== "offline");
        for (const pid of p.pids) {
          const holders = online.filter((s) => s.hostPids?.includes(pid));
          if (holders.length > 0)
            return { session: holders.length === 1 ? (holders[0] ?? null) : null };
        }
        return { session: null };
      }),
      "daemon.shutdown": rec("daemon.shutdown", () => ({ ok: true as const })),
      "session.list": rec(
        "session.list",
        (p: {
          repo?: string | undefined;
          cli?: string | undefined;
          includeOffline?: boolean | undefined;
        }) => ({
          sessions: this.all()
            .filter((s) => p.includeOffline || s.status !== "offline")
            .filter((s) => !p.cli || s.cli === p.cli)
            .filter((s) => !p.repo || s.repo?.root.endsWith(p.repo))
            .map((s) => this.withOrch(s)),
        }),
      ),
      "orchestrator.claim": rec("orchestrator.claim", (p: { sessionId: SessionId }) => {
        const r = claimOrchestrator(this.holder, p.sessionId, this.all());
        this.holder = r.orchestrator;
        return { orchestrator: r.orchestrator, previous: r.previous };
      }),
      "message.send": rec("message.send", (p: Parameters<ConvenoClient["message.send"]>[0]) => {
        const from = this.need(p.sessionId as SessionId);
        const target = resolveRecipient(p.to, this.all(), this.holder);
        const message = {
          kind: p.kind,
          body: p.body,
          id: newMessageId(),
          from: from.id,
          to: p.to,
          urgent: p.urgent ?? false,
          createdAt: this.now(),
          fromName: from.name,
          fromCli: from.cli,
          ...(p.replyTo ? { replyTo: p.replyTo } : {}),
        } as Message;
        this.mailboxes.get(target.id)?.push(createEntry(message, this.now()));
        return {
          message,
          delivery: "inbox" as const,
          deliveredTo: { id: target.id, name: target.name as Session["name"] },
        };
      }),
      "message.inbox": rec(
        "message.inbox",
        (p: {
          sessionId: SessionId;
          unreadOnly?: boolean | undefined;
          limit?: number | undefined;
        }) => {
          const entries = this.mailboxes.get(p.sessionId) ?? [];
          const r = readInbox(
            entries,
            { unreadOnly: p.unreadOnly ?? true, limit: p.limit ?? 50 },
            this.now(),
          );
          this.mailboxes.set(p.sessionId, r.entries);
          return { messages: r.returned.map((e) => e.message), unreadCount: r.unreadCount };
        },
      ),
      "message.deliver": notImpl,
      "message.ack": rec("message.ack", (p: { sessionId: SessionId; ids: Message["id"][] }) => {
        const r = ackEntries(this.mailboxes.get(p.sessionId) ?? [], p.ids, this.now());
        this.mailboxes.set(p.sessionId, r.entries);
        return { acked: r.acked };
      }),
      "events.subscribe": notImpl,
      onEvent: () => () => undefined,
      close: async () => undefined,
    } as unknown as ConvenoClient;
  }
}
