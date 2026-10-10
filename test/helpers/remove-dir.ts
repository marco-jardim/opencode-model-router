import { rmSync } from "node:fs";

/**
 * Windows refuses to remove a directory while any process has it as its current directory or holds a handle inside it
 * (EBUSY/EPERM/ENOTEMPTY on rmdir). Tests that spawn process trees must therefore wait until the processes are really
 * gone before they remove the scratch dir, and must fail loudly (with the path) when it still cannot be removed.
 */

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** True while `pid` names a live process (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls `check` until it is true or `limitMs` has passed; returns the last result. */
export async function waitUntil(check: () => boolean, limitMs: number, stepMs = 50): Promise<boolean> {
  for (const end = Date.now() + limitMs; ;) {
    if (check()) return true;
    if (Date.now() >= end) return false;
    await sleep(stepMs);
  }
}

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Default overall budget. The callers run this in an `afterEach` hook with an explicit hook timeout well above it
 * (vitest's default is 10 s), so the path-bearing error below is what surfaces, never "Hook timed out".
 */
export const REMOVE_DIR_BUDGET_MS = 8_000;

export interface RemoveDirOptions {
  /** Processes that may hold the directory (cwd or open handle): killed if still alive, then awaited until gone. */
  pids?: readonly number[];
  /** ONE overall budget: waiting for those processes to exit and retrying the removal share it (default 8 s). */
  deadlineMs?: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes `dir` after the processes that may hold it are gone. A process still alive after the deadline, or a removal
 * still failing with a lock error after the deadline, throws an Error naming the path: nothing is swallowed.
 */
export async function removeDirWhenReleased(dir: string, options: RemoveDirOptions = {}): Promise<void> {
  const deadlineMs = options.deadlineMs ?? REMOVE_DIR_BUDGET_MS;
  const end = Date.now() + deadlineMs;
  // `process.kill(0)` would signal the whole process group on POSIX: only real PIDs are touched.
  const pids = (options.pids ?? []).filter(pid => Number.isInteger(pid) && pid > 0);
  for (const pid of pids) {
    if (!pidAlive(pid)) continue;
    try {
      process.kill(pid);
    } catch (error) {
      // Gone between the check and the kill is fine; anything else (EPERM...) is surfaced with the path.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error(`cannot remove ${dir}: cannot kill process ${pid}: ${describe(error)}`);
    }
  }
  const stuck = pids.filter(pid => pidAlive(pid));
  if (stuck.length > 0 && !(await waitUntil(() => stuck.every(pid => !pidAlive(pid)), Math.max(0, end - Date.now())))) {
    throw new Error(`cannot remove ${dir}: process(es) ${stuck.filter(pid => pidAlive(pid)).join(", ")} still alive after ${deadlineMs} ms`);
  }
  let lastError: unknown;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE.has(code)) throw new Error(`cannot remove ${dir}: ${describe(error)}`);
      lastError = error;
    }
    if (Date.now() >= end) break;
    await sleep(100);
  }
  throw new Error(`cannot remove ${dir} within ${deadlineMs} ms: ${describe(lastError)}`);
}
