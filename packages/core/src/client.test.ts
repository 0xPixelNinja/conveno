import { describe, expect, expectTypeOf, it } from "vitest";
import type { Adapter } from "./adapter.js";
import type { ConvenoClient } from "./client.js";

describe("ConvenoClient types", () => {
  it("lets callers omit schema defaults and returns typed results", () => {
    expectTypeOf<Parameters<ConvenoClient["session.list"]>[0]>().toEqualTypeOf<{
      repo?: string | undefined;
      cli?: "claude" | "codex" | "antigravity" | "cursor" | "copilot" | "opencode" | undefined;
      includeOffline?: boolean | undefined;
    }>();
    expectTypeOf<Awaited<ReturnType<ConvenoClient["message.ack"]>>>().toEqualTypeOf<{
      acked: number;
    }>();
    expectTypeOf<Adapter["deliveryTier"]>().toEqualTypeOf<"next_turn" | "inbox">();
    expect(true).toBe(true);
  });
});
