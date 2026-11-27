import { parseArgs } from "node:util";
import type { Ctx } from "./ctx.js";
import { closest, cmd, fail } from "./fmt.js";

export interface FlagSpec {
  type: "boolean" | "string";
  short?: string;
  /** Shown in help, e.g. `<list>`. */
  value?: string;
  help: string;
}

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
  flags: Record<string, FlagSpec>;
  /** Extra lines under the options in `conveno <command> --help`. */
  notes?: string[];
  /** Positional arguments are allowed (daemon, hook). */
  positionals?: boolean;
}

const YES: FlagSpec = { type: "boolean", short: "y", help: "Apply without asking" };

export const COMMANDS: CommandSpec[] = [
  {
    name: "init",
    usage: "conveno init [--yes] [--dry-run] [--cli <list>]",
    summary: "Set up Claude Code, Codex and OpenCode",
    flags: {
      yes: YES,
      "dry-run": { type: "boolean", help: "Show the changes and write nothing" },
      cli: {
        type: "string",
        value: "<list>",
        help: "Only these CLIs, comma separated, such as claude,codex",
      },
    },
    notes: [
      "init shows every file it will change, with a diff, and asks first.",
      "Without a terminal it needs --yes, and exits 2 without it.",
    ],
  },
  {
    name: "uninstall",
    usage: "conveno uninstall [--yes]",
    summary: "Undo what init changed",
    flags: { yes: { type: "boolean", short: "y", help: "Restore without asking" } },
    notes: [
      "Files that still match what init wrote are restored byte for byte.",
      "Files you or the CLI edited since lose only Conveno's own entries.",
    ],
  },
  {
    name: "status",
    usage: "conveno status",
    summary: "List sessions by repo",
    flags: {},
  },
  {
    name: "doctor",
    usage: "conveno doctor",
    summary: "Check each CLI and the daemon",
    flags: {},
  },
  {
    name: "daemon",
    usage: "conveno daemon start|stop|status",
    summary: "Manage the background daemon",
    flags: {},
    positionals: true,
  },
  {
    name: "mcp",
    usage: "conveno mcp --cli <cli>",
    summary: "MCP server on stdio (CLIs launch this)",
    flags: { cli: { type: "string", value: "<cli>", help: "claude, codex or opencode" } },
  },
  {
    name: "hook",
    usage: "conveno hook <cli> <event>",
    summary: "Hook entry (CLIs launch this)",
    flags: {},
    positionals: true,
  },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/** `conveno <command> --help`. */
export function commandHelp(ctx: Ctx, spec: CommandSpec): string {
  const t = ctx.theme;
  const lines = [spec.summary, "", `Usage: ${spec.usage}`];
  const flags = Object.entries(spec.flags);
  if (flags.length > 0) {
    lines.push("", "Options:");
    const rows = flags.map(([name, f]) => {
      const left = `${f.short ? `-${f.short}, ` : ""}--${name}${f.value ? ` ${f.value}` : ""}`;
      return [left, f.help] as const;
    });
    const width = Math.max(...rows.map(([l]) => l.length)) + 2;
    for (const [l, h] of rows) lines.push(`  ${t.bold(l.padEnd(width))}${h}`);
  }
  if (spec.notes?.length) lines.push("", ...spec.notes);
  return `${lines.join("\n")}\n`;
}

export type Parsed = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};

/**
 * Parse a command's arguments. Unknown flags and stray words are usage errors (exit 2) with a
 * "Did you mean" when a known flag is within two edits. Returns the exit code on failure.
 */
export function parseFlags(ctx: Ctx, spec: CommandSpec, argv: string[]): Parsed | number {
  const options: Record<string, { type: "boolean" | "string"; short?: string }> = {};
  for (const [name, f] of Object.entries(spec.flags)) {
    options[name] = { type: f.type, ...(f.short ? { short: f.short } : {}) };
  }
  try {
    const r = parseArgs({
      args: argv,
      options,
      allowPositionals: spec.positionals === true,
      strict: true,
    });
    return { values: r.values as Parsed["values"], positionals: r.positionals };
  } catch (e) {
    const t = ctx.theme;
    const code = (e as NodeJS.ErrnoException).code;
    const message = e instanceof Error ? e.message : "";
    const unknown = /Unknown option '(-{1,2}[^']+)'/.exec(message)?.[1];
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && unknown) {
      const suggestion = closest(unknown.replace(/^-+/, ""), Object.keys(spec.flags));
      return fail(ctx, {
        what: `Unknown option ${unknown} for conveno ${spec.name}`,
        fix: `Run ${cmd(t, `conveno ${spec.name} --help`)} to see the options.`,
        ...(suggestion ? { didYouMean: `Did you mean --${suggestion}?` } : {}),
        exit: 2,
        ref: "e_usage",
      });
    }
    if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      return fail(ctx, {
        what: `A conveno ${spec.name} option is missing its value`,
        detail: [message.split("\n")[0] ?? message],
        fix: `Run ${cmd(t, `conveno ${spec.name} --help`)} to see the options.`,
        exit: 2,
        ref: "e_usage",
      });
    }
    const stray = /argument '([^']+)'/.exec(message)?.[1];
    return fail(ctx, {
      what: stray
        ? `Unexpected argument "${stray}" for conveno ${spec.name}`
        : `Could not read the arguments for conveno ${spec.name}`,
      fix: `Run ${cmd(t, `conveno ${spec.name} --help`)} to see the options.`,
      exit: 2,
      ref: "e_usage",
    });
  }
}
