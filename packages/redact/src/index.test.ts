import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@conveno/redact", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@conveno/redact");
  });
});
