import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Adapter,
  AdapterEnv,
  ConfigChange,
  Detection,
  HookOutput,
} from "@0xpixelninja/conveno-core";
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
}

function configDir(env: AdapterEnv): string {
  return join(env.home, ".config", "opencode");
}

/** Prefers an existing opencode.jsonc, then opencode.json, else a new opencode.json. */
async function locateConfig(env: AdapterEnv): Promise<ConfigFile> {
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

function serverEntry(env: AdapterEnv): ServerEntry {
  return { type: "local", command: [...env.conveno.command, "mcp", "--cli", "opencode"] };
}

function sameEntry(found: unknown, want: ServerEntry): boolean {
  if (found === null || typeof found !== "object") return false;
  const f = found as { type?: unknown; command?: unknown; disabled?: unknown };
  return (
    f.type === want.type &&
    f.disabled !== true &&
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
  const configPaths = [
    join(configDir(env), "opencode.jsonc"),
    join(configDir(env), "opencode.json"),
  ];
  try {
    const res = await env.exec("opencode", ["--version"]);
    if (res.code !== 0) return { installed: false, configPaths };
    const version = res.stdout.trim().split(/\s+/).pop();
    return { installed: true, binary: "opencode", configPaths, ...(version ? { version } : {}) };
  } catch {
    return { installed: false, configPaths };
  }
}

async function plan(env: AdapterEnv): Promise<ConfigChange[]> {
  const file = await locateConfig(env);
  const config = parseConfig(file);
  const want = serverEntry(env);
  if (sameEntry(servers(config)?.[SERVER_NAME], want)) return [];
  const base = file.text === null || file.text.trim() === "" ? "{}\n" : file.text;
  const edits = modify(base, ["mcp", "servers", SERVER_NAME], want, { formattingOptions: FORMAT });
  let after = applyEdits(base, edits);
  if (!after.endsWith("\n")) after += "\n";
  return [
    {
      path: file.path,
      before: file.text,
      after,
      description: `Add the conveno MCP server (mcp.servers.${SERVER_NAME}) to the OpenCode global config`,
    },
  ];
}

async function uninstallPlan(env: AdapterEnv): Promise<ConfigChange[]> {
  const file = await locateConfig(env);
  if (file.text === null) return [];
  const s = servers(parseConfig(file));
  if (!s || !(SERVER_NAME in s)) return [];
  const edits = modify(file.text, ["mcp", "servers", SERVER_NAME], undefined, {
    formattingOptions: FORMAT,
  });
  return [
    {
      path: file.path,
      before: file.text,
      after: applyEdits(file.text, edits),
      description: `Remove the conveno MCP server (mcp.servers.${SERVER_NAME}) from the OpenCode global config`,
    },
  ];
}

async function hook(): Promise<HookOutput> {
  // OpenCode has no hook injection in M1; delivery is through the inbox tool.
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
