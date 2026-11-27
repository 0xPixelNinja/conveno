// Copies the non-TypeScript outputs of generate.mjs next to the bundle.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "dist", "generated");
mkdirSync(dest, { recursive: true });
for (const f of ["tokens.css", "tokens.json", "sprite.svg"]) {
  copyFileSync(join(root, "src", "generated", f), join(dest, f));
}
