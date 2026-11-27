# conveno

The `conveno` command.

| Command | What it does |
|---|---|
| `conveno init [--yes] [--dry-run] [--cli claude,codex,opencode]` | Detects installed CLIs, shows a unified diff for every file it would change, asks, backs up to `<data>/backups/<timestamp>/` with a `manifest.json`, then applies. Without a terminal and without `--yes` it prints the plan and exits 1. `--dry-run` prints the plan and writes nothing. |
| `conveno uninstall [--yes]` | Restores the files from the latest manifest byte for byte. With no manifest it asks each adapter for its uninstall plan. |
| `conveno status` | Sessions grouped by repo, orchestrator marked. |
| `conveno doctor` | Per CLI: detected, version, MCP and hooks configured, delivery tier, fixes. Also whether the daemon answers. |
| `conveno daemon start\|stop\|status` | `stop` sends SIGTERM to the pid in the lock file (`taskkill` on Windows). |
| `conveno mcp --cli <cli>` | MCP stdio server. The CLIs launch this. |
| `conveno hook <cli> <event>` | Hook entry. Reads the hook JSON on stdin, never starts a daemon, always exits 0, gives up after 2 s. |

The command written into CLI configs is `[node, <this install's bin.js>]`, so configs work without a global install. It is `conveno` instead when the first `conveno` on `PATH` links to this same install.
The daemon entry is resolved from this package's own dependency (`import.meta.resolve("@0xpixelninja/conveno-daemon/bin")`) and passed to every connection.

Tests build a context with temp HOME and data directories, fake or real adapters, and a real in-process daemon. Rendered output is snapshotted with `NO_COLOR` set. They import the built daemon, so run `pnpm build` first.
