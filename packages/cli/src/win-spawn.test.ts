import { describe, expect, it } from "vitest";
import {
  cmdShimPlan,
  escapeCmdArg,
  escapeCmdCommand,
  planSpawn,
  resolveWindowsCommand,
} from "./win-spawn.js";

const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe("escapeCmdArg", () => {
  it("wraps in quotes and caret-escapes the quotes", () => {
    expect(escapeCmdArg("plain")).toBe('^"plain^"');
  });

  it("escapes every cmd metacharacter", () => {
    const out = escapeCmdArg("a^b&c|d<e>f(g)h%i!j");
    for (const ch of ["^", "&", "|", "<", ">", "(", ")", "%", "!"]) {
      expect(out).toContain(`^${ch}`);
    }
    // No metacharacter is left bare: every one is preceded by a caret.
    expect(out.replace(/\^./g, "")).toBe("abcdefghij");
  });

  it("keeps spaces inside the quoted argument", () => {
    expect(escapeCmdArg("C:\\Program Files\\x.js")).toBe('^"C:\\Program^ Files\\x.js^"');
  });

  it("escapes embedded quotes and the backslashes before them", () => {
    expect(escapeCmdArg('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeCmdArg('a\\"b')).toBe('^"a\\\\\\^"b^"');
  });

  it("doubles trailing backslashes so they cannot escape the closing quote", () => {
    expect(escapeCmdArg("C:\\dir\\")).toBe('^"C:\\dir\\\\^"');
  });

  it("escapes the program name without quoting it", () => {
    expect(escapeCmdCommand("C:\\Users\\a&b\\codex.cmd")).toBe("C:\\Users\\a^&b\\codex.cmd");
  });
});

describe("resolveWindowsCommand", () => {
  const env = { Path: "C:\\bin;C:\\npm", PATHEXT: ".com;.exe;.bat;.cmd;.js" };

  it("finds a .cmd shim on PATH, ignoring case in the variable names", () => {
    expect(resolveWindowsCommand("codex", env, files("C:\\npm\\codex.cmd"))).toBe(
      "C:\\npm\\codex.cmd",
    );
  });

  it("follows PATH order, then PATHEXT order", () => {
    const isFile = files("C:\\bin\\x.cmd", "C:\\bin\\x.exe", "C:\\npm\\x.exe");
    expect(resolveWindowsCommand("x", env, isFile)).toBe("C:\\bin\\x.exe");
    expect(resolveWindowsCommand("x", { ...env, PATHEXT: ".cmd;.exe" }, isFile)).toBe(
      "C:\\bin\\x.cmd",
    );
  });

  it("never picks a script type that Windows Script Host would open", () => {
    expect(resolveWindowsCommand("tool", env, files("C:\\bin\\tool.js"))).toBeUndefined();
  });

  it("uses the default PATHEXT when the variable is missing", () => {
    expect(resolveWindowsCommand("a", { PATH: "C:\\bin" }, files("C:\\bin\\a.exe"))).toBe(
      "C:\\bin\\a.EXE",
    );
  });

  it("tries a name that already has an extension as written", () => {
    expect(resolveWindowsCommand("opencode.cmd", env, files("C:\\npm\\opencode.cmd"))).toBe(
      "C:\\npm\\opencode.cmd",
    );
  });

  it("does not search PATH for a command with a directory", () => {
    const isFile = files("C:\\tools\\a.exe", "C:\\bin\\C:\\tools\\a.exe");
    expect(resolveWindowsCommand("C:\\tools\\a", env, isFile)).toBe("C:\\tools\\a.exe");
  });

  it("skips quoted and empty PATH entries", () => {
    expect(
      resolveWindowsCommand("a", { PATH: ';"C:\\My Tools";' }, files("C:\\My Tools\\a.exe")),
    ).toBe("C:\\My Tools\\a.EXE");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveWindowsCommand("nope", env, files())).toBeUndefined();
  });
});

describe("planSpawn", () => {
  const env = {
    PATH: "C:\\npm;C:\\bin",
    PATHEXT: ".com;.exe;.bat;.cmd",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
  };
  const isFile = files("C:\\npm\\codex.cmd", "C:\\bin\\claude.exe");

  it("spawns an .exe directly with its arguments untouched", () => {
    expect(planSpawn("claude", ["--version"], { platform: "win32", env, isFile })).toEqual({
      file: "C:\\bin\\claude.exe",
      args: ["--version"],
    });
  });

  it("runs a .cmd shim through cmd.exe with one quoted command line", () => {
    const plan = planSpawn("codex", ["--version"], { platform: "win32", env, isFile });
    expect(plan).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '"C:\\npm\\codex.cmd ^"--version^""'],
      windowsVerbatimArguments: true,
    });
  });

  it("falls back to cmd.exe when ComSpec is unset", () => {
    expect(cmdShimPlan("C:\\a.cmd", [], {}).file).toBe("cmd.exe");
  });

  it("leaves the command alone when nothing resolves, so spawn reports ENOENT", () => {
    expect(planSpawn("ghost", ["x"], { platform: "win32", env, isFile })).toEqual({
      file: "ghost",
      args: ["x"],
    });
  });

  it("does nothing off Windows", () => {
    expect(planSpawn("codex", ["--version"], { platform: "linux", env, isFile })).toEqual({
      file: "codex",
      args: ["--version"],
    });
  });
});
