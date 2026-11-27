import { createTheme } from "@conveno/brand";
import { connect } from "@conveno/client";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { startTestDaemon, type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

/** What a colour terminal gets. The default test theme has colour off, which hid two crashes. */
const colour = (env: Record<string, string> = { TERM: "xterm-256color" }) =>
  createTheme({
    env: { LANG: "en_US.UTF-8", ...env },
    isTTY: true,
    platform: "linux",
    color: "always",
  });

const ESC = "\u001b[";

/**
 * Run every command with colour on. A role or glyph without a colour throws only here, so a
 * command that prints fine when piped can still crash in a terminal.
 */
describe("every command in a colour terminal", () => {
  const levels: [string, Record<string, string>][] = [
    ["256 colours", { TERM: "xterm-256color" }],
    ["16 colours", { TERM: "xterm" }],
    ["truecolor", { TERM: "xterm-256color", COLORTERM: "truecolor" }],
  ];

  it.each(levels)("status with sessions (%s)", async (_name, env) => {
    const c = await testCtx({ theme: colour(env), interactive: true });
    ctxs.push(c);
    const d = await startTestDaemon(c);
    const client = await connect({
      kind: "mcp",
      dataDir: c.dataDir,
      socketPath: c.socketPath as string,
      autoStart: false,
    });
    try {
      const reg = (over: Record<string, unknown>) =>
        client["session.register"]({
          cwd: "/work/api",
          repo: { root: "/work/api" },
          ...over,
        } as never);
      const a = await reg({
        cli: "claude",
        pid: process.pid,
        hostPid: process.pid,
        hostPids: [process.pid],
      });
      await reg({ cli: "codex" });
      await client["orchestrator.claim"]({ sessionId: a.session.id });
      expect(await main(["status"], c)).toBe(0);
      expect(c.errText()).toBe("");
      expect(c.outText()).toContain(ESC);
      expect(c.outText()).toContain("daemon up");
    } finally {
      await client.close();
      await d.stop();
    }
  });

  const argvs: string[][] = [
    ["status"],
    ["doctor"],
    ["daemon", "status"],
    ["daemon", "stop"],
    ["init", "--dry-run"],
    ["uninstall", "--yes"],
    ["--help"],
    ["init", "--help"],
    ["nope"],
    ["init", "--cli", "vim"],
    ["daemon"],
    ["mcp"],
  ];
  it.each(argvs)("%s never reports an internal error", async (...argv) => {
    const c = await testCtx({ theme: colour(), interactive: true });
    ctxs.push(c);
    await main(argv, c);
    expect(c.errText()).not.toContain("e_internal");
    expect(c.errText()).not.toContain("stopped before it could finish");
  });

  it("works when the terminal reports no width", async () => {
    // Conveno does not read the terminal width, so a missing or zero `columns` cannot matter.
    const before = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    for (const columns of [undefined, 0]) {
      Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
      const c = await testCtx({ theme: colour(), interactive: true });
      ctxs.push(c);
      expect(await main(["status"], c)).toBe(0);
      expect(c.errText()).not.toContain("e_internal");
    }
    if (before) Object.defineProperty(process.stdout, "columns", before);
    else Reflect.deleteProperty(process.stdout, "columns");
  });
});
