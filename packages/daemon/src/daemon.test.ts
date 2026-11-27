import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clientProof, daemonProof, newAuthNonce } from "@conveno/core";
import { PROTOCOL_VERSION, RpcErrorCode } from "@conveno/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonAlreadyRunningError } from "./lifecycle.js";
import { startDaemon } from "./server.js";
import { MIGRATIONS, Store } from "./store.js";
import { type Harness, RawClient, register, startHarness } from "./test-utils.js";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

const text = (to: string, sessionId: string, body = "hi", extra: Record<string, unknown> = {}) => ({
  sessionId,
  to,
  kind: "text",
  body: { text: body },
  ...extra,
});

describe("handshake and auth", () => {
  const hello = (c: RawClient, nonce = newAuthNonce(), over: Record<string, unknown> = {}) =>
    c.rpc("hello", { protocolVersion: PROTOCOL_VERSION, client: "mcp", nonce, ...over });

  it("answers hello with a proof of the token and a fresh challenge", async () => {
    const c = await h.client();
    const nonce = newAuthNonce();
    const r = await hello(c, nonce);
    expect(r.result?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.result?.daemonVersion).toBe("0.1.0");
    expect(r.result?.proof).toBe(daemonProof(h.token(), nonce));
    expect(r.result?.challenge).toMatch(/^[0-9a-f]{64}$/);
    const other = await hello(await h.client());
    expect(other.result?.challenge).not.toBe(r.result?.challenge);
  });

  it("never sees or reveals the token on the wire", async () => {
    const c = await h.client();
    const r = await hello(c);
    expect(JSON.stringify(r)).not.toContain(h.token());
  });

  it("lets a client with the right proof in, and only then", async () => {
    const c = await h.client();
    const r = await hello(c);
    expect((await c.rpc("session.list", {})).error?.code).toBe(RpcErrorCode.Unauthorized);
    const ok = await c.rpc("auth", { proof: clientProof(h.token(), r.result?.challenge) });
    expect(ok.result).toEqual({ ok: true });
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("rejects a wrong proof with Unauthorized and closes the connection", async () => {
    const c = await h.client();
    await hello(c);
    const r = await c.rpc("auth", { proof: clientProof("not the token", "ab".repeat(32)) });
    expect(r.error?.code).toBe(RpcErrorCode.Unauthorized);
    await c.waitClosed();
  });

  it("rejects a proof for another challenge", async () => {
    const c = await h.client();
    await hello(c);
    const r = await c.rpc("auth", { proof: clientProof(h.token(), "cd".repeat(32)) });
    expect(r.error?.code).toBe(RpcErrorCode.Unauthorized);
  });

  it("rejects auth before hello", async () => {
    const c = await h.client();
    const r = await c.rpc("auth", { proof: "ab".repeat(32) });
    expect(r.error?.code).toBe(RpcErrorCode.Unauthorized);
  });

  it("rejects an unsupported protocol version with VersionMismatch", async () => {
    const c = await h.client();
    const r = await hello(c, newAuthNonce(), { protocolVersion: "conveno/99" });
    expect(r.error?.code).toBe(RpcErrorCode.VersionMismatch);
    expect(r.error?.message).toContain("conveno/1");
  });

  it("closes a connection that does not finish the handshake in time", async () => {
    await h.stop();
    h = await startHarness({ authTimeoutMs: 150 });
    const c = await h.client();
    await c.waitClosed();
  });

  it("keeps a connection that finished the handshake open past the handshake timeout", async () => {
    await h.stop();
    h = await startHarness({ authTimeoutMs: 150 });
    const c = await h.authed();
    await new Promise((r) => setTimeout(r, 400));
    expect(c.closed).toBe(false);
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("answers every method but hello and auth with Unauthorized before the handshake", async () => {
    const c = await h.client();
    for (const [method, params] of [
      ["session.list", {}],
      ["session.register", { cli: "claude", cwd: "/x" }],
      ["no.such.method", {}],
      ["ticket.create", {}],
    ] as const) {
      const r = await c.rpc(method, params);
      expect(r.error?.code, method).toBe(RpcErrorCode.Unauthorized);
    }
  });

  it("creates the token file with mode 0600 and keeps it across restarts", async () => {
    const before = h.token();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== "win32") {
      expect(statSync(join(h.dir, "daemon.token")).mode & 0o777).toBe(0o600);
    }
    await h.restart();
    expect(h.token()).toBe(before);
  });
});

describe("protocol errors", () => {
  it("reports invalid JSON for that line only and keeps the connection", async () => {
    const c = await h.authed();
    c.raw("{not json\n");
    expect((await c.nextReply()).error?.code).toBe(RpcErrorCode.ParseError);
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("rejects non-request JSON, notifications and bad envelopes with InvalidRequest", async () => {
    const c = await h.authed();
    c.raw('{"jsonrpc":"2.0","method":"session.list"}\n');
    expect((await c.nextReply()).error?.code).toBe(RpcErrorCode.InvalidRequest);
    c.raw("[1,2]\n");
    expect((await c.nextReply()).error?.code).toBe(RpcErrorCode.InvalidRequest);
    c.raw('{"jsonrpc":"1.0","id":5,"method":"session.list"}\n');
    const r = await c.nextReply();
    expect(r.error?.code).toBe(RpcErrorCode.InvalidRequest);
    expect(r.id).toBe(5);
  });

  it("rejects invalid params with InvalidParams and issue data", async () => {
    const c = await h.authed();
    const r = await c.rpc("session.register", { cli: "emacs", cwd: "/x" });
    expect(r.error?.code).toBe(RpcErrorCode.InvalidParams);
    expect(Array.isArray(r.error?.data)).toBe(true);
  });

  it("rejects an unknown method with MethodNotFound", async () => {
    const c = await h.authed();
    expect((await c.rpc("nope", {})).error?.code).toBe(RpcErrorCode.MethodNotFound);
  });

  it("returns MethodNotFound for ticket, spawn and peek methods", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    const sid = session.id;
    const calls: [string, Record<string, unknown>][] = [
      ["ticket.create", { sessionId: sid, question: "ok?" }],
      ["ticket.answer", { sessionId: sid, ticketId: "01J0000000000000000000000A", response: "y" }],
      ["spawn.request", { sessionId: sid, cli: "claude", prompt: "go" }],
      ["peek.request", { sessionId: sid, session: "claude@proj-1", mode: "recent" }],
    ];
    for (const [m, p] of calls) {
      expect((await c.rpc(m, p)).error?.code, m).toBe(RpcErrorCode.MethodNotFound);
    }
  });

  it("answers a line over 1 MiB with one error and resyncs at the next line", async () => {
    const c = await h.authed();
    c.raw(`${"x".repeat(1024 * 1024 + 10)}\n`);
    const r = await c.nextReply();
    expect(r.error?.code).toBe(RpcErrorCode.InvalidRequest);
    expect(r.error?.message).toContain("1 MiB");
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("handles requests split across chunks and several per chunk", async () => {
    const c = await h.authed();
    const line = '{"jsonrpc":"2.0","id":"a","method":"session.list"}\n';
    c.raw(line.slice(0, 10));
    await new Promise((r) => setTimeout(r, 20));
    c.raw(line.slice(10) + line.replace('"a"', '"b"'));
    const first = await c.nextReply();
    const second = await c.nextReply();
    expect([first.id, second.id]).toEqual(["a", "b"]);
  });
});

describe("sessions", () => {
  it("assigns names <cli>@<basename>-<n> with the lowest free n", async () => {
    const c = await h.authed();
    const cwd = join(tmpdir(), "My Project");
    const a = await register(c, { cwd });
    const b = await register(c, { cwd });
    const x = await register(c, { cwd, cli: "codex" });
    expect(a.session.name).toBe("claude@my-project-1");
    expect(b.session.name).toBe("claude@my-project-2");
    expect(x.session.name).toBe("codex@my-project-1");
    await c.call("session.unregister", { sessionId: a.session.id });
    const again = await register(c, { cwd });
    expect(again.session.name).toBe("claude@my-project-1");
  });

  it("uses the git root basename when cwd is inside a repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "convenod-repo-"));
    try {
      const repo = join(root, "api");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "src", "deep"), { recursive: true });
      const c = await h.authed();
      const { session } = await register(c, { cwd: join(repo, "src", "deep") });
      expect(session.name).toBe("claude@api-1");
      expect(session.repo.root).toBe(repo);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a full wire session on register", async () => {
    const c = await h.authed();
    const { session } = await register(c, {
      cli: "opencode",
      cliVersion: "1.2.3",
      pid: 4001,
      hostPids: [4000, 3999],
    });
    expect(session).toMatchObject({
      cli: "opencode",
      cliVersion: "1.2.3",
      status: "idle",
      isOrchestrator: false,
      deliveryTier: "inbox",
      spawnDepth: 0,
      pid: 4001,
      hostPids: [4000, 3999],
      startedAt: "2026-11-27T09:00:00.000Z",
      lastSeenAt: "2026-11-27T09:00:00.000Z",
    });
    expect(session.deviceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await register(c)).session.deliveryTier).toBe("next_turn");
  });

  it("honours a requested name and rejects a clash with Conflict", async () => {
    const c = await h.authed();
    expect((await register(c, { name: "alpha" })).session.name).toBe("alpha");
    const r = await c.rpc("session.register", { cli: "claude", cwd: "/x", name: "alpha" });
    expect(r.error?.code).toBe(RpcErrorCode.Conflict);
  });

  it("renames, rejects clashes and keeps the old name when it fails", async () => {
    const c = await h.authed();
    const a = (await register(c, { name: "alpha" })).session;
    await register(c, { name: "beta" });
    expect((await c.call("session.rename", { sessionId: a.id, name: "gamma" })).session.name).toBe(
      "gamma",
    );
    const clash = await c.rpc("session.rename", { sessionId: a.id, name: "beta" });
    expect(clash.error?.code).toBe(RpcErrorCode.Conflict);
    const reserved = await c.rpc("session.rename", { sessionId: a.id, name: "orchestrator" });
    expect(reserved.error?.code).toBe(RpcErrorCode.InvalidParams);
    expect((await c.call("session.list", {})).sessions.map((s: any) => s.name)).toContain("gamma");
  });

  it("sets and clears status text, rejects status offline", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    let r = await c.call("session.setStatus", {
      sessionId: session.id,
      status: "busy",
      statusText: "running tests",
    });
    expect(r.session).toMatchObject({ status: "busy", statusText: "running tests" });
    r = await c.call("session.setStatus", { sessionId: session.id, statusText: null });
    expect(r.session.status).toBe("busy");
    expect(r.session.statusText).toBeUndefined();
    const bad = await c.rpc("session.setStatus", { sessionId: session.id, status: "offline" });
    expect(bad.error?.code).toBe(RpcErrorCode.InvalidParams);
    const none = await c.rpc("session.setStatus", { sessionId: session.id });
    expect(none.error?.code).toBe(RpcErrorCode.InvalidParams);
  });

  it("strips control characters and extra whitespace from status text", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    const r = await c.call("session.setStatus", {
      sessionId: session.id,
      statusText: "  fixing\nbug\u0000  \u001b[31mred\r\n\tdone  ",
    });
    expect(r.session.statusText).toBe("fixing bug [31mred done");
    const blank = await c.call("session.setStatus", { sessionId: session.id, statusText: " \n " });
    expect(blank.session.statusText).toBeUndefined();
    const long = await c.rpc("session.setStatus", {
      sessionId: session.id,
      statusText: "x".repeat(201),
    });
    expect(long.error?.code).toBe(RpcErrorCode.InvalidParams);
  });

  it.each(["conveno", "orchestrator", "system", "user"])(
    "refuses the reserved name %s on register and rename with a plain message",
    async (name) => {
      const c = await h.authed();
      const reg = await c.rpc("session.register", { cli: "claude", cwd: "/x", name });
      expect(reg.error?.code).toBe(RpcErrorCode.InvalidParams);
      expect(reg.error?.message).toContain("reserved");
      const { session } = await register(c);
      const ren = await c.rpc("session.rename", { sessionId: session.id, name });
      expect(ren.error?.code).toBe(RpcErrorCode.InvalidParams);
      expect(ren.error?.message).toContain("reserved");
    },
  );

  it("lists with repo, cli and includeOffline filters", async () => {
    const c = await h.authed();
    const a = (await register(c, { cwd: join(tmpdir(), "one") })).session;
    await register(c, { cwd: join(tmpdir(), "two"), cli: "codex" });
    const gone = (await register(c, { cwd: join(tmpdir(), "one") })).session;
    await c.call("session.unregister", { sessionId: gone.id });
    const names = async (p: Record<string, unknown>) =>
      (await c.call("session.list", p)).sessions.map((s: any) => s.name);
    expect(await names({})).toEqual(["claude@one-1", "codex@two-1"]);
    expect(await names({ repo: "one" })).toEqual([a.name]);
    expect(await names({ repo: join(tmpdir(), "two") })).toEqual([]);
    expect(await names({ cli: "codex" })).toEqual(["codex@two-1"]);
    expect(await names({ includeOffline: true })).toHaveLength(3);
  });

  describe("session.byHost", () => {
    const byHost = async (c: RawClient, pids: number[]) =>
      (await c.call("session.byHost", { pids })).session as { id: string } | null;

    it("matches the first pid of the chain that any online session lists", async () => {
      const c = await h.authed();
      expect(await byHost(c, [777])).toBeNull();
      // Windows shape: the MCP server sits behind cmd.exe (900), the CLI is 800, its shell 700.
      const claude = (await register(c, { hostPids: [900, 800, 700] })).session;
      // The hook sits behind its own cmd.exe (901): the CLI (800) is the nearest shared ancestor.
      expect((await byHost(c, [901, 800, 700]))?.id).toBe(claude.id);
      expect((await byHost(c, [800]))?.id).toBe(claude.id);
      expect(await byHost(c, [555, 666])).toBeNull();
    });

    it("returns null when two sessions share the nearest matching pid", async () => {
      const c = await h.authed();
      await register(c, { hostPids: [900, 800, 700] });
      await register(c, { hostPids: [910, 800, 700] });
      expect(await byHost(c, [999, 800, 700])).toBeNull();
    });

    it("does not fall through to a farther pid after an ambiguous one", async () => {
      const c = await h.authed();
      await register(c, { hostPids: [900, 800, 100] });
      await register(c, { hostPids: [910, 800, 200] });
      const only = (await register(c, { hostPids: [920, 810, 700] })).session;
      // 800 is shared by two sessions: ambiguous, so the unique 700 is not tried.
      expect(await byHost(c, [800, 700])).toBeNull();
      expect((await byHost(c, [810, 700]))?.id).toBe(only.id);
    });

    it("prefers a nearer unique match over a farther shared one", async () => {
      const c = await h.authed();
      const a = (await register(c, { hostPids: [900, 800, 700] })).session;
      await register(c, { hostPids: [910, 810, 700] });
      expect((await byHost(c, [900, 700]))?.id).toBe(a.id);
      expect(await byHost(c, [700])).toBeNull();
    });

    it("ignores offline sessions, so a stale shared pid does not make a match ambiguous", async () => {
      const c = await h.authed();
      const old = (await register(c, { hostPids: [900, 800] })).session;
      const live = (await register(c, { hostPids: [910, 800] })).session;
      expect(await byHost(c, [800])).toBeNull();
      await c.call("session.unregister", { sessionId: old.id });
      expect((await byHost(c, [800]))?.id).toBe(live.id);
      await c.call("session.unregister", { sessionId: live.id });
      expect(await byHost(c, [800])).toBeNull();
    });

    it("reports a session without host pids as unmatched, and keeps hostPids in order", async () => {
      const c = await h.authed();
      const none = (await register(c)).session;
      expect(none.hostPids).toBeUndefined();
      const chained = (await register(c, { hostPids: [30, 20, 10] })).session;
      expect(chained.hostPids).toEqual([30, 20, 10]);
      expect(
        (await c.call("session.list", {})).sessions.find((s: any) => s.id === chained.id)?.hostPids,
      ).toEqual([30, 20, 10]);
    });

    it("rejects an empty or too long chain", async () => {
      const c = await h.authed();
      expect((await c.rpc("session.byHost", { pids: [] })).error?.code).toBe(
        RpcErrorCode.InvalidParams,
      );
      expect(
        (await c.rpc("session.byHost", { pids: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).error?.code,
      ).toBe(RpcErrorCode.InvalidParams);
      expect(
        (await c.rpc("session.register", { cli: "claude", cwd: "/x", hostPids: [] })).error?.code,
      ).toBe(RpcErrorCode.InvalidParams);
    });
  });

  it("only the nearest host pid decides liveness; farther ancestors may outlive the CLI", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPids: [5101, 5102, 5103] })).session;
    h.dead.add(5102);
    h.dead.add(5103);
    h.daemon.sweep();
    expect((await c.call("session.list", {})).sessions.map((s: any) => s.id)).toEqual([a.id]);
    h.dead.add(5101);
    h.daemon.sweep();
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("heartbeat updates lastSeenAt; unknown sessions are NotFound", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    h.clock.ms += 10_000;
    expect((await c.call("session.heartbeat", { sessionId: session.id })).lastSeenAt).toBe(
      "2026-11-27T09:00:10.000Z",
    );
    const r = await c.rpc("session.heartbeat", { sessionId: "01J0000000000000000000000A" });
    expect(r.error?.code).toBe(RpcErrorCode.NotFound);
  });

  it("unregister marks the session offline and is idempotent", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    expect(await c.call("session.unregister", { sessionId: session.id })).toEqual({ ok: true });
    expect(await c.call("session.unregister", { sessionId: session.id })).toEqual({ ok: true });
    const all = (await c.call("session.list", { includeOffline: true })).sessions;
    expect(all[0].status).toBe("offline");
  });
});

describe("orchestrator", () => {
  it("claims the role, flags the session and sends a granted system message", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    expect(await c.call("orchestrator.claim", { sessionId: a.id })).toEqual({
      orchestrator: a.id,
      previous: null,
    });
    const listed = (await c.call("session.list", {})).sessions[0];
    expect(listed.isOrchestrator).toBe(true);
    const inbox = await c.call("message.inbox", { sessionId: a.id });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]).toMatchObject({
      kind: "system",
      body: { event: "orchestrator.granted" },
    });
    expect(inbox.messages[0].fromName).toBeUndefined();
  });

  it("hands over: new holder granted, previous holder revoked, exactly one holder", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    const r = await c.call("orchestrator.claim", { sessionId: b.id });
    expect(r).toEqual({ orchestrator: b.id, previous: a.id });
    const flags = (await c.call("session.list", {})).sessions.map((s: any) => s.isOrchestrator);
    expect(flags).toEqual([false, true]);
    const aMsgs = (await c.call("message.inbox", { sessionId: a.id, unreadOnly: false })).messages;
    expect(aMsgs.map((m: any) => m.body.event)).toEqual([
      "orchestrator.granted",
      "orchestrator.revoked",
    ]);
    expect(aMsgs[1].body.detail).toContain(b.name);
    const bMsgs = (await c.call("message.inbox", { sessionId: b.id })).messages;
    expect(bMsgs).toHaveLength(1);
    expect(bMsgs[0].body.detail).toContain(a.name);
  });

  it("claiming while already the holder changes nothing", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    await c.call("message.inbox", { sessionId: a.id });
    expect(await c.call("orchestrator.claim", { sessionId: a.id })).toEqual({
      orchestrator: a.id,
      previous: null,
    });
    expect((await c.call("message.inbox", { sessionId: a.id })).messages).toEqual([]);
  });

  it("routes messages to orchestrator to whoever holds the role", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    const s = (await register(c)).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    const first = await c.call("message.send", text("orchestrator", s.id, "one"));
    expect(first.deliveredTo).toEqual({ id: a.id, name: a.name });
    await c.call("orchestrator.claim", { sessionId: b.id });
    const second = await c.call("message.send", text("orchestrator", s.id, "two"));
    expect(second.deliveredTo.id).toBe(b.id);
    expect(second.message.to).toBe("orchestrator");
  });

  it("fails with NotFound and the documented text when nobody holds the role", async () => {
    const c = await h.authed();
    const s = (await register(c)).session;
    const r = await c.rpc("message.send", text("orchestrator", s.id));
    expect(r.error?.code).toBe(RpcErrorCode.NotFound);
    expect(r.error?.message).toBe(
      "No session holds the orchestrator role. Run orchestrate in the session you want to use.",
    );
  });

  it("vacates the role when the holder unregisters, with no automatic pass", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    await c.call("session.unregister", { sessionId: a.id });
    const r = await c.rpc("message.send", text("orchestrator", b.id));
    expect(r.error?.code).toBe(RpcErrorCode.NotFound);
    expect(await c.call("orchestrator.claim", { sessionId: b.id })).toEqual({
      orchestrator: b.id,
      previous: null,
    });
  });

  it("rejects a claim from an unknown or offline session", async () => {
    const c = await h.authed();
    expect(
      (await c.rpc("orchestrator.claim", { sessionId: "01J0000000000000000000000A" })).error?.code,
    ).toBe(RpcErrorCode.NotFound);
    const a = (await register(c)).session;
    await c.call("session.unregister", { sessionId: a.id });
    expect((await c.rpc("orchestrator.claim", { sessionId: a.id })).error?.code).toBe(
      RpcErrorCode.NotFound,
    );
  });
});

describe("messages", () => {
  it("sends by name and by id, stamping sender name and cli", async () => {
    const c = await h.authed();
    const a = (await register(c, { name: "alpha", cli: "codex" })).session;
    const b = (await register(c, { name: "beta" })).session;
    const byName = await c.call("message.send", text("beta", a.id, "hello", { urgent: true }));
    expect(byName.deliveredTo).toEqual({ id: b.id, name: "beta" });
    expect(byName.delivery).toBe("next_turn");
    expect(byName.message).toMatchObject({
      from: a.id,
      to: "beta",
      kind: "text",
      urgent: true,
      fromName: "alpha",
      fromCli: "codex",
      createdAt: "2026-11-27T09:00:00.000Z",
    });
    const byId = await c.call("message.send", text(b.id, a.id, "again"));
    expect(byId.deliveredTo.id).toBe(b.id);
  });

  it("supports every message kind and replyTo", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    const t = await c.call("message.send", text(b.name, a.id));
    const handoff = await c.call("message.send", {
      sessionId: a.id,
      to: b.name,
      kind: "handoff",
      body: { goal: "g", state: "s", nextSteps: ["n"], filesTouched: ["f"] },
      replyTo: t.message.id,
    });
    expect(handoff.message.replyTo).toBe(t.message.id);
  });

  it("refuses client-sent system messages", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    const r = await c.rpc("message.send", {
      sessionId: a.id,
      to: b.name,
      kind: "system",
      body: { event: "x" },
    });
    expect(r.error?.code).toBe(RpcErrorCode.InvalidParams);
    expect(r.error?.message).toContain("Conveno daemon");
    expect((await c.call("message.inbox", { sessionId: b.id })).messages).toEqual([]);
  });

  it("checks that replyTo exists", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    const first = await c.call("message.send", text(b.name, a.id));
    const ok = await c.call(
      "message.send",
      text(b.name, a.id, "again", { replyTo: first.message.id }),
    );
    expect(ok.message.replyTo).toBe(first.message.id);
    const bad = await c.rpc(
      "message.send",
      text(b.name, a.id, "x", { replyTo: "01HZZZZZZZZZZZZZZZZZZZZZZZ" }),
    );
    expect(bad.error?.code).toBe(RpcErrorCode.NotFound);
    expect(bad.error?.message).toContain("01HZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("gives unknown, offline and missing recipients the documented errors", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c, { name: "beta" })).session;
    const unknown = await c.rpc("message.send", text("ghost", a.id));
    expect(unknown.error?.code).toBe(RpcErrorCode.NotFound);
    expect(unknown.error?.message).toBe(
      'No session named "ghost". Run list_sessions to see who is available.',
    );
    await c.call("session.unregister", { sessionId: b.id });
    const offline = await c.rpc("message.send", text("beta", a.id));
    expect(offline.error?.message).toBe(
      'Session "beta" is offline. Run list_sessions to see who is available.',
    );
    const byId = await c.rpc("message.send", text(b.id, a.id));
    expect(byId.error?.code).toBe(RpcErrorCode.NotFound);
  });

  it("refuses to send from an offline or unknown session", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c)).session;
    await c.call("session.unregister", { sessionId: a.id });
    expect((await c.rpc("message.send", text(b.name, a.id))).error?.code).toBe(
      RpcErrorCode.NotFound,
    );
    expect(
      (await c.rpc("message.send", text(b.name, "01J0000000000000000000000A"))).error?.code,
    ).toBe(RpcErrorCode.NotFound);
  });

  it("rejects an oversize text body", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const r = await c.rpc("message.send", text(a.name, a.id, "x".repeat(65_537)));
    expect(r.error?.code).toBe(RpcErrorCode.InvalidParams);
  });

  describe("deliver vs inbox", () => {
    let a: string;
    let b: string;
    let c: RawClient;
    beforeEach(async () => {
      c = await h.authed();
      a = (await register(c)).session.id;
      b = (await register(c)).session.id;
    });

    it("inbox returns messages in order, urgent first, and marks them read", async () => {
      await c.call("message.send", text(b, a, "one"));
      await c.call("message.send", text(b, a, "two", { urgent: true }));
      await c.call("message.send", text(b, a, "three"));
      const r = await c.call("message.inbox", { sessionId: b, limit: 2 });
      expect(r.messages.map((m: any) => m.body.text)).toEqual(["two", "one"]);
      expect(r.unreadCount).toBe(1);
      const rest = await c.call("message.inbox", { sessionId: b });
      expect(rest.messages.map((m: any) => m.body.text)).toEqual(["three"]);
      expect(rest.unreadCount).toBe(0);
      expect((await c.call("message.inbox", { sessionId: b })).messages).toEqual([]);
      const history = await c.call("message.inbox", { sessionId: b, unreadOnly: false });
      expect(history.messages).toHaveLength(3);
    });

    it("deliver returns undelivered messages once, urgent first, without marking them read", async () => {
      await c.call("message.send", text(b, a, "one"));
      await c.call("message.send", text(b, a, "two", { urgent: true }));
      await c.call("message.send", text(b, a, "three"));
      const d = await c.call("message.deliver", { sessionId: b, limit: 2 });
      expect(d.messages.map((m: any) => m.body.text)).toEqual(["two", "one"]);
      expect(d.remaining).toBe(1);
      const d2 = await c.call("message.deliver", { sessionId: b });
      expect(d2.messages.map((m: any) => m.body.text)).toEqual(["three"]);
      expect(d2.remaining).toBe(0);
      expect((await c.call("message.deliver", { sessionId: b })).messages).toEqual([]);
    });

    it("delivered messages are not unread: unreadOnly skips them, the full list still has them", async () => {
      await c.call("message.send", text(b, a, "one"));
      await c.call("message.deliver", { sessionId: b });
      const inbox = await c.call("message.inbox", { sessionId: b });
      expect(inbox.messages).toEqual([]);
      expect(inbox.unreadCount).toBe(0);
      const all = await c.call("message.inbox", { sessionId: b, unreadOnly: false });
      expect(all.messages.map((m: any) => m.body.text)).toEqual(["one"]);
    });

    it("returns every message of an oversize backlog over several calls, losing none", async () => {
      const total = 20;
      for (let i = 0; i < total; i++) {
        await c.call("message.send", text(b, a, `${i}`.padEnd(60_000, "x")));
      }
      const seen: string[] = [];
      let calls = 0;
      for (;;) {
        const r = await c.rpc("message.inbox", { sessionId: b, limit: 200 });
        expect(r.error).toBeUndefined();
        const batch = r.result.messages as any[];
        if (batch.length === 0) break;
        calls++;
        for (const m of batch) seen.push(m.body.text.slice(0, 2).trim());
        expect(r.result.unreadCount).toBe(total - seen.length);
      }
      expect(calls).toBeGreaterThan(1);
      expect(seen).toHaveLength(total);
      expect(new Set(seen).size).toBe(total);
    });

    it("deliver caps its response by size and reports what remains", async () => {
      const total = 20;
      for (let i = 0; i < total; i++) {
        await c.call("message.send", text(b, a, `${i}`.padEnd(60_000, "x")));
      }
      let got = 0;
      let calls = 0;
      for (;;) {
        const r = await c.rpc("message.deliver", { sessionId: b, limit: 200 });
        expect(r.error).toBeUndefined();
        if (r.result.messages.length === 0) break;
        calls++;
        got += r.result.messages.length;
        expect(r.result.remaining).toBe(total - got);
      }
      expect(calls).toBeGreaterThan(1);
      expect(got).toBe(total);
    });

    it("refuses a send when the recipient has 1000 unread messages", async () => {
      for (let i = 0; i < 1000; i++) await c.call("message.send", text(b, a, "x"));
      const r = await c.rpc("message.send", text(b, a, "one too many"));
      expect(r.error?.code).toBe(RpcErrorCode.LimitExceeded);
      expect(r.error?.message).toContain("too many unread messages");
      expect(r.error?.message).toContain((await c.call("session.list", {})).sessions[1].name);
      // Reading frees room.
      await c.call("message.inbox", { sessionId: b, limit: 200 });
      await c.call("message.send", text(b, a, "fits now"));
    }, 30_000);

    it("messages read through inbox are not delivered again", async () => {
      await c.call("message.send", text(b, a, "one"));
      await c.call("message.inbox", { sessionId: b });
      expect((await c.call("message.deliver", { sessionId: b })).messages).toEqual([]);
    });

    it("ack counts each message once and ignores unknown ids and other mailboxes", async () => {
      const m1 = (await c.call("message.send", text(b, a, "one"))).message.id;
      const m2 = (await c.call("message.send", text(b, a, "two"))).message.id;
      expect(
        await c.call("message.ack", { sessionId: b, ids: [m1, "01J0000000000000000000000A"] }),
      ).toEqual({ acked: 1 });
      expect(await c.call("message.ack", { sessionId: b, ids: [m1] })).toEqual({ acked: 0 });
      expect(await c.call("message.ack", { sessionId: a, ids: [m2] })).toEqual({ acked: 0 });
      const unread = await c.call("message.inbox", { sessionId: b });
      expect(unread.messages.map((m: any) => m.id)).toEqual([m2]);
      // An acked message is no longer unread and is not re-delivered.
      expect((await c.call("message.deliver", { sessionId: b })).messages).toEqual([]);
      const all = await c.call("message.inbox", { sessionId: b, unreadOnly: false });
      expect(all.messages).toHaveLength(2);
    });

    it("rejects an empty ack list and unknown sessions", async () => {
      expect((await c.rpc("message.ack", { sessionId: b, ids: [] })).error?.code).toBe(
        RpcErrorCode.InvalidParams,
      );
      expect(
        (await c.rpc("message.inbox", { sessionId: "01J0000000000000000000000A" })).error?.code,
      ).toBe(RpcErrorCode.NotFound);
      expect(
        (await c.rpc("message.deliver", { sessionId: "01J0000000000000000000000A" })).error?.code,
      ).toBe(RpcErrorCode.NotFound);
    });
  });
});

describe("events", () => {
  it("sends session, orchestrator and message notifications to subscribers", async () => {
    const watcher = await h.authed();
    const actor = await h.authed();
    const w = (await register(watcher)).session;
    const sub = await watcher.call("events.subscribe", { sessionId: w.id });
    expect(sub.subscribed).toEqual([
      "message.received",
      "ticket.created",
      "ticket.answered",
      "session.updated",
      "orchestrator.changed",
    ]);
    const x = (await register(actor)).session;
    await actor.call("message.send", text(w.name, x.id, "ping"));
    await actor.call("orchestrator.claim", { sessionId: x.id });
    await actor.call("session.rename", { sessionId: x.id, name: "renamed" });
    await actor.call("session.unregister", { sessionId: x.id });
    // registered, message, orchestrator granted msg to x (not w), changed, updated(x), updated(rename), unregistered...
    await watcher.waitForEvents(6);
    const evs = watcher.events;
    expect(evs[0]).toMatchObject({ event: "session.updated", data: { change: "registered" } });
    expect(evs[1]).toMatchObject({
      event: "message.received",
      data: { message: { body: { text: "ping" } } },
    });
    const names = evs.map((e) => e.event);
    expect(names).toContain("orchestrator.changed");
    expect(evs.some((e) => e.event === "session.updated" && e.data.change === "unregistered")).toBe(
      true,
    );
    // The orchestrator.granted system message went to x, not to the watcher.
    expect(
      evs.some((e) => e.event === "message.received" && e.data.message.kind === "system"),
    ).toBe(false);
  });

  it("honours topics and delivers a message only to its recipient's subscription", async () => {
    const a = await h.authed();
    const b = await h.authed();
    const sa = (await register(a)).session;
    const sb = (await register(b)).session;
    await a.call("events.subscribe", { sessionId: sa.id, topics: ["message.received"] });
    await b.call("events.subscribe", { sessionId: sb.id, topics: ["message.received"] });
    await a.call("message.send", text(sb.name, sa.id, "to b"));
    await b.waitForEvents(1);
    expect(b.events).toHaveLength(1);
    expect(a.events).toEqual([]);
    await a.call("session.setStatus", { sessionId: sa.id, status: "busy" });
    expect(a.events).toEqual([]);
  });

  it("stops notifying a closed connection and survives it", async () => {
    const a = await h.authed();
    const s = (await register(a)).session;
    await a.call("events.subscribe", { sessionId: s.id });
    a.close();
    await a.waitClosed();
    const b = await h.authed();
    await register(b);
    expect((await b.call("session.list", {})).sessions).toHaveLength(2);
  });

  it("rejects subscribing for an unknown session", async () => {
    const c = await h.authed();
    const r = await c.rpc("events.subscribe", { sessionId: "01J0000000000000000000000A" });
    expect(r.error?.code).toBe(RpcErrorCode.NotFound);
  });
});

describe("concurrent clients", () => {
  it("keeps names unique and loses no messages with many clients at once", async () => {
    const n = 12;
    const clients = await Promise.all(Array.from({ length: n }, () => h.authed()));
    const sessions = await Promise.all(
      clients.map((c) => register(c, { cwd: join(tmpdir(), "shared") })),
    );
    const names = sessions.map((s) => s.session.name);
    expect(new Set(names).size).toBe(n);
    const target = sessions[0]?.session.id as string;
    await Promise.all(
      clients.map((c, i) =>
        Promise.all(
          Array.from({ length: 5 }, (_, k) =>
            c.call("message.send", text(target, sessions[i]?.session.id as string, `m${i}-${k}`)),
          ),
        ),
      ),
    );
    const inbox = await (clients[0] as RawClient).call("message.inbox", {
      sessionId: target,
      limit: 200,
    });
    expect(inbox.messages).toHaveLength(n * 5);
    expect(new Set(inbox.messages.map((m: any) => m.id)).size).toBe(n * 5);
  });
});

describe("liveness", () => {
  it("marks a session offline 45 s after its last heartbeat", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    h.clock.ms += 44_000;
    h.daemon.sweep();
    expect((await c.call("session.list", {})).sessions).toHaveLength(1);
    h.clock.ms += 1_000;
    h.daemon.sweep();
    expect((await c.call("session.list", {})).sessions).toHaveLength(0);
    const all = (await c.call("session.list", { includeOffline: true })).sessions;
    expect(all[0]).toMatchObject({ id: session.id, status: "offline" });
  });

  it("heartbeats keep a session online", async () => {
    const c = await h.authed();
    const { session } = await register(c);
    for (let i = 0; i < 6; i++) {
      h.clock.ms += 15_000;
      await c.call("session.heartbeat", { sessionId: session.id });
      h.daemon.sweep();
    }
    expect((await c.call("session.list", {})).sessions).toHaveLength(1);
  });

  it("marks a session offline as soon as its nearest host pid dies", async () => {
    const c = await h.authed();
    await register(c, { hostPids: [5001] });
    const other = await register(c, { hostPids: [5002] });
    h.dead.add(5001);
    h.clock.ms += 1_000;
    h.daemon.sweep();
    const online = (await c.call("session.list", {})).sessions;
    expect(online.map((s: any) => s.id)).toEqual([other.session.id]);
  });

  it("frees the name of an offline session and vacates the orchestrator role", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPids: [5001] })).session;
    const b = (await register(c)).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    h.dead.add(5001);
    h.daemon.sweep();
    const err = await c.rpc("message.send", text("orchestrator", b.id));
    expect(err.error?.message).toContain("No session holds the orchestrator role");
    const again = await register(c, { hostPids: [5003] });
    expect(again.session.name).toBe(a.name);
    const offline = await c.rpc("message.send", text(a.id, b.id));
    expect(offline.error?.code).toBe(RpcErrorCode.NotFound);
  });

  it("emits session.updated offline and orchestrator.changed", async () => {
    const w = await h.authed();
    const ws = (await register(w)).session;
    await w.call("events.subscribe", { sessionId: ws.id });
    const c = await h.authed();
    const a = (await register(c, { hostPids: [5001] })).session;
    await c.call("orchestrator.claim", { sessionId: a.id });
    // Events for w travel on its own socket, so the claim's events can still be in flight here
    // (seen on Windows). A reply on w arrives after every event written to it before the reply.
    await w.call("session.list", {});
    const before = w.events.length;
    h.dead.add(5001);
    h.daemon.sweep();
    await w.waitForEvents(before + 2);
    const tail = w.events.slice(before);
    expect(tail.map((e) => e.event).sort()).toEqual(["orchestrator.changed", "session.updated"]);
    const changed = tail.find((e) => e.event === "orchestrator.changed");
    expect(changed?.data).toEqual({ orchestrator: null, previous: a.id });
  });

  it("brings an offline session back on heartbeat when its host lives and its name is free", async () => {
    const c = await h.authed();
    const a = (await register(c, { hostPids: [5001] })).session;
    h.clock.ms += 60_000;
    h.daemon.sweep();
    expect((await c.call("session.list", {})).sessions).toHaveLength(0);
    await c.call("session.heartbeat", { sessionId: a.id });
    expect((await c.call("session.list", {})).sessions.map((s: any) => s.id)).toEqual([a.id]);
  });

  it("refuses to revive a session whose name was taken or whose host died", async () => {
    const c = await h.authed();
    const a = (await register(c, { name: "alpha", hostPids: [5001] })).session;
    h.clock.ms += 60_000;
    h.daemon.sweep();
    await register(c, { name: "alpha" });
    expect((await c.rpc("session.heartbeat", { sessionId: a.id })).error?.code).toBe(
      RpcErrorCode.NotFound,
    );
  });

  it("deletes sessions offline for 7 days, with their messages, and keeps newer ones", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    const b = (await register(c, { name: "keeper" })).session;
    const d = (await register(c, { name: "gone" })).session;
    await c.call("message.send", text("gone", a.id, "to gone"));
    await c.call("message.send", text("keeper", a.id, "to keeper"));
    await c.call("session.unregister", { sessionId: d.id });
    h.clock.ms += 6 * 24 * 3_600_000;
    h.daemon.sweep();
    expect(
      (await c.call("session.list", { includeOffline: true })).sessions.map((s: any) => s.name),
    ).toContain("gone");
    h.clock.ms += 25 * 3_600_000;
    await c.call("session.heartbeat", { sessionId: a.id });
    await c.call("session.heartbeat", { sessionId: b.id });
    h.daemon.sweep();
    const names = (await c.call("session.list", { includeOffline: true })).sessions.map(
      (s: any) => s.name,
    );
    expect(names).not.toContain("gone");
    expect(names).toContain("keeper");
    const mine = await c.call("message.inbox", { sessionId: b.id });
    expect(mine.messages.map((m: any) => m.body.text)).toEqual(["to keeper"]);
    expect((await c.rpc("session.heartbeat", { sessionId: d.id })).error?.code).toBe(
      RpcErrorCode.NotFound,
    );
  });

  it("the real sweep timer runs on its interval", async () => {
    await h.stop();
    h = await startHarness({ sweepIntervalMs: 20 });
    const c = await h.authed();
    await register(c, { hostPids: [6001] });
    h.dead.add(6001);
    await new Promise((r) => setTimeout(r, 120));
    expect((await c.call("session.list", {})).sessions).toHaveLength(0);
  });
});

describe("idle exit", () => {
  it("shuts down after idleExitMs with no online sessions and calls onIdleExit", async () => {
    await h.stop();
    let exited = 0;
    h = await startHarness({ idleExitMs: 600_000, onIdleExit: () => exited++ });
    const c = await h.authed();
    const { session } = await register(c);
    h.clock.ms += 599_000;
    await c.call("session.heartbeat", { sessionId: session.id });
    h.daemon.sweep();
    expect(exited).toBe(0);
    await c.call("session.unregister", { sessionId: session.id });
    h.clock.ms += 30_000;
    h.daemon.sweep();
    expect(exited).toBe(0);
    h.clock.ms += 600_000;
    h.daemon.sweep();
    await new Promise((r) => setTimeout(r, 50));
    expect(exited).toBe(1);
    await expect(RawClient.connect(h.socketPath)).rejects.toThrow();
  });

  it("does not exit while a session is online", async () => {
    await h.stop();
    let exited = 0;
    h = await startHarness({ idleExitMs: 1_000, onIdleExit: () => exited++ });
    const c = await h.authed();
    const { session } = await register(c);
    for (let i = 0; i < 5; i++) {
      h.clock.ms += 15_000;
      await c.call("session.heartbeat", { sessionId: session.id });
      h.daemon.sweep();
    }
    expect(exited).toBe(0);
  });
});

describe("persistence", () => {
  it("keeps sessions, messages, mailbox state, orchestrator and device id across a restart", async () => {
    const c = await h.authed();
    const a = (await register(c, { name: "alpha" })).session;
    const b = (await register(c, { name: "beta" })).session;
    await c.call("orchestrator.claim", { sessionId: b.id });
    await c.call("message.send", text("beta", a.id, "read me"));
    await c.call("message.send", text("beta", a.id, "inject me"));
    await c.call("message.send", text("beta", a.id, "leave me"));
    const inboxBefore = await c.call("message.inbox", { sessionId: b.id, limit: 1 });
    expect(inboxBefore.messages).toHaveLength(1);
    await c.call("message.deliver", { sessionId: b.id, limit: 1 });
    const deviceId = a.deviceId;

    await h.restart();
    const d = await h.authed();
    const sessions = (await d.call("session.list", {})).sessions;
    expect(sessions.map((s: any) => [s.name, s.isOrchestrator])).toEqual([
      ["alpha", false],
      ["beta", true],
    ]);
    expect(sessions[0].deviceId).toBe(deviceId);
    const rest = await d.call("message.inbox", { sessionId: b.id });
    // "read me" was delivered by the hook, so it is no longer unread.
    expect(rest.messages.map((m: any) => m.body.text)).toEqual(["inject me", "leave me"]);
    const all = await d.call("message.inbox", { sessionId: b.id, unreadOnly: false });
    expect(all.messages).toHaveLength(4);
    // Messages still route to the persisted holder, and new messages queue after a restart.
    const sent = await d.call("message.send", text("orchestrator", a.id, "after"));
    expect(sent.deliveredTo.id).toBe(b.id);
  });

  it("gives sessions a full liveness window after a restart", async () => {
    const c = await h.authed();
    const a = (await register(c)).session;
    h.clock.ms += 600_000;
    await h.restart();
    h.clock.ms += 20_000;
    h.daemon.sweep();
    const d = await h.authed();
    expect((await d.call("session.list", {})).sessions).toHaveLength(1);
    await d.call("session.heartbeat", { sessionId: a.id });
    h.clock.ms += 60_000;
    h.daemon.sweep();
    expect((await d.call("session.list", {})).sessions).toHaveLength(0);
  });

  it("applies migrations once and survives reopening the database", async () => {
    await h.restart();
    await h.restart();
    const c = await h.authed();
    expect((await register(c)).session.name).toMatch(/^claude@/);
  });
});

describe("single instance and stale files", () => {
  it("refuses a second daemon on the same data directory", async () => {
    await expect(
      startDaemon({ dataDir: h.dir, socketPath: h.socketPath, sweepIntervalMs: 3_600_000 }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
    // The first daemon is untouched.
    const c = await h.authed();
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it("replaces a lock file whose process is gone", async () => {
    await h.restart();
    h.clients.splice(0);
    await h.daemon.close();
    writeFileSync(join(h.dir, "daemon.lock"), JSON.stringify({ pid: 2147483646 }));
    h.daemon = await startDaemon({
      dataDir: h.dir,
      socketPath: h.socketPath,
      sweepIntervalMs: 3_600_000,
    });
    const c = await h.authed();
    expect((await c.call("session.list", {})).sessions).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "probes the socket recorded in the lock, not the new daemon's own",
    async () => {
      // The running daemon wrote its socket path into the lock.
      const lock = join(h.dir, "daemon.lock");
      expect(JSON.parse(readFileSync(lock, "utf8"))).toEqual({
        pid: process.pid,
        socketPath: h.socketPath,
      });
      // Make the lock old enough that only the socket probe can keep it alive.
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      await expect(
        startDaemon({
          dataDir: h.dir,
          socketPath: join(h.dir, "other.sock"),
          sweepIntervalMs: 3_600_000,
        }),
      ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      const c = await h.authed();
      expect((await c.call("session.list", {})).sessions).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a socket path that is too long", async () => {
    await expect(
      startDaemon({
        dataDir: h.dir,
        socketPath: join(h.dir, `${"x".repeat(120)}.sock`),
        sweepIntervalMs: 3_600_000,
      }),
    ).rejects.toThrow(/too long.*XDG_RUNTIME_DIR/);
  });

  it("removes the lock file on close", async () => {
    await h.daemon.close();
    expect(() => statSync(join(h.dir, "daemon.lock"))).toThrow();
    h.daemon = await startDaemon({
      dataDir: h.dir,
      socketPath: h.socketPath,
      sweepIntervalMs: 3_600_000,
    });
  });

  it.skipIf(process.platform === "win32")(
    "removes a stale socket file and refuses to touch a live one",
    async () => {
      await h.daemon.close();
      // A leftover file at the socket path with nobody listening.
      const stale = join(h.dir, "stale.sock");
      writeFileSync(stale, "");
      const d = await startDaemon({
        dataDir: h.dir,
        socketPath: stale,
        sweepIntervalMs: 3_600_000,
      });
      const c = await RawClient.connect(stale);
      c.close();
      await d.close();

      // A live listener on the path: the daemon must not delete it or start.
      const live = join(h.dir, "live.sock");
      const holder = createServer();
      await new Promise<void>((r) => holder.listen(live, () => r()));
      await expect(
        startDaemon({ dataDir: h.dir, socketPath: live, sweepIntervalMs: 3_600_000 }),
      ).rejects.toBeInstanceOf(DaemonAlreadyRunningError);
      const probe = await RawClient.connect(live);
      probe.close();
      await new Promise<void>((r) => holder.close(() => r()));

      h.daemon = await startDaemon({
        dataDir: h.dir,
        socketPath: h.socketPath,
        sweepIntervalMs: 3_600_000,
      });
    },
  );

  it.skipIf(process.platform === "win32")("creates the socket with mode 0600", () => {
    expect(statSync(h.socketPath).mode & 0o777).toBe(0o600);
  });

  it("closes cleanly with connected clients and can be closed twice", async () => {
    await h.authed();
    await h.daemon.close();
    await h.daemon.close();
    h.daemon = await startDaemon({
      dataDir: h.dir,
      socketPath: h.socketPath,
      sweepIntervalMs: 3_600_000,
    });
  });
});

describe("daemon.shutdown", () => {
  it("needs the handshake like every other method", async () => {
    const c = await h.client();
    expect((await c.rpc("daemon.shutdown", {})).error?.code).toBe(RpcErrorCode.Unauthorized);
    // The daemon is still up.
    expect((await (await h.authed()).call("session.list", {})).sessions).toEqual([]);
  });

  it("replies ok, stops listening, closes the store, removes socket and lock, then calls onShutdown", async () => {
    await h.stop();
    let shutdowns = 0;
    h = await startHarness({ onShutdown: () => shutdowns++ });
    const lock = join(h.dir, "daemon.lock");
    const other = await h.authed();
    const c = await h.authed();
    const a = (await register(c, { name: "alpha" })).session;
    expect(statSync(lock).isFile()).toBe(true);
    if (process.platform !== "win32") expect(statSync(h.socketPath).isSocket()).toBe(true);

    // The reply arrives before the connection is torn down.
    const reply = await c.rpc("daemon.shutdown");
    expect(reply.result).toEqual({ ok: true });
    await c.waitClosed();
    await other.waitClosed();
    await vi.waitFor(() => expect(shutdowns).toBe(1));

    await expect(RawClient.connect(h.socketPath)).rejects.toThrow();
    expect(() => statSync(lock)).toThrow();
    if (process.platform !== "win32") expect(() => statSync(h.socketPath)).toThrow();

    // The store was closed cleanly: a new daemon takes the lock and sees the same session.
    await h.restart();
    const again = await h.authed();
    const names = (await again.call("session.list", { includeOffline: true })).sessions.map(
      (s: any) => s.name,
    );
    expect(names).toEqual([a.name]);
  });

  it("calls onShutdown, not onIdleExit", async () => {
    await h.stop();
    let idle = 0;
    let down = 0;
    h = await startHarness({ onIdleExit: () => idle++, onShutdown: () => down++ });
    const c = await h.authed();
    await c.rpc("daemon.shutdown");
    await vi.waitFor(() => expect(down).toBe(1));
    expect(idle).toBe(0);
  });
});

describe("store migrations", () => {
  it("turns a stored host_pid into a one-entry hostPids chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "convenod-mig-"));
    const path = join(dir, "conveno.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(MIGRATIONS[0]?.sql ?? "");
      old.exec("CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      old.prepare("INSERT INTO migrations (name, applied_at) VALUES ('001_initial', 'then')").run();
      old
        .prepare(
          `INSERT INTO sessions (id, name, cli, device_id, cwd, host_pid, status, delivery_tier, spawn_depth, started_at, last_seen_at)
           VALUES ('S1', 'old', 'claude', 'D1', '/w', 4321, 'idle', 'next_turn', 0, 't', 't'),
                  ('S2', 'none', 'claude', 'D1', '/w', NULL, 'idle', 'next_turn', 0, 't', 't')`,
        )
        .run();
      old.close();

      const store = new Store(path);
      const rows = store.allSessions();
      expect(rows.find((r) => r.name === "old")?.hostPids).toEqual([4321]);
      expect(rows.find((r) => r.name === "none")?.hostPids).toBeUndefined();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
