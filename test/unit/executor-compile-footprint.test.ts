import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MAX_DIR_EXPANSION,
  UNKNOWN_WRITES,
  extractFootprint,
  loadRepoView,
  normalizeRepoPath,
  overlaps,
  repoViewFrom,
  touchKey,
  type FootprintInput,
  type PathOutcome,
} from "../../src/executor/compile/footprint";
import { parsePlan } from "../../src/executor/compile/parse";
import { toolTargets } from "../../src/router/tool-paths";
import { compileOpts, makeHarness, planPathOf } from "../fixtures/cpx/plans/harness";
import { fixturePath, readFixture, readRepoViewFixture, stubGit } from "../fixtures/cpx/plans/loader";

const h = makeHarness();
const repo = h.repoView;
const NEW = { allowNew: true, createdEarlier: new Set<string>() };
const OLD = { allowNew: false, createdEarlier: new Set<string>() };

function norm(raw: string, o = OLD): PathOutcome {
  return normalizeRepoPath(raw, repo, o);
}

function input(over: Partial<FootprintInput>): FootprintInput {
  return {
    id: "1.1.1",
    kind: "task",
    body: "",
    manual: false,
    route: { fields: null },
    writesLine: null,
    readsLine: null,
    ...over,
  };
}

function line(text: string): { line: number; text: string; none: boolean } {
  return { line: 10, text, none: /^none\.?$/i.test(text.trim()) };
}

describe("executor compile: footprint (2.3.3)", () => {
  describe("normalizeRepoPath", () => {
    it.each([
      ["D:\\git\\omr-cpx-p23\\src\\alpha\\core.ts", "src/alpha/core.ts", "worktree"],
      ["D:\\git\\omr-cpx-main\\src\\alpha\\core.ts", "src/alpha/core.ts", "worktree"],
      ["d:\\GIT\\OMR-CPX-P23\\src\\alpha\\core.ts", "src/alpha/core.ts", "worktree"],
      ["src/alpha/core.ts", "src/alpha/core.ts", "relative"],
      ["src\\alpha\\core.ts", "src/alpha/core.ts", "relative"],
      ["./src/alpha/core.ts", "src/alpha/core.ts", "relative"],
      ["src/alpha/../beta/util.ts", "src/beta/util.ts", "relative"],
    ])("maps %s to a repo-relative path", (raw, path, via) => {
      const r = norm(raw);
      expect(r).toMatchObject({ ok: true, path, via });
    });

    it.each([
      ["https://example.com/a/b.ts", "url"],
      ["file:///etc/passwd", "url"],
      ["\\\\?\\C:\\Windows\\x.ts", "device"],
      ["\\\\.\\pipe\\x", "device"],
      ["\\Windows\\system32\\x.ts", "device"],
      ["\\\\host\\share\\x.ts", "unc"],
      ["../outside.ts", "escape"],
      ["src/../../outside.ts", "escape"],
      ["E:\\nowhere\\at\\all.ts", "other-drive"],
    ])("rejects %s as %s", (raw, reason) => {
      const r = norm(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason);
    });

    it("maps a foreign root to the longest suffix that is tracked", () => {
      const r = norm("D:\\git\\elsewhere\\checkout\\src\\index.ts");
      expect(r).toMatchObject({ ok: true, path: "src/index.ts", via: "suffix" });
    });

    it("resolves a unique basename and rejects an ambiguous one", () => {
      expect(norm("thing.ts")).toMatchObject({ ok: true, path: "src/alpha/thing.ts", via: "basename" });
      const amb = norm("dup.ts");
      expect(amb.ok).toBe(false);
      if (!amb.ok) expect(amb.reason).toBe("ambiguous");
    });

    it("accepts new files only with allowNew and an existing parent directory", () => {
      expect(norm("src/alpha/fresh.ts", NEW)).toMatchObject({ ok: true, path: "src/alpha/fresh.ts", via: "new" });
      const denied = norm("src/alpha/fresh.ts", OLD);
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toBe("not-found");
      expect(norm("nope/deeper/fresh.ts", NEW).ok).toBe(false);
    });

    it("accepts a new file whose parent directory was created earlier", () => {
      const created = new Set<string>(["gen"]);
      expect(normalizeRepoPath("gen/out.ts", repo, { allowNew: true, createdEarlier: created })).toMatchObject({ ok: true, via: "new" });
    });

    it("reduces globs to their static prefix as a directory", () => {
      expect(norm("src/alpha/*.ts")).toMatchObject({ ok: true, path: "src/alpha", dir: true });
    });
  });

  describe("keys", () => {
    it("folds case only on case-insensitive file systems", () => {
      expect(touchKey("Src/A.ts", true)).toBe("src/a.ts");
      expect(touchKey("Src/A.ts", false)).toBe("Src/A.ts");
    });

    it("overlaps on equality and on '/'-prefixes only", () => {
      expect(overlaps("src/a", "src/a", false)).toBe(true);
      expect(overlaps("src", "src/a/b.ts", false)).toBe(true);
      expect(overlaps("src/ab", "src/a", false)).toBe(false);
      expect(overlaps("SRC/a", "src/A", true)).toBe(true);
      expect(overlaps("SRC/a", "src/A", false)).toBe(false);
      expect(overlaps("", "src/a", false)).toBe(true);
    });
  });

  describe("repo view", () => {
    it("loads toplevel, worktrees, files and case sensitivity through git", async () => {
      const v = await loadRepoView(stubGit(readRepoViewFixture()), "D:\\git\\omr-cpx-p23");
      expect(v.toplevel).toBe("D:\\git\\omr-cpx-p23");
      expect(v.worktrees).toEqual(["D:\\git\\omr-cpx-main"]);
      expect(v.files.has("src/alpha/core.ts")).toBe(true);
      expect(v.dirs.has("src/alpha")).toBe(true);
      expect(v.caseInsensitive).toBe(true);
    });

    it("fails when git cannot find the toplevel", async () => {
      await expect(loadRepoView({ run: async () => ({ code: 128, stdout: "" }) }, "X:\\none")).rejects.toThrow(/show-toplevel/);
    });

    it("builds the same view from plain data", () => {
      const v = repoViewFrom({ toplevel: "/r", worktrees: [], files: ["a/b.ts", "a\\c.ts", "a/b.ts"], caseInsensitive: false });
      expect([...v.files].sort()).toEqual(["a/b.ts", "a/c.ts"]);
      expect(v.dirs.has("a")).toBe(true);
    });
  });

  describe("extractFootprint", () => {
    it("takes a Writes/Reads line as the closed footprint (D5)", () => {
      const fp = extractFootprint(
        input({
          body: "In `src/alpha/format.ts`: implement and replace the text; also see `src/beta/util.ts`.",
          writesLine: line("`src/alpha/core.ts`, `src/alpha/helpers.ts`"),
          readsLine: line("`src/alpha/types.ts`"),
        }),
        [],
        repo,
        new Set(),
      );
      expect(fp.footprint.writes).toEqual(["src/alpha/core.ts", "src/alpha/helpers.ts"]);
      expect(fp.footprint.reads).toEqual(["src/alpha/types.ts"]);
      expect(fp.footprint.confidence).toBe("explicit");
      expect(fp.editing).toBe(true);
      expect(fp.lowConfidence).toBe(false);
    });

    it("keeps a path that is both written and read only in writes", () => {
      const fp = extractFootprint(
        input({ writesLine: line("`src/alpha/core.ts`"), readsLine: line("`src/alpha/core.ts`, `src/alpha/types.ts`") }),
        [],
        repo,
        new Set(),
      );
      expect(fp.footprint.writes).toEqual(["src/alpha/core.ts"]);
      expect(fp.footprint.reads).toEqual(["src/alpha/types.ts"]);
    });

    it("treats `Writes: none` as an explicit empty write set", () => {
      const fp = extractFootprint(input({ writesLine: line("none") }), [], repo, new Set());
      expect(fp.footprint.writes).toEqual([]);
      expect(fp.footprint.confidence).toBe("explicit");
    });

    it("derives writes from write verbs when there is no Writes line", () => {
      const fp = extractFootprint(input({ body: "In `src/alpha/core.ts`: implement the core and read `src/alpha/types.ts`." }), [], repo, new Set());
      expect(fp.footprint.writes).toContain("src/alpha/core.ts");
      expect(fp.footprint.confidence).toBe("explicit");
    });

    it("uses ownership rows of the phase when the body names the owned path", () => {
      const fp = extractFootprint(
        input({ body: "Rework `src/alpha/core.ts` for the new shape." }),
        [{ path: "src/alpha/core.ts", owners: ["1.1"], line: 3 }],
        repo,
        new Set(),
      );
      expect(fp.footprint.writes).toContain("src/alpha/core.ts");
      expect(["ownership", "explicit"]).toContain(fp.footprint.confidence);
    });

    it("marks an editing task without evidence as unknown and low confidence", () => {
      const fp = extractFootprint(input({ body: "Make it better somehow." }), [], repo, new Set());
      expect(fp.footprint.confidence).toBe("unknown");
      expect(fp.editing).toBe(true);
      expect(fp.lowConfidence).toBe(true);
      expect(typeof UNKNOWN_WRITES).toBe("symbol");
    });

    it("never treats manual, preflight and qa tasks as editing", () => {
      for (const kind of ["manual", "preflight", "qa"] as const) {
        const fp = extractFootprint(input({ kind, manual: kind === "manual", body: "Check `src/alpha/core.ts`." }), [], repo, new Set());
        expect(fp.editing).toBe(false);
      }
    });

    it("does not treat a review class without edit needs as editing", () => {
      const fp = extractFootprint(input({ body: "Look at `src/alpha/core.ts`.", route: { fields: { class: "review", needs: [] } } }), [], repo, new Set());
      expect(fp.editing).toBe(false);
    });

    it("reports ignored paths with their reasons", () => {
      const fp = extractFootprint(
        input({
          writesLine: line("`src/alpha/core.ts`, `https://example.com/x.ts`, `../escape.ts`, `\\\\host\\share\\x.ts`, `E:\\nowhere\\y.ts`"),
        }),
        [],
        repo,
        new Set(),
      );
      expect(fp.footprint.writes).toEqual(["src/alpha/core.ts"]);
      const reasons = fp.ignored.map((i) => i.reason).sort();
      expect(reasons).toEqual(["escape", "other-drive", "unc", "url"]);
    });

    it("drops a read of the repository root as informational", () => {
      const fp = extractFootprint(input({ writesLine: line("`src/alpha/core.ts`"), readsLine: line("`D:\\git\\omr-cpx-p23\\`") }), [], repo, new Set());
      expect(fp.footprint.reads).toEqual([]);
      expect(fp.ignored.some((i) => i.reason === "repo-root")).toBe(true);
    });

    it("accepts `(new)` files and remembers them for later tasks", () => {
      const created = new Set<string>();
      const fp = extractFootprint(input({ writesLine: line("`src/alpha/fresh.ts` *(new)*") }), [], repo, created);
      expect(fp.footprint.writes).toEqual(["src/alpha/fresh.ts"]);
      expect(created.has("src/alpha/fresh.ts")).toBe(true);
    });

    it("records foreign roots mapped by suffix and flags the task low confidence", () => {
      const fp = extractFootprint(input({ body: "Fix `D:\\git\\elsewhere\\checkout\\src\\index.ts` now." }), [], repo, new Set());
      expect(fp.footprint.writes.concat(fp.footprint.reads)).toContain("src/index.ts");
      expect(fp.foreignRoots.length).toBeGreaterThan(0);
    });

    it("expands a directory write over tracked files, and goes unknown above the cap", () => {
      const small = extractFootprint(input({ writesLine: line("`src/executor/compile/`") }), [], repo, new Set());
      expect(small.footprint.writes.length).toBeGreaterThan(1);
      const big = repoViewFrom({
        toplevel: "/r",
        worktrees: [],
        files: Array.from({ length: MAX_DIR_EXPANSION + 5 }, (_, i) => `pkg/f${i}.ts`),
        caseInsensitive: false,
      });
      const unbounded = extractFootprint(input({ writesLine: line("`pkg/`") }), [], big, new Set());
      expect(unbounded.footprint.confidence).toBe("unknown");
      expect(unbounded.ignored.some((i) => i.reason === "dir-write-unbounded")).toBe(true);
    });
  });

  describe("through the compiler (synthetic plans)", () => {
    it("maps worktree, foreign and backslash paths of inline code to repo-relative footprints", async () => {
      const r = await h.compiler.compile(planPathOf("synthetic/inline-code-paths.md"), compileOpts(makeHarness()));
      const t1 = r.draft.tasks["1.1.1"];
      expect(t1?.footprint.writes).toEqual(expect.arrayContaining(["src/alpha/core.ts", "src/alpha/helpers.ts"]));
      const t2 = r.draft.tasks["1.1.2"];
      expect(t2?.footprint.writes).toContain("src/alpha/fresh.ts".replace("fresh", "new-file"));
      const t3 = r.draft.tasks["1.1.3"];
      const all3 = [...(t3?.footprint.writes ?? []), ...(t3?.footprint.reads ?? [])];
      expect(all3).toEqual(expect.arrayContaining(["src/alpha/format.ts", "src/beta/util.ts", "src/alpha/thing.ts"]));
      for (const t of Object.values(r.draft.tasks)) {
        for (const p of [...t.footprint.writes, ...t.footprint.reads]) {
          expect(p).not.toMatch(/\\|^[A-Za-z]:|^\.\.|^\//);
        }
      }
    });

    it("takes the Writes lines of a synthetic plan verbatim", () => {
      const p = parsePlan(readFixture("synthetic/contract-first.md"));
      for (const t of p.tasks) {
        const fp = extractFootprint(t, [], repo, new Set());
        const fromLine = (t.writesLine?.text.match(/`([^`]+)`/g) ?? []).map((s) => s.slice(1, -1));
        expect(fp.footprint.writes).toEqual(fromLine);
      }
    });
  });

  describe.skipIf(process.platform !== "win32")("parity with the tool registry (D8)", () => {
    it.each([
      "D:\\git\\omr-cpx-p23\\src\\alpha\\core.ts",
      "src\\alpha\\core.ts",
      "src/alpha/../beta/util.ts",
    ])("resolves %s like toolTargets", (raw) => {
      const mine = norm(raw);
      const theirs = toolTargets("write", { filePath: raw }, repo.toplevel).paths[0];
      expect(mine.ok).toBe(true);
      if (mine.ok && theirs !== undefined) {
        const rel = theirs.replace(/\\/g, "/").toLowerCase().replace(`${repo.toplevel.replace(/\\/g, "/").toLowerCase()}/`, "");
        expect(mine.path.toLowerCase()).toBe(rel);
      }
    });
  });

  describe.skipIf(!existsSync(fixturePath("critical-path-execution-plan.md")))("real plans", () => {
    const names = [
      "critical-path-execution-plan.md",
      "delegation-depth-and-effort-bump-plan.md",
      "role-tier-assurance-delegation-plan.md",
      "verification-resource-budget-plan.md",
    ];

    async function writeShare(list: readonly string[]): Promise<{ editing: number; withWrites: number; per: Record<string, string> }> {
      let editing = 0;
      let withWrites = 0;
      const per: Record<string, string> = {};
      for (const name of list) {
        const harness = makeHarness();
        const r = await harness.compiler.compile(planPathOf(name), compileOpts(harness));
        let e = 0;
        let w = 0;
        for (const t of Object.values(r.draft.tasks)) {
          if (t.kind === "manual" || t.kind === "preflight" || t.kind === "qa") continue;
          e += 1;
          if (t.footprint.writes.length > 0) w += 1;
        }
        per[name] = `${w}/${e}`;
        editing += e;
        withWrites += w;
      }
      return { editing, withWrites, per };
    }

    it("maps the real plans' foreign-root paths into this repository (rta T1.1.2, T0.1.1)", async () => {
      const harness = makeHarness();
      const r = await harness.compiler.compile(planPathOf("role-tier-assurance-delegation-plan.md"), compileOpts(harness));
      const fp = (id: string): string[] => {
        const t = r.draft.tasks[id];
        return t === undefined ? [] : [...t.footprint.writes, ...t.footprint.reads];
      };
      expect(fp("T1.1.2")).toContain("src/router/config.ts");
      expect(fp("T0.1.1")).toEqual(expect.arrayContaining(["test/smoke/helpers/routing-host.ts", "test/smoke/role-spikes.smoke.test.ts"]));
      expect(r.summary.warnings.some((w) => w.startsWith("foreign-root"))).toBe(true);
    });

    // D9 (source defect vs the plan's 2.3.3 criterion "≥80% of editing tasks have writes"; src/executor/compile/
    // footprint.ts write-verb rule, memo section 4 table): with the frozen repo view the paths resolve (see the test
    // above) but rta and vrb phrase their writes as "Extend `X`", "write `X`", "Keys in `X`", "`X` rows for …",
    // "First commit: … in `X`", none of which is a write verb, and rta's ownership map (rta:460-461,
    // `| Wave | Phase | Owns (writes) |`, phase id in cell 2) is neither the file-major nor the phase-major format of
    // memo section 2 step 4, so it is not applied (src/executor/compile/parse.ts scanTables). Measured:
    // rta 9/66, vrb 34/52 (36%). Expected ≥ 80%. Those tasks stay `unknown` (⊤) and go to the residue, so the draft
    // is safe but over-serialized.
    it.fails("D9: gives at least 80% of the editing tasks a write (the plans that compile today: rta, vrb)", async () => {
      const s = await writeShare(["role-tier-assurance-delegation-plan.md", "verification-resource-budget-plan.md"]);
      expect(s.editing).toBeGreaterThan(0);
      expect(s.withWrites / s.editing, JSON.stringify(s.per)).toBeGreaterThanOrEqual(0.8);
    });

    // D4 (cpx, E_COMPILE id-duplicate at cpx:2059) and D5 (dd, E_CYCLE 3.1 <-> 3.2): see executor-compile-real-plans.
    it.fails("D4/D5: gives at least 80% of the editing tasks a write over all four plans", async () => {
      const s = await writeShare(names);
      expect(s.withWrites / s.editing, JSON.stringify(s.per)).toBeGreaterThanOrEqual(0.8);
    });
  });
});
