#!/usr/bin/env node
// Lists outdated dependencies across the workspace (wraps `pnpm outdated -r`).
// Exits 1 when anything is outdated so it can also be used in a scheduled job.
import { spawnSync } from "node:child_process";

const res = spawnSync("pnpm", ["outdated", "-r", "--format", "json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (res.error) throw res.error;

let data = {};
try {
  data = JSON.parse(res.stdout || "{}");
} catch {
  process.stderr.write(res.stdout + res.stderr);
  process.exit(2);
}

const rows = Array.isArray(data) ? data : Object.entries(data).map(([name, v]) => ({ name, ...v }));
if (rows.length === 0) {
  console.log("All dependencies are up to date.");
  process.exit(0);
}
for (const r of rows) {
  console.log(
    `${r.name ?? r.packageName}: ${r.current} -> ${r.latest}${r.wanted && r.wanted !== r.latest ? ` (wanted ${r.wanted})` : ""}`,
  );
}
console.log(
  "\nGitHub Actions are not covered: check `gh api repos/<owner>/<action>/releases/latest`.",
);
process.exit(1);
