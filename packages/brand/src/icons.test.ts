import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, ICON_NAMES_WITH_16, SPRITE_PATH, spriteId } from "./icons.js";

describe("icons", () => {
  const sprite = readFileSync(SPRITE_PATH, "utf8");
  it("points at an existing sprite", () => {
    expect(existsSync(SPRITE_PATH)).toBe(true);
  });
  it("has a symbol for every icon name", () => {
    expect(ICON_NAMES.length).toBeGreaterThan(60);
    for (const n of ICON_NAMES) expect(sprite).toContain(`id="cv-${n}"`);
    for (const n of ICON_NAMES_WITH_16) expect(sprite).toContain(`id="cv-${n}-16"`);
  });
  it("resolves sprite ids, falling back when there is no 16 px variant", () => {
    expect(spriteId("session")).toBe("cv-session");
    expect(spriteId("session", 16)).toBe("cv-session-16");
  });
});
