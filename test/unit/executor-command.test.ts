import { describe, expect, it } from "vitest";
import { createPlanCommand, parsePlanCommand, planInstructions, type PlanCallArgs } from "../../src/executor/command";
import { buildPlanHelp, buildRouterHelp, PLAN_HELP_LINES } from "../../src/commands/output";
import type { ExecutorRuntime } from "../../src/executor/types";

// The command never touches the runtime; the factory only needs a value of its type.
const runtime = {} as unknown as ExecutorRuntime;
const command = createPlanCommand(runtime);

function callOf(args: string): PlanCallArgs {
  const parsed = parsePlanCommand(args);
  if (parsed.kind !== "call") throw new Error(`expected a call for "${args}", got help (${parsed.reason ?? "no reason"})`);
  return parsed.call;
}

/** The arguments the instruction asks the orchestrator to pass to `router_plan`. */
function jsonOf(text: string): unknown {
  const m = /```json\n(.*)\n```/.exec(text);
  if (m === null) throw new Error(`no json block in: ${text}`);
  return JSON.parse(m[1] as string);
}

describe("/plan command", () => {
  it("is named plan", () => {
    expect(command.name).toBe("plan");
    expect(command.description.length).toBeGreaterThan(0);
  });

  it("parses every subcommand", () => {
    expect(callOf("run docs/plans/x.md")).toEqual({ action: "compile", path: "docs/plans/x.md" });
    expect(callOf("status")).toEqual({ action: "status" });
    expect(callOf("status plan-1")).toEqual({ action: "status", planId: "plan-1" });
    expect(callOf("inbox")).toEqual({ action: "status", inbox: true });
    expect(callOf("answer q1 yes, go ahead")).toEqual({ action: "answer", id: "q1", text: "yes, go ahead" });
    for (const action of ["pause", "resume", "abort", "land", "adopt"] as const) {
      expect(callOf(`${action} plan-1`)).toEqual({ action, planId: "plan-1" });
    }
  });

  it("is case-insensitive on the subcommand and tolerant of extra whitespace", () => {
    expect(callOf("  STATUS   plan-1  ")).toEqual({ action: "status", planId: "plan-1" });
  });

  it("keeps the answer text as typed, unwrapping a single quoted text", () => {
    expect(callOf('answer q1 use "a  b" here')).toEqual({ action: "answer", id: "q1", text: 'use "a  b" here' });
    expect(callOf('answer q1 "only this"')).toEqual({ action: "answer", id: "q1", text: "only this" });
  });

  it("accepts a quoted Windows path with spaces", () => {
    expect(callOf('run "D:\\My Plans\\critical path.md"')).toEqual({ action: "compile", path: "D:\\My Plans\\critical path.md" });
    expect(callOf("run 'D:\\My Plans\\p.md' --phases 1.1")).toEqual({
      action: "compile",
      path: "D:\\My Plans\\p.md",
      phases: ["1.1"],
    });
    expect(callOf("run D:\\plans\\p.md")).toEqual({ action: "compile", path: "D:\\plans\\p.md" });
  });

  it("parses /plan run with --phases and --done-before", () => {
    expect(callOf("run p.md --phases 1.1,1.2 --done-before 2.1")).toEqual({
      action: "compile",
      path: "p.md",
      phases: ["1.1", "1.2"],
      doneBefore: "2.1",
    });
    expect(callOf("run --done-before 2.1 p.md --phases=3.1")).toEqual({
      action: "compile",
      path: "p.md",
      phases: ["3.1"],
      doneBefore: "2.1",
    });
  });

  it("builds the same arguments as a direct router_plan compile call", () => {
    const direct: PlanCallArgs = { action: "compile", path: "D:\\My Plans\\p.md", phases: ["4.1", "4.2"], doneBefore: "3.3" };
    const viaCommand = callOf('run "D:\\My Plans\\p.md" --phases 4.1,4.2 --done-before 3.3');
    expect(viaCommand).toEqual(direct);
    // The instruction carries exactly those arguments.
    expect(jsonOf(command.execute('run "D:\\My Plans\\p.md" --phases 4.1,4.2 --done-before 3.3'))).toEqual(direct);
    expect(planInstructions(direct)).toBe(command.execute('run "D:\\My Plans\\p.md" --phases 4.1,4.2 --done-before 3.3'));
  });

  it("turns each subcommand into instructions naming router_plan and its arguments", () => {
    for (const args of ["run p.md", "status", "status p1", "inbox", "answer q1 ok", "pause p1", "resume p1", "abort p1", "land p1", "adopt p1"]) {
      const text = command.execute(args);
      expect(text).toContain("`router_plan`");
      expect(jsonOf(text)).toEqual(callOf(args));
    }
  });

  it("prints the help for no or an unknown subcommand", () => {
    const help = buildPlanHelp();
    expect(command.execute("")).toBe(help);
    expect(command.execute("   ")).toBe(help);
    expect(command.execute("frobnicate now")).toBe(help);
    for (const line of PLAN_HELP_LINES) expect(help).toContain(line);
  });

  it("prints the help, with the reason, for malformed arguments", () => {
    for (const args of [
      "run",
      "run a.md b.md",
      "run a.md --phases",
      "run a.md --done-before",
      "run a.md --bogus 1",
      "status a b",
      "inbox extra",
      "answer q1",
      "answer",
      "pause",
      "land a b",
    ]) {
      const parsed = parsePlanCommand(args);
      expect(parsed.kind, args).toBe("help");
      const text = command.execute(args);
      expect(text, args).toContain(buildPlanHelp());
      expect(text, args).not.toContain("```json");
    }
  });
});

describe("/router help and /plan lines", () => {
  // The v1 help as it was before /plan existed.
  const V1_HELP = [
    "# Model Router",
    "Enforcement: **off**",
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/router overrides` — show the global + project override file paths and precedence",
    "- `/router models [provider]` — list valid model ids from your configured providers",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");

  it("v1 help is byte-identical: no /plan line without the plan option", () => {
    expect(buildRouterHelp("off")).toBe(V1_HELP);
    expect(buildRouterHelp("off", {})).toBe(V1_HELP);
    expect(buildRouterHelp("off", { plan: false })).toBe(V1_HELP);
    expect(buildRouterHelp("off")).not.toContain("/plan");
  });

  it("the plan option appends the /plan lines after the existing ones", () => {
    const v2 = buildRouterHelp("off", { plan: true });
    expect(v2.startsWith(V1_HELP)).toBe(true);
    expect(v2).toBe([V1_HELP, "", ...PLAN_HELP_LINES].join("\n"));
    expect(v2).toContain("/plan run <path>");
  });
});
