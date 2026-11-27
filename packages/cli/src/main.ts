import { CLI_KINDS, type CliKind } from "@conveno/protocol";
import { COMMAND_NAMES, COMMANDS, commandHelp, parseFlags } from "./args.js";
import type { Ctx } from "./ctx.js";
import { runDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import { closest, cmd, fail, plainError } from "./fmt.js";
import { runHook } from "./hook.js";
import { runInit } from "./init.js";
import { runStatus } from "./status.js";
import { runUninstall } from "./uninstall.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Conveno lets AI coding sessions on one machine find each other and exchange messages.";

export function helpText(ctx: Ctx): string {
  const t = ctx.theme;
  const rows = COMMANDS.map((c) => [c.usage.replace(/^conveno /, ""), c.summary] as const);
  const width = Math.max(...rows.map(([u]) => u.length), "--version".length) + 2;
  const row = (c: string, d: string) => `  ${t.bold(c.padEnd(width))}${d}`;
  return [
    DESCRIPTION,
    "",
    "Usage: conveno <command> [options]",
    "",
    ...rows.map(([u, d]) => row(u, d)),
    row("--version", "Print the version"),
    "",
    `Run ${cmd(t, "conveno <command> --help")} for the options of one command.`,
    `conveno ${t.paint("info", VERSION)}`,
    "",
  ].join("\n");
}

async function runMcp(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const spec = COMMANDS.find((c) => c.name === "mcp");
  if (!spec) return 2;
  const parsed = parseFlags(ctx, spec, argv);
  if (typeof parsed === "number") return parsed;
  const cli = typeof parsed.values.cli === "string" ? parsed.values.cli : undefined;
  if (!cli || !(CLI_KINDS as readonly string[]).includes(cli)) {
    return fail(ctx, {
      what: "conveno mcp needs a CLI name",
      detail: [`Got ${cli ? `"${cli}"` : "none"}. Known: ${CLI_KINDS.join(", ")}.`],
      fix: `Run ${cmd(t, "conveno mcp --cli claude")}, or let ${cmd(t, "conveno init")} write the config.`,
      exit: 2,
      ref: "e_usage",
    });
  }
  try {
    await ctx.runMcp({
      cli: cli as CliKind,
      ...(ctx.daemonEntry ? { daemonEntry: ctx.daemonEntry } : {}),
    });
    return 0;
  } catch (e) {
    return fail(ctx, {
      what: "The Conveno MCP server stopped",
      detail: [plainError(e)],
      fix: `Run ${cmd(t, "conveno doctor")} to check the daemon.`,
      exit: 1,
      ref: "e_mcp",
    });
  }
}

async function dispatch(command: string, rest: string[], ctx: Ctx): Promise<number> {
  const spec = COMMANDS.find((c) => c.name === command);
  if (spec && (rest.includes("--help") || rest.includes("-h")) && command !== "hook") {
    ctx.out(commandHelp(ctx, spec));
    return 0;
  }
  switch (command) {
    case "init":
      return runInit(ctx, rest);
    case "uninstall":
      return runUninstall(ctx, rest);
    case "status":
      return runStatus(ctx, rest);
    case "doctor":
      return runDoctor(ctx, rest);
    case "daemon":
      return runDaemon(ctx, rest);
    case "mcp":
      return runMcp(ctx, rest);
    case "hook":
      return runHook(ctx, rest);
    default: {
      const suggestion = closest(command, COMMAND_NAMES);
      return fail(ctx, {
        what: `Unknown command "${command}"`,
        detail: [`conveno ${VERSION} has: ${COMMAND_NAMES.join(", ")}.`],
        fix: `Run ${cmd(ctx.theme, "conveno --help")} to see usage.`,
        ...(suggestion ? { didYouMean: `Did you mean ${suggestion}?` } : {}),
        exit: 2,
        ref: "e_usage",
      });
    }
  }
}

/** Run one command line. Returns the exit code. Never throws. */
export async function main(argv: string[], ctx: Ctx): Promise<number> {
  const [command, ...rest] = argv;
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
      ctx.out(`${VERSION}\n`);
      return 0;
  }
  try {
    return await dispatch(command, rest, ctx);
  } catch (e) {
    return fail(ctx, {
      what: "conveno stopped before it could finish",
      detail: [plainError(e)],
      fix: `Run ${cmd(ctx.theme, "conveno doctor")} to check the install, then try again.`,
      exit: 1,
      ref: "e_internal",
    });
  }
}
