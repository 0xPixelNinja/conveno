# Contributing to Conveno

Conveno is pre-alpha. The M1 local core is in progress. The protocol, daemon, client, core, MCP server
and CLI are implemented, along with the Claude, Codex and OpenCode adapters. The relay, crypto, redact
and account-web packages and the Antigravity, Copilot and Cursor adapters are still stubs, so the most
useful contributions right now are protocol review, tests, docs and adapter research. Open an issue
before starting anything large.

By taking part you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Report security problems
privately, as described in [SECURITY.md](./SECURITY.md).

## Setup

You need Node 24 or later (see `.nvmrc`) and pnpm 12.

```sh
pnpm install
```

| Script | What it does |
|---|---|
| `pnpm lint` | Biome check (format, imports, lint) |
| `pnpm format` | Biome format, writes changes |
| `pnpm typecheck` | `tsc` in every package, through turbo |
| `pnpm build` | `tsdown` in every package, through turbo |
| `pnpm test` | `vitest run` in every package, through turbo |

CI runs install, lint, typecheck, build and test on Ubuntu, macOS and Windows with Node 24 and 26.
Run them locally in that order before you push. Code must work on all three operating systems, so
use `node:path` and avoid shell-specific commands.

`packages/brand` generates its TypeScript and CSS from `brand/` each time you build, typecheck or test
it. Edit `brand/tokens.json`, not the generated files.

## Commits

Use Conventional Commits: `type(scope): subject`.

- Subject in lowercase imperative mood, no trailing period, 72 characters or fewer.
- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style`, `perf`.
- Scopes: `brand`, `protocol`, `cli`, `daemon`, `mcp`, `core`, `crypto`, `relay`, `adapters`, `repo`,
  `deps`.
- Use the body to say why, when the diff does not make it obvious.

Examples:

```
feat(protocol): add ticket cancel message
fix(daemon): remove stale socket on startup
docs(repo): explain delivery tiers
```

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep the change focused. Unrelated cleanups go in a separate pull request.
3. Add or update tests, and docs where behaviour changes.
4. Make sure lint, typecheck, build and test pass.
5. Open the pull request. Its title follows the same Conventional Commits format as a commit, because
   it becomes the squash commit message. Fill in the template.
6. Respond to review. We squash merge once CI is green on all six jobs.

## Adding a CLI adapter

Adapters live in `packages/adapters/<cli>`. Each one covers the same five jobs, and each declares the
CLI versions it was tested on:

1. **Detect** whether the CLI is installed and which version.
2. **Install** the MCP server entry and hooks into the CLI's config, backing up every file it changes
   so `conveno uninstall` can restore it.
3. **Deliver** messages: live push if the CLI offers it, next-turn injection through a hook, and the
   `inbox` fallback. Report which tier is active for `conveno doctor`.
4. **Spawn** the unmodified official binary, visible or headless, with ACP where the CLI supports it.
5. **Read transcripts** into the common `Turn[]` shape for `peek`. On an unknown format, return the raw
   tail with a warning rather than failing.

Start with the CLI adapter request issue template, and add recorded hook payloads and transcripts as
test fixtures for each supported version. Use only documented, official mechanisms.

## Compliance rules

Every contribution must follow these rules. A pull request that breaks one will not be merged.

1. Never read, store or forward any provider login token or credential file. Adapters read only an
   allowlist of paths.
2. Spawn only the unmodified official CLI, under its own login or the user's API key.
3. Spawn only on the user's own machine, when a session or the owner asks. Nothing runs on a schedule
   by default.
4. The relay carries messages between the user's own sessions only. It never calls a model provider
   and never runs agents.
5. Antigravity is MCP only by default. Do not spawn or drive `agy` unless the user has configured a
   Gemini API key.
6. Recommend API keys for heavy or unattended spawning.
7. Ship the Claude channels integration as a proper plugin. Never tell users to enable the
   development-channels flag.
8. Messages from other sessions are always framed to the receiving agent as data from a peer, never as
   instructions from the user.

Also: no secrets, tokens or personal data in code, tests, fixtures or logs, and redaction must run
before anything from one session reaches another.

## Licensing

Contributions are licensed under the licence of the package they change: Apache-2.0, or AGPL-3.0-only
for `packages/relay`. The brand assets in `brand/` are covered by `brand/LICENSE.md` and are not open
for reuse in other products.
