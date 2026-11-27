import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "./index.js";

describe("conveno", () => {
  it("exports its name and version", () => {
    expect(PACKAGE_NAME).toBe("conveno");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
