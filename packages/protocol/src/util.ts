const encoder = new TextEncoder();

/** Number of bytes `s` occupies when encoded as UTF-8. */
export function utf8ByteLength(s: string): number {
  return encoder.encode(s).length;
}
