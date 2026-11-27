import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

/** A context with no daemon running, recording the options of every connect call. */
async function recording() {
  const c = await testCtx({ interactive: false });
  ctxs.push(c);
  const seen: { autoStart?: boolean }[] = [];
  const real = c.connect;
  c.connect = ((o: { autoStart?: boolean }) => {
    seen.push(o);
    return real(o as never);
  }) as never;
  return { c, seen };
}

/**
 * Only commands that need a running daemon may start one. Every other command must connect with
 * autoStart false, so that asking about the daemon never changes the answer.
 */
describe("which commands may start the daemon", () => {
  const readOnly: string[][] = [
    ["daemon", "status"],
    ["daemon", "stop"],
    ["status"],
    ["doctor"],
    ["hook", "claude", "UserPromptSubmit"],
    ["init", "--dry-run"],
    ["uninstall", "--yes"],
  ];
  it.each(readOnly)("%s never auto-starts", async (...argv) => {
    const { c, seen } = await recording();
    await main(argv, c);
    expect(seen.every((o) => o.autoStart === false)).toBe(true);
    expect(existsSync(c.socketPath as string)).toBe(false);
  });

  it("daemon start does", async () => {
    const { c, seen } = await recording();
    await main(["daemon", "start"], c).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((o) => o.autoStart === true)).toBe(true);
  });
});
