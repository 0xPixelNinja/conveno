import type { Message, MessageId } from "@0xpixelninja/conveno-protocol";

export const MAILBOX_STATES = ["queued", "delivered", "read", "acked"] as const;
export type MailboxState = (typeof MAILBOX_STATES)[number];

export interface MailboxEntry {
  message: Message;
  state: MailboxState;
  /** ISO timestamps of each transition reached. */
  queuedAt: string;
  deliveredAt?: string;
  readAt?: string;
  ackedAt?: string;
}

const rank = (s: MailboxState): number => MAILBOX_STATES.indexOf(s);
const STAMP = {
  queued: "queuedAt",
  delivered: "deliveredAt",
  read: "readAt",
  acked: "ackedAt",
} as const;

export function createEntry(message: Message, at: string): MailboxEntry {
  return { message, state: "queued", queuedAt: at };
}

/**
 * Move an entry forward: queued, delivered, read, acked. Skipping ahead is allowed (an ack of a
 * queued message is valid) and the skipped timestamps are filled with `at`. Never moves
 * backwards: a request for an earlier or equal state returns the entry unchanged.
 */
export function advanceEntry(entry: MailboxEntry, to: MailboxState, at: string): MailboxEntry {
  if (rank(to) <= rank(entry.state)) return entry;
  const next: MailboxEntry = { ...entry, state: to };
  for (const s of MAILBOX_STATES) {
    if (rank(s) > rank(entry.state) && rank(s) <= rank(to)) next[STAMP[s]] = at;
  }
  return next;
}

/**
 * Unread means the agent has never been shown the message: still queued. A message a hook
 * injected (delivered) was already shown, so it is not unread. `inbox` with `unreadOnly = false`
 * still lists it.
 */
export const isUnread = (e: MailboxEntry): boolean => e.state === "queued";

/** Urgent first, then oldest first. Message ids are monotonic ULIDs, so id order is send order. */
export function compareEntries(a: MailboxEntry, b: MailboxEntry): number {
  if (a.message.urgent !== b.message.urgent) return a.message.urgent ? -1 : 1;
  return a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0;
}

export const orderEntries = (entries: readonly MailboxEntry[]): MailboxEntry[] =>
  [...entries].sort(compareEntries);

export interface InboxQuery {
  unreadOnly: boolean;
  limit: number;
}

/**
 * What `inbox` returns: filtered, ordered, limited, with the returned entries moved to `read`.
 * `unreadCount` is the number of unread entries remaining afterwards.
 */
export function readInbox(
  entries: readonly MailboxEntry[],
  query: InboxQuery,
  at: string,
): { returned: MailboxEntry[]; entries: MailboxEntry[]; unreadCount: number } {
  const picked = orderEntries(entries.filter((e) => !query.unreadOnly || isUnread(e))).slice(
    0,
    Math.max(0, query.limit),
  );
  const ids = new Set(picked.map((e) => e.message.id));
  const updated = entries.map((e) => (ids.has(e.message.id) ? advanceEntry(e, "read", at) : e));
  const returned = orderEntries(updated.filter((e) => ids.has(e.message.id)));
  return { returned, entries: updated, unreadCount: updated.filter(isUnread).length };
}

/** Entries to inject into the agent's next turn: still queued, in delivery order. */
export const pendingForInjection = (entries: readonly MailboxEntry[]): MailboxEntry[] =>
  orderEntries(entries.filter((e) => e.state === "queued"));

/** Mark the given entries delivered (hook injection). */
export function markDelivered(
  entries: readonly MailboxEntry[],
  ids: readonly MessageId[],
  at: string,
): MailboxEntry[] {
  const set = new Set<string>(ids);
  return entries.map((e) => (set.has(e.message.id) ? advanceEntry(e, "delivered", at) : e));
}

/** Ack by id. Unknown ids are ignored; already-acked ids are not counted again. */
export function ackEntries(
  entries: readonly MailboxEntry[],
  ids: readonly MessageId[],
  at: string,
): { entries: MailboxEntry[]; acked: number } {
  const set = new Set<string>(ids);
  let acked = 0;
  const out = entries.map((e) => {
    if (!set.has(e.message.id) || e.state === "acked") return e;
    acked++;
    return advanceEntry(e, "acked", at);
  });
  return { entries: out, acked };
}
