import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    // --expose-gc lets MemoryMonitor.takeSnapshot() force a GC pass before
    // measuring, so RSS/heap diffs in memory_monitoring.test.ts aren't noise
    // from a GC that just hadn't run yet.
    poolOptions: { forks: { execArgv: ["--expose-gc"] } },
    include: ["__tests__/performance/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 15000,
  },
});
