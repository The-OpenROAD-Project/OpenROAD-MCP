import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["__tests__/integration/**", "__tests__/performance/**"],
    coverage: {
      provider: "v8",
      thresholds: { lines: 80 },
    },
  },
});
