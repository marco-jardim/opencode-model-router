/**
 * #90 P1.2 (amendments A1, A3): the server side of the TUI effort channel. OpenCode v2 only — the v2 adapter
 * (src/compat/v2-hooks.ts) records, per session (root and child), what its `chat.params` bridge applied to the latest turn and
 * answers the TUI's `effortOf` rpc from this store. Nothing here runs on OpenCode v1.
 */
import { effortRpc, type EffortOfOutput } from "./effort-rpc";

/** The store's default bound: the sessions of one location the TUI can still ask about. */
export const EFFORT_STORE_MAX_SESSIONS = 1000;

/** One turn as the adapter saw it; fields that are not strings (or a finite `at`) are dropped. */
export interface EffortTurn {
  readonly effort?: unknown;
  readonly variant?: unknown;
  readonly providerID?: unknown;
  readonly modelID?: unknown;
  readonly agent?: unknown;
  readonly at?: unknown;
}

export interface EffortStore {
  /** The latest turn of `sessionID` replaces the previous one (an absent effort clears a stale one). */
  record(sessionID: string, turn: EffortTurn): void;
  /** A copy of the latest turn of `sessionID`, or `{}` when nothing is known. */
  lookup(sessionID: string): EffortOfOutput;
  /** How many sessions are held. */
  size(): number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const TEXT_FIELDS = ["effort", "variant", "providerID", "modelID", "agent"] as const;

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/** Only the fields the rpc output declares, each only when it has a usable value (the output schema has no other keys). */
function sanitize(turn: EffortTurn): EffortOfOutput {
  const out: Mutable<EffortOfOutput> = {};
  for (const field of TEXT_FIELDS) {
    const value = turn[field];
    if (nonEmptyString(value)) out[field] = value;
  }
  if (typeof turn.at === "number" && Number.isFinite(turn.at)) out.at = turn.at;
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
    size: () => entries.size,
  };
}

/**
 * The effort a turn's (already normalised) request options carry: `reasoningEffort` (OpenAI family, and the alias
 * `reasoning_effort` once normalised), else `effort` (the Anthropic key `buildAgentOptions` writes and the escalation override
 * replaces). Undefined when neither is a non-empty string.
 */
export function appliedEffort(options: Readonly<Record<string, unknown>>): string | undefined {
  const reasoning = options.reasoningEffort;
  if (nonEmptyString(reasoning)) return reasoning;
  const effort = options.effort;
  return nonEmptyString(effort) ? effort : undefined;
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

const isDisposable = (value: unknown): value is Disposable =>
  value !== null && typeof value === "object" && typeof (value as { dispose?: unknown }).dispose === "function";

const defaultLog: EffortChannelLog = { warn: (message) => console.warn(`[model-router] ${message}`) };

/**
 * Registers `effortOf` on the host's rpc domain (`ctx.rpc.register(definition, handlers)`, OpenCode v2 ≥ 2.0.24). Feature-detected
 * (no `register` function: nothing, silently); a throwing or rejecting `register` is logged once and swallowed — the channel is
 * optional and must never fail the plugin's setup. Resolves to a dispose function that never throws either.
 */
export async function registerEffortChannel(
  rpcLike: unknown,
  store: EffortStore,
  log: EffortChannelLog = defaultLog,
): Promise<() => Promise<void>> {
  let registration: unknown;
  try {
    // The host's `ctx.rpc` is callable (`Object.assign(client, { register })`, @opencode/plugin promise/adapter.js): a function
    // or an object carrying `register` both qualify.
    const rpc = rpcLike as Partial<RpcLike> | null | undefined;
    if (rpc === null || (typeof rpc !== "object" && typeof rpc !== "function") || typeof rpc.register !== "function") return async () => {};
    registration = await rpc.register(effortRpc, { effortOf: effortOfHandler(store) });
  } catch (error) {
    try {
      log.warn(`TUI effort channel not registered (effortOf unavailable): ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // A failing log sink must not turn an optional channel into a setup failure.
    }
    return async () => {};
  }
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (isDisposable(registration)) await registration.dispose();
    } catch {
      // Disposal is best effort: the host drops the registry with the location anyway.
    }
  };
}
