import type { Adapter, ConfigChange, ConfigComponent, Detection } from "@conveno/core";
import { COMMANDS, parseFlags } from "./args.js";
import { adapterEnv, type Ctx, connectOpts } from "./ctx.js";
import { daemonProblem } from "./daemonError.js";
import { cmd, columns, errorBlock, plainError, plural, warnBlock } from "./fmt.js";

/** `ok`: set up. `missing`: not set up. `outdated`: set up by an older Conveno and needs `init`. */
type Part = "ok" | "missing" | "outdated";

interface Row {
  adapter: Adapter;
  detection: Detection;
  mcp: Part | null;
  hooks: Part | null;
  planError?: string;
}

/** What the plan says about one part: nothing to do, an addition, or an update to what is there. */
function partState(changes: ConfigChange[], component: ConfigComponent): Part {
  const mine = changes.filter((c) => c.component === component);
  if (mine.length === 0) return "ok";
  return mine.some((c) => c.kind === "add") ? "missing" : "outdated";
}

/** Time allowed for the one process-table query. */
const ANCESTRY_TIMEOUT_MS = 5_000;

const tierWord = (t: Adapter["deliveryTier"]): string => (t === "next_turn" ? "next turn" : t);

async function inspect(ctx: Ctx, adapter: Adapter): Promise<Row> {
  const env = adapterEnv(ctx);
  let detection: Detection;
  try {
    detection = await adapter.detect(env);
  } catch {
    detection = { installed: false, configPaths: [] };
  }
  if (!detection.installed) return { adapter, detection, mcp: null, hooks: null };
  const hasHooks = adapter.deliveryTier !== "inbox";
  try {
    const changes = await adapter.plan(env);
    return {
      adapter,
      detection,
      mcp: partState(changes, "mcp"),
      hooks: hasHooks ? partState(changes, "hooks") : null,
    };
  } catch (e) {
    return {
      adapter,
      detection,
      mcp: "missing",
      hooks: hasHooks ? "missing" : null,
      planError: plainError(e),
    };
  }
}

export async function runDoctor(ctx: Ctx, argv: string[] = []): Promise<number> {
  const t = ctx.theme;
  const spec = COMMANDS.find((c) => c.name === "doctor");
  if (spec) {
    const parsed = parseFlags(ctx, spec, argv);
    if (typeof parsed === "number") return parsed;
  }
  let ok = 0;
  let warnings = 0;
  let problems = 0;
  const notes: string[] = [];

  // Daemon.
  let daemonLine: string[];
  try {
    const client = await ctx.connect(connectOpts(ctx, false));
    try {
      const { sessions } = await client["session.list"]({ includeOffline: true });
      daemonLine = [`  ${t.status("ok")} daemon`, `running, ${plural(sessions.length, "session")}`];
      ok++;
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch (e) {
    const problem = daemonProblem(t, e);
    if (problem.notRunning) {
      daemonLine = [`  ${t.status("warn")} daemon`, "not running"];
      warnings++;
      notes.push(warnBlock(t, "The Conveno daemon is not running.", problem.fix, problem.why));
    } else {
      daemonLine = [`  ${t.status("error")} daemon`, "cannot be reached"];
      problems++;
      notes.push(
        errorBlock(t, {
          what: "The Conveno daemon cannot be reached",
          detail: [problem.why],
          fix: problem.fix,
          exit: 1,
          ref: "e_daemon",
        }),
      );
    }
  }
  ctx.out(`${columns([daemonLine]).join("\n")}\n\n`);

  // Process ancestry: hooks use it to find their session. It is quiet when it works.
  if (!(await ctx.ancestry(ANCESTRY_TIMEOUT_MS)).complete) {
    warnings++;
    notes.push(
      warnBlock(
        t,
        "Process ancestry is unavailable.",
        `Run ${cmd(t, "conveno doctor")} from a normal desktop session, or allow this user to read the process list. Messages still reach the inbox tool either way.`,
        ctx.platform === "win32"
          ? "Windows refused the process list (WMI denies it to non-admin remote logons such as SSH). A hook can then only match a session whose CLI is its direct parent, so next-turn delivery can miss sessions started through a launcher such as conveno.cmd."
          : "The process list could not be read. A hook can then only match a session whose CLI is its direct parent, so next-turn delivery can miss sessions started through a launcher or a shell.",
      ),
    );
  }

  // CLIs.
  const rows = await Promise.all(ctx.adapters.map((a) => inspect(ctx, a)));
  const q = (w: string) => t.paint("quiet", w);
  const table: string[][] = [
    [`    ${q("CLI")}`, q("NAME"), q("VERSION"), q("MCP"), q("HOOKS"), q("TIER"), q("NOTE")],
  ];
  const yesNo = (v: Part | null): string =>
    v === null
      ? q("n/a")
      : v === "ok"
        ? "yes"
        : t.paint("warn", v === "missing" ? "not configured" : "needs update");
  for (const r of rows) {
    const { adapter, detection } = r;
    if (!detection.installed) {
      table.push([
        `  ${t.glyph("offline")} ${adapter.cli}`,
        adapter.displayName,
        "",
        "",
        "",
        "",
        q("not found on PATH"),
      ]);
      continue;
    }
    const good = r.mcp === "ok" && (r.hooks === null || r.hooks === "ok") && !r.planError;
    let note =
      adapter.deliveryTier === "next_turn"
        ? "delivered at the next prompt"
        : "read through the inbox tool";
    if (!good) {
      note = r.planError
        ? "config could not be read"
        : r.mcp === "outdated" || r.hooks === "outdated"
          ? "needs an update"
          : "not fully configured";
    }
    table.push([
      `  ${good ? t.status("ok") : t.status("warn")} ${adapter.cli}`,
      adapter.displayName,
      detection.version ?? "",
      yesNo(r.mcp),
      yesNo(r.hooks),
      tierWord(adapter.deliveryTier),
      q(note),
    ]);
    if (r.planError) {
      problems++;
      notes.push(
        errorBlock(t, {
          what: `${adapter.displayName} config could not be read`,
          detail: [r.planError],
          fix: "Repair the file named above, then run conveno doctor again.",
          exit: 1,
          ref: "e_config",
        }),
      );
    } else if (good) {
      ok++;
    } else {
      warnings++;
      const named = [
        ["the MCP server", r.mcp],
        ["the hooks", r.hooks],
      ] as const;
      const list = (state: Part) =>
        named
          .filter(([, s]) => s === state)
          .map(([n]) => n)
          .join(" and ");
      const missing = list("missing");
      const outdated = list("outdated");
      const fix = `Run ${cmd(t, "conveno init")}, then restart open ${adapter.displayName} sessions.`;
      // init shows its diff first, and for an outdated part the diff is only the lines that changed.
      notes.push(
        missing && outdated
          ? warnBlock(
              t,
              `${adapter.displayName} is missing ${missing} and needs an update to ${outdated}.`,
              fix,
            )
          : missing
            ? warnBlock(t, `${adapter.displayName} is missing ${missing}.`, fix)
            : warnBlock(
                t,
                `${adapter.displayName} needs an update.`,
                fix,
                `Conveno's setup for ${outdated} is from an older version. ${cmd(t, "conveno init")} shows exactly which lines change.`,
              ),
      );
    }
  }
  ctx.out(`${columns(table).join("\n")}\n`);
  if (!rows.some((r) => r.detection.installed)) {
    notes.push(
      warnBlock(
        t,
        "No supported AI coding CLI was found on PATH.",
        "Install Claude Code, Codex CLI or OpenCode, then run conveno init.",
      ),
    );
    warnings++;
  }

  for (const n of notes) ctx.err(`\n${n.trimEnd()}\n`);
  ctx.out(`\n${ok} ok, ${plural(warnings, "warning")}, ${plural(problems, "problem")}\n`);
  return problems > 0 ? 1 : 0;
}
