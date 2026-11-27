import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import claudeAdapter from "@0xpixelninja/conveno-adapter-claude";
import codexAdapter from "@0xpixelninja/conveno-adapter-codex";
import opencodeAdapter from "@0xpixelninja/conveno-adapter-opencode";
import { createTheme } from "@0xpixelninja/conveno-brand";
import { connect } from "@0xpixelninja/conveno-client";
import { dataDir } from "@0xpixelninja/conveno-core";
import { runStdio } from "@0xpixelninja/conveno-mcp";
import type { Ctx } from "./ctx.js";

/**
 * Path to the daemon entry script, resolved from this package's own dependencies so it works from
 * a pnpm-installed layout (where the daemon is not hoisted next to the client).
 */
export function resolveDaemonEntry(): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve("@0xpixelninja/conveno-daemon/bin"));
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

/** The first `conveno` on PATH, when it is a link to this very install. */
export function pathConvenoIsThisInstall(
  env: Readonly<Record<string, string | undefined>>,
  binPath: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return false; // .cmd shims cannot be compared with the script
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
): string[] {
  return pathConvenoIsThisInstall(env, binPath, platform) ? ["conveno"] : [nodePath, binPath];
}

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 15_000, windowsHide: true, shell: process.platform === "win32", encoding: "utf8" },
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

function ask(question: string, defaultYes: boolean): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `, (answer) => {
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
    confirm: ask,
    now: () => new Date(),
    readStdin: readAllStdin,
    connect,
    ppid: process.ppid,
    runMcp: runStdio,
    hookTimeoutMs: 2_000,
  };
}
