import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { canonicalPath } from "../../src/verify/dispatch";
import { accept } from "../../src/verify/gate";
import type { Artefact, Delegation, GateDeps } from "../../src/verify/gate";
import type { DeterministicDeps } from "../../src/verify/types";
import { createMutexRegistry } from "../../src/verify/deterministic";
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
