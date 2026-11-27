# Contributing to Conveno

Conveno is pre-alpha. The local mesh is implemented: protocol, daemon, client, core, MCP server and
CLI, with the Claude, Codex and OpenCode adapters. The relay, crypto, redact and account-web packages
and the Antigravity, Copilot and Cursor adapters are planned and not implemented, so the most useful
contributions right now are protocol review, tests, docs and adapter research. Open an issue
before starting anything large.

By taking part you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Report security problems
privately, as described in [SECURITY.md](./SECURITY.md).

## Setup

You need Node 24 or later (see `.nvmrc`) and pnpm 12.

```sh
pnpm install
```

To run the CLI from a checkout, build first and call the bin directly:

```sh
pnpm build
node packages/cli/dist/bin.js init
```

| Script | What it does |
|---|---|
| `pnpm lint` | Biome check (format, imports, lint) |
| `pnpm format` | Biome format, writes changes |
| `pnpm deps:check` | List outdated dependencies across the workspace (`pnpm outdated -r`); exits 1 when any are |
| `pnpm typecheck` | `tsc` in every package, through turbo |
| `pnpm smoke:pack` | Pack the publishable packages, install them with npm in a temp project and run the installed `conveno` |
| `pnpm build` | `tsdown` in every package, through turbo |
| `pnpm test` | `vitest run` in every package, through turbo |

CI runs lint and typecheck once, then build and test on Ubuntu (Node 24 and 26) and Windows (Node
24), plus an install check from packed tarballs. macOS joins on pushes to main and on request
(`gh workflow run ci.yml --ref <branch> -f full=true`).
Run them locally in that order before you push. Code must work on all three operating systems, so
use `node:path` and avoid shell-specific commands.

`packages/brand` generates its TypeScript and CSS from `brand/` in a turbo `generate` task that build, typecheck
and test depend on. Edit `brand/tokens.json`, not the generated files.

## Commits

Use Conventional Commits: `type(scope): subject`.

- Subject in lowercase imperative mood, no trailing period, 72 characters or fewer.
- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`, `build`, `style`, `perf`.
- Scopes: `brand`, `protocol`, `cli`, `client`, `daemon`, `mcp`, `core`, `crypto`, `relay`, `redact`,
  `adapters`, `e2e`, `site`, `release`, `repo`, `deps`.
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
6. Respond to review. We squash merge once every CI job is green.

## Adding a CLI adapter

Adapters live in `packages/adapters/<cli>` and implement the `Adapter` interface from
`packages/core/src/adapter.ts`:

1. `detect(env)` reports whether the CLI is installed, its version and the config paths it uses.
2. `plan(env)` returns the `ConfigChange` list that adds the Conveno MCP server entry and hooks to the
   CLI's config. It is idempotent: empty when already installed. `conveno init` applies it and backs up
   every file it changes. `uninstallPlan(env)` returns the reverse, for `conveno uninstall`.
3. `hook(event, input, ctx)` handles a hook call from the CLI and returns its output. An adapter with
   `deliveryTier: "next_turn"` injects pending messages into the next turn. One with
   `deliveryTier: "inbox"` returns empty output, and the agent reads messages with the `inbox` tool.
   `conveno doctor` reports the tier.

Use only documented, official mechanisms. Start with the CLI adapter request issue template, and add
recorded hook payloads as test fixtures. Copy the layout of an existing adapter (`src/index.ts` plus
focused modules and tests).

Planned and not implemented yet: spawning the CLI (with ACP where it offers it), reading transcripts
for `peek`, live push, and declaring the tested CLI versions.

## Labels

`.github/labels.yml` lists the issue and pull request labels: type, area (one per package), tier,
`good first issue`, `help wanted`, `compliance` and `security`. A maintainer applies them with
`gh label create --force`. Pick the area label that matches the package you change.

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
