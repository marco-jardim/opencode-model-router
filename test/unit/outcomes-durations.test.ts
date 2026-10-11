import { describe, expect, it } from "vitest";
import {
  DURATION_MAX_AGE_DAYS,
  DURATION_MIN_SAMPLES,
  DURATION_P90_MIN_SAMPLES,
  DURATION_PRIOR_MS,
  DURATION_WINDOW,
  createDurationModel,
} from "../../src/routing/outcomes/durations";
import type { DurationOptions } from "../../src/routing/outcomes/durations";
import type { DispatchTimingRow } from "../../src/routing/outcomes/types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

let serial = 0;

/** A succeeded, capacity-free row ending `ageMs` before NOW; every row gets a distinct child session unless overridden. */
function row(overrides: Partial<DispatchTimingRow> & { ageMs?: number } = {}): DispatchTimingRow {
  const { ageMs, ...rest } = overrides;
  serial += 1;
  const endedAt = rest.endedAt ?? NOW - (ageMs ?? 1000) - serial;
  const durationMs = rest.durationMs ?? 1000;
  return {
    kind: "dispatch-timing",
    v: 1,
    ts: new Date(Number.isFinite(endedAt) ? endedAt : NOW).toISOString(),
    parentSessionID: "root",
    childSessionID: `child-${serial}`,
    callID: `call-${serial}`,
    role: "role",
    class: "cls",
    scope: "scope",
    tier: "fast",
    model: "p/m",
    background: false,
    startedAt: endedAt - durationMs,
    endedAt,
    durationMs,
    outcome: "succeeded",
    capacity: null,
    ...rest,
  };
}

/** `n` rows with durations `base + 1 .. base + n`, the i-th ending i ms before the previous one (ascending in endedAt). */
function ladder(n: number, overrides: Partial<DispatchTimingRow> = {}): DispatchTimingRow[] {
  const rows: DispatchTimingRow[] = [];
  for (let i = 1; i <= n; i++) rows.push(row({ ...overrides, durationMs: i, endedAt: NOW - 10_000 + i }));
  return rows;
}

const Q = { role: "role", class: "cls", scope: "scope" };

async function loaded(rows: readonly DispatchTimingRow[], opts?: DurationOptions, now: () => number = () => NOW) {
  const model = createDurationModel({ readTimings: () => rows, now }, opts);
  await model.load();
  return model;
}

describe("duration estimator: constants", () => {
  it("exposes the documented defaults", () => {
    expect(DURATION_WINDOW).toBe(50);
    expect(DURATION_MAX_AGE_DAYS).toBe(30);
    expect(DURATION_PRIOR_MS).toBe(480_000);
    expect(DURATION_MIN_SAMPLES).toBe(5);
  });
});

describe("duration estimator: samples per level", () => {
  it("0 samples: the prior, labeled prior, n = 0", async () => {
    const model = await loaded([]);
    expect(model.estimate(Q)).toEqual({ p50: 480_000, p90: 480_000, n: 0, source: "prior" });
  });

  it("an empty store returns the prior before and after load", async () => {
    const model = createDurationModel({ readTimings: () => [], now: () => NOW });
    expect(model.estimate(Q).source).toBe("prior");
    await model.load();
    expect(model.estimate(Q)).toEqual({ p50: DURATION_PRIOR_MS, p90: DURATION_PRIOR_MS, n: 0, source: "prior" });
  });

  it("4 samples are below the minimum: still the prior", async () => {
    const model = await loaded(ladder(4));
    expect(model.estimate(Q)).toEqual({ p50: 480_000, p90: 480_000, n: 0, source: "prior" });
  });

  it("5 samples answer: exact, nearest-rank percentiles", async () => {
    const model = await loaded(ladder(5)); // 1..5
    // rank(p50) = ceil(2.5) = 3; p90 needs 10 samples (QA-1.1-10), so it is the prior's
    expect(model.estimate(Q)).toEqual({ p50: 3, p90: 480_000, n: 5, source: "exact" });
  });

  it("60 samples: only the newest 50 are kept (window)", async () => {
    const model = await loaded(ladder(60)); // durations 1..60, newest = largest
    const est = model.estimate(Q);
    // kept 11..60: rank 25 -> 35, rank 45 -> 55
    expect(est).toEqual({ p50: 35, p90: 55, n: 50, source: "exact" });
  });

  it("a single sample with minSamples 1 answers with p50 = p90", async () => {
    const model = await loaded([row({ durationMs: 77 })], { minSamples: 1, p90MinSamples: 1 });
    expect(model.estimate(Q)).toEqual({ p50: 77, p90: 77, n: 1, source: "exact" });
  });
});

describe("duration estimator: fallback chain", () => {
  it("exact -> role-class -> role -> prior", async () => {
    const rows = [
      ...ladder(5, { role: "r", class: "c", scope: "s" }), // exact for (r,c,s)
      ...ladder(2, { role: "r", class: "c", scope: "t" }), // role-class (r,c) = 7
      ...ladder(3, { role: "r", class: "d", scope: "x" }), // role r = 10
    ];
    const model = await loaded(rows);
    expect(model.estimate({ role: "r", class: "c", scope: "s" })).toMatchObject({ source: "exact", n: 5 });
    expect(model.estimate({ role: "r", class: "c", scope: "t" })).toMatchObject({ source: "role-class", n: 7 });
    expect(model.estimate({ role: "r", class: "c", scope: "never" })).toMatchObject({ source: "role-class", n: 7 });
    expect(model.estimate({ role: "r", class: "d", scope: "x" })).toMatchObject({ source: "role", n: 10 });
    expect(model.estimate({ role: "r", class: "zzz", scope: "x" })).toMatchObject({ source: "role", n: 10 });
    expect(model.estimate({ role: "other", class: "c", scope: "s" })).toEqual({
      p50: DURATION_PRIOR_MS,
      p90: DURATION_PRIOR_MS,
      n: 0,
      source: "prior",
    });
  });

  it("a level with 4 samples is skipped for the coarser one", async () => {
    const rows = [...ladder(4, { scope: "s" }), ...ladder(1, { scope: "t" })];
    const model = await loaded(rows);
    expect(model.estimate({ ...Q, scope: "s" })).toMatchObject({ source: "role-class", n: 5 });
  });

  it("a custom prior is reported with source prior", async () => {
    const model = await loaded([], { priorMs: 1234 });
    expect(model.estimate(Q)).toEqual({ p50: 1234, p90: 1234, n: 0, source: "prior" });
  });

  it("a zero prior is honoured", async () => {
    const model = await loaded([], { priorMs: 0 });
    expect(model.estimate(Q)).toEqual({ p50: 0, p90: 0, n: 0, source: "prior" });
  });
});

describe("duration estimator: which rows count", () => {
  it("only succeeded rows count", async () => {
    const rows = [
      ...ladder(5, { outcome: "failed" }),
      ...ladder(5, { outcome: "interrupted" }),
      ...ladder(5, { outcome: "unknown" }),
    ];
    const model = await loaded(rows);
    expect(model.estimate(Q).source).toBe("prior");

    const mixed = await loaded([...rows, ...ladder(5)]);
    expect(mixed.estimate(Q)).toMatchObject({ source: "exact", n: 5 });
  });

  it("rows with a capacity class are excluded", async () => {
    const rows = [
      ...ladder(5, { capacity: "rate-limit" }),
      ...ladder(5, { capacity: "overload" }),
      ...ladder(5, { capacity: "usage-limit" }),
    ];
    const model = await loaded(rows);
    expect(model.estimate(Q).source).toBe("prior");
    const mixed = await loaded([...rows, ...ladder(5)]);
    expect(mixed.estimate(Q).n).toBe(5);
  });

  it("malformed numbers are ignored", async () => {
    const bad = [
      row({ durationMs: -1 }),
      row({ durationMs: Number.NaN }),
      row({ durationMs: Number.POSITIVE_INFINITY }),
      row({ endedAt: Number.NaN }),
    ];
    const model = await loaded([...bad, ...bad, ...bad]);
    expect(model.estimate(Q).source).toBe("prior");
  });

  it("a zero duration counts", async () => {
    const model = await loaded(ladder(5).map(r => ({ ...r, durationMs: 0 })));
    expect(model.estimate(Q)).toMatchObject({ p50: 0, n: 5 });
  });
});

describe("duration estimator: window and age", () => {
  it("keeps the newest rows by endedAt whatever the input order", async () => {
    const rows = ladder(60).reverse(); // newest first
    const model = await loaded(rows);
    expect(model.estimate(Q)).toEqual({ p50: 35, p90: 55, n: 50, source: "exact" });
  });

  it("honours a custom window", async () => {
    const model = await loaded(ladder(10), { window: 5, minSamples: 1, p90MinSamples: 1 }); // keeps 6..10
    expect(model.estimate(Q)).toEqual({ p50: 8, p90: 10, n: 5, source: "exact" });
  });

  it("the window applies per key and level", async () => {
    const rows = [...ladder(8, { scope: "a" }), ...ladder(8, { scope: "b" })];
    const model = await loaded(rows, { window: 6, minSamples: 1 });
    expect(model.estimate({ ...Q, scope: "a" }).n).toBe(6);
    expect(model.estimate({ ...Q, scope: "b" }).n).toBe(6);
    // role-class level holds only the newest 6 of the 16 rows
    expect(model.estimate({ ...Q, scope: "c" })).toMatchObject({ source: "role-class", n: 6 });
  });

  it("ignores rows older than 30 days, keeps the boundary", async () => {
    const old = ladder(5).map(r => ({ ...r, endedAt: NOW - 30 * DAY - 1 }));
    const model = await loaded(old);
    expect(model.estimate(Q).source).toBe("prior");

    const edge = ladder(5).map(r => ({ ...r, endedAt: NOW - 30 * DAY }));
    const kept = await loaded(edge);
    expect(kept.estimate(Q)).toMatchObject({ source: "exact", n: 5 });
  });

  it("an age-expired exact level falls back to a coarser one", async () => {
    const rows = [
      ...ladder(5, { scope: "s" }).map(r => ({ ...r, endedAt: NOW - 40 * DAY })),
      ...ladder(5, { scope: "t" }),
    ];
    const model = await loaded(rows);
    expect(model.estimate({ ...Q, scope: "s" })).toMatchObject({ source: "role-class", n: 5 });
  });

  it("age is judged at estimate time against the injected clock", async () => {
    let t = NOW;
    const model = await loaded(ladder(5), undefined, () => t);
    expect(model.estimate(Q).source).toBe("exact");
    t = NOW + 31 * DAY;
    expect(model.estimate(Q).source).toBe("prior");
  });

  it("honours maxAgeDays", async () => {
    const rows = ladder(5).map(r => ({ ...r, endedAt: NOW - 2 * DAY }));
    expect((await loaded(rows, { maxAgeDays: 1 })).estimate(Q).source).toBe("prior");
    expect((await loaded(rows, { maxAgeDays: 3 })).estimate(Q).source).toBe("exact");
    expect((await loaded(rows, { maxAgeDays: 0.5 })).estimate(Q).source).toBe("prior");
  });

  it("a non-finite clock reading falls back to the wall clock", async () => {
    const fresh = ladder(5).map(r => ({ ...r, endedAt: Date.now() - 1000 }));
    const model = await loaded(fresh, undefined, () => Number.NaN);
    expect(model.estimate(Q).source).toBe("exact");
    const stale = ladder(5).map(r => ({ ...r, endedAt: Date.now() - 40 * DAY }));
    const expired = await loaded(stale, undefined, () => Number.NaN);
    expect(expired.estimate(Q).source).toBe("prior");
  });
});

describe("duration estimator: percentiles and outliers", () => {
  it("a single 10x outlier among 10 samples does not move p90 (nearest rank: rank 9 of 10)", async () => {
    const rows = [...Array.from({ length: 9 }, () => row({ durationMs: 100 })), row({ durationMs: 1000 })];
    const model = await loaded(rows);
    expect(model.estimate(Q)).toEqual({ p50: 100, p90: 100, n: 10, source: "exact" });
  });

  it("the same outlier among 5 samples is p90 (nearest rank: rank 5 of 5) when the level may answer p90", async () => {
    const rows = [...Array.from({ length: 4 }, () => row({ durationMs: 100 })), row({ durationMs: 1000 })];
    const model = await loaded(rows, { p90MinSamples: 5 });
    expect(model.estimate(Q)).toEqual({ p50: 100, p90: 1000, n: 5, source: "exact" });
  });

  it("percentiles do not depend on the order rows were observed", async () => {
    const durations = [50, 10, 40, 20, 30, 60, 5, 90, 70, 80];
    const model = createDurationModel({ readTimings: () => [], now: () => NOW });
    durations.forEach((d, i) => model.observe(row({ durationMs: d, endedAt: NOW - 1000 - i })));
    // sorted: 5 10 20 30 40 50 60 70 80 90 -> rank 5 = 40, rank 9 = 80
    expect(model.estimate(Q)).toEqual({ p50: 40, p90: 80, n: 10, source: "exact" });
  });
});

describe("duration estimator: p90 needs a tail (QA-1.1-10)", () => {
  it("documents the default", () => {
    expect(DURATION_P90_MIN_SAMPLES).toBe(10);
  });

  it("9 samples: p50 from the level, p90 from the prior", async () => {
    const model = await loaded(ladder(9));
    expect(model.estimate(Q)).toEqual({ p50: 5, p90: 480_000, n: 9, source: "exact" });
  });

  it("10 samples: p90 from the level", async () => {
    const model = await loaded(ladder(10));
    expect(model.estimate(Q)).toEqual({ p50: 5, p90: 9, n: 10, source: "exact" });
  });

  it("a thin exact level takes p90 from the first coarser level with 10 samples", async () => {
    const rows = [
      ...ladder(5, { scope: "s" }), // exact: 1..5 (p50 = 3)
      ...ladder(10, { scope: "t" }), // role-class holds 15 rows: 1..5 and 1..10
    ];
    const model = await loaded(rows);
    // role-class durations sorted: 1,1,2,2,3,3,4,4,5,5,6,7,8,9,10 -> rank ceil(13.5) = 14 -> 9
    expect(model.estimate({ ...Q, scope: "s" })).toEqual({ p50: 3, p90: 9, n: 5, source: "exact" });
  });

  it("p90 never falls below p50 when the prior is smaller", async () => {
    const rows = ladder(5).map(r => ({ ...r, durationMs: r.durationMs + 1_000_000 }));
    const est = (await loaded(rows)).estimate(Q);
    expect(est.p50).toBe(1_000_003);
    expect(est.p90).toBeGreaterThanOrEqual(est.p50);
  });

  it("p90MinSamples is an option; invalid values fall back to 10", async () => {
    for (const p90MinSamples of [0, -1, Number.NaN]) {
      expect((await loaded(ladder(9), { p90MinSamples })).estimate(Q).p90).toBe(480_000);
    }
    expect((await loaded(ladder(3), { minSamples: 1, p90MinSamples: 3 })).estimate(Q).p90).toBe(3);
  });
});

describe("duration estimator: rows from the future (QA-1.1-9)", () => {
  it("ignores rows that ended more than a day after now; keeps the boundary", async () => {
    const future = ladder(5).map(r => ({ ...r, endedAt: NOW + DAY + 1 }));
    expect((await loaded(future)).estimate(Q).source).toBe("prior");
    const edge = ladder(5).map(r => ({ ...r, endedAt: NOW + DAY }));
    expect((await loaded(edge)).estimate(Q)).toMatchObject({ source: "exact", n: 5 });
  });

  it("judges the future at estimate time against the injected clock", async () => {
    let t = NOW;
    const rows = ladder(5).map(r => ({ ...r, endedAt: NOW + 2 * DAY }));
    const model = await loaded(rows, undefined, () => t);
    expect(model.estimate(Q).source).toBe("prior");
    t = NOW + 2 * DAY;
    expect(model.estimate(Q).source).toBe("exact");
  });
});

describe("duration estimator: dedupe is a set lookup (QA-1.1-11)", () => {
  it("20000 rows in a huge window dedupe correctly and quickly", async () => {
    const model = createDurationModel({ readTimings: () => [], now: () => NOW }, { window: 100_000, minSamples: 1 });
    const rows: DispatchTimingRow[] = [];
    for (let i = 0; i < 20_000; i++) rows.push(row({ durationMs: i, endedAt: NOW - 100_000 + i }));
    for (const r of rows) model.observe(r);
    for (const r of rows) model.observe(r);
    expect(model.estimate(Q).n).toBe(20_000);
  });

  it("a row pushed out of the window can be observed again", async () => {
    const model = createDurationModel({ readTimings: () => [], now: () => NOW }, { window: 2, minSamples: 1 });
    const rows = ladder(3);
    for (const r of rows) model.observe(r); // rows[0] falls out of the window
    model.observe(rows[0] as DispatchTimingRow); // it is the oldest: inserted, then dropped again
    expect(model.estimate(Q).n).toBe(2);
    expect(model.estimate(Q).p50).toBe(2);
  });
});

describe("duration estimator: load and observe", () => {
  it("load is idempotent: one read, rows counted once", async () => {
    let reads = 0;
    const rows = ladder(5);
    const model = createDurationModel({
      readTimings: () => {
        reads += 1;
        return rows;
      },
      now: () => NOW,
    });
    await model.load();
    await model.load();
    await model.load();
    expect(reads).toBe(1);
    expect(model.estimate(Q).n).toBe(5);
  });

  it("concurrent load calls share one read", async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const rows = ladder(6);
    const model = createDurationModel({
      readTimings: async () => {
        reads += 1;
        await gate;
        return rows;
      },
      now: () => NOW,
    });
    const first = model.load();
    const second = model.load();
    const third = model.load();
    expect(model.estimate(Q).source).toBe("prior"); // not loaded yet
    release();
    await Promise.all([first, second, third]);
    expect(reads).toBe(1);
    expect(model.estimate(Q)).toMatchObject({ source: "exact", n: 6 });
  });

  it("estimate is synchronous and sees only observed rows until load resolves", async () => {
    const model = createDurationModel({ readTimings: () => ladder(5), now: () => NOW });
    for (const r of ladder(5, { scope: "live" })) model.observe(r);
    expect(model.estimate({ ...Q, scope: "live" }).n).toBe(5);
    expect(model.estimate(Q).source).toBe("role-class"); // the observed rows only
    await model.load();
    expect(model.estimate(Q)).toMatchObject({ source: "exact", n: 5 });
  });

  it("observe dedupes a row already loaded from the file", async () => {
    const rows = ladder(5);
    const model = await loaded(rows);
    for (const r of rows) model.observe(r);
    model.observe(rows[0] as DispatchTimingRow);
    expect(model.estimate(Q).n).toBe(5);
  });

  it("observe before load, then load with the same rows, counts each once", async () => {
    const rows = ladder(6);
    const model = createDurationModel({ readTimings: () => rows, now: () => NOW });
    model.observe(rows[0] as DispatchTimingRow);
    model.observe(rows[1] as DispatchTimingRow);
    await model.load();
    expect(model.estimate(Q).n).toBe(6);
  });

  it("two distinct dispatches that differ only in call id both count", async () => {
    const model = createDurationModel({ readTimings: () => [], now: () => NOW }, { minSamples: 1 });
    const base = row({ durationMs: 10, endedAt: NOW - 5 });
    model.observe(base);
    model.observe({ ...base, callID: "another-call" });
    expect(model.estimate(Q).n).toBe(2);
  });

  it("observe ignores rows that do not count", () => {
    const model = createDurationModel({ readTimings: () => [], now: () => NOW }, { minSamples: 1 });
    model.observe(row({ outcome: "failed" }));
    model.observe(row({ capacity: "overload" }));
    model.observe(row({ durationMs: -5 }));
    expect(model.estimate(Q).source).toBe("prior");
  });

  it("a rejected read leaves the prior and never rejects; observed rows stay", async () => {
    const model = createDurationModel({
      readTimings: () => Promise.reject(new Error("disk gone")),
      now: () => NOW,
    });
    await expect(model.load()).resolves.toBeUndefined();
    expect(model.estimate(Q).source).toBe("prior");
    for (const r of ladder(5)) model.observe(r);
    expect(model.estimate(Q).n).toBe(5);
  });

  it("a synchronous throw in the read seam is contained too", async () => {
    const model = createDurationModel({
      readTimings: () => {
        throw new Error("sync failure");
      },
      now: () => NOW,
    });
    await expect(model.load()).resolves.toBeUndefined();
    expect(model.estimate(Q).source).toBe("prior");
  });

  it("a failed load is not retried by a second load()", async () => {
    let reads = 0;
    const model = createDurationModel({
      readTimings: () => {
        reads += 1;
        throw new Error("nope");
      },
      now: () => NOW,
    });
    await model.load();
    await model.load();
    expect(reads).toBe(1);
  });
});

describe("duration estimator: invalid options fall back", () => {
  it("window: 0, negative, NaN, Infinity -> 50", async () => {
    for (const window of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const model = await loaded(ladder(60), { window });
      expect(model.estimate(Q).n).toBe(50);
    }
  });

  it("a fractional window is floored", async () => {
    const model = await loaded(ladder(10), { window: 2.9, minSamples: 1 });
    expect(model.estimate(Q).n).toBe(2);
  });

  it("minSamples: 0, negative, NaN -> 5", async () => {
    for (const minSamples of [0, -1, Number.NaN]) {
      expect((await loaded(ladder(4), { minSamples })).estimate(Q).source).toBe("prior");
      expect((await loaded(ladder(5), { minSamples })).estimate(Q).source).toBe("exact");
    }
  });

  it("maxAgeDays: 0, negative, NaN -> 30", async () => {
    for (const maxAgeDays of [0, -1, Number.NaN]) {
      const young = ladder(5).map(r => ({ ...r, endedAt: NOW - 29 * DAY }));
      const old = ladder(5).map(r => ({ ...r, endedAt: NOW - 31 * DAY }));
      expect((await loaded(young, { maxAgeDays })).estimate(Q).source).toBe("exact");
      expect((await loaded(old, { maxAgeDays })).estimate(Q).source).toBe("prior");
    }
  });

  it("priorMs: negative, NaN, Infinity -> 480000", async () => {
    for (const priorMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await loaded([], { priorMs })).estimate(Q).p50).toBe(480_000);
    }
  });

  it("explicitly undefined options use the defaults", async () => {
    const model = await loaded(ladder(60), { window: undefined, maxAgeDays: undefined, priorMs: undefined, minSamples: undefined });
    expect(model.estimate(Q).n).toBe(50);
    expect((await loaded([], {})).estimate(Q).p90).toBe(480_000);
  });
});
