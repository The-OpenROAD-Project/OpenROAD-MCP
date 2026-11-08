import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    // Vitest 5 clears mocks before each test by default; keep the
    // Vitest 4 behavior so the upgrade does not change test semantics.
    clearMocks: false,
    include: ["__tests__/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
