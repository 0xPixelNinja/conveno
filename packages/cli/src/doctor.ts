import type { Adapter, Detection } from "@0xpixelninja/conveno-core";
import { adapterEnv, type Ctx, connectOpts } from "./ctx.js";
import { cmd, columns, errorBlock, plural, warnBlock } from "./fmt.js";

interface Row {
  adapter: Adapter;
  detection: Detection;
  mcp: boolean | null;
  hooks: boolean | null;
  planError?: string;
}

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
    const text = changes.map((c) => c.description);
    const hooksMissing = text.some((d) => /hook/i.test(d));
    const mcpMissing = text.some((d) => /mcp/i.test(d)) || (changes.length > 0 && !hooksMissing);
    return { adapter, detection, mcp: !mcpMissing, hooks: hasHooks ? !hooksMissing : null };
  } catch (e) {
    return {
      adapter,
      detection,
      mcp: false,
      hooks: hasHooks ? false : null,
      planError: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runDoctor(ctx: Ctx): Promise<number> {
  const t = ctx.theme;
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
    daemonLine = [`  ${t.status("warn")} daemon`, "not running"];
    warnings++;
    notes.push(
      warnBlock(
        t,
        "The Conveno daemon is not running.",
        `Run ${cmd(t, "conveno daemon start")}. It also starts when a CLI opens the Conveno MCP server.`,
        e instanceof Error ? e.message : undefined,
      ),
    );
  }
  ctx.out(`${columns([daemonLine]).join("\n")}\n\n`);

  // CLIs.
  const rows = await Promise.all(ctx.adapters.map((a) => inspect(ctx, a)));
  const q = (w: string) => t.paint("quiet", w);
  const table: string[][] = [
    [`    ${q("CLI")}`, q("NAME"), q("VERSION"), q("MCP"), q("HOOKS"), q("TIER"), q("NOTE")],
  ];
  const yesNo = (v: boolean | null): string => (v === null ? q("n/a") : v ? "yes" : "no");
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
    const good = r.mcp === true && r.hooks !== false && !r.planError;
    let note =
      adapter.deliveryTier === "next_turn"
        ? "delivered at the next prompt"
        : "read through the inbox tool";
    if (!good) note = r.planError ? "config could not be read" : "not fully configured";
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
        errorBlock(
          t,
          `${adapter.displayName} config could not be read`,
          [r.planError],
          "Repair the file named above, then run conveno doctor again.",
        ),
      );
    } else if (good) {
      ok++;
    } else {
      warnings++;
      const missing = [
        r.mcp === false ? "the MCP server" : "",
        r.hooks === false ? "the hooks" : "",
      ]
        .filter(Boolean)
        .join(" and ");
      notes.push(
        warnBlock(
          t,
          `${adapter.displayName} is missing ${missing}.`,
          `Run ${cmd(t, "conveno init")}, then restart open ${adapter.displayName} sessions.`,
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
