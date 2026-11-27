import { describe, expect, it } from "vitest";
import { messageFixture, ticketIdFixture } from "./fixtures.js";
import { newMessageId, newSessionId } from "./ids.js";
import { Message, Recipient, TEXT_MAX_BYTES } from "./message.js";
import { parseMessage } from "./parse.js";

describe("Recipient", () => {
  it("accepts a session id, a name, and the orchestrator alias", () => {
    expect(Recipient.safeParse(newSessionId()).success).toBe(true);
    expect(Recipient.safeParse("codex@repo-2").success).toBe(true);
    expect(Recipient.safeParse("orchestrator").success).toBe(true);
  });
  it("rejects garbage", () => {
    expect(Recipient.safeParse("Not A Name").success).toBe(false);
    expect(Recipient.safeParse("").success).toBe(false);
    expect(Recipient.safeParse(5).success).toBe(false);
  });
});

describe("Message", () => {
  it("parses a text message and defaults urgent to false", () => {
    const r = Message.parse(messageFixture());
    expect(r.kind).toBe("text");
    expect(r.urgent).toBe(false);
  });

  it("keeps urgent=true and replyTo", () => {
    const replyTo = newMessageId();
    const r = Message.parse(messageFixture({ urgent: true, replyTo }));
    expect(r.urgent).toBe(true);
    expect(r.replyTo).toBe(replyTo);
  });

  it("accepts all three recipient forms", () => {
    for (const to of ["orchestrator", newSessionId(), "claude@repo-1"]) {
      expect(Message.safeParse(messageFixture({ to })).success).toBe(true);
    }
  });

  it("enforces the 64 KiB text limit in bytes, not characters", () => {
    const ok = "a".repeat(TEXT_MAX_BYTES);
    expect(Message.safeParse(messageFixture({ body: { text: ok } })).success).toBe(true);
    expect(Message.safeParse(messageFixture({ body: { text: `${ok}a` } })).success).toBe(false);
    // 3 bytes per char: 21846 chars = 65538 bytes
    expect(Message.safeParse(messageFixture({ body: { text: "€".repeat(21846) } })).success).toBe(
      false,
    );
    expect(Message.safeParse(messageFixture({ body: { text: "€".repeat(21845) } })).success).toBe(
      true,
    );
  });

  it("parses a handoff", () => {
    const body = {
      goal: "ship it",
      state: "tests green",
      nextSteps: ["merge"],
      filesTouched: ["a.ts"],
    };
    expect(Message.safeParse(messageFixture({ kind: "handoff", body })).success).toBe(true);
    expect(
      Message.safeParse(messageFixture({ kind: "handoff", body: { ...body, goal: "" } })).success,
    ).toBe(false);
    expect(
      Message.safeParse(messageFixture({ kind: "handoff", body: { goal: "x" } })).success,
    ).toBe(false);
  });

  it("parses a question with and without options", () => {
    const ticketId = ticketIdFixture();
    expect(
      Message.safeParse(messageFixture({ kind: "question", body: { ticketId, question: "ok?" } }))
        .success,
    ).toBe(true);
    expect(
      Message.safeParse(
        messageFixture({
          kind: "question",
          body: { ticketId, question: "ok?", options: ["y", "n"] },
        }),
      ).success,
    ).toBe(true);
    expect(
      Message.safeParse(
        messageFixture({ kind: "question", body: { ticketId, question: "ok?", options: [] } }),
      ).success,
    ).toBe(false);
    expect(
      Message.safeParse(messageFixture({ kind: "question", body: { question: "ok?" } })).success,
    ).toBe(false);
  });

  it("parses an answer", () => {
    const ticketId = ticketIdFixture();
    expect(
      Message.safeParse(messageFixture({ kind: "answer", body: { ticketId, response: "yes" } }))
        .success,
    ).toBe(true);
    expect(
      Message.safeParse(messageFixture({ kind: "answer", body: { ticketId, response: "" } }))
        .success,
    ).toBe(false);
  });

  it("parses system messages", () => {
    expect(
      Message.safeParse(messageFixture({ kind: "system", body: { event: "orchestrator.changed" } }))
        .success,
    ).toBe(true);
    expect(
      Message.safeParse(messageFixture({ kind: "system", body: { event: "x", detail: "d" } }))
        .success,
    ).toBe(true);
    expect(Message.safeParse(messageFixture({ kind: "system", body: {} })).success).toBe(false);
  });

  it("rejects a body that does not match its kind", () => {
    expect(
      Message.safeParse(messageFixture({ kind: "handoff", body: { text: "hi" } })).success,
    ).toBe(false);
    expect(Message.safeParse(messageFixture({ kind: "text", body: { goal: "g" } })).success).toBe(
      false,
    );
  });

  it("rejects unknown kinds and missing fields", () => {
    expect(Message.safeParse(messageFixture({ kind: "shout" })).success).toBe(false);
    for (const k of ["id", "from", "to", "kind", "body", "createdAt"]) {
      const m = messageFixture() as Record<string, unknown>;
      delete m[k];
      expect(Message.safeParse(m).success, k).toBe(false);
    }
  });

  it("parseMessage returns a result object instead of throwing", () => {
    const good = parseMessage(messageFixture());
    expect(good.ok).toBe(true);
    const bad = parseMessage({ nope: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.issues.length).toBeGreaterThan(0);
    expect(parseMessage(null).ok).toBe(false);
  });
});
