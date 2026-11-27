import { createTheme, type Theme } from "@0xpixelninja/conveno-brand";
import { PACKAGE_NAME, VERSION } from "./version.js";

/**
 * `c● conveno 0.0.0`: the mark, the name in bold, the version in the info colour. The `c` is left
 * in the terminal's own foreground, never painted, so only the point carries a colour.
 */
export function versionLine(theme: Theme = createTheme()): string {
  const point = theme.unicode ? "●" : "*";
  return `c${theme.paint("entry", point)} ${theme.bold(PACKAGE_NAME)} ${theme.paint("info", VERSION)}`;
}
