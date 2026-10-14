import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createV2Observations, type ServiceIdentity, type V2Observations } from "../../src/compat/v2-observations";
import { BackgroundRuns, createIntegrationChecks } from "../../src/executor/integrate/checks";
import { serviceObservation } from "../../src/executor/observations";
import { applySlotEnv, slotEnvFor } from "../../src/executor/slots/env";
import { resolveVerifyBudget } from "../../src/router/config";
import { createDeadline, createDirectTestsPassHook, createScopeOpener, runDeterministic } from "../../src/verify/deterministic";
import { runArgv, runShell } from "../../src/verify/exec";
import type { RunnerFs, ScopedSpec } from "../../src/verify/runner";
import type { ExecSeam } from "../../src/verify/types";
import { completedServiceProcess, servicePairs } from "../helpers/service-observations";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));

const identity: ServiceIdentity = { planId: "p1", taskId: "T1", attempt: 2, phaseId: "p1", entryId: null,
  taskIds: ["T1"], component: "verify", candidate: "b".repeat(40) };
const cwd = resolve("service-test-no-io");
const spec: ScopedSpec = { runner: "vitest", mode: "related", file: "node", args: ["vitest", "related", "src/a.ts"],
  cwd, env: {}, reportPath: resolve(cwd, "report.json"), gitRoot: cwd, entry: "vitest", inputs: ["src/a.ts"],
  inputsAreTests: false, workers: 2, notes: [] };

describe("intrinsic verification service observations", () => {
  async function run(mode: "off" | "on" | "throw", prepMs = 200, waitMs = 700, failure = false) {
    const lines: string[] = [], calls: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    if (mode === "throw") sink.record = () => { throw new Error("observer failed"); };
    let now = 0;
    const service = serviceObservation(mode === "off" ? undefined : sink, () => identity, () => now);
    const budget = { ...resolveVerifyBudget({ activePreset: "a", presets: { a: {} }, defaultTier: "medium", rules: [] }), failureRecheck: false };
    const deadline = createDeadline(30_000);
    const fs: RunnerFs = {
      fileExists: async () => false,
      readFile: async () => { throw new Error("no report"); },
      unlink: async () => { calls.push("report-cleanup"); now += 40; },
    };
    const execute: ExecSeam = async () => {
      calls.push("execute"); now += 11;
      if (failure) throw new Error("command failed to start");
      return { code: 0, stdout: " Test Files  1 passed (1)\n Tests  3 passed (3)\n", stderr: "" };
    };
    const openScope = createScopeOpener({ service, budget, checkTimeoutMs: 5_000, fs,
      exec: execute, argv: async () => execute("test"),
      acquire: async () => {
        calls.push("acquire"); now += waitMs;
        return { lost: false, release: async () => { calls.push("release"); now += 90; } };
      },
    });
    const testsPass = createDirectTestsPassHook({ service, openScope, plannerFs: fs,
      search: { findByName: async () => [], findByContent: async () => [] }, budget,
      plan: async () => { calls.push("prepare"); now += prepMs; return spec; },
    });
    try {
      const verdict = await runDeterministic({ kind: "deterministic", source: "explicit", checks: [{ kind: "testsPass" }], criteria: [], deliverable: null }, {
        service, testsPass, openScope, deadline, exec: execute, fs, cwd, budget, changedFiles: [{ path: "src/a.ts", status: "M" }],
      });
      sink.close();
      return { verdict, calls, elapsed: now, lines, rows: mode === "on" ? servicePairs(lines) : [] };
    } finally { deadline.dispose(); sink.close(); }
  }

  it.each([false, true])("preserves verdict, execution and cleanup off/on/throwing (spawn failure=%s)", async failure => {
    const off = await run("off", 200, 700, failure);
    for (const mode of ["on", "throw"] as const) {
      const observed = await run(mode, 200, 700, failure);
      expect(observed.verdict).toEqual(off.verdict);
      expect(observed.calls).toEqual(off.calls);
      expect(observed.elapsed).toBe(off.elapsed);
      if (mode === "on") {
        const service = observed.rows.filter(r => r.spanKind === "service" && r.action === "end");
        expect(service).toMatchObject([{ ...identity, durationMs: 11, result: failure ? "error" : "pass" }]);
      }
    }
    expect(off.lines).toHaveLength(1); // only the explicitly closed test sink's seal; no observations off
  });

  it("excludes independently delayed preparation and slot acquisition (rejects the naive envelope)", async () => {
    const baseline = await run("on", 0, 0);
    const prep = await run("on", 2_000, 0);
    const wait = await run("on", 0, 7_000);
    const intrinsic = (duration: number) => expect(duration).toBe(11);
    for (const r of [baseline, prep, wait]) {
      const end = r.rows.find(row => row.spanKind === "service" && row.action === "end")!;
      intrinsic(end.durationMs);
      // Mutation control: an acquire+execution envelope must fail the SAME intrinsic-time assertion.
      if (r === wait) {
        const acquisition = r.rows.find(row => row.stage === "verification-slot" && row.action === "start")!;
        expect(() => intrinsic(end.clockMs - acquisition.clockMs)).toThrow();
        expect(end.clockMs - acquisition.clockMs).toBe(7_011);
      }
    }
    expect(prep.rows).toContainEqual(expect.objectContaining({ spanKind: "service-prep", stage: "test-planning", action: "end", durationMs: 2_000 }));
    expect(wait.rows).toContainEqual(expect.objectContaining({ spanKind: "service-wait", stage: "verification-slot", action: "end", durationMs: 7_000 }));
    expect(wait.elapsed - baseline.elapsed).toBe(7_000);
    expect(prep.elapsed - baseline.elapsed).toBe(2_000);
  });

  it.each(["shell", "argv", "integration"] as const)("excludes the real %s runner's pre-spawn slot-env lookup from service", async runner => {
    const executionIdentity: ServiceIdentity = runner === "integration"
      ? { ...identity, component: "checks", taskId: null, attempt: null, entryId: "i-1" } : identity;
    const run = async (envDelayMs: number) => {
      let now = 0;
      const lines: string[] = [];
      const sink = createV2Observations({ write: line => { lines.push(line); } });
      const service = serviceObservation(sink, () => executionIdentity, () => now);
      const hookKey = Symbol.for("omr.executor.slotEnvHook");
      const previous: unknown = Reflect.get(globalThis, hookKey);
      const lookup = vi.fn((at: string, platform: NodeJS.Platform) => {
        now += envDelayMs;
        return slotEnvFor(at, platform);
      });
      Reflect.set(globalThis, hookKey, { slotEnvFor: lookup, applySlotEnv });
      vi.mocked(spawn).mockImplementation(() => completedServiceProcess(() => { now += 11; }));
      const budget = resolveVerifyBudget({ activePreset: "a", presets: { a: {} }, defaultTier: "medium", rules: [] });
      const deadline = createDeadline(30_000);
      const scope = createScopeOpener({
        service, budget, checkTimeoutMs: 5_000, exec: runShell, argv: runArgv,
        fs: { fileExists: async () => false, readFile: async () => "", unlink: async () => undefined },
        acquire: async () => ({ lost: false, release: async () => undefined }),
      })({ cwd, command: "node --version" });
      try {
        if (runner === "integration") {
          const unexpected = (): never => { throw new Error("unexpected integration preparation I/O"); };
          const checks = createIntegrationChecks({
            ledger: unexpected, get pool() { return unexpected(); }, get git() { return unexpected(); }, get igit() { return unexpected(); },
            resolver: { resolve: unexpected }, guard: { assertWriteCwd: unexpected }, background: new BackgroundRuns(),
            clock: { now: () => now, iso: unexpected, setTimer: unexpected, clearTimer: unexpected, randomHex: unexpected },
            logger: { warn: unexpected }, preemptForeground: async () => undefined,
            acquire: async () => ({ lost: false, release: async () => undefined }),
            spawn: async (command, opts) => {
              const result = await runArgv(command.file, command.args, { ...opts, env: { ...command.env }, timeoutMs: 5_000 });
              return { exitCode: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, durationMs: 11 };
            },
          });
          expect(await checks.runCommands({
            observation: service,
            slot: { slot: "integration", path: cwd, planId: "p1", owner: "integration", commit: "b".repeat(40) },
            commit: "b".repeat(40), commands: [{ label: "probe", file: "node", args: ["--version"], source: "run-command", ref: null }],
            mode: "full", priority: "foreground", signal: deadline.signal, prepare: false,
          })).toMatchObject({ verdict: "pass" });
        } else {
          const result = runner === "shell" ? await scope.runShell("node --version", cwd, deadline)
            : await scope.runLint({ ...spec, runner: "eslint", args: ["--version"] }, deadline);
          expect(result).toMatchObject({ kind: "ran", exec: { code: 0 } });
        }
        expect(lookup).toHaveBeenCalledExactlyOnceWith(cwd, process.platform);
        expect(spawn).toHaveBeenCalledOnce();
        sink.close();
        return { elapsed: now, rows: servicePairs(lines) };
      } finally {
        await scope.close();
        deadline.dispose();
        sink.close();
        Reflect.set(globalThis, hookKey, previous);
        vi.mocked(spawn).mockReset();
      }
    };
    const baseline = await run(0);
    const delayed = await run(2_000);
    expect(delayed.elapsed - baseline.elapsed).toBe(2_000);
    for (const result of [baseline, delayed]) {
      expect(result.rows.filter(r => r.spanKind === "service" && r.action === "end")).toMatchObject([
        { ...executionIdentity, stage: "command", durationMs: 11, result: "pass" },
      ]);
    }
    expect(delayed.rows).toContainEqual(expect.objectContaining({ spanKind: "service-prep", action: "end", durationMs: 2_000 }));
  });

  it("does not evaluate identities or clocks off, contains projection faults, and freezes pair identity", () => {
    const make = vi.fn(() => { throw new Error("projection"); });
    const now = vi.fn(() => { throw new Error("clock"); });
    expect(serviceObservation(undefined, make, now)).toBeUndefined();
    expect(make).not.toHaveBeenCalled(); expect(now).not.toHaveBeenCalled();
    const lines: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    expect(() => serviceObservation(sink, make)?.start("service", "command")).not.toThrow();
    expect(sink.counts().failed).toBe(1);
    const throwing: V2Observations = { ...sink, record() { throw new Error("observer"); } };
    expect(() => serviceObservation(throwing, () => identity)?.start("service", "command")).not.toThrow();
    sink.close();

    const paired: string[] = [];
    const good = createV2Observations({ write: line => { paired.push(line); } });
    const ids = ["T1", "T2"];
    const port = serviceObservation(good, () => ({ ...identity, taskIds: ids }), () => 5);
    const first = port?.start("service", "command");
    ids.push("T3");
    first?.end("pass"); first?.end("error");
    port?.start("service", "command")?.end("error");
    good.close();
    const rows = servicePairs(paired);
    expect(rows[0]?.taskIds).toEqual(["T1", "T2"]);
    expect(rows[1]?.taskIds).toEqual(["T1", "T2"]);
    expect(rows).toHaveLength(4);
  });
});
