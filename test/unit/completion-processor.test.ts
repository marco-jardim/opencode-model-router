import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_SWEEP_AGE_MS,
  DECIDED_LIVE_MS,
  EARLY_END_TTL_MS,
  MAX_CALL_RECORDS,
  PENDING_GUARANTEES_TEXT,
  attemptKey,
  attemptLabel,
  createCompletionProcessor,
  createHeldResults,
  createInFlightRegistry,
  heldPlaceholder,
  renderCompleted,
  renderHeld,
  renderInFlight,
  storedVerdictOf,
  unheldVerdictText,
  verdictText,
  type Attempt,
  type BackgroundDecision,
  type CallRecord,
  type CloseCause,
  type CompletionProcessor,
  type FinishInput,
  type FinishResult,
  type HeldResults,
  type InFlightRegistry,
  type PersistedRecord,
  type SyntheticFn,
  type Trigger,
  type VerificationMode,
} from "../../src/compat/background";

const PARENT = "ses_parent";
const DECISION: BackgroundDecision = { background: true, hold: false, reason: "estimate" };

interface Rig {
  clock: { t: number };
  reg: InFlightRegistry;
  proc: CompletionProcessor;
  held: HeldResults;
  finishCalls: FinishInput[];
  released: string[];
  records: PersistedRecord[];
  processedKeys: Set<string>;
  posts: Array<Parameters<SyntheticFn>[0]>;
  warns: string[];
  closed: Array<{ attempt: Attempt; cause: CloseCause }>;
  claims: Set<string>;
  /** QA-2.1-4: handles given back through `releaseHeld`. */
  releasedHandles: string[];
  behavior: {
    finish: (input: FinishInput) => Promise<FinishResult>;
    read: (child: string) => Promise<{ text?: string } | undefined>;
    notices: string[];
    capture: ((callID: string, child: string) => Promise<unknown>) | undefined;
    release: (id: string) => void;
    synthetic: SyntheticFn;
  };
}

function finishResult(over: Partial<FinishResult> = {}): FinishResult {
  return { outputText: "child text\n[router] ok", suffix: "[router] ok", verification: { kind: "none" }, metadata: {}, ...over };
}

function rig(opts: { withCapture?: boolean } = {}): Rig {
  const clock = { t: 1_000_000 };
  const closed: Array<{ attempt: Attempt; cause: CloseCause }> = [];
  const warns: string[] = [];
  const logger = { warn: (m: string) => void warns.push(m) };
  const claims = new Set<string>();
  const reg = createInFlightRegistry({
    now: () => clock.t,
    logger,
    claims,
    onClosed: (attempt, cause) => void closed.push({ attempt, cause }),
  });
  const records: PersistedRecord[] = [];
  const processedKeys = new Set<string>();
  const persist = {
    append: async (r: PersistedRecord) => {
      records.push(r);
    },
    hasProcessed: (key: string) => processedKeys.has(key),
  };
  const posts: Array<Parameters<SyntheticFn>[0]> = [];
  const finishCalls: FinishInput[] = [];
  const released: string[] = [];
  const releasedHandles: string[] = [];
  const behavior: Rig["behavior"] = {
    finish: async () => finishResult(),
    read: async () => ({ text: "child text" }),
    notices: [],
    capture: opts.withCapture === true ? async () => ({ files: ["a.ts"] }) : undefined,
    release: (id) => void released.push(id),
    synthetic: async () => undefined,
  };
  const held = createHeldResults({
    synthetic: async (input) => {
      posts.push(input);
      return behavior.synthetic(input);
    },
    journal: persist,
    available: true,
    logger,
    now: () => clock.t,
    sleep: async () => undefined,
  });
  const proc = createCompletionProcessor(reg, {
    finish: async (input) => {
      finishCalls.push(input);
      return behavior.finish(input);
    },
    readChildResult: (child) => behavior.read(child),
    roleCompletion: async () => behavior.notices,
    releaseLeases: (id) => behavior.release(id),
    held,
    persist,
    now: () => clock.t,
    logger,
    releaseHeld: (handle) => void releasedHandles.push(handle),
    ...(opts.withCapture === true ? { captureDelta: (callID: string, child: string) => (behavior.capture ?? (async () => undefined))(callID, child) } : {}),
  });
  return { clock, reg, proc, held, finishCalls, released, records, processedKeys, posts, warns, closed, claims, releasedHandles, behavior };
}

describe("DF-1-4 resumed background dispatch (registry)", () => {
  it("DF-1-4 an end parked before the resume was decided is never replayed to the resumed attempt", () => {
    const r = rig();
    // Turn 1's end of the child, parked while no attempt of this process knew the child.
    r.reg.noteEarlyEnd("ses_c1", { outcome: "succeeded", eventID: "e_turn1", at: r.clock.t });
    r.clock.t += 1_000;
    // The resume: same child, new call, decided after the end was parked.
    expect(r.reg.decide(callRecord("c2", { at: r.clock.t, resumeOf: "ses_c1" }))).toBe(true);
    expect(r.reg.acknowledge("c2", "ses_c1", { userBackgrounded: false })).toBeDefined();
    expect(r.reg.takeEarlyEnd("ses_c1")).toBeUndefined();
  });

  it("DF-1-4 an end parked after the resume was decided is still replayed at its acknowledgement", () => {
    const r = rig();
    expect(r.reg.decide(callRecord("c3", { at: r.clock.t, resumeOf: "ses_c3" }))).toBe(true);
    r.clock.t += 10;
    r.reg.noteEarlyEnd("ses_c3", { outcome: "succeeded", eventID: "e_own", at: r.clock.t });
    expect(r.reg.acknowledge("c3", "ses_c3", { userBackgrounded: false })).toBeDefined();
    expect(r.reg.takeEarlyEnd("ses_c3")?.eventID).toBe("e_own");
  });

  it("DF-1-4 an end met before the turn has an answer waits; the turn's own end delivers exactly one verdict with its answer", async () => {
    const r = rig();
    await launch(r, "c2", "ses_c2", { handle: "vrf_2" });
    const reads: Array<{ text?: string } | undefined> = [undefined, { text: "turn 2 answer" }];
    r.behavior.read = async () => reads.shift();
    r.behavior.finish = async (input) => finishResult({ outputText: input.outputText, suffix: "", verification: { kind: "required", verdict: "PASS" } });
    await r.proc.process("ses_c2", endEvent());
    expect(r.reg.byChild("ses_c2")?.state).toBe("child-ended");
    expect(r.finishCalls).toHaveLength(0);
    await r.proc.process("ses_c2", { kind: "end-event", outcome: "succeeded", eventID: "ev2", at: 1_000_700 });
    await r.proc.process("ses_c2", { kind: "end-event", outcome: "succeeded", eventID: "ev3", at: 1_000_800 });
    await flushAll();
    expect(r.finishCalls.map((f) => f.outputText)).toEqual(["turn 2 answer"]);
    const verdicts = r.posts.filter((p) => JSON.stringify(p).includes("vrf_2"));
    expect(verdicts).toHaveLength(1);
    expect(JSON.stringify(verdicts[0])).toContain("turn 2 answer");
  });
});

function callRecord(callID: string, over: Partial<CallRecord> = {}): CallRecord {
  return {
    callID,
    parentSessionID: PARENT,
    agent: "implementer",
    description: `task ${callID}`,
    verifying: false,
    verificationMode: "none" as VerificationMode,
    decision: DECISION,
    at: 1_000_000,
    ...over,
  };
}

async function launch(r: Rig, callID: string, child: string, opts: { handle?: string; rec?: Partial<CallRecord> } = {}): Promise<Attempt> {
  expect(r.reg.decide(callRecord(callID, opts.rec))).toBe(true);
  if (opts.handle !== undefined) {
    await r.held.hold({ handle: opts.handle, parentSessionID: PARENT, childSessionID: child, callID, label: `implementer "task ${callID}"` });
  }
  const attempt = r.reg.acknowledge(callID, child, { userBackgrounded: false, ...(opts.handle === undefined ? {} : { hold: { handle: opts.handle } }) });
  if (attempt === undefined) throw new Error("acknowledge failed");
  return attempt;
}

function endEvent(at = 1_000_500): Trigger {
  return { kind: "end-event", outcome: "succeeded", eventID: "ev1", at };
}

function completion(state: "completed" | "error" | "cancelled" = "completed", body: string | undefined = "child text"): Trigger {
  return { kind: "completion", state, body, at: 1_000_600 };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Lets every promise chain started so far settle (a macrotask turn). */
async function flushAll(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("registry: decide / acknowledge / claims", () => {
  it("decide claims a callID once per process-wide set", () => {
    const r = rig();
    expect(r.reg.decide(callRecord("c1"))).toBe(true);
    expect(r.reg.decide(callRecord("c1"))).toBe(false);
    expect(r.claims.has("bg:c1")).toBe(true);
  });

  it("acknowledge needs a decided call and is idempotent for the same child", async () => {
    const r = rig();
    expect(r.reg.acknowledge("nope", "ses_x", { userBackgrounded: false })).toBeUndefined();
    const a = await launch(r, "c1", "ses_c1");
    expect(a.state).toBe("acknowledged");
    expect(a.key).toBe(attemptKey("ses_c1", "c1"));
    expect(r.reg.acknowledge("c1", "ses_c1", { userBackgrounded: true })).toBe(a);
    expect(r.reg.acknowledge("c1", "ses_other", { userBackgrounded: true })).toBeUndefined();
    expect(r.reg.byChild("ses_c1")).toBe(a);
    expect(r.reg.byCall("c1")).toBe(a);
    expect(r.reg.listForParent(PARENT)).toEqual([a]);
    expect(r.reg.liveCount()).toBe(1);
  });

  it("records userBackgrounded and the hold handle on the attempt", () => {
    const r = rig();
    r.reg.decide(callRecord("c1"));
    const a = r.reg.acknowledge("c1", "ses_c1", { userBackgrounded: true, hold: { handle: "vrf_1" } });
    expect(a?.userBackgrounded).toBe(true);
    expect(a?.hold).toEqual({ handle: "vrf_1" });
  });

  it("foreground marks a decided/open attempt terminal and a bare call gets a foreground attempt", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    r.reg.foreground("c1", "ses_c1");
    expect(a.state).toBe("foreground");
    expect(r.reg.liveCount()).toBe(0);

    r.reg.decide(callRecord("c2"));
    r.reg.foreground("c2", "ses_c2");
    expect(r.reg.byChild("ses_c2")?.state).toBe("foreground");

    r.reg.decide(callRecord("c3"));
    r.reg.foreground("c3", null);
    expect(r.reg.byCall("c3")).toBeUndefined();
    r.reg.foreground("unknown", "ses_z");
    expect(r.reg.byChild("ses_z")).toBeUndefined();
  });

  it("cancel drops a bare call and cancels an open attempt, but keeps terminal ones", async () => {
    const r = rig();
    r.reg.decide(callRecord("c1"));
    r.reg.cancel("c1");
    expect(r.reg.byCall("c1")).toBeUndefined();
    r.reg.cancel("unknown");
    const a = await launch(r, "c2", "ses_c2");
    r.reg.cancel("c2");
    expect(a.state).toBe("cancelled");
    const b = await launch(r, "c3", "ses_c3");
    r.reg.foreground("c3", "ses_c3");
    r.reg.cancel("c3");
    expect(b.state).toBe("foreground");
  });

  it("an end seen before the acknowledgement is kept once and expires after its TTL", () => {
    const r = rig();
    r.reg.noteEarlyEnd("ses_a", { outcome: "succeeded", eventID: "e1", at: r.clock.t });
    expect(r.reg.takeEarlyEnd("ses_a")?.eventID).toBe("e1");
    expect(r.reg.takeEarlyEnd("ses_a")).toBeUndefined();
    r.reg.noteEarlyEnd("ses_b", { outcome: "failed", eventID: "e2", at: r.clock.t });
    r.clock.t += EARLY_END_TTL_MS + 1;
    expect(r.reg.takeEarlyEnd("ses_b")).toBeUndefined();
  });

  it("the call records are bounded and prefer evicting terminal attempts", () => {
    const r = rig();
    for (let i = 0; i < MAX_CALL_RECORDS + 20; i += 1) {
      r.reg.decide(callRecord(`bulk${i}`));
      r.reg.foreground(`bulk${i}`, `ses_bulk${i}`);
    }
    expect(r.reg.byCall("bulk0")).toBeUndefined();
    expect(r.reg.byCall(`bulk${MAX_CALL_RECORDS + 19}`)).toBeDefined();
  });

  it("forgetSession removes the parent's and the child's attempts and the child's early end", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    r.reg.noteEarlyEnd("ses_c1", { outcome: "succeeded", eventID: "e", at: r.clock.t });
    r.reg.forgetSession("ses_c1");
    expect(r.reg.byChild("ses_c1")).toBeUndefined();
    expect(r.reg.takeEarlyEnd("ses_c1")).toBeUndefined();
    await launch(r, "c2", "ses_c2");
    r.reg.forgetSession(PARENT);
    expect(r.reg.listForParent(PARENT)).toEqual([]);
  });

  it("sweep closes attempts open for longer than the bound and returns them", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    r.reg.decide(callRecord("stale", { at: r.clock.t }));
    expect(r.reg.sweep(r.clock.t + ATTEMPT_SWEEP_AGE_MS)).toEqual([]);
    const closed = r.reg.sweep(r.clock.t + ATTEMPT_SWEEP_AGE_MS + 1);
    expect(closed).toEqual([a]);
    expect(a.state).toBe("closed-unknown");
    expect(a.outcome).toBe("unknown");
    expect(r.closed).toEqual([{ attempt: a, cause: "sweep" }]);
    expect(r.reg.byCall("stale")).toBeUndefined();
  });

  it("a throwing onClosed handler is logged, not propagated", async () => {
    const warns: string[] = [];
    const reg = createInFlightRegistry({
      now: () => 1,
      logger: { warn: (m) => void warns.push(m) },
      claims: new Set(),
      onClosed: () => {
        throw new Error("handler broke");
      },
    });
    reg.decide(callRecord("c1"));
    reg.acknowledge("c1", "ses_c", { userBackgrounded: false });
    reg.decide(callRecord("c2"));
    reg.acknowledge("c2", "ses_c", { userBackgrounded: false });
    expect(warns).toEqual(["[router] background close handler failed"]);
  });
});

describe("completion processor: one processing per attempt in every order", () => {
  type Ev = "ack" | "end" | "completion";
  const orders: Ev[][] = [
    ["ack", "end", "completion"],
    ["ack", "completion", "end"],
    ["end", "ack", "completion"],
    ["end", "completion", "ack"],
    ["completion", "ack", "end"],
    ["completion", "end", "ack"],
  ];

  async function drive(r: Rig, order: readonly Ev[], concurrent: boolean): Promise<void> {
    r.reg.decide(callRecord("c1"));
    const pending: Array<Promise<void>> = [];
    const run = async (p: Promise<void>): Promise<void> => {
      if (concurrent) pending.push(p);
      else await p;
    };
    for (const ev of order) {
      if (ev === "ack") {
        r.reg.acknowledge("c1", "ses_c1", { userBackgrounded: false });
        const early = r.reg.takeEarlyEnd("ses_c1");
        if (early !== undefined) await run(r.proc.process("ses_c1", { kind: "early-end", end: early }));
      } else if (ev === "end") {
        if (r.reg.byChild("ses_c1") === undefined) r.reg.noteEarlyEnd("ses_c1", { outcome: "succeeded", eventID: "e1", at: 1_000_500 });
        else await run(r.proc.process("ses_c1", endEvent()));
      } else {
        await run(r.proc.process("ses_c1", completion()));
      }
    }
    await Promise.all(pending);
  }

  for (const order of orders) {
    for (const concurrent of [false, true]) {
      it(`${order.join(" -> ")}${concurrent ? " (not awaited between events)" : ""} finishes exactly once`, async () => {
        const r = rig();
        await drive(r, order, concurrent);
        expect(r.finishCalls).toHaveLength(1);
        expect(r.finishCalls[0]).toMatchObject({ callID: "c1", childSessionID: "ses_c1", parentSessionID: PARENT, status: "succeeded", mode: "background" });
        expect(r.reg.byChild("ses_c1")?.state).toBe("annotated");
        expect(r.records.filter((x) => x.kind === "processed")).toHaveLength(1);
        expect(r.released).toEqual(["ses_c1"]);
      });
    }
  }

  it("a second trigger after the processing is a no-op", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", endEvent());
    await r.proc.process("ses_c1", completion());
    await r.proc.process("ses_c1", { kind: "recovery", outcome: "succeeded", text: "x", at: 1 });
    expect(r.finishCalls).toHaveLength(1);
  });

  it("a persisted processed key stops the processing (a restart replays nothing)", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    r.processedKeys.add(a.key);
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls).toHaveLength(0);
  });

  it("a throwing hasProcessed lookup is logged and does not block the processing", async () => {
    const r = rig();
    const warns: string[] = [];
    const proc = createCompletionProcessor(r.reg, {
      finish: async (i) => (r.finishCalls.push(i), finishResult()),
      readChildResult: async () => ({ text: "t" }),
      roleCompletion: async () => [],
      releaseLeases: () => undefined,
      held: r.held,
      persist: {
        append: async () => undefined,
        hasProcessed: () => {
          throw new Error("disk");
        },
      },
      now: () => r.clock.t,
      logger: { warn: (m) => void warns.push(m) },
    });
    await launch(r, "c1", "ses_c1");
    await proc.process("ses_c1", completion());
    expect(r.finishCalls).toHaveLength(1);
    expect(warns).toContain("[router] processed-key lookup failed");
  });

  it("an unknown child is ignored", async () => {
    const r = rig();
    await r.proc.process("ses_nobody", completion());
    expect(r.finishCalls).toHaveLength(0);
  });

  it("a foreground or cancelled attempt is never processed", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    r.reg.foreground("c1", "ses_c1");
    await launch(r, "c2", "ses_c2");
    r.reg.cancel("c2");
    await r.proc.process("ses_c1", completion());
    await r.proc.process("ses_c2", completion());
    expect(r.finishCalls).toHaveLength(0);
  });
});

describe("completion processor: reading the child result", () => {
  it("an end event whose result is not readable yet waits for the completion", async () => {
    const r = rig();
    r.behavior.read = async () => undefined;
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", endEvent());
    expect(a.state).toBe("child-ended");
    expect(a.endedAt).toBe(1_000_500);
    expect(r.finishCalls).toHaveLength(0);
    expect(r.proc.completedFor(PARENT)).toEqual([{ child: "ses_c1", label: 'implementer "task c1"', text: PENDING_GUARANTEES_TEXT }]);
    await r.proc.process("ses_c1", completion("completed", "final text"));
    expect(r.finishCalls).toHaveLength(1);
    expect(r.finishCalls[0]?.outputText).toBe("final text");
    expect(a.state).toBe("annotated");
  });

  it("a read that throws is logged and treated as not readable", async () => {
    const r = rig();
    r.behavior.read = async () => {
      throw new Error("no context");
    };
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", endEvent());
    expect(a.state).toBe("child-ended");
    expect(r.warns).toContain("[router] child result read failed; waiting for the completion");
  });

  it("the end event reads the text itself when it is available", async () => {
    const r = rig();
    r.behavior.read = async () => ({ text: "read text" });
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", endEvent());
    expect(r.finishCalls[0]?.outputText).toBe("read text");
    expect(r.finishCalls[0]?.endedAt).toBe(1_000_500);
  });

  it("settled waits for an in-flight processing and reports a timeout under fake timers", async () => {
    vi.useFakeTimers();
    const r = rig();
    let release: (v: FinishResult) => void = () => undefined;
    r.behavior.finish = () => new Promise<FinishResult>((resolve) => (release = resolve));
    await launch(r, "c1", "ses_c1");
    expect(await r.proc.settled("ses_none", 10)).toBe(true);
    const processing = r.proc.process("ses_c1", completion());
    const quick = r.proc.settled("ses_c1", 50);
    await vi.advanceTimersByTimeAsync(60);
    expect(await quick).toBe(false);
    const patient = r.proc.settled("ses_c1", 10_000);
    release(finishResult());
    await processing;
    expect(await patient).toBe(true);
    expect(await r.proc.settled("ses_c1", 10)).toBe(true);
  });

  it("settled is false while an acknowledged attempt has nothing to settle", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    expect(await r.proc.settled("ses_c1", 10)).toBe(false);
  });

  it("settled stays false after a child-ended wait without a result", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.behavior.read = async () => undefined;
    await launch(r, "c1", "ses_c1");
    const settledP = r.proc.settled("ses_c1", 1000);
    await r.proc.process("ses_c1", endEvent());
    await vi.advanceTimersByTimeAsync(1100);
    expect(await settledP).toBe(false);
  });
});

describe("completion processor: outcomes", () => {
  it("a failed child (completion error) finishes with status failed", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion("error", "boom"));
    expect(r.finishCalls[0]).toMatchObject({ status: "failed", outputText: "boom" });
  });

  it("an interrupted child (completion cancelled) finishes with status interrupted", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion("cancelled", "partial"));
    expect(r.finishCalls[0]).toMatchObject({ status: "interrupted" });
  });

  it("a failed end event carries its outcome", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", { kind: "end-event", outcome: "failed", eventID: "e", at: 5 });
    expect(r.finishCalls[0]).toMatchObject({ status: "failed", endedAt: 5 });
  });

  it("QA-2.1-17: a held child that failed or was interrupted journals no hold-text; a succeeded one does, with its status", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1", { handle: "h-failed" });
    await r.proc.process("ses_c1", completion("error", "boom"));
    await launch(r, "c2", "ses_c2", { handle: "h-cut" });
    await r.proc.process("ses_c2", completion("cancelled", "partial"));
    expect(r.records.filter((x) => x.kind === "hold-text")).toEqual([]);
    await launch(r, "c3", "ses_c3", { handle: "h-ok" });
    await r.proc.process("ses_c3", completion("completed", "all done"));
    expect(r.records.filter((x) => x.kind === "hold-text")).toEqual([
      expect.objectContaining({ handle: "h-ok", text: "all done", status: "succeeded" }),
    ]);
  });

  it("QA-2.1-17: only a recovery after a restart finishes with `restored` (the journaled dispatch, or an empty record)", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion("completed", "live result"));
    expect(r.finishCalls[0]?.restored).toBeUndefined();
    await launch(r, "c2", "ses_c2");
    await r.proc.process("ses_c2", { kind: "recovery", outcome: "succeeded", text: "recovered result", at: 7 });
    expect(r.finishCalls[1]).toMatchObject({ status: "succeeded", outputText: "recovered result", restored: {} });
  });

  it("a runner trigger (3.1) finishes with its status and text", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", { kind: "runner", status: "interrupted", text: "runner text", at: 9 });
    expect(r.finishCalls[0]).toMatchObject({ status: "interrupted", outputText: "runner text", endedAt: 9 });
  });

  it("a resume (new attempt on the same child) closes the old attempt and the new one owns the next end", async () => {
    const r = rig();
    const first = await launch(r, "c1", "ses_c1");
    const second = await launch(r, "c2", "ses_c1");
    expect(first.state).toBe("closed-unknown");
    expect(r.closed).toEqual([{ attempt: first, cause: "superseded" }]);
    expect(r.reg.byChild("ses_c1")).toBe(second);
    await r.proc.process("ses_c1", endEvent());
    expect(r.finishCalls).toHaveLength(1);
    expect(r.finishCalls[0]?.callID).toBe("c2");
    expect(first.state).toBe("closed-unknown");
    expect(second.state).toBe("annotated");
  });

  it("closeUnknown releases the leases and annotates; an attempt that never ends is closed unknown at the sweep", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    const [closed] = r.reg.sweep(r.clock.t + ATTEMPT_SWEEP_AGE_MS + 1);
    expect(closed).toBe(a);
    await r.proc.closeUnknown(a, "swept");
    expect(r.released).toEqual(["ses_c1"]);
    expect(a.annotations).toEqual(["[router] the dispatch ended without a result (swept)"]);
    expect(r.proc.completedFor(PARENT)).toEqual([
      { child: "ses_c1", label: 'implementer "task c1"', text: "[router] the dispatch ended without a result (swept)" },
    ]);
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls).toHaveLength(0);
  });

  it("closeUnknown on a held attempt posts an UNVERIFIABLE verdict once", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.closeUnknown(a, "superseded");
    await r.proc.closeUnknown(a, "superseded");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.text).toContain('verdict="UNVERIFIABLE"');
    expect(r.posts[0]?.text).toContain("[router] not verified: superseded");
    expect(r.held.isHeld("ses_c1")).toBe(false);
  });

  it("closeUnknown never throws when the lease release does", async () => {
    const r = rig();
    r.behavior.release = () => {
      throw new Error("lease broke");
    };
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.closeUnknown(a, "swept");
    expect(r.warns).toContain("[router] lease release failed");
  });
});

describe("completion processor: recovery after a restart", () => {
  it("a lost attempt (no result) is annotated, never finished, and its hold is released UNVERIFIABLE", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", { kind: "recovery", outcome: "lost", text: undefined, at: 7 });
    expect(r.finishCalls).toHaveLength(0);
    expect(a.annotations).toEqual(["[router] the dispatch was lost in a restart"]);
    expect(a.outcome).toBe("unknown");
    expect(a.state).toBe("released");
    expect(r.posts[0]?.text).toContain("lost in restart");
    expect(r.records.some((x) => x.kind === "processed")).toBe(true);
  });

  it("a lost attempt without a hold ends annotated", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", { kind: "recovery", outcome: "lost", text: undefined, at: 7 });
    expect(a.state).toBe("annotated");
    expect(r.released).toEqual(["ses_c1"]);
  });

  it("a recovered child with text is finished like any other", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", { kind: "recovery", outcome: "succeeded", text: "recovered", at: 7 });
    expect(r.finishCalls[0]).toMatchObject({ outputText: "recovered", status: "succeeded" });
  });
});

describe("completion processor: finish, delta, notices", () => {
  it("passes the captured change set to finish; a capture failure is logged and finish still runs", async () => {
    const r = rig({ withCapture: true });
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls[0]?.delta).toEqual({ files: ["a.ts"] });

    const r2 = rig({ withCapture: true });
    r2.behavior.capture = async () => {
      throw new Error("tree gone");
    };
    await launch(r2, "c1", "ses_c1");
    await r2.proc.process("ses_c1", completion());
    expect(r2.finishCalls).toHaveLength(1);
    expect("delta" in (r2.finishCalls[0] ?? {})).toBe(false);
    expect(r2.warns).toContain("[router] change-set capture failed");
  });

  it("an undefined delta is not sent", async () => {
    const r = rig({ withCapture: true });
    r.behavior.capture = async () => undefined;
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    expect("delta" in (r.finishCalls[0] ?? {})).toBe(false);
  });

  it("role notices come before the finish suffix, blank parts are dropped", async () => {
    const r = rig();
    r.behavior.notices = ["[router] budget low", "  "];
    r.behavior.finish = async () => finishResult({ suffix: "  [router] ok  " });
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    expect(a.annotations).toEqual(["[router] budget low", "[router] ok"]);
  });

  it("a finish that throws becomes a 'router guarantees failed' annotation; the leases are released and the key marked", async () => {
    const r = rig();
    r.behavior.finish = async () => {
      throw new Error("gate exploded");
    };
    const a = await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    expect(a.annotations).toEqual(["router guarantees failed: gate exploded"]);
    expect(a.state).toBe("annotated");
    expect(r.released).toEqual(["ses_c1"]);
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls).toHaveLength(1);
  });

  it("a finish that throws on a held attempt posts UNVERIFIABLE with the child text", async () => {
    const r = rig();
    r.behavior.finish = async () => {
      throw new Error("gate exploded");
    };
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion());
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.text).toContain('verdict="UNVERIFIABLE"');
    expect(r.posts[0]?.text).toContain("child text\n[router] not verified: gate exploded");
    expect(a.state).toBe("released");
  });

  it("a journal that throws does not fail the processing", async () => {
    const r = rig();
    const warns: string[] = [];
    const proc = createCompletionProcessor(r.reg, {
      finish: async (i) => (r.finishCalls.push(i), finishResult()),
      readChildResult: async () => ({ text: "t" }),
      roleCompletion: async () => [],
      releaseLeases: () => undefined,
      held: r.held,
      persist: {
        append: async () => {
          throw new Error("ENOSPC");
        },
        hasProcessed: () => false,
      },
      now: () => r.clock.t,
      logger: { warn: (m) => void warns.push(m) },
    });
    const a = await launch(r, "c1", "ses_c1");
    await proc.process("ses_c1", completion());
    expect(a.state).toBe("annotated");
    expect(warns).toContain("[router] background journal append failed");
  });

  it("a logger that throws never fails the processing", async () => {
    const r = rig();
    const proc = createCompletionProcessor(r.reg, {
      finish: async () => {
        throw new Error("x");
      },
      readChildResult: async () => ({ text: "t" }),
      roleCompletion: async () => [],
      releaseLeases: () => undefined,
      held: r.held,
      persist: { append: async () => undefined, hasProcessed: () => false },
      now: () => r.clock.t,
      logger: {
        warn: () => {
          throw new Error("logger broke");
        },
      },
    });
    await launch(r, "c1", "ses_c1");
    await expect(proc.process("ses_c1", completion())).resolves.toBeUndefined();
  });
});

describe("completion processor: held results", () => {
  it("a succeeded child whose gate holds leaves the attempt held until the verdict posts", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ verification: { kind: "held", handle: "vrf_h1" } });
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls[0]?.heldHandle).toBe("vrf_h1");
    expect(a.state).toBe("held");
    expect(r.held.isHeld("ses_c1")).toBe(true);
    expect(r.posts).toHaveLength(0);
    expect(r.proc.completedFor(PARENT)).toEqual([]);
    await r.held.verdict("vrf_h1", { verdict: "PASS", text: "output and verdict" });
    expect(r.posts).toHaveLength(1);
    expect(r.proc.completedFor(PARENT)).toEqual([]);
    expect(a.state).toBe("released");
  });

  it("without a gate a PASS implied by the result is posted by the processor", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ verification: { kind: "required", verdict: "PASS" } });
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion());
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.text).toContain('verdict="PASS"');
    expect(a.state).toBe("released");
  });

  it("a FAIL implied by the result carries the findings", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ outputText: "findings: x failed", verification: { kind: "required", verdict: "FAIL" } });
    await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion());
    expect(r.posts[0]?.text).toContain('verdict="FAIL"');
    expect(r.posts[0]?.text).toContain("findings: x failed");
  });

  it("a non-succeeded child with a hold releases UNVERIFIABLE, naming the outcome", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ outputText: "partial" });
    await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion("error", "boom"));
    expect(r.finishCalls[0]?.heldHandle).toBeUndefined();
    expect(r.posts[0]?.text).toContain('verdict="UNVERIFIABLE"');
    expect(r.posts[0]?.text).toContain("the dispatch ended failed");
  });

  it("a result with no verification and a hold releases UNVERIFIABLE: no verification ran", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion());
    expect(r.posts[0]?.text).toContain("no verification ran");
  });

  it("a verdict sink that throws is logged and the attempt is left held", async () => {
    const r = rig();
    const throwingHeld: HeldResults = {
      ...r.held,
      verdict: async () => {
        throw new Error("sink down");
      },
      isHeld: () => true,
    };
    const proc = createCompletionProcessor(r.reg, {
      finish: async () => finishResult(),
      readChildResult: async () => ({ text: "t" }),
      roleCompletion: async () => [],
      releaseLeases: () => undefined,
      held: throwingHeld,
      persist: { append: async () => undefined, hasProcessed: () => false },
      now: () => r.clock.t,
      logger: { warn: (m) => void r.warns.push(m) },
    });
    const a = await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await proc.process("ses_c1", completion());
    expect(a.state).toBe("held");
    expect(r.warns).toContain("[router] held verdict failed");
  });

  it("a held register keeps its reserved handle; every other end of a held attempt gives it back (QA-2.1-4)", async () => {
    const gated = rig();
    gated.behavior.finish = async () => finishResult({ verification: { kind: "held", handle: "vrf_h1" } });
    await launch(gated, "c1", "ses_c1", { handle: "vrf_h1" });
    await gated.proc.process("ses_c1", completion());
    expect(gated.releasedHandles).toEqual([]);

    const failed = rig();
    await launch(failed, "c1", "ses_c1", { handle: "vrf_h1" });
    await failed.proc.process("ses_c1", completion("error", "boom"));
    expect(failed.releasedHandles).toEqual(["vrf_h1"]);

    const interrupted = rig();
    await launch(interrupted, "c1", "ses_c1", { handle: "vrf_h1" });
    await interrupted.proc.process("ses_c1", completion("cancelled", "stopped"));
    expect(interrupted.releasedHandles).toEqual(["vrf_h1"]);

    const answered = rig();
    answered.behavior.finish = async () => finishResult({ verification: { kind: "required", verdict: "PASS" } });
    await launch(answered, "c1", "ses_c1", { handle: "vrf_h1" });
    await answered.proc.process("ses_c1", completion());
    expect(answered.releasedHandles).toEqual(["vrf_h1"]);

    const lost = rig();
    await launch(lost, "c1", "ses_c1", { handle: "vrf_h1" });
    await lost.proc.process("ses_c1", { kind: "recovery", outcome: "lost", text: undefined, at: 7 });
    expect(lost.releasedHandles).toEqual(["vrf_h1"]);

    const thrown = rig();
    thrown.behavior.finish = async () => {
      throw new Error("gate exploded");
    };
    await launch(thrown, "c1", "ses_c1", { handle: "vrf_h1" });
    await thrown.proc.process("ses_c1", completion());
    expect(thrown.releasedHandles).toEqual(["vrf_h1"]);

    const closed = rig();
    const a = await launch(closed, "c1", "ses_c1", { handle: "vrf_h1" });
    await closed.proc.closeUnknown(a, "superseded");
    expect(closed.releasedHandles).toEqual(["vrf_h1"]);
    expect(closed.posts[0]?.text).toContain("not verified: superseded");

    const plain = rig();
    await launch(plain, "c1", "ses_c1");
    await plain.proc.process("ses_c1", completion("error", "boom"));
    expect(plain.releasedHandles).toEqual([]);
  });

  it("a held attempt journals the child text with its hold before the gate runs (QA-2.1-6)", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ verification: { kind: "held", handle: "vrf_h1" } });
    await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    await r.proc.process("ses_c1", completion("completed", "the child said"));
    const kinds = r.records.map((x) => x.kind);
    expect(r.records.find((x) => x.kind === "hold-text")).toMatchObject({ handle: "vrf_h1", text: "the child said" });
    expect(kinds.indexOf("hold-text")).toBeLessThan(kinds.indexOf("processed"));
  });
});

describe("completed provider: completedFor / endTurn", () => {
  it("shows an annotation in the turn it was processed, then drops it after the turn ends", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    const first = r.proc.completedFor(PARENT);
    expect(first).toHaveLength(1);
    expect(first[0]?.text).toBe("[router] ok");
    expect(r.proc.completedFor(PARENT)).toEqual(first);
    r.proc.endTurn(PARENT);
    expect(r.proc.completedFor(PARENT)).toEqual([]);
    expect(r.reg.byChild("ses_c1")?.state).toBe("released");
  });

  it("an annotation that arrives after the turn started is shown in the next turn only once", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    r.proc.endTurn(PARENT);
    await r.proc.process("ses_c1", completion());
    expect(r.proc.completedFor(PARENT)).toHaveLength(1);
    r.proc.endTurn(PARENT);
    expect(r.proc.completedFor(PARENT)).toEqual([]);
  });

  it("the pending line shows first for a processing attempt and the annotation replaces it", async () => {
    const r = rig();
    let release: (v: FinishResult) => void = () => undefined;
    r.behavior.finish = () => new Promise<FinishResult>((resolve) => (release = resolve));
    const a = await launch(r, "c1", "ses_c1");
    const p = r.proc.process("ses_c1", completion());
    expect(r.proc.completedFor(PARENT).map((l) => l.text)).toEqual([PENDING_GUARANTEES_TEXT]);
    expect(a.pendingShown).toBe(true);
    for (let i = 0; i < 20 && r.finishCalls.length === 0; i += 1) await Promise.resolve();
    expect(r.finishCalls).toHaveLength(1);
    release(finishResult());
    await p;
    expect(r.proc.completedFor(PARENT).map((l) => l.text)).toEqual(["[router] ok"]);
  });

  it("lines are ordered by end time and an empty annotation reads 'completed'", async () => {
    const r = rig();
    r.behavior.finish = async () => finishResult({ suffix: "" });
    await launch(r, "c1", "ses_c1");
    await launch(r, "c2", "ses_c2");
    await r.proc.process("ses_c2", { kind: "completion", state: "completed", body: "b", at: 100 });
    await r.proc.process("ses_c1", { kind: "completion", state: "completed", body: "b", at: 200 });
    const lines = r.proc.completedFor(PARENT);
    expect(lines.map((l) => l.child)).toEqual(["ses_c2", "ses_c1"]);
    expect(lines.map((l) => l.text)).toEqual(["completed", "completed"]);
  });

  it("a swept attempt with annotations is reported", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1");
    r.reg.sweep(r.clock.t + ATTEMPT_SWEEP_AGE_MS + 1);
    await r.proc.closeUnknown(a, "swept");
    expect(r.proc.completedFor(PARENT)).toHaveLength(1);
    r.proc.endTurn(PARENT);
    expect(r.proc.completedFor(PARENT)).toEqual([]);
  });

  it("forgetSession resets the turn counter without affecting other parents", async () => {
    const r = rig();
    r.proc.endTurn(PARENT);
    r.proc.forgetSession(PARENT);
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    expect(r.proc.completedFor(PARENT)).toHaveLength(1);
    expect(r.proc.completedFor("ses_other")).toEqual([]);
  });
});

describe("race matrix leftovers (R4, R11, R22, R23) and memory caps", () => {
  it("R4: an end with no acknowledgement expires and nothing is processed", async () => {
    const r = rig();
    r.reg.noteEarlyEnd("ses_c1", { outcome: "succeeded", eventID: "e1", at: r.clock.t });
    r.clock.t += EARLY_END_TTL_MS + 1;
    r.reg.decide(callRecord("c1"));
    r.reg.acknowledge("c1", "ses_c1", { userBackgrounded: false });
    expect(r.reg.takeEarlyEnd("ses_c1")).toBeUndefined();
    expect(r.finishCalls).toHaveLength(0);
    expect(r.reg.byChild("ses_c1")?.state).toBe("acknowledged");
  });

  it("R11: a resume after the first attempt was processed is a new attempt, processed once more", async () => {
    const r = rig();
    await launch(r, "c1", "ses_c1");
    await r.proc.process("ses_c1", completion());
    await launch(r, "c2", "ses_c1");
    await r.proc.process("ses_c1", completion());
    await r.proc.process("ses_c1", completion());
    expect(r.finishCalls.map((c) => c.callID)).toEqual(["c1", "c2"]);
    expect(r.records.filter((x) => x.kind === "processed").map((x) => x.callID)).toEqual(["c1", "c2"]);
  });

  it("R22: a parent deleted mid-run drops its state; a later end processes nothing", async () => {
    const r = rig();
    let release: (v: FinishResult) => void = () => undefined;
    r.behavior.finish = () => new Promise<FinishResult>((resolve) => (release = resolve));
    await launch(r, "c1", "ses_c1", { handle: "vrf_h1" });
    const running = r.proc.process("ses_c1", completion());
    for (let i = 0; i < 20 && r.finishCalls.length === 0; i += 1) await Promise.resolve();
    r.reg.forgetSession(PARENT);
    r.proc.forgetSession(PARENT);
    r.held.forgetSession(PARENT);
    expect(r.held.isHeld("ses_c1")).toBe(false);
    expect(r.held.heldFor(PARENT)).toEqual([]);
    release(finishResult());
    await running;
    await r.proc.process("ses_c1", endEvent());
    expect(r.finishCalls).toHaveLength(1);
    expect(r.reg.listForParent(PARENT)).toEqual([]);
    expect(r.posts).toHaveLength(0);
  });

  it("R23: two plugin instances share the call claims, so one processing happens", async () => {
    const claims = new Set<string>();
    const mk = () => createInFlightRegistry({ now: () => 1, logger: { warn: () => undefined }, claims });
    const one = mk();
    const two = mk();
    expect(one.decide(callRecord("c1"))).toBe(true);
    expect(two.decide(callRecord("c1"))).toBe(false);
    expect(two.acknowledge("c1", "ses_c1", { userBackgrounded: false })).toBeUndefined();
    expect(one.acknowledge("c1", "ses_c1", { userBackgrounded: false })?.state).toBe("acknowledged");
  });

  it("the live count caps at the number of open calls", () => {
    const r = rig();
    for (let i = 0; i < 1000; i += 1) r.reg.decide(callRecord(`live${i}`));
    expect(r.reg.liveCount()).toBe(1000);
  });

  it("early ends are bounded to 200, the oldest dropped first", () => {
    const r = rig();
    for (let i = 0; i < 205; i += 1) r.reg.noteEarlyEnd(`ses_${i}`, { outcome: "succeeded", eventID: `e${i}`, at: r.clock.t });
    expect(r.reg.takeEarlyEnd("ses_0")).toBeUndefined();
    expect(r.reg.takeEarlyEnd("ses_4")).toBeUndefined();
    expect(r.reg.takeEarlyEnd("ses_5")).toBeDefined();
    expect(r.reg.takeEarlyEnd("ses_204")).toBeDefined();
  });

  it("the completed buffer shows at most 32 lines per parent, newest last", async () => {
    const r = rig();
    for (let i = 0; i < 40; i += 1) {
      await launch(r, `c${i}`, `ses_${i}`);
      await r.proc.process(`ses_${i}`, { kind: "completion", state: "completed", body: "b", at: 1000 + i });
    }
    const lines = r.proc.completedFor(PARENT);
    expect(lines).toHaveLength(32);
    expect(lines[0]?.child).toBe("ses_8");
    expect(lines[31]?.child).toBe("ses_39");
  });

  it("holds are bounded to 256 per parent: released holds are evicted, active ones refuse the next", async () => {
    const r = rig();
    for (let i = 0; i < 256; i += 1) {
      await r.held.hold({ handle: `vrf_${i}`, parentSessionID: PARENT, childSessionID: `ses_${i}`, callID: `c${i}` });
    }
    await expect(r.held.hold({ handle: "vrf_x", parentSessionID: PARENT, childSessionID: "ses_x", callID: "cx" })).rejects.toThrow(
      "hold capacity reached",
    );
    await r.held.verdict("vrf_0", { verdict: "PASS", text: "ok" });
    await r.held.hold({ handle: "vrf_x", parentSessionID: PARENT, childSessionID: "ses_x", callID: "cx" });
    expect(r.held.heldFor(PARENT)).toHaveLength(256);
    expect(r.held.isHeld("ses_0")).toBe(false);
  });

  it("holds are bounded to 10 000 globally", async () => {
    const r = rig();
    for (let p = 0; p < 40; p += 1) {
      for (let i = 0; i < 250; i += 1) {
        await r.held.hold({ handle: `vrf_${p}_${i}`, parentSessionID: `parent${p}`, childSessionID: `ses_${p}_${i}`, callID: `c${p}_${i}` });
      }
    }
    await expect(r.held.hold({ handle: "vrf_over", parentSessionID: "parent40", childSessionID: "ses_over", callID: "cover" })).rejects.toThrow(
      "hold capacity reached",
    );
  });

  it("completed-turn counters for more than 1000 parents are bounded without error", () => {
    const r = rig();
    for (let i = 0; i < 1010; i += 1) r.proc.endTurn(`parent${i}`);
    expect(r.proc.completedFor("parent0")).toEqual([]);
  });
});

describe("held results: placeholder, matcher, refusal, verdict delivery (memo 5, 7)", () => {
  const HANDLE = "vrf_aaaaaaaaaaaaaaaaaaaaaaaa";
  const CHILD = "ses_child";
  const PH = heldPlaceholder(HANDLE, CHILD);

  async function heldRig(body?: string): Promise<Rig> {
    const r = rig();
    await r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1", label: 'implementer "x"', ...(body === undefined ? {} : { body }) });
    return r;
  }

  it("holding appends a fsync'd hold record and lists the entry as verifying", async () => {
    const r = await heldRig();
    expect(r.records.find((x) => x.kind === "hold")).toMatchObject({ handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" });
    expect(r.held.isHeld(CHILD)).toBe(true);
    expect(r.held.heldFor(PARENT)).toEqual([{ handle: HANDLE, child: CHILD, label: 'implementer "x"', status: "verifying" }]);
    expect(r.held.placeholder(HANDLE, CHILD)).toBe(PH);
  });

  it("holding is refused when holding is not available", async () => {
    const held = createHeldResults({ synthetic: async () => undefined, journal: { append: async () => undefined, hasProcessed: () => false }, available: false, logger: { warn: () => undefined } });
    expect(held.available).toBe(false);
    await expect(held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c" })).rejects.toThrow("holding is not available");
  });

  it("a part that is the whole completion message becomes the placeholder; the placeholder is stable across requests", async () => {
    const r = await heldRig();
    const text = `<subagent sessionID="${CHILD}" state="completed">secret output</subagent>`;
    const once = r.held.applyText(PARENT, text);
    expect(once).toBe(PH);
    expect(r.held.applyText(PARENT, once)).toBe(PH);
    expect(r.held.applyText(PARENT, r.held.applyText(PARENT, once))).toBe(PH);
    expect(r.held.applyText("ses_other", text)).toBe(text);
  });

  it("an embedded record is cut precisely when the known body follows verbatim, else through the end (O13)", async () => {
    const r = await heldRig("the body");
    const exact = `before <subagent sessionID="${CHILD}" state="completed">the body</subagent> after`;
    expect(r.held.applyText(PARENT, exact)).toBe(`before ${PH} after`);
    const unknown = `before <subagent sessionID="${CHILD}" state="completed">other body</subagent> after`;
    expect(r.held.applyText(PARENT, unknown)).toBe(`before ${PH}`);
    const twice = `x <subagent sessionID="${CHILD}" state="completed">the body</subagent> y ${PH} z`;
    expect(r.held.applyText(PARENT, twice)).toBe(`x ${PH} y ${PH} z`);
  });

  it("a verdict entry is never rewritten", async () => {
    const r = await heldRig();
    const verdict = `<router-verdict handle="${HANDLE}" sessionID="${CHILD}" verdict="PASS">\n<subagent sessionID="${CHILD}">x</subagent>\n</router-verdict>`;
    expect(r.held.applyText(PARENT, verdict)).toBe(verdict);
  });

  it("apply copies only the changed messages and parts and never mutates the input", async () => {
    const r = await heldRig();
    const frozenPart = Object.freeze({ type: "text", text: `<subagent sessionID="${CHILD}" state="completed">secret</subagent>` });
    const other = Object.freeze({ type: "text", text: "hello" });
    const tool = Object.freeze({ type: "tool", text: `<subagent sessionID="${CHILD}">no</subagent>` });
    const m1 = Object.freeze({ id: "m1", parts: Object.freeze([frozenPart, other, tool]) });
    const m2 = Object.freeze({ id: "m2", parts: Object.freeze([other]) });
    const m3 = Object.freeze({ id: "m3" });
    const messages = Object.freeze([m1, m2, m3]);
    const out = r.held.apply(PARENT, messages);
    expect(out).toBeDefined();
    expect(out?.[0]).toEqual({ id: "m1", parts: [{ type: "text", text: PH }, other, tool] });
    expect(out?.[1]).toBe(m2);
    expect(out?.[2]).toBe(m3);
    expect(frozenPart.text).toContain("secret");
    expect(r.held.apply(PARENT, [m2, m3])).toBeUndefined();
    expect(r.held.apply("ses_other", messages)).toBeUndefined();
    expect(r.held.apply(PARENT, ["str", null])).toBeUndefined();
  });

  it("a released hold keeps its placeholder for the life of the session", async () => {
    const r = await heldRig();
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "ok" });
    expect(r.held.isHeld(CHILD)).toBe(false);
    expect(r.held.applyText(PARENT, `<subagent sessionID="${CHILD}" state="completed">secret</subagent>`)).toBe(PH);
  });

  it("refuses a resume by sessionID or task_id and a Code Mode reference to a held child, and nothing else", async () => {
    const r = await heldRig();
    const refusal = `[router] Refused: session ${CHILD} is held for verification (${HANDLE}). Its result arrives with the verdict; resume it after that.`;
    expect(r.held.refusal(PARENT, "subagent", { sessionID: CHILD })).toBe(refusal);
    expect(r.held.refusal(PARENT, "subagent", { task_id: CHILD })).toBe(refusal);
    expect(r.held.refusal(PARENT, "execute", { code: `await tools.opencode.subagent({sessionID: "${CHILD}"})` })).toBe(refusal);
    expect(r.held.refusal(PARENT, "subagent", { sessionID: "ses_unrelated" })).toBeUndefined();
    expect(r.held.refusal(PARENT, "subagent", { prompt: "x" })).toBeUndefined();
    expect(r.held.refusal(PARENT, "subagent", "not an object")).toBeUndefined();
    expect(r.held.refusal(PARENT, "execute", { code: "return 1" })).toBeUndefined();
    expect(r.held.refusal(PARENT, "execute", { code: 5 })).toBeUndefined();
    expect(r.held.refusal(PARENT, "read", { sessionID: CHILD })).toBeUndefined();
    expect(r.held.refusal("ses_other", "subagent", { sessionID: CHILD })).toBeUndefined();
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "ok" });
    expect(r.held.refusal(PARENT, "subagent", { sessionID: CHILD })).toBeUndefined();
  });

  it("posts the verdict entry once: journal posting, synthetic with resume, journal posted", async () => {
    const r = await heldRig();
    await r.held.verdict(HANDLE, { verdict: "FAIL", text: "child text\nfindings" });
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "late" });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({
      sessionID: PARENT,
      description: "Model router verdict",
      resume: true,
      metadata: { router: { kind: "held-verdict", handle: HANDLE, child: CHILD } },
    });
    expect(r.posts[0]?.text).toBe(`<router-verdict handle="${HANDLE}" sessionID="${CHILD}" verdict="FAIL">\nchild text\nfindings\n</router-verdict>`);
    expect(r.records.map((x) => x.kind)).toEqual(["hold", "posting", "posted"]);
  });

  it("an unknown handle is ignored", async () => {
    const r = await heldRig();
    await r.held.verdict("vrf_unknown", { verdict: "PASS", text: "x" });
    expect(r.posts).toEqual([]);
  });

  it("a synthetic failure is retried with backoff 3 times, then the entry stays held and posting for the next start", async () => {
    const r = await heldRig();
    let calls = 0;
    r.behavior.synthetic = async () => {
      calls += 1;
      throw new Error("host down");
    };
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "x" });
    expect(calls).toBe(3);
    expect(r.records.filter((x) => x.kind === "posted")).toEqual([]);
    expect(r.warns).toContain("[router] held verdict not posted; kept for the next start");
    expect(r.held.isHeld(CHILD)).toBe(true);
  });

  it("a synthetic that fails once then succeeds posts", async () => {
    const r = await heldRig();
    let calls = 0;
    r.behavior.synthetic = async () => {
      calls += 1;
      if (calls === 1) throw new Error("busy");
    };
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "x" });
    expect(calls).toBe(2);
    expect(r.held.isHeld(CHILD)).toBe(false);
  });

  // QA-2.1-2 changed this contract: a journal failure no longer keeps the verdict back (the old test expected
  // "[router] held verdict journal failed" and an active hold). The verdict is posted anyway, exactly once, and a journal
  // failure is never retried through synthetic.
  it("a journal that throws on posting is logged and the verdict is posted anyway, once (QA-2.1-2)", async () => {
    const warns: string[] = [];
    const posts: string[] = [];
    let fail = false;
    const held = createHeldResults({
      synthetic: async (input) => {
        posts.push(input.text);
      },
      journal: {
        append: async () => {
          if (fail) throw new Error("ENOSPC");
        },
        hasProcessed: () => false,
      },
      available: true,
      logger: { warn: (m) => void warns.push(m) },
      sleep: async () => undefined,
    });
    await held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c" });
    fail = true;
    await held.verdict(HANDLE, { verdict: "PASS", text: "x" });
    await held.verdict(HANDLE, { verdict: "PASS", text: "x again" });
    expect(warns).toContain("[router] held verdict posting not journaled; posting anyway");
    expect(posts).toHaveLength(1);
    expect(held.isHeld(CHILD)).toBe(false);
  });

  it("a journal that throws on posted after a successful post never posts twice (QA-2.1-2)", async () => {
    const posts: string[] = [];
    const held = createHeldResults({
      synthetic: async (input) => {
        posts.push(input.text);
      },
      journal: {
        append: async (record) => {
          if (record.kind === "posted") throw new Error("ENOSPC");
        },
        hasProcessed: () => false,
      },
      available: true,
      logger: { warn: () => undefined },
      sleep: async () => undefined,
    });
    await held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c" });
    await held.verdict(HANDLE, { verdict: "FAIL", text: "x" });
    await held.verdict(HANDLE, { verdict: "FAIL", text: "x" });
    expect(posts).toHaveLength(1);
    expect(held.isHeld(CHILD)).toBe(false);
  });

  it("forgetSession drops the session's holds and journals a forget record", async () => {
    const r = await heldRig();
    r.held.forgetSession(PARENT);
    await Promise.resolve();
    expect(r.held.isHeld(CHILD)).toBe(false);
    expect(r.held.applyText(PARENT, `<subagent sessionID="${CHILD}">x</subagent>`)).toBe(`<subagent sessionID="${CHILD}">x</subagent>`);
    expect(r.records.at(-1)).toMatchObject({ kind: "forget", session: PARENT });
  });

  it("a forget record that cannot be journaled is only logged", async () => {
    const warns: string[] = [];
    const held = createHeldResults({
      synthetic: async () => undefined,
      journal: {
        append: async () => {
          throw new Error("ENOSPC");
        },
        hasProcessed: () => false,
      },
      available: true,
      logger: { warn: (m) => void warns.push(m) },
    });
    held.forgetSession(PARENT);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await Promise.resolve();
    expect(warns).toContain("[router] held forget not journaled");
  });

  it("restore re-creates the active holds from the records, honoring posted and forget", () => {
    const r = rig();
    r.held.restore([
      { v: 1, kind: "hold", handle: "vrf_1", parent: PARENT, child: "ses_1", callID: "c1" },
      { v: 1, kind: "hold", handle: "vrf_2", parent: PARENT, child: "ses_2", callID: "c2" },
      { v: 1, kind: "hold", handle: "vrf_3", parent: "ses_gone", child: "ses_3" },
      { v: 1, kind: "hold", parent: PARENT, child: "ses_bad" },
      { v: 1, kind: "posted", handle: "vrf_2" },
      { v: 1, kind: "posted", handle: "vrf_unknown" },
      { v: 1, kind: "forget", session: "ses_gone" },
      { v: 1, kind: "other" },
    ]);
    expect(r.held.heldFor(PARENT).map((h) => h.handle)).toEqual(["vrf_1"]);
    expect(r.held.heldFor(PARENT)[0]?.label).toBe("session ses_1");
    expect(r.held.isHeld("ses_2")).toBe(false);
    expect(r.held.isHeld("ses_3")).toBe(false);
    expect(r.held.applyText(PARENT, '<subagent sessionID="ses_2" state="completed">x</subagent>')).toBe(heldPlaceholder("vrf_2", "ses_2"));
  });

  it("a verdict that settles before hold inserts the entry is queued and delivered by hold (QA-2.1-2)", async () => {
    const r = rig();
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "early" });
    expect(r.posts).toEqual([]);
    await r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" });
    await flushAll();
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.text).toContain("early");
    expect(r.held.isHeld(CHILD)).toBe(false);
  });

  it("a verdict that settles while the hold record is being written waits for it and is posted once (QA-2.1-2)", async () => {
    const r = rig();
    const holding = r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" });
    // The entry exists before the fsync resolves: it is held and a verdict joins it instead of being dropped.
    expect(r.held.isHeld(CHILD)).toBe(true);
    const delivering = r.held.verdict(HANDLE, { verdict: "FAIL", text: "during fsync" });
    await holding;
    await delivering;
    expect(r.posts).toHaveLength(1);
    expect(r.records.map((x) => x.kind)).toEqual(["hold", "posting", "posted"]);
  });

  /** QA-2.1-24: a held store whose `hold` record fails (the `hold` append rejects through `failHold`, or at once). */
  function failingHoldRig(mode: "now" | "later") {
    const posts: Array<Record<string, unknown>> = [];
    const warns: string[] = [];
    const kinds: string[] = [];
    let failHold: (error: Error) => void = () => undefined;
    const held = createHeldResults({
      synthetic: async (input) => {
        posts.push({ ...input });
      },
      journal: {
        append: (record) => {
          kinds.push(String(record.kind));
          if (record.kind !== "hold") return Promise.resolve();
          if (mode === "now") return Promise.reject(new Error("ENOSPC"));
          return new Promise<void>((_resolve, reject) => {
            failHold = reject;
          });
        },
        hasProcessed: () => false,
      },
      available: true,
      logger: { warn: (m) => void warns.push(m) },
      sleep: async () => undefined,
    });
    return { held, posts, warns, kinds, failHold: (error: Error) => failHold(error) };
  }

  it("QA-2.1-24: a verdict queued before a hold whose record fails is posted as a plain notice, once", async () => {
    const r = failingHoldRig("now");
    await r.held.verdict(HANDLE, { verdict: "FAIL", text: "early findings" });
    expect(r.posts).toEqual([]);
    await expect(r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" })).rejects.toThrow("ENOSPC");
    await flushAll();
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({
      sessionID: PARENT,
      text: unheldVerdictText(HANDLE, CHILD, { verdict: "FAIL", text: "early findings" }),
      resume: true,
      metadata: { router: { kind: "unheld-verdict", handle: HANDLE, child: CHILD } },
    });
    expect(String(r.posts[0]?.text)).not.toContain("<router-verdict ");
    expect(r.held.isHeld(CHILD)).toBe(false);
    // Nothing was held, so nothing about the post is journaled.
    expect(r.kinds).toEqual(["hold"]);
  });

  it("QA-2.1-24: a verdict that settles while a failing hold record is written is posted as a plain notice, not dropped", async () => {
    const r = failingHoldRig("later");
    const holding = r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" });
    const delivering = r.held.verdict(HANDLE, { verdict: "PASS", text: "during the write" });
    r.failHold(new Error("EIO"));
    await expect(holding).rejects.toThrow("EIO");
    await delivering;
    await flushAll();
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ sessionID: PARENT, text: unheldVerdictText(HANDLE, CHILD, { verdict: "PASS", text: "during the write" }), resume: true });
    expect(r.warns).not.toContain("[router] held verdict dropped: the hold was never journaled");
  });

  it("QA-2.1-24: a verdict that settles after its hold record failed is posted as a plain notice, once", async () => {
    const r = failingHoldRig("now");
    await expect(r.held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" })).rejects.toThrow("ENOSPC");
    await r.held.verdict(HANDLE, { verdict: "UNVERIFIABLE", text: "late", reason: "gate timed out" });
    await r.held.verdict(HANDLE, { verdict: "UNVERIFIABLE", text: "late again", reason: "gate timed out" });
    await flushAll();
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ text: unheldVerdictText(HANDLE, CHILD, { verdict: "UNVERIFIABLE", text: "late" }) });
  });

  it("QA-2.1-24: a plain notice whose synthetic call fails is retried, then logged", async () => {
    const warns: string[] = [];
    let calls = 0;
    const held = createHeldResults({
      synthetic: async () => {
        calls += 1;
        throw new Error("host busy");
      },
      journal: { append: async (record) => { if (record.kind === "hold") throw new Error("ENOSPC"); }, hasProcessed: () => false },
      available: true,
      logger: { warn: (m) => void warns.push(m) },
      sleep: async () => undefined,
    });
    await expect(held.hold({ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1" })).rejects.toThrow("ENOSPC");
    await held.verdict(HANDLE, { verdict: "PASS", text: "x" });
    expect(calls).toBe(3);
    expect(warns).toContain("[router] verdict of a result that could not be held was not posted");
  });

  it("the posting record carries the verdict text (QA-2.1-2, R21)", async () => {
    const r = await heldRig();
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "the findings" });
    expect(r.records.find((x) => x.kind === "posting")).toMatchObject({ handle: HANDLE, text: verdictText(HANDLE, CHILD, { verdict: "PASS", text: "the findings" }) });
  });

  it("noteText journals the child text with the hold (hold-text, fsync) and restore hands it back for the gate (QA-2.1-6)", async () => {
    const r = await heldRig();
    await r.held.noteText(HANDLE, "the child said");
    const note = r.records.find((x) => x.kind === "hold-text");
    // QA-2.1-17: the line names the child's status (only a succeeded child's text is ever noted).
    expect(note).toMatchObject({ handle: HANDLE, text: "the child said", status: "succeeded" });
    const next = rig();
    const restored = next.held.restore(r.records);
    expect(restored.reposts).toEqual([]);
    expect(restored.unverified).toEqual([{ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1", childText: "the child said", dispatch: {} }]);
    expect(next.held.isHeld(CHILD)).toBe(true);
  });

  it("QA-2.1-17: restore never hands back the text of a child that did not succeed, and keeps the journaled dispatch data", () => {
    const r = rig();
    const dispatch = { prompt: "write src/a.ts", description: "write a", subagentType: "fast", cwd: "/repo", workRoot: "/repo/wt", ignored: 7 };
    const restored = r.held.restore([
      { v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1", dispatch },
      { v: 1, kind: "hold-text", handle: HANDLE, text: "partial text of a failed child", status: "failed" },
    ]);
    expect(restored.unverified).toEqual([{
      handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1",
      dispatch: { prompt: "write src/a.ts", description: "write a", subagentType: "fast", cwd: "/repo", workRoot: "/repo/wt" },
    }]);
  });

  it("QA-2.1-17: a verdict the gate reached before the restart (a `verified` state record) is handed back with the hold", () => {
    const r = rig();
    const restored = r.held.restore([
      { v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" },
      { v: 1, kind: "hold-text", handle: HANDLE, text: "the child said", status: "succeeded" },
      { v: 1, kind: "state", handle: HANDLE, state: "verified", verdict: { pass: false, outcome: "fail", method: "deterministic", reasons: ["tests failed"], caveats: [] } },
    ]);
    expect(restored.unverified).toEqual([{
      handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, callID: "c1", childText: "the child said", dispatch: {},
      verdict: { verdict: "FAIL", reason: "tests failed" },
    }]);
    expect(storedVerdictOf({ pass: true, outcome: "pass", reasons: [] })).toEqual({ verdict: "PASS" });
    expect(storedVerdictOf({ pass: false, outcome: "unverifiable", reasons: ["gate timed out"] })).toEqual({ verdict: "UNVERIFIABLE", reason: "gate timed out" });
    expect(storedVerdictOf(null)).toBeUndefined();
  });

  it("a restored posting without posted is handed back as a repost; settleRestored(true) records posted without posting (R21)", async () => {
    const r = rig();
    const restored = r.held.restore([
      { v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" },
      { v: 1, kind: "posting", handle: HANDLE, text: "journaled verdict" },
    ]);
    expect(restored.reposts).toEqual([{ handle: HANDLE, parentSessionID: PARENT, childSessionID: CHILD, text: "journaled verdict" }]);
    expect(restored.unverified).toEqual([]);
    // A new verdict for a posting hold never posts a second entry.
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "again" });
    expect(r.posts).toEqual([]);
    await r.held.settleRestored(HANDLE, true);
    expect(r.posts).toEqual([]);
    expect(r.records.map((x) => x.kind)).toEqual(["posted"]);
    expect(r.held.isHeld(CHILD)).toBe(false);
  });

  it("settleRestored(false) re-posts the journaled verdict text, once (R21)", async () => {
    const r = rig();
    r.held.restore([
      { v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" },
      { v: 1, kind: "posting", handle: HANDLE, text: "journaled verdict" },
    ]);
    await r.held.settleRestored(HANDLE, false);
    await r.held.settleRestored(HANDLE, false);
    expect(r.posts.map((p) => p.text)).toEqual(["journaled verdict"]);
    expect(r.records.map((x) => x.kind)).toEqual(["posting", "posted"]);
  });

  it("a posted hold restores as an inactive placeholder: no repost, no gate, the raw completion stays hidden (QA-2.1-10)", () => {
    const r = rig();
    const restored = r.held.restore([
      { v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" },
      { v: 1, kind: "posted", handle: HANDLE },
    ]);
    expect(restored).toEqual({ reposts: [], unverified: [] });
    expect(r.held.isHeld(CHILD)).toBe(false);
    expect(r.held.heldFor(PARENT)).toEqual([]);
    expect(r.held.applyText(PARENT, `<subagent sessionID="${CHILD}" state="completed">raw</subagent>`)).toBe(PH);
  });

  it("a second restore of a known hold never resets it", async () => {
    const r = await heldRig();
    await r.held.verdict(HANDLE, { verdict: "PASS", text: "ok" });
    const again = r.held.restore([{ v: 1, kind: "hold", handle: HANDLE, parent: PARENT, child: CHILD, callID: "c1" }]);
    expect(again).toEqual({ reposts: [], unverified: [] });
    expect(r.held.isHeld(CHILD)).toBe(false);
  });
});

describe("bookkeeping bounds (QA-2.1-13)", () => {
  it("dispose gives back exactly the call claims this instance took; another instance's claims stay", () => {
    const claims = new Set<string>(["bg:foreign"]);
    const logger = { warn: () => undefined };
    const reg = createInFlightRegistry({ now: () => 1, logger, claims });
    expect(reg.decide(callRecord("c1"))).toBe(true);
    expect(reg.decide(callRecord("c2"))).toBe(true);
    expect(claims).toEqual(new Set(["bg:foreign", "bg:c1", "bg:c2"]));
    reg.dispose();
    expect(claims).toEqual(new Set(["bg:foreign"]));
    // A reloaded instance can decide the same calls again.
    const next = createInFlightRegistry({ now: () => 1, logger, claims });
    expect(next.decide(callRecord("c1"))).toBe(true);
  });

  it("forgetSession gives the session's claims back", () => {
    const claims = new Set<string>();
    const reg = createInFlightRegistry({ now: () => 1, logger: { warn: () => undefined }, claims });
    reg.decide(callRecord("c1"));
    reg.decide(callRecord("c2", { parentSessionID: "ses_other" }));
    reg.forgetSession(PARENT);
    expect(claims).toEqual(new Set(["bg:c2"]));
  });

  it("a decision waiting for its acknowledgement counts as live only while fresh and only when it is a background one", () => {
    let t = 1_000_000;
    const reg = createInFlightRegistry({ now: () => t, logger: { warn: () => undefined }, claims: new Set() });
    reg.decide(callRecord("c1", { at: t }));
    reg.decide(callRecord("c2", { at: t, decision: { background: false, hold: false, reason: "estimate" } }));
    expect(reg.liveCount()).toBe(1);
    t += DECIDED_LIVE_MS;
    expect(reg.liveCount()).toBe(1);
    t += 1;
    expect(reg.liveCount()).toBe(0);
  });
});

describe("pure renderers", () => {
  it("renderCompleted / renderHeld / renderInFlight are undefined when empty", () => {
    expect(renderCompleted([])).toBeUndefined();
    expect(renderHeld([])).toBeUndefined();
    expect(renderInFlight([], 0)).toBeUndefined();
  });

  it("renders the completed lines", () => {
    expect(renderCompleted([{ child: "ses_1", label: 'implementer "x"', text: "[router] ok" }])).toBe(
      '[router] Completed since your last turn:\n- implementer "x" (ses_1): [router] ok',
    );
  });

  it("renders the held entries", () => {
    expect(renderHeld([{ handle: "vrf_1", child: "ses_1", label: 'implementer "x"', status: "verifying" }])).toBe(
      '[router] Held for verification — not usable until the verdict:\n- implementer "x" (ses_1) vrf_1: verifying',
    );
  });

  it("renders only acknowledged attempts as in flight, with minutes since the ack", async () => {
    const r = rig();
    const a = await launch(r, "c1", "ses_c1", { rec: { role: "implementer" } });
    const b = await launch(r, "c2", "ses_c2");
    await r.proc.process("ses_c2", completion());
    const text = renderInFlight([a, b], (a.ackAt ?? 0) + 125_000);
    expect(text).toBe(
      [
        "[router] In flight (background): 1",
        '- implementer "task c1" (ses_c1) — 2 min',
        "Do not report the task done while dispatches are listed here.",
      ].join("\n"),
    );
    expect(renderInFlight([a], (a.ackAt ?? 0) - 10_000)).toContain("— 0 min");
  });

  it("attemptLabel normalizes whitespace and prefers the role", () => {
    expect(attemptLabel(callRecord("c", { role: "reviewer", description: "  a\n b  " }))).toBe('reviewer "a b"');
    expect(attemptLabel(callRecord("c", { description: "x" }))).toBe('implementer "x"');
  });

  it("the placeholder is a pure function of the handle and the child", () => {
    expect(heldPlaceholder("vrf_1", "ses_1")).toBe('<subagent sessionID="ses_1" state="held">held — verdict pending (vrf_1)</subagent>');
  });
});
