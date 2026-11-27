import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import claudeAdapter from "@conveno/adapter-claude";
import codexAdapter from "@conveno/adapter-codex";
import opencodeAdapter from "@conveno/adapter-opencode";
import { createTheme, type Theme } from "@conveno/brand";
import { connect } from "@conveno/client";
import { dataDir } from "@conveno/core";
import { runStdio } from "@conveno/mcp";
import type { Ctx } from "./ctx.js";
import { type ShimIo, windowsConvenoIsThisInstall } from "./shim.js";
import { planSpawn } from "./win-spawn.js";

/**
 * Path to the daemon entry script, resolved from this package's own dependencies so it works from
 * a pnpm-installed layout (where the daemon is not hoisted next to the client).
 */
export function resolveDaemonEntry(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("@conveno/daemon/bin"));
  } catch {
    return undefined;
  }
}

/** Path of this install's `bin.js` (a sibling of the bundled chunk that holds this code). */
export function cliBinPath(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.url));
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * The first `conveno` on PATH, when it is a link to this very install. On Windows that is a
 * `.cmd` or `.ps1` shim, which is read to see which script it starts.
 */
export function pathConvenoIsThisInstall(
  env: Readonly<Record<string, string | undefined>>,
  binPath: string,
  platform: NodeJS.Platform,
  shimIo?: ShimIo,
): boolean {
  if (platform === "win32") return windowsConvenoIsThisInstall(env, binPath, shimIo);
  const mine = real(binPath);
  if (!mine) return false;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "conveno");
    if (existsSync(candidate)) return real(candidate) === mine;
  }
  return false;
}

export function convenoCommand(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  binPath = cliBinPath(),
  nodePath = process.execPath,
  shimIo?: ShimIo,
): string[] {
  return pathConvenoIsThisInstall(env, binPath, platform, shimIo)
    ? ["conveno"]
    : [nodePath, binPath];
}

function run(cmd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: "utf8" }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

let windowsTable: Promise<Map<number, number>> | undefined;

/** One query for the whole process table, so walking six levels costs one PowerShell start. */
function windowsParents(): Promise<Map<number, number>> {
  windowsTable ??= (async () => {
    const map = new Map<number, number>();
    const out = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      1_500,
    );
    for (const line of (out ?? "").split(/\r?\n/)) {
      const m = /^(\d+) (\d+)$/.exec(line.trim());
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
    return map;
  })();
  return windowsTable;
}

/** Parent pid of `pid`: /proc on Linux, `ps` on macOS, a CIM query on Windows. Null when unknown. */
export async function parentOf(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let ppid: number;
  if (platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // `pid (comm) state ppid ...`: comm may hold spaces and parentheses, so cut after the last `)`.
      ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return null;
    }
  } else if (platform === "win32") {
    ppid = (await windowsParents()).get(pid) ?? Number.NaN;
  } else {
    const out = await run("ps", ["-o", "ppid=", "-p", String(pid)], 500);
    ppid = Number((out ?? "").trim());
  }
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  const plan = planSpawn(cmd, args);
  return new Promise((resolve, reject) => {
    execFile(
      plan.file,
      plan.args,
      {
        timeout: 15_000,
        windowsHide: true,
        encoding: "utf8",
        ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      },
      (err, stdout) => {
        if (!err) return resolve({ code: 0, stdout });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") return resolve({ code, stdout: stdout ?? "" });
        reject(err);
      },
    );
  });
}

function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function ask(theme: Theme, question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const choices = theme.paint("quiet", defaultYes ? "[Y/n]" : "[y/N]");
  return new Promise((resolve) => {
    rl.question(`${theme.status("prompt")} ${question} ${choices} `, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" ? defaultYes : a === "y" || a === "yes");
    });
  });
}

export function createRuntimeCtx(): Ctx {
  const home = homedir();
  const env = process.env;
  const platform = process.platform;
  const theme = createTheme();
  const daemonEntry = resolveDaemonEntry();
  return {
    home,
    platform,
    cwd: process.cwd(),
    env,
    dataDir: dataDir(platform, env, home),
    ...(daemonEntry ? { daemonEntry } : {}),
    conveno: { command: convenoCommand(env, platform) },
    adapters: [claudeAdapter, codexAdapter, opencodeAdapter],
    exec,
    theme,
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm: (q, d) => ask(theme, q, d),
    now: () => new Date(),
    readStdin: readAllStdin,
    connect,
    ppid: process.ppid,
    parentOf,
    runMcp: runStdio,
    hookTimeoutMs: 2_000,
  };
}
