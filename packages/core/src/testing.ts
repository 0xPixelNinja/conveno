import {
  type CliKind,
  type Message,
  newMessageId,
  newSessionId,
  type SessionId,
} from "@0xpixelninja/conveno-protocol";
import type { NamedSession } from "./naming.js";

export const sess = (
  name: string,
  status: NamedSession["status"] = "idle",
  id: SessionId = newSessionId(),
): NamedSession => ({ id, name, status });

export const textMessage = (
  text: string,
  over: { urgent?: boolean; from?: SessionId; createdAt?: string } = {},
): Message => ({
  kind: "text",
  body: { text },
  id: newMessageId(),
  from: over.from ?? newSessionId(),
  to: "orchestrator",
  urgent: over.urgent ?? false,
  createdAt: over.createdAt ?? "2026-11-27T14:02:11.000Z",
});

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
