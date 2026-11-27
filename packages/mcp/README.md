# @conveno/mcp

stdio MCP server that lets an AI coding session talk to other sessions on the same machine. It
connects to the daemon through `@conveno/client`. The session registers when the MCP
handshake completes, sends a heartbeat every 15 s, and unregisters when the server closes.

## Tools

- `whoami`: this session's id, name, CLI, repo, device and orchestrator flag
- `list_sessions`: other sessions, filtered by repo, CLI and offline state
- `send`: text to a session by name, id or `orchestrator`, with an optional `urgent` flag
- `inbox`: read messages (unread only by default) and mark them read
- `ack`: acknowledge handled message ids
- `rename`: change this session's name
- `set_status`: a short status line that other sessions see in `list_sessions`
- `orchestrate`: take the orchestrator role from the current holder

## Exports

- `createServer(options)`: build the server from a client, the MCP server's ancestor pids (`hostPids`, nearest first, from `readAncestry`) and a working directory
- `runStdio(options)`: connect the server to stdio and run until stdin closes or SIGTERM arrives
- `formatSessionTable`, `formatAge`: the plain-text output used by `list_sessions`
- `PACKAGE_NAME`
