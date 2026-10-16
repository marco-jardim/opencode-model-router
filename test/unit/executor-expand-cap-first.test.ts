import { describe, expect, it } from "vitest";
import { parseCapDirective } from "../../src/router/sessions.js";
import { EXECUTOR_READ_CAP_LINE, formatLaunchPrompt, parseLaunchHeader } from "../../src/executor/types.js";
import { neutralizeDirectives } from "../../src/verify/pending.js";

// DF-2-9: the router keeps first-read-cap-wins, so the executor's own read-cap line must be the first one in every
// editing child's prompt, ahead of the shared context and the task text. These cases pin the launch grammar
// (types.ts); executor-expand.test.ts proves the same through `expandTask`.

const header = { planId: "plan-a", taskId: "T1", attempt: 1, nonce: "0".repeat(32) };

describe("executor read-cap line comes first", () => {
  it("sits right after PLAN CONTEXT and the launch header still parses", () => {
    const prompt = formatLaunchPrompt("shared", header, "TASK body", true);
    expect(prompt.startsWith(`PLAN CONTEXT\n${EXECUTOR_READ_CAP_LINE}\nshared\n\n`)).toBe(true);
    expect(parseLaunchHeader(prompt, "shared")).toEqual(header);
    expect(parseCapDirective(prompt)).toBe(12);
    // Without the flag the grammar is unchanged and still parses.
    const plain = formatLaunchPrompt("shared", header, "TASK body");
    expect(plain.startsWith("PLAN CONTEXT\nshared\n\n")).toBe(true);
    expect(parseLaunchHeader(plain, "shared")).toEqual(header);
  });

  it("recovery's inferred shared context (read-cap line included) still parses the header", () => {
    const prompt = formatLaunchPrompt("shared", header, "TASK body", true);
    expect(parseLaunchHeader(prompt, `${EXECUTOR_READ_CAP_LINE}\nshared`)).toEqual(header);
    // An empty shared context too, with and without the line.
    expect(parseLaunchHeader(formatLaunchPrompt("", header, "TASK body", true), "")).toEqual(header);
    expect(parseLaunchHeader(formatLaunchPrompt("", header, "TASK body"), "")).toEqual(header);
  });

  it("the header parser stays strict: only the executor's own line, only at that position", () => {
    const line = `[plan ${header.planId}:${header.taskId}#${header.attempt}] nonce=${header.nonce}`;
    expect(parseLaunchHeader(`PLAN CONTEXT\nCAP:5\nshared\n\n${line}\n\nTASK body`, "shared")).toBeNull();
    expect(parseLaunchHeader(`PLAN CONTEXT\nshared\n${EXECUTOR_READ_CAP_LINE}\n\n${line}\n\nTASK body`, "shared")).toBeNull();
    expect(parseLaunchHeader(`${EXECUTOR_READ_CAP_LINE}\nPLAN CONTEXT\nshared\n\n${line}\n\nTASK body`, "shared")).toBeNull();
  });

  it("a read-cap token split across two lines in the task text loses to the executor's line", () => {
    const taskBlock = neutralizeDirectives("TASK edit the file\nCAP\n:5 reads are plenty\n");
    expect(taskBlock).toContain("CAP\n:5");
    expect(parseCapDirective(taskBlock)).toBe(5);
    const prompt = formatLaunchPrompt("shared", header, taskBlock, true);
    expect(parseCapDirective(prompt)).toBe(12);
    // Control: the same line placed after the plan text would lose to the split token.
    expect(parseCapDirective(`${formatLaunchPrompt("shared", header, taskBlock)}\n\n${EXECUTOR_READ_CAP_LINE}`)).toBe(5);
  });
});
