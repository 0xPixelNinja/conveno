import { RpcErrorCode } from "@conveno/protocol";
import { describe, expect, it } from "vitest";
import { ConvenoError, NO_ORCHESTRATOR_MESSAGE } from "./errors.js";
import { claimOrchestrator, effectiveHolder, holderAfterDeparture } from "./orchestrator.js";
import { resolveRecipient } from "./recipient.js";
import { sess } from "./test-utils.js";

describe("orchestrator", () => {
  const a = sess("claude@api-1");
  const b = sess("codex@api-1");

  it("claims with no holder", () => {
    const r = claimOrchestrator(null, a.id, [a, b]);
    expect(r).toMatchObject({ orchestrator: a.id, previous: null });
    expect(r.notices.map((n) => [n.to, n.event])).toEqual([[a.id, "orchestrator.granted"]]);
  });
  it("takes the role from the holder and notifies both", () => {
    const r = claimOrchestrator(a.id, b.id, [a, b]);
    expect(r.previous).toBe(a.id);
    expect(r.notices.map((n) => n.to).sort()).toEqual([a.id, b.id].sort());
    expect(r.notices.find((n) => n.to === a.id)?.detail).toContain("codex@api-1");
  });
  it("is a no-op when you already hold it", () => {
    const r = claimOrchestrator(a.id, a.id, [a, b]);
    expect(r).toEqual({ orchestrator: a.id, previous: null, notices: [] });
  });
  it("treats an offline holder as no holder", () => {
    const off = { ...a, status: "offline" as const };
    expect(effectiveHolder(off.id, [off, b])).toBeNull();
    const r = claimOrchestrator(off.id, b.id, [off, b]);
    expect(r.previous).toBeNull();
    expect(r.notices).toHaveLength(1);
  });
  it("rejects an unknown or offline claimer", () => {
    const off = { ...b, status: "offline" as const };
    expect(() => claimOrchestrator(null, off.id, [a, off])).toThrow(ConvenoError);
    expect(() => claimOrchestrator(null, sess("x").id, [a])).toThrow(ConvenoError);
  });
  it("never passes the role on when the holder leaves", () => {
    expect(holderAfterDeparture(a.id, a.id)).toBeNull();
    expect(holderAfterDeparture(a.id, b.id)).toBe(a.id);
    expect(holderAfterDeparture(null, b.id)).toBeNull();
  });
});

describe("resolveRecipient", () => {
  const a = sess("claude@api-1");
  const b = sess("codex@api-1");
  const off = sess("gone@api-1", "offline");
  const all = [a, b, off];
  const fail = (to: string, holder = null as typeof a.id | null) => {
    try {
      resolveRecipient(to, all, holder);
    } catch (e) {
      return e as ConvenoError;
    }
    throw new Error("expected failure");
  };

  it("resolves by id and by name", () => {
    expect(resolveRecipient(a.id, all, null)).toBe(a);
    expect(resolveRecipient("codex@api-1", all, null)).toBe(b);
  });
  it("resolves orchestrator to the holder", () => {
    expect(resolveRecipient("orchestrator", all, b.id)).toBe(b);
  });
  it("uses the exact spec error when nobody holds the role", () => {
    for (const holder of [null, off.id, sess("ghost").id]) {
      const e = fail("orchestrator", holder);
      expect(e.code).toBe(RpcErrorCode.NotFound);
      expect(e.message).toBe(
        "No session holds the orchestrator role. Run orchestrate in the session you want to use.",
      );
      expect(e.message).toBe(NO_ORCHESTRATOR_MESSAGE);
    }
  });
  it("reports offline and unknown recipients as NotFound", () => {
    expect(fail("gone@api-1").code).toBe(RpcErrorCode.NotFound);
    expect(fail("gone@api-1").message).toContain("offline");
    expect(fail(off.id).message).toContain("offline");
    expect(fail("nobody").message).toContain('No session named "nobody"');
  });
});
