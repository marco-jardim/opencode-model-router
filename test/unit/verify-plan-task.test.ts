// Phase 5.1.1b: the plan-task verifier over the dispatch verification engine (D8-D11, A-5.1-8/-9/-12/-13), with engine doubles.
// Integration with a real slot is 5.1.5's.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acceptMock = vi.hoisted(() => vi.fn());
const snapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/verify/gate", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/verify/gate")>()), accept: acceptMock }));
vi.mock("../../src/verify/tree", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/verify/tree")>()), snapshotTree: snapshotMock }));

import { gateResult, type Artefact, type Delegation, type GateDeps, type GateResult } from "../../src/verify/gate";
import { waitTreeFreeExcept, type PreparedVerification } from "../../src/verify/wiring";
import { execFileSync } from "node:child_process";
import { RouterTimeoutError } from "../../src/verify/timeout";
import { PLAN_TASK_PERIMETER_ID, planPerimeter } from "../../src/verify/perimeter";
import * as configModule from "../../src/router/config";
import { leaseHolderID, type Attempt, type SlotLease, type TaskNode } from "../../src/executor/types";
import type { PlanTaskContext, PlanTaskVerifier } from "../../src/executor/runtime";
import {
  PLAN_TASK_CHECKS_MIN_MS, PLAN_TASK_FINDINGS_MAX, PLAN_TASK_GRADER_SLACK_MS, PLAN_TASK_RERUN_BACKOFF_MS, PLAN_TASK_RETURN_TEXT_MAX,
  PLAN_TASK_TRANSIENT_RERUNS, planTaskReturnText,
  combineMixedPasses, createLeaseSelfExemptions, createPlanTaskVerifier as createRawPlanTaskVerifier, graderTierFor, isPlanTaskVerificationID, isTransientPlanTaskResult,
  planTaskChecksBudgetMs, planTaskDoD, planTaskGit, planTaskGraderBudgetMs, planTaskProducerTier, planTaskVerificationID,
  planTreeKey, slotVerdictOf, type PlanTaskVerifierDeps,
} from "../../src/verify/plan-task";

const bundled = JSON.parse(readFileSync(fileURLToPath(new URL("../../tiers.json", import.meta.url)), "utf8")) as Record<string, unknown>;
function config(strict = false): configModule.RouterConfig {
  return configModule.validateConfig({ ...bundled,
    routing: { delegation: "roles", leases: { mode: "enforce" } },
    enforcement: { verify: { require: "always", strictUnverifiable: strict } },
  });
}

const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const OTHER = "c".repeat(40);
const NONCE = "nonce-1234";

let slotPath = "";
beforeEach(() => {
  slotPath = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-plan-task-")));
  acceptMock.mockReset();
  snapshotMock.mockReset();
  snapshotMock.mockImplementation(async (cwd: string) => ({ root: cwd, head: CANDIDATE, branch: "omr/p1/t/t1", entries: new Map() }));
});
afterEach(() => {
  rmSync(slotPath, { recursive: true, force: true });
});

function task(over: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "t1", title: "Task one", phase: null, kind: "task", subtasks: [],
    text: "Implement the thing.\n[acceptance]\ncheck: testsPass\n[/acceptance]",
    route: { line: "[route class=implement]", role: "implementer", tier: "medium", pin: false },
    verify: "required", acceptance: null,
    footprint: { writes: [], reads: [], confidence: "unknown", sources: [] },
    estimate: { p50: 1, p90: 2, source: "test" }, state: "verifying", attempts: [], slot: "s1", branch: "omr/p1/t/t1", integrated: null,
    ...over,
  } as TaskNode;
}
function slot(): SlotLease { return { slot: "s1", path: slotPath, planId: "p1", owner: leaseHolderID("p1", "t1"), commit: BASE }; }
function attempt(over: Partial<Attempt> = {}): Attempt {
  return { n: 1, nonce: NONCE, callID: null, childSessionID: "child-1", startedAt: "2026-10-13T00:00:00.000Z", endedAt: null,
    outcome: "succeeded", verdict: null, context: "", ...over };
}

function prepared(over: Partial<PreparedVerification> = {}): PreparedVerification {
  return { changedFiles: [{ path: join(slotPath, "a.ts"), status: "M" }], changeBaseline: "available", reference: { kind: "none", reason: "test" },
    snapshot: undefined, producerSessionID: "child-1", ...over } as PreparedVerification;
}

const pass = (method: "deterministic" | "checker" = "deterministic"): GateResult =>
  gateResult({ pass: true, outcome: "pass", method, reasons: [`${method} ok`], ...(method === "checker" ? { grader: { tier: "heavy", model: null } } : {}) }, "explicit");
const fail = (reason = "tests failed"): GateResult => gateResult({ pass: false, outcome: "fail", method: "deterministic", reasons: [reason] }, "explicit");
const unverifiable = (reason: string, strict = false): GateResult =>
  gateResult({ pass: false, outcome: "unverifiable", method: "checker", reasons: [reason], caveats: [reason] }, "explicit", strict);

interface Harness {
  deps: PlanTaskVerifierDeps;
  git: { head: string; branch: string; parent: string; message: string; diff: string; ancestor: boolean };
  sleeps: number[];
  aborted: string[];
  prepareCalls: unknown[][];
  gateDepsCalls: unknown[][];
  cleared: string[];
  verdicts: string[];
  exemptDuringGate: Array<ReadonlySet<string>>;
  gateDeps: GateDeps[];
  logs: string[];
}

function harness(opts: { prepared?: PreparedVerification | (() => PreparedVerification); strict?: boolean; orchestrator?: string | null; perimeterPlanned?: boolean } = {}): Harness {
  const h: Harness = {
    git: { head: BASE, branch: "", parent: BASE, message: `omr: t1\n\nOmr-Attempt: ${NONCE}\n`, diff: "M\0a.ts\0A\0b.ts\0", ancestor: true },
    sleeps: [], aborted: [], prepareCalls: [], gateDepsCalls: [], cleared: [], verdicts: [], exemptDuringGate: [], gateDeps: [], logs: [],
    deps: undefined as unknown as PlanTaskVerifierDeps,
  };
  const exemptions = createLeaseSelfExemptions((root) => planTreeKey(root));
  const cfg = config(opts.strict ?? false);
  h.deps = {
    changedFileStore: { clear: (id: string) => { h.cleared.push(id); } } as unknown as PlanTaskVerifierDeps["changedFileStore"],
    beginVerificationBounded: vi.fn(async () => {}),
    prepareVerification: vi.fn(async (...args: unknown[]) => {
      h.prepareCalls.push(args);
      const p = opts.prepared;
      return typeof p === "function" ? p() : p ?? prepared();
    }) as unknown as PlanTaskVerifierDeps["prepareVerification"],
    buildGateDeps: vi.fn((...args: unknown[]) => {
      h.gateDepsCalls.push(args);
      // D11: the gate deps are built inside the gate's exemption window; record what the lease registry exempts then.
      h.exemptDuringGate.push(exemptions.exemptFor(slotPath));
      const built = { deterministic: {}, checker: { ladder: ["fast", "medium", "heavy"], minGraderTier: null } } as unknown as GateDeps;
      h.gateDeps.push(built);
      return built;
    }) as unknown as PlanTaskVerifierDeps["buildGateDeps"],
    captureBudget: () => undefined,
    readCapReached: () => undefined,
    onVerdict: (_child, verdict) => { h.verdicts.push(verdict.outcome ?? ""); },
    abortSession: async (id) => { h.aborted.push(id); },
    getConfig: () => cfg,
    git: async (args) => {
      const a = args.join(" ");
      if (a === "rev-parse --verify --quiet HEAD^{commit}") return { code: 0, stdout: `${h.git.head}\n`, stderr: "" };
      if (a.startsWith("rev-parse --verify --quiet") && a.endsWith("^1^{commit}")) return { code: 0, stdout: `${h.git.parent}\n`, stderr: "" };
      if (a === "symbolic-ref --quiet HEAD") return h.git.branch === "" ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: `refs/heads/${h.git.branch}\n`, stderr: "" };
      if (a.startsWith("merge-base --is-ancestor")) return { code: h.git.ancestor ? 0 : 1, stdout: "", stderr: "" };
      if (a.startsWith("diff --name-status -z -M")) return { code: 0, stdout: h.git.diff, stderr: "" };
      if (a.startsWith("log -1 --format=%B")) return { code: 0, stdout: h.git.message, stderr: "" };
      if (a === "rev-parse --show-toplevel") return { code: 0, stdout: `${slotPath}\n`, stderr: "" };
      return { code: 128, stdout: "", stderr: `unexpected git ${a}` };
    },
    exemptions,
    perimeterPlanned: () => opts.perimeterPlanned ?? false,
    sleep: async (ms) => { h.sleeps.push(ms); },
    now: () => 1_000,
    log: (message) => { h.logs.push(message); },
  };
  // QA-5.1-6: the runtime hands the plan's orchestrator to every hook; the harness plays the runtime (null: unknown).
  orchestrators.set(h.deps, { orchestratorSessionID: opts.orchestrator === undefined ? "orch-1" : opts.orchestrator ?? "" });
  // The harness never touches acceptMock: each test owns its implementations (persistent and `Once`), unaltered.
  return h;
}

/** The orchestrator the runtime would pass with each hook of a harness's verifier. */
const orchestrators = new WeakMap<PlanTaskVerifierDeps, PlanTaskContext>();

/** The verifier under test, called as the runtime calls it: each hook gets the harness's context unless the test passes one. */
function createPlanTaskVerifier(deps: PlanTaskVerifierDeps): PlanTaskVerifier {
  const v = createRawPlanTaskVerifier(deps);
  const ctx = (given: PlanTaskContext | undefined): PlanTaskContext => given ?? orchestrators.get(deps) ?? { orchestratorSessionID: "orch-1" };
  return {
    begin: (t, s, a, c) => v.begin?.(t, s, a, ctx(c)),
    observe: (t, s, a, f, c) => v.observe?.(t, s, a, f, ctx(c)),
    verify: (t, s, a, c) => v.verify(t, s, a, ctx(c)),
    forget: (planId, taskId, n) => v.forget?.(planId, taskId, n),
    dispose: () => v.dispose?.() ?? Promise.resolve(),
    get disposing() { return v.disposing; },
  };
}

/** begin (after the reset), observe (before the router's commit), the router's commit and switch, observe again, verify. */
async function runAttempt(h: Harness, t: TaskNode = task(), a: Attempt = attempt()) {
  const v = createPlanTaskVerifier(h.deps);
  await v.begin?.(t, slot(), a);
  await v.observe?.(t, slot(), a);
  h.git.head = CANDIDATE;
  h.git.branch = t.branch ?? "";
  await v.observe?.(t, slot(), a);
  return v.verify(t, slot(), a);
}

const delegationOf = (call: number): Delegation => acceptMock.mock.calls[call]![0] as Delegation;
const artefactOf = (call: number): Artefact => acceptMock.mock.calls[call]![1] as Artefact;

describe("plan-task verifier (D8)", () => {
  it("V1: runs the checks in the slot, on the fresh post-commit snapshot", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    const result = await runAttempt(h);
    expect(result.verdict).toBe("pass");
    expect(acceptMock).toHaveBeenCalledTimes(1);
    const d = delegationOf(0);
    expect(d.workRoot).toBe(slotPath);
    expect(d.cwd).toBe(slotPath);
    expect(d.trivial).toBe(false);
    expect(d.dod.checks.map((c) => c.kind)).toEqual(["testsPass"]);
    const preparedForGate = h.gateDepsCalls[0]![2] as PreparedVerification;
    expect(preparedForGate.snapshot?.root).toBe(slotPath);
    expect(snapshotMock).toHaveBeenCalledWith(slotPath, expect.anything(), expect.anything());
    expect(h.deps.beginVerificationBounded).toHaveBeenCalledWith(h.deps.changedFileStore, planTaskVerificationID("orch-1", "p1", "t1", 1), slotPath, expect.anything());
  });

  it("V2: the grader is parented to the orchestrator, scoped to the slot, never below the producer tier, and independent of the child", async () => {
    acceptMock.mockImplementation(async () => pass("checker"));
    const h = harness();
    const result = await runAttempt(h, task({ text: "Explain the thing.\n[acceptance]\ncriteria: the docs explain it\n[/acceptance]" }));
    expect(result).toMatchObject({ verdict: "pass", ref: "checker:heavy" });
    const [parent, inFlight, , , lowPriority, creator] = h.gateDepsCalls[0]!;
    expect(parent).toBe("orch-1");
    expect(creator).toBe("orch-1");
    expect(lowPriority).toBe(false);
    expect(inFlight).toBeInstanceOf(Set);
    expect(delegationOf(0).cwd).toBe(slotPath);
    expect(artefactOf(0).producerSessionID).toBe("child-1");
    // A role producer is named by its agent (as a role dispatch's subagent_type): unknown to the ladder, so the grader is heavy,
    // never the routed tier ("medium") that would lower it.
    const producer = artefactOf(0).producerTier;
    expect(producer).toBe(planTaskProducerTier(task(), h.deps.getConfig()));
    expect(["fast", "medium", "heavy"]).not.toContain(producer);
    expect(graderTierFor(producer, h.deps.getConfig())).toBe("heavy");
    expect(delegationOf(0).dod.kind).toBe("checker");
  });

  it("V3: a grader timeout is re-run twice with 30 s then 60 s backoff, then settles unverifiable once", async () => {
    acceptMock.mockImplementation(async () => unverifiable("grader dispatch failed: grader prompt timed out after 300000ms"));
    const h = harness();
    const result = await runAttempt(h, task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" }));
    expect(result.verdict).toBe("unverifiable");
    expect(acceptMock).toHaveBeenCalledTimes(1 + PLAN_TASK_TRANSIENT_RERUNS);
    expect(h.sleeps).toEqual([...PLAN_TASK_RERUN_BACKOFF_MS]);
    expect(PLAN_TASK_RERUN_BACKOFF_MS).toEqual([30_000, 60_000]);
    // One settled verdict: one breaker sample for the runtime.
    expect(h.verdicts).toEqual(["unverifiable"]);
  });

  it("V3: a transient unverifiable that clears on a re-run takes the re-run's verdict", async () => {
    acceptMock.mockImplementationOnce(async () => unverifiable("grader dispatch failed: 503")).mockImplementation(async () => pass("checker"));
    const h = harness();
    const result = await runAttempt(h, task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" }));
    expect(result.verdict).toBe("pass");
    expect(h.sleeps).toEqual([30_000]);
  });

  it("V4: a cut gate aborts the deadline and its grader sessions, then is unverifiable", async () => {
    acceptMock.mockImplementation(async (_d: Delegation, _a: Artefact) => {
      const inFlight = h.gateDepsCalls[h.gateDepsCalls.length - 1]![1] as Set<string>;
      inFlight.add(`grader-${h.gateDepsCalls.length}`);
      throw new RouterTimeoutError("verification gate", 1);
    });
    const h = harness();
    const result = await runAttempt(h, task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" }));
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/verification gate timed out/);
    expect(h.aborted).toEqual(["grader-1", "grader-2", "grader-3"]);
    const deadline = h.gateDepsCalls[0]![3] as { signal: AbortSignal };
    expect(deadline.signal.aborted).toBe(true);
  });

  it("V4/A-5.1-9: the pass deadlines", () => {
    expect(PLAN_TASK_CHECKS_MIN_MS).toBe(600_000);
    expect(PLAN_TASK_GRADER_SLACK_MS).toBe(60_000);
    expect(planTaskChecksBudgetMs(120_000)).toBe(600_000);
    expect(planTaskChecksBudgetMs(900_000)).toBe(900_000);
    expect(planTaskGraderBudgetMs(0, "heavy", 300_000)).toBe(360_000);
    expect(planTaskGraderBudgetMs(1_000_000, "heavy", 300_000)).toBe(1_000_000);
  });

  it("QA-5.1-3: a progress-note final text of the child is incomplete under the REAL gate, never PASS", async () => {
    const real = await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
    acceptMock.mockImplementation(real.accept);
    const h = harness();
    const graded: string[] = [];
    // A grader that would pass anything: without the return contract the progress note is graded and passes.
    h.deps.buildGateDeps = ((...args: unknown[]) => {
      h.gateDepsCalls.push(args);
      return {
        deterministic: {},
        checker: {
          ladder: ["fast", "medium", "heavy"], minGraderTier: null,
          budgetSnapshot: () => ({ tracked: false, stopped: false, usedUp: false }),
          dispatchGrader: async (req: { tier: string }) => { graded.push(req.tier); return { sessionID: "grader-1", text: '{"pass": true, "reasons": ["looks done"]}' }; },
        },
      } as unknown as GateDeps;
    }) as unknown as PlanTaskVerifierDeps["buildGateDeps"];
    const t = task({ text: "Explain the thing.\n[acceptance]\ncriteria: the docs explain it\n[/acceptance]" });
    const v = createPlanTaskVerifier(h.deps);
    const a = attempt();
    await v.begin?.(t, slot(), a);
    h.git.head = CANDIDATE;
    h.git.branch = t.branch ?? "";
    // A progress note by the checker's definition (checker.ts isProgressNote: no contract marker, the final sentence a
    // first-person announcement of finishing or continuing). The role-dispatch fixture of verify.criteria.test.ts.
    const note = "Edited src/a.ts. I'll finish the tests next.";
    const checker = await import("../../src/verify/checker");
    expect(checker.isProgressNote(note)).toBe(true);
    await v.observe?.(t, slot(), a, note);
    const result = await v.verify(t, slot(), a);
    expect(artefactOf(0).returnContract).toBe(true);
    expect(artefactOf(0).finalReturnText).toBe(note);
    expect(result.verdict).not.toBe("pass");
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/^incomplete: the delegate returned a progress note/);
    // Incomplete before any grader ran.
    expect(graded).toEqual([]);
    // Parity with a role dispatch: the same gate on the same artefact, as index.ts builds it for a role (returnContract).
    const dispatch = await real.accept({ dod: delegationOf(0).dod, trivial: false, mode: "modeA" }, artefactOf(0), h.deps.buildGateDeps(
      "orch-1", new Set(), prepared(), { signal: new AbortController().signal } as never, false, "orch-1"));
    expect(dispatch.verdict.reasons).toEqual([checker.INCOMPLETE_REASON]);
    expect(graded).toEqual([]);
    // "Now I'll run the tests" is no progress note for any producer (a dispatch grades it too): parity, not a plan-task gap.
    expect(checker.isProgressNote("Now I'll run the tests")).toBe(false);
    // The router's own commit description (no child text) is not a child return: no contract.
    acceptMock.mockClear();
    const v2 = createPlanTaskVerifier(h.deps);
    await v2.begin?.(t, slot(), a);
    await v2.observe?.(t, slot(), a);
    await v2.verify(t, slot(), a);
    expect(artefactOf(0).returnContract).toBeUndefined();
  });
});

describe("mixed blocks (D9, A-5.1-8)", () => {
  const mixed = task({ text: "x\n[acceptance]\ncheck: testsPass\ncriteria: the change is documented\n[/acceptance]" });

  it("V5: checks first, then the grader on the criteria alone; PASS only if both pass", async () => {
    acceptMock.mockImplementationOnce(async () => pass()).mockImplementationOnce(async () => pass("checker"));
    const h = harness();
    const result = await runAttempt(h, mixed);
    expect(result.verdict).toBe("pass");
    expect(acceptMock).toHaveBeenCalledTimes(2);
    expect(delegationOf(0).dod.kind).toBe("deterministic");
    expect(delegationOf(1).dod.kind).toBe("checker");
    expect(delegationOf(1).dod.checks).toEqual([]);
    expect(delegationOf(1).dod.criteria.length).toBeGreaterThan(0);
  });

  it("V5: a check fail dispatches no grader", async () => {
    acceptMock.mockImplementation(async () => fail());
    const h = harness();
    expect((await runAttempt(h, mixed)).verdict).toBe("fail");
    expect(acceptMock).toHaveBeenCalledTimes(1);
  });

  it("V5: checks pass and the grader fails or is unverifiable", async () => {
    acceptMock.mockImplementationOnce(async () => pass()).mockImplementationOnce(async () => fail("criteria unmet"));
    expect((await runAttempt(harness(), mixed)).verdict).toBe("fail");
    acceptMock.mockReset();
    acceptMock.mockImplementationOnce(async () => pass()).mockImplementation(async () => unverifiable("grader answer unparseable"));
    expect((await runAttempt(harness(), mixed)).verdict).toBe("unverifiable");
  });

  it("combineMixedPasses: fail wins, then unverifiable, pass needs both", () => {
    expect(combineMixedPasses(fail(), pass("checker")).verdict.outcome).toBe("fail");
    expect(combineMixedPasses(pass(), fail()).verdict.outcome).toBe("fail");
    expect(combineMixedPasses(pass(), unverifiable("x")).verdict.outcome).toBe("unverifiable");
    expect(combineMixedPasses(unverifiable("x"), pass("checker")).verdict.outcome).toBe("unverifiable");
    expect(combineMixedPasses(pass(), pass("checker")).verdict.outcome).toBe("pass");
  });
});

describe("change set and switches", () => {
  it("V6: changedFiles is the union of the observed files and the base..candidate diff", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    await runAttempt(h);
    const files = artefactOf(0).changedFiles.map((f) => planTreeKey(f.path));
    expect(files.sort()).toEqual([planTreeKey(join(slotPath, "a.ts")), planTreeKey(join(slotPath, "b.ts"))].sort());
    expect(artefactOf(0).changeBaseline).toBe("available");
  });

  it("V7: the router's own switch is no switch: observe runs once, before the commit", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    await runAttempt(h);
    expect(h.prepareCalls).toHaveLength(1);
    expect(artefactOf(0).branchSwitch).toBeUndefined();
  });

  it("V7: a child's branch switch is a switch (unverifiable)", async () => {
    acceptMock.mockImplementation(async (_d: Delegation, a: Artefact) => a.branchSwitch !== undefined ? unverifiable(a.branchSwitch) : pass());
    const h = harness({ prepared: prepared({ branchSwitch: "the working tree switched branch during the dispatch" }) });
    const result = await runAttempt(h);
    expect(result.verdict).toBe("unverifiable");
    expect(artefactOf(0).changeBaseline).toBe("unavailable");
  });

  it("pre-checks: off the task branch, or a base that is not an ancestor, runs nothing", async () => {
    const h = harness();
    const verifier = createPlanTaskVerifier(h.deps);
    await verifier.begin?.(task(), slot(), attempt());
    await verifier.observe?.(task(), slot(), attempt());
    h.git.head = CANDIDATE; h.git.branch = "main";
    expect((await verifier.verify(task(), slot(), attempt())).verdict).toBe("unverifiable");
    const h2 = harness();
    h2.git.ancestor = false;
    expect((await runAttempt(h2)).verdict).toBe("unverifiable");
    expect(acceptMock).not.toHaveBeenCalled();
  });
});

describe("restart fallbacks (fail closed)", () => {
  it("V8: no begin/observe record, the router's commit on the reset commit: verified on the commit diff with the restored head", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness({ prepared: prepared({ changedFiles: [] }) });
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1"; h.git.parent = BASE;
    const result = await createPlanTaskVerifier(h.deps).verify(task(), slot(), attempt());
    expect(result.verdict).toBe("pass");
    const restoredHead = h.prepareCalls[0]![6] as { head: string; branch: string | null };
    expect(restoredHead).toMatchObject({ head: CANDIDATE, branch: "omr/p1/t/t1" });
    expect(artefactOf(0).changedFiles).toHaveLength(2);
  });

  it("V8: child commits under the router's commit are unverifiable", async () => {
    const h = harness();
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1"; h.git.parent = OTHER;
    expect((await createPlanTaskVerifier(h.deps).verify(task(), slot(), attempt())).verdict).toBe("unverifiable");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("V8: no router trailer and a HEAD other than the reset commit is unverifiable", async () => {
    const h = harness();
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1"; h.git.message = "child commit\n";
    expect((await createPlanTaskVerifier(h.deps).verify(task(), slot(), attempt())).verdict).toBe("unverifiable");
  });

  it("V8: a perimeter that would be planned is unverifiable", async () => {
    const h = harness({ perimeterPlanned: true });
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1";
    const result = await createPlanTaskVerifier(h.deps).verify(task(), slot(), attempt());
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/perimeter would be planned/);
    expect(acceptMock).not.toHaveBeenCalled();
  });
});

describe("perimeter (A-5.1-12, I4)", () => {
  it("V9: the observed perimeter reaches the gate, and plan-task ids are plannable", async () => {
    acceptMock.mockImplementation(async (_d: Delegation, a: Artefact) => a.perimeter !== undefined ? unverifiable("another repository changed") : pass());
    const perimeter = { w: { root: slotPath, name: "slot" }, roots: [{ root: join(slotPath, "..", "lib"), name: "lib", status: "changed" as const }] };
    const h = harness({ prepared: prepared({ perimeter }) });
    expect((await runAttempt(h)).verdict).toBe("unverifiable");
    expect(artefactOf(0).perimeter).toEqual(perimeter);
    const id = planTaskVerificationID("orch-1", "p1", "t1", 2);
    expect(id).toBe("plan:orch-1:p1/t1#2");
    expect(PLAN_TASK_PERIMETER_ID.exec(id)?.[1]).toBe("orch-1");
    expect(isPlanTaskVerificationID(id)).toBe(true);
    expect(isPlanTaskVerificationID("plan::p1/t1#1")).toBe(false);
    // No working set, no parents: no perimeter (I9); a malformed plan id is never planned.
    expect(planPerimeter(id, slotPath, () => ({ parents: [], depth: 1, exclude: [] }))).toBeUndefined();
    expect(planPerimeter("plan:orch-1:p1", slotPath, () => ({ parents: [slotPath], depth: 1, exclude: [] }))).toBeUndefined();
  });

  it("an unknown orchestrator fails closed", async () => {
    const h = harness({ orchestrator: null });
    expect((await runAttempt(h)).verdict).toBe("unverifiable");
    expect(acceptMock).not.toHaveBeenCalled();
  });
});

describe("DoD and scope", () => {
  it("V10: a cwd outside the slot is refused by the gate", async () => {
    acceptMock.mockImplementation(async (d: Delegation) => d.refusedCwd !== undefined ? unverifiable(`cwd ${d.refusedCwd} outside`) : pass());
    const h = harness();
    const outside = join(slotPath, "..");
    const result = await runAttempt(h, task({ text: `x\n[acceptance]\ncwd: ${outside}\ncheck: testsPass\n[/acceptance]` }));
    expect(result.verdict).toBe("unverifiable");
    expect(delegationOf(0).workRoot).toBe(slotPath);
    expect(delegationOf(0).refusedCwd).toBeDefined();
  });

  it("V11: a task without a block gets the dispatch DoD inference (never 'no block, pass')", async () => {
    acceptMock.mockImplementation(async () => pass("checker"));
    const h = harness();
    const t = task({ text: "Rename the helper and update its callers." });
    expect(planTaskDoD(t).source).toBe("inferred");
    await runAttempt(h, t);
    expect(delegationOf(0).dod.source).toBe("inferred");
    expect(delegationOf(0).trivial).toBe(false);
  });

  it("V12: VERIFY:deferred is verified synchronously (no handle, no footer)", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    const result = await runAttempt(h, task({ verify: "deferred", text: "VERIFY:deferred\nx\n[acceptance]\ncheck: testsPass\n[/acceptance]" }));
    expect(result.verdict).toBe("pass");
    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(result.findings).not.toMatch(/router_verify|handle/i);
  });
});

describe("lease self-exemption (D11)", () => {
  it("V13: the task's own holders are exempt in its slot tree only, while the gate runs", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    await runAttempt(h);
    expect([...h.exemptDuringGate[0]!].sort()).toEqual(["child-1", leaseHolderID("p1", "t1")].sort());
    expect(h.deps.exemptions.exemptFor(slotPath).size).toBe(0);
  });

  it("V13: another tree and other plans' holders are never exempt", () => {
    const registry = createLeaseSelfExemptions((root) => planTreeKey(root));
    const release = registry.exempt(slotPath, ["child-1", leaseHolderID("p1", "t1")]);
    expect(registry.exemptFor(join(slotPath, "..")).size).toBe(0);
    expect(registry.exemptFor(slotPath).has(leaseHolderID("p2", "t1"))).toBe(false);
    expect(registry.exemptFor(`${slotPath}/`).has("child-1")).toBe(true);
    release();
    release();
    expect(registry.exemptFor(slotPath).size).toBe(0);
  });
});

describe("verdict mapping", () => {
  it("V14: a non-strict unverifiable stays unverifiable; a strict-rejected pass is unverifiable", () => {
    const nonStrict = unverifiable("no test process ran");
    expect(nonStrict.accepted).toBe(true);
    expect(slotVerdictOf(nonStrict).verdict).toBe("unverifiable");
    const strictPass = gateResult({ pass: true, outcome: "pass", method: "deterministic", reasons: ["ok"], caveats: ["c"] }, "explicit", true);
    expect(strictPass.accepted).toBe(false);
    expect(slotVerdictOf(strictPass).verdict).toBe("unverifiable");
    const skipped: GateResult = { accepted: false, verdict: { pass: false, method: "none", skipped: true, reasons: ["no checkable DoD"] }, dodSource: "inferred" };
    expect(slotVerdictOf(skipped).verdict).toBe("unverifiable");
    expect(slotVerdictOf(pass()).verdict).toBe("pass");
    expect(slotVerdictOf(fail()).verdict).toBe("fail");
  });

  it("V14: findings are reasons, caveats, notes, capped; ref names the grader tier; both ids cleared on settle", async () => {
    const long = "r".repeat(5000);
    const res = gateResult({ pass: false, outcome: "fail", method: "checker", reasons: [long], grader: { tier: "heavy", model: null } }, "explicit");
    const mapped = slotVerdictOf(res);
    expect(mapped.findings.length).toBeLessThanOrEqual(PLAN_TASK_FINDINGS_MAX);
    expect(mapped.ref).toBe("checker:heavy");
    const ordered = slotVerdictOf(gateResult({ pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["r1"], caveats: ["c1"], notes: ["n1"] }, "explicit"));
    expect(ordered.findings.split("\n")).toEqual(["r1", "c1", "n1"]);
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    await runAttempt(h);
    expect(h.cleared).toEqual(expect.arrayContaining(["child-1", planTaskVerificationID("orch-1", "p1", "t1", 1)]));
  });
});

type GitAnswer = { code: number | null; stdout: string; stderr: string };
/** Answers `override`'s git calls; everything else goes to the harness's git double. */
function withGit(h: Harness, override: (args: readonly string[]) => GitAnswer | undefined): void {
  const inner = h.deps.git;
  h.deps.git = async (args, cwd, ms) => override(args) ?? inner(args, cwd, ms);
}
const isHeadRead = (args: readonly string[]): boolean => args.join(" ") === "rev-parse --verify --quiet HEAD^{commit}";
/** A slot as the router left it after a restart: its commit (with this attempt's trailer) directly on the reset commit. */
function restarted(h: Harness): void { h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1"; h.git.parent = BASE; }
const verifyOnly = (h: Harness, t: TaskNode = task(), a: Attempt = attempt()) => createPlanTaskVerifier(h.deps).verify(t, slot(), a);

describe("restart fallback arms (fail closed)", () => {
  it("no readable HEAD after a restart", async () => {
    const h = harness();
    withGit(h, (args) => isHeadRead(args) ? { code: 1, stdout: "", stderr: "" } : undefined);
    const result = await verifyOnly(h);
    expect(result).toMatchObject({ verdict: "unverifiable" });
    expect(result.findings).toMatch(/no readable HEAD after a restart/);
  });

  it("an unreadable commit message, or an attempt without a nonce, is not the router's trailer", async () => {
    const h = harness();
    restarted(h);
    withGit(h, (args) => args[0] === "log" ? { code: 128, stdout: "", stderr: "" } : undefined);
    expect((await verifyOnly(h)).verdict).toBe("unverifiable");
    const h2 = harness();
    restarted(h2);
    expect((await verifyOnly(h2, task(), attempt({ nonce: "" }))).verdict).toBe("unverifiable");
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("the router's commit with an unreadable parent", async () => {
    const h = harness();
    restarted(h);
    withGit(h, (args) => args.join(" ").endsWith("^1^{commit}") ? { code: 128, stdout: "", stderr: "" } : undefined);
    const result = await verifyOnly(h);
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/unknown is not the reset commit/);
  });

  it("an unreadable or unresolvable toplevel falls back to the slot path for the restored head", async () => {
    acceptMock.mockImplementation(async () => pass());
    for (const top of [{ code: 128, stdout: "", stderr: "" }, { code: 0, stdout: "\n", stderr: "" }, { code: 0, stdout: join(slotPath, "missing", "x"), stderr: "" }]) {
      const h = harness();
      restarted(h);
      withGit(h, (args) => args.join(" ") === "rev-parse --show-toplevel" ? top : undefined);
      expect((await verifyOnly(h)).verdict).toBe("pass");
      expect((h.prepareCalls[0]![6] as { root: string }).root).toBe(slotPath);
    }
  });

  it("an unparseable attempt start reads as now", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    restarted(h);
    await verifyOnly(h, task(), attempt({ startedAt: "not a date" }));
    expect(h.prepareCalls[0]![5]).toBe(1_000);
  });

  it("a failed change observation after a restart", async () => {
    for (const thrown of [new Error("snapshot failed"), "plain failure"]) {
      const h = harness();
      restarted(h);
      h.deps.prepareVerification = (async () => { throw thrown; }) as unknown as PlanTaskVerifierDeps["prepareVerification"];
      const result = await verifyOnly(h);
      expect(result.verdict).toBe("unverifiable");
      expect(result.findings).toMatch(/change observation failed/);
    }
  });

  it("an observed perimeter after a restart is unverifiable; an empty one is not a perimeter", async () => {
    acceptMock.mockImplementation(async () => pass());
    const roots = { w: { root: slotPath, name: "slot" }, roots: [{ root: join(slotPath, "..", "lib"), name: "lib", status: "unchanged" as const }] };
    const h = harness({ prepared: prepared({ perimeter: roots }) });
    restarted(h);
    expect((await verifyOnly(h)).findings).toMatch(/perimeter would be planned/);
    const h2 = harness({ prepared: prepared({ perimeter: { w: { root: slotPath, name: "slot" }, roots: [] } }) });
    restarted(h2);
    expect((await verifyOnly(h2)).verdict).toBe("pass");
  });

  it("the wiring's own planning rule decides when no port is given; a planning error counts as planned", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    restarted(h);
    delete h.deps.perimeterPlanned;
    expect((await verifyOnly(h)).verdict).toBe("pass");
    const h2 = harness();
    restarted(h2);
    delete h2.deps.perimeterPlanned;
    h2.deps.getConfig = () => { throw new Error("config unreadable"); };
    expect((await verifyOnly(h2)).findings).toMatch(/perimeter would be planned/);
  });
});

describe("timeout and abort arms", () => {
  it("a gate error other than a timeout is unverifiable, and is not a cut", async () => {
    acceptMock.mockImplementation(async () => { throw new Error("engine exploded"); });
    const h = harness();
    const result = await runAttempt(h);
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/verification unavailable: Error: engine exploded/);
    expect(h.aborted).toEqual([]);
  });

  it("a failure observed before the timeout stands (fail), and a failing abort is best effort", async () => {
    acceptMock.mockImplementation(async (_d: Delegation, _a: Artefact, deps: GateDeps) => {
      (h.gateDepsCalls[h.gateDepsCalls.length - 1]![1] as Set<string>).add("grader-x");
      deps.deterministic.onFailure?.("tests failed: 2 introduced");
      throw new RouterTimeoutError("verification gate", 1);
    });
    const h = harness();
    h.deps.abortSession = async () => { throw new Error("abort refused"); };
    const result = await runAttempt(h);
    expect(result.verdict).toBe("fail");
    expect(result.findings).toMatch(/tests failed: 2 introduced/);
    expect(acceptMock).toHaveBeenCalledTimes(1);
  });
});

describe("D11 exemption filter", () => {
  it("filters only the exempt holders of the exempt tree, as index.ts's leaseGate wrapper applies it", async () => {
    const registry = createLeaseSelfExemptions((root) => planTreeKey(root));
    const releaseOwn = registry.exempt(slotPath, ["", "child-1", leaseHolderID("p1", "t1")]);
    const releaseOther = registry.exempt(join(slotPath, "..", "other-slot"), [leaseHolderID("p2", "t9")]);
    expect(registry.exemptFor(slotPath).has("")).toBe(false);
    const gate = { waitTreeFree: vi.fn(async () => ({ waitedMs: 0, holders: ["child-1", leaseHolderID("p1", "t1"), leaseHolderID("p2", "t9")], fileCount: 3 })) };
    const wait = await waitTreeFreeExcept(gate, slotPath, { producer: "orch-1" }, registry.exemptFor(slotPath), 0, new AbortController().signal);
    expect(wait.holders).toEqual([leaseHolderID("p2", "t9")]);
    releaseOwn();
    const after = await waitTreeFreeExcept(gate, slotPath, { producer: "orch-1" }, registry.exemptFor(slotPath), 0, new AbortController().signal);
    expect(after.holders).toHaveLength(3);
    releaseOther();
  });
});

describe("verifier arms", () => {
  it("begin twice clears the stale record; an unreadable HEAD at begin takes the lease's commit as the base", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    const calls: string[] = [];
    withGit(h, (args) => { calls.push(args.join(" ")); return undefined; });
    h.git.head = "not-a-sha";
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(task(), slot(), attempt());
    await v.begin?.(task(), slot(), attempt());
    expect(h.cleared).toContain(planTaskVerificationID("orch-1", "p1", "t1", 1));
    await v.observe?.(task(), slot(), attempt());
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1";
    expect((await v.verify(task(), slot(), attempt())).verdict).toBe("pass");
    expect(calls).toContain(`merge-base --is-ancestor ${BASE} ${CANDIDATE}`);
  });

  it("a begin that fails is logged (a throwing logger too) and verify takes the fallback", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    h.deps.beginVerificationBounded = async () => { throw new Error("capture refused"); };
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(task(), slot(), attempt());
    expect(h.logs.join("\n")).toMatch(/could not begin/);
    h.deps.log = () => { throw new Error("logger down"); };
    await expect(createPlanTaskVerifier(h.deps).begin?.(task(), slot(), attempt())).resolves.toBeUndefined();
    restarted(h);
    await v.observe?.(task(), slot(), attempt());
    expect(h.prepareCalls).toHaveLength(0);
    expect((await v.verify(task(), slot(), attempt())).verdict).toBe("pass");
    expect(h.prepareCalls[0]![6]).toMatchObject({ head: CANDIDATE });
  });

  it("forget drops a record (verify then falls back) and ignores an unknown attempt", async () => {
    const h = harness();
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(task(), slot(), attempt());
    await v.forget?.("p1", "t1", 1);
    await v.forget?.("p1", "t1", 9);
    expect(h.cleared).toContain(planTaskVerificationID("orch-1", "p1", "t1", 1));
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1"; h.git.parent = OTHER;
    expect((await v.verify(task(), slot(), attempt())).findings).toMatch(/lost in a restart/);
  });

  it("a failed observation is unverifiable", async () => {
    const h = harness();
    h.deps.prepareVerification = (async () => { throw new Error("tree unreadable"); }) as unknown as PlanTaskVerifierDeps["prepareVerification"];
    const result = await runAttempt(h);
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/change observation failed: tree unreadable/);
  });

  it("pre-check arms: no task branch, a detached slot, an unreadable candidate", async () => {
    expect((await runAttempt(harness(), task({ branch: null }))).findings).toMatch(/has no branch/);
    const h = harness();
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(task(), slot(), attempt());
    await v.observe?.(task(), slot(), attempt());
    expect((await v.verify(task(), slot(), attempt())).findings).toMatch(/not on the task branch/);
    const h2 = harness();
    const v2 = createPlanTaskVerifier(h2.deps);
    await v2.begin?.(task(), slot(), attempt());
    await v2.observe?.(task(), slot(), attempt());
    h2.git.branch = "omr/p1/t/t1"; h2.git.head = "zzz";
    expect((await v2.verify(task(), slot(), attempt())).findings).toMatch(/no readable HEAD/);
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("a slot that cannot be snapshotted runs nothing", async () => {
    snapshotMock.mockImplementation(async () => undefined);
    expect((await runAttempt(harness())).findings).toMatch(/could not be snapshotted/);
    snapshotMock.mockImplementation(async () => { throw new Error("git busy"); });
    expect((await runAttempt(harness())).findings).toMatch(/could not be snapshotted/);
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("a snapshot without a root: the observed root, else the slot path", async () => {
    acceptMock.mockImplementation(async () => pass());
    snapshotMock.mockImplementation(async () => ({ head: CANDIDATE, branch: "omr/p1/t/t1", entries: new Map() }));
    const observedRoot = join(slotPath, "observed");
    const h = harness({ prepared: prepared({ snapshot: { root: observedRoot } as unknown as PreparedVerification["snapshot"] }) });
    await runAttempt(h);
    expect(artefactOf(0).changeRoot).toBe(observedRoot);
    acceptMock.mockClear();
    await runAttempt(harness());
    expect(artefactOf(0).changeRoot).toBe(slotPath);
  });

  it("an unreadable or malformed commit diff runs nothing; a throwing git reads as a failed call", async () => {
    const answers: Array<() => GitAnswer> = [
      () => ({ code: 128, stdout: "", stderr: "bad revision" }),
      () => ({ code: 0, stdout: "??\0x\0", stderr: "" }),
      () => { throw new Error("spawn failed"); },
      () => { throw "spawn failed (string)"; },
    ];
    for (const answer of answers) {
      const h = harness();
      withGit(h, (args) => args[0] === "diff" ? answer() : undefined);
      expect((await runAttempt(h)).findings).toMatch(/could not be read/);
    }
    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("relative observed paths join the union; writers, deliverable and the child's budget reach the artefact", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness({ prepared: prepared({ changedFiles: [{ path: "a.ts", status: "M" }], unattributedWriters: ["bash"] }) });
    h.deps.captureBudget = () => ({ stub: true }) as unknown as ReturnType<PlanTaskVerifierDeps["captureBudget"]>;
    await runAttempt(h, task({ text: "x\n[acceptance]\ncheck: testsPass\ndeliverable: out.md\n[/acceptance]" }));
    const a = artefactOf(0);
    expect(a.changedFiles).toHaveLength(2);
    expect(a.unattributedWriters).toEqual(["bash"]);
    expect(a.declaredOutputs).toEqual(["out.md"]);
    expect(a.budget).toEqual({ stub: true });
    acceptMock.mockClear();
    await runAttempt(harness({ prepared: prepared({ unattributedWriters: [] }) }));
    expect(artefactOf(0).unattributedWriters).toBeUndefined();
    expect(artefactOf(0).declaredOutputs).toEqual([]);
  });

  it("an attempt without a child: no producer session, no verdict ingested, no child id cleared", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    expect((await runAttempt(h, task(), attempt({ childSessionID: null }))).verdict).toBe("pass");
    expect(artefactOf(0).producerSessionID).toBe("");
    expect(h.verdicts).toEqual([]);
    expect(h.cleared).not.toContain("child-1");
  });

  it("a skipped verdict is not ingested; an ingest error is logged and the verdict stands", async () => {
    acceptMock.mockImplementation(async (): Promise<GateResult> => ({ accepted: true, verdict: { pass: false, method: "none", skipped: true, reasons: ["skipped"] }, dodSource: "explicit" }));
    const h = harness();
    expect((await runAttempt(h)).verdict).toBe("unverifiable");
    expect(h.verdicts).toEqual([]);
    acceptMock.mockImplementation(async () => pass());
    const h2 = harness();
    h2.deps.onVerdict = () => { throw new Error("store full"); };
    expect((await runAttempt(h2)).verdict).toBe("pass");
    expect(h2.logs.join("\n")).toMatch(/not ingested/);
  });

  it("an unexpected error is unverifiable; a failing store clear is best effort", async () => {
    for (const thrown of [new Error("budget read failed"), "budget read failed (string)"]) {
      const h = harness();
      h.deps.captureBudget = () => { throw thrown; };
      h.deps.changedFileStore = { clear: () => { throw new Error("store gone"); } } as unknown as PlanTaskVerifierDeps["changedFileStore"];
      const result = await runAttempt(h);
      expect(result.verdict).toBe("unverifiable");
      expect(result.findings).toMatch(/verification unavailable: budget read failed/);
    }
  });

  it("QA-5.1-6: the orchestrator is the one the runtime passes; plan-task has no lookup or discovery of its own", async () => {
    acceptMock.mockImplementation(async () => pass("checker"));
    const h = harness();
    const gitCalls: string[] = [];
    const answer = h.deps.git;
    h.deps.git = async (args, cwd, ms) => { gitCalls.push(args.join(" ")); return answer(args, cwd, ms); };
    const t = task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" });
    const ctx: PlanTaskContext = { orchestratorSessionID: "orch-passed" };
    const v = createRawPlanTaskVerifier(h.deps);
    await v.begin?.(t, slot(), attempt(), ctx);
    h.git.head = CANDIDATE;
    h.git.branch = t.branch ?? "";
    await v.observe?.(t, slot(), attempt(), undefined, ctx);
    expect((await v.verify(t, slot(), attempt(), ctx)).verdict).toBe("pass");
    expect(h.gateDepsCalls[0]![0]).toBe("orch-passed");
    expect(h.gateDepsCalls[0]![5]).toBe("orch-passed");
    expect(h.deps.beginVerificationBounded).toHaveBeenCalledWith(h.deps.changedFileStore, planTaskVerificationID("orch-passed", "p1", "t1", 1), slotPath, expect.anything());
    // No toplevel discovery of its own (the restart fallback's slot toplevel is not reached on this path).
    expect(gitCalls.some((a) => a.includes("--show-toplevel"))).toBe(false);
    // Without a passed orchestrator the verifier fails closed; it never looks one up.
    const bare = createRawPlanTaskVerifier(h.deps);
    await bare.begin?.(t, slot(), attempt());
    await bare.observe?.(t, slot(), attempt());
    expect((await bare.verify(t, slot(), attempt())).findings).toMatch(/orchestrator of plan p1 could not be read/);
    // The module holds no orchestrator port, ledger store or executor-home discovery.
    const source = readFileSync(fileURLToPath(new URL("../../src/verify/plan-task.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/createLedgerStore|resolveExecutorHome|executor\/ledger"|executor\/paths"|orchestratorOf|ledgerOrchestratorOf/);
  });

  it("QA-5.1-14: after an adopt the grader is parented to the NEW orchestrator; the attempt's id keeps the one of its begin", async () => {
    acceptMock.mockImplementation(async () => pass("checker"));
    const h = harness();
    const t = task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" });
    const v = createRawPlanTaskVerifier(h.deps);
    const before: PlanTaskContext = { orchestratorSessionID: "orch-old" };
    await v.begin?.(t, slot(), attempt(), before);
    h.git.head = CANDIDATE;
    h.git.branch = t.branch ?? "";
    await v.observe?.(t, slot(), attempt(), "Done: implemented and documented.", before);
    // The adopt: the runtime now reads the new orchestrator from its ledger and passes it with verify.
    const result = await v.verify(t, slot(), attempt(), { orchestratorSessionID: "orch-new" });
    expect(result.verdict).toBe("pass");
    const [parent, , , , , creator] = h.gateDepsCalls[0]!;
    expect(parent).toBe("orch-new");
    expect(creator).toBe("orch-new");
    expect(h.prepareCalls[0]![1]).toBe(planTaskVerificationID("orch-old", "p1", "t1", 1));
  });

  it("QA-5.1-4: dispose cuts a hanging verify at once: unverifiable, deadline and grader aborted, no verdict ingested", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    acceptMock.mockImplementation(async () => {
      const inFlight = h.gateDepsCalls[h.gateDepsCalls.length - 1]![1] as Set<string>;
      inFlight.add("grader-hung");
      started();
      return new Promise<GateResult>(() => {});
    });
    const h = harness();
    const t = task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" });
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(t, slot(), attempt());
    h.git.head = CANDIDATE;
    h.git.branch = t.branch ?? "";
    await v.observe?.(t, slot(), attempt());
    const pending = v.verify(t, slot(), attempt());
    await running;
    expect(v.disposing).toBe(false);
    const t0 = Date.now();
    await v.dispose?.();
    const result = await pending;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(v.disposing).toBe(true);
    expect(result.verdict).toBe("unverifiable");
    expect(result.findings).toMatch(/the plugin is shutting down/);
    expect(h.aborted).toEqual(["grader-hung"]);
    expect((h.gateDepsCalls[0]![3] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(h.verdicts).toEqual([]);
    // A verify after dispose is cut at once: nothing runs.
    acceptMock.mockClear();
    expect((await v.verify(t, slot(), attempt())).findings).toMatch(/shutting down/);
    expect(acceptMock).not.toHaveBeenCalled();
    await v.dispose?.();
  });

  it("QA-5.1-4: dispose cancels a backoff sleep; the transient result is never re-run nor ingested", async () => {
    acceptMock.mockImplementation(async () => unverifiable("grader dispatch failed: 503"));
    const h = harness();
    let slept!: () => void;
    const sleeping = new Promise<void>((resolve) => { slept = resolve; });
    h.deps.sleep = (ms) => { h.sleeps.push(ms); slept(); return new Promise<void>(() => {}); };
    const t = task({ text: "x\n[acceptance]\ncriteria: works\n[/acceptance]" });
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(t, slot(), attempt());
    h.git.head = CANDIDATE;
    h.git.branch = t.branch ?? "";
    await v.observe?.(t, slot(), attempt());
    const pending = v.verify(t, slot(), attempt());
    await sleeping;
    await v.dispose?.();
    const result = await pending;
    expect(result.findings).toMatch(/the plugin is shutting down/);
    expect(h.sleeps).toEqual([30_000]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(h.verdicts).toEqual([]);
  });

  it("the default sleep and clock", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    delete h.deps.sleep;
    delete h.deps.now;
    delete h.deps.log;
    expect((await runAttempt(h)).verdict).toBe("pass");
    expect(typeof h.prepareCalls[0]![5]).toBe("number");
  });

  it("per-check placements reach the gate; a refused scope= is the gate's refusal", async () => {
    acceptMock.mockImplementation(async () => pass());
    await runAttempt(harness(), task({ text: "x\n[acceptance]\ncheck: testsPass scope=full\n[/acceptance]" }));
    expect(delegationOf(0).checkPlacements).toBeDefined();
    acceptMock.mockClear();
    await runAttempt(harness(), task({ text: "x\n[acceptance]\ncheck: testsPass scope=bogus\n[/acceptance]" }));
    expect(delegationOf(0).refusedCheck).toMatchObject({ why: "scope" });
  });
});

describe("the child's final text (owner decision on (a))", () => {
  it("(a) the grader judges the child's own final text when observe provides it", async () => {
    acceptMock.mockImplementation(async () => pass("checker"));
    const h = harness();
    const t = task({ text: "x\n[acceptance]\ncriteria: the thing is implemented\n[/acceptance]" });
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(t, slot(), attempt());
    await v.observe?.(t, slot(), attempt(), "  DONE: implemented the thing (src/a.ts:1)  ");
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1";
    // verifyAttempt's second observe without a text keeps the one already received.
    await v.observe?.(t, slot(), attempt());
    expect((await v.verify(t, slot(), attempt())).verdict).toBe("pass");
    expect(artefactOf(0).finalReturnText).toBe("DONE: implemented the thing (src/a.ts:1)");
  });

  it("(a) without the child's text (absent or blank) the grader gets the router's commit description", async () => {
    acceptMock.mockImplementation(async () => pass());
    await runAttempt(harness());
    expect(artefactOf(0).finalReturnText).toBe(`plan task t1 attempt 1: the router committed the slot's change as ${CANDIDATE} over ${BASE}`);
    acceptMock.mockClear();
    const h = harness();
    const v = createPlanTaskVerifier(h.deps);
    await v.begin?.(task(), slot(), attempt());
    await v.observe?.(task(), slot(), attempt(), "   ");
    h.git.head = CANDIDATE; h.git.branch = "omr/p1/t/t1";
    await v.verify(task(), slot(), attempt());
    expect(artefactOf(0).finalReturnText).toMatch(/^plan task t1 attempt 1: the router committed/);
  });

  it("(a) the child's text reaches the restart fallback, capped", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    restarted(h);
    const v = createPlanTaskVerifier(h.deps);
    await v.observe?.(task(), slot(), attempt(), "y".repeat(PLAN_TASK_RETURN_TEXT_MAX + 500));
    await v.verify(task(), slot(), attempt());
    const text = artefactOf(0).finalReturnText;
    expect(text.length).toBe(PLAN_TASK_RETURN_TEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
  });

  it("(a) forget and a settled verify drop the child's text", async () => {
    acceptMock.mockImplementation(async () => pass());
    const h = harness();
    restarted(h);
    const v = createPlanTaskVerifier(h.deps);
    await v.observe?.(task(), slot(), attempt(), "DONE: first claim");
    await v.forget?.("p1", "t1", 1);
    await v.verify(task(), slot(), attempt());
    expect(artefactOf(0).finalReturnText).toMatch(/^plan task t1 attempt 1: the router committed/);
    acceptMock.mockClear();
    await v.observe?.(task(), slot(), attempt(), "DONE: second claim");
    await v.verify(task(), slot(), attempt());
    expect(artefactOf(0).finalReturnText).toBe("DONE: second claim");
    acceptMock.mockClear();
    await v.verify(task(), slot(), attempt());
    expect(artefactOf(0).finalReturnText).toMatch(/^plan task t1 attempt 1: the router committed/);
  });

  it("planTaskReturnText: trimmed, scrubbed, capped; blank or absent falls back", () => {
    expect(planTaskReturnText("  DONE: ok  ", "fallback")).toBe("DONE: ok");
    expect(planTaskReturnText("   ", "fallback")).toBe("fallback");
    expect(planTaskReturnText(undefined, "fallback")).toBe("fallback");
    expect(planTaskReturnText("z".repeat(PLAN_TASK_RETURN_TEXT_MAX), "fallback")).toHaveLength(PLAN_TASK_RETURN_TEXT_MAX);
  });
});

describe("pure helpers", () => {
  it("slotVerdictOf without an outcome field, with blank and repeated lines", () => {
    expect(slotVerdictOf({ accepted: true, verdict: { pass: true, method: "deterministic", reasons: ["ok", "ok", "  "] }, dodSource: "explicit" }))
      .toEqual({ verdict: "pass", findings: "ok", ref: "deterministic" });
    expect(slotVerdictOf({ accepted: false, verdict: { pass: false, method: "deterministic", reasons: ["bad"] }, dodSource: "explicit" }).verdict).toBe("fail");
  });

  it("isTransientPlanTaskResult arms", () => {
    expect(isTransientPlanTaskResult(pass())).toBe(false);
    expect(isTransientPlanTaskResult({ accepted: false, verdict: { pass: false, method: "deterministic", reasons: ["x"] }, dodSource: "explicit" })).toBe(false);
    expect(isTransientPlanTaskResult({ accepted: true, verdict: { pass: false, outcome: "unverifiable", skipped: true, method: "none", reasons: ["x"] }, dodSource: "explicit" })).toBe(false);
    expect(isTransientPlanTaskResult(unverifiable("no test process ran"), true)).toBe(true);
    expect(isTransientPlanTaskResult({ accepted: true, verdict: { pass: false, outcome: "unverifiable", method: "checker", reasons: ["x"], caveats: ["grader dispatch failed: 502"] }, dodSource: "explicit" })).toBe(true);
    expect(isTransientPlanTaskResult(unverifiable("evidence missing"))).toBe(false);
  });

  it("combineMixedPasses arms: a skipped check pass, a skipped grader pass, notes and caveats", () => {
    const skipped: GateResult = { accepted: true, verdict: { pass: false, method: "none", skipped: true, reasons: ["skip"] }, dodSource: "explicit" };
    expect(combineMixedPasses(skipped, pass("checker"))).toBe(skipped);
    const graderSkipped = combineMixedPasses(pass(), skipped);
    expect(graderSkipped.verdict).toMatchObject({ outcome: "unverifiable", skipped: true });
    const noted = combineMixedPasses(
      gateResult({ pass: true, outcome: "pass", method: "deterministic", reasons: ["r1"], notes: ["n1"] }, "explicit"),
      { accepted: true, verdict: { pass: true, method: "checker", reasons: ["r2"], notes: ["n2"], caveats: ["c2"] }, dodSource: "explicit" },
    );
    // Both passes passed (the grader's caveats do not change its outcome): a pass, with both passes' notes and caveats.
    expect(noted.verdict).toMatchObject({ outcome: "pass", notes: ["n1", "n2"], caveats: ["c2"] });
    expect(noted.accepted).toBe(true);
    const plain = combineMixedPasses(gateResult({ pass: true, outcome: "pass", method: "deterministic", reasons: ["r1"] }, "explicit"), pass("checker"));
    expect(plain.verdict.notes).toBeUndefined();
    expect(plain.verdict.caveats).toBeUndefined();
    expect(plain.accepted).toBe(true);
  });

  it("planTreeKey per platform", () => {
    expect(planTreeKey("/a/b/", "linux")).toBe("/a/b");
    expect(planTreeKey("C:/Git/Slot\\", "win32")).toBe("c:\\git\\slot");
  });

  it("planTaskDoD: a bare block body, a marked block, a blank block", () => {
    expect(planTaskDoD({ title: "t", text: "x", acceptance: "check: testsPass" }).checks.map((c) => c.kind)).toEqual(["testsPass"]);
    expect(planTaskDoD({ title: "t", text: "x", acceptance: "[acceptance]\ncheck: lintClean\n[/acceptance]" }).checks.map((c) => c.kind)).toEqual(["lintClean"]);
    expect(planTaskDoD({ title: "t", text: "Rename the helper.", acceptance: "   " }).source).toBe("inferred");
  });

  it("planTaskProducerTier: an unknown role, an unreadable config", () => {
    expect(planTaskProducerTier(task({ route: { line: "", role: "no-such-role", tier: "fast", pin: false } }), config())).toBe("no-such-role");
    const unreadable = new Proxy({}, { get() { throw new Error("config unreadable"); } }) as unknown as configModule.RouterConfig;
    expect(planTaskProducerTier(task(), unreadable)).toBe("implementer");
  });

  it("graderTierFor honours minGraderTier", () => {
    expect(graderTierFor("heavy", config())).toBe("heavy");
    expect(graderTierFor("an-agent", config())).toBe("heavy");
    const raised = configModule.validateConfig({ ...bundled, enforcement: { verify: { minGraderTier: "heavy" } } });
    expect(graderTierFor("fast", raised)).toBe("heavy");
  });

  it("planTaskGit runs hardened git", async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-plan-task-repo-")));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      const inside = await planTaskGit()(["rev-parse", "--is-inside-work-tree"], repo, 10_000);
      expect(inside.code).toBe(0);
      expect(inside.stdout.trim()).toBe("true");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
