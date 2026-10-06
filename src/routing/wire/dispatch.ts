/**
 * Dispatch-time routing on v2 (M7, Phase 2.2.1): `route()` composes M2 (classify) → ladders → M4 (decide) for one
 * `subagent` call, applies the engine mode and writes the decision row; `commit()` registers the dispatch with the 2.1
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
 *     `route()` only decides and logs. After the legacy hook has had its say, the adapter calls `commit(callID, input)`
 *     with the input the host will execute: a resume (`sessionID` given) is registered at once; a fresh child does not
 *     exist yet, so the dispatch waits and is claimed by the `session.created` event of the child (parent, agent and
 *     title decide which one). `execute.after` then names the child (`onCallResult`): a dispatch still waiting is
 *     registered under it, and a heuristic claim that picked the wrong child is corrected before the verdict is
 *     recorded. A call that ends without a result, or whose hook chain throws, is dropped (`onCallFinished`).
 *  6. Single writer with the delegate runner (QA-2.2-1, QA-2.3-1): the runner (2.3) dispatches its producer and grader children
 *     through the same native tool, so the same hooks fire for them. It announces each call (`markRunnerDispatch`, keyed by
 *     the calling session, the agent and a hash of the prompt) and `route()` consumes the mark first: the call is left exactly
 *     as the runner wrote it (no rewrite, no route-line strip, no floor lift, no decision row, no registration). The runner's
 *     own recorder is the only writer for ladder attempts. A `session.created` that is the runner's child is never claimed
 *     for an orchestrator dispatch (already registered, or titled like a runner call).
 *  7. Multi-instance (A3): the same hook event may reach several plugin instances of the process; only the first
 *     instance whose engine is live acts on a call (a process-wide set of handled calls).
 */

import {
  buildLadder, candidateKey, coversNeeds, decide, detectionOf, escalateLadder, floorRankOf, resolveChosen, tierRankOf,
} from "../engine";
import { routerTierIds } from "../engine/ladders";
import type { ChosenDispatch, Decision, HostAgentInfo } from "../engine/types";
import { classify } from "../classify";
import type { ClassifyResult, TaskFacts } from "../classify/types";
import type { RouterConfig } from "../../router/config";
import {
  consumeRunnerDispatch, consumeRunnerDispatchLoose, forgetDispatch, lookupDispatch, rememberDispatch, runnerDescription,
  type DetectionDepth, type DispatchInput, type DispatchRecord,
} from "../../router/sessions";
import { resolve as resolvePath, sep } from "node:path";
import {
  FLOOR_LIFT_REASON,
  RESUME_REASON,
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
  /** Decide and log one `subagent` call. Registers nothing (see `commit`). Never throws. */
  route(call: RouteCall): Promise<RouteOutcome>;
  /**
   * The input the host is about to execute (`event.input` after the legacy hook ran): register the dispatch from it.
   * A call `route()` did not act on is ignored. Never throws.
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
  /** What the engine dispatches: the fallback for what the final input leaves out. */
  readonly final: { readonly agent: string; readonly model: string; readonly variant: string | null };
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

/** A directory in comparable form: absolute, no trailing separator, lower case on Windows (separators, spelling and case then compare by value). */
function normalizeDirectory(value: string): string {
  const resolved = resolvePath(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * QA-2.2-R2-2 (and its fallback): every dispatch router of the process, with the directory of its plugin instance (A3: one instance
 * per location). Which of them acts on a session is decided by the session's directory alone, see `ownsSession`.
 */
const liveInstances = new Map<number, string>();
let instanceSeq = 0;
/** Directories whose "no instance owns this" fallback was already logged (bounded). */
const loggedFallbacks = new Set<string>();

/**
 * Does the instance with directory `mine` act on a session that lives in `sessionDirectory`?
 *  1. a live instance whose directory IS the session's directory acts (so a static instance of that location is never overridden);
 *  2. otherwise the live instance whose directory is the deepest ANCESTOR of the session's (a session in a subdirectory of the
 *     project, or of a sub-project, belongs to the nearest project root);
 *  3. otherwise (a moved session, a path the host spells differently): the first live instance to claim the call acts, as it did
 *     before instance selection existed; it is logged once per directory at debug level.
 * Instances that share a directory both qualify; the claim of the call (A3) lets the first one act.
 */
function ownsSession(mine: string, sessionDirectory: string, logger: { debug?: (message: string, extra?: Record<string, unknown>) => void }): boolean {
  const target = normalizeDirectory(sessionDirectory);
  const directories = [...liveInstances.values()].map(normalizeDirectory);
  const own = normalizeDirectory(mine);
  if (directories.includes(target)) return own === target;
  const ancestors = directories.filter((directory) => isSameOrInside(directory, target));
  if (ancestors.length > 0) return own === ancestors.reduce((deepest, directory) => (directory.length > deepest.length ? directory : deepest));
  if (!loggedFallbacks.has(target)) {
    loggedFallbacks.add(target);
    while (loggedFallbacks.size > 64) loggedFallbacks.delete(loggedFallbacks.values().next().value as string);
    logger.debug?.("[router] routing: no plugin instance owns the session directory; the first live instance acts", { sessionDirectory });
  }
  return true;
}

function claimCall(key: string): boolean {
  if (handledCalls.has(key)) return false;
  handledCalls.add(key);
  while (handledCalls.size > MAX_HANDLED_CALLS) handledCalls.delete(handledCalls.values().next().value as string);
  return true;
}

/** Test-only: forget which calls were handled. */
export function resetDispatchRouting(): void {
  handledCalls.clear();
  liveInstances.clear();
  loggedFallbacks.clear();
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

/** A pick the engine cannot resolve to a model: logged as kept, never priced (1.4 handoff). */
function unresolvedChoice(cls: string, agent: string, routerIds: readonly string[]): RouteChoice {
  const origin = classifyAgentOrigin(agent, routerIds);
  return { key: makeKey(cls, { origin, id: agent }, "", "", null), agent, origin, model: "unknown/unknown", variant: "default" };
}

export function createDispatchRouter(deps: DispatchRouterDeps): DispatchRouter {
  const now = deps.now ?? (() => Date.now());
  const instanceID = ++instanceSeq;
  liveInstances.set(instanceID, deps.directory);
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
      outcomes: before.outcomes, keepExecution: true,
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
    const detection = result.detection ?? detectionOf(prompt);
    const pin = result.pin;
    // `classify` removes only the first-line route line and returns every other byte unchanged (probe, QA-2.2-5).
    const stripped = result.stripped !== prompt ? result.stripped : undefined;
    const callModel = str(args.model) ?? call.tierModel ?? null;
    const resumeID = str(args.sessionID);
    const decisionID = `${call.sessionID}:${safeNow(now)}:${++sequence}`;

    const chosen = resolveChosen({ cfg: prepared.cfg, agents: infos, agent, model: callModel, parentModel: session.model });
    let decision: Decision | null = null;
    let argmin: RouteChoice | null = null; // A27: the cheapest option the evidence filter removed, when it did
    let row: Pick<DecisionRow, "chosen" | "best" | "switched" | "pinned" | "unit" | "costs" | "confidence" | "reason">;
    let final: { agent: string; model: string; variant: string | null } | null = null;
    let outcome: RouteOutcome = { mode, ...(stripped === undefined ? {} : { prompt: stripped }), decisionID };

    if (chosen === null) {
      row = {
        chosen: unresolvedChoice(facts.class, agent, routerIds),
        best: null, switched: false, pinned: pin, unit: "ratio", costs: {}, confidence: 0,
        reason: "kept: the dispatched agent resolves to no model, so nothing could be priced",
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
      // A30 (QA-2.4-R2-3): a dispatch that resumes an existing child (`task_id`/`sessionID`) is never switched by the engine, in any mode:
      // the kernel's decision is still logged (best, costs, its own reason), but `switched` is false and the reason code is `kept:resume`.
      const resuming = resumeID !== null;
      row = {
        chosen: decision.chosen, best: decision.best, switched: resuming ? false : decision.switched, pinned: decision.pinned,
        unit: decision.unit, costs: { ...decision.costs }, confidence: decision.confidence,
        reason: resuming
          ? `${RESUME_REASON}: a dispatch that resumes an existing child is never switched (A30); engine decision: ${decision.reasonCode}: ${decision.reason}`
          : `${decision.reasonCode}: ${decision.reason}`,
      };
      final = { agent, model: chosen.model, variant: chosen.variant };

      if (mode === "enforce" && !decision.pinned && !resuming) {
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

    prepared.enqueue({
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
    });

    if (final !== null) {
      decided.set(call.callID, {
        parentSessionID: call.sessionID,
        decisionID,
        facts: factsOf(facts),
        acceptance: depthOf(detection),
        description: typeof args.description === "string" && args.description !== "" ? args.description : null,
        final,
        routerIds,
        resolve: (target) => resolveChosen({ cfg: prepared.cfg, agents: infos, agent: target, parentModel: session.model }),
        at: now(),
      });
      trim(decided, MAX_PENDING);
    }
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
        // QA-2.2-R2-2: the session decides which instance acts (exact directory, else the deepest ancestor, else the first live
        // instance, see `ownsSession`); a session that names no directory also falls to the first live instance.
        if (session.directory !== null && !ownsSession(deps.directory, session.directory, deps.logger)) return UNTOUCHED;
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
        const agent = str(final.agent) ?? d.final.agent;
        const ref = str(final.model);
        let model: string;
        let variant: string | null;
        if (ref !== null) {
          const parts = splitModelRef(ref);
          if (parts === null) return;
          model = `${parts.provider}/${parts.model}`;
          variant = parts.variant;
        } else if (agent === d.final.agent) {
          model = d.final.model;
          variant = d.final.variant;
        } else {
          const resolved = d.resolve(agent);
          if (resolved === null) return; // nothing to record a step against
          model = resolved.model;
          variant = resolved.variant;
        }
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
      liveInstances.delete(instanceID);
    },

    pendingCount(): number {
      const t = now();
      let count = 0;
      for (const entry of entries.values()) if (claimable(entry, t)) count += 1;
      return count;
    },
  };
}
