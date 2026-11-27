# Caucus

Caucus is a vendor-neutral mesh that lets AI coding CLI sessions (Claude Code, Codex,
Antigravity, Cursor, Copilot, OpenCode) find each other, message each other, spawn each other and
peek at each other, through a local daemon and a per-session MCP server. An end-to-end encrypted
cloud relay for connecting machines is planned.

**Status: pre-alpha, under construction.** Nothing is published yet. Currently only the wire
protocol (`packages/protocol`) is implemented; the other packages are stubs.

See [PLAN.md](./PLAN.md) for the product plan and milestones, and
[packages/protocol/PROTOCOL.md](./packages/protocol/PROTOCOL.md) for the protocol spec.

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

## Licence

Apache-2.0, except `packages/relay`, which is AGPL-3.0-only. See each package's `LICENSE`.
