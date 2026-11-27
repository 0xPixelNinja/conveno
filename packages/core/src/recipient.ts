import { ORCHESTRATOR_ALIAS, RpcErrorCode, SessionId } from "@0xpixelninja/conveno-protocol";
import {
  ConvenoError,
  NO_ORCHESTRATOR_MESSAGE,
  offlineRecipientMessage,
  unknownRecipientMessage,
} from "./errors.js";
import { isOnline } from "./liveness.js";
import type { NamedSession } from "./naming.js";
import { effectiveHolder } from "./orchestrator.js";

/**
 * Resolve a recipient (`orchestrator`, session id or session name) to a session.
 * Names resolve among non-offline sessions only; an id may also name an offline session
 * so a sender gets a clear error rather than "unknown".
 */
export function resolveRecipient(
  to: string,
  sessions: readonly NamedSession[],
  holder: SessionId | null,
): NamedSession {
  if (to === ORCHESTRATOR_ALIAS) {
    const h = effectiveHolder(holder, sessions);
    if (!h) throw new ConvenoError(RpcErrorCode.NotFound, NO_ORCHESTRATOR_MESSAGE);
    return h;
  }
  const byId = SessionId.safeParse(to).success ? sessions.find((s) => s.id === to) : undefined;
  const found = byId ?? sessions.find((s) => s.name === to && isOnline(s));
  if (found) {
    if (!isOnline(found)) {
      throw new ConvenoError(RpcErrorCode.NotFound, offlineRecipientMessage(found.name));
    }
    return found;
  }
  const offline = sessions.find((s) => s.name === to);
  if (offline) {
    throw new ConvenoError(RpcErrorCode.NotFound, offlineRecipientMessage(to));
  }
  throw new ConvenoError(RpcErrorCode.NotFound, unknownRecipientMessage(to));
}
