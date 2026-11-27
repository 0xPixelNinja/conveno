import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@0xpixelninja/caucus-relay", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@0xpixelninja/caucus-relay");
  });
});
