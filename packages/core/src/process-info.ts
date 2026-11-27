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

/** Windows: the whole process table as `<pid> <ppid> <command line>` lines, in one query. */
export const WINDOWS_TABLE_SCRIPT =
  'Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CommandLine | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }';

const powershell = (script: string): [string, string[]] => [
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-Command", script],
];

interface Row {
  ppid: number;
  command?: string;
}

/**
 * Parse `<pid> <ppid> [command line]` lines (`ps -A -o pid=,ppid=,args=` or the PowerShell query)
 * into pid -> { ppid, command }.
 */
export function parseProcessTable(output: string): Map<number, Row> {
  const table = new Map<number, Row>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const row: Row = { ppid: Number(m[2]) };
    if (m[3]) row.command = m[3];
    table.set(Number(m[1]), row);
  }
  return table;
}

/** `/proc/<pid>/stat` is `pid (comm) state ppid ...`; comm may hold spaces and parentheses. */
export function parseProcStat(stat: string): number | undefined {
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid >= 0 ? ppid : undefined;
}

export interface ProcessEntry {
  pid: number;
  /** Command line, when the OS gave one. */
  command?: string;
}

export interface Ancestry {
  /** Ancestors, nearest first: the direct parent, then its parent, and so on. */
  entries: ProcessEntry[];
  /** `entries` as bare pids: the raw chain registered as `hostPids`. */
  pids: number[];
  /**
   * The CLI process: the first ancestor that is not part of launching Conveno itself (see
   * `isConvenoLauncher`). Undefined when every ancestor is a launcher.
   */
  hostPid: number | undefined;
  /**
   * False when the process table could not be read (WMI denies it to a non-admin NETWORK logon,
   * `ps` is missing, the query timed out). `entries` then holds only the direct parent, without a
   * command line, so it is taken as the host: exact, but right only when no launcher sits between.
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
  /** Paths of Conveno's own bin script (normally `process.argv[1]`), for launcher detection. */
  launcherPaths?: string[];
  io?: ProcessIo;
}

const norm = (text: string): string => text.replaceAll("\\", "/").toLowerCase();

/** Split a command line into tokens, keeping quoted parts together and dropping the quotes. */
function tokens(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VERB = String.raw`["'^]*\s+["'^]*(?:hook|mcp)(?![\w-])`;
/** `conveno`, `conveno.cmd` or `conveno.ps1`, then quotes or cmd.exe carets, then `hook` or `mcp`. */
const CLI_VERB = new RegExp(String.raw`(?:^|[\s"'/])conveno(?:\.cmd|\.ps1)?${VERB}`);
/** The `conveno.cmd` or `conveno.ps1` shim file itself, wherever it appears. */
const SHIM_FILE = /(?:^|[\s"'/^])conveno\.(?:cmd|ps1)(?![\w.-])/;
/** An installed `@conveno/cli` entry script, in any package-manager layout. */
const INSTALLED_BIN = String.raw`@conveno/cli/(?:[^\s"']*/)?bin\.js`;

/**
 * Is this command line part of launching Conveno itself, as opposed to the CLI that hosts it?
 * Precise on purpose; a shell is skipped only when it is running a Conveno command:
 *  - a command line that runs `conveno hook ...` or `conveno mcp ...` (also `conveno.cmd`,
 *    `conveno.ps1`, or our own bin script by path): `sh -c "conveno hook claude X"`,
 *    `cmd /d /s /c ""...\conveno.cmd" hook ..."`
 *  - the cmd.exe or powershell that runs the `conveno.cmd` or `conveno.ps1` shim
 *  - node running our bin script (the installed `@conveno/cli` one, or one of `launcherPaths`)
 * Anything else, a bare shell included, is not a launcher.
 */
export function isConvenoLauncher(command: string, launcherPaths: string[] = []): boolean {
  const line = norm(command);
  if (CLI_VERB.test(line) || SHIM_FILE.test(line)) return true;
  const bins = launcherPaths.map(norm).filter((p) => p !== "");
  for (const bin of [...bins.map(escapeRe), INSTALLED_BIN]) {
    if (new RegExp(`${bin}${VERB}`).test(line)) return true;
  }
  const [exe, ...rest] = tokens(line);
  if (exe === undefined || !/(?:^|\/)node(?:\.exe)?$/.test(exe)) return false;
  const script = rest.find((t) => !t.startsWith("-"));
  return (
    script !== undefined && (bins.includes(script) || new RegExp(`${INSTALLED_BIN}$`).test(script))
  );
}

/** The first entry that is not a Conveno launcher. An entry without a command line counts as host. */
export function pickHostPid(
  entries: ProcessEntry[],
  launcherPaths: string[] = [],
): number | undefined {
  return entries.find(
    (e) => e.command === undefined || !isConvenoLauncher(e.command, launcherPaths),
  )?.pid;
}

function build(entries: ProcessEntry[], complete: boolean, launcherPaths: string[]): Ancestry {
  return {
    entries,
    pids: entries.map((e) => e.pid),
    hostPid: pickHostPid(entries, launcherPaths),
    complete,
  };
}

/** Extend `[first]` upwards through the table, stopping at the root, at a cycle and at `max`. */
function walk(first: number, table: ReadonlyMap<number, Row>, max: number): ProcessEntry[] {
  const entry = (pid: number): ProcessEntry => {
    const command = table.get(pid)?.command;
    return command === undefined ? { pid } : { pid, command };
  };
  const chain = [entry(first)];
  const seen = new Set([first]);
  let cur = first;
  while (chain.length < max) {
    const next = table.get(cur)?.ppid;
    // pid 0 and 1 are the kernel and init (or System Idle on Windows): never a useful ancestor.
    if (next === undefined || next <= 1 || seen.has(next)) break;
    chain.push(entry(next));
    seen.add(next);
    cur = next;
  }
  return chain;
}

/**
 * The ancestor chain of a process, with command lines, and the host pid taken from it. Never
 * throws. The direct parent is always the first entry when known, so a failed query degrades to
 * "the direct parent is the host".
 */
export async function readAncestry(opts: AncestryOptions = {}): Promise<Ancestry> {
  const io = opts.io ?? defaultProcessIo;
  const pid = opts.pid ?? process.pid;
  const ppid = opts.ppid ?? (opts.pid === undefined ? process.ppid : undefined);
  const max = opts.max ?? MAX_ANCESTORS;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const launchers = opts.launcherPaths ?? [];
  const bare = (): Ancestry =>
    build(ppid !== undefined && ppid > 0 ? [{ pid: ppid }] : [], false, launchers);
  try {
    const table =
      io.platform === "linux"
        ? await linuxTable(io, pid, ppid, max)
        : await readTable(io, timeoutMs);
    const parent = ppid ?? table?.get(pid)?.ppid;
    if (parent === undefined || parent <= 0 || !table || table.size === 0) return bare();
    return build(walk(parent, table, max), true, launchers);
  } catch {
    return bare();
  }
}

/** Linux has no table to read: build the part the walk needs from /proc, level by level. */
async function linuxTable(
  io: ProcessIo,
  pid: number,
  known: number | undefined,
  max: number,
): Promise<Map<number, Row> | null> {
  const table = new Map<number, Row>();
  const read = async (p: number): Promise<number | undefined> => {
    let ppid: number | undefined;
    try {
      ppid = parseProcStat(await io.readFile(`/proc/${p}/stat`));
    } catch {
      return undefined;
    }
    if (ppid === undefined) return undefined;
    const row: Row = { ppid };
    try {
      const command = (await io.readFile(`/proc/${p}/cmdline`)).split("\0").join(" ").trim();
      if (command !== "") row.command = command;
    } catch {
      // No command line: the process still counts, as a host.
    }
    table.set(p, row);
    return ppid;
  };
  const parent = known ?? (await read(pid));
  if (parent === undefined || parent <= 0) return null;
  let cur: number | undefined = parent;
  for (let i = 0; i < max && cur !== undefined && cur > 1 && !table.has(cur); i++) {
    cur = await read(cur);
  }
  // When /proc does not answer even for the parent, nothing was learned: incomplete.
  return table.size === 0 ? null : table;
}

async function readTable(io: ProcessIo, timeoutMs: number): Promise<Map<number, Row> | null> {
  const out =
    io.platform === "win32"
      ? await io.run(...powershell(WINDOWS_TABLE_SCRIPT), timeoutMs)
      : await io.run("ps", ["-A", "-o", "pid=,ppid=,args="], timeoutMs);
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
