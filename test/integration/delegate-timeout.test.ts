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
import { invalidateConfigCache } from "../../src/router/config";
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
    expect(result).not.toContain("[router ✓ accepted:");
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

    expect(result).toContain("[router ✓ accepted:");
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
    expect(result).not.toContain("[router ✓ accepted:");
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

  it("cuts off a grader that never resolves and returns an honest unmet", async () => {
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
    expect(result).not.toContain("[router ✓ accepted:");
    expect(result).not.toContain("inconclusive");
    expect(rec.graderPrompts).toBeGreaterThan(0);
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

    expect(result).toContain("[router status: unmet]");
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
    expect(resultB).toContain("[router ✓ accepted:");
    expect(resultB).not.toContain("timed out");
  });

  it("returns an honest unmet when the whole gate exceeds its budget", async () => {
    writeOverrides(dir, { gateBudgetMs: 2000, graderTimeoutMs: 600000 });
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

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("verification gate timed out after 2000ms");
    expect(result).not.toContain("[router ✓ accepted:");
  });
});
