#!/usr/bin/env node
import { homedir } from "node:os";
import { dataDir } from "@conveno/core";
import { DaemonAlreadyRunningError } from "./lifecycle.js";
import { startDaemon } from "./server.js";

async function main(): Promise<void> {
  const handle = await startDaemon({
    dataDir: dataDir(process.platform, process.env, homedir()),
    onIdleExit: () => {
      process.stderr.write("convenod: no sessions for a while, exiting.\n");
      process.exit(0);
    },
  });
  process.stderr.write(`convenod: listening on ${handle.socketPath}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void handle.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  if (e instanceof DaemonAlreadyRunningError) {
    process.stderr.write(`${e.message}\n`);
    process.exit(0);
  }
  process.stderr.write(`convenod failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
