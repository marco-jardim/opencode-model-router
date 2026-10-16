import type { Plugin } from "@opencode/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import ModelRouterPlugin from "./index";
import { createV2Runtime } from "./compat/v2-client";
import { registerV2Hooks } from "./compat/v2-hooks";
import type { Ingest } from "./routing/outcomes/ingest";
import type { BudgetSnapshot } from "./guard/enforce";
import type { PlanTaskVerifier } from "./executor/runtime";
import type { ExecutorChildGuardPort } from "./executor/types";
import { createExecutor, createExecutorAccess, prepareExecutor, type CreateExecutorOptions, type PreparedExecutor } from "./executor/create";
import { loadConfig, resolveRolesRouting, resolveRouting } from "./router/config";
import { locationOutsideWorkRoots } from "./router/work-roots";
import { openV2Observations } from "./compat/v2-observations";

/** Keep the routing engine shared; translate only the host API at this boundary. */
export default {
  id: "opencode-model-router",
  server: ModelRouterPlugin,
  async setup(ctx: Plugin.Context) {
    const observations = openV2Observations();
    try {
      const runtime = createV2Runtime(ctx);
      const directory = ctx.location.directory;
      const access = createExecutorAccess();
      const cfg = loadConfig(directory), routing = resolveRouting(cfg, "v2"), rolesRouting = resolveRolesRouting(cfg, "v2");
      const discoveryDisabled = rolesRouting.delegation !== "roles" ? "routing.delegation must be roles at start"
        : routing.leases.mode !== "enforce" ? "routing.leases.mode must be enforce"
        : cfg.enforcement?.verify?.require === "never" ? "enforcement.verify.require is never"
        : locationOutsideWorkRoots(directory, rolesRouting.workRoots) ? "the location is outside routing.workRoots"
        : null;
      const prep: Promise<PreparedExecutor> = discoveryDisabled === null ? prepareExecutor(directory)
        : Promise.resolve({ ok: false, reason: discoveryDisabled });
      // The engine consumes directory/client only. V2 has no legacy HTTP server
      // URL or Bun shell context; do not invent either for the adapter.
      let ingest: Ingest | undefined;
      // #84 P2.1: the plugin's `/bypass` state, read by the role dispatch path (the router's own gate will not run while bypassed, S10/P-9).
      let isBypassed: (() => boolean) | undefined;
      let budgetSnapshot: ((childSessionID: string) => BudgetSnapshot) | undefined;
      // #84 P2.1 (handoff 22): the host's own stops of role children (step limit, context overflow), observed by the adapter from the
      // event stream and folded into the plugin's budget signals. The adapter hands its observer back once registered.
      let observeHostBudget: ((childSessionID: string, stepLimit: number | null) => boolean | "unobserved") | undefined;
      let roleLive: ((agent: string) => boolean) | undefined;
      let verifyEnabled: (() => boolean) | undefined;
      // QA-G-A3-2: the plugin's count of a role child's call refused outside its guard (role-authority refusals, permission denials).
      let recordRefusal: ((sessionID: string, agent: string | undefined, tool: string, args: unknown) => string | undefined) | undefined;
      // Phase 5.1 D8: the plan-task verifier built over this plugin instance's dispatch verification engine.
      let slotVerifier: PlanTaskVerifier | undefined;
      let annotate: CreateExecutorOptions["annotate"];
      // Publishes executor child rounds/caps process-wide; the slot-location plugin consumes each new round locally.
      let executorChildGuard: ExecutorChildGuardPort | undefined;
      const input = {
        directory: ctx.location.directory,
        worktree: ctx.location.project.directory,
        client: runtime.client,
        routerChildRunner: runtime.childRunner,
        routerHost: "v2" as const,
        routerObservations: observations,
        routerExecutor: access,
        routerOnPlanAnnotate: (port: NonNullable<typeof annotate>) => { annotate = port; },
        // Step pricing reads the catalog the adapter already queries; the plugin's single telemetry ingest comes back
        // here so the event loop feeds the instance that also receives the verdicts (QA-2.1-7).
        routerCatalog: async () => (await ctx.model.list({ location: { directory: ctx.location.directory } })).data,
        // The agents of THIS plugin instance's location (QA-2.4-16): the host lists agents per location.
        routerAgents: async () => (await ctx.agent.list({ location: { directory: ctx.location.directory } })).data,
        ...(ctx.generate === undefined ? {} : { routerGenerate: ctx.generate }),
        // The same host call the adapter uses for the config-reload and narration notices (src/compat/v2-hooks.ts): a transcript entry that
        // does not resume the session (QA-2.4-R2-1).
        routerSynthetic: async (notice: { sessionID: string; text: string; description: string }) => {
          await ctx.session.synthetic({ sessionID: notice.sessionID, text: notice.text, description: notice.description, resume: false });
        },
        routerOnIngest: (created: Ingest) => { ingest = created; },
        routerOnBypassState: (read: () => boolean) => { isBypassed = read; },
        // QA-P21-1-3: the plugin's budget snapshot (guard state + read-only CAP state) for the adapter's budget notice.
        routerOnBudgetSnapshot: (read: (childSessionID: string) => BudgetSnapshot) => { budgetSnapshot = read; },
        routerHostBudget: (childSessionID: string, stepLimit: number | null) => observeHostBudget?.(childSessionID, stepLimit),
        // QA-P21-2-4: the adapter's "this role agent is registered" check; QA-P21-2 nit 3: whether router_verify is registered.
        routerRoleLive: (agent: string) => roleLive?.(agent),
        routerOnVerifyEnabled: (read: () => boolean) => { verifyEnabled = read; },
        routerOnRefusal: (record: NonNullable<typeof recordRefusal>) => { recordRefusal = record; },
        routerOnSlotVerifier: (verifier: PlanTaskVerifier) => { slotVerifier = verifier; },
        routerOnExecutorChildGuard: (port: ExecutorChildGuardPort) => { executorChildGuard = port; },
      };
      const hooks = await ModelRouterPlugin(input as unknown as PluginInput);
      const prepared = await prep;
      if (!prepared.ok) access.clear(prepared.reason);
      if (prepared.ok && runtime.childRunner === undefined) access.clear("the child runner is not available");
      const registration = registerV2Hooks(ctx, hooks, runtime, {
        observations,
        executor: (host) => createExecutor({ routerHost: "v2", directory }, { host, prepared, access, observations, ...(annotate ? { annotate } : {}) }) ?? null,
        ...(ingest ? { ingest } : {}), ...(isBypassed ? { isBypassed } : {}), ...(budgetSnapshot ? { budgetSnapshot } : {}),
        ...(verifyEnabled ? { routerVerifyEnabled: verifyEnabled } : {}),
        ...(recordRefusal ? { recordRefusal } : {}),
        ...(slotVerifier ? { slotVerifier } : {}),
        ...(executorChildGuard ? { executorChildGuard } : {}),
        onHostBudget: (observe) => { observeHostBudget = observe; },
        onRoleLive: (isLive) => { roleLive = isLive; },
      });
      if (observations === undefined) return registration;
      const dispose = await registration;
      let disposal: Promise<void> | undefined;
      // Later cleanup calls can finish before the first drain: every caller must share its seal barrier.
      // Start cleanup synchronously; the async wrapper converts synchronous throws to rejections.
      return () => disposal ??= (async () => { await dispose(); })().finally(() => observations.close());
    } catch (error) { observations?.close(); throw error; }
  },
} satisfies Plugin.Plugin & { server: typeof ModelRouterPlugin };
