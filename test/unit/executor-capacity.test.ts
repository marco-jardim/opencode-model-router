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
  type MetricPayload,
  type ProviderSignal,
  type TaskNode,
  type TaskRoute,
} from "../../src/executor/types";

type ExecutorMetric = MetricPayload;

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

const changes = (metrics: readonly CapacityMetric[]): Array<[string, number, number]> =>
  metrics.map((m) => [m.change, m.from, m.to]);

describe("capacity: decrease", () => {
  it("starts every provider at maxParallel", () => {
    const { c } = setup({ maxParallel: 5 });
    expect(c.limit("anthropic")).toBe(5);
    expect(c.limit("openai")).toBe(5);
    expect(c.canAcquire("anthropic", false)).toBe(true);
    expect(c.pausedUntil("anthropic")).toBeNull();
  });

  it("one 429 halves 8 -> 4 and holds for the cooldown with a decrease metric", () => {
    const { c, metrics } = setup();
    const r = c.onSignal(sig("ses:1", RATE));
    expect(r).toEqual({ decreased: true, pausedUntil: null, inbox: null });
    expect(c.limit("anthropic")).toBe(4);
    expect(metrics).toEqual([
      {
        name: "capacity", provider: "anthropic", change: "decrease", from: 8, to: 4,
        until: new Date(T0 + COOLDOWN).toISOString(), errorType: "provider.rate-limit", status: 429,
      },
    ]);
  });

  it("an overload (529) decreases like a rate limit", () => {
    const { c, metrics } = setup();
    expect(c.onSignal(sig("ses:1", OVERLOAD)).decreased).toBe(true);
    expect(c.limit("anthropic")).toBe(4);
    expect(metrics[0]?.errorType).toBe("provider.internal");
    expect(metrics[0]?.status).toBe(529);
  });

  it("three signals on distinct steps go 4, 2, 1 and stop at the floor", () => {
    const { c } = setup();
    const seen: number[] = [];
    for (const k of ["a:1", "b:1", "c:1", "d:1"]) {
      c.onSignal(sig(k, RATE));
      seen.push(c.limit("anthropic"));
    }
    expect(seen).toEqual([4, 2, 1, 1]);
  });

  it("repeats of one step decrease once", () => {
    const { c, metrics } = setup();
    expect(c.onSignal(sig("ses:1", RATE)).decreased).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      expect(c.onSignal(sig("ses:1", RATE, { source: "retry-hook" }))).toEqual({
        decreased: false, pausedUntil: null, inbox: null,
      });
    }
    expect(c.onSignal(sig("ses:1", OVERLOAD, { source: "step-failed" })).decreased).toBe(false);
    expect(c.limit("anthropic")).toBe(4);
    expect(metrics).toHaveLength(1);
  });

  it("a first signal at the floor renews the hold and emits decrease 1 -> 1 with decreased: false", () => {
    const { c, clock, metrics } = setup({ maxParallel: 1 });
    expect(c.onSignal(sig("a:1", RATE))).toEqual({ decreased: false, pausedUntil: null, inbox: null });
    clock.advance(60_000);
    expect(c.onSignal(sig("b:1", RATE)).decreased).toBe(false);
    expect(changes(metrics)).toEqual([["decrease", 1, 1], ["decrease", 1, 1]]);
    expect(metrics[1]?.until).toBe(new Date(T0 + 60_000 + COOLDOWN).toISOString());
  });

  it("ignores errors that are neither rate-limit, overload nor quota", () => {
    const { c, metrics } = setup();
    const r = c.onSignal(sig("ses:1", { type: "provider.auth", status: 401, message: "no" }));
    expect(r).toEqual({ decreased: false, pausedUntil: null, inbox: null });
    expect(c.limit("anthropic")).toBe(8);
    expect(metrics).toEqual([]);
  });

  it("maps an unknown error type by status: 429 rate-limit, 529 overload", () => {
    const a = setup();
    expect(a.c.onSignal(sig("s:1", { type: "weird", status: 429, message: "x" })).decreased).toBe(true);
    expect(a.c.limit("anthropic")).toBe(4);
    const b = setup();
    expect(b.c.onSignal(sig("s:1", { type: "weird", status: 529, message: "x" })).decreased).toBe(true);
    expect(b.c.limit("anthropic")).toBe(4);
    const d = setup();
    expect(d.c.onSignal(sig("s:1", { type: "weird", status: 500, message: "x" })).decreased).toBe(false);
    expect(d.c.limit("anthropic")).toBe(8);
  });

  it("two providers are independent", () => {
    const { c } = setup();
    c.onSignal(sig("s:1", RATE, { provider: "anthropic" }));
    expect(c.limit("anthropic")).toBe(4);
    expect(c.limit("openai")).toBe(8);
    c.onSignal(sig("s:1", QUOTA, { provider: "openai" }));
    expect(c.pausedUntil("openai")).not.toBeNull();
    expect(c.pausedUntil("anthropic")).toBeNull();
    expect(c.canAcquire("anthropic", false)).toBe(true);
    expect(c.canAcquire("openai", false)).toBe(false);
    expect(c.limit("anthropic")).toBe(4);
    expect(c.limit("openai")).toBe(8);
  });
});

describe("capacity: recovery", () => {
  it("grows by 1 per qualifying success only after the cooldown, never during the hold", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:1", RATE));
    const t1 = c.acquire("anthropic", false, "t1", 1);
    clock.advance(COOLDOWN - 1);
    c.release(t1, "success");
    expect(c.limit("anthropic")).toBe(4);
    const t2 = c.acquire("anthropic", false, "t2", 1);
    clock.advance(1);
    c.release(t2, "success");
    expect(c.limit("anthropic")).toBe(5);
    const t3 = c.acquire("anthropic", false, "t3", 1);
    c.release(t3, "success");
    expect(c.limit("anthropic")).toBe(6);
    expect(changes(metrics)).toEqual([["decrease", 8, 4], ["increase", 4, 5], ["increase", 5, 6]]);
    expect(metrics[1]?.until).toBeNull();
  });

  it("is capped at maxParallel and a non-success release never grows", () => {
    const { c, clock, metrics } = setup({ maxParallel: 2 });
    c.onSignal(sig("s:1", RATE));
    expect(c.limit("anthropic")).toBe(1);
    clock.advance(COOLDOWN);
    c.release(c.acquire("anthropic", false, "t1", 1), "other");
    expect(c.limit("anthropic")).toBe(1);
    c.release(c.acquire("anthropic", false, "t2", 1), "success");
    expect(c.limit("anthropic")).toBe(2);
    c.release(c.acquire("anthropic", false, "t3", 1), "success");
    expect(c.limit("anthropic")).toBe(2);
    expect(changes(metrics)).toEqual([["decrease", 2, 1], ["increase", 1, 2]]);
  });

  it("a repeat of the step signal renews the quiet period without a second decrease", () => {
    const { c, clock } = setup();
    c.onSignal(sig("s:1", RATE));
    clock.advance(COOLDOWN - 1_000);
    c.onSignal(sig("s:1", RATE, { source: "retry-hook" }));
    clock.advance(1_000);
    c.release(c.acquire("anthropic", false, "t1", 1), "success");
    expect(c.limit("anthropic")).toBe(4);
    clock.advance(COOLDOWN - 1_000);
    c.release(c.acquire("anthropic", false, "t2", 1), "success");
    expect(c.limit("anthropic")).toBe(5);
  });

  it("a success of a token acquired before the signal does not grow the limit", () => {
    const { c, clock } = setup();
    const old = c.acquire("anthropic", false, "old", 1);
    clock.advance(1_000);
    c.onSignal(sig("s:1", RATE));
    clock.advance(COOLDOWN + 1);
    c.release(old, "success");
    expect(c.limit("anthropic")).toBe(4);
    c.release(c.acquire("anthropic", false, "new", 1), "success");
    expect(c.limit("anthropic")).toBe(5);
  });

  it("release is idempotent and ignores unknown ids", () => {
    const { c } = setup({ maxParallel: 1 });
    const t = c.acquire("anthropic", false, "t1", 1);
    expect(c.canAcquire("anthropic", false)).toBe(false);
    c.release(t, "other");
    c.release(t, "other");
    c.release({ id: "nope" }, "success");
    expect(c.canAcquire("anthropic", false)).toBe(true);
    c.acquire("anthropic", false, "t2", 1);
    expect(c.canAcquire("anthropic", false)).toBe(false);
  });
});

describe("capacity: pause", () => {
  const RESET = "2026-10-12T12:00:00Z";
  const resetMs = Date.parse(RESET);

  it("a quota without a future instant pauses for pauseMs and raises one usage-limit inbox item", () => {
    const { c, metrics } = setup();
    const until = new Date(T0 + PAUSE).toISOString();
    const r = c.onSignal(sig("s:1", QUOTA));
    expect(r.decreased).toBe(false);
    expect(r.pausedUntil).toBe(until);
    expect(r.inbox).toEqual({
      kind: "usage-limit",
      severity: "info",
      taskId: null,
      text: `provider anthropic paused until ${until} (provider.quota)`,
      options: [],
    });
    expect(c.pausedUntil("anthropic")).toBe(until);
    expect(c.limit("anthropic")).toBe(8);
    expect(c.canAcquire("anthropic", false)).toBe(false);
    expect(() => c.acquire("anthropic", false, "t1", 1)).toThrow(ExecutorError);
    expect(metrics).toEqual([
      { name: "capacity", provider: "anthropic", change: "pause", from: 8, to: 8, until, errorType: "provider.quota", status: 429 },
    ]);
  });

  it("a quota with a future ISO instant pauses until it", () => {
    const { c } = setup();
    const r = c.onSignal(sig("s:1", { ...QUOTA, message: `Usage limit reached. Your limit will reset at ${RESET}.` }));
    expect(r.pausedUntil).toBe(new Date(resetMs).toISOString());
  });

  it("extends the pause for a later instant without a second inbox item, and ignores an earlier one", () => {
    const { c, clock, metrics } = setup();
    expect(c.onSignal(sig("s:1", QUOTA)).inbox).not.toBeNull();
    clock.advance(1_000);
    const ext = c.onSignal(sig("s:2", { ...QUOTA, message: `reset ${RESET}` }));
    expect(ext).toEqual({ decreased: false, pausedUntil: new Date(resetMs).toISOString(), inbox: null });
    expect(c.pausedUntil("anthropic")).toBe(new Date(resetMs).toISOString());
    const shorter = c.onSignal(sig("s:3", QUOTA));
    expect(shorter).toEqual({ decreased: false, pausedUntil: new Date(resetMs).toISOString(), inbox: null });
    expect(changes(metrics)).toEqual([["pause", 8, 8], ["pause", 8, 8]]);
    expect(metrics[1]?.until).toBe(new Date(resetMs).toISOString());
  });

  it("resumes lazily at the pause end with a resume metric and an unchanged limit", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:0", RATE));
    c.onSignal(sig("s:1", QUOTA));
    clock.advance(PAUSE - 1);
    expect(c.canAcquire("anthropic", false)).toBe(false);
    clock.advance(1);
    expect(c.canAcquire("anthropic", false)).toBe(true);
    expect(c.pausedUntil("anthropic")).toBeNull();
    expect(c.limit("anthropic")).toBe(4);
    expect(changes(metrics)).toEqual([["decrease", 8, 4], ["pause", 4, 4], ["resume", 4, 4]]);
    expect(metrics[2]?.until).toBeNull();
    // A new quota after the resume starts a new pause and raises a new inbox item.
    expect(c.onSignal(sig("s:2", QUOTA)).inbox).not.toBeNull();
  });

  it("no growth while paused", () => {
    const { c, clock } = setup();
    c.onSignal(sig("s:0", RATE));
    const t = c.acquire("anthropic", false, "t1", 1);
    clock.advance(COOLDOWN);
    c.onSignal(sig("s:1", QUOTA));
    c.release(t, "success");
    expect(c.limit("anthropic")).toBe(4);
  });

  it("a rate-limit signal during a pause reports the pause end", () => {
    const { c } = setup();
    const p = c.onSignal(sig("s:1", QUOTA)).pausedUntil;
    expect(c.onSignal(sig("s:2", RATE)).pausedUntil).toBe(p);
  });
});

describe("capacity: pauseUntilFromMessage", () => {
  it("returns the first future zoned instant", () => {
    const now = Date.parse("2026-10-12T10:00:00Z");
    expect(pauseUntilFromMessage("reset at 2026-10-12T12:00:00Z ok", now)).toBe(Date.parse("2026-10-12T12:00:00Z"));
    expect(pauseUntilFromMessage("at 2026-10-12T13:00+02:00", now)).toBe(Date.parse("2026-10-12T13:00+02:00"));
    expect(pauseUntilFromMessage("at 2026-10-12T12:00:00.500+02:00", now)).toBe(Date.parse("2026-10-12T12:00:00.500+02:00"));
  });

  it("skips past instants and takes the first future one", () => {
    const now = Date.parse("2026-10-12T10:00:00Z");
    expect(pauseUntilFromMessage("was 2026-10-11T12:00:00Z, now 2026-10-13T00:00:00Z", now)).toBe(
      Date.parse("2026-10-13T00:00:00Z"),
    );
  });

  it("ignores past, zoneless and absent instants", () => {
    const now = Date.parse("2026-10-12T10:00:00Z");
    expect(pauseUntilFromMessage("2026-10-11T12:00:00Z", now)).toBeNull();
    expect(pauseUntilFromMessage("2026-10-12T10:00:00Z", now)).toBeNull();
    expect(pauseUntilFromMessage("reset at 2026-10-13T12:00:00", now)).toBeNull();
    expect(pauseUntilFromMessage("Usage limit reached.", now)).toBeNull();
  });

  it("a quota with only a past or zoneless instant uses pauseMs", () => {
    const { c } = setup();
    const r = c.onSignal(sig("s:1", { ...QUOTA, message: "reset 2026-10-11T00:00:00Z or 2026-10-13T00:00:00" }));
    expect(r.pausedUntil).toBe(new Date(T0 + PAUSE).toISOString());
  });
});

describe("capacity: shouldStopRetry", () => {
  const stop = (c: CapacityController, stepKey: string, planChild: boolean, provider = "anthropic"): boolean =>
    c.shouldStopRetry({ sessionID: stepKey.split(":")[0] ?? "ses", stepKey, provider, planChild });

  it("is true for a plan child while the provider is paused, with one retry-stop metric per step", () => {
    const { c, metrics } = setup();
    c.onSignal(sig("s:1", QUOTA));
    expect(stop(c, "s:1", true)).toBe(true);
    expect(stop(c, "s:1", true)).toBe(true);
    expect(stop(c, "s:2", true)).toBe(true);
    const stops = metrics.filter((m) => m.change === "retry-stop");
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({
      name: "capacity", provider: "anthropic", change: "retry-stop", from: 8, to: 8, until: null, errorType: null, status: null,
    });
  });

  it("is true for a plan child once the first signal of the step is older than the cooldown", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:1", RATE));
    expect(stop(c, "s:1", true)).toBe(false);
    clock.advance(COOLDOWN);
    expect(stop(c, "s:1", true)).toBe(false);
    clock.advance(1);
    expect(stop(c, "s:1", true)).toBe(true);
    expect(stop(c, "s:1", true)).toBe(true);
    expect(changes(metrics)).toEqual([["decrease", 8, 4], ["retry-stop", 4, 4]]);
  });

  it("repeats of the step do not refresh its age", () => {
    const { c, clock } = setup();
    c.onSignal(sig("s:1", RATE));
    clock.advance(COOLDOWN);
    c.onSignal(sig("s:1", RATE, { source: "retry-hook" }));
    clock.advance(1);
    expect(stop(c, "s:1", true)).toBe(true);
  });

  it("is false for planChild: false, even when paused or old, and emits nothing", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:1", RATE));
    c.onSignal(sig("s:2", QUOTA));
    clock.advance(COOLDOWN + 1);
    const before = metrics.length;
    expect(stop(c, "s:1", false)).toBe(false);
    expect(stop(c, "s:2", false)).toBe(false);
    expect(metrics).toHaveLength(before);
  });

  it("is false for a plan child with no signal on the step and no pause", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:1", RATE));
    clock.advance(COOLDOWN + 1);
    expect(stop(c, "s:9", true)).toBe(false);
    expect(stop(c, "s:9", true, "openai")).toBe(false);
    expect(metrics).toHaveLength(1);
  });

  it("a pause of another provider does not stop this one", () => {
    const { c } = setup();
    c.onSignal(sig("s:1", QUOTA, { provider: "openai" }));
    expect(stop(c, "s:1", true, "anthropic")).toBe(false);
    expect(stop(c, "s:1", true, "openai")).toBe(true);
  });
});

describe("capacity: heavy cap, force and the view", () => {
  const route: TaskRoute = {
    agent: "a", model: { providerID: "anthropic", modelID: "m", variant: null }, provider: "anthropic", heavy: false,
  };
  const routes = { route: (): TaskRoute => route };

  it("caps heavy children per provider at 2", () => {
    const { c } = setup();
    const view = capacityView(c, routes);
    expect(view.free("anthropic", false)).toBe(8);
    expect(view.free("anthropic", true)).toBe(2);
    c.acquire("anthropic", true, "h1", 1);
    c.acquire("anthropic", true, "h2", 1);
    expect(c.canAcquire("anthropic", true)).toBe(false);
    expect(c.canAcquire("anthropic", false)).toBe(true);
    expect(view.free("anthropic", true)).toBe(0);
    expect(view.free("anthropic", false)).toBe(6);
    let err: unknown;
    try {
      c.acquire("anthropic", true, "h3", 1);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExecutorError);
    expect((err as ExecutorError).code).toBe("E_CAPACITY");
    // Another provider has its own heavy cap.
    expect(c.canAcquire("openai", true)).toBe(true);
  });

  it("the heavy cap is min(cap, limit) and follows a lowered limit", () => {
    const { c } = setup({ maxParallel: 2 });
    const view = capacityView(c, routes);
    expect(view.free("anthropic", true)).toBe(2);
    c.onSignal(sig("s:1", RATE));
    expect(c.limit("anthropic")).toBe(1);
    expect(view.free("anthropic", true)).toBe(1);
    c.acquire("anthropic", true, "h1", 1);
    expect(c.canAcquire("anthropic", true)).toBe(false);
  });

  it("honours a custom heavyCap", () => {
    const { c } = setup({ heavyCap: 1 });
    c.acquire("anthropic", true, "h1", 1);
    expect(c.canAcquire("anthropic", true)).toBe(false);
    expect(c.canAcquire("anthropic", false)).toBe(true);
  });

  it("a lowered limit never preempts: acquires wait until used < limit", () => {
    const { c } = setup();
    const view = capacityView(c, routes);
    const tokens = [1, 2, 3, 4, 5, 6].map((n) => c.acquire("anthropic", false, `t${n}`, 1));
    c.onSignal(sig("s:1", RATE));
    expect(c.limit("anthropic")).toBe(4);
    expect(view.free("anthropic", false)).toBe(0);
    expect(c.canAcquire("anthropic", false)).toBe(false);
    c.release(tokens[0] as { id: string }, "other");
    c.release(tokens[1] as { id: string }, "other");
    c.release(tokens[2] as { id: string }, "other");
    expect(view.free("anthropic", false)).toBe(1);
    expect(c.canAcquire("anthropic", false)).toBe(true);
  });

  it("force acquires past the limit and during a pause, never throwing E_CAPACITY", () => {
    const { c } = setup({ maxParallel: 1 });
    const view = capacityView(c, routes);
    const a = c.acquire("anthropic", false, "t1", 1);
    expect(() => c.acquire("anthropic", false, "t2", 1)).toThrow(ExecutorError);
    const b = c.acquire("anthropic", false, "t2", 1, { force: true });
    expect(view.free("anthropic", false)).toBe(0);
    c.onSignal(sig("s:1", QUOTA));
    const d = c.acquire("anthropic", true, "t3", 1, { force: true });
    expect(new Set([a.id, b.id, d.id]).size).toBe(3);
    c.release(a, "other");
    c.release(b, "other");
    c.release(d, "other");
    c.release(d, "other");
    expect(c.canAcquire("anthropic", false)).toBe(false); // still paused
    expect(view.free("anthropic", false)).toBe(0);
  });

  it("the view answers canAcquire ? 1 : 0 for a controller not built here", () => {
    let open = true;
    const foreign: CapacityController = {
      limit: () => 3,
      canAcquire: () => open,
      acquire: () => ({ id: "x" }),
      release: () => undefined,
      onSignal: () => ({ decreased: false, pausedUntil: null, inbox: null }),
      shouldStopRetry: () => false,
      pausedUntil: () => null,
      snapshot: () => null,
    };
    const view = capacityView(foreign, routes);
    expect(view.free("p", false)).toBe(1);
    open = false;
    expect(view.free("p", true)).toBe(0);
  });

  it("snapshot reports the options and per-provider counters", () => {
    const { c } = setup({ maxParallel: 4 });
    c.acquire("anthropic", true, "h1", 1);
    c.onSignal(sig("s:1", RATE));
    expect(c.snapshot()).toEqual({
      maxParallel: 4, heavyCap: 2, cooldownMs: COOLDOWN, pauseMs: PAUSE, tokens: 1,
      providers: {
        anthropic: {
          limit: 2, used: 1, heavyUsed: 1, holdUntil: new Date(T0 + COOLDOWN).toISOString(),
          lastSignalAt: new Date(T0).toISOString(), pausedUntil: null,
        },
      },
    });
  });
});

describe("capacity: metrics", () => {
  it("emits one capacity metric per change, in order", () => {
    const { c, clock, metrics } = setup();
    c.onSignal(sig("s:1", RATE)); // decrease 8 -> 4
    c.onSignal(sig("s:1", RATE)); // repeat: nothing
    c.release(c.acquire("anthropic", false, "t0", 1), "success"); // inside the hold: nothing
    clock.advance(COOLDOWN);
    c.release(c.acquire("anthropic", false, "t1", 1), "success"); // increase 4 -> 5
    c.onSignal(sig("s:2", QUOTA)); // pause
    c.shouldStopRetry({ sessionID: "s", stepKey: "s:3", provider: "anthropic", planChild: true }); // retry-stop
    clock.advance(PAUSE);
    c.limit("anthropic"); // resume
    expect(changes(metrics)).toEqual([
      ["decrease", 8, 4], ["increase", 4, 5], ["pause", 5, 5], ["retry-stop", 5, 5], ["resume", 5, 5],
    ]);
    expect(metrics.every((m) => m.name === "capacity" && m.provider === "anthropic")).toBe(true);
    expect(metrics.map((m) => m.until)).toEqual([
      new Date(T0 + COOLDOWN).toISOString(), null, new Date(T0 + COOLDOWN + PAUSE).toISOString(), null, null,
    ]);
  });

  it("onMetric errors propagate, after the state change", () => {
    const { c } = setup({
      onMetric: () => {
        throw new Error("sink failed");
      },
    });
    expect(() => c.onSignal(sig("s:1", RATE))).toThrow("sink failed");
    expect(c.limit("anthropic")).toBe(4);
  });
});

function metricEvent(seq: number, atMs: number, metric: ExecutorMetric): ExecutorEvent {
  return { seq, at: new Date(atMs).toISOString(), batch: seq, last: true, type: "metric", metric };
}

function capMetric(
  change: CapacityMetric["change"], from: number, to: number, until: number | null, provider = "anthropic",
): ExecutorMetric {
  return {
    name: "capacity", provider, change, from, to, until: until === null ? null : new Date(until).toISOString(),
    errorType: null, status: null,
  };
}

describe("capacity: restore", () => {
  const history: ExecutorEvent[] = [
    metricEvent(1, T0, capMetric("decrease", 8, 4, T0 + COOLDOWN)),
    metricEvent(2, T0 + 1_000, capMetric("decrease", 4, 2, T0 + 1_000 + COOLDOWN)),
    metricEvent(3, T0 + 2_000, capMetric("pause", 2, 2, T0 + PAUSE)),
    metricEvent(4, T0 + 2_500, { name: "counter", key: "k", value: 1, labels: {} }),
    metricEvent(5, T0 + 3_000, capMetric("decrease", 8, 4, T0 + 3_000 + COOLDOWN, "openai")),
  ];

  it("replays the last limit and a still-future hold and pause per provider", () => {
    const r = capacityRestoreFromEvents(history, { maxParallel: 8, nowMs: T0 + 4_000 });
    expect(r).toEqual({
      anthropic: { limit: 2, holdUntilMs: T0 + 1_000 + COOLDOWN, lastSignalAtMs: T0 + 1_000, pausedUntilMs: T0 + PAUSE },
      openai: { limit: 4, holdUntilMs: T0 + 3_000 + COOLDOWN, lastSignalAtMs: T0 + 3_000, pausedUntilMs: null },
    });
  });

  it("drops an elapsed hold and an elapsed pause but keeps the limit", () => {
    const r = capacityRestoreFromEvents(history, { maxParallel: 8, nowMs: T0 + PAUSE + COOLDOWN });
    expect(r.anthropic).toEqual({ limit: 2, holdUntilMs: 0, lastSignalAtMs: null, pausedUntilMs: null });
    expect(r.openai).toEqual({ limit: 4, holdUntilMs: 0, lastSignalAtMs: null, pausedUntilMs: null });
  });

  it("a resume clears the pause, an increase moves the limit, the limit is clamped to maxParallel", () => {
    const events = [
      metricEvent(1, T0, capMetric("pause", 8, 8, T0 + PAUSE)),
      metricEvent(2, T0 + 1_000, capMetric("resume", 8, 8, null)),
      metricEvent(3, T0 + 2_000, capMetric("decrease", 8, 2, T0 + 2_000 + COOLDOWN)),
      metricEvent(4, T0 + 3_000 + COOLDOWN, capMetric("increase", 2, 3, null)),
    ];
    const r = capacityRestoreFromEvents(events, { maxParallel: 8, nowMs: T0 + 4_000 });
    expect(r.anthropic?.pausedUntilMs).toBeNull();
    expect(r.anthropic?.limit).toBe(3);
    expect(capacityRestoreFromEvents(events, { maxParallel: 2, nowMs: T0 + 4_000 }).anthropic?.limit).toBe(2);
  });

  it("returns an empty record when there is no capacity history", () => {
    expect(capacityRestoreFromEvents([], { maxParallel: 8, nowMs: T0 })).toEqual({});
    expect(capacityRestoreFromEvents([history[3] as ExecutorEvent], { maxParallel: 8, nowMs: T0 })).toEqual({});
  });

  it("seeds a controller: limit, pause, hold and lazy resume", () => {
    const restore = capacityRestoreFromEvents(history, { maxParallel: 8, nowMs: T0 + 4_000 });
    const { c, clock, metrics } = setup({ restore });
    clock.advance(4_000);
    expect(c.limit("anthropic")).toBe(2);
    expect(c.limit("openai")).toBe(4);
    expect(c.limit("other")).toBe(8);
    expect(c.pausedUntil("anthropic")).toBe(new Date(T0 + PAUSE).toISOString());
    expect(c.canAcquire("anthropic", false)).toBe(false);
    clock.set(T0 + PAUSE);
    expect(c.canAcquire("anthropic", false)).toBe(true);
    expect(changes(metrics)).toEqual([["resume", 2, 2]]);
  });

  it("a restored hold blocks growth until it ends", () => {
    const restore = { anthropic: { limit: 2, holdUntilMs: T0 + COOLDOWN, lastSignalAtMs: T0, pausedUntilMs: null } };
    const { c, clock } = setup({ restore });
    clock.advance(COOLDOWN - 1);
    c.release(c.acquire("anthropic", false, "t1", 1), "success");
    expect(c.limit("anthropic")).toBe(2);
    clock.advance(1);
    c.release(c.acquire("anthropic", false, "t2", 1), "success");
    expect(c.limit("anthropic")).toBe(3);
  });

  it("round trip: a controller's own metrics restore its state", () => {
    const a = setup();
    a.c.onSignal(sig("s:1", RATE));
    a.c.onSignal(sig("s:2", QUOTA));
    const events = a.metrics.map((m, i) => metricEvent(i + 1, T0, m));
    const r = capacityRestoreFromEvents(events, { maxParallel: 8, nowMs: T0 + 1_000 });
    expect(r.anthropic).toEqual({
      limit: 4, holdUntilMs: T0 + COOLDOWN, lastSignalAtMs: T0, pausedUntilMs: T0 + PAUSE,
    });
  });
});

function taskNode(id: string): TaskNode {
  return {
    id,
    title: id,
    phase: null,
    kind: "task",
    text: "",
    subtasks: [],
    route: { line: "", role: "builder", tier: null, pin: false },
    verify: "none",
    acceptance: null,
    footprint: { writes: [], reads: [], confidence: "unknown", sources: [] },
    estimate: { p50: 0, p90: 0, source: "test" },
    state: "ready",
    attempts: [],
    slot: null,
    branch: null,
    integrated: null,
  };
}

describe("capacity: view routeOf", () => {
  it("memoizes the route per task id and free follows the controller", () => {
    const { c } = setup({ maxParallel: 3 });
    const calls: string[] = [];
    const view = capacityView(c, {
      route: (t) => {
        calls.push(t.id);
        return { agent: "a", model: { providerID: "anthropic", modelID: "m", variant: null }, provider: "anthropic", heavy: false };
      },
    });
    const first = view.routeOf(taskNode("T1"));
    expect(view.routeOf(taskNode("T1"))).toBe(first);
    view.routeOf(taskNode("T2"));
    expect(calls).toEqual(["T1", "T2"]);
    expect(view.free("anthropic", false)).toBe(3);
    c.acquire("anthropic", false, "T1", 1);
    expect(view.free("anthropic", false)).toBe(2);
    // A fresh view re-resolves.
    capacityView(c, { route: (t) => (calls.push(t.id), first) }).routeOf(taskNode("T1"));
    expect(calls).toEqual(["T1", "T2", "T1"]);
  });
});
