/**
 * Vitest config for smoke tests only.
 * Used by `npm run smoke` and direct invocations like:
 *   npx vitest run --config vitest.smoke.config.ts test/smoke/guard-hardblock.smoke.test.ts
 *
 * Intentionally omits the test/smoke/** exclude that is in vitest.config.ts,
 * so smoke tests (gated behind RUN_OC_SMOKE=1) are actually discoverable.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["test/smoke/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tmp/**"],
    environment: "node",
    // Smoke files must run ONE AT A TIME.  Each spawns a real `opencode run`
    // process, and two concurrent opencode processes contend on the CLI's
    // local SQLite state database: the loser dies after ~0.7s with
    // "Error: Unexpected error / database is locked" and exit code 1.
    // Reproduced live — guard-hardblock crashed this way while layer2-gate
    // held the lock, and passed once file parallelism was disabled.
    // Independently, layer2-gate.smoke.test.ts writes and then unlinks a
    // repo-root opencode.json, which would be pulled out from under any
    // sibling smoke file running alongside it.
    fileParallelism: false,
  },
});
