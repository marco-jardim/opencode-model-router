/**
 * The engine's per-plugin-instance runtime (M7, Phase 2.2): everything the dispatch path and the context hook share.
 *
 * It owns, lazily and only while `routing.engine != static`:
 *  - the process-wide outcomes bundle (A3: one store and one writer per process) used to READ posteriors and to
 *    ENQUEUE decision rows (D15: memory only, flushed by the 1.3 flusher off the hot path);
 *  - a cached agent list (5 s) and a cached model catalog (`createWireCatalog`);
 *  - the classifier backend, built once per distinct classifier settings (the log-once set, the `response_format`
 *    memo and the circuit breaker live on the instance, Phase 1.2 handoff).
 *
 * With `routing.engine == static` (the default, and every config without a `routing` block) `prepare()` returns `null`
 * before any host call, any allocation of a bundle or any disk access: the §1.2 guarantee.
 */

import type { LadderSessionPolicyInput } from "../../escalate/ladder";
import {
  resolveClassifierForPreset,
  resolveRouting,
  resolveVariantSteps,
  type ResolvedRouting,
  type RouterConfig,
} from "../../router/config";
import { createClassifierBackend, type ClassifyDeps } from "../classify";
import type { ClassifierBackend, ClassifierSettings, HostGenerate } from "../classify/types";
import type { EngineStoreView } from "../engine/types";
import { acquireOutcomes, type AcquireOutcomesOptions } from "../outcomes";
import { ingestSettings, type IngestSettings } from "../outcomes/ingest";
import type { LogRow, OutcomesBundle } from "../outcomes/types";
import {
  buildAgentView,
  createWireCatalog,
  parseRules,
  type AgentView,
  type PermissionRule,
  type RawCatalogModel,
  type WireCatalog,
} from "./host-info";

export interface WireLogger {
  warn(message: string, extra?: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  /** The live router config (hot reload re-reads it; the identity changes when the file does). */
  readonly loadConfig: () => RouterConfig;
  /** `ctx.agent.list().data`. */
  readonly listAgents: () => Promise<readonly unknown[]>;
  /** `ctx.model.list({ location }).data`. */
  readonly listModels: () => Promise<readonly RawCatalogModel[]>;
  /** `ctx.generate` for the `host` classifier backend (A4). */
  readonly generate?: HostGenerate;
  readonly logger: WireLogger;
  readonly now?: () => number;
  /** Seam over `acquireOutcomes` (tests inject persistence). */
  readonly acquire?: (options: AcquireOutcomesOptions) => OutcomesBundle;
  /** How long a fetched agent list is reused (default 5 s). */
  readonly agentsTtlMs?: number;
  /** The longest the first dispatch waits for the on-disk store to load (default 500 ms). */
  readonly readyTimeoutMs?: number;
}

/** Everything one decision needs, resolved once per call. */
export interface Prepared {
  readonly cfg: RouterConfig;
  readonly routing: ResolvedRouting;
  readonly settings: IngestSettings;
  readonly store: EngineStoreView;
  readonly catalog: WireCatalog;
  /** The runner's own policy input (A25, 1.4 handoff): the kernel prices the router block with it. */
  readonly session: LadderSessionPolicyInput;
  /** O(1): the row goes to the flusher's memory queue. */
  readonly enqueue: (row: LogRow) => void;
}

export interface EngineRuntime {
  /**
   * `null` when the engine is static (or the host is not v2): nothing was touched. Never throws. `cfg` is the config the caller
   * already loaded (one `loadConfig` per hook call); without it the runtime loads its own.
   */
  prepare(cfg?: RouterConfig): Promise<Prepared | null>;
  /** The dispatching session's view of the host's agents (evaluated permissions included). */
  agents(parentAgent: string | undefined, sessionRules: readonly PermissionRule[]): Promise<AgentView | null>;
  /** The classifier dependencies for this config (backend memoized). */
  classifyDeps(prepared: Prepared): ClassifyDeps;
  dispose(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Held {
  readonly dir: string;
  readonly bundle: OutcomesBundle;
  ready: "pending" | "done" | "gave-up";
}

export function createEngineRuntime(deps: RuntimeDeps): EngineRuntime {
  const now = deps.now ?? (() => Date.now());
  const acquire = deps.acquire ?? acquireOutcomes;
  const agentsTtlMs = deps.agentsTtlMs ?? 5_000;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 500;
  const catalog = createWireCatalog(deps.listModels, { now, logger: deps.logger });
  let held: Held | null = null;
  let routingMemo: { cfg: RouterConfig; routing: ResolvedRouting } | null = null;
  let agentsMemo: { at: number; data: readonly unknown[] } | null = null;
  let classifierMemo: { key: string; settings: ClassifierSettings; backend: ClassifierBackend | null } | null = null;
  let disposed = false;

  const release = (target: Held): void => {
    void target.bundle.release().catch((error: unknown) => {
      deps.logger.warn("[router] routing: releasing the outcome store failed", { error: describeError(error) });
    });
  };

  const waitReady = async (target: Held): Promise<void> => {
    if (target.ready !== "pending") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      target.bundle.ready.then(() => "done" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), readyTimeoutMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    target.ready = outcome === "done" ? "done" : "gave-up"; // a store that is slow to load is not waited for twice
  };

  const routingOf = (cfg: RouterConfig): ResolvedRouting => {
    if (routingMemo === null || routingMemo.cfg !== cfg) routingMemo = { cfg, routing: resolveRouting(cfg, "v2", deps.logger) };
    return routingMemo.routing;
  };

  return {
    async prepare(given): Promise<Prepared | null> {
      try {
        const cfg = given ?? deps.loadConfig();
        const settings = disposed ? null : ingestSettings(cfg, "v2");
        if (settings === null) {
          if (held !== null) {
            const previous = held;
            held = null;
            release(previous); // hot reload to static: let go of the store (its last release flushes)
          }
          return null;
        }
        if (held === null || held.dir !== settings.outcomesDir) {
          const previous = held;
          held = {
            dir: settings.outcomesDir,
            bundle: acquire({ dir: settings.outcomesDir, tuning: settings.tuning, logger: deps.logger }),
            ready: "pending",
          };
          if (previous !== null) release(previous);
        }
        const current = held;
        await Promise.all([waitReady(current), catalog.ensure()]);
        // QA-2.2-13: the runtime was disposed, or the config went static / moved to another directory, while we waited: the
        // holder we read from is no longer ours, and a decision made on a released store must not be logged.
        if (disposed || held !== current) return null;
        const routing = routingOf(cfg);
        return {
          cfg,
          routing,
          settings,
          store: current.bundle.store,
          catalog,
          session: {
            host: "v2",
            variantSteps: resolveVariantSteps(cfg, "v2"),
            maxContextFraction: routing.sessionReuse.maxContextFraction,
            catalog: (model) => catalog.entry(model),
            warn: (message) => deps.logger.warn(message),
          },
          enqueue: (row) => current.bundle.flusher.enqueue(row),
        };
      } catch (error) {
        deps.logger.warn("[router] routing: engine preparation failed; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
        return null;
      }
    },

    async agents(parentAgent, sessionRules): Promise<AgentView | null> {
      try {
        const t = now();
        if (agentsMemo === null || t - agentsMemo.at >= agentsTtlMs) {
          agentsMemo = { at: t, data: await deps.listAgents() };
        }
        return buildAgentView(agentsMemo.data, parentAgent, sessionRules);
      } catch (error) {
        deps.logger.warn("[router] routing: the agent list is unavailable; the dispatch proceeds as the orchestrator chose", { error: describeError(error) });
        return agentsMemo === null ? null : buildAgentView(agentsMemo.data, parentAgent, sessionRules);
      }
    },

    classifyDeps(prepared): ClassifyDeps {
      const settings = resolveClassifierForPreset(prepared.routing.classifier, prepared.cfg.activePreset);
      const key = JSON.stringify([
        settings.backend, settings.model, settings.baseUrl, settings.apiKeyEnv, settings.timeoutMs, settings.samples, settings.maxStateChars,
      ]);
      if (classifierMemo === null || classifierMemo.key !== key) {
        const memoSettings: ClassifierSettings = {
          backend: settings.backend,
          model: settings.model,
          baseUrl: settings.baseUrl,
          apiKeyEnv: settings.apiKeyEnv,
          timeoutMs: settings.timeoutMs,
          samples: settings.samples,
          maxStateChars: settings.maxStateChars,
        };
        classifierMemo = {
          key,
          settings: memoSettings,
          backend: createClassifierBackend(memoSettings, {
            ...(deps.generate === undefined ? {} : { generate: deps.generate }),
            logger: deps.logger,
          }),
        };
      }
      return {
        cfg: prepared.cfg,
        settings: classifierMemo.settings,
        minClassConfidence: prepared.routing.minClassConfidence,
        backend: classifierMemo.backend,
        logger: deps.logger,
      };
    },

    async dispose(): Promise<void> {
      disposed = true;
      const previous = held;
      held = null;
      if (previous !== null) {
        try {
          await previous.bundle.release();
        } catch (error) {
          deps.logger.warn("[router] routing: releasing the outcome store failed", { error: describeError(error) });
        }
      }
    },
  };
}

/** The session's own permission rules (`Session.Info.permissions`). */
export function sessionRulesOf(session: unknown): PermissionRule[] {
  return typeof session === "object" && session !== null ? parseRules((session as { permissions?: unknown }).permissions) : [];
}
