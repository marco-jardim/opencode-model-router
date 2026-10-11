/**
 * test/integration/v2-background.test.ts
 *
 * Phase 2.1 (task 2.1.8): background-first dispatch through the real plugin behind the real v2 adapter, driven by the fake host
 * of test/helpers/v2-bg-host.ts (no sleeps: events are queued and drained by microtask turns).
 *
 * Held-result scenarios (placeholder stability, refusal of a resume, compaction) start from a hold record in `pending.jsonl`
 * written by a previous process: the reload / adoption path (memo 11.3, R20) is the one a restart takes, and it exercises the
 * same matcher the live path uses.
 *
 * The defects found by 2.1.8 are fixed and pinned by plain tests named "Dn: ...": D2 early end processed at the ack, D3 held
 * verdict posted (the pending journal survives a removed directory), D4 resume by `task_id` of a held child refused, D5 a lost
 * child (empty history) annotated. Verdict posting through the real adapter to a busy and to an idle parent (PASS, FAIL: one
 * `synthetic` with `resume: true`) is tested in "held verdicts posted to the parent" below.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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
const completion = (child: string, body: string) => ({
  id: "m-completion",
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

function childSays(h: BgHost, child: string, text: string): void {
  h.childContext.set(child, [{ role: "assistant", content: [{ type: "text", text }] }]);
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
});
