import { readFile } from "node:fs/promises";
import { applyEdits, modify } from "jsonc-parser";

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

/** One change: set `value` at `path`, or delete the key when `value` is undefined. */
export interface JsonEdit {
  path: (string | number)[];
  value: unknown;
}

/**
 * Apply edits to the file's own text. Only the touched keys change: other keys, duplicate keys,
 * escapes, key order and line endings stay as they were, byte for byte.
 */
export function editJson(file: LoadedJson, edits: JsonEdit[]): string {
  const bom = file.raw?.charCodeAt(0) === 0xfeff;
  let text = file.raw === null || file.raw.trim() === "" ? "{}\n" : file.raw;
  if (bom) text = text.slice(1);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const formattingOptions = {
    insertSpaces: file.indent !== "\t",
    tabSize: typeof file.indent === "number" ? file.indent : 2,
    eol,
  };
  for (const e of edits) {
    text = applyEdits(text, modify(text, e.path, e.value, { formattingOptions }));
  }
  return (bom ? "\uFEFF" : "") + text;
}
