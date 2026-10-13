// Phase 4.2 task 4.2.3: QaLoop (src/executor/qa-loop.ts). Pure parts are tested directly; the loop itself runs against the real
// LedgerStore in a temp dir with doubles for the Waker and the Clock.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedgerStore } from "../../src/executor/ledger.js";
import {
  createQaLoop, decideRound, extractFindingsText, groupFindings, normalizeFindingPath, parseFindings,
  type QaDecision,
} from "../../src/executor/qa-loop.js";
import {
  canonicalFindingsJson, ExecutorError, fixTaskId, FINDINGS_FORMAT, FIX_TASKS_PER_ROUND_LIMIT, QA_ROUND_LIMIT, reviewTaskId,
  type ExecutorEventInput, type Finding, type FindingsReport, type LedgerV1, type LedgerWriter, type PhaseRecord, type TaskNode,
  type WakeReason,
} from "../../src/executor/types.js";
import { FakeClock, FakeProc } from "../fixtures/cpx/ledger/fakes.js";
import { buildDraft, holderOf, nonceFor, PLAN_ID, T0, taskNode } from "../fixtures/cpx/ledger/builders.js";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function f(id: string, severity: Finding["severity"], files: string[] = [`src/${id.toLowerCase()}.ts`]): Finding {
  return { id, severity, files, problem: `problem ${id}`, fix: `fix ${id}` };
}

const report = (...findings: Finding[]): FindingsReport => ({ findings });
const fence = (r: FindingsReport): string => `review text\n\`\`\`json\n${canonicalFindingsJson(r)}\n\`\`\`\n`;

describe("parse", () => {
  const a = report(f("A1", "major", ["a.ts"]));
  const b = report(f("B1", "nit", ["b.ts"]));

  it("takes the last json fence", () => {
    const text = `x\n\`\`\`json\n${canonicalFindingsJson(a)}\n\`\`\`\ny\n\`\`\`json\n${canonicalFindingsJson(b)}\n\`\`\`\nbye`;
    const r = parseFindings(text);
    expect(r).toEqual({ ok: true, report: b });
    expect(extractFindingsText(text)).toBe(`${canonicalFindingsJson(b)}\n`);
  });

  it("parses the whole text when there is no fence", () => {
    expect(parseFindings(canonicalFindingsJson(a))).toEqual({ ok: true, report: a });
    expect(parseFindings(`\n  ${canonicalFindingsJson(a)}  \n`)).toEqual({ ok: true, report: a });
  });

  it("round-trips canonicalFindingsJson", () => {
    const r = report(f("A1", "blocking", ["a.ts", "b.ts"]), f("A2", "nit", []));
    expect(parseFindings(canonicalFindingsJson(r))).toEqual({ ok: true, report: r });
    expect(parseFindings(fence(r))).toEqual({ ok: true, report: r });
  });

  it("reports bad JSON", () => {
    const r = parseFindings("```json\n{ nope\n```");
    expect(r.ok).toBe(false);
    const prose = parseFindings("looks good to me");
    expect(prose.ok).toBe(false);
  });

  it("reports each schema violation", () => {
    const base = { id: "A1", severity: "major", files: ["a.ts"], problem: "p", fix: "x" };
    const bad: unknown[] = [
      [],
      { findings: "x" },
      { findings: [], extra: 1 },
      { findings: [{ ...base, id: "" }] },
      { findings: [{ ...base, id: "-a" }] },
      { findings: [{ ...base, severity: "huge" }] },
      { findings: [{ ...base, files: "a.ts" }] },
      { findings: [{ ...base, files: [""] }] },
      { findings: [{ ...base, files: [1] }] },
      { findings: [{ ...base, problem: "" }] },
      { findings: [{ ...base, fix: 1 }] },
      { findings: [{ ...base, extra: 1 }] },
      { findings: [{ id: "A1", severity: "major", files: [], problem: "p" }] },
    ];
    for (const v of bad) expect(parseFindings(JSON.stringify(v)).ok, JSON.stringify(v)).toBe(false);
    expect(parseFindings(JSON.stringify({ findings: [base] })).ok).toBe(true);
    expect(parseFindings(JSON.stringify({ findings: [] })).ok).toBe(true);
    expect(FINDINGS_FORMAT.required).toEqual(["findings"]);
  });

  it("bounds the error to 500 characters", () => {
    const r = parseFindings(`{${"x".repeat(5000)}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeLessThanOrEqual(500);
    const long = parseFindings(JSON.stringify({ findings: [{ id: "A1", severity: "major", files: ["a"], problem: "p", fix: "f", ["z".repeat(2000)]: 1 }] }));
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error.length).toBeLessThanOrEqual(500);
  });
});

describe("grouping", () => {
  it("normalises paths", () => {
    expect(normalizeFindingPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeFindingPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeFindingPath("././a.ts")).toBe("a.ts");
    expect(normalizeFindingPath("/abs/a.ts")).toBeNull();
    expect(normalizeFindingPath("C:\\abs\\a.ts")).toBeNull();
    expect(normalizeFindingPath("../a.ts")).toBeNull();
    expect(normalizeFindingPath("src/../a.ts")).toBeNull();
    expect(normalizeFindingPath("")).toBeNull();
    expect(normalizeFindingPath(".")).toBeNull();
  });

  it("merges findings that share a file, transitively", () => {
    const g = groupFindings([f("A", "major", ["a.ts", "b.ts"]), f("B", "major", ["b.ts", "c.ts"]), f("C", "major", ["z.ts"]), f("D", "minor", ["./c.ts"])]);
    expect(g.map((x) => x.writes)).toEqual([["a.ts", "b.ts", "c.ts"], ["z.ts"]]);
    expect(g[0]?.findings.map((x) => x.id)).toEqual(["A", "B", "D"]);
  });

  it("orders components by smallest path, so k is deterministic", () => {
    const input = [f("A", "major", ["m.ts"]), f("B", "major", ["a.ts"]), f("C", "major", ["x.ts", "b.ts"])];
    const one = groupFindings(input).map((x) => x.writes);
    const two = groupFindings([...input].reverse()).map((x) => x.writes);
    expect(one).toEqual([["a.ts"], ["b.ts", "x.ts"], ["m.ts"]]);
    expect(two).toEqual(one);
  });

  it("puts findings without a usable file into one extra last group with no writes", () => {
    const g = groupFindings([f("A", "major", []), f("B", "major", ["/etc/passwd"]), f("C", "major", ["../x"]), f("D", "major", ["a.ts"])]);
    expect(g).toHaveLength(2);
    expect(g[0]?.writes).toEqual(["a.ts"]);
    expect(g[1]?.writes).toEqual([]);
    expect(g[1]?.findings.map((x) => x.id)).toEqual(["A", "B", "C"]);
  });

  it("fuzz: group writes are pairwise disjoint and every finding lands in exactly one group", () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 200; round++) {
      const findings: Finding[] = [];
      const n = 1 + rnd(25);
      for (let i = 0; i < n; i++) {
        const files: string[] = [];
        for (let j = rnd(4); j > 0; j--) files.push(["", "./", "src\\"][rnd(3)] + `f${rnd(12)}.ts`);
        findings.push(f(`F${i}`, "major", files));
      }
      const groups = groupFindings(findings);
      const seen = new Set<string>();
      for (const g of groups) {
        for (const w of g.writes) {
          expect(seen.has(w), `${w} in two groups`).toBe(false);
          seen.add(w);
        }
      }
      expect(groups.flatMap((g) => g.findings.map((x) => x.id)).sort()).toEqual(findings.map((x) => x.id).sort());
      expect(groupFindings(findings)).toEqual(groups);
    }
  });

  it("merges the overflow beyond 999 groups into the last one", () => {
    const many = Array.from({ length: 1005 }, (_, i) => f(`F${i}`, "major", [`d/f${String(i).padStart(4, "0")}.ts`]));
    const g = groupFindings(many);
    expect(g).toHaveLength(FIX_TASKS_PER_ROUND_LIMIT);
    expect(g[g.length - 1]?.writes).toHaveLength(7);
    expect(g.flatMap((x) => x.findings)).toHaveLength(1005);
    const withFileless = groupFindings([...many, f("X", "major", [])]);
    expect(withFileless).toHaveLength(FIX_TASKS_PER_ROUND_LIMIT);
    expect(withFileless[withFileless.length - 1]?.writes).toEqual([]);
  });
});

describe("decideRound (Q4)", () => {
  const none = report();
  const minor = report(f("M1", "minor"), f("N1", "nit"));
  const major = report(f("J1", "major"), f("M1", "minor"));
  const kinds = (r: FindingsReport, round: number, max: number): QaDecision["kind"] => decideRound(r, round, max).kind;

  it("no findings always pass", () => {
    for (let max = 1; max <= 4; max++) for (let r = 1; r <= max; r++) expect(kinds(none, r, max)).toBe("clean");
  });

  it("only minor/nit: next round while r <= 2 and r < max, else pass with the findings deferred", () => {
    for (let max = 1; max <= 4; max++) {
      for (let r = 1; r <= max; r++) {
        const d = decideRound(minor, r, max);
        if (r <= 2 && r < max) {
          expect(d.kind, `max ${max} r ${r}`).toBe("next-round");
          if (d.kind === "next-round") expect(d.deferred).toEqual([]);
        } else {
          expect(d.kind, `max ${max} r ${r}`).toBe("clean");
          if (d.kind === "clean") expect(d.deferred).toEqual(minor.findings);
        }
      }
    }
  });

  it("blocking/critical/major: next round below the cap, cap at r >= max", () => {
    for (let max = 1; max <= 4; max++) {
      for (let r = 1; r <= max; r++) {
        const d = decideRound(major, r, max);
        if (r >= max) {
          expect(d.kind, `max ${max} r ${r}`).toBe("cap");
          if (d.kind === "cap") expect(d.remaining).toEqual(major.findings);
        } else if (r <= 2) {
          expect(d.kind).toBe("next-round");
          if (d.kind === "next-round") {
            expect(d.deferred).toEqual([]);
            expect(d.groups.flatMap((g) => g.findings.map((x) => x.id)).sort()).toEqual(["J1", "M1"]);
          }
        } else {
          expect(d.kind).toBe("next-round");
          if (d.kind === "next-round") {
            expect(d.groups.flatMap((g) => g.findings.map((x) => x.id))).toEqual(["J1"]);
            expect(d.deferred.map((x) => x.id)).toEqual(["M1"]);
          }
        }
      }
    }
  });

  it("every blocking severity counts", () => {
    for (const s of ["blocking", "critical", "major"] as const) expect(kinds(report(f("A", s)), 1, 3)).toBe("next-round");
    for (const s of ["minor", "nit"] as const) expect(kinds(report(f("A", s)), 3, 4)).toBe("clean");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The loop against the real ledger
// ---------------------------------------------------------------------------------------------------------------

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
}, 60_000);

const PHASE = "p1";
const QA1 = "p1.QA";

interface Env {
  writer: LedgerWriter;
  loop: ReturnType<typeof createQaLoop>;
  wakes: Array<{ reason: WakeReason; key: string }>;
  warnings: string[];
  failWake: { on: boolean };
  qaId: string;
  /** Event types journaled after `seq` `after` (default: since the ledger was created), in order. */
  types(after?: number): Promise<string[]>;
  ledger(): Readonly<LedgerV1>;
  phase(): Readonly<PhaseRecord>;
  task(id: string): Readonly<TaskNode>;
}

interface Setup {
  max?: number;
  report?: FindingsReport;
  gate?: PhaseRecord["gate"];
  template?: boolean;
  paused?: boolean;
  qaPatch?: Partial<TaskNode>;
  round?: number;
}

function qaDone(id: string, context: string, patch: Partial<TaskNode> = {}): TaskNode {
  return taskNode(id, {
    phase: PHASE, kind: "qa", state: "done", text: "review the phase", footprint: { writes: [], reads: [], confidence: "explicit", sources: ["path"] },
    route: { line: "class=review d=none tier=heavy pin root=C:/repo", role: "review", tier: "heavy", pin: true },
    attempts: [{ n: 1, nonce: nonceFor(900), callID: null, childSessionID: "ses-qa", startedAt: T0, endedAt: T0, outcome: "succeeded", verdict: null, context }],
    ...patch,
  });
}

async function setup(o: Setup = {}): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "omr-qa-loop-"));
  roots.push(root);
  const clock = new FakeClock();
  const proc = new FakeProc(100, "host-a");
  const store = createLedgerStore({ home: join(root, "omr-executor"), clock, proc, warn: () => undefined, heartbeatMs: 10_000, staleMs: 60_000, snapshotEvery: 200 });
  const draft = buildDraft(0);
  draft.config.qaMaxRounds = o.max ?? 3;
  const ph = draft.phases[0] as PhaseRecord;
  ph.id = PHASE;
  ph.gate = o.gate ?? "qa-running";
  ph.paused = o.paused ?? false;
  const round = o.round ?? 1;
  ph.qaRound = round;
  const qaId = round === 1 ? QA1 : reviewTaskId(PHASE, round);
  draft.tasks["p1.T1"] = taskNode("p1.T1", { phase: PHASE, state: "integrated", integrated: { from: "a".repeat(40), to: "b".repeat(40) } });
  draft.tasks[qaId] = qaDone(qaId, canonicalFindingsJson(o.report ?? report()), o.qaPatch);
  draft.edges.push({ from: "p1.T1", to: qaId, kind: "structural", confidence: "high", evidence: "phase" });
  if (o.template === true) {
    draft.tasks["p1.FIX"] = taskNode("p1.FIX", {
      phase: PHASE, kind: "fix", state: "done", acceptance: "check: testsPass", verify: "deferred",
      route: { line: "class=implement d=deterministic tier=heavy pin root=C:/tmpl", role: "implement", tier: "heavy", pin: true },
    });
  }
  const writer = await store.create(draft, holderOf("ses-0", proc.pid, proc.hostname, clock.iso()));
  const wakes: Env["wakes"] = [];
  const warnings: string[] = [];
  const failWake = { on: false };
  const loop = createQaLoop({
    writer, clock,
    log: { warn: (m) => { warnings.push(m); } },
    waker: {
      wake: async (reason, key) => {
        if (failWake.on) throw new Error("wake down");
        wakes.push({ reason, key });
        return "sent";
      },
    },
  });
  return {
    writer, loop, wakes, warnings, failWake, qaId,
    types: async (after = 1) => (await store.exportPlan(PLAN_ID)).events.filter((e) => e.seq > after).map((e) => e.type),
    ledger: () => writer.ledger,
    phase: () => writer.ledger.phases.find((p) => p.id === PHASE) as PhaseRecord,
    task: (id) => writer.ledger.tasks[id] as TaskNode,
  };
}

async function failure(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected an ExecutorError");
}

let nonceSeq = 1000;

/** Drives the pending qa task `id` of the phase to done with `context`, the gate to qa-running (QA3, QA5). */
async function runQa(env: Env, id: string, context: string): Promise<void> {
  const w = env.writer;
  if (env.phase().gate === "pending") {
    await w.append([{ type: "gate-changed", phaseId: PHASE, from: "pending", to: "awaiting-qa", trigger: "phase-integrated", qaRound: env.phase().qaRound }]);
  }
  const q = env.task(id);
  if (q.state === "pending") await w.append([{ type: "task-transition", taskId: id, from: "pending", to: "ready", trigger: "deps-satisfied", detail: null }]);
  const attempt = { n: 1, nonce: nonceFor(nonceSeq++), callID: null, childSessionID: null, startedAt: T0, endedAt: null, outcome: null, verdict: null, context: "" };
  await w.append([
    { type: "attempt-started", taskId: id, attempt },
    { type: "task-transition", taskId: id, from: "ready", to: "dispatched", trigger: "launch", detail: null },
    { type: "gate-changed", phaseId: PHASE, from: "awaiting-qa", to: "qa-running", trigger: "qa-dispatched", qaRound: env.phase().qaRound },
    { type: "task-slot", taskId: id, slot: "slot-1", branch: `omr/${PLAN_ID}/t/${id}` },
  ]);
  await w.append([
    { type: "attempt-child", taskId: id, n: 1, childSessionID: `ses-${id}` },
    { type: "task-transition", taskId: id, from: "dispatched", to: "running", trigger: "child-created", detail: null },
  ]);
  await w.append([
    { type: "attempt-ended", taskId: id, n: 1, outcome: "succeeded", endedAt: T0, detail: null },
    { type: "attempt-context", taskId: id, n: 1, context },
    { type: "task-transition", taskId: id, from: "running", to: "completed", trigger: "child-ended", detail: null },
    { type: "task-transition", taskId: id, from: "completed", to: "done", trigger: "no-changes", detail: null },
    { type: "task-slot", taskId: id, slot: null, branch: null },
  ] satisfies ExecutorEventInput[]);
}

const fixIds = (env: Env, round: number): string[] => Object.keys(env.ledger().tasks).filter((id) => id.startsWith(`${PHASE}.FIX${round}-`));
const caps = (env: Env): LedgerV1["inbox"] => env.ledger().inbox.filter((i) => i.kind === "qa-cap");

describe("onQaResult: pass", () => {
  it("no findings: qa-clean, the gate passes, nothing else is written", async () => {
    const env = await setup();
    expect(await env.loop.onQaResult(env.qaId, report())).toBe("passed");
    expect(env.phase().gate).toBe("passed");
    expect(env.phase().qaRound).toBe(1);
    expect(await env.types()).toEqual(["gate-changed"]);
    expect(env.ledger().inbox).toEqual([]);
    expect(env.wakes).toEqual([]);
  });

  it("only minor/nit at the cap: passes, the findings are recorded as closed deferred info items (X8), IA before G", async () => {
    const env = await setup({ max: 1 });
    const r = report(f("M1", "minor", ["a.ts"]), f("N1", "nit", ["b.ts", "c.ts"]));
    expect(await env.loop.onQaResult(env.qaId, r)).toBe("passed");
    expect(await env.types()).toEqual(["inbox-added", "inbox-added", "gate-changed"]);
    expect(env.ledger().inbox).toMatchObject([
      { id: "R-1", kind: "qa-cap", severity: "info", taskId: env.qaId, answer: "deferred", options: [], text: "deferred minor M1: problem M1 [a.ts]" },
      { id: "R-2", kind: "qa-cap", severity: "info", taskId: env.qaId, answer: "deferred", text: "deferred nit N1: problem N1 [b.ts, c.ts]" },
    ]);
    expect(env.wakes).toEqual([]);
    expect(env.phase().gate).toBe("passed");
  });

  it("round 3 with only minor/nit passes with them deferred even below the cap", async () => {
    const env = await setup({ max: 4, round: 3 });
    expect(await env.loop.onQaResult(env.qaId, report(f("M1", "minor")))).toBe("passed");
    expect(caps(env)).toHaveLength(1);
    expect(env.phase()).toMatchObject({ gate: "passed", qaRound: 3 });
  });

  it("round 1 below the cap with only minor/nit fixes them all", async () => {
    const env = await setup({ max: 3 });
    expect(await env.loop.onQaResult(env.qaId, report(f("M1", "minor"), f("N1", "nit")))).toBe("next-round");
    expect(fixIds(env, 1)).toHaveLength(2);
    expect(caps(env)).toEqual([]);
  });

  it("long deferred text is bounded", async () => {
    const env = await setup({ max: 1 });
    const big = { ...f("M1", "minor"), problem: "p".repeat(6000) };
    await env.loop.onQaResult(env.qaId, report(big));
    const text = caps(env)[0]?.text ?? "";
    expect(text.length).toBe(4001);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("onQaResult: next round", () => {
  const findings = report(f("A1", "major", ["src/a.ts"]), f("A2", "minor", ["src/a.ts", "src/b.ts"]), f("C1", "critical", ["src/c.ts"]), f("D1", "blocking", []));

  it("round 1: gate pending with qaRound 2, fix tasks per component, a re-review task, edges; batch order G, TC.., EA.., IA", async () => {
    const env = await setup({ max: 3 });
    expect(await env.loop.onQaResult(env.qaId, findings)).toBe("next-round");
    expect(env.phase()).toMatchObject({ gate: "pending", qaRound: 2, paused: false });
    expect(await env.types()).toEqual([
      "gate-changed", "task-created", "task-created", "task-created", "task-created", "edge-added", "edge-added", "edge-added", "edge-added", "edge-added",
    ]);
    expect(fixIds(env, 1)).toEqual([fixTaskId(PHASE, 1, 1), fixTaskId(PHASE, 1, 2), fixTaskId(PHASE, 1, 3)]);
    const [k1, k2, k3] = fixIds(env, 1).map((id) => env.task(id));
    expect(k1?.footprint.writes).toEqual(["src/a.ts", "src/b.ts"]);
    expect(k2?.footprint.writes).toEqual(["src/c.ts"]);
    expect(k3?.footprint.writes).toEqual([]);
    for (const t of [k1, k2, k3]) {
      expect(t).toMatchObject({ kind: "fix", phase: PHASE, state: "pending", attempts: [], slot: null });
    }
    expect(JSON.parse(k1?.text.slice(k1.text.indexOf("{")) ?? "{}")).toEqual({ findings: [f("A1", "major", ["src/a.ts"]), f("A2", "minor", ["src/a.ts", "src/b.ts"])] });
    const review = env.task(reviewTaskId(PHASE, 2));
    expect(review).toMatchObject({ kind: "qa", phase: PHASE, state: "pending", id: "p1.QA2" });
    expect(review.text).toContain(canonicalFindingsJson(findings));
    const edgesTo = (to: string): string[] => env.ledger().edges.filter((e) => e.to === to).map((e) => e.from).sort();
    expect(edgesTo("p1.QA2")).toEqual(fixIds(env, 1));
    expect(edgesTo(k3?.id ?? "")).toEqual([k1?.id, k2?.id]);
  });

  it("fix tasks of one round have pairwise disjoint writes", async () => {
    const env = await setup({ max: 3 });
    const many = report(
      f("A", "major", ["a.ts", "b.ts"]), f("B", "major", ["b.ts", "c.ts"]), f("C", "major", ["d.ts"]), f("D", "major", ["e.ts", "d.ts"]),
      f("E", "major", ["f.ts"]), f("F", "minor", ["f.ts", "z.ts"]),
    );
    await env.loop.onQaResult(env.qaId, many);
    const seen = new Set<string>();
    for (const id of fixIds(env, 1)) for (const w of env.task(id).footprint.writes) {
      expect(seen.has(w)).toBe(false);
      seen.add(w);
    }
    expect([...seen].sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "z.ts"]);
  });

  it("round 3 fixes blocking/critical/major only and defers minor/nit (batch order G, TC, EA, IA)", async () => {
    const env = await setup({ max: 4, round: 3 });
    const r = report(f("J1", "major", ["a.ts"]), f("M1", "minor", ["b.ts"]), f("N1", "nit", ["a.ts"]));
    expect(await env.loop.onQaResult(env.qaId, r)).toBe("next-round");
    expect(env.phase()).toMatchObject({ gate: "pending", qaRound: 4 });
    expect(fixIds(env, 3)).toHaveLength(1);
    expect(env.task(fixTaskId(PHASE, 3, 1)).footprint.writes).toEqual(["a.ts"]);
    expect(env.task(fixTaskId(PHASE, 3, 1)).text).not.toContain("M1");
    expect(env.task(reviewTaskId(PHASE, 4)).id).toBe("p1.QA4");
    expect(await env.types()).toEqual(["gate-changed", "task-created", "task-created", "edge-added", "inbox-added", "inbox-added"]);
    expect(caps(env).map((i) => i.text)).toEqual(["deferred minor M1: problem M1 [b.ts]", "deferred nit N1: problem N1 [a.ts]"]);
    expect(caps(env).every((i) => i.answer === "deferred" && i.severity === "info")).toBe(true);
    expect(env.wakes).toEqual([]);
  });

  it("route and acceptance come from the phase FIX template when there is one", async () => {
    const env = await setup({ template: true });
    await env.loop.onQaResult(env.qaId, report(f("A1", "major", ["a.ts"])));
    const t = env.task(fixTaskId(PHASE, 1, 1));
    expect(t.route).toEqual({ line: "class=implement d=deterministic tier=heavy pin root=C:/tmpl", role: "implement", tier: "heavy", pin: true });
    expect(t.acceptance).toBe("check: testsPass");
    expect(t.verify).toBe("deferred");
  });

  it("without a template: the default route line with the phase root and no acceptance", async () => {
    const env = await setup();
    await env.loop.onQaResult(env.qaId, report(f("A1", "major", ["a.ts"])));
    const t = env.task(fixTaskId(PHASE, 1, 1));
    expect(t.route.line).toBe("class=implement d=deterministic tier=medium pin root=C:/repo");
    expect(t.route).toMatchObject({ tier: "medium", pin: true });
    expect(t.acceptance).toBeNull();
  });

  it("the re-review task copies the round's qa route line and depends on every fix task", async () => {
    const env = await setup();
    await env.loop.onQaResult(env.qaId, report(f("A1", "major", ["a.ts"]), f("B1", "major", ["b.ts"])));
    const review = env.task("p1.QA2");
    expect(review.route).toEqual(env.task(env.qaId).route);
    expect(review.route.line).toBe("class=review d=none tier=heavy pin root=C:/repo");
    expect(env.ledger().edges.filter((e) => e.to === "p1.QA2").map((e) => e.from).sort()).toEqual(["p1.FIX1-1", "p1.FIX1-2"]);
  });

  it("a file-less finding becomes a fix task with no writes that depends on the others", async () => {
    const env = await setup();
    await env.loop.onQaResult(env.qaId, report(f("A1", "major", []), f("B1", "major", ["b.ts"])));
    expect(env.task("p1.FIX1-1").footprint.writes).toEqual(["b.ts"]);
    expect(env.task("p1.FIX1-2").footprint.writes).toEqual([]);
    expect(env.ledger().edges.some((e) => e.from === "p1.FIX1-1" && e.to === "p1.FIX1-2")).toBe(true);
  });

  it("the next round's qa task can run and its result is applied (round numbering follows qaRound)", async () => {
    const env = await setup({ max: 3 });
    await env.loop.onQaResult(env.qaId, report(f("A1", "major", ["a.ts"])));
    await runQa(env, "p1.QA2", canonicalFindingsJson(report()));
    expect(env.phase()).toMatchObject({ gate: "qa-running", qaRound: 2 });
    expect(await env.loop.onQaResult("p1.QA2", report())).toBe("passed");
    expect(env.phase().gate).toBe("passed");
  });
});

describe("onQaResult: cap", () => {
  const blocking = report(f("J1", "major", ["a.ts"]), f("M1", "minor", ["b.ts"]));

  it("at the cap: gate qa-running to awaiting-qa, phase paused, one critical qa-cap item, one wake; order G, PP, IA", async () => {
    const env = await setup({ max: 2, round: 2 });
    expect(await env.loop.onQaResult(env.qaId, blocking)).toBe("cap-reached");
    expect(env.phase()).toMatchObject({ gate: "awaiting-qa", qaRound: 2, paused: true });
    expect(await env.types()).toEqual(["gate-changed", "phase-paused", "inbox-added"]);
    const item = env.ledger().inbox[0];
    expect(item).toMatchObject({ id: "R-1", kind: "qa-cap", severity: "critical", taskId: env.qaId, answer: null, options: ["accept", "fix"] });
    expect(item?.text).toContain("J1");
    expect(env.wakes).toEqual([{ reason: "inbox", key: "inbox:R-1" }]);
    expect(Object.keys(env.ledger().tasks).filter((id) => id.includes("FIX"))).toEqual([]);
  });

  it("qaMaxRounds 1: round 1 with a major finding caps at once", async () => {
    const env = await setup({ max: 1 });
    expect(await env.loop.onQaResult(env.qaId, blocking)).toBe("cap-reached");
  });

  it("an already paused phase is not paused twice", async () => {
    const env = await setup({ max: 1, paused: true });
    await env.loop.onQaResult(env.qaId, blocking);
    expect(await env.types()).toEqual(["gate-changed", "inbox-added"]);
    expect(env.phase().paused).toBe(true);
  });

  it("QA_ROUND_LIMIT offers accept only", async () => {
    // qaMaxRounds is at most 8 (EXECUTOR_LIMITS); cap-fix answers alone push qaRound past it, up to QA_ROUND_LIMIT.
    const env = await setup({ max: 8, round: QA_ROUND_LIMIT });
    expect(await env.loop.onQaResult(env.qaId, blocking)).toBe("cap-reached");
    expect(env.ledger().inbox[0]?.options).toEqual(["accept"]);
  });

  it("a wake that throws does not undo the journaled item", async () => {
    const env = await setup({ max: 1 });
    env.failWake.on = true;
    expect(await env.loop.onQaResult(env.qaId, blocking)).toBe("cap-reached");
    expect(env.ledger().inbox).toHaveLength(1);
    expect(env.warnings).toHaveLength(1);
  });

  it("an unknown or non-qa task is E_INVALID_INPUT", async () => {
    const env = await setup();
    expect((await failure(env.loop.onQaResult("nope", report()))).code).toBe("E_INVALID_INPUT");
    expect((await failure(env.loop.onQaResult("p1.T1", report()))).code).toBe("E_INVALID_INPUT");
  });
});

describe("onQaResult: idempotency (Q8)", () => {
  it("repeating a result writes nothing and returns the same outcome", async () => {
    for (const [r, max, want] of [
      [report(), 3, "passed"], [report(f("A", "major")), 3, "next-round"], [report(f("A", "major")), 1, "cap-reached"],
    ] as const) {
      const env = await setup({ max });
      expect(await env.loop.onQaResult(env.qaId, r)).toBe(want);
      const seq = env.ledger().seq;
      const inbox = env.ledger().inbox.length;
      expect(await env.loop.onQaResult(env.qaId, r)).toBe(want);
      expect(env.ledger().seq).toBe(seq);
      expect(env.ledger().inbox.length).toBe(inbox);
      expect(env.wakes.length).toBe(want === "cap-reached" ? 1 : 0);
    }
  });

  it("a cap answered with accept reads back as passed, answered with fix as next-round", async () => {
    const a = await setup({ max: 1, report: report(f("A", "major")) });
    await a.loop.onQaResult(a.qaId, report(f("A", "major")));
    await a.loop.onCapAnswer("R-1", "accept");
    expect(await a.loop.onQaResult(a.qaId, report(f("A", "major")))).toBe("passed");
    const b = await setup({ max: 1, report: report(f("A", "major")) });
    await b.loop.onQaResult(b.qaId, report(f("A", "major")));
    await b.loop.onCapAnswer("R-1", "fix");
    const seq = b.ledger().seq;
    expect(await b.loop.onQaResult(b.qaId, report(f("A", "major")))).toBe("next-round");
    expect(b.ledger().seq).toBe(seq);
  });

  it("two concurrent calls write once", async () => {
    const env = await setup({ max: 3 });
    const r = report(f("A", "major", ["a.ts"]));
    const [x, y] = await Promise.all([env.loop.onQaResult(env.qaId, r), env.loop.onQaResult(env.qaId, r)]);
    expect([x, y]).toEqual(["next-round", "next-round"]);
    expect(fixIds(env, 1)).toHaveLength(1);
  });

  it("a stale result for a task that is not the round's qa task is not applied", async () => {
    const env = await setup({ max: 3, round: 2 });
    await env.writer.append([{ type: "task-created", task: qaDone("p1.OLDQA", canonicalFindingsJson(report()), { state: "done", attempts: [] }) }]);
    const seq = env.ledger().seq;
    // p1.OLDQA is round 1's qa task (no .QA<n> suffix) and the phase is in round 2: Q8 derives "next-round", writes nothing.
    expect(await env.loop.onQaResult("p1.OLDQA", report(f("A", "major")))).toBe("next-round");
    expect(env.ledger().seq).toBe(seq);
    expect(env.phase().gate).toBe("qa-running");
  });
});

describe("onAwaitingQa", () => {
  it("passes a gate with no open qa task (no-open-qa)", async () => {
    const env = await setup({ gate: "awaiting-qa" });
    await env.loop.onAwaitingQa(PHASE);
    expect(env.phase().gate).toBe("passed");
    expect(await env.types()).toEqual(["gate-changed"]);
  });

  it("is a no-op while a qa task is outside done/cancelled", async () => {
    const env = await setup({ gate: "awaiting-qa", qaPatch: { state: "pending", attempts: [] } });
    const seq = env.ledger().seq;
    await env.loop.onAwaitingQa(PHASE);
    expect(env.ledger().seq).toBe(seq);
    expect(env.phase().gate).toBe("awaiting-qa");
  });

  it("is a no-op while a critical qa-cap item names one of the phase's qa tasks", async () => {
    const env = await setup({ max: 1 });
    await env.loop.onQaResult(env.qaId, report(f("A", "major")));
    const seq = env.ledger().seq;
    await env.loop.onAwaitingQa(PHASE);
    expect(env.ledger().seq).toBe(seq);
    expect(env.phase().gate).toBe("awaiting-qa");
  });

  it("is a no-op in any other gate state and for an unknown phase", async () => {
    const env = await setup({ gate: "qa-running" });
    const seq = env.ledger().seq;
    await env.loop.onAwaitingQa(PHASE);
    await env.loop.onAwaitingQa("nope");
    expect(env.ledger().seq).toBe(seq);
  });
});

describe("onCapAnswer", () => {
  const major = report(f("J1", "major", ["a.ts"]), f("M1", "minor", ["b.ts"]));

  async function capped(max = 1, round = 1): Promise<Env> {
    const env = await setup({ max, round, report: major });
    await env.loop.onQaResult(env.qaId, major);
    return env;
  }

  it("accept: answered, every remaining finding deferred, gate passed (cap-accepted), phase unpaused; order IAn, IA.., G, PP", async () => {
    const env = await capped();
    const base = env.ledger().seq;
    expect(await env.loop.onCapAnswer("R-1", "accept")).toBe("passed");
    expect(await env.types(base)).toEqual(["inbox-answered", "inbox-added", "inbox-added", "gate-changed", "phase-paused"]);
    expect(env.phase()).toMatchObject({ gate: "passed", paused: false, qaRound: 1 });
    expect(env.ledger().inbox.map((i) => [i.id, i.answer])).toEqual([["R-1", "accept"], ["R-2", "deferred"], ["R-3", "deferred"]]);
    expect(env.ledger().inbox[1]?.text).toBe("deferred major J1: problem J1 [a.ts]");
  });

  it("fix: only blocking/critical/major get fix tasks, qaRound + 1, phase unpaused, no deferred items; order IAn, G, TC.., EA, PP", async () => {
    const env = await capped();
    const base = env.ledger().seq;
    expect(await env.loop.onCapAnswer("R-1", "fix")).toBe("next-round");
    expect(await env.types(base)).toEqual(["inbox-answered", "gate-changed", "task-created", "task-created", "edge-added", "phase-paused"]);
    expect(env.phase()).toMatchObject({ gate: "pending", qaRound: 2, paused: false });
    expect(fixIds(env, 1).map((id) => env.task(id).footprint.writes)).toEqual([["a.ts"]]);
    expect(env.task("p1.QA2")).toMatchObject({ kind: "qa", state: "pending" });
    expect(caps(env)).toHaveLength(1);
    expect(env.ledger().inbox[0]?.answer).toBe("fix");
  });

  it("fix from a later round numbers from that round", async () => {
    const env = await capped(3, 3);
    await env.loop.onCapAnswer("R-1", "fix");
    expect(env.phase().qaRound).toBe(4);
    expect(env.task("p1.FIX3-1").phase).toBe(PHASE);
    expect(env.task("p1.QA4").id).toBe("p1.QA4");
  });

  it("a phase paused by something else stays paused when another critical item is open on it", async () => {
    const env = await capped();
    await env.writer.append([{ type: "inbox-added", item: { id: "B-9", kind: "breaker", severity: "critical", taskId: "p1.T1", text: "breaker", options: [], answer: null, createdAt: T0 } }]);
    await env.loop.onCapAnswer("R-1", "accept");
    expect(env.phase().paused).toBe(true);
  });

  it("rejects an unknown id, a non-cap item, a closed item's wrong answer and a value that is not an option", async () => {
    const env = await capped();
    expect((await failure(env.loop.onCapAnswer("R-77", "accept"))).code).toBe("E_INVALID_INPUT");
    await env.writer.append([{ type: "inbox-added", item: { id: "Q-5", kind: "question", severity: "blocking", taskId: "p1.T1", text: "q", options: [], answer: null, createdAt: T0 } }]);
    expect((await failure(env.loop.onCapAnswer("Q-5", "accept"))).code).toBe("E_INVALID_INPUT");
    const seq = env.ledger().seq;
    expect((await failure(env.loop.onCapAnswer("R-1", "maybe" as never))).code).toBe("E_INVALID_INPUT");
    expect(env.ledger().seq).toBe(seq);
    expect(env.ledger().inbox[0]?.answer).toBeNull();
  });

  it("fix is refused at QA_ROUND_LIMIT (the item offers accept only), accept works", async () => {
    // qaMaxRounds is at most 8 (EXECUTOR_LIMITS); cap-fix answers alone push qaRound past it, up to QA_ROUND_LIMIT.
    const env = await setup({ max: 8, round: QA_ROUND_LIMIT, report: major });
    await env.loop.onQaResult(env.qaId, major);
    expect((await failure(env.loop.onCapAnswer("R-1", "fix"))).code).toBe("E_INVALID_INPUT");
    expect(await env.loop.onCapAnswer("R-1", "accept")).toBe("passed");
  });

  it("answering twice writes once", async () => {
    const env = await capped();
    await env.loop.onCapAnswer("R-1", "accept");
    const seq = env.ledger().seq;
    expect(await env.loop.onCapAnswer("R-1", "accept")).toBe("passed");
    expect(env.ledger().seq).toBe(seq);
  });

  it("the findings are re-read from the round's qa attempt context", async () => {
    const env = await setup({ max: 1, report: report(f("ONLY", "critical", ["z.ts"])) });
    await env.loop.onQaResult(env.qaId, report(f("ONLY", "critical", ["z.ts"])));
    await env.loop.onCapAnswer("R-1", "fix");
    expect(env.task("p1.FIX1-1").footprint.writes).toEqual(["z.ts"]);
  });
});

describe("termination", () => {
  it("an always-major reviewer ends in a cap within qaMaxRounds, for qaMaxRounds 1-4", async () => {
    for (let max = 1; max <= 4; max++) {
      const major = report(f("J1", "major", ["a.ts"]));
      const env = await setup({ max, report: major });
      let id = env.qaId;
      let outcome = await env.loop.onQaResult(id, major);
      let rounds = 1;
      while (outcome === "next-round") {
        rounds++;
        expect(rounds).toBeLessThanOrEqual(max);
        id = reviewTaskId(PHASE, rounds);
        await runQa(env, id, canonicalFindingsJson(major));
        outcome = await env.loop.onQaResult(id, major);
      }
      expect(outcome, `max ${max}`).toBe("cap-reached");
      expect(rounds).toBe(max);
      expect(env.phase()).toMatchObject({ gate: "awaiting-qa", paused: true, qaRound: max });
      expect(env.wakes).toHaveLength(1);
      // The gate stays shut until a human decides.
      await env.loop.onAwaitingQa(PHASE);
      expect(env.phase().gate).toBe("awaiting-qa");
      expect(await env.loop.onCapAnswer(env.ledger().inbox.find((i) => i.severity === "critical")?.id ?? "", "accept")).toBe("passed");
      expect(env.phase().gate).toBe("passed");
    }
  });

  it("a reviewer that fixes itself in round 2 passes", async () => {
    const env = await setup({ max: 3, report: report(f("J1", "major", ["a.ts"])) });
    expect(await env.loop.onQaResult(env.qaId, report(f("J1", "major", ["a.ts"])))).toBe("next-round");
    await runQa(env, "p1.QA2", canonicalFindingsJson(report(f("N1", "nit", ["a.ts"]))));
    expect(await env.loop.onQaResult("p1.QA2", report(f("N1", "nit", ["a.ts"])))).toBe("next-round");
    await runQa(env, "p1.QA3", canonicalFindingsJson(report(f("N1", "nit", ["a.ts"]))));
    expect(await env.loop.onQaResult("p1.QA3", report(f("N1", "nit", ["a.ts"])))).toBe("passed");
    expect(env.phase()).toMatchObject({ gate: "passed", qaRound: 3 });
  });
});
