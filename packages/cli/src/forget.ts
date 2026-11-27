import { SessionNamePattern } from "@conveno/protocol";
import { COMMANDS, parseFlags } from "./args.js";
import { type Ctx, connectOpts } from "./ctx.js";
import { daemonProblem } from "./daemonError.js";
import { cmd, columns, fail, plural } from "./fmt.js";
import { renderSessions } from "./status.js";

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `30m`, `24h` or `7d` as milliseconds, or undefined when the text is anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d{1,6})([mhd])$/.exec(text);
  if (!m) return undefined;
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  return ms > 0 ? ms : undefined;
}

/** Rebuild the command line the user typed, for the "run it again with --yes" hint. */
function rerunLine(names: string[], flags: { offline: boolean; olderThan?: string }): string {
  const quoted = names.map((n) => (n.includes("*") ? `'${n}'` : n));
  return [
    "conveno forget",
    ...quoted,
    ...(flags.offline ? ["--offline"] : []),
    ...(flags.olderThan ? ["--older-than", flags.olderThan] : []),
  ].join(" ");
}

export async function runForget(ctx: Ctx, argv: string[]): Promise<number> {
  const t = ctx.theme;
  const spec = COMMANDS.find((c) => c.name === "forget");
  if (!spec) return 2;
  const parsed = parseFlags(ctx, spec, argv);
  if (typeof parsed === "number") return parsed;
  const names = parsed.positionals;
  const offline = parsed.values.offline === true;
  const olderThan =
    typeof parsed.values["older-than"] === "string" ? parsed.values["older-than"] : undefined;
  const dryRun = parsed.values["dry-run"] === true;
  const yes = parsed.values.yes === true;
  const help = `Run ${cmd(t, "conveno forget --help")} to see the options.`;

  for (const n of names) {
    if (!SessionNamePattern.safeParse(n).success) {
      return fail(ctx, {
        what: `"${n}" is not a session name or pattern`,
        detail: [
          'Names use lowercase letters, digits and ".", "_", "@" or "-". A "*" matches any run of characters.',
        ],
        fix: `Run ${cmd(t, "conveno status --all")} to see the names.`,
        exit: 2,
        ref: "e_usage",
      });
    }
  }
  let olderThanMs: number | undefined;
  if (olderThan !== undefined) {
    olderThanMs = parseDuration(olderThan);
    if (olderThanMs === undefined) {
      return fail(ctx, {
        what: `"${olderThan}" is not a duration`,
        detail: ["Use a whole number and a unit: 30m for minutes, 24h for hours, 7d for days."],
        fix: help,
        exit: 2,
        ref: "e_usage",
      });
    }
  }
  if (names.length === 0 && !offline && olderThanMs === undefined) {
    return fail(ctx, {
      what: "conveno forget needs to know which sessions to forget",
      detail: ["Name them, or pass --offline for every offline session."],
      fix: `For example ${cmd(t, "conveno forget 'conveno-real-*'")} or ${cmd(t, "conveno forget --offline --older-than 7d")}.`,
      exit: 2,
      ref: "e_usage",
    });
  }

  let client: Awaited<ReturnType<Ctx["connect"]>>;
  try {
    client = await ctx.connect(connectOpts(ctx, false));
  } catch (e) {
    const problem = daemonProblem(t, e);
    return fail(ctx, {
      what: problem.notRunning
        ? "The Conveno daemon is not running"
        : "The Conveno daemon cannot be reached",
      detail: [
        problem.notRunning
          ? "Sessions live in the daemon, so there is nothing to forget until it runs."
          : problem.why,
      ],
      fix: problem.notRunning ? `Run ${cmd(t, "conveno daemon start")}.` : problem.fix,
      exit: 1,
      ref: "e_daemon",
    });
  }
  try {
    // Ask the daemon what matches without changing anything, then forget exactly that list.
    const selector = {
      ...(names.length > 0 ? { names } : {}),
      // Offline sessions only, of any age, unless an age was given.
      ...(names.length === 0 || olderThanMs !== undefined ? { olderThanMs: olderThanMs ?? 0 } : {}),
    };
    const preview = await client["session.forget"]({ ...selector, dryRun: true });
    const ids = new Set(preview.forgotten.map((s) => s.id));
    const all = (await client["session.list"]({ includeOffline: true })).sessions;
    const picked = all.filter((s) => ids.has(s.id));

    if (preview.skippedOnline.length > 0) {
      ctx.out(
        `${t.status("warn")} ${t.bold(`Skipped ${plural(preview.skippedOnline.length, "online session")}`)}\n`,
      );
      ctx.out(
        `${columns(
          preview.skippedOnline.map((s) => [
            `  ${t.status("idle")} ${t.bold(s.name)}`,
            t.paint("quiet", "online, a running session is never forgotten"),
          ]),
        ).join("\n")}\n\n`,
      );
    }
    if (picked.length === 0) {
      ctx.out(
        `${t.status("info")} Nothing to forget. ${t.paint("quiet", `${cmd(t, "conveno status --all")} lists the offline sessions.`)}\n`,
      );
      return 0;
    }

    ctx.out(
      `${t.bold(dryRun ? `Would forget ${plural(picked.length, "session")}` : `Will forget ${plural(picked.length, "session")}`)}\n\n`,
    );
    ctx.out(`${renderSessions(ctx, picked)}\n\n`);
    ctx.out(
      `  ${t.paint("quiet", "Their queued messages are deleted too. Messages they sent stay with the receivers.")}\n\n`,
    );

    if (dryRun) {
      ctx.out(`${t.status("info")} Dry run. Nothing was changed.\n`);
      return 0;
    }
    if (!yes) {
      if (!ctx.interactive) {
        return fail(ctx, {
          what: "Needs a terminal to confirm",
          detail: ["No sessions were forgotten."],
          fix: `Run ${cmd(t, `${rerunLine(names, { offline, ...(olderThan ? { olderThan } : {}) })} --yes`)} to forget the sessions listed above.`,
          exit: 2,
          ref: "e_no_tty",
        });
      }
      if (!(await ctx.confirm(`Forget ${plural(picked.length, "session")}?`, false))) {
        ctx.out(`${t.status("info")} Nothing was changed.\n`);
        return 0;
      }
    }

    const done = await client["session.forget"]({ ids: [...ids] });
    ctx.out(
      `${t.status("ok")} ${t.bold("Done.")} Forgot ${plural(done.forgotten.length, "session")}.\n`,
    );
    return 0;
  } finally {
    await client.close().catch(() => undefined);
  }
}
