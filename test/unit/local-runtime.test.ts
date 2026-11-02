import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  admitLocalRuntime,
  createLocalRuntimeSupervisor,
  loadLocalRuntimeConfig,
  type GpuSample,
  type LocalRuntimeConfig,
} from "../../src/router/local-runtime";
import { statePath } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Causal RED on the LOCAL llama-server runtime (P4 slice), unit level.
//
// Covers three pure seams of src/router/local-runtime.ts:
//   * loadLocalRuntimeConfig — schema-validated parse of
//     opencode-model-router.local.json (missing/broken/invalid → null, never throws);
//   * admitLocalRuntime — GPU admission gate (UNKNOWN measurements are a DENY,
//     boundaries are inclusive);
//   * createLocalRuntimeSupervisor — acquire/release against injected fakes
//     (spawn/health/sample/now/sleep), single-flight spawn, readiness polling
//     by virtual clock, kill of ONLY the spawned child.
//
// Isolation: HOME/USERPROFILE point at a temp directory; a guard fails the
// test before it can write anywhere else. Only sections A/B touch the temp fs;
// section C is pure in-memory fakes (no timers, no network, no real fs).
// ---------------------------------------------------------------------------

let tmpDir = "";
let restoreHomeEnv: () => void = () => {};

const LOCAL_FILENAME = "opencode-model-router.local.json";

function assertInsideTmp(p: string): void {
  const rel = tmpDir === "" ? "" : relative(tmpDir, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `local-runtime.test: refusing to touch ${p}: it is not inside the temporary directory "${tmpDir}"`,
    );
  }
}

/** Write a candidate local-runtime config (object or raw string) into `dir`. */
function writeCfgFile(dir: string, content: unknown): string {
  const p = join(dir, LOCAL_FILENAME);
  assertInsideTmp(p);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  return p;
}

const cfg = (): LocalRuntimeConfig => ({
  exe: "C:/fake/llama-server.exe",
  model: { ref: "llama/qwen25-coder-14b", path: "C:/fake/qwen.gguf" },
  host: "127.0.0.1",
  port: 8080,
  readinessTimeoutMs: 120_000,
  admission: { maxGpuUtilPct: 70, minFreeVramMiB: 10_240 },
  extraArgs: [],
});

interface DepsOpts {
  healthQueue?: Array<"up" | "down">;
  defaultHealth?: "up" | "down";
  sampleState?: GpuSample;
}

/** In-memory fakes with call counters; virtual clock advances +30000 per now(). */
function makeDeps(opts: DepsOpts = {}) {
  const counters = { spawnCalls: 0, killCalls: 0, healthCalls: 0 };
  let lastArgs: string[] = [];
  const queue = [...(opts.healthQueue ?? [])];
  let nowValue = 0;
  return {
    counters,
    lastArgs: (): string[] => lastArgs,
    deps: {
      spawn: (exe: string, args: string[]) => {
        void exe;
        counters.spawnCalls += 1;
        lastArgs = args;
        return { pid: 4242, kill: async (): Promise<void> => { counters.killCalls += 1; } };
      },
      health: async (host: string, port: number): Promise<"up" | "down"> => {
        void host;
        void port;
        counters.healthCalls += 1;
        return queue.length > 0 ? (queue.shift() ?? opts.defaultHealth ?? "down") : (opts.defaultHealth ?? "down");
      },
      sample: async (): Promise<GpuSample> => opts.sampleState ?? { gpuUtilPct: 20, freeVramMiB: 20_000 },
      now: (): number => {
        const v = nowValue;
        nowValue += 30_000;
        return v;
      },
      sleep: async (ms: number): Promise<void> => {
        void ms;
      },
    },
  };
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
  tmpDir = mkdtempSync(join(tmpdir(), "local-runtime-"));
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  assertInsideTmp(statePath());
});

afterEach(() => {
  restoreHomeEnv();
  if (tmpDir !== "") rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpDir = "";
});

describe("admitLocalRuntime (P4)", () => {
  it("неизвестная утилизация GPU (null) отклоняет запуск с непустой причиной", () => {
    const r = admitLocalRuntime({ gpuUtilPct: null, freeVramMiB: 20_000 }, cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
  });

  it("неизвестный свободный VRAM (null) отклоняет запуск", () => {
    const r = admitLocalRuntime({ gpuUtilPct: 20, freeVramMiB: null }, cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
  });

  it("превышение maxGpuUtilPct отклоняет запуск", () => {
    const r = admitLocalRuntime({ gpuUtilPct: 95, freeVramMiB: 20_000 }, cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
  });

  it("границы включаются: ровно maxGpuUtilPct и ровно minFreeVramMiB допустимы", () => {
    const r = admitLocalRuntime({ gpuUtilPct: 70, freeVramMiB: 10_240 }, cfg());
    expect(r).toEqual({ ok: true });
  });
});

describe("loadLocalRuntimeConfig (P4)", () => {
  it("валидный минимальный конфиг получает все дефолты и сохраняет ref", () => {
    const minimal = { exe: "C:/fake/llama-server.exe", model: { ref: "llama/qwen25-coder-14b", path: "C:/fake/qwen.gguf" } };
    const p = writeCfgFile(dirname(statePath()), minimal);
    const loaded = loadLocalRuntimeConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.model.ref).toBe("llama/qwen25-coder-14b");
    expect(loaded!.model.path).toBe("C:/fake/qwen.gguf");
    expect(loaded!.host).toBe("127.0.0.1");
    expect(loaded!.port).toBe(8080);
    expect(loaded!.readinessTimeoutMs).toBe(120_000);
    expect(loaded!.admission).toEqual({ maxGpuUtilPct: 70, minFreeVramMiB: 10_240 });
    expect(loaded!.extraArgs).toEqual([]);
    expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual(minimal);
  });

  it("битый JSON возвращает null, не бросает", () => {
    writeCfgFile(tmpDir, "{ not json");
    expect(loadLocalRuntimeConfig(join(tmpDir, LOCAL_FILENAME))).toBeNull();
  });

  it("отсутствующий файл возвращает null", () => {
    expect(loadLocalRuntimeConfig(join(tmpDir, LOCAL_FILENAME))).toBeNull();
  });

  it("ref без провайдера (no-slash) не проходит схему", () => {
    writeCfgFile(tmpDir, { exe: "C:/fake/llama-server.exe", model: { ref: "no-slash", path: "C:/fake/qwen.gguf" } });
    expect(loadLocalRuntimeConfig(join(tmpDir, LOCAL_FILENAME))).toBeNull();
  });

  it("port вне диапазона (0) не проходит схему", () => {
    writeCfgFile(tmpDir, { exe: "C:/fake/llama-server.exe", model: { ref: "llama/qwen25-coder-14b", path: "C:/fake/qwen.gguf" }, port: 0 });
    expect(loadLocalRuntimeConfig(join(tmpDir, LOCAL_FILENAME))).toBeNull();
  });

  it("отсутствующий model не проходит схему", () => {
    writeCfgFile(tmpDir, { exe: "C:/fake/llama-server.exe" });
    expect(loadLocalRuntimeConfig(join(tmpDir, LOCAL_FILENAME))).toBeNull();
  });
});

describe("createLocalRuntimeSupervisor (P4)", () => {
  it("свободный GPU: спавнит один раз с полными аргументами и возвращает ref после readiness up", async () => {
    const f = makeDeps({ healthQueue: ["down", "up"] });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const c = { ...cfg(), extraArgs: ["--jinja"] };
    const r = await sup.acquire(c);
    expect(r).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(f.counters.spawnCalls).toBe(1);
    expect(f.lastArgs()).toEqual(["-m", "C:/fake/qwen.gguf", "--host", "127.0.0.1", "--port", "8080", "--jinja"]);
    expect(f.lastArgs()[0]).toBe("-m");
    expect(f.lastArgs()[1]).toBe(c.model.path);
    expect(f.lastArgs()).toContain("--host");
    expect(f.lastArgs()).toContain("127.0.0.1");
    expect(f.lastArgs()).toContain("--port");
    expect(f.lastArgs()).toContain("8080");
  });

  it("занятый GPU: отказ admission до spawn и до health", async () => {
    const f = makeDeps({ sampleState: { gpuUtilPct: 95, freeVramMiB: 20_000 } });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
    expect(f.counters.spawnCalls).toBe(0);
    expect(f.counters.healthCalls).toBe(0);
  });

  it("UNKNOWN-замер GPU: отказ без единого spawn", async () => {
    const f = makeDeps({ sampleState: { gpuUtilPct: null, freeVramMiB: 20_000 } });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r.ok).toBe(false);
    expect(f.counters.spawnCalls).toBe(0);
  });

  it("процесс уже жив (health up): ok без spawn", async () => {
    const f = makeDeps({ healthQueue: ["up"] });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(f.counters.spawnCalls).toBe(0);
  });

  it("таймаут readiness: убивает своего ребёнка и возвращает отказ", async () => {
    const f = makeDeps({ defaultHealth: "down" });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
    expect(f.counters.spawnCalls).toBe(1);
    expect(f.counters.killCalls).toBe(1);
  });

  it("параллельные acquire спавнят ровно один процесс и оба возвращают ok", async () => {
    const f = makeDeps({ healthQueue: ["down", "up", "up"] });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const [r1, r2] = await Promise.all([sup.acquire(cfg()), sup.acquire(cfg())]);
    expect(r1).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(r2).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(f.counters.spawnCalls).toBe(1);
  });

  it("release убивает своего ребёнка ровно один раз; без acquire это no-op", async () => {
    const f = makeDeps({ healthQueue: ["down", "up"] });
    const sup = createLocalRuntimeSupervisor(f.deps);
    await sup.acquire(cfg());
    await sup.release();
    expect(f.counters.killCalls).toBe(1);
    await sup.release();
    expect(f.counters.killCalls).toBe(1);

    const f2 = makeDeps();
    const sup2 = createLocalRuntimeSupervisor(f2.deps);
    await sup2.release();
    expect(f2.counters.killCalls).toBe(0);
  });
});
