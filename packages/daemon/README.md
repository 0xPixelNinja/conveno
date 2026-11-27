# @0xpixelninja/conveno-daemon

`convenod`: the local daemon. It serves the Conveno IPC protocol (JSON-RPC 2.0 over NDJSON) on a
Unix socket or Windows named pipe, stores sessions and messages in SQLite, and tracks which sessions
are alive. All rules (naming, liveness, orchestrator, mailbox) come from `@0xpixelninja/conveno-core`.

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
  Windows the file inherits the per-user data directory ACL, no explicit ACL is set). `hello` must be
  the first call. A wrong token gets `-32001` and the connection is closed. A protocol version other
  than `conveno/1` gets `-32005`.
- Storage: `<data>/conveno.db` through `node:sqlite`, WAL mode, schema tracked in a `migrations` table.
- Single instance: `<data>/daemon.lock`. A lock is stale unless its pid is alive and the socket answers
  (or the lock is under 5 s old). On POSIX a leftover socket file is removed only when nothing answers on it.
- Liveness: every 15 s sessions with no heartbeat for 45 s, or whose `hostPid` is gone, go `offline`.
  The orchestrator role is vacated, never passed on. After a daemon restart each session gets a full
  window to heartbeat again. A heartbeat from an offline session brings it back if its host process
  lives and its name is free; otherwise it must register again.
- Idle exit: after `idleExitMs` with no online sessions.
- `session.unregister` marks the session offline (the row stays so old messages keep their sender).
- `session.list` `repo` matches the repo root path or its basename.
- `ticket.*`, `spawn.*` and `peek.*` return `-32601` until their milestones.

No runtime dependencies beyond `protocol` and `core`.
