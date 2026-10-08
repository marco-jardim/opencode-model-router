/**
 * Role dispatch policy (plan §2.2–§2.4, P1.2). Pure: no I/O, no clock, no module state.
 *
 * - `grantFor` (T1.2.1): the actions one dispatch may use, inside the role's max policy, with the
 *   separation rule (I4) and the work-root rule applied last so nothing can re-add what they remove.
 * - `authorityFloor` (T1.2.1): the §2.3 table.
 * - `tierBounds` (T1.2.2): the role range ∩ the authority floor ∩ `floorTier` ∩ the running rung, risk and
 *   scope raise-only, route-line pin lifted/clamped into the window.
 */

import type { AuthorityAction, RoleKind, RoleSpec } from "../../router/roles";
import { DETECTIONS } from "../classify/types";
import type { ClassifyResult, ClassifyTrace, Detection, Need, Risk, RouteLine, Scope, TaskFacts } from "../classify/types";

export interface DispatchGrant {
  actions: ReadonlySet<AuthorityAction>;
  notes: readonly string[];
  /**
   * null → local only: no write and no run (`edit` and `router_run` withheld), no path outside the session
   * directory. A fixed egress role (researcher) keeps its egress: it touches no file.
   */
  workRoot: string | null;
}

/**
 * The classify shape a role dispatch is bounded from (`ClassifyResult` → `facts` and `trace.rules`/`trace.routeLine`):
 * pass the classifier result itself, so the raise-only risk/scope of §2.3 cannot be lost by omitting an optional field.
 */
export interface ClassifiedDispatch {
  readonly facts: ClassifyResult["facts"];
  readonly trace: Pick<ClassifyTrace, "rules" | "routeLine">;
}

declare const EFFECTIVE_DETECTION: unique symbol;

/**
 * The EFFECTIVE detection of a dispatch (§2.1, A34): `deterministic` only when the router's own gate runs the acceptance
 * checks for this dispatch, otherwise the weaker of the route-line claim and the prompt's `[acceptance]` block — never
 * `ClassifyResult.detection` (a claim) as is. Built only with {@link effectiveDetection}.
 */
export type EffectiveDetection = Detection & { readonly [EFFECTIVE_DETECTION]: true };

/**
 * Brand a detection the caller has ALREADY resolved as effective (A34). It never raises a value; an unknown value is
 * `none` (the strictest column of §2.3). Do not pass `ClassifyResult.detection` here: that is the route line's claim.
 */
export function effectiveDetection(detection: Detection): EffectiveDetection {
  return ((DETECTIONS as readonly string[]).includes(detection) ? detection : "none") as EffectiveDetection;
}

const BUILTIN_TIERS = ["fast", "medium", "heavy"] as const;

// ---------------------------------------------------------------------------
// Action classes (§2.2)
// ---------------------------------------------------------------------------

/** Canonical action order: grants are built in this order so logs and snapshots are stable. */
const ACTION_ORDER: readonly AuthorityAction[] = [
  "read",
  "glob",
  "grep",
  "router_git",
  "router_run",
  "edit",
  "webfetch",
  "websearch",
  "context7",
  "execute",
];
const KNOWN: ReadonlySet<string> = new Set<string>(ACTION_ORDER);
const LOCAL: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["read", "glob", "grep", "router_git"]);
const EXEC: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["router_run"]);
const WRITE: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["edit"]);
const EGRESS: ReadonlySet<AuthorityAction> = new Set<AuthorityAction>(["webfetch", "websearch", "context7", "execute"]);

function hasAny(actions: ReadonlySet<AuthorityAction>, cls: ReadonlySet<AuthorityAction>): boolean {
  for (const a of cls) if (actions.has(a)) return true;
  return false;
}

/**
 * Static part of a dynamic role's grant (§2.2 table): `general` = local; `implementer` = local + write
 * ("exec only when the task needs it"). Everything else of a dynamic role comes from needs or widening.
 */
function dynamicBase(kind: RoleKind): ReadonlySet<AuthorityAction> {
  return kind === "implement" ? new Set<AuthorityAction>([...LOCAL, ...WRITE]) : LOCAL;
}

/** Notes a grant can carry (exact texts, shared with the runtime and the tests). */
export const GRANT_NOTES = {
  shell: "raw shell is outside roles mode — dispatch a tier agent explicitly",
  web: "web access is outside this role — use `researcher`",
  edit: "edit is outside this role — use `implementer`",
  externalDir: "paths outside the session directory need a work root (root=)",
  noWorkRoot: "no valid work root: write and run withheld",
  separation: "egress dropped: a grant never mixes local, exec or write actions with egress (separation rule)",
} as const;

/**
 * The actions a dispatch may use (§2.2, §2.5).
 *
 * - max = `allow` minus `deny` (unknown action names dropped: configuration never widens authority).
 * - fixed roles: the max; needs only add notes; `widened` is ignored (the ladder is for dynamic roles).
 * - dynamic roles (any mode other than `fixed`, fail-closed): (base ∩ max) ∪ (needs-derived ∩ max) ∪
 *   (widened ∩ max), base per {@link dynamicBase}.
 * - needs (classifier `needs`, plus `routeLine.needs` when the caller passes the route line separately;
 *   `classify()` already merges `needs=` into `facts.needs`, the union is idempotent):
 *   `edit` → edit (note when the result lacks it); `shell`/`network` → `router_run` + the raw-shell note;
 *   `web` → no action, note when the result has no egress; `external_dir` → satisfied by a non-null
 *   work root (P2.1 resolves and validates it), otherwise a note; unknown needs are ignored.
 * - separation (I4): local/exec/write together with egress → egress dropped + note.
 * - `workRoot` null → local only: `edit` and `router_run` withheld + note (I9: no binding, no write, no run);
 *   egress of a fixed egress role is kept. The work root is copied unchanged.
 */
export function grantFor(
  role: RoleSpec,
  facts: TaskFacts,
  widened: readonly AuthorityAction[],
  workRoot: string | null,
  routeLine?: Pick<RouteLine, "needs"> | null,
): DispatchGrant {
  const denied = new Set<string>(role.authority.deny);
  const max = new Set<AuthorityAction>(role.authority.allow.filter((a) => KNOWN.has(a) && !denied.has(a)));
  const needs = new Set<Need | string>([...facts.needs, ...(routeLine?.needs ?? [])]);
  const wantsShell = needs.has("shell") || needs.has("network");

  const actions = new Set<AuthorityAction>();
  if (role.authority.mode === "fixed") {
    for (const a of max) actions.add(a);
  } else {
    const derived: AuthorityAction[] = [...dynamicBase(role.kind)];
    if (needs.has("edit")) derived.push("edit");
    if (wantsShell) derived.push("router_run");
    for (const a of [...derived, ...widened]) if (max.has(a)) actions.add(a);
  }

  const structural: string[] = [];
  if (hasAny(actions, EGRESS) && (hasAny(actions, LOCAL) || hasAny(actions, EXEC) || hasAny(actions, WRITE))) {
    for (const a of EGRESS) actions.delete(a);
    structural.push(GRANT_NOTES.separation);
  }
  /** The role could edit: a missing edit is then the work root's doing (its note), not the role's. */
  const roleEdits = actions.has("edit");
  if (workRoot === null) {
    // QA-P12-1-2: without a validated work root an edit would land in the session directory (the base checkout).
    let withheld = false;
    for (const a of [...WRITE, ...EXEC]) withheld = actions.delete(a) || withheld;
    if (withheld) structural.push(GRANT_NOTES.noWorkRoot);
  }

  const notes: string[] = [];
  if (wantsShell) notes.push(GRANT_NOTES.shell);
  if (needs.has("web") && !hasAny(actions, EGRESS)) notes.push(GRANT_NOTES.web);
  if (needs.has("edit") && !roleEdits) notes.push(GRANT_NOTES.edit);
  if (needs.has("external_dir") && workRoot === null) notes.push(GRANT_NOTES.externalDir);

  return {
    actions: new Set(ACTION_ORDER.filter((a) => actions.has(a))),
    notes: [...notes, ...structural],
    workRoot,
  };
}

// ---------------------------------------------------------------------------
// Tier floor (§2.3)
// ---------------------------------------------------------------------------

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
 * An unknown detection is treated as `none` (the strictest column).
 */
export function authorityFloor(grant: DispatchGrant, detection: Detection, risk: Risk, scope: Scope): string {
  const write = hasAny(grant.actions, WRITE);
  const exec = hasAny(grant.actions, EXEC);
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

// ---------------------------------------------------------------------------
// Tier window (§2.3, T1.2.2)
// ---------------------------------------------------------------------------

export interface TierBoundsOptions {
  /** `enforcement.escalate.floorTier`, or null. */
  floorTier: string | null;
  /** The child's running tier on a resume (never move below it), or null. */
  runningTier: string | null;
  /** Route-line `tier=`, or null. */
  pinTier: string | null;
  /**
   * Active tier order, cheapest first: `engine/ladders.roleTierOrder(cfg, session)`, the same order the role ladder is
   * built on (QA-P12-1-5); empty → `fast`, `medium`, `heavy`.
   */
  tiers: readonly string[];
}

/** Where the effective risk/scope of §2.3 come from besides `facts`. */
export interface EffectiveFactsSources {
  /**
   * The classifier's facts before the route line (`ClassifyResult.trace.rules`). `classify()` lets a route line
   * override `scope` (tier-mode L3); these restore raise-only semantics.
   */
  classifier?: Pick<TaskFacts, "risk" | "scope"> | null;
  /** The route line (`ClassifyResult.trace.routeLine`): raises risk/scope, never lowers them. */
  routeLine?: Pick<RouteLine, "risk" | "scope"> | null;
}

export interface TierBounds {
  floor: string;
  ceiling: string;
  pinned: string | null;
  reasons: readonly string[];
}

type FloorSource = "role" | "authority" | "floorTier" | "running";

const RISK_ORDER: readonly string[] = ["low", "medium", "high"];
const SCOPE_ORDER: readonly string[] = ["single", "multi", "repo"];

/** Highest of `values` in `order`; values not in `order` are ignored; `base` when none is higher. */
function highest<T extends string>(order: readonly string[], base: T, values: ReadonlyArray<T | null | undefined>): T {
  let out = base;
  for (const v of values) if (v != null && order.indexOf(v) > order.indexOf(out)) out = v;
  return out;
}

/**
 * Position of a floor-type tier on `order`. A built-in name missing from the order rounds UP to the
 * cheapest present built-in tier at least as capable; with none, `fast` is vacuous (the cheapest tier) and
 * anything else fails closed to the most capable tier. Any other unknown name fails closed to the top of
 * the order (QA-P12-1-4: a floor is never dropped).
 */
function placeFloor(tier: string, order: readonly string[]): { index: number; exact: boolean; known: boolean } {
  const at = order.indexOf(tier);
  if (at >= 0) return { index: at, exact: true, known: true };
  const rank = tierIndex(tier);
  if (rank < 0) return { index: order.length - 1, exact: false, known: false };
  const up = order.findIndex((t) => tierIndex(t) >= rank);
  if (up >= 0) return { index: up, exact: false, known: true };
  return { index: rank === 0 ? 0 : order.length - 1, exact: false, known: true };
}

/**
 * Position of the role ceiling. A built-in name missing from the order rounds DOWN to the most capable
 * present built-in tier not above it (none → the cheapest tier; the floor then wins). Any other unknown
 * name → null (ignored: no ceiling below the top).
 */
function placeCeiling(tier: string, order: readonly string[]): { index: number; exact: boolean } | null {
  const at = order.indexOf(tier);
  if (at >= 0) return { index: at, exact: true };
  const rank = tierIndex(tier);
  if (rank < 0) return null;
  let down = -1;
  order.forEach((t, i) => {
    const r = tierIndex(t);
    if (r >= 0 && r <= rank) down = i;
  });
  return { index: Math.max(down, 0), exact: false };
}

/**
 * `facts` with the effective risk and scope of §2.3: max(`facts`, `sources.classifier`, `sources.routeLine`) — a route
 * line raises them, never lowers them.
 */
export function effectiveFacts(facts: TaskFacts, sources: EffectiveFactsSources): TaskFacts {
  const risk = highest<Risk>(RISK_ORDER, facts.risk, [sources.classifier?.risk, sources.routeLine?.risk]);
  const scope = highest<Scope>(SCOPE_ORDER, facts.scope, [sources.classifier?.scope, sources.routeLine?.scope]);
  return risk === facts.risk && scope === facts.scope ? facts : { ...facts, risk, scope };
}

/** {@link effectiveFacts} of a classify result: `facts` raised by `trace.rules` and `trace.routeLine` (QA-P12-1-1). */
export function effectiveFactsOf(classified: ClassifiedDispatch): TaskFacts {
  return effectiveFacts(classified.facts, { classifier: classified.trace.rules, routeLine: classified.trace.routeLine });
}

/**
 * Tier window of a dispatch (§2.3).
 *
 * - risk/scope = max(`classified.facts`, `classified.trace.rules`, `classified.trace.routeLine`)
 *   ({@link effectiveFactsOf}): a route line can raise them, never lower them.
 * - `detection` is the EFFECTIVE detection ({@link effectiveDetection}), never `ClassifyResult.detection`.
 * - floor = max(role floor, `authorityFloor(grant, detection, risk, scope)`, `floorTier`, `runningTier`).
 * - ceiling = the role ceiling; when the floor is above it the floor wins and the ceiling is raised to the
 *   floor (the range is widened upward only).
 * - pin (`tier=`): inside [floor, ceiling] → pinned; below → lifted to the floor; above → clamped to the
 *   ceiling; not on the tier order → ignored (`pinned` null).
 * - Tier order = `opts.tiers` (empty → built-in). Built-in floor names missing from it round up, the ceiling
 *   rounds down (see {@link placeFloor}); any other unknown FLOOR name fails closed to the top of the order; an
 *   unknown ceiling or pin name is ignored.
 *
 * Reasons (deduplicated, in order of application):
 * `floor:<source>` a source raised the floor (source = authority | floorTier | running);
 * `round:<source>:<from>-><to>` a built-in name missing from the order was rounded (source adds role | ceiling);
 * `unknown:<source>:<name>-><top>` an unknown floor name was placed at the top of the order (fail closed);
 * `ignore:<source>:<name>` an unknown ceiling or pin name was ignored (source = ceiling | pin);
 * `lift:authority` the authority floor (on a tie it is named first) lifted the pin or the ceiling;
 * `lift:floor` any other floor source (role, floorTier, running) lifted the pin or the ceiling;
 * `clamp:ceiling` a pin above the ceiling was clamped to it.
 */
export function tierBounds(
  role: RoleSpec,
  grant: DispatchGrant,
  classified: ClassifiedDispatch,
  detection: EffectiveDetection,
  opts: TierBoundsOptions,
): TierBounds {
  const listed = opts.tiers.filter((t, i) => typeof t === "string" && t !== "" && opts.tiers.indexOf(t) === i);
  const order: readonly string[] = listed.length > 0 ? listed : BUILTIN_TIERS;
  const reasons: string[] = [];

  const { risk, scope } = effectiveFactsOf(classified);
  const sources: Array<[FloorSource, string | null]> = [
    ["role", role.tierRange.floor],
    ["authority", authorityFloor(grant, detection, risk, scope)],
    ["floorTier", opts.floorTier],
    ["running", opts.runningTier],
  ];

  let floor = 0;
  let owner: FloorSource | null = null;
  for (const [source, tier] of sources) {
    if (tier === null) continue;
    const placed = placeFloor(tier, order);
    if (!placed.known) reasons.push(`unknown:${source}:${tier}->${order[placed.index]}`);
    else if (!placed.exact) reasons.push(`round:${source}:${tier}->${order[placed.index]}`);
    if (placed.index > floor || owner === null) {
      if (placed.index > floor && source !== "role") reasons.push(`floor:${source}`);
      floor = Math.max(floor, placed.index);
      owner = source;
    } else if (placed.index === floor && source === "authority") {
      owner = source;
    }
  }
  const lift = owner === "authority" ? "lift:authority" : "lift:floor";

  let ceiling = order.length - 1;
  const roleCeiling = placeCeiling(role.tierRange.ceiling, order);
  if (roleCeiling === null) reasons.push(`ignore:ceiling:${role.tierRange.ceiling}`);
  else {
    if (!roleCeiling.exact) reasons.push(`round:ceiling:${role.tierRange.ceiling}->${order[roleCeiling.index]}`);
    ceiling = roleCeiling.index;
  }
  if (ceiling < floor) {
    ceiling = floor;
    reasons.push(lift);
  }

  let pinned: string | null = null;
  const pin = opts.pinTier;
  if (pin !== null) {
    const at = order.indexOf(pin);
    if (at < 0) reasons.push(`ignore:pin:${pin}`);
    else if (at < floor) {
      pinned = order[floor]!;
      reasons.push(lift);
    } else if (at > ceiling) {
      pinned = order[ceiling]!;
      reasons.push("clamp:ceiling");
    } else pinned = pin;
  }

  return { floor: order[floor]!, ceiling: order[ceiling]!, pinned, reasons: [...new Set(reasons)] };
}
