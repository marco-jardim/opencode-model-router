/**
 * test/unit/guard-resume.test.ts
 *
 * Guard-layer resume accounting: beginDispatch resets the per-dispatch
 * tool-call budget, while the cumulative ceiling (budget x
 * CUMULATIVE_BUDGET_MULTIPLIER) still bounds a session that keeps resuming.
 */

import { describe, it, expect } from "vitest";
import { createGuardStore } from "../../src/guard/store";
import {
  CUMULATIVE_BUDGET_MULTIPLIER,
  DEFAULT_GUARD_BUDGET,
  guardAfterCall,
  guardBeforeCall,
} from "../../src/guard/enforce";
import type { RouterConfig } from "../../src/router/config";

const cumulativeCeiling = DEFAULT_GUARD_BUDGET * CUMULATIVE_BUDGET_MULTIPLIER;

const baseCfg: RouterConfig = {
  activePreset: "default",
  presets: {
    default: {
      fast: { model: "m", description: "fast tier", whenToUse: [] },
    },
  },
  rules: [],
  defaultTier: "fast",
};

const enforcedCfg: RouterConfig = {
  ...baseCfg,
  enforcement: { mode: "enforced" },
};

const enforcedBudget10Cfg: RouterConfig = {
  ...baseCfg,
  enforcement: { mode: "enforced", guard: { budget: 10 } },
};

const advisoryCfg: RouterConfig = {
  ...baseCfg,
  enforcement: { mode: "advisory" },
};

const env: Record<string, string | undefined> = {};

function allowedWrite(
  store: ReturnType<typeof createGuardStore>,
  cfg: RouterConfig,
  sessionID: string,
  index: number,
): void {
  const toolArgs = { filePath: `out-${index}.txt` };
  const before = guardBeforeCall({
    cfg,
    tier: "fast",
    sessionID,
    tool: "write",
    toolArgs,
    store,
    env,
  });
  expect(before.block).toBe(false);
  guardAfterCall({
    cfg,
    tier: "fast",
    sessionID,
    tool: "write",
    toolArgs,
    output: { output: "ok" },
    store,
  });
}

function fillCumulativeCeiling(
  store: ReturnType<typeof createGuardStore>,
  cfg: RouterConfig,
  sessionID: string,
): void {
  for (let i = 0; i < cumulativeCeiling; i += 1) {
    if (i > 0 && i % DEFAULT_GUARD_BUDGET === 0) store.beginDispatch(sessionID);
    allowedWrite(store, cfg, sessionID, i);
  }
}

describe("guard dispatch resume budget", () => {
  it("beginDispatch resets per-dispatch tool-call count and preserves cumulative total", () => {
    const store = createGuardStore();
    const sid = "resume-reset";

    allowedWrite(store, enforcedCfg, sid, 0);
    allowedWrite(store, enforcedCfg, sid, 1);

    const before = store.get(sid);
    expect(before?.toolCallCount).toBe(2);
    expect(before?.totalToolCallCount).toBe(2);
    expect(before?.dispatches).toBe(1);

    store.beginDispatch(sid);

    const after = store.get(sid);
    expect(after?.toolCallCount).toBe(0);
    expect(after?.totalToolCallCount).toBe(2);
    expect(after?.dispatches).toBe(2);
    // Redundancy fingerprints and deliverable state survive the reset.
    expect(after?.deliverableExecuted).toBe(true);
  });

  it("ATTACK: repeated resumes each under the per-dispatch budget still get blocked", () => {
    const store = createGuardStore();
    const sid = "resume-cumulative-enforced";

    // 3 dispatches x 25 calls: the per-dispatch cap never fires.
    fillCumulativeCeiling(store, enforcedCfg, sid);
    store.beginDispatch(sid);
    expect(store.get(sid)?.toolCallCount).toBe(0);

    const result = guardBeforeCall({
      cfg: enforcedCfg,
      tier: "fast",
      sessionID: sid,
      tool: "write",
      toolArgs: { filePath: "over-ceiling.txt" },
      store,
      env,
    });

    expect(result.block).toBe(true);
    expect(result.guard).toBe("cumulative_iteration_cap");
    expect(result.message).toContain("cumulative");
    expect(result.message).toContain(String(cumulativeCeiling));
    expect(result.message).toContain("4 dispatches");
  });

  it("keeps the existing per-dispatch budget message when the current dispatch exhausts its budget", () => {
    const store = createGuardStore();
    const sid = "resume-per-dispatch-enforced";

    for (let i = 0; i < DEFAULT_GUARD_BUDGET; i += 1) {
      allowedWrite(store, enforcedCfg, sid, i);
    }

    const result = guardBeforeCall({
      cfg: enforcedCfg,
      tier: "fast",
      sessionID: sid,
      tool: "write",
      toolArgs: { filePath: "per-dispatch-over.txt" },
      store,
      env,
    });

    expect(result.block).toBe(true);
    expect(result.guard).toBe("iteration_cap");
    expect(result.message).toContain(
      `tool-call budget ${DEFAULT_GUARD_BUDGET} exhausted`,
    );
    expect(result.message).not.toContain("cumulative");
  });

  it("derives the cumulative ceiling from the configured per-dispatch budget", () => {
    const store = createGuardStore();
    const perDispatchSid = "resume-configured-budget-per-dispatch";

    for (let i = 0; i < 10; i += 1) {
      allowedWrite(store, enforcedBudget10Cfg, perDispatchSid, i);
    }

    const perDispatchResult = guardBeforeCall({
      cfg: enforcedBudget10Cfg,
      tier: "fast",
      sessionID: perDispatchSid,
      tool: "write",
      toolArgs: { filePath: "per-dispatch-over-custom.txt" },
      store,
      env,
    });

    expect(perDispatchResult.block).toBe(true);
    expect(perDispatchResult.message).toContain("tool-call budget 10 exhausted");
    expect(perDispatchResult.message).not.toContain("cumulative");

    const cumulativeSid = "resume-configured-budget-cumulative";
    for (let i = 0; i < 30; i += 1) {
      if (i > 0 && i % 10 === 0) store.beginDispatch(cumulativeSid);
      allowedWrite(store, enforcedBudget10Cfg, cumulativeSid, i);
    }
    store.beginDispatch(cumulativeSid);

    const cumulativeResult = guardBeforeCall({
      cfg: enforcedBudget10Cfg,
      tier: "fast",
      sessionID: cumulativeSid,
      tool: "write",
      toolArgs: { filePath: "cumulative-over-custom.txt" },
      store,
      env,
    });

    expect(cumulativeResult.block).toBe(true);
    expect(cumulativeResult.message).toContain("cumulative");
    expect(cumulativeResult.message).toContain("30");
    expect(cumulativeResult.message).not.toContain("75");
  });

  it("advisory mode records cumulative would-blocks but never blocks", () => {
    const store = createGuardStore();
    const sid = "resume-cumulative-advisory";

    fillCumulativeCeiling(store, advisoryCfg, sid);
    store.beginDispatch(sid);

    const toolArgs = { filePath: "advisory-over-ceiling.txt" };
    const result = guardBeforeCall({
      cfg: advisoryCfg,
      tier: "fast",
      sessionID: sid,
      tool: "write",
      toolArgs,
      store,
      env,
    });

    expect(result.block).toBe(false);
    expect(result.guard).toBe("cumulative_iteration_cap");

    const output = { output: "still ran" };
    guardAfterCall({
      cfg: advisoryCfg,
      tier: "fast",
      sessionID: sid,
      tool: "write",
      toolArgs,
      output,
      store,
    });
    expect(String(output.output)).toContain("GUARD:cumulative_iteration_cap");
  });

  it("a session that never resumes is unaffected by the cumulative clause", () => {
    const store = createGuardStore();
    const sid = "no-resume-unchanged";

    for (let i = 0; i < DEFAULT_GUARD_BUDGET - 1; i += 1) {
      allowedWrite(store, enforcedCfg, sid, i);
    }

    const state = store.get(sid);
    expect(state?.dispatches).toBe(1);
    expect(state?.totalToolCallCount).toBe(state?.toolCallCount);
    expect(state && state.totalToolCallCount < cumulativeCeiling).toBe(true);
  });

  it("beginDispatch is a safe no-op for unknown sessions", () => {
    const store = createGuardStore();

    expect(() => store.beginDispatch("missing-session")).not.toThrow();
    expect(store.get("missing-session")).toBeUndefined();
  });
});
