# Releasing

Ten packages are published to npm under the `@conveno` scope, all at the same version:
`protocol`, `core`, `client`, `daemon`, `mcp`, `brand`, `adapter-claude`, `adapter-codex`,
`adapter-opencode` and `cli`. Every other package is `"private": true` and is never published.

Every release goes out as a release candidate first. A version with a prerelease part
(`0.1.1-rc.1`) publishes to the npm dist-tag `next`. A plain version (`0.1.1`) publishes to
`latest`, which is what `npm install -g @conveno/cli` installs. The workflow derives the dist-tag
from the version, so a candidate cannot reach `latest` by accident.

## Release candidate

1. Set the version, for example `0.1.1-rc.1`, in the `package.json` of each publishable package.
   Update `VERSION` in `packages/cli/src/version.ts`, `DAEMON_VERSION` in
   `packages/daemon/src/server.ts` and `SERVER_VERSION` in `packages/mcp/src/index.ts`. Tests fail
   if these drift from `package.json`.
2. Run `pnpm check:release`, then `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` and
   `pnpm smoke:pack`.
3. Commit (for example `chore: release v0.1.1-rc.1`), then tag and push:

   ```sh
   git tag v0.1.1-rc.1
   git push origin main v0.1.1-rc.1
   ```

4. Test the candidate:

   ```sh
   npm i -g @conveno/cli@next
   conveno --version
   ```

   Run the real-CLI check (`packages/e2e/real-cli/README.md`) against it. If something is wrong,
   fix it and publish `0.1.1-rc.2` the same way.

## Final release

1. Change every version to the plain `0.1.1` in the same places as above, and turn the changelog
   entry from "unreleased" into the release.
2. Run the same checks, commit (`chore: release v0.1.1`), then tag and push `v0.1.1`.
3. The workflow publishes it to `latest`. Check with `npm view @conveno/cli dist-tags`.

## What the workflow does

`.github/workflows/release.yml` runs on every `v*` tag push. It installs with the frozen lockfile,
runs lint, typecheck, build, test and the pack smoke test, then runs
`node scripts/check-release.mjs "$TAG"`. That fails unless the tag is `vX.Y.Z` or `vX.Y.Z-pre` and
equals the version in every publishable `package.json`. The script then prints the dist-tag
(`next` for a prerelease, `latest` otherwise), and the workflow runs
`pnpm -r publish --access public --no-git-checks --tag <dist-tag>`. pnpm rewrites `workspace:*` to
the real version and publishes dependencies first. It authenticates with the `NPM_TOKEN` repository
secret.

Why the tag is explicit: the npm `tag` config for publish defaults to `latest`, so without `--tag`
a prerelease would land on `latest` too. See the npm docs for
[`npm publish --tag`](https://docs.npmjs.com/cli/v11/commands/npm-publish) and
[dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages), and
[`pnpm publish --tag`](https://pnpm.io/cli/publish). Vite does the same: its release scripts
read the prerelease part of the version and publish it under that dist-tag
([vitejs/release-scripts, `src/publish.ts`](https://github.com/vitejs/release-scripts/blob/main/src/publish.ts)).
The name `next` for candidates is common practice, and Conveno uses it for every prerelease.

`pnpm smoke:pack` packs the ten packages, installs the tarballs into a clean project with `npm`,
and runs the installed `conveno` (version, doctor, daemon start and stop, and an MCP handshake)
with an isolated home and data directory. CI runs it on Linux, macOS and Windows.

Provenance is off while the repository is private. When it goes public, turn on provenance or move
to npm trusted publishing (`id-token: write` is already granted).
