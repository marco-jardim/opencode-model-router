import { observeV2, type V2Observations } from "../compat/v2-observations";
import { pathsOverlap } from "./schedule";
import type { LedgerV1 } from "./types";

/** Raw committed scheduler inputs, not readySet/updateIdle output. No plan text, evidence, paths or commands. */
export function observeSchedulerLedger(sink: V2Observations | undefined, ledger: Readonly<LedgerV1>, action: "ledger" | "attach"): void {
  observeV2(sink, () => {
    const tasks = Object.values(ledger.tasks);
    if (tasks.length > 256) throw new Error("scheduler observation task bound");
    return { family: "scheduler", planId: ledger.planId, parentSessionID: ledger.orchestrator.sessionID, action,
      state: {
        ledgerSeq: ledger.seq, status: ledger.status, maxParallel: ledger.config.maxParallel,
        tasks: tasks.map((t) => ({ id: t.id, state: t.state, kind: t.kind, phase: t.phase, p50: t.estimate.p50,
          attempts: t.attempts.map((a) => ({ n: a.n, callID: a.callID, childSessionID: a.childSessionID, outcome: a.outcome })) })),
        edges: ledger.edges.map((e) => ({ from: e.from, to: e.to })),
        phases: ledger.phases.map((p) => ({ id: p.id, gate: p.gate, paused: p.paused })),
        // Pairwise conflict facts preserve the scheduler's prefix-overlap rule without disclosing paths.
        writeConflicts: tasks.flatMap((t, i) => tasks.slice(i + 1).filter((other) =>
          t.footprint.writes.some((a) => other.footprint.writes.some((b) => pathsOverlap(a, b)))).map((other) => [t.id, other.id])),
      } };
  });
}
