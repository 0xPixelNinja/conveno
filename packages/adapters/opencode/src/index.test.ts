import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnv } from "@0xpixelninja/conveno-core";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeAdapter } from "./index.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "conveno-oc-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function envFor(exec?: AdapterEnv["exec"]): AdapterEnv {
  return {
    home,
    platform: process.platform,
    cwd: home,
    exec: exec ?? (async () => ({ code: 0, stdout: "1.2.3\n" })),
    conveno: { command: ["conveno"] },
  };
}

async function seed(name: string, text: string): Promise<string> {
  const dir = join(home, ".config", "opencode");
  await mkdir(dir, { recursive: true });
  const p = join(dir, name);
  await writeFile(p, text);
  return p;
}

const ENTRY = { type: "local", command: ["conveno", "mcp", "--cli", "opencode"] };

const parsed = (s: string | undefined): any => parse(s ?? "");

describe("opencodeAdapter", () => {
  it("has the expected identity", () => {
    expect(opencodeAdapter.cli).toBe("opencode");
    expect(opencodeAdapter.deliveryTier).toBe("inbox");
  });

  it("creates opencode.json when no config exists", async () => {
    const [c] = await opencodeAdapter.plan(envFor());
    expect(c?.before).toBeNull();
    expect(c?.path).toBe(join(home, ".config", "opencode", "opencode.json"));
    expect(parsed(c?.after)).toEqual({ mcp: { servers: { conveno: ENTRY } } });
  });

  it("adds to an existing JSON config and keeps other keys", async () => {
    await seed(
      "opencode.json",
      '{"theme":"x","mcp":{"servers":{"other":{"type":"local","command":["a"]}}}}',
    );
    const [c] = await opencodeAdapter.plan(envFor());
    const after = parsed(c?.after);
    expect(after.theme).toBe("x");
    expect(after.mcp.servers.other).toEqual({ type: "local", command: ["a"] });
    expect(after.mcp.servers.conveno).toEqual(ENTRY);
  });

  it("preserves comments and trailing commas in JSONC", async () => {
    const text = `{
  // my theme
  "theme": "x", /* inline */
  "mcp": {
    "servers": {
      // keep me
      "other": { "type": "local", "command": ["a"], },
    },
  },
}
`;
    const p = await seed("opencode.jsonc", text);
    const [c] = await opencodeAdapter.plan(envFor());
    expect(c?.path).toBe(p);
    expect(c?.after).toContain("// my theme");
    expect(c?.after).toContain("/* inline */");
    expect(c?.after).toContain("// keep me");
    expect(parsed(c?.after).mcp.servers.conveno).toEqual(ENTRY);
  });

  it("is idempotent when already installed", async () => {
    await seed("opencode.json", JSON.stringify({ mcp: { servers: { conveno: ENTRY } } }));
    expect(await opencodeAdapter.plan(envFor())).toEqual([]);
  });

  it("rewrites a stale conveno entry", async () => {
    await seed(
      "opencode.json",
      JSON.stringify({ mcp: { servers: { conveno: { type: "local", command: ["old"] } } } }),
    );
    const [c] = await opencodeAdapter.plan(envFor());
    expect(parsed(c?.after).mcp.servers.conveno).toEqual(ENTRY);
  });

  it("refuses a malformed config without changing it", async () => {
    await seed("opencode.json", '{"mcp": {');
    await expect(opencodeAdapter.plan(envFor())).rejects.toThrow(/Cannot read .*opencode\.json/);
    await expect(opencodeAdapter.uninstallPlan(envFor())).rejects.toThrow(/Cannot read/);
  });

  it("uninstall removes only the conveno entry and keeps comments", async () => {
    await seed(
      "opencode.jsonc",
      `{
  // note
  "mcp": { "servers": { "other": { "type": "local", "command": ["a"] }, "conveno": ${JSON.stringify(ENTRY)} } }
}
`,
    );
    const [c] = await opencodeAdapter.uninstallPlan(envFor());
    const after = parsed(c?.after);
    expect(after.mcp.servers.conveno).toBeUndefined();
    expect(after.mcp.servers.other).toBeDefined();
    expect(c?.after).toContain("// note");
  });

  it("uninstall is empty when absent or no config", async () => {
    expect(await opencodeAdapter.uninstallPlan(envFor())).toEqual([]);
    await seed("opencode.json", "{}");
    expect(await opencodeAdapter.uninstallPlan(envFor())).toEqual([]);
  });

  it("detect reads the version and handles a missing binary", async () => {
    const d = await opencodeAdapter.detect(envFor());
    expect(d).toMatchObject({ installed: true, version: "1.2.3" });
    const missing = await opencodeAdapter.detect(
      envFor(async () => {
        throw new Error("ENOENT");
      }),
    );
    expect(missing.installed).toBe(false);
    expect(missing.configPaths.length).toBe(2);
  });

  it("hook returns empty output", async () => {
    const out = await opencodeAdapter.hook("x", {}, {} as never);
    expect(out).toEqual({ stdout: "", exitCode: 0 });
  });
});
