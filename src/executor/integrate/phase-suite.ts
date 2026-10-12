/**
 * Phase suite runner (plan 3.2.4, memo 3.2.1 §4.4, M21-M27).
 */
import {
  CHECK_TRIES,
  type BackgroundRuns, type CheckErrorReason, type CheckResult, type CommandRunRequest, type CommandRunResult, type IntegrateGit,
  type IntegrationChecks, type Logger, type ResolvedCommand, type RunResolver,
} from "./checks";
import {
  bisectRanges, orderRanges,
  type ProbeVerdict, type RangeBisectResult, type TaskRange,
} from "./bisect";
import type {
  PhaseSuiteRunner, RevertRequest, RevertVerdict, StepDetail, StepJournal, SuiteResolution, SuiteRunRequest, SuiteVerdict,
} from "./queue";
import type { GitOps } from "../git";
import type { Clock, IntegrationStep, LedgerV1, PhaseId, SlotPool, TaskId } from "../types";

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

function interruptedBy(j: StepJournal): "abort" | "dispose" {
  return j.signal.reason === "dispose" ? "dispose" : "abort";
}

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
  return r.idsUnparsed || r.ids.length === 0 ? [...original] : r.ids;
}

async function runSuite(d: PhaseSuiteDeps, req: SuiteRunRequest, j: StepJournal): Promise<SuiteVerdict> {
  const startDetail: StepDetail = { v: 1, commit: req.commit, base: req.base, commands: req.commands.map(c => ({ label: c.label, ref: c.ref })) };
  const exec = async (commit: string, mode: CommandRunRequest["mode"]): Promise<Attempt<CommandRunResult>> => {
    await j.assertWriteCwd(req.slot.path, "slot");
    const r = await d.checks.runCommands({ slot: req.slot, commit, commands: req.commands, mode, priority: "background", signal: j.signal, prepare: true });
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
  // ids = [] when the failure cannot be attributed to ids (collection error, unparsed output): then reruns and
  // probes run the full commands (M22).
  const attributable = !full.idsUnparsed && full.ids.length > 0 && full.files.length > 0;
  const ids = attributable ? full.ids : [];
  const files = attributable ? full.files : [];
  const mode: CommandRunRequest["mode"] = attributable ? { rerun: files } : "full";
  await j.end("failed", { v: 1, files: full.files, idsUnparsed: full.idsUnparsed, durationMs: full.durationMs, output: full.output }, ids);

  // 2. Two reruns at the suite commit.
  const rerunFailed: string[][] = [];
  let anyRerunFailed = false;
  for (const n of [1, 2] as const) {
    const detail: StepDetail = { v: 1, n, files };
    await j.start("suite-rerun", detail);
    const s = await stepped(j, "suite-rerun", detail, () => exec(req.commit, mode));
    if (s.kind !== "ok") return s;
    rerunFailed.push(failedIdsOf(s.value, ids));
    if (s.value.verdict === "fail") anyRerunFailed = true;
    if (n === 1) {
      await j.end(s.value.verdict === "fail" ? "failed" : "ok", { v: 1, durationMs: s.value.durationMs, output: s.value.output }, rerunFailed[0] ?? []);
      continue;
    }
    const classified = classifyReruns(ids, [rerunFailed[0] ?? [], rerunFailed[1] ?? []]);
    const flaky = attributable ? classified.reproduced.length === 0 : !anyRerunFailed;
    if (flaky) return { kind: "flaky", ids: classified.flaky }; // the second rerun stays open: the queue closes the entry with it
    await j.end("failed", { v: 1, reproduced: classified.reproduced, durationMs: s.value.durationMs, output: s.value.output }, classified.reproduced);
  }
  const reproduced = attributable ? classifyReruns(ids, [rerunFailed[0] ?? [], rerunFailed[1] ?? []]).reproduced : [];

  // 3. The phase base (M23): failures that also fail there are pre-existing and not bisected.
  if (req.base === null) {
    await memoStep(req.ranges.map(r => r.taskId));
    return { kind: "unattributed", ids: reproduced, reason: "no-base" };
  }
  const base = req.base;
  const baseDetail: StepDetail = { v: 1, at: "base", commit: base, files };
  await j.start("suite-rerun", baseDetail);
  const atBase = await stepped(j, "suite-rerun", baseDetail, () => exec(base, mode));
  if (atBase.kind !== "ok") return atBase;
  const baseRun = atBase.value;
  let regression: string[];
  if (!attributable) {
    if (baseRun.verdict === "fail") return { kind: "pre-existing", ids: [] };
    regression = [];
  } else {
    if (baseRun.verdict === "fail" && baseRun.idsUnparsed) {
      await j.end("failed", { v: 1, durationMs: baseRun.durationMs, output: baseRun.output }, reproduced);
      await memoStep(req.ranges.map(r => r.taskId));
      return { kind: "unattributed", ids: reproduced, reason: "no-base" };
    }
    const preexisting = new Set(baseRun.verdict === "fail" ? baseRun.ids : []);
    regression = reproduced.filter(id => !preexisting.has(id));
    if (regression.length === 0) return { kind: "pre-existing", ids: reproduced }; // the base step stays open
  }
  await j.end(baseRun.verdict === "fail" ? "failed" : "ok", { v: 1, durationMs: baseRun.durationMs, output: baseRun.output }, baseRun.verdict === "fail" ? baseRun.ids : []);

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
  const wanted = new Set(regression);
  let probes = 0;
  const probe = async (commit: string): Promise<ProbeVerdict> => {
    const label = labels.get(commit) ?? { taskId: ordered[0]?.taskId ?? "", probe: "to" as const };
    const detail: StepDetail = { v: 1, candidate: commit, taskId: label.taskId, probe: label.probe };
    await j.start("bisect", detail);
    const s = await stepped(j, "bisect", detail, () => exec(commit, mode));
    if (s.kind !== "ok") throw new ProbeStop(s);
    probes++;
    const r = s.value;
    const failed = r.verdict === "fail" && (!attributable || r.idsUnparsed || r.ids.some(id => wanted.has(id)));
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
  return { kind: "culprit", range: found.range, ids: regression, files };
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
        const message = revertMessage(await d.igit.subject(cwd, sha), culprit.taskId, culprit.from, culprit.to, req.phaseId);
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

/** Revert commit message (M26). */
export function revertMessage(subject: string, taskId: TaskId, from: string, to: string, phaseId: PhaseId): string {
  return `Revert "${subject}"\n\nomr: revert ${taskId} ${from}..${to} (phase ${phaseId} suite failure)`;
}
