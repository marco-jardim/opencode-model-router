/**
 * test/unit/guards.roles.test.ts — plan P1.5 (T1.5.1, T1.5.2, T1.5.4).
 *
 * §2.9 E6: the reader guard profile (read-only fast tier, routed class
 * review/recon/search, CAP:none + reason:, reader roles), refused calls not
 * charged and not recorded as executed by the repeat check. §2.6: role budgets
 * (total from the role/tier, `budget=` raise up to 2×, cumulative ×3,
 * `NEED MORE: budget` on exhaustion, budgetExhausted).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createGuardStore } from "../../src/guard/store";
import {
  CUMULATIVE_BUDGET_MULTIPLIER,
  DEFAULT_GUARD_BUDGET,
  budgetExhausted,
  buildGuardPolicy,
  captureBudget,
  guardAfterCall,
  guardBeforeCall,
} from "../../src/guard/enforce";
import {
  budgetSpent,
  evaluateGuards,
  forcingMessage,
  guardStopped,
  newGuardState,
  recordDenied,
  refusalCap,
  refusalsSpent,
} from "../../src/guard/guards";
import type { GuardPolicy } from "../../src/guard/guards";
import {
  GUARD_CUMULATIVE_MULTIPLIER,
  READER_CLASSES,
  REFUSAL_CAP,
  ROUTE_BUDGET_RAISE_MAX,
  TIER_GUARD_BUDGET,
  positiveBudget,
  raisedBudget,
  readerReason,
  roleGuardProfile,
} from "../../src/router/guard-profile";
import type { GuardProfile } from "../../src/router/guard-profile";
import type { RoleSpec } from "../../src/router/roles";
import type { RouterConfig } from "../../src/router/config";
import { forgetDispatch, rememberDispatch } from "../../src/router/sessions";

type Store = ReturnType<typeof createGuardStore>;

const tiers = {
  fast: { model: "p/fast", description: "fast tier", whenToUse: [] },
  medium: { model: "p/medium", description: "medium tier", whenToUse: [] },
  heavy: { model: "p/heavy", description: "heavy tier", whenToUse: [] },
};

function cfgOf(mode: "enforced" | "advisory" | "off", guard: Record<string, unknown> = {}): RouterConfig {
  return {
    activePreset: "default",
    presets: { default: tiers },
    rules: [],
    defaultTier: "medium",
    enforcement: { mode, guard },
  } as unknown as RouterConfig;
}

const env: Record<string, string | undefined> = {};
let seq = 0;
const sid = (label: string): string => `gr-${label}-${++seq}`;

interface CallOpts {
  tier?: string | null;
  profile?: GuardProfile;
  cap?: number | "none" | null;
  output?: string;
}

/** One tool call through both hooks; returns the before result and the output the child sees. */
function call(store: Store, cfg: RouterConfig, session: string, tool: string, args: Record<string, unknown>, opts: CallOpts = {}) {
  const tier = opts.tier === undefined ? "medium" : opts.tier;
  const before = guardBeforeCall({
    cfg, tier, sessionID: session, tool, toolArgs: args, store, env,
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
  });
  const output = { output: opts.output ?? "ok" as unknown };
  if (!before.block) {
    guardAfterCall({
      cfg, tier, sessionID: session, tool, toolArgs: args, output, store,
      ...(opts.profile ? { profile: opts.profile } : {}),
    });
  }
  return { before, output: String(output.output) };
}

const read = (i: number) => ({ filePath: `src/file-${i}.ts` });

const reader40: GuardProfile = { kind: "reader", budget: 40, cumulative: 120 };
const producer5: GuardProfile = { kind: "producer", budget: 5, cumulative: 15 };

function role(guard: "reader" | "producer", budget: Record<string, number>): Pick<RoleSpec, "guard" | "budget"> {
  return { guard, budget };
}

afterEach(() => {
  for (let i = 0; i <= seq; i++) forgetDispatch(`gr-class-${i}`);
});

// ---------------------------------------------------------------------------
// guard-profile.ts
// ---------------------------------------------------------------------------

describe("readerReason", () => {
  it("a role profile decides alone", () => {
    expect(readerReason({ profile: reader40 })).toBe("role");
    expect(readerReason({ profile: producer5, readOnlyTier: true, taskClass: "review", cap: "none" })).toBeNull();
  });

  it("tier signals in order: read-only tier, reader class, CAP:none", () => {
    expect(readerReason({ readOnlyTier: true, taskClass: "review" })).toBe("read-only-tier");
    for (const c of ["review", "recon", "search"]) expect(readerReason({ taskClass: c })).toBe("class");
    expect(readerReason({ taskClass: "implement", cap: "none" })).toBe("uncapped");
  });

  it("everything else is a producer", () => {
    expect(readerReason({})).toBeNull();
    expect(readerReason({ readOnlyTier: false, taskClass: "implement", cap: 8 })).toBeNull();
    expect(readerReason({ taskClass: null, cap: null })).toBeNull();
    expect(READER_CLASSES.has("debug")).toBe(false);
  });
});

describe("role budgets (§2.6)", () => {
  it("positiveBudget keeps positive integers only", () => {
    expect(positiveBudget(40)).toBe(40);
    expect(positiveBudget(7.9)).toBe(7);
    for (const bad of [0, -3, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "40", undefined, null]) {
      expect(positiveBudget(bad)).toBeUndefined();
    }
  });

  it("budget= raises up to 2× and never lowers", () => {
    expect(raisedBudget(40, undefined)).toBe(40);
    expect(raisedBudget(40, null)).toBe(40);
    expect(raisedBudget(40, 60)).toBe(60);
    expect(raisedBudget(40, 80)).toBe(80);
    expect(raisedBudget(40, 81)).toBe(80); // above 2× → clamped
    expect(raisedBudget(40, 10000)).toBe(40 * ROUTE_BUDGET_RAISE_MAX);
    expect(raisedBudget(40, 10)).toBe(40); // raise-only
    expect(raisedBudget(40, 0)).toBe(40);
    expect(raisedBudget(40, Number.NaN)).toBe(40);
  });

  it("roleGuardProfile: total from the role and tier, cumulative ×3", () => {
    const explorer = role("reader", { fast: 30, medium: 40 });
    expect(roleGuardProfile(explorer, "medium")).toEqual({ kind: "reader", budget: 40, cumulative: 120 });
    expect(roleGuardProfile(explorer, "fast", 45)).toEqual({ kind: "reader", budget: 45, cumulative: 135 });
    // budget= above 2× clamped.
    expect(roleGuardProfile(explorer, "fast", 500)).toEqual({ kind: "reader", budget: 60, cumulative: 180 });
    const implementer = role("producer", { fast: 40, medium: 80, heavy: 120 });
    expect(roleGuardProfile(implementer, "heavy", 1000)).toEqual({ kind: "producer", budget: 240, cumulative: 720 });
  });

  it("roleGuardProfile: a tier the role has no budget for (or an invalid one) falls back to the tier budget", () => {
    const explorer = role("reader", { fast: 30, medium: 40, broken: 0 });
    expect(roleGuardProfile(explorer, "heavy").budget).toBe(TIER_GUARD_BUDGET);
    expect(roleGuardProfile(explorer, "broken").budget).toBe(TIER_GUARD_BUDGET);
    expect(roleGuardProfile(explorer, "toString").budget).toBe(TIER_GUARD_BUDGET);
    expect(roleGuardProfile(explorer, "heavy").cumulative).toBe(TIER_GUARD_BUDGET * GUARD_CUMULATIVE_MULTIPLIER);
  });
});

// ---------------------------------------------------------------------------
// buildGuardPolicy
// ---------------------------------------------------------------------------

describe("buildGuardPolicy(cfg, tier, profile?)", () => {
  it("tier agents keep 25/×3 and an unchanged policy shape (golden)", () => {
    expect(DEFAULT_GUARD_BUDGET).toBe(25);
    expect(CUMULATIVE_BUDGET_MULTIPLIER).toBe(3);
    expect(buildGuardPolicy(cfgOf("enforced"), "heavy")).toEqual({
      budget: 25,
      cumulativeBudget: 75,
      readDraftCap: 3,
      sameOpRetryCap: 1,
      blockSelfScript: true,
      deliverableFirst: true,
      blockScriptWrites: false,
      deliverableSignal: null,
    });
    expect(buildGuardPolicy(cfgOf("enforced", { budget: 12 }), "fast").cumulativeBudget).toBe(36);
  });

  it("a role profile supplies the budgets, the kind and the NEED MORE instruction", () => {
    const p = buildGuardPolicy(cfgOf("enforced", { budget: 12 }), "medium", reader40);
    expect(p).toMatchObject({ budget: 40, cumulativeBudget: 120, reader: true, needMoreOnExhaustion: true });
    expect(buildGuardPolicy(cfgOf("enforced"), "medium", producer5)).toMatchObject({ budget: 5, cumulativeBudget: 15, reader: false });
  });

  it("an invalid profile budget falls back; the cumulative ceiling is never below the budget", () => {
    expect(buildGuardPolicy(cfgOf("enforced", { budget: 12 }), "medium", { kind: "reader", budget: 0, cumulative: -1 }))
      .toMatchObject({ budget: 12, cumulativeBudget: 36 });
    expect(buildGuardPolicy(cfgOf("enforced"), "medium", { kind: "producer", budget: 30, cumulative: 10 }))
      .toMatchObject({ budget: 30, cumulativeBudget: 30 });
  });
});

// ---------------------------------------------------------------------------
// E6 reproduction: reader profile
// ---------------------------------------------------------------------------

describe("E6 — reader profile: no consecutive-non-producing denial", () => {
  it("reader role with 40 reads → no denial; the 41st call hits the role budget", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("role");
    for (let i = 0; i < 40; i++) {
      expect(call(store, cfg, s, "read", read(i), { profile: reader40 }).before.block).toBe(false);
    }
    // QA-P15-2-1: using the whole budget is not a stop; the refusal of call 41 is.
    expect(budgetExhausted(s)).toBe(false);
    const r = call(store, cfg, s, "read", read(40), { profile: reader40 }).before;
    expect(r.block).toBe(true);
    expect(r.guard).toBe("iteration_cap");
    expect(r.message).toContain("NEED MORE: budget");
    expect(r.message).toContain("progress summary");
    expect(budgetExhausted(s)).toBe(true);
  });

  it("read-only fast tier (#78) with 40 reads → no denial", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced", { budget: 50 });
    const s = sid("fast");
    for (let i = 0; i < 40; i++) {
      expect(call(store, cfg, s, "grep", { pattern: `p${i}` }, { tier: "fast" }).before.block).toBe(false);
    }
  });

  it("a fast tier configured readOnly:false stays a producer", () => {
    const store = createGuardStore();
    const cfg = { ...cfgOf("enforced"), presets: { default: { ...tiers, fast: { ...tiers.fast, readOnly: false } } } } as unknown as RouterConfig;
    const s = sid("fastrw");
    for (let i = 0; i < 3; i++) call(store, cfg, s, "read", read(i), { tier: "fast" });
    expect(call(store, cfg, s, "read", read(3), { tier: "fast" }).before.guard).toBe("read_budget");
  });

  it("routed class=review|recon|search (dispatch registry) → no denial", () => {
    for (const taskClass of ["review", "recon", "search"]) {
      const store = createGuardStore();
      const cfg = cfgOf("enforced", { budget: 50 });
      const s = `gr-class-${++seq}`;
      rememberDispatch(s, {
        facts: { class: taskClass, risk: "high", scope: "repo", needs: [], confidence: 0.9, source: "route-line" },
        agent: "heavy",
        model: "p/heavy",
        tier: "heavy",
      });
      for (let i = 0; i < 40; i++) {
        expect(call(store, cfg, s, "read", read(i), { tier: "heavy" }).before.block).toBe(false);
      }
    }
  });

  it("a routed producer class keeps the draft guard", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = `gr-class-${++seq}`;
    rememberDispatch(s, {
      facts: { class: "implement", risk: "low", scope: "single", needs: [], confidence: 0.9, source: "route-line" },
      agent: "heavy", model: "p/heavy",
    });
    for (let i = 0; i < 3; i++) call(store, cfg, s, "read", read(i), { tier: "heavy" });
    expect(call(store, cfg, s, "read", read(3), { tier: "heavy" }).before.guard).toBe("read_budget");
  });

  it("CAP:none + reason: (explicit cap) → no denial; a numeric cap stays a producer", () => {
    const cfg = cfgOf("enforced", { budget: 50 });
    const store = createGuardStore();
    const s = sid("capnone");
    for (let i = 0; i < 40; i++) {
      expect(call(store, cfg, s, "read", read(i), { tier: "heavy", cap: "none" }).before.block).toBe(false);
    }
    const capped = sid("cap8");
    for (let i = 0; i < 3; i++) call(store, cfg, capped, "read", read(i), { tier: "heavy", cap: 8 });
    expect(call(store, cfg, capped, "read", read(3), { tier: "heavy", cap: 8 }).before.guard).toBe("read_budget");
  });

  it("QA-P15-1-3: CAP:none is known before the first call — 3 router_git calls then a read are allowed", () => {
    const cfg = cfgOf("enforced", { budget: 50 });
    const store = createGuardStore();
    const s = sid("capfirst");
    for (let i = 0; i < 3; i++) {
      expect(call(store, cfg, s, "router_git_log", { n: i }, { tier: "heavy", cap: "none" }).before.block).toBe(false);
    }
    expect(store.get(s)?.consecutiveNonProducing).toBe(3);
    expect(call(store, cfg, s, "read", read(0), { tier: "heavy", cap: "none" }).before.block).toBe(false);
    // Before the fix (cap learned from the first read's banner): the 4th call was denied.
    const producer = sid("capfirst-producer");
    for (let i = 0; i < 3; i++) call(store, cfg, producer, "router_git_log", { n: i }, { tier: "heavy", cap: 3 });
    expect(call(store, cfg, producer, "read", read(0), { tier: "heavy", cap: 3 }).before.guard).toBe("read_budget");
  });

  it("QA-P15-1-3: the cap belongs to its dispatch round — a resume with CAP:8 is a producer again", () => {
    const cfg = cfgOf("enforced");
    const store = createGuardStore();
    const s = sid("capround");
    for (let i = 0; i < 4; i++) expect(call(store, cfg, s, "read", read(i), { tier: "heavy", cap: "none" }).before.block).toBe(false);
    store.beginDispatch(s);
    const r = call(store, cfg, s, "read", read(4), { tier: "heavy", cap: 8 }).before;
    expect(r.block).toBe(true);
    expect(r.guard).toBe("read_budget");
  });

  it("producer keeps the draft guard (enforced): the 4th consecutive read is denied", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("producer");
    for (let i = 0; i < 3; i++) expect(call(store, cfg, s, "read", read(i)).before.block).toBe(false);
    const r = call(store, cfg, s, "read", read(3)).before;
    expect(r.block).toBe(true);
    expect(r.guard).toBe("read_budget");
    expect(r.message).toContain("take a producing action");
  });
});

describe("E6 — dogfood baseline: advisory footer (before/after golden)", () => {
  const footer = "[\u26a0 GUARD:read_budget]";

  it("before (producer heavy, no CAP:none): the footer fires at reads_since_produce ≥ 3", () => {
    const store = createGuardStore();
    const cfg = cfgOf("advisory");
    const s = sid("adv-before");
    const outputs = Array.from({ length: 5 }, (_, i) => call(store, cfg, s, "read", read(i), { tier: "heavy", output: `c\n\n[cap: ${i + 1}/3]` }).output);
    expect(outputs.slice(0, 3).some((o) => o.includes(footer))).toBe(false);
    expect(outputs[3]).toContain(`${footer} [budget 3/25 | deliverable=n/a | reads_since_produce=3] NEXT: take a producing action (write/edit) or emit your final answer`);
  });

  it("after (heavy review dispatch with CAP:none + reason:, 20 reads): no footer at all", () => {
    const store = createGuardStore();
    const cfg = cfgOf("advisory");
    const s = sid("adv-after");
    for (let i = 0; i < 20; i++) {
      const out = call(store, cfg, s, "read", read(i), { tier: "heavy", cap: "none", output: `c\n\n[cap: ${i + 1}/∞]` }).output;
      expect(out).not.toContain(footer);
      expect(out).not.toContain("GUARD:");
    }
  });

  it("a reader's budget footer asks for the final answer, never a write", () => {
    const store = createGuardStore();
    const cfg = cfgOf("advisory", { budget: 2 });
    const s = sid("adv-cap");
    call(store, cfg, s, "grep", { pattern: "a" }, { tier: "fast" });
    call(store, cfg, s, "grep", { pattern: "b" }, { tier: "fast" });
    const out = call(store, cfg, s, "grep", { pattern: "c" }, { tier: "fast" }).output;
    expect(out).toContain("[\u26a0 GUARD:iteration_cap]");
    expect(out).toContain("NEXT: emit your final answer");
    expect(out).not.toContain("write/edit");
  });
});

// ---------------------------------------------------------------------------
// Denied calls: not charged, not recorded as executed
// ---------------------------------------------------------------------------

describe("E6 — refused calls are not charged", () => {
  it("a denied call is not charged to the budget", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("uncharged");
    for (let i = 0; i < 3; i++) call(store, cfg, s, "read", read(i));
    const state = store.get(s)!;
    expect(state.toolCallCount).toBe(3);
    for (let i = 3; i < 8; i++) expect(call(store, cfg, s, "read", read(i)).before.block).toBe(true);
    expect(state.toolCallCount).toBe(3);
    expect(state.totalToolCallCount).toBe(3);
    expect(state.consecutiveNonProducing).toBe(3);
    expect(state.readCount).toBe(3);
    expect(state.blockedCount).toBe(5);
    expect(state.denied).toEqual({ round: 1, count: 5 });
  });

  it("repeat check after a denial: the refused read was never executed, so it is allowed later", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("repeat");
    for (let i = 0; i < 3; i++) call(store, cfg, s, "read", read(i));
    const denied = call(store, cfg, s, "read", read(3)).before;
    expect(denied.guard).toBe("read_budget");
    expect(call(store, cfg, s, "write", { filePath: "src/out.ts" }).before.block).toBe(false);
    // Before the fix: "DENIED: you already ran this exact read".
    const again = call(store, cfg, s, "read", read(3)).before;
    expect(again.block).toBe(false);
    // A read that really ran is still a repeat.
    expect(call(store, cfg, s, "read", read(0)).before.guard).toBe("redundant_read");
  });

  it("a refused self-script still counts in the scorecard metric, not in the budget", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("script");
    const r = call(store, cfg, s, "bash", { command: 'node -e "1"' }).before;
    expect(r.guard).toBe("anti_self_script");
    expect(r.message).toContain("budget 0/25");
    expect(store.get(s)).toMatchObject({ selfScriptCount: 1, toolCallCount: 0, consecutiveNonProducing: 0 });
  });

  it("a loop of refusals is bounded: after `budget` refusals in a dispatch every call is refused", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced", { budget: 4 });
    const s = sid("spin");
    for (let i = 0; i < 4; i++) expect(call(store, cfg, s, "bash", { command: 'node -e "1"' }).before.guard).toBe("anti_self_script");
    const stop = call(store, cfg, s, "write", { filePath: "a.ts" }).before;
    expect(stop.block).toBe(true);
    expect(stop.guard).toBe("denied_cap");
    expect(stop.message).toContain("4 refused tool calls");
    // A resume starts a new round of refusals.
    store.beginDispatch(s);
    expect(call(store, cfg, s, "write", { filePath: "a.ts" }).before.block).toBe(false);
  });

  it("recordDenied resets its count when the dispatch round changes", () => {
    const policy = buildGuardPolicy(cfgOf("enforced"), "medium");
    const state = newGuardState(policy);
    recordDenied(state, { tool: "read", args: read(0) }, policy);
    recordDenied(state, { tool: "read", args: read(1) }, policy);
    expect(state).toMatchObject({ denied: { round: 1, count: 2 }, selfScriptCount: 0, toolCallCount: 0 });
    state.dispatches = 2;
    recordDenied(state, { tool: "read", args: read(2) }, policy);
    expect(state.denied).toEqual({ round: 2, count: 1 });
    expect(evaluateGuards(state, { tool: "write", args: { filePath: "x" } }, policy).allow).toBe(true);
  });

  it("advisory mode is unchanged: the would-blocked call runs and is charged", () => {
    const store = createGuardStore();
    const cfg = cfgOf("advisory");
    const s = sid("advisory");
    for (let i = 0; i < 4; i++) call(store, cfg, s, "read", read(i));
    expect(store.get(s)).toMatchObject({ toolCallCount: 4, readCount: 4, blockedCount: 1 });
    expect(store.get(s)?.denied).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Budgets: exactly at the limit, budgetExhausted
// ---------------------------------------------------------------------------

describe("role budget at the limit and budgetExhausted", () => {
  it("budget exactly at the limit: N calls allowed, call N+1 denied with NEED MORE", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("limit");
    for (let i = 0; i < 5; i++) {
      expect(budgetExhausted(s)).toBe(false);
      expect(call(store, cfg, s, "write", { filePath: `o${i}.ts` }, { profile: producer5 }).before.block).toBe(false);
    }
    expect(store.get(s)?.toolCallCount).toBe(5);
    // QA-P15-2-1 (before: true here): a child that finishes at exactly its budget was not stopped.
    expect(budgetExhausted(s)).toBe(false);
    const r = call(store, cfg, s, "write", { filePath: "o5.ts" }, { profile: producer5 }).before;
    expect(budgetExhausted(s)).toBe(true);
    expect(r.block).toBe(true);
    expect(r.guard).toBe("iteration_cap");
    expect(r.message).toContain("DENIED: tool-call budget 5 exhausted. Stop now and return `NEED MORE: budget` with a progress summary");
    expect(r.message).toContain("NEXT: return `NEED MORE: budget` with a progress summary");
    expect(store.get(s)?.toolCallCount).toBe(5); // the refused call is not charged
  });

  it("tier agents keep their exhaustion message (no NEED MORE)", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced", { budget: 2 });
    const s = sid("tiermsg");
    call(store, cfg, s, "write", { filePath: "a" });
    call(store, cfg, s, "write", { filePath: "b" });
    const r = call(store, cfg, s, "write", { filePath: "c" }).before;
    expect(r.message).toContain("DENIED: tool-call budget 2 exhausted. Stop now and emit your final answer with what you have.");
    expect(r.message).not.toContain("NEED MORE");
    expect(budgetExhausted(s)).toBe(true);
  });

  it("cumulative exhaustion across resumes, and a resume restores the per-dispatch room", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const profile: GuardProfile = { kind: "producer", budget: 2, cumulative: 3 };
    const s = sid("cumulative");
    call(store, cfg, s, "write", { filePath: "a" }, { profile });
    call(store, cfg, s, "write", { filePath: "b" }, { profile });
    expect(budgetExhausted(s)).toBe(false);
    expect(call(store, cfg, s, "write", { filePath: "b2" }, { profile }).before.guard).toBe("iteration_cap");
    expect(budgetExhausted(s)).toBe(true);
    store.beginDispatch(s);
    expect(budgetExhausted(s)).toBe(false); // the stop belongs to round 1
    call(store, cfg, s, "write", { filePath: "c" }, { profile });
    expect(budgetExhausted(s)).toBe(false);
    const r = call(store, cfg, s, "write", { filePath: "d" }, { profile }).before;
    expect(r.guard).toBe("cumulative_iteration_cap");
    expect(r.message).toContain("NEED MORE: budget");
    expect(budgetExhausted(s)).toBe(true);
  });

  it("budgetExhausted tracks a bounded set: the least recently guarded session is dropped", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const profile: GuardProfile = { kind: "producer", budget: 1, cumulative: 3 };
    const first = sid("bounded");
    call(store, cfg, first, "write", { filePath: "a" }, { profile });
    call(store, cfg, first, "write", { filePath: "b" }, { profile }); // refused: a stop
    expect(budgetExhausted(first)).toBe(true);
    for (let i = 0; i < 1000; i++) {
      guardBeforeCall({ cfg, tier: "medium", sessionID: sid("filler"), tool: "read", toolArgs: read(i), store, env });
    }
    expect(store.get(first)?.toolCallCount).toBe(1);
    expect(budgetExhausted(first)).toBe(false);
  });

  it("budgetExhausted is false for unknown sessions and when enforcement is off", () => {
    expect(budgetExhausted("never-seen")).toBe(false);
    const store = createGuardStore();
    const s = sid("off");
    const r = call(store, cfgOf("off"), s, "write", { filePath: "a" }, { profile: { kind: "producer", budget: 1, cumulative: 3 } }).before;
    expect(r.block).toBe(false);
    expect(budgetExhausted(s)).toBe(false);
  });

  it("budgetSpent and forcingMessage for each profile", () => {
    const tierPolicy = buildGuardPolicy(cfgOf("enforced"), "medium");
    const rolePolicy: GuardPolicy = buildGuardPolicy(cfgOf("enforced"), "medium", producer5);
    const state = newGuardState(rolePolicy);
    expect(budgetSpent(state, rolePolicy)).toBe(false);
    expect(forcingMessage(state, rolePolicy)).toContain("NEXT: take a producing action (write/edit) or emit your final answer");
    state.toolCallCount = 5;
    expect(budgetSpent(state, rolePolicy)).toBe(true);
    expect(forcingMessage(state, rolePolicy)).toContain("NEXT: return `NEED MORE: budget` with a progress summary");
    state.toolCallCount = 0;
    state.totalToolCallCount = 15;
    expect(budgetSpent(state, rolePolicy)).toBe(true);
    expect(budgetSpent(state, {})).toBe(false);
    const tierState = newGuardState(tierPolicy);
    tierState.toolCallCount = 25;
    expect(forcingMessage(tierState, tierPolicy)).toBe(
      "[budget 25/25 | deliverable=n/a | reads_since_produce=0] NEXT: take a producing action (write/edit) or emit your final answer",
    );
    expect(forcingMessage(tierState, { ...tierPolicy, reader: true })).toContain("NEXT: emit your final answer");
  });
});

// ---------------------------------------------------------------------------
// QA round 1 (P1.5)
// ---------------------------------------------------------------------------

describe("QA-P15-1-4/5: refusal cap = min(budget, REFUSAL_CAP)", () => {
  const selfScript = { command: 'node -e "1"' };

  it("REFUSAL_CAP is 10; a role child (budget 40) with 30 calls run is stopped after 10 refusals and reported exhausted", () => {
    expect(REFUSAL_CAP).toBe(10);
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("refusals");
    for (let i = 0; i < 30; i++) call(store, cfg, s, "read", read(100 + i), { profile: reader40 });
    for (let i = 0; i < 10; i++) {
      expect(budgetExhausted(s)).toBe(false);
      expect(call(store, cfg, s, "bash", selfScript, { profile: reader40 }).before.guard).toBe("anti_self_script");
    }
    expect(budgetExhausted(s)).toBe(false); // used up is not yet a stop (QA-P15-2-1)
    const stop = call(store, cfg, s, "read", read(0), { profile: reader40 }).before;
    expect(budgetExhausted(s)).toBe(true);
    expect(stop.guard).toBe("denied_cap");
    expect(stop.message).toContain("DENIED: 10 refused tool calls in this dispatch (limit 10). Stop now and return `NEED MORE: budget` with a progress summary");
    expect(stop.message).toContain("NEXT: return `NEED MORE: budget` with a progress summary");
    expect(stop.message).not.toContain("take a producing action");
    // A resume restores the room: the round's refusals no longer count.
    store.beginDispatch(s);
    expect(budgetExhausted(s)).toBe(false);
  });

  it("QA-P15-2-3: 10 refusals do not stop a tier child before its base budget would", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("refusals-early");
    for (let i = 0; i < 10; i++) call(store, cfg, s, "bash", selfScript);
    // Before: denied_cap here (min(25, 10) refusals); after: 0 run + 10 refused < 25.
    expect(call(store, cfg, s, "write", { filePath: "a.ts" }).before.block).toBe(false);
  });

  it("a tier producer at its refusal cap is told to emit its final answer, not to write", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("refusals-tier");
    for (let i = 0; i < 15; i++) call(store, cfg, s, "write", { filePath: `w${i}.ts` });
    for (let i = 0; i < 10; i++) call(store, cfg, s, "bash", selfScript);
    const stop = call(store, cfg, s, "write", { filePath: "a.ts" }).before;
    expect(stop.message).toContain("DENIED: 10 refused tool calls in this dispatch (limit 10). Stop now and emit your final answer with what you have.");
    expect(stop.message).toContain("NEXT: emit your final answer");
    expect(stop.message).not.toContain("NEED MORE");
  });

  it("refusalCap, refusalsSpent and guardStopped", () => {
    const policy = buildGuardPolicy(cfgOf("enforced", { budget: 3 }), "medium");
    const state = newGuardState(policy);
    expect(refusalCap(state)).toBe(3);
    state.budget = 40;
    expect(refusalCap(state)).toBe(REFUSAL_CAP);
    expect(guardStopped(state, policy)).toBe(false);
    for (let i = 0; i < 10; i++) recordDenied(state, { tool: "read", args: read(i) }, policy);
    expect(refusalsSpent(state)).toBe(false); // 0 run + 10 refused < 40 (QA-P15-2-3)
    state.toolCallCount = 29;
    expect(refusalsSpent(state)).toBe(false);
    state.toolCallCount = 30;
    expect(refusalsSpent(state)).toBe(true);
    expect(guardStopped(state, policy)).toBe(true);
  });
});

describe("QA-P15-1-9: a resumed round takes its own budget", () => {
  it("a role budget= raise on the resume applies to that round's per-dispatch cap", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("raise");
    const first: GuardProfile = { kind: "producer", budget: 2, cumulative: 30 };
    const raised: GuardProfile = { kind: "producer", budget: 4, cumulative: 30 };
    call(store, cfg, s, "write", { filePath: "a" }, { profile: first });
    call(store, cfg, s, "write", { filePath: "b" }, { profile: first });
    expect(call(store, cfg, s, "write", { filePath: "c" }, { profile: first }).before.guard).toBe("iteration_cap");
    store.beginDispatch(s);
    for (let i = 0; i < 4; i++) {
      expect(call(store, cfg, s, "write", { filePath: `r${i}` }, { profile: raised }).before.block).toBe(false);
    }
    expect(store.get(s)?.budget).toBe(4);
    expect(call(store, cfg, s, "write", { filePath: "r4" }, { profile: raised }).before.guard).toBe("iteration_cap");
  });

  it("within a round the budget is not refreshed (round 1 keeps the first policy)", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("noraise");
    call(store, cfg, s, "write", { filePath: "a" }, { profile: { kind: "producer", budget: 1, cumulative: 9 } });
    expect(call(store, cfg, s, "write", { filePath: "b" }, { profile: { kind: "producer", budget: 5, cumulative: 9 } }).before.guard).toBe("iteration_cap");
    expect(store.get(s)?.budget).toBe(1);
  });
});

describe("QA-P15-1-11: redundant_read wording", () => {
  it("a reader is told to continue with a different call; a producer keeps its wording", () => {
    const cfg = cfgOf("enforced");
    const store = createGuardStore();
    const reader = sid("redundant-reader");
    call(store, cfg, reader, "read", read(0), { tier: "fast" });
    const r = call(store, cfg, reader, "read", read(0), { tier: "fast" }).before;
    expect(r.guard).toBe("redundant_read");
    expect(r.message).toContain("Reuse the result you already have; continue with a different call or finish.");
    expect(r.message).not.toContain("producing action");
    const producer = sid("redundant-producer");
    call(store, cfg, producer, "read", read(0));
    expect(call(store, cfg, producer, "read", read(0)).before.message).toContain("Reuse the result you already have; take a producing action or finish.");
  });
});

// ---------------------------------------------------------------------------
// QA round 2 (P1.5)
// ---------------------------------------------------------------------------

describe("QA-P15-2-1: budgetExhausted means an enforced stop in the current round", () => {
  it("advisory mode never stops: 30 calls past a budget of 25 → false", () => {
    const store = createGuardStore();
    const cfg = cfgOf("advisory");
    const s = sid("advisory-stop");
    for (let i = 0; i < 30; i++) call(store, cfg, s, "write", { filePath: `a${i}` });
    expect(store.get(s)?.toolCallCount).toBe(30);
    expect(store.get(s)?.stopped).toBeUndefined();
    expect(budgetExhausted(s)).toBe(false);
    expect(captureBudget(s)).toEqual({ tracked: true, stopped: false, usedUp: true });
  });

  it("each stop guard records {round, guard}; other refusals do not", () => {
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("stop-record");
    const profile: GuardProfile = { kind: "producer", budget: 3, cumulative: 9 };
    call(store, cfg, s, "bash", { command: 'node -e "1"' }, { profile });
    expect(store.get(s)?.stopped).toBeUndefined();
    for (const f of ["a", "b", "c"]) call(store, cfg, s, "write", { filePath: f }, { profile });
    expect(store.get(s)?.stopped).toBeUndefined();
    expect(call(store, cfg, s, "write", { filePath: "d" }, { profile }).before.guard).toBe("iteration_cap");
    expect(store.get(s)?.stopped).toEqual({ round: 1, guard: "iteration_cap" });
  });
});

describe("QA-P15-2-2/2-5: captureBudget", () => {
  it("snapshots tracked / stopped / usedUp and carries the read-cap flag", () => {
    expect(captureBudget("")).toEqual({ tracked: false, stopped: false, usedUp: false });
    expect(captureBudget("never-guarded", true)).toEqual({ tracked: false, stopped: false, usedUp: false, readCapReached: true });
    const store = createGuardStore();
    const cfg = cfgOf("enforced");
    const s = sid("capture");
    const profile: GuardProfile = { kind: "producer", budget: 2, cumulative: 9 };
    call(store, cfg, s, "write", { filePath: "a" }, { profile });
    expect(captureBudget(s, false)).toEqual({ tracked: true, stopped: false, usedUp: false, readCapReached: false });
    call(store, cfg, s, "write", { filePath: "b" }, { profile });
    expect(captureBudget(s)).toEqual({ tracked: true, stopped: false, usedUp: true });
    call(store, cfg, s, "write", { filePath: "c" }, { profile });
    const snapshot = captureBudget(s);
    expect(snapshot).toEqual({ tracked: true, stopped: true, usedUp: true });
    // A snapshot is a value: a later resume does not change what was captured.
    store.beginDispatch(s);
    expect(captureBudget(s).stopped).toBe(false);
    expect(snapshot.stopped).toBe(true);
  });
});
