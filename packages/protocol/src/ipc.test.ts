import { describe, expect, it } from "vitest";
import { messageFixture, NOW, sessionFixture } from "./fixtures.js";
import { newMessageId, newSessionId, newTicketId } from "./ids.js";
import {
  EVENT_NAMES,
  EventNotification,
  errorResponseFor,
  IPC_METHOD_NAMES,
  ipcMethods,
  makeEventNotification,
  parseIpcRequest,
} from "./ipc.js";
import { makeRequest, RpcErrorCode, RpcResponse } from "./rpc.js";
import { PROTOCOL_VERSION } from "./version.js";

const sid = newSessionId();
const req = (method: string, params?: Record<string, unknown>, id: string | number = 1) =>
  parseIpcRequest(makeRequest(id, method, params));

function okParams(method: string, params?: Record<string, unknown>) {
  const r = req(method, params);
  if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
  return r.request.params as Record<string, unknown>;
}

describe("method table", () => {
  it("defines every method the spec requires", () => {
    expect([...IPC_METHOD_NAMES].sort()).toEqual(
      [
        "hello",
        "auth",
        "session.register",
        "session.heartbeat",
        "session.unregister",
        "session.rename",
        "session.setStatus",
        "session.list",
        "session.byHost",
        "message.deliver",
        "orchestrator.claim",
        "message.send",
        "message.inbox",
        "message.ack",
        "ticket.create",
        "ticket.answer",
        "spawn.request",
        "peek.request",
        "events.subscribe",
      ].sort(),
    );
  });

  it("PROTOCOL_VERSION is conveno/1", () => {
    expect(PROTOCOL_VERSION).toBe("conveno/1");
  });
});

describe("parseIpcRequest: envelope", () => {
  it("rejects non-objects and wrong jsonrpc versions as InvalidRequest", () => {
    for (const bad of [null, 5, "x", [], { jsonrpc: "1.0", id: 1, method: "hello" }]) {
      const r = parseIpcRequest(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(RpcErrorCode.InvalidRequest);
    }
  });

  it("rejects a request without an id (client notifications are not supported)", () => {
    const r = parseIpcRequest({ jsonrpc: "2.0", method: "session.list" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.id).toBeNull();
  });

  it("echoes a valid id on a malformed request so the reply can be correlated", () => {
    const r = parseIpcRequest({ jsonrpc: "2.0", id: 9, method: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.id).toBe(9);
  });

  it("returns MethodNotFound for unknown methods, including prototype names", () => {
    for (const m of ["nope", "toString", "__proto__", "constructor"]) {
      const r = req(m);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(RpcErrorCode.MethodNotFound);
    }
  });

  it("returns InvalidParams with issues, and the id, for bad params", () => {
    const r = req("session.rename", { sessionId: sid, name: "BAD NAME" }, "r1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.id).toBe("r1");
      expect(r.error.code).toBe(RpcErrorCode.InvalidParams);
      expect(Array.isArray(r.error.data)).toBe(true);
      expect(RpcResponse.safeParse(errorResponseFor(r)).success).toBe(true);
    }
  });

  it("treats missing params as an empty object", () => {
    const p = okParams("session.list");
    expect(p).toEqual({ includeOffline: false });
  });
});

const HEX = "ab".repeat(32);

describe("hello and auth", () => {
  it("accepts a handshake with a nonce and validates its result", () => {
    const p = okParams("hello", { protocolVersion: PROTOCOL_VERSION, client: "mcp", nonce: HEX });
    expect(p.client).toBe("mcp");
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: "0.1.0",
      proof: HEX,
      challenge: HEX,
    };
    expect(ipcMethods.hello.result.safeParse(result).success).toBe(true);
    expect(
      ipcMethods.hello.result.safeParse({ ...result, protocolVersion: "conveno/2" }).success,
    ).toBe(false);
    expect(ipcMethods.hello.result.safeParse({ ...result, proof: undefined }).success).toBe(false);
  });

  it("requires a well formed nonce and a known client kind", () => {
    const base = { protocolVersion: PROTOCOL_VERSION, client: "mcp" };
    expect(req("hello", base).ok).toBe(false);
    expect(req("hello", { ...base, nonce: "short" }).ok).toBe(false);
    expect(req("hello", { ...base, nonce: HEX.toUpperCase() }).ok).toBe(false);
    expect(req("hello", { ...base, client: "browser", nonce: HEX }).ok).toBe(false);
  });

  it("does not take a token in hello", () => {
    const r = req("hello", {
      protocolVersion: PROTOCOL_VERSION,
      client: "mcp",
      nonce: HEX,
      authToken: "t",
    });
    expect(r.ok && "authToken" in r.request.params).toBe(false);
  });

  it("auth takes a hex proof", () => {
    expect(okParams("auth", { proof: HEX }).proof).toBe(HEX);
    expect(req("auth", { proof: "nope" }).ok).toBe(false);
    expect(req("auth", {}).ok).toBe(false);
  });
});

describe("session.*", () => {
  it("register: requires cli and cwd; name optional", () => {
    expect(req("session.register", { cli: "codex", cwd: "/r" }).ok).toBe(true);
    expect(
      req("session.register", {
        cli: "codex",
        cwd: "/r",
        name: "codex-1",
        pid: 1,
        hostPid: 2,
        repo: { root: "/r" },
      }).ok,
    ).toBe(true);
    expect(req("session.register", { cwd: "/r" }).ok).toBe(false);
    expect(req("session.register", { cli: "emacs", cwd: "/r" }).ok).toBe(false);
    expect(req("session.register", { cli: "codex", cwd: "/r", name: "Bad Name" }).ok).toBe(false);
  });

  it("heartbeat/unregister/claim require a session id", () => {
    for (const m of ["session.heartbeat", "session.unregister", "orchestrator.claim"]) {
      expect(req(m, { sessionId: sid }).ok, m).toBe(true);
      expect(req(m, {}).ok, m).toBe(false);
      expect(req(m, { sessionId: "nope" }).ok, m).toBe(false);
    }
  });

  it("rename validates the name", () => {
    expect(req("session.rename", { sessionId: sid, name: "planner" }).ok).toBe(true);
    expect(req("session.rename", { sessionId: sid, name: "orchestrator" }).ok).toBe(false);
  });

  it("setStatus needs status and/or statusText (null clears)", () => {
    expect(req("session.setStatus", { sessionId: sid, status: "busy" }).ok).toBe(true);
    expect(req("session.setStatus", { sessionId: sid, statusText: "working" }).ok).toBe(true);
    expect(req("session.setStatus", { sessionId: sid, statusText: null }).ok).toBe(true);
    expect(req("session.setStatus", { sessionId: sid }).ok).toBe(false);
    expect(req("session.setStatus", { sessionId: sid, statusText: "x".repeat(201) }).ok).toBe(
      false,
    );
    expect(req("session.setStatus", { sessionId: sid, status: "asleep" }).ok).toBe(false);
  });

  it("list accepts filters and defaults includeOffline to false", () => {
    expect(okParams("session.list", { repo: "/r", cli: "claude" })).toEqual({
      repo: "/r",
      cli: "claude",
      includeOffline: false,
    });
    expect(okParams("session.list", { includeOffline: true }).includeOffline).toBe(true);
    expect(req("session.list", { cli: "vim" }).ok).toBe(false);
    expect(
      ipcMethods["session.list"].result.safeParse({ sessions: [sessionFixture()] }).success,
    ).toBe(true);
  });
});

describe("message.*", () => {
  it("send: text with defaults", () => {
    const p = okParams("message.send", {
      sessionId: sid,
      to: "orchestrator",
      kind: "text",
      body: { text: "hi" },
    });
    expect(p.urgent).toBe(false);
  });

  it("send: every kind", () => {
    const ticketId = newTicketId();
    const bodies: [string, unknown][] = [
      ["text", { text: "t" }],
      ["handoff", { goal: "g", state: "s", nextSteps: [], filesTouched: [] }],
      ["question", { ticketId, question: "q" }],
      ["answer", { ticketId, response: "r" }],
      ["system", { event: "e" }],
    ];
    for (const [kind, body] of bodies) {
      expect(
        req("message.send", {
          sessionId: sid,
          to: "peer-1",
          kind,
          body,
          urgent: true,
          replyTo: newMessageId(),
        }).ok,
        kind,
      ).toBe(true);
    }
  });

  it("send: rejects mismatched body, bad recipient, missing sender", () => {
    expect(
      req("message.send", { sessionId: sid, to: "x", kind: "handoff", body: { text: "t" } }).ok,
    ).toBe(false);
    expect(
      req("message.send", { sessionId: sid, to: "BAD", kind: "text", body: { text: "t" } }).ok,
    ).toBe(false);
    expect(req("message.send", { to: "x", kind: "text", body: { text: "t" } }).ok).toBe(false);
    expect(
      req("message.send", {
        sessionId: sid,
        to: "x",
        kind: "text",
        body: { text: "t" },
        urgent: "yes",
      }).ok,
    ).toBe(false);
  });

  it("send result carries the stored message and the delivery tier", () => {
    const schema = ipcMethods["message.send"].result;
    const deliveredTo = { id: newSessionId(), name: "codex@api-1" };
    expect(
      schema.safeParse({ message: messageFixture(), delivery: "inbox", deliveredTo }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ message: messageFixture(), delivery: "pigeon", deliveredTo }).success,
    ).toBe(false);
    expect(schema.safeParse({ message: messageFixture(), delivery: "inbox" }).success).toBe(false);
  });

  it("byHost: needs a positive int host pid; result allows null", () => {
    expect(req("session.byHost", { hostPid: 42 }).ok).toBe(true);
    expect(req("session.byHost", { hostPid: 0 }).ok).toBe(false);
    expect(req("session.byHost", {}).ok).toBe(false);
    const r = ipcMethods["session.byHost"].result;
    expect(r.safeParse({ session: null }).success).toBe(true);
    expect(r.safeParse({ session: sessionFixture({ hostPid: 42 }) }).success).toBe(true);
    expect(r.safeParse({}).success).toBe(false);
  });

  it("deliver: defaults and bounds", () => {
    expect(okParams("message.deliver", { sessionId: sid })).toMatchObject({ limit: 20 });
    expect(req("message.deliver", { sessionId: sid, limit: 0 }).ok).toBe(false);
    expect(req("message.deliver", { sessionId: sid, limit: 201 }).ok).toBe(false);
    expect(req("message.deliver", {}).ok).toBe(false);
    const r = ipcMethods["message.deliver"].result;
    expect(r.safeParse({ messages: [messageFixture()], remaining: 0 }).success).toBe(true);
    expect(r.safeParse({ messages: [], remaining: -1 }).success).toBe(false);
  });

  it("inbox: defaults and bounds", () => {
    expect(okParams("message.inbox", { sessionId: sid })).toMatchObject({
      unreadOnly: true,
      limit: 50,
    });
    expect(req("message.inbox", { sessionId: sid, limit: 0 }).ok).toBe(false);
    expect(req("message.inbox", { sessionId: sid, limit: 201 }).ok).toBe(false);
    expect(req("message.inbox", { sessionId: sid, limit: 200, unreadOnly: false }).ok).toBe(true);
  });

  it("ack: 1..100 ids", () => {
    expect(req("message.ack", { sessionId: sid, ids: [newMessageId()] }).ok).toBe(true);
    expect(req("message.ack", { sessionId: sid, ids: [] }).ok).toBe(false);
    expect(
      req("message.ack", { sessionId: sid, ids: Array.from({ length: 101 }, () => newMessageId()) })
        .ok,
    ).toBe(false);
    expect(req("message.ack", { sessionId: sid, ids: ["nope"] }).ok).toBe(false);
  });
});

describe("ticket.*", () => {
  it("create and answer", () => {
    expect(req("ticket.create", { sessionId: sid, question: "ok?", options: ["y", "n"] }).ok).toBe(
      true,
    );
    expect(req("ticket.create", { sessionId: sid, question: "" }).ok).toBe(false);
    expect(
      req("ticket.answer", { sessionId: sid, ticketId: newTicketId(), response: "y" }).ok,
    ).toBe(true);
    expect(req("ticket.answer", { sessionId: sid, ticketId: "bad", response: "y" }).ok).toBe(false);
    expect(req("ticket.answer", { sessionId: sid, ticketId: newTicketId(), response: "" }).ok).toBe(
      false,
    );
  });
});

describe("spawn.request", () => {
  it("defaults mode to visible", () => {
    expect(okParams("spawn.request", { sessionId: sid, cli: "codex", prompt: "do x" }).mode).toBe(
      "visible",
    );
  });

  it("accepts headless with cwd and name; rejects bad input", () => {
    expect(
      req("spawn.request", {
        sessionId: sid,
        cli: "claude",
        prompt: "p",
        mode: "headless",
        cwd: "/r",
        name: "w-1",
      }).ok,
    ).toBe(true);
    expect(req("spawn.request", { sessionId: sid, cli: "claude", prompt: "" }).ok).toBe(false);
    expect(
      req("spawn.request", { sessionId: sid, cli: "claude", prompt: "p", mode: "background" }).ok,
    ).toBe(false);
    expect(req("spawn.request", { sessionId: sid, cli: "nano", prompt: "p" }).ok).toBe(false);
  });
});

describe("peek.request", () => {
  it("accepts all modes and either id or name as target", () => {
    for (const mode of ["recent", "full", "summary"]) {
      expect(req("peek.request", { sessionId: sid, session: "codex-1", mode }).ok, mode).toBe(true);
    }
    expect(
      req("peek.request", { sessionId: sid, session: newSessionId(), mode: "recent", n: 20 }).ok,
    ).toBe(true);
  });

  it("rejects bad mode, n and target", () => {
    expect(req("peek.request", { sessionId: sid, session: "x", mode: "tail" }).ok).toBe(false);
    expect(req("peek.request", { sessionId: sid, session: "x", mode: "recent", n: 0 }).ok).toBe(
      false,
    );
    expect(req("peek.request", { sessionId: sid, session: "X Y", mode: "recent" }).ok).toBe(false);
  });

  it("result must be flagged redacted", () => {
    const schema = ipcMethods["peek.request"].result;
    const base = {
      session: sid,
      mode: "recent",
      turns: [{ role: "user", text: "hi" }],
      truncated: false,
    };
    expect(schema.safeParse({ ...base, redacted: true }).success).toBe(true);
    expect(schema.safeParse({ ...base, redacted: false }).success).toBe(false);
  });
});

describe("events", () => {
  it("subscribe accepts known topics only", () => {
    expect(req("events.subscribe", { sessionId: sid }).ok).toBe(true);
    expect(
      req("events.subscribe", { sessionId: sid, topics: ["message.received", "ticket.created"] })
        .ok,
    ).toBe(true);
    expect(req("events.subscribe", { sessionId: sid, topics: ["nope"] }).ok).toBe(false);
    expect(req("events.subscribe", { sessionId: sid, topics: [] }).ok).toBe(false);
  });

  it("validates every notification type", () => {
    const ticket = {
      id: newTicketId(),
      fromSession: sid,
      question: "q",
      status: "open",
      createdAt: NOW,
    };
    const payloads = [
      { event: "message.received", data: { message: messageFixture() } },
      { event: "ticket.created", data: { ticket } },
      {
        event: "ticket.answered",
        data: {
          ticket: { ...ticket, status: "answered", answer: "a", answeredBy: sid, answeredAt: NOW },
        },
      },
      { event: "session.updated", data: { session: sessionFixture(), change: "registered" } },
      { event: "orchestrator.changed", data: { orchestrator: sid, previous: null } },
    ];
    expect(payloads.map((p) => p.event)).toEqual([...EVENT_NAMES]);
    for (const p of payloads) {
      const n = makeEventNotification(p as never);
      expect(EventNotification.safeParse(n).success, p.event).toBe(true);
      expect(n.method).toBe("event");
    }
  });

  it("rejects an event whose data does not match its name", () => {
    expect(
      EventNotification.safeParse({
        jsonrpc: "2.0",
        method: "event",
        params: { event: "ticket.created", data: { message: messageFixture() } },
      }).success,
    ).toBe(false);
    expect(
      EventNotification.safeParse({
        jsonrpc: "2.0",
        method: "event",
        params: { event: "x", data: {} },
      }).success,
    ).toBe(false);
  });
});
