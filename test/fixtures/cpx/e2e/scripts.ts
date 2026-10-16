import { readFileSync } from "node:fs";
import { canonicalFindingsJson, type FindingsReport } from "../../../../src/executor/types";
import type { CpxReply, FaultKind } from "../../../smoke/helpers/cpx-scripted-provider";

export interface TaskScript {
  durationMs: number;
  writePath?: string;
  content?: string;
  /** Explicit turns replace the default write + DONE sequence. */
  turns?: CpxReply[];
  findings?: FindingsReport;
  /** Passed to CpxFront.escalateNext, which prepends ESCALATE: itself. */
  escalation?: string;
}

export interface SuiteCommand { cwd: string; command: string; args: string[] }
type Checkpoint = { checkpoint: string };
export type Injection = Checkpoint & (
  | { kind: "hidden-overlap"; task: string; holder: string; path: string; holdUntil: string; expectedToolResult: "lease-conflict" }
  | { kind: "phase-only-regression"; task: string; expectedLocalExit: number; expectedPhaseExit: number; recovery: TaskScript }
  | { kind: "human-escalation"; task: string; answer: string; independentTask: string; recovery: TaskScript }
  | { kind: "qa-findings"; task: string; fixTasks: string[]; reviewTask: string }
  | { kind: "rate-limit"; task: string; fault: FaultKind; options: { times: number; retryAfterSeconds: number }; faultDelayMs: number }
  | { kind: "host-restart"; task: string; resumeCommand: string; baseline: string; recovery: TaskScript }
  | { kind: "ad-hoc-background" | "user-backgrounded"; dispatch: string }
  | { kind: "required-verification"; dispatch: string; onlyWhen: ["C4", "C15"]; otherwise: "foreground" }
);

export interface BackgroundDispatch {
  id: string;
  background: boolean;
  verify: "none" | "deferred" | "required";
  prompt: string;
  script: TaskScript;
  userAction?: "background-while-running";
  holdVerdictUntil?: string;
}

export interface PlanScript {
  schemaVersion: 1;
  plan: string;
  executor: { maxParallel: number; crossPhase: "inferred" };
  defaults: { content: string; completion: string; qa: FindingsReport };
  tasks: Record<string, TaskScript>;
  phaseSuites: Record<string, SuiteCommand[]>;
  localChecks: Record<string, SuiteCommand[]>;
  injections: Injection[];
  generatedTasks?: Record<string, TaskScript>;
  backgroundDispatches?: BackgroundDispatch[];
  tailAssertions: string[];
}

/** Trusted, checked-in fixture data; fixtures.test.ts pins its shape and provider compatibility. */
export function loadScript(name: "throughput" | "resilience"): PlanScript {
  return JSON.parse(readFileSync(new URL(`${name}.script.json`, import.meta.url), "utf8"));
}

export interface ScriptedTurn { delayMs: number; reply: CpxReply }

/** Front.replyNext-compatible turns. Paths remain run/slot-relative for the driver to rebase. */
export function scriptedTurns(script: PlanScript, task: TaskScript): ScriptedTurn[] {
  const replies: CpxReply[] = task.turns ?? (
    task.escalation !== undefined ? [{ text: `ESCALATE: ${task.escalation}` }] :
    task.writePath !== undefined ? [
      { tool: "write", input: { path: task.writePath, content: task.content ?? script.defaults.content } },
      { text: script.defaults.completion },
    ] : [{ text: canonicalFindingsJson(task.findings ?? script.defaults.qa) }]
  );
  if (!Number.isInteger(task.durationMs) || task.durationMs < 0 || replies.length === 0) {
    throw new Error("A task script needs a nonnegative integer duration and at least one turn");
  }
  // Charge the task's work once, not once per write or on each retryable provider fault.
  return replies.map((reply, index) => ({ delayMs: index === 0 ? task.durationMs : 0, reply }));
}
