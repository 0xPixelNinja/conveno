import { PassThrough } from "node:stream";
import { createTheme } from "@conveno/brand";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { ask } from "./runtime.js";
import { type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

/** A colour theme, as a real terminal gets. The default test theme has colour off, which hid bugs. */
const colourTheme = () =>
  createTheme({
    env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
    isTTY: true,
    platform: "linux",
    color: "always",
  });

/**
 * Interactive `conveno init`, as in a terminal: colour on, a real confirm prompt reading from a
 * fake TTY, then the CLI's own command. The `--yes` path never reaches the prompt, so it cannot
 * catch a failure there.
 */
describe("interactive init", () => {
  it("shows the prompt, takes the answer, and then runs the CLI's own command", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => {
      shown += String(d);
      if (shown.includes("[Y/n]")) setImmediate(() => input.write("y\n"));
    });
    const theme = colourTheme();
    const calls: string[][] = [];
    const stdinWhenCommandRan: boolean[] = [];
    const c = await testCtx({
      theme,
      interactive: true,
      confirm: (q, d) => ask(theme, q, d, { input, output }),
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "--version") return { code: 0, stdout: "2.1.332 (Claude Code)\n" };
        // The prompt must be fully closed before a child starts.
        stdinWhenCommandRan.push(input.isPaused() && input.listenerCount("data") === 0);
        return { code: 1, stdout: "" };
      },
    });
    ctxs.push(c);

    expect(await main(["init"], c)).toBe(0);
    expect(c.errText()).not.toContain("internal error");
    expect(c.outText()).toContain("Done.");
    expect(calls.some((a) => a.join(" ").startsWith("claude mcp add"))).toBe(true);
    expect(stdinWhenCommandRan).toEqual([true]);
    expect(shown).toContain("Apply these changes?");
  });

  it("answering no changes nothing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on("data", (d) => {
      if (String(d).includes("[Y/n]")) setImmediate(() => input.write("n\n"));
    });
    const theme = colourTheme();
    const c = await testCtx({
      theme,
      interactive: true,
      confirm: (q, d) => ask(theme, q, d, { input, output }),
    });
    ctxs.push(c);
    expect(await main(["init"], c)).toBe(0);
    expect(c.outText()).toContain("Nothing was changed.");
  });
});
