import { describe, expect, it } from "vitest";
import {
  ackEntries,
  advanceEntry,
  createEntry,
  isUnread,
  MAILBOX_STATES,
  markDelivered,
  orderEntries,
  pendingForInjection,
  readInbox,
} from "./mailbox.js";
import { rng, textMessage } from "./testing.js";

const T1 = "2026-11-27T10:00:00.000Z";
const T2 = "2026-11-27T10:00:01.000Z";
const mk = (text: string, urgent = false) => createEntry(textMessage(text, { urgent }), T1);

describe("state machine", () => {
  it("moves forward and stamps each step", () => {
    const e = advanceEntry(advanceEntry(mk("a"), "delivered", T1), "read", T2);
    expect(e).toMatchObject({ state: "read", deliveredAt: T1, readAt: T2 });
    expect(e.ackedAt).toBeUndefined();
  });
  it("fills skipped stamps when jumping ahead", () => {
    const e = advanceEntry(mk("a"), "acked", T2);
    expect(e).toMatchObject({ state: "acked", deliveredAt: T2, readAt: T2, ackedAt: T2 });
  });
  it("never moves backwards (property)", () => {
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      let e = mk("x");
      let max = 0;
      for (let k = 0; k < 6; k++) {
        const to = MAILBOX_STATES[Math.floor(r() * 4)] as (typeof MAILBOX_STATES)[number];
        e = advanceEntry(e, to, T2);
        max = Math.max(max, MAILBOX_STATES.indexOf(to));
        expect(MAILBOX_STATES.indexOf(e.state)).toBe(max);
      }
    }
  });
  it("treats queued and delivered as unread", () => {
    expect(isUnread(mk("a"))).toBe(true);
    expect(isUnread(advanceEntry(mk("a"), "delivered", T1))).toBe(true);
    expect(isUnread(advanceEntry(mk("a"), "read", T1))).toBe(false);
  });
});

describe("ordering", () => {
  it("puts urgent first, then oldest first (property)", () => {
    const r = rng(11);
    const entries = Array.from({ length: 60 }, (_, i) => mk(`m${i}`, r() < 0.3));
    const ordered = orderEntries(entries);
    const firstNormal = ordered.findIndex((e) => !e.message.urgent);
    expect(ordered.slice(firstNormal).every((e) => !e.message.urgent)).toBe(true);
    for (const group of [
      ordered.filter((e) => e.message.urgent),
      ordered.filter((e) => !e.message.urgent),
    ]) {
      const ids = group.map((e) => e.message.id);
      expect(ids).toEqual([...ids].sort());
    }
  });
});

describe("inbox", () => {
  const entries = [mk("a"), mk("b", true), mk("c"), mk("d")];

  it("returns unread by default, urgent first, limited, and marks them read", () => {
    const r = readInbox(entries, { unreadOnly: true, limit: 2 }, T2);
    expect(r.returned.map((e) => (e.message.kind === "text" ? e.message.body.text : ""))).toEqual([
      "b",
      "a",
    ]);
    expect(r.returned.every((e) => e.state === "read")).toBe(true);
    expect(r.unreadCount).toBe(2);
    expect(r.entries.filter((e) => e.state === "queued")).toHaveLength(2);
  });
  it("hides read messages when unreadOnly, shows them otherwise", () => {
    const first = readInbox(entries, { unreadOnly: true, limit: 20 }, T2);
    expect(readInbox(first.entries, { unreadOnly: true, limit: 20 }, T2).returned).toHaveLength(0);
    expect(readInbox(first.entries, { unreadOnly: false, limit: 20 }, T2).returned).toHaveLength(4);
  });
  it("does not downgrade acked messages", () => {
    const acked = ackEntries(entries, [entries[0]?.message.id as never], T2).entries;
    const r = readInbox(acked, { unreadOnly: false, limit: 20 }, T2);
    expect(r.entries.find((e) => e.message.id === entries[0]?.message.id)?.state).toBe("acked");
  });
});

describe("injection and ack", () => {
  it("injects only queued entries and marks them delivered", () => {
    const entries = [mk("a"), mk("b")];
    const pending = pendingForInjection(entries);
    expect(pending).toHaveLength(2);
    const after = markDelivered(
      entries,
      pending.map((e) => e.message.id),
      T2,
    );
    expect(after.every((e) => e.state === "delivered")).toBe(true);
    expect(pendingForInjection(after)).toHaveLength(0);
    expect(readInbox(after, { unreadOnly: true, limit: 20 }, T2).returned).toHaveLength(2);
  });
  it("counts acks once and ignores unknown ids", () => {
    const entries = [mk("a"), mk("b")];
    const ids = [entries[0]?.message.id, textMessage("zz").id] as never[];
    const first = ackEntries(entries, ids, T2);
    expect(first.acked).toBe(1);
    expect(ackEntries(first.entries, ids, T2).acked).toBe(0);
  });
});
