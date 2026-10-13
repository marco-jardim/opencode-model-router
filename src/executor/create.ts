// Executor assembly is synchronous; repository/home discovery is prepared separately.
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { V2Executor, V2ExecutorHost } from "../compat/v2-hooks";
import { loadConfig, parseModelRef, resolveActiveTiers, resolveRolesRouting, resolveRouting, validateSlotsDir, type RouterHost } from "../router/config";
import { resolveRoles } from "../router/roles";
import { planRun } from "../router/run-tools";
import { annotateSteps } from "../routing/engine/plan";
import { classifyMany } from "../routing/classify";
import { CLASS_STATIC_TIER } from "../routing/classify/types";
import { createDurationModel, DURATION_PRIOR_MS, type DurationModel } from "../routing/outcomes/durations";
import { CLASS_ROLE_KIND } from "../routing/engine/roles-taxonomy";
import { runArgv } from "../verify/exec";
import { hardeningArgs, spawnBounded, workRootGuards } from "../router/git-tools";
import { createCapacityController } from "./capacity";
import { createPlanCompiler, type CompilerDeps } from "./compile";
import { createGitOps, createGitRunner } from "./git";
import { BackgroundRuns, createIntegrateGit, createIntegrationChecks, createWriteGuard, type RunResolver } from "./integrate/checks";
import { createLander } from "./integrate/land";
import { createPhaseSuiteRunner } from "./integrate/phase-suite";
import { createIntegrationQueue, createRepoLockFactory, type IntegrationStepEvent } from "./integrate/queue";
import { createTaskLauncher } from "./launch";
import { createLedgerStore, createNodeClock, createNodeFileSystem } from "./ledger";
import { resolveExecutorHome } from "./paths";
import { createRecoveryService, sameToplevel } from "./recovery";
import { createExecutorRuntime, realCollaborators, type ExecutorRuntimeHandle, type RuntimeDeps } from "./runtime";
import { createScheduler } from "./schedule";
import { countPlanMarkers, createSlotPool, defaultSlotsDir, type SlotPoolOpenOptions } from "./slots/pool";
import { createProvisioner } from "./slots/provision";
import { ExecutorError, type ExecutorRuntime, type LedgerStore, type LedgerV1, type PlanId, type SlotPool, type Spawner } from "./types";

/** Process adapter over the router's bounded, no-shell runner. */
function nodeSpawner(): Spawner {
  return {
    pid: process.pid, hostname: hostname(),
    isAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
    async run(command, args, options) {
      const start = Date.now();
      const result = await spawnBounded(command, args, options.cwd, {
        env: { ...options.env }, timeoutMs: options.timeoutMs, signal: options.signal,
        maxBytes: options.maxOutputBytes, settleOnFailure: true, killGroupOnSettle: true,
      });
      if (result.failure !== undefined) throw new Error(result.failure);
      return { code: result.code, signal: null, stdout: result.output.toString("utf8"), stderr: result.stderr.toString("utf8"),
        truncated: result.truncated, durationMs: Date.now() - start };
    },
  };
}

type OpenPool = SlotPool & { open(opts?: SlotPoolOpenOptions): Promise<void>; close(): void; removeEmptyDir?(): Promise<boolean> };

/** Collection fences slot operations; a closed facade may still open a gc-only handle for purge. */
export class PlanSlotPools {
  private readonly entries = new Map<PlanId, { view: SlotPool; pool: Promise<OpenPool> | null; closed: boolean }>();
  constructor(private readonly deps: {
    store: LedgerStore; toplevel: string; makePool(ledger: Readonly<LedgerV1>): OpenPool; log?: RuntimeDeps["log"];
    /** QA-5.1-22: how many slot markers the plan still has (read only); a purge asks it when the plan's slotsDir is invalid. */
    markers?(planId: PlanId): Promise<number>;
  }) {}

  readonly facade: SlotPool = {
    acquire: (id, ...args) => this.of(id).acquire(id, ...args),
    acquireSpecial: (id, ...args) => this.of(id).acquireSpecial(id, ...args),
    reset: async () => { throw new ExecutorError("E_PLAN_STATE", "a slot operation requires a plan"); },
    cleanForChecks: async () => { throw new ExecutorError("E_PLAN_STATE", "a slot operation requires a plan"); },
    release: async () => { throw new ExecutorError("E_PLAN_STATE", "a slot operation requires a plan"); },
    get: async () => null,
    list: async (id) => id === undefined ? (await Promise.all([...this.entries.keys()].map((plan) => this.of(plan).list()))).flat() : this.of(id).list(),
    gc: (finished) => this.gc(finished),
  };

  of(planId: PlanId): SlotPool {
    const have = this.entries.get(planId);
    if (have !== undefined) return have.view;
    const entry = { view: null as SlotPool | null, pool: null as Promise<OpenPool> | null, closed: false };
    const get = (): Promise<OpenPool> => {
      if (entry.closed) return Promise.reject(new ExecutorError("E_PLAN_STATE", `slots of plan ${planId} are closed`));
      entry.pool ??= this.deps.store.read(planId).then(async (ledger) => {
        const pool = this.deps.makePool(ledger);
        try { await pool.open(); } catch (error) { pool.close(); throw error; }
        if (entry.closed) { pool.close(); throw new ExecutorError("E_PLAN_STATE", `slots of plan ${planId} are closed`); }
        return pool;
      });
      return entry.pool;
    };
    const view: SlotPool = {
      acquire: async (...args) => (await get()).acquire(...args),
      acquireSpecial: async (...args) => (await get()).acquireSpecial(...args),
      reset: async (...args) => (await get()).reset(...args),
      cleanForChecks: async (...args) => (await get()).cleanForChecks(...args),
      release: async (...args) => { if (!entry.closed) await (await get()).release(...args); },
      get: async (...args) => entry.closed ? null : (await get()).get(...args),
      list: async (...args) => entry.closed ? [] : (await get()).list(...args),
      gc: async (finished) => {
        if (entry.closed) {
          // QA-5.1-22: the gc-only handle creates no directory.
          const pool = this.deps.makePool(await this.deps.store.read(planId));
          try { await pool.open({ create: false }); return await pool.gc(finished); }
          finally { pool.close(); }
        }
        const pool = await get();
        const result = await pool.gc(finished);
        if (await finished(planId)) { entry.closed = true; pool.close(); }
        return result;
      },
    };
    entry.view = view;
    // Keep the memoized promise and closed flag in the same cell as the facade.
    this.entries.set(planId, Object.assign(entry, { view }));
    return view;
  }

  async gc(finished: Parameters<SlotPool["gc"]>[0]): ReturnType<SlotPool["gc"]> {
    const removed: string[] = [], reported: string[] = [];
    for (const plan of await this.deps.store.list()) {
      if (!sameToplevel(plan.toplevel, this.deps.toplevel)) continue;
      if (plan.status !== "completed" && plan.status !== "aborted" && this.entries.get(plan.planId)?.pool == null) continue;
      try {
        const result = await this.of(plan.planId).gc(finished);
        removed.push(...result.removed); reported.push(...result.reported);
      } catch (error) {
        this.deps.log?.("warn", "slot gc failed", { planId: plan.planId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { removed, reported };
  }

  /**
   * QA-5.1-22: the purge's full gc of a finished plan. The live pool (if any) is closed first; the gc runs through a gc-only
   * handle, which creates no directory, and a complete gc (no slot of the plan left) removes `<root>\<planId>` if it is
   * empty. An invalid slotsDir with no slot marker of the plan skips the gc (nothing to collect); with markers it refuses.
   */
  async purge(planId: PlanId, finished: Parameters<SlotPool["gc"]>[0]): ReturnType<SlotPool["gc"]> {
    const entry = this.entries.get(planId);
    if (entry !== undefined && !entry.closed) {
      entry.closed = true;
      try { (await entry.pool)?.close(); } catch { /* A failed open owns no live pool. */ }
    }
    const ledger = await this.deps.store.read(planId);
    let pool: OpenPool | null = null;
    try {
      pool = this.deps.makePool(ledger);
      await pool.open({ create: false });
    } catch (error) {
      pool?.close();
      if (!(error instanceof ExecutorError) || error.code !== "E_INVALID_INPUT") throw error;
      const markers = this.deps.markers === undefined ? 1 : await this.deps.markers(planId);
      if (markers > 0) {
        throw new ExecutorError("E_PLAN_STATE", `plan ${planId} still has ${markers} slot marker(s) but its slotsDir is invalid (${error.message}); `
          + "fix the slotsDir or remove those slots by hand, then purge again", { planId });
      }
      this.deps.log?.("warn", "purge: invalid slotsDir and no slot marker; nothing to collect", { planId, error: error.message });
      return { removed: [], reported: [] };
    }
    try {
      const result = await pool.gc(finished);
      await pool.removeEmptyDir?.();
      return result;
    } finally { pool.close(); }
  }

  async markerOf(slotName: string): Promise<{ planId: PlanId; taskId: string } | null> {
    const owners: Array<{ planId: PlanId; taskId: string }> = [];
    for (const plan of await this.deps.store.list()) {
      if (!sameToplevel(plan.toplevel, this.deps.toplevel) || (plan.status !== "running" && plan.status !== "paused")) continue;
      for (const record of await this.of(plan.planId).list()) {
        if (record.slot !== slotName && !sameToplevel(record.path, slotName)) continue;
        const owner = record.state === "leased" && record.owner !== null ? /^plan:([^:]+):(.+)$/.exec(record.owner) : null;
        if (owner?.[1] === plan.planId && owner[2] !== undefined) owners.push({ planId: plan.planId, taskId: owner[2] });
      }
    }
    return owners.length === 1 ? owners[0] ?? null : null;
  }

  async closeAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.closed = true;
      try { (await entry.pool)?.close(); } catch { /* A failed open owns no live pool. */ }
    }
  }
}

/** A configured slotsDir is a root, not a shared plan directory (A-5.1-6). */
export function slotsDirOf(planId: PlanId, toplevel: string, root: string | null = null): string {
  return root === null ? defaultSlotsDir(toplevel, planId) : join(root, planId);
}

function checkSlotsDir(slotsDir: string, toplevel: string): void {
  const result = validateSlotsDir(slotsDir, toplevel);
  if (!result.ok) throw new ExecutorError("E_INVALID_INPUT", result.reason);
}

/** Approval must still target the branch tip captured by compile, before any integration worktree is created. */
async function checkBase(git: RuntimeDeps["git"], repo: LedgerV1["repo"]): Promise<void> {
  const result = await git.run(["rev-parse", "--verify", `refs/heads/${repo.baseBranch}^{commit}`], { cwd: repo.toplevel, timeoutMs: 5_000 });
  if (result.code !== 0) throw new ExecutorError("E_GIT", `could not read base branch ${repo.baseBranch}`);
  const head = result.stdout.trim();
  if (head !== repo.baseCommit) {
    throw new ExecutorError("E_STALE_BASE", `base branch ${repo.baseBranch} moved ${repo.baseCommit}→${head} since compile; recompile`,
      { baseBranch: repo.baseBranch, old: repo.baseCommit, new: head });
  }
}

function runResolver(directory: string): RunResolver {
  return {
    async resolve(ref, cwd) {
      try {
        const config = resolveRolesRouting(loadConfig(directory), "v2").run;
        const plan = planRun({ script: ref.script, args: ref.args, cwd }, cwd, config, { platform: process.platform, env: process.env });
        return { ok: true, command: { label: ref.script, file: plan.executable, args: plan.argv,
          source: plan.kind === "script" ? "package-script" : "run-command", ref, cwd: plan.cwd,
          env: Object.fromEntries(Object.entries(plan.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) } };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

const processClaimKey = Symbol.for("omr.executor.claim.v1");
/**
 * QA-5.1-20: the retry callbacks of copies refused by the claim (a hot reload starts the new copy before the old one has
 * disposed). Kept beside the claim on the same global record, under its own key, so the claim's shape stays what every
 * loaded copy reads; a release calls each waiter once, and the waiters race for the claim through the same token check.
 */
const processClaimWaitersKey = Symbol.for("omr.executor.claim.waiters.v1");
const processClaims = globalThis as typeof globalThis & {
  [processClaimKey]?: { token: symbol; toplevel: string };
  [processClaimWaitersKey]?: Set<() => void>;
};

function claimWaiters(): Set<() => void> {
  return processClaims[processClaimWaitersKey] ??= new Set();
}

/** Frees the claim `token` holds (no-op for another holder's), then tells every refused copy that it may retry. */
function releaseClaim(token: symbol): void {
  if (processClaims[processClaimKey]?.token !== token) return;
  delete processClaims[processClaimKey];
  for (const retry of [...claimWaiters()]) {
    try { retry(); } catch { /* A waiter's failure is its own (it logs and clears its access). */ }
  }
}

/** No telemetry port: fixed tier priors, with the existing eight-minute prior as the middle tier. */
function staticTierDurations(cfg: Parameters<typeof resolveRoles>[0]): DurationModel {
  const priors = { fast: DURATION_PRIOR_MS / 2, medium: DURATION_PRIOR_MS, heavy: DURATION_PRIOR_MS * 2 };
  const models: Readonly<Record<string, DurationModel>> = Object.fromEntries(Object.entries(priors).map(([tier, priorMs]) =>
    [tier, createDurationModel({ readTimings: () => [], now: () => 0 }, { priorMs })]));
  const roles = resolveRoles(cfg, "v2"), names = Object.keys(priors);
  const staticTiers: Readonly<Record<string, string | null>> = CLASS_STATIC_TIER;
  return {
    estimate(query) {
      const requested = models[query.role] === undefined ? staticTiers[query.class] ?? cfg.defaultTier : query.role;
      const role = roles.get(query.role);
      const floor = role === undefined ? 0 : Math.max(0, names.indexOf(role.tierRange.floor));
      const ceiling = role === undefined ? names.length - 1 : names.indexOf(role.tierRange.ceiling);
      const index = Math.max(floor, Math.min(ceiling < 0 ? names.length - 1 : ceiling, Math.max(0, names.indexOf(requested))));
      return (models[names[index] ?? "medium"] ?? models.medium!).estimate(query);
    },
    observe() {},
    async load() {},
  };
}

export interface CreateExecutorOptions {
  host: V2ExecutorHost;
  prepared: PreparedExecutor;
  access: ExecutorAccess;
  annotate?: CompilerDeps["annotate"];
}

/** The adapter starts the returned runtime; assembling it never starts recovery or opens a plan. */
export function createExecutor(
  context: { routerHost: RouterHost; directory: string },
  options: CreateExecutorOptions,
): V2Executor | null | undefined {
  if (context.routerHost === "v1") return undefined;
  return assembleExecutor(context, options);
}

/**
 * QA-5.1-20: a copy refused only by the process claim keeps its inputs and retries the assembly once the claim is free: at
 * the release (the holder's dispose calls every waiter) or, failing that, the first time its `lateRuntime` is used. The
 * waiters race for the claim through the same token check, so one wins; the others stay waiters.
 * QA-5.1-26: the winner is handed to its adapter (`host.onExecutor`), which adopts it through the same path as an executor
 * built at start: it registers the executor's providers and hooks, starts it once (its recovery runs once) and disposes it in
 * the W7 order. A winner its adapter does not adopt (the adapter is already disposing) gets the safety dispose here.
 */
function waitForClaim(context: { directory: string }, options: CreateExecutorOptions): void {
  const { access, host } = options;
  const lifetime = host.lifetime;
  if (access.deferRetry === undefined || lifetime.aborted) return;
  const waiters = claimWaiters();
  let spent = false;
  // A copy that ends while it waits stops waiting: no executor is ever assembled for a disposed copy.
  function forget(): void {
    spent = true;
    waiters.delete(retry);
    access.deferRetry?.(null);
  }
  function retry(): void {
    if (spent || lifetime.aborted || processClaims[processClaimKey] !== undefined) return;
    lifetime.removeEventListener("abort", forget);
    forget();
    const built = assembleExecutor(context, options);
    if (built === null) return;
    let adopted = false;
    try {
      adopted = host.onExecutor(built);
    } catch (error) {
      console.warn("[model-router] executor: the adapter could not adopt it", String(error));
    }
    if (!adopted) void disposeUnadopted(built);
  }
  lifetime.addEventListener("abort", forget, { once: true });
  waiters.add(retry);
  access.deferRetry(retry);
}

/**
 * QA-5.1-26: the safety dispose of a handed-over executor its adapter did not adopt (it assembled after the adapter began to
 * dispose): the runtime, then its launcher, as W7 orders them. The runtime's dispose releases the claim, whatever fails.
 */
async function disposeUnadopted(built: V2Executor): Promise<void> {
  for (const [what, run] of [["runtime", () => built.runtime.dispose()], ["launcher", () => built.launcher.dispose()]] as const) {
    try {
      await run();
    } catch (error) {
      console.warn(`[model-router] executor: the ${what} could not be disposed`, String(error));
    }
  }
}

function assembleExecutor(context: { directory: string }, options: CreateExecutorOptions): V2Executor | null {
  const { directory } = context;
  const { host, prepared, access } = options;
  const absent = (reason: string): null => { access.clear(reason); return null; };
  const cfg = loadConfig(directory);
  if (resolveRolesRouting(cfg, "v2").delegation !== "roles") return absent("routing.delegation must be roles at start");
  if (resolveRouting(cfg, "v2").leases.mode !== "enforce") return absent("routing.leases.mode must be enforce");
  if (host.verifier === null) return absent("no plan-task verifier");
  if (cfg.enforcement?.verify?.require === "never") return absent("enforcement.verify.require is never");
  if (!prepared.ok) return absent(prepared.reason);
  if (host.leases === null) return absent("the lease registry is not available");
  if (host.runner === null) return absent("the child runner is not available");
  if (processClaims[processClaimKey] !== undefined) {
    // QA-5.1-20: refused only by the claim (a hot reload's new copy, while the old one disposes): wait for its release.
    waitForClaim(context, options);
    return absent("another plan executor already owns this process");
  }
  const claim = Symbol("plan executor");
  const { toplevel, home } = prepared;
  processClaims[processClaimKey] = { token: claim, toplevel };
  const clock = createNodeClock();
  const fs = createNodeFileSystem();
  const spawner = nodeSpawner();
  const log: RuntimeDeps["log"] = (level, message, detail) => {
    const write = level === "info" ? console.info : level === "warn" ? console.warn : console.error;
    write(`[model-router] executor: ${message}`, ...(detail === undefined ? [] : [detail]));
  };
  const timers = new Set<{ readonly id: number }>();
  let pools: PlanSlotPools | null = null;
  let launcher: ReturnType<typeof createTaskLauncher> | null = null;
  try {
    const rawGit = createGitRunner({ mode: "hardened", toplevel });
    const git: RuntimeDeps["git"] = { run: (args, opts) => rawGit.run([...hardeningArgs(), ...args], opts) };
    const userGit = createGitRunner({ mode: "user", toplevel });
    const store = createLedgerStore({ home });
    const opsOf = (planId: PlanId) => createGitOps({ git, userGit, fs, planId, toplevel, executorHome: home });
    pools = new PlanSlotPools({
      store, toplevel, log,
      markers: (planId) => countPlanMarkers({ fs, markersDir: join(home, "slots") }, planId),
      makePool(ledger) {
        const slotsDir = ledger.config.slotsDir ?? slotsDirOf(ledger.planId, toplevel);
        checkSlotsDir(slotsDir, toplevel);
        return createSlotPool({ planId: ledger.planId, repoKey: ledger.repo.key, toplevel, slotsDir,
          markersDir: join(home, "slots"), executorHome: home, maxParallel: ledger.config.maxParallel,
          git: opsOf(ledger.planId), fs, clock,
          integrationHead: async () => (await store.read(ledger.planId)).integration.head,
          provisioner: createProvisioner({ spawner, fs, clock, config: ledger.config,
            host: { platform: process.platform, env: process.env, guards: workRootGuards(slotsDir) } }),
          logger: { warn: (message) => log("warn", message) },
        });
      },
    });
    const planPools = pools;
    const routes: RuntimeDeps["routes"] = {
      route(task) {
        const current = loadConfig(directory);
        const roles = resolveRoles(current, "v2");
        const role = roles.get(task.route.role);
        if (role === undefined || !role.enabled) throw new ExecutorError("E_INVALID_INPUT", `unknown role ${task.route.role}`);
        const tiers = resolveActiveTiers(current);
        const names = Object.keys(tiers);
        const floor = names.indexOf(role.tierRange.floor), ceiling = names.indexOf(role.tierRange.ceiling);
        const requested = names.indexOf(task.route.tier ?? current.defaultTier);
        if (floor < 0 || ceiling < floor || requested < 0) throw new ExecutorError("E_INVALID_INPUT", "role tier range is unavailable");
        const tier = names[Math.max(floor, Math.min(ceiling, requested))];
        const config = tier === undefined ? undefined : tiers[tier];
        const model = config === undefined ? undefined : parseModelRef(config.model);
        if (model === undefined) throw new ExecutorError("E_INVALID_INPUT", "the task model is unavailable");
        return { agent: role.agent, model: { providerID: model.providerId, modelID: model.modelId, variant: config?.variant ?? null },
          provider: model.providerId, heavy: tier === "heavy" };
      },
    };
    const roleOf: CompilerDeps["roleOf"] = (route, tier) => {
      const roles = resolveRoles(loadConfig(directory), "v2");
      const kind = tier === "heavy" && route?.class === undefined ? "review" : CLASS_ROLE_KIND[route?.class ?? "other"];
      const candidates = [...roles.values()].filter((role) => role.enabled).sort((a, b) => a.agent.localeCompare(b.agent));
      const chosen = candidates.find((role) => role.kind === kind) ?? candidates.find((role) => role.kind === "general");
      if (chosen === undefined) throw new ExecutorError("E_INVALID_INPUT", `no enabled role for ${kind}`);
      return chosen.agent;
    };
    const innerCompiler = createPlanCompiler({
      fs,
      git: { async run(args, cwd) { const r = await git.run(args, { cwd, timeoutMs: 5_000 }); return { code: r.code ?? -1, stdout: r.stdout }; } },
      durations: host.durations ?? staticTierDurations(cfg),
      annotate: options.annotate ?? (async (steps) => {
        const current = loadConfig(directory), routing = resolveRouting(current, "v2");
        return annotateSteps(steps, { cfg: current, routing, agents: null, store: null,
          classifyMany: (inputs) => classifyMany(inputs, { cfg: current, settings: { ...routing.classifier, backend: "rules" },
            minClassConfidence: routing.minClassConfidence, backend: null, logger: { warn: (message) => log("warn", message) }, routeLinePositions: "any" }),
        });
      }),
      roleOf,
      integrationWorktree: (id) => join(slotsDirOf(id, toplevel, resolveRouting(loadConfig(directory), "v2").executor.slotsDir), "integration"),
    });
    const compiler: RuntimeDeps["compiler"] = {
      ...innerCompiler,
      async compile(path, opts) {
        const result = await innerCompiler.compile(path, opts);
        if (!sameToplevel(result.draft.repo.toplevel, toplevel)) throw new ExecutorError("E_INVALID_INPUT", "the plan belongs to another repository");
        const slotsDir = slotsDirOf(result.draft.planId, toplevel, resolveRouting(loadConfig(directory), "v2").executor.slotsDir);
        result.draft.config.slotsDir = slotsDir;
        if (!sameToplevel(result.draft.integration.worktree, join(slotsDir, "integration"))) {
          throw new ExecutorError("E_INVALID_INPUT", "the integration worktree does not match the plan slots directory");
        }
        checkSlotsDir(slotsDir, toplevel);
        return result;
      },
    };
    let runtime: ExecutorRuntimeHandle | null = null;
    const innerLauncher = createTaskLauncher({ runner: host.runner, hosts: host.hosts, bindings: host.bindings,
      bookkeeping: host.bookkeeping, clock, lifetime: host.lifetime, knownAgent: host.knownAgent,
      onMetric: (id, metric) => host.onLauncherMetric(id, metric),
    });
    let launcherDisposal: Promise<void> | null = null;
    launcher = { ...innerLauncher, dispose: () => launcherDisposal ??= innerLauncher.dispose() };
    const taskLauncher = launcher;
    const resolver = runResolver(directory);
    const buildQueue: Parameters<typeof realCollaborators>[0]["queue"] = (input) => {
      const planId = input.writer.planId;
      const pool = planPools.of(planId), ops = opsOf(planId);
      const guard = createWriteGuard({ ledger: () => input.writer.ledger, pool, realpath, platform: process.platform });
      const igit = createIntegrateGit(git, guard), background = new BackgroundRuns();
      const logger = { warn: (message: string) => log("warn", `queue: ${message}`) };
      const checks = createIntegrationChecks({ ledger: () => input.writer.ledger, pool, git: ops, igit, resolver, guard, background, clock, logger,
        spawn: async (command, opts) => {
          const start = clock.now();
          const result = await runArgv(command.file, command.args, { cwd: command.cwd ?? opts.cwd, env: command.env,
            signal: opts.signal, lowPriority: opts.lowPriority, timeoutMs: resolveRolesRouting(loadConfig(directory), "v2").run.timeoutMs });
          return { exitCode: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, durationMs: clock.now() - start };
        },
      });
      const suite = createPhaseSuiteRunner({ checks, igit, git: ops, pool, resolver, background, clock, logger });
      const lander = createLander({ git: ops, igit, guard, run: git, realpath, platform: process.platform });
      const queue = createIntegrationQueue({ planId, writer: input.writer,
        history: { steps: async () => (await store.exportPlan(planId)).events.filter((event): event is IntegrationStepEvent => event.type === "integration-step") },
        git: ops, igit, pool, leases: input.leases, checks, suite, lander, listener: input.listener,
        settle: (taskId, release) => {
          const poll = (): void => {
            if (!taskLauncher.inFlight().some((flight) => flight.taskId === taskId)) {
              void release().catch((error: unknown) => log("warn", "settled release failed", String(error)));
              return;
            }
            const timer = clock.setTimer(100, () => { timers.delete(timer); poll(); });
            timers.add(timer);
          };
          poll();
        },
        locks: createRepoLockFactory({ stateRoot: join(home, "locks"), clock, pid: spawner.pid, hostname: spawner.hostname, isPidAlive: spawner.isAlive }),
        guard, clock, logger,
      });
      return {
        enqueue: (ids) => queue.enqueue(ids), checkPhase: (id) => queue.checkPhase(id), land: () => queue.land(),
        abort: () => queue.abort(), queued: () => queue.queued(), dispose: () => queue.dispose(),
        async resume() {
          const ledger = input.writer.ledger, ref = `refs/heads/${ledger.integration.branch}`;
          if (await igit.readRef(toplevel, ref) === null) {
            const result = await git.run(["update-ref", ref, ledger.integration.head, "0".repeat(ledger.integration.head.length)], { cwd: toplevel, timeoutMs: 5_000 });
            if (result.code !== 0 && await igit.readRef(toplevel, ref) === null) throw new ExecutorError("E_GIT", "could not create the integration branch");
          }
          await pool.acquireSpecial(planId, "integration");
          return queue.resume();
        },
      };
    };
    const leases = host.leases;
    const holder: RuntimeDeps["holder"] = (sessionID) => {
      const now = clock.iso();
      return { sessionID, pid: spawner.pid, hostname: spawner.hostname, startedAt: now, heartbeatAt: now };
    };
    runtime = createExecutorRuntime({ store, compiler,
      slots: planPools.facade, slotsFor: (id) => planPools.of(id), purgeSlots: (id, finished) => planPools.purge(id, finished),
      scheduler: createScheduler(), launcher: taskLauncher, routes, verifier: host.verifier, git, hosts: host.hosts, bindings: host.bindings, clock,
      leaseRegistry: { acquireWrite: (owner, writes) => {
          const result = leases.registry.acquireWrite(owner, writes);
          if (result.ok) return { ok: true };
          if (result.reason === "held" || result.reason === "unknown-target") {
            return { ok: false, reason: result.reason, holders: result.holders.map((holder) => ({ holderID: holder.holderID, taskRef: holder.taskRef ?? null })) };
          }
          if (result.reason === "cap") return { ok: false, reason: "cap", message: `lease registry capacity reached (${result.held}/${result.limit})` };
          return { ok: false, reason: "invalid", message: result.message };
        },
        holderOf: (path) => {
          const holder = leases.registry.planHolderOf(toplevel, path);
          return holder === null ? null : { holderID: holder.holderID, taskRef: holder.taskRef ?? null };
        },
        releaseTask: (ref) => { leases.registry.releaseTask(ref); leases.notifyReleased(); } },
      recovery: createRecoveryService({ store, host: host.hosts, toplevel, holder, slotMarker: (slot) => planPools.markerOf(slot), clock, log }),
      holder, capacity: createCapacityController, collaborators: realCollaborators({ queue: buildQueue, clock, log }),
      pinOrchestrator: host.pinOrchestrator, log,
      config: () => ({ ...resolveRouting(loadConfig(directory), "v2").executor, slotsDir: null }), toplevel,
      async checkSlotsDir(slotsDir, repoToplevel, planId?: PlanId) {
        checkSlotsDir(slotsDir, repoToplevel);
        if (planId === undefined) throw new ExecutorError("E_PLAN_STATE", "approval validation requires the plan id");
        const ledger = await store.read(planId);
        await checkBase(git, ledger.repo);
      },
    });
    const innerRuntime = runtime;
    let disposal: Promise<void> | null = null;
    let starting: Promise<void> | null = null;
    const wrapped: ExecutorRuntimeHandle = { ...innerRuntime,
      // QA-5.1-20: recovery runs once per runtime, whoever starts it (the adapter, a claim retry or a late port).
      start() {
        starting ??= innerRuntime.start();
        return starting;
      },
      dispose() {
        disposal ??= (async () => {
          access.clear("disposed");
          try { await innerRuntime.dispose(); }
          finally {
            try { await planPools.closeAll(); }
            finally { for (const timer of timers) clock.clearTimer(timer); timers.clear(); releaseClaim(claim); }
          }
        })();
        return disposal;
      } };
    access.set(wrapped);
    return { runtime: wrapped, launcher: taskLauncher };
  } catch (error) {
    void launcher?.dispose();
    void pools?.closeAll();
    for (const timer of timers) clock.clearTimer(timer);
    const failed = absent(`assembly failed: ${error instanceof Error ? error.message : String(error)}`);
    releaseClaim(claim);
    return failed;
  }
}

export type PreparedExecutor = { ok: true; toplevel: string; home: string } | { ok: false; reason: string };

/** Discovery only: no ledger, worktree, marker or executor directory is created. */
export async function prepareExecutor(directory: string): Promise<PreparedExecutor> {
  try {
    const git = createGitRunner({ mode: "hardened", toplevel: directory });
    const run = (args: readonly string[], cwd: string) => git.run([...hardeningArgs(), ...args], { cwd, timeoutMs: 5_000 });
    const result = await run(["rev-parse", "--show-toplevel"], directory);
    if (result.code !== 0 || result.stdout.trim() === "") return { ok: false, reason: "not a git repository" };
    const toplevel = realpathSync.native(result.stdout.trim());
    const home = await resolveExecutorHome(toplevel, { git: run, realpath: async (path) => realpathSync.native(path) });
    return { ok: true, toplevel, home };
  } catch (error) {
    return { ok: false, reason: `repository discovery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface ExecutorAccess {
  runtime(): ExecutorRuntime | null;
  unavailable(): string;
  set(runtime: ExecutorRuntime): void;
  clear(reason: string): void;
  /**
   * QA-5.1-20: the assembly retry of a copy refused only by the process claim (null: none). `runtime()` runs it, at most
   * once per claim release, when it finds no runtime; `createExecutor` sets it.
   */
  deferRetry?(retry: (() => void) | null): void;
}

/** Tool/command ports resolve the current executor at call time, not plugin initialization. */
export function lateRuntime(access: ExecutorAccess): ExecutorRuntime {
  const get = (): ExecutorRuntime => {
    const runtime = access.runtime();
    if (runtime === null) throw new ExecutorError("E_PLAN_STATE", access.unavailable());
    return runtime;
  };
  return {
    compile: (...args) => get().compile(...args),
    residue: (...args) => get().residue(...args),
    approve: (...args) => get().approve(...args),
    status: (...args) => get().status(...args),
    ready: (...args) => get().ready(...args),
    addTasks: (...args) => get().addTasks(...args),
    answer: (...args) => get().answer(...args),
    done: (...args) => get().done(...args),
    pause: (...args) => get().pause(...args),
    resume: (...args) => get().resume(...args),
    abort: (...args) => get().abort(...args),
    land: (...args) => get().land(...args),
    adopt: (...args) => get().adopt(...args),
    gc: () => get().gc(),
    exportPlan: (...args) => get().exportPlan(...args),
    purge: (...args) => get().purge(...args),
    onRouterToolCall: (...args) => get().onRouterToolCall(...args),
    onHostEvent: (...args) => get().onHostEvent(...args),
    onRetryHook: (...args) => get().onRetryHook(...args),
    onChildEnd: (...args) => get().onChildEnd(...args),
    planLine: (sessionID) => access.runtime()?.planLine(sessionID) ?? null,
    start: async () => { await access.runtime()?.start(); },
    dispose: async () => { await access.runtime()?.dispose(); },
  };
}

export function createExecutorAccess(): ExecutorAccess {
  let current: ExecutorRuntime | null = null;
  let reason = "the plan executor is not available: not initialized";
  let retry: (() => void) | null = null;
  return {
    runtime: () => {
      // QA-5.1-20: no runtime yet, and refused by the claim: retry the assembly now if the claim is free (else it waits).
      if (current === null && retry !== null) retry();
      return current;
    },
    unavailable: () => reason,
    set(runtime) { current = runtime; },
    clear(why) {
      current = null;
      reason = `the plan executor is not available: ${why}`;
    },
    deferRetry(next) { retry = next; },
  };
}
