/**
 * test/integration/deferred-verification.test.ts
 *
 * Phase 2.4.2 (plan Phase 2.4, section 1.5-14..17; pending.ts R3, R10, R11): mode routing between
 * deferred and required verification, the router footer, lineage and the pending sweep.
 *
 * - "wiring (2.4.2a)" drives createVerificationWiring directly: directives, the VERIFY_WAIT-bounded
 *   capture wait, the deferred finish and R11 lineage.
 *
 * Every process goes through the mocked exec seam and is recorded. The tree snapshot and the
 * reference capture are mocked (git only in production; nothing runs here), so a deferred
 * delegation must leave the exec record empty and never construct the S3 slot's scope opener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig } from "../../src/router/config";
import {
  canonicalTier,
  createVerificationWiring,
  DEFERRED_FINISH_MS,
  dispatchDirectiveText,
  FALLBACK_CAPTURE_WAIT_MS,
  hasTestsPass,
  type DeferredFinish,
} from "../../src/verify/wiring";
import { createChangedFileStore, type TreeSnapshot } from "../../src/verify/dispatch";
import { gateResult } from "../../src/verify/gate";
import { HANDLE_PATTERN, MAX_ENTRIES_PER_SESSION, UNATTRIBUTED_RISK_REASON } from "../../src/verify/pending";
import { REASONS } from "../../src/verify/risk";
import type { RouterConfig } from "../../src/router/config";
import type { DoD } from "../../src/verify/dod";
import type { DispatchReference } from "../../src/verify/reference";

const state = vi.hoisted(() => ({
  /** What snapshotTree resolves with (undefined = unavailable). */
  snapshot: undefined as TreeSnapshot | undefined,
  /** Replaces the snapshot mock when set. */
  snapshotImpl: undefined as (() => Promise<TreeSnapshot | undefined>) | undefined,
  /** Every shell or argv spawn, as "file arg…" or the shell string. */
  commands: [] as string[],
  captures: 0,
  captureResult: undefined as unknown,
  /** The capture settles after this many (fake) ms; undefined = at once; "never" = held forever. */
  captureDelayMs: undefined as number | "never" | undefined,
  /** createScopeOpener / createDirectTestsPassHook calls: the S3 slot and the scoped run live behind them. */
  scopeOpeners: 0,
  testsPassHooks: 0,
  /** acquireSlot calls (the machine-wide S3 slot). */
  slotAcquires: 0,
  /** createBackgroundQueue calls (2.4.5: never when background is off). */
  queues: 0,
}));

vi.mock("../../src/verify/slot", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/slot")>();
  return {
    ...actual,
    acquireSlot: (...args: Parameters<typeof actual.acquireSlot>) => {
      state.slotAcquires += 1;
      return actual.acquireSlot(...args);
    },
  };
});
vi.mock("../../src/verify/pending", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/pending")>();
  return {
    ...actual,
    createBackgroundQueue: (...args: Parameters<typeof actual.createBackgroundQueue>) => {
      state.queues += 1;
      return actual.createBackgroundQueue(...args);
    },
  };
});

vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async () => (state.snapshotImpl ? state.snapshotImpl() : state.snapshot),
}));
vi.mock("../../src/verify/exec", () => ({
  runShell: async (command: string) => {
    state.commands.push(command);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
  runArgv: async (file: string, args: readonly string[]) => {
    state.commands.push([file, ...args].join(" "));
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  },
}));
vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createScopeOpener: (deps: Parameters<typeof actual.createScopeOpener>[0]) => {
      state.scopeOpeners += 1;
      return actual.createScopeOpener(deps);
    },
    createDirectTestsPassHook: (deps: Parameters<typeof actual.createDirectTestsPassHook>[0]) => {
      state.testsPassHooks += 1;
      return actual.createDirectTestsPassHook(deps);
    },
  };
});
// The plugin's own wiring instance, so the tests can read its pending registry and spy on lineage.
const captured = vi.hoisted(() => ({
  wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined,
  lineage: [] as Array<import("../../src/verify/wiring").LineageContext>,
}));
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      const wrapped: import("../../src/verify/wiring").VerificationWiring = {
        ...wiring,
        applyLineage: (res, ctx) => {
          captured.lineage.push(ctx);
          return wiring.applyLineage(res, ctx);
        },
      };
      captured.wiring = wrapped;
      return wrapped;
    },
  };
});
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  captureReference: (_at: string, signal: AbortSignal) => {
    state.captures += 1;
    return new Promise((resolveCapture, rejectCapture) => {
      // Like the real capture, an abort (the store clearing the dispatch) ends it without a reference.
      signal.addEventListener("abort", () => rejectCapture(new Error("capture aborted")), { once: true });
      const delay = state.captureDelayMs;
      if (delay === "never") return;
      if (delay === undefined) resolveCapture(state.captureResult);
      else setTimeout(() => resolveCapture(state.captureResult), delay);
    });
  },
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const root = resolve("deferred-verification-project");
const REF: DispatchReference = { root, head: "HEAD", commit: "HEAD", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };
const TESTS_DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const FILE_DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "fileExists", path: "x.txt" }] };

function snap(files: TreeSnapshot["files"], fingerprint: string): TreeSnapshot {
  return { cwd: root, root, head: "HEAD", fingerprint, dirty: files.length > 0, files, digests: new Map() };
}

/** A finish that deferred (the footer and handle), or the test fails with why it did not. */
function deferredOf(finish: DeferredFinish): Extract<DeferredFinish, { deferred: true }> {
  if (!finish.deferred) throw new Error(`not deferred: ${finish.reason} (${finish.detail})`);
  return finish;
}

function makeWiring(verify: NonNullable<NonNullable<RouterConfig["enforcement"]>["verify"]> = {}) {
  const cfg: RouterConfig = {
    activePreset: "a",
    presets: { a: { medium: { model: "p/m" } } },
    defaultTier: "medium",
    rules: [],
    enforcement: { verify },
  };
  const warnings: string[] = [];
  const wiring = createVerificationWiring({
    client: {},
    directory: root,
    getConfig: () => cfg,
    logger: { warn: message => warnings.push(message) },
  });
  return { cfg, wiring, store: createChangedFileStore(), warnings };
}

beforeEach(() => {
  Object.assign(state, {
    snapshot: snap([], "clean"),
    snapshotImpl: undefined,
    commands: [],
    captures: 0,
    captureResult: REF,
    captureDelayMs: undefined,
    scopeOpeners: 0,
    testsPassHooks: 0,
    slotAcquires: 0,
    queues: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wiring (2.4.2a)", () => {
  describe("directives: the orchestrator prompt only, defaults from the config", () => {
    it("defaultVerify decides when no directive is present, and a directive overrides it", () => {
      expect(makeWiring().wiring.resolveDirectives("do it").mode).toBe("deferred");
      const required = makeWiring({ defaultVerify: "required" }).wiring;
      expect(required.resolveDirectives("do it")).toMatchObject({ mode: "required", modeSource: "default" });
      expect(required.resolveDirectives("VERIFY:deferred\ndo it")).toMatchObject({ mode: "deferred", modeSource: "directive" });
      expect(makeWiring().wiring.resolveDirectives("VERIFY:required do it")).toMatchObject({ mode: "required", modeSource: "directive" });
    });

    it("VERIFY_WAIT defaults to captureWaitMs, allows 0 and is capped at baselineTimeoutMs", () => {
      const { wiring } = makeWiring({ captureWaitMs: 1234, baselineTimeoutMs: 4000 });
      expect(wiring.resolveDirectives("x").waitMs).toBe(1234);
      expect(wiring.resolveDirectives("VERIFY_WAIT:0s").waitMs).toBe(0);
      expect(wiring.resolveDirectives("VERIFY_WAIT:60s").waitMs).toBe(4000);
    });

    it("QA-2.4-9 (M8): when the verify budget cannot be resolved, the mode is required with the default 5 s capture wait", async () => {
      const base: RouterConfig = { activePreset: "a", presets: { a: { medium: { model: "p/m" } } }, defaultTier: "medium", rules: [] };
      // getConfig works; reading the enforcement block (resolveVerifyBudget) throws `throws` times.
      let throws = 0;
      const broken = Object.defineProperty(base, "enforcement", {
        get() {
          if (throws > 0) {
            throws -= 1;
            throw new Error("broken verify block");
          }
          return { verify: {} };
        },
      });
      const warnings: string[] = [];
      const wiring = createVerificationWiring({ client: {}, directory: root, getConfig: () => broken, logger: { warn: message => warnings.push(message) } });
      throws = 1;
      expect(wiring.resolveDirectives("VERIFY:deferred VERIFY_WAIT:0s")).toEqual({ mode: "required", waitMs: FALLBACK_CAPTURE_WAIT_MS, modeSource: "default", waitSource: "default" });
      expect(FALLBACK_CAPTURE_WAIT_MS).toBe(5_000);
      expect(warnings.some(w => w.includes("verifying synchronously"))).toBe(true);
      // Only the directive read fails; the capture starts, and the dispatch waits for it as 2.1
      // did: a 4 s capture is awaited in full (the old fallback, 0 ms, released it at once).
      vi.useFakeTimers();
      state.captureDelayMs = 4_000;
      throws = 1;
      let done = false;
      const started = wiring.startDispatch(createChangedFileStore(), "d9", root, TESTS_DOD, "VERIFY_WAIT:0s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(3_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });

    it("an unknown VERIFY value is logged and ignored", () => {
      const { wiring, warnings } = makeWiring();
      expect(wiring.resolveDirectives("VERIFY:maybe").mode).toBe("deferred");
      expect(warnings.some(w => w.includes("ignoring unknown VERIFY value"))).toBe(true);
    });

    it("the directive text is the prompt, or the description when the prompt is blank", () => {
      expect(dispatchDirectiveText("VERIFY:required", "VERIFY:deferred")).toBe("VERIFY:required");
      expect(dispatchDirectiveText("  ", "VERIFY:deferred")).toBe("VERIFY:deferred");
      expect(dispatchDirectiveText(undefined, undefined)).toBe("");
    });

    it("takeDispatch returns the remembered start once, then re-parses", async () => {
      const { wiring, store } = makeWiring();
      const start = await wiring.startDispatch(store, "task:o:1", root, TESTS_DOD, "VERIFY:required", true);
      expect(wiring.takeDispatch("task:o:1", "VERIFY:deferred")).toBe(start);
      expect(wiring.takeDispatch("task:o:1", "VERIFY:deferred").directives.mode).toBe("deferred");
    });
  });

  describe("VERIFY_WAIT bounds the capture wait (section 1.5-14)", () => {
    it("a capture that resolves after 20 s under VERIFY_WAIT:5s releases the dispatch at 5 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 20_000;
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d1", root, TESTS_DOD, "VERIFY_WAIT:5s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });

    it("VERIFY_WAIT:0s releases the dispatch at once", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = "never";
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d2", root, TESTS_DOD, "VERIFY_WAIT:0s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(done).toBe(true);
    });

    it("counts the wait from the dispatch's start: a slow synchronous capture start-up is inside VERIFY_WAIT (CI round 1)", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 20_000;
      // The snapshot's synchronous start-up (a git spawn on a loaded runner) takes 300 ms.
      state.snapshotImpl = () => {
        vi.setSystemTime(Date.now() + 300);
        return Promise.resolve(state.snapshot);
      };
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d4", root, TESTS_DOD, "VERIFY_WAIT:5s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4_699);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });

    it("a capture that resolves at 2 s under a 5 s wait releases the dispatch at 2 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 2_000;
      const { wiring, store } = makeWiring();
      let done = false;
      const started = wiring.startDispatch(store, "d3", root, TESTS_DOD, "VERIFY_WAIT:5s", false).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(done).toBe(true);
    });
  });

  describe("QA-3.1-3: dispatches starting together share one snapshot and one capture", () => {
    /** Each snapshot run is held until the test settles it. */
    const holdSnapshots = (): Array<(s: TreeSnapshot) => void> => {
      const held: Array<(s: TreeSnapshot) => void> = [];
      state.snapshotImpl = () => new Promise<TreeSnapshot>(settle => held.push(settle));
      return held;
    };

    it("20 parallel dispatches take 2 snapshots and 2 captures; none shares a snapshot started before it began", async () => {
      const held = holdSnapshots();
      const { wiring, store } = makeWiring();
      await Promise.all(Array.from({ length: 20 }, (_, i) => wiring.startDispatch(store, `d${i}`, root, TESTS_DOD, "VERIFY_WAIT:0s", false)));
      // d0 started run 1 at once; d1..d19 began while it was in flight, so they wait for run 2.
      expect(held).toHaveLength(1);
      held[0](snap([], "first"));
      await vi.waitFor(() => expect(held).toHaveLength(2));
      // A dispatch that begins while run 2 is in flight waits for run 3.
      await wiring.startDispatch(store, "late", root, TESTS_DOD, "VERIFY_WAIT:0s", false);
      held[1](snap([], "second"));
      await vi.waitFor(() => expect(store.baselineSnapshot("d19")?.fingerprint).toBe("second"));
      expect(store.baselineSnapshot("d0")?.fingerprint).toBe("first");
      for (let i = 1; i < 20; i += 1) expect(store.baselineSnapshot(`d${i}`)?.fingerprint).toBe("second");
      await vi.waitFor(() => expect(held).toHaveLength(3));
      held[2](snap([], "third"));
      await vi.waitFor(() => expect(store.baselineSnapshot("late")?.fingerprint).toBe("third"));
      // The capture is shared the same way (it resolves at once, so d0 runs alone and d1..d19 share one).
      expect(state.captures).toBe(3);
      for (let i = 0; i < 20; i += 1) expect((await store.reference(`d${i}`)).kind).toBe("captured");
      expect(state.commands).toEqual([]);
    });

    it("20 parallel deferred finishes share their gate-time snapshot; none uses a run started before it asked", async () => {
      const { wiring, store } = makeWiring();
      const ids = Array.from({ length: 20 }, (_, i) => `task:orch:${i}`);
      for (const id of [...ids, "task:orch:late"]) await wiring.startDispatch(store, id, root, TESTS_DOD, "", false);
      const input = (dispatchID: string) => ({
        dispatchID, orchestratorSessionID: "orch", producerSessionID: "child", producerTier: "fast",
        description: "tidy", cwd: root, dod: TESTS_DOD, dispatchedAt: 0,
      });
      const held = holdSnapshots();
      const a = resolve(root, "src", "a.ts");
      const b = resolve(root, "src", "b.ts");
      const finishing = ids.map(id => wiring.finishDeferred(store, input(id)));
      // The first finish started run 1 at once; the other 19 asked while it ran, so they wait for run 2.
      await vi.waitFor(() => expect(held).toHaveLength(1));
      held[0](snap([{ path: a, status: " M" }], "first"));
      await vi.waitFor(() => expect(held).toHaveLength(2));
      // A finish that asks while run 2 is in flight waits for run 3.
      const late = wiring.finishDeferred(store, input("task:orch:late"));
      held[1](snap([{ path: a, status: " M" }, { path: b, status: " M" }], "second"));
      await vi.waitFor(() => expect(held).toHaveLength(3));
      held[2](snap([{ path: b, status: " M" }], "third"));
      const finishes = (await Promise.all(finishing)).map(deferredOf);
      const lateFinish = deferredOf(await late);
      expect(held).toHaveLength(3);
      const changed = (handle: string) => {
        const found = wiring.pending.get("orch", handle);
        if (found.kind !== "found") throw new Error(`handle ${handle} not found`);
        const files = found.entry.changedFiles;
        return files === "unavailable" ? files : files.map(f => f.path);
      };
      expect(changed(finishes[0].handle)).toEqual([a]);
      for (const finish of finishes.slice(1)) expect(changed(finish.handle)).toEqual([a, b]);
      expect(changed(lateFinish.handle)).toEqual([b]);
      expect(state.commands).toEqual([]);
    });

    it("a tool outside NON_WRITING_TOOLS during a shared snapshot discards it for every sharer, and the deferred entry names the tool", async () => {
      const held = holdSnapshots();
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "VERIFY_WAIT:0s", false);
      await wiring.startDispatch(store, "task:orch:2", root, TESTS_DOD, "VERIFY_WAIT:0s", false);
      store.observeEdit("github_create_file");
      held[0](snap([], "first"));
      await vi.waitFor(() => expect(held).toHaveLength(2));
      held[1](snap([], "second"));
      for (const id of ["task:orch:1", "task:orch:2"]) {
        await vi.waitFor(() => expect(store.snapshotContaminatedBy(id)).toBe("github_create_file"));
        expect(store.baselineSnapshot(id)).toBeUndefined();
      }
      state.snapshotImpl = async () => snap([{ path: path.join(root, "src", "a.ts"), status: " M" }], "after");
      const finish = await wiring.finishDeferred(store, {
        dispatchID: "task:orch:2", orchestratorSessionID: "orch", producerSessionID: "child", producerTier: "fast",
        description: "add the parser", cwd: root, dod: TESTS_DOD, dispatchedAt: 0,
      });
      if (!finish.deferred) throw new Error(finish.detail);
      expect(wiring.pending.get("orch", finish.handle)).toMatchObject({
        kind: "found",
        entry: { changedFiles: "unavailable", contaminatedBy: "github_create_file", concurrentDispatches: 1 },
      });
    });
  });

  describe("isDeferred", () => {
    it("defers only a testsPass DoD in deferred mode with verification enabled", () => {
      const { wiring } = makeWiring();
      const deferred = wiring.resolveDirectives("");
      const required = wiring.resolveDirectives("VERIFY:required");
      expect(hasTestsPass(TESTS_DOD)).toBe(true);
      expect(wiring.isDeferred(TESTS_DOD, deferred)).toBe(true);
      expect(wiring.isDeferred(TESTS_DOD, required)).toBe(false);
      expect(wiring.isDeferred(FILE_DOD, deferred)).toBe(false);
      expect(makeWiring({ require: "never" }).wiring.isDeferred(TESTS_DOD, deferred)).toBe(false);
    });

    it("QA-2.4-10: a trivial dispatch with an inferred DoD is not deferred (the gate skips it); an explicit one is", () => {
      const { wiring } = makeWiring();
      const deferred = wiring.resolveDirectives("");
      const inferred: DoD = { ...TESTS_DOD, source: "inferred" };
      expect(wiring.isDeferred(inferred, deferred, true)).toBe(false);
      expect(wiring.isDeferred(inferred, deferred, false)).toBe(true);
      expect(wiring.isDeferred(inferred, deferred)).toBe(true);
      expect(wiring.isDeferred(TESTS_DOD, deferred, true)).toBe(true);
    });
  });

  describe("finishDeferred", () => {
    const input = (over: Partial<Parameters<ReturnType<typeof makeWiring>["wiring"]["finishDeferred"]>[1]> = {}) => ({
      dispatchID: "task:orch:1",
      orchestratorSessionID: "orch",
      producerSessionID: "child",
      producerTier: " Fast ",
      description: "add the parser",
      cwd: root,
      dod: TESTS_DOD,
      dispatchedAt: 0,
      ...over,
    });

    it("registers the delegation and returns the footer; no process, no slot, no scoped run", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: "??" }], "after");
      const finish = deferredOf(await wiring.finishDeferred(store, input()));
      expect(finish.handle).toMatch(HANDLE_PATTERN);
      const first = finish.footer.split("\n")[0];
      expect(first.startsWith(`[router] unverified \u00b7 ${finish.handle} \u00b7 risk `)).toBe(true);
      expect(finish.footer).not.toMatch(/\baccepted\b|\[router\] verified/i);
      // Zero spawns: HEAD did not move (no git diff), the capture and snapshot are seams.
      expect(state.commands).toEqual([]);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      const listed = wiring.pending.listUnverified("orch");
      expect(listed.map(e => e.handle)).toEqual([finish.handle]);
      expect(listed[0]).toMatchObject({ producerTier: "fast", root, dispatchID: "task:orch:1", producerSessionID: "child" });
      expect(listed[0].changedFiles).toEqual([{ path: resolve(root, "src", "a.ts"), status: "??" }]);
      // The producer tier is canonical: "fast" raises the risk (risk.ts row 11).
      expect(finish.risk.reasons).toContain(REASONS.fastTier);
      // A captured reference at return: no "no reference" step.
      expect(finish.risk.reasons).not.toContain(REASONS.noReference);
      expect(await listed[0].reference).toEqual({ kind: "captured", reference: REF });
    });

    it("a capture still in flight at return counts as no reference, and the record outlives it", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 10_000;
      const { wiring, store } = makeWiring();
      const started = wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "VERIFY_WAIT:0s", false);
      await vi.advanceTimersByTimeAsync(0);
      await started;
      const reference = store.reference("task:orch:1");
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after");
      const finishing = wiring.finishDeferred(store, input({ producerTier: "medium" }));
      await vi.advanceTimersByTimeAsync(0);
      const finish = deferredOf(await finishing);
      expect(finish.risk.reasons).toContain(REASONS.noReference);
      // Not cleared yet: clearing would abort the capture (dispatch.ts evict).
      expect(store.reference("task:orch:1")).toBe(reference);
      await vi.advanceTimersByTimeAsync(10_000);
      const [entry] = wiring.pending.listUnverified("orch");
      expect(await entry.reference).toEqual({ kind: "captured", reference: REF });
      // Cleared once the capture settled.
      expect(store.reference("task:orch:1")).not.toBe(reference);
    });

    it("no change baseline -> changedFiles unavailable and the unattributed risk, never []", async () => {
      const { wiring, store } = makeWiring();
      state.snapshot = undefined;
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      const finish = deferredOf(await wiring.finishDeferred(store, input()));
      expect(finish.risk).toEqual({ level: "high", reasons: [UNATTRIBUTED_RISK_REASON] });
      expect(wiring.pending.listUnverified("orch")[0].changedFiles).toBe("unavailable");
    });

    it("a snapshot slower than DEFERRED_FINISH_MS -> unavailable, and the result is not held longer", async () => {
      vi.useFakeTimers();
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshotImpl = () => new Promise(() => undefined);
      let done = false;
      const finishing = wiring.finishDeferred(store, input()).then(f => {
        done = true;
        return f;
      });
      await vi.advanceTimersByTimeAsync(DEFERRED_FINISH_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const finish = deferredOf(await finishing);
      expect(finish.risk.reasons).toEqual([UNATTRIBUTED_RISK_REASON]);
      expect(finish.handle).toMatch(HANDLE_PATTERN);
    });

    it("QA-2.4-4: a registration the registry refuses is not deferred; the dispatch record stays for the required gate", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after");
      const reference = store.reference("task:orch:1");
      const finish = await wiring.finishDeferred(store, input({ producerSessionID: "" }));
      expect(finish).toMatchObject({ deferred: false, reason: "unregistered" });
      expect(wiring.pending.listUnverified("orch")).toEqual([]);
      // Not cleared once its reference settles: the required gate reads the same record.
      await reference;
      await new Promise(resolveTick => setTimeout(resolveTick, 0));
      expect(store.reference("task:orch:1")).toBe(reference);
      expect(store.baselineSnapshot("task:orch:1")).toBeDefined();
    });

    it("QA-2.4-10: an attributed empty change set is not deferred; the record stays for the required gate", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      const finish = await wiring.finishDeferred(store, input());
      expect(finish).toMatchObject({ deferred: false, reason: "no-change" });
      expect(wiring.pending.stats().entries).toBe(0);
      expect(store.baselineSnapshot("task:orch:1")).toBeDefined();
      // An unattributed change set is still deferred (nothing proves it empty).
      state.snapshot = undefined;
      await wiring.startDispatch(store, "task:orch:2", root, TESTS_DOD, "", false);
      expect(await wiring.finishDeferred(store, input({ dispatchID: "task:orch:2" }))).toMatchObject({ deferred: true });
    });

    it("QA-G-1: an attributed empty change set of a DoD with another check or a criterion is deferred with [] (risk low)", async () => {
      const dods: DoD[] = [
        { ...TESTS_DOD, checks: [...TESTS_DOD.checks, { kind: "buildPasses", command: "npm run build" }] },
        { ...TESTS_DOD, checks: [...TESTS_DOD.checks, { kind: "run", command: "npm test" }] },
        { ...TESTS_DOD, checks: [...TESTS_DOD.checks, { kind: "lintClean", command: "npm run lint" }] },
        { ...TESTS_DOD, checks: [...TESTS_DOD.checks, { kind: "fileExists", path: "x.txt" }] },
        { ...TESTS_DOD, criteria: ["the parser rejects empty input"] },
      ];
      for (const [i, dod] of dods.entries()) {
        const { wiring, store } = makeWiring();
        const id = `task:orch:${i}`;
        await wiring.startDispatch(store, id, root, dod, "", false);
        const finish = deferredOf(await wiring.finishDeferred(store, input({ dispatchID: id, dod })));
        expect(finish.risk).toEqual({ level: "low", reasons: [REASONS.empty] });
        expect(finish.footer).not.toMatch(/\baccepted\b|\[router\] verified/i);
        const listed = wiring.pending.listUnverified("orch");
        expect(listed.map(e => e.handle)).toEqual([finish.handle]);
        expect(listed[0].changedFiles).toEqual([]);
      }
      // Nothing ran: no command, no slot, no scoped run.
      expect(state.commands).toEqual([]);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      expect(state.slotAcquires).toBe(0);
    });

    it("QA-2.4-4: a finish that throws is not deferred either", async () => {
      const { wiring, store } = makeWiring();
      await wiring.startDispatch(store, "task:orch:1", root, TESTS_DOD, "", false);
      state.snapshot = snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after");
      vi.spyOn(wiring.pending, "register").mockImplementation(() => {
        throw new Error("registry exploded");
      });
      expect(await wiring.finishDeferred(store, input())).toMatchObject({ deferred: false, reason: "error", detail: "registry exploded" });
      expect(store.baselineSnapshot("task:orch:1")).toBeDefined();
    });

    it("canonicalTier lowercases and trims", () => {
      expect(canonicalTier("  HEAVY ")).toBe("heavy");
    });
  });

  describe("applyLineage (R11)", () => {
    const failing = (introduced: string[], preexisting: string[]) =>
      gateResult({ pass: false, outcome: "fail", method: "deterministic", reasons: ["introduced"], failures: { introduced, preexisting, unknown: [] } }, "explicit");
    const passing = (preexisting: string[]) =>
      gateResult({ pass: true, outcome: "pass", method: "deterministic", reasons: [], notes: ["no worse than before"], failures: { introduced: [], preexisting, unknown: [] } }, "explicit");
    const ctx = (over: Partial<Parameters<ReturnType<typeof makeWiring>["wiring"]["applyLineage"]>[1]> = {}) => ({
      orchestratorSessionID: "orch",
      root,
      dispatchID: "task:orch:1",
      dispatchedAt: 100,
      returnedAt: 200,
      strictUnverifiable: false,
      ...over,
    });

    it("a rejection is recorded; a later pass on those pre-existing ids becomes unverifiable with the caveat", () => {
      const { wiring } = makeWiring();
      const rejected = failing(["t > a"], []);
      expect(wiring.applyLineage(rejected, ctx())).toBe(rejected);
      const later = wiring.applyLineage(passing(["t > a", "t > b"]), ctx({ dispatchID: "task:orch:2", dispatchedAt: 300, returnedAt: 400 }));
      expect(later.accepted).toBe(true);
      expect(later.verdict.outcome).toBe("unverifiable");
      expect(later.verdict.pass).toBe(false);
      expect(later.verdict.caveats?.[0]).toContain("t > a failed after dispatch task:orch:1 in this session and still fail");
      // strictUnverifiable rejects the downgraded pass.
      expect(wiring.applyLineage(passing(["t > a"]), ctx({ dispatchedAt: 300, strictUnverifiable: true })).accepted).toBe(false);
    });

    it("never matches another session, another root, or a dispatch that started before the rejection landed", () => {
      const { wiring } = makeWiring();
      wiring.applyLineage(failing(["t > a"], []), ctx());
      const pass = passing(["t > a"]);
      expect(wiring.applyLineage(pass, ctx({ orchestratorSessionID: "other", dispatchedAt: 300 }))).toBe(pass);
      expect(wiring.applyLineage(pass, ctx({ root: resolve("elsewhere"), dispatchedAt: 300 }))).toBe(pass);
      expect(wiring.applyLineage(pass, ctx({ dispatchedAt: 150 }))).toBe(pass);
    });

    it("a timed-out gate (no failures field) and an unknown root record and change nothing", () => {
      const { wiring } = makeWiring();
      const timedOut = gateResult({ pass: false, outcome: "fail", method: "none", reasons: ["check failed", "verification gate timed out after 90000ms"] }, "explicit");
      expect(wiring.applyLineage(timedOut, ctx())).toBe(timedOut);
      wiring.applyLineage(failing(["t > a"], []), ctx({ root: undefined }));
      expect(wiring.pending.stats().rejections).toBe(0);
      const pass = passing(["t > a"]);
      expect(wiring.applyLineage(pass, ctx({ dispatchedAt: 300 }))).toBe(pass);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The plugin: both dispatch paths (2.4.2b native `task`, 2.4.2c `delegate`)
// ---------------------------------------------------------------------------------------------

type DispatchPath = "task" | "delegate";
/** The paths routed so far; every routing case below runs on each of them. */
const PATHS: DispatchPath[] = ["task", "delegate"];

const ACCEPT_TESTS = "[acceptance]\ncheck: testsPass command=\"npm test\"\n[/acceptance]";
/** A testsPass DoD whose other check fails: a required gate rejects it, a deferred one never looks. */
const ACCEPT_TESTS_AND_MISSING = "[acceptance]\ncheck: testsPass command=\"npm test\"\ncheck: fileExists path=missing-file.txt\n[/acceptance]";
const ACCEPT_MISSING_ONLY = "[acceptance]\ncheck: fileExists path=missing-file.txt\n[/acceptance]";
const FOOTER_LINE = /^\[router\] unverified \u00b7 vrf_[0-9a-f]{24} \u00b7 risk (low|medium|high)/m;

interface PluginHarness {
  hooks: any;
  producerPrompts: number;
  created: string[];
  /** Clock value when the producer started: the task before hook returned, or the delegate producer prompt. */
  startedAt: number | undefined;
  /** The delegate producer's reply (default "DONE: implemented. VERIFY:required"). */
  delegateReply: string | undefined;
  /** `sessionID`: the dispatching (orchestrator) session; default "orch". */
  run(path: DispatchPath, prompt: string, reply?: string, tier?: string, sessionID?: string): Promise<string>;
}

/**
 * `parents`: session id -> parentID that session.get reports (default: none, a root session);
 * `lookupFails`: session ids whose session.get throws (QA-2.4-2).
 */
async function makePlugin(home: string, sessions: { parents?: Record<string, string>; lookupFails?: string[] } = {}): Promise<PluginHarness> {
  let counter = 0;
  const h: PluginHarness = {
    hooks: undefined,
    producerPrompts: 0,
    created: [],
    startedAt: undefined,
    delegateReply: undefined,
    async run(p, prompt, reply = "DONE: implemented.", tier = "fast", sessionID = "orch") {
      counter += 1;
      if (p === "task") {
        const input = { tool: "task", sessionID, callID: `call${counter}`, args: { subagent_type: "fast", prompt, description: "the work" } };
        const before = { args: { ...input.args } };
        await h.hooks["tool.execute.before"](input, before);
        h.startedAt = Date.now();
        // The host hands the (possibly rewritten) args to the after hook.
        input.args = before.args;
        const output = { output: `<task_result>\n${reply}\n</task_result>`, metadata: { sessionId: `child${counter}` } };
        await h.hooks["tool.execute.after"](input, output);
        return output.output;
      }
      return h.hooks.tool.delegate.execute({ task: prompt, tier }, { sessionID });
    },
  };
  const ctx = {
    directory: root,
    worktree: root,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async (req: { path: { id: string } }) => {
          if (sessions.lookupFails?.includes(req.path.id) === true) throw new Error("session.get failed");
          const parentID = sessions.parents?.[req.path.id];
          return { data: parentID !== undefined ? { parentID } : {} };
        },
        create: async () => {
          const id = `sess_${h.created.length + 1}`;
          h.created.push(id);
          return { data: { id } };
        },
        prompt: async (req: { body?: { system?: unknown } }) => {
          if (req.body?.system === undefined) {
            h.producerPrompts += 1;
            h.startedAt ??= Date.now();
          }
          return { data: { parts: [{ type: "text", text: h.delegateReply ?? "DONE: implemented. VERIFY:required" }] } };
        },
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  void home;
  h.hooks = await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  return h;
}

function writeOverrides(home: string, verify: Record<string, unknown>): void {
  const p = path.join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ enforcement: { verify } }), "utf-8");
  invalidateConfigCache();
}

describe("the plugin routes by mode on both dispatch paths", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-deferred-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
    captured.wiring = undefined;
    captured.lineage = [];
  });

  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /**
   * The producer changes src/a.ts: every snapshot lists it dirty under a new fingerprint and without
   * digests, so delta attributes it (QA-2.1-14) however dispatches interleave. Without a change, a
   * testsPass-only dispatch is not deferred at all (QA-2.4-10; QA-G-1: any other DoD still is).
   */
  const producerChanges = (): void => {
    let n = 0;
    state.snapshotImpl = async () => ({ cwd: root, root, head: "HEAD", fingerprint: `f${n++}`, dirty: true, files: [{ path: resolve(root, "src", "a.ts"), status: " M" }] });
  };

  const pendingOf = (sid: string) => {
    if (captured.wiring === undefined) throw new Error("the plugin built no wiring");
    return captured.wiring.pending.listUnverified(sid);
  };

  describe.each(PATHS)("%s", p => {
    it("default deferred: returns at once with the footer; zero test spawns, no slot, a pending entry", async () => {
      const h = await makePlugin(home);
      // Dispatch snapshot clean; the producer then added src/a.ts.
      let snapshots = 0;
      state.snapshotImpl = async () =>
        (snapshots++ === 0 ? snap([], "clean") : snap([{ path: resolve(root, "src", "a.ts"), status: "??" }], "after"));
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
      expect(out).toMatch(FOOTER_LINE);
      // The footer is the last thing in the result and is never an acceptance.
      expect(out.trimEnd().endsWith("before building on this work if the risk matters.")).toBe(true);
      expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]|\[router\] (accepted|verified)/i);
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([]);
      expect(state.commands.some(c => /npm|vitest|jest/.test(c))).toBe(false);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      expect(state.captures).toBe(1);
      const entries = pendingOf("orch");
      expect(entries).toHaveLength(1);
      expect(entries[0].producerTier).toBe("fast");
      expect(entries[0].changedFiles).toEqual([{ path: resolve(root, "src", "a.ts"), status: "??" }]);
      expect(out).toContain(entries[0].handle);
      expect(h.producerPrompts).toBe(p === "delegate" ? 1 : 0);
    });

    it("a deferred delegation is never gated: a failing check neither rejects nor retries it", async () => {
      producerChanges();
      const h = await makePlugin(home);
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).toMatch(FOOTER_LINE);
      expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]/);
      expect(state.scopeOpeners).toBe(0);
      if (p === "delegate") expect(h.producerPrompts).toBe(1);
    });

    it("VERIFY:required runs today's gate: it rejects exactly as before, with no footer", async () => {
      const h = await makePlugin(home);
      const out = await h.run(p, `VERIFY:required\nImplement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBeGreaterThan(0);
      if (p === "task") expect(out).toContain("NOT ACCEPTED");
      else {
        expect(out).toContain("[router status: unmet]");
        // The escalation ladder ran (more than one producer attempt).
        expect(h.producerPrompts).toBeGreaterThan(1);
      }
      expect(pendingOf("orch")).toEqual([]);
    });

    it("defaultVerify \"required\" with no directive is the same as VERIFY:required", async () => {
      writeOverrides(home, { defaultVerify: "required" });
      const h = await makePlugin(home);
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBeGreaterThan(0);
      expect(out).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
      // ...and VERIFY:deferred still defers under that default.
      producerChanges();
      const deferred = await h.run(p, `VERIFY:deferred\nImplement it.\n${ACCEPT_TESTS}`);
      expect(deferred).toMatch(FOOTER_LINE);
    });

    it("QA-2.4-2: a subagent's (or an unknown session's) dispatch is gated synchronously and registers nothing", async () => {
      // Depth guard disabled: this test covers synchronous verification; the depth limit is covered by depth-guard-wiring.test.ts (#66).
      (loadConfig().enforcement ??= {}).maxDelegationDepth = null;
      const h = await makePlugin(home, { parents: { sub: "orch" }, lookupFails: ["flaky"] });
      producerChanges();
      // A tracked tier subagent too (chat.message registers it), whatever session.get says.
      await h.hooks["chat.message"]({ sessionID: "tracked", agent: "fast" }, { parts: [{ type: "text", text: "implement the parser and its tests" }] });
      for (const sid of ["sub", "flaky", "tracked"]) {
        const out = await h.run(p, `VERIFY:deferred\nImplement it.\n${ACCEPT_TESTS_AND_MISSING}`, undefined, undefined, sid);
        expect(out).not.toMatch(FOOTER_LINE);
        // Today's gate ran and rejected (its fileExists check fails).
        expect(out).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
        expect(pendingOf(sid)).toEqual([]);
      }
      expect(pendingOf("orch")).toEqual([]);
      // Control: the proven root orchestrator still defers.
      expect(await h.run(p, `Implement it.\n${ACCEPT_TESTS}`)).toMatch(FOOTER_LINE);
      expect(pendingOf("orch")).toHaveLength(1);
    });

    it("QA-2.4-10: a producer that changed no file is gated exactly as the required path: same outcome, no footer, no entry", async () => {
      const h = await makePlugin(home);
      const deferredDefault = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
      const required = await h.run(p, `VERIFY:required\nImplement it.\n${ACCEPT_TESTS}`);
      expect(deferredDefault).toBe(required);
      expect(deferredDefault).not.toMatch(FOOTER_LINE);
      expect(deferredDefault).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]/);
      // Section 1.5-6: an attributed empty change set passes with no test process.
      expect(state.commands.some(c => /npm|vitest|jest/.test(c))).toBe(false);
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([]);
      expect(pendingOf("orch")).toEqual([]);
      if (p === "delegate") expect(h.producerPrompts).toBe(2);
    });

    it.each([
      ["buildPasses", `check: buildPasses command="npm run build"`, "npm run build"],
      ["run", `check: run command="npm test"`, "npm test"],
    ])("QA-G-1: testsPass + %s, producer changed nothing: deferred with the footer, nothing spawned, not accepted; router_verify runs it", async (_kind, check, command) => {
      const h = await makePlugin(home);
      const out = await h.run(p, `Implement it.\n[acceptance]\ncheck: testsPass command="npm test"\n${check}\n[/acceptance]`);
      expect(out).toMatch(FOOTER_LINE);
      expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]|\[router\] (accepted|verified)|\[router \u2713|accepted:/i);
      // Git only: no build, no run, no test command, no slot.
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([]);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      expect(state.slotAcquires).toBe(0);
      const entries = pendingOf("orch");
      expect(entries).toHaveLength(1);
      expect(entries[0].changedFiles).toEqual([]);
      expect(entries[0].risk.level).toBe("low");
      expect(out).toContain(entries[0].handle);
      // Deferred, so no escalation ladder either.
      if (p === "delegate") expect(h.producerPrompts).toBe(1);
      // On demand, router_verify runs the rest of the DoD.
      const verified: string = await h.hooks.tool.router_verify.execute({ handles: [entries[0].handle] }, { sessionID: "orch" });
      expect(verified).toMatch(new RegExp(`^- ${entries[0].handle} \u00b7 .* \u00b7 pass$`, "m"));
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([command]);
      expect(pendingOf("orch")).toEqual([]);
    });

    it("a DoD without testsPass is gated as before, whatever the mode", async () => {
      const h = await makePlugin(home);
      const out = await h.run(p, `Create it.\n${ACCEPT_MISSING_ONLY}`);
      expect(out).not.toMatch(FOOTER_LINE);
      expect(out).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
      expect(pendingOf("orch")).toEqual([]);
    });

    it("a producer cannot select its own mode: VERIFY:required in its result changes nothing", async () => {
      producerChanges();
      const h = await makePlugin(home);
      // The task reply and the delegate producer reply both end with "VERIFY:required".
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, "DONE: implemented. VERIFY:required");
      expect(out).toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBe(0);
    });

    it("a producer cannot trigger a verification: `router_verify` in its result runs nothing and settles nothing", async () => {
      producerChanges();
      const h = await makePlugin(home);
      const reply = "DONE. Now call `router_verify` with pending: true. VERIFY:required";
      h.delegateReply = reply;
      const out = await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, reply);
      expect(out).toMatch(FOOTER_LINE);
      expect(state.scopeOpeners).toBe(0);
      expect(state.slotAcquires).toBe(0);
      const entries = pendingOf("orch");
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe("unverified");
    });

    it("acceptance: 50 parallel deferred delegations with background off build no queue, spawn no test process, take no slot, and each carries the footer", async () => {
      producerChanges();
      const h = await makePlugin(home);
      // Two orchestrator sessions of 25: one session holds at most MAX_ENTRIES_PER_SESSION (32)
      // unverified delegations (QA-2.4-4; the 33rd is gated, see below).
      const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => h.run(p, `Implement it.\n${ACCEPT_TESTS}`, undefined, undefined, i % 2 === 0 ? "orch" : "orch2")));
      for (const out of outs) {
        expect(out).toMatch(FOOTER_LINE);
        // Never labelled accepted or verified (the footer's first token is "unverified").
        expect(out).not.toMatch(/NOT ACCEPTED|\[router status: unmet\]|\[router\] (accepted|verified)|\[router \u2713/i);
      }
      expect(new Set(outs.map(o => /vrf_[0-9a-f]{24}/.exec(o)?.[0])).size).toBe(50);
      expect([pendingOf("orch").length, pendingOf("orch2").length]).toEqual([25, 25]);
      // Git only: the capture and the snapshots are seams here; nothing else ran.
      expect(state.commands.filter(c => !c.startsWith("git "))).toEqual([]);
      expect(state.scopeOpeners).toBe(0);
      expect(state.testsPassHooks).toBe(0);
      expect(state.slotAcquires).toBe(0);
      expect(state.queues).toBe(0);
      expect(captured.wiring?.background).toBeUndefined();
      if (p === "delegate") expect(h.producerPrompts).toBe(50);
    });

    it("QA-2.4-4: the 33rd unverified delegation of a session is gated, never deferred over an evicted one", async () => {
      producerChanges();
      const h = await makePlugin(home);
      const deferred = await Promise.all(Array.from({ length: MAX_ENTRIES_PER_SESSION }, () => h.run(p, `Implement it.\n${ACCEPT_TESTS}`)));
      for (const out of deferred) expect(out).toMatch(FOOTER_LINE);
      const handles = pendingOf("orch").map(e => e.handle);
      expect(handles).toHaveLength(MAX_ENTRIES_PER_SESSION);
      // Session cap reached with unverified entries only: registry-full, so the required gate runs
      // (its failing fileExists check rejects), and no earlier delegation leaves the list.
      const gated = await h.run(p, `Implement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(gated).not.toMatch(FOOTER_LINE);
      expect(gated).not.toContain("no handle");
      expect(gated).toMatch(p === "task" ? /NOT ACCEPTED/ : /\[router status: unmet\]/);
      expect(state.scopeOpeners).toBeGreaterThan(0);
      expect(pendingOf("orch").map(e => e.handle).sort()).toEqual([...handles].sort());
      // Another session still defers (its own cap), and never evicts the first session's entries.
      expect(await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, undefined, undefined, "orch2")).toMatch(FOOTER_LINE);
      expect(pendingOf("orch")).toHaveLength(MAX_ENTRIES_PER_SESSION);
    });

    it("result latency: a deferred return waits for nothing but the git-only snapshot, cut at DEFERRED_FINISH_MS", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = "never";
      let snapshots = 0;
      // The dispatch snapshot answers; the finish's snapshot never does.
      state.snapshotImpl = () => (snapshots++ === 0 ? Promise.resolve(snap([], "clean")) : new Promise<TreeSnapshot | undefined>(() => undefined));
      const h = await makePlugin(home);
      let done = false;
      const running = h.run(p, `VERIFY_WAIT:0s\nImplement it.\n${ACCEPT_TESTS}`).then(out => {
        done = true;
        return out;
      });
      await vi.advanceTimersByTimeAsync(DEFERRED_FINISH_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const out = await running;
      expect(out).toMatch(FOOTER_LINE);
      expect(pendingOf("orch")[0].changedFiles).toBe("unavailable");
      expect(pendingOf("orch")[0].risk.reasons).toEqual([UNATTRIBUTED_RISK_REASON]);
    });

    it("the required gate hands its result to R11 lineage with the dispatch's own session and times", async () => {
      const h = await makePlugin(home);
      const before = Date.now();
      await h.run(p, `VERIFY:required\nImplement it.\n${ACCEPT_TESTS_AND_MISSING}`);
      expect(captured.lineage.length).toBeGreaterThan(0);
      for (const ctx of captured.lineage) {
        expect(ctx.orchestratorSessionID).toBe("orch");
        expect(ctx.dispatchedAt).toBeGreaterThanOrEqual(before);
        expect(ctx.returnedAt).toBeGreaterThanOrEqual(ctx.dispatchedAt);
        expect(ctx.root).toBe(root);
      }
    });

    it("VERIFY_WAIT:5s with a capture that takes 20 s: the producer starts at 5 s", async () => {
      vi.useFakeTimers();
      state.captureDelayMs = 20_000;
      // The capture may run up to baselineTimeoutMs (default 15 s) after the wait.
      producerChanges();
      writeOverrides(home, { baselineTimeoutMs: 30_000 });
      const h = await makePlugin(home);
      const t0 = Date.now();
      const done = h.run(p, `VERIFY_WAIT:5s\nImplement it.\n${ACCEPT_TESTS}`);
      await vi.advanceTimersByTimeAsync(20_000);
      const out = await done;
      expect(h.startedAt).toBe(t0 + 5_000);
      expect(out).toMatch(FOOTER_LINE);
      // The capture outlived the result (the dispatch record was not cleared under it): a later
      // router_verify gets the reference.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pendingOf("orch")[0].reference).toEqual({ kind: "captured", reference: REF });
    });

    it("VERIFY_WAIT:0s with a capture that never settles: the producer starts at once and the result is not held", async () => {
      state.captureDelayMs = "never";
      let snapshots = 0;
      state.snapshotImpl = async () =>
        (snapshots++ === 0 ? snap([], "clean") : snap([{ path: resolve(root, "src", "a.ts"), status: " M" }], "after"));
      const h = await makePlugin(home);
      const out = await h.run(p, `VERIFY_WAIT:0s\nImplement it.\n${ACCEPT_TESTS}`);
      expect(out).toMatch(FOOTER_LINE);
      // Still in flight at return: counted as no reference (risk raised one step).
      expect(pendingOf("orch")[0].risk.reasons).toContain(REASONS.noReference);
    });

    it("the registered producer tier is the canonical lowercase id", async () => {
      producerChanges();
      const h = await makePlugin(home);
      if (p === "task") {
        await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
        expect(pendingOf("orch")[0].producerTier).toBe("fast");
      } else {
        await h.run(p, `Implement it.\n${ACCEPT_TESTS}`, undefined, " Fast ");
        expect(pendingOf("orch")[0].producerTier).toBe("fast");
      }
    });

    it("session.deleted forgets the orchestrator's handles", async () => {
      producerChanges();
      const h = await makePlugin(home);
      await h.run(p, `Implement it.\n${ACCEPT_TESTS}`);
      const [entry] = pendingOf("orch");
      await h.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "orch" } } } });
      expect(pendingOf("orch")).toEqual([]);
      // pending.ts R5: forgetSession drops the session's tombstones too.
      expect(captured.wiring?.pending.get("orch", entry.handle).kind).toBe("unknown");
    });
  });

  it("the idle sweeper sweeps the pending registry, and plugin dispose disposes it", async () => {
    const h = await makePlugin(home);
    const pending = captured.wiring?.pending;
    if (pending === undefined) throw new Error("no registry");
    const sweep = vi.spyOn(pending, "sweep");
    const dispose = vi.spyOn(pending, "dispose");
    await h.hooks["chat.message"]({ sessionID: "S", agent: "fast" }, { parts: [] });
    expect(sweep).toHaveBeenCalledTimes(1);
    await h.hooks.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
