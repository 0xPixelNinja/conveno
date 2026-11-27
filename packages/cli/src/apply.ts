import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ConfigChange, dataPaths } from "@0xpixelninja/conveno-core";
import type { CliKind } from "@0xpixelninja/conveno-protocol";
import type { Ctx } from "./ctx.js";
import { paintDiff, unifiedDiff } from "./diff.js";
import { tilde } from "./fmt.js";

export interface PlannedChange {
  cli: CliKind;
  /** Is the CLI's binary present, so its `viaCommand` can run. */
  installed: boolean;
  change: ConfigChange;
}

export interface ManifestEntry {
  cli: CliKind;
  path: string;
  /** Backup file path relative to the backup directory, or null when the file did not exist. */
  backup: string | null;
  description: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  entries: ManifestEntry[];
  restoredAt?: string;
}

const MANIFEST_NAME = "manifest.json";

/** Print one block per file: path, what changes, the command that will run, the unified diff. */
export function presentChanges(ctx: Ctx, items: PlannedChange[]): void {
  const t = ctx.theme;
  for (const { change, installed } of items) {
    ctx.out(
      `  ${t.bold(tilde(change.path, ctx.home))}${change.before === null ? t.paint("quiet", "  (new file)") : ""}\n`,
    );
    ctx.out(`    ${change.description}\n`);
    if (change.viaCommand && installed) {
      ctx.out(`    ${t.paint("quiet", "run")}  ${t.bold(change.viaCommand.join(" "))}\n`);
    }
    const body = paintDiff(t, unifiedDiff(change.before, change.after));
    if (body.length > 0) ctx.out(`${body.join("\n")}\n`);
    ctx.out("\n");
  }
}

/** `<backups>/files/<path without drive or leading separator>`. */
const mirrored = (path: string): string =>
  join("files", path.replace(/^[A-Za-z]:/, "").replace(/^[\\/]+/, ""));

async function uniqueDir(base: string, stamp: string): Promise<string> {
  const existing = new Set(await readdir(base).catch(() => [] as string[]));
  let name = stamp;
  for (let n = 2; existing.has(name); n++) name = `${stamp}-${n}`;
  return name;
}

export interface Applied {
  backupDir: string;
  /** How each change was made. */
  how: { cli: CliKind; path: string; via: "command" | "file" }[];
}

/** Back up every file we will touch, write the manifest, then apply. */
export async function applyChanges(ctx: Ctx, items: PlannedChange[]): Promise<Applied> {
  const paths = dataPaths(ctx.platform, ctx.dataDir);
  await mkdir(paths.backups, { recursive: true });
  const stamp = ctx.now().toISOString().slice(0, 19).replace(/:/g, "-");
  const dirName = await uniqueDir(paths.backups, stamp);
  const backupDir = join(paths.backups, dirName);
  await mkdir(backupDir, { recursive: true });

  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const { cli, change } of items) {
    if (seen.has(change.path)) continue;
    seen.add(change.path);
    let backup: string | null = null;
    if (change.before !== null) {
      backup = mirrored(change.path);
      const dest = join(backupDir, backup);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(change.path, dest);
    }
    entries.push({ cli, path: change.path, backup, description: change.description });
  }
  const manifest: Manifest = { version: 1, createdAt: ctx.now().toISOString(), entries };
  await writeFile(join(backupDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

  const how: Applied["how"] = [];
  for (const { cli, installed, change } of items) {
    let done = false;
    if (change.viaCommand && installed) {
      const [bin, ...args] = change.viaCommand;
      try {
        const r = await ctx.exec(bin as string, args);
        done = r.code === 0;
      } catch {
        done = false;
      }
    }
    if (!done) {
      await mkdir(dirname(change.path), { recursive: true });
      await writeFile(change.path, change.after);
    }
    how.push({ cli, path: change.path, via: done ? "command" : "file" });
  }
  return { backupDir, how };
}

/** Newest manifest that has not been restored yet. */
export async function findLatestManifest(
  ctx: Ctx,
): Promise<{ dir: string; manifest: Manifest } | null> {
  const { backups } = dataPaths(ctx.platform, ctx.dataDir);
  const names = (await readdir(backups).catch(() => [] as string[])).sort().reverse();
  for (const name of names) {
    try {
      const manifest = JSON.parse(
        await readFile(join(backups, name, MANIFEST_NAME), "utf8"),
      ) as Manifest;
      if (manifest.version === 1 && !manifest.restoredAt) {
        return { dir: join(backups, name), manifest };
      }
    } catch {
      // not a backup directory we wrote; skip it
    }
  }
  return null;
}

/** Put every file back exactly as it was, then mark the manifest as used. */
export async function restoreManifest(
  ctx: Ctx,
  found: { dir: string; manifest: Manifest },
): Promise<void> {
  for (const e of found.manifest.entries) {
    if (e.backup === null) {
      await rm(e.path, { force: true });
    } else {
      await mkdir(dirname(e.path), { recursive: true });
      await writeFile(e.path, await readFile(join(found.dir, e.backup)));
    }
  }
  const done: Manifest = { ...found.manifest, restoredAt: ctx.now().toISOString() };
  await writeFile(join(found.dir, MANIFEST_NAME), `${JSON.stringify(done, null, 2)}\n`);
}
