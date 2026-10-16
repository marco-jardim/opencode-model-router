/**
 * Phase 3.1.2.f-h e2e: deferred verification costs nothing, the orchestrator keeps control, and the
 * background opt-in reports late. Drives the REAL plugin (real runners, real slot, real reference
 * worktrees; no mocks) against a temp git copy of the `vitest-app` fixture. Gated by RUN_VERIFY_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { UNATTRIBUTED_RISK_REASON } from "../../src/verify/pending";
import { DEFERRED_FINISH_MS, STATIC_SCOPING_UNFINISHED_REASON } from "../../src/verify/wiring";
import { e2eEnabled, prepareFixtureRepo, readProbeLog, type FixtureRepo, type ProbeEntry } from "./e2e/fixture-repo";
import { acceptance, createE2EPlugin, type E2EPlugin, type E2ETaskResult } from "./e2e/harness";
import {
  SAMPLER_MEDIAN_INTERVAL_MAX_MS,
  lifetimePeak,
  median,
  mentionsAny,
  pathSpellings,
  seen,
  seenAnywhere,
  snapshotIntervals,
  startSampler,
  type ProcSample,
  type Sampler,
  type Snapshot,
} from "./e2e/sampler";

const suite = e2eEnabled() ? describe : describe.skip;

const TEST_TIMEOUT_MS = 180_000;
/** Default VERIFY_WAIT (captureWaitMs). */
const VERIFY_WAIT_DEFAULT_MS = 5_000;
/**
 * CI round 1: what a before hook may take past VERIFY_WAIT. The plugin counts VERIFY_WAIT from the
 * dispatch's start (the capture's start-up is inside it, src/verify/wiring.ts boundedCaptureWait);
 * what is left is outside any timer's control: the wait's timer firing late on a busy event loop,
 * and the rest of the hook running after it, serialised over 20 releases that fall due together.
 * Measured on windows-latest under --coverage before that fix: up to 104 ms past 5000 ms.
 */
const HOOK_LATENCY_SLACK_MS = 250;
/**
 * QA-3.1-3 / QA-3.1-10: since 02a9a1c the 20 dispatches share one snapshot and one capture per
 * generation; measured p50 975-1031 ms (two ~0.5 s generations; the plan's "< 1 s" is a recorded
 * deviation). The bound leaves headroom for a loaded host, far below VERIFY_WAIT.
 */
const CAPTURE_WAIT_P50_MAX_MS = 1_500;
/** Footer risk reasons that a deferred finish cut at DEFERRED_FINISH_MS produces (QA-3.1-10). */
const CAP_FOOTER_MARKS = [UNATTRIBUTED_RISK_REASON, "scoping impossible (S6)", STATIC_SCOPING_UNFINISHED_REASON];
/** QA-3.1-10: the deferred finish's timer may fire this late past DEFERRED_FINISH_MS on a busy loop. */
const AFTER_TIMER_SLACK_MS = 150;
/** An after hook at or above this counts as "at the cap" in the 3.1.2.f report. */
const NEAR_CAP_MS = 1_950;
/** How often 3.1.2.f looks for the slot dir while the dispatches run (QA-3.1-11). */
const SLOT_POLL_MS = 20;
const FOOTER_RE = /\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7 risk \S+/;
const PENDING_HEADER = "[router] Unverified delegations in this session (newest first):";
const LATE_NOTICE_MARK = "Background verification";
const DRIFT_NOTICE = "tree drifted since delegation";

const ENV_TMP_KEYS = ["TEMP", "TMP", "TMPDIR"] as const;
/** The real profile, captured before any plugin instance points HOME/USERPROFILE at a temp home. */
const REAL_PROFILE = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

/**
 * startSampler inherits process.env at spawn time. With USERPROFILE pointing at the plugin's temp
 * home, powershell.exe's Get-CimInstance loop emits no snapshot at all (measured: 0 snapshots in
 * 6 s), so the sampler is spawned with the real profile restored for that synchronous call only.
 */
function startRealSampler(intervalMs: number): Sampler {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const put = (k: "HOME" | "USERPROFILE", v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  put("HOME", REAL_PROFILE.HOME);
  put("USERPROFILE", REAL_PROFILE.USERPROFILE);
  try {
    return startSampler({ intervalMs });
  } finally {
    put("HOME", saved.HOME);
    put("USERPROFILE", saved.USERPROFILE);
  }
}

/** Logs the measured numbers; with OMR_E2E_REPORT=<file> also appends them there (vitest may hide a passing test's console). */
function emit(text: string): void {
  console.log(text);
  const file = process.env.OMR_E2E_REPORT;
  if (file !== undefined && file !== "") appendFileSync(file, `${text}\n`, "utf8");
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function stats(values: number[]): string {
  return `p50=${percentile(values, 50).toFixed(0)}ms p95=${percentile(values, 95).toFixed(0)}ms max=${Math.max(...values).toFixed(0)}ms`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mod(i: number): string {
  return `src/m${String(i).padStart(2, "0")}.js`;
}

suite("verify resource budget: deferred (3.1.2.f-h)", { concurrent: false }, () => {
  let root = "";
  let slotDir = "";
  let homeA = "";
  let homeB = "";
  let repo: FixtureRepo | undefined;
  let base = "";
  const plugins: E2EPlugin[] = [];
  const savedTmp = new Map<string, string | undefined>();
  /** Handles of the 3.1.2.f dispatches, in dispatch order. */
  let fHandles: string[] = [];

  const r = (): FixtureRepo => {
    if (repo === undefined) throw new Error("fixture repo not prepared");
    return repo;
  };

  /** Every spelling of the repo dir and of the reference worktrees' prefix (QA-3.1-4: 8.3 vs long). */
  let spellings: string[] = [];
  /** The vitest-app copy's runner probe log (QA-3.1-9): one line per vitest main process. */
  let probeLog = "";
  /**
   * The mandated runner predicate: args mention the fixture repo dir (or a reference worktree) in
   * any spelling AND a test runner. The runner argv carries the long form while os.tmpdir() may be
   * 8.3 (QA-3.1-4), so a raw-spelling match found nothing.
   */
  const isRunner = (p: ProcSample): boolean => /vitest|jest|pytest/i.test(p.args) && mentionsAny(p.args, spellings);
  /** A broader cross-check: any descendant that looks like a runner or npm, wherever it runs. */
  const looksLikeRunner = (p: ProcSample): boolean => /vitest|jest|pytest|npm-cli|npm\.cmd|\bnpm\b/i.test(p.args);

  /** Runner-predicate matches: descendants of this process, and machine-wide (an orphan whose parent exited). */
  function runnersIn(snapshots: Snapshot[], samplerPid: number): { tree: ProcSample[]; machine: ProcSample[] } {
    return { tree: seen(snapshots, process.pid, [samplerPid], isRunner), machine: seenAnywhere(snapshots, [samplerPid], isRunner) };
  }

  /** QA-3.1-5: the sampler's real median interval, asserted against the documented bound. */
  function assertRate(tag: string, snapshots: Snapshot[]): void {
    const gaps = snapshotIntervals(snapshots);
    const m = median(gaps);
    emit(`[${tag}] sampler interval median=${m.toFixed(0)}ms ${gaps.length > 0 ? stats(gaps) : "n/a"} (bound ${SAMPLER_MEDIAN_INTERVAL_MAX_MS}ms)`);
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    expect(m).toBeLessThanOrEqual(SAMPLER_MEDIAN_INTERVAL_MAX_MS);
  }

  function probeLines(): ProbeEntry[] {
    return readProbeLog(probeLog);
  }

  async function reset(): Promise<void> {
    r().git("reset", "-q", "--hard", base);
    r().git("clean", "-q", "-fd", "-e", "node_modules", "-e", ".venv");
  }

  async function neutralEdit(rel: string, tag: string): Promise<void> {
    const text = await readFile(join(r().dir, rel), "utf8");
    await r().write(rel, `${text}\n// neutral edit ${tag}\n`);
  }

  async function breakModule(rel: string, from: string, to: string): Promise<void> {
    const text = await readFile(join(r().dir, rel), "utf8");
    if (!text.includes(from)) throw new Error(`${rel} does not contain ${from}`);
    await r().write(rel, text.replace(from, to));
  }

  function handleOf(res: E2ETaskResult): string | undefined {
    return FOOTER_RE.exec(res.output)?.[1];
  }

  async function slotLocks(): Promise<string[]> {
    if (!existsSync(slotDir)) return [];
    return (await readdir(slotDir)).filter(f => /^slot-\d+\.lock$/.test(f));
  }

  beforeAll(async () => {
    // The raw os.tmpdir() on purpose: on Windows it is often an 8.3 short path
    // (C:\Users\ABCDEF~1\...), and the plugin directory, TEMP and the reference worktrees must all
    // work under that spelling (E2E-2).
    root = await mkdtemp(join(os.tmpdir(), "omr-e2e-def-"));
    await mkdir(join(root, "repos"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    for (const k of ENV_TMP_KEYS) {
      savedTmp.set(k, process.env[k]);
      process.env[k] = join(root, "tmp");
    }
    slotDir = join(root, "tmp", "opencode-model-router", "verify-slots");
    homeA = join(root, "home", "a");
    homeB = join(root, "home", "b");
    await mkdir(join(root, "probe"), { recursive: true });
    probeLog = join(root, "probe", "vitest-app.log");
    repo = await prepareFixtureRepo("vitest-app", { root: join(root, "repos"), probeLog });
    base = repo.head();
    const tmp = join(root, "tmp");
    spellings = [...pathSpellings(repo.dir), ...pathSpellings(tmp).flatMap(t => [`${t}\\omr-ref-`, `${t}/omr-ref-`])];
    plugins.push(await createE2EPlugin({ directory: repo.dir, home: homeA, verify: {} }));
  }, 600_000);

  afterAll(async () => {
    for (const p of plugins.reverse()) {
      await p.dispose().catch((e: unknown) => process.stderr.write(`[deferred-e2e] dispose failed: ${String(e)}\n`));
    }
    for (const [k, v] of savedTmp) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // FixtureRepo.dispose unlinks a node_modules junction before removing the tree.
    if (repo !== undefined) await repo.dispose();
    if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }, 120_000);

  it("3.1.2.f: 20 parallel deferred delegations spawn no runner and take no slot", async () => {
    await reset();
    const plugin = plugins[0];
    // QA-3.1-11: this is the file's first test, so no slot was ever taken; the slot dir must not
    // come to exist at any moment of the run, not only be free of lock files at the end.
    expect(existsSync(slotDir)).toBe(false);
    let slotDirSeen = 0;
    let slotPolls = 0;
    const slotPoll = setInterval(() => {
      slotPolls++;
      if (existsSync(slotDir)) slotDirSeen++;
    }, SLOT_POLL_MS);
    const probeBefore = probeLines().length;
    const sampler = startRealSampler(100);
    let snapshots: Snapshot[] = [];
    let results: E2ETaskResult[] = [];
    try {
      // G-17: dispatch only once the sampler took its first snapshot. On win32 the sampler is a powershell.exe whose cold
      // start (CIM session included) used about a second of a 2-4 core windows-latest runner (PR #116: 32 snapshots at a
      // 110 ms median in a window of about 4.4 s, so the first came about 0.9 s in). That start overlapped the 20
      // before hooks and was counted in their capture wait (all 20 at 1950 ms, p50 bound 1500 ms). It is load from this
      // test, not from the plugin. Waiting also makes the sampler cover the whole dispatch window. A sampler that never
      // snapshots still fails the withSelf >= 5 check below.
      const live = Date.now() + 30_000;
      while (sampler.count() === 0 && Date.now() < live) await sleep(20);
      results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          plugin.task({
            sessionID: "orch-f",
            callID: `f-${i + 1}`,
            prompt: `Tidy module ${mod(i + 1)} without changing behaviour.\n${acceptance(r().testCommand)}`,
            description: `tidy ${mod(i + 1)}`,
            produce: () => neutralEdit(mod(i + 1), `f${i + 1}`),
          }),
        ),
      );
      await sleep(1000);
    } finally {
      snapshots = await sampler.stop();
      clearInterval(slotPoll);
    }

    const handles = results.map(handleOf);
    for (const [i, res] of results.entries()) expect(handles[i], res.output).toBeDefined();
    fHandles = handles as string[];
    expect(new Set(fHandles).size).toBe(20);

    const selfSnaps = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    const { tree: runners, machine } = runnersIn(snapshots, sampler.pid);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    const probes = probeLines().slice(probeBefore);
    const locks = await slotLocks();
    const before = results.map(x => x.beforeMs);
    const after = results.map(x => x.afterMs);
    // A finish cut by DEFERRED_FINISH_MS shows in the footer's risk reasons: before the change set
    // is known as UNATTRIBUTED_RISK_REASON, during static scoping as the S6 reason (the cap's
    // STATIC_SCOPING_UNFINISHED_REASON plan). A neutral src/mNN.js edit is neither.
    const capped = results.filter(x => CAP_FOOTER_MARKS.some(m => x.output.includes(m)));
    emit(
      `[3.1.2.f] dispatches=20 capture wait (beforeMs) ${stats(before)} | after-hook (afterMs) ${stats(after)} (cap ${DEFERRED_FINISH_MS}ms, at >= ${NEAR_CAP_MS}ms=${after.filter(x => x >= NEAR_CAP_MS).length}, capped footers=${capped.length})\n` +
        `[3.1.2.f] sampler snapshots=${snapshots.length} withSelf=${selfSnaps.length}\n` +
        `[3.1.2.f] runner processes seen (repo predicate)=${runners.length} machine-wide=${machine.length} broad=${broad.length} probe lines=${probes.length} ${broad.map(p => `${p.pid}:${p.args}`).join(" | ")}\n` +
        `[3.1.2.f] slot dir seen in ${slotDirSeen}/${slotPolls} polls, exists at end=${existsSync(slotDir)} lock files=${locks.length}\n` +
        `[3.1.2.f] slowest after hook's output:\n${[...results].sort((a, b) => b.afterMs - a.afterMs)[0]?.output ?? ""}`,
    );

    // Non-vacuous: the sampler saw this process in enough snapshots, at the documented rate.
    expect(selfSnaps.length).toBeGreaterThanOrEqual(5);
    assertRate("3.1.2.f", snapshots);
    expect(runners.map(p => p.args)).toEqual([]);
    expect(machine.map(p => p.args)).toEqual([]);
    expect(broad.map(p => p.args)).toEqual([]);
    // The probe does not sample: no vitest main started in the repo or a reference worktree at all.
    expect(probes).toEqual([]);
    expect(slotPolls).toBeGreaterThanOrEqual(20);
    expect(slotDirSeen).toBe(0);
    expect(existsSync(slotDir)).toBe(false);
    expect(locks).toEqual([]);
    for (const x of before) expect(x).toBeLessThanOrEqual(VERIFY_WAIT_DEFAULT_MS + HOOK_LATENCY_SLACK_MS);
    expect(percentile(before, 50)).toBeLessThanOrEqual(CAPTURE_WAIT_P50_MAX_MS);
    // QA-2.4-11: the plan said "within 50 ms"; the implementation bounds the deferred finish at
    // DEFERRED_FINISH_MS = 2 s (src/verify/wiring.ts), a documented deviation. QA-3.1-10: no finish
    // may reach that cap, where static scoping counts as impossible (the conservative reason).
    // A finish that reaches the cap is not a false pass (a cut drift digest makes router_verify
    // downgrade a later pass to unverifiable), so the bound allows the cap's timer slack; how many
    // finishes came near the cap is reported above.
    expect(Math.max(...after)).toBeLessThanOrEqual(DEFERRED_FINISH_MS + AFTER_TIMER_SLACK_MS);
    expect(capped.map(x => x.output)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.h (background: false): 3 s later still no runner, and the 20 handles stay listed as unverified", async () => {
    // With the default `background: false`, the 3.1.2.f run above already proved nothing runs while
    // the dispatches happen; this keeps watching afterwards.
    expect(fHandles.length).toBe(20);
    const probeBefore = probeLines().length;
    const sampler = startRealSampler(100);
    let snapshots: Snapshot[] = [];
    try {
      await sleep(3000);
    } finally {
      snapshots = await sampler.stop();
    }
    const selfSnaps = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    const { tree: runners, machine } = runnersIn(snapshots, sampler.pid);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    const probes = probeLines().slice(probeBefore);
    emit(
      `[3.1.2.h/bg-off] snapshots=${snapshots.length} withSelf=${selfSnaps.length} runners=${runners.length} machine-wide=${machine.length} broad=${broad.length} probe lines=${probes.length}`,
    );
    expect(selfSnaps.length).toBeGreaterThanOrEqual(5);
    assertRate("3.1.2.h/bg-off", snapshots);
    expect(runners.map(p => p.args)).toEqual([]);
    expect(machine.map(p => p.args)).toEqual([]);
    expect(broad.map(p => p.args)).toEqual([]);
    expect(probeLines().length).toBe(probeBefore);
    expect(await slotLocks()).toEqual([]);

    const system = (await plugins[0].systemPrompt("orch-f")).join("\n");
    expect(system).toContain(PENDING_HEADER);
    const listed = fHandles.filter(h => system.includes(h));
    // The list shows the 5 newest and summarises the rest.
    expect(listed.length).toBe(5);
    expect(system).toContain("- ... and 15 more");
    expect(system).not.toContain(LATE_NOTICE_MARK);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: VERIFY_WAIT:0s returns from the before hook quickly", async () => {
    const plugin = plugins[0];
    await reset();
    const plain = await plugin.task({
      sessionID: "orch-g-wait",
      callID: "g-wait-default",
      prompt: `Tidy module ${mod(3)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m03 (default wait)",
      // A real producer takes time; editing instantly can race the background capture (see report).
      produce: async () => {
        await sleep(1500);
        await neutralEdit(mod(3), "g-default");
      },
    });
    await reset();
    const zero = await plugin.task({
      sessionID: "orch-g-wait0",
      callID: "g-wait-zero",
      prompt: `VERIFY_WAIT:0s\nTidy module ${mod(4)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m04 (wait 0)",
      produce: async () => {
        await sleep(1500);
        await neutralEdit(mod(4), "g-zero");
      },
    });
    emit(
      `[3.1.2.g] beforeMs default=${plain.beforeMs.toFixed(0)}ms VERIFY_WAIT:0s=${zero.beforeMs.toFixed(0)}ms; ` +
        `afterMs default=${plain.afterMs.toFixed(0)}ms 0s=${zero.afterMs.toFixed(0)}ms`,
    );
    expect(handleOf(plain), plain.output).toBeDefined();
    expect(handleOf(zero), zero.output).toBeDefined();
    expect(zero.beforeMs).toBeLessThanOrEqual(300);
    expect(zero.beforeMs).toBeLessThanOrEqual(plain.beforeMs);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: VERIFY:required blocks until a verdict (introduced failure -> NOT ACCEPTED, no handle)", async () => {
    const plugin = plugins[0];
    await reset();
    const probeBefore = probeLines().length;
    const res = await plugin.task({
      sessionID: "orch-g-req",
      callID: "g-required",
      prompt: `VERIFY:required\nAdjust ${mod(20)}.\n${acceptance(r().testCommand)}`,
      description: "adjust m20 (required)",
      produce: () => breakModule(mod(20), "return x + 20;", "return x + 2000;"),
      // QA-3.1-15 (d): the producer's write is its child session's own edit tool call.
      childEdits: [mod(20)],
    });
    emit(`[3.1.2.g/required] beforeMs=${res.beforeMs.toFixed(0)}ms afterMs=${res.afterMs.toFixed(0)}ms\n${res.output}`);
    expect(res.output).toContain("NOT ACCEPTED");
    expect(res.output).not.toContain("vrf_");
    // QA-3.1-9: every vitest main of this dispatch ran inside its after hook, scoped.
    const probes = probeLines().slice(probeBefore);
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const p of probes) {
      expect(p.t, JSON.stringify(p)).toBeGreaterThanOrEqual(res.afterStartedAt);
      expect(p.t, JSON.stringify(p)).toBeLessThanOrEqual(res.returnedAt);
      expect(p.argv.length, JSON.stringify(p.argv)).toBeGreaterThan(1);
    }
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: VERIFY_WAIT:0s with the child's edit right away: the capture is contaminated, so the verdict is unverifiable and names the tool", async () => {
    // QA-3.1-15 (d): 3.1.2.g's other VERIFY_WAIT:0s case delays the producer by 1.5 s. Here the
    // child's edit tool fires as soon as the before hook returns, while the dispatch's capture is
    // still in flight (E2E-3's primary defence): the change set must be unavailable, never a pass.
    const plugin = plugins[0];
    await reset();
    const res = await plugin.task({
      sessionID: "orch-g-race",
      callID: "g-race",
      prompt: `VERIFY_WAIT:0s\nTidy module ${mod(6)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m06 (wait 0, immediate edit)",
      produce: () => neutralEdit(mod(6), "g-race"),
      childEdits: [mod(6)],
    });
    const h = handleOf(res);
    emit(`[3.1.2.g/race] beforeMs=${res.beforeMs.toFixed(0)}ms afterMs=${res.afterMs.toFixed(0)}ms\n${res.output}`);
    expect(h, res.output).toBeDefined();
    const report = await plugin.routerVerify({ handles: [h as string] }, { sessionID: "orch-g-race" });
    emit(`[3.1.2.g/race] report:\n${report}`);
    const line = report.split("\n").find(l => l.includes(h as string)) ?? "";
    expect(line).toMatch(/\u00b7 unverifiable\b/);
    expect(report).toContain('tool "edit"');
  }, TEST_TIMEOUT_MS);

  it("3.1.2.g: an edit after the producer returned is reported as drift, not a pass", async () => {
    const plugin = plugins[0];
    await reset();
    const res = await plugin.task({
      sessionID: "orch-g-drift",
      callID: "g-drift",
      prompt: `Tidy module ${mod(5)}.\n${acceptance(r().testCommand)}`,
      description: "tidy m05 (drift)",
      produce: () => neutralEdit(mod(5), "g-drift-1"),
      childEdits: [mod(5)],
    });
    const h = handleOf(res);
    expect(h, res.output).toBeDefined();
    await neutralEdit(mod(5), "g-drift-2");
    const report = await plugin.routerVerify({ handles: [h as string] }, { sessionID: "orch-g-drift" });
    emit(`[3.1.2.g/drift] report:\n${report}`);
    expect(report).toContain(DRIFT_NOTICE);
    const line = report.split("\n").find(l => l.includes(h as string)) ?? "";
    // Not a pass: drift downgrades the verdict (to unverifiable, or fail if tests broke). Under the
    // default strictUnverifiable=false an unverifiable verdict is still returned with a NOT-verified
    // caveat (QA-2.2-17), labelled UNVERIFIED and never accepted or verified (QA-3.1-21, plan G2).
    expect(line).not.toMatch(/\u00b7 pass\b/);
    expect(line).toMatch(/\u00b7 (unverifiable|fail)\b/);
    expect(report).not.toMatch(/\[router \u2713|\u2713 accepted|verified:/);
  }, TEST_TIMEOUT_MS);

  it("3.1.2.h: background: true reports an introduced failure once, as a late notice", async () => {
    await reset();
    const plugin = await createE2EPlugin({ directory: r().dir, home: homeB, verify: { background: true } });
    plugins.push(plugin);
    const probeBefore = probeLines().length;
    const sampler = startRealSampler(100);
    let snapshots: Snapshot[] = [];
    let notice = "";
    let h = "";
    const t0 = Date.now();
    try {
      const res = await plugin.task({
        sessionID: "orch-h-bg",
        callID: "h-bg",
        prompt: `Adjust ${mod(19)}.\n${acceptance(r().testCommand)}`,
        description: "adjust m19 (background)",
        produce: () => breakModule(mod(19), "return x + 19;", "return x + 1900;"),
      });
      h = handleOf(res) ?? "";
      expect(h, res.output).not.toBe("");
      emit(`[3.1.2.h/bg-on] beforeMs=${res.beforeMs.toFixed(0)}ms afterMs=${res.afterMs.toFixed(0)}ms handle=${h}`);
      while (Date.now() - t0 < 90_000) {
        const system = (await plugin.systemPrompt("orch-h-bg")).join("\n");
        if (system.includes(LATE_NOTICE_MARK)) {
          notice = system;
          break;
        }
        await sleep(500);
      }
    } finally {
      snapshots = await sampler.stop();
    }
    const { tree: runners, machine } = runnersIn(snapshots, sampler.pid);
    const broad = seen(snapshots, process.pid, [sampler.pid], looksLikeRunner);
    const probes = probeLines().slice(probeBefore);
    const livePeak = lifetimePeak(snapshots, process.pid, [sampler.pid], isRunner);
    emit(
      `[3.1.2.h/bg-on] late notice after ${Date.now() - t0}ms; runners seen (repo predicate)=${runners.length} machine-wide=${machine.length} broad=${broad.length} lifetime peak=${livePeak}\n` +
        `${broad.map(p => `  ${p.pid} prio=${String(p.priority)}: ${p.args}`).join("\n")}\n` +
        `[3.1.2.h/bg-on] probe lines=${probes.length}: ${probes.map(p => `${p.cwd} ${JSON.stringify(p.argv)}`).join(" | ")}\n${notice}`,
    );
    assertRate("3.1.2.h/bg-on", snapshots);
    // QA-3.1-4 positive control: the background run is a real vitest in the repo, and the runner
    // predicate (every path spelling) must see it, among descendants and machine-wide; the probe
    // records its main process independently of the sampler.
    expect(runners.length).toBeGreaterThanOrEqual(1);
    expect(machine.length).toBeGreaterThanOrEqual(runners.length);
    expect(probes.length).toBeGreaterThanOrEqual(1);
    for (const p of probes) expect(p.argv[0], JSON.stringify(p.argv)).toMatch(/^(related|run)$/);
    expect(probes.some(p => mentionsAny(p.cwd, pathSpellings(r().dir)) && p.argv[0] === "related")).toBe(true);
    const header = "[router] Background verification found introduced failures:";
    expect(notice).toContain(header);
    // The pending list also names the handle; the late-notice entry is the one after its header.
    const block = notice.slice(notice.indexOf(header));
    const entry = block.split("\n").find(l => l.startsWith(`- ${h}`)) ?? "";
    expect(entry).toContain("failing:");
    expect(entry).toMatch(/m19/);
    const again = (await plugin.systemPrompt("orch-h-bg")).join("\n");
    expect(again).not.toContain(LATE_NOTICE_MARK);
  }, TEST_TIMEOUT_MS);
});
