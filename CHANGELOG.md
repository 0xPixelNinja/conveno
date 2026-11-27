# Changelog

## 0.1.1

Fixes from the first run of 0.1.0 against the real Claude Code, OpenCode and Codex on Windows.

- Codex can now call Conveno's tools in `codex exec`. `conveno init` sets `default_tools_approval_mode = "approve"` on the `conveno` server in `~/.codex/config.toml`, for that server only. Before, Codex asked for approval it had no way to get and blocked every call. `conveno uninstall` removes it with the rest of the entry.
- `conveno doctor`, `status`, `daemon start`, `daemon status` and `mcp` now give a fix that matches the cause. When the socket path is too long, they say to set `XDG_RUNTIME_DIR` to a shorter directory instead of telling you to run `conveno daemon start`.
- Only `daemon start` and the MCP server start the daemon. A test now checks that `status`, `doctor`, `daemon status`, `daemon stop`, `hook`, `init` and `uninstall` do not.
- The real-CLI check cleans up after a run that was killed. It leaves a marker file before `init`, removes it after `uninstall`, and offers to run `daemon stop` and `uninstall --yes` if it finds one at the start.

## 0.1.0

First release.

- A local daemon, started on demand, that lets AI coding sessions on one machine find each other and exchange messages.
- An MCP server with eight tools: `whoami`, `list_sessions`, `send`, `inbox`, and more.
- Setup for Claude Code, Codex and OpenCode through `conveno init`, which shows each change first, backs up every file it edits and can be undone with `conveno uninstall`.
- `conveno status` and `conveno doctor` to see sessions and check the install.
- Claude Code and Codex get messages at the next prompt through hooks. OpenCode reads them through the `inbox` tool.
