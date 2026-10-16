/**
 * test/integration/v2-background.test.ts
 *
 * Phase 2.1 (task 2.1.8): background-first dispatch through the real plugin behind the real v2 adapter, driven by the fake host
 * of test/helpers/v2-bg-host.ts (no sleeps: events are queued and drained by microtask turns; what an adoption or a gate
 * starts in the background is awaited with `settled()`, never polled).
 *
 * Held-result scenarios (placeholder stability, refusal of a resume, compaction) start from a hold record in `pending.jsonl`
 * written by a previous process: the reload / adoption path (memo 11.3, R20) is the one a restart takes, and it exercises the
 * same matcher the live path uses.
 *
 * The defects found by 2.1.8 are fixed and pinned by plain tests named "Dn: ...": D2 early end processed at the ack, D3 a failed
 * held child's UNVERIFIABLE verdict posted (a journal that vanishes fails closed until it is recreated from memory, QA-2.1-8, QA-2.1-16), D4 resume by `task_id` of a held child refused, D5 a lost
 * child (empty history) annotated. Verdict posting through the real adapter to a busy and to an idle parent (PASS, FAIL: one
 * `synthetic` with `resume: true`) is tested in "held verdicts posted to the parent" below. Timing rows of the static engine feeding
 * the background decision ("static engine: timing rows…") and the route hint never carrying held output are tested here too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PENDING_RELOAD_RETRY_MS, reloadFailedResumeText } from "../../src/compat/v2-hooks";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

let host: BgHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  restoreEnv();
});

const ORCH = "orch";
const CHILD = "child-1";
const RUNNING = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };

async function boot(mode: "auto" | "model" | "off", more: { sessions?: Record<string, { parentID?: string }>; journalText?: string; home?: string; omitSynthetic?: boolean; omitCompaction?: boolean } = {}): Promise<BgHost> {
  host = await bootBgHost({
    overrides: { routing: { background: { mode }, leases: { mode: "off" } } },
    sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH }, ...(more.sessions ?? {}) },
    ...(more.journalText === undefined ? {} : { journalText: more.journalText }),
    ...(more.home === undefined ? {} : { home: more.home }),
    ...(more.omitSynthetic === true ? { omitSynthetic: true } : {}),
    ...(more.omitCompaction === true ? { omitCompaction: true } : {}),
  });
  return host;
}

let seq = 0;
function dispatch(input: Record<string, unknown>, sessionID = ORCH): ToolEvent {
  seq += 1;
  return { sessionID, agent: "build", messageID: `m${seq}`, id: `call-${seq}`, tool: "subagent", input: { agent: "fast", description: "background work", prompt: "do the work", ...input } };
}

function inputOf(event: ToolEvent): Record<string, unknown> {
  return event.input as Record<string, unknown>;
}

function contextEvent(messages: unknown[], sessionID = ORCH) {
  return {
    sessionID,
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
    options: {},
    system: [{ type: "text", text: "Host instructions" }],
    messages,
    tools: {},
  };
}

const user = (text: string) => ({ id: "m-user", role: "user", content: [{ type: "text", text }] });
// QA-DF1-20: the host gives every message its own id (the adapter tells completion elements apart by it, never by content).
let completionSeq = 0;
const completion = (child: string, body: string) => ({
  id: `m-completion-${++completionSeq}`,
  role: "user",
  content: [{ type: "text", text: `<subagent sessionID="${child}" state="completed">${body}</subagent>` }],
});

async function request(h: BgHost, messages: unknown[]): Promise<{ messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }> {
  const event = contextEvent(messages);
  await h.context(event);
  return event as unknown as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
}

function allText(event: { messages: Array<{ content: Array<{ text?: string }> }> }): string {
  return event.messages.flatMap((m) => m.content.map((p) => p.text ?? "")).join("\n---\n");
}

function tail(event: { messages: Array<{ role: string; content: Array<{ text?: string }> }> }): string {
  const last = event.messages[event.messages.length - 1];
  const text = last?.content[0]?.text;
  if (text === undefined || !text.startsWith("<router-state>")) throw new Error("no turn-state tail");
  return text;
}

function created(child: string, parent: string): unknown {
  return { type: "session.created", id: `ev-created-${child}`, created: 1, data: { sessionID: child, parentID: parent } };
}

function ended(child: string, kind: "succeeded" | "failed" | "interrupted" = "succeeded"): unknown {
  return { type: `session.execution.${kind}`, id: `ev-end-${child}-${kind}`, created: 2, data: { sessionID: child } };
}

/** QA-2.1-18: the child's last assistant message ended its step (a finish reason and a completed time): it is an end. */
function childSays(h: BgHost, child: string, text: string): void {
  h.childContext.set(child, [{ role: "assistant", content: [{ type: "text", text }], finish: "stop", time: { created: 1, completed: 2 } }]);
}

/** QA-2.1-18: the child was cut mid-step: partial text, no finish reason, no completed time. */
function childCutMidStep(h: BgHost, child: string, text: string): void {
  h.childContext.set(child, [{ role: "assistant", content: [{ type: "text", text }], time: { created: 1 } }]);
}

function holdJournal(handle: string, child: string, callID: string): string {
  return `${JSON.stringify({ v: 1, kind: "hold", handle, parent: ORCH, child, callID, at: 1 })}\n`;
}

const HANDLE = "vrf_0123456789abcdef01234567";

async function reboot(mode: "auto" | "model" | "off"): Promise<BgHost> {
  await host?.dispose();
  host = undefined;
  restoreEnv();
  return boot(mode);
}

describe("off: byte-identical dispatch arguments", () => {
  it("a verified tier dispatch gets today's background:false under off, auto (thin store) and model: identical input JSON", async () => {
    const inputs: string[] = [];
    for (const mode of ["off", "auto", "model"] as const) {
      const h = await reboot(mode);
      const plain = await h.before(dispatch({}));
      expect(inputOf(plain).background, mode).toBe(false); // verifying => false, as before the phase
      // The dispatch prompt names the host's working directory (different per boot): normalize it.
      inputs.push(JSON.stringify(inputOf(plain)).split(h.project.replace(/\\/g, "\\\\")).join("<project>"));
    }
    expect(new Set(inputs).size).toBe(1);
  });

  it("under off an explicit true survives and the ack text is untouched", async () => {
    const h = await boot("off");
    const explicit = await h.before(dispatch({ background: true }));
    expect(inputOf(explicit).background).toBe(false); // verifying tier call: the legacy rewrite, unchanged by the phase
    const ack = await h.after({ ...explicit, status: "completed", result: structuredClone(RUNNING) });
    expect(JSON.stringify(ack.result)).not.toContain("Running in the background");
    expect(JSON.stringify(ack.result)).not.toContain("Router guarantees");
  });

  it("under off the context hook adds no background state and leaves completions alone", async () => {
    const h = await boot("off");
    const body = `<subagent sessionID="${CHILD}" state="completed">some result</subagent>`;
    const event = await request(h, [user("hello"), { id: "m2", role: "user", content: [{ type: "text", text: body }] }]);
    expect(allText(event)).toContain("some result");
    expect(allText(event)).not.toContain("In flight");
    expect(allText(event)).not.toContain("Completed since your last turn");
  });
});

describe("auto with a thin store", () => {
  it("an explicit background:false stays false", async () => {
    const h = await boot("auto");
    const event = await h.before(dispatch({ background: false }));
    expect(inputOf(event).background).toBe(false);
  });

  it("an explicit background:true on a verified call is sent as true (held until verification)", async () => {
    const h = await boot("auto");
    const event = await h.before(dispatch({ background: true }));
    expect(inputOf(event).background).toBe(true);
  });

  it("without holding (no session.synthetic) an explicit true on a verified call stays in the foreground", async () => {
    const h = await boot("auto", { omitSynthetic: true });
    const call = await h.before(dispatch({ background: true }));
    expect(inputOf(call).background).toBe(false);
  });
});

describe("background dispatch: acknowledgement, in-flight list, completion annotation", () => {
  it("an explicit background dispatch is acknowledged, listed in flight, and its completion is annotated in the next tail", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    expect(inputOf(call).background).toBe(true);
    const ack = await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    // A tier dispatch is verified (required), so the ack says its result is held until verification finishes.
    expect(JSON.stringify(ack.result)).toContain(`[router] Running in the background (${CHILD}). Its result is held until verification finishes.`);

    const during = await request(h, [user("continue")]);
    expect(tail(during)).toContain("[router] Held for verification — not usable until the verdict:");
    expect(tail(during)).toContain("[router] In flight (background): 1");
    expect(tail(during)).toContain(`(${CHILD})`);
    expect(tail(during)).toContain("Do not report the task done while dispatches are listed here.");

    childSays(h, CHILD, "all done");
    h.emit(ended(CHILD));
    await h.drain();

    const after = await request(h, [user("continue"), completion(CHILD, "all done")]);
    const state = tail(after);
    // Processed once: no longer in flight. The result stays held (placeholder, never the child's text) until its verdict.
    expect(state).not.toContain("In flight (background)");
    expect(state).toContain("[router] Held for verification — not usable until the verdict:");
    expect(allText(after)).not.toContain("all done");
    expect(allText(after)).toContain('state="held"');
  });

  // Real OpenCode 2 shapes (smoke cpx-background): `ctx.session.context(child)` entries are discriminated by `type`, not `role`.
  it("the child's result is read from a host context entry typed `assistant` (no `role`): the end event completes the processing", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    // The root request that teaches the adapter the parent is a root; the attempt is listed in flight before its end event.
    const before = await request(h, [user("continue")]);
    expect(allText(before)).toContain("In flight (background): 1");
    h.childContext.set(CHILD, [
      { type: "user", id: "m1", content: [{ type: "text", text: "do the work" }] },
      { type: "assistant", id: "m2", content: [{ type: "text", text: "real host result" }] },
    ]);
    // A unique event id: the adapter drops an end event id it has already seen in this process.
    h.emit({ type: "session.execution.succeeded", id: "ev-end-typed-assistant", created: 2, data: { sessionID: CHILD } });
    await h.drain();
    // The end handler awaits the timing store before it starts the processor: poll until the attempt left the in-flight list.
    // G-16: the whole context is checked, as in QA-2.1-21: once the processing settled there may be no turn-state tail at all
    // (`tail()` threw then, so the poll only passed when it caught a tail before that; on Linux CI it never did).
    await vi.waitFor(async () => {
      const state = allText(await request(h, [user("continue")]));
      expect(state).not.toContain("In flight (background)");
      expect(state).not.toContain("router guarantees pending");
    }, { timeout: 5000, interval: 50 });
    // The settled outcome: the held attempt's verdict, posted to the parent, carries the text read from the typed `assistant`
    // entry (as in DF-1-4, the verdict entry quotes the child's answer). The processor journals and runs the gate before it posts.
    const verdicts = (): string[] => h.synthetic.filter((s) => s.text.startsWith("<router-verdict ")).map((s) => s.text);
    await vi.waitFor(() => expect(verdicts()).toHaveLength(1), { timeout: 20_000 });
    expect(verdicts()[0]).toContain("real host result");
  }, 60_000);

  it("QA-2.1-21: the processing an end event starts is tracked: settled() (and dispose) wait for it, no polling", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("continue")]); // the root request that teaches the adapter the parent is a root
    h.childContext.set(CHILD, [{ type: "assistant", id: "m2", content: [{ type: "text", text: "tracked result" }] }]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-tracked", created: 2, data: { sessionID: CHILD } });
    await h.settled();
    // Once the processing settled there is nothing left to report: the whole context is checked (no turn-state tail at all is
    // the expected outcome, so `tail()` would throw).
    const text = allText(await request(h, [user("continue")]));
    expect(text).not.toContain("In flight (background)");
    expect(text).not.toContain("router guarantees pending");
    expect(text).not.toContain("verifying");
  });

  it("a completion element with further attributes still completes a child whose context could not be read", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    h.emit(ended(CHILD)); // empty child context: nothing readable at the end event
    await h.drain();
    const body = `<subagent sessionID="${CHILD}" state="completed" agent="fast">late result</subagent>`;
    await request(h, [user("continue"), { id: "m3", role: "user", content: [{ type: "text", text: body }] }]);
    await h.drain();
    const state = tail(await request(h, [user("continue")]));
    expect(state).not.toContain("router guarantees pending");
  });

  // D2: with the child's end event delivered BEFORE the host's running acknowledgement, the parked end is processed at the ack
  // (memo §4.3 step 2, R3), as in the ack -> end order above.
  it("D2: an end event seen before the acknowledgement is processed at the ack (R3)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    childSays(h, CHILD, "fast result");
    h.emit(ended(CHILD));
    await h.drain();
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    await h.drain();
    const after = await request(h, [user("continue")]);
    expect(tail(after)).not.toContain("In flight (background)");
  });

  it("a user-backgrounded call (no background argument) is verified at completion: held at the ack, processed at the end (P3)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({}));
    expect(inputOf(call).background).toBe(false); // the router sent a foreground call; the user backgrounded it while it ran
    const ack = await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    expect(JSON.stringify(ack.result)).toContain("Its result is held until verification finishes");
    const during = await request(h, [user("go on")]);
    expect(tail(during)).toContain("In flight (background): 1");
    childSays(h, CHILD, "done later");
    h.emit(ended(CHILD));
    await h.drain();
    const after = await request(h, [user("go on"), completion(CHILD, "done later")]);
    expect(tail(after)).not.toContain("In flight (background)");
    expect(allText(after)).not.toContain("done later");
  });

  it("a parent interrupt does not drop the in-flight child (R8)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    h.emit(ended(ORCH, "interrupted"));
    await h.drain();
    const state = tail(await request(h, [user("again")]));
    expect(state).toContain("[router] In flight (background): 1");
  });

  // D3: a held child that ENDED FAILED gets an UNVERIFIABLE verdict entry (completion processor, memo 4.7 step 7).
  it("D3: a failed held child gets an UNVERIFIABLE verdict entry posted to the parent (R9)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    childSays(h, CHILD, "partial work");
    h.emit(ended(CHILD, "failed"));
    await h.drain();
    // The processor journals (file I/O) before it posts, which microtask turns alone do not cover.
    await vi.waitFor(() => expect(h.synthetic.filter((s) => s.text.startsWith("<router-verdict "))).toHaveLength(1));
    const verdicts = h.synthetic.filter((s) => s.text.startsWith("<router-verdict "));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.text).toContain('verdict="UNVERIFIABLE"');
    expect(verdicts[0]?.resume).toBe(true);
  });

  it("a failed held child is processed once: it leaves the in-flight list", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    childSays(h, CHILD, "partial work");
    h.emit(ended(CHILD, "failed"));
    await h.drain();
    const state = tail(await request(h, [user("again"), completion(CHILD, "partial work")]));
    expect(state).not.toContain("In flight (background)");
  });

  it("a foreground (completed) subagent result is never processed as a background completion (R5)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({}));
    await h.after({ ...call, status: "completed", result: { output: { sessionID: CHILD, status: "completed", output: "inline result" }, content: [{ type: "text", text: "inline result" }], metadata: { sessionID: CHILD } } });
    h.emit(ended(CHILD));
    await h.drain();
    const event = await request(h, [user("again")]);
    expect(allText(event)).not.toContain("Completed since your last turn");
    expect(allText(event)).not.toContain("In flight");
  });

  it("a dispatch whose call errored is dropped and never listed", async () => {
    const h = await boot("auto");
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "error", error: new Error("host failure") });
    const event = await request(h, [user("again")]);
    expect(allText(event)).not.toContain("In flight");
  });
});

describe("QA-DF1 round 2: the completion elements of a resumed background dispatch", () => {
  const verdicts = (h: BgHost): string[] => h.synthetic.filter((s) => s.text.startsWith("<router-verdict ")).map((s) => s.text);
  const say = (text: string) => ({ type: "assistant", content: [{ type: "text", text }], finish: "stop", time: { created: 1, completed: 2 } });
  const ask = (text: string) => ({ type: "user", content: [{ type: "text", text }] });

  it("QA-DF1-17: an element scanned while turn 1 is processing is never taken by the resumed attempt", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const first = await h.before(dispatch({ background: true }));
    await h.after({ ...first, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("start")]);
    // Turn 1's end starts its processing; its read of the child's history waits on a gate: the attempt stays `processing`.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = h.childContext.get.bind(h.childContext);
    let gated = true;
    const spy = vi.spyOn(h.childContext, "get").mockImplementation((sessionID: string) => {
      if (sessionID !== CHILD || !gated) return read(sessionID);
      gated = false;
      return gate.then(() => read(sessionID)) as unknown as unknown[];
    });
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: turn one")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa17-turn-1", created: 2, data: { sessionID: CHILD } });
    await vi.waitFor(() => expect(gated).toBe(false), { timeout: 20_000 });
    // The parent's wake request carries turn 1's element while turn 1 is still processing (seen, not remembered).
    const turnOne = completion(CHILD, "NEED MORE: turn one");
    await request(h, [user("start"), turnOne]);
    // Turn 1's processing ends (its verdict posted, its hold released: a held child cannot be resumed before) with no request
    // of the parent since that scan: the parent's history still holds turn 1's element, never remembered.
    release();
    await h.settled();
    spy.mockRestore();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(1), { timeout: 20_000 });
    const posted = verdicts(h).length;
    // The resume is decided now.
    const second = await h.before(dispatch({ background: true, sessionID: CHILD, prompt: "resume prompt" }));
    await h.after({ ...second, status: "completed", result: structuredClone(RUNNING) });
    // The next request still carries turn 1's element: the resumed attempt never takes it (pre-fix: turn 1's text was its answer).
    await request(h, [user("start"), turnOne, user("resumed")]);
    await h.settled();
    expect(verdicts(h)).toHaveLength(posted);
    // The resumed turn's own end delivers its own answer.
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: turn one"), ask("resume prompt"), say("DONE: turn two")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa17-turn-2", created: 3, data: { sessionID: CHILD } });
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(posted + 1), { timeout: 20_000 });
    expect(verdicts(h).at(-1)).toContain("DONE: turn two");
    expect(verdicts(h).slice(posted).join("\n")).not.toContain("NEED MORE: turn one");
    // Every wait above is on a condition; two processed turns with fsync'd journal and verdict writes exceed 5 s on a slow CI disk.
  }, 30_000);

  it("QA-DF1-20: an attempt its end left `child-ended` is read again on the parent's next request, with no new completion element", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const first = await h.before(dispatch({ background: true }));
    await h.after({ ...first, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("start")]);
    // The end comes before the turn's answer is readable: the attempt is left `child-ended`.
    h.childContext.set(CHILD, [ask("do the work")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa20-reread", created: 2, data: { sessionID: CHILD } });
    await h.settled();
    expect(verdicts(h)).toHaveLength(0);
    // The answer is readable now; the parent's next request carries no element that is new to this adapter (pre-fix: the sweep).
    h.childContext.set(CHILD, [ask("do the work"), say("DONE: read again")]);
    await request(h, [user("start"), user("next")]);
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(1), { timeout: 3_000 }); // within the test's 5 s: a failure is this assertion
    expect(verdicts(h)[0]).toContain("DONE: read again");
  });

  it("QA-DF1-20: two turns with the byte-identical answer \"NEED MORE: budget\" each deliver exactly one verdict", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const first = await h.before(dispatch({ background: true }));
    await h.after({ ...first, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("start")]);
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: budget")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa20-turn-1", created: 2, data: { sessionID: CHILD } });
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(1), { timeout: 20_000 });
    const turnOne = completion(CHILD, "NEED MORE: budget");
    await request(h, [user("start"), turnOne]);
    await h.settled();

    const second = await h.before(dispatch({ background: true, sessionID: CHILD, prompt: "resume prompt" }));
    await h.after({ ...second, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("start"), turnOne, user("resumed")]);
    await h.settled();
    // The resumed turn's end comes before its answer is readable: the attempt is left `child-ended`.
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: budget"), ask("resume prompt")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa20-turn-2", created: 3, data: { sessionID: CHILD } });
    await h.settled();
    expect(verdicts(h)).toHaveLength(1);
    // The resumed turn's completion element carries the very bytes of turn 1's: it is a new element all the same. The child's
    // history is left without the answer, so only the element (never the `child-ended` re-read) can deliver this verdict.
    const turnTwo = completion(CHILD, "NEED MORE: budget");
    await request(h, [user("start"), turnOne, user("resumed"), turnTwo]);
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(2), { timeout: 3_000 }); // within the test's 5 s: a failure is this assertion
    await request(h, [user("start"), turnOne, user("resumed"), turnTwo, user("again")]);
    await h.settled();
    expect(verdicts(h)).toHaveLength(2);
  });
});

describe("QA-DF1-23 (DF-1-9): the background decision for a parent the plugin never recorded (finish API attached: bgActive)", () => {
  const UNRECORDED = "u1";
  const bootUnrecorded = () => boot("auto", { sessions: { [UNRECORDED]: { parentID: ORCH } } }); // no `session.created` for u1

  // D1 row 2 (`!parentIsRoot`) answers the pre-2.1 value: for a tier dispatch that is the model's own flag (`nativeArgs` keeps
  // it), never a router-made `background: true` from the explicit or `auto` rows. The value a recorded child gets is the reference.
  const RECORDED = "r1";
  const valueOf = async (h: BgHost, parent: string, explicit: boolean | undefined): Promise<unknown> =>
    inputOf(await h.before(dispatch({ agent: "fast", ...(explicit === undefined ? {} : { background: explicit }) }, parent))).background;

  it("QA-DF1-23 a tier (non-role) dispatch from an unrecorded child stays foreground: a recorded child's value (guard)", async () => {
    const h = await boot("auto", { sessions: { [UNRECORDED]: { parentID: ORCH }, [RECORDED]: { parentID: ORCH } } });
    h.emit(created(RECORDED, ORCH));
    await h.drain();
    expect(await valueOf(h, UNRECORDED, undefined)).not.toBe(true);
    for (const explicit of [undefined, true, false]) {
      expect(await valueOf(h, UNRECORDED, explicit)).toBe(await valueOf(h, RECORDED, explicit));
    }
  });

  it("QA-DF1-23 a failed session lookup keeps the foreground value: a recorded child's value (guard)", async () => {
    const h = await boot("auto", { sessions: { [UNRECORDED]: { parentID: ORCH }, [RECORDED]: { parentID: ORCH } } });
    h.emit(created(RECORDED, ORCH));
    await h.drain();
    h.failingSessionLookups.add(UNRECORDED);
    expect(await valueOf(h, UNRECORDED, undefined)).not.toBe(true); // `unknown` is no root
    for (const explicit of [undefined, true]) {
      expect(await valueOf(h, UNRECORDED, explicit)).toBe(await valueOf(h, RECORDED, explicit));
    }
  });

  it("QA-DF1-23 an unrecorded parent costs exactly one session.get, however many dispatches", async () => {
    const h = await bootUnrecorded();
    const lookups = vi.spyOn(h.sessions, "get");
    for (let i = 0; i < 3; i++) await h.before(dispatch({ background: true }, UNRECORDED));
    expect(lookups.mock.calls.filter(([id]) => id === UNRECORDED)).toHaveLength(1);
  });
});

describe("DF-1-4 a resumed background dispatch", () => {
  const verdicts = (h: BgHost): string[] => h.synthetic.filter((s) => s.text.startsWith("<router-verdict ")).map((s) => s.text);
  const say = (text: string) => ({ type: "assistant", content: [{ type: "text", text }], finish: "stop", time: { created: 1, completed: 2 } });
  const ask = (text: string) => ({ type: "user", content: [{ type: "text", text }] });

  it("DF-1-4 the resume never takes the previous turn's completion element or answer; its own end delivers one verdict with its answer", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    // Turn 1: dispatched in the background, ended, verdict posted, completion element in the parent's history.
    const first = await h.before(dispatch({ background: true }));
    await h.after({ ...first, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("start")]); // the root request that teaches the adapter the parent is a root
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: turn one")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-df14-turn-1", created: 2, data: { sessionID: CHILD } });
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(1), { timeout: 20_000 });
    const turnOne = completion(CHILD, "NEED MORE: turn one");
    await request(h, [user("start"), turnOne]);
    await h.settled();

    // Turn 2: the resume of the same child, in the background, with a new prompt.
    const second = await h.before(dispatch({ background: true, sessionID: CHILD, prompt: "resume prompt" }));
    await h.after({ ...second, status: "completed", result: structuredClone(RUNNING) });
    // The parent's next request still carries turn 1's completion element: it is not the resume's.
    await request(h, [user("start"), turnOne, user("resumed")]);
    await h.settled();
    // An end met while the resumed turn has no answer yet: turn 1's answer is never read for it.
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: turn one"), ask("resume prompt")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-df14-early", created: 3, data: { sessionID: CHILD } });
    await h.settled();
    expect(verdicts(h)).toHaveLength(1);

    // The resumed turn's own end delivers exactly one verdict, with its answer.
    h.childContext.set(CHILD, [ask("do the work"), say("NEED MORE: turn one"), ask("resume prompt"), say("DONE: turn two")]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-df14-turn-2", created: 4, data: { sessionID: CHILD } });
    await h.settled();
    await vi.waitFor(() => expect(verdicts(h)).toHaveLength(2), { timeout: 20_000 });
    expect(verdicts(h)[1]).toContain("DONE: turn two");
    expect(verdicts(h)[1]).not.toContain("turn one");
    await request(h, [user("start"), turnOne, user("resumed"), completion(CHILD, "DONE: turn two")]);
    await h.settled();
    expect(verdicts(h)).toHaveLength(2);
  }, 60_000);
});

describe("held results across a restart (R20): placeholder, refusal, compaction", () => {
  const original = `<subagent sessionID="${CHILD}" state="completed">SECRET held output</subagent>`;

  it("the placeholder replaces the held completion on the first request and is identical across 3 requests", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    const messages = () => [user("hello"), { id: "m-completion", role: "user", content: [{ type: "text", text: original }] }];
    const texts: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const event = await request(h, messages());
      const text = allText(event);
      expect(text).not.toContain("SECRET");
      expect(text).toContain(`<subagent sessionID="${CHILD}" state="held">held — verdict pending (${HANDLE})</subagent>`);
      texts.push(event.messages[1]?.content[0]?.text ?? "");
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("the held entry appears in the turn-state tail as held, not usable until the verdict", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    const event = await request(h, [user("hello")]);
    expect(tail(event)).toContain("[router] Held for verification — not usable until the verdict:");
    expect(tail(event)).toContain(HANDLE);
  });

  it("the held output never leaks through the route hint or any other part of the tail", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    childSays(h, CHILD, "SECRET held output");
    const messages = [user("[route class=implement risk=low scope=single]\nimplement it"), { id: "m-completion", role: "user", content: [{ type: "text", text: original }] }];
    for (let i = 0; i < 2; i += 1) {
      const event = await request(h, messages.map((m) => structuredClone(m)));
      expect(tail(event)).not.toContain("SECRET");
      expect(allText(event)).not.toContain("SECRET");
    }
  });

  it("a resume of a held child is refused before anything runs", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    await request(h, [user("hello")]); // the first request of the parent adopts its records
    await expect(h.before(dispatch({ sessionID: CHILD }))).rejects.toThrow(`[router] Refused: session ${CHILD} is held for verification (${HANDLE}).`);
  });

  // D4: HeldResults.refusal honours `task_id`; execute.before hands it the raw input, not the scoped arguments.
  it("D4: a resume of a held child by task_id is refused", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    await request(h, [user("hello")]);
    await expect(h.before(dispatch({ task_id: CHILD }))).rejects.toThrow(/held for verification/);
  });

  it("a Code Mode execute that names a held child is refused", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    await request(h, [user("hello")]);
    seq += 1;
    const code: ToolEvent = { sessionID: ORCH, agent: "build", messageID: `m${seq}`, id: `call-${seq}`, tool: "execute", input: { code: `return await tools.opencode.subagent({ sessionID: "${CHILD}", prompt: "x" })` } };
    await expect(h.before(code)).rejects.toThrow(/held for verification/);
  });

  it("another session never adopts the held record, so nothing is redacted for it", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old"), sessions: { other: {} } });
    const event = contextEvent([user("hello"), { id: "m2", role: "user", content: [{ type: "text", text: original }] }], "other");
    await h.context(event);
    expect(allText(event as unknown as { messages: Array<{ content: Array<{ text?: string }> }> })).toContain("SECRET");
  });

  it("the compaction hook redacts the held completion in the messages being summarised", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-old") });
    const compaction = h.sessionHooks.compaction;
    if (compaction === undefined) throw new Error("no compaction hook");
    const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: "earlier" }] }, { id: "m2", role: "user", content: [{ type: "text", text: original }] }];
    await compaction({ sessionID: ORCH, messages } as never);
    expect(JSON.stringify(messages)).not.toContain("SECRET");
    expect(JSON.stringify(messages)).toContain(`held — verdict pending (${HANDLE})`);
    expect(messages[0]?.content[0]?.text).toBe("earlier");
  });

  // QA-2.1-6 (R20): a restored hold owes a verdict. With no child text and no open dispatch record nothing can be verified: it
  // ends UNVERIFIABLE at adoption, posted once with resume: true, and its placeholder stays (the raw completion stays hidden).
  it("QA-2.1-6: a restored hold without child text ends UNVERIFIABLE once at adoption; the placeholder stays", async () => {
    const h = await boot("auto", { journalText: holdJournal(HANDLE, CHILD, "call-restored") });
    await request(h, [user("hello")]); // the first request of the parent adopts its records
    // Adoption settles the restored hold in the background (history read, journal appends, post): awaited, not polled.
    await h.settled();
    const verdicts = () => h.synthetic.filter((s) => s.text.startsWith(`<router-verdict handle="${HANDLE}"`));
    expect(verdicts()).toHaveLength(1);
    expect(verdicts()[0]?.text).toContain('verdict="UNVERIFIABLE"');
    expect(verdicts()[0]?.resume).toBe(true);
    const event = await request(h, [user("again"), { id: "m-completion", role: "user", content: [{ type: "text", text: original }] }]);
    expect(allText(event)).not.toContain("SECRET");
    // The hold is settled, so nothing lists it as held: with nothing else to say the turn state is empty (no tail at all), and
    // whatever the request carries, tail included, never names it.
    expect(allText(event)).not.toContain("Held for verification");
    await h.settled();
    expect(verdicts()).toHaveLength(1);
  });

  // QA-2.1-2 (R21): a `posting` without `posted` is posted again with its journaled text, unless the parent already shows it.
  it("QA-2.1-2: a journaled posting without posted is re-posted with its journaled text, once", async () => {
    const text = `<router-verdict handle="${HANDLE}" sessionID="${CHILD}" verdict="PASS">\njournaled verdict\n</router-verdict>`;
    const journal = `${holdJournal(HANDLE, CHILD, "call-repost")}${JSON.stringify({ v: 1, kind: "posting", handle: HANDLE, text, at: 2 })}\n`;
    const h = await boot("auto", { journalText: journal });
    await request(h, [user("hello")]);
    await h.settled();
    expect(h.synthetic.filter((s) => s.text === text)).toHaveLength(1);
    await request(h, [user("again")]);
    await h.settled();
    expect(h.synthetic.filter((s) => s.text.includes(HANDLE))).toHaveLength(1);
    expect(readFileSync(h.journalPath, "utf8")).toContain(`"kind":"posted","handle":"${HANDLE}"`);
  });

  it("QA-2.1-2: a posting the parent's history already carries (metadata.router.handle) is recorded as posted, not posted again", async () => {
    const text = `<router-verdict handle="${HANDLE}" sessionID="${CHILD}" verdict="FAIL">\nfindings\n</router-verdict>`;
    const journal = `${holdJournal(HANDLE, CHILD, "call-seen")}${JSON.stringify({ v: 1, kind: "posting", handle: HANDLE, text, at: 2 })}\n`;
    const h = await boot("auto", { journalText: journal });
    h.childContext.set(ORCH, [{ type: "synthetic", text, metadata: { router: { kind: "held-verdict", handle: HANDLE, child: CHILD } } }]);
    await request(h, [user("hello")]);
    await h.settled();
    expect(readFileSync(h.journalPath, "utf8")).toContain(`"kind":"posted","handle":"${HANDLE}"`);
    expect(h.synthetic.filter((s) => s.text.includes(HANDLE))).toEqual([]);
  });

  it("without the compaction hook holding is unavailable: a verified explicit background call stays in the foreground", async () => {
    const h = await boot("auto", { omitCompaction: true });
    const call = await h.before(dispatch({ background: true }));
    expect(inputOf(call).background).toBe(false);
  });
});

describe("held verdicts posted to the parent (memo 5, 7.3)", () => {
  // The gate settles behind `finish` and hands its verdict to the held store through the sink the adapter gave the plugin
  // (`h.heldSink`); the store posts ONE `synthetic` entry with `resume: true`. The fake host delivers it as a steer to a parent
  // that is mid-turn (busy) and as exactly one wake to a parent that is idle.
  for (const verdict of ["PASS", "FAIL"] as const) {
    for (const parent of ["busy", "idle"] as const) {
      it(`a ${verdict} verdict is posted once to a ${parent} parent`, async () => {
        const h = await boot("auto");
        h.emit(created(CHILD, ORCH));
        const call = await h.before(dispatch({ background: true }));
        await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
        const handle = /vrf_[0-9a-f]{24}/.exec(tail(await request(h, [user("go on")])))?.[0];
        expect(handle).toBeDefined();
        h.setBusy(ORCH, parent === "busy");
        await h.heldSink.verdict(handle ?? "", { verdict, text: `the ${verdict} result` });
        await h.drain();
        expect(h.synthetic).toHaveLength(1);
        const posted = h.synthetic[0];
        expect(posted?.text).toContain(`<router-verdict handle="${handle}" sessionID="${CHILD}" verdict="${verdict}">`);
        expect(posted?.text).toContain(`the ${verdict} result`);
        expect(posted?.sessionID).toBe(ORCH);
        expect(posted?.resume).toBe(true);
        expect(posted?.delivery).toBe(parent === "busy" ? "steer" : "wake");
        expect(h.deliveries).toEqual({ steer: parent === "busy" ? 1 : 0, wake: parent === "busy" ? 0 : 1 });
        // The hold is released: the placeholder stays, the tail no longer lists the child as held.
        expect(tail(await request(h, [user("go on")]))).not.toContain("Held for verification");
        // A second verdict for the same handle posts nothing more.
        await h.heldSink.verdict(handle ?? "", { verdict, text: "again" });
        expect(h.synthetic).toHaveLength(1);
      });
    }
  }
});

describe("static engine: timing rows feed the background decision", () => {
  /** A dispatch with the route marker of a fixed class, so every call lands on one duration key. */
  const SLOW = "[route class=implement risk=low scope=single]\nImplement the feature in src/a.ts";
  const SLOW_MS = 60_000;

  async function oneSlowDispatch(h: BgHost, n: number, durationMs: number): Promise<ToolEvent> {
    const child = `slow-${n}`;
    h.sessions.set(child, { parentID: ORCH });
    h.emit(created(child, ORCH));
    const call = await h.before(dispatch({ prompt: SLOW, background: false }));
    // The timing clock starts at execute.before (the host's wall clock); the end event carries the child's end time.
    await h.after({ ...call, status: "completed", result: { output: { sessionID: child, status: "completed", output: "done" }, content: "done", metadata: { sessionID: child } } });
    h.emit({ type: "session.execution.succeeded", id: `ev-slow-${n}`, created: Date.now() + durationMs, data: { sessionID: child } });
    // G-20: the end event's timing row reaches the duration model only after the timing store's (fsync'd) write, which the
    // adapter tracks as background work (v2-hooks.ts, QA-2.1-21). `drain` only spins bounded microtask turns, so on a slow
    // runner disk the 5th row was not observed yet when the next dispatch was decided; `settled` waits for that write.
    await h.settled();
    return call;
  }

  it("after 5 sampled rows of one key with p50 >= 45 s the next dispatch of that key goes to the background", async () => {
    host = await bootBgHost({
      overrides: { routing: { engine: "static", background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {} },
    });
    const h = host;
    h.emit({ type: "session.created", id: "ev-created-root", created: 1, data: { sessionID: ORCH } });
    for (let n = 1; n <= 4; n += 1) await oneSlowDispatch(h, n, SLOW_MS);
    // Control: 4 rows are below the 5-sample minimum, so the estimate is still the prior and the call stays in the foreground.
    expect(inputOf(await h.before(dispatch({ prompt: SLOW }))).background).toBe(false);
    await oneSlowDispatch(h, 5, SLOW_MS);
    const next = await h.before(dispatch({ prompt: SLOW }));
    expect(inputOf(next).background).toBe(true);
    // Six dispatches, each with fsync'd journal and timing writes: over the 5 s default under a 14-worker scoped run.
  }, 30_000);
});

describe("a restart between the ack and the end (R18)", () => {
  it("an inflight record without processed is recovered when its parent is seen: finished -> processed", async () => {
    const journal = `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000call-old`, callID: "call-old", parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
    const h = await boot("auto", { journalText: journal });
    childSays(h, CHILD, "finished while we were down");
    await request(h, [user("hello")]);
    await h.drain();
    const state = tail(await request(h, [user("hello")]));
    expect(state).toContain("[router] Completed since your last turn:");
  });

  // D5: an adopted `inflight` record whose child has an EMPTY history (lost, R18) ends annotated "[router] the dispatch was lost
  // in a restart" and shows in the tail, like the same record with a finished child (previous test).
  it("D5: a lost child (no result in its history) is annotated as lost in the restart", async () => {
    // A call id of its own: the in-flight registry's `bg:<callID>` claims are process-wide, and the test above already took call-old.
    const journal = `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000call-lost`, callID: "call-lost", parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
    const h = await boot("auto", { journalText: journal });
    await request(h, [user("hello")]);
    await h.drain();
    // The recovery reads the child's history and journals before it annotates (file I/O): a later request carries the line.
    await vi.waitFor(async () => {
      expect(allText(await request(h, [user("hello")]))).toContain("the dispatch was lost in a restart");
    });
  });

  // QA-2.1-6: a lost dispatch without a hold wakes its parent with exactly one `resume: true` entry, whichever hook or event saw
  // the parent first, and however often the parent is seen afterwards.
  it("a lost non-held child wakes its parent once with resume: true (QA-2.1-6)", async () => {
    const journal = `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000call-wake`, callID: "call-wake", parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
    const h = await boot("auto", { journalText: journal });
    await request(h, [user("hello")]);
    await h.drain();
    const lostWakes = () => h.synthetic.filter((s) => s.resume === true && s.sessionID === ORCH && s.text.includes("was lost in a restart"));
    await vi.waitFor(() => {
      expect(lostWakes()).toHaveLength(1);
    });
    await request(h, [user("hello again")]);
    h.emit(created("child-unrelated", ORCH));
    await h.drain();
    expect(lostWakes()).toHaveLength(1);
    expect(lostWakes()[0]?.metadata).toMatchObject({ router: { kind: "lost-dispatch", child: CHILD, callID: "call-wake" } });
  });

  // QA-2.1-6: a child that ended with an error while the process was down is recovered as failed, not as a success.
  it("a recovered child whose last message is an error is processed as failed, with no lost wake (QA-2.1-6)", async () => {
    const journal = `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000call-err`, callID: "call-err", parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
    const h = await boot("auto", { journalText: journal });
    h.childContext.set(CHILD, [{ type: "assistant", role: "assistant", error: { name: "ProviderError", message: "rate limited" }, content: [{ type: "text", text: "half done" }] }]);
    await request(h, [user("hello")]);
    await h.drain();
    await vi.waitFor(async () => {
      expect(tail(await request(h, [user("hello")]))).toContain("[router] Completed since your last turn:");
    });
    expect(h.synthetic.filter((s) => s.text.includes("was lost in a restart"))).toEqual([]);
  });
});

describe("the pending journal fails under a held dispatch (QA-2.1-3, QA-2.1-8)", () => {
  it("QA-2.1-3: an ack whose journal writes fail says the result arrives unverified and holds nothing", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    await h.drain();
    // The journal's directory is a file: the inflight and hold writes fail.
    rmSync(dirname(h.journalPath), { recursive: true, force: true });
    // The state directory's parent exists whether or not the plugin wrote the journal yet; the blocker file takes its place.
    mkdirSync(dirname(dirname(h.journalPath)), { recursive: true });
    writeFileSync(dirname(h.journalPath), "not a directory");
    const call = await h.before(dispatch({ background: true }));
    const done = await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    const shown = JSON.stringify(done.result);
    expect(shown).toContain("Its result will arrive unverified");
    expect(shown).not.toContain("held until verification finishes");
    expect(tail(await request(h, [user("go on")]))).not.toContain("Held for verification");
  });

  it("QA-2.1-16: a journal that vanishes under the process is recreated once from memory: held state survives, fail-closed ends", async () => {
    const warn = vi.spyOn(console, "warn");
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    await h.drain();
    const call = await h.before(dispatch({ background: true }));
    const first = await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    expect(JSON.stringify(first.result)).toContain("held until verification finishes");
    expect(existsSync(h.journalPath)).toBe(true);
    rmSync(h.journalPath);
    const second = "child-2";
    h.sessions.set(second, { parentID: ORCH });
    h.emit(created(second, ORCH));
    await h.drain();
    // The next journal write finds the journal gone: the journal is rewritten from the in-memory state and the write retried.
    const next = await h.before(dispatch({ background: true }));
    const nextDone = await h.after({ ...next, status: "completed", result: { output: { sessionID: second, status: "running", output: "Working" }, content: "Working", metadata: { sessionID: second } } });
    await h.settled();
    expect(existsSync(h.journalPath)).toBe(true);
    const records = readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    // The first dispatch came back from memory exactly once: its in-flight attempt (with its dispatch data) and its hold.
    expect(records.filter((r) => r.kind === "inflight" && r.callID === call.id)).toHaveLength(1);
    expect(records.find((r) => r.kind === "inflight" && r.callID === call.id)?.dispatch).toMatchObject({ prompt: expect.any(String) });
    expect(records.filter((r) => r.kind === "hold" && r.child === CHILD)).toHaveLength(1);
    // The retried write of the second dispatch landed, and it is held: holding is available again (the fail-closed state ended).
    expect(records.filter((r) => r.kind === "inflight" && r.callID === next.id)).toHaveLength(1);
    expect(records.filter((r) => r.kind === "hold" && r.child === second)).toHaveLength(1);
    expect(JSON.stringify(nextDone.result)).toContain("held until verification finishes");
    // No redaction any more: a completion of an unknown child is shown, and both children are still held.
    const event = await request(h, [user("go on"), completion("child-other", "VISIBLE after the recreation")]);
    expect(allText(event)).toContain("VISIBLE after the recreation");
    expect(tail(event)).toContain("[router] Held for verification");
    // Later appends and loads find the recreated journal: one more dispatch is journaled without another recreation.
    const third = "child-3";
    h.sessions.set(third, { parentID: ORCH });
    h.emit(created(third, ORCH));
    await h.drain();
    const last = await h.before(dispatch({ background: true }));
    await h.after({ ...last, status: "completed", result: { output: { sessionID: third, status: "running", output: "Working" }, content: "Working", metadata: { sessionID: third } } });
    await h.settled();
    const after = readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(after.filter((r) => r.kind === "inflight" && r.callID === last.id)).toHaveLength(1);
    expect(after.filter((r) => r.kind === "hold" && r.child === CHILD)).toHaveLength(1);
    // Warned once for the vanishing, once for the recovery; never a failed recreation.
    const told = (part: string): number => warn.mock.calls.filter((args) => args.some((arg) => String(arg).includes(part))).length;
    expect(told("the pending journal vanished")).toBe(1);
    expect(told("the pending journal was recreated from memory")).toBe(1);
    expect(told("could not be recreated")).toBe(0);
    warn.mockRestore();
  });

  it("QA-PDF12-2: the rewrite of a vanished journal from memory keeps each dispatch's caller agent and message (inflight and hold)", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    await h.drain();
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    await h.settled();
    rmSync(h.journalPath);
    const second = "child-pdf122";
    h.sessions.set(second, { parentID: ORCH });
    h.emit(created(second, ORCH));
    await h.drain();
    // The next journal write finds the journal gone: it is rewritten from the in-memory state (the adapter's and the holds').
    const next = await h.before(dispatch({ background: true }));
    await h.after({ ...next, status: "completed", result: { output: { sessionID: second, status: "running", output: "Working" }, content: "Working", metadata: { sessionID: second } } });
    await h.settled();
    const records = readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
    const rewritten = records.filter((r) => (r.kind === "inflight" || r.kind === "hold") && r.callID === call.id);
    expect(rewritten.map((r) => r.kind).sort()).toEqual(["hold", "inflight"]);
    for (const record of rewritten) {
      expect(record.callerAgent).toBe(call.agent);
      expect(record.callerMessageID).toBe(call.messageID);
    }
    expect(call.agent).not.toBe("");
    expect(call.messageID).not.toBe("");
  });

  it("QA-2.1-20: while the journal is not reloaded, a Code Mode execute that resumes an unknown session is refused like a subagent resume", async () => {
    // QA-2.1-16 recreates a vanished journal, so the reload-failed state is made deterministic another way: a directory sits
    // where pending.jsonl belongs. The reload at start fails (the file cannot be read), and so does every retry; nothing has
    // vanished, so nothing is recreated.
    const home = mkdtempSync(join(tmpdir(), "omr-v2-bg-"));
    const blocker = join(home, ".local", "state", "opencode-model-router", "pending.jsonl");
    mkdirSync(blocker, { recursive: true });
    writeFileSync(join(blocker, "keep"), "not a journal");
    const h = await boot("auto", { home });
    expect(h.journalPath).toBe(blocker);
    h.emit(created(CHILD, ORCH));
    await h.drain();
    const call = await h.before(dispatch({ background: true }));
    const acked = await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    // Holding is off while the journal is not reloaded.
    expect(JSON.stringify(acked.result)).not.toContain("held until verification finishes");
    await h.settled();
    const execute = (code: string): ToolEvent => ({ sessionID: ORCH, agent: "build", messageID: "m-exec", id: `call-exec-${code.length}`, tool: "execute", input: { code } });
    await expect(h.before(execute(`await tools.subagent({ agent: "general", prompt: "continue", sessionID: "child-unknown" });`)))
      .rejects.toThrow(reloadFailedResumeText("child-unknown"));
    await expect(h.before(execute(`await tools.subagent({ agent: "general", prompt: "continue", "task_id": 'child-unknown' });`)))
      .rejects.toThrow(reloadFailedResumeText("child-unknown"));
    // The same check as for a subagent resume.
    await expect(h.before({ ...dispatch({ background: true }), input: { agent: "general", description: "x", prompt: "continue", sessionID: "child-unknown" } }))
      .rejects.toThrow(reloadFailedResumeText("child-unknown"));
    // Code that resumes nothing goes through.
    await expect(h.before(execute(`await tools.subagent({ agent: "general", prompt: "a fresh task" });`))).resolves.toBeDefined();
    // A refused attempt past PENDING_RELOAD_RETRY_MS starts another reload; it fails again, so the refusal stands.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + PENDING_RELOAD_RETRY_MS + 1_000);
      await expect(h.before(execute(`await tools.subagent({ agent: "general", prompt: "continue", sessionID: "child-unknown" });`)))
        .rejects.toThrow(reloadFailedResumeText("child-unknown"));
      await h.settled();
      await expect(h.before(execute(`await tools.subagent({ agent: "general", prompt: "again", sessionID: "child-unknown" });`)))
        .rejects.toThrow(reloadFailedResumeText("child-unknown"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a restored dispatch's child end needs a completion marker (QA-2.1-18)", () => {
  const inflightRecord = (callID: string): string =>
    `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000${callID}`, callID, parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
  const lostWakes = (h: BgHost) => h.synthetic.filter((s) => s.resume === true && s.sessionID === ORCH && s.text.includes("was lost in a restart"));

  it("a child cut mid-step (partial text, no finish reason, no completed time) is lost, not gated on its partial text", async () => {
    const h = await boot("auto", { journalText: inflightRecord("call-cut"), sessions: { "child-event": { parentID: ORCH } } });
    childCutMidStep(h, CHILD, "Half of the ans");
    h.emit(created("child-event", ORCH));
    await h.settled();
    await vi.waitFor(() => expect(lostWakes(h)).toHaveLength(1));
  });

  it("a child whose newest assistant message still has a running tool part is lost", async () => {
    const h = await boot("auto", { journalText: inflightRecord("call-tool"), sessions: { "child-event": { parentID: ORCH } } });
    h.childContext.set(CHILD, [{
      type: "assistant", id: "m2", time: { created: 1, completed: 2 },
      content: [{ type: "text", text: "Let me run the tests" }, { type: "tool", id: "t1", state: { status: "running" } }],
    }]);
    h.emit(created("child-event", ORCH));
    await h.settled();
    await vi.waitFor(() => expect(lostWakes(h)).toHaveLength(1));
  });

  it("a child whose newest step ended in tool calls (it meant to go on) is lost", async () => {
    const h = await boot("auto", { journalText: inflightRecord("call-steps"), sessions: { "child-event": { parentID: ORCH } } });
    h.childContext.set(CHILD, [{ type: "assistant", id: "m2", finish: "tool-calls", content: [{ type: "text", text: "Next I will edit" }] }]);
    h.emit(created("child-event", ORCH));
    await h.settled();
    await vi.waitFor(() => expect(lostWakes(h)).toHaveLength(1));
  });

  it("a child whose newest assistant message completed its step succeeded: it is processed, never reported lost", async () => {
    const h = await boot("auto", { journalText: inflightRecord("call-done"), sessions: { "child-event": { parentID: ORCH } } });
    childSays(h, CHILD, "The whole answer.");
    h.emit(created("child-event", ORCH));
    await h.settled();
    await vi.waitFor(async () => {
      expect(tail(await request(h, [user("continue")]))).toContain("[router] Completed since your last turn:");
    });
    expect(lostWakes(h)).toEqual([]);
  });
});

describe("adoption from the event loop (QA-2.1-6)", () => {
  it("a parent seen only through a host event adopts its records: the lost child wakes it once", async () => {
    const journal = `${JSON.stringify({ v: 1, kind: "inflight", key: `${CHILD}\u0000call-event`, callID: "call-event", parentSessionID: ORCH, childSessionID: CHILD, label: "fast \"x\"", agent: "fast", description: "x", verifying: false, verificationMode: "none", hold: null, at: Date.now() })}\n`;
    const h = await boot("auto", { journalText: journal, sessions: { "child-event": { parentID: ORCH } } });
    h.emit(created("child-event", ORCH));
    await h.drain();
    await vi.waitFor(() => {
      expect(h.synthetic.filter((s) => s.resume === true && s.sessionID === ORCH && s.text.includes("was lost in a restart"))).toHaveLength(1);
    });
  });
});
