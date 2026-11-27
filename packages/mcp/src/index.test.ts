import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_INTERVAL_MS, NOT_FROM_USER_NOTICE } from "@0xpixelninja/conveno-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDaemon } from "./fake-client.js";
import { createServer, formatAge, formatSessionTable, PACKAGE_NAME } from "./index.js";

interface Peer {
  mcp: ReturnType<typeof createServer>;
  client: Client;
  text(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

let daemon: FakeDaemon;
let root: string;
const peers: Peer[] = [];

async function startPeer(cwd: string, cli: "claude" | "codex" = "claude"): Promise<Peer> {
  const mcp = createServer({ cli, client: daemon.client(), hostPid: 4242, cwd });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const peer: Peer = {
    mcp,
    client,
    async text(name, args = {}) {
      const r = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      return { text: r.content[0]?.text ?? "", isError: r.isError === true };
    },
  };
  peers.push(peer);
  return peer;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  daemon = new FakeDaemon();
  root = await mkdtemp(join(tmpdir(), "conveno-mcp-"));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const p of peers.splice(0)) await p.mcp.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe("package", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@0xpixelninja/conveno-mcp");
  });
});

describe("tools", () => {
  it("lists exactly the M1 tools", async () => {
    const p = await startPeer(root);
    const { tools } = await p.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "ack",
        "inbox",
        "list_sessions",
        "orchestrate",
        "rename",
        "send",
        "set_status",
        "whoami",
      ].sort(),
    );
    for (const t of tools) expect((t.description ?? "").length).toBeGreaterThan(20);
  });

  it("registers on connect with cli, cwd, pid, host pid and repo", async () => {
    await mkdir(join(root, "myrepo", ".git"), { recursive: true });
    await mkdir(join(root, "myrepo", "src"));
    vi.stubEnv("CONVENO_CLI_VERSION", "1.2.3");
    await startPeer(join(root, "myrepo", "src"), "codex");
    await flush();
    vi.unstubAllEnvs();
    const [s] = [...daemon.sessions.values()];
    expect(s?.cli).toBe("codex");
    expect(s?.cliVersion).toBe("1.2.3");
    expect(s?.pid).toBe(process.pid);
    expect(s?.hostPid).toBe(4242);
    expect(s?.repo?.root).toBe(join(root, "myrepo"));
    expect(s?.name).toBe("codex@myrepo-1");
  });

  it("whoami reports the session", async () => {
    const p = await startPeer(root);
    const r = await p.text("whoami");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Name: claude@/);
    expect(r.text).toContain("Orchestrator: no");
    expect(r.text).toContain("none (not in a git repository)");
  });

  it("send, inbox and ack move a message between two sessions", async () => {
    const a = await startPeer(root);
    const b = await startPeer(root, "codex");
    await Promise.all([a.text("whoami"), b.text("whoami")]);
    const bName = [...daemon.sessions.values()].find((s) => s.cli === "codex")?.name ?? "";
    const sent = await a.text("send", { to: bName, text: "tests are green", urgent: true });
    expect(sent.isError).toBe(false);
    expect(sent.text).toContain(`to ${bName}`);

    const inbox = await b.text("inbox");
    expect(inbox.text).toContain(NOT_FROM_USER_NOTICE);
    expect(inbox.text).toContain("tests are green");
    expect(inbox.text).toContain("Unread remaining: 0.");

    const again = await b.text("inbox");
    expect(again.text).toContain("No messages");

    const id = /Message id: (\w+)/.exec(inbox.text)?.[1] ?? "";
    const acked = await b.text("ack", { ids: [id] });
    expect(acked.text).toBe("Acknowledged 1 message.");
  });

  it("turns daemon errors into tool errors with the plain message", async () => {
    const a = await startPeer(root);
    const r = await a.text("send", { to: "nobody", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('No session named "nobody". Run list_sessions to see who is available.');
    const bad = await a.text("rename", { name: "Bad Name" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("Invalid session name");
  });

  it("rename and set_status update the session shown by list_sessions", async () => {
    const a = await startPeer(root);
    const b = await startPeer(root, "codex");
    expect((await a.text("rename", { name: "api-worker" })).text).toBe("Renamed to api-worker.");
    expect((await a.text("set_status", { text: "fixing auth" })).text).toBe("ok");
    const table = await b.text("list_sessions");
    expect(table.text).toContain("api-worker");
    expect(table.text).toContain("fixing auth");
    expect(table.text.split("\n")[0]).toMatch(/^NAME\s+CLI\s+REPO\s+STATUS\s+ORCH\s+LAST SEEN/);
    const filtered = await b.text("list_sessions", { cli: "codex" });
    expect(filtered.text).not.toContain("api-worker");
  });

  it("orchestrate claims the role and reports the previous holder", async () => {
    const a = await startPeer(root);
    const b = await startPeer(root, "codex");
    expect((await a.text("orchestrate")).text).toContain("no previous holder");
    await b.text("whoami");
    const aName = [...daemon.sessions.values()].find((s) => s.cli === "claude")?.name;
    expect((await b.text("orchestrate")).text).toContain(`Previous holder: ${aName}`);
    expect((await a.text("whoami")).text).toContain("Orchestrator: no");
    expect((await b.text("whoami")).text).toContain("Orchestrator: yes");
    const sent = await a.text("send", { to: "orchestrator", text: "ping" });
    expect(sent.isError).toBe(false);
  });

  it("rejects bad input through the zod schemas", async () => {
    const a = await startPeer(root);
    await expect(a.client.callTool({ name: "ack", arguments: { ids: [] } })).resolves.toMatchObject(
      { isError: true },
    );
  });
});

describe("lifecycle", () => {
  it("heartbeats every 15 seconds and unregisters on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const p = await startPeer(root);
    await p.text("whoami");
    const id = [...daemon.sessions.keys()][0];
    const beats = () => daemon.calls.filter((c) => c.method === "session.heartbeat").length;
    expect(beats()).toBe(0);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(2);
    await p.mcp.close();
    expect(daemon.sessions.get(id as never)?.status).toBe("offline");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
    expect(beats()).toBe(2);
  });

  it("unregisters when the client side closes the transport", async () => {
    const p = await startPeer(root);
    await p.text("whoami");
    await p.client.close();
    await flush();
    expect([...daemon.sessions.values()][0]?.status).toBe("offline");
  });
});

describe("formatting", () => {
  it("formats ages", () => {
    const now = Date.parse("2026-11-27T12:00:00.000Z");
    expect(formatAge("2026-11-27T11:59:48.000Z", now)).toBe("12s ago");
    expect(formatAge("2026-11-27T11:55:00.000Z", now)).toBe("5m ago");
    expect(formatAge("2026-11-27T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatAge("2026-11-25T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("says so when no sessions match", () => {
    expect(formatSessionTable([], 0)).toBe("No sessions match.");
  });
});
