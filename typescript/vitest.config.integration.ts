import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
