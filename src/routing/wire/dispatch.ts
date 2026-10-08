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
import { routerTierIds } from "../engine/ladders";
import type { ChosenDispatch, Decision, HostAgentInfo, Ladder } from "../engine/types";
import { classify } from "../classify";
import type { ClassifyResult, Detection, TaskFacts } from "../classify/types";
import type { RouterConfig } from "../../router/config";
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
import { sessionRulesOf, type EngineRuntime, type Prepared, type WireLogger } from "./runtime";

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
}

export interface RouteOutcome {
  readonly mode: "static" | "shadow" | "advise" | "enforce";
  /** The prompt without its first-line `[route …]`; only when something was stripped. */
  readonly prompt?: string;
  /** `enforce`: the agent to dispatch instead (never for a pinned dispatch). */
  readonly agent?: string;
  /** `enforce`: `provider/model[#variant]` to dispatch with. */
  readonly model?: string;
  readonly decisionID?: string;
}

const UNTOUCHED: RouteOutcome = Object.freeze({ mode: "static" });

/**
 * Titles of the runner's own children (`description` of `v2-client.ts`: `Router <agent> delegation`, `Router result
 * verification`): a `session.created` carrying one is the runner's, never an orchestrator dispatch's.
 */
const RUNNER_CHILD_TITLE = /^Router (?:.+ delegation|result verification)$/;

export interface DispatchRouter {
  /** Decide one `subagent` call. Writes and registers nothing: `commit` writes its decision row and registers it. Never throws. */
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
  readonly row: DecisionRow;
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

/** Test-only: forget which calls were handled. */
export function resetDispatchRouting(): void {
  handledCalls.clear();
  subagentAnnotations.clear();
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
        try {
          // A34 (QA-G-B8): the capability of what really runs, after the legacy hook.
          const dispatched = ran === null ? null : d.capabilityOf(ran);
          d.enqueue({ ...d.row, capability: { pick: d.row.capability?.pick ?? null, dispatched } });
        } catch (error) {
          deps.logger.warn("[router] routing: the decision row could not be queued", { error: describeError(error) });
        }
        if (ran === null) return; // nothing to record a step against
        const { agent, model, variant } = ran;
        const dispatched: DispatchInput = {
          facts: d.facts,
          agent,
          model,
          variant,
          tier: classifyAgentOrigin(agent, d.routerIds) === "router" ? agent : null,
          acceptance: d.acceptance,
          parentSessionID: d.parentSessionID,
          decisionID: d.decisionID,
          step: "dispatch",
          picked: d.picked,
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
