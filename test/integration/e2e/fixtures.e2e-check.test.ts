// Self-check for the e2e fixture projects (plan §3.1.1). Opt-in: RUN_VERIFY_E2E=1, because it
// installs real dependencies (npm ci, uv sync). Each fixture is materialised twice (clean and
// with the committed pre-existing failure) and its own test command is run in the temp repo.
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  e2eEnabled,
  prepareFixtureRepo,
  runFixtureTests,
  toolAvailable,
  type FixtureName,
  type FixtureRepo,
} from "./fixture-repo.js";

const ROOT = join(tmpdir(), `omr-e2e-${randomBytes(4).toString("hex")}`);
const TIMEOUT = 300_000;

const CASES: { name: FixtureName; testDir: string; pattern: RegExp; min: number }[] = [
  { name: "vitest-app", testDir: "test", pattern: /\.test\.js$/, min: 40 },
  { name: "jest-app", testDir: "test", pattern: /\.test\.js$/, min: 20 },
  { name: "pytest-app", testDir: "tests", pattern: /^test_.*\.py$/, min: 20 },
];

/**
 * ANSI escape sequences (CSI, including SGR colours). vitest colours its summary whenever `CI` is
 * set, even into a pipe (CI round 1: `\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed`), so the
 * summary is only parseable once they are stripped.
 */
const ANSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** The failed-test count from a runner's summary line, or undefined when there is none. */
function countFailed(output: string): number | undefined {
  // vitest "      Tests  1 failed | 125 passed (126)", jest "Tests:       1 failed, 63 passed, 64 total",
  // pytest "==== 1 failed, 63 passed in 0.2s ====". One summary line each, matched per line.
  const text = output.replace(ANSI_RE, "").replace(/\r\n?/g, "\n");
  const m = /^[ \t]*Tests:?[ \t]+(\d+) failed\b/m.exec(text) ?? /^=+ (\d+) failed\b/m.exec(text);
  return m ? Number(m[1]) : undefined;
}

// Always runs (no install): the parser against the summaries the runners really print.
describe("e2e fixtures self-check: failed-count parser", () => {
  it("reads vitest's coloured CI summary (CI round 1), CRLF included", () => {
    const ci = "\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m42 passed\u001b[39m\u001b[22m\u001b[90m (43)\u001b[39m\r\n"
      + "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m126 passed\u001b[39m\u001b[22m\u001b[90m (127)\u001b[39m\r\n";
    expect(countFailed(ci)).toBe(1);
  });

  it("reads the plain vitest, jest and pytest summaries", () => {
    expect(countFailed(" Test Files  1 failed | 42 passed (43)\n      Tests  1 failed | 126 passed (127)\n")).toBe(1);
    expect(countFailed("Tests:       1 failed, 63 passed, 64 total\n")).toBe(1);
    expect(countFailed("=========== 1 failed, 63 passed in 0.52s ===========\n")).toBe(1);
  });

  it("is undefined without a summary, and ignores a test named like one", () => {
    expect(countFailed("")).toBeUndefined();
    expect(countFailed("  × Tests 2 failed somewhere\n      Tests  3 passed (3)\n")).toBeUndefined();
  });
});

const suite = e2eEnabled() ? describe : describe.skip;

suite("e2e fixtures self-check", () => {
  const repos: FixtureRepo[] = [];
  const uvMissing = !toolAvailable("uv");

  afterAll(async () => {
    for (const r of repos) await r.dispose();
    await rm(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, TIMEOUT);

  for (const c of CASES) {
    const skipPython = c.name === "pytest-app" && uvMissing && !process.env.CI;
    const test = skipPython ? it.skip : it;
    if (skipPython) console.warn(`[e2e] uv not found: skipping ${c.name} (it is required in CI)`);

    test(`${c.name}: clean repo passes`, { timeout: TIMEOUT }, async () => {
      const started = Date.now();
      const repo = await prepareFixtureRepo(c.name, { root: ROOT });
      repos.push(repo);
      console.log(`[e2e] ${c.name} prepared (copy+git+install) in ${Date.now() - started} ms`);
      expect(existsSync(repo.sentinelPath)).toBe(true);
      expect(repo.git("status", "--porcelain")).toBe("");

      const files = readdirSync(join(repo.dir, c.testDir)).filter((f) => c.pattern.test(f));
      expect(files.length).toBeGreaterThanOrEqual(c.min);

      const r = runFixtureTests(repo);
      console.log(`[e2e] ${c.name} clean run: exit ${String(r.status)} in ${r.ms} ms`);
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });

    test(`${c.name}: committed pre-existing failure fails exactly one test`, { timeout: TIMEOUT }, async () => {
      const started = Date.now();
      const repo = await prepareFixtureRepo(c.name, { root: ROOT, preexisting: true });
      repos.push(repo);
      console.log(`[e2e] ${c.name} prepared with preexisting in ${Date.now() - started} ms`);
      expect(repo.git("log", "-1", "--format=%s")).toBe("preexisting failure");
      expect(repo.git("status", "--porcelain")).toBe("");

      const r = runFixtureTests(repo);
      const out = r.stdout + r.stderr;
      console.log(`[e2e] ${c.name} preexisting run: exit ${String(r.status)} in ${r.ms} ms`);
      expect(r.status, out).not.toBe(0);
      expect(countFailed(out), out).toBe(1);
    });
  }
});
