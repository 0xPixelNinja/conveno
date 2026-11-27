import { readAncestry } from "@conveno/core";

/**
 * On Windows the MCP server reads its ancestor chain with one PowerShell Win32_Process query. The
 * first such query after a VM boots takes about 15 s while WMI starts its providers, then each
 * takes about 0.5 s. The e2e files run in parallel and each starts sessions, so without this they
 * would all wait on the same cold start at once. Pay it once, before any test file runs.
 */
export default async function setup(): Promise<void> {
  if (process.platform !== "win32") return;
  await readAncestry({ timeoutMs: 120_000 });
}
