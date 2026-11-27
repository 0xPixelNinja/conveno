import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tokens } from "./index.js";

const css = readFileSync(new URL("./generated/tokens.css", import.meta.url), "utf8");

describe("tokens", () => {
  it("matches brand/tokens.json", () => {
    const source = JSON.parse(
      readFileSync(new URL("../../../brand/tokens.json", import.meta.url), "utf8"),
    );
    expect(tokens).toEqual(source);
  });
  it("writes every colour as a --cv- property, light on :root and dark twice", () => {
    for (const [k, v] of Object.entries(tokens.color.light)) {
      const name = `--cv-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(css).toContain(`  ${name}: ${v};`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css.match(new RegExp(`--cv-entry: ${tokens.color.dark.entry};`, "g"))).toHaveLength(2);
  });
  it("carries type, space, radius, stroke and motion", () => {
    expect(css).toContain("--cv-fs-base: 15px;");
    expect(css).toContain("--cv-s-4: 16px;");
    expect(css).toContain("--cv-r-md: 4px;");
    expect(css).toContain("--cv-stroke-focus: 2px;");
    expect(css).toContain("--cv-ease-enter: cubic-bezier(0.2, 0.7, 0.1, 1);");
    expect(css).toContain("--cv-dur-base: 320ms;");
  });
});
