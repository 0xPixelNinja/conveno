import { createTheme, type Theme } from "@conveno/brand";
import { VERSION } from "./version.js";

/**
 * `c● conveno 0.1.1`: the mark, the name in bold, the version in the info colour. The `c` is left
 * in the terminal's own foreground, never painted, so only the point carries a colour.
 */
export function versionLine(theme: Theme = createTheme()): string {
  const point = theme.unicode ? "●" : "*";
  return `c${theme.paint("entry", point)} ${theme.bold("conveno")} ${theme.paint("info", VERSION)}`;
}
