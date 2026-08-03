import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Many files boot a real in-memory PGlite; under full parallel load the
    // workers are CPU-starved and the 5s default produces spurious timeouts.
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Keep test output readable; tests that assert logging behaviour stub the
    // logger methods (or manage LOG_LEVEL themselves), so they are unaffected.
    env: { LOG_LEVEL: "silent" },
    coverage: {
      provider: "v8",
      // src/index.ts is process bootstrap: Discord login, signal handlers,
      // process.exit — exercised by running the bot, not unit-testable.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
