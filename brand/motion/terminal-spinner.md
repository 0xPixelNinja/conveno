# terminal-spinner.json

Identical to `tokens.json` `terminal.spinner`. Name: `entry-write`.

- Concept: the c is the record, the dashes are an entry being written out of it, the point lands last. Same story as the logo reveal.
- `frames` (unicode) and `asciiFrames` are 6 cells wide, so the label after them never shifts. The last two frames are identical, a short hold for the landed point.
- Interval `intervalMs` 120 (motion.duration.instant). Show the spinner only after `showAfterMs` 400.
- Colour: the c and the dashes are quiet (ANSI bright black); the point is entry blue (ANSI blue), the mark point and the one sanctioned accent. The label after the spinner is the default foreground. With NO_COLOR, print plain frames.
- Use the ASCII frames when: CONVENO_ASCII=1, TERM=dumb or linux, a legacy Windows console (no WT_SESSION), a non-UTF-8 locale, or a CJK locale where the circle renders double width.
- Rendering: hide the cursor, write the frame, `\r`, overwrite; restore the cursor on exit, error and SIGINT. Replace the spinner with a state glyph and result when work ends (done is the check mark, ASCII `+`).
- No motion: print the static last frame once (see `noMotion` in the JSON).
- Never: braille frames, emoji, rotating bars, frames of any other width.
