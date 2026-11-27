import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};

// One published package. Every @conveno/* workspace package is bundled into dist; the third-party
// packages in `dependencies` stay external and are installed by npm. This is how wrangler (its
// internal @cloudflare/* packages are devDependencies) and Gemini CLI (it bundles its own core)
// ship.
export default defineConfig({
  entry: {
    // The `conveno` command.
    bin: "src/bin.ts",
    // The daemon runs as its own process, so it is its own file. The CLI starts it from here:
    // runtime.ts resolves `./daemon.js` next to the running bin.
    daemon: "../daemon/src/bin.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "node24",
  fixedExtension: false,
  deps: {
    alwaysBundle: [/^@conveno\//],
    // The build fails if the output imports anything that is not a declared dependency.
    onlyImport: Object.keys(pkg.dependencies),
  },
});
