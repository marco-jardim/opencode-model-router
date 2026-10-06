/**
 * Context-hook side of the engine (M7, Phase 2.2.1): the generated `R:` line and the per-turn hint.
 *
 * `static` and `shadow` leave the system prompt byte-identical (the snapshots pin it). `advise` and `enforce`:
 *  - swap the taxonomy line of the delegation protocol for `generateTaxonomy(...)` (a class moves only when the winner
 *    has ≥ 5 recorded outcomes, so the line stays the shipped one until evidence exists, D2), and append the route-line
 *    paragraph of `protocol.ts`;
 *  - add one extra system part, the per-turn hint: at most two lines, `agent id (description) — reason`, computed from the
 *    latest user message with the RULES classifier only (a hint never costs a model call) and cached for the turn, so the
 *    system prompt does not change between the steps of one turn.
 *
 * The hint and the generated `R:` line come from the same kernel, but the hint is only emitted when the kernel says
 * `switched` for the class's static tier, i.e. when it agrees with a move the line itself could make (QA focus: a hint
 * must never contradict the `R:` line). Errors are logged and the system prompt stays as the legacy hook built it.
 */

import {
  DELEGATION_PROTOCOL_HEADING,
  buildRouteLineProtocol,
  swapTaxonomyLine,
} from "../../router/protocol";
import { classify } from "../classify";
import { CLASS_STATIC_TIER, type TaskFacts } from "../classify/types";
import { buildLadder, decide, floorRankOf, generateTaxonomy, resolveChosen } from "../engine";
import { detectionOf } from "../engine/plan";
import type { Decision, HostAgentInfo } from "../engine/types";
import type { AgentView } from "./host-info";
import { sessionRulesOf, type EngineRuntime, type Prepared, type WireLogger } from "./runtime";

/** The generated line is recomputed at most this often (and whenever the config object changes). */
export const TAXONOMY_TTL_MS = 60_000;
/** The user text the hint classifies is cut to this many characters. */
export const HINT_MAX_USER_CHARS = 4_000;
const HINT_MEMO_LIMIT = 100;
const DESCRIPTION_MAX = 60;
const REASON_MAX = 200;

function oneLine(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * The hint text (≤ 2 lines) for a decision that wants to leave the orchestrator's usual agent, or `null` when there is
 * nothing to say: no switch, no target, or a pinned decision.
 */
export function buildHint(decision: Decision, facts: Pick<TaskFacts, "class">, descriptions: ReadonlyMap<string, string>): string | null {
  const { target, best, chosen } = decision;
  if (!decision.switched || decision.pinned || target === null || best === null) return null;
  const described = descriptions.get(target.agent.id);
  const destination = `@${target.agent.id}${described === undefined ? "" : ` (${oneLine(described, DESCRIPTION_MAX)})`}`;
  return [
    `Route hint: for ${facts.class} work like this turn, prefer ${destination} over @${chosen.agent}.`,
    `Why: ${oneLine(decision.reason, REASON_MAX)}`,
  ].join("\n");
}

/** Text of the latest user message that is the user's own (not a synthetic `Instructions from:` attachment). */
export function latestUserText(messages: readonly unknown[] | undefined): string | null {
  if (messages === undefined) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "user") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
      .map((part) => part.text)
      .filter((text) => !/^Instructions from:/m.test(text));
    if (texts.length > 0) return texts.join("\n").slice(0, HINT_MAX_USER_CHARS);
  }
  return null;
}

export interface ContextInput {
  readonly sessionID: string;
  readonly agent: string;
  /** `provider/model` of the model about to answer (the orchestrator's). */
  readonly parentModel: string | null;
  readonly messages?: readonly unknown[];
  /** The router config the hook already loaded. */
  readonly cfg?: Prepared["cfg"];
}

export interface SystemAugmenter {
  /**
   * Called by the context hook after the legacy hook has pushed its text. Rewrites the protocol text in `system` in place
   * and pushes the hint, registering both in `added` (the texts whose vocabulary the adapter translates). Never throws.
   */
  augment(input: ContextInput, system: string[], added: Set<string>): Promise<void>;
}

export interface SystemAugmenterDeps {
  readonly runtime: EngineRuntime;
  readonly getSession: (sessionID: string) => Promise<unknown>;
  readonly logger: WireLogger;
  readonly now?: () => number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSystemAugmenter(deps: SystemAugmenterDeps): SystemAugmenter {
  const now = deps.now ?? Date.now;
  let taxonomyMemo: { cfg: Prepared["cfg"]; agent: string; at: number; line: string } | null = null;
  const hints = new Map<string, { key: string; hint: string | null }>();

  const taxonomyLine = (prepared: Prepared, view: AgentView, input: ContextInput): string => {
    const t = now();
    if (taxonomyMemo !== null && taxonomyMemo.cfg === prepared.cfg && taxonomyMemo.agent === input.agent && t - taxonomyMemo.at < TAXONOMY_TTL_MS) {
      return taxonomyMemo.line;
    }
    const line = generateTaxonomy({
      cfg: prepared.cfg,
      routing: prepared.routing,
      host: "v2",
      store: prepared.store,
      agents: view.infos,
      pricing: (model) => prepared.catalog.pricing(model),
      session: prepared.session,
      parentModel: input.parentModel,
      logger: deps.logger,
    });
    taxonomyMemo = { cfg: prepared.cfg, agent: input.agent, at: t, line };
    return line;
  };

  const hintFor = async (prepared: Prepared, view: AgentView, input: ContextInput): Promise<string | null> => {
    const text = latestUserText(input.messages);
    if (text === null) return null;
    const key = `${text.length}:${text.slice(0, 200)}:${text.slice(-200)}`;
    const memo = hints.get(input.sessionID);
    if (memo !== undefined && memo.key === key) return memo.hint;
    const result = await classify({ prompt: text }, { ...deps.runtime.classifyDeps(prepared), backend: null });
    const staticTier = CLASS_STATIC_TIER[result.facts.class];
    let hint: string | null = null;
    if (staticTier !== null) {
      const infos: readonly HostAgentInfo[] = view.infos;
      const chosen = resolveChosen({ cfg: prepared.cfg, agents: infos, agent: staticTier, parentModel: input.parentModel });
      if (chosen !== null) {
        const ladder = buildLadder({
          cfg: prepared.cfg,
          routing: prepared.routing,
          facts: result.facts,
          agents: infos,
          pricing: (model) => prepared.catalog.pricing(model),
          parentModel: input.parentModel,
          logger: deps.logger,
          session: prepared.session,
        });
        const decision = decide({
          facts: result.facts,
          chosen,
          ladder,
          detection: result.detection ?? detectionOf(text),
          pin: false,
          routing: prepared.routing,
          store: prepared.store,
          floorRank: floorRankOf(prepared.cfg),
        });
        hint = buildHint(decision, result.facts, view.descriptions);
      }
    }
    hints.delete(input.sessionID);
    hints.set(input.sessionID, { key, hint });
    while (hints.size > HINT_MEMO_LIMIT) hints.delete(hints.keys().next().value as string);
    return hint;
  };

  return {
    async augment(input, system, added): Promise<void> {
      try {
        const protocolAt: number[] = [];
        system.forEach((text, index) => {
          if (added.has(text) && text.includes(DELEGATION_PROTOCOL_HEADING)) protocolAt.push(index);
        });
        if (protocolAt.length === 0) return; // not the orchestrator (the legacy hook pushed no protocol)
        const prepared = await deps.runtime.prepare(input.cfg);
        if (prepared === null) return; // static: byte-identical
        const mode = prepared.settings.engine;
        if (mode !== "advise" && mode !== "enforce") return; // shadow: the text is the shipped one
        const session = await deps.getSession(input.sessionID);
        const view = await deps.runtime.agents(input.agent, sessionRulesOf(session));
        if (view === null) return;
        const line = taxonomyLine(prepared, view, input);
        const paragraph = buildRouteLineProtocol(mode);
        for (const index of protocolAt) {
          const original = system[index] as string;
          const rewritten = `${swapTaxonomyLine(original, prepared.cfg, line)}\n\n${paragraph}`;
          added.add(rewritten);
          system[index] = rewritten;
        }
        const hint = await hintFor(prepared, view, input);
        if (hint !== null) {
          added.add(hint);
          system.push(hint);
        }
      } catch (error) {
        deps.logger.warn("[router] routing: the protocol could not be adapted to the engine; the shipped text stays", { error: describeError(error) });
      }
    },
  };
}
