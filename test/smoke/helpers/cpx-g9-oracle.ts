import type { Attempt } from "../../../src/executor/types";
import type { CpxRequest } from "./cpx-scripted-provider";

type G9Attempt = Pick<Attempt, "n" | "nonce" | "childSessionID" | "endedAt" | "outcome">;
export interface G9Ledger {
  readonly tasks: Readonly<Record<string, { readonly attempts: readonly G9Attempt[] }>>;
}
export interface RestartAttempt {
  readonly taskId: string;
  readonly n: number;
  readonly nonce: string;
  readonly childSessionID: string;
}

function fact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`G9: ${message}`);
}

/** Freeze actual open children BEFORE the crash, never infer permitted losses from the final ledger. */
export function captureRestartAttempts(ledger: G9Ledger): readonly RestartAttempt[] {
  return Object.freeze(Object.entries(ledger.tasks).flatMap(([taskId, task]) => task.attempts.flatMap(attempt =>
    attempt.outcome === null && attempt.endedAt === null && typeof attempt.childSessionID === "string" && attempt.childSessionID.length > 0
      ? [Object.freeze({ taskId, n: attempt.n, nonce: attempt.nonce, childSessionID: attempt.childSessionID })] : [])));
}

/** D16 applies ONLY to children observed at the intentional restart. Baselines must have zero lost
 * attempts; unexpected losses in the restart run also fail, even if that task has no commit subject.
 * Preserve every other subject byte and every integration entry (including missing/duplicate entries).
 */
export function normalizedCommitSubjects(subjects: readonly string[], ledger: G9Ledger, checkpoint?: readonly RestartAttempt[]): string[] {
  const lostByTask = new Map<string, number[]>();
  for (const [taskId, task] of Object.entries(ledger.tasks)) {
    const lost = task.attempts.filter(attempt => attempt.outcome === "lost");
    fact(checkpoint !== undefined || lost.length === 0, `uninterrupted baseline must have zero lost attempts (${taskId})`);
    for (const attempt of lost) {
      fact(checkpoint?.some(open => open.taskId === taskId && open.n === attempt.n && open.nonce === attempt.nonce && open.childSessionID === attempt.childSessionID),
        `lost attempt outside restart checkpoint: ${taskId}#${attempt.n}`);
      fact(attempt.endedAt !== null, `restart lost attempt must be closed: ${taskId}#${attempt.n}`);
    }
    lostByTask.set(taskId, lost.map(attempt => attempt.n));
  }
  return subjects.map(subject => {
    const colon = subject.indexOf(":");
    const suffix = /\(attempt (\d+)\)$/.exec(subject);
    if (colon < 0 || !suffix) return subject;
    const taskId = subject.slice(0, colon);
    const n = Number(suffix[1]);
    const lost = (lostByTask.get(taskId) ?? []).filter(prior => prior < n).length;
    return lost === 0 ? subject : `${subject.slice(0, suffix.index)}(attempt ${n - lost})`;
  });
}

/** Check the observed request, not a status-turn record populated with the expected root literal. */
export function assertRecoveryWakeSession(request: Pick<CpxRequest, "headers"> | undefined, root: string): void {
  fact(request, "restart wake request must exist");
  const header = (key: string): string | undefined => {
    const value = request.headers[key];
    return Array.isArray(value) ? value[0] : value;
  };
  fact(header("x-proof-session") === root, "only the bound root answers the wake");
  fact(header("x-proof-kind") === "primary", "restart wake must be a primary request");
}
