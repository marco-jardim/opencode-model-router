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
  let warnedCaller = false;
  let warnedLimit = false;

  function warn(message: string): void {
    try {
      deps.logger.warn(`[router] delegation depth: ${message}`);
    } catch {
      // A broken logger must not change an admission decision or reject a call.
      return;
    }
  }

  function warnUnknown(caller: string): void {
    if (warnedCallers.has(caller)) return;
    warnedCallers.add(caller);
    if (warnedCallers.size > MAX_WARNED_CALLERS) {
      warnedCallers.delete(warnedCallers.values().next().value!);
    }
    warn(`cannot resolve depth for session ${caller}; allowing dispatch.`);
  }

  function warnOnce(causes: Set<unknown>, cause: unknown, message: string): void {
    if (causes.has(cause)) return;
    causes.add(cause);
    if (causes.size > MAX_WARNED_CAUSES) causes.delete(causes.values().next().value);
    warn(message);
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
          warnOnce(warnedModes, resolved, `invalid enforcement mode ${describe(resolved)}; using advisory.`);
        }
      } catch {
        warn("cannot resolve enforcement mode; using advisory.");
      }
      if (mode === "off") return { block: false, mode };

      let max: number | null;
      try {
        max = deps.limit();
      } catch {
        warn("cannot resolve delegation depth limit; using 1.");
        max = 1;
      }
      if (max === null) return { block: false, mode };
      if (!Number.isInteger(max) || max < 1 || max > MAX_DELEGATION_DEPTH_LIMIT) {
        if (!warnedLimit) {
          warnedLimit = true;
          warn("invalid delegation depth limit; using 1.");
        }
        max = 1;
      }

      if (typeof callerSessionID !== "string" || callerSessionID === "") {
        if (!warnedCaller) {
          warnedCaller = true;
          warn("missing or invalid caller session; allowing dispatch.");
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
        warn(`invalid depth for session ${callerSessionID}; using ${MAX_DEPTH_HOPS}.`);
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
