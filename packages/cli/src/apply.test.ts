import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApplyError,
  applyChanges,
  type PlannedChange,
  realIo,
  StaleError,
  type WriteIo,
  writeAtomic,
} from "./apply.js";
import { type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
const make = async () => {
  const c = await testCtx();
  ctxs.push(c);
  return c;
};
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

const eperm = (path: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), {
    code: "EPERM",
    path,
  });

describe("writeAtomic", () => {
  it("replaces a file through a temp file on POSIX and leaves no temp file", async () => {
    const c = await make();
    const file = join(c.root, "a.json");
    await writeFile(file, "old");
    const seen: string[] = [];
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: (from, to) => {
        seen.push(from);
        return realIo.rename(from, to);
      },
    };
    await writeAtomic(file, "new", io);
    expect(await readFile(file, "utf8")).toBe("new");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/\.a\.json\.conveno-[0-9a-f]{12}\.tmp$/);
    expect(await readdir(c.root)).toEqual(["a.json", "home"]);
  });

  it("names the target, not the temp file, when the rename is refused, and cleans up", async () => {
    const c = await make();
    const file = join(c.root, "settings.json");
    await writeFile(file, "old");
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: async (from) => {
        throw eperm(from);
      },
    };
    const err = await writeAtomic(file, "new", io).catch((e: unknown) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EPERM");
    expect((err as NodeJS.ErrnoException).path).toBe(file);
    expect(await readFile(file, "utf8")).toBe("old");
    expect(await readdir(c.root)).toEqual(["home", "settings.json"]);
  });

  it("on Windows writes in place and never renames, so a locked target is not a problem", async () => {
    const c = await make();
    const file = join(c.root, "settings.json");
    await writeFile(file, "old");
    const io: WriteIo = {
      ...realIo,
      platform: "win32",
      // Windows refuses a rename over a file another process holds open without share-delete.
      rename: async (from) => {
        throw eperm(from);
      },
    };
    await writeAtomic(file, "new content", io);
    expect(await readFile(file, "utf8")).toBe("new content");
    expect(await readdir(c.root)).toEqual(["home", "settings.json"]);
  });

  it("on Windows creates a missing file and its directory", async () => {
    const c = await make();
    const file = join(c.root, "deep", "dir", "new.json");
    await writeAtomic(file, "x", { ...realIo, platform: "win32" });
    expect(await readFile(file, "utf8")).toBe("x");
  });
});

describe("applyChanges is all or nothing", () => {
  const plan = (c: TestCtx, name: string, before: string | null, after: string): PlannedChange => ({
    cli: "claude",
    installed: false,
    change: { path: join(c.home, name), before, after, description: `edit ${name}` },
  });

  it("puts the first file back and drops the backups when the second write fails", async () => {
    const c = await make();
    const a = plan(c, ".claude.json", '{"a":1}', '{"a":2}');
    const b = plan(c, "settings.json", '{"b":1}', '{"b":2}');
    await writeFile(a.change.path, a.change.before ?? "");
    await writeFile(b.change.path, b.change.before ?? "");
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: async (from, to) => {
        if (to === b.change.path) throw eperm(from);
        return realIo.rename(from, to);
      },
    };
    const err = await applyChanges(c, [a, b], { io }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplyError);
    expect((err as ApplyError).rolledBack).toBe(true);
    expect(((err as ApplyError).cause as NodeJS.ErrnoException).code).toBe("EPERM");
    expect(await readFile(a.change.path, "utf8")).toBe('{"a":1}');
    expect(await readFile(b.change.path, "utf8")).toBe('{"b":1}');
    expect(existsSync((err as ApplyError).backupDir)).toBe(false);
    expect((await readdir(c.home)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("removes a file it created when a later write fails", async () => {
    const c = await make();
    const a = plan(c, "new.json", null, "{}");
    const b = plan(c, "settings.json", "1", "2");
    await writeFile(b.change.path, "1");
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: async (from, to) => {
        if (to === b.change.path) throw eperm(from);
        return realIo.rename(from, to);
      },
    };
    await expect(applyChanges(c, [a, b], { io })).rejects.toBeInstanceOf(ApplyError);
    expect(existsSync(a.change.path)).toBe(false);
  });

  it("keeps the backups and names the files it could not restore", async () => {
    const c = await make();
    const a = plan(c, ".claude.json", "1", "2");
    const b = plan(c, "settings.json", "1", "2");
    await writeFile(a.change.path, "1");
    await writeFile(b.change.path, "1");
    let writes = 0;
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: async (from, to) => {
        writes++;
        // First write works, the second fails, and so does the restore of the first.
        if (writes === 1) return realIo.rename(from, to);
        throw eperm(from);
      },
    };
    const err = (await applyChanges(c, [a, b], { io }).catch((e: unknown) => e)) as ApplyError;
    expect(err.rolledBack).toBe(false);
    expect(err.notRestored).toEqual([a.change.path]);
    expect(existsSync(err.backupDir)).toBe(true);
    expect(
      await readFile(join(err.backupDir, "files", a.change.path.replace(/^[/\\]+/, "")), "utf8"),
    ).toBe("1");
  });

  it("restores earlier files and reports nothing changed when a file went stale", async () => {
    const c = await make();
    const a = plan(c, ".claude.json", "1", "2");
    const b = plan(c, "settings.json", "1", "2");
    await writeFile(a.change.path, "1");
    await writeFile(b.change.path, "1");
    const io: WriteIo = {
      ...realIo,
      platform: "linux",
      rename: async (from, to) => {
        await realIo.rename(from, to);
        // Someone edits the second file right after the first write lands.
        if (to === a.change.path) await writeFile(b.change.path, "edited");
      },
    };
    const err = (await applyChanges(c, [a, b], { io }).catch((e: unknown) => e)) as StaleError;
    expect(err).toBeInstanceOf(StaleError);
    expect(err.rolledBack).toBe(true);
    expect(await readFile(a.change.path, "utf8")).toBe("1");
    expect(await readFile(b.change.path, "utf8")).toBe("edited");
  });
});
