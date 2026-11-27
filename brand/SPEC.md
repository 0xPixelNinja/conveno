# Conveno brand lock: deliverables spec

Direction: **Minutes**. Mark: **variant C, "lowercase c"** (`mark.svg`): a heavy spine with two arms forming a c (the record and its entries), and the accent point sitting in the opening (the orchestrator / the decision). Chosen by the owner 2026-11-27.
Everything below derives from the mark's grid and the Minutes tokens. Nothing ships until the owner approves the brand book.

## 0. Foundations (locked first)
- Final mark: `mark.svg` (variant C, lowercase c). Optical sizes in `assets/mark-16|24|32.svg`.
- Tokens (refined from the Minutes exploration, which stays in git history): colour light/dark, semantic colours (ok / warn / error / info, separate from the entry accent), type scale, spacing (4-based), radius, stroke widths, motion (easing + durations).
- Type: Schibsted Grotesk (display), IBM Plex Sans (body), IBM Plex Mono (mono, timestamps, terminal).

## 1. Custom icon set
One family drawn from the mark's language: 24×24 grid (also checked at 16 and 20), 1.5px stroke at 24, flat cut ends, square joins, the point uses currentColor by default; entry blue only on orchestrator, live and status-orchestrator icons (see tokens.color.accentDiscipline). Outline style by default, plus a solid state for "active". Each icon has an SVG file, a name, and a one-line meaning. No vendor logos anywhere.

**Concepts:** session, orchestrator (claim / held), peer, spawn, handoff, peek (recent / full / summary), message send, inbox, unread, ack, ticket (open / answered / cancelled), question to owner, decision.

**Delivery tiers:** live, next turn, ACP, inbox.

**Status:** idle, busy, waiting on question, offline, error.

**Trust:** relay, device, device pairing, end-to-end encrypted (sealed entry), key, verified, revoked.

**Product:** daemon, MCP, hook, adapter, config, doctor / health, init, uninstall, telemetry (off/on), log / record, timestamp, search, filter, settings, copy, external link, docs, GitHub, terminal, repo / folder, branch.

**CLI identity:** one neutral monogram chip per CLI (cl, cx, ag, cu, cp, oc) in mono type on the rule. Never the vendors' logos or colours.

## 2. Motion library
- Tokens: `--ease-enter`, `--ease-exit`, `--ease-record` (a writing feel), and durations 120/200/320/560ms.
- Animations, each delivered as a standalone animated SVG (SMIL or CSS, whichever survives GitHub's camo) and as CSS/JS for the web, all with reduced-motion static end states:
  1. Logo reveal: entries write in from the rule, then the point lands.
  2. Logo idle "listening" loop for loading states, subtle and stoppable.
  3. Handoff: an entry travels from session A's rule to session B's and lands in their record.
  4. Message sealed: the entry text resolves into a ciphertext block (E2E).
  5. Ticket lifecycle: open, then routed to the orchestrator, answered, then closed.
  6. Orchestrator claim: the point moves to a new session.
  7. Working indicator: the timestamp ticks and an entry line draws.
  8. Session joins / leaves the record.
  9. Success / error confirmations.
- Terminal motion: spinner frames using ASCII-safe glyphs, plus an ASCII fallback for conhost.

## 3. Components and elements
- Session chip (name, CLI monogram, status, tier), orchestrator marker, ticket pill (3 states), delivery-tier badges, message entry row (timestamp · speaker · text), handoff card, peek panel, device row, pairing code display (6 words / QR frame), sealed-entry pair (what you see vs what the relay sees).
- Pattern and texture: a ruled-margin background, a section divider, a timestamp gutter.
- Buttons, inputs, focus ring, toggles (for the account page), using tokens only.

## 4. Terminal design (CLI look)
- ANSI palettes for dark and light terminals. 16-colour fallback mapping. Honours NO_COLOR, FORCE_COLOR and COLORTERM.
- Glyph set: ✓ ● › ○ with ASCII fallbacks (`+ * > o`).
- Layout specs and mockups for: `conveno init` (detect, then review the changes, then apply), `conveno status`, `conveno doctor`, `conveno pair`, `conveno login`, error and warning formats, a peek transcript view, the ticket prompt.
- Output written in plain words, aligned columns, no emoji.

## 5. Asset pack (production files)
- Wordmark and lockups: horizontal and stacked, light and dark, text **outlined to paths** (no font dependency).
- `favicon.svg` (with dark-mode media query), `favicon.ico` (16/32/48), `apple-touch-icon.png` (180), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`.
- `app-icon-512.png` (plugin directory, MCP registry icons, light and dark).
- `readme-banner-light.svg` and `-dark.svg` (for `<picture>`), `social-preview.png` (1280×640, under 1 MB).
- Animated README hero SVG, if GitHub keeps the animation; otherwise static.

## 6. Brand book
- Published as one browsable reference (Design System artifact): the README (voice and tone), tokens, components with live previews, icon grid, motion demos, assets, and do/don't rules.
- Also committed: `brand/` in the repo plus `packages/brand` (tokens as TS/CSS/JSON, icons as an SVG sprite and TS map, terminal theme), for the CLI and the account web to import.

## 7. Voice (short)
Plain, calm, precise. Talk the way a meeting secretary writes minutes: who, what, when, decided. No hype, no "AI magic", no emoji.
