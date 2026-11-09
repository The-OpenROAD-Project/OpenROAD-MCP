import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    // Vitest 5 clears mocks before each test by default; keep the
    // Vitest 4 behavior so the upgrade does not change test semantics.
    clearMocks: false,
    // --expose-gc lets MemoryMonitor.takeSnapshot() force a GC pass before
    // measuring, so RSS/heap diffs in memory_monitoring.test.ts are not noise
    // from a GC that just had not run yet.
    execArgv: ["--expose-gc"],
    include: ["__tests__/performance/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 15000,
  },
});
