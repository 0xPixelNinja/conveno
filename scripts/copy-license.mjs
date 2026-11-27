// Prepack step: copies the root Apache-2.0 LICENSE into the package being packed (the cwd).
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
copyFileSync(join(root, "LICENSE"), join(process.cwd(), "LICENSE"));
