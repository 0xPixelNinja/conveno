import { RpcErrorCode, type SessionId } from "@0xpixelninja/conveno-protocol";
import { ConvenoError } from "./errors.js";
import { isOnline } from "./liveness.js";
import type { NamedSession } from "./naming.js";

/** A `system` message the daemon should deliver as a result of an orchestrator change. */
export interface SystemNotice {
  to: SessionId;
  event: "orchestrator.granted" | "orchestrator.revoked";
  detail: string;
}

export interface ClaimResult {
  orchestrator: SessionId;
  /** The previous online holder, or null. An offline holder counts as no holder. */
  previous: SessionId | null;
  notices: SystemNotice[];
}

/** The current holder, treating an offline or unknown holder as nobody. */
export function effectiveHolder(
  holder: SessionId | null,
  sessions: readonly NamedSession[],
): NamedSession | null {
  if (holder === null) return null;
  const s = sessions.find((x) => x.id === holder);
  return s && isOnline(s) ? s : null;
}

/**
 * `orchestrate`: the claimer takes the role from the current holder. Exactly one holder
 * exists afterwards. Claiming while already holding is a no-op with no notices.
 */
export function claimOrchestrator(
  holder: SessionId | null,
  claimer: SessionId,
  sessions: readonly NamedSession[],
): ClaimResult {
  const me = sessions.find((s) => s.id === claimer);
  if (!me || !isOnline(me)) {
    throw new ConvenoError(RpcErrorCode.NotFound, "This session is not registered or is offline.");
  }
  const prev = effectiveHolder(holder, sessions);
  if (prev?.id === claimer) return { orchestrator: claimer, previous: null, notices: [] };
  const notices: SystemNotice[] = [
    {
      to: claimer,
      event: "orchestrator.granted",
      detail: prev
        ? `You are now the orchestrator. ${prev.name} held the role before you.`
        : "You are now the orchestrator.",
    },
  ];
  if (prev) {
    notices.push({
      to: prev.id,
      event: "orchestrator.revoked",
      detail: `${me.name} took the orchestrator role from you.`,
    });
  }
  return { orchestrator: claimer, previous: prev?.id ?? null, notices };
}

/** Holder after a session unregisters or goes offline: the role is vacated, never passed on. */
export function holderAfterDeparture(
  holder: SessionId | null,
  departed: SessionId,
): SessionId | null {
  return holder === departed ? null : holder;
}
