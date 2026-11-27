import { newDeviceId, newMessageId, newSessionId, newTicketId } from "./ids.js";

export const NOW = "2026-11-27T09:30:00.000Z";

export function sessionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: newSessionId(),
    name: "claude@repo-1",
    cli: "claude",
    deviceId: newDeviceId(),
    cwd: "/home/u/repo",
    status: "idle",
    isOrchestrator: false,
    deliveryTier: "inbox",
    spawnDepth: 0,
    startedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

export function messageFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: newMessageId(),
    from: newSessionId(),
    to: "orchestrator",
    kind: "text",
    body: { text: "hello" },
    createdAt: NOW,
    ...overrides,
  };
}

export const ticketIdFixture = () => newTicketId();
