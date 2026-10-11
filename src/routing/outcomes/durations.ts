// ---------------------------------------------------------------------------
// Dispatch duration estimator (Phase 1.1, task 1.1.3).
//
// Estimates how long a child dispatch of (role, class, scope) takes, from the rows of `timings.jsonl`
// (`DispatchTimingRow`). Pure module: no I/O of its own, the rows come through the injected `readTimings` seam
// and the clock through `now`. Like every module under src/routing/outcomes/ it must stay runnable under Node's
// type stripping: `import type` only, no enum, namespace or parameter property.
//
// Rules:
//   - fallback: exact (role, class, scope) -> (role, class) -> role -> prior. A level answers p50 only with at least
//     `minSamples` samples; otherwise the next, coarser level is tried. p90 needs at least `p90MinSamples` (10): it
//     comes from the finest level, from the p50 level on, that has them, else from the prior (never below p50);
//   - rows that ended more than a day after `now()` are ignored (a clock jump wrote them);
//   - only rows with `outcome: "succeeded"` count, and rows whose `capacity` is not null are excluded (ADR 0007 D6:
//     a provider capacity condition says nothing about how long the work takes);
//   - p50 / p90 are nearest-rank percentiles (rank = ceil(p * n), 1-based) over the newest `window` rows of the key
//     whose `endedAt` is within `maxAgeDays` of `now()`;
//   - the prior answers p50 = p90 = `priorMs`, n = 0, source "prior";
//   - memory is bounded: at most `window` newest rows are kept per key and level.
//
// Loading: `estimate` is synchronous. Call `await load()` once (idempotent; concurrent callers share one read) to
// fold the persisted rows in; until it resolves, `estimate` sees only the rows given to `observe`. `observe(row)`
// folds a live row in at any time. A row seen twice (from the file and from `observe`) counts once.
// ---------------------------------------------------------------------------

import type { DispatchTimingRow } from "./types";

export const DURATION_WINDOW = 50;
export const DURATION_MAX_AGE_DAYS = 30;
export const DURATION_PRIOR_MS = 480_000;
export const DURATION_MIN_SAMPLES = 5;
/** Samples a level needs before its p90 is reported (QA-1.1-10). */
export const DURATION_P90_MIN_SAMPLES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A row that ended later than `now` by more than this is ignored (QA-1.1-9: the clock that wrote it jumped forward). */
const MAX_FUTURE_ENDED_MS = DAY_MS;
const SEP = "\u0000";

export type DurationSource = "exact" | "role-class" | "role" | "prior";

export interface DurationEstimate {
  readonly p50: number;
  readonly p90: number;
  /** Samples behind the estimate (0 for the prior). */
  readonly n: number;
  readonly source: DurationSource;
}

export interface DurationQuery {
  readonly role: string;
  readonly class: string;
  readonly scope: string;
}

export interface DurationSeams {
  /** The persisted dispatch-timing rows (any order). Called once by `load()`. */
  readonly readTimings: () => Promise<readonly DispatchTimingRow[]> | readonly DispatchTimingRow[];
  /** Epoch milliseconds. */
  readonly now: () => number;
}

export interface DurationOptions {
  /** Newest rows kept and used per key (default 50). */
  readonly window?: number;
  /** Rows ended longer ago than this are ignored (default 30). */
  readonly maxAgeDays?: number;
  /** p50 = p90 of the prior, in milliseconds (default 480000). */
  readonly priorMs?: number;
  /** Samples a level needs to answer p50 (default 5). */
  readonly minSamples?: number;
  /** Samples a level needs to answer p90 (default 10); a thinner level hands p90 to a coarser one, else to the prior. */
  readonly p90MinSamples?: number;
}

export interface DurationModel {
  /** Synchronous. Uses the rows loaded and observed so far. */
  estimate(query: DurationQuery): DurationEstimate;
  /** Folds one live row in. Rows that do not count (not succeeded, capacity, malformed numbers) are ignored. */
  observe(row: DispatchTimingRow): void;
  /** Reads `readTimings` once and folds its rows in. Idempotent; never rejects (a failed read leaves the model on the prior). */
  load(): Promise<void>;
}

interface Sample {
  readonly endedAt: number;
  readonly durationMs: number;
  readonly id: string;
}

interface Bucket {
  /** Ascending by endedAt, at most `window` long. */
  readonly list: Sample[];
  /** Ids of `list`. */
  readonly ids: Set<string>;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Nearest rank on an ascending-sorted, non-empty list. */
function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] as number;
}

export function createDurationModel(seams: DurationSeams, opts: DurationOptions = {}): DurationModel {
  const window = positiveInt(opts.window, DURATION_WINDOW);
  const maxAgeMs = positiveNumber(opts.maxAgeDays, DURATION_MAX_AGE_DAYS) * DAY_MS;
  const priorMs = opts.priorMs !== undefined && Number.isFinite(opts.priorMs) && opts.priorMs >= 0 ? opts.priorMs : DURATION_PRIOR_MS;
  const minSamples = positiveInt(opts.minSamples, DURATION_MIN_SAMPLES);

  const p90MinSamples = positiveInt(opts.p90MinSamples, DURATION_P90_MIN_SAMPLES);

  // One map per level; each bucket holds the newest `window` samples of its key, ascending by endedAt, and the set of
  // their row ids (QA-1.1-11: the dedupe is a set lookup, not a scan of the list).
  const exact = new Map<string, Bucket>();
  const roleClass = new Map<string, Bucket>();
  const role = new Map<string, Bucket>();
  let loading: Promise<void> | null = null;

  function insert(level: Map<string, Bucket>, key: string, sample: Sample): void {
    let bucket = level.get(key);
    if (bucket === undefined) {
      bucket = { list: [], ids: new Set() };
      level.set(key, bucket);
    }
    if (bucket.ids.has(sample.id)) return;
    const { list } = bucket;
    let at = list.length;
    while (at > 0 && (list[at - 1] as Sample).endedAt > sample.endedAt) at -= 1;
    list.splice(at, 0, sample);
    bucket.ids.add(sample.id);
    if (list.length > window) {
      for (const dropped of list.splice(0, list.length - window)) bucket.ids.delete(dropped.id);
    }
  }

  function observe(row: DispatchTimingRow): void {
    if (row.outcome !== "succeeded" || row.capacity !== null) return;
    if (!Number.isFinite(row.endedAt) || !Number.isFinite(row.durationMs) || row.durationMs < 0) return;
    const sample: Sample = {
      endedAt: row.endedAt,
      durationMs: row.durationMs,
      id: `${row.childSessionID}${SEP}${row.callID}${SEP}${row.endedAt}`,
    };
    insert(exact, `${row.role}${SEP}${row.class}${SEP}${row.scope}`, sample);
    insert(roleClass, `${row.role}${SEP}${row.class}`, sample);
    insert(role, row.role, sample);
  }

  /**
   * Durations (ascending) of the key's samples within the age limit and not from the future (QA-1.1-9: a row that ended more
   * than a day after `now` carries a bad clock). Empty when there are none.
   */
  function durationsOf(level: Map<string, Bucket>, key: string, cutoff: number, ceiling: number): number[] {
    const bucket = level.get(key);
    if (bucket === undefined) return [];
    const durations: number[] = [];
    for (const sample of bucket.list) if (sample.endedAt >= cutoff && sample.endedAt <= ceiling) durations.push(sample.durationMs);
    return durations.sort((a, b) => a - b);
  }

  /**
   * p50 comes from the finest level with at least `minSamples` samples. p90 (QA-1.1-10) comes from the finest level, starting
   * at that one, with at least `p90MinSamples` (10) samples, else from the prior: a tail estimate needs a tail. p90 is never
   * reported below p50.
   */
  function estimate(query: DurationQuery): DurationEstimate {
    const t = seams.now();
    const now = Number.isFinite(t) ? t : Date.now();
    const cutoff = now - maxAgeMs;
    const ceiling = now + MAX_FUTURE_ENDED_MS;
    const levels: Array<{ readonly source: DurationSource; readonly durations: number[] }> = [
      { source: "exact", durations: durationsOf(exact, `${query.role}${SEP}${query.class}${SEP}${query.scope}`, cutoff, ceiling) },
      { source: "role-class", durations: durationsOf(roleClass, `${query.role}${SEP}${query.class}`, cutoff, ceiling) },
      { source: "role", durations: durationsOf(role, query.role, cutoff, ceiling) },
    ];
    const start = levels.findIndex((level) => level.durations.length >= minSamples);
    if (start < 0) return { p50: priorMs, p90: priorMs, n: 0, source: "prior" };
    const chosen = levels[start] as (typeof levels)[number];
    const p50 = nearestRank(chosen.durations, 0.5);
    const tail = levels.slice(start).find((level) => level.durations.length >= p90MinSamples);
    const p90 = tail === undefined ? priorMs : nearestRank(tail.durations, 0.9);
    return { p50, p90: Math.max(p90, p50), n: chosen.durations.length, source: chosen.source };
  }

  function load(): Promise<void> {
    if (loading === null) {
      loading = (async () => {
        try {
          const rows = await seams.readTimings();
          for (const row of rows) observe(row);
        } catch {
          // A failed read leaves the model on what `observe` supplied (and the prior): estimating must never throw.
          return;
        }
      })();
    }
    return loading;
  }

  return { estimate, observe, load };
}
