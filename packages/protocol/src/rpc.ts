import { z } from "zod";

export const JSONRPC_VERSION = "2.0";

/** JSON-RPC 2.0 error codes: standard range plus Conveno codes in the implementation-defined range. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  Unauthorized: -32001,
  NotFound: -32002,
  PermissionRequired: -32003,
  LimitExceeded: -32004,
  VersionMismatch: -32005,
  Conflict: -32006,
} as const;
export type RpcErrorCode = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export const RpcId = z.union([z.string().min(1), z.number().int()]);
export type RpcId = z.infer<typeof RpcId>;

export const RpcErrorObject = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcErrorObject = z.infer<typeof RpcErrorObject>;

export const RpcRequestEnvelope = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcId,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type RpcRequestEnvelope = z.infer<typeof RpcRequestEnvelope>;

export const RpcNotificationEnvelope = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const RpcSuccessResponse = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcId,
  result: z.unknown(),
});
export const RpcErrorResponse = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: RpcId.nullable(),
  error: RpcErrorObject,
});
export const RpcResponse = z.union([RpcSuccessResponse, RpcErrorResponse]);
export type RpcResponse = z.infer<typeof RpcResponse>;

export function makeRequest(id: RpcId, method: string, params?: Record<string, unknown>) {
  return params === undefined
    ? { jsonrpc: JSONRPC_VERSION, id, method }
    : { jsonrpc: JSONRPC_VERSION, id, method, params };
}

export function makeResult(id: RpcId, result: unknown) {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function makeError(id: RpcId | null, code: number, message: string, data?: unknown) {
  const error: RpcErrorObject = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSONRPC_VERSION, id, error };
}
