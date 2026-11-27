import { defineConfig } from "vitest/config";

// Real processes, real sockets and a 15 s liveness sweep: generous timeouts, mostly for Windows CI.
export default defineConfig({
  test: {
    globalSetup: ["./src/global-setup.ts"],
    include: ["src/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
