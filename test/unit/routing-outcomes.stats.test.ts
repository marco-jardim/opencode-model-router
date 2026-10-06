import { afterEach, describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  USAGE,
  parseStatsArgs,
  renderMarkdown,
  runStatsCli,
  summarize,
} from "../../src/routing/outcomes/stats";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { createPersister, nodePersistFs } from "../../src/routing/outcomes/persist";
import { emptyTokenSample } from "../../src/routing/outcomes/cost";
import { DECISIONS_MAX_GENERATIONS, OUTCOMES_CORRUPT_PREFIX, OUTCOMES_FILE, STATS_EXIT, makeKey } from "../../src/routing/outcomes/types";
import type {
  DecisionRow,
  LoadResult,
  LogRow,
  OutcomeKey,
  PersistDeps,
  RatioCell,
  ReadRowsResult,
  RefusalRow,
  StatsCliIO,
  StatsSource,
  StatsTable,
  VerdictRow,
} from "../../src/routing/outcomes/types";
// A type-only import pulls the script into `tsc --noEmit` (scripts/ is outside tsconfig `include`) without running it.
import type * as RoutingStatsScript from "../../scripts/routing-stats";

export type RoutingStatsScriptModule = typeof RoutingStatsScript;

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "routing-stats.ts");

const A = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");
const B = makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5");
const C = makeKey("implement", { origin: "router", id: "fast" }, "anthropic", "claude-haiku-4-5");

const iso = (s: string) => Date.parse(s);
const SINCE = "2026-10-06T00:00:00.000Z";
const UNTIL = "2026-10-07T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function choice(key: OutcomeKey) {
  const parts = key.split("|");
  const agentSeg = parts[1] ?? "router:unknown";
  const origin = agentSeg.startsWith("host:") ? ("host" as const) : ("router" as const);
  return { key, agent: agentSeg.slice(agentSeg.indexOf(":") + 1), origin, model: (parts[2] ?? "").split("#")[0] ?? "", variant: "default" };
}

function decision(id: string, at: string, partial: Partial<DecisionRow> = {}): DecisionRow {
  return {
    v: 1,
    kind: "decision",
    ts: at,
    sessionID: "s1",
    decisionID: id,
    mode: "shadow",
    childSessionID: null,
    facts: { class: "implement", risk: "low", scope: "file", needs: ["edit"], confidence: 0.9, source: "heuristic" },
    chosen: choice(A),
    best: choice(A),
    switched: false,
    pinned: false,
    unit: "ratio",
    costs: {},
    confidence: 0.8,
    reason: "test",
    step: "dispatch",
    resume: false,
    ...partial,
  };
}

function verdict(id: string, at: string, key: OutcomeKey, outcome: VerdictRow["verdict"], step: VerdictRow["step"] = "dispatch"): VerdictRow {
  return { v: 1, kind: "verdict", ts: at, sessionID: "s1", decisionID: id, childSessionID: `c-${id}`, attemptID: `c-${id}:0`, key, verdict: outcome, step };
}

function refusal(id: string, at: string, key: OutcomeKey, step: RefusalRow["step"] = "dispatch"): RefusalRow {
  return { v: 1, kind: "refusal", ts: at, sessionID: "s1", decisionID: id, childSessionID: `c-${id}`, attemptID: `c-${id}:0`, key, step };
}

/** The scenario documented in the comments of each test (window = SINCE ≤ ts < UNTIL). */
function scenario(): LogRow[] {
  return [
    decision("D1", "2026-10-05T23:59:59.000Z"), // before the window
    decision("D2", SINCE, { chosen: choice(A), best: choice(B), unit: "usd", costs: { [A]: 0.5, [B]: 0.2 } }), // exactly at `since`
    decision("D3", "2026-10-06T12:00:00.000Z", {
      facts: { class: "search", risk: "low", scope: "file", needs: [], confidence: 0.9, source: "heuristic" },
      chosen: choice(B),
      best: choice(B),
      unit: "ratio",
      costs: { [B]: 1 },
    }),
    decision("D4", "2026-10-06T13:00:00.000Z", { mode: "enforce", switched: true, chosen: choice(A), best: choice(C), unit: "usd", costs: { [A]: 0.6, [C]: 0.3 } }),
    decision("D5", "2026-10-06T14:00:00.000Z", {
      facts: { class: "review", risk: "high", scope: "repo", needs: [], confidence: 0.9, source: "heuristic" },
      chosen: choice(B),
      best: null,
      pinned: true,
      resume: true,
    }),
    decision("D6", "2026-10-06T15:00:00.000Z", { step: "variant", resume: true, best: null }),
    decision("D7", "2026-10-06T16:00:00.000Z", { step: "retry", best: null }),
    decision("D8", UNTIL), // exactly at `until`: excluded
    verdict("D2", "2026-10-06T01:00:00.000Z", A, "pass"),
    verdict("D3", "2026-10-06T12:05:00.000Z", B, "pass"),
    verdict("D6", "2026-10-06T15:05:00.000Z", A, "fail", "variant"),
    verdict("D7", "2026-10-06T16:05:00.000Z", A, "unverifiable", "retry"),
    verdict("D4", "2026-10-07T01:00:00.000Z", C, "fail"), // lands after `until`
    refusal("D2", "2026-10-06T01:01:00.000Z", A),
  ];
}

const WINDOW = { since: iso(SINCE), until: iso(UNTIL) };
const NONE = { since: null, until: null };

function storeWithMeasuredA() {
  const store = createOutcomeStore({ now: () => iso(SINCE) });
  [0.1, 0.2, 0.3].forEach((cost, i) =>
    store.recordStep(A, { attemptID: `m${i}`, cost, pricing: "priced", tokens: { ...emptyTokenSample(), input: 100, output: 10 }, final: true }),
  );
  return store;
}

function rate(num: number, den: number): RatioCell {
  return { num, den, rate: den === 0 ? null : num / den };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize", () => {
  it("empty window → every count 0, every rate null, no NaN anywhere", () => {
    const table = summarize(null, [], NONE);
    expect(table).toEqual({
      version: 1,
      window: { since: null, until: null },
      dispatches: 0,
      pinned: 0,
      byClass: [],
      byKey: [],
      agreement: { num: 0, den: 0, rate: null },
      switched: { count: 0, share: { num: 0, den: 0, rate: null }, failed: 0, verified: 0 },
      savings: [],
      variantSteps: { taken: 0, passRate: { num: 0, den: 0, rate: null } },
      resumeVsFresh: [
        { step: "dispatch", resume: 0, fresh: 0 },
        { step: "variant", resume: 0, fresh: 0 },
        { step: "retry", resume: 0, fresh: 0 },
        { step: "escalate", resume: 0, fresh: 0 },
      ],
    });
    const text = JSON.stringify(table) + renderMarkdown(table);
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
    // a window that excludes every row looks the same apart from its bounds
    const empty = summarize(null, scenario(), { since: iso("2030-01-01T00:00:00Z"), until: iso("2030-01-02T00:00:00Z") });
    expect(empty.dispatches).toBe(0);
    expect(empty.byKey).toEqual([]);
    expect(empty.window).toEqual({ since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" });
    expect(JSON.stringify(empty)).not.toMatch(/NaN/);
  });

  it("windows rows: `since` is inclusive, `until` exclusive", () => {
    const table = summarize(null, scenario(), WINDOW);
    expect(table.window).toEqual({ since: SINCE, until: UNTIL });
    expect(table.dispatches).toBe(4); // D2 (ts === since) counted; D1 (before) and D8 (ts === until) not
    const atSince = summarize(null, [decision("X", SINCE)], { since: iso(SINCE), until: null });
    expect(atSince.dispatches).toBe(1);
    const atUntil = summarize(null, [decision("X", UNTIL)], { since: null, until: iso(UNTIL) });
    expect(atUntil.dispatches).toBe(0);
    const justBefore = summarize(null, [decision("X", "2026-10-06T23:59:59.999Z")], { since: null, until: iso(UNTIL) });
    expect(justBefore.dispatches).toBe(1);
    // consecutive periods never double-count
    const day1 = summarize(null, scenario(), { since: iso("2026-10-05T00:00:00Z"), until: iso(SINCE) });
    const day2 = summarize(null, scenario(), { since: iso(SINCE), until: iso(UNTIL) });
    const day3 = summarize(null, scenario(), { since: iso(UNTIL), until: null });
    expect(day1.dispatches + day2.dispatches + day3.dispatches).toBe(summarize(null, scenario(), NONE).dispatches);
  });

  it("rows with an unparseable timestamp are never windowed in", () => {
    const bad = { ...decision("X", "not a date") };
    expect(summarize(null, [bad], NONE).dispatches).toBe(0);
  });

  it("columns: dispatches, pinned, by class (sorted), resume vs fresh", () => {
    const table = summarize(null, scenario(), WINDOW);
    expect(table.pinned).toBe(1);
    expect(table.byClass).toEqual([
      { class: "implement", dispatches: 2 },
      { class: "review", dispatches: 1 },
      { class: "search", dispatches: 1 },
    ]);
    expect(table.resumeVsFresh).toEqual([
      { step: "dispatch", resume: 1, fresh: 3 },
      { step: "variant", resume: 1, fresh: 0 },
      { step: "retry", resume: 0, fresh: 1 },
      { step: "escalate", resume: 0, fresh: 0 },
    ]);
    expect(table.variantSteps).toEqual({ taken: 1, passRate: rate(0, 1) });
  });

  it("by key: union of dispatched keys and verdict/refusal keys; switched rows count for best.key", () => {
    const table = summarize(storeWithMeasuredA(), scenario(), WINDOW);
    expect(table.byKey.map((r) => r.key)).toEqual([A, B, C].sort());
    const row = (key: OutcomeKey) => table.byKey.find((r) => r.key === key);
    expect(row(A)).toEqual({
      key: A,
      dispatches: 1,
      attempts: 3,
      pass: 1,
      fail: 1,
      unverifiable: 1,
      passRate: rate(1, 2),
      falseRefusals: 1,
      refusalRate: rate(1, 3),
      measuredUSD: { mean: expect.closeTo(0.2, 12) as unknown as number, n: 3 },
    });
    expect(row(B)).toMatchObject({ dispatches: 2, attempts: 2, pass: 1, fail: 0, passRate: rate(1, 1), falseRefusals: 0, refusalRate: rate(0, 2), measuredUSD: null });
    // D4 was switched to C; its fail verdict lands after `until`, so C has no windowed verdicts
    expect(row(C)).toMatchObject({ dispatches: 1, attempts: 1, pass: 0, fail: 0, passRate: rate(0, 0), measuredUSD: null });
  });

  it("a key that only has verdict rows (or refusals without a decision id) still gets a line", () => {
    const only = makeKey("review", { origin: "host", id: "general" }, "openai", "gpt");
    const rows = [verdict("Z", SINCE, only, "fail"), { ...refusal("Z2", SINCE, only), decisionID: null }];
    const table = summarize(null, rows, NONE);
    expect(table.byKey).toEqual([
      {
        key: only,
        dispatches: 0,
        attempts: 0,
        pass: 0,
        fail: 1,
        unverifiable: 0,
        passRate: rate(0, 1),
        falseRefusals: 1,
        refusalRate: rate(0, 0), // no attempts in the window: no rate
        measuredUSD: null,
      },
    ]);
    expect(table.dispatches).toBe(0);
  });

  it("QA-1.3-13: a refusal counts only for an attempt whose decision row is in the window, so the rate never passes 100 %", () => {
    const before = "2026-10-05T10:00:00.000Z";
    const rows: LogRow[] = [
      decision("old1", before), // before the window
      decision("old2", before),
      refusal("old1", SINCE, A), // refusals land inside the window, their attempts did not
      refusal("old2", SINCE, A),
      decision("new1", "2026-10-06T10:00:00.000Z"),
      refusal("new1", "2026-10-06T10:05:00.000Z", A),
    ];
    const windowed = summarize(null, rows, { since: iso(SINCE), until: iso(UNTIL) });
    const a = windowed.byKey.find((r) => r.key === A);
    expect(a).toMatchObject({ attempts: 1, falseRefusals: 1, refusalRate: rate(1, 1) });
    // over the whole log all three refusals are counted against all three attempts
    const everything = summarize(null, rows, NONE).byKey.find((r) => r.key === A);
    expect(everything).toMatchObject({ attempts: 3, falseRefusals: 3, refusalRate: rate(3, 3) });
    // only the refusals of out-of-window attempts: no line, no rate
    expect(summarize(null, rows.slice(0, 4), { since: iso(SINCE), until: iso(UNTIL) }).byKey).toEqual([]);
    // even a duplicated refusal for one attempt cannot push the rate above 100 %
    const duplicated = summarize(null, [decision("d", SINCE), refusal("d", SINCE, A), refusal("d", SINCE, A)], NONE).byKey[0];
    expect(duplicated?.falseRefusals).toBe(2);
    expect(duplicated?.refusalRate).toEqual(rate(1, 1));
  });

  it("QA-1.3-13: `verified` counts switched dispatches whose outcome is known (pass/fail verdict or refusal; unverifiable does not)", () => {
    const sw = (id: string) => decision(id, SINCE, { switched: true, best: choice(C) });
    const rows: LogRow[] = [
      sw("s1"),
      sw("s2"),
      sw("s3"),
      sw("s4"),
      sw("s5"),
      verdict("s1", SINCE, C, "pass"),
      verdict("s2", SINCE, C, "fail"),
      verdict("s3", SINCE, C, "unverifiable"),
      refusal("s4", UNTIL, C), // after the window, still known
    ];
    expect(summarize(null, rows, { since: iso(SINCE), until: iso(UNTIL) }).switched).toEqual({
      count: 5,
      share: rate(5, 5),
      failed: 2, // s2 (fail) and s4 (refusal)
      verified: 3, // s1, s2, s4
    });
    expect(renderMarkdown(summarize(null, rows, NONE))).toContain("failed 2 (verified 3 of 5)");
  });

  it("measuredUSD comes from the store (lifetime) and is null without a store or without samples", () => {
    expect(summarize(null, scenario(), WINDOW).byKey.every((r) => r.measuredUSD === null)).toBe(true);
    const withStore = summarize(storeWithMeasuredA(), scenario(), WINDOW);
    expect(withStore.byKey.find((r) => r.key === A)?.measuredUSD?.n).toBe(3);
    expect(withStore.byKey.find((r) => r.key === B)?.measuredUSD).toBeNull();
  });

  it("agreement: best == chosen over non-pinned dispatch rows that have a best", () => {
    const table = summarize(null, scenario(), WINDOW);
    expect(table.agreement).toEqual(rate(1, 3)); // D2 no, D3 yes, D4 no; D5 pinned; D6/D7 are not dispatches
  });

  it("agreement with 0 non-pinned rows → n/a (den 0, rate null), rendered as n/a", () => {
    const rows = [decision("P1", SINCE, { pinned: true, best: null }), decision("P2", SINCE, { pinned: true })];
    const table = summarize(null, rows, NONE);
    expect(table.dispatches).toBe(2);
    expect(table.pinned).toBe(2);
    expect(table.agreement).toEqual({ num: 0, den: 0, rate: null });
    expect(table.switched.share).toEqual({ num: 0, den: 0, rate: null });
    expect(renderMarkdown(table)).toContain("| Agreement (best == chosen, non-pinned) | n/a |");
    expect(renderMarkdown(table)).toContain("| Switched | 0 of 0 non-pinned (n/a); failed 0 (verified 0 of 0) |");
    // best === null rows do not enter the agreement denominator either
    const noBest = summarize(null, [decision("N1", SINCE, { best: null })], NONE);
    expect(noBest.agreement).toEqual({ num: 0, den: 0, rate: null });
  });

  it("switched: count, share of non-pinned, and failed (fail verdict or refusal anywhere in the log)", () => {
    const table = summarize(null, scenario(), WINDOW);
    expect(table.switched).toEqual({ count: 1, share: rate(1, 3), failed: 1, verified: 1 });
    // the failing verdict is outside the window; windowing the other way round must not change `failed`
    const justD4 = summarize(null, scenario(), { since: iso("2026-10-06T13:00:00Z"), until: iso("2026-10-06T13:30:00Z") });
    expect(justD4.switched.failed).toBe(1);
    // pass and unverifiable do not count; a refusal does
    const base = decision("S", SINCE, { switched: true, best: choice(C) });
    expect(summarize(null, [base, verdict("S", SINCE, C, "pass")], NONE).switched.failed).toBe(0);
    expect(summarize(null, [base, verdict("S", SINCE, C, "unverifiable")], NONE).switched.failed).toBe(0);
    expect(summarize(null, [base, refusal("S", UNTIL, C)], NONE).switched.failed).toBe(1);
    expect(summarize(null, [base, verdict("other", SINCE, C, "fail")], NONE).switched.failed).toBe(0);
    // pinned switched rows are not "switched" for D17
    expect(summarize(null, [{ ...base, pinned: true }], NONE).switched).toEqual({ count: 0, share: rate(0, 0), failed: 0, verified: 0 });
  });

  it("mixed units → one savings row per unit, never summed together", () => {
    const table = summarize(null, scenario(), WINDOW);
    expect(table.savings).toHaveLength(2);
    expect(table.savings[0]).toEqual({ unit: "ratio", total: 0, rows: 1 });
    expect(table.savings[1]?.unit).toBe("usd");
    expect(table.savings[1]?.rows).toBe(2);
    expect(table.savings[1]?.total).toBeCloseTo(0.6, 12);
    const md = renderMarkdown(table);
    expect(md).toContain("| Estimated savings (ratio) | 0.00 over 1 rows |");
    expect(md).toContain("| Estimated savings (usd) | $0.6000 over 2 rows |");
  });

  it("savings only count non-pinned rows with a best and two finite costs", () => {
    const rows = [
      decision("a", SINCE, { chosen: choice(A), best: choice(B), unit: "usd", costs: { [A]: 1, [B]: 0.25 } }),
      decision("b", SINCE, { chosen: choice(A), best: choice(B), unit: "usd", costs: { [A]: 1 } }), // best cost missing
      decision("c", SINCE, { chosen: choice(A), best: null, unit: "usd", costs: { [A]: 1 } }),
      decision("d", SINCE, { chosen: choice(A), best: choice(B), unit: "usd", pinned: true, costs: { [A]: 9, [B]: 1 } }),
      decision("e", SINCE, { chosen: choice(A), best: choice(B), unit: "usd", step: "retry", costs: { [A]: 9, [B]: 1 } }),
    ];
    expect(summarize(null, rows, NONE).savings).toEqual([{ unit: "usd", total: 0.75, rows: 1 }]);
  });

  it("is independent of the row order (including float sums)", () => {
    const many: LogRow[] = [];
    for (let i = 0; i < 40; i++) {
      many.push(
        decision(`m${i}`, new Date(iso(SINCE) + i * 60_000).toISOString(), {
          chosen: choice(i % 2 === 0 ? A : B),
          best: choice(C),
          unit: i % 3 === 0 ? "ratio" : "usd",
          costs: { [A]: 0.1 * (i + 1), [B]: 0.3 * i, [C]: 0.07 * i },
          switched: i % 5 === 0,
          step: i % 7 === 0 ? "variant" : "dispatch",
          resume: i % 4 === 0,
        }),
        verdict(`m${i}`, new Date(iso(SINCE) + i * 60_000 + 1).toISOString(), i % 2 === 0 ? A : B, i % 3 === 0 ? "fail" : "pass"),
      );
    }
    const reference = summarize(null, many, NONE);
    const referenceMd = renderMarkdown(reference);
    for (const seed of [1, 2, 3, 4, 5]) {
      const table = summarize(null, shuffled(many, seed), NONE);
      expect(table).toEqual(reference);
      expect(renderMarkdown(table)).toBe(referenceMd);
    }
  });

  it("does not mutate its inputs", () => {
    const rows = scenario();
    const frozen = JSON.stringify(rows);
    summarize(storeWithMeasuredA(), rows, WINDOW);
    expect(JSON.stringify(rows)).toBe(frozen);
  });

  it("non-finite window bounds are treated as unbounded", () => {
    const table = summarize(null, scenario(), { since: Number.NaN, until: Number.POSITIVE_INFINITY });
    expect(table.window).toEqual({ since: null, until: null });
    expect(table.dispatches).toBe(6); // D1..D5 and D8 are dispatch rows; D6/D7 are ladder steps
  });
});

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

describe("renderMarkdown", () => {
  const fixed: StatsTable = {
    version: 1,
    window: { since: "2026-10-06T00:00:00.000Z", until: null },
    dispatches: 7,
    pinned: 1,
    byClass: [
      { class: "implement", dispatches: 4 },
      { class: "search", dispatches: 3 },
    ],
    byKey: [
      {
        key: A,
        dispatches: 4,
        attempts: 6,
        pass: 3,
        fail: 1,
        unverifiable: 1,
        passRate: rate(3, 4),
        falseRefusals: 1,
        refusalRate: rate(1, 6),
        measuredUSD: { mean: 0.0123456, n: 4 },
      },
      {
        key: B,
        dispatches: 3,
        attempts: 3,
        pass: 0,
        fail: 0,
        unverifiable: 0,
        passRate: rate(0, 0),
        falseRefusals: 0,
        refusalRate: rate(0, 3),
        measuredUSD: null,
      },
    ],
    agreement: rate(2, 5),
    switched: { count: 2, share: rate(2, 6), failed: 1, verified: 1 },
    savings: [
      { unit: "ratio", total: 1.5, rows: 3 },
      { unit: "usd", total: 0.01234, rows: 2 },
    ],
    variantSteps: { taken: 3, passRate: rate(1, 2) },
    resumeVsFresh: [
      { step: "dispatch", resume: 1, fresh: 6 },
      { step: "variant", resume: 2, fresh: 1 },
      { step: "retry", resume: 0, fresh: 2 },
      { step: "escalate", resume: 0, fresh: 0 },
    ],
  };

  const expected = [
    "## Routing stats",
    "",
    "Window: 2026-10-06T00:00:00.000Z → open",
    "",
    "| Metric | Value |",
    "|---|---|",
    "| Dispatches | 7 |",
    "| Pinned | 1 |",
    "| Agreement (best == chosen, non-pinned) | 2/5 (40.0%) |",
    "| Switched | 2 of 6 non-pinned (33.3%); failed 1 (verified 1 of 2) |",
    "| Estimated savings (ratio) | 1.50 over 3 rows |",
    "| Estimated savings (usd) | $0.0123 over 2 rows |",
    "| Variant steps | 3 taken; pass 1/2 (50.0%) |",
    "",
    "### By class",
    "",
    "| Class | Dispatches |",
    "|---|---|",
    "| implement | 4 |",
    "| search | 3 |",
    "",
    "### By key",
    "",
    "| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/attempt (lifetime) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    "| implement\\|router:medium\\|anthropic/claude-sonnet-5-5#default | 4 | 6 | 3 | 1 | 1 | 3/4 (75.0%) | 1 | 1/6 (16.7%) | $0.0123 (n=4) |",
    "| search\\|host:explore\\|anthropic/claude-haiku-4-5#default | 3 | 3 | 0 | 0 | 0 | n/a | 0 | 0/3 (0.0%) | n/a |",
    "",
    "### Resume vs fresh",
    "",
    "| Step | Resume | Fresh |",
    "|---|---|---|",
    "| dispatch | 1 | 6 |",
    "| variant | 2 | 1 |",
    "| retry | 0 | 2 |",
    "| escalate | 0 | 0 |",
    "",
  ].join("\n");

  it("matches the documented template exactly (snapshot of a fixed table)", () => {
    expect(renderMarkdown(fixed)).toBe(expected);
  });

  it("is deterministic and uses \\n only, one blank line between blocks, one trailing newline", () => {
    const out = renderMarkdown(fixed);
    expect(renderMarkdown(fixed)).toBe(out);
    expect(out).not.toContain("\r");
    expect(out).not.toMatch(/\n\n\n/);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out.startsWith("## Routing stats\n\nWindow: ")).toBe(true);
  });

  it("an empty table prints a valid report: n/a, _none_ in place of empty tables, four zero rows", () => {
    const out = renderMarkdown(summarize(null, [], NONE));
    expect(out).toBe(
      [
        "## Routing stats",
        "",
        "Window: start → open",
        "",
        "| Metric | Value |",
        "|---|---|",
        "| Dispatches | 0 |",
        "| Pinned | 0 |",
        "| Agreement (best == chosen, non-pinned) | n/a |",
        "| Switched | 0 of 0 non-pinned (n/a); failed 0 (verified 0 of 0) |",
        "| Estimated savings | n/a |",
        "| Variant steps | 0 taken; pass n/a |",
        "",
        "### By class",
        "",
        "_none_",
        "",
        "### By key",
        "",
        "_none_",
        "",
        "### Resume vs fresh",
        "",
        "| Step | Resume | Fresh |",
        "|---|---|---|",
        "| dispatch | 0 | 0 |",
        "| variant | 0 | 0 |",
        "| retry | 0 | 0 |",
        "| escalate | 0 | 0 |",
        "",
      ].join("\n"),
    );
  });

  it("rows shuffled → identical output; the snapshot of the scenario is stable", () => {
    const rows = scenario();
    const reference = renderMarkdown(summarize(storeWithMeasuredA(), rows, WINDOW));
    for (const seed of [11, 12, 13]) expect(renderMarkdown(summarize(storeWithMeasuredA(), shuffled(rows, seed), WINDOW))).toBe(reference);
    expect(reference).toContain("| Dispatches | 4 |");
    expect(reference).toContain("| Agreement (best == chosen, non-pinned) | 1/3 (33.3%) |");
    expect(reference).toContain("| Switched | 1 of 3 non-pinned (33.3%); failed 1 (verified 1 of 1) |");
    expect(reference).toContain("| Variant steps | 1 taken; pass 0/1 (0.0%) |");
    expect(reference).toContain("$0.2000 (n=3) |");
    expect(reference).toContain("Window: 2026-10-06T00:00:00.000Z → 2026-10-07T00:00:00.000Z");
  });

  it("never prints -0.00 or $-0.0000, and keeps the sign of real negatives", () => {
    const table: StatsTable = {
      ...summarize(null, [], NONE),
      savings: [
        { unit: "ratio", total: -0.001, rows: 1 },
        { unit: "usd", total: -0.00001, rows: 1 },
      ],
    };
    const out = renderMarkdown(table);
    expect(out).toContain("| Estimated savings (ratio) | 0.00 over 1 rows |");
    expect(out).toContain("| Estimated savings (usd) | $0.0000 over 1 rows |");
    expect(out).not.toContain("-0.0");
    const negative = renderMarkdown({ ...table, savings: [{ unit: "usd", total: -0.5, rows: 2 }] });
    expect(negative).toContain("| Estimated savings (usd) | $-0.5000 over 2 rows |");
  });

  it("escapes pipes and flattens newlines in cells", () => {
    const table: StatsTable = {
      ...summarize(null, [], NONE),
      byClass: [{ class: "a|b\nc\r\nd", dispatches: 1 }],
    };
    expect(renderMarkdown(table)).toContain("| a\\|b c d | 1 |");
  });
});

// ---------------------------------------------------------------------------
// parseStatsArgs
// ---------------------------------------------------------------------------

describe("parseStatsArgs", () => {
  const ok = (argv: string[]) => {
    const r = parseStatsArgs(argv);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.args;
  };
  const err = (argv: string[]) => {
    const r = parseStatsArgs(argv);
    if (r.ok) throw new Error(`expected an error for ${JSON.stringify(argv)}`);
    return r.error;
  };

  it("no arguments → everything unbounded", () => {
    expect(ok([])).toEqual({ since: null, until: null, json: false, dir: null, help: false });
  });

  it("accepts both `--flag value` and `--flag=value`, plus --json and --help/-h", () => {
    const a = ok(["--since", "2026-10-06T12:00:00Z", "--until=2026-10-07", "--json", "--dir", "some dir"]);
    expect(a).toEqual({ since: Date.parse("2026-10-06T12:00:00Z"), until: Date.UTC(2026, 9, 7), json: true, dir: "some dir", help: false });
    expect(ok(["--dir=C:\\x\\y"]).dir).toBe("C:\\x\\y");
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
  });

  it("a date alone is UTC midnight; date-times need Z or an offset", () => {
    expect(ok(["--since", "2026-10-06"]).since).toBe(Date.UTC(2026, 9, 6));
    expect(ok(["--since", "2026-10-06T12:00Z"]).since).toBe(Date.UTC(2026, 9, 6, 12));
    expect(ok(["--since", "2026-10-06T12:00:30.5Z"]).since).toBe(Date.UTC(2026, 9, 6, 12, 0, 30, 500));
    expect(ok(["--since", "2026-10-06T12:00:00+02:00"]).since).toBe(Date.UTC(2026, 9, 6, 10));
    expect(ok(["--since", "2026-10-06T12:00:00-03:30"]).since).toBe(Date.UTC(2026, 9, 6, 15, 30));
    expect(err(["--since", "2026-10-06T12:00:00"])).toContain("Z or an offset");
    expect(err(["--since", "2026-10-06T12:00"])).toContain("--since");
  });

  it.each([
    ["not a date", "yesterday"],
    ["a US date", "10/06/2026"],
    ["a month 13", "2026-13-01"],
    ["February 30th (V8 would roll it over)", "2026-02-30"],
    ["a day 32", "2026-01-32"],
    ["hour 24", "2026-10-06T24:00:00Z"],
    ["minute 60", "2026-10-06T12:60:00Z"],
    ["second 60", "2026-10-06T12:00:60Z"],
    ["a 4-digit fraction", "2026-10-06T12:00:00.1234Z"],
    ["an offset without a colon", "2026-10-06T12:00:00+0200"],
    ["a space instead of T", "2026-10-06 12:00:00Z"],
    ["trailing junk", "2026-10-06Z"],
  ])("rejects %s", (_name, value) => {
    expect(err(["--since", value])).toContain("invalid --since value");
    expect(err(["--until", value])).toContain("invalid --until value");
  });

  it("accepts a leap day and rejects it in a common year", () => {
    expect(ok(["--since", "2028-02-29"]).since).toBe(Date.UTC(2028, 1, 29));
    expect(err(["--since", "2026-02-29"])).toContain("invalid");
  });

  it("repeated flags are errors", () => {
    expect(err(["--since", "2026-10-01", "--since", "2026-10-02"])).toBe("--since given more than once");
    expect(err(["--since=2026-10-01", "--since", "2026-10-02"])).toContain("more than once");
    expect(err(["--json", "--json"])).toContain("more than once");
    expect(err(["--dir", "a", "--dir=b"])).toContain("more than once");
    expect(err(["-h", "--help"])).toContain("more than once");
  });

  it("missing values are errors", () => {
    expect(err(["--since"])).toBe("--since requires a value");
    expect(err(["--until", "--json"])).toBe("--until requires a value");
    expect(err(["--dir"])).toBe("--dir requires a value");
    expect(err(["--dir="])).toBe("--dir requires a value");
    expect(err(["--since="])).toBe("--since requires a value");
  });

  it("unknown arguments and flags with a stray value are errors", () => {
    expect(err(["--sinse", "2026-10-01"])).toBe("unknown argument: --sinse");
    expect(err(["positional"])).toBe("unknown argument: positional");
    expect(err(["-x"])).toBe("unknown argument: -x");
    expect(err(["--json=true"])).toBe("--json does not take a value");
    expect(err(["--help=1"])).toBe("--help does not take a value");
  });

  it("since >= until is an error; since < until is fine", () => {
    expect(err(["--since", "2026-10-07", "--until", "2026-10-06"])).toBe("--since must be earlier than --until");
    expect(err(["--since", "2026-10-06", "--until", "2026-10-06"])).toBe("--since must be earlier than --until");
    expect(err(["--until", "2026-10-06T10:00:00Z", "--since", "2026-10-06T12:00:00+01:00"])).toContain("earlier");
    expect(ok(["--since", "2026-10-06", "--until", "2026-10-06T00:00:00.001Z"]).until).toBe(Date.UTC(2026, 9, 6, 0, 0, 0, 1));
  });
});

// ---------------------------------------------------------------------------
// runStatsCli (fake IO)
// ---------------------------------------------------------------------------

function loadResult(partial: Partial<LoadResult> = {}): LoadResult {
  return { status: "missing", snapshot: { version: 1, entries: {} }, dropped: 0, savedAt: null, message: null, ...partial };
}

function readResult(partial: Partial<ReadRowsResult> = {}): ReadRowsResult {
  return { rows: [], skipped: 0, files: [], oldestTs: null, generations: 0, ...partial };
}

function fakeIo(source: Partial<StatsSource> = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const load = vi.fn<StatsSource["load"]>(source.load ?? (async () => loadResult()));
  const readRows = vi.fn<StatsSource["readRows"]>(source.readRows ?? (async (): Promise<ReadRowsResult> => readResult()));
  const open = vi.fn<StatsCliIO["open"]>((dir) => ({ dir, load, readRows }));
  const io: StatsCliIO = { defaultDir: "/default/dir", open, stdout: (t) => void out.push(t), stderr: (t) => void errs.push(t) };
  return { io, out, errs, load, readRows, open };
}

describe("runStatsCli", () => {
  it("--help prints USAGE on stdout and exits 0 without opening anything", async () => {
    const { io, out, errs, open } = fakeIo();
    expect(await runStatsCli(["--help"], io)).toBe(0);
    expect(out.join("")).toBe(USAGE);
    expect(errs).toEqual([]);
    expect(open).not.toHaveBeenCalled();
    expect(USAGE.startsWith("Usage: node scripts/routing-stats.ts [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]\n")).toBe(true);
    expect(USAGE.endsWith("\n")).toBe(true);
  });

  it("QA-1.3-8: USAGE documents the plain-node form (any shell) and the PowerShell form of the npm script", () => {
    expect(USAGE).toContain("node scripts/routing-stats.ts");
    expect(USAGE).toContain("npm run routing:stats -- [--since <ISO>]");
    expect(USAGE).toContain(`PowerShell swallows a bare "--": write npm run routing:stats '--' --since <ISO>`);
    expect(USAGE).toContain("resolved like routing.outcomes.path");
  });

  it("a usage error prints the error and USAGE on stderr and exits 2", async () => {
    const { io, out, errs, open } = fakeIo();
    expect(await runStatsCli(["--bogus"], io)).toBe(STATS_EXIT.usage);
    expect(STATS_EXIT.usage).toBe(2);
    expect(errs.join("")).toBe(`routing-stats: unknown argument: --bogus\n${USAGE}`);
    expect(out).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("a missing store is an empty table with exit 0, read-only (quarantine: false)", async () => {
    const { io, out, errs, load, open } = fakeIo();
    expect(await runStatsCli([], io)).toBe(0);
    expect(open).toHaveBeenCalledWith("/default/dir");
    expect(load).toHaveBeenCalledWith({ quarantine: false });
    expect(out.join("")).toBe(renderMarkdown(summarize(createOutcomeStore(), [], NONE)));
    expect(errs).toEqual(["routing-stats: no outcome data in /default/dir\n"]); // QA-1.3-5: exit 0, but say so
  });

  it("QA-1.3-5: the `no outcome data` note appears only when there is neither a store nor any decision-log file", async () => {
    const withLog = fakeIo({ readRows: async () => readResult({ rows: scenario(), files: ["decisions.jsonl"] }) });
    expect(await runStatsCli([], withLog.io)).toBe(0);
    expect(withLog.errs).toEqual([]);
    const withStore = fakeIo({ load: async () => loadResult({ status: "ok" }) });
    expect(await runStatsCli(["--dir", "somewhere"], withStore.io)).toBe(0);
    expect(withStore.errs).toEqual([]);
    const named = fakeIo();
    await runStatsCli(["--dir", "/typo/dir"], named.io);
    expect(named.errs).toEqual(["routing-stats: no outcome data in /typo/dir\n"]);
  });

  it("--dir overrides the default directory", async () => {
    const { io, open } = fakeIo();
    await runStatsCli(["--dir", "elsewhere"], io);
    expect(open).toHaveBeenCalledWith("elsewhere");
  });

  it.each(["corrupt", "unsupported-version"] as const)("a %s store → exit 1, clear message, nothing on stdout", async (status) => {
    const { io, out, errs, readRows } = fakeIo({ load: async () => loadResult({ status, message: "C:\\dir\\outcomes.json: something is wrong" }) });
    expect(await runStatsCli([], io)).toBe(STATS_EXIT.corrupt);
    expect(STATS_EXIT.corrupt).toBe(1);
    expect(errs.join("")).toBe("routing-stats: corrupted outcome store: C:\\dir\\outcomes.json: something is wrong\n");
    expect(out).toEqual([]);
    expect(readRows).not.toHaveBeenCalled();
  });

  it("dropped entries and skipped log lines are warnings; the table is still printed", async () => {
    const { io, out, errs } = fakeIo({
      load: async () => loadResult({ status: "ok", dropped: 2, message: "X: 2 invalid entries dropped" }),
      readRows: async () => readResult({ rows: scenario(), skipped: 3 }),
    });
    expect(await runStatsCli(["--since", SINCE, "--until", UNTIL], io)).toBe(0);
    expect(errs).toEqual(["routing-stats: warning: X: 2 invalid entries dropped\n", "routing-stats: skipped 3 unreadable decision-log line(s)\n"]);
    expect(out.join("")).toBe(renderMarkdown(summarize(createOutcomeStore(), scenario(), WINDOW)));
  });

  it("QA-1.3-10: warns when the log has rotated and the window starts before (or without) its oldest retained row", async () => {
    const oldest = "2026-10-05T08:00:00.000Z";
    const rotated = { readRows: async () => readResult({ rows: scenario(), oldestTs: oldest, generations: DECISIONS_MAX_GENERATIONS, files: ["g1", "g2", "g3", "live"] }) };
    const warning = (since?: string) => async () => {
      const { io, errs, out } = fakeIo(rotated);
      expect(await runStatsCli(since === undefined ? [] : ["--since", since], io)).toBe(0);
      expect(out.join("")).toContain("## Routing stats");
      return errs.join("");
    };
    expect(await warning()()).toBe(`routing-stats: warning: the decision log has rotated; its oldest retained row is ${oldest}, so an unbounded window may be incomplete\n`);
    expect(await warning("2026-10-01")()).toContain("so this window may be incomplete");
    expect(await warning("2026-10-05T07:59:59Z")()).toContain("may be incomplete");
    expect(await warning(oldest)()).toBe(""); // the window starts at the oldest retained row: nothing is missing
    expect(await warning("2026-10-06")()).toBe("");
    // QA-1.3-19: fewer generations than the retention limit means nothing was pruned yet: no warning
    for (const generations of [1, DECISIONS_MAX_GENERATIONS - 1]) {
      const young = fakeIo({ readRows: async () => readResult({ rows: scenario(), oldestTs: oldest, generations, files: ["g1", "live"] }) });
      await runStatsCli([], young.io);
      expect(young.errs, `generations ${generations}`).toEqual([]);
    }
    // no rotated generation, or no rows: nothing to warn about
    const never = fakeIo({ readRows: async () => readResult({ rows: scenario(), oldestTs: oldest, generations: 0, files: ["live"] }) });
    await runStatsCli([], never.io);
    expect(never.errs).toEqual([]);
    const empty = fakeIo({ readRows: async () => readResult({ generations: DECISIONS_MAX_GENERATIONS, files: ["g1"] }) });
    await runStatsCli([], empty.io);
    expect(empty.errs).toEqual([]);
  });

  it("--json prints the StatsTable as indented JSON", async () => {
    const snapshot = storeWithMeasuredA().snapshot();
    const { io, out } = fakeIo({
      load: async () => loadResult({ status: "ok", snapshot }),
      readRows: async () => readResult({ rows: scenario() }),
    });
    expect(await runStatsCli(["--json", "--since", SINCE, "--until", UNTIL], io)).toBe(0);
    const text = out.join("");
    const expectedStore = createOutcomeStore();
    expectedStore.fromSnapshot(snapshot);
    expect(text).toBe(JSON.stringify(summarize(expectedStore, scenario(), WINDOW), null, 2) + "\n");
    expect(JSON.parse(text).byKey).toHaveLength(3);
  });

  it("an unexpected error is reported as `routing-stats: <message>` with exit 1, and never thrown", async () => {
    const { io, errs } = fakeIo({
      load: async () => {
        throw new Error("boom");
      },
    });
    expect(await runStatsCli([], io)).toBe(1);
    expect(errs.join("")).toBe("routing-stats: boom\n");

    const failing: StatsCliIO = {
      ...io,
      open: () => {
        throw "plain string";
      },
      stderr: () => {
        throw new Error("stderr closed");
      },
    };
    expect(await runStatsCli([], failing)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The script, against a real directory
// ---------------------------------------------------------------------------

describe("scripts/routing-stats.ts (plain node)", () => {
  const made: string[] = [];
  afterEach(async () => {
    while (made.length > 0) await rm(made.pop() as string, { recursive: true, force: true });
  });

  const realDeps = (): PersistDeps => ({ fs: nodePersistFs(), now: Date.now, sleep: async () => undefined, logger: { warn() {} }, pid: process.pid });

  async function parentDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "omr-routing-stats-"));
    made.push(dir);
    return dir;
  }

  /** Writes a fixture through the real persister: a store with measured cost for A, plus the scenario rows. */
  async function writeFixture(dir: string): Promise<void> {
    const persister = createPersister(dir, realDeps());
    const store = storeWithMeasuredA();
    store.recordVerdict(A, "pass", { attemptID: "f1", step: "dispatch" });
    store.recordVerdict(B, "fail", { attemptID: "f2", step: "dispatch" });
    expect(await persister.saveSnapshot(store.snapshot())).toEqual({ ok: true });
    const rows = scenario();
    expect(await persister.appendRows(rows.slice(0, 7))).toEqual({ ok: true });
    expect(await persister.appendRows(rows.slice(7))).toEqual({ ok: true });
  }

  async function expectedFor(dir: string, since: number | null, until: number | null): Promise<string> {
    const persister = createPersister(dir, realDeps());
    const loaded = await persister.load({ quarantine: false });
    const store = createOutcomeStore();
    if (loaded.status === "ok") store.fromSnapshot(loaded.snapshot);
    const { rows } = await persister.readRows();
    return renderMarkdown(summarize(store, rows, { since, until }));
  }

  function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: options.cwd ?? REPO_ROOT, env: options.env ?? process.env, encoding: "buffer", timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString("utf8"), error: result.error };
  }

  it("prints exactly the module's output for the same directory and window (byte for byte)", async () => {
    const parent = await parentDir();
    const dir = join(parent, "outcomes");
    await writeFixture(dir);
    const expected = await expectedFor(dir, iso(SINCE), iso(UNTIL));
    expect(expected).toContain("| Dispatches | 4 |");

    const result = run(["--dir", dir, "--since", SINCE, "--until", UNTIL]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Buffer.from(expected, "utf8").equals(result.stdout)).toBe(true);

    // unbounded window, and the same data through the `--since=` form with a date alone
    const all = run(["--dir", dir]);
    expect(Buffer.from(await expectedFor(dir, null, null), "utf8").equals(all.stdout)).toBe(true);
    const dateOnly = run([`--dir=${dir}`, "--since=2026-10-06", "--until=2026-10-07"]);
    expect(Buffer.from(expected, "utf8").equals(dateOnly.stdout)).toBe(true);
  }, 60_000);

  it("--json matches JSON.stringify(summarize(...), null, 2)", async () => {
    const parent = await parentDir();
    const dir = join(parent, "outcomes");
    await writeFixture(dir);
    const persister = createPersister(dir, realDeps());
    const loaded = await persister.load({ quarantine: false });
    const store = createOutcomeStore();
    store.fromSnapshot(loaded.snapshot);
    const expected = JSON.stringify(summarize(store, (await persister.readRows()).rows, WINDOW), null, 2) + "\n";
    const result = run(["--dir", dir, "--since", SINCE, "--until", UNTIL, "--json"]);
    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(expected);
  }, 60_000);

  it("QA-1.3-5: a relative --dir resolves like routing.outcomes.path: under the default directory, not the cwd", async () => {
    const parent = await parentDir();
    const cwdParent = await parentDir();
    const underDefault = join(parent, "opencode-model-router-trajectory", "rel-outcomes");
    await writeFixture(underDefault);
    await mkdir(join(cwdParent, "rel-outcomes"), { recursive: true }); // a decoy in the working directory
    const env = { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent };
    const result = run(["--dir", "rel-outcomes", "--since", SINCE, "--until", UNTIL], { cwd: cwdParent, env });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.toString("utf8")).toBe(await expectedFor(underDefault, iso(SINCE), iso(UNTIL)));
    expect(await readdir(join(cwdParent, "rel-outcomes"))).toEqual([]);
  }, 60_000);

  it("QA-1.3-5: --dir ~/x expands ~ to the home directory, like routing.outcomes.path", async () => {
    const home = await parentDir();
    await writeFixture(join(home, "stats-fixture"));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const result = run(["--dir", "~/stats-fixture", "--since", SINCE, "--until", UNTIL], { env });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.toString("utf8")).toBe(await expectedFor(join(home, "stats-fixture"), iso(SINCE), iso(UNTIL)));
    const tilde = run(["--dir", "~\\stats-fixture", "--since", SINCE, "--until", UNTIL], { env });
    if (process.platform === "win32") expect(tilde.stdout.toString("utf8")).toBe(result.stdout.toString("utf8"));
  }, 60_000);

  it("without --dir it reads <os tmpdir>/opencode-model-router-trajectory (here: a private tmpdir)", async () => {
    const parent = await parentDir();
    const dir = join(parent, "opencode-model-router-trajectory");
    await writeFixture(dir);
    await writeFile(join(dir, "ses_1.scorecard.log"), "scorecard\n", "utf8");
    const env = { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent };
    const result = run(["--since", SINCE, "--until", UNTIL], { env });
    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe(await expectedFor(dir, iso(SINCE), iso(UNTIL)));
    expect(await readFile(join(dir, "ses_1.scorecard.log"), "utf8")).toBe("scorecard\n");
  }, 60_000);

  it("an empty store prints a valid table and creates nothing", async () => {
    const parent = await parentDir();
    const missing = join(parent, "never-created");
    const empty = join(parent, "empty");
    await mkdir(empty, { recursive: true });
    const expected = renderMarkdown(summarize(createOutcomeStore(), [], NONE));

    for (const dir of [missing, empty]) {
      const result = run(["--dir", dir]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe(`routing-stats: no outcome data in ${dir}\n`); // QA-1.3-5
      expect(result.stdout.toString("utf8")).toBe(expected);
    }
    await expect(stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(empty)).toEqual([]);
    expect(expected).toContain("| Dispatches | 0 |");
    expect(expected).toContain("_none_");
  }, 60_000);

  it("a corrupted store exits non-zero with a clear message, prints no table, and leaves the files alone", async () => {
    const parent = await parentDir();
    const dir = join(parent, "outcomes");
    await mkdir(dir, { recursive: true });
    const file = join(dir, OUTCOMES_FILE);
    await writeFile(file, '{"schema": "opencode-model-router.outcomes", "version": 1, "entries": {', "utf8");

    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stdout.length).toBe(0);
    expect(result.stderr.startsWith("routing-stats: corrupted outcome store: ")).toBe(true);
    expect(result.stderr).toContain(file);
    expect(result.stderr).toContain("invalid JSON");
    expect(await readdir(dir)).toEqual([OUTCOMES_FILE]); // strictly read-only: no quarantine file, no temp files
    expect((await readFile(file, "utf8")).startsWith('{"schema"')).toBe(true);
    expect((await readdir(dir)).filter((n) => n.startsWith(OUTCOMES_CORRUPT_PREFIX))).toEqual([]);
  }, 60_000);

  it("a store written by a newer version also exits 1", async () => {
    const parent = await parentDir();
    const dir = join(parent, "outcomes");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, OUTCOMES_FILE), JSON.stringify({ schema: "opencode-model-router.outcomes", version: 2, entries: {} }), "utf8");
    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("corrupted outcome store");
    expect(result.stderr).toContain("version 2");
  }, 60_000);

  it("--help exits 0 with USAGE; a usage error exits 2", async () => {
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout.toString("utf8")).toBe(USAGE);
    const bad = run(["--since", "2026-10-06T12:00:00"]); // zone-less date-time
    expect(bad.status).toBe(2);
    expect(bad.stdout.length).toBe(0);
    expect(bad.stderr).toContain("routing-stats: invalid --since value");
    expect(bad.stderr).toContain(USAGE);
  }, 60_000);

  it("the script's own location and the helper dir are what the test thinks they are", () => {
    expect(basename(SCRIPT)).toBe("routing-stats.ts");
    expect(dirname(dirname(SCRIPT))).toBe(REPO_ROOT.replace(/[\\/]$/, ""));
  });
});
