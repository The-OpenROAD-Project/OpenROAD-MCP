import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    // Vitest 5 clears mocks before each test by default; keep the
    // Vitest 4 behavior so the upgrade does not change test semantics.
    clearMocks: false,
    include: ["__tests__/**/*.test.ts"],
    exclude: ["__tests__/integration/**", "__tests__/performance/**"],
    coverage: {
      provider: "v8",
      thresholds: {
        // Repo-wide floor.
        lines: 80,

        // Per-file floors for the critical modules (session lifecycle,
        // the Tcl whitelist, report-image path security, tool dispatch).
        // Set a little below the measured level at the time they were
        // added so the floor has headroom, not exactly equal to it.
        "src/config/command_whitelist.ts": { statements: 90, branches: 88 },
        "src/tools/base.ts": { statements: 100, branches: 100 },
        "src/tools/interactive.ts": { statements: 90, branches: 75 },
        "src/core/manager.ts": { statements: 95, branches: 90 },
        "src/tools/report_images.ts": { statements: 95, branches: 80 },

        // server.ts is mostly transport/tool-registration wiring exercised
        // by the Docker-based real-OpenROAD integration suite (see
        // .github/workflows/docker-test.yml), not by this unit-only run —
        // this floor only guards against regressing below where it sits
        // today, not a 90% unit-coverage target.
        "src/server.ts": { statements: 25, branches: 5 },
      },
    },
  },
});
