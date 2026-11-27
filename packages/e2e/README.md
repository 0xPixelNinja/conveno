# @0xpixelninja/conveno-e2e

Cross-platform end-to-end tests for Conveno. Private, never published.

Each test file starts the real `convenod` (`packages/daemon/dist/bin.js`) in a temporary home, data dir and socket (via `HOME`, `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `LOCALAPPDATA` and `USERNAME`). Fake CLIs are child processes that spawn the MCP server (`src/fixtures/mcp-entry.mjs`, which calls `runStdio`), so `hostPid` relationships are real. The MCP SDK `Client` drives each server over stdio.

| File | Covers |
|---|---|
| `scenarios.test.ts` | Three sessions: names, list, send by name and `orchestrator`, framing, urgent order, ack, rename and conflict, set_status, orchestrate handover, no-holder error |
| `hooks.test.ts` | `claudeAdapter.hook` and `codexAdapter.hook` with real host pids: JSON shape, delivered once, history kept |
| `liveness.test.ts` | Crashes a host and its MCP server; the 15 s sweep marks it offline, vacates the orchestrator, and sends fail |
| `persistence.test.ts` | Sessions, orchestrator and queued messages survive a daemon restart |

Run `pnpm build` at the repo root first (the tests use `dist/`), then `pnpm --filter @0xpixelninja/conveno-e2e test`. The liveness test takes about 16 s.

`real-cli/` has a script for the owner's machine that uses the real CLIs: see `real-cli/README.md`.
