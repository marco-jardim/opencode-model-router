import { describe, expect, it } from "vitest";
import { createLocalRuntimeSupervisor, type GpuSample, type LocalRuntimeConfig, type LocalRuntimeDeps } from "../../src/router/local-runtime";

// ---------------------------------------------------------------------------
// Orphan guard: a supervisor never spawns a second llama-server while its own
// previous child may still be alive. The live child must be killed BEFORE the
// second spawn happens — otherwise the orphaned process keeps the GPU (VRAM)
// hostage and `release` can no longer reach it, breaking the rendering-priority
// contract. Pure in-memory fakes; the fake spawn records how many kills had
// already happened at the moment of each spawn.
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

describe("local runtime orphan guard", () => {
  it("a second acquire kills the previous own child BEFORE spawning again", async () => {
    let spawnCalls = 0;
    let killCalls = 0;
    /** killCalls snapshot taken at the moment of each spawn. */
    const killCallsAtSpawn: number[] = [];
    const queue = ["down", "up", "down", "up", "up"] as Array<"up" | "down">;
    const deps: LocalRuntimeDeps = {
      spawn: (_exe: string, _args: string[]) => {
        spawnCalls += 1;
        killCallsAtSpawn.push(killCalls);
        return { pid: 4200 + spawnCalls, kill: async () => { killCalls += 1; } };
      },
      health: async () => queue.shift() ?? "up",
      sample: async (): Promise<GpuSample> => ({ gpuUtilPct: 20, freeVramMiB: 20_000 }),
      now: () => 0,
      sleep: async () => {},
    };
    const supervisor = createLocalRuntimeSupervisor(deps);

    // acquire #1: down → spawn C1 (nothing to kill yet) → ready.
    const first = await supervisor.acquire(cfg());
    expect(first).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });

    // acquire #2 (the endpoint flapped "down"): C1 may still be alive, so the
    // kill of C1 must already have happened by the time spawn #2 runs.
    const second = await supervisor.acquire(cfg());
    expect(second).toEqual({ ok: true, ref: "llama/qwen25-coder-14b" });

    expect(spawnCalls).toBe(2);
    expect(killCallsAtSpawn).toEqual([0, 1]);
    expect(killCalls).toBeGreaterThanOrEqual(1);
  });
});
