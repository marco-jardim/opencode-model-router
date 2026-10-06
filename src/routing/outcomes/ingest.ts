// ---------------------------------------------------------------------------
// Telemetry ingestion (M6, plan 2.1.2) — child-session outcomes and costs → outcome store.
//
// Signals handled (OpenCode v2 only, D1):
//   - `session.step.ended` of a registered child → `store.recordStep` (cost and tokens, D6/A1)
//   - a verifier verdict            → `store.recordVerdict` + a `VerdictRow`
//   - a false-refusal observation   → `store.recordFalseRefusal` + a `RefusalRow`
//   - a session that went away      → open attempts folded, registry entries forgotten
//
// Rules (docs/qa/cost-aware-routing/phase-1.2.md, phase-1.3.md "to 2.1"):
//   - Nothing happens unless `routing.engine !== "static"` (§1.2: no new files in static mode). The
//     outcomes bundle is acquired lazily, on the first signal that is actually recorded.
//   - Only children registered with `rememberDispatch` are recorded (`src/router/sessions.ts`).
//   - Never record under a class whose `facts.confidence < routing.minClassConfidence`, and never under
//     a backend label: the registry only ever holds `facts.class` (A19, QA-1.2-27). Such a dispatch has
//     no store call and no verdict/refusal row.
//   - The same `session.step.ended` (same event id) reaches every live location's plugin instance (S3b,
//     A3): a module-scope LRU of event ids counts it once. The registry, the dedupe state and the store
//     bundle (`acquireOutcomes`) are all process-wide; there is one writer per process.
//   - Never on a dispatch's hot path: handlers only update memory and enqueue rows; the flusher writes
//     (D15: on session idle/deleted and at most every 30 s, coalesced).
//   - Errors are logged and swallowed (§0.10.10); a handler never throws into a session or the event loop.
// ---------------------------------------------------------------------------

import { homedir, tmpdir } from "node:os";
import type { RouterConfig, RouterHost } from "../../router/config";
import { resolveRouting } from "../../router/config";
import { getActiveTiers } from "../../router/protocol";
import {
  forgetDispatch,
  forgetDispatchesOf,
  lookupDispatch,
  sweepDispatches,
  touchDispatch,
} from "../../router/sessions";
import type { DispatchRecord } from "../../router/sessions";
import type { AcquireOutcomesOptions } from "./index";
import { acquireOutcomes } from "./index";
import { pricingState, tokenSampleFromEvent } from "./cost";
import { resolveOutcomesDir } from "./persist";
import type {
  AttemptSignal,
  Clock,
  LoggedRoutingMode,
  ModelPricing,
  OutcomeKey,
  OutcomeLogger,
  OutcomesBundle,
  OutcomeTuning,
  RefusalRow,
  StepEndedTokens,
  Verdict,
  VerdictRow,
} from "./types";
import { LOG_ROW_VERSION, classifyAgentOrigin, makeKey, safeNow, splitModelRef } from "./types";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** What ingestion needs from the resolved config. `null` from {@link ingestSettings} = ingestion is off. */
export interface IngestSettings {
  /** Never `static`: a static engine has no settings at all. */
  readonly engine: LoggedRoutingMode;
  readonly minClassConfidence: number;
  /** Resolved outcomes directory (`routing.outcomes.path`, else the scorecard directory). */
  readonly outcomesDir: string;
  readonly tuning: OutcomeTuning;
  /** Ids of the active preset's router tier agents (origin `router`); every other agent is `host`. */
  readonly routerAgentIds: ReadonlySet<string>;
}

const settingsCache = new WeakMap<RouterConfig, IngestSettings | null>();

/**
 * Ingestion settings for `cfg` on `host`, or `null` when ingestion must do nothing: any host but v2 (D1) and
 * `routing.engine === "static"` (§1.2). Cached per config object (hot reload builds a new object).
 */
export function ingestSettings(cfg: RouterConfig | undefined, host: RouterHost): IngestSettings | null {
  if (host !== "v2") return null;
  const cached = cfg === undefined ? undefined : settingsCache.get(cfg);
  if (cached !== undefined) return cached;
  const routing = resolveRouting(cfg, host);
  let settings: IngestSettings | null = null;
  const engine = routing.engine;
  if (engine !== "static") {
    settings = Object.freeze({
      engine,
      minClassConfidence: routing.minClassConfidence,
      outcomesDir: resolveOutcomesDir(routing.outcomes.path, { tmpdir: tmpdir(), homedir: homedir() }),
      tuning: Object.freeze({
        halfLifeDays: routing.outcomes.halfLifeDays,
        maxEffectiveSamples: routing.outcomes.maxEffectiveSamples,
      }),
      routerAgentIds: new Set(cfg === undefined ? [] : Object.keys(getActiveTiers(cfg))),
    });
  }
  if (cfg !== undefined) settingsCache.set(cfg, settings);
  return settings;
}

// ---------------------------------------------------------------------------
// Catalog pricing (A1/A10): supplied from the catalog lookup the v2 adapter already uses (`ctx.model.list`)
// ---------------------------------------------------------------------------

/** The part of a host catalog model that pricing needs (`Model.Info` is assignable). */
export interface CatalogModel {
  readonly providerID: string;
  readonly id: string;
  readonly cost?: unknown;
}

export type PricingLookup = (provider: string, model: string) => Promise<ModelPricing>;

export interface CatalogPricingOptions {
  readonly now?: Clock;
  readonly logger?: OutcomeLogger;
  /** How long a loaded catalog is trusted (default 60 s). */
  readonly ttlMs?: number;
  /** After a failed load, wait this long before trying again (default 15 s). */
  readonly retryMs?: number;
}

function asPricing(value: unknown): ModelPricing {
  return typeof value === "object" && value !== null ? (value as ModelPricing) : undefined;
}

/**
 * Cached `provider/model → catalog cost` lookup over `list`. A model that is absent or a failed load gives
 * `undefined`, which {@link pricingState} reads as `unpriced` (A1): a `0` cost is then stored as unknown and
 * only a positive host-reported cost is kept. Concurrent callers share one in-flight load; never rejects.
 */
export function createCatalogPricing(
  list: () => Promise<readonly CatalogModel[]>,
  options: CatalogPricingOptions = {},
): PricingLookup {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const retryMs = options.retryMs ?? 15_000;
  let table = new Map<string, ModelPricing>();
  let loadedAt: number | null = null;
  let failedAt: number | null = null;
  let loading: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    try {
      const models = await list();
      const next = new Map<string, ModelPricing>();
      for (const model of models) next.set(`${model.providerID}/${model.id}`, asPricing(model.cost));
      table = next;
      loadedAt = safeNow(now);
      failedAt = null;
    } catch (error) {
      failedAt = safeNow(now);
      options.logger?.warn("[router] outcome ingestion: model catalog unavailable; step costs treated as unpriced", {
        error: describe(error),
      });
    }
  };

  return async (provider, model) => {
    const t = safeNow(now);
    const fresh = loadedAt !== null && t - loadedAt < ttlMs;
    const backingOff = failedAt !== null && t - failedAt < retryMs;
    if (!fresh && !backingOff) {
      loading ??= load().finally(() => {
        loading = null;
      });
      await loading;
    }
    return table.get(`${provider}/${model}`);
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (A3: shared by every plugin instance of the process)
// ---------------------------------------------------------------------------

/** Event ids remembered for the duplicate-delivery dedupe (LRU). */
export const SEEN_EVENT_CAP = 4096;
/** Signals (verdict/refusal rows) remembered so a repeated signal enqueues one row. */
const SIGNAL_CAP = 4096;
/** Children whose last attempt id is tracked (so a superseded attempt can be folded). */
const LAST_ATTEMPT_CAP = 2000;
/** Children already reported as unkeyable (model unresolved), one warning each. */
const WARNED_CAP = 500;

const seenEvents = new Map<string, true>();
const signalled = new Set<string>();
const lastAttemptByChild = new Map<string, string>();
const warnedUnkeyed = new Set<string>();

function boundedAdd(set: Set<string>, value: string, cap: number): boolean {
  if (set.has(value)) return false;
  set.add(value);
  while (set.size > cap) {
    const oldest = set.values().next();
    if (oldest.done === true) break;
    set.delete(oldest.value);
  }
  return true;
}

/** True the first time an event id is seen. A repeat refreshes its recency (LRU). */
function firstDelivery(eventKey: string): boolean {
  if (seenEvents.has(eventKey)) {
    seenEvents.delete(eventKey);
    seenEvents.set(eventKey, true);
    return false;
  }
  seenEvents.set(eventKey, true);
  while (seenEvents.size > SEEN_EVENT_CAP) {
    const oldest = seenEvents.keys().next();
    if (oldest.done === true) break;
    seenEvents.delete(oldest.value);
  }
  return true;
}

function rememberAttempt(child: string, attemptId: string): string | undefined {
  const previous = lastAttemptByChild.get(child);
  lastAttemptByChild.delete(child);
  lastAttemptByChild.set(child, attemptId);
  while (lastAttemptByChild.size > LAST_ATTEMPT_CAP) {
    const oldest = lastAttemptByChild.keys().next();
    if (oldest.done === true) break;
    lastAttemptByChild.delete(oldest.value);
  }
  return previous;
}

/** Test-only: drop the module-scope dedupe and attempt state (the dispatch registry has its own reset). */
export function resetIngestState(): void {
  seenEvents.clear();
  signalled.clear();
  lastAttemptByChild.clear();
  warnedUnkeyed.clear();
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/** A v2 event as delivered by `ctx.event.subscribe` (only what ingestion reads). */
export interface IngestEvent {
  readonly id?: unknown;
  readonly type: string;
  readonly data?: unknown;
}

export interface IngestDeps {
  /** Settings for the current call; `null` = ingestion off. Called per event, so it must be cheap (cache by config). */
  readonly settings: () => IngestSettings | null;
  readonly logger: OutcomeLogger;
  /** Catalog pricing of `provider`/`model`; absent → every step is priced as `unpriced` (A1). Only step events use it. */
  readonly pricing?: PricingLookup;
  /** Clock for row timestamps (default `Date.now`). */
  readonly now?: Clock;
  /** Seam over `acquireOutcomes` (tests pass injected deps/scheduler through). */
  readonly acquire?: (options: AcquireOutcomesOptions) => OutcomesBundle;
}

export interface Ingest {
  /** `session.step.ended` for a registered child. Awaits only the (cached) catalog lookup. Never rejects. */
  onStepEnded(event: IngestEvent): Promise<void>;
  /** A verifier verdict for the child's current attempt. Never throws. */
  onVerdict(childSessionID: string, outcome: Verdict): void;
  /** A false refusal (zero tool calls) observed for the child's current attempt. Never throws. */
  onFalseRefusal(childSessionID: string): void;
  /** A session was deleted: the child's open attempt is folded and its registry entry dropped; children of the session too. */
  onSessionGone(sessionID: string): void;
  /** Idle/deleted flush point (D15): coalesced and throttled by the flusher, never awaited. No-op without recorded data. */
  requestFlush(): void;
  /** Opportunistic maintenance for the idle sweeper: expired dispatches, idle open attempts. */
  sweep(): void;
  /** Flush and release this instance's reference to the outcomes bundle. Never rejects. */
  dispose(): Promise<void>;
}

/** Event types after which the router flushes (v2's equivalents of `session.idle`, plus the idle/deleted events). */
export const FLUSH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.idle",
  "session.deleted",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Target {
  readonly record: DispatchRecord;
  readonly settings: IngestSettings;
  readonly key: OutcomeKey;
}

export function createIngest(deps: IngestDeps): Ingest {
  const now: Clock = deps.now ?? Date.now;
  const acquire = deps.acquire ?? acquireOutcomes;
  let held: { readonly dir: string; readonly bundle: OutcomesBundle; tuning: OutcomeTuning } | null = null;
  let disposed = false;

  const warn = (message: string, error: unknown, extra?: Record<string, unknown>): void => {
    deps.logger.warn(`[router] outcome ingestion: ${message}`, { ...extra, error: describe(error) });
  };

  /** The bundle for `settings.outcomesDir`, acquired on first use; a changed directory re-acquires. */
  const bundleFor = (settings: IngestSettings): OutcomesBundle | null => {
    if (disposed) return null;
    if (held !== null && held.dir === settings.outcomesDir) {
      if (
        held.tuning.halfLifeDays !== settings.tuning.halfLifeDays ||
        held.tuning.maxEffectiveSamples !== settings.tuning.maxEffectiveSamples
      ) {
        held.bundle.store.configure(settings.tuning);
        held.tuning = settings.tuning;
      }
      return held.bundle;
    }
    const previous = held;
    held = null;
    if (previous !== null) {
      void previous.bundle.release().catch((error: unknown) => warn("releasing the previous outcomes directory failed", error));
    }
    const bundle = acquire({ dir: settings.outcomesDir, tuning: settings.tuning, logger: deps.logger });
    held = { dir: settings.outcomesDir, bundle, tuning: settings.tuning };
    return bundle;
  };

  /** Registered, trusted and keyable? Otherwise nothing may be recorded for the child. */
  const targetOf = (childSessionID: string): Target | null => {
    const settings = deps.settings();
    if (settings === null) return null;
    const record = lookupDispatch(childSessionID);
    if (record === undefined) return null;
    const confidence = record.facts.confidence;
    // Phase 1.2 handoff (QA-1.2-27): a class below the threshold is "unknown" for learning, not a class of
    // its own. No fallback class, no store call, no row.
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < settings.minClassConfidence) {
      return null;
    }
    const cls = record.facts.class;
    if (typeof cls !== "string" || cls === "" || cls === "unknown") return null;
    if (record.model === null) return unkeyable(childSessionID, "the dispatch registered no model");
    const ref = splitModelRef(record.model);
    if (ref === null) return unkeyable(childSessionID, `model "${record.model}" is not provider/model`);
    const variant = record.variant ?? ref.variant;
    const origin = classifyAgentOrigin(record.agent, settings.routerAgentIds);
    const key = makeKey(cls, { origin, id: record.agent }, ref.provider, ref.model, variant);
    return { record, settings, key };
  };

  const unkeyable = (childSessionID: string, why: string): null => {
    if (boundedAdd(warnedUnkeyed, childSessionID, WARNED_CAP)) {
      deps.logger.warn(`[router] outcome ingestion: child ${childSessionID} is not recorded: ${why}`);
    }
    return null;
  };

  const signalOf = (record: DispatchRecord): AttemptSignal => ({ attemptID: record.attemptId, step: record.step });

  const rowBase = (record: DispatchRecord): { v: typeof LOG_ROW_VERSION; ts: string; sessionID: string } => ({
    v: LOG_ROW_VERSION,
    ts: new Date(safeNow(now)).toISOString(),
    sessionID: record.parentSessionID ?? "",
  });

  const closeLastAttempt = (childSessionID: string): void => {
    const last = lastAttemptByChild.get(childSessionID);
    lastAttemptByChild.delete(childSessionID);
    if (last !== undefined) held?.bundle.store.closeAttempt(last);
  };

  return {
    async onStepEnded(event: IngestEvent): Promise<void> {
      try {
        if (event.type !== "session.step.ended" || !isRecord(event.data)) return;
        const data = event.data;
        const sessionID = data.sessionID;
        if (typeof sessionID !== "string") return;
        const target = targetOf(sessionID);
        if (target === null) return;
        const { record, settings, key } = target;
        // Dedupe only a step that is about to be recorded: an instance whose own settings are static must not
        // consume the event another instance (another location, another config) will record.
        const tokens = isRecord(data.tokens) ? (data.tokens as unknown as StepEndedTokens) : undefined;
        const eventKey =
          typeof event.id === "string" && event.id !== ""
            ? event.id
            : `${sessionID}|${String(data.assistantMessageID)}|${String(data.cost)}|${tokens?.input}|${tokens?.output}`;
        if (!firstDelivery(eventKey)) return;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        const ref = splitModelRef(record.model ?? "");
        const pricing = ref === null || deps.pricing === undefined ? undefined : await deps.pricing(ref.provider, ref.model);
        if (disposed) return;
        const superseded = rememberAttempt(sessionID, record.attemptId);
        if (superseded !== undefined && superseded !== record.attemptId) bundle.store.closeAttempt(superseded);
        bundle.store.recordStep(key, {
          attemptID: record.attemptId,
          cost: typeof data.cost === "number" ? data.cost : Number.NaN,
          pricing: pricingState(pricing),
          tokens: tokenSampleFromEvent(
            tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ),
          final: data.finish !== "tool-calls",
        });
        touchDispatch(sessionID, safeNow(now));
      } catch (error) {
        warn("session.step.ended failed", error);
      }
    },

    onVerdict(childSessionID: string, outcome: Verdict): void {
      try {
        const target = targetOf(childSessionID);
        if (target === null) return;
        const { record, settings, key } = target;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        // `unverifiable` updates nothing in the store (D4) but is still a row for the statistics.
        bundle.store.recordVerdict(key, outcome, signalOf(record));
        if (boundedAdd(signalled, `verdict|${outcome}|${record.attemptId}`, SIGNAL_CAP)) {
          const row: VerdictRow = {
            ...rowBase(record),
            kind: "verdict",
            decisionID: record.decisionID,
            childSessionID,
            attemptID: record.attemptId,
            key,
            verdict: outcome,
            step: record.step,
          };
          bundle.flusher.enqueue(row);
        }
        touchDispatch(childSessionID, safeNow(now));
      } catch (error) {
        warn("verdict failed", error, { childSessionID });
      }
    },

    onFalseRefusal(childSessionID: string): void {
      try {
        const target = targetOf(childSessionID);
        if (target === null) return;
        const { record, settings, key } = target;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        // The store converts an earlier `pass` of the same attempt into a failure (C5, QA-1.3-6).
        bundle.store.recordFalseRefusal(key, signalOf(record));
        if (boundedAdd(signalled, `refusal|${record.attemptId}`, SIGNAL_CAP)) {
          const row: RefusalRow = {
            ...rowBase(record),
            kind: "refusal",
            decisionID: record.decisionID,
            childSessionID,
            attemptID: record.attemptId,
            key,
            step: record.step,
          };
          bundle.flusher.enqueue(row);
        }
        touchDispatch(childSessionID, safeNow(now));
      } catch (error) {
        warn("false refusal failed", error, { childSessionID });
      }
    },

    onSessionGone(sessionID: string): void {
      try {
        if (lookupDispatch(sessionID) !== undefined) {
          closeLastAttempt(sessionID);
          forgetDispatch(sessionID);
        }
        // The orchestrator went away: its children can no longer receive verdicts.
        for (const child of forgetDispatchesOf(sessionID)) closeLastAttempt(child.childSessionID);
        warnedUnkeyed.delete(sessionID);
        if (held !== null) void held.bundle.flusher.requestFlush();
      } catch (error) {
        warn("session cleanup failed", error, { sessionID });
      }
    },

    requestFlush(): void {
      try {
        if (held !== null) void held.bundle.flusher.requestFlush();
      } catch (error) {
        warn("flush request failed", error);
      }
    },

    sweep(): void {
      try {
        sweepDispatches(safeNow(now));
        for (const child of [...lastAttemptByChild.keys()]) {
          if (lookupDispatch(child) === undefined) lastAttemptByChild.delete(child);
        }
        held?.bundle.store.sweepAttempts();
      } catch (error) {
        warn("sweep failed", error);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      const current = held;
      held = null;
      if (current === null) return;
      try {
        await current.bundle.release();
      } catch (error) {
        warn("release failed", error);
      }
    },
  };
}
