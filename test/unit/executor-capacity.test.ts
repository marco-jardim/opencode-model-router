import { describe, expect, it } from "vitest";
import {
  capacityRestoreFromEvents,
  capacityView,
  createCapacityController,
  pauseUntilFromMessage,
  type CapacityMetric,
  type CapacityOptions,
} from "../../src/executor/capacity";
import {
  ExecutorError,
  type CapacityController,
  type Clock,
  type ExecutorEvent,
  type HostError,
  type ProviderSignal,
  type TaskNode,
  type TaskRoute,
} from "../../src/executor/types";

const T0 = Date.parse("2026-10-12T10:00:00.000Z");
const COOLDOWN = 120_000;
const PAUSE = 900_000;

/** Fake clock: time moves only through `advance`. */
function fakeClock(start = T0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let now = start;
  let timer = 0;
  return {
    now: () => now,
    iso: (ms?: number) => new Date(ms ?? now).toISOString(),
    setTimer: () => ({ id: ++timer }),
    clearTimer: () => undefined,
    randomHex: (bytes: number) => "0".repeat(bytes * 2),
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

function setup(over: Partial<CapacityOptions> = {}) {
  const clock = fakeClock();
  const metrics: CapacityMetric[] = [];
  const c = createCapacityController({
    maxParallel: 8,
    cooldownMs: COOLDOWN,
    pauseMs: PAUSE,
    clock,
    onMetric: (m) => metrics.push(m),
    ...over,
  });
  return { c, clock, metrics };
}

const RATE: HostError = { type: "provider.rate-limit", status: 429, message: "Too many requests" };
const OVERLOAD: HostError = { type: "provider.internal", status: 529, message: "Overloaded" };
const QUOTA: HostError = { type: "provider.quota", status: 429, message: "Usage limit reached." };

function sig(stepKey: string, error: HostError, over: Partial<ProviderSignal> = {}): ProviderSignal {
  return {
    source: "retry-scheduled",
    sessionID: stepKey.split(":")[0] ?? "ses",
    stepKey,
    provider: "anthropic",
    error,
    at: new Date(T0).toISOString(),
    ...over,
  };
}

describe("capacity: placeholder", () => {
  it("builds", () => {
    const { c } = setup();
    expect(c.limit("anthropic")).toBe(8);
    expect(ExecutorError).toBeDefined();
    expect(pauseUntilFromMessage("", T0)).toBeNull();
    expect(capacityRestoreFromEvents([], { maxParallel: 8, nowMs: T0 })).toEqual({});
    const _types: Array<CapacityController | ExecutorEvent | TaskNode | TaskRoute | undefined> = [];
    expect(_types).toHaveLength(0);
    expect(typeof capacityView).toBe("function");
  });
});
