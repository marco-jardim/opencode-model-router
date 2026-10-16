/**
 * Range bisect (plan 3.2.4, memo 3.2.1 M24): pure search over a phase's integrated task ranges.
 *
 * Verdicts are monotone along the integration chain: once the failing ids fail at a commit they keep failing
 * at every later commit of the phase. The search finds the first range whose `to` fails, then confirms the
 * boundary (the culprit's `from` must pass). It never touches git: the caller supplies the probe.
 */
import type { TaskRange } from "./queue";

export type { TaskRange };

export type ProbeVerdict = "pass" | "fail";
export type RangeBisectResult = { kind: "culprit"; index: number; range: TaskRange; probes: number }
  | { kind: "outside"; reason: "from-fails" | "last-passes"; probes: number };

/** Orders by the position of `to` in `chain` (revList(base, suiteCommit), oldest first); throws on a `to` not in chain. */
export function orderRanges(ranges: readonly TaskRange[], chain: readonly string[]): TaskRange[] {
  const position = new Map<string, number>();
  chain.forEach((sha, i) => {
    if (!position.has(sha)) position.set(sha, i);
  });
  const keyed = ranges.map((range, order) => {
    const at = position.get(range.to);
    if (at === undefined) throw new Error(`range ${range.taskId}: commit ${range.to} is not in the phase chain`);
    return { range, at, order };
  });
  keyed.sort((a, b) => a.at - b.at || a.order - b.order);
  return keyed.map(k => ({ taskId: k.range.taskId, from: k.range.from, to: k.range.to }));
}

/** Upper bound of real probes `bisectRanges` runs for `n` ranges: ceil(log2 n) + 2. */
export function maxRangeProbes(n: number): number {
  return (n <= 1 ? 0 : Math.ceil(Math.log2(n))) + 2;
}

/**
 * `ordered` is oldest first (see `orderRanges`). `suiteCommit` is the commit the suite failed at, so it is
 * known to fail; `known` holds verdicts already observed (they cost no probe). `probe(commit)` runs only the
 * failing ids at `commit`.
 */
export async function bisectRanges(ordered: readonly TaskRange[], suiteCommit: string,
  probe: (commit: string) => Promise<ProbeVerdict>, known?: ReadonlyMap<string, ProbeVerdict>): Promise<RangeBisectResult> {
  const seen = new Map<string, ProbeVerdict>(known ?? []);
  if (!seen.has(suiteCommit)) seen.set(suiteCommit, "fail");
  let probes = 0;
  const verdictAt = async (commit: string): Promise<ProbeVerdict> => {
    const cached = seen.get(commit);
    if (cached !== undefined) return cached;
    probes++;
    const v = await probe(commit);
    seen.set(commit, v);
    return v;
  };

  const n = ordered.length;
  if (n === 0) return { kind: "outside", reason: "last-passes", probes };

  if (await verdictAt(ordered[n - 1]!.to) === "pass") return { kind: "outside", reason: "last-passes", probes };

  // Lower bound: the first index whose `to` fails. `hi` always fails.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await verdictAt(ordered[mid]!.to) === "fail") hi = mid;
    else lo = mid + 1;
  }

  const range = ordered[lo]!;
  // Boundary: the culprit's `from` must pass. When it is the previous observed `to` the cache answers.
  if (await verdictAt(range.from) === "fail") return { kind: "outside", reason: "from-fails", probes };
  return { kind: "culprit", index: lo, range: { taskId: range.taskId, from: range.from, to: range.to }, probes };
}
