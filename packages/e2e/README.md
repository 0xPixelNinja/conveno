# @conveno/e2e

Cross-platform end-to-end tests for Conveno. Private, never published.

Each test file starts the real `convenod` (`packages/daemon/dist/bin.js`) in a temporary home, data dir and socket (via `HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `LOCALAPPDATA` and `USERNAME`). Fake CLIs are child processes that spawn the MCP server (`src/fixtures/mcp-entry.mjs`, which calls `runStdio`), so the `hostPids` ancestor chains are real. The MCP SDK `Client` drives each server over stdio.

| File | Covers |
|---|---|
| `scenarios.test.ts` | Three sessions: names, list, send by name and `orchestrator`, framing, urgent order, ack, rename and conflict, set_status, orchestrate handover, no-holder error |
| `hooks.test.ts` | `claudeAdapter.hook` and `codexAdapter.hook` with real host pids: JSON shape, delivered once, history kept |
| `liveness.test.ts` | Crashes a host and its MCP server; the 15 s sweep marks it offline, vacates the orchestrator, and sends fail |
| `persistence.test.ts` | Sessions, orchestrator and queued messages survive a daemon restart |
| `hook-shell.test.ts` | The installed hook command under `/bin/sh -c`, where the hook's parent is the shell and not the CLI: it still finds the session further up the process tree (POSIX only) |
| `shutdown.test.ts` | The real ancestor chain a session registers, and `daemon.shutdown`: the daemon replies, exits 0 and leaves no lock or socket behind |
| `marker.test.ts` | The real-CLI script's run marker and stale-run cleanup |
| `release-tag.test.ts` | Tag parsing and dist-tag choice in `scripts/release-tag.ts`, and `check-release.mjs` |

Run `pnpm build` at the repo root first (the tests use `dist/`), then `pnpm --filter @conveno/e2e test`. The liveness test takes about 16 s.

`real-cli/` has a script for a developer machine that uses the real CLIs: see `real-cli/README.md`.
