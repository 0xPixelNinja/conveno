import { parseArgs } from "node:util";
import { findLatestManifest, restoreManifest } from "./apply.js";
import type { Ctx } from "./ctx.js";
import { cmd, columns, errorBlock, plural, tilde } from "./fmt.js";
import { collectPlans, confirmAndApply, detectAll, reportFailures } from "./init.js";

export async function runUninstall(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  let yes = false;
  try {
    yes =
      parseArgs({
        args: argv,
        options: { yes: { type: "boolean", short: "y" } },
        allowPositionals: false,
      }).values.yes === true;
  } catch (e) {
    ctx.err(
      errorBlock(
        t,
        "Could not read the arguments for conveno uninstall",
        [e instanceof Error ? e.message : String(e)],
        `Run ${cmd(t, "conveno --help")} to see the options.`,
      ),
    );
    return 2;
  }

  const latest = await findLatestManifest(ctx).catch(() => null);
  if (latest) {
    const { manifest, dir } = latest;
    ctx.out(
      `${t.bold(`Conveno will restore ${plural(manifest.entries.length, "file")}`)} from the backup made ${manifest.createdAt}.\n\n`,
    );
    const rows = manifest.entries.map((e) => [
      `  ${tilde(e.path, ctx.home)}`,
      t.paint(
        "quiet",
        e.backup === null ? "removed, it did not exist before" : "restored byte for byte",
      ),
    ]);
    ctx.out(`${columns(rows).join("\n")}\n\n`);
    if (!yes) {
      if (!ctx.interactive) {
        ctx.err(
          errorBlock(
            t,
            "Needs a terminal to confirm",
            ["No files were changed."],
            `Run ${cmd(t, "conveno uninstall --yes")} to restore the files listed above.`,
          ),
        );
        return 1;
      }
      if (!(await ctx.confirm("Restore these files?", false))) {
        ctx.out(`${t.status("info")} Nothing was changed.\n`);
        return 0;
      }
    }
    try {
      await restoreManifest(ctx, latest);
    } catch (e) {
      ctx.err(
        errorBlock(
          t,
          "Could not restore a file",
          [
            e instanceof Error ? e.message : String(e),
            `The backup is still in ${tilde(dir, ctx.home)}.`,
          ],
          "Fix the problem above, then run conveno uninstall again.",
        ),
      );
      return 1;
    }
    ctx.out(
      `${t.status("ok")} ${t.bold("Done.")} Restored ${plural(manifest.entries.length, "file")}. Restart open sessions to drop Conveno.\n`,
    );
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
  });
  if ("exit" in result) return result.exit;
  ctx.out(
    `${t.status("ok")} ${t.bold("Done.")} Removed the Conveno entries. Restart open sessions to drop Conveno.\n`,
  );
  return 0;
}
