/**
 * test/integration/delegate-timeout.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove the Phase-4 time
 * boxes: the producer prompt, the grader prompt and the acceptance gate all
 * have a ceiling, and hitting one produces an honest `unmet` rather than a
 * fabricated pass.
 *
 * FAKE TIMERS ONLY. Every wait here is advanced explicitly with
 * vi.advanceTimersByTimeAsync; nothing in this file depends on wall-clock
 * timing, because a test that sleeps for real is flaky by construction and
 * would take ten minutes to prove the default ceiling.
 *
 * No live models, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { ChildSessionRequest, RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache } from "../../src/router/config";
import { resetDispatchRegistry } from "../../src/router/sessions";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
// These tests isolate model/gate clocks. The temp directories are not Git
// checkouts; model the unavailable snapshot without introducing real processes
// into a fake-timer test (which would make grader start times wall-clock dependent).
// `treeDelay.ms` > 0 makes the (fake-timer) snapshot take that long, to model a slow P0 preparation.
const treeDelay = vi.hoisted(() => ({ ms: 0 }));
vi.mock("../../src/verify/tree", () => ({
  snapshotTree: () =>
    treeDelay.ms > 0
      ? new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), treeDelay.ms))
      : Promise.resolve(undefined),
}));
// Record every gate deadline the plugin creates (the real implementation still runs).
const createdDeadlines = vi.hoisted(() => [] as Array<{ budgetMs: number; signal: AbortSignal }>);
vi.mock("../../src/verify/deterministic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createDeadline: (...args: Parameters<typeof actual.createDeadline>) => {
      const d = actual.createDeadline(...args);
      createdDeadlines.push(d);
      return d;
    },
  };
});
import {
  DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS,
  DEFAULT_GATE_BUDGET_MS,
  DEFAULT_GRADER_PROMPT_TIMEOUT_MS,
} from "../../src/verify/timeout";

let sessionCounter = 0;

const ACCEPTANCE =
  "[acceptance]\ncriteria: the result is correct\n[/acceptance]";

interface Recorder {
  created: string[];
  aborted: string[];
  deleted: string[];
  producerPrompts: number;
  graderPrompts: number;
  /** Session ids that received a grader prompt, in dispatch order. */
  graderSessionIds: string[];
}

function newRecorder(): Recorder {
  return {
    created: [],
    aborted: [],
    deleted: [],
    producerPrompts: 0,
    graderPrompts: 0,
    graderSessionIds: [],
  };
}

/** A promise that never settles — the hung model this whole phase is about. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function makeCtx(
  dir: string,
  rec: Recorder,
  behaviour: {
    /** Called for each producer prompt (1-based attempt index). */
    producer: (attempt: number) => Promise<any>;
    /** Called for each grader prompt (1-based call index). */
    grader?: (call: number) => Promise<any>;
  },
) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => {
          const id = `sess_${sessionCounter++}`;
          rec.created.push(id);
          return { data: { id } };
        },
        abort: async (opts: any) => {
          rec.aborted.push(opts?.path?.id);
          return {};
        },
        delete: async (opts: any) => {
          rec.deleted.push(opts?.path?.id);
          return {};
        },
        prompt: async (opts: any) => {
          // dispatchGrader always sets body.system; the producer never does.
          if (opts?.body?.system !== undefined) {
            rec.graderPrompts += 1;
            rec.graderSessionIds.push(opts?.path?.id);
            return behaviour.grader
              ? behaviour.grader(rec.graderPrompts)
              : { data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] } };
          }
          rec.producerPrompts += 1;
          return behaviour.producer(rec.producerPrompts);
        },
      },
    } as any,
  };
}

function textReply(text: string) {
  return { data: { parts: [{ type: "text", text }] } };
}

/** Write an overrides layer so the plugin reads a non-default ceiling. */
function writeOverrides(home: string, verify: Record<string, unknown>): void {
  const p = path.join(
    home,
    ".config/opencode/opencode-model-router.overrides.jsonc",
  );
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({ enforcement: { verify } }),
    "utf-8",
  );
  invalidateConfigCache();
}

describe("delegate time-boxes (fake timers)", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrto-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    else delete process.env.USERPROFILE;
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // Producer
  // -------------------------------------------------------------------------

  it("cuts off a producer prompt that never resolves and still returns", async () => {
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, { producer: () => never() }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "heavy",
      acceptance: ACCEPTANCE,
    });

    // Enough budget for every ladder attempt to hit its own ceiling.
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS * 8);
    const result = await pending;

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("timed out after");
    // Honest failure, never a fabricated acceptance.
    expect(result).not.toContain("[router ✓");
    // A hung producer must not have been graded as if it had produced anything.
    expect(rec.graderPrompts).toBe(0);
  });

  it("does not cut off a producer that resolves just under the ceiling", async () => {
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(textReply("producer output")),
              DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS - 1,
            ),
          ),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS);
    const result = await pending;

    expect(result).toContain("[router ✓ verified:");
    expect(result).toContain("producer output");
    expect(result).not.toContain("timed out");
  });

  it("honours a custom delegateTimeoutMs from config", async () => {
    writeOverrides(dir, { delegateTimeoutMs: 5000 });
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, { producer: () => never() }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });

    // Far below the 600 s default: only the custom ceiling can fire here.
    await vi.advanceTimersByTimeAsync(5000 * 8);
    const result = await pending;

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("timed out after 5000ms");
  });

  it("disposes a timed-out producer session exactly once", async () => {
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, { producer: () => never() }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "heavy",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS * 8);
    await pending;

    // Every session the plugin created was aborted and deleted, once each.
    expect(rec.created.length).toBeGreaterThan(0);
    for (const sid of rec.created) {
      expect(rec.aborted.filter((x) => x === sid)).toHaveLength(1);
      expect(rec.deleted.filter((x) => x === sid)).toHaveLength(1);
    }
    expect(rec.aborted).toHaveLength(rec.created.length);
    expect(rec.deleted).toHaveLength(rec.created.length);
  });

  it("yields status unmet, not a crash, when the last ladder attempt times out", async () => {
    const rec = newRecorder();
    // Every attempt but the last produces normally and fails grading; the last
    // one hangs. The ladder must still terminate with an honest verdict.
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: (attempt) =>
          attempt >= 3 ? never() : Promise.resolve(textReply("partial work")),
        grader: () => Promise.resolve(textReply('{"pass":false,"reasons":["nope"]}')),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS * 8);
    const result = await pending;

    expect(result).toContain("[router status: unmet]");
    expect(result).not.toContain("[router ✓");
    expect(rec.producerPrompts).toBeGreaterThanOrEqual(3);
  });

  it("never aborts the parent orchestrator session", async () => {
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, { producer: () => never() }) as any,
    );

    const parentSessionID = "orchestrator-session";
    const pending: Promise<string> = hooks.tool.delegate.execute(
      { task: "do x", tier: "fast", acceptance: ACCEPTANCE },
      { sessionID: parentSessionID },
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS * 8);
    await pending;

    expect(rec.aborted).not.toContain(parentSessionID);
    expect(rec.deleted).not.toContain(parentSessionID);
    // The abort blast radius is exactly the plugin's own child sessions.
    for (const sid of rec.aborted) expect(rec.created).toContain(sid);
  });

  // -------------------------------------------------------------------------
  // Grader
  // -------------------------------------------------------------------------

  it("strict mode cuts off a grader without retrying or escalating", async () => {
    writeOverrides(dir, { strictUnverifiable: true });
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        grader: () => never(),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATE_BUDGET_MS * 8);
    const result = await pending;

    expect(result).toContain("[router status: unmet]");
    // Not accepted, and NOT reported as an inconclusive skip.
    expect(result).not.toContain("[router ✓");
    expect(result).not.toContain("inconclusive");
    expect(rec.graderPrompts).toBe(1);
    expect(rec.producerPrompts).toBe(1);
  });

  it("disposes a timed-out grader session exactly once", async () => {
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        grader: () => never(),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_GATE_BUDGET_MS * 8);
    await pending;

    for (const sid of rec.created) {
      expect(rec.deleted.filter((x) => x === sid)).toHaveLength(1);
    }
    expect(rec.deleted).toHaveLength(rec.created.length);
  });

  it("honours a custom graderTimeoutMs from config", async () => {
    writeOverrides(dir, { graderTimeoutMs: 1000, gateBudgetMs: 900000 });
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        grader: () => never(),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    // Below both the 60 s grader default and the (raised) gate budget, so only
    // the custom grader ceiling can be what fired.
    await vi.advanceTimersByTimeAsync(1000 * 8);
    const result = await pending;

    // QA-3.1-21 (plan G2): still returned, but never labelled accepted or verified.
    expect(result).toContain("[router ⚠ UNVERIFIED: checker]");
    expect(result).not.toMatch(/\[router ✓|accepted:|verified:/);
    expect(result).toContain("Verification caveats");
    expect(rec.producerPrompts).toBe(1);
    expect(rec.graderPrompts).toBe(1);
    expect(result).toContain("grader prompt timed out after 1000ms");
    expect(DEFAULT_GRADER_PROMPT_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  // -------------------------------------------------------------------------
  // Gate budget
  // -------------------------------------------------------------------------

  it("aborts only its OWN graders when the gate budget expires", async () => {
    // Two concurrent delegations sharing one plugin instance. A's gate runs out
    // of budget while B's grader is healthy and mid-flight. A's abort must not
    // reach B: the wiring-global graderSessions set holds both.
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000 });
    const rec = newRecorder();

    // A's graders hang forever. B's grader answers 1500ms after it starts,
    // which is inside B's own 2000ms gate budget but AFTER A's budget has
    // already expired — the exact overlap where a wiring-global abort would
    // take B down with A.
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        // Call 2 is B's. Every other call belongs to A (which retries) and hangs.
        grader: (call) =>
          call === 2
            ? new Promise((resolve) =>
                setTimeout(() => resolve(textReply('{"pass":true,"reasons":[]}')), 1500),
              )
            : never(),
      }) as any,
    );

    // t=0: A starts. Its gate budget expires at t=2000.
    const a: Promise<string> = hooks.tool.delegate.execute({
      task: "task A",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(1000);

    // t=1000: B starts. Its gate expires at t=3000; its grader answers at 2500.
    const b: Promise<string> = hooks.tool.delegate.execute({
      task: "task B",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(10);
    const bGraderSid = rec.graderSessionIds[1];
    expect(bGraderSid).toBeTruthy();
    expect(bGraderSid).not.toBe(rec.graderSessionIds[0]);

    // t=2100: A's gate budget has blown; B's grader is still in flight.
    await vi.advanceTimersByTimeAsync(1100);
    expect(rec.aborted).toContain(rec.graderSessionIds[0]); // A's own grader: yes
    expect(rec.aborted).not.toContain(bGraderSid); // B's grader: untouched

    // Let both delegations finish (A's ladder keeps timing out and gives up).
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS * 8);
    const [resultA, resultB] = await Promise.all([a, b]);

    expect(resultA).toContain("verification gate timed out after 2000ms");
    // B was never collateral damage: it completed and was accepted.
    expect(resultB).toContain("[router ✓ verified:");
    expect(resultB).not.toContain("timed out");
  });

  it.each([false, true])("gate budget exhaustion is unverifiable (strict=%s)", async (strictUnverifiable) => {
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000, strictUnverifiable });
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        grader: () => never(),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(2000 * 8);
    const result = await pending;

    expect(result).toContain("verification gate timed out after 2000ms");
    expect(rec.producerPrompts).toBe(1);
    expect(rec.graderPrompts).toBe(1);
    if (strictUnverifiable) {
      expect(result).toContain("[router status: unmet]");
      expect(result).not.toContain("[router ✓");
    } else {
      // QA-3.1-21 (plan G2): the timed-out gate is returned, never labelled accepted or verified.
      expect(result).toContain("[router ⚠ UNVERIFIED: none]");
      expect(result).not.toMatch(/\[router ✓|accepted:|verified:/);
      expect(result).toContain("Verification caveats — NOT verified");
    }
  });

  it("aborts the delegate gate deadline when the gate budget expires", async () => {
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000, strictUnverifiable: true });
    createdDeadlines.length = 0;
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("producer output")),
        grader: () => never(),
      }) as any,
    );

    const pending: Promise<string> = hooks.tool.delegate.execute({
      task: "do x",
      tier: "heavy",
      acceptance: ACCEPTANCE,
    });
    await vi.advanceTimersByTimeAsync(2000 * 8);
    await pending;

    const gate = createdDeadlines.filter((d) => d.budgetMs === 2000);
    expect(gate.length).toBeGreaterThan(0);
    for (const d of gate) expect(d.signal.aborted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Native task gate (tool.execute.after)
  // -------------------------------------------------------------------------

  it("bounds the native task gate: a hung accept yields the unverifiable result and aborts its deadline", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000, strictUnverifiable: true });
    createdDeadlines.length = 0;
    const rec = newRecorder();
    const hooks: any = await ModelRouterPlugin(
      makeCtx(dir, rec, {
        producer: () => Promise.resolve(textReply("unused")),
        grader: () => never(),
      }) as any,
    );

    const input = {
      tool: "task",
      sessionID: "orch",
      callID: "call1",
      args: { subagent_type: "fast", prompt: `Do the thing.\n${ACCEPTANCE}` },
    };
    const output = {
      output: "<task_result>\nDONE: did the thing.\n</task_result>",
      metadata: { sessionId: "child-native" },
    };

    let settled = false;
    const pending = hooks["tool.execute.after"](input, output).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2000 * 4);
    await pending;

    expect(settled).toBe(true);
    expect(rec.graderPrompts).toBe(1);
    expect(output.output).toContain("verification gate timed out after 2000ms");
    expect(output.output).toContain("NOT ACCEPTED");
    // The grader this gate opened is aborted, and so is the gate's deadline.
    expect(rec.aborted).toContain(rec.graderSessionIds[0]);
    expect(createdDeadlines).toHaveLength(1);
    expect(createdDeadlines[0]!.budgetMs).toBe(2000);
    expect(createdDeadlines[0]!.signal.aborted).toBe(true);
  });

  it("QA-2.1-4: preparation time counts against gateBudgetMs (native task gate)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000, strictUnverifiable: true });
    createdDeadlines.length = 0;
    treeDelay.ms = 1500;
    try {
      const rec = newRecorder();
      const hooks: any = await ModelRouterPlugin(
        makeCtx(dir, rec, {
          producer: () => Promise.resolve(textReply("unused")),
          grader: () => never(),
        }) as any,
      );
      const input = {
        tool: "task",
        sessionID: "orch",
        callID: "call-prep",
        args: { subagent_type: "fast", prompt: `Do the thing.\n${ACCEPTANCE}` },
      };
      const output = {
        output: "<task_result>\nDONE: did the thing.\n</task_result>",
        metadata: { sessionId: "child-prep" },
      };

      let settled = false;
      const pending = hooks["tool.execute.after"](input, output).then(() => {
        settled = true;
      });
      // The deadline exists before the 1500 ms snapshot starts ...
      await vi.advanceTimersByTimeAsync(10);
      expect(createdDeadlines).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1989);
      expect(settled).toBe(false);
      // ... so the gate ends at 2000 ms from its start, not 1500 + 2000 ms.
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      await pending;
      expect(output.output).toContain("verification gate timed out after 2000ms");
      expect(createdDeadlines[0]!.signal.aborted).toBe(true);
    } finally {
      treeDelay.ms = 0;
    }
  });
});

describe("delegate time-boxes: resumed v2 children (Phase 2.3, fake timers)", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrto-resume-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    resetDispatchRegistry();
    resetIngestState();
    invalidateConfigCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    else delete process.env.USERPROFILE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    resetDispatchRegistry();
    resetIngestState();
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function writeResumeOverrides(): void {
    const p = path.join(dir, ".config/opencode/opencode-model-router.overrides.jsonc");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tier = (model: string, variant: string, costRatio: number) => ({ model, variant, costRatio, description: "test tier", whenToUse: ["testing"] });
    fs.writeFileSync(p, JSON.stringify({
      activePreset: "tst",
      presets: { tst: {
        fast: tier("anthropic/claude-sonnet-5-5", "low", 1),
        medium: tier("anthropic/claude-sonnet-5-5", "medium", 5),
        heavy: tier("anthropic/claude-opus-5-5", "xhigh", 20),
      } },
      routing: {},
      enforcement: { escalate: { maxTotalAttempts: 8, costCeiling: { multiple: 100 } } },
    }), "utf-8");
    invalidateConfigCache();
  }

  const catalog = ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"].map((ref) => {
    const [providerID, id] = ref.split("/");
    return { providerID: providerID!, id: id!, variants: ["low", "medium", "high", "xhigh"].map((v) => ({ id: v })), limit: { input: 1_000_000, context: 1_000_000, output: 4_096 } };
  });

  it("cuts a resumed child that never answers off at the producer ceiling, aborts its signal, and carries on fresh", async () => {
    writeResumeOverrides();
    const verdicts = [false, true];
    const log: string[] = [];
    let producerRuns = 0;
    let ingest: { onStepEnded(event: unknown): Promise<void>; onExecutionEnded(sessionID: string): void } | undefined;
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir,
      client: { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id } }) } },
      routerHost: "v2",
      routerCatalog: async () => catalog,
      // The plugin's own telemetry ingest: the host publishes a finished step's usage on the event stream, and the
      // ladder's resume decision (D11) reads the child's context from what the ingest saw.
      routerOnIngest: (created: typeof ingest) => { ingest = created; },
      routerChildRunner: {
        run: async (request: ChildSessionRequest) => {
          if (request.system !== undefined) {
            const sid = `grader-${sessionCounter++}`;
            await request.onCreated(sid);
            return { sessionID: sid, text: JSON.stringify({ pass: verdicts.shift() ?? false, reasons: ["scripted verdict"] }) };
          }
          producerRuns += 1;
          const sid = request.resumeSessionID ?? `resume-child-${producerRuns}`;
          log.push(`${request.resumeSessionID === undefined ? "create" : "resume"}:${sid}:${request.model?.variant}`);
          await request.onCreated(sid);
          if (producerRuns === 1) {
            await ingest?.onStepEnded({ id: `step-${sid}`, type: "session.step.ended", data: { sessionID: sid, finish: "stop", cost: 0, tokens: { input: 5_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } } });
            ingest?.onExecutionEnded(sid); // the host's session.execution.* event, after the last step
          }
          if (producerRuns === 2) {
            await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => { log.push(`aborted:${sid}`); reject(request.signal?.reason); }, { once: true }));
          }
          return { sessionID: sid, text: "producer output" };
        },
        dispose: async (sid: string) => { log.push(`dispose:${sid}`); },
      },
    } as unknown as RouterPluginInput) as unknown as { tool: { delegate: { execute(args: Record<string, unknown>, ctx?: { sessionID?: string }): Promise<string> } }; dispose(): Promise<void> };

    const pending = hooks.tool.delegate.execute({ task: "VERIFY:required\ndo x", tier: "fast", acceptance: ACCEPTANCE }, { sessionID: "orchestrator" });
    await vi.advanceTimersByTimeAsync(DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS + 1_000);
    const result = await pending;
    await hooks.dispose();

    expect(result).toContain("[router ✓ verified:");
    // attempt 1 fresh, attempt 2 resumed the child with the next variant and hung, attempt 3 fresh (a producer that
    // timed out reports no trustworthy context, D11), still stepping the variant.
    expect(log.filter((e) => !e.startsWith("dispose:"))).toEqual([
      "create:resume-child-1:low",
      "resume:resume-child-1:medium",
      "aborted:resume-child-1",
      "create:resume-child-3:high",
    ]);
    expect(log.indexOf("dispose:resume-child-1")).toBeLessThan(log.indexOf("create:resume-child-3:high"));
  });

  type DelegateHooks = { tool: { delegate: { execute(args: Record<string, unknown>, ctx?: { sessionID?: string }): Promise<string> } }; dispose(): Promise<void> };

  function immediateRunner(created: string[]) {
    return {
      run: async (request: ChildSessionRequest) => {
        const sid = `quick-${sessionCounter++}`;
        created.push(sid);
        await request.onCreated(sid);
        return { sessionID: sid, text: request.system !== undefined ? '{"pass":true,"reasons":[]}' : "producer output" };
      },
      dispose: async () => undefined,
    };
  }

  it("QA-2.3-3: a catalog that never answers costs the first delegation one timeout, no later one anything, and is logged once", async () => {
    writeResumeOverrides();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let listCalls = 0;
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir,
      client: { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id } }) } },
      routerHost: "v2",
      routerCatalog: () => { listCalls += 1; return new Promise<never>(() => undefined); },
      routerChildRunner: immediateRunner([]),
    } as unknown as RouterPluginInput) as unknown as DelegateHooks;
    const execute = () => hooks.tool.delegate.execute({ task: "VERIFY:required\ndo x", tier: "fast", acceptance: ACCEPTANCE }, { sessionID: "orchestrator" });
    const settles = (promise: Promise<string>) => { const state = { done: false }; void promise.then(() => { state.done = true; }); return state; };
    const unavailable = () => warn.mock.calls.filter(([message]) => String(message).includes("model catalog is unavailable")).length;
    try {
      // The first delegation waits for the catalog's own timeout (3 s), then carries on without variant info.
      const first = execute();
      const firstState = settles(first);
      await vi.advanceTimersByTimeAsync(2_900);
      expect(firstState.done).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      expect(firstState.done).toBe(true);
      expect(await first).toContain("[router ✓ verified:");
      expect(listCalls).toBe(1);
      expect(unavailable()).toBe(1);
      // Within the TTL the negative answer is served at once: no wait, no second list() call, no second log line.
      for (let n = 0; n < 2; n++) {
        const later = execute();
        const state = settles(later);
        await vi.advanceTimersByTimeAsync(100);
        expect(state.done).toBe(true);
        expect(await later).toContain("[router ✓ verified:");
      }
      expect(listCalls).toBe(1);
      expect(unavailable()).toBe(1);
      // After the TTL the first call is still outstanding: nothing starts behind it, and nothing waits.
      await vi.advanceTimersByTimeAsync(20_000);
      const afterTtl = execute();
      const afterTtlState = settles(afterTtl);
      await vi.advanceTimersByTimeAsync(100);
      expect(afterTtlState.done).toBe(true);
      await afterTtl;
      expect(listCalls).toBe(1);
      // A call abandoned for good (60 s) is replaced; it hangs too, so that delegation waits once more, and the
      // failure streak is still one log line.
      await vi.advanceTimersByTimeAsync(60_000);
      const replaced = execute();
      const replacedState = settles(replaced);
      await vi.advanceTimersByTimeAsync(3_200);
      expect(replacedState.done).toBe(true);
      await replaced;
      expect(listCalls).toBe(2);
      expect(unavailable()).toBe(1);
    } finally {
      warn.mockRestore();
      await hooks.dispose();
    }
  });

  it("QA-2.3-R2-6: an abandoned catalog call that fails late does not release the marker of the newer call", async () => {
    writeResumeOverrides();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pending: Array<{ resolve(models: typeof catalog): void; reject(error: Error): void }> = [];
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir,
      client: { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id } }) } },
      routerHost: "v2",
      routerCatalog: () => new Promise<typeof catalog>((resolve, reject) => { pending.push({ resolve, reject }); }),
      routerChildRunner: immediateRunner([]),
    } as unknown as RouterPluginInput) as unknown as DelegateHooks;
    const execute = () => hooks.tool.delegate.execute({ task: "VERIFY:required\ndo x", tier: "fast", acceptance: ACCEPTANCE }, { sessionID: "orchestrator" });
    try {
      const first = execute();
      await vi.advanceTimersByTimeAsync(3_100); // call 1 hangs past its timeout
      await first;
      expect(pending).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(61_000); // call 1 is abandoned
      const second = execute();
      await vi.advanceTimersByTimeAsync(3_100); // call 2 hangs too
      await second;
      expect(pending).toHaveLength(2);
      pending[0]!.reject(new Error("late failure of the abandoned call"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(16_000); // past the TTL of the negative answer
      const third = execute();
      await vi.advanceTimersByTimeAsync(100);
      await third;
      expect(pending).toHaveLength(2); // call 2 is still outstanding: nothing starts behind it
      // the newer call's own late answer fills the cache, and the next delegation uses it
      pending[1]!.resolve(catalog);
      await vi.advanceTimersByTimeAsync(0);
      const fourth = execute();
      await vi.advanceTimersByTimeAsync(100);
      await fourth;
      expect(pending).toHaveLength(2);
    } finally {
      warn.mockRestore();
      await hooks.dispose();
    }
  });
  it("QA-2.3-3: concurrent delegations share one catalog load, and a late answer still fills the cache", async () => {
    writeResumeOverrides();
    let listCalls = 0;
    let answer!: (models: typeof catalog) => void;
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir,
      client: { session: { get: async ({ path: p }: { path: { id: string } }) => ({ data: { id: p.id } }) } },
      routerHost: "v2",
      routerCatalog: () => { listCalls += 1; return new Promise<typeof catalog>((resolve) => { answer = resolve; }); },
      routerChildRunner: immediateRunner([]),
    } as unknown as RouterPluginInput) as unknown as DelegateHooks;
    const execute = () => hooks.tool.delegate.execute({ task: "VERIFY:required\ndo x", tier: "fast", acceptance: ACCEPTANCE }, { sessionID: "orchestrator" });
    try {
      const a = execute();
      const b = execute();
      await vi.advanceTimersByTimeAsync(100);
      expect(listCalls).toBe(1); // one shared in-flight load for both
      answer(catalog);
      await vi.advanceTimersByTimeAsync(100);
      expect(await a).toContain("[router ✓ verified:");
      expect(await b).toContain("[router ✓ verified:");
      const c = execute();
      await vi.advanceTimersByTimeAsync(100);
      await c;
      expect(listCalls).toBe(1); // the positive answer is cached for the TTL
    } finally {
      await hooks.dispose();
    }
  });
});