// Cross-repo P3a (Y5): a consumer testsPass with scope=affected runs `vitest related` through a link
// into the changed repository W, with this repository's own vitest, in temp dirs (spike C1/R1).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { access, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectTestsPassHook, createScopeOpener, runDeterministic } from "../../src/verify/deterministic";
import { runArgv, runShell } from "../../src/verify/exec";
import { crossLinkAliases } from "../../src/verify/perimeter";
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

/** The planner's git searches find nothing here: a related run needs none (vitest's own graph selects). */
const noSearch: TestSearchSeam = {
  findByName: async () => [],
  findByContent: async () => [],
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
  return createDirectTestsPassHook({ openScope, plannerFs: nodeFs, search: noSearch, budget });
}

/** One foreign testsPass with an explicit scope=affected in C, run as the gate runs it for a change in L (W). */
async function runConsumerCheck(fx: Fixture, command: string, changed: readonly string[]) {
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
    // uses-lib.test.js's one test; other.test.js (one test, no import of the lib) is not selected.
    if (scoped?.kind === "ran") expect(scoped.result.total).toBe(1);
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

  it("an L change that breaks C: unverifiable, never fail", async () => {
    const changed = changeLib(fx, "index.js", "export function add(a, b) {\n  return a - b;\n}\n");
    const { verdict, runs, failures } = await runConsumerCheck(fx, "npx vitest run", [changed]);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.pass).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.scoped.kind).toBe("ran");
    expect(failures).toEqual([]);
  }, RUN_TIMEOUT_MS);

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
