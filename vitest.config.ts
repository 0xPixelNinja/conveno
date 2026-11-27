import { defineConfig } from "vitest/config";

// Root config for running every package's tests from the repo root (`pnpm vitest`).
// `pnpm test` runs each package's own `vitest run` through turbo.
export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
