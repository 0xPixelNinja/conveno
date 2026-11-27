import { describe, expect, it } from "vitest";
import {
  MAX_ANCESTORS,
  type ProcessIo,
  parseProcessTable,
  parseProcStat,
  readAncestry,
  readCommandLine,
  WINDOWS_TABLE_SCRIPT,
} from "./process-info.js";

/** A process table as pid -> ppid. */
type Table = Record<number, number>;

interface Call {
  file: string;
  args: string[];
  timeoutMs: number;
}

/** Injected OS access over a fixed table. Records every spawn, and every file read. */
function fakeIo(platform: NodeJS.Platform, table: Table, over: Partial<ProcessIo> = {}) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const io: ProcessIo = {
    platform,
    readFile: async (path) => {
      reads.push(path);
      const m = /^\/proc\/(\d+)\/stat$/.exec(path);
      const ppid = m ? table[Number(m[1])] : undefined;
      if (ppid === undefined) throw new Error("ENOENT");
      return `${m?.[1]} (node (x) y) S ${ppid} 1 1 0`;
    },
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs });
      if (platform === "win32") {
        return `${Object.entries(table)
          .map(([p, pp]) => `${p} ${pp}`)
          .join("\r\n")}\r\n`;
      }
      return Object.entries(table)
        .map(([p, pp]) => `${p.padStart(6)} ${String(pp).padStart(6)}`)
        .join("\n");
    },
    ...over,
  };
  return { io, calls, reads };
}

describe("parsers", () => {
  it("reads ps output with padding and PowerShell output with CRLF", () => {
    expect([...parseProcessTable("    1     0\n  412   300\n")]).toEqual([
      [1, 0],
      [412, 300],
    ]);
    expect([...parseProcessTable("4 0\r\n500 400\r\n\r\n")]).toEqual([
      [4, 0],
      [500, 400],
    ]);
  });

  it("ignores headers, blank lines and noise", () => {
    expect([
      ...parseProcessTable("PID PPID\n\nProcessId ParentProcessId\nGet-CimInstance : x\n7 3"),
    ]).toEqual([[7, 3]]);
  });

  it("reads the parent from /proc stat even when the name has spaces and parentheses", () => {
    expect(parseProcStat("42 (my (weird) name) S 17 42 42 0")).toBe(17);
    expect(parseProcStat("garbage")).toBeUndefined();
  });
});

// The same process tree on every OS: terminal 100 > shell 200 > CLI 300, which starts the MCP
// server (through a launcher on Windows) and, later, a hook (through its own launcher).
describe("readAncestry on Linux", () => {
  const table: Table = { 100: 1, 200: 100, 300: 200, 310: 300, 500: 310 };

  it("walks /proc one level at a time, nearest first, and stops below init", async () => {
    const { io } = fakeIo("linux", table);
    expect(await readAncestry({ pid: 500, ppid: 310, io })).toEqual({
      pids: [310, 300, 200, 100],
      complete: true,
    });
  });

  it("reads the parent of the given pid when no ppid is passed", async () => {
    const { io } = fakeIo("linux", table);
    expect((await readAncestry({ pid: 500, io })).pids).toEqual([310, 300, 200, 100]);
  });

  it("caps the chain at eight entries", async () => {
    const deep: Table = {};
    for (let p = 10; p <= 40; p++) deep[p] = p - 1;
    const { io } = fakeIo("linux", deep);
    const r = await readAncestry({ pid: 40, ppid: 39, io });
    expect(r.pids).toHaveLength(MAX_ANCESTORS);
    expect(r.pids).toEqual([39, 38, 37, 36, 35, 34, 33, 32]);
  });

  it("stops at a cycle", async () => {
    const { io } = fakeIo("linux", { 20: 30, 30: 20 });
    expect((await readAncestry({ pid: 10, ppid: 20, io })).pids).toEqual([20, 30]);
  });

  it("ends the chain where /proc stops answering, still complete", async () => {
    const { io } = fakeIo("linux", { 310: 300, 500: 310 });
    // 300 is not readable: the chain is the parent and the ancestor that was seen.
    expect(await readAncestry({ pid: 500, ppid: 310, io })).toEqual({
      pids: [310, 300],
      complete: true,
    });
  });

  it("falls back to the direct parent, marked incomplete, when /proc is not readable", async () => {
    const { io } = fakeIo(
      "linux",
      {},
      { readFile: async () => Promise.reject(new Error("EACCES")) },
    );
    expect(await readAncestry({ pid: 500, ppid: 310, io })).toEqual({
      pids: [310],
      complete: false,
    });
  });
});

describe("readAncestry on macOS", () => {
  const table: Table = { 1: 0, 100: 1, 200: 100, 300: 200, 310: 300, 500: 310 };

  it("builds the chain from one ps call", async () => {
    const { io, calls } = fakeIo("darwin", table);
    expect(await readAncestry({ pid: 500, ppid: 310, timeoutMs: 800, io })).toEqual({
      pids: [310, 300, 200, 100],
      complete: true,
    });
    expect(calls).toEqual([{ file: "ps", args: ["-A", "-o", "pid=,ppid="], timeoutMs: 800 }]);
  });

  it("falls back to the direct parent when ps fails", async () => {
    const { io } = fakeIo("darwin", table, { run: async () => null });
    expect(await readAncestry({ pid: 500, ppid: 310, io })).toEqual({
      pids: [310],
      complete: false,
    });
  });
});

describe("readAncestry on Windows", () => {
  // npm installs conveno as conveno.cmd, so each side goes through a cmd.exe shim:
  //   WindowsTerminal 100 > powershell 200 > claude 300
  //     > cmd.exe 400 > node 500 (MCP server, started from conveno.cmd)
  //     > cmd.exe 410 > node 510 (hook, started from conveno.cmd)
  const table: Table = { 100: 0, 200: 100, 300: 200, 400: 300, 500: 400, 410: 300, 510: 410 };

  it("reads the whole table with one PowerShell call and walks it", async () => {
    const { io, calls } = fakeIo("win32", table);
    const mcp = await readAncestry({ pid: 500, ppid: 400, timeoutMs: 30_000, io });
    expect(mcp).toEqual({ pids: [400, 300, 200, 100], complete: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("powershell.exe");
    expect(calls[0]?.args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_TABLE_SCRIPT,
    ]);
    expect(WINDOWS_TABLE_SCRIPT).toContain("Get-CimInstance");
    expect(WINDOWS_TABLE_SCRIPT).toContain("Win32_Process");
    expect(WINDOWS_TABLE_SCRIPT).toContain("ProcessId,ParentProcessId");
    expect(calls[0]?.timeoutMs).toBe(30_000);
  });

  it("gives the MCP server and the hook chains that meet at the CLI, past both cmd.exe shims", async () => {
    const { io } = fakeIo("win32", table);
    const mcp = (await readAncestry({ pid: 500, ppid: 400, io })).pids;
    const hook = (await readAncestry({ pid: 510, ppid: 410, io })).pids;
    expect(mcp).toEqual([400, 300, 200, 100]);
    expect(hook).toEqual([410, 300, 200, 100]);
    // The old rule (ppid against ppid) never matched: 400 is not in the hook's chain.
    expect(hook).not.toContain(mcp[0]);
    expect(hook.find((p) => mcp.includes(p))).toBe(300);
  });

  it("falls back to [ppid] and flags it when WMI denies the query (non-admin NETWORK logon)", async () => {
    for (const out of [null, "", "Get-CimInstance : Access denied \r\n"]) {
      const { io } = fakeIo("win32", table, { run: async () => out });
      expect(await readAncestry({ pid: 510, ppid: 410, io })).toEqual({
        pids: [410],
        complete: false,
      });
    }
  });

  it("still answers the direct parent when the parent is not in the table", async () => {
    const { io } = fakeIo("win32", { 100: 4 });
    expect(await readAncestry({ pid: 510, ppid: 410, io })).toEqual({
      pids: [410],
      complete: true,
    });
  });

  it("never throws, even when the runner does", async () => {
    const { io } = fakeIo("win32", table, { run: async () => Promise.reject(new Error("spawn")) });
    expect(await readAncestry({ pid: 510, ppid: 410, io })).toEqual({
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
      run: async (file, args, timeoutMs) => (
        calls.push({ file, args, timeoutMs }), " node /d/bin.js\n"
      ),
    };
    expect(await readCommandLine(77, io, 900)).toBe("node /d/bin.js");
    expect(calls).toEqual([{ file: "ps", args: ["-o", "command=", "-p", "77"], timeoutMs: 900 }]);
  });

  it("asks PowerShell for one process on Windows", async () => {
    const calls: Call[] = [];
    const io: ProcessIo = {
      platform: "win32",
      readFile: async () => "",
      run: async (file, args, timeoutMs) => (
        calls.push({ file, args, timeoutMs }),
        '"C:\\node.exe" C:\\x\\@conveno\\daemon\\dist\\bin.js\r\n'
      ),
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
