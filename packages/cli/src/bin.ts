#!/usr/bin/env node
import { main } from "./main.js";
import { createRuntimeCtx } from "./runtime.js";

const argv = process.argv.slice(2);
const isHook = argv[0] === "hook";

try {
  const code = await main(argv, createRuntimeCtx());
  // Hooks must never linger on an open socket; others exit once they have flushed.
  if (isHook) process.exit(0);
  process.exitCode = code;
} catch (e) {
  if (isHook) process.exit(0);
  process.stderr.write(`x conveno failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.stderr.write("  fix  Run conveno doctor, then try again.\n");
  process.exitCode = 1;
}
