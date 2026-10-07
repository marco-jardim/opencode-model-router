/**
 * Global setup of the test run (QA-2.1-R2-6): gives every worker the id of this run, and removes at the end the
 * private directories the workers' setup file (home-guard.ts) created, including those of test files that were skipped
 * (they never run `afterAll`, and a worker is not always allowed to exit cleanly). Runs in the main process, where
 * `os.tmpdir()` is the real temp dir. Best effort: a failure is logged, never swallowed, and never fails the run.
 */
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_ID_ENV = "OMR_TEST_RUN_ID";

export function setup(): void {
  process.env[RUN_ID_ENV] = `${process.pid}-${Date.now().toString(36)}`;
}

/** Remove every guard directory of `runId` under `root`; returns how many went away. Errors go to `log`. */
export function removeRunGuardDirs(
  root: string,
  runId: string,
  log: (message: string) => void = (message) => console.warn(message),
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
): number {
  if (runId === "") return 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    log(`global-guard: cannot list ${root}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
  const prefixes = [`omr-home-guard-${runId}-`, `omr-tmp-guard-${runId}-`];
  let removed = 0;
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    try {
      remove(join(root, name));
      removed += 1;
    } catch (error) {
      log(`global-guard: cannot remove ${join(root, name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}

export function teardown(): void {
  removeRunGuardDirs(tmpdir(), process.env[RUN_ID_ENV] ?? "");
}
