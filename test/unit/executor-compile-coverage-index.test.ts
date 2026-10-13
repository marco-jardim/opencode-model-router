import { describe, expect, it } from "vitest";
import { createPlanCompiler, planIdOf, type CompilerDeps } from "../../src/executor/compile/index";
import { residueDigestOf } from "../../src/executor/compile/residue";
import { ExecutorError, PLAN_ID_PATTERN, executorDefaults, type ExecutorConfig, type TaskNode } from "../../src/executor/types";
import { NOW, ROUTE_LINE, compileOpts, makeHarness, planPathOf, stubAnnotate } from "../fixtures/cpx/plans/harness";

async function rejection(p: Promise<unknown>): Promise<ExecutorError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ExecutorError) return e;
    throw e;
  }
  throw new Error("expected the promise to reject");
}

const SIMPLE_PLAN = [
  "# Plan",
  "",
  "## Phase 1.1: First",
  "",
  "**Tasks**",
  "- **1.1.1** Add the widget",
  "  Writes: `src/widget.ts`",
  "- **1.1.2** Use the widget",
  "  Writes: `src/use.ts`",
  "  Reads: `src/widget.ts`",
  "",
].join("\n");

describe("compile happy path", () => {
  it("compiles a small plan into a valid draft", async () => {
    const h = makeHarness({ inline: { "simple.md": SIMPLE_PLAN } });
    const r = await h.compiler.compile(planPathOf("simple.md"), compileOpts(h));
    expect(r.draft.schema).toBe(1);
    expect(r.draft.seq).toBe(1);
    expect(r.draft.planId).toBe("simple");
    expect(Object.keys(r.draft.tasks).length).toBeGreaterThan(0);
    expect(r.summary.tasks).toBe(Object.keys(r.draft.tasks).length);
    expect(h.compiler.validate(r.draft)).toEqual([]);
  });
});

const TWO_PHASES = [
  "# Plan",
  "",
  "## Wave 1",
  "",
  "### Phase 1.1: First",
  "",
  "**Tasks**",
  "- **1.1.1** Add widget",
  "  Writes: `src/a.ts`",
  "- **1.1.2** Use widget",
  "  Writes: `src/b.ts`",
  "",
  "### Phase 1.2: Second",
  "Depends on: 1.1",
  "",
  "**Tasks**",
  "- **1.2.1** Another one",
  "  Writes: `src/c.ts`",
  "",
].join("\n");

describe("compile selection", () => {
  const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
  const p = planPathOf("twophase.md");

  it("compiles every phase by default", async () => {
    const r = await h.compiler.compile(p, compileOpts(h));
    expect(r.draft.phases.map((x) => x.id)).toEqual(["1.1", "1.2"]);
    expect(Object.keys(r.draft.tasks)).toEqual(["1.1.1", "1.1.2", "1.2.1"]);
    expect(r.draft.phases[1]?.dependsOn).toEqual(["1.1"]);
    expect(r.summary.phases).toBe(2);
  });

  it("rejects an empty or unknown phase selection", async () => {
    expect((await rejection(h.compiler.compile(p, compileOpts(h, { phases: [] })))).message).toContain("must not be empty");
    expect((await rejection(h.compiler.compile(p, compileOpts(h, { phases: ["9.9"] })))).message).toContain("unknown phase 9.9");
    expect((await rejection(h.compiler.compile(p, compileOpts(h, { doneBefore: "9.9" })))).message).toContain("unknown doneBefore");
  });

  it("rejects a phase whose dependency is neither selected nor earlier", async () => {
    const e = await rejection(h.compiler.compile(p, compileOpts(h, { phases: ["1.2"] })));
    expect(e.code).toBe("E_INVALID_INPUT");
    expect(e.message).toContain("depends on 1.1");
  });

  it("marks earlier phases done with a passed gate when doneBefore is given", async () => {
    const r = await h.compiler.compile(p, compileOpts(h, { phases: ["1.1", "1.2"], doneBefore: "1.2" }));
    expect(r.draft.phases.map((x) => [x.id, x.gate])).toEqual([["1.1", "passed"], ["1.2", "pending"]]);
    expect(r.draft.tasks["1.1.1"]?.state).toBe("done");
    expect(r.draft.tasks["1.2.1"]?.state).toBe("pending");
    expect(r.draft.planId).toBe("twophase-1-1--1-2-db-1-2");
    expect(r.draft.tasks["1.1.1"]?.estimate.source).toContain("done");
  });

  it("keeps only the gate of an earlier phase that is not selected", async () => {
    const r = await h.compiler.compile(p, compileOpts(h, { phases: ["1.2"], doneBefore: "1.2" }));
    expect(r.draft.phases.map((x) => [x.id, x.gate])).toEqual([["1.1", "passed"], ["1.2", "pending"]]);
    expect(Object.keys(r.draft.tasks)).toEqual(["1.2.1"]);
    expect(r.draft.edges.some((e) => e.from === "gate:1.1" && e.to === "1.2.1")).toBe(true);
  });

  it("selects a single phase without dependencies", async () => {
    const r = await h.compiler.compile(p, compileOpts(h, { phases: ["1.1"] }));
    expect(Object.keys(r.draft.tasks)).toEqual(["1.1.1", "1.1.2"]);
  });
});

describe("compile git and repo seams", () => {
  it("fails with E_GIT when a git command fails", async () => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const git = { run: async (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> => (args.join(" ") === `rev-parse --verify refs/heads/${h.view.branch}^{commit}` ? { code: 128, stdout: "" } : h.deps.git.run(args, cwd)) };
    const c = createPlanCompiler({ ...h.deps, git });
    const e = await rejection(c.compile(planPathOf("twophase.md"), compileOpts(h)));
    expect(e.code).toBe("E_GIT");
  });

  it("uses the realpath seam for the repo key", async () => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const seen: string[] = [];
    const c = createPlanCompiler({ ...h.deps, fs: { ...h.deps.fs, realpath: async (p) => { seen.push(p); return "REAL-KEY"; } } });
    const r = await c.compile(planPathOf("twophase.md"), compileOpts(h));
    expect(r.draft.repo.key).toBe("REAL-KEY");
    expect(seen).toHaveLength(1);
  });

  it("resolves a relative common git dir against the repository toplevel", async () => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES }, view: { commonDir: ".git" } });
    const r = await h.compiler.compile(planPathOf("twophase.md"), compileOpts(h));
    expect(r.draft.repo.key.replace(/\\/g, "/")).toBe(`${h.view.toplevel.replace(/\\/g, "/")}/.git`);
  });

  it("resolves a relative common git dir on a posix cwd", async () => {
    const h = makeHarness({ view: { commonDir: ".git", toplevel: "/repo" } });
    const c = createPlanCompiler({ ...h.deps, fs: { readText: async () => TWO_PHASES } });
    const r = await c.compile("/plans/twophase.md", compileOpts(h));
    expect(r.draft.repo.toplevel).toBe("/repo");
    expect(r.draft.repo.key).toBe("/repo/.git");
  });
});

describe("addTasks", () => {
  const frag = (...items: string[]): string => ["**Tasks**", ...items, ""].join("\n");
  const setup = async (over: { phases?: string[]; doneBefore?: string } = {}) => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const r = await h.compiler.compile(planPathOf("twophase.md"), compileOpts(h, over));
    return { h, ledger: r.draft };
  };

  it("adds a task to the phase named by its id prefix", async () => {
    const { h, ledger } = await setup();
    const r = h.compiler.addTasks(ledger, frag("- **1.2.2** Extra work", "  Writes: `src/d.ts`"));
    expect(r.tasks.map((t) => t.id)).toEqual(["1.2.2"]);
    expect(r.tasks[0]?.phase).toBe("1.2");
    expect(r.tasks[0]?.state).toBe("pending");
    expect(r.edges.every((e) => e.to === "1.2.2" || e.from === "1.2.2")).toBe(true);
  });

  it("rejects an empty fragment, a clashing id and a task without a phase", async () => {
    const { h, ledger } = await setup();
    const code = (text: string): string | undefined => {
      try {
        h.compiler.addTasks(ledger, text);
      } catch (e) {
        return e instanceof ExecutorError ? `${e.code}:${e.message}` : String(e);
      }
      return undefined;
    };
    expect(code("just prose\n")).toContain("E_INVALID_INPUT");
    expect(code(frag("- **1.2.1** Again", "  Writes: `src/z.ts`"))).toContain("duplicate task id 1.2.1");
    expect(code(frag("- **1.1.1** Again"))).toContain("E_INVALID_INPUT");
    expect(code(frag("- **9.9.1** Orphan", "  Writes: `src/z.ts`"))).toContain("belongs to no phase");
  });

  it("rejects a task for a phase whose gate has passed", async () => {
    const { h, ledger } = await setup({ phases: ["1.2"], doneBefore: "1.2" });
    expect(() => h.compiler.addTasks(ledger, frag("- **1.1.9** Late", "  Writes: `src/late.ts`"))).toThrow(/already passed its gate/);
  });

  it.each(["/etc/passwd", "../../x.ts", "E:/other/x.ts", "//host/share/x.ts"])("rejects a write to %s", async (path) => {
    const { h, ledger } = await setup();
    expect(() => h.compiler.addTasks(ledger, frag("- **1.2.2** Escape", `  Writes: \`${path}\``))).toThrow(/outside the repository/);
  });

  it("uses the listTrackedFiles seam and conflicts with live tasks", async () => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const asked: string[] = [];
    const c = createPlanCompiler({ ...h.deps, listTrackedFiles: (top) => { asked.push(top); return ["src/a.ts"]; } });
    const ledger = (await c.compile(planPathOf("twophase.md"), compileOpts(h))).draft;
    const r = c.addTasks(ledger, frag("- **1.1.3** Same file", "  Writes: `src/a.ts`"));
    expect(asked).toEqual([ledger.repo.toplevel]);
    expect(r.edges.some((e) => e.to === "1.1.3")).toBe(true);
  });

  it("falls back to the paths a foreign ledger knows when no files were recorded", async () => {
    const { h, ledger } = await setup();
    const fresh = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const r = fresh.compiler.addTasks(ledger, frag("- **1.2.2** Extra", "  Writes: `src/c.ts`"));
    expect(r.tasks).toHaveLength(1);
    expect(h.compiler.validate(ledger)).toEqual([]);
  });

  it("rejects a new task that an already finished task would have to wait for", async () => {
    const { h, ledger } = await setup();
    const finished = { ...ledger, tasks: { ...ledger.tasks, "1.2.1": { ...(ledger.tasks["1.2.1"] as TaskNode), state: "done" as const } } };
    let caught: unknown;
    try {
      h.compiler.addTasks(finished, frag("- **1.2.2** Too late", "  Writes: `src/d.ts`", "  This must run before 1.2.1."));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    expect((caught as ExecutorError).code).toBe("E_INVALID_INPUT");
    expect((caught as ExecutorError).message).toContain("cannot wait for a new task");
  });

  it("rejects added tasks that leave the extended ledger invalid and lists the violations", async () => {
    const { h, ledger } = await setup();
    const withQa = { ...ledger, tasks: { ...ledger.tasks, "1.2.1": { ...(ledger.tasks["1.2.1"] as TaskNode), kind: "qa" as const } } };
    let caught: unknown;
    try {
      h.compiler.addTasks(withQa, frag("- **1.2.QA** Second review", "  Writes: `src/review.ts`"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    const err = caught as ExecutorError;
    expect(err.code).toBe("E_INVALID_INPUT");
    expect(err.message).toContain("added tasks are invalid");
    const violations = (err.detail as { violations: Array<{ code: string; taskIds: string[] }> }).violations;
    expect(violations.map((v) => v.code)).toContain("qa-multiple");
    expect(violations.find((v) => v.code === "qa-multiple")?.taskIds).toContain("1.2.QA");
  });

  it("leaves a pending task alone while reopening only ready ones", async () => {
    const { h, ledger } = await setup();
    const r = h.compiler.addTasks(ledger, frag("- **1.2.2** First", "  Writes: `src/d.ts`", "  This must run before 1.2.1."));
    expect(r.edges.some((e) => e.from === "1.2.2" && e.to === "1.2.1")).toBe(true);
    expect(r.reopened).toEqual([]);
  });

  it("adds to a ledger without any task id that could be referenced", async () => {
    const { h, ledger } = await setup();
    const empty = { ...ledger, tasks: {}, edges: [] };
    const r = h.compiler.addTasks(empty, frag("- **1.2.2** Extra work", "  Writes: `src/d.ts`"));
    expect(r.tasks.map((t) => t.id)).toEqual(["1.2.2"]);
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toContain("gate:1.1>1.2.2");
    expect(r.reopened).toEqual([]);
  });

  it("rejects an id that a ledger task already uses in another case", async () => {
    const { h, ledger } = await setup();
    const lower = { ...(ledger.tasks["1.2.1"] as TaskNode), id: "1.2.qa" };
    const withLower = { ...ledger, tasks: { ...ledger.tasks, "1.2.qa": lower } };
    let caught: unknown;
    try {
      h.compiler.addTasks(withLower, frag("- **1.2.QA** Review", "  Writes: `src/review.ts`"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    expect((caught as ExecutorError).code).toBe("E_INVALID_INPUT");
    expect((caught as ExecutorError).message).toBe("task id 1.2.QA already exists in the ledger");
    expect((caught as ExecutorError).detail).toEqual({ taskId: "1.2.QA" });
  });

  it("treats a new task without write evidence as writing everything", async () => {
    const { h, ledger } = await setup();
    const r = h.compiler.addTasks(ledger, frag("- **1.2.2** Do other things in the repo", `  ${ROUTE_LINE}`));
    expect(r.tasks[0]?.footprint.confidence).toBe("unknown");
    expect(r.edges.some((e) => e.kind === "conflict" && e.from === "1.2.1" && e.to === "1.2.2")).toBe(true);
  });

  it("keeps a single conflict edge between two new tasks writing the same file", async () => {
    const { h, ledger } = await setup();
    const r = h.compiler.addTasks(ledger, frag("- **1.2.2** First", "  Writes: `src/shared.ts`", "- **1.2.3** Second", "  Writes: `src/shared.ts`"));
    const between = r.edges.filter((e) => e.from === "1.2.2" && e.to === "1.2.3");
    expect(between).toHaveLength(1);
    expect(between[0]?.kind).toBe("conflict");
    expect(new Set(r.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(r.edges.length);
  });

  it("rejects an item without an id, whose hash id names no phase", async () => {
    const { h, ledger } = await setup();
    let caught: unknown;
    try {
      h.compiler.addTasks(ledger, frag("- Tidy up the widget", "  Writes: `src/d.ts`"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    const err = caught as ExecutorError;
    expect(err.code).toBe("E_INVALID_INPUT");
    expect(err.message).toMatch(/^task S[0-9a-f]{8}-1 belongs to no phase of the ledger$/);
    expect(err.detail).toMatchObject({ phase: "main" });
  });

  it("files a task under the phase of its id prefix when it sits under a heading the ledger does not know", async () => {
    const { h, ledger } = await setup();
    const text = ["### Phase 9.9: Elsewhere", "", "**Tasks**", "- **1.2.2** Extra work", "  Writes: `src/d.ts`", ""].join("\n");
    const r = h.compiler.addTasks(ledger, text);
    expect(r.tasks.map((t) => [t.id, t.phase])).toEqual([["1.2.2", "1.2"]]);
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toContain("gate:1.1>1.2.2");
    expect(r.edges.some((e) => e.from === "gate:9.9")).toBe(false);
  });

  it("merges a fragment's phase dependencies with the ledger's without repeating them", async () => {
    const { h, ledger } = await setup();
    const text = ["### Phase 1.1: First", "", "### Phase 1.2: Second", "Depends on: 1.1", "", "**Tasks**", "- **1.2.2** Extra work", "  Writes: `src/d.ts`", ""].join("\n");
    const r = h.compiler.addTasks(ledger, text);
    expect(r.tasks.map((t) => [t.id, t.phase])).toEqual([["1.2.2", "1.2"]]);
    expect(r.edges.filter((e) => e.from === "gate:1.1" && e.to === "1.2.2")).toHaveLength(1);
  });

  it("gives a new task the gate edge of a dependency only the fragment declares", async () => {
    const { h, ledger } = await setup();
    const detached = { ...ledger, phases: ledger.phases.map((p) => ({ ...p, dependsOn: [] })) };
    const text = ["### Phase 1.1: First", "", "### Phase 1.2: Second", "Depends on: 1.1", "", "**Tasks**", "- **1.2.2** Extra work", "  Writes: `src/d.ts`", ""].join("\n");
    const r = h.compiler.addTasks(detached, text);
    expect(r.edges.filter((e) => e.from === "gate:1.1" && e.to === "1.2.2")).toHaveLength(1);
    const plain = h.compiler.addTasks(detached, frag("- **1.2.2** Extra work", "  Writes: `src/d.ts`"));
    expect(plain.edges.some((e) => e.from === "gate:1.1" && e.to === "1.2.2")).toBe(false);
  });

  it("links a new task past a finished tests stage to the successors that can still wait", async () => {
    const { h, ledger } = await setup();
    const base = ledger.tasks["1.2.1"] as TaskNode;
    const empty = { ...base.footprint, writes: [], reads: [] };
    const stage = (from: string, to: string) => ({ from, to, kind: "structural" as const, confidence: "high" as const, evidence: "stage" });
    const staged = {
      ...ledger,
      tasks: {
        ...ledger.tasks,
        "1.2.3": { ...base, id: "1.2.3", footprint: empty, state: "done" as const },
        "1.2.TESTS": { ...base, id: "1.2.TESTS", kind: "tests" as const, footprint: empty, state: "done" as const },
        "1.2.QA": { ...base, id: "1.2.QA", kind: "qa" as const, footprint: empty, state: "pending" as const },
      },
      // 1.2.9 is a stale edge target that is no longer a task of the ledger
      edges: [...ledger.edges, stage("1.2.1", "1.2.TESTS"), stage("1.2.TESTS", "1.2.3"), stage("1.2.TESTS", "1.2.9"), stage("1.2.TESTS", "1.2.QA"), stage("1.2.3", "1.2.QA")],
    };
    const r = h.compiler.addTasks(staged, frag("- **1.2.2** Extra work", "  Writes: `src/d.ts`"));
    const keys = r.edges.map((e) => `${e.from}>${e.to}`);
    expect(keys).toContain("1.2.2>1.2.QA");
    expect(r.edges.find((e) => e.from === "1.2.2" && e.to === "1.2.QA")?.kind).toBe("structural");
    expect(keys).not.toContain("1.2.2>1.2.TESTS");
    expect(keys).not.toContain("1.2.2>1.2.3");
    expect(keys).not.toContain("1.2.2>1.2.9");
    expect(r.reopened).toEqual([]);
  });

  it("rejects a gate edge from a phase only the fragment knows", async () => {
    const { h, ledger } = await setup();
    const text = ["### Phase 9.8: Elsewhere", "", "### Phase 1.2: Second", "Depends on: 9.8", "", "**Tasks**", "- **1.2.2** Extra work", "  Writes: `src/d.ts`", ""].join("\n");
    let caught: unknown;
    try {
      h.compiler.addTasks(ledger, text);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    const err = caught as ExecutorError;
    expect(err.code).toBe("E_INVALID_INPUT");
    // the gate reaches every source of phase 1.2; the first one met is refused
    expect(err.message).toMatch(/^edge gate:9\.8 -> 1\.2\.[12] names a phase that is not in the ledger$/);
    expect(err.detail).toMatchObject({ from: "gate:9.8" });
  });

  it("adds next to a ledger task that has no phase", async () => {
    const { h, ledger } = await setup();
    const loose = { ...ledger, tasks: { ...ledger.tasks, "1.1.1": { ...(ledger.tasks["1.1.1"] as TaskNode), phase: null } } };
    const r = h.compiler.addTasks(loose, frag("- **1.2.2** Extra work", "  Writes: `src/d.ts`"));
    expect(r.tasks.map((t) => [t.id, t.phase])).toEqual([["1.2.2", "1.2"]]);
    expect(r.edges.some((e) => e.from === "1.1.1" || e.to === "1.1.1")).toBe(false);
  });

  it("reopens a ready task that must now wait for a new one", async () => {
    const { h, ledger } = await setup();
    const ready = { ...ledger, tasks: { ...ledger.tasks, "1.2.1": { ...(ledger.tasks["1.2.1"] as TaskNode), state: "ready" as const } } };
    const r = h.compiler.addTasks(ready, frag("- **1.2.2** Must come first", "  Writes: `src/d.ts`", "  This must run before 1.2.1."));
    expect(r.reopened.every((id) => id === "1.2.1")).toBe(true);
  });
});

describe("mergeResidue", () => {
  const PLAN = [
    "# Plan",
    "",
    "### Phase 1.1: First",
    "",
    "**Tasks**",
    "- **1.1.1** Do things in the repo",
    "- **1.1.2** Do other things in the repo",
    "",
  ].join("\n");

  it("asks for residue, merges a valid answer and rejects a bad one", async () => {
    const h = makeHarness({ inline: { "resid.md": PLAN } });
    const r = await h.compiler.compile(planPathOf("resid.md"), compileOpts(h));
    expect(r.residueRequest).toBeDefined();
    expect(r.draft.status).toBe("awaiting-residue");
    const digest = residueDigestOf(r.draft.planDigest, r.residueRequest?.taskIds ?? []);
    const good = JSON.stringify({
      requestDigest: digest,
      footprints: [{ taskId: "1.1.1", writes: ["src/x.ts"], reads: [], evidence: "found" }],
      edges: [],
      noChange: ["1.1.2"],
    });
    const m = h.compiler.mergeResidue(r.draft, `DONE:\n\`\`\`json\n${good}\n\`\`\``);
    expect(m.draft.status).toBe("awaiting-approval");
    expect(m.draft.tasks["1.1.1"]?.footprint.writes).toEqual(["src/x.ts"]);
    expect(m.draft.tasks["1.1.2"]?.footprint.confidence).toBe("inferred");
    expect(m.summary.tasks).toBe(2);
    expect(r.draft.status).toBe("awaiting-residue");

    let caught: unknown;
    try {
      h.compiler.mergeResidue(r.draft, "not json");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    expect((caught as ExecutorError).code).toBe("E_RESIDUE");
    expect((caught as ExecutorError).message).toContain("residue-json");
  });

  it("rejects a merge that leaves an invalid plan", async () => {
    const h = makeHarness({ inline: { "resid.md": PLAN } });
    const r = await h.compiler.compile(planPathOf("resid.md"), compileOpts(h));
    const digest = residueDigestOf(r.draft.planDigest, r.residueRequest?.taskIds ?? []);
    const wrongWrites = JSON.stringify({
      requestDigest: digest,
      footprints: [{ taskId: "1.1.1", writes: ["a/b"], reads: [], evidence: "x" }, { taskId: "1.1.2", writes: ["a/b/c"], reads: [], evidence: "x" }],
      edges: [],
    });
    const m = h.compiler.mergeResidue(r.draft, wrongWrites);
    expect(h.compiler.validate(m.draft)).toEqual([]);
    expect(m.draft.edges.some((e) => e.kind === "conflict")).toBe(true);
  });

  it("refuses a merge whose result breaks the ledger and lists both kinds of violation", async () => {
    const h = makeHarness({ inline: { "resid.md": PLAN } });
    const r = await h.compiler.compile(planPathOf("resid.md"), compileOpts(h));
    const digest = residueDigestOf(r.draft.planDigest, r.residueRequest?.taskIds ?? []);
    const answer = JSON.stringify({
      requestDigest: digest,
      footprints: [{ taskId: "1.1.1", writes: ["src/x.ts"], reads: [], evidence: "found" }],
      edges: [],
      noChange: ["1.1.2"],
    });
    const broken = { ...r.draft, repo: { ...r.draft.repo, baseCommit: "not-a-commit" } };
    let caught: unknown;
    try {
      h.compiler.mergeResidue(broken, answer);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecutorError);
    const err = caught as ExecutorError;
    expect(err.code).toBe("E_RESIDUE");
    expect(err.message).toBe("the merged residue leaves an invalid plan");
    const detail = err.detail as { code: string; violations: Array<{ code: string; taskIds: string[] }>; ledger: string[] };
    expect(detail.code).toBe("residue-invalid");
    expect(detail.violations.map((v) => v.code)).toContain("ledger:git-id");
    expect(detail.ledger).toContain("git-id at $.repo.baseCommit");
  });
});

describe("shared context", () => {
  it("replaces worktree paths, strips header-shaped lines and cuts at the cap", async () => {
    const header = "[plan demo-plan:1.1.1#1] nonce=" + "a".repeat(32);
    const plan = [
      "# Plan",
      "",
      "<!-- plan-context -->",
      "Repo lives at D:\\fake\\repo\\src and D:/fake/repo/.",
      header,
      "line three",
      "<!-- /plan-context -->",
      "",
      "### Phase 1.1: First",
      "",
      "**Tasks**",
      "- **1.1.1** Do it",
      "  Writes: `src/a.ts`",
      "",
    ].join("\n");
    const h = makeHarness({ inline: { "ctx.md": plan }, view: { toplevel: "D:\\fake\\repo", worktrees: ["D:\\fake\\repo"] } });
    const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h));
    expect(r.draft.sharedContext).toContain("<worktree>");
    expect(r.draft.sharedContext).not.toContain("D:\\fake\\repo");
    expect(r.draft.sharedContext).toContain("[header-shaped line removed]");
    expect(r.summary.warnings.some((w) => w.startsWith("shared-context-header"))).toBe(true);

    const cap = { ...h.config, sharedContextChars: 40 };
    const cut = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h, { config: cap }));
    expect(cut.draft.sharedContext.length).toBeLessThanOrEqual(40);
    expect(cut.summary.warnings.some((w) => w.startsWith("shared-context-truncated"))).toBe(true);
  });
});

describe("compile routing fields", () => {
  it("takes the tier from the engine route line when the annotation carries no valid tier", async () => {
    const h = makeHarness({ inline: { "simple.md": SIMPLE_PLAN } });
    const base = stubAnnotate();
    const annotate: CompilerDeps["annotate"] = async (steps) => {
      const plan = await base(steps);
      for (const s of plan) {
        Reflect.set(s, "tier", "auto");
        Reflect.set(s, "routeLine", "[route class=implement risk=low scope=single d=none tier=heavy]");
      }
      return plan;
    };
    const c = createPlanCompiler({ ...h.deps, annotate });
    const r = await c.compile(planPathOf("simple.md"), compileOpts(h));
    const t = r.draft.tasks["1.1.1"];
    expect(t?.route.tier).toBe("heavy");
    expect(t?.route.role).toBe("role-heavy");
    expect(t?.route.line).toContain("tier=heavy");
  });
});

describe("compile self-check", () => {
  it("refuses a draft that breaks the ledger schema and names the ledger violation", async () => {
    const h = makeHarness({ inline: { "twophase.md": TWO_PHASES } });
    const git = { run: async (args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> => (args.join(" ") === `rev-parse --verify refs/heads/${h.view.branch}^{commit}` ? { code: 0, stdout: "not-a-commit\n" } : h.deps.git.run(args, cwd)) };
    const c = createPlanCompiler({ ...h.deps, git });
    const e = await rejection(c.compile(planPathOf("twophase.md"), compileOpts(h)));
    expect(e.code).toBe("E_COMPILE");
    expect(e.message).toMatch(/^compiled draft is invalid: /);
    const detail = e.detail as { code: string; line: number; violations: Array<{ code: string; message: string; taskIds: string[] }>; ledger: string[] };
    expect(detail.code).toBe("draft-invalid");
    expect(detail.line).toBe(0);
    expect(detail.violations.map((v) => v.code)).toContain("ledger:git-id");
    expect(detail.ledger).toContain("git-id at $.repo.baseCommit");
    const first = detail.violations[0];
    expect(e.message).toBe(`compiled draft is invalid: ${first?.code}: ${first?.message}`);
  });
});

describe("shared context roots", () => {
  const ctxPlan = (...context: string[]): string =>
    ["# Plan", "", "<!-- plan-context -->", ...context, "<!-- /plan-context -->", "", "### Phase 1.1: First", "", "**Tasks**", "- **1.1.1** Do it", "  Writes: `src/a.ts`", ""].join("\n");

  it("replaces a root that is not followed by a separator with a bare placeholder", async () => {
    const h = makeHarness({ inline: { "ctx.md": ctxPlan("Repo lives at D:\\fake\\repo today.") }, view: { toplevel: "D:\\fake\\repo", worktrees: ["D:\\fake\\repo"] } });
    const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h));
    expect(r.draft.sharedContext).toContain("Repo lives at <worktree> today.");
  });

  it("replaces UNC and posix worktree roots and keeps their separator style", async () => {
    const h = makeHarness({
      inline: { "ctx.md": ctxPlan("UNC \\\\host\\share\\wt\\x.ts and posix /srv/wt/y.ts end") },
      view: { toplevel: "D:\\fake\\repo", worktrees: ["D:\\fake\\repo", "\\\\host\\share\\wt", "/srv/wt"] },
    });
    const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h));
    expect(r.draft.sharedContext).toContain("UNC <worktree>\\x.ts and posix <worktree>/y.ts end");
  });

  it("does not split a surrogate pair when the cap falls inside it on a single line", async () => {
    const h = makeHarness({ inline: { "ctx.md": ctxPlan(`${"x".repeat(39)}\u{1F600}tail`) } });
    const cap = { ...h.config, sharedContextChars: 40 };
    const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h, { config: cap }));
    expect(r.draft.sharedContext).toBe("x".repeat(39));
    expect(r.summary.warnings).toContain("shared-context-truncated: shared context cut to 39 of 45 chars");
  });

  it("ignores a worktree root that has no path segment", async () => {
    const h = makeHarness({ inline: { "ctx.md": ctxPlan("keep a/b and \\c\\d as they are") }, view: { toplevel: "D:\\fake\\repo", worktrees: ["D:\\fake\\repo", "/", "\\"] } });
    const r = await h.compiler.compile(planPathOf("ctx.md"), compileOpts(h));
    expect(r.draft.sharedContext).toContain("keep a/b and \\c\\d as they are");
    expect(r.draft.sharedContext).not.toContain("<worktree>");
  });
});

describe("compile input checks", () => {
  const h = makeHarness({ inline: { "x.md": "# Plan\n" } });
  const good = (): ExecutorConfig => executorDefaults();
  const run = (config: ExecutorConfig, over: { now?: string; sid?: string; path?: string } = {}): Promise<unknown> =>
    h.compiler.compile(over.path ?? planPathOf("x.md"), { config, orchestratorSessionID: over.sid ?? "s", now: over.now ?? NOW });
  const withCfg = (patch: Record<string, unknown>): ExecutorConfig => ({ ...good(), ...patch }) as ExecutorConfig;

  it("rejects a relative plan path", async () => {
    const e = await rejection(run(good(), { path: "plans/x.md" }));
    expect(e.code).toBe("E_INVALID_INPUT");
    expect(e.message).toContain("absolute");
  });

  it.each(["2026-10-11", "2026-10-11T10:00:00Z", "2026-13-45T10:00:00.000Z", ""])("rejects now=%j", async (now) => {
    expect((await rejection(run(good(), { now }))).message).toContain("ISO");
  });

  it("rejects an empty orchestrator session id", async () => {
    expect((await rejection(run(good(), { sid: "" }))).message).toContain("orchestratorSessionID");
  });

  it("rejects a config that is not an object", async () => {
    const e = await rejection(h.compiler.compile(planPathOf("x.md"), { config: null as unknown as ExecutorConfig, orchestratorSessionID: "s", now: NOW }));
    expect(e.message).toBe("config must be an object");
  });

  it.each([
    ["maxParallel", { maxParallel: 0 }],
    ["maxParallel", { maxParallel: 2.5 }],
    ["batchMax", { batchMax: 9 }],
    ["maxAttempts", { maxAttempts: 7 }],
    ["qaMaxRounds", { qaMaxRounds: 0 }],
    ["sharedContextChars", { sharedContextChars: -1 }],
    ["capacityCooldownMs", { capacityCooldownMs: 1 }],
    ["capacityPauseMs", { capacityPauseMs: 1 }],
    ["wakeDebounceMs", { wakeDebounceMs: 5 }],
    ["circuitBreaker.failureRatio", { circuitBreaker: { ...good().circuitBreaker, failureRatio: 0 } }],
    ["circuitBreaker.minAttempts", { circuitBreaker: { ...good().circuitBreaker, minAttempts: 0 } }],
    ["circuitBreaker.consecutiveFailures", { circuitBreaker: { ...good().circuitBreaker, consecutiveFailures: 99 } }],
    ["circuitBreaker.failureRatio", { circuitBreaker: undefined }],
  ])("rejects an out-of-range config.%s", async (name, patch) => {
    const e = await rejection(run(withCfg(patch)));
    expect(e.code).toBe("E_INVALID_INPUT");
    expect(e.message).toContain(`config.${name}`);
  });

  it.each([
    ["approve", { approve: "never" }],
    ["crossPhase", { crossPhase: "x" }],
    ["land", { land: "x" }],
    ["slotsDir", { slotsDir: 3 }],
    ["python", { python: 3 }],
    ["integrationChecks", { integrationChecks: "none" }],
    ["integrationChecks", { integrationChecks: [{ script: "t", args: [1] }] }],
    ["integrationChecks", { integrationChecks: [null] }],
    ["phaseSuite", { phaseSuite: "on" }],
    ["provision", { provision: "none" }],
    ["provision", { provision: [] }],
    ["provision", { provision: null }],
    ["provision", { provision: { npm: "x" } }],
    ["provision", { provision: { npm: [[1]] } }],
  ])("rejects a bad config.%s", async (name, patch) => {
    const e = await rejection(run(withCfg(patch)));
    expect(e.code).toBe("E_INVALID_INPUT");
    expect(e.message).toContain(`config.${name}`);
  });

  it("accepts command lists and a provision map", async () => {
    const cfg = withCfg({
      integrationChecks: [{ script: "test", args: ["a"] }],
      phaseSuite: [{ script: "test", args: [] }],
      provision: { npm: [["ci"], ["run", "build"]] },
      slotsDir: "D:\\slots",
    });
    const r = (await h.compiler.compile(planPathOf("x.md"), compileOpts(h, { config: cfg }))) as { draft: { config: ExecutorConfig } };
    expect(r.draft.config).toEqual(cfg);
    expect(r.draft.config).not.toBe(cfg);
  });
});

describe("planIdOf coverage", () => {
  it("slugs the file name without its extension", () => {
    expect(planIdOf("D:\\plans\\My Plan.md", undefined)).toBe("my-plan");
    expect(planIdOf("/plans/roadmap.v2.md", undefined)).toBe("roadmap-v2");
  });

  it("keeps a dotfile name whole", () => {
    expect(planIdOf("/plans/.plan", undefined)).toBe("plan");
  });

  it("appends the selected phases and doneBefore", () => {
    expect(planIdOf("/p/plan.md", ["1.1", "2"])).toBe("plan-1-1--2");
    expect(planIdOf("/p/plan.md", ["1.1.2"])).not.toBe(planIdOf("/p/plan.md", ["1.1", "2"]));
    expect(planIdOf("/p/plan.md", [], "1.2")).toBe("plan-db-1-2");
    expect(planIdOf("/p/plan.md", ["a"], "b")).toBe("plan-a-db-b");
  });

  it("falls back to 'plan' when the name has no slug characters", () => {
    expect(planIdOf("/p/日本.md", undefined)).toMatch(PLAN_ID_PATTERN);
    expect(planIdOf("/", undefined)).toMatch(PLAN_ID_PATTERN);
  });

  it("shortens long ids deterministically with a hash suffix", () => {
    const long = `/p/${"abcdefgh-".repeat(10)}x.md`;
    const id = planIdOf(long, undefined);
    expect(id.length).toBeLessThanOrEqual(41);
    expect(id).toMatch(PLAN_ID_PATTERN);
    expect(planIdOf(long, undefined)).toBe(id);
    expect(planIdOf(`${long}`.replace("x.md", "y.md"), undefined)).not.toBe(id);
  });

  it("produces a valid id even for very short names", () => {
    expect(planIdOf("/p/a.md", undefined)).toMatch(PLAN_ID_PATTERN);
  });
});
