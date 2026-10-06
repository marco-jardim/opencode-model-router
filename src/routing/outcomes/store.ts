// ---------------------------------------------------------------------------
// Outcome store (M3): per-key Beta evidence (D4), per-attempt cost accounting (D6), snapshot/restore.
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §4.
// Pure core: no I/O. The clock is injected (`Date.now` is only the default). Single writer per process
// (A3) is enforced by index.ts; this module is a plain in-memory object.
// ---------------------------------------------------------------------------

import type {
  AttemptSignal,
  BetaPrior,
  BetaState,
  CostStats,
  MeanStat,
  OpenAttempt,
  OutcomeCounts,
  OutcomeEntrySnapshot,
  OutcomeKey,
  OutcomeSnapshot,
  OutcomeStore,
  OutcomeStoreOptions,
  OutcomeTuning,
  SnapshotLoadReport,
  StepSample,
  TokenMeans,
  Verdict,
} from "./types";
import { OUTCOMES_SCHEMA_ID, OUTCOMES_SCHEMA_VERSION, parseKey, safeNow } from "./types";
import { MIN_TINY, SAME_RANK_PRIOR, capEvidence, decayFactor, decayTo, mergeBeta, observe, posteriorOf, sanitizeTuning } from "./beta";
import {
  addTokens,
  cleanTokenSample,
  emptyCostStats,
  emptyTokenSample,
  foldAttempt,
  mergeCostStats,
  stepUSD,
} from "./cost";

const DEFAULT_MAX_OPEN_ATTEMPTS = 256;
const DEFAULT_MAX_SCORED_ATTEMPTS = 4096;
const DEFAULT_MAX_IDLE_MS = 30 * 60_000;

/** Internal mutable entry. Every field is replaced (never mutated in place), so values handed out stay stable. */
interface Entry {
  readonly cls: string;
  beta: BetaState;
  counts: OutcomeCounts;
  cost: CostStats;
}

const ZERO_COUNTS: OutcomeCounts = Object.freeze({
  pass: 0,
  fail: 0,
  falseRefusals: 0,
  variantPass: 0,
  variantFail: 0,
});

function deepFreeze<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}

const EMPTY_COST: CostStats = deepFreeze(emptyCostStats());

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** LRU on a Map: refresh = delete + set; evict from the front. */
function remember<V>(map: Map<string, V>, id: string, value: V, max: number): void {
  map.delete(id);
  map.set(id, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

/** What scored an attempt (QA-1.3-6): enough to convert a pass into a failure when a false refusal follows it. */
interface ScoredInfo {
  readonly key: OutcomeKey;
  readonly kind: "pass" | "fail" | "refusal";
  /** Instant of the Beta observation. */
  readonly at: number;
  /** The scoring signal was a `variant` step. */
  readonly variant: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot validation (shared by fromSnapshot and parseSnapshot)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function isNonNegFinite(x: unknown): x is number {
  return isFiniteNum(x) && x >= 0;
}

function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function readMean(x: unknown): MeanStat | null {
  if (!isRec(x) || !isNonNegFinite(x.mean) || !isCount(x.n)) return null;
  return { mean: x.mean, n: x.n };
}

function readTokenMeans(x: unknown): TokenMeans | null {
  if (!isRec(x) || !isCount(x.n)) return null;
  const { input, output, reasoning, cacheRead, cacheWrite } = x;
  if (!isNonNegFinite(input) || !isNonNegFinite(output) || !isNonNegFinite(reasoning)) return null;
  if (!isNonNegFinite(cacheRead) || !isNonNegFinite(cacheWrite)) return null;
  return { n: x.n, input, output, reasoning, cacheRead, cacheWrite };
}

function readCounts(x: unknown): OutcomeCounts | null {
  if (!isRec(x)) return null;
  const { pass, fail, falseRefusals, variantPass, variantFail } = x;
  if (!isCount(pass) || !isCount(fail) || !isCount(falseRefusals) || !isCount(variantPass) || !isCount(variantFail)) {
    return null;
  }
  return { pass, fail, falseRefusals, variantPass, variantFail };
}

function readCost(x: unknown): CostStats | null {
  if (!isRec(x) || !isCount(x.unpricedAttempts)) return null;
  const measuredUSD = readMean(x.measuredUSD);
  const tokens = readTokenMeans(x.tokens);
  const steps = readMean(x.steps);
  const finalMessageTokens = readMean(x.finalMessageTokens);
  if (!measuredUSD || !tokens || !steps || !finalMessageTokens) return null;
  return { measuredUSD, unpricedAttempts: x.unpricedAttempts, tokens, steps, finalMessageTokens };
}

/** Validate one persisted entry and return a deep copy of plain numbers, or null when invalid. */
function readEntry(key: string, value: unknown): Entry | null {
  const parts = parseKey(key);
  if (parts === null || !isRec(value)) return null;
  const b = value.beta;
  if (!isRec(b) || !isNonNegFinite(b.alpha) || !isNonNegFinite(b.beta) || !isFiniteNum(b.updatedAt)) return null;
  const counts = readCounts(value.counts);
  const cost = readCost(value.cost);
  if (!counts || !cost) return null;
  return { cls: parts.cls, beta: { alpha: b.alpha, beta: b.beta, updatedAt: b.updatedAt }, counts, cost };
}

function entrySnapshot(entry: Entry): OutcomeEntrySnapshot {
  return {
    beta: { alpha: entry.beta.alpha, beta: entry.beta.beta, updatedAt: entry.beta.updatedAt },
    counts: { ...entry.counts },
    cost: {
      measuredUSD: { ...entry.cost.measuredUSD },
      unpricedAttempts: entry.cost.unpricedAttempts,
      tokens: { ...entry.cost.tokens },
      steps: { ...entry.cost.steps },
      finalMessageTokens: { ...entry.cost.finalMessageTokens },
    },
  };
}

function addCounts(a: OutcomeCounts, b: OutcomeCounts): OutcomeCounts {
  return {
    pass: a.pass + b.pass,
    fail: a.fail + b.fail,
    falseRefusals: a.falseRefusals + b.falseRefusals,
    variantPass: a.variantPass + b.variantPass,
    variantFail: a.variantFail + b.variantFail,
  };
}

// ---------------------------------------------------------------------------
// Foreign-writer deltas (QA-1.3-4): disk − baseline, per entry
// ---------------------------------------------------------------------------

/** `disk − base` of a running mean: exact arithmetic while neither side has passed the effective-sample cap. */
function subMean(disk: MeanStat, base: MeanStat): MeanStat {
  const n = disk.n - base.n;
  if (n <= 0) return { mean: 0, n: 0 };
  return { mean: Math.max(0, (disk.mean * disk.n - base.mean * base.n) / n), n };
}

function subTokenMeans(disk: TokenMeans, base: TokenMeans): TokenMeans {
  const n = disk.n - base.n;
  if (n <= 0) return { n: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const part = (d: number, b: number): number => Math.max(0, (d * disk.n - b * base.n) / n);
  return {
    n,
    input: part(disk.input, base.input),
    output: part(disk.output, base.output),
    reasoning: part(disk.reasoning, base.reasoning),
    cacheRead: part(disk.cacheRead, base.cacheRead),
    cacheWrite: part(disk.cacheWrite, base.cacheWrite),
  };
}

/**
 * What another writer added to an entry since `base` was synced: counters and attempt-weighted means
 * subtract exactly (means while n ≤ maxEffectiveSamples, then they are EWMAs and the delta is approximate);
 * the Beta evidence is subtracted at a common instant and floored at 0.
 */
function subtractEntry(disk: Entry, base: Entry, tuning: OutcomeTuning): Entry {
  const t = Math.max(disk.beta.updatedAt, base.beta.updatedAt);
  const d = decayTo(disk.beta, t, tuning);
  const b = decayTo(base.beta, t, tuning);
  let alpha = Math.max(0, d.alpha - b.alpha);
  let beta = Math.max(0, d.beta - b.beta);
  if (alpha + beta < MIN_TINY) {
    alpha = 0;
    beta = 0;
  }
  const dc = disk.counts;
  const bc = base.counts;
  return {
    cls: disk.cls,
    beta: { alpha, beta, updatedAt: t },
    counts: {
      pass: Math.max(0, dc.pass - bc.pass),
      fail: Math.max(0, dc.fail - bc.fail),
      falseRefusals: Math.max(0, dc.falseRefusals - bc.falseRefusals),
      variantPass: Math.max(0, dc.variantPass - bc.variantPass),
      variantFail: Math.max(0, dc.variantFail - bc.variantFail),
    },
    cost: {
      measuredUSD: subMean(disk.cost.measuredUSD, base.cost.measuredUSD),
      unpricedAttempts: Math.max(0, disk.cost.unpricedAttempts - base.cost.unpricedAttempts),
      tokens: subTokenMeans(disk.cost.tokens, base.cost.tokens),
      steps: subMean(disk.cost.steps, base.cost.steps),
      finalMessageTokens: subMean(disk.cost.finalMessageTokens, base.cost.finalMessageTokens),
    },
  };
}

function isEmptyEntry(e: Entry): boolean {
  const c = e.counts;
  const k = e.cost;
  return (
    e.beta.alpha + e.beta.beta === 0 &&
    c.pass + c.fail + c.falseRefusals + c.variantPass + c.variantFail === 0 &&
    k.unpricedAttempts === 0 &&
    k.measuredUSD.n + k.tokens.n + k.steps.n + k.finalMessageTokens.n === 0
  );
}

export type ParseSnapshotResult =
  | { readonly ok: true; readonly snapshot: OutcomeSnapshot; readonly dropped: number }
  | { readonly ok: false; readonly reason: "unsupported-version" | "corrupt"; readonly message: string };

/**
 * Validate a parsed `outcomes.json` envelope. A newer `version`, another schema, a non-object or a
 * non-integer `version` is `unsupported-version` (never quarantined or overwritten by this plugin);
 * `version < 1` or a missing `entries` object on our schema is `corrupt`. Invalid entries are dropped
 * and counted; the valid ones come back with keys in sorted order.
 */
export function parseSnapshot(json: unknown): ParseSnapshotResult {
  // QA-1.3-11: valid JSON that is not a version-1 outcome store is somebody else's file (or a newer
  // format): report it as `unsupported-version` so it is never quarantined or overwritten.
  if (!isRec(json)) {
    return { ok: false, reason: "unsupported-version", message: "not an outcome store: the top-level JSON value is not an object" };
  }
  if (json.schema !== OUTCOMES_SCHEMA_ID) {
    return { ok: false, reason: "unsupported-version", message: `not an outcome store: unexpected schema ${JSON.stringify(json.schema)}` };
  }
  const version = json.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, reason: "unsupported-version", message: `unrecognized outcome store version ${JSON.stringify(version)}` };
  }
  if (version > OUTCOMES_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "unsupported-version",
      message: `unsupported outcome store version ${version} (this plugin reads version ${OUTCOMES_SCHEMA_VERSION})`,
    };
  }
  if (version < 1) return { ok: false, reason: "corrupt", message: `invalid version ${version}` };
  if (!isRec(json.entries)) return { ok: false, reason: "corrupt", message: "missing entries object" };

  const valid: Array<readonly [string, OutcomeEntrySnapshot]> = [];
  let dropped = 0;
  for (const [key, value] of Object.entries(json.entries)) {
    const entry = readEntry(key, value);
    if (entry === null) dropped += 1;
    else valid.push([key, entrySnapshot(entry)]);
  }
  valid.sort((a, b) => compareCodeUnits(a[0], b[0]));
  const entries: Record<string, OutcomeEntrySnapshot> = {};
  for (const [key, snap] of valid) entries[key] = snap;
  return { ok: true, snapshot: { version: OUTCOMES_SCHEMA_VERSION, entries }, dropped };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createOutcomeStore(options: OutcomeStoreOptions = {}): OutcomeStore {
  const now = options.now ?? Date.now;
  /** One reading of the clock; a non-finite reading falls back to Date.now() (QA-1.3-7). */
  const clockNow = (): number => safeNow(now);
  const maxOpen = Math.max(1, Math.floor(options.maxOpenAttempts ?? DEFAULT_MAX_OPEN_ATTEMPTS));
  const maxScored = Math.max(1, Math.floor(options.maxScoredAttempts ?? DEFAULT_MAX_SCORED_ATTEMPTS));
  let tuning: OutcomeTuning = sanitizeTuning(options);
  let revision = 0;

  const entries = new Map<OutcomeKey, Entry>();
  const open = new Map<string, OpenAttempt>();
  const scored = new Map<string, ScoredInfo>();
  const closed = new Map<string, true>();

  /** Existing entry, or a new one for a well-formed key (`cls` is cached from `parseKey`); null for a malformed key. */
  function entryFor(key: OutcomeKey): Entry | null {
    const existing = entries.get(key);
    if (existing) return existing;
    const parts = parseKey(key);
    if (parts === null) return null;
    const created: Entry = {
      cls: parts.cls,
      beta: { alpha: 0, beta: 0, updatedAt: clockNow() },
      counts: ZERO_COUNTS,
      cost: EMPTY_COST,
    };
    entries.set(key, created);
    return created;
  }

  function fold(attempt: OpenAttempt): void {
    const entry = entryFor(attempt.key);
    if (entry === null) return;
    entry.cost = foldAttempt(entry.cost, attempt, tuning.maxEffectiveSamples);
    revision += 1;
  }

  /** Add one validated persisted entry to the live state (new key: taken as is). */
  function absorb(key: OutcomeKey, incoming: Entry, t: number): void {
    // QA-1.3-7: evidence stamped after "now" (a clock that was ahead when it was written) is re-stamped.
    if (incoming.beta.updatedAt > t) incoming.beta = { alpha: incoming.beta.alpha, beta: incoming.beta.beta, updatedAt: t };
    const live = entries.get(key);
    if (live === undefined) {
      entries.set(key, incoming);
      return;
    }
    live.beta = mergeBeta(live.beta, incoming.beta, t, tuning);
    live.counts = addCounts(live.counts, incoming.counts);
    live.cost = mergeCostStats(live.cost, incoming.cost);
  }

  function markClosed(attemptID: string): void {
    remember(closed, attemptID, true, maxScored);
  }

  function closeInternal(attemptID: string, rememberClosed: boolean): void {
    const attempt = open.get(attemptID);
    if (attempt === undefined) return;
    open.delete(attemptID);
    fold(attempt);
    if (rememberClosed) markClosed(attemptID);
  }

  const store: OutcomeStore = {
    get revision(): number {
      return revision;
    },

    configure(next: Partial<OutcomeTuning>): void {
      tuning = sanitizeTuning({
        halfLifeDays: next.halfLifeDays ?? tuning.halfLifeDays,
        maxEffectiveSamples: next.maxEffectiveSamples ?? tuning.maxEffectiveSamples,
      });
    },

    recordVerdict(key: OutcomeKey, verdict: Verdict, signal: AttemptSignal): boolean {
      if (verdict !== "pass" && verdict !== "fail") return false;
      const previous = scored.get(signal.attemptID);
      if (previous !== undefined) {
        remember(scored, signal.attemptID, previous, maxScored);
        return false;
      }
      const entry = entryFor(key);
      if (entry === null) return false;
      const pass = verdict === "pass";
      const variant = signal.step === "variant";
      const t = clockNow();
      entry.beta = observe(entry.beta, pass, t, tuning);
      const c = entry.counts;
      entry.counts = {
        pass: c.pass + (pass ? 1 : 0),
        fail: c.fail + (pass ? 0 : 1),
        falseRefusals: c.falseRefusals,
        variantPass: c.variantPass + (variant && pass ? 1 : 0),
        variantFail: c.variantFail + (variant && !pass ? 1 : 0),
      };
      remember(scored, signal.attemptID, { key, kind: pass ? "pass" : "fail", at: t, variant }, maxScored);
      revision += 1;
      return true;
    },

    recordFalseRefusal(key: OutcomeKey, signal: AttemptSignal): boolean {
      const entry = entryFor(key);
      if (entry === null) return false;
      const previous = scored.get(signal.attemptID);
      const c = entry.counts;
      const t = clockNow();
      revision += 1; // the lifetime counter below always changes
      if (previous === undefined) {
        // First terminal signal of the attempt: a failure.
        const variant = signal.step === "variant";
        entry.counts = { ...c, falseRefusals: c.falseRefusals + 1, variantFail: c.variantFail + (variant ? 1 : 0) };
        entry.beta = observe(entry.beta, false, t, tuning);
        remember(scored, signal.attemptID, { key, kind: "refusal", at: t, variant }, maxScored);
        return true;
      }
      if (previous.kind === "pass" && previous.key === key) {
        // QA-1.3-6: the pass was wrong. Observe the failure, take the pass's decayed contribution back out
        // of alpha (floored at 0; an approximation once the cap has rescaled the evidence) and move the
        // counters pass → fail.
        const decayed = decayTo(entry.beta, t, tuning);
        const contribution = decayFactor(t - previous.at, tuning.halfLifeDays);
        entry.beta = capEvidence(
          { alpha: Math.max(0, decayed.alpha - contribution), beta: decayed.beta + 1, updatedAt: decayed.updatedAt },
          tuning.maxEffectiveSamples,
        );
        const v = previous.variant ? 1 : 0;
        entry.counts = {
          pass: Math.max(0, c.pass - 1),
          fail: c.fail + 1,
          falseRefusals: c.falseRefusals + 1,
          variantPass: Math.max(0, c.variantPass - v),
          variantFail: c.variantFail + v,
        };
        remember(scored, signal.attemptID, { key, kind: "refusal", at: t, variant: previous.variant }, maxScored);
        return true;
      }
      // Already a failure (fail verdict or an earlier refusal): lifetime counter only.
      entry.counts = { ...c, falseRefusals: c.falseRefusals + 1 };
      remember(scored, signal.attemptID, previous, maxScored);
      return false;
    },

    recordStep(key: OutcomeKey, step: StepSample): void {
      if (closed.has(step.attemptID)) return;
      let acc = open.get(step.attemptID);
      if (acc !== undefined && acc.key !== key) {
        // One attempt id is expected to map to one key. If it does not, fold what was gathered for the
        // old key and start a fresh accumulator for this one (it must not stay in `closed`).
        closeInternal(step.attemptID, false);
        acc = undefined;
      }
      const usd = stepUSD(step.cost, step.pricing);
      const t = clockNow();
      const base: OpenAttempt = acc ?? {
        key,
        attemptID: step.attemptID,
        steps: 0,
        usd: 0,
        usdKnown: true,
        tokens: emptyTokenSample(),
        finalOutput: null,
        lastStepAt: t,
      };
      const tokens = cleanTokenSample(step.tokens);
      const next: OpenAttempt = {
        key: base.key,
        attemptID: base.attemptID,
        steps: base.steps + 1,
        usd: base.usd + (usd ?? 0),
        usdKnown: base.usdKnown && usd !== null,
        tokens: addTokens(base.tokens, tokens),
        finalOutput: step.final ? tokens.output : base.finalOutput,
        lastStepAt: t,
      };
      open.delete(step.attemptID);
      if (step.final) {
        fold(next);
        markClosed(step.attemptID);
        return;
      }
      open.set(step.attemptID, next);
      if (open.size > maxOpen) {
        const oldest = open.keys().next();
        if (oldest.done !== true) closeInternal(oldest.value, true);
      }
    },

    closeAttempt(attemptID: string): void {
      closeInternal(attemptID, true);
    },

    sweepAttempts(maxIdleMs: number = DEFAULT_MAX_IDLE_MS): number {
      const t = clockNow();
      const idle: string[] = [];
      for (const [id, attempt] of open) {
        const age = t - attempt.lastStepAt;
        if (Number.isFinite(age) && age >= maxIdleMs) idle.push(id);
      }
      for (const id of idle) closeInternal(id, true);
      return idle.length;
    },

    posterior(key: OutcomeKey, prior: BetaPrior = SAME_RANK_PRIOR) {
      return posteriorOf(entries.get(key)?.beta, prior, clockNow(), tuning);
    },

    cost(key: OutcomeKey): CostStats {
      return entries.get(key)?.cost ?? EMPTY_COST;
    },

    classTokenProfile(cls: string): TokenMeans | null {
      let n = 0;
      let input = 0;
      let output = 0;
      let reasoning = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      for (const entry of entries.values()) {
        const t = entry.cost.tokens;
        if (entry.cls !== cls || t.n === 0) continue;
        n += t.n;
        input += t.input * t.n;
        output += t.output * t.n;
        reasoning += t.reasoning * t.n;
        cacheRead += t.cacheRead * t.n;
        cacheWrite += t.cacheWrite * t.n;
      }
      if (n === 0) return null;
      return {
        n,
        input: input / n,
        output: output / n,
        reasoning: reasoning / n,
        cacheRead: cacheRead / n,
        cacheWrite: cacheWrite / n,
      };
    },

    keys(): OutcomeKey[] {
      return [...entries.keys()].sort(compareCodeUnits);
    },

    snapshot(): OutcomeSnapshot {
      const out: Record<string, OutcomeEntrySnapshot> = {};
      for (const key of store.keys()) {
        const entry = entries.get(key);
        if (entry) out[key] = entrySnapshot(entry);
      }
      return { version: OUTCOMES_SCHEMA_VERSION, entries: out };
    },

    fromSnapshot(snapshot: OutcomeSnapshot, opts?: { readonly mode?: "replace" | "merge" }): SnapshotLoadReport {
      const mode = opts?.mode ?? "replace";
      const source: Record<string, unknown> = isRec(snapshot?.entries) ? snapshot.entries : {};
      const accepted = new Map<OutcomeKey, Entry>();
      let dropped = 0;
      for (const [key, value] of Object.entries(source)) {
        const entry = readEntry(key, value);
        if (entry === null) dropped += 1;
        else accepted.set(key as OutcomeKey, entry);
      }
      const hadEntries = entries.size > 0;
      if (mode === "replace") entries.clear();
      const t = clockNow();
      for (const [key, disk] of accepted) absorb(key, disk, t);
      if (accepted.size > 0 || (mode === "replace" && hadEntries)) revision += 1;
      return { accepted: accepted.size, dropped };
    },

    mergeForeign(disk: OutcomeSnapshot, baseline: OutcomeSnapshot): SnapshotLoadReport {
      const diskEntries: Record<string, unknown> = isRec(disk?.entries) ? disk.entries : {};
      const baseEntries: Record<string, unknown> = isRec(baseline?.entries) ? baseline.entries : {};
      const t = clockNow();
      let accepted = 0;
      let dropped = 0;
      for (const [key, value] of Object.entries(diskEntries)) {
        const current = readEntry(key, value);
        if (current === null) {
          dropped += 1;
          continue;
        }
        const base = key in baseEntries ? readEntry(key, baseEntries[key]) : null;
        const delta = base === null ? current : subtractEntry(current, base, tuning);
        if (isEmptyEntry(delta)) continue;
        absorb(key as OutcomeKey, delta, t);
        accepted += 1;
      }
      if (accepted > 0) revision += 1;
      return { accepted, dropped };
    },
  };

  return store;
}
