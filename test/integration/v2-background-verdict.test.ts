/**
 * Phase 2.1 QA round 1: the verdict a background completion ends in, through the real plugin's finish API (src/index.ts) as the
 * v2 adapter attaches it.
 *
 * - QA-2.1-1: a held dispatch whose gate gives no verdict (verification not required, a read-only skip, a deferral, an error)
 *   posts UNVERIFIABLE with a reason, never PASS.
 * - QA-2.1-5: a child that did not succeed is never verified: `finish` returns no verification and the gate does not run.
 * - QA-2.1-9 / QA-2.1-11 (the pieces router_verify and the gate use): a held entry's report line; the producer-aware lease wait.
 * - QA-DF1-16: a held gate's verdict settles as the gate reached it (method, outcome, reasons, caveats), so router_verify on the
 *   held handle reports what the posted text says; the held gate's grader launches from the orchestrator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import { ROUTER_FINISH_ATTACH, type FinishApi, type HeldSink } from "../../src/compat/background";
import { invalidateConfigCache } from "../../src/router/config";
import { backgroundOutcomes, formatVerifyReport, HELD_RESULT_TEXT, waitTreeFreeExcept } from "../../src/verify/wiring";
import { removeDirWhenReleased } from "../helpers/remove-dir";
import { bootBgHost, restoreEnv, type BgHost, type NativeSubagentStub } from "../helpers/v2-bg-host";

const gate = vi.hoisted(() => ({ parsed: 0, passCaveat: undefined as string | undefined, trivialSessions: new Set<string>() }));

// QA-DF1-29: the real session store; a child session in `trivialSessions` reads as classified trivial at dispatch.
vi.mock("../../src/router/sessions", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/router/sessions")>();
  return {
    ...actual,
    createSessionStore: (...args: Parameters<typeof actual.createSessionStore>) => {
      const store = actual.createSessionStore(...args);
      const isTrivial = store.isTrivial.bind(store);
      store.isTrivial = (sessionID: string) => gate.trivialSessions.has(sessionID) || isTrivial(sessionID);
      return store;
    },
  };
});

// QA-DF1-16: the real checker (its grader launches through the test's runner); with `passCaveat` set, its pass carries that
// caveat (a pass with caveats, which the gate lets through as `⚠ UNVERIFIED`).
vi.mock("../../src/verify/checker", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/checker")>();
  return {
    ...actual,
    runChecker: async (...args: Parameters<typeof actual.runChecker>) => {
      const verdict = await actual.runChecker(...args);
      const caveat = gate.passCaveat;
      return caveat !== undefined && verdict.outcome === "pass" ? { ...verdict, caveats: [...(verdict.caveats ?? []), caveat] } : verdict;
    },
  };
});

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
  gate.passCaveat = undefined;
  gate.trivialSessions.clear();
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

/** QA-DF1-16: the plugin's own `router_verify` tool on one handle of the orchestrator's session, as the model calls it. */
async function routerVerify(hooks: Hooks, handle: string): Promise<string> {
  const verify = hooks.tool?.router_verify;
  if (verify === undefined) throw new Error("the plugin registers no router_verify tool");
  const context = { sessionID: "ses_parent", messageID: "msg_df116", agent: "build", abort: new AbortController().signal };
  const result: unknown = await verify.execute({ handles: [handle] }, context as unknown as Parameters<typeof verify.execute>[1]);
  return typeof result === "string" ? result : JSON.stringify(result);
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

/**
 * DF-1.1-1: the background completion through the REAL v2 adapter (its completion processor and finish wrapper) and the REAL v2
 * child runner (`createV2Runtime`): the grader reaches the host's native `subagent` tool in the tool context of the CALLER
 * (the orchestrator agent whose `subagent:<grader>` permission the host checks), never the dispatched child's.
 */
describe("DF-1.1-1 a background completion's grader launches as the caller agent", () => {
  const ORCH = "ses_orch_df111";
  const CHILD = "ses_child_df111";
  const criteriaPrompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
  let bg: BgHost | undefined;

  afterEach(async () => {
    await bg?.dispose();
    bg = undefined;
    restoreEnv();
  });

  it("DF-1.1-1 a background `fast` dispatch from `build`: the grader reaches the native subagent with agent `build` (never `fast`, never undefined)", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const stub: NativeSubagentStub = { calls: [] }; // answers every call with the host's denial (the DF-1.1-1 symptom)
    const h = await bootBgHost({
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: { agent: "build" }, [CHILD]: { parentID: ORCH } },
      nativeSubagent: stub,
    });
    bg = h;
    execFileSync("git", ["init", "-q"], { cwd: h.project }); // a work tree the gate can prepare its verification in
    h.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await h.drain();
    const call = await h.before({
      sessionID: ORCH, agent: "build", messageID: "m-df111", id: "call-df111-bg", tool: "subagent",
      input: { agent: "fast", description: "explain the parser", prompt: criteriaPrompt, background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await h.after({ ...call, status: "completed", result: running });
    await h.settled();
    // The child ends: the completion processor reads its text and finishes it (the gate, then the grader).
    h.childContext.set(CHILD, [{ role: "assistant", content: [{ type: "text", text: "The parser starts in parse()." }], finish: "stop", time: { created: 1, completed: 2 } }]);
    h.emit({ type: "session.execution.succeeded", id: `ev-end-${CHILD}-succeeded`, created: 2, data: { sessionID: CHILD } });
    await h.drain();
    await vi.waitFor(() => expect(stub.calls.length).toBeGreaterThan(0), { timeout: 25_000 });
    await h.settled();
    for (const launched of stub.calls) {
      expect(launched.agent).toBe("build");
      expect(launched.sessionID).toBe(ORCH);
    }
  }, 30_000);
});

type Launched = { parentSessionID?: string };

/** QA-DF1-29: the user's overrides layer (as delegate-timeout.test.ts writes it); read by the next attach. */
function writeRouterConfig(overrides: Record<string, unknown>): void {
  const file = join(home, ".config", "opencode", "opencode-model-router.overrides.jsonc");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(overrides), "utf-8");
  invalidateConfigCache();
}

/** QA-DF1-16: a held background dispatch through the real before hook and finish API; the grader answers through `answer`. */
async function heldGraderRun(callID: string, answer: () => Promise<{ sessionID: string; text: string }>) {
  process.env.MODEL_ROUTER_ENFORCE = "1";
  execFileSync("git", ["init", "-q"], { cwd: home }); // a work tree the gate can prepare its verification in
  const launched: Launched[] = [];
  const runner = {
    run: async (request: Launched) => {
      launched.push(request);
      return answer();
    },
    dispose: async () => undefined,
  };
  const { api, posted, hooks } = await attach(runner);
  const prompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
  const before = hooks["tool.execute.before"] as unknown as ((input: unknown, output: unknown) => Promise<void>) | undefined;
  await before?.({ tool: "task", sessionID: "ses_parent", callID }, { args: { subagent_type: "fast", description: "explain the parser", prompt } })
    .catch(() => undefined);
  const handle = api.reserveHeld("ses_parent", callID);
  if (handle === undefined) throw new Error("no handle reserved");
  const result = await api.finish({
    callID,
    parentSessionID: "ses_parent",
    childSessionID: `ses_child_${callID}`,
    outputText: "The parser starts in parse().",
    status: "succeeded",
    mode: "background",
    heldHandle: handle,
    endedAt: Date.now(),
  });
  expect(result.verification).toEqual({ kind: "held", handle });
  await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 25_000 });
  return { api, handle, launched, posted, hooks };
}

describe("QA-DF1-16 a held gate verdict is settled as the gate reached it", () => {
  it("QA-DF1-16 a checker result that could not be verified: the grader launches from the orchestrator; router_verify reports the gate's method and reason", async () => {
    const { handle, launched, posted, hooks } = await heldGraderRun("call-df116-a", async () => {
      throw new Error("Tool.Error: Subagent denied: model-router-grader");
    });
    expect(launched.length).toBeGreaterThan(0);
    for (const request of launched) expect(request.parentSessionID).toBe("ses_parent");
    expect(posted[0]).toMatchObject({ handle, verdict: "UNVERIFIABLE" });
    expect(posted[0].text).toContain("[router \u26a0 UNVERIFIED: checker]");
    const text = await routerVerify(hooks, handle);
    // The settled held entry's verdict, reported (nothing is run again) with the gate's outcome and method, and the grader's
    // reason (an unverifiable checker result carries it as a caveat).
    expect(text).toContain(`- ${handle} \u00b7 `);
    expect(text).toContain(" \u00b7 unverifiable (cached verdict; nothing was run)");
    expect(text).toContain("[router \u26a0 UNVERIFIED: checker]");
    expect(text).toContain("Verification caveats");
    expect(text).toContain("grader dispatch failed");
    expect(text).not.toContain("deterministic");
    expect(text).not.toContain("\u2713 verified");
  }, 30_000);

  // The gate's pass with caveats (the posted text reads `⚠ UNVERIFIED`); `heldVerification` used to settle it as a clean pass.
  it("QA-DF1-16 a pass with caveats: router_verify reports it UNVERIFIED with its caveats, as the posted text does (never \u2713 verified)", async () => {
    gate.passCaveat = "the grader saw only the final text (QA-DF1-16 caveat)";
    const { handle, launched, posted, hooks } = await heldGraderRun("call-df116-b", async () => ({
      sessionID: "ses_grader_df116_b",
      text: JSON.stringify({ pass: true, reasons: ["the explanation names parse()"] }),
    }));
    expect(launched.length).toBeGreaterThan(0);
    for (const request of launched) expect(request.parentSessionID).toBe("ses_parent");
    expect(posted[0]).toMatchObject({ handle, verdict: "PASS" });
    expect(posted[0].text).toContain("[router \u26a0 UNVERIFIED: checker]");
    expect(posted[0].text).toContain("QA-DF1-16 caveat");
    const text = await routerVerify(hooks, handle);
    expect(text).toContain(" \u00b7 pass (cached verdict; nothing was run)");
    expect(text).toContain("[router \u26a0 UNVERIFIED: checker]");
    expect(text).toContain("Verification caveats");
    expect(text).toContain("QA-DF1-16 caveat");
    expect(text).not.toContain("\u2713 verified");
    expect(text).not.toContain("deterministic");
  }, 30_000);
});

// QA-DF1-29: readers re-derive a tag from the stored pass/outcome (router_verify through gateResult, the restart re-post through
// heldVerdictKind); the stored verdict must give the tag the gate's decision posted.
describe("QA-DF1-29 a held entry's stored pass/outcome match its posted tag", () => {
  // The gate accepts a trivial dispatch with an auto-inferred DoD without verifying it ({ accepted: true, pass: false,
  // skipped: true }, gate.ts); the held dispatch posts PASS, and router_verify must not re-derive FAIL from the raw verdict.
  // The child changed a file, so the read-only skip (an inferred criteria-only DoD, no files changed) is not taken.
  it("QA-DF1-29 a trivial background dispatch: router_verify shows pass", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    execFileSync("git", ["init", "-q"], { cwd: home });
    const { api, posted, hooks } = await attach();
    const callID = "call-df129-a";
    gate.trivialSessions.add(`ses_child_${callID}`); // classified trivial at dispatch
    const before = hooks["tool.execute.before"] as unknown as ((input: unknown, output: unknown) => Promise<void>) | undefined;
    await before?.({ tool: "task", sessionID: "ses_parent", callID }, { args: { subagent_type: "fast", description: "fix the failing test", prompt: "Fix the failing test in a.test.ts so the tests pass." } })
      .catch(() => undefined);
    // The child's change (not a read-only delegation): its `write` call through the plugin's tool hooks, then the file itself.
    const after = hooks["tool.execute.after"] as unknown as ((input: unknown, output: unknown) => Promise<void>) | undefined;
    const writeCall = { tool: "write", sessionID: `ses_child_${callID}`, callID: `${callID}-write`, args: { filePath: join(home, "a.ts"), content: "export const count = 1;\n" } };
    await before?.(writeCall, { args: writeCall.args }).catch(() => undefined);
    writeFileSync(join(home, "a.ts"), "export const count = 1;\n");
    await after?.(writeCall, { title: "", output: "Wrote file successfully.", metadata: {} }).catch(() => undefined);
    const handle = api.reserveHeld("ses_parent", callID);
    if (handle === undefined) throw new Error("no handle reserved");
    // The change set frozen at child end (the adapter's captureDelta): the child wrote a.ts. (The held gate's change set is the
    // change-file store's; this delta is the pending entry's.)
    const delta = { callID, childSessionID: `ses_child_${callID}`, files: [{ path: join(home, "a.ts"), status: "written" }], capturedAt: Date.now() };
    const result = await api.finish({
      callID,
      parentSessionID: "ses_parent",
      childSessionID: `ses_child_${callID}`,
      outputText: "Renamed x to count.",
      status: "succeeded",
      mode: "background",
      heldHandle: handle,
      delta,
      endedAt: Date.now(),
    });
    expect(result.verification).toEqual({ kind: "held", handle });
    await vi.waitFor(() => expect(posted).toHaveLength(1), { timeout: 25_000 });
    expect(gate.parsed).toBeGreaterThan(0);
    expect(posted[0], posted[0].reason).toMatchObject({ handle, verdict: "PASS" });
    const text = await routerVerify(hooks, handle);
    expect(text).toContain(`- ${handle} \u00b7 `);
    expect(text).toContain(" \u00b7 pass (cached verdict; nothing was run)");
    expect(text).not.toContain(" \u00b7 fail");
    expect(text).not.toContain("NOT ACCEPTED");
    // QA-DF1-30 (QA-3.1-21): a skipped check is accepted unverified, never labelled verified.
    expect(text).toContain("[router \u26a0 UNVERIFIED: none]");
    expect(text).not.toContain("\u2713 verified");
  }, 30_000);

  // strictUnverifiable rejects a pass with caveats (gate.ts): the held dispatch posts FAIL. A restart between the store and the
  // post re-posts the stored verdict (finishRestored, a `settled` entry), which must say FAIL as well, never PASS.
  it("QA-DF1-29 strictUnverifiable pass with caveats: the restart re-post says FAIL", async () => {
    writeRouterConfig({ enforcement: { verify: { strictUnverifiable: true } } });
    gate.passCaveat = "the grader saw only the final text (QA-DF1-29 caveat)";
    const { api, handle, launched, posted } = await heldGraderRun("call-df129-b", async () => ({
      sessionID: "ses_grader_df129_b",
      text: JSON.stringify({ pass: true, reasons: ["the explanation names parse()"] }),
    }));
    expect(launched.length).toBeGreaterThan(0);
    // The gate rejected the pass (strictUnverifiable, a caveat): the posted tag is FAIL.
    expect(posted[0]).toMatchObject({ handle, verdict: "FAIL" });
    // The restart re-post (finishRestored): the held dispatch finished again as restored finds its settled entry and posts the
    // tag of what was stored (heldVerdictKind), as a new process does after the journal's `state` record.
    const again = await api.finish({
      callID: "call-df129-b",
      parentSessionID: "ses_parent",
      childSessionID: "ses_child_call-df129-b",
      outputText: "The parser starts in parse().",
      status: "succeeded",
      mode: "background",
      heldHandle: handle,
      restored: {},
      endedAt: Date.now(),
    });
    expect(again.verification).toEqual({ kind: "held", handle });
    await vi.waitFor(() => expect(posted).toHaveLength(2), { timeout: 10_000 });
    expect(posted[1]).toMatchObject({ handle, verdict: "FAIL" });
    expect(posted[1].text).toContain("[router] FAIL");
    expect(posted[1].text).not.toContain("[router] PASS");
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
