import { describe, expect, it } from "vitest";
import { newSessionId, newTicketId } from "./ids.js";
import { NOW } from "./test-utils.js";
import { Ticket } from "./ticket.js";

const open = () => ({
  id: newTicketId(),
  fromSession: newSessionId(),
  question: "Delete the migration?",
  status: "open",
  createdAt: NOW,
});

describe("Ticket", () => {
  it("accepts an open ticket with options", () => {
    expect(Ticket.safeParse({ ...open(), options: ["yes", "no"] }).success).toBe(true);
  });

  it("accepts an answered ticket with all answer fields", () => {
    const t = {
      ...open(),
      status: "answered",
      answer: "no",
      answeredBy: newSessionId(),
      answeredAt: NOW,
    };
    expect(Ticket.safeParse(t).success).toBe(true);
  });

  it("requires answer fields when answered", () => {
    expect(Ticket.safeParse({ ...open(), status: "answered" }).success).toBe(false);
    expect(Ticket.safeParse({ ...open(), status: "answered", answer: "no" }).success).toBe(false);
  });

  it("forbids answer fields on open or cancelled tickets", () => {
    expect(Ticket.safeParse({ ...open(), answer: "sneaky" }).success).toBe(false);
    expect(
      Ticket.safeParse({ ...open(), status: "cancelled", answeredBy: newSessionId() }).success,
    ).toBe(false);
    expect(Ticket.safeParse({ ...open(), status: "cancelled" }).success).toBe(true);
  });

  it("rejects unknown status and empty question", () => {
    expect(Ticket.safeParse({ ...open(), status: "timed_out" }).success).toBe(false);
    expect(Ticket.safeParse({ ...open(), question: "" }).success).toBe(false);
  });
});
