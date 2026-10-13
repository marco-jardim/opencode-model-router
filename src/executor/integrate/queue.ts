/**
 * Integration queue (plan 3.2.3, design memo 3.2.1 in docs/qa/critical-path-execution/phase-3.2.md).
 *
 * The only module that journals integration entries. It owns every move of the integration branch
 * (I1: `merge --ff-only` to a checked commit, then a CAS on the branch ref) and journals every step
 * before and after its git writes (I4).
 */
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import * as nodePath from "node:path";
import {
  AX_MAX_CHARS,
  CHECK_TRIES,
  DETAIL_MAX_BYTES,
  OUTPUT_TAIL_BYTES,
  type CheckErrorReason,
  type CheckResult,
  type CreateRefOutcome,
  type IntegrateGit,
  type IntegrationChecks,
  type Logger,
  type ResolvedCommand,
  type WriteGuard,
  type WritePurpose,
} from "./checks";
import type { GitOps } from "../git";
import {
  ExecutorError,
  TASK_TRANSITIONS,
  formatInboxId,
  nextInboxNumber,
  type BatchBuilder,
  type Clock,
  type ExecutorEvent,
  type ExecutorEventInput,
  type GateState,
  type GateTrigger,
  type InboxItem,
  type InboxKind,
  type IntegrationEntry,
  type IntegrationListener,
  type IntegrationQueue,
  type IntegrationStep,
  type IntegrationStepResult,
  type IsoTime,
  type LeaseService,
  type LedgerV1,
  type LedgerWriter,
  type OpenIntegrationEntry,
  type PhaseId,
  type PlanId,
  type ResumeReport,
  type RunCommandRef,
  type SlotLease,
  type SlotPool,
  type TaskId,
  type TaskState,
  type TransitionTrigger,
} from "../types";

export const PREEMPT_LIMIT = 3, LOCK_HEARTBEAT_MS = 30_000, LOCK_STALE_MS = 600_000, STALLED_POLL_MS = 5_000;
/** QA-3.2-33: a repo-lock wait is reported once after this long. */
export const LOCK_WAIT_REPORT_MS = 300_000;
/** QA-3.2-30: retries of a tag entry of a completed plan (after its 3 tries), with doubling delays from TAG_RETRY_BASE_MS. */
export const TAG_RETRY_LIMIT = 3, TAG_RETRY_BASE_MS = 60_000;

export interface TaskRange { taskId: TaskId; from: string; to: string }

export type SuiteResolution = { kind: "off" } | { kind: "none" } | { kind: "runs"; commands: ResolvedCommand[] }
  | { kind: "refused"; reason: string; ref: RunCommandRef | null };
export interface SuiteRunRequest {
  planId: PlanId; phaseId: PhaseId; commit: string; base: string | null;
  ranges: readonly TaskRange[]; commands: readonly ResolvedCommand[]; slot: SlotLease;
}
export type SuiteVerdict = { kind: "passed" } | { kind: "flaky"; ids: string[] } | { kind: "pre-existing"; ids: string[] }
  | { kind: "culprit"; range: TaskRange; ids: string[]; files: string[] }
  | { kind: "unattributed"; ids: string[]; reason: "outside" | "no-base" | "base-unparsed" | "base-overlap" }
  | { kind: "error"; reason: CheckErrorReason; message: string } | { kind: "interrupted"; by: "abort" | "dispose" };
export interface RevertRequest {
  planId: PlanId; phaseId: PhaseId; culprit: TaskRange; suiteCommit: string; head: string;
  regression: { ids: string[]; files: string[]; commands: ResolvedCommand[] }; slot: SlotLease;
}
export type RevertVerdict = { kind: "ok"; revertHead: string; reverted: string[] } | { kind: "conflict"; at: string; paths: string[] }
  | { kind: "failed"; ids: string[]; files: string[]; output: string } | { kind: "error"; reason: CheckErrorReason; message: string }
  | { kind: "interrupted"; by: "abort" | "dispose" };
export interface LandRequest { toplevel: string; baseBranch: string; candidate: string; integrationBranch: string }
export type LandRefusal = { reason: "toplevel-mismatch"; actual: string } | { reason: "not-checked-out"; head: string | null }
  | { reason: "dirty"; paths: string[] } | { reason: "diverged"; baseTip: string } | { reason: "ignored-overwrite"; paths: string[] }
  | { reason: "base-missing" };
export type LandInspection = { ok: true; baseTip: string; noop: boolean } | { ok: false; refusal: LandRefusal; baseTip: string | null };
export type LandOutcome = { kind: "landed"; from: string; to: string } | { kind: "refused"; refusal: LandRefusal } | { kind: "error"; message: string };
export type TagOutcome = CreateRefOutcome | { kind: "error"; message: string };

export type IntegrationStepEvent = Extract<ExecutorEvent, { type: "integration-step" }>;

// ---------------------------------------------------------------------------------------------------------------
// 5.2 detail schemas (M34) and 5.3 counters (M33)
// ---------------------------------------------------------------------------------------------------------------

export interface RangeDetail { taskId: TaskId; from: string; to: string }
export interface CheckDetail {
  v: 1; verdict: "pass" | "fail" | "error";
  components: Array<{ name: string; label: string; exitCode: number | null; timedOut: boolean; durationMs: number;
    scope: "spec" | "no-affected" | "full" | "rerun"; flakyIds: string[] }>;
  failingFiles: string[]; flakyIds: string[]; note: "no-checks" | null;
  error: { reason: string; message: string } | null; output: string;
}
export interface RefusedDetail { v: 1; reason: string; n?: number; message?: string }
export interface StepDetailMap {
  rebase: { v: 1; onto: string; tasks: Array<{ taskId: TaskId; tip: string; upstream: string }> }
    | { v: 1; stacked: RangeDetail[]; deferred: TaskId[] }
    | { v: 1; taskId: TaskId; paths: string[]; truncated: boolean;
      ours: Record<string, Array<{ sha: string; subject: string }>>; theirs: Record<string, Array<{ sha: string; subject: string }>> }
    | RefusedDetail;
  checks: { v: 1; base: string; candidate: string; tasks: TaskId[]; probe?: "memo" } | CheckDetail | RefusedDetail;
  "batch-checks": { v: 1; base: string; candidate: string; tasks: TaskId[]; probe?: "memo" } | CheckDetail | RefusedDetail;
  bisect: { v: 1; base: string; candidate: string; tasks: TaskId[]; probe?: "memo" } | CheckDetail
    | { v: 1; candidate: string; taskId: TaskId; probe: "to" | "from" }
    | { v: 1; verdict: "pass" | "fail"; probes: number; culprit?: RangeDetail; outside?: "from-fails" | "last-passes"; files?: string[] }
    | RefusedDetail;
  "fast-forward": { v: 1; from: string; to: string; ranges: RangeDetail[] } | { v: 1; from: string; to: string } | RefusedDetail;
  "phase-suite": { v: 1; commit: string; base: string | null; commands: Array<{ label: string; ref: RunCommandRef | null }> }
    | { v: 1; files: string[]; idsUnparsed: boolean; durationMs: number; output: string } | RefusedDetail;
  "suite-rerun": { v: 1; n: 1 | 2; files: string[] } | { v: 1; at: "base"; commit: string; files: string[] }
    | { v: 1; reproduced?: string[]; durationMs: number; output: string } | RefusedDetail;
  "revert-build": { v: 1; culprit: RangeDetail; suiteCommit: string; head: string; files: string[] }
    | { v: 1; revertHead: string; reverted: string[] } | { v: 1; at: string; paths: string[]; commands: string[] } | RefusedDetail;
  "revert-checks": { v: 1; base: string; candidate: string; extraFiles: string[] } | CheckDetail | RefusedDetail;
  "revert-fast-forward": { v: 1; from: string; to: string; culprit: RangeDetail; suiteCommit: string }
    | { v: 1; from: string; to: string } | RefusedDetail;
  rollback: { v: 1; of: IntegrationStep | null; reason: "resume" | "abort" | "stalled" } | { v: 1; reset: string | null };
  tag: { v: 1; name: string; commit: string } | { v: 1; outcome: "created" | "exists-same" | "exists-other"; at?: string } | RefusedDetail;
  land: { v: 1; mode: string; toplevel: string; baseBranch: string }
    | { v: 1; from?: string; to?: string; refusal?: LandRefusal } | RefusedDetail;
}
export type StepDetail = StepDetailMap[IntegrationStep];

export type IntegrationMetricKey =
  | "integration.entry" | "integration.step" | "integration.checks" | "integration.checks.none" | "integration.flaky"
  | "integration.batch" | "integration.bisect.probes" | "integration.suite" | "integration.revert" | "integration.preempt"
  | "integration.slot.wait" | "integration.tag" | "integration.land" | "integration.resume" | "integration.lock.takeover"
  /** A dequeued task that was no longer `verified` when its entry's first batch was built (dropped, no transition). */
  | "integration.dequeue.skipped"
  /** A repo-lock wait that outlasted LOCK_WAIT_REPORT_MS (one inbox item per wait). */
  | "integration.lock.wait";

/** M34: JSON detail capped at 16 KiB; an `output` field keeps its last 4 KiB. */
export function encodeDetail(detail: StepDetail | Record<string, unknown>): string {
  const obj: Record<string, unknown> = { ...(detail as Record<string, unknown>) };
  if (typeof obj.output === "string") obj.output = tailBytes(obj.output, OUTPUT_TAIL_BYTES);
  let text = JSON.stringify(obj);
  if (Buffer.byteLength(text, "utf8") <= DETAIL_MAX_BYTES) return text;
  if (typeof obj.output === "string") obj.output = tailBytes(obj.output, 1024);
  for (const key of ["ours", "theirs", "components", "paths", "ranges", "stacked", "tasks", "files", "extraFiles"]) {
    text = JSON.stringify(obj);
    if (Buffer.byteLength(text, "utf8") <= DETAIL_MAX_BYTES) return text;
    const value = obj[key];
    if (Array.isArray(value)) obj[key] = value.slice(0, 20);
    else if (value !== undefined && typeof value === "object") obj[key] = {};
    obj.truncated = true;
  }
  text = JSON.stringify(obj);
  if (Buffer.byteLength(text, "utf8") <= DETAIL_MAX_BYTES) return text;
  return JSON.stringify({ v: 1, truncated: true, reason: typeof obj.reason === "string" ? obj.reason : undefined });
}

export function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  return buf.subarray(buf.length - max).toString("utf8").replace(/^\uFFFD+/, "");
}

export function clipText(s: string, max: number = AX_MAX_CHARS): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

export function parseDetail(text: string | null | undefined): Record<string, unknown> | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 5.1 seams
// ---------------------------------------------------------------------------------------------------------------

export interface StepJournal {
  readonly entry: Readonly<IntegrationEntry>;
  readonly signal: AbortSignal;
  /** ISS for the open entry; rejects if a step is open. Resolves after the fsync. */
  start(step: IntegrationStep, detail: StepDetail,
    patch?: Partial<Pick<IntegrationEntry, "candidate" | "slot" | "taskIds">>): Promise<void>;
  /** Never closes; closing ends belong to the queue (M1, A2-1). Runners leave their final step open. */
  end(result: Exclude<IntegrationStepResult, "rolled-back">, detail: StepDetail, failingIds?: readonly string[]): Promise<void>;
  assertWriteCwd(cwd: string, purpose: WritePurpose): Promise<void>;
  /** Buffered; appended inside the next batch. */
  counter(key: IntegrationMetricKey, value: number, labels: Record<string, string>): void;
}
export interface PhaseSuiteRunner {
  resolve(ledger: Readonly<LedgerV1>, phaseId: PhaseId, commit: string): Promise<SuiteResolution>;
  run(req: SuiteRunRequest, j: StepJournal): Promise<SuiteVerdict>;
  revert(req: RevertRequest, j: StepJournal): Promise<RevertVerdict>;
  /** Aborts the in-flight background run if it still has preemption budget; true if aborted. */
  preemptBackground(): boolean;
}
export interface Lander {
  tagName(planId: PlanId, phaseId: PhaseId): string;
  tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome>;
  inspect(req: LandRequest): Promise<LandInspection>;
  fastForward(req: LandRequest): Promise<LandOutcome>;
  commands(req: LandRequest, refusal: LandRefusal): string[];
}
/** V2: wired by 5.1 from the 2.2 store's history read; the queue caches it and appends its own writes. */
export interface IntegrationHistory {
  steps(): Promise<readonly IntegrationStepEvent[]>;
}
export interface RepoLock {
  readonly lost: AbortSignal;
  release(): Promise<void>;
  /** Re-reads the lock file: true while it is still ours (QA-3.2-28, checked right before the CAS). Optional for doubles. */
  verify?(): Promise<boolean>;
}
/** What a long repo-lock wait is waiting for (QA-3.2-33). */
export interface LockWaitInfo {
  file: string; pid: number | null; hostname: string | null; planId: string | null; heartbeatAgeMs: number | null; waitedMs: number;
}
export interface RepoLockFactory {
  /** `onWait` is called at most once per wait, after it outlasted the factory's report delay. */
  acquire(repoKey: string, holder: { planId: PlanId; entryId: string | null }, signal: AbortSignal,
    onWait?: (info: LockWaitInfo) => void): Promise<RepoLock>;
}

// ---------------------------------------------------------------------------------------------------------------
// Event constructors (A1-2.4 Q rows)
// ---------------------------------------------------------------------------------------------------------------

type StepInput = Extract<ExecutorEventInput, { type: "integration-step" }>;

function iss(entry: IntegrationEntry, step: IntegrationStep, detail: StepDetail | Record<string, unknown>,
  failingIds: readonly string[] = []): StepInput {
  return { type: "integration-step", edge: "start", entry: { ...entry, taskIds: [...entry.taskIds] }, step, result: null,
    detail: encodeDetail(detail), failingIds: [...failingIds], closes: false };
}

function ise(entry: IntegrationEntry, step: IntegrationStep, result: IntegrationStepResult,
  detail: StepDetail | Record<string, unknown>, closes: boolean, failingIds: readonly string[] = []): StepInput {
  return { type: "integration-step", edge: "end", entry: { ...entry, taskIds: [...entry.taskIds] }, step, result,
    detail: encodeDetail(detail), failingIds: [...failingIds], closes };
}

function counterEvent(key: IntegrationMetricKey, value: number, labels: Record<string, string>): ExecutorEventInput {
  return { type: "metric", metric: { name: "counter", key, value, labels: { ...labels } } };
}

// ---------------------------------------------------------------------------------------------------------------
// Queue dependencies (memo §6)
// ---------------------------------------------------------------------------------------------------------------

export interface IntegrationQueueDeps {
  planId: PlanId; writer: LedgerWriter; history: IntegrationHistory; git: GitOps; igit: IntegrateGit;
  pool: SlotPool; leases: LeaseService; checks: IntegrationChecks; suite: PhaseSuiteRunner; lander: Lander; listener: IntegrationListener;
  settle: (taskId: TaskId, release: () => Promise<void>) => void; locks: RepoLockFactory; guard: WriteGuard; clock: Clock; logger: Logger;
}

/** The serial-lane entry in flight (at most one, M4) or the background suite entry. */
interface LiveEntry {
  entry: IntegrationEntry;
  startSeq: number;
  /** The step whose start is journaled and whose end is not, or null. */
  open: IntegrationStep | null;
  openedAt: number;
  lane: "serial" | "background";
}

/** Thrown inside a flow to stop the lane after the queue already journaled the halt (M13b) or lost the lock (M7). */
class LaneStop extends Error {
  override readonly name = "LaneStop" as const;
}

/** A git read that could not run (infrastructure), as opposed to a ref that does not exist (QA-3.2-9). */
class GitReadError extends Error {
  override readonly name = "GitReadError" as const;
  constructor(readonly ref: string, cause: unknown) {
    super(`git could not read ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function errCode(e: unknown): string | null {
  return e instanceof ExecutorError ? e.code : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rangesOf(stacked: readonly RangeDetail[]): RangeDetail[] {
  return stacked.map(r => ({ taskId: r.taskId, from: r.from, to: r.to }));
}

function checkDetail(r: CheckResult): CheckDetail {
  return {
    v: 1, verdict: r.verdict,
    components: r.components.map(c => ({ name: c.name, label: c.label, exitCode: c.exitCode, timedOut: c.timedOut,
      durationMs: c.durationMs, scope: c.scope, flakyIds: [...c.flakyIds] })),
    failingFiles: r.verdict === "fail" ? [...r.failingFiles] : [],
    flakyIds: r.verdict === "error" ? [] : [...r.flakyIds],
    note: r.verdict === "pass" ? r.note : null,
    error: r.verdict === "error" ? { reason: r.reason, message: r.message } : null,
    output: r.verdict === "fail" ? r.output : "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// M5: repo lock (I3) = in-process mutex per repo.key + cross-process lock file
// ---------------------------------------------------------------------------------------------------------------

/** In-process tails per repo key, shared by every queue (and every factory) in the process. */
const REPO_MUTEX = new Map<string, Promise<void>>();

interface LockFileContent { pid: number; hostname: string; planId: string; entryId: string | null; heartbeatAt: number; token: string | null }

function parseLockFile(text: string): LockFileContent | null {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o.pid !== "number" || typeof o.hostname !== "string" || typeof o.heartbeatAt !== "number") return null;
    return { pid: o.pid, hostname: o.hostname, planId: typeof o.planId === "string" ? o.planId : "",
      entryId: typeof o.entryId === "string" ? o.entryId : null, heartbeatAt: o.heartbeatAt,
      token: typeof o.token === "string" ? o.token : null };
  } catch {
    return null;
  }
}

function fsCode(e: unknown): unknown {
  return e !== null && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
}

/** A repo lock; `takeover` says whether acquiring it took over a dead or stale holder (counter `integration.lock.takeover`). */
export interface RepoLockWithTakeover extends RepoLock { readonly takeover: "dead-pid" | "stale" | null }

export function createRepoLockFactory(o: {
  stateRoot: string; clock: Clock; pid: number; hostname: string;
  isPidAlive: (pid: number) => boolean; heartbeatMs?: number; staleMs?: number; waitReportMs?: number;
}): RepoLockFactory {
  const heartbeatMs = o.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  const waitReportMs = o.waitReportMs ?? LOCK_WAIT_REPORT_MS;

  function lockPath(repoKey: string): string {
    const digest = createHash("sha256").update(repoKey, "utf8").digest("hex");
    return nodePath.join(o.stateRoot, "repos", digest, "integration.lock");
  }

  async function takeMutex(repoKey: string, signal: AbortSignal): Promise<() => void> {
    for (;;) {
      if (signal.aborted) throw new ExecutorError("E_DISPOSED", "repo lock wait aborted", { repoKey: repoKey.slice(0, 200) });
      const tail = REPO_MUTEX.get(repoKey);
      if (tail === undefined) {
        let free!: () => void;
        const mine = new Promise<void>(resolve => { free = resolve; });
        REPO_MUTEX.set(repoKey, mine);
        return () => {
          if (REPO_MUTEX.get(repoKey) === mine) REPO_MUTEX.delete(repoKey);
          free();
        };
      }
      await Promise.race([tail, new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))]);
    }
  }

  async function sleep(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>(resolve => {
      const onAbort = (): void => { o.clock.clearTimer(h); resolve(); };
      const h = o.clock.setTimer(ms, () => { signal.removeEventListener("abort", onAbort); resolve(); });
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  let tmpSeq = 0;
  function sideName(file: string, tag: string): string {
    tmpSeq++;
    return `${file}.${o.pid}.${tmpSeq}.${randomBytes(4).toString("hex")}.${tag}`;
  }

  /** Writes `content` to a fresh side file in full (fsync'd), so no reader ever sees a partial lock file (QA-3.2-4). */
  async function writeSide(file: string, content: LockFileContent): Promise<string> {
    const tmp = sideName(file, "tmp");
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(JSON.stringify(content), "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return tmp;
  }

  /** Creates the lock atomically and complete: a hard link of a fully written side file, which never overwrites (EEXIST). */
  async function create(file: string, content: LockFileContent): Promise<boolean> {
    const tmp = await writeSide(file, content);
    try {
      await link(tmp, file);
      return true;
    } catch (e) {
      if (fsCode(e) === "EEXIST") return false;
      throw e;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  async function readRaw(file: string): Promise<string | null> {
    try {
      return await readFile(file, "utf8");
    } catch (e) {
      if (fsCode(e) === "ENOENT") return null;
      throw e;
    }
  }

  /**
   * Compare-and-delete: removes the lock file only if it still holds `raw`. The file is renamed aside first (atomic, one
   * taker wins); a file that is not the one judged (another taker already replaced it) is linked back. True if removed.
   */
  async function removeIfSame(file: string, raw: string): Promise<boolean> {
    const tomb = sideName(file, "stale");
    try {
      await rename(file, tomb);
    } catch (e) {
      if (fsCode(e) === "ENOENT") return false;
      throw e;
    }
    let moved: string;
    try {
      moved = await readFile(tomb, "utf8");
    } catch (e) {
      // Not judgeable (not a file): put it back where it was and fail.
      await rename(tomb, file).catch(() => undefined);
      throw e;
    }
    if (moved !== raw) await link(tomb, file).catch(() => undefined);
    await unlink(tomb).catch(() => undefined);
    return moved === raw;
  }

  /**
   * Why the holder recorded in `raw` may be taken over, or null for a live holder. Same host: pid liveness only (R4);
   * our own pid while this process holds the repo mutex is a leftover. Other hosts: the heartbeat age. Unparsable counts
   * as stale; the caller takes over only when the same verdict holds for the same bytes at two polls.
   */
  function judge(raw: string): "dead-pid" | "stale" | null {
    const current = parseLockFile(raw);
    if (current === null) return "stale";
    if (current.hostname === o.hostname) return current.pid === o.pid || !o.isPidAlive(current.pid) ? "dead-pid" : null;
    return o.clock.now() - current.heartbeatAt > staleMs ? "stale" : null;
  }

  /**
   * Nit (QA-3.2 round 2): removes side files a crashed writer left next to the lock (`<lock>.<pid>.<n>.<hex>.tmp|stale`).
   * Only ours (this process holds the repo mutex, so none of ours is in flight) or a dead same-host pid's are removed.
   */
  async function cleanSides(file: string): Promise<void> {
    const dir = nodePath.dirname(file);
    const base = nodePath.basename(file) + ".";
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(base) || !(name.endsWith(".tmp") || name.endsWith(".stale"))) continue;
      const pid = Number(name.slice(base.length).split(".")[0]);
      if (!Number.isInteger(pid)) continue;
      if (pid !== o.pid && o.isPidAlive(pid)) continue;
      await unlink(nodePath.join(dir, name)).catch(() => undefined);
    }
  }

  return {
    async acquire(repoKey, holder, signal, onWait) {
      const freeMutex = await takeMutex(repoKey, signal);
      const file = lockPath(repoKey);
      const token = randomBytes(8).toString("hex");
      let takeover: "dead-pid" | "stale" | null = null;
      const startedAt = o.clock.now();
      let reported = false;
      try {
        await mkdir(nodePath.dirname(file), { recursive: true });
        await cleanSides(file);
        let suspect: { raw: string; reason: "dead-pid" | "stale" } | null = null;
        /** Set by a successful compare-and-delete; counted only if our very next create wins (nit: takeover counter). */
        let removed: "dead-pid" | "stale" | null = null;
        for (;;) {
          if (signal.aborted) throw new ExecutorError("E_DISPOSED", "repo lock wait aborted", { repoKey: repoKey.slice(0, 200) });
          const content: LockFileContent = { pid: o.pid, hostname: o.hostname, planId: holder.planId, entryId: holder.entryId,
            heartbeatAt: o.clock.now(), token };
          if (await create(file, content)) {
            takeover = removed;
            break;
          }
          removed = null;
          const raw = await readRaw(file);
          if (raw === null) {
            suspect = null;
            continue;
          }
          const reason = judge(raw);
          if (reason !== null && suspect !== null && suspect.raw === raw && suspect.reason === reason) {
            suspect = null;
            if (await removeIfSame(file, raw)) removed = reason;
            continue;
          }
          suspect = reason === null ? null : { raw, reason };
          // QA-3.2-33: one report per wait once it outlasted waitReportMs (the holder, its heartbeat age, the file).
          if (!reported && onWait !== undefined && o.clock.now() - startedAt >= waitReportMs) {
            reported = true;
            const cur = parseLockFile(raw);
            try {
              onWait({ file, pid: cur?.pid ?? null, hostname: cur?.hostname ?? null, planId: cur?.planId ?? null,
                heartbeatAgeMs: cur === null ? null : o.clock.now() - cur.heartbeatAt, waitedMs: o.clock.now() - startedAt });
            } catch {
              // A reporting failure never breaks the wait.
            }
          }
          await sleep(Math.min(heartbeatMs, 1000), signal);
        }
      } catch (e) {
        freeMutex();
        throw e;
      }
      const lost = new AbortController();
      let released = false;
      /** QA-3.2-27: the beat in flight; release() waits for it before its compare-and-delete. */
      let beating: Promise<void> | null = null;
      const ours = (raw: string | null): boolean => {
        const current = raw === null ? null : parseLockFile(raw);
        return current !== null && current.pid === o.pid && current.hostname === o.hostname && current.token === token;
      };
      const beatOnce = async (): Promise<void> => {
        if (released || lost.signal.aborted) return;
        try {
          const raw = await readRaw(file);
          if (released) return;
          const current = raw === null ? null : parseLockFile(raw);
          if (current === null || !ours(raw)) {
            lost.abort();
            return;
          }
          // A full side file renamed over the lock: the lock file is never empty or partial (QA-3.2-4).
          const tmp = await writeSide(file, { ...current, heartbeatAt: o.clock.now() });
          if (released) {
            await unlink(tmp).catch(() => undefined);
            return;
          }
          try {
            await rename(tmp, file);
          } catch (e) {
            await unlink(tmp).catch(() => undefined);
            throw e;
          }
        } catch {
          // A transient read or rename failure is retried at the next beat; only a missing or foreign lock file is a loss.
        }
        if (!released && !lost.signal.aborted) timer = o.clock.setTimer(heartbeatMs, beat);
      };
      const beat = (): void => {
        const p = beatOnce();
        beating = p;
        void p.finally(() => { if (beating === p) beating = null; });
      };
      let timer = o.clock.setTimer(heartbeatMs, beat);
      const lock: RepoLockWithTakeover = {
        lost: lost.signal,
        takeover,
        async verify() {
          if (released || lost.signal.aborted) return false;
          try {
            if (ours(await readRaw(file))) return true;
          } catch {
            return true; // unreadable now: not proof of a loss; the heartbeat decides
          }
          lost.abort();
          return false;
        },
        async release() {
          if (released) return;
          released = true;
          o.clock.clearTimer(timer);
          try {
            if (beating !== null) await beating;
            const raw = await readRaw(file);
            if (raw !== null && ours(raw)) await removeIfSame(file, raw);
          } catch {
            // Already gone or replaced by a takeover: nothing of ours to remove.
          } finally {
            freeMutex();
          }
        },
      };
      return lock;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------------------------

type CheckStep = "checks" | "batch-checks" | "bisect" | "revert-checks";
type Pre = (l: Readonly<LedgerV1>) => ExecutorEventInput[];
const NONE: Pre = () => [];

interface PendingRevert { phaseId: PhaseId; culprit: TaskRange; suiteCommit: string; ids: string[]; files: string[]; commands: ResolvedCommand[]; rerun: LiveEntry | null }
interface StackResult { stacked: RangeDetail[]; deferred: TaskId[] }

export function createIntegrationQueue(d: IntegrationQueueDeps): IntegrationQueue {
  return new Queue(d);
}

class Queue implements IntegrationQueue {
  private readonly d: IntegrationQueueDeps;
  private readonly fifo: TaskId[] = [];
  /** Resume reruns (M4 pick #1): requeued task entries' task ids, oldest `startSeq` first. */
  private readonly requeued: Array<{ taskIds: TaskId[]; phaseId: PhaseId | null; startSeq: number }> = [];
  private readonly reverts: PendingRevert[] = [];
  private readonly tags: PhaseId[] = [];
  /** Background lane FIFO by phase (M4): `start` from pending, `rerun` from suite-failed, `none` = ISS only (A2-1). */
  private readonly suites: Array<{ phaseId: PhaseId; gate: "start" | "rerun" | "none" }> = [];
  private steps: IntegrationStepEvent[] | null = null;
  private counters: ExecutorEventInput[] = [];
  private serial: LiveEntry | null = null;
  private background: LiveEntry | null = null;
  /** M36 stalled entries, at most one per lane (QA-3.2-5). */
  private readonly stalled = new Map<LiveEntry["lane"], LiveEntry>();
  /** Queued work that waits behind an infrastructure pause with no entry open (QA-3.2-9): the poll kicks it. */
  private pausedWork = false;
  /** QA-3.2-28: latched at the first lost-lock halt; every later git write stops until a lock is taken again. */
  private lockLost = false;
  /** QA-3.2-30: retries so far of a completed plan's tag entry, per phase. */
  private readonly tagRetries = new Map<PhaseId, number>();
  private stalledTimer: { readonly id: number } | null = null;
  private lock: RepoLock | null = null;
  private integrationLease: SlotLease | null = null;
  /** I1: commits whose checks passed in a slot during the current serial entry. */
  private passed = new Set<string>();
  /** M18: verdicts by candidate sha within the current serial entry. */
  private verdicts = new Map<string, "pass" | "fail">();
  private resumed = false;
  private resuming: Promise<ResumeReport> | null = null;
  private serialRunning = false;
  private backgroundRunning = false;
  private stopped = false;
  private disposed = false;
  private aborting = false;
  private readonly ctl = new AbortController();
  private readonly bgCtl = new AbortController();
  /** Aborted only by dispose(): ends a wait for the repo lock. */
  private readonly lockCtl = new AbortController();

  constructor(d: IntegrationQueueDeps) {
    this.d = d;
  }

  private get ledger(): Readonly<LedgerV1> {
    return this.d.writer.ledger;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Journal core (M1, M7, I4)
  // -------------------------------------------------------------------------------------------------------------

  /** The first history load is cached as a promise, so concurrent first callers share one read (and one array). */
  private async loadSteps(): Promise<IntegrationStepEvent[]> {
    if (this.stepsP === null) {
      this.stepsP = this.d.history.steps().then(s => {
        this.steps = [...s];
        return this.steps;
      });
      this.stepsP.catch(() => { this.stepsP = null; });
    }
    return this.stepsP;
  }

  private stepsP: Promise<IntegrationStepEvent[]> | null = null;

  private assertLive(): void {
    if (this.disposed) throw new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId });
    if (this.stopped) throw new LaneStop("integration lanes stopped after a rejected append");
  }

  /** Appends one batch; the buffered counters ride along. A rejected append stops both lanes (M7). */
  private async append(build: Pre): Promise<Readonly<LedgerV1>> {
    this.assertLive();
    await this.loadSteps();
    const counters = this.counters.splice(0);
    let built: ExecutorEventInput[] = [];
    let base = 0;
    try {
      const next = await this.d.writer.append(l => {
        base = l.seq;
        built = [...build(l), ...counters];
        return built;
      });
      this.record(built, base);
      return next;
    } catch (e) {
      await this.onAppendError(e);
      throw e;
    }
  }

  private record(built: readonly ExecutorEventInput[], base: number): void {
    const steps = this.steps;
    if (steps === null || built.length === 0) return;
    const at = this.d.clock.iso();
    built.forEach((ev, i) => {
      if (ev.type !== "integration-step") return;
      steps.push({ ...ev, seq: base + 1 + i, at, batch: base + 1, last: i === built.length - 1 });
    });
  }

  private async onAppendError(e: unknown): Promise<void> {
    this.stopped = true;
    const code = errCode(e);
    // A lost ledger lock disposes the queue (the runners report `dispose`); any other rejection only stops the lanes.
    this.bgCtl.abort(code === "E_LOCK_LOST" ? "dispose" : "stopped");
    if (code === "E_LOCK_LOST") {
      // Outcome unknown (2.2 handoff): no further git or listener call; the next writer's resume() reconciles.
      this.disposed = true;
      this.ctl.abort("dispose");
      // dispose() returns early once `disposed` is set, so the repo lock (and its heartbeat) would otherwise never be released.
      await this.releaseLock();
      return;
    }
    if (code === "E_ILLEGAL_TRANSITION") {
      this.d.logger.warn(`integration queue: illegal transition rejected by the ledger writer: ${message(e)}`);
      try {
        const now = this.d.clock.iso();
        await this.d.writer.append(l => [
          ...this.pauseEvents(l, "integration-bug"),
          this.inboxEvent(l, "failure", "critical", null,
            `Integration queue bug: a journal batch was rejected (${clipText(message(e), 500)}). The plan is paused and this queue has stopped: restart the executor (the new queue's resume() reconciles), then unpause.`, now),
        ]);
      } catch (inner) {
        this.d.logger.warn(`integration queue: could not pause after an illegal transition: ${message(inner)}`);
      }
    }
    // QA-3.2-34: a stopped queue makes no further git write: it must not keep the repo lock (nor the process's repo mutex)
    // or its 5 s poll until dispose(). resume() and abort() release the lock in their own `finally`.
    this.pausedWork = false;
    this.clearStalled();
    if (!this.holdLock) await this.releaseLock();
  }

  private pauseEvents(l: Readonly<LedgerV1>, reason: string): ExecutorEventInput[] {
    return l.status === "running" ? [{ type: "status-changed", from: "running", to: "paused", reason }] : [];
  }

  private inboxEvent(l: Readonly<LedgerV1>, kind: InboxKind, severity: InboxItem["severity"], taskId: TaskId | null,
    text: string, createdAt: IsoTime): ExecutorEventInput {
    const item: InboxItem = { id: formatInboxId(kind, nextInboxNumber(l)), kind, severity, taskId, text: clipText(text),
      options: [], answer: null, createdAt };
    return { type: "inbox-added", item };
  }

  private newInbox(next: Readonly<LedgerV1>, before: number): InboxItem[] {
    return next.inbox.slice(before);
  }

  private notifyInbox(items: readonly InboxItem[]): void {
    if (this.disposed) return;
    for (const item of items) this.safe(() => this.d.listener.onInbox(item));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.d.logger.warn(`integration queue: listener threw: ${message(e)}`);
    }
  }

  /** Opens an entry: `pre` events, then its first ISS, in one batch (M1 id rule). */
  private async openEntry(lane: LiveEntry["lane"], init: Omit<IntegrationEntry, "id">, step: IntegrationStep,
    detail: StepDetail, pre: Pre = NONE, failingIds: readonly string[] = []): Promise<LiveEntry> {
    let entry: IntegrationEntry | null = null;
    let startSeq = 0;
    await this.append(l => {
      const events = pre(l);
      startSeq = l.seq + 1 + events.length;
      entry = { ...init, id: entryIdAt(l, events.length), taskIds: [...init.taskIds] };
      return [...events, iss(entry, step, detail, failingIds)];
    });
    if (entry === null) throw new ExecutorError("E_INVALID_INPUT", "entry builder did not run", null);
    const live: LiveEntry = { entry, startSeq, open: step, openedAt: this.d.clock.now(), lane };
    if (lane === "serial") this.serial = live;
    else this.background = live;
    return live;
  }

  /** ISS for an open entry; a step must not be open (entry rules, phase-1.4.md:960). */
  private async start(live: LiveEntry, step: IntegrationStep, detail: StepDetail,
    patch?: Partial<Pick<IntegrationEntry, "candidate" | "slot" | "taskIds">>, failingIds: readonly string[] = [], pre: Pre = NONE): Promise<void> {
    if (live.open !== null) throw new ExecutorError("E_INVALID_INPUT", "a step is already open", { entry: live.entry.id, step: live.open });
    const entry: IntegrationEntry = { ...live.entry, ...(patch ?? {}) };
    await this.append(l => [...pre(l), iss(entry, step, detail, failingIds)]);
    live.entry = entry;
    live.open = step;
    live.openedAt = this.d.clock.now();
  }

  /** ISE of the open step plus the row's other events; `closes` finishes the entry. Returns the new ledger. */
  private async end(live: LiveEntry, result: IntegrationStepResult, detail: StepDetail, closes: boolean,
    failingIds: readonly string[] = [], post: Pre = NONE): Promise<Readonly<LedgerV1>> {
    const step = live.open;
    if (step === null) throw new ExecutorError("E_INVALID_INPUT", "no step is open", { entry: live.entry.id });
    const ms = this.d.clock.now() - live.openedAt;
    const entry = live.entry;
    const extra: ExecutorEventInput[] = [counterEvent("integration.step", ms, { step, result })];
    if (closes) extra.push(counterEvent("integration.entry", 1, { kind: entry.kind, outcome: result }));
    const next = await this.append(l => [ise(entry, step, result, detail, closes, failingIds), ...post(l), ...extra]);
    live.open = null;
    if (closes) await this.closed(live);
    return next;
  }

  private async closed(live: LiveEntry): Promise<void> {
    if (this.serial === live) {
      this.serial = null;
      this.passed = new Set();
      this.verdicts = new Map();
      this.lastFail = new Map();
      if (!this.holdLock) await this.releaseLock();
    }
    if (this.background === live) this.background = null;
    this.clearStalled(live);
  }

  private async releaseLock(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock !== null) {
      try {
        await lock.release();
      } catch (e) {
        this.d.logger.warn(`integration queue: repo lock release failed: ${message(e)}`);
      }
    }
  }

  /**
   * Takes the repo lock (M5). abort() aborts `ctl` first and must still take the lock for its rollback batches, so only a
   * lane's wait for a new entry (`cancellable`) also ends on `ctl` (QA-3.2-3); dispose() (`lockCtl`) ends every wait.
   */
  private async takeLock(entryId: string | null, cancellable = false): Promise<void> {
    if (this.lock !== null) return;
    let signal = this.lockCtl.signal;
    const cleanup: Array<() => void> = [];
    if (cancellable) {
      const both = new AbortController();
      const stop = (): void => both.abort();
      for (const s of [this.ctl.signal, this.lockCtl.signal]) {
        if (s.aborted) both.abort();
        s.addEventListener("abort", stop, { once: true });
        cleanup.push(() => s.removeEventListener("abort", stop));
      }
      signal = both.signal;
    }
    let lock: RepoLock;
    try {
      lock = await this.d.locks.acquire(this.ledger.repo.key, { planId: this.d.planId, entryId }, signal,
        info => { void this.lockWaitItem(info); });
    } catch (e) {
      if (errCode(e) === "E_DISPOSED" || signal.aborted) throw e;
      // A plan that is not running (land() of a completed plan, resume() of a paused one) has no pause to take and no
      // poll to retry: the error goes to the caller (land() rejects; the runtime logs it), as before.
      if (this.ledger.status !== "running") throw e;
      // QA-3.2-33: a running lane's lock that cannot be taken (filesystem error) is an infrastructure pause with an item,
      // never a silent lane stop. Work stays queued; the poll retries once the plan runs again.
      await this.infraPauseQueued(`The repository lock for ${this.ledger.repo.key} could not be taken (${clipText(message(e), 500)}).`);
      throw new LaneStop(`repo lock unavailable: ${clipText(message(e), 300)}`);
    } finally {
      for (const c of cleanup) c();
    }
    this.lock = lock;
    this.lockLost = false;
    const takeover = (lock as Partial<RepoLockWithTakeover>).takeover;
    if (takeover === "dead-pid" || takeover === "stale") {
      this.counters.push(counterEvent("integration.lock.takeover", 1, { reason: takeover }));
    }
  }

  /** QA-3.2-33: one inbox item for a repo-lock wait that outlasted the factory's report delay. */
  private async lockWaitItem(info: LockWaitInfo): Promise<void> {
    if (this.disposed || this.stopped) return;
    const holder = info.pid === null ? "an unreadable lock file" : `pid ${info.pid} on ${info.hostname ?? "?"} (plan ${info.planId ?? "?"})`;
    const age = info.heartbeatAgeMs === null ? "unknown" : `${Math.round(info.heartbeatAgeMs / 1000)} s`;
    const now = this.d.clock.iso();
    try {
      const before = this.ledger.inbox.length;
      const next = await this.append(l => [this.inboxEvent(l, "failure", "blocking", null,
        `Integration has waited ${Math.round(info.waitedMs / 60_000)} min for the repository lock ${info.file}, held by ${holder}; last heartbeat ${age} ago. If that process is gone or stuck, stop it or remove the lock file.`, now),
        counterEvent("integration.lock.wait", info.waitedMs, {})]);
      this.notifyInbox(this.newInbox(next, before));
    } catch (e) {
      this.laneError(e);
    }
  }

  /** A StepJournal over a live entry, for the suite and revert runners (they never close). */
  private journal(live: LiveEntry, signal: AbortSignal): StepJournal {
    return {
      get entry() { return live.entry; },
      signal,
      start: async (step, detail, patch) => {
        if (live.open !== null) throw new ExecutorError("E_INVALID_INPUT", "a step is already open", { entry: live.entry.id, step: live.open });
        await this.start(live, step, detail, patch);
      },
      // Never closes: closing ends belong to the queue (M1, A2-1).
      end: async (result, detail, failingIds) => {
        await this.end(live, result, detail, false, failingIds ?? []);
      },
      assertWriteCwd: async (cwd, purpose) => {
        this.assertLive();
        await this.guardWrite(live, cwd, purpose);
      },
      counter: (key, value, labels) => {
        this.counters.push(counterEvent(key, value, labels));
      },
    };
  }

  /** M13 halt: [ISE(open step, refused) if a step is open, status-changed (only if running), IA critical]. The lane stops. */
  private async halt(live: LiveEntry | null, reason: string, text: string): Promise<never> {
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const post: Pre = l => [...this.pauseEvents(l, reason), this.inboxEvent(l, "failure", "critical", null, text, now)];
    let next: Readonly<LedgerV1>;
    if (live !== null && live.open !== null) next = await this.end(live, "refused", { v: 1, reason }, false, [], post);
    else next = await this.append(post);
    this.notifyInbox(this.newInbox(next, before));
    if (live !== null) this.markStalled(live);
    await this.releaseForPause(live);
    throw new LaneStop(reason);
  }

  /**
   * QA-3.2-3: a paused serial entry does not keep the repo lock (other plans on the same repository would deadlock);
   * the stalled poll or resume() takes it again before the rollback. resume() and abort() release it themselves.
   */
  private async releaseForPause(live: LiveEntry | null): Promise<void> {
    if (this.holdLock || (live !== null && live.lane !== "serial")) return;
    await this.releaseLock();
  }

  /** QA-3.2-4: a lost repo lock means another holder may write; no git write starts after it fired (halt instead). */
  private async assertLock(live: LiveEntry | null, verify = false): Promise<void> {
    // QA-3.2-28: once lost, every later write stops too (resume and abort loops included) until a lock is taken again.
    if (this.lockLost) throw new LaneStop("integration-lock-lost");
    const lock = this.lock;
    if (lock === null) return;
    // Right before the CAS the file itself is re-read (token compare): `lost` is only as fresh as the last heartbeat.
    const gone = lock.lost.aborted || (verify && lock.verify !== undefined && !(await lock.verify()));
    if (!gone) return;
    this.lockLost = true;
    this.lock = null;
    await lock.release().catch(() => undefined);
    await this.halt(live, "integration-lock-lost",
      `The repository lock for ${this.ledger.repo.key} was lost (taken over or removed) while integration entry ${live?.entry.id ?? "(none)"} was running; no further git write was made. The plan is paused; unpause to roll the entry back and retry.`);
  }

  /** Every queue-side git write: the lock check (QA-3.2-4), then the write-cwd guard (M30, I5). */
  private async guardWrite(live: LiveEntry | null, cwd: string, purpose: WritePurpose): Promise<void> {
    if (live === null || live.lane === "serial") await this.assertLock(live);
    await this.d.guard.assertWriteCwd(cwd, purpose);
  }

  // -------------------------------------------------------------------------------------------------------------
  // M36 stalled entries (one per lane, QA-3.2-5)
  // -------------------------------------------------------------------------------------------------------------

  private markStalled(live: LiveEntry): void {
    this.stalled.set(live.lane, live);
    this.ensurePoll();
  }

  /** The 5 s status poll runs while a stalled entry exists or queued work waits behind an infrastructure pause. */
  private ensurePoll(): void {
    if (this.stalledTimer !== null || this.disposed) return;
    const tick = (): void => {
      this.stalledTimer = null;
      if ((this.stalled.size === 0 && !this.pausedWork) || this.disposed) return;
      void this.pokeStalled();
      if ((this.stalled.size > 0 || this.pausedWork) && !this.disposed) this.stalledTimer = this.d.clock.setTimer(STALLED_POLL_MS, tick);
    };
    this.stalledTimer = this.d.clock.setTimer(STALLED_POLL_MS, tick);
  }

  private clearStalled(live?: LiveEntry): void {
    if (live === undefined) this.stalled.clear();
    else if (this.stalled.get(live.lane) === live) this.stalled.delete(live.lane);
    if (this.stalled.size > 0 || (this.pausedWork && !this.disposed)) return;
    if (this.stalledTimer !== null) this.d.clock.clearTimer(this.stalledTimer);
    this.stalledTimer = null;
  }

  /**
   * M36: once status is running again, the in-process rollback (`reason:"stalled"`) of every stalled entry (each lane's,
   * oldest first), then requeue or rerun as resume() would.
   */
  private async pokeStalled(): Promise<void> {
    if (this.disposed || this.stopped || this.aborting) {
      // QA-3.2-34: a stopped or aborting queue never rolls back in process; its 5 s poll must not re-arm forever.
      this.pausedWork = false;
      if (this.stalledTimer !== null) this.d.clock.clearTimer(this.stalledTimer);
      this.stalledTimer = null;
      return;
    }
    if (this.ledger.status !== "running") return;
    const wake = this.pausedWork;
    this.pausedWork = false;
    if (this.stalled.size === 0) {
      // Nothing stalled: kick only for work an infrastructure pause left queued (the poll's own wake-up). enqueue() and
      // checkPhase() kick by themselves; a second kick from here would set both lanes' `wanted` flags at once.
      if (wake) {
        this.clearStalled();
        this.kick();
      }
      return;
    }
    const lives = [...this.stalled.values()].sort((a, b) => a.startSeq - b.startSeq);
    this.clearStalled();
    const phases = new Set<PhaseId>();
    try {
      await this.withSerial(async () => {
        for (const live of lives) {
          if (live.lane === "serial") await this.takeLock(live.entry.id);
          const rolled = await this.rollbackEntry(this.toOpen(live), "stalled");
          await this.followUp(rolled, null, phases);
        }
      });
      for (const p of phases) await this.checkPhaseSafe(p);
    } catch (e) {
      this.laneError(e);
      // QA-3.2-29: an entry whose rollback failed is still open in the ledger: keep it stalled for the next poll.
      if (!this.disposed && !this.stopped) {
        const open = new Set(this.d.writer.openIntegration().map(o => o.entry.id));
        for (const live of lives) if (open.has(live.entry.id) && !this.stalled.has(live.lane)) this.markStalled(live);
      }
      if (this.serial !== null && this.stalled.get("serial") === this.serial && !this.holdLock) await this.releaseLock();
    }
    this.kick();
  }

  private toOpen(live: LiveEntry): OpenIntegrationEntry {
    return { entry: live.entry, startSeq: live.startSeq, step: live.open ?? "rollback", edge: live.open === null ? "end" : "start",
      result: null };
  }

  private laneError(e: unknown): void {
    if (e instanceof LaneStop) return;
    if (errCode(e) === "E_DISPOSED" || errCode(e) === "E_LOCK_LOST") return;
    this.d.logger.warn(`integration queue: lane error: ${message(e)}`);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Small reads and event helpers
  // -------------------------------------------------------------------------------------------------------------

  private async slotLease(slot: string, owner: string): Promise<SlotLease> {
    const rec = await this.d.pool.get(slot);
    if (rec === null) throw new ExecutorError("E_SLOT_BROKEN", "slot not found", { slot });
    return { slot, path: rec.path, planId: this.d.planId, owner: rec.owner ?? owner, commit: rec.commit ?? "" };
  }

  private async integrationSlot(): Promise<SlotLease> {
    if (this.integrationLease === null) this.integrationLease = await this.d.pool.acquireSpecial(this.d.planId, "integration");
    return this.integrationLease;
  }

  /**
   * `refs/heads/<integration.branch>` read in `repo.toplevel` (the common repository, not the integration worktree,
   * which may be missing or broken; QA-3.2-9). Null if the ref does not exist; a git failure throws `GitReadError`.
   */
  private async branchTip(): Promise<string | null> {
    const l = this.ledger;
    return this.readRefOrThrow(`refs/heads/${l.integration.branch}`);
  }

  private async readRefOrThrow(ref: string): Promise<string | null> {
    try {
      return await this.d.igit.readRef(this.ledger.repo.toplevel, ref);
    } catch (e) {
      throw new GitReadError(ref, e);
    }
  }

  /** Reads a ref with up to CHECK_TRIES attempts; "infra" when git never ran (M13a), else the ref (null = missing). */
  private async readRefRetry(ref: string): Promise<{ kind: "ok"; at: string | null } | { kind: "infra"; message: string }> {
    let last = "";
    for (let n = 0; n < CHECK_TRIES; n++) {
      try {
        return { kind: "ok", at: await this.readRefOrThrow(ref) };
      } catch (e) {
        last = message(e);
      }
    }
    return { kind: "infra", message: last };
  }

  private async taskTip(id: TaskId): Promise<string> {
    const l = this.ledger;
    const branch = l.tasks[id]?.branch ?? null;
    if (branch === null) throw new ExecutorError("E_INVALID_INPUT", "task has no branch", { taskId: id });
    const tip = await this.readRefOrThrow(`refs/heads/${branch}`);
    if (tip === null) throw new ExecutorError("E_GIT", `task branch refs/heads/${branch} does not exist`, { taskId: id, branch });
    return tip;
  }

  private tt(l: Readonly<LedgerV1>, id: TaskId, to: TaskState, trigger: TransitionTrigger, detail: string | null = null): ExecutorEventInput[] {
    const t = l.tasks[id];
    if (t === undefined || !TASK_TRANSITIONS[t.state].includes(to)) return [];
    return [{ type: "task-transition", taskId: id, from: t.state, to, trigger, detail }];
  }

  private ax(l: Readonly<LedgerV1>, id: TaskId, text: string): ExecutorEventInput[] {
    const t = l.tasks[id];
    const last = t?.attempts[t.attempts.length - 1];
    if (last === undefined) return [];
    return [{ type: "attempt-context", taskId: id, n: last.n, context: clipText(text) }];
  }

  /** True when no task of the entry other than `decided` is still `integrating` (row 30 `closes`, M19). */
  private closesWith(l: Readonly<LedgerV1>, live: LiveEntry, decided: readonly TaskId[]): boolean {
    return !live.entry.taskIds.some(id => !decided.includes(id) && l.tasks[id]?.state === "integrating");
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.2 Task or batch entry
  // -------------------------------------------------------------------------------------------------------------

  /** Plan rows for a stack: tip and upstream (M14) per task, read before the journal. */
  private async stackPlan(ids: readonly TaskId[], head: string): Promise<Array<{ taskId: TaskId; tip: string; upstream: string }>> {
    const top = this.ledger.repo.toplevel;
    const out: Array<{ taskId: TaskId; tip: string; upstream: string }> = [];
    for (const id of ids) {
      const tip = await this.taskTip(id);
      let upstream: string;
      try {
        upstream = await this.d.igit.mergeBase(top, head, tip);
      } catch (e) {
        // Nit (QA-3.2 round 2): `git merge-base` exit 1 = no common ancestor: the task's branch is unrelated (owner repair,
        // a blocking item), not an infrastructure failure.
        const detail = e instanceof ExecutorError ? e.detail : null;
        if (detail !== null && typeof detail === "object" && !Array.isArray(detail) && detail.code === 1) {
          throw new ExecutorError("E_GIT", `task branch tip ${tip} has no common ancestor with the integration head ${head}`, { taskId: id });
        }
        throw new GitReadError(`merge-base ${head} ${tip}`, e);
      }
      try {
        upstream = await this.reintegrationUpstream(id, tip, upstream);
      } catch (e) {
        throw new GitReadError(`ancestry of ${tip}`, e);
      }
      out.push({ taskId: id, tip, upstream });
    }
    return out;
  }

  /**
   * QA-3.2-10 / QA-3.2-25: the rebase upstream of a task that was reverted. A retry built on the old task branch whose
   * original change lies below the merge base (fast-forwarded as is, then reverted) would replay only its fixes. Unless the
   * tip already contains the latest revert (a retry rebuilt on the head keeps the merge base), the upstream is the one
   * journaled in the task's first rebase step (its original base, ancestor of the tip), else the `from` of the OLDEST revert
   * whose `to` is below the merge base. Any number of reverts keeps the original change.
   */
  private async reintegrationUpstream(id: TaskId, tip: string, mergeBase: string): Promise<string> {
    const reverts = await this.revertedRanges(id);
    const latest = reverts[reverts.length - 1];
    if (latest === undefined) return mergeBase;
    const top = this.ledger.repo.toplevel;
    if (latest.revertHead !== null && await this.d.igit.isAncestor(top, latest.revertHead, tip)) return mergeBase;
    const first = await this.firstUpstream(id);
    if (first !== null && first !== mergeBase && await this.d.igit.isAncestor(top, first, tip)) return first;
    for (const rv of reverts) {
      if (rv.to !== rv.from && await this.d.igit.isAncestor(top, rv.to, mergeBase)) return rv.from;
    }
    return mergeBase;
  }

  /** Every revert of `id` that reached the branch (closing `revert-fast-forward` ok), oldest first, from history. */
  private async revertedRanges(id: TaskId): Promise<Array<{ from: string; to: string; revertHead: string | null }>> {
    const steps = await this.loadSteps();
    const out: Array<{ from: string; to: string; revertHead: string | null }> = [];
    for (let i = 0; i < steps.length; i++) {
      const ev = steps[i];
      if (ev === undefined || ev.entry.kind !== "revert" || ev.step !== "revert-fast-forward" || !ev.closes || ev.result !== "ok") continue;
      if (ev.entry.taskIds[0] !== id) continue;
      let start: Record<string, unknown> | null = null;
      for (let k = i; k >= 0 && start === null; k--) {
        const s = steps[k];
        if (s !== undefined && s.entry.id === ev.entry.id && s.edge === "start" && s.step === "revert-fast-forward") start = parseDetail(s.detail);
      }
      const c = start?.culprit as Partial<RangeDetail> | undefined;
      if (c === undefined || c.taskId !== id || typeof c.from !== "string" || typeof c.to !== "string") continue;
      out.push({ from: c.from, to: c.to, revertHead: ev.entry.candidate });
    }
    return out;
  }

  /** The `upstream` journaled for `id` in the first rebase step that planned it (its original base), or null. */
  private async firstUpstream(id: TaskId): Promise<string | null> {
    for (const ev of await this.loadSteps()) {
      if (ev.step !== "rebase" || ev.edge !== "start" || (ev.entry.kind !== "task" && ev.entry.kind !== "batch")) continue;
      const tasks = parseDetail(ev.detail)?.tasks;
      if (!Array.isArray(tasks)) continue;
      for (const t of tasks as unknown[]) {
        const x = t as { taskId?: unknown; upstream?: unknown } | null;
        if (x !== null && typeof x === "object" && x.taskId === id && typeof x.upstream === "string") return x.upstream;
      }
    }
    return null;
  }

  private async runTaskEntry(ids: TaskId[], requeue: boolean): Promise<void> {
    const l0 = this.ledger;
    const head = l0.integration.head;
    const lastId = ids[ids.length - 1];
    const slot = lastId === undefined ? null : l0.tasks[lastId]?.slot ?? null;
    let plan: Array<{ taskId: TaskId; tip: string; upstream: string }> | null = null;
    let infra: string | null = null;
    for (let n = 1; plan === null && n <= CHECK_TRIES; n++) {
      try {
        if (slot === null) throw new ExecutorError("E_INVALID_INPUT", "task has no slot", { taskId: lastId ?? null });
        plan = await this.stackPlan(ids, head);
      } catch (e) {
        if (e instanceof GitReadError) {
          // QA-3.2-9: git could not run (infrastructure), not a missing branch: retry, then pause with the tasks kept queued.
          infra = e.message;
          continue;
        }
        // A missing branch or slot: nothing is journaled yet; the tasks cannot be dequeued until the owner repairs them.
        for (const id of ids) this.dropQueued(id);
        const now = this.d.clock.iso();
        const before = this.ledger.inbox.length;
        const next = await this.append(l => [this.inboxEvent(l, "failure", "blocking", ids[0] ?? null,
          `Integration could not read task ${ids.join(", ")}: ${message(e)}`, now)]);
        this.notifyInbox(this.newInbox(next, before));
        return;
      }
    }
    if (plan === null) {
      if (requeue) this.requeued.unshift({ taskIds: [...ids], phaseId: l0.tasks[ids[0] ?? ""]?.phase ?? null, startSeq: 0 });
      await this.infraPauseQueued(`Integration of ${ids.join(", ")} could not read its branches ${CHECK_TRIES} times (${clipText(infra ?? "", 500)}).`);
      return;
    }
    try {
      await this.takeLock(null, true);
    } catch (e) {
      // The requeued group was taken off the list by pickSerial: put it back for the next pass.
      if (requeue) this.requeued.unshift({ taskIds: [...ids], phaseId: l0.tasks[ids[0] ?? ""]?.phase ?? null, startSeq: 0 });
      throw e;
    }
    // QA-3.2-32: a task cancelled (or otherwise moved on) while this lane read its branches or waited for the repo lock is
    // dropped here, before any journal line; the rest is integrated.
    const l1 = this.ledger;
    const want: TaskState = requeue ? "integrating" : "verified";
    const keep = ids.filter(id => l1.tasks[id]?.state === want);
    const dropped = ids.filter(id => !keep.includes(id));
    for (const id of ids) this.dropQueued(id);
    if (dropped.length > 0) {
      this.d.logger.warn(`integration queue: ${dropped.join(", ")} no longer ${want} after the repo-lock wait; dropped without an entry`);
      this.counters.push(counterEvent("integration.dequeue.skipped", dropped.length, { reason: "state-changed" }));
    }
    const keptLast = keep[keep.length - 1];
    const keptSlot = keptLast === undefined ? null : l1.tasks[keptLast]?.slot ?? null;
    if (keptLast === undefined || keptSlot === null) {
      if (this.serial === null && !this.holdLock) await this.releaseLock();
      return;
    }
    const keptPlan = plan.filter(p => keep.includes(p.taskId));
    const phaseId = l1.tasks[keep[0] ?? ""]?.phase ?? null;
    const live = await this.openEntry("serial",
      { kind: keep.length > 1 ? "batch" : "task", phaseId, taskIds: keep, slot: keptSlot, baseHead: head, candidate: null },
      "rebase", { v: 1, onto: head, tasks: keptPlan },
      // Row 28: verified->integrating per task, then ISS(rebase); requeued tasks are already integrating (ISS only).
      l => {
        if (requeue) return [];
        const out: ExecutorEventInput[] = [];
        for (const id of keep) {
          if (l.tasks[id]?.state === "verified") {
            out.push(...this.tt(l, id, "integrating", "dequeued"));
            continue;
          }
          // Nit (QA-3.2): never drop a row-28 transition silently; the ledger then judges the entry.
          this.d.logger.warn(`integration queue: ${id} is ${l.tasks[id]?.state ?? "unknown"}, not verified, at dequeue; no verified->integrating transition`);
          out.push(counterEvent("integration.dequeue.skipped", 1, { reason: "not-verified-at-batch" }));
        }
        return out;
      });
    await this.integrateStack(live, keep, keptPlan);
  }

  /** M13a with no entry open: [status-changed running->paused "integration-infrastructure", IA critical]; work stays queued. */
  private async infraPauseQueued(text: string): Promise<void> {
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const next = await this.append(l => [...this.pauseEvents(l, "integration-infrastructure"),
      this.inboxEvent(l, "failure", "critical", null, `${text} The plan is paused; unpause to retry.`, now)]);
    this.notifyInbox(this.newInbox(next, before));
    this.pausedWork = true;
    this.ensurePoll();
  }

  /** `integrateStack(T)` of memo §4.2. `plan` given = the rebase step is already open with that detail. */
  private async integrateStack(live: LiveEntry, T: readonly TaskId[],
    plan: Array<{ taskId: TaskId; tip: string; upstream: string }> | null): Promise<void> {
    const { stacked, deferred } = await this.stack(live, T, plan);
    if (stacked.length > 0) {
      const verdict = await this.check(live, T.length === 1 ? "checks" : "batch-checks", stacked);
      if (verdict === "pass") {
        if (T.length > 1) this.counters.push(counterEvent("integration.batch", stacked.length, { outcome: "pass" }));
        await this.integrate(live, stacked);
      } else {
        if (stacked.length > 1) this.counters.push(counterEvent("integration.batch", stacked.length, { outcome: "halved" }));
        this.probes = 0;
        await this.halve(live, stacked);
        if (stacked.length > 1) this.counters.push(counterEvent("integration.bisect.probes", this.probes, { kind: "halves" }));
      }
    }
    if (deferred.length > 0) await this.integrateStack(live, deferred, null);
  }

  private probes = 0;

  /** M17: stack T in the slot of T's last task. A conflict on the head is terminal (row 31); against a batch-mate it defers. */
  private async stack(live: LiveEntry, T: readonly TaskId[],
    given: Array<{ taskId: TaskId; tip: string; upstream: string }> | null): Promise<StackResult> {
    const head = this.ledger.integration.head;
    const lastId = T[T.length - 1];
    const slotId = lastId === undefined ? null : this.ledger.tasks[lastId]?.slot ?? null;
    if (slotId === null) throw new ExecutorError("E_INVALID_INPUT", "stack task has no slot", { taskId: lastId ?? null });
    let plan = given ?? await this.stackPlan(T, head);
    if (live.open === null) await this.start(live, "rebase", { v: 1, onto: head, tasks: plan }, { slot: slotId });
    const lease = await this.slotLease(slotId, lastId ?? live.entry.id);
    const stacked: RangeDetail[] = [];
    const deferred: TaskId[] = [];
    let prev = head;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      if (p === undefined) continue;
      if (this.ctl.signal.aborted) throw new LaneStop("aborted");
      await this.guardWrite(live, lease.path, "slot");
      await this.d.pool.reset(lease.slot, p.tip);
      const r = await this.d.git.rebaseOnto(lease.path, prev, p.upstream);
      if (r.ok) {
        stacked.push({ taskId: p.taskId, from: prev, to: r.head });
        prev = r.head;
        continue;
      }
      await this.assertLock(live); // QA-3.2-28: rebaseAbort is a write too
      await this.d.git.rebaseAbort(lease.path);
      if (prev !== head) {
        deferred.push(p.taskId);
        continue;
      }
      // Row 31: a conflict with the integration head itself.
      await this.conflict(live, p, r.conflicts, head, lease.path);
      const rest = plan.slice(i + 1);
      if (rest.length > 0) {
        plan = rest;
        i = -1;
        await this.start(live, "rebase", { v: 1, onto: head, tasks: rest }, { slot: slotId });
      } else {
        return { stacked, deferred };
      }
    }
    await this.end(live, "ok", { v: 1, stacked: rangesOf(stacked), deferred: [...deferred] }, false);
    return { stacked, deferred };
  }

  /** M15 summaries, then the row-31 batch [ISE(rebase, conflict), TT integrating->conflict, AX]. The slot is kept (M35). */
  private async conflict(live: LiveEntry, p: { taskId: TaskId; tip: string; upstream: string }, conflicts: readonly string[],
    head: string, cwd: string): Promise<void> {
    const paths = conflicts.slice(0, 20);
    const ours: Record<string, Array<{ sha: string; subject: string }>> = {};
    const theirs: Record<string, Array<{ sha: string; subject: string }>> = {};
    for (const path of paths) {
      ours[path] = await this.d.igit.logPaths(cwd, p.upstream, head, path, 5).catch(() => []);
      theirs[path] = await this.d.igit.logPaths(cwd, p.upstream, p.tip, path, 5).catch(() => []);
    }
    const lines = [`Rebase of ${p.taskId} onto the integration head ${head} conflicted in ${conflicts.length} path(s).`];
    for (const path of paths) {
      lines.push(`- ${path}`);
      for (const c of ours[path] ?? []) lines.push(`  integrated ${c.sha.slice(0, 12)} ${c.subject}`);
      for (const c of theirs[path] ?? []) lines.push(`  this task ${c.sha.slice(0, 12)} ${c.subject}`);
    }
    if (conflicts.length > paths.length) lines.push(`(${conflicts.length - paths.length} more paths not shown)`);
    lines.push("Rebase the task onto the integration head and resolve these paths.");
    const text = lines.join("\n");
    // Row 31 order (phase-1.4.md:942): ISE, AX, TT.
    await this.endDecide(live, "conflict",
      { v: 1, taskId: p.taskId, paths, truncated: conflicts.length > paths.length, ours, theirs }, [p.taskId], [],
      l => [...this.ax(l, p.taskId, text), ...this.tt(l, p.taskId, "conflict", "rebase-conflict")]);
    if (!this.disposed) this.safe(() => this.d.listener.onConflict(p.taskId));
  }

  /** ISE of the open step whose `closes` is computed against the ledger the batch applies to (row 30/31/32 rule). */
  private async endDecide(live: LiveEntry, result: IntegrationStepResult, detail: StepDetail, decided: readonly TaskId[],
    failingIds: readonly string[], post: Pre, onCloses?: (closes: boolean) => void): Promise<Readonly<LedgerV1>> {
    const step = live.open;
    if (step === null) throw new ExecutorError("E_INVALID_INPUT", "no step is open", { entry: live.entry.id });
    const ms = this.d.clock.now() - live.openedAt;
    const entry = live.entry;
    let closes = false;
    const next = await this.append(l => {
      closes = this.closesWith(l, live, decided);
      const extra: ExecutorEventInput[] = [counterEvent("integration.step", ms, { step, result })];
      if (closes) extra.push(counterEvent("integration.entry", 1, { kind: entry.kind, outcome: result }));
      return [ise(entry, step, result, detail, closes, failingIds), ...post(l), ...extra];
    });
    live.open = null;
    onCloses?.(closes);
    if (closes) await this.closed(live);
    return next;
  }

  private lastFail = new Map<string, { ids: string[]; detail: CheckDetail }>();

  /** One check run at the stack tip (M8-M13). Pass ends the step ok; fail leaves it open for the caller (row 32 or halving). */
  private async check(live: LiveEntry, step: CheckStep, S: readonly RangeDetail[]): Promise<"pass" | "fail"> {
    const head = this.ledger.integration.head;
    const tipRange = S[S.length - 1];
    if (tipRange === undefined) throw new ExecutorError("E_INVALID_INPUT", "empty stack", null);
    const candidate = tipRange.to;
    const tasks = S.map(r => r.taskId);
    if (step === "bisect") this.probes++;
    const memo = this.verdicts.get(candidate);
    if (memo !== undefined) {
      await this.start(live, step, { v: 1, base: head, candidate, tasks, probe: "memo" }, { candidate });
      if (memo === "pass") {
        await this.end(live, "ok", { v: 1, verdict: "pass", components: [], failingFiles: [], flakyIds: [], note: null, error: null, output: "" }, false);
        return "pass";
      }
      return "fail";
    }
    const slotId = live.entry.slot;
    if (slotId === null) throw new ExecutorError("E_INVALID_INPUT", "entry has no slot", { entry: live.entry.id });
    const lease = await this.slotLease(slotId, live.entry.id);
    let n = 0;
    for (;;) {
      await this.start(live, step, { v: 1, base: head, candidate, tasks }, { candidate });
      await this.assertLock(live); // QA-3.2-28: the checks prepare (reset + clean) the slot first
      const r = await this.d.checks.run({ slot: lease, base: head, candidate, priority: "foreground", extra: null, signal: this.ctl.signal });
      // QA-3.2-13: once the outer signal fired the run is interrupted whatever it returned: no failed/onFailed during abort.
      if (this.ctl.signal.aborted) throw new LaneStop("checks interrupted");
      const scope = r.components.find(c => c.name === "tests")?.scope ?? "full";
      this.counters.push(counterEvent("integration.checks", r.durationMs, { verdict: r.verdict, scope }));
      if (r.verdict !== "error" && r.flakyIds.length > 0) this.counters.push(counterEvent("integration.flaky", r.flakyIds.length, { where: "checks" }));
      if (r.verdict === "pass") {
        if (r.note === "no-checks") this.counters.push(counterEvent("integration.checks.none", 1, {}));
        this.passed.add(candidate);
        this.verdicts.set(candidate, "pass");
        await this.end(live, "ok", checkDetail(r), false);
        return "pass";
      }
      if (r.verdict === "fail") {
        this.verdicts.set(candidate, "fail");
        this.lastFail.set(candidate, { ids: [...r.failingIds], detail: checkDetail(r) });
        return "fail";
      }
      if (r.reason === "interrupted" || this.ctl.signal.aborted) throw new LaneStop("checks interrupted");
      if (r.reason !== "preempted") n++;
      else this.counters.push(counterEvent("integration.preempt", 1, {}));
      await this.end(live, "refused", { v: 1, reason: r.reason, n, message: clipText(r.message, 1000) }, false);
      if (n >= CHECK_TRIES) await this.infraPause(live, `Integration checks of ${tasks.join(", ")} at ${candidate} could not run ${n} times (${r.reason}: ${clipText(r.message, 500)}).`);
    }
  }

  /** M13a exhaustion: [status-changed running->paused "integration-infrastructure" (only if running), IA(failure, critical)]; the entry stays open (M36). */
  private async infraPause(live: LiveEntry, text: string): Promise<never> {
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const next = await this.append(l => [...this.pauseEvents(l, "integration-infrastructure"),
      this.inboxEvent(l, "failure", "critical", null, `${text} The plan is paused; unpause to retry.`, now)]);
    this.notifyInbox(this.newInbox(next, before));
    this.markStalled(live);
    await this.releaseForPause(live);
    throw new LaneStop("integration-infrastructure");
  }

  /** M18 halving. pre: S on the current head, S's tip observed (or memoized) failing; its check step may still be open. */
  private async halve(live: LiveEntry, S: readonly RangeDetail[]): Promise<void> {
    const only = S[0];
    if (S.length === 1 && only !== undefined) {
      await this.culprit(live, only);
      return;
    }
    const tip = S[S.length - 1];
    if (live.open !== null && tip !== undefined) {
      const f = this.lastFail.get(tip.to);
      await this.end(live, "failed", f?.detail ?? { v: 1, reason: "memo" }, false, f?.ids ?? []);
    }
    const k = Math.ceil(S.length / 2);
    const L = S.slice(0, k);
    const R = S.slice(k);
    if (await this.check(live, "bisect", L) === "pass") {
      await this.integrate(live, L);
      await this.halve(live, R);
    } else {
      await this.halve(live, L);
      await this.integrateStack(live, R.map(r => r.taskId), null);
    }
  }

  /** Row 32: the task whose commit at exactly head + ... + task failed. */
  private async culprit(live: LiveEntry, r: RangeDetail): Promise<void> {
    const head = this.ledger.integration.head;
    if (live.open === null) {
      await this.start(live, "bisect", { v: 1, base: head, candidate: r.to, tasks: [r.taskId], probe: "memo" }, { candidate: r.to });
    }
    const f = this.lastFail.get(r.to);
    const detail: CheckDetail = f?.detail ?? { v: 1, verdict: "fail", components: [], failingFiles: [], flakyIds: [], note: null, error: null, output: "" };
    const ids = f?.ids ?? [];
    const text = [`Integration checks failed for ${r.taskId} at ${r.to} (on integration head ${head}).`,
      ids.length > 0 ? `Failing: ${ids.slice(0, 50).join(", ")}` : "",
      detail.failingFiles.length > 0 ? `Files: ${detail.failingFiles.slice(0, 50).join(", ")}` : "",
      detail.output !== "" ? `Output (tail):\n${tailBytes(detail.output, 2000)}` : ""].filter(s => s !== "").join("\n");
    // Row 32 order (phase-1.4.md:943): ISE, AX, TT.
    await this.endDecide(live, "failed", detail, [r.taskId], ids,
      l => [...this.ax(l, r.taskId, text), ...this.tt(l, r.taskId, "failed", "checks-failed")]);
    if (!this.disposed) this.safe(() => this.d.listener.onFailed(r.taskId));
  }

  /** Fast-forwards to the checked tip of S (I1), then the row-30 batch and the M35 releases. */
  private async integrate(live: LiveEntry, S: readonly RangeDetail[]): Promise<void> {
    const tip = S[S.length - 1];
    if (tip === undefined) return;
    const head = this.ledger.integration.head;
    await this.fastForward(live, "fast-forward", tip.to, { v: 1, from: head, to: tip.to, ranges: rangesOf(S) }, []);
    await this.completeIntegrated(live, head, tip.to, S);
  }

  /** Row 30: [ISE(fast-forward ok), IH, per task task-integrated + TT integrating->integrated + TS(null)], then releases. */
  private async completeIntegrated(live: LiveEntry, from: string, to: string, S: readonly RangeDetail[]): Promise<void> {
    const ids = S.map(r => r.taskId);
    const slots = new Map<TaskId, string | null>(ids.map(id => [id, this.ledger.tasks[id]?.slot ?? null]));
    const phases = new Set<PhaseId>();
    await this.endDecide(live, "ok", { v: 1, from, to }, ids, [], l => {
      const out: ExecutorEventInput[] = [{ type: "integration-head", head: to }];
      for (const r of S) {
        const t = l.tasks[r.taskId];
        if (t === undefined || t.state !== "integrating") continue;
        if (t.phase !== null) phases.add(t.phase);
        out.push({ type: "task-integrated", taskId: r.taskId, from: r.from, to: r.to });
        out.push(...this.tt(l, r.taskId, "integrated", "fast-forwarded"));
        out.push({ type: "task-slot", taskId: r.taskId, slot: null, branch: t.branch });
      }
      return out;
    });
    if (this.disposed) return;
    for (const id of ids) {
      const slot = slots.get(id) ?? null;
      if (slot !== null) await this.d.pool.release(slot).catch((e: unknown) => this.d.logger.warn(`integration queue: slot release failed: ${message(e)}`));
      this.d.leases.releaseTask(id);
      this.safe(() => this.d.listener.onIntegrated(id));
    }
    for (const p of phases) await this.checkPhaseSafe(p);
    // QA-3.2-31: a phase with no task of its own integrates when the phases it depends on do: wake those dependents.
    for (const q of dependentPhases(this.ledger, phases)) await this.checkPhaseSafe(q);
  }

  /**
   * M6 / I1: the only code that moves the integration branch. ISS(step, candidate) -> branch at head? -> integration worktree at
   * head -> merge --ff-only -> CAS. The caller writes the closing batch.
   */
  private async fastForward(live: LiveEntry, step: "fast-forward" | "revert-fast-forward", candidate: string, detail: StepDetail,
    failingIds: readonly string[]): Promise<void> {
    if (!this.passed.has(candidate)) {
      throw new ExecutorError("E_INVALID_INPUT", "I1: refusing to fast-forward to a commit whose checks did not pass in this entry",
        { entry: live.entry.id, candidate });
    }
    const l = this.ledger;
    const head = l.integration.head;
    const wt = l.integration.worktree;
    await this.start(live, step, detail, { candidate }, failingIds);
    let tip: string | null;
    try {
      tip = await this.branchTip();
    } catch (e) {
      // QA-3.2-9: git could not run; infrastructure (M13a), never "moved".
      await this.end(live, "refused", { v: 1, reason: "git", message: clipText(message(e), 1000) }, false);
      return this.infraPause(live, `The integration branch ${l.integration.branch} could not be read before the fast-forward (${clipText(message(e), 500)}).`);
    }
    if (tip !== head) {
      await this.halt(live, "integration-branch-moved", tip === null
        ? `The integration branch ref refs/heads/${l.integration.branch} does not exist (journaled head ${head}). The plan is paused.`
        : `The integration branch ${l.integration.branch} is at ${tip}, not at the journaled head ${head}. The plan is paused.`);
    }
    const lease = await this.integrationSlot();
    await this.guardWrite(live, wt, "integration");
    let at: string | null = null;
    try {
      at = await this.d.git.revParse(wt, "HEAD");
    } catch {
      at = null;
    }
    const dirty = at === head ? (await this.d.git.statusPorcelain(wt)).length > 0 : true;
    if (at !== head || dirty) await this.d.pool.reset(lease.slot, head);
    // QA-3.2-36: abort() fired: no merge and no CAS; the step stays open and abort() rolls the entry back.
    if (this.ctl.signal.aborted) throw new LaneStop("aborted before the merge");
    const merged = await this.d.git.mergeFfOnly(wt, candidate);
    if (!merged.ok || merged.head !== candidate) {
      await this.halt(live, "ff-refused",
        `git merge --ff-only ${candidate} was refused in the integration worktree (head ${head}). The plan is paused; resume() rolls the entry back.`);
    }
    if (this.ctl.signal.aborted) throw new LaneStop("aborted before the CAS");
    // QA-3.2-28: the lock file is re-read (token compare) right before the CAS, not only the last heartbeat's verdict.
    await this.assertLock(live, true);
    try {
      await this.d.git.branchForce(l.integration.branch, candidate, head);
    } catch (e) {
      await this.halt(live, "integration-branch-moved",
        `The compare-and-swap of ${l.integration.branch} from ${head} to ${candidate} failed (${clipText(message(e), 300)}). The plan is paused.`);
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // IntegrationQueue API
  // -------------------------------------------------------------------------------------------------------------

  enqueue(taskIds: readonly TaskId[]): void {
    if (this.disposed) throw new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId });
    if (this.aborting) throw new ExecutorError("E_PLAN_STATE", "the plan is aborting", { planId: this.d.planId });
    const l = this.ledger;
    if (l.status !== "running" && l.status !== "paused") {
      throw new ExecutorError("E_PLAN_STATE", "enqueue needs a running or paused plan", { planId: this.d.planId, status: l.status });
    }
    for (const id of taskIds) {
      if (this.fifo.includes(id) || this.requeued.some(g => g.taskIds.includes(id))) continue;
      if (this.serial?.entry.taskIds.includes(id) === true) continue;
      const t = l.tasks[id];
      if (t === undefined || t.state !== "verified" || t.slot === null || t.branch === null) {
        this.d.logger.warn(`integration queue: ignoring enqueue of ${id} (state ${t?.state ?? "unknown"})`);
        continue;
      }
      this.fifo.push(id);
    }
    void this.pokeStalled();
    this.kick();
  }

  queued(): readonly TaskId[] {
    if (this.disposed) return [];
    return [...this.requeued.flatMap(g => g.taskIds), ...this.fifo];
  }

  async checkPhase(p: PhaseId): Promise<void> {
    if (this.disposed) throw new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId });
    if (this.aborting) return;
    void this.pokeStalled();
    const l = this.ledger;
    const ph = l.phases.find(x => x.id === p);
    if (ph === undefined || ph.paused) return;
    const open = this.d.writer.openIntegration().filter(o => o.entry.phaseId === p);
    if (l.status !== "running") {
      // QA-3.2-15: the last phase can pass after the plan completed; its tag entry still runs (serial lane, tags only).
      if (l.status === "completed" && ph.gate === "passed" && ph.tag === null && !open.some(o => o.entry.kind === "tag") && !this.tags.includes(p)) {
        this.tags.push(p);
        this.kick();
      }
      return;
    }
    const head = l.integration.head;
    if (ph.gate === "pending") {
      if (!phaseIntegrated(l, p) || this.suites.some(s => s.phaseId === p) || this.background?.entry.phaseId === p) return;
      // QA-3.2-19: a phase with no task of its own (qa only) has nothing for a suite to attribute: it skips the suite.
      const res: SuiteResolution = phaseHasOwnTasks(l, p) ? await this.d.suite.resolve(l, p, head) : { kind: "none" };
      if (res.kind === "runs") {
        this.suites.push({ phaseId: p, gate: "start" });
        this.kick();
        return;
      }
      if (res.kind === "refused") {
        await this.suiteRefused(p, res.reason);
        return;
      }
      // Only the call whose batch opened the gate notifies: a concurrent checkPhase finds the gate already open (empty batch).
      let opened = false;
      const next = await this.append(lg => {
        const cur = lg.phases.find(x => x.id === p);
        opened = cur !== undefined && cur.gate === "pending";
        if (cur === undefined || !opened) return [];
        return [{ type: "gate-changed", phaseId: p, from: "pending", to: "awaiting-qa", trigger: "phase-integrated", qaRound: cur.qaRound },
          counterEvent("integration.suite", 0, { verdict: res.kind })];
      });
      if (opened && next.phases.find(x => x.id === p)?.gate === "awaiting-qa" && !this.disposed) this.safe(() => this.d.listener.onGate(p, "awaiting-qa"));
      return;
    }
    if (ph.gate === "suite-running") {
      if (open.some(o => o.entry.kind === "phase-suite") || this.background?.entry.phaseId === p || this.suites.some(s => s.phaseId === p)) return;
      this.suites.push({ phaseId: p, gate: "none" });
      this.kick();
      return;
    }
    if (ph.gate === "suite-failed") {
      if (open.length > 0 || this.reverts.some(r => r.phaseId === p) || this.suites.some(s => s.phaseId === p)) return;
      const pending = await this.revertFromHistory(p);
      if (pending !== null) this.reverts.unshift(pending);
      else this.suites.push({ phaseId: p, gate: "rerun" });
      this.kick();
      return;
    }
    if (ph.gate === "passed" && ph.tag === null) {
      if (open.some(o => o.entry.kind === "tag") || this.tags.includes(p)) return;
      this.tags.push(p);
      this.kick();
    }
  }

  land(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    if (this.disposed) return Promise.reject(new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId }));
    if (this.landing !== null) return this.landing;
    const p = this.doLand().finally(() => { this.landing = null; });
    this.landing = p;
    return p;
  }

  resume(): Promise<ResumeReport> {
    if (this.disposed) return Promise.reject(new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId }));
    if (this.resumed && this.report !== null) return Promise.resolve(this.report);
    if (this.resuming !== null) return this.resuming;
    const p = this.doResume().finally(() => { this.resuming = null; });
    this.resuming = p;
    return p;
  }

  abort(): Promise<void> {
    if (this.disposed) return Promise.reject(new ExecutorError("E_DISPOSED", "integration queue disposed", { planId: this.d.planId }));
    if (this.aborted === null) this.aborted = this.doAbort();
    return this.aborted;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // The reason lets the suite runner report `interrupted by dispose` (not abort).
    this.ctl.abort("dispose");
    this.bgCtl.abort("dispose");
    this.lockCtl.abort("dispose");
    this.clearStalled();
    await new Promise<void>(resolve => {
      const h = this.d.clock.setTimer(30_000, resolve);
      void this.idle().then(() => { this.d.clock.clearTimer(h); resolve(); });
    });
    await this.releaseLock();
  }

  private landing: Promise<{ landed: boolean; inbox: InboxItem | null }> | null = null;
  private aborted: Promise<void> | null = null;
  private report: ResumeReport | null = null;
  private inResume = false;
  private serialTail: Promise<void> = Promise.resolve();
  private serialLoopP: Promise<void> = Promise.resolve();
  private backgroundLoopP: Promise<void> = Promise.resolve();

  private async withSerial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.serialTail;
    let free!: () => void;
    this.serialTail = new Promise<void>(resolve => { free = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      free();
    }
  }

  private async idle(): Promise<void> {
    await Promise.allSettled([this.serialLoopP, this.backgroundLoopP, this.serialTail]);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lanes (M4)
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Starts each lane loop that is not running. A kick that finds a loop running sets that lane's `wanted` flag, which the
   * loop's `.finally` re-checks: a loop that already decided it had nothing to do (pickSerial null, no suite) but has not
   * cleared its running flag yet would otherwise swallow the kick, and the work queued with it would wait for the next one.
   */
  private kick(): void {
    if (this.disposed || this.stopped || this.aborting || !this.resumed) return;
    this.kickSerial();
    this.kickBackground();
  }

  /**
   * Each lane's `.finally` re-kicks only its own lane. A lane-agnostic re-kick let two idle lanes keep setting each other's
   * `wanted` flag (each loop ends within a few microtasks, while the other is still "running"), an endless microtask
   * ping-pong that starved timers and I/O whenever no work was dequeueable (e.g. only paused-phase tasks queued).
   */
  private kickSerial(): void {
    if (this.disposed || this.stopped || this.aborting || !this.resumed) return;
    if (this.serialRunning) {
      this.serialWanted = true;
      return;
    }
    this.serialRunning = true;
    this.serialWanted = false;
    this.serialLoopP = this.serialLoop().finally(() => {
      this.serialRunning = false;
      if (this.serialWanted) {
        this.serialWanted = false;
        this.kickSerial();
      }
    });
  }

  private kickBackground(): void {
    if (this.disposed || this.stopped || this.aborting || !this.resumed) return;
    if (this.backgroundRunning) {
      this.backgroundWanted = true;
      return;
    }
    this.backgroundRunning = true;
    this.backgroundWanted = false;
    this.backgroundLoopP = this.backgroundLoop().finally(() => {
      this.backgroundRunning = false;
      if (this.backgroundWanted) {
        this.backgroundWanted = false;
        this.kickBackground();
      }
    });
  }

  private serialWanted = false;
  private backgroundWanted = false;

  /** Lanes run while running; the serial lane also runs tag entries of a completed plan (QA-3.2-15). */
  private laneOpen(serial = false): boolean {
    const status = this.ledger.status;
    return this.resumed && !this.disposed && !this.stopped && !this.aborting
      && (status === "running" || (serial && status === "completed" && this.tags.length > 0));
  }

  private async serialLoop(): Promise<void> {
    while (this.laneOpen(true) && this.stalled.size === 0) {
      const job = this.pickSerial(this.ledger);
      if (job === null) return;
      const ok = await this.withSerial(async () => {
        try {
          await job();
          return true;
        } catch (e) {
          this.laneError(e);
          if (!(e instanceof LaneStop)) await this.unexpected(this.serial, e);
          return false;
        }
      });
      if (!ok) return;
    }
  }

  private async backgroundLoop(): Promise<void> {
    while (this.laneOpen()) {
      const job = this.suites.shift();
      if (job === undefined) return;
      try {
        await this.runSuite(job.phaseId, job.gate);
      } catch (e) {
        this.laneError(e);
        if (!(e instanceof LaneStop)) await this.unexpected(this.background, e);
        return;
      }
    }
  }

  /** An unexpected throw with an entry open: pause through M13a so resume (or the stalled path) rolls it back. */
  private async unexpected(live: LiveEntry | null, e: unknown): Promise<void> {
    if (live === null || this.disposed || this.stopped || this.aborting || this.stalled.get(live.lane) === live) return;
    if (errCode(e) === "E_DISPOSED" || errCode(e) === "E_LOCK_LOST") return;
    try {
      if (live.open !== null) await this.end(live, "refused", { v: 1, reason: "error", message: clipText(message(e), 1000) }, false);
      await this.infraPause(live, `Integration entry ${live.entry.id} (${live.entry.kind}) stopped: ${clipText(message(e), 500)}.`);
    } catch (inner) {
      this.laneError(inner);
    }
  }

  /** M4 pick order: resume reruns, pending reverts, tags, task FIFO (batched). Land is driven by land(). */
  private pickSerial(l: Readonly<LedgerV1>): (() => Promise<void>) | null {
    if (l.status !== "running") {
      const tag = this.tags.shift();
      return tag === undefined ? null : () => this.runTag(tag);
    }
    for (let i = 0; i < this.requeued.length; i++) {
      const g = this.requeued[i];
      if (g === undefined) continue;
      const ids = g.taskIds.filter(id => l.tasks[id]?.state === "integrating");
      if (ids.length === 0) {
        this.requeued.splice(i, 1);
        i--;
        continue;
      }
      if (phasePaused(l, g.phaseId)) continue;
      this.requeued.splice(i, 1);
      return () => this.runTaskEntry(ids, true);
    }
    const rerunAt = this.reverts.findIndex(r => r.rerun !== null);
    const revertAt = rerunAt >= 0 ? rerunAt : this.reverts.length > 0 ? 0 : -1;
    if (revertAt >= 0) {
      const rv = this.reverts.splice(revertAt, 1)[0];
      if (rv !== undefined) return () => this.runRevert(rv);
    }
    const tag = this.tags.shift();
    if (tag !== undefined) return () => this.runTag(tag);
    const batch = pickBatch(l, this.fifo, l.config.batchMax);
    if (batch.length > 0) return () => this.runTaskEntry(batch, false);
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.3 / 4.4 phase suite (background lane)
  // -------------------------------------------------------------------------------------------------------------

  private gateEvent(l: Readonly<LedgerV1>, p: PhaseId, from: GateState, to: GateState, trigger: GateTrigger): ExecutorEventInput[] {
    const ph = l.phases.find(x => x.id === p);
    if (ph === undefined || ph.gate !== from) return [];
    return [{ type: "gate-changed", phaseId: p, from, to, trigger, qaRound: ph.qaRound }];
  }

  private async suiteRefused(p: PhaseId, reason: string): Promise<void> {
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const next = await this.append(l => [{ type: "phase-paused", phaseId: p, paused: true, reason: "suite-unresolvable" },
      this.inboxEvent(l, "failure", "critical", null, `The phase suite of ${p} cannot be resolved: ${reason}. Phase ${p} is paused.`, now)]);
    this.notifyInbox(this.newInbox(next, before));
  }

  private phaseRanges(l: Readonly<LedgerV1>, p: PhaseId): TaskRange[] {
    const out: TaskRange[] = [];
    for (const t of Object.values(l.tasks)) {
      if (t.phase === p && t.state === "integrated" && t.integrated !== null) out.push({ taskId: t.id, from: t.integrated.from, to: t.integrated.to });
    }
    return out;
  }

  private async runSuite(p: PhaseId, gate: "start" | "rerun" | "none"): Promise<void> {
    const l = this.ledger;
    const ph = l.phases.find(x => x.id === p);
    if (ph === undefined || ph.paused) return;
    if (gate === "start" && ph.gate !== "pending") return;
    if (gate === "rerun" && ph.gate !== "suite-failed") return;
    if (gate === "none" && ph.gate !== "suite-running") return;
    const head = l.integration.head;
    const res: SuiteResolution = gate === "start" && !phaseHasOwnTasks(l, p) ? { kind: "none" } : await this.d.suite.resolve(l, p, head);
    if (res.kind === "refused") {
      await this.suiteRefused(p, res.reason);
      return;
    }
    if (res.kind !== "runs" && gate !== "start") {
      // QA-3.2-2: a suite state (suite-running with no entry, or suite-failed on a rerun) is never left without a run:
      // no gate event; the phase pauses with a critical item (M21 "never skipped silently", A2-1 "never stuck silently").
      // Nit A-3.2-1: `off` comes from the plan's approved `phaseSuite` setting, not from missing tests.
      const remedy = res.kind === "off"
        ? "The plan's approved phaseSuite setting is \"off\": set phaseSuite (re-approve the plan's config) or move the gate on by hand"
        : "Restore the phase's tests";
      await this.suiteRefused(p, `the suite resolves to "${res.kind}" at head ${head} while the gate is ${ph.gate}, so it cannot run and the gate stays ${ph.gate}. ${remedy}, then unpause phase ${p} to run the suite`);
      return;
    }
    if (res.kind !== "runs") {
      // Off or no tests at this commit: the gate leaves pending without a run (M21).
      const next = await this.append(lg => [
        ...(gate === "start" ? this.gateEvent(lg, p, "pending", "awaiting-qa", "phase-integrated") : []),
        counterEvent("integration.suite", 0, { verdict: res.kind })]);
      if (next.phases.find(x => x.id === p)?.gate === "awaiting-qa" && !this.disposed) this.safe(() => this.d.listener.onGate(p, "awaiting-qa"));
      return;
    }
    const base = phaseBase(await this.loadSteps(), p);
    const live = await this.openEntry("background",
      { kind: "phase-suite", phaseId: p, taskIds: [], slot: "ci", baseHead: head, candidate: head }, "phase-suite",
      { v: 1, commit: head, base, commands: res.commands.map(c => ({ label: c.label, ref: c.ref })) },
      lg => gate === "start" ? this.gateEvent(lg, p, "pending", "suite-running", "phase-integrated")
        : gate === "rerun" ? this.gateEvent(lg, p, "suite-failed", "suite-running", "suite-rerun") : []);
    if (gate !== "none" && !this.disposed) this.safe(() => this.d.listener.onGate(p, "suite-running"));
    const startedAt = this.d.clock.now();
    const ci = await this.d.pool.acquireSpecial(this.d.planId, "ci");
    try {
      const verdict = await this.d.suite.run({ planId: this.d.planId, phaseId: p, commit: head, base,
        ranges: this.phaseRanges(this.ledger, p), commands: res.commands, slot: ci }, this.journal(live, this.bgCtl.signal));
      await this.closeSuite(live, p, head, verdict, startedAt, res.commands);
    } finally {
      if (!this.disposed && this.background !== live) {
        await this.d.pool.release(ci.slot).catch((e: unknown) => this.d.logger.warn(`integration queue: ci release failed: ${message(e)}`));
      }
    }
  }

  /** §4.4 step 9 closing batches; the runner leaves its final step open. */
  private async closeSuite(live: LiveEntry, p: PhaseId, commit: string, v: SuiteVerdict, startedAt: number,
    commands: readonly ResolvedCommand[]): Promise<void> {
    if (v.kind === "interrupted") throw new LaneStop(`suite interrupted by ${v.by}`);
    // QA-3.2-36: abort()/dispose() fired while the run returned: no gate, pause or inbox event; abort() closes the entry.
    if (this.bgCtl.signal.aborted || this.aborting) throw new LaneStop("suite closed after abort");
    if (v.kind === "error") {
      if (live.open !== null) await this.end(live, "refused", { v: 1, reason: v.reason, message: clipText(v.message, 1000) }, false);
      return this.infraPause(live, `The phase suite of ${p} could not run (${v.reason}: ${clipText(v.message, 500)}).`);
    }
    if (live.open === null) await this.start(live, "phase-suite", { v: 1, commit, base: null, commands: commands.map(c => ({ label: c.label, ref: c.ref })) });
    const ms = this.d.clock.now() - startedAt;
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    let next: Readonly<LedgerV1>;
    let gate: GateState | null = null;
    if (v.kind === "passed") {
      gate = "awaiting-qa";
      next = await this.end(live, "ok", { v: 1, files: [], idsUnparsed: false, durationMs: ms, output: "" }, true, [],
        l => [...this.gateEvent(l, p, "suite-running", "awaiting-qa", "suite-passed"), counterEvent("integration.suite", ms, { verdict: "passed" })]);
    } else if (v.kind === "flaky" || v.kind === "pre-existing") {
      gate = "awaiting-qa";
      const flaky = v.kind === "flaky";
      next = await this.end(live, flaky ? "flaky" : "pre-existing", { v: 1, durationMs: ms, output: "" }, true, v.ids,
        l => [...this.gateEvent(l, p, "suite-running", "awaiting-qa", "suite-passed"),
          this.inboxEvent(l, flaky ? "flaky" : "failure", "info", null, flaky
            ? `Phase ${p} suite at ${commit}: flaky tests passed on rerun: ${v.ids.slice(0, 50).join(", ")}.`
            : `Phase ${p} suite at ${commit}: failures that already fail at the phase base: ${v.ids.slice(0, 50).join(", ")}.`, now),
          counterEvent("integration.suite", ms, { verdict: v.kind }),
          ...(flaky ? [counterEvent("integration.flaky", v.ids.length, { where: "suite" })] : [])]);
    } else if (v.kind === "culprit") {
      gate = "suite-failed";
      // QA-3.2-24: the failing files ride in the closing detail, so a revert rebuilt from history (restart) still has them.
      next = await this.end(live, "failed", { v: 1, verdict: "fail", probes: 0, culprit: { taskId: v.range.taskId, from: v.range.from, to: v.range.to },
        files: [...v.files] },
        true, v.ids, l => [...this.gateEvent(l, p, "suite-running", "suite-failed", "suite-culprit-found"),
          counterEvent("integration.suite", ms, { verdict: "culprit" })]);
      const resolved = await this.d.suite.resolve(this.ledger, p, commit).catch(() => null);
      this.reverts.unshift({ phaseId: p, culprit: { ...v.range }, suiteCommit: commit, ids: [...v.ids], files: [...v.files],
        commands: resolved !== null && resolved.kind === "runs" ? resolved.commands : [...commands], rerun: null });
    } else {
      const why = v.reason === "outside" ? "the failure lies outside the phase's task ranges (outside)"
        : v.reason === "no-base" ? "the phase has no recorded base to compare against (no-base)"
        : v.reason === "base-overlap" ? "every failing file also fails at the phase base, so the regression cannot be probed apart from the pre-existing failures (base-overlap)"
        : "the base check's output could not be parsed into test ids, so pre-existing failures cannot be told apart (base-unparsed)";
      next = await this.end(live, "failed", { v: 1, verdict: "fail", probes: 0, outside: v.reason === "outside" ? "last-passes" : undefined }, true, v.ids,
        l => [{ type: "phase-paused", phaseId: p, paused: true, reason: "suite-unattributed" },
          this.inboxEvent(l, "failure", "critical", null,
            `Phase ${p} suite at ${commit} failed (${v.ids.slice(0, 50).join(", ")}) and the failure is not attributable to a task of the phase: ${why}. Phase ${p} is paused.`, now),
          counterEvent("integration.suite", ms, { verdict: "unattributed" })]);
    }
    if (this.disposed) return;
    if (gate !== null) {
      const g = gate;
      this.safe(() => this.d.listener.onGate(p, g));
    }
    this.notifyInbox(this.newInbox(next, before));
    this.kick();
  }

  /** M25 crash path: the latest closed suite of P named a culprit and no revert entry of P since -> the revert. */
  private async revertFromHistory(p: PhaseId): Promise<PendingRevert | null> {
    const steps = await this.loadSteps();
    let suite: IntegrationStepEvent | null = null;
    for (const ev of steps) if (ev.entry.kind === "phase-suite" && ev.entry.phaseId === p && ev.closes) suite = ev;
    if (suite === null) return null;
    const seq = suite.seq;
    if (steps.some(ev => ev.entry.kind === "revert" && ev.entry.phaseId === p && ev.seq > seq)) return null;
    const detail = parseDetail(suite.detail);
    const c = detail?.culprit as Partial<RangeDetail> | undefined;
    if (c === undefined || typeof c.taskId !== "string" || typeof c.from !== "string" || typeof c.to !== "string") return null;
    const commit = suite.entry.candidate ?? suite.entry.baseHead;
    const resolved = await this.d.suite.resolve(this.ledger, p, commit).catch(() => null);
    // QA-3.2-24: ids from the closing end's failingIds, files from its detail (written since round 2).
    const files = Array.isArray(detail?.files) ? (detail.files as unknown[]).filter((f): f is string => typeof f === "string") : [];
    return { phaseId: p, culprit: { taskId: c.taskId, from: c.from, to: c.to }, suiteCommit: commit, ids: [...suite.failingIds], files,
      commands: resolved !== null && resolved.kind === "runs" ? resolved.commands : [], rerun: null };
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.5 revert entry (serial)
  // -------------------------------------------------------------------------------------------------------------

  private async runRevert(rv: PendingRevert): Promise<void> {
    const l = this.ledger;
    const culprit = l.tasks[rv.culprit.taskId];
    if (culprit === undefined || culprit.state !== "integrated") {
      if (rv.rerun === null) return;
    }
    try {
      await this.takeLock(rv.rerun?.entry.id ?? null, true);
    } catch (e) {
      this.reverts.unshift(rv); // taken off by pickSerial: keep it pending
      throw e;
    }
    const head = l.integration.head;
    const live = rv.rerun ?? await this.openEntry("serial",
      { kind: "revert", phaseId: rv.phaseId, taskIds: [rv.culprit.taskId], slot: "integration", baseHead: head, candidate: null },
      "revert-build", { v: 1, culprit: { ...rv.culprit }, suiteCommit: rv.suiteCommit, head, files: [...rv.files] }, NONE, rv.ids);
    this.serial = live;
    const slot = await this.integrationSlot();
    // M26: built at the current head (a rerun entry may have been journaled before requeued tasks integrated).
    const buildHead = this.ledger.integration.head;
    const v = await this.d.suite.revert({ planId: this.d.planId, phaseId: rv.phaseId, culprit: { ...rv.culprit }, suiteCommit: rv.suiteCommit,
      head: buildHead, regression: { ids: [...rv.ids], files: [...rv.files], commands: [...rv.commands] }, slot },
      this.journal(live, this.ctl.signal));
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const p = rv.phaseId;
    if (v.kind === "interrupted") throw new LaneStop(`revert interrupted by ${v.by}`);
    if (v.kind === "error") {
      if (live.open !== null) await this.end(live, "refused", { v: 1, reason: v.reason, message: clipText(v.message, 1000) }, false);
      return this.infraPause(live, `The revert of ${rv.culprit.taskId} could not be built or checked (${v.reason}: ${clipText(v.message, 500)}).`);
    }
    if (v.kind === "conflict") {
      // The head the revert was built at (a rerun entry's baseHead can be older), so the commands reproduce this conflict.
      const commands = [`git -C "${l.integration.worktree}" switch --detach ${buildHead}`,
        `git -C "${l.integration.worktree}" revert --no-commit ${rv.culprit.to}`];
      if (live.open === null) await this.start(live, "revert-build", { v: 1, culprit: { ...rv.culprit }, suiteCommit: rv.suiteCommit, head: buildHead, files: [...rv.files] });
      const next = await this.end(live, "conflict", { v: 1, at: v.at, paths: v.paths.slice(0, 20), commands }, true, [],
        lg => [{ type: "phase-paused", phaseId: p, paused: true, reason: "revert-conflict" },
          this.inboxEvent(lg, "failure", "critical", rv.culprit.taskId,
            `Reverting ${rv.culprit.taskId} (${rv.culprit.from}..${rv.culprit.to}) for the phase ${p} suite failure conflicts at ${v.at} in: ${v.paths.slice(0, 20).join(", ")}. Phase ${p} is paused. Inspect with (never run by the executor):\n${commands.join("\n")}`, now),
          counterEvent("integration.revert", 1, { outcome: "conflict" })]);
      this.notifyInbox(this.newInbox(next, before));
      return;
    }
    if (v.kind === "failed") {
      if (live.open === null) await this.start(live, "revert-checks", { v: 1, base: live.entry.baseHead, candidate: live.entry.candidate ?? live.entry.baseHead, extraFiles: [...rv.files] });
      const next = await this.end(live, "failed", { v: 1, verdict: "fail", components: [], failingFiles: [...v.files], flakyIds: [], note: null, error: null, output: v.output },
        true, v.ids, lg => [{ type: "phase-paused", phaseId: p, paused: true, reason: "revert-insufficient" },
          this.inboxEvent(lg, "failure", "critical", rv.culprit.taskId,
            `Reverting ${rv.culprit.taskId} did not make the integration checks pass (${v.ids.slice(0, 50).join(", ")}). The branch is unchanged; phase ${p} is paused.`, now),
          counterEvent("integration.revert", 1, { outcome: "insufficient" })]);
      this.notifyInbox(this.newInbox(next, before));
      return;
    }
    // ok: revert-checks passed in the integration slot (I1), then M6 and the row-34 batch.
    if (live.open !== null) await this.end(live, "ok", { v: 1, base: live.entry.baseHead, candidate: v.revertHead, extraFiles: [...rv.files] }, false);
    this.passed.add(v.revertHead);
    const from = this.ledger.integration.head;
    await this.fastForward(live, "revert-fast-forward", v.revertHead,
      { v: 1, from, to: v.revertHead, culprit: { ...rv.culprit }, suiteCommit: rv.suiteCommit }, rv.ids);
    await this.completeReverted(live, p, v.revertHead, rv.culprit, rv.suiteCommit, rv.ids);
  }

  /** Row 34 (M27): [ISE(revert-fast-forward ok, closes), IH, AX, TT integrated->reverted, R9 dependents, G suite-failed->pending]. */
  private async completeReverted(live: LiveEntry, p: PhaseId, to: string, culprit: TaskRange, suiteCommit: string,
    ids: readonly string[]): Promise<void> {
    const from = this.ledger.integration.head;
    const released: Array<{ id: TaskId; slot: string | null; live: boolean }> = [];
    const text = `Reverted from the integration branch: phase ${p} suite at ${suiteCommit} failed (${ids.slice(0, 50).join(", ")}); this task's range ${culprit.from}..${culprit.to} is the culprit. Fix the failing tests before integrating again.`;
    await this.end(live, "ok", { v: 1, from, to }, true, ids, l => {
      const out: ExecutorEventInput[] = [{ type: "integration-head", head: to }, ...this.ax(l, culprit.taskId, text),
        ...this.tt(l, culprit.taskId, "reverted", "suite-culprit")];
      const g2 = new Set<PhaseId>();
      for (const e of l.edges) {
        if (e.from !== culprit.taskId) continue;
        const t = l.tasks[e.to];
        if (t === undefined || (t.state !== "ready" && t.state !== "dispatched" && t.state !== "running")) continue;
        if (released.some(r => r.id === t.id)) continue;
        // `blocked` holds no open attempt (A1-7 `open-attempt`): the in-flight attempt ends before the transition, or the
        // ledger rejects the whole row-34 batch.
        const last = t.attempts[t.attempts.length - 1];
        if (last !== undefined && last.outcome === null) {
          // A2-6: endedAt = max(now, startedAt); startedAt is never rewritten (QA-3.2-16).
          const now = this.d.clock.iso();
          const endedAt = Date.parse(last.startedAt) > Date.parse(now) ? last.startedAt : now;
          out.push({ type: "attempt-ended", taskId: t.id, n: last.n, outcome: "interrupted", endedAt, detail: "dep-reverted" });
        }
        out.push(...this.tt(l, t.id, "blocked", "dep-reverted"));
        if (t.slot !== null) out.push({ type: "task-slot", taskId: t.id, slot: null, branch: t.branch });
        // QA4 G2 (rows 13/19): a qa task leaving flight for blocked takes its phase's gate qa-running->awaiting-qa.
        if (t.kind === "qa" && t.state !== "ready" && t.phase !== null && !g2.has(t.phase)) {
          const g = this.gateEvent(l, t.phase, "qa-running", "awaiting-qa", "qa-requeued");
          if (g.length > 0) g2.add(t.phase);
          out.push(...g);
        }
        released.push({ id: t.id, slot: t.slot, live: t.state !== "ready" });
      }
      out.push(...this.gateEvent(l, p, "suite-failed", "pending", "culprit-reverted"));
      out.push(counterEvent("integration.revert", 1, { outcome: "ok" }));
      return out;
    });
    if (this.disposed) return;
    for (const r of released) {
      const release = async (): Promise<void> => {
        if (r.slot !== null) await this.d.pool.release(r.slot).catch((e: unknown) => this.d.logger.warn(`integration queue: slot release failed: ${message(e)}`));
        this.d.leases.releaseTask(r.id);
      };
      if (r.live) this.d.settle(r.id, release);
      else await release();
    }
    this.safe(() => this.d.listener.onReverted(culprit.taskId));
    this.safe(() => this.d.listener.onGate(p, "pending"));
    await this.checkPhaseSafe(p);
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.6 tag entry (serial)
  // -------------------------------------------------------------------------------------------------------------

  private async runTag(p: PhaseId): Promise<void> {
    const l = this.ledger;
    const ph = l.phases.find(x => x.id === p);
    if (ph === undefined || ph.gate !== "passed" || ph.tag !== null) return;
    try {
      await this.takeLock(null, true);
    } catch (e) {
      if (!this.tags.includes(p)) this.tags.unshift(p); // taken off by pickSerial: keep it due
      throw e;
    }
    const head = l.integration.head;
    const name = this.d.lander.tagName(this.d.planId, p);
    const live = await this.openEntry("serial", { kind: "tag", phaseId: p, taskIds: [], slot: null, baseHead: head, candidate: head },
      "tag", { v: 1, name, commit: head });
    await this.finishTag(live, p, name, head);
  }

  private async finishTag(live: LiveEntry, p: PhaseId, name: string, commit: string): Promise<"tagged" | "none"> {
    const wt = this.ledger.integration.worktree;
    for (let n = 1; ; n++) {
      if (live.open === null) await this.start(live, "tag", { v: 1, name, commit }, { candidate: commit });
      await this.assertLock(live);
      let r: TagOutcome;
      try {
        await this.d.guard.assertWriteCwd(wt, "tag");
        r = await this.d.lander.tag({ cwd: wt, name, commit });
      } catch (e) {
        r = { kind: "error", message: message(e) };
      }
      if (r === "created" || r === "exists-same") {
        const outcome = r;
        await this.end(live, "ok", { v: 1, outcome }, true, [],
          l => [...(l.phases.find(x => x.id === p)?.tag === null ? [{ type: "phase-tagged" as const, phaseId: p, tag: name }] : []),
            counterEvent("integration.tag", 1, { outcome })]);
        return "tagged";
      }
      if (r.kind === "exists-other") {
        const at = r.at;
        const now = this.d.clock.iso();
        const before = this.ledger.inbox.length;
        const next = await this.end(live, "refused", { v: 1, outcome: "exists-other", at }, true, [],
          l => [this.inboxEvent(l, "failure", "info", null, `The phase tag ${name} already exists at ${at}, not at ${commit}; it is never moved.`, now),
            counterEvent("integration.tag", 1, { outcome: "exists-other" })]);
        this.notifyInbox(this.newInbox(next, before));
        return "none";
      }
      await this.end(live, "refused", { v: 1, reason: "error", n, message: clipText(r.message, 1000) }, false);
      if (n >= CHECK_TRIES) {
        if (this.ledger.status === "running") await this.infraPause(live, `The phase tag ${name} could not be created (${clipText(r.message, 500)}).`);
        // QA-3.2-30: a completed plan has no pause to lift: roll the entry back and retry later (bounded), then give up.
        await this.retryTagLater(live, p, name, commit, r.message);
        return "none";
      }
    }
  }

  /** QA-3.2-30: rolls a completed plan's failing tag entry back; retries after TAG_RETRY_BASE_MS * 2^k, at most TAG_RETRY_LIMIT times. */
  private async retryTagLater(live: LiveEntry, p: PhaseId, name: string, commit: string, why: string): Promise<void> {
    await this.rollbackEntry(this.toOpen(live), "stalled");
    const k = (this.tagRetries.get(p) ?? 0) + 1;
    this.tagRetries.set(p, k);
    if (k > TAG_RETRY_LIMIT) {
      const now = this.d.clock.iso();
      const before = this.ledger.inbox.length;
      const top = this.ledger.repo.toplevel;
      const next = await this.append(l => [this.inboxEvent(l, "failure", "blocking", null,
        `The phase tag ${name} could not be created after ${k} rounds of ${CHECK_TRIES} tries (${clipText(why, 500)}). The plan is complete, so integration stops retrying it. Create it by hand: git -C "${top}" tag ${name} ${commit}`, now),
        counterEvent("integration.tag", 1, { outcome: "gave-up" })]);
      this.notifyInbox(this.newInbox(next, before));
      return;
    }
    this.d.clock.setTimer(TAG_RETRY_BASE_MS * 2 ** (k - 1), () => {
      if (this.disposed || this.aborting || this.tags.includes(p)) return;
      this.tags.push(p);
      this.kick();
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.7 land
  // -------------------------------------------------------------------------------------------------------------

  private async doLand(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    const l0 = this.ledger;
    if (l0.status !== "completed") throw new ExecutorError("E_PLAN_STATE", "land needs a completed plan", { planId: this.d.planId, status: l0.status });
    const head = l0.integration.head;
    const steps = await this.loadSteps();
    let lastLand: IntegrationStepEvent | null = null;
    for (const ev of steps) if (ev.entry.kind === "land" && ev.closes) lastLand = ev;
    if (lastLand !== null && lastLand.result === "ok" && lastLand.entry.candidate === head) {
      const base = await this.d.igit.readRef(l0.repo.toplevel, `refs/heads/${l0.repo.baseBranch}`).catch(() => null);
      // QA-3.2-35: a base branch that already contains the landed head (the owner committed on top) is landed too.
      if (base !== null && await this.baseContains(base, head)) return { landed: true, inbox: null };
    }
    return this.withSerial(async () => {
      await this.takeLock(null);
      try {
        return await this.landEntry();
      } finally {
        if (this.serial === null) await this.releaseLock();
      }
    });
  }

  private async landEntry(): Promise<{ landed: boolean; inbox: InboxItem | null }> {
    const l = this.ledger;
    const head = l.integration.head;
    const mode = l.config.land;
    const req: LandRequest = { toplevel: l.repo.toplevel, baseBranch: l.repo.baseBranch, candidate: head, integrationBranch: l.integration.branch };
    const live = await this.openEntry("serial", { kind: "land", phaseId: null, taskIds: [], slot: null, baseHead: head, candidate: head },
      "land", { v: 1, mode, toplevel: req.toplevel, baseBranch: req.baseBranch });
    const finish = async (result: IntegrationStepResult, detail: StepDetail, inbox: { kind: InboxKind; severity: InboxItem["severity"]; text: string } | null,
      outcome: string): Promise<{ landed: boolean; inbox: InboxItem | null }> => {
      const now = this.d.clock.iso();
      const before = this.ledger.inbox.length;
      const next = await this.end(live, result, detail, true, [], lg => [
        ...(inbox === null ? [] : [this.inboxEvent(lg, inbox.kind, inbox.severity, null, inbox.text, now)]),
        counterEvent("integration.land", 1, { mode, outcome })]);
      const items = this.newInbox(next, before);
      this.notifyInbox(items);
      return { landed: result === "ok", inbox: items[0] ?? null };
    };
    let tip: string | null;
    try {
      tip = await this.branchTip();
    } catch (e) {
      // QA-3.2-9: git could not run (infrastructure), never "moved"; the entry ends refused and land() can be retried.
      return finish("refused", { v: 1, reason: "error", message: clipText(message(e), 1000) }, { kind: "landing", severity: "blocking",
        text: `Landing ${head} on ${req.baseBranch} stopped: ${clipText(message(e), 500)}. Nothing was landed; retry land() once git runs again.` }, "error");
    }
    if (tip !== head) {
      return finish("refused", { v: 1, reason: "integration-branch-moved" }, { kind: "failure", severity: "critical",
        text: `The integration branch ${l.integration.branch} is at ${tip ?? "(missing)"}, not at the journaled head ${head}; nothing was landed.` }, "branch-moved");
    }
    const ff = `git -C "${req.toplevel}" merge --ff-only ${head}`;
    if (mode === "manual") {
      return finish("refused", { v: 1, reason: "manual" }, { kind: "landing", severity: "info",
        text: `Plan ${this.d.planId} is complete; the integration branch ${l.integration.branch} is at ${head}. To land it on ${req.baseBranch}:\n${ff}` }, "manual");
    }
    const refusal = (r: LandRefusal): Promise<{ landed: boolean; inbox: InboxItem | null }> => {
      let commands: string[] = [];
      try {
        commands = this.d.lander.commands(req, r);
      } catch (e) {
        this.d.logger.warn(`integration queue: lander.commands threw: ${message(e)}`);
      }
      return finish("refused", { v: 1, refusal: r }, { kind: "landing", severity: "blocking",
        text: `Landing ${head} on ${req.baseBranch} in ${req.toplevel} was refused (${r.reason}).${commands.length > 0 ? `\n${commands.join("\n")}` : ""}` }, r.reason);
    };
    let inspection: LandInspection;
    try {
      inspection = await this.d.lander.inspect(req);
    } catch (e) {
      return finish("refused", { v: 1, reason: "error", message: clipText(message(e), 1000) }, { kind: "landing", severity: "blocking",
        text: `Landing ${head} failed: ${clipText(message(e), 500)}` }, "error");
    }
    if (!inspection.ok) return refusal(inspection.refusal);
    let o: LandOutcome;
    try {
      o = await this.d.lander.fastForward(req);
    } catch (e) {
      o = { kind: "error", message: message(e) };
    }
    if (o.kind === "landed") return finish("ok", { v: 1, from: o.from, to: o.to }, null, "landed");
    if (o.kind === "refused") return refusal(o.refusal);
    return finish("refused", { v: 1, reason: "error", message: clipText(o.message, 1000) }, { kind: "landing", severity: "blocking",
      text: `Landing ${head} on ${req.baseBranch} failed: ${clipText(o.message, 500)}\n${ff}` }, "error");
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.8 resume (A1-3, A2-5, M31) and the shared rollback (M36)
  // -------------------------------------------------------------------------------------------------------------

  private liveFor(o: OpenIntegrationEntry): LiveEntry {
    for (const c of [this.serial, this.background, ...this.stalled.values()]) {
      if (c !== null && c.entry.id === o.entry.id) {
        c.open = o.edge === "start" ? o.step : null;
        return c;
      }
    }
    const live: LiveEntry = { entry: { ...o.entry, taskIds: [...o.entry.taskIds] }, startSeq: o.startSeq,
      open: o.edge === "start" ? o.step : null, openedAt: this.d.clock.now(), lane: o.entry.kind === "phase-suite" ? "background" : "serial" };
    if (live.lane === "serial") this.serial = live;
    else this.background = live;
    return live;
  }

  /** §4.8 step 1: normalize to a started rollback step, run the rollback git, close with ISE(rollback, rolled-back). */
  private async rollbackEntry(o: OpenIntegrationEntry, reason: "resume" | "abort" | "stalled"): Promise<LiveEntry> {
    const live = this.liveFor(o);
    if (!(o.step === "rollback" && o.edge === "start")) {
      const entry = live.entry;
      if (o.edge === "start") {
        const step = o.step;
        await this.append(() => [ise(entry, step, "rolled-back", { v: 1, reason }, false), iss(entry, "rollback", { v: 1, of: step, reason })]);
        live.open = "rollback";
        live.openedAt = this.d.clock.now();
      } else {
        await this.start(live, "rollback", { v: 1, of: o.step === "rollback" ? null : o.step, reason });
      }
    }
    const reset = await this.rollbackGit(live.entry);
    await this.end(live, "rolled-back", { v: 1, reset }, true);
    return live;
  }

  /** The §4.8 table's rollback git: none for tag, land and phase-suite. Returns the commit the slot was reset to. */
  private async rollbackGit(entry: IntegrationEntry): Promise<string | null> {
    if (entry.kind === "task" || entry.kind === "batch") {
      if (entry.slot === null) return null;
      // QA-3.2-21: the slot is reset to the tip of the task that owns it (the latest `entry.slot` may belong to a sub-batch's
      // last task, not the batch's). A slot no task of the entry owns any more was released: it is not ours to touch.
      const slot = entry.slot;
      const owner = entry.taskIds.find(id => this.ledger.tasks[id]?.slot === slot);
      if (owner === undefined) return null;
      const lease = await this.slotLease(slot, entry.id).catch(() => null);
      if (lease === null) return null;
      await this.guardWrite(null, lease.path, "slot");
      await this.d.git.rebaseAbort(lease.path).catch(() => undefined);
      const tip = await this.taskTip(owner).catch(() => null);
      if (tip !== null) await this.d.pool.reset(slot, tip);
      return tip;
    }
    if (entry.kind === "revert") {
      const l = this.ledger;
      const lease = await this.integrationSlot();
      await this.guardWrite(null, l.integration.worktree, "integration");
      await this.d.igit.revertAbort(l.integration.worktree).catch(() => undefined);
      await this.d.pool.reset(lease.slot, l.integration.head);
      return l.integration.head;
    }
    return null;
  }

  /** §4.8 table, "after the fsync": requeue (task/batch), journal the revert rerun, or collect the phase for checkPhase. */
  private async followUp(live: LiveEntry, report: ResumeReport | null, phases: Set<PhaseId>): Promise<void> {
    const e = live.entry;
    if (e.kind === "task" || e.kind === "batch") {
      const ids = e.taskIds.filter(id => this.ledger.tasks[id]?.state === "integrating");
      if (ids.length > 0) {
        this.requeued.push({ taskIds: ids, phaseId: e.phaseId, startSeq: live.startSeq });
        this.requeued.sort((a, b) => a.startSeq - b.startSeq);
      }
      report?.rolledBack.push(...ids);
      report?.entries.push({ id: e.id, kind: e.kind, action: "rolled-back" });
      return;
    }
    if (e.kind === "revert" && e.phaseId !== null) {
      const steps = await this.loadSteps();
      let first: IntegrationStepEvent | null = null;
      for (const ev of steps) if (ev.entry.id === e.id && ev.step === "revert-build" && ev.edge === "start") { first = ev; break; }
      const d = parseDetail(first?.detail);
      const c = d?.culprit as Partial<RangeDetail> | undefined;
      const taskId = e.taskIds[0];
      const fallback = taskId === undefined ? null : this.ledger.tasks[taskId]?.integrated ?? null;
      const culprit: TaskRange | null = c !== undefined && typeof c.taskId === "string" && typeof c.from === "string" && typeof c.to === "string"
        ? { taskId: c.taskId, from: c.from, to: c.to }
        : taskId !== undefined && fallback !== null ? { taskId, from: fallback.from, to: fallback.to } : null;
      if (culprit === null) {
        report?.entries.push({ id: e.id, kind: e.kind, action: "rolled-back" });
        return;
      }
      const suiteCommit = typeof d?.suiteCommit === "string" ? d.suiteCommit : e.baseHead;
      const files = Array.isArray(d?.files) ? (d.files as unknown[]).filter((f): f is string => typeof f === "string") : [];
      const ids = [...(first?.failingIds ?? [])];
      const resolved = await this.d.suite.resolve(this.ledger, e.phaseId, suiteCommit).catch(() => null);
      const head = this.ledger.integration.head;
      // Journal the rerun now; its git runs only while running (M31).
      const rerun = await this.openEntry("serial",
        { kind: "revert", phaseId: e.phaseId, taskIds: [culprit.taskId], slot: "integration", baseHead: head, candidate: null },
        "revert-build", { v: 1, culprit, suiteCommit, head, files }, NONE, ids);
      this.reverts.unshift({ phaseId: e.phaseId, culprit, suiteCommit, ids, files,
        commands: resolved !== null && resolved.kind === "runs" ? resolved.commands : [], rerun });
      report?.entries.push({ id: e.id, kind: e.kind, action: "rerun" });
      return;
    }
    if (e.kind === "phase-suite" && e.phaseId !== null) {
      phases.add(e.phaseId);
      const l = this.ledger;
      const started = l.status === "running" && !phasePaused(l, e.phaseId);
      report?.entries.push({ id: e.id, kind: e.kind, action: started ? "rerun" : "rolled-back" });
      return;
    }
    // QA-3.2-15: a tag entry rolled back (stalled poll) comes due again through checkPhase (gate passed, no tag).
    if (e.kind === "tag" && e.phaseId !== null) phases.add(e.phaseId);
    report?.entries.push({ id: e.id, kind: e.kind, action: "none" });
  }

  /** §4.8 step 0 (b): complete a fast-forward that landed with the row-30 or row-34 batch. */
  private async completeOpen(o: OpenIntegrationEntry, report: ResumeReport): Promise<void> {
    const steps = await this.loadSteps();
    const live = this.liveFor(o);
    const head = this.ledger.integration.head;
    const tip = o.entry.candidate ?? head;
    const d = latestStartDetail(steps, o.entry.id) as Record<string, unknown> | null;
    if (o.step === "fast-forward") {
      const raw = Array.isArray(d?.ranges) ? d.ranges as unknown[] : [];
      const ranges: RangeDetail[] = [];
      for (const r of raw) {
        const x = r as Partial<RangeDetail> | null;
        if (x !== null && typeof x.taskId === "string" && typeof x.from === "string" && typeof x.to === "string") ranges.push({ taskId: x.taskId, from: x.from, to: x.to });
      }
      await this.completeIntegrated(live, head, tip, ranges);
      report.completed.push(...ranges.map(r => r.taskId));
    } else {
      const c = d?.culprit as Partial<RangeDetail> | undefined;
      const taskId = typeof c?.taskId === "string" ? c.taskId : o.entry.taskIds[0] ?? "";
      const culprit: TaskRange = { taskId, from: typeof c?.from === "string" ? c.from : "", to: typeof c?.to === "string" ? c.to : "" };
      const suiteCommit = typeof d?.suiteCommit === "string" ? d.suiteCommit : o.entry.baseHead;
      let ids: string[] = [];
      for (let i = steps.length - 1; i >= 0; i--) {
        const ev = steps[i];
        if (ev !== undefined && ev.entry.id === o.entry.id && ev.edge === "start") { ids = [...ev.failingIds]; break; }
      }
      if (o.entry.phaseId === null) throw new ExecutorError("E_INVALID_INPUT", "revert entry without a phase", { entry: o.entry.id });
      await this.completeReverted(live, o.entry.phaseId, tip, culprit, suiteCommit, ids);
      report.completed.push(taskId);
    }
    report.entries.push({ id: o.entry.id, kind: o.entry.kind, action: "completed" });
  }

  private async resumeTag(o: OpenIntegrationEntry, report: ResumeReport): Promise<void> {
    const live = this.liveFor(o);
    const p = o.entry.phaseId;
    if (p === null || o.step === "rollback") {
      const r = await this.rollbackEntry(o, "resume");
      report.entries.push({ id: r.entry.id, kind: r.entry.kind, action: "none" });
      return;
    }
    const d = latestStartDetail(await this.loadSteps(), o.entry.id) as Record<string, unknown> | null;
    const name = typeof d?.name === "string" ? d.name : this.d.lander.tagName(this.d.planId, p);
    const commit = o.entry.candidate ?? o.entry.baseHead;
    if (live.open !== null && live.open !== "tag") await this.end(live, "rolled-back", { v: 1, reason: "resume" }, false);
    const action = await this.finishTag(live, p, name, commit);
    report.entries.push({ id: o.entry.id, kind: o.entry.kind, action: action === "tagged" ? "tagged" : "none" });
  }

  private async resumeLand(o: OpenIntegrationEntry, report: ResumeReport): Promise<boolean> {
    const live = this.liveFor(o);
    const l = this.ledger;
    const candidate = o.entry.candidate ?? o.entry.baseHead;
    const base = await this.d.igit.readRef(l.repo.toplevel, `refs/heads/${l.repo.baseBranch}`).catch(() => null);
    if (live.open !== null && live.open !== "land") await this.end(live, "rolled-back", { v: 1, reason: "resume" }, false);
    if (live.open === null) await this.start(live, "land", { v: 1, mode: l.config.land, toplevel: l.repo.toplevel, baseBranch: l.repo.baseBranch });
    // QA-3.2-35: landed when the base branch is at the candidate or already contains it (owner commits on top), the same
    // rule as land.ts's no-op inspection.
    if (base !== null && await this.baseContains(base, candidate)) {
      // One no-op convention with land.ts: from = to = the candidate (every landed outcome's `to` is the candidate).
      await this.end(live, "ok", { v: 1, from: candidate, to: candidate }, true, [], () => [counterEvent("integration.land", 1, { mode: l.config.land, outcome: "landed" })]);
      report.entries.push({ id: o.entry.id, kind: o.entry.kind, action: "completed" });
      return false;
    }
    await this.end(live, "rolled-back", { v: 1, reason: "resume" }, true);
    report.entries.push({ id: o.entry.id, kind: o.entry.kind, action: "rerun" });
    return true;
  }

  /** QA-3.2-35: the base tip is the candidate or a descendant of it (read-only; a git failure counts as "not landed"). */
  private async baseContains(base: string, candidate: string): Promise<boolean> {
    if (base === candidate) return true;
    return this.d.igit.isAncestor(this.ledger.repo.toplevel, candidate, base).catch(() => false);
  }

  /** §4.8 step 0 (c): [status-changed running->paused (only if running), IA critical]; halted, without the latch. */
  private async resumeHalt(report: ResumeReport, reason: string, text: string): Promise<void> {
    const now = this.d.clock.iso();
    const before = this.ledger.inbox.length;
    const next = await this.append(l => [...this.pauseEvents(l, reason),
      this.inboxEvent(l, "failure", "critical", null, text, now),
      counterEvent("integration.resume", 1, { action: "halted" })]);
    this.notifyInbox(this.newInbox(next, before));
    report.halted = true;
  }

  private async doResume(): Promise<ResumeReport> {
    const report: ResumeReport = { completed: [], rolledBack: [], halted: false, entries: [] };
    const l0 = this.ledger;
    if (l0.status === "aborted") return report;
    if (l0.status !== "running" && l0.status !== "paused" && l0.status !== "completed") {
      throw new ExecutorError("E_PLAN_STATE", "resume needs a running, paused or completed plan", { planId: this.d.planId, status: l0.status });
    }
    let landAgain = false;
    const phases = new Set<PhaseId>();
    const halted = await this.withSerial(async () => {
      try {
        await this.takeLock(null);
      } catch (e) {
        // QA-3.2-33: the lock could not be taken; takeLock already paused with an item. Halted without the latch.
        if (!(e instanceof LaneStop)) throw e;
        report.halted = true;
        return true;
      }
      this.holdLock = true;
      try {
        // Step 0: reconcile the branch tip with integration.head.
        const head = this.ledger.integration.head;
        const ref = `refs/heads/${this.ledger.integration.branch}`;
        const read = await this.readRefRetry(ref);
        if (read.kind === "infra") {
          // QA-3.2-9: git could not run; infrastructure, never "moved". Halted without the latch: a later resume() retries.
          await this.resumeHalt(report, "integration-infrastructure",
            `resume() could not read ${ref} in ${this.ledger.repo.toplevel} ${CHECK_TRIES} times (${clipText(read.message, 500)}); this is an infrastructure failure, the branch was not judged. Integration is halted; nothing was changed. Fix git access, unpause and resume.`);
          return true;
        }
        const tip = read.at;
        if (tip === null) {
          await this.resumeHalt(report, "integration-branch-missing",
            `The integration branch ref ${ref} does not exist in ${this.ledger.repo.toplevel} (journaled head ${head}). The plan's compile/start step (5.1) must create the integration branch and its integration worktree slot before integration can run. Integration is halted; nothing was changed.`);
          return true;
        }
        if (tip !== head) {
          let ahead: boolean;
          try {
            ahead = await this.d.igit.isAncestor(this.ledger.repo.toplevel, head, tip);
          } catch (e) {
            // Nit: a git failure is infrastructure, never "moved".
            await this.resumeHalt(report, "integration-infrastructure",
              `resume() could not compare ${head} with the branch tip ${tip} (${clipText(message(e), 500)}); this is an infrastructure failure, the branch was not judged. Integration is halted; nothing was changed. Fix git access, unpause and resume.`);
            return true;
          }
          const o = ahead
            ? this.d.writer.openIntegration().find(x => (x.step === "fast-forward" || x.step === "revert-fast-forward") && x.edge === "start" && x.entry.candidate === tip)
            : undefined;
          if (o === undefined) {
            await this.resumeHalt(report, "integration-branch-moved",
              `The integration branch ${this.ledger.integration.branch} is at ${tip}, not at the journaled head ${head}, and no journaled fast-forward explains it. Integration is halted; nothing was changed.`);
            return true;
          }
          await this.completeOpen(o, report);
        }
        // Step 1: open entries, oldest first.
        const opens = [...this.d.writer.openIntegration()].sort((a, b) => a.startSeq - b.startSeq);
        for (const o of opens) {
          if (this.reverts.some(r => r.rerun?.entry.id === o.entry.id)) continue;
          try {
            if (o.entry.kind === "tag") {
              await this.resumeTag(o, report);
            } else if (o.entry.kind === "land") {
              landAgain = await this.resumeLand(o, report) || landAgain;
            } else {
              const live = await this.rollbackEntry(o, "resume");
              await this.followUp(live, report, phases);
            }
          } catch (e) {
            if (!(e instanceof LaneStop)) throw e;
            report.entries.push({ id: o.entry.id, kind: o.entry.kind, action: "none" });
            // QA-3.2-28: after a lost-lock halt no later entry is rolled back without the lock: stop, halted, no latch.
            if (this.lockLost) {
              report.halted = true;
              return true;
            }
          }
        }
        // Step 2: orphans (integrating, in no open entry, exempt), after the step-1 requeues, in plan order.
        const queuedIds = new Set(this.requeued.flatMap(g => g.taskIds));
        for (const t of Object.values(this.ledger.tasks)) {
          if (t.state !== "integrating" || queuedIds.has(t.id)) continue;
          this.requeued.push({ taskIds: [t.id], phaseId: t.phase, startSeq: Number.MAX_SAFE_INTEGER });
          report.rolledBack.push(t.id);
        }
        // Step 3: phases to check.
        const l = this.ledger;
        for (const ph of l.phases) {
          if ((ph.gate === "pending" && phaseIntegrated(l, ph.id)) || ph.gate === "suite-running" || ph.gate === "suite-failed"
            || (ph.gate === "passed" && ph.tag === null)) phases.add(ph.id);
        }
        for (const entry of report.entries) this.counters.push(counterEvent("integration.resume", 1, { action: entry.action }));
        return false;
      } finally {
        this.holdLock = false;
        await this.releaseLock();
      }
    });
    if (halted) return report;
    for (const p of phases) await this.checkPhaseSafe(p);
    // Step 4: latch, kick, pending land.
    this.resumed = true;
    this.report = report;
    this.kick();
    const l = this.ledger;
    if (landAgain && l.status === "completed" && l.config.land === "ff-when-clean") {
      void this.land().catch((e: unknown) => this.d.logger.warn(`integration queue: land after resume failed: ${message(e)}`));
    }
    return report;
  }

  // -------------------------------------------------------------------------------------------------------------
  // 4.9 abort
  // -------------------------------------------------------------------------------------------------------------

  private async doAbort(): Promise<void> {
    this.aborting = true;
    // QA-3.2-34: queued work behind an infrastructure pause would otherwise keep the 5 s poll armed forever.
    this.pausedWork = false;
    this.clearStalled();
    this.ctl.abort();
    this.bgCtl.abort();
    await Promise.allSettled([this.serialLoopP, this.backgroundLoopP]);
    if (this.disposed) return;
    await this.withSerial(async () => {
      await this.takeLock(null);
      this.holdLock = true;
      try {
        const l = this.ledger;
        const head = l.integration.head;
        const opens = [...this.d.writer.openIntegration()].sort((a, b) => a.startSeq - b.startSeq);
        const lives = opens.map(o => this.liveFor(o));
        const inEntries = new Set(opens.flatMap(o => o.entry.taskIds));
        const orphans = Object.values(l.tasks).filter(t => t.state === "integrating" && !inEntries.has(t.id));
        const synth: LiveEntry[] = [];
        // Batch A: per entry [ISE(open step, rolled-back)] if a step is started, then ISS(rollback); synthetic task entries for orphans.
        await this.append(lg => {
          const out: ExecutorEventInput[] = [];
          synth.length = 0;
          opens.forEach((o, i) => {
            const live = lives[i];
            if (live === undefined || (o.step === "rollback" && o.edge === "start")) return;
            if (o.edge === "start") out.push(ise(live.entry, o.step, "rolled-back", { v: 1, reason: "abort" }, false));
            out.push(iss(live.entry, "rollback", { v: 1, of: o.step === "rollback" ? null : o.step, reason: "abort" }));
          });
          for (const t of orphans) {
            const entry: IntegrationEntry = { id: entryIdAt(lg, out.length), kind: "task", phaseId: t.phase, taskIds: [t.id], slot: t.slot,
              baseHead: head, candidate: null };
            synth.push({ entry, startSeq: lg.seq + 1 + out.length, open: "rollback", openedAt: 0, lane: "serial" });
            out.push(iss(entry, "rollback", { v: 1, of: null, reason: "abort" }));
          }
          return out;
        });
        for (const live of lives) live.open = "rollback";
        const all = [...lives, ...synth];
        const resets = new Map<string, string | null>();
        for (const live of all) {
          // QA-3.2-28: after a lost-lock halt no further rollback git runs; the entries stay open (rollback started) for
          // the next writer's resume(), and abort() rejects (A1-8: the runtime logs it).
          if (this.lockLost) throw new LaneStop("repo lock lost during abort");
          try {
            resets.set(live.entry.id, await this.rollbackGit(live.entry));
          } catch (e) {
            this.d.logger.warn(`integration queue: rollback of ${live.entry.id} failed: ${message(e)}`);
            resets.set(live.entry.id, null);
          }
        }
        // Batch B, the row-33 batch: per entry [ISE(rollback, rolled-back, closes)], per still-integrating task [TT ->cancelled, TS(null)].
        const released: Array<{ id: TaskId; slot: string | null }> = [];
        await this.append(lg => {
          const out: ExecutorEventInput[] = [];
          released.length = 0;
          for (const live of all) {
            out.push(ise(live.entry, "rollback", "rolled-back", { v: 1, reset: resets.get(live.entry.id) ?? null }, true));
            for (const id of live.entry.taskIds) {
              const t = lg.tasks[id];
              if (t === undefined || t.state !== "integrating" || released.some(r => r.id === id)) continue;
              out.push(...this.tt(lg, id, "cancelled", "abort"));
              out.push({ type: "task-slot", taskId: id, slot: null, branch: t.branch });
              released.push({ id, slot: t.slot });
            }
          }
          return out;
        });
        for (const live of all) live.open = null;
        this.serial = null;
        this.background = null;
        this.fifo.length = 0;
        this.requeued.length = 0;
        this.reverts.length = 0;
        this.tags.length = 0;
        this.suites.length = 0;
        for (const r of released) {
          if (r.slot !== null) await this.d.pool.release(r.slot).catch((e: unknown) => this.d.logger.warn(`integration queue: slot release failed: ${message(e)}`));
          this.d.leases.releaseTask(r.id);
        }
      } finally {
        this.holdLock = false;
        await this.releaseLock();
      }
    });
  }

  private holdLock = false;

  private dropQueued(id: TaskId): void {
    const i = this.fifo.indexOf(id);
    if (i >= 0) this.fifo.splice(i, 1);
  }

  private async checkPhaseSafe(p: PhaseId): Promise<void> {
    try {
      await this.checkPhase(p);
    } catch (e) {
      this.laneError(e);
    }
  }
}

/** M1: entry id of the entry whose first ISS is the k-th (0-based) event of the next batch. */
export function entryIdAt(l: Readonly<LedgerV1>, k: number): string {
  return "i-" + String(l.seq + 1 + k);
}

/**
 * M20 (working reading of §3.3): every non-qa task of the phase is integrated, done or cancelled. A phase with no non-qa
 * task waits for the phases it depends on (QA-3.2-19); `path` guards dependency cycles.
 */
export function phaseIntegrated(l: Readonly<LedgerV1>, p: PhaseId, path: readonly PhaseId[] = []): boolean {
  let any = false;
  for (const t of Object.values(l.tasks)) {
    if (t.phase !== p || t.kind === "qa") continue;
    any = true;
    if (t.state !== "integrated" && t.state !== "done" && t.state !== "cancelled") return false;
  }
  if (any) return true;
  // QA-3.2-19: a phase with no non-qa task of its own is integrated only once every phase it depends on is (cycle-safe).
  const ph = l.phases.find(x => x.id === p);
  if (ph === undefined || path.includes(p)) return false;
  return ph.dependsOn.every(dep => phaseIntegrated(l, dep, [...path, p]));
}

/** QA-3.2-31: the phases that depend on any of `ps`, transitively (each once, in plan order), excluding `ps` themselves. */
export function dependentPhases(l: Readonly<LedgerV1>, ps: Iterable<PhaseId>): PhaseId[] {
  const seen = new Set<PhaseId>(ps);
  const out: PhaseId[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const ph of l.phases) {
      if (seen.has(ph.id) || !ph.dependsOn.some(d => seen.has(d))) continue;
      seen.add(ph.id);
      out.push(ph.id);
      grew = true;
    }
  }
  return out;
}

/** True when phase `p` has at least one non-qa task of its own (a suite has something to attribute). */
export function phaseHasOwnTasks(l: Readonly<LedgerV1>, p: PhaseId): boolean {
  return Object.values(l.tasks).some(t => t.phase === p && t.kind !== "qa");
}

function phasePaused(l: Readonly<LedgerV1>, p: PhaseId | null): boolean {
  if (p === null) return false;
  return l.phases.find(ph => ph.id === p)?.paused === true;
}

/** A task the serial lane may dequeue: still `verified`, and its phase is not paused (A1-8 gates dequeue only). */
function dequeueable(l: Readonly<LedgerV1>, id: TaskId): boolean {
  const t = l.tasks[id];
  return t !== undefined && t.state === "verified" && t.branch !== null && !phasePaused(l, t.phase);
}

/**
 * M16 + A1-8: the first dequeueable task, plus (only when 2+ tasks are dequeueable) the following dequeueable tasks
 * of the same phase, in queue order, up to `batchMax`. `batchMax = 1` disables batching. Never waits for a batch to fill.
 */
export function pickBatch(l: Readonly<LedgerV1>, queue: readonly TaskId[], batchMax: number): TaskId[] {
  const ready = queue.filter(id => dequeueable(l, id));
  const first = ready[0];
  if (first === undefined) return [];
  const max = Math.max(1, Math.floor(batchMax));
  if (ready.length < 2 || max === 1) return [first];
  const phase = l.tasks[first]?.phase ?? null;
  const out: TaskId[] = [];
  for (const id of ready) {
    if (out.length >= max) break;
    if ((l.tasks[id]?.phase ?? null) === phase) out.push(id);
  }
  return out;
}

/** M23: `baseHead` of the earliest task or batch entry of the phase in history; null if there is none. */
export function phaseBase(steps: readonly IntegrationStepEvent[], p: PhaseId): string | null {
  let best: { seq: number; base: string } | null = null;
  for (const ev of steps) {
    const e = ev.entry;
    if (ev.edge !== "start" || e.phaseId !== p || (e.kind !== "task" && e.kind !== "batch")) continue;
    if (best === null || ev.seq < best.seq) best = { seq: ev.seq, base: e.baseHead };
  }
  return best?.base ?? null;
}

/** M19: the parsed detail of the latest start edge of `entryId`, or null. */
export function latestStartDetail(steps: readonly IntegrationStepEvent[], entryId: string): StepDetail | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const ev = steps[i];
    if (ev === undefined || ev.entry.id !== entryId || ev.edge !== "start") continue;
    const parsed = parseDetail(ev.detail);
    return parsed === null ? null : parsed as unknown as StepDetail;
  }
  return null;
}

