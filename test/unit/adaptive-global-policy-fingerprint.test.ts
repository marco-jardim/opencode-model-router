import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  OVERRIDE_FILENAME,
  configSourcesFingerprint,
  invalidateConfigCache,
  loadConfig,
  overridePath,
  projectPinnedTiers,
  statePath,
} from "../../src/router/config";
import { emptyAdaptiveSnapshot, resolveAdaptiveAssignment } from "../../src/router/adaptive";
import { adaptiveStatePath, readAdaptiveView, resetAdaptiveViewCache } from "../../src/router/adaptive-store";

// ---------------------------------------------------------------------------
// Causal RED on the GLOBAL adaptive policy fingerprint (slice A3).
//
// The adaptive snapshot is GLOBAL (it lives next to the manual router state in
// the home directory), so its CAS fingerprint must be taken against the GLOBAL
// policy sources only (bundled config, global override, global preset/budget
// state). A project override file (a per-project model/variant pin) must:
//   * NOT change the fingerprint another project sees, and
//   * NOT invalidate a shared snapshot,
// while the pin still wins consumer-side for its own project
// (resolveAdaptiveAssignment + projectPinnedTiers), and a GLOBAL opt-in change
// still invalidates the snapshot for everyone.
//
// Isolation mirrors the protected suites: HOME is a temp directory; a guard
// fails the test before it can write anywhere else. No network.
// ---------------------------------------------------------------------------

let tmpHome = "";
let projA = "";
let projB = "";
let restoreHomeEnv: () => void = () => {};

function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `adaptive-global-policy-fingerprint.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}"`,
    );
  }
}

function writeGlobal(content: Record<string, unknown>): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf-8");
  invalidateConfigCache();
}

function writeProject(dir: string, content: Record<string, unknown>): void {
  const p = join(dir, ".opencode", OVERRIDE_FILENAME);
  const rel = relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`adaptive-global-policy-fingerprint.test: refusing to touch ${p}: outside the temporary home`);
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf-8");
  invalidateConfigCache();
}

const baseConfig = {
  activePreset: "workstation",
  presets: {
    workstation: {
      fast: { model: "base/g-model" },
      medium: { model: "base/g-model-medium" },
      heavy: { model: "base/g-model-heavy" },
    },
  },
};

const adaptiveBlock = { managedTiers: { workstation: ["fast", "medium", "heavy"] }, local: false };
const SNAPSHOT_A = "cand/a-model";

beforeEach(() => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  restoreHomeEnv = () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  };
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-adaptive-gfp-"));
  projA = mkdtempSync(join(tmpHome, "projA-"));
  projB = mkdtempSync(join(tmpHome, "projB-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) throw new Error("adaptive-global-policy-fingerprint.test: os.homedir() is not the temporary home");
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
  projA = "";
  projB = "";
  invalidateConfigCache();
  resetAdaptiveViewCache();
});

/** A fingerprint-current global snapshot assigning SNAPSHOT_A to workstation.fast. */
function writeSharedSnapshot(): string {
  const path = adaptiveStatePath();
  assertInsideTmpHome(path);
  const snapshot = {
    ...emptyAdaptiveSnapshot(1, configSourcesFingerprint(projA), new Date().toISOString()),
    assignments: { workstation: { fast: { model: SNAPSHOT_A } } },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  resetAdaptiveViewCache();
  return snapshot.configFingerprint;
}

describe("adaptive global policy fingerprint and project isolation (slice A3)", () => {
  it("two projects with one global policy share one fingerprint and one snapshot; a project pin changes only the pinning project", () => {
    writeGlobal({ ...baseConfig, adaptiveRouting: adaptiveBlock });
    // Project B pins fast to its own manual model; project A has no project override.
    writeProject(projB, { presets: { workstation: { fast: { model: "pin/b-model" } } } });

    const fpA = configSourcesFingerprint(projA);
    const fpB = configSourcesFingerprint(projB);
    expect(fpB).toBe(fpA);

    const written = writeSharedSnapshot();
    expect(written).toBe(fpA);
    // The shared snapshot is current for BOTH projects.
    const viewA = readAdaptiveView(projA);
    const viewB = readAdaptiveView(projB);
    expect(viewA?.assignments.workstation?.fast?.model).toBe(SNAPSHOT_A);
    expect(viewB?.assignments.workstation?.fast?.model).toBe(SNAPSHOT_A);

    // Consumer-side, per project: the pin removes only B's fast from management.
    const cfgA = loadConfig(projA);
    const cfgB = loadConfig(projB);
    expect(projectPinnedTiers(cfgA).has("workstation.fast")).toBe(false);
    expect(projectPinnedTiers(cfgB).has("workstation.fast")).toBe(true);
    expect(resolveAdaptiveAssignment(cfgA, "workstation", "fast", viewA, projectPinnedTiers(cfgA)))
      .toEqual({ model: SNAPSHOT_A });
    expect(resolveAdaptiveAssignment(cfgB, "workstation", "fast", viewB, projectPinnedTiers(cfgB)))
      .toBeUndefined();
  });

  it("touching a project override file does not invalidate the shared snapshot for its own project", () => {
    writeGlobal({ ...baseConfig, adaptiveRouting: adaptiveBlock });
    writeProject(projA, { presets: { workstation: { medium: { model: "pin/a-medium" } } } });
    const before = configSourcesFingerprint(projA);
    writeSharedSnapshot();
    expect(readAdaptiveView(projA)?.assignments.workstation?.fast?.model).toBe(SNAPSHOT_A);

    // Rewrite the project file (new content, new mtime): the GLOBAL policy did not change.
    writeProject(projA, { presets: { workstation: { medium: { model: "pin/a-medium-v2" } } } });
    expect(configSourcesFingerprint(projA)).toBe(before);
    expect(readAdaptiveView(projA)?.assignments.workstation?.fast?.model).toBe(SNAPSHOT_A);
  });

  it("control — a global opt-in change still invalidates the shared snapshot", () => {
    writeGlobal({ ...baseConfig, adaptiveRouting: adaptiveBlock });
    writeSharedSnapshot();
    expect(readAdaptiveView(projA)).not.toBeNull();

    writeGlobal({ ...baseConfig, adaptiveRouting: { managedTiers: { workstation: ["fast", "medium", "heavy"] }, local: true } });
    expect(configSourcesFingerprint(projA)).not.toBeNull();
    const view = readAdaptiveView(projA);
    expect(view).toBeNull();
    void existsSync;
  });
});
