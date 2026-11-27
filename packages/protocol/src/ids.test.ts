import { describe, expect, it } from "vitest";
import {
  DeviceId,
  MessageId,
  newMessageId,
  newSessionId,
  newTicketId,
  SessionId,
  TicketId,
} from "./ids.js";

describe("ids", () => {
  it("generates valid 26-char ULIDs accepted by every id schema", () => {
    const id = newSessionId();
    expect(id).toHaveLength(26);
    for (const schema of [SessionId, MessageId, TicketId, DeviceId]) {
      expect(schema.safeParse(id).success).toBe(true);
    }
  });

  it("generates strictly increasing ids, even within one millisecond", () => {
    const ids = Array.from({ length: 1000 }, () => newMessageId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(1000);
  });

  it("rejects malformed ids", () => {
    const bad = [
      "",
      "abc",
      "01ARZ3NDEKTSV4RRFFQ69G5FA", // 25 chars
      "01ARZ3NDEKTSV4RRFFQ69G5FAVV", // 27 chars
      "01arz3ndektsv4rrffq69g5fav", // lowercase
      "01ARZ3NDEKTSV4RRFFQ69G5FAI", // contains I
      "81ARZ3NDEKTSV4RRFFQ69G5FAV", // timestamp overflow
    ];
    for (const b of bad) expect(SessionId.safeParse(b).success, b).toBe(false);
    expect(SessionId.safeParse(123).success).toBe(false);
    expect(TicketId.safeParse(undefined).success).toBe(false);
  });

  it("accepts a known-good ULID", () => {
    expect(SessionId.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
  });

  it("creates ticket ids", () => {
    expect(TicketId.safeParse(newTicketId()).success).toBe(true);
  });
});
