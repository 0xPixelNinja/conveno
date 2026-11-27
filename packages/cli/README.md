# @conveno/cli

Conveno connects the AI coding CLI sessions on one machine so they can find each other, send messages and route work to the one session you pick as the orchestrator. You keep using each CLI the way you do today. This package is the `conveno` command and everything it needs, including the local daemon.

- Website: https://conveno.dev
- Source and issues: https://github.com/0xPixelNinja/conveno
- Status: pre-alpha. The local mesh works. The relay, tickets, handoff, peek and spawn are planned.

## Install

You need Node 24 or later.

```sh
npm i -g @conveno/cli
conveno --version
```

## Get started

```sh
conveno init
```

`conveno init` finds the supported CLIs on your machine and shows a diff of every config file it would change. It asks before it writes, and it backs each file up first. Add `--dry-run` to print the plan and write nothing.

Then open two CLI sessions, for example Claude Code and Codex. In one, ask it to run `list_sessions`, then to `send` a message to the other. `conveno status` lists the sessions.

`conveno uninstall` reverts what `init` did. A file that has not changed since `init` is restored byte for byte. If a CLI has rewritten it since, only Conveno's entries are removed.

## Commands

| Command | What it does |
|---|---|
| `conveno init` | Add the Conveno MCP server and hooks to each detected CLI. |
| `conveno uninstall` | Undo every install that has not been undone. |
| `conveno status` | Online sessions grouped by repo, with the orchestrator marked. `--all` includes offline ones. |
| `conveno doctor` | Check each CLI and the daemon, and say how to fix what is wrong. |
| `conveno daemon start\|stop\|status` | Control the local daemon. It also starts when a CLI opens the Conveno MCP server, and exits when no session has been online for a while. |

`conveno --help` lists the rest, and `conveno <command> --help` shows the options of one. The `mcp` and `hook` commands are what the CLIs call; you do not run them yourself.

## Supported CLIs

| CLI | Delivery |
|---|---|
| Claude Code | At the start of the next turn (hook), or with the `inbox` tool |
| Codex | At the start of the next turn (hook), or with the `inbox` tool |
| OpenCode | With the `inbox` tool |

Antigravity, Cursor and Copilot are planned.

## How it works

Each CLI session starts its own MCP server through `conveno mcp`. The servers talk to one small daemon on your machine, which keeps the session list, the mailboxes and the routing. The daemon listens on a local socket and nothing leaves your machine. Messages from other sessions reach an agent labelled as data from a peer, not as instructions from you.

Conveno never reads, stores or forwards a provider login token or credential file. It works with the official CLIs only, under your own login or API key.

## Licence

Code: Apache-2.0, see `LICENSE`. The Conveno name, mark and brand assets are not covered by that licence, see `NOTICE`.
