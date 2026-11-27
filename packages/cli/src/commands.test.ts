import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import claudeAdapter from "@conveno/adapter-claude";
import codexAdapter from "@conveno/adapter-codex";
import { connect } from "@conveno/client";
import { dataPaths } from "@conveno/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { convenoCommand, resolveDaemonEntry } from "./runtime.js";
import {
  ancestryOf,
  type FakeProcs,
  fakeAdapter,
  seed,
  startTestDaemon,
  type TestCtx,
  testCtx,
} from "./test-utils.js";

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
    expect(c.outText()).toBe("0.1.1-rc.1\n");
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
      const a = await reg({
        cli: "claude",
        pid: process.pid,
        hostPid: process.pid,
        hostPids: [process.pid],
      });
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

  it("says what is lost when process ancestry is unavailable, as a warning, not a failure", async () => {
    const c = await make({
      platform: "win32",
      exec: execFor({ claude: "2.1.4" }),
      ancestry: async () => ({
        entries: [{ pid: 4242 }],
        pids: [4242],
        hostPid: 4242,
        complete: false,
      }),
    });
    expect(await main(["doctor"], c)).toBe(0);
    expect(c.errText()).toContain("Process ancestry is unavailable.");
    expect(c.errText()).toContain("WMI denies it to non-admin remote logons");
    expect(c.errText()).toContain("conveno.cmd");
    expect(c.outText()).toMatch(/\d+ warnings?/);
  });

  it("stays quiet about ancestry when it works", async () => {
    const c = await make({ exec: execFor({ claude: "2.1.4" }) });
    await main(["doctor"], c);
    expect(c.errText()).not.toContain("ancestry");
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

  describe("stop", () => {
    const DAEMON_CMD = "/usr/bin/node /opt/conveno/node_modules/@conveno/daemon/dist/bin.js";

    /** What the context's `exec` was asked to run. Stop must never reach for taskkill. */
    const neverExec = (calls: string[][]) => async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { code: 1, stdout: "" };
    };

    /** A fake daemon behind `connect`: answers until `daemon.shutdown`, then vanishes. */
    function fakeDaemon(
      c: TestCtx,
      opts: { shutdown?: () => Promise<unknown>; lingers?: boolean; exitPolls?: number } = {},
    ) {
      const state = { up: true, shutdowns: 0, aliveChecks: 0 };
      const lock = dataPaths(c.platform, c.dataDir).lock;
      // The fake daemon's process (the made-up pid in its lock) lives exactly as long as the fake
      // daemon does. Real pids must not leak in: 4242 can be a live process on a CI runner.
      // `exitPolls`: the process outlives its socket and lock for that many liveness checks.
      const realIsAlive = c.isAlive;
      let exitPolls = opts.exitPolls ?? 0;
      c.isAlive = (pid) => {
        if (pid !== 4242) return realIsAlive(pid);
        state.aliveChecks++;
        return state.up || exitPolls-- > 0;
      };
      c.connect = (async () => {
        if (!state.up) throw new Error("ECONNREFUSED");
        return {
          close: async () => undefined,
          "daemon.shutdown": async () => {
            state.shutdowns++;
            if (opts.shutdown) return opts.shutdown();
            if (!opts.lingers) {
              state.up = false;
              await rm(lock, { force: true });
            }
            return { ok: true };
          },
        };
      }) as never;
      return state;
    }

    it.each(["linux", "win32"] as const)(
      "asks the daemon to shut down over the control channel, with no signal and no taskkill (%s)",
      async (platform) => {
        const execs: string[][] = [];
        const killed: number[] = [];
        const c = await make({
          platform,
          exec: neverExec(execs),
          kill: (pid) => void killed.push(pid),
        });
        const lock = dataPaths(c.platform, c.dataDir).lock;
        try {
          await seed(lock, JSON.stringify({ pid: 4242 }));
          const state = fakeDaemon(c);
          expect(await main(["daemon", "stop"], c)).toBe(0);
          expect(state.shutdowns).toBe(1);
          expect(c.outText()).toContain("Stopped the daemon (pid 4242)");
          expect(existsSync(lock)).toBe(false);
          expect(killed).toEqual([]);
          expect(execs).toEqual([]);
        } finally {
          await rm(lock, { force: true });
        }
      },
    );

    it("waits for the daemon process to exit, not only for its socket and lock", async () => {
      const c = await make();
      const lock = dataPaths(c.platform, c.dataDir).lock;
      try {
        await seed(lock, JSON.stringify({ pid: 4242 }));
        // As a daemon still closing its database does.
        const state = fakeDaemon(c, { exitPolls: 3 });
        expect(await main(["daemon", "stop"], c)).toBe(0);
        expect(state.aliveChecks).toBeGreaterThan(3);
        expect(c.outText()).toContain("Stopped the daemon (pid 4242)");
      } finally {
        await rm(lock, { force: true });
      }
    });

    it("connects without autoStart", async () => {
      const seen: { autoStart?: boolean }[] = [];
      const c = await make();
      const inner = fakeDaemon(c);
      const wrapped = c.connect;
      c.connect = ((o: { autoStart?: boolean }) => {
        seen.push(o);
        return wrapped(o as never);
      }) as never;
      expect(await main(["daemon", "stop"], c)).toBe(0);
      expect(inner.shutdowns).toBe(1);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((o) => o.autoStart === false)).toBe(true);
    });

    it("stops a real daemon and waits until its socket and lock are gone", async () => {
      // This daemon runs inside the test process, so the pid in its lock (ours) never exits.
      // Count that pid as exited once the daemon has let go of its lock, as a real one would.
      let lock = "";
      const c = await make({
        isAlive: (pid) => pid !== process.pid || existsSync(lock),
      });
      const d = await startTestDaemon(c);
      lock = dataPaths(c.platform, c.dataDir).lock;
      try {
        expect(existsSync(lock)).toBe(true);
        expect(await main(["daemon", "stop"], c)).toBe(0);
        expect(c.outText()).toContain("Stopped the daemon");
        expect(existsSync(lock)).toBe(false);
        if (process.platform !== "win32") expect(existsSync(c.socketPath as string)).toBe(false);
        expect(await main(["daemon", "status"], c)).toBe(1);
      } finally {
        await d.stop();
      }
    });

    it("fails, without killing anything, when the daemon says ok but keeps answering", async () => {
      const killed: number[] = [];
      const c = await make({ stopTimeoutMs: 250, kill: (pid) => void killed.push(pid) });
      await seed(dataPaths(c.platform, c.dataDir).lock, JSON.stringify({ pid: 4242 }));
      fakeDaemon(c, { lingers: true });
      expect(await main(["daemon", "stop"], c)).toBe(1);
      expect(c.errText()).toContain("is still running after");
      expect(c.errText()).toContain("ref e_daemon_stop");
      expect(killed).toEqual([]);
    });

    it("fails, without killing anything, when the daemon refuses the request", async () => {
      const killed: number[] = [];
      const c = await make({ kill: (pid) => void killed.push(pid) });
      await seed(dataPaths(c.platform, c.dataDir).lock, JSON.stringify({ pid: 4242 }));
      fakeDaemon(c, {
        shutdown: async () => {
          throw new Error(
            "Method not found: daemon.shutdown. This version of the Conveno daemon does not support it.",
          );
        },
      });
      expect(await main(["daemon", "stop"], c)).toBe(1);
      expect(c.errText()).toContain("did not accept the stop request");
      expect(c.errText()).toContain("Method not found");
      expect(killed).toEqual([]);
    });

    it("with no daemon and no lock says so", async () => {
      const c = await make();
      expect(await main(["daemon", "stop"], c)).toBe(0);
      expect(c.outText()).toContain("Nothing to stop");
    });

    it("removes a lock whose pid is dead, and stops nothing", async () => {
      const killed: number[] = [];
      const c = await make({ isAlive: () => false, kill: (pid) => void killed.push(pid) });
      const lock = dataPaths(c.platform, c.dataDir).lock;
      await seed(lock, JSON.stringify({ pid: 4242 }));
      expect(await main(["daemon", "stop"], c)).toBe(0);
      expect(c.outText()).toContain("Removed the stale lock file");
      expect(existsSync(lock)).toBe(false);
      expect(killed).toEqual([]);
    });

    it("never signals an unrelated live process that holds the lock's pid, and removes the stale lock", async () => {
      // A real live process whose pid sits in the lock file, with no daemon on the socket.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      const killed: number[] = [];
      const c = await make({
        isAlive: (pid) => pid === child.pid,
        commandLineOf: async () => `${process.execPath} -e setInterval(() => {}, 1000)`,
        kill: (pid) => void killed.push(pid),
      });
      const lock = dataPaths(c.platform, c.dataDir).lock;
      try {
        await seed(lock, JSON.stringify({ pid: child.pid }));
        expect(await main(["daemon", "stop"], c)).toBe(0);
        expect(c.outText()).toContain("Removed the stale lock file");
        expect(existsSync(lock)).toBe(false);
        expect(killed).toEqual([]);
        expect(child.exitCode).toBeNull();
        expect(child.killed).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    });

    it("does not kill or unlock when it cannot verify the process, and says so plainly", async () => {
      const killed: number[] = [];
      const c = await make({
        isAlive: () => true,
        commandLineOf: async () => null,
        kill: (pid) => void killed.push(pid),
      });
      const lock = dataPaths(c.platform, c.dataDir).lock;
      await seed(lock, JSON.stringify({ pid: 4242 }));
      expect(await main(["daemon", "stop"], c)).toBe(1);
      expect(killed).toEqual([]);
      expect(existsSync(lock)).toBe(true);
      expect(c.errText()).toContain("pid 4242 could not be checked");
      expect(c.errText()).toContain("stopped nothing");
      expect(c.errText()).toContain("ref e_daemon_lock");
    });

    it.each(["linux", "win32"] as const)(
      "ends a verified daemon that does not answer with process.kill, not taskkill (%s)",
      async (platform) => {
        const execs: string[][] = [];
        const alive = new Set([4242]);
        const killed: number[] = [];
        const c = await make({
          platform,
          exec: neverExec(execs),
          isAlive: (pid) => alive.has(pid),
          commandLineOf: async () => DAEMON_CMD,
          kill: (pid) => {
            killed.push(pid);
            alive.delete(pid);
          },
        });
        const lock = dataPaths(c.platform, c.dataDir).lock;
        try {
          await seed(lock, JSON.stringify({ pid: 4242 }));
          expect(await main(["daemon", "stop"], c)).toBe(0);
          expect(killed).toEqual([4242]);
          expect(execs).toEqual([]);
          expect(c.outText()).toContain("Stopped the daemon (pid 4242)");
          // A terminated process cannot remove its own lock.
          expect(existsSync(lock)).toBe(false);
        } finally {
          await rm(lock, { force: true });
        }
      },
    );

    it("recognises the daemon by the entry script this install resolved", async () => {
      const killed: number[] = [];
      const alive = new Set([4242]);
      const c = await make({
        daemonEntry: "/work/conveno/packages/daemon/dist/bin.js",
        isAlive: (pid) => alive.has(pid),
        commandLineOf: async () => "node /work/conveno/packages/daemon/dist/bin.js",
        kill: (pid) => {
          killed.push(pid);
          void alive.delete(pid);
        },
      });
      await seed(dataPaths(c.platform, c.dataDir).lock, JSON.stringify({ pid: 4242 }));
      expect(await main(["daemon", "stop"], c)).toBe(0);
      expect(killed).toEqual([4242]);
    });

    it("fails plainly when the kill is refused or the process stays alive", async () => {
      const refused = await make({
        isAlive: () => true,
        commandLineOf: async () => DAEMON_CMD,
        kill: () => {
          throw new Error("EPERM: operation not permitted");
        },
      });
      await seed(dataPaths(refused.platform, refused.dataDir).lock, JSON.stringify({ pid: 4242 }));
      expect(await main(["daemon", "stop"], refused)).toBe(1);
      expect(refused.errText()).toContain("Could not stop the daemon (pid 4242)");
      expect(refused.errText()).toContain("EPERM");

      const stubborn = await make({
        stopTimeoutMs: 200,
        isAlive: () => true,
        commandLineOf: async () => DAEMON_CMD,
        kill: () => undefined,
      });
      await seed(
        dataPaths(stubborn.platform, stubborn.dataDir).lock,
        JSON.stringify({ pid: 4242 }),
      );
      expect(await main(["daemon", "stop"], stubborn)).toBe(1);
      expect(stubborn.errText()).toContain("is still running after");
    });
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
  // A Windows tree. npm installs conveno as conveno.cmd, so each side runs through a cmd.exe shim.
  //   powershell 200 > claude 300 (the CLI)
  //     > cmd.exe 400 (shim) > node 500            the MCP server
  //     > bash 405 -c "conveno hook" > cmd.exe 410 (shim) > node 510   a hook
  //   powershell 200 > claude 301 (another CLI, no Conveno session) > bash 406 > cmd.exe 411 > node 511
  const SHIM = String.raw`C:\Users\u\AppData\Roaming\npm\conveno.cmd`;
  const winProcs: FakeProcs = {
    200: [100, "powershell.exe"],
    300: [200, String.raw`C:\Users\u\AppData\Roaming\npm\claude.exe`],
    400: [300, String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""${SHIM}" mcp --cli claude"`],
    500: [
      400,
      String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@conveno\cli\dist\bin.js mcp --cli claude`,
    ],
    405: [300, `bash -c "conveno hook claude UserPromptSubmit"`],
    410: [
      405,
      String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""${SHIM}" hook claude UserPromptSubmit"`,
    ],
    510: [
      410,
      String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@conveno\cli\dist\bin.js hook claude UserPromptSubmit`,
    ],
    301: [200, String.raw`C:\Users\u\AppData\Roaming\npm\claude.exe`],
    406: [301, `bash -c "conveno hook claude UserPromptSubmit"`],
    411: [
      406,
      String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""${SHIM}" hook claude UserPromptSubmit"`,
    ],
    511: [
      411,
      String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@conveno\cli\dist\bin.js hook claude UserPromptSubmit`,
    ],
  };
  /** What the MCP server in `winProcs` registers: found by the same logic the hook uses. */
  const mcpHost = async () => {
    const a = await ancestryOf(winProcs, { pid: 500, ppid: 400 })(1_000);
    return { hostPid: a.hostPid, hostPids: a.pids };
  };

  /** A daemon with two sessions, the other messaging the one registered with `mine`. */
  async function withPair(
    c: TestCtx,
    mine: { hostPid?: number | undefined; hostPids?: number[] },
    run: () => Promise<void>,
    other: { hostPid?: number; hostPids?: number[] } = {},
  ) {
    const d = await startTestDaemon(c);
    const client = await connect({
      kind: "mcp",
      dataDir: c.dataDir,
      socketPath: c.socketPath as string,
      autoStart: false,
    });
    const reg = (over: Record<string, unknown>) =>
      client["session.register"]({ cwd: "/work/api", pid: process.pid, ...over } as never);
    try {
      const me = await reg({ cli: "claude", ...mine });
      const peer = await reg({ cli: "codex", ...other });
      await client["message.send"]({
        sessionId: peer.session.id,
        to: me.session.name,
        kind: "text",
        body: { text: "rename the migration" },
      } as never);
      await run();
    } finally {
      await client.close();
      await d.stop();
    }
  }

  const hookCtx = (over: Partial<Parameters<typeof testCtx>[0]> = {}) =>
    make({ readStdin: async () => '{"hook_event_name":"UserPromptSubmit"}', ...over });

  it("delivers queued messages through the adapter, matching the hook's host pid to the session", async () => {
    const asked: number[] = [];
    const c = await make({
      ancestry: async (ms) => {
        asked.push(ms);
        return {
          entries: [{ pid: process.pid }],
          pids: [process.pid],
          hostPid: process.pid,
          complete: true,
        };
      },
      readStdin: async () => '{"hook_event_name":"SessionStart"}',
    });
    await withPair(c, { hostPid: process.pid, hostPids: [process.pid] }, async () => {
      expect(await main(["hook", "claude", "SessionStart"], c)).toBe(0);
      const printed = JSON.parse(c.outText());
      expect(printed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(printed.hookSpecificOutput.additionalContext).toContain("rename the migration");
      expect(c.errText()).toBe("");
      // One lookup, inside the hook budget.
      expect(asked).toEqual([1_200]);
    });
  });

  it("finds the CLI through conveno.cmd shims and bash -c on Windows", async () => {
    const mcp = await mcpHost();
    // Registered as the CLI itself, not the cmd.exe shim in between.
    expect(mcp).toEqual({ hostPid: 300, hostPids: [400, 300, 200, 100] });
    const c = await hookCtx({
      platform: "win32",
      ancestry: ancestryOf(winProcs, { pid: 510, ppid: 410 }),
    });
    await withPair(c, mcp, async () => {
      expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
      expect(c.outText()).toContain("rename the migration");
      expect(c.errText()).toBe("");
    });
  });

  it("matches nothing for an unregistered CLI that shares a shell and terminal with a registered one", async () => {
    const c = await hookCtx({
      platform: "win32",
      ancestry: ancestryOf(winProcs, { pid: 511, ppid: 411 }),
    });
    await withPair(c, await mcpHost(), async () => {
      expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
      expect(c.outText()).toBe("");
      expect(c.errText()).toBe("");
    });
  });

  it("delivers nothing when two sessions sit under one CLI process, never guessing", async () => {
    const mcp = await mcpHost();
    const c = await hookCtx({
      platform: "win32",
      ancestry: ancestryOf(winProcs, { pid: 510, ppid: 410 }),
    });
    await withPair(
      c,
      mcp,
      async () => {
        expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
        expect(c.outText()).toBe("");
      },
      mcp,
    );
  });

  it("falls back to the direct parent when the process list is denied, without a word on stderr", async () => {
    // WMI refuses a non-admin NETWORK logon. With no shim the direct parent is the CLI and still matches.
    const direct: FakeProcs = { 300: [200, "claude.exe"], 510: [300, "node bin.js hook"] };
    const c = await hookCtx({
      ancestry: ancestryOf(direct, { pid: 510, ppid: 300 }, { denied: true }),
    });
    await withPair(c, { hostPid: 300, hostPids: [300] }, async () => {
      expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
      expect(c.outText()).toContain("rename the migration");
      expect(c.errText()).toBe("");
    });

    // Behind a shim the direct parent (410) is not the registered CLI (300): exact equality fails.
    const shim = await hookCtx({
      platform: "win32",
      ancestry: ancestryOf(winProcs, { pid: 510, ppid: 410 }, { denied: true }),
    });
    await withPair(shim, await mcpHost(), async () => {
      expect(await main(["hook", "claude", "UserPromptSubmit"], shim)).toBe(0);
      expect(shim.outText()).toBe("");
      expect(shim.errText()).toBe("");
    });
  });

  it("stays inside the hook budget when the process-table query never answers", async () => {
    const c = await make({
      hookTimeoutMs: 80,
      ancestry: () => new Promise(() => undefined),
      connect: (async () => ({ close: async () => undefined })) as never,
    });
    const t0 = Date.now();
    expect(await main(["hook", "claude", "UserPromptSubmit"], c)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(c.outText()).toBe("");
  });

  it("prints nothing, exits 0 and does not start a daemon when none is running", async () => {
    const seen: { autoStart?: boolean }[] = [];
    const c = await make();
    const real = c.connect;
    c.connect = ((o: { autoStart?: boolean }) => {
      seen.push(o);
      return real(o as never);
    }) as never;
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
