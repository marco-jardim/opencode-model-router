/**
 * Dispatch-time routing on v2 (M7, Phase 2.2.1): `routeDispatch` composes M2 (classify) → ladders → M4 (decide) for
 * one `subagent` call, applies the engine mode, writes the decision row and registers the child with the 2.1
 * dispatch-facts registry so ingestion sees it.
 *
 * Design (the order the adapter calls it in, `src/compat/v2-hooks.ts` `execute.before`):
 *
 *  1. Engine first. `route()` runs before the `subagentTiers` override and before the legacy `tool.execute.before`.
 *     `subagentTiers` only fills a MISSING `model`: the engine sees the model it would fill (`callModel`) when it
 *     resolves the orchestrator's pick, and when it switches it always writes a model of its own, so the override
 *     never fires after a switch. The legacy hook runs last, so headers and the depth banner see the final agent.
 *  2. Modes (§1.2): `static` returns before any host call, allocation or disk access. `shadow` classifies, decides and
 *     logs (a `switched` row is a would-switch); the input is untouched except that `[route …]` lines are stripped.
 *     `advise` is `shadow` plus the protocol/hint of the context hook. `enforce` additionally writes `agent` and
 *     `model#variant` when the kernel switches (D9, A16, A24) and the dispatch is not pinned.
 *  3. Only the orchestrator's own prompt is parsed: the session must be a root session, and the route line only counts
 *     on the first non-empty line of the prompt (A22). A subagent's dispatch is left exactly as it is.
 *  4. Errors never reach the session: any failure is logged and the dispatch proceeds as the orchestrator wrote it.
 *  5. Registration (2.1 handoff, QA-2.1-R2-10): once per execution of a child. A resume (`sessionID` given) is
 *     registered at once; a fresh child does not exist yet, so the dispatch waits in a per-parent queue and is claimed
 *     by the `session.created` event of the child (parent, agent and title decide which one), or dropped when the tool
 *     call finishes.
 */

import { buildLadder, candidateKey, decide, detectionOf, escalateLadder, floorRankOf, resolveChosen, tierRankOf } from "../engine";
import { routerTierIds } from "../engine/ladders";
import type { ChosenDispatch, Decision, HostAgentInfo } from "../engine/types";
import { classify } from "../classify";
import type { ClassifyResult, TaskFacts } from "../classify/types";
import type { RouterConfig } from "../../router/config";
import { rememberDispatch, type DetectionDepth, type DispatchInput } from "../../router/sessions";
import {
  LOG_ROW_VERSION,
  classifyAgentOrigin,
  makeKey,
  normalizeVariant,
  safeNow,
  type DecisionRow,
  type DecisionTrace,
  type RouteChoice,
} from "../outcomes/types";
import { agentModelRef, type AgentView } from "./host-info";
import { sessionRulesOf, type EngineRuntime, type Prepared, type WireLogger } from "./runtime";

/** A dispatch waits at most this long for its child's `session.created` event before it is forgotten. */
export const PENDING_TTL_MS = 120_000;
/** Bound on dispatches waiting for a child (oldest dropped first). */
export const MAX_PENDING = 200;

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
  /** The prompt without its `[route …]` line(s); only when something was stripped. */
  readonly prompt?: string;
  /** `enforce`: the agent to dispatch instead (never for a pinned dispatch). */
  readonly agent?: string;
  /** `enforce`: `provider/model[#variant]` to dispatch with. */
  readonly model?: string;
  readonly decisionID?: string;
}

const UNTOUCHED: RouteOutcome = Object.freeze({ mode: "static" });

export interface DispatchRouter {
  /** Route one `subagent` call. Never throws. */
  route(call: RouteCall): Promise<RouteOutcome>;
  /** A `session.created` event: claim the pending dispatch of this child, if there is one. Never throws. */
  onSessionCreated(created: { readonly sessionID: unknown; readonly parentID: unknown; readonly agent: unknown; readonly title: unknown }): void;
  /** The tool call ended: its dispatch can no longer be claimed. */
  onCallFinished(callID: string): void;
  /** Dispatches still waiting for a child (diagnostics, tests). */
  pendingCount(): number;
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

interface Pending {
  readonly callID: string;
  readonly parentSessionID: string;
  readonly agent: string;
  readonly description: string | null;
  readonly input: DispatchInput;
  readonly at: number;
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
  const pending: Pending[] = [];
  let sequence = 0;

  const sweepPending = (t: number): void => {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (t - (pending[i] as Pending).at >= PENDING_TTL_MS) pending.splice(i, 1);
    }
    while (pending.length > MAX_PENDING) pending.shift();
  };

  const register = (childSessionID: string, input: DispatchInput): void => {
    try {
      rememberDispatch(childSessionID, input, now());
    } catch (error) {
      deps.logger.warn("[router] routing: the dispatch could not be registered for ingestion", { error: describeError(error) });
    }
  };

  /**
   * The orchestrator's pick lifted to `floorTier` (handoff 1.4, QA-1.4-17): `enforce` starts the dispatch on
   * `max(pick, floor)`, so the row prices what runs. Only router tiers have a rank; a host agent is never lifted.
   */
  const floorLift = (prepared: Prepared, chosen: ChosenDispatch, infos: readonly HostAgentInfo[] | null): ChosenDispatch | null => {
    const floorRank = floorRankOf(prepared.cfg);
    if (floorRank === null || chosen.agent.origin !== "router") return null;
    const rank = tierRankOf(prepared.cfg, chosen.agent.id);
    if (rank === null || rank >= floorRank) return null;
    const floorTier = escalateLadder(prepared.cfg)[floorRank];
    if (floorTier === undefined) return null;
    const lifted = resolveChosen({ cfg: prepared.cfg, agents: infos, agent: floorTier });
    const info = infos?.find((agent) => agent.id === floorTier);
    // The host must be able to start it: a floor tier the parent may not dispatch stays a note, not a swap.
    return lifted !== null && info !== undefined && info.permitted && info.mode !== "primary" && !info.hidden ? lifted : null;
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
    const stripped = result.stripped !== prompt ? result.stripped : undefined;
    const callModel = str(args.model) ?? call.tierModel ?? null;
    const resumeID = str(args.sessionID);
    const decisionID = `${call.sessionID}:${safeNow(now)}:${++sequence}`;

    const chosen = resolveChosen({ cfg: prepared.cfg, agents: infos, agent, model: callModel, parentModel: session.model });
    let decision: Decision | null = null;
    let argmin: RouteChoice | null = null; // A27: the cheapest option the evidence filter removed, when it did
    let row: Pick<DecisionRow, "chosen" | "best" | "switched" | "pinned" | "unit" | "costs" | "confidence" | "reason">;
    let final: { agent: string; model: string; variant: string | null; tier: string | null } | null = null;
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
      row = {
        chosen: decision.chosen, best: decision.best, switched: decision.switched, pinned: decision.pinned,
        unit: decision.unit, costs: { ...decision.costs }, confidence: decision.confidence, reason: `${decision.reasonCode}: ${decision.reason}`,
      };
      final = { agent, model: chosen.model, variant: chosen.variant, tier: chosen.agent.origin === "router" ? agent : null };

      if (mode === "enforce" && !decision.pinned) {
        if (decision.switched && decision.target !== null) {
          const target = decision.target;
          outcome = { ...outcome, agent: target.agent.id, model: refOf(target.model, target.variant) };
          final = { agent: target.agent.id, model: target.model, variant: target.variant, tier: target.tier };
        } else {
          const lifted = floorLift(prepared, chosen, infos);
          if (lifted !== null) {
            outcome = { ...outcome, agent: lifted.agent.id, model: refOf(lifted.model, lifted.variant) };
            final = { agent: lifted.agent.id, model: lifted.model, variant: lifted.variant, tier: lifted.agent.id };
            row = {
              ...row,
              best: choiceOf(facts.class, lifted),
              switched: true,
              reason: `${row.reason} [floorTier: dispatch lifted from @${agent} to @${lifted.agent.id}]`,
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
      const input: DispatchInput = {
        facts: factsOf(facts),
        agent: final.agent,
        model: final.model,
        variant: final.variant,
        tier: final.tier,
        acceptance: depthOf(detection),
        parentSessionID: call.sessionID,
        decisionID,
        step: "dispatch",
      };
      if (resumeID !== null) {
        register(resumeID, input);
      } else {
        const t = now();
        sweepPending(t);
        pending.push({
          callID: call.callID,
          parentSessionID: call.sessionID,
          agent: final.agent,
          description: typeof args.description === "string" && args.description !== "" ? args.description : null,
          input,
          at: t,
        });
        sweepPending(t);
      }
    }
    return outcome;
  };

  return {
    async route(call): Promise<RouteOutcome> {
      try {
        const agent = str(call.args.agent);
        if (agent === null || agent === deps.graderAgent) return UNTOUCHED;
        const prepared = await deps.runtime.prepare(call.cfg);
        if (prepared === null) return UNTOUCHED; // static: nothing touched
        let session: SessionView;
        try {
          session = readSession(await deps.getSession(call.sessionID));
        } catch (error) {
          deps.logger.warn("[router] routing: the dispatching session is unavailable; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
          return UNTOUCHED;
        }
        // Only an orchestrator's own prompt is parsed (QA focus: a delegate must not be able to pin or steer).
        if (session.parentID !== null) return UNTOUCHED;
        const view = await deps.runtime.agents(session.agent ?? call.agent, session.rules);
        return await decideAndRecord(call, prepared, session, view);
      } catch (error) {
        deps.logger.warn("[router] routing: the engine failed; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
        return UNTOUCHED;
      }
    },

    onSessionCreated(created): void {
      try {
        const sessionID = str(created.sessionID);
        const parentID = str(created.parentID);
        if (sessionID === null || parentID === null || pending.length === 0) return;
        sweepPending(now());
        const agent = str(created.agent);
        const title = str(created.title);
        const mine = pending.filter((entry) => entry.parentSessionID === parentID);
        const sameAgent = agent === null ? mine : mine.filter((entry) => entry.agent === agent);
        if (sameAgent.length === 0) return;
        const claimed = (title === null ? undefined : sameAgent.find((entry) => entry.description === title)) ?? sameAgent[0];
        if (claimed === undefined) return;
        pending.splice(pending.indexOf(claimed), 1);
        register(sessionID, claimed.input);
      } catch (error) {
        deps.logger.warn("[router] routing: a new child session could not be matched to its dispatch", { error: describeError(error) });
      }
    },

    onCallFinished(callID): void {
      for (let i = pending.length - 1; i >= 0; i--) {
        if ((pending[i] as Pending).callID === callID) pending.splice(i, 1);
      }
    },

    pendingCount: () => pending.length,
  };
}
