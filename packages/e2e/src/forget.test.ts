import { execFile, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliClient,
  type DaemonProc,
  type FakeSession,
  makeEnv,
  makeRepo,
  nameOf,
  removeEnv,
  startDaemonProc,
  startFakeSession,
  type TestEnv,
  waitFor,
} from "./harness.js";

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli", "dist", "bin.js");

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run the built `conveno` against the isolated daemon. Its stdin is not a terminal. */
function conveno(t: TestEnv, ...args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_BIN, ...args],
      { env: { ...process.env, ...t.env, NO_COLOR: "1" }, windowsHide: true },
      (error, out, err) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, out, err });
      },
    );
  });
}

// The daemon marks a dead host offline at its next 15 s sweep, so this waits for real sweeps.
describe("conveno forget against the real daemon", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let keep: FakeSession;
  let gone: FakeSession;
  let keepName = "";
  let goneName = "";
  let ghostName = "";

  const listed = async (): Promise<string[]> => {
    const client = await cliClient(t);
    try {
      return (await client["session.list"]({ includeOffline: true })).sessions.map((s) => s.name);
    } finally {
      await client.close();
    }
  };

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    keep = await startFakeSession(t, "codex", makeRepo(t, "keep"));
    gone = await startFakeSession(t, "claude", makeRepo(t, "conveno-real-gone"));
    keepName = nameOf((await keep.call("whoami")).text);
    goneName = nameOf((await gone.call("whoami")).text);
  });

  afterAll(async () => {
    await Promise.all([keep?.close(), gone?.close()]);
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("the sweep forgets an offline session whose folder was deleted, and keeps the others", async () => {
    expect((await gone.call("send", { to: keepName, text: "from gone" })).isError).toBe(false);
    expect((await keep.call("send", { to: goneName, text: "to gone" })).isError).toBe(false);

    // A session in a folder that never existed, hosted by a process that has already exited. It
    // costs no extra processes, which matters on slow CI machines.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const client = await cliClient(t);
    try {
      const { session } = await client["session.register"]({
        cli: "claude",
        cwd: join(t.root, "deleted-repo"),
        hostPid: dead,
      });
      ghostName = session.name;
    } finally {
      await client.close();
    }
    gone.killHost();

    // One sweep marks both offline, the next removes the ghost. The other offline session stays,
    // because its folder exists and a day has not passed.
    await waitFor("the ghost session to be forgotten", async () => {
      return !(await listed()).includes(ghostName);
    });
    const names = await listed();
    expect(names).toContain(goneName);
    expect(names).toContain(keepName);
  });

  it("--dry-run lists the offline session and changes nothing", async () => {
    const r = await conveno(t, "forget", "--offline", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Would forget 1 session");
    expect(r.out).toContain(goneName);
    expect(r.out).not.toContain(keepName);
    expect(r.out).toContain("Dry run. Nothing was changed.");
    expect(await listed()).toContain(goneName);
  });

  it("without a terminal and without --yes it exits 2 and changes nothing", async () => {
    const r = await conveno(t, "forget", "--offline");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Needs a terminal to confirm");
    expect(await listed()).toContain(goneName);
  });

  it("--yes forgets the offline session, skips the live one and keeps mail it sent", async () => {
    const r = await conveno(t, "forget", "*@conveno-real-*", keepName, "--yes");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Skipped 1 online session");
    expect(r.out).toContain(keepName);
    expect(r.out).toContain("Done. Forgot 1 session.");
    const names = await listed();
    expect(names).not.toContain(goneName);
    expect(names).toContain(keepName);

    // What the forgotten session sent stays readable in the live session's inbox.
    const inbox = await keep.call("inbox");
    expect(inbox.text).toContain("from gone");
    expect(inbox.text).toContain(goneName);
    // Its own mailbox went with it, and the name no longer resolves.
    const toGone = await keep.call("send", { to: goneName, text: "still there?" });
    expect(toGone.isError).toBe(true);
    expect(toGone.text).toContain(`No session named "${goneName}"`);
  });

  it("has nothing left to forget", async () => {
    const r = await conveno(t, "forget", "--offline", "--yes");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Nothing to forget.");
  });
});
