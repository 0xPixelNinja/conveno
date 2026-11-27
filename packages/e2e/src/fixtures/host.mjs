// Fake host CLI. Spawns the MCP server with the stdio it was given, so the MCP server's
// parent pid (hostPid) is this process. Stays alive until killed or its child exits.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, [process.argv[2]], { stdio: "inherit" });
if (process.env.FAKE_PIDFILE) writeFileSync(process.env.FAKE_PIDFILE, String(child.pid));
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", () => process.exit(1));
setInterval(() => {}, 60_000);
