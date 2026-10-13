// pdf2-1 (a) budget resume and (b) no lost work: runtime resume, WIP snapshot and restore (real git).
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import {
  RESUME_PROMPT, classifyChildText, createExecutorRuntime, realCollaborators,
  type CollaboratorInput, type ExecutorRuntimeHandle, type PlanCollaborators, type RuntimeDeps,
} from "../../src/executor/runtime";
import { orphanRefName, restoreSlotWork, snapshotSlotWork, wipRefName, wipTrailer } from "../../src/executor/git";
import { createLedgerStore, createNodeClock } from "../../src/executor/ledger";
import { createCapacityController } from "../../src/executor/capacity";
import { createScheduler } from "../../src/executor/schedule";
import {
  BUDGET_RESUMES, ExecutorError, WIP_TRAILER,
  TRANSITION_TRIGGERS,
  type ChildEnd, type ExecutorEventInput, type ExpandInput, type GitRunner, type IntegrationQueue, type LaunchConfirmation, type LaunchHooks,
  type LaunchRequest, type LedgerV1, type ProcessResult, type SlotPool,
} from "../../src/executor/types";
import { buildDraft, holderOf, taskNode } from "../fixtures/cpx/ledger/builders";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import { runningParkTrigger } from "../../src/executor/unattended";

const expansion = vi.hoisted(() => ({ calls: [] as Array<{ taskId: string; attempt: number; restored: { attempt: number; files: number } | null }> }));

vi.mock("../../src/executor/expand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/executor/expand")>();
  return {
    ...actual,
    loadExpansionEnv: async () => ({ worktrees: [], longPaths: true }),
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

function draft(r: Repo): LedgerV1 {
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
  return value;
}

async function rig(o: { seed?: (r: Repo) => Promise<void>; foreignOwner?: boolean } = {}) {
  const r = await repo();
  if (o.seed !== undefined) await o.seed(r);
  const store = createLedgerStore({ home: join(r.root, "home") });
  const clock = createNodeClock();
  const launches: Launch[] = [];
  const launcher = { throwNext: null as ExecutorError | null };
  let owner: string | null = null;
  const pool = {
    acquire: vi.fn<SlotPool["acquire"]>(async (id, who, commit) => {
      owner = who;
      return { slot: "slot-1", path: r.slot, planId: id, owner: who, commit };
    }),
    acquireSpecial: vi.fn<SlotPool["acquireSpecial"]>(async () => { throw new Error("unexpected special slot"); }),
    reset: vi.fn<SlotPool["reset"]>(async (_slot, commit) => {
      await sh(r.slot, "checkout", "-q", "--detach", "--force", commit);
      await sh(r.slot, "clean", "-q", "-ffd");
    }),
    cleanForChecks: vi.fn<SlotPool["cleanForChecks"]>(async () => {}),
    release: vi.fn<SlotPool["release"]>(async () => { owner = null; }),
    get: vi.fn<SlotPool["get"]>(async (slot) => slot !== "slot-1" || owner === null ? null : {
      schema: 1, slot: "slot-1", path: r.slot, kind: "task", planId: PLAN, repoKey: "repo", state: "leased",
      owner: o.foreignOwner === true ? "someone-else" : owner, commit: r.base, managers: [], manifests: {},
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
    store, slots: pool, slotsFor: () => pool,
    compiler: {
      compile: async () => ({ draft: draft(r), summary: { tasks: 1, phases: 1, edges: 0, workMs: 0, criticalPathMs: 0, width: 1, expectedMakespanMs: 0, manual: [], warnings: [] } }),
      mergeResidue: () => { throw new Error("unexpected residue"); }, addTasks: () => { throw new Error("unexpected addTasks"); }, validate: () => [],
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
      inFlight: () => [],
      dispose: async () => {
        for (const l of launches) {
          l.confirm({ kind: "unconfirmed", reason: "threw", error: "disposed" });
          l.end({ kind: "interrupted", childSessionID: l.childSessionID, reason: "dispose", endedAt: clock.iso() });
        }
      },
    },
    routes: { route: () => ({ agent: "implementer", model: { providerID: "test", modelID: "test", variant: null }, provider: "test", heavy: false }) },
    verifier: {
      begin: (task, _slot, attempt) => { begun.push(`${task.id}#${attempt.n}`); },
      verify: async () => ({ verdict: "pass", findings: "", ref: "proof" }),
    },
    git,
    hosts: {
      get: async (id) => ({ id, parentID: null }), context: async () => ({ messages: [] }), activity: async () => "inactive",
      interrupt: async () => {}, synthetic: async () => {}, move: async () => {}, onEvent: () => () => {},
    },
    clock, leaseRegistry: { acquireWrite: () => ({ ok: true }), holderOf: () => null, releaseTask: () => {} },
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
    r, runtime, store, pool, queue, launches, launcher, collabs, begun, ledger, pause, journal,
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
  it("2. resumes the same child with the same attempt and nonce up to BUDGET_RESUMES times, then parks with budget-cap", async () => {
    const h = await rig();
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "work in progress\n");
    let last = first;
    for (let k = 1; k <= BUDGET_RESUMES; k++) {
      await h.end(last, "ses-1", k === 2 ? `${ROUTER_BUDGET_NOTE_PREFIX} cap reached` : "NEED MORE: budget");
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
      [1, 2, 3].map((resumes) => ({ type: "attempt-resumed", taskId: "T1", n: 1, resumes })),
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

  it("7. a dirty slot the task no longer holds goes to an orphan ref and is never restored", async () => {
    const h = await rig({ foreignOwner: true });
    await h.start();
    const first = await h.launched(1);
    await h.child(first, "ses-1");
    await writeFile(join(h.r.slot, "b.txt"), "whose?\n");
    await h.end(first, "ses-1", "ESCALATE: stuck");
    await untilState(h, "parked");
    expect(await refOf(h.r.top, wipRefName(PLAN, "T1"))).toBeNull();
    const orphans = (await sh(h.r.top, "for-each-ref", "--format=%(refname)", `refs/heads/omr/${PLAN}/orphan/`)).split(/\r?\n/).filter((x) => x !== "");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatch(new RegExp(`^refs/heads/${orphanRefName(PLAN, "slot-1", 0).replace(/-0$/, "")}-\\d+$`));
    await h.answer("go on");
    await h.launched(2);
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
