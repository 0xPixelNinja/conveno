import { monotonicFactory } from "ulid";
import { z } from "zod";

/** Crockford base32, uppercase, 26 chars. First char is 0-7 (48-bit timestamp must not overflow). */
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const ulid = (what: string) => z.string().regex(ULID_RE, `${what} must be a ULID`);

export const SessionId = ulid("SessionId").brand<"SessionId">();
export type SessionId = z.infer<typeof SessionId>;

export const MessageId = ulid("MessageId").brand<"MessageId">();
export type MessageId = z.infer<typeof MessageId>;

export const TicketId = ulid("TicketId").brand<"TicketId">();
export type TicketId = z.infer<typeof TicketId>;

export const DeviceId = ulid("DeviceId").brand<"DeviceId">();
export type DeviceId = z.infer<typeof DeviceId>;

export const AccountId = ulid("AccountId").brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

// One monotonic generator per process so ids created in the same millisecond still sort in order.
const next = monotonicFactory();

export const newSessionId = (): SessionId => SessionId.parse(next());
export const newMessageId = (): MessageId => MessageId.parse(next());
export const newTicketId = (): TicketId => TicketId.parse(next());
export const newDeviceId = (): DeviceId => DeviceId.parse(next());
export const newAccountId = (): AccountId => AccountId.parse(next());
