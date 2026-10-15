import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildSessionRunner } from "../../src/compat/child-session";
import { createV2Observations, type ObservationRecord, type V2Observations } from "../../src/compat/v2-observations";
import { leaseHolderID, type Attempt, type SlotLease, type TaskNode } from "../../src/executor/types";
import { scrubText } from "../../src/guard/scrub";
import type { RouterConfig } from "../../src/router/config";
import { createChangedFileStore } from "../../src/verify/dispatch";
import { runShell } from "../../src/verify/exec";
import { accept, gateResult } from "../../src/verify/gate";
import { readHead, readHeadState } from "../../src/verify/head";
import { createLeaseSelfExemptions, createPlanTaskVerifier, planTaskVerificationID, planTreeKey, slotVerdictOf, type PlanTaskGit } from "../../src/verify/plan-task";
import { snapshotTree } from "../../src/verify/tree";
import { createVerificationWiring } from "../../src/verify/wiring";
import { completedServiceProcess, servicePairs } from "../helpers/service-observations";

// Capture tests double the final gate; the candidate regression restores real accept and
// runShell, doubling only I/O below the real plan-task -> wiring -> deterministic boundary.
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
vi.mock("../../src/verify/tree", async (original) => ({ ...await original<typeof import("../../src/verify/tree")>(), snapshotTree: vi.fn() }));
vi.mock("../../src/verify/head", async (original) => ({ ...await original<typeof import("../../src/verify/head")>(), readHead: vi.fn(), readHeadState: vi.fn() }));
vi.mock("../../src/verify/perimeter", async (original) => ({ ...await original<typeof import("../../src/verify/perimeter")>(), planPerimeter: () => undefined }));
vi.mock("../../src/verify/gate", async (original) => ({ ...await original<typeof import("../../src/verify/gate")>(), accept: vi.fn() }));
vi.mock("../../src/verify/slot", async original => ({
  ...await original<typeof import("../../src/verify/slot")>(),
  acquireSlot: vi.fn(async () => ({ lost: false, release: async () => undefined })),
}));
vi.mock("../../src/verify/exec", () => ({
  runArgv: vi.fn(async () => { throw new Error("unexpected verification process"); }),
  runShell: vi.fn(async () => { throw new Error("unexpected verification shell"); }),
}));

const root = resolve("plan-task-observations");
const BASE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const parent = "plan-parent";
const branch = "omr/p1/t/t1";
const cfg: RouterConfig = {
  activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [],
  routing: { delegation: "roles", repoParents: [] },
};
const task: TaskNode = {
  id: "t1", title: "Explain the change", phase: null, kind: "task", subtasks: [],
  text: "Explain the change.\n[acceptance]\ncriteria: the explanation is complete\n[/acceptance]",
  route: { line: "[route class=implement]", role: "implementer", tier: "medium", pin: false },
  verify: "required", acceptance: null,
  footprint: { writes: [], reads: [], confidence: "unknown", sources: [] },
  estimate: { p50: 1, p90: 2, source: "test" }, state: "verifying", attempts: [], slot: "s1", branch, integrated: null,
};
const slot: SlotLease = { slot: "s1", path: root, planId: "p1", owner: leaseHolderID("p1", task.id), commit: BASE };
const context = { orchestratorSessionID: parent };
const attempt = (n: number, identity: boolean): Attempt => ({
  n, nonce: `nonce-${n}`, callID: identity ? `${parent}:call-${n}` : null,
  // Reusing a child must not collapse distinct attempts or replace the retained call id.
  childSessionID: identity ? "shared-child" : null,
  startedAt: "2026-10-13T00:00:00.000Z", endedAt: null, outcome: "succeeded", verdict: null, context: "",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accept).mockResolvedValue(gateResult({ pass: true, outcome: "pass", method: "checker", reasons: ["complete"] }, "explicit"));
});

function harness(observations?: V2Observations, verificationTask = task, diagnostics: {
  childRunner?: ChildSessionRunner;
  warn?: (message: string) => void;
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  const state = { head: BASE, nonce: "" };
  vi.mocked(snapshotTree).mockImplementation(async () => ({
    cwd: root, root, head: state.head, branch, fingerprint: state.head, dirty: false, files: [], digests: new Map(),
  }));
  vi.mocked(readHead).mockImplementation(async () => ({ root, head: state.head, branch }));
  vi.mocked(readHeadState).mockImplementation(async () => ({ root, head: state.head, branch }));
  const store = createChangedFileStore();
  // delta runs once inside each actual observeChange invocation, not for cached observe calls or gate re-runs.
  const captures = vi.spyOn(store, "delta");
  const warnings: string[] = [], logs: string[] = [], sleeps: number[] = [];
  const onVerdict = vi.fn();
  const wiring = createVerificationWiring({ client: {}, directory: root, getConfig: () => cfg, observations,
    childRunner: diagnostics.childRunner, logger: { warn: diagnostics.warn ?? (message => { warnings.push(message); }) } });
  const git: PlanTaskGit = async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --verify --quiet HEAD^{commit}") return { code: 0, stdout: state.head, stderr: "" };
    if (command === `rev-parse --verify --quiet ${CANDIDATE}^1^{commit}`) return { code: 0, stdout: BASE, stderr: "" };
    if (command === "symbolic-ref --quiet HEAD") return { code: 0, stdout: `refs/heads/${branch}`, stderr: "" };
    if (command === "rev-parse --show-toplevel") return { code: 0, stdout: root, stderr: "" };
    if (command.startsWith("log -1 --format=%B")) return { code: 0, stdout: `Omr-Attempt: ${state.nonce}`, stderr: "" };
    if (command.startsWith("merge-base --is-ancestor") || command.startsWith("diff --name-status -z -M")) return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected plan-task git: ${command}`);
  };
  const verifier = createPlanTaskVerifier({
    changedFileStore: store,
    beginVerificationBounded: wiring.beginVerificationBounded,
    prepareVerification: wiring.prepareVerification,
    buildGateDeps: wiring.buildGateDeps,
    captureBudget: () => undefined, readCapReached: () => undefined,
    abortSession: async () => undefined, getConfig: () => cfg, git,
    exemptions: createLeaseSelfExemptions(planTreeKey),
    onVerdict,
    log: diagnostics.log ?? (message => { logs.push(message); }),
    sleep: async ms => { sleeps.push(ms); await diagnostics.sleep?.(ms); },
  });
  return {
    captures, warnings, logs, sleeps, onVerdict,
    async run(a: Attempt, restart: boolean) {
      state.head = BASE;
      state.nonce = a.nonce;
      if (!restart) {
        // The child is not known at begin; diagnostics must use the attempt at capture time.
        await verifier.begin?.(verificationTask, slot, { ...a, childSessionID: null }, context);
      }
      await verifier.observe?.(verificationTask, slot, a, undefined, context);
      await verifier.observe?.(verificationTask, slot, a, undefined, context);
      state.head = CANDIDATE;
      return verifier.verify(verificationTask, slot, a, context);
    },
    async dispose() {
      await verifier.dispose?.();
      await wiring.disposeVerification();
    },
  };
}

describe("plan-task capture observations through the real verification wiring", () => {
  it.each([
    "[model-router] v2 child dispatch requires an active tool context or a retained context matching its parent",
    "[model-router] OpenCode v2's native subagent tool is unavailable",
    `startup refused\ntoken=secret-123456 ghp_${"s".repeat(30)} ${"x".repeat(300)}`,
  ])("logs a thrown grader startup reason through real wiring/checker after restart: %s", async message => {
    const realGate = await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
    vi.mocked(accept).mockImplementation(realGate.accept);
    const error = new Error(message);
    const reason = scrubText(message).replace(/\s+/g, " ").trim().slice(0, 200);
    const retryReason = scrubText(`grader dispatch failed: ${String(error)}`).replace(/\s+/g, " ").trim().slice(0, 200);
    const expected = gateResult({ pass: false, outcome: "unverifiable", method: "checker",
      reasons: [scrubText(`grader dispatch failed: ${String(error)}`)] }, "explicit");
    // Diagnostics work with observations off, on, or a failed logger; no dispatch error is replaced.
    for (const mode of ["off", "on", "throw"] as const) {
      const lines: string[] = [];
      const sink = createV2Observations({ write: line => { lines.push(line); } });
      const childRunner: ChildSessionRunner = {
        run: vi.fn(async () => { throw error; }), dispose: vi.fn(async () => undefined),
      };
      const throwingLog = () => { throw new Error("logger failed"); };
      const h = harness(mode === "off" ? undefined : sink, task, {
        childRunner, ...(mode === "throw" ? { warn: throwingLog, log: throwingLog } : {}),
      });
      vi.mocked(accept).mockClear();
      try {
        expect(await h.run(attempt(2, true), true)).toEqual(slotVerdictOf(expected));
        expect(childRunner.run).toHaveBeenCalledTimes(3);
        expect(childRunner.dispose).not.toHaveBeenCalled();
        expect(accept).toHaveBeenCalledTimes(3);
        expect(h.sleeps).toEqual([30_000, 60_000]);
        expect(h.onVerdict).toHaveBeenCalledExactlyOnceWith("shared-child", expected.verdict);
        if (mode !== "throw") {
          expect(h.warnings).toEqual(Array(3).fill(`[verify] grader dispatch failed for t1#2: ${reason}`));
          expect(h.logs).toEqual([1, 2].map(n => `plan-task verification retry ${n} for t1#2: ${retryReason}`));
          expect([...h.warnings, ...h.logs].join(" ")).not.toMatch(/[\r\n]|secret-123456|ghp_/);
        }
        expect(reason.length).toBeLessThanOrEqual(200);
        expect(retryReason.length).toBeLessThanOrEqual(200);
        sink.close();
        const rows = servicePairs(lines);
        expect(rows.filter(r => r.stage === "grader-startup" && r.action === "end")).toMatchObject(
          mode === "off" ? [] : Array.from({ length: 3 }, () => ({ spanKind: "service-prep", result: "error", taskId: "t1", attempt: 2 })),
        );
        expect(rows.filter(r => r.stage === "retry-backoff" && r.action === "end")).toHaveLength(mode === "off" ? 0 : 2);
        expect(rows.filter(r => r.spanKind === "service")).toEqual([]);
      } finally { await h.dispose(); sink.close(); }
    }
  });

  it("exposes the startup and transient reasons before any verdict is published", async () => {
    const realGate = await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
    vi.mocked(accept).mockImplementation(realGate.accept);
    const lines: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    let sleeping!: () => void;
    const backoffStarted = new Promise<void>(resolve => { sleeping = resolve; });
    const childRunner: ChildSessionRunner = {
      run: vi.fn(async () => { throw new Error("startup token=secret-123456"); }), dispose: async () => undefined,
    };
    const h = harness(sink, task, { childRunner, sleep: async () => { sleeping(); await new Promise<void>(() => {}); } });
    const pending = h.run(attempt(2, true), true);
    try {
      await backoffStarted;
      expect(h.onVerdict).not.toHaveBeenCalled();
      expect(h.warnings).toEqual(["[verify] grader dispatch failed for t1#2: startup token=[REDACTED]"]);
      expect(h.logs).toEqual(["plan-task verification retry 1 for t1#2: grader dispatch failed: Error: startup token=[REDACTED]"]);
      sink.flush();
      const rows = lines.map((line): ObservationRecord => JSON.parse(line));
      expect(rows.filter(r => r.family === "service" && r.stage === "grader-startup" && r.action === "end"))
        .toMatchObject([{ result: "error", taskId: "t1", attempt: 2 }]);
      await h.dispose();
      expect(await pending).toMatchObject({ verdict: "unverifiable", cut: true });
      expect(childRunner.run).toHaveBeenCalledTimes(1);
      expect(h.sleeps).toEqual([30_000]);
      expect(h.onVerdict).not.toHaveBeenCalled();
      sink.close();
      expect(servicePairs(lines).filter(r => r.stage === "retry-backoff" && r.action === "end")).toMatchObject([{ result: "interrupted" }]);
    } finally { await h.dispose(); sink.close(); }
  });

  it("binds normal-attempt execution spans from a real deterministic check to the checked candidate", async () => {
    const realGate = await vi.importActual<typeof import("../../src/verify/gate")>("../../src/verify/gate");
    const realExec = await vi.importActual<typeof import("../../src/verify/exec")>("../../src/verify/exec");
    vi.mocked(accept).mockImplementation(realGate.accept);
    vi.mocked(runShell).mockImplementation(realExec.runShell);
    vi.mocked(spawn).mockImplementation(() => completedServiceProcess(() => undefined));
    const lines: string[] = [];
    const sink = createV2Observations({ write: line => { lines.push(line); } });
    const h = harness(sink, { ...task, text: 'Check the build.\n[acceptance]\ncheck: buildPasses command="node --version"\n[/acceptance]' });
    const attempts = [attempt(1, true), attempt(2, true)];
    try {
      for (const a of attempts) expect(await h.run(a, false)).toMatchObject({ verdict: "pass", ref: "deterministic" });
      expect(accept).toHaveBeenCalledTimes(attempts.length);
      expect(runShell).toHaveBeenCalledTimes(attempts.length);
      expect(spawn).toHaveBeenCalledTimes(attempts.length);
      sink.close();
      expect(servicePairs(lines).filter(r => r.spanKind === "service" && r.action === "end")).toMatchObject(attempts.map(a => ({
        planId: "p1", taskId: "t1", attempt: a.n, phaseId: null, entryId: null, taskIds: ["t1"],
        component: "verify", candidate: CANDIDATE, stage: "command", result: "pass",
      })));
    } finally {
      await h.dispose();
      sink.close();
      vi.mocked(accept).mockReset();
      vi.mocked(runShell).mockReset();
      vi.mocked(spawn).mockReset();
    }
  });

  it.each([false, true])("records exactly one correctly identified row per capture (restart=%s)", async (restart) => {
    const lines: string[] = [];
    const sink = createV2Observations({ write: (line) => { lines.push(line); } });
    const h = harness(sink);
    try {
      const attempts = [attempt(1, true), attempt(2, true), attempt(3, false)];
      for (const a of attempts) expect(await h.run(a, restart)).toMatchObject({ verdict: "pass" });
      expect(h.captures).toHaveBeenCalledTimes(attempts.length);
      sink.flush();
      const rows = lines.map((line): ObservationRecord => JSON.parse(line));
      const captures = rows.filter((row) => row.family === "completion-effect" && row.effect === "change-set-capture");
      expect(captures).toHaveLength(h.captures.mock.calls.length);
      expect(captures).toMatchObject(attempts.map((a) => ({
        source: "plan-task-change", parentSessionID: parent,
        callID: a.callID ?? planTaskVerificationID(parent, slot.planId, task.id, a.n), childSessionID: a.childSessionID,
      })));
      sink.close();
      const services = servicePairs(lines);
      expect(services.filter(r => r.action === "end" && r.stage === "change-capture")).toMatchObject(attempts.map(a => ({
        planId: "p1", taskId: "t1", attempt: a.n, taskIds: ["t1"], component: "verify", spanKind: "service-prep",
      })));
      expect(services.filter(r => r.action === "end" && r.stage === "slot-snapshot")).toMatchObject(attempts.map(a => ({
        planId: "p1", taskId: "t1", attempt: a.n, candidate: CANDIDATE, spanKind: "service-prep",
      })));
      expect(sink.counts()).toEqual({ attempted: rows.length, written: rows.length, dropped: 0, failed: 0 });
    } finally {
      await h.dispose();
      sink.close();
    }
  });

  it.each([false, true])("leaves verification unchanged with no sink or a throwing sink (restart=%s)", async (restart) => {
    const sink = createV2Observations({ write: () => undefined });
    const record = vi.spyOn(sink, "record").mockImplementation(() => { throw new Error("observer failed"); });
    try {
      for (const observations of [undefined, sink]) {
        const h = harness(observations);
        try {
          expect(await h.run(attempt(1, true), restart)).toMatchObject({ verdict: "pass" });
          expect(h.captures).toHaveBeenCalledTimes(1);
        } finally { await h.dispose(); }
        // Capture projection plus two attempted prep starts; a throwing observer never starts a pair.
        expect(record).toHaveBeenCalledTimes(observations === undefined ? 0 : 3);
      }
    } finally { sink.close(); }
  });
});
