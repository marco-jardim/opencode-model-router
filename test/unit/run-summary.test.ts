/**
 * #108 slice 2: `router_run({ summary: "failures" })` for vitest npm scripts (OpenCode v2 roles mode, where router_run exists).
 * Pure parsing and the 4 KiB cut rule (P5), the injected `--reporter=json --outputFile=<OS temp>` (P11) with the verify
 * runner's report-path guard, the refusals, and an end-to-end run through npm with a stand-in vitest binary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunConfig } from "../../src/router/roles";
import {
  firstErrorBlock, newRunReportPath, oneLine, parseVitestReport, renderFailureSummary, renderSummaryUnavailable, RUN_REPORT_MAX_BYTES, RUN_SUMMARY_MAX_BYTES,
  runReportPathAllowed, vitestScriptRefusal, type VitestReportSummary,
} from "../../src/router/run-summary";
import { planRun, routerRunTool, type RunRecord, type WorkRootAnswer } from "../../src/router/run-tools";
import { reportPathAllowed, REPORT_NAME_RE } from "../../src/verify/runner";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const WIN = process.platform === "win32";
const SPAWN_TIMEOUT = 90_000;
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
const bytes = (text: string) => Buffer.byteLength(text);
const STATUS = '[router_run] package.json script "test": exit code: 1; duration 1.0 s';

/** A vitest-style JSON report: `files` maps a test file to its failing test titles (empty: a file-level error). */
function report(cwd: string, files: Record<string, string[]>, extra: Record<string, unknown> = {}): string {
  const failed = Object.values(files).reduce((sum, titles) => sum + titles.length, 0);
  return JSON.stringify({
    numTotalTests: failed + 10, numPassedTests: 9, numFailedTests: failed, numPendingTests: 1, numTodoTests: 0,
    numTotalTestSuites: Object.keys(files).length + 3, numFailedTestSuites: Object.keys(files).length,
    testResults: [
      { name: join(cwd, "test", "ok.test.ts"), status: "passed", message: "", assertionResults: [{ status: "passed", title: "fine", ancestorTitles: [] }] },
      ...Object.entries(files).map(([file, titles]) => ({
        name: join(cwd, ...file.split("/")), status: "failed", message: titles.length === 0 ? "\u001b[31mError: Cannot find module './gone'\u001b[39m\n    at load (x.ts:1:1)" : "",
        assertionResults: titles.map(title => ({
          status: "failed", title, ancestorTitles: ["suite"],
          failureMessages: [`AssertionError: expected ${title} to pass\n\n- Expected\n+ Received\n    at Object.<anonymous> (${file}:3:7)`],
        })),
      })),
    ],
    ...extra,
  });
}

describe("run-summary helpers (#108)", () => {
  it("P11: only a single vitest command qualifies; reporter and output-file settings are refused", () => {
    for (const body of ["vitest", "vitest run", "  vitest run --maxWorkers=2 test/unit", "vitest --run --coverage"]) expect(vitestScriptRefusal(body), body).toBeUndefined();
    expect(vitestScriptRefusal("node probe.js")).toBe("does not start with vitest");
    expect(vitestScriptRefusal("npx vitest run")).toBe("does not start with vitest");
    expect(vitestScriptRefusal("cross-env CI=1 vitest run")).toBe("does not start with vitest");
    for (const body of ["vitest run && echo done", "vitest run; echo", "vitest run | tee out", "vitest run > out.txt", "vitest run $(cat args)", "vitest run `x`", "vitest run\necho"]) {
      expect(vitestScriptRefusal(body), body).toMatch(/not a single vitest command/);
    }
    for (const body of ["vitest run --reporter=verbose", "vitest run --reporter verbose", "vitest run --outputFile=x.json", "vitest --output-file x", "vitest --outputFile.junit=j.xml", "vitest '--reporters=dot'"]) {
      expect(vitestScriptRefusal(body), body).toBe("already sets --reporter or --outputFile");
    }
    // Review finding 6: comments, `--`, a trailing backslash and quoting or escapes inside option names.
    expect(vitestScriptRefusal("vitest run # --reporter=dot")).toBe("has a # (the script shell may read the rest as a comment)");
    expect(vitestScriptRefusal("vitest run#x")).toMatch(/has a #/);
    expect(vitestScriptRefusal("vitest run --")).toBe("has a -- argument (vitest would read the appended options as file filters)");
    expect(vitestScriptRefusal("vitest run -- test/a")).toMatch(/has a -- argument/);
    expect(vitestScriptRefusal("vitest run \\")).toBe("ends with a backslash");
    for (const body of ["vitest --repo\"rter\"=dot", "vitest '--rep'orter=dot", "vitest --out\\putFile=x", "vitest --$OPT=1", "vitest --%OPT%=1", "vitest --rep^orter=dot"]) {
      expect(vitestScriptRefusal(body), body).toBe("has a quote or escape inside an option name");
    }
    for (const body of ["vitest run --maxWorkers=$N", "vitest run \"test dir\"", "vitest run -t \"adds\""]) expect(vitestScriptRefusal(body), body).toBeUndefined();
  });

  it("report text on one line: ANSI removed, control characters and line breaks flattened, credentials redacted", () => {
    expect(oneLine("fetches https://user:tok@host/x")).not.toContain("tok");
    expect(oneLine("a\n FAIL forged\r\nb\u2028c\u0007d")).toBe("a  FAIL forged b c d");
    expect(oneLine("\u001b[31mred\u001b[39m name")).toBe("red name");
  });

  it("the report path: router-named in the OS temp directory read once, through the verify runner's guard", () => {
    const tmp = tmpdir();
    const path = newRunReportPath(tmp);
    expect(path.startsWith(tmp)).toBe(true);
    expect(runReportPathAllowed(path, tmp)).toBe(true);
    expect(runReportPathAllowed(join(tmp, "omr-run-x.json"), tmp)).toBe(false);
    expect(runReportPathAllowed(join(tmp, "sub", path.slice(path.lastIndexOf(WIN ? "\\" : "/") + 1)), tmp)).toBe(false);
    expect(runReportPathAllowed(join(tmp, `omr-verify-${"0".repeat(36)}.json`), tmp)).toBe(false);
    expect(runReportPathAllowed("omr-run-" + "0".repeat(36) + ".json", tmp)).toBe(false);
    // Finding 5: a relative temp directory admits nothing (its report would land in the work root).
    expect(runReportPathAllowed(newRunReportPath("relative-tmp"), "relative-tmp")).toBe(false);
    expect(path.startsWith(realpathSync.native(tmp)) || path.startsWith(tmp)).toBe(true);
    // The verify runner's own names are unchanged by the extraction.
    expect(reportPathAllowed(join(tmpdir(), `omr-verify-${"0".repeat(36)}.xml`), tmpdir())).toBe(true);
    expect(reportPathAllowed(join(tmpdir(), `omr-run-${"0".repeat(36)}.json`), tmpdir())).toBe(false);
    expect(REPORT_NAME_RE.test(`omr-verify-${"a".repeat(36)}.json`)).toBe(true);
    expect(reportPathAllowed("C:\\T\\OMR-VERIFY-" + "0".repeat(36) + ".json", "c:\\t", "win32", /^omr-verify-[0-9a-f-]{36}\.json$/i)).toBe(true);
    expect(reportPathAllowed("/T/omr-verify-" + "0".repeat(36) + ".json", "/t", "linux")).toBe(false);
  });

  it("the first error block: ANSI removed, credentials redacted, cut at a blank line or stack frame, at most 4 lines", () => {
    expect(firstErrorBlock("\n\u001b[31mAssertionError: boom\u001b[39m\nsecond\n\nafter blank")).toBe("AssertionError: boom\nsecond");
    expect(firstErrorBlock("Error: x\n    at f (a.ts:1:1)\nmore")).toBe("Error: x");
    expect(firstErrorBlock("Error: x\n ❯ test/a.test.ts:3:7")).toBe("Error: x");
    expect(firstErrorBlock("1\n2\n3\n4\n5")).toBe("1\n2\n3\n4");
    expect(firstErrorBlock("Error: fetch https://user:hunter2@example.com/x failed")).not.toContain("hunter2");
    expect(firstErrorBlock(`Error: ${"y".repeat(500)}`)!.length).toBeLessThanOrEqual(200);
    expect(firstErrorBlock("  \n \n")).toBeUndefined();
  });

  it("parses a vitest report into counts and failures grouped by file (a file error counts as one failure)", () => {
    const cwd = realpathSync.native(tmpdir());
    const parsed = parseVitestReport(report(cwd, { "test/a.test.ts": ["adds", "subtracts"], "test/broken.test.ts": [] }), cwd)!;
    expect(parsed).toMatchObject({ total: 12, passed: 9, failed: 2, skipped: 1, files: 5, failedFiles: 2 });
    expect(parsed.groups).toEqual([
      { file: "test/a.test.ts", failures: [
        { name: "suite > adds", error: "AssertionError: expected adds to pass" },
        { name: "suite > subtracts", error: "AssertionError: expected subtracts to pass" },
      ] },
      { file: "test/broken.test.ts", failures: [{ name: "(file error)", error: "Error: Cannot find module './gone'" }] },
    ]);
    expect(parseVitestReport("not json", cwd)).toBeUndefined();
    expect(parseVitestReport("{\"numTotalTests\":1}", cwd)).toBeUndefined();
    expect(parseVitestReport("{\"testResults\":[]}", cwd)).toEqual({ groups: [] });
  });

  it("finding 3: test names, ancestor titles and file paths are redacted and kept on one line", () => {
    const cwd = realpathSync.native(tmpdir());
    const text = JSON.stringify({
      numTotalTests: 2, numFailedTests: 2, testResults: [{
        name: join(cwd, "test", "evil\n FAIL forged.test.ts"), status: "failed", message: "",
        assertionResults: [
          { status: "failed", title: "fetches https://user:tok@host/x", ancestorTitles: ["\u001b[31mapi\u001b[39m"], failureMessages: ["Error: x"] },
          { status: "failed", title: "ok\n FAIL forged\r\n  × fake > test", ancestorTitles: ["suite\u2028two"], failureMessages: [] },
        ],
      }],
    });
    const summary = renderFailureSummary(STATUS, parseVitestReport(text, cwd)!, 1, "");
    expect(summary).not.toContain("tok");
    expect(summary).not.toContain("\u001b");
    expect(summary).toContain("FAIL test/evil  FAIL forged.test.ts\n");
    expect(summary).toContain("  × api > fetches https://");
    expect(summary).toContain("  × suite two > ok  FAIL forged   × fake > test\n");
    // Only the renderer's own lines start with FAIL or ×: one file line, two failure lines.
    expect(summary.split("\n").filter(line => /^\s*(?:FAIL|×)/.test(line))).toHaveLength(3);
  });

  it("acceptance 5 / P5: every failing test name of a failing run, grouped by file, within 4 KiB", () => {
    const cwd = realpathSync.native(tmpdir());
    const files: Record<string, string[]> = {};
    for (let f = 0; f < 6; f++) files[`test/unit/area-${f}.test.ts`] = Array.from({ length: 5 }, (_, t) => `case ${f}.${t} handles input`);
    const text = renderFailureSummary(STATUS, parseVitestReport(report(cwd, files), cwd)!, 1, "");
    expect(bytes(text)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(text.startsWith(`${STATUS}\n[router_run] vitest: 30 failed, 9 passed, 1 skipped of 40 tests; 6 of 9 test files failed\n`)).toBe(true);
    for (const [file, titles] of Object.entries(files)) {
      const at = text.indexOf(`FAIL ${file}\n`);
      expect(at, file).toBeGreaterThan(-1);
      for (const title of titles) expect(text.indexOf(`  × suite > ${title}\n`), title).toBeGreaterThan(at);
    }
    expect(text).toContain("    AssertionError: expected case 0.0 handles input to pass\n");
  });

  it("P5 cut rule: names before error blocks, then the exact count of failures, files and error blocks left out", () => {
    const cwd = realpathSync.native(tmpdir());
    const files: Record<string, string[]> = {};
    for (let f = 0; f < 40; f++) files[`test/f${f}.test.ts`] = Array.from({ length: 10 }, (_, t) => `a fairly long test name number ${t}`);
    const parsed = parseVitestReport(report(cwd, files), cwd)!;
    const text = renderFailureSummary(STATUS, parsed, 1, "");
    expect(bytes(text)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    const names = text.split("\n").filter(line => line.startsWith("  × ")).length;
    const left = /not shown, to keep this summary within 4096 bytes: (\d+) more failures in (\d+) files(?:; the error blocks? of (\d+) listed failures?)?\. Run without summary/
      .exec(text);
    expect(left, text).not.toBeNull();
    expect(names + Number(left![1])).toBe(400);
    const shownFiles = text.split("\n").filter(line => line.startsWith("FAIL ")).length;
    // The last shown file may be partly listed: the omitted files count those with any failure left out.
    expect(shownFiles + Number(left![2])).toBeGreaterThanOrEqual(40);
    expect(shownFiles + Number(left![2])).toBeLessThanOrEqual(41);
    // Names come first; every listed failure has an error block, shown or counted.
    const blocks = text.split("\n").filter(line => line.startsWith("    AssertionError")).length;
    expect(blocks + Number(left![3] ?? 0)).toBe(names);
    expect(blocks).toBeLessThan(names);
    // Room for every name but not every block: the blocks that do not fit are counted.
    const some: Record<string, string[]> = { "test/a.test.ts": Array.from({ length: 30 }, (_, t) => `t${t}`) };
    const mid = parseVitestReport(report(cwd, some), cwd)!;
    const withBlocks = renderFailureSummary(STATUS, { ...mid, groups: mid.groups.map(group => ({ ...group, failures: group.failures.map(failure => ({ ...failure, error: `E: ${"z".repeat(150)}` })) })) }, 1, "");
    expect(bytes(withBlocks)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(withBlocks.split("\n").filter(line => line.startsWith("  × "))).toHaveLength(30);
    const shownBlocks = withBlocks.split("\n").filter(line => line.startsWith("    E: ")).length;
    expect(shownBlocks).toBeGreaterThan(0);
    expect(withBlocks).toContain(`not shown, to keep this summary within 4096 bytes: the error blocks of ${30 - shownBlocks} listed failures.`);
  });

  it("a passing run, a failing exit without failures in the report, and a missing report", () => {
    const passing: VitestReportSummary = { total: 3, passed: 3, failed: 0, skipped: 0, files: 1, failedFiles: 0, groups: [] };
    expect(renderFailureSummary(STATUS.replace("1;", "0;"), passing, 0, "noise\n")).toBe(
      `${STATUS.replace("1;", "0;")}\n[router_run] vitest: 0 failed, 3 passed, 0 skipped of 3 tests; 0 of 1 test files failed\n`);
    const tail = `${"early line\n".repeat(1000)}Coverage threshold for lines (80%) not met\n`;
    const noFailure = renderFailureSummary(STATUS, passing, 1, tail);
    expect(bytes(noFailure)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(noFailure).toContain("the run ended with exit code 1 but its report lists no failing test; the last lines of its output:\n");
    expect(noFailure.endsWith("Coverage threshold for lines (80%) not met\n")).toBe(true);
    const missing = renderSummaryUnavailable(STATUS, "vitest wrote no report", `${"x".repeat(9000)}\nError: config not found\n`);
    expect(bytes(missing)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(missing).toBe(`${STATUS}\n[router_run] vitest summary unavailable: vitest wrote no report; the last lines of the output:\nError: config not found\n`);
  });
});

let root: string;
let home: string;
beforeEach(() => {
  vi.mocked(childProcess.spawn).mockClear();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-summary-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-summary-home-")));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of [root, home]) rmSync(dir, RM);
});

const config = (over: Partial<RunConfig> = {}): RunConfig => ({ scripts: ["test", "typecheck"], commands: {}, timeoutMs: 60_000, ...over });
const testEnv = (): NodeJS.ProcessEnv => ({
  ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "Roaming"), LOCALAPPDATA: join(home, "Local"),
  XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
});
const host = () => ({ platform: process.platform, env: testEnv() });
const bind = (dir: string): WorkRootAnswer => ({ role: true, root: dir });
type Execute = (args: unknown, context: unknown) => Promise<string>;
const context = () => ({ sessionID: "child", messageID: "m", agent: "runner", directory: root, worktree: root, abort: new AbortController().signal,
  metadata: () => undefined, ask: async () => undefined });
function makeTool(cfg: RunConfig, records: RunRecord[] = []) {
  const t = routerRunTool({ config: () => cfg, resolveWorkRoot: () => bind(root), recordRun: e => { records.push(e); }, env: testEnv() });
  return (args: unknown) => (t.execute as unknown as Execute)(args, context());
}
function packageJson(scripts: Record<string, string>) {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", version: "1.0.0", private: true, scripts }));
}
/**
 * A stand-in `vitest` on npm's script PATH: it records its arguments and copies report.json (when present) to --outputFile. With a
 * mode.txt: `hang` (report first, then never exits), `oversized` (a report above the cap), `malformed` (not JSON).
 */
function fakeVitest(mode?: "hang" | "oversized" | "malformed") {
  const bin = join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  if (mode !== undefined) writeFileSync(join(root, "mode.txt"), mode);
  writeFileSync(join(root, "fake-vitest.js"), [
    "const fs = require('fs');",
    "const args = process.argv.slice(2);",
    "const mode = fs.existsSync('mode.txt') ? fs.readFileSync('mode.txt', 'utf8').trim() : '';",
    "fs.writeFileSync('vitest-args.json', JSON.stringify(args));",
    "console.log('RUN v5 fake');",
    "console.error('stderr noise from the fake');",
    "const out = args.find(a => a.startsWith('--outputFile='));",
    "if (out) {",
    "  const path = out.slice('--outputFile='.length);",
    `  if (mode === 'oversized') fs.writeFileSync(path, Buffer.alloc(${RUN_REPORT_MAX_BYTES + 1}, 0x20));`,
    "  else if (mode === 'malformed') fs.writeFileSync(path, 'not json');",
    "  else if (fs.existsSync('report.json')) fs.copyFileSync('report.json', path);",
    "}",
    "if (mode === 'hang') setInterval(() => undefined, 1000);",
    "else process.exit(fs.existsSync('report.json') ? 1 : 2);",
  ].join("\n"));
  writeFileSync(join(bin, "vitest.cmd"), "@node \"%~dp0\\..\\..\\fake-vitest.js\" %*\r\n");
  writeFileSync(join(bin, "vitest"), "#!/bin/sh\nexec node \"$(dirname \"$0\")/../../fake-vitest.js\" \"$@\"\n", { mode: 0o755 });
}
/** The report path of the last run spawned with one (later spawns, such as taskkill after a timeout, carry none). */
const outputFileOfLastSpawn = (): string => {
  const args = vi.mocked(childProcess.spawn).mock.calls.map(call => call[1] as unknown as readonly string[] | undefined);
  const arg = args.reverse().flatMap(list => list?.filter(a => a.startsWith("--outputFile=")) ?? [])[0]!;
  return arg.slice("--outputFile=".length);
};

describe("planRun with summary failures (#108 P11)", () => {
  const REPORT = join(tmpdir(), `omr-run-${"0".repeat(36)}.json`);
  const INJECTED = ["--reporter=json", `--outputFile=${REPORT}`];

  it("appends the reporter and output file to a vitest script entry and to npm commands running one; unchanged without it", () => {
    packageJson({ test: "vitest run", typecheck: "tsc --noEmit", unit: "vitest run test/unit" });
    expect(planRun({ script: "test", cwd: root }, root, config(), host(), { failuresReport: REPORT }).argv.slice(-4)).toEqual(["test", "--", ...INJECTED]);
    expect(planRun({ script: "test", cwd: root }, root, config(), host()).argv.at(-1)).toBe("test");
    const cfg = config({ commands: {
      files: { argv: ["npm", "run", "test", "--"], args: ["test/*", "--maxWorkers=*"] },
      bare: { argv: ["npm", "run", "unit"], args: ["test/*"] },
      shorthand: { argv: ["npm", "test", "--", "--maxWorkers=2"] },
    } });
    expect(planRun({ script: "files", args: ["test/a.test.ts", "--maxWorkers=2"], cwd: root }, root, cfg, host(), { failuresReport: REPORT }).argv.slice(-6))
      .toEqual(["test", "--", "test/a.test.ts", "--maxWorkers=2", ...INJECTED]);
    expect(planRun({ script: "bare", args: ["test/a.test.ts"], cwd: root }, root, cfg, host(), { failuresReport: REPORT }).argv.slice(-5))
      .toEqual(["unit", "test/a.test.ts", "--", ...INJECTED]);
    expect(planRun({ script: "shorthand", cwd: root }, root, cfg, host(), { failuresReport: REPORT }).argv.slice(-5))
      .toEqual(["test", "--", "--maxWorkers=2", ...INJECTED]);
    expect(planRun({ script: "files", args: ["test/a.test.ts"], cwd: root }, root, cfg, host()).argv.slice(-3)).toEqual(["test", "--", "test/a.test.ts"]);
  });

  it("refuses every entry that is not a vitest npm script, and caller or fixed reporter settings", () => {
    packageJson({ test: "node probe.js", typecheck: "vitest run && echo ok", unit: "vitest run", start: "vitest" });
    const cfg = config({ commands: {
      node: { argv: ["node", "probe.js"] },
      start: { argv: ["npm", "start"] },
      files: { argv: ["npm", "run", "unit", "--"], args: ["--reporter=*", "--outputFile=*", "--output-file=*", "--", "test/*"] },
      fixed: { argv: ["npm", "run", "unit", "--", "--reporter=dot"] },
      twice: { argv: ["npm", "run", "unit", "--", "--"] },
    } });
    const plan = (script: string, args: string[] = []) => () => planRun({ script, args, cwd: root }, root, cfg, host(), { failuresReport: REPORT });
    expect(plan("test")).toThrow('summary "failures" needs a vitest npm script: script "test" does not start with vitest');
    expect(plan("typecheck")).toThrow(/script "typecheck" is not a single vitest command/);
    expect(plan("node")).toThrow('summary "failures" needs a vitest npm script; "node" is not an npm entry');
    expect(plan("start")).toThrow('"start" does not run one package.json script');
    for (const arg of ["--reporter=verbose", "--outputFile=x.json", "--output-file=x.json"]) {
      expect(plan("files", [arg]), arg).toThrow(`${arg} is not accepted with it`);
    }
    expect(plan("fixed")).toThrow("--reporter=dot is not accepted with it");
    // Finding 6: a caller (or a second fixed) `--` would turn the appended options into file filters.
    expect(plan("files", ["test/a.test.ts", "--"])).toThrow('summary "failures" does not accept a "--" argument');
    expect(plan("twice")).toThrow('does not accept a "--" argument');
    expect(plan("files", ["test/a.test.ts"])().argv.slice(-3)).toEqual(["test/a.test.ts", ...INJECTED]);
  });
});

describe("router_run summary failures end to end (#108)", () => {
  it("runs the vitest script with the injected reporter, answers within 4 KiB grouped by file, and deletes the report", async () => {
    packageJson({ test: "vitest run" });
    fakeVitest();
    writeFileSync(join(root, "report.json"), report(root, { "test/a.test.ts": ["adds", "subtracts"], "test/b.test.ts": ["divides"] }));
    const records: RunRecord[] = [];
    const answer = await makeTool(config(), records)({ script: "test", cwd: root, summary: "failures" });
    expect(bytes(answer)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(answer).toMatch(/^\[router_run\] package\.json script "test": exit code: \d+; duration [\d.]+ s\n\[router_run\] vitest: 3 failed, 9 passed, 1 skipped of 13 tests; 2 of 5 test files failed\n/);
    expect(answer).toContain("FAIL test/a.test.ts\n  × suite > adds\n    AssertionError: expected adds to pass\n  × suite > subtracts\n");
    expect(answer).toContain("FAIL test/b.test.ts\n  × suite > divides\n");
    expect(answer).not.toContain("stderr noise");
    const args = JSON.parse(readFileSync(join(root, "vitest-args.json"), "utf8")) as string[];
    const reportPath = outputFileOfLastSpawn();
    expect(args).toEqual(["run", "--reporter=json", `--outputFile=${reportPath}`]);
    expect(runReportPathAllowed(reportPath, tmpdir())).toBe(true);
    expect(existsSync(reportPath)).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]!.script).toBe("test");
    expect(records[0]!.exitCode).not.toBe(0);
  }, SPAWN_TIMEOUT);

  it("without a report: the reason and the output's last lines; without summary: today's answer", async () => {
    packageJson({ test: "vitest run" });
    fakeVitest();
    const run = makeTool(config());
    const answer = await run({ script: "test", cwd: root, summary: "failures" });
    expect(answer).toMatch(/exit code: \d+; .*\n\[router_run\] vitest summary unavailable: vitest wrote no report \(it did not start, was stopped, or failed before reporting\); the last lines of the output:\n/);
    expect(answer).toContain("RUN v5 fake");
    expect(existsSync(outputFileOfLastSpawn())).toBe(false);
    const plain = await run({ script: "test", cwd: root });
    expect(plain).not.toContain("vitest summary");
    expect(plain).toContain("stderr noise from the fake");
    expect(JSON.parse(readFileSync(join(root, "vitest-args.json"), "utf8"))).toEqual(["run"]);
  }, SPAWN_TIMEOUT);

  it("refuses before spawning: a non-vitest script, an unknown summary value", async () => {
    packageJson({ test: "node probe.js" });
    const run = makeTool(config());
    expect(await run({ script: "test", cwd: root, summary: "failures" }))
      .toBe('[router_run] error: refused: summary "failures" needs a vitest npm script: script "test" does not start with vitest');
    expect(await run({ script: "test", cwd: root, summary: "all" })).toMatch(/^\[router_run\] error: /);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it("finding 5: a relative OS temp directory is refused before planning; no report can land in the work root", async () => {
    packageJson({ test: "vitest run" });
    fakeVitest();
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    for (const name of ["TEMP", "TMP", "TMPDIR"] as const) process.env[name] = "relative-tmp";
    let answer: string;
    try {
      answer = await makeTool(config())({ script: "test", cwd: root, summary: "failures" });
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    expect(answer).toBe('[router_run] error: refused: summary "failures" needs an absolute OS temp directory for its report (it is "relative-tmp"; check TEMP, TMP or TMPDIR)');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, "relative-tmp"))).toBe(false);
    expect(readdirSync(root).filter(name => name.startsWith("omr-run-"))).toEqual([]);
  });

  it("finding 4: the report is deleted when the run times out, and when the spawn fails", async () => {
    packageJson({ test: "vitest run" });
    fakeVitest("hang");
    writeFileSync(join(root, "report.json"), report(root, { "test/a.test.ts": ["adds"] }));
    const timedOut = await makeTool(config({ timeoutMs: 5_000 }))({ script: "test", cwd: root, summary: "failures" });
    expect(timedOut).toMatch(/^\[router_run\] package\.json script "test": timed out after 5000 ms, process tree killed; exit code: none;/);
    expect(timedOut).toContain("FAIL test/a.test.ts\n  × suite > adds\n");
    expect(bytes(timedOut)).toBeLessThanOrEqual(RUN_SUMMARY_MAX_BYTES);
    expect(existsSync(outputFileOfLastSpawn())).toBe(false);
    // A spawn that fails after the report path exists (written here by the failing spawn itself).
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let written: string | undefined;
    vi.mocked(childProcess.spawn).mockImplementation(((command: string, args: readonly string[], options: childProcess.SpawnOptions) => {
      const out = args.find(arg => arg.startsWith("--outputFile="));
      if (out === undefined) return actual.spawn(command, args, options);
      written = out.slice("--outputFile=".length);
      writeFileSync(written, "{}");
      throw new Error("spawn EACCES (test)");
    }) as unknown as typeof childProcess.spawn);
    try {
      expect(await makeTool(config())({ script: "test", cwd: root, summary: "failures" })).toBe("[router_run] error: spawn EACCES (test)");
    } finally {
      vi.mocked(childProcess.spawn).mockImplementation(actual.spawn);
    }
    expect(written).toBeDefined();
    expect(existsSync(written!)).toBe(false);
  }, SPAWN_TIMEOUT);

  it("finding 10: an oversized report is not read (size checked first), a malformed one is reported; both are deleted", async () => {
    packageJson({ test: "vitest run" });
    fakeVitest("oversized");
    const oversized = await makeTool(config())({ script: "test", cwd: root, summary: "failures" });
    expect(oversized).toContain(`[router_run] vitest summary unavailable: the vitest report is larger than ${RUN_REPORT_MAX_BYTES / (1024 * 1024)} MiB; the last lines of the output:\n`);
    expect(existsSync(outputFileOfLastSpawn())).toBe(false);
    fakeVitest("malformed");
    const malformed = await makeTool(config())({ script: "test", cwd: root, summary: "failures" });
    expect(malformed).toContain("[router_run] vitest summary unavailable: the vitest report is not a vitest JSON report; the last lines of the output:\n");
    expect(existsSync(outputFileOfLastSpawn())).toBe(false);
  }, SPAWN_TIMEOUT);
});
