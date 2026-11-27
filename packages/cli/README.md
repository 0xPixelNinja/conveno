# conveno

The `conveno` command. `conveno --help` lists the commands and `conveno <command> --help` the options of one. Unknown commands and flags exit 2 and suggest the closest name. `conveno --version` prints the version and nothing else.

| Command | What it does |
|---|---|
| `conveno init [--yes] [--dry-run] [--cli claude,codex,opencode]` | Detects installed CLIs, shows a unified diff for every file it would change, asks, backs up to `<data>/backups/<timestamp>/` with a `manifest.json`, then applies. Without a terminal and without `--yes` it prints the plan and exits 2. `--dry-run` prints the plan and writes nothing. |
| `conveno uninstall [--yes]` | Undoes every install that has not been undone, newest first. A file that still hashes to what init wrote is restored byte for byte. A file changed since (Claude Code rewrites `~/.claude.json` all the time) is not restored: only Conveno's entries are removed, and the output names those files. With no manifest it asks each adapter for its uninstall plan. Needs `--yes` without a terminal (exit 2). |
| `conveno status` | Sessions grouped by repo, orchestrator marked. Says `relay: off (local only)`. |
| `conveno doctor` | Per CLI: detected, version, MCP and hooks configured (`not configured` when missing), delivery tier, fixes. Also whether the daemon answers. |
| `conveno daemon start\|stop\|status` | `stop` signals the pid in the lock file (`taskkill` on Windows) only when something answers the Conveno handshake on the socket. Otherwise it removes the stale lock and says so. |
| `conveno mcp --cli <cli>` | MCP stdio server. The CLIs launch this. |
| `conveno hook <cli> <event>` | Hook entry. Reads the hook JSON on stdin, never starts a daemon, always exits 0, gives up after 2 s. |

## Safety rules

- Every file is re-read after the confirm prompt. If it no longer matches the plan, nothing is written to it and the command exits 1 with a plain message.
- Files are written through a temp file in the same directory and renamed, keeping the file mode.
- Data and backup directories are mode 0700 on POSIX (existing ones are tightened); backup files are 0600.
- A CLI's own command (`claude mcp add`) is used when the binary exists, never on Windows. There the file edit is used, because the `.cmd` shims need a shell that would split paths with spaces and act on `&` or `^`. The dry run and the confirm screen show the command that will run and label the diff as the expected result.
- The hook finds its session by walking up from its parent process (up to 6 levels), because `/bin/sh -c "conveno hook ..."` under dash does not exec and the parent is the shell. Linux reads `/proc/<pid>/stat`, macOS runs `ps -o ppid= -p <pid>`, Windows asks CIM once for the process table. Best effort: any failure means nothing is delivered.

The command written into CLI configs is `[node, <this install's bin.js>]`, so configs work without a global install. It is `conveno` instead when the first `conveno` on `PATH` links to this same install.
The daemon entry is resolved from this package's own dependency (`import.meta.resolve("@0xpixelninja/conveno-daemon/bin")`) and passed to every connection.

Tests build a context with temp HOME and data directories, fake or real adapters, and a real in-process daemon. Rendered output is snapshotted with `NO_COLOR` set. They import the built daemon, so run `pnpm build` first.
