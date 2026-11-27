import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DAEMON_VERSION } from "./server.js";

it("reports the version in package.json", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(DAEMON_VERSION).toBe(manifest.version);
});
