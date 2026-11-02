// ---------------------------------------------------------------------------
// Local llama-server runtime (P4 local contour): the validated config file,
// the GPU admission gate, and the acquire/release supervisor.
//
// Pure seams: everything time-, process- or network-shaped is injected
// (LocalRuntimeDeps); the module itself touches the filesystem only in
// loadLocalRuntimeConfig and never starts timers or sockets. A measurement
// that is UNKNOWN is a DENY, never a success; a live foreign process on the
// port is used as-is and never spawned over or killed.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./config";

/** The validated local-runtime config (defaults already applied). */
export interface LocalRuntimeConfig {
  readonly exe: string;
  readonly model: { readonly ref: string; readonly path: string };
  readonly host: string;
  readonly port: number;
  readonly readinessTimeoutMs: number;
  readonly admission: { readonly maxGpuUtilPct: number; readonly minFreeVramMiB: number };
  readonly extraArgs: readonly string[];
}

/** One GPU measurement; null fields are UNKNOWN and always deny admission. */
export type GpuSample = { gpuUtilPct: number | null; freeVramMiB: number | null };

const REF_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const LOCAL_CONFIG_FILENAME = "opencode-model-router.local.json";

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const isPositiveNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Load and schema-validate the local-runtime config. Form only: file
 * EXISTENCE (exe path, model weights) is deliberately not checked here.
 * Missing file, broken JSON or an invalid schema yield null — never a throw,
 * and never a default that masks a broken value.
 */
export function loadLocalRuntimeConfig(path?: string): LocalRuntimeConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path ?? join(dirname(statePath()), LOCAL_CONFIG_FILENAME), "utf-8"));
  } catch {
    return null;
  }
  if (!isPlain(raw)) return null;
  if (!isNonEmptyString(raw.exe)) return null;
  const model = raw.model;
  if (!isPlain(model) || !isNonEmptyString(model.ref) || !REF_PATTERN.test(model.ref) || !isNonEmptyString(model.path)) {
    return null;
  }
  if (raw.host !== undefined && !isNonEmptyString(raw.host)) return null;
  const host = raw.host ?? "127.0.0.1";
  if (raw.port !== undefined) {
    if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65_535) return null;
  }
  const port = raw.port ?? 8_080;
  if (raw.readinessTimeoutMs !== undefined && !isPositiveNumber(raw.readinessTimeoutMs)) return null;
  const readinessTimeoutMs = raw.readinessTimeoutMs ?? 120_000;
  let admission: LocalRuntimeConfig["admission"];
  if (raw.admission === undefined) {
    admission = { maxGpuUtilPct: 70, minFreeVramMiB: 10_240 };
  } else {
    if (!isPlain(raw.admission)) return null;
    const { maxGpuUtilPct, minFreeVramMiB } = raw.admission;
    if (
      maxGpuUtilPct !== undefined &&
      (typeof maxGpuUtilPct !== "number" || !Number.isFinite(maxGpuUtilPct) || maxGpuUtilPct < 0 || maxGpuUtilPct > 100)
    ) {
      return null;
    }
    if (minFreeVramMiB !== undefined && !isPositiveNumber(minFreeVramMiB)) return null;
    admission = {
      maxGpuUtilPct: maxGpuUtilPct ?? 70,
      minFreeVramMiB: minFreeVramMiB ?? 10_240,
    };
  }
  if (raw.extraArgs !== undefined) {
    if (!Array.isArray(raw.extraArgs) || !raw.extraArgs.every((arg) => typeof arg === "string")) return null;
  }
  const extraArgs: readonly string[] = raw.extraArgs ?? [];
  return {
    exe: raw.exe,
    model: { ref: model.ref, path: model.path },
    host,
    port,
    readinessTimeoutMs,
    admission,
    extraArgs,
  };
}

/**
 * The GPU admission gate. Boundaries are INCLUSIVE (exactly maxGpuUtilPct and
 * exactly minFreeVramMiB are admitted); any UNKNOWN measurement denies with a
 * non-empty reason. The ok branch is exactly `{ ok: true }`.
 */
export function admitLocalRuntime(sample: GpuSample, cfg: LocalRuntimeConfig): { ok: true } | { ok: false; reason: string } {
  if (sample.gpuUtilPct === null) {
    return { ok: false, reason: "GPU utilization is UNKNOWN — a local start never runs on an unknown measurement" };
  }
  if (sample.freeVramMiB === null) {
    return { ok: false, reason: "free VRAM is UNKNOWN — a local start never runs on an unknown measurement" };
  }
  if (sample.gpuUtilPct > cfg.admission.maxGpuUtilPct) {
    return { ok: false, reason: `GPU utilization ${sample.gpuUtilPct}% is above the admission ceiling ${cfg.admission.maxGpuUtilPct}%` };
  }
  if (sample.freeVramMiB < cfg.admission.minFreeVramMiB) {
    return { ok: false, reason: `free VRAM ${sample.freeVramMiB} MiB is below the admission floor ${cfg.admission.minFreeVramMiB} MiB` };
  }
  return { ok: true };
}

/** The injected seams: process, health probe, GPU sampler, clock and sleep. */
export interface LocalRuntimeDeps {
  spawn(exe: string, args: string[]): { pid: number; kill(): Promise<void> };
  health(host: string, port: number): Promise<"up" | "down">;
  sample(): Promise<GpuSample>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type LocalRuntimeSupervisor = {
  acquire(cfg: LocalRuntimeConfig): Promise<{ ok: true; ref: string } | { ok: false; reason: string }>;
  release(): Promise<void>;
};

/** How often readiness is polled while a spawned runtime warms up (through deps.sleep). */
const READINESS_POLL_MS = 500;

/**
 * One supervisor per plugin instance. `acquire`:
 *   (a) samples the GPU and admits it — a deny touches neither health nor spawn;
 *   (b) an already-"up" endpoint returns the model ref WITHOUT spawning (a
 *       live foreign process is never spawned over and never killed);
 *   (c) otherwise exactly ONE spawn happens, shared by concurrent acquires
 *       (the whole acquire is single-flight);
 *   (d) readiness is polled through deps.now/deps.sleep until the endpoint is
 *       up or cfg.readinessTimeoutMs elapses — on timeout the OWN child is
 *       killed and the acquire fails with a reason;
 *   (e) a throwing spawn is caught and returned as a failure, never rethrown.
 * `release` kills only the supervisor's own live child, idempotently; without
 * a spawn it is a no-op.
 */
export function createLocalRuntimeSupervisor(deps: LocalRuntimeDeps): LocalRuntimeSupervisor {
  let child: { kill(): Promise<void> } | undefined;
  let inFlight: Promise<{ ok: true; ref: string } | { ok: false; reason: string }> | undefined;

  const acquireOnce = async (
    cfg: LocalRuntimeConfig,
  ): Promise<{ ok: true; ref: string } | { ok: false; reason: string }> => {
    const admitted = admitLocalRuntime(await deps.sample(), cfg);
    if (!admitted.ok) return { ok: false, reason: admitted.reason };
    const startedAt = deps.now();
    if ((await deps.health(cfg.host, cfg.port)) === "up") {
      return { ok: true, ref: cfg.model.ref };
    }
    // Orphan guard: never overwrite the child slot while our own previous
    // child may still be alive — kill it FIRST (a leaked llama-server would
    // hold VRAM that rendering has priority over, and release() could no
    // longer reach it).
    if (child !== undefined) {
      const previous = child;
      child = undefined;
      await previous.kill();
    }
    // Pre-spawn admission re-read: between the first sample and this point the
    // GPU may have been taken over (rendering has priority); a deny on the
    // fresher measurement aborts WITHOUT a spawn. An acquire that never
    // spawns (already-"up" endpoint, first-sample deny) takes one sample.
    const reread = admitLocalRuntime(await deps.sample(), cfg);
    if (!reread.ok) return { ok: false, reason: reread.reason };
    try {
      child = deps.spawn(cfg.exe, [
        "-m",
        cfg.model.path,
        "--host",
        cfg.host,
        "--port",
        String(cfg.port),
        ...(cfg.extraArgs ?? []),
      ]);
    } catch (error) {
      return { ok: false, reason: `failed to start ${cfg.exe}: ${(error as Error).message}` };
    }
    for (;;) {
      if ((await deps.health(cfg.host, cfg.port)) === "up") {
        return { ok: true, ref: cfg.model.ref };
      }
      if (deps.now() - startedAt >= cfg.readinessTimeoutMs) {
        const own = child;
        child = undefined;
        await own?.kill();
        return { ok: false, reason: `local runtime was not ready within ${cfg.readinessTimeoutMs}ms` };
      }
      await deps.sleep(READINESS_POLL_MS);
    }
  };

  return {
    acquire(cfg) {
      const pending = inFlight ?? acquireOnce(cfg).finally(() => {
        inFlight = undefined;
      });
      inFlight = pending;
      return pending;
    },
    async release() {
      const own = child;
      child = undefined;
      await own?.kill();
    },
  };
}
