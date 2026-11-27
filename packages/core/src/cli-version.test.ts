import { describe, expect, it } from "vitest";
import { parseCliVersion } from "./cli-version.js";

describe("parseCliVersion", () => {
  it("finds the version in each CLI's own wording", () => {
    expect(parseCliVersion("2.1.4 (Claude Code)\n")).toBe("2.1.4");
    expect(parseCliVersion("codex-cli 0.99.1\n")).toBe("0.99.1");
    expect(parseCliVersion("2.4.2")).toBe("2.4.2");
  });

  it("keeps a prerelease suffix", () => {
    expect(parseCliVersion("codex-cli 0.100.0-alpha.3")).toBe("0.100.0-alpha.3");
  });

  it("returns undefined when there is no version", () => {
    expect(parseCliVersion("")).toBeUndefined();
    expect(parseCliVersion("command not found")).toBeUndefined();
  });
});
