// Release consistency check: `node scripts/check-release.mjs [tag] [--print-dist-tag]`.
// Conveno ships one npm package, @conveno/cli, with every other workspace package bundled into it.
// - @conveno/cli is the only package that is not "private"
// - its version is X.Y.Z or X.Y.Z-prerelease, equal to the tag when one is given, and every other
//   workspace package that has a version (not the 0.0.0 placeholders) is at the same version. A
//   prerelease publishes to the npm dist-tag "next", a plain version to "latest" (rules in
//   release-tag.ts). --print-dist-tag prints that tag alone.
// - the CLI lists no workspace package under dependencies (they are bundled, so they are
//   devDependencies), and every third-party dependency of the packages it bundles is a dependency of
//   the CLI at the same exact version
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distTagFor, isVersion, versionOfTag } from "./release-tag.ts";

const PLACEHOLDER_VERSION = "0.0.0";
const PUBLISHED = "@conveno/cli";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [];
for (const top of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!top.isDirectory()) continue;
  const dir = join(root, "packages", top.name);
  const dirs = existsSync(join(dir, "package.json"))
    ? [dir]
    : readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "package.json")))
        .map((d) => join(dir, d.name));
  for (const d of dirs) manifests.push(JSON.parse(readFileSync(join(d, "package.json"), "utf8")));
}

const byName = new Map(manifests.map((m) => [m.name, m]));
const problems = [];

const publishable = manifests.filter((m) => m.private !== true);
if (publishable.length !== 1 || publishable[0].name !== PUBLISHED) {
  problems.push(
    `only ${PUBLISHED} may be published, but these are not private: ${publishable.map((m) => m.name).join(", ") || "none"}`,
  );
}
const cli = byName.get(PUBLISHED);
if (!cli) {
  console.error(`${PUBLISHED} not found under packages/`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const printDistTag = argv.includes("--print-dist-tag");
const tag = argv.find((a) => !a.startsWith("--"));
const expected = tag === undefined ? cli.version : versionOfTag(tag);
if (tag !== undefined && !(tag.startsWith("v") && isVersion(expected ?? ""))) {
  problems.push(`tag "${tag}" is not of the form vX.Y.Z or vX.Y.Z-rc.N`);
} else if (expected === undefined || !isVersion(expected)) {
  problems.push(`version "${expected}" is not X.Y.Z or X.Y.Z-rc.N`);
}

for (const m of manifests) {
  if (m.version === PLACEHOLDER_VERSION && m.private === true) continue;
  if (m.version !== expected) problems.push(`${m.name} is at ${m.version}, expected ${expected}`);
}

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  for (const [dep, range] of Object.entries(cli[field] ?? {})) {
    if (String(range).startsWith("workspace:") || byName.has(dep)) {
      problems.push(
        `${PUBLISHED} lists ${dep} under ${field}. Workspace packages are bundled: use devDependencies.`,
      );
    }
  }
}
for (const [dep, range] of Object.entries(cli.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(range))) {
    problems.push(`${PUBLISHED} depends on ${dep}@${range}, which is not an exact version`);
  }
}

// What the CLI bundles: its workspace devDependencies, and what those depend on in turn.
const bundled = new Set();
const visit = (name) => {
  if (bundled.has(name)) return;
  const m = byName.get(name);
  if (!m) return;
  bundled.add(name);
  for (const dep of Object.keys(m.dependencies ?? {})) visit(dep);
};
for (const [dep, range] of Object.entries(cli.devDependencies ?? {})) {
  if (!String(range).startsWith("workspace:")) continue;
  if (!byName.has(dep)) problems.push(`${PUBLISHED} bundles ${dep}, which is not in the workspace`);
  visit(dep);
}
for (const name of bundled) {
  for (const [dep, range] of Object.entries(byName.get(name).dependencies ?? {})) {
    if (byName.has(dep)) continue;
    const have = cli.dependencies?.[dep];
    if (have === undefined) {
      problems.push(`${name} depends on ${dep}, which ${PUBLISHED} does not declare`);
    } else if (have !== range) {
      problems.push(`${name} uses ${dep}@${range} but ${PUBLISHED} declares ${have}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (printDistTag) console.log(distTagFor(expected));
else
  console.log(
    `${PUBLISHED} ${expected}, dist-tag ${distTagFor(expected)}, bundles ${bundled.size} workspace packages`,
  );
