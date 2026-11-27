import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@0xpixelninja/caucus-redact", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@0xpixelninja/caucus-redact");
  });
});
