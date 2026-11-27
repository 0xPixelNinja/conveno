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
  pid: z.number().int().positive().optional(),
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
