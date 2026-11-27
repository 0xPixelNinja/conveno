# Releasing

One package is published to npm: `@conveno/cli`. It bundles every other workspace package, so
there is nothing else to release. All other packages are `"private": true`. The workspace packages
that have code carry the same version as the CLI, and `pnpm check:release` fails if they drift.

Every release goes out as a release candidate first. A version with a prerelease part
(`0.1.1-rc.1`) publishes to the npm dist-tag `next`. A plain version (`0.1.1`) publishes to
`latest`, which is what `npm install -g @conveno/cli` installs. The workflow derives the dist-tag
from the version, so a candidate cannot reach `latest` by accident.

## One-time setup on npmjs.com

The release workflow publishes with npm trusted publishing: it holds no npm token. The package owner
adds the publisher once, on npmjs.com, under the `@conveno/cli` package settings, "Trusted
publishing", GitHub Actions:

- Organization or user: `0xPixelNinja`
- Repository: `conveno`
- Workflow filename: `release.yml`
- Environment name: leave empty
- Allowed actions: allow `npm publish`

The fields are case-sensitive and npm does not check them when you save, so a typo shows up as a
failed publish. A new configuration must be used for a successful publish within two days or it
expires. The repository must be public for npm to attach provenance. See
[Trusted publishing](https://docs.npmjs.com/trusted-publishers) and
[Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements).

## Release candidate

1. Set the version, for example `0.1.1-rc.1`, in the `package.json` of `@conveno/cli` and of every
   workspace package that has a version other than `0.0.0`. Update `VERSION` in
   `packages/cli/src/version.ts`, `DAEMON_VERSION` in `packages/daemon/src/server.ts` and
   `SERVER_VERSION` in `packages/mcp/src/index.ts`. Tests fail if these drift from `package.json`.
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

## Retiring the old packages

Releases before 0.1.1 published ten packages. After the first 0.1.1 release, deprecate the nine that
are now bundled (with an npm account that owns the scope):

```sh
for p in protocol core client daemon mcp brand adapter-claude adapter-codex adapter-opencode; do
  npm deprecate "@conveno/$p@*" "Merged into @conveno/cli. Install @conveno/cli instead."
done
```

## What the workflow does

`.github/workflows/release.yml` runs on every `v*` tag push, in two jobs.

`verify` has read access only. It installs with the frozen lockfile and runs lint, typecheck, build,
test and the pack smoke test. It then runs `node scripts/check-release.mjs "$TAG"`, which fails
unless the tag is `vX.Y.Z` or `vX.Y.Z-pre` and equals the version of `@conveno/cli` and of the
other versioned packages. The script prints the dist-tag (`next` for a prerelease, `latest`
otherwise). The job packs `@conveno/cli` with `pnpm pack` and uploads the tarball.

`publish` is the only job with `id-token: write`. It checks that its npm is 11.5.1 or later, which
trusted publishing needs, downloads the tarball and runs
`npm publish <tarball> --access public --provenance --tag <dist-tag>`. It checks out and runs no
repository code. Every action in both workflows is pinned to a full commit SHA, and Dependabot
keeps the pins current.

Why the tag is explicit: the npm `tag` config for publish defaults to `latest`, so without `--tag`
a prerelease would land on `latest` too. See the npm docs for
[`npm publish --tag`](https://docs.npmjs.com/cli/v11/commands/npm-publish) and
[dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages). Vite does the same: its release
scripts read the prerelease part of the version and publish it under that dist-tag
([vitejs/release-scripts, `src/publish.ts`](https://github.com/vitejs/release-scripts/blob/main/src/publish.ts)).
The name `next` for candidates is common practice, and Conveno uses it for every prerelease.

`pnpm smoke:pack` packs `@conveno/cli`, installs the tarball into a clean project with `npm`, checks
that only the promised files and no other `@conveno` package were installed, and runs the installed
`conveno` (version, doctor, daemon start and stop, and an MCP handshake) with an isolated home and
data directory. CI runs it on Linux, macOS and Windows.
