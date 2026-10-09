import { defineConfig } from "vitest/config";

// Vitest configuration for opencode-model-router.
// - Tests live in the top-level `test/` directory (NEVER under `src/`), so the
//   published package (files: ["src/", ...]) can never ship tests (plan C4).
// - The default run excludes `test/smoke/**`: those are opt-in real-OpenCode
//   smokes gated behind RUN_OC_SMOKE=1 (run via `npm run smoke`).
// - Coverage source is `src/`. The thresholds below are enforced: a
//   `npm run test:coverage` run fails when any of them is missed.
// - OMR_COVERAGE_ARTIFACT=1 (CI only): collect coverage without thresholds.
//   The CI jobs that run a subset of the suite (e2e only, one OS only) upload
//   coverage-final.json; the gate is the merged report, not each partial run.
// - OMR_COVERAGE_MERGED=1 (set only by scripts/coverage-merge.mjs): adds the
//   per-file gates below. They apply to the Windows+Linux merged report only,
//   because each OS leaves the other's platform branches uncovered.

/** Per-file gate (lines and branches, %) on the merged Windows+Linux coverage. */
export const MERGED_PER_FILE_MIN = { lines: 90, branches: 90 } as const;
export const MERGED_PER_FILE_GATED = [
  "src/verify/exec.ts",
  "src/verify/runner.ts",
  "src/verify/slot.ts",
  "src/verify/reference.ts",
  "src/verify/batch.ts",
  "src/verify/directives.ts",
  "src/verify/risk.ts",
  "src/verify/pending.ts",
  // #90 (C-6): the pure TUI status model and the server side of the TUI effort channel.
  "src/tui/status-model.ts",
  "src/tui/effort-channel.ts",
] as const;

const mergedGates =
  process.env.OMR_COVERAGE_MERGED === "1"
    ? Object.fromEntries(MERGED_PER_FILE_GATED.map((f) => [f, { ...MERGED_PER_FILE_MIN, perFile: true }]))
    : {};

export default defineConfig({
  test: {
    root: ".",
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**", "node_modules/**", "dist/**", "tmp/**"],
    environment: "node",
    // Keeps every test off the real home directory (QA-1.1-17, plan amendment
    // A14): os.homedir() is mocked to the test's own HOME/USERPROFILE redirect or a
    // private temp dir, in any pool. Never run vitest with --pool=threads anyway.
    setupFiles: ["test/setup/home-guard.ts"],
    // QA-2.1-R2-6: tags the run and removes the private temp dirs its workers created (skipped files included).
    globalSetup: ["test/setup/global-guard.ts"],
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
      thresholds: process.env.OMR_COVERAGE_ARTIFACT === "1" ? {} : {
        statements: 80,
        branches: 85,
        functions: 80,
        lines: 80,
        "src/guard/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/verify/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/router/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/escalate/**/*.ts": { branches: 95, lines: 95, functions: 95 },
        "src/telemetry/**/*.ts": { branches: 95, lines: 95, functions: 95 },
        ...mergedGates,
      },
    },
  },
});
