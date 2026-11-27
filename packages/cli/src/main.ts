import { parseArgs } from "node:util";
import { CLI_KINDS, type CliKind } from "@0xpixelninja/conveno-protocol";
import { versionLine } from "./banner.js";
import type { Ctx } from "./ctx.js";
import { runDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { cmd, errorBlock } from "./fmt.js";
import { runHook } from "./hook.js";
import { runInit } from "./init.js";
import { runStatus } from "./status.js";
import { runUninstall } from "./uninstall.js";
import { VERSION } from "./version.js";

export function helpText(ctx: Ctx): string {
  const t = ctx.theme;
  const row = (c: string, d: string) => `  ${t.bold(c.padEnd(26))}${d}`;
  return [
    `${versionLine(t)}`,
    "",
    "Usage: conveno <command> [options]",
    "",
    row("init [--yes] [--dry-run]", "Set up Claude Code, Codex and OpenCode"),
    row("  [--cli list]", "Limit init to some CLIs"),
    row("uninstall [--yes]", "Undo what init changed"),
    row("status", "List sessions by repo"),
    row("doctor", "Check each CLI and the daemon"),
    row("daemon start|stop|status", "Manage the background daemon"),
    row("mcp --cli <cli>", "MCP server on stdio (CLIs launch this)"),
    row("hook <cli> <event>", "Hook entry (CLIs launch this)"),
    row("--version", "Print the version"),
    "",
    `--cli takes a comma-separated list such as claude,codex.`,
    "",
  ].join("\n");
}

async function runMcp(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  let cli: string | undefined;
  try {
    cli = parseArgs({ args: argv, options: { cli: { type: "string" } }, allowPositionals: false })
      .values.cli;
  } catch (e) {
    cli = undefined;
    void e;
  }
  if (!cli || !(CLI_KINDS as readonly string[]).includes(cli)) {
    ctx.err(
      errorBlock(
        t,
        "conveno mcp needs a CLI name",
        [`Got ${cli ? `"${cli}"` : "none"}. Known: ${CLI_KINDS.join(", ")}.`],
        `Run ${cmd(t, "conveno mcp --cli claude")}, or let ${cmd(t, "conveno init")} write the config.`,
      ),
    );
    return 2;
  }
  try {
    await ctx.runMcp({
      cli: cli as CliKind,
      ...(ctx.daemonEntry ? { daemonEntry: ctx.daemonEntry } : {}),
    });
    return 0;
  } catch (e) {
    ctx.err(
      errorBlock(
        t,
        "The Conveno MCP server stopped",
        [e instanceof Error ? e.message : String(e)],
        `Run ${cmd(t, "conveno doctor")} to check the daemon.`,
      ),
    );
    return 1;
  }
}

/** Run one command line. Returns the exit code. */
export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const [command, ...rest] = argv;
  const t = ctx.theme;
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      ctx.out(helpText(ctx));
      return 0;
    case "--version":
    case "-v":
    case "version":
      ctx.out(`${versionLine(t)}\n`);
      return 0;
    case "init":
      return runInit(ctx, rest);
    case "uninstall":
      return runUninstall(ctx, rest);
    case "status":
      return runStatus(ctx);
    case "doctor":
      return runDoctor(ctx);
    case "daemon":
      return runDaemon(ctx, rest);
    case "mcp":
      return runMcp(ctx, rest);
    case "hook":
      return runHook(ctx, rest);
    default:
      ctx.err(
        errorBlock(
          t,
          `Unknown command "${command}"`,
          [`conveno ${VERSION} has: init, uninstall, status, doctor, daemon, mcp, hook.`],
          `Run ${cmd(t, "conveno --help")} to see usage.`,
        ),
      );
      return 2;
  }
}
