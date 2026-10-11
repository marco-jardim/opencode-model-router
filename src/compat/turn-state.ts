import { scrubText } from "../guard/scrub";

/**
 * The turn-state tail (v2 only, Phase 1.2): per-request router state that used to be pushed into the system array
 * (pending list, late notices, route hint) is rendered here and appended after the last real message instead, so the
 * cached prefix stays byte-identical between requests. Nothing here runs at load; the registry is created by the adapter.
 */

/** Upper bound of the whole tail in UTF-16 code units: wrapper and overflow line included. */
export const TURN_STATE_MAX_CHARS = 6000;

/** The reserved provider name of the plan section (order 0..9 is reserved for it). */
export const PLAN_PROVIDER_NAME = "plan";

/** Set on the legacy transform's output bag when the request belongs to a root session. */
export const TURN_STATE_ROOT: unique symbol = Symbol("router.turnState.root");

export interface TurnStateProvider {
  name: string;
  order: number;
  render(sid: string): string | undefined;
  active?(sid: string): boolean;
}

export interface TurnStateRegistry {
  /** Returns an idempotent unregister that removes only this registration. */
  registerTurnStateProvider(provider: TurnStateProvider): () => void;
  /** The tail text for the session, or `undefined` when no provider has anything to say. */
  buildTurnState(sid: string): string | undefined;
  /** Whether any provider reports activity for the session (a throw counts as no activity). */
  hasActivity(sid: string): boolean;
}

export interface TurnStateDeps {
  logger: { warn(message: string, meta?: object): void };
  translate?: (text: string) => string;
}

const OPEN = "<router-state>\n";
const CLOSE = "\n</router-state>";
const PLAN_SUFFIX = " (router_plan action=status)";

/** A fresh Anthropic-style cache marker; the only place the router creates one (no TTL is ever set). */
export function routerCacheHint(): { type: "ephemeral" } {
  return { type: "ephemeral" };
}

function compareProviders(a: TurnStateProvider, b: TurnStateProvider): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

export function createTurnStateRegistry(deps: TurnStateDeps): TurnStateRegistry {
  const translate = deps.translate ?? ((text: string) => text);
  /** One record per registration, so a stale unregister can never remove a later registration. */
  const registrations: { provider: TurnStateProvider }[] = [];
  const logged = new Set<string>();

  const warnOnce = (name: string, error: unknown): void => {
    if (logged.has(name)) return;
    logged.add(name);
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`[router] turn state: provider "${name}" failed; section skipped`, { error: scrubText(message) });
  };

  const ordered = (): TurnStateProvider[] => registrations.map((entry) => entry.provider).sort(compareProviders);

  const isActive = (provider: TurnStateProvider, sid: string): boolean => {
    if (provider.active === undefined) return false;
    try {
      return provider.active(sid) === true;
    } catch (error) {
      warnOnce(provider.name, error);
      return false;
    }
  };

  return {
    registerTurnStateProvider(provider) {
      if (typeof provider !== "object" || provider === null
        || typeof provider.name !== "string" || provider.name === ""
        || typeof provider.order !== "number" || !Number.isFinite(provider.order)) {
        throw new Error("turn state provider needs a non-empty name and a finite order");
      }
      if (registrations.some((entry) => entry.provider.name === provider.name)) {
        throw new Error(`turn state provider "${provider.name}" is already registered`);
      }
      const registration = { provider };
      registrations.push(registration);
      return () => {
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },

    buildTurnState(sid) {
      const providers = ordered();
      const sections: string[] = [];
      for (const provider of providers) {
        let text: string;
        try {
          const rendered: unknown = provider.render(sid);
          if (typeof rendered !== "string") continue;
          text = translate(rendered).trim();
        } catch (error) {
          warnOnce(provider.name, error);
          continue;
        }
        if (text !== "") sections.push(text);
      }
      if (sections.length === 0) return undefined;
      const body = sections.join("\n\n");
      const whole = OPEN + body + CLOSE;
      if (whole.length <= TURN_STATE_MAX_CHARS) return whole;

      const planActive = providers.some((provider) => provider.name === PLAN_PROVIDER_NAME && isActive(provider, sid));
      const lines = body.split("\n");
      const overflowLine = (from: number): string =>
        `… ${lines.slice(from).filter((line) => line.trim() !== "").length} more lines${planActive ? PLAN_SUFFIX : ""}`;
      for (let keep = lines.length - 1; keep > 0; keep--) {
        const kept = lines.slice(0, keep);
        while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
        const out = OPEN + (kept.length > 0 ? kept.join("\n") + "\n" : "") + overflowLine(keep) + CLOSE;
        if (out.length <= TURN_STATE_MAX_CHARS) return out;
      }
      // Worst case: the wrapper and the overflow line alone (a few dozen characters, always within the bound).
      return OPEN + overflowLine(0) + CLOSE;
    },

    hasActivity(sid) {
      return ordered().some((provider) => isActive(provider, sid));
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The last non-empty text part of a message (also none for a message without a parts array). */
function lastTextPart(message: unknown): { content: unknown[]; index: number; part: Record<string, unknown> } | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) return undefined;
  const content: unknown[] = message.content;
  for (let index = content.length - 1; index >= 0; index--) {
    const part = content[index];
    if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text !== "") return { content, index, part };
  }
  return undefined;
}

/**
 * Appends the tail as a new last message and puts the one router cache hint on the last non-empty text part of the
 * last message that has one (the O12 walk). Pure: host messages, content arrays and parts are never mutated; the
 * changed message is a prototype-preserving copy. `undefined` tail → `undefined` (the caller leaves the messages alone).
 */
export function placeTurnState<M>(messages: readonly M[], tail: string | undefined, makeTail: (text: string) => M): M[] | undefined {
  if (tail === undefined) return undefined;
  const next = messages.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const message = next[i];
    const target = lastTextPart(message);
    if (target === undefined) continue;
    const content = target.content.slice();
    content[target.index] = { ...target.part, cache: routerCacheHint() };
    const copy: M = Object.assign(Object.create(Object.getPrototypeOf(message)), message, { content });
    next[i] = copy;
    break;
  }
  next.push(makeTail(tail));
  return next;
}
