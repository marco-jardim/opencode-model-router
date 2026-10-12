// Adaptive per-provider concurrency (Phase 3.1.3, memo phase-3.1.md §3 M14-M20, §7 M35 capacity metric, §8).
// Imports `./types` only (memo §1 dependency table).

import {
  classifyProviderError,
  ExecutorError,
  HEAVY_CAP_PER_PROVIDER,
  type CapacityController,
  type CapacityView,
  type Clock,
  type ExecutorEvent,
  type InboxItem,
  type IsoTime,
  type JsonValue,
  type MetricPayload,
  type ProviderSignal,
  type RouteResolver,
  type TaskId,
  type TaskNode,
  type TaskRoute,
} from "./types";

/** The `capacity` variant of `MetricPayload` (memo §7 M35). */
export type CapacityMetric = Extract<MetricPayload, { name: "capacity" }>;

/** Persistable per-provider state; `holdUntilMs` 0 means no hold. */
export interface CapacityProviderState {
  limit: number;
  holdUntilMs: number;
  lastSignalAtMs: number | null;
  pausedUntilMs: number | null;
}

export interface CapacityOptions {
  /** Initial limit and cap (1-8, D13). */
  maxParallel: number;
  /** `capacityCooldownMs`: hold after a decrease, quiet time before growth, retry-stop threshold. */
  cooldownMs: number;
  /** `capacityPauseMs`: pause length when a quota error carries no future zoned instant. */
  pauseMs: number;
  /** Concurrent heavy children per provider before `min(·, limit)`; default `HEAVY_CAP_PER_PROVIDER`. */
  heavyCap?: number;
  clock: Clock;
  onMetric(m: CapacityMetric): void;
  restore?: Readonly<Record<string, CapacityProviderState>>;
}

type OnSignalResult = ReturnType<CapacityController["onSignal"]>;
type InboxInput = Omit<InboxItem, "id" | "createdAt" | "answer">;

interface ProviderRuntime extends CapacityProviderState {
  used: number;
  heavyUsed: number;
}

interface TokenRecord {
  provider: string;
  heavy: boolean;
  taskId: TaskId;
  attempt: number;
  acquiredAtMs: number;
}

/** M17: the first zoned ISO instant in `message` that is later than `nowMs`; zoneless and past instants are ignored. */
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

export function pauseUntilFromMessage(message: string, nowMs: number): number | null {
  for (const m of message.matchAll(ISO_INSTANT)) {
    const t = Date.parse(m[0]);
    if (Number.isFinite(t) && t > nowMs) return t;
  }
  return null;
}

/** Free-slot queries of controllers built here; `CapacityController` itself exposes no counters. */
const FREE = new WeakMap<CapacityController, (provider: string, heavy: boolean) => number>();

function clampLimit(limit: number, maxParallel: number): number {
  if (!Number.isFinite(limit)) return maxParallel;
  return Math.min(maxParallel, Math.max(1, Math.floor(limit)));
}

export function createCapacityController(o: CapacityOptions): CapacityController {
  const maxParallel = Math.max(1, Math.floor(o.maxParallel));
  const heavyCap = Math.max(0, Math.floor(o.heavyCap ?? HEAVY_CAP_PER_PROVIDER));
  const { cooldownMs, pauseMs, clock } = o;

  const providers = new Map<string, ProviderRuntime>();
  const tokens = new Map<string, TokenRecord>();
  /** M15: first rate-limit/overload signal per stepKey (dedupe and M18 age). */
  const firstSignalAt = new Map<string, number>();
  /** M18: `retry-stop` is emitted once per stepKey. */
  const retryStopped = new Set<string>();
  let tokenSeq = 0;

  for (const [p, s] of Object.entries(o.restore ?? {})) {
    providers.set(p, {
      limit: clampLimit(s.limit, maxParallel),
      holdUntilMs: s.holdUntilMs,
      lastSignalAtMs: s.lastSignalAtMs,
      pausedUntilMs: s.pausedUntilMs,
      used: 0,
      heavyUsed: 0,
    });
  }

  /** Called only after the state change it reports, so a throwing sink leaves the state consistent. */
  const emit = (m: Omit<CapacityMetric, "name">): void => {
    o.onMetric({ name: "capacity", ...m });
  };

  const state = (provider: string): ProviderRuntime => {
    let s = providers.get(provider);
    if (s === undefined) {
      s = { limit: maxParallel, holdUntilMs: 0, lastSignalAtMs: null, pausedUntilMs: null, used: 0, heavyUsed: 0 };
      providers.set(provider, s);
    }
    return s;
  };

  /** M17 lazy resume: any call at or after `pausedUntil` lifts the pause (metric `resume`, limit unchanged). */
  const current = (provider: string, now: number): ProviderRuntime => {
    const s = state(provider);
    if (s.pausedUntilMs !== null && now >= s.pausedUntilMs) {
      s.pausedUntilMs = null;
      emit({ provider, change: "resume", from: s.limit, to: s.limit, until: null, errorType: null, status: null });
    }
    return s;
  };

  const heavyLimit = (s: ProviderRuntime): number => Math.min(heavyCap, s.limit);

  const free = (provider: string, heavy: boolean): number => {
    const s = current(provider, clock.now());
    const normal = s.pausedUntilMs !== null ? 0 : Math.max(0, s.limit - s.used);
    return heavy ? Math.min(normal, Math.max(0, heavyLimit(s) - s.heavyUsed)) : normal;
  };

  const isoOrNull = (ms: number | null): IsoTime | null => (ms === null ? null : clock.iso(ms));

  const controller: CapacityController = {
    limit(provider) {
      return current(provider, clock.now()).limit;
    },

    canAcquire(provider, heavy) {
      return free(provider, heavy) > 0;
    },

    acquire(provider, heavy, taskId, attempt, opts) {
      const now = clock.now();
      const s = current(provider, now);
      if (opts?.force !== true && free(provider, heavy) <= 0) {
        throw new ExecutorError("E_CAPACITY", `no ${heavy ? "heavy " : ""}capacity for provider ${provider}`, {
          provider, heavy, taskId, attempt, limit: s.limit, used: s.used, heavyUsed: s.heavyUsed,
          pausedUntil: isoOrNull(s.pausedUntilMs),
        });
      }
      tokenSeq += 1;
      const id = `cap-${tokenSeq}`;
      tokens.set(id, { provider, heavy, taskId, attempt, acquiredAtMs: now });
      s.used += 1;
      if (heavy) s.heavyUsed += 1;
      return { id };
    },

    release(token, result) {
      const t = tokens.get(token.id);
      if (t === undefined) return; // idempotent; unknown ids are ignored
      tokens.delete(token.id);
      const now = clock.now();
      const s = current(t.provider, now);
      s.used = Math.max(0, s.used - 1);
      if (t.heavy) s.heavyUsed = Math.max(0, s.heavyUsed - 1);
      if (result !== "success" || s.limit >= maxParallel) return;
      // M16: grow by 1 only after a quiet cooldown, and only from a child started at or after the last signal.
      if (s.pausedUntilMs !== null || now < s.holdUntilMs) return;
      if (s.lastSignalAtMs !== null && (now - s.lastSignalAtMs < cooldownMs || t.acquiredAtMs < s.lastSignalAtMs)) return;
      const from = s.limit;
      s.limit = from + 1;
      emit({ provider: t.provider, change: "increase", from, to: s.limit, until: null, errorType: null, status: null });
    },

    onSignal(sig: ProviderSignal): OnSignalResult {
      const now = clock.now();
      const s = current(sig.provider, now);
      const cls = classifyProviderError(sig.error);
      const errorType = sig.error.type;
      const status = sig.error.status;

      if (cls === "rate-limit" || cls === "overload") {
        s.lastSignalAtMs = now;
        if (firstSignalAt.has(sig.stepKey)) {
          return { decreased: false, pausedUntil: isoOrNull(s.pausedUntilMs), inbox: null };
        }
        firstSignalAt.set(sig.stepKey, now);
        // A first signal at the floor (limit 1) still renews the hold and emits `decrease` 1 -> 1 (`decreased: false`).
        const from = s.limit;
        s.limit = Math.max(1, Math.floor(from / 2));
        s.holdUntilMs = now + cooldownMs;
        emit({ provider: sig.provider, change: "decrease", from, to: s.limit, until: clock.iso(s.holdUntilMs), errorType, status });
        return { decreased: s.limit < from, pausedUntil: isoOrNull(s.pausedUntilMs), inbox: null };
      }

      if (cls === "quota") {
        const until = pauseUntilFromMessage(sig.error.message, now) ?? now + pauseMs;
        const starting = s.pausedUntilMs === null;
        if (!starting && s.pausedUntilMs !== null && until <= s.pausedUntilMs) {
          return { decreased: false, pausedUntil: clock.iso(s.pausedUntilMs), inbox: null };
        }
        s.pausedUntilMs = until;
        const untilIso = clock.iso(until);
        emit({ provider: sig.provider, change: "pause", from: s.limit, to: s.limit, until: untilIso, errorType, status });
        const inbox: InboxInput | null = starting
          ? usageLimitItem(sig.provider, untilIso, errorType)
          : null;
        return { decreased: false, pausedUntil: untilIso, inbox };
      }

      return { decreased: false, pausedUntil: isoOrNull(s.pausedUntilMs), inbox: null };
    },

    shouldStopRetry(i) {
      const now = clock.now();
      const s = current(i.provider, now);
      if (!i.planChild) return false;
      const first = firstSignalAt.get(i.stepKey);
      const stop = s.pausedUntilMs !== null || (first !== undefined && now - first > cooldownMs);
      if (stop && !retryStopped.has(i.stepKey)) {
        retryStopped.add(i.stepKey);
        emit({
          provider: i.provider, change: "retry-stop", from: s.limit, to: s.limit, until: null,
          errorType: null, status: null,
        });
      }
      return stop;
    },

    pausedUntil(provider) {
      return isoOrNull(current(provider, clock.now()).pausedUntilMs);
    },

    snapshot(): JsonValue {
      const now = clock.now();
      const out: { [k: string]: JsonValue } = {};
      for (const p of [...providers.keys()].sort()) {
        const s = current(p, now);
        out[p] = {
          limit: s.limit,
          used: s.used,
          heavyUsed: s.heavyUsed,
          holdUntil: s.holdUntilMs > now ? clock.iso(s.holdUntilMs) : null,
          lastSignalAt: isoOrNull(s.lastSignalAtMs),
          pausedUntil: isoOrNull(s.pausedUntilMs),
        };
      }
      return { maxParallel, heavyCap, cooldownMs, pauseMs, tokens: tokens.size, providers: out };
    },
  };

  FREE.set(controller, free);
  return controller;
}

/** M15: the inbox input raised once when a pause starts. `taskId` stays null here: the controller sees sessions, not
 *  tasks; the runtime fills in the plan child's task when it knows it. */
function usageLimitItem(provider: string, untilIso: IsoTime, errorType: string): InboxInput {
  return {
    kind: "usage-limit",
    severity: "info",
    taskId: null,
    text: `provider ${provider} paused until ${untilIso} (${errorType})`,
    options: [],
  };
}

/** A per-tick view: `routeOf` memoized per task id, `free` per M14. A controller not built by
 *  `createCapacityController` exposes no counters, so its view answers at most 1 (only ever delays). */
export function capacityView(c: CapacityController, routes: RouteResolver): CapacityView {
  const memo = new Map<TaskId, TaskRoute>();
  const free = FREE.get(c) ?? ((p: string, heavy: boolean): number => (c.canAcquire(p, heavy) ? 1 : 0));
  return {
    routeOf(task: TaskNode): TaskRoute {
      let r = memo.get(task.id);
      if (r === undefined) {
        r = routes.route(task);
        memo.set(task.id, r);
      }
      return r;
    },
    free,
  };
}

/** M20: replays the history's `capacity` metrics per provider: the last `to`, and a still-future hold or pause. */
export function capacityRestoreFromEvents(
  events: readonly ExecutorEvent[],
  o: { maxParallel: number; nowMs: number },
): Record<string, CapacityProviderState> {
  const maxParallel = Math.max(1, Math.floor(o.maxParallel));
  const out: Record<string, CapacityProviderState> = {};
  for (const e of events) {
    if (e.type !== "metric" || e.metric.name !== "capacity") continue;
    const m = e.metric;
    const s = (out[m.provider] ??= { limit: maxParallel, holdUntilMs: 0, lastSignalAtMs: null, pausedUntilMs: null });
    s.limit = clampLimit(m.to, maxParallel);
    const untilMs = m.until === null ? Number.NaN : Date.parse(m.until);
    switch (m.change) {
      case "decrease": {
        s.holdUntilMs = Number.isFinite(untilMs) ? untilMs : 0;
        const at = Date.parse(e.at);
        s.lastSignalAtMs = Number.isFinite(at) ? at : null;
        break;
      }
      case "pause":
        if (Number.isFinite(untilMs) && (s.pausedUntilMs === null || untilMs > s.pausedUntilMs)) s.pausedUntilMs = untilMs;
        break;
      case "resume":
        s.pausedUntilMs = null;
        break;
      default:
        break;
    }
  }
  for (const s of Object.values(out)) {
    if (s.holdUntilMs <= o.nowMs) {
      s.holdUntilMs = 0;
      s.lastSignalAtMs = null;
    }
    if (s.pausedUntilMs !== null && s.pausedUntilMs <= o.nowMs) s.pausedUntilMs = null;
  }
  return out;
}
