import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import codexAdapter from "@conveno/adapter-codex";
import type { ConfigChange } from "@conveno/core";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { fakeAdapter, type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

const make = async (over: Parameters<typeof testCtx>[0] = {}) => {
  const c = await testCtx(over);
  ctxs.push(c);
  return c;
};

const change = (
  component: ConfigChange["component"],
  kind: ConfigChange["kind"],
): ConfigChange => ({
  component,
  kind,
  path: "/x",
  before: null,
  after: "",
  description: "Whatever wording an adapter chooses, with hook and MCP in it.",
});

/** An adapter with hooks whose plan is the given changes. */
const planned = (...changes: ConfigChange[]) =>
  fakeAdapter({
    cli: "codex",
    displayName: "Codex",
    deliveryTier: "next_turn",
    plan: async () => changes,
  });

describe("doctor: configured, not configured, needs an update", () => {
  it("is quiet about a CLI whose plan is empty", async () => {
    const c = await make({ adapters: [planned()] });
    expect(await main(["doctor"], c)).toBe(0);
    expect(c.errText()).not.toContain("Codex is missing");
    expect(c.errText()).not.toContain("needs an update");
  });

  it("says a CLI that was never set up is missing the MCP server and the hooks", async () => {
    const c = await make({ adapters: [planned(change("mcp", "add"), change("hooks", "add"))] });
    expect(await main(["doctor"], c)).toBe(0);
    expect(c.outText()).toContain("not configured");
    expect(c.outText()).not.toContain("needs update");
    expect(c.errText()).toContain("Codex is missing the MCP server and the hooks.");
    expect(c.errText()).toContain("conveno init");
  });

  it("says an out of date MCP entry needs an update, not that it is missing", async () => {
    const c = await make({ adapters: [planned(change("mcp", "update"))] });
    expect(await main(["doctor"], c)).toBe(0);
    const out = c.outText();
    expect(out).toContain("needs update");
    expect(out).not.toContain("not configured");
    expect(out).toContain("needs an update");
    const err = c.errText();
    expect(err).toContain("Codex needs an update.");
    expect(err).toContain("the MCP server");
    expect(err).not.toContain("is missing");
    expect(err).toContain("fix  Run conveno init");
    expect(out).toMatch(/^0 ok, 2 warnings, 0 problems$/m);
  });

  it("separates the parts: hooks missing and the MCP entry out of date", async () => {
    const c = await make({ adapters: [planned(change("mcp", "update"), change("hooks", "add"))] });
    expect(await main(["doctor"], c)).toBe(0);
    expect(c.errText()).toContain(
      "Codex is missing the hooks and needs an update to the MCP server.",
    );
  });

  it("does not call a part out of date when only the other one is", async () => {
    const c = await make({ adapters: [planned(change("hooks", "update"))] });
    await main(["doctor"], c);
    const row =
      c
        .outText()
        .split("\n")
        .find((l) => l.includes("codex")) ?? "";
    expect(row).toMatch(/yes\s+needs update/);
  });

  it("does not read the description to decide", async () => {
    const c = await make({
      adapters: [
        fakeAdapter({
          cli: "codex",
          displayName: "Codex",
          deliveryTier: "next_turn",
          plan: async () => [{ ...change("mcp", "update"), description: "Add hooks and Add MCP" }],
        }),
      ],
    });
    await main(["doctor"], c);
    expect(c.errText()).toContain("Codex needs an update.");
    expect(c.errText()).not.toContain("the hooks");
  });

  it("treats an adapter without hooks (inbox) by its MCP part alone", async () => {
    const c = await make({
      adapters: [fakeAdapter({ plan: async () => [change("mcp", "update")] })],
    });
    await main(["doctor"], c);
    expect(c.errText()).toContain("Fake CLI needs an update.");
    expect(c.outText()).toMatch(/needs update\s+n\/a/);
  });
});

describe("doctor after an upgrade that adds default_tools_approval_mode (Codex)", () => {
  it("reports needs an update, and the plan changes only the missing line", async () => {
    const c = await make({ adapters: [codexAdapter] });
    const codexVersion = async () => ({ code: 0, stdout: "codex-cli 0.99.1\n" });
    const ctx = { ...c, exec: codexVersion };
    // A 0.1.0 install: the full entry and both hooks, without the approval mode.
    expect(await main(["init", "--yes"], ctx)).toBe(0);
    const config = join(c.home, ".codex", "config.toml");
    const text = await readFile(config, "utf8");
    await writeFile(config, text.replace(/^default_tools_approval_mode.*\n/m, ""));
    c.stdout.length = 0;
    c.stderr.length = 0;

    expect(await main(["doctor"], ctx)).toBe(0);
    expect(c.outText()).toMatch(/codex\s+Codex\s+\S+\s+needs update\s+yes/);
    expect(c.errText()).toContain("Codex needs an update.");
    expect(c.errText()).not.toContain("is missing");
    expect(c.errText()).toContain("conveno init");

    // What init would write: the one new line and nothing else.
    c.stdout.length = 0;
    expect(await main(["init", "--dry-run"], ctx)).toBe(0);
    const added = c
      .outText()
      .split("\n")
      .filter((l) => /^\s*\+(?!\+\+)/.test(l));
    expect(added.map((l) => l.trim())).toEqual(['+default_tools_approval_mode = "approve"']);

    // init repairs it, and doctor is green.
    expect(await main(["init", "--yes"], ctx)).toBe(0);
    c.stdout.length = 0;
    c.stderr.length = 0;
    await main(["doctor"], ctx);
    expect(c.errText()).not.toContain("Codex needs an update");
    expect(c.errText()).not.toContain("Codex is missing");
    expect(c.outText()).toContain("1 ok");
  });
});
