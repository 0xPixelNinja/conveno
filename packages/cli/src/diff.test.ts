import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.js";

describe("unifiedDiff", () => {
  it("returns nothing for equal text", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("shows a new file as all additions", () => {
    expect(unifiedDiff(null, "x\ny\n")).toEqual(["@@ -0,0 +1,2 @@", "+x", "+y"]);
  });

  it("keeps two lines of context and merges close hunks", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const after = before.replace("2", "two").replace("9", "nine");
    expect(unifiedDiff(before, after)).toEqual([
      "@@ -1,4 +1,4 @@",
      " 1",
      "-2",
      "+two",
      " 3",
      " 4",
      "@@ -7,4 +7,4 @@",
      " 7",
      " 8",
      "-9",
      "+nine",
      " 10",
    ]);
  });
});
