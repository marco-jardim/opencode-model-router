import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createTurnStateRegistry, PLAN_PROVIDER_NAME } from "../../src/compat/turn-state";
import {
  createExecutorInstructionsProvider,
  EXECUTOR_INSTRUCTIONS_ORDER,
  EXECUTOR_INSTRUCTIONS_PROVIDER_NAME,
  EXECUTOR_INSTRUCTIONS_TEXT,
} from "../../src/executor/instructions";

function providerFor(line: string | null) {
  return createExecutorInstructionsProvider({ planLine: () => line });
}

describe("executor instructions provider", () => {
  it("renders nothing without a plan or with a completed plan (planLine null)", () => {
    const provider = providerFor(null);
    expect(provider.render("s1")).toBeUndefined();
    expect(provider.active?.("s1")).toBe(false);
  });

  it("renders the exact text while a plan runs", () => {
    const provider = providerFor("plan running 1/3");
    expect(provider.render("s1")).toBe(EXECUTOR_INSTRUCTIONS_TEXT);
    expect(provider.active?.("s1")).toBe(true);
    expect(EXECUTOR_INSTRUCTIONS_TEXT).toBe([
      "Plan executor rules:",
      "- Run the `manual` tasks listed in the router state yourself and report each with `router_plan action=done`.",
      "- Never edit a slot or the plan file.",
      "- Never report the plan done while `router_plan action=status` says running.",
      "- Answer inbox items only with the human's answer or with text this plan already states.",
    ].join("\n"));
  });

  it("is byte-stable across calls and independent of the plan line", () => {
    const a = providerFor("plan running 1/3");
    const b = providerFor("plan running 2/3");
    expect(a.render("s1")).toBe(a.render("s1"));
    expect(a.render("s1")).toBe(b.render("s2"));
  });

  it("sorts after the plan provider inside the tail", () => {
    expect(EXECUTOR_INSTRUCTIONS_PROVIDER_NAME).not.toBe(PLAN_PROVIDER_NAME);
    const registry = createTurnStateRegistry({ logger: { warn: () => undefined } });
    registry.registerTurnStateProvider(providerFor("running"));
    registry.registerTurnStateProvider({ name: PLAN_PROVIDER_NAME, order: 60, render: () => "PLAN LINE", active: () => true });
    expect(EXECUTOR_INSTRUCTIONS_ORDER).toBeGreaterThan(60);
    const tail = registry.buildTurnState("s1") ?? "";
    expect(tail.indexOf("PLAN LINE")).toBeGreaterThanOrEqual(0);
    expect(tail.indexOf("PLAN LINE")).toBeLessThan(tail.indexOf(EXECUTOR_INSTRUCTIONS_TEXT));
  });

  it("uses no system-prompt hook", () => {
    const source = readFileSync(new URL("../../src/executor/instructions.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/experimental\.chat\.system\.transform|system\.transform|\bsystem\.push\b/);
  });
});
