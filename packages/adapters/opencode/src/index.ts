import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type Adapter,
  type AdapterEnv,
  type ConfigChange,
  type Detection,
  type HookOutput,
  parseCliVersion,
} from "@conveno/core";
import { applyEdits, modify, type ParseError, parse, printParseErrorCode } from "jsonc-parser";

const SERVER_NAME = "conveno";
const FORMAT = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

interface ConfigFile {
  path: string;
  /** Current text, or null when the file does not exist. */
  text: string | null;
}

interface ServerEntry {
  type: "local";
  command: string[];
  enabled?: true;
}

type Shape = "v1" | "v2";

/** First OpenCode release that reads `mcp.servers`. There were no 2.0.x or 2.1.x releases. */
const V2_MIN: readonly [number, number, number] = [2, 2, 0];

/** `$XDG_CONFIG_HOME/opencode` when XDG_CONFIG_HOME is an absolute path, else `~/.config/opencode`. */
function configDir(env: AdapterEnv): string {
  const xdg = env.env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(env.home, ".config");
  return join(base, "opencode");
}

/** `OPENCODE_CONFIG` names one config file; when set it is the only file we touch. */
const customConfig = (env: AdapterEnv): string | undefined => env.env.OPENCODE_CONFIG || undefined;

/**
 * `OPENCODE_CONFIG` when set. Otherwise an existing opencode.jsonc, then opencode.json, else a
 * new opencode.json in the config directory.
 */
async function locateConfig(env: AdapterEnv): Promise<ConfigFile> {
  const custom = customConfig(env);
  if (custom) {
    try {
      return { path: custom, text: await readFile(custom, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return { path: custom, text: null };
    }
  }
  const dir = configDir(env);
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const path = join(dir, name);
    try {
      return { path, text: await readFile(path, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return { path: join(dir, "opencode.json"), text: null };
}

function parseConfig(file: ConfigFile): Record<string, unknown> {
  if (file.text === null || file.text.trim() === "") return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(file.text, errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first) {
    throw new Error(
      `Cannot read ${file.path}: ${printParseErrorCode(first.error)} at offset ${first.offset}. ` +
        "Fix the syntax or move the file aside, then run conveno again. The file was not changed.",
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Cannot read ${file.path}: the top level must be a JSON object. The file was not changed.`,
    );
  }
  return value as Record<string, unknown>;
}

function serverEntry(env: AdapterEnv, shape: Shape): ServerEntry {
  const command = [...env.conveno.command, "mcp", "--cli", "opencode"];
  return shape === "v1" ? { type: "local", command, enabled: true } : { type: "local", command };
}

function parseVersion(text: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function isV2OrLater(v: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((v[i] as number) !== (V2_MIN[i] as number)) return (v[i] as number) > (V2_MIN[i] as number);
  }
  return true;
}

async function chooseShape(env: AdapterEnv, config: Record<string, unknown>): Promise<Shape> {
  let version: [number, number, number] | undefined;
  try {
    const res = await env.exec("opencode", ["--version"]);
    if (res.code === 0) version = parseVersion(res.stdout);
  } catch {
    version = undefined;
  }
  if (version) return isV2OrLater(version) ? "v2" : "v1";
  // Unknown version: keep V2 only when the config already has the `mcp.servers` envelope.
  // Otherwise V1, which every 1.x release reads (1.19.x also reads V2).
  return servers(config) !== undefined ? "v2" : "v1";
}

function v1Entry(config: Record<string, unknown>): unknown {
  const mcp = config.mcp;
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return undefined;
  return (mcp as Record<string, unknown>)[SERVER_NAME];
}

function pathFor(shape: Shape): string[] {
  return shape === "v1" ? ["mcp", SERVER_NAME] : ["mcp", "servers", SERVER_NAME];
}

function sameEntry(found: unknown, want: ServerEntry): boolean {
  if (found === null || typeof found !== "object") return false;
  const f = found as { type?: unknown; command?: unknown; disabled?: unknown; enabled?: unknown };
  return (
    f.type === want.type &&
    f.disabled !== true &&
    (want.enabled === undefined || f.enabled === true) &&
    Array.isArray(f.command) &&
    f.command.length === want.command.length &&
    f.command.every((c, i) => c === want.command[i])
  );
}

function servers(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const mcp = config.mcp;
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return undefined;
  const s = (mcp as Record<string, unknown>).servers;
  if (s === null || typeof s !== "object" || Array.isArray(s)) return undefined;
  return s as Record<string, unknown>;
}

async function detect(env: AdapterEnv): Promise<Detection> {
  const custom = customConfig(env);
  const configPaths = custom
    ? [custom]
    : [join(configDir(env), "opencode.jsonc"), join(configDir(env), "opencode.json")];
  try {
    const res = await env.exec("opencode", ["--version"]);
    if (res.code !== 0) return { installed: false, configPaths };
    const version = parseCliVersion(res.stdout);
    return { installed: true, binary: "opencode", configPaths, ...(version ? { version } : {}) };
  } catch {
    return { installed: false, configPaths };
  }
}

async function plan(env: AdapterEnv): Promise<ConfigChange[]> {
  const file = await locateConfig(env);
  const config = parseConfig(file);
  const shape = await chooseShape(env, config);
  const want = serverEntry(env, shape);
  const current = shape === "v1" ? v1Entry(config) : servers(config)?.[SERVER_NAME];
  if (sameEntry(current, want)) return [];
  let text = file.text === null || file.text.trim() === "" ? "{}\n" : file.text;
  // Keep exactly one conveno entry: drop ours from the other shape.
  const otherShape: Shape = shape === "v1" ? "v2" : "v1";
  const other = otherShape === "v1" ? v1Entry(config) : servers(config)?.[SERVER_NAME];
  if (other !== undefined) {
    text = applyEdits(
      text,
      modify(text, pathFor(otherShape), undefined, { formattingOptions: FORMAT }),
    );
  }
  let after = applyEdits(text, modify(text, pathFor(shape), want, { formattingOptions: FORMAT }));
  if (!after.endsWith("\n")) after += "\n";
  const where = shape === "v1" ? `mcp.${SERVER_NAME}` : `mcp.servers.${SERVER_NAME}`;
  return [
    {
      component: "mcp",
      kind: current !== undefined || other !== undefined ? "update" : "add",
      path: file.path,
      before: file.text,
      after,
      description: `Add the conveno MCP server (${where}) to the OpenCode global config`,
    },
  ];
}

async function uninstallPlan(env: AdapterEnv): Promise<ConfigChange[]> {
  const file = await locateConfig(env);
  if (file.text === null) return [];
  const config = parseConfig(file);
  let text = file.text;
  const removed: string[] = [];
  if (servers(config)?.[SERVER_NAME] !== undefined) {
    text = applyEdits(text, modify(text, pathFor("v2"), undefined, { formattingOptions: FORMAT }));
    removed.push(`mcp.servers.${SERVER_NAME}`);
  }
  if (v1Entry(config) !== undefined) {
    text = applyEdits(text, modify(text, pathFor("v1"), undefined, { formattingOptions: FORMAT }));
    removed.push(`mcp.${SERVER_NAME}`);
  }
  if (removed.length === 0) return [];
  return [
    {
      component: "mcp",
      kind: "remove",
      path: file.path,
      before: file.text,
      after: text,
      description: `Remove the conveno MCP server (${removed.join(", ")}) from the OpenCode global config`,
    },
  ];
}

async function hook(): Promise<HookOutput> {
  // OpenCode has no hook injection yet; delivery is through the inbox tool.
  return { stdout: "", exitCode: 0 };
}

export const opencodeAdapter: Adapter = {
  cli: "opencode",
  displayName: "OpenCode",
  deliveryTier: "inbox",
  detect,
  plan,
  uninstallPlan,
  hook,
};

export default opencodeAdapter;
