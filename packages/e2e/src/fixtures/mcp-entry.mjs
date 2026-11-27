// Test-only MCP entry: what `conveno mcp <cli>` does, without needing the cli package.
import { runStdio } from "@conveno/mcp";

await runStdio({ cli: process.env.FAKE_CLI ?? "claude" });
