// ---------------------------------------------------------------------------
// Routing statistics (1.3.3, D18): pure `summarize`, deterministic `renderMarkdown`, argument parsing
// and the CLI driver behind `npm run routing:stats` and `/router stats` (2.4).
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §7.
// No I/O of its own: `runStatsCli` gets every read and write through `StatsCliIO`. Runnable under Node
// type stripping (type-only imports use `import type`).
// ---------------------------------------------------------------------------

import type {
  ClassStatsRow,
  CostUnit,
  DecisionRow,
  KeyStatsRow,
  LogRow,
  OutcomeKey,
  OutcomeStoreView,
  RatioCell,
  RefusalRow,
  ResumeFreshRow,
  SavingsRow,
  StatsCliIO,
  StatsTable,
  StatsWindow,
  VerdictRow,
} from "./types";
import { LADDER_STEP_KINDS, STATS_EXIT } from "./types";
import { createOutcomeStore } from "./store";

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

function ratio(num: number, den: number): RatioCell {
  return { num, den, rate: den === 0 ? null : num / den };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function finiteOrNull(x: number | null): number | null {
  return x !== null && Number.isFinite(x) ? x : null;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The key a decision row actually dispatched to: `best` when `enforce` switched, else `chosen`. */
function dispatchedKey(row: DecisionRow): OutcomeKey {
  return row.switched && row.best !== null ? row.best.key : row.chosen.key;
}

interface KeyAcc {
  dispatches: number;
  attempts: number;
  pass: number;
  fail: number;
  unverifiable: number;
  falseRefusals: number;
}

/**
 * Aggregate the decision log (and, for the cost column, the store) over `since ≤ ts < until`.
 * `since` is inclusive and `until` exclusive so consecutive periods never double-count. Counts and
 * rates come only from the windowed rows; the `switched.failed` join looks at all rows, because the
 * verdict of a switched dispatch may land after `until`. Every rate is a {@link RatioCell}: an empty
 * denominator is `null`, never NaN.
 */
export function summarize(store: OutcomeStoreView | null, rows: readonly LogRow[], window: StatsWindow): StatsTable {
  const since = finiteOrNull(window.since);
  const until = finiteOrNull(window.until);
  const inWindow = (row: LogRow): boolean => {
    const t = Date.parse(row.ts);
    return Number.isFinite(t) && (since === null || t >= since) && (until === null || t < until);
  };

  const decisions: DecisionRow[] = [];
  const verdicts: VerdictRow[] = [];
  const refusals: RefusalRow[] = [];
  for (const row of rows) {
    if (!inWindow(row)) continue;
    if (row.kind === "decision") decisions.push(row);
    else if (row.kind === "verdict") verdicts.push(row);
    else refusals.push(row);
  }
  const dispatchRows = decisions.filter((r) => r.step === "dispatch");
  const nonPinned = dispatchRows.filter((r) => !r.pinned);

  // By class.
  const classCounts = new Map<string, number>();
  for (const r of dispatchRows) classCounts.set(r.facts.class, (classCounts.get(r.facts.class) ?? 0) + 1);
  const byClass: ClassStatsRow[] = [...classCounts.keys()]
    .sort(compareCodeUnits)
    .map((cls) => ({ class: cls, dispatches: classCounts.get(cls) ?? 0 }));

  // By key.
  const accs = new Map<OutcomeKey, KeyAcc>();
  const slot = (key: OutcomeKey): KeyAcc => {
    let acc = accs.get(key);
    if (acc === undefined) {
      acc = { dispatches: 0, attempts: 0, pass: 0, fail: 0, unverifiable: 0, falseRefusals: 0 };
      accs.set(key, acc);
    }
    return acc;
  };
  for (const r of decisions) {
    const acc = slot(dispatchedKey(r));
    acc.attempts += 1;
    if (r.step === "dispatch") acc.dispatches += 1;
  }
  for (const v of verdicts) slot(v.key)[v.verdict] += 1;
  for (const r of refusals) slot(r.key).falseRefusals += 1;
  const byKey: KeyStatsRow[] = [...accs.keys()].sort(compareCodeUnits).map((key) => {
    const acc = accs.get(key) ?? { dispatches: 0, attempts: 0, pass: 0, fail: 0, unverifiable: 0, falseRefusals: 0 };
    const measured = store === null ? null : store.cost(key).measuredUSD;
    return {
      key,
      dispatches: acc.dispatches,
      attempts: acc.attempts,
      pass: acc.pass,
      fail: acc.fail,
      unverifiable: acc.unverifiable,
      passRate: ratio(acc.pass, acc.pass + acc.fail),
      falseRefusals: acc.falseRefusals,
      refusalRate: ratio(acc.falseRefusals, acc.attempts),
      measuredUSD: measured !== null && measured.n > 0 ? { mean: measured.mean, n: measured.n } : null,
    };
  });

  // Agreement: best == chosen over non-pinned dispatches that have a best.
  const withBest = nonPinned.filter((r) => r.best !== null);
  const agreement = ratio(withBest.filter((r) => r.best !== null && r.best.key === r.chosen.key).length, withBest.length);

  // Switched, and how many of those ended in a fail verdict or a false refusal (any window).
  const failedDecisionIDs = new Set<string>();
  for (const row of rows) {
    if (row.kind === "verdict" && row.verdict === "fail" && row.decisionID !== null) failedDecisionIDs.add(row.decisionID);
    else if (row.kind === "refusal" && row.decisionID !== null) failedDecisionIDs.add(row.decisionID);
  }
  const switchedRows = nonPinned.filter((r) => r.switched);

  // Savings: Σ C(chosen) − C(best) per unit, never summed across units. Summed in ascending order so
  // the total does not depend on the row order.
  const terms = new Map<CostUnit, number[]>();
  for (const r of nonPinned) {
    if (r.best === null) continue;
    const chosenCost = r.costs[r.chosen.key];
    const bestCost = r.costs[r.best.key];
    if (typeof chosenCost !== "number" || typeof bestCost !== "number") continue;
    if (!Number.isFinite(chosenCost) || !Number.isFinite(bestCost)) continue;
    const list = terms.get(r.unit) ?? [];
    list.push(chosenCost - bestCost);
    terms.set(r.unit, list);
  }
  const savings: SavingsRow[] = [...terms.keys()].sort(compareCodeUnits).map((unit) => {
    const list = [...(terms.get(unit) ?? [])].sort((a, b) => a - b);
    return { unit, total: list.reduce((sum, x) => sum + x, 0), rows: list.length };
  });

  // Variant steps.
  const variantVerdicts = verdicts.filter((v) => v.step === "variant");
  const variantPass = variantVerdicts.filter((v) => v.verdict === "pass").length;
  const variantFail = variantVerdicts.filter((v) => v.verdict === "fail").length;

  const resumeVsFresh: ResumeFreshRow[] = LADDER_STEP_KINDS.map((step) => {
    const ofStep = decisions.filter((r) => r.step === step);
    const resume = ofStep.filter((r) => r.resume).length;
    return { step, resume, fresh: ofStep.length - resume };
  });

  return {
    version: 1,
    window: { since: isoOrNull(since), until: isoOrNull(until) },
    dispatches: dispatchRows.length,
    pinned: dispatchRows.filter((r) => r.pinned).length,
    byClass,
    byKey,
    agreement,
    switched: {
      count: switchedRows.length,
      share: ratio(switchedRows.length, nonPinned.length),
      failed: switchedRows.filter((r) => failedDecisionIDs.has(r.decisionID)).length,
    },
    savings,
    variantSteps: {
      taken: decisions.filter((r) => r.step === "variant").length,
      passRate: ratio(variantPass, variantPass + variantFail),
    },
    resumeVsFresh,
  };
}

// ---------------------------------------------------------------------------
// renderMarkdown
// ---------------------------------------------------------------------------

/** `toFixed` without `-0.00`. */
function fix(x: number, digits: number): string {
  return (Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x).toFixed(digits);
}

function fmtRatio(cell: RatioCell): string {
  return cell.den === 0 ? "n/a" : `${cell.num}/${cell.den} (${((100 * cell.num) / cell.den).toFixed(1)}%)`;
}

function fmtPercent(cell: RatioCell): string {
  return cell.rate === null ? "n/a" : `${(100 * cell.rate).toFixed(1)}%`;
}

function fmtUSD(x: number): string {
  return `$${fix(x, 4)}`;
}

function fmtRatioAmount(x: number): string {
  return fix(x, 2);
}

/** Keys contain `|`; a cell must neither break the table nor span lines. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Markdown report: `\n` only, blocks separated by exactly one blank line, exactly one trailing `\n`.
 * Deterministic: the same table always renders the same bytes.
 */
export function renderMarkdown(table: StatsTable): string {
  const metrics = [
    "| Metric | Value |",
    "|---|---|",
    `| Dispatches | ${table.dispatches} |`,
    `| Pinned | ${table.pinned} |`,
    `| Agreement (best == chosen, non-pinned) | ${fmtRatio(table.agreement)} |`,
    `| Switched | ${table.switched.count} of ${table.switched.share.den} non-pinned (${fmtPercent(table.switched.share)}); failed ${table.switched.failed} |`,
    ...(table.savings.length === 0
      ? ["| Estimated savings | n/a |"]
      : table.savings.map(
          (s) =>
            `| Estimated savings (${s.unit}) | ${s.unit === "usd" ? fmtUSD(s.total) : fmtRatioAmount(s.total)} over ${s.rows} rows |`,
        )),
    `| Variant steps | ${table.variantSteps.taken} taken; pass ${fmtRatio(table.variantSteps.passRate)} |`,
  ];

  const classTable =
    table.byClass.length === 0
      ? "_none_"
      : ["| Class | Dispatches |", "|---|---|", ...table.byClass.map((r) => `| ${cell(r.class)} | ${r.dispatches} |`)].join("\n");

  const keyTable =
    table.byKey.length === 0
      ? "_none_"
      : [
          "| Key | Dispatches | Attempts | Pass | Fail | Unverifiable | Pass rate | False refusals | Refusal rate | USD/dispatch |",
          "|---|---|---|---|---|---|---|---|---|---|",
          ...table.byKey.map(
            (r) =>
              `| ${cell(r.key)} | ${r.dispatches} | ${r.attempts} | ${r.pass} | ${r.fail} | ${r.unverifiable} | ${fmtRatio(r.passRate)} | ${r.falseRefusals} | ${fmtRatio(r.refusalRate)} | ${
                r.measuredUSD === null ? "n/a" : `${fmtUSD(r.measuredUSD.mean)} (n=${r.measuredUSD.n})`
              } |`,
          ),
        ].join("\n");

  const resumeTable = [
    "| Step | Resume | Fresh |",
    "|---|---|---|",
    ...table.resumeVsFresh.map((r) => `| ${r.step} | ${r.resume} | ${r.fresh} |`),
  ].join("\n");

  const blocks = [
    "## Routing stats",
    `Window: ${table.window.since ?? "start"} → ${table.window.until ?? "open"}`,
    metrics.join("\n"),
    "### By class",
    classTable,
    "### By key",
    keyTable,
    "### Resume vs fresh",
    resumeTable,
  ];
  return blocks.join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Arguments and CLI
// ---------------------------------------------------------------------------

export interface StatsArgs {
  readonly since: number | null;
  readonly until: number | null;
  readonly json: boolean;
  readonly dir: string | null;
  readonly help: boolean;
}

export type ParseStatsResult =
  | { readonly ok: true; readonly args: StatsArgs }
  | { readonly ok: false; readonly error: string };

export const USAGE = [
  "Usage: npm run routing:stats -- [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]",
  "  --since <ISO>  include rows with ts >= since (YYYY-MM-DD, or date-time with Z or an offset)",
  "  --until <ISO>  include rows with ts < until",
  "  --json         print the StatsTable as JSON",
  "  --dir <path>   outcome directory (default: <os tmpdir>/opencode-model-router-trajectory)",
  "",
].join("\n");

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2})))?$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Epoch ms of an ISO date or zoned date-time, or an error text. A zone-less date-time is refused (it would be machine-dependent). */
function parseInstant(flag: string, value: string): { readonly ms: number } | { readonly error: string } {
  const m = ISO_RE.exec(value);
  if (m === null) {
    return {
      error: `invalid ${flag} value "${value}": expected YYYY-MM-DD or a date-time with Z or an offset (e.g. 2026-10-06T12:00:00Z)`,
    };
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offsetHour = m[8] === undefined ? 0 : Number(m[8]);
  const offsetMinute = m[9] === undefined ? 0 : Number(m[9]);
  const calendarOk =
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
  const ms = calendarOk ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return { error: `invalid ${flag} value "${value}": not a real date` };
  return { ms };
}

/** `--since <v>`/`--since=<v>` (also `--until`, `--dir`), `--json`, `--help`/`-h`. Repeats, unknown arguments and an empty window are errors. */
export function parseStatsArgs(argv: readonly string[]): ParseStatsResult {
  let since: number | null = null;
  let until: number | null = null;
  let json = false;
  let dir: string | null = null;
  let help = false;
  const seen = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const rawName = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const name = rawName === "-h" ? "--help" : rawName;

    if (name === "--json" || name === "--help") {
      if (inline !== null) return { ok: false, error: `${name} does not take a value` };
      if (seen.has(name)) return { ok: false, error: `${name} given more than once` };
      seen.add(name);
      if (name === "--json") json = true;
      else help = true;
      continue;
    }
    if (name !== "--since" && name !== "--until" && name !== "--dir") return { ok: false, error: `unknown argument: ${arg}` };
    if (seen.has(name)) return { ok: false, error: `${name} given more than once` };
    seen.add(name);

    let value: string | null = inline;
    if (value === null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    if (value === null || value === "") return { ok: false, error: `${name} requires a value` };

    if (name === "--dir") {
      dir = value;
      continue;
    }
    const parsed = parseInstant(name, value);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    if (name === "--since") since = parsed.ms;
    else until = parsed.ms;
  }

  if (since !== null && until !== null && since >= until) {
    return { ok: false, error: "--since must be earlier than --until" };
  }
  return { ok: true, args: { since, until, json, dir, help } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `routing:stats` driver. Read-only: loads without quarantine, cleanup or mkdir. Never throws:
 * a usage error exits 2, a corrupt or too-new store exits 1 with a clear message, an unexpected error
 * writes `routing-stats: <message>` and exits 1. A missing store is an empty table with exit 0.
 */
export async function runStatsCli(argv: readonly string[], io: StatsCliIO): Promise<number> {
  try {
    const parsed = parseStatsArgs(argv);
    if (!parsed.ok) {
      io.stderr(`routing-stats: ${parsed.error}\n${USAGE}`);
      return STATS_EXIT.usage;
    }
    const { args } = parsed;
    if (args.help) {
      io.stdout(USAGE);
      return STATS_EXIT.ok;
    }

    const source = io.open(args.dir ?? io.defaultDir);
    const loaded = await source.load({ quarantine: false });
    if (loaded.status === "corrupt" || loaded.status === "unsupported-version") {
      io.stderr(`routing-stats: corrupted outcome store: ${loaded.message ?? loaded.status}\n`);
      return STATS_EXIT.corrupt;
    }
    if (loaded.dropped > 0) io.stderr(`routing-stats: warning: ${loaded.message ?? `${loaded.dropped} invalid store entries dropped`}\n`);

    const store = createOutcomeStore();
    if (loaded.status === "ok") store.fromSnapshot(loaded.snapshot);
    const read = await source.readRows();
    if (read.skipped > 0) io.stderr(`routing-stats: skipped ${read.skipped} unreadable decision-log line(s)\n`);

    const table = summarize(store, read.rows, { since: args.since, until: args.until });
    io.stdout(args.json ? JSON.stringify(table, null, 2) + "\n" : renderMarkdown(table));
    return STATS_EXIT.ok;
  } catch (error) {
    try {
      io.stderr(`routing-stats: ${messageOf(error)}\n`);
    } catch {
      return STATS_EXIT.corrupt;
    }
    return STATS_EXIT.corrupt;
  }
}
