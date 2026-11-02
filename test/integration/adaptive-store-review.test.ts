import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { configSourcesFingerprint, invalidateConfigCache, overridePath, statePath } from "../../src/router/config";
import { emptyAdaptiveSnapshot } from "../../src/router/adaptive";
import {
  adaptiveStatePath,
  readAdaptiveSnapshotFile,
  resetAdaptiveViewCache,
  runWeeklyAdaptiveReview,
  writeAdaptiveSnapshotAtomic,
} from "../../src/router/adaptive-store";

// ---------------------------------------------------------------------------
// Causal RED on the weekly review STORE composition (slices A4 + A5), driven
// through the real runWeeklyAdaptiveReview with a FAKE fetch (no network).
//
// A4 — source revision provenance: the evidence source revision must be
// RESOLVED once per review from the official allowlisted GitHub repo
// (api.github.com/repos/harbor-framework/terminal-bench/commits/main),
// validated as a 40-hex sha, and then used for EVERY public schema fetch.
// The old code hardcodes TERMINAL_BENCH_REF forever, so a new upstream SHA is
// never picked up. Arbitrary URLs from a payload stay ignored.
//
// A5 — partial apply merges with previous working assignments: an APPLY may
// cover a subset of managed roles; roles it does not re-assign keep their
// previous working assignment (never fall back to the file model), and the
// review's `current` for a role with a previous valid auto assignment is that
// assignment (a candidate must beat it, not the base file model G).
//
// Isolation mirrors the protected suites: HOME is a temp directory, guarded.
// ---------------------------------------------------------------------------

const REPO = "harbor-framework/terminal-bench";
const COMMITS_MAIN = `https://api.github.com/repos/${REPO}/commits/main`;
const SHA1 = "1234567890abcdef1234567890abcdef12345678";
const SHA2 = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const leaderboardUrl = (ref: string) => `https://raw.githubusercontent.com/${REPO}/${ref}/leaderboard/leaderboard.yaml`;
const submissionsUrl = (ref: string) => `https://api.github.com/repos/${REPO}/contents/leaderboard/submissions?ref=${ref}`;
const rawUrl = (ref: string, name: string) => `https://raw.githubusercontent.com/${REPO}/${ref}/leaderboard/submissions/${name}`;

const LEADERBOARD_YAML = "benchmark:\n  dataset_version_refs: ['4']\n";

/** One terminal-bench submission JSON in the documented shape. */
const submission = (model: string, accuracy: number, ci: number, nTrials = 100) => ({
  metrics: { accuracy, accuracy_ci95_half_width: ci, n_trials: nTrials },
  source_filter: { model_name: model, agent: "oc", agent_version: "1", reasoning_effort: "high" },
  metadata: { model_display: { label: model } },
});

type Routes = Record<string, unknown>;

function makeFetch(routes: Routes): { fetchImpl: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = async (url: string): Promise<{ ok: boolean; text: () => Promise<string> }> => {
    urls.push(url);
    const body = routes[url];
    if (body === undefined) return { ok: false, text: async () => "" };
    return { ok: true, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, urls };
}

/** Routes for a fully working source at `ref` with the given submission files. */
function sourceRoutes(ref: string, files: Array<{ name: string; body: unknown }>): Routes {
  const routes: Routes = {
    [COMMITS_MAIN]: { sha: ref },
    [leaderboardUrl(ref)]: LEADERBOARD_YAML,
    [submissionsUrl(ref)]: files.map((f) => ({ name: f.name, download_url: rawUrl(ref, f.name) })),
  };
  for (const f of files) routes[rawUrl(ref, f.name)] = f.body;
  return routes;
}

const LOGGER = { warn: () => {} };

let tmpHome = "";
let projDir = "";
let restoreHomeEnv: () => void = () => {};

function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`adaptive-store-review.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}"`);
  }
}

function writeGlobal(preset: Record<string, unknown>, managedTiers: string[]): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      activePreset: "workstation",
      presets: { workstation: preset },
      adaptiveRouting: { managedTiers: { workstation: managedTiers }, local: false },
    }),
    "utf-8",
  );
  invalidateConfigCache();
}

/** A due (8 days old) fingerprint-current snapshot; `assignments` is its working set. */
function writeDueSnapshot(assignments: Record<string, { model: string; variant?: string }>): void {
  const path = adaptiveStatePath();
  assertInsideTmpHome(path);
  const snapshot = {
    ...emptyAdaptiveSnapshot(1, configSourcesFingerprint(projDir), new Date().toISOString()),
    lastAttemptAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    assignments: { workstation: assignments },
  };
  writeFileSync(path, JSON.stringify(snapshot), "utf-8");
  resetAdaptiveViewCache();
}

function committed() {
  return readAdaptiveSnapshotFile(adaptiveStatePath()).snapshot;
}

async function review(routes: Routes, catalogRefs: readonly string[], admission?: { quotasOk?: boolean; capabilitiesOk?: boolean }) {
  const { fetchImpl, urls } = makeFetch(routes);
  const outcome = await runWeeklyAdaptiveReview({
    projectDir: projDir,
    fetchImpl,
    catalogRefs: async () => catalogRefs,
    ...(admission === undefined ? {} : { admission }),
    logger: LOGGER,
  });
  return { outcome, urls, snapshot: committed() };
}

beforeEach(() => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  restoreHomeEnv = () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  };
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-store-review-"));
  projDir = mkdtempSync(join(tmpHome, "proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) throw new Error("adaptive-store-review.test: os.homedir() is not the temporary home");
  assertInsideTmpHome(overridePath());
  assertInsideTmpHome(statePath());
  invalidateConfigCache();
  resetAdaptiveViewCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreHomeEnv();
  if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpHome = "";
  projDir = "";
  invalidateConfigCache();
  resetAdaptiveViewCache();
});

describe("weekly review source provenance (slice A4)", () => {
  it("resolves the source revision once per review and stamps it into the committed snapshot", async () => {
    writeGlobal({ fast: { model: "base/g" } }, ["fast"]);
    const routes = sourceRoutes(SHA1, [{ name: "s1.json", body: submission("cand/x", 90, 1) }]);
    const { outcome, urls, snapshot } = await review(routes, ["cand/x"]);
    // Admission is UNKNOWN in production, so the decision itself holds — the
    // provenance must still be resolved and committed.
    expect(outcome).toBe("held");
    expect(urls.some((u) => u === COMMITS_MAIN)).toBe(true);
    expect(urls.filter((u) => u.includes("/commits/main"))).toHaveLength(1);
    expect(urls.some((u) => u === leaderboardUrl(SHA1))).toBe(true);
    expect(snapshot?.sourceRef).toBe(SHA1);
    expect(snapshot?.evidence.some((u) => u === rawUrl(SHA1, "s1.json"))).toBe(true);
  });

  it("a new upstream revision is picked up by the next week's review", async () => {
    writeGlobal({ fast: { model: "base/g" } }, ["fast"]);
    const first = await review(
      sourceRoutes(SHA1, [{ name: "s1.json", body: submission("cand/x", 90, 1) }]),
      ["cand/x"],
    );
    expect(first.snapshot?.sourceRef).toBe(SHA1);

    // One week passes; upstream moved to a new revision.
    const aged = { ...first.snapshot!, lastAttemptAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() };
    await writeAdaptiveSnapshotAtomic(adaptiveStatePath(), aged);
    resetAdaptiveViewCache();

    const second = await review(
      sourceRoutes(SHA2, [{ name: "s2.json", body: submission("cand/x", 91, 1) }]),
      ["cand/x"],
    );
    expect(second.outcome).toBe("held");
    expect(second.snapshot?.generation).toBe((aged.generation ?? 1) + 1);
    expect(second.snapshot?.sourceRef).toBe(SHA2);
    expect(second.urls.some((u) => u === leaderboardUrl(SHA2))).toBe(true);
    expect(second.urls.some((u) => u === leaderboardUrl(SHA1))).toBe(false);
  });

  it("a revision that is not a 40-hex sha holds the review with a reason and fetches no payload", async () => {
    writeGlobal({ fast: { model: "base/g" } }, ["fast"]);
    const { outcome, urls, snapshot } = await review(
      { [COMMITS_MAIN]: { sha: "not-a-sha" }, [leaderboardUrl("not-a-sha")]: LEADERBOARD_YAML },
      ["cand/x"],
    );
    expect(outcome).toBe("held");
    expect(urls).toEqual([COMMITS_MAIN]);
    expect(snapshot?.sourceRef).toBeUndefined();
    expect(snapshot?.reasons.join(" ").toLowerCase()).toContain("revision");
  });

  it("control — a download_url outside the allowlisted raw prefix is ignored, never fetched", async () => {
    writeGlobal({ fast: { model: "base/g" } }, ["fast"]);
    const routes: Routes = {
      [COMMITS_MAIN]: { sha: SHA1 },
      [leaderboardUrl(SHA1)]: LEADERBOARD_YAML,
      [submissionsUrl(SHA1)]: [
        { name: "good.json", download_url: rawUrl(SHA1, "good.json") },
        { name: "evil.json", download_url: "https://evil.example.com/submissions/evil.json" },
      ],
      [rawUrl(SHA1, "good.json")]: submission("cand/x", 90, 1),
    };
    const { urls, snapshot } = await review(routes, ["cand/x"]);
    expect(urls.some((u) => u.startsWith("https://evil.example.com"))).toBe(false);
    expect(snapshot?.evidence).toEqual([rawUrl(SHA1, "good.json")]);
  });
});

describe("weekly review partial apply and regression guard (slice A5)", () => {
  it("the review's current for a role with a previous auto assignment is that assignment, not the file model G", async () => {
    // File model G (50±2); previous auto assignment A (80±2); candidate B (60±2)
    // clears G but NOT A. The review must hold and keep A working.
    writeGlobal({ fast: { model: "base/g", variant: "high" } }, ["fast"]);
    const routes = sourceRoutes(SHA1, [
      { name: "g.json", body: submission("base/g", 50, 2) },
      { name: "a.json", body: submission("cand/a", 80, 2) },
      { name: "b.json", body: submission("cand/b", 60, 2) },
    ]);
    writeDueSnapshot({ fast: { model: "cand/a", variant: "high" } });
    const { outcome, snapshot } = await review(routes, ["cand/b"], { quotasOk: true, capabilitiesOk: true });
    expect(outcome).toBe("held");
    expect(snapshot?.assignments.workstation?.fast?.model).toBe("cand/a");
  });

  it("a partial apply merges with the previous working assignments instead of dropping held roles", async () => {
    // fast has no previous assignment and its candidate B (60±2) clears the
    // file model G (50±2): fast is applied. heavy's previous working assignment
    // cand/h has no evidence record (E unknown): heavy is held — and must KEEP
    // cand/h, not fall back to the file model.
    writeGlobal({ fast: { model: "base/g", variant: "high" }, heavy: { model: "base/gh" } }, ["fast", "heavy"]);
    const routes = sourceRoutes(SHA1, [
      { name: "g.json", body: submission("base/g", 50, 2) },
      { name: "b.json", body: submission("cand/b", 60, 2) },
    ]);
    writeDueSnapshot({ heavy: { model: "cand/h" } });
    const { outcome, snapshot } = await review(routes, ["cand/b"], { quotasOk: true, capabilitiesOk: true });
    expect(outcome).toBe("applied");
    // The assignment keeps the VERIFIED profile ("high") — a new model never
    // silently keeps or drops the previous tier's variant.
    expect(snapshot?.assignments.workstation).toEqual({
      fast: { model: "cand/b", variant: "high" },
      heavy: { model: "cand/h" },
    });
    expect(snapshot?.previousAssignments.workstation).toEqual({ heavy: { model: "cand/h" } });
  });
});
