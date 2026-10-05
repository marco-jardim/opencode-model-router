import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDepthTracker,
  DEFAULT_DEPTH_MAX_ENTRIES,
  DEFAULT_DEPTH_TIMEOUT_MS,
  DEPTH_LOOKUP_RETRY_MS,
  MAX_DEPTH_HOPS,
  type DepthTracker,
} from "../../src/router/depth";
import { DEFAULT_IDLE_TTL_MS } from "../../src/router/idle-sweep";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let time = 0;
  const getParent = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null);
  const warn = vi.fn();
  const tracker = createDepthTracker({ getParent, now: () => time, logger: { warn } }, options);
  return { tracker, getParent, warn, time: (value: number) => { time = value; } };
}

function chain(tracker: DepthTracker, depth: number, prefix = "n") {
  tracker.recordRoot(`${prefix}0`);
  for (let i = 1; i <= depth; i++) tracker.recordCreated(`${prefix}${i}`, `${prefix}${i - 1}`);
}

// Flush lookup creation without advancing the deadline.
async function started() { await Promise.resolve(); await Promise.resolve(); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("delegation depth evidence", () => {
  it.each([0, 1, 2, 5, 31, 32, 33, 40])("T-created-known / T-hops: recorded chain of %i edges", async (depth) => {
    const { tracker, getParent } = fixture();
    chain(tracker, depth);
    expect(await tracker.depthOf(`n${depth}`)).toBe(Math.min(depth, MAX_DEPTH_HOPS));
    expect(getParent).not.toHaveBeenCalled();
  });

  it.each([1, 2, 5, 31, 32, 33, 40])("T-g2 / T-hops: backend chain of %i edges is memoized", async (depth) => {
    const { tracker, getParent } = fixture();
    getParent.mockImplementation(async (id) => Number(id) === 0 ? null : String(Number(id) - 1));
    expect(await tracker.depthOf(String(depth))).toBe(Math.min(depth, MAX_DEPTH_HOPS));
    const count = getParent.mock.calls.length;
    expect(count).toBeLessThanOrEqual(34);
    expect(await tracker.depthOf(String(depth))).toBe(Math.min(depth, MAX_DEPTH_HOPS));
    expect(getParent).toHaveBeenCalledTimes(count);
    expect(new Set(getParent.mock.calls.map(([id]) => id)).size).toBe(count);
  });

  it("T-ooo: resolves grandchild, child, root without lookup", async () => {
    const { tracker, getParent } = fixture();
    tracker.recordCreated("G", "C");
    tracker.recordCreated("C", "R");
    tracker.recordRoot("R");
    expect(await tracker.depthOf("G")).toBe(2);
    expect(await tracker.depthOf("C")).toBe(1);
    expect(getParent).not.toHaveBeenCalled();
  });

  it("T-created-unknown: placeholders are not nodes and only the parent is fetched", async () => {
    const { tracker, getParent } = fixture();
    tracker.recordCreated("C", "P");
    expect(tracker.size()).toBe(1);
    expect(await tracker.depthOf("C")).toBe(1);
    expect(await tracker.depthOf("C")).toBe(1);
    expect(getParent.mock.calls).toEqual([["P"]]);
  });

  it.each([false, true])("T-conflict-raise / T-mono: both root/link orders (%s)", async (reverse) => {
    const { tracker, getParent, warn } = fixture();
    chain(tracker, 2);
    if (reverse) tracker.recordCreated("X", "n2");
    tracker.recordRoot("X");
    tracker.recordCreated("C", "X");
    expect(await tracker.depthOf("C")).toBe(reverse ? 4 : 1);
    tracker.recordCreated("X", "n2");
    tracker.recordCreated("X", null);
    tracker.recordRoot("X");
    expect(await tracker.depthOf("X")).toBe(3);
    expect(await tracker.depthOf("C")).toBe(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(getParent).not.toHaveBeenCalled();
  });

  it.each([false, true])("T-cycle: recorded self/two-node cycles terminate (%s)", async (self) => {
    const { tracker, getParent } = fixture();
    tracker.recordCreated("A", self ? "A" : "B");
    if (!self) tracker.recordCreated("B", "A");
    expect(await tracker.depthOf("A")).toBe(MAX_DEPTH_HOPS);
    expect(await tracker.depthOf("A")).toBe(MAX_DEPTH_HOPS);
    expect(getParent).not.toHaveBeenCalled();
  });

  it("T-cycle: backend loop is capped and memoized", async () => {
    const { tracker, getParent } = fixture();
    getParent.mockImplementation(async (id) => id === "A" ? "B" : "A");
    expect(await tracker.depthOf("A")).toBe(MAX_DEPTH_HOPS);
    expect(await tracker.depthOf("B")).toBe(MAX_DEPTH_HOPS);
    expect(getParent).toHaveBeenCalledTimes(2);
  });

  it("T-plugin / T-plugin-v1: anchors, known and unknown creators never fetch the child", async () => {
    const { tracker, getParent, warn } = fixture();
    chain(tracker, 3);
    tracker.recordPluginChild("anchor", null);
    tracker.recordPluginChild("known", "n3");
    tracker.recordPluginChild("unknown", "creator");
    tracker.recordRoot("anchor");
    tracker.recordCreated("known", null);
    tracker.recordPluginChild("anchor", null);
    tracker.recordPluginChild("known", "n3");
    tracker.recordCreated("known", "n0");
    expect(await tracker.depthOf("anchor")).toBe(1);
    expect(await tracker.depthOf("known")).toBe(4);
    expect(await tracker.depthOf("unknown")).toBe(1);
    expect(getParent.mock.calls).toEqual([["creator"]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("T-plugin: promotes a root to an anchor and permits a later creator link", async () => {
    const { tracker, warn } = fixture();
    tracker.recordRoot("X");
    tracker.recordPluginChild("X", null);
    expect(await tracker.depthOf("X")).toBe(1);
    chain(tracker, 2);
    tracker.recordPluginChild("X", "n2");
    expect(await tracker.depthOf("X")).toBe(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("T-warn: distinct parents keep the maximum, duplicates do not overflow, fifth link caps", async () => {
    const { tracker, warn } = fixture();
    chain(tracker, 4);
    for (let i = 0; i < 4; i++) {
      tracker.recordCreated("X", `n${i}`);
      tracker.recordCreated("X", `n${i}`);
    }
    expect(await tracker.depthOf("X")).toBe(4);
    tracker.recordCreated("X", "n4");
    expect(await tracker.depthOf("X")).toBe(MAX_DEPTH_HOPS);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("T-input: invalid runtime ids and parents never throw or create nodes", async () => {
    const { tracker, getParent } = fixture();
    for (const raw of ["", undefined, null, 4, {}, []]) {
      // Deliberately exercise JavaScript callers through the public TS boundary.
      const id = raw as string;
      tracker.recordRoot(id);
      tracker.recordCreated(id, "P");
      tracker.recordPluginChild(id, "P");
      tracker.forget(id);
      expect(await tracker.depthOf(id)).toBeUndefined();
    }
    for (const raw of [3, {}, []]) tracker.recordCreated("X", raw as string);
    expect(tracker.size()).toBe(0);
    expect(getParent).not.toHaveBeenCalled();
    for (const [i, raw] of [null, undefined, ""].entries()) {
      tracker.recordCreated(`root${i}`, raw as string | null);
      expect(await tracker.depthOf(`root${i}`)).toBe(0);
    }
    for (const [i, raw] of [null, undefined, "", 3, {}, "self5"].entries()) {
      tracker.recordPluginChild(`self${i}`, raw as string | null);
      expect(await tracker.depthOf(`self${i}`)).toBe(1);
    }
  });

  it("T-imports: only idle-sweep is imported", () => {
    const source = readFileSync(new URL("../../src/router/depth.ts", import.meta.url), "utf8");
    expect([...source.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1])).toEqual(["./idle-sweep"]);
  });
});

describe("lookup lifetimes", () => {
  it("T-flight: 100 callers share one walk, including every ancestor", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture();
    getParent.mockImplementation(async (id) => id === "X" ? "P" : null);
    const results = await Promise.all(Array.from({ length: 100 }, () => tracker.depthOf("X")));
    expect(results).toEqual(Array(100).fill(1));
    expect(getParent.mock.calls).toEqual([["X"], ["P"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T-flight: different walks share a missing ancestor", async () => {
    const { tracker, getParent } = fixture();
    const parent = deferred<string | null>();
    getParent.mockReturnValue(parent.promise);
    tracker.recordCreated("X", "A");
    tracker.recordCreated("Y", "A");
    const x = tracker.depthOf("X");
    const y = tracker.depthOf("Y");
    await started();
    parent.resolve(null);
    expect(await Promise.all([x, y])).toEqual([1, 1]);
    expect(getParent.mock.calls).toEqual([["A"]]);
  });

  it.each([new Error("offline"), "non-Error rejection"])("T-throttle: %s warns once and retries at precisely 30s", async (error) => {
    vi.useFakeTimers();
    const { tracker, getParent, warn, time } = fixture();
    getParent.mockRejectedValueOnce(error).mockResolvedValue(null);
    expect(await tracker.depthOf("X")).toBeUndefined();
    time(29_999);
    expect(await tracker.depthOf("X")).toBeUndefined();
    expect(getParent).toHaveBeenCalledTimes(1);
    time(30_000);
    expect(await tracker.depthOf("X")).toBe(0);
    expect(getParent).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("T-throttle: sync throws and backwards clocks allow recovery", async () => {
    const { tracker, getParent, time } = fixture();
    time(100);
    getParent.mockImplementationOnce(() => { throw new Error("sync"); });
    expect(await tracker.depthOf("X")).toBeUndefined();
    time(99);
    expect(await tracker.depthOf("X")).toBe(0);
    expect(getParent).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "", 4, {}])("malformed backend answer %j is not root evidence", async (raw) => {
    const { tracker, getParent, warn } = fixture();
    getParent.mockResolvedValue(raw as string);
    expect(await tracker.depthOf("X")).toBeUndefined();
    expect(tracker.size()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed answer"));
  });

  it("F1: failures and throttle preserve the known floor, including plugins", async () => {
    const { tracker, getParent, warn } = fixture();
    getParent.mockRejectedValue("offline");
    tracker.recordPluginChild("X", "P");
    tracker.recordCreated("C", "X");
    expect(await tracker.depthOf("C")).toBe(2);
    expect(await tracker.depthOf("C")).toBe(2);
    expect(await tracker.depthOf("X")).toBe(1);
    expect(getParent.mock.calls).toEqual([["P"]]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("T-timeout / T-detach / T-late-fail: late settlement (%s)", async (succeed) => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { tracker, getParent, warn, time } = fixture();
      const pending = deferred<string | null>();
      getParent.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
      const result = tracker.depthOf("X", { timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await result).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      time(29_999);
      expect(await tracker.depthOf("X")).toBeUndefined();
      if (!succeed) {
        pending.reject("late failure");
        await vi.advanceTimersByTimeAsync(0);
      }
      time(30_000);
      expect(await tracker.depthOf("X")).toBe(0);
      expect(getParent).toHaveBeenCalledTimes(2);
      if (succeed) {
        tracker.recordCreated("P", "R");
        tracker.recordRoot("R");
        pending.resolve("P");
        await vi.advanceTimersByTimeAsync(0);
        expect(await tracker.depthOf("X")).toBe(2);
      }
      expect(warn.mock.calls.filter(([message]) => message.includes("cannot resolve"))).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("T-timeout: shared callers have independent deadlines and retain floors", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValue(pending.promise);
    tracker.recordCreated("X", "P");
    const early = tracker.depthOf("X", { timeoutMs: 5 });
    const late = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await early).toBe(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(await late).toBe(1);
    pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 0, -1, Infinity, NaN])("invalid/default timeout %s uses the default", async (timeoutMs) => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture();
    getParent.mockReturnValue(new Promise(() => {}));
    const result = tracker.depthOf("X", { timeoutMs });
    await vi.advanceTimersByTimeAsync(DEFAULT_DEPTH_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["root", "parent", "failure"])("T-midwalk / T-mono: event before backend %s", async (answer) => {
    const { tracker, getParent, warn } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValue(pending.promise);
    chain(tracker, 2);
    const result = tracker.depthOf("X");
    await started();
    tracker.recordCreated("X", "n2");
    if (answer === "failure") pending.reject("offline");
    else pending.resolve(answer === "root" ? null : "n0");
    expect(await result).toBe(3);
    expect(warn).toHaveBeenCalledTimes(answer === "failure" ? 0 : 1);
    expect(getParent.mock.calls).toEqual([["X"]]);
  });

  it("T-midwalk: a missing parent is learned during the await", async () => {
    const { tracker, getParent, warn } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValue(pending.promise);
    tracker.recordCreated("X", "P");
    const result = tracker.depthOf("X");
    await started();
    tracker.recordCreated("P", "R");
    tracker.recordRoot("R");
    pending.reject("gap filled");
    expect(await result).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("T-forget: cancels a hung queried lookup promptly and discards its late answer", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    const result = tracker.depthOf("X");
    await started();
    tracker.forget("X");
    expect(await result).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve("P");
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.size()).toBe(0);
    expect(await tracker.depthOf("X")).toBe(0);
    expect(getParent).toHaveBeenCalledTimes(2);
  });

  it("T-forget: cancelling a shared ancestor settles descendants at their floors without throttle", async () => {
    const { tracker, getParent } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValueOnce(pending.promise).mockResolvedValue(null);
    tracker.recordCreated("X", "P");
    const result = tracker.depthOf("X");
    await started();
    tracker.forget("P");
    expect(await result).toBe(1);
    expect(await tracker.depthOf("X")).toBe(1);
    pending.reject("discard me");
    await started();
    expect(getParent.mock.calls).toEqual([["P"], ["P"]]);
  });

  it("T-forget: cancelling a walk waiting on another id does not resurrect the start", async () => {
    const { tracker, getParent } = fixture();
    const pending = deferred<string | null>();
    getParent.mockReturnValue(pending.promise);
    tracker.recordCreated("X", "P");
    const result = tracker.depthOf("X");
    await started();
    tracker.forget("X");
    expect(await result).toBeUndefined();
    pending.resolve(null);
    await started();
    await started();
    expect(tracker.size()).toBe(1);
    expect(await tracker.depthOf("P")).toBe(0);
  });
});

describe("eviction and bookkeeping", () => {
  it.each([1, 3])("an active walk retains event evidence across backend insertion with %i slots", async (maxEntries) => {
    const { tracker, getParent } = fixture({ maxEntries });
    tracker.recordCreated("X", "P");
    for (let i = 1; i < maxEntries; i++) tracker.recordRoot(`other${i}`);
    expect(await tracker.depthOf("X")).toBe(1);
    expect(getParent.mock.calls).toEqual([["P"]]);
    expect(tracker.size()).toBeLessThanOrEqual(maxEntries);
  });

  it("active walk snapshots preserve every conflicting parent across eviction", async () => {
    const { tracker, getParent } = fixture({ maxEntries: 1 });
    tracker.recordCreated("X", "P");
    tracker.recordCreated("X", "Q");
    getParent.mockImplementation(async (id) => id === "Q" ? "R" : null);
    expect(await tracker.depthOf("X")).toBe(2);
    expect(getParent.mock.calls).toEqual([["P"], ["Q"], ["R"]]);
    expect(tracker.size()).toBe(1);
  });

  it("backend walks retain learned links across LRU eviction, even with one slot", async () => {
    const { tracker, getParent } = fixture({ maxEntries: 1 });
    getParent.mockImplementation(async (id) => Number(id) === 0 ? null : String(Number(id) - 1));
    expect(await tracker.depthOf("5")).toBe(5);
    expect(tracker.size()).toBe(1);
    expect(getParent).toHaveBeenCalledTimes(6);
    expect(await tracker.depthOf("5")).toBe(5);
    expect(tracker.size()).toBe(1);
    expect(getParent).toHaveBeenCalledTimes(12);
    expect(await tracker.depthOf("0")).toBe(0);
  });

  it("repeated authoritative root records remain roots", async () => {
    const { tracker, warn } = fixture();
    tracker.recordRoot("R");
    tracker.recordRoot("R");
    expect(await tracker.depthOf("R")).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("the fetch budget caps broad conflicting ancestry without memoizing MAX", async () => {
    const { tracker, getParent, warn } = fixture();
    function tree(id: string, levels: number): void {
      if (levels === 0) return;
      for (let i = 0; i < 4; i++) {
        const parent = `${id}.${i}`;
        tracker.recordCreated(id, parent);
        tree(parent, levels - 1);
      }
    }
    tree("X", 4);
    expect(await tracker.depthOf("X")).toBe(MAX_DEPTH_HOPS);
    expect(getParent).toHaveBeenCalledTimes(66);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fetch budget"));
    // Further calls must continue fetching, rather than treating MAX as evidence.
    for (let i = 0; i < 3; i++) await tracker.depthOf("X");
    expect(await tracker.depthOf("X")).toBe(4);
    expect(getParent).toHaveBeenCalledTimes(256);
  });

  // Amended for QA-1.2-6: a throwing clock is contained at the seam, so the
  // lookup no longer fails; it used to settle as an "internal lookup failure".
  it("a clock failure inside a lookup is contained and the answer is applied", async () => {
    const warn = vi.fn();
    const now = vi.fn().mockImplementationOnce(() => { throw new Error("clock unavailable"); }).mockReturnValue(0);
    const tracker = createDepthTracker({ now, logger: { warn }, getParent: async () => null });
    expect(await tracker.depthOf("X")).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a throttle established by a shared failing ancestor is respected inside another walk", async () => {
    const { tracker, getParent } = fixture();
    const pending = deferred<string | null>();
    getParent.mockImplementation((id) => id === "X" ? pending.promise : Promise.reject("offline"));
    const result = tracker.depthOf("X");
    await started();
    expect(await tracker.depthOf("P")).toBeUndefined();
    pending.resolve("P");
    expect(await result).toBe(1);
    expect(getParent.mock.calls).toEqual([["X"], ["P"]]);
  });

  it("T-lru / T-absolute: leaves go before ancestors; evicted leaves are looked up, never inferred roots", async () => {
    const { tracker, getParent } = fixture({ maxEntries: 3 });
    chain(tracker, 2);
    expect(tracker.size()).toBe(3);
    for (let i = 0; i < 20; i++) {
      tracker.recordCreated(`leaf${i}`, "n2");
      expect(tracker.size()).toBe(3);
      expect(await tracker.depthOf("n2")).toBe(2);
      expect(tracker.size()).toBe(3);
    }
    expect(getParent).not.toHaveBeenCalled();
    getParent.mockRejectedValueOnce("gone");
    expect(await tracker.depthOf("leaf0")).toBeUndefined();
    expect(getParent.mock.calls).toEqual([["leaf0"]]);
  });

  it("T-absolute: forgetting an ancestor preserves resolved floors without lookup", async () => {
    const { tracker, getParent } = fixture();
    chain(tracker, 2);
    tracker.forget("n1");
    expect(await tracker.depthOf("n2")).toBe(2);
    expect(getParent).not.toHaveBeenCalled();
    tracker.recordCreated("n1", "n0");
    expect(await tracker.depthOf("n2")).toBe(2);
  });

  it("T-absolute: unresolved descendants re-fetch forgotten intermediates, retaining floors on failure", async () => {
    const { tracker, getParent } = fixture();
    tracker.recordCreated("C", "P");
    tracker.recordCreated("G", "C");
    tracker.forget("C");
    getParent.mockRejectedValue("offline");
    expect(await tracker.depthOf("G")).toBe(2);
    expect(getParent.mock.calls).toEqual([["C"]]);
  });

  it("T-ttl: reads refresh the entire ancestry; idle boundary and future stamps", async () => {
    const { tracker, time } = fixture({ ttlMs: 100 });
    chain(tracker, 2);
    tracker.recordRoot("idle");
    time(50);
    expect(await tracker.depthOf("n2")).toBe(2);
    time(100);
    tracker.sweep();
    expect(tracker.size()).toBe(3);
    time(149);
    tracker.sweep();
    expect(tracker.size()).toBe(3);
    time(-1);
    tracker.sweep();
    expect(tracker.size()).toBe(3);
    time(150);
    tracker.sweep();
    expect(tracker.size()).toBe(0);
  });

  // Amended for QA-1.2-5: the failure blocklist shares the `maxEntries` FIFO cap,
  // so B's failure evicts A's throttle and A is retried (4 and 5 lookups, not 3 and 4).
  it("T-warn: FIFO warning and throttle bounds, forget reset, and TTL expiration", async () => {
    const { tracker, getParent, warn, time } = fixture({ ttlMs: 10, maxEntries: 1 });
    getParent.mockRejectedValue("offline");
    await tracker.depthOf("A");
    await tracker.depthOf("B");
    await tracker.depthOf("A");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(getParent).toHaveBeenCalledTimes(3);
    tracker.forget("A");
    await tracker.depthOf("A");
    expect(warn).toHaveBeenCalledTimes(4);
    time(10);
    tracker.sweep();
    await tracker.depthOf("A");
    expect(warn).toHaveBeenCalledTimes(5);
    expect(getParent).toHaveBeenCalledTimes(4);
    time(DEPTH_LOOKUP_RETRY_MS + 10);
    tracker.sweep();
    await tracker.depthOf("A");
    expect(getParent).toHaveBeenCalledTimes(5);
  });

  it.each([{ ttlMs: 0, maxEntries: 0 }, { ttlMs: Infinity, maxEntries: 1.5 }, { ttlMs: NaN, maxEntries: NaN }])("invalid options %j fall back to defaults", ({ ttlMs, maxEntries }) => {
    const { tracker, time } = fixture({ ttlMs, maxEntries });
    tracker.recordRoot("X");
    time(DEFAULT_IDLE_TTL_MS - 1);
    tracker.sweep();
    expect(tracker.size()).toBe(1);
    time(DEFAULT_IDLE_TTL_MS);
    tracker.sweep();
    expect(tracker.size()).toBe(0);
    for (let i = 0; i <= DEFAULT_DEPTH_MAX_ENTRIES; i++) tracker.recordRoot(String(i));
    expect(tracker.size()).toBe(DEFAULT_DEPTH_MAX_ENTRIES);
  });
});

describe("QA-1.2-6: seams never escape", () => {
  function brittle(now: () => number, warn: (msg: string) => void = vi.fn()) {
    const getParent = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValue(null);
    return { tracker: createDepthTracker({ getParent, now, logger: { warn } }), getParent };
  }
  const broken = () => { throw new Error("clock"); };

  it("a throwing clock on the timeout and failure paths resolves to the floor", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = brittle(broken);
    getParent.mockReturnValue(new Promise(() => {}));
    tracker.recordCreated("X", "P");
    const result = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe(1);
    getParent.mockRejectedValue(new Error("offline"));
    await expect(tracker.depthOf("Y")).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a throwing clock inside a backend record still yields the exact depth", async () => {
    const { tracker, getParent } = brittle(broken);
    getParent.mockImplementation(async (id) => id === "X" ? "P" : null);
    await expect(tracker.depthOf("X")).resolves.toBe(1);
    tracker.sweep();
    expect(tracker.size()).toBe(2);
  });

  it("non-number clock readings fall back to the last good reading", async () => {
    let reading: unknown = 5;
    const { tracker } = brittle(() => reading as number);
    tracker.recordRoot("R");
    reading = Number.NaN;
    tracker.recordCreated("C", "R");
    reading = "later";
    expect(await tracker.depthOf("C")).toBe(1);
    expect(tracker.size()).toBe(2);
  });

  it("a throwing logger never makes a record call throw, and the warning is retried", async () => {
    const warn = vi.fn(() => { throw new Error("logger down"); });
    const { tracker } = brittle(() => 0, warn);
    tracker.recordRoot("R");
    expect(() => tracker.recordCreated("R", "P")).not.toThrow();
    expect(() => tracker.recordCreated("R", "Q")).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(tracker.depthOf("R")).resolves.toBe(1);
  });

  it.each([Object.create(null), { toString() { throw new Error("toString"); } }])("an unprintable rejection is described, not rethrown (%#)", async (reason) => {
    const { tracker, getParent } = brittle(() => 0);
    const warn = vi.fn();
    const logged = createDepthTracker({ getParent, now: () => 0, logger: { warn } });
    getParent.mockRejectedValue(reason);
    await expect(logged.depthOf("X")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unprintable rejection"));
    await expect(tracker.depthOf("X")).resolves.toBeUndefined();
  });

  it("a throwing timeoutMs getter falls back to the default timeout", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = brittle(() => 0);
    getParent.mockReturnValue(new Promise(() => {}));
    const options = { get timeoutMs(): number { throw new Error("getter"); } };
    const result = tracker.depthOf("X", options);
    await vi.advanceTimersByTimeAsync(DEFAULT_DEPTH_TIMEOUT_MS - 1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeUndefined();
  });
});

describe("QA-1.2-5: the failure blocklist is bounded", () => {
  it("keeps only the newest maxEntries throttles, and entries expire at lookup time", async () => {
    const { tracker, getParent, time } = fixture({ maxEntries: 10 });
    getParent.mockRejectedValue("down");
    for (let i = 0; i < 1_000; i++) expect(await tracker.depthOf(`s${i}`)).toBeUndefined();
    expect(getParent).toHaveBeenCalledTimes(1_000);
    getParent.mockResolvedValue(null);
    // The 990 oldest throttles were evicted: the recovered backend is asked again.
    for (let i = 0; i < 990; i++) expect(await tracker.depthOf(`s${i}`)).toBe(0);
    expect(getParent).toHaveBeenCalledTimes(1_990);
    // The 10 newest are still inside their window...
    for (let i = 990; i < 1_000; i++) expect(await tracker.depthOf(`s${i}`)).toBeUndefined();
    expect(getParent).toHaveBeenCalledTimes(1_990);
    // ...and expire on their own, without sweep().
    time(DEPTH_LOOKUP_RETRY_MS);
    for (let i = 990; i < 1_000; i++) expect(await tracker.depthOf(`s${i}`)).toBe(0);
    expect(getParent).toHaveBeenCalledTimes(2_000);
  });
});

describe("QA-1.2-3: a timed-out walk is cancelled and stays reachable", () => {
  function held() {
    const { tracker, getParent, time } = fixture();
    const answers = new Map<string, ReturnType<typeof deferred<string | null>>>();
    getParent.mockImplementation((id) => {
      const answer = deferred<string | null>();
      answers.set(id, answer);
      return answer.promise;
    });
    return { tracker, getParent, answers, time };
  }

  it("forget reaches the detached lookup: no resurrection and no orphan lookups", async () => {
    vi.useFakeTimers();
    const { tracker, getParent, answers } = held();
    const result = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeUndefined();
    tracker.forget("X");
    expect(tracker.size()).toBe(0);
    answers.get("X")!.resolve("P");
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.size()).toBe(0);
    expect(getParent.mock.calls).toEqual([["X"]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("without forget the late answer is applied, but the cancelled walk never continues", async () => {
    vi.useFakeTimers();
    const { tracker, getParent, answers, time } = held();
    const result = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBeUndefined();
    answers.get("X")!.resolve("P");
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.size()).toBe(1);
    expect(getParent.mock.calls).toEqual([["X"]]);
    // One walk per session: the next walk is a fresh one, and only it asks for P.
    time(DEPTH_LOOKUP_RETRY_MS);
    const next = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(0);
    expect(getParent.mock.calls).toEqual([["X"], ["P"]]);
    answers.get("P")!.resolve(null);
    expect(await next).toBe(1);
  });

  it("an early caller's timeout does not cancel the walk other callers still await", async () => {
    vi.useFakeTimers();
    const { tracker, answers } = held();
    const early = tracker.depthOf("X", { timeoutMs: 5 });
    const late = tracker.depthOf("X", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await early).toBeUndefined();
    answers.get("X")!.resolve(null);
    expect(await late).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a lookup shared with a live walk stays attached when another walk times out", async () => {
    vi.useFakeTimers();
    const { tracker, getParent, answers } = held();
    tracker.recordCreated("X", "A");
    tracker.recordCreated("Y", "A");
    const x = tracker.depthOf("X", { timeoutMs: 5 });
    const y = tracker.depthOf("Y", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(5);
    expect(await x).toBe(1);
    answers.get("A")!.resolve(null);
    expect(await y).toBe(1);
    expect(await tracker.depthOf("X")).toBe(1);
    expect(getParent.mock.calls).toEqual([["A"]]);
  });
});

describe("QA-1.2-4: the timeout floor uses what the walk has learned", () => {
  it("returns the proven floor of a walk whose start was evicted (one slot)", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture({ maxEntries: 1 });
    getParent.mockImplementation((id) => id === "X" ? Promise.resolve("P") : id === "P" ? Promise.resolve("Q") : new Promise(() => {}));
    const result = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe(2);
    expect(getParent.mock.calls).toEqual([["X"], ["P"], ["Q"]]);
  });

  it("a joining caller's snapshot is shared with the walk it joins", async () => {
    vi.useFakeTimers();
    const { tracker, getParent } = fixture();
    getParent.mockReturnValue(new Promise(() => {}));
    tracker.recordCreated("X", "P");
    const first = tracker.depthOf("X", { timeoutMs: 10 });
    const second = tracker.depthOf("X", { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    expect(await Promise.all([first, second])).toEqual([1, 1]);
  });
});
