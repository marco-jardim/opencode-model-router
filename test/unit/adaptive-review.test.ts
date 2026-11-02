import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  ADAPTIVE_WEEK_MS,
  decideAdaptive,
  formatAssignmentRef,
  isSnapshotCurrent,
  parseSubmissionRecord,
  resolveAdaptiveAssignment,
  weeklyReviewDue,
  type AdaptiveSnapshot,
  type EvidenceRecord,
} from "../../src/router/adaptive";
import {
  adaptiveStatePath,
  commitAdaptiveSnapshotCAS,
  readAdaptiveSnapshotFile,
  writeAdaptiveSnapshotAtomic,
} from "../../src/router/adaptive-store";
import {
  invalidateConfigCache,
  loadConfig,
  overridePath,
  statePath,
  OVERRIDE_FILENAME,
  configSourcesFingerprint,
  projectPinnedTiers,
  type RouterConfig,
} from "../../src/router/config";

// ---------------------------------------------------------------------------
// Weekly adaptive cloud review: decision (E/P/S), snapshot CAS state, and
// config provenance (project-pinned tiers keep their manual priority).
// The E/P/S matrix (P2, agreed): a candidate is applied ONLY when all three
// hold for a managed (preset, tier):
//   E (evidence): exact model identity via a public benchmark record
//      (benchmark version 4, enough trials, finite accuracy/CI in range).
//      A name match is never identity; an unversioned alias stays UNKNOWN.
//   P (preferable): the candidate's lower CI bound is strictly above the
//      current model's upper CI bound.
//   S (safe): same harness (agent id, agent version, reasoning effort),
//      mandatory capabilities known-OK, runtime cost/quota known-OK inside
//      the existing bounds. An undefined admission field is UNKNOWN and
//      holds — it is never read as success and no price is invented.
// ---------------------------------------------------------------------------

const rec = (
  model: string,
  accuracy: number,
  ci: number,
  agentVersion = "2.1.207",
): EvidenceRecord => ({
  model,
  modelLabel: model,
  agent: "claude-code",
  agentVersion,
  effort: "max",
  accuracy,
  ciHalfWidth: ci,
  nTrials: 330,
  benchmarkVersion: "4",
  sourceUrl: "https://example.test/record.json",
});

const snapshot = (over: Partial<AdaptiveSnapshot> = {}): AdaptiveSnapshot => ({
  version: 1,
  generation: 1,
  configFingerprint: "fp-1",
  lastAttemptAt: null,
  lastAppliedAt: null,
  assignments: {},
  previousAssignments: {},
  evidence: [],
  reasons: [],
  ...over,
});

describe("weeklyReviewDue", () => {
  it("is due without a snapshot and after a week, not due inside the week", () => {
    expect(weeklyReviewDue(null, 1_000_000)).toBe(true);
    const now = 1_800_000_000_000;
    expect(weeklyReviewDue(snapshot({ lastAttemptAt: new Date(now - ADAPTIVE_WEEK_MS - 1).toISOString() }), now)).toBe(true);
    expect(weeklyReviewDue(snapshot({ lastAttemptAt: new Date(now - ADAPTIVE_WEEK_MS + 60_000).toISOString() }), now)).toBe(false);
    expect(weeklyReviewDue(snapshot({ lastAttemptAt: null }), now)).toBe(true);
  });
});

describe("parseSubmissionRecord", () => {
  const valid = {
    metadata: {
      agent_display: { label: "Claude Code" },
      model_display: { label: "GLM-5.3" },
      reasoning_effort: "max",
    },
    metrics: { accuracy: 41.82, accuracy_ci95_half_width: 3.23, n_trials: 330 },
    source_filter: { agent: "claude-code", agent_version: "2.1.207", model_name: "anthropic/glm-5.3", reasoning_effort: "max" },
  };

  it("accepts the documented record shape", () => {
    const { record, problem } = parseSubmissionRecord(valid, "4", "https://example.test/r.json");
    expect(problem).toBeUndefined();
    expect(record?.model).toBe("anthropic/glm-5.3");
    expect(record?.accuracy).toBe(41.82);
    expect(record?.nTrials).toBe(330);
    expect(record?.benchmarkVersion).toBe("4");
  });

  it.each([
    ["missing accuracy", { ...valid, metrics: { accuracy_ci95_half_width: 3.23, n_trials: 330 } }],
    ["accuracy out of range", { ...valid, metrics: { ...valid.metrics, accuracy: 120 } }],
    ["missing model identity", { ...valid, source_filter: { ...valid.source_filter, model_name: "glm-5.3" } }],
    ["not an object", "nope"],
  ])("rejects a malformed record (%s)", (_name, raw) => {
    const { record, problem } = parseSubmissionRecord(raw, "4", "https://example.test/r.json");
    expect(record).toBeUndefined();
    expect(problem).toBeTruthy();
  });
});

describe("decideAdaptive - E/P/S", () => {
  const candidates = ["anthropic/glm-5.3", "zai/glm-5.3-flash"];
  // Fixture profile: every record below runs reasoning_effort "max".
  const current = { workstation: { fast: { model: "anthropic/glm-5.3", variant: "max" } } };
  const okAdmission = { quotasOk: true, capabilitiesOk: true } as const;

  it("applies only when E, P and S all pass", () => {
    const decision = decideAdaptive({
      candidates,
      current,
      evidence: [rec("anthropic/glm-5.3", 41.82, 3.23), rec("zai/glm-5.3-flash", 90, 2)],
      admission: okAdmission,
    });
    expect(decision.action).toBe("apply");
    if (decision.action === "apply") {
      expect(decision.assignments.workstation?.fast?.model).toBe("zai/glm-5.3-flash");
    }
  });

  it("holds when runtime cost/quota data is unknown, without inventing pricing", () => {
    const decision = decideAdaptive({
      candidates,
      current,
      evidence: [rec("anthropic/glm-5.3", 41.82, 3.23), rec("zai/glm-5.3-flash", 90, 2)],
      admission: { capabilitiesOk: true },
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("quota");
  });

  it("holds when the candidate lower CI bound does not clear the current upper bound (P)", () => {
    const decision = decideAdaptive({
      candidates,
      current,
      evidence: [rec("anthropic/glm-5.3", 41.82, 3.23), rec("zai/glm-5.3-flash", 44, 2)],
      admission: okAdmission,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toMatch(/CI bound/);
  });

  it("holds when the harness is not comparable (S)", () => {
    const decision = decideAdaptive({
      candidates,
      current,
      evidence: [rec("anthropic/glm-5.3", 41.82, 3.23), rec("zai/glm-5.3-flash", 90, 2, "9.9.9")],
      admission: okAdmission,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("harness");
  });

  it("holds when the candidate has no evidence record (E, identity unknown)", () => {
    const decision = decideAdaptive({
      candidates,
      current,
      evidence: [rec("anthropic/glm-5.3", 41.82, 3.23)],
      admission: okAdmission,
    });
    expect(decision.action).toBe("hold");
    expect(decision.reasons.join(" ")).toContain("unknown");
  });
});

describe("snapshot CAS state (separate file, manual state untouched)", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-mr-adaptive-store-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("commits atomically and rejects a stale generation (concurrent writer)", async () => {
    const path = join(dir, "adaptive.json");
    const logger = { warn: () => {} };
    const first = snapshot({ generation: 1, configFingerprint: "fp-1" });
    expect(await commitAdaptiveSnapshotCAS({ path, expected: null, next: first, logger })).toBe("committed");

    const second = snapshot({ generation: 2, configFingerprint: "fp-1" });
    expect(await commitAdaptiveSnapshotCAS({ path, expected: { generation: 1, configFingerprint: "fp-1" }, next: second, logger })).toBe("committed");

    const stale = snapshot({ generation: 3, configFingerprint: "fp-1" });
    expect(await commitAdaptiveSnapshotCAS({ path, expected: { generation: 1, configFingerprint: "fp-1" }, next: stale, logger })).toBe("concurrent");

    const after = readAdaptiveSnapshotFile(path);
    expect(after.snapshot?.generation).toBe(2);
  });

  it("reports a corrupt snapshot as UNKNOWN, never as success", () => {
    const path = join(dir, "adaptive.json");
    writeFileSync(path, "{ not json", "utf-8");
    const { snapshot: snap, problem } = readAdaptiveSnapshotFile(path);
    expect(snap).toBeUndefined();
    expect(problem).toBeTruthy();
    expect(weeklyReviewDue(null, Date.now())).toBe(true);
  });

  it("keeps the manual router state file byte-identical after an adaptive write", async () => {
    const manual = join(dir, "opencode-model-router.state.json");
    writeFileSync(manual, JSON.stringify({ activePreset: "anthropic" }), "utf-8");
    const path = join(dir, "opencode-model-router.adaptive.json");
    await writeAdaptiveSnapshotAtomic(path, snapshot({ generation: 1, configFingerprint: "fp" }));
    expect(readAdaptiveSnapshotFile(path).snapshot?.generation).toBe(1);
    expect(readFileSync(manual, "utf-8")).toBe(JSON.stringify({ activePreset: "anthropic" }));
  });
});

describe("config provenance and assignment overlay", () => {
  let tmpHome = "";
  let projDir = "";
  let restoreHomeEnv: () => void = () => {};

  const assertInsideTmpHome = (p: string): void => {
    const rel = tmpHome === "" ? "" : relative(tmpHome, p);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`refusing to touch ${p}: outside the temporary home`);
    }
  };

  beforeEach(() => {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    restoreHomeEnv = () => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    };
    tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-adaptive-prov-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    if (homedir() !== tmpHome) throw new Error("os.homedir() is not the temporary home");
    projDir = mkdtempSync(join(tmpHome, "proj-"));
    assertInsideTmpHome(overridePath());
    assertInsideTmpHome(statePath());
    invalidateConfigCache();
  });

  afterEach(() => {
    restoreHomeEnv();
    if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    tmpHome = "";
    projDir = "";
    invalidateConfigCache();
  });

  const writeGlobal = (content: unknown): void => {
    const p = overridePath();
    assertInsideTmpHome(p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(content), "utf-8");
  };

  const writeProject = (content: unknown): void => {
    const p = join(projDir, ".opencode", OVERRIDE_FILENAME);
    assertInsideTmpHome(p);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(content), "utf-8");
  };

  const agreedBlock = {
    managedTiers: { anthropic: ["fast", "medium", "heavy"] },
    local: false,
  };

  const baseConfig = {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-sonnet-5-5" },
        medium: { model: "anthropic/claude-sonnet-5-5", variant: "medium" },
        heavy: { model: "anthropic/claude-opus-5-5", variant: "xhigh" },
      },
    },
  };

  it("keeps a project-pinned tier on its manual model and overlays only managed, unpinned tiers", () => {
    writeGlobal({ ...baseConfig, adaptiveRouting: agreedBlock });
    writeProject({ presets: { anthropic: { fast: { model: "anthropic/project-choice" } } } });
    const cfg = loadConfig(projDir);
    const pinned = projectPinnedTiers(cfg);
    expect(pinned.has("anthropic.fast")).toBe(true);
    expect(pinned.has("anthropic.medium")).toBe(false);

    const snap = snapshot({
      configFingerprint: configSourcesFingerprint(projDir),
      assignments: { anthropic: { medium: { model: "zai/glm-5.3-flash", variant: "high" } } },
    });
    expect(resolveAdaptiveAssignment(cfg, "anthropic", "fast", snap, pinned)).toBeUndefined();
    const overlay = resolveAdaptiveAssignment(cfg, "anthropic", "medium", snap, pinned);
    expect(overlay).toEqual({ model: "zai/glm-5.3-flash", variant: "high" });
    expect(formatAssignmentRef(overlay!)).toBe("zai/glm-5.3-flash#high");
  });

  it("ignores a snapshot taken for a different config (fingerprint CAS)", () => {
    writeGlobal({ ...baseConfig, adaptiveRouting: agreedBlock });
    const cfg = loadConfig(projDir);
    const snap = snapshot({
      configFingerprint: "stale-fingerprint",
      assignments: { anthropic: { fast: { model: "zai/glm-5.3-flash" } } },
    });
    expect(isSnapshotCurrent(snap, configSourcesFingerprint(projDir))).toBe(false);
    expect(isSnapshotCurrent(snap, "stale-fingerprint")).toBe(true);
    void cfg;
  });

  it("does nothing without the opt-in block (default off)", () => {
    writeGlobal(baseConfig);
    const cfg: RouterConfig = loadConfig(projDir);
    const snap = snapshot({ assignments: { anthropic: { fast: { model: "zai/glm-5.3-flash" } } } });
    expect(resolveAdaptiveAssignment(cfg, "anthropic", "fast", snap, projectPinnedTiers(cfg))).toBeUndefined();
  });
});

// Silence the config-notices logger side effect in this suite.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
