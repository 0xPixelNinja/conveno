import {
  type CliKind,
  RpcErrorCode,
  SESSION_NAME_PATTERN,
  type SessionId,
  SessionName,
} from "@conveno/protocol";
import { ConvenoError } from "./errors.js";
import { isOnline } from "./liveness.js";

export interface NamedSession {
  id: SessionId;
  name: string;
  status: "idle" | "busy" | "waiting_on_question" | "offline";
}

const MAX_NAME = 64;

/** Make a directory name safe to embed in a session name: lowercase, `[a-z0-9._-]`, non-empty. */
export function sanitizeNamePart(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
  return cleaned === "" ? "workspace" : cleaned;
}

/**
 * `<cli>@<repo-basename>-<n>` with the lowest `n >= 1` not used by a non-offline session.
 * The repo part is truncated when needed so the whole name fits the protocol limit.
 */
export function generateSessionName(
  cli: CliKind,
  repoBasename: string,
  sessions: readonly Pick<NamedSession, "name" | "status">[],
): string {
  const taken = new Set(sessions.filter(isOnline).map((s) => s.name));
  const prefix = `${cli}@`;
  for (let n = 1; ; n++) {
    const suffix = `-${n}`;
    const room = MAX_NAME - prefix.length - suffix.length;
    const base = sanitizeNamePart(repoBasename).slice(0, room);
    const name = `${prefix}${base}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Validate a rename. Returns the name to store. Throws `ConvenoError`:
 * InvalidParams for a bad name, Conflict when another non-offline session already uses it.
 * Renaming to your own current name is allowed (no-op).
 */
export function validateRename(
  sessionId: SessionId,
  requested: string,
  sessions: readonly NamedSession[],
): string {
  if (!SESSION_NAME_PATTERN.test(requested)) {
    throw new ConvenoError(
      RpcErrorCode.InvalidParams,
      `Invalid session name "${requested}". Use 1 to 64 characters: lowercase letters, digits, ".", "_", "@" or "-", starting with a letter or digit.`,
    );
  }
  const parsed = SessionName.safeParse(requested);
  if (!parsed.success) {
    throw new ConvenoError(
      RpcErrorCode.InvalidParams,
      `"${requested}" is reserved. Pick a different name.`,
    );
  }
  const clash = sessions.find((s) => s.id !== sessionId && isOnline(s) && s.name === requested);
  if (clash) {
    throw new ConvenoError(
      RpcErrorCode.Conflict,
      `The name "${requested}" is already used by an active session. Pick a different name.`,
    );
  }
  return parsed.data;
}
