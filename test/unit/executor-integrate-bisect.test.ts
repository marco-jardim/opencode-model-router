import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  BackgroundRuns, CheckPrepareError, createIntegrateGit, createIntegrationChecks, createWriteGuard, isPlaceholderTestScript, observeFull,
  PREEMPT_BUDGET, selectFromFiles,
  type CommandOutput, type PreemptBudget,
} from "../../src/executor/integrate/checks";
import type { SlotHandle, SlotOptions, SlotResult } from "../../src/verify/slot";
import type {
  DetectedRunner, NoAffected, PlanScopedRunInput, RunResult as VerifyResult, ScopedSpec, Unverifiable,
} from "../../src/verify/runner";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { createLander, phaseTagName, samePath } from "../../src/executor/integrate/land";
import { phaseTagName as gitPhaseTagName, type GitOps } from "../../src/executor/git";
import { hardeningArgs } from "../../src/router/git-tools";
import { ExecutorError } from "../../src/executor/types";
import type {
  Clock, ExecutorConfig, GitRunner, IntegrationStep, LedgerV1, RunCommandRef, SlotLease, SlotPool, SlotRecord,
} from "../../src/executor/types";
import type {
  CheckErrorReason, CheckRequest, CheckResult, CheckSelection, CommandRunRequest, CommandRunResult, IntegrateGit,
  IntegrationChecks, NameStatus, ResolvedCommand, RunResolver, WriteGuard,
} from "../../src/executor/integrate/checks";
import type {
  LandRequest, RevertRequest, StepDetail, StepJournal, SuiteRunRequest,
} from "../../src/executor/integrate/queue";
import { classifyReruns, createPhaseSuiteRunner, fileOfSuiteId, interruptedBy, revertMessage } from "../../src/executor/integrate/phase-suite";
import { PREEMPT_LIMIT } from "../../src/executor/integrate/queue";
import {
  bisectRanges,
  maxRangeProbes,
  orderRanges,
  type ProbeVerdict,
  type TaskRange,
} from "../../src/executor/integrate/bisect";

// The verify runner is a seam of checks.ts: its planners and result reader are replaced by scripted doubles (default:
// the real functions), so no real runner, git or test process is involved.
type RunnerModule = typeof import("../../src/verify/runner");
const runnerHooks = vi.hoisted(() => ({
  planScopedRun: null as RunnerModule["planScopedRun"] | null,
  detectRunner: null as RunnerModule["detectRunner"] | null,
  planRerun: null as RunnerModule["planRerun"] | null,
  readResult: null as RunnerModule["readResult"] | null,
}));
vi.mock("../../src/verify/runner", async importOriginal => {
  const actual = await importOriginal<RunnerModule>();
  return {
    ...actual,
    planScopedRun: (...a: Parameters<RunnerModule["planScopedRun"]>) => (runnerHooks.planScopedRun ?? actual.planScopedRun)(...a),
    detectRunner: (...a: Parameters<RunnerModule["detectRunner"]>) => (runnerHooks.detectRunner ?? actual.detectRunner)(...a),
    planRerun: (...a: Parameters<RunnerModule["planRerun"]>) => (runnerHooks.planRerun ?? actual.planRerun)(...a),
    readResult: (...a: Parameters<RunnerModule["readResult"]>) => (runnerHooks.readResult ?? actual.readResult)(...a),
  };
});
afterEach(() => {
  runnerHooks.planScopedRun = null;
  runnerHooks.detectRunner = null;
  runnerHooks.planRerun = null;
  runnerHooks.readResult = null;
});

/** Chain c0..cn; task i spans c{i} -> c{i+1}. */
function chainOf(n: number): string[] {
  return Array.from({ length: n + 1 }, (_, i) => `c${i}`);
}
function rangesOf(n: number): TaskRange[] {
  return Array.from({ length: n }, (_, i) => ({ taskId: `T${i + 1}`, from: `c${i}`, to: `c${i + 1}` }));
}
/** Verdict function: commits with index >= firstFail fail. */
function monotone(firstFail: number, log: string[]): (commit: string) => Promise<ProbeVerdict> {
  return async commit => {
    log.push(commit);
    return Number(commit.slice(1)) >= firstFail ? "fail" : "pass";
  };
}

describe("orderRanges", () => {
  it("orders by the position of `to` in the chain, oldest first", () => {
    const ranges = rangesOf(4);
    const shuffled = [ranges[2]!, ranges[0]!, ranges[3]!, ranges[1]!];
    expect(orderRanges(shuffled, chainOf(4)).map(r => r.taskId)).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("is stable for ranges sharing the same `to`", () => {
    const chain = ["c0", "c1"];
    const out = orderRanges(
      [{ taskId: "B", from: "c0", to: "c1" }, { taskId: "A", from: "c0", to: "c1" }], chain);
    expect(out.map(r => r.taskId)).toEqual(["B", "A"]);
  });

  it("throws on a `to` that is not in the chain", () => {
    expect(() => orderRanges([{ taskId: "X", from: "c0", to: "zzz" }], chainOf(2))).toThrow(/not in the phase chain/);
  });

  it("returns copies and does not mutate the input", () => {
    const ranges = rangesOf(2);
    const copy = JSON.stringify(ranges);
    const out = orderRanges(ranges, chainOf(2));
    expect(JSON.stringify(ranges)).toBe(copy);
    expect(out[0]).not.toBe(ranges[0]);
    expect(out).toEqual(ranges);
  });

  it("handles the empty input", () => {
    expect(orderRanges([], chainOf(3))).toEqual([]);
  });
});

describe("maxRangeProbes", () => {
  it("is ceil(log2 n) + 2 and 2 for n <= 1", () => {
    expect([0, 1, 2, 3, 4, 5, 8, 9].map(maxRangeProbes)).toEqual([2, 2, 3, 4, 4, 5, 5, 6]);
  });
});

describe("bisectRanges", () => {
  it("finds the culprit at every position 1..n for n 1..8 within the probe bound", async () => {
    for (let n = 1; n <= 8; n++) {
      for (let pos = 1; pos <= n; pos++) {
        const log: string[] = [];
        const ordered = rangesOf(n);
        // the culprit task `pos` makes c{pos} the first failing commit
        const result = await bisectRanges(ordered, `c${n}`, monotone(pos, log));
        expect(result.kind, `n=${n} pos=${pos}`).toBe("culprit");
        if (result.kind !== "culprit") continue;
        expect(result.index).toBe(pos - 1);
        expect(result.range.taskId).toBe(`T${pos}`);
        expect(result.probes).toBe(log.length);
        expect(result.probes).toBeLessThanOrEqual(maxRangeProbes(n));
        expect(new Set(log).size).toBe(log.length); // no commit is probed twice
        expect(log).not.toContain(`c${n}`); // the suite commit is known to fail: never probed
      }
    }
  });

  it("returns a copy of the culprit range", async () => {
    const ordered = rangesOf(3);
    const result = await bisectRanges(ordered, "c3", monotone(2, []));
    if (result.kind !== "culprit") throw new Error("expected culprit");
    expect(result.range).toEqual(ordered[1]);
    expect(result.range).not.toBe(ordered[1]);
  });

  it("reports outside/last-passes when the last `to` passes (flaky suite failure)", async () => {
    const log: string[] = [];
    const result = await bisectRanges(rangesOf(4), "suite", async c => { log.push(c); return "pass"; });
    expect(result).toEqual({ kind: "outside", reason: "last-passes", probes: 1 });
    expect(log).toEqual(["c4"]);
  });

  it("reports outside/from-fails when the failure exists before the first range (pre-existing)", async () => {
    const log: string[] = [];
    const result = await bisectRanges(rangesOf(4), "c4", monotone(0, log));
    expect(result.kind).toBe("outside");
    if (result.kind !== "outside") return;
    expect(result.reason).toBe("from-fails");
    expect(result.probes).toBe(log.length);
    expect(result.probes).toBeLessThanOrEqual(maxRangeProbes(4));
  });

  it("reports outside/from-fails when every commit including the first `from` fails", async () => {
    const verdicts: Record<string, ProbeVerdict> = { c0: "fail", c1: "fail", c2: "fail", c3: "fail" };
    const result = await bisectRanges(rangesOf(3), "c3", async c => verdicts[c]!);
    expect(result).toMatchObject({ kind: "outside", reason: "from-fails" });
  });

  it("known verdicts cost no probe", async () => {
    const log: string[] = [];
    const known = new Map<string, ProbeVerdict>([["c4", "fail"], ["c2", "fail"], ["c1", "pass"]]);
    const result = await bisectRanges(rangesOf(4), "c4", monotone(2, log), known);
    // last (c4) known fail; search lo=0 hi=3: mid=1 -> c2 known fail; mid=0 -> c1 known pass; from c1 known pass
    expect(result).toMatchObject({ kind: "culprit", index: 1, probes: 0 });
    expect(log).toEqual([]);
  });

  it("a known pass for the last `to` yields last-passes with 0 probes", async () => {
    const log: string[] = [];
    const known = new Map<string, ProbeVerdict>([["c4", "pass"]]);
    const result = await bisectRanges(rangesOf(4), "suite", monotone(1, log), known);
    expect(result).toEqual({ kind: "outside", reason: "last-passes", probes: 0 });
    expect(log).toEqual([]);
  });

  it("does not mutate the known map", async () => {
    const known = new Map<string, ProbeVerdict>([["c1", "pass"]]);
    await bisectRanges(rangesOf(4), "c4", monotone(3, []), known);
    expect([...known.entries()]).toEqual([["c1", "pass"]]);
  });

  it("treats the suite commit as a known fail even when it is the last `to`", async () => {
    const log: string[] = [];
    await bisectRanges(rangesOf(3), "c3", monotone(1, log));
    expect(log).not.toContain("c3");
  });

  it("empty range list is outside/last-passes with zero probes", async () => {
    const result = await bisectRanges([], "c0", async () => "fail");
    expect(result).toEqual({ kind: "outside", reason: "last-passes", probes: 0 });
  });

  it("a single range whose from passes is the culprit with one probe", async () => {
    const log: string[] = [];
    const result = await bisectRanges(rangesOf(1), "c1", monotone(1, log));
    expect(result).toMatchObject({ kind: "culprit", index: 0, probes: 1 });
    expect(log).toEqual(["c0"]);
  });

  it("probes strictly sequentially (never overlapping)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await bisectRanges(rangesOf(8), "c8", async commit => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return Number(commit.slice(1)) >= 5 ? "fail" : "pass";
    });
    expect(maxInFlight).toBe(1);
  });

  it("probes at most the bound for every culprit position over n 1..16 (including known suite commit)", async () => {
    for (let n = 1; n <= 16; n++) {
      for (let pos = 1; pos <= n; pos++) {
        const log: string[] = [];
        const result = await bisectRanges(rangesOf(n), `c${n}`, monotone(pos, log));
        expect(result.kind).toBe("culprit");
        expect(log.length, `n=${n} pos=${pos}`).toBeLessThanOrEqual(maxRangeProbes(n));
      }
    }
  });

  it("a base verdict passed in `known` saves the boundary probe of the first range", async () => {
    const log: string[] = [];
    const known = new Map<string, ProbeVerdict>([["c0", "pass"]]);
    const result = await bisectRanges(rangesOf(4), "c4", monotone(1, log), known);
    expect(result).toMatchObject({ kind: "culprit", index: 0 });
    expect(log).not.toContain("c0");
  });
});

describe("classifyReruns (M22)", () => {
  it("an id failing in at least one rerun is reproduced, the rest is flaky; order follows the original", () => {
    expect(classifyReruns(["a", "b", "c"], [["b"], ["c"]])).toEqual({ reproduced: ["b", "c"], flaky: ["a"] });
    expect(classifyReruns(["a", "b"], [[], []])).toEqual({ reproduced: [], flaky: ["a", "b"] });
    expect(classifyReruns(["a", "b"], [["a", "b"], ["a", "b"]])).toEqual({ reproduced: ["a", "b"], flaky: [] });
  });

  it("ids that fail only in a rerun are ignored; duplicates collapse", () => {
    expect(classifyReruns(["a", "a", "b"], [["x"], ["y"]])).toEqual({ reproduced: [], flaky: ["a", "b"] });
    expect(classifyReruns(["a", "a"], [["a"], []])).toEqual({ reproduced: ["a"], flaky: [] });
    expect(classifyReruns([], [["x"], ["y"]])).toEqual({ reproduced: [], flaky: [] });
  });
});

describe("revertMessage (M26)", () => {
  it("is a single-line revert subject naming the task (plus an optional body naming the range and phase)", () => {
    const from = "a".repeat(40);
    const to = "b".repeat(40);
    const message = revertMessage("add feature", "T3", from, to, "p1", "plan-one");
    const [subject = "", ...rest] = message.split("\n");
    expect(subject.length).toBeGreaterThan(0);
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(subject).toMatch(/^revert/i);
    expect(subject).toContain("T3");
    expect(subject).not.toMatch(/[\r\n\0]/);
    const body = rest.join("\n");
    if (body.trim() !== "") {
      // whatever the body holds, it never contradicts the range or the phase
      if (body.includes(from.slice(0, 7))) expect(body).toContain(to.slice(0, 7));
      if (/phase/i.test(body)) expect(body).toContain("p1");
    }
  });
});

describe("check selection (M9, M10)", () => {
  const none = { packageJson: null, pytestIni: false, conftest: false, pyproject: null, setupCfg: null, toxIni: null };

  it("recognises the npm init placeholder test script, whatever the quoting and case", () => {
    expect(isPlaceholderTestScript('echo "Error: no test specified" && exit 1')).toBe(true);
    expect(isPlaceholderTestScript("echo 'error: no test specified' && exit 1")).toBe(true);
    expect(isPlaceholderTestScript('  echo "Error: no test specified"   &&  exit 1  ')).toBe(true);
    expect(isPlaceholderTestScript("node t/run.js")).toBe(false);
    expect(isPlaceholderTestScript('echo "Error: no test specified" && exit 0')).toBe(false);
  });

  it("selects typecheck and node tests from package.json scripts; a placeholder test script selects nothing", () => {
    const pkg = (scripts: Record<string, string>): string => JSON.stringify({ scripts });
    expect(selectFromFiles({ ...none, packageJson: pkg({ typecheck: "tsc", test: "node t/run.js" }) }, "auto"))
      .toEqual({ typecheck: true, node: true, pytest: false, extras: [] });
    expect(selectFromFiles({ ...none, packageJson: pkg({ test: 'echo "Error: no test specified" && exit 1' }) }, "auto"))
      .toEqual({ typecheck: false, node: false, pytest: false, extras: [] });
    expect(selectFromFiles({ ...none, packageJson: pkg({}) }, "auto")).toEqual({ typecheck: false, node: false, pytest: false, extras: [] });
  });

  it("tolerates a missing, malformed or non-object package.json", () => {
    for (const packageJson of [null, "{", "7", "null", '{"scripts":5}', '{"scripts":null}']) {
      expect(selectFromFiles({ ...none, packageJson }, "auto")).toEqual({ typecheck: false, node: false, pytest: false, extras: [] });
    }
  });

  it("non-string scripts do not count", () => {
    expect(selectFromFiles({ ...none, packageJson: JSON.stringify({ scripts: { test: 1, typecheck: true } }) }, "auto"))
      .toMatchObject({ typecheck: false, node: false });
  });

  it("selects pytest from any of its configuration files", () => {
    expect(selectFromFiles({ ...none, pytestIni: true }, "auto").pytest).toBe(true);
    expect(selectFromFiles({ ...none, conftest: true }, "auto").pytest).toBe(true);
    expect(selectFromFiles({ ...none, pyproject: "[tool.pytest.ini_options]\n" }, "auto").pytest).toBe(true);
    expect(selectFromFiles({ ...none, setupCfg: "[tool:pytest]\n" }, "auto").pytest).toBe(true);
    expect(selectFromFiles({ ...none, toxIni: "[pytest]\n" }, "auto").pytest).toBe(true);
    expect(selectFromFiles({ ...none, pyproject: "[tool.black]\n", setupCfg: "[metadata]\n", toxIni: "[tox]\n" }, "auto").pytest).toBe(false);
  });

  it("extras: 'auto' adds none, an explicit list is copied (not aliased)", () => {
    const extras = [{ script: "lint", args: ["--quiet"] }];
    const out = selectFromFiles(none, extras);
    expect(out.extras).toEqual(extras);
    expect(out.extras[0]).not.toBe(extras[0]);
    expect(out.extras[0]?.args).not.toBe(extras[0]?.args);
    expect(selectFromFiles(none, []).extras).toEqual([]);
  });
});

describe("land path helpers", () => {
  it("samePath folds separators and trailing separators, and case only on win32", () => {
    expect(samePath("C:\\Repo\\", "c:/repo", "win32")).toBe(true);
    expect(samePath("C:\\Repo", "c:/repo", "linux")).toBe(false);
    expect(samePath("/a/b//", "/a/b", "linux")).toBe(true);
    expect(samePath("C:\\", "C:/", "win32")).toBe(true);
    expect(samePath("/", "/", "linux")).toBe(true);
    expect(samePath("/a", "/b", "linux")).toBe(false);
  });

  it("phaseTagName is omr/<plan>/phase/<encoded phase> (git.ts naming, QA-3.2-14)", () => {
    expect(phaseTagName("plan1", "p2")).toBe("omr/plan1/phase/p2");
    expect(phaseTagName("plan1", "p2")).toBe(gitPhaseTagName("plan1", "p2"));
  });
});

/** A typed partial double: unset members are absent (calling one is a test bug and throws a TypeError). */
function stub<T extends object>(partial: Partial<T>): T {
  return partial as T;
}

type RunResult = Awaited<ReturnType<GitRunner["run"]>>;
function runResult(code: number | null, stdout = "", stderr = ""): RunResult {
  return { code, signal: null, stdout, stderr, truncated: false, durationMs: 0 };
}

// QA-3.2-14/-17/-20: every owner-checkout probe runs `-C <toplevel> --no-optional-locks ...hardeningArgs() <args>` through
// the injected hardened runner (`run`); the doubles below match the git subcommand after that prefix.
describe("createLander", () => {
  const req: LandRequest = { toplevel: "/repo", baseBranch: "main", candidate: "cand", integrationBranch: "omr/int" };
  const probePrefix = (toplevel: string): string[] => ["-C", toplevel, "--no-optional-locks", ...hardeningArgs()];
  const PROBE_PREFIX_LENGTH = probePrefix("/repo").length;

  interface World {
    probes: Record<string, RunResult>;
    seen: string[][];
    baseTip: string | null;
    ancestor: boolean;
    behind: boolean;
    changed: NameStatus[];
    ignored: string[];
    merge: Awaited<ReturnType<GitOps["mergeFfOnly"]>>;
    guardError: unknown;
    realpath: (p: string) => Promise<string>;
    createRef: IntegrateGit["createRef"];
    ignoredCalls: string[][];
  }
  function world(over: Partial<World> = {}): { w: World; lander: ReturnType<typeof createLander> } {
    const w: World = {
      probes: {
        "rev-parse --show-toplevel": runResult(0, "/repo\n"),
        "symbolic-ref -q HEAD": runResult(0, "refs/heads/main\n"),
        status: runResult(0, ""),
      },
      seen: [], baseTip: "base", ancestor: true, behind: false, changed: [], ignored: [],
      merge: { ok: true, head: "cand" },
      guardError: null, realpath: async p => p, createRef: async () => "created", ignoredCalls: [],
      ...over,
    };
    w.probes = {
      "rev-parse --show-toplevel": runResult(0, "/repo\n"),
      "symbolic-ref -q HEAD": runResult(0, "refs/heads/main\n"),
      status: runResult(0, ""),
      ...over.probes,
    };
    const run = stub<GitRunner>({
      run: async args => {
        w.seen.push([...args]);
        // The probe prefix is `-C <toplevel> --no-optional-locks ...hardeningArgs()`; the key is the subcommand after it.
        const sub = args.slice(PROBE_PREFIX_LENGTH);
        const key = sub[0] === "status" ? "status" : sub.join(" ");
        return w.probes[key] ?? runResult(1);
      },
    });
    const igit = stub<IntegrateGit>({
      readRef: async () => w.baseTip,
      // isAncestor(base, candidate) answers `ancestor`; the reverse question (is the candidate already in the base?) `behind`.
      isAncestor: async (_cwd, ancestor) => (ancestor === req.candidate ? w.behind : w.ancestor),
      diffNameStatus: async () => w.changed,
      ignoredAt: async (_cwd, paths) => { w.ignoredCalls.push([...paths]); return w.ignored; },
      createRef: (cwd, ref, commit) => w.createRef(cwd, ref, commit),
    });
    const git = stub<GitOps>({ mergeFfOnly: async () => w.merge });
    const guard: WriteGuard = {
      assertWriteCwd: async () => { if (w.guardError !== null) throw w.guardError; },
    };
    const lander = createLander({ git, igit, guard, run, realpath: p => w.realpath(p), platform: "linux" });
    return { w, lander };
  }

  it("refuses with toplevel-mismatch when rev-parse fails or reports another directory", async () => {
    const failing = world({ probes: { "rev-parse --show-toplevel": runResult(128) } });
    expect(await failing.lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "toplevel-mismatch", actual: "" }, baseTip: null });
    const other = world({ probes: { "rev-parse --show-toplevel": runResult(0, "/elsewhere\n") } });
    expect(await other.lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "toplevel-mismatch", actual: "/elsewhere" }, baseTip: null });
  });

  it("probes with -C <toplevel> and falls back to the raw paths when realpath fails", async () => {
    const { w, lander } = world({ realpath: async () => { throw new Error("ENOENT"); }, baseTip: null });
    expect(await lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "base-missing" }, baseTip: null });
    expect(w.seen[0]).toEqual([...probePrefix("/repo"), "rev-parse", "--show-toplevel"]);
    expect(w.seen[0]?.slice(0, 3)).toEqual(["-C", "/repo", "--no-optional-locks"]);
  });

  it("every owner-checkout probe runs hardened with -C <toplevel>", async () => {
    const { w, lander } = world();
    expect(await lander.inspect(req)).toEqual({ ok: true, baseTip: "base", noop: false });
    expect(w.seen.map(a => a.slice(0, PROBE_PREFIX_LENGTH))).toEqual([probePrefix("/repo"), probePrefix("/repo"), probePrefix("/repo")]);
    expect(w.seen.map(a => a.slice(PROBE_PREFIX_LENGTH))).toEqual([
      ["rev-parse", "--show-toplevel"], ["symbolic-ref", "-q", "HEAD"], ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
    ]);
  });

  it("compares the realpaths of the reported and the recorded toplevel", async () => {
    const { lander } = world({
      realpath: async p => (p === "/link" ? "/repo" : p),
      probes: { "rev-parse --show-toplevel": runResult(0, "/repo/\n") },
    });
    expect(await lander.inspect({ ...req, toplevel: "/link" })).toMatchObject({ ok: true, noop: false });
  });

  it("refuses with not-checked-out and names the current head (null when detached or empty)", async () => {
    const detached = world({ probes: { "rev-parse --show-toplevel": runResult(0, "/repo"), "symbolic-ref -q HEAD": runResult(1) } });
    expect(await detached.lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "not-checked-out", head: null }, baseTip: "base" });
    const empty = world({ probes: { "rev-parse --show-toplevel": runResult(0, "/repo"), "symbolic-ref -q HEAD": runResult(0, "\n") } });
    expect(await empty.lander.inspect(req)).toMatchObject({ refusal: { reason: "not-checked-out", head: null } });
    const other = world({ probes: { "rev-parse --show-toplevel": runResult(0, "/repo"), "symbolic-ref -q HEAD": runResult(0, "refs/heads/dev\n") } });
    expect(await other.lander.inspect(req)).toMatchObject({ refusal: { reason: "not-checked-out", head: "refs/heads/dev" } });
  });

  it("throws when git status fails in the owner checkout, and fastForward reports it as an error", async () => {
    const { lander } = world({ probes: {
      "rev-parse --show-toplevel": runResult(0, "/repo"), "symbolic-ref -q HEAD": runResult(0, "refs/heads/main"), status: runResult(null),
    } });
    await expect(lander.inspect(req)).rejects.toThrow(/exit unknown/);
    expect(await lander.fastForward(req)).toEqual({ kind: "error", message: expect.stringContaining("git status failed") });
  });

  it("lists dirty paths, skipping short fields and the origin of renames and copies", async () => {
    const status = ["R  new.txt", "old.txt", " M mod.txt", "??", "C  copy.txt", "src.txt", "?? untracked.txt", ""].join("\0");
    const { lander } = world({ probes: {
      "rev-parse --show-toplevel": runResult(0, "/repo"), "symbolic-ref -q HEAD": runResult(0, "refs/heads/main"), status: runResult(0, status),
    } });
    expect(await lander.inspect(req)).toEqual({
      ok: false, refusal: { reason: "dirty", paths: ["new.txt", "mod.txt", "copy.txt", "untracked.txt"] }, baseTip: "base",
    });
  });

  it("refuses diverged when the base tip is not an ancestor of the candidate", async () => {
    const { lander } = world({ ancestor: false });
    expect(await lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "diverged", baseTip: "base" }, baseTip: "base" });
  });

  it("is a noop when the base tip already is the candidate", async () => {
    const { lander, w } = world({ baseTip: "cand" });
    expect(await lander.inspect(req)).toEqual({ ok: true, baseTip: "cand", noop: true });
    expect(w.ignoredCalls).toEqual([]);
  });

  it("is a noop, not diverged, when the base already contains the candidate (the owner moved on after landing)", async () => {
    const { lander, w } = world({ ancestor: false, behind: true });
    expect(await lander.inspect(req)).toEqual({ ok: true, baseTip: "base", noop: true });
    expect(w.ignoredCalls).toEqual([]);
    // One no-op convention (land.ts and queue.ts): nothing moved here, so from = to = the candidate.
    expect(await world({ ancestor: false, behind: true }).lander.fastForward(req)).toEqual({ kind: "landed", from: "cand", to: "cand" });
  });

  it("refuses ignored-overwrite for added or changed paths only; deletions are not probed", async () => {
    const blocked = world({ changed: [{ status: "A", path: "a.txt" }, { status: "D", path: "gone.txt" }], ignored: ["a.txt"] });
    expect(await blocked.lander.inspect(req)).toEqual({ ok: false, refusal: { reason: "ignored-overwrite", paths: ["a.txt"] }, baseTip: "base" });
    expect(blocked.w.ignoredCalls).toEqual([["a.txt"]]);
    const clear = world({ changed: [{ status: "M", path: "m.txt" }] });
    expect(await clear.lander.inspect(req)).toEqual({ ok: true, baseTip: "base", noop: false });
    const onlyDeletes = world({ changed: [{ status: "D", path: "gone.txt" }] });
    expect(await onlyDeletes.lander.inspect(req)).toEqual({ ok: true, baseTip: "base", noop: false });
    expect(onlyDeletes.w.ignoredCalls).toEqual([]);
  });

  it("fastForward: refusal, noop, diverged merge, unexpected head, success and thrown errors", async () => {
    expect(await world({ ancestor: false }).lander.fastForward(req)).toMatchObject({ kind: "refused", refusal: { reason: "diverged" } });
    expect(await world({ baseTip: "cand" }).lander.fastForward(req)).toEqual({ kind: "landed", from: "cand", to: "cand" });
    expect(await world({ merge: { ok: false, head: "moved" } }).lander.fastForward(req))
      .toEqual({ kind: "refused", refusal: { reason: "diverged", baseTip: "moved" } });
    expect(await world({ merge: { ok: true, head: "other" } }).lander.fastForward(req))
      .toEqual({ kind: "error", message: "fast-forward left HEAD at other, expected cand" });
    expect(await world().lander.fastForward(req)).toEqual({ kind: "landed", from: "base", to: "cand" });
    expect(await world({ guardError: new Error("not the toplevel") }).lander.fastForward(req)).toEqual({ kind: "error", message: "not the toplevel" });
    expect(await world({ guardError: "plain" }).lander.fastForward(req)).toEqual({ kind: "error", message: "plain" });
  });

  it("tag creates refs/tags/<name> and reports a thrown error as an outcome", async () => {
    const refs: string[] = [];
    const ok = world({ createRef: async (_cwd, ref, commit) => { refs.push(`${ref}@${commit}`); return "exists-same"; } });
    expect(await ok.lander.tag({ cwd: "/slot", name: "omr/plan1/phase/p2", commit: "abc" })).toBe("exists-same");
    expect(refs).toEqual(["refs/tags/omr/plan1/phase/p2@abc"]);
    const bad = world({ createRef: async () => { throw new Error("boom"); } });
    expect(await bad.lander.tag({ cwd: "/slot", name: "n", commit: "abc" })).toEqual({ kind: "error", message: "boom" });
    expect(ok.lander.tagName("plan1", "p2")).toBe("omr/plan1/phase/p2");
  });

  it("commands: one hint list per refusal, none when nothing can be done", () => {
    const { lander } = world();
    const merge = 'git -C "/repo" merge --ff-only cand';
    expect(lander.commands(req, { reason: "dirty", paths: ["a"] })).toEqual([
      'git -C "/repo" status --porcelain=v1 --untracked-files=all', "# commit or stash the changes above, then:", merge,
    ]);
    expect(lander.commands(req, { reason: "not-checked-out", head: null })).toEqual(['git -C "/repo" switch main', merge]);
    expect(lander.commands(req, { reason: "diverged", baseTip: "b" })).toEqual([
      'git -C "/repo" log --oneline cand..main', "# the owner chooses; the executor never runs this:", 'git -C "/repo" merge refs/heads/omr/int',
    ]);
    expect(lander.commands(req, { reason: "ignored-overwrite", paths: ["x", "y"] })).toEqual([
      "# ignored file would be overwritten: x", "# ignored file would be overwritten: y", "# move them, then:", merge,
    ]);
    expect(lander.commands(req, { reason: "toplevel-mismatch", actual: "/z" })).toEqual([]);
    expect(lander.commands(req, { reason: "base-missing" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Write guard and IntegrateGit
// ---------------------------------------------------------------------------------------------------------------

describe("createWriteGuard (M30)", () => {
  const ledger = stub<LedgerV1>({
    planId: "plan",
    repo: stub<LedgerV1["repo"]>({ toplevel: "/repo" }),
    integration: stub<LedgerV1["integration"]>({ worktree: "/wt" }),
  });
  const slotRecord = (path: string): SlotRecord => stub<SlotRecord>({ path });
  function guardOf(platform: NodeJS.Platform, o: { ledger?: LedgerV1; slots?: string[]; realpath?: (p: string) => Promise<string> } = {}) {
    const listed: Array<string | undefined> = [];
    const pool = stub<SlotPool>({ list: async planId => { listed.push(planId); return (o.slots ?? []).map(slotRecord); } });
    return { guard: createWriteGuard({ ledger: () => o.ledger ?? ledger, pool, realpath: o.realpath ?? (async p => p), platform }), listed };
  }

  it("allows the integration worktree and the slots of the plan, whatever the trailing separator", async () => {
    const { guard, listed } = guardOf("linux", { slots: ["/slots/s1"] });
    await expect(guard.assertWriteCwd("/wt/", "integration")).resolves.toBeUndefined();
    await expect(guard.assertWriteCwd("/slots/s1", "slot")).resolves.toBeUndefined();
    expect(listed).toEqual(["plan", "plan"]);
  });

  it("refuses any other directory", async () => {
    const { guard } = guardOf("linux", { slots: ["/slots/s1"] });
    await expect(guard.assertWriteCwd("/elsewhere", "tag")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(guard.assertWriteCwd("/elsewhere", "tag")).rejects.toThrow(/outside the slots/);
  });

  it("a slot path that does not resolve cannot be the cwd, but does not hide the others", async () => {
    const realpath = async (p: string): Promise<string> => {
      if (p === "/gone") throw new Error("ENOENT");
      return p;
    };
    const { guard } = guardOf("linux", { slots: ["/gone", "/slots/s2"], realpath });
    await expect(guard.assertWriteCwd("/slots/s2", "slot")).resolves.toBeUndefined();
    await expect(guard.assertWriteCwd("/slots/s3", "slot")).rejects.toThrow(/outside the slots/);
  });

  it("a landing write is allowed only in the repository toplevel", async () => {
    const { guard } = guardOf("linux");
    await expect(guard.assertWriteCwd("/repo", "land")).resolves.toBeUndefined();
    await expect(guard.assertWriteCwd("/wt", "land")).rejects.toThrow(/repository toplevel/);
  });

  it("folds case and separators on win32 only, and keeps a drive root", async () => {
    const winLedger = stub<LedgerV1>({
      planId: "plan", repo: stub<LedgerV1["repo"]>({ toplevel: "C:\\" }), integration: stub<LedgerV1["integration"]>({ worktree: "c:/Repo/WT" }),
    });
    const w = guardOf("win32", { ledger: winLedger });
    await expect(w.guard.assertWriteCwd("C:\\REPO\\wt\\", "integration")).resolves.toBeUndefined();
    await expect(w.guard.assertWriteCwd("c:/", "land")).resolves.toBeUndefined();
    const posix = guardOf("linux", { ledger: winLedger });
    await expect(posix.guard.assertWriteCwd("/wt", "land")).rejects.toThrow();
    const root = stub<LedgerV1>({ planId: "plan", repo: stub<LedgerV1["repo"]>({ toplevel: "/" }), integration: stub<LedgerV1["integration"]>({ worktree: "/wt" }) });
    await expect(guardOf("linux", { ledger: root }).guard.assertWriteCwd("/", "land")).resolves.toBeUndefined();
  });
});

describe("createIntegrateGit", () => {
  type Reply = RunResult | ((args: readonly string[]) => RunResult);
  function gitEnv(replies: Reply[] = [], kinds: Record<string, "file" | "dir"> = {}) {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const writes: string[] = [];
    const lstats: string[] = [];
    let n = 0;
    const run = stub<GitRunner>({
      run: async (args, o) => {
        calls.push({ args, cwd: o.cwd });
        const reply = replies[n++] ?? runResult(0);
        return typeof reply === "function" ? reply(args) : reply;
      },
    });
    const guard: WriteGuard = { assertWriteCwd: async (cwd, purpose) => { writes.push(`${purpose}:${cwd}`); } };
    const lstatOf = async (p: string) => {
      const key = p.replace(/\\/g, "/");
      lstats.push(key);
      const kind = kinds[key];
      if (kind === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isDirectory: () => kind === "dir" };
    };
    return { igit: createIntegrateGit(run, guard, lstatOf), calls, writes, lstats };
  }
  /** The git arguments after the shared prefix (--no-optional-locks plus the hardening flags). */
  const rest = (args: readonly string[], first: string): string[] => args.slice(args.indexOf(first));

  it("diffNameStatus parses the -z name-status pairs; an unknown status counts as modified", async () => {
    const { igit, calls } = gitEnv([runResult(0, "M\0a.ts\0A\0b.ts\0D\0c.ts\0T\0d.ts\0X\0e.ts\0Z\0")]);
    expect(await igit.diffNameStatus("/wt", "from", "to")).toEqual([
      { status: "M", path: "a.ts" }, { status: "A", path: "b.ts" }, { status: "D", path: "c.ts" }, { status: "T", path: "d.ts" }, { status: "M", path: "e.ts" },
    ]);
    expect(rest(calls[0]?.args ?? [], "diff")).toEqual(["diff", "--name-status", "-z", "--no-renames", "--no-ext-diff", "from", "to", "--"]);
    expect(calls[0]?.args[0]).toBe("--no-optional-locks");
    expect(calls[0]?.cwd).toBe("/wt");
  });

  it("a failing read is an E_GIT error naming the exit code, the signal or unknown", async () => {
    const long = "e".repeat(5000);
    const a = gitEnv([runResult(128, "", long)]);
    const err = await a.igit.revList("/wt", "a", "b").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_GIT", message: "git rev-list failed (exit 128)" });
    expect(err).toBeInstanceOf(ExecutorError);
    const detail = JSON.stringify(err instanceof ExecutorError ? err.detail : null);
    expect(detail).toContain('"op":"rev-list"');
    expect(detail).toContain("e".repeat(2048));
    expect(detail).not.toContain("e".repeat(2049));
    const sig = gitEnv([{ ...runResult(null), signal: "SIGTERM" }]);
    await expect(sig.igit.mergeBase("/wt", "a", "b")).rejects.toThrow("git merge-base failed (exit SIGTERM)");
    const none = gitEnv([runResult(null)]);
    await expect(none.igit.subject("/wt", "a")).rejects.toThrow("(exit unknown)");
  });

  it("logPaths pairs sha and subject, skips blank shas and passes a literal pathspec", async () => {
    const { igit, calls } = gitEnv([runResult(0, "sha1\0first\0\0skipped\0\nsha2\0second\0")]);
    expect(await igit.logPaths("/wt", "a", "b", "dir/f.ts", 5)).toEqual([{ sha: "sha1", subject: "first" }, { sha: "sha2", subject: "second" }]);
    expect(rest(calls[0]?.args ?? [], "log")).toEqual(["log", "-z", "--format=%H%x00%s", "-n", "5", "a..b", "--", ":(literal)dir/f.ts"]);
  });

  it("revList returns the trimmed non-empty lines, oldest first", async () => {
    const { igit, calls } = gitEnv([runResult(0, "a\n b \n\nc\n")]);
    expect(await igit.revList("/wt", "x", "y")).toEqual(["a", "b", "c"]);
    expect(rest(calls[0]?.args ?? [], "rev-list")).toEqual(["rev-list", "--reverse", "--topo-order", "x..y"]);
  });

  it("createRef creates against the zero id after asserting the tag write cwd", async () => {
    const { igit, calls, writes } = gitEnv([runResult(0)]);
    expect(await igit.createRef("/wt", "refs/tags/t", "abcd")).toBe("created");
    expect(writes).toEqual(["tag:/wt"]);
    expect(rest(calls[0]?.args ?? [], "update-ref")).toEqual(["update-ref", "refs/tags/t", "abcd", "0000"]);
  });

  it("createRef reports an existing ref: same commit, another commit, or fails when it is not there", async () => {
    const same = gitEnv([runResult(1), runResult(0, "abcd\n")]);
    expect(await same.igit.createRef("/wt", "refs/tags/t", "abcd")).toBe("exists-same");
    const other = gitEnv([runResult(1), runResult(0, "ffff\n")]);
    expect(await other.igit.createRef("/wt", "refs/tags/t", "abcd")).toEqual({ kind: "exists-other", at: "ffff" });
    const missing = gitEnv([runResult(128, "", "locked"), runResult(1)]);
    await expect(missing.igit.createRef("/wt", "refs/tags/t", "abcd")).rejects.toThrow("git update-ref failed");
  });

  it("readRef: a commit, null for an unknown ref, an error otherwise", async () => {
    const { igit, calls } = gitEnv([runResult(0, "abc\n"), runResult(1), runResult(129, "", "bad")]);
    expect(await igit.readRef("/wt", "refs/heads/m")).toBe("abc");
    expect(rest(calls[0]?.args ?? [], "rev-parse")).toEqual(["rev-parse", "--verify", "-q", "--end-of-options", "refs/heads/m^{commit}"]);
    expect(await igit.readRef("/wt", "refs/heads/none")).toBeNull();
    await expect(igit.readRef("/wt", "refs/heads/bad")).rejects.toThrow("git rev-parse failed");
  });

  it("mergeBase trims, isAncestor maps exit 0/1 and fails on anything else", async () => {
    const { igit } = gitEnv([runResult(0, "base\n"), runResult(0), runResult(1), runResult(128)]);
    expect(await igit.mergeBase("/wt", "a", "b")).toBe("base");
    expect(await igit.isAncestor("/wt", "a", "b")).toBe(true);
    expect(await igit.isAncestor("/wt", "a", "b")).toBe(false);
    await expect(igit.isAncestor("/wt", "a", "b")).rejects.toThrow("git merge-base failed");
  });

  it("showFile returns the content, or null when the path is not in the commit", async () => {
    const { igit, calls } = gitEnv([runResult(0, "content"), runResult(128)]);
    expect(await igit.showFile("/wt", "c1", "package.json")).toBe("content");
    expect(rest(calls[0]?.args ?? [], "show")).toEqual(["show", "c1:package.json"]);
    expect(await igit.showFile("/wt", "c1", "missing")).toBeNull();
  });

  it("subject drops the trailing newline only", async () => {
    const { igit } = gitEnv([runResult(0, "feat: x\r\n"), runResult(0, "a\nb\n")]);
    expect(await igit.subject("/wt", "c1")).toBe("feat: x");
    expect(await igit.subject("/wt", "c1")).toBe("a\nb");
  });

  it("ignoredAt lists the exact paths file by file and a parent only where it exists as a non-directory (QA-3.2-12)", async () => {
    const none = gitEnv();
    expect(await none.igit.ignoredAt("/wt", [])).toEqual([]);
    expect(none.calls).toEqual([]);
    // a/ is a real directory (its other ignored files must not refuse landing); a/b is an ignored FILE where the
    // change needs a directory; p is itself a changed path (asked once, never lstat'ed); /abs and f do not exist.
    const { igit, calls, lstats } = gitEnv([runResult(0, "a/b\0x\0")], { "/wt/a": "dir", "/wt/a/b": "file" });
    expect(await igit.ignoredAt("/wt", ["a/b/c.txt", "a/d.txt", "x", "/abs/y", "p", "p/q.txt", "f/g.txt"])).toEqual(["a/b", "x"]);
    const args = calls[0]?.args ?? [];
    expect(args).not.toContain("--directory");
    expect(rest(args, "ls-files").slice(0, 6)).toEqual(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--"]);
    expect(args.slice(args.lastIndexOf("--") + 1)).toEqual([
      ":(literal)a/b/c.txt", ":(literal)a/d.txt", ":(literal)x", ":(literal)/abs/y", ":(literal)p", ":(literal)p/q.txt", ":(literal)f/g.txt",
      ":(literal)a/b",
    ]);
    expect(lstats).toEqual(["/wt/a/b", "/wt/a", "/wt/abs", "/wt/f"]);
  });

  it("ignoredAt with only directory parents passes no parent at all", async () => {
    const { igit, calls } = gitEnv([runResult(0, "")], { "/wt/src": "dir" });
    expect(await igit.ignoredAt("/wt", ["src/new.ts"])).toEqual([]);
    expect((calls[0]?.args ?? []).slice(-2)).toEqual(["--", ":(literal)src/new.ts"]);
  });

  it("revertAbort does nothing without REVERT_HEAD and aborts otherwise, asserting the slot write cwd", async () => {
    const idle = gitEnv([runResult(1)]);
    await idle.igit.revertAbort("/slot");
    expect(idle.writes).toEqual(["slot:/slot"]);
    expect(idle.calls).toHaveLength(1);
    const active = gitEnv([runResult(0, "sha"), runResult(0)]);
    await active.igit.revertAbort("/slot");
    expect(rest(active.calls[1]?.args ?? [], "revert")).toEqual(["revert", "--abort"]);
    const failing = gitEnv([runResult(0, "sha"), runResult(1, "", "no")]);
    await expect(failing.igit.revertAbort("/slot")).rejects.toThrow("git revert --abort failed");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Integration checks doubles
// ---------------------------------------------------------------------------------------------------------------

const noneOut = (exitCode: number | null = 0, o: Partial<CommandOutput> = {}): CommandOutput => ({
  exitCode, timedOut: false, stdout: "", stderr: "", durationMs: 5, ...o,
});
const okHandle = (released: string[], tag = "h"): SlotHandle => ({ lost: false, release: async () => { released.push(tag); } });
const scoped = (o: Partial<ScopedSpec> = {}): ScopedSpec => ({
  runner: "vitest", mode: "related", file: "node", args: ["vitest", "run"], cwd: "/slot/pkg", env: { A: "1" }, reportPath: "/tmp/r.json",
  gitRoot: "/slot", entry: "/slot/node_modules/vitest/vitest.mjs", inputs: ["/slot/a.test.ts"], inputsAreTests: true, workers: 2, notes: [], ...o,
});
const report = (o: Partial<VerifyResult> = {}): VerifyResult => ({
  failingIds: [], failingFiles: [], collectionError: false, total: 1, complete: true, source: "report", ...o,
});
const noAffected: NoAffected = { noAffected: true, note: "none" };
const unverifiable: Unverifiable = { unverifiable: true, reason: "no runner", code: "no-git-root" };
const detected = stub<DetectedRunner>({ kind: "vitest", launcher: "direct" });

interface ChecksOpts {
  files?: Record<string, string | null>;
  diff?: NameStatus[];
  diffError?: Error;
  head?: string;
  resetError?: unknown;
  spawn?: (c: ResolvedCommand, o: { cwd: string; signal: AbortSignal; lowPriority: boolean }, n: number) => CommandOutput | Promise<CommandOutput>;
  acquire?: (o: SlotOptions, n: number) => SlotResult | Promise<SlotResult>;
  /** null: leave the dependency unset, so the default (wiring.preemptBackgroundVerification) runs. */
  preemptForeground?: (() => Promise<void>) | null;
  resolve?: (ref: RunCommandRef, cwd: string) => { ok: true; command: ResolvedCommand } | { ok: false; reason: string };
  config?: Partial<LedgerV1["config"]>;
  allowCommand?: (command: string) => boolean;
  slotMax?: number;
  background?: BackgroundRuns;
  /** Which test files exist (default: every one). */
  exists?: (p: string) => boolean;
}
const PKG_BOTH = JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest run" } });

function checksEnv(o: ChecksOpts = {}) {
  const spawned: Array<{ c: ResolvedCommand; cwd: string; low: boolean }> = [];
  const released: string[] = [];
  const acquired: SlotOptions[] = [];
  const preempts: string[] = [];
  const resets: string[] = [];
  let tick = 0;
  const background = o.background ?? new BackgroundRuns();
  const pool = stub<SlotPool>({
    reset: async (s, commit) => { resets.push(`reset:${s}@${commit}`); current = commit; if (o.resetError !== undefined) throw o.resetError; },
    cleanForChecks: async s => { resets.push(`clean:${s}`); },
    // The plan's slots: the ci slot that observed a suite failure, and this check's slot.
    list: async () => [stub<SlotRecord>({ path: nodePath.resolve("/ci") }), stub<SlotRecord>({ path: nodePath.resolve("/slot") })],
  });
  // The slot follows its last reset (default "cand"), unless the test pins its head.
  let current = "cand";
  const git = stub<GitOps>({ revParse: async () => o.head ?? current });
  const igit = stub<IntegrateGit>({
    showFile: async (_cwd, _commit, path) => (o.files ?? { "package.json": null })[path] ?? null,
    diffNameStatus: async () => { if (o.diffError !== undefined) throw o.diffError; return o.diff ?? []; },
  });
  const resolver: RunResolver = {
    resolve: async (ref, cwd) => (o.resolve ?? ((r: RunCommandRef) => ({
      ok: true as const, command: { label: r.script, file: "npm", args: ["run", r.script, ...r.args], source: "package-script" as const, ref: r },
    })))(ref, cwd),
  };
  const checks = createIntegrationChecks({
    ledger: () => stub<LedgerV1>({
      planId: "plan", integration: stub<LedgerV1["integration"]>({ worktree: nodePath.resolve("/integration") }),
      config: stub<LedgerV1["config"]>({ integrationChecks: "auto", python: "auto", ...o.config }),
    }),
    pool, git, igit, resolver,
    spawn: async (c, opts) => {
      spawned.push({ c, cwd: opts.cwd, low: opts.lowPriority });
      return (o.spawn ?? (() => noneOut()))(c, opts, spawned.length);
    },
    guard: { assertWriteCwd: async () => undefined },
    background, clock: stub<Clock>({ now: () => (tick += 10) }), logger: { warn: () => undefined },
    ...(o.preemptForeground === null ? {} : { preemptForeground: o.preemptForeground ?? (async () => { preempts.push("fg"); }) }),
    acquire: async (opts) => {
      acquired.push(opts);
      return (o.acquire ?? (() => okHandle(released)))(opts, acquired.length);
    },
    ...(o.slotMax === undefined ? {} : { slotMax: o.slotMax }),
    ...(o.allowCommand === undefined ? {} : { allowCommand: o.allowCommand }),
    fileExists: async p => (o.exists ?? (() => true))(p),
  });
  return { checks, spawned, released, acquired, preempts, resets, background, at: () => current };
}

function checkReq(o: Partial<CheckRequest> = {}): CheckRequest {
  return { slot, base: "base", candidate: "cand", priority: "foreground", signal: new AbortController().signal, ...o };
}

// ---------------------------------------------------------------------------------------------------------------
// Phase suite runner doubles
// ---------------------------------------------------------------------------------------------------------------

const slot: SlotLease = { slot: "s1", path: "/slot", planId: "plan", owner: "integration", commit: "c3" };
const cmd: ResolvedCommand = { label: "npm test", file: "npm", args: ["test"], source: "package-script", ref: { script: "test", args: [] } };

function runRes(verdict: CommandRunResult["verdict"], o: Partial<CommandRunResult> = {}): CommandRunResult {
  return { verdict, ids: [], files: [], idsUnparsed: false, output: "", durationMs: 1, error: null, ...o };
}
function failRes(ids: string[], o: Partial<CommandRunResult> = {}): CommandRunResult {
  return runRes("fail", { ids, files: ["f.test.ts"], output: "out", ...o });
}
/** A failure as runCommands reports a full run: each id's file resolved against the slot (`fileOfSuiteId`). */
function suiteFail(ids: string[], o: Partial<CommandRunResult> = {}): CommandRunResult {
  return failRes(ids, { files: [...new Set(ids.map(id => fileOfSuiteId("/slot", id)))].sort(), ...o });
}
function errRes(reason: CheckErrorReason, message = "m"): CommandRunResult {
  return runRes("error", { error: { reason, message } });
}
function byCommit(m: Record<string, CommandRunResult>): (req: CommandRunRequest) => CommandRunResult {
  return req => m[req.commit] ?? runRes("pass");
}

function journalOf(signal: AbortSignal = new AbortController().signal) {
  const log = {
    order: [] as string[],
    starts: [] as Array<{ step: IntegrationStep; detail: StepDetail; patch: unknown }>,
    ends: [] as Array<{ result: string; detail: StepDetail; ids: readonly string[] | undefined }>,
    counters: [] as Array<{ key: string; value: number; labels: Record<string, string> }>,
    cwds: [] as string[],
  };
  const j: StepJournal = {
    entry: { id: "i-1", kind: "phase-suite", phaseId: "p1", taskIds: [], slot: "s1", baseHead: "c0", candidate: null },
    signal,
    start: async (step, detail, patch) => { log.order.push(`start:${step}`); log.starts.push({ step, detail, patch }); },
    end: async (result, detail, ids) => { log.order.push(`end:${result}`); log.ends.push({ result, detail, ids }); },
    assertWriteCwd: async (cwd, purpose) => { log.cwds.push(`${purpose}:${cwd}`); },
    counter: (key, value, labels) => { log.counters.push({ key, value, labels }); },
  };
  return { j, log };
}

function suiteEnv(over: {
  runCommands?: (req: CommandRunRequest, n: number) => CommandRunResult;
  checks?: Partial<IntegrationChecks>; igit?: Partial<IntegrateGit>; git?: Partial<GitOps>; resolver?: Partial<RunResolver>;
} = {}) {
  const requests: CommandRunRequest[] = [];
  const background = new BackgroundRuns();
  const checks = stub<IntegrationChecks>({
    runCommands: async req => { requests.push(req); return (over.runCommands ?? (() => runRes("pass")))(req, requests.length); },
    ...over.checks,
  });
  const runner = createPhaseSuiteRunner({
    checks, igit: stub<IntegrateGit>({ ...over.igit }), git: stub<GitOps>({ ...over.git }), pool: stub<SlotPool>({}),
    resolver: stub<RunResolver>({ ...over.resolver }), background, clock: stub<Clock>({}), logger: { warn: () => undefined },
  });
  return { runner, requests, background };
}

function suiteReq(o: Partial<SuiteRunRequest> = {}): SuiteRunRequest {
  return { planId: "plan", phaseId: "p1", commit: "c3", base: "c0", ranges: rangesOf(3), commands: [cmd], slot, ...o };
}

const lintCfg: Partial<LedgerV1["config"]> = { integrationChecks: [{ script: "lint", args: [] }] };

describe("phase suite execution cwd", () => {
  it.each(["auto", "configured"] as const)("runs the %s suite, base and probes at their commits in CI, then checks the revert slot", async setting => {
    const integration = nodePath.resolve("/integration");
    const ci = { ...slot, slot: "ci", path: nodePath.resolve("/ci") };
    let integrationHead = "c9"; // Integration has moved on beyond the suite commit under test.
    const executed: Array<{ label: string; cwd: string; commit: string }> = [];
    const resolve: NonNullable<ChecksOpts["resolve"]> = (ref, cwd) => ({
      ok: true, command: { ...cmd, label: ref.script, ref, resolution: { cwd, env: {} } },
    });
    runnerHooks.planScopedRun = async () => unverifiable;
    const env = checksEnv({
      files: { "package.json": PKG_BOTH }, config: lintCfg, resolve,
      spawn: (command, opts) => {
        // Match the production spawner too: a command cwd overrides the options cwd a second time.
        const cwd = command.cwd ?? opts.cwd;
        const commit = cwd === integration ? integrationHead : env.at();
        executed.push({ label: command.label, cwd, commit });
        return commit === "c0" || commit === "c1" || commit === "rh" ? noneOut() : noneOut(1, { stdout: "unparsed failure" });
      },
    });
    const { runner } = suiteEnv({
      checks: env.checks, resolver: { resolve: async (ref, cwd) => resolve(ref, cwd) },
      igit: { revList: async (_cwd, _from, to) => to === "c2" ? ["c2"] : ["c1", "c2", "c3"], subject: async () => "change [plan:T2]" },
      git: { revert: async () => { integrationHead = "rh"; return { ok: true, head: "rh" }; }, revParse: async () => integrationHead },
    });
    const ledger = stub<LedgerV1>({
      integration: stub<LedgerV1["integration"]>({ worktree: integration }),
      config: stub<LedgerV1["config"]>({ phaseSuite: setting === "auto" ? "auto" : [{ script: "suite", args: [] }] }),
    });
    const resolved = await runner.resolve(ledger, "p1", "c3");
    if (resolved.kind !== "runs") throw new Error("expected suite commands");
    const verdict = await runner.run(suiteReq({ slot: ci, commands: resolved.commands }), journalOf().j);
    expect(executed.slice(0, 4).map(({ cwd, commit }) => ({ cwd, commit }))).toEqual(
      ["c3", "c3", "c3", "c0"].map(commit => ({ cwd: ci.path, commit })),
    );
    expect(executed.every(run => run.cwd === ci.path)).toBe(true);
    expect(new Set(executed.slice(4).map(run => run.commit))).toEqual(new Set(["c1", "c2"]));
    expect(integrationHead).toBe("c9");
    expect(verdict).toEqual({ kind: "culprit", range: { taskId: "T2", from: "c1", to: "c2" }, ids: [], files: [] });
    expect(env.resets.filter(r => r.startsWith("reset:"))).toEqual(executed.map(run => `reset:ci@${run.commit}`));

    // Reuse the resolved suite command for the full-command revert regression; CI is still at a bisect commit.
    executed.length = 0;
    expect(await runner.revert({
      planId: "plan", phaseId: "p1", culprit: { taskId: "T2", from: "c1", to: "c2" }, suiteCommit: "c3", head: "c9",
      regression: { ids: [], files: [], commands: resolved.commands }, slot: { ...slot, slot: "integration", path: integration },
    }, journalOf().j)).toEqual({ kind: "ok", revertHead: "rh", reverted: ["c2"] });
    expect(executed).toEqual(["typecheck", "test", "lint", setting === "auto" ? "test" : "suite"].map(label => ({ label, cwd: integration, commit: "rh" })));
    expect(env.resets.slice(-4)).toEqual(["reset:integration@c9", "clean:integration", "reset:integration@rh", "clean:integration"]);
  });

  it("preserves an intentional command cwd instead of changing shared exec semantics", async () => {
    const override = { ...cmd, cwd: "/slot/pkg" };
    const { runner } = suiteEnv({ resolver: { resolve: async () => ({ ok: true, command: override }) } });
    const resolved = await runner.resolve(stub<LedgerV1>({
      integration: stub<LedgerV1["integration"]>({ worktree: "/integration" }),
      config: stub<LedgerV1["config"]>({ phaseSuite: [{ script: "test", args: [] }] }),
    }), "p1", "c3");
    if (resolved.kind !== "runs") throw new Error("expected suite commands");
    const { checks, spawned } = checksEnv();
    expect(await checks.runCommands({ slot, commit: "c3", commands: resolved.commands, mode: "full", priority: "background", signal: new AbortController().signal, prepare: true }))
      .toMatchObject({ verdict: "pass" });
    expect(spawned[0]).toMatchObject({ cwd: override.cwd, c: override });
  });
});

describe("integration checks: prepare and select", () => {
  it("prepare resets, cleans and verifies the head of the slot", async () => {
    const { checks, resets } = checksEnv();
    await checks.prepare(slot, "cand");
    expect(resets).toEqual(["reset:s1@cand", "clean:s1"]);
  });

  it("prepare wraps a failing slot operation (Error and non-Error) in a CheckPrepareError", async () => {
    const a = checksEnv({ resetError: new Error("boom") });
    const err = await a.checks.prepare(slot, "cand").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckPrepareError);
    expect(err).toMatchObject({ name: "CheckPrepareError", message: "could not prepare slot s1: boom" });
    const b = checksEnv({ resetError: "plain" });
    await expect(b.checks.prepare(slot, "cand")).rejects.toThrow("could not prepare slot s1: plain");
  });

  it("prepare refuses a slot that is not at the requested commit, naming both (12 characters)", async () => {
    const { checks } = checksEnv({ head: "1234567890abcdef" });
    const err = await checks.prepare(slot, "fedcba0987654321").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckPrepareError);
    expect(err).toMatchObject({ message: "slot s1 is at 1234567890ab, not fedcba098765" });
  });

  it("select resolves typecheck and the node tests from package.json", async () => {
    const { checks } = checksEnv({ files: { "package.json": PKG_BOTH } });
    const sel = await checks.select("/slot", "cand");
    expect(sel.typecheck).toMatchObject({ label: "typecheck", args: ["run", "typecheck"] });
    expect(sel.tests).toHaveLength(1);
    expect(sel.tests[0]).toMatchObject({ framework: "node", full: { label: "test" } });
    expect(sel.extras).toEqual([]);
  });

  it("select adds pytest with the configured python, unless the command is not allowed", async () => {
    const labels: string[] = [];
    const auto = checksEnv({ files: { "pytest.ini": "" }, allowCommand: l => { labels.push(l); return true; } });
    const sel = await auto.checks.select("/slot", "cand");
    expect(sel.tests).toEqual([{ framework: "pytest", full: { label: "python -m pytest", file: "python", args: ["-m", "pytest"], source: "pytest", ref: null } }]);
    expect(labels).toEqual(["python -m pytest"]);
    const custom = checksEnv({ files: { "conftest.py": "" }, config: { python: "py3" } });
    expect((await custom.checks.select("/slot", "cand")).tests[0]?.full).toMatchObject({ label: "py3 -m pytest", file: "py3" });
    const denied = checksEnv({ files: { "pytest.ini": "" }, allowCommand: () => false });
    expect((await denied.checks.select("/slot", "cand")).tests).toEqual([]);
  });

  it("select resolves the configured extra checks", async () => {
    const { checks } = checksEnv({ config: { integrationChecks: [{ script: "lint", args: ["-q"] }, { script: "audit", args: [] }] } });
    const sel = await checks.select("/slot", "cand");
    expect(sel.extras.map(e => e.args)).toEqual([["run", "lint", "-q"], ["run", "audit"]]);
  });

  it("select rejects with the resolver's reason for a typecheck, a test or an extra it refuses", async () => {
    const refuse = (script: string) => (r: RunCommandRef) => (r.script === script
      ? { ok: false as const, reason: "not allowed" }
      : { ok: true as const, command: { label: r.script, file: "npm", args: [], source: "package-script" as const, ref: r } });
    const a = checksEnv({ files: { "package.json": PKG_BOTH }, resolve: refuse("typecheck") });
    await expect(a.checks.select("/slot", "cand")).rejects.toThrow("typecheck: not allowed");
    const b = checksEnv({ files: { "package.json": PKG_BOTH }, resolve: refuse("test") });
    await expect(b.checks.select("/slot", "cand")).rejects.toThrow("test: not allowed");
    const c = checksEnv({ config: lintCfg, resolve: refuse("lint") });
    await expect(c.checks.select("/slot", "cand")).rejects.toThrow("lint: not allowed");
  });
});

describe("integration checks: run", () => {
  it("reports a prepare error with no component", async () => {
    const { checks, acquired } = checksEnv({ resetError: new Error("boom") });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "error", reason: "prepare", message: "could not prepare slot s1: boom", components: [] });
    expect(acquired).toHaveLength(0);
  });

  it("reports a refused command as a resolve error and a failing diff as a prepare error", async () => {
    const a = checksEnv({ files: { "package.json": PKG_BOTH }, resolve: r => ({ ok: false, reason: `no ${r.script}` }) });
    expect(await a.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "resolve", message: "typecheck: no typecheck" });
    const b = checksEnv({ diffError: new Error("diff failed") });
    expect(await b.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "prepare", message: "diff failed" });
  });

  it("passes with the no-checks note when nothing is selected, and takes no slot", async () => {
    const { checks, acquired, spawned } = checksEnv();
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "pass", components: [], flakyIds: [], note: "no-checks" });
    expect(r.durationMs).toBeGreaterThan(0);
    expect(acquired).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it("a regression command alone is a check", async () => {
    const regress: ResolvedCommand = { label: "regress", file: "npm", args: ["run", "regress"], source: "run-command", ref: null };
    const { checks, spawned } = checksEnv();
    const r = await checks.run(checkReq({ extra: { ids: [], files: [], commands: [regress] } }));
    expect(r).toMatchObject({ verdict: "pass", note: null, components: [{ name: "regression", label: "regress", exitCode: 0, scope: "full" }] });
    expect(spawned.map(s => s.c.label)).toEqual(["regress"]);
  });

  it("runs typecheck, scoped tests, extras and regression in order under the slot and passes", async () => {
    const regress: ResolvedCommand = { label: "regress", file: "npm", args: ["run", "regress"], source: "run-command", ref: null };
    const captured: { input: PlanScopedRunInput | null } = { input: null };
    runnerHooks.planScopedRun = async input => { captured.input = input; return noAffected; };
    const { checks, spawned, released, acquired } = checksEnv({
      files: { "package.json": PKG_BOTH }, config: lintCfg, diff: [{ status: "M", path: "src/a.ts" }],
    });
    const r = await checks.run(checkReq({ extra: { ids: ["x"], files: ["extra.test.ts"], commands: [regress] } }));
    expect(r).toMatchObject({ verdict: "pass", flakyIds: [], note: null });
    if (r.verdict !== "pass") throw new Error("expected pass");
    expect(r.components.map(c => `${c.name}:${c.label}:${c.scope}`)).toEqual([
      "typecheck:typecheck:full", "tests:no affected tests:no-affected", "extra:lint:full", "regression:regress:full",
    ]);
    expect(spawned.map(s => s.c.label)).toEqual(["typecheck", "lint", "regress"]);
    expect(spawned.every(s => s.cwd === "/slot" && !s.low)).toBe(true);
    expect(released).toEqual(["h"]);
    expect(acquired[0]).toMatchObject({ max: 2, waitMs: 2000, meta: { cwd: "/slot", command: "integration checks" } });
    const input = captured.input;
    expect(input).toMatchObject({ command: "npm test", cwd: "/slot", budget: { maxWorkers: 2 } });
    // QA-3.2-6: the regression files are judged by the regression component only, not added to the scoped tests.
    expect(input?.changedFiles).toEqual([{ path: nodePath.join("/slot", "src/a.ts"), status: "M" }]);
  });

  it("a pytest component is planned under its own label", async () => {
    let command = "";
    runnerHooks.planScopedRun = async input => { command = input.command; return noAffected; };
    const { checks } = checksEnv({ files: { "pytest.ini": "" } });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "pass" });
    expect(command).toBe("python -m pytest");
  });

  it("a failing typecheck fails fast with the output tail and runs nothing else", async () => {
    runnerHooks.planScopedRun = async () => { throw new Error("tests must not be planned"); };
    const { checks, spawned } = checksEnv({
      files: { "package.json": PKG_BOTH }, spawn: () => noneOut(1, { stdout: "o".repeat(3000), stderr: "e".repeat(3000) }),
    });
    const r = await checks.run(checkReq({ priority: "background" }));
    expect(r).toMatchObject({ verdict: "fail", failingIds: [], failingFiles: [], flakyIds: [] });
    if (r.verdict !== "fail") throw new Error("expected fail");
    expect(Buffer.byteLength(r.output)).toBe(4096);
    expect(r.output.endsWith("e".repeat(3000))).toBe(true);
    expect(r.components).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.low).toBe(true);
  });

  it("a timed out extra or regression command fails", async () => {
    const a = checksEnv({ config: lintCfg, spawn: () => noneOut(null, { timedOut: true, stdout: "slow" }) });
    expect(await a.checks.run(checkReq())).toMatchObject({ verdict: "fail", output: "slow", components: [{ name: "extra", timedOut: true, exitCode: null }] });
    const regress: ResolvedCommand = { label: "regress", file: "npm", args: [], source: "run-command", ref: null };
    const b = checksEnv({ config: lintCfg, spawn: c => (c.label === "regress" ? noneOut(2) : noneOut()) });
    const r = await b.checks.run(checkReq({ extra: { ids: [], files: [], commands: [regress] } }));
    expect(r).toMatchObject({ verdict: "fail" });
    if (r.verdict !== "fail") return;
    expect(r.components.map(c => c.name)).toEqual(["extra", "regression"]);
  });
});

describe("integration checks: revert regression (QA-3.2-6)", () => {
  const X = "t.test.ts > x", OTHER = "t.test.ts > other";
  const ciFile = nodePath.resolve("/ci", "t.test.ts");
  // Re-rooted under the check's slot path ("/slot", joined as given).
  const here = nodePath.join("/slot", "t.test.ts");
  const extra = (o: Partial<NonNullable<CheckRequest["extra"]>> = {}) => ({ extra: { ids: [X], files: [ciFile], commands: [cmd], ...o } });

  function regressionEnv(results: VerifyResult[], spawn?: ChecksOpts["spawn"]) {
    const planned: Array<readonly string[]> = [];
    let n = 0;
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async (_r, files) => { planned.push(files); return scoped({ mode: "rerun", args: ["rr"] }); };
    runnerHooks.readResult = async () => results[n++] ?? report();
    return { ...checksEnv(spawn === undefined ? {} : { spawn }), planned };
  }

  it("reruns only the regression files, re-rooted from the ci slot; a complete passing rerun passes", async () => {
    const env = regressionEnv([report()], () => noneOut(0));
    const r = await env.checks.run(checkReq(extra()));
    expect(r).toMatchObject({ verdict: "pass", components: [{ name: "regression", label: "npm test", scope: "rerun", exitCode: 0 }] });
    expect(env.planned).toEqual([[here]]);
    expect(env.spawned.map(s => s.c.args)).toEqual([["rr"]]);
  });

  it("QA-3.2-26: a failing rerun that names none of the regression ids fails closed with every regression id", async () => {
    // Another id form (jest JSON `<abs> > <fullName>`) or another failure: neither clears the regression.
    for (const named of [[OTHER], [`${here} > x`]]) {
      const env = regressionEnv([report({ failingIds: named, failingFiles: [here] })], () => noneOut(1, { stdout: "red" }));
      expect(await env.checks.run(checkReq(extra()))).toMatchObject({ verdict: "fail", failingIds: [X], failingFiles: [here], output: "red" });
    }
  });

  it("a regression id that still fails makes the revert insufficient, naming only the regression ids", async () => {
    const env = regressionEnv([report({ failingIds: [OTHER, X], failingFiles: [here] })], () => noneOut(1, { stdout: "still" }));
    expect(await env.checks.run(checkReq(extra()))).toMatchObject({ verdict: "fail", failingIds: [X], failingFiles: [here], flakyIds: [], output: "still" });
  });

  it("a timeout or a collection error in the regression files fails with every regression id", async () => {
    for (const [res, out] of [[report(), noneOut(null, { timedOut: true })], [report({ collectionError: true, failingIds: ["t.test.ts"] }), noneOut(1)]] as const) {
      const env = regressionEnv([res], () => out);
      expect(await env.checks.run(checkReq(extra()))).toMatchObject({ verdict: "fail", failingIds: [X] });
    }
  });

  it("an incomplete rerun falls back to the whole command, judged by the ids its output names (none named: fail closed)", async () => {
    const cases: Array<{ full: CommandOutput; verdict: string; ids?: string[] }> = [
      { full: noneOut(0), verdict: "pass" },
      { full: noneOut(1, { stdout: ` FAIL  ${OTHER}\n Tests  1 failed (1)\n` }), verdict: "fail", ids: [X] },
      { full: noneOut(1, { stdout: ` FAIL  ${X}\n FAIL  ${OTHER}\n Tests  2 failed (2)\n` }), verdict: "fail", ids: [X] },
      { full: noneOut(1, { stdout: "unparsed" }), verdict: "fail", ids: [X] },
    ];
    for (const c of cases) {
      const env = regressionEnv([report({ complete: false })], (_c, _o, k) => (k === 1 ? noneOut(0) : c.full));
      const r = await env.checks.run(checkReq(extra()));
      expect(r).toMatchObject(c.ids === undefined ? { verdict: c.verdict } : { verdict: c.verdict, failingIds: c.ids });
      expect(env.spawned.map(s => s.c.args)).toEqual([["rr"], ["test"]]);
      if (r.verdict !== "error") expect(r.components.at(-1)).toMatchObject({ name: "regression", scope: "full" });
    }
  });

  it("QA-3.2-24: no regression file present here, or none the planner maps, runs the whole command judged by the ids", async () => {
    const detectedFor: string[] = [];
    runnerHooks.detectRunner = async command => { detectedFor.push(command); return detected; };
    runnerHooks.planRerun = async () => noAffected;
    const py: ResolvedCommand = { label: "python -m pytest", file: "python", args: ["-m", "pytest"], source: "pytest", ref: null };
    // The files are gone (reverted away, or not re-rootable): nothing is planned, the whole commands run and pass.
    const gone = checksEnv({ exists: () => false });
    expect(await gone.checks.run(checkReq(extra({ commands: [cmd, py] })))).toMatchObject({
      verdict: "pass", components: [{ name: "regression", label: "npm test", scope: "full" }, { name: "regression", label: "python -m pytest", scope: "full" }],
    });
    expect(gone.spawned.map(s => s.c.label)).toEqual(["npm test", "python -m pytest"]);
    expect(detectedFor).toEqual([]);
    // No file at all: the whole command, failing with a regression id, fails.
    const none = checksEnv({ spawn: () => noneOut(1, { stdout: ` FAIL  ${X}\n Tests  1 failed (1)\n` }) });
    expect(await none.checks.run(checkReq(extra({ files: [] })))).toMatchObject({ verdict: "fail", failingIds: [X], failingFiles: [] });
    const green = checksEnv();
    expect(await green.checks.run(checkReq(extra({ files: [] })))).toMatchObject({ verdict: "pass", components: [{ name: "regression", scope: "full" }] });
    // Present files the planner maps to no test: the whole command too (never "no affected tests" -> pass).
    const unmapped = checksEnv({ spawn: () => noneOut(1, { stdout: "boom" }) });
    expect(await unmapped.checks.run(checkReq(extra({ commands: [py, cmd] })))).toMatchObject({ verdict: "fail", failingIds: [X] });
    expect(detectedFor).toEqual(["python -m pytest"]);
    expect(unmapped.spawned.map(s => s.c.label)).toEqual(["python -m pytest"]);
    runnerHooks.detectRunner = async () => unverifiable;
    const blind = checksEnv({ spawn: () => noneOut(1, { stdout: ` FAIL  ${OTHER}\n Tests  1 failed (1)\n` }) });
    expect(await blind.checks.run(checkReq(extra()))).toMatchObject({ verdict: "fail", failingIds: [X], components: [{ name: "regression", scope: "full" }] });
    runnerHooks.detectRunner = async () => { throw new Error("a non-test command is never planned"); };
    const script: ResolvedCommand = { label: "suite", file: "npm", args: ["run", "suite"], source: "run-command", ref: { script: "suite", args: [] } };
    const other = checksEnv({ spawn: () => noneOut(1, { stdout: ` FAIL  ${X}\n Tests  1 failed (1)\n` }) });
    expect(await other.checks.run(checkReq(extra({ commands: [script] })))).toMatchObject({ verdict: "fail", failingIds: [X] });
    expect(other.spawned.map(s => s.c.label)).toEqual(["suite"]);
  });

  it("re-roots ci-slot and integration-worktree paths, joins relative ones and keeps unknown absolute ones", async () => {
    const env = regressionEnv([report()], () => noneOut(0));
    const stray = nodePath.resolve("/elsewhere", "u.test.ts");
    const files = [ciFile, nodePath.resolve("/integration", "sub", "i.test.ts"), "rel.test.ts", stray, nodePath.resolve("/ci")];
    expect(await env.checks.run(checkReq(extra({ files })))).toMatchObject({ verdict: "pass" });
    expect(env.planned).toEqual([[here, nodePath.join("/slot", "sub", "i.test.ts"), nodePath.join("/slot", "rel.test.ts"), stray, nodePath.resolve("/ci")]]);
  });

  it("regression ids without commands rerun with this commit's test commands, or fail closed without any", async () => {
    const env = regressionEnv([report()], () => noneOut(0));
    runnerHooks.planScopedRun = async () => noAffected;
    const withTests = checksEnv({ files: { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) } });
    const r = await withTests.checks.run(checkReq(extra({ commands: [] })));
    expect(r).toMatchObject({ verdict: "pass" });
    if (r.verdict === "pass") expect(r.components.map(c => `${c.name}:${c.label}`)).toEqual(["tests:no affected tests", "regression:test"]);
    expect(await env.checks.run(checkReq(extra({ commands: [] })))).toMatchObject({
      verdict: "error", reason: "resolve", message: "the regression ids have no test command to rerun them",
    });
  });
});

describe("integration checks: tests component", () => {
  const PKG_TEST = { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) };
  const f1 = "a.test.ts > s > one", f2 = "b.py::C::two";

  it("an unverifiable plan never counts as verified: the full command runs", async () => {
    runnerHooks.planScopedRun = async () => unverifiable;
    const ok = checksEnv({ files: PKG_TEST });
    const r = await ok.checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "pass", components: [{ name: "tests", label: "test", scope: "full", exitCode: 0 }] });
    expect(ok.spawned[0]?.c.label).toBe("test");

    const bad = checksEnv({ files: PKG_TEST, spawn: () => noneOut(1, { stdout: "out-", stderr: "err" }) });
    expect(await bad.checks.run(checkReq())).toMatchObject({ verdict: "fail", failingIds: [], failingFiles: [], output: "out-err" });
    const timed = checksEnv({ files: PKG_TEST, spawn: () => noneOut(0, { timedOut: true }) });
    expect(await timed.checks.run(checkReq())).toMatchObject({ verdict: "fail" });
  });

  it("a complete clean scoped run passes under the spec command, in the spec's directory and environment", async () => {
    runnerHooks.planScopedRun = async () => scoped();
    runnerHooks.readResult = async () => report();
    const { checks, spawned } = checksEnv({ files: PKG_TEST });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "pass", components: [{ name: "tests", label: "test", scope: "spec" }] });
    expect(spawned[0]).toMatchObject({ cwd: "/slot/pkg", c: { file: "node", args: ["vitest", "run"], env: { A: "1" }, cwd: "/slot/pkg" } });
  });

  it("a timed out or colliding scoped failure is final: no confirmation rerun, no full run", async () => {
    let reruns = 0;
    runnerHooks.planScopedRun = async () => scoped();
    runnerHooks.detectRunner = async () => { reruns++; return detected; };
    const cases: Array<{ out: CommandOutput; res: VerifyResult; ids: string[]; files: string[] }> = [
      { out: noneOut(null, { timedOut: true }), res: report({ failingIds: ["a"], failingFiles: ["/slot/a"] }), ids: ["a"], files: ["/slot/a"] },
      { out: noneOut(1), res: report({ failingIds: ["a"], failingFiles: ["/slot/a"], collectionError: true }), ids: ["a"], files: ["/slot/a"] },
    ];
    for (const c of cases) {
      runnerHooks.readResult = async () => c.res;
      const { checks, spawned } = checksEnv({ files: PKG_TEST, spawn: () => ({ ...c.out, stdout: "so", stderr: "se" }) });
      const r = await checks.run(checkReq());
      expect(r).toMatchObject({ verdict: "fail", failingIds: c.ids, failingFiles: c.files, flakyIds: [], output: "sose" });
      expect(spawned).toHaveLength(1);
    }
    expect(reruns).toBe(0);
  });

  it("QA-3.2-7: an incomplete or id-less scoped report never blames: the full command decides", async () => {
    runnerHooks.planScopedRun = async () => scoped();
    runnerHooks.detectRunner = async () => { throw new Error("no confirmation rerun of an unparsed full failure"); };
    // exit 0 with an incomplete report: the full command passes, so the check passes (it used to fail the task).
    runnerHooks.readResult = async () => report({ complete: false, failingIds: ["partial"] });
    const a = checksEnv({ files: PKG_TEST, spawn: (_c, _o, k) => (k === 1 ? noneOut(0) : noneOut(0, { stdout: "full ok" })) });
    const ra = await a.checks.run(checkReq());
    expect(ra).toMatchObject({ verdict: "pass", components: [{ name: "tests", label: "test", scope: "full", exitCode: 0 }] });
    expect(a.spawned.map(s => s.c.args)).toEqual([["vitest", "run"], ["run", "test"]]);
    // A failing scoped run whose report names no id (incomplete or not): the full command fails too, unparsed.
    for (const res of [report({ complete: false }), report()]) {
      runnerHooks.readResult = async () => res;
      const b = checksEnv({ files: PKG_TEST, spawn: (_c, _o, k) => (k === 1 ? noneOut(1) : noneOut(1, { stdout: "so", stderr: "se" })) });
      expect(await b.checks.run(checkReq())).toMatchObject({ verdict: "fail", failingIds: [], failingFiles: [], flakyIds: [], output: "sose" });
      expect(b.spawned).toHaveLength(2);
    }
  });

  /** First run fails ids [f1, f2]; the rerun is scripted. */
  function rerunEnv(
    second: { out: CommandOutput; res: VerifyResult },
    o: { runner?: DetectedRunner | Unverifiable; rerun?: ScopedSpec | NoAffected | Unverifiable; full?: CommandOutput } = {},
  ) {
    const results = [report({ failingIds: [f1, f2], failingFiles: ["/slot/a.test.ts", "/slot/b.py"] }), second.res];
    let n = 0;
    const planned: Array<{ files: readonly string[]; command: string }> = [];
    runnerHooks.planScopedRun = async () => scoped();
    runnerHooks.readResult = async () => results[n++] ?? report();
    runnerHooks.detectRunner = async command => { planned.push({ files: [], command }); return o.runner ?? detected; };
    runnerHooks.planRerun = async (_runner, files) => { planned.push({ files, command: "rerun" }); return o.rerun ?? scoped({ mode: "rerun", args: ["rerun"], env: { B: "2" }, cwd: "/slot/rr" }); };
    const env = checksEnv({
      files: PKG_TEST,
      spawn: (_c, _o, k) => (k === 1 ? noneOut(1, { stdout: "first" }) : k === 2 ? { ...second.out, stdout: "second" } : (o.full ?? noneOut(0))),
    });
    return { ...env, planned };
  }

  it("a failure that passes on the rerun is flaky: the check passes and names the flaky ids", async () => {
    const { checks, spawned, planned } = rerunEnv({ out: noneOut(0), res: report() });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "pass", flakyIds: [f1, f2], note: null });
    if (r.verdict !== "pass") return;
    expect(r.components).toMatchObject([{ name: "tests", scope: "rerun", flakyIds: [f1, f2] }]);
    expect(spawned[1]).toMatchObject({ cwd: "/slot/rr", c: { args: ["rerun"], env: { B: "2" } } });
    expect(planned).toEqual([{ files: [], command: "npm test" }, { files: ["/slot/a.test.ts", "/slot/b.py"], command: "rerun" }]);
  });

  it("only the ids that fail again are failing; the others are flaky", async () => {
    const { checks } = rerunEnv({ out: noneOut(1), res: report({ failingIds: [f1], failingFiles: ["/slot/a.test.ts"] }) });
    const r = await checks.run(checkReq());
    // failingFiles are the first failure's files (the dead conditional of round 1 is gone).
    expect(r).toMatchObject({ verdict: "fail", failingIds: [f1], failingFiles: ["/slot/a.test.ts", "/slot/b.py"], flakyIds: [f2], output: "second" });
    if (r.verdict !== "fail") return;
    expect(r.components).toMatchObject([{ scope: "rerun", flakyIds: [f2] }]);
  });

  it("a rerun that fails without naming ids keeps every original id failing", async () => {
    const { checks } = rerunEnv({ out: noneOut(1), res: report() });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "fail", failingIds: [f1, f2], failingFiles: ["/slot/a.test.ts", "/slot/b.py"], flakyIds: [] });
  });

  it("a rerun with a collection error or a timeout clears no id", async () => {
    for (const out of [noneOut(0), noneOut(null, { timedOut: true })]) {
      const collection = out.timedOut ? false : true;
      const { checks } = rerunEnv({ out, res: report({ failingIds: [f2], failingFiles: ["/slot/b.py"], collectionError: collection }) });
      const r = await checks.run(checkReq());
      expect(r).toMatchObject({ verdict: "fail", failingIds: [f1, f2], flakyIds: [], output: "second" });
    }
  });

  it("QA-3.2-7: an incomplete rerun with exit 0 is no pass; the full command is the second observation", async () => {
    // Full command passes: every id is flaky.
    const pass = rerunEnv({ out: noneOut(0), res: report({ complete: false }) });
    const rp = await pass.checks.run(checkReq());
    expect(rp).toMatchObject({ verdict: "pass", flakyIds: [f1, f2] });
    if (rp.verdict === "pass") expect(rp.components).toMatchObject([{ name: "tests", scope: "full", flakyIds: [f1, f2] }]);
    expect(pass.spawned.map(s => s.c.args)).toEqual([["vitest", "run"], ["rerun"], ["run", "test"]]);
    // Full command fails naming f1 with a complete inventory: f1 is confirmed, f2 flaky.
    const named = rerunEnv({ out: noneOut(0), res: report({ complete: false }) }, { full: noneOut(1, { stdout: ` FAIL  ${f1}\n Tests  1 failed | 3 passed (4)\n` }) });
    const rn = await named.checks.run(checkReq());
    expect(rn).toMatchObject({ verdict: "fail", failingIds: [f1], flakyIds: [f2], failingFiles: ["/slot/a.test.ts", "/slot/b.py"] });
    // Full command fails without a usable inventory: nothing is cleared.
    const blind = rerunEnv({ out: noneOut(0), res: report({ complete: false }) }, { full: noneOut(1, { stdout: "boom" }) });
    expect(await blind.checks.run(checkReq())).toMatchObject({ verdict: "fail", failingIds: [f1, f2], flakyIds: [], output: "boom" });
  });

  it("QA-3.2-1/-7: a full run's failure names its ids from the output and gets the confirmation rerun", async () => {
    runnerHooks.planScopedRun = async () => unverifiable;
    runnerHooks.detectRunner = async () => detected;
    const planned: Array<readonly string[]> = [];
    runnerHooks.planRerun = async (_r, files) => { planned.push(files); return scoped({ mode: "rerun", args: ["rerun"] }); };
    runnerHooks.readResult = async () => report({ failingIds: [f1], failingFiles: ["/slot/a.test.ts"] });
    const out = ` FAIL  ${f1}\nFAILED ${f2} - assert 1 == 2\n Tests  2 failed | 9 passed (11)\n`;
    const { checks, spawned } = checksEnv({ files: PKG_TEST, spawn: (_c, _o, k) => (k === 1 ? noneOut(1, { stdout: out }) : noneOut(1, { stdout: "again" })) });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "fail", failingIds: [f1], flakyIds: [f2], output: "again" });
    expect(spawned.map(s => s.c.args)).toEqual([["run", "test"], ["rerun"]]);
    expect(planned).toEqual([[nodePath.resolve("/slot", "a.test.ts"), nodePath.resolve("/slot", "b.py")]]);
  });

  it("QA-3.2-1: a full run's failure with an incomplete inventory is final, with the ids it names", async () => {
    runnerHooks.planScopedRun = async () => unverifiable;
    runnerHooks.detectRunner = async () => { throw new Error("no confirmation of a partial inventory"); };
    const { checks } = checksEnv({ files: PKG_TEST, spawn: () => noneOut(1, { stdout: ` FAIL  ${f1}\n Tests  3 failed (3)\n` }) });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "fail", failingIds: [f1], failingFiles: [nodePath.resolve("/slot", "a.test.ts")], flakyIds: [] });
  });

  it("without a rerunnable runner the first failure stands", async () => {
    for (const o of [{ runner: unverifiable }, { rerun: noAffected }, { rerun: unverifiable }]) {
      const { checks, spawned } = rerunEnv({ out: noneOut(0), res: report() }, o);
      const r = await checks.run(checkReq());
      expect(r).toMatchObject({ verdict: "fail", failingIds: [f1, f2], failingFiles: ["/slot/a.test.ts", "/slot/b.py"], flakyIds: [], output: "first" });
      expect(spawned).toHaveLength(1);
    }
  });

  it("ids of every shape stay failing with the first failure's files (the rerun fails with a mix of ids)", async () => {
    const ids = ["a.test.ts > s", "b.py::C::t", "bare.test.ts", "c.py::T > odd"];
    runnerHooks.planScopedRun = async () => scoped();
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async () => scoped({ mode: "rerun" });
    let n = 0;
    runnerHooks.readResult = async () => (n++ === 0 ? report({ failingIds: ids, failingFiles: ["/slot/x"] }) : report({ failingIds: ids, failingFiles: ["/slot/y"] }));
    const { checks } = checksEnv({ files: PKG_TEST, spawn: () => noneOut(1) });
    const r = await checks.run(checkReq());
    expect(r).toMatchObject({ verdict: "fail", failingIds: ids, failingFiles: ["/slot/x"], flakyIds: [] });
  });
});

describe("integration checks: verification slot (M12)", () => {
  const busy: SlotResult = { busy: true };

  it("a foreground check preempts background verification first, then preempts one background run per busy answer", async () => {
    const bg = new BackgroundRuns();
    const victim = new AbortController();
    bg.register(victim, 1);
    const mine: string[] = [];
    const { checks, acquired, preempts } = checksEnv({
      config: lintCfg, background: bg, slotMax: 5, acquire: (_o, n) => (n < 3 ? busy : okHandle(mine)),
    });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "pass" });
    expect(preempts).toEqual(["fg"]);
    expect(acquired).toHaveLength(3);
    expect(acquired[0]).toMatchObject({ max: 5 });
    expect(victim.signal.aborted).toBe(true);
    expect(mine).toEqual(["h"]);
  });

  it("a background check registers for preemption, never preempts others and runs at low priority", async () => {
    const bg = new BackgroundRuns();
    const other = new AbortController();
    bg.register(other, 1);
    const during: number[] = [];
    const { checks, spawned, preempts, acquired } = checksEnv({
      config: lintCfg, background: bg, acquire: (_o, n) => (n < 2 ? busy : okHandle([])),
      spawn: () => { during.push(bg.active); return noneOut(); },
    });
    expect(await checks.run(checkReq({ priority: "background" }))).toMatchObject({ verdict: "pass" });
    expect(during).toEqual([2]);
    expect(bg.active).toBe(1);
    expect(other.signal.aborted).toBe(false);
    expect(preempts).toEqual([]);
    expect(acquired).toHaveLength(2);
    expect(spawned[0]?.low).toBe(true);
  });

  it("the default preemption (wiring) works when none is injected", async () => {
    const { checks } = checksEnv({ config: lintCfg, preemptForeground: null });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "pass" });
  });

  it("an aborted request never takes a slot", async () => {
    const ac = new AbortController();
    ac.abort();
    const { checks, acquired, spawned } = checksEnv({ config: lintCfg });
    expect(await checks.run(checkReq({ signal: ac.signal }))).toMatchObject({
      verdict: "error", reason: "interrupted", message: "aborted while waiting for a verification slot",
    });
    expect(acquired).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });

  it("an abort while waiting for the slot ends the wait", async () => {
    const ac = new AbortController();
    const { checks, acquired } = checksEnv({ config: lintCfg, acquire: () => { ac.abort(); return busy; } });
    expect(await checks.run(checkReq({ signal: ac.signal }))).toMatchObject({
      verdict: "error", reason: "interrupted", message: "aborted while waiting for a verification slot",
    });
    expect(acquired).toHaveLength(1);
  });

  it("a slot reclaimed while held is a slot-lost error and the handle is still released", async () => {
    let onLost: (() => void) | undefined;
    const rel: string[] = [];
    const { checks } = checksEnv({
      config: lintCfg, acquire: o => { onLost = o.onLost; return okHandle(rel); }, spawn: () => { onLost?.(); return noneOut(); },
    });
    expect(await checks.run(checkReq())).toMatchObject({
      verdict: "error", reason: "slot-lost", message: "the verification slot was reclaimed while held",
    });
    expect(rel).toEqual(["h"]);
  });

  it("a handle that reports itself lost without the callback is a slot-lost run", async () => {
    const rel: string[] = [];
    const lost: SlotHandle = { lost: true, release: async () => { rel.push("l"); } };
    const { checks } = checksEnv({ config: lintCfg, acquire: () => lost });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "slot-lost", message: "the verification slot was reclaimed while held" });
    expect(rel).toEqual(["l"]);
  });

  it("QA-3.2-13: an abort during the checks is interrupted, never the verdict the killed run produced", async () => {
    const ac = new AbortController();
    const rel: string[] = [];
    const failing = checksEnv({ config: lintCfg, acquire: () => okHandle(rel), spawn: () => { ac.abort(); return noneOut(1, { stdout: "killed" }); } });
    expect(await failing.checks.run(checkReq({ signal: ac.signal }))).toMatchObject({ verdict: "error", reason: "interrupted", message: "the run was aborted" });
    expect(rel).toEqual(["h"]);
    // The outer abort wins over a lost slot and a preemption that fired with it.
    const bc = new AbortController();
    let onLost: (() => void) | undefined;
    const both = checksEnv({ config: lintCfg, acquire: o => { onLost = o.onLost; return okHandle([]); }, spawn: () => { onLost?.(); bc.abort(); return noneOut(0); } });
    expect(await both.checks.run(checkReq({ signal: bc.signal }))).toMatchObject({ verdict: "error", reason: "interrupted" });
    // A passing run that was aborted is not a pass either (runCommands too).
    const cc = new AbortController();
    const passing = checksEnv({ spawn: () => { cc.abort(); return noneOut(0); } });
    const r = await passing.checks.runCommands({ slot, commit: "c", commands: [cmd], mode: "full", priority: "background", signal: cc.signal, prepare: false });
    expect(r).toMatchObject({ verdict: "error", error: { reason: "interrupted", message: "the run was aborted" } });
  });

  it("a child killed by a fired signal rejects: that is the signal's outcome, not a spawn error", async () => {
    const ac = new AbortController();
    const aborted = checksEnv({ config: lintCfg, spawn: () => { ac.abort(); throw new Error("killed"); } });
    expect(await aborted.checks.run(checkReq({ signal: ac.signal }))).toMatchObject({ verdict: "error", reason: "interrupted" });
    const bg = new BackgroundRuns();
    const preempted = checksEnv({ config: lintCfg, background: bg, spawn: () => { bg.preemptOne(); throw new Error("killed"); } });
    expect(await preempted.checks.run(checkReq({ priority: "background" }))).toMatchObject({ verdict: "error", reason: "preempted" });
    let onLost: (() => void) | undefined;
    const lost = checksEnv({ config: lintCfg, acquire: o => { onLost = o.onLost; return okHandle([]); }, spawn: () => { onLost?.(); throw new Error("killed"); } });
    expect(await lost.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "slot-lost" });
    const gone: SlotHandle = { lost: true, release: async () => undefined };
    const lostHandle = checksEnv({ config: lintCfg, acquire: () => gone, spawn: () => { throw new Error("killed"); } });
    expect(await lostHandle.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "slot-lost" });
  });

  it("a background run preempted by a foreground check reports preempted", async () => {
    const bg = new BackgroundRuns();
    const { checks } = checksEnv({ config: lintCfg, background: bg, spawn: () => { bg.preemptOne(); return noneOut(); } });
    expect(await checks.run(checkReq({ priority: "background" }))).toMatchObject({
      verdict: "error", reason: "preempted", message: "a foreground check preempted this background run",
    });
    expect(bg.active).toBe(0);
  });

  it("a spawner failure is a spawn error (Error and non-Error) and releases the slot", async () => {
    const rel: string[] = [];
    const a = checksEnv({ config: lintCfg, acquire: () => okHandle(rel), spawn: () => { throw new Error("no such file"); } });
    expect(await a.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "spawn", message: "no such file" });
    expect(rel).toEqual(["h"]);
    const b = checksEnv({ config: lintCfg, spawn: () => Promise.reject("plain") });
    expect(await b.checks.run(checkReq())).toMatchObject({ verdict: "error", reason: "spawn", message: "plain" });
  });
});

describe("integration checks: test search and filesystem seams", () => {
  const PKG_TEST = { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) };
  const dirs: { root: string } = { root: "" };
  beforeAll(async () => { dirs.root = await mkdtemp(nodePath.join(tmpdir(), "omr-bisect-")); });
  afterAll(async () => { await rm(dirs.root, { recursive: true, force: true }); });

  it("the search runs git through the spawner and maps exit codes, time-outs and failures to undefined", async () => {
    const replies: Array<CommandOutput | Error> = [];
    const got: Record<string, readonly string[] | undefined> = {};
    runnerHooks.planScopedRun = async input => {
      const s = input.search;
      replies.push(noneOut(0, { stdout: "a/x.test.ts\0y.ts\0" }));
      got["name"] = await s.findByName("/root", ["a*b.ts"]);
      replies.push(noneOut(0));
      got["escaped"] = await s.findByName("/root", ["a?b", "c[d]", "e\\f"]);
      replies.push(noneOut(1));
      got["nameExit1"] = await s.findByName("/root", ["x"]);
      replies.push(noneOut(0, { timedOut: true }));
      got["nameTimeout"] = await s.findByName("/root", ["x"]);
      replies.push(new Error("spawn failed"));
      got["nameThrow"] = await s.findByName("/root", ["x"]);
      replies.push(noneOut(1));
      got["none"] = await s.findByContent("/root", "needle", ["*.ts"]);
      replies.push(noneOut(0, { stdout: "z.ts\0" }));
      got["hit"] = await s.findByContent("/root", "needle", ["*.ts"], { word: true });
      replies.push(noneOut(0, { stdout: "q.ts\0" }));
      got["plainHit"] = await s.findByContent("/root", "needle", ["*.ts"], { word: false });
      replies.push(noneOut(2));
      got["contentError"] = await s.findByContent("/root", "needle", ["*.ts"]);
      replies.push(noneOut(1, { timedOut: true }));
      got["contentTimeout"] = await s.findByContent("/root", "needle", ["*.ts"]);
      replies.push(new Error("spawn failed"));
      got["contentThrow"] = await s.findByContent("/root", "needle", ["*.ts"]);
      return noAffected;
    };
    const { checks, spawned } = checksEnv({
      files: PKG_TEST, spawn: () => { const r = replies.shift(); if (r instanceof Error) throw r; return r ?? noneOut(); },
    });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "pass" });
    expect(got["name"]).toEqual([nodePath.resolve("/root", "a/x.test.ts"), nodePath.resolve("/root", "y.ts")]);
    expect(got["escaped"]).toEqual([]);
    expect(got["nameExit1"]).toBeUndefined();
    expect(got["nameTimeout"]).toBeUndefined();
    expect(got["nameThrow"]).toBeUndefined();
    expect(got["none"]).toEqual([]);
    expect(got["hit"]).toEqual([nodePath.resolve("/root", "z.ts")]);
    expect(got["plainHit"]).toEqual([nodePath.resolve("/root", "q.ts")]);
    expect(got["contentError"]).toBeUndefined();
    expect(got["contentTimeout"]).toBeUndefined();
    expect(got["contentThrow"]).toBeUndefined();

    const calls = spawned.filter(s => s.c.file === "git");
    expect(calls).toHaveLength(11);
    expect(calls[0]).toMatchObject({ cwd: "/slot", low: true, c: { label: "git", source: "run-command", ref: null, cwd: "/slot" } });
    expect(calls[0]?.c.args).toEqual([
      "--no-optional-locks", "-C", "/root", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ":(glob)**/a[*]b.ts",
    ]);
    expect(calls[1]?.c.args.slice(-3)).toEqual([":(glob)**/a[?]b", ":(glob)**/c[[]d[]]", ":(glob)**/e[\\\\]f"]);
    expect(calls[6]?.c.args).toEqual([
      "--no-optional-locks", "-C", "/root", "grep", "-l", "-z", "-F", "-w", "--untracked", "-e", "needle", "--", "*.ts",
    ]);
    expect(calls[7]?.c.args).not.toContain("-w");
  });

  it("the filesystem seam reads real files, reports a missing file and tolerates an already deleted one", async () => {
    const file = nodePath.join(dirs.root, "f.txt");
    await writeFile(file, "hi");
    await mkdir(nodePath.join(dirs.root, "sub"));
    const expectedReal = await realpath(file);
    const got: {
      exists: boolean[]; text: string; real: string | undefined; stat: unknown; dir: readonly string[] | undefined;
      gone: boolean; dirError: unknown;
    } = { exists: [], text: "", real: undefined, stat: null, dir: undefined, gone: false, dirError: null };
    runnerHooks.planScopedRun = async input => {
      const fs = input.fs;
      got.exists = [await fs.fileExists(file), await fs.fileExists(nodePath.join(dirs.root, "nope"))];
      got.text = await fs.readFile(file);
      got.real = await fs.realpath?.(file);
      got.stat = await fs.stat?.(file);
      got.dir = await fs.readdir?.(dirs.root);
      return scoped();
    };
    runnerHooks.readResult = async (_spec, _exec, fs) => {
      await fs.unlink(file);
      got.gone = !(await fs.fileExists(file));
      await fs.unlink(file);
      got.dirError = await fs.unlink(nodePath.join(dirs.root, "sub")).then(() => null, (e: unknown) => e);
      return report();
    };
    const { checks } = checksEnv({ files: PKG_TEST });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "pass" });
    expect(got.exists).toEqual([true, false]);
    expect(got.text).toBe("hi");
    expect(got.real).toBe(expectedReal);
    expect(got.stat).toMatchObject({ isFile: true, size: 2n });
    expect([...(got.dir ?? [])].sort()).toEqual(["f.txt", "sub"]);
    expect(got.gone).toBe(true);
    expect(got.dirError).toBeInstanceOf(Error);
  });
});

describe("integration checks: runCommands", () => {
  const testCmd: ResolvedCommand = { label: "npm test", file: "npm", args: ["test"], source: "package-script", ref: { script: "test", args: [] } };
  const lintCmd: ResolvedCommand = { label: "lint", file: "npm", args: ["run", "lint"], source: "package-script", ref: { script: "lint", args: [] } };
  const pyCmd: ResolvedCommand = { label: "python -m pytest", file: "python", args: ["-m", "pytest"], source: "pytest", ref: null };
  function cmdReq(o: Partial<CommandRunRequest> = {}): CommandRunRequest {
    return { slot, commit: "cand", commands: [testCmd], mode: "full", priority: "foreground", signal: new AbortController().signal, prepare: true, ...o };
  }

  it("a prepare failure is an error result and takes no slot; prepare=false skips the preparation", async () => {
    const a = checksEnv({ resetError: new Error("boom") });
    const r = await a.checks.runCommands(cmdReq());
    expect(r).toMatchObject({ verdict: "error", ids: [], files: [], idsUnparsed: false, output: "", error: { reason: "prepare", message: "could not prepare slot s1: boom" } });
    expect(r.durationMs).toBeGreaterThan(0);
    expect(a.acquired).toHaveLength(0);
    const b = checksEnv();
    expect(await b.checks.runCommands(cmdReq({ prepare: false }))).toMatchObject({ verdict: "pass", error: null });
    expect(b.resets).toEqual([]);
  });

  it("the full mode runs every command and passes", async () => {
    const { checks, spawned } = checksEnv();
    const r = await checks.runCommands(cmdReq({ commands: [lintCmd, testCmd, pyCmd] }));
    expect(r).toMatchObject({ verdict: "pass", ids: [], files: [], idsUnparsed: false, error: null });
    expect(spawned.map(s => s.c.label)).toEqual(["lint", "npm test", "python -m pytest"]);
  });

  it("the first failing command stops the run: unparsed, with its output tail", async () => {
    const { checks, spawned } = checksEnv({ spawn: c => (c.label === "lint" ? noneOut(1, { stdout: "lint-out", stderr: "-err" }) : noneOut()) });
    const r = await checks.runCommands(cmdReq({ commands: [lintCmd, testCmd], priority: "background" }));
    expect(r).toMatchObject({ verdict: "fail", ids: [], files: [], idsUnparsed: true, output: "lint-out-err" });
    expect(spawned.map(s => s.c.label)).toEqual(["lint"]);
    expect(spawned[0]?.low).toBe(true);
    const t = checksEnv({ spawn: () => noneOut(0, { timedOut: true }) });
    expect(await t.checks.runCommands(cmdReq())).toMatchObject({ verdict: "fail", idsUnparsed: true });
  });

  it("a rerun narrows a test command to the failing files and collects sorted ids and files", async () => {
    const planned: Array<{ command: string; files: readonly string[] }> = [];
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async (_r, files) => { planned.push({ command: "rerun", files }); return scoped({ mode: "rerun", args: ["rr"], env: { R: "1" }, cwd: "/slot/rr" }); };
    runnerHooks.readResult = async () => report({ failingIds: ["b > y", "a > x"], failingFiles: ["/slot/b", "/slot/a"] });
    const { checks, spawned } = checksEnv({ spawn: () => noneOut(1, { stdout: "boom" }) });
    const r = await checks.runCommands(cmdReq({ mode: { rerun: ["a.test.ts > x", "b.py::T::t", "a.test.ts"] } }));
    expect(r).toMatchObject({ verdict: "fail", ids: ["a > x", "b > y"], files: ["/slot/a", "/slot/b"], idsUnparsed: false, output: "boom" });
    expect(planned).toEqual([{ command: "rerun", files: [nodePath.resolve("/slot", "a.test.ts"), nodePath.resolve("/slot", "b.py")] }]);
    expect(spawned[0]).toMatchObject({ cwd: "/slot/rr", c: { args: ["rr"], env: { R: "1" }, label: "npm test" } });
  });

  it("a pytest command is detected under its own label; other commands run unchanged in a rerun", async () => {
    const detectedFor: string[] = [];
    runnerHooks.detectRunner = async command => { detectedFor.push(command); return detected; };
    runnerHooks.planRerun = async () => scoped({ mode: "rerun" });
    runnerHooks.readResult = async () => report();
    const { checks, spawned } = checksEnv();
    const r = await checks.runCommands(cmdReq({ commands: [pyCmd, lintCmd], mode: { rerun: ["t.py::T::t"] } }));
    expect(r).toMatchObject({ verdict: "pass", ids: [], files: [], idsUnparsed: false });
    expect(detectedFor).toEqual(["python -m pytest"]);
    expect(spawned.map(s => s.c.label)).toEqual(["python -m pytest", "lint"]);
  });

  it("an unparsed or timed out scoped failure marks the ids unparsed; a rerun with nothing affected is skipped", async () => {
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async () => scoped({ mode: "rerun" });
    runnerHooks.readResult = async () => report({ complete: false });
    const a = checksEnv({ spawn: () => noneOut(1) });
    expect(await a.checks.runCommands(cmdReq({ mode: { rerun: ["t"] } }))).toMatchObject({ verdict: "fail", ids: [], idsUnparsed: true });
    runnerHooks.readResult = async () => report({ failingIds: ["a"], failingFiles: ["/slot/a"] });
    const b = checksEnv({ spawn: () => noneOut(0, { timedOut: true }) });
    // A timed out run's inventory is partial whatever its report says.
    expect(await b.checks.runCommands(cmdReq({ mode: { rerun: ["t"] } }))).toMatchObject({ verdict: "fail", ids: ["a"], idsUnparsed: true });
    runnerHooks.planRerun = async () => noAffected;
    const c = checksEnv();
    expect(await c.checks.runCommands(cmdReq({ mode: { rerun: ["t"] } }))).toMatchObject({ verdict: "pass" });
    expect(c.spawned).toHaveLength(0);
  });

  it("QA-3.2-1 (3): a rerun with exit 0 but an incomplete report is no pass: the full command decides", async () => {
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async () => scoped({ mode: "rerun", args: ["rr"] });
    for (const res of [report({ complete: false }), report({ collectionError: true })]) {
      runnerHooks.readResult = async () => res;
      const pass = checksEnv({ spawn: () => noneOut(0) });
      expect(await pass.checks.runCommands(cmdReq({ mode: { rerun: ["a.test.ts > x"] } }))).toMatchObject({ verdict: "pass", idsUnparsed: false });
      expect(pass.spawned.map(s => s.c.args)).toEqual([["rr"], ["test"]]);
    }
    runnerHooks.readResult = async () => report({ complete: false });
    const fail = checksEnv({ spawn: (_c, _o, k) => (k === 1 ? noneOut(0) : noneOut(1, { stdout: " FAIL  a.test.ts > x\n Tests  1 failed (1)\n" })) });
    expect(await fail.checks.runCommands(cmdReq({ mode: { rerun: ["a.test.ts > x"] } }))).toMatchObject({
      verdict: "fail", ids: ["a.test.ts > x"], files: [nodePath.resolve("/slot", "a.test.ts")], idsUnparsed: false,
    });
    // A failing rerun whose report names no id falls back too.
    runnerHooks.readResult = async () => report();
    const blind = checksEnv({ spawn: () => noneOut(1, { stdout: "x" }) });
    expect(await blind.checks.runCommands(cmdReq({ mode: { rerun: ["a.test.ts > x"] } }))).toMatchObject({ verdict: "fail", ids: [], idsUnparsed: true });
    expect(blind.spawned).toHaveLength(2);
  });

  it("QA-3.2-1 (1): a full run names its failing ids from the output of every failing test command", async () => {
    const vitestOut = " FAIL  test/a.test.ts > s > one\n FAIL  test/a.test.ts > s > two\n Tests  2 failed | 5 passed (7)\n";
    const pytestOut = "FAILED tests/test_b.py::T::t - assert 0\n===== 1 failed, 3 passed in 0.1s =====\n";
    const { checks, spawned } = checksEnv({ spawn: c => (c.source === "pytest" ? noneOut(1, { stdout: pytestOut }) : noneOut(1, { stdout: vitestOut })) });
    const r = await checks.runCommands(cmdReq({ commands: [testCmd, pyCmd], priority: "background" }));
    expect(r).toMatchObject({
      verdict: "fail", idsUnparsed: false, output: pytestOut,
      ids: ["test/a.test.ts > s > one", "test/a.test.ts > s > two", "tests/test_b.py::T::t"],
      files: [nodePath.resolve("/slot", "test/a.test.ts"), nodePath.resolve("/slot", "tests/test_b.py")].sort(),
    });
    expect(spawned).toHaveLength(2);
    // An inventory that does not add up (3 failed, 1 named) is unparsed, with the ids it names.
    const partial = checksEnv({ spawn: () => noneOut(1, { stdout: " FAIL  test/a.test.ts > s > one\n Tests  3 failed (3)\n" }) });
    expect(await partial.checks.runCommands(cmdReq())).toMatchObject({ verdict: "fail", ids: ["test/a.test.ts > s > one"], idsUnparsed: true });
  });

  it("an unverifiable runner falls back to running the command as it is", async () => {
    runnerHooks.detectRunner = async () => unverifiable;
    const { checks, spawned } = checksEnv({ spawn: () => noneOut(3, { stdout: "plain" }) });
    const r = await checks.runCommands(cmdReq({ mode: { rerun: ["t"] } }));
    expect(r).toMatchObject({ verdict: "fail", idsUnparsed: true, output: "plain" });
    expect(spawned.map(s => s.c)).toEqual([testCmd]);
  });

  it("a slot that cannot be taken or a failing spawner is an error result", async () => {
    const ac = new AbortController();
    ac.abort();
    const a = checksEnv();
    expect(await a.checks.runCommands(cmdReq({ signal: ac.signal }))).toMatchObject({
      verdict: "error", error: { reason: "interrupted", message: "aborted while waiting for a verification slot" },
    });
    const b = checksEnv({ spawn: () => { throw new Error("spawn died"); } });
    expect(await b.checks.runCommands(cmdReq())).toMatchObject({ verdict: "error", error: { reason: "spawn", message: "spawn died" } });
  });
});

describe("phase suite runner: run", () => {
  it("a passing full run is passed and journals nothing itself", async () => {
    const { runner, requests } = suiteEnv();
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "passed" });
    expect(log.order).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ commit: "c3", mode: "full", priority: "background", prepare: true, signal: j.signal });
    expect(log.cwds).toEqual(["slot:/slot"]);
  });

  it("an unattributable failure reruns the full commands; two passing reruns are flaky with no ids", async () => {
    const { runner, requests } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? runRes("fail", { idsUnparsed: true, output: "boom" }) : runRes("pass")) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "flaky", ids: [] });
    expect(requests.map(r => r.mode)).toEqual(["full", "full", "full"]);
    expect(log.order).toEqual(["end:failed", "start:suite-rerun", "end:ok", "start:suite-rerun"]);
  });

  it("an attributable failure reruns only the failing files; reruns without the ids plus a green full run make them flaky", async () => {
    const { runner, requests } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? failRes(["a", "b"]) : runRes("pass")) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "flaky", ids: ["a", "b"] });
    // QA-3.2-23: the reruns of the files, then one full-command run in the still open second rerun step.
    expect(requests.slice(1).map(r => r.mode)).toEqual([{ rerun: ["f.test.ts"] }, { rerun: ["f.test.ts"] }, "full"]);
    // QA-3.2-22: the reruns at the suite commit must run something; the full runs need not.
    expect(requests.map(r => r.requireRun)).toEqual([false, true, true, false]);
    expect(log.ends[0]).toMatchObject({ result: "failed", ids: ["a", "b"] });
    expect(log.ends[1]).toMatchObject({ result: "ok", ids: [] });
    expect(log.order).toEqual(["end:failed", "start:suite-rerun", "end:ok", "start:suite-rerun"]);
  });

  it("QA-3.2-23, NEW-1 (a): only the full run reproduces: green base -> full-command probes, culprit with no files", async () => {
    const A = "a.test.ts > a", B = "b.test.ts > b";
    const { runner, requests } = suiteEnv({
      // The file reruns are green; only the full commands fail at the suite commit (c3), and at c2 nothing fails.
      runCommands: (r, n) => (n === 1 ? suiteFail([A, B]) : r.mode === "full" && r.commit === "c3" ? suiteFail([B], { output: "whole" }) : runRes("pass")),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j, log } = journalOf();
    // The suite commit failed only under the full commands, so the probes run the full commands, the newest range
    // is blamed on a GREEN full probe at c2 (never on file probes that never failed), and the revert check gets no
    // files (it runs the whole command).
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "culprit", range: { taskId: "T3", from: "c2", to: "c3" }, ids: [B], files: [] });
    expect(log.ends[2]).toMatchObject({ result: "failed", ids: [B], detail: { reproduced: [B], flaky: [A], output: "whole" } });
    expect(requests.slice(0, 5).map(r => `${r.commit}:${typeof r.mode === "string" ? r.mode : "files"}`)).toEqual([
      "c3:full", "c3:files", "c3:files", "c3:full", "c0:full",
    ]);
    // Every probe runs the full commands, and c2 (the boundary the culprit rests on) was probed green.
    expect(requests.length).toBeGreaterThan(5);
    expect(requests.slice(5).every(r => r.mode === "full")).toBe(true);
    expect(requests.slice(5).map(r => r.commit)).toContain("c2");
    expect(log.counters[0]).toEqual({ key: "integration.flaky", value: 1, labels: { where: "suite" } });
    // From a red base (another id fails there) the same failure cannot be isolated: unattributed, nobody blamed.
    const red = suiteEnv({
      runCommands: (r, n) => (n === 1 ? suiteFail([A, B]) : r.commit === "c0" ? suiteFail(["p.test.ts > p"])
        : r.mode === "full" ? suiteFail([B], { output: "whole" }) : runRes("pass")),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const rj = journalOf();
    expect(await red.runner.run(suiteReq(), rj.j)).toEqual({ kind: "unattributed", ids: [B], reason: "base-overlap" });
    expect(red.requests.map(r => r.commit)).toEqual(["c3", "c3", "c3", "c3", "c0"]);
    expect(rj.log.order.at(-1)).toBe("start:bisect");
    // A red full run naming none of the original ids reproduces all of them (fail closed).
    const blind = suiteEnv({ runCommands: (r, n) => (n === 1 ? failRes(["a"]) : r.mode === "full" ? runRes("fail", { idsUnparsed: true }) : runRes("pass")) });
    expect(await blind.runner.run(suiteReq({ base: null }), journalOf().j)).toEqual({ kind: "unattributed", ids: ["a"], reason: "no-base" });
  });

  it("a rerun that fails without parsed ids counts as every original id", async () => {
    const { runner } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? failRes(["a", "b"]) : n === 2 ? runRes("fail", { idsUnparsed: true }) : runRes("pass")) });
    const { j } = journalOf();
    const verdict = await runner.run(suiteReq({ base: null }), j);
    expect(verdict).toEqual({ kind: "unattributed", ids: ["a", "b"], reason: "no-base" });
  });

  it("without a base the failure is unattributed and a memo bisect step is journaled", async () => {
    const { runner } = suiteEnv({ runCommands: () => failRes(["x"]) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq({ base: null }), j)).toEqual({ kind: "unattributed", ids: ["x"], reason: "no-base" });
    expect(log.order.slice(-1)).toEqual(["start:bisect"]);
    expect(log.starts.at(-1)?.detail).toEqual({ v: 1, base: "c3", candidate: "c3", tasks: ["T1", "T2", "T3"], probe: "memo" });
    expect(log.ends.at(-1)).toMatchObject({ result: "failed", ids: ["x"] });
  });

  it("failures that also fail at the base are pre-existing and the base step stays open", async () => {
    const { runner, requests } = suiteEnv({ runCommands: byCommit({ c3: failRes(["x", "y"]), c0: failRes(["x", "y"]) }) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "pre-existing", ids: ["x", "y"] });
    expect(requests.at(-1)?.commit).toBe("c0");
    expect(log.order.at(-1)).toBe("start:suite-rerun");
  });

  it("an unparsed failure at the base is unattributed (base-unparsed) with a memo step", async () => {
    const { runner } = suiteEnv({ runCommands: byCommit({ c3: failRes(["x"]), c0: runRes("fail", { idsUnparsed: true, output: "o" }) }) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "unattributed", ids: ["x"], reason: "base-unparsed" });
    expect(log.ends.at(-1)).toMatchObject({ result: "failed", ids: ["x"] });
    expect(log.order.at(-1)).toBe("start:bisect");
  });

  it("QA-3.2-1 (2): an unattributable failure that also fails at the base fails closed: unattributed, never pre-existing", async () => {
    const { runner, requests } = suiteEnv({ runCommands: () => runRes("fail", { idsUnparsed: true, output: "o" }) });
    const { j, log } = journalOf();
    // reason: the unattributed base label `base-unparsed` (queue.ts's SuiteVerdict).
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "unattributed", ids: [], reason: "base-unparsed" });
    expect(requests.map(r => `${r.commit}:${typeof r.mode === "string" ? r.mode : "rerun"}`)).toEqual(["c3:full", "c3:full", "c3:full", "c0:full"]);
    expect(log.ends.at(-1)).toMatchObject({ result: "failed", ids: [], detail: { output: "o" } });
    expect(log.order.slice(-2)).toEqual(["end:failed", "start:bisect"]);
    expect(log.starts.at(-1)?.detail).toMatchObject({ probe: "memo" });
  });

  it("QA-3.2-1: a full run that names its ids is attributable end to end: reruns, base and bisect use the ids", async () => {
    // The full run's ids now come from its output (checks.runCommands); the suite carries them to the culprit.
    const X = "t.test.ts > x", TF = fileOfSuiteId("/slot", "t.test.ts");
    const { runner, requests } = suiteEnv({
      runCommands: byCommit({ c3: suiteFail([X]), c2: suiteFail([X]) }),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j, log } = journalOf();
    // The file reruns at the suite commit failed WITH the regression id: a file-scoped bisect, culprit with its file.
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "culprit", range: { taskId: "T2", from: "c1", to: "c2" }, ids: [X], files: [TF] });
    expect(log.ends[0]).toMatchObject({ result: "failed", ids: [X], detail: { idsUnparsed: false } });
    // Reruns and probes run the failing file; the base runs the full commands (QA-3.2-23).
    expect(requests.map(r => `${r.commit}:${typeof r.mode === "string" ? r.mode : r.mode.rerun.join(",")}`)).toEqual([
      "c3:full", `c3:${TF}`, `c3:${TF}`, "c0:full", ...requests.slice(4).map(r => `${r.commit}:${TF}`),
    ]);
    expect(requests.length).toBeGreaterThan(4);
  });

  it("NEW-1 (b): probe files are the regression's files minus the base's failing files, never another failing file", async () => {
    // a (file A) is flaky; r (file R) is the regression, sharing R with p, which already fails at the base.
    const a = "a.test.ts > a", r = "r.test.ts > r", p = "r.test.ts > p";
    const { runner, requests } = suiteEnv({
      runCommands: (q, n) => (n === 1 ? suiteFail([a, p, r])
        : q.commit === "c0" ? suiteFail([p])
          : q.commit === "c3" ? suiteFail([p, r]) : runRes("pass")),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j } = journalOf();
    // The only regression file also fails at the base: no probe set isolates r, so nobody is blamed (the old probe
    // set, every failing file minus the base's, was [a.test.ts]: green everywhere, the newest range blamed).
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "unattributed", ids: [r], reason: "base-overlap" });
    expect(requests.map(q => q.commit)).toEqual(["c3", "c3", "c3", "c3", "c0"]);
  });

  it("NEW-1 (c): an unparsed failure of the file reruns keeps the ids reproduced but never seeds a file-scoped bisect", async () => {
    const X = "x.test.ts > x";
    const env = (c0: CommandRunResult) => suiteEnv({
      runCommands: (q, n) => (n === 1 ? suiteFail([X]) : q.commit === "c3" ? runRes("fail", { idsUnparsed: true, output: "ran nothing" })
        : q.commit === "c0" ? c0 : q.commit === "c2" ? suiteFail([X]) : runRes("pass")),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    // Green base: full-command probes; c2 fails, c1 passes -> T2, and the revert check gets no files.
    const green = env(runRes("pass"));
    expect(await green.runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "culprit", range: { taskId: "T2", from: "c1", to: "c2" }, ids: [X], files: [] });
    expect(green.requests.slice(4).every(q => q.mode === "full")).toBe(true);
    // Red base (another id): unattributed.
    const red = env(suiteFail(["o.test.ts > o"]));
    expect(await red.runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "unattributed", ids: [X], reason: "base-overlap" });
  });

  it("NEW-2: any id the file reruns clear is checked by the full run; one it reproduces is never pre-existing", async () => {
    const a = "a.test.ts > a", p = "p.test.ts > p";
    // The reruns reproduce p and clear a; the full run fails with both; p also fails at the base.
    const both = suiteEnv({
      runCommands: (q, n) => (n === 1 ? suiteFail([a, p]) : q.commit === "c0" ? suiteFail([p])
        : q.mode === "full" ? suiteFail([a, p], { output: "whole" }) : suiteFail([p])),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const bj = journalOf();
    // a was reproduced only by the full run (never by a file rerun) and the base is red: unattributed, not pre-existing.
    expect(await both.runner.run(suiteReq(), bj.j)).toEqual({ kind: "unattributed", ids: [a], reason: "base-overlap" });
    expect(both.requests.map(q => `${q.commit}:${typeof q.mode === "string" ? q.mode : "files"}`)).toEqual(["c3:full", "c3:files", "c3:files", "c3:full", "c0:full"]);
    expect(bj.log.ends[2]).toMatchObject({ result: "failed", ids: [a, p], detail: { reproduced: [a, p], output: "whole" } });
    // The full run clears a too: a is flaky and reported, p is pre-existing.
    const cleared = suiteEnv({
      runCommands: (q, n) => (n === 1 ? suiteFail([a, p]) : q.mode === "full" ? suiteFail([p], { output: "whole" }) : suiteFail([p])),
    });
    const cj = journalOf();
    expect(await cleared.runner.run(suiteReq(), cj.j)).toEqual({ kind: "pre-existing", ids: [p] });
    expect(cj.log.ends[2]).toMatchObject({ result: "failed", ids: [p], detail: { reproduced: [p], flaky: [a] } });
    expect(cj.log.counters).toEqual([{ key: "integration.flaky", value: 1, labels: { where: "suite" } }]);
  });

  it("a failing rerun that names none of the original ids clears none of them (fail closed)", async () => {
    const { runner } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? failRes(["a"]) : failRes(["other form of a"])) });
    expect(await runner.run(suiteReq({ base: null }), journalOf().j)).toEqual({ kind: "unattributed", ids: ["a"], reason: "no-base" });
  });

  it("QA-3.2-26: a probe that fails naming none of the regression ids is a failing probe (fail closed)", async () => {
    // c1 fails with another id (or the same failure in another id form): it can no longer read as a pass, so the
    // culprit is the range that ends there, never a later innocent one.
    const X = "f.test.ts > x", F = fileOfSuiteId("/slot", "f.test.ts");
    const { runner, requests } = suiteEnv({
      runCommands: byCommit({ c3: suiteFail([X]), c2: suiteFail([X]), c1: failRes(["/abs/f.test.ts > x"]) }),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "culprit", range: { taskId: "T1", from: "c0", to: "c1" }, ids: [X], files: [F] });
    expect(log.ends.filter(e => e.result === "failed" && "probes" in e.detail).length).toBeGreaterThan(0);
    expect(requests.slice(4).every(q => typeof q.mode !== "string" && q.mode.rerun.join() === F)).toBe(true);
  });

  it("bisects to the culprit range, probing only the regression ids and never the known base", async () => {
    const X = "f.test.ts > x", F = fileOfSuiteId("/slot", "f.test.ts");
    const { runner, requests } = suiteEnv({
      runCommands: byCommit({ c3: suiteFail([X]), c2: suiteFail([X, "f.test.ts > other"]) }),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j, log } = journalOf();
    const verdict = await runner.run(suiteReq(), j);
    expect(verdict).toEqual({ kind: "culprit", range: { taskId: "T2", from: "c1", to: "c2" }, ids: [X], files: [F] });
    expect(requests.slice(4).every(q => typeof q.mode !== "string" && q.mode.rerun.join() === F)).toBe(true);
    const probed = requests.slice(4).map(r => r.commit);
    expect(probed).not.toContain("c0");
    expect(probed).not.toContain("c3");
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every(c => c === "c1" || c === "c2")).toBe(true);
    expect(log.counters).toEqual([{ key: "integration.bisect.probes", value: probed.length, labels: { kind: "suite" } }]);
    expect(log.ends.some(e => e.result === "ok" && e.ids?.length === 0)).toBe(true);
    expect(log.starts.at(-1)?.detail).toMatchObject({ probe: "memo", tasks: ["T1", "T2", "T3"] });
  });

  it("bisects an unattributable failure by the verdict alone", async () => {
    const unparsed = runRes("fail", { idsUnparsed: true });
    const { runner, requests } = suiteEnv({
      runCommands: byCommit({ c3: unparsed, c2: unparsed }),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    expect(await runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "culprit", range: { taskId: "T2", from: "c1", to: "c2" }, ids: [], files: [] });
    expect(requests.slice(0, 3).map(r => r.mode)).toEqual(["full", "full", "full"]);
  });

  it("reports outside when even the first range's from fails", async () => {
    const ranges: TaskRange[] = [{ taskId: "T1", from: "cx", to: "c1" }, { taskId: "T2", from: "c1", to: "c2" }, { taskId: "T3", from: "c2", to: "c3" }];
    const { runner } = suiteEnv({
      runCommands: byCommit({ c3: failRes(["x"]), c2: failRes(["x"]), c1: failRes(["x"]), cx: failRes(["x"]) }),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j } = journalOf();
    expect(await runner.run(suiteReq({ ranges }), j)).toEqual({ kind: "unattributed", ids: ["x"], reason: "outside" });
  });

  it("a range whose `to` is not in the phase chain is unattributed (outside) with a memo step", async () => {
    const { runner } = suiteEnv({ runCommands: byCommit({ c3: failRes(["x"]) }), igit: { revList: async () => [] } });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "unattributed", ids: ["x"], reason: "outside" });
    expect(log.order.at(-1)).toBe("start:bisect");
  });

  it("a git failure while listing the chain is a prepare error (Error and non-Error)", async () => {
    const run = byCommit({ c3: failRes(["x"]) });
    const a = suiteEnv({ runCommands: run, igit: { revList: async () => { throw new Error("rev-list failed"); } } });
    expect(await a.runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "error", reason: "prepare", message: "rev-list failed" });
    const b = suiteEnv({ runCommands: run, igit: { revList: () => Promise.reject("plain") } });
    expect(await b.runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "error", reason: "prepare", message: "plain" });
  });

  it("a probe that cannot run stops the bisect with its outcome", async () => {
    const { runner } = suiteEnv({
      runCommands: (req) => (req.commit === "c3" ? failRes(["x"]) : req.commit === "c0" ? runRes("pass") : errRes("spawn", "no probe")),
      igit: { revList: async () => ["c1", "c2", "c3"] },
    });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "error", reason: "spawn", message: "no probe" });
    expect(log.counters).toEqual([]);
  });

  it("a failed run without an error object is a spawn error; three tries then give up with a clipped message", async () => {
    const { runner, requests } = suiteEnv({ runCommands: () => ({ ...runRes("error"), error: null }) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "error", reason: "spawn", message: "the run failed without a reason" });
    expect(requests).toHaveLength(3);
    expect(log.order).toEqual(["end:refused", "start:phase-suite", "end:refused", "start:phase-suite", "end:refused"]);

    const long = suiteEnv({ runCommands: () => errRes("prepare", "z".repeat(1500)) });
    const l = journalOf();
    const verdict = await long.runner.run(suiteReq(), l.j);
    expect(verdict).toMatchObject({ kind: "error", reason: "prepare" });
    const detail = l.log.ends[0]?.detail;
    const message = detail !== undefined && "message" in detail ? detail.message : undefined;
    expect(message).toHaveLength(1000);
    expect(message?.endsWith("\u2026")).toBe(true);
  });

  it("a preempted attempt reopens the step with the same detail and does not use the try budget", async () => {
    const { runner, requests } = suiteEnv({ runCommands: (_r, n) => (n <= 5 ? errRes("preempted") : runRes("pass")) });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq(), j)).toEqual({ kind: "passed" });
    expect(requests).toHaveLength(6);
    expect(log.ends[0]).toMatchObject({ result: "refused", detail: { reason: "preempted", n: 1 } });
    expect(log.ends[4]).toMatchObject({ detail: { reason: "preempted", n: 5 } });
    expect(log.starts.every(s => s.step === "phase-suite")).toBe(true);
  });

  it("an aborted journal signal interrupts before and after an attempt (abort and dispose)", async () => {
    const pre = new AbortController();
    pre.abort();
    const a = suiteEnv();
    expect(await a.runner.run(suiteReq(), journalOf(pre.signal).j)).toEqual({ kind: "interrupted", by: "abort" });
    expect(a.requests).toHaveLength(0);

    const during = new AbortController();
    const b = suiteEnv({ runCommands: () => { during.abort("dispose"); return errRes("spawn"); } });
    expect(await b.runner.run(suiteReq(), journalOf(during.signal).j)).toEqual({ kind: "interrupted", by: "dispose" });

    const c = suiteEnv({ runCommands: () => errRes("interrupted") });
    expect(await c.runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "interrupted", by: "abort" });
  });

  it("an error in the first rerun is returned as is", async () => {
    const { runner } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? failRes(["x"]) : errRes("slot-lost", "lost")) });
    expect(await runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "error", reason: "slot-lost", message: "lost" });
  });

  it("an error at the base is returned as is", async () => {
    const { runner } = suiteEnv({ runCommands: (r) => (r.commit === "c0" ? errRes("slot-lost", "lost") : failRes(["x"])) });
    expect(await runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "error", reason: "slot-lost", message: "lost" });
  });

  it("preemptBackground delegates to the background runs", () => {
    const { runner, background } = suiteEnv();
    const c = new AbortController();
    background.register(c, 1);
    expect(runner.preemptBackground()).toBe(true);
    expect(c.signal.aborted).toBe(true);
    expect(runner.preemptBackground()).toBe(false);
  });
});

describe("phase suite runner: revert", () => {
  const revertReq: RevertRequest = {
    planId: "plan", phaseId: "p1", culprit: { taskId: "T2", from: "c1", to: "c2" }, suiteCommit: "c3", head: "h0",
    regression: { ids: ["x"], files: ["f.test.ts"], commands: [cmd] }, slot,
  };
  const pass: CheckResult = { verdict: "pass", components: [], flakyIds: [], note: null, durationMs: 1 };

  function revertEnv(over: { checks?: Partial<IntegrationChecks>; igit?: Partial<IntegrateGit>; git?: Partial<GitOps> } = {}) {
    const reverted: Array<{ sha: string; message: string }> = [];
    const runs: CheckRequest[] = [];
    const env = suiteEnv({
      checks: {
        prepare: async () => undefined,
        run: async req => { runs.push(req); return pass; },
        ...over.checks,
      },
      igit: { revList: async () => ["s1", "s2"], subject: async sha => `change ${sha} [plan:T2]`, ...over.igit },
      git: {
        revert: async (_cwd, sha, message) => { reverted.push({ sha, message }); return { ok: true, head: sha }; },
        revParse: async () => "rh",
        ...over.git,
      },
    });
    return { ...env, reverted, runs };
  }

  it("reverts newest first, then runs the integration checks with the regression as extra", async () => {
    const { runner, reverted, runs } = revertEnv();
    const { j, log } = journalOf();
    expect(await runner.revert(revertReq, j)).toEqual({ kind: "ok", revertHead: "rh", reverted: ["s2", "s1"] });
    expect(reverted.map(r => r.sha)).toEqual(["s2", "s1"]);
    expect(reverted[0]?.message).toMatch(/^revert\(p1\)/);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      base: "h0", candidate: "rh", priority: "foreground", extra: { ids: ["x"], files: ["f.test.ts"], commands: [cmd] },
    });
    expect(log.cwds).toEqual(["integration:/slot"]);
    expect(log.order).toEqual(["end:ok", "start:revert-checks"]);
    expect(log.starts[0]?.patch).toEqual({ candidate: "rh" });
  });

  it("a revert conflict reports the commit and the paths", async () => {
    const { runner } = revertEnv({ git: { revert: async () => ({ ok: false, conflicts: ["a.ts", "b.ts"], head: "h" }) } });
    expect(await runner.revert(revertReq, journalOf().j)).toEqual({ kind: "conflict", at: "s2", paths: ["a.ts", "b.ts"] });
  });

  it("failing integration checks are reported with their ids, files and output", async () => {
    const failing: CheckResult = { verdict: "fail", components: [], failingIds: ["x"], failingFiles: ["f"], flakyIds: [], output: "o", durationMs: 1 };
    const { runner } = revertEnv({ checks: { run: async () => failing } });
    expect(await runner.revert(revertReq, journalOf().j)).toEqual({ kind: "failed", ids: ["x"], files: ["f"], output: "o" });
  });

  it("an erroring check run is retried three times, a preempted one without limit", async () => {
    let calls = 0;
    const erroring = revertEnv({ checks: { run: async () => { calls++; return { verdict: "error", reason: "slot-lost", message: "lost", components: [], durationMs: 1 }; } } });
    expect(await erroring.runner.revert(revertReq, journalOf().j)).toEqual({ kind: "error", reason: "slot-lost", message: "lost" });
    expect(calls).toBe(3);

    let n = 0;
    const preempted = revertEnv({ checks: { run: async () => {
      n++;
      return n < 5 ? { verdict: "error", reason: "preempted", message: "p", components: [], durationMs: 1 } : pass;
    } } });
    expect(await preempted.runner.revert(revertReq, journalOf().j)).toMatchObject({ kind: "ok" });
    expect(n).toBe(5);
  });

  it("a slot that cannot be prepared is a prepare error after three tries (Error and non-Error)", async () => {
    let calls = 0;
    const a = revertEnv({ checks: { prepare: async () => { calls++; throw new Error("dirty slot"); } } });
    expect(await a.runner.revert(revertReq, journalOf().j)).toEqual({ kind: "error", reason: "prepare", message: "dirty slot" });
    expect(calls).toBe(3);
    const b = revertEnv({ checks: { prepare: () => Promise.reject("nope") } });
    expect(await b.runner.revert(revertReq, journalOf().j)).toEqual({ kind: "error", reason: "prepare", message: "nope" });
  });

  it("an empty culprit range holds nothing to revert", async () => {
    const { runner } = revertEnv({ igit: { revList: async () => [] } });
    expect(await runner.revert(revertReq, journalOf().j)).toEqual({
      kind: "error", reason: "prepare", message: "range c1..c2 holds no commit to revert",
    });
  });

  it("a git failure while building the revert is a spawn error (Error and non-Error)", async () => {
    const a = revertEnv({ git: { revert: async () => { throw new Error("git died"); } } });
    expect(await a.runner.revert(revertReq, journalOf().j)).toEqual({ kind: "error", reason: "spawn", message: "git died" });
    const b = revertEnv({ igit: { revList: () => Promise.reject("plain") } });
    expect(await b.runner.revert(revertReq, journalOf().j)).toEqual({ kind: "error", reason: "spawn", message: "plain" });
  });

  it("an aborted journal interrupts the build and the checks", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await revertEnv().runner.revert(revertReq, journalOf(ac.signal).j)).toEqual({ kind: "interrupted", by: "abort" });

    const late = new AbortController();
    const env = revertEnv({ checks: { run: async () => { late.abort("dispose"); return { verdict: "error", reason: "spawn", message: "x", components: [], durationMs: 1 }; } } });
    expect(await env.runner.revert(revertReq, journalOf(late.signal).j)).toEqual({ kind: "interrupted", by: "dispose" });
  });
});

describe("phase suite runner: resolve", () => {
  const ref: RunCommandRef = { script: "lint", args: ["--quiet"] };
  function ledgerOf(phaseSuite: ExecutorConfig["phaseSuite"]): LedgerV1 {
    return stub<LedgerV1>({
      config: stub<LedgerV1["config"]>({ phaseSuite }),
      integration: stub<LedgerV1["integration"]>({ worktree: "/wt" }),
    });
  }

  it("off and an empty list select nothing", async () => {
    const { runner } = suiteEnv();
    expect(await runner.resolve(ledgerOf("off"), "p1", "c3")).toEqual({ kind: "off" });
    expect(await runner.resolve(ledgerOf([]), "p1", "c3")).toEqual({ kind: "none" });
  });

  it("auto runs the full command of every selected test component", async () => {
    const selection: CheckSelection = { typecheck: null, tests: [{ framework: "node", full: cmd }], extras: [] };
    const seen: string[] = [];
    const { runner } = suiteEnv({ checks: { select: async (cwd, commit) => { seen.push(`${cwd}@${commit}`); return selection; } } });
    expect(await runner.resolve(ledgerOf("auto"), "p1", "c3")).toEqual({ kind: "runs", commands: [cmd] });
    expect(seen).toEqual(["/wt@c3"]);
    const none = suiteEnv({ checks: { select: async () => ({ typecheck: null, tests: [], extras: [] }) } });
    expect(await none.runner.resolve(ledgerOf("auto"), "p1", "c3")).toEqual({ kind: "none" });
  });

  it("auto refuses when the selection throws", async () => {
    const a = suiteEnv({ checks: { select: async () => { throw new Error("no package.json"); } } });
    expect(await a.runner.resolve(ledgerOf("auto"), "p1", "c3")).toEqual({ kind: "refused", reason: "phase p1 suite selection failed: no package.json", ref: null });
    const b = suiteEnv({ checks: { select: () => Promise.reject("plain") } });
    expect(await b.runner.resolve(ledgerOf("auto"), "p1", "c3")).toMatchObject({ kind: "refused", reason: "phase p1 suite selection failed: plain" });
  });

  it("an explicit list resolves every ref in the integration worktree", async () => {
    const { runner } = suiteEnv({ resolver: { resolve: async (r, cwd) => ({ ok: true, command: { ...cmd, label: `${r.script}@${cwd}` } }) } });
    expect(await runner.resolve(ledgerOf([ref, { script: "test", args: [] }]), "p1", "c3")).toEqual({
      kind: "runs", commands: [{ ...cmd, label: "lint@/wt" }, { ...cmd, label: "test@/wt" }],
    });
  });

  it("an explicit list refuses with the resolver's reason or error and names the ref", async () => {
    const denied = suiteEnv({ resolver: { resolve: async () => ({ ok: false, reason: "not allowed" }) } });
    expect(await denied.runner.resolve(ledgerOf([ref]), "p1", "c3")).toEqual({ kind: "refused", reason: "not allowed", ref });
    const throwing = suiteEnv({ resolver: { resolve: async () => { throw new Error("resolver down"); } } });
    expect(await throwing.runner.resolve(ledgerOf([ref]), "p1", "c3")).toEqual({ kind: "refused", reason: "resolver down", ref });
    const plain = suiteEnv({ resolver: { resolve: () => Promise.reject("plain") } });
    expect(await plain.runner.resolve(ledgerOf([ref]), "p1", "c3")).toEqual({ kind: "refused", reason: "plain", ref });
  });
});

describe("BackgroundRuns preemption budget (M12, M38)", () => {
  it("a background run can be preempted PREEMPT_LIMIT times, then never again", () => {
    const runs = new BackgroundRuns();
    const ctls: AbortController[] = [];
    const cleanup = (() => {
      const c = new AbortController();
      ctls.push(c);
      return runs.register(c, PREEMPT_LIMIT);
    })();
    expect(runs.active).toBe(1);
    // the same run re-registers after each preemption (a rerun) with a fresh controller but a spent budget in the real flow;
    // here a single registration has budget for exactly one abort of its controller
    expect(runs.preemptOne()).toBe(true);
    expect(ctls[0]?.signal.aborted).toBe(true);
    expect(runs.preemptOne()).toBe(false); // that controller is already aborted
    cleanup();
    expect(runs.active).toBe(0);
    expect(runs.preemptOne()).toBe(false);
  });

  it("a registration with budget 0 is never preempted; the first run with budget is", () => {
    const runs = new BackgroundRuns();
    const spent = new AbortController();
    const fresh = new AbortController();
    runs.register(spent, 0);
    runs.register(fresh, 3);
    expect(runs.preemptOne()).toBe(true);
    expect(spent.signal.aborted).toBe(false);
    expect(fresh.signal.aborted).toBe(true);
  });

  it("PREEMPT_LIMIT is 3", () => {
    expect(PREEMPT_LIMIT).toBe(3);
    expect(PREEMPT_BUDGET).toBe(PREEMPT_LIMIT);
  });

  it("QA-3.2-8: a shared budget spans registrations, so a suite entry is preempted at most PREEMPT_BUDGET times", () => {
    const runs = new BackgroundRuns();
    const budget: PreemptBudget = { left: PREEMPT_BUDGET };
    let preempted = 0;
    // Each run of the entry (full, reruns, base, probes, retries after a preemption) registers anew with the budget.
    for (let k = 0; k < 6; k++) {
      const c = new AbortController();
      const off = runs.register(c, budget);
      if (runs.preemptOne()) preempted++;
      expect(c.signal.aborted).toBe(k < PREEMPT_BUDGET);
      off();
    }
    expect(preempted).toBe(PREEMPT_BUDGET);
    expect(budget.left).toBe(0);
  });

  it("QA-3.2-8: runCommands registers with the request's budget; without one a run gets a fresh budget", async () => {
    const bg = new BackgroundRuns();
    const budget: PreemptBudget = { left: 1 };
    const seen: boolean[] = [];
    const { checks } = checksEnv({ background: bg, spawn: () => { seen.push(bg.preemptOne()); return noneOut(0); } });
    const req: CommandRunRequest = { slot, commit: "c", commands: [cmd], mode: "full", priority: "background", signal: new AbortController().signal, prepare: false, preempt: budget };
    expect(await checks.runCommands(req)).toMatchObject({ verdict: "error", error: { reason: "preempted" } });
    // The budget is spent: the next run of the entry is not preempted and completes.
    expect(await checks.runCommands(req)).toMatchObject({ verdict: "pass" });
    expect(seen).toEqual([true, false]);
    expect(budget.left).toBe(0);
    const fresh: CommandRunRequest = { slot, commit: "c", commands: [cmd], mode: "full", priority: "background", signal: new AbortController().signal, prepare: false };
    expect(await checks.runCommands(fresh)).toMatchObject({ verdict: "error", error: { reason: "preempted" } });
  });

  it("QA-3.2-8: every run of one suite entry carries the same budget; another entry gets its own", async () => {
    const { runner, requests } = suiteEnv({ runCommands: (_r, n) => (n === 1 ? failRes(["a"]) : runRes("pass")) });
    await runner.run(suiteReq(), journalOf().j);
    const first = requests[0]?.preempt;
    expect(first).toEqual({ left: PREEMPT_BUDGET });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(r => r.preempt === first)).toBe(true);
    await runner.run(suiteReq(), journalOf().j);
    expect(requests.at(-1)?.preempt).not.toBe(first);
  });
});

describe("QA-3.2 round 1: suite helpers", () => {
  it("observeFull reads vitest, pytest and jest ids, resolves their files and reports completeness", () => {
    const out = (stdout: string, exitCode: number | null = 1): CommandOutput => ({ exitCode, timedOut: false, stdout, stderr: "", durationMs: 1 });
    expect(observeFull(out("no ids here"), "/slot")).toBeNull();
    expect(observeFull(out(" FAIL  a.test.ts > s > t\n Tests  1 failed (1)\n"), "/slot")).toEqual({
      ids: ["a.test.ts > s > t"], files: [nodePath.resolve("/slot", "a.test.ts")], complete: true,
    });
    const py = observeFull({ ...out(""), exitCode: null, stderr: "FAILED t/b.py::C::x - e\nFAILED t/b.py::C::y\n= 3 failed =\n" }, "/slot");
    expect(py).toEqual({ ids: ["t/b.py::C::x", "t/b.py::C::y"], files: [nodePath.resolve("/slot", "t/b.py")], complete: false });
  });

  it("interruptedBy reads dispose from the abort reason (string or E_DISPOSED), else abort", () => {
    const by = (reason?: unknown) => {
      const c = new AbortController();
      c.abort(reason);
      return interruptedBy({ signal: c.signal });
    };
    expect(by("dispose")).toBe("dispose");
    expect(by(new ExecutorError("E_DISPOSED", "disposed"))).toBe("dispose");
    expect(by("abort")).toBe("abort");
    expect(by()).toBe("abort");
    expect(by(new ExecutorError("E_PLAN_STATE", "x"))).toBe("abort");
  });
});

describe("QA-3.2 round 2: ids, completeness and runs that ran nothing", () => {
  const cwd = nodePath.resolve("/slot");
  const out = (stdout: string, stderr = ""): CommandOutput => ({ exitCode: 1, timedOut: false, stdout, stderr, durationMs: 1 });
  const PKG_TEST = { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) };

  it("QA-3.2-22/-26: observeFull drops a vitest project prefix and rewrites jest JSON ids to the readResult form", () => {
    expect(observeFull(out(" FAIL  |web| test/a.test.ts > s > t\n Tests  1 failed (1)\n"), cwd)).toEqual({
      ids: ["test/a.test.ts > s > t"], files: [nodePath.resolve(cwd, "test/a.test.ts")], complete: true,
    });
    const json = JSON.stringify({
      numFailedTests: 2, numRuntimeErrorTestSuites: 0, testResults: [
        { name: nodePath.join(cwd, "src", "a.test.ts"), status: "failed", assertionResults: [
          { status: "failed", fullName: "s t", ancestorTitles: ["s"], title: "t" },
          { status: "passed", fullName: "s ok", ancestorTitles: ["s"], title: "ok" },
        ] },
        { name: "rel/b.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "only" }] },
        { name: nodePath.join(cwd, "c.test.ts"), status: "passed" },
      ],
    });
    // Not `<absolute suite> > s t` (observeTests' JSON form): the same form readResult gives the reruns.
    expect(observeFull(out(json), cwd)).toEqual({
      ids: ["rel/b.test.ts > only", "src/a.test.ts > s > t"],
      files: [nodePath.resolve(cwd, "rel/b.test.ts"), nodePath.resolve(cwd, "src/a.test.ts")].sort(),
      complete: true,
    });
  });

  it("QA-3.2-23: observeFull calls an inventory incomplete when the output reports errors outside the tests", () => {
    const ok = " FAIL  a.test.ts > s > t\n Tests  1 failed (1)\n";
    const cases = [
      ` FAIL  b.test.ts [ b.test.ts ]\n${ok}`,
      `${ok} Errors  1 error\n`,
      "FAILED t/a.py::x - e\nERROR t/b.py - ImportError\n= 1 failed in 0.1s =\n",
      "FAILED t/a.py::x - e\n===== 1 failed, 2 errors in 0.3s =====\n",
      "FAILED t/a.py::x - e\n= 1 failed in 0.1s =\nInterrupted: 1 error during collection\n",
    ];
    for (const stdout of cases) expect(observeFull(out(stdout), cwd)?.complete).toBe(false);
    expect(observeFull(out(ok), cwd)?.complete).toBe(true);
    const runtime = JSON.stringify({
      numFailedTests: 1, numRuntimeErrorTestSuites: 1,
      testResults: [{ name: "a.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "t", title: "t" }] }],
    });
    expect(observeFull(out(runtime), cwd)).toMatchObject({ ids: ["a.test.ts > t"], complete: false });
    const brokenSuite = JSON.stringify({
      numFailedTests: 1, testResults: [
        { name: "a.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "t", title: "t" }] },
        { name: "broken.test.ts", status: "failed", assertionResults: [] },
      ],
    });
    expect(observeFull(out(brokenSuite), cwd)).toMatchObject({ ids: ["a.test.ts > t"], complete: false });
    // A failed assertion without names still counts (and the inventory, one id short for observeTests, is incomplete).
    const nameless = JSON.stringify({ numFailedTests: 1, testResults: [{ name: "x.test.ts", status: "failed", assertionResults: [{ status: "failed", ancestorTitles: ["d"] }] }] });
    expect(observeFull(out(nameless), cwd)).toMatchObject({ ids: ["x.test.ts > d > "], complete: false });
    expect(observeFull(out("{}"), cwd)).toBeNull();
    expect(observeFull(out("42"), cwd)).toBeNull();
  });

  it("QA-3.2-23: an error in the confirming full run is returned as is", async () => {
    const { runner } = suiteEnv({ runCommands: (r, n) => (n === 1 ? failRes(["a"]) : r.mode === "full" ? errRes("slot-lost", "lost") : runRes("pass")) });
    expect(await runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "error", reason: "slot-lost", message: "lost" });
  });

  it("QA-3.2-22: at the suite commit a rerun that maps to no test fails unparsed; ids whose files are missing are unparsed", async () => {
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async () => noAffected;
    const req = (o: Partial<CommandRunRequest> = {}): CommandRunRequest => ({
      slot, commit: "cand", commands: [cmd], mode: { rerun: ["a.test.ts > x"] }, priority: "background", signal: new AbortController().signal, prepare: false, ...o,
    });
    const a = checksEnv();
    expect(await a.checks.runCommands(req({ requireRun: true }))).toMatchObject({
      verdict: "fail", ids: [], idsUnparsed: true, output: "the rerun ran no test: 1 failing file(s) map to no test file",
    });
    expect(await a.checks.runCommands(req())).toMatchObject({ verdict: "pass" });
    expect(a.spawned).toHaveLength(0);
    const missing = checksEnv({ exists: () => false, spawn: () => noneOut(1, { stdout: " FAIL  sub/a.test.ts > x\n Tests  1 failed (1)\n" }) });
    expect(await missing.checks.runCommands(req({ mode: "full" }))).toMatchObject({ verdict: "fail", ids: ["sub/a.test.ts > x"], idsUnparsed: true });
  });

  it("QA-3.2-22: a full tests failure whose files are missing here is final: no confirmation rerun", async () => {
    runnerHooks.planScopedRun = async () => unverifiable;
    runnerHooks.detectRunner = async () => { throw new Error("no rerun of missing files"); };
    const { checks } = checksEnv({
      files: PKG_TEST, exists: () => false, spawn: () => noneOut(1, { stdout: " FAIL  sub/a.test.ts > x\n Tests  1 failed (1)\n" }),
    });
    expect(await checks.run(checkReq())).toMatchObject({ verdict: "fail", failingIds: ["sub/a.test.ts > x"], flakyIds: [] });
  });

  it("QA-3.2-22: a `|proj|` id whose rerun runs nothing at the suite commit is reproduced, never flaky", async () => {
    runnerHooks.detectRunner = async () => detected;
    runnerHooks.planRerun = async () => noAffected; // the planner drops a file it cannot find
    const env = checksEnv({ spawn: () => noneOut(1, { stdout: " FAIL  |proj| test/a.test.ts > s > t\n Tests  1 failed (1)\n" }) });
    const { runner } = suiteEnv({ checks: env.checks });
    const { j, log } = journalOf();
    expect(await runner.run(suiteReq({ base: null }), j)).toEqual({ kind: "unattributed", ids: ["test/a.test.ts > s > t"], reason: "no-base" });
    expect(log.ends[0]).toMatchObject({ result: "failed", ids: ["test/a.test.ts > s > t"] });
    expect(log.ends.slice(1, 3).map(e => e.result)).toEqual(["failed", "failed"]);
    expect(env.spawned).toHaveLength(1);
  });

  it("QA-3.2-23: a red base plus a new collection error at the suite commit is never pre-existing", async () => {
    const variants: Array<{ base: string; suite: string }> = [
      { base: " FAIL  a.test.ts > s > x\n Tests  1 failed (1)\n", suite: " FAIL  b.test.ts [ b.test.ts ]\n FAIL  a.test.ts > s > x\n Tests  1 failed (1)\n" },
      { base: "FAILED t/a.py::x - e\n= 1 failed in 0.1s =\n", suite: "ERROR t/b.py - ImportError\nFAILED t/a.py::x - e\n= 1 failed, 1 error in 0.1s =\n" },
    ];
    for (const v of variants) {
      const box: { at?: () => string } = {};
      const env = checksEnv({ spawn: () => noneOut(1, { stdout: box.at?.() === "c0" ? v.base : v.suite }) });
      box.at = env.at;
      const { runner } = suiteEnv({ checks: env.checks, igit: { revList: async () => ["c1", "c2", "c3"] } });
      expect(await runner.run(suiteReq(), journalOf().j)).toEqual({ kind: "unattributed", ids: [], reason: "base-unparsed" });
    }
  });

  it("QA-3.2-36: an abort that fires while the slot is released turns the result into interrupted", async () => {
    const ac = new AbortController();
    const handle: SlotHandle = { lost: false, release: async () => { ac.abort(); } };
    const env = checksEnv({ config: lintCfg, acquire: () => handle });
    expect(await env.checks.run(checkReq({ signal: ac.signal }))).toMatchObject({ verdict: "error", reason: "interrupted", message: "the run was aborted" });
    const bc = new AbortController();
    const late = checksEnv({ acquire: () => ({ lost: false, release: async () => { bc.abort(); } }) });
    const r = await late.checks.runCommands({ slot, commit: "c", commands: [cmd], mode: "full", priority: "background", signal: bc.signal, prepare: false });
    expect(r).toMatchObject({ verdict: "error", error: { reason: "interrupted" } });
  });
});
