# @conveno/client

Typed IPC client for the Conveno daemon. The `mcp`, `cli` and hook code use it.

The package exports one function, `connect(options)`. It opens the daemon socket and returns a
`ConvenoClient` with one typed method per IPC call, such as `session.list`, `message.send` and
`orchestrator.claim`. The method names are defined in `@conveno/protocol`.

## Options

- `kind` (required): the kind of client connecting
- `dataDir`: directory that holds `daemon.token`. Defaults to core's `dataDir` for the platform.
- `socketPath`: daemon endpoint. Defaults to the protocol's default socket path.
- `autoStart`: spawn the daemon when nothing is listening. Default `true`.
- `daemonEntry`: path to the daemon's entry script. Auto-start needs it; without one, a missing daemon is an error.
- `requestTimeoutMs`: per-request timeout. Default 5000 ms.
- `startTimeoutMs`: how long to retry after auto-start. Default 3000 ms.

Call `close()` on the client when you are done with it.
