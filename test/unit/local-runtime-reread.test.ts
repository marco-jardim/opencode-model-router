import { describe, expect, it } from "vitest";
import { createLocalRuntimeSupervisor, type GpuSample, type LocalRuntimeConfig } from "../../src/router/local-runtime";

// ---------------------------------------------------------------------------
// Causal RED on the PRE-SPAWN admission re-read (P5 slice A), unit level.
//
// The GPU is sampled TWICE per acquire that is about to spawn: a fast first
// sample before the health probe, and a second sample immediately before
// deps.spawn. Between the two, the GPU may have been taken over by rendering,
// so a deny on the second (fresher) measurement must abort WITHOUT a spawn.
// An acquire that never intends to spawn (already-"up" endpoint, first-sample
// deny) takes exactly one sample.
//
// Pure in-memory fakes: no timers, no network, no fs.
// ---------------------------------------------------------------------------

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
  sampleQueue?: GpuSample[];
}

/** In-memory fakes: sampleQueue is shifted per call; an empty queue repeats the last sample. */
function makeDeps(opts: DepsOpts = {}) {
  const counters = { sampleCalls: 0, spawnCalls: 0, killCalls: 0, healthCalls: 0 };
  const healthQ = [...(opts.healthQueue ?? [])];
  const sampleQ = [...(opts.sampleQueue ?? [])];
  let lastSample: GpuSample = { gpuUtilPct: 20, freeVramMiB: 20_000 };
  let nowValue = 0;
  return {
    counters,
    deps: {
      spawn: (exe: string, args: string[]) => {
        void exe;
        void args;
        counters.spawnCalls += 1;
        return { pid: 4242, kill: async (): Promise<void> => { counters.killCalls += 1; } };
      },
      health: async (host: string, port: number): Promise<"up" | "down"> => {
        void host;
        void port;
        counters.healthCalls += 1;
        return healthQ.length > 0 ? (healthQ.shift() ?? opts.defaultHealth ?? "down") : (opts.defaultHealth ?? "down");
      },
      sample: async (): Promise<GpuSample> => {
        counters.sampleCalls += 1;
        lastSample = sampleQ.shift() ?? lastSample;
        return lastSample;
      },
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

describe("pre-spawn admission re-read (P5)", () => {
  it("happy-путь: два замера GPU (до health и перед spawn), один spawn, ok", async () => {
    const f = makeDeps({
      sampleQueue: [
        { gpuUtilPct: 20, freeVramMiB: 20_000 },
        { gpuUtilPct: 20, freeVramMiB: 20_000 },
      ],
      healthQueue: ["down", "up"],
    });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(f.counters.sampleCalls).toBe(2);
    expect(f.counters.spawnCalls).toBe(1);
  });

  it("гонка: второй замер видит занятый GPU — отказ без spawn после одной health-пробы", async () => {
    const f = makeDeps({
      sampleQueue: [
        { gpuUtilPct: 20, freeVramMiB: 20_000 },
        { gpuUtilPct: 95, freeVramMiB: 20_000 },
      ],
      healthQueue: ["down"],
    });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).not.toBe("");
    expect(f.counters.spawnCalls).toBe(0);
    expect(f.counters.healthCalls).toBe(1);
  });

  it("второй замер UNKNOWN — отказ без spawn", async () => {
    const f = makeDeps({
      sampleQueue: [
        { gpuUtilPct: 20, freeVramMiB: 20_000 },
        { gpuUtilPct: null, freeVramMiB: 20_000 },
      ],
      healthQueue: ["down"],
    });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r.ok).toBe(false);
    expect(f.counters.spawnCalls).toBe(0);
  });

  it("процесс уже жив: один замер, второго нет, spawn нет", async () => {
    const f = makeDeps({ healthQueue: ["up"] });
    const sup = createLocalRuntimeSupervisor(f.deps);
    const r = await sup.acquire(cfg());
    expect(r).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });
    expect(f.counters.sampleCalls).toBe(1);
    expect(f.counters.spawnCalls).toBe(0);
  });
});
