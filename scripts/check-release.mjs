// Release consistency check: `node scripts/check-release.mjs [tag]`.
// - every publishable package (not "private") has the same version, equal to the tag when one is given
// - publishable packages depend only on other publishable packages
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const tag = process.argv[2];
const expected = tag === undefined ? publishable[0]?.version : tag.replace(/^v/, "");
if (tag !== undefined && !/^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
  problems.push(`tag "${tag}" is not of the form vX.Y.Z`);
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
console.log(`${publishable.length} publishable packages at ${expected}`);
