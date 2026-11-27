// Process ancestry and command lines, read from the OS. Used by the MCP server (to register the
// chain of processes above it), by `conveno hook` (to look that chain up) and by `conveno daemon
// stop` (to check that a pid is the daemon). Each OS gets one cheap query, never one per level:
//   Linux    /proc/<pid>/stat, one small file per level
//   macOS    one `ps -A -o pid=,ppid=` for the whole table
//   Windows  one PowerShell call that reads Win32_Process for the whole table
// The OS access is injected (`ProcessIo`) so tests feed in process tables.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { planSpawn } from "./win-spawn.js";

/** Longest ancestor chain. Matches `HOST_PIDS_MAX` in the protocol. */
export const MAX_ANCESTORS = 8;

export interface ProcessIo {
  platform: NodeJS.Platform;
  /** Read a text file. Rejects when it cannot be read. */
  readFile(path: string): Promise<string>;
  /** Run a program without a shell. Resolves with its stdout, or null when it failed or timed out. */
  run(file: string, args: string[], timeoutMs: number): Promise<string | null>;
}

export const defaultProcessIo: ProcessIo = {
  platform: process.platform,
  readFile: (path) => readFile(path, "utf8"),
  run: (file, args, timeoutMs) => {
    // On Windows the program is resolved on PATH and PATHEXT; nothing goes through a shell.
    const plan = planSpawn(file, args);
    return new Promise((resolve) => {
      execFile(
        plan.file,
        plan.args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (err, stdout) => resolve(err ? null : stdout),
      );
    });
  },
};

/** Windows: the whole process table as `<pid> <ppid>` lines, in one query. */
export const WINDOWS_TABLE_SCRIPT =
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

const powershell = (script: string): [string, string[]] => [
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
];

/** Parse `<pid> <ppid>` lines (`ps -A -o pid=,ppid=` or the PowerShell query) into pid -> ppid. */
export function parseProcessTable(output: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/** `/proc/<pid>/stat` is `pid (comm) state ppid ...`; comm may hold spaces and parentheses. */
export function parseProcStat(stat: string): number | undefined {
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
}

export interface Ancestry {
  /** Ancestor pids, nearest first: the direct parent, then its parent, and so on. */
  pids: number[];
  /**
   * False when the process table could not be read (WMI denies it to a non-admin NETWORK logon,
   * `ps` is missing, the query timed out). `pids` then holds only the direct parent, so a launcher
   * between the CLI and this process cannot be seen through.
   */
  complete: boolean;
}

export interface AncestryOptions {
  /** Process whose parents are wanted. Default: this process. */
  pid?: number;
  /** Its direct parent, when already known. Default: `process.ppid` for this process. */
  ppid?: number;
  /** Default `MAX_ANCESTORS`. */
  max?: number;
  /** Time allowed for the one process-table query. Default 5 s. */
  timeoutMs?: number;
  io?: ProcessIo;
}

/** Extend `[first]` upwards through `parentOf`, stopping at the root, at a cycle and at `max`. */
function walk(first: number, parentOf: (pid: number) => number | undefined, max: number): number[] {
  const chain = [first];
  const seen = new Set(chain);
  let cur = first;
  while (chain.length < max) {
    const next = parentOf(cur);
    // pid 0 and 1 are the kernel and init (or System Idle on Windows): never a useful ancestor.
    if (next === undefined || next <= 1 || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    cur = next;
  }
  return chain;
}

/**
 * The ancestor chain of a process. Never throws. The direct parent is always the first entry
 * when it is known, so a failed query degrades to the old single-pid behaviour.
 */
export async function readAncestry(opts: AncestryOptions = {}): Promise<Ancestry> {
  const io = opts.io ?? defaultProcessIo;
  const pid = opts.pid ?? process.pid;
  const ppid = opts.ppid ?? (opts.pid === undefined ? process.ppid : undefined);
  const max = opts.max ?? MAX_ANCESTORS;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  try {
    if (io.platform === "linux") return await linuxAncestry(io, pid, ppid, max);
    const table = await readTable(io, timeoutMs);
    const parent = ppid ?? table?.get(pid);
    if (parent === undefined || parent <= 0) return { pids: [], complete: false };
    if (!table || table.size === 0) return { pids: [parent], complete: false };
    return { pids: walk(parent, (p) => table.get(p), max), complete: true };
  } catch {
    return ppid !== undefined && ppid > 0
      ? { pids: [ppid], complete: false }
      : { pids: [], complete: false };
  }
}

async function linuxAncestry(
  io: ProcessIo,
  pid: number,
  known: number | undefined,
  max: number,
): Promise<Ancestry> {
  const stat = async (p: number): Promise<number | undefined> => {
    try {
      return parseProcStat(await io.readFile(`/proc/${p}/stat`));
    } catch {
      return undefined;
    }
  };
  const parent = known ?? (await stat(pid));
  if (parent === undefined || parent <= 0) return { pids: [], complete: false };
  // When /proc does not answer for the parent, the chain stops there and is flagged incomplete.
  const probe = await stat(parent);
  if (probe === undefined && parent > 1) return { pids: [parent], complete: false };
  const pids = [parent];
  const seen = new Set(pids);
  let next = probe;
  while (pids.length < max) {
    if (next === undefined || next <= 1 || seen.has(next)) break;
    pids.push(next);
    seen.add(next);
    next = await stat(next);
  }
  return { pids, complete: true };
}

async function readTable(io: ProcessIo, timeoutMs: number): Promise<Map<number, number> | null> {
  const out =
    io.platform === "win32"
      ? await io.run(...powershell(WINDOWS_TABLE_SCRIPT), timeoutMs)
      : await io.run("ps", ["-A", "-o", "pid=,ppid="], timeoutMs);
  return out === null ? null : parseProcessTable(out);
}

/**
 * The command line of a process as one string, or null when the OS does not say (the process is
 * gone, or the query was denied). A null answer means "unknown", never "not the daemon".
 */
export async function readCommandLine(
  pid: number,
  io: ProcessIo = defaultProcessIo,
  timeoutMs = 5_000,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    let text: string | null;
    if (io.platform === "linux") {
      text = (await io.readFile(`/proc/${pid}/cmdline`)).split("\0").join(" ");
    } else if (io.platform === "win32") {
      text = await io.run(
        ...powershell(
          `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}" -Property CommandLine).CommandLine`,
        ),
        timeoutMs,
      );
    } else {
      text = await io.run("ps", ["-o", "command=", "-p", String(pid)], timeoutMs);
    }
    const line = (text ?? "").trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}
