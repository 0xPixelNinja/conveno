import { type Adapter, type Detection, dataPaths } from "@0xpixelninja/conveno-core";
import { CLI_KINDS, type CliKind } from "@0xpixelninja/conveno-protocol";
import {
  type Applied,
  ApplyError,
  applyChanges,
  type PlannedChange,
  presentChanges,
  StaleError,
} from "./apply.js";
import { COMMANDS, parseFlags } from "./args.js";
import { adapterEnv, type Ctx } from "./ctx.js";
import { closest, cmd, columns, fail, plainError, plural, seconds, tilde } from "./fmt.js";

export const CODEX_NOTE = "Codex asks you to trust new hooks once: run /hooks inside Codex.";

export interface Found {
  adapter: Adapter;
  detection: Detection;
}

/** Detect every adapter. A detection that throws counts as not installed. */
export async function detectAll(ctx: Ctx, adapters: Adapter[] = ctx.adapters): Promise<Found[]> {
  const env = adapterEnv(ctx);
  return Promise.all(
    adapters.map(async (adapter) => {
      try {
        return { adapter, detection: await adapter.detect(env) };
      } catch {
        return { adapter, detection: { installed: false, configPaths: [] } as Detection };
      }
    }),
  );
}

export function parseCliList(
  raw: string | undefined,
  ctx: Ctx,
): Adapter[] | { message: string; suggestion?: string } {
  if (raw === undefined) return ctx.adapters;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Adapter[] = [];
  for (const n of names) {
    if (!(CLI_KINDS as readonly string[]).includes(n)) {
      const suggestion = closest(
        n,
        ctx.adapters.map((a) => a.cli),
      );
      return {
        message: `Unknown CLI "${n}". Known CLIs: ${ctx.adapters.map((a) => a.cli).join(", ")}.`,
        ...(suggestion ? { suggestion: `Did you mean ${suggestion}?` } : {}),
      };
    }
    const a = ctx.adapters.find((x) => x.cli === n);
    if (!a) {
      return {
        message: `"${n}" is not supported in this version. Supported: ${ctx.adapters.map((x) => x.cli).join(", ")}.`,
      };
    }
    out.push(a);
  }
  return out;
}

function printDetections(ctx: Ctx, found: Found[]): void {
  const t = ctx.theme;
  ctx.out(`${t.bold("Looking for AI coding CLIs on this machine")}\n`);
  const rows = found.map(({ adapter, detection }) =>
    detection.installed
      ? [
          `  ${t.status("ok")} ${adapter.cli}`,
          adapter.displayName,
          detection.version ?? "",
          t.paint("quiet", tilde(detection.configPaths[0] ?? "", ctx.home)),
        ]
      : [`  ${t.glyph("offline")} ${adapter.cli}`, t.paint("quiet", "not found")],
  );
  ctx.out(`${columns(rows).join("\n")}\n\n`);
}

/** Collect plans from installed adapters. Returns failures instead of throwing. */
export async function collectPlans(
  ctx: Ctx,
  found: Found[],
  which: "plan" | "uninstallPlan",
): Promise<{ items: PlannedChange[]; failures: { cli: CliKind; message: string }[] }> {
  const env = adapterEnv(ctx);
  const items: PlannedChange[] = [];
  const failures: { cli: CliKind; message: string }[] = [];
  for (const { adapter, detection } of found) {
    try {
      for (const change of await adapter[which](env)) {
        items.push({ cli: adapter.cli, installed: detection.installed, change });
      }
    } catch (e) {
      failures.push({ cli: adapter.cli, message: plainError(e) });
    }
  }
  return { items, failures };
}

export function reportFailures(
  ctx: Ctx,
  failures: { cli: CliKind; message: string }[],
  retry: string,
): void {
  for (const f of failures) {
    fail(ctx, {
      what: `Could not plan changes for ${f.cli}`,
      detail: [f.message],
      fix: `Fix the problem above, or run ${cmd(ctx.theme, retry)} to leave ${f.cli} out.`,
      exit: 1,
      ref: "e_plan",
    });
  }
}

export const staleFailure = (ctx: Ctx, e: StaleError, rerun: string): number =>
  fail(ctx, {
    what: `${tilde(e.path, ctx.home)} changed while Conveno was waiting`,
    detail: [
      e.rolledBack
        ? "Conveno did not overwrite it. Nothing was left changed."
        : "Conveno did not overwrite it. Some other files may already be changed.",
    ],
    fix: `Run ${cmd(ctx.theme, rerun)} again to plan from the file as it is now.`,
    exit: 1,
    ref: "e_stale",
  });

/** Show the plan, confirm, back up, apply. Shared by init and the plan-based uninstall. */
export async function confirmAndApply(
  ctx: Ctx,
  items: PlannedChange[],
  opts: { yes: boolean; verb: string; rerun: string; markRestored?: boolean },
): Promise<{ applied: Applied } | { exit: number }> {
  const t = ctx.theme;
  const files = new Set(items.map((i) => i.change.path)).size;
  ctx.out(
    `${t.bold(`Conveno will change ${plural(files, "file")}.`)} Nothing else is touched.\n\n`,
  );
  presentChanges(ctx, items);
  const paths = dataPaths(ctx.platform, ctx.dataDir);
  ctx.out(
    `  ${t.paint("quiet", `Backups go to ${tilde(paths.backups, ctx.home)}/<timestamp>/`)}\n`,
  );
  ctx.out(`  ${t.paint("quiet", "Undo any time with:")} ${cmd(t, "conveno uninstall")}\n\n`);

  if (!opts.yes) {
    if (!ctx.interactive) {
      return {
        exit: fail(ctx, {
          what: "Needs a terminal to confirm",
          detail: ["No changes were made."],
          fix: `Run ${cmd(t, `${opts.rerun} --yes`)} to apply the changes shown above.`,
          exit: 2,
          ref: "e_no_tty",
        }),
      };
    }
    if (!(await ctx.confirm(`${opts.verb} these changes?`, true))) {
      ctx.out(`${t.status("info")} Nothing was changed.\n`);
      return { exit: 0 };
    }
  }

  try {
    return {
      applied: await applyChanges(ctx, items, opts.markRestored ? { markRestored: true } : {}),
    };
  } catch (e) {
    if (e instanceof StaleError) return { exit: staleFailure(ctx, e, opts.rerun) };
    if (e instanceof ApplyError && !e.rolledBack) {
      return {
        exit: fail(ctx, {
          what: "Could not write the changes",
          detail: [
            plainError(e.cause ?? e),
            `These files could not be put back and may be changed: ${e.notRestored.map((p) => tilde(p, ctx.home)).join(", ")}.`,
          ],
          fix: `The originals are in ${tilde(e.backupDir, ctx.home)}. Copy them back, then fix the problem and run again.`,
          exit: 1,
          ref: "e_write",
        }),
      };
    }
    return {
      exit: fail(ctx, {
        what: "Could not write the changes",
        detail: [
          plainError(e instanceof ApplyError ? (e.cause ?? e) : e),
          "Files already written in this run were restored. Nothing was left changed.",
        ],
        fix: "Close the program that has the file open (a running Claude Code, an editor), then run again.",
        exit: 1,
        ref: "e_write",
      }),
    };
  }
}

export async function runInit(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const started = ctx.now();
  const spec = COMMANDS.find((c) => c.name === "init");
  if (!spec) return 2;
  const parsed = parseFlags(ctx, spec, argv);
  if (typeof parsed === "number") return parsed;
  const values = parsed.values;
  const chosen = parseCliList(typeof values.cli === "string" ? values.cli : undefined, ctx);
  if (!Array.isArray(chosen)) {
    return fail(ctx, {
      what: chosen.message,
      fix: `Pass ${cmd(t, "--cli claude,codex,opencode")} or leave it out.`,
      ...(chosen.suggestion ? { didYouMean: chosen.suggestion } : {}),
      exit: 2,
      ref: "e_usage",
    });
  }

  const found = await detectAll(ctx, chosen);
  printDetections(ctx, found);
  const installed = found.filter((f) => f.detection.installed);
  if (installed.length === 0) {
    return fail(ctx, {
      what: "No supported AI coding CLI was found",
      detail: [`Looked for ${chosen.map((a) => a.displayName).join(", ")} on PATH.`],
      fix: "Install one of them, then run conveno init again.",
      exit: 1,
      ref: "e_no_cli",
    });
  }

  const { items, failures } = await collectPlans(ctx, installed, "plan");
  if (failures.length > 0) {
    reportFailures(ctx, failures, "conveno init --cli <others>");
    return 1;
  }
  if (items.length === 0) {
    ctx.out(
      `${t.status("ok")} Conveno is already set up for ${installed.map((f) => f.adapter.cli).join(", ")}. Nothing to change.\n`,
    );
    return 0;
  }

  if (values["dry-run"]) {
    const files = new Set(items.map((i) => i.change.path)).size;
    ctx.out(
      `${t.bold(`Conveno would change ${plural(files, "file")}.`)} Nothing else is touched.\n\n`,
    );
    presentChanges(ctx, items);
    ctx.out(
      `${t.status("info")} Dry run: nothing was written. Run ${cmd(t, "conveno init")} to apply.\n`,
    );
    return 0;
  }

  const result = await confirmAndApply(ctx, items, {
    yes: values.yes === true,
    verb: "Apply",
    rerun: "conveno init",
  });
  if ("exit" in result) return result.exit;

  const byCli = new Map<CliKind, string[]>();
  for (const h of result.applied.how) {
    byCli.set(h.cli, [...(byCli.get(h.cli) ?? []), h.via]);
  }
  const rows = [...byCli].map(([cli, vias]) => [
    `  ${t.status("ok")} ${cli}`,
    vias.every((v) => v === "command") ? "configured with the CLI's own command" : "configured",
  ]);
  ctx.out(`${columns(rows).join("\n")}\n\n`);
  ctx.out(`${t.status("ok")} ${t.bold("Done.")} ${seconds(started, ctx.now())}\n`);
  ctx.out(`  Backups are in ${tilde(result.applied.backupDir, ctx.home)}.\n`);
  ctx.out("  Restart open sessions so they pick up Conveno.\n");
  if (byCli.has("codex")) ctx.out(`${t.status("info")} ${CODEX_NOTE}\n`);
  ctx.out(`  Next: ${cmd(t, "conveno status")} lists your sessions.\n`);
  return 0;
}
