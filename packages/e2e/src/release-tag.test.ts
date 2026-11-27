import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { distTagFor, isVersion, versionOfTag } from "../../../scripts/release-tag.js";

describe("distTagFor", () => {
  it("sends a plain version to latest", () => {
    expect(distTagFor("0.1.1")).toBe("latest");
    expect(distTagFor("12.0.3")).toBe("latest");
  });
  it("sends any prerelease to next", () => {
    expect(distTagFor("0.1.1-rc.1")).toBe("next");
    expect(distTagFor("0.2.0-beta.3")).toBe("next");
    expect(distTagFor("1.0.0-alpha")).toBe("next");
  });
  it("ignores build metadata", () => {
    expect(distTagFor("1.0.0+build.5")).toBe("latest");
    expect(distTagFor("1.0.0-rc.1+build.5")).toBe("next");
  });
  it("rejects what is not a version", () => {
    for (const bad of ["", "1.2", "v1.2.3", "1.2.3-", "1.2.3-rc..1", "latest"]) {
      expect(isVersion(bad), bad).toBe(false);
      expect(() => distTagFor(bad), bad).toThrow();
    }
  });
  it("reads the version out of a tag", () => {
    expect(versionOfTag("v0.1.1-rc.1")).toBe("0.1.1-rc.1");
  });
});

describe("check-release.mjs", () => {
  const script = resolve(import.meta.dirname, "../../../scripts/check-release.mjs");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const version = run().stdout.match(/at (\S+),/)?.[1] ?? "";

  it("prints the dist-tag for the matching tag", () => {
    const r = run(`v${version}`, "--print-dist-tag");
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(distTagFor(version));
  });
  it("fails when the tag and the versions disagree", () => {
    expect(run("v99.0.0").status).toBe(1);
    expect(run("v99.0.0-rc.1", "--print-dist-tag").status).toBe(1);
  });
  it("fails when the tag has no v", () => {
    expect(run(version).status).toBe(1);
  });
});
