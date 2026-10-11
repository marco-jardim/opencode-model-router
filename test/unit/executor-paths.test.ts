import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirWhenReleased } from "../helpers/remove-dir.js";
import {
  EXECUTOR_HOME_DIRNAME,
  SLOT_MARKERS_DIRNAME,
  assertPlanId,
  isPlanId,
  newPlanId,
  planDir,
  resolveExecutorHome,
  slotMarkersDir,
  type GitRunner,
} from "../../src/executor/paths.js";
import { PLAN_ID_PATTERN, type PlanId } from "../../src/executor/types.js";

const MAIN = resolve("/repo/main");
const LINKED = resolve("/repo/linked");
const COMMON = resolve("/repo/main/.git");

/** A fake git: the main checkout reports a relative common dir, a linked worktree an absolute one. */
const fakeGit: GitRunner = async (args, cwd) => {
  expect(args).toEqual(["rev-parse", "--git-common-dir"]);
  if (cwd === MAIN) return { code: 0, stdout: ".git\n", stderr: "" };
  if (cwd === LINKED) return { code: 0, stdout: `${COMMON}\r\n`, stderr: "" };
  return { code: 128, stdout: "", stderr: "fatal: not a git repository\n" };
};
const identity = async (p: string): Promise<string> => p;

describe("resolveExecutorHome (seams)", () => {
  it("main checkout and linked worktree resolve to the same home", async () => {
    const a = await resolveExecutorHome(MAIN, { git: fakeGit, realpath: identity });
    const b = await resolveExecutorHome(LINKED, { git: fakeGit, realpath: identity });
    expect(a).toBe(join(COMMON, EXECUTOR_HOME_DIRNAME));
    expect(b).toBe(a);
  });

  it("is never under worktrees/<id>", async () => {
    const home = await resolveExecutorHome(LINKED, { git: fakeGit, realpath: identity });
    expect(home.split(/[\\/]/)).not.toContain("worktrees");
  });

  it("passes the resolved path through realpath", async () => {
    const seen: string[] = [];
    const home = await resolveExecutorHome(MAIN, {
      git: fakeGit,
      realpath: async (p) => {
        seen.push(p);
        return join("/real", "common");
      },
    });
    expect(seen).toEqual([COMMON]);
    expect(home).toBe(join("/real", "common", EXECUTOR_HOME_DIRNAME));
  });

  it("throws when git fails", async () => {
    await expect(resolveExecutorHome(resolve("/nowhere"), { git: fakeGit, realpath: identity })).rejects.toThrow(
      /Cannot resolve the git common directory/,
    );
  });

  it("throws when git reports nothing", async () => {
    const empty: GitRunner = async () => ({ code: 0, stdout: "\n", stderr: "" });
    await expect(resolveExecutorHome(MAIN, { git: empty, realpath: identity })).rejects.toThrow(/no common directory/);
  });

  it("refuses a network or device path", async () => {
    const unc: GitRunner = async () => ({ code: 0, stdout: "\\\\server\\share\\.git\n", stderr: "" });
    await expect(resolveExecutorHome(MAIN, { git: unc, realpath: identity })).rejects.toThrow(/network or device path/);
  });

  // QA-2.2-10: a local-looking answer whose realpath crosses a junction or symlink onto a share is refused too.
  it("refuses a common dir whose realpath is a UNC path", async () => {
    const toShare = async (): Promise<string> => "\\\\server\\share\\repo\\.git";
    await expect(resolveExecutorHome(MAIN, { git: fakeGit, realpath: toShare })).rejects.toThrow(
      /resolves to a network or device path/,
    );
    await expect(resolveExecutorHome(LINKED, { git: fakeGit, realpath: toShare })).rejects.toThrow(
      /resolves to a network or device path/,
    );
  });

  // QA-2.2-10: a relative answer resolved against a UNC working directory is refused before realpath runs.
  it.runIf(process.platform === "win32")("refuses a relative common dir that resolves onto a share", async () => {
    const shareDir = "\\\\server\\share\\repo";
    const relative: GitRunner = async () => ({ code: 0, stdout: ".git\n", stderr: "" });
    const seen: string[] = [];
    const spy = async (p: string): Promise<string> => {
      seen.push(p);
      return p;
    };
    await expect(resolveExecutorHome(shareDir, { git: relative, realpath: spy })).rejects.toThrow(
      /resolves to a network or device path/,
    );
    expect(seen).toEqual([]);
  });
});

describe("resolveExecutorHome (real git, linked worktree)", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await removeDirWhenReleased(r, { deadlineMs: 20_000 });
  }, 60_000);

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdio: "pipe",
      windowsHide: true,
    });
  };

  it("the main checkout, a subdirectory and a linked worktree share one home in the git common dir, never under worktrees/<id>", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-paths-"));
    roots.push(root);
    const main = join(root, "main");
    const linked = join(root, "linked");
    await mkdir(join(main, "sub"), { recursive: true });
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", linked, "-b", "feature");

    const fromMain = await resolveExecutorHome(main);
    const fromSub = await resolveExecutorHome(join(main, "sub"));
    const fromLinked = await resolveExecutorHome(linked);
    const expected = join(await realpath(join(main, ".git")), EXECUTOR_HOME_DIRNAME);
    expect(fromMain).toBe(expected);
    expect(fromSub).toBe(expected);
    expect(fromLinked).toBe(expected);
    expect(fromLinked.split(/[\\/]/)).not.toContain("worktrees");
    expect(fromLinked).not.toContain(`${sep}worktrees${sep}`);
    // Nothing was created by resolving.
    await expect(realpath(expected)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("a directory outside any repository is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "omr-paths-"));
    roots.push(root);
    await expect(resolveExecutorHome(root)).rejects.toThrow(/Cannot resolve the git common directory/);
  }, 60_000);
});

describe("plan ids and directories", () => {
  it("newPlanId has the format p-<yyyymmdd>-<6 hex> and matches PLAN_ID_PATTERN", () => {
    const id = newPlanId("plan.md", "sha256:abc", { a: 1 }, new Date("2026-10-11T23:59:59Z"));
    expect(id).toMatch(/^p-20261011-[0-9a-f]{6}$/);
    expect(PLAN_ID_PATTERN.test(id)).toBe(true);
    expect(isPlanId(id)).toBe(true);
  });

  it("is deterministic and key-order independent for object options", () => {
    const t = "2026-01-02T03:04:05Z";
    const a = newPlanId("p", "d", { x: 1, y: { b: 2, a: 1 } }, t);
    const b = newPlanId("p", "d", { y: { a: 1, b: 2 }, x: 1 }, t);
    expect(a).toBe(b);
    expect(a.startsWith("p-20260102-")).toBe(true);
  });

  it("changes with path, digest or options; a string option is used verbatim", () => {
    const t = new Date("2026-01-02T00:00:00Z");
    const base = newPlanId("p", "d", "o", t);
    expect(newPlanId("q", "d", "o", t)).not.toBe(base);
    expect(newPlanId("p", "e", "o", t)).not.toBe(base);
    expect(newPlanId("p", "d", "z", t)).not.toBe(base);
    expect(newPlanId("pd", "", "o", t)).toBe(newPlanId("p", "d", "o", t)); // plain concatenation
  });

  it("uses the UTC day and rejects an invalid time", () => {
    expect(newPlanId("p", "d", null, new Date("2026-03-04T23:30:00-05:00"))).toMatch(/^p-20260305-/);
    expect(() => newPlanId("p", "d", null, "not a time")).toThrow(/valid time/);
  });

  it("isPlanId / assertPlanId reject path-like ids", () => {
    const tooLong = `p-${"a".repeat(41)}`;
    for (const bad of ["", "ab", "../x", "-abc", "P-20261011-abcdef", "p-20261011-abcdef/x", "p-20261011-abcdef\\x", "p.1-abc", tooLong, 5, null]) {
      expect(isPlanId(bad)).toBe(false);
    }
    expect(() => assertPlanId("../etc")).toThrow(/Invalid plan id/);
    expect(assertPlanId("p-20261011-abcdef")).toBe("p-20261011-abcdef");
  });

  // QA-2.2-14: the slot markers directory name is reserved, so no plan directory can collide with it.
  it("the slot markers directory name is not a plan id", () => {
    expect(SLOT_MARKERS_DIRNAME).toBe("slots");
    expect(isPlanId(SLOT_MARKERS_DIRNAME)).toBe(false);
    expect(() => assertPlanId(SLOT_MARKERS_DIRNAME)).toThrow(/Invalid plan id/);
    expect(() => planDir(resolve("/h/omr-executor"), SLOT_MARKERS_DIRNAME as PlanId)).toThrow(/Invalid plan id/);
    expect(isPlanId("slots-1")).toBe(PLAN_ID_PATTERN.test("slots-1")); // only the exact name is reserved
  });

  it("planDir and slotMarkersDir join under the home", () => {
    const home = resolve("/h/omr-executor");
    expect(planDir(home, "p-20261011-abcdef" as PlanId)).toBe(join(home, "p-20261011-abcdef"));
    expect(slotMarkersDir(home)).toBe(join(home, SLOT_MARKERS_DIRNAME));
    expect(() => planDir(home, "../x" as PlanId)).toThrow(/Invalid plan id/);
  });
});
