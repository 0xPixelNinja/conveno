import { createTheme, type Theme } from "@0xpixelninja/conveno-brand";
import { PACKAGE_NAME, VERSION } from "./index.js";

/** `c● conveno 0.0.0`: the mark, the name in bold ink, the version quiet. */
export function versionLine(theme: Theme = createTheme()): string {
  return `${theme.mark()} ${theme.bold(PACKAGE_NAME)} ${theme.paint("quiet", VERSION)}`;
}
