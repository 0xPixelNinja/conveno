import { describe, expect, it } from "vitest";
import { createLineDecoder, encodeFrame, MAX_LINE_BYTES } from "./framing.js";

const values = (rs: ReturnType<ReturnType<typeof createLineDecoder>["push"]>) =>
  rs.map((r) => (r.ok ? r.value : `ERR:${r.error.code}`));

describe("encodeFrame", () => {
  it("emits one JSON line terminated by a single newline", () => {
    expect(encodeFrame({ a: 1 })).toBe('{"a":1}\n');
  });

  it("escapes newlines inside strings so the frame stays one line", () => {
    const f = encodeFrame({ t: "a\nb\r\nc" });
    expect(f.slice(0, -1)).not.toMatch(/[\r\n]/);
    expect(JSON.parse(f)).toEqual({ t: "a\nb\r\nc" });
  });

  it("throws on oversize frames and unserialisable values", () => {
    expect(() => encodeFrame({ s: "x".repeat(MAX_LINE_BYTES) })).toThrow(RangeError);
    expect(() => encodeFrame(undefined)).toThrow(TypeError);
    expect(() => encodeFrame({ s: "x".repeat(20) }, 10)).toThrow(RangeError);
  });
});

describe("createLineDecoder", () => {
  it("decodes a single complete line", () => {
    const d = createLineDecoder();
    expect(values(d.push('{"a":1}\n'))).toEqual([{ a: 1 }]);
  });

  it("decodes multiple lines in one chunk", () => {
    const d = createLineDecoder();
    expect(values(d.push('{"a":1}\n{"b":2}\n[3]\n'))).toEqual([{ a: 1 }, { b: 2 }, [3]]);
  });

  it("buffers partial lines across chunks", () => {
    const d = createLineDecoder();
    expect(d.push('{"a"')).toEqual([]);
    expect(d.push(":1")).toEqual([]);
    expect(values(d.push('}\n{"b":'))).toEqual([{ a: 1 }]);
    expect(values(d.push("2}\n"))).toEqual([{ b: 2 }]);
  });

  it("handles a chunk boundary right before the newline", () => {
    const d = createLineDecoder();
    expect(d.push('{"a":1}')).toEqual([]);
    expect(values(d.push("\n"))).toEqual([{ a: 1 }]);
  });

  it("works byte by byte", () => {
    const d = createLineDecoder();
    const bytes = new TextEncoder().encode('{"a":"é€😀"}\n{"b":2}\n');
    const out = [];
    for (const b of bytes) out.push(...d.push(new Uint8Array([b])));
    expect(values(out)).toEqual([{ a: "é€😀" }, { b: 2 }]);
  });

  it("reassembles a multibyte character split across Uint8Array chunks", () => {
    const d = createLineDecoder();
    const bytes = new TextEncoder().encode('{"a":"😀"}\n');
    const cut = bytes.indexOf(0xf0) + 2;
    expect(d.push(bytes.slice(0, cut))).toEqual([]);
    expect(values(d.push(bytes.slice(cut)))).toEqual([{ a: "😀" }]);
  });

  it("skips blank lines and tolerates CRLF", () => {
    const d = createLineDecoder();
    expect(values(d.push('\n\n{"a":1}\r\n  \n{"b":2}\r\n'))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reports invalid JSON per line and keeps going", () => {
    const d = createLineDecoder();
    expect(values(d.push('{"a":1}\nnot json\n{"b":2}\n'))).toEqual([
      { a: 1 },
      "ERR:invalid_json",
      { b: 2 },
    ]);
  });

  it("accepts a line of exactly the maximum size", () => {
    const max = 64;
    const d = createLineDecoder(max);
    const payload = `"${"x".repeat(max - 2)}"`;
    expect(payload.length).toBe(max);
    expect(values(d.push(`${payload}\n`))).toEqual([payload.slice(1, -1)]);
  });

  it("rejects a complete line one byte over the maximum", () => {
    const max = 64;
    const d = createLineDecoder(max);
    const payload = `"${"x".repeat(max - 1)}"`;
    expect(values(d.push(`${payload}\n{"ok":1}\n`))).toEqual(["ERR:line_too_long", { ok: 1 }]);
  });

  it("errors once on an oversize line that arrives in pieces, then resyncs", () => {
    const max = 32;
    const d = createLineDecoder(max);
    const out = [
      ...d.push(`{"k":"${"y".repeat(20)}`),
      ...d.push("y".repeat(20)),
      ...d.push("y".repeat(20)),
      ...d.push('"}\n{"after":true}\n'),
    ];
    expect(values(out)).toEqual(["ERR:line_too_long", { after: true }]);
  });

  it("counts bytes, not characters, against the limit", () => {
    const d = createLineDecoder(10);
    // '"€€€"' is 5 chars but 11 bytes
    expect(values(d.push('"€€€"\n'))).toEqual(["ERR:line_too_long"]);
    expect(values(d.push('"€€"\n'))).toEqual(["€€"]);
  });

  it("enforces the default 1 MiB limit", () => {
    const d = createLineDecoder();
    const big = `"${"x".repeat(MAX_LINE_BYTES)}"\n`;
    expect(values(d.push(big))).toEqual(["ERR:line_too_long"]);
    const exact = `"${"x".repeat(MAX_LINE_BYTES - 2)}"\n`;
    expect(d.push(exact)).toHaveLength(1);
    expect(d.push(exact)[0]?.ok).toBe(true);
  });

  it("end() flushes a trailing unterminated line as an error", () => {
    const d = createLineDecoder();
    d.push('{"a":1');
    expect(values(d.end())).toEqual(["ERR:incomplete_line"]);
    expect(d.end()).toEqual([]);
  });

  it("end() is silent when the stream ended cleanly or with whitespace", () => {
    const d = createLineDecoder();
    d.push('{"a":1}\n  ');
    expect(d.end()).toEqual([]);
  });

  it("round-trips encodeFrame output through arbitrary chunking", () => {
    const msgs = [{ a: 1 }, { s: "multi\nline" }, [1, 2, 3], "str", { n: null }];
    const wire = msgs.map((m) => encodeFrame(m)).join("");
    for (const size of [1, 2, 3, 7, 1000]) {
      const d = createLineDecoder();
      const out = [];
      for (let i = 0; i < wire.length; i += size) out.push(...d.push(wire.slice(i, i + size)));
      expect(values(out)).toEqual(msgs);
    }
  });
});
