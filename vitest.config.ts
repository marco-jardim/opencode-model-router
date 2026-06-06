import { defineConfig } from "vitest/config";

// Vitest configuration for opencode-model-router.
// - Tests live in the top-level `test/` directory (NEVER under `src/`), so the
//   published package (files: ["src/", ...]) can never ship tests (plan C4).
// - The default run excludes `test/smoke/**`: those are opt-in real-OpenCode
//   smokes gated behind RUN_OC_SMOKE=1 (run via `npm run smoke`).
// - Coverage source is `src/`. Thresholds are wired but intentionally left
//   non-failing in Wave 0; they are turned on in Phase 5.1.
export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "node_modules/**", "dist/**", "tmp/**"],
    environment: "node",
    server: {
      deps: {
        inline: ["@opencode-ai/plugin"],
      },
    },
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // Thresholds turned on in Phase 5.1. Global floors are computed across the
      // whole `src/` total (index.ts is plugin wiring, intentionally covered by
      // the integration/smoke suites rather than unit tests, so it is not gated
      // per-file). The per-directory branch gates lock in the global DoD target
      // (>=90% branch on the pure guard/verify/escalate/telemetry/router modules);
      // each is set a few points below the measured baseline to avoid brittleness.
      thresholds: {
        statements: 80,
        branches: 85,
        functions: 80,
        lines: 80,
        "src/guard/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/verify/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/router/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/escalate/**/*.ts": { branches: 95, lines: 95, functions: 95 },
        "src/telemetry/**/*.ts": { branches: 95, lines: 95, functions: 95 },
      },
    },
  },
});
