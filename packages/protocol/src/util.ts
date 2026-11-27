const encoder = new TextEncoder();

/** Number of bytes `s` occupies when encoded as UTF-8. */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * Make free text safe for a one-line display: control characters (newlines and tabs included)
 * become spaces, runs of whitespace collapse to one space, and the ends are trimmed.
 */
export function sanitizeLine(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
