// ---------------------------------------------------------------------------
// Adaptive routing persistence and the weekly review runner.
//
// The snapshot lives in ONE versioned file next to the manual router state
// (opencode-model-router.adaptive.json). The manual state file
// (opencode-model-router.state.json) is never touched: writeState there is
// atomic but not CAS and external writers do not take our lock, so adaptive
// data in it could be silently reverted. Here every commit goes through the
// shared file lock (src/routing/file-lock.ts) with a generation +
// configFingerprint CAS, and the write itself is atomic (temp + rename).
//
// Missing or corrupt snapshot => explicit UNKNOWN/hold, never 0/success. A
// failed attempt still records lastAttemptAt under the lock, so a source that
// stays broken is not retried on every turn.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ADAPTIVE_SNAPSHOT_VERSION,
  boundEvidence,
  decideAdaptive,
  emptyAdaptiveSnapshot,
  isSnapshotCurrent,
  parseSubmissionRecord,
  weeklyReviewDue,
  type AdaptiveAdmission,
  type AdaptiveAssignment,
  type AdaptiveSnapshot,
  type EvidenceRecord,
} from "./adaptive";
import { configSourcesFingerprint, loadGlobalConfig, resolvePresetName, statePath } from "./config";
import { withLock } from "../routing/file-lock";
import type { OutcomeLogger } from "../routing/outcomes/types";

/**
 * The verified seed revision (2026-11-01): leaderboard.yaml dataset ref 4 and
 * the 21 submission JSONs were confirmed at this sha on main. Documented
 * provenance only — every live review RESOLVES the current main HEAD once per
 * review (TERMINAL_BENCH_COMMIT_URL) and validates it as a 40-hex sha; the
 * seed is never silently substituted for a resolution that failed.
 */
export const TERMINAL_BENCH_SEED_REF = "4031b48384a5946ba2c5b3c5fa59246ce8d47d92";
/** The only allowlisted evidence repo (official GitHub, read-only, no auth). */
export const TERMINAL_BENCH_REPO = "harbor-framework/terminal-bench";
/** Resolved once per review: the current main HEAD of the allowlisted repo. */
export const TERMINAL_BENCH_COMMIT_URL = `https://api.github.com/repos/${TERMINAL_BENCH_REPO}/commits/main`;
const leaderboardYamlUrl = (ref: string) => `https://raw.githubusercontent.com/${TERMINAL_BENCH_REPO}/${ref}/leaderboard/leaderboard.yaml`;
const submissionsIndexUrl = (ref: string) => `https://api.github.com/repos/${TERMINAL_BENCH_REPO}/contents/leaderboard/submissions?ref=${ref}`;
const rawSubmissionPrefix = (ref: string) => `https://raw.githubusercontent.com/${TERMINAL_BENCH_REPO}/${ref}/leaderboard/submissions/`;
/** Time bound per HTTP request (a resource guard, not a quality threshold). */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Resource bounds, not quality thresholds: MAX_SUBMISSIONS caps the NUMBER of
 * per-submission requests one review may issue (the seed revision carries 21),
 * MAX_BODY_BYTES caps how much of one response body is even parsed — together
 * with FETCH_TIMEOUT_MS they bound a review's time and memory; neither says
 * anything about the QUALITY of the evidence.
 */
const MAX_SUBMISSIONS = 25;
const MAX_BODY_BYTES = 2_000_000;

/** The one adaptive snapshot file, next to the manual router state. */
export function adaptiveStatePath(): string {
  return join(dirname(statePath()), "opencode-model-router.adaptive.json");
}

// --- minimal node PersistFs (the shape withLock expects) -------------------

const nodeFs = {
  async mkdirp(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
  },
  async createExclusive(path: string, data: string): Promise<boolean> {
    try {
      writeFileSync(path, data, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  },
  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    try {
      const st = statSync(path);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async rename(from: string, to: string): Promise<void> {
    renameSync(from, to);
  },
  async unlink(path: string): Promise<void> {
    unlinkSync(path);
  },
  async readText(path: string): Promise<string | null> {
    try {
      return readFileSync(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async writeDurable(path: string, data: string): Promise<void> {
    writeFileSync(path, data, "utf-8");
  },
  async appendText(path: string, data: string): Promise<void> {
    appendFileSync(path, data, "utf-8");
  },
  async readdir(dir: string): Promise<string[]> {
    try {
      return readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
};

// --- snapshot file ----------------------------------------------------------

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-empty bounded string; an empty value never masks corruption. */
const isBoundedString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** Prototype-polluting keys are never valid preset/tier names. */
const isSafeKey = (key: string): boolean => key !== "__proto__" && key !== "constructor" && key !== "prototype";

/** A bounded list of bounded strings: snapshot evidence/reasons keep their shape and size. */
const isBoundedStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 64 && v.every((el) => isBoundedString(el, 4096));

/** A `preset -> tier -> {model, variant?}` map of the shipped snapshot shape. */
function assignmentsProblem(v: unknown, field: string): string | undefined {
  if (!isPlain(v)) return `${field} must be an object`;
  for (const [preset, tiers] of Object.entries(v)) {
    if (!isSafeKey(preset)) return `${field}: unsafe preset key '${preset}'`;
    if (!isPlain(tiers)) return `${field}.${preset} must be an object`;
    for (const [tier, assignment] of Object.entries(tiers)) {
      if (!isSafeKey(tier)) return `${field}.${preset}: unsafe tier key '${tier}'`;
      if (!isPlain(assignment)) return `${field}.${preset}.${tier} must be an object`;
      if (!isBoundedString(assignment.model, 256)) return `${field}.${preset}.${tier}.model must be a non-empty string`;
      if (assignment.variant !== undefined && !isBoundedString(assignment.variant, 64)) {
        return `${field}.${preset}.${tier}.variant must be a non-empty string`;
      }
    }
  }
  return undefined;
}

/**
 * Read and validate the snapshot file against the FULL shipped v1 schema:
 * version/generation/fingerprint, null-or-string timestamps, preset→tier
 * assignment maps with a typed model (+ optional variant), bounded string
 * arrays for evidence/reasons, and an optional 40-hex sourceRef. A missing,
 * wrongly typed or prototype-dangerous field is corruption, not a default to
 * fill in: the result is UNKNOWN (never success) and consumers keep the
 * fallback. The public snapshot version does not change.
 */
export function readAdaptiveSnapshotFile(path: string = adaptiveStatePath()): { snapshot?: AdaptiveSnapshot; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { problem: "missing" };
    return { problem: `unreadable: ${(error as Error).message}` };
  }
  if (!isPlain(raw)) return { problem: "not an object" };
  if (raw.version !== ADAPTIVE_SNAPSHOT_VERSION) return { problem: `unsupported version ${String(raw.version)}` };
  if (typeof raw.generation !== "number" || !Number.isInteger(raw.generation) || raw.generation < 0) {
    return { problem: "generation must be a non-negative integer" };
  }
  if (!isBoundedString(raw.configFingerprint, 4096)) return { problem: "configFingerprint must be a string" };
  if (raw.lastAttemptAt !== null && !isBoundedString(raw.lastAttemptAt, 64)) {
    return { problem: "lastAttemptAt must be null or a string" };
  }
  if (raw.lastAppliedAt !== null && !isBoundedString(raw.lastAppliedAt, 64)) {
    return { problem: "lastAppliedAt must be null or a string" };
  }
  const assignments = assignmentsProblem(raw.assignments, "assignments");
  if (assignments !== undefined) return { problem: assignments };
  const previous = assignmentsProblem(raw.previousAssignments, "previousAssignments");
  if (previous !== undefined) return { problem: previous };
  if (!isBoundedStringArray(raw.evidence)) return { problem: "evidence must be a bounded array of strings" };
  if (!isBoundedStringArray(raw.reasons)) return { problem: "reasons must be a bounded array of strings" };
  if (raw.sourceRef !== undefined && (typeof raw.sourceRef !== "string" || !/^[0-9a-f]{40}$/.test(raw.sourceRef))) {
    return { problem: "sourceRef must be a 40-hex sha" };
  }
  return { snapshot: raw as unknown as AdaptiveSnapshot };
}

/** Atomic temp + rename write; the tmp file is best-effort removed on failure. */
export async function writeAdaptiveSnapshotAtomic(path: string, snapshot: AdaptiveSnapshot): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.adaptive.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      (await import("node:fs")).unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
}

/**
 * Lock + CAS commit. `expected` is what the caller last saw: null for a
 * first write, else the generation + fingerprint it based the next snapshot
 * on. Returns "concurrent" (and writes nothing) when the file moved, so a
 * cross-process race can never silently overwrite a fresher review.
 */
export async function commitAdaptiveSnapshotCAS(args: {
  readonly path?: string;
  readonly expected: { readonly generation: number; readonly configFingerprint: string } | null;
  readonly next: AdaptiveSnapshot;
  readonly logger: OutcomeLogger;
}): Promise<"committed" | "concurrent"> {
  const path = args.path ?? adaptiveStatePath();
  const result = await withLock(
    nodeFs,
    dirname(path),
    `${path}.lock`,
    Date.now,
    args.logger,
    async (): Promise<"committed" | "concurrent"> => {
      const { snapshot: current, problem } = readAdaptiveSnapshotFile(path);
      if (args.expected === null) {
        if (current !== undefined || (problem !== undefined && problem !== "missing")) return "concurrent";
      } else {
        if (current === undefined) return "concurrent";
        if (current.generation !== args.expected!.generation || current.configFingerprint !== args.expected!.configFingerprint) {
          return "concurrent";
        }
      }
      await writeAdaptiveSnapshotAtomic(path, args.next);
      return "committed";
    },
  );
  return result.status === "ran" ? result.value : "concurrent";
}

// --- cached view for the dispatch hot path ----------------------------------

interface ViewMemo {
  mtimeMs: number;
  snapshot: AdaptiveSnapshot | null;
}

let viewMemo: ViewMemo | undefined;

function readCachedSnapshot(path: string): AdaptiveSnapshot | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (viewMemo !== undefined && viewMemo.mtimeMs === mtimeMs) return viewMemo.snapshot;
    const { snapshot } = readAdaptiveSnapshotFile(path);
    viewMemo = { mtimeMs, snapshot: snapshot ?? null };
    return viewMemo.snapshot;
  } catch {
    return null;
  }
}

/** Invalidate the cached view (tests, and any writer in this process). */
export function resetAdaptiveViewCache(): void {
  viewMemo = undefined;
}

/**
 * The snapshot a dispatch may use: present, parseable, and taken against the
 * CURRENT config sources. Anything else (missing, corrupt, stale
 * fingerprint, opt-in removed) is null: the overlay stays off and the file
 * model rules.
 */
export function readAdaptiveView(projectDir?: string): AdaptiveSnapshot | null {
  const snapshot = readCachedSnapshot(adaptiveStatePath());
  if (snapshot === null) return null;
  return isSnapshotCurrent(snapshot, configSourcesFingerprint(projectDir)) ? snapshot : null;
}

// --- public evidence (read-only GitHub metadata) ----------------------------

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text: () => Promise<string> }>;

async function fetchText(fetchImpl: FetchLike, url: string): Promise<string | null> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > MAX_BODY_BYTES ? null : text;
}

/**
 * Resolve the CURRENT source revision of the allowlisted repo, once per
 * review. The response must be JSON with a 40-hex `sha`; anything else is a
 * hold reason, never a silent fallback to the seed sha and never data from an
 * arbitrary URL.
 */
export async function resolveTerminalBenchRef(fetchImpl: FetchLike): Promise<{ ref: string } | { problem: string }> {
  const text = await fetchText(fetchImpl, TERMINAL_BENCH_COMMIT_URL);
  if (text === null) return { problem: "source revision endpoint unavailable" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "source revision response is not JSON" };
  }
  const sha = (parsed as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) {
    return { problem: "source revision is not a valid 40-hex sha" };
  }
  return { ref: sha };
}

/**
 * Discover the current terminal-bench submission records at the RESOLVED ref
 * (see resolveTerminalBenchRef; the ref is never taken from a payload). The
 * leaderboard YAML proves the benchmark version (dataset_version_refs
 * containing '4') with a plain string check — no YAML dependency. Only
 * raw.githubusercontent.com URLs under the RESOLVED ref are fetched; anything
 * else in a payload is ignored. Unknown/rate-limited/failing sources yield
 * no records and a reason, never invented data.
 */
export async function fetchTerminalBenchEvidence(fetchImpl: FetchLike, ref: string): Promise<{ records: EvidenceRecord[]; problems: string[] }> {
  const problems: string[] = [];
  const yaml = await fetchText(fetchImpl, leaderboardYamlUrl(ref));
  if (yaml === null) {
    return { records: [], problems: ["leaderboard index unavailable"] };
  }
  const benchmarkVersion = /dataset_version_refs[^[\]]*\[\s*['"]4['"]/.test(yaml) ? "4" : "unknown";
  if (benchmarkVersion !== "4") {
    return { records: [], problems: ["benchmark version is not 4 per leaderboard index"] };
  }

  const indexText = await fetchText(fetchImpl, submissionsIndexUrl(ref));
  if (indexText === null) {
    return { records: [], problems: ["submissions index unavailable"] };
  }
  let entries: unknown;
  try {
    entries = JSON.parse(indexText);
  } catch {
    return { records: [], problems: ["submissions index is not JSON"] };
  }
  if (!Array.isArray(entries)) return { records: [], problems: ["submissions index is not a list"] };

  const allowedPrefix = rawSubmissionPrefix(ref);
  const records: EvidenceRecord[] = [];
  for (const entry of entries.slice(0, MAX_SUBMISSIONS)) {
    if (!isPlain(entry) || typeof entry.download_url !== "string") continue;
    if (!entry.download_url.startsWith(allowedPrefix)) continue;
    if (typeof entry.name !== "string" || !entry.name.endsWith(".json")) continue;
    const text = await fetchText(fetchImpl, entry.download_url);
    if (text === null) {
      problems.push(`${entry.name}: download failed`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      problems.push(`${entry.name}: invalid JSON`);
      continue;
    }
    const { record, problem } = parseSubmissionRecord(raw, benchmarkVersion, entry.download_url);
    if (record !== undefined) records.push(record);
    else problems.push(`${entry.name}: ${problem ?? "rejected"}`);
  }
  return { records, problems: problems.slice(0, MAX_SUBMISSIONS) };
}

// --- the weekly run ----------------------------------------------------------

export type WeeklyReviewOutcome = "applied" | "held" | "not-due" | "busy" | "no-managed-tiers";

/**
 * One weekly review, never blocking the chat hot path:
 *   1. under the lock: re-check due, claim a generation, stamp lastAttemptAt;
 *   2. OUTSIDE the lock: fetch evidence + catalog, decide (apply or hold);
 *   3. under the lock: CAS-commit against the claimed generation; a file that
 *      moved meanwhile (another process) is left alone.
 * Any fetch/decide failure commits a HOLD with the reason, so a broken
 * source is not retried every turn.
 */
export async function runWeeklyAdaptiveReview(deps: {
  readonly projectDir?: string;
  readonly fetchImpl: FetchLike;
  readonly catalogRefs: () => Promise<readonly string[]>;
  readonly admission?: AdaptiveAdmission;
  readonly logger: OutcomeLogger;
  readonly now?: () => number;
}): Promise<WeeklyReviewOutcome> {
  const nowMs = deps.now?.() ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const path = adaptiveStatePath();
  const fingerprint = configSourcesFingerprint(deps.projectDir);

  // 1. Claim under the lock.
  const claimed = await withLock(
    nodeFs,
    dirname(path),
    `${path}.lock`,
    Date.now,
    deps.logger,
    async (): Promise<{ generation: number; base: AdaptiveSnapshot | null } | "not-due" | "busy"> => {
      const { snapshot: current } = readAdaptiveSnapshotFile(path);
      if (!weeklyReviewDue(current ?? null, nowMs)) return "not-due";
      const generation = (current?.generation ?? 0) + 1;
      // The previous working set survives ONLY when it was taken against the
      // CURRENT global policy fingerprint: a stale (or corrupt) snapshot never
      // re-becomes the ACTIVE assignments — not on this claim and not on the
      // final hold — it may only be replaced by a successful review. A
      // current-fingerprint working set still survives a partial hold (and
      // stays the merge baseline); generation keeps its monotonic CAS guard.
      const carry = current !== undefined && current.configFingerprint === fingerprint ? current : null;
      const next = emptyAdaptiveSnapshot(generation, fingerprint, nowIso);
      await writeAdaptiveSnapshotAtomic(path, {
        ...next,
        assignments: carry?.assignments ?? {},
        previousAssignments: carry?.previousAssignments ?? {},
        ...(carry?.sourceRef !== undefined ? { sourceRef: carry.sourceRef } : {}),
      });
      return { generation, base: carry };
    },
  );
  if (claimed.status === "busy") return "busy";
  if (claimed.value === "not-due") return "not-due";
  if (claimed.value === "busy") return "busy";
  const { generation, base } = claimed.value;
  resetAdaptiveViewCache();

  // 2. Discover + decide outside the lock.
  let decision: ReturnType<typeof decideAdaptive>;
  let evidenceUrls: readonly string[] = [];
  let sourceRef: string | undefined;
  try {
    // The review's baseline is the GLOBAL policy (loadGlobalConfig): a project
    // pin never becomes the shared review's comparison base — consumer-side
    // pins still win per project through resolveAdaptiveAssignment.
    const cfg = loadGlobalConfig();
    const presetName = resolvePresetName(cfg, cfg.activePreset);
    const managed = cfg.adaptiveRouting?.managedTiers[presetName ?? ""] ?? [];
    if (presetName === undefined || managed.length === 0) {
      decision = { action: "hold", reasons: ["no managed tiers in the active preset"] };
    } else {
      // Resolve the source revision ONCE per review; every public schema is
      // then read at THAT ref, so a new upstream revision is picked up next
      // week. A failed resolution holds the review — the seed sha stays
      // documented provenance, never a silent fallback.
      const resolved = await resolveTerminalBenchRef(deps.fetchImpl);
      if ("problem" in resolved) {
        decision = { action: "hold", reasons: [`source revision not resolved: ${resolved.problem}`] };
      } else {
        sourceRef = resolved.ref;
        // deps.catalogRefs is the HOST PROJECT availability surface: it may be
        // project-filtered, so it only answers candidate IDENTITY here — never
        // a global finance/admission authority (that stays with `admission`).
        const [{ records, problems }, candidates] = await Promise.all([
          fetchTerminalBenchEvidence(deps.fetchImpl, resolved.ref),
          deps.catalogRefs(),
        ]);
        // The review's CURRENT model for a managed tier is its previous valid
        // auto assignment (the snapshot's working set), falling back to the
        // file model only where no assignment exists: a candidate must beat
        // what is actually RUNNING, or a mid-quality candidate would regress
        // an accepted assignment back toward the file fallback.
        const current: Record<string, Record<string, { model: string; variant?: string }>> = { [presetName]: {} };
        const preset = cfg.presets[presetName] ?? {};
        const previousTiers = base?.assignments[presetName] ?? {};
        for (const tier of managed) {
          const previousAssignment = previousTiers[tier];
          if (previousAssignment !== undefined) {
            current[presetName]![tier] = {
              model: previousAssignment.model,
              ...(previousAssignment.variant !== undefined ? { variant: previousAssignment.variant } : {}),
            };
            continue;
          }
          const tierCfg = preset[tier];
          if (tierCfg !== undefined) {
            current[presetName]![tier] = {
              model: tierCfg.model,
              ...(tierCfg.variant !== undefined ? { variant: tierCfg.variant } : {}),
            };
          }
        }
        decision = decideAdaptive({ candidates, current, evidence: records, admission: deps.admission ?? {} });
        evidenceUrls = boundEvidence(records.map((r) => r.sourceUrl));
        if (decision.action === "hold" && problems.length > 0 && decision.reasons.length === 0) {
          decision = { action: "hold", reasons: problems };
        }
      }
    }
  } catch (error) {
    decision = { action: "hold", reasons: [`review failed: ${(error as Error).message}`] };
  }

  // 3. CAS commit under the lock. An APPLY may cover a subset of managed
  // roles: newly accepted assignments MERGE with the previous working set, so
  // a role the decision held keeps its working assignment instead of falling
  // back to the file model on the next dispatch.
  const applied = decision.action === "apply";
  const nextAssignments: Record<string, Record<string, AdaptiveAssignment>> = {};
  for (const [preset, tiers] of Object.entries(base?.assignments ?? {})) nextAssignments[preset] = { ...tiers };
  if (decision.action === "apply") {
    for (const [preset, tiers] of Object.entries(decision.assignments)) {
      nextAssignments[preset] = { ...(nextAssignments[preset] ?? {}), ...tiers };
    }
  }
  const next: AdaptiveSnapshot = {
    version: ADAPTIVE_SNAPSHOT_VERSION,
    generation,
    configFingerprint: fingerprint,
    lastAttemptAt: nowIso,
    lastAppliedAt: applied ? nowIso : (base?.lastAppliedAt ?? null),
    assignments: nextAssignments,
    previousAssignments: base?.assignments ?? {},
    evidence: evidenceUrls,
    reasons: decision.reasons,
    ...(sourceRef !== undefined ? { sourceRef } : {}),
  };
  const committed = await commitAdaptiveSnapshotCAS({
    path,
    expected: { generation, configFingerprint: fingerprint },
    next,
    logger: deps.logger,
  });
  resetAdaptiveViewCache();
  if (committed !== "committed") return "busy";
  return applied ? "applied" : "held";
}
