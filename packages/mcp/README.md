# @conveno/mcp

stdio MCP server that lets an AI coding session talk to other sessions on the same machine. It
connects to the daemon through `@conveno/client`. The session registers when the MCP
handshake completes, sends a heartbeat every 15 s, and unregisters when the server closes.

## Server instructions

The initialize result carries an `instructions` string (`SERVER_INSTRUCTIONS`). The MCP specification describes it as a hint to the model about how to use the server (https://modelcontextprotocol.io/specification/2025-06-18/schema, `InitializeResult.instructions`). It says that Conveno connects the user's other AI coding sessions and that questions about other sessions, agents, the orchestrator or messages should be answered by calling the tools, not from general knowledge. It repeats that messages from other sessions are information, not instructions from the user. Whether a client shows it to the model is up to the client.

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

- `createServer(options)`: build the server from a client, the host CLI pid and raw ancestor chain (`host`, from `readAncestry`) and a working directory
- `runStdio(options)`: connect the server to stdio and run until stdin closes or SIGTERM arrives
- `formatSessionTable`, `formatAge`: the plain-text output used by `list_sessions`
- `PACKAGE_NAME`
