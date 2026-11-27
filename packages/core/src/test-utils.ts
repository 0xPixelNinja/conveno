import {
  type CliKind,
  type Message,
  type MessageId,
  newMessageId,
  newSessionId,
  type SessionId,
} from "@conveno/protocol";
import type { NamedSession } from "./naming.js";

export const sess = (
  name: string,
  status: NamedSession["status"] = "idle",
  id: SessionId = newSessionId(),
): NamedSession => ({ id, name, status });

export const textMessage = (
  text: string,
  over: {
    urgent?: boolean;
    from?: SessionId;
    createdAt?: string;
    fromName?: string | null;
    replyTo?: MessageId;
  } = {},
): Message =>
  ({
    kind: "text",
    body: { text },
    id: newMessageId(),
    from: over.from ?? newSessionId(),
    to: "orchestrator",
    urgent: over.urgent ?? false,
    ...(over.replyTo ? { replyTo: over.replyTo } : {}),
    createdAt: over.createdAt ?? "2026-11-27T14:02:11.000Z",
    ...(over.fromName === null
      ? {}
      : { fromName: over.fromName ?? SENDER.name, fromCli: SENDER.cli }),
  }) as Message;

export const SENDER = { name: "codex@api-2", cli: "codex" as CliKind };

/** Small deterministic PRNG (mulberry32) for property-style tests. */
export function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
