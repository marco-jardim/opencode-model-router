import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import ModelRouterPlugin from "../../src/index";
import { type ChildSessionRequest, type RouterPluginInput } from "../../src/compat/child-session";
import { configSourcesFingerprint, invalidateConfigCache, OVERRIDE_FILENAME, overridePath, statePath, type TierConfig } from "../../src/router/config";
import { emptyAdaptiveSnapshot } from "../../src/router/adaptive";
import { adaptiveStatePath, resetAdaptiveViewCache } from "../../src/router/adaptive-store";
import type { GpuSample } from "../../src/router/local-runtime";
import { lookupDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import type { RunnerCatalogModel } from "../../src/escalate/resume";

// ---------------------------------------------------------------------------
// Causal RED on PATCH-MODE for the local llama-runtime fast tier (P5 slice B+C).
//
// A local fast task must NOT touch the working tree: in a git project the
// delegate runs the local child in an isolated candidate worktree under the
// OS temp dir (name contains "router-local-"), extracts the patch artifact
// (digest + changed files) into the dispatch attribution record, and removes
// the candidate on plugin dispose. A non-git project and a project pin on
// fast never use the local path at all (cloud snapshot model, ordinary cwd,
// zero spawns).
//
// Harness mirrors adaptive-local-runtime.test.ts; git calls go through
// promisify(execFile) with timeouts; HOME and every directory are temp.
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

const BASE = "base/g";
const MED_BASE = "base/gm";
const A_MODEL = "cand/a-model";
const M_MODEL = "cand/m-model";
const LOCAL_REF = "llama/qwen25-coder-14b";
const PINNED_REF = "proj/pinned";

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
  model(LOCAL_REF, ["low", "medium", "high", "xhigh", "max"]),
  model(PINNED_REF, ["low", "medium", "high", "xhigh", "max"]),
];

interface Run {
  readonly sid: string;
  readonly agent: string | undefined;
  readonly model: ChildSessionRequest["model"];
  readonly resumeSessionID: string | undefined;
  readonly cwd: string | undefined;
}

interface LocalRuntimeFake {
  spawnCalls: number;
  killCalls: number;
  healthCalls: number;
  healthQueue: Array<"up" | "down">;
  sampleState: GpuSample;
}

describe("delegate: local runtime patch-mode in an isolated candidate worktree (P5)", { timeout: 30_000 }, () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Array<() => Promise<void>> = [];
  const dirs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "adaptive-local-patch-"));
    dirs.push(dir);
    const home = mkdtempSync(join(tmpdir(), "adaptive-local-patch-home-"));
    dirs.push(home);
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
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

  async function initRepo(target: string): Promise<void> {
    await execFileAsync("git", ["init"], { cwd: target, timeout: 15_000 });
    await execFileAsync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
      cwd: target,
      timeout: 15_000,
    });
  }

  async function porcelain(target: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: target, timeout: 15_000 });
    return String(stdout).trim();
  }

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

  function writeProjectPin(): void {
    const projectDir = join(dir, ".opencode");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, OVERRIDE_FILENAME),
      JSON.stringify({ presets: { tst: { fast: { model: PINNED_REF, variant: "low" } } } }),
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

  function writeLocalRuntime(): void {
    const path = join(dirname(statePath()), "opencode-model-router.local.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ exe: "C:/fake/llama-server.exe", model: { ref: LOCAL_REF, path: "C:/fake/qwen.gguf" } }),
      "utf-8",
    );
  }

  async function setup(opts: {
    local: boolean;
    verdicts: boolean[];
    healthQueue?: Array<"up" | "down">;
    sampleState?: GpuSample;
  }) {
    writeConfig(opts.local);
    writeSnapshot(A_MODEL, "xhigh");

    const localRuntime: LocalRuntimeFake = {
      spawnCalls: 0,
      killCalls: 0,
      healthCalls: 0,
      healthQueue: [...(opts.healthQueue ?? [])],
      sampleState: opts.sampleState ?? { gpuUtilPct: 20, freeVramMiB: 20_000 },
    };
    const runtimeDeps = {
      spawn: async (exe: string, args: string[]) => {
        void exe;
        void args;
        localRuntime.spawnCalls += 1;
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
    let counter = 0;

    const childRunner = {
      async run(request: ChildSessionRequest) {
        if (request.system !== undefined) {
          const sid = `grader-${counter++}`;
          await request.onCreated(sid);
          return { sessionID: sid, text: JSON.stringify({ pass: verdicts.shift() ?? false, reasons: ["scripted verdict"] }) };
        }
        const resume = request.resumeSessionID;
        const sid = resume ?? `child-${runs.length + 1}`;
        await request.onCreated(sid);
        await request.onConfirmed?.(sid);
        runs.push({ sid, agent: request.agent, model: request.model, resumeSessionID: resume, cwd: request.cwd });
        if (`${request.model?.providerID}/${request.model?.modelID}` === LOCAL_REF) {
          writeFileSync(join(String(request.cwd ?? dir), "local-change.txt"), "patch-mode probe", "utf-8");
        }
        await ingest?.onStepEnded({
          id: `step-${sid}`,
          type: "session.step.ended",
          data: {
            sessionID: sid,
            assistantMessageID: "m1",
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
    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await hooks.dispose();
    };
    instances.push(dispose);
    return {
      runs,
      localRuntime,
      dispose,
      run: () =>
        hooks.tool.delegate.execute(
          { tier: "fast", task: "VERIFY:required\ndo x", acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" },
          { sessionID: "orchestrator" },
        ),
    };
  }

  it("локальная задача работает в изолированном candidate-worktree: дерево не тронуто, патч извлечён в атрибуцию, candidate убран dispose", async () => {
    await initRepo(dir);
    const t = await setup({
      local: true,
      verdicts: [true],
      healthQueue: ["up"],
      sampleState: { gpuUtilPct: 20, freeVramMiB: 20_000 },
    });
    writeLocalRuntime();
    expect(await porcelain(dir)).toBe("");

    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs[0]!.model?.modelID).toBe("qwen25-coder-14b");

    const cwd = t.runs[0]!.cwd;
    expect(cwd).toBeDefined();
    expect(cwd).not.toBe(dir);
    expect(String(cwd)).toContain("router-local-");

    // Рабочее дерево не изменено: ни untracked-файла, ни любого другого статуса.
    expect(await porcelain(dir)).toBe("");
    expect(existsSync(join(dir, "local-change.txt"))).toBe(false);

    // Артефакт патча доступен в записи атрибуции делегирования.
    const record = lookupDispatch("child-1");
    expect(record?.localPatchDigest).toBeTruthy();
    expect(record?.localChangedFiles).toContain("local-change.txt");

    // dispose плагина убирает candidate-worktree полностью.
    await t.dispose();
    expect(existsSync(String(cwd))).toBe(false);
  });

  it("не-git проект не использует локальную модель: облачная модель и обычный cwd", async () => {
    const t = await setup({
      local: true,
      verdicts: [true],
      healthQueue: ["up"],
      sampleState: { gpuUtilPct: 20, freeVramMiB: 20_000 },
    });
    writeLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(t.runs[0]!.model?.modelID).toBe("a-model");
    expect(t.runs[0]!.cwd ?? dir).toBe(dir);
    expect(t.localRuntime.spawnCalls).toBe(0);
  });

  it("project pin на fast отключает локальный путь: pinned-модель, acquire не вызывается", async () => {
    await initRepo(dir);
    writeProjectPin();
    const t = await setup({
      local: true,
      verdicts: [true],
      healthQueue: ["up"],
      sampleState: { gpuUtilPct: 20, freeVramMiB: 20_000 },
    });
    writeLocalRuntime();
    const result = await t.run();
    expect(result).toContain("[router ✓ verified:");
    expect(`${t.runs[0]!.model?.providerID}/${t.runs[0]!.model?.modelID}`).toBe(PINNED_REF);
    expect(t.localRuntime.spawnCalls).toBe(0);
    expect(String(t.runs[0]!.cwd ?? "")).not.toContain("router-local-");
  });
});
