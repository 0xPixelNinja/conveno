import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
  /**
   * sha256 of the file as init left it. Uninstall restores the backup only while the file still
   * has this hash. Missing in manifests written by older builds.
   */
  afterSha256?: string;
}

export interface Manifest {
  version: 1;
  createdAt: string;
  entries: ManifestEntry[];
  restoredAt?: string;
}

const MANIFEST_NAME = "manifest.json";
const isPosix = (ctx: Ctx): boolean => ctx.platform !== "win32";

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** A file changed between planning and writing. */
export class StaleError extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while Conveno was working. Nothing in it was overwritten.`);
    this.name = "StaleError";
  }
}

/** Will this change be made by the CLI's own command? Never on Windows: .cmd shims need a shell. */
export const usesCommand = (ctx: Ctx, item: PlannedChange): boolean =>
  Boolean(item.change.viaCommand) && item.installed && ctx.platform !== "win32";

/** Print one block per file: path, what changes, the command that will run, the unified diff. */
export function presentChanges(ctx: Ctx, items: PlannedChange[]): void {
  const t = ctx.theme;
  for (const item of items) {
    const { change } = item;
    ctx.out(
      `  ${t.bold(tilde(change.path, ctx.home))}${change.before === null ? t.paint("quiet", "  (new file)") : ""}\n`,
    );
    ctx.out(`    ${change.description}\n`);
    const viaCommand = usesCommand(ctx, item) && change.viaCommand !== undefined;
    if (viaCommand && change.viaCommand) {
      ctx.out(`    ${t.paint("quiet", "will run")}  ${t.bold(change.viaCommand.join(" "))}\n`);
      ctx.out(
        `    ${t.paint("quiet", "expected result (the command may format the file differently)")}\n`,
      );
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

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Create a directory only the user can use, and tighten one that already exists. */
async function privateDir(ctx: Ctx, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (isPosix(ctx)) await chmod(dir, 0o700).catch(() => undefined);
}

/**
 * Write through a temp file in the same directory, then rename over the target, so a reader never
 * sees half a file. Keeps the mode of an existing file and writes through a symlink.
 */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const mode = await stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined,
  );
  const tmp = join(dir, `.${basename(target)}.conveno-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { mode: mode ?? 0o644 });
    if (mode !== undefined && process.platform !== "win32") await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export interface Applied {
  backupDir: string;
  /** How each change was made. */
  how: { cli: CliKind; path: string; via: "command" | "file" }[];
}

/** Re-read the file and refuse to go on when it is no longer what the plan was made from. */
async function currentIfUnchanged(change: ConfigChange): Promise<Buffer | null> {
  const bytes = await readBytes(change.path);
  const same =
    change.before === null
      ? bytes === null
      : bytes !== null && bytes.toString("utf8") === change.before;
  if (!same) throw new StaleError(change.path);
  return bytes;
}

/**
 * Back up every file we will touch, write the manifest, then apply. Each file is re-read first,
 * so a change made after the plan was shown is never overwritten.
 */
export async function applyChanges(
  ctx: Ctx,
  items: PlannedChange[],
  opts: { markRestored?: boolean } = {},
): Promise<Applied> {
  const paths = dataPaths(ctx.platform, ctx.dataDir);
  const unique = items.filter(
    (it, i) => items.findIndex((o) => o.change.path === it.change.path) === i,
  );
  const originals = new Map<string, Buffer | null>();
  for (const { change } of unique) originals.set(change.path, await currentIfUnchanged(change));

  await privateDir(ctx, ctx.dataDir);
  await privateDir(ctx, paths.backups);
  const stamp = ctx.now().toISOString().slice(0, 19).replace(/:/g, "-");
  const backupDir = join(paths.backups, await uniqueDir(paths.backups, stamp));
  await privateDir(ctx, backupDir);

  const entries: ManifestEntry[] = [];
  for (const { cli, change } of unique) {
    const original = originals.get(change.path) ?? null;
    let backup: string | null = null;
    if (original !== null) {
      backup = mirrored(change.path);
      const dest = join(backupDir, backup);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, original, { mode: 0o600 });
    }
    entries.push({
      cli,
      path: change.path,
      backup,
      description: change.description,
      afterSha256: sha256(change.after),
    });
  }
  const manifest: Manifest = {
    version: 1,
    createdAt: ctx.now().toISOString(),
    entries,
    ...(opts.markRestored ? { restoredAt: ctx.now().toISOString() } : {}),
  };
  const writeManifest = () =>
    writeFile(join(backupDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  await writeManifest();

  const how: Applied["how"] = [];
  for (const item of unique) {
    const { cli, change } = item;
    let done = false;
    if (usesCommand(ctx, item) && change.viaCommand) {
      const [bin, ...args] = change.viaCommand;
      try {
        const r = await ctx.exec(bin as string, args);
        // A command that exits 0 but leaves the file alone did nothing we can rely on.
        const now = await readBytes(change.path);
        done = r.code === 0 && now !== null && now.toString("utf8") !== change.before;
      } catch {
        done = false;
      }
    }
    if (!done) {
      await currentIfUnchanged(change);
      await writeAtomic(change.path, change.after);
    }
    how.push({ cli, path: change.path, via: done ? "command" : "file" });
  }

  // Record what is on disk now, which differs from `after` when the CLI's command formatted it.
  let rewrite = false;
  for (const e of entries) {
    const now = await readBytes(e.path);
    if (now !== null && sha256(now) !== e.afterSha256) {
      e.afterSha256 = sha256(now);
      rewrite = true;
    }
  }
  if (rewrite) await writeManifest();
  return { backupDir, how };
}

/** Every manifest that has not been restored yet, newest first. */
export async function listManifests(ctx: Ctx): Promise<{ dir: string; manifest: Manifest }[]> {
  const { backups } = dataPaths(ctx.platform, ctx.dataDir);
  const names = (await readdir(backups).catch(() => [] as string[])).sort().reverse();
  const out: { dir: string; manifest: Manifest }[] = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(
        await readFile(join(backups, name, MANIFEST_NAME), "utf8"),
      ) as Manifest;
      if (manifest.version === 1 && !manifest.restoredAt) {
        out.push({ dir: join(backups, name), manifest });
      }
    } catch {
      // not a backup directory we wrote; skip it
    }
  }
  return out;
}

export type EntryAction = "restore" | "remove" | "edit" | "gone";

/**
 * What uninstall does with one file. `current` is the hash of the file now (null when missing).
 * The backup is restored only when the file is exactly what init left; any other content means
 * someone changed it since, so only Conveno's own entries come out.
 */
export function actionFor(entry: ManifestEntry, current: string | null): EntryAction {
  if (current === null) return "gone";
  if (entry.afterSha256 !== undefined && current === entry.afterSha256) {
    return entry.backup === null ? "remove" : "restore";
  }
  return "edit";
}

export interface PreviewRow {
  entry: ManifestEntry;
  action: EntryAction;
}

/**
 * Predict the actions for all manifests, newest to oldest, following how each restore changes the
 * file the next (older) manifest sees.
 */
export async function previewRestore(
  manifests: { dir: string; manifest: Manifest }[],
): Promise<PreviewRow[]> {
  const state = new Map<string, string | null>();
  const rows: PreviewRow[] = [];
  for (const { dir, manifest } of manifests) {
    for (const entry of manifest.entries) {
      if (!state.has(entry.path)) {
        const bytes = await readBytes(entry.path);
        state.set(entry.path, bytes === null ? null : sha256(bytes));
      }
      const action = actionFor(entry, state.get(entry.path) ?? null);
      rows.push({ entry, action });
      if (action === "restore" && entry.backup !== null) {
        state.set(entry.path, sha256(await readFile(join(dir, entry.backup))));
      } else if (action === "remove") state.set(entry.path, null);
      else if (action === "edit") state.set(entry.path, "unknown");
    }
  }
  return rows;
}

/** Restore one file as init found it, when it still matches. Returns the action taken. */
export async function restoreEntry(dir: string, entry: ManifestEntry): Promise<EntryAction> {
  const bytes = await readBytes(entry.path);
  const action = actionFor(entry, bytes === null ? null : sha256(bytes));
  if (action === "remove") await rm(entry.path, { force: true });
  else if (action === "restore" && entry.backup !== null) {
    await writeAtomic(entry.path, await readFile(join(dir, entry.backup)));
  }
  return action;
}

export async function markRestored(
  ctx: Ctx,
  found: { dir: string; manifest: Manifest },
): Promise<void> {
  const done: Manifest = { ...found.manifest, restoredAt: ctx.now().toISOString() };
  await writeFile(join(found.dir, MANIFEST_NAME), `${JSON.stringify(done, null, 2)}\n`, {
    mode: 0o600,
  });
}
