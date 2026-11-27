import { createTheme } from "@conveno/brand";
import { describe, expect, it } from "vitest";
import { versionLine } from "./banner.js";

describe("versionLine", () => {
  it("prints the mark glyph, the name and the version without colour", () => {
    const theme = createTheme({
      env: { NO_COLOR: "1", LANG: "en_US.UTF-8" },
      isTTY: true,
      platform: "linux",
    });
    expect(versionLine(theme)).toBe("c● conveno 0.1.1-rc.2");
  });
  it("uses ASCII when asked", () => {
    const theme = createTheme({
      env: { NO_COLOR: "1" },
      isTTY: true,
      platform: "linux",
      ascii: true,
    });
    expect(versionLine(theme)).toBe("c* conveno 0.1.1-rc.2");
  });
  it("colours the point with the entry role", () => {
    const theme = createTheme({
      env: { COLORTERM: "truecolor", LANG: "en_US.UTF-8" },
      isTTY: true,
      platform: "linux",
      background: "dark",
    });
    expect(versionLine(theme)).toContain("\u001b[38;2;140;166;255m●\u001b[0m");
  });
});
