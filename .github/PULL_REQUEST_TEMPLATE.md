<!-- PR title: Conventional Commits, `type(scope): subject`, e.g. `fix(daemon): remove stale socket on startup`.
     Types: feat, fix, docs, chore, refactor, test, ci, build, style, perf.
     Scopes: brand, protocol, cli, daemon, mcp, core, crypto, relay, adapters, repo, deps. -->

## Summary

What changed and why.

## Type

- [ ] feat
- [ ] fix
- [ ] docs
- [ ] chore, refactor, test, ci or build

## Checklist

- [ ] The title follows Conventional Commits
- [ ] Tests added or updated
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` pass
- [ ] Docs updated where behaviour changed
- [ ] The compliance rules in CONTRIBUTING.md are respected (no provider credentials, official CLIs only, relay never runs agents)
- [ ] No secrets, tokens or personal data in code, fixtures or logs
