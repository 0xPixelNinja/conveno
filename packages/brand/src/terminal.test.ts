import { describe, expect, it } from "vitest";
import { terminalTheme } from "./generated/terminal-theme.js";
import { tokens } from "./generated/tokens.js";
import {
  createTheme,
  detectBackground,
  detectColorLevel,
  detectMotion,
  detectUnicode,
  type Env,
  type TerminalContext,
} from "./terminal.js";

const ctx = (env: Env = {}, over: Partial<TerminalContext> = {}): TerminalContext => ({
  env,
  isTTY: true,
  platform: "linux",
  ...over,
});

describe("detectColorLevel", () => {
  it("is 0 when stdout is not a TTY", () => {
    expect(detectColorLevel(ctx({ TERM: "xterm-256color" }, { isTTY: false }))).toBe(0);
  });
  it("NO_COLOR beats everything, including FORCE_COLOR and the always flag", () => {
    const env = { NO_COLOR: "1", FORCE_COLOR: "3", COLORTERM: "truecolor" };
    expect(detectColorLevel(ctx(env), "always")).toBe(0);
  });
  it("ignores an empty NO_COLOR", () => {
    expect(detectColorLevel(ctx({ NO_COLOR: "", TERM: "xterm" }))).toBe(1);
  });
  it("FORCE_COLOR=0..3 sets the level, even without a TTY", () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(detectColorLevel(ctx({ FORCE_COLOR: String(level) }, { isTTY: false }))).toBe(level);
    }
  });
  it("FORCE_COLOR empty or true means at least 16 colours", () => {
    expect(detectColorLevel(ctx({ FORCE_COLOR: "" }, { isTTY: false }))).toBe(1);
    expect(
      detectColorLevel(ctx({ FORCE_COLOR: "true", COLORTERM: "truecolor" }, { isTTY: false })),
    ).toBe(3);
  });
  it("COLORTERM selects truecolor", () => {
    expect(detectColorLevel(ctx({ COLORTERM: "truecolor", TERM: "xterm" }))).toBe(3);
    expect(detectColorLevel(ctx({ COLORTERM: "24bit", TERM: "xterm" }))).toBe(3);
  });
  it("TERM selects 256, 16 or none", () => {
    expect(detectColorLevel(ctx({ TERM: "xterm-256color" }))).toBe(2);
    expect(detectColorLevel(ctx({ TERM: "xterm" }))).toBe(1);
    expect(detectColorLevel(ctx({ TERM: "dumb" }))).toBe(0);
    expect(detectColorLevel(ctx({}))).toBe(0);
  });
  it("honours the --color flag", () => {
    expect(detectColorLevel(ctx({ TERM: "xterm-256color" }), "never")).toBe(0);
    expect(detectColorLevel(ctx({ TERM: "xterm" }, { isTTY: false }), "always")).toBe(1);
  });
  it("detects Windows Terminal as truecolor", () => {
    expect(detectColorLevel(ctx({ WT_SESSION: "x" }, { platform: "win32" }))).toBe(3);
    expect(detectColorLevel(ctx({}, { platform: "win32" }))).toBe(1);
  });
});

describe("detectBackground", () => {
  it("reads COLORFGBG and defaults to dark", () => {
    expect(detectBackground({ COLORFGBG: "0;15" })).toBe("light");
    expect(detectBackground({ COLORFGBG: "15;0" })).toBe("dark");
    expect(detectBackground({})).toBe("dark");
  });
});

describe("paint", () => {
  const roles = Object.keys(terminalTheme.roles) as (keyof typeof terminalTheme.roles)[];
  it("emits truecolor from the theme for every role, dark and light", () => {
    for (const background of ["dark", "light"] as const) {
      const t = createTheme({
        env: { COLORTERM: "truecolor" },
        isTTY: true,
        platform: "linux",
        background,
      });
      for (const role of roles) {
        if (role === "ink") continue;
        const n = Number.parseInt(terminalTheme.roles[role].truecolor[background].slice(1), 16);
        const rgb = `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
        expect(t.paint(role, "x")).toBe(`\u001b[38;2;${rgb}mx\u001b[0m`);
      }
    }
  });

  it("leaves ink as the terminal's own foreground and only bolds it", () => {
    const t = createTheme({ env: { COLORTERM: "truecolor" }, isTTY: true, platform: "linux" });
    expect(t.paint("ink", "x")).toBe("x");
    expect(t.paint("ink", "x", { bold: true })).toBe("\u001b[1mx\u001b[0m");
    expect(t.mark()).toMatch(/^c\u001b\[/);
    expect(t.status("busy")).toBe("●");
  });
  it("emits the 256 index and the 16-colour code", () => {
    const t256 = createTheme({ env: { TERM: "xterm-256color" }, isTTY: true, platform: "linux" });
    expect(t256.paint("entry", "x")).toBe("\u001b[38;5;111mx\u001b[0m");
    const t16 = createTheme({
      env: { TERM: "xterm" },
      isTTY: true,
      platform: "linux",
      background: "light",
    });
    expect(t16.paint("error", "x")).toBe("\u001b[31mx\u001b[0m");
  });
  it("adds bold, and leaves text alone with no colour", () => {
    const on = createTheme({ env: { TERM: "xterm" }, isTTY: true, platform: "linux" });
    expect(on.paint("ok", "x", { bold: true })).toBe("\u001b[1;32mx\u001b[0m");
    expect(on.bold("x")).toBe("\u001b[1mx\u001b[0m");
    const off = createTheme({
      env: { NO_COLOR: "1", TERM: "xterm" },
      isTTY: true,
      platform: "linux",
    });
    expect(off.paint("ok", "x", { bold: true })).toBe("x");
    expect(off.bold("x")).toBe("x");
  });
});

describe("glyphs", () => {
  const unicodeEnv = { LANG: "en_US.UTF-8" };
  it("uses the unicode column on a UTF-8 terminal", () => {
    const t = createTheme({ env: unicodeEnv, isTTY: false, platform: "linux" });
    expect(t.unicode).toBe(true);
    expect(t.glyph("ok")).toBe("✓");
    expect(t.glyph("orchestrator")).toBe("●");
    expect(t.glyph("arrow")).toBe("→");
    expect(t.mark()).toBe("c●");
  });
  it("falls back to ASCII from tokens.terminal.asciiFallback", () => {
    const t = createTheme({ env: { CONVENO_ASCII: "1" }, isTTY: false, platform: "linux" });
    expect(t.unicode).toBe(false);
    for (const [name, u] of Object.entries(tokens.terminal.glyphs)) {
      const expected = (tokens.terminal.asciiFallback as Record<string, string>)[u] ?? u;
      expect(t.glyph(name as keyof typeof tokens.terminal.glyphs)).toBe(expected);
    }
    expect(t.mark()).toBe("c*");
  });
  it("falls back on the legacy Windows console, not on Windows Terminal", () => {
    expect(detectUnicode(ctx({}, { platform: "win32" }))).toBe(false);
    expect(detectUnicode(ctx({ WT_SESSION: "x" }, { platform: "win32" }))).toBe(true);
    expect(detectUnicode(ctx({ TERM_PROGRAM: "vscode" }, { platform: "win32" }))).toBe(true);
  });
  it("falls back on a non-UTF-8 locale and on the Linux console", () => {
    expect(detectUnicode(ctx({ LANG: "C" }))).toBe(false);
    expect(detectUnicode(ctx({ LC_ALL: "en_US.ISO-8859-1", LANG: "en_US.UTF-8" }))).toBe(false);
    expect(detectUnicode(ctx({ TERM: "linux", LANG: "en_US.UTF-8" }))).toBe(false);
    expect(detectUnicode(ctx({}))).toBe(true);
  });
  it("colours status glyphs by role", () => {
    const t = createTheme({
      env: { ...unicodeEnv, TERM: "xterm" },
      isTTY: true,
      platform: "linux",
    });
    expect(t.status("ok")).toBe("\u001b[32m✓\u001b[0m");
    expect(t.status("orchestrator")).toBe("\u001b[34m●\u001b[0m");
    expect(t.status("waiting")).toBe("\u001b[33m◉\u001b[0m");
  });
  it("gives every glyph a colour, so status() works with colour on for any glyph name", () => {
    for (const color of ["always", "never"] as const) {
      for (const level of ["xterm", "xterm-256color", "dumb"]) {
        const t = createTheme({
          env: { ...unicodeEnv, TERM: level, COLORTERM: level === "xterm" ? "truecolor" : "" },
          isTTY: true,
          platform: "linux",
          color,
        });
        for (const name of Object.keys(tokens.terminal.glyphs)) {
          expect(() => t.status(name as keyof typeof tokens.terminal.glyphs), name).not.toThrow();
        }
      }
    }
  });
  it("paints the prompt chevron quiet, as the terminal spec says", () => {
    const t = createTheme({
      env: { ...unicodeEnv, TERM: "xterm" },
      isTTY: true,
      platform: "linux",
    });
    expect(t.status("prompt")).toBe(t.paint("quiet", "›"));
  });
});

describe("spinner gating", () => {
  it("animates on an interactive terminal", () => {
    expect(detectMotion(ctx({ TERM: "xterm" }))).toBe(true);
  });
  it.each([
    ["CONVENO_NO_MOTION=1", { CONVENO_NO_MOTION: "1" }, {}],
    ["CI", { CI: "true" }, {}],
    ["TERM=dumb", { TERM: "dumb" }, {}],
    ["no TTY", {}, { isTTY: false }],
  ])("is static with %s", (_n, env, over) => {
    expect(detectMotion(ctx(env, over))).toBe(false);
  });
  it("treats CI=0 and CI=false as unset", () => {
    expect(detectMotion(ctx({ CI: "0" }))).toBe(true);
    expect(detectMotion(ctx({ CI: "false" }))).toBe(true);
  });
  it("returns the frames from tokens, plain when there is no colour", () => {
    const t = createTheme({
      env: { NO_COLOR: "1", LANG: "en_US.UTF-8" },
      isTTY: true,
      platform: "linux",
    });
    const sp = t.spinner();
    expect(sp.frames).toEqual(tokens.terminal.spinner.frames);
    expect(sp.intervalMs).toBe(120);
    expect(sp.showAfterMs).toBe(400);
    expect(sp.staticLine).toBe("c─── ●");
  });
  it("uses the ASCII frames in ASCII mode", () => {
    const t = createTheme({
      env: { NO_COLOR: "1", CONVENO_ASCII: "1" },
      isTTY: true,
      platform: "linux",
    });
    const sp = t.spinner();
    expect(sp.frames).toEqual(tokens.terminal.spinner.asciiFrames);
    expect(sp.staticLine).toBe("c--- *");
  });
  it("paints the line quiet and only the point entry", () => {
    const t = createTheme({
      env: { TERM: "xterm", LANG: "en_US.UTF-8" },
      isTTY: true,
      platform: "linux",
    });
    expect(t.spinner().staticLine).toBe("\u001b[90mc───\u001b[0m \u001b[34m●\u001b[0m");
    expect(t.spinner().animated).toBe(true);
  });
  it("is not animated under CI", () => {
    const t = createTheme({ env: { CI: "1", TERM: "xterm" }, isTTY: true, platform: "linux" });
    expect(t.spinner().animated).toBe(false);
  });
});
