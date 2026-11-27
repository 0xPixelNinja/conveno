import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@0xpixelninja/conveno-adapter-opencode", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@0xpixelninja/conveno-adapter-opencode");
  });
});
