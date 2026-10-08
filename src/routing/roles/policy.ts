/**
 * Role dispatch policy (plan §2.2–§2.4, P1.2). Pure: no I/O, no clock, no module state.
 *
 * - `grantFor` (T1.2.1): the actions one dispatch may use, inside the role's max policy, with the
 *   separation rule (I4) and the work-root rule applied last so nothing can re-add what they remove.
 * - `authorityFloor` (T1.2.1): the §2.3 table.
 * - `tierBounds` returns the most restrictive valid result today (the role's own range tightened by the
 *   authority floor); T1.2.2 completes it.
 */

import type { AuthorityAction, RoleKind, RoleSpec } from "../../router/roles";
import type { Detection, Need, Risk, RouteLine, Scope, TaskFacts } from "../classify/types";

export interface DispatchGrant {
  actions: ReadonlySet<AuthorityAction>;
  notes: readonly string[];
  /** null → no path outside the session directory, no router_run. */
  workRoot: string | null;
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
  noWorkRoot: "router_run needs a bound work root (root=) — not granted",
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
 * - `workRoot` null → `router_run` not granted + note (I9: no binding, no run); copied unchanged.
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
  if (workRoot === null && actions.delete("router_run")) structural.push(GRANT_NOTES.noWorkRoot);

  const notes: string[] = [];
  if (wantsShell) notes.push(GRANT_NOTES.shell);
  if (needs.has("web") && !hasAny(actions, EGRESS)) notes.push(GRANT_NOTES.web);
  if (needs.has("edit") && !actions.has("edit")) notes.push(GRANT_NOTES.edit);
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
