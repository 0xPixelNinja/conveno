import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import claudeAdapter from "@conveno/adapter-claude";
import codexAdapter from "@conveno/adapter-codex";
import { connect } from "@conveno/client";
import { dataPaths } from "@conveno/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { convenoCommand, resolveDaemonEntry } from "./runtime.js";
import { fakeAdapter, seed, startTestDaemon, type TestCtx, testCtx } from "./test-utils.js";

beforeAll(() => {
  process.env.TZ = "UTC";
});

const ctxs: TestCtx[] = [];
const make = async (over: Parameters<typeof testCtx>[0] = {}) => {
  const c = await testCtx(over);
  ctxs.push(c);
  return c;
};
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

const claudeJson = (c: TestCtx) => join(c.home, ".claude.json");
const claudeSettings = (c: TestCtx) => join(c.home, ".claude", "settings.json");

/** exec that answers `--version` for the given binaries and fails every other command. */
const execFor =
  (versions: Record<string, string>, calls: string[][] = []) =>
  async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const v = versions[cmd];
    if (v && args[0] === "--version") return { code: 0, stdout: `${v}\n` };
    if (v) return { code: 1, stdout: "" };
    throw new Error(`spawn ${cmd} ENOENT`);
  };

describe("help, version, unknown", () => {
  it("prints the version", async () => {
    const c = await make();
    expect(await main(["--version"], c)).toBe(0);
    expect(c.outText()).toBe("0.1.0\n");
  });

  it("prints plain, short help", async () => {
    const c = await make();
    expect(await main(["--help"], c)).toBe(0);
    expect(c.outText()).toMatchSnapshot();
  });

  it("rejects an unknown command with exit 2 and a fix", async () => {
    const c = await make();
    expect(await main(["frobnicate"], c)).toBe(2);
    expect(c.errText()).toMatchSnapshot();
  });
});

describe("init", () => {
  it("prints the plan and exits 2 without a terminal or --yes, changing nothing", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    expect(await main(["init"], c)).toBe(2);
    expect(c.outText()).toMatchSnapshot("stdout");
    expect(c.errText()).toMatchSnapshot("stderr");
    expect(existsSync(claudeJson(c))).toBe(false);
    expect(existsSync(dataPaths(c.platform, c.dataDir).backups)).toBe(false);
  });

  it("--dry-run prints the plan and diffs, exits 0 and writes nothing", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    expect(await main(["init", "--dry-run"], c)).toBe(0);
    expect(c.outText()).toMatchSnapshot();
    expect(c.errText()).toBe("");
    expect(existsSync(claudeJson(c))).toBe(false);
    expect(existsSync(dataPaths(c.platform, c.dataDir).backups)).toBe(false);
  });

  it("asks first on a terminal and stops on no", async () => {
    const asked: string[] = [];
    const c = await make({
      exec: execFor({ claude: "2.1.4" }),
      interactive: true,
      confirm: async (q) => {
        asked.push(q);
        return false;
      },
    });
    expect(await main(["init"], c)).toBe(0);
    expect(asked).toEqual(["Apply these changes?"]);
    expect(existsSync(claudeJson(c))).toBe(false);
    expect(c.outText()).toContain("Nothing was changed.");
  });

  it("with --yes backs up, writes files, records a manifest and notes the Codex trust step", async () => {
    const c = await make({
      adapters: [claudeAdapter, codexAdapter],
      exec: execFor({ claude: "2.1.4", codex: "codex-cli 0.46.0" }),
    });
    await seed(claudeJson(c), '{\n    "theme": "dark"\n}\n');
    expect(await main(["init", "--yes"], c)).toBe(0);
    expect(c.outText()).toMatchSnapshot();

    expect(JSON.parse(await readFile(claudeJson(c), "utf8")).mcpServers.conveno.args).toEqual([
      "mcp",
      "--cli",
      "claude",
    ]);
    expect(await readFile(join(c.home, ".codex", "config.toml"), "utf8")).toContain("conveno");

    const { backups } = dataPaths(c.platform, c.dataDir);
    const [stamp] = await readdir(backups);
    expect(stamp).toBe("2026-11-27T14-02-11");
    const manifest = JSON.parse(
      await readFile(join(backups, stamp as string, "manifest.json"), "utf8"),
    );
    expect(manifest.entries.map((e: { cli: string }) => e.cli).sort()).toEqual([
      "claude",
      "claude",
      "codex",
      "codex",
    ]);
    expect(c.outText()).toContain(
      "Codex asks you to trust new hooks once: run /hooks inside Codex.",
    );
  });

  it("is idempotent: a second run has nothing to change", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await main(["init", "--yes"], c);
    c.stdout.length = 0;
    expect(await main(["init", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("already set up for claude");
  });

  it("does not mention Codex when Codex is not configured, and never mentions telemetry", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await main(["init", "--yes"], c);
    expect(c.outText()).not.toContain("Codex");
    expect(c.outText().toLowerCase()).not.toContain("telemetry");
  });

  it("runs viaCommand when the binary exists, and falls back to writing the file when it fails", async () => {
    const calls: string[][] = [];
    const path = join((await make()).home, "unused");
    void path;
    const c = await make();
    const target = join(c.home, "fake.json");
    const adapter = fakeAdapter({
      cli: "claude",
      plan: async () => [
        {
          path: target,
          before: null,
          after: '{"a":1}\n',
          description: "Add a.",
          viaCommand: ["fake", "add", "a"],
        },
      ],
    });
    const ok = {
      ...c,
      adapters: [adapter],
      exec: async (cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        // The CLI's own command writes the file in its own format.
        await writeFile(target, '{ "a": 1 }\n');
        return { code: 0, stdout: "" };
      },
    };
    expect(await main(["init", "--yes"], ok)).toBe(0);
    if (process.platform !== "win32") {
      expect(calls).toEqual([["fake", "add", "a"]]);
      expect(await readFile(target, "utf8")).toBe('{ "a": 1 }\n');
    }
    await rm(target, { force: true });

    const failing = { ...c, adapters: [adapter], exec: async () => ({ code: 1, stdout: "" }) };
    expect(await main(["init", "--yes"], failing)).toBe(0);
    expect(await readFile(target, "utf8")).toBe('{"a":1}\n');
  });

  it("reports a malformed config as an error and changes nothing", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await seed(claudeSettings(c), '{"hooks": 5}');
    expect(await main(["init", "--yes"], c)).toBe(1);
    expect(c.errText()).toMatchSnapshot();
    expect(existsSync(claudeJson(c))).toBe(false);
  });

  it("fails with exit 1 and a fix when no CLI is installed", async () => {
    const c = await make({ exec: execFor({}) });
    expect(await main(["init", "--yes"], c)).toBe(1);
    expect(c.errText()).toContain("No supported AI coding CLI was found");
  });

  it("rejects an unknown --cli value with exit 2", async () => {
    const c = await make();
    expect(await main(["init", "--cli", "vim"], c)).toBe(2);
    expect(c.errText()).toContain('Unknown CLI "vim"');
  });
});

describe("uninstall", () => {
  it("restores files byte for byte from the latest manifest and removes files that did not exist", async () => {
    const c = await make({
      adapters: [claudeAdapter, codexAdapter],
      exec: execFor({ claude: "2.1.4", codex: "codex-cli 0.46.0" }),
    });
    const original = '{\r\n\t"theme":"dark",\r\n  "x": [1,2]\r\n}';
    await seed(claudeJson(c), original);
    await main(["init", "--yes"], c);
    expect(await readFile(claudeJson(c), "utf8")).not.toBe(original);

    c.stdout.length = 0;
    expect(await main(["uninstall", "--yes"], c)).toBe(0);
    expect(c.outText()).toMatchSnapshot();
    expect(await readFile(claudeJson(c), "utf8")).toBe(original);
    expect(existsSync(claudeSettings(c))).toBe(false);
    expect(existsSync(join(c.home, ".codex", "config.toml"))).toBe(false);
  });

  it("falls back to each adapter's uninstallPlan when there is no manifest", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    // Install by hand, with no backup on record.
    const env = {
      home: c.home,
      platform: c.platform,
      cwd: c.home,
      exec: c.exec,
      conveno: c.conveno,
      env: {},
    };
    for (const ch of await claudeAdapter.plan(env)) await seed(ch.path, ch.after);
    expect(await main(["uninstall", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("No install backup found");
    expect(JSON.parse(await readFile(claudeJson(c), "utf8")).mcpServers ?? {}).not.toHaveProperty(
      "conveno",
    );
  });

  it("says so when there is nothing to remove", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    expect(await main(["uninstall", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Nothing to remove");
  });

  it("needs --yes without a terminal", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await main(["init", "--yes"], c);
    expect(await main(["uninstall"], c)).toBe(2);
    expect(c.errText()).toContain("conveno uninstall --yes");
  });
});

describe("status", () => {
  it("warns with a fix when no daemon is running", async () => {
    const c = await make();
    expect(await main(["status"], c)).toBe(0);
    expect(c.errText()).toMatchSnapshot();
  });

  it("groups sessions by repo and marks the orchestrator, against a real daemon", async () => {
    const c = await make();
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
      const a = await reg({ cli: "claude", pid: process.pid, hostPid: process.pid });
      await reg({ cli: "codex" });
      await reg({ cli: "opencode", cwd: "/work/docs", repo: { root: "/work/docs" } });
      await client["orchestrator.claim"]({ sessionId: a.session.id });
      expect(await main(["status"], c)).toBe(0);
      expect(c.outText()).toMatchSnapshot();
    } finally {
      await client.close();
      await d.stop();
    }
  });

  it("says when there are no sessions", async () => {
    const c = await make();
    const d = await startTestDaemon(c);
    try {
      expect(await main(["status"], c)).toBe(0);
      expect(c.outText()).toMatchSnapshot();
    } finally {
      await d.stop();
    }
  });
});

describe("doctor", () => {
  it("reports each CLI, the daemon and fixes when nothing is set up", async () => {
    const c = await make({
      adapters: [claudeAdapter, codexAdapter],
      exec: execFor({ claude: "2.1.4" }),
    });
    expect(await main(["doctor"], c)).toBe(0);
    expect(c.outText()).toMatchSnapshot("stdout");
    expect(c.errText()).toMatchSnapshot("stderr");
  });

  it("is green after init with a daemon up", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await main(["init", "--yes"], c);
    c.stdout.length = 0;
    const d = await startTestDaemon(c);
    try {
      expect(await main(["doctor"], c)).toBe(0);
      expect(c.outText()).toMatchSnapshot();
      expect(c.errText()).toBe("");
    } finally {
      await d.stop();
    }
  });
});

describe("daemon", () => {
  it("start connects with autoStart and the resolved daemon entry", async () => {
    const seen: unknown[] = [];
    const c = await make({
      daemonEntry: "/opt/conveno/daemon/bin.js",
      connect: (async (o: unknown) => {
        seen.push(o);
        return { close: async () => undefined };
      }) as never,
    });
    expect(await main(["daemon", "start"], c)).toBe(0);
    expect(seen).toMatchObject([
      { kind: "cli", autoStart: true, daemonEntry: "/opt/conveno/daemon/bin.js" },
    ]);
  });

  it("status reflects a real daemon", async () => {
    const c = await make();
    expect(await main(["daemon", "status"], c)).toBe(1);
    expect(c.outText()).toContain("daemon not running");
    const d = await startTestDaemon(c);
    try {
      c.stdout.length = 0;
      expect(await main(["daemon", "status"], c)).toBe(0);
      expect(c.outText()).toContain("daemon running");
    } finally {
      await d.stop();
    }
  });

  it.each(["linux", "win32"] as const)(
    "stop sends the lock file's pid a stop signal (%s)",
    async (platform) => {
      const taskkills: string[][] = [];
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      // On Windows, stop shells out to taskkill. The default fake exec only answers --version, so
      // stand in for taskkill by ending the child, and check the arguments it was given.
      const c = await make({
        platform,
        // Something answers the Conveno handshake on the socket.
        connect: (async () => ({ close: async () => undefined })) as never,
        exec: async (cmd, args) => {
          taskkills.push([cmd, ...args]);
          child.kill();
          return { code: 0, stdout: "" };
        },
      });
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      try {
        await seed(dataPaths(c.platform, c.dataDir).lock, JSON.stringify({ pid: child.pid }));
        expect(await main(["daemon", "stop"], c)).toBe(0);
        await exited;
        expect(c.outText()).toContain(`Stopped the daemon (pid ${child.pid})`);
        if (c.platform === "win32") {
          expect(taskkills).toEqual([["taskkill", "/PID", String(child.pid), "/T", "/F"]]);
        } else {
          expect(taskkills).toEqual([]);
        }
      } finally {
        child.kill("SIGKILL");
        // A win32 data path on a POSIX host is a relative file name; remove it.
        await rm(dataPaths(c.platform, c.dataDir).lock, { force: true });
      }
    },
  );

  it("stop never signals a pid when nothing answers as the daemon, and removes the stale lock", async () => {
    // An unrelated live process whose pid sits in the lock file.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const c = await make();
    const lock = dataPaths(c.platform, c.dataDir).lock;
    try {
      await seed(lock, JSON.stringify({ pid: child.pid }));
      expect(await main(["daemon", "stop"], c)).toBe(0);
      expect(c.outText()).toContain("Removed the stale lock file");
      expect(existsSync(lock)).toBe(false);
      expect(child.exitCode).toBeNull();
      expect(child.killed).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("stop with no daemon says so", async () => {
    const c = await make();
    expect(await main(["daemon", "stop"], c)).toBe(0);
    expect(c.outText()).toContain("Nothing to stop");
  });

  it("needs a subcommand", async () => {
    const c = await make();
    expect(await main(["daemon"], c)).toBe(2);
  });
});

describe("mcp", () => {
  it("runs the stdio server with the CLI name and the daemon entry", async () => {
    const calls: unknown[] = [];
    const c = await make({
      daemonEntry: "/d/bin.js",
      runMcp: async (o) => void calls.push(o),
    });
    expect(await main(["mcp", "--cli", "codex"], c)).toBe(0);
    expect(calls).toEqual([{ cli: "codex", daemonEntry: "/d/bin.js" }]);
  });

  it("requires a known --cli", async () => {
    const c = await make();
    expect(await main(["mcp"], c)).toBe(2);
    expect(await main(["mcp", "--cli", "emacs"], c)).toBe(2);
    expect(c.errText()).toContain("conveno mcp needs a CLI name");
  });
});

describe("hook", () => {
  it("delivers queued messages through the adapter, using ppid as the host pid", async () => {
    const c = await make({
      ppid: process.pid,
      readStdin: async () => '{"hook_event_name":"SessionStart"}',
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
        body: { text: "rename the migration" },
      } as never);
      expect(await main(["hook", "claude", "SessionStart"], c)).toBe(0);
      const printed = JSON.parse(c.outText());
      expect(printed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(printed.hookSpecificOutput.additionalContext).toContain("rename the migration");
      expect(c.errText()).toBe("");
    } finally {
      await client.close();
      await d.stop();
    }
  });

  it("prints nothing, exits 0 and does not start a daemon when none is running", async () => {
    const seen: { autoStart?: boolean }[] = [];
    const c = await make();
    const real = c.connect;
    c.connect = ((o: { autoStart?: boolean }) => (seen.push(o), real(o as never))) as never;
    expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
    expect(c.outText()).toBe("");
    expect(c.errText()).toBe("");
    expect(seen).toMatchObject([{ autoStart: false }]);
    expect(existsSync(c.socketPath as string)).toBe(false);
  });

  it("exits 0 for unknown CLIs and bad JSON", async () => {
    const c = await make({ readStdin: async () => "not json" });
    expect(await main(["hook", "vim", "Start"], c)).toBe(0);
    expect(await main(["hook", "claude", "SessionStart"], c)).toBe(0);
    expect(c.errText()).toBe("");
  });

  it("gives up after the timeout when the adapter hangs", async () => {
    const adapter = fakeAdapter({ cli: "claude", hook: () => new Promise(() => undefined) });
    const c = await make({
      adapters: [adapter],
      hookTimeoutMs: 50,
      connect: (async () => ({
        close: async () => undefined,
        "session.byHost": async () => ({ session: { id: "s" } }),
      })) as never,
    });
    const t0 = Date.now();
    expect(await main(["hook", "claude", "SessionStart"], c)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(c.outText()).toBe("");
  });
});

describe("conveno command and daemon entry", () => {
  it("falls back to node plus the bin path", () => {
    expect(convenoCommand({ PATH: "" }, "linux", "/x/bin.js", "/usr/bin/node")).toEqual([
      "/usr/bin/node",
      "/x/bin.js",
    ]);
  });

  it("uses plain `conveno` on Windows when the PATH shim starts this install", () => {
    const shim = "C:\\npm\\conveno.cmd";
    const bin = "C:\\npm\\node_modules\\@conveno\\cli\\dist\\bin.js";
    const text = `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@conveno\\cli\\dist\\bin.js" %*\r\n`;
    const io = {
      isFile: (p: string) => p.toLowerCase() === shim.toLowerCase(),
      readFile: (p: string) => (p.toLowerCase() === shim.toLowerCase() ? text : undefined),
      realpath: (p: string) => p,
    };
    expect(convenoCommand({ PATH: "C:\\npm" }, "win32", bin, "C:\\node.exe", io)).toEqual([
      "conveno",
    ]);
    expect(
      convenoCommand({ PATH: "C:\\npm" }, "win32", "D:\\elsewhere\\bin.js", "C:\\node.exe", io),
    ).toEqual(["C:\\node.exe", "D:\\elsewhere\\bin.js"]);
  });

  it.skipIf(process.platform === "win32")(
    "prefers `conveno` when PATH points at this install",
    async () => {
      const c = await make();
      const bin = join(c.root, "lib", "bin.js");
      await seed(bin, "#!/usr/bin/env node\n");
      const pathDir = join(c.root, "pathbin");
      await seed(join(pathDir, ".keep"), "");
      await symlink(bin, join(pathDir, "conveno"));
      expect(convenoCommand({ PATH: pathDir }, "linux", bin, "/usr/bin/node")).toEqual(["conveno"]);

      const other = join(c.root, "other.js");
      await writeFile(other, "");
      expect(convenoCommand({ PATH: pathDir }, "linux", other, "/usr/bin/node")).toEqual([
        "/usr/bin/node",
        other,
      ]);
    },
  );

  it("resolves the daemon entry through this package's own dependency", () => {
    const entry = resolveDaemonEntry();
    expect(entry).toBeDefined();
    expect(entry).toMatch(/conveno-daemon|daemon/);
    expect(existsSync(entry as string)).toBe(true);
  });
});
