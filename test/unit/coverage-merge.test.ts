// QA-1.4-9: unit tests for the pure gate decision of scripts/coverage-merge.mjs
// (scripts/coverage-gate.ts) and for the gate declarations in vitest.config.ts.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
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
  opts: {
    exact?: string[];
    prefixes?: Parameters<typeof evaluateGates>[0]["prefixes"];
    warnOnly?: string[];
    warnOnlyPrefixes?: string[];
  },
) {
  return evaluateGates({
    exact: opts.exact ?? [],
    exactMin: MIN,
    prefixes: opts.prefixes ?? [],
    files: new Map(Object.entries(files)),
    warnOnly: new Set(opts.warnOnly ?? []),
    warnOnlyPrefixes: new Set(opts.warnOnlyPrefixes ?? []),
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

  it("warns without failing for misses under a warn-only prefix", () => {
    const out = run(
      { "src/executor/a.ts": stat(50, 60, 70) },
      { prefixes, warnOnlyPrefixes: ["src/executor/"] },
    );
    expect(out.failed).toBe(false);
    expect(out.results[0]).toMatchObject({
      source: "prefix",
      prefix: "src/executor/",
      status: "fail",
      soft: true,
      misses: ["lines", "branches", "functions"],
    });
    expect(out.warnings).toEqual([
      "src/executor/a.ts below the prefix gate src/executor/ (lines 50%, branches 60%, functions 70%); warn-only, not blocking",
    ]);
  });

  it("keeps non-soft prefixes blocking when another prefix is warn-only", () => {
    const out = run(
      { "src/executor/a.ts": stat(50, 50), "src/verify/a.ts": stat(50, 50) },
      {
        prefixes: [...prefixes, { prefix: "src/verify/", lines: 90, branches: 90 }],
        warnOnlyPrefixes: ["src/executor/"],
      },
    );
    expect(out.failed).toBe(true);
    expect(out.warnings).toHaveLength(1);
    expect(out.results.find((r) => r.prefix === "src/verify/")).toMatchObject({ status: "fail", soft: false });
  });

  it("only warns when a warn-only prefix matches no file", () => {
    const out = run({}, { prefixes, warnOnlyPrefixes: ["src/executor/"] });
    expect(out.failed).toBe(false);
    expect(out.emptyPrefixes).toEqual(["src/executor/"]);
    expect(out.results).toEqual([]);
    expect(out.warnings).toEqual([
      "src/executor/ prefix gate matched no file of the merged report (warn-only, not blocking)",
    ]);
  });

  it("does not soften an exact entry with a warn-only prefix", () => {
    const out = run(
      { "src/executor/a.ts": stat(10, 10) },
      { exact: ["src/executor/a.ts"], prefixes, warnOnlyPrefixes: ["src/executor/"] },
    );
    expect(out.failed).toBe(true);
    expect(out.results.find((r) => r.source === "exact")).toMatchObject({ status: "fail", soft: false });
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

// QA-1.4-30: the script itself, run as CI runs it (plain node, types stripped) on tiny istanbul fixtures.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// `--experimental-strip-types` exists from Node 22.6 (default-on from 22.18 / 23.6, where the flag is still accepted).
const canStrip = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6);
const WORK = mkdtempSync(join(tmpdir(), "omr-cov-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

function pos(line: number) {
  return { start: { line, column: 0 }, end: { line, column: 10 } };
}

/** One-statement, one-function istanbul file at `/fixture/src/executor/fixture.ts`; `fnLine` moves the function location. */
function fixtureCoverage(fnHits: number, fnLine = 1): string {
  const path = "/fixture/src/executor/fixture.ts";
  return JSON.stringify({
    [path]: {
      path,
      statementMap: { 0: pos(1) },
      s: { 0: 1 },
      fnMap: { 0: { name: "f", decl: pos(fnLine), loc: pos(fnLine), line: fnLine } },
      f: { 0: fnHits },
      branchMap: {},
      b: {},
    },
  });
}

function runMerge(name: string, inputs: string[], options: string[] = []) {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  const files = inputs.map((text, i) => {
    const file = join(dir, `in${i}.json`);
    writeFileSync(file, text);
    return file;
  });
  const soft = MERGED_PER_FILE_GATED.flatMap((rel) => ["--warn-only", rel]); // the fixture covers none of the exact files
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/coverage-merge.mjs", ...soft, ...options, join(dir, "out"), ...files],
    { cwd: ROOT, encoding: "utf8" },
  );
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe.skipIf(!canStrip)("scripts/coverage-merge.mjs on fixture summaries", () => {
  it("passes a prefix-gated file that meets every minimum", () => {
    const r = runMerge("pass", [fixtureCoverage(1)]);
    expect(r.out).toContain("src/executor/fixture.ts");
    expect(r.out).toContain("coverage gate passed");
    expect(r.status).toBe(0);
  });

  it("fails on functions below the prefix gate", () => {
    const r = runMerge("fn-fail", [fixtureCoverage(0)]);
    expect(r.out).toMatch(/src\/executor\/fixture\.ts.*FAIL/);
    expect(r.status).toBe(1);
  });

  it("warns without failing on a soft prefix miss", () => {
    const r = runMerge("fn-soft", [fixtureCoverage(0)], ["--warn-only-prefix", "src/executor/"]);
    expect(r.out).toMatch(/src\/executor\/fixture\.ts.*WARN \(warn-only\)/);
    expect(r.out).toContain("::warning::src/executor/fixture.ts below the prefix gate");
    expect(r.status).toBe(0);
  });

  it("warns without failing on an empty soft prefix", () => {
    const r = runMerge("empty-soft", ["{}"], ["--warn-only-prefix", "src/executor/"]);
    expect(r.out).toMatch(/src\/executor\/.*WARN \(warn-only\): prefix gate matched no file/);
    expect(r.out).toContain("::warning::src/executor/ prefix gate matched no file");
    expect(r.out).not.toContain("FAIL");
    expect(r.status).toBe(0);
  });

  it.each(["src/not-gated/", "src/executor", undefined])("rejects an undeclared or missing warn-only prefix (%s)", (prefix) => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/coverage-merge.mjs", "--warn-only-prefix", ...(prefix ? [prefix] : [])],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--warn-only-prefix needs one of: src/executor/");
    expect(r.stderr).toContain("usage: node scripts/coverage-merge.mjs");
  });

  it("reports function-map drift when two inputs map the same source to different function locations", () => {
    const r = runMerge("drift", [fixtureCoverage(1, 1), fixtureCoverage(1, 2)]);
    expect(r.out).toContain("WARN function map drift 1->2");
    expect(r.status).toBe(0);
  });

  it("exits 2 on bad input", () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/coverage-merge.mjs"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe.skipIf(!canStrip)("scripts/coverage-gate.ts", () => {
  it("uses only erasable syntax: node --experimental-strip-types imports it and runs evaluateGates", () => {
    const url = pathToFileURL(join(ROOT, "scripts", "coverage-gate.ts")).href;
    const code =
      `const m = await import(${JSON.stringify(url)});` +
      `const o = m.evaluateGates({ exact: [], exactMin: { lines: 90, branches: 90 }, prefixes: [], files: new Map() });` +
      `console.log(JSON.stringify(o));`;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { cwd: ROOT, encoding: "utf8" });
    expect(r.stderr).not.toMatch(/SyntaxError|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ results: [], emptyPrefixes: [], warnings: [], failed: false });
  });
});
