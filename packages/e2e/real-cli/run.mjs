#!/usr/bin/env node
// Real-CLI check for a developer's machine. Plain Node (>= 24), no dependencies.
// Runs on the REAL home directory, because the real CLIs need your logins.
// It prints what it will change and does not apply anything without approval.
// See README.md in this folder. Results go to a JSON report.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
// One resolver for the CLI and this script. Node strips the types from this file.
import { planSpawn } from "../../core/src/win-spawn.ts";
import { cleanupStale, markerPath, readMarker, removeMarker, writeMarker } from "./marker.ts";

const USAGE = `Usage: node run.mjs [options]

  --conveno <cmd>      How to run conveno (default: conveno)
  --clis <list>        Comma list from claude,opencode,codex (default: every installed one)
  --approve-init       Approve "conveno init --yes" for the CLIs above. Without a terminal,
                       the script prints the plan and stops (exit code 2) unless this is set.
  --keep-installed     Do not run "conveno uninstall" at the end (default: uninstall)
  --manual             Also walk through the interactive two-terminal check
  --data-dir <dir>     Conveno data dir (default: the platform default)
  --report <file>      JSON report path (default: ./real-cli-report.json)
  --timeout <sec>      Per agent run (default: 300)
  --print-manual       Print the interactive prompts and exit
  --help
`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
if (flag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const CONVENO = opt("--conveno", "conveno");
const REPORT = opt("--report", join(process.cwd(), "real-cli-report.json"));
const TIMEOUT_MS = Number(opt("--timeout", "300")) * 1000;
const NONCE = `cvn-${randomBytes(4).toString("hex")}`;
// `--conveno x.js` runs through this Node. A .js file handed to cmd.exe opens Windows Script Host.
const CONVENO_IS_SCRIPT = /\.(c|m)?js$/i.test(CONVENO);
const CONVENO_BIN = CONVENO_IS_SCRIPT ? process.execPath : CONVENO;
const CONVENO_PREFIX = CONVENO_IS_SCRIPT ? [resolve(CONVENO)] : [];

function dataDir() {
  const given = opt("--data-dir");
  if (given) return given;
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "conveno");
  }
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "conveno");
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg?.startsWith("/") ? xdg : join(home, ".local", "share"), "conveno");
}

/* ---------- prompts for the interactive check ---------- */

const manualPrompts = (self, other) => ({
  terminal1: [
    "Call the conveno whoami tool and tell me my session name.",
    "Call the conveno list_sessions tool and tell me who else is online.",
    `Use the conveno send tool to send "${NONCE} hello from terminal 1" to ${other}.`,
  ],
  terminal2: [
    "Call the conveno whoami tool and tell me my session name.",
    "Reply with the single word ok.",
    "Call the conveno inbox tool and quote the message you got, word for word.",
  ],
  expect: [
    `Terminal 1 whoami shows a name like ${self}.`,
    `Terminal 2, second prompt: on Claude Code the message from terminal 1 should already be in the agent's context before it calls inbox (hook delivery). Ask "what did the last message from another session say?" to see it.`,
    `Terminal 2, third prompt: inbox returns the framed message, including "not from the user".`,
  ],
});

if (flag("--print-manual")) {
  console.log(JSON.stringify(manualPrompts("claude@<repo-1>-1", "claude@<repo-2>-1"), null, 2));
  process.exit(0);
}

/* ---------- small helpers ---------- */

const steps = [];
const report = {
  nonce: NONCE,
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  conveno: CONVENO,
  steps,
  summary: {},
};
const tmpDirs = [];

function save() {
  report.finishedAt = new Date().toISOString();
  report.summary = {
    pass: steps.filter((s) => s.status === "pass").length,
    fail: steps.filter((s) => s.status === "fail").length,
    skip: steps.filter((s) => s.status === "skip").length,
  };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
}

async function step(id, title, fn) {
  const t0 = Date.now();
  console.log(`\n== ${id}: ${title}`);
  const rec = { id, title, status: "pass", detail: "", ms: 0 };
  steps.push(rec);
  try {
    const r = await fn();
    if (r?.skip) {
      rec.status = "skip";
      rec.detail = r.skip;
    } else {
      rec.detail = r?.detail ?? "";
      if (r?.data !== undefined) rec.data = r.data;
    }
  } catch (e) {
    rec.status = "fail";
    if (e?.data !== undefined) rec.data = e.data;
    rec.detail = e instanceof Error ? e.message : String(e);
  }
  rec.ms = Date.now() - t0;
  console.log(
    `   ${rec.status.toUpperCase()}${rec.detail ? `: ${rec.detail.split("\n")[0]}` : ""}`,
  );
  save();
  return rec;
}

function run(cmd, cmdArgs, o = {}) {
  const plan = planSpawn(cmd, cmdArgs);
  const r = spawnSync(plan.file, plan.args, {
    encoding: "utf8",
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    timeout: o.timeout ?? 60_000,
    cwd: o.cwd,
    input: o.input,
    windowsHide: true,
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
    error: r.error?.message,
  };
}

/** Run a long agent command without blocking the script. Resolves when it exits or times out. */
function runAsync(cmd, cmdArgs, o) {
  const plan = planSpawn(cmd, cmdArgs);
  const child = spawn(plan.file, plan.args, {
    cwd: o.cwd,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out, err, timedOut: true });
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, out, err: `${err}${e.message}`, timedOut: false });
    });
  });
  return { child, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conveno = (...a) => run(CONVENO_BIN, [...CONVENO_PREFIX, ...a]);

async function ask(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer;
}

function makeRepo(label) {
  const base = mkdtempSync(join(tmpdir(), "cvn-real-"));
  tmpDirs.push(base);
  const dir = join(base, `conveno-real-${label}-${NONCE.slice(4)}`);
  mkdirSync(dir);
  const g = run("git", ["init", "-q", dir]);
  if (g.code !== 0) throw new Error(`git init failed: ${g.err || g.error}`);
  return dir;
}

const sessionName = (cli, repoDir) => {
  const base = repoDir.split(/[\\/]/).pop().toLowerCase();
  return `${cli}@${base}-1`;
};

async function waitForStatus(text, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = conveno("status");
    if (r.out.includes(text)) return true;
    await sleep(2000);
  }
  return false;
}

/** Read-only look at the daemon database for the nonce. Schema: messages(json), mailbox(state). */
function dbRows(needle) {
  const file = join(dataDir(), "conveno.db");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT m.id AS id, json_extract(m.json, '$.kind') AS kind, mb.session_id AS session_id, mb.state AS state
         FROM messages m LEFT JOIN mailbox mb ON mb.message_id = m.id
         WHERE m.json LIKE ?`,
      )
      .all(`%${needle}%`);
  } finally {
    db.close();
  }
}

/* ---------- per-CLI agent invocation ---------- */

const TOOL_NOTE = "Use the conveno MCP tools (whoami, list_sessions, send, inbox).";

function agentCommand(cli, prompt, { canSleep } = {}) {
  switch (cli) {
    case "claude": {
      // Flags per Claude Code CLI reference: -p, --output-format, --allowedTools.
      const allowed = ["mcp__conveno", ...(canSleep ? ["Bash(sleep *)"] : [])].join(",");
      return ["claude", ["-p", prompt, "--output-format", "json", "--allowedTools", allowed]];
    }
    case "opencode":
      return ["opencode", ["run", prompt]];
    case "codex":
      return ["codex", ["exec", "--skip-git-repo-check", prompt]];
    default:
      throw new Error(`unknown cli ${cli}`);
  }
}

const textOf = (cli, res) => {
  if (cli !== "claude") return res.out;
  try {
    return String(JSON.parse(res.out).result ?? res.out);
  } catch {
    return res.out;
  }
};

/**
 * The receiver (always Claude Code here) polls its inbox until the sender's message arrives.
 * Then the sender runs whoami, list_sessions and send. Both are real CLI processes.
 */
async function pair(senderCli, receiverCli, tag) {
  const rRepo = makeRepo(`${tag}r`);
  const sRepo = makeRepo(`${tag}s`);
  const rName = sessionName(receiverCli, rRepo);
  const sName = sessionName(senderCli, sRepo);
  const text = `${NONCE} ${tag} hello`;

  const recvPrompt =
    `${TOOL_NOTE} Call whoami. Then call inbox. If it returns no messages, run "sleep 5" in Bash and call inbox again, up to 40 times. ` +
    `When a message arrives, reply with exactly: GOT <the message text>. If none arrives, reply NONE.`;
  const [rBin, rArgs] = agentCommand(receiverCli, recvPrompt, { canSleep: true });
  const recv = runAsync(rBin, rArgs, { cwd: rRepo });

  const up = await waitForStatus(rName);
  if (!up) {
    recv.child.kill("SIGKILL");
    const r = await recv.done;
    throw new Error(
      `Receiver ${rName} never appeared in "conveno status". stderr: ${r.err.slice(0, 400)}`,
    );
  }

  const sendPrompt =
    `${TOOL_NOTE} Do these in order: 1) call whoami. 2) call list_sessions. ` +
    `3) call send with to="${rName}" and text="${text}". Then reply with the id the send tool returned.`;
  const [sBin, sArgs] = agentCommand(senderCli, sendPrompt);
  const sender = await runAsync(sBin, sArgs, { cwd: sRepo }).done;
  const receiver = await recv.done;

  const senderText = textOf(senderCli, sender);
  const receiverText = textOf(receiverCli, receiver);
  const rows = dbRows(text);
  const data = {
    senderSession: sName,
    receiverSession: rName,
    senderExit: sender.code,
    receiverExit: receiver.code,
    senderReply: senderText.slice(0, 300),
    receiverReply: receiverText.slice(0, 300),
    dbRows: rows,
  };
  const problems = [];
  if (sender.code !== 0) problems.push(`sender exited ${sender.code}: ${sender.err.slice(0, 300)}`);
  if (rows.length === 0) problems.push("message not found in the daemon database");
  else if (!rows.some((r) => r.state === "read" || r.state === "acked")) {
    problems.push(
      `message is in the database but state is ${rows.map((r) => r.state).join(",")}, not read`,
    );
  }
  if (!receiverText.includes(text))
    problems.push(
      `receiver reply does not contain the message text: ${receiverText.slice(0, 200)}`,
    );
  if (problems.length) throw Object.assign(new Error(problems.join("; ")), { data });
  return { detail: `${sName} -> ${rName}`, data };
}

/* ---------- the run ---------- */

console.log(`Conveno real-CLI check. Nonce ${NONCE}. Report: ${REPORT}`);
console.log("This runs on your real home directory and real CLI logins.");

let targets = [];

const pre = await step("prereq", "Check Node, conveno and the installed CLIs", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw new Error(`Node ${process.version} is too old. Install Node 24 or newer.`);
  const v = conveno("--version");
  if (v.code !== 0) {
    throw new Error(
      `"${CONVENO} --version" failed (${v.error ?? v.err}). Install conveno or pass --conveno <path>.`,
    );
  }
  const found = {};
  for (const c of ["claude", "opencode", "codex"]) {
    const r = run(c, ["--version"]);
    found[c] = r.code === 0 ? r.out.split("\n")[0] : null;
  }
  const git = run("git", ["--version"]);
  if (git.code !== 0) throw new Error("git is required for the temporary test repos.");
  const wanted = opt("--clis")
    ?.split(",")
    .map((s) => s.trim());
  targets = Object.keys(found).filter((c) => found[c] && (!wanted || wanted.includes(c)));
  if (!targets.includes("claude"))
    throw new Error(
      "Claude Code is required (the receiver in every pair). Install it and log in first.",
    );
  return {
    detail: `conveno ${v.out}; using ${targets.join(", ")}`,
    data: { conveno: v.out, found, targets },
  };
});

if (pre.status === "fail") {
  save();
  console.error(`\nStopping: ${pre.detail}`);
  process.exit(1);
}

// A run killed with SIGKILL skips its uninstall. Its marker is still here: show it and clean up
// first, under the same approval rules as init. Nothing is changed without approval.
const MARKER = markerPath(dataDir());
if (readMarker(MARKER).kind !== "none") {
  let outcome = "none";
  await step("stale-cleanup", "Clean up after an earlier interrupted run", async () => {
    outcome = await cleanupStale({
      markerFile: MARKER,
      conveno: (...a) => conveno(...a),
      approved: flag("--approve-init"),
      ask,
      log: console.log,
    });
    if (outcome === "failed") throw new Error("cleanup of the earlier run failed");
    if (outcome !== "cleaned") return { skip: `earlier run not cleaned up (${outcome})` };
    return { detail: "cleaned up the earlier run" };
  });
  if (outcome !== "cleaned") {
    save();
    process.exit(outcome === "failed" ? 1 : 2);
  }
}

// Show the plan, then ask. Nothing is changed before this point.
console.log("\n--- PLAN (nothing has been changed yet) ---");
console.log(
  `1. conveno init --yes --cli ${targets.join(",")}   (edits the CLIs' config; conveno backs up each file first)`,
);
console.log(
  "2. Start two real sessions per pair in temporary git repos, send a message, check the daemon database.",
);
console.log(
  `3. ${flag("--keep-installed") ? "Leave Conveno installed." : "conveno uninstall --yes   (restores the config files)"}`,
);
console.log("Preview of the exact config changes:");
const preview = conveno("init", "--dry-run", "--cli", targets.join(","));
if (preview.code === 0) console.log(preview.out);
else
  console.log(
    '   (no --dry-run in this conveno build. "conveno init" without --yes prints the exact diff and asks.)',
  );
report.plan = { targets, dryRun: preview.code === 0 ? preview.out : null };

let approved = flag("--approve-init");
if (!approved) {
  const a = await ask("Apply these changes to your real configuration? [y/N] ");
  if (a === null) {
    save();
    console.error(
      "\nNo terminal and no --approve-init. Review the plan above, then re-run with --approve-init.",
    );
    process.exit(2);
  }
  approved = a === "y" || a === "yes";
}
if (!approved) {
  await step("init", "conveno init", () => ({ skip: "not approved" }));
  save();
  console.log("Not approved. Nothing was changed.");
  process.exit(2);
}

let initAttempted = false;
try {
  initAttempted = true;
  // Written before init and removed after a successful uninstall, so a killed run leaves a trace.
  if (!flag("--keep-installed")) {
    writeMarker(MARKER, {
      nonce: NONCE,
      pid: process.pid,
      startedAt: report.startedAt,
      platform: report.platform,
      targets,
      conveno: CONVENO,
    });
  }
  await step("init", "conveno init --yes", () => {
    const r = conveno("init", "--yes", "--cli", targets.join(","));
    if (r.code !== 0) throw new Error(`init failed (${r.code}): ${r.err || r.out}`.slice(0, 600));
    return { detail: "applied", data: { output: r.out.slice(0, 2000) } };
  });

  await step("doctor", "conveno doctor reports each CLI as configured", () => {
    const r = conveno("doctor");
    if (r.code !== 0) throw new Error(`doctor exited ${r.code}: ${(r.err || r.out).slice(0, 400)}`);
    const missing = targets.filter((c) => !r.out.toLowerCase().includes(c));
    if (missing.length) throw new Error(`doctor output does not mention ${missing.join(", ")}`);
    return { data: { output: r.out.slice(0, 3000) } };
  });

  await step("daemon", "daemon starts", () => {
    const r = conveno("daemon", "start");
    const s = conveno("daemon", "status");
    if (s.code !== 0)
      throw new Error(`daemon status exited ${s.code}: ${(s.err || s.out).slice(0, 300)}`);
    return { detail: s.out.split("\n")[0], data: { start: r.out, status: s.out } };
  });

  await step(
    "hook-smoke",
    "conveno hook claude UserPromptSubmit prints nothing outside a session",
    () => {
      const r = run(CONVENO_BIN, [...CONVENO_PREFIX, "hook", "claude", "UserPromptSubmit"], {
        input: "{}",
        timeout: 10_000,
      });
      if (r.code !== 0) throw new Error(`hook exited ${r.code}, a hook must always exit 0`);
      if (r.out !== "")
        throw new Error(`hook printed text for a pid with no session: ${r.out.slice(0, 200)}`);
    },
  );

  await step(
    "pair-claude-claude",
    "Claude Code sends to Claude Code (non-interactive, claude -p)",
    () => pair("claude", "claude", "cc"),
  );

  await step("pair-opencode-claude", "OpenCode sends to Claude Code (opencode run)", () =>
    targets.includes("opencode")
      ? pair("opencode", "claude", "oc")
      : { skip: "opencode not installed" },
  );

  await step("pair-codex-claude", "Codex sends to Claude Code (codex exec, best effort)", () =>
    targets.includes("codex") ? pair("codex", "claude", "cx") : { skip: "codex not installed" },
  );

  await step("liveness", "finished sessions are not listed as online", () => {
    const r = conveno("status");
    const stale = r.out
      .split("\n")
      .filter((l) => l.includes("conveno-real-") && /idle|busy|waiting/i.test(l));
    if (stale.length)
      throw new Error(`sessions still shown online after their CLI exited:\n${stale.join("\n")}`);
  });

  if (flag("--manual")) {
    await step("manual", "Interactive two-terminal check", async () => {
      const a = makeRepo("m1");
      const b = makeRepo("m2");
      const p = manualPrompts(sessionName("claude", a), sessionName("claude", b));
      console.log("\nOpen two terminals.");
      console.log(`Terminal 1:  cd "${a}" && claude`);
      console.log(`Terminal 2:  cd "${b}" && claude`);
      console.log("\nPaste in terminal 1, one at a time:");
      for (const t of p.terminal1) console.log(`  > ${t}`);
      console.log("\nThen in terminal 2:");
      for (const t of p.terminal2) console.log(`  > ${t}`);
      console.log("\nExpected:");
      for (const t of p.expect) console.log(`  - ${t}`);
      const ans = await ask("\nPress Enter when done (or type skip): ");
      if (ans === null) return { skip: "no terminal to wait on; prompts printed above" };
      if (ans === "skip") return { skip: "skipped by user" };
      const rows = dbRows(NONCE);
      const manualRows = rows.filter((r) => r.kind === "text");
      if (manualRows.length === 0) throw new Error("no message with the nonce reached the daemon");
      const states = manualRows.map((r) => r.state);
      const hookDelivered = states.some((s) => s === "delivered" || s === "read" || s === "acked");
      return { detail: `states: ${states.join(", ")}`, data: { rows: manualRows, hookDelivered } };
    });
  }
} finally {
  // Always undo what init did, also when init or a pair failed: a failed init may have left
  // files changed. Its own step, so the report shows whether the cleanup worked.
  if (initAttempted && !flag("--keep-installed")) {
    await step(
      "uninstall",
      "daemon stop, conveno uninstall --yes, then doctor shows CLIs not configured",
      () => {
        const stop = conveno("daemon", "stop");
        const r = conveno("uninstall", "--yes");
        if (r.code !== 0)
          throw new Error(`uninstall failed (${r.code}): ${(r.err || r.out).slice(0, 500)}`);
        removeMarker(MARKER);
        const d = conveno("doctor");
        return {
          detail: "uninstalled",
          data: {
            daemonStop: stop.out.slice(0, 500),
            uninstall: r.out.slice(0, 2000),
            doctor: d.out.slice(0, 2000),
          },
        };
      },
    );
  }
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  save();
}
const bad = steps.filter((s) => s.status === "fail");
console.log(
  `\nDone: ${report.summary.pass} passed, ${report.summary.fail} failed, ${report.summary.skip} skipped. Report: ${REPORT}`,
);
for (const s of bad) console.log(`  FAIL ${s.id}: ${s.detail.split("\n")[0]}`);
process.exit(bad.length ? 1 : 0);
