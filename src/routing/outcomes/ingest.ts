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
  OutcomeStore,
  StepEndedTokens,
  StepSample,
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
  /** How long a loaded catalog is fresh (default 60 s); after that it is served stale while it reloads in the background. */
  readonly ttlMs?: number;
  /** After a failed or timed-out load, wait this long before trying again (default 15 s). */
  readonly retryMs?: number;
  /** The longest a lookup waits for the very first load of a catalog (default 2 s); then it answers `unpriced` (QA-2.1-5). */
  readonly loadTimeoutMs?: number;
  /** Shutdown: lookups waiting for a load return at once. The shared load itself is not cancelled. */
  readonly signal?: AbortSignal;
  /**
   * Share the table, the in-flight load and the back-off with every lookup created with the same key, in the whole
   * process (QA-2.1-2): the location directory. The first creator's `list` serves them all. Without a key the lookup
   * has a private cache.
   */
  readonly cacheKey?: string;
}

interface CatalogLoad {
  readonly promise: Promise<void>;
  readonly startedAt: number;
  /** A lookup stopped waiting for it (timeout): later lookups do not wait for it again. */
  abandoned: boolean;
}

interface CatalogState {
  table: Map<string, ModelPricing>;
  loadedAt: number | null;
  failedAt: number | null;
  loading: CatalogLoad | null;
}

const sharedCatalogs = new Map<string, CatalogState>();

/** Test-only: forget every shared catalog cache. */
export function resetCatalogPricing(): void {
  sharedCatalogs.clear();
}

function asPricing(value: unknown): ModelPricing {
  return typeof value === "object" && value !== null ? (value as ModelPricing) : undefined;
}

/**
 * Cached `provider/model → catalog cost` lookup over `list`. A model that is absent, a failed or slow first load, or
 * a lookup that was aborted gives `undefined`, which {@link pricingState} reads as `unpriced` (A1): a `0` cost is then
 * stored as unknown and only a positive host-reported cost is kept.
 *
 * It never blocks the serial event loop for long (QA-2.1-5): once a table has loaded it is served immediately, stale
 * after the TTL while it reloads in the background; only the first lookup of a cold catalog waits, for at most
 * `loadTimeoutMs` and never past `signal`; a failed or timed-out load backs off for `retryMs`. Never rejects.
 */
export function createCatalogPricing(
  list: () => Promise<readonly CatalogModel[]>,
  options: CatalogPricingOptions = {},
): PricingLookup {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  const retryMs = options.retryMs ?? 15_000;
  const loadTimeoutMs = options.loadTimeoutMs ?? 2_000;
  const { signal, logger } = options;
  let state: CatalogState | undefined = options.cacheKey === undefined ? undefined : sharedCatalogs.get(options.cacheKey);
  if (state === undefined) {
    state = { table: new Map(), loadedAt: null, failedAt: null, loading: null };
    if (options.cacheKey !== undefined) sharedCatalogs.set(options.cacheKey, state);
  }
  const shared = state;

  const startLoad = (t: number): CatalogLoad => {
    const run = async (): Promise<void> => {
      try {
        const models = await list();
        const next = new Map<string, ModelPricing>();
        for (const model of models) next.set(`${model.providerID}/${model.id}`, asPricing(model.cost));
        shared.table = next;
        shared.loadedAt = safeNow(now);
        shared.failedAt = null;
      } catch (error) {
        shared.failedAt = safeNow(now);
        logger?.warn("[router] outcome ingestion: model catalog unavailable; step costs treated as unpriced", {
          error: describe(error),
        });
      }
    };
    const load: CatalogLoad = {
      startedAt: t,
      abandoned: false,
      promise: run().finally(() => {
        if (shared.loading === load) shared.loading = null;
      }),
    };
    shared.loading = load;
    return load;
  };

  /** Wait for `load`, but not longer than `loadTimeoutMs` and not past an abort. */
  const waitFor = (load: CatalogLoad): Promise<"done" | "timeout" | "aborted"> => {
    if (signal?.aborted === true) return Promise.resolve("aborted");
    return new Promise<"done" | "timeout" | "aborted">((resolve) => {
      const onAbort = (): void => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), loadTimeoutMs);
      timer.unref();
      const finish = (outcome: "done" | "timeout" | "aborted"): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void load.promise.then(() => finish("done"));
    });
  };

  return async (provider, model) => {
    const t = safeNow(now);
    const fresh = shared.loadedAt !== null && t - shared.loadedAt < ttlMs;
    if (!fresh) {
      const backingOff = shared.failedAt !== null && t - shared.failedAt < retryMs;
      let load = shared.loading;
      // A load that hung is replaced once the back-off has passed.
      if (load !== null && load.abandoned && t - load.startedAt >= retryMs) load = null;
      if (load === null && !backingOff) load = startLoad(t);
      if (shared.loadedAt === null && load !== null && !load.abandoned) {
        const outcome = await waitFor(load);
        if (outcome === "timeout" && shared.loadedAt === null) {
          load.abandoned = true;
          shared.failedAt = safeNow(now);
          logger?.warn("[router] outcome ingestion: model catalog is slow; step costs treated as unpriced", { loadTimeoutMs });
        }
      }
    }
    return shared.table.get(`${provider}/${model}`);
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
/** Final steps held back until their attempt ends (QA-2.1-6). */
const HELD_FINAL_CAP = 2000;
/** A held final step whose attempt never reported its end is folded after this idle time (the store's own default). */
const HELD_FINAL_IDLE_MS = 30 * 60_000;
/** Model references already reported as unkeyable (model unresolved), one warning each. */
const WARNED_CAP = 500;

const seenEvents = new Map<string, true>();
const signalled = new Set<string>();
/** What scored each attempt in the store (`pass`, `fail` or `refusal`), so a refusal knows whether it converts a pass. */
const scored = new Map<string, "pass" | "fail" | "refusal">();
/** `${outcomesDir}|${child}` → the attempt the child's latest step belongs to (a store in another directory is another recording). */
const lastAttemptByChild = new Map<string, LastAttempt>();
const warnedUnkeyed = new Set<string>();

interface LastAttempt {
  readonly dir: string;
  readonly attempt: string;
}

interface HeldFinal {
  readonly dir: string;
  readonly attempt: string;
  readonly key: OutcomeKey;
  /** Already marked `final`: recorded as such when the attempt ends. */
  readonly sample: StepSample;
  readonly at: number;
}
/**
 * QA-2.1-6: a step that finished with anything but `tool-calls` only sets the attempt's `finalOutput`; the attempt
 * stays open (a `length` or `error` finish may be followed by more steps) and is folded when its execution ends. The
 * step is held here, outside the store, until the next step of the attempt (then it was not the last), the end of the
 * execution, the session's deletion, a sweep or a dispose.
 */
const heldFinals = new Map<string, HeldFinal>();

function boundedSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

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

const scopeKey = (dir: string, id: string): string => `${dir}|${id}`;

function rememberAttempt(dir: string, child: string, attemptId: string): string | undefined {
  const mapKey = scopeKey(dir, child);
  const previous = lastAttemptByChild.get(mapKey)?.attempt;
  lastAttemptByChild.delete(mapKey);
  lastAttemptByChild.set(mapKey, { dir, attempt: attemptId });
  while (lastAttemptByChild.size > LAST_ATTEMPT_CAP) {
    const oldest = lastAttemptByChild.keys().next();
    if (oldest.done === true) break;
    lastAttemptByChild.delete(oldest.value);
  }
  return previous;
}

/** Test-only: drop the module-scope dedupe and attempt state (the dispatch registry has its own reset). */
export function resetIngestState(): void {
  resetCatalogPricing();
  seenEvents.clear();
  signalled.clear();
  scored.clear();
  lastAttemptByChild.clear();
  warnedUnkeyed.clear();
  heldFinals.clear();
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
  /**
   * `session.step.ended` (and `session.step.failed`, when it carries a cost or tokens) of a registered child. Awaits
   * only the cached catalog lookup, bounded by its load timeout. Never rejects.
   */
  onStepEnded(event: IngestEvent): Promise<void>;
  /** The child's execution ended (succeeded, failed or interrupted): its open attempt is folded (QA-2.1-6). */
  onExecutionEnded(childSessionID: string): void;
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
/** An ingest that does nothing (a v2 adapter started without the plugin's own). */
export const NOOP_INGEST: Ingest = Object.freeze({
  onStepEnded: () => Promise.resolve(),
  onExecutionEnded: () => undefined,
  onVerdict: () => undefined,
  onFalseRefusal: () => undefined,
  onSessionGone: () => undefined,
  requestFlush: () => undefined,
  sweep: () => undefined,
  dispose: () => Promise.resolve(),
});

/** The v2 events that end a session's execution (the adapter maps them to `session.idle`). */
export const EXECUTION_END_TYPES: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

export const FLUSH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.idle",
  "session.deleted",
  ...EXECUTION_END_TYPES,
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
    // Registry first: most `session.step.ended` events belong to sessions that are not registered children
    // (the orchestrator's own), and the settings may cost a config fingerprint check.
    const record = lookupDispatch(childSessionID);
    if (record === undefined) return null;
    const settings = deps.settings();
    if (settings === null) return null;
    const confidence = record.facts.confidence;
    // Phase 1.2 handoff (QA-1.2-27): a class below the threshold is "unknown" for learning, not a class of
    // its own. No fallback class, no store call, no row.
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < settings.minClassConfidence) {
      return null;
    }
    const cls = record.facts.class;
    if (typeof cls !== "string" || cls === "" || cls === "unknown") return null;
    if (record.model === null) return unkeyable(`${record.agent}|`, childSessionID, "the dispatch registered no model");
    const ref = splitModelRef(record.model);
    if (ref === null) return unkeyable(`${record.agent}|${record.model}`, childSessionID, `model "${record.model}" is not provider/model`);
    const variant = record.variant ?? ref.variant;
    const origin = classifyAgentOrigin(record.agent, settings.routerAgentIds);
    const key = makeKey(cls, { origin, id: record.agent }, ref.provider, ref.model, variant);
    return { record, settings, key };
  };

  // One warning per model reference (QA-2.1-12), not per child: every child of an unresolved agent says the same.
  const unkeyable = (reference: string, childSessionID: string, why: string): null => {
    if (boundedAdd(warnedUnkeyed, reference, WARNED_CAP)) {
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

  /** Held final steps this instance created (`${dir}|${attempt}`), released with it. */
  const ownedHeld = new Set<string>();

  /** The outcomes directory this instance writes to right now, or null when ingestion is off. */
  const currentDir = (): string | null => held?.dir ?? deps.settings()?.outcomesDir ?? null;

  /** The shared store of `dir`, through this instance's bundle when it has one; null when ingestion is off for `dir`. */
  const storeOf = (dir: string): OutcomeStore | null => {
    if (held !== null) return held.dir === dir ? held.bundle.store : null;
    const settings = deps.settings();
    return settings === null || settings.outcomesDir !== dir ? null : (bundleFor(settings)?.store ?? null);
  };

  /** Record the held final step of an attempt: as its last step (`asFinal`, folds the attempt) or as a plain step. */
  const settle = (dir: string, attemptId: string, asFinal: boolean): void => {
    const heldKey = scopeKey(dir, attemptId);
    const pending = heldFinals.get(heldKey);
    if (pending === undefined) return;
    heldFinals.delete(heldKey);
    ownedHeld.delete(heldKey);
    storeOf(dir)?.recordStep(pending.key, asFinal ? pending.sample : { ...pending.sample, final: false });
  };

  /** Fold an attempt that is over: its held final step first, then whatever is still open. */
  const endAttempt = (dir: string, attemptId: string): void => {
    settle(dir, attemptId, true);
    storeOf(dir)?.closeAttempt(attemptId);
  };

  const closeLastAttempt = (childSessionID: string): void => {
    const dir = currentDir();
    if (dir === null) return;
    const mapKey = scopeKey(dir, childSessionID);
    const last = lastAttemptByChild.get(mapKey);
    lastAttemptByChild.delete(mapKey);
    if (last !== undefined) endAttempt(last.dir, last.attempt);
  };

  const settleOwned = (): void => {
    for (const heldKey of [...ownedHeld]) {
      const pending = heldFinals.get(heldKey);
      if (pending === undefined) ownedHeld.delete(heldKey);
      else settle(pending.dir, pending.attempt, true);
    }
  };

  /** QA-2.1-11: ingestion went off (engine switched to static): finish what is pending and let the bundle go. */
  const dropIfOff = (): boolean => {
    if (held === null || deps.settings() !== null) return false;
    settleOwned();
    const current = held;
    held = null;
    void current.bundle.release().catch((error: unknown) => warn("releasing the outcomes bundle failed", error));
    return true;
  };
  return {
    async onStepEnded(event: IngestEvent): Promise<void> {
      try {
        const failed = event.type === "session.step.failed";
        if ((event.type !== "session.step.ended" && !failed) || !isRecord(event.data)) return;
        const data = event.data;
        const sessionID = data.sessionID;
        if (typeof sessionID !== "string") return;
        const first = targetOf(sessionID);
        if (first === null) return;
        const tokens = isRecord(data.tokens) ? (data.tokens as unknown as StepEndedTokens) : undefined;
        // A failed step reports cost and tokens only when it got that far (QA-2.1-6): nothing measured, nothing to add.
        if (failed && typeof data.cost !== "number" && tokens === undefined) return;
        const eventKey =
          typeof event.id === "string" && event.id !== ""
            ? event.id
            : `${sessionID}|${String(data.assistantMessageID)}|${String(data.cost)}|${tokens?.input}|${tokens?.output}`;
        // Pricing first (cached, or bounded by the catalog's own load timeout): a slow lookup must not decide
        // which instance owns the event (QA-2.1-2).
        const ref = splitModelRef(first.record.model ?? "");
        const pricing = ref === null || deps.pricing === undefined ? undefined : await deps.pricing(ref.provider, ref.model);
        if (disposed) return;
        // From here on everything is synchronous, so the check and the record of an event id cannot interleave
        // with another instance. The registry and the settings may have changed during the await.
        const target = targetOf(sessionID);
        if (target === null) return;
        const { record, settings, key } = target;
        // Dedupe only a step that is about to be recorded: an instance whose own settings are static must not
        // consume the event another instance (another location, another config) will record. The directory is
        // part of the key (QA-2.1-8): a store in another directory is a different recording.
        if (!firstDelivery(`${settings.outcomesDir}|${eventKey}`)) return;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        const dir = settings.outcomesDir;
        const superseded = rememberAttempt(dir, sessionID, record.attemptId);
        if (superseded !== undefined && superseded !== record.attemptId) endAttempt(dir, superseded);
        const sample: StepSample = {
          attemptID: record.attemptId,
          cost: typeof data.cost === "number" ? data.cost : Number.NaN,
          pricing: pricingState(pricing),
          tokens: tokenSampleFromEvent(
            tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          ),
          final: false,
        };
        // A step after a held final one proves that one was not the last.
        settle(dir, record.attemptId, false);
        if (!failed && data.finish !== "tool-calls") {
          const heldKey = scopeKey(dir, record.attemptId);
          boundedSet(heldFinals, heldKey, { dir, attempt: record.attemptId, key, sample: { ...sample, final: true }, at: safeNow(now) }, HELD_FINAL_CAP);
          ownedHeld.add(heldKey);
        } else {
          bundle.store.recordStep(key, sample);
        }
        touchDispatch(sessionID, safeNow(now));
      } catch (error) {
        warn("session.step.ended failed", error);
      }
    },
    onExecutionEnded(childSessionID: string): void {
      try {
        if (lookupDispatch(childSessionID) === undefined) return;
        closeLastAttempt(childSessionID);
      } catch (error) {
        warn("execution end failed", error, { childSessionID });
      }
    },

    onVerdict(childSessionID: string, outcome: Verdict): void {
      try {
        const target = targetOf(childSessionID);
        if (target === null) return;
        const { record, settings, key } = target;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        const attempt = record.attemptId;
        // Rows follow the store (QA-2.1-3): a verdict that moves nothing (the attempt was scored already, by a
        // verdict or a refusal) writes no row, or `routing:stats` would count outcomes the store never saw.
        // `unverifiable` moves nothing by design; it is a row only while the attempt is still unscored.
        if (outcome === "unverifiable") {
          if (scored.has(attempt) || !boundedAdd(signalled, `unverifiable|${attempt}`, SIGNAL_CAP)) return;
        } else {
          if (!bundle.store.recordVerdict(key, outcome, signalOf(record))) return;
          boundedSet(scored, attempt, outcome, SIGNAL_CAP);
        }
        const row: VerdictRow = {
          ...rowBase(record),
          kind: "verdict",
          decisionID: record.decisionID,
          childSessionID,
          attemptID: attempt,
          key,
          verdict: outcome,
          step: record.step,
        };
        bundle.flusher.enqueue(row);
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
        const attempt = record.attemptId;
        // One refusal per attempt (QA-2.1-9): a repeat must not reach the store, whose lifetime counter would grow.
        if (!boundedAdd(signalled, `refusal|${attempt}`, SIGNAL_CAP)) return;
        const bundle = bundleFor(settings);
        if (bundle === null) return;
        const prior = scored.get(attempt);
        // The store converts an earlier `pass` of the same attempt into a failure (C5, QA-1.3-6); the row says so,
        // and `routing:stats` moves that pass to a fail the same way.
        const changed = bundle.store.recordFalseRefusal(key, signalOf(record));
        boundedSet(scored, attempt, "refusal", SIGNAL_CAP);
        const row: RefusalRow = {
          ...rowBase(record),
          kind: "refusal",
          decisionID: record.decisionID,
          childSessionID,
          attemptID: attempt,
          key,
          step: record.step,
          ...(prior === "pass" && changed ? { overrides: "pass" as const } : {}),
        };
        bundle.flusher.enqueue(row);
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
        if (held !== null) void held.bundle.flusher.requestFlush();
      } catch (error) {
        warn("session cleanup failed", error, { sessionID });
      }
    },

    requestFlush(): void {
      try {
        if (dropIfOff()) return;
        if (held !== null) void held.bundle.flusher.requestFlush();
      } catch (error) {
        warn("flush request failed", error);
      }
    },

    sweep(): void {
      try {
        dropIfOff();
        const t = safeNow(now);
        sweepDispatches(t);
        // A child that was swept away can no longer end its attempt: fold it.
        for (const [mapKey, last] of [...lastAttemptByChild]) {
          const child = mapKey.slice(last.dir.length + 1);
          if (lookupDispatch(child) !== undefined) continue;
          lastAttemptByChild.delete(mapKey);
          endAttempt(last.dir, last.attempt);
        }
        for (const pending of [...heldFinals.values()]) {
          if (t - pending.at >= HELD_FINAL_IDLE_MS) settle(pending.dir, pending.attempt, true);
        }
        held?.bundle.store.sweepAttempts();
      } catch (error) {
        warn("sweep failed", error);
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      settleOwned();
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
