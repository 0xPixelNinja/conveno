import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ConfigChange, dataPaths } from "@conveno/core";
import type { CliKind } from "@conveno/protocol";
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
  /** True unless files written earlier in the same run could not be put back. */
  rolledBack = true;
  constructor(readonly path: string) {
    super(`${path} changed while Conveno was working. Nothing in it was overwritten.`);
    this.name = "StaleError";
  }
}

/** Will this change be made by the CLI's own command? Yes when the CLI is installed and the plan has one. */
export const usesCommand = (item: PlannedChange): boolean =>
  Boolean(item.change.viaCommand) && item.installed;

/** Print one block per file: path, what changes, the command that will run, the unified diff. */
export function presentChanges(ctx: Ctx, items: PlannedChange[]): void {
  const t = ctx.theme;
  for (const item of items) {
    const { change } = item;
    ctx.out(
      `  ${t.bold(tilde(change.path, ctx.home))}${change.before === null ? t.paint("quiet", "  (new file)") : ""}\n`,
    );
    ctx.out(`    ${change.description}\n`);
    const viaCommand = usesCommand(item) && change.viaCommand !== undefined;
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
export const mirrored = (path: string): string =>
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

/** The file operations `writeAtomic` uses. Tests replace them to simulate Windows lock errors. */
export interface WriteIo {
  realpath(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  mode(path: string): Promise<number | undefined>;
  writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Open `path` truncated, write, flush to disk, close. */
  overwrite(path: string, data: string | Uint8Array): Promise<void>;
  rm(path: string): Promise<void>;
  platform: NodeJS.Platform;
}

export const realIo: WriteIo = {
  realpath: (p) => realpath(p),
  mkdir: async (p) => void (await mkdir(p, { recursive: true })),
  mode: (p) =>
    stat(p).then(
      (s) => s.mode & 0o777,
      () => undefined,
    ),
  writeFile: (p, data, mode) => writeFile(p, data, { mode }),
  chmod: (p, mode) => chmod(p, mode),
  rename: (a, b) => rename(a, b),
  overwrite: async (p, data) => {
    const fh = await open(p, "w");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  rm: (p) => rm(p, { force: true }),
  platform: process.platform,
};

/**
 * Replace the contents of `path` with `data`, keeping its mode and writing through a symlink.
 *
 * POSIX: write a temp file in the same directory, then rename it over the target, so a reader
 * never sees half a file.
 *
 * Windows: write the target in place (open truncated, write, fsync). Reason, confirmed in the
 * libuv source Node uses: `fs.rename` is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which needs
 * DELETE access to the existing target. That fails with ERROR_ACCESS_DENIED (reported as EPERM,
 * with `err.path` set to the temp file, the source) whenever any other process holds the target
 * open without FILE_SHARE_DELETE. Node itself shares READ, WRITE and DELETE on every handle, but
 * C runtime, Python and .NET defaults share only READ and WRITE, and so may a running CLI or a
 * virus scanner. Truncating in place needs only FILE_SHARE_WRITE from the other handles, so it
 * succeeds in the cases where an atomic replace cannot. The cost is that a reader can see a
 * half-written file for a moment. That is acceptable here because callers re-read the target and
 * compare it with the plan just before writing, and `applyChanges` restores every file from its
 * backup if any write fails. No temp file exists on this path, so none can be left behind.
 */
export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
  io: WriteIo = realIo,
): Promise<void> {
  const target = await io.realpath(path).catch(() => path);
  await io.mkdir(dirname(target));
  if (io.platform === "win32") {
    await io.overwrite(target, data);
    return;
  }
  const mode = await io.mode(target);
  const tmp = join(
    dirname(target),
    `.${basename(target)}.conveno-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await io.writeFile(tmp, data, mode ?? 0o644);
    if (mode !== undefined) await io.chmod(tmp, mode);
    await io.rename(tmp, target);
  } catch (e) {
    // Node names the temp file (the rename source) in the error. The user cares about the target.
    if (e instanceof Error && (e as NodeJS.ErrnoException).path === tmp) {
      (e as NodeJS.ErrnoException).path = target;
    }
    throw e;
  } finally {
    await io.rm(tmp).catch(() => undefined);
  }
}

/** A write failed. `rolledBack` says whether every file written before it was put back. */
export class ApplyError extends Error {
  constructor(
    message: string,
    readonly rolledBack: boolean,
    /** Files that could not be restored, with the backup directory that holds their originals. */
    readonly notRestored: string[],
    readonly backupDir: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApplyError";
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
  opts: { markRestored?: boolean; io?: WriteIo } = {},
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

  const io = opts.io ?? realIo;
  const how: Applied["how"] = [];
  // Files touched so far, so a failure can put them back. A path is listed before its write is
  // tried, because a CLI's own command may change the file and then fail.
  const touched: string[] = [];
  try {
    for (const item of unique) {
      const { cli, change } = item;
      let done = false;
      touched.push(change.path);
      if (usesCommand(item) && change.viaCommand) {
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
        await writeAtomic(change.path, change.after, io);
      }
      how.push({ cli, path: change.path, via: done ? "command" : "file" });
    }
  } catch (e) {
    const notRestored: string[] = [];
    for (const path of touched.reverse()) {
      const original = originals.get(path) ?? null;
      try {
        const now = await readBytes(path);
        const unchanged = original === null ? now === null : now?.equals(original) === true;
        if (unchanged) continue; // the failed write never reached this file
        if (original === null) await io.rm(path);
        else await writeAtomic(path, original, io);
      } catch {
        notRestored.push(path);
      }
    }
    const rolledBack = notRestored.length === 0;
    // With everything restored, the backups and manifest describe a change that never happened.
    if (rolledBack) await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    if (e instanceof StaleError) {
      e.rolledBack = rolledBack;
      throw e;
    }
    throw new ApplyError(
      e instanceof Error ? e.message : String(e),
      rolledBack,
      notRestored,
      backupDir,
      {
        cause: e,
      },
    );
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
