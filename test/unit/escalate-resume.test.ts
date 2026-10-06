import { describe, expect, it } from "vitest";
import {
  advance,
  buildEscalatePolicy,
  newLadderState,
  nextAction,
  recordAttempt,
  type EscalatePolicy,
  type LadderAction,
  type LadderSessionPolicyInput,
  type LadderState,
} from "../../src/escalate/ladder";
import {
  createCatalogLookup,
  planFirstAttempt,
  planNextAttempt,
  type AttemptPlan,
  type CatalogLookup,
} from "../../src/escalate/resume";
import type { CatalogModel } from "../../src/escalate/variants";
import type { EnforcementConfig, RouterConfig, TierConfig } from "../../src/router/config";

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const PLAIN = "anthropic/no-variants";

const entry = (variants: string[], limit: CatalogModel["limit"] = { input: 1_000_000, context: 1_000_000, output: 64_000 }): CatalogModel => ({
  variants: variants.map((id) => ({ id })),
  limit,
});
const CATALOG: Record<string, CatalogModel> = {
  [SONNET]: entry(["low", "medium", "high", "xhigh", "max"]),
  [OPUS]: entry(["low", "medium", "high", "xhigh", "max"]),
  [PLAIN]: { limit: { input: 1_000_000 } },
};
const lookup: CatalogLookup = (model) => (Object.hasOwn(CATALOG, model) ? CATALOG[model] : undefined);
const V2: LadderSessionPolicyInput = { host: "v2", catalog: lookup };

function config(tiers: Record<string, TierConfig>, escalate: EnforcementConfig["escalate"] = {}): RouterConfig {
  return { activePreset: "p", presets: { p: tiers }, rules: [], defaultTier: "fast", enforcement: { escalate: { maxTotalAttempts: 10, costCeiling: { multiple: 1000 }, ...escalate } } };
}

const OWNER: Record<string, TierConfig> = {
  fast: { model: SONNET, variant: "low", costRatio: 1 },
  medium: { model: SONNET, variant: "medium", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};

const FAIL = { pass: false, outcome: "fail" as const, reasons: ["nope"] };

/** One failed attempt of `plan` on `child` (its context is `tokens`), then the next action, state and plan. */
function failOnce(
  cfg: RouterConfig,
  policy: EscalatePolicy,
  state: LadderState,
  previous: AttemptPlan,
  child: string | null,
  tokens: number | null,
  catalog: CatalogLookup | undefined = lookup,
): { action: LadderAction; state: LadderState; plan: AttemptPlan } {
  const recorded = recordAttempt(state, 1, child === null ? undefined : { sessionID: child, lastStepTokens: tokens });
  const action = nextAction(recorded, FAIL, policy, { dispatchPromptChars: 400 });
  const advanced = advance(recorded, action);
  return { action, state: advanced, plan: planNextAttempt({ action, state: advanced, previous, cfg, policy, catalog }) };
}

describe("createCatalogLookup", () => {
  it("keys entries by providerID/id, skips malformed ones and keeps the first of a repeat", () => {
    const first = { providerID: "p", id: "m", variants: [{ id: "high" }] };
    const lookupFn = createCatalogLookup([
      first,
      { providerID: "p", id: "m", variants: [{ id: "low" }] },
      { providerID: "", id: "x" },
      { providerID: "q", id: "" },
      null as unknown as { providerID: string; id: string },
    ]);
    expect(lookupFn("p/m")).toBe(first);
    expect(lookupFn("q/")).toBeUndefined();
    expect(lookupFn("nope/none")).toBeUndefined();
  });
});

describe("planFirstAttempt", () => {
  it("is the start tier exactly as the runner always dispatched it", () => {
    expect(planFirstAttempt(config(OWNER), "fast")).toEqual({
      step: "dispatch", tier: "fast", agent: "fast",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "low" }, variant: "low",
    });
  });

  it("a tier without a variant has none, and an unresolvable model leaves the model undefined", () => {
    const cfg = config({ fast: { model: "anthropic/m", costRatio: 1 }, broken: { model: "nomodel", costRatio: 1 } });
    const plain = planFirstAttempt(cfg, "fast");
    expect(plain.model?.variant).toBeUndefined();
    expect(plain.variant).toBeUndefined();
    expect(planFirstAttempt(cfg, "broken").model).toBeUndefined();
    expect(planFirstAttempt(cfg, "missing").model).toBeUndefined();
  });
});

describe("planNextAttempt: variant steps and escalations on a session-aware policy (D10, D11)", () => {
  it("a failed attempt resumes the same child with the next variant of the same model", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const first = planFirstAttempt(cfg, "fast");
    const next = failOnce(cfg, policy, newLadderState("fast", policy), first, "child-1", 20_000);
    expect(next.action).toMatchObject({ action: "retry", variantStep: true, variant: "medium", resume: true });
    expect(next.plan).toMatchObject({
      step: "variant", tier: "fast", agent: "fast", resumeSessionID: "child-1",
      model: { providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "medium" },
      variant: "medium", costRatio: 1, // the tier's ratio: no candidate prices this rung
    });
    expect(next.plan.resumeBasis).toMatchObject({ resume: true, reason: "under-threshold" });
    expect(next.plan.fresh).toBeUndefined();
  });

  it("F5: a configured candidate costRatio is the rung's ratio, carried on the plan for the runner to charge", () => {
    const cfg = config({
      fast: { model: SONNET, variant: "low", costRatio: 1, candidates: [{ variant: "low", costRatio: 1 }, { variant: "medium", costRatio: 3 }, { variant: "high", costRatio: 6 }] },
      medium: { model: SONNET, variant: "medium", costRatio: 5 },
    });
    const policy = buildEscalatePolicy(cfg, V2);
    const first = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "c", 1_000);
    const second = failOnce(cfg, policy, first.state, first.plan, "c", 2_000);
    expect([first.plan.costRatio, second.plan.costRatio]).toEqual([3, 6]);
    expect([first.plan.model?.variant, second.plan.model?.variant]).toEqual(["medium", "high"]);
  });

  it("walks the ladder one variant at a time on the same child, then escalates with an agent switch", () => {
    const cfg = config(OWNER, { maxTotalAttempts: 10 });
    const policy = buildEscalatePolicy(cfg, V2);
    let state = newLadderState("fast", policy);
    let plan = planFirstAttempt(cfg, "fast");
    const steps: Array<[string, string | undefined, string | undefined]> = [];
    for (let i = 0; i < 6; i++) {
      const next = failOnce(cfg, policy, state, plan, "child-1", 10_000);
      state = next.state;
      plan = next.plan;
      steps.push([plan.step, plan.agent, plan.model?.variant]);
      if (plan.step === "escalate") break;
    }
    // sonnet#low -> medium -> high -> xhigh (the effortBumpMax cap), one plain retry (maxAttemptsPerTier 1) at the top
    // variant it reached, then heavy (opus), which is another model.
    expect(steps.map(([kind]) => kind)).toEqual(["variant", "variant", "variant", "retry", "escalate"]);
    expect(steps.map(([, , variant]) => variant)).toEqual(["medium", "high", "xhigh", "xhigh", "xhigh"]);
    expect(steps[3]).toEqual(["retry", "fast", "xhigh"]); // the retry keeps the reached variant
    expect(steps[4]![1]).toBe("heavy");
    expect(plan).toMatchObject({ tier: "heavy", agent: "heavy", resumeSessionID: "child-1", model: { modelID: "claude-opus-5-5", variant: "xhigh" } });
  });

  it("starts fresh when the child is over the threshold of the next model", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "child-1", 700_000);
    expect(next.action.resume).toBe(false);
    expect(next.plan.resumeSessionID).toBeUndefined();
    expect(next.plan.resumeBasis).toMatchObject({ resume: false, reason: "at-or-over-threshold" });
    expect(next.plan.model?.variant).toBe("medium"); // still the next variant, on a new child
    expect(next.plan.fresh).toBeUndefined(); // a ladder decision, not a runner override
  });

  it("starts fresh when the child's context is unknown (the attempt failed before any step was seen)", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "child-1", null);
    expect(next.plan.resumeSessionID).toBeUndefined();
    expect(next.plan.resumeBasis?.reason).toBe("unknown-tokens");
  });

  it("starts fresh when no child was observed at all", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), null, null);
    expect(next.plan.resumeSessionID).toBeUndefined();
    expect(next.plan.resumeBasis?.reason).toBe("no-child");
  });

  it("a plain retry of a tier with nothing above resumes at the variant it reached", () => {
    const cfg = config({ fast: { model: SONNET, variant: "xhigh", costRatio: 1 }, medium: { model: OPUS, variant: "xhigh", costRatio: 5 } }, { maxAttemptsPerTier: 2 });
    const policy = buildEscalatePolicy(cfg, V2);
    // sonnet's ladder is capped at xhigh, so the base is the top: the first failure is a plain retry.
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "c", 5_000);
    expect(next.action).toMatchObject({ action: "retry" });
    expect(next.action.variantStep).toBeUndefined();
    expect(next.plan).toMatchObject({ step: "retry", resumeSessionID: "c", model: { variant: "xhigh" } });
  });
});

describe("planNextAttempt: catalog validation before the call (D10 fallback)", () => {
  it("an invalid target variant starts fresh on the tier's configured model, logged by the caller through `fresh`", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const first = planFirstAttempt(cfg, "fast");
    // The catalog the plan sees has lost `medium` since the policy was built (hot catalog change).
    const shrunk: CatalogLookup = (model) => (model === SONNET ? entry(["low", "high"]) : lookup(model));
    const next = failOnce(cfg, policy, newLadderState("fast", policy), first, "child-1", 1_000, shrunk);
    expect(next.action.variant).toBe("medium");
    expect(next.plan.fresh).toBe("invalid-variant");
    expect(next.plan.resumeSessionID).toBeUndefined();
    expect(next.plan.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" }); // bare: the effort override carries it
    expect(next.plan.variant).toBeUndefined();
    expect(next.plan.effort).toBe("medium"); // fresh session + effort override instead
    expect(next.plan.step).toBe("variant");
  });

  it("QA-2.3-8: the invalid-variant fallback is charged at the tier's ratio, not at the ratio of the rung it could not run", () => {
    const cfg = config({
      fast: { model: SONNET, variant: "low", costRatio: 1, candidates: [{ variant: "low", costRatio: 1 }, { variant: "medium", costRatio: 5 }] },
      medium: { model: SONNET, variant: "medium", costRatio: 5 },
    });
    const policy = buildEscalatePolicy(cfg, V2);
    const shrunk: CatalogLookup = (model) => (model === SONNET ? entry(["low", "high"]) : lookup(model));
    const recorded = recordAttempt(newLadderState("fast", policy), 1, { sessionID: "c", lastStepTokens: 1_000 });
    const action = nextAction(recorded, FAIL, policy, { dispatchPromptChars: 10 });
    expect(action.costRatio).toBe(5); // the ladder priced the rung `medium`
    const invalid = planNextAttempt({ action, state: advance(recorded, action), previous: planFirstAttempt(cfg, "fast"), cfg, policy, catalog: shrunk });
    expect(invalid.fresh).toBe("invalid-variant");
    expect(invalid.costRatio).toBeUndefined();
    // a valid catalog keeps the rung's ratio
    const valid = planNextAttempt({ action, state: advance(recorded, action), previous: planFirstAttempt(cfg, "fast"), cfg, policy, catalog: lookup });
    expect(valid.costRatio).toBe(5);
  });

  it("a model the catalog no longer has is invalid too", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "child-1", 1_000, () => undefined);
    expect(next.plan.fresh).toBe("invalid-variant");
    expect(next.plan.resumeSessionID).toBeUndefined();
    expect(next.plan.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    expect(next.plan.effort).toBe("medium");
  });

  it("a target variant that is not an effort level (an unlisted candidate) falls back fresh without an effort override", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const first = planFirstAttempt(cfg, "fast");
    const recorded = recordAttempt(newLadderState("fast", policy), 1, { sessionID: "child-1", lastStepTokens: 1_000 });
    const action = nextAction(recorded, FAIL, policy, { dispatchPromptChars: 10 });
    // Hand-edit the action the way a bug or a stale policy could: a variant the host never lists.
    const forged: LadderAction = { ...action, variant: "turbo" };
    const plan = planNextAttempt({ action: forged, state: advance(recorded, forged), previous: first, cfg, policy, catalog: lookup });
    expect(plan.fresh).toBe("invalid-variant");
    expect(plan.effort).toBeUndefined();
    expect(plan.resumeSessionID).toBeUndefined();
    expect(plan.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-5-5", variant: "low" }); // the tier's own, no effort to carry
  });

  it("an invalid variant never resumes, even when the ladder said resume", () => {
    const cfg = config(OWNER);
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "child-1", 1_000, () => null);
    expect(next.action.resume).toBe(true);
    expect(next.plan.resumeSessionID).toBeUndefined();
  });
});

describe("planNextAttempt: host behaviour that is unverified starts fresh", () => {
  it("R1: a bare model sent to a child whose variant was set by an earlier step starts fresh", () => {
    // fast has no configured variant (base default) and steps to `high`; escalating to a bare-model tier is a bare resume.
    const cfg = config({ fast: { model: SONNET, costRatio: 1 }, medium: { model: PLAIN, costRatio: 5 } }, { maxTotalAttempts: 10 });
    const lookupPlain: CatalogLookup = (model) => (model === PLAIN ? entry(["low", "high"]) : lookup(model));
    const policy = buildEscalatePolicy(cfg, { host: "v2", catalog: lookupPlain });
    let state = newLadderState("fast", policy);
    let plan = planFirstAttempt(cfg, "fast");
    const kinds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const next = failOnce(cfg, policy, state, plan, "child-1", 1_000, lookupPlain);
      state = next.state;
      plan = next.plan;
      kinds.push(`${plan.step}:${plan.model?.variant ?? "bare"}${plan.fresh ? `:${plan.fresh}` : ""}`);
      if (plan.step === "escalate") break;
    }
    expect(kinds[0]).toBe("variant:high");
    const last = kinds[kinds.length - 1]!;
    expect(last.startsWith("escalate:")).toBe(true);
    expect(plan.fresh).toBe("bare-model-after-variant");
    expect(plan.resumeSessionID).toBeUndefined();
  });

  it("R1 does not apply when the previous attempt ran on the default variant (bare resume is consistent)", () => {
    const cfg = config({ fast: { model: PLAIN, costRatio: 1 }, medium: { model: "anthropic/other", costRatio: 5 } }, { maxAttemptsPerTier: 0 });
    const lookupOther: CatalogLookup = (model) => (model === "anthropic/other" ? entry(["low", "high"]) : lookup(model));
    const policy = buildEscalatePolicy(cfg, { host: "v2", catalog: lookupOther });
    const first = planFirstAttempt(cfg, "fast");
    const next = failOnce(cfg, policy, newLadderState("fast", policy), first, "child-1", 1_000, lookupOther);
    expect(next.plan).toMatchObject({ step: "escalate", agent: "medium", resumeSessionID: "child-1" });
    expect(next.plan.model?.variant).toBeUndefined(); // a bare model, sent to a child that stored `default`
    expect(next.plan.fresh).toBeUndefined();
  });

  it("QA-1.5-22: an escalation across an effort-configured tier starts fresh until the host behaviour is proven", () => {
    const cfg = config({
      fast: { model: SONNET, variant: "low", costRatio: 1 },
      medium: { model: SONNET, variant: "medium", effort: "high", costRatio: 5 },
      heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
    }, { maxAttemptsPerTier: 0, maxTotalAttempts: 10 });
    const policy = buildEscalatePolicy(cfg, V2);
    expect(policy.variants?.perTier.medium?.effortConfigured).toBe(true);
    let state = newLadderState("fast", policy);
    let plan = planFirstAttempt(cfg, "fast");
    let escalated: AttemptPlan | undefined;
    for (let i = 0; i < 8 && escalated === undefined; i++) {
      const next = failOnce(cfg, policy, state, plan, "child-1", 1_000);
      state = next.state;
      plan = next.plan;
      if (plan.step === "escalate") escalated = plan;
    }
    expect(escalated).toMatchObject({ tier: "medium", agent: "medium" });
    expect(escalated?.fresh).toBe("effort-path");
    expect(escalated?.resumeSessionID).toBeUndefined();
  });

  it("a variant step or plain retry on an effort-configured tier is not an escalation, so it can still resume", () => {
    const cfg = config({ fast: { model: SONNET, effort: "low", costRatio: 1 }, medium: { model: OPUS, variant: "xhigh", costRatio: 5 } }, { maxAttemptsPerTier: 2 });
    const policy = buildEscalatePolicy(cfg, V2);
    const next = failOnce(cfg, policy, newLadderState("fast", policy), planFirstAttempt(cfg, "fast"), "child-1", 1_000);
    expect(next.plan.step).toBe("retry");
    expect(next.plan.resumeSessionID).toBe("child-1");
    expect(next.plan.effort).toBeDefined(); // the effort bump of the producer-side path
  });
});

describe("planNextAttempt without a session-aware policy: exactly what the runner always dispatched", () => {
  it("v1 / variantSteps none / no catalog: the tier's configured model and variant, never a resume", () => {
    const cfg = config(OWNER, { maxAttemptsPerTier: 1 });
    for (const session of [undefined, { host: "v1" as const, catalog: lookup }, { host: "v2" as const, variantSteps: "none" as const, catalog: lookup }, { host: "v2" as const, catalog: () => undefined }]) {
      const policy = buildEscalatePolicy(cfg, session);
      expect(policy.variants).toBeUndefined();
      let state = newLadderState("fast", policy);
      let plan = planFirstAttempt(cfg, "fast");
      const seen: Array<[string, string, string | undefined]> = [];
      for (let i = 0; i < 3; i++) {
        const next = failOnce(cfg, policy, state, plan, "child-1", 1_000);
        state = next.state;
        plan = next.plan;
        seen.push([plan.step, plan.agent, plan.model?.variant]);
        expect(plan.resumeSessionID).toBeUndefined();
        expect(plan.fresh).toBeUndefined();
        expect(plan.resumeBasis).toBeUndefined();
        expect(plan.costRatio).toBeUndefined();
      }
      expect(seen).toEqual([["retry", "fast", "low"], ["escalate", "medium", "medium"], ["retry", "medium", "medium"]]);
    }
  });

  it("an escalation to a tier without variant info (no catalog entry) dispatches its configured model, fresh", () => {
    const cfg = config({ fast: { model: SONNET, variant: "low", costRatio: 1 }, medium: { model: "anthropic/uncataloged", variant: "medium", costRatio: 5 } }, { maxAttemptsPerTier: 0 });
    const policy = buildEscalatePolicy(cfg, V2);
    let state = newLadderState("fast", policy);
    let plan = planFirstAttempt(cfg, "fast");
    let escalated: AttemptPlan | undefined;
    for (let i = 0; i < 8 && escalated === undefined; i++) {
      const next = failOnce(cfg, policy, state, plan, "child-1", 1_000);
      state = next.state;
      plan = next.plan;
      if (plan.step === "escalate") escalated = plan;
    }
    expect(escalated).toMatchObject({ agent: "medium", model: { modelID: "uncataloged", variant: "medium" } });
    expect(escalated?.resumeSessionID).toBeUndefined();
    expect(escalated?.resumeBasis?.reason).toBe("unknown-budget");
  });
});
