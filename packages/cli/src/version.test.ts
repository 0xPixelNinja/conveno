import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, VERSION } from "./version.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
};

describe("conveno", () => {
  it("exports its name and version", () => {
    expect(PACKAGE_NAME).toBe("@conveno/cli");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  });

  it("matches package.json", () => {
    expect(PACKAGE_NAME).toBe(manifest.name);
    expect(VERSION).toBe(manifest.version);
  });
});
