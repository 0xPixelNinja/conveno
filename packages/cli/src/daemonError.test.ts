import { ClientError, type ClientErrorKind } from "@conveno/client";
import { afterEach, describe, expect, it } from "vitest";
import { daemonProblem } from "./daemonError.js";
import { main } from "./main.js";
import { plainTheme, type TestCtx, testCtx } from "./test-utils.js";

const ctxs: TestCtx[] = [];
afterEach(async () => {
  for (const c of ctxs.splice(0)) await c.cleanup();
});

const failing = async (kind: ClientErrorKind | undefined, message = "It broke.") => {
  const c = await testCtx({
    connect: (async () => {
      throw new ClientError(message, { kind });
    }) as never,
  });
  ctxs.push(c);
  return c;
};

describe("daemonProblem: every fix matches its why", () => {
  const t = plainTheme();
  const cases: [ClientErrorKind, RegExp][] = [
    ["socket_path_too_long", /XDG_RUNTIME_DIR.*shorter directory/],
    ["no_daemon", /conveno daemon start/],
    ["permission", /who owns the socket/],
    ["not_daemon", /Stop the process that owns the socket/],
    ["token_empty", /conveno daemon stop.*conveno daemon start/],
    ["daemon_missing", /Reinstall Conveno/],
    ["start_timeout", /conveno daemon status/],
    ["connection", /conveno daemon status/],
  ];
  it.each(cases)("%s", (kind, fix) => {
    const p = daemonProblem(t, new ClientError("why", { kind }));
    expect(p.fix).toMatch(fix);
    expect(p.notRunning).toBe(kind === "no_daemon");
  });
  it("sends an unknown error to doctor, never to daemon start", () => {
    expect(daemonProblem(t, new Error("odd")).fix).toMatch(/conveno doctor/);
    expect(daemonProblem(t, new Error("odd")).fix).not.toMatch(/daemon start/);
  });
});

describe("a socket path that is too long", () => {
  const long = "The Conveno socket path is too long for this system.";
  it("doctor says to set XDG_RUNTIME_DIR, not to run daemon start", async () => {
    const c = await failing("socket_path_too_long", long);
    expect(await main(["doctor"], c)).toBe(1);
    expect(c.errText()).toContain(long);
    expect(c.errText()).toMatch(/fix\s+Set XDG_RUNTIME_DIR to a shorter directory/);
    expect(c.outText()).toContain("cannot be reached");
  });
  it("status, daemon status and daemon start say the same", async () => {
    for (const argv of [["status"], ["daemon", "status"], ["daemon", "start"]]) {
      const c = await failing("socket_path_too_long", long);
      await main(argv, c);
      expect(c.errText(), argv.join(" ")).toMatch(/fix\s+Set XDG_RUNTIME_DIR/);
    }
  });
});
