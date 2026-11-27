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

## Hook command quoting on Windows

Hook commands in shell form are run by Git Bash on Windows, or by PowerShell when Git Bash is not installed (https://code.claude.com/docs/en/hooks, "Exec form and shell form": "`sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git Bash isn't installed"). The adapter writes the command for bash and uses forward slashes in every Windows path, for example `"C:/Program Files/nodejs/node.exe" "C:/Users/x/AppData/Roaming/npm/node_modules/conveno/dist/bin.js" hook claude SessionStart`. A backslash would otherwise need doubling inside the JSON string and again for bash, which is how `C:\\Program Files` ended up in the command before. Windows accepts `/` in every path Node and Git Bash use, so the command means the same file with nothing to escape. Paths without spaces are left unquoted. The MCP entry in `~/.claude.json` is not run through a shell and keeps native paths.

Not covered: without Git Bash, Claude Code runs the command in PowerShell, where a line that starts with a quoted string is a parse error (the docs' "Common Windows errors" describe the same failure). Install Git for Windows, which Claude Code uses by default. The docs also describe an exec form (`args` field, no shell); it is not used because the docs do not say which Claude Code version added it. The shell was read from the docs only and not run on Windows.
