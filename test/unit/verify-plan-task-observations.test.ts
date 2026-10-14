import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createV2Observations, type ObservationRecord, type V2Observations } from "../../src/compat/v2-observations";
import { leaseHolderID, type Attempt, type SlotLease, type TaskNode } from "../../src/executor/types";
import type { RouterConfig } from "../../src/router/config";
import { createChangedFileStore } from "../../src/verify/dispatch";
import { accept, gateResult } from "../../src/verify/gate";
import { readHeadState } from "../../src/verify/head";
import { createLeaseSelfExemptions, createPlanTaskVerifier, planTaskVerificationID, planTreeKey, type PlanTaskGit } from "../../src/verify/plan-task";
import { snapshotTree } from "../../src/verify/tree";
import { createVerificationWiring } from "../../src/verify/wiring";
import { servicePairs } from "../helpers/service-observations";

// Only I/O and the final gate are doubles: begin/observe/fallback, prepareVerification,
// observeChange and the change store are the real plan-task -> wiring boundary.
vi.mock("../../src/verify/tree", async (original) => ({ ...await original<typeof import("../../src/verify/tree")>(), snapshotTree: vi.fn() }));
vi.mock("../../src/verify/head", async (original) => ({ ...await original<typeof import("../../src/verify/head")>(), readHeadState: vi.fn() }));
vi.mock("../../src/verify/perimeter", async (original) => ({ ...await original<typeof import("../../src/verify/perimeter")>(), planPerimeter: () => undefined }));
vi.mock("../../src/verify/gate", async (original) => ({ ...await original<typeof import("../../src/verify/gate")>(), accept: vi.fn() }));
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

function harness(observations?: V2Observations) {
  const state = { head: BASE, nonce: "" };
  vi.mocked(snapshotTree).mockImplementation(async () => ({
    cwd: root, root, head: state.head, branch, fingerprint: state.head, dirty: false, files: [], digests: new Map(),
  }));
  vi.mocked(readHeadState).mockImplementation(async () => ({ root, head: state.head, branch }));
  const store = createChangedFileStore();
  // delta runs once inside each actual observeChange invocation, not for cached observe calls or gate re-runs.
  const captures = vi.spyOn(store, "delta");
  const wiring = createVerificationWiring({ client: {}, directory: root, getConfig: () => cfg, observations });
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
  });
  return {
    captures,
    async run(a: Attempt, restart: boolean) {
      state.head = BASE;
      state.nonce = a.nonce;
      if (!restart) {
        // The child is not known at begin; diagnostics must use the attempt at capture time.
        await verifier.begin?.(task, slot, { ...a, childSessionID: null }, context);
      }
      await verifier.observe?.(task, slot, a, undefined, context);
      await verifier.observe?.(task, slot, a, undefined, context);
      state.head = CANDIDATE;
      return verifier.verify(task, slot, a, context);
    },
    async dispose() {
      await verifier.dispose?.();
      await wiring.disposeVerification();
    },
  };
}

describe("plan-task capture observations through the real verification wiring", () => {
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
