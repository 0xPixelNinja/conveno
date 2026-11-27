import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

describe("an unexpected error", () => {
  it("shows its cause, and keeps the stack in a private log file", async () => {
    const c = await testCtx({
      interactive: true,
      confirm: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'ansi256')");
      },
    });
    ctxs.push(c);
    expect(await main(["init"], c)).toBe(1);
    const err = c.errText();
    expect(err).toContain("TypeError: Cannot read properties of undefined (reading 'ansi256')");
    expect(err).not.toContain("Conveno hit an internal error.");
    expect(err).toContain("ref e_internal");
    const logged = /The full error is in (\S+error\.log)/.exec(err)?.[1];
    expect(logged).toBeDefined();
    const file = (logged as string).replace("~", c.home);
    const text = await readFile(file, "utf8");
    expect(text).toContain("TypeError: Cannot read properties of undefined");
    expect(text).toContain("at ");
    expect(text).toContain("ref       e_internal");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("still reports the cause when the log cannot be written", async () => {
    const c = await testCtx({
      interactive: true,
      dataDir: "\0not-a-path",
      confirm: async () => {
        throw new RangeError("out of range");
      },
    });
    ctxs.push(c);
    expect(await main(["init"], c)).toBe(1);
    expect(c.errText()).toContain("RangeError: out of range");
    expect(c.errText()).not.toContain("The full error is in");
  });
});
