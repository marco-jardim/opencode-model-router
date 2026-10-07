/**
 * Self-check of the e2e helpers (sampler + real-plugin harness). Gated: it spawns real processes
 * and drives the real plugin, so it runs only with RUN_VERIFY_E2E=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptance, createE2EPlugin } from "./harness";
import { ancestorsOf, descendantsOf, startSampler, workerCensus, type ProcSample, type Snapshot } from "./sampler";

const enabled = process.env.RUN_VERIFY_E2E === "1";
const suite = enabled ? describe : describe.skip;

// Always runs (pure): the process-tree helpers against the Windows pid-reuse shape of CI round 1.
describe("e2e sampler helpers: process tree under Windows pid reuse", () => {
  const proc = (pid: number, ppid: number, createdMs: number | undefined, args: string): ProcSample => ({
    pid,
    ppid,
    priority: 8,
    lowPriority: false,
    args,
    ...(createdMs === undefined ? {} : { createdMs }),
  });
  // CI round 1: npx's parent (pid 2620) had exited; a git child of the test process then got pid
  // 2620, and npx -> cmd -> vitest main (the test process's own ancestors) looked like its children.
  const T = 1_000_000;
  const win: Snapshot = {
    t: T + 10_000,
    procs: [
      proc(5448, 2620, T, "node npx-cli.js vitest run --coverage"),
      proc(5288, 5448, T + 10, "cmd.exe /d /s /c vitest run --coverage"),
      proc(5336, 5288, T + 20, "node vitest.mjs run --coverage"),
      proc(1000, 5336, T + 30, "node vitest/dist/workers/forks.js"),
      proc(2620, 1000, T + 9_000, "git status --porcelain"),
      proc(2700, 2620, T + 9_010, "git.exe credential helper"),
    ],
  };

  it("does not follow a stale ppid to an older, unrelated process", () => {
    expect(descendantsOf(win, 1000, []).map(p => p.pid)).toEqual([2620, 2700]);
    // What the ppid alone would have said: the test process's own ancestors as its descendants.
    const unguarded = win.procs.map(p => ({ ...p, createdMs: undefined }));
    expect(descendantsOf({ ...win, procs: unguarded }, 1000, []).map(p => p.pid)).toEqual([2620, 5448, 2700, 5288, 5336]);
  });

  it("finds the ancestors and stops at the reused pid", () => {
    expect(ancestorsOf(win, 1000).map(p => p.pid)).toEqual([5336, 5288, 5448]);
  });

  it("follows the ppid as is when creation times are unknown (POSIX samples reparent orphans)", () => {
    const posix: Snapshot = {
      t: T,
      procs: [
        proc(1, 0, undefined, "init"),
        proc(5448, 1, undefined, "node npx-cli.js vitest run"),
        proc(5336, 5448, undefined, "node vitest.mjs run"),
        proc(1000, 5336, undefined, "node vitest/dist/workers/forks.js"),
        proc(3000, 1000, undefined, "git status --porcelain"),
        proc(3001, 3000, undefined, "git credential helper"),
      ],
    };
    expect(ancestorsOf(posix, 1000).map(p => p.pid)).toEqual([5336, 5448, 1]);
    expect(descendantsOf(posix, 1000, []).map(p => p.pid)).toEqual([3000, 3001]);
  });
});

// Always runs (pure): running vs retiring vitest forks (CI round 1, 3.1.2.c: 3 workers, bound 2).
describe("e2e sampler helpers: workerCensus", () => {
  const W = "node C:/r/node_modules/vitest/dist/workers/forks.js";
  const isWorker = (p: ProcSample): boolean => p.args === W;
  const proc = (pid: number, ppid: number, createdMs: number | undefined, args = W): ProcSample => ({
    pid,
    ppid,
    priority: 6,
    lowPriority: true,
    args,
    ...(createdMs === undefined ? {} : { createdMs }),
  });
  const main = (pid: number): ProcSample => proc(pid, 1, 0, "node C:/r/node_modules/vitest/vitest.mjs run");
  const snap = (t: number, procs: ProcSample[]): Snapshot => ({ t, procs: [proc(1, 0, 0, "test"), ...procs] });

  it("does not count a finished fork in its last sighting once the same main forked its successor", () => {
    // Measured shape (16 cores, CPU-loaded, 2 mains): main 6952 had 55044 (last seen here) and two
    // newer forks; main 47168 two running forks. 5 alive, 4 running.
    const snaps = [
      snap(100, [main(10), main(20), proc(55044, 10, 50), proc(57316, 20, 60), proc(7440, 20, 70)]),
      snap(200, [main(10), main(20), proc(55044, 10, 50), proc(52960, 10, 150), proc(59456, 10, 190), proc(57316, 20, 60), proc(7440, 20, 70)]),
      snap(300, [main(10), main(20), proc(52960, 10, 150), proc(59456, 10, 190), proc(57316, 20, 60), proc(7440, 20, 70)]),
    ];
    const census = workerCensus(snaps, 1, [], isWorker, 2);
    expect(census.map(c => [c.workers.length, c.running])).toEqual([[3, 3], [5, 4], [4, 4]]);
    expect([...census[1].retiring]).toEqual([55044]);
  });

  it("counts a fork seen again later, and a fork with no newer sibling, as running", () => {
    const snaps = [
      // 3 forks under one main, all seen again: 3 running (a real excess stays visible).
      snap(100, [main(10), proc(501, 10, 10), proc(502, 10, 20), proc(503, 10, 30)]),
      snap(200, [main(10), proc(501, 10, 10), proc(502, 10, 20), proc(503, 10, 30)]),
      // Last sighting of all three: one over the cap of 2, so only the oldest (501) retires.
      snap(300, [main(10), main(20), proc(501, 10, 10), proc(502, 10, 20), proc(503, 10, 30), proc(601, 20, 5)]),
      snap(400, [main(10), main(20)]),
    ];
    const census = workerCensus(snaps, 1, [], isWorker, 2);
    expect(census.map(c => c.running)).toEqual([3, 3, 3, 0]);
    // A newer fork under another main is no successor: 601 (main 20) is alone, so it runs.
    expect([...census[2].retiring]).toEqual([501]);
  });

  it("keeps two lives of a reused pid apart (Windows)", () => {
    const snaps = [
      snap(100, [main(10), proc(901, 10, 10), proc(902, 10, 20)]),
      snap(200, [main(10), proc(901, 10, 10), proc(902, 10, 20), proc(903, 10, 150)]),
      // pid 901 again, a new fork created at 250: the first 901 was last seen at 200.
      snap(300, [main(10), proc(902, 10, 20), proc(901, 10, 250)]),
      snap(400, [main(10)]),
    ];
    const census = workerCensus(snaps, 1, [], isWorker, 2);
    expect([...census[1].retiring]).toEqual([901]);
    expect(census.map(c => c.running)).toEqual([2, 2, 2, 0]);
  });

  it("never excuses a main's forks below the per-run cap: two runs at once still add up", () => {
    // Each main has 2 forks, the older in its last sighting with a newer sibling: no excess, so
    // all 4 run (against a machine-wide bound of 2 with one slot, a violation stays visible).
    const snaps = [
      snap(100, [main(10), main(20), proc(1001, 10, 10), proc(1002, 10, 20), proc(2001, 20, 10), proc(2002, 20, 20)]),
      snap(200, [main(10), main(20), proc(1002, 10, 20), proc(2002, 20, 20)]),
    ];
    expect(workerCensus(snaps, 1, [], isWorker, 2).map(c => c.running)).toEqual([4, 2]);
  });

  it("retires nothing in the final snapshot, where no last sighting is known", () => {
    const snaps = [
      snap(100, [main(10), proc(801, 10, 10), proc(802, 10, 20)]),
      snap(200, [main(10), proc(801, 10, 10), proc(802, 10, 20), proc(803, 10, 30)]),
    ];
    expect(workerCensus(snaps, 1, [], isWorker, 2).map(c => c.running)).toEqual([2, 3]);
  });

  it("orders forks by first sighting when creation times are unknown (POSIX)", () => {
    const snaps = [
      snap(100, [main(10), proc(701, 10, undefined), proc(702, 10, undefined)]),
      snap(200, [main(10), proc(701, 10, undefined), proc(702, 10, undefined), proc(703, 10, undefined)]),
      snap(300, [main(10), proc(702, 10, undefined), proc(703, 10, undefined)]),
    ];
    const census = workerCensus(snaps, 1, [], isWorker, 2);
    expect(census.map(c => c.running)).toEqual([2, 2, 2]);
    expect([...census[1].retiring]).toEqual([701]);
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

suite("e2e harness self-check", () => {
  let repo = "";
  let home = "";

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "omr-e2e-repo-"));
    home = mkdtempSync(join(tmpdir(), "omr-e2e-home-"));
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "user.email", "e2e@example.invalid");
    git(repo, "config", "user.name", "e2e");
    writeFileSync(join(repo, "README.md"), "fixture\n", "utf-8");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterAll(() => {
    for (const dir of [repo, home]) if (dir !== "") rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("defers a real task dispatch, lists it for the orchestrator, and samples the machine", async () => {
    const sampler = startSampler({ intervalMs: 100 });
    const plugin = await createE2EPlugin({ directory: repo, home });
    let snapshots: Snapshot[] = [];
    try {
      const res = await plugin.task({
        sessionID: "orch1",
        callID: "c1",
        prompt: `Add a file.\n${acceptance()}`,
        description: "add a file",
        produce: async () => {
          writeFileSync(join(repo, "added.ts"), "export const added = 1;\n", "utf-8");
        },
      });
      // The output ends with the router footer: only `[router]` lines after the task result, the
      // first of them the deferred line `[router] unverified · vrf_<24 hex> · risk <level>`.
      const tail = res.output.slice(res.output.lastIndexOf("</task_result>") + "</task_result>".length).trim().split("\n");
      expect(tail.every(line => line.startsWith("[router] ")), res.output).toBe(true);
      const handle = /^\[router\] unverified \u00b7 (vrf_[0-9a-f]{24}) \u00b7 risk \S+/.exec(tail[0])?.[1];
      expect(handle, res.output).toBeDefined();
      const system = await plugin.systemPrompt("orch1");
      expect(system.some(s => s.includes(handle as string))).toBe(true);
      console.log(`[self-check] task beforeMs=${res.beforeMs.toFixed(1)} afterMs=${res.afterMs.toFixed(1)} handle=${handle}`);
      // Keep sampling long enough for a stable interval estimate. A fixed wait is not enough on a
      // cold Windows runner: powershell.exe startup and the first Get-CimInstance (WMI warm-up)
      // can take most of it (CI: 1 snapshot after 2.5 s), so also wait for the snapshots themselves.
      const minUntil = Date.now() + 2500;
      const deadline = Date.now() + 30_000;
      while ((Date.now() < minUntil || sampler.count() < 5) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      await plugin.dispose();
      snapshots = await sampler.stop();
    }

    expect(snapshots.length).toBeGreaterThanOrEqual(5);
    const self = snapshots.filter(s => s.procs.some(p => p.pid === process.pid));
    expect(self.length).toBeGreaterThanOrEqual(5);
    // The sampler itself is a child of this process; excluding it leaves it out.
    const withSampler = descendantsOf(self[self.length - 1], process.pid, []);
    expect(withSampler.some(p => p.pid === sampler.pid)).toBe(true);
    expect(descendantsOf(self[self.length - 1], process.pid, [sampler.pid]).some(p => p.pid === sampler.pid)).toBe(false);

    const gaps = snapshots.slice(1).map((s, i) => s.t - snapshots[i].t).sort((a, b) => a - b);
    console.log(
      `[self-check] snapshots=${snapshots.length} procs/snapshot~${snapshots[0].procs.length} ` +
        `interval median=${percentile(gaps, 50)}ms p95=${percentile(gaps, 95)}ms min=${gaps[0]}ms max=${gaps[gaps.length - 1]}ms`,
    );
  }, 60_000);
});
