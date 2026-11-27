// Release tag rules. Plain erasable TypeScript: check-release.mjs loads it through Node's type
// stripping, and a unit test imports it directly.
//
// A version with a prerelease part (1.2.3-rc.1) publishes to the npm dist-tag `next`. A plain
// version (1.2.3) publishes to `latest`. Without --tag, npm and pnpm publish to `latest`, so a
// prerelease would become what `npm i -g @conveno/cli` installs. Vite's release scripts derive the
// dist-tag from the version the same way (vitejs/release-scripts, src/publish.ts).

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isVersion = (version: string): boolean => SEMVER.test(version);

/** `v1.2.3-rc.1` and `1.2.3-rc.1` both give `1.2.3-rc.1`. */
export const versionOfTag = (tag: string): string => tag.replace(/^v/, "");

/** The npm dist-tag a version publishes to. Throws on a string that is not a version. */
export function distTagFor(version: string): "latest" | "next" {
  const m = SEMVER.exec(version);
  if (!m) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
  return m[4] === undefined ? "latest" : "next";
}
