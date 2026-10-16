import { PLAN_PROVIDER_ORDER, type TurnStateProvider } from "../compat/turn-state";

/**
 * Executor instructions (plan task 4.1.6, v2 only): a turn-state provider section, never system-prompt text. It renders
 * only while a plan runs in the session (`planLine` is non-null) and is byte-stable for the same state, so the cached
 * prefix is untouched. Registration is a handoff to 5.1.2; nothing here registers itself.
 */

/** Provider name; sorts right after the "plan" provider (`PLAN_PROVIDER_NAME`). */
export const EXECUTOR_INSTRUCTIONS_PROVIDER_NAME = "plan-instructions";

/** Right after the plan section, which the v2 adapter registers at `PLAN_PROVIDER_ORDER` (turn-state.ts). */
export const EXECUTOR_INSTRUCTIONS_ORDER = PLAN_PROVIDER_ORDER + 1;

/** The exact text rendered while a plan runs. */
export const EXECUTOR_INSTRUCTIONS_TEXT = [
  "Plan executor rules:",
  "- Run the `manual` tasks listed in the router state yourself and report each with `router_plan action=done`.",
  "- Never edit a slot or the plan file.",
  "- Never report the plan done while `router_plan action=status` says running.",
  "- Answer inbox items only with the human's answer or with text this plan already states.",
].join("\n");

export interface ExecutorInstructionsRuntime {
  planLine(sessionID: string): string | null;
}

export function createExecutorInstructionsProvider(runtime: ExecutorInstructionsRuntime): TurnStateProvider {
  return {
    name: EXECUTOR_INSTRUCTIONS_PROVIDER_NAME,
    order: EXECUTOR_INSTRUCTIONS_ORDER,
    render: (sid) => (runtime.planLine(sid) === null ? undefined : EXECUTOR_INSTRUCTIONS_TEXT),
    active: (sid) => runtime.planLine(sid) !== null,
  };
}
