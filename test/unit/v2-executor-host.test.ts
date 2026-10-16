// QA-4.2-2: the executor's `HostSessions.context` adapter over the v2 host's real history shape (memo R1 rule 5, amended):
// an explicit terminal `idle` entry exists only when the host's history shows the child ended, with the real end outcome.
// QA-4.2-27: that end comes from `childHistoryEnd`, the one end rule background's recovery (`childEndState`) also uses.
import { describe, expect, it } from "vitest";
import { childHistoryEnd, executorHostContext, historyEntryKind, historyToolInFlight } from "../../src/compat/v2-hooks";
import { classifyChild } from "../../src/executor/recovery";
import { formatLaunchPrompt } from "../../src/executor/types";
import { PLAN_ID, nonceFor } from "../fixtures/cpx/ledger/builders.js";

const PREAMBLE = "You are a subagent spawned by another session.";
const HEADER = { planId: PLAN_ID, taskId: "T1", attempt: 1, nonce: nonceFor(1) };
const prompt = (eol = "\n"): string => `${PREAMBLE}${eol}${formatLaunchPrompt("shared", HEADER, "TASK T1\ndo it")}`;
const user = (text: string) => ({ type: "user", text });
const finished = (text: string) => ({ type: "assistant", text, finish: "stop", time: { created: 1, completed: 2 } });
const midTool = () => ({
  type: "assistant", text: "", finish: "tool-calls", time: { created: 1 },
  parts: [{ type: "tool", tool: "bash", state: { status: "running" } }],
});
const tool = () => ({ type: "tool", callID: "c1", tool: "bash", state: { status: "running" } });
const synthetic = (text: string) => ({ type: "synthetic", text });

describe("executorHostContext (QA-4.2-2)", () => {
  it("a child killed mid-tool-call has no terminal entry", () => {
    const c = executorHostContext([user(prompt()), midTool(), tool()]);
    expect(c.messages.some((m) => m.role === "idle")).toBe(false);
    expect(c.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(c.messages[2]).toEqual({ role: "assistant", text: null, outcome: null });
    expect(c.toolInFlight).toBe(true);
  });

  it("an assistant step cut mid-stream (no completion marker) has no terminal entry", () => {
    const c = executorHostContext([user(prompt()), { type: "assistant", text: "partial", time: { created: 1 } }]);
    expect(c.messages.some((m) => m.role === "idle")).toBe(false);
  });

  it("a finished child ends with idle succeeded; a later synthetic entry is skipped and never idle", () => {
    const c = executorHostContext([user(prompt()), finished("REPORT"), synthetic("[router] notice")]);
    expect(c.messages).toEqual([
      { role: "user", text: prompt(), outcome: null },
      { role: "assistant", text: "REPORT", outcome: null },
      { role: "assistant", text: null, outcome: null },
      { role: "idle", text: null, outcome: "succeeded" },
    ]);
  });

  it("a failed child ends with idle failed; an aborted one with idle interrupted", () => {
    const failed = executorHostContext([user(prompt()), { ...finished("x"), error: { name: "APIError", message: "boom" } }]);
    expect(failed.messages.at(-1)).toEqual({ role: "idle", text: null, outcome: "failed" });
    const aborted = executorHostContext([user(prompt()), { type: "assistant", info: { error: { name: "MessageAbortedError" } } }]);
    expect(aborted.messages.at(-1)).toEqual({ role: "idle", text: null, outcome: "interrupted" });
  });

  it("a user turn last (a resume) is not an end", () => {
    const c = executorHostContext([user(prompt()), finished("REPORT"), user("again")]);
    expect(c.messages.some((m) => m.role === "idle")).toBe(false);
  });

  it("a non-array history is empty", () => {
    expect(executorHostContext(undefined)).toEqual({ messages: [], toolInFlight: false });
  });

  it("QA-4.2-27: a completed step without text is an end (succeeded), as the live launcher treats it", () => {
    for (const step of [
      { type: "assistant", finish: "stop", time: { created: 1, completed: 2 } },
      { type: "assistant", time: { created: 1, completed: 2 }, parts: [{ type: "tool", tool: "bash", state: { status: "completed" } }] },
      { type: "assistant", info: { finish: "stop" } },
    ]) {
      const c = executorHostContext([user(prompt()), step]);
      expect(c.messages.at(-2)).toEqual({ role: "assistant", text: null, outcome: null });
      expect(c.messages.at(-1)).toEqual({ role: "idle", text: null, outcome: "succeeded" });
    }
  });

  it("QA-4.2-27: one entry-kind precedence for the mapping and the end rule", () => {
    // `type: "synthetic"` wins over a `role`; assistant (either field) over user; a model-facing `role` entry counts.
    expect(historyEntryKind({ type: "synthetic", role: "user" })).toBe("synthetic");
    expect(historyEntryKind({ type: "synthetic", role: "assistant" })).toBe("synthetic");
    expect(historyEntryKind({ role: "assistant" })).toBe("assistant");
    expect(historyEntryKind({ type: "user", role: "assistant" })).toBe("assistant");
    expect(historyEntryKind({ role: "user" })).toBe("user");
    expect(historyEntryKind({ type: "tool" })).toBe("other");
    expect(historyEntryKind(null)).toBe("other");
    const c = executorHostContext([
      { role: "user", content: [{ type: "text", text: prompt() }] },
      { role: "assistant", content: [{ type: "text", text: "REPORT" }], finish: "stop" },
      { type: "synthetic", role: "user", text: "[router] notice" },
    ]);
    expect(c.messages.map((m) => [m.role, m.text, m.outcome])).toEqual([
      ["user", prompt(), null], ["assistant", "REPORT", null], ["assistant", null, null], ["idle", null, "succeeded"],
    ]);
  });
});

describe("historyToolInFlight (R2-1)", () => {
  it.each(["running", "streaming", "pending", "unknown-status", undefined])("an open or unknown tool status (%s) is in flight in every history shape", (status) => {
    for (const state of [{ state: { status } }, { state: status }, { status }]) {
      const part = { type: "tool", ...state };
      expect(historyToolInFlight([part])).toBe(true);
      expect(historyToolInFlight([{ type: "assistant", parts: [part] }])).toBe(true);
      expect(historyToolInFlight([{ type: "assistant", content: [part] }])).toBe(true);
    }
    expect(historyToolInFlight([{ type: "tool" }])).toBe(true);
  });

  it.each(["completed", "error"])("%s tools are not in flight, standalone or in parts/content", (status) => {
    for (const state of [{ state: { status } }, { state: status }, { status }]) {
      const part = { type: "tool", ...state };
      expect(historyToolInFlight([part, { type: "assistant", parts: [part] }, { type: "assistant", content: [part] }])).toBe(false);
    }
  });

  it("checks all entries and both part arrays, even after a user turn", () => {
    expect(historyToolInFlight([midTool(), user("again")])).toBe(true);
    expect(historyToolInFlight([{ type: "assistant", content: [{ type: "text", text: "" }], parts: [{ type: "tool" }] }])).toBe(true);
  });

  it("a user turn last or a text-only step cut mid-stream has no tool in flight", () => {
    for (const history of [
      [user(prompt()), finished("REPORT"), user("again")],
      [user(prompt()), { type: "assistant", text: "partial", time: { created: 1 } }],
      [null, { type: "assistant", parts: [null, { type: "text", text: "partial" }] }],
      undefined,
    ]) {
      expect(historyToolInFlight(history)).toBe(false);
      expect(executorHostContext(history).toolInFlight).toBe(false);
    }
  });
});

describe("childHistoryEnd (QA-4.2-27: the one end rule of background and the executor)", () => {
  it("no entry but synthetic ones is none", () => {
    expect(childHistoryEnd([])).toEqual({ kind: "none" });
    expect(childHistoryEnd(undefined)).toEqual({ kind: "none" });
    expect(childHistoryEnd([synthetic("x")])).toEqual({ kind: "none" });
  });

  it("a user or tool turn last, or a step without its end, is open", () => {
    expect(childHistoryEnd([user(prompt())])).toEqual({ kind: "open" });
    expect(childHistoryEnd([user(prompt()), midTool()])).toEqual({ kind: "open" });
    expect(childHistoryEnd([user(prompt()), midTool(), tool()])).toEqual({ kind: "open" });
    expect(childHistoryEnd([user(prompt()), { type: "assistant", text: "partial", finish: "tool-calls" }])).toEqual({ kind: "open" });
    expect(childHistoryEnd([user(prompt()), finished("REPORT"), user("again")])).toEqual({ kind: "open" });
  });

  it("an ended step reports its outcome and its text (absent when it has none)", () => {
    expect(childHistoryEnd([user(prompt()), finished("REPORT"), synthetic("n")])).toEqual({ kind: "ended", outcome: "succeeded", text: "REPORT" });
    expect(childHistoryEnd([user(prompt()), { type: "assistant", finish: "stop" }])).toEqual({ kind: "ended", outcome: "succeeded", text: undefined });
    expect(childHistoryEnd([user(prompt()), { type: "assistant", text: "half", error: "boom" }])).toEqual({ kind: "ended", outcome: "failed", text: "half" });
    expect(childHistoryEnd([user(prompt()), { type: "assistant", error: { name: "MessageAbortedError" } }]))
      .toEqual({ kind: "ended", outcome: "interrupted", text: undefined });
    expect(childHistoryEnd([user(prompt()), { type: "assistant", info: { error: "request cancelled" } }]))
      .toEqual({ kind: "ended", outcome: "interrupted", text: undefined });
  });
});

describe("recovery over the adapter (QA-4.2-1, QA-4.2-2)", () => {
  it("recovery over the adapter: a running child with the host preamble is alive, a killed-mid-tool one is never finished", () => {
    const expectHdr = { planId: HEADER.planId, taskId: HEADER.taskId, n: HEADER.attempt, nonce: HEADER.nonce };
    const info = { id: "child", parentID: "parent" };
    for (const eol of ["\n", "\r\n"]) {
      const running = executorHostContext([user(prompt(eol)), midTool()]);
      expect(classifyChild(info, running, "active", expectHdr, "shared")).toBe("alive");
      expect(classifyChild(info, running, "unknown", expectHdr, "shared")).toBe("unknown");
      const done = executorHostContext([user(prompt(eol)), finished("REPORT")]);
      expect(classifyChild(info, done, "unknown", expectHdr, "shared")).toBe("finished");
    }
  });
});
