import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { INTEGRATION_ESTIMATE_MS, formatSummary, planEstimate, taskEstimate } from "../../src/executor/compile/estimate";
import { createPlanCompiler, planIdOf } from "../../src/executor/compile/index";
import { parsePlan } from "../../src/executor/compile/parse";
import { VALIDATION_CODES, isStrictRepoPath, validateLedger } from "../../src/executor/compile/validate";
import { ExecutorError, PLAN_ID_PATTERN, executorDefaults, isLedgerV1, type LedgerV1 } from "../../src/executor/types";
import { NOW, compileOpts, constantDurations, edgeKeys, makeHarness, planPathOf, type Harness } from "../fixtures/cpx/plans/harness";
import { fixturePath, readFixture, readManifest, readFixtureBytes, sha256Of } from "../fixtures/cpx/plans/loader";

const PLAN_NAMES = [
  "critical-path-execution-plan.md",
  "delegation-depth-and-effort-bump-plan.md",
  "role-tier-assurance-delegation-plan.md",
  "verification-resource-budget-plan.md",
];
const FROZEN = PLAN_NAMES.every((n) => existsSync(fixturePath(n)));

const SYNTHETIC_OK = [
  "contract-first",
  "graph-arrows",
  "post-qa-order",
  "nested-subtasks",
  "fences-with-items",
  "headings-only",
  "unannotated-flat",
  "ownership-file-major",
  "ownership-phase-major",
  "inline-code-paths",
  "df-switch",
];

async function compileName(name: string, extra: { phases?: string[]; doneBefore?: string } = {}) {
  const h = makeHarness();
  const r = await h.compiler.compile(planPathOf(name), compileOpts(h, extra));
  return { h, ...r };
}

async function failure(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

function clone(l: LedgerV1): LedgerV1 {
  return JSON.parse(JSON.stringify(l)) as LedgerV1;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedPlan(phases: number, perPhase: number, seed: number): string {
  const rand = rng(seed);
  const out: string[] = ["# Generated plan", "", "Shared preamble.", ""];
  let n = 0;
  for (let p = 1; p <= phases; p += 1) {
    if ((p - 1) % 5 === 0) out.push(`## Wave ${Math.floor((p - 1) / 5) + 1}`, "");
    out.push(`### Phase ${p}.1 Generated ${p}`, "", "**Tasks**");
    for (let t = 1; t <= perPhase; t += 1) {
      n += 1;
      const shared = rand() < 0.15 ? `src/alpha/shared-${p}.ts` : `src/alpha/gen-${n}.ts`;
      out.push(`- **${p}.1.${t}** \`[tier:medium]\` Implement piece ${n}.`, `  Writes: \`${shared}\``);
    }
    out.push("");
  }
  return out.join("\n");
}

describe("executor compile: pins", () => {
  it("never reads the live plans directory from a compile test", () => {
    const needles = [["docs", "plans"].join("/"), ["docs", "plans"].join("\\\\"), ["docs", "plans"].join("\\")];
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const f of ["parse", "footprint", "edges", "residue", "real-plans"]) {
      const text = readFileSync(join(dir, `executor-compile-${f}.test.ts`), "utf8");
      for (const needle of needles) expect(text.includes(needle), `${f}: ${needle}`).toBe(false);
    }
  });

  it("pins every manifest entry to its frozen bytes", () => {
    for (const e of readManifest()) {
      const bytes = readFixtureBytes(e.name);
      expect(bytes.length, e.name).toBe(e.bytes);
      expect(sha256Of(bytes), e.name).toBe(e.sha256);
      expect(e.source).toBe(["docs", "plans", e.name].join("/"));
    }
  });

  it("rejects fixture paths outside the fixtures directory", () => {
    expect(() => fixturePath("../../unit/executor-compile-parse.test.ts")).toThrow(/escapes/);
    expect(() => readFixture("..\\loader.ts")).toThrow(/escapes/);
  });
});

describe("executor compile: drafts (2.3.6)", () => {
  it("takes the toplevel's base branch tip, not the plan checkout HEAD, and never caches it across compiles", async () => {
    const h = makeHarness();
    const old = "1".repeat(40);
    let tip = "2".repeat(40);
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const compiler = createPlanCompiler({ ...h.deps, git: {
      async run(args, cwd) {
        calls.push({ args, cwd });
        if (args.join(" ") === "symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/cpx/main\n" };
        if (args.join(" ") === "rev-parse --verify refs/heads/cpx/main^{commit}") return { code: 0, stdout: `${tip}\n` };
        if (args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: `${old}\n` };
        return h.deps.git.run(args, cwd);
      },
    } });
    const path = planPathOf("synthetic/contract-first.md");
    const first = await compiler.compile(path, compileOpts(h));
    expect(first.draft.repo.baseBranch).toBe("cpx/main");
    expect(first.draft.repo.baseCommit).toBe(tip);
    expect(first.draft.integration.head).toBe(tip);
    expect(calls.filter(call => call.args[0] === "symbolic-ref" || call.args.includes("--verify"))
      .every(call => call.cwd === h.view.toplevel)).toBe(true);
    expect(calls.some(call => call.args.join(" ") === "rev-parse HEAD")).toBe(false);
    tip = "3".repeat(40);
    const second = await compiler.compile(path, compileOpts(h));
    expect(second.draft.repo.baseCommit).toBe(tip);
    expect(second.draft.integration.head).toBe(tip);
    expect(first.draft.repo.baseCommit).toBe("2".repeat(40));
  });

  it("refuses a detached toplevel HEAD and asks for the base branch", async () => {
    const h = makeHarness();
    const compiler = createPlanCompiler({ ...h.deps, git: {
      async run(args, cwd) {
        if (args[0] === "symbolic-ref") {
          expect(cwd).toBe(h.view.toplevel);
          return { code: 128, stdout: "" };
        }
        return h.deps.git.run(args, cwd);
      },
    } });
    await expect(compiler.compile(planPathOf("synthetic/contract-first.md"), compileOpts(h))).rejects.toMatchObject({
      code: "E_INVALID_INPUT", message: expect.stringContaining("check out the base branch"),
    });
  });
  it("QA-PDF21-10: reads the full branch ref when a tag has the same name", async () => {
    const h = makeHarness();
    const calls: string[] = [];
    const compiler = createPlanCompiler({ ...h.deps, git: {
      async run(args, cwd) {
        const command = args.join(" ");
        calls.push(command);
        if (command === "symbolic-ref --short HEAD") return { code: 0, stdout: "heads/release\n" };
        if (command === "symbolic-ref HEAD") return { code: 0, stdout: "refs/heads/release\n" };
        if (command === "rev-parse --verify refs/heads/release^{commit}") return { code: 0, stdout: `${h.view.head}\n` };
        if (command === "rev-parse --verify refs/heads/heads/release^{commit}") return { code: 128, stdout: "" };
        return h.deps.git.run(args, cwd);
      },
    } });
    const { draft } = await compiler.compile(planPathOf("synthetic/contract-first.md"), compileOpts(h));
    expect(draft.repo.baseBranch).toBe("release");
    expect(draft.repo.baseCommit).toBe(h.view.head);
    expect(calls).toContain("symbolic-ref HEAD");
    expect(calls).not.toContain("symbolic-ref --short HEAD");
  });
  it.each(["refs/tags/release", "release", "refs/heads/"])("QA-PDF21-10: refuses a non-branch symbolic HEAD %s", async (ref) => {
    const h = makeHarness();
    const compiler = createPlanCompiler({ ...h.deps, git: {
      run: (args, cwd) => args[0] === "symbolic-ref"
        ? Promise.resolve({ code: 0, stdout: `${ref}\n` })
        : h.deps.git.run(args, cwd),
    } });
    await expect(compiler.compile(planPathOf("synthetic/contract-first.md"), compileOpts(h))).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it.each(SYNTHETIC_OK)("%s compiles to a valid, closed, seq 1 draft", async (name) => {
    const { h, draft } = await compileName(`synthetic/${name}.md`);
    expect(isLedgerV1(draft)).toBe(true);
    expect(draft.seq).toBe(1);
    expect(h.compiler.validate(draft)).toEqual([]);
    expect(draft.launcher).toBe("A");
    expect(draft.orchestrator).toEqual({ sessionID: "ses_test", boundAt: NOW });
    expect(draft.integration.branch).toBe(`omr/${draft.planId}/integration`);
    expect(draft.integration.worktree).toBe(`D:\\slots\\${draft.planId}\\integration`);
    expect(draft.repo.toplevel).toBe("D:\\git\\omr-cpx-p23");
    expect(draft.repo.key).toBe("D:\\git\\omr-cpx-main\\.git");
    expect(draft.repo.baseCommit).toBe(h.view.head);
  });

  it("marks manual dogfood tasks and keeps DF phases out of explicit selection", async () => {
    const { draft, summary } = await compileName("synthetic/df-switch.md");
    expect(summary.manual.length).toBeGreaterThan(0);
    for (const id of summary.manual) expect(draft.tasks[id]?.route).toEqual({ line: "", role: "", tier: null, pin: false });
    const h = makeHarness();
    const err = await failure(h.compiler.compile(planPathOf("synthetic/df-switch.md"), compileOpts(h, { phases: ["DF1"] })));
    expect(err.code).toBe("E_INVALID_INPUT");
  });

  it("selects phases and projects earlier phases as done (gate passed)", async () => {
    const { draft, h } = await compileName("synthetic/graph-arrows.md", { phases: ["1.2"], doneBefore: "1.2" });
    expect(Object.keys(draft.tasks)).toEqual(["1.2.1"]);
    expect(draft.phases.map((p) => [p.id, p.gate])).toEqual([["1.1", "passed"], ["1.2", "pending"]]);
    expect(draft.phases.every((p) => p.qaRound === 1 && !p.paused && p.tag === null)).toBe(true);
    const incoming = draft.edges.filter((e) => e.to === "1.2.1");
    expect(incoming.length).toBeGreaterThan(0);
    for (const e of incoming) {
      expect(e.from.startsWith("gate:")).toBe(true);
      expect(draft.phases.find((p) => `gate:${p.id}` === e.from)?.gate).toBe("passed");
    }
    expect(draft.planId).toBe("graph-arrows-1-2-db-1-2"); // QA-2.3-17: doneBefore is part of the plan id
    expect(h.compiler.validate(draft)).toEqual([]);
  });

  it("rejects bad inputs with E_INVALID_INPUT", async () => {
    const h = makeHarness();
    const good = compileOpts(h);
    const abs = planPathOf("synthetic/contract-first.md");
    const cases: Array<[string, Promise<unknown>]> = [
      ["relative path", h.compiler.compile("plan.md", good)],
      ["unknown phase", h.compiler.compile(abs, { ...good, phases: ["9.9"] })],
      ["empty phases", h.compiler.compile(abs, { ...good, phases: [] })],
      ["unknown doneBefore", h.compiler.compile(abs, { ...good, doneBefore: "9.9" })],
      ["bad now", h.compiler.compile(abs, { ...good, now: "2026-10-11T10:00:00Z" })],
      ["empty session", h.compiler.compile(abs, { ...good, orchestratorSessionID: "" })],
      ["config out of range", h.compiler.compile(abs, { ...good, config: { ...executorDefaults(), maxParallel: 9999 } })],
      ["config enum", h.compiler.compile(abs, { ...good, config: { ...executorDefaults(), approve: "maybe" as never } })],
    ];
    for (const [label, p] of cases) {
      const err = await failure(p);
      expect(err.code, label).toBe("E_INVALID_INPUT");
    }
  });

  it("derives plan ids from the file name and the selected phases", () => {
    expect(planIdOf("D:\\plans\\My Plan.v2.md", undefined)).toBe("my-plan-v2");
    expect(planIdOf("/x/plan.md", ["1.1", "2.1"])).toBe("plan-1-1--2-1");
    // QA-2.3-17: `["1.1.2"]` and `["1.1","2"]` no longer collide; doneBefore separates runs of one phase list
    expect(planIdOf("/x/plan.md", ["1.1.2"])).not.toBe(planIdOf("/x/plan.md", ["1.1", "2"]));
    expect(planIdOf("/x/plan.md", ["1.1"], "1.2")).not.toBe(planIdOf("/x/plan.md", ["1.1"]));
    const long = planIdOf(`D:\\plans\\${"very-long-name-".repeat(8)}.md`, undefined);
    expect(long.length).toBeLessThanOrEqual(41);
    expect(long).toMatch(PLAN_ID_PATTERN);
    expect(planIdOf("D:\\plans\\---.md", undefined)).toMatch(PLAN_ID_PATTERN);
  });

  it("compiles a generated 300-task plan under 2 s with a closed ledger", async () => {
    const text = generatedPlan(30, 10, 12345);
    const h = makeHarness({ inline: { "gen.md": text } });
    const t0 = Date.now();
    const r = await h.compiler.compile(planPathOf("gen.md"), compileOpts(h));
    const elapsed = Date.now() - t0;
    expect(Object.keys(r.draft.tasks).length).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2000);
    expect(h.compiler.validate(r.draft)).toEqual([]);
    const again = await h.compiler.compile(planPathOf("gen.md"), compileOpts(h));
    expect(edgeKeys(again.draft)).toEqual(edgeKeys(r.draft));
  });
});

describe.skipIf(!FROZEN)("executor compile: the one frozen plan that compiles today (rta)", () => {
  const name = "role-tier-assurance-delegation-plan.md";

  it("reports the `Checkpoint DF-n` steps it does not compile (not a phase heading in the memo grammar)", async () => {
    const { summary } = await compileName(name);
    // rta:757 and rta:872 are `#### Checkpoint DF-1/DF-2` siblings of P1.6/P2.3, so their numbered steps
    // (rta:761-775, rta:876-902) sit outside every phase: not tasks, each reported as `item-outside-phase`.
    const outside = summary.warnings.filter((w) => w.startsWith("item-outside-phase"));
    for (const line of [761, 764, 768, 775]) expect(outside.some((w) => w.includes(`L${line}:`)), `L${line}`).toBe(true);
  });

  it("yields a valid, closed, seq 1 draft with T-prefixed ids and no FIX templates", async () => {
    const { h, draft } = await compileName(name);
    expect(isLedgerV1(draft)).toBe(true);
    expect(draft.seq).toBe(1);
    expect(h.compiler.validate(draft)).toEqual([]);
    for (const id of ["T0.1.1", "T1.1.1", "T1.5.3a", "T3.4.5"]) expect(Object.keys(draft.tasks), id).toContain(id);
    expect(Object.keys(draft.tasks).some((id) => id.endsWith(".FIX"))).toBe(false);
  });

  it("QA-2.3-18: T3.4.5 (rta:1002) names `Footprint.confidence` after a write verb and stays top", async () => {
    const { draft } = await compileName(name);
    const fp = draft.tasks["T3.4.5"]?.footprint;
    // no explicit write: the identifier is not a file; the phase's ownership rows (if any) give at most an `inferred` set
    expect(fp?.confidence).not.toBe("explicit");
    expect(fp?.writes.some((w) => w.includes("Footprint"))).toBe(false);
  });

  it("is deterministic: two compiles give the same ids and edges", async () => {
    const a = await compileName(name);
    const b = await compileName(name);
    expect(Object.keys(a.draft.tasks)).toEqual(Object.keys(b.draft.tasks));
    expect(edgeKeys(a.draft)).toEqual(edgeKeys(b.draft));
  });
});

describe("executor compile: estimate and summary (2.3.6.b)", () => {
  it("summarises work, critical path, width and makespan", async () => {
    const { draft, summary } = await compileName("synthetic/graph-arrows.md");
    const launchable = Object.values(draft.tasks).filter((t) => t.kind !== "manual" && t.kind !== "preflight");
    expect(summary.tasks).toBe(Object.keys(draft.tasks).length);
    expect(summary.phases).toBe(draft.phases.length);
    expect(summary.edges).toBe(draft.edges.length);
    expect(summary.workMs).toBe(launchable.length * 600_000);
    expect(summary.criticalPathMs).toBeGreaterThanOrEqual(600_000);
    expect(summary.criticalPathMs).toBeLessThanOrEqual(summary.workMs);
    expect(summary.width).toBeGreaterThanOrEqual(1);
    expect(summary.expectedMakespanMs).toBeGreaterThanOrEqual(summary.criticalPathMs);
    expect(summary.expectedMakespanMs).toBeGreaterThanOrEqual(INTEGRATION_ESTIMATE_MS * launchable.length);
    const line = formatSummary(summary, { planId: draft.planId, maxParallel: 4 });
    expect(line).toContain(`plan ${draft.planId}: ${summary.tasks} tasks`);
    expect(line).toContain(`${summary.phases} phases`);
    expect(line).toContain(`${summary.warnings.length} warnings`);
    expect(planEstimate(draft, draft.config.maxParallel).workMs).toBe(summary.workMs);
  });

  it("serial chains have width 1 and a critical path equal to the work", async () => {
    const text = `# P\n\n## Wave 1\n\n### Phase 1.1 Chain\n\n**Tasks**\n- **1.1.1** \`[tier:medium]\` A.\n  Writes: \`src/alpha/core.ts\`\n- **1.1.2** \`[tier:medium]\` B.\n  Writes: \`src/alpha/core.ts\`\n\nOrder: 1.1.1 → 1.1.2\n`;
    const h = makeHarness({ inline: { "chain.md": text } });
    const r = await h.compiler.compile(planPathOf("chain.md"), compileOpts(h));
    expect(r.summary.width).toBe(1);
    expect(r.summary.criticalPathMs).toBe(r.summary.workMs);
  });

  it("estimates manual, done and modelled tasks", () => {
    const m = constantDurations(1000, 4000);
    expect(taskEstimate(m, { kind: "manual", state: "pending", role: "", tier: null, route: null })).toEqual({ p50: 0, p90: 0, source: "manual" });
    expect(taskEstimate(m, { kind: "task", state: "done", role: "r", tier: null, route: null })).toEqual({ p50: 0, p90: 0, source: "done: merged before the run" });
    expect(taskEstimate(m, { kind: "task", state: "pending", role: "", tier: "fast", route: null })).toEqual({ p50: 1000, p90: 4000, source: "prior" });
  });
});

describe("executor compile: validate (2.3.6.a)", () => {
  async function base(): Promise<{ h: Harness; draft: LedgerV1 }> {
    const { h, draft } = await compileName("synthetic/contract-first.md");
    return { h, draft };
  }
  const codes = (h: Harness, l: LedgerV1): string[] => h.compiler.validate(l).map((e) => e.code);

  it("lists its codes", () => {
    expect(VALIDATION_CODES).toEqual(expect.arrayContaining(["cycle", "closure", "id-unknown", "path-outside", "qa-multiple"]));
  });

  it("reports an edge to an unknown id", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    l.edges.push({ from: "1.1.1", to: "9.9.9", kind: "explicit", confidence: "high", evidence: "x" });
    expect(codes(h, l)).toContain("id-unknown");
  });

  it("reports a cycle", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    l.edges.push({ from: "1.1.2", to: "1.1.1", kind: "explicit", confidence: "high", evidence: "x" });
    expect(codes(h, l)).toContain("cycle");
  });

  it("reports a path that is not repo-relative", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    const t = l.tasks["1.1.3"];
    if (t === undefined) throw new Error("fixture changed");
    t.footprint.writes = ["D:/x/y.ts"];
    expect(codes(h, l)).toContain("path-outside");
    expect(isStrictRepoPath("src/a.ts")).toBe(true);
    for (const bad of ["", "/abs", "a\\b", "a/../b", "a/./b", "a//b", "C:/x", "a\0b"]) expect(isStrictRepoPath(bad), bad).toBe(false);
  });

  it("reports concurrent tasks whose footprints overlap (closure)", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    l.edges = [];
    const t = l.tasks["1.1.3"];
    if (t === undefined) throw new Error("fixture changed");
    t.footprint.writes = ["src/alpha/parser.ts"];
    expect(codes(h, l)).toContain("closure");
  });

  it("reports more than one live qa task per phase and ids equal after case folding", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    const src = l.tasks["1.1.3"];
    if (src === undefined) throw new Error("fixture changed");
    l.tasks["1.1.Q1"] = { ...clone({ ...draft, tasks: { x: src } }).tasks["x"]!, id: "1.1.Q1", kind: "qa" };
    l.tasks["1.1.q1"] = { ...l.tasks["1.1.Q1"], id: "1.1.q1" };
    const c = codes(h, l);
    expect(c).toContain("qa-multiple");
    expect(c).toContain("id-duplicate");
  });

  it("defers to the ledger invariants", async () => {
    const { h, draft } = await base();
    const l = clone(draft);
    l.seq = 0;
    expect(validateLedger(l).some((e) => e.code.startsWith("ledger:"))).toBe(true);
    expect(h.compiler.validate(draft)).toEqual([]);
  });
});

describe("executor compile: addTasks", () => {
  const frag = (id: string, path: string): string => `- **${id}** \`[tier:medium]\` New work.\n  Writes: \`${path}\`\n`;

  it("adds independent tasks without edges", async () => {
    const { h, draft } = await compileName("synthetic/contract-first.md");
    const r = h.compiler.addTasks(draft, frag("1.1.4", "src/alpha/index.ts"));
    expect(r.tasks.map((t) => t.id)).toEqual(["1.1.4"]);
    expect(r.tasks[0]?.phase).toBe("1.1");
    expect(r.edges).toEqual([]);
    expect(r.reopened).toEqual([]);
  });

  it("orders a new task after existing live tasks it conflicts with", async () => {
    const { h, draft } = await compileName("synthetic/contract-first.md");
    const r = h.compiler.addTasks(draft, frag("1.1.4", "src/alpha/format.ts"));
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toContain("1.1.3>1.1.4");
  });

  it("rejects duplicate ids and empty fragments", async () => {
    const { h, draft } = await compileName("synthetic/contract-first.md");
    expect(() => h.compiler.addTasks(draft, frag("1.1.1", "src/alpha/index.ts"))).toThrow(ExecutorError);
    expect(() => h.compiler.addTasks(draft, "no tasks here")).toThrow(ExecutorError);
    expect(() => h.compiler.addTasks(draft, frag("7.7.1", "src/alpha/index.ts"))).toThrow(ExecutorError);
  });
});

describe.skipIf(!FROZEN)("executor compile: frozen real plans", () => {
  interface PlanCounts {
    tasks: number;
    preflight: number;
    qa: number;
    manual?: number;
    phases: number;
    waves: number;
    perPhase: Record<string, number>;
    orderEdges: string[];
    dependsOn: Record<string, string[]>;
  }
  const counts = (): Record<string, PlanCounts> => JSON.parse(readFixture("counts.json")) as Record<string, PlanCounts>;

  it("pins the four plans in the manifest", () => {
    expect(readManifest().map((e) => e.name).sort()).toEqual([...PLAN_NAMES].sort());
    expect(Object.keys(counts()).sort()).toEqual([...PLAN_NAMES].sort());
  });

  // D3 (fixed in parse.ts): an id-shaped heading is a phase only when a task id of its own section has that prefix.
  // D4 (fixed): Pre-flight items of a `Dogfood switch DF-<n>` section are `DF<n>.PF<k>`; Worktrees/Acceptance/DoD lists
  // of a DF section are not tasks (cpx:2041, 2156).
  // D5 (fixed): only the dependency clause of a `Depends on:` line counts (up to a sentence boundary `. ` not followed by an
  // id, a bold label, a middle dot or "parallel with"; `;` does not end it, see QA-2.3-7 and QA-2.3-27), so
  // `**Depends on:** 2.3 merged. Parallel with 3.2.` (dd:1385, dd:1426) no longer closes a 3.1/3.2 cycle.
  // D6 (fixed): the numbered section heading `## 3. Waves, phases, tasks` (vrb:468) is not a phase, and a synthetic
  // wave never shares an id with a real `Wave N` heading.
  // D7 (fixed): `**Task**` (vrb:1469) is a Tasks label, so 3.2.1 and 3.2.2 are tasks.
  // cpx: `DF<n>.FIX` is the dogfood FIX template, a `**Fallback:**` list ends the Tasks block (cpx:3904), and
  // `**Depends on:** DF-2 (and 5.1)` (cpx:3933) gates 6.1 on the plan's own DF2 section.
  // dd: counts.json corrected (1.3.2b at dd:1047 is a task; see its `correction` note).
  // D4-D7 are fixed in parse.ts (Pre-flight items of a DF section, `Depends on:` clause end, numbered section headings,
  // `**Task**` list labels and explicit ids inside a Pre-flight block), so every plan compiles to its hand counts.
  for (const name of PLAN_NAMES) {
    it(`${name} compiles to a valid draft whose counts equal the hand counts`, async () => {
      await handCountCheck(name);
    });
  }

  it("vrb has no phase for the `## 3.` section heading and 3.2.1/3.2.2 are tasks", async () => {
    const { draft } = await compileName("verification-resource-budget-plan.md");
    expect(draft.phases.map((p) => p.id)).not.toContain("3");
    expect(draft.waves.map((w) => w.id)).toEqual(["0.P", "1", "2", "3"]);
    expect(Object.keys(draft.tasks)).toContain("3.2.1");
    expect(Object.keys(draft.tasks)).toContain("3.2.2");
  });

  async function handCountCheck(name: string): Promise<void> {
    const { h, draft, summary } = await compileName(name);
    expect(isLedgerV1(draft)).toBe(true);
    expect(draft.seq).toBe(1);
    expect(h.compiler.validate(draft)).toEqual([]);
    const c = counts()[name];
    if (c === undefined) throw new Error(`no hand counts for ${name}`);
    const tasks = Object.values(draft.tasks);
    const perPhase: Record<string, number> = {};
    for (const t of tasks) if (t.phase !== null) perPhase[t.phase] = (perPhase[t.phase] ?? 0) + 1;
    // One object per side, so a mismatch prints every compiler number next to its hand count.
    const actual = {
      tasks: tasks.length,
      preflight: tasks.filter((t) => t.kind === "preflight").length,
      qa: tasks.filter((t) => t.kind === "qa").length,
      ...(c.manual !== undefined ? { manual: summary.manual.length } : {}),
      phases: draft.phases.length,
      waves: draft.waves.length,
      perPhase,
    };
    const expected = {
      tasks: c.tasks,
      preflight: c.preflight,
      qa: c.qa,
      ...(c.manual !== undefined ? { manual: c.manual } : {}),
      phases: c.phases,
      waves: c.waves,
      perPhase: c.perPhase,
    };
    // On a mismatch, name the task ids of every phase whose count differs from the hand count.
    const off = Object.keys({ ...perPhase, ...c.perPhase })
      .filter((p) => perPhase[p] !== c.perPhase[p])
      .map((p) => `${p}: ${tasks.filter((t) => t.phase === p).map((t) => t.id).join(" ")}`);
    expect(actual, `${name} ${off.join(" | ")}`).toEqual(expected);
    expect(tasks.some((t) => t.id.endsWith(".FIX"))).toBe(false);
  }

  for (const name of PLAN_NAMES) {
    it(`${name}: hand-listed Order edges and Depends-on gates are present`, async () => {
      await orderCheck(name);
    });
  }

  async function orderCheck(name: string): Promise<void> {
    const { draft } = await compileName(name);
    const c = counts()[name];
    if (c === undefined) throw new Error(`no hand counts for ${name}`);
    const keys = edgeKeys(draft);
    for (const e of c.orderEdges) expect(keys, e).toContain(e);
    for (const [phase, deps] of Object.entries(c.dependsOn)) {
      const rec = draft.phases.find((p) => p.id === phase);
      for (const d of deps) expect(rec?.dependsOn, `${phase} depends on ${d}`).toContain(d);
    }
  }

  // QA-2.3-9: exact assertions (not just "present").
  for (const name of PLAN_NAMES) {
    it(`${name}: parsed phase dependencies and the Order-edge set equal counts.json exactly`, async () => {
      const c = counts()[name];
      if (c === undefined) throw new Error(`no hand counts for ${name}`);
      const text = readFixture(name);
      const lines = text.split(/\r?\n/);
      const parsed = parsePlan(text);
      const phaseIds = new Set(parsed.phases.map((p) => p.id));
      // Independent of the parser: the phase-level `Depends on:` clauses read straight from the phase's lines (clause ends at
      // `. `, `;` or "parallel with"; only two-component phase ids count). Task-level lines (indented list items) are skipped.
      for (const ph of parsed.phases) {
        if (ph.synthetic) continue; // a `.post` phase shares the span of its parent and depends on it by construction
        const want = new Set<string>();
        for (const l of lines.slice(ph.span.line - 1, ph.span.endLine)) {
          if (/^\s{2,}/.test(l)) continue;
          const m = /Depends on(?::\*\*|\*\*:|:)\s*(.*)$/i.exec(l);
          if (m === null) continue;
          const clause = (m[1] ?? "").split(/\.\s|;|parallel with/i)[0] ?? "";
          for (const id of clause.matchAll(/(?<![\w.])(\d+\.(?:\d+|P)(?![\w]|\.\d)|DF-?\d+)/g)) {
            const pid = (id[1] ?? "").replace("DF-", "DF");
            if (phaseIds.has(pid) && pid !== ph.id) want.add(pid);
          }
        }
        const got = [...new Set(ph.dependsOn.filter((d) => !d.external).map((d) => d.id))].sort();
        expect(got, `${ph.id} Depends on`).toEqual([...want].sort());
      }
      for (const [p, deps] of Object.entries(c.dependsOn)) {
        const ph = parsed.phases.find((x) => x.id === p);
        expect(ph, `${p} is a parsed phase`).toBeDefined();
        for (const d of deps) expect(phaseIds.has(d), `${p} -> ${d}`).toBe(true);
      }
      const { draft } = await compileName(name);
      const order = draft.edges.filter((e) => e.evidence.startsWith("order ")).map((e) => `${e.from}>${e.to}`).sort();
      // counts.json lists the Depends-on gate edges (`gate:P>task`) next to the Order edges; only the latter carry `order` evidence.
      const hand = c.orderEdges.filter((k) => !k.startsWith("gate:")).sort();
      // counts.json lists the complete Order-edge set of the three smaller plans. For the cpx plan it lists only the
      // notable hand-checked edges (the other ~130 are chain/stage edges nobody hand-listed), so there it is a subset check.
      if (name === "critical-path-execution-plan.md") expect(order).toEqual(expect.arrayContaining(hand));
      else expect(order).toEqual(hand);

      // QA-2.3-24: the Order edges derived independently from the plan's own `Order:` lines (like the Depends-on check above)
      // must equal the compiled set exactly, for the cpx plan too. Arrows chain groups; `∥` and parentheses make a group;
      // an item that is no task (FIX) is dropped; a pre-flight item not listed feeds the first group; QA closes the chain.
      const taskIds = new Set(parsed.tasks.map((t) => t.id));
      const wantOrder = new Set<string>();
      for (const ph of parsed.phases) {
        if (ph.synthetic) continue;
        const own = lines.slice(ph.span.line - 1, ph.span.endLine).filter((l) => !/^\s{2,}/.test(l));
        const raw = own.map((l) => /^\W*Order\W+(.*)$/i.exec(l)?.[1]).find((x) => x !== undefined);
        if (raw === undefined) continue;
        const clause = raw.split(/\.\s/)[0] ?? "";
        const groups: string[][] = clause.split("→").map((part) =>
          [...part.matchAll(/(?<![\w.])(?:\d+\.(?:\d+|P)\.\w+|QA|FIX)(?![\w])/g)]
            .map((m) => (m[0] === "QA" ? `${ph.id}.QA` : m[0]))
            .filter((id) => taskIds.has(id)),
        ).filter((g) => g.length > 0);
        const listed = new Set(groups.flat());
        const pre = parsed.tasks.filter((t) => t.phase === ph.id && t.kind === "preflight" && !listed.has(t.id)).map((t) => t.id);
        const chain = [...(pre.length > 0 && groups.length > 0 ? [pre] : []), ...groups];
        const qaId = `${ph.id}.QA`;
        if (!listed.has(qaId) && taskIds.has(qaId) && groups.length > 0) chain.push([qaId]);
        for (let i = 0; i + 1 < chain.length; i += 1) {
          for (const a of chain[i] ?? []) for (const b of chain[i + 1] ?? []) wantOrder.add(`${a}>${b}`);
        }
      }
      expect(order).toEqual([...wantOrder].sort());
    });

    it(`${name}: every Writes:/Reads: path of a task is in its footprint`, async () => {
      const { draft, h } = await compileName(name);
      const parsed = parsePlan(readFixture(name));
      const plain = /^[\w-]+(?:\/[\w.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
      for (const t of parsed.tasks) {
        const node = draft.tasks[t.id];
        if (node === undefined) continue;
        for (const [label, list, have] of [
          ["Writes", t.writesLine, node.footprint.writes],
          ["Reads", t.readsLine, node.footprint.reads.concat(node.footprint.writes)],
        ] as const) {
          if (list === null || list.none) continue;
          for (const m of list.text.matchAll(/`([^`]+)`/g)) {
            const tok = (m[1] ?? "").replace(/\\/g, "/");
            // a Reads: path that is not tracked cannot be resolved and is reported as ignored, not kept; Writes: are always kept
            const tracked = [...h.repoView.files].some((f) => f.toLowerCase() === tok.toLowerCase());
            if (plain.test(tok) && (label === "Writes" || tracked)) expect(have.map((x) => x.toLowerCase()), `${t.id} ${label} ${tok}`).toContain(tok.toLowerCase());
          }
        }
      }
    });
  }

  it("D4: the 6.1 scenario has exactly these task ids", async () => {
    const { draft } = await compileName("critical-path-execution-plan.md", { phases: ["6.1"], doneBefore: "6.1" });
    expect(Object.keys(draft.tasks).sort()).toEqual([
      "6.1.1", "6.1.2", "6.1.3", "6.1.4", "6.1.5", "6.1.PF1", "6.1.PF2", "6.1.PF3", "6.1.QA",
    ]);
  });

  it("D4: compiles phase 6.1 of the cpx plan with everything earlier done", async () => {
    const { draft } = await compileName("critical-path-execution-plan.md", { phases: ["6.1"], doneBefore: "6.1" });
    const ids = Object.keys(draft.tasks);
    for (const id of ["6.1.1", "6.1.2", "6.1.3", "6.1.4", "6.1.5", "6.1.QA"]) expect(ids).toContain(id);
    expect(draft.tasks["6.1.4"]?.kind).toBe("manual");
    const pf = Object.values(draft.tasks).filter((t) => t.kind === "preflight");
    expect(pf.length).toBeGreaterThan(0);
    for (const t of pf) expect(t.id).toMatch(/^6\.1\.PF\d+$/);
    const satisfied = (from: string): boolean => {
      if (from.startsWith("gate:")) return draft.phases.find((p) => `gate:${p.id}` === from)?.gate === "passed";
      const s = draft.tasks[from]?.state;
      return s === "done" || s === "integrated";
    };
    for (const t of pf) {
      for (const e of draft.edges.filter((x) => x.to === t.id)) expect(satisfied(e.from), `${e.from} -> ${t.id}`).toBe(true);
    }
    const unsat = draft.edges.filter((e) => e.to === "6.1.1" && !satisfied(e.from)).map((e) => e.from).sort();
    expect(unsat).toEqual(pf.map((t) => t.id).sort());
  });
});
