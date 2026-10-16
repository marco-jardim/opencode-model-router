/**
 * QA-SYNC1-5: the approvals store refuses the router state directory (the pending journal, whose verdict records are
 * re-posted after a restart) and the executor home with its plan and slot-marker directories, and any repository inside them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXECUTOR_HOME_DIRNAME, newPlanId, planDir, resolveExecutorHome, slotMarkersDir, type GitRunner } from "../../src/executor/paths";
import { inspectCandidate, protectedLocations, protectedProblem, resetIdentityCaches } from "../../src/routing/roles/approvals";
import { resolvePendingJournalDir } from "../../src/verify/pending";

const temps: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  resetIdentityCaches();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function routerStateDir(): string {
  return resolvePendingJournalDir({ homedir: os.homedir(), platform: process.platform, xdgStateHome: process.env.XDG_STATE_HOME });
}

function tempBase(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-protected-")));
  temps.push(dir);
  return dir;
}

function mkdir(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** `resolveExecutorHome` itself, with a git that knows one common dir (`git rev-parse --git-common-dir` there prints `.`). */
function executorHomeOf(commonDir: string): (dir: string) => Promise<string> {
  const git: GitRunner = async (args, cwd) =>
    args.join(" ") === "rev-parse --git-common-dir" && path.resolve(cwd) === path.resolve(commonDir)
      ? { code: 0, stdout: ".\n", stderr: "" }
      : { code: 128, stdout: "", stderr: "fatal: not a git repository" };
  return (dir) => resolveExecutorHome(dir, { git, realpath: async (p) => p });
}

describe("protectedLocations: router state and executor directories", () => {
  it("refuses the router state directory and a repository inside it", () => {
    const dir = routerStateDir();
    expect(protectedLocations().some((l) => l.label === "the router state directory" && l.dir === dir)).toBe(true);
    expect(protectedProblem(dir, dir)).toBe(`is the router state directory (${dir})`);
    const repo = path.join(dir, "some-repo");
    expect(protectedProblem(repo, repo)).toBe(`is inside the router state directory (${dir})`);
  });

  it.runIf(process.platform !== "win32")("follows XDG_STATE_HOME for the router state directory, as the pending journal does", () => {
    const xdg = path.join(os.tmpdir(), "omr-xdg-state");
    vi.stubEnv("XDG_STATE_HOME", xdg);
    const dir = routerStateDir();
    expect(dir.startsWith(xdg)).toBe(true);
    const repo = path.join(dir, "nested", "repo");
    expect(protectedProblem(repo, repo)).toBe(`is inside the router state directory (${dir})`);
  });

  it("refuses the executor home, its plan and slot-marker directories and a repository inside them", async () => {
    const base = tempBase();
    const common = mkdir(base, "R", ".git");
    const executorHome = executorHomeOf(common);
    const home = await executorHome(common);
    expect(home).toBe(path.join(common, EXECUTOR_HOME_DIRNAME));
    const plan = mkdir(planDir(home, newPlanId("plan.md", "digest", {}, new Date("2026-10-13T00:00:00Z"))));
    const markers = mkdir(slotMarkersDir(home));
    const repo = mkdir(plan, "nested", "repo");
    mkdir(repo, ".git");

    expect(await inspectCandidate(home, { executorHome })).toBe(`is the executor home (${home})`);
    for (const inside of [plan, markers, repo]) {
      expect(await inspectCandidate(inside, { executorHome })).toBe(`is inside the executor home (${home})`);
    }
  });

  it("resolves no executor home for a candidate without an ancestor named like one", async () => {
    const base = tempBase();
    const plain = mkdir(base, "work", "repo");
    const executorHome = vi.fn(async (dir: string) => path.join(dir, EXECUTOR_HOME_DIRNAME));
    const result = await inspectCandidate(plain, { executorHome });
    expect(executorHome).not.toHaveBeenCalled();
    expect(result).toEqual(expect.stringContaining("has no .git directory"));
  });

  it("does not refuse a directory merely named like the executor home", async () => {
    const base = tempBase();
    const common = mkdir(base, "R", ".git");
    const lookalike = mkdir(base, "work", EXECUTOR_HOME_DIRNAME);
    const result = await inspectCandidate(lookalike, { executorHome: executorHomeOf(common) });
    expect(result).toEqual(expect.stringContaining("has no .git directory"));
  });

  it("checks every ancestor named like the executor home within one shared deadline (QA-SYNC1-18)", async () => {
    const base = tempBase();
    const outer = mkdir(base, "a", EXECUTOR_HOME_DIRNAME);
    const candidate = mkdir(outer, "b", EXECUTOR_HOME_DIRNAME, "repo");
    // Each ancestor answers "no executor home" well within the bound; two of them in a row take longer than it.
    const boundMs = 400;
    const stepMs = 250;
    const slowResolver = () =>
      vi.fn((dir: string) => new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`no executor home for ${dir}`)), stepMs);
      }));

    // One such ancestor: its answer comes within the bound, and the .git check runs next.
    const once = slowResolver();
    expect(await inspectCandidate(outer, { executorHome: once, executorHomeBoundMs: boundMs }))
      .toEqual(expect.stringContaining("has no .git directory"));
    expect(once).toHaveBeenCalledTimes(1);

    // Two: the second ancestor gets only what the first left of the same deadline, so the candidate is refused.
    const twice = slowResolver();
    expect(await inspectCandidate(candidate, { executorHome: twice, executorHomeBoundMs: boundMs }))
      .toBe(`could not be checked against the executor home within ${String(boundMs)} ms (git did not answer in time)`);
    expect(twice).toHaveBeenCalledTimes(2);
    expect(twice.mock.calls.map(([dir]) => dir)).toEqual([path.dirname(path.dirname(candidate)), path.join(base, "a")]);
  });
});
