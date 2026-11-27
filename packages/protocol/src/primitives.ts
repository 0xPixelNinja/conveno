import { z } from "zod";

export const CLI_KINDS = [
  "claude",
  "codex",
  "antigravity",
  "cursor",
  "copilot",
  "opencode",
] as const;
export const CliKind = z.enum(CLI_KINDS);
export type CliKind = z.infer<typeof CliKind>;

/** How a message reaches a session, best first. */
export const DELIVERY_TIERS = ["live", "next_turn", "acp", "inbox"] as const;
export const DeliveryTier = z.enum(DELIVERY_TIERS);
export type DeliveryTier = z.infer<typeof DeliveryTier>;

export const SESSION_STATUSES = ["idle", "busy", "waiting_on_question", "offline"] as const;
export const SessionStatus = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9._@-]{0,63}$/;

/** Literal recipient meaning "whoever currently holds the orchestrator role". */
export const ORCHESTRATOR_ALIAS = "orchestrator";

/**
 * Names no session may take. `orchestrator` is the recipient alias; the others are the senders
 * the daemon uses for its own messages, so a session must not pose as them.
 */
export const RESERVED_SESSION_NAMES = ["conveno", ORCHESTRATOR_ALIAS, "system", "user"] as const;
export const isReservedSessionName = (n: string): boolean =>
  (RESERVED_SESSION_NAMES as readonly string[]).includes(n);

/**
 * Human-readable session name, unique per account. Reserved names are refused. ULIDs are
 * uppercase, names are lowercase, so ids and names never collide.
 */
export const SessionName = z
  .string()
  .regex(SESSION_NAME_PATTERN, "invalid session name")
  .refine((n) => !isReservedSessionName(n), { message: "reserved session name" });
export type SessionName = z.infer<typeof SessionName>;

/** UTC ISO-8601 timestamp, e.g. `2026-11-27T09:30:00.000Z`. */
export const IsoTimestamp = z.iso.datetime();
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** Hex-encoded SHA-256 digest (64 lowercase hex chars). */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex sha-256");

/** Standard base64 with padding. */
export const Base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "invalid base64");
