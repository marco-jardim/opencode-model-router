/**
 * Phase 3.1.2.b-c e2e: verification is bounded machine-wide. Drives the REAL plugin (real runners,
 * real slot, real reference worktrees; no mocks) against temp git copies of the `vitest-app`
 * fixture while a process sampler watches this process's descendants. Gated by RUN_VERIFY_E2E=1.
 *
 * - b: 5 concurrent VERIFY:required dispatches (2 introduce failures -> rechecks), then 5 deferred
 *   dispatches verified by one router_verify({pending:true}). Peak concurrent runner workers stay
 *   within maxWorkers x maxConcurrentVerifications, the runner tree runs below normal priority,
 *   nothing runs inside a before hook, no run covers the full file set, and the runner
 *   invocations stay within the batching design's count per gate window (scopedRunBound).
 * - b (concurrent pair): a broken and a neutral leaf dispatched at once: the broken one is
 *   rejected, the neutral one accepted or rejected with the concurrent-delegations caveat.
 * - c: two child processes (two "opencode sessions"), each with its own plugin and repo but the
 *   same TEMP (so the same machine-wide slot dir), with maxConcurrentVerifications 1, are jointly
 *   held to one slot: overlapping gates, never two runner mains at once; each child gets exactly
 *   one rejection (its broken leaf) and two verified passes, and no deferred footer.
 * - d: a gate with a small gateBudgetMs and a 120 s test returns on time, not as a pass, and no
 *   attributable process is alive 3 s after it returned.
 * - e (last): no reference worktree or omr-ref dir is left, and each fixture install is intact.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eEnabled, prepareFixtureRepo, type FixtureRepo } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin, type E2ETaskResult } from "./e2e/harness";
import {
  ancestorsOf,
  descendantsOf,
  peak,
  priorityViolations,
  seen,
  startSampler,
  workerCensus,
  workerKey,
  type ProcSample,
  type Snapshot,
} from "./e2e/sampler";
import type { ChildConfig, ChildSummary } from "./e2e/child-instance";

const suite = e2eEnabled() ? describe : describe.skip;

const TEST_TIMEOUT_MS = 480_000;
const ENV_TMP_KEYS = ["TEMP", "TMP", "TMPDIR"] as const;
/** Default budget (src/router/config.ts): maxWorkers 2, maxConcurrentVerifications max(1, floor(cores/8)). */
const MAX_WORKERS = 2;
const CORES = os.availableParallelism();
const MAX_CONCURRENT = Math.max(1, Math.floor(CORES / 8));
const WORKER_BOUND = MAX_WORKERS * MAX_CONCURRENT;
/** The fixture has 41 static test files plus dynamic.test.js. */
const FULL_FILE_SET = 42;
const SUMMARY_PREFIX = "OMR_CHILD_SUMMARY ";
const CHILD_ENTRY = fileURLToPath(new URL("./e2e/child-instance.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function norm(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

/** Case-insensitive on win32 (paths there are), case-sensitive elsewhere. */
function foldCase(s: string): string {
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Every spelling of `dir` a command line may carry: raw and realpath (an 8.3 short os.tmpdir()
 * vs its long form), each with `\` and with `/` separators, case-folded on win32.
 */
function pathSpellings(dir: string): string[] {
  const forms = [dir];
  try {
    forms.push(realpathSync.native(dir));
  } catch (e) {
    // A dir that does not exist (yet) has only its raw spelling.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const out = new Set<string>();
  for (const f of forms) {
    out.add(foldCase(f.replace(/\//g, "\\")));
    out.add(foldCase(f.replace(/\\/g, "/")));
  }
  return [...out];
}

/** Whether `args` mentions any of `spellings`, compared as-is and with separators unified to `/`. */
function mentionsAny(args: string, spellings: readonly string[]): boolean {
  const raw = foldCase(args);
  const slashed = raw.replace(/\\/g, "/");
  return spellings.some(s => raw.includes(s) || slashed.includes(s.replace(/\\/g, "/")));
}

/** Verdict markers appended by the gate (src/verify/dispatch.ts buildAcceptedSuffix / buildForcingNote). */
const UNVERIFIED_MARK = "[router \u26a0 UNVERIFIED";
/** QA-3.1-21 (plan G2): no router label may claim a pass on an unverified delegation. */
const PASS_CLAIM = /\[router \u2713|\u2713 accepted|verified:/;
const REJECTED_MARK = "NOT ACCEPTED";
const CAVEAT_MARK = "Verification caveats \u2014 NOT verified";
/** A deferred verification footer names a vrf_ handle; VERIFY:required dispatches must not carry one. */
const DEFERRED_FOOTER = /\bvrf_/;
/** A rejection over introduced failures while sibling dispatches ran in the same tree (src/verify/wiring.ts, QA-3.1-2). */
const CONCURRENT_CAVEAT = "other delegations ran in this working tree concurrently";
/** QA-3.1-8: how long after its creation a low-priority spawn may still be sampled at normal priority. */
const SPAWN_PRIORITY_RACE_MS = 500;
/** QA-3.1-7: 3.1.2.c's children hold one verification slot machine-wide. */
const C_MAX_CONCURRENT = 1;
const C_WORKER_BOUND = MAX_WORKERS * C_MAX_CONCURRENT;
/** 3.1.2.d: small enough for the 120 s slow test to hit it, larger than capture + planning (measured). */
const GATE_BUDGET_MS = 6000;
/**
 * 3.1.2.b/c: neutral dispatches start this long after the broken ones: past the broken edit
 * (produce delay 1000 ms) and the broken gate's batch window (batchWindowMs 2000 ms).
 */
const NEUTRAL_START_DELAY_MS = 3500;
const SLOW_TEST = `\nit("slow", async () => { await new Promise(r => setTimeout(r, 120000)); }, 200000);\n`;
/**
 * How far a snapshot's `t` may sit from the moment its process list was read: win32 stamps it
 * before the CIM query (~100 ms), POSIX when the parent reads the `@@T` frame, possibly after `ps`.
 */
const SNAPSHOT_SKEW_MS = 250;

/** Logs the measured numbers; with OMR_E2E_REPORT=<file> also appends them there (vitest may hide a passing test's console). */
function emit(text: string): void {
  console.log(text);
  const file = process.env.OMR_E2E_REPORT;
  if (file !== undefined && file !== "") appendFileSync(file, `${text}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mod(i: number): string {
  return `src/m${String(i).padStart(2, "0")}.js`;
}

function intervalStats(snapshots: Snapshot[]): string {
  const gaps = snapshots
    .slice(1)
    .map((s, i) => s.t - snapshots[i].t)
    .sort((a, b) => a - b);
  if (gaps.length === 0) return "n/a";
  return `median=${gaps[Math.floor(gaps.length / 2)]}ms max=${gaps[gaps.length - 1]}ms`;
}

/** A vitest pool worker process (vitest 4: node .../vitest/dist/workers/forks.js). */
function isWorkerArgs(args: string): boolean {
  return /vitest\/dist\/workers\//.test(norm(args));
}

/** The vitest CLI process (node .../vitest/vitest.mjs <args>), not a worker. */
function isMainArgs(args: string): boolean {
  const a = norm(args);
  return !isWorkerArgs(args) && /vitest\/vitest\.mjs\b|node_modules\/\.bin\/vitest\b|vitest\/dist\/cli/.test(a);
}

/**
 * workerCensus with the exiting-fork exemption capped at 1 per runner main per snapshot
 * (QA-3.1-17): vitest's reaping shape is one finished fork still exiting while its successor runs,
 * so a main with `perRunCap` running forks can show one extra, never more. Any further excess
 * counts as running. `excused` is how many workers this snapshot exempted.
 */
interface CappedCensus {
  snapshot: Snapshot;
  workers: ProcSample[];
  retiring: Set<number>;
  excused: Set<number>;
  running: number;
  sightings: Map<string, { first: number; last: number }>;
}

function cappedCensus(snapshots: Snapshot[], rootPid: number, exclude: number[], isWorker: (p: ProcSample) => boolean): CappedCensus[] {
  return workerCensus(snapshots, rootPid, exclude, isWorker, MAX_WORKERS).map(c => {
    const excused = new Set<number>();
    const mainsUsed = new Set<number>();
    for (const w of c.workers) {
      if (!c.retiring.has(w.pid) || mainsUsed.has(w.ppid)) continue;
      mainsUsed.add(w.ppid);
      excused.add(w.pid);
    }
    return { snapshot: c.snapshot, workers: c.workers, retiring: c.retiring, excused, running: c.workers.length - excused.size, sightings: c.sightings };
  });
}

/** The capped census's peak of running workers, and how many snapshots used the exemption. */
function runningStats(census: CappedCensus[]): { peak: number; exemptSnapshots: number; exempted: number } {
  return {
    peak: Math.max(0, ...census.map(c => c.running)),
    exemptSnapshots: census.filter(c => c.excused.size > 0).length,
    exempted: census.reduce((n, c) => n + c.excused.size, 0),
  };
}

/**
 * Every snapshot where more than `bound` matching workers are alive, with each worker's parent,
 * creation time and first/last sighting, and the parent's args. It tells two runs at once (the
 * slot) from one run's finished forks still exiting: vitest 4 starts a runner's termination and
 * schedules the next file's fork without awaiting it ("Runner terminations are started but not
 * awaited until the end of full run", vitest/dist/chunks/cli-api.*.js).
 */
function overBound(census: CappedCensus[], bound: number): string[] {
  const out: string[] = [];
  for (const c of census) {
    if (c.workers.length <= bound) continue;
    const byPid = new Map(c.snapshot.procs.map(p => [p.pid, p] as const));
    out.push(`  snapshot t=${c.snapshot.t}: ${c.workers.length} workers alive, ${c.running} running, ${c.excused.size} excused as exiting`);
    for (const w of c.workers) {
      const x = c.sightings.get(workerKey(w));
      const parent = byPid.get(w.ppid);
      const mark = c.excused.has(w.pid) ? " (exiting, excused)" : c.retiring.has(w.pid) ? " (retiring, over the cap: counted)" : "";
      out.push(
        `    worker ${w.pid}${mark} ppid=${w.ppid} created=${w.createdMs ?? "?"}` +
          ` seen ${x === undefined ? "?" : `${x.first - c.snapshot.t}..+${x.last - c.snapshot.t}ms`}` +
          ` parent: ${parent === undefined ? "(not in snapshot)" : `${isMainArgs(parent.args) ? "runner main" : "other"} ${parent.args.slice(0, 160)}`}`,
      );
    }
  }
  return out;
}

/** Test-file tokens in a runner command line. */
function testFileArgs(args: string): string[] {
  return args.split(/\s+/).filter(t => /\.test\.[cm]?[jt]sx?"?$/.test(t));
}

interface Sighting {
  p: ProcSample;
  first: number;
  last: number;
}

/** Matching descendants, one per process life (workerKey), with their first and last sighting. */
function sightingsOf(snapshots: Snapshot[], rootPid: number, exclude: number[], predicate: (p: ProcSample) => boolean): Sighting[] {
  const byKey = new Map<string, Sighting>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const x = byKey.get(workerKey(p));
      if (x === undefined) byKey.set(workerKey(p), { p, first: s.t, last: s.t });
      else x.last = s.t;
    }
  }
  return [...byKey.values()];
}

/** When a process started: its creation time where known (win32), else its first sighting (POSIX). */
function startOf(x: Sighting): number {
  return x.p.createdMs ?? x.first;
}

/**
 * Matching descendants sampled at normal priority (lowPriority === false) more than `maxAgeMs`
 * after they started (creation time on win32, first sighting elsewhere). On Windows a direct child
 * spawned for low priority runs at normal priority between CreateProcess and the parent's
 * setPriority call (QA-3.1-8 resolution, 533d988); that window is short, so only a young process
 * may be seen there.
 */
function normalPriorityPastSpawn(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  predicate: (p: ProcSample) => boolean,
  maxAgeMs: number,
): { p: ProcSample; ageMs: number }[] {
  const firstAt = new Map<string, number>();
  const out = new Map<string, { p: ProcSample; ageMs: number }>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const key = workerKey(p);
      if (!firstAt.has(key)) firstAt.set(key, s.t);
      if (p.lowPriority !== false) continue;
      const ageMs = s.t - (p.createdMs ?? firstAt.get(key) ?? s.t);
      if (ageMs > maxAgeMs && !out.has(key)) out.set(key, { p, ageMs });
    }
  }
  return [...out.values()];
}

/** Matching descendants sampled at low priority more than `graceMs` after their first sighting. */
function lowPriorityPastGrace(
  snapshots: Snapshot[],
  rootPid: number,
  exclude: number[],
  predicate: (p: ProcSample) => boolean,
  graceMs: number,
): ProcSample[] {
  const firstAt = new Map<string, number>();
  const out = new Map<string, ProcSample>();
  for (const s of snapshots) {
    for (const p of descendantsOf(s, rootPid, exclude)) {
      if (!predicate(p)) continue;
      const key = workerKey(p);
      const first = firstAt.get(key);
      if (first === undefined) firstAt.set(key, s.t);
      else if (p.lowPriority === true && s.t - first > graceMs && !out.has(key)) out.set(key, p);
    }
  }
  return [...out.values()];
}

/**
 * QA-3.1-6: the most runner invocations N concurrent vitest gates can cost, from the batching
 * design (src/verify/batch.ts). A gate window of n members costs:
 *   - n = 1 (B5.1, the direct path): 1 scoped run;
 *   - n >= 2 pooled: 1 union run (B5.4), plus one own run per member when the union fails
 *     (vitest is mode B, B7.3b), none when it is green (sources only: derived green, B7.2a);
 *   - n >= 2 split (B5.6): n own runs;
 *   - rechecks: at most one per member whose outcome has failures (B5.8), shared by members at
 *     the same reference (B8.6).
 * So a window runs at most n + 1 scoped commands when n >= 2, exactly 1 when n = 1, and at most n
 * rechecks. The test cannot see how the gates were split into windows; the worst split pools them
 * in pairs, each pooled window adding one union run: scoped <= N + floor(N / 2), rechecks <= N.
 * A pending batch whose union is green (router_verify over neutral edits) is exactly 1 run.
 */
function scopedRunBound(gates: number): number {
  return gates + Math.floor(gates / 2);
}

/** The largest number of runner mains alive at once, not counting a main under another main. */
function peakTopMains(snapshots: Snapshot[], rootPid: number, exclude: number[], isMain: (p: ProcSample) => boolean): number {
  let max = 0;
  for (const s of snapshots) {
    const mains = descendantsOf(s, rootPid, exclude).filter(isMain);
    const pids = new Set(mains.map(p => p.pid));
    max = Math.max(max, mains.filter(p => !pids.has(p.ppid)).length);
  }
  return max;
}

suite("verify resource budget: machine-wide bound (3.1.2.b-e)", { concurrent: false }, () => {
  let root = "";
  let tmpDir = "";
  const repos: FixtureRepo[] = [];
  const plugins: E2EPlugin[] = [];
  const savedTmp = new Map<string, string | undefined>();
  let bundlePath = "";
  let bundleDir = "";

  /** Spellings of every repo dir and of `<tmp>/omr-ref-`, rebuilt when a repo is added. */
  let scopeCache: { n: number; spellings: string[] } = { n: -1, spellings: [] };
  const scopeSpellings = (): string[] => {
    if (scopeCache.n !== repos.length) {
      const refPrefixes = pathSpellings(tmpDir).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`]);
      scopeCache = { n: repos.length, spellings: [...refPrefixes, ...repos.flatMap(r => pathSpellings(r.dir))] };
    }
    return scopeCache.spellings;
  };
  /** Runner processes scoped to one of our repos or a reference worktree of one. */
  const inScope = (p: ProcSample): boolean => mentionsAny(p.args, scopeSpellings());
  const isWorker = (p: ProcSample): boolean => inScope(p) && isWorkerArgs(p.args);
  const isMain = (p: ProcSample): boolean => inScope(p) && isMainArgs(p.args);
  const isRunnerTree = (p: ProcSample): boolean => isWorker(p) || isMain(p);

  beforeAll(async () => {
    // The raw os.tmpdir(), possibly an 8.3 short path (fixed in 29760a6); the scope predicates
    // match both the raw and the realpath spelling of every dir.
    root = await mkdtemp(join(os.tmpdir(), "omr-e2e-bound-"));
    tmpDir = join(root, "tmp");
    await mkdir(join(root, "repos"), { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    for (const k of ENV_TMP_KEYS) {
      savedTmp.set(k, process.env[k]);
      process.env[k] = tmpDir;
    }
    for (let i = 0; i < 3; i++) repos.push(await prepareFixtureRepo("vitest-app", { root: join(root, "repos") }));

    // Bundle the child entry (and the plugin it imports) to one .mjs. The output sits two levels
    // below this repo's root, like src/router/config.ts: the plugin finds tiers.json at
    // `<module dir>/../..`, and the externalised package imports resolve from the root node_modules.
    bundleDir = join(REPO_ROOT, "test", `.omr-e2e-child-${process.pid}`);
    const req = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
    const vite = req("vite") as { build(config: Record<string, unknown>): Promise<unknown> };
    await vite.build({
      configFile: false,
      root: REPO_ROOT,
      logLevel: "silent",
      build: {
        ssr: CHILD_ENTRY,
        write: true,
        outDir: bundleDir,
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)],
          output: { format: "es", entryFileNames: "child-instance.mjs" },
        },
      },
    });
    bundlePath = join(bundleDir, "child-instance.mjs");
  }, 900_000);

  afterAll(async () => {
    for (const p of plugins.reverse()) {
      await p.dispose().catch((e: unknown) => process.stderr.write(`[bound-e2e] dispose failed: ${String(e)}\n`));
    }
    for (const [k, v] of savedTmp) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // FixtureRepo.dispose unlinks a node_modules junction before removing the tree.
    for (const r of repos) await r.dispose();
    if (bundleDir !== "") await rm(bundleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 180_000);

  it("3.1.2.b: 5 required + 5 deferred dispatches stay within the worker bound, below normal priority", async () => {
    const repo = repos[0];
    const base = repo.head();
    const plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "b"), verify: {} });
    plugins.push(plugin);

    const edit = async (rel: string, from: string | undefined, to: string | undefined, tag: string): Promise<void> => {
      const text = await readFile(join(repo.dir, rel), "utf8");
      if (from === undefined || to === undefined) return repo.write(rel, `${text}\n// neutral edit ${tag}\n`);
      if (!text.includes(from)) throw new Error(`${rel} does not contain ${from}`);
      return repo.write(rel, text.replace(from, to));
    };
    // The producers share one working tree and verification judges the current tree. In vitest-app
    // module k imports module floor(k/2), so a neutral edit to m01..m05 has the tests of modules
    // another producer broke among its related tests, and all five were rejected. m11..m20 have no
    // importers (leaves): each leaf's related tests are its own. That alone is not enough: a
    // dispatch's change set is the tree against its dispatch-time capture, so a neutral dispatch
    // captured before a sibling's broken edit counts that edit as its own (measured: m11 rejected
    // over m12/m14 failures). The neutral dispatches therefore start NEUTRAL_START_DELAY_MS later,
    // after the broken edits are in the tree and outside their batch window (2000 ms). The fully
    // concurrent case and its documented outcome are "3.1.2.b (concurrent pair)" (QA-3.1-2).
    const REQUIRED = [11, 12, 13, 14, 15];
    const FAILING = new Set([12, 14]);

    // No profile restore here: the sampler must work with USERPROFILE at the plugin's fake home.
    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let required: E2ETaskResult[] = [];
    let deferred: E2ETaskResult[] = [];
    let report = "";
    /** Phase bounds: required gates [t0, t1], deferred dispatches (t1, t2], router_verify (t2, t3]. */
    let t0 = 0;
    let t1 = 0;
    let t2 = 0;
    let t3 = 0;
    /** End of this test's own (synchronous, normal-priority) git reset/clean, started at t1. */
    let tReset = 0;
    try {
      t0 = Date.now();
      required = await Promise.all(
        REQUIRED.map(async i => {
          if (!FAILING.has(i)) await sleep(NEUTRAL_START_DELAY_MS);
          return plugin.task({
            sessionID: `orch-b${i}`,
            callID: `b-req-${i}`,
            prompt: `VERIFY:required\nAdjust ${mod(i)}.\n${acceptance(repo.testCommand)}`,
            description: `adjust ${mod(i)}`,
            produce: async () => {
              await sleep(1000);
              if (FAILING.has(i)) await edit(mod(i), `return x + ${i};`, `return x + ${i * 100};`, `b${i}`);
              else await edit(mod(i), undefined, undefined, `b${i}`);
            },
          });
        }),
      );
      t1 = Date.now();
      repo.git("reset", "-q", "--hard", base);
      repo.git("clean", "-q", "-fd", "-e", "node_modules");
      tReset = Date.now();
      deferred = await Promise.all(
        [6, 8, 10, 12, 14].map((m, i) =>
          plugin.task({
            sessionID: "orch-bd",
            callID: `b-def-${i + 1}`,
            prompt: `Tidy ${mod(m)}.\n${acceptance(repo.testCommand)}`,
            description: `tidy ${mod(m)}`,
            produce: async () => {
              await sleep(1000);
              await edit(mod(m), undefined, undefined, `bd${i + 1}`);
            },
          }),
        ),
      );
      t2 = Date.now();
      report = await plugin.routerVerify({ pending: true }, { sessionID: "orch-bd" });
      t3 = Date.now();
      await sleep(500);
    } finally {
      snapshots = await sampler.stop();
    }

    const excl = [sampler.pid];
    const all = seen(snapshots, process.pid, excl, () => true);
    const runnerish = all.filter(p => /vitest|npm|node_modules/i.test(p.args));
    const workers = seen(snapshots, process.pid, excl, isWorker);
    const mains = seen(snapshots, process.pid, excl, isMain);
    const peakWorkers = peak(snapshots, process.pid, excl, isWorker);
    const census = cappedCensus(snapshots, process.pid, excl, isWorker);
    const { peak: runningPeak, exemptSnapshots, exempted } = runningStats(census);
    const peakMains = peak(snapshots, process.pid, excl, isMain);
    const over = overBound(census, WORKER_BOUND);
    const violations = priorityViolations(snapshots, process.pid, excl, isRunnerTree, 250);
    const lowRunner = lowPriorityPastGrace(snapshots, process.pid, excl, isRunnerTree, 250);
    // The test's own reset/clean between the phases is not the plugin's git (win32 creation times;
    // elsewhere matched by args).
    const ownGit = (p: ProcSample): boolean =>
      /\bgit(\.exe)?"?\s+(reset|clean)\b/i.test(p.args) &&
      (p.createdMs === undefined || (p.createdMs >= t1 - SNAPSHOT_SKEW_MS && p.createdMs <= tReset + SNAPSHOT_SKEW_MS));
    const isGitCmd = (p: ProcSample): boolean => /\b(git|cmd)(\.exe)?\b/i.test(p.args) && !ownGit(p);
    const gitCmdNormal = all.filter(p => isGitCmd(p) && p.lowPriority === false);
    const gitCmdLate = normalPriorityPastSpawn(snapshots, process.pid, excl, isGitCmd, SPAWN_PRIORITY_RACE_MS);
    // QA-3.1-6: runner invocations per phase, by start time (creation on win32, first sighting
    // elsewhere, widened by SNAPSHOT_SKEW_MS at the phase ends).
    const refSpellings = pathSpellings(tmpDir).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`]);
    const mainLives = sightingsOf(snapshots, process.pid, excl, isMain);
    const isRecheck = (x: Sighting): boolean => mentionsAny(x.p.args, refSpellings);
    const inPhase = (x: Sighting, from: number, to: number): boolean => startOf(x) >= from && startOf(x) < to;
    const reqRuns = mainLives.filter(x => inPhase(x, t0 - SNAPSHOT_SKEW_MS, t1 + SNAPSHOT_SKEW_MS));
    const reqScoped = reqRuns.filter(x => !isRecheck(x));
    const reqRechecks = reqRuns.filter(isRecheck);
    const deferredRuns = mainLives.filter(x => inPhase(x, t1 + SNAPSHOT_SKEW_MS, t2 - SNAPSHOT_SKEW_MS));
    const pendingRuns = mainLives.filter(x => inPhase(x, t2 - SNAPSHOT_SKEW_MS, t3 + SNAPSHOT_SKEW_MS));
    const strayRuns = mainLives.filter(x => !reqRuns.includes(x) && !deferredRuns.includes(x) && !pendingRuns.includes(x));
    const runsText = (xs: Sighting[]): string => xs.map(x => `\n    ${x.p.pid} +${startOf(x) - t0}ms ${x.p.args.slice(0, 200)}`).join("");
    const beforeWindows = [...required, ...deferred].map(r => [r.produceStartedAt - r.beforeMs, r.produceStartedAt] as const);
    const inBefore = snapshots.filter(s => beforeWindows.some(([a, b]) => s.t >= a && s.t <= b));
    // The staggered neutral before hooks overlap the broken dispatches' gates; those gate runs
    // (scoped run and recheck) name a broken module and are not before-hook work.
    const failingNames = new RegExp(`(src/m(${[...FAILING].join("|")})\\.js|test/m(${[...FAILING].join("|")})-\\d+\\.test\\.js)`);
    const runnersInBefore = inBefore.flatMap(s => {
      const gateMains = new Set(s.procs.filter(p => isMain(p) && failingNames.test(norm(p.args))).map(p => p.pid));
      return seen([s], process.pid, excl, p => isRunnerTree(p) && !gateMains.has(p.pid) && !gateMains.has(p.ppid));
    });
    const outputs = [...required, ...deferred].map(r => r.output);
    const failingOutputs = required.filter(r => r.output.includes("NOT ACCEPTED")).length;

    emit(
      [
        `[3.1.2.b] cores=${CORES} maxWorkers=${MAX_WORKERS} x maxConcurrentVerifications=${MAX_CONCURRENT} -> bound ${WORKER_BOUND}`,
        `[3.1.2.b] sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}`,
        `[3.1.2.b] peak workers=${peakWorkers} (running ${runningPeak}) distinct workers=${workers.length} peak mains=${peakMains} distinct runner-main invocations=${mains.length}`,
        `[3.1.2.b] snapshots over the worker bound=${over.filter(l => l.startsWith("  snapshot")).length}; snapshots using the exiting-worker exemption=${exemptSnapshots} (workers excused=${exempted}, cap 1 per runner per snapshot)`,
        ...over,
        `[3.1.2.b] priority violations=${violations.length} ${violations.map(p => `${p.pid}:${String(p.priority)}:${p.args}`).join(" | ")}`,
        `[3.1.2.b] runner processes sampled at low priority after the grace=${lowRunner.length}`,
        `[3.1.2.b] git/cmd descendants seen at normal priority=${gitCmdNormal.length} ${gitCmdNormal.map(p => `${p.pid}:${p.args.slice(0, 120)}`).join(" | ")}`,
        `[3.1.2.b] of them more than ${SPAWN_PRIORITY_RACE_MS}ms after creation=${gitCmdLate.length} ${gitCmdLate.map(x => `${x.p.pid}(+${x.ageMs}ms):${x.p.args.slice(0, 120)}`).join(" | ")}`,
        `[3.1.2.b] runner invocations: required phase scoped=${reqScoped.length} (bound ${scopedRunBound(REQUIRED.length)}) rechecks=${reqRechecks.length} (bound ${REQUIRED.length}); deferred phase=${deferredRuns.length}; router_verify=${pendingRuns.length}; outside the phases=${strayRuns.length}`,
        `  required:${runsText(reqRuns)}`,
        `  deferred:${runsText(deferredRuns)}`,
        `  router_verify:${runsText(pendingRuns)}`,
        `  outside:${runsText(strayRuns)}`,
        `[3.1.2.b] snapshots inside before-hook windows=${inBefore.length} runners in them=${runnersInBefore.length}`,
        `[3.1.2.b] NOT ACCEPTED among required=${failingOutputs}`,
        `[3.1.2.b] distinct runner-related descendant args:`,
        ...[...new Set(runnerish.map(p => `  prio=${String(p.priority)} ${p.args}`))],
        `[3.1.2.b] runner-main args:`,
        ...mains.map(p => `  ${p.args}`),
        `[3.1.2.b] outputs:`,
        ...outputs.map((o, i) => `  --- #${i + 1}\n${o}`),
        `[3.1.2.b] pending report:\n${report}`,
      ].join("\n"),
    );

    // Non-vacuity.
    expect(snapshots.filter(s => s.procs.some(p => p.pid === process.pid)).length).toBeGreaterThanOrEqual(5);
    expect(peakWorkers).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    expect(mains.length).toBeGreaterThanOrEqual(1);
    // The bound, on workers running a test file: at most one finished fork per runner main that
    // vitest is still reaping is excused per snapshot (cappedCensus, QA-3.1-17).
    expect(runningPeak, over.join("\n")).toBeLessThanOrEqual(WORKER_BOUND);
    // Below normal priority for the whole runner tree (after the documented spawn race), and the
    // check is not vacuous: some runner process was sampled low after the grace (QA-3.1-8).
    expect(violations.map(p => `${p.pid} prio=${String(p.priority)} ${p.args}`)).toEqual([]);
    expect(lowRunner.length).toBeGreaterThanOrEqual(1);
    // git (snapshot, capture) runs low too; normal priority only inside the spawn->setPriority race.
    expect(gitCmdLate.map(x => `${x.p.pid} +${x.ageMs}ms ${x.p.args}`)).toEqual([]);
    // Nothing runs inside a before hook.
    expect(runnersInBefore.map(p => p.args)).toEqual([]);
    // Scoped runs only: `related` or explicit test files, never the full file set.
    for (const m of mains) {
      const files = testFileArgs(m.args);
      expect(/\brelated\b/.test(m.args) || files.length > 0, m.args).toBe(true);
      expect(files.length, m.args).toBeLessThan(FULL_FILE_SET);
    }
    // Runs are batched and bounded per gate window (scopedRunBound): the required gates within the
    // design's worst split, at least one recheck proving the broken leaves' failures introduced;
    // the deferred dispatches run nothing at their gate; the pending batch is exactly 1 run.
    expect(reqScoped.length, runsText(reqRuns)).toBeGreaterThanOrEqual(1);
    expect(reqScoped.length, runsText(reqRuns)).toBeLessThanOrEqual(scopedRunBound(REQUIRED.length));
    expect(reqRechecks.length, runsText(reqRuns)).toBeGreaterThanOrEqual(1);
    expect(reqRechecks.length, runsText(reqRuns)).toBeLessThanOrEqual(REQUIRED.length);
    expect(deferredRuns.length, runsText(deferredRuns)).toBe(0);
    expect(pendingRuns.length, runsText(pendingRuns)).toBe(1);
    expect(pendingRuns.filter(isRecheck).length, runsText(pendingRuns)).toBe(0);
    expect(strayRuns.length, runsText(strayRuns)).toBe(0);
    // Exactly the two broken leaves are rejected; the three neutral leaves pass.
    REQUIRED.forEach((m, i) => {
      const out = required[i].output;
      expect(out.includes(REJECTED_MARK), `${mod(m)}:\n${out}`).toBe(FAILING.has(m));
      expect(DEFERRED_FOOTER.test(out), out).toBe(false);
    });
    expect(failingOutputs).toBe(FAILING.size);
    expect(report).not.toBe("");
  }, TEST_TIMEOUT_MS);

  it("3.1.2.b (concurrent pair): a broken and a neutral leaf dispatched together get the documented outcome", async () => {
    // QA-3.1-2: 3.1.2.b staggers its neutral dispatches; here one pair runs fully concurrently.
    // The tree is not partitioned (e1b86a9): the neutral dispatch's change set can include the
    // sibling's broken edit. The documented outcome is that it is accepted, or rejected WITH the
    // concurrent-delegations caveat; a bare rejection would blame it silently.
    const repo = await prepareFixtureRepo("vitest-app", { root: join(root, "repos") });
    repos.push(repo);
    const plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "bp"), verify: {} });
    plugins.push(plugin);
    const BROKEN = 16;
    const NEUTRAL = 17;
    const [broken, neutral] = await Promise.all(
      [BROKEN, NEUTRAL].map(m =>
        plugin.task({
          sessionID: `orch-bp${m}`,
          callID: `bp-${m}`,
          prompt: `VERIFY:required\nAdjust ${mod(m)}.\n${acceptance(repo.testCommand)}`,
          description: `adjust ${mod(m)}`,
          produce: async () => {
            await sleep(1000);
            const text = await readFile(join(repo.dir, mod(m)), "utf8");
            if (m === BROKEN) {
              const from = `return x + ${m};`;
              if (!text.includes(from)) throw new Error(`${mod(m)} does not contain ${from}`);
              await repo.write(mod(m), text.replace(from, `return x + ${m * 100};`));
            } else {
              await repo.write(mod(m), `${text}\n// neutral edit bp${m}\n`);
            }
          },
        }),
      ),
    );
    const outcome = (out: string): string =>
      out.includes(REJECTED_MARK) ? (out.includes(CONCURRENT_CAVEAT) ? "NOT ACCEPTED with the concurrent caveat" : "NOT ACCEPTED") : "accepted";
    emit(
      [
        `[3.1.2.b pair] ${mod(BROKEN)} (broken): ${outcome(broken.output)}; ${mod(NEUTRAL)} (neutral): ${outcome(neutral.output)}`,
        `  --- broken\n${broken.output}`,
        `  --- neutral\n${neutral.output}`,
      ].join("\n"),
    );
    expect(broken.output.includes(REJECTED_MARK), broken.output).toBe(true);
    expect(DEFERRED_FOOTER.test(broken.output), broken.output).toBe(false);
    expect(DEFERRED_FOOTER.test(neutral.output), neutral.output).toBe(false);
    if (neutral.output.includes(REJECTED_MARK)) expect(neutral.output, neutral.output).toContain(CONCURRENT_CAVEAT);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.c: two plugin instances in two processes share the machine-wide bound", async () => {
    // Leaf modules and staggered starts only (see 3.1.2.b): each child yields exactly one rejection
    // and two passes.
    const children = [
      { tag: "c1", repo: repos[1], mods: [16, 17, 18], broken: 16 },
      { tag: "c2", repo: repos[2], mods: [19, 20, 13], broken: 19 },
    ];
    const startAt = Date.now() + 1500;
    const configPaths: string[] = [];
    for (const c of children) {
      const cfg: ChildConfig = {
        tag: c.tag,
        repoDir: c.repo.dir,
        home: join(root, "home", c.tag),
        testCommand: c.repo.testCommand,
        startAt,
        produceDelayMs: 1000,
        // QA-3.1-7: one slot machine-wide, so the slot must hold one child back on any host (the
        // default max(1, floor(cores/8)) is 2 on 16 cores: 2 children x 2 workers never exceed it).
        verify: { maxConcurrentVerifications: C_MAX_CONCURRENT },
        edits: c.mods.map(m =>
          m === c.broken
            ? { rel: mod(m), from: `return x + ${m};`, to: `return x + ${m * 100};` }
            : { rel: mod(m), startDelayMs: NEUTRAL_START_DELAY_MS },
        ),
      };
      const p = join(root, `${c.tag}.json`);
      await writeFile(p, JSON.stringify(cfg), "utf8");
      configPaths.push(p);
    }

    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let runs: { code: number | null; stdout: string; stderr: string }[] = [];
    try {
      runs = await Promise.all(
        configPaths.map(
          cfgPath =>
            new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
              // TEMP/TMP/TMPDIR are inherited (set in beforeAll): the same slot dir for both children.
              const child = spawn(process.execPath, [bundlePath, cfgPath], { cwd: REPO_ROOT, env: process.env, windowsHide: true });
              let stdout = "";
              let stderr = "";
              child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
              child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
              child.on("error", reject);
              child.on("exit", code => resolve({ code, stdout, stderr }));
            }),
        ),
      );
      await sleep(300);
    } finally {
      snapshots = await sampler.stop();
    }

    const summaries = runs.map(r => {
      const line = r.stdout.split("\n").find(l => l.startsWith(SUMMARY_PREFIX));
      return line === undefined ? undefined : (JSON.parse(line.slice(SUMMARY_PREFIX.length)) as ChildSummary);
    });
    const excl = [sampler.pid];
    const peakWorkers = peak(snapshots, process.pid, excl, isWorker);
    const census = cappedCensus(snapshots, process.pid, excl, isWorker);
    const { peak: runningPeak, exemptSnapshots, exempted } = runningStats(census);
    const workers = seen(snapshots, process.pid, excl, isWorker);
    const mains = seen(snapshots, process.pid, excl, isMain);
    const perChildPeak = summaries.map(s =>
      s === undefined ? -1 : peak(snapshots, s.pid, excl, isWorker),
    );
    const over = overBound(census, C_WORKER_BOUND);
    // QA-3.1-7: the slot holder is the runner main (one per hold at a time: union, own runs and
    // rechecks run in sequence under it), so with one slot at most one main is alive machine-wide.
    const peakMainsAll = peakTopMains(snapshots, process.pid, excl, isMain);
    const perChildMains = summaries.map(s => (s === undefined ? 0 : seen(snapshots, s.pid, excl, isMain).length));
    // Each child's gate windows (after hook start to return); the two children's must overlap.
    const gates = summaries.map(s => (s === undefined ? [] : s.dispatches.map(d => [d.returnedAt - d.afterMs, d.returnedAt] as const)));
    let gateOverlapMs = 0;
    for (const [a0, a1] of gates[0] ?? []) {
      for (const [b0, b1] of gates[1] ?? []) gateOverlapMs = Math.max(gateOverlapMs, Math.min(a1, b1) - Math.max(a0, b0));
    }
    emit(
      [
        `[3.1.2.c] maxConcurrentVerifications=${C_MAX_CONCURRENT} -> bound ${C_WORKER_BOUND}; sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}`,
        `[3.1.2.c] peak workers (both children)=${peakWorkers} (running ${runningPeak}) per child=${perChildPeak.join(",")} distinct workers=${workers.length} runner-main invocations=${mains.length} per child=${perChildMains.join(",")}`,
        `[3.1.2.c] peak runner mains alive at once (both children)=${peakMainsAll}; longest overlap of the two children's gate windows=${gateOverlapMs.toFixed(0)}ms`,
        `[3.1.2.c] snapshots over the worker bound=${over.filter(l => l.startsWith("  snapshot")).length}; snapshots using the exiting-worker exemption=${exemptSnapshots} (workers excused=${exempted})`,
        ...over,
        ...runs.map((r, i) => `[3.1.2.c] child ${i + 1} exit=${String(r.code)} stderr:\n${r.stderr.slice(-2000)}`),
        ...summaries.flatMap(s => (s === undefined ? [] : s.dispatches.map(d => `  --- ${d.callID} after=${d.afterMs.toFixed(0)}ms\n${d.output}`))),
      ].join("\n"),
    );

    /**
     * Runner mains of this child, in its repo, whose args name module m's source or one of its test
     * files, seen in the snapshots taken within [from, to] (widened by SNAPSHOT_SKEW_MS).
     */
    const mainsFor = (childPid: number, repoDir: string, m: number, from = -Infinity, to = Infinity): ProcSample[] => {
      const nn = String(m).padStart(2, "0");
      const names = new RegExp(`(src/m${nn}\\.js|test/m${nn}-\\d+\\.test\\.js)`);
      const repoSpellings = pathSpellings(repoDir);
      const within = snapshots.filter(s => s.t >= from - SNAPSHOT_SKEW_MS && s.t <= to + SNAPSHOT_SKEW_MS);
      return seen(within, childPid, excl, p => isMain(p) && mentionsAny(p.args, repoSpellings) && names.test(norm(p.args)));
    };
    const perDispatch = children.flatMap((c, ci) =>
      c.mods.map((m, di) => {
        const s = summaries[ci];
        const d = s?.dispatches[di];
        const mains = s === undefined ? [] : mainsFor(s.pid, c.repo.dir, m);
        // This dispatch's own gate: its after hook, from its start to its return.
        const gateMains = s === undefined || d === undefined ? [] : mainsFor(s.pid, c.repo.dir, m, d.returnedAt - d.afterMs, d.returnedAt);
        return { tag: c.tag, m, broken: m === c.broken, d, mains, gateMains };
      }),
    );
    emit(
      perDispatch
        .map(x => `[3.1.2.c] ${x.tag} ${mod(x.m)}${x.broken ? " (broken)" : ""}: after=${x.d?.afterMs.toFixed(0) ?? "?"}ms runner mains naming it=${x.mains.length} ${x.mains.map(p => p.pid).join(",")}; during its gate=${x.gateMains.length} ${x.gateMains.map(p => p.pid).join(",")}`)
        .join("\n"),
    );

    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    for (const s of summaries) {
      expect(s).toBeDefined();
      expect(s?.dispatches.length).toBe(3);
    }
    for (const x of perDispatch) {
      const out = x.d?.output ?? "";
      const label = `${x.tag} ${mod(x.m)}:\n${out}`;
      // VERIFY:required: never a deferred-verification footer.
      expect(DEFERRED_FOOTER.test(out), label).toBe(false);
      if (x.broken) {
        // Exactly one rejection per child, naming the broken module's test.
        expect(out.includes(REJECTED_MARK), label).toBe(true);
        expect(new RegExp(`m${String(x.m).padStart(2, "0")}`).test(out), label).toBe(true);
      } else {
        // A clean required-mode pass leaves the output untouched: no rejection, no caveat.
        expect(out.includes(REJECTED_MARK), label).toBe(false);
        expect(out.includes(CAVEAT_MARK), label).toBe(false);
        // Non-vacuity: verification really ran for this dispatch. The direct evidence is a runner
        // main of this child, in its repo, naming this module and alive during this dispatch's own
        // gate. (CI round 1: a duration floor is no proof; a batched 2-file run on Linux finished
        // its gate in 587-686 ms.)
        expect(x.gateMains.map(p => p.pid), label).not.toEqual([]);
      }
    }
    expect(peakWorkers).toBeGreaterThanOrEqual(1);
    expect(workers.length).toBeGreaterThanOrEqual(1);
    // The bound, on workers running a test file (cappedCensus).
    expect(runningPeak, over.join("\n")).toBeLessThanOrEqual(C_WORKER_BOUND);
    // The joint slot really held one child back: both children ran the runner, their gates
    // overlapped in wall time, and yet at most one slot holder ran at any snapshot, so one waited.
    for (const n of perChildMains) expect(n).toBeGreaterThanOrEqual(1);
    expect(gateOverlapMs).toBeGreaterThan(0);
    expect(peakMainsAll).toBeLessThanOrEqual(C_MAX_CONCURRENT);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.d: a gate that hits its budget returns on time and leaves no orphan", async () => {
    const repo = await prepareFixtureRepo("vitest-app", { root: join(root, "repos") });
    repos.push(repo);
    const plugin = await createE2EPlugin({ directory: repo.dir, home: join(root, "home", "d"), verify: { gateBudgetMs: GATE_BUDGET_MS } });
    plugins.push(plugin);
    const spellings = [...pathSpellings(repo.dir), ...pathSpellings(tmpDir).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`])];
    const attributable = (p: ProcSample): boolean => mentionsAny(p.args, spellings) || /vitest/i.test(p.args);

    const sampler = startSampler({ intervalMs: 100 });
    let snapshots: Snapshot[] = [];
    let result: E2ETaskResult | undefined;
    let dispatchedAt = 0;
    try {
      dispatchedAt = Date.now();
      result = await plugin.task({
        sessionID: "orch-d",
        callID: "d-slow",
        prompt: `VERIFY:required\nAdjust ${mod(7)} and cover it.\n${acceptance(repo.testCommand)}`,
        description: `adjust ${mod(7)}`,
        produce: async () => {
          await sleep(1000);
          const src = await readFile(join(repo.dir, mod(7)), "utf8");
          await repo.write(mod(7), `${src}\n// neutral edit d\n`);
          const rel = "test/m07-1.test.js";
          const t = await readFile(join(repo.dir, rel), "utf8");
          await repo.write(rel, `${t}${SLOW_TEST}`);
        },
      });
      // Keep sampling well past return + 3 s so at least one snapshot starts after it.
      await sleep(Math.max(0, result.returnedAt + 5000 - Date.now()));
    } finally {
      snapshots = await sampler.stop();
    }
    if (result === undefined) throw new Error("the dispatch did not return");
    const res: E2ETaskResult = result;

    const excl = [sampler.pid];
    const gateStartedAt = res.returnedAt - res.afterMs;
    const deadlineAt = gateStartedAt + GATE_BUDGET_MS;
    const deadlineToReturn = res.returnedAt - deadlineAt;
    const runDuring = seen(
      snapshots.filter(s => s.t <= res.returnedAt),
      process.pid,
      excl,
      p => isRunnerTree(p),
    );
    const trackedDuring = seen(
      snapshots.filter(s => s.t <= res.returnedAt),
      process.pid,
      excl,
      attributable,
    );
    const late = snapshots.filter(s => s.t >= res.returnedAt + 3000);
    // This process's own ancestors (the vitest main, and in CI npx and cmd) outlive the gate by
    // design; they are never a gate orphan (CI round 1).
    const ancestors = new Set(snapshots.flatMap(s => ancestorsOf(s, process.pid)).map(p => p.pid));
    /** Created by this dispatch or later (creation times are known on win32 only). */
    const sinceDispatch = (p: ProcSample): boolean => p.createdMs === undefined || p.createdMs >= dispatchedAt;
    // Descendants still attached to this process, and (Windows does not reparent) any process on
    // the machine created since the dispatch that is one of the tracked pids (same creation time)
    // or names our paths.
    const tracked = new Map(trackedDuring.filter(sinceDispatch).map(p => [p.pid, p.createdMs]));
    const lateDesc = late.flatMap(s => descendantsOf(s, process.pid, excl).filter(attributable).map(p => ({ t: s.t, p })));
    const lateMachine = late.flatMap(s =>
      s.procs
        .filter(p => p.pid !== sampler.pid && p.pid !== process.pid && !ancestors.has(p.pid) && sinceDispatch(p))
        .filter(p => (tracked.has(p.pid) && tracked.get(p.pid) === p.createdMs) || mentionsAny(p.args, spellings))
        .map(p => ({ t: s.t, p })),
    );
    const describeProc = (x: { t: number; p: ProcSample }): string =>
      `+${x.t - res.returnedAt}ms pid=${x.p.pid} ppid=${x.p.ppid} created=${x.p.createdMs === undefined ? "?" : `${x.p.createdMs - dispatchedAt}ms after dispatch`} ${x.p.args.slice(0, 300)}`;
    // Direct check, after the sampler stopped: signal 0 on every pid seen.
    const directAlive: number[] = [];
    for (const pid of tracked.keys()) {
      try {
        process.kill(pid, 0);
        directAlive.push(pid);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EPERM") directAlive.push(pid);
        else if (code !== "ESRCH") throw e;
      }
    }
    const directAliveAt = Date.now() - res.returnedAt;

    emit(
      [
        `[3.1.2.d] gateBudgetMs=${GATE_BUDGET_MS} beforeMs=${res.beforeMs.toFixed(0)} afterMs(gate)=${res.afterMs.toFixed(0)}`,
        `[3.1.2.d] dispatch->return=${res.returnedAt - dispatchedAt}ms deadline->gate return=${deadlineToReturn.toFixed(0)}ms`,
        `[3.1.2.d] sampler snapshots=${snapshots.length} interval ${intervalStats(snapshots)}; snapshots >= return+3s=${late.length} (first at +${late.length > 0 ? late[0].t - res.returnedAt : -1}ms, last at +${late.length > 0 ? late[late.length - 1].t - res.returnedAt : -1}ms)`,
        `[3.1.2.d] runner processes seen during the run=${runDuring.length} attributable descendants seen=${trackedDuring.length} (created since the dispatch=${tracked.size}); own ancestors=[${[...ancestors].join(",")}]`,
        ...trackedDuring.map(p => `  seen ${p.pid} ppid=${p.ppid} created=${p.createdMs === undefined ? "?" : `${p.createdMs - dispatchedAt}ms after dispatch`} ${p.args.slice(0, 200)}`),
        `[3.1.2.d] alive >= 3 s after return: descendants=${lateDesc.length} machine-wide=${lateMachine.length} direct kill(0) at +${directAliveAt}ms=${directAlive.length} [${directAlive.join(",")}]`,
        ...[...lateDesc, ...lateMachine].map(x => `  alive at ${describeProc(x)}`),
        `[3.1.2.d] output:\n${res.output}`,
      ].join("\n"),
    );

    // Non-vacuity: the runner did start, and the sampler covered the +3 s mark.
    expect(runDuring.length).toBeGreaterThanOrEqual(1);
    expect(late.length).toBeGreaterThanOrEqual(1);
    // Returns on time.
    expect(res.afterMs).toBeLessThanOrEqual(GATE_BUDGET_MS + 3000);
    // Not a pass: rejected, or returned UNVERIFIED with a caveat naming the timeout (QA-3.1-21).
    const out = res.output;
    const notPass = out.includes(REJECTED_MARK) || (out.includes(UNVERIFIED_MARK) && out.includes(CAVEAT_MARK));
    expect(notPass, out).toBe(true);
    expect(PASS_CLAIM.test(out), out).toBe(false);
    expect(/timed out|budget|deadline/i.test(out), out).toBe(true);
    expect(DEFERRED_FOOTER.test(out), out).toBe(false);
    // No orphans 3 s after return.
    expect(lateDesc.map(describeProc)).toEqual([]);
    expect(lateMachine.map(describeProc)).toEqual([]);
    expect(directAlive).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // Keep last: checks what every test above left behind.
  it("3.1.2.e: reference worktrees are disposed and the fixture installs are intact", async () => {
    const refEntries = (r: FixtureRepo): string[] =>
      r
        .git("worktree", "list", "--porcelain")
        .split("\n")
        .filter(l => l.startsWith("worktree ") && /omr-ref-/.test(l));
    const refDirs = async (): Promise<string[]> => (await readdir(tmpDir)).filter(n => n.startsWith("omr-ref-"));
    const t0 = Date.now();
    let worktrees = repos.flatMap(refEntries);
    let dirs = await refDirs();
    while ((worktrees.length > 0 || dirs.length > 0) && Date.now() - t0 < 15_000) {
      await sleep(500);
      worktrees = repos.flatMap(refEntries);
      dirs = await refDirs();
    }
    const settledMs = Date.now() - t0;
    const installs = await Promise.all(
      repos.map(async r => {
        const nm = await lstat(join(r.dir, "node_modules"));
        return { dir: r.dir, sentinel: existsSync(r.sentinelPath), realDir: nm.isDirectory() && !nm.isSymbolicLink() };
      }),
    );
    emit(
      [
        `[3.1.2.e] repos=${repos.length} settled after ${settledMs}ms; omr-ref worktrees=${worktrees.length} omr-ref dirs in tmp=${dirs.length}`,
        ...worktrees.map(w => `  worktree ${w}`),
        ...dirs.map(d => `  dir ${d}`),
        ...installs.map(i => `  ${i.dir} sentinel=${i.sentinel} node_modules real dir=${i.realDir}`),
      ].join("\n"),
    );
    expect(repos.length).toBeGreaterThanOrEqual(4);
    expect(worktrees).toEqual([]);
    expect(dirs).toEqual([]);
    for (const i of installs) {
      expect(i.sentinel, i.dir).toBe(true);
      expect(i.realDir, i.dir).toBe(true);
    }
  }, 60_000);
});
