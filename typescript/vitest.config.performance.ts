import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["__tests__/performance/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 15000,
  },
});
