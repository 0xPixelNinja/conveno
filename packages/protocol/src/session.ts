import { z } from "zod";
import { DeviceId, SessionId } from "./ids.js";
import {
  CliKind,
  DeliveryTier,
  IsoTimestamp,
  SessionName,
  SessionStatus,
  Sha256Hex,
} from "./primitives.js";

export const STATUS_TEXT_MAX = 200;

/** Longest ancestor chain a session registers or a hook looks up. */
export const HOST_PIDS_MAX = 8;

/** An ancestor chain of process ids, nearest first. */
export const HostPids = z.array(z.number().int().positive()).min(1).max(HOST_PIDS_MAX);
export type HostPids = z.infer<typeof HostPids>;

export const RepoInfo = z.object({
  /** Absolute path of the repository root on the session's device. */
  root: z.string().min(1),
  /** SHA-256 of the normalised `origin` URL; lets sessions on different machines match repos without exposing the URL. */
  remoteUrlHash: Sha256Hex.optional(),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

export const Session = z.object({
  id: SessionId,
  name: SessionName,
  cli: CliKind,
  cliVersion: z.string().min(1).max(64).optional(),
  deviceId: DeviceId,
  cwd: z.string().min(1),
  repo: RepoInfo.optional(),
  /** PID of the MCP server process. */
  pid: z.number().int().positive().optional(),
  /**
   * The MCP server's ancestor chain, nearest first, at most `HOST_PIDS_MAX` entries. The first
   * entry is the process that launched the MCP server; the rest are the launchers and the CLI
   * above it. Hooks match a session through this list.
   */
  hostPids: HostPids.optional(),
  status: SessionStatus,
  statusText: z.string().max(STATUS_TEXT_MAX).optional(),
  isOrchestrator: z.boolean(),
  deliveryTier: DeliveryTier,
  spawnedBy: SessionId.optional(),
  spawnDepth: z.number().int().min(0),
  startedAt: IsoTimestamp,
  lastSeenAt: IsoTimestamp,
});
export type Session = z.infer<typeof Session>;
