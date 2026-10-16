// pdf2-1 (a) budget resume and (b) no lost work: runtime resume, WIP snapshot and restore (real git).
import { afterEach, describe, expect, it, vi } from "vitest";
// QA-PDF21 round-1 regressions live in the "QA-PDF21 snapshot safety" describe block (after the rig and `seedWip`).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import {
  RESUME_PROMPT, classifyChildText, createExecutorRuntime, realCollaborators,
  type CollaboratorInput, type ExecutorRuntimeHandle, type PlanCollaborators, type RuntimeDeps,
} from "../../src/executor/runtime";
import { orphanRefName, restoreSlotWork, snapshotSlotWork, taskBranchName, wipRefName, wipTrailer } from "../../src/executor/git";
import { createLedgerStore, createNodeClock } from "../../src/executor/ledger";
import { createCapacityController } from "../../src/executor/capacity";
import { createScheduler } from "../../src/executor/schedule";
import {
  BUDGET_RESUMES, ExecutorError, WIP_TRAILER,
  TRANSITION_TRIGGERS,
  type ChildEnd, type ExecutorEventInput, type ExpandInput, type GitRunner, type IntegrationQueue, type LaunchConfirmation, type LaunchHooks,
  type InboxItem, type LaunchRequest, type LedgerV1, type ProcessResult, type SlotPool,
} from "../../src/executor/types";
import { buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import { parkItemOf, runningParkTrigger } from "../../src/executor/unattended";

const expansion = vi.hoisted(() => ({
  calls: [] as Array<{ taskId: string; attempt: number; restored: { attempt: number; files: number } | null }>,
  /** QA-PDF21-13: runs inside a launch step after its restore and before its attempt-started batch. */
  beforeEnv: null as (() => Promise<void>) | null,
}));

vi.mock("../../src/executor/expand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/executor/expand")>();
  return {
    ...actual,
    loadExpansionEnv: async () => {
      const hook = expansion.beforeEnv;
      if (hook !== null) await hook();
      return { worktrees: [], longPaths: true };
    },
    expandTask: (i: ExpandInput) => {
      expansion.calls.push({ taskId: i.taskId, attempt: i.attempt, restored: i.restored ?? null });
      const out = { prompt: `TASK ${i.taskId} attempt ${i.attempt} nonce ${i.nonce}`, routeLine: "[route needs=edit,shell]", workRoot: i.slot.path };
      return out as ReturnType<typeof actual.expandTask>;
    },
  };
});

/** Per-test bound: a hang fails the test instead of the run. */
const TEST_MS = 30_000;
/** Bound of each wait on an observed condition. */
const WAIT_MS = 10_000;

/** Fails with `what` when `pr` does not settle within `ms`. */
async function bounded<T>(what: string, pr: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pr,
      new Promise<never>((_res, rej) => { timer = setTimeout(() => { rej(new Error(`${what} did not settle within ${ms} ms`)); }, ms); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const runtimes: ExecutorRuntimeHandle[] = [];
const roots: string[] = [];
afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0).reverse()) await bounded("runtime.dispose", runtime.dispose(), 15_000);
  } finally {
    vi.restoreAllMocks();
    expansion.calls.length = 0;
    expansion.beforeEnv = null;
    for (const root of roots.splice(0)) await bounded(`removing ${root}`, removeDirWhenReleased(root), 15_000);
  }
}, 40_000);

// ---------------------------------------------------------------------------------------------------------------
// real git
// ---------------------------------------------------------------------------------------------------------------

function runGit(args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile("git", [...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const raw: unknown = err === null ? 0 : (err as { code?: unknown }).code;
        resolve({ code: typeof raw === "number" ? raw : 1, signal: null, stdout: String(stdout), stderr: String(stderr), truncated: false, durationMs: 0 });
      });
  });
}

const git: GitRunner = { run: (args, o) => runGit(args, o.cwd) };

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

interface Repo { root: string; top: string; slot: string; base: string }

async function repo(): Promise<Repo> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omr-runtime-resume-")));
  roots.push(root);
  const top = join(root, "repo");
  await mkdir(top);
  await sh(top, "init", "-q");
  for (const [k, v] of [["user.name", "Resume Test"], ["user.email", "resume@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]] as const) {
    await sh(top, "config", k, v);
  }
  await writeFile(join(top, "a.txt"), "base\n");
  await sh(top, "add", "-A");
  await sh(top, "commit", "-q", "-m", "base");
  const base = (await sh(top, "rev-parse", "HEAD")).trim();
  const slot = join(root, "slot-1");
  await sh(top, "worktree", "add", "-q", "--detach", slot, base);
  return { root, top, slot, base };
}

async function refOf(top: string, ref: string): Promise<string | null> {
  const r = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`], top);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function status(slot: string): Promise<string> {
  return (await sh(slot, "status", "--porcelain", "--untracked-files=all")).trim();
}

// ---------------------------------------------------------------------------------------------------------------
// rig: real ledger, scheduler, capacity and policy; doubles for the pool (real git underneath), launcher and queue
// ---------------------------------------------------------------------------------------------------------------

const PLAN = "plan-resume";
const ORCH = "owner-plan-resume";
const CONTEXT = { bootID: "boot-1", epoch: 1, callID: "call-1" };

interface Launch {
  req: LaunchRequest;
  hooks: LaunchHooks;
  /** The completion settled (an end came). */
  settled: boolean;
  /** The confirmation settled. */
  confirmed: boolean;
  childSessionID: string | null;
  end(e: ChildEnd): void;
  confirm(c: LaunchConfirmation): void;
}

function draft(r: Repo, tasks: LedgerV1["tasks"] = {}, edges: LedgerV1["edges"] = []): LedgerV1 {
  const value = buildDraft(0, PLAN);
  value.status = "awaiting-approval";
  value.repo = { ...value.repo, toplevel: r.top, baseCommit: r.base };
  value.integration = { ...value.integration, head: r.base };
  value.orchestrator.sessionID = ORCH;
  value.config = { ...value.config, slotsDir: join(r.root, "slots"), land: "manual", phaseSuite: "off", maxAttempts: 5 };
  value.tasks.T1 = taskNode("T1", {
    phase: "p1", state: "pending",
    footprint: { writes: ["a.txt", "b.txt", "c.txt"], reads: [], confidence: "explicit", sources: ["path"] },
  });
  Object.assign(value.tasks, tasks);
  value.edges = [...value.edges, ...edges];
  return value;
}

interface RigOptions {
  clock?: RuntimeDeps["clock"];
  seed?: (r: Repo) => Promise<void>;
  foreignOwner?: boolean;
  /** QA-PDF21: the runtime's git runner (a fault-injecting wrapper of the real one). */
  git?: GitRunner;
  /** QA-PDF21: the verifier's verdicts, in order; "pass" once they run out. */
  verdicts?: Array<"pass" | "fail">;
  /** QA-PDF21: the compiler's addTasks. */
  addTasks?: RuntimeDeps["compiler"]["addTasks"];
  /** Additional tasks and lease holders for learned-dependency regressions. */
  tasks?: LedgerV1["tasks"];
  leaseRegistry?: RuntimeDeps["leaseRegistry"];
  /** QA-PDF21: the launcher reports its unsettled launches as in flight. */
  inFlight?: boolean;
  /** QA-PDF21-19: dependency edges of the draft. */
  edges?: LedgerV1["edges"];
  /**
   * QA-PDF21-12: as the real pool (pool.ts `work`): the owner's own leased slot comes back with its record's commit (the
   * one before any reset the runtime runs next), and `reset` and `get` keep that record's commit.
   */
  recordCommit?: boolean;
}

async function rig(o: RigOptions = {}) {
  const r = await repo();
  if (o.seed !== undefined) await o.seed(r);
  const store = createLedgerStore({ home: join(r.root, "home") });
  const clock = o.clock ?? createNodeClock();
  const launches: Launch[] = [];
  const launcher = { throwNext: null as ExecutorError | null };
  let owner: string | null = null;
  /** QA-PDF21-4: the acquires that found the slot ready (unleased) and reset it, as the real pool does. */
  const acquireResets: number[] = [];
  /** QA-PDF21-5: the slot's status when `begin` captured its reference. */
  const begunStatus: string[] = [];
  /** QA-PDF21-12: the commit the slot's record names (`recordCommit`). */
  let recCommit = r.base;
  const pool = {
    acquire: vi.fn<SlotPool["acquire"]>(async (id, who, commit) => {
      // As the real pool (pool.ts acquire): a ready slot is reset to `commit` before it is handed out; the owner's own
      // leased slot comes back as it is.
      const same = owner !== null;
      if (owner === null) {
        await sh(r.slot, "checkout", "-q", "--detach", "--force", commit);
        await sh(r.slot, "clean", "-q", "-ffd");
        acquireResets.push(acquireResets.length + 1);
        recCommit = commit;
      }
      owner = who;
      return { slot: "slot-1", path: r.slot, planId: id, owner: who, commit: o.recordCommit === true && same ? recCommit : commit };
    }),
    acquireSpecial: vi.fn<SlotPool["acquireSpecial"]>(async () => { throw new Error("unexpected special slot"); }),
    reset: vi.fn<SlotPool["reset"]>(async (_slot, commit) => {
      await sh(r.slot, "checkout", "-q", "--detach", "--force", commit);
      await sh(r.slot, "clean", "-q", "-ffd");
      recCommit = commit;
    }),
    noteCommit: vi.fn<SlotPool["noteCommit"]>(async () => {}),
    cleanForChecks: vi.fn<SlotPool["cleanForChecks"]>(async () => ({ drifted: false })),
    release: vi.fn<SlotPool["release"]>(async () => { owner = null; }),
    get: vi.fn<SlotPool["get"]>(async (slot) => slot !== "slot-1" || owner === null ? null : {
      schema: 1, slot: "slot-1", path: r.slot, kind: "task", planId: PLAN, repoKey: "repo", state: "leased",
      owner: o.foreignOwner === true ? "someone-else" : owner, commit: o.recordCommit === true ? recCommit : r.base, managers: [], manifests: {},
      createdAt: clock.iso(), updatedAt: clock.iso(),
    }),
    list: vi.fn<SlotPool["list"]>(async () => []),
    gc: vi.fn<SlotPool["gc"]>(async () => ({ removed: [], reported: [] })),
  } satisfies SlotPool;
  const queue = {
    enqueue: vi.fn<IntegrationQueue["enqueue"]>(() => {}),
    resume: vi.fn<IntegrationQueue["resume"]>(async () => ({ completed: [], rolledBack: [], halted: false, entries: [] })),
    checkPhase: vi.fn<IntegrationQueue["checkPhase"]>(async () => {}),
    land: vi.fn<IntegrationQueue["land"]>(async () => ({ landed: false, inbox: null })),
    abort: vi.fn<IntegrationQueue["abort"]>(async () => {}), queued: () => [], dispose: async () => {},
  };
  const collabs: PlanCollaborators[] = [];
  const writers: Array<CollaboratorInput["writer"]> = [];
  const journal: ExecutorEventInput[] = [];
  const begun: string[] = [];
  const deps: RuntimeDeps = {
    store, executorHome: join(r.root, "home"), slots: pool, slotsFor: () => pool,
    compiler: {
      compile: async () => ({ draft: draft(r, o.tasks, o.edges), summary: { tasks: 1, phases: 1, edges: 0, workMs: 0, criticalPathMs: 0, width: 1, expectedMakespanMs: 0, manual: [], warnings: [] } }),
      mergeResidue: () => { throw new Error("unexpected residue"); }, addTasks: o.addTasks ?? (() => { throw new Error("unexpected addTasks"); }), validate: () => [],
    },
    scheduler: createScheduler(),
    launcher: {
      gate: () => ({ ok: true, context: { ...CONTEXT, sessionID: ORCH, messageID: "msg-1", agent: "orchestrator", capturedAt: "2026-10-13T00:00:00.000Z" }, ageMs: 0 }),
      launch: (req, hooks) => {
        const thrown = launcher.throwNext;
        if (thrown !== null) {
          launcher.throwNext = null;
          throw thrown;
        }
        let end: (e: ChildEnd) => void = () => {};
        let confirm: (c: LaunchConfirmation) => void = () => {};
        const completion = new Promise<ChildEnd>((res) => { end = res; });
        const confirmation = new Promise<LaunchConfirmation>((res) => { confirm = res; });
        // As the real launcher: the confirmation settles once (a later settle is a no-op), the completion once.
        const launch: Launch = {
          req, hooks, settled: false, confirmed: false, childSessionID: req.resume?.childSessionID ?? null,
          end: (e) => { if (!launch.settled) { launch.settled = true; end(e); } },
          confirm: (c) => { if (!launch.confirmed) { launch.confirmed = true; confirm(c); } },
        };
        launches.push(launch);
        return { taskId: req.taskId, attempt: req.attempt, nonce: req.nonce, context: req.context, contextAgeMs: 0, startedAt: clock.iso(), confirmation, completion };
      },
      // As the real launcher: a cancel ends the child as interrupted; dispose settles every open confirmation and child.
      cancel: async (taskId, attempt, reason) => {
        for (const l of launches) {
          if (l.req.taskId !== taskId || l.req.attempt !== attempt || l.settled) continue;
          l.confirm({ kind: "unconfirmed", reason: "superseded", error: null });
          l.end({ kind: "interrupted", childSessionID: l.childSessionID, reason, endedAt: clock.iso() });
        }
      },
      inFlight: () => (o.inFlight === true ? launches.filter((l) => !l.settled).map((l) => ({ taskId: l.req.taskId, attempt: l.req.attempt, childSessionID: l.childSessionID, startedAt: clock.iso() })) : []),
      dispose: async () => {
        for (const l of launches) {
          l.confirm({ kind: "unconfirmed", reason: "threw", error: "disposed" });
          l.end({ kind: "interrupted", childSessionID: l.childSessionID, reason: "dispose", endedAt: clock.iso() });
        }
      },
    },
    routes: { route: () => ({ agent: "implementer", model: { providerID: "test", modelID: "test", variant: null }, provider: "test", heavy: false }) },
    verifier: {
      begin: async (task, slot, attempt) => {
        begun.push(`${task.id}#${attempt.n}`);
        begunStatus.push(await status(slot.path));
      },
      verify: async () => ({ verdict: o.verdicts?.shift() ?? "pass", findings: "", ref: "proof" }),
    },
    git: o.git ?? git,
    hosts: {
      get: async (id) => ({ id, parentID: null }), context: async () => ({ messages: [] }), activity: async () => "inactive",
      interrupt: async () => {}, synthetic: async () => {}, move: async () => {}, onEvent: () => () => {},
    },
    clock, leaseRegistry: o.leaseRegistry ?? { acquireWrite: () => ({ ok: true }), holderOf: () => null, releaseTask: () => {} },
    recovery: null, holder: (sessionID) => holderOf(sessionID, process.pid, hostname()), capacity: createCapacityController,
    collaborators: (input) => {
      writers.push(input.writer);
      // Every event the plan journals, as built (the ledger keeps no transition list).
      const append = input.writer.append.bind(input.writer);
      input.writer.append = (batch) => append(typeof batch === "function"
        ? (l) => { const ev = batch(l); journal.push(...ev); return ev; }
        : (journal.push(...batch), batch));
      const c = realCollaborators({ queue: () => queue, clock, log() {} })(input);
      collabs.push(c);
      return c;
    },
    pinOrchestrator: () => () => {}, log() {}, config: () => draft(r).config, bindings: { bind() {}, evict() {} }, toplevel: r.top,
  };
  const runtime = createExecutorRuntime(deps);
  runtimes.push(runtime);
  // `settled()` also waits for live children, so the rig waits on what it observes instead.
  const ledger = async (): Promise<LedgerV1> => {
    const w = writers[writers.length - 1];
    if (w === undefined) throw new Error("ledger missing");
    return w.ledger;
  };
  const pause = (ms = 30): Promise<void> => new Promise((res) => { setTimeout(res, ms); });
  const h = {
    r, runtime, store, pool, queue, launches, launcher, collabs, begun, ledger, pause, journal, acquireResets, begunStatus, deps,
    async restart(): Promise<ExecutorRuntimeHandle> {
      await runtime.dispose();
      const next = createExecutorRuntime(deps);
      runtimes.push(next);
      return next;
    },
    async start(): Promise<void> {
      await runtime.compile({ path: draft(r).planPath, sessionID: ORCH });
      await runtime.approve(PLAN, ORCH);
    },
    async launched(count: number): Promise<Launch> {
      await vi.waitFor(() => { expect(launches.length).toBeGreaterThanOrEqual(count); }, { timeout: WAIT_MS, interval: 20 });
      await pause();
      const l = launches[count - 1];
      if (l === undefined) throw new Error(`launch ${count} missing`);
      return l;
    },
    async child(l: Launch, id: string): Promise<void> {
      await l.hooks.onChildCreated(id);
      l.confirm({ kind: "confirmed", childSessionID: id, latencyMs: 0 });
      await vi.waitFor(async () => { expect((await ledger()).tasks.T1?.state).toBe("running"); }, { timeout: WAIT_MS, interval: 20 });
    },
    async end(l: Launch, id: string, text: string): Promise<void> {
      l.end({ kind: "completed", childSessionID: id, text, endedAt: clock.iso() });
      await pause();
    },
    async state(): Promise<string> {
      return (await ledger()).tasks.T1?.state ?? "missing";
    },
    /** QA-PDF21-12: moves the plan's integration head (as the queue's `integration-head` event does). */
    async moveHead(head: string): Promise<void> {
      const w = writers[writers.length - 1];
      if (w === undefined) throw new Error("writer missing");
      await w.append([{ type: "integration-head", head }]);
    },
    async answer(text: string): Promise<void> {
      const l = await ledger();
      const item = l.inbox.find((x) => x.taskId === "T1" && x.answer === null);
      if (item === undefined) throw new Error("no open item");
      const c = collabs[collabs.length - 1];
      if (c === undefined) throw new Error("no collaborators");
      await c.policy.answer(item.id, text);
      runtime.onLeaseReleased();
    },
  };
  return h;
}

async function untilState(h: Awaited<ReturnType<typeof rig>>, state: string): Promise<void> {
  await vi.waitFor(async () => { expect(await h.state()).toBe(state); }, { timeout: WAIT_MS, interval: 20 });
  await h.pause();
}

/** A WIP commit of `files` whose parent is `parent`, stored at the task's WIP ref (as a salvage seeds it). */
async function seedWip(r: Repo, parent: string, files: Record<string, string>, n = 1): Promise<string> {
  const scratch = join(r.root, `scratch-${Date.now()}`);
  await sh(r.top, "worktree", "add", "-q", "--detach", scratch, parent);
  for (const [name, text] of Object.entries(files)) await writeFile(join(scratch, name), text);
  await sh(scratch, "add", "-A");
  await sh(scratch, "commit", "-q", "-m", `wip(T1): attempt ${n} seeded`, "-m", wipTrailer(PLAN, "T1", n, "seed-nonce"));
  const commit = (await sh(scratch, "rev-parse", "HEAD")).trim();
  await sh(r.top, "update-ref", `refs/heads/${wipRefName(PLAN, "T1")}`, commit);
  await sh(r.top, "worktree", "remove", "--force", scratch);
  return commit;
}

// ---------------------------------------------------------------------------------------------------------------
// QA-PDF21 round 1: snapshot safety (each test fails without its fix)
// ---------------------------------------------------------------------------------------------------------------

/** A runner over the real git: `fail` makes a matching call fail (code 1) or throw; `spy` sees every call first. */
function faultyGit(
  fail: (args: readonly string[], cwd: string) => "fail" | "throw" | null,
  spy?: (args: readonly string[], cwd: string) => Promise<void>,
): GitRunner {
  return {
    run: async (args, o) => {
      if (spy !== undefined) await spy(args, o.cwd);
      const f = fail(args, o.cwd);
      if (f === "throw") throw new Error(`injected: git ${args[0] ?? ""} could not run`);
      if (f === "fail") return { code: 1, signal: null, stdout: "", stderr: `fatal: injected failure of git ${args[0] ?? ""}`, truncated: false, durationMs: 0 };
      return runGit(args, o.cwd);
    },
  };
}

/** A WIP ref of T1 adding b.txt on the base. */
async function seedB(r: Repo): Promise<void> {
  await seedWip(r, r.base, { "b.txt": "seeded\n" });
}

/** A WIP ref of T1 whose change of a.txt conflicts with the base (test 10's seed). */
async function seedConflict(r: Repo): Promise<void> {
  const scratch = join(r.root, "side");
  await sh(r.top, "worktree", "add", "-q", "--detach", scratch, r.base);
  await writeFile(join(scratch, "a.txt"), "side\n");
  await sh(scratch, "commit", "-q", "-am", "side");
  const side = (await sh(scratch, "rev-parse", "HEAD")).trim();
  await sh(r.top, "worktree", "remove", "--force", scratch);
  await seedWip(r, side, { "a.txt": "wip\n" });
}

/** Leaves an `index.lock` in `slot`'s git dir (a git killed mid-step); returns its path. */
async function lockIndex(slot: string): Promise<string> {
  const rel = (await sh(slot, "rev-parse", "--git-path", "index.lock")).trim();
  const path = isAbsolute(rel) ? rel : join(slot, rel);
  await writeFile(path, "");
  return path;
}

/** A git spy recording T1's ledger slot at each `add -A` (a snapshot's or a commit's first write). */
function slotAtAdd(): { seen: Array<string | null>; ledger: { read: (() => Promise<LedgerV1>) | null }; spy: (args: readonly string[]) => Promise<void> } {
  const seen: Array<string | null> = [];
  const ledger: { read: (() => Promise<LedgerV1>) | null } = { read: null };
  return {
    seen,
    ledger,
    spy: async (args) => {
      const read = ledger.read;
      if (read !== null && args[0] === "add" && args[1] === "-A") seen.push((await read()).tasks.T1?.slot ?? null);
    },
  };
}

describe("QA-PDF21 snapshot safety", () => {
  const trailer = wipTrailer(PLAN, "T1", 1, "qa-nonce");
  const wipRef = wipRefName(PLAN, "T1");
  const until = async (fn: () => void | Promise<void>): Promise<void> => {
    await vi.waitFor(fn, { timeout: WAIT_MS, interval: 20 });
  };

  it("-3. update-ref fails: one retry, then the commit goes to a unique orphan ref and the slot is not reset", async () => {
    const r = await repo();
    await writeFile(join(r.slot, "b.txt"), "unsaved\n");
    let tries = 0;
    const g = faultyGit((args) => {
      if (args[0] !== "update-ref" || !args.includes(`refs/heads/${wipRef}`)) return null;
      tries += 1;
      return "fail";
    });
    const fallback = orphanRefName(PLAN, "slot-1", 5, "n1");
    const error = await snapshotSlotWork(g, { cwd: r.slot, ref: wipRef, message: "wip", trailer, timeoutMs: WAIT_MS, fallbackRef: fallback })
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutorError);
    expect(tries).toBe(2);
    expect(await refOf(r.top, wipRef)).toBeNull();
    const kept = await refOf(r.top, fallback);
    expect(kept).not.toBeNull();
    expect(await sh(r.top, "show", `${kept ?? ""}:b.txt`)).toBe("unsaved\n");
    expect(await readFile(join(r.slot, "b.txt"), "utf8")).toBe("unsaved\n");
  }, TEST_MS);

  it("-3. a leftover index.lock is removed and the failed step retried once", async () => {
    const r = await repo();
    await writeFile(join(r.slot, "b.txt"), "behind a lock\n");
    const lock = await lockIndex(r.slot);
    let removed = 0;
    const s = await snapshotSlotWork(git, {
      cwd: r.slot, ref: wipRef, message: "wip", trailer, timeoutMs: WAIT_MS,
      removeIndexLock: async () => {
        removed += 1;
        await rm(lock, { force: true });
        return true;
      },
    });
    expect(removed).toBe(1);
    expect(s.saved).toBe(true);
    expect(await sh(r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("behind a lock\n");
    expect(await status(r.slot)).toBe("");
  }, TEST_MS);

  it("-6. a snapshot parented at the lease base holds the committed attempt and the uncommitted rest", async () => {
    const r = await repo();
    await writeFile(join(r.slot, "b.txt"), "committed\n");
    await sh(r.slot, "add", "-A");
    await sh(r.slot, "commit", "-q", "-m", "attempt 1");
    await writeFile(join(r.slot, "c.txt"), "uncommitted\n");
    const s = await snapshotSlotWork(git, { cwd: r.slot, ref: wipRef, message: "wip", trailer, timeoutMs: WAIT_MS, base: r.base });
    expect(s.saved).toBe(true);
    expect((await sh(r.top, "rev-parse", `refs/heads/${wipRef}^`)).trim()).toBe(r.base);
    expect(await sh(r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("committed\n");
    expect(await sh(r.top, "show", `refs/heads/${wipRef}:c.txt`)).toBe("uncommitted\n");
  }, TEST_MS);

  it("-10. orphan ref names of one slot in one millisecond differ by their nonce", () => {
    expect(orphanRefName(PLAN, "slot-1", 7, "a1")).toBe(`omr/${PLAN}/orphan/slot-1-7-a1`);
    expect(orphanRefName(PLAN, "slot-1", 7, "a1")).not.toBe(orphanRefName(PLAN, "slot-1", 7, "b2"));
  });

  it("-3. a failed snapshot keeps the slot leased, unreset and unreleased, raises one item naming it, and the relaunch waits", async () => {
    let failAdd = false;
    const h = await rig({ git: faultyGit((args) => (failAdd && args[0] === "add" && args[1] === "-A" ? "fail" : null)) });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "unsaved\n");
    failAdd = true;
    await h.end(first, "ses-1", "ESCALATE: need a decision");
    await untilState(h, "parked");
    await until(async () => { expect((await h.ledger()).inbox.some((x) => x.text.includes("slot slot-1 could not be saved"))).toBe(true); });
    const l = await h.ledger();
    expect(l.tasks.T1?.slot).toBe("slot-1");
    expect(l.inbox.filter((x) => x.text.includes("could not be saved")).map((x) => x.severity)).toEqual(["blocking"]);
    expect(h.pool.release).not.toHaveBeenCalled();
    expect(h.pool.reset).toHaveBeenCalledTimes(1);
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("unsaved\n");
    // The answered task's relaunch cannot save either: no reset, no launch.
    await h.answer("go on");
    await h.pause(500);
    expect(h.launches).toHaveLength(1);
    expect(h.pool.reset).toHaveBeenCalledTimes(1);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("unsaved\n");
    // Once git works again the work is saved first, then the slot is reset and the work restored.
    failAdd = false;
    await h.launched(2);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("unsaved\n");
    expect(await refOf(h.r.top, wipRef)).not.toBeNull();
  }, TEST_MS);

  it("-3. a leftover index.lock in the slot does not cost the parked attempt its work", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "behind a lock\n");
    await lockIndex(h.r.slot);
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("behind a lock\n");
    // G-17: the release follows the save after the parked state (A3), so wait for it as -4 below does.
    await until(() => { expect(h.pool.release).toHaveBeenCalled(); });
  }, TEST_MS);

  it("-4. the pool's acquire resets a ready slot, and the released attempt's work still comes back", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "kept\n");
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    // G-17: the release follows the parked state by design: the ledger batch that writes TS(null) lands first, then
    // `releaseResources` saves the slot's work with git and only then gives the slot back (A3, QA-PDF21-4). On a slow
    // runner that git save outlasts the fixed pause after "parked", so wait for the release itself (still exactly one).
    await until(() => { expect(h.pool.release).toHaveBeenCalledTimes(1); });
    await h.answer("go on");
    await h.launched(2);
    expect(h.acquireResets).toHaveLength(2);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("kept\n");
    expect(expansion.calls.at(-1)?.restored).toEqual({ attempt: 1, files: 1 });
  }, TEST_MS);

  it("-4. abort saves a running attempt's work once its cancel settled and keeps the WIP ref; purge deletes it", async () => {
    const h = await rig({ inFlight: true });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "aborted work\n");
    await h.runtime.abort(PLAN, ORCH);
    await until(() => { expect(h.pool.release).toHaveBeenCalled(); });
    expect(first.settled).toBe(true);
    // The collection (its WIP sweep, then the slots' gc) ran and kept the cancelled task's ref.
    await until(() => { expect(h.pool.gc).toHaveBeenCalled(); });
    expect((await h.ledger()).tasks.T1?.state).toBe("cancelled");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("aborted work\n");
    await h.runtime.purge(PLAN, ORCH);
    expect(await refOf(h.r.top, wipRef)).toBeNull();
  }, TEST_MS);

  it("-4. addTasks saves a reopened task's slot before the batch that clears it", async () => {
    const at = slotAtAdd();
    const h = await rig({
      verdicts: ["fail"],
      addTasks: () => ({ tasks: [], edges: [], reopened: ["T1"] }),
      git: faultyGit(() => null, at.spy),
    });
    at.ledger.read = h.ledger;
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "attempt 1\n");
    await h.runtime.pause(PLAN, ORCH);
    await h.end(first, "ses-1", "DONE: finished");
    await untilState(h, "ready");
    expect((await h.ledger()).tasks.T1?.slot).toBe("slot-1");
    at.seen.length = 0;
    await h.runtime.addTasks(PLAN, "more work", ORCH);
    expect(await h.state()).toBe("pending");
    expect(at.seen[0]).toBe("slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("attempt 1\n");
    expect(h.pool.release).toHaveBeenCalled();
  }, TEST_MS);

  it("addTasks refuses the entire fragment when a reopened task holds unsaved work", async () => {
    let failAdd = false;
    const h = await rig({
      verdicts: ["fail"],
      addTasks: () => ({
        tasks: [taskNode("T2", { phase: "p1", state: "pending" })],
        edges: [{ from: "T2", to: "T1", kind: "learned", confidence: "high", evidence: "new prerequisite" }],
        reopened: ["T1"],
      }),
      git: faultyGit((args) => (failAdd && args[0] === "add" && args[1] === "-A" ? "fail" : null)),
    });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "reopened work\n");
    await h.runtime.pause(PLAN, ORCH);
    await h.end(first, "ses-1", "DONE: finished");
    await untilState(h, "ready");
    await bounded("paused runtime settled", h.runtime.settled(), WAIT_MS);
    const before = structuredClone(await h.ledger());
    const journalStart = h.journal.length;
    failAdd = true;
    const refusal: unknown = await h.runtime.addTasks(PLAN, "more work", ORCH).then(() => null, (e: unknown) => e);
    expect(await h.state()).toBe("ready");
    const l = await h.ledger();
    // QA-PDF21-13: the item the refusal points at exists (raised before the refusal); nothing of the fragment is journaled.
    const hold = l.inbox.filter((x) => x.text.includes("slot slot-1 could not be saved"));
    expect(hold.map((x) => x.severity)).toEqual(["blocking"]);
    expect(refusal).toMatchObject({
      code: "E_PLAN_STATE",
      message: "task T1 holds unsaved work in slot slot-1; answer its item first",
      // ExecutorError's structured payload is its `detail` (types.ts ExecutorError); the raised item's id is in it.
      detail: { taskId: "T1", slot: "slot-1", inboxId: hold[0]!.id },
    });
    expect(l.tasks).toEqual(before.tasks);
    expect(l.edges).toEqual(before.edges);
    // Only the item (and its wake and diagnostics): no task, edge or transition of the fragment.
    expect(h.journal.slice(journalStart).filter((e) => e.type !== "inbox-added" && e.type !== "metric" && e.type !== "wake")).toEqual([]);
    expect(l.tasks.T1?.slot).toBe("slot-1");
    expect(h.pool.release).not.toHaveBeenCalled();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("reopened work\n");
    failAdd = false;
    await h.runtime.addTasks(PLAN, "more work", ORCH);
    expect(await h.state()).toBe("pending");
    expect((await h.ledger()).tasks.T1?.slot).toBeNull();
    expect((await h.ledger()).tasks.T2).toBeDefined();
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("reopened work\n");
    expect(h.pool.release).toHaveBeenCalledTimes(1);
  }, TEST_MS);

  it("-5. begin captures the reference at the clean reset commit, before the restore", async () => {
    const h = await rig({ seed: seedB });
    await h.start();
    await h.launched(1);
    expect(h.begun).toEqual(["T1#1"]);
    expect(h.begunStatus).toEqual([""]);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("seeded\n");
  }, TEST_MS);

  it("-6. a verify-fail retry carries the committed attempt over to the next attempt", async () => {
    const h = await rig({ verdicts: ["fail"] });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "attempt 1\n");
    await h.end(first, "ses-1", "DONE: finished");
    const second = await h.launched(2);
    expect(second.req.attempt).toBe(2);
    expect((await sh(h.r.slot, "rev-parse", "HEAD")).trim()).toBe(h.r.base);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("attempt 1\n");
    expect(expansion.calls.at(-1)).toEqual({ taskId: "T1", attempt: 2, restored: { attempt: 1, files: 1 } });
  }, TEST_MS);

  it("-6. the task's final commit drops its WIP ref", async () => {
    const h = await rig({ seed: seedB });
    await h.start();
    const first = await h.launched(1);
    expect(await refOf(h.r.top, wipRef)).not.toBeNull();
    await h.child(first, "ses-1");
    await h.end(first, "ses-1", "DONE: finished");
    await until(() => { expect(h.queue.enqueue).toHaveBeenCalledWith(["T1"]); });
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    const head = (await sh(h.r.slot, "rev-parse", "HEAD")).trim();
    expect(await sh(h.r.slot, "show", `${head}:b.txt`)).toBe("seeded\n");
  }, TEST_MS);

  it("-6/-10. a restore the child undid drops the WIP ref, so the stale work is not restored again", async () => {
    const h = await rig({ seed: seedB });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await sh(h.r.slot, "reset", "-q", "--hard", "HEAD");
    expect(await status(h.r.slot)).toBe("");
    await h.end(first, "ses-1", "ESCALATE: nothing worth keeping");
    await untilState(h, "parked");
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    await h.answer("go on");
    await h.launched(2);
    expect(expansion.calls.at(-1)?.restored).toBeNull();
    expect(existsSync(join(h.r.slot, "b.txt"))).toBe(false);
  }, TEST_MS);

  it("-7. a restore conflict offers discard-wip / keep-wip; discard-wip drops the ref and the task relaunches clean", async () => {
    const h = await rig({ seed: seedConflict });
    await h.start();
    await untilState(h, "parked");
    const item = (await h.ledger()).inbox.find((x) => x.taskId === "T1" && x.answer === null);
    if (item === undefined) throw new Error("no park item");
    expect(item.options).toEqual(["discard-wip", "keep-wip"]);
    await h.runtime.answer(PLAN, item.id, "discard-wip", ORCH);
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    const first = await h.launched(1);
    expect(first.req.attempt).toBe(2);
    expect(expansion.calls.at(-1)?.restored).toBeNull();
    expect(await readFile(join(h.r.slot, "a.txt"), "utf8")).toBe("base\n");
  }, TEST_MS);

  it("-7. a transient git error in the restore skips the launch with the backoff; no conflict, the ref is kept", async () => {
    let failPick = 1;
    const h = await rig({
      seed: seedB,
      git: faultyGit((args) => (args[0] === "cherry-pick" && args[1] === "--no-commit" && failPick-- > 0 ? "throw" : null)),
    });
    await h.start();
    const first = await h.launched(1);
    expect(failPick).toBeLessThan(0);
    expect(first.req.attempt).toBe(1);
    expect((await h.ledger()).inbox.filter((x) => x.taskId === "T1")).toHaveLength(0);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("seeded\n");
    expect(await refOf(h.r.top, wipRef)).not.toBeNull();
  }, TEST_MS);

  it("-10. lease-needed saves the attempt's work while the task still holds its slot", async () => {
    const at = slotAtAdd();
    const h = await rig({ git: faultyGit(() => null, at.spy) });
    at.ledger.read = h.ledger;
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "half done\n");
    await h.end(first, "ses-1", "NEED MORE: lease c.txt");
    await until(async () => { expect(await refOf(h.r.top, wipRef)).not.toBeNull(); });
    expect(at.seen[0]).toBe("slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("half done\n");
    // The teardown's bounded dispose must settle too: a task waiting for its lease never holds disposal up.
  }, TEST_MS);

  it("lease-needed with a learned dependency parks unsaved work, then retries after its answer and dependency", async () => {
    let failAdd = false;
    let held = false;
    const at = slotAtAdd();
    const h = await rig({
      tasks: { T2: taskNode("T2", { phase: "p1", kind: "manual", state: "pending" }) },
      leaseRegistry: {
        acquireWrite: () => ({ ok: true }),
        holderOf: (path) => held && path === "d.txt" ? { holderID: "holder-T2", taskRef: `${PLAN}:T2` } : null,
        releaseTask: () => {},
      },
      git: faultyGit((args) => (failAdd && args[0] === "add" && args[1] === "-A" ? "fail" : null), at.spy),
    });
    at.ledger.read = h.ledger;
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "leased work\n");
    held = true;
    failAdd = true;
    await h.end(first, "ses-1", "NEED MORE: lease d.txt");
    await untilState(h, "parked");
    await until(async () => { expect((await h.ledger()).inbox.some((x) => x.text.includes("could not be saved"))).toBe(true); });
    const parked = await h.ledger();
    expect(parked.tasks.T1?.slot).toBe("slot-1");
    expect(parked.tasks.T1?.attempts.at(-1)?.outcome).toBe("interrupted");
    expect(parked.tasks.T1?.footprint.writes).toContain("d.txt");
    expect(parked.edges).toContainEqual({
      from: "T2", to: "T1", kind: "learned", confidence: "high", evidence: "NEED MORE: lease d.txt",
    });
    expect(parked.inbox.map((x) => x.severity)).toEqual(["blocking"]);
    expect(h.pool.release).not.toHaveBeenCalled();
    expect(h.pool.reset).toHaveBeenCalledTimes(1);
    expect(at.seen).toEqual(["slot-1"]);
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("leased work\n");
    h.runtime.onLeaseReleased();
    await h.pause(200);
    expect((await h.ledger()).inbox).toHaveLength(1);
    expect(h.launches).toHaveLength(1);

    // The answer readies the held task, but its learned dependency still forbids a launch.
    await h.runtime.pause(PLAN, ORCH);
    failAdd = false;
    const item = parked.inbox[0];
    if (item === undefined) throw new Error("no unsaved-work item");
    await h.runtime.answer(PLAN, item.id, "git fixed; continue", ORCH);
    expect(await h.state()).toBe("ready");
    await h.runtime.resume(PLAN, ORCH);
    await h.pause(200);
    expect(h.launches).toHaveLength(1);
    await h.runtime.pause(PLAN, ORCH);
    held = false;
    await h.runtime.done(PLAN, "T2", ORCH);
    await h.runtime.resume(PLAN, ORCH);
    const second = await h.launched(2);
    expect(second.req.taskId).toBe("T1");
    expect(second.req.attempt).toBe(2);
    expect(at.seen).toContain("slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("leased work\n");
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("leased work\n");
    expect(expansion.calls.at(-1)?.restored).toEqual({ attempt: 1, files: 1 });
    expect((await h.ledger()).inbox[0]?.answer).toBe("git fixed; continue");
  }, TEST_MS);
});

// ---------------------------------------------------------------------------------------------------------------
// QA-PDF21 round 2 (each test fails without its fix)
// ---------------------------------------------------------------------------------------------------------------

/** A commit on `parent` changing `files` (kept at a test ref): an integration head that moved past the base. */
async function commitOn(r: Repo, parent: string, files: Record<string, string>): Promise<string> {
  const scratch = join(r.root, `head-${Date.now()}`);
  await sh(r.top, "worktree", "add", "-q", "--detach", scratch, parent);
  for (const [name, text] of Object.entries(files)) await writeFile(join(scratch, name), text);
  await sh(scratch, "commit", "-q", "-am", "integrated");
  const commit = (await sh(scratch, "rev-parse", "HEAD")).trim();
  await sh(r.top, "update-ref", "refs/heads/test/moved-head", commit);
  await sh(r.top, "worktree", "remove", "--force", scratch);
  return commit;
}

/** A git runner whose `add -A` fails while `fail` is set. */
function failingAdd(): { fail: boolean; git: GitRunner } {
  const s: { fail: boolean; git: GitRunner } = { fail: false, git: git };
  s.git = faultyGit((args) => (s.fail && args[0] === "add" && args[1] === "-A" ? "fail" : null));
  return s;
}

describe("QA-PDF21 round 2", () => {
  const wipRef = wipRefName(PLAN, "T1");
  const until = async (fn: () => void | Promise<void>): Promise<void> => {
    await vi.waitFor(fn, { timeout: WAIT_MS, interval: 20 });
  };
  const holdOf = async (h: Awaited<ReturnType<typeof rig>>): Promise<InboxItem | undefined> =>
    (await h.ledger()).inbox.find((x) => x.answer === null && x.text.includes("slot slot-1 could not be saved"));

  it("-12. a restore conflict after the head moved keeps attempt 1's tree at the WIP ref; keep-wip restores that tree, not the integration delta", async () => {
    const h = await rig({ verdicts: ["fail"], recordCommit: true });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "a.txt"), "attempt 1\n");
    await h.runtime.pause(PLAN, ORCH);
    await h.end(first, "ses-1", "DONE: finished");
    await untilState(h, "ready");
    expect((await h.ledger()).tasks.T1?.slot).toBe("slot-1");
    // The integration head moves past the base with a change that conflicts with attempt 1.
    await h.moveHead(await commitOn(h.r, h.r.base, { "a.txt": "integrated\n" }));
    await h.runtime.resume(PLAN, ORCH);
    await untilState(h, "parked");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:a.txt`)).toBe("attempt 1\n");
    expect((await sh(h.r.top, "rev-parse", `refs/heads/${wipRef}^`)).trim()).toBe(h.r.base);
    // keep-wip, once the head is back at the base: the next attempt gets attempt 1's tree back.
    await h.moveHead(h.r.base);
    const item = (await h.ledger()).inbox.find((x) => x.taskId === "T1" && x.answer === null && x.options.includes("keep-wip"));
    if (item === undefined) throw new Error("no restore-conflict item");
    await h.runtime.answer(PLAN, item.id, "keep-wip", ORCH);
    await h.launched(2);
    expect(await readFile(join(h.r.slot, "a.txt"), "utf8")).toBe("attempt 1\n");
    expect(expansion.calls.at(-1)?.restored).toEqual({ attempt: 1, files: 1 });
  }, TEST_MS);

  it("-13. an addTasks racing a launch waits for the launch step and never resets the slot holding restored work", async () => {
    const h = await rig({ verdicts: ["fail"], addTasks: () => ({ tasks: [], edges: [], reopened: ["T1"] }) });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "attempt 1\n");
    let racing: Promise<unknown> = Promise.resolve(null);
    // Between the second launch's restore and its attempt-started batch: an addTasks reopening T1.
    expansion.beforeEnv = async () => {
      expansion.beforeEnv = null;
      racing = h.runtime.addTasks(PLAN, "more work", ORCH).catch((e: unknown) => e);
      await h.pause(500);
    };
    await h.end(first, "ses-1", "DONE: finished");
    const second = await h.launched(2);
    expect(second.req.attempt).toBe(2);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("attempt 1\n");
    await bounded("the racing addTasks", racing, WAIT_MS);
    expect(await h.state()).toBe("dispatched");
    expect((await h.ledger()).tasks.T1?.slot).toBe("slot-1");
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("attempt 1\n");
  }, TEST_MS);

  it("-14. only a missing slot directory holds nothing to save", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "lost with the slot\n");
    await rm(h.r.slot, { recursive: true, force: true });
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    await until(() => { expect(h.pool.release).toHaveBeenCalledTimes(1); });
    const l = await h.ledger();
    expect(l.tasks.T1?.slot).toBeNull();
    expect(l.inbox.some((x) => x.text.includes("could not be saved"))).toBe(false);
    expect(await refOf(h.r.top, wipRef)).toBeNull();
  }, TEST_MS);

  it("R3-6. missing repository metadata quarantines files and never collects them as clean", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "irreplaceable\n");
    await rm(join(h.r.slot, ".git"));
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    const quarantine = join(h.r.root, "home", "quarantine", PLAN);
    const entries = await readdir(quarantine);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^slot-1-\d+/);
    expect(await readFile(join(quarantine, entries[0]!, "b.txt"), "utf8")).toBe("irreplaceable\n");
    expect(existsSync(h.r.slot)).toBe(false);
    expect(h.pool.release).not.toHaveBeenCalled();
    await h.runtime.abort(PLAN, ORCH);
    await bounded("abort settled", h.runtime.settled(), WAIT_MS);
    await expect(h.runtime.gc()).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(h.runtime.purge(PLAN, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(h.pool.gc).not.toHaveBeenCalled();
    expect((await h.ledger()).inbox.filter((x) => x.text.includes("could not be saved"))).toHaveLength(1);
    const restarted = await h.restart();
    await expect(restarted.gc()).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    await expect(restarted.purge(PLAN, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE" });
    expect(await readFile(join(quarantine, entries[0]!, "b.txt"), "utf8")).toBe("irreplaceable\n");
    expect((await h.store.read(PLAN)).inbox.filter((x) => x.text.includes("could not be saved"))).toHaveLength(1);
  }, TEST_MS);

  it("-15. answering the unsaved-work item saves the slot again and ends its hold", async () => {
    const s = failingAdd();
    const h = await rig({ git: s.git });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "unsaved\n");
    s.fail = true;
    await h.end(first, "ses-1", "ESCALATE: need a decision");
    await untilState(h, "parked");
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    const hold = await holdOf(h);
    if (hold === undefined) throw new Error("no unsaved-work item");
    expect(await refOf(h.r.top, wipRef)).toBeNull();
    s.fail = false;
    await h.runtime.answer(PLAN, hold.id, "git fixed", ORCH);
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("unsaved\n");
    expect(await status(h.r.slot)).toBe("");
    expect(await holdOf(h)).toBeUndefined();
  }, TEST_MS);

  it("R3-2. purge waits for abort's background save and rechecks its failed result", async () => {
    let blocked = false;
    let entered = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await rig({ inFlight: true, git: faultyGit(
      (args) => blocked && args[0] === "add" ? "fail" : null,
      async (args) => { if (blocked && args[0] === "add") { entered = true; await gate; } },
    ) });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "abort in progress\n");
    blocked = true;
    await h.runtime.abort(PLAN, ORCH);
    await until(() => { expect(entered).toBe(true); });
    let settled = false;
    const purge = h.runtime.purge(PLAN, ORCH).then(() => null, (e: unknown) => e).finally(() => { settled = true; });
    try {
      await h.pause(150);
      expect(settled).toBe(false);
      expect(h.pool.gc).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect(await bounded("purge refusal", purge, WAIT_MS)).toMatchObject({ code: "E_PLAN_STATE" });
    expect(await h.store.read(PLAN)).toMatchObject({ status: "aborted" });
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("abort in progress\n");
  }, TEST_MS);

  it("R3-2. purge refuses after 30 seconds on the runtime clock when abort cleanup is still pending", async () => {
    const clock = createNodeClock();
    let shift = 0;
    let block = false;
    let entered = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await rig({ inFlight: true, clock: { ...clock, now: () => clock.now() + shift },
      git: faultyGit(() => null, async (args) => { if (block && args[0] === "add") { entered = true; await gate; } }),
    });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "pending cleanup\n");
    block = true;
    try {
      await h.runtime.abort(PLAN, ORCH);
      await until(() => { expect(entered).toBe(true); });
      const purge = h.runtime.purge(PLAN, ORCH).then(() => null, (e: unknown) => e);
      await h.pause(100);
      shift = 30_001;
      expect(await bounded("bounded purge", purge, WAIT_MS)).toMatchObject({ code: "E_PLAN_STATE", message: expect.stringContaining("cleanup is still pending") });
      expect(h.pool.gc).not.toHaveBeenCalled();
      expect(await h.store.read(PLAN)).toMatchObject({ status: "aborted" });
      expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("pending cleanup\n");
    } finally { release(); }
  }, TEST_MS);

  it("-15. after an abort with a failed save, gc and purge refuse while the save fails; a tick saves it, then collects", async () => {
    const s = failingAdd();
    const h = await rig({ inFlight: true, git: s.git });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "aborted work\n");
    s.fail = true;
    await h.runtime.abort(PLAN, ORCH);
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    await h.pause(200);
    expect(h.pool.gc).not.toHaveBeenCalled();
    await expect(h.runtime.gc()).rejects.toMatchObject({ code: "E_PLAN_STATE", message: expect.stringContaining("slot-1") });
    await expect(h.runtime.purge(PLAN, ORCH)).rejects.toMatchObject({ code: "E_PLAN_STATE", message: expect.stringContaining("slot-1") });
    expect(h.pool.gc).not.toHaveBeenCalled();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("aborted work\n");
    expect(await h.store.read(PLAN)).toMatchObject({ status: "aborted" });
    s.fail = false;
    h.runtime.onLeaseReleased();
    await until(() => { expect(h.pool.gc).toHaveBeenCalled(); });
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("aborted work\n");
  }, TEST_MS);

  it.each(["gc", "purge"] as const)("R3-1. %s retries durable holds in a plan never attached by this runtime", async (action) => {
    const s = failingAdd();
    const h = await rig({ inFlight: true, git: s.git });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "survives restart\n");
    s.fail = true;
    await h.runtime.abort(PLAN, ORCH);
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    const next = await h.restart();
    const collect = () => action === "gc" ? next.gc() : next.purge(PLAN, ORCH);
    await expect(collect()).rejects.toMatchObject({ code: "E_PLAN_STATE", message: expect.stringContaining("slot-1") });
    expect(h.pool.gc).not.toHaveBeenCalled();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("survives restart\n");
    expect((await h.store.read(PLAN)).inbox.filter((x) => x.text.includes("could not be saved"))).toHaveLength(1);
    s.fail = false;
    await collect();
    expect(h.pool.gc).toHaveBeenCalled();
    if (action === "gc") expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("survives restart\n");
  }, TEST_MS);

  it("R3-1. a leased marker alone rebuilds the hold after a crash before its inbox item was journaled", async () => {
    const s = failingAdd();
    const h = await rig({ inFlight: true, git: s.git });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "marker-only work\n");
    s.fail = true;
    await h.runtime.abort(PLAN, ORCH);
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    const next = await h.restart();
    // Recreate exactly the durable terminal ledger from before wipHold's inbox-added batch; the pool marker remains.
    const beforeItem = await h.store.read(PLAN);
    beforeItem.inbox = [];
    beforeItem.seq = 1;
    await h.store.remove(PLAN);
    const writer = await h.store.create(beforeItem, holderOf(ORCH, process.pid, hostname()));
    await writer.close();
    h.pool.list.mockImplementation(async () => {
      const marker = await h.pool.get("slot-1");
      return marker === null ? [] : [marker];
    });
    await expect(next.gc()).rejects.toMatchObject({ code: "E_PLAN_STATE", message: expect.stringContaining("slot-1") });
    expect(h.pool.gc).not.toHaveBeenCalled();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("marker-only work\n");
    expect((await h.store.read(PLAN)).inbox.filter((x) => x.text.includes("could not be saved"))).toHaveLength(1);
    s.fail = false;
    await next.gc();
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("marker-only work\n");
  }, TEST_MS);

  it("-16. a restore error that persists counts toward the provisioning streak, which raises one item", async () => {
    let picks = 0;
    const h = await rig({
      seed: seedB,
      git: faultyGit((args) => {
        if (args[0] !== "cherry-pick" || args[1] !== "--no-commit") return null;
        picks += 1;
        return "throw";
      }),
    });
    await h.start();
    await vi.waitFor(async () => {
      h.runtime.onLeaseReleased();
      expect((await h.ledger()).inbox.some((x) => x.text.includes("consecutive launches could not provision a slot"))).toBe(true);
    }, { timeout: 20_000, interval: 100 });
    const items = (await h.ledger()).inbox.filter((x) => x.text.includes("could not provision a slot"));
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toContain(`restoring the work of T1 (${wipRef})`);
    expect(picks).toBeGreaterThanOrEqual(5);
    expect(h.launches).toHaveLength(0);
    expect(await refOf(h.r.top, wipRef)).not.toBeNull();
  }, TEST_MS);

  it("-19. a lease-needed park of unsaved work names its item in the attempt context, blocks its dependents and keeps its file leases", async () => {
    const s = failingAdd();
    let held = false;
    const releaseTask = vi.fn<(holderID: string) => void>();
    const h = await rig({
      tasks: {
        T2: taskNode("T2", { phase: "p1", kind: "manual", state: "pending" }),
        T3: taskNode("T3", { phase: "p1", state: "pending" }),
      },
      edges: [{ from: "T1", to: "T3", kind: "learned", confidence: "high", evidence: "T3 builds on T1" }],
      leaseRegistry: {
        acquireWrite: () => ({ ok: true }),
        holderOf: (path) => held && path === "d.txt" ? { holderID: "holder-T2", taskRef: `${PLAN}:T2` } : null,
        releaseTask,
      },
      git: s.git,
    });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "leased work\n");
    held = true;
    s.fail = true;
    const releases = releaseTask.mock.calls.length;
    await h.end(first, "ses-1", "NEED MORE: lease d.txt");
    await untilState(h, "parked");
    await until(async () => { expect(await holdOf(h)).toBeDefined(); });
    const l = await h.ledger();
    const t1 = l.tasks.T1;
    const hold = await holdOf(h);
    if (t1 === undefined || hold === undefined) throw new Error("no parked task or item");
    expect(t1.attempts.at(-1)?.context).toBe(hold.text);
    expect(parkItemOf(l, t1)?.id).toBe(hold.id);
    expect(l.tasks.T3?.state).toBe("blocked");
    expect(t1.slot).toBe("slot-1");
    expect(releaseTask.mock.calls.length).toBe(releases);
  }, TEST_MS);
});

// ---------------------------------------------------------------------------------------------------------------
// 1. classification
// ---------------------------------------------------------------------------------------------------------------

describe("pdf2-1 (a): child text classification", () => {
  const table: Array<[string, string]> = [
    ["NEED MORE: budget", "budget"],
    ["NEED MORE: budget (read cap reached)\nmore text", "budget"],
    ["  need more:   BUDGET exhausted", "budget"],
    [`${ROUTER_BUDGET_NOTE_PREFIX} read-only call cap reached; resume with "continue and finish"`, "budget"],
    ["NEED MORE: lease src/a.ts", "lease"],
    ["NEED MORE: budgetary review", "ambiguity"],
    ["NEED MORE: context", "ambiguity"],
    ["NEED CONTEXT: which file?", "ambiguity"],
    ["SCOPE GROWTH: three more files", "ambiguity"],
    ["ESCALATE: authority", "escalate"],
    ["DONE: all green", "ordinary"],
  ];
  for (const [text, kind] of table) {
    it(`${JSON.stringify(text.split("\n")[0])} -> ${kind}`, () => {
      expect(classifyChildText(text).kind).toBe(kind);
    });
  }

  it("the lease check wins over the budget check and keeps its path", () => {
    expect(classifyChildText("NEED MORE: lease docs/budget.md")).toEqual({ kind: "lease", path: "docs/budget.md" });
  });
});

describe("pdf2-1 (a): the budget-cap park trigger", () => {
  it("running -> parked admits budget-cap, and the policy journals every running cause as its own trigger", () => {
    expect(TRANSITION_TRIGGERS["running>parked"]).toContain("budget-cap");
    for (const cause of ["escalate", "ambiguity", "qa-unparsable", "budget-cap"] as const) {
      expect(runningParkTrigger(cause)).toEqual({ trigger: cause, detail: null });
    }
    expect(() => runningParkTrigger("exhausted")).toThrow(ExecutorError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 2-3. budget resume
// ---------------------------------------------------------------------------------------------------------------

describe("pdf2-1 (a): a budget end resumes the same attempt", () => {
  it("a recovered budget end waits for root admission, then resumes the same child without resetting its WIP or beginning verification again", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "kept across recovery\n");
    const resets = h.pool.reset.mock.calls.length;
    const feed = {
      taskId: "T1", from: "running", evidence: "finished", action: "process-result", n: 1, childSessionID: "ses-1",
      context: { messages: [{ role: "assistant", text: "NEED MORE: budget", outcome: null }, { role: "idle", text: null, outcome: "completed" }] },
      probation: null, mismatch: false, orphans: [], slotValid: true,
    } satisfies import("../../src/executor/recovery").ReconcileFeed;
    h.deps.recovery = { recover: async () => [{ planId: PLAN, actions: [feed] }], adopt: async () => {}, reconcile: async () => [feed] };
    const gate = vi.spyOn(h.deps.launcher, "gate").mockReturnValue({ ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey: "recovery-context" } });
    const next = await h.restart();
    await next.start();
    await next.settled();
    expect(h.launches).toHaveLength(1);
    expect(h.pool.reset).toHaveBeenCalledTimes(resets);
    expect(h.pool.release).not.toHaveBeenCalled();
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("kept across recovery\n");
    gate.mockRestore();
    next.onRouterToolCall(ORCH);
    const resumed = await h.launched(2);
    expect(resumed.req).toMatchObject({ attempt: 1, nonce: first.req.nonce, resume: { childSessionID: "ses-1" }, prompt: RESUME_PROMPT });
    resumed.confirm({ kind: "confirmed", childSessionID: "ses-1", latencyMs: 0 });
    expect(h.begun).toEqual(["T1#1"]);
    expect(h.pool.reset).toHaveBeenCalledTimes(resets);
    expect(h.pool.release).not.toHaveBeenCalled();
    expect((await h.ledger()).tasks.T1?.attempts).toHaveLength(1);
    expect((await h.ledger()).tasks.T1?.attempts[0]?.resumes).toBe(1);
  }, TEST_MS);

  it("recovered re-provisioning retains an owned slot whose dirty work cannot be saved", async () => {
    let failSave = false;
    const h = await rig({ git: faultyGit(args => failSave && args[0] === "add" ? "fail" : null) });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await h.runtime.dispose();
    const branch = taskBranchName(PLAN, "T1");
    await sh(h.r.top, "branch", branch, h.r.base);
    const writer = await h.store.open(PLAN, h.deps.holder(ORCH));
    await writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "succeeded", endedAt: h.deps.clock.iso(), detail: null },
      { type: "task-transition", taskId: "T1", from: "running", to: "completed", trigger: "child-ended", detail: null },
      { type: "task-slot", taskId: "T1", slot: "slot-1", branch },
      { type: "task-transition", taskId: "T1", from: "completed", to: "verifying", trigger: "committed", detail: null },
    ]);
    await writer.close();
    await writeFile(join(h.r.slot, "b.txt"), "unsaved recovered work\n");
    failSave = true;
    const feed = { taskId: "T1", from: "verifying", evidence: "none", action: "reverify", n: 1, childSessionID: "ses-1",
      context: null, probation: null, mismatch: false, orphans: [], slotValid: false } satisfies import("../../src/executor/recovery").ReconcileFeed;
    h.deps.recovery = { recover: async () => [{ planId: PLAN, actions: [feed] }], adopt: async () => {}, reconcile: async () => [feed] };
    const resets = h.pool.reset.mock.calls.length;
    const next = await h.restart();
    await next.start();
    await next.settled();
    expect(h.pool.reset).toHaveBeenCalledTimes(resets);
    expect(h.pool.release).not.toHaveBeenCalled();
    expect((await h.ledger()).tasks.T1).toMatchObject({ state: "verifying", slot: "slot-1" });
    expect((await h.ledger()).inbox.some(item => item.answer === null && item.text.startsWith("the work in slot slot-1 could not be saved"))).toBe(true);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("unsaved recovered work\n");
  }, TEST_MS);

  it("2. resumes the same child with the same attempt and nonce up to BUDGET_RESUMES times, then parks with budget-cap", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "work in progress\n");
    let last = first;
    for (let k = 1; k <= BUDGET_RESUMES; k++) {
      // The last end before the cap is the router's budget note (it counts as a budget end too), whatever BUDGET_RESUMES is.
      await h.end(last, "ses-1", k === BUDGET_RESUMES ? `${ROUTER_BUDGET_NOTE_PREFIX} cap reached` : "NEED MORE: budget");
      last = await h.launched(k + 1);
      expect(last.req.resume).toEqual({ childSessionID: "ses-1" });
      expect(last.req.attempt).toBe(1);
      expect(last.req.nonce).toBe(first.req.nonce);
      expect(last.req.prompt).toBe(RESUME_PROMPT);
      last.confirm({ kind: "confirmed", childSessionID: "ses-1", latencyMs: 0 });
      await h.pause();
      const l = await h.ledger();
      expect(l.tasks.T1?.state).toBe("running");
      expect(l.tasks.T1?.attempts).toHaveLength(1);
      expect(l.tasks.T1?.attempts[0]?.resumes).toBe(k);
      expect(l.inbox.filter((x) => x.taskId === "T1")).toEqual([]);
    }
    // No second verifier.begin, no new attempt; the slot was kept.
    expect(h.begun).toEqual(["T1#1"]);
    expect(h.pool.release).not.toHaveBeenCalled();
    await h.end(last, "ses-1", "NEED MORE: budget");
    await untilState(h, "parked");
    expect(h.launches).toHaveLength(BUDGET_RESUMES + 1);
    const l = await h.ledger();
    const item = l.inbox.find((x) => x.taskId === "T1");
    expect(item?.text).toMatch(/budget cap reached/);
    expect(item?.text).toMatch(/kept/);
    expect(l.tasks.T1?.attempts[0]?.outcome).toBe("interrupted");
    expect(l.tasks.T1?.attempts[0]?.resumes).toBe(BUDGET_RESUMES);
    // The park is journaled under its own trigger, and the attempt ends with the cause as its detail.
    expect(h.journal.filter((e) => e.type === "task-transition" && e.taskId === "T1" && e.to === "parked")).toEqual([
      { type: "task-transition", taskId: "T1", from: "running", to: "parked", trigger: "budget-cap", detail: null },
    ]);
    expect(h.journal).toContainEqual(expect.objectContaining({ type: "attempt-ended", taskId: "T1", n: 1, outcome: "interrupted", detail: "budget-cap" }));
    expect(h.journal.filter((e) => e.type === "attempt-resumed")).toEqual(
      Array.from({ length: BUDGET_RESUMES }, (_, k) => k + 1).map((resumes) => ({ type: "attempt-resumed", taskId: "T1", n: 1, resumes })),
    );
    expect(await refOf(h.r.top, wipRefName(PLAN, "T1"))).not.toBeNull();
  }, TEST_MS);

  it("3a. an unconfirmed resume parks the task and keeps its work", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "kept\n");
    await h.end(first, "ses-1", "NEED MORE: budget");
    const resumed = await h.launched(2);
    resumed.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    await untilState(h, "parked");
    const wip = await refOf(h.r.top, wipRefName(PLAN, "T1"));
    expect(wip).not.toBeNull();
    expect(await sh(h.r.top, "show", `${wip}:b.txt`)).toBe("kept\n");
    expect((await h.ledger()).inbox.find((x) => x.taskId === "T1")?.text).toMatch(/not confirmed/);
  }, TEST_MS);

  it("3b. E_NO_CONTEXT on the resume parks the task and keeps its work", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "kept\n");
    h.launcher.throwNext = new ExecutorError("E_NO_CONTEXT", "stale context");
    await h.end(first, "ses-1", "NEED MORE: budget");
    await untilState(h, "parked");
    expect(h.launches).toHaveLength(1);
    const wip = await refOf(h.r.top, wipRefName(PLAN, "T1"));
    expect(await sh(h.r.top, "show", `${wip}:b.txt`)).toBe("kept\n");
    expect((await h.ledger()).inbox.find((x) => x.taskId === "T1")?.text).toMatch(/E_NO_CONTEXT/);
  }, TEST_MS);
});

// ---------------------------------------------------------------------------------------------------------------
// 4-10. no lost work
// ---------------------------------------------------------------------------------------------------------------

describe("pdf2-1 (b): no lost work", () => {
  it("4. a park with a dirty slot stores an Omr-Wip commit (never Omr-Attempt) and leaves the slot clean at the base", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "a.txt"), "changed\n");
    await writeFile(join(h.r.slot, "b.txt"), "new\n");
    await h.end(first, "ses-1", "ESCALATE: need a decision");
    await untilState(h, "parked");
    const wip = await refOf(h.r.top, wipRefName(PLAN, "T1"));
    expect(wip).not.toBeNull();
    const body = await sh(h.r.top, "log", "-1", "--format=%B", `${wip}`);
    expect(body).toContain(`${WIP_TRAILER}: ${PLAN}/T1/1/${first.req.nonce}`);
    expect(body).not.toContain("Omr-Attempt");
    expect((await sh(h.r.top, "rev-parse", `${wip}^`)).trim()).toBe(h.r.base);
    expect((await sh(h.r.slot, "rev-parse", "HEAD")).trim()).toBe(h.r.base);
    expect(await status(h.r.slot)).toBe("");
  }, TEST_MS);

  it("5 + 9. the answered attempt gets the work as uncommitted changes on the integration head; its commit holds every attempt's files", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "attempt 1\n");
    await h.end(first, "ses-1", "ESCALATE: which API?");
    await untilState(h, "parked");
    await h.answer("use the new one");
    const second = await h.launched(2);
    expect(second.req.attempt).toBe(2);
    expect(second.req.resume).toBeUndefined();
    expect(expansion.calls.at(-1)).toEqual({ taskId: "T1", attempt: 2, restored: { attempt: 1, files: 1 } });
    expect((await sh(h.r.slot, "rev-parse", "HEAD")).trim()).toBe(h.r.base);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("attempt 1\n");
    expect(await status(h.r.slot)).toMatch(/b\.txt/);
    await h.child(second, "ses-2");
    await writeFile(join(h.r.slot, "c.txt"), "attempt 2\n");
    await h.end(second, "ses-2", "DONE: finished");
    await vi.waitFor(() => { expect(h.queue.enqueue).toHaveBeenCalledWith(["T1"]); }, { timeout: WAIT_MS, interval: 20 });
    const head = (await sh(h.r.slot, "rev-parse", "HEAD")).trim();
    expect((await sh(h.r.slot, "rev-parse", "HEAD^")).trim()).toBe(h.r.base);
    const files = (await sh(h.r.slot, "show", "--name-only", "--format=", head)).split(/\r?\n/).filter((x) => x !== "").sort();
    expect(files).toEqual(["b.txt", "c.txt"]);
    expect(await sh(h.r.slot, "log", "-1", "--format=%B", head)).toContain("Omr-Attempt");
  }, TEST_MS);

  it("6. a lost launch (no child) does not destroy the parked attempt's work", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "precious\n");
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    await h.answer("go on");
    const second = await h.launched(2);
    second.confirm({ kind: "unconfirmed", reason: "timeout", error: null });
    second.end({ kind: "lost", childSessionID: null, reason: "unconfirmed", endedAt: new Date().toISOString() });
    await h.pause();
    const third = await h.launched(3);
    expect(third.req.attempt).toBe(3);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("precious\n");
    const wip = await refOf(h.r.top, wipRefName(PLAN, "T1"));
    expect(await sh(h.r.top, "show", `${wip}:b.txt`)).toBe("precious\n");
  }, TEST_MS);

  it("7. a dirty slot leased to another owner is never touched; once a launch holds it, its work goes to an orphan ref, never restored", async () => {
    const h = await rig({ foreignOwner: true });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "whose?\n");
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    expect(await refOf(h.r.top, wipRefName(PLAN, "T1"))).toBeNull();
    const orphanRefs = async (): Promise<string[]> =>
      (await sh(h.r.top, "for-each-ref", "--format=%(refname)", `refs/heads/omr/${PLAN}/orphan/`)).split(/\r?\n/).filter((x) => x !== "");
    // QA-PDF21-14: the pool leases the slot to another owner: no save, reset or release runs in that worktree.
    expect(await orphanRefs()).toEqual([]);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("whose?\n");
    expect(h.pool.release).not.toHaveBeenCalled();
    await h.answer("go on");
    await h.launched(2);
    // The acquire handed the slot to the relaunch: its leftover work went to an orphan ref before the reset.
    const orphans = await orphanRefs();
    expect(orphans).toHaveLength(1);
    // QA-PDF21-10: `<slot>-<ms>-<nonce>`.
    expect(orphans[0]).toMatch(new RegExp(`^refs/heads/${orphanRefName(PLAN, "slot-1", 0).replace(/-0$/, "")}-\\d+-[a-z0-9]+$`));
    expect(await sh(h.r.top, "show", `${orphans[0] ?? ""}:b.txt`)).toBe("whose?\n");
    expect(expansion.calls.at(-1)?.restored).toBeNull();
    expect(existsSync(join(h.r.slot, "b.txt"))).toBe(false);
  }, TEST_MS);

  it("8. a clean slot creates no ref", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await h.end(first, "ses-1", "ESCALATE: nothing done");
    await untilState(h, "parked");
    expect((await sh(h.r.top, "for-each-ref", "--format=%(refname)", `refs/heads/omr/${PLAN}/`)).trim()).toBe("");
  }, TEST_MS);

  it("10. a restore conflict parks the task with the WIP ref kept and the slot clean at the base", async () => {
    let wip = "";
    const h = await rig({
      seed: async (r) => {
        // The saved work changed a.txt from "side" (its parent) to "wip"; the base still has "base": a conflict.
        const scratch = join(r.root, "side");
        await sh(r.top, "worktree", "add", "-q", "--detach", scratch, r.base);
        await writeFile(join(scratch, "a.txt"), "side\n");
        await sh(scratch, "commit", "-q", "-am", "side");
        const side = (await sh(scratch, "rev-parse", "HEAD")).trim();
        await sh(r.top, "worktree", "remove", "--force", scratch);
        wip = await seedWip(r, side, { "a.txt": "wip\n" });
      },
    });
    await h.start();
    await untilState(h, "parked");
    expect(h.launches).toHaveLength(0);
    expect(await refOf(h.r.top, wipRefName(PLAN, "T1"))).toBe(wip);
    expect((await h.ledger()).inbox.find((x) => x.taskId === "T1")?.text).toMatch(new RegExp(`previous work conflicts with ${h.r.base}; wip ref kept`));
    expect((await sh(h.r.slot, "rev-parse", "HEAD")).trim()).toBe(h.r.base);
    expect(await status(h.r.slot)).toBe("");
  }, TEST_MS);

  it("a seeded WIP ref is restored at attempt 1 (salvage, A-DF2-4)", async () => {
    const h = await rig({ seed: async (r) => { await seedWip(r, r.base, { "c.txt": "salvaged\n" }, 3); } });
    await h.start();
    await h.launched(1);
    expect(expansion.calls.at(-1)).toEqual({ taskId: "T1", attempt: 1, restored: { attempt: 3, files: 1 } });
    expect(await readFile(join(h.r.slot, "c.txt"), "utf8")).toBe("salvaged\n");
    expect((await sh(h.r.slot, "rev-parse", "HEAD")).trim()).toBe(h.r.base);
  }, TEST_MS);
});

describe("pdf2-1 (b): snapshot and restore helpers", () => {
  it("skips a snapshot whose tree equals the WIP ref's tree and still resets the slot", async () => {
    const r = await repo();
    const ref = wipRefName(PLAN, "T1");
    const input = { cwd: r.slot, ref, message: "wip(T1): attempt 1 escalate", trailer: wipTrailer(PLAN, "T1", 1, "n1"), timeoutMs: 30_000 };
    expect(await snapshotSlotWork(git, input)).toEqual({ saved: false, reason: "clean" });
    await writeFile(join(r.slot, "b.txt"), "x\n");
    const saved = await snapshotSlotWork(git, input);
    expect(saved).toMatchObject({ saved: true, ref, files: 1 });
    expect(await status(r.slot)).toBe("");
    const back = await restoreSlotWork(git, { cwd: r.slot, ref, timeoutMs: 30_000 });
    expect(back).toMatchObject({ kind: "restored", attempt: 1, files: 1 });
    expect(await snapshotSlotWork(git, input)).toEqual({ saved: false, reason: "unchanged" });
    expect(await status(r.slot)).toBe("");
    expect((await sh(r.slot, "rev-parse", "HEAD")).trim()).toBe(r.base);
  }, TEST_MS);
});

// ---------------------------------------------------------------------------------------------------------------
// pdf2-1 round 4 (merge of cpx/main, re-check of 4070b22): each test fails without its fix
// ---------------------------------------------------------------------------------------------------------------

/** The collaborator inputs the runtime builds (its hooks for the queue), in attach order. */
function captureInputs(h: Awaited<ReturnType<typeof rig>>): CollaboratorInput[] {
  const inputs: CollaboratorInput[] = [];
  const build = h.deps.collaborators;
  h.deps.collaborators = (i) => {
    inputs.push(i);
    return build(i);
  };
  return inputs;
}

/** The queue's `releaseSlot` hook of the latest attachment (`IntegrationQueueDeps.releaseSlot`). */
function releaseSlotOf(inputs: readonly CollaboratorInput[]): { input: CollaboratorInput; releaseSlot: NonNullable<CollaboratorInput["releaseSlot"]> } {
  const input = inputs[inputs.length - 1];
  if (input === undefined) throw new Error("no collaborator input");
  const releaseSlot = input.releaseSlot;
  if (releaseSlot === undefined) throw new Error("the runtime supplied no releaseSlot hook");
  return { input, releaseSlot };
}

describe("pdf2-1 round 4: blocked dependents, re-provisioning and slot paths", () => {
  const wipRef = wipRefName(PLAN, "T1");
  const waitFor = (fn: () => void | Promise<void>): Promise<void> => vi.waitFor(fn, { timeout: WAIT_MS, interval: 20 });

  it("M1: a READY dependent blocked by a reverted dependency keeps its unsaved work at its WIP ref", async () => {
    const h = await rig();
    const inputs = captureInputs(h);
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "dependent's unsaved work\n");
    // No relaunch: the lost attempt leaves T1 ready and still holding its unsaved slot (row 18).
    vi.spyOn(h.deps.launcher, "gate").mockReturnValue({ ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey: "m1-ready" } });
    first.end({ kind: "lost", childSessionID: "ses-1", reason: "runner-error", endedAt: h.deps.clock.iso() });
    await untilState(h, "ready");
    expect((await h.ledger()).tasks.T1?.slot).toBe("slot-1");
    const { input, releaseSlot } = releaseSlotOf(inputs);
    // Row 34 as the queue journals it for a ready dependent of the reverted task, then the queue's release of its slot.
    await input.writer.append([
      { type: "task-transition", taskId: "T1", from: "ready", to: "blocked", trigger: "dep-reverted", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    await releaseSlot("T1", "slot-1");
    // Saved before the release: the pool's next acquire resets the slot, the work stays at the WIP ref.
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("dependent's unsaved work\n");
    expect(h.pool.release).toHaveBeenCalledTimes(1);
    expect(h.pool.release).toHaveBeenCalledWith("slot-1");
    expect(await status(h.r.slot)).toBe("");
  }, TEST_MS);

  it("M1: a RUNNING dependent blocked by a reverted dependency is saved once and released by the runtime only", async () => {
    const seen = { slot: null as string | null, snapshots: 0 };
    const h = await rig({
      inFlight: true,
      // T0 stands for the reverted dependency: row 34 below makes T1 depend on it. Without an unsatisfied dependency the
      // scheduler unblocks T1 at once (`promotable`) and relaunches it, and that launch's own pre-reset check of the
      // slot is a second `status`: not a second save of the blocked attempt's work.
      tasks: { T0: taskNode("T0", { phase: "p1", kind: "manual", state: "pending" }) },
      git: faultyGit(() => null, async (args, cwd) => {
        // Every save of the slot starts with this status read (`snapshotSlotWork`).
        if (cwd === seen.slot && args[0] === "status" && args[1] === "--porcelain") seen.snapshots++;
      }),
    });
    const inputs = captureInputs(h);
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "running dependent's work\n");
    seen.slot = h.r.slot;
    const { input, releaseSlot } = releaseSlotOf(inputs);
    // Row 34 for a running dependent: its open attempt ends in the same batch. T1 now depends on T0, which is not
    // integrated (as a reverted dependency is not), so it stays blocked.
    await input.writer.append([
      { type: "edge-added", edge: { from: "T0", to: "T1", kind: "structural", confidence: "high", evidence: "the reverted dependency" } },
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "interrupted", endedAt: h.deps.clock.iso(), detail: "dep-reverted" },
      { type: "task-transition", taskId: "T1", from: "running", to: "blocked", trigger: "dep-reverted", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    // The queue's notification: the runtime cancels the live child (`sweepBlocked`).
    input.listener.onReverted("T1");
    await waitFor(() => { expect(first.settled).toBe(true); });
    // As create.ts's `settle`: the queue's release runs once the child left the launcher.
    await releaseSlot("T1", "slot-1");
    await h.pause(100);
    expect(h.pool.release).toHaveBeenCalledTimes(1);
    expect(h.pool.release).toHaveBeenCalledWith("slot-1");
    expect(seen.snapshots).toBe(1);
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("running dependent's work\n");
    expect((await h.ledger()).tasks.T1?.state).toBe("blocked");
  }, TEST_MS);

  it("N-1: the queue's release of a READY dependent waits for a launch step of the same task: their saves never overlap", async () => {
    // Every git step in the slot is counted while it runs; the relaunch's first one is held open.
    const io = { slot: "", active: 0, max: 0, hold: null as Promise<void> | null, entered: (): void => {} };
    const counting: GitRunner = {
      run: async (args, o) => {
        const inSlot = io.slot !== "" && o.cwd === io.slot;
        if (inSlot) {
          io.active += 1;
          io.max = Math.max(io.max, io.active);
        }
        try {
          const hold = inSlot ? io.hold : null;
          if (hold !== null) {
            io.hold = null;
            io.entered();
            await hold;
          }
          return await runGit(args, o.cwd);
        } finally {
          if (inSlot) io.active -= 1;
        }
      },
    };
    const h = await rig({ git: counting });
    const inputs = captureInputs(h);
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "dependent's unsaved work\n");
    const gate = vi.spyOn(h.deps.launcher, "gate").mockReturnValue({ ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey: "n1-ready" } });
    first.end({ kind: "lost", childSessionID: "ses-1", reason: "runner-error", endedAt: h.deps.clock.iso() });
    await untilState(h, "ready");
    const { input, releaseSlot } = releaseSlotOf(inputs);
    let resume: () => void = () => {};
    io.hold = new Promise<void>((res) => { resume = res; });
    const entered = new Promise<void>((res) => { io.entered = res; });
    io.slot = h.r.slot;
    // The context is back: the relaunch's launch step takes the task and starts its save before the slot's reset.
    gate.mockRestore();
    h.runtime.onLeaseReleased();
    await entered;
    // Row 34 for the READY dependent, then the queue's release of its slot, while that launch step holds the task.
    await input.writer.append([
      { type: "task-transition", taskId: "T1", from: "ready", to: "blocked", trigger: "dep-reverted", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    const released = releaseSlot("T1", "slot-1");
    await h.pause(200);
    expect(io.max).toBe(1);
    expect(h.pool.release).not.toHaveBeenCalled();
    resume();
    await released;
    await h.pause(100);
    expect(io.max).toBe(1);
    expect(h.pool.release).toHaveBeenCalledTimes(1);
    expect(h.pool.release).toHaveBeenCalledWith("slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("dependent's unsaved work\n");
    // The launch step found its task blocked after the save: no child was launched.
    expect(h.launches).toHaveLength(1);
    expect((await h.ledger()).tasks.T1?.state).toBe("blocked");
  }, TEST_MS);

  it("N-D: a late queue release of a blocked dependent never frees the slot its relaunch leased again", async () => {
    // The relaunch's first git step in the slot is held open, so it holds the task's mutex.
    const io = { slot: "", hold: null as Promise<void> | null, entered: (): void => {} };
    const holding: GitRunner = {
      run: async (args, o) => {
        const hold = io.slot !== "" && o.cwd === io.slot ? io.hold : null;
        if (hold !== null) {
          io.hold = null;
          io.entered();
          await hold;
        }
        return runGit(args, o.cwd);
      },
    };
    const h = await rig({ git: holding });
    const inputs = captureInputs(h);
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "dependent's unsaved work\n");
    const gate = vi.spyOn(h.deps.launcher, "gate").mockReturnValue({ ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey: "nd-ready" } });
    first.end({ kind: "lost", childSessionID: "ses-1", reason: "runner-error", endedAt: h.deps.clock.iso() });
    await untilState(h, "ready");
    const { input, releaseSlot } = releaseSlotOf(inputs);
    let resume: () => void = () => {};
    io.hold = new Promise<void>((res) => { resume = res; });
    const entered = new Promise<void>((res) => { io.entered = res; });
    io.slot = h.r.slot;
    // The context is back: the relaunch's launch step takes the task's mutex and starts its save before the slot's reset.
    gate.mockRestore();
    h.runtime.onLeaseReleased();
    await entered;
    // Row 34 for the READY dependent, then the queue's fire-and-forget release of its slot: it waits for the mutex.
    await input.writer.append([
      { type: "task-transition", taskId: "T1", from: "ready", to: "blocked", trigger: "dep-reverted", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    const released = releaseSlot("T1", "slot-1");
    // The dependency recovers before the launch step re-reads its task, so the step relaunches T1 in the same slot.
    await input.writer.append((cur) => (cur.tasks.T1?.state === "blocked"
      ? [{ type: "task-transition", taskId: "T1", from: "blocked", to: "ready", trigger: "dep-recovered", detail: null }]
      : []));
    resume();
    const second = await h.launched(2);
    await released;
    await h.pause(100);
    expect(second.req.attempt).toBe(2);
    // The late release found T1 relaunched: the slot of attempt 2 is neither saved away nor given back to the pool.
    expect(h.pool.release).not.toHaveBeenCalled();
    const t1 = (await h.ledger()).tasks.T1;
    expect(t1?.state).toBe("dispatched");
    expect(t1?.slot).toBe("slot-1");
    expect(t1?.attempts.map((a) => a.n)).toEqual([1, 2]);
    expect(await readFile(join(h.r.slot, "b.txt"), "utf8")).toBe("dependent's unsaved work\n");
  }, TEST_MS);

  /** T1 ready after a lost attempt, still holding its slot with unsaved work, not relaunched (no context); then row 34. */
  async function blockedReadyDependent(stateKey: string) {
    const h = await rig();
    const inputs = captureInputs(h);
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "dependent's unsaved work\n");
    vi.spyOn(h.deps.launcher, "gate").mockReturnValue({ ok: false, reason: "no-context", wake: { reason: "stale-context", stateKey } });
    first.end({ kind: "lost", childSessionID: "ses-1", reason: "runner-error", endedAt: h.deps.clock.iso() });
    await untilState(h, "ready");
    expect((await h.ledger()).tasks.T1?.slot).toBe("slot-1");
    const { input, releaseSlot } = releaseSlotOf(inputs);
    await input.writer.append([
      { type: "task-transition", taskId: "T1", from: "ready", to: "blocked", trigger: "dep-reverted", detail: null },
      { type: "task-slot", taskId: "T1", slot: null, branch: null },
    ]);
    return { h, input, releaseSlot };
  }

  it("N-D: a blocked dependent whose dependency recovered (ready again, same attempt) still has its slot saved and freed", async () => {
    const { h, input, releaseSlot } = await blockedReadyDependent("nd-recovered");
    // The dependency recovers before the queue's fire-and-forget release takes the task's mutex.
    await input.writer.append([{ type: "task-transition", taskId: "T1", from: "blocked", to: "ready", trigger: "dep-recovered", detail: null }]);
    await releaseSlot("T1", "slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("dependent's unsaved work\n");
    expect(h.pool.release).toHaveBeenCalledTimes(1);
    expect(h.pool.release).toHaveBeenCalledWith("slot-1");
    expect(await status(h.r.slot)).toBe("");
    const t1 = (await h.ledger()).tasks.T1;
    expect(t1?.state).toBe("ready");
    expect(t1?.slot).toBeNull();
    expect(t1?.attempts.map((a) => a.n)).toEqual([1]);
  }, TEST_MS);

  it("N-D: a blocked dependent an abort cancelled still has its slot saved and freed by the queue's late release", async () => {
    const { h, releaseSlot } = await blockedReadyDependent("nd-cancelled");
    // The abort cancels T1; its ledger slot is null, so the abort itself neither saves nor releases the slot.
    await h.runtime.abort(PLAN, ORCH);
    expect((await h.ledger()).tasks.T1?.state).toBe("cancelled");
    expect(h.pool.release).not.toHaveBeenCalled();
    await releaseSlot("T1", "slot-1");
    expect(await sh(h.r.top, "show", `refs/heads/${wipRef}:b.txt`)).toBe("dependent's unsaved work\n");
    expect(h.pool.release).toHaveBeenCalledTimes(1);
    expect(h.pool.release).toHaveBeenCalledWith("slot-1");
    expect(await status(h.r.slot)).toBe("");
  }, TEST_MS);

  it("minor-4: a failed save before the re-provisioning reset keeps the new slot leased under its hold and drops its cached lease", async () => {
    const io = { failSave: false, refuse: false };
    const h = await rig({
      git: faultyGit(args => (io.failSave && args[0] === "add" ? "fail" : null)),
      leaseRegistry: {
        acquireWrite: () => (io.refuse ? { ok: false, reason: "held", holders: [{ holderID: "holder-x", taskRef: "other-plan:T9" }] } : { ok: true }),
        holderOf: () => null,
        releaseTask: () => {},
      },
    });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await h.runtime.dispose();
    const branch = taskBranchName(PLAN, "T1");
    await sh(h.r.top, "branch", branch, h.r.base);
    const writer = await h.store.open(PLAN, h.deps.holder(ORCH));
    await writer.append([
      { type: "attempt-ended", taskId: "T1", n: 1, outcome: "succeeded", endedAt: h.deps.clock.iso(), detail: null },
      { type: "task-transition", taskId: "T1", from: "running", to: "completed", trigger: "child-ended", detail: null },
      { type: "task-slot", taskId: "T1", slot: "slot-1", branch },
      { type: "task-transition", taskId: "T1", from: "completed", to: "verifying", trigger: "committed", detail: null },
    ]);
    await writer.close();
    const feed = { taskId: "T1", from: "verifying", evidence: "none", action: "reverify", n: 1, childSessionID: "ses-1",
      context: null, probation: null, mismatch: false, orphans: [], slotValid: false } satisfies import("../../src/executor/recovery").ReconcileFeed;
    h.deps.recovery = { recover: async () => [{ planId: PLAN, actions: [feed] }], adopt: async () => {}, reconcile: async () => [feed] };
    // The pool keeps recording slot-1 as T1's: the restart's lease retries never see it vanish.
    h.pool.get.mockImplementation(async (slot) => slot !== "slot-1" ? null : {
      schema: 1, slot: "slot-1", path: h.r.slot, kind: "task", planId: PLAN, repoKey: "repo", state: "leased",
      owner: `plan:${PLAN}:T1`, commit: h.r.base, managers: [], manifests: {}, createdAt: h.deps.clock.iso(), updatedAt: h.deps.clock.iso(),
    });
    // The new slot R2 acquires holds work that cannot be saved.
    h.pool.acquire.mockImplementationOnce(async (id, who, commit) => {
      await writeFile(join(h.r.slot, "c.txt"), "left in slot-2\n");
      io.failSave = true;
      return { slot: "slot-2", path: h.r.slot, planId: id, owner: who, commit };
    });
    io.refuse = true; // T1's leases cannot be re-taken: T1 is held until they are back
    const next = await h.restart();
    await next.start();
    await waitFor(async () => {
      expect((await h.ledger()).inbox.some((i) => i.answer === null && i.text.startsWith("the work in slot slot-2 could not be saved"))).toBe(true);
    });
    await next.settled();
    expect((await h.ledger()).tasks.T1).toMatchObject({ state: "verifying", slot: "slot-1" });
    expect(h.pool.release).not.toHaveBeenCalledWith("slot-2"); // kept leased under its hold
    // The leases come back: the held task verifies with the slot its ledger names, not the cached new slot.
    io.failSave = false;
    io.refuse = false;
    const verify = vi.spyOn(h.deps.verifier, "verify");
    next.onLeaseReleased();
    await waitFor(() => { expect(verify).toHaveBeenCalled(); });
    expect(verify.mock.calls[0]?.[1]).toMatchObject({ slot: "slot-1", path: h.r.slot });
  }, TEST_MS);

  it("nit: a slot whose path is empty fails its save without running git in the process's cwd", async () => {
    const emptyCwd: string[] = [];
    const h = await rig({
      git: faultyGit((_args, cwd) => (cwd === "" ? "fail" : null), async (args, cwd) => {
        if (cwd === "") emptyCwd.push(args.join(" "));
      }),
    });
    // The pool hands out a lease without a path (never trusted as the process's cwd).
    h.pool.acquire.mockImplementationOnce(async (id, who, commit) => ({ slot: "slot-1", path: "", planId: id, owner: who, commit }));
    await h.start();
    const skipped = (): number => h.journal.filter((e) => e.type === "metric" && e.metric.name === "counter"
      && e.metric.key === "launch-skipped" && e.metric.labels.reason === "wip-save").length;
    await waitFor(() => { expect(skipped()).toBeGreaterThan(0); });
    expect(emptyCwd).toEqual([]);
    expect(h.journal.some((e) => e.type === "metric" && e.metric.name === "counter" && e.metric.key === "wip-failed"
      && e.metric.labels.slot === "slot-1")).toBe(true);
  }, TEST_MS);
});
