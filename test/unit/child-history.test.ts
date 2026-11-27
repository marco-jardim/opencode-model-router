// #167: the shared reader of a v2 child's own history (`ctx.session.context`), used by the background completion processor
// (which ignores `failed`) and by the native child runner after it waited for a running result.
import { describe, expect, it } from "vitest";
import { assistantStepCompleted, historyHasEntry, lastAssistantReply, messageText, newestEntryId } from "../../src/compat/child-history";

const user = (text: string, id?: string) => ({ ...(id ? { id } : {}), type: "user", content: [{ type: "text", text }] });
const answer = (text: string, more: Record<string, unknown> = {}) =>
  ({ type: "assistant", content: [{ type: "text", text }], finish: "stop", ...more });

describe("messageText", () => {
  it("reads text, string content, or joined text parts of content or parts", () => {
    expect(messageText({ text: "a" })).toBe("a");
    expect(messageText({ content: "b" })).toBe("b");
    expect(messageText({ content: [{ type: "text", text: "c" }, { type: "tool" }, { type: "text", text: "d" }] })).toBe("c\nd");
    expect(messageText({ parts: [{ type: "text", text: "e" }] })).toBe("e");
    expect(messageText({ content: [{ type: "reasoning", text: "x" }] })).toBeUndefined();
    expect(messageText(null)).toBeUndefined();
  });
});

describe("lastAssistantReply", () => {
  it("no history, or no assistant text, is no reply", () => {
    expect(lastAssistantReply(undefined)).toBeUndefined();
    expect(lastAssistantReply({ messages: [] })).toBeUndefined();
    expect(lastAssistantReply([])).toBeUndefined();
    expect(lastAssistantReply([user("go"), { type: "assistant", finish: "stop" }])).toBeUndefined();
  });

  it("is the newest assistant text of the current turn, past non-message entries, in either shape", () => {
    expect(lastAssistantReply([user("go"), answer("first step", { finish: "tool-calls" }), { type: "tool" }, answer("done"),
      { type: "synthetic", text: "note" }, { type: "idle" }])).toEqual({ text: "done", failed: false });
    expect(lastAssistantReply([{ role: "user", text: "go" }, { role: "assistant", text: "done" }])).toEqual({ text: "done", failed: false });
    // An assistant entry without text is passed over, as the background reader always did.
    expect(lastAssistantReply([user("go"), answer("done"), { type: "assistant", finish: "stop" }])).toEqual({ text: "done", failed: false });
  });

  it("stops at the newest user prompt (DF-1-4): an earlier turn's answer is not this turn's", () => {
    expect(lastAssistantReply([user("first"), answer("old"), user("again")])).toBeUndefined();
    expect(lastAssistantReply([user("first"), answer("old"), user("again"), answer("new")])).toEqual({ text: "new", failed: false });
  });

  it("an error on an assistant entry from the answer onward fails the reply; an older one does not", () => {
    expect(lastAssistantReply([user("go"), answer("half", { error: { name: "APIError" } })])).toEqual({ text: "half", failed: true });
    expect(lastAssistantReply([user("go"), answer("half", { info: { error: "boom" } })])).toEqual({ text: "half", failed: true });
    expect(lastAssistantReply([user("go"), answer("done"), { type: "assistant", error: { name: "MessageAbortedError" } }]))
      .toEqual({ text: "done", failed: true });
    expect(lastAssistantReply([user("go"), answer("draft", { error: "retried" }), answer("done")])).toEqual({ text: "done", failed: false });
    expect(lastAssistantReply([user("go"), answer("done", { error: null })])).toEqual({ text: "done", failed: false });
  });

  it.each(["failed", "interrupted"])("a run end marker with outcome %s in the current turn fails the reply", (outcome) => {
    expect(lastAssistantReply([user("go"), answer("done"), { type: "idle", outcome }])).toEqual({ text: "done", failed: true });
  });

  it("an end marker that succeeded, has no outcome, or belongs to an earlier turn changes nothing", () => {
    expect(lastAssistantReply([user("go"), answer("done"), { type: "idle", outcome: "succeeded" }])).toEqual({ text: "done", failed: false });
    expect(lastAssistantReply([user("go"), answer("done"), { type: "idle" }])).toEqual({ text: "done", failed: false });
    expect(lastAssistantReply([user("first"), answer("old"), { type: "idle", outcome: "failed" }, user("again"), answer("new")]))
      .toEqual({ text: "new", failed: false });
  });

  describe("final (the native runner's waited result): the turn's newest assistant entry decides", () => {
    const toolStep = (text: string, status = "completed") => ({
      type: "assistant", finish: "tool-calls", content: [{ type: "text", text }, { type: "tool", id: "t1", name: "read", state: { status } }],
    });
    const final = { final: true };

    it("a draft before a tool call is never the answer when the final step has no text", () => {
      const history = [user("go"), toolStep('Draft: {"pass":true} — let me confirm'),
        { type: "assistant", content: [{ type: "reasoning", text: "checked" }], finish: "stop" }, { type: "idle", outcome: "succeeded" }];
      expect(lastAssistantReply(history, final)).toBeUndefined();
      // The background reader (no option) keeps its walk past a textless entry.
      expect(lastAssistantReply(history)).toEqual({ text: 'Draft: {"pass":true} — let me confirm', failed: false });
    });

    it("a newest entry whose step did not end, or is in a tool call, is no answer", () => {
      expect(lastAssistantReply([user("go"), { type: "assistant", content: [{ type: "text", text: "half" }], time: { created: 1 } }], final))
        .toBeUndefined();
      expect(lastAssistantReply([user("go"), toolStep("half", "running")], final)).toBeUndefined();
      expect(lastAssistantReply([user("go"), toolStep("calling a tool")], final)).toBeUndefined();
      expect(lastAssistantReply([user("go"), answer("half", { finish: "unknown" })], final)).toBeUndefined();
    });

    it("a completed newest entry with text is the answer, whatever earlier steps said", () => {
      expect(lastAssistantReply([user("go"), toolStep("draft"), answer("done")], final)).toEqual({ text: "done", failed: false });
      expect(lastAssistantReply([user("go"), toolStep("draft"), { type: "assistant", text: "done", time: { created: 1, completed: 2 } }], final))
        .toEqual({ text: "done", failed: false });
      expect(lastAssistantReply([user("go"), answer("done", { info: { finish: "stop" }, finish: undefined })], final))
        .toEqual({ text: "done", failed: false });
    });

    it("finish: error fails the answer even without an error field; idle outcomes still apply", () => {
      expect(lastAssistantReply([user("go"), answer("half", { finish: "error" })], final)).toEqual({ text: "half", failed: true });
      expect(lastAssistantReply([user("go"), answer("done"), { type: "idle", outcome: "interrupted" }], final)).toEqual({ text: "done", failed: true });
      // Without `final` a finish reason is not read (the background reader is unchanged).
      expect(lastAssistantReply([user("go"), answer("half", { finish: "error" })])).toEqual({ text: "half", failed: false });
    });

    it("an idle entry is not required", () => {
      expect(lastAssistantReply([user("go"), answer("done")], final)).toEqual({ text: "done", failed: false });
    });
  });

  describe("after a marker (a resume)", () => {
    const before = [user("first", "m1"), { id: "m2", ...answer("old") }, { id: "m3", type: "idle", outcome: "succeeded" }];
    const marker = (prompt = "again") => ({ after: { id: "m3", prompt } });

    it("reads only what follows the marker, and only an answer after this run's own prompt", () => {
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }], marker()))
        .toEqual({ text: "new", failed: false });
      expect(lastAssistantReply(before, marker())).toBeUndefined();
      expect(lastAssistantReply([...before, { id: "m4", type: "idle", outcome: "interrupted" }], marker())).toBeUndefined();
      // An answer with no prompt of its own after the marker is not this run's answer.
      expect(lastAssistantReply([...before, { id: "m4", ...answer("unprompted") }], marker())).toBeUndefined();
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }, { id: "m6", type: "idle", outcome: "failed" }],
        marker())).toEqual({ text: "new", failed: true });
    });

    it("the user entry must contain this run's prompt (trimmed, line endings aside); another one does not count", () => {
      const run = (entry: string, prompt: string) =>
        lastAssistantReply([...before, user(entry, "m4"), { id: "m5", ...answer("new") }], marker(prompt));
      expect(run("You are a subagent spawned by another session.\r\nline one\r\nline two", "  line one\nline two\n")).toEqual({ text: "new", failed: false });
      expect(run("a prompt queued by an earlier run", "again")).toBeUndefined();
      expect(run("again", "   ")).toBeUndefined();
      // A steered-in prompt after ours belongs to the same turn: ours is still among the entries before the answer.
      expect(lastAssistantReply([...before, user("again", "m4"), user("also this", "m5"), { id: "m6", ...answer("new") }], marker()))
        .toEqual({ text: "new", failed: false });
    });

    it("the same prompt text before the marker does not count: only an entry after it does", () => {
      const repeated = [user("again", "m1"), { id: "m2", ...answer("old") }, { id: "m3", type: "idle", outcome: "succeeded" }];
      expect(lastAssistantReply(repeated, marker())).toBeUndefined();
      expect(lastAssistantReply([...repeated, user("again", "m4"), { id: "m5", ...answer("new") }], marker())).toEqual({ text: "new", failed: false });
    });

    it("a run end between this run's prompt and the answer: the answer is a later run's, not ours", () => {
      const idle = (outcome: string, id: string) => ({ id, type: "idle", outcome });
      // (a) our run was interrupted after taking our prompt; another prompt was taken and answered afterwards.
      expect(lastAssistantReply([...before, user("again", "m4"), idle("interrupted", "m5"), user("something else", "m6"),
        { id: "m7", ...answer("foreign") }, idle("succeeded", "m8")], { final: true, ...marker() })).toBeUndefined();
      // Any outcome counts: a run ended between them.
      expect(lastAssistantReply([...before, user("again", "m4"), idle("succeeded", "m5"), user("something else", "m6"),
        { id: "m7", ...answer("foreign") }], marker())).toBeUndefined();
      // (b) a steered-in prompt in the same run, then the answer and its run end: still ours.
      expect(lastAssistantReply([...before, user("again", "m4"), user("also this", "m5"), { id: "m6", ...answer("new") },
        idle("succeeded", "m7")], { final: true, ...marker() })).toEqual({ text: "new", failed: false });
      // (c) our prompt, the answer, its run end.
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }, idle("succeeded", "m6")],
        { final: true, ...marker() })).toEqual({ text: "new", failed: false });
      // A run end after the answer keeps its meaning: an outcome other than "succeeded" fails the reply.
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }, idle("interrupted", "m6")],
        { final: true, ...marker() })).toEqual({ text: "new", failed: true });
      // The newest own prompt is the reference: an identical prompt taken again after the run end, then answered, is ours.
      expect(lastAssistantReply([...before, user("again", "m4"), idle("interrupted", "m5"), user("again", "m6"),
        { id: "m7", ...answer("retried") }], { final: true, ...marker() })).toEqual({ text: "retried", failed: false });
    });

    it("combines with final: the newest entry after the prompt decides", () => {
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }, { id: "m6", type: "assistant", finish: "stop" }],
        { final: true, ...marker() })).toBeUndefined();
    });

    it("a marker that is no longer in the history (compacted) gives no reply", () => {
      expect(lastAssistantReply([{ id: "c1", type: "compaction" }, user("again", "m4"), { id: "m5", ...answer("new") }], marker()))
        .toBeUndefined();
      expect(lastAssistantReply([], marker())).toBeUndefined();
    });

    it("without a marker the reader is unchanged", () => {
      expect(lastAssistantReply([...before, user("again", "m4"), { id: "m5", ...answer("new") }])).toEqual({ text: "new", failed: false });
      expect(lastAssistantReply(before)).toEqual({ text: "old", failed: false });
    });
  });
});

describe("assistantStepCompleted (QA-2.1-18, moved from v2-hooks.ts unchanged)", () => {
  it("a finish other than tool-calls/unknown, or a completed time, with no open tool part, ends the step", () => {
    expect(assistantStepCompleted({ type: "assistant", finish: "stop" })).toBe(true);
    expect(assistantStepCompleted({ type: "assistant", finish: "error" })).toBe(true);
    expect(assistantStepCompleted({ type: "assistant", info: { finish: "stop" } })).toBe(true);
    expect(assistantStepCompleted({ type: "assistant", time: { created: 1, completed: 2 } })).toBe(true);
    expect(assistantStepCompleted({ type: "assistant", finish: "tool-calls", time: { created: 1, completed: 2 } })).toBe(false);
    expect(assistantStepCompleted({ type: "assistant", finish: "unknown" })).toBe(false);
    expect(assistantStepCompleted({ type: "assistant", time: { created: 1 } })).toBe(false);
    expect(assistantStepCompleted({ type: "assistant", finish: "stop", content: [{ type: "tool", state: { status: "running" } }] })).toBe(false);
    expect(assistantStepCompleted({ type: "assistant", finish: "stop", parts: [{ type: "tool", state: "pending" }] })).toBe(false);
    expect(assistantStepCompleted({ type: "assistant", finish: "stop", content: [{ type: "tool", state: { status: "completed" } }] })).toBe(true);
    expect(assistantStepCompleted(null)).toBe(false);
  });
});

describe("historyHasEntry", () => {
  it("tells whether an entry with this id is still in the history", () => {
    expect(historyHasEntry([{ id: "a" }, { id: "b" }], "a")).toBe(true);
    expect(historyHasEntry([{ id: "c1", type: "compaction" }, { id: "b" }], "a")).toBe(false);
    expect(historyHasEntry([], "a")).toBe(false);
    expect(historyHasEntry({ id: "a" }, "a")).toBe(false);
  });
});

describe("newestEntryId", () => {
  it("is the id of the newest entry, or undefined", () => {
    expect(newestEntryId([{ id: "a" }, { id: "b" }])).toBe("b");
    expect(newestEntryId([{ id: "a" }, { type: "user" }])).toBeUndefined();
    expect(newestEntryId([{ id: "" }])).toBeUndefined();
    expect(newestEntryId([])).toBeUndefined();
    expect(newestEntryId({ id: "a" })).toBeUndefined();
  });
});
