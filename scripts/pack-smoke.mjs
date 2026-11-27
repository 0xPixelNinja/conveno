// Pack smoke test: packs @conveno/cli, the one published package, installs the tarball into a clean
// temp project with plain npm (as a user would), checks what landed, then drives the installed
// `conveno` with an isolated home and data directory. Run it after `pnpm build`: `pnpm smoke:pack`.
//
// Exits non-zero on the first failure. Everything it creates lives under one temp directory that
// is removed at the end, and the daemon is stopped before that.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Plain erasable TypeScript, loaded by Node's type stripping (the e2e real-cli script does too).
import { planSpawn } from "../packages/core/src/win-spawn.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const log = (msg) => console.log(`smoke: ${msg}`);

class SmokeError extends Error {}
const fail = (msg) => {
  throw new SmokeError(msg);
};
const check = (cond, msg) => {
  if (!cond) fail(msg);
};

/** Run a command to completion. Windows .cmd shims go through cmd.exe via planSpawn, never a shell option. */
function run(command, args, { cwd, env = process.env, timeout = 120_000, input } = {}) {
  const plan = planSpawn(command, args, { env });
  return new Promise((resolvePromise) => {
    const child = spawn(plan.file, plan.args, {
      cwd,
      env,
      windowsHide: true,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? "");
  });
}

async function mustRun(label, command, args, opts) {
  const r = await run(command, args, opts);
  if (r.code !== 0) {
    fail(
      `${label} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""})\n${r.stdout}\n${r.stderr}`.trim(),
    );
  }
  return r;
}

/** Publishable workspace members: every package.json under packages/ that is not private. */
function publishablePackages() {
  const dirs = [];
  for (const top of readdirSync(join(root, "packages"), { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const dir = join(root, "packages", top.name);
    if (existsSync(join(dir, "package.json"))) dirs.push(dir);
    else
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(join(dir, sub.name, "package.json"))) {
          dirs.push(join(dir, sub.name));
        }
      }
  }
  return dirs
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
    .filter((p) => p.manifest.private !== true);
}

async function main(work) {
  const pkgs = publishablePackages();
  check(
    pkgs.length === 1 && pkgs[0].manifest.name === "@conveno/cli",
    `only @conveno/cli may be published, found: ${pkgs.map((p) => p.manifest.name).join(", ") || "none"}`,
  );
  const cli = pkgs[0];
  log(`packing ${cli.manifest.name}`);

  const tarballs = join(work, "tarballs");
  mkdirSync(tarballs);
  check(existsSync(join(cli.dir, "dist", "bin.js")), "no dist/bin.js, run pnpm build first");
  await mustRun("pnpm pack", "pnpm", ["pack", "--pack-destination", tarballs], { cwd: cli.dir });
  const files = readdirSync(tarballs)
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => join(tarballs, f));
  check(files.length === 1, `expected 1 tarball, got ${files.length}`);

  const project = join(work, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), '{"name":"conveno-smoke","private":true}\n');
  log("npm install");
  await mustRun(
    "npm install",
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error", ...files],
    { cwd: project, timeout: 300_000 },
  );

  checkInstalled(project);

  // Isolated identity: nothing here may touch the real home, data directory or daemon.
  const home = join(work, "home");
  const xdgRuntime = join(work, "run");
  const localAppData = join(home, "AppData", "Local");
  const xdgData = join(home, ".local", "share");
  for (const d of [home, xdgRuntime, localAppData, xdgData]) mkdirSync(d, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: xdgRuntime,
    LOCALAPPDATA: localAppData,
    APPDATA: join(home, "AppData", "Roaming"),
    // The Windows pipe name is derived from the user name, so give this run its own.
    USERNAME: `smoke${randomBytes(4).toString("hex")}`,
    NO_COLOR: "1",
    CI: "1",
  };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG", "CONVENO_ASCII"])
    delete env[k];

  const bin = join(project, "node_modules", ".bin", win ? "conveno.cmd" : "conveno");
  check(existsSync(bin), `installed bin is missing: ${bin}`);
  const conveno = (args, opts) =>
    mustRun(`conveno ${args.join(" ")}`, bin, args, { cwd: home, env, ...opts });

  let daemonMayRun = false;
  try {
    const version = await conveno(["--version"]);
    check(
      version.stdout.trim() === cli.manifest.version,
      `conveno --version printed "${version.stdout.trim()}", expected ${cli.manifest.version}`,
    );
    log(`conveno --version ${version.stdout.trim()}`);

    await conveno(["doctor"]);
    log("conveno doctor ok");

    daemonMayRun = true;
    const started = await conveno(["daemon", "start"]);
    log(`conveno daemon start: ${started.stdout.trim()}`);
    const status = await conveno(["daemon", "status"]);
    check(/daemon running/.test(status.stdout), `daemon status: ${status.stdout}${status.stderr}`);
    log(`conveno daemon status: ${status.stdout.trim()}`);

    const session = await mcpRoundTrip(project, bin, env, home);
    await waitUnregistered(conveno, session);
    log(`mcp server unregistered ${session} after its client closed`);

    const preview = await conveno(["forget", "--offline", "--dry-run"]);
    check(
      preview.stdout.includes(session),
      `forget --dry-run does not list ${session}: ${preview.stdout}`,
    );
    const forgot = await conveno(["forget", session, "--yes"]);
    check(
      /Done\. Forgot 1 session\./.test(forgot.stdout),
      `forget: ${forgot.stdout}${forgot.stderr}`,
    );
    log(`conveno forget removed ${session}`);

    await conveno(["daemon", "stop"]);
    daemonMayRun = false;
    const after = await run(bin, ["daemon", "status"], { cwd: home, env });
    check(
      /not running/.test(after.stdout),
      `daemon still running after stop: ${after.stdout}${after.stderr}`,
    );
    log("conveno daemon stop ok");
  } finally {
    if (daemonMayRun) await run(bin, ["daemon", "stop"], { cwd: home, env }).catch(() => {});
  }
}

/**
 * What npm installed: the files the package promises, the daemon entry beside the command, and no
 * other @conveno package (they are bundled, so nothing may resolve to a workspace copy).
 */
function checkInstalled(project) {
  const installed = join(project, "node_modules", "@conveno", "cli");
  for (const f of ["README.md", "LICENSE", "NOTICE", "dist/bin.js", "dist/daemon.js"]) {
    check(existsSync(join(installed, f)), `the installed package is missing ${f}`);
  }
  const top = readdirSync(installed).sort();
  check(
    top.every((n) => ["README.md", "LICENSE", "NOTICE", "dist", "package.json"].includes(n)),
    `unexpected files in the installed package: ${top.join(", ")}`,
  );
  const scope = readdirSync(join(project, "node_modules", "@conveno"));
  check(scope.length === 1, `other @conveno packages were installed: ${scope.join(", ")}`);
  log(`installed files ok (${top.join(", ")})`);
}

const EXPECTED_TOOLS = [
  "whoami",
  "list_sessions",
  "send",
  "inbox",
  "ack",
  "rename",
  "set_status",
  "orchestrate",
];

/** Real MCP handshake and tools/list over stdio against the installed `conveno mcp`. */
async function mcpRoundTrip(project, bin, env, cwd) {
  // The installed copy of the SDK (a dependency of @conveno/mcp), ESM build.
  const sdk = join(project, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  check(existsSync(sdk), `installed MCP SDK not found at ${sdk}`);
  const { Client } = await import(pathToFileURL(join(sdk, "client", "index.js")).href);
  const { StdioClientTransport } = await import(
    pathToFileURL(join(sdk, "client", "stdio.js")).href
  );
  const transport = new StdioClientTransport({
    command: bin,
    args: ["mcp", "--cli", "claude"],
    env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)),
    cwd,
    stderr: "pipe",
  });
  const client = new Client({ name: "pack-smoke", version: "0.0.0" });
  try {
    await Promise.race([
      client.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new SmokeError("MCP initialize timed out")), 30_000),
      ),
    ]);
    const server = client.getServerVersion();
    check(server?.name === "conveno", `unexpected MCP server name: ${server?.name}`);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const want of EXPECTED_TOOLS)
      check(names.includes(want), `tools/list is missing ${want}: ${names}`);
    log(`mcp initialize + tools/list ok (${names.length} tools)`);
    const who = await client.callTool({ name: "whoami", arguments: {} });
    const name = /Name: (\S+)/.exec(who.content?.[0]?.text ?? "")?.[1];
    check(name !== undefined, `whoami did not name the session: ${JSON.stringify(who)}`);
    return name;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * After its client closes stdin, the MCP server unregisters and exits. On Windows it runs behind
 * the conveno.cmd shim and takes a moment, and while it runs it holds files in this folder. Wait
 * for the daemon to show the session gone or offline, which also checks that unregister works.
 */
async function waitUnregistered(conveno, name) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const line = (await conveno(["status"])).stdout.split("\n").find((l) => l.includes(name));
    if (line === undefined || /offline/.test(line)) return;
    if (Date.now() > deadline) {
      throw new SmokeError(`session ${name} is still online 15 s after its MCP client closed`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const work = mkdtempSync(join(tmpdir(), "cvs-"));
let failed = false;
try {
  await main(work);
  log("passed");
} catch (err) {
  failed = true;
  console.error(`smoke: FAILED\n${err instanceof SmokeError ? err.message : (err?.stack ?? err)}`);
} finally {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.error(`smoke: could not remove ${work}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
