import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { PROTOCOL_VERSION } from "@conveno/protocol";

/** 32 random bytes as lowercase hex, for nonces and challenges. */
export const newAuthNonce = (): string => randomBytes(32).toString("hex");

/** Proof the daemon sends in the `hello` result: HMAC-SHA256 of the client's nonce. */
export const daemonProof = (token: string, nonce: string): string =>
  createHmac("sha256", token).update(`${PROTOCOL_VERSION} daemon ${nonce}`).digest("hex");

/** Proof the client sends in `auth`: HMAC-SHA256 of the daemon's challenge. */
export const clientProof = (token: string, challenge: string): string =>
  createHmac("sha256", token).update(`${PROTOCOL_VERSION} client ${challenge}`).digest("hex");

/** Constant-time comparison of two hex proofs. */
export function proofsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
