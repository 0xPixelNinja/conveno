import { newSessionId } from "@conveno/protocol";
import { describe, expect, it } from "vitest";
import type { HookContext } from "./adapter.js";
import type { ConvenoClient } from "./client.js";
import { pendingHookContext } from "./hook-delivery.js";
import { textMessage } from "./test-utils.js";

const ctxWith = (client: Partial<ConvenoClient>): HookContext => ({
  client: client as ConvenoClient,
  hostPid: 4242,
});

describe("pendingHookContext", () => {
  it("frames the delivered messages for the session that owns the host pid", async () => {
    const asked: unknown[] = [];
    const session = { id: newSessionId() };
    const text = await pendingHookContext(
      ctxWith({
        "session.byHost": async (p) => {
          asked.push(p);
          return { session } as never;
        },
        "message.deliver": async () => ({ messages: [textMessage("hi there")], remaining: 0 }),
      }),
    );
    expect(asked).toEqual([{ pid: 4242 }]);
    expect(text).toContain("1 new message from other sessions");
    expect(text).toContain("hi there");
  });

  it("is null when no session owns the process", async () => {
    const text = await pendingHookContext(
      ctxWith({ "session.byHost": async () => ({ session: null }) as never }),
    );
    expect(text).toBeNull();
  });

  it("is null when nothing is waiting", async () => {
    const text = await pendingHookContext(
      ctxWith({
        "session.byHost": async () => ({ session: { id: newSessionId() } }) as never,
        "message.deliver": async () => ({ messages: [], remaining: 0 }),
      }),
    );
    expect(text).toBeNull();
  });

  it("is null when the daemon is unreachable", async () => {
    const text = await pendingHookContext(
      ctxWith({
        "session.byHost": async () => {
          throw new Error("no daemon");
        },
      }),
    );
    expect(text).toBeNull();
  });
});
