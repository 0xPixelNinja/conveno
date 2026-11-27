# @0xpixelninja/conveno-brand

Brand tokens, terminal theme and icon names for the CLI and the web apps. Private workspace package.

Everything here is generated from `brand/` by `scripts/generate.mjs`; nothing is copied by hand.
`brand/tokens.json` is the source of truth.

| Export | What |
|---|---|
| `tokens` | all of `tokens.json` as a typed const |
| `@0xpixelninja/conveno-brand/tokens.css` | `--cv-*` custom properties; light on `:root`, dark through `prefers-color-scheme` and `[data-theme="dark"]` |
| `@0xpixelninja/conveno-brand/tokens.json` | `tokens.json` |
| `createTheme()` | terminal theme: `paint(role, text)`, `bold`, `glyph(name)`, `status(name)`, `mark()`, `spinner()` |
| `detectColorLevel`, `detectUnicode`, `detectMotion`, `detectBackground` | the environment checks behind `createTheme` |
| `IconName`, `ICON_NAMES`, `spriteId()`, `SPRITE_PATH` | icon names and the SVG sprite |

Terminal behaviour follows `brand/components/terminal.md`:

- Colour level: `NO_COLOR`, then `FORCE_COLOR=0..3`, then the `color` option, TTY, `COLORTERM`, `TERM`.
- ASCII glyphs when `CONVENO_ASCII=1`, on the legacy Windows console, on a non-UTF-8 locale or `TERM=linux`.
- The spinner holds still when `CONVENO_NO_MOTION`, `CI` or `TERM=dumb` is set, or stdout is not a TTY.

```ts
import { createTheme } from "@0xpixelninja/conveno-brand";

const t = createTheme();
console.log(`${t.mark()} ${t.bold("conveno")}`);
console.log(`${t.status("ok")} daemon running`);
```
