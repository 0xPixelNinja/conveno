# Conveno terminal design

How the `conveno` CLI looks and reads. Colours come from `../tokens.json` (`ansi`, `color`). The machine-readable form is `terminal-theme.json`. Mockups are in `showcase.html`; the examples at the end of this file are generated from the same source.

The CLI should read like minutes: who, what, when, decided. Plain words, aligned columns, no emoji, no decoration.

## 1. Roles

The code asks for a role, never a colour. Every role has a truecolor value for dark and light terminals, an xterm-256 index, and a 16-colour SGR code.

| Role | Meaning | Truecolor dark | Truecolor light | 256 dark / light | 16-colour |
|---|---|---|---|---|---|
| `entry` | The accent. Orchestrator dot, live tier, links, the spinner's point | `#8CA6FF` | `#2346D9` | 111 / 26 | `34` blue |
| `stamp` | Needs the owner: open tickets, waiting on a question | `#FFB547` | `#9A5700` | 215 / 130 | `33` yellow |
| `ok` | Healthy, done, answered | `#7BD88F` | `#1E7B3A` | 114 / 28 | `32` green |
| `warn` | Works, but will bite later. Always followed by a fix | `#FFB547` | `#8A5200` | 215 / 94 | `33` yellow |
| `error` | Failed. Always says what happened and how to fix it | `#F2777A` | `#B3202A` | 210 / 124 | `31` red |
| `info` | Neutral facts worth a second look: versions, counts | `#6FD3E8` | `#0A6C82` | 117 / 30 | `36` cyan |
| `quiet` | Timestamps, column heads, hints, separators, idle and offline | `#7F8EA1` | `#5C6A7B` | 245 / 242 | `90` bright black |
| `ink` | Primary text, busy dot | `#D5DEE8` | `#111B28` | 253 / 234 | `39` default fg |

Rules:

- `ink` is the terminal's default foreground. Never set it, except with bold.
- Bold (SGR 1) is for session names, ticket ids and the one key phrase of a line. It is never the only signal.
- Dim (SGR 2) is not used. `quiet` is a real colour, because dim renders inconsistently.
- Underline (SGR 4) is for URLs only.
- `stamp` and `warn` share a hue on purpose. Context separates them: `stamp` is for tickets and waiting, `warn` is always paired with `!` and a fix line.
- `entry` is for the orchestrator, the live tier, links, and the spinner's point (the mark's point) only; it is never used for decoration, headings, commands or the prompt. Commands are bold ink; the prompt `›` is `quiet`. Section titles are plain bold or quiet.
- Colour is never the only carrier of meaning. Every colour sits beside a glyph or a word (`!`, `x`, `waiting`, `orchestrator`).
- The version is shown in `info` (`conveno 0.1.1-rc.1` in `--help`). `conveno --version` alone prints the bare version, no colour.
- Reset (SGR 0) at the end of every coloured span and every line, so a crash never leaves the terminal tinted.
- Background colours are never set.

### Background detection

Choose the `dark` or `light` column by, in order: `CONVENO_THEME=dark|light`; `COLORFGBG` (background 7 or 15 means light); an OSC 11 query with a 100 ms timeout when stdout is a TTY. Default is dark. 256 and 16-colour modes use the same choice.

## 2. Colour depth, NO_COLOR, FORCE_COLOR, COLORTERM

Resolve once at startup, first match wins:

1. `NO_COLOR` set and non-empty: no colour and no bold. Glyphs stay.
2. `FORCE_COLOR`: `0` or `false` is off. `1` is 16-colour, `2` is 256, `3` is truecolor. Empty or `true` is at least 16-colour, then raised by step 5 or 6. It overrides the TTY check, but never `NO_COLOR`.
3. `--no-color` / `--color` flags override steps 2 to 4 for that run.
4. stdout is not a TTY: no colour (so pipes and logs are clean). Applies to stderr separately: errors are coloured only if stderr is a TTY.
5. `COLORTERM` is `truecolor` or `24bit`: truecolor.
6. `TERM` is `dumb` or unset: no colour. `TERM` ends in `256color`: 256. Anything else: 16.
7. Windows: Windows Terminal (`WT_SESSION`) and recent conhost with VT enabled get truecolor. Older conhost gets 16.

With no colour, output is still complete and aligned: the glyphs and words carry the meaning, which is why every state has both.

Machine output (`--json`) never contains escape codes.

## 3. Glyphs, status shapes and the spinner

Glyphs come from `tokens.terminal.glyphs`; their colours from `tokens.terminal.glyphColors`. Nothing outside this table is used as a symbol.

| Meaning | Unicode | ASCII | Colour role |
|---|---|---|---|
| ok, done, healthy | `✓` | `+` | `ok` |
| warning | `!` | `!` | `warn` |
| error | `x` | `x` | `error` |
| info | `i` | `i` | `info` |
| prompt, quoted reply | `›` | `>` | `quiet` |
| bullet, separator | `·` | `.` | `quiet` |
| orchestrator | `●` | `*` | `entry` |
| busy | `●` | `*` | `ink` |
| waiting | `◉` | `@` | `stamp` |
| idle | `○` | `o` | `quiet` |
| offline | `-` | `-` | `quiet` |
| arrow, routed to | `→` | `->` | `quiet` |
| rule | `─` | `-` | `quiet` |

Status shapes are exactly `tokens.status.shapes` (the orchestrator is a small c with a blue point in the UI, and `●` in entry followed by the word `orchestrator` in the terminal), the same five shapes the `status-*` icons and the UI chips use: busy is a filled dot (ink), idle a ring (quiet), waiting a dot inside a ring (stamp, `◉`), offline a short dash (quiet), error a two-stroke cross (error, `x`). The orchestrator is a filled blue dot and is the only blue status.

There are no emoji, no box-drawing frames, and no vertical margin glyph. Quoted blocks are set off with a `─` rule line and a two-space indent. Redacted spans are written `[redacted]` (inverse video where colour is on). Truncation is plain `...`.

Use Unicode when the locale is UTF-8 (`LC_ALL`, `LC_CTYPE`, `LANG` contains `UTF-8`) and `TERM` is not `linux`, or on Windows Terminal. Otherwise use ASCII. `CONVENO_ASCII=1` forces ASCII; `CONVENO_ASCII=0` forces Unicode.

### Spinner: entry-write

The spinner draws the mark being written: the `c`, an entry running out from it, then the point lands. Frames (`tokens.terminal.spinner`), 120 ms per frame, looping:

```text
c
c─
c──
c───
c─── ●
c─── ●
```

ASCII frames: `c`, `c-`, `c--`, `c---`, `c--- *`, `c--- *`. Colour: the `c` and the entry line are `quiet`, the point `●` is `entry` (it is the mark's point, a sanctioned use). Drawn in place with `\r`.

- Show it only after 400 ms of waiting (`showAfterMs`). Faster work prints no spinner.
- It always ends by replacing the line with a final `✓`, `!` or `x` result line.
- Static line, no animation: when `CONVENO_NO_MOTION=1`, when `CI` is set, when stdout is not a TTY, or when `NO_COLOR` is set with `TERM=dumb`. Print the line once as `c─── ●  Waiting for the other device`.

## 4. Layout

- Two-space indent for anything under a heading line. Second level is four spaces.
- Width is `min(columns, 100)`. Below 60 columns, drop optional columns in this order: `LAST ENTRY`, `CLI`, `STATE`. Never wrap a table row; truncate instead.
- Columns are separated by at least two spaces. Pad every cell to the widest value in its column. Left-align text, right-align counts and sizes.
- Column heads are uppercase, `quiet`, indented to match their column. Only tables get heads.
- Truncate in the middle with `...` for paths (`~/code/.../migrate/20261127.rb`) and at the end for names. Never truncate ids, versions, or timestamps.
- Session names are `cli@project-n`, always whole. The name column is as wide as the longest name.
- Timestamps are local time, 24-hour `HH:MM:SS`, `quiet`. Dates appear only when the day is not today (`2026-11-20`). Durations: `3h 12m`, `00:02:14` for running clocks, `09:42 left` for countdowns.
- Paths shorten the home directory to `~`. Show the exact path whenever a file will be changed.
- Blank line between blocks. No blank line at the start. One trailing blank line is not printed.
- Tables group by device when more than one device is paired: device name in bold, `(this device)` quiet, then its rows.
- The orchestrator row gets a blue `●` and the word `orchestrator` at the end of the row. Other rows use the status glyph for their state (section 3): ink `●` busy, quiet `○` idle, yellow `◉` waiting, quiet `-` offline, red `x` error.
- Counts come last: `7 ok, 1 warning, 0 problems`. Singular and plural are correct (`1 warning`).
- Standard output holds results; warnings, errors and prompts go to stderr, so `conveno status | cat` stays clean.

## 5. Message formats

### Success

```text
✓ <What was done, past tense>. <Optional second sentence: what to do next.>
  <quiet detail line>
```

One `✓` line per completed step. The final line is `✓ Done.` in bold, then the duration (`Done. 2.4s`), then detail lines with the next steps. Next steps are commands in bold ink, each on its own line.

### Warning

```text
! <What is wrong, with the object named>.
  why  <One line: the cause>
  fix  <Imperative sentence with the exact command in bold ink>
```

`why` is optional. `fix` is required. A warning never stops the command and the exit code stays 0, unless `--strict` is set (then 2).

### Error

```text
x <What happened, in one line, object named>
  <One or two lines of detail: what Conveno saw and what still works>
  fix  <Imperative sentence with the exact command>
  <Optional: Did you mean ...?>

exit 1 · ref <e_code>
```

Rules: first line says what happened, not what went wrong in the abstract. Second part says the consequence. `fix` gives something to do. The `ref` is for support and matches the log. No stack traces unless `--debug`. No "Oops", no "Something went wrong", no exclamation marks, no blame.

Exit codes: `0` ok, `1` the command failed, `2` usage error or `--strict` warning, `3` needs sign-in, `4` relay unreachable.

### Prompts

```text
› <Question in sentence case>? [Y/n] 
```

- `›` is `quiet`. The question is ink. The choices are `quiet`.
- Capital letter is the default. `Enter` takes it. Destructive actions default to `N`.
- Numbered choices print as `1  Option` in a margin; the prompt shows the range `[1-3, or type a reply]`.
- Free text shows a quiet default in brackets: `› Device name [macbook-air]`.
- The answer typed by the user stays on the prompt line. After answering, print one `✓` result line.
- Without a TTY and without `--yes`, never hang: fail with exit 2, `x Needs a terminal to confirm`, `fix  Run again with --yes`.
- `init` always shows the exact file changes before asking. Never ask for consent to something not yet shown.

## 6. Copy voice

- Write like a secretary taking minutes: who, what, when, decided.
- Name the object every time: `codex@api-2`, `~/.claude.json`, `T-0042`. Not "the session", not "the file".
- Past tense for what Conveno did (`Wrote`, `Paired`, `Answered`). Present for state (`running`, `waiting`). Imperative for fixes (`Run`, `Restart`).
- Sentence case. No title case, no all caps except column heads.
- Commands to run are always written out in full, in bold ink, with no surrounding quotes.
- Numbers have units: `10s`, `212 bytes`, `2 days`.
- Do not say: please, simply, just, easy, magic, seamless, oops, awesome, successfully. No emoji. No exclamation marks.
- Say "end-to-end encrypted" or "the relay sees only ciphertext". Do not say "secure" without saying how.
- Say `orchestrator`, `ticket`, `handoff`, `peek`, `delivery tier`, `device`, `pairing`. Do not invent synonyms.

## 7. Delivery tiers in text

| Tier | Written as | Role |
|---|---|---|
| live | `live` | `entry` |
| next turn | `next turn` | ink |
| ACP | `ACP` | ink |
| inbox | `inbox` | `quiet` |

## 8. Examples

All examples are shown with colour off. Colour and bold follow sections 1 and 3: `✓` is green, `x` red, `!` yellow, `i` cyan, commands bold ink, the prompt `›` quiet, timestamps and heads quiet, the orchestrator dot and `live` blue, the ticket yellow.

### `conveno init`

Detect, show exact changes, confirm, apply.

```text
$ conveno init

Looking for AI coding CLIs on this machine (macbook-air)
  ✓ claude    Claude Code  2.1.4    ~/.claude.json
  ✓ codex     Codex CLI    0.46.0   ~/.codex/config.toml
  ✓ agy       Antigravity  1.3.0    ~/.config/agy/mcp.json
  ✓ opencode  OpenCode     0.9.2    ~/.config/opencode/config.json
  - cursor    not found
  - copilot   not found

Conveno will change 4 files. Nothing else is touched.

  ~/.claude.json
    + mcpServers.conveno  command: conveno mcp --client claude
    + hooks.Stop          command: conveno hook stop
  ~/.codex/config.toml
    + [mcp_servers.conveno]
  ~/.config/agy/mcp.json
    + servers.conveno
  ~/.config/opencode/config.json
    + mcp.conveno

  Backups go to ~/.conveno/backups/2026-11-27T14-02-07/
  Undo any time with: conveno uninstall

› Apply these changes? [Y/n] y

  ✓ claude    configured, hook installed
  ✓ codex     configured
  ✓ agy       configured
  ✓ opencode  configured

✓ Done. 2.4s
  Restart open sessions so they pick up Conveno.
  Next: conveno pair adds another device.
        conveno status lists your sessions.
```

Without a terminal and without `--yes`, `init` prints the same changes, then fails with exit 2:

```text
x Needs a terminal to confirm
  No changes were made.
  fix  Run conveno init --yes to apply the changes shown above.

exit 2 · ref e_no_tty
```

### `conveno uninstall`

Files that still match what `init` wrote are restored byte for byte. A file that changed since (for example `~/.claude.json`, which Claude Code rewrites) is not restored: only Conveno's entries are removed, and the result names it. Times are local.

```text
$ conveno uninstall
Conveno will undo 1 install, made 2026-11-27 14:02:07 (local time).

  ~/.claude.json                   edited since init, so only Conveno's entries are removed
  ~/.claude/settings.json          restored byte for byte
  ~/.codex/config.toml             removed, it did not exist before

› Undo these changes? [y/N] y

✓ Done. 0.3s
  Restored 2 files to how init found them.
  Edited, not restored, because they changed since init: ~/.claude.json. Only Conveno's entries were removed.
  Restart open sessions to drop Conveno.
```

The default is `N`. Without a terminal and without `--yes` it fails with exit 2, the same as `init`.

### `conveno status`

In M1 there is no relay, so the first line says `relay: off (local only)`. The first line has no leading `✓`. Sessions are grouped by repo; the grouping by device below applies once devices are paired.

```text
$ conveno status
daemon up 3h 12m · relay connected · end-to-end encrypted

  macbook-air (this device)
    SESSION           CLI  TIER       STATE    LAST ENTRY
  ● claude@api-1      cl   live       busy     14:02:11  orchestrator
  ○ codex@api-2       cx   next turn  idle     14:02:09
  ○ opencode@docs-1   oc   inbox      idle     13:47:20
  ● claude@api-4      cl   live       busy     14:02:02

  studio-linux (paired 2026-11-20)
    SESSION           CLI  TIER       STATE    LAST ENTRY
  ◉ agy@web-1         ag   ACP        waiting  14:01:58
  - cursor@web-2      cu   inbox      offline  12:20:44

1 ticket open
  T-0042 codex@api-2 asks claude@api-1  waiting 00:02:14
  › Rename the migration or keep it?

6 sessions on 2 devices · conveno peek <session> to read one
```

Two devices. `claude@api-1` holds the orchestrator point (blue `●`), `claude@api-4` is busy (ink `●`), idle sessions are `○`, `agy@web-1` is waiting on a question (`◉`), `cursor@web-2` is offline (`-`). The open ticket is the only yellow line block.

### `conveno doctor`

```text
$ conveno doctor
  ✓ daemon    running, pid 41873, 127.0.0.1:7420
  ✓ relay     relay.conveno.dev, ciphertext only
  ✓ keys      device key in Keychain, verified 2026-11-20
  ✓ pairing   2 devices, none expiring

    DELIVERY   CLI          VERSION  TIER       NOTE
  ✓ claude     Claude Code  2.1.4    live       channel and hook active
  ✓ codex      Codex CLI    0.46.0   next turn  delivered at next prompt
  ! agy        Antigravity  1.3.0    inbox      ACP not answering
  ✓ opencode   OpenCode     0.9.2    next turn  delivered at next prompt

  i update    conveno 0.8.2 is available (you have 0.8.1)

! agy@web-1 does not answer over ACP, so its entries wait in the inbox.
  why  Antigravity 1.3.0 is running without its ACP server.
  fix  Restart it with agy --acp, then run conveno doctor again.

7 ok, 1 warning, 0 problems
```

### `conveno pair`

```text
$ conveno pair
Pairing code for macbook-air. It expires in 10 minutes.

    1 maple     3 quartz    5 tundra
    2 harbor    4 ember     6 willow

On the other device run conveno pair --join and type the words.
Or run conveno pair --qr to show a QR code.

c─── ● Waiting for the other device 09:42 left

✓ Paired studio-linux (Ubuntu 24.04, conveno 0.8.1)
  Safety number 4821 0937 5512 0064
  Both screens must show the same number.
  If they differ, run conveno pair --cancel.
```

The words are numbered so they can be read aloud in order. The `c─── ●` spinner line is replaced by the `✓` line on success.

### `conveno login`

```text
$ conveno login
Sign in to link this device to your account.

  Open   https://conveno.dev/device
  Code   KQ4M-7ZTR

c─── ● Waiting for approval in the browser (Ctrl+C to cancel)

✓ Signed in as ana@northwind.dev
  account     Northwind (team, 3 devices)
  this device macbook-air · key stored in Keychain
  Next: conveno init
```

### Errors

```text
$ conveno peek codex@api-9
x No session named codex@api-9
  The relay knows 6 sessions on 2 devices. None has that name.
  fix  Run conveno status to list names, then try again.
  Did you mean codex@api-2?

exit 1 · ref e_sess_404

$ conveno status
x Cannot reach the relay
  The daemon is up, but relay.conveno.dev timed out after 10s.
  Local sessions still work. Other devices are unreachable.
  fix  Check your network or proxy, then run conveno doctor.

exit 1 · ref e_relay_timeout
```

### Peek transcript

```text
$ conveno peek codex@api-2 --recent 7
codex@api-2 · ~/code/api · next turn · last 7 of 212 entries

  14:01:32  you    Add a nullable archived_at column to projects.
  14:01:40  codex  Reading db/migrate and app/models/project.rb.
  14:01:52  codex  Wrote db/migrate/20261127_add_archived_at.rb.
  14:01:58  codex  Migrating with DATABASE_URL=[redacted]
  14:02:03  codex  Applied. Staging dashboard: [redacted]
  14:02:09  codex  Name clashes with the earlier 0117 migration.
  14:02:11  ticket T-0042 to claude@api-1: rename the migration?

  2 spans redacted on this device before sealing: 1 secret, 1 url
  conveno peek codex@api-2 --full  or  --summary
```

Redactions are made on the device before sealing. Each is a fixed `[redacted]`, so length is not revealed. The footer counts them by kind. The ticket line is yellow.

### Ticket prompt, as seen in the orchestrator

```text
─── ticket T-0042 · codex@api-2 → claude@api-1 · 14:02:11 ──────
  Rename the migration or keep it?
  20261127_add_archived_at.rb is already applied in staging.
  It clashes with 0117_add_archived.rb.

  1  Keep it and add a follow-up migration
  2  Rename it and re-run in staging
  3  Ask the owner (phone-2 will be notified)

› Answer T-0042 [1-3, or type a reply] 1

✓ Answered T-0042. Sent to codex@api-2 at next turn · 14:02:48
```

The `─` header rule is quiet and the ticket id is yellow. The numbered options are the three most likely answers, and a typed reply is always accepted.

### ASCII and no colour

The `status` screen with `CONVENO_ASCII=1 NO_COLOR=1`:

```text
$ conveno status
daemon up 3h 12m . relay connected . end-to-end encrypted

  macbook-air (this device)
    SESSION           CLI  TIER       STATE    LAST ENTRY
  * claude@api-1      cl   live       busy     14:02:11  orchestrator
  o codex@api-2       cx   next turn  idle     14:02:09
  o opencode@docs-1   oc   inbox      idle     13:47:20
  * claude@api-4      cl   live       busy     14:02:02

  studio-linux (paired 2026-11-20)
    SESSION           CLI  TIER       STATE    LAST ENTRY
  @ agy@web-1         ag   ACP        waiting  14:01:58
  - cursor@web-2      cu   inbox      offline  12:20:44

1 ticket open
  T-0042 codex@api-2 asks claude@api-1  waiting 00:02:14
  > Rename the migration or keep it?

6 sessions on 2 devices . conveno peek <session> to read one
```
