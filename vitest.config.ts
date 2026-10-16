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
/**
 * Directory-prefix gates on the merged report (scripts/coverage-merge.mjs): every merged file under a
 * prefix (which ends with "/") must meet the declared minimums, functions included, and a prefix that
 * matches no file fails. Phase 1.4.3 / QA-1.4-9: the executor gate (src/executor/**) is enforced in CI
 * here, as the glob threshold below is off there (OMR_COVERAGE_ARTIFACT=1) and an exact list would
 * leave every new executor file ungated.
 */
export const MERGED_PREFIX_GATED = [{ prefix: "src/executor/", lines: 90, branches: 90, functions: 90 }] as const;

const mergedGates =
  process.env.OMR_COVERAGE_MERGED === "1"
    ? Object.fromEntries(MERGED_PER_FILE_GATED.map((f) => [f, { ...MERGED_PER_FILE_MIN, perFile: true }]))
    : {};

const projectDefaults = {
  root: ".",
  environment: "node" as const,
  // Every project keeps the home redirect and dependency handling of the original pool.
  setupFiles: ["test/setup/home-guard.ts"],
  server: { deps: { inline: ["@opencode-ai/plugin"] } },
};
const excluded = ["test/smoke/**", "node_modules/**", "dist/**", "tmp/**"];

export default defineConfig({
  test: {
    root: ".",
    // Keeps every test off the real home directory (QA-1.1-17, plan amendment
    // A14): os.homedir() is mocked to the test's own HOME/USERPROFILE redirect or a
    // private temp dir, in any pool. Never run vitest with --pool=threads anyway.
    // QA-2.1-R2-6: tags the run and removes the private temp dirs its workers created (skipped files included).
    globalSetup: ["test/setup/global-guard.ts"],
    projects: [
      {
        test: { ...projectDefaults, name: "default", include: ["test/**/*.test.ts"],
          exclude: [...excluded, "test/unit/exec.test.ts"], sequence: { groupOrder: 0 } },
      },
      {
        // G-6 / P-2: lifecycle deadlines need an otherwise idle test pool, not longer timeouts.
        // A separate group runs after the parallel suite; CLI --maxWorkers does not share its fork.
        test: { ...projectDefaults, name: "exec-serial", include: ["test/unit/exec.test.ts"], exclude: excluded,
          pool: "forks", maxWorkers: 1, fileParallelism: false, sequence: { groupOrder: 1 } },
      },
    ],
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
        "src/executor/**/*.ts": { branches: 90, lines: 90, functions: 90 },
        "src/escalate/**/*.ts": { branches: 95, lines: 95, functions: 95 },
        "src/telemetry/**/*.ts": { branches: 95, lines: 95, functions: 95 },
        ...mergedGates,
      },
    },
  },
});
