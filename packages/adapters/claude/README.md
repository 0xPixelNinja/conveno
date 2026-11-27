# @0xpixelninja/conveno-adapter-claude

Conveno adapter for Claude Code. Exports `claudeAdapter` (named and default), an `Adapter` from `@0xpixelninja/conveno-core`. Delivery tier: `next_turn`.

## What it installs

1. MCP server `conveno` at user scope, in `~/.claude.json` under `mcpServers`:
   `{ "type": "stdio", "command": "<conveno>", "args": [..., "mcp", "--cli", "claude"], "env": {} }`.
   The plan's `viaCommand` is `claude mcp add --scope user conveno -- <conveno command> mcp --cli claude`; the file change is the equivalent before/after.
2. Hooks in `~/.claude/settings.json` for `SessionStart` and `UserPromptSubmit`, each a command hook running `<conveno command> hook claude <Event>` with `timeout: 5` (seconds).

Existing keys, servers and hooks are left alone. Indentation and trailing newline of the existing file are kept. Planning again after an install returns no changes. A stale conveno path from an earlier install is replaced, not duplicated. Uninstall removes only the `conveno` server and hook handlers whose command ends in `hook claude SessionStart` or `hook claude UserPromptSubmit`.

Invalid JSON, a non-object top level, or a non-object `hooks` or `mcpServers` makes `plan` throw an error that names the file and changes nothing.

If `CLAUDE_CONFIG_DIR` is set, both files live in that directory (`.claude.json` and `settings.json`).

## Hook output

`hook(event, input, ctx)` looks up the session with `session.byHost({ hostPid })`, calls `message.deliver`, and when messages exist prints:

```json
{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "<formatHookContext(messages)>" } }
```

Otherwise it prints nothing. Any error, unknown event or missing session gives empty output and exit code 0.

## Sources

Checked 2026-11-27.

- MCP, `claude mcp add --scope user`, `~/.claude.json`: https://code.claude.com/docs/en/mcp
- Hooks format, SessionStart and UserPromptSubmit input and `additionalContext` output, timeout in seconds: https://code.claude.com/docs/en/hooks
- Settings file locations, `CLAUDE_CONFIG_DIR`: https://code.claude.com/docs/en/settings

Dependency: `jsonc-parser` (already used by the OpenCode adapter). The file fallback edits the existing text with `modify` and `applyEdits`, so only our keys change; duplicate keys, string escapes, key order and line endings elsewhere stay byte for byte. Claude Code rewrites `~/.claude.json` constantly, so a whole-file rewrite would lose or reformat its data.

The docs do not show the exact user-scope layout of `~/.claude.json`. The `mcpServers` top-level key and the `type`/`command`/`args`/`env` entry shape follow what `claude mcp add` writes; verify with `claude mcp get conveno`.
