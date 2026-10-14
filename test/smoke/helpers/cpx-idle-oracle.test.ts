import { describe, expect, it } from "vitest";
import { createV2Observations, type ObservationValue } from "../../../src/compat/v2-observations";
import { assertG8IdleEpisodes, reconstructIdleEpisodes, type IdleFragment, type ObservationFile } from "./cpx-idle-oracle";

const BASE = Date.parse("2026-10-14T12:00:00.000Z");
type Task = { id: string; state: string; kind: string; phase: string | null; p50: number; slot: string | null;
  attempts: { n: number; callID: string | null; childSessionID: string | null; outcome: string | null }[] };
const task = (id = "a", extra: Partial<Task> = {}): Task => ({ id, state: "ready", kind: "task", phase: null, p50: 100, slot: null, attempts: [], ...extra });
type Slot = { slot: string; kind: string; state: string; taskId: string | null };
const slot = (state: string, taskId: string | null = null, name = "slot-1", kind = "task"): Slot => ({ slot: name, kind, state, taskId });
const fragment = (from: number, to: number): IdleFragment => ({ fromAt: new Date(BASE + from).toISOString(),
  toAt: new Date(BASE + to).toISOString(), ms: to - from, readyTaskIds: ["a"] });

/** Hand-authored wire rows, not the production scheduler or its idle metric implementation. */
function fixture(tasks = [task()], maxParallel = 4) {
  const rows: { at: number; family: "scheduler"; planId: string; parentSessionID: string; action: string; state: ObservationValue }[] = [];
  let ledger = { ledgerSeq: 1, status: "awaiting-approval", maxParallel, tasks, edges: [] as { from: string; to: string }[],
    phases: [] as { id: string; gate: string; paused: boolean }[], writeConflicts: [] };
  let idle = false;
  const inFlight = new Set<string>();
  const reservations = new Map<string, { token: string; attempt: number }>();
  const routed = new Set<string>();
  let tokenSequence = 0;
  let limit = maxParallel;
  let paused = false;
  const add = (action: string, ms: number, state: ObservationValue) => {
    rows.push({ at: BASE + ms, family: "scheduler", planId: "plan", parentSessionID: "parent", action, state: structuredClone(state) });
  };
  const runtime = (action: string, ms: number, detail: ObservationValue = null) => {
    add(action, ms, { clockMs: BASE + ms, ledgerSeq: ledger.ledgerSeq, orchIdle: idle, passive: false, recovering: false,
      disposed: action === "detach", latch: action === "detach", inFlight: [...inFlight], tokens: [], detail });
  };
  const query = (ms: number) => {
    const free = paused ? 0 : Math.max(0, limit - reservations.size);
    runtime("capacity-free", ms, { provider: "provider:fixture", heavy: false, free });
    runtime("capacity-free", ms, { provider: "provider:fixture", heavy: true, free: Math.min(free, 2) });
  };
  const routeTasks = (ms: number) => {
    for (const t of ledger.tasks) if (!routed.has(t.id) && t.kind !== "manual" && t.kind !== "preflight") {
      routed.add(t.id);
      runtime("route", ms, { taskId: t.id, provider: "provider:fixture", heavy: false });
      query(ms);
    }
  };
  const commit = (ms: number, change: Partial<typeof ledger>) => {
    ledger = { ...ledger, ...change, ledgerSeq: ledger.ledgerSeq + 1 };
    add("ledger", ms, ledger);
    routeTasks(ms);
  };
  const orchestrator = (ms: number, event: string) => {
    if (event === "step.started") idle = false;
    else if (event.startsWith("execution.")) idle = true;
    runtime("orchestrator", ms, { event });
  };
  const prepare = (ms: number, taskId = "a", attempt = 1) => {
    const token = `token-${++tokenSequence}`;
    reservations.set(taskId, { token, attempt });
    runtime("capacity-reserve", ms, { taskId, attempt, provider: "provider:fixture", heavy: false, token, force: false });
    inFlight.add(taskId);
    runtime("launch-prepare", ms, { taskId, attempt });
    runtime("launch-gate", ms, { ok: true, ready: [] }); // The selected set is NOT the durable ready set.
  };
  const release = (ms: number, taskId = "a") => {
    const held = reservations.get(taskId)!;
    reservations.delete(taskId);
    runtime("capacity-release", ms, { taskId, ...held, result: "other" });
  };
  const endStep = (ms: number, result: "launched" | "skipped", taskId = "a", attempt = 1) => {
    if (result === "skipped") release(ms, taskId);
    inFlight.delete(taskId);
    runtime("launch-step-end", ms, { taskId, attempt, result });
  };
  const launch = (ms: number, taskId = "a", attempt = 1) => runtime("launch", ms, { taskId, attempt, callID: "call", provider: "provider:fixture", heavy: false });
  let physical = { maxParallel, opened: true, closed: false, slots: [] as Slot[], corrupt: [] as string[] };
  const pool = (ms: number, action: string, change: Partial<typeof physical> = {}, detail: ObservationValue = null) => {
    physical = { ...physical, ...change };
    add(action, ms, { clockMs: BASE + ms, ...physical, detail });
  };
  const files = (): ObservationFile[] => {
    const wire = rows.map((row, i) => ({ ...row, v: 1, stream: "fixture", seq: i + 1 }));
    const end = { v: 1, stream: "fixture", seq: wire.length + 1, at: rows.at(-1)!.at, kind: "end",
      attempted: wire.length, written: wire.length, dropped: 0, failed: 0 };
    return [{ file: "fixture.jsonl", text: [...wire, end].map(row => JSON.stringify(row) + "\n").join("") }];
  };
  add("capacity-init", -3, { maxParallel, providers: [] });
  add("attach", -2, ledger);
  runtime("runtime-attach", -2);
  routeTasks(-2);
  commit(-1, { status: "running" });
  orchestrator(0, "execution.completed");
  return { rows, runtime, commit, orchestrator, prepare, endStep, launch, release, files, pool, raw: add, query,
    provider(ms: number, change: string, to = limit) {
      add("provider", ms, { provider: "provider:fixture", change, from: limit, to,
        until: change === "pause" ? new Date(BASE + ms + 1000).toISOString() : null });
      limit = to;
      if (change === "pause") paused = true;
      else if (change === "resume") paused = false;
    },
    get ledger() { return ledger; },
    identity: () => ({ planId: "plan", parentSessionID: "parent", finalLedgerSeq: ledger.ledgerSeq }),
    finish(ms: number) {
      for (const taskId of [...reservations.keys()]) release(ms, taskId);
      commit(ms, { status: "completed", tasks: ledger.tasks.map(t => ({ ...t, state: "done" })) });
      runtime("detach", ms);
    },
  };
}
const reconstruct = (f: ReturnType<typeof fixture>) => reconstructIdleEpisodes(f.files(), f.identity());
function changeWire(files: ObservationFile[], change: (rows: Record<string, unknown>[]) => void): ObservationFile[] {
  return files.map(file => {
    const rows = file.text.trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    change(rows);
    return { ...file, text: rows.map(row => JSON.stringify(row) + "\n").join("") };
  });
}

describe("G8 independent maximal idle episodes (no host)", () => {
  it("requires the deferred sink's disposal/close seal; flush alone cannot produce passing evidence", () => {
    const f = fixture();
    f.finish(1_000);
    const lines: string[] = [];
    let now = BASE;
    const sink = createV2Observations({ now: () => now, write: line => { lines.push(line); } });
    for (const row of f.rows) { now = row.at; sink.record(() => row); }
    const files = () => [{ file: "deferred.jsonl", text: lines.join("") }];
    expect(lines).toHaveLength(0);
    sink.flush();
    expect(() => reconstructIdleEpisodes(files(), f.identity())).toThrow(/incomplete observation stream/);
    sink.close(); // The v2 adapter awaits disposal and then invokes this synchronous drain+seal barrier.
    expect(reconstructIdleEpisodes(files(), f.identity()).episodes.map(e => e.ms)).toEqual([1_000]);
  });

  it("rejects an 11.3 s episode hidden by repeated slot-unavailable fragments smaller than 3 s", () => {
    const f = fixture([task()], 1);
    for (const [start, end] of [[2_700, 2_800], [5_500, 5_650], [8_400, 8_500]]) {
      f.prepare(start!);
      f.query(start!); // Physical provider free is now zero, but only a provisional reservation owns it.
      f.endStep(end!, "skipped"); // Reuses attempt #1: no child and no journaled attempt.
    }
    f.finish(11_300);
    const fragments = [fragment(0, 2_750), fragment(2_850, 5_600), fragment(5_700, 8_450), fragment(8_550, 11_300)];
    expect(fragments.every(f => f.ms < 3_000)).toBe(true);
    expect(fragments.reduce((sum, f) => sum + f.ms, 0)).toBe(11_000);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => e.ms)).toEqual([11_300]);
    expect(() => assertG8IdleEpisodes(episodes, fragments)).toThrow(/episode 11300 ms exceeds 10,000/);
  });

  it.each([10_000, 10_001])("enforces the exact %i ms episode boundary without needing any ledger metric", ms => {
    const f = fixture();
    f.finish(ms);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => e.ms)).toEqual([ms]);
    if (ms === 10_000) expect(() => assertG8IdleEpisodes(episodes, [])).not.toThrow();
    else expect(() => assertG8IdleEpisodes(episodes, [])).toThrow(/exceeds 10,000/);
  });

  it("reconciles a step's delayed closing tick without extending the independent episode", () => {
    const f = fixture();
    f.orchestrator(5_000, "step.started");
    f.runtime("schedule", 5_000);
    f.query(5_005); // The tick does asynchronous work before its launch gate/updateIdle.
    f.runtime("launch-gate", 5_010, { ok: false, ready: ["a"] });
    f.commit(5_011, {}); // The metric append becomes a committed graph swap afterwards.
    f.finish(6_000);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => [e.fromMs - BASE, e.toMs - BASE, e.ms])).toEqual([[0, 5_000, 5_000]]);
    expect(() => assertG8IdleEpisodes(episodes, [fragment(0, 5_010)])).not.toThrow();
    expect(() => assertG8IdleEpisodes(episodes, [fragment(0, 5_011)])).toThrow(/fragment outside reconstructed episodes/);
    expect(() => assertG8IdleEpisodes(episodes, [fragment(5_001, 5_010)])).toThrow(/fragment outside reconstructed episodes/);
  });

  it.each(["missing", "task-gate", "later-turn"])("rejects a delayed fragment with a %s closing tick", marker => {
    const f = fixture();
    f.orchestrator(5_000, "step.started");
    f.runtime("schedule", 5_000);
    if (marker === "task-gate") f.runtime("launch-gate", 5_010, { taskId: "a", attempt: 1, ok: false });
    if (marker === "later-turn") {
      f.orchestrator(5_005, "execution.completed");
      f.orchestrator(5_009, "step.started");
      f.runtime("launch-gate", 5_010, { ok: false, ready: ["a"] });
    }
    f.finish(6_000);
    expect(() => assertG8IdleEpisodes(reconstruct(f).episodes, [fragment(0, 5_010)])).toThrow(/fragment outside reconstructed episodes/);
  });

  it("reconciles a confirmed launch only at the end of its observed launch-step aggregate", () => {
    const f = fixture([task(), task("b")]);
    f.runtime("launch-gate", 4_000, { ok: true, ready: ["a", "b"] });
    f.prepare(4_000, "a");
    f.prepare(4_000, "b");
    f.commit(4_500, { tasks: [task("a", { state: "dispatched" }), task("b")] });
    f.launch(5_000, "a");
    f.endStep(5_005, "launched", "a");
    f.endStep(5_010, "skipped", "b");
    f.runtime("schedule", 5_010); // Scheduled after the aggregate's updateIdle call.
    f.finish(6_000);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[0, 5_000], [5_000, 6_000]]);
    expect(() => assertG8IdleEpisodes(episodes, [fragment(0, 5_010)])).not.toThrow();
    expect(() => assertG8IdleEpisodes(episodes, [fragment(0, 5_011)])).toThrow(/fragment outside reconstructed episodes/);
  });

  it.each(["route", "capacity-free", "both"])("fails closed on an 11,001 ms sealed interval missing %s evidence", missing => {
    const f = fixture();
    f.rows.splice(0, f.rows.length, ...f.rows.filter(row => !(row.action === "route" && missing !== "capacity-free")
      && !(row.action === "capacity-free" && missing !== "route")));
    f.finish(11_001);
    expect(() => assertG8IdleEpisodes(reconstruct(f).episodes, [])).toThrow(/unknown.*11001.*exceeds 10,000/i);
  });

  it.each([10_001, 6_000])("does not discard a %i ms unknown prefix when the first capacity query arrives", firstQuery => {
    const f = fixture();
    f.rows.splice(0, f.rows.length, ...f.rows.filter(row => row.action !== "capacity-free"));
    f.query(firstQuery);
    f.finish(11_001);
    expect(() => assertG8IdleEpisodes(reconstruct(f).episodes, [])).toThrow(/unknown.*11001.*exceeds 10,000/i);
  });

  it.each([1_000, 10_000])("allows a short %i ms unknown interval without guessing an eligible route", duration => {
    const f = fixture();
    f.rows.splice(0, f.rows.length, ...f.rows.filter(row => row.action !== "route" && row.action !== "capacity-free"));
    f.finish(duration);
    const { episodes } = reconstruct(f);
    expect(episodes).toEqual([]);
    expect(() => assertG8IdleEpisodes(episodes, [])).not.toThrow();
  });

  it("allows a short unknown prefix adjacent to an eligible span at the exact ceiling", () => {
    const f = fixture();
    f.rows.splice(0, f.rows.length, ...f.rows.filter(row => row.action !== "capacity-free"));
    f.query(4_000);
    f.finish(10_000);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[4_000, 10_000]]);
    expect(() => assertG8IdleEpisodes(episodes, [])).not.toThrow();
  });

  it("splits at a confirmed launch, not its reservation or provisional dispatched ledger swap", () => {
    const f = fixture([task("a"), task("b")]);
    f.prepare(3_000);
    f.commit(5_000, { tasks: [task("a", { state: "dispatched", attempts: [{ n: 1, callID: "call", childSessionID: null, outcome: null }] }), task("b")] });
    f.launch(6_000);
    f.endStep(6_500, "launched");
    f.finish(12_000);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => [e.fromMs - BASE, e.toMs - BASE, e.endedBy])).toEqual([[0, 6_000, "launch"], [6_000, 12_000, "plan-completed"]]);
    expect(() => assertG8IdleEpisodes(episodes, [fragment(0, 5_900), fragment(6_000, 12_000)])).not.toThrow();
    expect(() => assertG8IdleEpisodes(episodes, [fragment(5_900, 6_100)])).toThrow(/fragment outside reconstructed episodes/);
  });

  it("does not treat a throwing launch invocation (step result skipped) as a successful launch", () => {
    const f = fixture();
    f.prepare(3_000);
    f.commit(5_000, { tasks: [task("a", { state: "dispatched" })] });
    f.launch(5_500);
    f.commit(6_000, { tasks: [task()] });
    f.endStep(6_500, "skipped");
    f.finish(11_001);
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => e.ms)).toEqual([11_001]);
    expect(() => assertG8IdleEpisodes(episodes, [])).toThrow(/exceeds 10,000/);
  });

  it("does not split a failed preparation that journals a failure and requeues without launching", () => {
    const f = fixture();
    f.prepare(3_000);
    f.commit(5_000, { tasks: [task("a", { state: "failed", attempts: [{ n: 1, callID: "call", childSessionID: null, outcome: "failed" }] })] });
    f.commit(6_000, { tasks: [task()] });
    f.endStep(6_500, "skipped");
    f.finish(11_001);
    expect(reconstruct(f).episodes.map(e => e.ms)).toEqual([11_001]);
  });

  it("retains a QA task's provisional admission until its launch", () => {
    const f = fixture([task("qa", { kind: "qa", phase: null })]);
    f.commit(100, { tasks: [task("qa", { kind: "qa", phase: "phase" })], phases: [{ id: "phase", gate: "awaiting-qa", paused: false }] });
    f.prepare(200, "qa");
    f.commit(300, { tasks: [task("qa", { kind: "qa", phase: "phase", state: "dispatched" })], phases: [{ id: "phase", gate: "qa-running", paused: false }] });
    f.launch(400, "qa");
    f.endStep(450, "launched", "qa");
    f.finish(500);
    expect(reconstruct(f).episodes.map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[100, 400]]);
  });

  it("uses raw dependencies and phase gates, not launch-gate.ready; excludes manual/preflight", () => {
    const f = fixture([task("manual", { kind: "manual" }), task("preflight", { kind: "preflight" })]);
    f.commit(100, { tasks: [task("a", { phase: "phase" }), task("dep", { state: "pending" })],
      edges: [{ from: "dep", to: "a" }, { from: "gate:gate", to: "a" }],
      phases: [{ id: "phase", gate: "pending", paused: true }, { id: "gate", gate: "pending", paused: false }] });
    f.runtime("launch-gate", 200, { ready: ["a"], ok: true }); // A lying derived list cannot open an episode.
    f.commit(300, { tasks: [task("a", { phase: "phase" }), task("dep", { state: "done" })] });
    f.commit(400, { phases: [{ id: "phase", gate: "pending", paused: false }, { id: "gate", gate: "pending", paused: false }] });
    f.commit(500, { phases: [{ id: "phase", gate: "pending", paused: false }, { id: "gate", gate: "passed", paused: false }] });
    f.runtime("launch-gate", 600, { ready: [], ok: false }); // Nor can a selected-set gap close one.
    f.finish(1_000);
    expect(reconstruct(f).episodes.map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[500, 1_000]]);
  });

  it("closes on a real step, pause and genuinely empty ready set, and reopens only when eligible", () => {
    const f = fixture();
    f.orchestrator(100, "step.started");
    f.orchestrator(200, "execution.completed");
    f.commit(300, { status: "paused" });
    f.commit(400, { status: "running" });
    f.commit(500, { tasks: [task("a", { state: "parked" })] });
    f.commit(600, { tasks: [task()] });
    f.finish(700);
    expect(reconstruct(f).episodes.map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[0, 100], [200, 300], [400, 500], [600, 700]]);
  });

  it("asserts A across physical blockage; only the real pool swap to ready makes B launchable", () => {
    const f = fixture([task(), task("b", { state: "done", slot: "slot-1" })], 1);
    f.pool(0, "slot-pool-open", { slots: [slot("leased", "b")] });
    f.prepare(100);
    f.query(100);
    f.pool(150, "slot-acquire-start", {}, { kind: "task", taskId: "a" });
    f.pool(175, "slot-acquire-result", {}, { slot: null, kind: "task", taskId: "a", mode: null, result: "unavailable" });
    f.endStep(200, "skipped"); // Provider release does not release the physical slot.
    f.commit(300, { tasks: [task(), task("b", { state: "done", slot: null })] });
    f.raw("lease-release", 400, { taskRef: "plan:plan:b" });
    f.pool(450, "slot-state", { slots: [slot("resetting", "b")] }, { slot: "slot-1" });
    f.pool(500, "slot-release-start", {}, { slot: "slot-1" });
    f.pool(600, "slot-release-complete", {}, { slot: "slot-1", result: "unchanged" });
    f.pool(700, "slot-reset-start", {}, { slot: "slot-1" });
    f.pool(800, "slot-state", { slots: [slot("leased", "b")] }, { slot: "slot-1" });
    f.pool(800, "slot-reset-end", {}, { slot: "slot-1", result: "completed" });
    f.pool(850, "slot-release-start", {}, { slot: "slot-1" });
    f.pool(900, "slot-release-failed", {}, { slot: "slot-1" });
    f.pool(11_000, "slot-state", { slots: [slot("ready")] }, { slot: "slot-1" });
    f.pool(11_000, "slot-release-complete", {}, { slot: "slot-1", result: "released" });
    f.finish(11_001);
    const oracle = reconstruct(f);
    expect(oracle.predicate).toBe("A: provider-capacity");
    expect(oracle.episodes.map(e => e.ms)).toEqual([11_001]);
    expect(oracle.episodes[0]!.slotDiagnostics.map(s => [s.status, s.ms])).toEqual([["slot-blocked", 11_000], ["launchable", 1]]);
    expect(() => assertG8IdleEpisodes(oracle.episodes, [fragment(0, 11_001)])).toThrow(/exceeds 10,000/);
  });

  it("splits B at claim/preparation and physical completion without fragmenting A", () => {
    const f = fixture([task()], 1);
    f.pool(0, "slot-pool-open", { slots: [slot("ready")] });
    f.prepare(100);
    f.pool(100, "slot-state", { slots: [slot("resetting", "a")] }, { slot: "slot-1" });
    f.pool(100, "slot-claim", {}, { slot: "slot-1", kind: "task", taskId: "a", mode: "reset" });
    f.pool(200, "slot-reset-start", {}, { slot: "slot-1" });
    f.pool(300, "slot-state", { slots: [slot("provisioning", "a")] }, { slot: "slot-1" });
    f.pool(300, "slot-provision-start", {}, { slot: "slot-1" });
    f.pool(400, "slot-provision-end", {}, { slot: "slot-1", result: "completed" });
    f.pool(500, "slot-state", { slots: [slot("leased", "a")] }, { slot: "slot-1" });
    f.pool(500, "slot-acquire-result", {}, { slot: "slot-1", kind: "task", taskId: "a", mode: "reset", result: "reused" });
    f.endStep(600, "skipped");
    f.finish(1_000);
    f.pool(1_000, "slot-pool-close", { closed: true });
    const { episodes } = reconstruct(f);
    expect(episodes.map(e => e.ms)).toEqual([1_000]);
    expect(episodes[0]!.slotDiagnostics.map(s => [s.status, s.ms])).toEqual([["launchable", 100], ["slot-blocked", 400], ["launchable", 500]]);
    expect(episodes[0]!.slotDiagnostics.reduce((sum, s) => sum + s.ms, 0)).toBe(episodes[0]!.ms);
  });

  it.each(["creating", "provisioning", "resetting", "leased"])("a %s slot owned by someone else occupies the physical cap", state => {
    const f = fixture([task()], 1);
    f.pool(0, "slot-pool-open", { slots: [slot(state, "other")] });
    f.finish(100);
    expect(reconstruct(f).episodes[0]!.slotDiagnostics.map(s => s.status)).toEqual(["slot-blocked"]);
  });

  it("keeps missing facts and creation/replacement room unknown, excluding special and retired slots from the cap", () => {
    const f = fixture([task()], 1);
    f.pool(100, "slot-pool-open", { slots: [slot("leased", null, "ci", "ci"), slot("leased", null, "integration", "integration"), slot("retired")] });
    f.pool(200, "slot-state", { slots: [slot("broken")] }, { slot: "slot-1" });
    f.pool(300, "slot-state", { slots: [], corrupt: ["slot-1"] }, { slot: "slot-1" });
    f.finish(400);
    const spans = reconstruct(f).episodes[0]!.slotDiagnostics;
    expect(spans.every(s => s.status === "slot-unknown")).toBe(true);
    expect(spans.map(s => s.reason)).toEqual(["no opened pool snapshot", "creation/replacement within cap; physical claim unproven", "creation/replacement unproven; corrupt markers present"]);
    expect(spans.reduce((sum, s) => sum + s.ms, 0)).toBe(400);
  });

  it("provider exhaustion after a genuine launch, and pause/resume, are A boundaries", () => {
    const f = fixture([task(), task("b")], 1);
    f.prepare(100);
    f.commit(200, { tasks: [task("a", { state: "dispatched" }), task("b")] });
    f.launch(300);
    f.endStep(400, "launched");
    f.query(500);
    f.release(1_000);
    f.provider(1_100, "pause");
    f.query(1_200);
    f.provider(1_300, "resume");
    f.finish(1_500);
    expect(reconstruct(f).episodes.filter(e => e.ms > 0).map(e => [e.fromMs - BASE, e.toMs - BASE])).toEqual([[0, 300], [1_000, 1_100], [1_300, 1_500]]);
  });

  it("fails closed on malformed slot snapshots, unknown slot actions, and inconsistent provider queries", () => {
    const f = fixture();
    f.pool(100, "slot-pool-open", { slots: [slot("ready")] });
    f.finish(200);
    for (const change of [
      (rows: Record<string, unknown>[]) => { rows.find(r => r.action === "slot-pool-open")!.state = { clockMs: BASE + 100 }; },
      (rows: Record<string, unknown>[]) => { rows.find(r => r.action === "slot-pool-open")!.action = "slot-invented"; },
      (rows: Record<string, unknown>[]) => {
        const row = rows.find(r => r.action === "capacity-free")!;
        const state = row.state as Record<string, unknown>;
        state.detail = { provider: "provider:fixture", heavy: false, free: 999 };
      },
    ]) expect(() => reconstructIdleEpisodes(changeWire(f.files(), change), f.identity())).toThrow(/G8 observations/);
  });

  it.each(["dropped", "failed", "gap", "missing-end", "truncated"])("fails closed on a %s observation stream", fault => {
    const f = fixture();
    f.finish(1_000);
    const files = fault === "truncated" ? f.files().map(file => ({ ...file, text: file.text.slice(0, -8) }))
      : changeWire(f.files(), rows => {
        if (fault === "gap") rows[1]!.seq = 99;
        else if (fault === "missing-end") rows.pop();
        else rows.at(-1)![fault] = 1;
      });
    expect(() => reconstructIdleEpisodes(files, f.identity())).toThrow(/observation|truncated/);
  });

  it("checks every adapter file, not just the stream containing the plan", () => {
    const f = fixture();
    f.finish(1_000);
    const unrelated = { file: "other.jsonl", text: JSON.stringify({ v: 1, stream: "other", seq: 1, at: BASE,
      kind: "end", attempted: 0, written: 0, dropped: 1, failed: 0 }) + "\n" };
    expect(() => reconstructIdleEpisodes([...f.files(), unrelated], f.identity())).toThrow(/incomplete observation stream/);
  });

  it.each(["capacity-open", "graph-open", "runtime-open", "runtime-close", "step-open", "step-close", "launch", "orchestrator"])("rejects missing %s even in a sealed, contiguous stream", missing => {
    const f = fixture();
    f.prepare(100);
    f.launch(200);
    f.endStep(300, "launched");
    f.finish(1_000);
    const action = { "capacity-open": "capacity-init", "graph-open": "attach", "runtime-open": "runtime-attach", "runtime-close": "detach", "step-open": "launch-prepare",
      "step-close": "launch-step-end", launch: "launch", orchestrator: "orchestrator" }[missing];
    f.rows.splice(f.rows.findIndex(row => row.action === action), 1);
    expect(() => reconstruct(f)).toThrow(/missing|attachment/);
  });

  it("rejects missing streams, missing completed state, and uncovered or malformed ledger fragments", () => {
    const f = fixture();
    expect(() => reconstructIdleEpisodes([], f.identity())).toThrow(/missing observation files/);
    f.finish(1_000);
    const { episodes } = reconstruct(f);
    expect(() => reconstructIdleEpisodes(f.files(), { ...f.identity(), finalLedgerSeq: 999 })).toThrow(/missing completed/);
    expect(() => reconstructIdleEpisodes(f.files(), { ...f.identity(), finalLedgerSeq: 1 })).toThrow(/missing ledger tail/);
    expect(() => assertG8IdleEpisodes(episodes, [fragment(-1, 100)])).toThrow(/fragment outside/);
    expect(() => assertG8IdleEpisodes(episodes, [{ ...fragment(0, 1_000), ms: 1 }])).toThrow(/invalid ledger idle fragment/);
    expect(() => assertG8IdleEpisodes([], [fragment(0, 1_000)])).toThrow(/fragment outside/);
  });

  it("rejects an idle transition whose runtime payload is missing instead of silently skipping it", () => {
    const f = fixture();
    f.orchestrator(500, "step.started");
    f.finish(1_000);
    const files = changeWire(f.files(), rows => {
      const row = rows.find(row => row.action === "orchestrator" && row.at === BASE + 500)!;
      row.state = { ledgerSeq: 2, orchIdle: false, detail: { event: "step.started" } };
    });
    expect(() => reconstructIdleEpisodes(files, f.identity())).toThrow(/invalid timestamp/);
  });
});
