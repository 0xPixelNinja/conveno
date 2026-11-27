import { utf8ByteLength } from "./util.js";

/** Maximum size of one NDJSON line, excluding the terminating newline. */
export const MAX_LINE_BYTES = 1024 * 1024;

export type FrameErrorCode = "line_too_long" | "invalid_json" | "incomplete_line";

export type FrameResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: FrameErrorCode; message: string } };

/** Serialise `obj` as one NDJSON line (JSON + `\n`). Throws if the line would exceed `maxLineBytes`. */
export function encodeFrame(obj: unknown, maxLineBytes: number = MAX_LINE_BYTES): string {
  const json = JSON.stringify(obj);
  if (json === undefined) throw new TypeError("value is not JSON-serialisable");
  // JSON.stringify never emits a raw newline: control characters inside strings are escaped.
  if (utf8ByteLength(json) > maxLineBytes) {
    throw new RangeError(`frame exceeds ${maxLineBytes} bytes`);
  }
  return `${json}\n`;
}

export interface LineDecoder {
  /** Feed a chunk; returns one result per completed line, in order. */
  push(chunk: string | Uint8Array): FrameResult[];
  /** Call at end of stream: reports a trailing unterminated line, if any. */
  end(): FrameResult[];
}

/**
 * Incremental NDJSON decoder. Handles lines split across chunks (including mid-UTF-8-sequence),
 * several lines in one chunk, CRLF, and blank lines (skipped). A line longer than `maxLineBytes`
 * yields one `line_too_long` error; the rest of that line is discarded so decoding resyncs at the
 * next newline. Malformed JSON yields `invalid_json` for that line only.
 */
export function createLineDecoder(maxLineBytes: number = MAX_LINE_BYTES): LineDecoder {
  const utf8 = new TextDecoder("utf-8");
  let pending = "";
  let pendingBytes = 0;
  let discarding = false;

  const tooLong = (): FrameResult => ({
    ok: false,
    error: { code: "line_too_long", message: `line exceeds ${maxLineBytes} bytes` },
  });

  const parseLine = (raw: string): FrameResult[] => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return [];
    try {
      return [{ ok: true, value: JSON.parse(line) }];
    } catch (e) {
      return [{ ok: false, error: { code: "invalid_json", message: (e as Error).message } }];
    }
  };

  const decode = (chunk: string | Uint8Array, last: boolean): string =>
    typeof chunk === "string" ? chunk : utf8.decode(chunk, { stream: !last });

  const consume = (text: string): FrameResult[] => {
    const out: FrameResult[] = [];
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl === -1) break;
      const segment = text.slice(start, nl);
      start = nl + 1;
      if (discarding) {
        // The oversize error for this line was already emitted; resume at the next line.
        discarding = false;
      } else if (pendingBytes + utf8ByteLength(segment) > maxLineBytes) {
        out.push(tooLong());
      } else {
        out.push(...parseLine(pending + segment));
      }
      pending = "";
      pendingBytes = 0;
    }
    const rest = text.slice(start);
    if (rest !== "" && !discarding) {
      pending += rest;
      pendingBytes += utf8ByteLength(rest);
      if (pendingBytes > maxLineBytes) {
        out.push(tooLong());
        discarding = true;
        pending = "";
        pendingBytes = 0;
      }
    }
    return out;
  };

  return {
    push(chunk) {
      return consume(decode(chunk, false));
    },
    end() {
      const out = consume(utf8.decode());
      if (pending.trim() !== "") {
        out.push({
          ok: false,
          error: { code: "incomplete_line", message: "stream ended inside a line" },
        });
      }
      pending = "";
      pendingBytes = 0;
      discarding = false;
      return out;
    },
  };
}
