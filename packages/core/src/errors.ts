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

export const NO_ORCHESTRATOR_MESSAGE =
  "No session holds the orchestrator role. Run orchestrate in the session you want to use.";
