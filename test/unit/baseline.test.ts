import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { observeTests, REFERENCE_NONE } from "../../src/verify/baseline";
import { ABSENT_DIGEST, contaminatedReferenceReason, createChangedFileStore, buildAcceptedSuffix, type TreeSnapshot, type DispatchCaptureDeps } from "../../src/verify/dispatch";
import { accept, type Artefact } from "../../src/verify/gate";
import { buildGradingPrompt } from "../../src/verify/checker";
import { validateConfig } from "../../src/router/config";
import { nextAction, newLadderState } from "../../src/escalate/ladder";
import type { RecheckOutcome, ScopedOutcome, TestsPassRequest, TestsPassRun } from "../../src/verify/types";
import { judgeScoped, formatIds } from "../../src/verify/baseline";
import type { RunResult } from "../../src/verify/runner";
import type { DispatchReference } from "../../src/verify/reference";
import { NO_TESTS_PASS_HOOK } from "../../src/verify/deterministic";

const cwd = resolve("baseline-workspace");
const tree = (over: Partial<TreeSnapshot> = {}): TreeSnapshot => ({ cwd, head: "head1", fingerprint: "diff1", dirty: false, files: [], ...over });
const artefact: Artefact = { changedFiles: [], declaredOutputs: [], finalReturnText: "done", producerTier: "medium", producerSessionID: "child" };
const FILE = "a.test.ts";
const id = (name: string): string => `${FILE} > ${name}`;
const result = (failingIds: string[], o: Partial<RunResult> = {}): RunResult => ({
  failingIds, failingFiles: failingIds.length ? [resolve(cwd, FILE)] : [], collectionError: false, total: 4, complete: true, source: "report", ...o,
});
const scopedRun = (r: RunResult, exitCode = r.failingIds.length ? 1 : 0): ScopedOutcome => ({ kind: "ran", result: r, exitCode, notes: [] });
/** An exact recheck in which FILE ran at the dispatch reference with `refIds` failing. */
const atReference = (refIds: string[]): RecheckOutcome => ({ kind: "exact", result: result(refIds), ranFiles: [FILE], absentFiles: [], notes: [] });
const REF: DispatchReference = { root: cwd, head: "head1", commit: "head1", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };
const captured = { kind: "captured", reference: REF };

/** Runs the gate with a testsPass hook that returns `run` (no hook when undefined); the test command itself must never run. */
async function grade(run: TestsPassRun | undefined, seen: TestsPassRequest[] = []) {
  return accept({ dod: { kind: "deterministic", checks: [{ kind: "testsPass" }], criteria: [], deliverable: null, source: "explicit" } }, artefact, {
    deterministic: {
      cwd,
      exec: async () => { throw new Error("testsPass must never run its command through deps.exec"); },
      fs: { fileExists: async () => false, readFile: async () => "" },
      ...(run ? { testsPass: async (req: TestsPassRequest) => { seen.push(req); return run; } } : {}),
    },
    checker: { dispatchGrader: async () => ({ sessionID: "grader", text: "" }) },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

describe("reference-aware testsPass", () => {
  it("rejects and escalates a producer failure that passes at the dispatch reference", async () => {
    const r = await grade({ scoped: scopedRun(result([id("new-test")])), recheck: atReference([]) });
    expect(r.accepted).toBe(false);
    expect(r.verdict.outcome).toBe("fail");
    expect(r.verdict.reasons[0]).toContain("new-test");
    // 2.4 lineage: the gate result exposes the introduced ids.
    expect(r.verdict.failures).toEqual({ introduced: [id("new-test")], preexisting: [], unknown: [] });
    const policy = { ladder: ["medium", "heavy"], maxAttemptsPerTier: 0, maxTotalAttempts: 4 };
    expect(nextAction(newLadderState("medium", policy), r.verdict, policy).action).toBe("escalate");
  });
  it("accepts unchanged pre-existing failures with an explicit no-worse note", async () => {
    const r = await grade({ scoped: scopedRun(result([id("old-test")])), recheck: atReference([id("old-test")]) });
    expect(r.accepted).toBe(true);
    expect(r.verdict.outcome).toBe("pass");
    expect(r.verdict.failures).toEqual({ introduced: [], preexisting: [id("old-test")], unknown: [] });
    const output = buildAcceptedSuffix(r.verdict.method, r.verdict.outcome, r.verdict.caveats, r.verdict.notes);
    expect(output).toContain("[router \u2713 verified: deterministic]");
    expect(output).toContain("no worse than before");
    expect(output).toContain("NOT green");
    expect(output).toContain("exact dispatch reference");
  });
  it("rejects only the additional failure, never blaming the old one", async () => {
    const r = await grade({ scoped: scopedRun(result([id("new-test"), id("old-test")])), recheck: atReference([id("old-test")]) });
    expect(r.accepted).toBe(false);
    expect(r.verdict.reasons.join()).toContain(`introduced failures: ${id("new-test")};`);
    expect(r.verdict.failures?.introduced).toEqual([id("new-test")]);
    expect(r.verdict.failures?.preexisting).toEqual([id("old-test")]);
    const policy = { ladder: ["medium", "heavy"], maxAttemptsPerTier: 0, maxTotalAttempts: 4 };
    expect(nextAction(newLadderState("medium", policy), r.verdict, policy).action).toBe("escalate");
  });
  it("detects a replacement failure even when counts are equal", async () => {
    expect((await grade({ scoped: scopedRun(result([id("new")])), recheck: atReference([id("old")]) })).accepted).toBe(false);
  });
  it("accepts a failure without a reference as unverifiable with observed failures and a caveat", async () => {
    const r = await grade({ scoped: scopedRun(result([id("observed-test")])), recheck: { kind: "unusable", cause: "no-reference", reason: REFERENCE_NONE.failed } });
    expect(r.accepted).toBe(true);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.verdict.caveats?.join()).toContain("observed-test");
    expect(r.verdict.caveats?.join()).toContain("no reference");
    const output = buildAcceptedSuffix(r.verdict.method, r.verdict.outcome, r.verdict.caveats, r.verdict.notes);
    // QA-3.1-21 (plan G2): an unverifiable result is never labelled accepted or verified.
    expect(output).toContain("[router \u26a0 UNVERIFIED: deterministic]");
    expect(output).not.toMatch(/\u2713|accepted|\bverified:/);
    expect(output).toContain("Verification caveats — NOT verified");
    expect(output).toContain("observed-test");
  });
  it("passes a green scoped run without a recheck, and never runs tests without a pipeline (G5)", async () => {
    const seen: TestsPassRequest[] = [];
    expect((await grade({ scoped: scopedRun(result([])), recheck: undefined }, seen)).verdict.outcome).toBe("pass");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      command: "npm test", cwd, testScope: "affected", changedFiles: "unavailable",
      reference: { kind: "none", reason: REFERENCE_NONE.untracked },
    });
    const bare = await grade(undefined);
    expect(bare.verdict.outcome).toBe("unverifiable");
    expect(bare.verdict.caveats?.join()).toContain(NO_TESTS_PASS_HOOK);
  });
  it("an opaque failing run without identities is unverifiable, never a pass or a rejection (G2)", async () => {
    const opaque = { code: 2, stdout: "custom runner broke", stderr: "" };
    expect(observeTests(opaque)).toMatchObject({ code: 2, failures: [], complete: false });
    for (const recheck of [atReference([]), undefined]) {
      const r = await grade({ scoped: scopedRun(result([], { complete: false, source: "text", note: "custom runner broke" }), 2), recheck });
      expect(r.verdict.outcome).toBe("unverifiable");
      expect(r.accepted).toBe(true);
    }
  });
  it("count-only output yields no identities, so it can neither excuse nor reject", () => {
    expect(observeTests({ code: 1, stdout: "3 failing", stderr: "" })).toMatchObject({ failures: [], count: 3, complete: false });
    expect(judgeScoped(scopedRun(result([], { complete: false, source: "text" }), 1), atReference([]))).toMatchObject({ ok: false, unverifiable: true });
  });
  it("parses multiple runner formats opportunistically without counting failing suites as tests", () => {
    expect(observeTests({ code: 1, stdout: " FAIL test/a.ts > suite > test\n Tests  1 failed | 2 passed", stderr: "" })).toMatchObject({ failures: ["test/a.ts > suite > test"], count: 1, complete: true });
    expect(observeTests({ code: 1, stdout: "--- FAIL: TestThing (0.01s)\nFAIL package 0.1s", stderr: "" }).failures).toEqual(["TestThing"]);
    expect(observeTests({ code: 1, stdout: JSON.stringify({ numFailedTests: 1, testResults: [{ name: "suite", assertionResults: [{ status: "failed", fullName: "test" }] }] }), stderr: "" })).toMatchObject({ failures: ["suite > test"], complete: true });
    expect(observeTests({ code: 1, stdout: "Test Files 8 failed\nTests 1 failed", stderr: "" }).count).toBe(1);
  });
});

describe("dispatch reference capture in the changed-file store", () => {
  function harness() {
    let snapshot = tree();
    let now = 0;
    const store = createChangedFileStore({ now: () => now });
    const capture = vi.fn(async (_cwd: string, _signal: AbortSignal): Promise<DispatchReference | undefined> => REF);
    const deps: DispatchCaptureDeps = { snapshot: async () => snapshot, capture, timeoutMs: 50 };
    const start = (dispatch: string) => store.beginDispatch(dispatch, cwd, deps);
    const get = (dispatch: string) => store.reference(dispatch);
    return { store, deps, capture, start, get, setTree: (s: TreeSnapshot) => { snapshot = s; }, tick: (n: number) => { now = n; } };
  }
  it("captures in the background and resolves once the capture settled", async () => {
    const h = harness();
    const started = h.start("first");
    expect(started).toBeInstanceOf(Promise);
    await started;
    expect(await h.get("first")).toEqual(captured);
    h.store.clear("first");
    expect(await h.get("first")).toEqual({ kind: "none", reason: REFERENCE_NONE.untracked });
    await h.start("second");
    expect(await h.get("second")).toEqual(captured);
    expect(h.capture).toHaveBeenCalledTimes(2);
  });
  it("a retry keeps the original dispatch's reference", async () => {
    const h = harness();
    await h.start("first");
    h.capture.mockResolvedValue({ ...REF, commit: "after-the-failed-attempt" });
    await h.start("first");
    expect(await h.get("first")).toEqual(captured);
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
  it("without a capture the dispatch keeps its uncaptured state and still snapshots", async () => {
    const h = harness();
    await h.store.beginDispatch("off", cwd, { snapshot: h.deps.snapshot, timeoutMs: 50, uncaptured: { kind: "disabled" } });
    await h.store.beginDispatch("readonly", cwd, { snapshot: h.deps.snapshot, timeoutMs: 50 });
    expect(await h.get("off")).toEqual({ kind: "disabled" });
    expect(await h.get("readonly")).toEqual({ kind: "none", reason: REFERENCE_NONE.notRequested });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.store.delta("off", "child", tree()).changeBaseline).toBe("available");
  });
  it.each(["edit", "patch", "bash"])("discards a reference contaminated by %s mid-capture", async cause => {
    const h = harness(); const held = deferred<DispatchReference | undefined>(); let signal: AbortSignal | undefined;
    h.capture.mockImplementationOnce(async (_c, s) => { signal = s; return held.promise; });
    const settled = h.start("child");
    await vi.waitFor(() => expect(signal).toBeDefined());
    const tool = cause === "patch" ? "apply_patch" : cause;
    h.store.observeEdit(tool, cwd);
    expect(signal?.aborted).toBe(true);
    held.resolve(REF);
    await settled;
    // QA-3.1-3: the reason names the tool whose call discarded the capture.
    expect(await h.get("child")).toEqual({ kind: "none", reason: `${REFERENCE_NONE.contaminated} (tool "${tool}")` });
    const r = await grade({ scoped: scopedRun(result([id("observed")])), recheck: { kind: "unusable", cause: "no-reference", reason: REFERENCE_NONE.contaminated } });
    expect(r.verdict.outcome).toBe("unverifiable");
    expect(r.accepted).toBe(true);
  });
  it("an edit during initial fingerprinting also discards the snapshot", async () => {
    const h = harness(); const held = deferred<TreeSnapshot>();
    h.deps.snapshot = () => held.promise;
    const settled = h.start("child"); h.store.observeEdit("edit", cwd); held.resolve(tree());
    await settled;
    expect(h.store.delta("child", "child", tree()).changeBaseline).toBe("unavailable");
    expect(h.store.snapshotContaminatedBy("child")).toBe("edit");
    expect(await h.get("child")).toEqual({ kind: "none", reason: contaminatedReferenceReason("edit") });
  });
  // E2E-3: opencode fires tool.execute.before for MCP tools (`<server>_<tool>`) and custom tools
  // too. An edit by one of them that lands while the dispatch snapshot is still in flight
  // (VERIFY_WAIT:0s) used to seed the baseline: the change set came out empty and available, so the
  // gate passed "no changed files" without running anything.
  it.each(["filesystem_write_file", "morph_edit", "batch", "Serena_replace_symbol_body"])(
    "a tool not known to be non-writing (%s) mid-snapshot leaves no change baseline and no reference (E2E-3)",
    async tool => {
      const h = harness();
      const snap = deferred<TreeSnapshot>();
      const ref = deferred<DispatchReference | undefined>();
      let signal: AbortSignal | undefined;
      h.deps.snapshot = () => snap.promise;
      h.capture.mockImplementationOnce(async (_c, s) => { signal = s; return ref.promise; });
      const settled = h.start("child");
      await vi.waitFor(() => expect(signal).toBeDefined());
      // No cwd: MCP and custom tools carry none, so the edit overlaps every dispatch.
      h.store.observeEdit(tool);
      expect(signal?.aborted).toBe(true);
      // Both settle AFTER the edit and so already contain it.
      const edited = tree({ fingerprint: "after-edit", dirty: true, files: [{ path: resolve(cwd, "src", "a.ts"), status: " M" }] });
      snap.resolve(edited);
      ref.resolve(REF);
      await settled;
      const delta = h.store.delta("child", "child", edited);
      expect(delta.changeBaseline).toBe("unavailable");
      expect(h.store.baselineSnapshot("child")).toBeUndefined();
      // QA-3.1-3: both discards name the unknown tool, so the unverifiable verdict can say which.
      expect(h.store.snapshotContaminatedBy("child")).toBe(tool);
      expect(await h.get("child")).toEqual({ kind: "none", reason: `${REFERENCE_NONE.contaminated} (tool "${tool}")` });
    },
  );
  it.each(["read", "glob", "grep", "task", "delegate", "router_verify", "todowrite", "webfetch", "read_mcp_resource", "skill"])(
    "a non-writing tool (%s) mid-snapshot keeps the change baseline and the reference",
    async tool => {
      const h = harness();
      const snap = deferred<TreeSnapshot>();
      const ref = deferred<DispatchReference | undefined>();
      let signal: AbortSignal | undefined;
      h.deps.snapshot = () => snap.promise;
      h.capture.mockImplementationOnce(async (_c, s) => { signal = s; return ref.promise; });
      const settled = h.start("child");
      await vi.waitFor(() => expect(signal).toBeDefined());
      h.store.observeEdit(tool);
      expect(signal?.aborted).toBe(false);
      snap.resolve(tree());
      ref.resolve(REF);
      await settled;
      expect(h.store.delta("child", "child", tree()).changeBaseline).toBe("available");
      expect(await h.get("child")).toEqual(captured);
    },
  );
  it("editing a different known directory does not contaminate capture", async () => {
    const h = harness(); const held = deferred<DispatchReference | undefined>();
    h.capture.mockImplementationOnce(() => held.promise);
    const settled = h.start("child");
    h.store.observeEdit("edit", resolve("unrelated-workspace")); held.resolve(REF);
    await settled;
    expect(await h.get("child")).toEqual(captured);
  });
  it("the capture is bounded, aborted at its timeout, and yields no reference", async () => {
    vi.useFakeTimers(); const h = harness(); let signal: AbortSignal | undefined;
    h.capture.mockImplementationOnce(async (_c, s) => { signal = s; return new Promise<undefined>(() => {}); });
    void h.start("child"); const pending = h.get("child");
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ kind: "none", reason: REFERENCE_NONE.failed }); expect(signal?.aborted).toBe(true);
  });
  it("a gate signal bounds the wait for a capture still in flight", async () => {
    const h = harness(); const held = deferred<DispatchReference | undefined>();
    h.capture.mockImplementationOnce(() => held.promise);
    const settled = h.start("child"); const gate = new AbortController();
    const waiting = h.store.reference("child", gate.signal); gate.abort();
    expect(await waiting).toEqual({ kind: "none", reason: REFERENCE_NONE.gateBudget });
    held.resolve(REF);
    await settled;
    expect(await h.get("child")).toEqual(captured);
  });
  it("TTL sweeps dispatch references with their dispatch", async () => {
    const h = harness(); await h.start("first");
    h.tick(100); h.store.sweep(100, 100);
    expect(await h.get("first")).toEqual({ kind: "none", reason: REFERENCE_NONE.untracked });
    await h.start("second");
    expect(h.capture).toHaveBeenCalledTimes(2);
  });
  it("grader receives child edits union new changed paths, not unrelated pre-existing dirt", async () => {
    const h = harness(); const old = resolve(cwd, "old.ts"); const edited = resolve(cwd, "edited.ts"); const added = resolve(cwd, "new.ts");
    const before = tree({ dirty: true, files: [{ path: old, status: " M" }, { path: edited, status: " M" }] });
    h.setTree(before); await h.start("dispatch");
    h.store.record("child", "edit", { filePath: edited });
    const delta = h.store.delta("dispatch", "child", { ...before, files: [...before.files, { path: added, status: "??" }] });
    expect(delta.changedFiles.map(f => f.path).sort()).toEqual([edited, added].sort());
    const prompt = buildGradingPrompt({ criteria: ["investigate"], artefact: { ...artefact, ...delta }, producerTier: "medium", producerSessionID: "child" }).prompt;
    expect(prompt).toContain("Producer delta only"); expect(prompt).toContain("predate the dispatch");
    expect(prompt).not.toContain(old);
    expect(prompt).toContain(edited); expect(prompt).toContain(added);
  });
  it("a retry's change set keeps every earlier attempt's tool edits (QA-2.1-1)", async () => {
    const h = harness();
    const a = resolve(cwd, "src/a.js"); const b = resolve(cwd, "src/b.js"); const c = resolve(cwd, "src/c.js");
    // src/a.js is already dirty at dispatch, so the snapshot part never adds it.
    const before = tree({ dirty: true, files: [{ path: a, status: " M" }] });
    h.setTree(before); await h.start("p1");
    h.store.record("p1", "edit", { filePath: a });
    expect(h.store.delta("p1", "p1", before).changedFiles.map(f => f.path)).toEqual([a]);
    // Attempt 2 is a new producer session judged against p1's reference; it only creates b.
    h.store.record("p2", "write", { filePath: b });
    h.store.record("unrelated", "edit", { filePath: resolve(cwd, "elsewhere.ts") });
    const second = h.store.delta("p1", "p2", { ...before, files: [...before.files, { path: b, status: "??" }] });
    expect(second.changedFiles.map(f => f.path).sort()).toEqual([a, b].sort());
    // The ladder clears a retry's session after its gate: attempt 3 still sees a and b.
    h.store.clear("p2");
    h.store.record("p3", "edit", { filePath: b });
    h.store.record("p3", "edit", { filePath: c });
    const third = h.store.delta("p1", "p3", before);
    expect(third.changedFiles.map(f => f.path).sort()).toEqual([a, b, c].sort());
    expect(third.changedFiles).toContainEqual({ path: a, status: " M" });
    expect(third.changedFiles).toContainEqual({ path: b, status: "written" });
    expect(third.changedFiles).toContainEqual({ path: c, status: "modified" });
  });
  describe("canonical change-set keys (QA-2.1-8)", () => {
    const withAlias = (body: (real: string, alias: string) => Promise<void>) => async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-canon-")));
      const real = join(root, "Real Project");
      mkdirSync(join(real, "src"), { recursive: true });
      writeFileSync(join(real, "src", "b.js"), "export {};\n");
      writeFileSync(join(real, "src", "gone.js"), "export {};\n");
      const alias = join(root, "alias");
      symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
      try {
        await body(real, alias);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    };
    /** The 8.3 short spelling of `p`, or undefined when the volume has no short names. */
    const shortName = (p: string): string | undefined => {
      if (process.platform !== "win32") return undefined;
      try {
        const out = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${p}") do @echo %~sI"`], {
          encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true,
        }).stdout.trim();
        return out && out.toLowerCase() !== p.toLowerCase() ? out : undefined;
      } catch {
        return undefined;
      }
    };
    const oneEntry = async (dispatchCwd: string, toolPath: string, listedPath: string, status = " M") => {
      const h = harness();
      h.setTree(tree({ cwd: dispatchCwd }));
      await h.store.beginDispatch("d", dispatchCwd, h.deps);
      h.store.record("child", "edit", { filePath: toolPath });
      return h.store.delta("d", "child", tree({ cwd: dispatchCwd, dirty: true, files: [{ path: listedPath, status }] })).changedFiles;
    };
    it("a tool path through a junction or symlink alias and the real snapshot path are one entry", withAlias(async (real, alias) => {
      const changed = await oneEntry(alias, join(alias, "src", "b.js"), join(real, "src", "b.js"));
      expect(changed).toEqual([{ path: join(real, "src", "b.js"), status: " M" }]);
    }));
    it("a deletion seen through the alias keeps the snapshot's status (canonical parent, missing file)", withAlias(async (real, alias) => {
      rmSync(join(real, "src", "gone.js"));
      const changed = await oneEntry(alias, join(alias, "src", "gone.js"), join(real, "src", "gone.js"), " D");
      expect(changed).toEqual([{ path: join(real, "src", "gone.js"), status: " D" }]);
    }));
    it("an 8.3 short-name spelling and the long path of one file are one entry (win32, where short names exist)", withAlias(async (real) => {
      const short = shortName(real);
      if (short === undefined) return; // No 8.3 names on this volume (or not win32): nothing to collapse.
      const changed = await oneEntry(short, join(short, "src", "b.js"), join(real, "src", "b.js"));
      expect(changed).toEqual([{ path: join(real, "src", "b.js"), status: " M" }]);
    }));
    it.runIf(process.platform === "win32")("compares case-insensitively on win32", withAlias(async (real) => {
      const changed = await oneEntry(real, join(real.toUpperCase(), "SRC", "B.JS"), join(real, "src", "b.js"));
      expect(changed).toEqual([{ path: join(real, "src", "b.js"), status: " M" }]);
    }));
  });
  describe("paths already dirty or untracked at dispatch (QA-2.1-2)", () => {
    const [a, b, c, d, u] = ["a.js", "b.js", "c.js", "d.js", "notes.txt"].map(n => resolve(cwd, n));
    const before = tree({
      dirty: true, fingerprint: "f1",
      files: [{ path: a, status: " M" }, { path: b, status: " M" }, { path: c, status: " M" }, { path: d, status: " M" }, { path: u, status: "??" }],
      digests: new Map([[a, "file:a1"], [b, "file:b1"], [c, "file:c1"], [d, "file:d1"], [u, "file:u1"]]),
    });
    const gate = async (current: TreeSnapshot, dispatch: TreeSnapshot = before) => {
      const h = harness(); h.setTree(dispatch); await h.start("d");
      return h.store.delta("d", "d", current);
    };
    it("adds a changed digest (sed), a restore (git checkout), a deletion (git rm, rm) and an undigested path; never an unchanged one", async () => {
      const current = tree({
        dirty: true, fingerprint: "f2",
        files: [{ path: a, status: " M" }, { path: c, status: " M" }, { path: d, status: "D " }],
        // b: restored to HEAD (no longer listed); u: deleted; c: unchanged; a: edited; d: git rm.
        digests: new Map([[a, "file:a2"], [b, "file:b0"], [c, "file:c1"], [d, ABSENT_DIGEST], [u, ABSENT_DIGEST]]),
      });
      const delta = await gate(current);
      expect(delta.changeBaseline).toBe("available");
      expect(delta.changedFiles).toEqual(expect.arrayContaining([
        { path: a, status: " M" }, { path: b, status: " M" }, { path: d, status: "D " }, { path: u, status: " D" },
      ]));
      expect(delta.changedFiles.map(f => f.path)).not.toContain(c);
      expect(delta.changedFiles).toHaveLength(4);
      // Same digests: only a path that left the listing (b) or that the gate did not digest (u) is added.
      const partial = await gate({ ...current, digests: new Map([[a, "file:a1"], [b, "file:b1"], [c, "file:c1"], [d, "file:d1"]]) });
      expect(partial.changedFiles.map(f => f.path).sort()).toEqual([b, u].sort());
    });
    it("without per-file digests a changed fingerprint widens to every dispatch-listed path, still available (QA-2.1-14)", async () => {
      const edited = tree({ ...before, fingerprint: "f2", files: [{ path: a, status: " M" }, { path: c, status: "D " }, { path: u, status: "??" }] });
      const gone = resolve(cwd, "no-such-dir-qa2114", "b.js");
      for (const [dispatch, current] of [
        [{ ...before, digests: "unavailable" as const }, edited],
        [before, { ...edited, digests: "unavailable" as const }],
        [{ ...before, digests: undefined }, edited],
        [before, { ...edited, digests: undefined }],
      ]) {
        const delta = await gate(current, dispatch);
        expect(delta.changeBaseline).toBe("available");
        // Still listed: the current status. Left the listing: modified if on disk, else deleted.
        expect(delta.changedFiles).toEqual(expect.arrayContaining([
          { path: a, status: " M" }, { path: c, status: "D " }, { path: u, status: "??" },
        ]));
        expect(delta.changedFiles.map(f => f.path).sort()).toEqual([a, b, c, d, u].sort());
      }
      const left = tree({ ...before, files: [{ path: gone, status: " M" }], digests: "unavailable" });
      expect((await gate(tree({ ...left, fingerprint: "f2", files: [] }), left)).changedFiles).toEqual([{ path: gone, status: " D" }]);
      const same = await gate({ ...before, digests: "unavailable" }, { ...before, digests: "unavailable" });
      expect(same).toEqual({ changedFiles: [], changeBaseline: "available" });
    });
  });
  it("tool-observed paths take the snapshot's status letters and rename source", async () => {
    const h = harness(); await h.start("dispatch");
    const gone = resolve(cwd, "gone.ts"); const old = resolve(cwd, "old.ts"); const moved = resolve(cwd, "moved.ts");
    h.store.record("child", "apply_patch", { patchText: "*** Begin Patch\n*** Delete File: gone.ts\n*** Update File: old.ts\n*** Move to: moved.ts\n*** End Patch" });
    const current = tree({ files: [{ path: gone, status: " D" }, { path: moved, status: "R ", previousPath: old }] });
    const { changedFiles } = h.store.delta("dispatch", "child", current);
    expect(changedFiles).toContainEqual({ path: gone, status: " D" });
    expect(changedFiles).toContainEqual({ path: moved, status: "R ", previousPath: old });
    expect(changedFiles).toContainEqual({ path: old, status: "modified" });
  });
  it("missing snapshot never substitutes a raw dirty tree and explicitly disclaims attribution", () => {
    const h = harness(); const old = resolve(cwd, "old.ts");
    const delta = h.store.delta("missing", "child", tree({ files: [{ path: old, status: " M" }] }));
    expect(delta.changedFiles).toEqual([]);
    const prompt = buildGradingPrompt({ criteria: [], artefact: { ...artefact, ...delta }, producerTier: "medium", producerSessionID: "child" }).prompt;
    expect(prompt).toContain("snapshot unavailable"); expect(prompt).not.toContain(old);
  });
  it("read-only tools neither record a change nor contaminate a capture in flight", async () => {
    const h = harness(); const held = deferred<DispatchReference | undefined>(); let signal: AbortSignal | undefined;
    h.capture.mockImplementationOnce(async (_c, s) => { signal = s; return held.promise; });
    const settled = h.start("child");
    await vi.waitFor(() => expect(signal).toBeDefined());
    h.store.record("child", "read", { filePath: "a.ts" });
    h.store.observeEdit("grep", cwd);
    expect(signal?.aborted).toBe(false);
    expect(h.store.get("child")).toEqual([]);
    expect(h.store.get("never-seen")).toEqual([]);
    held.resolve(REF);
    await settled;
    expect(await h.get("child")).toEqual(captured);
  });
  it("a snapshot that rejects leaves the change baseline unavailable but still captures", async () => {
    const h = harness();
    h.deps.snapshot = async () => { throw new Error("git broke"); };
    await h.start("child");
    expect(h.store.delta("child", "child", tree()).changeBaseline).toBe("unavailable");
    expect(await h.get("child")).toEqual(captured);
  });
  it("an already-spent gate signal returns gateBudget without waiting for the capture", async () => {
    const h = harness(); const held = deferred<DispatchReference | undefined>();
    h.capture.mockImplementationOnce(() => held.promise);
    const settled = h.start("child"); const gate = new AbortController(); gate.abort();
    expect(await h.store.reference("child", gate.signal)).toEqual({ kind: "none", reason: REFERENCE_NONE.gateBudget });
    held.resolve(REF);
    await settled;
    expect(await h.store.reference("child", gate.signal)).toEqual(captured);
  });
  it("patch edit logs cover additions, updates, removals and rename destinations", () => {
    const h = harness();
    h.store.record("child", "apply_patch", { patchText: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: renamed.ts\n*** Add File: new.ts\n*** Delete File: gone.ts\n*** End Patch" });
    expect(h.store.get("child").map(f => f.path)).toEqual(["old.ts", "renamed.ts", "new.ts", "gone.ts"]);
  });
});

it("validateConfig validates both baseline settings without requiring either", () => {
  const cfg = { activePreset: "a", presets: { a: { fast: { model: "p/m" } } }, rules: [], defaultTier: "fast" };
  expect(validateConfig(cfg).enforcement).toBeUndefined();
  for (const testBaseline of [true, false]) expect(validateConfig({ ...cfg, enforcement: { verify: { testBaseline, baselineTimeoutMs: 1 } } }).enforcement?.verify?.testBaseline).toBe(testBaseline);
  expect(() => validateConfig({ ...cfg, enforcement: { verify: { testBaseline: "yes" } } })).toThrow("testBaseline must be a boolean");
  for (const baselineTimeoutMs of [0, -1, 1.5, "100", Infinity]) expect(() => validateConfig({ ...cfg, enforcement: { verify: { baselineTimeoutMs } } })).toThrow("baselineTimeoutMs must be an integer");
});

describe("judgeScoped verdict algebra (deterministic.ts T5-T7)", () => {
  const ID = "a.test.ts > t1";
  const OBS = `; observed failures: ${ID}`;
  const rr = (failingIds: string[], o: Partial<RunResult> = {}): RunResult => ({
    failingIds, failingFiles: failingIds.map(id => `/repo/${id.split(" > ")[0]}`), collectionError: false,
    total: 3, complete: true, source: "text", ...o,
  });
  const ran = (result: RunResult, exitCode = 1): ScopedOutcome => ({ kind: "ran", result, exitCode, notes: [] });
  const exact = (refIds: string[], o: Partial<Extract<RecheckOutcome, { kind: "exact" }>> = {}): RecheckOutcome => ({
    kind: "exact", result: rr(refIds, { total: 5 }), ranFiles: ["a.test.ts"], absentFiles: [], notes: [], ...o,
  });
  const cols: Record<string, RecheckOutcome | undefined> = {
    "--": undefined,
    "X+": exact([ID]),
    "X-": exact([]),
    "X?": exact(["a.test.ts > other"]),
    A: { kind: "approximate", inexactReasons: [{ cause: "untracked-modified", path: "src/x.ts" }, { cause: "untracked-deleted", path: "" }] },
    U: { kind: "unusable", cause: "no-reference", reason: "the dispatch was not tracked" },
    D: { kind: "disabled" },
    T: { kind: "timed-out", boundMs: 4000 },
    S: { kind: "skipped-deadline", remainingMs: 8000 },
  };
  const rows: Record<string, ScopedOutcome> = {
    R2: ran(rr([ID])),
    R2i: ran(rr([ID], { complete: false, note: "report truncated" })),
    R3: ran(rr([ID], { complete: false, collectionError: true })),
  };
  const col = (inventoryNote: string): Record<string, [boolean, boolean, string]> => ({
    "X-": [false, false, `testsPass: introduced failures: ${ID}${OBS}`],
    "X?": [false, true, `testsPass: cannot prove failures predate dispatch: ${ID}${OBS}`],
    A: [false, true, `testsPass: cannot attribute failures: the dispatch reference is approximate (untracked-modified src/x.ts, untracked-deleted)${OBS}`],
    U: [false, true, `testsPass: no reference: pre-existing failures cannot be told apart (the dispatch was not tracked)${OBS}`],
    D: [false, true, `testsPass: cannot attribute failures: failureRecheck is off, pre-existing failures cannot be told apart${OBS}`],
    T: [false, true, `testsPass: cannot attribute failures: the reference rerun timed out after 4000ms${OBS}`],
    S: [false, true, `testsPass: gate budget exhausted before recheck${OBS}`],
    "X+": [false, true, `testsPass: the scoped failure inventory is incomplete (${inventoryNote}); known failures predate dispatch, others may not${OBS}`],
  });
  const u9: [boolean, boolean, string] = [false, true, `testsPass: cannot attribute failures: no failing test file identified, recheck not attempted${OBS}`];
  const table: Record<string, Record<string, [boolean, boolean, string]>> = {
    R2: { ...col(""), "--": u9, "X+": [true, false, ""] },
    R2i: { ...col("report truncated"), "--": u9 },
    R3: { ...col("collection error"), "--": [false, true, `testsPass: collection error without failing test files: no details${OBS}`] },
  };
  const cells = Object.entries(table).flatMap(([row, byCol]) => Object.entries(byCol).map(([c, want]) => [row, c, ...want] as const));

  it.each(cells)("%s x %s -> ok=%s unverifiable=%s", (row, c, ok, unv, reason) => {
    const j = judgeScoped(rows[row], cols[c]);
    expect(j.ok).toBe(ok);
    expect(j.unverifiable).toBe(unv);
    if (ok) {
      expect(j.reason).toBeUndefined();
      expect(j.note).toBe(`testsPass: no worse than before; pre-existing failures: ${ID}; suite is NOT green (affected tests checked against the exact dispatch reference)`);
      expect(j.failures).toEqual({ introduced: [], preexisting: [ID], unknown: [] });
    } else {
      expect(j.reason).toBe(reason);
    }
    if (c.startsWith("X")) expect(j.failures).toBeDefined();
    else expect(j.failures).toBeUndefined();
  });

  it("u4 names the cause of a non-reference unusable recheck", () => {
    expect(judgeScoped(rows.R2, { kind: "unusable", cause: "materialize-failed", reason: "worktree add failed" }).reason)
      .toBe(`testsPass: cannot attribute failures: reference unusable (materialize-failed): worktree add failed${OBS}`);
  });

  it("R0 no-affected passes with the NoAffected note verbatim, ignoring any recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped({ kind: "no-affected", note: "no changed files, no affected tests" }, recheck))
        .toEqual({ ok: true, unverifiable: false, note: "no changed files, no affected tests" });
    }
  });

  it("R1 green passes with e1, plus n1 when no test ran, ignoring any recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(ran(rr([]), 0), recheck))
        .toEqual({ ok: true, unverifiable: false, evidence: "testsPass: affected tests passed (full, 3 tests)" });
    }
    expect(judgeScoped(ran(rr([], { total: 0 }), 0), undefined)).toEqual({
      ok: true, unverifiable: false, evidence: "testsPass: affected tests passed (full, 0 tests)", note: "testsPass: no affected tests ran",
    });
  });

  it("R4 incomplete without failing ids is u12 whatever the recheck", () => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(ran(rr([], { complete: false, note: "no report written" }), 2), recheck))
        .toEqual({ ok: false, unverifiable: true, reason: "testsPass: the scoped result is incomplete: no report written (exit 2)" });
    }
  });

  it.each([
    ["R5 timed out", { kind: "timed-out", boundMs: 5000 }, "testsPass timed out after 5000ms"],
    ["R5 aborted", { kind: "aborted", reason: "gate budget exhausted during the scoped run" }, "testsPass: gate budget exhausted during the scoped run"],
    ["R6 slot busy", { kind: "slot-busy", waitedMs: 60000, deadlineCut: false }, "verification slot busy (waited 60000ms)"],
    ["R6 deadline cut", { kind: "slot-busy", waitedMs: 5000, deadlineCut: true }, "gate budget exhausted waiting for the verification slot"],
    ["R7 S6", { kind: "unverifiable", code: "node-not-found", reason: "no node on PATH" }, "testsPass: scoping impossible (node-not-found): no node on PATH"],
    ["R8 error", { kind: "error", reason: "spawn EPERM" }, "testsPass check errored: spawn EPERM"],
  ] as [string, ScopedOutcome, string][])("%s is unverifiable whatever the recheck", (_name, scoped, reason) => {
    for (const recheck of Object.values(cols)) {
      expect(judgeScoped(scoped, recheck)).toEqual({ ok: false, unverifiable: true, reason });
    }
  });

  describe("T5 classification edge cases", () => {
    it("an id whose file is absent at the reference is introduced", () => {
      const j = judgeScoped(ran(rr(["new.test.ts > t"])), exact([], { result: undefined, ranFiles: [], absentFiles: ["new.test.ts"] }));
      expect(j).toMatchObject({ ok: false, unverifiable: false, failures: { introduced: ["new.test.ts > t"], preexisting: [], unknown: [] } });
    });

    it("a file that was not rerun leaves its ids unknown", () => {
      const j = judgeScoped(ran(rr(["b.test.ts > t"])), exact([ID]));
      expect(j).toMatchObject({ ok: false, unverifiable: true, failures: { unknown: ["b.test.ts > t"] } });
    });

    it("report source classifies id-level: another failing id in the same file does not hide a new one", () => {
      const j = judgeScoped(ran(rr([ID], { source: "report" })), exact(["a.test.ts > other"]));
      expect(j).toMatchObject({ ok: false, unverifiable: false, reason: `testsPass: introduced failures: ${ID}${OBS}` });
    });

    it("text source classifies file-level only when the file passed at the reference", () => {
      expect(judgeScoped(ran(rr([ID])), exact(["a.test.ts > other"])).failures).toEqual({ introduced: [], preexisting: [], unknown: [ID] });
      expect(judgeScoped(ran(rr([ID])), exact([])).failures).toEqual({ introduced: [ID], preexisting: [], unknown: [] });
    });

    it("pytest ids key on the part before ::", () => {
      const id = "tests/test_x.py::TestA::test_b";
      const j = judgeScoped(ran(rr([id], { source: "report" })), exact([id], { ranFiles: ["tests/test_x.py"] }));
      expect(j).toMatchObject({ ok: true, failures: { preexisting: [id] } });
    });

    it("a pytest id containing \" > \" keys at the earliest separator, so failing at both sides is pre-existing", () => {
      const id = "tests/test_x.py::test_cmp[1 > 0]";
      const j = judgeScoped(ran(rr([id], { source: "report" })), exact([id], { ranFiles: ["tests/test_x.py"] }));
      expect(j).toMatchObject({ ok: true, unverifiable: false, failures: { introduced: [], preexisting: [id], unknown: [] } });
      expect(j.note).toContain("no worse than before");
    });

    it("a bare-file id is never pre-existing: introduced when its file ran or is absent", () => {
      const bare = "a.test.ts";
      const scoped = ran(rr([bare], { collectionError: true, complete: false }));
      expect(judgeScoped(scoped, exact([bare])).failures).toEqual({ introduced: [bare], preexisting: [], unknown: [] });
      expect(judgeScoped(scoped, exact([], { result: undefined, ranFiles: [], absentFiles: [bare] })).ok).toBe(false);
    });

    it("r1 names only the introduced ids and notes the pre-existing ones", () => {
      const j = judgeScoped(ran(rr([ID, "a.test.ts > t2"], { source: "report" })), exact([ID]));
      expect(j).toMatchObject({
        ok: false, unverifiable: false,
        reason: `testsPass: introduced failures: a.test.ts > t2; observed failures: ${ID}, a.test.ts > t2`,
        note: `testsPass: also failing at the dispatch reference: ${ID}`,
      });
    });
  });

  it("<ids> lists at most 10 ids, then the remainder count", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    expect(formatIds(ids)).toBe(`${ids.slice(0, 10).join(", ")} (+2 more)`);
    expect(formatIds(ids.slice(0, 10))).toBe(ids.slice(0, 10).join(", "));
  });
});
