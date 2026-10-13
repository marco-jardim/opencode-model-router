import { posix, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_REASONS,
  BATCH_RESERVE_MARGIN_MS,
  BATCH_STALE_GRACE_MS,
  argvTemplate,
  attributeUnion,
  batchKey,
  createBatchCoordinator as createCoordinator,
  createBatchDeadline,
  deriveSharedRecheck,
  envSignature,
  fileKeyOf,
  isGuardSensitive,
  referenceKey,
  taintUnreproduced,
  unionChangedFiles,
} from "../../src/verify/batch";
import type { BatchCoordinator, BatchCoordinatorOptions, BatchPlanInput, BatchPlanner, BatchRuntime } from "../../src/verify/batch";
import { judgeScoped } from "../../src/verify/baseline";
import type { DispatchReference } from "../../src/verify/reference";
import { readResult } from "../../src/verify/runner";
import type { RunResult, RunnerKind, ScopedSpec, ScopingPlan } from "../../src/verify/runner";
import type {
  Deadline,
  OpenVerificationScope,
  RecheckOutcome,
  ScopedOutcome,
  TestsPassHook,
  TestsPassRequest,
  TestsPassRun,
} from "../../src/verify/types";

const REPORT = "/tmp/omr-verify-00000000-0000-0000-0000-000000000000.json";

/**
 * The tests of the W1-W6 mechanics, B5-B11 and the B12 property open windows that only a timer,
 * the size cap or a reserve closes: W7's idle close (QA-2.2-17 a) would close each one as soon as
 * its last request joined. W7 has its own tests below, which use createCoordinator itself.
 */
function createBatchCoordinator(options: BatchCoordinatorOptions = {}): BatchCoordinator {
  return createCoordinator({ idleClose: false, ...options });
}

function spec(over: Partial<ScopedSpec> = {}): ScopedSpec {
  const inputs = over.inputs ?? ["/r/app/src/a.ts"];
  const reportPath = over.reportPath ?? REPORT;
  return {
    runner: "vitest",
    mode: "related",
    file: "/usr/bin/node",
    args: ["/r/node_modules/vitest/vitest.mjs", "related", "--run", "--reporter=json", `--outputFile=${reportPath}`, "--maxWorkers=2", ...inputs],
    cwd: "/r/app",
    env: {},
    reportPath,
    gitRoot: "/r",
    entry: "/r/node_modules/vitest/vitest.mjs",
    inputs,
    inputsAreTests: false,
    workers: 2,
    notes: [],
    ...over,
  };
}

function run(over: Partial<RunResult> = {}): RunResult {
  return { failingIds: [], failingFiles: [], collectionError: false, total: 5, complete: true, source: "report", ...over };
}

// ---------------------------------------------------------------------------------------------
// B3: keys
// ---------------------------------------------------------------------------------------------

describe("envSignature", () => {
  it("is independent of key order and sensitive to values", () => {
    expect(envSignature({ B: "1", A: "2" })).toBe(envSignature({ A: "2", B: "1" }));
    expect(envSignature({ A: "1" })).not.toBe(envSignature({ A: "2" }));
    expect(envSignature({})).toBe("[]");
  });
});

describe("argvTemplate", () => {
  it("drops inputs and masks the report path, also inside an option", () => {
    const s = spec({ inputs: ["/r/app/src/a.ts", "/r/app/src/b.ts"] });
    expect(argvTemplate(s)).toEqual(["/r/node_modules/vitest/vitest.mjs", "related", "--run", "--reporter=json", "--outputFile=<report>", "--maxWorkers=2"]);
  });

  it("keeps an option token equal to nothing in inputs", () => {
    const s = spec({ args: ["-t", "name", REPORT, "/r/app/src/a.ts"] });
    expect(argvTemplate(s)).toEqual(["-t", "name", "<report>"]);
  });
});

describe("batchKey", () => {
  it("equal for specs that differ only in inputs and report path", () => {
    const a = spec({ inputs: ["/r/app/src/a.ts"] });
    const b = spec({ inputs: ["/r/app/src/b.ts", "/r/app/src/c.ts"], reportPath: "/tmp/omr-verify-11111111-1111-1111-1111-111111111111.json" });
    expect(batchKey(a, "linux")).toBe(batchKey(b, "linux"));
  });

  const base = spec();
  const table: [string, ScopedSpec][] = [
    ["kept argument", spec({ args: [...base.args, "-t", "x"] })],
    ["worker cap", spec({ args: base.args.map((x) => (x === "--maxWorkers=2" ? "--maxWorkers=1" : x)) })],
    ["env", spec({ env: { NODE_ENV: "test" } })],
    ["cwd", spec({ cwd: "/r/other" })],
    ["file", spec({ file: "/opt/node" })],
    ["entry", spec({ entry: "/r/node_modules/vitest/other.mjs" })],
    ["gitRoot", spec({ gitRoot: "/s" })],
    ["runner", spec({ runner: "jest" })],
  ];
  for (const [what, other] of table) {
    it(`differs by ${what}`, () => expect(batchKey(other, "linux")).not.toBe(batchKey(base, "linux")));
  }

  it("folds path case on win32 only", () => {
    const upper = spec({ cwd: "C:\\R\\App", gitRoot: "C:\\R", entry: "C:\\R\\node_modules\\vitest\\vitest.mjs", file: "C:\\Node\\node.exe", args: [] });
    const lower = spec({ cwd: "c:\\r\\app", gitRoot: "c:\\r", entry: "c:\\r\\node_modules\\vitest\\vitest.mjs", file: "c:\\node\\node.exe", args: [] });
    expect(batchKey(upper, "win32")).toBe(batchKey(lower, "win32"));
    expect(batchKey(upper, "linux")).not.toBe(batchKey(lower, "linux"));
  });
});

describe("referenceKey", () => {
  const ref = (over: Partial<DispatchReference> = {}): DispatchReference => ({
    root: "/r",
    head: "h1",
    commit: "c1",
    untracked: new Map([
      ["a.txt", "1"],
      ["b.txt", "2"],
    ]),
    tracked: new Map([["src/x.ts", "9"]]),
    captureReasons: [
      { cause: "dependency-drift", path: "" },
      { cause: "untracked-symlink", path: "l" },
    ],
    capturedAt: 1,
    ...over,
  });

  it("ignores capturedAt and entry order", () => {
    const reordered = ref({
      capturedAt: 999,
      untracked: new Map([
        ["b.txt", "2"],
        ["a.txt", "1"],
      ]),
      captureReasons: [
        { cause: "untracked-symlink", path: "l" },
        { cause: "dependency-drift", path: "" },
      ],
    });
    expect(referenceKey(reordered)).toBe(referenceKey(ref()));
  });

  const table: [string, DispatchReference][] = [
    ["commit", ref({ commit: "c2" })],
    ["root", ref({ root: "/s" })],
    ["untracked hash", ref({ untracked: new Map([["a.txt", "1"], ["b.txt", "3"]]) })],
    ["tracked", ref({ tracked: new Map() })],
    ["captureReasons", ref({ captureReasons: [] })],
  ];
  for (const [what, other] of table) {
    it(`differs by ${what}`, () => expect(referenceKey(other)).not.toBe(referenceKey(ref())));
  }
});

// ---------------------------------------------------------------------------------------------
// B6: union change set
// ---------------------------------------------------------------------------------------------

describe("unionChangedFiles", () => {
  it("posix: resolves against each member's cwd and dedups by (path, previousPath) in first-seen order", () => {
    const out = unionChangedFiles(
      [
        { cwd: "/r/a", changedFiles: [{ path: "x.ts", status: "M" }, { path: "/r/shared.ts" }] },
        {
          cwd: "/r/b",
          changedFiles: [{ path: "../shared.ts", status: "A" }, { path: "y.ts", previousPath: "old.ts" }, { path: "y.ts" }, { path: "./y.ts", previousPath: "old.ts" }],
        },
      ],
      "linux",
    );
    expect(out).toEqual([
      { path: "/r/a/x.ts", status: "M" },
      { path: "/r/shared.ts" },
      { path: "/r/b/y.ts", previousPath: "/r/b/old.ts" },
      { path: "/r/b/y.ts" },
    ]);
  });

  it("win32: case-insensitive keys, native separators, first spelling kept", () => {
    const members = [
      { cwd: "C:\\R", changedFiles: [{ path: "src/A.ts", status: "M" }] },
      { cwd: "c:\\r\\src", changedFiles: [{ path: "a.ts", status: "D" }] },
    ];
    expect(unionChangedFiles(members, "win32")).toEqual([{ path: "C:\\R\\src\\A.ts", status: "M" }]);
  });

  it("posix keeps case-distinct paths apart", () => {
    const members = [
      { cwd: "/r", changedFiles: [{ path: "A.ts" }] },
      { cwd: "/r", changedFiles: [{ path: "a.ts" }] },
    ];
    expect(unionChangedFiles(members, "linux")).toHaveLength(2);
  });

  it("an empty set of members gives an empty union", () => {
    expect(unionChangedFiles([], "linux")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B7: attribution
// ---------------------------------------------------------------------------------------------

describe("isGuardSensitive", () => {
  const table: [string, ScopedSpec, boolean][] = [
    ["source inputs only", spec(), false],
    ["a .test file", spec({ inputs: ["/r/app/src/a.ts", "/r/app/test/a.test.ts"] }), true],
    ["a .spec.tsx file", spec({ inputs: ["/r/app/src/a.spec.tsx"] }), true],
    ["a file under __tests__", spec({ inputs: ["/r/app/__tests__/a.ts"] }), true],
    ["a win32 __tests__ path", spec({ inputs: ["C:\\r\\app\\__tests__\\a.ts"] }), true],
    ["lexicalPaths", spec({ lexicalPaths: true }), true],
    ["inputsAreTests", spec({ runner: "pytest", inputsAreTests: true, inputs: ["/r/app/tests/test_a.py"] }), true],
    ["no inputs", spec({ inputs: [] }), false],
  ];
  for (const [what, s, want] of table) {
    it(`${what} -> ${want}`, () => {
      expect(isGuardSensitive(s, "linux")).toBe(want);
      expect(isGuardSensitive(s, "win32")).toBe(want);
    });
  }
});

describe("fileKeyOf", () => {
  const table: [string, string, NodeJS.Platform, string][] = [
    ["/r/app", "/r/app/test/a.test.ts", "linux", "test/a.test.ts"],
    ["/r/app", "/r/other/x.ts", "linux", "../other/x.ts"],
    ["C:\\R\\App", "c:\\r\\app\\test\\a.test.ts", "win32", "test/a.test.ts"],
    ["C:\\R\\App", "C:\\R\\App\\Test\\A.test.ts", "win32", "Test/A.test.ts"],
  ];
  for (const [cwd, abs, platform, want] of table) {
    it(`${platform} ${abs} -> ${want}`, () => expect(fileKeyOf(cwd, abs, platform)).toBe(want));
  }
});

describe("attributeUnion", () => {
  const src = spec();
  const withTest = spec({ inputs: ["/r/app/src/a.ts", "/r/app/test/a.test.ts"] });
  const lexical = spec({ lexicalPaths: true });
  const py = spec({ runner: "pytest", cwd: "/r/py", inputs: ["/r/py/tests/test_a.py", "/r/py/tests/test_b.py"], inputsAreTests: true });
  const pyCounts = { "tests/test_a.py": 2, "tests/test_b.py": 1, "tests/test_c.py": 4 };
  const green = (total: number | undefined) => ({ kind: "derived", exitCode: 0, result: run({ total }) });

  const table: [string, RunResult, Record<string, number> | undefined, ScopedSpec, unknown][] = [
    // 7.1
    ["7.1 incomplete union", run({ complete: false }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    ["7.1 collection error", run({ collectionError: true }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    ["7.1 text source", run({ source: "text" }), undefined, src, { kind: "own-run", cause: "not-comparable" }],
    // 7.2a
    ["7.2a not guard-sensitive", run({ total: 7 }), undefined, src, green(7)],
    // 7.2b JS
    ["7.2b JS test input, no counts", run(), undefined, withTest, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b JS test input, counted", run(), { "test/a.test.ts": 3, "test/z.test.ts": 2 }, withTest, green(3)],
    ["7.2b JS test input, 0 counted", run(), { "test/z.test.ts": 2 }, withTest, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b lexical, sources only", run(), { "src/a.ts": 1 }, lexical, { kind: "own-run", cause: "zero-test-ambiguous" }],
    // 7.2b pytest
    ["7.2b pytest, no counts", run(), undefined, py, { kind: "own-run", cause: "zero-test-ambiguous" }],
    ["7.2b pytest, counted", run(), pyCounts, py, green(3)],
    [
      "7.2b pytest, 0 counted",
      run(),
      { "tests/test_c.py": 4 },
      py,
      { kind: "derived", exitCode: 5, result: run({ total: 0, complete: false, note: "pytest ran no tests although a test file was passed" }) },
    ],
    // 7.3a
    [
      "7.3a pytest failure in the member's file, counted",
      run({ failingIds: ["tests/test_a.py::t1", "tests/test_c.py::t9"], failingFiles: ["/r/py/tests/test_a.py", "/r/py/tests/test_c.py"] }),
      pyCounts,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"], total: 3 }) },
    ],
    [
      "7.3a pytest failure in the member's file, no counts",
      run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"] }),
      undefined,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_a.py::t1"], failingFiles: ["/r/py/tests/test_a.py"], total: 5 }) },
    ],
    [
      "7.3a pytest bare collection-file id attributes too",
      run({ failingIds: ["tests/test_b.py"], failingFiles: ["/r/py/tests/test_b.py"] }),
      pyCounts,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_b.py"], failingFiles: ["/r/py/tests/test_b.py"], total: 3 }) },
    ],
    [
      // QA-2.2-11: the file part ends at the earliest separator, here "::", not at the " > " inside the name.
      "7.3a pytest name containing \" > \" is charged to its file",
      run({ failingIds: ["tests/test_a.py::test_cmp[1 > 0]", "tests/test_c.py::test_cmp[2 > 1]"], failingFiles: ["/r/py/tests/test_a.py", "/r/py/tests/test_c.py"] }),
      pyCounts,
      py,
      { kind: "derived", exitCode: 1, result: run({ failingIds: ["tests/test_a.py::test_cmp[1 > 0]"], failingFiles: ["/r/py/tests/test_a.py"], total: 3 }) },
    ],
    ["7.3a pytest failure elsewhere, counted", run({ failingIds: ["tests/test_c.py::t9"], failingFiles: ["/r/py/tests/test_c.py"] }), pyCounts, py, green(3)],
    ["7.3a pytest failure elsewhere, no counts", run({ failingIds: ["tests/test_c.py::t9"] }), undefined, py, { kind: "own-run", cause: "zero-test-ambiguous" }],
    // 7.3b
    ["7.3b vitest failing, source member", run({ failingIds: ["test/a.test.ts > x"] }), { "test/a.test.ts": 1 }, src, { kind: "own-run", cause: "mode-b" }],
    ["7.3b vitest failing, test member", run({ failingIds: ["test/a.test.ts > x"] }), { "test/a.test.ts": 1 }, withTest, { kind: "own-run", cause: "mode-b" }],
  ];
  for (const [what, union, counts, member, want] of table) {
    it(what, () => expect(attributeUnion(union, counts, member, "linux")).toEqual(want));
  }

  it("win32: ids and files match the member's inputs case-insensitively", () => {
    const wpy = spec({ runner: "pytest", cwd: "C:\\R\\Py", gitRoot: "C:\\R", inputs: ["C:\\R\\Py\\tests\\test_a.py"], inputsAreTests: true });
    const union = run({ failingIds: ["Tests/test_a.py::t", "tests/test_b.py::u"], failingFiles: ["c:\\r\\py\\tests\\test_a.py", "C:\\R\\Py\\tests\\test_b.py"] });
    expect(attributeUnion(union, { "tests/Test_A.py": 2 }, wpy, "win32")).toEqual({
      kind: "derived",
      exitCode: 1,
      result: run({ failingIds: ["Tests/test_a.py::t"], failingFiles: ["c:\\r\\py\\tests\\test_a.py"], total: 2 }),
    });
    // On posix the same spellings do not match.
    const ppy = spec({ runner: "pytest", cwd: "/R/Py", inputs: ["/R/Py/tests/test_a.py"], inputsAreTests: true });
    expect(attributeUnion(run({ failingIds: ["Tests/test_a.py::t"] }), undefined, ppy, "linux")).toEqual({ kind: "own-run", cause: "zero-test-ambiguous" });
  });
});

describe("QA-2.2-1: pytest static attribution through the real readResult", () => {
  const XML = "/tmp/omr-verify-00000000-0000-0000-0000-000000000000.xml";
  const X = "/r/tests/test_x.py";
  const Y = "/r/tests/test_y.py";
  const SUB = "/r/sub/tests/test_x.py";
  const host = { platform: "linux" as const, tmpdir: "/tmp" };
  const pyspec = (inputs: string[], pinned = true): ScopedSpec =>
    spec({
      runner: "pytest",
      file: "/usr/bin/pytest",
      entry: "/usr/bin/pytest",
      cwd: "/r",
      gitRoot: "/r",
      reportPath: XML,
      args: ["-p", "no:cacheprovider", `--junitxml=${XML}`, "--maxfail=0", ...(pinned ? ["--rootdir=/r"] : []), "--", ...inputs],
      inputs,
      inputsAreTests: true,
      workers: null,
    });
  const junit = (...cases: string[]) => `<?xml version="1.0"?><testsuites><testsuite>${cases.join("")}</testsuite></testsuites>`;
  const failing = (classname: string, name: string) => `<testcase classname="${classname}" name="${name}"><failure message="boom">x</failure></testcase>`;
  const passing = (classname: string, name: string) => `<testcase classname="${classname}" name="${name}"/>`;
  async function readReport(s: ScopedSpec, xml: string, code: number): Promise<RunResult> {
    const fs = {
      fileExists: async (p: string) => p === XML,
      readFile: async (p: string) => {
        if (p !== XML) throw new Error(`ENOENT ${p}`);
        return xml;
      },
      unlink: async () => undefined,
    };
    return readResult(s, { code, stdout: "", stderr: "" }, fs, host);
  }
  // A owns tests/test_x.py (failing) and tests/test_y.py; B owns sub/tests/test_x.py (green).
  const unionXml = junit(failing("tests.test_x", "test_1"), passing("sub.tests.test_x", "test_1"), passing("sub.tests.test_x", "test_2"), passing("tests.test_y", "test_1"));

  it("the owner of the failing tests/test_x.py is charged, never excused by sub/tests/test_x.py", async () => {
    const a = pyspec([X, Y]);
    const b = pyspec([SUB]);
    const union = await readReport(pyspec([SUB, X, Y]), unionXml, 1);
    const soloA = await readReport(a, junit(failing("tests.test_x", "test_1"), passing("tests.test_y", "test_1")), 1);
    const soloB = await readReport(b, junit(passing("sub.tests.test_x", "test_1"), passing("sub.tests.test_x", "test_2")), 0);
    expect(soloA).toMatchObject({ failingIds: ["tests/test_x.py::test_1"], complete: true });

    const derivedA = attributeUnion(union, union.testsByFile, a, "linux");
    expect(derivedA).toEqual({
      kind: "derived",
      exitCode: 1,
      result: { failingIds: soloA.failingIds, failingFiles: soloA.failingFiles, collectionError: false, total: 2, complete: true, source: "report" },
    });
    const derivedB = attributeUnion(union, union.testsByFile, b, "linux");
    expect(derivedB).toEqual({ kind: "derived", exitCode: 0, result: run({ total: soloB.total }) });
  });

  it("without a pinned rootdir the union is ambiguous: not comparable, so every member runs its own spec", async () => {
    const union = await readReport(pyspec([SUB, X, Y], false), unionXml, 1);
    expect(union.complete).toBe(false);
    for (const member of [pyspec([X, Y], false), pyspec([SUB], false)]) {
      expect(attributeUnion(union, union.testsByFile, member, "linux")).toEqual({ kind: "own-run", cause: "not-comparable" });
    }
  });
});

describe("taintUnreproduced", () => {
  it("nothing unreproduced returns the result unchanged", () => {
    const r = run();
    expect(taintUnreproduced(r, [])).toBe(r);
  });

  it("marks the result incomplete with sorted, deduplicated ids and keeps its failures", () => {
    const r = run({ failingIds: ["a > x"], failingFiles: ["/r/a"] });
    expect(taintUnreproduced(r, ["z > 2", "b > 1", "z > 2"])).toEqual({
      ...r,
      complete: false,
      note: "batched run failure not reproduced by any request's own run: b > 1, z > 2",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B8: shared recheck
// ---------------------------------------------------------------------------------------------

describe("deriveSharedRecheck", () => {
  const passThrough: RecheckOutcome[] = [
    { kind: "approximate", inexactReasons: [{ cause: "dependency-drift", path: "" }] },
    { kind: "disabled" },
    { kind: "timed-out", boundMs: 100 },
    { kind: "skipped-deadline", remainingMs: 50 },
  ];
  for (const o of passThrough) {
    it(`${o.kind} is the same for every member`, () => expect(deriveSharedRecheck(o, undefined, ["/r/app/x.test.ts"], "/r/app", "linux")).toBe(o));
  }

  for (const cause of ["no-reference", "materialize-failed", "reference-vanished", "unreproduced-inputs", "runner-unsupported", "error"] as const) {
    it(`unusable ${cause} (reference-level) is shared`, () => {
      const o: RecheckOutcome = { kind: "unusable", cause, reason: "r" };
      expect(deriveSharedRecheck(o, undefined, [], "/r", "linux")).toBe(o);
    });
  }
  for (const cause of ["incomplete", "collection-error", "no-tests", "rerun-unplannable"] as const) {
    it(`unusable ${cause} (run-level) splits`, () => {
      expect(deriveSharedRecheck({ kind: "unusable", cause, reason: "r" }, undefined, [], "/r", "linux")).toBe("split");
    });
  }

  const shared: RecheckOutcome = {
    kind: "exact",
    result: run({
      failingIds: ["test/a.test.ts > x", "test/b.test.ts > y"],
      failingFiles: ["/wt/app/test/a.test.ts", "/wt/app/test/b.test.ts"],
      total: 4,
    }),
    ranFiles: ["test/a.test.ts", "test/b.test.ts", "test/e.test.ts"],
    absentFiles: ["test/c.test.ts"],
    notes: ["n"],
  };
  const counts = { "test/a.test.ts": 2, "test/b.test.ts": 2, "test/e.test.ts": 1 };

  it("exact: filtered to the member's ran files, total from the counts", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/a.test.ts", "/r/app/test/c.test.ts"], "/r/app", "linux")).toEqual({
      kind: "exact",
      result: run({ failingIds: ["test/a.test.ts > x"], failingFiles: ["/wt/app/test/a.test.ts"], total: 2 }),
      ranFiles: ["test/a.test.ts"],
      absentFiles: ["test/c.test.ts"],
      notes: ["n"],
    });
  });

  it("exact: every file of the member absent -> undefined result", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/c.test.ts"], "/r/app", "linux")).toEqual({
      kind: "exact",
      result: undefined,
      ranFiles: [],
      absentFiles: ["test/c.test.ts"],
      notes: ["n"],
    });
  });

  it("exact: a ran file with no failing id at the reference is exact with counts", () => {
    const r = deriveSharedRecheck(shared, counts, ["/r/app/test/e.test.ts"], "/r/app", "linux");
    expect(r).toMatchObject({ kind: "exact", result: { failingIds: [], failingFiles: [], total: 1, complete: true } });
  });

  it("exact: the same without counts splits", () => {
    expect(deriveSharedRecheck(shared, undefined, ["/r/app/test/e.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: without counts, a failing id keeps the shared total", () => {
    expect(deriveSharedRecheck(shared, undefined, ["/r/app/test/b.test.ts"], "/r/app", "linux")).toMatchObject({
      kind: "exact",
      result: { failingIds: ["test/b.test.ts > y"], failingFiles: ["/wt/app/test/b.test.ts"], total: 4 },
    });
  });

  it("exact: the member's ran files hold 0 tests -> unusable incomplete", () => {
    expect(deriveSharedRecheck(shared, { ...counts, "test/a.test.ts": 0 }, ["/r/app/test/a.test.ts"], "/r/app", "linux")).toEqual({
      kind: "unusable",
      cause: "incomplete",
      reason: "rerun ran no tests although every input is a test file",
    });
  });

  it("exact: a member file neither ran nor absent splits", () => {
    expect(deriveSharedRecheck(shared, counts, ["/r/app/test/d.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: ran files without a shared result split", () => {
    expect(deriveSharedRecheck({ ...shared, result: undefined }, counts, ["/r/app/test/a.test.ts"], "/r/app", "linux")).toBe("split");
  });

  it("exact: rerun files take the longest matching key", () => {
    const nested: RecheckOutcome = {
      kind: "exact",
      result: run({ failingIds: ["sub/x.test.ts > b", "x.test.ts > a"], failingFiles: ["/wt/sub/x.test.ts", "/wt/x.test.ts"], total: 2 }),
      ranFiles: ["x.test.ts", "sub/x.test.ts"],
      absentFiles: [],
      notes: [],
    };
    expect(deriveSharedRecheck(nested, { "x.test.ts": 1, "sub/x.test.ts": 1 }, ["/r/x.test.ts"], "/r", "linux")).toMatchObject({
      result: { failingIds: ["x.test.ts > a"], failingFiles: ["/wt/x.test.ts"], total: 1 },
      ranFiles: ["x.test.ts"],
    });
  });

  it("win32: member files, keys and rerun paths match case-insensitively", () => {
    const w: RecheckOutcome = {
      kind: "exact",
      result: run({ failingIds: ["test/a.test.ts > x"], failingFiles: ["D:\\wt\\Test\\A.test.ts"], total: 3 }),
      ranFiles: ["test/a.test.ts"],
      absentFiles: [],
      notes: [],
    };
    expect(deriveSharedRecheck(w, { "Test/A.test.ts": 3 }, ["c:\\r\\Test\\A.test.ts"], "C:\\R", "win32")).toMatchObject({
      kind: "exact",
      result: { failingIds: ["test/a.test.ts > x"], failingFiles: ["D:\\wt\\Test\\A.test.ts"], total: 3 },
      ranFiles: ["test/a.test.ts"],
    });
    expect(deriveSharedRecheck(w, undefined, ["/R/Test/A.test.ts"], "/R", "linux")).toBe("split");
  });
});

// ---------------------------------------------------------------------------------------------
// B9: batch deadline
// ---------------------------------------------------------------------------------------------

interface FakeDeadline extends Deadline {
  abort(): void;
  listeners: Set<unknown>;
}

function fake(budgetMs: number, remainingMs: number): FakeDeadline {
  const ctl = new AbortController();
  const listeners = new Set<unknown>();
  const signal = ctl.signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  vi.spyOn(signal, "addEventListener").mockImplementation((type, listener, options) => {
    listeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(signal, "removeEventListener").mockImplementation((type, listener, options) => {
    listeners.delete(listener);
    remove(type, listener, options);
  });
  return {
    budgetMs,
    remaining: () => (signal.aborted ? 0 : remainingMs),
    bound: (ms) => Math.min(ms, signal.aborted ? 0 : remainingMs),
    signal,
    abort: () => ctl.abort(),
    listeners,
  };
}

describe("createBatchDeadline", () => {
  it("remaining is the largest attached remaining, bound clamps, budget is the largest budget", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    expect(d.budgetMs).toBe(5000);
    expect(d.remaining()).toBe(700);
    expect(d.bound(500)).toBe(500);
    expect(d.bound(Number.POSITIVE_INFINITY)).toBe(700);
    expect(d.signal.aborted).toBe(false);
    d.dispose();
  });

  it("a released member no longer counts; releasing everyone aborts and leaves no listener", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    d.release(b);
    expect(b.listeners.size).toBe(0);
    expect(d.remaining()).toBe(300);
    d.release(b); // idempotent
    expect(d.signal.aborted).toBe(false);
    d.release(a);
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    expect(a.listeners.size).toBe(0);
  });

  it("aborts only once every attached member has aborted", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    a.abort();
    expect(d.signal.aborted).toBe(false);
    expect(d.remaining()).toBe(700);
    b.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.remaining()).toBe(0);
    expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it("releasing the last live member when the rest have aborted aborts", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b]);
    a.abort();
    d.release(b);
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size + b.listeners.size).toBe(0);
  });

  it("dispose aborts, removes every listener and is idempotent", () => {
    const a = fake(1000, 300);
    const b = fake(5000, 700);
    const d = createBatchDeadline([a, b, a]);
    expect(a.listeners.size).toBe(1);
    d.dispose();
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size + b.listeners.size).toBe(0);
    d.dispose();
    expect(d.signal.aborted).toBe(true);
    expect(a.signal.aborted).toBe(false);
  });

  it("no members, or members already aborted, abort at once", () => {
    const empty = createBatchDeadline([]);
    expect(empty.signal.aborted).toBe(true);
    expect(empty.remaining()).toBe(0);
    expect(empty.budgetMs).toBe(0);
    const a = fake(1000, 300);
    a.abort();
    const d = createBatchDeadline([a]);
    expect(d.signal.aborted).toBe(true);
    expect(a.listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: fakes (fake timers; a model repository behind fake planner and scope seams)
// ---------------------------------------------------------------------------------------------

const WINDOW = 100;
const ROOT = "/r";

interface TestDeadline extends Deadline {
  abort(): void;
}

/** A gate deadline on the (fake) clock. It has no timer: the owner aborts it, as withTimeout does. */
function liveDeadline(budgetMs = 60_000): TestDeadline {
  const ctl = new AbortController();
  const start = Date.now();
  const remaining = () => (ctl.signal.aborted ? 0 : Math.max(0, budgetMs - (Date.now() - start)));
  return { budgetMs, remaining, bound: (ms) => Math.min(ms, remaining()), signal: ctl.signal, abort: () => ctl.abort() };
}

const REF: DispatchReference = {
  root: ROOT,
  head: "h1",
  commit: "c1",
  untracked: new Map(),
  tracked: new Map(),
  captureReasons: [],
  capturedAt: 0,
};

interface TestRequest extends TestsPassRequest {
  readonly deadline: TestDeadline;
}

function req(files: readonly string[], over: Partial<TestRequest> = {}): TestRequest {
  return {
    command: "npx vitest run",
    cwd: ROOT,
    testScope: "affected",
    changedFiles: files.map((path) => ({ path, status: "M" })),
    reference: { kind: "captured", reference: REF },
    deadline: liveDeadline(),
    ...over,
  };
}

/** The model repository: which test files relate to which source, and what fails now and at the reference. */
interface Model {
  /** Source key (cwd-relative) -> its related test files. A test file relates to itself. */
  readonly related?: Readonly<Record<string, readonly string[]>>;
  /** Test file -> its number of tests (default 2). */
  readonly tests?: Readonly<Record<string, number>>;
  /** Test file -> the names failing in the live tree. */
  readonly failing?: Readonly<Record<string, readonly string[]>>;
  /** Test file -> the names failing at the reference; a file missing here is absent there. */
  readonly atRef?: Readonly<Record<string, readonly string[]>>;
  /** false: reports carry no per-file counts (P1 absent). */
  readonly counts?: boolean;
}

const MODEL: Model = {
  related: Object.fromEntries([..."abcdefgh"].map((x) => [`src/${x}.ts`, [`test/${x}.test.ts`]])),
};

const isTestKey = (k: string) => /\.test\.ts$|(^|\/)test_[^/]*\.py$/.test(k);
const idOf = (runner: RunnerKind, file: string, name: string) => (runner === "pytest" ? `${file}::${name}` : `${file} > ${name}`);
const keyOfId = (id: string) => id.split(/ > |::/)[0] ?? id;

/** readResult over the model, with its zero-test guard and per-file counts. */
function runModel(model: Model, spec: ScopedSpec): RunResult {
  const files = new Set<string>();
  for (const abs of spec.inputs) {
    const k = posix.relative(spec.cwd, abs);
    if (spec.inputsAreTests || isTestKey(k)) files.add(k);
    for (const t of model.related?.[k] ?? []) files.add(t);
  }
  const keys = [...files].sort();
  const failingIds = keys.flatMap((k) => (model.failing?.[k] ?? []).map((n) => idOf(spec.runner, k, n))).sort();
  const failingFiles = [...new Set(failingIds.map(keyOfId))].map((k) => posix.join(spec.cwd, k)).sort();
  const testsByFile: Record<string, number> = Object.fromEntries(keys.map((k) => [k, model.tests?.[k] ?? 2]));
  const total = keys.reduce((n, k) => n + (testsByFile[k] ?? 0), 0);
  const guard = total === 0 && (spec.inputsAreTests || spec.inputs.some((f) => isTestKey(posix.relative(spec.cwd, f))));
  return {
    failingIds,
    failingFiles,
    collectionError: false,
    total,
    complete: !guard,
    source: "report",
    ...(guard ? { note: `${spec.runner} ran no tests although a test file was passed` } : {}),
    ...(model.counts === false ? {} : { testsByFile }),
  };
}

function ranModel(model: Model, spec: ScopedSpec): ScopedOutcome {
  const result = runModel(model, spec);
  return { kind: "ran", result, exitCode: result.failingIds.length > 0 ? 1 : 0, spec, notes: spec.notes };
}

/** 2.1's Rechecker over the model: pytest is runner-unsupported; vitest reruns the files present at the reference. */
function recheckModel(model: Model, command: string, cwd: string, files: readonly string[]): RecheckOutcome {
  if (command.split(" ").includes("pytest")) return { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" };
  const keys = [...new Set(files.map((f) => posix.relative(cwd, f)))].sort();
  const ranFiles = keys.filter((k) => model.atRef?.[k] !== undefined);
  const absentFiles = keys.filter((k) => model.atRef?.[k] === undefined);
  if (ranFiles.length === 0) return { kind: "exact", result: undefined, ranFiles, absentFiles, notes: [] };
  const failingIds = ranFiles.flatMap((k) => (model.atRef?.[k] ?? []).map((n) => idOf("vitest", k, n))).sort();
  const testsByFile: Record<string, number> = Object.fromEntries(ranFiles.map((k) => [k, model.tests?.[k] ?? 2]));
  const result: RunResult = {
    failingIds,
    failingFiles: [...new Set(failingIds.map(keyOfId))].map((k) => `/tmp/omr-ref/${k}`),
    collectionError: false,
    total: ranFiles.reduce((n, k) => n + (testsByFile[k] ?? 0), 0),
    complete: true,
    source: "report",
    ...(model.counts === false ? {} : { testsByFile }),
  };
  return { kind: "exact", result, ranFiles, absentFiles, notes: ["rechecked at the reference"] };
}

/** planScopedRun over the model. The command's words after the subcommand are kept options (B3). */
function planModel(input: BatchPlanInput, report = 0, argvCap = Number.POSITIVE_INFINITY): ScopingPlan {
  if (input.changedFiles === "unavailable") return { unverifiable: true, code: "attribution-unavailable", reason: "no change attribution" };
  const inputs = [...new Set(input.changedFiles.map((c) => posix.resolve(input.cwd, c.path)))].sort();
  if (inputs.length === 0) return { noAffected: true, note: "no affected tests" };
  if (inputs.some((f) => f.includes("untestable"))) return { unverifiable: true, code: "config-changed", reason: "a config file changed" };
  if (inputs.length > argvCap) return { unverifiable: true, code: "argv-too-long", reason: "argv too long" };
  const words = input.command.split(" ");
  const runner: RunnerKind = words.includes("pytest") ? "pytest" : words.includes("jest") ? "jest" : "vitest";
  const reportPath = `/tmp/omr-report-${report}.${runner === "pytest" ? "xml" : "json"}`;
  const entry = `${input.cwd}/node_modules/${runner}/bin.js`;
  const options = words.slice(runner === "vitest" ? 3 : 2);
  return {
    runner,
    mode: "related",
    file: runner === "pytest" ? "/usr/bin/pytest" : "/usr/bin/node",
    args:
      runner === "pytest"
        ? [`--junitxml=${reportPath}`, ...options, ...inputs]
        : [entry, "related", "--run", ...options, `--outputFile=${reportPath}`, ...inputs],
    cwd: input.cwd,
    env: { CI: "1" },
    reportPath,
    gitRoot: input.cwd,
    entry,
    inputs,
    inputsAreTests: runner === "pytest",
    workers: runner === "pytest" ? null : 2,
    notes: [`planned ${inputs.length} input(s)`],
  };
}

interface Calls {
  readonly events: string[];
  readonly plans: BatchPlanInput[];
  readonly planned: ScopingPlan[];
  readonly opens: { readonly cwd: string; readonly command: string }[];
  readonly executes: { readonly scope: number; readonly spec: ScopedSpec; readonly deadline: Deadline; readonly at: number }[];
  readonly rechecks: {
    readonly scope: number;
    readonly command: string;
    readonly reference: DispatchReference;
    readonly files: readonly string[];
    readonly deadline: Deadline;
  }[];
  readonly closes: number[];
  readonly direct: TestsPassRequest[];
}

interface HarnessOptions {
  /** Replaces the model run; `n` is the index of the execute call. */
  readonly execute?: (spec: ScopedSpec, deadline: Deadline, n: number) => ScopedOutcome | Promise<ScopedOutcome>;
  /** Replaces the model recheck; `n` is the index of the recheck call. */
  readonly rechecker?: (
    reference: DispatchReference,
    files: readonly string[],
    deadline: Deadline,
    n: number,
  ) => RecheckOutcome | Promise<RecheckOutcome>;
  readonly plan?: BatchPlanner;
  readonly argvCap?: number;
  readonly runtime?: Partial<BatchRuntime>;
  /** Called when a scope releases its slot (its first close). */
  readonly close?: () => void;
}

/** The runtime seams, each counting its calls. A scope throws when used after its close. */
function harness(model: Model = MODEL, o: HarnessOptions = {}) {
  const calls: Calls = { events: [], plans: [], planned: [], opens: [], executes: [], rechecks: [], closes: [], direct: [] };
  let reports = 0;
  const plan: BatchPlanner = async (input, deadline) => {
    calls.plans.push(input);
    const out = o.plan !== undefined ? await o.plan(input, deadline) : planModel(input, reports++, o.argvCap);
    calls.planned.push(out);
    return out;
  };
  const openScope: OpenVerificationScope = (meta) => {
    const id = calls.opens.length;
    calls.opens.push(meta);
    calls.events.push(`open ${id}`);
    let closed = false;
    const use = (what: string) => {
      if (closed) throw new Error(`${what} after close`);
      calls.events.push(`${what} ${id}`);
    };
    return {
      execute: async (spec, deadline) => {
        use("execute");
        const n = calls.executes.push({ scope: id, spec, deadline, at: Date.now() }) - 1;
        if (deadline.signal.aborted) return { kind: "aborted", reason: "aborted before the spawn" };
        return o.execute !== undefined ? o.execute(spec, deadline, n) : ranModel(model, spec);
      },
      rechecker: (command, cwd) => async (reference, files, deadline) => {
        use("recheck");
        const n = calls.rechecks.push({ scope: id, command, reference, files, deadline }) - 1;
        return o.rechecker !== undefined ? o.rechecker(reference, files, deadline, n) : recheckModel(model, command, cwd, files);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        calls.closes.push(id);
        calls.events.push(`close ${id}`);
        o.close?.();
      },
    };
  };
  const direct: TestsPassHook = async (request) => {
    calls.direct.push(request);
    return { scoped: { kind: "no-affected", note: "direct" }, recheck: undefined };
  };
  const runtime: BatchRuntime = { direct, plan, openScope, batchWindowMs: WINDOW, recheckMinRemainingMs: 1_000, failureRecheck: true, ...o.runtime };
  return { calls, runtime };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An executor that runs until its signal aborts, as a killed tree reports. */
function untilAborted(_spec: ScopedSpec, deadline: Deadline): Promise<ScopedOutcome> {
  return new Promise((resolve) => {
    deadline.signal.addEventListener("abort", () => resolve({ kind: "aborted", reason: "tree killed" }), { once: true });
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const at = (k: string, cwd = ROOT) => posix.join(cwd, k);
const aborted = (reason: string): TestsPassRun => ({ scoped: { kind: "aborted", reason }, recheck: undefined });

function specOf(plan: ScopingPlan): ScopedSpec {
  if ("noAffected" in plan || "unverifiable" in plan) throw new Error(`expected a ScopedSpec, got ${JSON.stringify(plan)}`);
  return plan;
}

function ran(run: TestsPassRun): Extract<ScopedOutcome, { kind: "ran" }> {
  if (run.scoped.kind !== "ran") throw new Error(`expected a ran outcome, got ${JSON.stringify(run.scoped)}`);
  return run.scoped;
}

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: B2 bypasses, B4 windows, B5 union run, B9 deadlines, B11 disposal
// ---------------------------------------------------------------------------------------------

describe("createBatchCoordinator: windows and the union run", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("five requests in one window: exactly one union run under one scope, five outcomes", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const names = [..."abcde"];
    const outs = names.map((x) => hook(req([`src/${x}.ts`])));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, pendingRequests: 5, runningBatches: 0 });
    expect(calls.executes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(calls.opens).toEqual([{ cwd: ROOT, command: "npx vitest run" }]);
    expect(calls.executes).toHaveLength(1);
    expect(calls.executes[0]?.spec.inputs).toEqual(names.map((x) => at(`src/${x}.ts`)));
    runs.forEach((run, i) => {
      expect(run.recheck).toBeUndefined();
      const s = ran(run);
      expect(s).toMatchObject({ exitCode: 0, result: { failingIds: [], complete: true, total: 10 } });
      expect(s.spec?.inputs).toEqual([at(`src/${names[i]}.ts`)]);
      expect(s.notes).toEqual(["planned 1 input(s)", "batched: 1 run for 5 requests"]);
    });
    expect(c.stats()).toEqual({
      openWindows: 0,
      runningBatches: 0,
      pendingRequests: 0,
      unionRuns: 1,
      ownRuns: 0,
      rechecks: 0,
      splits: 0,
      taints: 0,
    });
    await c.dispose();
    expect(calls.closes).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("different roots, runners or kept options form separate batches, each with its own scope", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [
      hook(req(["src/a.ts"])),
      hook(req(["src/b.ts"])),
      hook(req(["src/a.ts"], { cwd: "/s" })),
      hook(req(["src/a.ts"], { command: "npx jest" })),
      hook(req(["src/c.ts"], { command: "npx vitest run -t smoke" })),
    ];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(runs.map((r) => r.scoped.kind)).toEqual(["ran", "ran", "ran", "ran", "ran"]);
    expect(calls.opens).toHaveLength(4);
    const batches = calls.executes.map((e) => JSON.stringify([e.spec.runner, e.spec.cwd, e.spec.args.includes("smoke"), e.spec.inputs.length]));
    expect(batches.sort()).toEqual(
      [
        ["jest", ROOT, false, 1],
        ["vitest", "/s", false, 1],
        ["vitest", ROOT, false, 2],
        ["vitest", ROOT, true, 1],
      ]
        .map((x) => JSON.stringify(x))
        .sort(),
    );
    expect(new Set(calls.executes.map((e) => e.scope)).size).toBe(4);
    expect(c.stats()).toMatchObject({ unionRuns: 1, ownRuns: 3 });
    await c.dispose();
  });

  it("batchWindowMs <= 0 and testScope full use runtime.direct", async () => {
    const { calls, runtime } = harness(MODEL, { runtime: { batchWindowMs: 0 } });
    const c = createBatchCoordinator({ platform: "linux" });
    const direct = { scoped: { kind: "no-affected", note: "direct" }, recheck: undefined };
    expect(await c.hook(runtime)(req(["src/a.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: -1 })(req(["src/b.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: Number.NaN })(req(["src/b.ts"]))).toEqual(direct);
    expect(await c.hook({ ...runtime, batchWindowMs: WINDOW })(req(["src/c.ts"], { testScope: "full" }))).toEqual(direct);
    expect(calls.direct).toHaveLength(4);
    expect(calls.plans).toHaveLength(0);
    expect(calls.opens).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a request with crossLinkRoot uses runtime.direct, never the coordinator's plan (cross-repo P3a)", async () => {
    const { calls, runtime } = harness(MODEL, { runtime: { batchWindowMs: WINDOW } });
    const c = createBatchCoordinator({ platform: "linux" });
    const direct = { scoped: { kind: "no-affected", note: "direct" }, recheck: undefined };
    const crossLinked = req(["src/a.ts"], { crossLinkRoot: "/lib", crossLinkAliases: [`${ROOT}/node_modules/lib`] });
    expect(await c.hook(runtime)(crossLinked)).toEqual(direct);
    expect(calls.direct).toEqual([crossLinked]);
    expect(calls.plans).toHaveLength(0);
    expect(calls.opens).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await c.dispose();
  });

  it("planning outcomes and an exhausted deadline settle at once, without a window or the slot", async () => {
    const late = req(["src/b.ts"]);
    const { calls, runtime } = harness(MODEL, {
      plan: async (input) => {
        if (input.changedFiles !== "unavailable" && input.changedFiles.some((f) => f.path === "src/b.ts")) late.deadline.abort();
        return planModel(input);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    expect(await hook(req([]))).toEqual({ scoped: { kind: "no-affected", note: "no affected tests" }, recheck: undefined });
    expect(await hook(req(["vitest.untestable.ts"]))).toEqual({
      scoped: { kind: "unverifiable", code: "config-changed", reason: "a config file changed" },
      recheck: undefined,
    });
    expect(await hook(req(["src/a.ts"], { changedFiles: "unavailable" }))).toMatchObject({
      scoped: { kind: "unverifiable", code: "attribution-unavailable" },
    });
    const gone = req(["src/a.ts"]);
    gone.deadline.abort();
    expect(await hook(gone)).toEqual(aborted(BATCH_REASONS.beforeRun));
    expect(await hook(late)).toEqual(aborted(BATCH_REASONS.beforeRun));
    // QA-2.2-9: as in 2.1's direct hook, an exhausted deadline is planned first, so a planning
    // outcome is the same as alone.
    const noneLeft = req([]);
    noneLeft.deadline.abort();
    expect(await hook(noneLeft)).toEqual({ scoped: { kind: "no-affected", note: "no affected tests" }, recheck: undefined });
    const s6 = req(["vitest.untestable.ts"]);
    s6.deadline.abort();
    expect(await hook(s6)).toMatchObject({ scoped: { kind: "unverifiable", code: "config-changed" } });
    expect(calls.plans).toHaveLength(7);
    expect(calls.opens).toHaveLength(0);
    expect(c.stats()).toMatchObject({ openWindows: 0, pendingRequests: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("QA-2.2-9: the direct-path reasons are 2.1's constants, verbatim", () => {
    // origin/vrb/p21 src/verify/deterministic.ts ABORTED_BEFORE_RUN and ABORTED_DURING_RUN.
    expect(BATCH_REASONS.beforeRun).toBe("gate budget exhausted before the scoped run");
    expect(BATCH_REASONS.run).toBe("gate budget exhausted during the scoped run");
  });

  it("QA-2.2-10: a logger that throws never turns into a rejection; it is dropped after its first throw", async () => {
    const warn = vi.fn(() => {
      throw new Error("logger down");
    });
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    // An internal failure (runBatch's catch logs), a split (logged) and a failing close (logged).
    const opening = harness(MODEL, { runtime: { openScope: () => { throw new Error("boom"); } } });
    const failed = [c.hook(opening.runtime)(req(["src/a.ts"])), c.hook(opening.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect((await Promise.all(failed)).map((r) => r.scoped)).toEqual([
      { kind: "error", reason: "verification batch failed: boom" },
      { kind: "error", reason: "verification batch failed: boom" },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const inner = harness(MODEL, { argvCap: 1 });
    const closing = harness(MODEL, {
      argvCap: 1,
      runtime: {
        openScope: (meta) => ({
          ...inner.runtime.openScope(meta),
          close: async () => {
            throw new Error("close failed");
          },
        }),
      },
    });
    const split = [c.hook(closing.runtime)(req(["src/a.ts"])), c.hook(closing.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect((await Promise.all(split)).map((r) => ran(r).exitCode)).toEqual([0, 0]);
    await expect(c.dispose()).resolves.toBeUndefined();
    expect(c.stats()).toMatchObject({ splits: 1, runningBatches: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("an arrival during a running batch joins the next window, never the running union", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec, _d, n) => {
        if (n === 0) await gate.promise;
        return ranModel(MODEL, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const first = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(1);

    const late = hook(req(["src/c.ts"]));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, runningBatches: 1, pendingRequests: 3 });
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await late).spec?.inputs).toEqual([at("src/c.ts")]);
    expect(calls.executes.map((e) => [e.scope, e.spec.inputs])).toEqual([
      [0, [at("src/a.ts"), at("src/b.ts")]],
      [1, [at("src/c.ts")]],
    ]);

    gate.resolve();
    expect((await Promise.all(first)).map((r) => ran(r).exitCode)).toEqual([0, 0]);
    await c.dispose();
    expect([...calls.closes].sort()).toEqual([0, 1]);
  });

  it("the maximum size closes a window early, and so does a joiner that could not outlive the wait (W2, W3)", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux", maxBatchSize: 3 });
    const hook = c.hook(runtime);
    const outs = [..."abcd"].map((x) => hook(req([`src/${x}.ts`])));
    await flush();
    expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([3]);
    expect(c.stats().openWindows).toBe(1);
    await Promise.all(outs.slice(0, 3));
    await vi.advanceTimersByTimeAsync(WINDOW);
    await outs[3];
    expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([3, 1]);

    // W3: 60 ms left in the window, and a joiner with exactly 60 ms left: far below its floor, so
    // the window closes at once. QA-2.2-17 (c): that joiner cannot cover a batched run either, so
    // the batch splits (QA-2.2-23): each member runs alone in its own scope, in arrival order.
    const w3 = harness();
    const c3 = createBatchCoordinator({ platform: "linux" });
    const hook3 = c3.hook(w3.runtime);
    const long = hook3(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(40);
    const short = hook3(req(["src/b.ts"], { deadline: liveDeadline(60) }));
    await flush();
    expect(w3.calls.executes.map((e) => [e.scope, e.spec.inputs])).toEqual([
      [0, [at("src/a.ts")]],
      [1, [at("src/b.ts")]],
    ]);
    expect(c3.stats()).toMatchObject({ unionRuns: 0, ownRuns: 2, splits: 1 });
    expect(vi.getTimerCount()).toBe(0);
    await Promise.all([long, short]);
    await Promise.all([c.dispose(), c3.dispose()]);
  });

  it("QA-2.2-17 (b), W3: a member's floor moves the close time earlier, never later, and keeps one timer", async () => {
    const { calls, runtime } = harness(MODEL, { runtime: { batchWindowMs: 10_000 } });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const long = hook(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(1_000);
    // Floor = recheck threshold 1 s (captured reference) + the margin; 3 s more than that: it may
    // wait 3 s, where the window alone would keep it 9 s more.
    const tight = req(["src/b.ts"], { deadline: liveDeadline(1_000 + BATCH_RESERVE_MARGIN_MS + 3_000) });
    const pt = hook(tight);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls.executes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts"), at("src/b.ts")]]);
    // At the close, b still has its whole floor: the window spent nothing from its reserve.
    expect(tight.deadline.remaining()).toBe(1_000 + BATCH_RESERVE_MARGIN_MS);
    await Promise.all([long, pt]);

    // No reference: the floor is only the margin, so the same budget waits the whole window.
    const loose = harness(MODEL, { runtime: { batchWindowMs: 3_000 } });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const outs = [
      c2.hook(loose.runtime)(req(["src/a.ts"])),
      c2.hook(loose.runtime)(req(["src/b.ts"], { reference: { kind: "none", reason: "none" }, deadline: liveDeadline(6_000) })),
    ];
    await vi.advanceTimersByTimeAsync(2_999);
    expect(loose.calls.executes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(loose.calls.executes).toHaveLength(1);
    await Promise.all(outs);
    await Promise.all([c.dispose(), c2.dispose()]);
  });

  it("QA-2.2-24, W3: the member at arrival index k keeps its floor plus e x (2k + 1), the split schedule ahead of its recheck", async () => {
    const RUN_MS = 1_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec) => {
        await tick();
        return ranModel(MODEL, spec);
      },
      runtime: { batchWindowMs: 10_000 },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    // A first batch measures the key's estimate: 1 s.
    const warm = hook(req(["src/h.ts"]));
    await vi.advanceTimersByTimeAsync(10_000 + RUN_MS);
    expect(ran(await warm).exitCode).toBe(0);
    // Floor 2 s. b joins second (k = 1): it keeps 2 s + 3 runs, so with 7 s it may wait 2 s. With
    // e ignored (QA-2.2-26 M4) it would wait 5 s; with one run for every member, 4 s.
    const a = hook(req(["src/a.ts"]));
    const b = hook(req(["src/b.ts"], { deadline: liveDeadline(2_000 + 3 * RUN_MS + 2_000) }));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls.executes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.executes.length).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(10 * RUN_MS);
    await Promise.all([a, b]);
    await c.dispose();
  });

  it("QA-2.2-26 (M14), W3: a run measured while a window is open moves that window's close earlier", async () => {
    const RUN_MS = 3_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec, _deadline, n) => {
        if (n === 0) await tick();
        return ranModel(MODEL, spec);
      },
      runtime: { batchWindowMs: 10_000 },
    });
    const c = createBatchCoordinator({ platform: "linux", maxBatchSize: 2 });
    const hook = c.hook(runtime);
    // Two requests fill a window (W2); their union runs 3 s, the key's first measurement.
    const first = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
    await flush();
    expect(calls.executes).toHaveLength(1);
    // m joins the next window with 8 s: floor 2 s and e = 0, so it could wait 6 s.
    const m = hook(req(["src/c.ts"], { deadline: liveDeadline(8_000) }));
    await flush();
    expect(c.stats().openWindows).toBe(1);
    // At 3 s the union is measured: m now keeps 2 s + 3 s, which it has only just left, so the
    // window closes then, not at 6 s.
    await vi.advanceTimersByTimeAsync(RUN_MS);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts"), at("src/b.ts")], [at("src/c.ts")]]);
    expect(c.stats().openWindows).toBe(0);
    await Promise.all([...first, m]);
    await c.dispose();
  });

  it("QA-2.2-17 (a), QA-2.2-18, W7: a lone request never waits; arrivals during a running batch gather until it ends", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec, _deadline, n) => {
        if (n === 0) await gate.promise;
        return ranModel(MODEL, spec);
      },
      runtime: { batchWindowMs: 10_000 },
    });
    const c = createCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const lone = hook(req(["src/a.ts"]));
    await flush();
    // No window wait: nothing else is in flight, so the window closed as the request joined.
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts")]]);
    expect(c.stats()).toMatchObject({ openWindows: 0, runningBatches: 1 });
    // Two requests arrive while that batch runs: they gather in one window ...
    const later = [hook(req(["src/b.ts"])), hook(req(["src/c.ts"]))];
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, runningBatches: 1, pendingRequests: 3 });
    // ... which closes as soon as the running batch ends, long before its 10 s timer.
    gate.resolve();
    await flush();
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts")], [at("src/b.ts"), at("src/c.ts")]]);
    expect((await Promise.all([lone, ...later])).map((r) => ran(r).exitCode)).toEqual([0, 0, 0]);
    expect(vi.getTimerCount()).toBe(0);
    await c.dispose();
  });

  it("W7: a request still planning keeps a window open; its planning outcome closes it", async () => {
    const held = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      plan: async (input) => {
        if (input.changedFiles !== "unavailable" && input.changedFiles.length === 0) await held.promise;
        return planModel(input);
      },
      runtime: { batchWindowMs: 10_000 },
    });
    const c = createCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = hook(req(["src/a.ts"]));
    const none = hook(req([]));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 1, pendingRequests: 1 });
    expect(calls.executes).toHaveLength(0);
    held.resolve();
    expect(await none).toEqual({ scoped: { kind: "no-affected", note: "no affected tests" }, recheck: undefined });
    await flush();
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts")]]);
    expect(ran(await a).exitCode).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await c.dispose();
  });

  it("QA-2.2-17 (c), B5.2a: with a measured run time, a member that cannot cover the batched schedule makes every member run alone", async () => {
    const RUN_MS = 1_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec) => {
        await tick();
        return ranModel(MODEL, spec);
      },
    });
    const c = createCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    // A first run measures the key's estimate: 1 s.
    const warm = hook(req(["src/h.ts"]));
    await vi.advanceTimersByTimeAsync(RUN_MS);
    expect(ran(await warm).exitCode).toBe(0);
    // Floor 2 s (1 s threshold + margin). s needs 2 s + 4 runs (union, 3 own runs) = 6 s: 5 s is short.
    const s = req(["src/s.ts"], { deadline: liveDeadline(5_000) });
    const outs = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"])), hook(s)];
    await flush();
    // QA-2.2-23: no union, and every member in a scope of its own, started in arrival order.
    expect(calls.executes.map((e) => [e.scope, e.spec.inputs])).toEqual([
      [0, [at("src/h.ts")]],
      [1, [at("src/a.ts")]],
      [2, [at("src/b.ts")]],
      [3, [at("src/s.ts")]],
    ]);
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const runs = await Promise.all(outs);
    for (const r of runs) expect(ran(r).notes).toEqual(["planned 1 input(s)"]);
    expect(c.stats()).toMatchObject({ unionRuns: 0, ownRuns: 4, splits: 1 });
    expect(calls.closes.sort()).toEqual([0, 1, 2, 3]);
    // Before any measurement the estimate is 0: the same budget stays in the union (a residual).
    const cold = harness(MODEL);
    const c2 = createCoordinator({ platform: "linux" });
    const coldRuns = await Promise.all([
      c2.hook(cold.runtime)(req(["src/a.ts"])),
      c2.hook(cold.runtime)(req(["src/s.ts"], { deadline: liveDeadline(5_000) })),
    ]);
    expect(cold.calls.executes.map((e) => e.spec.inputs.length)).toEqual([2]);
    expect(coldRuns.map((r) => ran(r).exitCode)).toEqual([0, 0]);
    await Promise.all([c.dispose(), c2.dispose()]);
  });

  it("QA-2.2-23, B5.6: a short member's cut slot wait stays its own; the others take the slot in scopes of their own", async () => {
    const RUN_MS = 1_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    // The slot is taken by another check for longer than s can wait: an execute under a deadline
    // with less than 3 s left is cut while it waits for the slot.
    const inner = harness(MODEL, {
      execute: async (spec, deadline) => {
        if (deadline.remaining() < 3 * RUN_MS) return { kind: "slot-busy", waitedMs: deadline.remaining(), deadlineCut: true };
        await tick();
        return ranModel(MODEL, spec);
      },
    });
    // 2.1's scope (P4): a failed hold attempt answers every later call of the same scope at once.
    const runtime: BatchRuntime = {
      ...inner.runtime,
      openScope: (meta) => {
        const scope = inner.runtime.openScope(meta);
        let busy: ScopedOutcome | undefined;
        return {
          ...scope,
          execute: async (spec, deadline) => {
            if (busy !== undefined) return busy;
            const out = await scope.execute(spec, deadline);
            if (out.kind === "slot-busy") busy = out;
            return out;
          },
        };
      },
    };
    const c = createCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const warm = hook(req(["src/h.ts"]));
    await vi.advanceTimersByTimeAsync(RUN_MS);
    await warm;
    const outs = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"])), hook(req(["src/s.ts"], { deadline: liveDeadline(2_500) }))];
    await vi.advanceTimersByTimeAsync(RUN_MS);
    const runs = await Promise.all(outs);
    // s gets its own slot-busy, as alone; a and b run, as alone.
    expect(runs[2]?.scoped).toMatchObject({ kind: "slot-busy", deadlineCut: true });
    expect(runs.slice(0, 2).map((r) => ran(r).exitCode)).toEqual([0, 0]);
    expect(inner.calls.opens).toHaveLength(1 + 3);
    expect(c.stats()).toMatchObject({ unionRuns: 0, splits: 1 });
    await c.dispose();
  });

  it("QA-2.2-25, B5.2a: the union is priced at one run per member, and each member keeps one recheck per member ahead of it", async () => {
    const RUN_MS = 1_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    const setup = async () => {
      const h = harness(MODEL, {
        execute: async (spec) => {
          await tick();
          return ranModel(MODEL, spec);
        },
      });
      const c = createCoordinator({ platform: "linux" });
      const warm = c.hook(h.runtime)(req(["src/h.ts"]));
      await vi.advanceTimersByTimeAsync(RUN_MS);
      await warm;
      return { ...h, c, hook: c.hook(h.runtime) };
    };
    // e = 1 s, floor 2 s, two members: the first in deadline order needs 2 + (2 x 2 + 0) = 6 s,
    // the second 2 + (2 x 2 + 1) = 7 s. W7 closes the window as the second joins, with no wait.
    const fits = await setup();
    const both = [fits.hook(req(["src/a.ts"], { deadline: liveDeadline(6_000) })), fits.hook(req(["src/b.ts"], { deadline: liveDeadline(7_000) }))];
    await vi.advanceTimersByTimeAsync(2 * RUN_MS);
    await Promise.all(both);
    expect(fits.c.stats()).toMatchObject({ unionRuns: 1, splits: 0 });
    // 6.5 s for the second: enough without its place in the recheck queue (QA-2.2-26 M12), and
    // enough with the union priced as one run (1 + n + i: 5 s), but short of 7 s: the batch splits.
    const short = await setup();
    const split = [short.hook(req(["src/a.ts"], { deadline: liveDeadline(6_200) })), short.hook(req(["src/b.ts"], { deadline: liveDeadline(6_500) }))];
    await vi.advanceTimersByTimeAsync(2 * RUN_MS);
    await Promise.all(split);
    expect(short.c.stats()).toMatchObject({ unionRuns: 0, ownRuns: 3, splits: 1 });
    await Promise.all([fits.c.dispose(), short.c.dispose()]);
  });

  it("QA-2.2-25: union planning and the union's slot wait end where the pooled schedule stops fitting; then the members run alone", async () => {
    const RUN_MS = 1_000;
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, RUN_MS));
    const unionPlanBounds: number[] = [];
    const holdBounds: number[] = [];
    const inner = harness(MODEL, {
      execute: async (spec) => {
        await tick();
        return ranModel(MODEL, spec);
      },
      plan: async (input, deadline) => {
        if (input.changedFiles !== "unavailable" && input.changedFiles.length > 1) unionPlanBounds.push(deadline.remaining());
        return planModel(input);
      },
    });
    // 2.1's hold (P4): another check keeps the slot, so the wait runs to its bound, then fails.
    let slotFree = true;
    const runtime: BatchRuntime = {
      ...inner.runtime,
      openScope: (meta) => ({
        ...inner.runtime.openScope(meta),
        hold: async (deadline) => {
          holdBounds.push(deadline.remaining());
          if (slotFree) return true;
          await new Promise<void>((resolve) => setTimeout(resolve, deadline.bound(60_000)));
          return false;
        },
      }),
    };
    const c = createCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const warm = hook(req(["src/h.ts"]));
    await vi.advanceTimersByTimeAsync(RUN_MS);
    await warm;
    // e = 1 s, floor 2 s, two members with 20 s: the second in deadline order needs 7 s, so the
    // batch may spend 13 s on planning and on the slot wait.
    slotFree = false;
    const outs = [hook(req(["src/a.ts"], { deadline: liveDeadline(20_000) })), hook(req(["src/b.ts"], { deadline: liveDeadline(20_000) }))];
    await flush();
    expect(unionPlanBounds).toEqual([13_000]);
    expect(holdBounds).toEqual([13_000]);
    await vi.advanceTimersByTimeAsync(12_999);
    expect(inner.calls.executes).toHaveLength(1);
    // At 13 s the hold is given up: its scope closes unused, and each member runs in its own.
    await vi.advanceTimersByTimeAsync(1);
    expect(inner.calls.executes.map((e) => [e.scope, e.spec.inputs])).toEqual([
      [0, [at("src/h.ts")]],
      [2, [at("src/a.ts")]],
      [3, [at("src/b.ts")]],
    ]);
    expect(inner.calls.closes).toContain(1);
    await vi.advanceTimersByTimeAsync(RUN_MS);
    expect((await Promise.all(outs)).map((r) => ran(r).exitCode)).toEqual([0, 0]);
    expect(c.stats()).toMatchObject({ unionRuns: 0, splits: 1 });
    await c.dispose();
  });

  it("QA-2.2-25: a union plan or a hold that overruns its bound is checked again, and the batch splits", async () => {
    const RUN_MS = 1_000;
    const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    // e = 1 s, floor 2 s, two members with 20 s: the pooled schedule fits for 13 s more.
    const run = async (slowPlan: boolean) => {
      const inner = harness(MODEL, {
        execute: async (spec) => {
          await tick(RUN_MS);
          return ranModel(MODEL, spec);
        },
        // A planner step that ignores its bound: the union plan takes 13.5 s.
        plan: async (input) => {
          if (slowPlan && input.changedFiles !== "unavailable" && input.changedFiles.length > 1) await tick(13_500);
          return planModel(input);
        },
      });
      const runtime: BatchRuntime = {
        ...inner.runtime,
        // The slow plan's scope has no hold (the union's execute would take it); the other's hold
        // is granted after 13.5 s, past its bound.
        openScope: (meta) =>
          slowPlan
            ? inner.runtime.openScope(meta)
            : {
                ...inner.runtime.openScope(meta),
                hold: async () => {
                  await tick(13_500);
                  return true;
                },
              },
      };
      const c = createCoordinator({ platform: "linux" });
      const hook = c.hook(runtime);
      const warm = hook(req(["src/h.ts"]));
      await vi.advanceTimersByTimeAsync(RUN_MS);
      await warm;
      const outs = [hook(req(["src/a.ts"], { deadline: liveDeadline(20_000) })), hook(req(["src/b.ts"], { deadline: liveDeadline(20_000) }))];
      await vi.advanceTimersByTimeAsync(13_500 + RUN_MS);
      expect((await Promise.all(outs)).map((r) => ran(r).notes), `slow ${slowPlan ? "plan" : "hold"}`).toEqual([["planned 1 input(s)"], ["planned 1 input(s)"]]);
      expect(c.stats(), `slow ${slowPlan ? "plan" : "hold"}`).toMatchObject({ unionRuns: 0, ownRuns: 3, splits: 1 });
      await c.dispose();
      return inner.calls;
    };
    await run(true);
    // The held scope is closed (its slot released) before the members' own scopes run.
    const calls = await run(false);
    expect(calls.executes.map((e) => e.scope)).toEqual([0, 2, 3]);
    expect(calls.closes).toContain(1);
  });

  it("a maximum size that is not a safe integer >= 1 means no batching", async () => {
    for (const maxBatchSize of [0, 1.5, Number.NaN]) {
      const { calls, runtime } = harness();
      const c = createBatchCoordinator({ platform: "linux", maxBatchSize });
      const hook = c.hook(runtime);
      await Promise.all([hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))]);
      expect(calls.opens).toHaveLength(2);
      expect(calls.executes.map((e) => e.spec.inputs.length)).toEqual([1, 1]);
      expect(vi.getTimerCount()).toBe(0);
      await c.dispose();
    }
  });

  it("an abort while waiting in the window settles at once; a window left empty clears its timer", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const pa = hook(a);
    const pb = hook(req(["src/b.ts"]));
    await flush();
    a.deadline.abort();
    expect(await pa).toEqual(aborted(BATCH_REASONS.window));
    expect(c.stats().pendingRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await pb).exitCode).toBe(0);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/b.ts")]]);

    const x = req(["src/c.ts"]);
    const px = hook(x);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    x.deadline.abort();
    expect(await px).toEqual(aborted(BATCH_REASONS.window));
    expect(vi.getTimerCount()).toBe(0);
    expect(c.stats()).toMatchObject({ openWindows: 0, pendingRequests: 0 });
    await c.dispose();
  });

  it("a requester whose deadline expires mid-batch gets aborted labelled with the phase; the batch continues", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(MODEL, {
      execute: async (spec) => {
        await gate.promise;
        return ranModel(MODEL, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    // a's budget covers its floor (W3: recheck threshold + margin), so it waits in the window.
    const a = req(["src/a.ts"], { deadline: liveDeadline(3_000) });
    const b = req(["src/b.ts"], { deadline: liveDeadline(9_000) });
    const pa = hook(a);
    const pb = hook(b);
    await vi.advanceTimersByTimeAsync(WINDOW);
    const union = calls.executes[0];
    expect(union?.deadline.remaining()).toBe(8_900);

    await vi.advanceTimersByTimeAsync(2_900);
    expect(a.deadline.remaining()).toBe(0);
    a.deadline.abort();
    expect(await pa).toEqual(aborted(BATCH_REASONS.run));
    expect(union?.deadline.signal.aborted).toBe(false);
    expect(union?.deadline.remaining()).toBe(6_000);

    gate.resolve();
    expect(ran(await pb)).toMatchObject({ exitCode: 0, spec: { inputs: [at("src/b.ts")] } });
    expect(calls.executes).toHaveLength(1);
    await c.dispose();
  });

  it("when every member aborts, the union's signal aborts (the tree is killed) and nothing is spawned afterwards", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(false);
    b.deadline.abort();
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.run), aborted(BATCH_REASONS.run)]);
    await flush();
    expect(calls.executes).toHaveLength(1);
    expect(calls.closes).toEqual([0]);
    expect(c.stats()).toMatchObject({ runningBatches: 0, pendingRequests: 0, ownRuns: 0 });
  });

  it("dispose settles waiting and running members, kills the runs, leaves no timer and is idempotent", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const running = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const waiting = hook(req(["src/c.ts"]));
    const alone = hook(req(["src/d.ts"], { command: "npx jest" }));
    await vi.advanceTimersByTimeAsync(WINDOW / 2);
    const single = hook(req(["src/e.ts"], { command: "npx jest -i" }));
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 3, runningBatches: 1, pendingRequests: 5 });

    await c.dispose();
    const gone = aborted(BATCH_REASONS.disposed);
    expect(await Promise.all([...running, waiting, alone, single])).toEqual([gone, gone, gone, gone, gone]);
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.closes).toEqual([0]);
    await flush();
    expect(c.stats()).toMatchObject({ openWindows: 0, runningBatches: 0, pendingRequests: 0 });
    expect(await hook(req(["src/f.ts"]))).toEqual(gone);
    await c.dispose();
    expect(calls.executes).toHaveLength(1);
  });

  it("dispose kills a batch of one that runs under the member's own deadline", async () => {
    const { calls, runtime } = harness(MODEL, { execute: untilAborted });
    const c = createBatchCoordinator({ platform: "linux" });
    const out = c.hook(runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(false);
    await c.dispose();
    expect(await out).toEqual(aborted(BATCH_REASONS.disposed));
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    expect(calls.executes[0]?.deadline.remaining()).toBe(0);
  });

  it("the starvation bound: a steady stream cannot keep a window open past its fixed close", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const t0 = Date.now();
    const outs: Promise<TestsPassRun>[] = [];
    for (const x of "abcdef") {
      outs.push(hook(req([`src/${x}.ts`])));
      await vi.advanceTimersByTimeAsync(30);
    }
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    // a..d arrived at 0, 30, 60, 90: closed at 100. e opened the next window at 120; f joined at 150.
    expect(calls.executes.map((e) => [e.at - t0, e.spec.inputs.length])).toEqual([
      [100, 4],
      [220, 2],
    ]);
    await c.dispose();
  });

  it("a batch holds one scope: opened once, every run and recheck inside it, closed after the last", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["fails"] }, atRef: { "test/b.test.ts": [] } };
    const { calls, runtime } = harness(model);
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [..."abc"].map((x) => hook(req([`src/${x}.ts`])));
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    await flush();
    // QA-2.2-3: b's recheck runs as soon as b's outcome is final, before c's own run.
    expect(calls.events).toEqual(["open 0", "execute 0", "execute 0", "execute 0", "recheck 0", "execute 0", "close 0"]);
    await c.dispose();
  });

  it("a batch of one runs the member's own spec under the member's own deadline (the direct path)", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const a = req(["src/a.ts"], { deadline: liveDeadline(5_000) });
    const out = c.hook(runtime)(a);
    await vi.advanceTimersByTimeAsync(WINDOW);
    const run = await out;
    expect(calls.plans).toHaveLength(1);
    expect(calls.executes[0]?.spec).toBe(calls.planned[0]);
    expect(calls.executes[0]?.deadline.remaining()).toBe(a.deadline.remaining());
    expect(calls.executes[0]?.deadline.bound(100)).toBe(100);
    expect(run).toEqual({ scoped: ranModel(MODEL, calls.executes[0]?.spec ?? spec()), recheck: undefined });
    expect(c.stats()).toMatchObject({ unionRuns: 0, ownRuns: 1 });
    await c.dispose();
  });

  it("an inconsistent union plan splits the batch into own runs, logged once", async () => {
    const union = (input: BatchPlanInput) => input.changedFiles !== "unavailable" && input.changedFiles.length > 1;
    const cases: [string, HarnessOptions][] = [
      ["a union-only S6", { argvCap: 1 }],
      [
        "a rejected union plan",
        {
          plan: async (input) => {
            if (union(input)) throw new Error("search failed");
            return planModel(input);
          },
        },
      ],
      ["a union with nothing to run", { plan: async (input) => (union(input) ? { noAffected: true, note: "none" } : planModel(input)) }],
      [
        "a union with other options",
        { plan: async (input) => planModel(union(input) ? { ...input, command: "npx vitest run --bail" } : input) },
      ],
      [
        "a union with other inputs",
        {
          plan: async (input) =>
            planModel(union(input) && input.changedFiles !== "unavailable" ? { ...input, changedFiles: input.changedFiles.slice(1) } : input),
        },
      ],
    ];
    for (const [what, o] of cases) {
      const { calls, runtime } = harness(MODEL, o);
      const warn = vi.fn();
      const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
      const hook = c.hook(runtime);
      const outs = [hook(req(["src/a.ts"])), hook(req(["src/b.ts"]))];
      await vi.advanceTimersByTimeAsync(WINDOW);
      const runs = await Promise.all(outs);
      expect(runs.map((r) => ran(r).spec?.inputs), what).toEqual([[at("src/a.ts")], [at("src/b.ts")]]);
      expect(runs.map((r) => ran(r).notes), what).toEqual([["planned 1 input(s)"], ["planned 1 input(s)"]]);
      // QA-2.2-23: each member runs alone, in a scope of its own, as its direct hook would.
      expect(calls.opens, what).toHaveLength(2);
      expect(c.stats(), what).toMatchObject({ unionRuns: 0, ownRuns: 2, splits: 1 });
      expect(warn, what).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0], what).toContain("split");
      await c.dispose();
    }
  });

  it("a busy slot reaches every member; a timed-out or failed union falls back to own runs", async () => {
    const busy: ScopedOutcome = { kind: "slot-busy", waitedMs: 30_000, deadlineCut: false };
    const b1 = harness(MODEL, { execute: () => busy });
    const c1 = createBatchCoordinator({ platform: "linux" });
    const outs1 = [c1.hook(b1.runtime)(req(["src/a.ts"])), c1.hook(b1.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(await Promise.all(outs1)).toEqual([
      { scoped: busy, recheck: undefined },
      { scoped: busy, recheck: undefined },
    ]);
    expect(b1.calls.executes).toHaveLength(1);

    for (const first of [{ kind: "timed-out", boundMs: 120_000 }, { kind: "error", reason: "spawn failed" }] as const) {
      const h = harness(MODEL, { execute: (spec, _d, n) => (n === 0 ? first : ranModel(MODEL, spec)) });
      const c = createBatchCoordinator({ platform: "linux" });
      const outs = [c.hook(h.runtime)(req(["src/a.ts"])), c.hook(h.runtime)(req(["src/b.ts"]))];
      await vi.advanceTimersByTimeAsync(WINDOW);
      const runs = await Promise.all(outs);
      expect(runs.map((r) => ran(r).spec?.inputs)).toEqual([[at("src/a.ts")], [at("src/b.ts")]]);
      expect(h.calls.executes).toHaveLength(3);
      expect(c.stats()).toMatchObject({ unionRuns: 1, ownRuns: 2 });
      await c.dispose();
    }
    await c1.dispose();
  });

  it("the union plan deduplicates overlapping change sets", async () => {
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const outs = [hook(req(["src/a.ts", "src/shared.ts"])), hook(req([at("src/shared.ts"), "src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    await Promise.all(outs);
    expect(calls.plans[2]?.changedFiles).toEqual([
      { path: at("src/a.ts"), status: "M" },
      { path: at("src/shared.ts"), status: "M" },
      { path: at("src/b.ts"), status: "M" },
    ]);
    expect(calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/a.ts"), at("src/b.ts"), at("src/shared.ts")]]);
    await c.dispose();
  });

  it("the hook never rejects when a seam throws", async () => {
    const boom = () => {
      throw new Error("boom");
    };
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });

    const planning = harness(MODEL, { plan: async () => boom() });
    expect(await c.hook(planning.runtime)(req(["src/a.ts"]))).toEqual({
      scoped: { kind: "error", reason: "scoped run planning failed: boom" },
      recheck: undefined,
    });

    const direct = harness(MODEL, { runtime: { batchWindowMs: 0, direct: async () => boom() } });
    expect(await c.hook(direct.runtime)(req(["src/a.ts"]))).toEqual({
      scoped: { kind: "error", reason: "verification coordinator failed: boom" },
      recheck: undefined,
    });

    const opening = harness(MODEL, { runtime: { openScope: boom } });
    const opened = [c.hook(opening.runtime)(req(["src/a.ts"])), c.hook(opening.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const failed = { scoped: { kind: "error", reason: "verification batch failed: boom" }, recheck: undefined };
    expect(await Promise.all(opened)).toEqual([failed, failed]);

    const executing = harness(MODEL, { execute: boom });
    const executed = [c.hook(executing.runtime)(req(["src/a.ts"])), c.hook(executing.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const spawnFailed = { scoped: { kind: "error", reason: "scoped run failed: boom" }, recheck: undefined };
    expect(await Promise.all(executed)).toEqual([spawnFailed, spawnFailed]);
    expect(executing.calls.executes).toHaveLength(3);

    const failing: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"] } };
    const rechecking = harness(failing, { rechecker: boom });
    const rechecked = c.hook(rechecking.runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect((await rechecked).recheck).toEqual({ kind: "unusable", cause: "error", reason: "recheck failed: boom" });

    const inner = harness();
    const closing = harness(MODEL, { runtime: { openScope: (meta) => ({ ...inner.runtime.openScope(meta), close: async () => boom() }) } });
    const closed = c.hook(closing.runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(ran(await closed).exitCode).toBe(0);
    await c.dispose();
    expect(warn).toHaveBeenCalledWith("verify batch: scope close failed", { error: "boom" });
  });

  it("sweep evicts a batch whose seam never returned once the grace period has passed", async () => {
    const { calls, runtime } = harness(MODEL, { execute: () => new Promise<ScopedOutcome>(() => undefined) });
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    b.deadline.abort();
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.run), aborted(BATCH_REASONS.run)]);
    expect(c.stats().runningBatches).toBe(1);
    expect(c.sweep()).toBe(0);
    await vi.advanceTimersByTimeAsync(BATCH_STALE_GRACE_MS + 1);
    expect(c.sweep()).toBe(1);
    expect(c.stats().runningBatches).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "verify batch: evicted a batch whose seam never returned; its scope closes, and its slot is released, once the seam exits",
      expect.objectContaining({ members: 2 }),
    );
    await c.dispose();
    expect(calls.closes).toEqual([0]);
  });

  it("QA-2.2-4: dispose releases the slot only once the killed tree has exited", async () => {
    const log: string[] = [];
    const { calls, runtime } = harness(MODEL, {
      execute: (_spec, deadline) =>
        new Promise<ScopedOutcome>((resolve) => {
          const exit = () => {
            log.push("tree exited");
            resolve({ kind: "aborted", reason: "tree killed" });
          };
          deadline.signal.addEventListener("abort", () => setTimeout(exit, 500), { once: true });
        }),
      close: () => log.push("slot released"),
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const outs = [c.hook(runtime)(req(["src/a.ts"])), c.hook(runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    let done = false;
    const disposing = c.dispose().then(() => {
      done = true;
    });
    const gone = aborted(BATCH_REASONS.disposed);
    expect(await Promise.all(outs)).toEqual([gone, gone]);
    expect(calls.executes[0]?.deadline.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.closes).toEqual([]);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await disposing;
    expect(log).toEqual(["tree exited", "slot released"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(c.stats().runningBatches).toBe(0);
  });

  it("QA-2.2-4: a seam that returns after its batch was evicted does not release the slot a second time", async () => {
    const late = deferred<ScopedOutcome>();
    const { calls, runtime } = harness(MODEL, { execute: () => late.promise });
    const c = createBatchCoordinator({ platform: "linux" });
    const members = [req(["src/a.ts"]), req(["src/b.ts"])];
    const outs = members.map((m) => c.hook(runtime)(m));
    await vi.advanceTimersByTimeAsync(WINDOW);
    for (const m of members) m.deadline.abort();
    await Promise.all(outs);
    await vi.advanceTimersByTimeAsync(BATCH_STALE_GRACE_MS + 1);
    expect(c.sweep()).toBe(1);
    await flush();
    expect(calls.closes).toEqual([0]);
    late.resolve({ kind: "aborted", reason: "tree killed" });
    await flush();
    expect(calls.closes).toEqual([0]);
    await c.dispose();
    expect(c.stats()).toMatchObject({ runningBatches: 0, pendingRequests: 0 });
  });

  it("dispose while a request is planning answers it disposed; a seam that throws a non-Error is reported; the platform defaults", async () => {
    const gate = deferred<void>();
    const planning = harness(MODEL, {
      plan: async (input) => {
        await gate.promise;
        return planModel(input);
      },
    });
    const c = createBatchCoordinator();
    const out = c.hook(planning.runtime)(req(["src/a.ts"]));
    await flush();
    await c.dispose();
    gate.resolve();
    expect(await out).toEqual(aborted(BATCH_REASONS.disposed));
    expect(planning.calls.opens).toHaveLength(0);

    const throwing = harness(MODEL, {
      execute: () => {
        // A seam may throw anything, not only an Error.
        throw "string failure";
      },
    });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const run = c2.hook(throwing.runtime)(req(["src/a.ts"]));
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(await run).toEqual({ scoped: { kind: "error", reason: "scoped run failed: string failure" }, recheck: undefined });
    await c2.dispose();
  });

  it("QA-2.2-4: dispose waits at most the grace period for a hung seam, then closes its scope and logs it", async () => {
    const { calls, runtime } = harness(MODEL, { execute: () => new Promise<ScopedOutcome>(() => undefined) });
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    const outs = [c.hook(runtime)(req(["src/a.ts"])), c.hook(runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    let done = false;
    const disposing = c.dispose().then(() => {
      done = true;
    });
    const gone = aborted(BATCH_REASONS.disposed);
    expect(await Promise.all(outs)).toEqual([gone, gone]);
    await vi.advanceTimersByTimeAsync(BATCH_STALE_GRACE_MS - 1);
    expect(done).toBe(false);
    expect(calls.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await disposing;
    expect(calls.closes).toEqual([0]);
    expect(warn).toHaveBeenCalledWith(
      "verify batch: evicted a batch whose seam never returned; its scope closes, and its slot is released, once the seam exits",
      expect.objectContaining({ members: 2 }),
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(c.stats().runningBatches).toBe(0);
  });

  it("QA-2.2-19: with a scope whose close waits for its hung seam, as 2.1's does, dispose still returns after one grace period", async () => {
    const hung = deferred<ScopedOutcome>();
    const inner = harness(MODEL, { execute: () => hung.promise });
    const released: string[] = [];
    const runtime: BatchRuntime = {
      ...inner.runtime,
      openScope: (meta) => {
        const scope = inner.runtime.openScope(meta);
        const inflight: Promise<ScopedOutcome>[] = [];
        return {
          ...scope,
          execute: (spec, deadline) => {
            const p = scope.execute(spec, deadline);
            inflight.push(p);
            return p;
          },
          // 2.1's close: the slot is released only once every tracked execute has returned.
          close: async () => {
            await Promise.allSettled(inflight);
            await scope.close();
            released.push("slot released");
          },
        };
      },
    };
    const warn = vi.fn();
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    const outs = [c.hook(runtime)(req(["src/a.ts"])), c.hook(runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    let done = false;
    const disposing = c.dispose().then(() => {
      done = true;
    });
    const gone = aborted(BATCH_REASONS.disposed);
    expect(await Promise.all(outs)).toEqual([gone, gone]);
    await vi.advanceTimersByTimeAsync(BATCH_STALE_GRACE_MS);
    expect(done).toBe(true);
    await disposing;
    // The slot is still held: the seam has not exited, and nothing else can run beside it.
    expect(released).toEqual([]);
    expect(warn).toHaveBeenCalledWith("verify batch: dispose stopped waiting for scope closes; each slot is released once its seam exits", { closes: 1 });
    expect(vi.getTimerCount()).toBe(0);
    hung.resolve({ kind: "aborted", reason: "tree killed" });
    await flush();
    expect(released).toEqual(["slot released"]);
    // A second dispose has nothing left to wait for.
    await expect(c.dispose()).resolves.toBeUndefined();
  });

  it("uses the injected timers and clock", async () => {
    let t = 1_000;
    const handles: (() => void)[] = [];
    const timers = {
      setTimeout: vi.fn((callback: () => void) => handles.push(callback)),
      clearTimeout: vi.fn(),
    };
    const { calls, runtime } = harness();
    const c = createBatchCoordinator({ platform: "linux", timers, now: () => t });
    const out = c.hook(runtime)(req(["src/a.ts"]));
    await flush();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), WINDOW);
    t += WINDOW;
    handles[0]?.();
    expect(ran(await out).exitCode).toBe(0);
    expect(timers.clearTimeout).toHaveBeenCalledWith(1);
    expect(calls.executes).toHaveLength(1);
    await c.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// createBatchCoordinator: B7 attribution, B7.5 taint, B8 shared recheck
// ---------------------------------------------------------------------------------------------

describe("createBatchCoordinator: attribution and rechecks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Submits one request per change set in one window and returns the settled runs. */
  async function batch(runtime: BatchRuntime, requests: readonly TestRequest[], options: Parameters<typeof createBatchCoordinator>[0] = {}) {
    const c = createBatchCoordinator({ platform: "linux", ...options });
    const hook = c.hook(runtime);
    const outs = requests.map((r) => hook(r));
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    await c.dispose();
    return { runs, stats: c.stats() };
  }

  const sharedFile = (file: string): Model => ({
    related: Object.fromEntries([..."abcd"].map((x) => [`src/${x}.ts`, [`test/${x}.test.ts`, file]])),
  });
  /** a and b share a pre-existing failure; only b's own run reproduces b's new failure, so a is held until then. */
  const heldModel: Model = {
    ...sharedFile("test/common.test.ts"),
    failing: { "test/common.test.ts": ["old"], "test/b.test.ts": ["new"] },
    atRef: { "test/common.test.ts": ["old"], "test/b.test.ts": [] },
  };
  /** A deadline that aborts itself at expiry, as the gate's withTimeout does. */
  function expiringDeadline(budgetMs: number): TestDeadline {
    const d = liveDeadline(budgetMs);
    const t = setTimeout(() => d.abort(), budgetMs);
    d.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
    return d;
  }
  /** A step that takes `ms` of (fake) time, or ends early with `killed` when its signal aborts. */
  function takes<T>(ms: number, deadline: Deadline, done: () => T, killed: T): Promise<T> {
    return new Promise<T>((resolve) => {
      const onAbort = () => {
        clearTimeout(t);
        resolve(killed);
      };
      const t = setTimeout(() => {
        deadline.signal.removeEventListener("abort", onAbort);
        resolve(done());
      }, ms);
      deadline.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  it("a union failure in one member's file fails only that member: 1 + n runs (mode B), outcomes as direct", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["breaks"] }, atRef: { "test/b.test.ts": [] } };
    const { calls, runtime } = harness(model);
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"]), req(["src/c.ts"])]);
    expect(calls.executes).toHaveLength(4);
    expect(calls.executes.slice(1).map((e) => e.spec)).toEqual(calls.planned.slice(0, 3));
    const own = calls.planned.slice(0, 3).map(specOf);
    expect(runs).toEqual([
      { scoped: ranModel(model, own[0] ?? spec()), recheck: undefined },
      { scoped: ranModel(model, own[1] ?? spec()), recheck: recheckModel(model, "npx vitest run", ROOT, [at("test/b.test.ts")]) },
      { scoped: ranModel(model, own[2] ?? spec()), recheck: undefined },
    ]);
    expect(ran(runs[1] ?? aborted("")).result.failingIds).toEqual(["test/b.test.ts > breaks"]);
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/b.test.ts")]]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 3, rechecks: 1, taints: 0, splits: 0 });
  });

  it("a failing file related to two members: both are rechecked, through one recheck the second reuses (B8.6)", async () => {
    const model: Model = { ...sharedFile("test/shared.test.ts"), failing: { "test/shared.test.ts": ["new"] }, atRef: { "test/shared.test.ts": [] } };
    const { calls, runtime } = harness({
      ...model,
      related: { ...model.related, "src/c.ts": ["test/c.test.ts"] },
    });
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"]), req(["src/c.ts"])]);
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/shared.test.ts")]]);
    const exact = {
      kind: "exact",
      result: { failingIds: [], failingFiles: [], collectionError: false, total: 2, complete: true, source: "report" },
      ranFiles: ["test/shared.test.ts"],
      absentFiles: [],
      notes: ["rechecked at the reference"],
    };
    // The first member's recheck is its own, verbatim; the second derives from it without a spawn.
    expect(runs.map((r) => r.recheck)).toEqual([recheckModel(model, "npx vitest run", ROOT, [at("test/shared.test.ts")]), exact, undefined]);
    expect(runs.map((r) => ran(r).result.failingIds)).toEqual([["test/shared.test.ts > new"], ["test/shared.test.ts > new"], []]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 3, rechecks: 1 });
  });

  it("a pre-existing failure shared by every member at one reference: a single recheck, all derive exact, one scope", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const { runs, stats } = await batch(runtime, [..."abcd"].map((x) => req([`src/${x}.ts`])));
    expect(calls.rechecks).toHaveLength(1);
    expect(runs[0]?.recheck).toEqual(recheckModel(model, "npx vitest run", ROOT, [at("test/common.test.ts")]));
    for (const run of runs.slice(1)) {
      expect(run.recheck).toEqual({
        kind: "exact",
        result: {
          failingIds: ["test/common.test.ts > old"],
          failingFiles: ["/tmp/omr-ref/test/common.test.ts"],
          collectionError: false,
          total: 2,
          complete: true,
          source: "report",
        },
        ranFiles: ["test/common.test.ts"],
        absentFiles: [],
        notes: ["rechecked at the reference"],
      });
    }
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 4, rechecks: 1 });
    expect(calls.events).toEqual(["open 0", "execute 0", "execute 0", "recheck 0", "execute 0", "execute 0", "execute 0", "close 0"]);
  });

  it("distinct references get one recheck each", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const other: DispatchReference = { ...REF, commit: "c2" };
    const { runs, stats } = await batch(runtime, [
      req(["src/a.ts"]),
      req(["src/b.ts"], { reference: { kind: "captured", reference: other } }),
      req(["src/c.ts"]),
    ]);
    expect(calls.rechecks.map((r) => r.reference.commit).sort()).toEqual(["c1", "c2"]);
    expect(runs.map((r) => r.recheck?.kind)).toEqual(["exact", "exact", "exact"]);
    expect(stats.rechecks).toBe(2);
  });

  it("a run-level unusable shared recheck splits into own rechecks; a reference-level one is shared", async () => {
    const model: Model = {
      ...MODEL,
      failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] },
      atRef: { "test/a.test.ts": [], "test/b.test.ts": ["y"] },
    };
    const collection: RecheckOutcome = { kind: "unusable", cause: "collection-error", reason: "setup failed at the reference" };
    const split = harness(model, {
      rechecker: (_ref, files, _d, n) => (n === 0 ? collection : recheckModel(model, "npx vitest run", ROOT, files)),
    });
    const warn = vi.fn();
    const one = await batch(split.runtime, [req(["src/a.ts"]), req(["src/b.ts"])], { logger: { warn } });
    expect(split.calls.rechecks.map((r) => r.files)).toEqual([[at("test/a.test.ts"), at("test/b.test.ts")], [at("test/a.test.ts")], [at("test/b.test.ts")]]);
    expect(one.runs.map((r) => r.recheck)).toEqual([
      recheckModel(model, "npx vitest run", ROOT, [at("test/a.test.ts")]),
      recheckModel(model, "npx vitest run", ROOT, [at("test/b.test.ts")]),
    ]);
    expect(one.stats.rechecks).toBe(3);
    expect(warn).toHaveBeenCalledWith("verify batch: a shared recheck split into own rechecks", { members: 2, shared: "unusable" });

    const vanished: RecheckOutcome = { kind: "unusable", cause: "reference-vanished", reason: "stash commit missing" };
    const shared = harness(model, { rechecker: () => vanished });
    const two = await batch(shared.runtime, [req(["src/a.ts"]), req(["src/b.ts"])]);
    expect(two.runs.map((r) => r.recheck)).toEqual([vanished, vanished]);
    expect(shared.calls.rechecks).toHaveLength(1);
  });

  it("a member below the recheck threshold gets skipped-deadline and leaves its group", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    // a arrives with enough for its floor (W3, B5.2a); the union run then uses up all but 950 ms.
    let left = 2_500;
    const short: TestDeadline = { ...liveDeadline(2_500), remaining: () => left, bound: (ms) => Math.min(ms, left) };
    const { calls, runtime } = harness(model, {
      execute: (spec, _deadline, n) => {
        if (n === 0) left = 950;
        return ranModel(model, spec);
      },
    });
    const { runs } = await batch(runtime, [req(["src/a.ts"], { deadline: short }), req(["src/b.ts"])]);
    expect(calls.executes[0]?.spec.inputs).toHaveLength(2);
    expect(runs[0]?.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 950 });
    expect(runs[1]?.recheck?.kind).toBe("exact");
    expect(calls.rechecks).toHaveLength(1);
    expect(calls.rechecks[0]?.deadline.remaining()).toBe(59_900);
  });

  it("reference disabled or none: decided without a recheck", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] } };
    const { calls, runtime } = harness(model);
    const { runs } = await batch(runtime, [
      req(["src/a.ts"], { reference: { kind: "disabled" } }),
      req(["src/b.ts"], { reference: { kind: "none", reason: "dispatch not tracked" } }),
    ]);
    expect(runs.map((r) => r.recheck)).toEqual([
      { kind: "disabled" },
      { kind: "unusable", cause: "no-reference", reason: "dispatch not tracked" },
    ]);
    expect(calls.rechecks).toHaveLength(0);
  });

  it("QA-2.2-2: failureRecheck off at the gate disables a captured reference, per request, as the direct hook does", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model);
    const off: BatchRuntime = { ...runtime, failureRecheck: false };
    const c = createBatchCoordinator({ platform: "linux" });
    // The window is opened by the gate with the setting on; the second gate has it off.
    const outs = [
      c.hook(runtime)(req(["src/a.ts"])),
      c.hook(off)(req(["src/b.ts"])),
      c.hook(off)(req(["src/c.ts"], { reference: { kind: "none", reason: "dispatch not tracked" } })),
    ];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(calls.executes[0]?.spec.inputs).toHaveLength(3);
    expect(runs.map((r) => r.recheck?.kind)).toEqual(["exact", "disabled", "disabled"]);
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/common.test.ts")]]);
    await c.dispose();

    // The opener off does not disable a member whose own gate has it on.
    const h = harness(model);
    const c2 = createBatchCoordinator({ platform: "linux" });
    const outs2 = [c2.hook({ ...h.runtime, failureRecheck: false })(req(["src/a.ts"])), c2.hook(h.runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect((await Promise.all(outs2)).map((r) => r.recheck?.kind)).toEqual(["disabled", "exact"]);
    await c2.dispose();
  });

  it("the flaky taint: a union failure that no own run reproduces makes every member incomplete", async () => {
    const flaky: Model = { ...MODEL, failing: { "test/a.test.ts": ["flaky"] } };
    const warn = vi.fn();
    const { calls, runtime } = harness(MODEL, { execute: (spec, _d, n) => ranModel(n === 0 ? flaky : MODEL, spec) });
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"])], { logger: { warn } });
    expect(calls.executes).toHaveLength(3);
    for (const run of runs) {
      expect(run.recheck).toBeUndefined();
      expect(ran(run).result).toMatchObject({
        failingIds: [],
        complete: false,
        note: "batched run failure not reproduced by any request's own run: test/a.test.ts > flaky",
      });
    }
    expect(stats.taints).toBe(1);
    expect(warn).toHaveBeenCalledWith("verify batch: a batched run failure was not reproduced by any request's own run", {
      ids: ["test/a.test.ts > flaky"],
    });
  });

  it("pytest: static attribution from the union's report, without a process", async () => {
    const model: Model = { failing: { "tests/test_b.py": ["test_x"] }, tests: { "tests/test_c.py": 0 } };
    const { calls, runtime } = harness(model);
    const requests = ["a", "b", "c"].map((x) => req([`tests/test_${x}.py`], { command: "pytest" }));
    const { runs, stats } = await batch(runtime, requests);
    expect(calls.executes).toHaveLength(1);
    const own = calls.planned.slice(0, 3).map(specOf);
    runs.forEach((run, i) => {
      const direct = runModel(model, own[i] ?? spec());
      const s = ran(run);
      expect(s.result).toMatchObject({
        failingIds: direct.failingIds,
        failingFiles: direct.failingFiles,
        total: direct.total,
        complete: direct.complete,
      });
      expect(s.result.note).toBe(direct.note);
      expect(s.notes).toEqual(["planned 1 input(s)", "batched: 1 run for 3 requests"]);
    });
    expect(runs.map((r) => ran(r).exitCode)).toEqual([0, 1, 5]);
    expect(runs.map((r) => r.recheck)).toEqual([undefined, { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" }, undefined]);
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 0, rechecks: 1, taints: 0 });

    // Without per-file counts, the members with no failure of their own confirm by running alone.
    const bare = harness({ ...model, counts: false });
    const without = await batch(bare.runtime, ["a", "b", "c"].map((x) => req([`tests/test_${x}.py`], { command: "pytest" })));
    expect(bare.calls.executes.map((e) => e.spec.inputs)).toEqual([
      [at("tests/test_a.py"), at("tests/test_b.py"), at("tests/test_c.py")],
      [at("tests/test_a.py")],
      [at("tests/test_c.py")],
    ]);
    expect(without.runs.map((r) => [ran(r).result.failingIds, ran(r).result.complete])).toEqual([
      [[], true],
      [["tests/test_b.py::test_x"], true],
      [[], false],
    ]);
  });

  it("QA-2.2-11 (a): a complete pytest union keeps every failing id for the taint, also one that names no input", async () => {
    const ghost = "tests/test_z.py::t_ghost";
    const { calls, runtime } = harness(MODEL, {
      execute: (spec, _d, n) => {
        const out = ranModel(MODEL, spec);
        if (n !== 0 || out.kind !== "ran") return out;
        return { ...out, exitCode: 1, result: { ...out.result, failingIds: [ghost], failingFiles: [at("tests/test_z.py")] } };
      },
    });
    const { runs, stats } = await batch(runtime, ["a", "b"].map((x) => req([`tests/test_${x}.py`], { command: "pytest" })));
    expect(calls.executes).toHaveLength(1);
    for (const run of runs) {
      expect(run.recheck).toBeUndefined();
      expect(ran(run).result).toMatchObject({ failingIds: [], complete: false, note: `batched run failure not reproduced by any request's own run: ${ghost}` });
    }
    expect(stats).toMatchObject({ unionRuns: 1, ownRuns: 0, taints: 1 });
  });

  it("a guard-sensitive member of a green union: derived from per-file counts, else a confirmation run", async () => {
    const withCounts = harness();
    const one = await batch(withCounts.runtime, [req(["test/a.test.ts"]), req(["src/b.ts"])]);
    expect(withCounts.calls.executes).toHaveLength(1);
    expect(ran(one.runs[0] ?? aborted("")).result).toMatchObject({ failingIds: [], complete: true, total: 2 });
    expect(ran(one.runs[1] ?? aborted("")).result).toMatchObject({ failingIds: [], complete: true, total: 4 });

    const bare = harness({ ...MODEL, counts: false });
    const two = await batch(bare.runtime, [req(["test/a.test.ts"]), req(["src/b.ts"])]);
    expect(bare.calls.executes.map((e) => e.spec.inputs)).toEqual([[at("src/b.ts"), at("test/a.test.ts")], [at("test/a.test.ts")]]);
    expect(two.runs.map((r) => ran(r).exitCode)).toEqual([0, 0]);
    expect(two.stats).toMatchObject({ unionRuns: 1, ownRuns: 1 });
  });

  it("an abort while queued for an own run settles with the attribution phase, and that run is never spawned", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"] }, atRef: { "test/a.test.ts": ["x"] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const b = req(["src/b.ts"]);
    const outs = [hook(a), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(2);
    b.deadline.abort();
    expect(await outs[1]).toEqual(aborted(BATCH_REASONS.attribution));
    gate.resolve();
    const run = await outs[0];
    expect(ran(run ?? aborted("")).result.failingIds).toEqual(["test/a.test.ts > x"]);
    expect(run?.recheck?.kind).toBe("exact");
    expect(calls.executes).toHaveLength(2);
    await c.dispose();
  });

  it("a member whose deadline ends during its own run settles with that run at once, as alone", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] }, atRef: { "test/b.test.ts": [] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const d = req(["src/d.ts"], { reference: { kind: "disabled" } });
    const outs = [hook(a), hook(req(["src/b.ts"])), hook(d)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    expect(calls.executes[1]?.deadline.signal.aborted).toBe(true);
    gate.resolve();
    const [ra, rb, rd] = await Promise.all(outs);
    expect(ra?.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 0 });
    expect(ran(ra ?? aborted("")).result.failingIds).toEqual(["test/a.test.ts > x"]);
    expect(rb?.recheck?.kind).toBe("exact");
    expect(rd).toMatchObject({ scoped: { kind: "ran", exitCode: 0 }, recheck: undefined });
    await c.dispose();

    // The same with a disabled reference reports its reference decision.
    const gate2 = deferred<void>();
    const h2 = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 1) await gate2.promise;
        return ranModel(model, spec);
      },
    });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const x = req(["src/a.ts"], { reference: { kind: "disabled" } });
    const outs2 = [c2.hook(h2.runtime)(x), c2.hook(h2.runtime)(req(["src/c.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    x.deadline.abort();
    gate2.resolve();
    expect((await outs2[0])?.recheck).toEqual({ kind: "disabled" });
    await Promise.all(outs2);
    await c2.dispose();
  });

  it("an abort while waiting for a shared recheck gets timed-out; when all abort, the recheck's signal aborts", async () => {
    // a holds its outcome until b's own run reproduces b's failure (B5.7); both are then ready together and share one recheck.
    const model = heldModel;
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      rechecker: async (_ref, files) => {
        await gate.promise;
        return recheckModel(model, "npx vitest run", ROOT, files);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const outs = [hook(a), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.rechecks).toHaveLength(1);
    a.deadline.abort();
    const ra = await outs[0];
    expect(ra?.recheck).toEqual({ kind: "timed-out", boundMs: 59_900 });
    expect(ra?.scoped.kind).toBe("ran");
    expect(calls.rechecks[0]?.deadline.signal.aborted).toBe(false);
    gate.resolve();
    expect((await outs[1])?.recheck?.kind).toBe("exact");
    await c.dispose();

    const killed = harness(model, {
      rechecker: (_ref, _files, deadline) =>
        new Promise<RecheckOutcome>((resolve) => {
          deadline.signal.addEventListener("abort", () => resolve({ kind: "timed-out", boundMs: 1 }), { once: true });
        }),
    });
    const c2 = createBatchCoordinator({ platform: "linux" });
    const members = [req(["src/a.ts"]), req(["src/b.ts"])];
    const outs2 = members.map((m) => c2.hook(killed.runtime)(m));
    await vi.advanceTimersByTimeAsync(WINDOW);
    for (const m of members) m.deadline.abort();
    expect((await Promise.all(outs2)).map((r) => r.recheck)).toEqual([
      { kind: "timed-out", boundMs: 59_900 },
      { kind: "timed-out", boundMs: 59_900 },
    ]);
    expect(killed.calls.rechecks[0]?.deadline.signal.aborted).toBe(true);
    await c2.dispose();
    expect(killed.calls.closes).toEqual([0]);
  });

  it("dispose during a shared recheck aborts it and settles every member", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const { calls, runtime } = harness(model, {
      rechecker: (_ref, _files, deadline) =>
        new Promise<RecheckOutcome>((resolve) => {
          deadline.signal.addEventListener("abort", () => resolve({ kind: "timed-out", boundMs: 1 }), { once: true });
        }),
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const outs = [c.hook(runtime)(req(["src/a.ts"])), c.hook(runtime)(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    await c.dispose();
    expect(await Promise.all(outs)).toEqual([aborted(BATCH_REASONS.disposed), aborted(BATCH_REASONS.disposed)]);
    expect(calls.rechecks[0]?.deadline.signal.aborted).toBe(true);
    expect(calls.closes).toEqual([0]);
  });

  it("QA-2.2-3, the plan case: a pre-existing failure shared by 5 requests under default-like budgets passes with the note, as alone", async () => {
    const RUN_MS = 15_000;
    const GATE_MS = 90_000;
    const model: Model = {
      related: Object.fromEntries([..."abcde"].map((x) => [`src/${x}.ts`, [`test/${x}.test.ts`, "test/common.test.ts"]])),
      failing: { "test/common.test.ts": ["old"] },
      atRef: { "test/common.test.ts": ["old"] },
    };
    const options = (): HarnessOptions => ({
      execute: (spec, deadline) => takes<ScopedOutcome>(RUN_MS, deadline, () => ranModel(model, spec), { kind: "aborted", reason: BATCH_REASONS.run }),
      rechecker: (_ref, files, deadline) =>
        takes<RecheckOutcome>(RUN_MS, deadline, () => recheckModel(model, "npx vitest run", ROOT, files), { kind: "timed-out", boundMs: RUN_MS }),
      runtime: { recheckMinRemainingMs: 10_000 },
    });

    // Alone, each request is one run and one recheck: 30 s of its 90 s, a pass with the note.
    const solo = harness(model, options());
    const cs = createBatchCoordinator({ platform: "linux" });
    const alone = cs.hook(solo.runtime)(req(["src/e.ts"], { deadline: expiringDeadline(GATE_MS) }));
    await vi.advanceTimersByTimeAsync(GATE_MS);
    expect(judgeStandIn(await alone)).toMatchObject({ verdict: "pass", preexisting: ["test/common.test.ts > old"] });
    await cs.dispose();

    // Batched: 1 union run + 5 own runs (mode B) + 1 recheck, 15 s each, under one hold.
    const { calls, runtime } = harness(model, options());
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const t0 = Date.now();
    const settledAt: number[] = [];
    const outs = [..."abcde"].map((x, i) =>
      hook(req([`src/${x}.ts`], { deadline: expiringDeadline(GATE_MS) })).then((r) => {
        settledAt[i] = Date.now() - t0;
        return r;
      }),
    );
    await vi.advanceTimersByTimeAsync(GATE_MS + WINDOW);
    const verdicts = (await Promise.all(outs)).map(judgeStandIn);
    // The first member no longer waits for every other member's own run: it rechecks right after its
    // own, and the later members reuse that recheck (one spawn). Before QA-2.2-3 every member held its
    // outcome until all 1 + 5 runs had ended (90.1 s) and was then aborted: 0 passes.
    expect(verdicts.slice(0, 3).map((v) => v.verdict)).toEqual(["pass", "pass", "pass"]);
    for (const v of verdicts.slice(0, 3)) expect(v.preexisting).toEqual(["test/common.test.ts > old"]);
    expect(settledAt.slice(0, 3)).toEqual([WINDOW + 3 * RUN_MS, WINDOW + 4 * RUN_MS, WINDOW + 5 * RUN_MS]);
    // The members whose own runs cannot fit in the 90 s any more are unverifiable, never a false pass.
    expect(verdicts.slice(3).map((v) => v.verdict)).toEqual(["unverifiable", "unverifiable"]);
    expect(calls.rechecks).toHaveLength(1);
    expect(calls.opens).toHaveLength(1);
    await c.dispose();
  });

  it("QA-2.2-3: own runs and rechecks interleave earliest deadline first; a reused recheck settles before the next run", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const pendingAtRun: number[] = [];
    const holder: { c?: ReturnType<typeof createBatchCoordinator> } = {};
    const { calls, runtime } = harness(model, {
      execute: (spec) => {
        pendingAtRun.push(holder.c?.stats().pendingRequests ?? -1);
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    holder.c = c;
    const hook = c.hook(runtime);
    const outs = [
      hook(req(["src/a.ts"], { deadline: liveDeadline(60_000) })),
      hook(req(["src/b.ts"], { deadline: liveDeadline(30_000) })),
      hook(req(["src/c.ts"], { deadline: liveDeadline(45_000) })),
    ];
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(calls.executes.slice(1).map((e) => e.spec.inputs)).toEqual([[at("src/b.ts")], [at("src/c.ts")], [at("src/a.ts")]]);
    expect(calls.events).toEqual(["open 0", "execute 0", "execute 0", "recheck 0", "execute 0", "execute 0", "close 0"]);
    // b settled (its recheck) before c's own run started; c settled (reuse) before a's.
    expect(pendingAtRun).toEqual([3, 3, 2, 1]);
    expect(runs.map((r) => r.recheck?.kind)).toEqual(["exact", "exact", "exact"]);
    await c.dispose();
  });

  it("QA-2.2-3: an abort while holding a known outcome settles with that outcome, made incomplete while a union failure is unexplained", async () => {
    const gate = deferred<void>();
    const { calls, runtime } = harness(heldModel, {
      execute: async (spec, _d, n) => {
        if (n === 2) await gate.promise;
        return ranModel(heldModel, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const outs = [hook(a), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(3);
    a.deadline.abort();
    const ra = await outs[0];
    expect(ra?.recheck).toEqual({ kind: "skipped-deadline", remainingMs: 0 });
    expect(ran(ra ?? aborted(""))).toMatchObject({
      result: {
        failingIds: ["test/common.test.ts > old"],
        complete: false,
        note: "batched run failure not reproduced by any request's own run: test/b.test.ts > new",
      },
    });
    expect(judgeStandIn(ra ?? aborted("")).verdict).toBe("unverifiable");
    gate.resolve();
    const rb = await outs[1];
    expect(ran(rb ?? aborted("")).result).toMatchObject({ complete: true, failingIds: ["test/b.test.ts > new", "test/common.test.ts > old"] });
    expect(rb?.recheck?.kind).toBe("exact");
    expect(c.stats().taints).toBe(0);
    await c.dispose();
  });

  it("QA-2.2-3: an abort while waiting for its recheck turn keeps its outcome, with skipped-deadline", async () => {
    const model: Model = { failing: { "tests/test_a.py": ["t"], "tests/test_b.py": ["u"] } };
    const gate = deferred<void>();
    const unsupported: RecheckOutcome = { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" };
    const { calls, runtime } = harness(model, {
      rechecker: async () => {
        await gate.promise;
        return unsupported;
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const b = req(["tests/test_b.py"], { command: "pytest", reference: { kind: "captured", reference: { ...REF, commit: "c2" } } });
    const outs = [hook(req(["tests/test_a.py"], { command: "pytest" })), hook(b)];
    await vi.advanceTimersByTimeAsync(WINDOW);
    expect(calls.executes).toHaveLength(1);
    expect(calls.rechecks).toHaveLength(1);
    b.deadline.abort();
    const rb = await outs[1];
    expect(rb).toMatchObject({ scoped: { kind: "ran", result: { failingIds: ["tests/test_b.py::u"], complete: true } }, recheck: { kind: "skipped-deadline", remainingMs: 0 } });
    gate.resolve();
    expect((await outs[0])?.recheck).toEqual(unsupported);
    expect(calls.rechecks).toHaveLength(1);
    await c.dispose();
  });

  it("QA-2.2-3 (c): pytest: a member that left during the union run does not taint the others", async () => {
    const model: Model = { failing: { "tests/test_c.py": ["t"] } };
    const gate = deferred<void>();
    const warn = vi.fn();
    const { runtime } = harness(model, {
      execute: async (spec) => {
        await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux", logger: { warn } });
    const hook = c.hook(runtime);
    const gone = req(["tests/test_c.py"], { command: "pytest" });
    const outs = ["a", "b"].map((x) => hook(req([`tests/test_${x}.py`], { command: "pytest" })));
    const pc = hook(gone);
    await vi.advanceTimersByTimeAsync(WINDOW);
    gone.deadline.abort();
    expect(await pc).toEqual(aborted(BATCH_REASONS.run));
    gate.resolve();
    for (const run of await Promise.all(outs)) {
      expect(ran(run).result).toMatchObject({ failingIds: [], complete: true, total: 2 });
      expect(judgeStandIn(run).verdict).toBe("pass");
    }
    expect(c.stats().taints).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    await c.dispose();
  });

  it("QA-2.2-3: mode B with a member that left during the union run: the others run their own specs, and its unreproduced failure taints them", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"] }, atRef: { "test/a.test.ts": [] } };
    const gate = deferred<void>();
    const { calls, runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 0) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const outs = [hook(a), hook(req(["src/b.ts"])), hook(req(["src/c.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    gate.resolve();
    const runs = await Promise.all(outs);
    expect(runs[0]).toEqual(aborted(BATCH_REASONS.run));
    // a's related failure is reproduced by no remaining own run: b and c cannot pass on the batch's word.
    expect(calls.executes.slice(1).map((e) => e.spec.inputs)).toEqual([[at("src/b.ts")], [at("src/c.ts")]]);
    for (const run of runs.slice(1)) expect(ran(run).result).toMatchObject({ failingIds: [], complete: false });
    expect(c.stats().taints).toBe(1);
    await c.dispose();
  });

  it("QA-2.2-3: a green member held for another member's failure settles incomplete, with no recheck, when it aborts", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["new"] }, atRef: { "test/b.test.ts": [] } };
    const gate = deferred<void>();
    const { runtime } = harness(model, {
      execute: async (spec, _d, n) => {
        if (n === 2) await gate.promise;
        return ranModel(model, spec);
      },
    });
    const c = createBatchCoordinator({ platform: "linux" });
    const hook = c.hook(runtime);
    const a = req(["src/a.ts"]);
    const outs = [hook(a), hook(req(["src/b.ts"]))];
    await vi.advanceTimersByTimeAsync(WINDOW);
    a.deadline.abort();
    expect(await outs[0]).toMatchObject({
      scoped: { kind: "ran", result: { failingIds: [], complete: false, note: "batched run failure not reproduced by any request's own run: test/b.test.ts > new" } },
      recheck: undefined,
    });
    gate.resolve();
    expect((await outs[1])?.recheck?.kind).toBe("exact");
    await c.dispose();
  });

  it("B8.6: a recorded recheck that does not cover a later member's files is not reused; that member rechecks its own", async () => {
    const model: Model = { ...MODEL, failing: { "test/a.test.ts": ["x"], "test/b.test.ts": ["y"] }, atRef: { "test/a.test.ts": [], "test/b.test.ts": ["y"] } };
    const { calls, runtime } = harness(model, { argvCap: 1 });
    const { runs, stats } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"])]);
    expect(stats).toMatchObject({ splits: 1, ownRuns: 2, rechecks: 2 });
    expect(calls.rechecks.map((r) => r.files)).toEqual([[at("test/a.test.ts")], [at("test/b.test.ts")]]);
    expect(runs.map((r) => judgeStandIn(r).verdict)).toEqual(["fail", "pass"]);
  });

  it("two members sharing one Deadline (one router_verify call): it stays attached until the last of them settles", async () => {
    const model: Model = { ...MODEL, failing: { "test/b.test.ts": ["y"] }, atRef: { "test/b.test.ts": ["y"] } };
    const { calls, runtime } = harness(model);
    const shared = liveDeadline();
    const { runs } = await batch(runtime, [req(["src/a.ts"], { deadline: shared }), req(["src/b.ts"], { deadline: shared })]);
    expect(runs.map((r) => r.recheck?.kind)).toEqual([undefined, "exact"]);
    expect(calls.rechecks[0]?.deadline.signal.aborted).toBe(false);
  });

  it("B8.6: only outcomes that hold for any member are reused; a deadline-bound one is not", async () => {
    const model: Model = { ...sharedFile("test/common.test.ts"), failing: { "test/common.test.ts": ["old"] }, atRef: { "test/common.test.ts": ["old"] } };
    const outcomes: RecheckOutcome[] = [
      { kind: "unusable", cause: "materialize-failed", reason: "aborted" },
      { kind: "approximate", inexactReasons: [{ cause: "dependency-drift", path: "" }] },
    ];
    const { calls, runtime } = harness(model, { rechecker: (_r, _f, _d, n) => outcomes[n] ?? { kind: "timed-out", boundMs: 1 } });
    const { runs } = await batch(runtime, [req(["src/a.ts"]), req(["src/b.ts"]), req(["src/c.ts"])]);
    // a's materialize-failed is not reused: b rechecks, and c reuses b's approximate.
    expect(runs.map((r) => r.recheck)).toEqual([outcomes[0], outcomes[1], outcomes[1]]);
    expect(calls.rechecks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// B12: the equivalence property. Batched verdicts equal solo verdicts over seeded random cases.
//
// QA-2.2-6: the fake runner writes real reports (vitest JSON; pytest junit with a pinned
// --rootdir, suffix-colliding paths such as tests/test_x.py and sub/tests/test_x.py, a module next
// to a package of the same name, and classes nested in the module) and parses them with the REAL
// readResult, so a parser mapping bug (QA-2.2-1) reaches the verdicts. Requests come from several
// cwds, about a third of the cases use win32 paths (case-folded keys, spellings in another case),
// `-t smoke` filters the tests now and at the reference, test counts differ per reference, and
// each case asserts one scope per batch and the B13 spawn bounds. The judge is a port of 2.1's
// judgeScoped rules (T5/T6), so a rejection is never collapsed into unverifiable.
// ---------------------------------------------------------------------------------------------

/** mulberry32: a small deterministic PRNG (as in test/unit/guards.test.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type VerdictKind = "pass" | "fail" | "unverifiable";

interface Verdict {
  readonly verdict: VerdictKind;
  readonly introduced: readonly string[];
  readonly preexisting: readonly string[];
  readonly unknown: readonly string[];
}

/** 2.1-T5's fileKeyOfId: the part before the earliest " > " or "::", else the id (QA-2.2-11). */
function fileKeyOfId(id: string): string {
  const gt = id.indexOf(" > ");
  const cc = id.indexOf("::");
  const cut = gt < 0 ? cc : cc < 0 ? gt : Math.min(gt, cc);
  return cut >= 0 ? id.slice(0, cut) : id;
}

/**
 * The verdict rules of 2.1's judgeScoped (origin/vrb/p21 deterministic.ts T5, T6), ported until
 * 2.2.3 plugs in the real function. Every exact classification follows T5.5, so an incomplete or
 * collection-error inventory with a proven introduced id is a rejection (R2i/R3 x X- = F r1).
 */
function judgeStandIn(run: TestsPassRun): Verdict {
  const bare = (verdict: VerdictKind): Verdict => ({ verdict, introduced: [], preexisting: [], unknown: [] });
  const s = run.scoped;
  if (s.kind === "no-affected") return bare("pass");
  if (s.kind !== "ran") return bare("unverifiable");
  const c = s.result;
  // T5.2 (R1) and T5.3 (R4, R3 without identities).
  if (c.failingIds.length === 0) return bare(c.complete && !c.collectionError ? "pass" : "unverifiable");
  // T5.4: no recheck, or a non-exact column.
  const rc = run.recheck;
  if (rc?.kind !== "exact") return bare("unverifiable");
  const introduced: string[] = [];
  const preexisting: string[] = [];
  const unknown: string[] = [];
  const r = rc.result;
  for (const x of c.failingIds) {
    const f = fileKeyOfId(x);
    if (rc.absentFiles.includes(f)) introduced.push(x);
    else if (!rc.ranFiles.includes(f)) unknown.push(x);
    else if (r?.failingIds.includes(x) === true) preexisting.push(x);
    else if (c.source === "report") introduced.push(x);
    else if (!(r?.failingIds.some((id) => fileKeyOfId(id) === f) ?? false)) introduced.push(x);
    else unknown.push(x);
  }
  // T5.6.
  const verdict: VerdictKind = introduced.length > 0 ? "fail" : unknown.length === 0 && c.complete && !c.collectionError ? "pass" : "unverifiable";
  return { verdict, introduced: introduced.sort(), preexisting: preexisting.sort(), unknown: unknown.sort() };
}

/**
 * 2.2.3: 2.1's real judgeScoped (baseline.ts, T5/T6) in the stand-in's shape: ok -> pass, else
 * unverifiable or fail, with the classification sets sorted (empty when nothing was classified).
 */
function judgeReal(run: TestsPassRun): Verdict {
  const j = judgeScoped(run.scoped, run.recheck);
  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();
  return {
    verdict: j.ok ? "pass" : j.unverifiable ? "unverifiable" : "fail",
    introduced: sorted(j.failures?.introduced),
    preexisting: sorted(j.failures?.preexisting),
    unknown: sorted(j.failures?.unknown),
  };
}

/** 2.1's one-request path over the same seams: plan, one scope, one run, one recheck of the failing files. */
async function directOver(rt: BatchRuntime, request: TestsPassRequest): Promise<TestsPassRun> {
  const plan = await rt.plan({ command: request.command, cwd: request.cwd, changedFiles: request.changedFiles }, request.deadline);
  if ("noAffected" in plan) return { scoped: { kind: "no-affected", note: plan.note }, recheck: undefined };
  if ("unverifiable" in plan) return { scoped: { kind: "unverifiable", code: plan.code, reason: plan.reason }, recheck: undefined };
  const scope = rt.openScope({ cwd: request.cwd, command: request.command });
  try {
    const scoped = await scope.execute(plan, request.deadline);
    if (scoped.kind !== "ran" || scoped.result.failingIds.length === 0 || scoped.result.failingFiles.length === 0) return { scoped, recheck: undefined };
    const ref = request.reference;
    // 2.1's createDirectTestsPassHook (origin/vrb/p21 deterministic.ts): the gate's setting wins over the capture.
    if (ref.kind === "disabled" || !rt.failureRecheck) return { scoped, recheck: { kind: "disabled" } };
    if (ref.kind === "none") return { scoped, recheck: { kind: "unusable", cause: "no-reference", reason: ref.reason } };
    const recheck = await scope.rechecker(request.command, request.cwd)(ref.reference, scoped.result.failingFiles, request.deadline);
    return { scoped, recheck };
  } finally {
    await scope.close();
  }
}

/** The paths of one case: posix, or win32 (case-insensitive keys). */
interface World {
  readonly platform: "linux" | "win32";
  readonly P: typeof posix;
  /** The vitest project: runner cwd and git root. */
  readonly root: string;
  /** The pytest project: runner cwd, git root and pinned --rootdir. */
  readonly py: string;
  readonly tmp: string;
  /** Where the fake rechecker's reference worktree lives. */
  readonly refRoot: string;
}

const LINUX: World = { platform: "linux", P: posix, root: "/r", py: "/p", tmp: "/tmp", refRoot: "/tmp/omr-ref" };
const WIN: World = { platform: "win32", P: win32, root: "C:\\r", py: "C:\\p", tmp: "C:\\Temp", refRoot: "C:\\Temp\\omr-ref" };
const REF_B: DispatchReference = { ...REF, commit: "c2", head: "h2" };

const VT = [..."abcdef"].map((x) => `test/${x}.test.ts`);
const VS = [..."abcdef"].map((x) => `src/${x}.ts`);
/** pytest test files: three share the dotted suffix "test_x", and tests/test_x.py sits next to the package tests/test_x/. */
const PT = ["tests/test_a.py", "tests/test_b.py", "tests/test_x.py", "sub/tests/test_x.py", "app/tests/test_x.py", "tests/test_x/test_y.py"];
const V_NAMES = ["t1", "t2", "smoke1"];
/**
 * "TestK::t2" is a test method of class TestK: junit classname "<module>.TestK", name "t2".
 * QA-2.2-11: parametrized names may contain " > " (pytest writes it as "&gt;" in the report).
 */
const P_NAMES = ["t1", "TestK::t2", "smoke1", "test_cmp[1 > 0]", "TestK::test_gt[a > b]"];

interface TestFile {
  readonly names: readonly string[];
  readonly failing: readonly string[];
}

interface PropertyModel {
  /** vitest source key -> its related test keys. A test file relates to itself. */
  readonly related: Readonly<Record<string, readonly string[]>>;
  /** Test key -> its tests now. */
  readonly now: Readonly<Record<string, TestFile>>;
  /** Reference commit -> test key -> its tests there (their number differs per reference); a missing key is absent there. */
  readonly refs: Readonly<Record<string, Readonly<Record<string, TestFile>>>>;
}

interface CaseRequest {
  readonly command: string;
  readonly cwd: string;
  readonly files: readonly string[] | "unavailable";
  readonly reference: TestsPassRequest["reference"];
  /** QA-2.2-2: the submitting gate's failureRecheck. */
  readonly failureRecheck: boolean;
}

interface PropertyCase {
  readonly world: World;
  readonly model: PropertyModel;
  readonly requests: readonly CaseRequest[];
  readonly flaky: boolean;
}

function genCase(seed: number): PropertyCase {
  const rnd = mulberry32(seed);
  const chance = (p: number) => rnd() < p;
  const pickFrom = <T,>(xs: readonly T[], fallback: T): T => xs[Math.floor(rnd() * xs.length)] ?? fallback;
  const world = chance(0.35) ? WIN : LINUX;
  const P = world.P;
  const related: Record<string, readonly string[]> = Object.fromEntries(VS.map((s) => [s, VT.filter(() => chance(0.35))]));
  const file = (pool: readonly string[]): TestFile => {
    const names = chance(0.15) ? [] : pool.filter(() => chance(0.7));
    return { names, failing: names.filter(() => chance(0.25)) };
  };
  const now: Record<string, TestFile> = Object.fromEntries([...VT.map((t) => [t, file(V_NAMES)]), ...PT.map((t) => [t, file(P_NAMES)])]);
  const refs: Record<string, Record<string, TestFile>> = {};
  for (const commit of [REF.commit, REF_B.commit]) {
    const at: Record<string, TestFile> = {};
    for (const [t, f] of Object.entries(now)) {
      if (chance(0.2)) continue; // absent at this reference
      // Per-reference counts: the file may hold fewer tests there, or none at all.
      const names = chance(0.15) ? [] : chance(0.3) ? f.names.filter(() => chance(0.5)) : f.names;
      at[t] = { names, failing: f.failing.filter((n) => names.includes(n) && chance(0.6)) };
    }
    refs[commit] = at;
  }
  const refStates: TestsPassRequest["reference"][] = [
    { kind: "captured", reference: REF },
    { kind: "captured", reference: REF },
    { kind: "captured", reference: REF_B },
    { kind: "none", reason: "no reference captured" },
    { kind: "disabled" },
  ];
  // win32: a request may spell a path in another case; the planner's realpath gives it back canonical.
  const spell = (p: string) => (world.platform === "win32" && chance(0.3) ? p.toUpperCase() : p);
  // Most requests of a case share their runner's command, so batches of several members are common.
  const pyCommand = pickFrom(["pytest", "pytest", "pytest -c pytest.ini", "pytest -c pytest.ini", "pytest -q"], "pytest");
  const vCommand = chance(0.25) ? "npx vitest run -t smoke" : "npx vitest run";
  const n = 1 + Math.floor(rnd() * 6);
  const requests: CaseRequest[] = [];
  for (let i = 0; i < n; i++) {
    const reference = pickFrom(refStates, { kind: "disabled" });
    const failureRecheck = !chance(0.15);
    if (chance(0.03)) {
      requests.push({ command: "npx vitest run", cwd: world.root, files: "unavailable", reference, failureRecheck });
      continue;
    }
    const count = Math.floor(rnd() * 4);
    if (chance(0.35)) {
      const cwd = chance(0.3) ? P.join(world.py, "tests") : world.py;
      const keys = [...new Set(Array.from({ length: count }, () => pickFrom(PT, "tests/test_a.py")))];
      const files = keys.map((k) => spell(P.relative(cwd, P.join(world.py, k))));
      // "-c pytest.ini": an explicit config gets no --rootdir pin (runner.ts D.4), so readResult maps classnames by suffix.
      const command = chance(0.8) ? pyCommand : pickFrom(["pytest", "pytest -q", "pytest -c pytest.ini"], "pytest");
      requests.push({ command, cwd, files, reference, failureRecheck });
    } else {
      const cwd = chance(0.3) ? P.join(world.root, "src") : world.root;
      const keys = [...new Set(Array.from({ length: count }, () => pickFrom([...VS, ...VT], "src/a.ts")))];
      const files = keys.map((k) => spell(P.relative(cwd, P.join(world.root, k))));
      if (chance(0.05)) files.push(P.relative(cwd, P.join(world.root, "src/untestable.ts")));
      const command = chance(0.8) ? vCommand : "npx vitest run";
      requests.push({ command, cwd, files, reference, failureRecheck });
    }
  }
  return { world, model: { related, now, refs }, requests, flaky: chance(0.15) };
}

function toRequest(c: CaseRequest): TestRequest {
  return c.files === "unavailable"
    ? req([], { command: c.command, cwd: c.cwd, changedFiles: "unavailable", reference: c.reference })
    : req(c.files, { command: c.command, cwd: c.cwd, reference: c.reference });
}

/** A test name filter for `-t <pattern>` (vitest), kept by the rerun as well. */
function nameFilter(words: readonly string[]): (name: string) => boolean {
  const i = words.indexOf("-t");
  const pattern = i >= 0 ? words[i + 1] : undefined;
  return pattern === undefined ? () => true : (name) => name.includes(pattern);
}

const slashKey = (w: World, from: string, abs: string) => w.P.relative(from, abs).replace(/\\/g, "/");

/**
 * planScopedRun over the model: canonical inputs (the realpath seam), a pinned --rootdir for pytest
 * unless the command names its config with -c (runner.ts D.4: the spawn reads it and its directory
 * is the rootdir), and a report path readResult accepts.
 */
function planCase(w: World, input: BatchPlanInput, n: number): ScopingPlan {
  if (input.changedFiles === "unavailable") return { unverifiable: true, code: "attribution-unavailable", reason: "no change attribution" };
  const P = w.P;
  const words = input.command.split(" ");
  const pytest = words.includes("pytest");
  const runnerCwd = pytest ? w.py : w.root;
  const known = pytest ? PT : [...VS, ...VT];
  const fold = (k: string) => (w.platform === "win32" ? k.toLowerCase() : k);
  const canonical = (abs: string) => {
    const k = slashKey(w, runnerCwd, abs);
    const hit = known.find((x) => fold(x) === fold(k));
    return hit === undefined ? abs : P.join(runnerCwd, hit);
  };
  const byKey = new Map<string, string>();
  for (const c of input.changedFiles) {
    const abs = canonical(P.resolve(input.cwd, c.path));
    byKey.set(fold(abs), abs);
  }
  const inputs = [...byKey.values()].sort();
  if (inputs.length === 0) return { noAffected: true, note: "no affected tests" };
  if (inputs.some((f) => f.includes("untestable"))) return { unverifiable: true, code: "config-changed", reason: "a config file changed" };
  const reportPath = P.join(w.tmp, `omr-verify-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.${pytest ? "xml" : "json"}`);
  const entry = pytest ? P.join(w.py, ".venv", "bin", "pytest") : P.join(w.root, "node_modules", "vitest", "vitest.mjs");
  const options = words.slice(pytest ? 1 : 3);
  return {
    runner: pytest ? "pytest" : "vitest",
    mode: "related",
    file: pytest ? entry : P.join(w.root, "node.exe"),
    args: pytest
      ? ["-p", "no:cacheprovider", `--junitxml=${reportPath}`, "--maxfail=0", ...options, ...(options.includes("-c") ? [] : [`--rootdir=${w.py}`]), "--", ...inputs]
      : [entry, "related", "--run", "--reporter=json", `--outputFile=${reportPath}`, ...options, ...inputs],
    cwd: runnerCwd,
    env: {},
    reportPath,
    gitRoot: runnerCwd,
    entry,
    inputs,
    inputsAreTests: pytest,
    workers: pytest ? null : 2,
    notes: [`planned ${inputs.length} input(s)`],
  };
}

/** vitest's jest-compatible JSON report of one spec over the model. */
function vitestReport(w: World, model: PropertyModel, spec: ScopedSpec, flaky: boolean): { text: string; code: number } {
  const keys = new Set<string>();
  for (const abs of spec.inputs) {
    const k = slashKey(w, spec.cwd, abs);
    if (isTestKey(k)) keys.add(k);
    for (const t of model.related[k] ?? []) keys.add(t);
  }
  const only = nameFilter(spec.args);
  const suites = [...keys].sort().map((k) => {
    const f = model.now[k] ?? { names: [], failing: [] };
    const failing = f.failing.filter(only);
    return {
      name: w.P.join(spec.cwd, k),
      status: failing.length > 0 ? "failed" : "passed",
      assertionResults: f.names.filter(only).map((title) => ({ title, ancestorTitles: [], status: failing.includes(title) ? "failed" : "passed" })),
    };
  });
  if (flaky) suites.push({ name: w.P.join(spec.cwd, "test/zz.test.ts"), status: "failed", assertionResults: [{ title: "flaky", ancestorTitles: [], status: "failed" }] });
  const total = suites.reduce((n, s) => n + s.assertionResults.length, 0);
  const failed = suites.some((s) => s.status === "failed");
  return { text: JSON.stringify({ numTotalTests: total, numRuntimeErrorTestSuites: 0, testResults: suites }), code: failed ? 1 : 0 };
}

/** pytest's junit XML of one spec over the model; classnames are rootdir-relative module paths, then class names. */
function pytestReport(w: World, model: PropertyModel, spec: ScopedSpec, flaky: boolean): { text: string; code: number } {
  const cases: string[] = [];
  let failed = false;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const testcase = (classname: string, name: string, fails: boolean) => {
    failed ||= fails;
    cases.push(`<testcase classname="${esc(classname)}" name="${esc(name)}" time="0.01">${fails ? '<failure message="assert">boom</failure>' : ""}</testcase>`);
  };
  for (const abs of spec.inputs) {
    const k = slashKey(w, w.py, abs);
    const module = k.replace(/\.py$/, "").split("/").join(".");
    const f = model.now[k] ?? { names: [], failing: [] };
    for (const n of f.names) {
      const parts = n.split("::");
      const name = parts.pop() ?? n;
      testcase([module, ...parts].join("."), name, f.failing.includes(n));
    }
    if (flaky && abs === spec.inputs[0]) testcase(module, "flaky", true);
  }
  return {
    text: `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest">${cases.join("")}</testsuite></testsuites>`,
    code: failed ? 1 : cases.length === 0 ? 5 : 0,
  };
}

/** 2.1's Rechecker over the model: pytest is runner-unsupported; vitest reruns the files present at the reference, with the same -t. */
function recheckCase(w: World, model: PropertyModel, command: string, reference: DispatchReference, files: readonly string[]): RecheckOutcome {
  const words = command.split(" ");
  if (words.includes("pytest")) return { kind: "unusable", cause: "runner-unsupported", reason: "pytest imports the live tree" };
  const at = model.refs[reference.commit] ?? {};
  const only = nameFilter(words);
  const keys = [...new Set(files.map((f) => slashKey(w, w.root, f)))].sort();
  const ranFiles = keys.filter((k) => at[k] !== undefined);
  const absentFiles = keys.filter((k) => at[k] === undefined);
  if (ranFiles.length === 0) return { kind: "exact", result: undefined, ranFiles, absentFiles, notes: [] };
  const testsByFile: Record<string, number> = Object.fromEntries(ranFiles.map((k) => [k, (at[k]?.names ?? []).filter(only).length]));
  const total = ranFiles.reduce((n, k) => n + (testsByFile[k] ?? 0), 0);
  // T4.k: readResult's rerun zero-test guard makes the rerun incomplete.
  if (total === 0) return { kind: "unusable", cause: "incomplete", reason: "rerun ran no tests although every input is a test file" };
  const failingIds = ranFiles.flatMap((k) => (at[k]?.failing ?? []).filter(only).map((n) => `${k} > ${n}`)).sort();
  const failingFiles = [...new Set(failingIds.map(fileKeyOfId))].map((k) => w.P.join(w.refRoot, k)).sort();
  return {
    kind: "exact",
    result: { failingIds, failingFiles, collectionError: false, total, complete: true, source: "report", testsByFile },
    ranFiles,
    absentFiles,
    notes: [],
  };
}

interface PropertyCalls {
  readonly opens: number[];
  readonly closes: number[];
  readonly executes: { readonly scope: number; readonly spec: ScopedSpec; out?: ScopedOutcome }[];
  readonly rechecks: { readonly scope: number; readonly command: string; readonly files: readonly string[] }[];
}

/** The runtime of one case: every execute goes through the real readResult; `flaky` injects a failure into the first execute. */
function propertySeams(pc: PropertyCase, flaky: boolean) {
  const w = pc.world;
  const calls: PropertyCalls = { opens: [], closes: [], executes: [], rechecks: [] };
  let reports = 0;
  const plan: BatchPlanner = async (input) => planCase(w, input, reports++);
  const openScope: OpenVerificationScope = () => {
    const id = calls.opens.push(calls.opens.length) - 1;
    let closed = false;
    return {
      execute: async (spec) => {
        if (closed) throw new Error("execute after close");
        const entry: PropertyCalls["executes"][number] = { scope: id, spec };
        const inject = flaky && calls.executes.length === 0;
        calls.executes.push(entry);
        const report = spec.runner === "pytest" ? pytestReport(w, pc.model, spec, inject) : vitestReport(w, pc.model, spec, inject);
        const fs = {
          fileExists: async (p: string) => p === spec.reportPath,
          readFile: async (p: string) => {
            if (p !== spec.reportPath) throw new Error(`ENOENT ${p}`);
            return report.text;
          },
          unlink: async () => undefined,
        };
        const result = await readResult(spec, { code: report.code, stdout: "", stderr: "" }, fs, { platform: w.platform, tmpdir: w.tmp });
        const out: ScopedOutcome = { kind: "ran", result, exitCode: report.code, spec, notes: [...spec.notes, ...(result.note !== undefined ? [result.note] : [])] };
        entry.out = out;
        return out;
      },
      rechecker: (command) => async (reference, files) => {
        if (closed) throw new Error("recheck after close");
        calls.rechecks.push({ scope: id, command, files });
        return recheckCase(w, pc.model, command, reference, files);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        calls.closes.push(id);
      },
    };
  };
  const direct: TestsPassHook = async () => {
    throw new Error("the property never bypasses to the direct hook");
  };
  const runtime: BatchRuntime = { direct, plan, openScope, batchWindowMs: WINDOW, recheckMinRemainingMs: 1_000, failureRecheck: true };
  return { calls, runtime };
}

const PROPERTY_CASES = 300;
const PROPERTY_CHUNK = 50;
const PROPERTY_SEED = 0x2b12;
/** What the property cases exercised, so a vacuous generator cannot pass silently. */
const propertyTally = {
  pass: 0,
  fail: 0,
  unverifiable: 0,
  sharedRuns: 0,
  flakyMembers: 0,
  win32Batches: 0,
  multiCwdBatches: 0,
  suffixUnions: 0,
  unpinnedSuffixUnions: 0,
  filteredBatches: 0,
  reusedRechecks: 0,
  /** QA-2.2-11: pytest unions of several members with a failing name that contains " > ". */
  gtNameUnions: 0,
};

describe("createBatchCoordinator: B12 batched verdicts equal solo verdicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * One seeded case. `judge` is the stand-in oracle, or (2.2.3) 2.1's real judgeScoped: with the
   * real judge, every solo and batched run is also judged by the stand-in, and both must agree.
   */
  async function runCase(seed: number, judge: (run: TestsPassRun) => Verdict = judgeStandIn): Promise<void> {
    const pc = genCase(seed);
    const w = pc.world;
    const agree = (run: TestsPassRun, what: string): void => {
      if (judge !== judgeStandIn) expect(judgeStandIn(run), `seed ${seed}: the stand-in disagrees with judgeScoped (${what})`).toEqual(judge(run));
    };

    // Solo: every request alone, through 2.1's one-request path.
    const solo = propertySeams(pc, false);
    const soloVerdicts: Verdict[] = [];
    for (const cr of pc.requests) {
      const run = await directOver({ ...solo.runtime, failureRecheck: cr.failureRecheck }, toRequest(cr));
      agree(run, `solo ${JSON.stringify(cr)}`);
      soloVerdicts.push(judge(run));
    }
    expect(solo.calls.closes.length, `seed ${seed}: solo scopes closed`).toBe(solo.calls.opens.length);

    // Batched: every request in one window, each through its own gate's hook.
    const batched = propertySeams(pc, pc.flaky);
    const c = createBatchCoordinator({ platform: w.platform });
    const outs = pc.requests.map((cr) => c.hook({ ...batched.runtime, failureRecheck: cr.failureRecheck })(toRequest(cr)));
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    await c.dispose();
    const where = (i: number) => `seed ${seed} (${w.platform}), request ${i}: ${JSON.stringify(pc.requests[i])}`;
    expect(batched.calls.closes.length, `seed ${seed}: batched scopes closed`).toBe(batched.calls.opens.length);
    expect(vi.getTimerCount(), `seed ${seed}: leaked timers`).toBe(0);
    expect(c.stats().splits, `seed ${seed}: the model never splits`).toBe(0);
    if (batched.calls.executes.length < solo.calls.executes.length) propertyTally.sharedRuns++;

    // The batches: the requests whose own plan is a spec, grouped by batch key, in arrival order.
    const batches = new Map<string, { readonly i: number; readonly spec: ScopedSpec }[]>();
    pc.requests.forEach((cr, i) => {
      if (cr.files === "unavailable") return;
      const plan = planCase(w, { command: cr.command, cwd: cr.cwd, changedFiles: cr.files.map((path) => ({ path, status: "M" })) }, 0);
      if ("noAffected" in plan || "unverifiable" in plan) return;
      const key = batchKey(plan, w.platform);
      batches.set(key, [...(batches.get(key) ?? []), { i, spec: plan }]);
    });
    // Exactly one scope per batch, and every run of a scope belongs to its batch.
    expect(batched.calls.opens.length, `seed ${seed}: one scope per batch`).toBe(batches.size);
    const scopeOf = new Map<string, number>();
    for (const e of batched.calls.executes) {
      const key = batchKey(e.spec, w.platform);
      expect(scopeOf.get(key) ?? e.scope, `seed ${seed}: a batch used two scopes`).toBe(e.scope);
      scopeOf.set(key, e.scope);
    }
    expect(scopeOf.size, `seed ${seed}: every batch ran under its own scope`).toBe(batches.size);

    // B13 spawn bounds, per batch.
    let flakyKey: string | undefined;
    for (const [key, members] of batches) {
      const scope = scopeOf.get(key);
      const executes = batched.calls.executes.filter((e) => e.scope === scope);
      const rechecks = batched.calls.rechecks.filter((r) => r.scope === scope);
      const n = members.length;
      const pytest = members[0]?.spec.runner === "pytest";
      const at = `seed ${seed}, batch ${key}`;
      if (pc.flaky && batched.calls.executes[0]?.scope === scope) flakyKey = key;
      if (w.platform === "win32") propertyTally.win32Batches++;
      if (new Set(members.map((m) => pc.requests[m.i]?.cwd)).size > 1) propertyTally.multiCwdBatches++;
      if (members.some((m) => m.spec.args.includes("-t"))) propertyTally.filteredBatches++;
      const referenceKeys = new Set(
        members.flatMap((m) => {
          const ref = pc.requests[m.i]?.reference;
          return ref?.kind === "captured" ? [referenceKey(ref.reference)] : [];
        }),
      );
      expect(rechecks.length, `${at}: rechecks`).toBeLessThanOrEqual(n + referenceKeys.size);
      if (n === 1) {
        expect(executes.map((e) => e.spec.inputs), `${at}: a batch of one is the direct path`).toEqual([members[0]?.spec.inputs]);
        continue;
      }
      const union = executes[0];
      const want = new Set(members.flatMap((m) => m.spec.inputs.map((f) => (w.platform === "win32" ? f.toLowerCase() : f))));
      expect(new Set(union?.spec.inputs.map((f) => (w.platform === "win32" ? f.toLowerCase() : f))), `${at}: the union's inputs`).toEqual(want);
      if (pytest && ["tests/test_x.py", "sub/tests/test_x.py", "app/tests/test_x.py"].filter((k) => union?.spec.inputs.includes(w.P.join(w.py, k))).length > 1) {
        propertyTally.suffixUnions++;
        if (union?.spec.args.includes("-c") === true) propertyTally.unpinnedSuffixUnions++;
      }
      const u = union?.out;
      if (pytest && u?.kind === "ran" && u.result.failingIds.some((id) => id.includes(" > "))) propertyTally.gtNameUnions++;
      const comparable = u?.kind === "ran" && u.result.complete && !u.result.collectionError && u.result.source === "report";
      if (!comparable) expect(executes.length, `${at}: not comparable -> 1 + n`).toBe(1 + n);
      else if (pytest) expect(executes.length, `${at}: pytest attributes statically`).toBe(1);
      else if (u.result.failingIds.length > 0) expect(executes.length, `${at}: mode B`).toBe(1 + n);
      else {
        const ambiguous = members.filter((m) => isGuardSensitive(m.spec, w.platform)).length;
        expect(executes.length, `${at}: a green union`).toBeLessThanOrEqual(1 + ambiguous);
        expect(rechecks.length, `${at}: a green union rechecks nothing`).toBe(0);
      }
    }
    const answered = runs.filter((r) => r.recheck !== undefined && ["exact", "unusable", "approximate"].includes(r.recheck.kind)).length;
    if (answered > batched.calls.rechecks.length) propertyTally.reusedRechecks++;

    runs.forEach((run, i) => {
      agree(run, `batched ${where(i)}`);
      const got = judge(run);
      propertyTally[got.verdict]++;
      const soloVerdict = soloVerdicts[i];
      const cr = pc.requests[i];
      // B-G2 (never a false pass), on every case.
      if (got.verdict === "pass" && soloVerdict?.verdict !== "pass") throw new Error(`false pass (${where(i)}): solo ${JSON.stringify(soloVerdict)}`);
      if (flakyKey !== undefined && cr !== undefined && cr.files !== "unavailable") {
        const plan = planCase(w, { command: cr.command, cwd: cr.cwd, changedFiles: cr.files.map((path) => ({ path, status: "M" })) }, 0);
        if (!("noAffected" in plan) && !("unverifiable" in plan) && batchKey(plan, w.platform) === flakyKey) {
          propertyTally.flakyMembers++;
          // vitest: every member runs its own spec, and the unreproduced union failure taints them all.
          if (plan.runner !== "pytest") expect(got.verdict, `${where(i)}: a member of the flaky batch judged ok`).not.toBe("pass");
          return;
        }
      }
      expect(got, where(i)).toEqual(soloVerdict);
    });
  }

  for (let start = 0; start < PROPERTY_CASES; start += PROPERTY_CHUNK) {
    it(`seeds ${start}..${start + PROPERTY_CHUNK - 1}`, async () => {
      for (let i = start; i < start + PROPERTY_CHUNK; i++) await runCase(PROPERTY_SEED + i);
    }, 30_000);
  }

  // 2.2.3.b: the same property judged by 2.1's real judgeScoped (B12: "both must agree").
  for (let start = 0; start < PROPERTY_CASES; start += PROPERTY_CHUNK) {
    it(`seeds ${start}..${start + PROPERTY_CHUNK - 1}, judged by 2.1's judgeScoped`, async () => {
      for (let i = start; i < start + PROPERTY_CHUNK; i++) await runCase(PROPERTY_SEED + i, judgeReal);
    }, 30_000);
  }

  it("an unpinned pytest union whose classname is ambiguous runs own specs and taints no one (found by the property)", async () => {
    const t1 = { names: ["t1"], failing: [] };
    const pc: PropertyCase = {
      world: LINUX,
      model: {
        related: {},
        now: { "tests/test_x.py": { names: ["t1"], failing: ["t1"] }, "sub/tests/test_x.py": t1, "tests/test_a.py": t1 },
        refs: {},
      },
      requests: ["tests/test_x.py", "sub/tests/test_x.py", "tests/test_a.py"].map((f) => ({
        command: "pytest -c pytest.ini",
        cwd: LINUX.py,
        files: [f],
        reference: { kind: "captured", reference: REF },
        failureRecheck: true,
      })),
      flaky: false,
    };
    const { calls, runtime } = propertySeams(pc, false);
    const c = createBatchCoordinator({ platform: "linux" });
    const outs = pc.requests.map((cr) => c.hook(runtime)(toRequest(cr)));
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    // Without a pinned rootdir "tests.test_x" names tests/test_x.py and sub/tests/test_x.py alike.
    expect(calls.executes[0]?.out).toMatchObject({ result: { failingIds: ["tests.test_x::t1"], complete: false } });
    expect(calls.executes).toHaveLength(4);
    expect(runs.map((r) => judgeStandIn(r).verdict)).toEqual(["unverifiable", "pass", "pass"]);
    expect(ran(runs[0] ?? aborted(""))).toMatchObject({ result: { failingIds: ["tests/test_x.py::t1"], complete: true } });
    expect(c.stats().taints).toBe(0);
    await c.dispose();
  });

  it("QA-2.2-11: a pytest failure whose name contains \" > \" is charged to its file through the real readResult; batched is never a pass where solo is unverifiable", async () => {
    const pc: PropertyCase = {
      world: LINUX,
      model: {
        related: {},
        // parametrize('expr', ['1 > 0']): pytest 9.0.2 writes classname="tests.test_x" name="test_cmp[1 &gt; 0]".
        now: { "tests/test_x.py": { names: ["test_cmp[1 > 0]", "t1"], failing: ["test_cmp[1 > 0]"] }, "tests/test_a.py": { names: ["t1"], failing: [] } },
        refs: {},
      },
      requests: ["tests/test_x.py", "tests/test_a.py"].map((f) => ({
        command: "pytest",
        cwd: LINUX.py,
        files: [f],
        reference: { kind: "captured", reference: REF },
        failureRecheck: true,
      })),
      flaky: false,
    };
    const id = "tests/test_x.py::test_cmp[1 > 0]";
    const unionSpec = specOf(planCase(LINUX, { command: "pytest", cwd: LINUX.py, changedFiles: pc.requests.flatMap((r) => (r.files === "unavailable" ? [] : r.files.map((path) => ({ path, status: "M" as const })))) }, 0));
    expect(pytestReport(LINUX, pc.model, unionSpec, false).text).toContain('<testcase classname="tests.test_x" name="test_cmp[1 &gt; 0]" time="0.01"><failure');

    // Alone: the failure is A's, and pytest's recheck is runner-unsupported, so A is unverifiable (2.1 decision 5).
    const solo = propertySeams(pc, false);
    const soloRuns: TestsPassRun[] = [];
    for (const cr of pc.requests) soloRuns.push(await directOver(solo.runtime, toRequest(cr)));
    expect(ran(soloRuns[0] ?? aborted(""))).toMatchObject({ result: { failingIds: [id], complete: true } });
    expect(soloRuns[0]?.recheck).toMatchObject({ kind: "unusable", cause: "runner-unsupported" });
    expect(soloRuns.map((r) => judgeStandIn(r).verdict)).toEqual(["unverifiable", "pass"]);

    // Batched: one union run through the real readResult; its " > " id is derived for A, as alone.
    const { calls, runtime } = propertySeams(pc, false);
    const c = createBatchCoordinator({ platform: "linux" });
    const outs = pc.requests.map((cr) => c.hook(runtime)(toRequest(cr)));
    await vi.advanceTimersByTimeAsync(WINDOW);
    const runs = await Promise.all(outs);
    expect(calls.executes).toHaveLength(1);
    expect(calls.executes[0]?.out).toMatchObject({ result: { failingIds: [id], complete: true } });
    expect(ran(runs[0] ?? aborted(""))).toMatchObject({ result: { failingIds: [id], complete: true } });
    expect(runs[0]?.recheck).toEqual(soloRuns[0]?.recheck);
    expect(runs.map((r) => judgeStandIn(r).verdict)).toEqual(["unverifiable", "pass"]);
    expect(runs.map(judgeStandIn)).toEqual(soloRuns.map(judgeStandIn));
    expect(c.stats()).toMatchObject({ unionRuns: 1, ownRuns: 0, taints: 0 });
    await c.dispose();
  });

  it("the property cases reached every verdict, shared runs, flaky members, win32, several cwds, colliding pytest paths, -t, reuse and \" > \" names", () => {
    for (const [what, n] of Object.entries(propertyTally)) expect(n, what).toBeGreaterThan(10);
  });

  it("the generator covers the interesting shapes", () => {
    let flaky = 0;
    let pytest = 0;
    let multi = 0;
    let distinctRefs = 0;
    let guardSensitive = 0;
    let zeroTest = 0;
    let capturedButOff = 0;
    let fewerAtRef = 0;
    let nested = 0;
    let gtFailing = 0;
    for (let i = 0; i < PROPERTY_CASES; i++) {
      const pc = genCase(PROPERTY_SEED + i);
      if (pc.flaky) flaky++;
      if (pc.requests.some((r) => r.command.startsWith("pytest"))) pytest++;
      if (pc.requests.length > 1) multi++;
      const commits = new Set(pc.requests.flatMap((r) => (r.reference.kind === "captured" ? [r.reference.reference.commit] : [])));
      if (commits.size > 1) distinctRefs++;
      if (pc.requests.some((r) => !r.command.startsWith("pytest") && r.files !== "unavailable" && r.files.some((f) => /\.test\.ts$/i.test(f)))) guardSensitive++;
      if (Object.values(pc.model.now).some((f) => f.names.length === 0)) zeroTest++;
      if (pc.requests.some((r) => r.reference.kind === "captured" && !r.failureRecheck)) capturedButOff++;
      if (Object.values(pc.model.refs).some((at) => Object.entries(at).some(([k, f]) => f.names.length < (pc.model.now[k]?.names.length ?? 0)))) fewerAtRef++;
      if (Object.values(pc.model.now).some((f) => f.failing.includes("TestK::t2"))) nested++;
      if (PT.some((k) => pc.model.now[k]?.failing.some((n) => n.includes(" > ")) === true)) gtFailing++;
    }
    for (const n of [flaky, pytest, multi, distinctRefs, guardSensitive, zeroTest, capturedButOff, fewerAtRef, nested, gtFailing]) expect(n).toBeGreaterThan(10);
  });
});
