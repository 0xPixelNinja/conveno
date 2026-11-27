# @0xpixelninja/conveno-core

Shared logic for Conveno: session naming, recipient resolution, orchestrator claims, liveness,
mailbox state and message framing. The daemon, client, MCP server and CLI import it.

## Main exports

- Naming: `generateSessionName`, `validateRename`, `sanitizeNamePart`
- Recipients: `resolveRecipient`, plus the error text for unknown, offline and missing recipients
- Orchestrator: `claimOrchestrator`, `effectiveHolder`, `holderAfterDeparture`
- Liveness: `evaluateLiveness`, `statusAfterLiveness`, `HEARTBEAT_INTERVAL_MS` (15 s),
  `OFFLINE_AFTER_MS` (45 s)
- Mailbox: `createEntry`, `advanceEntry`, `readInbox`, `pendingForInjection`, `markDelivered`,
  `ackEntries`. Entries move through `queued`, `delivered`, `read` and `acked`.
- Framing: `formatInbox`, `formatHookContext`, `formatFramedMessage`, `renderBody`
- Repo and paths: `detectRepo`, `baseName`, `dataDir`, `dataPaths`
- Types: `ConvenoClient` and `ClientMethodName` (the typed IPC surface), `Adapter`, `HookContext`,
  `HookOutput`, `Detection`, `ConvenoError`

The `testing.ts` helpers are not exported from the package entry point.
