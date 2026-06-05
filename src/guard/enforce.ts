import {
  evaluateGuards,
  updateState,
  recordBlock,
  forcingMessage,
  observationOk,
} from "./guards";
import type { GuardPolicy, GuardCall, GuardState } from "./guards";
import { scrubText } from "./scrub";
import { resolveEnforcementMode } from "../router/enforcement";
import type { EnforcementMode } from "../router/enforcement";
import type { RouterConfig } from "../router/config";

/**
 * Default total tool-call ceiling for an enforced subagent delegation. This is a
 * hard budget (all tool calls), distinct from the read-only cap in tiers.json.
 * Deliberately generous so enforced mode never false-stops ordinary work;
 * tuned with field data in Phase 4.3 (preliminary).
 */
export const DEFAULT_GUARD_BUDGET = 25;

export interface GuardStoreLike {
  ensure(sessionID: string, policy: GuardPolicy): GuardState;
  get(sessionID: string): GuardState | undefined;
  setPendingNote(sessionID: string, note: string): void;
  takePendingNote(sessionID: string): string | undefined;
}

/** Build a GuardPolicy from config for a given subagent tier. deliverableSignal
 * is null in Wave 1 (Mode A/B signal wiring lands in Wave 2/4), which disables
 * the deliverable-first clause — the honest common case (M5). */
export function buildGuardPolicy(cfg: RouterConfig, tier: string | null): GuardPolicy {
  const g = cfg.enforcement?.guard ?? {};
  return {
    budget: g.budget ?? DEFAULT_GUARD_BUDGET,
    readDraftCap: g.readDraftCap ?? 3,
    sameOpRetryCap: g.sameOpRetryCap ?? 1,
    blockSelfScript: g.blockSelfScript ?? true,
    deliverableFirst: g.deliverableFirst ?? true,
    blockScriptWrites: g.blockScriptWrites ?? false,
    deliverableSignal: null,
  };
}

export interface BeforeResult {
  block: boolean;
  message?: string;
  mode: EnforcementMode;
  guard?: string | null;
}

/** Compact per-delegation scorecard, emitted only when enforcement was active. */
export function formatScorecard(state: GuardState, tier: string | null): string {
  const ttfa = state.ttfa == null ? "n/a" : String(state.ttfa);
  return `[router scorecard | tier=${tier ?? "?"} | ttfa=${ttfa} | read:exec=${state.readCount}:${state.execCount} | self_scripts=${state.selfScriptCount} | tool_calls=${state.toolCallCount} | blocks=${state.blockedCount} | stop=${state.lastBlock ?? "none"}]`;
}

/**
 * Decide whether a subagent tool call must be hard-blocked. The caller (the
 * tool.execute.before hook) throws with `message` when block===true. In "off"
 * mode this returns immediately WITHOUT creating guard state, so the after-hook
 * stays a no-op and behaviour is byte-identical (GA-1).
 */
export function guardBeforeCall(params: {
  cfg: RouterConfig;
  tier: string | null;
  sessionID: string;
  tool: string;
  toolArgs: unknown;
  store: GuardStoreLike;
  env: Record<string, string | undefined>;
  trivial?: boolean;
}): BeforeResult {
  const { cfg, tier, sessionID, tool, toolArgs, store, env, trivial } = params;
  let mode = resolveEnforcementMode({ config: cfg, tier: tier ?? undefined, env }).mode;
  if (
    mode === "enforced" &&
    trivial === true &&
    cfg.enforcement?.proportional?.trivialBypass !== false
  ) {
    mode = "advisory";
  }
  if (mode === "off") return { block: false, mode };

  const policy = buildGuardPolicy(cfg, tier);
  const state = store.ensure(sessionID, policy);
  const call: GuardCall = { tool, args: (toolArgs ?? {}) as Record<string, unknown> };
  const decision = evaluateGuards(state, call, policy);

  if (decision.allow) return { block: false, mode, guard: null };

  if (mode === "enforced") {
    // Count the refused attempt so the budget cannot be spun, then signal a block.
    updateState(state, call, { ok: false }, policy);
    recordBlock(state, decision);
    const message = scrubText(`${decision.observation}\n${forcingMessage(state, policy)}`);
    return { block: true, mode, message, guard: decision.guard };
  }

  // advisory: never block; record the would-block and stash a banner the
  // after-hook will append to this call's output.
  recordBlock(state, decision);
  store.setPendingNote(
    sessionID,
    scrubText(`[\u26a0 GUARD:${decision.guard}] ${forcingMessage(state, policy)}`),
  );
  return { block: false, mode, guard: decision.guard };
}

/**
 * Update guard state after an ALLOWED call has executed (we now know ok), and
 * surface any pending advisory banner by appending it to the tool output.
 * No-op when guard state was never created (off mode) => GA-1 preserved.
 */
export function guardAfterCall(params: {
  cfg: RouterConfig;
  tier: string | null;
  sessionID: string;
  tool: string;
  toolArgs: unknown;
  output: { output?: unknown };
  store: GuardStoreLike;
}): void {
  const { cfg, tier, sessionID, tool, toolArgs, output, store } = params;
  const state = store.get(sessionID);
  if (!state) return;
  const policy = buildGuardPolicy(cfg, tier);
  const call: GuardCall = { tool, args: (toolArgs ?? {}) as Record<string, unknown> };
  updateState(state, call, { ok: observationOk(output?.output) }, policy);
  const note = store.takePendingNote(sessionID);
  if (note) {
    const existing = typeof output.output === "string" ? output.output : "";
    output.output = existing ? `${existing}\n\n${note}` : note;
  }
}
