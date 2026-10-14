import { describe, expect, it } from "vitest";
import type { ObservationData, ServiceIdentity, ServiceSpanKind } from "../../../src/compat/v2-observations";
import type { ExecutorEvent, ExecutorEventInput, IntegrationEntry, TaskNode } from "../../../src/executor/types";
import { assertG8Bound, freezeG8Plan, reconstructG8, type G8Final, type GraphEdge } from "./cpx-g8-oracle";
import type { ObservationFile } from "./cpx-idle-oracle";

const BASE = Date.parse("2026-10-14T12:00:00Z"), MONO = 500;
interface Task { id: string; durationMs: number; phase?: string; qa?: boolean }

/** Hand-authored service and journal evidence, not the production executor or estimator. Epoch and
 * monotonic clocks deliberately have different origins; raw journal time never supplies service cost.
 */
function fixture(tasks: Task[], edges: GraphEdge[] = [], p = 4) {
  const authored = Object.fromEntries(tasks.map(t => [t.id, { durationMs: t.durationMs }]));
  const nodes: Record<string, Pick<TaskNode, "phase" | "kind" | "footprint">> = Object.fromEntries(tasks.map(t => [t.id, {
    phase: t.phase ?? null, kind: t.qa ? "qa" : "task",
    footprint: { writes: t.qa ? [] : [`${t.id}.ts`], reads: [], confidence: "explicit", sources: ["writes-line"] },
  }]));
  const phases = [...new Set(tasks.flatMap(t => t.phase ? [t.phase] : []))];
  const compiled = { planId: "plan", seq: 1, config: { maxParallel: p }, tasks: nodes, phases: phases.map(id => ({ id })), edges };
  const plan = freezeG8Plan(authored, compiled);
  const finalTasks: Record<string, G8Final["tasks"][string]> = Object.fromEntries(tasks.map(t => [t.id, {
    state: t.qa ? "done" : "integrated", integrated: t.qa ? null : { from: `base-${t.id}`, to: `tip-${t.id}` },
    attempts: [{ n: 1, outcome: "succeeded", verdict: t.qa ? null : "pass" }],
  }]));
  const final: G8Final = { planId: "plan", status: "completed", tasks: finalTasks, phases: phases.map(id => ({ id, gate: "passed" })) };
  const events: ExecutorEvent[] = [], rows: (ObservationData & { at: number })[] = [];
  let end = 100_000, operation = 0;
  function event(ms: number, input: ExecutorEventInput, batch?: number): ExecutorEvent {
    const seq = events.length + 1;
    const row = { ...input, seq, batch: batch ?? seq, last: true, at: new Date(BASE + ms).toISOString() };
    events.push(row);
    return row;
  }
  function span(identity: ServiceIdentity, from: number, to: number, spanKind: ServiceSpanKind = "service", stage = "command") {
    const operationId = `op-${++operation}`;
    rows.push({ ...identity, family: "service", operationId, stage, spanKind, action: "start", clockMs: MONO + from,
      durationMs: 0, result: null, at: BASE + from });
    rows.push({ ...identity, family: "service", operationId, stage, spanKind, action: "end", clockMs: MONO + to,
      durationMs: to - from, result: "pass", at: BASE + to });
  }
  const verifyIdentity = (id: string, attempt = 1): ServiceIdentity => ({ planId: "plan", taskId: id, attempt,
    phaseId: null, entryId: null, taskIds: [id], component: "verify", candidate: null });
  function verify(id: string, from: number, ms = 0, attempt = 1, verdict: "pass" | "fail" = "pass") {
    span(verifyIdentity(id, attempt), from, from + ms, "service", "grading");
    event(from + ms, { type: "attempt-verdict", taskId: id, n: attempt, verdict, ref: null });
  }
  function entry(id: string, ids: string[], from: number, ms: number, phase?: string) {
    const suite = ids.length === 0;
    const identity: IntegrationEntry = { id, kind: suite ? "phase-suite" : ids.length === 1 ? "task" : "batch",
      phaseId: phase ?? nodes[ids[0] ?? ""]?.phase ?? null, taskIds: ids, slot: "slot-1", baseHead: "base", candidate: `commit-${id}` };
    const quarter = Math.floor(ms / 4);
    const components: { component: ServiceIdentity["component"]; ms: number }[] = suite ? [{ component: "phase-suite", ms }]
      : [{ component: "rebase", ms: quarter }, { component: "checks", ms: ms - 2 * quarter }, { component: "fast-forward", ms: quarter }];
    let at = from;
    for (const [index, component] of components.entries()) {
      const step = component.component === "checks" && ids.length > 1 ? "batch-checks" : component.component;
      // verify never occurs in an integration entry.
      if (step === "verify") throw new Error("invalid fixture step");
      event(at, { type: "integration-step", edge: "start", entry: identity, step, result: null, detail: null, failingIds: [], closes: false });
      span({ planId: "plan", taskId: null, attempt: null, phaseId: identity.phaseId, entryId: id, taskIds: ids,
        component: component.component, candidate: identity.candidate }, at, at + component.ms);
      at += component.ms;
      const close = event(at, { type: "integration-step", edge: "end", entry: identity, step, result: "ok", detail: null,
        failingIds: [], closes: index === components.length - 1 });
      if (step === "fast-forward") for (const taskId of ids) {
        event(at, { type: "task-integrated", taskId, from: `base-${taskId}`, to: `tip-${taskId}` }, close.batch);
      }
    }
    if (suite) event(at, { type: "gate-changed", phaseId: phase!, from: "qa-running", to: "passed", trigger: "qa-clean", qaRound: 1 });
  }
  for (const task of tasks) {
    event(0, { type: "metric", metric: { name: "launch", taskId: task.id, attempt: 1, agent: "implementer", model: "fixture", provider: "fixture", heavy: false } });
    if (task.qa) event(task.durationMs, { type: "task-transition", taskId: task.id, from: "completed", to: "done", trigger: "no-changes", detail: null });
  }
  function files(): ObservationFile[] {
    const commits: (ObservationData & { at: number })[] = [];
    const states = new Map(tasks.map(t => [t.id, t.qa ? "running" : "integrating"]));
    const commit = (ledgerSeq: number, at: number) => commits.push({ family: "scheduler", planId: "plan", parentSessionID: "parent", action: "ledger", at,
      state: { ledgerSeq, tasks: tasks.map(t => ({ id: t.id, kind: t.qa ? "qa" : "task", phase: t.phase ?? null, state: states.get(t.id)!,
        attempts: finalTasks[t.id]!.attempts.map(a => ({ n: a.n, outcome: ["done", "integrated"].includes(states.get(t.id)!) ? a.outcome : null })) })) } });
    commit(plan.compiledLedgerSeq, BASE);
    const batches = new Map<number, ExecutorEvent[]>();
    for (const e of inventory()) { const batch = batches.get(e.batch) ?? []; batch.push(e); batches.set(e.batch, batch); }
    for (const batch of batches.values()) {
      let changed = false;
      for (const e of batch) {
        if (e.type === "task-integrated") { states.set(e.taskId, "integrated"); changed = true; }
        if (e.type === "task-transition" && e.trigger === "no-changes") { states.set(e.taskId, "done"); changed = true; }
      }
      if (changed) commit(Math.max(...batch.map(e => e.seq)), Math.max(...batch.map(e => Date.parse(e.at))));
    }
    const wire = [...rows, ...commits].sort((a, b) => a.at - b.at).map((row, i) => ({ ...row, v: 1, stream: "fixture", seq: i + 1 }));
    const seal = { v: 1, stream: "fixture", seq: wire.length + 1, at: Math.max(BASE + end, ...wire.map(r => r.at)), kind: "end",
      attempted: wire.length, written: wire.length, dropped: 0, failed: 0 };
    return [{ file: "fixture.jsonl", text: [...wire, seal].map(row => JSON.stringify(row) + "\n").join("") }];
  }
  function inventory(): ExecutorEvent[] {
    const completion: ExecutorEvent = { type: "metric", seq: events.length + 1, batch: Number.MAX_SAFE_INTEGER, last: true,
      at: new Date(BASE + end).toISOString(), metric: { name: "wake", reason: "plan-completed", stateKey: "completed", result: "sent" } };
    const ordered = [...events, completion].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = new Map<number, number>();
    ordered.forEach((e, i) => { if (!first.has(e.batch)) first.set(e.batch, i + 1 + plan.compiledLedgerSeq); });
    return ordered.map((e, i) => ({ ...e, seq: i + 1 + plan.compiledLedgerSeq, batch: first.get(e.batch)! }));
  }
  function shiftFrom(ms: number, delay: number, keepStepStart = false) {
    const shifted = new Set(rows.flatMap(row => row.family === "service" && row.action === "start" && row.at >= BASE + ms ? [row.operationId] : []));
    for (const row of rows) if (row.family === "service" ? shifted.has(row.operationId) : row.at >= BASE + ms) {
      row.at += delay;
      if (row.family === "service") row.clockMs += delay;
    }
    for (const e of events) if (Date.parse(e.at) >= BASE + ms) {
      // A predecessor finishing exactly at the boundary is not part of the delayed successor.
      if (Date.parse(e.at) === BASE + ms && (e.type === "task-integrated" || (e.type === "integration-step" && e.edge === "end"))) continue;
      if (keepStepStart && e.type === "integration-step" && e.edge === "start" && Date.parse(e.at) === BASE + ms) continue;
      e.at = new Date(Date.parse(e.at) + delay).toISOString();
    }
    end += delay;
  }
  return { authored, compiled, plan, final, finalTasks, rows, events, event, span, verifyIdentity, verify, entry, files, inventory, shiftFrom,
    finish(ms: number) { end = ms; },
    measure(rawΣI = 0) { return reconstructG8(plan, final, inventory(), files(), rawΣI); } };
}
type Fixture = ReturnType<typeof fixture>;
function atBound(f: Fixture) { const bound = f.measure().bound; f.finish(bound); return f.measure(); }
function sharedBatch() {
  const f = fixture([{ id: "a", durationMs: 10_000 }, { id: "b", durationMs: 10_000 }]);
  f.verify("a", 10_000); f.verify("b", 10_000); f.entry("batch", ["a", "b"], 10_000, 4_000);
  return f;
}
function dominant(term: "CP_eff" | "W/p" | "ΣI_service") {
  const count = term === "CP_eff" ? 1 : term === "W/p" ? 8 : 5;
  const durationMs = term === "ΣI_service" ? 100 : 10_000;
  const integration = term === "W/p" ? 100 : 1_000;
  const f = fixture(Array.from({ length: count }, (_, i) => ({ id: `t${i}`, durationMs })));
  const verification = term === "CP_eff" ? 2_000 : 0;
  for (let i = 0; i < count; i++) {
    f.verify(`t${i}`, durationMs, verification);
    f.entry(`i${i}`, [`t${i}`], durationMs + verification + i * integration, integration);
  }
  return f;
}
function changeWire(files: ObservationFile[], edit: (rows: Record<string, unknown>[]) => void): ObservationFile[] {
  return files.map(file => {
    const rows: Record<string, unknown>[] = file.text.trimEnd().split("\n").map(line => JSON.parse(line));
    edit(rows);
    return { ...file, text: rows.map(row => JSON.stringify(row) + "\n").join("") };
  });
}

describe("G8 amended intrinsic-service oracle A-6.1-1 (no host)", () => {
  it.each(["CP_eff", "W/p", "ΣI_service"] as const)("%s dominates: exactly-at-bound passes; bound + 1 ms fails", term => {
    const f = dominant(term), m = atBound(f);
    const terms = { CP_eff: m.CP_eff, "W/p": m.W_auth / m.p, "ΣI_service": m["ΣI_service"] };
    expect(terms[term]).toBeGreaterThan(Math.max(...Object.entries(terms).filter(([key]) => key !== term).map(([, n]) => n)));
    expect(m.bound).toBe(1.3 * terms[term]);
    expect(() => assertG8Bound(m)).not.toThrow();
    f.finish(m.bound + 1);
    expect(() => assertG8Bound(f.measure())).toThrow(/amended makespan bound exceeded/);
  });

  it("assigns the full shared 4 s entry to both independent 10 s writers, but unions it once", () => {
    const m = atBound(sharedBatch());
    expect(m).toMatchObject({ CP_eff: 14_000, W_auth: 20_000, p: 4, "ΣI_service": 4_000, rawCP: 10_000, bound: 18_200 });
    expect(m.vertices.a).toMatchObject({ authored: 10_000, V_service: 0, I_service: 4_000, total: 14_000, entryIds: ["batch"] });
    expect(m.vertices.b).toEqual(m.vertices.a);
    expect(() => assertG8Bound(m)).not.toThrow();
  });

  it("uses task→gate and gate→task edges, including the terminal gate's service", () => {
    const f = fixture([{ id: "a", durationMs: 10_000, phase: "p1" }, { id: "b", durationMs: 1_000, phase: "p2" }], [{ from: "gate:p1", to: "b" }]);
    f.verify("a", 10_000); f.entry("a", ["a"], 10_000, 100); f.entry("s1", [], 10_100, 2_000, "p1");
    f.verify("b", 13_100); f.entry("b", ["b"], 13_100, 100); f.entry("s2", [], 13_200, 3_000, "p2");
    const m = atBound(f);
    expect(m).toMatchObject({ rawCP: 11_000, CP_eff: 16_200, "ΣI_service": 200 });
    expect(m.vertices["gate:p2"]?.S_service).toBe(3_000);
    expect(() => assertG8Bound(m)).not.toThrow();
  });

  it("an 11 s CP-edge launch delay at a baseline exactly at the bound cannot enlarge any term", () => {
    const f = fixture([{ id: "a", durationMs: 10_000 }, { id: "b", durationMs: 10_000 }], [{ from: "a", to: "b" }]);
    f.verify("a", 10_000); f.entry("a", ["a"], 10_000, 1_000);
    const launch = f.events.find(e => e.type === "metric" && e.metric.name === "launch" && e.metric.taskId === "b")!;
    launch.at = new Date(BASE + 11_000).toISOString();
    f.verify("b", 21_000); f.entry("b", ["b"], 21_000, 1_000);
    const before = atBound(f);
    expect(() => assertG8Bound(before)).not.toThrow();
    f.shiftFrom(11_000, 11_000);
    const after = f.measure();
    expect(after).toMatchObject({ CP_eff: before.CP_eff, W_auth: before.W_auth, "ΣI_service": before["ΣI_service"], bound: before.bound, makespan: before.bound + 11_000 });
    expect(after.vertices).toEqual(before.vertices);
    expect(() => assertG8Bound(after)).toThrow(/amended makespan bound exceeded/);
  });

  it("pre-entry queue padding cannot grow CP_eff or ΣI_service (even with inflated raw ΣI)", () => {
    const f = sharedBatch(), before = atBound(f);
    f.shiftFrom(10_000, 11_000);
    f.span({ ...f.verifyIdentity("a"), component: "rebase" }, 10_000, 21_000, "service-wait", "integration-queue");
    const after = f.measure(1_000_000);
    expect(after).toMatchObject({ CP_eff: before.CP_eff, "ΣI_service": before["ΣI_service"], bound: before.bound, rawΣI: 1_000_000 });
    expect(after.diagnostics.waitMs).toBe(11_000);
    expect(() => assertG8Bound(after)).toThrow(/amended makespan bound exceeded/);
  });

  it.each(["verify", "checks", "phase-suite"] as const)("intra-step preparation/resource wait padding in %s is diagnostic only", component => {
    const f = fixture([{ id: "a", durationMs: 10_000, phase: "p" }]);
    f.verify("a", 10_000, 1_000); f.entry("i", ["a"], 11_000, 4_000); f.entry("s", [], 15_000, 2_000, "p");
    const before = atBound(f);
    const service = f.rows.find(r => r.family === "service" && r.action === "start" && r.component === component);
    if (!service || service.family !== "service") throw new Error("missing fixture service");
    const start = service.at - BASE, identity = { ...service };
    f.shiftFrom(start, 11_000, true);
    f.span(identity, start, start + 5_000, "service-prep", "preparation");
    f.span(identity, start + 5_000, start + 11_000, "service-wait", "verification-slot");
    const after = f.measure(999_999);
    expect(after).toMatchObject({ CP_eff: before.CP_eff, "ΣI_service": before["ΣI_service"], bound: before.bound });
    expect(after.vertices).toEqual(before.vertices);
    expect(() => assertG8Bound(after)).toThrow(/amended makespan bound exceeded/);
  });

  it("observed-p and post-run DAG/duration attacks do not change the frozen denominator", () => {
    const f = dominant("W/p"), before = atBound(f);
    f.compiled.config.maxParallel = 1;
    f.compiled.edges.push({ from: "t0", to: "t1" });
    f.authored.t0!.durationMs = 999_999;
    f.rows.push({ family: "scheduler", planId: "plan", parentSessionID: "parent", action: "capacity-init", state: { maxParallel: 1, providers: [] }, at: BASE });
    expect(f.measure()).toMatchObject({ p: 4, W_auth: before.W_auth, CP_eff: before.CP_eff, bound: before.bound });
    f.finish(before.bound + 1);
    expect(() => assertG8Bound(f.measure())).toThrow(/amended makespan bound exceeded/);
    expect(Object.isFrozen(f.plan.links)).toBe(true);
  });

  it("sums verification only for the final passing attempt, without candidate deduplication", () => {
    const f = dominant("CP_eff");
    f.finalTasks.t0 = { ...f.finalTasks.t0!, attempts: [{ n: 1, outcome: "succeeded", verdict: "fail" }, { n: 2, outcome: "succeeded", verdict: "pass" }] };
    for (const row of f.rows) if (row.family === "service" && row.component === "verify") row.attempt = 2;
    for (const e of f.events) if (e.type === "attempt-verdict") { e.n = 2; e.at = new Date(BASE + 12_100).toISOString(); }
    f.verify("t0", 0, 5_000, 1, "fail");
    f.span(f.verifyIdentity("t0", 2), 12_000, 12_100);
    expect(f.measure().vertices.t0?.V_service).toBe(2_100);
  });

  it("allows zero I/V for QA only with explicit no-changes evidence; never for a writer", () => {
    const f = fixture([{ id: "a", durationMs: 100 }, { id: "qa", durationMs: 100, qa: true }]);
    f.verify("a", 100); f.entry("i", ["a"], 100, 100);
    expect(f.measure().vertices.qa).toMatchObject({ V_service: 0, I_service: 0 });
    f.events.splice(f.events.findIndex(e => e.type === "task-transition"), 1);
    expect(() => f.measure()).toThrow(/missing explicit no-operation evidence/);
    const writer = dominant("CP_eff");
    writer.finalTasks.t0 = { ...writer.finalTasks.t0!, state: "done", integrated: null };
    expect(() => writer.measure()).toThrow(/writer not integrated/);
  });

  it("uses explicit committed snapshots after ledger compaction removes non-history events", () => {
    const f = fixture([{ id: "a", durationMs: 100, phase: "p" }, { id: "qa", durationMs: 10, phase: "p", qa: true }]);
    f.verify("a", 100, 10); f.entry("i", ["a"], 110, 100); f.entry("s", [], 210, 20, "p");
    const compacted = f.inventory().filter(e => ["metric", "integration-step", "attempt-verdict"].includes(e.type));
    expect(reconstructG8(f.plan, f.final, compacted, f.files(), 0).vertices).toEqual(f.measure().vertices);
    const missing = changeWire(f.files(), rows => {
      // Keep a valid seal/sequence so absence cannot masquerade as a permitted no-operation.
      for (let i = rows.length - 2; i >= 0; i--) if (rows[i]!.family === "scheduler") rows.splice(i, 1);
      rows.forEach((row, i) => { row.seq = i + 1; });
      rows.at(-1)!.attempted = rows.length - 1; rows.at(-1)!.written = rows.length - 1;
    });
    expect(() => reconstructG8(f.plan, f.final, compacted, missing, 0)).toThrow(/integration attribution|no-operation evidence/);
  });

  it("ignores compilation drafts before the frozen pre-run ledger, not post-run graph changes", () => {
    const f = sharedBatch(), before = f.measure();
    f.rows.push({ family: "scheduler", planId: "plan", parentSessionID: "parent", action: "ledger", at: BASE - 1,
      state: { ledgerSeq: 0, tasks: [] } });
    expect(f.measure().vertices).toEqual(before.vertices);
  });

  it.each(["verify", "entry", "checks", "phase-suite"])("fails closed on missing %s service", missing => {
    const f = fixture([{ id: "a", durationMs: 100, phase: "p" }]);
    f.verify("a", 100, 10); f.entry("i", ["a"], 110, 100); f.entry("s", [], 210, 20, "p");
    for (let i = f.rows.length - 1; i >= 0; i--) {
      const row = f.rows[i]!;
      if (row.family === "service" && (missing === "entry" ? row.entryId === "i" : row.component === missing)) f.rows.splice(i, 1);
    }
    expect(() => f.measure()).toThrow(/missing (verify|entry|phase-suite) service/);
  });

  it.each(["unsealed", "gap", "dropped", "failed", "truncated", "duplicate stream"])("rejects %s observation streams", fault => {
    const f = sharedBatch();
    let files = changeWire(f.files(), rows => {
      if (fault === "unsealed") rows.pop();
      if (fault === "gap") rows.splice(1, 1);
      if (fault === "dropped") rows.at(-1)!.dropped = 1;
      if (fault === "failed") rows.at(-1)!.failed = 1;
    });
    if (fault === "truncated") files[0]!.text = files[0]!.text.slice(0, -1);
    if (fault === "duplicate stream") files = [...files, ...files];
    expect(() => reconstructG8(f.plan, f.final, f.inventory(), files, 0)).toThrow();
  });

  it.each(["start", "end"] as const)("rejects an unpaired service %s even in diagnostic spans", action => {
    const f = sharedBatch();
    f.span(f.verifyIdentity("a"), 0, 1, "service-prep");
    const index = f.rows.findIndex(r => r.family === "service" && r.spanKind === "service-prep" && r.action !== action);
    f.rows.splice(index, 1);
    expect(() => f.measure()).toThrow(/unpaired service/);
  });

  it.each(["pair", "task", "attempt", "candidate", "members"])("rejects ambiguous %s attribution", ambiguity => {
    const f = sharedBatch();
    for (const row of f.rows) if (row.family === "service") {
      if (ambiguity === "pair" && row.action === "end") row.candidate = "different";
      if (ambiguity === "task" && row.component === "verify") row.taskId = "unknown";
      if (ambiguity === "attempt" && row.component === "verify") row.attempt = 9;
      if (ambiguity === "candidate" && row.component === "checks") row.candidate = "wrong-commit";
      if (ambiguity === "members" && row.entryId === "batch") row.taskIds = ["a"];
    }
    expect(() => f.measure()).toThrow(/ambiguous|unknown verify attempt|matching journal step/);
  });

  it("rejects a batch duplicated along a dependency path, including through a phase gate", () => {
    for (const gate of [false, true]) {
      const f = fixture([{ id: "a", durationMs: 10_000, phase: "p" }, { id: "b", durationMs: 10_000, phase: gate ? "q" : "p" }],
        [{ from: gate ? "gate:p" : "a", to: "b" }]);
      f.verify("a", 10_000); f.verify("b", 10_000); f.entry("batch", ["a", "b"], 10_000, 4_000);
      expect(() => f.measure()).toThrow(/not an antichain/);
    }
  });

  it("rejects duplicate members, duplicated operations and a second integration attribution", () => {
    const members = sharedBatch();
    members.events.forEach(e => { if (e.type === "integration-step") e.entry.taskIds = ["a", "a", "b"]; });
    expect(() => members.measure()).toThrow(/invalid batch membership/);
    const operations = sharedBatch();
    operations.rows.push(...operations.rows.filter(r => r.family === "service" && r.entryId === "batch").map(r => ({ ...r })));
    expect(() => operations.measure()).toThrow(/duplicate operation/);
    const twice = sharedBatch();
    twice.entry("again", ["a", "b"], 14_000, 4_000);
    expect(() => twice.measure()).toThrow(/ambiguous\/duplicate integration attribution/);
  });

  it("rejects a makespan justified only by counting each batch once per member in ΣI", () => {
    const f = fixture(Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, durationMs: 10 })));
    for (let i = 0; i < 8; i++) f.verify(`t${i}`, 10);
    for (let i = 0; i < 4; i++) f.entry(`batch${i}`, [`t${2 * i}`, `t${2 * i + 1}`], 10 + i * 4_000, 4_000);
    const m = atBound(f);
    expect(m["ΣI_service"]).toBe(16_000);
    f.finish(1.3 * 32_000); // The forbidden per-member sum would accept this.
    expect(() => assertG8Bound(f.measure())).toThrow(/amended makespan bound exceeded/);
  });

  it("unions overlapping integration executions instead of summing their enclosing lifetimes", () => {
    const f = sharedBatch();
    const checks = f.rows.find(r => r.family === "service" && r.component === "checks" && r.action === "start");
    if (!checks || checks.family !== "service") throw new Error("missing fixture checks");
    f.span(checks, 11_500, 12_500); // Distinct repeated execution, inside the existing 11..13 s command.
    expect(f.measure()).toMatchObject({ CP_eff: 14_000, "ΣI_service": 4_000 });
  });

  it("unions concurrent entries globally and fails closed on service outside the makespan window", () => {
    const f = fixture([{ id: "a", durationMs: 10_000 }, { id: "b", durationMs: 10_000 }]);
    f.verify("a", 10_000); f.verify("b", 10_000);
    f.entry("a", ["a"], 10_000, 4_000); f.entry("b", ["b"], 12_000, 4_000);
    expect(f.measure()).toMatchObject({ CP_eff: 14_000, "ΣI_service": 6_000 });
    f.finish(15_999);
    expect(() => f.measure()).toThrow(/service outside makespan window/);
  });
});
