import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { MailboxEntry, MailboxState } from "@0xpixelninja/conveno-core";
import {
  type CliKind,
  type DeliveryTier,
  type DeviceId,
  DeviceId as DeviceIdSchema,
  Message,
  type MessageId,
  newDeviceId,
  type Session,
  type SessionId,
  type SessionStatus,
} from "@0xpixelninja/conveno-protocol";

/** One row of the `sessions` table, in the shape the daemon works with. */
export interface SessionRow {
  id: SessionId;
  name: string;
  cli: CliKind;
  cliVersion?: string;
  deviceId: DeviceId;
  cwd: string;
  repoRoot?: string;
  repoRemoteUrlHash?: string;
  pid?: number;
  hostPid?: number;
  status: SessionStatus;
  statusText?: string;
  deliveryTier: DeliveryTier;
  spawnedBy?: SessionId;
  spawnDepth: number;
  startedAt: string;
  lastSeenAt: string;
}

const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cli TEXT NOT NULL,
        cli_version TEXT,
        device_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        repo_remote_hash TEXT,
        pid INTEGER,
        host_pid INTEGER,
        status TEXT NOT NULL,
        status_text TEXT,
        delivery_tier TEXT NOT NULL,
        spawned_by TEXT,
        spawn_depth INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX sessions_host_pid ON sessions (host_pid);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE mailbox (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT,
        acked_at TEXT,
        PRIMARY KEY (session_id, message_id)
      );
      CREATE INDEX mailbox_state ON mailbox (session_id, state);
      CREATE TABLE orchestrator (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        session_id TEXT
      );
      INSERT INTO orchestrator (slot, session_id) VALUES (1, NULL);
    `,
  },
];

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

function toSessionRow(r: Row): SessionRow {
  const row: SessionRow = {
    id: r.id as SessionId,
    name: r.name as string,
    cli: r.cli as CliKind,
    deviceId: r.device_id as DeviceId,
    cwd: r.cwd as string,
    status: r.status as SessionStatus,
    deliveryTier: r.delivery_tier as DeliveryTier,
    spawnDepth: r.spawn_depth as number,
    startedAt: r.started_at as string,
    lastSeenAt: r.last_seen_at as string,
  };
  const cliVersion = str(r.cli_version);
  if (cliVersion !== undefined) row.cliVersion = cliVersion;
  const repoRoot = str(r.repo_root);
  if (repoRoot !== undefined) row.repoRoot = repoRoot;
  const hash = str(r.repo_remote_hash);
  if (hash !== undefined) row.repoRemoteUrlHash = hash;
  const pid = num(r.pid);
  if (pid !== undefined) row.pid = pid;
  const hostPid = num(r.host_pid);
  if (hostPid !== undefined) row.hostPid = hostPid;
  const statusText = str(r.status_text);
  if (statusText !== undefined) row.statusText = statusText;
  const spawnedBy = str(r.spawned_by);
  if (spawnedBy !== undefined) row.spawnedBy = spawnedBy as SessionId;
  return row;
}

/** Wire-format session for a stored row. */
export function toSession(row: SessionRow, isOrchestrator: boolean): Session {
  const s: Session = {
    id: row.id,
    name: row.name,
    cli: row.cli,
    deviceId: row.deviceId,
    cwd: row.cwd,
    status: row.status,
    isOrchestrator,
    deliveryTier: row.deliveryTier,
    spawnDepth: row.spawnDepth,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
  };
  if (row.cliVersion !== undefined) s.cliVersion = row.cliVersion;
  if (row.repoRoot !== undefined) {
    s.repo =
      row.repoRemoteUrlHash !== undefined
        ? { root: row.repoRoot, remoteUrlHash: row.repoRemoteUrlHash }
        : { root: row.repoRoot };
  }
  if (row.pid !== undefined) s.pid = row.pid;
  if (row.hostPid !== undefined) s.hostPid = row.hostPid;
  if (row.statusText !== undefined) s.statusText = row.statusText;
  if (row.spawnedBy !== undefined) s.spawnedBy = row.spawnedBy;
  return s;
}

function toEntry(r: Row): MailboxEntry {
  const message = Message.parse(JSON.parse(r.json as string));
  const entry: MailboxEntry = {
    message,
    state: r.state as MailboxState,
    queuedAt: r.queued_at as string,
  };
  const d = str(r.delivered_at);
  const rd = str(r.read_at);
  const a = str(r.acked_at);
  if (d) entry.deliveredAt = d;
  if (rd) entry.readAt = rd;
  if (a) entry.ackedAt = a;
  return entry;
}

/** SQLite persistence. All methods are synchronous; callers group writes with `tx`. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  private migrate(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    const done = new Set(this.all("SELECT name FROM migrations").map((r) => r.name as string));
    for (const m of MIGRATIONS) {
      if (done.has(m.name)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.run(
          "INSERT INTO migrations (name, applied_at) VALUES (?, ?)",
          m.name,
          new Date().toISOString(),
        );
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  migrationNames(): string[] {
    return this.all("SELECT name FROM migrations ORDER BY name").map((r) => r.name as string);
  }

  /** The device id of this machine, generated on first start. */
  deviceId(): DeviceId {
    const r = this.all("SELECT value FROM meta WHERE key = 'device_id'")[0];
    if (r) return DeviceIdSchema.parse(r.value);
    const id = newDeviceId();
    this.run("INSERT INTO meta (key, value) VALUES ('device_id', ?)", id);
    return id;
  }

  /* ---- sessions ---- */

  insertSession(s: SessionRow): void {
    this.run(
      `INSERT INTO sessions (id, name, cli, cli_version, device_id, cwd, repo_root, repo_remote_hash,
        pid, host_pid, status, status_text, delivery_tier, spawned_by, spawn_depth, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id,
      s.name,
      s.cli,
      s.cliVersion ?? null,
      s.deviceId,
      s.cwd,
      s.repoRoot ?? null,
      s.repoRemoteUrlHash ?? null,
      s.pid ?? null,
      s.hostPid ?? null,
      s.status,
      s.statusText ?? null,
      s.deliveryTier,
      s.spawnedBy ?? null,
      s.spawnDepth,
      s.startedAt,
      s.lastSeenAt,
    );
  }

  getSession(id: string): SessionRow | undefined {
    const r = this.all("SELECT * FROM sessions WHERE id = ?", id)[0];
    return r ? toSessionRow(r) : undefined;
  }

  /** Every session, oldest first (ids are monotonic ULIDs). */
  allSessions(): SessionRow[] {
    return this.all("SELECT * FROM sessions ORDER BY started_at, id").map(toSessionRow);
  }

  updateSession(
    id: string,
    fields: {
      name?: string;
      status?: SessionStatus;
      statusText?: string | null;
      lastSeenAt?: string;
    },
  ): void {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      vals.push(fields.name);
    }
    if (fields.status !== undefined) {
      sets.push("status = ?");
      vals.push(fields.status);
    }
    if (fields.statusText !== undefined) {
      sets.push("status_text = ?");
      vals.push(fields.statusText);
    }
    if (fields.lastSeenAt !== undefined) {
      sets.push("last_seen_at = ?");
      vals.push(fields.lastSeenAt);
    }
    if (sets.length === 0) return;
    this.run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
  }

  /* ---- orchestrator ---- */

  holder(): SessionId | null {
    const r = this.all("SELECT session_id FROM orchestrator WHERE slot = 1")[0];
    return (str(r?.session_id) as SessionId | undefined) ?? null;
  }

  setHolder(id: SessionId | null): void {
    this.run("UPDATE orchestrator SET session_id = ? WHERE slot = 1", id);
  }

  /* ---- messages and mailbox ---- */

  insertMessage(message: Message, recipient: SessionId, at: string): void {
    this.run("INSERT INTO messages (id, json) VALUES (?, ?)", message.id, JSON.stringify(message));
    this.run(
      "INSERT INTO mailbox (session_id, message_id, state, queued_at) VALUES (?, ?, 'queued', ?)",
      recipient,
      message.id,
      at,
    );
  }

  /** Messages queued for a session that no one has been shown yet. */
  unreadCount(sessionId: SessionId): number {
    const r = this.all(
      "SELECT COUNT(*) AS n FROM mailbox WHERE session_id = ? AND state = 'queued'",
      sessionId,
    )[0];
    return (num(r?.n) ?? 0) as number;
  }

  hasMessage(id: string): boolean {
    return this.all("SELECT 1 AS x FROM messages WHERE id = ?", id).length > 0;
  }

  /** Remove a session, its mailbox, and any message no mailbox refers to any more. */
  deleteSession(id: string): void {
    this.run("DELETE FROM mailbox WHERE session_id = ?", id);
    this.run("DELETE FROM messages WHERE id NOT IN (SELECT message_id FROM mailbox)");
    this.run("DELETE FROM sessions WHERE id = ?", id);
  }

  /** Mailbox entries of one session, optionally limited to the given states or message ids. */
  entries(
    sessionId: SessionId,
    filter: { states?: MailboxState[]; ids?: readonly MessageId[] } = {},
  ): MailboxEntry[] {
    let sql = `SELECT m.json, b.state, b.queued_at, b.delivered_at, b.read_at, b.acked_at
       FROM mailbox b JOIN messages m ON m.id = b.message_id WHERE b.session_id = ?`;
    const params: SQLInputValue[] = [sessionId];
    if (filter.states) {
      sql += ` AND b.state IN (${filter.states.map(() => "?").join(",")})`;
      params.push(...filter.states);
    }
    if (filter.ids) {
      sql += ` AND b.message_id IN (${filter.ids.map(() => "?").join(",")})`;
      params.push(...filter.ids);
    }
    return this.all(sql, ...params).map(toEntry);
  }

  saveEntry(sessionId: SessionId, e: MailboxEntry): void {
    this.run(
      `UPDATE mailbox SET state = ?, delivered_at = ?, read_at = ?, acked_at = ?
       WHERE session_id = ? AND message_id = ?`,
      e.state,
      e.deliveredAt ?? null,
      e.readAt ?? null,
      e.ackedAt ?? null,
      sessionId,
      e.message.id,
    );
  }
}
