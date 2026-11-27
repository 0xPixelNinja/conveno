import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Adapter,
  type AdapterEnv,
  type ConfigChange,
  type Detection,
  formatHookContext,
  type HookContext,
  type HookOutput,
} from "@conveno/core";
import {
  APPROVAL_MODE,
  addServer,
  ConfigParseError,
  matchesSpec,
  parseToml,
  removeServer,
  SERVER_NAME,
  serverOf,
} from "./toml.js";

export const PACKAGE_NAME = "@conveno/adapter-codex";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
/** Seconds. The hook gives up after 2 s on its own; this leaves room for Node startup. Same as Claude. */
const HOOK_TIMEOUT_SECONDS = 5;

type Json = Record<string, unknown>;

const codexDir = (env: AdapterEnv): string => env.env.CODEX_HOME || join(env.home, ".codex");
const configPath = (env: AdapterEnv): string => join(codexDir(env), "config.toml");
const hooksPath = (env: AdapterEnv): string => join(codexDir(env), "hooks.json");

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Quote one word of a hook command. Codex runs the command line with `$SHELL -lc` on Unix and with
 * `%COMSPEC% /C "<line>"` (cmd.exe) on Windows, so Windows words are written for cmd.exe: double
 * quotes, and forward slashes in paths. cmd.exe and every Windows API accept `/`, and it avoids
 * any question of how `\` meets a quote.
 */
function quoteArg(arg: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const word = arg.replace(/\\/g, "/");
    return /^[A-Za-z0-9_./:=@+,-]+$/.test(word) ? word : `"${word.replace(/"/g, '""')}"`;
  }
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function hookCommand(env: AdapterEnv, event: HookEvent): string {
  return [...env.conveno.command, "hook", "codex", event]
    .map((a) => quoteArg(a, env.platform))
    .join(" ");
}

/** A handler is ours when it runs `... hook codex <event>`; this lets us find it after the command path changes. */
const isOurs = (command: unknown, event: string): boolean =>
  typeof command === "string" && new RegExp(`\\bhook codex ${event}\\s*$`).test(command);

function parseHooksJson(path: string, text: string | null): Json {
  if (text === null || text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  } catch {
    // reported below
  }
  throw new ConfigParseError(
    `Cannot parse ${path} as a JSON object. Fix or move the file, then run conveno again. Conveno did not change it.`,
  );
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asObject = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};

function handlersOf(group: unknown): unknown[] {
  return asArray(asObject(group).hooks);
}

/** Hook entries for one event with our handlers removed; empty groups are dropped. */
function withoutOurs(groups: unknown[], event: HookEvent): unknown[] {
  const out: unknown[] = [];
  for (const group of groups) {
    const handlers = handlersOf(group);
    const kept = handlers.filter((h) => !isOurs(asObject(h).command, event));
    if (kept.length === handlers.length) out.push(group);
    else if (kept.length > 0) out.push({ ...asObject(group), hooks: kept });
  }
  return out;
}

function hasOurs(groups: unknown[], event: HookEvent, command: string): boolean {
  return groups.some((g) => handlersOf(g).some((h) => asObject(h).command === command));
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function planHooks(env: AdapterEnv): Promise<ConfigChange[]> {
  const path = hooksPath(env);
  const before = await readIfExists(path);
  const doc = parseHooksJson(path, before);
  const hooks = asObject(doc.hooks);
  let changed = false;
  const next: Json = { ...hooks };
  for (const event of HOOK_EVENTS) {
    const groups = asArray(hooks[event]);
    const command = hookCommand(env, event);
    if (hasOurs(groups, event, command)) continue;
    changed = true;
    next[event] = [
      ...withoutOurs(groups, event),
      { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] },
    ];
  }
  if (!changed) return [];
  return [
    {
      path,
      before,
      after: json({ ...doc, hooks: next }),
      description:
        "Add SessionStart and UserPromptSubmit hooks that deliver Conveno messages on the next turn. Codex asks you to trust new hooks: review them with /hooks.",
    },
  ];
}

async function uninstallHooks(env: AdapterEnv): Promise<ConfigChange[]> {
  const path = hooksPath(env);
  const before = await readIfExists(path);
  if (before === null) return [];
  const doc = parseHooksJson(path, before);
  const hooks = asObject(doc.hooks);
  const next: Json = { ...hooks };
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const groups = asArray(hooks[event]);
    const kept = withoutOurs(groups, event);
    if (JSON.stringify(kept) === JSON.stringify(groups)) continue;
    changed = true;
    if (kept.length > 0) next[event] = kept;
    else delete next[event];
  }
  if (!changed) return [];
  const { hooks: _drop, ...rest } = doc;
  const after = Object.keys(next).length > 0 ? { ...rest, hooks: next } : rest;
  return [
    {
      path,
      before,
      after: json(after),
      description: "Remove the Conveno SessionStart and UserPromptSubmit hooks.",
    },
  ];
}

function serverSpec(env: AdapterEnv, existing?: Record<string, unknown>) {
  const [command, ...rest] = env.conveno.command;
  if (!command) throw new Error("conveno command is empty; cannot build the Codex MCP entry.");
  // A mode the user chose for this server stays; only a missing one is filled in.
  const chosen = existing?.default_tools_approval_mode;
  return {
    command,
    args: [...rest, "mcp", "--cli", "codex"],
    approval: typeof chosen === "string" ? chosen : APPROVAL_MODE,
  };
}

async function planMcp(env: AdapterEnv): Promise<ConfigChange[]> {
  const path = configPath(env);
  const before = await readIfExists(path);
  const existing = serverOf(parseToml(path, before ?? ""));
  const spec = serverSpec(env, existing);
  if (matchesSpec(existing, spec)) return [];
  return [
    {
      path,
      before,
      after: addServer(path, before ?? "", spec),
      description: `${existing ? "Update" : "Add"} the "${SERVER_NAME}" MCP server in Codex config (mcp_servers.${SERVER_NAME}). It lets Codex call Conveno's own tools without asking each time (default_tools_approval_mode = "${spec.approval}", this server only).`,
      // No viaCommand: `codex mcp add` has no flag for the approval mode, so Conveno writes the whole entry.
    },
  ];
}

async function uninstallMcp(env: AdapterEnv): Promise<ConfigChange[]> {
  const path = configPath(env);
  const before = await readIfExists(path);
  if (before === null || !serverOf(parseToml(path, before))) return [];
  return [
    {
      path,
      before,
      after: removeServer(path, before),
      description: `Remove the "${SERVER_NAME}" MCP server from Codex config.`,
    },
  ];
}

async function detect(env: AdapterEnv): Promise<Detection> {
  const configPaths = [configPath(env), hooksPath(env)];
  try {
    const { code, stdout } = await env.exec("codex", ["--version"]);
    if (code !== 0) return { installed: false, configPaths };
    const version = /\d+\.\d+\.\d+\S*/.exec(stdout)?.[0];
    return { installed: true, binary: "codex", ...(version ? { version } : {}), configPaths };
  } catch {
    return { installed: false, configPaths };
  }
}

const EMPTY: HookOutput = { stdout: "", exitCode: 0 };

async function hook(event: string, _input: unknown, ctx: HookContext): Promise<HookOutput> {
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return EMPTY;
  try {
    const { session } = await ctx.client["session.byHost"]({ pid: ctx.hostPid });
    if (!session) return EMPTY;
    const { messages } = await ctx.client["message.deliver"]({ sessionId: session.id });
    const additionalContext = formatHookContext(messages);
    if (additionalContext === "") return EMPTY;
    return {
      stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } })}\n`,
      exitCode: 0,
    };
  } catch {
    return EMPTY;
  }
}

export const codexAdapter: Adapter = {
  cli: "codex",
  displayName: "Codex",
  deliveryTier: "next_turn",
  detect,
  async plan(env) {
    return [...(await planMcp(env)), ...(await planHooks(env))];
  },
  async uninstallPlan(env) {
    return [...(await uninstallMcp(env)), ...(await uninstallHooks(env))];
  },
  hook,
};

export default codexAdapter;
