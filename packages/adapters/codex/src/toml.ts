import { parse, patch } from "@decimalturn/toml-patch";

type Table = Record<string, unknown>;

export const SERVER_NAME = "conveno";

export class ConfigParseError extends Error {}

export function parseToml(path: string, text: string): Table {
  try {
    return parse(text) as Table;
  } catch (err) {
    throw new ConfigParseError(
      `Cannot parse ${path} as TOML (${err instanceof Error ? err.message : String(err)}). Fix or move the file, then run conveno again. Conveno did not change it.`,
    );
  }
}

export interface ServerSpec {
  command: string;
  args: string[];
  /**
   * Value for `default_tools_approval_mode`, Codex's per-server setting for MCP tool approval
   * (auto, prompt, writes or approve). Conveno writes `approve` so Codex does not ask before each call.
   */
  approval: string;
}

/** The approval mode Conveno asks for. A mode the user already set on the server is kept instead. */
export const APPROVAL_MODE = "approve";

export function serverOf(doc: Table): Table | undefined {
  const servers = doc.mcp_servers;
  if (servers && typeof servers === "object") {
    const ours = (servers as Table)[SERVER_NAME];
    if (ours && typeof ours === "object") return ours as Table;
  }
  return undefined;
}

export function matchesSpec(server: Table | undefined, spec: ServerSpec): boolean {
  return (
    server !== undefined &&
    server.command === spec.command &&
    JSON.stringify(server.args) === JSON.stringify(spec.args) &&
    server.default_tools_approval_mode === spec.approval
  );
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

/** TOML basic strings use the same escapes as JSON for everything we write. */
const q = (s: string): string => JSON.stringify(s);

function tableText(spec: ServerSpec, eol: string): string {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${q(spec.command)}`,
    `args = [${spec.args.map(q).join(", ")}]`,
    `default_tools_approval_mode = ${q(spec.approval)}`,
    "",
  ].join(eol);
}

/** Compare parsed data, treating a missing `mcp_servers` and an empty one as equal. */
const sameData = (a: Table, b: Table): boolean => {
  const norm = (t: Table): string =>
    JSON.stringify(t, (k, v) =>
      k === "mcp_servers" && v && Object.keys(v as Table).length === 0 ? undefined : v,
    );
  return norm(a) === norm(b);
};

/**
 * Add our `[mcp_servers.conveno]` table. The file is left byte-for-byte intact: the table is
 * appended as text. If the result does not parse to the expected data (for example the user
 * already defines `mcp_servers.conveno` inline), fall back to a comment-preserving patch.
 */
export function addServer(path: string, before: string, spec: ServerSpec): string {
  const doc = parseToml(path, before);
  const expected = structuredClone(doc);
  const servers = (expected.mcp_servers ?? {}) as Table;
  servers[SERVER_NAME] = {
    command: spec.command,
    args: spec.args,
    default_tools_approval_mode: spec.approval,
  };
  expected.mcp_servers = servers;

  const eol = eolOf(before);
  const sep = before === "" ? "" : before.endsWith("\n") ? eol : eol + eol;
  const appended = before + sep + tableText(spec, eol);
  try {
    if (sameData(parse(appended) as Table, expected)) return appended;
  } catch {
    // fall through to the patch
  }
  return patch(before, expected as never);
}

/** Remove our table and any `[mcp_servers.conveno.*]` subtables. */
export function removeServer(path: string, before: string): string {
  const doc = parseToml(path, before);
  const expected = structuredClone(doc);
  const servers = expected.mcp_servers as Table | undefined;
  if (servers) delete servers[SERVER_NAME];

  const eol = eolOf(before);
  const lines = before.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const key = (header[1] as string).replace(/["'\s]/g, "");
      const key0 = `mcp_servers.${SERVER_NAME}`;
      skipping = key === key0 || key.startsWith(`${key0}.`);
    }
    if (!skipping) out.push(line);
  }
  let text = out.join(eol);
  // Our table was last: drop the blank separator that preceded it.
  if (skipping) text = text.replace(/(\r?\n)+$/, "") + (text.trim() === "" ? "" : eol);
  try {
    if (sameData(parse(text) as Table, expected)) return text;
  } catch {
    // fall through to the patch
  }
  return patch(before, expected as never);
}
