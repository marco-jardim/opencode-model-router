/**
 * Guard profiles (plan §2.6, §2.9 E6). Pure.
 *
 * A dispatch is guarded as a READER (no consecutive-non-producing denial: reading
 * is the work) or as a PRODUCER (the read/draft guard pushes towards a write).
 * Role dispatches carry an explicit `GuardProfile`; tier dispatches are readers when
 * the tier is read-only (#78), when the routed class is review/recon/search, or when
 * the dispatch is uncapped by a justified `CAP:none` + `reason:`.
 */
import type { RoleSpec } from "./roles";

/** Per-delegation guard profile; buildGuardPolicy accepts it optionally. */
export interface GuardProfile {
  kind: "reader" | "producer";
  budget: number;
  cumulative: number;
}

/** Total tool-call budget of a tier dispatch (re-exported as DEFAULT_GUARD_BUDGET by enforce.ts). */
export const TIER_GUARD_BUDGET = 25;

/** Cumulative ceiling across resumed dispatches = this multiple of the total budget. */
export const GUARD_CUMULATIVE_MULTIPLIER = 3;

/**
 * Refused tool calls allowed per dispatch round before every call is refused
 * (QA-P15-1-4): min(budget, REFUSAL_CAP). Refusals are not charged to the
 * budget, so a child can take up to budget + REFUSAL_CAP steps; the host
 * `steps` limit must sit above that (P-4: steps = top budget + REFUSAL_CAP + margin).
 */
export const REFUSAL_CAP = 10;

/** A route-line `budget=` raises a role budget to at most this multiple of it. */
export const ROUTE_BUDGET_RAISE_MAX = 2;

/** Routed task classes whose dispatches read rather than produce. */
export const READER_CLASSES: ReadonlySet<string> = new Set(["review", "recon", "search"]);

export type ReaderReason = "role" | "read-only-tier" | "class" | "uncapped";

export interface ReaderSignals {
  /** A role dispatch's profile: its kind decides alone. */
  profile?: GuardProfile;
  /** The dispatch runs on a read-only tier (`isReadOnlyTier`). */
  readOnlyTier?: boolean;
  /** The routed task class of the dispatch, when known. */
  taskClass?: string | null;
  /** The honoured CAP directive: "none" only for `CAP:none` with a `reason:` line. */
  cap?: number | "none" | null;
}

/** Why a dispatch is guarded as a reader, or null for a producer. */
export function readerReason(signals: ReaderSignals): ReaderReason | null {
  if (signals.profile !== undefined) return signals.profile.kind === "reader" ? "role" : null;
  if (signals.readOnlyTier === true) return "read-only-tier";
  if (typeof signals.taskClass === "string" && READER_CLASSES.has(signals.taskClass)) return "class";
  if (signals.cap === "none") return "uncapped";
  return null;
}

/** A positive integer, or undefined for anything else (NaN, ≤ 0, ±Infinity). */
export function positiveBudget(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 1 ? n : undefined;
}

/**
 * The total budget after a route-line `budget=`: raise-only, at most
 * ROUTE_BUDGET_RAISE_MAX × base. An absent or invalid request keeps the base.
 */
export function raisedBudget(base: number, requested?: number | null): number {
  const asked = positiveBudget(requested);
  if (asked === undefined) return base;
  return Math.min(Math.max(base, asked), base * ROUTE_BUDGET_RAISE_MAX);
}

/** The role's own budget for `tier` (a positive integer), or undefined. */
function ownBudget(role: Pick<RoleSpec, "budget">, tier: string): number | undefined {
  return positiveBudget(Object.prototype.hasOwnProperty.call(role.budget, tier) ? role.budget[tier] : undefined);
}

/**
 * The guard profile of a role dispatch on `tier`: total = the role's budget for the
 * tier, raised by `budget=` up to 2×; cumulative = total × GUARD_CUMULATIVE_MULTIPLIER.
 * A tier the role has no budget for (a floor lifted above the role's ceiling, an
 * invalid entry) gets max(the role's budget for its ceiling tier, TIER_GUARD_BUDGET)
 * (QA-G-A3-7): a lifted dispatch never gets less than the role on its ceiling, nor
 * less than a tier agent. Without a known ceiling: TIER_GUARD_BUDGET.
 */
export function roleGuardProfile(
  role: Pick<RoleSpec, "guard" | "budget"> & { readonly tierRange?: Pick<RoleSpec["tierRange"], "ceiling"> },
  tier: string,
  routeBudget?: number | null,
): GuardProfile {
  const ceiling = role.tierRange === undefined ? undefined : ownBudget(role, role.tierRange.ceiling);
  const base = ownBudget(role, tier) ?? Math.max(ceiling ?? 0, TIER_GUARD_BUDGET);
  const budget = raisedBudget(base, routeBudget);
  return { kind: role.guard, budget, cumulative: budget * GUARD_CUMULATIVE_MULTIPLIER };
}
