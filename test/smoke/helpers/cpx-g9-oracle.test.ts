import { describe, expect, it } from "vitest";
import type { Attempt } from "../../../src/executor/types";
import { assertRecoveryWakeSession, captureRestartAttempts, normalizedCommitSubjects, type G9Ledger } from "./cpx-g9-oracle";

const taskId = "2.1.4";
const subject = (n: number): string => `${taskId}: Derive an artifact; recover its interrupted attempt. (attempt ${n})`;
const attempt = (n: number, outcome: Attempt["outcome"], extra: Partial<Attempt> = {}) => ({
  n, outcome, nonce: `nonce-${n}`, childSessionID: `child-${n}`, endedAt: outcome === null ? null : "2026-10-16T00:00:01.000Z", ...extra,
});
const ledger = (attempts: ReturnType<typeof attempt>[]): G9Ledger => ({ tasks: { [taskId]: { attempts } } });
const checkpoint = () => captureRestartAttempts(ledger([attempt(1, null)]));

describe("G9 checkpoint-scoped integration commit subjects (no host)", () => {
  it("normalizes only the restart's observed lost child to the baseline's counted attempt", () => {
    const baseline = normalizedCommitSubjects([subject(1)], ledger([attempt(1, "succeeded")]));
    const recovered = normalizedCommitSubjects([subject(2)], ledger([attempt(1, "lost"), attempt(2, "succeeded")]), checkpoint());
    expect(baseline).toEqual([subject(1)]);
    expect(recovered).toEqual(baseline);
  });

  it("R2-4: rejects a baseline lost attempt that the old normalization hid", () => {
    const baseline = ledger([attempt(1, "lost"), attempt(2, "succeeded")]);
    expect(() => normalizedCommitSubjects([subject(2)], baseline)).toThrow(/baseline must have zero lost attempts/);
    // No commit (e.g. a QA/no-changes task) must not make a baseline loss invisible either.
    expect(() => normalizedCommitSubjects([], baseline)).toThrow(/baseline must have zero lost attempts/);
  });

  it("R2-4: rejects a second, post-checkpoint loss on the checkpoint task", () => {
    const final = ledger([attempt(1, "lost"), attempt(2, "lost"), attempt(3, "succeeded")]);
    expect(() => normalizedCommitSubjects([subject(3)], final, checkpoint())).toThrow(/outside restart checkpoint: 2\.1\.4#2/);
  });

  it("R2-4: rejects another task's loss, even with no subject for that task", () => {
    const final: G9Ledger = { tasks: { ...ledger([attempt(1, "lost"), attempt(2, "succeeded")]).tasks,
      qa: { attempts: [attempt(1, "lost", { nonce: "qa-nonce", childSessionID: "qa-child" })] } } };
    expect(() => normalizedCommitSubjects([subject(2)], final, checkpoint())).toThrow(/outside restart checkpoint: qa#1/);
  });

  it.each([{ childSessionID: "different-child" }, { nonce: "different-nonce" }])("does not allow a same-number loss with a different identity: %j", extra => {
    const final = ledger([attempt(1, "lost", extra), attempt(2, "succeeded")]);
    expect(() => normalizedCommitSubjects([subject(2)], final, checkpoint())).toThrow(/outside restart checkpoint/);
  });

  it("captures immutable open-child identities, excluding attempts already closed or without a child", () => {
    const open = attempt(1, null);
    const before = ledger([open, attempt(2, "lost"), attempt(3, null, { childSessionID: null }),
      attempt(4, null, { endedAt: "2026-10-16T00:00:01.000Z" }), attempt(5, null, { childSessionID: "" })]);
    const captured = captureRestartAttempts(before);
    expect(captured).toEqual([{ taskId, n: 1, nonce: "nonce-1", childSessionID: "child-1" }]);
    open.childSessionID = "mutated-after-checkpoint";
    expect(captured[0]?.childSessionID).toBe("child-1");
    expect(Object.isFrozen(captured) && Object.isFrozen(captured[0])).toBe(true);
    expect(() => normalizedCommitSubjects([subject(3)], ledger([attempt(2, "lost"), attempt(3, "succeeded")]), captured)).toThrow(/outside restart checkpoint/);
  });

  it("allows concurrent checkpoint children, but subtracts only this task's earlier lost attempt", () => {
    const before: G9Ledger = { tasks: { ...ledger([attempt(1, null)]).tasks, other: { attempts: [attempt(1, null, { childSessionID: "other-child" })] } } };
    const final: G9Ledger = { tasks: { ...ledger([attempt(1, "lost"), attempt(2, "failed"), attempt(3, "succeeded")]).tasks,
      other: { attempts: [attempt(1, "lost", { childSessionID: "other-child" }), attempt(2, "succeeded")] } } };
    expect(normalizedCommitSubjects([subject(3), "other: Work (attempt 2)"], final, captureRestartAttempts(before))).toEqual([subject(2), "other: Work (attempt 1)"]);
    expect(normalizedCommitSubjects([subject(1)], final, captureRestartAttempts(before))).toEqual([subject(1)]);
  });

  it.each(["interrupted", "failed", "capacity"] as const)("keeps counted %s attempt 1, so integrated attempt 2 stays attempt 2", outcome => {
    const final = ledger([attempt(1, outcome), attempt(2, "succeeded")]);
    expect(normalizedCommitSubjects([subject(2)], final, checkpoint())).toEqual([subject(2)]);
    expect(normalizedCommitSubjects([subject(2)], final)).toEqual([subject(2)]);
  });

  it("requires the checkpoint loss to be closed", () => {
    expect(() => normalizedCommitSubjects([subject(2)], ledger([attempt(1, "lost", { endedAt: null }), attempt(2, "succeeded")]), checkpoint())).toThrow(/lost attempt must be closed/);
  });

  it.each([0, 2])("retains %i integrations so missing or duplicated effects still fail equality", count => {
    const normalized = normalizedCommitSubjects(Array.from({ length: count }, () => subject(2)), ledger([attempt(1, "lost"), attempt(2, "succeeded")]), checkpoint());
    expect(normalized).toHaveLength(count);
    expect(normalized).not.toEqual([subject(1)]);
  });

  it("leaves unknown task IDs and subjects without an attempt suffix unchanged", () => {
    const subjects = ["unknown: Derive an artifact (attempt 2)", "toString: Unknown task (attempt 2)", `${taskId}: Derive an artifact`, `${taskId}: Keep (attempt 2) inside the title`, "No task delimiter (attempt 2)"];
    expect(normalizedCommitSubjects(subjects, ledger([attempt(1, "lost"), attempt(2, "succeeded")]), checkpoint())).toEqual(subjects);
  });
});

describe("G9 recovery wake session evidence (no host)", () => {
  const root = "root-fixture";
  const request = (session = root, kind = "primary") => ({ headers: { "x-proof-session": session, "x-proof-kind": kind } });

  it("accepts the observed primary request from the bound root, including array headers", () => {
    expect(() => assertRecoveryWakeSession(request(), root)).not.toThrow();
    expect(() => assertRecoveryWakeSession({ headers: { "x-proof-session": [root], "x-proof-kind": ["primary"] } }, root)).not.toThrow();
  });

  it("R2-8: rejects another session even when the cached status-turn record claims the expected root", () => {
    const wake = { sessionID: root, request: request("other-session") };
    // The former `expect(wake.sessionID).toBe(root)` passed on this mismatched evidence.
    expect(() => assertRecoveryWakeSession(wake.request, root)).toThrow(/only the bound root answers the wake/);
  });

  it("rejects missing request/session evidence and auxiliary requests from the same root", () => {
    expect(() => assertRecoveryWakeSession(undefined, root)).toThrow(/wake request must exist/);
    expect(() => assertRecoveryWakeSession({ headers: { "x-proof-kind": "primary" } }, root)).toThrow(/only the bound root/);
    expect(() => assertRecoveryWakeSession(request(root, "compaction"), root)).toThrow(/must be a primary request/);
  });
});
