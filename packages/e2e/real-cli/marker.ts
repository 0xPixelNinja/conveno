// Run marker for the real-CLI check. Plain erasable TypeScript: run.mjs loads it through Node's
// type stripping, and the unit tests import it directly.
//
// A run that is killed with SIGKILL (for example by a low-memory reaper) skips its `finally` block,
// so Conveno stays installed. The marker is written before `conveno init` and removed after
// `conveno uninstall` succeeds. If one is found at the start of a run, the earlier run did not clean up.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RunMarker {
  nonce: string;
  pid: number;
  startedAt: string;
  platform: string;
  targets: string[];
  conveno: string;
}

/** What `readMarker` found. A file that cannot be parsed still counts as a marker. */
export type MarkerState =
  | { kind: "none" }
  | { kind: "found"; marker: RunMarker }
  | { kind: "unreadable"; raw: string };

export const MARKER_NAME = "real-cli-run.json";

/** The marker lives in Conveno's data directory, which `conveno uninstall` leaves alone. */
export const markerPath = (dataDir: string): string => join(dataDir, MARKER_NAME);

export function writeMarker(path: string, marker: RunMarker): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

export function readMarker(path: string): MarkerState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw e;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { kind: "found", marker: value as RunMarker };
    }
  } catch {
    // reported as unreadable below
  }
  return { kind: "unreadable", raw: raw.slice(0, 500) };
}

export function removeMarker(path: string): void {
  rmSync(path, { force: true });
}

/** Plain-language lines that tell the user what the earlier run left behind. */
export function describeMarker(path: string, state: MarkerState): string[] {
  const head = `An earlier real-CLI run did not clean up (marker: ${path}).`;
  if (state.kind === "unreadable") {
    return [head, `The marker could not be read. Its start: ${state.raw}`];
  }
  if (state.kind !== "found") return [];
  const m = state.marker;
  return [
    head,
    `  started   ${m.startedAt} (pid ${m.pid}, ${m.platform})`,
    `  nonce     ${m.nonce}`,
    `  CLIs      ${Array.isArray(m.targets) ? m.targets.join(", ") : "unknown"}`,
    "Conveno may still be installed in those CLIs. Cleaning up forgets that run's test sessions, then runs `conveno daemon stop` and `conveno uninstall --yes`.",
  ];
}

/**
 * Pattern for the sessions one run created. Its temporary repos are named `conveno-real-<label>-<id>`,
 * where `<id>` is the nonce without its `cvn-` prefix, and a session is named `<cli>@<repo name>-<n>`.
 */
export const sessionPattern = (nonce: string): string =>
  `*@conveno-real-*-${nonce.replace(/^cvn-/, "")}-*`;

/** Arguments for `conveno` that forget one run's sessions. They must be offline; live ones are skipped. */
export const forgetArgs = (nonce: string): string[] => ["forget", sessionPattern(nonce), "--yes"];

export interface CommandResult {
  code: number;
  out: string;
  err: string;
}

export interface CleanupDeps {
  markerFile: string;
  /** Run conveno with these arguments. */
  conveno(...args: string[]): CommandResult;
  /** `--approve-init` was given. */
  approved: boolean;
  /** Ask the user a yes/no question. Null when there is no terminal. */
  ask(question: string): Promise<string | null>;
  log(line: string): void;
}

/**
 * What happened to a marker left by an earlier run:
 * - `none`: no marker, nothing to do.
 * - `cleaned`: Conveno was stopped and uninstalled, and the marker removed.
 * - `no-approval`: no terminal and no `--approve-init`; nothing was changed.
 * - `declined`: the user said no; nothing was changed.
 * - `failed`: a cleanup command failed; the marker stays so the next run tries again.
 */
export type CleanupOutcome = "none" | "cleaned" | "no-approval" | "declined" | "failed";

/**
 * Clean up after an earlier run, under the same approval rules as `conveno init`: forget its test
 * sessions, stop the daemon, uninstall.
 */
export async function cleanupStale(deps: CleanupDeps): Promise<CleanupOutcome> {
  const state = readMarker(deps.markerFile);
  if (state.kind === "none") return "none";
  for (const line of describeMarker(deps.markerFile, state)) deps.log(line);

  if (!deps.approved) {
    const answer = await deps.ask(
      "Clean up now (forget its sessions, daemon stop, uninstall --yes)? [y/N] ",
    );
    if (answer === null) {
      deps.log(
        "No terminal and no --approve-init. Nothing was changed. Re-run with --approve-init to clean up.",
      );
      return "no-approval";
    }
    if (answer !== "y" && answer !== "yes") {
      deps.log("Not approved. Nothing was changed.");
      return "declined";
    }
  }

  // Forgetting needs the daemon, so it comes before `daemon stop`. Like `daemon stop` it is best
  // effort: with no daemon there is nothing to forget, and only uninstall decides the outcome.
  if (state.kind === "found" && typeof state.marker.nonce === "string") {
    const forget = deps.conveno(...forgetArgs(state.marker.nonce));
    deps.log(`forget the earlier run's sessions: exit ${forget.code}`);
  }
  const stop = deps.conveno("daemon", "stop");
  deps.log(`daemon stop: exit ${stop.code}`);
  const un = deps.conveno("uninstall", "--yes");
  if (un.code !== 0) {
    deps.log(`uninstall failed (${un.code}): ${(un.err || un.out).slice(0, 400)}`);
    return "failed";
  }
  removeMarker(deps.markerFile);
  deps.log("Cleaned up the earlier run.");
  return "cleaned";
}
