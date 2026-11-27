# @0xpixelninja/conveno-adapter-opencode

Conveno adapter for OpenCode. Exports `opencodeAdapter` (named and default).

- Detect: runs `opencode --version`.
- Install: adds a local MCP server named `conveno` that runs `<conveno command> mcp --cli opencode` to the global config.
- Uninstall: removes only `mcp.servers.conveno`.
- Delivery tier: `inbox`. `hook()` returns empty output.

The config file is `~/.config/opencode/opencode.jsonc` if present, else `opencode.json`, else a new `opencode.json`. Edits are made with `jsonc-parser`, so comments and trailing commas in existing files are kept. A file that does not parse is left untouched and the error says where.

## Config shape

The current OpenCode docs (V2) put servers under `mcp.servers`, not directly under `mcp`, and have no `enabled` field: servers connect automatically and `disabled: true` turns one off. The written entry is:

```jsonc
{ "mcp": { "servers": { "conveno": { "type": "local", "command": ["conveno", "mcp", "--cli", "opencode"] } } } }
```

Older OpenCode releases (V1) used `mcp.<name>` with `enabled`. This adapter targets the current docs only.

## Sources

- https://opencode.ai/docs/mcp-servers/ (local server fields: `type`, `command`, `cwd`, `environment`, `disabled`)
- https://opencode.ai/docs/config/ (global path `~/.config/opencode/opencode.json(c)`; JSON and JSONC are both supported)

The docs list no Windows-specific global path, so `~/.config/opencode` is used on every OS.

## TODO (M2): plugin delivery

The config docs say OpenCode loads plugins from the `plugins` config array (a package name, or an object with `package` and `options`) and from `plugins/` directories, including the global config directory. They do not describe the plugin event API; the plugins guide (https://opencode.ai/docs/plugins/) has to be read first. M2 should ship a Conveno plugin there that fetches pending messages from the daemon and injects them at the start of a turn, which would move this adapter to the `next_turn` tier.
