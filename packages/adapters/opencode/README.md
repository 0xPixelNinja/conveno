# @0xpixelninja/conveno-adapter-opencode

Conveno adapter for OpenCode. Exports `opencodeAdapter` (named and default).

- Detect: runs `opencode --version`.
- Install: adds a local MCP server named `conveno` that runs `<conveno command> mcp --cli opencode` to the global config.
- Uninstall: removes only our `conveno` entry, from `mcp.servers` and from `mcp`.
- Delivery tier: `inbox`. `hook()` returns empty output.

The config file is `~/.config/opencode/opencode.jsonc` if present, else `opencode.json`, else a new `opencode.json`. Edits are made with `jsonc-parser`, so comments and trailing commas in existing files are kept. A file that does not parse is left untouched and the error says where.

## Config shape

The current OpenCode docs (V2) put servers under `mcp.servers`, not directly under `mcp`, and have no `enabled` field: servers connect automatically and `disabled: true` turns one off. V2 entry:

```jsonc
{ "mcp": { "servers": { "conveno": { "type": "local", "command": ["conveno", "mcp", "--cli", "opencode"] } } } }
```

V1 (older releases) used `mcp.<name>` with `enabled`:

```jsonc
{ "mcp": { "conveno": { "type": "local", "command": ["conveno", "mcp", "--cli", "opencode"], "enabled": true } } }
```

Choice of shape: the adapter runs `opencode --version`.

1. Known version below 2.2.0: always V1, even with no existing config. 2.2.0 is the first V2 release in the GitHub release list (https://github.com/sst/opencode/releases; no 2.0.x or 2.1.x tags exist, and the 1.x line continued to 1.19.6).
2. Known version 2.2.0 or later: V2.
3. Unknown version: V2 only if the config already has an `mcp.servers` object, otherwise V1 (including no config, no `mcp` key, or an empty `mcp`). V1 is the safer default: every 1.x release reads it, and the 1.19.6 source (`packages/opencode/src/config/v2-compat.ts`, `normalizeMcp`) shows 1.x also normalises the V2 `mcp.servers` envelope, while the V2 docs only promise V2. Earlier 1.x releases were not checked against `mcp.servers`; in 1.19.6 an `mcp` entry without a `type` is logged and ignored, not fatal.

When it writes one shape it removes our entry from the other. Uninstall removes our entry from both shapes.

## Where 2.x is published

`npm view opencode-ai dist-tags.latest` is 1.19.6, so the `opencode-ai` package is still the 1.x line. The V2 docs install 2.x as `@opencode/cli` on npm (`latest` is 2.4.2), `brew install anomalyco/tap/opencode-v2`, or `curl -fsSL https://opencode.ai/v2/install | bash`. `opencode --version` reports the installed line either way, which is what the adapter reads.

## Sources

- https://opencode.ai/docs/mcp-servers/ (local server fields: `type`, `command`, `cwd`, `environment`, `disabled`)
- https://opencode.ai/docs/config/ (global path `~/.config/opencode/opencode.json(c)`; JSON and JSONC are both supported)

The docs list no Windows-specific global path, so `~/.config/opencode` is used on every OS.

## Config location overrides

1. `OPENCODE_CONFIG`, when set, names one config file. That file is the only one the adapter reads or writes (it is created if missing).
2. Otherwise `$XDG_CONFIG_HOME/opencode/` when `XDG_CONFIG_HOME` is an absolute path.
3. Otherwise `~/.config/opencode/`.

Source for the default location: https://opencode.ai/docs/config/ (global config at `~/.config/opencode/opencode.json(c)`). That page does not describe `OPENCODE_CONFIG` or `XDG_CONFIG_HOME`; honouring them follows the XDG convention and the variable OpenCode's own tooling uses for a custom config file. Check them against the docs when they list them.

## TODO (M2): plugin delivery

The config docs say OpenCode loads plugins from the `plugins` config array (a package name, or an object with `package` and `options`) and from `plugins/` directories, including the global config directory. They do not describe the plugin event API; the plugins guide (https://opencode.ai/docs/plugins/) has to be read first. M2 should ship a Conveno plugin there that fetches pending messages from the daemon and injects them at the start of a turn, which would move this adapter to the `next_turn` tier.
