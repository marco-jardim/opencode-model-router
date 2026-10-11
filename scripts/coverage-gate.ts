// Pure gate decision of scripts/coverage-merge.mjs, kept free of I/O so it can be unit-tested
// (test/unit/coverage-merge.test.ts). Node strips the types when the script imports this file
// (`--experimental-strip-types`, the default from Node 22.18/23.6), so ONLY erasable TypeScript syntax
// may be used here: type annotations, `interface`, `type`, `import type`. No `enum`, `namespace`, parameter
// properties, `import x = require()`, `export =`, or angle-bracket assertions (QA-1.4-30). The test
// "coverage-gate.ts uses only erasable syntax" runs it through `node --experimental-strip-types`.

export interface Metric {
  pct: number;
  covered: number;
  total: number;
}

/** Istanbul summary of one merged file, plus an optional free-text note (branch- or function-map drift). */
export interface FileStat {
  lines: Metric;
  branches: Metric;
  functions: Metric;
  note?: string;
}

/** Minimums (%) an entry enforces; a metric left undefined is not gated. */
export interface GateMin {
  lines?: number;
  branches?: number;
  functions?: number;
}

/** Directory-prefix entry: `prefix` ends with "/" and gates every merged file under it. */
export interface PrefixGate extends GateMin {
  prefix: string;
}

export type GateMetric = "lines" | "branches" | "functions";

export interface GateResult {
  /** Repo-relative file path (or the exact entry when the file is missing). */
  rel: string;
  /** Which kind of entry gated the file. */
  source: "exact" | "prefix";
  /** The prefix entry that matched (prefix source only). */
  prefix?: string;
  status: "ok" | "fail" | "missing";
  /** Warn-only: a miss is reported but does not fail the gate. */
  soft: boolean;
  /** Metrics this entry gates, with their minimums. */
  required: GateMin;
  stat?: FileStat;
  /** Metrics under their minimum. */
  misses: GateMetric[];
}

export interface GateOutcome {
  results: GateResult[];
  /** Prefix entries that matched no file of the merged report. */
  emptyPrefixes: string[];
  warnings: string[];
  failed: boolean;
}

export interface GateInput {
  /** Exact-path entries (MERGED_PER_FILE_GATED), gated on lines and branches by `exactMin`. */
  exact: readonly string[];
  exactMin: { lines: number; branches: number };
  /** Directory-prefix entries (MERGED_PREFIX_GATED). */
  prefixes: readonly PrefixGate[];
  /** Merged report: repo-relative path to summary. */
  files: ReadonlyMap<string, FileStat>;
  /** Exact entries whose miss only warns. */
  warnOnly?: ReadonlySet<string>;
}

const METRICS: readonly GateMetric[] = ["lines", "branches", "functions"];

function misses(stat: FileStat, required: GateMin): GateMetric[] {
  return METRICS.filter((m) => {
    const min = required[m];
    return min !== undefined && stat[m].pct < min;
  });
}

/** Decide every gate against the merged report. Never reads files or exits. */
export function evaluateGates(input: GateInput): GateOutcome {
  const warnOnly = input.warnOnly ?? new Set<string>();
  const results: GateResult[] = [];
  const warnings: string[] = [];
  const emptyPrefixes: string[] = [];
  let failed = false;

  const exactRequired: GateMin = { lines: input.exactMin.lines, branches: input.exactMin.branches };
  for (const rel of input.exact) {
    const soft = warnOnly.has(rel);
    const stat = input.files.get(rel);
    if (!stat) {
      results.push({ rel, source: "exact", status: "missing", soft, required: exactRequired, misses: [] });
      if (soft) warnings.push(`${rel} is missing from every input (warn-only, not blocking)`);
      else failed = true;
      continue;
    }
    const missed = misses(stat, exactRequired);
    const bad = missed.length > 0;
    if (bad && soft) {
      warnings.push(
        `${rel} below the per-file gate (lines ${stat.lines.pct}%, branches ${stat.branches.pct}%); warn-only, not blocking`,
      );
    } else if (bad) {
      failed = true;
    }
    results.push({
      rel,
      source: "exact",
      status: bad ? "fail" : "ok",
      soft,
      required: exactRequired,
      stat,
      misses: missed,
    });
  }

  for (const entry of input.prefixes) {
    if (!entry.prefix.endsWith("/")) {
      throw new Error(`prefix gate "${entry.prefix}" must end with "/"`);
    }
    const required: GateMin = { lines: entry.lines, branches: entry.branches, functions: entry.functions };
    const matched = [...input.files.entries()]
      .filter(([rel]) => rel.startsWith(entry.prefix))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (matched.length === 0) {
      emptyPrefixes.push(entry.prefix);
      failed = true;
      continue;
    }
    for (const [rel, stat] of matched) {
      const missed = misses(stat, required);
      if (missed.length > 0) failed = true;
      results.push({
        rel,
        source: "prefix",
        prefix: entry.prefix,
        status: missed.length > 0 ? "fail" : "ok",
        soft: false,
        required,
        stat,
        misses: missed,
      });
    }
  }

  return { results, emptyPrefixes, warnings, failed };
}
