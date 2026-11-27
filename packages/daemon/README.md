# @conveno/daemon

`convenod`: the local daemon. It serves the Conveno IPC protocol (JSON-RPC 2.0 over NDJSON) on a
Unix socket or Windows named pipe, stores sessions and messages in SQLite, and tracks which sessions
are alive. All rules (naming, liveness, orchestrator, mailbox) come from `@conveno/core`.

## API

```ts
startDaemon(opts: {
  dataDir: string;
  socketPath?: string;                 // default: defaultSocketPath() from protocol
  idleExitMs?: number;                 // default 10 min; Infinity disables
  now?: () => Date;
  isAlive?: (pid: number) => boolean;  // default: process.kill(pid, 0), EPERM counts as alive
  sweepIntervalMs?: number;            // default 15 s
  onIdleExit?: () => void;
}): Promise<{ socketPath: string; close(): Promise<void>; sweep(): void }>
```

`sweep()` runs one liveness and idle check immediately; tests use it with a fake clock.
The `convenod` bin (`dist/bin.js`) reads the data directory from core's `dataDir()` and exits on
SIGINT or SIGTERM after closing cleanly.

## Behaviour

- Auth: a random 32-byte token is written to `<data>/daemon.token` on first start (mode 0600; on
  Windows the file inherits the per-user data directory ACL, no explicit ACL is set). The token never
  crosses the socket. The handshake is mutual: `hello` carries the client's nonce and returns an
  HMAC proof of it plus a challenge; the client answers with `auth` and an HMAC proof of the
  challenge. Every other method returns `-32001` until `auth` succeeds. A wrong proof gets `-32001`
  and the connection is closed, as does a connection that has not finished within 5 s. A protocol
  version other than `conveno/1` gets `-32005`.
- Storage: `<data>/conveno.db` through `node:sqlite`, WAL mode, schema tracked in a `migrations` table.
- Single instance: `<data>/daemon.lock` holds the pid and socket path of the owner. A lock is stale
  unless its pid is alive and the socket recorded in the lock answers (or the lock is under 5 s old). On POSIX a leftover socket file is removed only when nothing answers on it.
- Liveness: every 15 s sessions with no heartbeat for 45 s, or whose `hostPid` is gone, go `offline`.
  The orchestrator role is vacated, never passed on. After a daemon restart each session gets a full
  window to heartbeat again. A heartbeat from an offline session brings it back if its host process
  lives and its name is free; otherwise it must register again.
- Limits: a recipient may hold 1000 unread messages (`-32004` beyond that). One `message.inbox` or
  `message.deliver` response carries at most about 900 KB of messages; the rest stay unread for the
  next call. Offline sessions not seen for 7 days are deleted with their mailbox by the sweep.
- Status text is reduced to one line: control characters become spaces and whitespace collapses.
- Clients cannot send `system` messages, and `conveno`, `orchestrator`, `system` and `user` are
  reserved session names. Binding a session to the connection that registered it is deferred to M2.
- Idle exit: after `idleExitMs` with no online sessions.
- `session.unregister` marks the session offline (the row stays so old messages keep their sender).
- `session.list` `repo` matches the repo root path or its basename.
- `ticket.*`, `spawn.*` and `peek.*` return `-32601` until their milestones.

Known gap, deferred to M2: there is no socket backpressure. A client that stops reading can make the
daemon buffer its pending writes in memory.

No runtime dependencies beyond `protocol` and `core`.
