// Tests for src/executor/tool.ts (plan task 4.1.2 and its part of 4.1.5): the `router_plan` tool.
// The runtime is a typed, stateful double that enforces what the real runtime enforces at its boundary (E_NOT_OWNER,
// E_PLAN_STATE, E_LEDGER_NOT_FOUND, E_INVALID_INPUT, E_CYCLE), so the tool is exercised end to end: validation,
// ownership refusal mapped to text, and the compile -> residue -> approve round trip. Nothing here touches disk or time.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROUTER_PLAN_ACTIONS,
  askApprovalText,
  boardPlanId,
  createRouterPlanTool,
  executeRouterPlan,
  planLinePlanId,
  resolvePlanPath,
  type RouterPlanAction,
  type RouterPlanToolOptions,
} from "../../src/executor/tool.js";
import {
  ExecutorError,
  type CompileSummary,
  type ExecutorRuntime,
  type HostSessionEvent,
  type PlanId,
  type TaskId,
} from "../../src/executor/types.js";

const OWNER = "ses_owner";
const OTHER = "ses_other";
const PLAN_FILE = "D:\\work\\plans\\fixture.md";
const RESIDUE_FILE = "D:\\work\\plans\\residue-fixture.md";
const KNOWN_PHASES = ["1.1", "1.2", "2.1"];

type PlanStatus = "awaiting-residue" | "awaiting-approval" | "running" | "paused" | "completed" | "aborted";
type FakeTaskState = "pending" | "ready" | "running" | "done";

interface FakeTask {
  state: FakeTaskState;
  kind: "auto" | "manual" | "preflight";
  deps: string[];
}

interface FakePlan {
  id: PlanId;
  owner: string;
  status: PlanStatus;
  tasks: Map<TaskId, FakeTask>;
  inbox: Map<string, { open: boolean; answer: string | null }>;
  slots: string[];
  journal: string[];
}

function summaryOf(tasks: number, manual: TaskId[] = []): CompileSummary {
  return {
    tasks, phases: 2, edges: 1, workMs: 7_200_000, criticalPathMs: 3_600_000, width: 2,
    expectedMakespanMs: 4_500_000, manual, warnings: [],
  };
}

/** Stateful `ExecutorRuntime` double. `calls` records every public method entered; `throwOn` injects a failure per method. */
class FakeRuntime implements ExecutorRuntime {
  readonly plans = new Map<PlanId, FakePlan>();
  readonly calls: string[] = [];
  readonly throwOn = new Map<string, unknown>();
  readonly deletedRefs: string[] = [];
  readonly liveSessions = new Set<string>([OWNER, OTHER]);
  lastCompile: { path: string; phases?: string[]; doneBefore?: string; sessionID: string } | null = null;
  statusText: string | null = null;
  private seq = 0;

  seed(id: PlanId, owner: string, status: PlanStatus, tasks: Record<TaskId, Partial<FakeTask>> = {}): FakePlan {
    const plan: FakePlan = {
      id, owner, status, tasks: new Map(), inbox: new Map(), slots: [`slot-${id}-a`], journal: [`plan-created ${id}`],
    };
    for (const [tid, t] of Object.entries(tasks)) plan.tasks.set(tid, { state: "pending", kind: "auto", deps: [], ...t });
    this.plans.set(id, plan);
    return plan;
  }

  private enter(name: string): void {
    this.calls.push(name);
    if (this.throwOn.has(name)) throw this.throwOn.get(name);
  }

  private plan(id: PlanId): FakePlan {
    const p = this.plans.get(id);
    if (p === undefined) throw new ExecutorError("E_LEDGER_NOT_FOUND", `no ledger for plan ${id}`);
    return p;
  }

  private owned(id: PlanId, sessionID: string): FakePlan {
    const p = this.plan(id);
    if (p.owner !== sessionID && this.liveSessions.has(p.owner)) {
      throw new ExecutorError("E_NOT_OWNER", `plan ${id} is orchestrated by session ${p.owner}`);
    }
    return p;
  }

  private expect(p: FakePlan, ...allowed: PlanStatus[]): void {
    if (!allowed.includes(p.status)) {
      throw new ExecutorError("E_PLAN_STATE", `plan ${p.id} is ${p.status}; needs ${allowed.join(" or ")}`);
    }
  }

  async compile(i: { path: string; phases?: string[]; doneBefore?: string; sessionID: string }) {
    this.enter("compile");
    this.lastCompile = i;
    if (!i.path.endsWith(".md")) throw new ExecutorError("E_COMPILE", `line 1: ${i.path} is not a plan file`);
    for (const id of [...(i.phases ?? []), ...(i.doneBefore !== undefined ? [i.doneBefore] : [])]) {
      if (!KNOWN_PHASES.includes(id)) throw new ExecutorError("E_INVALID_INPUT", `unknown phase ${id}`);
    }
    const planId = `plan-${++this.seq}`;
    const residue = i.path.includes("residue");
    const p = this.seed(planId, i.sessionID, residue ? "awaiting-residue" : "awaiting-approval", { "1.1.1": {}, "1.1.2": { kind: "manual" } });
    p.slots = [];
    const tasks = i.phases !== undefined ? i.phases.length * 2 : 4;
    return { planId, summary: summaryOf(tasks, ["1.1.2"]), residuePrompt: residue ? "ARCHITECT PROMPT: emit the residue JSON" : null };
  }

  async residue(planId: PlanId, text: string, sessionID: string) {
    this.enter("residue");
    const p = this.owned(planId, sessionID);
    this.expect(p, "awaiting-residue");
    try {
      JSON.parse(text);
    } catch {
      throw new ExecutorError("E_RESIDUE", "response is not valid JSON");
    }
    p.status = "awaiting-approval";
    return summaryOf(5);
  }

  async approve(planId: PlanId, sessionID: string) {
    this.enter("approve");
    const p = this.owned(planId, sessionID);
    this.expect(p, "awaiting-approval");
    p.status = "running";
  }

  async status(planId: PlanId | null, sessionID: string) {
    this.enter("status");
    if (this.statusText !== null) return this.statusText;
    const p = planId === null
      ? [...this.plans.values()].find(x => x.owner === sessionID)
      : this.plan(planId);
    if (p === undefined) throw new ExecutorError("E_LEDGER_NOT_FOUND", "no plan for this session");
    // The shape of runtime.ts renderBoard: head line, indented Ready entries, an `Inbox:` section, `Metrics:` last.
    const lines = [`Plan ${p.id} [${p.status}] ${PLAN_FILE}`, `Tasks: ${p.tasks.size}`, "Ready:"];
    for (const [id, t] of p.tasks) if (t.state === "ready") lines.push(`  ${id}${t.kind === "auto" ? "" : ` manual (${t.kind})`}`);
    for (const [id, t] of p.tasks) if (t.state === "running") lines.push(`Running: ${id} attempt 1`);
    const open = [...p.inbox].filter(([, i]) => i.open);
    if (open.length > 0) {
      lines.push("Inbox:");
      for (const [id] of open) lines.push(`  ${id} question/blocking: pick an option`);
    }
    lines.push("Metrics: launches 0, wakes 0, idle-with-ready 0 ms");
    return lines.join("\n");
  }

  async ready(planId: PlanId) {
    this.enter("ready");
    const p = this.plan(planId);
    const ready = [...p.tasks].filter(([, t]) => t.state === "ready");
    return {
      launchable: ready.filter(([, t]) => t.kind === "auto").map(([id]) => id),
      manual: ready.filter(([, t]) => t.kind !== "auto").map(([id]) => id),
    };
  }

  async addTasks(planId: PlanId, text: string, sessionID: string) {
    this.enter("addTasks");
    const p = this.owned(planId, sessionID);
    this.expect(p, "running", "paused");
    let doc: { tasks?: Array<{ id: string; deps?: string[]; writes?: string[] }>; edges?: Array<{ from: string; to: string }> };
    try {
      doc = JSON.parse(text) as typeof doc;
    } catch {
      throw new ExecutorError("E_INVALID_INPUT", "add-tasks text is not valid JSON");
    }
    const deps = new Map<string, string[]>([...p.tasks].map(([id, t]) => [id, [...t.deps]]));
    const added: TaskId[] = [];
    for (const n of doc.tasks ?? []) {
      if (deps.has(n.id)) throw new ExecutorError("E_INVALID_INPUT", `duplicate task id ${n.id}`);
      for (const w of n.writes ?? []) {
        if (/^([A-Za-z]:|[\\/])/.test(w) || w.split(/[\\/]/).includes("..")) {
          throw new ExecutorError("E_INVALID_INPUT", `write path outside the repository: ${w}`);
        }
      }
      deps.set(n.id, [...(n.deps ?? [])]);
      added.push(n.id);
    }
    const reopened: TaskId[] = [];
    for (const e of doc.edges ?? []) {
      if (!deps.has(e.from) || !deps.has(e.to)) throw new ExecutorError("E_INVALID_INPUT", `unknown task in edge ${e.from} -> ${e.to}`);
      deps.get(e.to)?.push(e.from);
      const t = p.tasks.get(e.to);
      const src = p.tasks.get(e.from);
      if (t !== undefined && t.state === "ready" && (src === undefined || src.state !== "done") && !reopened.includes(e.to)) reopened.push(e.to);
    }
    for (const [id, ds] of deps) {
      for (const d of ds) if (!deps.has(d)) throw new ExecutorError("E_INVALID_INPUT", `unknown dependency ${d} of ${id}`);
    }
    const cycle = findCycle(deps);
    if (cycle !== null) throw new ExecutorError("E_CYCLE", `dependency cycle: ${cycle.join(" -> ")}`);
    for (const id of added) p.tasks.set(id, { state: "pending", kind: "auto", deps: deps.get(id) ?? [] });
    for (const id of reopened) {
      const t = p.tasks.get(id);
      if (t !== undefined) t.state = "pending";
    }
    for (const [id, ds] of deps) {
      const t = p.tasks.get(id);
      if (t !== undefined) t.deps = ds;
    }
    p.journal.push(`tasks-added ${added.join(",")}`);
    return { added, reopened };
  }

  async answer(planId: PlanId, inboxId: string, text: string, sessionID: string) {
    this.enter("answer");
    const p = this.owned(planId, sessionID);
    const item = p.inbox.get(inboxId);
    if (item === undefined || !item.open) throw new ExecutorError("E_INVALID_INPUT", `inbox item ${inboxId} is not open`);
    item.open = false;
    item.answer = text;
  }

  async done(planId: PlanId, taskId: TaskId, sessionID: string) {
    this.enter("done");
    const p = this.owned(planId, sessionID);
    const t = p.tasks.get(taskId);
    if (t === undefined) throw new ExecutorError("E_INVALID_INPUT", `unknown task ${taskId}`);
    if (t.kind === "auto" || t.state !== "ready") {
      throw new ExecutorError("E_INVALID_INPUT", `task ${taskId} is ${t.kind} in ${t.state}; only a manual or preflight task in ready can be reported done`);
    }
    t.state = "done";
  }

  async pause(planId: PlanId, sessionID: string) {
    this.enter("pause");
    const p = this.owned(planId, sessionID);
    this.expect(p, "running");
    p.status = "paused";
  }

  async resume(planId: PlanId, sessionID: string) {
    this.enter("resume");
    const p = this.owned(planId, sessionID);
    this.expect(p, "paused");
    p.status = "running";
  }

  async abort(planId: PlanId, sessionID: string) {
    this.enter("abort");
    const p = this.owned(planId, sessionID);
    this.expect(p, "awaiting-residue", "awaiting-approval", "running", "paused");
    p.status = "aborted";
  }

  async land(planId: PlanId, sessionID: string) {
    this.enter("land");
    const p = this.owned(planId, sessionID);
    this.expect(p, "running");
    p.status = "completed";
  }

  async adopt(planId: PlanId, sessionID: string) {
    this.enter("adopt");
    const p = this.plan(planId);
    if (p.owner !== sessionID && this.liveSessions.has(p.owner)) throw new ExecutorError("E_LOCK_HELD", `plan ${planId} is locked by a live session`);
    this.expect(p, "running", "paused");
    p.owner = sessionID;
  }

  async gc() {
    this.enter("gc");
    const removed: string[] = [];
    for (const p of this.plans.values()) {
      if (p.status !== "completed" && p.status !== "aborted") continue;
      removed.push(...p.slots);
      p.slots = [];
    }
    return { removed, reported: [] as string[] };
  }

  async exportPlan(planId: PlanId) {
    this.enter("exportPlan");
    const p = this.plan(planId);
    return JSON.stringify({ snapshot: { planId: p.id, status: p.status, tasks: Object.fromEntries(p.tasks) }, journal: p.journal });
  }

  async purge(planId: PlanId, sessionID: string) {
    this.enter("purge");
    const p = this.owned(planId, sessionID);
    this.expect(p, "completed", "aborted");
    p.slots = [];
    this.deletedRefs.push(`omr/${planId}/`);
    this.plans.delete(planId);
  }

  onRouterToolCall(): void {}
  onHostEvent(_e: HostSessionEvent): void {}
  onRetryHook(): { stop: boolean } {
    return { stop: false };
  }
  async onChildEnd(): Promise<void> {}
  /** The shape of runtime.ts planLine: the session's first running or paused plan, finished ones skipped. */
  planLine(sessionID: string): string | null {
    this.calls.push("planLine");
    if (this.throwOn.has("planLine")) throw this.throwOn.get("planLine");
    for (const p of this.plans.values()) {
      if (p.owner !== sessionID || (p.status !== "running" && p.status !== "paused")) continue;
      const done = [...p.tasks.values()].filter(t => t.state === "done").length;
      const running = [...p.tasks.values()].filter(t => t.state === "running").length;
      const ready = [...p.tasks.values()].filter(t => t.state === "ready").length;
      return `plan ${p.id}: ${done}/${p.tasks.size} done, ${running} running, ${ready} ready${p.status === "paused" ? ", paused" : ""}`;
    }
    return null;
  }
  async start(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function findCycle(deps: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c !== null) return c;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c !== null) return c;
  }
  return null;
}

/** `sessionID === null` calls without a session in the tool context. */
function call(rt: ExecutorRuntime, args: unknown, sessionID: string | null = OWNER, opts?: RouterPlanToolOptions): Promise<string> {
  return executeRouterPlan(rt, args, sessionID === null ? {} : { sessionID }, opts);
}

/** One valid call per action, with the plan state it needs, and a fragment its answer must contain. */
interface ValidCase {
  action: RouterPlanAction;
  args: Record<string, unknown>;
  seedStatus: PlanStatus;
  expectText: string;
  after(rt: FakeRuntime): void;
}

function seedFor(rt: FakeRuntime, status: PlanStatus): void {
  const p = rt.seed("p1", OWNER, status, {
    T1: { state: "ready" },
    M1: { state: "ready", kind: "manual" },
    T2: { state: "pending", deps: ["T1"] },
  });
  p.inbox.set("Q-1", { open: true, answer: null });
}

const VALID: ValidCase[] = [
  { action: "compile", args: { path: PLAN_FILE }, seedStatus: "running", expectText: "plan plan-1: 4 tasks", after: rt => expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval") },
  { action: "residue", args: { planId: "p1", text: "{\"tasks\":[]}" }, seedStatus: "awaiting-residue", expectText: "residue merged", after: rt => expect(rt.plans.get("p1")?.status).toBe("awaiting-approval") },
  { action: "approve", args: { planId: "p1" }, seedStatus: "awaiting-approval", expectText: "approved and running", after: rt => expect(rt.plans.get("p1")?.status).toBe("running") },
  { action: "status", args: { planId: "p1" }, seedStatus: "running", expectText: "Metrics:", after: () => {} },
  { action: "status", args: {}, seedStatus: "running", expectText: "Plan p1 [running]", after: () => {} },
  { action: "ready", args: { planId: "p1" }, seedStatus: "running", expectText: "launchable 1 (T1); manual 1 (M1)", after: () => {} },
  { action: "add-tasks", args: { planId: "p1", text: "{\"tasks\":[{\"id\":\"N1\",\"writes\":[\"src/a.ts\"]}]}" }, seedStatus: "running", expectText: "added 1 (N1)", after: rt => expect(rt.plans.get("p1")?.tasks.has("N1")).toBe(true) },
  { action: "answer", args: { planId: "p1", inboxId: "Q-1", text: "use option b" }, seedStatus: "running", expectText: "inbox Q-1 answered", after: rt => expect(rt.plans.get("p1")?.inbox.get("Q-1")?.answer).toBe("use option b") },
  { action: "done", args: { planId: "p1", task: "M1" }, seedStatus: "running", expectText: "task M1 marked done", after: rt => expect(rt.plans.get("p1")?.tasks.get("M1")?.state).toBe("done") },
  { action: "pause", args: { planId: "p1" }, seedStatus: "running", expectText: "paused", after: rt => expect(rt.plans.get("p1")?.status).toBe("paused") },
  { action: "resume", args: { planId: "p1" }, seedStatus: "paused", expectText: "resumed", after: rt => expect(rt.plans.get("p1")?.status).toBe("running") },
  { action: "abort", args: { planId: "p1" }, seedStatus: "running", expectText: "aborted", after: rt => expect(rt.plans.get("p1")?.status).toBe("aborted") },
  { action: "land", args: { planId: "p1" }, seedStatus: "running", expectText: "landing requested", after: rt => expect(rt.plans.get("p1")?.status).toBe("completed") },
  { action: "adopt", args: { planId: "p1" }, seedStatus: "running", expectText: "adopted by this session", after: () => {} },
  { action: "gc", args: {}, seedStatus: "aborted", expectText: "removed 1 (slot-p1-a)", after: rt => expect(rt.plans.get("p1")?.slots).toEqual([]) },
  { action: "export", args: { planId: "p1" }, seedStatus: "running", expectText: "\"snapshot\"", after: () => {} },
  { action: "purge", args: { planId: "p1" }, seedStatus: "completed", expectText: "purged", after: rt => { expect(rt.plans.has("p1")).toBe(false); expect(rt.deletedRefs).toEqual(["omr/p1/"]); } },
];

/** Actions that take a planId and are owner-checked by the runtime (status, ready and export are read-only). */
const OWNER_CHECKED: RouterPlanAction[] = ["residue", "approve", "add-tasks", "answer", "done", "pause", "resume", "abort", "land", "purge"];

function validFor(action: RouterPlanAction): ValidCase {
  const c = VALID.find(v => v.action === action);
  if (c === undefined) throw new Error(`no valid case for ${action}`);
  return c;
}

describe("router_plan: every action with valid input", () => {
  for (const c of VALID) {
    it(`${c.action} ${JSON.stringify(c.args).slice(0, 40)}`, async () => {
      const rt = new FakeRuntime();
      seedFor(rt, c.seedStatus);
      const out = await call(rt, { action: c.action, ...c.args });
      expect(out).toContain(c.expectText);
      expect(out).not.toContain("[router_plan]");
      c.after(rt);
    });
  }

  it("covers every action of the schema", () => {
    expect(new Set(VALID.map(v => v.action))).toEqual(new Set(ROUTER_PLAN_ACTIONS));
  });

  it("compile returns the summary and the next step", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: PLAN_FILE });
    expect(out).toContain("plan plan-1: 4 tasks, 2 phases, 1 edges; work 2h00m, critical path 1h00m, width 2, expected makespan 1h15m.");
    expect(out).toContain("manual tasks (1): 1.1.2");
    expect(out).toContain("Call action=approve only when the user approves plan plan-1 after seeing this summary, or types /plan approve plan-1.");
    expect(rt.lastCompile).toEqual({ path: PLAN_FILE, sessionID: OWNER });
  });

  it("compile passes phases and doneBefore through and omits absent ones", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: PLAN_FILE, phases: ["1.1", " 1.2 "], doneBefore: "2.1" });
    expect(out).toContain("plan plan-1: 4 tasks");
    expect(rt.lastCompile).toEqual({ path: PLAN_FILE, phases: ["1.1", "1.2"], doneBefore: "2.1", sessionID: OWNER });
    const bad = await call(rt, { action: "compile", path: PLAN_FILE, phases: ["9.9"] });
    expect(bad).toContain("compile refused (E_INVALID_INPUT)");
    expect(bad).toContain("unknown phase 9.9");
    const bad2 = await call(rt, { action: "compile", path: PLAN_FILE, doneBefore: "9.9" });
    expect(bad2).toContain("E_INVALID_INPUT");
  });

  it("compile of a plan with residue returns the dispatch prompt and how to continue", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: RESIDUE_FILE });
    expect(out).toContain("status: awaiting-residue");
    expect(out).toContain("router_plan action=residue planId=plan-1");
    expect(out).toContain("ARCHITECT PROMPT: emit the residue JSON");
    expect(out).not.toContain("action=approve");
  });

  it("compile errors from the plan file come back as text", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: "D:\\work\\notes.txt" });
    expect(out).toContain("compile refused (E_COMPILE)");
    expect(out).toContain("Fix the plan file");
  });
});

describe("router_plan: round trip compile -> residue -> approve", () => {
  it("walks a residue plan to running", async () => {
    const rt = new FakeRuntime();
    const compiled = await call(rt, { action: "compile", path: RESIDUE_FILE });
    const planId = /planId=(\S+)/.exec(compiled)?.[1];
    expect(planId).toBe("plan-1");

    // approve before the residue is merged is refused with the state
    const early = await call(rt, { action: "approve", planId });
    expect(early).toContain("approve refused (E_PLAN_STATE)");
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-residue");

    // malformed residue is refused and leaves the plan where it was
    const garbled = await call(rt, { action: "residue", planId, text: "not json" });
    expect(garbled).toContain("E_RESIDUE");
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-residue");

    const merged = await call(rt, { action: "residue", planId, text: "{\"edges\":[]}" });
    expect(merged).toContain("residue merged");
    expect(merged).toContain(askApprovalText("plan-1"));
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");

    const approved = await call(rt, { action: "approve", planId });
    expect(approved).toContain("approved and running");
    expect(rt.plans.get("plan-1")?.status).toBe("running");

    const board = await call(rt, { action: "status" });
    expect(board).toContain("Plan plan-1 [running]");
    expect(board).toContain("Metrics:");
  });

  it("walks a plain plan: compile -> approve", async () => {
    const rt = new FakeRuntime();
    await call(rt, { action: "compile", path: PLAN_FILE });
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");
    expect(await call(rt, { action: "approve", planId: "plan-1" })).toContain("approved and running");
    expect(rt.plans.get("plan-1")?.status).toBe("running");
  });
});

describe("router_plan: approve: auto skips the stop", () => {
  const auto: RouterPlanToolOptions = { approve: () => "auto" };

  it("compile approves at once", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: PLAN_FILE }, OWNER, auto);
    expect(out).toContain("approved and running (approve: auto)");
    expect(out).not.toContain("awaiting-approval");
    expect(rt.plans.get("plan-1")?.status).toBe("running");
    expect(rt.calls).toEqual(["compile", "approve"]);
  });

  it("a residue plan still waits for the residue, then approves at once", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: RESIDUE_FILE }, OWNER, auto);
    expect(out).toContain("status: awaiting-residue");
    expect(rt.calls).toEqual(["compile"]);
    const merged = await call(rt, { action: "residue", planId: "plan-1", text: "{}" }, OWNER, auto);
    expect(merged).toContain("approved and running (approve: auto)");
    expect(rt.plans.get("plan-1")?.status).toBe("running");
  });

  it("ask (and no option) stops for the user: the model is never told to approve on its own (QA-4.1-1)", async () => {
    for (const opts of [undefined, { approve: () => "ask" as const }, {}]) {
      const rt = new FakeRuntime();
      const out = await call(rt, { action: "compile", path: PLAN_FILE }, OWNER, opts);
      // QA-4.1-16: the exact stop text; the user's request to compile or run the plan is not approval.
      const last = out.split("\n").pop() ?? "";
      expect(last).toBe(
        "status: awaiting-approval. Stop here. This plan is not approved. A request to compile or run it is not approval. " +
          "Call action=approve only when the user approves plan plan-1 after seeing this summary, or types /plan approve plan-1.",
      );
      expect(askApprovalText("plan-1")).toBe(last);
      expect(out).not.toMatch(/Review it, then call|in this conversation|Show this summary to the user\. Call/);
      expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");
      expect(rt.calls).toEqual(["compile"]);
    }
  });

  it("ask after a merged residue asks the user too (QA-4.1-1)", async () => {
    const rt = new FakeRuntime();
    await call(rt, { action: "compile", path: RESIDUE_FILE }, OWNER, { approve: () => "ask" });
    const merged = await call(rt, { action: "residue", planId: "plan-1", text: "{}" }, OWNER, { approve: () => "ask" });
    expect(merged).toContain(`residue merged. ${askApprovalText("plan-1")}`);
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");
    expect(rt.calls).toEqual(["compile", "residue"]);
  });

  it("a failing automatic approve is reported and the plan stays awaiting-approval", async () => {
    const rt = new FakeRuntime();
    rt.throwOn.set("approve", new ExecutorError("E_PLAN_STATE", "plan is locked"));
    const out = await call(rt, { action: "compile", path: PLAN_FILE }, OWNER, auto);
    expect(out).toContain("plan plan-1: 4 tasks");
    expect(out).toContain("auto-approve refused (E_PLAN_STATE)");
    expect(out).toContain("router_plan action=approve planId=plan-1");
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");
  });

  it("a throwing option getter does not escape", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: PLAN_FILE }, OWNER, { approve: () => { throw new Error("config gone"); } });
    expect(out).toContain("failed: config gone");
  });

  it("QA-4.1-10: the getter is read only by compile and residue; a throwing one breaks no other action", async () => {
    let reads = 0;
    const throwing: RouterPlanToolOptions = {
      approve: () => {
        reads++;
        throw new Error("config gone");
      },
    };
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    expect(await call(rt, { action: "status" }, OWNER, throwing)).toContain("Plan p1 [running]");
    expect(await call(rt, { action: "status", inbox: true }, OWNER, throwing)).toContain("Q-1");
    expect(await call(rt, { action: "answer", inboxId: "Q-1", text: "b" }, OWNER, throwing)).toBe("plan p1: inbox Q-1 answered.");
    expect(await call(rt, { action: "ready", planId: "p1" }, OWNER, throwing)).toContain("launchable 1");
    expect(await call(rt, { action: "pause", planId: "p1" }, OWNER, throwing)).toContain("paused");
    expect(await call(rt, { action: "resume", planId: "p1" }, OWNER, throwing)).toContain("resumed");
    expect(await call(rt, { action: "abort", planId: "p1" }, OWNER, throwing)).toContain("aborted");
    expect(await call(rt, { action: "gc" }, OWNER, throwing)).toContain("gc: removed");
    expect(reads).toBe(0);
    // compile and residue read it (and report the failure as text).
    expect(await call(rt, { action: "compile", path: PLAN_FILE }, OWNER, throwing)).toContain("action=compile failed: config gone");
    expect(await call(rt, { action: "residue", planId: "p1", text: "{}" }, OWNER, throwing)).toContain("action=residue failed: config gone");
    expect(reads).toBe(2);
  });
});

describe("router_plan: a relative compile path (QA-4.1-6)", () => {
  it("is resolved against the project directory of the tool context", async () => {
    const rt = new FakeRuntime();
    const out = await executeRouterPlan(rt, { action: "compile", path: "docs\\plans\\fixture.md" }, { sessionID: OWNER, directory: "D:\\work" });
    expect(out).toContain("plan plan-1: 4 tasks");
    expect(rt.lastCompile?.path).toBe("D:\\work\\docs\\plans\\fixture.md");
    await executeRouterPlan(rt, { action: "compile", path: "./plans/../plans/fixture.md" }, { sessionID: OWNER, directory: "D:/work" });
    expect(rt.lastCompile?.path).toBe("D:\\work\\plans\\fixture.md");
    await executeRouterPlan(rt, { action: "compile", path: "plans/fixture.md" }, { sessionID: OWNER, directory: "/home/u/repo" });
    expect(rt.lastCompile?.path).toBe("/home/u/repo/plans/fixture.md");
  });

  it("falls back to the worktree, and ignores a relative directory", async () => {
    const rt = new FakeRuntime();
    await executeRouterPlan(rt, { action: "compile", path: "fixture.md" }, { sessionID: OWNER, worktree: "D:\\wt" });
    expect(rt.lastCompile?.path).toBe("D:\\wt\\fixture.md");
    await executeRouterPlan(rt, { action: "compile", path: "fixture.md" }, { sessionID: OWNER, directory: "rel\\dir", worktree: "D:\\wt2" });
    expect(rt.lastCompile?.path).toBe("D:\\wt2\\fixture.md");
  });

  it("passes an absolute path through unchanged (drive, UNC, POSIX)", async () => {
    for (const p of [PLAN_FILE, "D:/work/plans/fixture.md", "\\\\server\\share\\fixture.md", "/srv/plans/fixture.md"]) {
      const rt = new FakeRuntime();
      await executeRouterPlan(rt, { action: "compile", path: p }, { sessionID: OWNER, directory: "C:\\elsewhere" });
      expect(rt.lastCompile?.path, p).toBe(p);
    }
    expect(resolvePlanPath(PLAN_FILE, null)).toBe(PLAN_FILE);
  });

  it("is refused before the runtime when no project directory is known", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "compile", path: "plans/fixture.md" });
    expect(out).toContain("action=compile refused");
    expect(out).toContain("relative and the project directory is unknown; pass an absolute path");
    expect(rt.calls).toEqual([]);
    expect(resolvePlanPath("plans/fixture.md", null)).toBeNull();
  });

  it("QA-4.1-20: a drive-relative path (C:foo) is refused, never resolved against a drive's current directory", async () => {
    for (const p of ["C:foo.md", "c:plans\\fixture.md", "D:fixture.md", "C:"]) {
      const rt = new FakeRuntime();
      const out = await executeRouterPlan(rt, { action: "compile", path: p }, { sessionID: OWNER, directory: "D:\\proj" });
      expect(out, p).toContain("action=compile refused");
      expect(out, p).toContain("is relative to a drive's current directory, not to the project; pass an absolute path.");
      expect(rt.calls, p).toEqual([]);
      expect(resolvePlanPath(p, "D:\\proj"), p).toBeNull();
    }
    // A drive path with a separator stays absolute.
    expect(resolvePlanPath("C:\\plans\\fixture.md", "D:\\proj")).toBe("C:\\plans\\fixture.md");
    expect(resolvePlanPath("C:/plans/fixture.md", "D:\\proj")).toBe("C:/plans/fixture.md");
  });
});

describe("router_plan: missing fields", () => {
  const REQUIRED: Array<[RouterPlanAction, string[]]> = [
    ["compile", ["path"]],
    ["residue", ["planId", "text"]],
    ["approve", ["planId"]],
    ["ready", ["planId"]],
    ["add-tasks", ["planId", "text"]],
    ["answer", ["inboxId", "text"]],
    ["done", ["planId", "task"]],
    ["pause", ["planId"]],
    ["resume", ["planId"]],
    ["abort", ["planId"]],
    ["land", ["planId"]],
    ["adopt", ["planId"]],
    ["export", ["planId"]],
    ["purge", ["planId"]],
  ];
  const FULL: Record<string, unknown> = { path: PLAN_FILE, planId: "p1", text: "{}", inboxId: "Q-1", task: "M1" };

  for (const [action, fields] of REQUIRED) {
    for (const field of fields) {
      it(`${action} without ${field}`, async () => {
        const rt = new FakeRuntime();
        seedFor(rt, "running");
        const args: Record<string, unknown> = { action };
        for (const f of fields) if (f !== field) args[f] = FULL[f];
        const out = await call(rt, args);
        expect(out).toContain(`action=${action} needs ${field}`);
        expect(out.startsWith("[router_plan]")).toBe(true);
        expect(rt.calls).toEqual([]);
      });
    }
  }

  it("null counts as missing and empty strings are refused", async () => {
    const rt = new FakeRuntime();
    expect(await call(rt, { action: "pause", planId: null })).toContain("needs planId");
    expect(await call(rt, { action: "pause", planId: "   " })).toContain("planId must not be empty");
    expect(await call(rt, { action: "add-tasks", planId: "p1", text: "  \n" })).toContain("text must not be empty");
    expect(await call(rt, { action: "compile", path: "" })).toContain("path must not be empty");
    expect(rt.calls).toEqual([]);
  });

  it("a missing action is refused", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { planId: "p1" });
    expect(out).toContain("\"action\" is required");
    expect(out).toContain("compile");
    expect(rt.calls).toEqual([]);
  });

  it("a call without a session is refused before the runtime is touched", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "pause", planId: "p1" }, null);
    expect(out).toContain("no calling session");
    expect(await executeRouterPlan(rt, { action: "gc" })).toContain("no calling session");
    expect(await call(rt, { action: "pause", planId: "p1" }, "")).toContain("no calling session");
    expect(rt.calls).toEqual([]);
  });
});

describe("router_plan: wrong types and strictness", () => {
  const BAD: Array<[string, Record<string, unknown>, string]> = [
    ["action number", { action: 3 }, "\"action\" is required and must be a string"],
    ["action unknown", { action: "explode" }, "unknown action \"explode\""],
    ["planId number", { action: "pause", planId: 5 }, "planId must be a string; got number"],
    ["planId object", { action: "pause", planId: {} }, "planId must be a string; got object"],
    ["planId array", { action: "pause", planId: ["p1"] }, "planId must be a string; got array"],
    ["planId path", { action: "pause", planId: "..\\evil" }, "planId must be 1-200 characters"],
    ["planId wildcard", { action: "purge", planId: "omr/*" }, "planId must be 1-200 characters"],
    ["path number", { action: "compile", path: 5 }, "path must be a string; got number"],
    ["phases string", { action: "compile", path: PLAN_FILE, phases: "1.1" }, "phases must be an array of phase id strings; got string"],
    ["phases numbers", { action: "compile", path: PLAN_FILE, phases: [1, 2] }, "phases must be an array of phase id strings"],
    ["phases empty", { action: "compile", path: PLAN_FILE, phases: [] }, "phases must hold 1-200 phase ids"],
    ["phases blank entry", { action: "compile", path: PLAN_FILE, phases: ["1.1", " "] }, "phases must hold 1-200 phase ids"],
    ["doneBefore array", { action: "compile", path: PLAN_FILE, doneBefore: ["1.1"] }, "doneBefore must be a string; got array"],
    ["text number", { action: "residue", planId: "p1", text: 42 }, "text must be a string; got number"],
    ["text object", { action: "add-tasks", planId: "p1", text: { tasks: [] } }, "text must be a string; got object"],
    ["inboxId number", { action: "answer", planId: "p1", inboxId: 1, text: "x" }, "inboxId must be a string; got number"],
    ["task boolean", { action: "done", planId: "p1", task: true }, "task must be a string; got boolean"],
    ["unknown key", { action: "pause", planId: "p1", force: true }, "force unknown for action=pause (it takes: planId)"],
    ["key of another action", { action: "pause", planId: "p1", text: "x" }, "text not used by action=pause"],
    ["compile with planId", { action: "compile", path: PLAN_FILE, planId: "p1" }, "planId not used by action=compile (it takes: path, phases, doneBefore)"],
    ["gc with argument", { action: "gc", planId: "p1" }, "planId not used by action=gc (it takes no arguments)"],
    ["status with text", { action: "status", text: "x" }, "text not used by action=status (it takes: planId, inbox)"],
    ["inbox string", { action: "status", inbox: "yes" }, "inbox must be a boolean; got string"],
    ["inbox on another action", { action: "ready", planId: "p1", inbox: true }, "inbox not used by action=ready (it takes: planId)"],
    ["answer with id instead of inboxId", { action: "answer", id: "Q-1", text: "x" }, "id unknown for action=answer (it takes: inboxId, text, planId)"],
  ];
  for (const [name, args, expected] of BAD) {
    it(name, async () => {
      const rt = new FakeRuntime();
      seedFor(rt, "running");
      const out = await call(rt, args);
      expect(out).toContain(expected);
      expect(out.startsWith("[router_plan]")).toBe(true);
      expect(rt.calls).toEqual([]);
    });
  }

  it("non-object arguments", async () => {
    const rt = new FakeRuntime();
    for (const raw of [null, undefined, "pause", 7, ["pause"]]) {
      const out = await call(rt, raw);
      expect(out).toContain("arguments must be an object with an \"action\"");
    }
    expect(rt.calls).toEqual([]);
  });

  it("oversized text is refused", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "residue", planId: "p1", text: "x".repeat(2_000_001) });
    expect(out).toContain("text is too long");
    expect(rt.calls).toEqual([]);
  });

  it("explicit undefined fields are ignored", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    expect(await call(rt, { action: "pause", planId: "p1", text: undefined })).toContain("paused");
  });
});

describe("router_plan: an unknown plan", () => {
  const ACTIONS_WITH_PLAN: RouterPlanAction[] = ["residue", "approve", "status", "ready", "add-tasks", "answer", "done", "pause", "resume", "abort", "land", "adopt", "export", "purge"];
  for (const action of ACTIONS_WITH_PLAN) {
    it(action, async () => {
      const rt = new FakeRuntime();
      seedFor(rt, "running");
      const out = await call(rt, { action, ...validFor(action === "status" ? "status" : action).args, planId: "ghost" });
      expect(out).toContain(`${action === "status" ? "action=status" : `action=${action}`} refused (E_LEDGER_NOT_FOUND)`);
      expect(out).toContain("ghost");
      expect(out).toContain("No such plan");
      expect(rt.plans.get("p1")?.status).toBe("running");
    });
  }

  it("status without planId and no plan of the session", async () => {
    const rt = new FakeRuntime();
    const out = await call(rt, { action: "status" });
    expect(out).toContain("E_LEDGER_NOT_FOUND");
  });
});

describe("router_plan: a plan owned by another live session", () => {
  for (const action of OWNER_CHECKED) {
    it(`${action} is refused and changes nothing`, async () => {
      const rt = new FakeRuntime();
      const c = validFor(action);
      seedFor(rt, c.seedStatus);
      const before = JSON.stringify([...rt.plans.values()].map(p => [p.status, [...p.tasks], [...p.inbox]]));
      const out = await call(rt, { action, ...c.args }, OTHER);
      expect(out).toContain(`action=${action} refused (E_NOT_OWNER)`);
      // QA-4.1-15: "another session", not "another live session".
      expect(out).toContain("That plan belongs to another session; do not act on it.");
      expect(out).not.toContain("another live session");
      expect(out).toContain("action=adopt");
      expect(JSON.stringify([...rt.plans.values()].map(p => [p.status, [...p.tasks], [...p.inbox]]))).toBe(before);
      expect(rt.deletedRefs).toEqual([]);
    });
  }

  it("adopt by another session is refused while the owner is alive and works once it is gone", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const refused = await call(rt, { action: "adopt", planId: "p1" }, OTHER);
    expect(refused).toContain("action=adopt refused (E_LOCK_HELD)");
    expect(rt.plans.get("p1")?.owner).toBe(OWNER);
    rt.liveSessions.delete(OWNER);
    const ok = await call(rt, { action: "adopt", planId: "p1" }, OTHER);
    expect(ok).toContain("adopted by this session");
    expect(rt.plans.get("p1")?.owner).toBe(OTHER);
    // the previous owner is not live; the plan is now owned by OTHER, whom the double treats as live
    expect(await call(rt, { action: "pause", planId: "p1" }, OWNER)).toContain("E_NOT_OWNER");
  });

  it("read-only actions work for any session on any status", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "completed");
    expect(await call(rt, { action: "status", planId: "p1" }, OTHER)).toContain("Plan p1 [completed]");
    expect(await call(rt, { action: "status", planId: "p1", inbox: true }, OTHER)).toContain("Q-1");
    expect(await call(rt, { action: "ready", planId: "p1" }, OTHER)).toContain("launchable");
    expect(await call(rt, { action: "export", planId: "p1" }, OTHER)).toContain("\"snapshot\"");
  });

  it("answer without planId never reaches another session's plan", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "answer", inboxId: "Q-1", text: "x" }, OTHER);
    expect(out).toBe(NO_PLAN_REFUSAL);
    expect(rt.plans.get("p1")?.inbox.get("Q-1")?.open).toBe(true);
    expect(rt.calls).toEqual(["planLine"]);
  });
});

const NO_PLAN_REFUSAL =
  "[router_plan] action=answer refused: this session runs no plan now; pass planId (the user: /plan answer --plan <planId> <id> <text>).";

describe("router_plan: answer without planId and the inbox view", () => {
  it("answer without planId answers on the calling session's plan", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "answer", inboxId: "Q-1", text: "go with b" });
    expect(out).toBe("plan p1: inbox Q-1 answered.");
    expect(rt.plans.get("p1")?.inbox.get("Q-1")?.answer).toBe("go with b");
    expect(rt.calls).toEqual(["planLine", "answer"]);
  });

  it("answer without planId and no plan of the session is refused", async () => {
    const rt = new FakeRuntime();
    expect(await call(rt, { action: "answer", inboxId: "Q-1", text: "x" })).toBe(NO_PLAN_REFUSAL);
    expect(rt.calls).toEqual(["planLine"]);
  });

  it("answer without planId refuses when the plan line names no plan", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    rt.planLine = () => "something else";
    const out = await call(rt, { action: "answer", inboxId: "Q-1", text: "x" });
    expect(out).toBe(NO_PLAN_REFUSAL);
    expect(rt.calls).toEqual([]);
  });

  it("QA-4.1-5: without planId the session's RUNNING plan is used, never its oldest finished one", async () => {
    const rt = new FakeRuntime();
    // Insertion order makes the finished plans first, as `runtime.status(null)` would pick them.
    for (const [id, status] of [["old-done", "completed"], ["old-abort", "aborted"]] as const) {
      rt.seed(id, OWNER, status).inbox.set("Q-1", { open: true, answer: null });
    }
    const current = rt.seed("cur", OWNER, "paused");
    current.inbox.set("Q-1", { open: true, answer: null });
    expect(await call(rt, { action: "answer", inboxId: "Q-1", text: "go" })).toBe("plan cur: inbox Q-1 answered.");
    expect(current.inbox.get("Q-1")?.answer).toBe("go");
    expect(rt.plans.get("old-done")?.inbox.get("Q-1")?.open).toBe(true);
    expect(rt.plans.get("old-abort")?.inbox.get("Q-1")?.open).toBe(true);
    expect((await call(rt, { action: "status" })).split("\n")[0]).toBe(`Plan cur [paused] ${PLAN_FILE}`);
    expect((await call(rt, { action: "status", inbox: true })).split("\n")[0]).toBe(`Plan cur [paused] ${PLAN_FILE}`);
    // With only finished plans left, answer asks for planId; status falls back to the runtime's pick.
    current.status = "aborted";
    expect(await call(rt, { action: "answer", inboxId: "Q-1", text: "x" })).toBe(NO_PLAN_REFUSAL);
    expect((await call(rt, { action: "status" })).split("\n")[0]).toBe(`Plan old-done [completed] ${PLAN_FILE}`);
    // An explicit planId always wins.
    expect(await call(rt, { action: "answer", planId: "old-done", inboxId: "Q-1", text: "late" })).toBe("plan old-done: inbox Q-1 answered.");
  });

  it("status inbox:true shows only the head line and the open inbox items", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    rt.plans.get("p1")?.inbox.set("Q-2", { open: true, answer: null });
    const out = await call(rt, { action: "status", inbox: true });
    expect(out).toBe([
      `Plan p1 [running] ${PLAN_FILE}`,
      "Inbox (2):",
      "  Q-1 question/blocking: pick an option",
      "  Q-2 question/blocking: pick an option",
      // QA-4.1-15: the user's form first; this is the session's running plan, so no --plan.
      "Answer: /plan answer <id> <text> (tool: router_plan action=answer planId=p1 inboxId=<id> text=<answer>).",
    ].join("\n"));
    expect(out).not.toContain("Metrics:");
    expect(out).not.toContain("Ready:");
  });

  it("status inbox:true with no open item says so", async () => {
    const rt = new FakeRuntime();
    rt.seed("p1", OWNER, "running", { T1: { state: "ready" } });
    expect(await call(rt, { action: "status", planId: "p1", inbox: true })).toBe(`Plan p1 [running] ${PLAN_FILE}\nInbox: no open items.`);
  });

  it("status inbox:true keeps a multi-line item whole and counts items only", async () => {
    const rt = new FakeRuntime();
    rt.statusText = "Plan p7 [paused] D:\\p.md\nReady:\n  T1\nInbox:\n  Q-1 question/blocking: first line\nsecond line\n  Q-2 info/minor: ok\nMetrics: launches 3";
    const out = await call(rt, { action: "status", inbox: true });
    expect(out).toBe([
      "Plan p7 [paused] D:\\p.md",
      "Inbox (2):",
      "  Q-1 question/blocking: first line",
      "second line",
      "  Q-2 info/minor: ok",
      // p7 is not the session's running plan (planLine is null here), so the user's form names it.
      "Answer: /plan answer --plan p7 <id> <text> (tool: router_plan action=answer planId=p7 inboxId=<id> text=<answer>).",
    ].join("\n"));
  });

  it("status inbox:true of another plan than the running one names --plan in the user's form", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    rt.seed("p2", OWNER, "completed").inbox.set("Q-5", { open: true, answer: null });
    const out = await call(rt, { action: "status", planId: "p2", inbox: true });
    const lines = out.split("\n");
    expect(lines[lines.length - 1]).toBe(
      "Answer: /plan answer --plan p2 <id> <text> (tool: router_plan action=answer planId=p2 inboxId=<id> text=<answer>).",
    );
  });

  it("status inbox:false is the full board", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "status", inbox: false });
    expect(out).toContain("Ready:");
    expect(out).toContain("Metrics:");
  });
});

describe("router_plan: ready, done and manual tasks", () => {
  it("ready lists manual tasks and tells how to report them", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "ready", planId: "p1" });
    expect(out).toContain("launchable 1 (T1); manual 1 (M1).");
    expect(out).toContain("router_plan action=done planId=p1 task=<id>");
  });

  it("ready with nothing says none and gives no manual hint", async () => {
    const rt = new FakeRuntime();
    rt.seed("p1", OWNER, "running", { T1: { state: "pending" } });
    const out = await call(rt, { action: "ready", planId: "p1" });
    expect(out).toBe("plan p1 ready: launchable 0 (none); manual 0 (none).");
  });

  it("done on a non-manual task is refused", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "done", planId: "p1", task: "T1" });
    expect(out).toContain("action=done refused (E_INVALID_INPUT)");
    expect(out).toContain("only a manual or preflight task");
    expect(rt.plans.get("p1")?.tasks.get("T1")?.state).toBe("ready");
  });

  it("done on a manual task that is not ready, and on an unknown task, is refused", async () => {
    const rt = new FakeRuntime();
    rt.seed("p1", OWNER, "running", { M1: { state: "pending", kind: "manual" }, P1: { state: "ready", kind: "preflight" } });
    expect(await call(rt, { action: "done", planId: "p1", task: "M1" })).toContain("E_INVALID_INPUT");
    expect(await call(rt, { action: "done", planId: "p1", task: "Z9" })).toContain("unknown task Z9");
    expect(await call(rt, { action: "done", planId: "p1", task: "P1" })).toContain("task P1 marked done");
  });

  it("a long manual list is cut with a count", async () => {
    const rt = new FakeRuntime();
    const tasks: Record<string, Partial<FakeTask>> = {};
    for (let i = 1; i <= 20; i++) tasks[`M${i}`] = { state: "ready", kind: "manual" };
    rt.seed("p1", OWNER, "running", tasks);
    const out = await call(rt, { action: "ready", planId: "p1" });
    expect(out).toContain("manual 20 (M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12 (+8 more))");
  });
});

describe("router_plan: add-tasks", () => {
  it("rejects a cycle among the new tasks and leaves the plan untouched", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const text = JSON.stringify({ tasks: [{ id: "N1", deps: ["N2"] }, { id: "N2", deps: ["N1"] }] });
    const out = await call(rt, { action: "add-tasks", planId: "p1", text });
    expect(out).toContain("action=add-tasks refused (E_CYCLE)");
    expect(out).toContain("N1 -> N2 -> N1");
    expect(out).toContain("Remove one dependency");
    expect(rt.plans.get("p1")?.tasks.has("N1")).toBe(false);
  });

  it("rejects an edge that closes a cycle through existing tasks", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "add-tasks", planId: "p1", text: JSON.stringify({ edges: [{ from: "T2", to: "T1" }] }) });
    expect(out).toContain("E_CYCLE");
    expect(rt.plans.get("p1")?.tasks.get("T1")?.state).toBe("ready");
  });

  it("rejects a write path outside the repository (relative escape and absolute)", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    for (const w of ["..\\outside\\a.ts", "src/../../b.ts", "C:\\Windows\\c.ts", "/etc/d"]) {
      const text = JSON.stringify({ tasks: [{ id: "N1", writes: [w] }] });
      const out = await call(rt, { action: "add-tasks", planId: "p1", text });
      expect(out).toContain("action=add-tasks refused (E_INVALID_INPUT)");
      expect(out).toContain("outside the repository");
    }
    expect(rt.plans.get("p1")?.tasks.has("N1")).toBe(false);
  });

  it("rejects text that is not JSON", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    expect(await call(rt, { action: "add-tasks", planId: "p1", text: "add a task please" })).toContain("not valid JSON");
  });

  it("an unsatisfied dependency on a ready task returns it to pending", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const text = JSON.stringify({ tasks: [{ id: "N1" }], edges: [{ from: "N1", to: "T1" }] });
    const out = await call(rt, { action: "add-tasks", planId: "p1", text });
    expect(out).toBe("plan p1: added 1 (N1); returned to pending 1 (T1).");
    expect(rt.plans.get("p1")?.tasks.get("T1")?.state).toBe("pending");
    expect(rt.plans.get("p1")?.tasks.get("T1")?.deps).toContain("N1");
    const ready = await call(rt, { action: "ready", planId: "p1" });
    expect(ready).toContain("launchable 0 (none)");
  });

  it("a satisfied dependency leaves a ready task ready", async () => {
    const rt = new FakeRuntime();
    rt.seed("p1", OWNER, "running", { D1: { state: "done" }, T1: { state: "ready" } });
    const out = await call(rt, { action: "add-tasks", planId: "p1", text: JSON.stringify({ edges: [{ from: "D1", to: "T1" }] }) });
    expect(out).toBe("plan p1: added 0 (none).");
    expect(rt.plans.get("p1")?.tasks.get("T1")?.state).toBe("ready");
  });

  it("is refused on a plan that is not running or paused", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "completed");
    expect(await call(rt, { action: "add-tasks", planId: "p1", text: "{}" })).toContain("E_PLAN_STATE");
  });
});

describe("router_plan: gc, export and purge", () => {
  it("gc removes only the slots of completed or aborted plans", async () => {
    const rt = new FakeRuntime();
    rt.seed("run", OWNER, "running");
    rt.seed("pau", OWNER, "paused");
    rt.seed("don", OWNER, "completed");
    rt.seed("abo", OWNER, "aborted");
    const out = await call(rt, { action: "gc" });
    expect(out).toBe("gc: removed 2 (slot-don-a, slot-abo-a); reported 0 (none).");
    expect(rt.plans.get("run")?.slots).toEqual(["slot-run-a"]);
    expect(rt.plans.get("pau")?.slots).toEqual(["slot-pau-a"]);
    expect(rt.plans.get("don")?.slots).toEqual([]);
    expect(rt.plans.get("abo")?.slots).toEqual([]);
    expect(await call(rt, { action: "gc" })).toBe("gc: removed 0 (none); reported 0 (none).");
  });

  it("gc names reported slots as left in place", async () => {
    const rt = new FakeRuntime();
    rt.gc = async () => ({ removed: [], reported: ["D:\\slots\\odd"] });
    const out = await call(rt, { action: "gc" });
    expect(out).toContain("reported 1 (D:\\slots\\odd)");
    expect(out).toContain("not removed");
  });

  it("export returns the snapshot plus the journal as JSON text", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "export", planId: "p1" });
    const doc = JSON.parse(out) as { snapshot: { planId: string; status: string }; journal: string[] };
    expect(doc.snapshot.planId).toBe("p1");
    expect(doc.snapshot.status).toBe("running");
    expect(doc.journal).toEqual(["plan-created p1"]);
  });

  it("purge is refused for a running or paused plan", async () => {
    for (const status of ["running", "paused", "awaiting-approval"] as const) {
      const rt = new FakeRuntime();
      seedFor(rt, status);
      const out = await call(rt, { action: "purge", planId: "p1" });
      expect(out).toContain("action=purge refused (E_PLAN_STATE)");
      expect(rt.plans.has("p1")).toBe(true);
      expect(rt.deletedRefs).toEqual([]);
    }
  });

  it("purge removes a completed or aborted plan", async () => {
    for (const status of ["completed", "aborted"] as const) {
      const rt = new FakeRuntime();
      seedFor(rt, status);
      const out = await call(rt, { action: "purge", planId: "p1" });
      expect(out).toBe("plan p1 purged: slots, omr/p1/ refs and ledger removed.");
      expect(rt.plans.has("p1")).toBe(false);
      expect(rt.deletedRefs).toEqual(["omr/p1/"]);
      expect(await call(rt, { action: "export", planId: "p1" })).toContain("E_LEDGER_NOT_FOUND");
    }
  });
});

describe("router_plan: pause, resume, abort, land, answer state errors", () => {
  it("map E_PLAN_STATE to a pointer at status", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const out = await call(rt, { action: "resume", planId: "p1" });
    expect(out).toContain("action=resume refused (E_PLAN_STATE)");
    expect(out).toContain("action=status");
  });

  it("answer of a closed or unknown inbox item is refused", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    expect(await call(rt, { action: "answer", planId: "p1", inboxId: "Q-9", text: "x" })).toContain("E_INVALID_INPUT");
    expect(await call(rt, { action: "answer", planId: "p1", inboxId: "Q-1", text: "a" })).toContain("answered");
    expect(await call(rt, { action: "answer", planId: "p1", inboxId: "Q-1", text: "b" })).toContain("not open");
  });

  it("pause then resume then abort walk the states", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    await call(rt, { action: "pause", planId: "p1" });
    expect(rt.plans.get("p1")?.status).toBe("paused");
    await call(rt, { action: "resume", planId: "p1" });
    expect(rt.plans.get("p1")?.status).toBe("running");
    const aborted = await call(rt, { action: "abort", planId: "p1" });
    expect(aborted).toContain("action=gc");
    expect(aborted).toContain("action=purge planId=p1");
    expect(await call(rt, { action: "pause", planId: "p1" })).toContain("E_PLAN_STATE");
  });
});

describe("router_plan: output shape", () => {
  it("never throws: unexpected errors become compact text", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    rt.throwOn.set("pause", new Error("disk\nfull   at\n  C:\\x"));
    expect(await call(rt, { action: "pause", planId: "p1" })).toBe("[router_plan] action=pause failed: disk full at C:\\x");
    rt.throwOn.set("pause", "plain string");
    expect(await call(rt, { action: "pause", planId: "p1" })).toBe("[router_plan] action=pause failed: plain string");
    rt.throwOn.set("pause", null);
    expect(await call(rt, { action: "pause", planId: "p1" })).toContain("failed: null");
  });

  it("an ExecutorError recognised by name from another realm is still mapped", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const foreign = Object.assign(new Error("not yours"), { name: "ExecutorError", code: "E_NOT_OWNER" });
    rt.throwOn.set("pause", foreign);
    expect(await call(rt, { action: "pause", planId: "p1" })).toContain("refused (E_NOT_OWNER): not yours");
  });

  it("long error messages are cut", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    rt.throwOn.set("pause", new ExecutorError("E_GIT", "x".repeat(5000)));
    const out = await call(rt, { action: "pause", planId: "p1" });
    expect(out.length).toBeLessThan(700);
    expect(out).toContain("...");
  });

  it("status passes the board through and cuts an oversized one", async () => {
    const rt = new FakeRuntime();
    rt.statusText = "BOARD";
    expect(await call(rt, { action: "status" })).toBe("BOARD");
    rt.statusText = "y".repeat(50_000);
    const out = await call(rt, { action: "status" });
    expect(out.length).toBeLessThan(40_100);
    expect(out).toContain("status truncated at 40000 chars");
  });

  it("warnings in a summary are listed up to five", async () => {
    const rt = new FakeRuntime();
    const compile = rt.compile.bind(rt);
    rt.compile = async i => {
      const r = await compile(i);
      return { ...r, summary: { ...r.summary, warnings: Array.from({ length: 7 }, (_, n) => `warning ${n + 1}`) } };
    };
    const out = await call(rt, { action: "compile", path: PLAN_FILE });
    expect(out).toContain("warnings (7):");
    expect(out).toContain("- warning 5");
    expect(out).not.toContain("- warning 6");
    expect(out).toContain("- (+2 more)");
  });
});

describe("createRouterPlanTool", () => {
  it("declares the strict args and delegates execute", async () => {
    const rt = new FakeRuntime();
    seedFor(rt, "running");
    const def = createRouterPlanTool(rt);
    expect(Object.keys(def.args).sort()).toEqual(["action", "doneBefore", "inbox", "inboxId", "path", "phases", "planId", "task", "text"]);
    expect(def.description).toContain("compile");
    expect(def.description).toContain("purge");
    const ctx = { sessionID: OWNER } as never;
    expect(await def.execute({ action: "pause", planId: "p1" }, ctx)).toContain("paused");
    expect(rt.plans.get("p1")?.status).toBe("paused");
    expect(await def.execute({ action: "pause", planId: "p1" }, { sessionID: OTHER } as never)).toContain("E_NOT_OWNER");
    expect(await def.execute({ action: "nope" } as never, ctx)).toContain("unknown action");
  });

  it("reads the approve setting on every call", async () => {
    const rt = new FakeRuntime();
    let mode: "ask" | "auto" = "ask";
    const def = createRouterPlanTool(rt, { approve: () => mode });
    const ctx = { sessionID: OWNER } as never;
    expect(await def.execute({ action: "compile", path: PLAN_FILE }, ctx)).toContain("awaiting-approval");
    mode = "auto";
    expect(await def.execute({ action: "compile", path: PLAN_FILE }, ctx)).toContain("approve: auto");
    expect(rt.plans.get("plan-1")?.status).toBe("awaiting-approval");
    expect(rt.plans.get("plan-2")?.status).toBe("running");
  });

  it("schema enum matches the exported action list", () => {
    expect(ROUTER_PLAN_ACTIONS).toEqual([
      "compile", "residue", "approve", "status", "ready", "add-tasks", "answer", "done",
      "pause", "resume", "abort", "land", "adopt", "gc", "export", "purge",
    ]);
  });

  it("describes path, approval and ownership as QA-4.1 fixed them", () => {
    const def = createRouterPlanTool(new FakeRuntime());
    // QA-4.1-16: no "unless … auto" clause the model could satisfy with its own belief about the setting.
    expect(def.description).toContain("approve (planId; only after the user approves; with approve: auto, compile approves by itself)");
    expect(def.description).not.toMatch(/unless/);
    expect(def.description).toContain("A plan owned by another session is refused.");
    expect(def.description).not.toContain("another live session");
  });
});

// QA-4.1-5 contract: the tool reads two runtime.ts renderings, `planLine` (which plan the session runs now) and the
// board head of `renderBoard`. These pins break when runtime.ts changes either template, and the parsers are run on lines
// built exactly like those templates.
describe("router_plan: contract with runtime.ts planLine and renderBoard (QA-4.1-5)", () => {
  const src = readFileSync(join(process.cwd(), "src", "executor", "runtime.ts"), "utf8");

  it("runtime.ts still renders the shapes the tool parses", () => {
    expect(src).toContain(
      'let line = `plan ${l.planId}: ${done}/${ts2.length} done, ${running} running, ${ready} ready${l.status === "paused" ? ", paused" : ""}`;',
    );
    expect(src).toContain('if (!g.ok && g.reason !== "disposed") line += ` (launch blocked: ${g.reason})`;');
    // planLine skips every plan that is not running or paused: the finished ones never answer "the session's plan".
    expect(src).toContain('if (l.orchestrator.sessionID !== sessionID || (l.status !== "running" && l.status !== "paused")) continue;');
    expect(src).toContain("const out: string[] = [`Plan ${l.planId} [${l.status}] ${l.planPath}`];");
    expect(src).toContain('out.push("Inbox:");');
    expect(src).toContain("out.push(`Metrics: launches ${p.counters.launches}");
  });

  it("parses lines built like those templates", () => {
    const planLine = (planId: string, status: string, done: number, total: number, running: number, ready: number, blocked?: string): string => {
      let line = `plan ${planId}: ${done}/${total} done, ${running} running, ${ready} ready${status === "paused" ? ", paused" : ""}`;
      if (blocked !== undefined) line += ` (launch blocked: ${blocked})`;
      return line;
    };
    for (const id of ["p1", "cpx-p41-executor", "plan-2026-10-13", "a:b"]) {
      expect(planLinePlanId(planLine(id, "running", 0, 12, 2, 3)), id).toBe(id);
      expect(planLinePlanId(planLine(id, "paused", 11, 12, 0, 0, "capacity")), id).toBe(id);
      expect(boardPlanId(`Plan ${id} [completed] D:\\My Plans\\p.md\nTasks: done 12`), id).toBe(id);
    }
    expect(planLinePlanId(null)).toBeNull();
    expect(planLinePlanId("Plan p1 [running] D:\\p.md")).toBeNull();
    expect(boardPlanId("plan p1: 0/1 done, 0 running, 1 ready")).toBeNull();
  });
});
