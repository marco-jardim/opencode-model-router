import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect } from "vitest";
import { checkV2ObservationStream, type ServiceObservationData } from "../../src/compat/v2-observations";

/** Only the OS child is doubled: callers still run their real pre-spawn preparation and process lifecycle. */
export function completedServiceProcess(onClose: () => void, output = "", code = 0): ChildProcess {
  const child = new ChildProcess();
  const stdout = new PassThrough(), stderr = new PassThrough();
  child.stdout = stdout;
  child.stderr = stderr;
  queueMicrotask(() => {
    stdout.end(output);
    stderr.end();
    onClose();
    child.emit("exit", code, null);
    child.emit("close", code, null);
  });
  return child;
}

/** Also requires a complete, fault-free stream: dropped starts/ends must never look like zero service. */
export function servicePairs(lines: readonly string[]): ServiceObservationData[] {
  const rows = checkV2ObservationStream(lines).filter(r => r.family === "service");
  const starts = rows.filter(r => r.action === "start");
  expect(new Set(starts.map(r => r.operationId)).size).toBe(starts.length);
  expect(rows.filter(r => r.action === "end")).toHaveLength(starts.length);
  for (const start of starts) {
    const ends = rows.filter(r => r.action === "end" && r.operationId === start.operationId);
    expect(ends).toHaveLength(1);
    const end = ends[0]!;
    for (const key of ["planId", "taskId", "attempt", "phaseId", "entryId", "taskIds", "component", "candidate", "stage", "spanKind"] as const) {
      expect(end[key]).toEqual(start[key]);
    }
    expect(start.result).toBeNull();
    expect(start.durationMs).toBe(0);
    expect(end.result).not.toBeNull();
    expect(end.clockMs).toBeGreaterThanOrEqual(start.clockMs);
    expect(end.durationMs).toBe(end.clockMs - start.clockMs);
  }
  return rows;
}
