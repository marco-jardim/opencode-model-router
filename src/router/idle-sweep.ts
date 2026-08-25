export const DEFAULT_IDLE_TTL_MS = 60 * 60_000;
export const IDLE_SWEEP_THROTTLE_MS = 5 * 60_000;

export type SweepFn = () => void;

/**
 * Creates a small coordinator for opportunistic idle-TTL sweeps. It is intended
 * to be invoked from an existing hook path; no timers are scheduled.
 *
 * Isolation: each sweeper runs inside its own try/catch, so a throwing sweeper
 * neither propagates out of the coordinator nor prevents the remaining sweepers
 * from running. A throttle window is consumed even when a sweeper throws.
 */
export function createIdleTtlSweeper(
  sweepers: SweepFn[],
  throttleMs = IDLE_SWEEP_THROTTLE_MS,
): (nowMs?: number) => boolean {
  let lastSweepMs: number | null = null;

  return (nowMs = Date.now()): boolean => {
    if (lastSweepMs !== null && nowMs - lastSweepMs < throttleMs) {
      return false;
    }

    lastSweepMs = nowMs;
    for (const sweep of sweepers) {
      try {
        sweep();
      } catch {
        // A failing sweeper must not stop the others (best-effort maintenance).
      }
    }
    return true;
  };
}
