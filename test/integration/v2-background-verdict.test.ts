/**
 * Phase 2.1 QA round 1: the verdict a background completion ends in, through the real plugin's finish API (src/index.ts) as the
 * v2 adapter attaches it.
 *
 * - QA-2.1-1: a held dispatch whose gate gives no verdict (verification not required, a read-only skip, a deferral, an error)
 *   posts UNVERIFIABLE with a reason, never PASS.
 * - QA-2.1-5: a child that did not succeed is never verified: `finish` returns no verification and the gate does not run.
 * - QA-2.1-9 / QA-2.1-11 (the pieces router_verify and the gate use): a held entry's report line; the producer-aware lease wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { ROUTER_FINISH_ATTACH, type FinishApi, type HeldSink } from "../../src/compat/background";
import { invalidateConfigCache } from "../../src/router/config";
import { backgroundOutcomes, formatVerifyReport, HELD_RESULT_TEXT, waitTreeFreeExcept } from "../../src/verify/wiring";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const gate = vi.hoisted(() => ({ parsed: 0 }));

vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

// The gate's first step on a finished `task` call: counting it tells whether finishDispatch ran a gate at all.
vi.mock("../../src/verify/dispatch", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/dispatch")>();
  return {
    ...actual,
    parseTaskResult: (output: unknown) => {
      gate.parsed += 1;
      return actual.parseTaskResult(output);
    },
  };
});

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, MODEL_ROUTER_ENFORCE: process.env.MODEL_ROUTER_ENFORCE };
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omr-bg-verdict-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  gate.parsed = 0;
  invalidateConfigCache();
});

afterEach(async () => {
  for (const key of ["HOME", "USERPROFILE", "MODEL_ROUTER_ENFORCE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  invalidateConfigCache();
  await removeDirWhenReleased(home);
});

type Posted = { handle: string; verdict: string; text: string; reason?: string };

async function attach(runner?: { run(request: { parentSessionID?: string }): Promise<{ sessionID: string; text: string }>; dispose(sessionID: string): Promise<void> }): Promise<{ api: FinishApi; posted: Posted[]; hooks: Hooks }> {
  const hooks: Hooks = await ModelRouterPlugin({
    directory: home,
    worktree: home,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    routerHost: "v2",
    client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
    // DF-1-3: the v2 child runner the graders launch through (the adapter's `ctx.routerChildRunner`).
    ...(runner === undefined ? {} : { routerChildRunner: runner }),
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
  const channel: unknown = Reflect.get(hooks, ROUTER_FINISH_ATTACH);
  if (typeof channel !== "function") throw new Error("the plugin exposes no finish attach channel");
  const posted: Posted[] = [];
  const held: HeldSink = {
    verdict: async (handle, v) => {
      posted.push({ handle, ...v });
    },
  };
  const api = channel({ host: "v2", held }) as FinishApi | undefined;
  if (api === undefined) throw new Error("v2 attach returned no finish API");
  return { api, posted, hooks };
}

async function finishHeld(api: FinishApi, callID: string): Promise<string> {
  const handle = api.reserveHeld("ses_parent", callID);
  if (handle === undefined) throw new Error("no handle reserved");
  const result = await api.finish({
    callID,
    parentSessionID: "ses_parent",
    childSessionID: `ses_child_${callID}`,
    outputText: "Looked around; nothing to change.",
    status: "succeeded",
    mode: "background",
    heldHandle: handle,
    endedAt: Date.now(),
  });
  expect(result.verification).toEqual({ kind: "held", handle });
  return handle;
}

describe("held background verdicts (QA-2.1-1)", () => {
  it("verification not required: the held verdict is UNVERIFIABLE with its reason, never PASS", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "0";
    const { api, posted } = await attach();
    const handle = await finishHeld(api, "call-none");
    await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 10_000 });
    expect(posted[0]).toMatchObject({ handle, verdict: "UNVERIFIABLE" });
    expect(posted[0].reason).toBe("not verified: verification is not required for this dispatch");
    expect(posted[0].text).toContain("Looked around; nothing to change.");
    expect(posted[0].text.trimEnd().endsWith("[router] UNVERIFIABLE — not verified: verification is not required for this dispatch")).toBe(true);
  });

  it("a gate that gives no verdict (read-only skip or deferral) posts UNVERIFIABLE with its reason, never PASS", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const { api, posted } = await attach();
    const handle = await finishHeld(api, "call-skip");
    await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 25_000 });
    expect(gate.parsed).toBeGreaterThan(0);
    expect(posted[0]).toMatchObject({ handle, verdict: "UNVERIFIABLE" });
    expect(posted[0].verdict).not.toBe("PASS");
    expect(posted[0].reason).toMatch(/^(not verified: |verification unavailable: )/);
    expect(posted[0].text).toMatch(/\[router\] UNVERIFIABLE — (not verified: |verification unavailable: )/);
  }, 30_000);
});

describe("DF-1-3 a background completion without a deterministic check", () => {
  it("DF-1-3 the grader launches from the orchestrator (never the current context); an unverifiable result is tagged UNVERIFIABLE, never PASS", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    execFileSync("git", ["init", "-q"], { cwd: home }); // a work tree the gate can prepare its verification in
    const launched: Array<{ parentSessionID?: string }> = [];
    const runner = {
      run: async (request: { parentSessionID?: string }) => {
        launched.push(request);
        throw new Error("Tool.Error: Subagent denied: model-router-grader");
      },
      dispose: async () => undefined,
    };
    const { api, hooks } = await attach(runner);
    // The call's arguments as the before hook keeps them (an explicit acceptance with a criterion only: a grader check).
    const prompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
    const before = hooks["tool.execute.before"] as unknown as ((input: unknown, output: unknown) => Promise<void>) | undefined;
    await before?.({ tool: "task", sessionID: "ses_parent", callID: "call-df13" }, { args: { subagent_type: "fast", description: "explain the parser", prompt } })
      .catch(() => undefined);
    const result = await api.finish({
      callID: "call-df13",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child_df13",
      outputText: "The parser starts in parse().",
      status: "succeeded",
      mode: "background",
      endedAt: Date.now(),
    });
    expect(launched.length).toBeGreaterThan(0);
    for (const request of launched) expect(request.parentSessionID).toBe("ses_parent");
    expect(result.verification).toEqual({ kind: "required", verdict: "UNVERIFIABLE" });
    // Acceptance is unchanged: an unverifiable result is accepted (not strictUnverifiable), so no forcing note.
    expect(result.outputText.startsWith("The parser starts in parse().")).toBe(true);
    expect(result.outputText).not.toContain("NEXT: address the above");
  }, 30_000);
});

describe("router_verify and a held entry (QA-2.1-9)", () => {
  const handle = "vrf_0123456789abcdef01234567";

  it("a held entry is reported as held, with nothing run, and never claimed by a background run", () => {
    const text = formatVerifyReport([{ kind: "held", handle, description: "refactor the parser" }], 0, false);
    expect(text).toContain(`- ${handle} \u00b7 refactor the parser \u00b7 ${HELD_RESULT_TEXT}`);
    expect(backgroundOutcomes([{ kind: "held", handle, description: "refactor the parser" }])).toEqual([{ kind: "reported", handle }]);
  });
});

describe("the gate's lease wait leaves out the producer's own holder (QA-2.1-11)", () => {
  type Wait = { waitedMs: number; holders: string[]; fileCount: number };
  const fakeGate = (answers: Array<string[]>) => {
    const calls: number[] = [];
    let i = 0;
    return {
      calls,
      gate: {
        waitTreeFree: async (_tree: string, _owner: { producer: string }, deadlineMs: number): Promise<Wait> => {
          calls.push(deadlineMs);
          const holders = answers[Math.min(i, answers.length - 1)];
          i += 1;
          return { waitedMs: 0, holders, fileCount: holders.length };
        },
      },
    };
  };
  const signal = new AbortController().signal;

  it("only the producer holds the tree: no wait at all (one probe)", async () => {
    const { gate: g, calls } = fakeGate([["ses_producer"]]);
    const wait = await waitTreeFreeExcept(g, "/repo", { producer: "ses_parent" }, new Set(["ses_producer"]), 5_000, signal);
    expect(wait.holders).toEqual([]);
    expect(calls).toEqual([0]);
  });

  it("another holder without the producer: the event-driven wait runs as before, with the time left", async () => {
    const { gate: g, calls } = fakeGate([["ses_other"], ["ses_other"]]);
    const wait = await waitTreeFreeExcept(g, "/repo", { producer: "ses_parent" }, new Set(["ses_producer"]), 5_000, signal);
    expect(wait.holders).toEqual(["ses_other"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(0);
    expect(calls[1]).toBeGreaterThan(0);
  });

  it("another holder next to the producer: polled until only the producer remains", async () => {
    const { gate: g, calls } = fakeGate([["ses_producer", "ses_other"], ["ses_producer"]]);
    const wait = await waitTreeFreeExcept(g, "/repo", { producer: "ses_parent" }, new Set(["ses_producer"]), 5_000, signal);
    expect(wait.holders).toEqual([]);
    expect(calls).toEqual([0, 0]);
  });
});

describe("children that did not succeed (QA-2.1-5)", () => {
  for (const status of ["failed", "interrupted", "unknown"] as const) {
    it(`a ${status} child is never verified: no gate, no verification, no router text`, async () => {
      process.env.MODEL_ROUTER_ENFORCE = "1";
      const { api, posted } = await attach();
      const result = await api.finish({
        callID: `call-${status}`,
        parentSessionID: "ses_parent",
        childSessionID: `ses_child_${status}`,
        outputText: "partial output",
        status,
        mode: "background",
        endedAt: Date.now(),
      });
      expect(result).toEqual({ outputText: "partial output", suffix: "", verification: { kind: "none" }, metadata: {} });
      expect(gate.parsed).toBe(0);
      expect(posted).toEqual([]);
    });
  }

  it("a succeeded child under the same settings does run the gate (control)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const { api } = await attach();
    await api.finish({
      callID: "call-ok",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child_ok",
      outputText: "done",
      status: "succeeded",
      mode: "background",
      endedAt: Date.now(),
    });
    expect(gate.parsed).toBeGreaterThan(0);
  }, 30_000);
});
