import { describe, expect, it } from "vitest";
import { newAccountId, newDeviceId, newMessageId } from "./ids.js";
import { parseRelayFrame } from "./parse.js";
import { RELAY_CIPHERTEXT_MAX_CHARS } from "./relay.js";

const b64 = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

const hello = () => ({
  t: "hello",
  v: 1,
  accountId: newAccountId(),
  deviceId: newDeviceId(),
  sig: b64(64),
  ts: 1_764_235_800_000,
});
const envelope = () => ({
  t: "envelope",
  v: 1,
  id: newMessageId(),
  fromDevice: newDeviceId(),
  toDevice: newDeviceId(),
  nonce: b64(24),
  ciphertext: b64(100),
  sig: b64(64),
  ts: 1_764_235_800_000,
});

describe("RelayFrame", () => {
  it("accepts each frame type", () => {
    expect(parseRelayFrame(hello()).ok).toBe(true);
    expect(parseRelayFrame(envelope()).ok).toBe(true);
    expect(parseRelayFrame({ t: "ack", id: newMessageId() }).ok).toBe(true);
    expect(parseRelayFrame({ t: "error", code: "rate_limited", message: "slow down" }).ok).toBe(
      true,
    );
  });

  it("rejects unknown frame types and wrong versions", () => {
    expect(parseRelayFrame({ ...hello(), t: "ping" }).ok).toBe(false);
    expect(parseRelayFrame({ ...hello(), v: 2 }).ok).toBe(false);
    expect(parseRelayFrame({ ...envelope(), v: 0 }).ok).toBe(false);
  });

  it("rejects non-base64 and wrong-length nonce", () => {
    expect(parseRelayFrame({ ...envelope(), ciphertext: "not base64!" }).ok).toBe(false);
    expect(parseRelayFrame({ ...envelope(), sig: "abc" }).ok).toBe(false);
    expect(parseRelayFrame({ ...envelope(), nonce: b64(16) }).ok).toBe(false);
    expect(parseRelayFrame({ ...hello(), sig: "***" }).ok).toBe(false);
  });

  it("bounds ciphertext size", () => {
    const ok = "A".repeat(RELAY_CIPHERTEXT_MAX_CHARS);
    expect(parseRelayFrame({ ...envelope(), ciphertext: ok }).ok).toBe(true);
    expect(parseRelayFrame({ ...envelope(), ciphertext: `${ok}AAAA` }).ok).toBe(false);
  });

  it("rejects bad ids and timestamps", () => {
    expect(parseRelayFrame({ ...hello(), accountId: "acct" }).ok).toBe(false);
    expect(parseRelayFrame({ ...envelope(), toDevice: "x" }).ok).toBe(false);
    expect(parseRelayFrame({ ...hello(), ts: -1 }).ok).toBe(false);
    expect(parseRelayFrame({ ...hello(), ts: 1.5 }).ok).toBe(false);
    expect(parseRelayFrame({ t: "ack" }).ok).toBe(false);
  });

  it("an envelope carries no plaintext fields (metadata only)", () => {
    const r = parseRelayFrame({ ...envelope(), body: { text: "secret" }, kind: "text" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("body");
      expect(r.value).not.toHaveProperty("kind");
    }
  });
});
