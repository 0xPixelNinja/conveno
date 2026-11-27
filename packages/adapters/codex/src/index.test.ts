import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AdapterEnv, type ConfigChange, type ConvenoClient } from "@0xpixelninja/conveno-core";
import { type Message, newMessageId, newSessionId } from "@0xpixelninja/conveno-protocol";
import { parse } from "@decimalturn/toml-patch";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import codexAdapter, { codexAdapter as named } from "./index.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "conveno-codex-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const env = (over: Partial<AdapterEnv> = {}): AdapterEnv => ({
  home,
  platform: "linux",
  cwd: home,
  exec: async () => ({ code: 0, stdout: "codex-cli 0.99.1\n" }),
  conveno: { command: ["conveno"] },
  env: {},
  ...over,
});
const cfg = () => join(home, ".codex", "config.toml");
const hooksFile = () => join(home, ".codex", "hooks.json");
const write = async (path: string, text: string) => {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(path, text);
};
/** What `conveno init` would do: write `after` for each change. */
const apply = async (changes: ConfigChange[]) => {
  await mkdir(join(home, ".codex"), { recursive: true });
  for (const c of changes) await writeFile(c.path, c.after);
};
const textMessage = (text: string): Message =>
  ({
    kind: "text",
    body: { text },
    id: newMessageId(),
    from: newSessionId(),
    to: "orchestrator",
    urgent: false,
    createdAt: "2026-11-27T14:02:11.000Z",
    fromName: "codex@api-2",
    fromCli: "codex",
  }) as Message;
const asToml = (s: string) => parse(s) as Record<string, any>;

describe("exports", () => {
  it("default and named export are the adapter", () => {
    expect(codexAdapter).toBe(named);
    expect(named.cli).toBe("codex");
    expect(named.deliveryTier).toBe("next_turn");
  });
});

describe("detect", () => {
  it("reports version and config paths", async () => {
    const d = await named.detect(env());
    expect(d).toMatchObject({ installed: true, version: "0.99.1", binary: "codex" });
    expect(d.configPaths).toEqual([cfg(), hooksFile()]);
  });
  it("is not installed when exec throws or exits non-zero", async () => {
    const throws = await named.detect(
      env({
        exec: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(throws.installed).toBe(false);
    const bad = await named.detect(env({ exec: async () => ({ code: 1, stdout: "" }) }));
    expect(bad.installed).toBe(false);
  });
});

describe("plan on an empty home", () => {
  it("adds the MCP table and both hooks", async () => {
    const changes = await named.plan(env());
    expect(changes.map((c) => c.path)).toEqual([cfg(), hooksFile()]);
    const [mcp, hooks] = changes as [ConfigChange, ConfigChange];
    expect(mcp.before).toBeNull();
    expect(mcp.viaCommand).toEqual([
      "codex",
      "mcp",
      "add",
      "conveno",
      "--",
      "conveno",
      "mcp",
      "--cli",
      "codex",
    ]);
    expect(asToml(mcp.after).mcp_servers.conveno).toEqual({
      command: "conveno",
      args: ["mcp", "--cli", "codex"],
    });
    const h = JSON.parse(hooks.after);
    expect(h.hooks.SessionStart[0].hooks[0]).toEqual({
      type: "command",
      command: "conveno hook codex SessionStart",
      timeout: 5,
    });
    expect(h.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      "conveno hook codex UserPromptSubmit",
    );
  });
  it("quotes a multi-part command with spaces", async () => {
    const changes = await named.plan(
      env({ conveno: { command: ["node", "/opt/my tools/conveno.js"] } }),
    );
    const mcp = asToml(changes[0]?.after ?? "").mcp_servers.conveno;
    expect(mcp.command).toBe("node");
    expect(mcp.args).toEqual(["/opt/my tools/conveno.js", "mcp", "--cli", "codex"]);
    expect(JSON.parse(changes[1]?.after ?? "").hooks.SessionStart[0].hooks[0].command).toBe(
      "node '/opt/my tools/conveno.js' hook codex SessionStart",
    );
  });
});

describe("plan with existing config", () => {
  const existing = `# my codex config
model = "gpt-5"  # favourite

# a server
[mcp_servers.docs]
command = "npx"  # run it
args = ["-y", "docs-mcp"]

[profiles.fast]
model = "mini"
`;
  it("preserves comments and other servers byte for byte", async () => {
    await write(cfg(), existing);
    const [mcp] = await named.plan(env());
    expect(mcp?.before).toBe(existing);
    expect(mcp?.after.startsWith(existing)).toBe(true);
    const doc = asToml(mcp?.after ?? "");
    expect(doc.mcp_servers.docs.command).toBe("npx");
    expect(doc.mcp_servers.conveno.command).toBe("conveno");
    expect(doc.profiles.fast.model).toBe("mini");
  });
  it("adds a separator when the file has no trailing newline", async () => {
    await write(cfg(), 'model = "x"');
    const [mcp] = await named.plan(env());
    expect(asToml(mcp?.after ?? "").mcp_servers.conveno.command).toBe("conveno");
    expect(mcp?.after.startsWith('model = "x"\n\n[mcp_servers.conveno]')).toBe(true);
  });
  it("keeps other hooks and unrelated hooks.json keys", async () => {
    await write(
      hooksFile(),
      JSON.stringify({
        extra: 1,
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine.sh" }] }],
          Stop: [{ hooks: [{ type: "command", command: "stop.sh" }] }],
        },
      }),
    );
    const changes = await named.plan(env());
    const h = JSON.parse(changes.find((c) => c.path === hooksFile())?.after ?? "");
    expect(h.extra).toBe(1);
    expect(h.hooks.Stop).toHaveLength(1);
    expect(h.hooks.UserPromptSubmit).toHaveLength(2);
    expect(h.hooks.UserPromptSubmit[0].hooks[0].command).toBe("mine.sh");
  });
  it("updates our entries when the conveno command moved, without viaCommand", async () => {
    await apply(await named.plan(env()));
    const moved = env({ conveno: { command: ["/new/conveno"] } });
    const changes = await named.plan(moved);
    expect(changes).toHaveLength(2);
    expect(changes[0]?.viaCommand).toBeUndefined();
    expect(asToml(changes[0]?.after ?? "").mcp_servers.conveno.command).toBe("/new/conveno");
    const h = JSON.parse(changes[1]?.after ?? "");
    expect(h.hooks.SessionStart).toHaveLength(1);
    expect(h.hooks.SessionStart[0].hooks[0].command).toBe("/new/conveno hook codex SessionStart");
  });
});

describe("idempotence and uninstall", () => {
  it("plans nothing once installed", async () => {
    await apply(await named.plan(env()));
    expect(await named.plan(env())).toEqual([]);
  });
  it("uninstall removes only our entries and restores the original", async () => {
    const original = `# top\nmodel = "x"\n\n[mcp_servers.docs]\ncommand = "d" # keep\n`;
    await write(cfg(), original);
    await write(
      hooksFile(),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "mine.sh" }] }] },
      }),
    );
    await apply(await named.plan(env()));
    const changes = await named.uninstallPlan(env());
    expect(changes).toHaveLength(2);
    expect(changes[0]?.after).toBe(original);
    const h = JSON.parse(changes[1]?.after ?? "");
    expect(h.hooks.SessionStart).toBeUndefined();
    expect(h.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: "mine.sh" }] },
    ]);
    await apply(changes);
    expect(await named.uninstallPlan(env())).toEqual([]);
    expect(await readFile(cfg(), "utf8")).toBe(original);
  });
  it("uninstall of a conveno-only install leaves empty config and no hooks key", async () => {
    await apply(await named.plan(env()));
    const changes = await named.uninstallPlan(env());
    expect(changes[0]?.after).toBe("");
    expect(JSON.parse(changes[1]?.after ?? "")).toEqual({});
  });
  it("uninstall is empty when nothing exists", async () => {
    expect(await named.uninstallPlan(env())).toEqual([]);
  });
  it("removes our table when it sits in the middle of the file", async () => {
    await write(cfg(), `[mcp_servers.conveno]\ncommand = "c"\nargs = []\n\n[other]\na = 1 # c\n`);
    const [c] = await named.uninstallPlan(env());
    expect(c?.after).toBe(`\n[other]\na = 1 # c\n`.replace(/^\n/, ""));
  });
  it("falls back to a patch when conveno is defined inline", async () => {
    await write(cfg(), `# c\n[mcp_servers]\nconveno = { command = "old", args = [] }\n`);
    const [c] = await named.plan(env());
    expect(asToml(c?.after ?? "").mcp_servers.conveno.command).toBe("conveno");
    expect(c?.after).toContain("# c");
    const [u] = await named.uninstallPlan(env());
    expect(asToml(u?.after ?? "").mcp_servers?.conveno).toBeUndefined();
  });
});

describe("malformed input", () => {
  it("throws a fix-it error for bad TOML and leaves the file alone", async () => {
    await write(cfg(), "model = = oops\n");
    await expect(named.plan(env())).rejects.toThrow(/Cannot parse .*config\.toml as TOML/);
    await expect(named.uninstallPlan(env())).rejects.toThrow(/did not change it/);
    expect(await readFile(cfg(), "utf8")).toBe("model = = oops\n");
  });
  it("throws for bad hooks.json", async () => {
    await write(hooksFile(), "{ not json");
    await expect(named.plan(env())).rejects.toThrow(/Cannot parse .*hooks\.json as a JSON object/);
  });
});

describe("hook", () => {
  const session = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ" };
  const fakeClient = (over: Record<string, unknown> = {}) =>
    ({
      "session.byHost": async () => ({ session }),
      "message.deliver": async () => ({ messages: [textMessage("hi there")], remaining: 0 }),
      ...over,
    }) as unknown as ConvenoClient;

  for (const event of ["SessionStart", "UserPromptSubmit"]) {
    it(`prints additionalContext for ${event}`, async () => {
      const out = await named.hook(event, {}, { client: fakeClient(), hostPid: 42 });
      expect(out.exitCode).toBe(0);
      const parsed = JSON.parse(out.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("hi there");
      expect(parsed.hookSpecificOutput.additionalContext).toContain("not from the user");
    });
  }
  it("passes the host pid to session.byHost and the session id to deliver", async () => {
    const calls: unknown[] = [];
    const client = fakeClient({
      "session.byHost": async (p: unknown) => (calls.push(p), { session }),
      "message.deliver": async (p: unknown) => (calls.push(p), { messages: [], remaining: 0 }),
    });
    await named.hook("UserPromptSubmit", {}, { client, hostPid: 7 });
    expect(calls).toEqual([{ hostPid: 7 }, { sessionId: session.id }]);
  });
  it("prints nothing with no session, no messages, unknown events or errors", async () => {
    const empty = { stdout: "", exitCode: 0 };
    const ctx = (client: ConvenoClient) => ({ client, hostPid: 1 });
    expect(
      await named.hook(
        "SessionStart",
        {},
        ctx(fakeClient({ "session.byHost": async () => ({ session: null }) })),
      ),
    ).toEqual(empty);
    expect(
      await named.hook(
        "SessionStart",
        {},
        ctx(fakeClient({ "message.deliver": async () => ({ messages: [], remaining: 0 }) })),
      ),
    ).toEqual(empty);
    expect(await named.hook("Stop", {}, ctx(fakeClient()))).toEqual(empty);
    expect(
      await named.hook(
        "SessionStart",
        {},
        ctx(
          fakeClient({
            "message.deliver": async () => {
              throw new Error("daemon down");
            },
          }),
        ),
      ),
    ).toEqual(empty);
  });
});

describe("CODEX_HOME", () => {
  it("is honoured from env.env", async () => {
    const alt = join(home, "alt-codex");
    const changes = await codexAdapter.plan(env({ env: { CODEX_HOME: alt } }));
    expect(changes.map((c) => c.path)).toContain(join(alt, "config.toml"));
    expect(changes.map((c) => c.path)).toContain(join(alt, "hooks.json"));
  });
});
