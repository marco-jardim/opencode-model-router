/**
 * Phase 3.1.2.a: the verification guardrail matrix, end to end on real runners.
 *
 * The REAL plugin (no mocks: real runArgv, real slot, real reference worktrees) is driven against
 * temp git copies of the three fixture projects, through both entry points: `VERIFY:required`
 * dispatches (the synchronous gate) and deferred dispatches followed by `router_verify`.
 *
 * Opt-in: RUN_VERIFY_E2E=1. TEMP/TMP/TMPDIR point into a private root for the whole file, so the
 * machine-wide verification slot and the reference worktrees are isolated from other runs.
 */
import { lstat, mkdir, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { e2eEnabled, prepareFixtureRepo, readProbeLog, type FixtureName, type FixtureRepo, type ProbeEntry } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin } from "./e2e/harness";
import { mentionsAny, pathSpellings } from "./e2e/sampler";

const d = e2eEnabled() ? describe : describe.skip;

const TEST_TIMEOUT = 120_000;
const SETUP_TIMEOUT = 600_000;
const HANDLE_RE = /vrf_[0-9a-f]{24}/;
const TEMP_KEYS = ["TEMP", "TMP", "TMPDIR"] as const;

type Mode = "required" | "deferred";
type Expect = "rejected" | "accepted-preexisting" | "no-affected" | "unverifiable" | "accepted";

interface RunnerSpec {
  name: FixtureName;
  /** Full-suite test count of the fixture (self-check), for the "no full suite" assertion. */
  fullCount: number;
  /** Source module the pre-existing failing test imports (behaviour-neutral edit target). */
  preModule: string;
  /** Behaviour-neutral addition to preModule. */
  neutral: string;
  /** A different module, broken by replacing `breakFrom` with `breakTo`. */
  breakModule: string;
  breakFrom: string;
  breakTo: string;
  /** Test id fragments: a test that the break makes fail, and the pre-existing failing test. */
  introducedId: string;
  preexistingId: string;
  /** A config file whose edit makes the scoped run unverifiable. */
  configFile: string;
  configAppend: string;
  /** pytest cannot recheck failures against the reference (approved deviation 5). */
  recheckUnsupported: boolean;
}

const RUNNERS: RunnerSpec[] = [
  {
    name: "vitest-app",
    fullCount: 126,
    preModule: "src/m01.js",
    neutral: "\nexport function unused01() {\n  return 0;\n}\n",
    breakModule: "src/m02.js",
    breakFrom: "return x + 2;",
    breakTo: "return x + 200;",
    introducedId: "value adds 2",
    preexistingId: "asserts something false",
    configFile: "vitest.config.js",
    configAppend: "\n// touched by the e2e matrix\n",
    recheckUnsupported: false,
  },
  {
    name: "jest-app",
    fullCount: 63,
    preModule: "src/a01.js",
    neutral: "\nmodule.exports.unused01 = function unused01() {\n  return 0;\n};\n",
    breakModule: "src/a02.js",
    breakFrom: "return x * 2;",
    breakTo: "return x * 200;",
    introducedId: "multiplies by 2",
    preexistingId: "asserts something false",
    configFile: "jest.config.js",
    configAppend: "\n// touched by the e2e matrix\n",
    recheckUnsupported: false,
  },
  {
    name: "pytest-app",
    fullCount: 63,
    preModule: "app/mod01.py",
    neutral: "\n\ndef unused01():\n    return 0\n",
    breakModule: "app/mod02.py",
    breakFrom: "return x - 2",
    breakTo: "return x - 200",
    introducedId: "test_mod02_1.py::test_value_subtracts",
    preexistingId: "test_preexisting.py::test_asserts_something_false",
    configFile: "tests/conftest.py",
    configAppend: "\n# touched by the e2e matrix\n",
    recheckUnsupported: true,
  },
];

interface Scenario {
  key: string;
  title: string;
  preexisting: boolean;
  produce(repo: FixtureRepo, r: RunnerSpec): Promise<void>;
  expected(r: RunnerSpec): Expect;
  /** The files the producer edits, fired as its child session's `edit` tool calls (QA-3.1-15 d). */
  edits(r: RunnerSpec): string[];
  /** Only for these fixtures (default: all). */
  only?: FixtureName[];
  /** QA-3.1-9: whether the verdict must rest on a scoped runner run (else: no runner may start). */
  runs: boolean;
  /** The introduced failing test id, when not the runner's `introducedId`. */
  introducedId?: string;
}

const JEST_SETUP = "jest.setup.js";
const DYNAMIC_TARGET = "src/m07.js";
/** vitest-app's test/dynamic.test.js ids (they fail when m07's value07 breaks, if the file runs). */
const DYNAMIC_IDS = ["loads a module through a computed specifier"];
/**
 * Measured (the dynamic cell, vitest 4.1.11): `vitest related src/m07.js` DOES run
 * test/dynamic.test.js. Vite resolves the template-literal specifier `../src/${which}.js` to a glob
 * over src/*.js, so the module graph links the file to every src module; the plan §5 blind spot
 * does not arise for this shape under vitest.
 */
const DYNAMIC_RUNS = true;
/** Probe timestamps (pytest's int(time.time() * 1000)) against Date.now(): same clock, truncation only. */
const PROBE_CLOCK_SLACK_MS = 5;

/** Logs the verdicts; with OMR_E2E_REPORT=<file> also appends them there (vitest may hide a passing test's console). */
function emit(text: string): void {
  console.log(text);
  const file = process.env.OMR_E2E_REPORT;
  if (file !== undefined && file !== "") appendFileSync(file, `${text}\n`, "utf8");
}

async function breakModule(repo: FixtureRepo, r: RunnerSpec): Promise<void> {
  const p = join(repo.dir, r.breakModule);
  const src = readFileSync(p, "utf8");
  expect(src).toContain(r.breakFrom);
  await repo.write(r.breakModule, src.replace(r.breakFrom, r.breakTo));
}

async function neutralEdit(repo: FixtureRepo, r: RunnerSpec): Promise<void> {
  const src = readFileSync(join(repo.dir, r.preModule), "utf8");
  await repo.write(r.preModule, src + r.neutral);
}

const SCENARIOS: Scenario[] = [
  {
    key: "green",
    title: "green control (neutral source edit)",
    preexisting: false,
    produce: neutralEdit,
    expected: () => "accepted",
    edits: r => [r.preModule],
    runs: true,
  },
  {
    key: "introduced",
    title: "introduced failure",
    preexisting: false,
    produce: breakModule,
    expected: r => (r.recheckUnsupported ? "unverifiable" : "rejected"),
    edits: r => [r.breakModule],
    runs: true,
  },
  {
    key: "preexisting",
    title: "pre-existing failure only",
    preexisting: true,
    produce: neutralEdit,
    expected: r => (r.recheckUnsupported ? "unverifiable" : "accepted-preexisting"),
    edits: r => [r.preModule],
    runs: true,
  },
  {
    key: "pre-and-introduced",
    title: "pre-existing + introduced failure",
    preexisting: true,
    produce: breakModule,
    expected: r => (r.recheckUnsupported ? "unverifiable" : "rejected"),
    edits: r => [r.breakModule],
    runs: true,
  },
  {
    key: "docs",
    title: "docs-only change",
    preexisting: false,
    produce: async repo => {
      await repo.write("docs/x.md", "# Notes\n\nDocumentation only.\n");
    },
    expected: () => "no-affected",
    edits: () => ["docs/x.md"],
    runs: false,
  },
  {
    key: "config",
    title: "test config change",
    preexisting: false,
    produce: async (repo, r) => {
      const src = readFileSync(join(repo.dir, r.configFile), "utf8");
      await repo.write(r.configFile, src + r.configAppend);
    },
    expected: () => "unverifiable",
    edits: r => [r.configFile],
    runs: false,
  },
  {
    // QA-3.1-15 (b): jest-app's setupFilesAfterEnv file. It runs in every scoped jest run (the probe
    // line it writes is asserted in the source-edit cells), so an edit to it changes every test.
    key: "setup",
    title: "jest setup file change",
    preexisting: false,
    only: ["jest-app"],
    produce: async repo => {
      const src = readFileSync(join(repo.dir, JEST_SETUP), "utf8");
      await repo.write(JEST_SETUP, `${src}\nglobalThis.__JEST_APP_SETUP_EDITED__ = true;\n`);
    },
    expected: () => "unverifiable",
    edits: () => [JEST_SETUP],
    runs: false,
  },
  {
    // QA-3.1-15 (c): test/dynamic.test.js reaches src/m07.js only through a computed import
    // specifier (plan §5's documented blind spot). The cell records what `vitest related` does with it.
    key: "dynamic",
    title: "dynamic-import target change",
    preexisting: false,
    only: ["vitest-app"],
    produce: async repo => {
      const src = readFileSync(join(repo.dir, DYNAMIC_TARGET), "utf8");
      expect(src).toContain("return x + 7;");
      await repo.write(DYNAMIC_TARGET, src.replace("return x + 7;", "return x + 700;"));
    },
    expected: () => "rejected",
    introducedId: "value adds 7",
    edits: () => [DYNAMIC_TARGET],
    runs: true,
  },
];

let root = "";
const savedTemp = new Map<string, string | undefined>();

/** Removes a directory tree without recursing through junctions/symlinks into their targets. */
async function removeTree(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const e of entries) {
    const p = join(dir, e.name);
    const st = await lstat(p);
    if (st.isSymbolicLink()) await unlink(p);
    else if (st.isDirectory()) await removeTree(p);
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

beforeAll(async () => {
  if (!e2eEnabled()) return;
  // The raw os.tmpdir() on purpose: on Windows it is often an 8.3 short path
  // (C:\Users\ABCDEF~1\...), and the plugin directory, TEMP and the reference worktrees must all
  // work under that spelling (E2E-2).
  root = await mkdtemp(join(os.tmpdir(), "omr-e2e-"));
  await mkdir(join(root, "repos"), { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  for (const k of TEMP_KEYS) {
    savedTemp.set(k, process.env[k]);
    process.env[k] = join(root, "tmp");
  }
});

afterAll(async () => {
  if (!e2eEnabled()) return;
  for (const [k, v] of savedTemp) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (root !== "") await removeTree(root);
}, SETUP_TIMEOUT);

/** Normalises the verdict text (the footer and the report may both be present). */
function classify(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const CAVEAT = "Verification caveats — NOT verified";

function assertVerdict(text: string, exp: Expect, r: RunnerSpec, mode: Mode, introducedId: string): void {
  const t = classify(text);
  if (mode === "deferred") {
    // The router_verify report: one verdict line per handle.
    const verdict = /· (pass|fail|unverifiable)\b/.exec(t)?.[1];
    const want = exp === "rejected" ? "fail" : exp === "unverifiable" ? "unverifiable" : "pass";
    expect(verdict, "router_verify verdict").toBe(want);
  }
  switch (exp) {
    case "accepted":
      // QA-3.1-18: a clean pass appends exactly the verified label, in both modes (the deferred
      // report also says "· pass", checked above).
      expect(t).toMatch(/\[router ✓ verified: (deterministic|checker)\]/);
      expect(t).not.toContain("UNVERIFIED");
      expect(t).not.toContain("NOT ACCEPTED");
      expect(t).not.toContain(CAVEAT);
      expect(t).not.toContain("introduced failures:");
      break;
    case "rejected":
      if (mode === "required") expect(t).toContain("NOT ACCEPTED");
      expect(t).not.toContain("[router ✓");
      expect(t).toContain("introduced failures:");
      expect(t).toContain(introducedId);
      break;
    case "accepted-preexisting":
      expect(t).toContain("[router ✓ verified:");
      expect(t).not.toContain("NOT ACCEPTED");
      expect(t).not.toContain("introduced failures:");
      expect(t).toContain("no worse than before; pre-existing failures:");
      expect(t).toContain("suite is NOT green");
      expect(t).toContain(r.preexistingId);
      break;
    case "no-affected":
      expect(t).not.toContain("NOT ACCEPTED");
      expect(t).not.toContain("introduced failures:");
      expect(t).toMatch(/no affected tests/);
      break;
    case "unverifiable":
      // Returned with a caveat (strictUnverifiable off), never a clean pass nor a rejection, and
      // never labelled accepted or verified (QA-3.1-21, plan G2).
      expect(t).toContain("[router ⚠ UNVERIFIED:");
      expect(t).not.toMatch(/\[router ✓|✓ accepted|verified:/);
      expect(t).toContain(CAVEAT);
      expect(t).not.toContain("NOT ACCEPTED");
      expect(t).not.toContain("introduced failures:");
      expect(t).not.toContain("no affected tests");
      break;
  }
}

/** Positional path arguments of a runner argv: test or source files (a scoped run names some). */
function fileArgs(argv: string[]): string[] {
  return argv.filter((a, i) => !a.startsWith("-") && !/^(?:--config|-c|--rootDir)$/.test(argv[i - 1] ?? "") && /\.(?:[cm]?js|py)$|::/.test(a));
}

/**
 * QA-3.1-9: ties the verdict to the verifier's own runner runs, recorded by the fixture's probe
 * (one `main` line per runner main process; jest-app also one `setupAfterEnv` line per test file).
 * Every run falls inside the verdict's window; a scenario that must run tests ran at least one
 * scoped main in the repo itself and never the full suite; one that must not run started nothing.
 */
function assertProbes(probes: ProbeEntry[], s: Scenario, r: RunnerSpec, repo: FixtureRepo, window: { from: number; to: number }): void {
  for (const p of probes) {
    expect(p.t, `probe outside the verdict window: ${JSON.stringify(p)}`).toBeGreaterThanOrEqual(window.from - PROBE_CLOCK_SLACK_MS);
    expect(p.t, `probe outside the verdict window: ${JSON.stringify(p)}`).toBeLessThanOrEqual(window.to + PROBE_CLOCK_SLACK_MS);
  }
  const mains = probes.filter(p => p.kind === "main");
  if (!s.runs) {
    expect(probes.map(p => p.argv)).toEqual([]);
    return;
  }
  expect(mains.length, "at least one runner main ran for the verdict").toBeGreaterThanOrEqual(1);
  for (const p of mains) {
    expect(fileArgs(p.argv).length, `a full-suite run: ${JSON.stringify(p.argv)}`).toBeGreaterThan(0);
    if (r.name === "vitest-app") expect(p.argv[0]).toMatch(/^(?:related|run)$/);
  }
  const own = pathSpellings(repo.dir);
  const inRepo = mains.filter(p => mentionsAny(p.cwd, own));
  expect(inRepo.length, "a scoped run in the repo itself (not only a reference worktree)").toBeGreaterThanOrEqual(1);
  if (r.name === "jest-app") {
    // QA-3.1-15 (b): the setupFilesAfterEnv file ran in the scoped run. (How many files it ran for
    // depends on the import graph: every jest-app test reaches src/a01.js, so an a01 edit relates all.)
    const setups = probes.filter(p => p.kind === "setupAfterEnv" && mentionsAny(p.cwd, own));
    expect(setups.length).toBeGreaterThanOrEqual(1);
  }
}

for (const r of RUNNERS) {
  d(`guardrail matrix on real ${r.name}`, { concurrent: false }, () => {
    let repo: FixtureRepo;
    let plugin: E2EPlugin;
    let basePlain = "";
    let basePre = "";
    let call = 0;
    let probeLog = "";

    beforeAll(async () => {
      await mkdir(join(root, "probe"), { recursive: true });
      probeLog = join(root, "probe", `${r.name}.log`);
      repo = await prepareFixtureRepo(r.name, { root: join(root, "repos"), preexisting: true, probeLog });
      basePre = repo.head();
      basePlain = repo.git("rev-parse", "HEAD~1");
      plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", r.name) });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await plugin?.dispose();
      await repo?.dispose();
    }, SETUP_TIMEOUT);

    afterEach(async () => {
      // No reference worktree may outlive its verification. Disposal may trail the verdict
      // slightly, so poll briefly before failing.
      let list = repo.git("worktree", "list");
      for (let i = 0; i < 50 && list.includes("omr-ref-"); i++) {
        await new Promise(res => setTimeout(res, 200));
        list = repo.git("worktree", "list");
      }
      expect(list).not.toContain("omr-ref-");
    }, 30_000);

    for (const s of SCENARIOS.filter(x => x.only === undefined || x.only.includes(r.name))) {
      for (const mode of ["required", "deferred"] as Mode[]) {
        // E2E-1 (fixed): pytest static scoping used to map an edited app/modNN.py to no test,
        // although tests/test_modNN_*.py import it, so a real introduced failure was accepted with
        // "no affected tests: no test files map to the changed modules". It now maps the importers.
        it(`${s.title} [${mode}] -> ${s.expected(r)}`, async () => {
          const base = s.preexisting ? basePre : basePlain;
          repo.git("reset", "-q", "--hard", base);
          repo.git("clean", "-q", "-fd", "-e", "node_modules", "-e", ".venv");
          const sessionID = `orch-${r.name}-${s.key}-${mode}`;
          call += 1;
          const callID = `call-${r.name}-${s.key}-${mode}-${call}`;
          const text = `Implement the ${s.key} change in ${r.name}.`;
          const prompt =
            (mode === "required" ? "VERIFY:required\n" : "") + `${text}\n` + acceptance(repo.testCommand);
          const probeStart = readProbeLog(probeLog).length;
          const res = await plugin.task({ sessionID, callID, prompt, produce: () => s.produce(repo, r), childEdits: s.edits(r) });
          emit(`--- ${r.name} ${s.key} ${mode} task() output ---\n${res.output}`);

          let verdictText = res.output;
          // QA-3.1-9: the window the verdict's runner runs must fall in: the gate (after hook) for
          // required, router_verify for deferred (nothing may run at dispatch or in the after hook).
          let window = { from: res.afterStartedAt, to: res.returnedAt };
          if (mode === "deferred") {
            const m = HANDLE_RE.exec(res.output);
            expect(m, "deferred output carries a vrf_ handle").not.toBeNull();
            expect(res.output).toContain("[router] unverified");
            const handle = m?.[0] ?? "";
            const from = Date.now();
            verdictText = await plugin.routerVerify({ handles: [handle] }, { sessionID });
            window = { from, to: Date.now() };
            emit(`--- ${r.name} ${s.key} ${mode} router_verify report ---\n${verdictText}`);
          }
          const probes = readProbeLog(probeLog).slice(probeStart);
          emit(`--- ${r.name} ${s.key} ${mode} probe (${probes.length}) ---\n${probes.map(p => `${p.kind} t+${p.t - window.from}ms ${p.cwd} ${JSON.stringify(p.argv)}`).join("\n")}`);
          assertProbes(probes, s, r, repo, window);

          const exp = s.expected(r);
          assertVerdict(verdictText, exp, r, mode, s.introducedId ?? r.introducedId);
          if (s.key === "dynamic") {
            // Measured behaviour: see DYNAMIC_RUNS.
            for (const id of DYNAMIC_IDS) {
              if (DYNAMIC_RUNS) expect(verdictText).toContain(id);
              else expect(verdictText).not.toContain(id);
            }
          }
          // E2E-1: the source-edit scenarios must run the edited module's tests, never pass as
          // "nothing to run" (the green control passed that way before the fix).
          if (s.key !== "docs" && s.key !== "config") expect(verdictText).not.toMatch(/no affected tests/);
          if (r.recheckUnsupported && exp === "unverifiable" && s.key !== "config") {
            // No recheck (approved deviation 5), so the failure cannot be attributed; the scoped
            // run must still have run the mapped tests and observed the failing ids.
            const observed = /observed failures: ([^\n]*)/.exec(verdictText)?.[1] ?? "";
            expect(observed).toContain(s.key === "preexisting" ? r.preexistingId : r.introducedId);
          }
          if (s.key === "config") expect(verdictText).toContain(`config-changed): config file changed: ${r.configFile}`);
          if (s.key === "pre-and-introduced" && exp === "rejected") {
            // Only the introduced id is presented as introduced.
            const line = /introduced failures: ([^\n;]*)/.exec(verdictText)?.[1] ?? "";
            expect(line).toContain(r.introducedId);
            expect(line).not.toContain(r.preexistingId);
          }
        }, TEST_TIMEOUT);
      }
    }
  });
}

/**
 * QA-G-10 (regression, the round-2 repro): the base adds combo02() to app/mod02.py, and
 * tests/test_combo.py imports the module in isort's default grid wrap. The producer breaks combo02.
 * QA-G-2's import-shaped search missed test_combo.py: the scoped pytest argv held only
 * test_mod02_1.py, and the result read `[router ✓ verified: deterministic]` over a failing importer.
 */
d("QA-G-10: a pytest importer in isort's grid wrap is selected (real pytest-app)", { concurrent: false }, () => {
  let repo: FixtureRepo;
  let plugin: E2EPlugin;
  let probeLog = "";
  const COMBO = "    return value02(x) + 1";

  beforeAll(async () => {
    await mkdir(join(root, "probe"), { recursive: true });
    probeLog = join(root, "probe", "pytest-app-qag10.log");
    repo = await prepareFixtureRepo("pytest-app", { root: join(root, "repos"), probeLog });
    const mod02 = readFileSync(join(repo.dir, "app/mod02.py"), "utf8");
    await repo.write("app/mod02.py", `${mod02}\n\ndef combo02(x):\n${COMBO}\n`);
    await repo.write(
      "tests/test_combo.py",
      "from app import (mod01, mod03, mod04,\n                 mod05, mod02)\n\n\ndef test_combo02():\n    assert mod02.combo02(10) == 9\n",
    );
    repo.commit("base: combo02 and its isort-grid importer");
    plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "pytest-app-qag10") });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await plugin?.dispose();
    await repo?.dispose();
  }, SETUP_TIMEOUT);

  it("pytest VERIFY:required, combo02 broken -> test_combo.py is in the scoped argv and the result is not a verified pass", async () => {
    const probeStart = readProbeLog(probeLog).length;
    const res = await plugin.task({
      sessionID: "orch-pytest-app-qag10",
      callID: "call-pytest-app-qag10",
      prompt: `VERIFY:required\nBreak combo02 in pytest-app.\n${acceptance(repo.testCommand)}`,
      produce: async () => {
        const src = readFileSync(join(repo.dir, "app/mod02.py"), "utf8");
        expect(src).toContain(COMBO);
        await repo.write("app/mod02.py", src.replace(COMBO, "    return value02(x) + 100"));
      },
      childEdits: ["app/mod02.py"],
    });
    emit(`--- pytest-app QA-G-10 task() output ---\n${res.output}`);
    const own = pathSpellings(repo.dir);
    const mains = readProbeLog(probeLog)
      .slice(probeStart)
      .filter(p => p.kind === "main" && mentionsAny(p.cwd, own));
    emit(`--- pytest-app QA-G-10 probe (${mains.length}) ---\n${mains.map(p => JSON.stringify(p.argv)).join("\n")}`);
    expect(mains.length, "a scoped pytest run in the repo").toBeGreaterThanOrEqual(1);
    for (const p of mains) {
      const files = fileArgs(p.argv);
      expect(files.some(a => /test_combo\.py$/.test(a)), JSON.stringify(p.argv)).toBe(true);
      expect(files.some(a => /test_mod02_1\.py$/.test(a)), JSON.stringify(p.argv)).toBe(true);
    }
    const t = classify(res.output);
    expect(t).not.toContain("[router ✓");
    expect(t).not.toMatch(/✓ accepted|verified:/);
    expect(t).toContain("[router ⚠ UNVERIFIED:");
    expect(/observed failures: ([^\n]*)/.exec(t)?.[1] ?? "").toContain("test_combo.py::test_combo02");
  }, TEST_TIMEOUT);
});
