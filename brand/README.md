# Conveno brand

The locked brand for Conveno: the mark, colour and type tokens, icons, motion, UI and terminal
components, and the asset pack (lockups, favicons, README banners, social preview).

Open [`index.html`](./index.html) for the brand book. It links to a showcase page for each pack.

## What is here

| Path | Contents |
|---|---|
| `tokens.json` | The source of truth: colour (light and dark), type, space, radius, stroke, motion, terminal and status values |
| `mark.svg` | The mark: a lowercase c (a spine and two arms) with an accent point in its opening |
| `SPEC.md` | The deliverables spec the brand was built against |
| `assets/` | Marks at 16, 24, 32 and 64 px, lockups, wordmarks, favicon, app icons, README hero and banners, social preview |
| `icons/` | 73 icons: 24 px set, hand-tuned 16 px variants, ink-baked SVGs, `sprite.svg`, `icons.json` |
| `motion/` | Standalone animated SVGs, `motion.css`, `motion.js`, terminal spinner |
| `components/` | `components.css`, terminal theme and design notes (`terminal.md`, `terminal-theme.json`) |

Each pack has a `_src/` folder with the scripts that generate it and a `README.md` on how to run them.
`_src/` at this level holds checks that run across all packs.

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

Each pack documents its commands in its own `_src/README.md`:

```sh
node icons/_src/build.mjs                    # icons
(cd motion/_src && node fonts.mjs && node svgs.mjs && node show.mjs)
python3 components/_src/build.py             # components showcase and terminal.md
(cd assets/_src && python3 fonts.py && python3 build3.py && python3 build4.py && python3 build5.py)
python3 _src/check-colors.py                 # brand checks across packs
```

The asset and motion scripts download their fonts rather than storing them; see their READMEs for
the Python and npm dependencies.

## Licence

The brand assets are covered by [`LICENSE.md`](./LICENSE.md), separate from the Apache-2.0 code
licence. In short: copyright 0xPixelNinja, free to use to refer to Conveno, not for other products.
The fonts are SIL OFL 1.1.
