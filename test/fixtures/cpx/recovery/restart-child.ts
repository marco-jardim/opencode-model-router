// Child process of test/integration/executor-recovery-restart.test.ts: runs the REAL plugin-side executor (createExecutorRuntime +
// LedgerStore + slots + git + integration queue via realCollaborators) against a temp repo. The host simulator lives in the test
// process and keeps child sessions on disk, so they outlive this process. Bundled to .mjs by the test; not imported by it.
//
// argv: <config json path>. stdin: protocol lines from the test (`EVENT <json>`). stdout: protocol lines (`READY <point> ...`
// once parked at a kill point, `LAUNCH <taskId> <n> <session>`, `SETTLED`).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCapacityController } from "../../../../src/executor/capacity.js";
import { createGitOps, createGitRunner, integrationBranchName } from "../../../../src/executor/git.js";
import {
  BackgroundRuns,
  createIntegrateGit,
  createIntegrationChecks,
  createWriteGuard,
  type CommandRunner,
  type ResolvedCommand,
  type RunResolver,
} from "../../../../src/executor/integrate/checks.js";
import { createLander } from "../../../../src/executor/integrate/land.js";
import { createPhaseSuiteRunner } from "../../../../src/executor/integrate/phase-suite.js";
import { createIntegrationQueue, createRepoLockFactory, type IntegrationStepEvent } from "../../../../src/executor/integrate/queue.js";
import { createLedgerStore, createNodeFileSystem } from "../../../../src/executor/ledger.js";
import { createRecoveryService } from "../../../../src/executor/recovery.js";
import { processIdentity } from "../../../../src/executor/process-identity.js";
import { createExecutorRuntime, realCollaborators, type CollaboratorInput, type LeaseRegistryPort } from "../../../../src/executor/runtime.js";
import { createScheduler } from "../../../../src/executor/schedule.js";
import { createSlotPool } from "../../../../src/executor/slots/pool.js";
import { detectManagers, type Provisioner } from "../../../../src/executor/slots/provision.js";
import {
  type ChildEnd,
  type Clock,
  type GitRunner,
  type HostSessionEvent,
  type HostSessions,
  type LaunchConfirmation,
  type LaunchGate,
  type LaunchRequest,
  type LedgerV1,
  type PlanCompiler,
  type ProcessResult,
  type RouteResolver,
  type SlotVerifier,
  type Spawner,
  type TaskLauncher,
} from "../../../../src/executor/types.js";
import { buildDraft, holderOf, taskNode } from "../ledger/builders.js";
import {
  activityOf, appendMessages, contextOf, finishedAnswer, interruptedStep, midToolCall, readSession, userPromptMessage, writeSession, type ChildConfig,
  type KillPoint,
} from "./host-store.js";

/** What `realCollaborators`' queue factory receives (writer, leases, waker, listener; plus the policy and QA loop). */
export type QueueInput = CollaboratorInput;

/**
 * HostSessions over the disk store: `get`/`context` read the session file, `interrupt` marks it idle (an interrupted child
 * answers nothing more), `activity` is the injected value (v2's adapter is a stub answering "unknown"), events come from the test
 * on stdin.
 */
export function diskHosts(root: string, activity: ChildConfig["activity"], orchestrator: string): HostSessions & { emit(e: HostSessionEvent): void } {
  const listeners = new Set<(e: HostSessionEvent) => void>();
  return {
    async get(sessionID) {
      if (sessionID === orchestrator) return { id: sessionID, parentID: null };
      const s = await readSession(root, sessionID);
      return s === null ? null : { id: s.id, parentID: s.parentID };
    },
    async context(sessionID) {
      const s = await readSession(root, sessionID);
      return s === null ? { messages: [] } : contextOf(s);
    },
    async activity(sessionID) {
      return activityOf(activity, await readSession(root, sessionID));
    },
    async interrupt(sessionID) {
      const s = await readSession(root, sessionID);
      if (s === null) return;
      if (s.status === "busy") {
        await writeSession(root, {
          ...s,
          status: "idle",
          interrupted: s.interrupted + 1,
          messages: [...s.messages, interruptedStep(Date.now())],
        });
      } else {
        await writeSession(root, { ...s, interrupted: s.interrupted + 1 });
      }
    },
    async synthetic() {},
    async move() {},
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(e) {
      for (const l of [...listeners]) l(e);
    },
  };
}

/** One protocol line on stdout. */
export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface Run {
  req: LaunchRequest;
  sessionID: string | null;
  settled: boolean;
  end(e: ChildEnd): void;
}

/**
 * The scripted launcher: a launch creates the child's session on disk (its first user message is the launch prompt, as the host
 * stores it), journals it through `onChildCreated`, then "runs" it. A `normal` child writes its file in the slot and answers; any
 * other script leaves the child busy (the test's host simulator plays it after this process is killed). Normal children of a run
 * wait until every scripted child of that run is launched, so the kill point always finds them in flight.
 */
export function scriptedLauncher(c: ChildConfig, clock: Clock): TaskLauncher {
  const runs: Run[] = [];
  const scripted = new Set(Object.keys(c.scripts).filter((k) => c.scripts[k] !== "normal"));
  const launchedScripted = new Set<string>();
  let wakeHold: () => void = () => undefined;
  let hold = new Promise<void>((res) => (wakeHold = res));
  const releaseHoldIfReady = (): void => {
    if ([...scripted].every((t) => launchedScripted.has(t))) wakeHold();
  };
  releaseHoldIfReady();
  const gate: LaunchGate = {
    ok: true,
    context: { sessionID: c.orchestrator, callID: "call-1", messageID: "msg-1", agent: "orchestrator", capturedAt: clock.iso(), bootID: "0123456789abcdef", epoch: 1 },
    ageMs: 0,
  };
  let seq = 0;
  return {
    gate: () => gate,
    launch(req, hooks) {
      let resolveEnd: (e: ChildEnd) => void = () => undefined;
      let resolveConf: (k: LaunchConfirmation) => void = () => undefined;
      const completion = new Promise<ChildEnd>((res) => (resolveEnd = res));
      const confirmation = new Promise<LaunchConfirmation>((res) => (resolveConf = res));
      const run: Run = {
        req,
        sessionID: null,
        settled: false,
        end(e) {
          if (run.settled) return;
          run.settled = true;
          resolveEnd(e);
        },
      };
      runs.push(run);
      const first = !runs.some((r) => r !== run && r.req.taskId === req.taskId);
      const script = first ? (c.scripts[req.taskId] ?? "normal") : "normal";
      const work = c.work[req.taskId] ?? { file: `src/${req.taskId.toLowerCase()}.txt`, content: `${req.taskId}\n` };
      seq += 1;
      const sid = `ses-r${c.run}-${req.taskId}-${req.attempt}-${seq}-${clock.randomHex(3)}`;
      const answer = `DONE: ${req.taskId} wrote ${work.file}`;
      void (async () => {
        await writeSession(c.hostRoot, {
          id: sid,
          parentID: c.orchestrator,
          status: "busy",
          messages: [userPromptMessage(req.prompt)],
          script,
          slotPath: req.workRoot,
          file: work.file,
          content: work.content,
          answer,
          interrupted: 0,
          run: c.run,
          ...(c.launcherLiveness ? { launcherPid: process.pid } : {}),
        });
        run.sessionID = sid;
        try {
          await hooks.onChildCreated(sid);
        } catch (e) {
          resolveConf({ kind: "unconfirmed", reason: "hook-failed", error: e instanceof Error ? e.message : String(e) });
          run.end({ kind: "lost", childSessionID: sid, reason: "refused", endedAt: clock.iso() });
          return;
        }
        resolveConf({ kind: "confirmed", childSessionID: sid, latencyMs: 1 });
        say(`LAUNCH ${req.taskId} ${req.attempt} ${sid} ${script}`);
        if (script !== "normal") {
          // QA-4.2-2/R2-1: neither a mid-tool call nor a provider step cut mid-stream is an end.
          await appendMessages(c.hostRoot, sid, c.stopAt === "provider"
            ? [{ type: "assistant", text: "partial", time: { created: Date.now() } }]
            : midToolCall(Date.now()));
          launchedScripted.add(req.taskId);
          releaseHoldIfReady();
          return;
        }
        await hold;
        if (run.settled) return;
        await writeWork(req.workRoot, work.file, work.content);
        await appendMessages(c.hostRoot, sid, [finishedAnswer(answer, Date.now())], "idle");
        run.end({ kind: "completed", childSessionID: sid, text: answer, endedAt: clock.iso() });
      })().catch((e: unknown) => {
        say(`ERROR launch ${req.taskId}#${req.attempt}: ${e instanceof Error ? e.message : String(e)}`);
        resolveConf({ kind: "unconfirmed", reason: "threw", error: String(e) });
        run.end({ kind: "lost", childSessionID: run.sessionID, reason: "runner-error", endedAt: clock.iso() });
      });
      return { taskId: req.taskId, attempt: req.attempt, nonce: req.nonce, context: req.context, contextAgeMs: 0, startedAt: clock.iso(), confirmation, completion };
    },
    async cancel(taskId, attempt, reason) {
      const run = runs.find((r) => r.req.taskId === taskId && r.req.attempt === attempt && !r.settled);
      if (run === undefined) return;
      if (run.sessionID !== null) {
        const s = await readSession(c.hostRoot, run.sessionID);
        if (s !== null && s.status === "busy") {
          await writeSession(c.hostRoot, { ...s, status: "idle", interrupted: s.interrupted + 1, messages: [...s.messages, interruptedStep(Date.now())] });
        }
      }
      run.end({ kind: "interrupted", childSessionID: run.sessionID, reason, endedAt: clock.iso() });
    },
    inFlight() {
      return runs.filter((r) => !r.settled).map((r) => ({ taskId: r.req.taskId, attempt: r.req.attempt, childSessionID: r.sessionID, startedAt: clock.iso() }));
    },
    async dispose() {
      // Journals nothing (recovery closes the attempts of children still busy as lost); the children stay busy on the host.
      hold = Promise.resolve();
    },
  };
}

async function writeWork(slotPath: string, file: string, content: string): Promise<void> {
  const p = join(slotPath, file);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
}

/** The plan the compiler double hands out: `taskIds` independent tasks, one file each, awaiting approval (approve path, §9). */
export function draftOf(c: ChildConfig, taskIds: readonly string[]): LedgerV1 {
  const d = buildDraft(0, c.planId);
  d.status = "awaiting-approval";
  d.planPath = join(c.toplevel, "PLAN.md");
  d.repo = { key: `key-${c.planId}`, toplevel: c.toplevel, baseBranch: c.baseBranch, baseCommit: c.baseCommit };
  d.integration = { branch: integrationBranchName(c.planId), worktree: join(c.slotsDir, "integration"), head: c.baseCommit };
  d.orchestrator = { sessionID: c.orchestrator, boundAt: d.orchestrator.boundAt };
  // One task per integration entry (the kill points name T1's entry); no phase suite; no landing on `main` (not the subject).
  d.config = { ...d.config, slotsDir: c.slotsDir, batchMax: 1, phaseSuite: "off", land: "manual", maxParallel: Math.min(8, taskIds.length + 1) };
  d.edges = [];
  d.tasks = {};
  for (const id of taskIds) {
    const file = c.work[id]?.file ?? `src/${id.toLowerCase()}.txt`;
    d.tasks[id] = taskNode(id, {
      route: { line: "", role: "implementer", tier: "fast", pin: false },
      footprint: { writes: [file], reads: [], confidence: "explicit", sources: ["path"] },
    });
  }
  return d;
}

/** The executor as one process: everything real but the launcher (scripted), the host (disk), routes and the slot verifier. */
async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) {
    process.stderr.write("usage: restart-child <config.json>\n");
    process.exit(2);
  }
  const c = JSON.parse(await readFile(configPath, "utf8")) as ChildConfig;
  const keepAlive = setInterval(() => undefined, 1_000);
  const clock = realClock();
  const fsys = createNodeFileSystem();
  const taskIds = Object.keys(c.work).sort();
  const draft = draftOf(c, taskIds);
  const branchRef = `refs/heads/${draft.integration.branch}`;
  const log = (level: "info" | "warn" | "error", msg: string, detail?: unknown): void => {
    process.stderr.write(`LOG ${level}: ${msg}${detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}\n`);
  };

  // ---- kill points: the git runner every real component shares parks the process at the armed point
  let fired = false;
  const park = (point: KillPoint, detail: string): Promise<never> => {
    fired = true;
    say(`READY ${point} ${detail}`);
    return new Promise<never>(() => undefined);
  };
  const hardened = createGitRunner({ mode: "hardened", toplevel: c.toplevel });
  const git: GitRunner = {
    async run(args, o) {
      const k = fired ? null : c.kill;
      // K1: GitOps.mergeFfOnly (`merge --ff-only --no-edit <candidate>`, git.ts) runs only in the queue's fast-forward step, after
      // that step's start event is fsynced (queue.ts fastForward).
      if (k?.point === "K1" && args.includes("merge") && args.includes("--ff-only")) {
        await park("K1", args[args.length - 1] ?? "");
      }
      const r = await hardened.run(args, o);
      if (k?.point === "K2" && r.code === 0 && args.includes("update-ref") && args.includes("--no-deref") && !args.includes("-d") && args.includes(branchRef)) {
        await park("K2", args.join(" "));
      }
      if (k?.point === "K3" && r.code === 0 && args.includes("commit") && args.some((a) => a.startsWith(`${k.task}: `))) {
        await park("K3", o.cwd);
      }
      return r;
    },
  };

  // ---- the real stack
  const store = createLedgerStore({ home: c.home });
  const ops = createGitOps({ git, userGit: createGitRunner({ mode: "user", toplevel: c.toplevel }), fs: fsys, planId: c.planId, toplevel: c.toplevel, executorHome: c.home });
  const pool = createSlotPool({
    planId: c.planId,
    repoKey: draft.repo.key,
    toplevel: c.toplevel,
    slotsDir: c.slotsDir,
    markersDir: join(c.home, "markers"),
    executorHome: c.home,
    maxParallel: draft.config.maxParallel,
    git: ops,
    fs: fsys,
    clock,
    // As create.ts wires it: special slots start at the durable ledger's integration head. Run 0 creates the integration
    // slot before the compile writes that ledger, so until then it is the head of the draft the compile will store.
    integrationHead: async () => (await store.list()).some((p) => p.planId === c.planId)
      ? (await store.read(c.planId)).integration.head
      : draft.integration.head,
    provisioner: noProvisioner(),
  });
  await pool.open();
  const hosts = diskHosts(c.hostRoot, c.activity, c.orchestrator);
  const holder = (sessionID: string): ReturnType<typeof holderOf> => holderOf(sessionID, process.pid, hostname(), clock.iso());
  const self = c.launcherLiveness ? processIdentity() : undefined;
  const recovery = createRecoveryService({
    store,
    host: hosts,
    toplevel: c.toplevel,
    holder,
    slotMarker: async (slotPath) => {
      for (const r of await pool.list()) {
        if (norm(r.path) !== norm(slotPath) && r.slot !== slotPath) continue;
        if (r.state !== "leased" || r.owner === null) return null;
        const m = /^plan:([^:]+):(.+)$/.exec(r.owner);
        return m === null ? null : { planId: m[1] ?? "", taskId: m[2] ?? "" };
      }
      return null;
    },
    clock,
    log,
    livenessMs: c.livenessMs,
    pollMs: c.pollMs,
    ...(self === undefined ? {} : { launcherLiveness: { self, isAlive: nodeSpawner().isAlive } }),
  });
  const buildQueue = (i: QueueInput): ReturnType<typeof createIntegrationQueue> => {
    const guard = createWriteGuard({ ledger: () => i.writer.ledger, pool, realpath: (p) => realpath(p), platform: process.platform });
    const igit = createIntegrateGit(git, guard);
    const background = new BackgroundRuns();
    const logger = { warn: (m: string) => log("warn", `queue: ${m}`) };
    const checks = createIntegrationChecks({
      ledger: () => i.writer.ledger,
      pool,
      git: ops,
      igit,
      resolver: nodeResolver(),
      spawn: realRunner(),
      guard,
      background,
      clock,
      logger,
      preemptForeground: async () => undefined,
      acquire: async () => ({ release: async () => undefined, lost: false }),
    });
    const suite = createPhaseSuiteRunner({ checks, igit, git: ops, pool, resolver: nodeResolver(), background, clock, logger });
    const lander = createLander({ git: ops, igit, guard, run: git, realpath: (p) => realpath(p), platform: process.platform });
    return createIntegrationQueue({
      planId: c.planId,
      writer: i.writer,
      history: { steps: () => historySteps(store, c.planId) },
      git: ops,
      igit,
      pool,
      leases: i.leases,
      checks,
      suite,
      lander,
      listener: i.listener,
      settle: (_id, release) => {
        void release();
      },
      locks: createRepoLockFactory({ stateRoot: c.lockRoot, clock, pid: process.pid, hostname: hostname(), isPidAlive: (pid) => nodeSpawner().isAlive(pid) }),
      guard,
      clock,
      logger,
    });
  };
  const routes: RouteResolver = {
    route: (t) => ({ agent: t.route.role, model: { providerID: "prov", modelID: "model-1", variant: null }, provider: "prov", heavy: false }),
  };
  const verifier: SlotVerifier = { verify: async (t, _slot, a) => ({ verdict: "pass", findings: "", ref: `ref-${t.id}-${a.n}` }) };
  const compiler: PlanCompiler = {
    compile: async () => ({
      draft: JSON.parse(JSON.stringify(draft)) as LedgerV1,
      summary: { tasks: taskIds.length, phases: 1, edges: 0, workMs: 0, criticalPathMs: 0, width: taskIds.length, expectedMakespanMs: 0, manual: [], warnings: [] },
    }),
    mergeResidue: () => {
      throw new Error("mergeResidue is not used");
    },
    addTasks: () => {
      throw new Error("addTasks is not used");
    },
    validate: () => [],
  };
  const runtime = createExecutorRuntime({
    store,
    ...(self === undefined ? {} : { self }),
    compiler,
    slots: pool,
    scheduler: createScheduler(),
    launcher: scriptedLauncher(c, clock),
    bindings: { bind() {}, evict() {} },
    routes,
    verifier,
    git,
    hosts,
    clock,
    leaseRegistry: new RegistryDouble(),
    recovery,
    holder,
    capacity: (o) => createCapacityController(o),
    collaborators: realCollaborators({ queue: buildQueue, clock, log }),
    pinOrchestrator: () => () => undefined,
    log,
    config: () => draft.config,
    toplevel: c.toplevel,
  });

  // ---- host events from the test's simulator
  let inBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => {
    inBuf += d;
    let i = inBuf.indexOf("\n");
    while (i >= 0) {
      const line = inBuf.slice(0, i).trim();
      inBuf = inBuf.slice(i + 1);
      if (line.startsWith("EVENT ")) hosts.emit(JSON.parse(line.slice("EVENT ".length)) as HostSessionEvent);
      i = inBuf.indexOf("\n");
    }
  });

  // ---- run 0: compile + approve (the integration branch exists; the integration slot is created here, 5.1 handoff);
  //      run 1: start() alone recovers the running ledger
  await runtime.start();
  if (c.run === 0) {
    await pool.acquireSpecial(c.planId, "integration");
    await runtime.compile({ path: draft.planPath, sessionID: c.orchestrator });
    await runtime.approve(c.planId, c.orchestrator);
  }
  say("STARTED");

  // ---- settle: every task integrated, then the runtime idle
  // Every task integrated and the phase gate closed (checkPhase runs after the integrated batch, in the queue's lane), so the
  // control and the restarted run are compared at the same point.
  const reader = createLedgerStore({ home: c.home });
  const deadline = Date.now() + 480_000;
  let allAt: number | null = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    if (fired) continue;
    const l = await reader.read(c.planId);
    if (Object.values(l.tasks).every((t) => t.state === "integrated")) {
      allAt ??= Date.now();
      if (l.phases.every((p) => p.gate === "passed")) break;
      if (Date.now() - allAt > 30_000) {
        say(`NOTE gates not passed 30 s after the last integration: ${l.phases.map((p) => `${p.id}=${p.gate}`).join(",")}`);
        break;
      }
    }
    if (Date.now() > deadline) {
      say(`STUCK ${JSON.stringify({ status: l.status, tasks: Object.values(l.tasks).map((t) => `${t.id}=${t.state}`), inbox: l.inbox.map((x) => x.text.slice(0, 300)) })}`);
      break;
    }
  }
  await Promise.race([runtime.settled(), new Promise((r) => setTimeout(r, 30_000))]);
  await new Promise((r) => setTimeout(r, 500));
  await runtime.dispose();
  say("SETTLED");
  clearInterval(keepAlive);
  process.exit(0);
}

/** The plan's journaled integration steps (the 5.1 history seam, as executor-integrate-git.test.ts wires it). */
async function historySteps(store: ReturnType<typeof createLedgerStore>, planId: string): Promise<IntegrationStepEvent[]> {
  try {
    const { events } = await store.exportPlan(planId);
    return events.filter((e): e is IntegrationStepEvent => e.type === "integration-step");
  } catch {
    return [];
  }
}

/** The write-lease registry port (in memory: a restart rebuilds it from the ledger, A3). */
class RegistryDouble implements LeaseRegistryPort {
  readonly held = new Map<string, { holderID: string; taskRef: string | null }>();
  acquireWrite(
    holder: { holderID: string; tree: string; isChild: true; taskRef: string; scope: "until-integrated" },
    writes: readonly string[],
  ): ReturnType<LeaseRegistryPort["acquireWrite"]> {
    const blockers: Array<{ holderID: string; taskRef: string | null }> = [];
    for (const w of writes) {
      const h = this.held.get(w);
      if (h !== undefined && h.taskRef !== holder.taskRef) blockers.push({ ...h });
    }
    if (blockers.length > 0) return { ok: false, reason: "held", holders: blockers };
    for (const w of writes) this.held.set(w, { holderID: holder.holderID, taskRef: holder.taskRef });
    return { ok: true };
  }
  releaseTask(taskRef: string): void {
    for (const [p, h] of [...this.held]) if (h.taskRef === taskRef) this.held.delete(p);
  }
  holderOf(path: string): { holderID: string; taskRef: string | null } | null {
    return this.held.get(path) ?? null;
  }
}

/** Provisioning is not the subject here: a slot is just a reset worktree. */
function noProvisioner(): Provisioner {
  return {
    detect: (slot, tracked) => detectManagers(slot, tracked, createNodeFileSystem(), { provision: "auto", python: "auto" }),
    provision: async () => undefined,
  };
}

/** The check commands of the `node-basic` fixture: `typecheck` is `node check.js`. */
function nodeResolver(): RunResolver {
  return {
    async resolve(ref, cwd) {
      if (ref.script !== "typecheck") return { ok: false, reason: `no script ${ref.script} in ${cwd}` };
      const command: ResolvedCommand = { label: "node check.js", file: process.execPath, args: ["check.js"], source: "package-script", ref };
      return { ok: true, command };
    },
  };
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** The checks' CommandRunner over real child processes. */
function realRunner(): CommandRunner {
  const spawner = nodeSpawner();
  return async (cmd, o) => {
    const r = await spawner.run(cmd.file, cmd.args, { cwd: o.cwd, env: definedEnv({ ...process.env, ...(cmd.env ?? {}) }), timeoutMs: 120_000, signal: o.signal });
    return { exitCode: r.code, timedOut: false, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  };
}

const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(Reflect.get(error, "code")) : undefined;
}

/** Real timers, unref'd (the process stays up through the stdin pipe and the keep-alive interval). */
export function realClock(): Clock {
  let id = 0;
  const timers = new Map<number, NodeJS.Timeout>();
  return {
    now: () => Date.now(),
    iso: (ms) => new Date(ms ?? Date.now()).toISOString(),
    setTimer(ms, fn) {
      const n = ++id;
      const t = setTimeout(() => {
        timers.delete(n);
        fn();
      }, ms);
      t.unref();
      timers.set(n, t);
      return { id: n };
    },
    clearTimer(h) {
      const t = timers.get(h.id);
      if (t !== undefined) clearTimeout(t);
      timers.delete(h.id);
    },
    randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  };
}

/** No shell; bounded output; the timeout kills the process. */
export function nodeSpawner(): Spawner {
  return {
    pid: process.pid,
    hostname: hostname(),
    isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return errCode(error) === "EPERM";
      }
    },
    run(command, args, o) {
      return new Promise<ProcessResult>((resolve, reject) => {
        const started = Date.now();
        const child = spawn(command, [...args], {
          cwd: o.cwd,
          env: o.env === undefined ? process.env : { ...o.env },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          ...(o.signal === undefined ? {} : { signal: o.signal }),
        });
        const max = o.maxOutputBytes ?? 1024 * 1024;
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const take = (current: string, chunk: Buffer): string => {
          if (current.length >= max) {
            truncated = true;
            return current;
          }
          return current + chunk.toString("utf8");
        };
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = take(stdout, chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = take(stderr, chunk);
        });
        const timer = setTimeout(() => child.kill(), o.timeoutMs);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (exit, signal) => {
          clearTimeout(timer);
          resolve({ code: exit, signal, stdout, stderr, truncated, durationMs: Date.now() - started });
        });
      });
    },
  };
}

main().catch((e: unknown) => {
  process.stderr.write(`restart-child failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  say(`FATAL ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
