// Prepack step: copies the root LICENSE and NOTICE (Apache-2.0 section 4) into the package being
// packed (the cwd), so the tarball carries them. The copies are not committed (see .gitignore).
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["LICENSE", "NOTICE"]) {
  copyFileSync(join(root, name), join(process.cwd(), name));
}
