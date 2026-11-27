import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import claudeAdapter from "@0xpixelninja/conveno-adapter-claude";
import { connect } from "@0xpixelninja/conveno-client";
import { dataPaths } from "@0xpixelninja/conveno-core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type PlannedChange, usesCommand } from "./apply.js";
import { levenshtein } from "./fmt.js";
import { main } from "./main.js";
import { parentOf, windowsShellSafe } from "./runtime.js";
import { fakeAdapter, seed, startTestDaemon, type TestCtx, testCtx } from "./test-utils.js";

beforeAll(() => {
  process.env.TZ = "UTC";
});

const ctxs: TestCtx[] = [];
const make = async (over: Parameters<typeof testCtx>[0] = {}) => {
  const c = await testCtx({ exec: async () => ({ code: 1, stdout: "2.1.4\n" }), ...over });
  ctxs.push(c);
  return c;
};
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

const claudeJson = (c: TestCtx) => join(c.home, ".claude.json");
const claudeSettings = (c: TestCtx) => join(c.home, ".claude", "settings.json");
const detect =
  (version = "2.1.4") =>
  async (cmd: string, args: string[]) =>
    cmd === "claude" && args[0] === "--version"
      ? { code: 0, stdout: `${version}\n` }
      : { code: 1, stdout: "" };

describe("uninstall keeps what changed since init", () => {
  it("restores byte for byte while the file is untouched", async () => {
    const c = await make({ exec: detect() });
    const original = '{\r\n\t"a": 1,\r\n  "a": 2\r\n}';
    await seed(claudeJson(c), original);
    await main(["init", "--yes"], c);
    expect(await main(["uninstall", "--yes"], c)).toBe(0);
    expect(await readFile(claudeJson(c), "utf8")).toBe(original);
    expect(c.outText()).toContain("Restored 2 files");
  });

  it("removes only Conveno's keys from a file the user or Claude Code edited later", async () => {
    const c = await make({ exec: detect() });
    await seed(claudeJson(c), '{\n  "theme": "dark"\n}\n');
    await main(["init", "--yes"], c);
    const edited = JSON.parse(await readFile(claudeJson(c), "utf8"));
    edited.newSetting = { later: true };
    await writeFile(claudeJson(c), `${JSON.stringify(edited, null, 2)}\n`);

    c.stdout.length = 0;
    expect(await main(["uninstall", "--yes"], c)).toBe(0);
    const after = JSON.parse(await readFile(claudeJson(c), "utf8"));
    expect(after.theme).toBe("dark");
    expect(after.newSetting).toEqual({ later: true });
    expect(after.mcpServers ?? {}).not.toHaveProperty("conveno");
    expect(c.outText()).toContain("Edited, not restored");
    expect(c.outText()).toContain("~/.claude.json");
    // The untouched file was still restored (it did not exist before init).
    expect(existsSync(claudeSettings(c))).toBe(false);
  });

  it("restores every manifest, newest to oldest", async () => {
    const c = await make();
    const file = join(c.home, "tool.cfg");
    await seed(file, "orig\n");
    const adapter = fakeAdapter({
      cli: "claude",
      plan: async () => {
        const before = existsSync(file) ? await readFile(file, "utf8") : null;
        return [{ path: file, before, after: `${before ?? ""}x\n`, description: "Add x." }];
      },
    });
    const ctx = { ...c, adapters: [adapter] };
    await main(["init", "--yes"], ctx);
    await main(["init", "--yes"], ctx);
    expect(await readFile(file, "utf8")).toBe("orig\nx\nx\n");
    expect((await readdir(dataPaths(c.platform, c.dataDir).backups)).length).toBe(2);

    expect(await main(["uninstall", "--yes"], ctx)).toBe(0);
    expect(await readFile(file, "utf8")).toBe("orig\n");
    // Everything is marked restored, so a second run finds nothing to undo.
    c.stdout.length = 0;
    expect(await main(["uninstall", "--yes"], { ...ctx, adapters: [fakeAdapter()] })).toBe(0);
    expect(c.outText()).toContain("Nothing to remove");
  });

  it("shows manifest times in local time", async () => {
    const c = await make({ exec: detect() });
    await main(["init", "--yes"], c);
    c.stdout.length = 0;
    await main(["uninstall"], c);
    expect(c.outText()).toContain("made 2026-11-27 14:02:11 (local time)");
    expect(c.outText()).not.toContain("T14:02:11.000Z");
  });
});

describe("apply safety", () => {
  it("does not overwrite a file that changed after the plan was shown", async () => {
    const c = await make({
      exec: detect(),
      interactive: true,
      confirm: async () => {
        await seed(claudeJson(c), '{"changedMeanwhile": true}\n');
        return true;
      },
    });
    await seed(claudeJson(c), '{"theme": "dark"}\n');
    expect(await main(["init"], c)).toBe(1);
    expect(c.errText()).toContain("changed while Conveno was waiting");
    expect(c.errText()).toContain("ref e_stale");
    expect(await readFile(claudeJson(c), "utf8")).toBe('{"changedMeanwhile": true}\n');
  });

  it.skipIf(process.platform === "win32")(
    "writes atomically, keeps the file mode and leaves no temp files",
    async () => {
      const c = await make({ exec: detect() });
      await seed(claudeJson(c), '{"theme": "dark"}\n');
      await chmod(claudeJson(c), 0o600);
      await main(["init", "--yes"], c);
      expect((await stat(claudeJson(c))).mode & 0o777).toBe(0o600);
      expect((await readdir(c.home)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "creates and tightens data and backup directories to 0700",
    async () => {
      const c = await make({ exec: detect() });
      const { backups } = dataPaths(c.platform, c.dataDir);
      await mkdir(backups, { recursive: true });
      await chmod(c.dataDir, 0o755);
      await chmod(backups, 0o755);
      await seed(claudeJson(c), '{"theme": "dark"}\n');
      await main(["init", "--yes"], c);
      const mode = async (p: string) => (await stat(p)).mode & 0o777;
      expect(await mode(c.dataDir)).toBe(0o700);
      expect(await mode(backups)).toBe(0o700);
      const [stamp] = await readdir(backups);
      expect(await mode(join(backups, stamp as string))).toBe(0o700);
      expect(await mode(join(backups, stamp as string, "manifest.json"))).toBe(0o600);
    },
  );

  it("records the hash of what init wrote", async () => {
    const c = await make({ exec: detect() });
    await main(["init", "--yes"], c);
    const { backups } = dataPaths(c.platform, c.dataDir);
    const [stamp] = await readdir(backups);
    const manifest = JSON.parse(
      await readFile(join(backups, stamp as string, "manifest.json"), "utf8"),
    );
    for (const e of manifest.entries) expect(e.afterSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("labels the command and the expected result on the confirm screen and in dry runs", async () => {
    const c = await make({ exec: detect() });
    await main(["init", "--dry-run"], c);
    expect(c.outText()).toContain("will run  claude mcp add --scope user conveno");
    expect(c.outText()).toContain("expected result");
  });

  it("never uses a CLI's own command on Windows", () => {
    const item = {
      cli: "claude",
      installed: true,
      change: { path: "x", before: null, after: "", description: "", viaCommand: ["claude", "x"] },
    } as PlannedChange;
    const base = { platform: "linux" } as TestCtx;
    expect(usesCommand(base, item)).toBe(true);
    expect(usesCommand({ ...base, platform: "win32" } as TestCtx, item)).toBe(false);
  });

  it("refuses to hand shell metacharacters or spaces to a Windows shell", () => {
    expect(windowsShellSafe("claude", ["--version"])).toBe(true);
    expect(windowsShellSafe("taskkill", ["/PID", "12", "/T", "/F"])).toBe(true);
    expect(windowsShellSafe("claude", ["mcp", "add", "C:\\Program Files\\x.js"])).toBe(false);
    expect(windowsShellSafe("claude", ["a&calc"])).toBe(false);
    expect(windowsShellSafe("claude", ["a^b"])).toBe(false);
    expect(windowsShellSafe("claude & calc", [])).toBe(false);
  });
});

describe("hook finds the CLI above a shell", () => {
  it.skipIf(process.platform === "win32")("reads the parent pid of a live process", async () => {
    expect(await parentOf(process.pid)).toBe(process.ppid);
    expect(await parentOf(1)).toBeNull();
  });

  it("tries each ancestor until the daemon knows one", async () => {
    const shellPid = 424242;
    const c = await make({
      ppid: shellPid,
      parentOf: async (pid) => (pid === shellPid ? process.pid : null),
      readStdin: async () => "{}",
    });
    const d = await startTestDaemon(c);
    const client = await connect({
      kind: "mcp",
      dataDir: c.dataDir,
      socketPath: c.socketPath as string,
      autoStart: false,
    });
    try {
      const me = await client["session.register"]({
        cli: "claude",
        cwd: "/work/api",
        hostPid: process.pid,
        pid: process.pid,
      });
      const other = await client["session.register"]({ cli: "codex", cwd: "/work/api" });
      await client["message.send"]({
        sessionId: other.session.id,
        to: me.session.name,
        kind: "text",
        body: { text: "found through the shell" },
      } as never);
      expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
      expect(c.outText()).toContain("found through the shell");
      expect(c.errText()).toBe("");
    } finally {
      await client.close();
      await d.stop();
    }
  });

  it("stops after six levels", async () => {
    const asked: number[] = [];
    const c = await make({
      ppid: 100,
      parentOf: async (pid) => (asked.push(pid), pid + 1),
      connect: (async () => ({
        close: async () => undefined,
        "session.byHost": async () => ({ session: null }),
      })) as never,
    });
    expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
    expect(asked.length).toBe(5); // six pids are checked, so five parent lookups
    expect(c.outText()).toBe("");
  });
});

describe("usage errors", () => {
  it("rejects an unknown flag with a suggestion, exit 2 and a ref", async () => {
    const c = await make();
    expect(await main(["init", "--ye"], c)).toBe(2);
    expect(c.errText()).toContain("Unknown option --ye for conveno init");
    expect(c.errText()).toContain("Did you mean --yes?");
    expect(c.errText()).toContain("exit 2 · ref e_usage");
  });

  it("rejects an unknown command with a suggestion", async () => {
    const c = await make();
    expect(await main(["statu"], c)).toBe(2);
    expect(c.errText()).toContain("Did you mean status?");
    c.stderr.length = 0;
    expect(await main(["zzzzzz"], c)).toBe(2);
    expect(c.errText()).not.toContain("Did you mean");
  });

  it("rejects stray arguments", async () => {
    const c = await make();
    expect(await main(["status", "now"], c)).toBe(2);
    expect(c.errText()).toContain('Unexpected argument "now"');
  });

  it("prints help per command", async () => {
    const c = await make();
    expect(await main(["init", "--help"], c)).toBe(0);
    expect(c.outText()).toContain("Usage: conveno init");
    expect(c.outText()).toContain("--dry-run");
  });

  it("starts the main help with a one-line description", async () => {
    const c = await make();
    await main(["--help"], c);
    expect(c.outText().split("\n")[0]).toMatch(/^Conveno lets AI coding sessions/);
  });

  it("measures edit distance", () => {
    expect(levenshtein("init", "inti")).toBe(2);
    expect(levenshtein("a", "a")).toBe(0);
  });

  it("turns a thrown Node error into a plain message with exit 1", async () => {
    const c = await make({
      exec: detect(),
      adapters: [
        fakeAdapter({
          cli: "claude",
          plan: async () => {
            throw Object.assign(new Error("EACCES: permission denied, open '/x'"), {
              code: "EACCES",
              path: "/x",
            });
          },
        }),
      ],
    });
    c.exec = async () => ({ code: 0, stdout: "1" });
    expect(await main(["init", "--yes"], c)).toBe(1);
    expect(c.errText()).not.toContain("EACCES");
    expect(c.errText()).toContain("no permission");
    expect(claudeAdapter.cli).toBe("claude");
  });
});
