import { z } from "zod";
import { AccountId, DeviceId, MessageId } from "./ids.js";
import { Base64 } from "./primitives.js";
import { RELAY_FRAME_VERSION } from "./version.js";

/** Max base64 length of an envelope ciphertext (~384 KiB of sealed payload). */
export const RELAY_CIPHERTEXT_MAX_CHARS = 512 * 1024;

const v = z.literal(RELAY_FRAME_VERSION);
/** Unix epoch milliseconds. */
const ts = z.number().int().nonnegative();

/** First frame on a connection: proves the device owns its signing key. */
export const RelayHello = z.object({
  t: z.literal("hello"),
  v,
  accountId: AccountId,
  deviceId: DeviceId,
  /** Ed25519 signature (base64) over the canonical hello string; see PROTOCOL.md. */
  sig: Base64,
  ts,
});

/** An end-to-end encrypted message addressed to one device. The relay never sees plaintext. */
export const RelayEnvelope = z.object({
  t: z.literal("envelope"),
  v,
  id: MessageId,
  fromDevice: DeviceId,
  toDevice: DeviceId,
  /** crypto_box nonce, 24 bytes, base64. */
  nonce: Base64.length(32),
  ciphertext: Base64.max(RELAY_CIPHERTEXT_MAX_CHARS),
  /** Ed25519 signature by `fromDevice` over the envelope fields. */
  sig: Base64,
  ts,
});

export const RelayAck = z.object({ t: z.literal("ack"), id: MessageId });

export const RelayError = z.object({
  t: z.literal("error"),
  code: z.string().min(1).max(64),
  message: z.string().max(1_000),
});

export const RelayFrame = z.discriminatedUnion("t", [
  RelayHello,
  RelayEnvelope,
  RelayAck,
  RelayError,
]);
export type RelayFrame = z.infer<typeof RelayFrame>;
export type RelayHello = z.infer<typeof RelayHello>;
export type RelayEnvelope = z.infer<typeof RelayEnvelope>;
export type RelayAck = z.infer<typeof RelayAck>;
export type RelayError = z.infer<typeof RelayError>;
