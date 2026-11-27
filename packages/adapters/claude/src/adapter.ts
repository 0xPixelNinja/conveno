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
import { editJson, isObject, type JsonEdit, type JsonObject, loadJson } from "./json-file.js";

export const SERVER_NAME = "conveno";
export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit"] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];
/** Seconds. Hooks run before the model turn, so keep this short. */
export const HOOK_TIMEOUT_SECONDS = 5;

const EMPTY: HookOutput = { stdout: "", exitCode: 0 };

/** `~/.claude.json` holds user-scope MCP servers; settings.json holds hooks. Both honor CLAUDE_CONFIG_DIR. */
function paths(env: AdapterEnv): { mcp: string; settings: string } {
  const dir = env.env.CLAUDE_CONFIG_DIR;
  if (dir) return { mcp: join(dir, ".claude.json"), settings: join(dir, "settings.json") };
  return {
    mcp: join(env.home, ".claude.json"),
    settings: join(env.home, ".claude", "settings.json"),
  };
}

/**
 * Quote one word of a hook command for the shell Claude Code runs it in. On Windows that is Git
 * Bash (PowerShell only when Git Bash is not installed), so the word is written for bash. Windows
 * paths use forward slashes there: bash would read `\P` inside double quotes as an escape, and
 * Windows accepts `/` in every API Node and Git Bash use, so `C:/Program Files/nodejs/node.exe`
 * means the same file and needs no escaping.
 */
function quoteHookWord(arg: string, platform: NodeJS.Platform): string {
  const word = platform === "win32" ? arg.replace(/\\/g, "/") : arg;
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(word) ? word : `"${word.replace(/(["\\$`])/g, "\\$1")}"`;
}

const hookCommand = (env: AdapterEnv, event: string): string =>
  [...env.conveno.command, "hook", "claude", event]
    .map((w) => quoteHookWord(w, env.platform))
    .join(" ");

const mcpArgs = (env: AdapterEnv): string[] => [...env.conveno.command, "mcp", "--cli", "claude"];

const desiredServer = (env: AdapterEnv): JsonObject => {
  const [command = "conveno", ...args] = mcpArgs(env);
  return { type: "stdio", command, args, env: {} };
};

/** Recognizes our hook command even if the conveno path changed since install. */
const isOurHookCommand = (cmd: unknown): boolean =>
  typeof cmd === "string" && /(^|\s)hook claude (SessionStart|UserPromptSubmit)$/.test(cmd.trim());

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function groupsOf(hooks: JsonObject, event: string): unknown[] {
  const g = hooks[event];
  return Array.isArray(g) ? g : [];
}

function hasExactHook(hooks: JsonObject, event: string, command: string): boolean {
  return groupsOf(hooks, event).some(
    (g) =>
      isObject(g) &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isObject(h) && h.type === "command" && h.command === command),
  );
}

/** Drop our hook handlers (and groups left empty by that). */
function stripOurHooks(groups: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const g of groups) {
    if (!isObject(g) || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !(isObject(h) && isOurHookCommand(h.command)));
    if (kept.length === g.hooks.length) out.push(g);
    else if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return out;
}

function hooksObject(settings: JsonObject, path: string): JsonObject {
  const h = settings.hooks;
  if (h === undefined) return {};
  if (!isObject(h)) {
    throw new Error(
      `"hooks" in ${path} must be an object. Fix the file, then run the install again. Nothing was changed.`,
    );
  }
  return h;
}

function mcpObject(config: JsonObject, path: string): JsonObject {
  const s = config.mcpServers;
  if (s === undefined) return {};
  if (!isObject(s)) {
    throw new Error(
      `"mcpServers" in ${path} must be an object. Fix the file, then run the install again. Nothing was changed.`,
    );
  }
  return s;
}

async function detect(env: AdapterEnv): Promise<Detection> {
  const p = paths(env);
  const configPaths = [p.mcp, p.settings];
  try {
    const r = await env.exec("claude", ["--version"]);
    if (r.code !== 0) return { installed: false, configPaths };
    const version = /\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0];
    return { installed: true, binary: "claude", ...(version ? { version } : {}), configPaths };
  } catch {
    return { installed: false, configPaths };
  }
}

async function plan(env: AdapterEnv): Promise<ConfigChange[]> {
  const p = paths(env);
  const changes: ConfigChange[] = [];

  const mcpFile = await loadJson(p.mcp);
  const servers = mcpObject(mcpFile.value, p.mcp);
  const want = desiredServer(env);
  if (!sameJson(servers[SERVER_NAME], want)) {
    const after = editJson(mcpFile, [{ path: ["mcpServers", SERVER_NAME], value: want }]);
    changes.push({
      path: p.mcp,
      before: mcpFile.raw,
      after,
      description: `Register the "${SERVER_NAME}" MCP server at user scope (conveno mcp --cli claude).`,
      viaCommand: ["claude", "mcp", "add", "--scope", "user", SERVER_NAME, "--", ...mcpArgs(env)],
    });
  }

  const setFile = await loadJson(p.settings);
  const hooks = hooksObject(setFile.value, p.settings);
  const missing = HOOK_EVENTS.filter((e) => !hasExactHook(hooks, e, hookCommand(env, e)));
  if (missing.length > 0) {
    const next: JsonObject = { ...hooks };
    for (const e of missing) {
      next[e] = [
        ...stripOurHooks(groupsOf(hooks, e)),
        {
          hooks: [{ type: "command", command: hookCommand(env, e), timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ];
    }
    changes.push({
      path: p.settings,
      before: setFile.raw,
      after: editJson(
        setFile,
        missing.map((e) => ({ path: ["hooks", e], value: next[e] })),
      ),
      description: `Add ${missing.join(" and ")} hooks that deliver Conveno messages to Claude Code.`,
    });
  }
  return changes;
}

async function uninstallPlan(env: AdapterEnv): Promise<ConfigChange[]> {
  const p = paths(env);
  const changes: ConfigChange[] = [];

  const mcpFile = await loadJson(p.mcp);
  const servers = mcpObject(mcpFile.value, p.mcp);
  if (SERVER_NAME in servers) {
    changes.push({
      path: p.mcp,
      before: mcpFile.raw,
      after: editJson(mcpFile, [{ path: ["mcpServers", SERVER_NAME], value: undefined }]),
      description: `Remove the "${SERVER_NAME}" MCP server from user scope.`,
      viaCommand: ["claude", "mcp", "remove", "--scope", "user", SERVER_NAME],
    });
  }

  const setFile = await loadJson(p.settings);
  const hooks = hooksObject(setFile.value, p.settings);
  const next: JsonObject = { ...hooks };
  const edits: JsonEdit[] = [];
  for (const e of HOOK_EVENTS) {
    const groups = groupsOf(hooks, e);
    const stripped = stripOurHooks(groups);
    if (sameJson(groups, stripped)) continue;
    if (stripped.length > 0) next[e] = stripped;
    else delete next[e];
    edits.push({ path: ["hooks", e], value: stripped.length > 0 ? stripped : undefined });
  }
  if (edits.length > 0) {
    // Dropping the last event takes the empty `hooks` object with it.
    if (Object.keys(next).length === 0) edits.push({ path: ["hooks"], value: undefined });
    changes.push({
      path: p.settings,
      before: setFile.raw,
      after: editJson(setFile, edits),
      description: "Remove the Conveno SessionStart and UserPromptSubmit hooks.",
    });
  }
  return changes;
}

const isHookEvent = (e: string): e is HookEvent => (HOOK_EVENTS as readonly string[]).includes(e);

/** Never throws and never writes to stderr: any failure means "deliver nothing this time". */
async function hook(event: string, _input: unknown, ctx: HookContext): Promise<HookOutput> {
  if (!isHookEvent(event)) return EMPTY;
  try {
    const { session } = await ctx.client["session.byHost"]({ hostPid: ctx.hostPid });
    if (!session) return EMPTY;
    const { messages } = await ctx.client["message.deliver"]({ sessionId: session.id });
    if (messages.length === 0) return EMPTY;
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: formatHookContext(messages) },
    });
    return { stdout, exitCode: 0 };
  } catch {
    return EMPTY;
  }
}

export const claudeAdapter: Adapter = {
  cli: "claude",
  displayName: "Claude Code",
  deliveryTier: "next_turn",
  detect,
  plan,
  uninstallPlan,
  hook,
};
