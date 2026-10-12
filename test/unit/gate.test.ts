import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { canonicalPath } from "../../src/verify/dispatch";
import { accept } from "../../src/verify/gate";
import type { Artefact, Delegation, GateDeps } from "../../src/verify/gate";
import type { DeterministicDeps } from "../../src/verify/types";
import { createMutexRegistry, runDeterministic } from "../../src/verify/deterministic";
import type { CheckPlacement } from "../../src/verify/types";

// P2.4: a pass-through spy, so a test can read what the gate hands to runDeterministic (placements, change set).
vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return { ...actual, runDeterministic: vi.fn(actual.runDeterministic) };
});
import type { CheckerDeps } from "../../src/verify/checker";
import { normalizeDoD } from "../../src/verify/dod";
import type { Check } from "../../src/verify/dod";

// --- fakes -----------------------------------------------------------------

function fakeDeterministicDeps(opts: {
  code?: number;
  stdout?: string;
  fileExists?: boolean;
  throws?: boolean;
} = {}): DeterministicDeps {
  return {
    exec: async () => {
      if (opts.throws) throw new Error("boom");
      return { code: opts.code ?? 0, stdout: opts.stdout ?? "", stderr: "" };
    },
    fs: {
      fileExists: async () => {
        if (opts.throws) throw new Error("boom");
        return opts.fileExists ?? true;
      },
      readFile: async () => "{}",
    },
    cwd: "/ws",
    mutex: createMutexRegistry(),
  };
}

function fakeCheckerDeps(opts: {
  pass?: boolean;
  graderSessionID?: string;
  throws?: boolean;
} = {}): CheckerDeps {
  return {
    dispatchGrader: async () => {
      if (opts.throws) throw new Error("grader down");
      return {
        sessionID: opts.graderSessionID ?? "grader-sess",
        text: JSON.stringify({
          pass: opts.pass ?? true,
          reasons: opts.pass ? [] : ["criterion not met"],
        }),
      };
    },
    ladder: ["fast", "medium", "heavy"],
  };
}

function artefact(overrides: Partial<Artefact> = {}): Artefact {
  return {
    changedFiles: [],
    finalReturnText: "done",
    declaredOutputs: [],
    producerSessionID: "producer-sess",
    producerTier: "fast",
    ...overrides,
  };
}

const detDoD = () =>
  normalizeDoD({
    kind: "deterministic",
    checks: [{ kind: "fileExists", path: "out.txt" }],
    criteria: [],
    deliverable: "out.txt",
    source: "explicit",
  });

const checkerDoD = () =>
  normalizeDoD({
    kind: "checker",
    checks: [],
    criteria: ["the feature works as described"],
    deliverable: null,
    source: "inferred",
  });

const noneDoD = () =>
  normalizeDoD({
    kind: "none",
    checks: [],
    criteria: [],
    deliverable: null,
    source: "none",
  });

function deps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    deterministic: fakeDeterministicDeps(),
    checker: fakeCheckerDeps(),
    ...over,
  };
}

// --- tests -----------------------------------------------------------------

describe("accept() — outside-directory safety net", () => {
  const base = join(tmpdir(), "gate-repo");
  const outside = join(tmpdir(), "producer-worktree");
  const changed = (paths: string[]) => artefact({ changedFiles: paths.map(path => ({ path, status: "M" })) });
  function setup() {
    const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code: 0, stdout: "OK", stderr: "" });
    const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: base, exec } });
    const dod = normalizeDoD({ ...detDoD(), checks: [{ kind: "run", command: "node verify.js", expect: "OK" }] });
    return { exec, d, dod };
  }

  it.each([false, true])("does not run checks when every change is absolute and outside (strict=%s)", async (strictUnverifiable) => {
    const { exec, d, dod } = setup();
    const firstPath = join(outside, "file.ts");
    const r = await accept({ dod }, changed([firstPath, join(outside, "other.ts")]), { ...d, strictUnverifiable });
    const reason = `the producer changed files only outside ${base} (e.g. ${firstPath}); checks run there cannot see them. Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(r.accepted).toBe(!strictUnverifiable);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([
    ["relative.ts"],
    [],
  ])("runs checks when no change is absolute and outside: %j", async (...paths) => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed(paths), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalled();
  });

  // S4/F3: a mixed change set used to pass on the inside paths alone (the runner drops the outside ones with a note).
  // A relative path is root-relative, so it counts as inside (unless it climbs out: see the `../` test below).
  it.each([
    [[join(base, "inside.ts"), join(outside, "outside.ts")], [join(outside, "outside.ts")]],
    [["relative.ts", join(outside, "outside.ts")], [join(outside, "outside.ts")]],
    [[join(base, "inside.ts"), join(outside, "a.ts"), join(outside, "b.ts")], [join(outside, "a.ts"), join(outside, "b.ts")]],
  ])("a change set mixing inside and outside paths is unverifiable and runs nothing: %j", async (paths, outsidePaths) => {
    const { exec, d, dod } = setup();
    const reason = `the producer also changed files outside ${base}: ${outsidePaths.join(", ")}; checks scoped to ${base} cannot see them, so the change set cannot be verified as a whole. Verify those paths in their own repository, or dispatch that work separately.`;
    const r = await accept({ dod }, changed(paths), d);
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(r.accepted).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    const strict = await accept({ dod }, changed(paths), { ...d, strictUnverifiable: true });
    expect(strict.accepted).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("names at most five outside paths, then 'and N more'", async () => {
    const { exec, d, dod } = setup();
    const many = Array.from({ length: 7 }, (_, i) => join(outside, `f${i}.ts`));
    const r = await accept({ dod }, changed([join(base, "inside.ts"), ...many]), d);
    const reason = `the producer also changed files outside ${base}: ${many.slice(0, 5).join(", ")} and 2 more; checks scoped to ${base} cannot see them, so the change set cannot be verified as a whole. Verify those paths in their own repository, or dispatch that work separately.`;
    expect(r.verdict.reasons).toEqual([reason]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("a relative path that climbs out of the root is outside, not root-relative", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed(["inside.ts", join("..", "other", "x.ts")]), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons.join("\n")).toContain(`also changed files outside ${base}: ${join("..", "other", "x.ts")}`);
    expect(exec).not.toHaveBeenCalled();
    // `..cache` is a child named like a climb, and a `..` that stays inside is inside.
    const ok = await accept({ dod }, changed(["..cache/x.ts", join("sub", "..", "y.ts")]), d);
    expect(ok.verdict.outcome).toBe("pass");
  });

  it("the grader path with only relative paths canonicalises nothing", async () => {
    const { d } = setup();
    const canonicalPath = vi.fn((path: string) => path);
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const r = await accept({ dod: checkerDoD() }, changed(["a.ts", "b.ts"]), { ...d, canonicalPath, checker: { ...d.checker, dispatchGrader } });
    expect(r.verdict.outcome).toBe("pass");
    expect(canonicalPath).not.toHaveBeenCalled();
  });

  it("the grader path flags a mixed change set too and dispatches no grader", async () => {
    const { d } = setup();
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const r = await accept({ dod: checkerDoD(), cwd: base }, changed([join(base, "inside.ts"), join(outside, "outside.ts")]), { ...d, checker: { ...d.checker, dispatchGrader } });
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons.join("\n")).toContain(`also changed files outside ${base}: ${join(outside, "outside.ts")}`);
    expect(dispatchGrader).not.toHaveBeenCalled();
  });

  describe("with the change root (git top-level) on the artefact", () => {
    const mono = join(tmpdir(), "gate-mono");
    const pkgA = join(mono, "packages", "a");
    const pkgB = join(mono, "packages", "b");
    const withRoot = (paths: string[], changeRoot: string | undefined = mono) =>
      artefact({ changedFiles: paths.map(path => ({ path, status: "M" })), ...(changeRoot !== undefined ? { changeRoot } : {}) });
    function monoSetup() {
      const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code: 0, stdout: "OK", stderr: "" });
      const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: pkgA, exec } });
      const dod = normalizeDoD({ ...detDoD(), checks: [{ kind: "run", command: "node verify.js", expect: "OK" }] });
      return { exec, d, dod };
    }

    it("edits in sibling packages of one repo are not flagged (cwd = packages/a)", async () => {
      const { exec, d, dod } = monoSetup();
      const r = await accept({ dod, cwd: pkgA }, withRoot([join(pkgA, "x.ts"), join(pkgB, "y.ts")]), d);
      expect(r.verdict.outcome).toBe("pass");
      expect(exec).toHaveBeenCalled();
    });

    it("the grader path does not flag sibling packages either", async () => {
      const { d } = monoSetup();
      const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
      const r = await accept({ dod: checkerDoD(), cwd: pkgA }, withRoot([join(pkgA, "x.ts"), join(pkgB, "y.ts")]), { ...d, checker: { ...d.checker, dispatchGrader } });
      expect(r.verdict.outcome).toBe("pass");
      expect(dispatchGrader).toHaveBeenCalled();
    });

    it.runIf(process.platform === "win32")("compares the change root case-insensitively on win32", async () => {
      const { exec, d, dod } = monoSetup();
      const r = await accept({ dod, cwd: pkgA }, withRoot([join(pkgA, "x.ts"), join(pkgB, "y.ts").toUpperCase()], mono.toLowerCase()), d);
      expect(r.verdict.outcome).toBe("pass");
      expect(exec).toHaveBeenCalled();
    });

    it("a path outside the change root is flagged against the root, naming the root", async () => {
      const { exec, d, dod } = monoSetup();
      const stray = join(tmpdir(), "gate-other-repo", "z.ts");
      const r = await accept({ dod, cwd: pkgA }, withRoot([join(pkgA, "x.ts"), join(pkgB, "y.ts"), stray]), d);
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.reasons.join("\n")).toContain(`also changed files outside ${mono}: ${stray}`);
      expect(exec).not.toHaveBeenCalled();
    });
  });

  // I5 (P0.3, S1/S3/S10): an empty change set after a tool the router cannot observe is never a verified pass.
  describe("unattributable writers with an empty change set (Artefact.unattributedWriters)", () => {
    const empty = (writers: string[] | undefined, changeBaseline: "available" | "unavailable" = "available", paths: string[] = []) =>
      ({ ...changed(paths), changeBaseline, ...(writers !== undefined ? { unattributedWriters: writers } : {}) });
    const caveat = (tools: string) =>
      `no change was observed in ${base} but the producer ran ${tools}; a write those tools made cannot be seen, so this is not a verified pass`;

    it("a passing deterministic verdict becomes unverifiable with the caveat; strict rejects it", async () => {
      const { exec, d, dod } = setup();
      const r = await accept({ dod }, empty(["bash", "router_run"]), d);
      expect(exec).toHaveBeenCalled();
      expect(r.verdict.pass).toBe(false);
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.caveats).toEqual([caveat("bash, router_run")]);
      expect(r.verdict.reasons).toContain(caveat("bash, router_run"));
      expect(r.accepted).toBe(true);
      const strict = await accept({ dod }, empty(["bash"]), { ...d, strictUnverifiable: true });
      expect(strict.verdict.outcome).toBe("unverifiable");
      expect(strict.accepted).toBe(false);
    });

    it("applies on the grader path too", async () => {
      const { d } = setup();
      const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
      const r = await accept({ dod: checkerDoD(), cwd: base }, empty(["execute"]), { ...d, checker: { ...d.checker, dispatchGrader } });
      expect(dispatchGrader).toHaveBeenCalled();
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.caveats).toEqual([caveat("execute")]);
    });

    it("names the change root when the artefact carries one", async () => {
      const { d, dod } = setup();
      const root = join(tmpdir(), "gate-root");
      const r = await accept({ dod }, { ...empty(["bash"]), changeRoot: root }, d);
      expect(r.verdict.caveats).toEqual([`no change was observed in ${root} but the producer ran bash; a write those tools made cannot be seen, so this is not a verified pass`]);
    });

    it("lists at most five writers, then 'and N more'", async () => {
      const { d, dod } = setup();
      const tools = ["a_1", "a_2", "a_3", "a_4", "a_5", "a_6", "a_7"];
      const r = await accept({ dod }, empty(tools), d);
      expect(r.verdict.caveats).toEqual([caveat("a_1, a_2, a_3, a_4, a_5 and 2 more")]);
    });

    // F2: a nested task/delegate/subagent child's writes are not in the producer's lineage.
    it("a delegating tool with an empty change set carries the caveat", async () => {
      const { d, dod } = setup();
      const r = await accept({ dod }, empty(["task"]), d);
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.caveats).toEqual([caveat("task")]);
    });

    // F4: tool names reach the plugin from MCP servers and custom tools: sanitised like every other router text.
    it("sanitises the writer names in the caveat", async () => {
      const { d, dod } = setup();
      const long = `evil"\n${"x".repeat(80)}`;
      const r = await accept({ dod }, empty([long, "mcp srv/tool"]), d);
      const label = `evil??${"x".repeat(80)}`.slice(0, 63) + "…";
      expect(r.verdict.caveats).toEqual([caveat(`${label}, mcp?srv?tool`)]);
    });

    it.each([
      ["no writers", empty(undefined)],
      ["an empty writer list", empty([])],
      ["a non-empty change set", empty(["bash"], "available", [join(base, "inside.ts")])],
      ["an unavailable change baseline", empty(["bash"], "unavailable")],
    ])("adds nothing with %s", async (_label, art) => {
      const { d, dod } = setup();
      const r = await accept({ dod }, art, d);
      expect(r.verdict.outcome).toBe("pass");
      expect(r.verdict.caveats ?? []).toEqual([]);
    });

    it("leaves a failing verdict as it is", async () => {
      const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code: 1, stdout: "NO", stderr: "" });
      const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: base, exec } });
      const dod = normalizeDoD({ ...detDoD(), checks: [{ kind: "run", command: "node verify.js", expect: "OK" }] });
      const r = await accept({ dod }, empty(["bash"]), d);
      expect(r.verdict.outcome ?? (r.verdict.pass ? "pass" : "fail")).toBe("fail");
      expect(r.verdict.caveats ?? []).not.toContain(caveat("bash"));
    });
  });

  // I7 (P0.2, S9/S12): a branch switch of the verified tree refuses before anything runs, on both verifiers.
  describe("a branch switch of the working tree (Artefact.branchSwitch)", () => {
    const reason = "the working tree /repo switched from branch main to branch feat/x during the dispatch; the checks would verify another branch";
    const refused = { pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] };

    it("is unverifiable on the deterministic path and runs nothing; strict rejects it", async () => {
      const { exec, d, dod } = setup();
      const r = await accept({ dod }, { ...changed([join(base, "inside.ts")]), branchSwitch: reason }, d);
      expect(r.verdict).toEqual(refused);
      expect(r.accepted).toBe(true);
      const strict = await accept({ dod }, { ...changed([join(base, "inside.ts")]), branchSwitch: reason }, { ...d, strictUnverifiable: true });
      expect(strict.verdict).toEqual(refused);
      expect(strict.accepted).toBe(false);
      expect(exec).not.toHaveBeenCalled();
    });

    it("comes before the all-outside and mixed checks", async () => {
      const { exec, d, dod } = setup();
      for (const paths of [[join(outside, "o.ts")], [join(base, "inside.ts"), join(outside, "o.ts")]]) {
        const r = await accept({ dod }, { ...changed(paths), branchSwitch: reason }, d);
        expect(r.verdict.reasons).toEqual([reason]);
      }
      expect(exec).not.toHaveBeenCalled();
    });

    it("is unverifiable on the grader path and dispatches no grader; strict rejects it", async () => {
      const { d } = setup();
      const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
      const graded = { ...d, checker: { ...d.checker, dispatchGrader } };
      const r = await accept({ dod: checkerDoD(), cwd: base }, { ...changed([join(base, "inside.ts")]), branchSwitch: reason }, graded);
      expect(r.verdict).toEqual(refused);
      expect(r.accepted).toBe(true);
      const strict = await accept({ dod: checkerDoD(), cwd: base }, { ...changed([join(base, "inside.ts")]), branchSwitch: reason }, { ...graded, strictUnverifiable: true });
      expect(strict.verdict).toEqual(refused);
      expect(strict.accepted).toBe(false);
      expect(dispatchGrader).not.toHaveBeenCalled();
    });

    it("an artefact without branchSwitch is judged as before", async () => {
      const { exec, d, dod } = setup();
      const r = await accept({ dod }, changed([join(base, "inside.ts")]), d);
      expect(r.verdict.outcome).toBe("pass");
      expect(exec).toHaveBeenCalled();
    });
  });

  it("treats a sibling-prefix directory as outside", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed([join(`${base}-v2`, "file.ts")]), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(exec).not.toHaveBeenCalled();
  });

  it("compares canonical paths: another spelling of the base is not outside", async () => {
    // CI regression: the base arrived as a Windows 8.3 short name (C:\Users\MARQUI~1\...) and the
    // changed files as long names (C:\Users\Marquinho\...), so a lexical check skipped real work.
    const { exec, d, dod } = setup();
    const longBase = join(tmpdir(), "gate-repo-long-name");
    const canonicalPath = (path: string) =>
      path === base || path.startsWith(base + sep) ? longBase + path.slice(base.length) : path;
    const r = await accept({ dod }, changed([join(longBase, "file.ts")]), { ...d, canonicalPath });
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalled();
  });

  it("canonicalizes the real filesystem: a path through a directory link is inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-canonical-"));
    try {
      const real = join(root, "real");
      const link = join(root, "link");
      mkdirSync(real);
      // A junction on Windows needs no privilege; elsewhere a plain directory symlink.
      symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      const { exec, d, dod } = setup();
      const r = await accept({ dod, cwd: link }, changed([join(real, "file.ts")]), { ...d, canonicalPath });
      expect(r.verdict.outcome).toBe("pass");
      expect(exec).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it("runs checks in delegation.cwd when it contains the changes", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod, cwd: outside }, changed([join(outside, "file.ts")]), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalledWith("node verify.js", expect.objectContaining({ cwd: outside }));
  });

  // C1: the grader path refuses an all-outside change set exactly as the deterministic path does (it used to grade it).
  it("refuses an all-outside change set on a checker DoD, with the deterministic reason, and dispatches no grader", async () => {
    const { d } = setup();
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const firstPath = join(outside, "file.ts");
    const r = await accept({ dod: checkerDoD() }, changed([firstPath, join(outside, "b.ts")]), { ...d, checker: { ...d.checker, dispatchGrader } });
    const reason = `the producer changed files only outside ${base} (e.g. ${firstPath}); checks run there cannot see them. Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(dispatchGrader).not.toHaveBeenCalled();
  });

  // F3: a relative path that climbs out of the base is outside; so is a mix of absolute-outside and `../` paths.
  it.each([
    ["only a ../ path", ["../other/a.ts"]],
    ["absolute-outside and ../ paths", [join(outside, "a.ts"), "../other/b.ts"]],
  ])("refuses a change set entirely outside the base: %s (deterministic)", async (_label, paths) => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed(paths), d);
    const reason = `the producer changed files only outside ${base} (e.g. ${paths[0]}); checks run there cannot see them. Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses ../ paths on the grader path and dispatches no grader", async () => {
    const { d } = setup();
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const r = await accept({ dod: checkerDoD() }, changed(["../other/a.ts"]), { ...d, checker: { ...d.checker, dispatchGrader } });
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(dispatchGrader).not.toHaveBeenCalled();
  });

  it("still runs checks when a ../ path stays inside the base", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed(["sub/../a.ts"]), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalled();
  });
});

// #84 P3.3 DF2-F1 (DF-2 step 4, live): a role dispatch into a sibling worktree had its [acceptance] checks run in the SESSION
// directory ("changed files only outside <session dir> … Add cwd:") while its detection was recorded deterministic.
describe("accept() — a role dispatch is verified in its work root (DF2-F1)", () => {
  const session = join(tmpdir(), "gate-session-dir");
  const root = join(tmpdir(), "gate-sibling-worktree");
  const probe = join(root, "tmp-df2-probe.txt");
  function setup(checks: Check[] = [{ kind: "fileExists", path: probe }, { kind: "run", command: "node verify.js", expect: "OK" }]) {
    const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code: 0, stdout: "OK", stderr: "" });
    const fileExists = vi.fn<DeterministicDeps["fs"]["fileExists"]>().mockResolvedValue(true);
    const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: session, exec, fs: { fileExists, readFile: async () => "{}" } } });
    const dod = normalizeDoD({ ...detDoD(), checks });
    return { exec, fileExists, d, dod };
  }
  const wrote = (path = probe) => artefact({ changedFiles: [{ path, status: "??" }] });

  it("the live case: no cwd: in the block — the checks run in the work root, never the session directory", async () => {
    const { exec, fileExists, d, dod } = setup();
    const r = await accept({ dod, workRoot: root }, wrote(), d);
    expect(r.verdict.outcome).toBe("pass");
    expect([...r.verdict.reasons, ...(r.verdict.caveats ?? [])].join("\n")).not.toMatch(/only outside/);
    expect(fileExists).toHaveBeenCalledWith(probe);
    expect(exec).toHaveBeenCalledWith("node verify.js", expect.objectContaining({ cwd: root }));
  });

  it("a relative check path resolves against the work root", async () => {
    const { fileExists, d, dod } = setup([{ kind: "fileExists", path: "tmp-df2-probe.txt" }]);
    const r = await accept({ dod, workRoot: root }, wrote(), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(fileExists).toHaveBeenCalledWith(probe);
  });

  it("an explicit cwd: inside the work root still wins (a relative one is taken from the work root)", async () => {
    for (const cwd of [join(root, "pkg"), "pkg"]) {
      const { exec, d, dod } = setup();
      const r = await accept({ dod, cwd, workRoot: root }, wrote(join(root, "pkg", "index.ts")), d);
      expect(r.verdict.outcome).toBe("pass");
      expect(exec).toHaveBeenCalledWith("node verify.js", expect.objectContaining({ cwd: join(root, "pkg") }));
    }
  });

  it.each([false, true])("an explicit cwd: outside the work root is refused: unverifiable, no check runs (strict=%s)", async (strictUnverifiable) => {
    for (const cwd of [session, `${root}-v2`, join(root, "..")]) {
      const { exec, fileExists, d, dod } = setup();
      const r = await accept({ dod, cwd, workRoot: root }, wrote(), { ...d, strictUnverifiable });
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.method).toBe("none");
      expect(r.verdict.reasons).toHaveLength(1);
      expect(r.verdict.reasons[0]).toMatch(/outside this role dispatch's work root/);
      expect(r.verdict.caveats).toEqual(r.verdict.reasons);
      expect(r.accepted).toBe(!strictUnverifiable);
      expect(exec).not.toHaveBeenCalled();
      expect(fileExists).not.toHaveBeenCalled();
    }
  });

  it("the refusal also holds for a grader DoD; the grader of a role dispatch is scoped to the work root", async () => {
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const { d } = setup();
    const withGrader = { ...d, checker: { ...d.checker, dispatchGrader } };
    const refused = await accept({ dod: checkerDoD(), cwd: session, workRoot: root }, wrote(), withGrader);
    expect(refused.verdict.outcome).toBe("unverifiable");
    expect(dispatchGrader).not.toHaveBeenCalled();
    const graded = await accept({ dod: checkerDoD(), workRoot: root }, wrote(), withGrader);
    expect(graded.verdict.outcome).toBe("pass");
    expect(dispatchGrader).toHaveBeenCalledWith(expect.objectContaining({ cwd: root }));
  });

  it("changes that all landed outside the work root stay unverifiable, and the caveat names the work root", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod, workRoot: root }, wrote(join(session, "x.ts")), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons[0]).toMatch(/changed files only outside/);
    expect(r.verdict.reasons[0]).toContain(`work root ${root}`);
    expect(exec).not.toHaveBeenCalled();
  });

  it("QA-P33F1-1-2: a cwd the caller refused (refusedCwd) is refused unresolved: no canonicalisation, no check", async () => {
    const { exec, fileExists, d, dod } = setup();
    const canonicalPath = vi.fn((path: string) => path);
    const unc = "\\\\server\\share\\x";
    const r = await accept({ dod, workRoot: root, refusedCwd: unc, cwdSource: "acceptance" }, wrote(), { ...d, canonicalPath });
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons).toEqual([expect.stringContaining(`the [acceptance] block's cwd ${unc} is outside this role dispatch's work root ${root}`)]);
    expect(canonicalPath).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(fileExists).not.toHaveBeenCalled();
  });

  it("fix-1 review nit: the refusal names where the cwd came from — the call's argument, the block, or neither", async () => {
    const { exec, d, dod } = setup();
    const refused = async (over: { refusedCwd?: string; cwd?: string; cwdSource?: "argument" | "acceptance" }) =>
      (await accept({ dod, workRoot: root, ...over }, wrote(), d)).verdict.reasons[0] ?? "";
    const argument = await refused({ refusedCwd: session, cwdSource: "argument" });
    expect(argument).toContain(`the call's cwd argument ${session} is outside this role dispatch's work root ${root}`);
    expect(argument).toContain(`Drop the "cwd" argument`);
    expect(argument).not.toContain("[acceptance]");
    const block = await refused({ refusedCwd: session, cwdSource: "acceptance" });
    expect(block).toContain(`the [acceptance] block's cwd ${session} is outside`);
    expect(block).toContain(`Remove "cwd:"`);
    const unknown = await refused({ refusedCwd: session });
    expect(unknown).toContain(`the requested cwd ${session} is outside`);
    expect(unknown).not.toContain("[acceptance]");
    // The lexical backstop (a cwd the caller did not check) names its source the same way.
    expect(await refused({ cwd: session, cwdSource: "argument" })).toContain(`the call's cwd argument ${session} is outside`);
    expect(exec).not.toHaveBeenCalled();
  });

  it("QA-P33F1-1 nit 1: a cwd: inside the root but narrower than where the work landed suggests widening it", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod, cwd: join(root, "pkg"), workRoot: root }, wrote(join(root, "other", "x.ts")), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons[0]).toContain(`changed files only outside ${join(root, "pkg")}`);
    expect(r.verdict.reasons[0]).toContain(`"cwd:" narrows verification to ${join(root, "pkg")} inside the work root ${root}: widen "cwd:"`);
    expect(exec).not.toHaveBeenCalled();
  });

  it("I1: a tier dispatch (no work root) keeps the session directory and today's caveat", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, wrote(), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons[0]).toBe(`the producer changed files only outside ${session} (e.g. ${probe}); checks run there cannot see them. Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("accept() — per-check placements (P2.4)", () => {
  const W = join(tmpdir(), "p24-work-root");
  const C = join(tmpdir(), "p24-consumer");
  const runCheck: Check = { kind: "run", command: "node verify.js", expect: "OK" };
  const foreign: CheckPlacement = { cwd: join(C, "pkg"), top: C, foreign: true };
  const local: CheckPlacement = { cwd: W, top: W, foreign: false };
  const wrote = (...names: string[]) =>
    artefact({ changeRoot: W, changedFiles: names.map(name => ({ path: join(W, name), status: "M" })) });
  function setup(checks: Check[] = [runCheck], det: Partial<DeterministicDeps> = {}) {
    const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code: 0, stdout: "OK", stderr: "" });
    const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: W, exec, ...det } });
    const dod = normalizeDoD({ ...detDoD(), checks });
    return { exec, d, dod };
  }
  const lastRunArgs = () => {
    const calls = vi.mocked(runDeterministic).mock.calls;
    return calls[calls.length - 1][1];
  };

  it.each([false, true])("a refused check root is unverifiable and nothing runs, naming the check (strict=%s)", async (strictUnverifiable) => {
    const { exec, d, dod } = setup([runCheck, runCheck]);
    const refusedCheck = { index: 1, kind: "run", text: "/elsewhere", why: "outside" as const };
    const r = await accept({ dod, workRoot: W, refusedCheck }, wrote("a.ts"), { ...d, strictUnverifiable });
    const reason = `check 2 (run) cwd=/elsewhere is outside the work root ${W} and its read set; nothing ran`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(r.accepted).toBe(!strictUnverifiable);
    expect(exec).not.toHaveBeenCalled();
  });

  it("an invalid scope= is refused with its own text; nothing runs", async () => {
    const { exec, d, dod } = setup();
    const refusedCheck = { index: 0, kind: "testsPass", text: "everything", why: "scope" as const };
    const r = await accept({ dod, workRoot: W, refusedCheck }, wrote("a.ts"), d);
    const reason = "check 1 (testsPass) scope=everything is not affected or full; nothing ran";
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.reasons).toEqual([reason]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("a tier dispatch's per-check cwd= is refused with the roles-only reason; nothing runs (OD1=B)", async () => {
    const { exec, d, dod } = setup([runCheck, runCheck]);
    const refusedCheck = { index: 1, kind: "run", text: "sub", why: "tier" as const };
    const r = await accept({ dod, refusedCheck }, wrote("a.ts"), d);
    const reason = "check 2 (run) cwd=sub: a per-check cwd= is honoured only in roles mode; nothing ran";
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(exec).not.toHaveBeenCalled();
  });

  it("without placements the verdict is the same and the runner receives none", async () => {
    const { exec, d, dod } = setup();
    const plain = await accept({ dod, workRoot: W }, wrote("a.ts"), d);
    expect(plain.verdict).toEqual({
      pass: true,
      outcome: "pass",
      method: "deterministic",
      reasons: ["all 1 deterministic checks passed"],
      evidence: "exit 0: node verify.js",
    });
    expect(lastRunArgs()).not.toHaveProperty("placements");
    const explicit = await accept({ dod, workRoot: W, checkPlacements: undefined, refusedCheck: undefined }, wrote("a.ts"), d);
    expect(explicit).toEqual(plain);
    // Placements without a single defined entry add no I3 refusal.
    const empty = await accept({ dod, workRoot: W, checkPlacements: [undefined] }, wrote("a.ts"), d);
    expect(empty).toEqual(plain);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it("a grader DoD is unaffected by placements", async () => {
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const { d } = setup();
    const r = await accept({ dod: checkerDoD(), workRoot: W, checkPlacements: [foreign] }, wrote("a.ts"), { ...d, checker: { ...d.checker, dispatchGrader } });
    expect(r.verdict.outcome).toBe("pass");
    expect(dispatchGrader).toHaveBeenCalled();
  });

  it("I3: a change in W with every check in another repository is unverifiable, and nothing runs", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod, workRoot: W, checkPlacements: [foreign] }, wrote("a.ts"), d);
    const reason = `the change in ${join(W, "a.ts")} is not covered by any check root (${C}); nothing ran`;
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.reasons).toEqual([reason]);
    expect(r.verdict.caveats).toEqual([reason]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("I3: a check with an unknown top covers nothing", async () => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod, workRoot: W, checkPlacements: [{ cwd: join(C, "pkg"), top: undefined, foreign: true }] }, wrote("a.ts"), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons[0]).toContain("is not covered by any check root (no check root)");
    expect(exec).not.toHaveBeenCalled();
  });

  it("I3: a check in W plus a check in a consumer repository runs both", async () => {
    const { exec, d, dod } = setup([runCheck, runCheck]);
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, foreign] }, wrote("a.ts"), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenLastCalledWith("node verify.js", expect.objectContaining({ cwd: foreign.cwd }));
    expect(lastRunArgs().placements).toEqual([undefined, foreign]);
  });

  it("I3: more than five uncovered paths list five, then 'and N more'", async () => {
    const { exec, d, dod } = setup();
    const names = ["a", "b", "c", "d", "e", "f", "g"].map(name => `${name}.ts`);
    const r = await accept({ dod, workRoot: W, checkPlacements: [foreign] }, wrote(...names), d);
    const listed = names.slice(0, 5).map(name => join(W, name)).join(", ");
    expect(r.verdict.reasons).toEqual([`the change in ${listed} and 2 more is not covered by any check root (${C}); nothing ran`]);
    expect(exec).not.toHaveBeenCalled();
  });

  // Cross-repo P3a (Y5, SD-P3a-5, -10): with a foreign placement (v2 roles only) the runner gets W's git top and the consumer
  // link spellings of it, for a consumer testsPass with an explicit scope=affected. accept() is the one deterministic call site
  // of both the synchronous and the deferred verification (wiring.ts buildGateDeps), so these pins cover both paths.
  describe("cross-link change root (cross-repo P3a, Y5)", () => {
    it("with a foreign check the runner gets changeRoot = artefact.changeRoot and an alias provider", async () => {
      const { d, dod } = setup([runCheck, runCheck]);
      const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, foreign] }, wrote("a.ts"), d);
      expect(r.verdict.outcome).toBe("pass");
      const args = lastRunArgs();
      expect(args.changeRoot).toBe(W);
      expect(typeof args.crossLinkAliases).toBe("function");
      // W and C do not exist here: the provider is fail-soft and spells nothing.
      expect(args.crossLinkAliases?.(C)).toEqual([]);
    });

    it("without artefact.changeRoot the change root is the effective base dir", async () => {
      const { d, dod } = setup([runCheck, runCheck]);
      const art = { ...wrote("a.ts") };
      delete (art as { changeRoot?: string }).changeRoot;
      const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, foreign] }, art, d);
      expect(r.verdict.outcome).toBe("pass");
      expect(lastRunArgs().changeRoot).toBe(W);
    });

    it("a given alias provider is kept", async () => {
      const given = (_consumer: string): readonly string[] => ["/spelled/w"];
      const { d, dod } = setup([runCheck, runCheck], { crossLinkAliases: given });
      await accept({ dod, workRoot: W, checkPlacements: [undefined, foreign] }, wrote("a.ts"), d);
      expect(lastRunArgs().crossLinkAliases).toBe(given);
    });

    it("the default provider spells W as each consumer link's JS realpath (real dirs)", async () => {
      const fs = await import("node:fs");
      const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "p3a-gate-")));
      try {
        const w = join(base, "w");
        const c = join(base, "c");
        fs.mkdirSync(w, { recursive: true });
        fs.mkdirSync(join(c, "node_modules", "@scope"), { recursive: true });
        const win = process.platform === "win32";
        fs.symlinkSync(w, join(c, "node_modules", "lib"), win ? "junction" : "dir");
        // win32: a junction target written in another case than the disk; the JS realpath keeps that text (spike C4).
        fs.symlinkSync(win ? w.toUpperCase() : w, join(c, "node_modules", "@scope", "lib"), win ? "junction" : "dir");
        fs.mkdirSync(join(c, "node_modules", "plain"));
        const { d, dod } = setup([runCheck, runCheck], { cwd: w });
        const art = artefact({ changeRoot: w, changedFiles: [{ path: join(w, "a.ts"), status: "M" }] });
        const r = await accept({ dod, workRoot: w, checkPlacements: [undefined, { cwd: c, top: c, foreign: true }] }, art, d);
        expect(r.verdict.outcome).toBe("pass");
        const args = lastRunArgs();
        expect(args.changeRoot).toBe(w);
        const aliases = args.crossLinkAliases?.(c) ?? [];
        const expected = new Set([fs.realpathSync(join(c, "node_modules", "lib")), fs.realpathSync(join(c, "node_modules", "@scope", "lib"))]);
        expect([...aliases].sort()).toEqual([...expected].sort());
        expect(aliases.some(alias => alias.split(/[\\/]/).includes("node_modules"))).toBe(false);
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    });

    // QA round 1 M2 (spelling): besides `<consumer>/node_modules`, the provider reads the hoisted links of the consumer's
    // ancestors up to its git top, W's own workspace links into W, and pnpm's `.pnpm/*/node_modules/<name>` links; bounded.
    describe("crossLinkAliases spellings (QA-1 M2)", () => {
      type FS = typeof import("node:fs");
      type Path = typeof import("node:path");
      type Aliases = typeof import("../../src/verify/perimeter").crossLinkAliases;
      const win = process.platform === "win32";
      const link = (fs: FS, target: string, at: string): void => {
        fs.mkdirSync(join(at, ".."), { recursive: true });
        fs.symlinkSync(target, at, win ? "junction" : "dir");
      };
      /** win32: the k-th case spelling of p (a junction's JS realpath keeps it, spike C4); posix: p. */
      const spell = (p: string, k: number): string => (win ? [p, p.toUpperCase(), p.toLowerCase()][k % 3]! : p);
      const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
      const noNodeModules = (xs: readonly string[]): boolean => xs.every(x => !x.includes("node_modules"));
      const fixture = async (run: (fs: FS, path: Path, base: string, aliasesOf: Aliases) => void): Promise<void> => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const { crossLinkAliases: aliasesOf } = await import("../../src/verify/perimeter");
        const base = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "p3a-m2-")));
        try {
          run(fs, path, base, aliasesOf);
        } finally {
          fs.rmSync(base, { recursive: true, force: true });
        }
      };

      it("an ancestor's hoisted link, up to and including the consumer's git top, is found; one above the top is not", () =>
        fixture((fs, path, base, aliasesOf) => {
          const w = join(base, "w");
          const top = join(base, "outer", "c");
          const app = join(top, "packages", "app");
          fs.mkdirSync(join(w, "src"), { recursive: true });
          fs.mkdirSync(join(top, ".git"), { recursive: true });
          fs.mkdirSync(join(app, "node_modules"), { recursive: true });
          link(fs, spell(w, 1), join(base, "outer", "node_modules", "lib"));
          expect(aliasesOf(app, w)).toEqual([]);
          const hoisted = join(top, "node_modules", "@scope", "lib");
          const between = join(top, "packages", "node_modules", "mid");
          link(fs, spell(w, 2), hoisted);
          link(fs, spell(join(w, "src"), 1), between);
          const aliases = aliasesOf(app, w);
          expect(aliases).toHaveLength(new Set(aliases).size);
          expect(sorted(aliases)).toEqual(sorted([path.resolve(fs.realpathSync(hoisted)), path.resolve(fs.realpathSync(between), "..")]));
          expect(noNodeModules(aliases)).toBe(true);
        }));

      it("W's own workspace link into W is found (W/node_modules/@w/core, reached through @w/ui); links out of W are not", () =>
        fixture((fs, path, base, aliasesOf) => {
          const w = join(base, "w");
          const c = join(base, "c");
          const other = join(base, "other");
          fs.mkdirSync(join(w, "packages", "core"), { recursive: true });
          fs.mkdirSync(other, { recursive: true });
          fs.mkdirSync(join(c, "node_modules"), { recursive: true });
          link(fs, other, join(w, "node_modules", "ext"));
          link(fs, other, join(c, "node_modules", "other"));
          expect(aliasesOf(c, w)).toEqual([]);
          const core = join(w, "node_modules", "@w", "core");
          link(fs, spell(join(w, "packages", "core"), 1), core);
          const aliases = aliasesOf(c, w);
          expect(aliases).toEqual([path.resolve(fs.realpathSync(core), "..", "..")]);
          expect(noNodeModules(aliases)).toBe(true);
        }));

      it("pnpm's .pnpm/*/node_modules/<name> links into W are found (top level and @scope)", () =>
        fixture((fs, path, base, aliasesOf) => {
          const w = join(base, "w");
          const c = join(base, "c");
          const store = join(c, "node_modules", ".pnpm");
          fs.mkdirSync(join(w, "packages", "lib"), { recursive: true });
          fs.mkdirSync(join(store, "plain@1.0.0", "node_modules", "plain"), { recursive: true });
          const named = join(store, "w@file+..+w", "node_modules", "w");
          const scoped = join(store, "@s+lib@file+..+w+packages+lib", "node_modules", "@s", "lib");
          link(fs, spell(w, 1), named);
          link(fs, spell(join(w, "packages", "lib"), 2), scoped);
          const aliases = aliasesOf(c, w);
          expect(sorted(aliases)).toEqual(sorted([path.resolve(fs.realpathSync(named)), path.resolve(fs.realpathSync(scoped), "..", "..")]));
          expect(noNodeModules(aliases)).toBe(true);
        }));

      it("bounds: node_modules directories, entries and .pnpm entries read are capped", () =>
        fixture((fs, path, base, aliasesOf) => {
          const w = join(base, "w");
          const top = join(base, "c");
          const app = join(top, "app");
          const store = join(top, "node_modules", ".pnpm");
          fs.mkdirSync(w, { recursive: true });
          fs.mkdirSync(join(top, ".git"), { recursive: true });
          fs.mkdirSync(app, { recursive: true });
          for (const name of ["a", "b", "d", "e", "f"]) fs.mkdirSync(join(top, "node_modules", name), { recursive: true });
          link(fs, w, join(top, "node_modules", "lib"));
          for (const k of [0, 1, 2]) link(fs, spell(w, k), join(store, `w${k}@1.0.0`, "node_modules", "w"));
          const lstats: string[] = [];
          const io = {
            lstat: (p: string) => {
              lstats.push(p);
              return fs.lstatSync(p);
            },
            readlink: (p: string) => fs.readlinkSync(p),
            realpath: (p: string) => fs.realpathSync.native(p),
            jsRealpath: (p: string) => fs.realpathSync(p),
          };
          const all = { dirs: 64, entries: 4000, pnpm: 256 };
          expect(aliasesOf(app, w, io, all).length).toBeGreaterThan(0);
          // One directory: only the consumer's own node_modules (absent) is read.
          expect(aliasesOf(app, w, io, { ...all, dirs: 1 })).toEqual([]);
          lstats.length = 0;
          aliasesOf(app, w, io, { ...all, entries: 3 });
          expect(lstats.length).toBeLessThanOrEqual(3);
          const pnpmEntries = (): Set<string> =>
            new Set(lstats.filter(p => p.startsWith(store)).map(p => path.relative(store, p).split(/[\\/]/)[0]!));
          lstats.length = 0;
          expect(aliasesOf(app, w, io, { ...all, pnpm: 1 }).length).toBeGreaterThan(0);
          expect(pnpmEntries().size).toBe(1);
          lstats.length = 0;
          aliasesOf(app, w, io, { ...all, pnpm: 0 });
          expect(pnpmEntries().size).toBe(0);
        }));

      it("never a spelling containing the substring node_modules (vitest's case-sensitive rule); case-only variants kept", () =>
        fixture((fs, path, base, aliasesOf) => {
          const hidden = join(base, "x_node_modules", "w");
          const shown = join(base, "Y_NODE_MODULES", "w");
          const c = join(base, "c");
          fs.mkdirSync(hidden, { recursive: true });
          fs.mkdirSync(shown, { recursive: true });
          link(fs, hidden, join(c, "node_modules", "hidden"));
          expect(aliasesOf(c, hidden)).toEqual([]);
          const links = [join(c, "node_modules", "shown"), join(c, "node_modules", "shown-upper"), join(c, "node_modules", "shown-lower")];
          links.forEach((at, k) => link(fs, spell(shown, k), at));
          const aliases = aliasesOf(c, shown);
          expect(aliases).toHaveLength(new Set(aliases).size);
          expect(aliases.length).toBeGreaterThan(0);
          // win32: the lower-case spelling holds "y_node_modules" and is dropped; "Y_NODE_MODULES" is kept (case-sensitive).
          const expected = links.map(at => path.resolve(fs.realpathSync(at))).filter(spelling => !spelling.includes("node_modules"));
          expect(sorted(aliases)).toEqual(sorted(expected));
        }));
    });

    it("without a foreign check (in-repo placements, or none as on v1 and tiers) neither is set", async () => {
      const { d, dod } = setup([runCheck, runCheck]);
      await accept({ dod, workRoot: W, checkPlacements: [undefined, local] }, wrote("a.ts"), d);
      expect(lastRunArgs()).not.toHaveProperty("changeRoot");
      expect(lastRunArgs()).not.toHaveProperty("crossLinkAliases");
      await accept({ dod, workRoot: W }, wrote("a.ts"), d);
      expect(lastRunArgs()).not.toHaveProperty("changeRoot");
      expect(lastRunArgs()).not.toHaveProperty("crossLinkAliases");
      await accept({ dod }, wrote("a.ts"), d);
      expect(lastRunArgs()).not.toHaveProperty("changeRoot");
      expect(lastRunArgs()).not.toHaveProperty("crossLinkAliases");
    });

    it("a v2 tier's per-check cwd= is refused first (OD1): the runner is never called, so no changeRoot", async () => {
      const { exec, d, dod } = setup([runCheck, { kind: "testsPass", command: "npm test" }]);
      vi.mocked(runDeterministic).mockClear();
      const refusedCheck = { index: 1, kind: "testsPass", text: "../consumer", why: "tier" as const };
      const r = await accept({ dod, refusedCheck }, wrote("a.ts"), d);
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.verdict.reasons).toEqual(["check 2 (testsPass) cwd=../consumer: a per-check cwd= is honoured only in roles mode; nothing ran"]);
      expect(vi.mocked(runDeterministic)).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });
  });

  it("F7: with a foreign check, relative changed paths reach the runner absolute, against the change root", async () => {
    const changedFiles = [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "R", previousPath: "old.ts" }, { path: join(W, "c.ts") }];
    const { d, dod } = setup([runCheck, runCheck], { changedFiles });
    const art = artefact({ changeRoot: W, changedFiles: [{ path: "a.ts", status: "M" }] });
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, foreign] }, art, d);
    expect(r.verdict.outcome).toBe("pass");
    expect(lastRunArgs().changedFiles).toEqual([
      { path: join(W, "a.ts"), status: "M" },
      { path: join(W, "b.ts"), status: "R", previousPath: join(W, "old.ts") },
      { path: join(W, "c.ts") },
    ]);
  });

  it("F7: without a foreign check the change set is handed over unchanged", async () => {
    const changedFiles = [{ path: "a.ts", status: "M" }];
    const { d, dod } = setup([runCheck, runCheck], { changedFiles });
    const art = artefact({ changeRoot: W, changedFiles: [{ path: "a.ts", status: "M" }] });
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, local] }, art, d);
    expect(r.verdict.outcome).toBe("pass");
    expect(lastRunArgs().changedFiles).toBe(changedFiles);
  });

  it("F17: an unavailable change baseline with only a foreign check is unverifiable, and nothing runs", async () => {
    const { exec, d, dod } = setup();
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    const r = await accept({ dod, workRoot: W, checkPlacements: [foreign] }, unobserved, d);
    const reason = `the change in the work root could not be observed and no check runs there (${C}); nothing ran`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(exec).not.toHaveBeenCalled();
    // An available, empty change set leaves nothing uncovered: the foreign check runs.
    const observed = await accept({ dod, workRoot: W, checkPlacements: [foreign] }, { ...unobserved, changeBaseline: "available" }, d);
    expect(observed.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("F17: an unavailable change baseline with a check in W plus a foreign check runs both", async () => {
    const { exec, d, dod } = setup([runCheck, runCheck]);
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    for (const inW of [undefined, local]) {
      const r = await accept({ dod, workRoot: W, checkPlacements: [inW, foreign] }, unobserved, d);
      expect(r.verdict.outcome).toBe("pass");
      expect(lastRunArgs().placements).toEqual([inW, foreign]);
    }
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("QA round 2 M1: an unavailable baseline with a check only in a nested repository inside W is unverifiable, and nothing runs", async () => {
    const { exec, d, dod } = setup();
    const nested = join(W, "vendor");
    const inNested: CheckPlacement = { cwd: nested, top: nested, foreign: false };
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    const r = await accept({ dod, workRoot: W, checkPlacements: [inNested] }, unobserved, d);
    const reason = `the change in the work root could not be observed and no check runs there (${nested}); nothing ran`;
    expect(r.verdict).toEqual({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] });
    expect(exec).not.toHaveBeenCalled();
  });

  it("QA round 2 M1: an unplaced check beside the nested-repository check covers the change root and both run", async () => {
    const { exec, d, dod } = setup([runCheck, runCheck]);
    const nested = join(W, "vendor");
    const inNested: CheckPlacement = { cwd: nested, top: nested, foreign: false };
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, inNested] }, unobserved, d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("QA round 2 M1: a check whose top contains the change root covers it", async () => {
    const { d, dod } = setup();
    const unobserved = artefact({ changeRoot: join(W, "pkg"), changedFiles: [], changeBaseline: "unavailable" });
    const r = await accept({ dod, workRoot: W, checkPlacements: [{ cwd: W, top: W, foreign: false }] }, unobserved, d);
    expect(r.verdict.outcome).toBe("pass");
  });

  it("QA round 2 M1: when every top is unknown the reason says so", async () => {
    const { exec, d, dod } = setup();
    const unknown: CheckPlacement = { cwd: join(C, "pkg"), top: undefined, foreign: true };
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    const r = await accept({ dod, workRoot: W, checkPlacements: [unknown] }, unobserved, d);
    const reason = "the change in the work root could not be observed and no check runs there (no check root); nothing ran";
    expect(r.verdict.reasons).toEqual([reason]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("QA-2 #5: a non-foreign check with an unknown top (W not a git repository) covers the change root", async () => {
    const { exec, d, dod } = setup();
    const unknownTop: CheckPlacement = { cwd: W, top: undefined, foreign: false };
    const r = await accept({ dod, workRoot: W, checkPlacements: [unknownTop] }, wrote("a.ts"), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(r.verdict.reasons.join("\n")).not.toContain("is not covered by any check root");
    const unobserved = artefact({ changeRoot: W, changedFiles: [], changeBaseline: "unavailable" });
    const r2 = await accept({ dod, workRoot: W, checkPlacements: [unknownTop] }, unobserved, d);
    expect(r2.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("accept() — consumer caveat (D6)", () => {
  const W = join(tmpdir(), "d6-work-root");
  const C = join(tmpdir(), "d6-consumer");
  const consumer = { root: C, name: "app-c", entry: "@scope/lib-w" };
  const runCheck: Check = { kind: "run", command: "node verify.js", expect: "OK" };
  const testsCheck: Check = { kind: "testsPass", command: "npm test" };
  const existsCheck: Check = { kind: "fileExists", path: "out.txt" };
  const inConsumer = (over: Partial<CheckPlacement> = {}): CheckPlacement => ({ cwd: C, top: C, foreign: true, scope: "full", ...over });
  const CAVEAT = `app-c at ${C} links this work root (node_modules/@scope/lib-w) and no check ran there; add a check such as: check: testsPass cwd="${C}" scope=full`;
  /** Cross-repo P3c.5 (SD-P3c-5, F6): a consumer found through a declared edge names the edge's file and label, not node_modules. */
  const EDGE_CAVEAT = `app-c at ${C} links this work root (package.json dependencies (file:) in packages/x/package.json) and no check ran there; add a check such as: check: testsPass cwd="${C}" scope=full`;
  const perimeter = (consumers?: readonly { root: string; name?: string; entry?: string; via?: string }[]): NonNullable<Artefact["perimeter"]> => ({
    w: { root: W, name: "lib-w" },
    roots: [{ root: C, name: "app-c", status: "unchanged" }],
    ...(consumers !== undefined ? { consumers } : {}),
  });
  const wrote = (over: Partial<Artefact> = {}): Artefact =>
    artefact({ changeRoot: W, changedFiles: [{ path: join(W, "a.ts"), status: "M" }], perimeter: perimeter([consumer]), ...over });
  function setup(checks: Check[], code = 0) {
    const exec = vi.fn<DeterministicDeps["exec"]>().mockResolvedValue({ code, stdout: "OK", stderr: "" });
    const d = deps({ deterministic: { ...fakeDeterministicDeps(), cwd: W, exec } });
    const dod = normalizeDoD({ ...detDoD(), checks });
    return { exec, d, dod };
  }

  it("a consumer without a check turns a pass into UNVERIFIED, naming the consumer and the suggested check line", async () => {
    const { d, dod } = setup([runCheck]);
    const r = await accept({ dod, workRoot: W }, wrote(), d);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons).toContain(CAVEAT);
    expect(r.verdict.caveats).toEqual([CAVEAT]);
    // Not a pass: the I8 scope line (a pass's evidence) is not added.
    expect(r.verdict.reasons.join("\n")).not.toContain("verified scope:");
    // strictUnverifiable refuses it like any other unverifiable verdict.
    expect((await accept({ dod, workRoot: W }, wrote(), { ...d, strictUnverifiable: true })).accepted).toBe(false);
    // A consumer without a name is named by its root.
    const unnamed = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter([{ root: C, entry: "lib-w" }]) }), d);
    expect(unnamed.verdict.caveats).toEqual([
      `${C} at ${C} links this work root (node_modules/lib-w) and no check ran there; add a check such as: check: testsPass cwd="${C}" scope=full`,
    ]);
  });

  it("a testsPass (or run) placed in the consumer: no caveat", async () => {
    for (const check of [testsCheck, runCheck]) {
      const { exec, d, dod } = setup([runCheck, check]);
      const delegation = { dod, workRoot: W, checkPlacements: [undefined, inConsumer()] };
      const r = await accept(delegation, wrote(), d);
      expect(r.verdict.caveats ?? [], check.kind).not.toContain(CAVEAT);
      expect(r.verdict.reasons, check.kind).not.toContain(CAVEAT);
      // The verdict is the runner's own: the same as with no consumer known (the fake testsPass output is not a test report).
      expect(r.verdict, check.kind).toEqual((await accept(delegation, wrote({ perimeter: perimeter() }), d)).verdict);
      if (check.kind === "run") {
        expect(r.verdict.outcome).toBe("pass");
        expect(exec).toHaveBeenCalledWith("node verify.js", expect.objectContaining({ cwd: C }));
      }
    }
    // The placement's top is compared with the perimeterKey normalisation (separators, trailing separator, case on win32).
    const spelled = `${process.platform === "win32" ? C.toUpperCase() : C}${sep}`;
    const { d, dod } = setup([runCheck, runCheck]);
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, inConsumer({ top: spelled })] }, wrote(), d);
    expect(r.verdict.outcome).toBe("pass");
  });

  it("a fileExists placed in the consumer does not count", async () => {
    const { d, dod } = setup([runCheck, existsCheck]);
    const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, { cwd: C, top: C, foreign: true }] }, wrote(), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats).toEqual([CAVEAT]);
  });

  it("an empty change set: no caveat, the pass stays a pass", async () => {
    const { d, dod } = setup([runCheck]);
    const r = await accept({ dod, workRoot: W }, wrote({ changedFiles: [] }), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(r.verdict.reasons).not.toContain(CAVEAT);
    expect(r.verdict.caveats ?? []).toEqual([]);
  });

  it("F17: an unavailable change baseline counts as a change: a consumer without a check carries the caveat", async () => {
    const { d, dod } = setup([runCheck]);
    const r = await accept({ dod, workRoot: W }, wrote({ changedFiles: [], changeBaseline: "unavailable" }), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats).toEqual([CAVEAT]);
  });

  it("QA-2 #2: consumer discovery that stopped early carries a caveat per entry on a pass with a change", async () => {
    const { d, dod } = setup([runCheck]);
    const incomplete = [{ root: C, name: "app-c" }, { root: join(tmpdir(), "d6-other") }];
    const art = (over: Partial<Artefact> = {}): Artefact =>
      wrote({ perimeter: { ...perimeter(), consumersIncomplete: incomplete }, ...over });
    const caveats = [
      `consumer discovery stopped before finishing app-c at ${C}; a repository there may link this work root unchecked; add a check such as: check: testsPass cwd="${C}" scope=full`,
      `consumer discovery stopped before finishing ${incomplete[1].root} at ${incomplete[1].root}; a repository there may link this work root unchecked; add a check such as: check: testsPass cwd="${incomplete[1].root}" scope=full`,
    ];
    const r = await accept({ dod, workRoot: W }, art(), d);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats).toEqual(caveats);
    // An unavailable baseline counts as a change too.
    const unobserved = await accept({ dod, workRoot: W }, art({ changedFiles: [], changeBaseline: "unavailable" }), d);
    expect(unobserved.verdict.caveats).toEqual(caveats);
    // An empty, available change set: no caveat, the pass stays a pass.
    const empty = await accept({ dod, workRoot: W }, art({ changedFiles: [], changeBaseline: "available" }), d);
    expect(empty.verdict.outcome).toBe("pass");
    expect(empty.verdict.caveats ?? []).toEqual([]);
  });

  it("QA round 2 M2: an incomplete root is cleared by a consumer check placed there, and not by a fileExists", async () => {
    const incompleteOnly = (): Artefact => wrote({ perimeter: { ...perimeter(), consumersIncomplete: [{ root: C, name: "app-c" }] } });
    const caveat = `consumer discovery stopped before finishing app-c at ${C}; a repository there may link this work root unchecked; add a check such as: check: testsPass cwd="${C}" scope=full`;
    for (const check of [testsCheck, runCheck]) {
      const { d, dod } = setup([runCheck, check]);
      const r = await accept({ dod, workRoot: W, checkPlacements: [undefined, inConsumer()] }, incompleteOnly(), d);
      expect(r.verdict.caveats ?? [], check.kind).not.toContain(caveat);
      expect(r.verdict.reasons, check.kind).not.toContain(caveat);
    }
    const { d, dod } = setup([runCheck, existsCheck]);
    const kept = await accept({ dod, workRoot: W, checkPlacements: [undefined, { cwd: C, top: C, foreign: true }] }, incompleteOnly(), d);
    expect(kept.verdict.outcome).toBe("unverifiable");
    expect(kept.verdict.caveats).toEqual([caveat]);
  });

  /** P3c.5: a consumer found through a declared edge (`via`, no `entry`). */
  const edged = { root: C, name: "app-c", via: "package.json dependencies (file:) in packages/x/package.json" };

  it("P3c.5 (SD-P3c-5): an edge consumer without a check turns a pass into UNVERIFIED, naming its edge (never node_modules)", async () => {
    const { d, dod } = setup([runCheck]);
    const r = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter([edged]) }), d);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.reasons).toContain(EDGE_CAVEAT);
    expect(r.verdict.caveats).toEqual([EDGE_CAVEAT]);
    expect(r.verdict.caveats?.join("\n")).not.toContain("node_modules");
    // A consumer without a name is named by its root; the label alone when it starts with its file.
    const unnamed = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter([{ root: C, via: "go.mod replace" }]) }), d);
    expect(unnamed.verdict.caveats).toEqual([
      `${C} at ${C} links this work root (go.mod replace) and no check ran there; add a check such as: check: testsPass cwd="${C}" scope=full`,
    ]);
    // The declaring file comes from the filesystem: it is echoed through displaySafe (a bracket cannot forge a router line).
    const odd = { root: C, name: "app-c", via: "package.json dependencies (file:) in packages/[router: x]/package.json" };
    const quoted = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter([odd]) }), d);
    expect(quoted.verdict.caveats).toHaveLength(1);
    const line = quoted.verdict.caveats?.[0] ?? "";
    expect(line).toContain(`app-c at ${C} links this work root ("package.json dependencies (file:) in packages/\\133router: x\\135/package.json")`);
    expect(line).not.toContain("[router:");
  });

  it("P3c.5 (F6): a node_modules consumer and an edge consumer each carry their own literal", async () => {
    const D = join(tmpdir(), "d6-edge-consumer");
    const { d, dod } = setup([runCheck]);
    const both = [consumer, { root: D, name: "app-d", via: "tsconfig references in tsconfig.json" }];
    const r = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter(both) }), d);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats).toEqual([
      CAVEAT,
      `app-d at ${D} links this work root (tsconfig references in tsconfig.json) and no check ran there; add a check such as: check: testsPass cwd="${D}" scope=full`,
    ]);
  });

  it("P3c.5: a consumer check placed with its top equal to the edge consumer's root clears the edge caveat; a fileExists does not", async () => {
    for (const check of [testsCheck, runCheck]) {
      const { d, dod } = setup([runCheck, check]);
      const delegation = { dod, workRoot: W, checkPlacements: [undefined, inConsumer()] };
      const r = await accept(delegation, wrote({ perimeter: perimeter([edged]) }), d);
      expect(r.verdict.caveats ?? [], check.kind).not.toContain(EDGE_CAVEAT);
      expect(r.verdict.reasons, check.kind).not.toContain(EDGE_CAVEAT);
      expect(r.verdict, check.kind).toEqual((await accept(delegation, wrote({ perimeter: perimeter() }), d)).verdict);
      if (check.kind === "run") expect(r.verdict.outcome).toBe("pass");
    }
    const exists = setup([runCheck, existsCheck]);
    const kept = await accept(
      { dod: exists.dod, workRoot: W, checkPlacements: [undefined, { cwd: C, top: C, foreign: true }] },
      wrote({ perimeter: perimeter([edged]) }),
      exists.d,
    );
    expect(kept.verdict.outcome).toBe("unverifiable");
    expect(kept.verdict.caveats).toEqual([EDGE_CAVEAT]);
  });

  it("a fail stays a fail, without the consumer caveat", async () => {
    const { d, dod } = setup([runCheck], 1);
    const r = await accept({ dod, workRoot: W }, wrote(), d);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.verdict.reasons).not.toContain(CAVEAT);
    expect(r.verdict.caveats ?? []).not.toContain(CAVEAT);
  });

  it("no perimeter, or a perimeter without consumers: unchanged", async () => {
    const { d, dod } = setup([runCheck]);
    const none = await accept({ dod, workRoot: W }, wrote({ perimeter: undefined }), d);
    expect(none.verdict).toEqual({
      pass: true,
      outcome: "pass",
      method: "deterministic",
      reasons: ["all 1 deterministic checks passed"],
      evidence: "exit 0: node verify.js",
    });
    const without = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter() }), d);
    const empty = await accept({ dod, workRoot: W }, wrote({ perimeter: perimeter([]) }), d);
    expect(without.verdict.outcome).toBe("pass");
    expect(empty.verdict).toEqual(without.verdict);
  });
});

describe("accept() — gate policy", () => {
  it("1. require:'never' disables the gate (accepts without verifying)", async () => {
    const del: Delegation = { dod: detDoD() };
    const r = await accept(del, artefact(), deps({ require: "never" }));
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/disabled/i);
  });

  it("2. no checkable DoD + trivial => skip + accept (GA-6)", async () => {
    const del: Delegation = { dod: noneDoD(), trivial: true };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(true);
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/trivial/i);
  });

  it("2b. trivial + auto-inferred checkable DoD => skip + accept, grader NOT called (GA-6)", async () => {
    const dod = normalizeDoD({ kind: "checker", checks: [], criteria: ["the result is correct"], deliverable: null, source: "inferred" });
    let graderCalls = 0;
    const d = deps();
    d.checker = {
      ...d.checker,
      dispatchGrader: async () => {
        graderCalls++;
        return { sessionID: "grader_sess", text: '{"pass":true,"reasons":[]}' };
      },
    };
    const r = await accept({ dod, trivial: true }, artefact(), d);
    expect(r.accepted).toBe(true);
    expect(r.verdict.skipped).toBe(true);
    expect(r.verdict.reasons[0]).toMatch(/trivial/i);
    expect(graderCalls).toBe(0);
  });

  it("2c. trivial + EXPLICIT checkable DoD => still verified (explicit overrides trivial)", async () => {
    const dod = normalizeDoD({ kind: "checker", checks: [], criteria: ["the result is correct"], deliverable: null, source: "explicit" });
    const d = deps();
    d.checker = {
      ...d.checker,
      dispatchGrader: async () => ({ sessionID: "grader_sess", text: '{"pass":false,"reasons":["nope"]}' }),
    };
    const r = await accept({ dod, trivial: true }, artefact(), d);
    expect(r.accepted).toBe(false);
    expect(r.verdict.skipped).toBeFalsy();
    expect(r.verdict.method).toBe("checker");
  });

  it("3. no checkable DoD + non-trivial + Mode A => not accepted (forcing)", async () => {
    const del: Delegation = { dod: noneDoD(), mode: "modeA" };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(false);
    expect(r.verdict.method).toBe("none");
    expect(r.verdict.reasons[0]).toMatch(/Mode A/);
  });

  it("4. no checkable DoD + non-trivial + Mode B => strict error", async () => {
    const del: Delegation = { dod: noneDoD(), mode: "modeB" };
    const r = await accept(del, artefact(), deps());
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons[0]).toMatch(/Mode B/);
  });
});

describe("accept() — deterministic path", () => {
  it("5. all checks pass => accepted", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: true }) }),
    );
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("deterministic");
    expect(r.verdict.pass).toBe(true);
  });

  it("6. a failing check => not accepted", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: false }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.pass).toBe(false);
  });

  it("11. fail-closed: a throwing seam yields not-accepted (never throws out)", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ throws: true }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.pass).toBe(false);
  });
});

describe("accept() — checker path", () => {
  it("7. grader PASS => accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: true }) }),
    );
    expect(r.accepted).toBe(true);
    expect(r.verdict.method).toBe("checker");
  });

  it("8. grader FAIL => not accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: false }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.method).toBe("checker");
  });

  it("9. GA-3: a lying 'DONE' is rejected by the independent grader", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact({ finalReturnText: "DONE: fully implemented and tested" }),
      deps({ checker: fakeCheckerDeps({ pass: false }) }),
    );
    expect(r.accepted).toBe(false);
  });

  it("10. independence enforced: grader sharing the producer session FAILs", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact({ producerSessionID: "producer-sess" }),
      deps({ checker: fakeCheckerDeps({ graderSessionID: "producer-sess" }) }),
    );
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons.join(" ")).toMatch(/independent/i);
  });

  it("12. strict fail-closed: a throwing grader dispatch => not accepted", async () => {
    const r = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ throws: true }), strictUnverifiable: true }),
    );
    expect(r.accepted).toBe(false);
  });
});

describe("accept() — bookkeeping", () => {
  it("13. dodSource is mirrored from the DoD", async () => {
    const det = await accept({ dod: detDoD() }, artefact(), deps());
    expect(det.dodSource).toBe("explicit");
    const chk = await accept(
      { dod: checkerDoD() },
      artefact(),
      deps({ checker: fakeCheckerDeps({ pass: true }) }),
    );
    expect(chk.dodSource).toBe("inferred");
  });

  it("14. omitted require behaves like 'whenDoDPresent'", async () => {
    const r = await accept(
      { dod: detDoD() },
      artefact(),
      deps({ deterministic: fakeDeterministicDeps({ fileExists: true }) }),
    );
    expect(r.accepted).toBe(true);
  });
});
