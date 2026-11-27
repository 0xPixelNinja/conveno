import type { Theme } from "@0xpixelninja/conveno-brand";
import type { DeliveryTier, Session } from "@0xpixelninja/conveno-protocol";
import { type Ctx, connectOpts } from "./ctx.js";
import { cmd, columns, plural, tilde, warnBlock } from "./fmt.js";

const CLI_SHORT: Record<string, string> = {
  claude: "cl",
  codex: "cx",
  opencode: "oc",
  antigravity: "ag",
  cursor: "cu",
  copilot: "cp",
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local `HH:MM:SS`, with the date in front when it is not today. */
export function stamp(iso: string, now: Date): string {
  const d = new Date(iso);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  return day === today ? time : `${day} ${time}`;
}

export function tierText(theme: Theme, tier: DeliveryTier): string {
  switch (tier) {
    case "live":
      return theme.paint("entry", "live");
    case "next_turn":
      return "next turn";
    case "acp":
      return "ACP";
    case "inbox":
      return theme.paint("quiet", "inbox");
  }
}

function stateCell(theme: Theme, s: Session): { glyph: string; word: string } {
  if (s.status === "offline") return { glyph: theme.status("offline"), word: "offline" };
  if (s.status === "waiting_on_question")
    return { glyph: theme.status("waiting"), word: "waiting" };
  if (s.isOrchestrator) return { glyph: theme.status("orchestrator"), word: s.status };
  if (s.status === "busy") return { glyph: theme.status("busy"), word: "busy" };
  return { glyph: theme.status("idle"), word: "idle" };
}

/** Sessions grouped by repository, the way brand/components/terminal.md lays them out. */
export function renderSessions(ctx: Ctx, sessions: Session[]): string {
  const t = ctx.theme;
  const now = ctx.now();
  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.repo?.root ?? s.cwd;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const blocks: string[] = [];
  for (const key of [...groups.keys()].sort()) {
    const list = (groups.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const q = (w: string) => t.paint("quiet", w);
    const head = [`  ${q("SESSION")}`, q("CLI"), q("TIER"), q("STATE"), q("LAST SEEN")];
    const rows = list.map((s) => {
      const st = stateCell(t, s);
      return [
        `${st.glyph} ${t.bold(s.name)}`,
        CLI_SHORT[s.cli] ?? s.cli,
        tierText(t, s.deliveryTier),
        st.word,
        t.paint("quiet", stamp(s.lastSeenAt, now)),
        ...(s.isOrchestrator ? [t.paint("entry", "orchestrator")] : []),
      ];
    });
    const lines = columns([head, ...rows]);
    const [headLine, ...rowLines] = lines;
    blocks.push(
      [`  ${t.bold(tilde(key, ctx.home))}`, `  ${headLine}`, ...rowLines.map((l) => `  ${l}`)].join(
        "\n",
      ),
    );
  }
  return blocks.join("\n\n");
}

export async function runStatus(ctx: Ctx): Promise<number> {
  const t = ctx.theme;
  let client: Awaited<ReturnType<Ctx["connect"]>>;
  try {
    client = await ctx.connect(connectOpts(ctx, false));
  } catch {
    ctx.err(
      warnBlock(
        t,
        "The Conveno daemon is not running.",
        `Run ${cmd(t, "conveno daemon start")}, or open a supported CLI after ${cmd(t, "conveno init")}.`,
        "Sessions are listed by the daemon, and nothing is listening on its socket.",
      ),
    );
    return 0;
  }
  try {
    const { sessions } = await client["session.list"]({ includeOffline: true });
    const repos = new Set(sessions.map((s) => s.repo?.root ?? s.cwd)).size;
    ctx.out(
      `${t.status("ok")} daemon up ${t.glyph("bullet")} ${plural(sessions.length, "session")}\n`,
    );
    if (sessions.length === 0) {
      ctx.out(
        `\nNo sessions yet. Open a supported CLI after ${cmd(t, "conveno init")} and it appears here.\n`,
      );
      return 0;
    }
    ctx.out(`\n${renderSessions(ctx, sessions)}\n\n`);
    ctx.out(`${plural(sessions.length, "session")} in ${plural(repos, "repo")}\n`);
    return 0;
  } finally {
    await client.close().catch(() => undefined);
  }
}
