// QA-4.2-2: the executor's `HostSessions.context` adapter over the v2 host's real history shape (memo R1 rule 5, amended):
// an explicit terminal `idle` entry exists only when the host's history shows the child ended, with the real end outcome.
import { describe, expect, it } from "vitest";
import { executorHostContext } from "../../src/compat/v2-hooks";
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
    expect(executorHostContext(undefined)).toEqual({ messages: [] });
  });

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
