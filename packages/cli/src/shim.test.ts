import { describe, expect, it } from "vitest";
import {
  parseCmdShimTarget,
  parsePs1ShimTarget,
  type ShimIo,
  shimPointsAt,
  windowsConvenoIsThisInstall,
} from "./shim.js";

const crlf = (lines: string[]): string => `${lines.join("\r\n")}\r\n`;

// Output of cmd-shim 8 (npm 11) for a global install: the shim sits in the prefix directory and
// the package under its node_modules.
const NPM_CMD = (target: string): string =>
  crlf([
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  ]);

const NPM_PS1 = (target: string): string =>
  [
    "#!/usr/bin/env pwsh",
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    "",
    '$exe=""',
    'if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {',
    "  # Fix case when both the Windows and Linux builds of Node",
    "  # are installed in the same directory",
    '  $exe=".exe"',
    "}",
    "$ret=0",
    'if (Test-Path "$basedir/node$exe") {',
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "$basedir/node$exe"  "$basedir/${target}" $args`,
    "  } else {",
    `    & "$basedir/node$exe"  "$basedir/${target}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "} else {",
    "  # Support pipeline input",
    "  if ($MyInvocation.ExpectingInput) {",
    `    $input | & "node$exe"  "$basedir/${target}" $args`,
    "  } else {",
    `    & "node$exe"  "$basedir/${target}" $args`,
    "  }",
    "  $ret=$LASTEXITCODE",
    "}",
    "exit $ret",
    "",
  ].join("\n");

// Output of @zkochan/cmd-shim 9 (pnpm) for a global bin directory.
const PNPM_CMD = (target: string): string =>
  crlf([
    "@SETLOCAL",
    "@IF NOT DEFINED NODE_PATH (",
    '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@conveno+cli@0.1.0\\node_modules\\@conveno\\cli\\node_modules;C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@conveno+cli@0.1.0\\node_modules"',
    ") ELSE (",
    '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@conveno+cli@0.1.0\\node_modules;%NODE_PATH%"',
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${target}" %*`,
    ")",
  ]);

const NPM_BIN = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@conveno\\cli\\dist\\bin.js";
const PNPM_BIN =
  "C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@conveno\\cli\\dist\\bin.js";
const NPM_TARGET = "node_modules\\@conveno\\cli\\dist\\bin.js";
const PNPM_TARGET = "global\\5\\node_modules\\@conveno\\cli\\dist\\bin.js";

describe("parseCmdShimTarget", () => {
  it("reads the npm cmd-shim script path", () => {
    expect(parseCmdShimTarget(NPM_CMD(NPM_TARGET))).toBe(NPM_TARGET);
  });

  it("reads the pnpm script path and ignores node.exe and NODE_PATH", () => {
    expect(parseCmdShimTarget(PNPM_CMD(PNPM_TARGET))).toBe(PNPM_TARGET);
  });

  it("keeps parent segments", () => {
    expect(parseCmdShimTarget(NPM_CMD("..\\lib\\node_modules\\@conveno\\cli\\dist\\bin.js"))).toBe(
      "..\\lib\\node_modules\\@conveno\\cli\\dist\\bin.js",
    );
  });

  it("returns an absolute target as written", () => {
    expect(parseCmdShimTarget('node "C:\\tools\\conveno\\bin.js" %*')).toBe(
      "C:\\tools\\conveno\\bin.js",
    );
  });

  it("returns undefined for a shim that starts no script", () => {
    expect(parseCmdShimTarget('@"%~dp0\\conveno.exe" %*\r\n')).toBeUndefined();
  });
});

describe("parsePs1ShimTarget", () => {
  it("reads the target of an npm shim", () => {
    expect(parsePs1ShimTarget(NPM_PS1("node_modules/@conveno/cli/dist/bin.js"))).toBe(
      "node_modules/@conveno/cli/dist/bin.js",
    );
  });

  it("returns undefined for an unrelated script", () => {
    expect(parsePs1ShimTarget('Write-Host "hello"\n')).toBeUndefined();
  });
});

/** A fake disk: path (case-insensitive) to content. */
function disk(files: Record<string, string>, links: Record<string, string> = {}): ShimIo {
  const map = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  const link = new Map(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    isFile: (p) => map.has(p.toLowerCase()),
    readFile: (p) => map.get(p.toLowerCase()),
    realpath: (p) => link.get(p.toLowerCase()) ?? (map.has(p.toLowerCase()) ? p : undefined),
  };
}

describe("shimPointsAt", () => {
  it("accepts an npm shim for this install", () => {
    const io = disk({ "C:\\Users\\me\\AppData\\Roaming\\npm\\conveno.cmd": NPM_CMD(NPM_TARGET) });
    expect(shimPointsAt("C:\\Users\\me\\AppData\\Roaming\\npm\\conveno.cmd", NPM_BIN, io)).toBe(
      true,
    );
  });

  it("accepts a pnpm shim for this install, ignoring case", () => {
    const shim = "C:\\Users\\me\\AppData\\Local\\pnpm\\conveno.cmd";
    const io = disk({ [shim]: PNPM_CMD(PNPM_TARGET) });
    expect(shimPointsAt(shim, PNPM_BIN.toUpperCase(), io)).toBe(true);
  });

  it("resolves parent segments", () => {
    const shim = "C:\\prefix\\bin\\conveno.cmd";
    const io = disk({ [shim]: NPM_CMD("..\\lib\\node_modules\\@conveno\\cli\\dist\\bin.js") });
    expect(
      shimPointsAt(shim, "C:\\prefix\\lib\\node_modules\\@conveno\\cli\\dist\\bin.js", io),
    ).toBe(true);
  });

  it("follows links when the paths differ", () => {
    const shim = "C:\\npm\\conveno.cmd";
    const target = "C:\\npm\\node_modules\\@conveno\\cli\\dist\\bin.js";
    const real = "D:\\store\\conveno\\dist\\bin.js";
    const io = disk({ [shim]: NPM_CMD(NPM_TARGET) }, { [target]: real, [real]: real });
    expect(shimPointsAt(shim, real, io)).toBe(true);
  });

  it("rejects a shim for another install", () => {
    const shim = "C:\\npm\\conveno.cmd";
    const io = disk({ [shim]: NPM_CMD(NPM_TARGET) });
    expect(shimPointsAt(shim, "D:\\checkout\\packages\\cli\\dist\\bin.js", io)).toBe(false);
  });

  it("rejects a missing or unparseable shim", () => {
    expect(shimPointsAt("C:\\npm\\conveno.cmd", NPM_BIN, disk({}))).toBe(false);
    expect(
      shimPointsAt("C:\\npm\\conveno.cmd", NPM_BIN, disk({ "C:\\npm\\conveno.cmd": "x" })),
    ).toBe(false);
  });

  it("reads a .ps1 shim", () => {
    const shim = "C:\\npm\\conveno.ps1";
    const io = disk({ [shim]: NPM_PS1("node_modules/@conveno/cli/dist/bin.js") });
    expect(shimPointsAt(shim, "C:\\npm\\node_modules\\@conveno\\cli\\dist\\bin.js", io)).toBe(true);
  });
});

describe("windowsConvenoIsThisInstall", () => {
  const dir = "C:\\Users\\me\\AppData\\Roaming\\npm";

  it("finds conveno.cmd on PATH and checks its target", () => {
    const io = disk({ [`${dir}\\conveno.cmd`]: NPM_CMD(NPM_TARGET) });
    const env = { Path: `C:\\Windows\\System32;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    expect(windowsConvenoIsThisInstall(env, NPM_BIN, io)).toBe(true);
  });

  it("uses only the first conveno on PATH", () => {
    const io = disk({
      "C:\\a\\conveno.cmd": NPM_CMD("node_modules\\other\\bin.js"),
      [`${dir}\\conveno.cmd`]: NPM_CMD(NPM_TARGET),
    });
    expect(windowsConvenoIsThisInstall({ PATH: `C:\\a;${dir}` }, NPM_BIN, io)).toBe(false);
  });

  it("falls back to conveno.ps1", () => {
    const io = disk({ [`${dir}\\conveno.ps1`]: NPM_PS1("node_modules/@conveno/cli/dist/bin.js") });
    expect(windowsConvenoIsThisInstall({ PATH: dir }, NPM_BIN, io)).toBe(true);
  });

  it("is false when conveno is not on PATH", () => {
    expect(windowsConvenoIsThisInstall({ PATH: dir }, NPM_BIN, disk({}))).toBe(false);
  });
});
