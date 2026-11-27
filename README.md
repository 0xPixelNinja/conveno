<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/assets/readme-hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/assets/readme-hero-light.svg">
  <img alt="Conveno: Every AI coding session, in one meeting." src="brand/assets/readme-banner-light.svg" width="100%">
</picture>

Connect AI coding CLI sessions across every platform. Peer-to-peer, end-to-end encrypted.

[![CI](https://github.com/0xPixelNinja/conveno/actions/workflows/ci.yml/badge.svg)](https://github.com/0xPixelNinja/conveno/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2346D9)](./LICENSE)
[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-2346D9)](./.nvmrc)
[![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-9A5700)](#status-and-roadmap)

## What it is

Conveno lets AI coding CLI sessions find each other, send each other messages, start each other and
hand work off. It works across Claude Code, Codex, Antigravity, Cursor, Copilot and OpenCode, on
macOS, Linux and Windows.

You keep using each CLI the way you do today. Conveno adds an MCP server and a few hooks to each one,
and a small local daemon that connects them. There is no dashboard. The interface is whichever
session you choose as the orchestrator.

## Why

Sessions on every CLI are isolated. The Claude Code session in one repo cannot see the Codex session
in another, and neither can tell the other what it learned. Claude Code can already coordinate its own
sessions. Nothing does it across tools, and nothing does it across your machines.

Today you copy and paste between terminals. Conveno replaces the paste with a message, a handoff or a
question routed to the one session you are watching.

## How it works

```
  Claude Code   Codex   Antigravity   Cursor   Copilot   OpenCode
      |           |          |           |        |          |
      +-----------+---- MCP (stdio) + hooks per CLI ---------+
                              |
                        conveno-mcp   (one per session)
                              |  local IPC
                          convenod    (daemon: registry, mailbox, routing, spawn, peek)
                              |
                              |  optional, end-to-end encrypted
                              v
                        Conveno relay  (sees ciphertext and routing metadata only)
                              ^
                              |
                  convenod on your other machines
```

Each session gets an automatic name such as `claude@repo-1`. Messages are delivered live where the
CLI supports it, at the next turn through a hook where it does not, and through an `inbox` tool as the
fallback on every CLI. The architecture and the delivery mechanism per CLI are in
[PLAN.md](./PLAN.md).

## What it will do

- **Sessions.** List every session on your account with its CLI, repo and status (idle, busy, waiting
  on a question), filtered by repo.
- **Orchestrator.** Any session can claim the orchestrator role, and you can move it at any time.
  There is one per workspace.
- **Messages.** Send to a session or to the orchestrator. A busy session queues the message until its
  next turn unless it is marked urgent.
- **Tickets.** A question or permission request from any session becomes a ticket routed to the
  orchestrator, which answers it or asks you. Nothing is approved on a timeout.
- **Handoff.** Pass work to another session with a goal, current state, next steps and files touched.
- **Peek.** Read another session's recent turns, its full history or a summary. Secrets are redacted
  before anything leaves the session.
- **Spawn.** Start a new session in a visible terminal or headless. The owner approves it unless the
  CLI is on an allowlist, with limits on how many sessions run at once and how deep spawning goes.
- **Relay.** Connect machines through an end-to-end encrypted relay. The local mesh never needs an
  account.

## Compliance and trust

- Conveno never reads, stores or forwards a provider login token or credential file.
- It starts only the unmodified official CLI, under the user's own login or API key.
- Spawning happens on your machine, when a session or you ask for it. Nothing runs on a schedule by
  default.
- The relay carries messages between your own sessions. It never calls a model provider and never
  runs an agent. It sees account and device ids, timestamps and message sizes. Message content is
  sealed to each recipient device and signed by the sender, so the relay sees ciphertext only.
- Messages from other sessions reach an agent labelled as data from a peer, not as instructions from
  the user.
- Antigravity is connected through MCP only. Conveno does not start or drive `agy` unless you
  configure a Gemini API key.

The full list of rules is in [PLAN.md, section 10](./PLAN.md). To report a security problem, see
[SECURITY.md](./SECURITY.md).

## Supported CLIs

| CLI | Tier | Notes |
|---|---|---|
| Claude Code | A | Hooks, channels and spawn |
| Codex | A | Hooks and spawn |
| Antigravity | B | MCP only by default |
| Cursor | B | Hooks and spawn |
| Copilot | B | Hooks and spawn |
| OpenCode | B | HTTP API and ACP |

Tier A is the polished path at launch. Tier B ships labelled beta. `conveno doctor` will report which
delivery mechanism is active for each installed CLI and version.

## Status and roadmap

Pre-alpha. Nothing is usable yet and nothing is published. The wire protocol
([`packages/protocol`](./packages/protocol)) is implemented. The daemon, MCP server, adapters, crypto
and relay are stubs, and the `conveno` command prints its version and exits.

The milestones, from the local core to the relay, accounts and launch, are in
[PLAN.md, section 13](./PLAN.md).

## Development

You need Node 24 or later and pnpm 12.

```sh
pnpm install
pnpm lint        # Biome
pnpm typecheck   # tsc through turbo
pnpm build       # tsdown through turbo
pnpm test        # vitest through turbo
```

The packages are under [`packages/`](./packages). `packages/brand` generates its sources from
`brand/` on every build, typecheck and test, so run the scripts through pnpm.
[CONTRIBUTING.md](./CONTRIBUTING.md) has the commit style, the pull request flow and how to add a CLI
adapter.

## Brand

The mark, tokens, icons, motion and terminal theme are in [`brand/`](./brand). Open
[`brand/index.html`](./brand/index.html) for the brand book. `brand/tokens.json` is the source of
truth.

## License

The code is Apache-2.0, except [`packages/relay`](./packages/relay), which is AGPL-3.0-only. See
[LICENSE](./LICENSE) and each package's own `LICENSE`.

The brand assets in [`brand/`](./brand) are copyright 0xPixelNinja and have their own terms in
[`brand/LICENSE.md`](./brand/LICENSE.md). You may use them to refer to Conveno, not for other products.
