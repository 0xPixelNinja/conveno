# @conveno/daemon

`convenod`: the local daemon. It serves the Conveno IPC protocol (JSON-RPC 2.0 over NDJSON) on a
Unix socket or Windows named pipe, stores sessions and messages in SQLite, and tracks which sessions
are alive. All rules (naming, liveness, orchestrator, mailbox) come from `@conveno/core`.

This is a private workspace package. `@conveno/cli` bundles it and ships it as `dist/daemon.js`.

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
  pathExists?: (path: string) => boolean; // default: existsSync; for the missing-folder rule
}): Promise<{ socketPath: string; close(): Promise<void>; sweep(): void }>
```

`sweep()` runs one liveness and idle check immediately; tests use it with a fake clock.
The daemon entry (`src/bin.ts`, shipped as `dist/daemon.js` inside `@conveno/cli`) reads the data directory from core's `dataDir()` and exits on
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
- Shutdown: `daemon.shutdown` replies `{ ok: true }`, then stops listening, closes the store, removes the socket (POSIX) and the lock file, and exits 0. `conveno daemon stop` uses it.
- Log: unexpected errors, with their stacks, go to `<data>/logs/daemon.log` (mode 0600). At 1 MiB the file moves to `daemon.log.1`, replacing the older one. Request parameters are never logged. The reply to the client names this path.
- Start log: a client that starts the daemon sends its stdout and stderr to `<data>/logs/daemon-start.log`, truncated at each start. It catches what the daemon prints before its own log is open, such as a crash at startup, and a failed start shows its last lines.
- Hook lookup: `session.byHost` takes the hook's host pid and returns the one online session whose `hostPid` equals it. No walking to ancestors; none or two matches give `null`.
- Liveness: every 15 s sessions with no heartbeat for 45 s, or whose `hostPid` (the CLI hosting the MCP server) is gone, go `offline`.
  The orchestrator role is vacated, never passed on. After a daemon restart each session gets a full
  window to heartbeat again. A heartbeat from an offline session brings it back if its host process
  lives and its name is free; otherwise it must register again.
- Limits: a recipient may hold 1000 unread messages (`-32004` beyond that). One `message.inbox` or
  `message.deliver` response carries at most about 900 KB of messages; the rest stay unread for the
  next call.
- Pruning: the sweep deletes an offline session, with its mailbox, by these rules in order. (1) A
  session with unread (queued) messages is kept for 7 days offline, so mail sent to a closed session
  survives a weekend; after that it and its mail are deleted. (2) A session replaced by a newer live
  session with the same name, CLI and repo is deleted 5 minutes after it went offline. It cannot come
  back, because a heartbeat is refused while another live session holds its name. (3) Any other
  offline session is deleted after 24 hours: it returns only while its host process lives, and a new
  run of the CLI registers as a new session. (4) An offline session whose recorded working directory, or
  repository root when it has one, has been missing from disk for 5 minutes is deleted, unless it
  has unread messages (rule 1 applies instead) or its host process still runs (it can come back
  with a heartbeat). The grace keeps a briefly unmounted drive or share from wiping its sessions. This clears the sessions of deleted temp repos and old checkouts. Online
  sessions are never deleted.
- Forget: `session.forget` removes offline sessions on request (`conveno forget`), by id, by name or
  `*` glob, and by how long ago they were last seen. It never removes an online session and reports
  those it skipped. A removed session's mailbox goes with it in one transaction; messages it sent to
  others stay. `dryRun` reports without changing anything.
- Status text is reduced to one line: control characters become spaces and whitespace collapses.
- Clients cannot send `system` messages, and `conveno`, `orchestrator`, `system` and `user` are
  reserved session names. Binding a session to the connection that registered it is planned.
- Idle exit: after `idleExitMs` with no online sessions.
- `session.unregister` marks the session offline (the row stays so old messages keep their sender).
- `session.list` `repo` matches the repo root path or its basename.
- `ticket.*`, `spawn.*` and `peek.*` return `-32601` because they are not implemented yet.

Known gap, planned: there is no socket backpressure. A client that stops reading can make the
daemon buffer its pending writes in memory.

No runtime dependencies beyond `protocol` and `core`.
