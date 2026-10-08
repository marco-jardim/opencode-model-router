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
    [join(base, "inside.ts"), join(outside, "outside.ts")],
    ["relative.ts"],
    ["relative.ts", join(outside, "outside.ts")],
    [],
  ])("runs checks unless all changes are absolute and outside: %j", async (...paths) => {
    const { exec, d, dod } = setup();
    const r = await accept({ dod }, changed(paths), d);
    expect(r.verdict.outcome).toBe("pass");
    expect(exec).toHaveBeenCalled();
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

  it("does not apply the safety net to a checker DoD", async () => {
    const { d } = setup();
    const dispatchGrader = vi.fn<CheckerDeps["dispatchGrader"]>().mockResolvedValue({ sessionID: "grader", text: '{"pass":true,"reasons":[]}' });
    const r = await accept({ dod: checkerDoD() }, changed([join(outside, "file.ts")]), { ...d, checker: { ...d.checker, dispatchGrader } });
    expect(r.verdict.outcome).toBe("pass");
    expect(dispatchGrader).toHaveBeenCalled();
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
