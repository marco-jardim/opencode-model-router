/**
 * Role dispatch policy contracts (plan §2.3/§2.4). Pure.
 *
 * `authorityFloor` is complete. `grantFor` and `tierBounds` return the most
 * restrictive valid result today (the role's static allow minus deny, no widening,
 * no work root; the role's own range tightened by the authority floor); T1.2.1
 * completes `grantFor` and T1.2.2 completes `tierBounds`.
 */

import type { AuthorityAction, RoleSpec } from "../../router/roles";
import type { Detection, Risk, Scope, TaskFacts } from "../classify/types";

export interface DispatchGrant {
  actions: ReadonlySet<AuthorityAction>;
  notes: readonly string[];
  /** null → no path outside the session directory, no router_run. */
  workRoot: string | null;
}

const BUILTIN_TIERS = ["fast", "medium", "heavy"] as const;

/**
 * The actions a dispatch may use. Most restrictive valid result: the role's
 * `allow` minus its `deny`; `widened` is not applied and `workRoot` is not
 * granted until T1.2.1 completes the derivation.
 */
export function grantFor(
  role: RoleSpec,
  _facts: TaskFacts,
  _widened: readonly AuthorityAction[],
  _workRoot: string | null,
): DispatchGrant {
  const denied = new Set<AuthorityAction>(role.authority.deny);
  const actions = new Set<AuthorityAction>(role.authority.allow.filter((a) => !denied.has(a)));
  return { actions, notes: [], workRoot: null };
}

const WRITE: readonly AuthorityAction[] = ["edit"];
const EXEC: readonly AuthorityAction[] = ["router_run"];

function tierIndex(tier: string): number {
  return (BUILTIN_TIERS as readonly string[]).indexOf(tier);
}

function maxBuiltin(a: string, b: string): string {
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

/**
 * Minimum tier for a grant (floor = max over every matching row of §2.3):
 * - no write (local/egress/exec only): fast
 * - write without exec: deterministic → fast if risk low and scope single, else medium;
 *   grader → medium; none → medium, heavy if risk high
 * - write + exec: deterministic → medium; grader / none → heavy
 */
export function authorityFloor(grant: DispatchGrant, detection: Detection, risk: Risk, scope: Scope): string {
  const has = (set: readonly AuthorityAction[]): boolean => set.some((a) => grant.actions.has(a));
  const write = has(WRITE);
  const exec = has(EXEC);
  let floor = "fast";
  if (write && !exec) {
    if (detection === "deterministic") floor = risk === "low" && scope === "single" ? "fast" : "medium";
    else if (detection === "grader") floor = "medium";
    else floor = risk === "high" ? "heavy" : "medium";
  }
  if (write && exec) {
    floor = maxBuiltin(floor, detection === "deterministic" ? "medium" : "heavy");
  }
  return floor;
}

/**
 * Tier window of a dispatch. Most restrictive valid result today: floor = the
 * highest of the role floor, the authority floor and `floorTier`; ceiling = the
 * role ceiling (raised to the floor if below); `pinned` = `pinTier` when it lies
 * inside the window. T1.2.2 completes the running-tier and tier-list rules.
 */
export function tierBounds(
  role: RoleSpec,
  grant: DispatchGrant,
  facts: TaskFacts,
  detection: Detection,
  opts: {
    floorTier: string | null;
    runningTier: string | null;
    pinTier: string | null;
    tiers: readonly string[];
  },
): { floor: string; ceiling: string; pinned: string | null; reasons: readonly string[] } {
  const order = opts.tiers.length > 0 ? opts.tiers : BUILTIN_TIERS;
  const idx = (t: string): number => order.indexOf(t);
  const higher = (a: string, b: string): string => (idx(b) > idx(a) ? b : a);
  const reasons: string[] = [];
  let floor = role.tierRange.floor;
  const candidates: Array<[string | null, string]> = [
    [authorityFloor(grant, detection, facts.risk, facts.scope), "authority"],
    [opts.floorTier, "floorTier"],
  ];
  for (const [tier, why] of candidates) {
    if (tier !== null && idx(tier) > idx(floor)) {
      floor = higher(floor, tier);
      reasons.push(`floor:${why}`);
    }
  }
  let ceiling = role.tierRange.ceiling;
  if (idx(ceiling) < idx(floor)) {
    ceiling = floor;
    reasons.push("ceiling:raised-to-floor");
  }
  const pin = opts.pinTier;
  const pinned = pin !== null && idx(pin) >= idx(floor) && idx(pin) <= idx(ceiling) ? pin : null;
  if (pin !== null && pinned === null) reasons.push("pin:out-of-range");
  return { floor, ceiling, pinned, reasons };
}
