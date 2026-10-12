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
 * held child's UNVERIFIABLE verdict posted (a journal that vanishes now fails closed instead, QA-2.1-8), D4 resume by `task_id` of a held child refused, D5 a lost
 * child (empty history) annotated. Verdict posting through the real adapter to a busy and to an idle parent (PASS, FAIL: one
 * `synthetic` with `resume: true`) is tested in "held verdicts posted to the parent" below. Timing rows of the static engine feeding
 * the background decision ("static engine: timing rows…") and the route hint never carrying held output are tested here too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PENDING_RELOAD_RETRY_MS } from "../../src/compat/v2-hooks";
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

  // Real OpenCode 2 shapes (smoke cpx-background): `ctx.session.context(child)` entries are discriminated by `type`, not `role`.
  it("the child's result is read from a host context entry typed `assistant` (no `role`): the end event completes the processing", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    await request(h, [user("continue")]); // the root request that teaches the adapter the parent is a root
    h.childContext.set(CHILD, [
      { type: "user", id: "m1", content: [{ type: "text", text: "do the work" }] },
      { type: "assistant", id: "m2", content: [{ type: "text", text: "real host result" }] },
    ]);
    // A unique event id: the adapter drops an end event id it has already seen in this process.
    h.emit({ type: "session.execution.succeeded", id: "ev-end-typed-assistant", created: 2, data: { sessionID: CHILD } });
    await h.drain();
    // The end handler awaits the timing store before it starts the processor: poll the tail until the attempt left the in-flight list.
    await vi.waitFor(async () => {
      const state = tail(await request(h, [user("continue")]));
      expect(state).not.toContain("In flight (background)");
      expect(state).not.toContain("router guarantees pending");
    }, { timeout: 5000, interval: 50 });
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
    await h.drain();
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
  });
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

  it("QA-2.1-8: a journal that vanishes under the process fails closed and is never recreated", async () => {
    const h = await boot("auto");
    h.emit(created(CHILD, ORCH));
    await h.drain();
    const call = await h.before(dispatch({ background: true }));
    await h.after({ ...call, status: "completed", result: structuredClone(RUNNING) });
    expect(existsSync(h.journalPath)).toBe(true);
    rmSync(h.journalPath);
    const second = "child-2";
    h.sessions.set(second, { parentID: ORCH });
    h.emit(created(second, ORCH));
    await h.drain();
    const next = await h.before(dispatch({ background: true }));
    await h.after({ ...next, status: "completed", result: { output: { sessionID: second, status: "running", output: "Working" }, content: "Working", metadata: { sessionID: second } } });
    // Fail closed (memo 12): a completion this process cannot prove processed is redacted.
    const event = await request(h, [user("go on"), completion("child-unknown", "SECRET unprocessed output")]);
    expect(allText(event)).not.toContain("SECRET unprocessed output");
    // The compaction hook fails closed the same way: a summary never carries it either.
    const compaction = h.sessionHooks.compaction;
    if (compaction === undefined) throw new Error("no compaction hook");
    const messages = [{ id: "m1", role: "user", content: [{ type: "text", text: `<subagent sessionID="child-unknown" state="completed">SECRET unprocessed output</subagent>` }] }];
    await compaction({ sessionID: ORCH, messages } as never);
    expect(JSON.stringify(messages)).not.toContain("SECRET unprocessed output");
    await h.drain();
    expect(existsSync(h.journalPath)).toBe(false);
    // The failed state is not permanent: once the journal is back, a later hook retries the reload (at most every
    // PENDING_RELOAD_RETRY_MS) and the fail-closed redaction ends.
    writeFileSync(h.journalPath, "");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + PENDING_RELOAD_RETRY_MS + 1_000);
      await vi.waitFor(async () => {
        const again = await request(h, [user("later"), completion("child-other", "VISIBLE after the reload")]);
        expect(allText(again)).toContain("VISIBLE after the reload");
      });
    } finally {
      vi.useRealTimers();
    }
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
