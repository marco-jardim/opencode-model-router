// QA-1.4-9: unit tests for the pure gate decision of scripts/coverage-merge.mjs
// (scripts/coverage-gate.ts) and for the gate declarations in vitest.config.ts.
import { describe, expect, it } from "vitest";
import { evaluateGates, type FileStat } from "../../scripts/coverage-gate.ts";
import { MERGED_PER_FILE_GATED, MERGED_PER_FILE_MIN, MERGED_PREFIX_GATED } from "../../vitest.config.ts";

function metric(pct: number) {
  return { pct, covered: pct, total: 100 };
}

function stat(lines: number, branches: number, functions = 100): FileStat {
  return { lines: metric(lines), branches: metric(branches), functions: metric(functions) };
}

const MIN = { lines: 90, branches: 90 };

function run(
  files: Record<string, FileStat>,
  opts: { exact?: string[]; prefixes?: Parameters<typeof evaluateGates>[0]["prefixes"]; warnOnly?: string[] },
) {
  return evaluateGates({
    exact: opts.exact ?? [],
    exactMin: MIN,
    prefixes: opts.prefixes ?? [],
    files: new Map(Object.entries(files)),
    warnOnly: new Set(opts.warnOnly ?? []),
  });
}

describe("exact entries (unchanged behaviour)", () => {
  it("passes a file at the minimum and fails below it on lines or branches", () => {
    expect(run({ "src/a.ts": stat(90, 90) }, { exact: ["src/a.ts"] }).failed).toBe(false);
    const lines = run({ "src/a.ts": stat(89.9, 100) }, { exact: ["src/a.ts"] });
    expect(lines.failed).toBe(true);
    expect(lines.results[0]).toMatchObject({ status: "fail", misses: ["lines"] });
    const branches = run({ "src/a.ts": stat(100, 80) }, { exact: ["src/a.ts"] });
    expect(branches.failed).toBe(true);
    expect(branches.results[0]?.misses).toEqual(["branches"]);
  });

  it("does not gate functions for exact entries", () => {
    const out = run({ "src/a.ts": stat(100, 100, 0) }, { exact: ["src/a.ts"] });
    expect(out.failed).toBe(false);
    expect(out.results[0]?.required).toEqual({ lines: 90, branches: 90 });
  });

  it("fails on a file missing from the report, warns when it is warn-only", () => {
    const hard = run({}, { exact: ["src/a.ts"] });
    expect(hard.failed).toBe(true);
    expect(hard.results[0]).toMatchObject({ rel: "src/a.ts", status: "missing", soft: false });
    const soft = run({}, { exact: ["src/a.ts"], warnOnly: ["src/a.ts"] });
    expect(soft.failed).toBe(false);
    expect(soft.warnings).toEqual(["src/a.ts is missing from every input (warn-only, not blocking)"]);
  });

  it("only warns for a warn-only file below the gate, other files stay blocking", () => {
    const out = run(
      { "src/a.ts": stat(50, 50), "src/b.ts": stat(95, 95) },
      { exact: ["src/a.ts", "src/b.ts"], warnOnly: ["src/a.ts"] },
    );
    expect(out.failed).toBe(false);
    expect(out.warnings).toEqual([
      "src/a.ts below the per-file gate (lines 50%, branches 50%); warn-only, not blocking",
    ]);
    const blocking = run({ "src/a.ts": stat(50, 50), "src/b.ts": stat(10, 95) }, {
      exact: ["src/a.ts", "src/b.ts"],
      warnOnly: ["src/a.ts"],
    });
    expect(blocking.failed).toBe(true);
  });

  it("ignores files outside every entry", () => {
    expect(run({ "src/other.ts": stat(0, 0, 0) }, { exact: [] }).failed).toBe(false);
  });
});

describe("prefix entries", () => {
  const prefixes = [{ prefix: "src/executor/", lines: 90, branches: 90, functions: 90 }];

  it("gates every file under the prefix and nothing outside it", () => {
    const out = run(
      {
        "src/executor/types.ts": stat(100, 100),
        "src/executor/later.ts": stat(100, 50),
        "src/executorish/x.ts": stat(0, 0, 0),
        "src/verify/y.ts": stat(0, 0, 0),
      },
      { prefixes },
    );
    expect(out.results.map((r) => r.rel)).toEqual(["src/executor/later.ts", "src/executor/types.ts"]);
    expect(out.failed).toBe(true);
    expect(out.results.find((r) => r.rel === "src/executor/later.ts")).toMatchObject({
      source: "prefix",
      prefix: "src/executor/",
      status: "fail",
      misses: ["branches"],
    });
    expect(out.results.find((r) => r.rel === "src/executor/types.ts")?.status).toBe("ok");
  });

  it("matches nested directories", () => {
    const out = run({ "src/executor/deep/er/file.ts": stat(10, 100) }, { prefixes });
    expect(out.failed).toBe(true);
    expect(out.results[0]?.misses).toEqual(["lines"]);
  });

  it("passes when every matched file meets every minimum", () => {
    const out = run({ "src/executor/a.ts": stat(90, 90, 90), "src/executor/b.ts": stat(100, 100) }, { prefixes });
    expect(out.failed).toBe(false);
    expect(out.emptyPrefixes).toEqual([]);
  });

  it("fails when the prefix matches no file", () => {
    const out = run({ "src/verify/y.ts": stat(100, 100) }, { prefixes });
    expect(out.failed).toBe(true);
    expect(out.emptyPrefixes).toEqual(["src/executor/"]);
    expect(out.results).toEqual([]);
  });

  it("gates functions for entries that declare it", () => {
    const out = run({ "src/executor/a.ts": stat(100, 100, 80) }, { prefixes });
    expect(out.failed).toBe(true);
    expect(out.results[0]).toMatchObject({ status: "fail", misses: ["functions"] });
  });

  it("does not gate functions when the entry does not declare it", () => {
    const out = run(
      { "src/executor/a.ts": stat(100, 100, 0) },
      { prefixes: [{ prefix: "src/executor/", lines: 90, branches: 90 }] },
    );
    expect(out.failed).toBe(false);
  });

  it("rejects a prefix without a trailing slash", () => {
    expect(() => run({}, { prefixes: [{ prefix: "src/executor", lines: 90 }] })).toThrow(/must end with "\/"/);
  });

  it("is not softened by warn-only on an exact entry", () => {
    const out = run(
      { "src/executor/a.ts": stat(10, 10) },
      { exact: ["src/executor/a.ts"], prefixes, warnOnly: ["src/executor/a.ts"] },
    );
    expect(out.failed).toBe(true);
  });
});

describe("gate declarations in vitest.config.ts", () => {
  it("declares src/executor/ as a 90/90/90 prefix gate", () => {
    expect(MERGED_PREFIX_GATED).toEqual([{ prefix: "src/executor/", lines: 90, branches: 90, functions: 90 }]);
    for (const entry of MERGED_PREFIX_GATED) expect(entry.prefix.endsWith("/")).toBe(true);
  });

  it("keeps the exact-file gate shape", () => {
    expect(MERGED_PER_FILE_MIN).toEqual({ lines: 90, branches: 90 });
    expect(MERGED_PER_FILE_GATED).toContain("src/verify/exec.ts");
    expect(MERGED_PER_FILE_GATED).toContain("src/tui/status-model.ts");
    for (const rel of MERGED_PER_FILE_GATED) expect(rel.endsWith("/")).toBe(false);
  });
});
