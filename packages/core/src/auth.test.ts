import { describe, expect, it } from "vitest";
import { clientProof, daemonProof, newAuthNonce, proofsMatch } from "./auth.js";

describe("auth proofs", () => {
  it("makes 32 byte hex nonces", () => {
    expect(newAuthNonce()).toMatch(/^[0-9a-f]{64}$/);
    expect(newAuthNonce()).not.toBe(newAuthNonce());
  });
  it("binds each proof to its role, token and value", () => {
    const n = newAuthNonce();
    expect(daemonProof("t", n)).toMatch(/^[0-9a-f]{64}$/);
    expect(daemonProof("t", n)).toBe(daemonProof("t", n));
    expect(daemonProof("t", n)).not.toBe(clientProof("t", n));
    expect(daemonProof("t", n)).not.toBe(daemonProof("u", n));
    expect(daemonProof("t", n)).not.toBe(daemonProof("t", newAuthNonce()));
  });
  it("compares proofs without throwing on odd lengths", () => {
    const p = daemonProof("t", "x");
    expect(proofsMatch(p, p)).toBe(true);
    expect(proofsMatch(p, "short")).toBe(false);
    expect(proofsMatch(p, daemonProof("u", "x"))).toBe(false);
  });
});
