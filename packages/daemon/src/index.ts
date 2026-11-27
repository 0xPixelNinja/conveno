export { DaemonAlreadyRunningError, defaultIsAlive } from "./lifecycle.js";
export {
  DAEMON_SENDER_ID,
  DAEMON_VERSION,
  type DaemonHandle,
  type DaemonOptions,
  DEFAULT_IDLE_EXIT_MS,
  SWEEP_INTERVAL_MS,
  startDaemon,
} from "./server.js";
