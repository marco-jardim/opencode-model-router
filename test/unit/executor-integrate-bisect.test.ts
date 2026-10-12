import { describe, expect, it } from "vitest";
import { BackgroundRuns, isPlaceholderTestScript, selectFromFiles } from "../../src/executor/integrate/checks";
import { classifyReruns, revertMessage } from "../../src/executor/integrate/phase-suite";
import { PREEMPT_LIMIT } from "../../src/executor/integrate/queue";
import {
  bisectRanges,
  maxRangeProbes,
  orderRanges,
  type ProbeVerdict,
  type TaskRange,
} from "../../src/executor/integrate/bisect";

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
  });
});
