import type { BeforeResult } from "../guard/enforce";
import { MAX_DELEGATION_DEPTH_LIMIT } from "./config";
import { MAX_DEPTH_HOPS } from "./depth";
import type { DepthTracker } from "./depth";
import type { EnforcementMode } from "./enforcement";

export const DELEGATION_DEPTH_GUARD = "delegation_depth";
export type DepthGuardResult = BeforeResult & { banner?: string };

const MAX_WARNED_CALLERS = 1_000;
const MAX_WARNED_CAUSES = 100;

function describe(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : `${typeof value}: ${String(value)}`;
  } catch {
    return "unprintable value";
  }
}

/** Runtime seam values are keyed by their bounded printed form, never identity. */
function describeValue(value: unknown): string {
  let printed: string;
  try {
    printed = String(value);
  } catch {
    printed = "unprintable value";
  }
  return `${typeof value}: ${printed}`.slice(0, 80);
}

export function depthLimitMessage(depth: number, max: number): string {
  return `[router] DELEGATION DEPTH LIMIT — this session is at delegation depth ${depth}; enforcement.maxDelegationDepth is ${max}, so it cannot dispatch another subagent. Do this part of the work yourself and report the result; do not retry the dispatch.`;
}

export function depthAdvisoryBanner(depth: number, max: number): string {
  return `[⚠ GUARD:delegation_depth] this session is at delegation depth ${depth}; enforcement.maxDelegationDepth is ${max}. In enforced mode this dispatch would have been refused. Do not dispatch further subagents from this session; do that work yourself.`;
}

/** Pure dispatch decision; the caller owns refusal and advisory-banner delivery. */
export function createDepthGuard(deps: {
  tracker: Pick<DepthTracker, "depthOf">;
  limit: () => number | null;
  mode: (callerSessionID: string | undefined) => EnforcementMode;
  logger: { warn(msg: string): void };
}): { checkDispatch(callerSessionID: string | undefined): Promise<DepthGuardResult> } {
  const warnedCallers = new Set<string>();
  const warnedModes = new Set<unknown>();
  const warnedModeErrors = new Set<unknown>();
  const warnedLimitErrors = new Set<unknown>();
  const warnedDepths = new Set<unknown>();
  const warnedLimits = new Set<unknown>();
  let warnedCaller = false;

  function warn(message: string): boolean {
    try {
      deps.logger.warn(`[router] delegation depth: ${message}`);
      return true;
    } catch {
      // A broken logger must not change an admission decision or reject a call.
      return false;
    }
  }

  function warnUnknown(caller: string): void {
    if (warnedCallers.has(caller)) return;
    if (!warn(`cannot resolve depth for session ${caller}; allowing dispatch.`)) return;
    warnedCallers.add(caller);
    if (warnedCallers.size > MAX_WARNED_CALLERS) {
      warnedCallers.delete(warnedCallers.values().next().value!);
    }
  }

  function warnOnce(causes: Set<unknown>, cause: unknown, message: string): void {
    if (causes.has(cause)) return;
    // Remember only delivered warnings; a broken logger is retried next time.
    if (!warn(message)) return;
    causes.add(cause);
    if (causes.size > MAX_WARNED_CAUSES) causes.delete(causes.values().next().value);
  }

  return {
    async checkDispatch(callerSessionID) {
      // Read both seams on every call so live config and caller-tier changes apply.
      let mode: EnforcementMode = "advisory";
      try {
        const resolved = deps.mode(callerSessionID);
        if (resolved === "off" || resolved === "advisory" || resolved === "enforced") {
          mode = resolved;
        } else {
          const cause = describeValue(resolved);
          warnOnce(warnedModes, cause, `invalid enforcement mode ${cause}; using advisory.`);
        }
      } catch (error) {
        const cause = describe(error);
        warnOnce(warnedModeErrors, cause, `cannot resolve enforcement mode (${cause}); using advisory.`);
      }
      if (mode === "off") return { block: false, mode };

      let max: number | null;
      try {
        max = deps.limit();
      } catch (error) {
        const cause = describe(error);
        warnOnce(warnedLimitErrors, cause, `cannot resolve delegation depth limit (${cause}); using 1.`);
        max = 1;
      }
      if (max === null) return { block: false, mode };
      if (!Number.isInteger(max) || max < 1 || max > MAX_DELEGATION_DEPTH_LIMIT) {
        const cause = describeValue(max);
        warnOnce(warnedLimits, cause, `invalid delegation depth limit ${cause}; using effective limit 1.`);
        max = 1;
      }

      if (typeof callerSessionID !== "string" || callerSessionID === "") {
        if (!warnedCaller) {
          warnedCaller = warn("missing or invalid caller session; allowing dispatch.");
        }
        return { block: false, mode, guard: null };
      }

      let depth: number | undefined;
      try {
        depth = await deps.tracker.depthOf(callerSessionID);
      } catch {
        warnUnknown(callerSessionID);
        return { block: false, mode, guard: null };
      }
      if (depth === undefined) {
        // The tracker owns unknown-depth warnings (including failure/timeout).
        // Phase 2.3 must pass the same plugin logger to tracker and guard: D2
        // requires one warning, not one per layer. Cancellation may be silent.
        // Only invalid callers and tracker contract violations are ours to log.
        return { block: false, mode, guard: null };
      }
      if (!Number.isInteger(depth) || depth < 0) {
        const cause = describe(depth);
        warnOnce(warnedDepths, JSON.stringify([callerSessionID, cause]),
          `invalid depth ${cause} for session ${callerSessionID}; using ${MAX_DEPTH_HOPS}.`);
        depth = MAX_DEPTH_HOPS;
      }

      if (depth + 1 > max) {
        if (mode === "enforced") {
          return { block: true, mode, message: depthLimitMessage(depth, max), guard: DELEGATION_DEPTH_GUARD };
        }
        return { block: false, mode, guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(depth, max) };
      }
      return { block: false, mode, guard: null };
    },
  };
}
