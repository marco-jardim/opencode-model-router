// Cross-repo P3a (Y5): a consumer testsPass with scope=affected runs `vitest related` through a link
// into the changed repository W, with this repository's own vitest, in temp dirs (spike C1/R1).
// QA-1 M2/m4: the planner's searches are real git (the completeness check finds the consumer tests that
// name W's package), and the hook gets wiring.ts's ignored-module lister and the dispatch start (D23).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { access, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectTestsPassHook, createScopeOpener, runDeterministic } from "../../src/verify/deterministic";
import { runArgv, runShell } from "../../src/verify/exec";
import { crossLinkAliases } from "../../src/verify/perimeter";
import { fileMtimeMs, listIgnoredModules } from "../../src/verify/tree";
import type { RunnerFs, TestSearchSeam } from "../../src/verify/runner";
import type { TestsPassHook, TestsPassRun } from "../../src/verify/types";
import { resolveVerifyBudget, type VerifyBudget } from "../../src/router/config";

/** wiring.ts's fsSeam over absolute paths: the native realpath, fileExists accepting directories. */
const nodeFs: RunnerFs = {
  async fileExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
  readFile: p => readFile(p, "utf-8"),
  realpath: p => realpath(p),
  async stat(p) {
    const s = await stat(p, { bigint: true });
    return { isFile: s.isFile(), size: s.size, dev: s.dev, ino: s.ino };
  },
  readdir: p => readdir(p),
  async unlink(p) {
    try {
      await unlink(p);
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err;
    }
  },
};

/** git's stdout split on NUL into absolute paths under `root`. */
function nulPaths(root: string, out: string): string[] {
  return out.split("\0").filter(Boolean).map(rel => join(root, rel));
}

/**
 * wiring.ts's TestSearchSeam over real git (TestSearchSeam's contract: `git ls-files` and `git grep -l -z -F --untracked`,
 * exit 1 = no match, any other failure = undefined). QA-1 M2: the completeness check searches the consumer's test files for
 * W's package names with it.
 */
const gitSearch: TestSearchSeam = {
  async findByName(gitRoot, names) {
    try {
      const specs = names.map(n => `:(glob)**/${n}`);
      return nulPaths(gitRoot, execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...specs], { cwd: gitRoot, encoding: "utf8" }));
    } catch {
      return undefined;
    }
  },
  async findByContent(gitRoot, needle, globs, options) {
    const args = ["grep", "-l", "-z", "-F", "--untracked", ...(options?.word === true ? ["-w"] : []), "-e", needle, "--", ...globs];
    try {
      return nulPaths(gitRoot, execFileSync("git", args, { cwd: gitRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch (err) {
      return (err as { status?: number }).status === 1 ? [] : undefined;
    }
  },
};

/** The production direct hook (wiring.ts buildGateDeps) over real processes, no batching, no recheck reference. */
function realHook(budget: VerifyBudget): TestsPassHook {
  const openScope = createScopeOpener({
    argv: (file, args, opts) => runArgv(file, args, { cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeoutMs ?? RUN_TIMEOUT_MS, signal: opts?.signal, env: opts?.env }),
    exec: (command, opts) => runShell(command, { cwd: opts?.cwd ?? process.cwd(), timeoutMs: opts?.timeoutMs ?? RUN_TIMEOUT_MS, signal: opts?.signal, env: opts?.env }),
    fs: nodeFs,
    budget,
    checkTimeoutMs: RUN_TIMEOUT_MS,
  });
  return createDirectTestsPassHook({
    openScope,
    plannerFs: nodeFs,
    search: gitSearch,
    budget,
    // wiring.ts: W's git-ignored modules modified at or after the dispatch start (D23, QA C1).
    listIgnored: (root, signal, since) => listIgnoredModules(root, { signal, since, lowPriority: budget.lowPriority }),
    // wiring.ts (QA round 2 M-A): a changed source of W newer than the newest listed build output → S6 build-stale.
    mtimeOf: fileMtimeMs,
  });
}

/**
 * One foreign testsPass with an explicit scope=affected in C, run as the gate runs it for a change in L (W). `dispatchStartedAt`
 * (D23): the dispatch start the gate passes on; W's ignored modules older than it are never inputs.
 */
async function runConsumerCheck(fx: Fixture, command: string, changed: readonly string[], dispatchStartedAt = Date.now() - 60_000) {
  const budget = resolveVerifyBudget(undefined, { cores: 2 });
  const direct = realHook(budget);
  const runs: TestsPassRun[] = [];
  const testsPass: TestsPassHook = async req => {
    const run = await direct(req);
    runs.push(run);
    return run;
  };
  const failures: string[] = [];
  const verdict = await runDeterministic(
    { kind: "deterministic", checks: [{ kind: "testsPass", command }], criteria: [], deliverable: null, source: "explicit" },
    {
      exec: (cmd, opts) => runShell(cmd, { cwd: opts?.cwd ?? fx.lib, timeoutMs: opts?.timeoutMs ?? RUN_TIMEOUT_MS, signal: opts?.signal }),
      fs: nodeFs,
      cwd: fx.lib,
      budget,
      testsPass,
      changedFiles: changed.map(path => ({ path, status: "M" })),
      placements: [{ cwd: fx.consumer, top: fx.consumer, foreign: true, scope: "affected" }],
      changeRoot: fx.lib,
      crossLinkAliases: consumerCwd => crossLinkAliases(consumerCwd, fx.lib),
      onFailure: reason => failures.push(reason),
      timeoutMs: RUN_TIMEOUT_MS,
      dispatchStartedAt,
    },
  );
  return { verdict, runs, failures };
}

const IS_WIN = process.platform === "win32";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** `path` with the case of its last segment's letters flipped (win32 only: the junction target text differs from the disk). */
function flipLastSegmentCase(path: string): string {
  const parent = dirname(path);
  const last = path.slice(parent.length).replace(/^[\\/]+/, "");
  const flipped = [...last].map(ch => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("");
  return join(parent, flipped);
}

/** A directory link: a win32 junction whose target text differs in case from the disk, a posix directory symlink. */
function linkDir(target: string, link: string): void {
  mkdirSync(dirname(link), { recursive: true });
  if (IS_WIN) symlinkSync(flipLastSegmentCase(target), link, "junction");
  else symlinkSync(target, link, "dir");
}

/** A fresh temp directory, as the disk spells it (no 8.3 names, no /var -> /private/var; removed by the caller). */
function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

/** This repository's own vitest package (the consumer links it: the hook resolves `<cwd>/node_modules/vitest`). */
const OWN_VITEST = join(process.cwd(), "node_modules", "vitest");

const LIB_NAME = "xlink-lib";

/** The temp layout: lib repository L (= W, the changed repository) and consumer repository C linking L. */
interface Fixture {
  readonly base: string;
  readonly lib: string;
  readonly consumer: string;
}

function commitAll(repo: string): void {
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
}

/**
 * L exports `add` (index.js, imported by C's uses-lib test) and `unused` (unused.js, imported by no C test). C has two tests:
 * uses-lib.test.js imports the lib through `C/node_modules/xlink-lib`; other.test.js imports nothing of it.
 */
function makeFixture(): Fixture {
  const base = tempDir("omr-xlink-");
  const lib = join(base, "lib");
  const consumer = join(base, "consumer");
  write(join(lib, "package.json"), JSON.stringify({ name: LIB_NAME, version: "1.0.0", type: "module", main: "index.js" }, null, 2));
  write(join(lib, "index.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  write(join(lib, "unused.js"), "export const unused = 1;\n");
  git(lib, "init", "-q");
  commitAll(lib);

  write(join(consumer, "package.json"), JSON.stringify({ name: "xlink-consumer", version: "1.0.0", type: "module", private: true }, null, 2));
  write(join(consumer, ".gitignore"), "node_modules\n");
  write(
    join(consumer, "test", "uses-lib.test.js"),
    `import { expect, test } from "vitest";\nimport { add } from "${LIB_NAME}";\n\ntest("adds through the link", () => {\n  expect(add(1, 2)).toBe(3);\n});\n`,
  );
  write(join(consumer, "test", "other.test.js"), `import { expect, test } from "vitest";\n\ntest("other", () => {\n  expect(1).toBe(1);\n});\n`);
  git(consumer, "init", "-q");
  commitAll(consumer);
  // The lib through C/node_modules (win32: a junction whose target text differs in case from the disk, as in the spike).
  linkDir(lib, join(consumer, "node_modules", LIB_NAME));
  // This repository's vitest 5 (SD-P3a-4), its target spelled as on disk.
  symlinkSync(OWN_VITEST, join(consumer, "node_modules", "vitest"), IS_WIN ? "junction" : "dir");
  return { base, lib, consumer };
}

function removeFixture(fx: Fixture): void {
  rmSync(fx.base, { recursive: true, force: true, maxRetries: 3 });
}

/** Changes `rel` in L (uncommitted: W's change set) and returns its absolute path, as the gate passes it. */
function changeLib(fx: Fixture, rel: string, text: string): string {
  const abs = join(fx.lib, rel);
  write(abs, text);
  return abs;
}

/** Bounds for one related run of this repository's vitest over a two-file consumer. */
const RUN_TIMEOUT_MS = 120_000;

describe.skipIf(!existsSync(join(OWN_VITEST, "vitest.mjs")))("cross-link related run (cross-repo P3a, Y5)", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    removeFixture(fx);
  });

  it("the consumer's link spells W as vite does (win32: the junction's stored target text, not the disk case)", () => {
    const aliases = crossLinkAliases(fx.consumer, fx.lib);
    expect(aliases).toContain(IS_WIN ? flipLastSegmentCase(fx.lib) : fx.lib);
    expect(aliases.some(alias => alias.split(/[\\/]/).includes("node_modules"))).toBe(false);
  });

  it("an L change C still passes: pass with scope=affected, only the importing test selected", async () => {
    const changed = changeLib(fx, "index.js", "export function add(a, b) {\n  // still a sum\n  return b + a;\n}\n");
    const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [changed]);
    expect(verdict.reasons).toEqual(["all 1 deterministic checks passed"]);
    expect(verdict.outcome).toBe("pass");
    expect(runs).toHaveLength(1);
    const scoped = runs[0]?.scoped;
    expect(scoped?.kind).toBe("ran");
    // QA m4: WHICH file ran, by file: uses-lib.test.js (its one test); other.test.js (no import of the lib) is not selected.
    if (scoped?.kind === "ran") {
      expect(scoped.result.testsByFile).toEqual({ "test/uses-lib.test.js": 1 });
      expect(scoped.result.complete).toBe(true);
    }
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("an L change that breaks C: the failure is observed, and the verdict is unverifiable, never fail", async () => {
    const changed = changeLib(fx, "index.js", "export function add(a, b) {\n  return a - b;\n}\n");
    const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [changed]);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.pass).toBe(false);
    expect(runs).toHaveLength(1);
    const scoped = runs[0]?.scoped;
    expect(scoped?.kind).toBe("ran");
    // QA m4: the run really failed in uses-lib.test.js (a complete inventory), not merely an unverifiable run.
    if (scoped?.kind === "ran") {
      expect(scoped.result.failingIds).toEqual(["test/uses-lib.test.js > adds through the link"]);
      expect(scoped.result.complete).toBe(true);
      expect(scoped.result.testsByFile).toEqual({ "test/uses-lib.test.js": 1 });
    }
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("QA-1 M2: a consumer test vitest misses (a require() of the lib) makes the run unverifiable through the completeness check", async () => {
    // A second consumer test reaches the lib through createRequire: vite's graph never sees it, so `vitest related` misses it.
    write(
      join(fx.consumer, "test", "requires-lib.test.js"),
      'import { createRequire } from "node:module";\nimport { expect, test } from "vitest";\n\n' +
        "const require = createRequire(import.meta.url);\n\n" +
        `test("reads the lib through require", () => {\n  expect(require("${LIB_NAME}/package.json").name).toBe("${LIB_NAME}");\n});\n`,
    );
    const changed = changeLib(fx, "index.js", "export function add(a, b) {\n  // still a sum\n  return b + a;\n}\n");
    const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [changed]);
    expect(runs).toHaveLength(1);
    const scoped = runs[0]?.scoped;
    expect(scoped?.kind).toBe("ran");
    if (scoped?.kind === "ran") {
      // vitest selected only the importing test, and it passed ...
      expect(scoped.result.testsByFile).toEqual({ "test/uses-lib.test.js": 1 });
      expect(scoped.result.failingIds).toEqual([]);
      // ... but the run is incomplete: requires-lib.test.js names the lib and did not run.
      expect(scoped.result.complete).toBe(false);
      expect(scoped.result.note).toBe(
        "vitest did not run 1 consumer test file(s) that import the linked repository (test/requires-lib.test.js); " +
          "the link may not be followed: use scope=full",
      );
    }
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join("\n")).toContain("vitest did not run 1 consumer test file(s) that import the linked repository");
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

  describe("D23: W's main is a git-ignored build output (dist/)", () => {
    /** L's entry becomes dist/index.js, ignored by git; src/index.js is its tracked source. */
    function buildLib(): { src: string; dist: string } {
      write(join(fx.lib, "package.json"), JSON.stringify({ name: LIB_NAME, version: "1.0.0", type: "module", main: "dist/index.js" }, null, 2));
      write(join(fx.lib, ".gitignore"), "dist\n");
      const src = join(fx.lib, "src", "index.js");
      write(src, "export function add(a, b) {\n  return a + b;\n}\n");
      const dist = join(fx.lib, "dist", "index.js");
      write(dist, "export function add(a, b) {\n  return a + b;\n}\n");
      commitAll(fx.lib);
      return { src, dist };
    }

    it("the producer rebuilt dist (mtime at or after the dispatch start): the consumer test is selected and passes", async () => {
      const { src, dist } = buildLib();
      const started = Date.now() - 5_000;
      write(src, "export function add(a, b) {\n  return b + a;\n}\n");
      write(dist, "export function add(a, b) {\n  return b + a;\n}\n");
      const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [src], started);
      expect(verdict.reasons).toEqual(["all 1 deterministic checks passed"]);
      expect(verdict.outcome).toBe("pass");
      const scoped = runs[0]?.scoped;
      expect(scoped?.kind).toBe("ran");
      if (scoped?.kind === "ran") {
        expect(scoped.result.testsByFile).toEqual({ "test/uses-lib.test.js": 1 });
        expect(scoped.result.complete).toBe(true);
      }
      expect(failures).toEqual([]);
    }, RUN_TIMEOUT_MS);

    it("a stale dist (mtime before the dispatch start) is no input: zero selection, unverifiable", async () => {
      const { src, dist } = buildLib();
      const old = new Date(Date.now() - 600_000);
      utimesSync(dist, old, old);
      write(src, "export function add(a, b) {\n  return b + a;\n}\n");
      const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [src], Date.now() - 5_000);
      expect(verdict.outcome).toBe("unverifiable");
      expect(verdict.reasons.join("\n")).toContain(`vitest selected no test in ${fx.consumer} for the change in ${fx.lib}`);
      const scoped = runs[0]?.scoped;
      expect(scoped?.kind).toBe("ran");
      if (scoped?.kind === "ran") expect(scoped.result.total).toBe(0);
      expect(failures).toEqual([]);
    }, RUN_TIMEOUT_MS);

    it("QA round 2 M-A: src edited again after the build (dist fresh, but older than src): unverifiable cross-link-build-stale, never a pass on the intermediate build", async () => {
      const { src, dist } = buildLib();
      const started = Date.now() - 60_000;
      const edited = new Date(started + 10_000);
      const built = new Date(started + 20_000);
      const reedited = new Date(started + 30_000);
      // The producer edits src, builds dist (fresh: after the dispatch start), then edits src again, breaking C, and never rebuilds.
      write(src, "export function add(a, b) {\n  return b + a;\n}\n");
      utimesSync(src, edited, edited);
      write(dist, "export function add(a, b) {\n  return b + a;\n}\n");
      utimesSync(dist, built, built);
      write(src, "export function add(a, b) {\n  return a - b;\n}\n");
      utimesSync(src, reedited, reedited);
      const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [src], started);
      expect(verdict.outcome).toBe("unverifiable");
      const scoped = runs[0]?.scoped;
      expect(scoped?.kind).toBe("unverifiable");
      if (scoped?.kind === "unverifiable") {
        expect(scoped.code).toBe("cross-link-build-stale");
        expect(scoped.reason.startsWith("the build output in ")).toBe(true);
        expect(scoped.reason.endsWith(
          "/dist is older than src/index.js changed in the linked repository; " +
          "rebuild it (e.g. a buildPasses check in the linked repository before this one) or use scope=full",
        )).toBe(true);
      }
      expect(verdict.reasons.join("\n")).toContain("is older than src/index.js changed in the linked repository");
      expect(failures).toEqual([]);
    }, RUN_TIMEOUT_MS);
  });

  it("an L change no C test imports: unverifiable with the zero-selection note", async () => {
    const changed = changeLib(fx, "unused.js", "export const unused = 2;\n");
    const { verdict, failures } = await runConsumerCheck(fx, "npx vitest run", [changed]);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.reasons.join("\n")).toContain(`vitest selected no test in ${fx.consumer} for the change in ${fx.lib}`);
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("a jest command: S6 cross-link-unsupported, nothing spawned", async () => {
    write(join(fx.consumer, "node_modules", "jest", "package.json"), JSON.stringify({ name: "jest", version: "29.7.0", bin: { jest: "bin/jest.js" } }));
    write(join(fx.consumer, "node_modules", "jest", "bin", "jest.js"), "process.exit(0);\n");
    const changed = changeLib(fx, "index.js", "export function add(a, b) {\n  return b + a;\n}\n");
    const { verdict, runs, failures } = await runConsumerCheck(fx, "npx jest", [changed]);
    expect(verdict.outcome).toBe("unverifiable");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scoped).toMatchObject({ kind: "unverifiable", code: "cross-link-unsupported" });
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);
});
