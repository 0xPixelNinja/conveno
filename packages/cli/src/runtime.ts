import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import claudeAdapter from "@conveno/adapter-claude";
import codexAdapter from "@conveno/adapter-codex";
import opencodeAdapter from "@conveno/adapter-opencode";
import { createTheme, type Theme } from "@conveno/brand";
import { connect } from "@conveno/client";
import { dataDir, planSpawn, readAncestry, readCommandLine } from "@conveno/core";
import { defaultIsAlive } from "@conveno/daemon";
import { runStdio } from "@conveno/mcp";
import type { Ctx } from "./ctx.js";
import { type ShimIo, windowsConvenoIsThisInstall } from "./shim.js";

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
    ancestry: (timeoutMs) => readAncestry({ timeoutMs }),
    isAlive: defaultIsAlive,
    commandLineOf: (pid) => readCommandLine(pid),
    kill: (pid) => process.kill(pid),
    stopTimeoutMs: 5_000,
    runMcp: runStdio,
    hookTimeoutMs: 2_000,
  };
}
