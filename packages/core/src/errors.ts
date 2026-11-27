import { RpcErrorCode } from "@0xpixelninja/conveno-protocol";

/** A rule violation that maps directly onto a JSON-RPC error the daemon can return. */
export class ConvenoError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.name = "ConvenoError";
    this.code = code;
  }
}

export const unknownRecipientMessage = (to: string): string =>
  `No session named "${to}". Run list_sessions to see who is available.`;

export const offlineRecipientMessage = (name: string): string =>
  `Session "${name}" is offline. Run list_sessions to see who is available.`;

export const NO_ORCHESTRATOR_MESSAGE =
  "No session holds the orchestrator role. Run orchestrate in the session you want to use.";
