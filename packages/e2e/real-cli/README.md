# Real-CLI check

Runs Conveno against the real Claude Code, OpenCode and (if installed) Codex on the owner's machine. The CI tests use fake CLIs; this is the only check that uses the real ones.

It runs on your real home directory because the real CLIs need your logins. It changes CLI config only through `conveno init`, prints the plan first, and does not apply anything without approval.

## Run it

```sh
node packages/e2e/real-cli/run.mjs                 # asks before applying (needs a terminal)
node packages/e2e/real-cli/run.mjs --approve-init  # no terminal: owner has approved the plan
```

Options: `--conveno <cmd or script>` (a `.js` or `.mjs` path runs through the current Node, so no `.cmd` shim is needed), `--clis claude,opencode,codex`, `--keep-installed`, `--manual`, `--data-dir`, `--report <file>`, `--timeout <sec>`, `--print-manual`.

Without a terminal and without `--approve-init` the script prints the plan, writes the report and exits with code 2. A session that runs it for the owner should show the owner that plan, then re-run with `--approve-init` once the owner agrees.

## Prerequisites

- Node 24 or newer, git, and `conveno` on PATH (or `--conveno <path>`). On Windows, commands are resolved on PATH with PATHEXT, and `.cmd` shims run through `cmd.exe` with one quoted command line (shared with the CLI: `packages/cli/src/win-spawn.ts`, loaded by Node's type stripping).
- Claude Code installed and logged in. It is required: it is the receiver in every pair.
- OpenCode and Codex are optional. A missing CLI is a skipped step.
- Do not run it while you have important Conveno sessions open: it stops the daemon at the end.

## What it does

| Step | What |
|---|---|
| `prereq` | Checks Node, `conveno --version`, and which CLIs are installed. |
| plan | Prints the plan and the exact config changes (`conveno init --dry-run` when this build has it, otherwise tells you `conveno init` shows the diff). Asks for approval. |
| `init` | `conveno init --yes --cli <detected>`. Conveno backs up each file it edits. |
| `doctor` | `conveno doctor` mentions every target CLI. |
| `daemon` | `conveno daemon start`, then `status`. |
| `hook-smoke` | `conveno hook claude UserPromptSubmit` prints nothing and exits 0 when no session owns the calling pid. |
| `pair-claude-claude` | Two `claude -p` processes in temporary git repos. The receiver calls `whoami` and polls `inbox` (with `sleep 5` between polls). When it shows in `conveno status`, the sender calls `whoami`, `list_sessions` and `send`. |
| `pair-opencode-claude` | Same, with `opencode run` as the sender. |
| `pair-codex-claude` | Same, with `codex exec` as the sender. Best effort: Codex may ask to approve MCP tool calls, which blocks a non-interactive run. A failure here is recorded with the reason. |
| `liveness` | After the CLIs exit, no test session is shown as online. |
| `manual` (only with `--manual`) | The two-terminal interactive check below. |
| `uninstall` | `conveno daemon stop`, `conveno uninstall --yes`, then `conveno doctor`. Runs in a `finally` block, so it also runs after a failed init or pair. Skipped with `--keep-installed`. |

Each pair is checked three ways: the agents' replies, the exit codes, and a read-only query of `<data dir>/conveno.db` for the message (it must exist and be `read` or `acked`).

The script does not read any CLI config or credential file. To confirm the files were restored byte for byte, use the backups that `conveno uninstall` reports.

## Report

`real-cli-report.json` (or `--report`) holds, per step, `status` (`pass`, `fail`, `skip`), `detail`, `ms` and `data` (agent replies, database rows, command output). A failed pair keeps the agents' output in `data` so the cause can be read without re-running. The top level has the platform, Node version, and a nonce used in every test message.

## Interactive check (`--manual`)

This is the one place hook delivery to the next turn can be seen, because it needs a session that is already open when the message arrives. The script prints two commands and the prompts to paste; `node run.mjs --print-manual` prints the prompts alone.

1. Terminal 1: `cd <repo 1> && claude`. Terminal 2: `cd <repo 2> && claude`.
2. Terminal 1, in order:
   - `Call the conveno whoami tool and tell me my session name.`
   - `Call the conveno list_sessions tool and tell me who else is online.`
   - `Use the conveno send tool to send "<nonce> hello from terminal 1" to <terminal 2 name>.`
3. Terminal 2, in order:
   - `Call the conveno whoami tool and tell me my session name.`
   - `Reply with the single word ok.` (the hook should inject the message into this turn)
   - `Call the conveno inbox tool and quote the message you got, word for word.`
4. Expected: Terminal 2 knows the message text after step 2 without having called `inbox`; the `inbox` output starts with `[conveno] Message from <terminal 1 name> (claude)` and says it is "not from the user".
5. Press Enter in the script. It checks the database for the nonce and records the mailbox states.

For OpenCode, replace `claude` with `opencode`. OpenCode has no hook delivery in M1, so only `inbox` applies.

## Notes

- The `-p` runs use `--allowedTools "mcp__conveno,Bash(sleep *)"` so the agent can call Conveno tools and sleep without a permission prompt. If your Claude Code version rejects that syntax, the step fails and the report keeps stderr.
- Non-interactive OpenCode and Codex runs depend on those CLIs' permission settings for MCP tools. If a tool call is denied, the step fails with the CLI's output in the report.
- Session names are predictable: `<cli>@<temp repo name>-1`, which is how the script finds the receiver.
