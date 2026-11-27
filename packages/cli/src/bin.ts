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
} catch {
  // `main` reports its own failures. This only catches a failure before it could (for example
  // while building the context): print a plain message, never a Node stack.
  if (isHook) process.exit(0);
  process.stderr.write("x conveno could not start\n");
  process.stderr.write("  fix  Run conveno doctor, then try again.\n\n");
  process.stderr.write("exit 1 · ref e_startup\n");
  process.exitCode = 1;
}
