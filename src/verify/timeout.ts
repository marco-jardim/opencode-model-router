/**
 * src/verify/timeout.ts — shared time-box primitives for delegation.
 *
 * Lives in its own module so both the plugin factory (src/index.ts, producer
 * prompt + verification gate) and the impure verification wiring
 * (src/verify/wiring.ts, grader prompt) can import it without either importing
 * the other. An index -> wiring -> index cycle would be the alternative, and
 * this also keeps the index.ts diff to the call sites themselves.
 *
 * Why a ceiling at all: `session.prompt` has no client-side bound. A model or
 * transport that never answers leaves the delegate waiting forever with no
 * status, no disposal and no way for the ladder to advance. The ceiling turns
 * "never returns" into an honest failed attempt.
 *
 * The timeout is a real cancellation, not merely an abandoned wait: every call
 * site pairs the rejection with `session.abort` (directly, or via
 * disposeChildSession, which aborts before it deletes), and the SDK's abort is
 * a genuine server-side POST /session/{id}/abort.
 *
 * This module owns the ONLY setTimeout in src/. Everything else that needs a
 * clock takes `now` as an argument.
 */

/** Ceiling for one producer `session.prompt` turn (10 minutes). */
export const DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS = 600_000;
/** Ceiling for one grader `session.prompt` turn (1 minute). */
export const DEFAULT_GRADER_PROMPT_TIMEOUT_MS = 60_000;
/** Ceiling for the whole acceptance gate, grader ladder included (90 s). */
export const DEFAULT_GATE_BUDGET_MS = 90_000;

/**
 * Thrown by `withTimeout` when the budget elapses first. A distinct class so
 * call sites can tell "the operation timed out" apart from "the operation
 * failed", and report each honestly instead of collapsing both into one
 * message.
 */
export class RouterTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "RouterTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Coerce a configured budget to a usable one, falling back on anything that is
 * not a finite positive number.
 *
 * validateEnforcement already rejects `0`, negatives and non-integers in
 * tiers.json, so this is defence in depth for config that reaches the runtime
 * without passing through validation (override layers, tests, a hand-built
 * RouterConfig). Note the fallback direction: an unusable value becomes the
 * DEFAULT ceiling, never "no ceiling".
 */
export function timeoutMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Race `promise` against `budgetMs`, rejecting with a RouterTimeoutError if the
 * budget wins. The timer is always cleared in a finally, so a promise that
 * settles first does not leave the event loop pinned for the rest of the
 * budget.
 *
 * Losing the race does not stop the underlying work by itself — cancellation is
 * the caller's job (see the module header).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  budgetMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RouterTimeoutError(operation, budgetMs)),
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
