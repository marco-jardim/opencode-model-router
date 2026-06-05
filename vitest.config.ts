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
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // thresholds: wired in Phase 5.1 (kept off here so Wave 0 never fails on
      // coverage while pure modules are still being extracted).
    },
  },
});
