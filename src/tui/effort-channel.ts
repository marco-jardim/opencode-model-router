/**
 * #90 P1.2 (amendments A1, A3): the server side of the TUI effort channel. OpenCode v2 only — the v2 adapter
 * (src/compat/v2-hooks.ts) records, per session (root and child), what its `chat.params` bridge applied to the latest turn and
 * answers the TUI's `effortOf` rpc from this store. Nothing here runs on OpenCode v1.
 */
import { isClaudeModel } from "../router/protocol";
import { effortRpc, type EffortOfOutput } from "./effort-rpc";

/** The store's default bound: the sessions of one location the TUI can still ask about. */
export const EFFORT_STORE_MAX_SESSIONS = 1000;

/** How long the registration waits for the host's `rpc.register` before it resolves without the channel (a late one is kept). */
export const EFFORT_REGISTER_TIMEOUT_MS = 2000;

/** One turn as the adapter saw it; fields that are not strings (or a finite `at`, a positive integer budget) are dropped. */
export interface EffortTurn {
  readonly effort?: unknown;
  readonly variant?: unknown;
  readonly providerID?: unknown;
  readonly modelID?: unknown;
  readonly agent?: unknown;
  readonly at?: unknown;
  readonly thinkingBudget?: unknown;
}

export interface EffortStore {
  /** The latest turn of `sessionID` replaces the previous one (an absent effort clears a stale one). */
  record(sessionID: string, turn: EffortTurn): void;
  /** A copy of the latest turn of `sessionID`, or `{}` when nothing is known. */
  lookup(sessionID: string): EffortOfOutput;
  /** Drops what is known about `sessionID` (the session was deleted, or its latest request did not go out). */
  forget(sessionID: string): void;
  /** How many sessions are held. */
  size(): number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const TEXT_FIELDS = ["effort", "variant", "providerID", "modelID", "agent"] as const;

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Only the fields the rpc output declares, each only when it has a usable value (the output schema has no other keys). */
function sanitize(turn: EffortTurn): EffortOfOutput {
  const out: Mutable<EffortOfOutput> = {};
  for (const field of TEXT_FIELDS) {
    const value = turn[field];
    if (nonEmptyString(value)) out[field] = value;
  }
  if (typeof turn.at === "number" && Number.isFinite(turn.at)) out.at = turn.at;
  if (positiveInteger(turn.thinkingBudget)) out.thinkingBudget = turn.thinkingBudget;
  return out;
}

/** A bounded in-memory store; above `maxSessions` the least recently WRITTEN session is evicted. */
export function createEffortStore(maxSessions: number = EFFORT_STORE_MAX_SESSIONS): EffortStore {
  const max = Number.isSafeInteger(maxSessions) && maxSessions > 0 ? maxSessions : EFFORT_STORE_MAX_SESSIONS;
  const entries = new Map<string, EffortOfOutput>();
  return {
    record(sessionID, turn) {
      if (!nonEmptyString(sessionID)) return;
      entries.delete(sessionID); // re-inserted last: the write order is the eviction order
      entries.set(sessionID, sanitize(turn));
      while (entries.size > max) entries.delete(entries.keys().next().value!);
    },
    lookup(sessionID) {
      const entry = nonEmptyString(sessionID) ? entries.get(sessionID) : undefined;
      return entry === undefined ? {} : { ...entry };
    },
    forget(sessionID) {
      if (nonEmptyString(sessionID)) entries.delete(sessionID);
    },
    size: () => entries.size,
  };
}

/**
 * The effort a turn's (already normalised) request options carry. Two keys can hold it: `effort` (what `buildAgentOptions`
 * writes for a Claude model, and what the escalation override replaces there) and `reasoningEffort` (every other family; the
 * `reasoning_effort` alias once normalised). For a Claude model (the router's own `isClaudeModel`, on `provider/model`)
 * `effort` is read first, otherwise `reasoningEffort`; each falls back to the other. Undefined when neither is a non-empty string.
 */
export function appliedEffort(
  options: Readonly<Record<string, unknown>>,
  model: { readonly providerID?: unknown; readonly modelID?: unknown } = {},
): string | undefined {
  // `provider/model` as the router spells a model (a provider alone stays `anthropic/`, which the predicate still matches).
  const id = nonEmptyString(model.modelID) ? model.modelID : "";
  const ref = nonEmptyString(model.providerID) ? `${model.providerID}/${id}` : id;
  const order = isClaudeModel(ref) ? ["effort", "reasoningEffort"] as const : ["reasoningEffort", "effort"] as const;
  for (const key of order) {
    const value = options[key];
    if (nonEmptyString(value)) return value;
  }
  return undefined;
}

/**
 * The thinking budget a turn's (already normalised) request options carry, in the shape the router writes it
 * (src/router/agent-options.ts `buildAgentOptions`: `thinking: { type: "enabled", budgetTokens }`; the `budget_tokens` alias once
 * normalised): `budgetTokens` when `type` is `"enabled"` and the budget a positive integer, else undefined.
 */
export function appliedThinkingBudget(options: Readonly<Record<string, unknown>>): number | undefined {
  const thinking = options.thinking;
  if (thinking === null || typeof thinking !== "object") return undefined;
  const { type, budgetTokens } = thinking as { type?: unknown; budgetTokens?: unknown };
  return type === "enabled" && positiveInteger(budgetTokens) ? budgetTokens : undefined;
}

/** The `effortOf` handler: defensive about its input (anything but a non-empty `sessionID` string answers `{}`). */
export function effortOfHandler(store: EffortStore): (input: unknown) => Promise<EffortOfOutput> {
  return async (input) => {
    try {
      if (input === null || typeof input !== "object") return {};
      const sessionID = (input as { sessionID?: unknown }).sessionID;
      return nonEmptyString(sessionID) ? store.lookup(sessionID) : {};
    } catch {
      return {};
    }
  };
}

type EffortHandlers = { readonly effortOf: (input: unknown) => Promise<EffortOfOutput> };
interface RpcLike {
  register(definition: typeof effortRpc, handlers: EffortHandlers): unknown;
}
interface Disposable {
  dispose(): unknown;
}
export interface EffortChannelLog {
  warn(message: string): void;
}
export interface EffortChannelOptions {
  /** How long to wait for `register` (default {@link EFFORT_REGISTER_TIMEOUT_MS}); injectable for tests. */
  readonly timeoutMs?: number;
}

const isDisposable = (value: unknown): value is Disposable =>
  value !== null && typeof value === "object" && typeof (value as { dispose?: unknown }).dispose === "function";

/** Disposes a registration, best effort: the host drops the registry with the location anyway. */
async function disposeQuietly(registration: unknown): Promise<void> {
  try {
    if (isDisposable(registration)) await registration.dispose();
  } catch {
    // Never thrown out of a dispose path.
  }
}

const defaultLog: EffortChannelLog = { warn: (message) => console.warn(`[model-router] ${message}`) };
const NO_OP = async (): Promise<void> => {};
const TIMED_OUT: unique symbol = Symbol("effort-channel-timeout");

/**
 * Registers `effortOf` on the host's rpc domain (`ctx.rpc.register(definition, handlers)`, OpenCode v2 ≥ 2.0.22 (types), verified
 * 2.0.24–2.0.26). Feature-detected (no `register` function: nothing, silently); a throwing or rejecting `register` is logged once
 * and swallowed — the channel is optional and must never fail the plugin's setup. The returned promise waits for `register` a
 * bounded time (default 2 s): past it, it resolves without the channel (logged once); the v2 adapter does not await it (GA-4). A
 * registration that arrives later is kept (logged once) and disposed with the channel; one that arrives after the channel was
 * disposed is disposed at once; a late rejection is swallowed. Resolves to a dispose function that never throws.
 */
export async function registerEffortChannel(
  rpcLike: unknown,
  store: EffortStore,
  log: EffortChannelLog = defaultLog,
  options: EffortChannelOptions = {},
): Promise<() => Promise<void>> {
  const note = (message: string): void => {
    try {
      log.warn(message);
    } catch {
      // A failing log sink must not turn an optional channel into a setup failure.
    }
  };
  const warn = (message: string): void => note(`TUI effort channel not registered (effortOf unavailable): ${message}`);
  const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  let pending: Promise<unknown>;
  try {
    // The host's `ctx.rpc` is callable (`Object.assign(client, { register })`, @opencode/plugin promise/adapter.js): a function
    // or an object carrying `register` both qualify.
    const rpc = rpcLike as Partial<RpcLike> | null | undefined;
    if (rpc === null || (typeof rpc !== "object" && typeof rpc !== "function") || typeof rpc.register !== "function") return NO_OP;
    pending = Promise.resolve(rpc.register(effortRpc, { effortOf: effortOfHandler(store) }));
  } catch (error) {
    warn(messageOf(error));
    return NO_OP;
  }
  const requested = options.timeoutMs;
  const timeoutMs = typeof requested === "number" && Number.isFinite(requested) && requested >= 0 ? requested : EFFORT_REGISTER_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    pending.then((registration) => ({ registration }), (error: unknown) => ({ error })),
    new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (outcome !== TIMED_OUT && "error" in outcome) {
    warn(messageOf(outcome.error));
    return NO_OP;
  }
  let disposed = false;
  let registration: unknown = outcome === TIMED_OUT ? undefined : outcome.registration;
  if (outcome === TIMED_OUT) {
    note(`TUI effort channel: rpc.register did not settle within ${timeoutMs} ms; setup goes on without it (a late registration is kept)`);
    pending.then((late) => {
      if (disposed) {
        void disposeQuietly(late); // the channel is gone already: never leave a registration behind
        return;
      }
      registration = late;
      note(`TUI effort channel registered late (after the ${timeoutMs} ms wait); effortOf is available`);
    }, () => {
      // A late rejection: the channel stays unavailable, as the timeout already said.
    });
  }
  return async () => {
    if (disposed) return;
    disposed = true;
    await disposeQuietly(registration);
  };
}
