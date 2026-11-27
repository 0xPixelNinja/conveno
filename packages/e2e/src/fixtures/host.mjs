// Fake host CLI. Spawns the MCP server with the stdio it was given, so the MCP server's
// parent pid (hostPid) is this process. Stays alive until killed or its child exits.
//
// Optional hook runner: when FAKE_TRIGGER and FAKE_SH_CMD are set, the host waits for the
// trigger file to appear, then runs FAKE_SH_CMD through `sh -c` (like a real CLI runs a hook),
// writes its stdout to FAKE_SH_OUT and creates FAKE_SH_OUT + ".done" when the shell exits.
import { spawn } from "node:child_process";
import { existsSync, openSync, rmSync, writeFileSync } from "node:fs";

const child = spawn(process.execPath, [process.argv[2]], { stdio: "inherit" });
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(child.pid));
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", () => process.exit(1));

const { FAKE_TRIGGER, FAKE_SH_CMD, FAKE_SH_OUT } = process.env;
if (FAKE_TRIGGER && FAKE_SH_CMD && FAKE_SH_OUT) {
  const poll = setInterval(() => {
    if (!existsSync(FAKE_TRIGGER)) return;
    clearInterval(poll);
    rmSync(FAKE_TRIGGER, { force: true });
    const out = openSync(FAKE_SH_OUT, "w");
    const sh = spawn("sh", ["-c", FAKE_SH_CMD], { stdio: ["ignore", out, "ignore"] });
    sh.on("exit", () => writeFileSync(`${FAKE_SH_OUT}.done`, ""));
  }, 25);
}

setInterval(() => {}, 60_000);
