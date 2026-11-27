# Releasing

Ten packages are published to npm under the `@conveno` scope, all at the same version:
`protocol`, `core`, `client`, `daemon`, `mcp`, `brand`, `adapter-claude`, `adapter-codex`,
`adapter-opencode` and `cli`. Every other package is `"private": true` and is never published.

## Steps

1. Set the new version in the `package.json` of each publishable package. Update `VERSION` in
   `packages/cli/src/version.ts`, `DAEMON_VERSION` in `packages/daemon/src/server.ts` and
   `SERVER_VERSION` in `packages/mcp/src/index.ts`. Tests fail if these drift from `package.json`.
2. Run `pnpm check:release`, then `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` and
   `pnpm smoke:pack`.
3. Commit (for example `chore: release v0.1.0`), then tag and push:

   ```sh
   git tag v0.1.0
   git push origin main v0.1.0
   ```

## What the workflow does

`.github/workflows/release.yml` runs on every `v*` tag push. It installs with the frozen lockfile,
runs lint, typecheck, build, test and the pack smoke test, checks that the tag equals the version in
every publishable `package.json`, then runs `pnpm -r publish --access public --no-git-checks`. pnpm
rewrites `workspace:*` to the real version and publishes dependencies first. It authenticates with
the `NPM_TOKEN` repository secret.

`pnpm smoke:pack` packs the ten packages, installs the tarballs into a clean project with `npm`,
and runs the installed `conveno` (version, doctor, daemon start and stop, and an MCP handshake)
with an isolated home and data directory. CI runs it on Linux, macOS and Windows.

Provenance is off while the repository is private. When it goes public, turn on provenance or move
to npm trusted publishing (`id-token: write` is already granted).
