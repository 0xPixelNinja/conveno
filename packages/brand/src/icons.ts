import { fileURLToPath } from "node:url";
import { ICON_NAMES, ICON_NAMES_WITH_16 } from "./generated/icon-names.js";

export { ICON_NAMES, ICON_NAMES_WITH_16 };

/** Every icon in the sprite, e.g. `"session"`, `"handoff"`, `"status-waiting"`. */
export type IconName = (typeof ICON_NAMES)[number];

/**
 * Absolute path of the SVG sprite. Inline it in a page, then reference icons with `<use>`.
 * The pure annotation lets a bundler that does not use this export (the CLI) drop the call.
 */
export const SPRITE_PATH: string = /* @__PURE__ */ fileURLToPath(
  /* @__PURE__ */ new URL("./generated/sprite.svg", import.meta.url),
);

/** The `<symbol>` id to pass to `<use href="#...">`. Pass `16` for the hand-tuned small variant. */
export function spriteId(name: IconName, size?: 16): string {
  const tuned = size === 16 && (ICON_NAMES_WITH_16 as readonly string[]).includes(name);
  return tuned ? `cv-${name}-16` : `cv-${name}`;
}
