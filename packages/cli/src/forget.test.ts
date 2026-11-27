import { createTheme } from "@conveno/brand";
import { connect } from "@conveno/client";
import { type DaemonHandle, startDaemon } from "@conveno/daemon";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseDuration } from "./forget.js";
import { main } from "./main.js";
import { FIXED_NOW, type TestCtx, testCtx } from "./test-utils.js";

beforeAll(() => {
  process.env.TZ = "UTC";
});

const ESC = "\u001b[";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour is the point
const stripColour = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");
const HOUR = 3_600_000;

const ctxs: TestCtx[] = [];
const daemons: DaemonHandle[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const c of ctxs.splice(0)) await c.cleanup();
});

interface Fixture {
  c: TestCtx;
  clock: { ms: number };
  /** Names of every session the daemon still lists. */
  names(): Promise<string[]>;
}

/**
 * A daemon with three sessions: `old-1` and `old-2` offline, `live` online. `old-1` was last seen
 * 5 hours before now and `old-2` just now.
 */
async function fixture(over: Parameters<typeof testCtx>[0] = {}): Promise<Fixture> {
  const c = await testCtx(over);
  ctxs.push(c);
  const clock = { ms: FIXED_NOW.getTime() };
  const daemon = await startDaemon({
    dataDir: c.dataDir,
    ...(c.socketPath ? { socketPath: c.socketPath } : {}),
    idleExitMs: Number.POSITIVE_INFINITY,
    now: () => new Date(clock.ms),
    sweepIntervalMs: 3_600_000,
    pathExists: () => true,
  });
  daemons.push(daemon);
  const client = await connect({
    kind: "mcp",
    dataDir: c.dataDir,
    socketPath: c.socketPath as string,
    autoStart: false,
  });
  const reg = (cwd: string) =>
    client["session.register"]({ cli: "claude", cwd, repo: { root: cwd } } as never);
  try {
    const old1 = await reg("/work/old-1");
    await client["session.unregister"]({ sessionId: old1.session.id });
    clock.ms += 5 * HOUR;
    const old2 = await reg("/work/old-2");
    await client["session.unregister"]({ sessionId: old2.session.id });
    await reg("/work/live");
  } finally {
    await client.close();
  }
  return {
    c,
    clock,
    async names() {
      const cl = await connect({
        kind: "mcp",
        dataDir: c.dataDir,
        socketPath: c.socketPath as string,
        autoStart: false,
      });
      try {
        return (await cl["session.list"]({ includeOffline: true })).sessions
          .map((s) => s.name)
          .sort();
      } finally {
        await cl.close();
      }
    },
  };
}

describe("parseDuration", () => {
  it("reads minutes, hours and days", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("24h")).toBe(24 * HOUR);
    expect(parseDuration("7d")).toBe(7 * 24 * HOUR);
  });
  it("refuses anything else", () => {
    for (const bad of ["", "7", "d", "7days", "-1h", "1.5h", "0m", "1 h", "1H", "1w"]) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });
});

describe("conveno forget", () => {
  it("--dry-run lists what would go and changes nothing", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "--offline", "--dry-run"], c)).toBe(0);
    const out = c.outText();
    expect(out).toContain("Would forget 2 sessions");
    expect(out).toContain("claude@old-1-1");
    expect(out).toContain("claude@old-2-1");
    expect(out).not.toContain("claude@live-1");
    expect(out).toContain("Dry run. Nothing was changed.");
    expect(out).not.toContain("Done.");
    expect(await names()).toHaveLength(3);
  });

  it("prints the sessions in the status table style", async () => {
    const { c } = await fixture();
    await main(["forget", "--offline", "--dry-run"], c);
    expect(c.outText()).toMatchInlineSnapshot(`
      "Would forget 2 sessions

        /work/old-1
          SESSION         CLI  TIER       STATE    LAST SEEN
        - claude@old-1-1  cl   next turn  offline  14:02:11

        /work/old-2
          SESSION         CLI  TIER       STATE    LAST SEEN
        - claude@old-2-1  cl   next turn  offline  19:02:11

        Their queued messages are deleted too. Messages they sent stay with the receivers.

      i Dry run. Nothing was changed.
      "
    `);
  });

  it("--yes forgets offline sessions without asking and ends with Done and the count", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "--offline", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Done. Forgot 2 sessions.");
    expect(await names()).toEqual(["claude@live-1"]);
  });

  it("matches a * pattern and quotes it in the rerun hint", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "claude@old-*", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Done. Forgot 2 sessions.");
    expect(await names()).toEqual(["claude@live-1"]);
  });

  it("lists a live match as skipped and never forgets it", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "claude@live-1", "claude@old-1-1", "--yes"], c)).toBe(0);
    const out = c.outText();
    expect(out).toContain("Skipped 1 online session");
    expect(out).toContain("claude@live-1");
    expect(out).toContain("a running session is never forgotten");
    expect(out).toContain("Done. Forgot 1 session.");
    expect(await names()).toEqual(["claude@live-1", "claude@old-2-1"]);
  });

  it("says there is nothing to forget when only a live session matched", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "claude@live-1", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Skipped 1 online session");
    expect(c.outText()).toContain("Nothing to forget.");
    expect(await names()).toHaveLength(3);
  });

  it("says there is nothing to forget when nothing matches", async () => {
    const { c } = await fixture();
    expect(await main(["forget", "no-such-*", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Nothing to forget.");
  });

  it("--older-than keeps newer offline sessions", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "--older-than", "1h", "--yes"], c)).toBe(0);
    expect(c.outText()).toContain("Done. Forgot 1 session.");
    expect(await names()).toEqual(["claude@live-1", "claude@old-2-1"]);
  });

  it("combines a name pattern with --older-than", async () => {
    const { c, names } = await fixture();
    expect(await main(["forget", "claude@old-*", "--older-than", "1h", "--yes"], c)).toBe(0);
    expect(await names()).toEqual(["claude@live-1", "claude@old-2-1"]);
  });

  describe("confirmation", () => {
    it("asks in a terminal, defaults to no, and forgets on yes", async () => {
      const asked: [string, boolean][] = [];
      const { c, names } = await fixture({
        interactive: true,
        confirm: async (q, d) => {
          asked.push([q, d]);
          return true;
        },
      });
      expect(await main(["forget", "--offline"], c)).toBe(0);
      expect(asked).toEqual([["Forget 2 sessions?", false]]);
      expect(c.outText()).toContain("Will forget 2 sessions");
      expect(c.outText()).toContain("Done. Forgot 2 sessions.");
      expect(await names()).toEqual(["claude@live-1"]);
    });

    it("changes nothing when the answer is no", async () => {
      const { c, names } = await fixture({ interactive: true, confirm: async () => false });
      expect(await main(["forget", "--offline"], c)).toBe(0);
      expect(c.outText()).toContain("Nothing was changed.");
      expect(c.outText()).not.toContain("Done.");
      expect(await names()).toHaveLength(3);
    });

    it("does not ask with --yes", async () => {
      const { c } = await fixture({
        interactive: true,
        confirm: async () => {
          throw new Error("must not ask");
        },
      });
      expect(await main(["forget", "--offline", "--yes"], c)).toBe(0);
    });

    it("does not ask with --dry-run", async () => {
      const { c } = await fixture({
        interactive: true,
        confirm: async () => {
          throw new Error("must not ask");
        },
      });
      expect(await main(["forget", "--offline", "--dry-run"], c)).toBe(0);
    });

    it("without a terminal exits 2 with a plain message, a rerun hint and changes nothing", async () => {
      const { c, names } = await fixture({ interactive: false });
      expect(await main(["forget", "claude@old-*"], c)).toBe(2);
      const err = c.errText();
      expect(err).toContain("Needs a terminal to confirm");
      expect(err).toContain("No sessions were forgotten.");
      expect(err).toContain("conveno forget 'claude@old-*' --yes");
      expect(err).toContain("exit 2");
      expect(err).toContain("e_no_tty");
      expect(await names()).toHaveLength(3);
    });
  });

  describe("usage errors", () => {
    it("needs a selector", async () => {
      const { c } = await fixture();
      expect(await main(["forget"], c)).toBe(2);
      expect(c.errText()).toContain("needs to know which sessions to forget");
      expect(c.errText()).toContain("e_usage");
    });

    it("rejects a bad duration", async () => {
      const { c } = await fixture();
      expect(await main(["forget", "--offline", "--older-than", "soon"], c)).toBe(2);
      expect(c.errText()).toContain('"soon" is not a duration');
      expect(c.errText()).toContain("30m");
    });

    it("rejects a name that cannot be a session name", async () => {
      const { c } = await fixture();
      expect(await main(["forget", "Has Space"], c)).toBe(2);
      expect(c.errText()).toContain('"Has Space" is not a session name or pattern');
    });

    it("suggests the closest option", async () => {
      const { c } = await fixture();
      expect(await main(["forget", "--offlin"], c)).toBe(2);
      expect(c.errText()).toContain("Unknown option --offlin for conveno forget");
      expect(c.errText()).toContain("Did you mean --offline?");
    });

    it("suggests forget for a mistyped command", async () => {
      const c = await testCtx();
      ctxs.push(c);
      expect(await main(["forgt"], c)).toBe(2);
      expect(c.errText()).toContain("Did you mean forget?");
    });

    it("needs a value for --older-than", async () => {
      const { c } = await fixture();
      expect(await main(["forget", "--older-than"], c)).toBe(2);
      expect(c.errText()).toContain("missing its value");
    });
  });

  it("explains that the daemon must run", async () => {
    const c = await testCtx();
    ctxs.push(c);
    expect(await main(["forget", "--offline", "--yes"], c)).toBe(1);
    expect(c.errText()).toContain("The Conveno daemon is not running");
    expect(c.errText()).toContain("conveno daemon start");
  });

  it("has its own help and is listed in the main help", async () => {
    const c = await testCtx();
    ctxs.push(c);
    expect(await main(["forget", "--help"], c)).toBe(0);
    const help = c.outText();
    expect(help).toContain("Usage: conveno forget");
    for (const flag of ["--offline", "--older-than <duration>", "--dry-run", "-y, --yes"]) {
      expect(help).toContain(flag);
    }
    c.stdout.length = 0;
    await main(["--help"], c);
    expect(c.outText()).toContain("forget [<name|pattern>...] [options]");
  });

  describe("colour", () => {
    const colourTheme = () =>
      createTheme({
        env: { TERM: "xterm-256color", LANG: "en_US.UTF-8" },
        isTTY: true,
        platform: "linux",
        color: "always",
      });

    it("paints with colour on, and the same text is left once the colour is stripped", async () => {
      const plain = await fixture();
      await main(["forget", "claude@old-*", "claude@live-1", "--dry-run"], plain.c);
      const coloured = await fixture({ theme: colourTheme() });
      await main(["forget", "claude@old-*", "claude@live-1", "--dry-run"], coloured.c);
      expect(plain.c.outText()).not.toContain(ESC);
      expect(coloured.c.outText()).toContain(ESC);
      expect(stripColour(coloured.c.outText())).toBe(plain.c.outText());
      expect(coloured.c.errText()).toBe("");
    });

    it("keeps the Done line and the prompt hint readable in colour", async () => {
      const f = await fixture({ theme: colourTheme() });
      expect(await main(["forget", "--offline", "--yes"], f.c)).toBe(0);
      expect(stripColour(f.c.outText())).toContain("Done. Forgot 2 sessions.");
      expect(f.c.errText()).not.toContain("e_internal");
    });
  });
});
