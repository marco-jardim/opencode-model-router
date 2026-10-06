// ---------------------------------------------------------------------------
// Outcome store and cost accounting (M3) — public surface and the process-wide registry (A3).
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §6.
// One store and one writer per process and outcomes directory: `acquireOutcomes` hands every caller
// (e.g. two plugin instances of the same host process) the same bundle and reference-counts it.
// No I/O of its own: persistence goes through persist.ts. Static mode never calls `acquireOutcomes`.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import type {
  LoadResult,
  OutcomeLogger,
  OutcomesBundle,
  OutcomeTuning,
  PersistDeps,
  Persister,
  FlushScheduler,
  WriteResult,
} from "./types";
import { sanitizeTuning } from "./beta";
import { createOutcomeStore } from "./store";
import { createFlusher, createPersister, nodePersistDeps, nodeScheduler } from "./persist";

export * from "./types";
export {
  DAY_MS,
  MIN_TINY,
  PRIOR_STRENGTH,
  SAME_RANK_PRIOR,
  capEvidence,
  decayFactor,
  decayTo,
  mergeBeta,
  observe,
  posteriorOf,
  priorForRankOffset,
  sanitizeTuning,
} from "./beta";
export {
  MIN_MEASURED_USD_SAMPLES,
  addTokens,
  compareUnit,
  emptyCostStats,
  expectedAttemptUSD,
  foldAttempt,
  isUnpriced,
  mergeCostStats,
  normalizePricing,
  priceTokens,
  pricingState,
  selectPriceEntry,
  stepUSD,
  taxUSD,
  tokenSampleFromEvent,
  updateMean,
  updateTokenMeans,
} from "./cost";
export { createOutcomeStore, parseSnapshot } from "./store";
export type { ParseSnapshotResult } from "./store";
export {
  compactStamp,
  createFlusher,
  createPersister,
  nodePersistDeps,
  nodePersistFs,
  nodeScheduler,
  parseLogLine,
  renameWithRetry,
  resolveOutcomesDir,
} from "./persist";

export { USAGE, parseStatsArgs, renderMarkdown, runStatsCli, summarize } from "./stats";
export type { ParseStatsResult, StatsArgs } from "./stats";

export interface AcquireOutcomesOptions {
  /** Outcomes directory (already resolved with `resolveOutcomesDir`). */
  readonly dir: string;
  readonly tuning: Partial<OutcomeTuning>;
  readonly logger: OutcomeLogger;
  /** Injected persistence dependencies (tests); defaults to `nodePersistDeps(logger)`. */
  readonly deps?: PersistDeps;
  /** Injected timers (tests); defaults to `nodeScheduler()`. */
  readonly scheduler?: FlushScheduler;
}

interface RegistryEntry {
  readonly core: Omit<OutcomesBundle, "release">;
  refs: number;
  tuning: OutcomeTuning;
}

const registry = new Map<string, RegistryEntry>();

function registryId(dir: string): string {
  const abs = resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function unreadableResult(error: unknown): LoadResult {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "corrupt", snapshot: { version: 1, entries: {} }, dropped: 0, savedAt: null, message };
}

/**
 * A persister whose writes wait for the initial load. Without it a flush that fires before the load
 * finished could overwrite the file the load is about to read (or quarantine).
 */
function gatedPersister(persister: Persister, ready: Promise<LoadResult>): Pick<Persister, "saveSnapshot" | "appendRows"> {
  return {
    async saveSnapshot(snapshot): Promise<WriteResult> {
      await ready;
      return persister.saveSnapshot(snapshot);
    },
    async appendRows(rows): Promise<WriteResult> {
      await ready;
      return persister.appendRows(rows);
    },
  };
}

function holderOf(entry: RegistryEntry, id: string): OutcomesBundle {
  let released = false;
  return {
    ...entry.core,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      if (registry.get(id) === entry) registry.delete(id);
      await entry.core.flusher.dispose();
    },
  };
}

/**
 * A3: the process-wide bundle for `options.dir`. The first caller creates the store, persister and
 * flusher and starts loading the disk snapshot; later callers (same directory, case-insensitive on
 * win32) share them and the last `tuning` wins. Each caller must `release()` its holder once; the last
 * release flushes and disposes.
 */
export function acquireOutcomes(options: AcquireOutcomesOptions): OutcomesBundle {
  const id = registryId(options.dir);
  const tuning = sanitizeTuning(options.tuning);
  const existing = registry.get(id);
  if (existing !== undefined) {
    existing.refs += 1;
    if (existing.tuning.halfLifeDays !== tuning.halfLifeDays || existing.tuning.maxEffectiveSamples !== tuning.maxEffectiveSamples) {
      options.logger.info?.("[router] outcome tuning changed; the last caller wins", { previous: existing.tuning, next: tuning });
      existing.core.store.configure(tuning);
      existing.tuning = tuning;
    }
    return holderOf(existing, id);
  }

  const deps = options.deps ?? nodePersistDeps(options.logger);
  const store = createOutcomeStore({ ...tuning, now: deps.now });
  const persister = createPersister(options.dir, deps);
  const ready: Promise<LoadResult> = persister
    .load({ quarantine: true })
    .then((result) => {
      if (result.status === "ok") store.fromSnapshot(result.snapshot, { mode: "merge" });
      return result;
    })
    .catch((error: unknown) => unreadableResult(error));
  const flusher = createFlusher(store, gatedPersister(persister, ready), {
    now: deps.now,
    scheduler: options.scheduler ?? nodeScheduler(),
    logger: options.logger,
  });
  const entry: RegistryEntry = { core: { dir: options.dir, store, persister, flusher, ready }, refs: 1, tuning };
  registry.set(id, entry);
  return holderOf(entry, id);
}
