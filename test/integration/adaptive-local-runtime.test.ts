import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import ModelRouterPlugin from "../../src/index";
import { type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { configSourcesFingerprint, invalidateConfigCache, overridePath, statePath, type TierConfig } from "../../src/router/config";
import { emptyAdaptiveSnapshot } from "../../src/router/adaptive";
import { adaptiveStatePath, resetAdaptiveViewCache } from "../../src/router/adaptive-store";
import type { GpuSample } from "../../src/router/local-runtime";
import { lookupDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import type { RunnerCatalogModel } from "../../src/escalate/resume";

// ---------------------------------------------------------------------------
// Causal RED on the LOCAL llama-runtime binding at delegate task-start (P4).
//
// When adaptiveRouting.local === true AND a valid opencode-model-router.local.json
// exists next to the router state, the fast tier of THIS task binds to
// cfg.model.ref at task start (one immutable binding like applyAdaptiveAssignments:
// a copy of activeCfg, the global snapshot object is never mutated; medium/heavy
// escalations keep the snapshot models). Admission deny, broken config or
// local:false must leave the snapshot model and must NOT break delegation.
// The deps come from the new ctx.routerLocalRuntime field (same pattern as
// routerChildRunner/routerCatalog); plugin dispose() releases the supervisor.
//
// Harness is the delegate task-start harness of adaptive-delegate-binding.test.ts;
// no network, no host, no live models; HOME and every directory are temp.
// ---------------------------------------------------------------------------

const BASE = "base/g";
const MED_BASE = "base/gm";
const A_MODEL = "cand/a-model";
const M_MODEL = "cand/m-model";
const LOCAL_REF = "llama/qwen25-coder-14b";

const execFileAsync = promisify(execFile);

/** A git repo is the patch-mode prerequisite: the local tier runs only inside an isolated candidate worktree. */
async function initRepo(target: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: target, timeout: 15_000 });
  await execFileAsync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
    cwd: target,
    timeout: 15_000,
  });
}

const fullTier = (tier: TierConfig): TierConfig => ({ description: "test tier", whenToUse: ["testing"], ...tier } as TierConfig);

function model(id: string, variants: string[]): RunnerCatalogModel {
  const [providerID, ...rest] = id.split("/");
  return {
    providerID: providerID!,
    id: rest.join("/"),
    variants: variants.map((name) => ({ id: name })),
    limit: { input: 1_000_000, context: 1_000_000, output: 4_096 },
  };
}
const CATALOG = (): RunnerCatalogModel[] => [
  model(BASE, ["low", "medium", "high", "xhigh", "max"]),
  model(MED_BASE, ["low", "medium", "high", "xhigh", "max"]),
  model(A_MODEL, ["low", "medium", "high", "xhigh", "max"]),
  model(M_MODEL, ["low", "medium", "high", "xhigh", "max"]),
  // The local runtime model is known to the catalog so the ladder can plan it;
  // the assertions below still pin EVERY bound model to the exact ref.
  model(LOCAL_REF, ["low", "medium", "high", "xhigh", "max"]),
];

interface Run {
  readonly sid: string;
  readonly agent: string | undefined;
  readonly model: ChildSessionRequest["model"];
  readonly resumeSessionID: string | undefined;
}

interface LocalRuntimeFake {
  spawnCalls: number;
  killCalls: number;
  healthCalls: number;
  lastArgs: string[];
  healthQueue: Array<"up" | "down">;
  sampleState: GpuSample;
}

describe("delegate: local llama-runtime binding at task start (P4)", { timeout: 20_000 }, () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adaptive-local-"));
    dirs.push(dir);
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    resetDispatchRegistry();
    resetIngestState();
    invalidateConfigCache();
    resetAdaptiveViewCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const dispose of instances.splice(0)) await dispose();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    resetDispatchRegistry();
    resetIngestState();
    resetAdaptiveViewCache();
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function writeConfig(local: boolean): void {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(
      overridePath(),
      JSON.stringify({
        activePreset: "tst",
        presets: {
          tst: {
            fast: fullTier({ model: BASE, variant: "low", costRatio: 1 }),
            medium: fullTier({ model: MED_BASE, variant: "high", costRatio: 5 }),
          },
        },
        routing: {},
        adaptiveRouting: { managedTiers: { tst: ["fast", "medium"] }, local },
        enforcement: { escalate: { maxTotalAttempts: 6, costCeiling: { multiple: 100 } }, verify: {} },
      }),
      "utf-8",
    );
    invalidateConfigCache();
  }

  function writeSnapshot(fastModel: string, fastVariant: string, mediumModel = M_MODEL): void {
    const path = adaptiveStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const snapshot = {
      ...emptyAdaptiveSnapshot(1, configSourcesFingerprint(dir), new Date().toISOString()),
      assignments: {
        tst: {
          fast: { model: fastModel, variant: fastVariant },
          medium: { model: mediumModel, variant: "high" },
        },
      },
    };
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
    resetAdaptiveViewCache();
  }

  /** Write the local runtime config next to the router state. */
  function writeLocalRuntime(over: Record<string, unknown> = {}): void {
    const path = join(dirname(statePath()), "opencode-model-router.local.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        exe: "C:/fake/llama-server.exe",
        model: { ref: LOCAL_REF, path: "C:/fake/qwen.gguf" },
        ...over,
      }),
      "utf-8",
    );
  }

  /** Write a broken (schema-invalid) local runtime config. */
  function writeBrokenLocalRuntime(): void {
    const path = join(dirname(statePath()), "opencode-model-router.local.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{\"exe\": 42}", "utf-8");
  }

  async function setup(opts: {
    local: boolean;
    verdicts: boolean[];
    healthQueue?: Array<"up" | "down">;
    sampleState?: GpuSample;
    during?: (attempt: number) => void;
  }) {
    writeConfig(opts.local);
    writeSnapshot(A_MODEL, "xhigh");

    const localRuntime: LocalRuntimeFake = {
      spawnCalls: 0,
      killCalls: 0,
      healthCalls: 0,
      lastArgs: [],
      healthQueue: [...(opts.healthQueue ?? [])],
      sampleState: opts.sampleState ?? { gpuUtilPct: 20, freeVramMiB: 20_000 },
    };
    const runtimeDeps = {
      spawn: async (exe: string, args: string[]) => {
        localRuntime.spawnCalls += 1;
        localRuntime.lastArgs = args;
        void exe;
        return { pid: 4242, kill: async (): Promise<void> => { localRuntime.killCalls += 1; } };
      },
      health: async (host: string, port: number): Promise<"up" | "down"> => {
        void host;
        void port;
        localRuntime.healthCalls += 1;
        return localRuntime.healthQueue.length > 0 ? (localRuntime.healthQueue.shift() ?? "down") : "down";
      },
      sample: async (): Promise<GpuSample> => localRuntime.sampleState,
      now: (): number => Date.now(),
      sleep: async (ms: number): Promise<void> => {
        void ms;
      },
    };

    const runs: Run[] = [];
    const verdicts = [...opts.verdicts];
    let ingest: Ingest | undefined;
    let attempt = 0;
    let counter = 0;

    const childRunner = {
      async run(request: ChildSessionRequest) {
        if (request.system !== undefined) {
          const sid = `grader-${counter++}`;
          await request.onCreated(sid);
          return { sessionID: sid, text: JSON.stringify({ pass: verdicts.shift() ?? false, reasons: ["scripted verdict"] }) };
        }
        attempt += 1;
        const resume = request.resumeSessionID;
        let sid: string;
        if (resume !== undefined) {
          sid = resume;
        } else {
          sid = `child-${runs.length + 1}`;
        }
        await request.onCreated(sid);
        await request.onConfirmed?.(sid);
        runs.push({ sid, agent: request.agent, model: request.model, resumeSessionID: resume });
        opts.during?.(attempt);
        await ingest?.onStepEnded({
          id: `step-${sid}-${attempt}`,
          type: "session.step.ended",
          data: {
            sessionID: sid,
            assistantMessageID: `m${attempt}`,
            finish: "stop",
            cost: 0,
            tokens: { input: 5_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        });
        ingest?.onExecutionEnded(sid);
        return { sessionID: sid, text: "producer output" };
      },
      async dispose(sid: string) {
        void sid;
      },
    };

    const ctx = {
      directory: dir,
      worktree: dir,
      client: {
        session: {
          get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
          create: async () => ({ data: { id: `v1-child-${counter++}` } }),
          prompt: async () => ({ data: { parts: [{ type: "text", text: "producer output" }] } }),
          delete: async () => ({}),
        },
      },
      routerHost: "v2" as const,
      routerChildRunner: childRunner,
      routerCatalog: async () => CATALOG(),
      routerOnIngest: (created: Ingest) => { ingest = created; },
      routerLocalRuntime: runtimeDeps,
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as {
      tool: { delegate: { execute(args: Record<string, unknown>, ctx?: { sessionID?: string }): Promise<string> } };
      dispose(): Promise<void>;
    };
    instances.push(() => hooks.dispose());
    return {
      runs,
      localRuntime,
      run: () =>
        hooks.tool.delegate.execute(
          { tier: "fast", task: "VERIFY:required\ndo x", acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" },
          { sessionID: "orchestrator" },
        ),
    };
  }

  it("локальная модель биндится на fast при свободном GPU: все fast-попытки локальны, medium остаётся облачным", async () => {
    await initRepo(dir);
    const attributed: Array<string | null> = [];
    const t = await setup({
      local: true,
      verdicts: [false, false, true],
      healthQueue: ["up"],
      sampleState: { gpuUtilPct: 20, freeVramMiB: 20_000 },
      during: () => {
        const record = lookupDispatch("child-1");
        if (record !== undefined) attributed.push(record.model ?? null);
      },
    });
    writeLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");

    expect(t.runs.map((r) => `${r.model?.providerID}/${r.model?.modelID}`)).toEqual([
      LOCAL_REF,
      LOCAL_REF,
      M_MODEL,
    ]);
    expect(attributed).toEqual([LOCAL_REF, LOCAL_REF, M_MODEL]);
    // health "up" immediately: the process is already alive, nothing is spawned.
    expect(t.localRuntime.spawnCalls).toBe(0);
  });

  it("занятый GPU оставляет облачную модель снапшота и не трогает runtime", async () => {
    const t = await setup({
      local: true,
      verdicts: [true],
      sampleState: { gpuUtilPct: 95, freeVramMiB: 20_000 },
    });
    writeLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs[0]!.model?.modelID).toBe("a-model");
    expect(t.localRuntime.spawnCalls).toBe(0);
    expect(t.localRuntime.healthCalls).toBe(0);
  });

  it("битый local-конфиг не ломает делегирование: облачная модель снапшота", async () => {
    const t = await setup({
      local: true,
      verdicts: [true],
    });
    writeBrokenLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs[0]!.model?.modelID).toBe("a-model");
    expect(t.localRuntime.spawnCalls).toBe(0);
  });

  it("local:false не использует локальную модель даже при валидном конфиге и свободном GPU", async () => {
    const t = await setup({
      local: false,
      verdicts: [true],
      sampleState: { gpuUtilPct: 20, freeVramMiB: 20_000 },
    });
    writeLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs[0]!.model?.modelID).toBe("a-model");
    expect(t.localRuntime.spawnCalls).toBe(0);
  });
});
