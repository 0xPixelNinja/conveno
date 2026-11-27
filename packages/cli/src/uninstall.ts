import type { CliKind } from "@conveno/protocol";
import {
  applyChanges,
  type EntryAction,
  listManifests,
  type Manifest,
  type ManifestEntry,
  markRestored,
  type PlannedChange,
  previewRestore,
  restoreEntry,
  StaleError,
} from "./apply.js";
import { COMMANDS, parseFlags } from "./args.js";
import type { Ctx } from "./ctx.js";
import { cmd, columns, fail, localStamp, plainError, plural, seconds, tilde } from "./fmt.js";
import { collectPlans, confirmAndApply, detectAll, reportFailures, staleFailure } from "./init.js";

const NOTE: Record<EntryAction, string> = {
  restore: "restored byte for byte",
  remove: "removed, it did not exist before",
  edit: "edited since init, so only Conveno's entries are removed",
  gone: "already gone, left as it is",
};

type Found = { dir: string; manifest: Manifest };

/** Remove Conveno's own entries from files that changed since init, through each adapter. */
async function removeOwnEntries(
  ctx: Ctx,
  entries: ManifestEntry[],
): Promise<{ edited: string[]; failures: { cli: CliKind; message: string }[] }> {
  if (entries.length === 0) return { edited: [], failures: [] };
  const clis = new Set(entries.map((e) => e.cli));
  const found = (await detectAll(ctx)).filter((f) => clis.has(f.adapter.cli));
  const { items, failures } = await collectPlans(ctx, found, "uninstallPlan");
  const wanted = new Set(entries.map((e) => e.path));
  const mine: PlannedChange[] = items.filter((i) => wanted.has(i.change.path));
  if (mine.length > 0) await applyChanges(ctx, mine, { markRestored: true });
  return { edited: mine.map((i) => i.change.path), failures };
}

async function restoreAll(
  ctx: Ctx,
  manifests: Found[],
): Promise<{ restored: string[]; edited: string[]; untouched: string[] }> {
  const restored: string[] = [];
  const edited: string[] = [];
  const untouched: string[] = [];
  for (const found of manifests) {
    const needEdit: ManifestEntry[] = [];
    for (const entry of found.manifest.entries) {
      const action = await restoreEntry(found.dir, entry);
      if (action === "edit") needEdit.push(entry);
      else if (action === "gone") untouched.push(entry.path);
      else restored.push(entry.path);
    }
    const r = await removeOwnEntries(ctx, needEdit);
    if (r.failures.length > 0) {
      reportFailures(ctx, r.failures, "conveno uninstall");
      throw new Error("A config file could not be read, so it was left as it is.");
    }
    edited.push(...r.edited);
    for (const e of needEdit) if (!r.edited.includes(e.path)) untouched.push(e.path);
    await markRestored(ctx, found);
  }
  return { restored, edited, untouched };
}

export async function runUninstall(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const started = ctx.now();
  const spec = COMMANDS.find((c) => c.name === "uninstall");
  if (!spec) return 2;
  const parsed = parseFlags(ctx, spec, argv);
  if (typeof parsed === "number") return parsed;
  const yes = parsed.values.yes === true;

  const manifests = await listManifests(ctx).catch(() => [] as Found[]);
  if (manifests.length > 0) {
    const rows = await previewRestore(manifests);
    const made = manifests.map((m) => localStamp(m.manifest.createdAt));
    ctx.out(
      `${t.bold(`Conveno will undo ${plural(manifests.length, "install")}`)}, made ${made.join(", ")} (local time).\n\n`,
    );
    ctx.out(
      `${columns(rows.map((r) => [`  ${tilde(r.entry.path, ctx.home)}`, t.paint("quiet", NOTE[r.action])])).join("\n")}\n\n`,
    );
    if (!yes) {
      if (!ctx.interactive) {
        return fail(ctx, {
          what: "Needs a terminal to confirm",
          detail: ["No files were changed."],
          fix: `Run ${cmd(t, "conveno uninstall --yes")} to undo the changes listed above.`,
          exit: 2,
          ref: "e_no_tty",
        });
      }
      if (!(await ctx.confirm("Undo these changes?", false))) {
        ctx.out(`${t.status("info")} Nothing was changed.\n`);
        return 0;
      }
    }
    let result: Awaited<ReturnType<typeof restoreAll>>;
    try {
      result = await restoreAll(ctx, manifests);
    } catch (e) {
      if (e instanceof StaleError) return staleFailure(ctx, e, "conveno uninstall");
      return fail(ctx, {
        what: "Could not restore a file",
        detail: [
          plainError(e),
          `The backups are still in ${tilde(manifests[0]?.dir ?? ctx.dataDir, ctx.home)} and the other backup folders next to it.`,
        ],
        fix: "Fix the problem above, then run conveno uninstall again.",
        exit: 1,
        ref: "e_restore",
      });
    }
    ctx.out(`${t.status("ok")} ${t.bold("Done.")} ${seconds(started, ctx.now())}\n`);
    ctx.out(`  Restored ${plural(result.restored.length, "file")} to how init found them.\n`);
    if (result.edited.length > 0) {
      ctx.out(
        `  Edited, not restored, because they changed since init: ${result.edited.map((p) => tilde(p, ctx.home)).join(", ")}. Only Conveno's entries were removed.\n`,
      );
    }
    ctx.out("  Restart open sessions to drop Conveno.\n");
    return 0;
  }

  // No backup on record: ask each adapter what it would remove.
  const found = await detectAll(ctx);
  const { items, failures } = await collectPlans(ctx, found, "uninstallPlan");
  if (failures.length > 0) {
    reportFailures(ctx, failures, "conveno uninstall");
    return 1;
  }
  if (items.length === 0) {
    ctx.out(
      `${t.status("ok")} Nothing to remove. No Conveno entries were found in any supported CLI.\n`,
    );
    return 0;
  }
  ctx.out(
    `${t.status("info")} No install backup found, so Conveno will remove only its own entries.\n\n`,
  );
  const result = await confirmAndApply(ctx, items, {
    yes,
    verb: "Remove",
    rerun: "conveno uninstall",
    markRestored: true,
  });
  if ("exit" in result) return result.exit;
  ctx.out(`${t.status("ok")} ${t.bold("Done.")} ${seconds(started, ctx.now())}\n`);
  ctx.out("  Removed the Conveno entries. Restart open sessions to drop Conveno.\n");
  return 0;
}
