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
import { OUTCOMES_SCHEMA_ID, OUTCOMES_SCHEMA_VERSION, parseKey } from "./types";
import { SAME_RANK_PRIOR, mergeBeta, observe, posteriorOf, sanitizeTuning } from "./beta";
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

/** LRU set on a Map: refresh = delete + set; evict from the front. */
function touch(set: Map<string, true>, id: string, max: number): void {
  set.delete(id);
  set.set(id, true);
  while (set.size > max) {
    const oldest = set.keys().next();
    if (oldest.done === true) break;
    set.delete(oldest.value);
  }
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

export type ParseSnapshotResult =
  | { readonly ok: true; readonly snapshot: OutcomeSnapshot; readonly dropped: number }
  | { readonly ok: false; readonly reason: "unsupported-version" | "corrupt"; readonly message: string };

/**
 * Validate a parsed `outcomes.json` envelope. A newer `version` is `unsupported-version` (never
 * overwritten by this plugin); a wrong schema, a non-object or `version < 1` is `corrupt`. Invalid
 * entries are dropped and counted; the valid ones come back with keys in sorted order.
 */
export function parseSnapshot(json: unknown): ParseSnapshotResult {
  if (!isRec(json)) return { ok: false, reason: "corrupt", message: "not a JSON object" };
  if (json.schema !== OUTCOMES_SCHEMA_ID) {
    return { ok: false, reason: "corrupt", message: `unexpected schema ${JSON.stringify(json.schema)}` };
  }
  const version = json.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, reason: "corrupt", message: "missing or non-integer version" };
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
  const maxOpen = Math.max(1, Math.floor(options.maxOpenAttempts ?? DEFAULT_MAX_OPEN_ATTEMPTS));
  const maxScored = Math.max(1, Math.floor(options.maxScoredAttempts ?? DEFAULT_MAX_SCORED_ATTEMPTS));
  let tuning: OutcomeTuning = sanitizeTuning(options);
  let revision = 0;

  const entries = new Map<OutcomeKey, Entry>();
  const open = new Map<string, OpenAttempt>();
  const scored = new Map<string, true>();
  const closed = new Map<string, true>();

  /** Existing entry, or a new one for a well-formed key (`cls` is cached from `parseKey`); null for a malformed key. */
  function entryFor(key: OutcomeKey): Entry | null {
    const existing = entries.get(key);
    if (existing) return existing;
    const parts = parseKey(key);
    if (parts === null) return null;
    const created: Entry = {
      cls: parts.cls,
      beta: { alpha: 0, beta: 0, updatedAt: now() },
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

  function closeInternal(attemptID: string, remember: boolean): void {
    const attempt = open.get(attemptID);
    if (attempt === undefined) return;
    open.delete(attemptID);
    fold(attempt);
    if (remember) touch(closed, attemptID, maxScored);
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
      if (scored.has(signal.attemptID)) {
        touch(scored, signal.attemptID, maxScored);
        return false;
      }
      const entry = entryFor(key);
      if (entry === null) return false;
      const pass = verdict === "pass";
      const variant = signal.step === "variant";
      entry.beta = observe(entry.beta, pass, now(), tuning);
      const c = entry.counts;
      entry.counts = {
        pass: c.pass + (pass ? 1 : 0),
        fail: c.fail + (pass ? 0 : 1),
        falseRefusals: c.falseRefusals,
        variantPass: c.variantPass + (variant && pass ? 1 : 0),
        variantFail: c.variantFail + (variant && !pass ? 1 : 0),
      };
      touch(scored, signal.attemptID, maxScored);
      revision += 1;
      return true;
    },

    recordFalseRefusal(key: OutcomeKey, signal: AttemptSignal): boolean {
      const entry = entryFor(key);
      if (entry === null) return false;
      const firstSignal = !scored.has(signal.attemptID);
      const variantFail = firstSignal && signal.step === "variant" ? 1 : 0;
      const c = entry.counts;
      entry.counts = { ...c, falseRefusals: c.falseRefusals + 1, variantFail: c.variantFail + variantFail };
      if (firstSignal) entry.beta = observe(entry.beta, false, now(), tuning);
      touch(scored, signal.attemptID, maxScored);
      revision += 1;
      return firstSignal;
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
      const t = now();
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
        touch(closed, step.attemptID, maxScored);
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
      const t = now();
      const idle: string[] = [];
      for (const [id, attempt] of open) {
        const age = t - attempt.lastStepAt;
        if (Number.isFinite(age) && age >= maxIdleMs) idle.push(id);
      }
      for (const id of idle) closeInternal(id, true);
      return idle.length;
    },

    posterior(key: OutcomeKey, prior: BetaPrior = SAME_RANK_PRIOR) {
      return posteriorOf(entries.get(key)?.beta, prior, now(), tuning);
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
      const t = now();
      for (const [key, disk] of accepted) {
        const live = mode === "merge" ? entries.get(key) : undefined;
        if (live === undefined) {
          entries.set(key, disk);
          continue;
        }
        live.beta = mergeBeta(live.beta, disk.beta, t, tuning);
        live.counts = addCounts(live.counts, disk.counts);
        live.cost = mergeCostStats(live.cost, disk.cost);
      }
      if (accepted.size > 0 || (mode === "replace" && hadEntries)) revision += 1;
      return { accepted: accepted.size, dropped };
    },
  };

  return store;
}
