import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  configSourcesFingerprint,
  invalidateConfigCache,
  overridePath,
  statePath,
  OVERRIDE_FILENAME,
} from "../../src/router/config";
import {
  adaptiveStatePath,
  readAdaptiveView,
  resetAdaptiveViewCache,
  runWeeklyAdaptiveReview,
} from "../../src/router/adaptive-store";

const SOURCE_REF = "1234567890abcdef1234567890abcdef12345678";
const API_ROOT = "https://api.github.com/repos/harbor-framework/terminal-bench";
const RAW_ROOT =
  `https://raw.githubusercontent.com/harbor-framework/terminal-bench/${SOURCE_REF}`;
const REVIEW_NOW = Date.parse("2026-11-01T12:00:00.000Z");
const OLD_ATTEMPT = new Date(
  REVIEW_NOW - 8 * 24 * 60 * 60 * 1000,
).toISOString();
const LOGGER = { warn: () => {} };

let tmpHome: string;
let projectDir: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

function assertInsideFixture(path: string): void {
  const rel = relative(tmpHome, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error(`Path outside fixture: ${path}`);
  }
}

function writeFixtureJson(path: string, value: unknown): void {
  assertInsideFixture(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writeGlobal(): void {
  writeFixtureJson(overridePath(), {
    activePreset: "workstation",
    presets: {
      workstation: {
        fast: { model: "base/g", variant: "high" },
      },
    },
    adaptiveRouting: {
      managedTiers: { workstation: ["fast"] },
      local: false,
    },
  });
  invalidateConfigCache();
  resetAdaptiveViewCache();
}

function writeSnapshot(value: unknown): void {
  writeFixtureJson(adaptiveStatePath(), value);
  resetAdaptiveViewCache();
}

function submission(model: string, accuracy: number): string {
  return JSON.stringify({
    metrics: {
      accuracy,
      accuracy_ci95_half_width: 5,
      n_trials: 100,
    },
    source_filter: {
      model_name: model,
      agent: "oc",
      agent_version: "1",
      reasoning_effort: "high",
    },
    metadata: {
      model_display: { label: model },
    },
  });
}

function evidenceRoutes(): ReadonlyMap<string, string> {
  const submissionsRoot = `${RAW_ROOT}/leaderboard/submissions`;
  return new Map([
    [
      `${API_ROOT}/commits/main`,
      JSON.stringify({ sha: SOURCE_REF }),
    ],
    [
      `${RAW_ROOT}/leaderboard/leaderboard.yaml`,
      "benchmark:\n  dataset_version_refs: ['4']\n",
    ],
    [
      `${API_ROOT}/contents/leaderboard/submissions?ref=${SOURCE_REF}`,
      JSON.stringify([
        { name: "g.json", download_url: `${submissionsRoot}/g.json` },
        { name: "p.json", download_url: `${submissionsRoot}/p.json` },
        { name: "a.json", download_url: `${submissionsRoot}/a.json` },
      ]),
    ],
    [`${submissionsRoot}/g.json`, submission("base/g", 40)],
    [`${submissionsRoot}/p.json`, submission("project/p", 90)],
    [`${submissionsRoot}/a.json`, submission("cand/a", 75)],
  ]);
}

function makeFetch(routes: ReadonlyMap<string, string>): typeof fetch {
  return async (input) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
    const body = routes.get(url);
    return new Response(body ?? "Not found", {
      status: body === undefined ? 404 : 200,
    });
  };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-global-review-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) {
    throw new Error("Fixture home is not active");
  }
  projectDir = mkdtempSync(join(tmpHome, "proj-"));
  assertInsideFixture(overridePath());
  assertInsideFixture(statePath());
  assertInsideFixture(adaptiveStatePath());
  invalidateConfigCache();
  resetAdaptiveViewCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnvironment("HOME", previousHome);
  restoreEnvironment("USERPROFILE", previousUserProfile);
  invalidateConfigCache();
  resetAdaptiveViewCache();
  const rel = relative(tmpdir(), tmpHome);
  if (
    isAbsolute(rel)
    || rel.includes("/")
    || rel.includes("\\")
    || !rel.startsWith("oc-mr-global-review-")
  ) {
    throw new Error("Refusing cleanup outside the owned fixture");
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("global adaptive review", () => {
  it("сравнивает кандидата с глобальной моделью при закреплении модели проекта", async () => {
    writeGlobal();
    writeFixtureJson(join(projectDir, ".opencode", OVERRIDE_FILENAME), {
      presets: {
        workstation: {
          fast: { model: "project/p", variant: "high" },
        },
      },
    });
    invalidateConfigCache();
    resetAdaptiveViewCache();

    const outcome = await runWeeklyAdaptiveReview({
      projectDir,
      fetchImpl: makeFetch(evidenceRoutes()),
      catalogRefs: async () => ["cand/a"],
      admission: { quotasOk: true, capabilitiesOk: true },
      logger: LOGGER,
      now: () => REVIEW_NOW,
    });

    expect(outcome).toBe("applied");
    expect(readAdaptiveView(projectDir)?.assignments.workstation?.fast)
      .toMatchObject({ model: "cand/a", variant: "high" });
  });

  it("не восстанавливает stale назначение при неуспешном пересмотре", async () => {
    writeGlobal();
    writeSnapshot({
      version: 1,
      generation: 1,
      configFingerprint: "stale-fingerprint",
      lastAttemptAt: OLD_ATTEMPT,
      lastAppliedAt: OLD_ATTEMPT,
      assignments: {
        workstation: {
          fast: { model: "old/a", variant: "high" },
        },
      },
      previousAssignments: {},
      evidence: [],
      reasons: [],
    });
    expect(readAdaptiveView(projectDir)).toBeNull();

    const outcome = await runWeeklyAdaptiveReview({
      projectDir,
      fetchImpl: makeFetch(new Map<string, string>()),
      catalogRefs: async () => ["cand/a"],
      logger: LOGGER,
      now: () => REVIEW_NOW,
    });

    expect(outcome).toBe("held");
    expect(readAdaptiveView(projectDir)?.assignments.workstation?.fast)
      .toBeUndefined();
  });

  it("отклоняет snapshot без assignments при действительном fingerprint", () => {
    writeGlobal();
    writeSnapshot({
      version: 1,
      generation: 1,
      configFingerprint: configSourcesFingerprint(projectDir),
      lastAttemptAt: null,
      lastAppliedAt: null,
      previousAssignments: {},
      evidence: [],
      reasons: [],
    });

    expect(readAdaptiveView(projectDir)).toBeNull();
  });
});
