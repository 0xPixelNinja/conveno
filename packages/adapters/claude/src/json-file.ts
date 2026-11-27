import { readFile } from "node:fs/promises";

export type JsonObject = Record<string, unknown>;

export interface LoadedJson {
  /** Raw file text, or null when the file does not exist. */
  raw: string | null;
  value: JsonObject;
  indent: string | number;
  trailingNewline: boolean;
}

export const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Read a JSON object file. Missing or blank files give `{}`; anything else that is not a JSON object throws. */
export async function loadJson(path: string): Promise<LoadedJson> {
  let raw: string | null;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = null;
    else throw new Error(`Cannot read ${path}: ${(err as Error).message}. Check its permissions.`);
  }
  if (raw === null || raw.trim() === "") {
    return { raw, value: {}, indent: 2, trailingNewline: true };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${(err as Error).message}). Fix or remove the file, then run the install again. Nothing was changed.`,
    );
  }
  if (!isObject(value)) {
    throw new Error(
      `${path} must contain a JSON object at the top level. Fix the file, then run the install again. Nothing was changed.`,
    );
  }
  return { raw, value, indent: detectIndent(raw), trailingNewline: raw.endsWith("\n") };
}

function detectIndent(raw: string): string | number {
  const m = /^([ \t]+)\S/m.exec(raw);
  if (!m?.[1]) return 2;
  return m[1].startsWith("\t") ? "\t" : m[1].length;
}

export function serialize(file: LoadedJson, value: JsonObject): string {
  return JSON.stringify(value, null, file.indent) + (file.trailingNewline ? "\n" : "");
}
