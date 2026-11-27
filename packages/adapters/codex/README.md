# @conveno/adapter-codex

Conveno adapter for the OpenAI Codex CLI. Exports `codexAdapter` (also the default export), an `Adapter` from `@conveno/core`. Delivery tier: `next_turn`.

## What it configures

| Piece | Where | Content |
| --- | --- | --- |
| MCP server | `~/.codex/config.toml` | `[mcp_servers.conveno]` with `command = "<conveno command>"` and `args = [..., "mcp", "--cli", "codex"]` |
| Hooks | `~/.codex/hooks.json` | `SessionStart` and `UserPromptSubmit` command hooks running `<conveno command> hook codex <event>`, `timeout = 5` (seconds) |

- The MCP change carries `viaCommand` (`codex mcp add conveno -- <command> mcp --cli codex`) alongside the equivalent file diff. It is omitted when a `conveno` entry already exists with other values, because `codex mcp add` is documented only for new servers; the file diff is used then. Uninstall has no command: the docs do not describe `codex mcp remove`, so uninstall edits the file.
- `plan` returns an empty list when everything is already installed. If the conveno command path changed, the existing entries are replaced, not duplicated.
- `uninstallPlan` removes only the `conveno` MCP table and handlers whose command ends in `hook codex SessionStart` or `hook codex UserPromptSubmit`. Other hooks and servers stay.
- Config is read from `<home>/.codex`. `CODEX_HOME` is not read; pass a different `home` in `AdapterEnv` if needed.
- Malformed TOML or JSON makes `plan` and `uninstallPlan` throw an error that names the file; nothing is changed.

## TOML editing

`@decimalturn/toml-patch` (maintained fork of `toml-patch`) keeps comments but rewrites new entries as dotted inline tables and leaves an empty `[mcp_servers]` header after removal. So the adapter edits text directly: it appends its own `[mcp_servers.conveno]` table, or removes that table and its subtables, leaving the rest of the file byte for byte. It parses the result and compares it with the expected data. Only if they differ (for example `conveno` is defined inline under `[mcp_servers]`) does it fall back to `toml-patch`, which still preserves comments.

## Hook contract

Codex runs the command with a JSON object on stdin. The adapter ignores that input and finds the session by the hook's ancestor pids (`session.byHost`), takes undelivered messages (`message.deliver`), and prints, for both events:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<formatHookContext output>"}}
```

`hookEventName` is `UserPromptSubmit` for that event. It prints nothing and exits 0 when there is no session, no messages, an unknown event, or any error.

Codex asks the user to review and trust new or changed hooks (`/hooks`) before they run, so delivery starts after that step. Until then the `inbox` tool still works.

## Sources

- Hooks: https://learn.chatgpt.com/docs/hooks (locations `$CODEX_HOME/hooks.json` or `~/.codex/hooks.json`, `[hooks]` in `config.toml`, matcher groups, `timeout` in seconds, stdin fields, `hookSpecificOutput.additionalContext`, trust by hash, no feature flag needed)
- MCP: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (formerly https://developers.openai.com/codex/mcp; `[mcp_servers.<name>]` with `command`, `args`, `env`; `codex mcp add <name> -- <command>`)
- Source: https://github.com/openai/codex

## Hook command quoting on Windows

The Codex hooks page (https://learn.chatgpt.com/docs/hooks) does not say which shell runs a hook command. The source does: `codex-rs/hooks/src/engine/command_runner.rs` (`build_command`, `default_shell_program`) runs `%COMSPEC% /C "<command line>"`, falling back to `cmd.exe`, on Windows, and `$SHELL -lc` elsewhere. When `conveno` on PATH is this install, the command is plain `conveno hook codex SessionStart` and none of the quoting below applies. Otherwise, on Windows the command is written for cmd.exe: words with spaces in double quotes, and forward slashes in paths, for example `"C:/Program Files/nodejs/node.exe" "C:/Users/x/AppData/Roaming/npm/node_modules/@conveno/cli/dist/bin.js" hook codex SessionStart`. cmd.exe runs a quoted program path with forward slashes, and the outer quotes that Codex adds around the whole line are stripped by `/C`. Paths without spaces are left unquoted. The docs also list a `commandWindows` override, which is not needed. Read from the docs and source only, not run on Windows.
