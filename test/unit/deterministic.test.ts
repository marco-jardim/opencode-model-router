// test/unit/deterministic.test.ts
// Unit tests for src/verify/deterministic.ts — all seams are faked; no real fs/exec.

import { describe, it, expect } from "vitest";
import {
  runDeterministic,
  createMutexRegistry,
  DEFAULT_ALLOWLIST,
  FORBIDDEN_SHELL,
  isCommandAllowed,
  shapeMismatch,
} from "../../src/verify/deterministic";
import {
  createDeadline,
  NO_TESTS_PASS_HOOK,
  SLOT_DEADLINE_REASON,
  type CommandOutcome,
  type OpenCheckScope,
} from "../../src/verify/deterministic";
import { resolveVerifyBudget } from "../../src/router/config";
import type { DoD, Check } from "../../src/verify/dod";
import type { LintSpec } from "../../src/verify/runner";
import type { Deadline, DeterministicDeps, ExecResult, TestsPassHook, TestsPassRequest, TestsPassRun } from "../../src/verify/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoD(checks: Check[]): DoD {
  return { kind: "deterministic", checks, criteria: [], deliverable: null, source: "explicit" };
}

function makeDeps(overrides: Partial<DeterministicDeps> = {}): DeterministicDeps {
  return {
    exec: async (_cmd, _opts) => ({ code: 0, stdout: "", stderr: "" }),
    fs: {
      fileExists: async (_path) => true,
      readFile: async (_path) => "{}",
    },
    cwd: "/fake/cwd",
    ...overrides,
  };
}

function okExec(stdout = "", stderr = ""): DeterministicDeps["exec"] {
  return async (_cmd, _opts) => ({ code: 0, stdout, stderr });
}

function failExec(code = 1, stdout = "", stderr = ""): DeterministicDeps["exec"] {
  return async (_cmd, _opts) => ({ code, stdout, stderr });
}

/** A TestsPassHook that records each request and returns `run` (default: a green scoped run). */
function testsPassHook(run: TestsPassRun = {
  scoped: { kind: "ran", exitCode: 0, notes: [], result: { failingIds: [], failingFiles: [], collectionError: false, total: 1, complete: true, source: "report" } },
  recheck: undefined,
}): { fn: TestsPassHook; requests: TestsPassRequest[]; commands: string[] } {
  const requests: TestsPassRequest[] = [];
  return {
    fn: async req => { requests.push(req); return run; },
    requests,
    get commands() { return requests.map(r => r.command); },
  };
}

function timedOutExec(): DeterministicDeps["exec"] {
  return async (_cmd, _opts): Promise<ExecResult> => ({
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: true,
  });
}

// ---------------------------------------------------------------------------
// runDeterministic: empty checks
// ---------------------------------------------------------------------------

describe("runDeterministic — empty checks", () => {
  it("returns pass:false, method:none, skipped:true when no checks", async () => {
    const dod = makeDoD([]);
    const verdict = await runDeterministic(dod, makeDeps());
    expect(verdict.pass).toBe(false);
    expect(verdict.method).toBe("none");
    expect(verdict.skipped).toBe(true);
    expect(verdict.reasons).toContain("no deterministic checks to run");
  });
});

// ---------------------------------------------------------------------------
// fileExists
// ---------------------------------------------------------------------------

describe("runDeterministic — fileExists", () => {
  it("passes when file exists", async () => {
    const deps = makeDeps({ fs: { fileExists: async () => true, readFile: async () => "{}" } });
    const verdict = await runDeterministic(makeDoD([{ kind: "fileExists", path: "dist/out.js" }]), deps);
    expect(verdict.pass).toBe(true);
    expect(verdict.method).toBe("deterministic");
    expect(verdict.evidence).toContain("exists: dist/out.js");
  });

  it("fails when file does not exist, reason includes 'file not found'", async () => {
    const deps = makeDeps({ fs: { fileExists: async () => false, readFile: async () => "{}" } });
    const verdict = await runDeterministic(makeDoD([{ kind: "fileExists", path: "missing.ts" }]), deps);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("file not found");
    expect(verdict.reasons[0]).toContain("missing.ts");
  });

  it("fails with errored reason when fs throws", async () => {
    const deps = makeDeps({
      fs: {
        fileExists: async () => { throw new Error("EACCES"); },
        readFile: async () => "{}",
      },
    });
    const verdict = await runDeterministic(makeDoD([{ kind: "fileExists", path: "x.ts" }]), deps);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("errored");
  });

  it("fails with 'missing path' reason when path is absent", async () => {
    const verdict = await runDeterministic(makeDoD([{ kind: "fileExists" }]), makeDeps());
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("missing 'path'");
  });
});

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

describe("runDeterministic — run", () => {
  it("passes on exit code 0", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test" }]),
      makeDeps({ exec: okExec() }),
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.evidence).toContain("exit 0: npm test");
  });

  it("fails on non-zero exit code, reason includes 'exited 1'", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test" }]),
      makeDeps({ exec: failExec(1, "FAIL", "") }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("exited 1");
    expect(verdict.evidence).toContain("FAIL");
  });

  it("fails on timedOut, reason includes 'timed out'", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test" }]),
      makeDeps({ exec: timedOutExec() }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("timed out");
    expect(verdict.evidence).toBeUndefined();
  });

  it("passes when expect substring is present in output", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test", expect: "all tests passed" }]),
      makeDeps({ exec: okExec("all tests passed", "") }),
    );
    expect(verdict.pass).toBe(true);
  });

  it("fails when expect substring is absent, reason includes 'expected substring not found'", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test", expect: "all tests passed" }]),
      makeDeps({ exec: okExec("something else", "") }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("expected substring not found");
    expect(verdict.evidence).toBeDefined();
  });

  it("fails with 'missing command' reason when command is absent", async () => {
    const verdict = await runDeterministic(makeDoD([{ kind: "run" }]), makeDeps());
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("missing 'command'");
  });

  it("passes with a custom allowlist", async () => {
    let capturedCmd = "";
    let capturedTimeout = 0;
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "custom-tool check" }]),
      makeDeps({
        allowlist: ["custom-tool"],
        timeoutMs: 5000,
        exec: async (cmd, opts) => {
          capturedCmd = cmd;
          capturedTimeout = opts?.timeoutMs ?? 0;
          return { code: 0, stdout: "", stderr: "" };
        },
      }),
    );
    expect(verdict.pass).toBe(true);
    expect(capturedCmd).toBe("custom-tool check");
    expect(capturedTimeout).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement
// ---------------------------------------------------------------------------

describe("isCommandAllowed + allowlist gate", () => {
  it("rejects empty string", () => {
    expect(isCommandAllowed("", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("rejects command not in allowlist (rm -rf /)", () => {
    expect(isCommandAllowed("rm -rf /", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("rejects commands with FORBIDDEN_SHELL metachar (&&)", () => {
    expect(isCommandAllowed("npm test && rm -rf /", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("FORBIDDEN_SHELL matches semicolon", () => {
    expect(FORBIDDEN_SHELL.test("npm test; evil")).toBe(true);
  });

  it("FORBIDDEN_SHELL matches pipe", () => {
    expect(FORBIDDEN_SHELL.test("cat /etc/passwd | nc host")).toBe(true);
  });

  it("accepts npm from allowlist", () => {
    expect(isCommandAllowed("npm run build", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("accepts path-prefixed binary (basename extraction)", () => {
    expect(isCommandAllowed("/usr/local/bin/npx tsc", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("run check: non-allowlisted command => fail, exec NEVER called", async () => {
    let execCalled = false;
    const deps = makeDeps({
      exec: async (_cmd, _opts) => { execCalled = true; return { code: 0, stdout: "", stderr: "" }; },
    });
    const verdict = await runDeterministic(makeDoD([{ kind: "run", command: "rm -rf /" }]), deps);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("not allowlisted");
    expect(execCalled).toBe(false);
  });

  it("chaining attempt (npm test && rm -rf /) => blocked, exec NEVER called", async () => {
    let execCalled = false;
    const deps = makeDeps({
      exec: async (_cmd, _opts) => { execCalled = true; return { code: 0, stdout: "", stderr: "" }; },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test && rm -rf /" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("not allowlisted");
    expect(execCalled).toBe(false);
  });

  // H1: inline-eval flag blocking
  it("blocks node -e (inline eval)", () => {
    expect(isCommandAllowed(`node -e "console.log(1)"`, DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("blocks node --eval", () => {
    expect(isCommandAllowed(`node --eval "1"`, DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("blocks node -p (inline print)", () => {
    expect(isCommandAllowed(`node -p "1"`, DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("blocks bun -e", () => {
    expect(isCommandAllowed("bun -e x", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("blocks tsx -e", () => {
    expect(isCommandAllowed("tsx -e x", DEFAULT_ALLOWLIST)).toBe(false);
  });

  it("allows node script.js (no eval flag)", () => {
    expect(isCommandAllowed("node script.js", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("allows tsc -p tsconfig.json (tsc is not an interpreter)", () => {
    expect(isCommandAllowed("tsc -p tsconfig.json", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("allows eslint -c .eslintrc.json (eslint is not an interpreter)", () => {
    expect(isCommandAllowed("eslint -c .eslintrc.json", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("allows npm test", () => {
    expect(isCommandAllowed("npm test", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("blocks python3 -c with extended allowlist", () => {
    expect(isCommandAllowed(`python3 -c "x"`, [...DEFAULT_ALLOWLIST, "python3"])).toBe(false);
  });

  it("allows pytest", () => {
    expect(DEFAULT_ALLOWLIST).toContain("pytest");
    expect(DEFAULT_ALLOWLIST).not.toContain("uv");
    expect(isCommandAllowed("pytest -q tests", DEFAULT_ALLOWLIST)).toBe(true);
  });

  it("allows only `uv run pytest ...` for uv", () => {
    expect(isCommandAllowed("uv run pytest -q", DEFAULT_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed("C:\\tools\\uv.exe run pytest", DEFAULT_ALLOWLIST)).toBe(true);
    expect(isCommandAllowed(`uv run python -c "x"`, DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("uv run --with x pytest", DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("uv pip install x", DEFAULT_ALLOWLIST)).toBe(false);
    expect(isCommandAllowed("uvx pytest", DEFAULT_ALLOWLIST)).toBe(false);
    // A user allowlist containing "uv" does not widen the special case.
    expect(isCommandAllowed("uv run python x.py", [...DEFAULT_ALLOWLIST, "uv"])).toBe(false);
    // Without pytest on the allowlist, uv run pytest is refused too.
    expect(isCommandAllowed("uv run pytest", ["npm", "uv"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// testsPass / buildPasses / lintClean defaults
// ---------------------------------------------------------------------------

describe("runDeterministic — repo-command defaults", () => {
  it("testsPass uses default 'npm test' when command absent", async () => {
    const hook = testsPassHook();
    await runDeterministic(makeDoD([{ kind: "testsPass" }]), makeDeps({ testsPass: hook.fn }));
    expect(hook.commands).toEqual(["npm test"]);
  });

  it("buildPasses uses 'npm run build' when a build script exists", async () => {
    let capturedCmd = "";
    const deps = makeDeps({
      fs: { fileExists: async () => true, readFile: async () => '{"scripts":{"build":"tsc"}}' },
      exec: async (cmd, _opts) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
    });
    await runDeterministic(makeDoD([{ kind: "buildPasses" }]), deps);
    expect(capturedCmd).toBe("npm run build");
  });

  it("lintClean uses default 'npm run lint' when command absent", async () => {
    let capturedCmd = "";
    const deps = makeDeps({
      exec: async (cmd, _opts) => { capturedCmd = cmd; return { code: 0, stdout: "", stderr: "" }; },
    });
    await runDeterministic(makeDoD([{ kind: "lintClean" }]), deps);
    expect(capturedCmd).toBe("npm run lint");
  });

  it("testsPass uses deps.defaults.testCommand when check.command absent", async () => {
    const hook = testsPassHook();
    await runDeterministic(makeDoD([{ kind: "testsPass" }]), makeDeps({ defaults: { testCommand: "pnpm test" }, testsPass: hook.fn }));
    expect(hook.commands).toEqual(["pnpm test"]);
  });

  it("testsPass check.command takes precedence over defaults", async () => {
    const hook = testsPassHook();
    await runDeterministic(
      makeDoD([{ kind: "testsPass", command: "npx vitest run" }]),
      makeDeps({ defaults: { testCommand: "pnpm test" }, testsPass: hook.fn }),
    );
    expect(hook.commands).toEqual(["npx vitest run"]);
  });

  it("testsPass: a timed-out scoped run is unverifiable with 'timed out' in the reason", async () => {
    const hook = testsPassHook({ scoped: { kind: "timed-out", boundMs: 5000 }, recheck: undefined });
    const verdict = await runDeterministic(makeDoD([{ kind: "testsPass", command: "npm test" }]), makeDeps({ testsPass: hook.fn }));
    expect(verdict.pass).toBe(false);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.reasons[0]).toContain("timed out");
  });

  it("testsPass never runs its command through deps.exec; without a hook it is unverifiable (G5)", async () => {
    let execCalls = 0;
    const verdict = await runDeterministic(
      makeDoD([{ kind: "testsPass", command: "npm test" }]),
      makeDeps({ exec: async () => { execCalls++; return { code: 0, stdout: "", stderr: "" }; } }),
    );
    expect(execCalls).toBe(0);
    expect(verdict.outcome).toBe("unverifiable");
    expect(verdict.caveats?.[0]).toContain(NO_TESTS_PASS_HOOK);
  });

  it("testsPass: not allowlisted -> unverifiable, the hook is never called (P1)", async () => {
    const hook = testsPassHook();
    const verdict = await runDeterministic(makeDoD([{ kind: "testsPass", command: "npm test && evil" }]), makeDeps({ testsPass: hook.fn }));
    expect(hook.commands).toEqual([]);
    expect(verdict.caveats?.[0]).toBe("command not allowlisted: npm test && evil");
  });

  it("testsPass forwards the request inputs and carries an introduced failure onto the verdict", async () => {
    const reference = { kind: "none", reason: "the dispatch-time capture failed or timed out" } as const;
    const changedFiles = [{ path: "/fake/cwd/src/a.ts", status: " M" }];
    const hook = testsPassHook({
      scoped: { kind: "ran", exitCode: 1, notes: [], result: { failingIds: ["a.test.ts > t"], failingFiles: ["/fake/cwd/a.test.ts"], collectionError: false, total: 1, complete: true, source: "report" } },
      recheck: { kind: "exact", result: undefined, ranFiles: [], absentFiles: ["a.test.ts"], notes: [] },
    });
    const failures: string[] = [];
    const verdict = await runDeterministic(
      makeDoD([{ kind: "testsPass" }]),
      makeDeps({ testsPass: hook.fn, changedFiles, reference, budget: resolveVerifyBudget(undefined, { cores: 8 }), onFailure: r => failures.push(r) }),
    );
    expect(hook.requests[0]).toMatchObject({ cwd: "/fake/cwd", testScope: "affected", changedFiles, reference });
    expect(verdict.outcome).toBe("fail");
    expect(verdict.failures).toEqual({ introduced: ["a.test.ts > t"], preexisting: [], unknown: [] });
    expect(failures).toEqual(["testsPass: introduced failures: a.test.ts > t; observed failures: a.test.ts > t"]);
  });

  it("buildPasses: non-zero exit => fail", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "buildPasses", command: "npm run build" }]),
      makeDeps({ exec: failExec(2, "", "build error") }),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("exited 2");
  });

  it("uses mutex when provided, except for testsPass (P1: 2.2 must batch concurrent gates)", async () => {
    let mutexUsed = false;
    const fakeMutex = {
      runExclusive: async <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
        mutexUsed = true;
        return fn();
      },
    };
    const deps = makeDeps({
      mutex: fakeMutex,
      exec: async (_cmd, _opts) => ({ code: 0, stdout: "", stderr: "" }),
      testsPass: testsPassHook().fn,
    });
    await runDeterministic(makeDoD([{ kind: "testsPass" }]), deps);
    expect(mutexUsed).toBe(false);
    await runDeterministic(makeDoD([{ kind: "lintClean" }]), deps);
    expect(mutexUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildPasses / lintClean / run under per-check scopes (2.1.2.5, T8)
// ---------------------------------------------------------------------------

describe("runDeterministic — command checks under per-check scopes", () => {
  const ranWith = (code: number, stdout = ""): CommandOutcome => ({ kind: "ran", exec: { code, stdout, stderr: "" }, notes: [] });
  function fakeScopes(outcome: (what: string) => CommandOutcome = () => ranWith(0)) {
    const events: string[] = [];
    const deadlines: Deadline[] = [];
    let open = 0;
    let maxOpen = 0;
    const unused = async (): Promise<never> => { throw new Error("not used by command checks"); };
    const openScope: OpenCheckScope = meta => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      events.push(`open ${meta.command}`);
      return {
        execute: unused,
        rechecker: () => unused,
        runShell: async (command, _cwd, deadline) => { deadlines.push(deadline); events.push(`shell ${command}`); return outcome(command); },
        runLint: async (spec, deadline) => { deadlines.push(deadline); events.push(`lint ${spec.inputs.join(",")}`); return outcome(spec.inputs.join(",")); },
        close: async () => { open--; events.push(`close ${meta.command}`); },
      };
    };
    return { openScope, events, deadlines, maxOpen: () => maxOpen };
  }
  const neverExec: DeterministicDeps["exec"] = async () => { throw new Error("scoped checks never use deps.exec"); };
  const lintSpec = (inputs: string[]): LintSpec => ({
    runner: "eslint", file: "/usr/bin/node", args: ["eslint.js", ...inputs], cwd: "/fake/cwd", env: {}, gitRoot: "/fake/cwd",
    entry: "eslint.js", inputs, workers: null, notes: [],
  });

  it("each check opens its own scope and closes it before the next check starts (never nested)", async () => {
    const s = fakeScopes();
    const verdict = await runDeterministic(
      makeDoD([
        { kind: "buildPasses", command: "npm run build" },
        { kind: "run", command: "node check.js" },
        { kind: "lintClean", command: "npx eslint ." },
      ]),
      makeDeps({ exec: neverExec, openScope: s.openScope, planLint: async () => ({ unscoped: true, reason: "change attribution unavailable" }) }),
    );
    expect(verdict.outcome).toBe("pass");
    expect(s.events).toEqual([
      "open npm run build", "shell npm run build", "close npm run build",
      "open node check.js", "shell node check.js", "close node check.js",
      "open npx eslint .", "shell npx eslint .", "close npx eslint .",
    ]);
    expect(s.maxOpen()).toBe(1);
  });

  it("lintClean: NoAffected passes with its note and takes no slot", async () => {
    const s = fakeScopes();
    const verdict = await runDeterministic(
      makeDoD([{ kind: "lintClean", command: "npx eslint ." }]),
      makeDeps({ exec: neverExec, openScope: s.openScope, planLint: async () => ({ noAffected: true, note: "no changed lintable files" }) }),
    );
    expect(verdict.outcome).toBe("pass");
    expect(verdict.notes).toEqual(["lintClean: no changed lintable files"]);
    expect(s.events).toEqual([]);
  });

  // #84 QA-G-B-2-1: a carried acceptance (a role resume re-checking the block of an earlier attempt) never passes on a check that
  // ran no process: "no affected tests" proves nothing about the child's earlier changes.
  it("QA-G-B-2-1: with noAffectedUnverifiable, a NoAffected testsPass or lintClean is unverifiable (never a no-process pass)", async () => {
    const reason = "a carried acceptance";
    const noTests = testsPassHook({ scoped: { kind: "no-affected", note: "no changed files, no affected tests" }, recheck: undefined });
    const tests = await runDeterministic(makeDoD([{ kind: "testsPass", command: "npm test" }]), makeDeps({ testsPass: noTests.fn, noAffectedUnverifiable: reason }));
    expect(tests.outcome).toBe("unverifiable");
    expect(tests.pass).toBe(false);
    expect(tests.reasons.join("\n")).toContain(`${reason} (testsPass: no changed files, no affected tests)`);
    const s = fakeScopes();
    const lint = await runDeterministic(
      makeDoD([{ kind: "lintClean", command: "npx eslint ." }]),
      makeDeps({ exec: neverExec, openScope: s.openScope, planLint: async () => ({ noAffected: true, note: "no changed lintable files" }), noAffectedUnverifiable: reason }),
    );
    expect(lint.outcome).toBe("unverifiable");
    expect(lint.reasons.join("\n")).toContain(`${reason} (lintClean: no changed lintable files)`);
    expect(s.events).toEqual([]);
    // Without the flag (every other dispatch, I1): unchanged.
    expect((await runDeterministic(makeDoD([{ kind: "testsPass", command: "npm test" }]), makeDeps({ testsPass: noTests.fn }))).outcome).toBe("pass");
  });

  it("lintClean: a LintSpec runs through the argv scope and its exit code decides", async () => {
    const s = fakeScopes(() => ranWith(1, "a.ts: 1 problem"));
    const changedFiles = [{ path: "/fake/cwd/a.ts", status: " M" }];
    const inputs: unknown[] = [];
    const verdict = await runDeterministic(
      makeDoD([{ kind: "lintClean", command: "npx eslint ." }]),
      makeDeps({
        exec: neverExec, openScope: s.openScope, changedFiles,
        planLint: async input => { inputs.push(input); return lintSpec(["/fake/cwd/a.ts"]); },
      }),
    );
    expect(inputs[0]).toMatchObject({ command: "npx eslint .", cwd: "/fake/cwd", changedFiles, budget: { maxWorkers: 2 } });
    expect(s.events).toEqual(["open npx eslint .", "lint /fake/cwd/a.ts", "close npx eslint ."]);
    expect(verdict.outcome).toBe("fail");
    expect(verdict.reasons[0]).toBe("command exited 1: npx eslint . (scoped to 1 changed files)");
  });

  it("slot busy and a gate-budget cut are unverifiable; the check's own timeout still fails", async () => {
    const busy = await runDeterministic(
      makeDoD([{ kind: "buildPasses", command: "npm run build" }]),
      makeDeps({ exec: neverExec, openScope: fakeScopes(() => ({ kind: "slot-busy", waitedMs: 60000, deadlineCut: false })).openScope }),
    );
    expect(busy.outcome).toBe("unverifiable");
    expect(busy.caveats).toEqual(["verification slot busy (waited 60000ms)"]);

    const cut = await runDeterministic(
      makeDoD([{ kind: "run", command: "node check.js" }]),
      makeDeps({ exec: neverExec, openScope: fakeScopes(() => ({ kind: "slot-busy", waitedMs: 5000, deadlineCut: true })).openScope }),
    );
    expect(cut.caveats).toEqual([SLOT_DEADLINE_REASON]);

    const timedOut = (): CommandOutcome => ({ kind: "timed-out", boundMs: 120000, exec: { code: -1, stdout: "", stderr: "", timedOut: true } });
    const own = await runDeterministic(
      makeDoD([{ kind: "buildPasses", command: "npm run build" }]),
      makeDeps({ exec: neverExec, openScope: fakeScopes(timedOut).openScope }),
    );
    expect(own.outcome).toBe("fail");
    expect(own.reasons[0]).toBe("buildPasses timed out after 120000ms: npm run build");

    const spent = createDeadline(0);
    try {
      const gate = await runDeterministic(
        makeDoD([{ kind: "buildPasses", command: "npm run build" }]),
        makeDeps({ exec: neverExec, openScope: fakeScopes(timedOut).openScope, deadline: spent }),
      );
      expect(gate.outcome).toBe("unverifiable");
      expect(gate.caveats).toEqual(["buildPasses: gate budget exhausted during the run: npm run build"]);
    } finally {
      spent.dispose();
    }
  });

  it("every scoped check runs under the gate deadline, or its own of gateBudgetMs", async () => {
    const gate = createDeadline(60_000);
    try {
      const s = fakeScopes();
      await runDeterministic(
        makeDoD([{ kind: "buildPasses", command: "npm run build" }, { kind: "run", command: "node check.js" }]),
        makeDeps({ exec: neverExec, openScope: s.openScope, deadline: gate }),
      );
      expect(s.deadlines).toEqual([gate, gate]);
    } finally {
      gate.dispose();
    }
    const s = fakeScopes();
    const budget = { ...resolveVerifyBudget(undefined, { cores: 8 }), gateBudgetMs: 4321 };
    await runDeterministic(makeDoD([{ kind: "run", command: "node check.js" }]), makeDeps({ exec: neverExec, openScope: s.openScope, budget }));
    expect(s.deadlines[0]?.budgetMs).toBe(4321);
  });
});

// ---------------------------------------------------------------------------
// schemaMatch
// ---------------------------------------------------------------------------

describe("runDeterministic — schemaMatch", () => {
  it("passes when target matches schema shape (schema from file path)", async () => {
    const target = JSON.stringify({ name: "foo", version: "1.0" });
    const schema = JSON.stringify({ name: "", version: "" });
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async (p) => (p.endsWith("target.json") ? target : schema),
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema: "schema.json" }]),
      deps,
    );
    expect(verdict.pass).toBe(true);
  });

  it("passes when target matches schema shape (inline schema)", async () => {
    const schema = JSON.stringify({ name: "" });
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async () => JSON.stringify({ name: "bar" }),
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema }]),
      deps,
    );
    expect(verdict.pass).toBe(true);
  });

  it("fails with 'missing' reason when schema has extra key absent from target", async () => {
    const target = JSON.stringify({ name: "foo" });
    const schema = JSON.stringify({ name: "", missingKey: "" });
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async (p) => (p.endsWith("target.json") ? target : schema),
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema: "schema.json" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("missing");
  });

  it("fails with 'expected' reason on type mismatch (number vs string)", async () => {
    const target = JSON.stringify({ count: "not-a-number" });
    const schema = JSON.stringify({ count: 0 });
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async (p) => (p.endsWith("target.json") ? target : schema),
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema: "schema.json" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("expected");
  });

  it("fails with 'not valid JSON' when target file contains invalid JSON", async () => {
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async () => "{ not json }",
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema: "schema.json" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("not valid JSON");
  });

  it("fails with 'not valid JSON' when inline schema is malformed", async () => {
    const deps = makeDeps({
      fs: {
        fileExists: async () => true,
        readFile: async () => JSON.stringify({ x: 1 }),
      },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json", schema: "{ bad json" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("not valid JSON");
  });

  it("fails when path or schema is absent", async () => {
    const verdict = await runDeterministic(
      makeDoD([{ kind: "schemaMatch", path: "target.json" }]), // no schema
      makeDeps(),
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons[0]).toContain("requires 'path' and 'schema'");
  });
});

// ---------------------------------------------------------------------------
// shapeMismatch unit tests
// ---------------------------------------------------------------------------

describe("shapeMismatch", () => {
  it("returns null for matching plain objects", () => {
    expect(shapeMismatch({ a: "", b: 0 }, { a: "hello", b: 42 })).toBeNull();
  });

  it("detects missing key", () => {
    const r = shapeMismatch({ a: "", b: "" }, { a: "x" });
    expect(r).toContain("b: missing");
  });

  it("detects type mismatch at top-level primitive", () => {
    const r = shapeMismatch(0, "str");
    expect(r).toContain("expected number, got string");
  });

  it("detects when schema is object but target is not", () => {
    const r = shapeMismatch({ x: 1 }, [1, 2]);
    expect(r).toContain("expected object");
  });

  it("detects when schema is array but target is not", () => {
    const r = shapeMismatch([], "not array");
    expect(r).toContain("expected array");
  });

  it("returns null for matching arrays (no element check)", () => {
    expect(shapeMismatch([1, 2, 3], [99])).toBeNull();
    expect(shapeMismatch([], [])).toBeNull();
  });

  it("returns null for matching primitives", () => {
    expect(shapeMismatch("a", "b")).toBeNull();
    expect(shapeMismatch(1, 2)).toBeNull();
    expect(shapeMismatch(true, false)).toBeNull();
  });

  it("recurses into nested objects", () => {
    const schema = { outer: { inner: "" } };
    const target = { outer: { inner: 99 } };
    const r = shapeMismatch(schema, target);
    expect(r).toContain("expected string, got number");
  });
});

// ---------------------------------------------------------------------------
// Aggregation: multiple checks
// ---------------------------------------------------------------------------

describe("runDeterministic — aggregation", () => {
  it("overall pass:false when one of many checks fails", async () => {
    let callCount = 0;
    const deps = makeDeps({
      fs: {
        fileExists: async () => { callCount++; return callCount !== 2; }, // second call fails
        readFile: async () => "{}",
      },
    });
    const verdict = await runDeterministic(
      makeDoD([
        { kind: "fileExists", path: "a.ts" },
        { kind: "fileExists", path: "b.ts" }, // this one fails
      ]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.some(r => r.includes("file not found"))).toBe(true);
  });

  it("all pass => reasons=['all N deterministic checks passed'], evidence present", async () => {
    const deps = makeDeps({
      exec: okExec("ok output", ""),
      fs: { fileExists: async () => true, readFile: async () => "{}" },
    });
    const verdict = await runDeterministic(
      makeDoD([
        { kind: "fileExists", path: "src/index.ts" },
        { kind: "run", command: "npm test" },
      ]),
      deps,
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.method).toBe("deterministic");
    expect(verdict.reasons).toEqual(["all 2 deterministic checks passed"]);
    expect(verdict.evidence).toBeDefined();
    expect(verdict.evidence).toContain("exists: src/index.ts");
    expect(verdict.evidence).toContain("exit 0: npm test");
  });

  it("evidence is undefined when no checks produce evidence (fileExists fail only)", async () => {
    const deps = makeDeps({
      fs: { fileExists: async () => false, readFile: async () => "{}" },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "fileExists", path: "missing.ts" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.evidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MutexRegistry
// ---------------------------------------------------------------------------

describe("createMutexRegistry", () => {
  it("serializes same-key calls (start,end,start,end — never start,start)", async () => {
    const registry = createMutexRegistry();
    const log: string[] = [];
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 10));

    const p1 = registry.runExclusive("key", async () => {
      log.push("start1");
      await delay();
      log.push("end1");
      return 1;
    });

    const p2 = registry.runExclusive("key", async () => {
      log.push("start2");
      await delay();
      log.push("end2");
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(log).toEqual(["start1", "end1", "start2", "end2"]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it("different keys may run concurrently", async () => {
    const registry = createMutexRegistry();
    const starts: string[] = [];
    const delay = () => new Promise<void>(resolve => setTimeout(resolve, 10));

    const p1 = registry.runExclusive("a", async () => {
      starts.push("a");
      await delay();
    });
    const p2 = registry.runExclusive("b", async () => {
      starts.push("b");
      await delay();
    });

    await Promise.all([p1, p2]);
    // Both should have started (order may vary but both must appear)
    expect(starts).toContain("a");
    expect(starts).toContain("b");
  });

  it("lock is not wedged when fn rejects — second call still runs", async () => {
    const registry = createMutexRegistry();
    let secondRan = false;

    const p1 = registry.runExclusive("key", async () => {
      throw new Error("deliberate failure");
    });

    const p2 = registry.runExclusive("key", async () => {
      secondRan = true;
      return 42;
    });

    await p1.catch(() => {}); // consume rejection
    const result = await p2;

    expect(secondRan).toBe(true);
    expect(result).toBe(42);
  });

  it("rejection propagates from runExclusive when fn throws", async () => {
    const registry = createMutexRegistry();
    const p = registry.runExclusive("k", async () => { throw new Error("boom"); });
    await expect(p).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

describe("runDeterministic — secret scrubbing", () => {
  it("redacts Anthropic-style token from exec stderr in evidence and reasons", async () => {
    const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const deps = makeDeps({
      exec: async (_cmd, _opts) => ({ code: 1, stdout: "", stderr: `auth error: ${secret}` }),
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.evidence).toBeDefined();
    expect(verdict.evidence).not.toContain(secret);
    expect(verdict.evidence).toContain("[REDACTED]");
    // reason ("command exited 1: npm test") doesn't contain the secret either
    expect(verdict.reasons.join(" ")).not.toContain(secret);
  });

  it("redacts secrets from exec errors in reason", async () => {
    const secret = "sk-ant-ZZZZYYYY11112222333344445555666677778888";
    const deps = makeDeps({
      exec: async (_cmd, _opts) => { throw new Error(`network error token=${secret}`); },
    });
    const verdict = await runDeterministic(
      makeDoD([{ kind: "run", command: "npm test" }]),
      deps,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(" ")).not.toContain(secret);
  });
});
