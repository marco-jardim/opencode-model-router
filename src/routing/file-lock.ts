import { randomUUID } from "node:crypto";
import type { PersistFs, OutcomeLogger } from "./outcomes/types";

export const LOCK_STALE_MS = 30_000;
export type LockResult<T> = { status: "ran"; value: T } | { status: "busy" };

/** Exclusive create, bounded attempts, mtime-based stale recovery; never waits on the hot path.
 * A process suspended longer than staleMs can lose its lease: this is a best-effort local-file lock.
 * Lock errors propagate: callers choose whether an unlocked fallback is safe.
 */
export async function withLock<T>(
  fs: PersistFs, dir: string, lockPath: string, now: () => number,
  logger: OutcomeLogger, run: () => Promise<T>, staleMs = LOCK_STALE_MS,
): Promise<LockResult<T>> {
  await fs.mkdirp(dir);
  let acquired = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await fs.createExclusive(lockPath, String(now()))) {
      acquired = true;
      break;
    }
    const held = await fs.stat(lockPath);
    if (held === null) continue;
    if (now() - held.mtimeMs < staleMs) return { status: "busy" };
    const grave = `${lockPath}.stale-${randomUUID()}`;
    try {
      await fs.rename(lockPath, grave);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const moved = await fs.stat(grave);
    if (moved !== null && now() - moved.mtimeMs < staleMs) {
      await fs.rename(grave, lockPath);
      return { status: "busy" };
    }
    try { await fs.unlink(grave); } catch (error) {
      logger.warn("[router] could not remove stale file lock", { error: String(error) });
    }
  }
  if (!acquired) return { status: "busy" };
  try {
    return { status: "ran", value: await run() };
  } finally {
    try { await fs.unlink(lockPath); } catch (error) {
      logger.warn("[router] could not remove file lock", { error: String(error) });
    }
  }
}
