import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "./index.js";

describe("caucus-cli", () => {
  it("exports its name and version", () => {
    expect(PACKAGE_NAME).toBe("caucus-cli");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
