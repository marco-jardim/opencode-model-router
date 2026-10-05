import { describe, it, expect, vi } from "vitest";
import {
  createDepthGuard,
  DELEGATION_DEPTH_GUARD,
  depthAdvisoryBanner,
  depthLimitMessage,
} from "../../src/router/depth-guard";
import { MAX_DELEGATION_DEPTH_LIMIT } from "../../src/router/config";
import { createDepthTracker, MAX_DEPTH_HOPS } from "../../src/router/depth";
import type { DepthTracker, DepthTrackerSeams } from "../../src/router/depth";
import type { EnforcementMode } from "../../src/router/enforcement";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import type { RouterConfig } from "../../src/router/config";

function setup(depth: number | undefined, max: number | null = 1, mode: EnforcementMode = "enforced") {
  const depthOf = vi.fn<DepthTracker["depthOf"]>().mockResolvedValue(depth);
  const limit = vi.fn(() => max);
  const resolveMode = vi.fn<(caller: string | undefined) => EnforcementMode>(() => mode);
  const warn = vi.fn<(message: string) => void>();
  const guard = createDepthGuard({ tracker: { depthOf }, limit, mode: resolveMode, logger: { warn } });
  return { ...guard, depthOf, limit, resolveMode, warn };
}

describe("delegation depth guard", () => {
  const modes: EnforcementMode[] = ["off", "advisory", "enforced"];
  const limits = [null, 1, 2, 32];
  const depths = [0, 1, 2, 31, MAX_DEPTH_HOPS, undefined];
  const cases = depths.flatMap((depth) => limits.flatMap((max) => modes.map((mode) => ({ depth, max, mode }))));

  it.each(cases)("depth=$depth limit=$max mode=$mode", async ({ depth, max, mode }) => {
    const guard = setup(depth, max, mode);
    const result = await guard.checkDispatch("caller");
    const active = mode !== "off" && max !== null;
    const exceeded = active && depth !== undefined && depth + 1 > max;
    const expected = !active
      ? { block: false, mode }
      : !exceeded
        ? { block: false, mode, guard: null }
        : mode === "enforced"
          ? { block: true, mode, guard: DELEGATION_DEPTH_GUARD, message: depthLimitMessage(depth, max) }
          : { block: false, mode, guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(depth, max) };
    expect(result).toStrictEqual(expected);
    expect(result.message).toBe(exceeded && mode === "enforced" ? depthLimitMessage(depth, max) : undefined);
    expect(result.banner).toBe(exceeded && mode === "advisory" ? depthAdvisoryBanner(depth, max) : undefined);
    expect(guard.depthOf).toHaveBeenCalledTimes(active ? 1 : 0);
    if (active) expect(guard.depthOf).toHaveBeenCalledWith("caller");
    expect(guard.limit).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    expect(guard.resolveMode).toHaveBeenCalledExactlyOnceWith("caller");
    expect(guard.warn).not.toHaveBeenCalled();
  });

  it("pins the tracker saturation depth to the largest supported limit (A13)", () => {
    expect(MAX_DEPTH_HOPS).toBe(MAX_DELEGATION_DEPTH_LIMIT);
    expect(DELEGATION_DEPTH_GUARD).toBe("delegation_depth");
  });

  it("preserves the exact D5 refusal and A1 advisory text", () => {
    expect(depthLimitMessage(1, 1)).toMatchInlineSnapshot(`"[router] DELEGATION DEPTH LIMIT — this session is at delegation depth 1; enforcement.maxDelegationDepth is 1, so it cannot dispatch another subagent. Do this part of the work yourself and report the result; do not retry the dispatch."`);
    expect(depthAdvisoryBanner(1, 1)).toMatchInlineSnapshot(`"[⚠ GUARD:delegation_depth] this session is at delegation depth 1; enforcement.maxDelegationDepth is 1. In enforced mode this dispatch would have been refused. Do not dispatch further subagents from this session; do that work yourself."`);
  });

  it("honours a changed limit on the next call", async () => {
    const guard = setup(1);
    expect((await guard.checkDispatch("caller")).block).toBe(true);
    guard.limit.mockReturnValue(2);
    expect(await guard.checkDispatch("caller")).toStrictEqual({ block: false, mode: "enforced", guard: null });
    guard.limit.mockReturnValue(null);
    expect(await guard.checkDispatch("caller")).toStrictEqual({ block: false, mode: "enforced" });
    expect(guard.depthOf).toHaveBeenCalledTimes(2);
    expect(guard.limit).toHaveBeenCalledTimes(3);
  });

  it("resolves mode per caller and per call", async () => {
    const guard = setup(1);
    guard.resolveMode.mockImplementation((caller) => caller === "enforced" ? "enforced" : "advisory");
    expect((await guard.checkDispatch("enforced")).block).toBe(true);
    expect((await guard.checkDispatch("advisory")).banner).toBe(depthAdvisoryBanner(1, 1));
    guard.resolveMode.mockReturnValue("off");
    expect(await guard.checkDispatch("enforced")).toStrictEqual({ block: false, mode: "off" });
    expect(guard.resolveMode.mock.calls).toEqual([["enforced"], ["advisory"], ["enforced"]]);
    expect(guard.depthOf).toHaveBeenCalledTimes(2);
  });

  it.each(["Enforced", "ENFORCED", "enforce", "on", "", 1, null, undefined, { mode: "enforced" }, "Off"])(
    "validates malformed mode %j as advisory, with one warning", async (mode) => {
      const guard = setup(1);
      guard.resolveMode.mockReturnValue(mode as EnforcementMode);
      for (let i = 0; i < 2; i++) {
        expect(await guard.checkDispatch("caller")).toStrictEqual({
          block: false, mode: "advisory", guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(1, 1),
        });
      }
      expect(guard.depthOf).toHaveBeenCalledTimes(2);
      expect(guard.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("invalid enforcement mode"));
    },
  );

  it("validates an unrecognised state-file mode passed through the real resolver", async () => {
    const guard = setup(1);
    guard.resolveMode.mockImplementation(() => resolveEnforcementMode({
      config: { enforcement: { mode: "Enforced" } } as unknown as RouterConfig, env: {},
    }).mode);
    expect((await guard.checkDispatch("caller")).mode).toBe("advisory");
    expect(guard.warn).toHaveBeenCalledTimes(1);
  });

  it("bounds distinct invalid-mode warnings at 100, evicting the oldest", async () => {
    const guard = setup(1);
    for (let i = 0; i < 101; i++) {
      guard.resolveMode.mockReturnValue(`invalid-${i}` as EnforcementMode);
      await guard.checkDispatch("caller");
    }
    guard.resolveMode.mockReturnValue("invalid-1" as EnforcementMode);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(101);
    guard.resolveMode.mockReturnValue("invalid-0" as EnforcementMode);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(102);
  });

  it("contains an invalid mode that cannot be printed", async () => {
    const guard = setup(1);
    guard.resolveMode.mockReturnValue({ toString() { throw new Error("unprintable"); } } as unknown as EnforcementMode);
    expect((await guard.checkDispatch("caller")).mode).toBe("advisory");
    expect(guard.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("unprintable value"));
  });

  it.each(["reject", "throw"])("allows tracker %s and warns once per caller", async (failure) => {
    const guard = setup(undefined);
    if (failure === "reject") guard.depthOf.mockRejectedValue(new Error("offline"));
    if (failure === "throw") guard.depthOf.mockImplementation(() => { throw new Error("broken"); });
    for (const caller of ["first", "first", "second", "second"]) {
      await expect(guard.checkDispatch(caller)).resolves.toStrictEqual({ block: false, mode: "enforced", guard: null });
    }
    expect(guard.warn).toHaveBeenCalledTimes(2);
    expect(guard.warn.mock.calls[0][0]).toContain("first");
    expect(guard.warn.mock.calls[1][0]).toContain("second");
  });

  it("shares contract-violation warning deduplication across concurrent calls", async () => {
    const guard = setup(undefined);
    guard.depthOf.mockRejectedValueOnce(new Error("offline"));
    await Promise.all([guard.checkDispatch("caller"), guard.checkDispatch("caller")]);
    guard.depthOf.mockImplementationOnce(() => { throw new Error("broken"); });
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(1);
  });

  it("caps unknown-caller warnings at 1,000 entries, evicting the oldest", async () => {
    const guard = setup(undefined);
    guard.depthOf.mockRejectedValue(new Error("offline"));
    for (let i = 0; i < 1_001; i++) await guard.checkDispatch(`caller-${i}`);
    expect(guard.warn).toHaveBeenCalledTimes(1_001);
    await guard.checkDispatch("caller-1");
    expect(guard.warn).toHaveBeenCalledTimes(1_001);
    await guard.checkDispatch("caller-0");
    expect(guard.warn).toHaveBeenCalledTimes(1_002);
  });

  it("leaves undefined-depth warnings to the tracker", async () => {
    const guard = setup(undefined);
    await guard.checkDispatch("caller");
    await guard.checkDispatch("caller");
    expect(guard.warn).not.toHaveBeenCalled();
  });

  it("logs exactly once per unknown caller with the real tracker and shared logger", async () => {
    const warn = vi.fn<(message: string) => void>();
    const logger = { warn };
    const getParent = vi.fn<DepthTrackerSeams["getParent"]>().mockRejectedValue(new Error("offline"));
    const tracker = createDepthTracker({ getParent, now: Date.now, logger });
    const guard = createDepthGuard({ tracker, limit: () => 1, mode: () => "enforced", logger });
    for (const caller of ["first", "first", "second", "second"]) {
      expect(await guard.checkDispatch(caller)).toStrictEqual({ block: false, mode: "enforced", guard: null });
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining("cannot resolve session first: offline"));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining("cannot resolve session second: offline"));
  });

  it("allows when the real tracker times out at 2000 ms, with one warning and no timers", async () => {
    vi.useFakeTimers();
    try {
      const logger = { warn: vi.fn<(message: string) => void>() };
      const getParent = vi.fn<DepthTrackerSeams["getParent"]>(() => new Promise(() => { /* backend hangs */ }));
      const tracker = createDepthTracker({ getParent, now: Date.now, logger });
      const guard = createDepthGuard({ tracker, limit: () => 1, mode: () => "enforced", logger });
      const settled = vi.fn();
      const pending = guard.checkDispatch("caller").then((result) => { settled(); return result; });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toStrictEqual({ block: false, mode: "enforced", guard: null });
      expect(settled).toHaveBeenCalledTimes(1);
      expect(await guard.checkDispatch("caller")).toStrictEqual({ block: false, mode: "enforced", guard: null });
      expect(getParent).toHaveBeenCalledExactlyOnceWith("caller");
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cannot resolve session caller"));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([NaN, -1, 1.5, "2", Infinity, null, {}])("fails closed for invalid depth %j", async (depth) => {
    const guard = setup(depth as unknown as number, 32);
    expect(await guard.checkDispatch("caller")).toStrictEqual({
      block: true, mode: "enforced", guard: DELEGATION_DEPTH_GUARD, message: depthLimitMessage(MAX_DEPTH_HOPS, 32),
    });
    expect(guard.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("invalid depth"));
  });

  it("retains advisory semantics for a malformed tracker depth", async () => {
    const guard = setup(NaN, 32, "advisory");
    expect(await guard.checkDispatch("caller")).toStrictEqual({
      block: false, mode: "advisory", guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(MAX_DEPTH_HOPS, 32),
    });
  });

  it.each([NaN, -1, 0, 1.5, 33, Infinity, "2", undefined])("uses limit 1 and warns once for invalid limit %j", async (max) => {
    const guard = setup(1, max as unknown as number);
    // Set explicitly: undefined must not select the fixture's default argument.
    guard.limit.mockReturnValue(max as unknown as number);
    for (let i = 0; i < 2; i++) {
      expect(await guard.checkDispatch("caller")).toStrictEqual({
        block: true, mode: "enforced", guard: DELEGATION_DEPTH_GUARD, message: depthLimitMessage(1, 1),
      });
    }
    expect(guard.warn).toHaveBeenCalledExactlyOnceWith(
      `[router] delegation depth: invalid delegation depth limit ${typeof max}: ${String(max)}; using effective limit 1.`,
    );
    guard.depthOf.mockResolvedValue(0);
    expect((await guard.checkDispatch("root")).block).toBe(false);
  });

  it("allows missing, empty, and non-string callers with one warning total", async () => {
    const guard = setup(32);
    for (const caller of [undefined, "", null, 2, {}, undefined]) {
      await expect(guard.checkDispatch(caller as unknown as string | undefined)).resolves.toStrictEqual({
        block: false, mode: "enforced", guard: null,
      });
    }
    expect(guard.warn).toHaveBeenCalledTimes(1);
    expect(guard.depthOf).not.toHaveBeenCalled();
    expect(guard.resolveMode).toHaveBeenNthCalledWith(1, undefined);
  });

  it("warns once per distinct live invalid limit and refuses using the effective limit", async () => {
    const guard = setup(1);
    for (const max of [0, 2, 99, 0, 99]) {
      guard.limit.mockReturnValue(max);
      const result = await guard.checkDispatch("caller");
      expect(result.block).toBe(max !== 2);
      expect(result.message).toBe(max === 2 ? undefined : depthLimitMessage(1, 1));
    }
    expect(guard.warn.mock.calls).toStrictEqual([
      ["[router] delegation depth: invalid delegation depth limit number: 0; using effective limit 1."],
      ["[router] delegation depth: invalid delegation depth limit number: 99; using effective limit 1."],
    ]);
  });

  it("bounds distinct invalid-limit warnings at 100, evicting the oldest", async () => {
    const guard = setup(1);
    for (let i = 0; i < 101; i++) {
      guard.limit.mockReturnValue(-i);
      await guard.checkDispatch("caller");
    }
    guard.limit.mockReturnValue(-1);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(101);
    guard.limit.mockReturnValue(0);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(102);
  });

  it.each(["off", "null"])("short-circuits %s before validating the caller", async (disabled) => {
    const guard = setup(32, disabled === "null" ? null : 1, disabled === "off" ? "off" : "enforced");
    expect((await guard.checkDispatch(undefined)).block).toBe(false);
    expect(guard.depthOf).not.toHaveBeenCalled();
    expect(guard.warn).not.toHaveBeenCalled();
  });

  it("contains throwing mode and limit seams with logged defaults", async () => {
    const guard = setup(1);
    guard.resolveMode.mockImplementation(() => { throw new Error("mode unavailable"); });
    guard.limit.mockImplementation(() => { throw new Error("limit unavailable"); });
    await expect(guard.checkDispatch("caller")).resolves.toStrictEqual({
      block: false, mode: "advisory", guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(1, 1),
    });
    expect(guard.warn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates persistent seam failures and invalid depths over 100 checks", async () => {
    const guard = setup(NaN);
    guard.resolveMode.mockImplementation(() => { throw new Error("mode unavailable"); });
    guard.limit.mockImplementation(() => { throw new Error("limit unavailable"); });
    for (let i = 0; i < 100; i++) {
      expect(await guard.checkDispatch("caller")).toStrictEqual({
        block: false, mode: "advisory", guard: DELEGATION_DEPTH_GUARD, banner: depthAdvisoryBanner(MAX_DEPTH_HOPS, 1),
      });
    }
    expect(guard.warn).toHaveBeenCalledTimes(3);
  });

  it("deduplicates throwing modes even when the limit disables the guard", async () => {
    const guard = setup(1, null);
    guard.resolveMode.mockImplementation(() => { throw new Error("mode unavailable"); });
    for (let i = 0; i < 100; i++) {
      expect(await guard.checkDispatch("caller")).toStrictEqual({ block: false, mode: "advisory" });
    }
    expect(guard.warn).toHaveBeenCalledTimes(1);
    expect(guard.depthOf).not.toHaveBeenCalled();
  });

  it.each(["mode", "limit", "depth"])("bounds distinct %s failure causes at 100", async (seam) => {
    const guard = setup(1);
    function fail(cause: number) {
      if (seam === "mode") guard.resolveMode.mockImplementation(() => { throw new Error(`cause-${cause}`); });
      if (seam === "limit") guard.limit.mockImplementation(() => { throw new Error(`cause-${cause}`); });
      if (seam === "depth") guard.depthOf.mockResolvedValue(-cause - 1);
    }
    for (let i = 0; i < 101; i++) {
      fail(i);
      await guard.checkDispatch("caller");
    }
    fail(1);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(101);
    fail(0);
    await guard.checkDispatch("caller");
    expect(guard.warn).toHaveBeenCalledTimes(102);
  });

  it("a throwing logger never rejects or weakens a known-depth decision", async () => {
    const guard = setup(NaN);
    guard.warn.mockImplementation(() => { throw new Error("logger unavailable"); });
    await expect(guard.checkDispatch("caller")).resolves.toMatchObject({ block: true, mode: "enforced" });
    guard.depthOf.mockRejectedValue(new Error("tracker unavailable"));
    await expect(guard.checkDispatch("unknown")).resolves.toStrictEqual({ block: false, mode: "enforced", guard: null });
  });

  it.each(["caller", "tracker", "mode", "limit", "mode throw", "limit throw", "depth"])(
    "retries an undelivered %s warning, then deduplicates after delivery", async (failure) => {
      const guard = setup(1);
      const caller = failure === "caller" ? undefined : "caller";
      if (failure === "tracker") guard.depthOf.mockRejectedValue(new Error("offline"));
      if (failure === "mode") guard.resolveMode.mockReturnValue("Enforced" as EnforcementMode);
      if (failure === "limit") guard.limit.mockReturnValue(0);
      if (failure === "mode throw") guard.resolveMode.mockImplementation(() => { throw new Error("mode unavailable"); });
      if (failure === "limit throw") guard.limit.mockImplementation(() => { throw new Error("limit unavailable"); });
      if (failure === "depth") guard.depthOf.mockResolvedValue(NaN);
      const delivered = vi.fn();
      guard.warn.mockImplementationOnce(() => { throw new Error("logger unavailable"); });
      guard.warn.mockImplementation(delivered);
      const first = await guard.checkDispatch(caller);
      expect(delivered).not.toHaveBeenCalled();
      expect(await guard.checkDispatch(caller)).toStrictEqual(first);
      expect(await guard.checkDispatch(caller)).toStrictEqual(first);
      expect(guard.warn).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenCalledTimes(1);
    },
  );
});
