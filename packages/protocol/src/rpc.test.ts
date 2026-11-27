import { describe, expect, it } from "vitest";
import { makeError, makeRequest, makeResult, RpcErrorCode, RpcResponse } from "./rpc.js";

describe("rpc helpers", () => {
  it("has the documented error codes", () => {
    expect(RpcErrorCode).toMatchObject({
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
    });
    const codes = Object.values(RpcErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("builds valid requests, results and errors", () => {
    expect(makeRequest(1, "session.list")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session.list",
    });
    expect(makeRequest("a", "x", { k: 1 })).toHaveProperty("params", { k: 1 });
    expect(RpcResponse.safeParse(makeResult(1, { ok: true })).success).toBe(true);
    const e = makeError(null, RpcErrorCode.ParseError, "bad");
    expect(e).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "bad" } });
    expect(RpcResponse.safeParse(e).success).toBe(true);
    expect(makeError(2, -32003, "ask", { action: "spawn" }).error.data).toEqual({
      action: "spawn",
    });
  });

  it("rejects a response with the wrong jsonrpc version", () => {
    expect(RpcResponse.safeParse({ jsonrpc: "1.0", id: 1, result: 1 }).success).toBe(false);
  });
});
