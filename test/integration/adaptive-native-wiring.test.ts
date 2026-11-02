import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { configSourcesFingerprint, invalidateConfigCache, overridePath, statePath } from "../../src/router/config";
import { emptyAdaptiveSnapshot } from "../../src/router/adaptive";
import { adaptiveStatePath, resetAdaptiveViewCache } from "../../src/router/adaptive-store";
import { registerV2Hooks } from "../../src/compat/v2-hooks";

// ---------------------------------------------------------------------------
// Causal RED on the NATIVE wiring, not on a pure helper: the real
// registerV2Hooks drives a fake v2 context end to end, and the assertion reads
// the model the host would execute (event.input after tool.execute.before).
//
// Confirmed primary wiring defect (src/compat/v2-hooks.ts, subagent path):
//   1804: if (args.model === undefined && tierModel !== undefined) args.model = tierModel;
//   1809: if (args.model === undefined && cfg.adaptiveRouting !== undefined) { ...resolveAdaptiveAssignment... }
// The tier fill runs FIRST, so a managed tier with a fingerprint-current
// snapshot never reaches the adaptive overlay: the ordinary mapped fast tier
// receives the preset fallback model G instead of the snapshot assignment A.
//
// Isolation mirrors test/unit/adaptive-routing-config.test.ts (QA-1.1-1): the
// global override and the adaptive snapshot live strictly inside a temporary
// home; a guard fails the test before it can write anywhere else. No network,
// no model SDK, no real host: ctx.agent.list is faked, the v2 event bus is a
// local Map. Protected unit tests are untouched.
// ---------------------------------------------------------------------------

let tmpHome = "";
let tmpProject = "";
let restoreHomeEnv: () => void = () => {};

const FALLBACK_G = "base/g-model";
const SNAPSHOT_A = "cand/a-model";
const EXPLICIT_P = "prov/p-model";

/** Throw unless `p` is a path strictly inside the temporary home. */
function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `adaptive-native-wiring.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}" (QA-1.1-1)`,
    );
  }
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
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-wiring-"));
  tmpProject = mkdtempSync(join(tmpdir(), "oc-mr-wiring-proj-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) {
    throw new Error(`adaptive-native-wiring.test: os.homedir() is "${homedir()}", not the temporary home (QA-1.1-1)`);
  }
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
  if (tmpProject !== "") rmSync(tmpProject, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpHome = "";
  tmpProject = "";
  invalidateConfigCache();
  resetAdaptiveViewCache();
});

/** The opt-in block under test: workstation preset manages all three tiers. */
function writeConfig(extra: Record<string, unknown> = {}): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      activePreset: "workstation",
      presets: {
        workstation: {
          fast: { model: FALLBACK_G },
          medium: { model: "base/g-model-medium" },
          heavy: { model: "base/g-model-heavy" },
        },
      },
      subagentTiers: { helper: "fast", helperMedium: "medium" },
      adaptiveRouting: { managedTiers: { workstation: ["fast", "medium", "heavy"] }, local: true },
      ...extra,
    }),
    "utf-8",
  );
  invalidateConfigCache();
}

/** A fingerprint-current snapshot assigning SNAPSHOT_A to workstation.fast, plus any extra tier assignments. */
function writeCurrentSnapshot(extraAssignments: Record<string, { model: string }> = {}): void {
  const path = adaptiveStatePath();
  assertInsideTmpHome(path);
  const fingerprint = configSourcesFingerprint(tmpProject);
  const snapshot = {
    ...emptyAdaptiveSnapshot(1, fingerprint, new Date().toISOString()),
    assignments: { workstation: { fast: { model: SNAPSHOT_A }, ...extraAssignments } },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  resetAdaptiveViewCache();
}

/** A snapshot whose fingerprint cannot match the current config sources. */
function writeStaleSnapshot(): void {
  const path = adaptiveStatePath();
  assertInsideTmpHome(path);
  const snapshot = {
    ...emptyAdaptiveSnapshot(1, "stale-fingerprint-from-another-config", new Date().toISOString()),
    assignments: { workstation: { fast: { model: SNAPSHOT_A } } },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  resetAdaptiveViewCache();
}

interface EmitResult {
  readonly input: Record<string, unknown>;
  readonly legacyModels: readonly (string | undefined)[];
}

/**
 * Register the real v2 hooks over a minimal fake v2 host and emit one
 * subagent call. Returns the input the native execute would receive plus the
 * model the legacy before-hook observed.
 */
async function dispatchSubagent(opts: { model?: string; agent?: string }): Promise<EmitResult> {
  const handlers = new Map<string, Array<(event: unknown) => Promise<void>>>();
  const ctx = {
    location: { directory: tmpProject, project: { directory: tmpProject } },
    project: { directory: tmpProject },
    agent: {
      list: async () => ({ data: [{ id: "helper", mode: "subagent" }, { id: "helperMedium", mode: "subagent" }] }),
      transform: async (fn: (editor: { update: (name: string, mutate: (agent: { mode?: string }) => void) => void }) => void) => {
        fn({ update: () => {} });
        return { dispose: async () => {} };
      },
    },
    session: {
      get: async () => ({ agent: "orchestrator", parentID: null }),
      lookup: async () => null,
      hook: async (_kind: string, _fn: (event: unknown) => Promise<void>) => ({ dispose: async () => {} }),
    },
    permission: {
      hook: async (_kind: string, _fn: (event: unknown) => Promise<void>) => ({ dispose: async () => {} }),
    },
    command: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({});
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn: (editor: unknown) => void) => {
        fn({});
        return { dispose: async () => {} };
      },
      hook: async (kind: string, fn: (event: unknown) => Promise<void>) => {
        const list = handlers.get(kind) ?? [];
        list.push(fn);
        handlers.set(kind, list);
        return { dispose: async () => {} };
      },
    },
    on: (event: string, fn: (event: unknown) => Promise<void>) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return { dispose: async () => {} };
    },
  };
  const legacyModels: (string | undefined)[] = [];
  const hooks = {
    "tool.execute.before": async (_event: unknown, output: { args?: { model?: string } }) => {
      legacyModels.push(output.args?.model);
    },
  };
  const cleanup = await registerV2Hooks(ctx as never, hooks as never);
  try {
    const event: Record<string, unknown> = {
      id: "call-1",
      sessionID: "root-1",
      agent: "orchestrator",
      tool: "subagent",
      input: {
        agent: opts.agent ?? "helper",
        subagent_type: opts.agent ?? "helper",
        prompt: "run the helper",
        description: "run the helper",
        ...(opts.model === undefined ? {} : { model: opts.model }),
      },
    };
    for (const fn of handlers.get("execute.before") ?? []) await fn(event);
    return { input: (event.input ?? {}) as Record<string, unknown>, legacyModels };
  } finally {
    await cleanup();
  }
}

describe("adaptive native wiring — managed tier must receive the snapshot model", () => {
  it("managed fast tier + fingerprint-current snapshot: native execute receives A, not the preset fallback G", async () => {
    writeConfig();
    writeCurrentSnapshot();
    const result = await dispatchSubagent({});
    expect(result.legacyModels[0]).toBe(SNAPSHOT_A);
    expect(result.input.model).toBe(SNAPSHOT_A);
  });

  it("control — explicit caller model keeps priority even with a current snapshot", async () => {
    writeConfig();
    writeCurrentSnapshot();
    const result = await dispatchSubagent({ model: EXPLICIT_P });
    expect(result.input.model).toBe(EXPLICIT_P);
  });

  it("control — stale-fingerprint snapshot is rejected: fallback G stays", async () => {
    writeConfig();
    writeStaleSnapshot();
    const result = await dispatchSubagent({});
    expect(result.input.model).toBe(FALLBACK_G);
  });

  it("control — absent snapshot: fallback G stays", async () => {
    writeConfig();
    const result = await dispatchSubagent({});
    expect(result.input.model).toBe(FALLBACK_G);
  });

  it("control — a tier outside managedTiers keeps the file model even when a current snapshot names it", async () => {
    writeConfig({ adaptiveRouting: { managedTiers: { workstation: ["fast"] }, local: true } });
    writeCurrentSnapshot({ medium: { model: "cand/should-not-run" } });
    const result = await dispatchSubagent({ agent: "helperMedium" });
    expect(result.input.model).toBe("base/g-model-medium");
  });
});
