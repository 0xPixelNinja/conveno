import { claudeAdapter } from "@0xpixelninja/conveno-adapter-claude";
import { codexAdapter } from "@0xpixelninja/conveno-adapter-codex";
import { type ConvenoClient, NOT_FROM_USER_NOTICE } from "@0xpixelninja/conveno-core";
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
} from "./harness.js";

interface HookJson {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

describe("hook path with real host pids", () => {
  let t: TestEnv;
  let daemon: DaemonProc;
  let sender: FakeSession;
  let claude: FakeSession;
  let codex: FakeSession;
  let client: ConvenoClient;

  beforeAll(async () => {
    t = await makeEnv();
    daemon = await startDaemonProc(t);
    sender = await startFakeSession(t, "claude", makeRepo(t, "sender"));
    claude = await startFakeSession(t, "claude", makeRepo(t, "target"));
    codex = await startFakeSession(t, "codex", makeRepo(t, "codexrepo"));
    client = await cliClient(t, "adapter");
  });

  afterAll(async () => {
    await client?.close();
    await Promise.all([sender?.close(), claude?.close(), codex?.close()]);
    await daemon?.stop();
    if (t) await removeEnv(t);
  });

  it("claude hook delivers once as additionalContext JSON; history stays in the inbox", async () => {
    const claudeName = nameOf((await claude.call("whoami")).text);
    await sender.call("send", { to: claudeName, text: "hook me, first" });
    await sender.call("send", { to: claudeName, text: "hook me, second", urgent: true });

    const out = await claudeAdapter.hook(
      "UserPromptSubmit",
      {},
      { client, hostPid: claude.hostPid },
    );
    expect(out.exitCode).toBe(0);
    const json = JSON.parse(out.stdout) as HookJson;
    expect(Object.keys(json)).toEqual(["hookSpecificOutput"]);
    expect(json.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx = json.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("[conveno] 2 new messages from other sessions");
    expect(ctx).toContain(NOT_FROM_USER_NOTICE);
    expect(ctx).toContain("hook me, first");
    expect(ctx.indexOf("hook me, second")).toBeLessThan(ctx.indexOf("hook me, first"));

    // Delivered messages are not injected a second time.
    const again = await claudeAdapter.hook(
      "UserPromptSubmit",
      {},
      { client, hostPid: claude.hostPid },
    );
    expect(again.stdout).toBe("");

    // They are still in the inbox history.
    const history = await claude.call("inbox", { unread_only: false });
    expect(history.text).toContain("hook me, first");
    expect(history.text).toContain("hook me, second");
  });

  it("claude hook prints nothing for unknown events and unknown host pids", async () => {
    const other = await claudeAdapter.hook("Stop", {}, { client, hostPid: claude.hostPid });
    expect(other.stdout).toBe("");
    // A pid nobody registered with. Highest valid pid on every platform we run on.
    const unknown = await claudeAdapter.hook("SessionStart", {}, { client, hostPid: 2 ** 22 - 1 });
    expect(unknown.stdout).toBe("");
  });

  it("codex hook delivers through the same path", async () => {
    const codexName = nameOf((await codex.call("whoami")).text);
    await sender.call("send", { to: codexName, text: "hello codex" });

    const out = await codexAdapter.hook("SessionStart", {}, { client, hostPid: codex.hostPid });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.endsWith("\n")).toBe(true);
    const json = JSON.parse(out.stdout) as HookJson;
    expect(json.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(json.hookSpecificOutput.additionalContext).toContain("hello codex");
    expect(json.hookSpecificOutput.additionalContext).toContain(NOT_FROM_USER_NOTICE);

    const again = await codexAdapter.hook(
      "UserPromptSubmit",
      {},
      { client, hostPid: codex.hostPid },
    );
    expect(again.stdout).toBe("");
    const history = await codex.call("inbox", { unread_only: false });
    expect(history.text).toContain("hello codex");
  });

  it("a message is delivered to the right session's hook only", async () => {
    const senderName = nameOf((await sender.call("whoami")).text);
    await claude.call("send", { to: senderName, text: "only for sender" });
    const wrong = await claudeAdapter.hook(
      "UserPromptSubmit",
      {},
      { client, hostPid: claude.hostPid },
    );
    expect(wrong.stdout).toBe("");
    const right = await claudeAdapter.hook(
      "UserPromptSubmit",
      {},
      { client, hostPid: sender.hostPid },
    );
    expect(right.stdout).toContain("only for sender");
  });

  // Bug found by e2e (client/mcp): the client's zod check answers before the daemon, so the agent
  // sees "invalid session name" without the rule from core's validateRename. Remove `.fails` when fixed.
  it.fails("rename with a bad name tells the agent the naming rule", async () => {
    const r = await sender.call("rename", { name: "Not Valid!" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Use 1 to 64 characters");
  });
});
