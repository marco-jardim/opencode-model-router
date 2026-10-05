import { buildAgentOptions, effortCeilingFor, effortRank } from "../router/agent-options";
import { EFFORT_LEVELS, type EffortLevel, type TierConfig } from "../router/config";

export const EFFORT_OVERRIDE_KEYS = ["effort", "reasoningEffort"] as const;

type Logger = { warn(msg: string): void };
type Entry = {
  tierName: string;
  model: string;
  keys: Partial<Record<(typeof EFFORT_OVERRIDE_KEYS)[number], unknown>>;
  warnedMissingTarget: boolean;
};

export interface EffortOverrideStore {
  set(sessionID: string, tierName: string, tier: TierConfig, effort: EffortLevel): void;
  clear(sessionID: string): void;
  has(sessionID: string): boolean;
  size(): number;
}

// Keep the public store API small and prevent callers from mutating saved keys.
const entriesByStore = new WeakMap<EffortOverrideStore, Map<string, Entry>>();

function warn(logger: Logger, message: string): void {
  try {
    logger.warn(`[model-router] ${message}`);
  } catch {
    // A failing logger must not turn a best-effort override into a hook failure.
    return;
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createEffortOverrideStore(
  opts: { maxEntries?: number; logger?: Logger } = {},
): EffortOverrideStore {
  const logger = opts.logger ?? console;
  const requestedMax = opts.maxEntries ?? 1_000;
  const maxEntries = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : 1_000;
  if (maxEntries !== requestedMax) warn(logger, "Invalid effort override maxEntries; using 1000");
  const entries = new Map<string, Entry>();
  const store: EffortOverrideStore = {
    set(sessionID, tierName, tier, effort) {
      try {
        if (!nonempty(sessionID) || !nonempty(tierName) || !tier || typeof tier !== "object"
          || !nonempty(tier.model) || !EFFORT_LEVELS.includes(effort)) {
          warn(logger, "Invalid effort override arguments; override refused");
          return;
        }
        const separator = tier.model.indexOf("/");
        if (separator <= 0 || separator === tier.model.length - 1) {
          warn(logger, "Effort override requires a provider/model identity; override refused");
          return;
        }
        const ceiling = effortCeilingFor(tier);
        if (ceiling === null || effortRank(effort) > effortRank(ceiling)) {
          warn(logger, `Effort override for ${sessionID} exceeds the tier ceiling; override refused`);
          return;
        }
        const options = buildAgentOptions({ ...tier, effort }, tierName);
        const keys: Entry["keys"] = {};
        for (const key of EFFORT_OVERRIDE_KEYS) {
          if (Object.hasOwn(options, key)) keys[key] = options[key];
        }
        if (Object.keys(keys).length === 0) {
          warn(logger, `Effort override for ${sessionID} has no effort keys; override refused`);
          return;
        }
        entries.delete(sessionID);
        entries.set(sessionID, { tierName, model: tier.model, keys, warnedMissingTarget: false });
        if (entries.size > maxEntries) {
          // A positive capacity and overflow guarantee a first entry.
          const oldest = entries.keys().next().value!;
          entries.delete(oldest);
          warn(logger, `Evicted oldest effort override for ${oldest}`);
        }
      } catch {
        warn(logger, "Failed to register effort override");
      }
    },
    clear(sessionID) { entries.delete(sessionID); },
    has(sessionID) { return entries.has(sessionID); },
    size() { return entries.size; },
  };
  entriesByStore.set(store, entries);
  return store;
}

/** Apply only to the producer's provider-options object, chosen by the host adapter. */
export function applyEffortOverride(
  store: EffortOverrideStore,
  input: { sessionID?: unknown; agent?: unknown; model?: unknown },
  target: unknown,
  logger: Logger,
): void {
  try {
    if (typeof input.sessionID !== "string") return;
    const entry = entriesByStore.get(store)?.get(input.sessionID);
    if (!entry || input.agent !== entry.tierName) return;
    if (input.model === null || typeof input.model !== "object") return;
    const model = input.model as { providerID?: unknown; modelID?: unknown; id?: unknown };
    const separator = entry.model.indexOf("/");
    if (model.providerID !== entry.model.slice(0, separator)
      || (model.modelID ?? model.id) !== entry.model.slice(separator + 1)) return;
    if (target === null || typeof target !== "object") {
      // Warning state lives with the bounded entry and is removed on clear/eviction.
      if (!entry.warnedMissingTarget) {
        entry.warnedMissingTarget = true;
        warn(logger, `Missing provider-options target for effort override ${input.sessionID}`);
      }
      return;
    }
    const options = target as Record<string, unknown>;
    for (const key of EFFORT_OVERRIDE_KEYS) {
      if (Object.hasOwn(entry.keys, key)) {
        options[key] = entry.keys[key];
        if (key === "reasoningEffort") delete options.reasoning_effort;
      }
    }
  } catch {
    warn(logger, "Failed to apply effort override");
  }
}
