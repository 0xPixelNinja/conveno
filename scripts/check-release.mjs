// Release consistency check: `node scripts/check-release.mjs [tag] [--print-dist-tag]`.
// - every publishable package (not "private") has the same version, equal to the tag when one is given
// - the version is X.Y.Z or X.Y.Z-prerelease; a prerelease publishes to the npm dist-tag "next", a
//   plain version to "latest" (rules in release-tag.ts). --print-dist-tag prints that tag alone.
// - publishable packages depend only on other publishable packages
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { distTagFor, isVersion, versionOfTag } from "./release-tag.ts";

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

const publishable = manifests.filter((m) => m.private !== true);
const names = new Set(publishable.map((m) => m.name));
const problems = [];

const argv = process.argv.slice(2);
const printDistTag = argv.includes("--print-dist-tag");
const tag = argv.find((a) => !a.startsWith("--"));
const expected = tag === undefined ? publishable[0]?.version : versionOfTag(tag);
if (tag !== undefined && !(tag.startsWith("v") && isVersion(expected ?? ""))) {
  problems.push(`tag "${tag}" is not of the form vX.Y.Z or vX.Y.Z-rc.N`);
} else if (expected === undefined || !isVersion(expected)) {
  problems.push(`version "${expected}" is not X.Y.Z or X.Y.Z-rc.N`);
}
for (const m of publishable) {
  if (m.version !== expected) problems.push(`${m.name} is at ${m.version}, expected ${expected}`);
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(m[field] ?? {})) {
      if (String(range).startsWith("workspace:") && !names.has(dep)) {
        problems.push(`${m.name} depends on ${dep}, which is private`);
      }
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
    `${publishable.length} publishable packages at ${expected}, dist-tag ${distTagFor(expected)}`,
  );
