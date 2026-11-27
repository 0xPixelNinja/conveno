# Conveno brand

The locked brand for Conveno: the mark, colour and type tokens, icons, motion, UI and terminal
components, and the asset pack (lockups, favicons, README banners, social preview).

## What is here

| Path | Contents |
|---|---|
| `tokens.json` | The source of truth: colour (light and dark), type, space, radius, stroke, motion, terminal and status values |
| `mark.svg` | The mark: a lowercase c (a spine and two arms) with an accent point in its opening |
| `SPEC.md` | The deliverables spec the brand was built against |
| `assets/` | Marks at 16, 24, 32 and 64 px, lockups, wordmarks, favicon, app icons, README hero and banners, social preview |
| `icons/` | 73 icons: 24 px set, hand-tuned 16 px variants, `svg-ink/` (colours baked in, for `<img>` in READMEs and docs), `sprite.svg`, `icons.json` |
| `motion/` | Standalone animated SVGs, `motion.css`, `motion.js`, terminal spinner |
| `components/` | `components.css`, terminal theme and design notes (`terminal.md`, `terminal-theme.json`) |

## Source of truth

`tokens.json` is authoritative. Anything that needs a colour, size, radius, easing or glyph reads it,
either directly or through [`packages/brand`](../packages/brand), which generates TypeScript, CSS
custom properties (`--cv-*`) and the terminal theme from it. Do not copy values by hand. If a value
is missing, add it to `tokens.json` first.

## Usage rules

- **Accent discipline.** Entry blue is reserved for the mark's point (wherever the mark or its
  motif appears, including the spinner point), the orchestrator, the live delivery tier, links and
  the focus ring. Everything else is ink, quiet or a semantic colour (ok, warn, error, info, stamp).
  Primary buttons, toggles and checkboxes are ink.
- **Mark clear space.** At least 1 unit (8/64 of the mark's height) on every side, 2 units where
  there is room. Minimum size: 16 px for the mark, 96 px wide for a lockup. Below 32 px use the
  hand-tuned files in `assets/` (`mark-16-*`, `mark-24-*`), not a scaled master.
- **Type.** Schibsted Grotesk for headings, IBM Plex Sans for UI text, IBM Plex Mono for
  timestamps, names, ids and commands.
- **Voice.** Plain and specific. No emoji.
- **Don't** recolour the mark, rotate or stretch it, add outlines, shadows or gradients, put the
  point in a colour other than entry blue (or one flat colour in the mono versions), round the
  corners, set the wordmark in another typeface, or use another CLI vendor's logo or colours with it.
- **Motion.** Motion shows a change in the record: something written, moved, sealed or answered.
  No bounce, no overshoot. Always provide a static end state for `prefers-reduced-motion`.
- **Themes.** Light on `:root`; dark through `prefers-color-scheme` and `[data-theme="dark"]`.

## Regenerating

The files here are generated. The generators, checks and showcase pages are kept outside this
repository. To change an asset, change `tokens.json` or open an issue.

## Licence

The brand assets are covered by [`LICENSE.md`](./LICENSE.md), separate from the Apache-2.0 code
licence. In short: copyright 0xPixelNinja, free to use to refer to Conveno, not for other products.
The fonts are SIL OFL 1.1.
