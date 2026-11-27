import { describe, expect, it } from "vitest";
import { sanitizeLine } from "./util.js";

describe("sanitizeLine", () => {
  it("turns control characters and newlines into single spaces", () => {
    expect(sanitizeLine("a\nb\r\nc\td\u0000e\u001b[31mf")).toBe("a b c d e [31mf");
  });
  it("collapses whitespace and trims", () => {
    expect(sanitizeLine("  a   b   c  ")).toBe("a b c");
  });
  it("leaves plain text alone", () => {
    expect(sanitizeLine("Working on tests")).toBe("Working on tests");
  });
});
