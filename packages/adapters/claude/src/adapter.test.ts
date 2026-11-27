import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AdapterEnv,
  type ConfigChange,
  type ConvenoClient,
  formatHookContext,
} from "@conveno/core";
import { type Message, newMessageId, newSessionId } from "@conveno/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import claudeDefault, { claudeAdapter } from "./index.js";

let home: string;

const textMessage = (text: string, over: { urgent?: boolean } = {}): Message =>
  ({
    kind: "text",
    body: { text },
    id: newMessageId(),
    from: newSessionId(),
    to: "orchestrator",
    urgent: over.urgent ?? false,
    createdAt: "2026-11-27T14:02:11.000Z",
    fromName: "codex@api-2",
    fromCli: "codex",
  }) as Message;

const sess = (name: string) => ({ id: newSessionId(), name });

const env = (over: Partial<AdapterEnv> = {}): AdapterEnv => ({
  home,
  platform: "linux",
  cwd: home,
  exec: async () => ({ code: 0, stdout: "2.1.0 (Claude Code)\n" }),
  conveno: { command: ["conveno"] },
  env: {},
  ...over,
});

const mcpPath = () => join(home, ".claude.json");
const settingsPath = () => join(home, ".claude", "settings.json");

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function apply(changes: ConfigChange[]) {
  for (const c of changes) {
    await mkdir(dirname(c.path), { recursive: true });
    await writeFile(c.path, c.after);
  }
}

const readJson = async (p: string) => JSON.parse(await readFile(p, "utf8"));

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "conveno-claude-"));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe("metadata", () => {
  it("is exported by name and as default", () => {
    expect(claudeDefault).toBe(claudeAdapter);
    expect(claudeAdapter.cli).toBe("claude");
    expect(claudeAdapter.deliveryTier).toBe("next_turn");
  });
});

describe("detect", () => {
  it("reports the version when claude runs", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "2.1.0 (Claude Code)\n" }));
    const d = await claudeAdapter.detect(env({ exec }));
    expect(exec).toHaveBeenCalledWith("claude", ["--version"]);
    expect(d).toMatchObject({ installed: true, version: "2.1.0", binary: "claude" });
    expect(d.configPaths).toEqual([mcpPath(), settingsPath()]);
  });

  it("reports not installed when exec fails or exits non-zero", async () => {
    const thrown = await claudeAdapter.detect(
      env({
        exec: async () => {
          throw new Error("ENOENT");
        },
      }),
    );
    expect(thrown.installed).toBe(false);
    const nonZero = await claudeAdapter.detect(
      env({ exec: async () => ({ code: 1, stdout: "" }) }),
    );
    expect(nonZero.installed).toBe(false);
  });

  it("honors CLAUDE_CONFIG_DIR", async () => {
    const d = await claudeAdapter.detect(env({ env: { CLAUDE_CONFIG_DIR: join(home, "alt") } }));
    expect(d.configPaths).toEqual([
      join(home, "alt", ".claude.json"),
      join(home, "alt", "settings.json"),
    ]);
  });
});

describe("plan", () => {
  it("creates both files from nothing", async () => {
    const changes = await claudeAdapter.plan(env());
    expect(changes).toHaveLength(2);
    const [mcp, settings] = changes as [ConfigChange, ConfigChange];
    expect(mcp.before).toBeNull();
    expect(mcp.viaCommand).toEqual([
      "claude",
      "mcp",
      "add",
      "--scope",
      "user",
      "conveno",
      "--",
      "conveno",
      "mcp",
      "--cli",
      "claude",
    ]);
    expect(JSON.parse(mcp.after)).toEqual({
      mcpServers: {
        conveno: { type: "stdio", command: "conveno", args: ["mcp", "--cli", "claude"], env: {} },
      },
    });
    expect(settings.before).toBeNull();
    const hooks = JSON.parse(settings.after).hooks;
    expect(hooks.SessionStart).toEqual([
      { hooks: [{ type: "command", command: "conveno hook claude SessionStart", timeout: 5 }] },
    ]);
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe("conveno hook claude UserPromptSubmit");
  });

  it("treats a blank existing file as empty", async () => {
    await put(mcpPath(), "  \n");
    const changes = await claudeAdapter.plan(env());
    expect(changes[0]?.before).toBe("  \n");
  });

  it("keeps other MCP servers, other hooks and unrelated keys; preserves indent", async () => {
    await put(
      mcpPath(),
      `{\n    "numStartups": 3,\n    "mcpServers": {\n        "other": {"command": "x"}\n    },\n    "projects": {}\n}\n`,
    );
    await put(
      settingsPath(),
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            SessionStart: [
              { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] },
            ],
            PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "lint" }] }],
          },
        },
        null,
        "\t",
      ),
    );
    const changes = await claudeAdapter.plan(env());
    const mcp = changes.find((c) => c.path === mcpPath()) as ConfigChange;
    expect(mcp.after.startsWith('{\n    "numStartups"')).toBe(true);
    expect(mcp.after.endsWith("}\n")).toBe(true);
    const mcpJson = JSON.parse(mcp.after);
    expect(mcpJson.numStartups).toBe(3);
    expect(mcpJson.mcpServers.other).toEqual({ command: "x" });
    expect(mcpJson.mcpServers.conveno).toBeDefined();

    const st = changes.find((c) => c.path === settingsPath()) as ConfigChange;
    expect(st.after).not.toMatch(/\n\s{2}"theme"/); // tab indentation kept
    expect(st.after.endsWith("\n")).toBe(false); // original had no trailing newline
    const j = JSON.parse(st.after);
    expect(j.theme).toBe("dark");
    expect(j.hooks.PreToolUse).toHaveLength(1);
    expect(j.hooks.SessionStart).toHaveLength(2);
    expect(j.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
  });

  it("is empty once installed", async () => {
    await apply(await claudeAdapter.plan(env()));
    expect(await claudeAdapter.plan(env())).toEqual([]);
  });

  it("repairs a missing hook only for that event", async () => {
    await apply(await claudeAdapter.plan(env()));
    const j = await readJson(settingsPath());
    delete j.hooks.UserPromptSubmit;
    await put(settingsPath(), JSON.stringify(j));
    const changes = await claudeAdapter.plan(env());
    expect(changes).toHaveLength(1);
    expect(changes[0]?.description).toMatch(/UserPromptSubmit/);
    expect(changes[0]?.description).not.toMatch(/SessionStart/);
  });

  it("replaces a stale conveno command instead of duplicating it", async () => {
    await apply(await claudeAdapter.plan(env({ conveno: { command: ["/old/conveno"] } })));
    const changes = await claudeAdapter.plan(env({ conveno: { command: ["/new/conveno"] } }));
    await apply(changes);
    const j = await readJson(settingsPath());
    expect(j.hooks.SessionStart).toHaveLength(1);
    expect(j.hooks.SessionStart[0].hooks[0].command).toBe("/new/conveno hook claude SessionStart");
    const m = await readJson(mcpPath());
    expect(m.mcpServers.conveno.command).toBe("/new/conveno");
  });

  it("quotes commands with spaces and splits node entry points", async () => {
    const e = env({ conveno: { command: ["C:\\Program Files\\node.exe", "C:\\c\\cli.js"] } });
    const changes = await claudeAdapter.plan(e);
    const st = JSON.parse((changes[1] as ConfigChange).after);
    expect(st.hooks.SessionStart[0].hooks[0].command).toBe(
      '"C:\\\\Program Files\\\\node.exe" C:\\c\\cli.js hook claude SessionStart',
    );
    const srv = JSON.parse((changes[0] as ConfigChange).after).mcpServers.conveno;
    expect(srv.command).toBe("C:\\Program Files\\node.exe");
    expect(srv.args).toEqual(["C:\\c\\cli.js", "mcp", "--cli", "claude"]);
  });

  it("writes Windows hook paths with forward slashes, quoted for Git Bash", async () => {
    const e = env({
      platform: "win32",
      conveno: {
        command: [
          "C:\\Program Files\\nodejs\\node.exe",
          "C:\\Users\\Dev User\\AppData\\Roaming\\npm\\node_modules\\conveno\\dist\\bin.js",
        ],
      },
    });
    const changes = await claudeAdapter.plan(e);
    const settings = changes[1] as ConfigChange;
    const command = JSON.parse(settings.after).hooks.UserPromptSubmit[0].hooks[0].command;
    expect(command).toBe(
      '"C:/Program Files/nodejs/node.exe" "C:/Users/Dev User/AppData/Roaming/npm/node_modules/conveno/dist/bin.js" hook claude UserPromptSubmit',
    );
    // No backslash survives into the command, so neither the JSON file nor bash needs escapes.
    expect(command).not.toContain("\\");
    expect(settings.after).not.toContain("\\\\");
    // Installing again finds the same command and plans nothing.
    await put(settingsPath(), settings.after);
    await put(mcpPath(), (changes[0] as ConfigChange).after);
    expect(await claudeAdapter.plan(e)).toEqual([]);
  });

  it("keeps a Windows path without spaces unquoted", async () => {
    const e = env({
      platform: "win32",
      conveno: { command: ["C:\\nodejs\\node.exe", "D:\\c\\bin.js"] },
    });
    const st = JSON.parse(((await claudeAdapter.plan(e))[1] as ConfigChange).after);
    expect(st.hooks.SessionStart[0].hooks[0].command).toBe(
      "C:/nodejs/node.exe D:/c/bin.js hook claude SessionStart",
    );
  });

  it("refuses malformed JSON with a clear error and leaves the file alone", async () => {
    await put(settingsPath(), '{ "hooks": { oops }');
    await expect(claudeAdapter.plan(env())).rejects.toThrow(
      /settings\.json is not valid JSON.*Nothing was changed/s,
    );
    expect(await readFile(settingsPath(), "utf8")).toBe('{ "hooks": { oops }');
    await put(mcpPath(), "[]");
    await expect(claudeAdapter.plan(env())).rejects.toThrow(/must contain a JSON object/);
  });

  it("refuses wrongly shaped hooks or mcpServers", async () => {
    await put(settingsPath(), '{"hooks": []}');
    await expect(claudeAdapter.plan(env())).rejects.toThrow(/"hooks".*must be an object/);
    await put(settingsPath(), "{}");
    await put(mcpPath(), '{"mcpServers": 1}');
    await expect(claudeAdapter.plan(env())).rejects.toThrow(/"mcpServers".*must be an object/);
  });
});

describe("byte-exact edits", () => {
  const original =
    '{\r\n  "a": 1,\r\n  "a": 2,\r\n  "path": "C:\\\\x\\u00e9\\/y",\r\n  "mcpServers": {"other": {"command": "x"}}\r\n}\r\n';

  it("keeps duplicate keys, escapes and line endings outside our key", async () => {
    await put(mcpPath(), original);
    const [c] = await claudeAdapter.plan(env());
    const after = c?.after ?? "";
    expect(after).toContain('"a": 1,\r\n  "a": 2,\r\n  "path": "C:\\\\x\\u00e9\\/y"');
    expect(after).not.toMatch(/[^\r]\n/);
    expect(JSON.parse(after).mcpServers.conveno.command).toBe("conveno");
    // Removing our key again gives back every other byte.
    await writeFile(mcpPath(), after);
    const [u] = await claudeAdapter.uninstallPlan(env());
    expect(JSON.parse(u?.after ?? "").mcpServers).toEqual({ other: { command: "x" } });
    expect(u?.after).toContain('"a": 1,\r\n  "a": 2,\r\n  "path": "C:\\\\x\\u00e9\\/y"');
  });
});

describe("uninstallPlan", () => {
  it("is empty when nothing is installed", async () => {
    expect(await claudeAdapter.uninstallPlan(env())).toEqual([]);
  });

  it("removes only what we added", async () => {
    await put(
      mcpPath(),
      JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: true }, null, 2),
    );
    await put(
      settingsPath(),
      JSON.stringify(
        {
          theme: "dark",
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
            Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
          },
        },
        null,
        2,
      ),
    );
    await apply(await claudeAdapter.plan(env()));
    const un = await claudeAdapter.uninstallPlan(env());
    expect(un.find((c) => c.path === mcpPath())?.viaCommand).toEqual([
      "claude",
      "mcp",
      "remove",
      "--scope",
      "user",
      "conveno",
    ]);
    await apply(un);
    const m = await readJson(mcpPath());
    expect(m).toEqual({ mcpServers: { other: { command: "x" } }, keep: true });
    const s = await readJson(settingsPath());
    expect(s).toEqual({
      theme: "dark",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
      },
    });
    expect(await claudeAdapter.uninstallPlan(env())).toEqual([]);
  });

  it("drops an empty hooks key after install-only then uninstall", async () => {
    await apply(await claudeAdapter.plan(env()));
    await apply(await claudeAdapter.uninstallPlan(env()));
    expect(await readJson(settingsPath())).toEqual({});
    expect(await readJson(mcpPath())).toEqual({ mcpServers: {} });
  });
});

describe("hook", () => {
  // Input examples copied from https://code.claude.com/docs/en/hooks
  const sessionStartInput = {
    session_id: "abc123",
    transcript_path: "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
    cwd: "/Users/...",
    hook_event_name: "SessionStart",
    source: "resume",
    model: "claude-opus-5",
  };
  const promptInput = {
    session_id: "abc123",
    transcript_path: "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
    cwd: "/Users/...",
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    prompt: "Write a function to calculate the factorial of a number",
  };

  const clientWith = (over: Record<string, unknown>) =>
    ({
      "session.byHost": vi.fn(async () => ({ session: null })),
      "message.deliver": vi.fn(async () => ({ messages: [], remaining: 0 })),
      ...over,
    }) as unknown as ConvenoClient;

  it("emits additionalContext for the event when messages exist", async () => {
    const me = sess("claude@web");
    const messages = [textMessage("ship it"), textMessage("also this", { urgent: true })];
    const client = clientWith({
      "session.byHost": vi.fn(async () => ({ session: me })),
      "message.deliver": vi.fn(async () => ({ messages, remaining: 0 })),
    });
    for (const [event, input] of [
      ["SessionStart", sessionStartInput],
      ["UserPromptSubmit", promptInput],
    ] as const) {
      const out = await claudeAdapter.hook(event, input, { client, pids: [4242, 4241] });
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: formatHookContext(messages),
        },
      });
    }
    expect(client["session.byHost"]).toHaveBeenCalledWith({ pids: [4242, 4241] });
    expect(client["message.deliver"]).toHaveBeenCalledWith({ sessionId: me.id });
  });

  it("prints nothing without a session, without messages, or on unknown events", async () => {
    const none = await claudeAdapter.hook("UserPromptSubmit", promptInput, {
      client: clientWith({}),
      pids: [1],
    });
    expect(none).toEqual({ stdout: "", exitCode: 0 });

    const me = sess("claude@web");
    const empty = await claudeAdapter.hook("SessionStart", sessionStartInput, {
      client: clientWith({ "session.byHost": async () => ({ session: me }) }),
      pids: [1],
    });
    expect(empty).toEqual({ stdout: "", exitCode: 0 });

    const unknown = await claudeAdapter.hook("Stop", {}, { client: clientWith({}), pids: [1] });
    expect(unknown).toEqual({ stdout: "", exitCode: 0 });
  });

  it("swallows client errors", async () => {
    const client = clientWith({
      "session.byHost": async () => {
        throw new Error("daemon down");
      },
    });
    const err = vi.spyOn(process.stderr, "write");
    const out = await claudeAdapter.hook("UserPromptSubmit", promptInput, { client, pids: [1] });
    expect(out).toEqual({ stdout: "", exitCode: 0 });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
