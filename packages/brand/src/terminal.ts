import { terminalTheme } from "./generated/terminal-theme.js";
import { tokens } from "./generated/tokens.js";

/** Semantic colour roles. Code asks for a role, never a colour. */
export type Role = keyof typeof terminalTheme.roles;
/** 0 = no colour, 1 = 16 colours, 2 = xterm 256, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;
/** The terminal's own background. Decides which palette column is used. */
export type Background = "dark" | "light";
/** Glyph names from tokens.terminal.glyphs, e.g. `ok`, `orchestrator`, `prompt`. */
export type GlyphName = keyof typeof tokens.terminal.glyphs;
export type Env = Readonly<Record<string, string | undefined>>;

export interface TerminalContext {
  env: Env;
  /** Is stdout a TTY. */
  isTTY: boolean;
  platform: string;
}

export interface ThemeOptions extends Partial<TerminalContext> {
  /** `--color` / `--no-color` style flag from the caller. Beaten only by NO_COLOR. */
  color?: "auto" | "always" | "never";
  /** Force the ASCII glyph column. Same as CONVENO_ASCII=1. */
  ascii?: boolean;
  /** Override background detection. */
  background?: Background;
}

const ESC = "\u001b[";
const RESET = `${ESC}0m`;

const set = (v: string | undefined): v is string => v !== undefined && v !== "";
const falsy = (v: string | undefined): boolean =>
  v === undefined || v === "" || v === "0" || v.toLowerCase() === "false";

function currentContext(): TerminalContext {
  return { env: process.env, isTTY: Boolean(process.stdout.isTTY), platform: process.platform };
}

/** Precedence from brand/components/terminal-theme.json: NO_COLOR, FORCE_COLOR, flag, TTY, COLORTERM, TERM. */
export function detectColorLevel(
  ctx: TerminalContext = currentContext(),
  flag: "auto" | "always" | "never" = "auto",
): ColorLevel {
  const { env } = ctx;
  if (set(env.NO_COLOR)) return 0;

  let floor: ColorLevel = 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force.toLowerCase() === "false") return 0;
    if (force === "1") return 1;
    if (force === "2") return 2;
    if (force === "3") return 3;
    floor = 1; // empty or "true": at least 16 colours, then detect
  }
  if (flag === "never") return 0;
  if (flag === "always") floor = Math.max(floor, 1) as ColorLevel;
  if (floor === 0 && !ctx.isTTY) return 0;

  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = env.TERM ?? "";
  let detected: ColorLevel;
  if (colorterm === "truecolor" || colorterm === "24bit") detected = 3;
  else if (ctx.platform === "win32" && (set(env.WT_SESSION) || env.ConEmuANSI === "ON"))
    detected = 3;
  else if (term === "dumb") detected = 0;
  else if (term === "" && ctx.platform !== "win32") detected = 0;
  else if (/256color/.test(term)) detected = 2;
  else detected = 1;
  return Math.max(detected, floor) as ColorLevel;
}

/** COLORFGBG ("fg;bg") when the terminal sets it. Defaults to dark. */
export function detectBackground(env: Env = process.env): Background {
  const raw = env.COLORFGBG;
  if (raw) {
    const bg = Number(raw.split(";").at(-1));
    if (Number.isInteger(bg)) return bg === 7 || bg === 15 ? "light" : "dark";
  }
  return "dark";
}

/** False for CONVENO_ASCII=1, the legacy Windows console and non-UTF-8 locales. */
export function detectUnicode(ctx: TerminalContext = currentContext()): boolean {
  const { env } = ctx;
  if (!falsy(env.CONVENO_ASCII)) return false;
  if (ctx.platform === "win32") {
    const modern =
      set(env.WT_SESSION) ||
      set(env.TERM_PROGRAM) ||
      env.ConEmuANSI === "ON" ||
      env.TERM === "xterm-256color" ||
      env.TERM === "alacritty";
    return modern;
  }
  if (env.TERM === "linux") return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (set(locale)) return /utf-?8/i.test(locale);
  return true;
}

/** Spinner gate from tokens.terminal.spinner.noMotion: CONVENO_NO_MOTION, CI, non-TTY, TERM=dumb. */
export function detectMotion(ctx: TerminalContext = currentContext()): boolean {
  const { env } = ctx;
  if (!falsy(env.CONVENO_NO_MOTION)) return false;
  if (!falsy(env.CI)) return false;
  if (!ctx.isTTY) return false;
  if (env.TERM === "dumb") return false;
  return true;
}

export interface Theme {
  readonly colorLevel: ColorLevel;
  readonly background: Background;
  readonly unicode: boolean;
  readonly motion: boolean;
  /** Colour a string with a role. Optionally bold. No-op at colour level 0. */
  paint(role: Role, text: string, opts?: { bold?: boolean }): string;
  /** Bold with no colour. No-op at colour level 0 (NO_COLOR drops bold too). */
  bold(text: string): string;
  /** The glyph as plain text, unicode or ASCII. */
  glyph(name: GlyphName): string;
  /** The glyph in its role colour (tokens.terminal.glyphColors). */
  status(name: GlyphName): string;
  /** The mark in miniature: `c` in ink, point in entry. `c●`, or `c*` in ASCII. */
  mark(): string;
  spinner(): Spinner;
}

export interface Spinner {
  /** Animate only when true. Otherwise print `staticLine` once. */
  readonly animated: boolean;
  readonly intervalMs: number;
  /** Do not show the spinner for work that finishes sooner than this. */
  readonly showAfterMs: number;
  /** Painted frames, in order. Rendered at the same width. */
  readonly frames: readonly string[];
  /** `c─── ●`, painted. */
  readonly staticLine: string;
}

function sgr(role: Role, level: ColorLevel, bg: Background): string | undefined {
  const r = terminalTheme.roles[role];
  if (level === 3) {
    const hex = r.truecolor[bg].slice(1);
    const n = Number.parseInt(hex, 16);
    return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
  }
  if (level === 2) return `38;5;${r.ansi256[bg]}`;
  return String(r.ansi16.fg);
}

export function createTheme(opts: ThemeOptions = {}): Theme {
  const now = currentContext();
  const ctx: TerminalContext = {
    env: opts.env ?? now.env,
    isTTY: opts.isTTY ?? now.isTTY,
    platform: opts.platform ?? now.platform,
  };
  const colorLevel = detectColorLevel(ctx, opts.color);
  const background = opts.background ?? detectBackground(ctx.env);
  const unicode = opts.ascii ? false : detectUnicode(ctx);
  const motion = detectMotion(ctx);

  const wrap = (codes: string, text: string) => `${ESC}${codes}m${text}${RESET}`;
  const paint: Theme["paint"] = (role, text, o) => {
    if (colorLevel === 0 || text === "") return text;
    const color = sgr(role, colorLevel, background);
    return wrap(o?.bold ? `1;${color}` : (color as string), text);
  };
  const bold: Theme["bold"] = (text) => (colorLevel === 0 || text === "" ? text : wrap("1", text));
  const glyph: Theme["glyph"] = (name) => {
    const u = tokens.terminal.glyphs[name];
    if (unicode) return u;
    return (tokens.terminal.asciiFallback as Record<string, string>)[u] ?? u;
  };
  const status: Theme["status"] = (name) =>
    paint(
      tokens.terminal.glyphColors[name as keyof typeof tokens.terminal.glyphColors],
      glyph(name),
    );
  const point = unicode ? "●" : (tokens.terminal.asciiFallback["●"] ?? "*");
  const mark = () => `${paint("ink", "c")}${paint("entry", point)}`;

  const spinner = (): Spinner => {
    const sp = tokens.terminal.spinner;
    const raw: readonly string[] = unicode ? sp.frames : sp.asciiFrames;
    const dot = unicode ? "●" : "*";
    // The c and the entry line are quiet; only the final point is entry.
    const paintFrame = (f: string) => {
      const i = f.indexOf(dot);
      const line = i === -1 ? f : f.slice(0, i);
      const tail = i === -1 ? "" : paint("entry", dot);
      return (
        paint("quiet", line.trimEnd()) + " ".repeat(line.length - line.trimEnd().length) + tail
      );
    };
    const frames = raw.map(paintFrame);
    return {
      animated: motion,
      intervalMs: sp.intervalMs,
      showAfterMs: sp.showAfterMs,
      frames,
      staticLine: paintFrame(raw[raw.length - 1] as string),
    };
  };

  return { colorLevel, background, unicode, motion, paint, bold, glyph, status, mark, spinner };
}
