/**
 * Dispatch-time routing on v2 (M7, Phase 2.2.1): `route()` composes M2 (classify) → ladders → M4 (decide) for one
 * `subagent` call and applies the engine mode; `commit()` writes the decision row (QA-G-A2) and registers the dispatch with the 2.1
 * dispatch-facts registry once the FINAL input is known, so ingestion sees what really ran.
 *
 * Design (the order the adapter calls it in, `src/compat/v2-hooks.ts` `execute.before` / `execute.after`):
 *
 *  1. Engine first. `route()` runs before the `subagentTiers` override and before the legacy `tool.execute.before`.
 *     `subagentTiers` only fills a MISSING `model`: the engine sees the model it would fill (`callModel`) when it
 *     resolves the orchestrator's pick, and when it switches it always writes a model of its own, so the override
 *     never fires after a switch. The legacy hook runs last, so headers and the depth banner see the final agent.
 *  2. Modes (§1.2): `static` returns before any host call, allocation or disk access. `shadow` classifies, decides and
 *     logs (a `switched` row is a would-switch); the input is untouched except that the first-line `[route …]` is
 *     stripped. `advise` is `shadow` plus the protocol/hint of the context hook. `enforce` additionally writes `agent`
 *     and `model#variant` when the kernel switches (D9, A16, A24, A27) and the dispatch is not pinned.
 *  3. Only the orchestrator's own prompt is parsed: the session must be a root session, and the route line only counts
 *     on the first non-empty line of the prompt (A22); every other byte of the prompt passes through unchanged. A
 *     subagent's dispatch is left exactly as it is.
 *  4. Errors never reach the session: any failure is logged and the dispatch proceeds as the orchestrator wrote it.
 *  5. Registration (2.1 handoff, QA-2.1-R2-10; QA-2.2-2/3): once per execution of a child, from the FINAL input.
 *     `route()` only decides; its decision row is held until `commit()` (QA-G-A2: a call the hook chain rejects writes no row; a
 *     call the HOST then fails keeps its row, a known limit — no retraction row). After the legacy hook has had its say, the adapter calls `commit(callID, input)`
 *     with the input the host will execute: a resume (`sessionID` given) is registered at once; a fresh child does not
 *     exist yet, so the dispatch waits and is claimed by the `session.created` event of the child (parent, agent and
 *     title decide which one). `execute.after` then names the child (`onCallResult`): a dispatch still waiting is
 *     registered under it, and a heuristic claim that picked the wrong child is corrected before the verdict is
 *     recorded. A call that ends without a result, or whose hook chain throws, is dropped (`onCallFinished`).
 *  6. Single writer with the delegate runner (QA-2.2-1, QA-2.3-1): the runner (2.3) dispatches its producer and grader children
 *     through the same native tool. It announces each call (`markRunnerDispatch`, keyed by the calling session, the agent and a hash of
 *     the prompt) and `route()` consumes the mark first: the call is left exactly as the runner wrote it (no rewrite, no route-line
 *     strip, no floor lift, no decision row, no registration). The runner's own recorder is the only writer for ladder attempts. A
 *     `session.created` that is the runner's child is never claimed for an orchestrator dispatch (already registered, or titled like a
 *     runner call). MEASURED on the real OpenCode 2.0.22 host (Phase 3.2, H4): the host does NOT run the plugin's `execute.before` /
 *     `execute.after` hooks for calls made through `ctx.tool.list()` natives, so on 2.0.22 `route()` never sees a runner call and the mark
 *     is withdrawn unconsumed (`v2-client.ts`). The mark and the "runner description" rule are defensive: they only matter on a host
 *     that does hook such calls.
 *  7. Multi-instance (A3): MEASURED on 2.0.22 (Phase 3.2, H2): the host hands a SESSION EVENT to the plugin instance of every live
 *     location, but the TOOL HOOKS of a call only to the instance of the session's location. The receiving instance acts; the
 *     process-wide set of handled calls is defensive for hooks. What protects
 *     the store from a duplicated EVENT is the event-id LRU of the ingest (`firstDelivery`) and of the registry. Only the first instance
 *     whose engine is live acts on a call.
 */

import {
  buildLadder, candidateKey, capabilityRank, coversNeeds, decide, detectionOf, escalateLadder, floorRankOf, lowerEffortOnSameModel, resolveChosen,
  tierRankOf, weakerDetection,
} from "../engine";
import { buildRoleLadder, roleTierOrder, routerTierIds } from "../engine/ladders";
import { decideRole } from "../engine/kernel";
import type { Candidate, ChosenDispatch, Decision, HostAgentInfo, Ladder, RoleLadder } from "../engine/types";
import { classify } from "../classify";
import type { ClassifyResult, Detection, TaskFacts } from "../classify/types";
import { resolveVerifyBudget, type RouterConfig } from "../../router/config";
import { resolveEnforcementMode } from "../../router/enforcement";
import { roleGuardProfile } from "../../router/guard-profile";
import { resolveRoles, type AuthorityAction, type RoleSpec } from "../../router/roles";
import { parseVerifyDirectives } from "../../verify/directives";
import { buildDelegationDoD } from "../../verify/dispatch";
import { requestedVerificationCwd, verificationScope } from "../roles/work-root";
import { effectiveDetection, effectiveFactsOf, grantFor, tierBounds, type DispatchGrant, type EffectiveDetection } from "../roles/policy";
import {
  BINDING_NOTES, LOCAL_ACTIONS, currentBinding, evictCall, newDispatchNonce, noncePromptLine, nonceTitleSuffix, registerPending, type Binding,
} from "../roles/binding";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  consumeRunnerDispatch, consumeRunnerDispatchLoose, forgetDispatch, lookupDispatch, rememberDispatch, runnerDescription,
  type DetectionDepth, type DispatchInput, type DispatchRecord,
} from "../../router/sessions";
import { randomBytes } from "node:crypto";
import {
  FLOOR_LIFT_REASON,
  RESUME_REASON,
  RESUME_RUNNING_REASON,
  RESUME_PINNED_REASON,
  RESUME_NAMED_NEEDS_REASON,
  RESUME_NAMED_NEVER_DOWN_REASON,
  ANNOTATION_REASON,
  LOG_ROW_VERSION,
  classifyAgentOrigin,
  makeKey,
  normalizeVariant,
  safeNow,
  splitModelRef,
  type DecisionRow,
  type DecisionTrace,
  type RouteChoice,
} from "../outcomes/types";
import { agentModelRef, type AgentView } from "./host-info";
import { sessionRulesOf, type EngineRuntime, type Prepared, type RolePrepared, type WireLogger } from "./runtime";

/** A fresh dispatch can be claimed by a `session.created` event for at most this long. */
export const PENDING_TTL_MS = 120_000;
/** Bound on dispatches kept for claiming and for the result (oldest dropped first). */
export const MAX_PENDING = 200;
/** A dispatch whose result never arrives is forgotten after this long (the registry's own idle TTL). */
export const ENTRY_TTL_MS = 3_600_000;
/** Bound on the process-wide set of handled calls (LRU). */
export const MAX_HANDLED_CALLS = 4096;

export interface RouteCall {
  /** The tool call id (`event.id`): the dispatch ends with the call. */
  readonly callID: string;
  /** The dispatching (orchestrator) session. */
  readonly sessionID: string;
  /** Its agent. */
  readonly agent: string | undefined;
  /** The call's input in the adapter's legacy vocabulary: `agent` (and `subagent_type`), `prompt`, `description`, `model`, `sessionID` (`task_id`). */
  readonly args: Readonly<Record<string, unknown>>;
  /** The model `subagentTiers` would fill in when the call sets none (the engine resolves the pick with it). */
  readonly tierModel?: string | undefined;
  /** The router config the caller already loaded for this call. */
  readonly cfg?: RouterConfig | undefined;
  /**
   * #84 P2.1, role dispatches only: actions widened for this resume (`consumeAuthority(…).widened`, P1.6). They enter
   * `grantFor(…, widened, …)`, so the authority floor is recomputed on them (handoff 36). Absent = none.
   */
  readonly widened?: readonly AuthorityAction[] | undefined;
}

export interface RouteOutcome {
  readonly mode: "static" | "shadow" | "advise" | "enforce";
  /** The prompt without its first-line `[route …]`; only when something was stripped. Role dispatch: also ends with the nonce line. */
  readonly prompt?: string;
  /** `enforce`: the agent to dispatch instead (never for a pinned dispatch). */
  readonly agent?: string;
  /** `enforce`: `provider/model[#variant]` to dispatch with. Role dispatch: ALWAYS set, in every engine mode (I2). */
  readonly model?: string;
  readonly decisionID?: string;
  /**
   * #84 P2.1, a fresh role dispatch: the description with the nonce title suffix at its END (`nonceTitleSuffix`). The adapter
   * must apply it like `prompt` (P2.1-C: `args.description = routed.description`).
   */
  readonly description?: string;
  /** #84 P2.1: what the role path decided (absent for every tier dispatch). */
  readonly role?: RoleRouted;
}

/** #84 P2.1: one routed role dispatch, as the adapter (P2.1-C) needs it (header root, guard profile, escalation hint). */
export interface RoleRouted {
  readonly callID: string;
  readonly parentSessionID: string;
  /** The role agent. */
  readonly agent: string;
  /** The tier the dispatched rung belongs to (role × tier statistics, guard profile, escalation hint). */
  readonly tier: string;
  /** `provider/model[#variant]` set as the call's `model`. */
  readonly model: string;
  /** `tierBounds(…)` of the dispatch. */
  readonly window: { readonly floor: string; readonly ceiling: string; readonly pinned: string | null };
  readonly grant: DispatchGrant;
  /** The validated work root (canonical long form), or null (no `root=` match, or the session directory could not be resolved). */
  readonly workRoot: string | null;
  /**
   * #84 P3.3 DF2-F1 (QA-P33F1-1-1, 1-3): where the router's gate verifies this dispatch — the grant's work root (a resume keeps the
   * child's bound root, whatever its prompt's route line says), else the canonical session directory (no validated work root).
   */
  readonly verifyRoot: string;
  /** The route line's `root=` as written, or null. */
  readonly requestedRoot: string | null;
  /** Work-root, grant and catalog notes (for the dispatch header / parent result). */
  readonly notes: readonly string[];
  readonly detection: EffectiveDetection;
  /** The dispatch's total call budget (`roleGuardProfile(spec, tier, routeLine.budget).budget`). */
  readonly budget: number;
  /** The route line's `budget=`, or null (pass it to `roleGuardProfile`, handoff 27). */
  readonly routeBudget: number | null;
  /** The nonce registered for a fresh dispatch; null on a resume (no pending entry). */
  readonly nonce: string | null;
  /** The decision row's id; null when no row is written (`engine: static`). */
  readonly decisionID: string | null;
  /** The resumed child (`sessionID`/`task_id`), or null. */
  readonly resumeID: string | null;
  /** The next tier of the role's range above `tier` (escalation hint, P-8); null at the ceiling. */
  readonly nextTier: string | null;
  /** The effective task class of the dispatch (re-dispatch signal, handoff 17); null when unknown. */
  readonly class: string | null;
}

/**
 * #84 P2.1: a role dispatch the router refuses (malformed first route line, no candidate inside the tier window, the router could not
 * route it). `route()` THROWS it — the one exception to "never throws" — so the adapter's `execute.before` fails the call with this
 * message and the host never runs the child. It never falls back to a tier agent (QA-P12-1-5).
 */
export class RoleDispatchRefusal extends Error {
  readonly agent: string;
  readonly reason: string;
  constructor(agent: string, reason: string) {
    super(`[router] role dispatch @${agent} refused: ${reason}`);
    this.name = "RoleDispatchRefusal";
    this.agent = agent;
    this.reason = reason;
  }
}

/** Exact refusal reasons of the role path (shared with the tests). */
export const ROLE_REFUSALS = {
  malformed:
    "the first line of the prompt starts like a route line but is not a valid one (unbalanced, too long, ...); fix it (`[route class=… root=<absolute path>]`) or remove it",
  noPrompt: "the call carries no prompt",
  noCandidate: (floor: string, ceiling: string, reasons: readonly string[]): string =>
    `no model is available inside the tier window ${floor}..${ceiling} (${reasons.join(", ") || "window:no-candidates"}); the router never falls back to a tier agent — fix the preset, or dispatch a tier agent explicitly`,
  failed: (detail: string): string => `the router could not route it (${detail}); retry, or dispatch a tier agent explicitly`,
  session: (detail: string): string => `the dispatching session is unavailable (${detail}); retry`,
} as const;

const UNTOUCHED: RouteOutcome = Object.freeze({ mode: "static" });

/**
 * Titles of the runner's own children (`description` of `v2-client.ts`: `Router <agent> delegation`, `Router result
 * verification`): a `session.created` carrying one is the runner's, never an orchestrator dispatch's.
 */
const RUNNER_CHILD_TITLE = /^Router (?:.+ delegation|result verification)$/;

export interface DispatchRouter {
  /**
   * Decide one `subagent` call. Writes and registers nothing: `commit` writes its decision row and registers it. Never throws, except
   * {@link RoleDispatchRefusal} for a role dispatch the router refuses (#84 P2.1; tier dispatches never throw).
   */
  route(call: RouteCall): Promise<RouteOutcome>;
  /**
   * The input the host is about to execute (`event.input` after the legacy hook ran): write the call's decision row, then register the
   * dispatch from it. A call `route()` did not act on is ignored. Never throws.
   */
  commit(callID: string, input: unknown): void;
  /** A `session.created` event: claim the waiting dispatch of this child, if there is one. Never throws. */
  onSessionCreated(created: { readonly sessionID: unknown; readonly parentID: unknown; readonly agent: unknown; readonly title: unknown }): void;
  /** `execute.after`: the call's result names the child (or `null`). Registers/corrects, then forgets the call. Never throws. */
  onCallResult(callID: string, childSessionID: string | null): void;
  /** The call ended without a result, or its hook chain failed: forget it. */
  onCallFinished(callID: string): void;
  /**
   * QA-P21-1-11 (handoff 20): a role child bound to its dispatch (`bind`). The first time per child, an annotation row records the
   * OBSERVED binding kind (reason `note:binding:<kind>`, `note:binding:unknown` for an unknown one) against its dispatch's decision
   * row; nothing when the engine writes no rows or the dispatch is unknown. Never throws.
   */
  noteBinding(childSessionID: string, binding: Pick<Binding, "kind" | "decisionID">): void;
  /** Dispatches still waiting to be claimed (diagnostics, tests). */
  pendingCount(): number;
  /** Children registered by a wrong heuristic claim and not yet taken over by their own dispatch (diagnostics, tests). */
  misclaimedCount(): number;
  /** This instance is gone: it no longer owns any session directory. Idempotent. */
  dispose(): void;
}

export interface DispatchRouterDeps {
  readonly runtime: EngineRuntime;
  /** `ctx.session.get({ sessionID })`. */
  readonly getSession: (sessionID: string) => Promise<unknown>;
  /** The adapter's own grader agent id: never routed. */
  readonly graderAgent: string;
  /** The default directory of the plugin instance (fallback `cwd` of the classifier). */
  readonly directory: string;
  readonly logger: WireLogger;
  readonly now?: () => number;
  /**
   * #84 P2.1 (role dispatches only): stdout of `git worktree list --porcelain` run in `cwd` (the session directory). Default: `git`
   * through `execFile` (5 s timeout). Injected by tests.
   */
  readonly listWorktrees?: (cwd: string) => Promise<string>;
  /** #84 P2.1: canonical long form of an existing path (default `realpathSync.native`). Only called on an already matched root. */
  readonly realpath?: (path: string) => string;
  /** #84 P2.1: path rules of the work-root comparison (default `process.platform`). */
  readonly platform?: NodeJS.Platform;
  /** #84 P2.1: the router is bypassed for this session (`/bypass`, `src/index.ts`): the verification gate will not run (S10/P-9). */
  readonly isBypassed?: (sessionID: string) => boolean;
  /** #84 P2.1: environment of the enforcement-mode env gate (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * QA-P21-1-8: the role path is live (the plugin STARTED in roles mode, so its role agents and tools exist). `false` → every role
   * agent takes the tier path, as in tiers mode. Default: live.
   */
  readonly rolesEnabled?: (agent: string) => boolean;
  /**
   * QA-P21-2 nit 3: `router_verify` is registered (index.ts `routerVerifyEnabled`); `false` → nothing is deferred, so a deferred
   * directive does not weaken the detection. Absent: treated as registered.
   */
  readonly routerVerifyEnabled?: () => boolean;
}

/** What `route()` decided, until `commit()` has the final input. */
interface Decided {
  readonly parentSessionID: string;
  readonly decisionID: string;
  readonly facts: DecisionRow["facts"];
  readonly acceptance: DetectionDepth;
  readonly description: string | null;
  /**
   * QA-G-A2: the decision row, written by `commit()` — i.e. only for a dispatch whose hook chain let it through to the host. A call the
   * legacy hook rejects (`onCallFinished`) never writes it. Known limit: a call the HOST then fails (`onCallResult` with no child for a
   * fresh dispatch) keeps its row; no retraction row is written.
   */
  readonly row: DecisionRow | null;
  /** Appends a row to the decision log (`Prepared.enqueue` of the call). */
  readonly enqueue: (row: DecisionRow) => void;
  /** A34 (QA-G-B8): the capability rank of what the host is handed (`row.capability.dispatched`); `null` = unknown. */
  readonly capabilityOf: (ran: RanDispatch) => number | null;
  /** What the engine dispatches: the fallback for what the final input leaves out. `null`: the pick resolved to no model (row only). */
  readonly final: { readonly agent: string; readonly model: string; readonly variant: string | null } | null;
  /** The agent the orchestrator NAMED for this dispatch, before the router changed anything: recorded with the child (QA-2.4-R3-1). */
  readonly picked: string;
  readonly routerIds: readonly string[];
  /** Resolve an agent the legacy hook switched to (the same resolution the engine used for the pick). */
  readonly resolve: (agent: string) => ChosenDispatch | null;
  readonly at: number;
  /** #84 P2.1: a role dispatch (absent for every tier dispatch). */
  readonly role?: RoleCommit;
}

/** What `commit()` needs of a role dispatch. */
interface RoleCommit {
  /** The tier of the dispatched rung: the registry's `tier` (running tier on a resume, role × tier rows of ingestion). */
  readonly tier: string;
  /** `false` when the engine is static: no instance may score the attempt (`DispatchInput.outcomes`). */
  readonly outcomes: boolean;
  /** The pending binding entry to register (a fresh dispatch); null on a resume. */
  readonly pending: { readonly nonce: string; readonly grant: DispatchGrant; readonly budget: number; readonly description: string; readonly decisionID: string | null } | null;
}

/** A committed dispatch, kept until its call ends. */
interface Entry {
  readonly callID: string;
  readonly parentSessionID: string;
  readonly agent: string;
  readonly description: string | null;
  readonly input: DispatchInput;
  readonly at: number;
  /** A resume: the child it was registered under, and what the registry held for it before (QA-2.2-R2-1). */
  readonly resumeID?: string;
  readonly previous?: DispatchRecord;
  /** `waiting`: no child yet; `claimed`: a `session.created` was matched to it; `resumed`: registered at commit. */
  state: "waiting" | "claimed" | "resumed";
  claimedChild?: string;
  /** #84 P2.1: a binding entry was registered for this call (`registerPending`); a rejected call evicts it. */
  rolePending?: true;
  /** QA-P21-1-11: a role dispatch's decision row and its log, for the binding annotation row (absent: no rows). */
  roleRow?: { readonly row: DecisionRow; readonly enqueue: (row: DecisionRow) => void };
}

/**
 * A3: every plugin instance of the process may be handed the same hook event. The first instance whose engine is live
 * claims the call; the others leave it alone (the first one already routed, logged and will register it).
 */
const handledCalls = new Set<string>();

function claimCall(key: string): boolean {
  if (handledCalls.has(key)) return false;
  handledCalls.add(key);
  while (handledCalls.size > MAX_HANDLED_CALLS) handledCalls.delete(handledCalls.values().next().value as string);
  return true;
}

/** Bound on children with pending subagent-result annotations (oldest dropped first). */
export const MAX_ANNOTATED_CHILDREN = 256;
/** Bound on annotations kept per child (oldest dropped first). */
export const MAX_ANNOTATIONS_PER_CHILD = 8;

export interface SubagentAnnotation {
  readonly kind: "budget" | "authority";
  readonly text: string;
}

/** Process-wide: annotations for the parent's `subagent` result, keyed by child session. */
const subagentAnnotations = new Map<string, SubagentAnnotation[]>();

/**
 * Seam: record an annotation to be appended to the parent's `subagent` result of `childSessionID`.
 * Bounded; consumed once by {@link takeSubagentAnnotations}.
 */
export function annotateSubagentResult(kind: "budget" | "authority", childSessionID: string, text: string): void {
  const list = subagentAnnotations.get(childSessionID) ?? [];
  subagentAnnotations.delete(childSessionID);
  list.push({ kind, text });
  while (list.length > MAX_ANNOTATIONS_PER_CHILD) list.shift();
  subagentAnnotations.set(childSessionID, list);
  while (subagentAnnotations.size > MAX_ANNOTATED_CHILDREN) subagentAnnotations.delete(subagentAnnotations.keys().next().value as string);
}

/** The annotations recorded for `childSessionID`, in order; they are removed (a second call returns none). */
export function takeSubagentAnnotations(childSessionID: string): readonly SubagentAnnotation[] {
  const list = subagentAnnotations.get(childSessionID);
  if (list === undefined) return [];
  subagentAnnotations.delete(childSessionID);
  return list;
}

// ---------------------------------------------------------------------------
// #84 P2.1 (T2.1.2): role dispatch path — exported API for the adapter (P2.1-C)
// ---------------------------------------------------------------------------

/** Bound on routed role dispatches kept for the adapter (oldest dropped first). */
export const MAX_ROUTED_ROLES = 1000;

/** Process-wide: the routed role dispatch of each call id, for the legacy hook (header) and `execute.after` (hint). */
const routedRoles = new Map<string, RoleRouted>();

function rememberRoutedRole(routed: RoleRouted): void {
  routedRoles.delete(routed.callID);
  routedRoles.set(routed.callID, routed);
  while (routedRoles.size > MAX_ROUTED_ROLES) routedRoles.delete(routedRoles.keys().next().value as string);
}

/** The role dispatch `route()` decided for `callID` (kept until {@link forgetRoutedRole}, a rejected call, or the LRU bound). */
export function routedRoleOf(callID: string): RoleRouted | undefined {
  return routedRoles.get(callID);
}

/**
 * Handoff 30: the routed decision's work root for `buildDispatchHeader` (canonical long form). `undefined` = not a routed role
 * dispatch (tier dispatches: the tier path does not resolve roots); `null` = a role dispatch without a validated work root.
 */
export function routedWorkRoot(callID: string): string | null | undefined {
  const routed = routedRoles.get(callID);
  return routed === undefined ? undefined : routed.workRoot;
}

/** Drop what `route()` kept for `callID` (the adapter calls it once `execute.after` is done with it). */
export function forgetRoutedRole(callID: string): void {
  routedRoles.delete(callID);
  strippedRoots.delete(callID);
}

/**
 * Handoff 30 (tier dispatches, v2 shadow/advise/enforce): the `root=` of the first-line route line `route()` stripped from the
 * prompt, so the legacy hook's dispatch header can still name it (T1.5.3a). Process-wide, bounded like {@link routedRoles}.
 */
const strippedRoots = new Map<string, string>();

function rememberStrippedRoot(callID: string, root: string): void {
  strippedRoots.delete(callID);
  strippedRoots.set(callID, root);
  while (strippedRoots.size > MAX_ROUTED_ROLES) strippedRoots.delete(strippedRoots.keys().next().value as string);
}

/** The route line's `root=` of a tier dispatch whose route line `route()` stripped; undefined otherwise. */
export function strippedRouteRoot(callID: string): string | undefined {
  return strippedRoots.get(callID);
}

/** A role's max authority (allow − deny, never `execute`): the `maxOf` of `bind` / `currentBinding` (handoff 33). */
export function roleMaxActions(spec: RoleSpec | undefined): readonly AuthorityAction[] | undefined {
  if (spec === undefined) return undefined;
  return spec.authority.allow.filter((action) => action !== "execute" && !spec.authority.deny.includes(action));
}

/**
 * Text form of a path for the work-root comparison, WITHOUT touching the filesystem: separators unified (win32: `/` → `\`),
 * repeated separators and `.` segments dropped, the trailing separator dropped (a drive or POSIX root keeps it), case folded on win32.
 */
export function normalizeRootText(path: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  let text = path.trim();
  if (win) text = text.replace(/\//g, "\\");
  const absolute = text.startsWith(sep);
  const parts = text.split(sep).filter((part) => part !== "" && part !== ".");
  let out = (absolute ? sep : "") + parts.join(sep);
  if (win && /^[A-Za-z]:$/.test(out)) out += sep; // `D:\` stays a root
  if (out === "") out = absolute ? sep : "";
  return win ? out.toLowerCase() : out;
}

/**
 * The worktree paths of `git worktree list --porcelain` output (the `worktree <path>` line of each entry), as git prints them, in
 * git's order (the main worktree first). QA-P23-A4: an entry git marks `prunable` (its directory is gone or no longer points
 * back) is dropped — it is not a work root any more, even if a plain directory now sits at its path.
 */
export function parseWorktreeList(porcelain: string): string[] {
  const out: string[] = [];
  let current: string | undefined;
  let prunable = false;
  const flush = (): void => {
    if (current !== undefined && !prunable) out.push(current);
    current = undefined;
    prunable = false;
  };
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      flush();
      if (line.length > "worktree ".length) current = line.slice("worktree ".length);
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      prunable = true;
    }
  }
  flush();
  return out;
}

export interface WorkRootResolution {
  /** Canonical long form (`realpathSync.native`) of the validated root; null = no validated work root. */
  readonly workRoot: string | null;
  /** The route line's `root=` as written, or null. */
  readonly requested: string | null;
  /** Why there is no work root (for the grant notes and the dispatch header); null when resolved. */
  readonly note: string | null;
}

export interface WorkRootDeps {
  readonly listWorktrees: (cwd: string) => Promise<string>;
  readonly realpath: (path: string) => string;
  readonly platform: NodeJS.Platform;
}

/** `git worktree list --porcelain` in `cwd` (stdout); rejects on any failure. */
export function gitWorktreeList(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["worktree", "list", "--porcelain"], { cwd, timeout: 5_000, windowsHide: true, maxBuffer: 1 << 20, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * The work root of a role dispatch (plan §2.2, handoff 8). `root` comes ONLY from `ClassifyResult.trace.routeLine.root` (never a
 * re-parse of the prompt).
 * - no `root=` → the session directory (canonical long form);
 * - `root=` → its normalised TEXT is compared with the session directory and with every worktree of `git worktree list --porcelain`
 *   (run in the session directory) BEFORE any filesystem call on it; a match → the canonical long form of the matched entry;
 * - anything else (no match, git unavailable, an entry that does not resolve) → `workRoot: null` with a note.
 * Never throws.
 */
export async function resolveRoleWorkRoot(
  input: { readonly root: string | null; readonly sessionDirectory: string },
  deps: WorkRootDeps,
): Promise<WorkRootResolution> {
  const canonical = (path: string): string | null => {
    try {
      const resolved = deps.realpath(path);
      return typeof resolved === "string" && resolved !== "" ? resolved : null;
    } catch {
      return null;
    }
  };
  if (input.root === null) {
    const dir = canonical(input.sessionDirectory);
    return dir === null
      ? { workRoot: null, requested: null, note: `the session directory ${input.sessionDirectory} could not be resolved: no work root` }
      : { workRoot: dir, requested: null, note: null };
  }
  const want = normalizeRootText(input.root, deps.platform);
  let match: string | undefined = normalizeRootText(input.sessionDirectory, deps.platform) === want ? input.sessionDirectory : undefined;
  if (match === undefined) {
    let listed: string[] = [];
    try {
      listed = parseWorktreeList(await deps.listWorktrees(input.sessionDirectory));
    } catch {
      listed = [];
    }
    match = listed.find((path) => normalizeRootText(path, deps.platform) === want);
  }
  const none = `root=${input.root} is neither the session directory nor a worktree listed by \`git worktree list --porcelain\`: no work root`;
  if (match === undefined) return { workRoot: null, requested: input.root, note: none };
  const resolved = canonical(match);
  return resolved === null
    ? { workRoot: null, requested: input.root, note: `root=${input.root} does not resolve on disk: no work root` }
    : { workRoot: resolved, requested: input.root, note: null };
}

/**
 * S10/P-9 (agent-agnostic): the router's own verification gate will run deterministic checks for this dispatch — the call is a
 * `task`/`subagent` (always, here), `enforcement.mode ≠ off` (env gate included), `verify.require ≠ never` (the condition of
 * `verify/dispatch.shouldVerifyTask`), the router is not bypassed, and the prompt's `[acceptance]` block carries a machine check.
 */
export function roleRouterGate(input: {
  readonly cfg: RouterConfig;
  readonly bypassed: boolean;
  /** `detectionOf(prompt)`: the depth of the prompt's own `[acceptance]` block. */
  readonly acceptance: Detection;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * QA-P21-1-2: the dispatch's verification is DEFERRED (`roleGateDeferred`): the gate does not run at the return, so the
   * detection is never `deterministic` on its account. Absent = not deferred.
   */
  readonly deferred?: boolean;
  /**
   * #84 P3.3 DF2-F1: the gate cannot run the checks in the dispatch's work root ({@link roleGateOutsideWorkRoot}), so the
   * detection is never `deterministic` on its account. Absent = it can.
   */
  readonly outsideWorkRoot?: boolean;
}): boolean {
  if (input.bypassed || input.deferred === true || input.outsideWorkRoot === true || input.acceptance !== "deterministic") return false;
  let mode = "off";
  try {
    mode = resolveEnforcementMode({ config: input.cfg, env: { ...(input.env ?? process.env) } }).mode;
  } catch {
    mode = "off";
  }
  if (mode === "off") return false;
  return (input.cfg.enforcement?.verify?.require ?? "whenDoDPresent") !== "never";
}

/**
 * QA-P21-1-2: the dispatch's verification would be deferred, exactly as the native path decides it (index.ts `isDeferred` →
 * verify/wiring.ts `isDeferred`): its `VERIFY:` directives resolve to `deferred` (the configured `defaultVerify` when the text has
 * none; the text is `dispatchDirectiveText(prompt, description)`) AND its DoD carries a `testsPass` check. A deferred dispatch
 * returns without the gate (`router_verify` runs it later), so the router's gate cannot back a `deterministic` detection.
 * Fails toward "deferred" on any error (a weaker detection, never a stronger one). QA-P21-2 nit 3: nothing is deferred when
 * `router_verify` is not registered (`verifyEnabled: false`, index.ts `routerVerifyEnabled`): the gate then runs at the return.
 */
export function roleGateDeferred(cfg: RouterConfig, prompt: string, description: string, opts: { readonly verifyEnabled?: boolean } = {}): boolean {
  if (opts.verifyEnabled === false) return false;
  try {
    const text = prompt.trim() !== "" ? prompt : description; // verify/wiring.ts dispatchDirectiveText
    const budget = resolveVerifyBudget(cfg);
    const directives = parseVerifyDirectives(text, {
      defaultVerify: budget.defaultVerify, captureWaitMs: budget.captureWaitMs, baselineTimeoutMs: budget.baselineTimeoutMs,
    });
    if (directives.mode !== "deferred") return false;
    return buildDelegationDoD({ prompt, description }).checks.some((check) => check.kind === "testsPass");
  } catch {
    return true;
  }
}

/**
 * #84 P3.3 DF2-F1: the router's gate verifies a role dispatch in its work root (index.ts `verificationScopeOf` → gate
 * `Delegation.workRoot`). It cannot when the dispatch has no validated work root (`workRoot: null`), or when the requested cwd —
 * the call's `cwd` argument, else the `[acceptance]` block's `cwd:` (`requestedVerificationCwd`, the after-hook's order, nit 3) —
 * lies outside that root by P2.3's rule (`verificationScope`; the gate refuses it: unverifiable). Then the router's gate cannot
 * back a `deterministic` detection. `workRoot` is the GRANT's root (QA-P33F1-1-1: a resume keeps the child's bound root). Fails
 * toward "outside" on any error (a weaker detection, never a stronger one).
 *
 * What the decision row records is decided HERE, at dispatch: a gate that later reports the delegation unverifiable for a reason
 * only the return shows (every change outside the work root, a timeout, a verifier error) does not rewrite the row — its verdict
 * carries the caveat (`[router ⚠ UNVERIFIED …]`) and is never accepted as verified.
 */
export function roleGateOutsideWorkRoot(workRoot: string | null, prompt: string, description: string, argsCwd?: unknown): boolean {
  if (workRoot === null) return true;
  try {
    return verificationScope(requestedVerificationCwd(argsCwd, buildDelegationDoD({ prompt, description }).cwd), workRoot).outside;
  } catch {
    return true;
  }
}

/** QA-P33F1-1-1 / 1-3: where the gate verifies a role dispatch — the grant's work root, else the canonical session directory. */
function verifyRootOf(grant: DispatchGrant, sessionDirectory: string, realpath: (path: string) => string): string {
  if (grant.workRoot !== null) return grant.workRoot;
  try {
    const real = realpath(sessionDirectory);
    return typeof real === "string" && real !== "" ? real : sessionDirectory;
  } catch {
    return sessionDirectory;
  }
}

/** The tier above `current` on `order`, up to the role's `ceiling`; null at (or above) the ceiling or when either is not on the order. */
export function nextRoleTier(order: readonly string[], ceiling: string, current: string | null): string | null {
  if (current === null) return null;
  const at = order.indexOf(current);
  const top = order.indexOf(ceiling);
  if (at < 0 || top < 0 || at >= top) return null;
  return order[at + 1] ?? null;
}

/**
 * P-8 (handoff 39), QA-P21-2-2: the role-aware escalation hint after a verification FAIL — resume the SAME child with the findings;
 * the router itself raises it to the next tier of the role's range ({@link roleEscalationAfterFail} records the raise, the next
 * resume applies it). The orchestrator sets neither `model` nor a `tier=` pin, and never names a tier agent. Pure.
 */
export function roleEscalationHint(input: {
  readonly agent: string;
  readonly childSessionID: string | null;
  readonly currentTier: string | null;
  readonly nextTier: string | null;
}): string {
  const task = input.childSessionID === null ? "the same sessionID" : `the same sessionID ("${input.childSessionID}")`;
  if (input.nextTier === null) {
    const top = input.currentTier === null ? "" : ` (it already runs on its highest tier, ${input.currentTier})`;
    return `NEXT: resume ${task} with @${input.agent} and the findings${top}; set neither \`model\` nor \`tier=\`; do not start a new task and do not treat the prior result as complete.`;
  }
  const from = input.currentTier === null ? "" : ` from ${input.currentTier}`;
  return `NEXT: resume ${task} with @${input.agent} and the findings; the router raises it to ${input.nextTier}${from}; set neither \`model\` nor \`tier=\`; do not start a new task.`;
}

/** The child's role, running tier and next tier of its role range, from the dispatch registry; null when it is not a role child. */
function escalationOf(cfg: RouterConfig, childSessionID: string): { agent: string; current: string | null; next: string | null } | null {
  const record = lookupDispatch(childSessionID);
  if (record === undefined) return null;
  const spec = resolveRoles(cfg, "v2").get(record.agent);
  if (spec === undefined) return null;
  const current = record.tier ?? null;
  return { agent: record.agent, current, next: nextRoleTier(roleTierOrder(cfg), spec.tierRange.ceiling, current) };
}

/**
 * {@link roleEscalationHint} for a child the router registered: its role and running tier from the dispatch registry, the next
 * tier from the role's range on `roleTierOrder(cfg)`. `null` when the child is not a role dispatch of roles mode. Records nothing.
 */
export function roleEscalationHintFor(cfg: RouterConfig, childSessionID: string): string | null {
  const e = escalationOf(cfg, childSessionID);
  return e === null ? null : roleEscalationHint({ agent: e.agent, childSessionID, currentTier: e.current, nextTier: e.next });
}

/** QA-P21-2-2: pending raises, child → the parent that may consume it and the tier (bounded, oldest out; 30 min TTL). */
export const MAX_RESUME_RAISES = 1000;
export const RESUME_RAISE_TTL_MS = 30 * 60 * 1000;
const resumeRaises = new Map<string, { readonly parentSessionID: string; readonly tier: string; readonly at: number }>();

/**
 * QA-P21-2-2 ("the router raises the tier"): the hint emitted after a verification FAIL of a role child, AND the raise it promises:
 * the next tier of the role's range is recorded for the child, consumed once by `parentSessionID`'s next resume of that child,
 * which applies it as a raise-only floor. Nothing is recorded at the ceiling. `null` when the child is not a role child.
 */
export function roleEscalationAfterFail(cfg: RouterConfig, childSessionID: string, parentSessionID: string): string | null {
  const e = escalationOf(cfg, childSessionID);
  if (e === null) return null;
  if (e.next !== null && parentSessionID !== "") {
    resumeRaises.delete(childSessionID);
    resumeRaises.set(childSessionID, { parentSessionID, tier: e.next, at: Date.now() });
    while (resumeRaises.size > MAX_RESUME_RAISES) resumeRaises.delete(resumeRaises.keys().next().value as string);
  }
  return roleEscalationHint({ agent: e.agent, childSessionID, currentTier: e.current, nextTier: e.next });
}

/** The raise recorded for this parent's resume of the child (not consumed), or null. */
export function pendingResumeRaise(childSessionID: string, parentSessionID: string): string | null {
  const raise = resumeRaises.get(childSessionID);
  if (raise === undefined) return null;
  if (Date.now() - raise.at >= RESUME_RAISE_TTL_MS) {
    resumeRaises.delete(childSessionID);
    return null;
  }
  return raise.parentSessionID === parentSessionID ? raise.tier : null;
}

/** `prompt` with `line` as its LAST line (every byte of `prompt` kept). */
function withLastLine(prompt: string, line: string): string {
  if (prompt === "") return line;
  return prompt.endsWith("\n") ? `${prompt}${line}` : `${prompt}\n${line}`;
}

/** The catalog's variant ids of `model`; `null` when the catalog does not know the model (then nothing is dropped). */
function catalogVariantIds(catalog: RolePrepared["catalog"], model: string): string[] | null {
  let entry: ReturnType<RolePrepared["catalog"]["entry"]>;
  try {
    entry = catalog.entry(model);
  } catch {
    return null;
  }
  if (entry === undefined) return null;
  const variants = Array.isArray(entry.variants) ? entry.variants : [];
  return variants.flatMap((v) => (v !== null && v !== undefined && typeof v.id === "string" ? [v.id] : []));
}

/**
 * An explicit caller `model` on a role dispatch: kept when it is a rung of the window (inside the bounds); above the ceiling →
 * clamped to the ceiling's rung (the pin rule of `tierBounds`); anything else (below the floor, unknown) → lifted to the floor's
 * rung. On a resume it never moves below what the kernel decided (the running rung).
 */
function placeCallerModel(
  ladder: RoleLadder,
  ref: string,
  decided: Candidate,
  resumed: boolean,
): { readonly candidate: Candidate; readonly code: string } {
  const parts = splitModelRef(ref);
  const model = parts === null ? ref : `${parts.provider}/${parts.model}`;
  const variant = parts === null ? null : parts.variant;
  const cands = ladder.candidates;
  const inside = cands.find((c) => c.model === model && (variant === null || normalizeVariant(c.variant) === normalizeVariant(variant)));
  if (inside !== undefined) {
    if (resumed && inside.rank < decided.rank) return { candidate: decided, code: "kept:caller-model:resume" };
    return { candidate: inside, code: "kept:caller-model" };
  }
  const firsts = ladder.tiers.flatMap((t) => (t.first === null ? [] : [t.first]));
  const floor = cands[firsts[0] ?? 0] ?? decided;
  const ceiling = cands[firsts[firsts.length - 1] ?? 0] ?? decided;
  const rank = capabilityRank(ladder, { model, variant }, null);
  const placed = rank !== null && ladder.ceilingRank !== null && rank > ladder.ceilingRank
    ? { candidate: ceiling, code: "clamp:caller-model:ceiling" }
    : { candidate: floor, code: "lift:caller-model:floor" };
  return resumed && placed.candidate.rank < decided.rank ? { candidate: decided, code: "kept:caller-model:resume" } : placed;
}

/** QA-P21-2-2: the note of a resume raised after a verification FAIL (`raise:verification-fail:<tier>`). */
export const RESUME_RAISE_NOTE = "raise:verification-fail:";

/** The higher of two tiers on `order` (unknown or null ones ignored); null when neither is on it. */
function higherTier(order: readonly string[], a: string | null, b: string | null): string | null {
  const ia = a === null ? -1 : order.indexOf(a);
  const ib = b === null ? -1 : order.indexOf(b);
  if (ia < 0 && ib < 0) return a ?? b; // let tierBounds report an unknown floorTier as before
  return ia >= ib ? a : b;
}

/**
 * QA-P21-2-1: the grant of a resume of an EXACTLY bound child: what the child holds (its bound grant) plus the actions widened for
 * this resume. Only adds; `router_run` stays withheld without a work root (I9). The work root is the bound one, else the resume's.
 */
function resumedGrant(boundGrant: DispatchGrant, widened: readonly AuthorityAction[], workRoot: string | null): DispatchGrant {
  const root = boundGrant.workRoot ?? workRoot;
  const actions = new Set<AuthorityAction>([...boundGrant.actions, ...widened]);
  if (root === null) actions.delete("router_run");
  return { actions, notes: [...boundGrant.notes], workRoot: root };
}

/** QA-P21-1-1: the note of a delegate's role dispatch (unparsed, floor rung of the unknown-binding window). */
export const DELEGATE_DISPATCH_NOTE =
  "delegate dispatch: the prompt is not routed (a delegate never pins or steers); the floor rung of the role's local-only window is dispatched";
/** QA-P21-1-5: the reason code of a route-line pin that wins over an explicit caller `model`. */
export const PIN_OVER_CALLER_REASON = "pin:over-caller-model";
/** QA-P21-1-6: no window rung present in the host catalog at or above the floor (the role dispatch is refused). */
export const VARIANT_NO_CANDIDATE_REASON = "variant:no-catalog-candidate";

/**
 * QA-P21-1-6: what is dispatched for the picked rung given the host catalog. Its variant exists (or the catalog does not know the
 * model) → the rung as is. Otherwise the bare model, at its OWN capability rank (`capabilityRank(ladder, { model, variant: null })`),
 * when that rank reaches the window floor; else the next window rung present in the catalog at or above the floor; `null` when
 * there is none (the caller refuses).
 */
function placeInCatalog(
  ladder: RoleLadder,
  picked: Candidate,
  catalog: RolePrepared["catalog"],
): { readonly candidate: Candidate; readonly variant: string | null; readonly dropped: string | null } | null {
  const variantOf = (c: Pick<Candidate, "variant">): string | null => (normalizeVariant(c.variant) === "default" ? null : normalizeVariant(c.variant));
  const present = (c: Candidate): boolean => {
    const v = variantOf(c);
    if (v === null) return true;
    const ids = catalogVariantIds(catalog, c.model);
    return ids === null || ids.includes(v);
  };
  if (present(picked)) return { candidate: picked, variant: variantOf(picked), dropped: null };
  const wanted = variantOf(picked);
  const floorRank = ladder.floorRank;
  const bareRank = capabilityRank(ladder, { model: picked.model, variant: null }, null);
  if (bareRank !== null && (floorRank === null || bareRank >= floorRank)) {
    return {
      candidate: { ...picked, variant: null, rank: bareRank },
      variant: null,
      dropped: `variant ${wanted} of ${picked.model} is not in the host catalog: dispatched on the tier model without a variant (capability rank ${bareRank})`,
    };
  }
  const at = ladder.candidates.indexOf(picked);
  const next = ladder.candidates.slice(at < 0 ? 0 : at + 1).find((c) => present(c) && (floorRank === null || c.rank >= floorRank));
  if (next === undefined) return null;
  return {
    candidate: next,
    variant: variantOf(next),
    dropped: `variant ${wanted} of ${picked.model} is not in the host catalog and the bare model ranks below the window floor: dispatched on ${refOf(next.model, variantOf(next))}`,
  };
}

/** Test-only: forget which calls were handled. */
export function resetDispatchRouting(): void {
  handledCalls.clear();
  subagentAnnotations.clear();
  routedRoles.clear();
  strippedRoots.clear();
  resumeRaises.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The child session a finished `subagent` call names (`result.output.sessionID`, else `result.metadata.sessionID`; spike S1). */
export function childSessionOf(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const output = result.output;
  const fromOutput = isRecord(output) ? str(output.sessionID) : null;
  if (fromOutput !== null) return fromOutput;
  return isRecord(result.metadata) ? str(result.metadata.sessionID) : null;
}

interface SessionView {
  readonly parentID: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly directory: string | null;
  readonly rules: ReturnType<typeof sessionRulesOf>;
}

function readSession(raw: unknown): SessionView {
  const session = isRecord(raw) ? raw : {};
  const location = isRecord(session.location) ? session.location : {};
  return {
    parentID: str(session.parentID),
    agent: str(session.agent),
    model: agentModelRef(session.model),
    directory: str(location.directory),
    rules: sessionRulesOf(session),
  };
}

/** The row's `facts` (1.3's structural view of `TaskFacts`). */
function factsOf(facts: TaskFacts): DecisionRow["facts"] {
  return { class: facts.class, risk: facts.risk, scope: facts.scope, needs: [...facts.needs], confidence: facts.confidence, source: facts.source };
}

function traceOf(result: ClassifyResult, argmin: RouteChoice | null): DecisionTrace {
  const { routeLines, backend, backendSkipped } = result.trace;
  return {
    routeLines: { count: routeLines.count, conflict: routeLines.conflict, edgeOnly: routeLines.edgeOnly },
    backend: backend === null
      ? null
      : {
          id: backend.id,
          status: backend.status,
          latencyMs: backend.latencyMs,
          ...(backend.label === undefined ? {} : { label: backend.label }),
          ...(backend.rejected === true ? { rejected: true as const } : {}),
          ...(backend.disagrees === true ? { disagrees: true as const } : {}),
        },
    ...(backendSkipped === undefined ? {} : { backendSkipped }),
    ...(argmin === null ? {} : { argmin }),
  };
}

function choiceOf(cls: string, dispatch: ChosenDispatch): RouteChoice {
  const key = candidateKey(cls, dispatch);
  return { key, agent: dispatch.agent.id, origin: dispatch.agent.origin, model: dispatch.model, variant: normalizeVariant(dispatch.variant) };
}

/** `provider/model[#variant]`. */
function refOf(model: string, variant: string | null): string {
  return variant === null || variant === "" || variant === "default" ? model : `${model}#${variant}`;
}

function depthOf(detection: string): DetectionDepth {
  return detection === "deterministic" || detection === "grader" ? detection : "none";
}

/**
 * The row's reason for the kernel's decision: its reason CODE, then the kernel's text without the leading word the text carries itself
 * (`kept: …`, `switched: …`), so a row reads `switched: C(best)=…` and `kept:best-is-chosen: the chosen dispatch …`, not `switched: switched: …` /
 * `kept:best-is-chosen: kept: …` (QA-3.2-12). The code stays the first token: `routing:stats` reads `kept:evidence` and `lift:floor` by prefix.
 */
function reasonText(decision: Pick<Decision, "reasonCode" | "reason">): string {
  return `${decision.reasonCode}: ${decision.reason.replace(/^(?:kept|switched): /, "")}`;
}

/** A pick the engine cannot resolve to a model: logged as kept, never priced (1.4 handoff). */
function unresolvedChoice(cls: string, agent: string, routerIds: readonly string[]): RouteChoice {
  const origin = classifyAgentOrigin(agent, routerIds);
  return { key: makeKey(cls, { origin, id: agent }, "", "", null), agent, origin, model: "unknown/unknown", variant: "default" };
}

/** What the host runs for a committed call: agent, `provider/model` and variant. */
interface RanDispatch {
  readonly agent: string;
  readonly model: string;
  readonly variant: string | null;
}

/** Same `provider/model` (a `#variant` suffix split off) and the same normalized variant. */
function sameModelVariant(a: { readonly model: string; readonly variant: string | null }, b: { readonly model: string; readonly variant: string | null }): boolean {
  const left = splitModelRef(a.model);
  const right = splitModelRef(b.model);
  const modelOf = (ref: ReturnType<typeof splitModelRef>, raw: string): string => (ref === null ? raw : `${ref.provider}/${ref.model}`);
  return modelOf(left, a.model) === modelOf(right, b.model)
    && normalizeVariant(a.variant ?? left?.variant ?? null) === normalizeVariant(b.variant ?? right?.variant ?? null);
}

/**
 * What the host will run for a committed call: the final input's agent and `model` win over what the engine decided (the legacy hook
 * runs after the engine); a model the final input leaves out is the engine's (same agent) or the resolved one (another agent). `null`
 * when it cannot be told (an unparseable `model`, an agent that resolves to no model).
 */
function ranOf(
  d: Pick<Decided, "resolve">,
  decidedFinal: NonNullable<Decided["final"]>,
  final: Readonly<Record<string, unknown>>,
): RanDispatch | null {
  const agent = str(final.agent) ?? decidedFinal.agent;
  const ref = str(final.model);
  if (ref !== null) {
    const parts = splitModelRef(ref);
    return parts === null ? null : { agent, model: `${parts.provider}/${parts.model}`, variant: parts.variant };
  }
  if (agent === decidedFinal.agent) return { agent, model: decidedFinal.model, variant: decidedFinal.variant };
  const resolved = d.resolve(agent);
  return resolved === null ? null : { agent, model: resolved.model, variant: resolved.variant };
}

export function createDispatchRouter(deps: DispatchRouterDeps): DispatchRouter {
  const now = deps.now ?? (() => Date.now());
  const instanceNonce = randomBytes(8).toString("hex");
  /** Between `route()` and `commit()`. */
  const decided = new Map<string, Decided>();
  /** Committed dispatches, in insertion order, until their call ends. */
  const entries = new Map<string, Entry>();
  /**
   * QA-2.2-R2-7: children registered under a dispatch by a heuristic claim that the dispatch's own result then disowned (child →
   * the wrong dispatch's decision). They stay registered (their steps keep being counted, under the wrong facts) until the
   * result of the dispatch that really started them takes them over.
   */
  const misclaimed = new Map<string, string>();
  /** QA-P21-1-11: role children whose observed binding has been recorded (once per child; bounded). */
  const notedBindings = new Set<string>();
  let sequence = 0;

  const trim = <T>(map: Map<string, T>, limit: number): void => {
    while (map.size > limit) map.delete(map.keys().next().value as string);
  };

  const sweep = (t: number): void => {
    for (const [callID, entry] of entries) {
      if (t - entry.at >= ENTRY_TTL_MS) entries.delete(callID);
    }
    trim(entries, MAX_PENDING);
  };

  /**
   * QA-2.2-R2-1: the call of a resume ended without a result (the host rejected it after the hooks ran). Its registration was
   * made for an execution that never started: drop it, and put back what the registry held for the child before, so a live
   * child keeps its facts and its attempt id (what the registry had observed of the execution cannot be restored).
   */
  const undoResume = (entry: Entry): void => {
    if (entry.state !== "resumed" || entry.resumeID === undefined) return;
    if (lookupDispatch(entry.resumeID)?.decisionID !== entry.input.decisionID) return; // someone registered it since: theirs
    const before = entry.previous;
    if (before === undefined) {
      forgetDispatch(entry.resumeID);
      return;
    }
    register(entry.resumeID, {
      facts: before.facts, agent: before.agent, model: before.model, variant: before.variant, tier: before.tier, acceptance: before.acceptance,
      parentSessionID: before.parentSessionID, attemptId: before.attemptId, decisionID: before.decisionID, step: before.step,
      outcomes: before.outcomes, picked: before.picked, keepExecution: true,
    });
  };

  const claimable = (entry: Entry, t: number): boolean => entry.state === "waiting" && t - entry.at < PENDING_TTL_MS;

  const register = (childSessionID: string, input: DispatchInput): void => {
    try {
      rememberDispatch(childSessionID, input, now());
    } catch (error) {
      deps.logger.warn("[router] routing: the dispatch could not be registered for ingestion", { error: describeError(error) });
    }
  };

  /**
   * The orchestrator's pick lifted to `floorTier` (handoff 1.4, QA-1.4-17): `enforce` starts the dispatch on
   * `max(pick, floor)`, so the row prices what runs. Only router tiers have a rank; a host agent is never lifted. The floor
   * tier must be startable by the parent AND cover the task's needs (QA-2.2-7): a lift must not send a shell task to an
   * agent without a shell.
   */
  const floorLift = (prepared: Prepared, chosen: ChosenDispatch, infos: readonly HostAgentInfo[] | null, facts: TaskFacts): ChosenDispatch | null => {
    const floorRank = floorRankOf(prepared.cfg);
    if (floorRank === null || chosen.agent.origin !== "router") return null;
    const rank = tierRankOf(prepared.cfg, chosen.agent.id);
    if (rank === null || rank >= floorRank) return null;
    const floorTier = escalateLadder(prepared.cfg)[floorRank];
    if (floorTier === undefined) return null;
    const lifted = resolveChosen({ cfg: prepared.cfg, agents: infos, agent: floorTier });
    const info = infos?.find((agent) => agent.id === floorTier);
    if (lifted === null || info === undefined) return null;
    if (!info.permitted || info.mode === "primary" || info.hidden) return null;
    return coversNeeds(info.grants, facts.needs) ? lifted : null;
  };

  /**
   * A30 as amended (QA-2.4-R3-1): the host switches a resumed child to the agent the resume NAMES when it differs from the one the child
   * runs (`switchAgent` in the host's subagent tool: the child's model becomes that agent's). An orchestrator that resumes a child
   * with its own original pick of a child the router moved (floor lift, evidence switch) would move it back below where the router put
   * it. What the child runs, when that is the case: the resume names the pick the child was dispatched under, the child runs another
   * agent, and it is this orchestrator's child.
   */
  const runningAfterRouter = (resumeID: string, parentSessionID: string, named: string): { agent: string; model: string; variant: string | null } | null => {
    const record = lookupDispatch(resumeID);
    if (record === undefined || record.parentSessionID !== parentSessionID) return null;
    if (record.picked === null || record.picked !== named || record.agent === named || record.model === null) return null;
    return { agent: record.agent, model: record.model, variant: record.variant };
  };

  /**
   * A34 (QA-G-B3): may the A30 rewrite send this resume to the agent the child runs? Only when that agent is still startable by the
   * parent and its EVALUATED permissions cover the resume's own `needs` (A11: the resume may ask for more than the first dispatch did),
   * and, on high-risk work without detection (D9 never-down), when it is not below the named pick's capability rank — nor the pick's own
   * model on a lower variant at that rank. Unknown agent info or an unknown capability is a refusal: the resume is then sent as named,
   * which is the orchestrator's own pick and so never a move down. `null` = the rewrite is allowed.
   */
  const runningRefusal = (
    running: { readonly agent: string; readonly model: string; readonly variant: string | null },
    named: ChosenDispatch,
    namedRank: number | null,
    ladder: Ladder,
    infos: readonly HostAgentInfo[] | null,
    facts: TaskFacts,
    detection: Detection,
  ): "needs" | "never-down" | null => {
    const info = infos?.find((candidate) => candidate.id === running.agent);
    if (info === undefined || !info.permitted || info.mode === "primary" || info.hidden || !coversNeeds(info.grants, facts.needs)) return "needs";
    if (facts.risk !== "high" || detection !== "none") return null;
    const pickRank = capabilityRank(ladder, named, namedRank);
    const runRank = capabilityRank(ladder, running, null);
    if (pickRank === null || runRank === null || runRank < pickRank) return "never-down";
    return runRank === pickRank && lowerEffortOnSameModel(running, named) ? "never-down" : null;
  };

  const decideAndRecord = async (call: RouteCall, prepared: Prepared, session: SessionView, view: AgentView | null): Promise<RouteOutcome> => {
    const { args } = call;
    const agent = str(args.agent);
    const prompt = typeof args.prompt === "string" ? args.prompt : null;
    if (agent === null || prompt === null) return UNTOUCHED;
    const mode = prepared.settings.engine;
    const infos = view === null ? null : view.infos;
    const routerIds = routerTierIds(prepared.cfg);

    const result = await classify(
      { description: typeof args.description === "string" ? args.description : "", prompt, cwd: session.directory ?? deps.directory },
      deps.runtime.classifyDeps(prepared),
    );
    const facts = result.facts;
    // A34 (QA-G-B2): the weaker of the route line's `d=` claim and the prompt's own `[acceptance]` block. Detection is the only
    // field a route line could use to WEAKEN a safety rule (D9 never-down holds for `d == none`), so a claim never raises it.
    const detection = weakerDetection(result.detection, detectionOf(prompt));
    const pin = result.pin;
    // `classify` removes only the first-line route line and returns every other byte unchanged (probe, QA-2.2-5).
    const stripped = result.stripped !== prompt ? result.stripped : undefined;
    const strippedRoot = stripped === undefined ? undefined : result.trace.routeLine?.root;
    if (typeof strippedRoot === "string" && strippedRoot !== "") rememberStrippedRoot(call.callID, strippedRoot);
    const callModel = str(args.model) ?? call.tierModel ?? null;
    const resumeID = str(args.sessionID);
    const decisionID = `${call.sessionID}:${safeNow(now)}:${instanceNonce}:${++sequence}`;

    const chosen = resolveChosen({ cfg: prepared.cfg, agents: infos, agent, model: callModel, parentModel: session.model });
    let decision: Decision | null = null;
    let argmin: RouteChoice | null = null; // A27: the cheapest option the evidence filter removed, when it did
    let row: Pick<DecisionRow, "chosen" | "best" | "switched" | "pinned" | "unit" | "costs" | "confidence" | "reason">;
    let final: { agent: string; model: string; variant: string | null } | null = null;
    let outcome: RouteOutcome = { mode, ...(stripped === undefined ? {} : { prompt: stripped }), decisionID };
    // A34 (QA-G-B8): the pick's capability rank for the row, and how to rank what the host is finally handed (at `commit`).
    let pickCapability: number | null = null;
    let capabilityOf: (ran: RanDispatch) => number | null = () => null;

    if (chosen === null) {
      row = {
        chosen: unresolvedChoice(facts.class, agent, routerIds),
        best: null, switched: false, pinned: pin, unit: "ratio", costs: {}, confidence: 0,
        reason: "kept:unresolved: the dispatched agent resolves to no model, so nothing could be priced",
      };
    } else {
      const ladder = buildLadder({
        cfg: prepared.cfg,
        routing: prepared.routing,
        facts,
        agents: infos,
        pricing: (model) => prepared.catalog.pricing(model),
        parentModel: session.model,
        logger: deps.logger,
        session: prepared.session,
      });
      decision = decide({
        facts, chosen, ladder, detection, pin, routing: prepared.routing, store: prepared.store, floorRank: floorRankOf(prepared.cfg),
      });
      argmin = decision.argmin !== null && decision.argmin.key !== decision.best?.key ? decision.argmin : null;
      const pickRank = decision.pickRank ?? capabilityRank(ladder, chosen, null);
      pickCapability = pickRank;
      capabilityOf = (ran) => {
        // The pick itself ranks as the pick (its candidate rank included); anything else by its model, never below its candidate rank.
        if (ran.agent === agent && sameModelVariant(ran, chosen)) return pickRank;
        const candidate = ladder.candidates.find((c) => c.agent.id === ran.agent && sameModelVariant(c, ran));
        return capabilityRank(ladder, ran, candidate?.rank ?? null);
      };
      // A30 (QA-2.4-R2-3): a dispatch that resumes an existing child (`task_id`/`sessionID`) is never switched by the engine, in any mode:
      // the kernel's decision is still logged (best, costs, its own reason), but `switched` is false and the reason code is `kept:resume`.
      const resuming = resumeID !== null;
      // QA-2.4-R3-1 (A30 amended): the router never moves a child from where it runs. A resume that repeats the orchestrator's original
      // pick of a child the router moved is sent to the agent/model the child runs (`enforce`; the other modes only say so in the row).
      const moved = resumeID === null ? null : runningAfterRouter(resumeID, call.sessionID, agent);
      // A34 (QA-G-B3): the rewrite must neither send the resume to an agent that cannot do the resumed work (needs, permission) nor move
      // it below the named pick on high-risk work without detection (D9 never-down). Refused: the resume is sent as named (and floor-lifted).
      const refusal = moved === null || decision.pinned
        ? null
        : runningRefusal(moved, chosen, decision.pickRank, ladder, infos, facts, detection);
      const running = refusal === null ? moved : null;
      row = {
        chosen: decision.chosen, best: decision.best, switched: resuming ? false : decision.switched, pinned: decision.pinned,
        unit: decision.unit, costs: { ...decision.costs }, confidence: decision.confidence,
        reason: moved !== null
          ? decision.pinned
            // A pinned resume is sent as named (`kept:resume:pinned`): it was NOT rewritten, so the row must not claim it was.
            ? `${RESUME_PINNED_REASON}: the resume names @${agent}, the orchestrator's own pick for a child the router moved to @${moved.agent}; pinned, so it is sent as named and NOT rewritten (the host moves the child to @${agent}); engine decision: ${reasonText(decision)}`
            : refusal === "needs"
              ? `${RESUME_NAMED_NEEDS_REASON}: the resume names @${agent}, the orchestrator's own pick for a child the router moved to @${moved.agent}; @${moved.agent} is not startable or its permissions do not cover needs [${facts.needs.join(",")}], so it is sent as named and NOT rewritten (the host moves the child to @${agent}) (A34); engine decision: ${reasonText(decision)}`
              : refusal === "never-down"
                ? `${RESUME_NAMED_NEVER_DOWN_REASON}: the resume names @${agent}, the orchestrator's own pick for a child the router moved to @${moved.agent}; @${moved.agent} is below the pick's capability on high-risk work without detection (D9 never down), so it is sent as named and NOT rewritten (the host moves the child to @${agent}) (A34); engine decision: ${reasonText(decision)}`
                : `${RESUME_RUNNING_REASON}: the resume names @${agent}, the orchestrator's own pick for a child the router moved to @${moved.agent}; ${mode === "enforce" ? "sent to @" + moved.agent + " so the host does not switch it back (A30)" : "would be sent to @" + moved.agent + " (not applied in " + mode + ") so the host does not switch it back (A30)"}; engine decision: ${reasonText(decision)}`
          : resuming
            ? `${RESUME_REASON}: a dispatch that resumes an existing child is never switched by the engine (A30); engine decision: ${reasonText(decision)}`
            : reasonText(decision),
      };
      final = { agent, model: chosen.model, variant: chosen.variant };

      if (mode === "enforce" && !decision.pinned && running !== null) {
        outcome = { ...outcome, agent: running.agent, model: refOf(running.model, running.variant) };
        final = { agent: running.agent, model: running.model, variant: running.variant };
      } else if (mode === "enforce" && !decision.pinned && resuming) {
        // A resume naming an agent other than the one the child runs, and other than the pick it was dispatched under, is the
        // orchestrator's choice: honoured, never below the floor. Without a record of the child nothing is known to move.
        const record = lookupDispatch(resumeID);
        const lifted = record !== undefined && record.parentSessionID === call.sessionID && record.agent !== agent ? floorLift(prepared, chosen, infos, facts) : null;
        if (lifted !== null) {
          outcome = { ...outcome, agent: lifted.agent.id, model: refOf(lifted.model, lifted.variant) };
          final = { agent: lifted.agent.id, model: lifted.model, variant: lifted.variant };
          row = {
            ...row,
            best: choiceOf(facts.class, lifted),
            switched: true,
            reason: `${FLOOR_LIFT_REASON}: resume lifted from @${agent} to @${lifted.agent.id} by enforcement.escalate.floorTier (the child runs @${record?.agent ?? "?"}); engine decision: ${row.reason}`,
          };
        }
      } else if (mode === "enforce" && !decision.pinned) {
        if (decision.switched && decision.target !== null) {
          const target = decision.target;
          outcome = { ...outcome, agent: target.agent.id, model: refOf(target.model, target.variant) };
          final = { agent: target.agent.id, model: target.model, variant: target.variant };
        } else {
          const lifted = floorLift(prepared, chosen, infos, facts);
          if (lifted !== null) {
            outcome = { ...outcome, agent: lifted.agent.id, model: refOf(lifted.model, lifted.variant) };
            final = { agent: lifted.agent.id, model: lifted.model, variant: lifted.variant };
            row = {
              ...row,
              best: choiceOf(facts.class, lifted),
              switched: true,
              // Its own reason code (QA-2.2-7): a floor lift is policy, not an evidence-based switch; D17 does not count it.
              reason: `${FLOOR_LIFT_REASON}: dispatch lifted from @${agent} to @${lifted.agent.id} by enforcement.escalate.floorTier; engine decision: ${row.reason}`,
            };
          }
        }
      }
    }

    const decisionRow: DecisionRow = {
      v: LOG_ROW_VERSION,
      ts: new Date(safeNow(now)).toISOString(),
      sessionID: call.sessionID,
      kind: "decision",
      decisionID,
      mode,
      childSessionID: resumeID,
      facts: factsOf(facts),
      ...row,
      step: "dispatch",
      resume: resumeID !== null,
      trace: traceOf(result, argmin),
      // A34 (QA-G-B8): the detection decided with, and the route line's claim when the prompt did not back it.
      detection: {
        effective: detection,
        ...(result.detection !== undefined && result.detection !== null && result.detection !== detection ? { claimed: result.detection } : {}),
      },
      capability: { pick: pickCapability, dispatched: null }, // `dispatched` is filled in by `commit()` from the final input
    };

    // QA-G-A2: the row waits for `commit()`, so a call whose hook chain rejects it (`onCallFinished`) never writes one.
    decided.set(call.callID, {
      parentSessionID: call.sessionID,
      decisionID,
      facts: factsOf(facts),
      acceptance: depthOf(detection),
      description: typeof args.description === "string" && args.description !== "" ? args.description : null,
      row: decisionRow,
      enqueue: (logged) => prepared.enqueue(logged),
      capabilityOf,
      final,
      routerIds,
      resolve: (target) => resolveChosen({ cfg: prepared.cfg, agents: infos, agent: target, parentModel: session.model }),
      picked: agent,
      at: now(),
    });
    trim(decided, MAX_PENDING);
    return outcome;
  };

  // -------------------------------------------------------------------------
  // #84 P2.1 (T2.1.2): the role path. Tier dispatches never reach it (I1).
  // -------------------------------------------------------------------------

  const workRootDeps: WorkRootDeps = {
    listWorktrees: deps.listWorktrees ?? gitWorktreeList,
    realpath: deps.realpath ?? ((path: string) => realpathSync.native(path)),
    platform: deps.platform ?? process.platform,
  };

  /**
   * The rung a resumed child runs on: the dispatch registry's record (its `tier` is the role tier the router registered), else the
   * child session's own model; unknown → a model off every ladder, which the kernel lifts to the window ceiling (never below).
   */
  const runningRungOf = async (resumeID: string): Promise<{ tier: string | null; model: string; variant: string | null }> => {
    const record = lookupDispatch(resumeID);
    if (record !== undefined && record.model !== null) return { tier: record.tier ?? null, model: record.model, variant: record.variant ?? null };
    try {
      const ref = readSession(await deps.getSession(resumeID)).model;
      const parts = ref === null ? null : splitModelRef(ref);
      if (parts !== null) return { tier: null, model: `${parts.provider}/${parts.model}`, variant: parts.variant };
    } catch {
      // unknown: fail closed below
    }
    return { tier: null, model: "unknown/unknown", variant: null };
  };

  /** `null`: not a role dispatch (tiers mode, a tier or host agent). A role agent whose preparation fails is refused. */
  const prepareRole = async (agent: string, cfg: RouterConfig | undefined): Promise<RolePrepared | null> => {
    const prepareRoles = deps.runtime.prepareRoles;
    if (prepareRoles === undefined) return null;
    // QA-P21-1-8 / QA-P21-2-4: not started in roles mode, or this role agent was not registered: the tier path, as today.
    if (deps.rolesEnabled !== undefined && !deps.rolesEnabled(agent)) return null;

    try {
      return await prepareRoles.call(deps.runtime, agent, cfg);
    } catch (error) {
      // `prepareRoles` throws only once it knows `agent` is a role agent (fail closed).
      throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.failed(describeError(error)));
    }
  };

  const decideRoleDispatch = async (call: RouteCall, rp: RolePrepared, session: SessionView): Promise<RouteOutcome> => {
    const { args } = call;
    const agent = rp.spec.agent;
    const prompt = typeof args.prompt === "string" ? args.prompt : null;
    if (prompt === null) throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.noPrompt);
    const description = typeof args.description === "string" ? args.description : "";
    const sessionDirectory = session.directory ?? deps.directory;

    // 1. classify; a malformed first route line refuses the dispatch (handoff 4).
    const result = await classify({ description, prompt, cwd: sessionDirectory }, rp.classifyDeps);
    if (result.trace.routeLines.malformed === true) throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.malformed);
    const routeLine = result.trace.routeLine;
    const resumeID = str(args.sessionID);
    const resumed = resumeID !== null;

    // 2. work root: `root=` from the trace only, text-compared with `git worktree list --porcelain` before any filesystem call.
    const root = await resolveRoleWorkRoot({ root: routeLine?.root ?? null, sessionDirectory }, workRootDeps);

    // 3. grant (widened actions of a resume recompute the floor, handoff 36). QA-P21-2-1: a resume of an EXACTLY bound child keeps
    // what that child holds (its bound grant) plus the widened actions — the resume prompt alone ("continue") would lose them.
    const bound = resumeID === null ? undefined : currentBinding(resumeID, { maxOf: (name) => roleMaxActions(rp.roles.get(name)) });
    const grant: DispatchGrant = bound?.kind === "exact" ? resumedGrant(bound.grant, call.widened ?? [], root.workRoot)
      : grantFor(rp.spec, result.facts, call.widened ?? [], root.workRoot, routeLine);

    // 4. effective detection (S10/P-9, A34; handoff 5): never `result.detection` as is.
    const acceptance = detectionOf(prompt);
    const routerGate = roleRouterGate({
      cfg: rp.cfg, bypassed: deps.isBypassed?.(call.sessionID) === true, acceptance, ...(deps.env === undefined ? {} : { env: deps.env }),
      // QA-P21-1-2, QA-P21-2 nit 3
      deferred: roleGateDeferred(rp.cfg, prompt, description, { verifyEnabled: deps.routerVerifyEnabled?.() !== false }),
      outsideWorkRoot: roleGateOutsideWorkRoot(grant.workRoot, prompt, description, args.cwd), // DF2-F1, QA-P33F1-1-1, nit 3
    });
    const detection = effectiveDetection({ routerGate, claim: result.detection, acceptance });

    // 5. bounds on the one role tier order (handoff 9); a resume passes the child's running tier. QA-P21-2-2: the raise recorded
    // after a verification FAIL of this child (for this parent) is a raise-only floor, like `floorTier`; consumed on success.
    const running = resumeID === null ? null : await runningRungOf(resumeID);
    const tiers = roleTierOrder(rp.cfg, rp.session);
    const raised = resumeID === null ? null : pendingResumeRaise(resumeID, call.sessionID);
    const floorTier = higherTier(tiers, rp.cfg.enforcement?.escalate?.floorTier ?? null, raised);
    const bounds = tierBounds(rp.spec, grant, result, detection, {
      floorTier,
      runningTier: running?.tier ?? null,
      pinTier: routeLine?.tier ?? null,
      tiers,
    });

    // 6. kernel (handoff 10: kernel.ts / ladders.ts); `dispatch === null` refuses, never a fallback (handoff 6).
    const ladder = buildRoleLadder({
      cfg: rp.cfg, facts: result.facts, role: agent, window: bounds, pricing: (model) => rp.catalog.pricing(model), logger: deps.logger, session: rp.session,
    });
    const decisionID = `${call.sessionID}:${safeNow(now)}:${instanceNonce}:${++sequence}`;
    const rd = decideRole({
      classified: result, ladder, detection, engine: rp.engine, routing: rp.routing, store: rp.store,
      resume: running === null ? null : { model: running.model, variant: running.variant },
      exploration: { rate: rp.exploration, decisionID },
    });
    if (rd.dispatch === null) throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.noCandidate(bounds.floor, bounds.ceiling, rd.reasons));

    // 7. an explicit caller `model` is kept only inside the bounds, and never over a route-line pin (QA-P21-1-5: the pinned rung,
    // raised to the running rung on a resume, wins); then the host catalog decides whether the variant exists.
    const notes: string[] = [...(root.note === null ? [] : [root.note]), ...grant.notes];
    // #84 P2.3 (T2.3.3): the row of a resume records the authority it widens (the actions new to this child's grant).
    const widenedNow = (call.widened ?? []).filter((action) => grant.actions.has(action) && bound?.grant.actions.has(action) !== true);
    if (widenedNow.length > 0) notes.push(BINDING_NOTES.widened(widenedNow));
    if (raised !== null) notes.push(`${RESUME_RAISE_NOTE}${raised}`);
    const callerRef = str(args.model);
    const placed = callerRef === null
      ? null
      : bounds.pinned !== null
        ? { candidate: rd.dispatch, code: PIN_OVER_CALLER_REASON }
        : placeCallerModel(ladder, callerRef, rd.dispatch, resumed);
    const picked: Candidate = placed === null ? rd.dispatch : placed.candidate;
    const variantPlace = placeInCatalog(ladder, picked, rp.catalog);
    if (variantPlace === null) {
      throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.noCandidate(bounds.floor, bounds.ceiling, [...rd.reasons, VARIANT_NO_CANDIDATE_REASON]));
    }
    const { candidate: dispatch, variant: finalVariant, dropped } = variantPlace;
    if (dropped !== null) notes.push(dropped);
    const model = refOf(dispatch.model, finalVariant);
    const tier = dispatch.tier;

    // 8. binding markers (a fresh dispatch only; handoff 31): nonce at the END of the description, nonce line LAST in the prompt.
    const nonce = resumed ? null : newDispatchNonce();
    const outPrompt = nonce === null ? result.stripped : withLastLine(result.stripped, noncePromptLine(nonce));
    const outDescription = nonce === null ? null : `${description}${nonceTitleSuffix(nonce)}`;
    const routeBudget = routeLine?.budget ?? null;
    const budget = roleGuardProfile(rp.spec, tier, routeBudget).budget;

    // 9. the decision row with the role extension (no row when the engine is static).
    const decision = rd.decision;
    const facts = effectiveFactsOf(result);
    const cls = facts.class;
    const ran: ChosenDispatch = { agent: { origin: "role", id: agent }, model: dispatch.model, variant: finalVariant };
    let row: DecisionRow | null = null;
    const mode = rp.engine;
    if (mode !== "static" && rp.enqueue !== null) {
      // QA-P21-1-6: switched/chosen follow the kernel's decision; a variant the catalog lacks only changes what is dispatched.
      const applied = mode === "enforce" && rd.switched && placed === null;
      const wouldSwitch = mode !== "enforce" && !resumed && decision.switched && placed === null;
      const argmin = decision.argmin !== null && decision.argmin.key !== decision.best?.key ? decision.argmin : null;
      const head = resumed
        ? `${RESUME_REASON}: a role dispatch that resumes a child is never switched or explored (A30); engine decision: ${reasonText(decision)}`
        : rd.explore
          ? `explore: exploration draw (propensity ${rd.propensity}); engine decision: ${reasonText(decision)}`
          : placed !== null
            ? `${placed.code}: the call named model ${callerRef}; engine decision: ${reasonText(decision)}`
            : reasonText(decision);
      const extra = [...rd.reasons, ...notes];
      // QA-P21-1-11: a fresh dispatch has no binding yet (its child binds later; `noteBinding` writes the observed kind then).
      // A resume records the child's current binding.
      const binding = resumed ? currentBinding(resumeID, { maxOf: (name) => roleMaxActions(rp.roles.get(name)) })?.kind : undefined;
      row = {
        v: LOG_ROW_VERSION,
        ts: new Date(safeNow(now)).toISOString(),
        sessionID: call.sessionID,
        kind: "decision",
        decisionID,
        mode,
        childSessionID: resumeID,
        facts: factsOf(facts),
        chosen: applied && rd.base !== null ? choiceOf(cls, rd.base) : choiceOf(cls, ran),
        best: decision.best,
        switched: applied || wouldSwitch,
        pinned: decision.pinned,
        unit: decision.unit,
        costs: { ...decision.costs },
        confidence: decision.confidence,
        reason: `${head}; role @${agent} on ${tier} in ${bounds.floor}..${bounds.ceiling}${extra.length > 0 ? ` [${extra.join("; ")}]` : ""}`,
        step: "dispatch",
        resume: resumed,
        trace: traceOf(result, argmin),
        detection: {
          effective: detection,
          ...(result.detection !== undefined && result.detection !== null && result.detection !== detection ? { claimed: result.detection } : {}),
        },
        capability: { pick: rd.base?.rank ?? null, dispatched: dispatch.rank },
        role: agent,
        tier,
        grant: [...grant.actions].sort(),
        boundsReasons: [...bounds.reasons],
        explore: rd.explore,
        propensity: rd.propensity,
        ...(binding === undefined ? {} : { binding }),
      };
    }
    const logged = row === null ? null : decisionID;

    const routed: RoleRouted = {
      callID: call.callID,
      parentSessionID: call.sessionID,
      agent,
      tier,
      model,
      window: { floor: bounds.floor, ceiling: bounds.ceiling, pinned: bounds.pinned },
      grant,
      workRoot: root.workRoot,
      verifyRoot: verifyRootOf(grant, sessionDirectory, workRootDeps.realpath),
      requestedRoot: root.requested,
      notes,
      detection,
      budget,
      routeBudget,
      nonce,
      decisionID: logged,
      resumeID,
      nextTier: nextRoleTier(tiers, rp.spec.tierRange.ceiling, tier),
      class: cls,
    };
    rememberRoutedRole(routed);
    if (raised !== null && resumeID !== null) resumeRaises.delete(resumeID); // QA-P21-2-2: consumed once, by a routed resume

    decided.set(call.callID, {
      parentSessionID: call.sessionID,
      decisionID,
      facts: factsOf(facts),
      acceptance: depthOf(detection),
      description: outDescription ?? (description !== "" ? description : null),
      row,
      enqueue: rp.enqueue ?? (() => {}),
      capabilityOf: (r) => (r.agent === agent && sameModelVariant(r, ran) ? dispatch.rank : null),
      final: { agent, model: dispatch.model, variant: finalVariant },
      routerIds: routerTierIds(rp.cfg),
      resolve: (target) => resolveChosen({ cfg: rp.cfg, agents: null, agent: target, parentModel: session.model }),
      picked: agent,
      at: now(),
      role: {
        tier,
        outcomes: mode !== "static",
        pending: nonce === null ? null : { nonce, grant, budget, description: outDescription ?? description, decisionID: logged },
      },
    });
    trim(decided, MAX_PENDING);
    return {
      mode,
      ...(outPrompt !== prompt ? { prompt: outPrompt } : {}),
      model,
      ...(logged === null ? {} : { decisionID: logged }),
      ...(outDescription === null ? {} : { description: outDescription }),
      role: routed,
    };
  };

  /**
   * QA-P21-1-1: a role dispatch made by a session that has a parent (a delegate). Its prompt is never parsed (no route line, pin
   * or steering) and nothing is registered for it (no nonce, no pending entry, no row: its child binds `unknown`), but it never
   * runs on a model of its own choosing (I2): any caller `model` is replaced by the FLOOR rung of the window computed on the
   * unknown-binding grant (role max ∩ local, I9) — on a resume never below the child's running tier — and, as a routed role
   * dispatch, it is forced to the foreground (P-5).
   */
  const decideDelegateRoleDispatch = (call: RouteCall, rp: RolePrepared, session: SessionView): RouteOutcome => {
    const agent = rp.spec.agent;
    const max = new Set<AuthorityAction>(roleMaxActions(rp.spec) ?? []);
    const grant: DispatchGrant = { actions: new Set(LOCAL_ACTIONS.filter((a) => max.has(a))), notes: [DELEGATE_DISPATCH_NOTE], workRoot: null };
    const facts: TaskFacts = { class: "other", risk: "low", scope: "single", needs: [], confidence: 0, source: "rules" };
    const detection = effectiveDetection({ routerGate: false, claim: null, acceptance: null });
    const tiers = roleTierOrder(rp.cfg, rp.session);
    const resumeID = str(call.args.sessionID);
    const runningTier = resumeID === null ? null : lookupDispatch(resumeID)?.tier ?? null;
    const bounds = tierBounds(rp.spec, grant, { facts, trace: { rules: facts, routeLine: null } }, detection, {
      floorTier: rp.cfg.enforcement?.escalate?.floorTier ?? null, runningTier, pinTier: null, tiers,
    });
    const ladder = buildRoleLadder({
      cfg: rp.cfg, facts, role: agent, window: { floor: bounds.floor, ceiling: bounds.ceiling, pinned: null },
      pricing: (model) => rp.catalog.pricing(model), logger: deps.logger, session: rp.session,
    });
    const first = ladder.tiers.find((t) => t.tier === bounds.floor)?.first ?? ladder.tiers.find((t) => t.first !== null)?.first ?? null;
    const rung = first === null ? undefined : ladder.candidates[first];
    const placed = rung === undefined ? null : placeInCatalog(ladder, rung, rp.catalog);
    if (placed === null) {
      throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.noCandidate(bounds.floor, bounds.ceiling, rung === undefined ? ["window:no-candidates"] : [VARIANT_NO_CANDIDATE_REASON]));
    }
    const tier = placed.candidate.tier;
    const model = refOf(placed.candidate.model, placed.variant);
    const routed: RoleRouted = {
      callID: call.callID,
      parentSessionID: call.sessionID,
      agent,
      tier,
      model,
      window: { floor: bounds.floor, ceiling: bounds.ceiling, pinned: null },
      grant,
      workRoot: null,
      verifyRoot: verifyRootOf(grant, session.directory ?? deps.directory, workRootDeps.realpath),
      requestedRoot: null,
      notes: [DELEGATE_DISPATCH_NOTE, ...(placed.dropped === null ? [] : [placed.dropped])],
      detection,
      budget: roleGuardProfile(rp.spec, tier, null).budget,
      routeBudget: null,
      nonce: null,
      decisionID: null,
      resumeID,
      nextTier: nextRoleTier(tiers, rp.spec.tierRange.ceiling, tier),
      class: null,
    };
    rememberRoutedRole(routed);
    return { mode: rp.engine, model, role: routed };
  };

  /** A role dispatch, from `route()`: claimed like a tier call (A3); only the orchestrator's own dispatch is routed. */
  const routeRoleCall = async (call: RouteCall, callKey: string, rp: RolePrepared): Promise<RouteOutcome> => {
    const agent = rp.spec.agent;
    if (handledCalls.has(callKey)) return UNTOUCHED; // A3: another instance already acted on this call
    let session: SessionView;
    try {
      session = readSession(await deps.getSession(call.sessionID));
    } catch (error) {
      throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.session(describeError(error)));
    }
    if (!claimCall(callKey)) return UNTOUCHED;
    try {
      // QA-P21-1-1: a delegate's dispatch is never parsed (it must not pin or steer), but it runs on the router's floor rung of
      // the unknown-binding window, in the foreground — never on a model the delegate names (I2).
      if (session.parentID !== null) return decideDelegateRoleDispatch(call, rp, session);
      return await decideRoleDispatch(call, rp, session);
    } catch (error) {
      if (error instanceof RoleDispatchRefusal) throw error;
      throw new RoleDispatchRefusal(agent, ROLE_REFUSALS.failed(describeError(error)));
    }
  };

  return {
    async route(call): Promise<RouteOutcome> {
      try {
        const agent = str(call.args.agent);
        const callKey = `${call.sessionID}\u0000${call.callID}`;
        // QA-2.2-1 / QA-INT-1: a call the delegate runner announced is the runner's alone. Only a call that carries the runner's own
        // description can be one (an orchestrator dispatch with the same agent and prompt never spends the runner's mark); if the
        // prompt is not the announced one (rewritten by another plugin) a runner-titled call still finds its mark by session and
        // agent. The call is then marked handled, so no other instance of this process (A3) routes it either.
        if (agent !== null && typeof call.args.prompt === "string"
          && call.args.description === runnerDescription(agent === deps.graderAgent ? undefined : agent)) {
          const exact = consumeRunnerDispatch({ parentSessionID: call.sessionID, agent, prompt: call.args.prompt });
          if (exact || consumeRunnerDispatchLoose({ parentSessionID: call.sessionID, agent })) {
            if (!exact) deps.logger.warn("[router] routing: a runner call arrived with another prompt than the one it announced (rewritten by another plugin?); it was left alone", { agent });
            claimCall(callKey);
            return UNTOUCHED;
          }
        }
        if (agent === null || agent === deps.graderAgent) return UNTOUCHED;
        // #84 P2.1: a role agent of roles mode (v2) takes the role path in EVERY engine mode; tiers mode gets `null` before any host call.
        const role = await prepareRole(agent, call.cfg);
        if (role !== null) return await routeRoleCall(call, callKey, role);
        const prepared = await deps.runtime.prepare(call.cfg);
        if (prepared === null) return UNTOUCHED; // static: nothing touched
        if (handledCalls.has(callKey)) return UNTOUCHED; // A3 (QA-2.2-12): another instance already acted on this call
        let session: SessionView;
        try {
          session = readSession(await deps.getSession(call.sessionID));
        } catch (error) {
          deps.logger.warn("[router] routing: the dispatching session is unavailable; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
          return UNTOUCHED;
        }
        // QA-G-A6: only the session location receives tool hooks on measured hosts. Never defer to an instance that
        // may receive no hook; the process-wide call claim below remains the single-writer guard.
        if (!claimCall(callKey)) return UNTOUCHED;
        // Only an orchestrator's own prompt is parsed (QA focus: a delegate must not be able to pin or steer).
        if (session.parentID !== null) return UNTOUCHED;
        const view = await deps.runtime.agents(session.agent ?? call.agent, session.rules);
        return await decideAndRecord(call, prepared, session, view);
      } catch (error) {
        if (error instanceof RoleDispatchRefusal) throw error; // #84 P2.1: the host must refuse the role dispatch
        deps.logger.warn("[router] routing: the engine failed; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
        return UNTOUCHED;
      }
    },

    commit(callID, input): void {
      try {
        const d = decided.get(callID);
        if (d === undefined) return;
        decided.delete(callID);
        const final = isRecord(input) ? input : {};
        // The agent and model the host will run, after the legacy hook: they win over what the engine decided.
        const ran = d.final === null ? null : ranOf(d, d.final, final);
        // QA-G-A2: the hook chain let the call through, so the dispatch runs: its decision row is written now (never for a rejected call).
        let written: DecisionRow | null = null;
        try {
          // A34 (QA-G-B8): the capability of what really runs, after the legacy hook.
          const dispatched = ran === null ? null : d.capabilityOf(ran);
          if (d.row !== null) {
            written = { ...d.row, capability: { pick: d.row.capability?.pick ?? null, dispatched } };
            d.enqueue(written);
          }
        } catch (error) {
          deps.logger.warn("[router] routing: the decision row could not be queued", { error: describeError(error) });
        }
        // #84 P2.1: a fresh role dispatch registers its pending binding entry from the input the host will execute (handoff 31).
        const rolePending = d.role !== undefined && d.role.pending !== null && str(final.sessionID) === null;
        if (rolePending && d.role !== undefined && d.role.pending !== null) {
          try {
            registerPending({
              parentSessionID: d.parentSessionID,
              callID,
              agent: str(final.agent) ?? d.picked,
              description: str(final.description) ?? d.role.pending.description,
              nonce: d.role.pending.nonce,
              grant: d.role.pending.grant,
              budget: d.role.pending.budget,
              decisionID: d.role.pending.decisionID,
              registeredAt: Date.now(), // the binding registry's own clock
            });
          } catch (error) {
            deps.logger.warn("[router] routing: the role dispatch could not be registered for binding", { error: describeError(error) });
          }
        }
        if (ran === null) return; // nothing to record a step against
        const { agent, model, variant } = ran;
        const dispatched: DispatchInput = {
          facts: d.facts,
          agent,
          model,
          variant,
          tier: d.role !== undefined && agent === d.picked ? d.role.tier : classifyAgentOrigin(agent, d.routerIds) === "router" ? agent : null,
          acceptance: d.acceptance,
          parentSessionID: d.parentSessionID,
          decisionID: d.decisionID,
          step: "dispatch",
          picked: d.picked,
          ...(d.role !== undefined && !d.role.outcomes ? { outcomes: false } : {}),
        };
        const t = now();
        sweep(t);
        const resumeID = str(final.sessionID);
        // QA-2.2-R2-1: remember what the registry held for a resumed child, in case the host then rejects the resume.
        const previous = resumeID === null ? undefined : lookupDispatch(resumeID);
        const entry: Entry = {
          callID, parentSessionID: d.parentSessionID, agent, description: d.description, input: dispatched, at: t,
          state: resumeID === null ? "waiting" : "resumed",
          ...(resumeID === null ? {} : { resumeID }),
          ...(previous === undefined ? {} : { previous }),
          ...(rolePending ? { rolePending: true as const } : {}),
          ...(d.role !== undefined && written !== null ? { roleRow: { row: written, enqueue: d.enqueue } } : {}),
        };
        if (resumeID !== null) register(resumeID, dispatched);
        entries.delete(callID);
        entries.set(callID, entry);
        trim(entries, MAX_PENDING);
      } catch (error) {
        deps.logger.warn("[router] routing: the dispatch could not be committed for ingestion", { error: describeError(error) });
      }
    },

    onSessionCreated(created): void {
      try {
        const sessionID = str(created.sessionID);
        const parentID = str(created.parentID);
        if (sessionID === null || parentID === null || entries.size === 0) return;
        // The runner registers its own children (and titles them `Router …`): never take one for an orchestrator dispatch.
        if (lookupDispatch(sessionID) !== undefined) return;
        const title = str(created.title);
        if (title !== null && RUNNER_CHILD_TITLE.test(title)) return;
        const t = now();
        sweep(t);
        const agent = str(created.agent);
        const mine = [...entries.values()].filter((entry) => entry.parentSessionID === parentID && claimable(entry, t));
        const sameAgent = agent === null ? mine : mine.filter((entry) => entry.agent === agent);
        if (sameAgent.length === 0) return;
        const claimed = (title === null ? undefined : sameAgent.find((entry) => entry.description === title)) ?? sameAgent[0];
        if (claimed === undefined) return;
        claimed.state = "claimed";
        claimed.claimedChild = sessionID;
        register(sessionID, claimed.input);
      } catch (error) {
        deps.logger.warn("[router] routing: a new child session could not be matched to its dispatch", { error: describeError(error) });
      }
    },

    onCallResult(callID, childSessionID): void {
      try {
        decided.delete(callID);
        const entry = entries.get(callID);
        entries.delete(callID);
        if (entry === undefined) return;
        if (childSessionID === null) {
          undoResume(entry); // the call ended without a result: a resume the host rejected leaves the child as it was
          return;
        }
        if (entry.state === "resumed") return;
        // Still waiting (the event was missed, or the claim expired), or claimed for a different child: the result is the truth.
        // The same execution, corrected or completed: keep what the registry has seen of it (QA-2.3-1a).
        misclaimed.delete(childSessionID); // a child this dispatch really started is no longer anyone's wrong claim
        if (lookupDispatch(childSessionID)?.decisionID !== entry.input.decisionID) register(childSessionID, { ...entry.input, keepExecution: true });
        if (entry.state === "claimed" && entry.claimedChild !== undefined && entry.claimedChild !== childSessionID
          && lookupDispatch(entry.claimedChild)?.decisionID === entry.input.decisionID) {
          // A wrong claim: that child belongs to another dispatch. It stays registered (its steps keep being counted) and is marked;
          // the result of the dispatch that really started it takes it over (R2-7).
          misclaimed.set(entry.claimedChild, entry.input.decisionID ?? "");
          trim(misclaimed, MAX_PENDING);
        }
      } catch (error) {
        deps.logger.warn("[router] routing: the child of a finished dispatch could not be registered", { error: describeError(error) });
      }
    },

    onCallFinished(callID): void {
      decided.delete(callID);
      const entry = entries.get(callID);
      entries.delete(callID);
      if (entry !== undefined) undoResume(entry);
      // #84 P2.1: a rejected role call leaves no pending binding entry and no routed record behind.
      routedRoles.delete(callID);
      strippedRoots.delete(callID);
      if (entry?.rolePending === true) {
        try {
          evictCall(entry.parentSessionID, callID);
        } catch (error) {
          deps.logger.warn("[router] routing: a rejected role dispatch could not be evicted from the binding registry", { error: describeError(error) });
        }
      }
    },

    noteBinding(childSessionID, binding): void {
      try {
        if (notedBindings.has(childSessionID)) return;
        const decisionID = binding.decisionID ?? lookupDispatch(childSessionID)?.decisionID ?? null;
        const entry = [...entries.values()].find((e) => e.roleRow !== undefined
          && ((decisionID !== null && e.input.decisionID === decisionID) || e.claimedChild === childSessionID || e.resumeID === childSessionID));
        if (entry?.roleRow === undefined) return;
        notedBindings.add(childSessionID);
        while (notedBindings.size > MAX_HANDLED_CALLS) notedBindings.delete(notedBindings.values().next().value as string);
        const { row, enqueue } = entry.roleRow;
        enqueue({
          v: LOG_ROW_VERSION,
          kind: "decision",
          ts: new Date(safeNow(now)).toISOString(),
          sessionID: row.sessionID,
          decisionID: row.decisionID,
          mode: row.mode,
          childSessionID,
          facts: row.facts,
          chosen: row.chosen,
          best: null,
          switched: false,
          pinned: false,
          unit: row.unit,
          costs: {},
          confidence: row.confidence,
          reason: `${ANNOTATION_REASON}binding:${binding.kind}`,
          step: row.step,
          resume: row.resume,
          ...(row.role === undefined ? {} : { role: row.role }),
          ...(row.tier === undefined ? {} : { tier: row.tier }),
          binding: binding.kind,
        });
      } catch (error) {
        deps.logger.warn("[router] routing: the binding of a role child could not be recorded", { error: describeError(error) });
      }
    },

    misclaimedCount: () => misclaimed.size,

    dispose(): void {
    },

    pendingCount(): number {
      const t = now();
      let count = 0;
      for (const entry of entries.values()) if (claimable(entry, t)) count += 1;
      return count;
    },
  };
}
