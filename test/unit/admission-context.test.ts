/**
 * Cross-repo P3c.2a (docs/design/cross-repo-phase3-plan.md, item (c)): the perimeter's link admission, factored out of
 * `planPerimeter` into the exported `admissionContext(config, workingSet)`. Behaviour-preserving: test/integration/perimeter.test.ts
 * covers it through `planPerimeter`; these pin the factored function itself.
 *
 * - Both spellings of a parent: a parent configured through a junction admits a top level spelled through the junction (as
 *   configured) and spelled as its real path (canonical); a parent configured canonically is listed once.
 * - `routing.repoDepth`: a top level is admitted 1..depth segments below a parent (the parent itself is not); depth is at least 1.
 * - `routing.repoExclude`: a glob matching the top level, or a directory between the parent and it, refuses it.
 * - Working set: a working-set worktree is admitted as a top level wherever it lies (outside every parent, deeper than the
 *   depth, under an excluded directory); `worktreeOf` finds the worktree holding a directory.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { admissionContext } from "../../src/verify/perimeter";

let base: string;
let parent: string;
let alias: string;
let outside: string;

/** A working-set entry: the main worktree `worktree` of the repository `name` (admission reads only `worktree`). */
function entry(worktree: string, name: string): RepoLocation {
  return { repository: worktree, name, worktree, branch: "main", head: null, worktrees: [] };
}

/** A glob in the spelling `routing.repoExclude` uses (forward slashes). */
function glob(...segments: string[]): string {
  return path.join(...segments).replace(/\\/g, "/");
}

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-admission-")));
  parent = path.join(base, "parent");
  outside = path.join(base, "outside");
  for (const dir of [
    path.join(parent, "lib-a"),
    path.join(parent, "group", "deep"),
    path.join(parent, "skip-me"),
    path.join(outside, "wt", "sub"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  alias = path.join(base, "alias");
  fs.symlinkSync(parent, alias, "junction");
});

afterAll(() => {
  // The junction is removed itself (never recursed through) before the temporary tree.
  if (alias !== undefined && fs.existsSync(alias)) fs.rmSync(alias, { recursive: false, force: true });
  if (base !== undefined) fs.rmSync(base, { recursive: true, force: true });
});

describe("admissionContext (P3c.2a)", () => {
  it("lists a parent configured through a link in both spellings, and a canonical parent once", () => {
    const viaAlias = admissionContext({ parents: [alias], depth: 1 }, []);
    expect(viaAlias.parents).toEqual([alias, parent]);
    const canonicalOnly = admissionContext({ parents: [parent], depth: 1 }, []);
    expect(canonicalOnly.parents).toEqual([parent]);
  });

  it("admits a top level below a parent named in either spelling (as configured and canonical)", () => {
    const ctx = admissionContext({ parents: [alias], depth: 1, exclude: [] }, []);
    expect(ctx.admitTop(path.join(alias, "lib-a"))).toBe(true); // As configured.
    expect(ctx.admitTop(path.join(parent, "lib-a"))).toBe(true); // Canonical (a link target's real path).
    expect(ctx.parentOf(path.join(alias, "lib-a"))).toBe(alias);
    expect(ctx.parentOf(path.join(parent, "lib-a"))).toBe(parent);
    expect(ctx.admitTop(path.join(outside, "wt"))).toBe(false);
    expect(ctx.parentOf(path.join(outside, "wt"))).toBeUndefined();
  });

  it("admits a top level only 1..repoDepth segments below a parent, the parent itself never", () => {
    const depth1 = admissionContext({ parents: [parent], depth: 1 }, []);
    expect(depth1.admitTop(path.join(parent, "lib-a"))).toBe(true);
    expect(depth1.admitTop(path.join(parent, "group", "deep"))).toBe(false);
    expect(depth1.admitTop(parent)).toBe(false);
    // `parentOf` is admission by text, before the depth: a deeper directory still has its parent.
    expect(depth1.parentOf(path.join(parent, "group", "deep"))).toBe(parent);
    expect(depth1.parentOf(parent)).toBeUndefined();

    const depth2 = admissionContext({ parents: [parent], depth: 2 }, []);
    expect(depth2.admitTop(path.join(parent, "group", "deep"))).toBe(true);
    expect(depth2.admitTop(path.join(parent, "lib-a"))).toBe(true);

    // The depth is a whole number of at least 1.
    expect(admissionContext({ parents: [parent], depth: 0 }, []).admitTop(path.join(parent, "lib-a"))).toBe(true);
    expect(admissionContext({ parents: [parent], depth: 1.9 }, []).admitTop(path.join(parent, "group", "deep"))).toBe(false);
  });

  it("refuses a top level that a repoExclude glob matches, or a directory between the parent and it", () => {
    const own = admissionContext({ parents: [parent], depth: 2, exclude: [glob(parent, "skip-*")] }, []);
    expect(own.admitTop(path.join(parent, "skip-me"))).toBe(false);
    expect(own.admitTop(path.join(parent, "lib-a"))).toBe(true);
    expect(own.admitTop(path.join(parent, "group", "deep"))).toBe(true);

    const between = admissionContext({ parents: [parent], depth: 2, exclude: [glob(parent, "group")] }, []);
    expect(between.admitTop(path.join(parent, "group", "deep"))).toBe(false);
    expect(between.admitTop(path.join(parent, "lib-a"))).toBe(true);
    // Excluded or not, the directory is still below the parent (admission by text).
    expect(between.parentOf(path.join(parent, "group", "deep"))).toBe(parent);
  });

  it("admits a working-set worktree as a top level wherever it lies, and finds the worktree holding a directory", () => {
    const wt = path.join(outside, "wt");
    const deep = path.join(parent, "group", "deep");
    const ctx = admissionContext(
      { parents: [parent], depth: 1, exclude: [glob(parent, "group")] },
      [entry(wt, "wt"), entry(deep, "deep")],
    );
    expect(ctx.admitTop(wt)).toBe(true); // Outside every parent.
    expect(ctx.admitTop(deep)).toBe(true); // Deeper than the depth, under an excluded directory.
    expect(ctx.admitTop(path.join(wt, "sub"))).toBe(false); // Only the worktree itself is a top level.
    expect(ctx.worktreeOf(path.join(wt, "sub"))?.name).toBe("wt");
    expect(ctx.worktreeOf(wt)?.name).toBe("wt");
    expect(ctx.worktreeOf(path.join(parent, "lib-a"))).toBeUndefined();

    // Without parents, the working set alone admits.
    const noParents = admissionContext({ parents: [], depth: 1 }, [entry(wt, "wt")]);
    expect(noParents.parents).toEqual([]);
    expect(noParents.admitTop(wt)).toBe(true);
    expect(noParents.admitTop(path.join(parent, "lib-a"))).toBe(false);
    expect(noParents.parentOf(path.join(parent, "lib-a"))).toBeUndefined();
  });
});
