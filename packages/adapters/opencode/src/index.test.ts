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

describe("opencodeAdapter V1 fallback", () => {
  const V1_ENTRY = { ...ENTRY, enabled: true };
  const v1Config = JSON.stringify({
    mcp: { other: { type: "local", command: ["a"], enabled: true } },
  });
  const ver = (v: string | null): AdapterEnv =>
    envFor(async () => {
      if (v === null) throw new Error("ENOENT");
      return { code: 0, stdout: `${v}\n` };
    });

  it("writes V1 for an old version when the config uses V1 keys", async () => {
    await seed("opencode.json", v1Config);
    const [c] = await opencodeAdapter.plan(ver("1.19.6"));
    const after = parsed(c?.after);
    expect(after.mcp.conveno).toEqual(V1_ENTRY);
    expect(after.mcp.servers).toBeUndefined();
    expect(after.mcp.other).toBeDefined();
  });

  it("writes V1 when the version is unknown and the config uses V1 keys", async () => {
    await seed("opencode.json", v1Config);
    const [c] = await opencodeAdapter.plan(ver(null));
    expect(parsed(c?.after).mcp.conveno).toEqual(V1_ENTRY);
  });

  it("writes V2 for an old version when the config has no V1 keys", async () => {
    await seed("opencode.json", "{}");
    const [c] = await opencodeAdapter.plan(ver("1.19.6"));
    expect(parsed(c?.after).mcp.servers.conveno).toEqual(ENTRY);
  });

  it("writes V2 for 2.2.0 and later even when the config has V1 keys", async () => {
    await seed("opencode.json", v1Config);
    for (const v of ["2.2.0", "2.4.2", "3.0.0"]) {
      const [c] = await opencodeAdapter.plan(ver(v));
      expect(parsed(c?.after).mcp.servers.conveno).toEqual(ENTRY);
    }
  });

  it("treats 2.1.9 as V1", async () => {
    await seed("opencode.json", v1Config);
    const [c] = await opencodeAdapter.plan(ver("2.1.9"));
    expect(parsed(c?.after).mcp.conveno).toEqual(V1_ENTRY);
  });

  it("is idempotent for an installed V1 entry on an old version", async () => {
    await seed("opencode.json", JSON.stringify({ mcp: { conveno: V1_ENTRY } }));
    expect(await opencodeAdapter.plan(ver("1.19.6"))).toEqual([]);
  });

  it("moves a V1 entry to V2 on a new version", async () => {
    await seed("opencode.json", JSON.stringify({ mcp: { conveno: V1_ENTRY } }));
    const [c] = await opencodeAdapter.plan(ver("2.4.2"));
    const after = parsed(c?.after);
    expect(after.mcp.conveno).toBeUndefined();
    expect(after.mcp.servers.conveno).toEqual(ENTRY);
  });

  it("uninstall removes a V1 entry and keeps the rest", async () => {
    await seed(
      "opencode.jsonc",
      `{ // c\n "mcp": { "other": { "type": "local", "command": ["a"] }, "conveno": ${JSON.stringify(V1_ENTRY)} } }`,
    );
    const [c] = await opencodeAdapter.uninstallPlan(envFor());
    const after = parsed(c?.after);
    expect(after.mcp.conveno).toBeUndefined();
    expect(after.mcp.other).toBeDefined();
    expect(c?.after).toContain("// c");
  });

  it("uninstall removes both shapes when both exist", async () => {
    await seed(
      "opencode.json",
      JSON.stringify({
        mcp: {
          conveno: V1_ENTRY,
          servers: { conveno: ENTRY, keep: { type: "local", command: ["k"] } },
        },
      }),
    );
    const [c] = await opencodeAdapter.uninstallPlan(envFor());
    const after = parsed(c?.after);
    expect(after.mcp.conveno).toBeUndefined();
    expect(after.mcp.servers.conveno).toBeUndefined();
    expect(after.mcp.servers.keep).toBeDefined();
  });
});
