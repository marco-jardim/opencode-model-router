// ---------------------------------------------------------------------------
// Adaptive routing: the weekly cloud review decision, the versioned
// snapshot shape, and the per-dispatch assignment overlay. Pure module: no
// I/O, no network, no module state. Persistence lives in adaptive-store.ts.
//
// The selection rules live on `decideAdaptive` (its doc comment is the
// authority). Naming note: the P2 contract defines E=weeklyDue,
// P=policyAllowed, S=sufficientEvidence; the earlier "E/P/S matrix" table
// here mislabeled this module's own checks with those letters. No new
// protocol is introduced — the rows below are this function's checks only.
//
// An UNKNOWN cell never reads as success: a missing admission field, a
// missing or conflicting evidence record, an unknown deployed profile all
// hold. Benchmark cost is not an OpenCode price and a subscription-zero model
// is not "free" — this module never invents either.
// ---------------------------------------------------------------------------

import type { RouterConfig } from "./config";

export const ADAPTIVE_SNAPSHOT_VERSION = 1;
export const ADAPTIVE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded snapshot fields: no prompts, no history tables. */
const MAX_EVIDENCE_ENTRIES = 8;
const MAX_REASONS = 8;

/** One managed tier's model choice. The pair travels together: a new model never keeps the previous model's variant. */
export interface AdaptiveAssignment {
  readonly model: string;
  readonly variant?: string;
}

/**
 * The single versioned snapshot of the weekly review, persisted next to the
 * manual router state in its own file. `generation` + `configFingerprint`
 * are the CAS guard: a snapshot whose fingerprint does not match the current
 * config sources is stale and is never applied.
 */
export interface AdaptiveSnapshot {
  readonly version: typeof ADAPTIVE_SNAPSHOT_VERSION;
  readonly generation: number;
  readonly configFingerprint: string;
  readonly lastAttemptAt: string | null;
  readonly lastAppliedAt: string | null;
  readonly assignments: Readonly<Record<string, Readonly<Record<string, AdaptiveAssignment>>>>;
  readonly previousAssignments: Readonly<Record<string, Readonly<Record<string, AdaptiveAssignment>>>>;
  /** Short evidence refs (benchmark record URLs), bounded. */
  readonly evidence: readonly string[];
  /** Bounded decision/hold reasons. */
  readonly reasons: readonly string[];
  /** The resolved source revision this review's evidence was read at (provenance; absent when resolution failed). */
  readonly sourceRef?: string;
}

/** One public benchmark record, reduced to the fields the decision reads. */
export interface EvidenceRecord {
  readonly model: string;
  readonly modelLabel: string;
  readonly agent: string;
  readonly agentVersion: string;
  readonly effort: string;
  readonly accuracy: number;
  readonly ciHalfWidth: number;
  readonly nTrials: number;
  readonly benchmarkVersion: string;
  readonly sourceUrl: string;
}

/**
 * Runtime admission for the S row. `undefined` means UNKNOWN (hold); the
 * production caller has no quota source today, so a real review holds here
 * until the owner provides one.
 */
export interface AdaptiveAdmission {
  readonly quotasOk?: boolean;
  readonly capabilitiesOk?: boolean;
}

/** The current file model of one managed (preset, tier). */
export interface AdaptiveCurrent {
  readonly model: string;
  readonly variant?: string;
}

/** True when no snapshot exists, or the last attempt is at least a week old. */
export function weeklyReviewDue(snapshot: AdaptiveSnapshot | null, nowMs: number): boolean {
  if (snapshot === null) return true;
  if (snapshot.lastAttemptAt === null) return true;
  const last = Date.parse(snapshot.lastAttemptAt);
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= ADAPTIVE_WEEK_MS;
}

/** A fresh, empty snapshot at `generation` for `configFingerprint`. */
export function emptyAdaptiveSnapshot(generation: number, configFingerprint: string, nowIso: string): AdaptiveSnapshot {
  return {
    version: ADAPTIVE_SNAPSHOT_VERSION,
    generation,
    configFingerprint,
    lastAttemptAt: nowIso,
    lastAppliedAt: null,
    assignments: {},
    previousAssignments: {},
    evidence: [],
    reasons: [],
  };
}

/** A snapshot is current only for the exact config fingerprint it was taken against. */
export function isSnapshotCurrent(snapshot: AdaptiveSnapshot | null, configFingerprint: string): boolean {
  return snapshot !== null && snapshot.configFingerprint === configFingerprint;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const str = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Reduce one terminal-bench submission JSON to an {@link EvidenceRecord}, or
 * report why it cannot be evidence. `benchmarkVersion` comes from the
 * leaderboard index (dataset_version_refs), not from the record, and a
 * record that does not fit the known schema is rejected, never patched.
 */
export function parseSubmissionRecord(
  raw: unknown,
  benchmarkVersion: string,
  sourceUrl: string,
): { record?: EvidenceRecord; problem?: string } {
  if (!isPlain(raw)) return { problem: "record is not an object" };
  const metrics = raw.metrics;
  const filter = raw.source_filter;
  const metadata = raw.metadata;
  if (!isPlain(metrics) || !isPlain(filter) || !isPlain(metadata)) {
    return { problem: "record lacks metrics/source_filter/metadata" };
  }
  const accuracy = metrics.accuracy;
  const ci = metrics.accuracy_ci95_half_width;
  const nTrials = metrics.n_trials;
  if (!num(accuracy) || accuracy < 0 || accuracy > 100) return { problem: "metrics.accuracy must be a number 0..100" };
  if (!num(ci) || ci < 0 || ci > 100) return { problem: "metrics.accuracy_ci95_half_width must be a number 0..100" };
  if (!num(nTrials) || !Number.isInteger(nTrials) || nTrials < 1) return { problem: "metrics.n_trials must be a positive integer" };
  const model = filter.model_name;
  if (!str(model) || !model.includes("/")) return { problem: "source_filter.model_name must be a provider/model string" };
  if (!str(filter.agent)) return { problem: "source_filter.agent must be a non-empty string" };
  if (!str(filter.agent_version)) return { problem: "source_filter.agent_version must be a non-empty string" };
  const effort = filter.reasoning_effort;
  if (!str(effort)) return { problem: "source_filter.reasoning_effort must be a non-empty string" };
  const modelDisplay = metadata.model_display;
  return {
    record: {
      model,
      modelLabel: isPlain(modelDisplay) && str(modelDisplay.label) ? modelDisplay.label : model,
      agent: filter.agent,
      agentVersion: filter.agent_version,
      effort,
      accuracy,
      ciHalfWidth: ci,
      nTrials,
      benchmarkVersion,
      sourceUrl,
    },
  };
}

export type AdaptiveDecision =
  | { readonly action: "apply"; readonly assignments: Record<string, Record<string, AdaptiveAssignment>>; readonly reasons: readonly string[] }
  | { readonly action: "hold"; readonly reasons: readonly string[] };

/**
 * The weekly decision over one review's inputs. Every managed (preset, tier)
 * of `current` is examined; the rules are this function's own (see the module
 * note: they are NOT the P2 letters E/P/S, and no new protocol is claimed):
 *
 *   1. Deployed profile: the tier's explicit `variant`, else the `#suffix` of
 *      its own model ref; both present and different is a conflict. Unknown
 *      or conflicting profile holds — no guessed default such as "max".
 *   2. Baseline evidence: records naming EXACTLY the deployed model base AND
 *      the deployed profile (`record.effort`). None holds (identity unknown).
 *      Several must agree on harness and on accuracy/CI/n-trials; conflicting
 *      comparable baselines hold — the weakest is never cherry-picked and no
 *      statistics are invented.
 *   3. Candidates are FILTERED before any ranking: exact catalog identity,
 *      the baseline's benchmark version and harness (agent, agentVersion) and
 *      the SAME deployed profile, finite in-range metrics with n-trials > 0.
 *      Several admissible records of one candidate must agree; a conflicting
 *      candidate is dropped, not averaged.
 *   4. Known-OK capabilities and runtime cost/quota (admission) gate the
 *      assignment; an undefined admission field is UNKNOWN and holds.
 *   5. The admissible candidates are ranked by CI lower bound; the winner is
 *      applied only when its lower bound is STRICTLY above the baseline's
 *      upper bound. The assignment keeps the verified profile as its variant
 *      (a new model never silently keeps the previous tier's variant).
 */
export function decideAdaptive(input: {
  readonly candidates: readonly string[];
  readonly current: Readonly<Record<string, Readonly<Record<string, AdaptiveCurrent>>>>;
  readonly evidence: readonly EvidenceRecord[];
  readonly admission: AdaptiveAdmission;
}): AdaptiveDecision {
  const reasons: string[] = [];
  const assignments: Record<string, Record<string, AdaptiveAssignment>> = {};

  /** Records agree only when they carry one confirmed body of evidence. */
  const agree = (records: readonly EvidenceRecord[]): boolean => {
    const first = records[0]!;
    return records.every(
      (r) =>
        r.agent === first.agent &&
        r.agentVersion === first.agentVersion &&
        r.benchmarkVersion === first.benchmarkVersion &&
        r.accuracy === first.accuracy &&
        r.ciHalfWidth === first.ciHalfWidth &&
        r.nTrials === first.nTrials,
    );
  };

  for (const [preset, tiers] of Object.entries(input.current)) {
    for (const [tier, cur] of Object.entries(tiers)) {
      const tierKey = `${preset}.${tier}`;
      const before = reasons.length;

      if (input.admission.capabilitiesOk !== true) {
        reasons.push(`${tierKey}: candidate capabilities unknown (S: unknown)`);
      }
      if (input.admission.quotasOk !== true) {
        reasons.push(`${tierKey}: runtime cost/quota unknown (S: unknown)`);
      }

      // 1. The deployed profile: explicit variant, else the model ref's own
      // "#suffix"; both present and different is a conflict, neither is a guess.
      const hashAt = cur.model.indexOf("#");
      const modelBase = hashAt === -1 ? cur.model : cur.model.slice(0, hashAt);
      const inlineVariant = hashAt === -1 ? undefined : cur.model.slice(hashAt + 1);
      let profile: string | undefined;
      if (cur.variant !== undefined && inlineVariant !== undefined) {
        if (cur.variant !== inlineVariant) {
          reasons.push(`${tierKey}: deployed variant conflict ('${cur.variant}' vs '${inlineVariant}' in the model ref)`);
        } else {
          profile = cur.variant;
        }
      } else {
        profile = cur.variant ?? inlineVariant;
      }

      // 2. Baseline: exact model base AND exact deployed profile.
      let baseline: EvidenceRecord | undefined;
      if (profile === undefined) {
        reasons.push(`${tierKey}: deployed variant unknown (no variant and no '#suffix'); no guessed default`);
      } else {
        const exact = input.evidence.filter((r) => r.model === modelBase && r.effort === profile);
        if (exact.length === 0) {
          reasons.push(`${tierKey}: no evidence record for the deployed ${modelBase}#${profile} (identity unknown)`);
        } else if (!agree(exact)) {
          reasons.push(`${tierKey}: conflicting baseline records for ${modelBase}#${profile}; holding instead of cherry-picking`);
        } else {
          baseline = exact[0]!;
        }
      }

      // 3. Filter FIRST, rank later: a higher-scoring inadmissible record
      // must never win over a lower-scoring admissible one.
      const admissible: EvidenceRecord[] = [];
      let harnessRejection = false;
      if (baseline !== undefined && profile !== undefined) {
        const byCandidate = new Map<string, EvidenceRecord[]>();
        for (const record of input.evidence) {
          if (record.model === modelBase) continue; // the deployed model itself is not a candidate
          if (!input.candidates.includes(record.model)) continue; // exact catalog identity, no aliases
          if (record.benchmarkVersion !== baseline.benchmarkVersion) continue;
          if (record.agent !== baseline.agent || record.agentVersion !== baseline.agentVersion || record.effort !== profile) {
            harnessRejection = true; // an incomparable benchmark/effort, whatever its score
            continue;
          }
          if (!Number.isFinite(record.accuracy) || !Number.isFinite(record.ciHalfWidth) || record.nTrials < 1) continue;
          const list = byCandidate.get(record.model);
          if (list === undefined) byCandidate.set(record.model, [record]);
          else list.push(record);
        }
        for (const records of byCandidate.values()) {
          if (agree(records)) admissible.push(records[0]!); // conflicting records drop the candidate
        }
      }

      // 5. Rank the admissible by CI lower bound; require a STRICT improvement
      // over the baseline's upper bound; keep the verified profile.
      if (baseline !== undefined && profile !== undefined) {
        let best: EvidenceRecord | undefined;
        for (const record of admissible) {
          if (best === undefined || record.accuracy - record.ciHalfWidth > best.accuracy - best.ciHalfWidth) best = record;
        }
        if (best === undefined) {
          reasons.push(
            harnessRejection
              ? `${tierKey}: candidate records exist but the harness is not comparable (agent/agentVersion/effort) (S)`
              : `${tierKey}: no admissible candidate with an exact, comparable evidence record (identity unknown)`,
          );
        } else {
          const low = best.accuracy - best.ciHalfWidth;
          const high = baseline.accuracy + baseline.ciHalfWidth;
          if (!(low > high)) {
            reasons.push(`${tierKey}: candidate ${best.model} lower CI bound ${low} not above current ${modelBase} upper bound ${high} (P)`);
          } else if (reasons.length === before) {
            (assignments[preset] ??= {})[tier] = { model: best.model, variant: profile };
          }
        }
      }
    }
  }

  if (Object.keys(assignments).length === 0) {
    return { action: "hold", reasons: reasons.slice(0, MAX_REASONS) };
  }
  return { action: "apply", assignments, reasons: reasons.slice(0, MAX_REASONS) };
}

/**
 * The per-dispatch overlay: which model a managed tier actually runs.
 * Returns undefined (the caller keeps the file model) when the opt-in is
 * absent, the tier is not managed, the tier is pinned by an accepted project
 * layer (manual priority), or there is no snapshot. Callers must pass a
 * fingerprint-current snapshot (see isSnapshotCurrent); a stale snapshot is
 * never applied.
 */
export function resolveAdaptiveAssignment(
  cfg: RouterConfig,
  presetName: string,
  tierName: string,
  snapshot: AdaptiveSnapshot | null,
  pinnedTiers: ReadonlySet<string>,
): AdaptiveAssignment | undefined {
  const adaptive = cfg.adaptiveRouting;
  if (adaptive === undefined) return undefined;
  const managed = adaptive.managedTiers[presetName];
  if (managed === undefined || !managed.includes(tierName as "fast" | "medium" | "heavy")) return undefined;
  if (pinnedTiers.has(`${presetName}.${tierName}`)) return undefined;
  const assignment = snapshot?.assignments[presetName]?.[tierName];
  if (assignment === undefined) return undefined;
  return { model: assignment.model, ...(assignment.variant !== undefined ? { variant: assignment.variant } : {}) };
}

/** `provider/model` or `provider/model#variant` — the pair is always formatted together. */
export function formatAssignmentRef(assignment: AdaptiveAssignment): string {
  return `${assignment.model}${assignment.variant !== undefined ? `#${assignment.variant}` : ""}`;
}

/**
 * Task-start effective config (slice A2): a copy of `cfg` with every managed,
 * unpinned tier of `presetName` that has a snapshot assignment running that
 * assignment's model+variant pair. The caller reads the snapshot ONCE per
 * task, BEFORE the ladder plan is generated, so every attempt (fresh or
 * resumed), the attribution rows and the producer registration keep the models
 * the task started with, and the ladder's explicit tier/effort escalation
 * still runs the escalated tier's own assignment. Pure: no I/O, and the input
 * config object (loadConfig's cache) is never mutated.
 */
export function applyAdaptiveAssignments(
  cfg: RouterConfig,
  presetName: string,
  snapshot: AdaptiveSnapshot | null,
  pinnedTiers: ReadonlySet<string>,
): RouterConfig {
  const managed = cfg.adaptiveRouting?.managedTiers[presetName];
  if (managed === undefined || snapshot === null) return cfg;
  let presets = cfg.presets;
  for (const tier of managed) {
    const assignment = resolveAdaptiveAssignment(cfg, presetName, tier, snapshot, pinnedTiers);
    if (assignment === undefined) continue;
    const tierCfg = cfg.presets[presetName]?.[tier];
    if (tierCfg === undefined) continue;
    const next = { ...tierCfg, model: assignment.model };
    if (assignment.variant !== undefined) next.variant = assignment.variant;
    else delete next.variant;
    presets = { ...presets, [presetName]: { ...(presets[presetName] ?? {}), [tier]: next } };
  }
  if (presets === cfg.presets) return cfg;
  return { ...cfg, presets };
}

/** Bound an evidence list for the snapshot. */
export function boundEvidence(urls: readonly string[]): readonly string[] {
  return urls.filter((u) => typeof u === "string").slice(0, MAX_EVIDENCE_ENTRIES);
}
