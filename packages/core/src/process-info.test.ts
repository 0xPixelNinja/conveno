import { describe, expect, it } from "vitest";
import {
  isConvenoLauncher,
  MAX_ANCESTORS,
  type ProcessIo,
  parseProcessTable,
  parseProcStat,
  pickHostPid,
  readAncestry,
  readCommandLine,
  WINDOWS_TABLE_SCRIPT,
} from "./process-info.js";

/** A process table: pid -> [ppid, command line]. */
type Table = Record<number, [number, string]>;

interface Call {
  file: string;
  args: string[];
  timeoutMs: number;
}

/** Injected OS access over a fixed table. Records every spawn. */
function fakeIo(platform: NodeJS.Platform, table: Table, over: Partial<ProcessIo> = {}) {
  const calls: Call[] = [];
  const io: ProcessIo = {
    platform,
    readFile: async (path) => {
      const m = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(path);
      const row = m ? table[Number(m[1])] : undefined;
      if (!m || !row) throw new Error("ENOENT");
      return m[2] === "stat"
        ? `${m[1]} (node (x) y) S ${row[0]} 1 1 0`
        : `${row[1].split(" ").join("\0")}\0`;
    },
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      const sep = platform === "win32" ? "\r\n" : "\n";
      return Object.entries(table)
        .map(([p, [pp, cmd]]) => `${p.padStart(6)} ${String(pp).padStart(6)} ${cmd}`)
        .join(sep);
    },
    ...over,
  };
  return { io, calls };
}

describe("parsers", () => {
  it("reads ps output with padding and PowerShell output with CRLF, keeping command lines", () => {
    expect([...parseProcessTable("    1     0 /sbin/init\n  412   300 node a.js --x\n")]).toEqual([
      [1, { ppid: 0, command: "/sbin/init" }],
      [412, { ppid: 300, command: "node a.js --x" }],
    ]);
    expect([...parseProcessTable('4 0\r\n500 400 cmd.exe /d /c "x y"\r\n\r\n')]).toEqual([
      [4, { ppid: 0 }],
      [500, { ppid: 400, command: 'cmd.exe /d /c "x y"' }],
    ]);
  });

  it("ignores headers, blank lines and noise", () => {
    expect([
      ...parseProcessTable(
        "PID PPID ARGS\n\nProcessId ParentProcessId\nGet-CimInstance : x\n7 3 sh",
      ),
    ]).toEqual([[7, { ppid: 3, command: "sh" }]]);
  });

  it("reads the parent from /proc stat even when the name has spaces and parentheses", () => {
    expect(parseProcStat("42 (my (weird) name) S 17 42 42 0")).toBe(17);
    expect(parseProcStat("garbage")).toBeUndefined();
  });
});

describe("isConvenoLauncher", () => {
  const BIN = "/opt/conveno/packages/cli/dist/bin.js";

  it.each([
    // a shell running a conveno command
    'bash -c "conveno hook claude UserPromptSubmit"',
    "/bin/sh -c conveno hook claude UserPromptSubmit; true",
    "/bin/sh -c /usr/local/bin/conveno hook codex SessionStart",
    "sh -c conveno mcp --cli claude",
    // Windows: cmd.exe running the npm shim, with the quoting the shim runner uses
    String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\Users\u\AppData\Roaming\npm\conveno.cmd" hook claude X"`,
    'cmd.exe /d /s /c "conveno.cmd mcp --cli claude"',
    String.raw`cmd /d /s /c "^"C:\npm\conveno.cmd^" ^"hook^" ^"claude^""`,
    // PowerShell running the .ps1 shim
    String.raw`powershell.exe -NoProfile -File C:\Users\u\AppData\Roaming\npm\conveno.ps1 mcp --cli codex`,
    // node running our bin script
    "node /usr/local/bin/conveno mcp --cli claude",
    String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@conveno\cli\dist\bin.js hook claude X`,
    "/usr/bin/node --no-warnings /home/u/.pnpm/@conveno+cli@0.1.0/node_modules/@conveno/cli/dist/bin.js mcp",
    `node ${BIN} hook claude X`,
    `/bin/sh -c "${BIN}" hook claude X; true`,
  ])("is a launcher: %s", (line) => {
    expect(isConvenoLauncher(line, [BIN]), line).toBe(true);
  });

  it.each([
    "claude",
    "bash",
    "-bash",
    "/bin/sh",
    "bash -c claude --resume",
    'bash -c "npm run build && conveno-docs hook"',
    "zsh -c echo conveno hooked",
    "cmd.exe /d /c echo hello",
    "powershell.exe",
    String.raw`C:\Users\u\AppData\Roaming\npm\claude.exe`,
    "node /work/app/server.js",
    "node /work/app/bin.js mcp",
    "/usr/bin/python3 -m conveno_tools hook",
    "vim conveno.md",
    "less notes-on-conveno.cmdline.txt",
    "node /x/@conveno/daemon/dist/bin.js",
  ])("is not a launcher: %s", (line) => {
    expect(isConvenoLauncher(line, [BIN]), line).toBe(false);
  });

  it("matches paths ignoring case and slash direction", () => {
    expect(
      isConvenoLauncher(String.raw`node.exe C:\Work\Conveno\packages\cli\dist\bin.js mcp`, [
        "C:/work/conveno/packages/cli/dist/bin.js",
      ]),
    ).toBe(true);
  });
});

describe("pickHostPid", () => {
  it("takes the first entry that is not a launcher, and an entry without a command line as host", () => {
    expect(
      pickHostPid([
        { pid: 4, command: "cmd.exe /d /s /c conveno.cmd mcp" },
        { pid: 3, command: "claude.exe" },
        { pid: 2, command: "powershell.exe" },
      ]),
    ).toBe(3);
    expect(pickHostPid([{ pid: 9 }, { pid: 8, command: "claude" }])).toBe(9);
    expect(pickHostPid([{ pid: 4, command: "sh -c conveno hook x" }])).toBeUndefined();
    expect(pickHostPid([])).toBeUndefined();
  });
});

// A tree on every OS: terminal 100 > shell 200 > CLI 300. The MCP server hangs under the CLI, on
// Windows behind the npm shim's cmd.exe. A hook hangs under the CLI behind a shell and the shim.
const POSIX: Table = {
  100: [1, "kitty"],
  200: [100, "-bash"],
  300: [200, "claude"],
  310: [300, "node /usr/local/bin/conveno mcp --cli claude"],
  320: [300, "/bin/sh -c conveno hook claude UserPromptSubmit; true"],
  330: [320, "node /usr/local/bin/conveno hook claude UserPromptSubmit"],
};
const WIN: Table = {
  100: [0, "WindowsTerminal.exe"],
  200: [100, "powershell.exe"],
  300: [200, String.raw`C:\npm\claude.exe`],
  400: [
    300,
    String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\npm\conveno.cmd" mcp --cli claude"`,
  ],
  500: [400, String.raw`node.exe C:\npm\node_modules\@conveno\cli\dist\bin.js mcp --cli claude`],
  405: [300, `bash -c "conveno hook claude UserPromptSubmit"`],
  410: [
    405,
    String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c ""C:\npm\conveno.cmd" hook claude UserPromptSubmit"`,
  ],
  510: [
    410,
    String.raw`node.exe C:\npm\node_modules\@conveno\cli\dist\bin.js hook claude UserPromptSubmit`,
  ],
};

describe("readAncestry on Linux", () => {
  it("walks /proc one level at a time and finds the CLI above a sh -c and a symlinked bin", async () => {
    const { io } = fakeIo("linux", POSIX);
    const hook = await readAncestry({ pid: 330, ppid: 320, io });
    expect(hook.pids).toEqual([320, 300, 200, 100]);
    expect(hook.hostPid).toBe(300);
    expect(hook.complete).toBe(true);
    expect(hook.entries[0]?.command).toBe("/bin/sh -c conveno hook claude UserPromptSubmit; true");
    const mcp = await readAncestry({ pid: 310, ppid: 300, io });
    expect(mcp.hostPid).toBe(300);
  });

  it("reads the parent of the given pid when no ppid is passed", async () => {
    const { io } = fakeIo("linux", POSIX);
    expect((await readAncestry({ pid: 330, io })).hostPid).toBe(300);
  });

  it("caps the chain at eight entries", async () => {
    const deep: Table = {};
    for (let p = 10; p <= 40; p++) deep[p] = [p - 1, "x"];
    const { io } = fakeIo("linux", deep);
    const r = await readAncestry({ pid: 40, ppid: 39, io });
    expect(r.pids).toEqual([39, 38, 37, 36, 35, 34, 33, 32]);
    expect(r.pids).toHaveLength(MAX_ANCESTORS);
  });

  it("stops at a cycle", async () => {
    const { io } = fakeIo("linux", { 20: [30, "a"], 30: [20, "b"] });
    expect((await readAncestry({ pid: 10, ppid: 20, io })).pids).toEqual([20, 30]);
  });

  it("falls back to the direct parent, flagged, when /proc is not readable", async () => {
    const { io } = fakeIo(
      "linux",
      {},
      { readFile: async () => Promise.reject(new Error("EACCES")) },
    );
    const r = await readAncestry({ pid: 330, ppid: 320, io });
    expect(r).toEqual({ entries: [{ pid: 320 }], pids: [320], hostPid: 320, complete: false });
  });
});

describe("readAncestry on macOS", () => {
  it("builds the chain and command lines from one ps call", async () => {
    const { io, calls } = fakeIo("darwin", { 1: [0, "/sbin/launchd"], ...POSIX });
    const r = await readAncestry({ pid: 330, ppid: 320, timeoutMs: 800, io });
    expect(r.pids).toEqual([320, 300, 200, 100]);
    expect(r.hostPid).toBe(300);
    expect(calls).toEqual([{ file: "ps", args: ["-A", "-o", "pid=,ppid=,args="], timeoutMs: 800 }]);
  });

  it("falls back to the direct parent when ps fails", async () => {
    const { io } = fakeIo("darwin", POSIX, { run: async () => null });
    expect(await readAncestry({ pid: 330, ppid: 320, io })).toMatchObject({
      pids: [320],
      hostPid: 320,
      complete: false,
    });
  });
});

describe("readAncestry on Windows", () => {
  it("reads the table, command lines included, with one PowerShell call", async () => {
    const { io, calls } = fakeIo("win32", WIN);
    const mcp = await readAncestry({ pid: 500, ppid: 400, timeoutMs: 30_000, io });
    expect(mcp.pids).toEqual([400, 300, 200, 100]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("powershell.exe");
    expect(calls[0]?.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_TABLE_SCRIPT,
    ]);
    for (const word of [
      "Get-CimInstance",
      "Win32_Process",
      "ProcessId,ParentProcessId,CommandLine",
    ]) {
      expect(WINDOWS_TABLE_SCRIPT).toContain(word);
    }
    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  it("gives the MCP server and the hook the same host: the CLI, through the shim and bash -c", async () => {
    const { io } = fakeIo("win32", WIN);
    const mcp = await readAncestry({ pid: 500, ppid: 400, io });
    const hook = await readAncestry({ pid: 510, ppid: 410, io });
    expect(mcp.hostPid).toBe(300);
    expect(hook.pids).toEqual([410, 405, 300, 200, 100]);
    expect(hook.hostPid).toBe(300);
  });

  it("gives an unregistered CLI in the same terminal a different host, never the shared shell", async () => {
    const other: Table = {
      ...WIN,
      301: [200, String.raw`C:\npm\codex.exe`],
      411: [301, String.raw`cmd /d /s /c ""C:\npm\conveno.cmd" hook codex X"`],
      511: [411, String.raw`node.exe C:\npm\node_modules\@conveno\cli\dist\bin.js hook codex X`],
    };
    const { io } = fakeIo("win32", other);
    const mine = await readAncestry({ pid: 510, ppid: 410, io });
    const theirs = await readAncestry({ pid: 511, ppid: 411, io });
    expect(theirs.hostPid).toBe(301);
    expect(theirs.hostPid).not.toBe(mine.hostPid);
    // The shared shell is in both raw chains, which is why the chain alone never decides a match.
    expect(theirs.pids).toContain(200);
    expect(mine.pids).toContain(200);
  });

  it("falls back to the direct parent and flags it when WMI denies the query", async () => {
    for (const out of [null, "", "Get-CimInstance : Access denied \r\n"]) {
      const { io } = fakeIo("win32", WIN, { run: async () => out });
      expect(await readAncestry({ pid: 510, ppid: 410, io })).toEqual({
        entries: [{ pid: 410 }],
        pids: [410],
        hostPid: 410,
        complete: false,
      });
    }
  });

  it("matches the old behaviour when there is no shim: the direct parent is the CLI", async () => {
    const { io } = fakeIo("win32", WIN, { run: async () => null });
    expect((await readAncestry({ pid: 888, ppid: 300, io })).hostPid).toBe(300);
  });

  it("never throws, even when the runner does", async () => {
    const { io } = fakeIo("win32", WIN, { run: async () => Promise.reject(new Error("spawn")) });
    expect(await readAncestry({ pid: 510, ppid: 410, io })).toMatchObject({
      pids: [410],
      complete: false,
    });
  });
});

describe("readAncestry with the real OS", () => {
  it.skipIf(process.platform === "win32")("starts at this process's real parent", async () => {
    const r = await readAncestry();
    expect(r.complete).toBe(true);
    expect(r.pids[0]).toBe(process.ppid);
    expect(r.pids.length).toBeLessThanOrEqual(MAX_ANCESTORS);
    expect(r.hostPid).toBeDefined();
  });
});

describe("readCommandLine", () => {
  it("reads /proc cmdline on Linux, NUL separated", async () => {
    const { io } = fakeIo(
      "linux",
      {},
      { readFile: async () => "node\0/opt/x/@conveno/daemon/dist/bin.js\0" },
    );
    expect(await readCommandLine(77, io)).toBe("node /opt/x/@conveno/daemon/dist/bin.js");
  });

  it("asks ps on macOS", async () => {
    const calls: Call[] = [];
    const io: ProcessIo = {
      platform: "darwin",
      readFile: async () => "",
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs });
        return " node /d/bin.js\n";
      },
    };
    expect(await readCommandLine(77, io, 900)).toBe("node /d/bin.js");
    expect(calls).toEqual([{ file: "ps", args: ["-o", "command=", "-p", "77"], timeoutMs: 900 }]);
  });

  it("asks PowerShell for one process on Windows", async () => {
    const calls: Call[] = [];
    const io: ProcessIo = {
      platform: "win32",
      readFile: async () => "",
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs });
        return '"C:\\node.exe" C:\\x\\@conveno\\daemon\\dist\\bin.js\r\n';
      },
    };
    expect(await readCommandLine(77, io)).toBe(
      '"C:\\node.exe" C:\\x\\@conveno\\daemon\\dist\\bin.js',
    );
    expect(calls[0]?.file).toBe("powershell.exe");
    expect(calls[0]?.args.at(-1)).toContain('-Filter "ProcessId=77"');
  });

  it("answers null when the OS does not say", async () => {
    const denied: ProcessIo = {
      platform: "win32",
      readFile: async () => "",
      run: async () => null,
    };
    expect(await readCommandLine(77, denied)).toBeNull();
    const empty: ProcessIo = {
      platform: "win32",
      readFile: async () => "",
      run: async () => "\r\n",
    };
    expect(await readCommandLine(77, empty)).toBeNull();
    const gone: ProcessIo = {
      platform: "linux",
      readFile: async () => Promise.reject(new Error("ENOENT")),
      run: async () => null,
    };
    expect(await readCommandLine(77, gone)).toBeNull();
    expect(await readCommandLine(0, gone)).toBeNull();
    expect(await readCommandLine(Number.NaN, gone)).toBeNull();
  });
});
