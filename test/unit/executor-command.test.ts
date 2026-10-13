import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanCommand, parsePlanCommand, planInstructions, type PlanCallArgs } from "../../src/executor/command";
import { buildPlanHelp, buildRouterHelp, PLAN_HELP_LINES } from "../../src/commands/output";
import { executeRouterPlan } from "../../src/executor/tool";
import type { CompileSummary, ExecutorRuntime } from "../../src/executor/types";

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
    expect(callOf("answer q1 yes, go ahead")).toEqual({ action: "answer", inboxId: "q1", text: "yes, go ahead" });
    for (const action of ["approve", "pause", "resume", "abort", "land", "adopt"] as const) {
      expect(callOf(`${action} plan-1`)).toEqual({ action, planId: "plan-1" });
    }
  });

  it("QA-4.1-1: /plan approve <planId> emits action=approve (plan amendment A-4.1-1)", () => {
    expect(callOf("approve plan-1")).toEqual({ action: "approve", planId: "plan-1" });
    expect(jsonOf(command.execute("approve plan-1"))).toEqual({ action: "approve", planId: "plan-1" });
    expect(parsePlanCommand("approve").kind).toBe("help");
    expect(parsePlanCommand("approve a b").kind).toBe("help");
  });

  it("QA-4.1-1, QA-4.1-7: the /plan run instruction compiles only, routes a residue step and leaves approval to the user", () => {
    const text = command.execute("run p.md");
    expect(text).toContain("to compile the plan:");
    expect(text).not.toMatch(/and start/);
    // A residue step is not a dead end: the prompt goes to an architect and its JSON back through action=residue.
    expect(text).toContain("`awaiting-residue`");
    expect(text).toMatch(/to an architect subagent/);
    expect(text).toContain("`action=residue`");
    // Approval is the user's: shown to them, approved only on their explicit word or /plan approve.
    expect(text).toContain("`awaiting-approval`: show the summary to the user and wait for their approval.");
    expect(text).toContain("only after the user explicitly approves in this conversation");
    expect(text).toContain("`/plan approve <planId>`");
    // The other subcommands keep the plain report instruction.
    expect(command.execute("status")).toContain("Then report the tool result to the user verbatim. Do nothing else for this command.");
    expect(command.execute("status")).not.toContain("awaiting-residue");
  });

  it("QA-4.1-5: /plan inbox and /plan answer take an optional --plan <planId>", () => {
    expect(callOf("inbox --plan p2")).toEqual({ action: "status", inbox: true, planId: "p2" });
    expect(callOf("inbox --plan=p2")).toEqual({ action: "status", inbox: true, planId: "p2" });
    expect(callOf("answer --plan p2 q1 yes, go ahead")).toEqual({ action: "answer", planId: "p2", inboxId: "q1", text: "yes, go ahead" });
    expect(callOf('answer --plan=p2 q1 "only this"')).toEqual({ action: "answer", planId: "p2", inboxId: "q1", text: "only this" });
    // Without --plan nothing changes.
    expect(callOf("answer q1 --plan is a word here")).toEqual({ action: "answer", inboxId: "q1", text: "--plan is a word here" });
    for (const args of ["inbox --plan", "inbox --plan=", "inbox --plan p2 extra", "inbox p2", "answer --plan", "answer --plan p2 q1"]) {
      expect(parsePlanCommand(args).kind, args).toBe("help");
    }
  });

  it("QA-4.1-11: an unterminated quote prints the help instead of running to the end of the input", () => {
    const args = "run C:\\Users\\O'Brien\\p.md --phases 1.1";
    const parsed = parsePlanCommand(args);
    expect(parsed).toEqual({ kind: "help", reason: expect.stringContaining("unterminated quote") });
    const text = command.execute(args);
    expect(text).toContain("unterminated quote");
    expect(text).toContain(buildPlanHelp());
    expect(text).not.toContain("```json");
    for (const bad of ['status "p1', "pause 'p1", 'answer "q1 yes', "answer --plan 'p2 q1 yes", 'run "D:\\x.md']) {
      expect(parsePlanCommand(bad), bad).toEqual({ kind: "help", reason: expect.stringContaining("unterminated quote") });
    }
    // Wrapped in the other quote, the same path works.
    expect(callOf("run \"C:\\Users\\O'Brien\\p.md\" --phases 1.1")).toEqual({
      action: "compile",
      path: "C:\\Users\\O'Brien\\p.md",
      phases: ["1.1"],
    });
    // The answer text alone is taken as typed, apostrophes included.
    expect(callOf("answer q1 don't do it")).toEqual({ action: "answer", inboxId: "q1", text: "don't do it" });
    expect(callOf("answer q1 'it is")).toEqual({ action: "answer", inboxId: "q1", text: "'it is" });
  });

  it("QA-4.1-15: --phases takes comma-separated ids only", () => {
    expect(callOf("run p.md --phases 1.1,1.2")).toEqual({ action: "compile", path: "p.md", phases: ["1.1", "1.2"] });
    expect(callOf('run p.md --phases "1.1, 1.2"')).toEqual({ action: "compile", path: "p.md", phases: ["1.1", "1.2"] });
    for (const args of ["run p.md --phases 1.1 1.2", 'run p.md --phases "1.1 1.2"', "run --phases 1.1 1.2 p.md"]) {
      const parsed = parsePlanCommand(args);
      expect(parsed, args).toEqual({ kind: "help", reason: expect.stringContaining("comma-separated phase ids") });
    }
  });

  it("is case-insensitive on the subcommand and tolerant of extra whitespace", () => {
    expect(callOf("  STATUS   plan-1  ")).toEqual({ action: "status", planId: "plan-1" });
  });

  it("keeps the answer text as typed, unwrapping a single quoted text", () => {
    expect(callOf('answer q1 use "a  b" here')).toEqual({ action: "answer", inboxId: "q1", text: 'use "a  b" here' });
    expect(callOf('answer q1 "only this"')).toEqual({ action: "answer", inboxId: "q1", text: "only this" });
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
    for (const args of [
      "run p.md", "approve p1", "status", "status p1", "inbox", "inbox --plan p1", "answer q1 ok", "answer --plan p1 q1 ok",
      "pause p1", "resume p1", "abort p1", "land p1", "adopt p1",
    ]) {
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
      "approve",
      "run a.md --phases 1.1 1.2",
      "run C:\\Users\\O'Brien\\p.md --phases 1.1",
    ]) {
      const parsed = parsePlanCommand(args);
      expect(parsed.kind, args).toBe("help");
      const text = command.execute(args);
      expect(text, args).toContain(buildPlanHelp());
      expect(text, args).not.toContain("```json");
    }
  });
});

/**
 * A runtime double that records the calls and answers like a running plan p1 with one open inbox item q1. `args` keeps
 * the arguments of compile (its input), status (the plan id) and answer (the plan id).
 */
function recordingRuntime(): { rt: ExecutorRuntime; calls: string[]; args: unknown[] } {
  const calls: string[] = [];
  const args: unknown[] = [];
  const summary: CompileSummary = {
    tasks: 1, phases: 1, edges: 0, workMs: 60_000, criticalPathMs: 60_000, width: 1, expectedMakespanMs: 60_000, manual: [], warnings: [],
  };
  const rec = async (name: string): Promise<void> => {
    calls.push(name);
  };
  const rt: ExecutorRuntime = {
    async compile(input) {
      calls.push("compile");
      args.push(input);
      return { planId: "p1", summary, residuePrompt: null };
    },
    async residue() {
      calls.push("residue");
      return summary;
    },
    approve: () => rec("approve"),
    async status(planId) {
      calls.push("status");
      args.push(planId);
      const id = planId ?? "p1";
      return `Plan ${id} [running] p.md\nTasks: ready 1\nReady:\n  1.1.1\nInbox:\n  q1 question/blocking: which option?\nMetrics: launches 0, wakes 0, idle-with-ready 0 ms`;
    },
    async ready() {
      calls.push("ready");
      return { launchable: [], manual: [] };
    },
    async addTasks() {
      calls.push("addTasks");
      return { added: [], reopened: [] };
    },
    answer: (planId) => {
      args.push(planId);
      return rec("answer");
    },
    done: () => rec("done"),
    pause: () => rec("pause"),
    resume: () => rec("resume"),
    abort: () => rec("abort"),
    land: () => rec("land"),
    adopt: () => rec("adopt"),
    async gc() {
      calls.push("gc");
      return { removed: [], reported: [] };
    },
    async exportPlan() {
      calls.push("exportPlan");
      return "{}";
    },
    purge: () => rec("purge"),
    onRouterToolCall() {},
    onHostEvent() {},
    onRetryHook() {
      return { stop: false };
    },
    async onChildEnd() {},
    planLine() {
      return "plan p1: 0/1 done, 0 running, 1 ready";
    },
    async start() {},
    async dispose() {},
  };
  return { rt, calls, args };
}

/** The tool context of the orchestrator: a session and an absolute project directory (relative plan paths resolve there). */
const CTX = { sessionID: "ses_orchestrator", directory: process.cwd() };

describe("/plan argument blocks pass router_plan validation", () => {
  // Each subcommand line and the runtime method the resulting router_plan call reaches last.
  const CASES: Array<[string, string]> = [
    ["run p.md", "compile"],
    ['run "D:\\My Plans\\p.md" --phases 1.1,1.2 --done-before 2.1', "compile"],
    ["approve p1", "approve"],
    ["status", "status"],
    ["status p1", "status"],
    ["inbox", "status"],
    ["inbox --plan p2", "status"],
    ["answer q1 yes, go ahead", "answer"],
    ['answer q1 "only this"', "answer"],
    ["answer --plan p2 q1 yes", "answer"],
    ["pause p1", "pause"],
    ["resume p1", "resume"],
    ["abort p1", "abort"],
    ["land p1", "land"],
    ["adopt p1", "adopt"],
  ];

  it("covers every subcommand", () => {
    expect(new Set(CASES.map(([args]) => args.split(" ")[0]))).toEqual(
      new Set(["run", "approve", "status", "inbox", "answer", "pause", "resume", "abort", "land", "adopt"]),
    );
    // Every subcommand of the help is covered here.
    const helpSubs = PLAN_HELP_LINES.flatMap((l) => /^- `\/plan ([a-z|]+)/.exec(l)?.[1]?.split("|") ?? []);
    expect(new Set(CASES.map(([args]) => args.split(" ")[0]))).toEqual(new Set(helpSubs));
  });

  for (const [args, method] of CASES) {
    it(`/plan ${args}`, async () => {
      const { rt, calls } = recordingRuntime();
      const out = await executeRouterPlan(rt, jsonOf(command.execute(args)), CTX);
      expect(out.startsWith("[router_plan]"), out).toBe(false);
      expect(calls[calls.length - 1]).toBe(method);
    });
  }

  it("/plan inbox renders only the inbox section, with the /plan answer form for the user", async () => {
    const { rt } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("inbox")), CTX);
    expect(out).toContain("q1 question/blocking: which option?");
    expect(out).toContain("Answer: /plan answer <id> <text>");
    expect(out).toContain("router_plan action=answer planId=p1 inboxId=<id>");
    expect(out).not.toContain("Metrics:");
  });

  it("/plan inbox --plan <other> shows that plan and names --plan in the answer form", async () => {
    const { rt, args } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("inbox --plan p2")), CTX);
    expect(args).toEqual(["p2"]);
    expect(out.split("\n")[0]).toBe("Plan p2 [running] p.md");
    expect(out).toContain("Answer: /plan answer --plan p2 <id> <text>");
  });

  it("QA-4.1-6: /plan run with a relative path compiles the path resolved against the project directory", async () => {
    const { rt, args } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("run docs/plans/p.md")), CTX);
    expect(out.startsWith("[router_plan]"), out).toBe(false);
    expect(args).toEqual([expect.objectContaining({ path: resolve(process.cwd(), "docs/plans/p.md") })]);
  });

  it("QA-4.1-1: /plan run with approve ask never tells the model to approve on its own", async () => {
    const { rt, calls } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("run p.md")), CTX, { approve: () => "ask" });
    expect(calls).toEqual(["compile"]);
    expect(out).toContain("Show this summary to the user.");
    expect(out).toContain("Call router_plan action=approve only after the user explicitly approves in this conversation");
    expect(out).not.toMatch(/Review it, then call/);
  });

  it("/plan answer reaches the running plan of the calling session (planLine, not the oldest board)", async () => {
    const { rt, calls, args } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("answer q1 yes, go ahead")), CTX);
    expect(out).toBe("plan p1: inbox q1 answered.");
    expect(calls).toEqual(["answer"]);
    expect(args).toEqual(["p1"]);
  });

  it("/plan answer --plan <id> reaches that plan", async () => {
    const { rt, calls, args } = recordingRuntime();
    const out = await executeRouterPlan(rt, jsonOf(command.execute("answer --plan p2 q1 yes")), CTX);
    expect(out).toBe("plan p2: inbox q1 answered.");
    expect(calls).toEqual(["answer"]);
    expect(args).toEqual(["p2"]);
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

  it("QA-4.1-1, -5, -6, -15: the /plan help says compile-only, approve, --plan, the path rule and the adopt case", () => {
    const help = PLAN_HELP_LINES.join("\n");
    expect(help).not.toMatch(/start executing it/);
    expect(help).toContain("it does not start until approved");
    expect(help).toContain("- `/plan approve <planId>` — approve a compiled plan and start it");
    expect(help).toContain("absolute, or relative to the project directory");
    expect(help).toContain("[--phases <id,id,...>]");
    expect(help).toContain("- `/plan inbox [--plan <planId>]`");
    expect(help).toContain("- `/plan answer [--plan <planId>] <id> <text>`");
    expect(help).toContain("adopt a plan whose owning session is gone");
    expect(help).not.toMatch(/started elsewhere/);
  });
});
