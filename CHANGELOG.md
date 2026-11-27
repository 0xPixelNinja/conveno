# Changelog

## 0.1.1 (unreleased)

Fixes from the first run of 0.1.0 against the real Claude Code, OpenCode and Codex on Windows. It goes out first as `0.1.1-rc.1` on the npm dist-tag `next` (`npm i -g @conveno/cli@next`), and becomes `0.1.1` on `latest` once the real-CLI check passes on it.

- Conveno is now one npm package, `@conveno/cli`. The protocol, core, client, daemon, MCP server, brand and adapter code is bundled into it, and the daemon is `dist/daemon.js` inside it. Install and upgrade as before with `npm i -g @conveno/cli`. The nine other `@conveno/*` packages published with 0.1.0 (`protocol`, `core`, `client`, `daemon`, `mcp`, `brand`, `adapter-claude`, `adapter-codex`, `adapter-opencode`) are no longer published and will be deprecated; they were never meant to be installed on their own.
- The release workflow publishes with npm trusted publishing and provenance, with no stored npm token.
- Unexpected errors in the daemon are now written to `<data dir>/logs/daemon.log` (readable by you only, rotated at 1 MiB), and the error message names that file. Before, it pointed at a log that did not exist.
- The security policy now names its contacts and supported versions, and says the daemon's auth token is created once and kept until deleted, not renewed at each boot.
- Releases now publish a prerelease version such as `0.1.1-rc.1` to `next` and only a plain version to `latest`. The release workflow derives the tag from the version and fails if it disagrees with the git tag.
- Fixed `conveno init` failing with "internal error" in a colour terminal, right after you confirm. The prompt arrow and the separator, arrow and rule glyphs had no colour in the brand tokens, so painting them threw. They are now quiet grey, as the terminal spec says. `conveno status` hit the same bug when it printed its separator. The `--yes` path and piped output never painted them, which is why only an interactive terminal failed.
- An unexpected error now shows its message instead of "internal error", and writes the full stack to `<data dir>/logs/<timestamp>-error.log` (readable by you only), and prints that path.
- `conveno status` crashed in a colour terminal when the daemon was running, for the same missing-colour reason as `init`. Fixed by the same change. A new test runs every command with colour on, at 16, 256 and true colour, with the terminal width missing or zero (Conveno does not read the width).
- Agents now use the Conveno tools when you ask about other sessions. The MCP server sends instructions in its initialize result, and the `whoami` and `list_sessions` descriptions say when to call them. Before, Codex answered "can you see my OpenCode session?" from general knowledge without calling `list_sessions`. Whether the instructions reach the model depends on the CLI.
- `conveno status` lists only online sessions. A footer says how many offline ones are hidden, and `conveno status --all` shows them. The `list_sessions` tool already left offline sessions out unless asked.
- The daemon deletes old offline sessions sooner: after 24 hours (was 7 days), or 5 minutes once a newer live session has the same name, CLI and repo. A session with unread messages still keeps them for 7 days, so mail sent to a closed session is not lost. The rules are in `packages/daemon/README.md`.
- Codex can now call Conveno's tools in `codex exec`. `conveno init` sets `default_tools_approval_mode = "approve"` on the `conveno` server in `~/.codex/config.toml`, for that server only. Before, Codex asked for approval it had no way to get and blocked every call. `conveno uninstall` removes it with the rest of the entry.
- `conveno doctor`, `status`, `daemon start`, `daemon status` and `mcp` now give a fix that matches the cause. When the socket path is too long, they say to set `XDG_RUNTIME_DIR` to a shorter directory instead of telling you to run `conveno daemon start`.
- Only `daemon start` and the MCP server start the daemon. A test now checks that `status`, `doctor`, `daemon status`, `daemon stop`, `hook`, `init` and `uninstall` do not.
- The real-CLI check cleans up after a run that was killed. It leaves a marker file before `init`, removes it after `uninstall`, and offers to run `daemon stop` and `uninstall --yes` if it finds one at the start.

## 0.1.0

First release.

- A local daemon, started on demand, that lets AI coding sessions on one machine find each other and exchange messages.
- An MCP server with eight tools: `whoami`, `list_sessions`, `send`, `inbox`, and more.
- Setup for Claude Code, Codex and OpenCode through `conveno init`, which shows each change first, backs up every file it edits and can be undone with `conveno uninstall`.
- `conveno status` and `conveno doctor` to see sessions and check the install.
- Claude Code and Codex get messages at the next prompt through hooks. OpenCode reads them through the `inbox` tool.
