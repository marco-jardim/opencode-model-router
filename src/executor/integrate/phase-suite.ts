/**
 * Phase suite runner (plan 3.2.4, memo 3.2.1 §4.4, M21-M27).
 */
import {
  CHECK_TRIES, PREEMPT_BUDGET,
  type BackgroundRuns, type CheckErrorReason, type PreemptBudget, type CheckResult, type CommandRunRequest, type CommandRunResult, type IntegrateGit,
  type IntegrationChecks, type Logger, type ResolvedCommand, type RunResolver,
} from "./checks";
import {
  bisectRanges, orderRanges,
  type ProbeVerdict, type RangeBisectResult, type TaskRange,
} from "./bisect";
import type {
  PhaseSuiteRunner, RevertRequest, RevertVerdict, StepDetail, StepJournal, SuiteResolution, SuiteRunRequest, SuiteVerdict,
} from "./queue";
import { COMMIT_SUBJECT_PATTERN, formatCommitMessage, type GitOps } from "../git";
import { ExecutorError, type Clock, type IntegrationStep, type LedgerV1, type PhaseId, type PlanId, type SlotPool, type TaskId } from "../types";

export interface PhaseSuiteDeps {
  checks: IntegrationChecks; igit: IntegrateGit; git: GitOps; pool: SlotPool;
  resolver: RunResolver; background: BackgroundRuns; clock: Clock; logger: Logger;
}

/**
 * M22: `reproduced` = original ids failing in at least one rerun; `flaky` = original ids minus `reproduced`.
 * Only the original ids count; ids that fail only in a rerun are ignored. Order follows `original`.
 */
export function classifyReruns(original: readonly string[], reruns: readonly [readonly string[], readonly string[]]):
  { reproduced: string[]; flaky: string[] } {
  const failed = new Set<string>([...reruns[0], ...reruns[1]]);
  const reproduced: string[] = [];
  const flaky: string[] = [];
  const seen = new Set<string>();
  for (const id of original) {
    if (seen.has(id)) continue;
    seen.add(id);
    (failed.has(id) ? reproduced : flaky).push(id);
  }
  return { reproduced, flaky };
}

// ---------------------------------------------------------------------------------------------------------------
// Step retries (M13a) and preemption (M12), shared by the suite run and the revert
// ---------------------------------------------------------------------------------------------------------------

type StepFailure = { reason: CheckErrorReason; message: string };
type Attempt<T> = { error: StepFailure; value?: undefined } | { error: null; value: T };
type Stepped<T> = { kind: "ok"; value: T } | { kind: "error"; reason: CheckErrorReason; message: string }
  | { kind: "interrupted"; by: "abort" | "dispose" };

/**
 * Who stopped the run, read from the journal signal's abort reason: `"dispose"` (or an `E_DISPOSED` ExecutorError)
 * is dispose, anything else (`"abort"`, the default AbortError) is abort. The queue aborts with the matching reason.
 */
export function interruptedBy(j: Pick<StepJournal, "signal">): "abort" | "dispose" {
  const r: unknown = j.signal.reason;
  return r === "dispose" || (r instanceof ExecutorError && r.code === "E_DISPOSED") ? "dispose" : "abort";
}

/**
 * The `unattributed` reason of a failure the phase base cannot split by ids (QA-3.2-1): the suite's failure names no
 * id, or the base run's output names none. Distinct from `no-base` (the phase has no base at all).
 */
const BASE_UNPARSED: Extract<SuiteVerdict, { kind: "unattributed" }>["reason"] = "base-unparsed";

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

/**
 * Runs `op` while `step` is open. A preempted attempt closes the step as refused and reopens it with the same
 * detail (it does not use the try budget, M38). Any other error does the same, at most CHECK_TRIES times; after
 * that no step is left open. An interrupted run leaves the step open and journals nothing more.
 */
async function stepped<T>(j: StepJournal, step: IntegrationStep, detail: StepDetail, op: () => Promise<Attempt<T>>): Promise<Stepped<T>> {
  let tries = 0;
  let preempts = 0;
  for (;;) {
    if (j.signal.aborted) return { kind: "interrupted", by: interruptedBy(j) };
    const r = await op();
    if (r.error === null) return { kind: "ok", value: r.value };
    const e = r.error;
    if (j.signal.aborted || e.reason === "interrupted") return { kind: "interrupted", by: interruptedBy(j) };
    if (e.reason === "preempted") {
      preempts++;
      await j.end("refused", { v: 1, reason: "preempted", n: preempts });
      await j.start(step, detail);
      continue;
    }
    tries++;
    await j.end("refused", { v: 1, reason: e.reason, message: clip(e.message, 1000) });
    if (tries >= CHECK_TRIES) return { kind: "error", reason: e.reason, message: e.message };
    await j.start(step, detail);
  }
}

/** Raised inside the bisect probe to unwind `bisectRanges` with the non-ok outcome of a probe. */
class ProbeStop extends Error {
  override readonly name = "ProbeStop" as const;
  constructor(readonly outcome: Exclude<Stepped<CommandRunResult>, { kind: "ok" }>) {
    super("bisect probe stopped");
  }
}

/** Failure ids of a run for classification: an unparsed failure counts as every id of `original`. */
function failedIdsOf(r: CommandRunResult, original: readonly string[]): string[] {
  if (r.verdict !== "fail") return [];
  // Fail closed: a failing rerun that names none of the original ids (other ids, another id form) clears none of them.
  return r.idsUnparsed || !r.ids.some(id => original.includes(id)) ? [...original] : r.ids;
}

async function runSuite(d: PhaseSuiteDeps, req: SuiteRunRequest, j: StepJournal): Promise<SuiteVerdict> {
  const startDetail: StepDetail = { v: 1, commit: req.commit, base: req.base, commands: req.commands.map(c => ({ label: c.label, ref: c.ref })) };
  // QA-3.2-8 (M38): one preemption budget for the whole suite entry, shared by every run below. Once spent, the
  // entry's runs register with nothing left, so a foreground check waits instead of preempting again.
  const preempt: PreemptBudget = { left: PREEMPT_BUDGET };
  const exec = async (commit: string, mode: CommandRunRequest["mode"], requireRun = false): Promise<Attempt<CommandRunResult>> => {
    await j.assertWriteCwd(req.slot.path, "slot");
    const r = await d.checks.runCommands({
      slot: req.slot, commit, commands: req.commands, mode, priority: "background", signal: j.signal, prepare: true, preempt, requireRun,
    });
    if (r.verdict === "error") return { error: r.error ?? { reason: "spawn", message: "the run failed without a reason" } };
    return { error: null, value: r };
  };
  const memoStep = async (tasks: readonly TaskId[]): Promise<void> => {
    await j.start("bisect", { v: 1, base: req.base ?? req.commit, candidate: req.commit, tasks: [...tasks], probe: "memo" });
  };

  // 1. The full run; the phase-suite step is already open (the queue journaled it with the entry).
  const first = await stepped(j, "phase-suite", startDetail, () => exec(req.commit, "full"));
  if (first.kind !== "ok") return first;
  const full = first.value;
  if (full.verdict === "pass") return { kind: "passed" };
  // The full run names its failing ids from the output (QA-3.2-1). ids = [] only when the failure cannot be
  // attributed to ids (collection error, a timeout, an incomplete inventory): then reruns and probes run the full
  // commands (M22), and a base that fails too pauses the phase (unattributed, fail closed).
  const attributable = !full.idsUnparsed && full.ids.length > 0 && full.files.length > 0;
  const ids = attributable ? full.ids : [];
  const files = attributable ? full.files : [];
  const mode: CommandRunRequest["mode"] = attributable ? { rerun: files } : "full";
  await j.end("failed", { v: 1, files: full.files, idsUnparsed: full.idsUnparsed, durationMs: full.durationMs, output: full.output }, ids);

  // 2. Two reruns at the suite commit. QA-3.2-22: they must run the failing files there; a rerun that ran nothing
  // is a failure (unparsed), never a pass.
  const rerunFailed: string[][] = [];
  let anyRerunFailed = false;
  let reproduced: string[] = [];
  for (const n of [1, 2] as const) {
    const detail: StepDetail = { v: 1, n, files };
    await j.start("suite-rerun", detail);
    const s = await stepped(j, "suite-rerun", detail, () => exec(req.commit, mode, true));
    if (s.kind !== "ok") return s;
    rerunFailed.push(failedIdsOf(s.value, ids));
    if (s.value.verdict === "fail") anyRerunFailed = true;
    if (n === 1) {
      await j.end(s.value.verdict === "fail" ? "failed" : "ok", { v: 1, durationMs: s.value.durationMs, output: s.value.output }, rerunFailed[0] ?? []);
      continue;
    }
    const classified = classifyReruns(ids, [rerunFailed[0] ?? [], rerunFailed[1] ?? []]);
    let last = s.value;
    reproduced = classified.reproduced;
    if (attributable && reproduced.length === 0) {
      // QA-3.2-23: reruns of the failing files alone never clear the failure: one green run of the full commands
      // (in the same open step) must agree before it is flaky. A red one reproduces the original ids it names (all
      // of them when it names none).
      const whole = await stepped(j, "suite-rerun", detail, () => exec(req.commit, "full"));
      if (whole.kind !== "ok") return whole;
      last = whole.value;
      reproduced = classifyReruns(ids, [failedIdsOf(last, ids), []]).reproduced;
    }
    const flaky = attributable ? reproduced.length === 0 : !anyRerunFailed;
    if (flaky) return { kind: "flaky", ids: classified.flaky }; // the second rerun stays open: the queue closes the entry with it
    await j.end("failed", { v: 1, reproduced, durationMs: last.durationMs, output: last.output }, reproduced);
  }

  // 3. The phase base (M23): failures that also fail there are pre-existing and not bisected. QA-3.2-23: the base runs
  // the full commands, so pre-existing rests on a complete inventory of the whole base run, not of the failing files.
  if (req.base === null) {
    await memoStep(req.ranges.map(r => r.taskId));
    return { kind: "unattributed", ids: reproduced, reason: "no-base" };
  }
  const base = req.base;
  const baseDetail: StepDetail = { v: 1, at: "base", commit: base, files };
  await j.start("suite-rerun", baseDetail);
  const atBase = await stepped(j, "suite-rerun", baseDetail, () => exec(base, "full"));
  if (atBase.kind !== "ok") return atBase;
  const baseRun = atBase.value;
  // QA-3.2-1 (2): fail closed. When the base failure cannot be split by ids (the suite's failure has none, or the base
  // run's output names none), nothing can be shown pre-existing: the phase pauses (unattributed), it never passes.
  if (baseRun.verdict === "fail" && (!attributable || baseRun.idsUnparsed)) {
    await j.end("failed", { v: 1, durationMs: baseRun.durationMs, output: baseRun.output }, reproduced);
    await memoStep(req.ranges.map(r => r.taskId));
    return { kind: "unattributed", ids: reproduced, reason: BASE_UNPARSED };
  }
  const preexisting = new Set(baseRun.verdict === "fail" ? baseRun.ids : []);
  const regression = reproduced.filter(id => !preexisting.has(id));
  // Without ids (`!attributable`, the base passed) the regression is the whole failure: bisect with the full commands.
  if (attributable && regression.length === 0) return { kind: "pre-existing", ids: reproduced }; // the base step stays open
  await j.end(baseRun.verdict === "fail" ? "failed" : "ok", { v: 1, durationMs: baseRun.durationMs, output: baseRun.output }, baseRun.verdict === "fail" ? baseRun.ids : []);

  // M22 "bisect using only regression.files": the probes run only the failing files that do not already fail at the base.
  // With QA-3.2-26 (a failing probe fails, whatever ids it names) a pre-existing failure in a probed file would fail
  // every probe and blame the first range. When every failing file also fails at the base (a regression sharing a file
  // with a pre-existing failure), the regression cannot be isolated: fail closed, unattributed, nobody blamed.
  const baseFiles = new Set(baseRun.verdict === "fail" ? baseRun.files : []);
  const probeFiles = attributable ? files.filter(f => !baseFiles.has(f)) : [];
  if (attributable && probeFiles.length === 0) {
    await memoStep(req.ranges.map(r => r.taskId));
    return { kind: "unattributed", ids: regression, reason: "base-overlap" };
  }
  const probeMode: CommandRunRequest["mode"] = attributable ? { rerun: probeFiles } : "full";

  // 4. Bisect over the phase's ranges, running only the regression.
  let ordered: TaskRange[];
  try {
    ordered = orderRanges(req.ranges, await d.igit.revList(req.slot.path, base, req.commit));
  } catch (e) {
    if (e instanceof Error && e.message.includes("is not in the phase chain")) {
      await memoStep(req.ranges.map(r => r.taskId));
      return { kind: "unattributed", ids: regression, reason: "outside" };
    }
    return { kind: "error", reason: "prepare", message: e instanceof Error ? e.message : String(e) };
  }
  const labels = new Map<string, { taskId: TaskId; probe: "to" | "from" }>();
  for (const r of ordered) {
    if (!labels.has(r.from)) labels.set(r.from, { taskId: r.taskId, probe: "from" });
    labels.set(r.to, { taskId: r.taskId, probe: "to" });
  }
  let probes = 0;
  const probe = async (commit: string): Promise<ProbeVerdict> => {
    const label = labels.get(commit) ?? { taskId: ordered[0]?.taskId ?? "", probe: "to" as const };
    const detail: StepDetail = { v: 1, candidate: commit, taskId: label.taskId, probe: label.probe };
    await j.start("bisect", detail);
    const s = await stepped(j, "bisect", detail, () => exec(commit, probeMode));
    if (s.kind !== "ok") throw new ProbeStop(s);
    probes++;
    // QA-3.2-26: fail closed. A failing probe fails, whichever ids it names: a run of the regression files that names
    // none of the regression ids (another id form, or another failure masking them) is no evidence of a pass.
    const failed = s.value.verdict === "fail";
    await j.end(failed ? "failed" : "ok", { v: 1, verdict: failed ? "fail" : "pass", probes }, failed ? regression : []);
    return failed ? "fail" : "pass";
  };
  let found: RangeBisectResult;
  try {
    found = await bisectRanges(ordered, req.commit, probe, new Map<string, ProbeVerdict>([[base, "pass"]]));
  } catch (e) {
    if (e instanceof ProbeStop) return e.outcome;
    throw e;
  }
  j.counter("integration.bisect.probes", probes, { kind: "suite" });
  await memoStep(ordered.map(r => r.taskId));
  if (found.kind === "outside") return { kind: "unattributed", ids: regression, reason: "outside" };
  // The revert's regression checks run the files the bisect ran (the regression's own files).
  return { kind: "culprit", range: found.range, ids: regression, files: attributable ? probeFiles : files };
}

type BuiltRevert = { kind: "built"; head: string; reverted: string[] } | { kind: "conflict"; at: string; paths: string[] };

/**
 * M26: the revert of the culprit range is built in the `integration` slot at the current head, newest commit first,
 * then the integration checks run on it with the regression ids as extra (I1: nothing moves before they pass).
 * The runner never fast-forwards; the queue does that on `ok`. The `revert-build` step is open on entry.
 */
async function runRevert(d: PhaseSuiteDeps, req: RevertRequest, j: StepJournal): Promise<RevertVerdict> {
  const cwd = req.slot.path;
  const { culprit } = req;
  const range = { taskId: culprit.taskId, from: culprit.from, to: culprit.to };
  const buildDetail: StepDetail = { v: 1, culprit: range, suiteCommit: req.suiteCommit, head: req.head, files: [...req.regression.files] };
  const built = await stepped<BuiltRevert>(j, "revert-build", buildDetail, async () => {
    await j.assertWriteCwd(cwd, "integration");
    try {
      await d.checks.prepare(req.slot, req.head);
    } catch (e) {
      return { error: { reason: "prepare", message: e instanceof Error ? e.message : String(e) } };
    }
    try {
      const newestFirst = (await d.igit.revList(cwd, culprit.from, culprit.to)).reverse();
      if (newestFirst.length === 0) return { error: { reason: "prepare", message: `range ${culprit.from}..${culprit.to} holds no commit to revert` } };
      for (const sha of newestFirst) {
        const message = revertMessage(await d.igit.subject(cwd, sha), culprit.taskId, culprit.from, culprit.to, req.phaseId, req.planId);
        const r = await d.git.revert(cwd, sha, message);
        if (!r.ok) return { error: null, value: { kind: "conflict", at: sha, paths: [...r.conflicts] } };
      }
      return { error: null, value: { kind: "built", head: await d.git.revParse(cwd, "HEAD"), reverted: newestFirst } };
    } catch (e) {
      return { error: { reason: "spawn", message: e instanceof Error ? e.message : String(e) } };
    }
  });
  if (built.kind !== "ok") return built;
  if (built.value.kind === "conflict") return { kind: "conflict", at: built.value.at, paths: built.value.paths };
  const { head: revertHead, reverted } = built.value;
  await j.end("ok", { v: 1, revertHead, reverted });

  const checkDetail: StepDetail = { v: 1, base: req.head, candidate: revertHead, extraFiles: [...req.regression.files] };
  await j.start("revert-checks", checkDetail, { candidate: revertHead });
  const checked = await stepped<CheckResult>(j, "revert-checks", checkDetail, async () => {
    const r = await d.checks.run({
      slot: req.slot, base: req.head, candidate: revertHead, priority: "foreground", signal: j.signal,
      extra: { ids: [...req.regression.ids], files: [...req.regression.files], commands: [...req.regression.commands] },
    });
    return r.verdict === "error" ? { error: { reason: r.reason, message: r.message } } : { error: null, value: r };
  });
  if (checked.kind !== "ok") return checked;
  const result = checked.value;
  // The revert-checks step stays open: the queue closes it (ok) or closes the entry with the failure.
  if (result.verdict === "fail") return { kind: "failed", ids: result.failingIds, files: result.failingFiles, output: result.output };
  return { kind: "ok", revertHead, reverted };
}

/** M21: what the phase suite is at `commit`. Reads through git, so no slot is touched before the journal. */
async function resolveSuite(d: PhaseSuiteDeps, ledger: Readonly<LedgerV1>, phaseId: PhaseId, commit: string): Promise<SuiteResolution> {
  const setting = ledger.config.phaseSuite;
  if (setting === "off") return { kind: "off" };
  const cwd = ledger.integration.worktree;
  if (setting === "auto") {
    try {
      const selection = await d.checks.select(cwd, commit);
      const commands = selection.tests.map(t => t.full);
      return commands.length === 0 ? { kind: "none" } : { kind: "runs", commands };
    } catch (e) {
      return { kind: "refused", reason: `phase ${phaseId} suite selection failed: ${e instanceof Error ? e.message : String(e)}`, ref: null };
    }
  }
  if (setting.length === 0) return { kind: "none" };
  const commands: ResolvedCommand[] = [];
  for (const ref of setting) {
    let r: Awaited<ReturnType<RunResolver["resolve"]>>;
    try {
      r = await d.resolver.resolve(ref, cwd);
    } catch (e) {
      return { kind: "refused", reason: e instanceof Error ? e.message : String(e), ref };
    }
    if (!r.ok) return { kind: "refused", reason: r.reason, ref };
    commands.push(r.command);
  }
  return { kind: "runs", commands };
}

export function createPhaseSuiteRunner(d: PhaseSuiteDeps): PhaseSuiteRunner {
  return {
    resolve: (ledger, phaseId, commit) => resolveSuite(d, ledger, phaseId, commit),
    run: (req, j) => runSuite(d, req, j),
    revert: (req, j) => runRevert(d, req, j),
    preemptBackground: () => d.background.preemptOne(),
  };
}

/**
 * Revert commit message (M26). `GitOps.revert` accepts only a one-line `COMMIT_SUBJECT_PATTERN` subject (no body), so the
 * message is `revert(<phase>): <taskId> <from>..<to> "<subject>" [<planId>:<taskId>]` via `formatCommitMessage` (the
 * title is cut at 72 characters). `planId` defaults to the `[plan:task]` suffix of the reverted subject.
 */
export function revertMessage(subject: string, taskId: TaskId, from: string, to: string, phaseId: PhaseId, planId?: PlanId): string {
  const plan = planId ?? COMMIT_SUBJECT_PATTERN.exec(subject)?.[4];
  if (plan === undefined) {
    throw new ExecutorError("E_INVALID_INPUT", "revert message needs the plan id", { subject: subject.slice(0, 200) });
  }
  const scope = /^[\w.-]+$/.test(phaseId) ? phaseId : "phase";
  const title = `${taskId} ${from.slice(0, 7)}..${to.slice(0, 7)} "${subject.replace(/ \[[^\]]*\]$/, "")}"`;
  return formatCommitMessage({ type: "revert", scope, title, planId: plan, taskId });
}
