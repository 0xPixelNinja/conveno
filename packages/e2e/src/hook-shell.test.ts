import { existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOT_FROM_USER_NOTICE } from "@0xpixelninja/conveno-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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

// A real CLI runs hooks as `/bin/sh -c "<command>"`. Under dash the shell does not exec the last
// command when something follows it, so the hook's parent is the shell, not the CLI that
// registered as a session. The hook has to look further up the process tree.
describe.skipIf(process.platform === "win32")(
  "hook run through sh -c (skipped on Windows: it has no sh, and hooks there start through cmd.exe)",
  () => {
    let t: TestEnv;
    let daemon: DaemonProc;
    let sender: FakeSession;
    let target: FakeSession;
    let outFile: string;
    let trigger: string;

    beforeAll(async () => {
      t = await makeEnv();
      daemon = await startDaemonProc(t);
      sender = await startFakeSession(t, "codex", makeRepo(t, "sender"));
      outFile = join(t.root, "hook.out");
      trigger = join(t.root, "hook.trigger");
      // The trailing `true` keeps sh from exec-ing node, so sh stays between the hook and the host.
      const command = `"${process.execPath}" "${CLI_BIN}" hook claude UserPromptSubmit; true`;
      target = await startFakeSession(t, "claude", makeRepo(t, "target"), {
        FAKE_TRIGGER: trigger,
        FAKE_SH_CMD: command,
        FAKE_SH_OUT: outFile,
      });
    });

    afterAll(async () => {
      await Promise.all([sender?.close(), target?.close()]);
      await daemon?.stop();
      if (t) await removeEnv(t);
    });

    it("delivers through the CLI above the shell", async () => {
      expect(existsSync(CLI_BIN)).toBe(true);
      const name = nameOf((await target.call("whoami")).text);
      await sender.call("send", { to: name, text: "reached through sh" });

      writeFileSync(trigger, "");
      await waitFor("the hook to finish", () => existsSync(`${outFile}.done`));

      const out = (await readFile(outFile, "utf8")).trim();
      const json = JSON.parse(out) as {
        hookSpecificOutput: { hookEventName: string; additionalContext: string };
      };
      expect(json.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(json.hookSpecificOutput.additionalContext).toContain("reached through sh");
      expect(json.hookSpecificOutput.additionalContext).toContain(NOT_FROM_USER_NOTICE);
    });
  },
);
