// Phase 2.2 / 2.3 integration: the single-writer runner mark (QA-2.2-1) and the registry's `keepExecution` (QA-2.3-1a).
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RUNNER_TOKENS, RUNNER_TOKEN_TTL_MS, awaitExecutionEnd, consumeRunnerDispatch, lastStepContext, markRunnerDispatch, noteExecutionEnded,
  noteStepContext, rememberDispatch, resetDispatchRegistry, resetRunnerTokens, runnerTokenCount,
} from "../../src/router/sessions";

const FACTS = { class: "implement", risk: "low", scope: "single", needs: [] as string[], confidence: 0.9, source: "rules" };
const key = (over: Partial<{ parentSessionID: string; agent: string; prompt: string }> = {}) => ({ parentSessionID: "root", agent: "medium", prompt: "Do the thing", ...over });

afterEach(() => {
  resetRunnerTokens();
  resetDispatchRegistry();
});

describe("runner mark", () => {
  it("is consumed once, by the same session, agent and prompt only", () => {
    markRunnerDispatch(key(), 1_000);
    expect(consumeRunnerDispatch(key({ parentSessionID: "other" }), 1_001)).toBe(false);
    expect(consumeRunnerDispatch(key({ agent: "fast" }), 1_001)).toBe(false);
    expect(consumeRunnerDispatch(key({ prompt: "Do the thing." }), 1_001)).toBe(false);
    expect(consumeRunnerDispatch(key(), 1_001)).toBe(true);
    expect(consumeRunnerDispatch(key(), 1_002)).toBe(false);
    expect(runnerTokenCount(1_002)).toBe(0);
  });

  it("each announcement is one mark: two announcements are two consumptions", () => {
    markRunnerDispatch(key(), 0);
    markRunnerDispatch(key(), 0);
    expect(runnerTokenCount(0)).toBe(2);
    expect(consumeRunnerDispatch(key(), 1)).toBe(true);
    expect(consumeRunnerDispatch(key(), 1)).toBe(true);
    expect(consumeRunnerDispatch(key(), 1)).toBe(false);
  });

  it("expires after the time limit (120 s): the last instant is still valid, the limit is not", () => {
    expect(RUNNER_TOKEN_TTL_MS).toBeLessThanOrEqual(120_000);
    markRunnerDispatch(key(), 0);
    expect(consumeRunnerDispatch(key(), RUNNER_TOKEN_TTL_MS - 1)).toBe(true);
    markRunnerDispatch(key(), 0);
    expect(consumeRunnerDispatch(key(), RUNNER_TOKEN_TTL_MS)).toBe(false);
    expect(runnerTokenCount(RUNNER_TOKEN_TTL_MS)).toBe(0);
  });

  it("withdrawing removes the runner's own mark, and nothing else", () => {
    const withdraw = markRunnerDispatch(key(), 0);
    markRunnerDispatch(key({ prompt: "other" }), 0);
    withdraw();
    withdraw(); // idempotent
    expect(consumeRunnerDispatch(key(), 1)).toBe(false);
    expect(consumeRunnerDispatch(key({ prompt: "other" }), 1)).toBe(true);
    // a mark that was already consumed cannot be withdrawn over a newer one
    const first = markRunnerDispatch(key(), 10);
    expect(consumeRunnerDispatch(key(), 11)).toBe(true);
    markRunnerDispatch(key(), 12);
    first();
    expect(consumeRunnerDispatch(key(), 13)).toBe(true);
  });

  it("is bounded: past the cap the oldest announcements are dropped", () => {
    for (let i = 0; i < MAX_RUNNER_TOKENS + 10; i++) markRunnerDispatch(key({ prompt: `p${i}` }), 0);
    expect(runnerTokenCount(0)).toBe(MAX_RUNNER_TOKENS);
    expect(consumeRunnerDispatch(key({ prompt: "p0" }), 1)).toBe(false);
    expect(consumeRunnerDispatch(key({ prompt: `p${MAX_RUNNER_TOKENS + 9}` }), 1)).toBe(true);
  });

  it("hashes the prompt: a very long prompt is a cheap key", () => {
    const prompt = "x".repeat(2_000_000);
    markRunnerDispatch(key({ prompt }), 0);
    expect(consumeRunnerDispatch(key({ prompt }), 1)).toBe(true);
    expect(consumeRunnerDispatch(key({ prompt: `${prompt}y` }), 1)).toBe(false);
  });
});

describe("rememberDispatch keepExecution (QA-2.3-1a)", () => {
  const register = (child: string, over: Record<string, unknown> = {}) =>
    rememberDispatch(child, { facts: FACTS, agent: "medium", model: "p/m", variant: "medium", parentSessionID: "root", ...over });

  it("a resume or a ladder attempt (the default) is a new execution: step context and end state start from nothing", () => {
    register("c1");
    noteStepContext("c1", 5_000);
    noteExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(5_000);
    register("c1");
    expect(lastStepContext("c1")).toBeNull();
  });

  it("a registration of the same execution keeps the step context and the end state, and bumps the attempt", () => {
    const first = register("c1", { decisionID: "wrong" });
    noteStepContext("c1", 5_000);
    noteStepContext("c1", 3_000);
    noteExecutionEnded("c1");
    const second = register("c1", { decisionID: "right", keepExecution: true });
    expect(second.attemptIndex).toBe(first.attemptIndex + 1);
    expect(second.decisionID).toBe("right");
    expect(lastStepContext("c1")).toBe(5_000); // the largest step stays
  });

  it("keeps the step context of a running execution, and a later step still raises it", () => {
    register("c1");
    noteStepContext("c1", 1_000);
    register("c1", { keepExecution: true });
    expect(lastStepContext("c1")).toBeNull(); // not ended yet
    noteStepContext("c1", 2_500);
    noteExecutionEnded("c1");
    expect(lastStepContext("c1")).toBe(2_500);
  });

  it("whoever waits for the end keeps waiting across the re-registration, and is released by the end", async () => {
    register("c1");
    const waiting = awaitExecutionEnd("c1", 5_000);
    register("c1", { keepExecution: true });
    noteExecutionEnded("c1");
    await expect(waiting).resolves.toBe(true);
  });

  it("without keepExecution a waiter is released with false (the registration was replaced)", async () => {
    register("c1");
    const waiting = awaitExecutionEnd("c1", 5_000);
    register("c1");
    await expect(waiting).resolves.toBe(false);
  });

  it("keepExecution on a first registration is just a registration", () => {
    register("fresh", { keepExecution: true });
    expect(lastStepContext("fresh")).toBeNull();
  });
});