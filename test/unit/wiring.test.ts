import { describe, it, expect, vi } from "vitest";
import {
  applyDispatchCaveats,
  concurrentDispatchesCaveat,
  contaminatedBaselineCaveat,
  createSharedFlight,
  createVerificationWiring,
  extractAssistantText,
  HELD_RESULT_TEXT,
  noChangeGateSpawnsNothing,
} from "../../src/verify/wiring";
import { buildDelegationDoD, buildForcingNote, createChangedFileStore, type DispatchDelta } from "../../src/verify/dispatch";
import type { DoD } from "../../src/verify/dod";
import type { TestsPassRequest } from "../../src/verify/types";
import { preemptBackgroundVerification } from "../../src/verify/wiring";
import type { GateResult } from "../../src/verify/gate";
import type { RouterConfig } from "../../src/router/config";
import { unattributedRisk } from "../../src/verify/pending";
import type { CheckPlacement } from "../../src/verify/types";

// Phase 2.1: the reference GC test below records the order of keepReferences and gcStaleReferences; both pass through to the real
// module except the GC scan itself (no git in this unit test).
const refCalls = vi.hoisted(() => ({ order: [] as string[], kept: [] as string[][] }));
vi.mock("../../src/verify/reference", async importOriginal => {
  const real = await importOriginal<typeof import("../../src/verify/reference")>();
  return {
    ...real,
    keepReferences: (keys: Iterable<string>, opts?: Parameters<typeof real.keepReferences>[1]) => {
      refCalls.order.push("keep");
      refCalls.kept.push([...keys]);
      return real.keepReferences(keys, opts);
    },
    gcStaleReferences: async () => {
      refCalls.order.push("gc");
      return { removed: [], kept: [], failed: [] };
    },
  };
});

function cfg(over: Partial<RouterConfig> = {}): RouterConfig {
  return {
    activePreset: "alpha",
    defaultTier: "medium",
    rules: [],
    presets: { alpha: { fast: { model: "p/fast-m" }, heavy: { model: "p/heavy-m" } } },
    ...over,
  } as RouterConfig;
}

/** Records what the wiring asks of the opencode client. */
function fakeClient(over: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    session: {
      create: async (a: any) => {
        calls.push(["create", a]);
        return { data: { id: "SID1" } };
      },
      prompt: async (a: any) => {
        calls.push(["prompt", a]);
        return { data: { parts: [{ type: "text", text: "graded" }] } };
      },
      abort: async (a: any) => {
        calls.push(["abort", a]);
      },
      delete: async (a: any) => {
        calls.push(["delete", a]);
      },
      ...over,
    },
  };
}

function respondToPrompt(client: ReturnType<typeof fakeClient>, response: any): void {
  client.session.prompt = async (args: any) => {
    client.calls.push(["prompt", args]);
    return response;
  };
}

describe("reference GC at start (Phase 2.1, pending.jsonl reload)", () => {
  const refDir = "/tmp/omr-ref-4242-0123456789abcdef";
  const refRecord = {
    v: 1 as const,
    kind: "ref",
    handle: "vrf_0123456789abcdef01234567",
    callID: "call-1",
    reference: { root: "/d", head: "h", commit: "c", untracked: {}, tracked: {}, captureReasons: [], capturedAt: 1, links: { [`${refDir}/node_modules`]: "/d/node_modules" } },
  };

  it("keeps the reference dirs named by reloaded pending entries before the GC scans", async () => {
    refCalls.order.length = 0;
    refCalls.kept.length = 0;
    const w = createVerificationWiring({ client: fakeClient(), directory: "/d", getConfig: () => cfg(), pendingRestore: Promise.resolve([refRecord]), logger: { warn: () => undefined } });
    const cancel = w.startReferenceGc(0);
    await vi.waitFor(() => expect(refCalls.order).toContain("gc"));
    cancel();
    expect(refCalls.order).toEqual(["keep", "gc"]);
    expect(refCalls.kept).toEqual([[refDir]]);
  });

  it("scans anyway when the reload fails, and keeps nothing", async () => {
    refCalls.order.length = 0;
    refCalls.kept.length = 0;
    const w = createVerificationWiring({ client: fakeClient(), directory: "/d", getConfig: () => cfg(), pendingRestore: Promise.reject(new Error("unreadable")), logger: { warn: () => undefined } });
    const cancel = w.startReferenceGc(0);
    await vi.waitFor(() => expect(refCalls.order).toContain("gc"));
    cancel();
    expect(refCalls.order).toEqual(["gc"]);
  });
});

describe("leaseGate (Phase 2.1.5): a verification run waits for the tree's holders, then runs with the caveat", () => {
  const request: TestsPassRequest = {
    command: "pnpm test", cwd: process.cwd(), testScope: "affected", changedFiles: [], reference: { kind: "none", reason: "test" },
    deadline: { budgetMs: 60_000, remaining: () => 60_000, bound: ms => Math.min(ms, 60_000), signal: new AbortController().signal },
  };
  const run = (w: ReturnType<typeof createVerificationWiring>, prepared: Awaited<ReturnType<ReturnType<typeof createVerificationWiring>["prepareVerification"]>>) => {
    const hook = w.buildGateDeps("PARENT", undefined, prepared).deterministic.testsPass;
    if (hook === undefined) throw new Error("the gate deps carry no testsPass hook");
    return hook(request);
  };

  it("waits first, then runs the hook, and marks the dispatch with the holders that remain", { timeout: 15_000 }, async () => {
    const order: string[] = [];
    const waitTreeFree = vi.fn(async () => {
      order.push("wait");
      return { waitedMs: 5, holders: ["impl-1", "impl-2"], fileCount: 3 };
    });
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), leaseGate: { waitTreeFree }, logger: { warn: () => undefined } });
    const prepared = await w.prepareVerification(createChangedFileStore(), "lease-d", "child");
    expect(prepared.producerSessionID).toBe("child");
    await run(w, prepared);
    // QA-2.1-11: a probe (deadline 0) first, to see whether the producer's own holder is in the tree; neither holder is the
    // producer, so the event-driven wait then runs as before, with the time left, on the same tree and owner.
    expect(waitTreeFree).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["wait", "wait"]);
    const [probeTree, probeOwner, probeMs] = waitTreeFree.mock.calls[0] as unknown as [string, { producer: string }, number];
    const [tree, owner, deadlineMs] = waitTreeFree.mock.calls[1] as unknown as [string, { producer: string }, number];
    expect(typeof tree).toBe("string");
    expect(probeTree).toBe(tree);
    expect(probeOwner).toEqual({ producer: "PARENT" });
    expect(owner).toEqual({ producer: "PARENT" });
    expect(probeMs).toBe(0);
    expect(deadlineMs).toBeGreaterThan(0);
    // The caveat that applyDispatchCaveats turns into the "other delegations ran concurrently (2)" reason.
    expect(prepared.concurrentDispatches).toBe(2);
  });

  it("QA-2.1-11: the producer's own holder never delays its check and is no caveat", async () => {
    const waitTreeFree = vi.fn(async () => ({ waitedMs: 0, holders: ["child"], fileCount: 1 }));
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), leaseGate: { waitTreeFree }, logger: { warn: () => undefined } });
    const prepared = await w.prepareVerification(createChangedFileStore(), "lease-own", "child");
    await run(w, prepared);
    // One probe and no wait: the only holder is the producer ("child").
    expect(waitTreeFree).toHaveBeenCalledTimes(1);
    expect((waitTreeFree.mock.calls[0] as unknown as [string, { producer: string }, number])[2]).toBe(0);
    expect(prepared.concurrentDispatches ?? 0).toBe(0);
  });

  it("QA-2.1-11: with another holder next to the producer, it waits for that holder only, then counts no caveat", async () => {
    const answers = [["child", "impl-1"], ["child"]];
    let call = 0;
    const waitTreeFree = vi.fn(async () => {
      const holders = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return { waitedMs: 0, holders, fileCount: holders.length };
    });
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), leaseGate: { waitTreeFree }, logger: { warn: () => undefined } });
    const prepared = await w.prepareVerification(createChangedFileStore(), "lease-mixed", "child");
    await run(w, prepared);
    // Polled with probes only (an event-driven wait would also wait for the producer, until the deadline).
    expect(waitTreeFree.mock.calls.map(c => (c as unknown as [string, { producer: string }, number])[2])).toEqual([0, 0]);
    expect(prepared.concurrentDispatches ?? 0).toBe(0);
  });

  it("adds no caveat when the tree is free", async () => {
    const waitTreeFree = vi.fn(async () => ({ waitedMs: 0, holders: [], fileCount: 0 }));
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), leaseGate: { waitTreeFree }, logger: { warn: () => undefined } });
    const prepared = await w.prepareVerification(createChangedFileStore(), "lease-free", "child");
    await run(w, prepared);
    expect(waitTreeFree).toHaveBeenCalledTimes(1);
    expect(prepared.concurrentDispatches ?? 0).toBe(0);
  });

  it("still verifies when the wait throws", async () => {
    const warn = vi.fn();
    const waitTreeFree = vi.fn(async () => { throw new Error("registry gone"); });
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), leaseGate: { waitTreeFree }, logger: { warn } });
    const prepared = await w.prepareVerification(createChangedFileStore(), "lease-err", "child");
    expect(await run(w, prepared)).toBeDefined();
    expect(warn).toHaveBeenCalledWith("[verify] lease wait failed; verifying anyway", expect.objectContaining({ error: expect.stringContaining("registry gone") }));
  });
});

describe("router_verify and a held background result (QA-2.1-9)", () => {
  const session = "ses_parent_held";
  const passed = { verdict: { pass: true, outcome: "pass" as const, method: "deterministic" as const, reasons: [], caveats: [] }, retryable: false };

  function registerHeld(w: ReturnType<typeof createVerificationWiring>, callID: string): string {
    const handle = w.pending.reserveHandle(session);
    if (handle === undefined) throw new Error("no handle reserved");
    const reg = w.pending.register({
      orchestratorSessionID: session,
      dispatchID: callID,
      producerSessionID: `ses_child_${callID}`,
      producerTier: "fast",
      description: "held dispatch",
      cwd: process.cwd(),
      root: undefined,
      dispatchedAt: Date.now(),
      dod: buildDelegationDoD({ prompt: "Refactor the parser.\n[acceptance]\ncheck: testsPass\n[/acceptance]" }),
      reference: Promise.resolve({ kind: "none", reason: "held dispatch: the required gate captures its own reference" }),
      changedFiles: [],
      risk: unattributedRisk(),
      handle,
      hold: { childSessionID: `ses_child_${callID}`, callID },
    });
    if (!reg.ok) throw new Error(`held entry not registered: ${reg.code} ${reg.detail}`);
    return handle;
  }

  it("refuses a held entry its gate has not claimed yet: nothing runs, nothing is claimed, the entry stays held", async () => {
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), logger: { warn: () => undefined } });
    const handle = registerHeld(w, "call-held-1");
    const before = w.pending.get(session, handle);
    expect(before.kind === "found" ? before.entry.state : before.kind).toBe("held");
    const report = await w.verifyHandles(session, { kind: "handles", handles: [handle] });
    expect(report.items).toEqual([{ kind: "held", handle, description: "held dispatch" }]);
    expect(report.text).toContain(`- ${handle} \u00b7 held dispatch \u00b7 ${HELD_RESULT_TEXT}`);
    const looked = w.pending.get(session, handle);
    expect(looked.kind === "found" ? looked.entry.state : looked.kind).toBe("held");
    if (looked.kind === "found") expect(looked.entry.verifyingSince).toBeUndefined();
    // The background gate can still claim it afterwards: router_verify left no claim behind.
    expect(w.pending.markVerifying(session, handle).kind).toBe("claimed");
  });

  it("joins the held entry's gate once it claimed the entry, and replays the settled verdict afterwards", async () => {
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), logger: { warn: () => undefined } });
    const handle = registerHeld(w, "call-held-2");
    const claim = w.pending.markVerifying(session, handle);
    if (claim.kind !== "claimed") throw new Error(`expected the gate's claim, got ${claim.kind}`);
    const joined = w.verifyHandles(session, { kind: "handles", handles: [handle] });
    // The gate settles later (a macrotask), after router_verify reached its claim and joined the run in flight.
    const settled = new Promise<boolean>(done => setTimeout(() => done(claim.settle(passed)), 100));
    const report = await joined;
    expect(await settled).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ kind: "verdict", handle, via: "joined" });
    const again = await w.verifyHandles(session, { kind: "handles", handles: [handle] });
    expect(again.items[0]).toMatchObject({ kind: "verdict", handle, via: "cached" });
  });
});

describe("router_verify on a restored entry whose perimeter was not journaled (hadPerimeter)", () => {
  const session = "ses_parent_perimeter_lost";
  const handle = "vrf_0123456789abcdef0123abcd";
  const entryRecord = (over: Record<string, unknown> = {}) => ({
    v: 1 as const,
    kind: "entry",
    handle,
    parent: session,
    child: "ses_child_perimeter_lost",
    callID: "call-perimeter-lost",
    producer: "ses_child_perimeter_lost",
    tier: "fast",
    dod: buildDelegationDoD({ prompt: "Refactor the parser.\n[acceptance]\ncheck: testsPass\n[/acceptance]" }),
    // No change and a testsPass-only DoD: the gate would pass it without a process, so only the flag makes it unverifiable.
    changedFiles: [],
    changedFilesDropped: 0,
    reference: null,
    risk: unattributedRisk(),
    description: "cross-repo dispatch",
    root: null,
    cwd: process.cwd(),
    state: "unverified",
    createdAt: Date.now(),
    dispatchedAt: Date.now(),
    ...over,
  });

  it("settles UNVERIFIABLE with 'perimeter lost in restart', never a pass", async () => {
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), logger: { warn: () => undefined } });
    expect(w.pending.restore([entryRecord({ hadPerimeter: true })], { now: Date.now() }).restored).toBe(1);
    const report = await w.verifyHandles(session, { kind: "handles", handles: [handle] });
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      kind: "verdict", handle, via: "run",
      result: { retryable: false, verdict: { pass: false, outcome: "unverifiable", reasons: ["perimeter lost in restart"] } },
    });
    expect(report.text).toContain("perimeter lost in restart");
  });

  it("an old record without the flag is judged as before (control)", async () => {
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg(), logger: { warn: () => undefined } });
    expect(w.pending.restore([entryRecord()], { now: Date.now() }).restored).toBe(1);
    const report = await w.verifyHandles(session, { kind: "handles", handles: [handle] });
    expect(report.text).not.toContain("perimeter lost in restart");
  });
});

describe("noChangeGateSpawnsNothing (F13)", () => {
  const testsOnly: DoD = { kind: "deterministic", checks: [{ kind: "testsPass" }], criteria: [], deliverable: null, source: "explicit" };
  const placed = (scope?: "affected" | "full"): CheckPlacement => ({
    cwd: "/repo/pkg",
    top: "/repo",
    foreign: false,
    ...(scope !== undefined ? { scope } : {}),
  });

  it("false with a placed scope=full", () => {
    expect(noChangeGateSpawnsNothing(testsOnly, { placements: [placed("full")] })).toBe(false);
    const two: DoD = { ...testsOnly, checks: [{ kind: "testsPass" }, { kind: "testsPass" }] };
    expect(noChangeGateSpawnsNothing(two, { placements: [undefined, placed("full")] })).toBe(false);
  });

  it("false with fullScope", () => {
    expect(noChangeGateSpawnsNothing(testsOnly, { fullScope: true })).toBe(false);
    expect(noChangeGateSpawnsNothing(testsOnly, { fullScope: true, placements: [placed("affected")] })).toBe(false);
  });

  it("true otherwise (unchanged)", () => {
    expect(noChangeGateSpawnsNothing(testsOnly)).toBe(true);
    expect(noChangeGateSpawnsNothing(testsOnly, {})).toBe(true);
    expect(noChangeGateSpawnsNothing(testsOnly, { fullScope: false })).toBe(true);
    expect(noChangeGateSpawnsNothing(testsOnly, { placements: [placed("affected")] })).toBe(true);
    expect(noChangeGateSpawnsNothing(testsOnly, { placements: [placed()] })).toBe(true);
    expect(noChangeGateSpawnsNothing(testsOnly, { placements: [undefined] })).toBe(true);
    // The rest of the rule is as before: any other check or a criterion still means a process or a grader.
    expect(noChangeGateSpawnsNothing({ ...testsOnly, checks: [] })).toBe(false);
    expect(noChangeGateSpawnsNothing({ ...testsOnly, criteria: ["x"] })).toBe(false);
    expect(noChangeGateSpawnsNothing({ ...testsOnly, checks: [{ kind: "testsPass" }, { kind: "lintClean" }] })).toBe(false);
  });
});

describe("extractAssistantText", () => {
  it("joins the text parts", () => {
    expect(
      extractAssistantText({ data: { parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    ).toBe("a\nb");
  });

  it("skips non-text and malformed parts", () => {
    expect(
      extractAssistantText({
        data: { parts: [{ type: "tool" }, { type: "text", text: 5 }, { type: "text", text: "ok" }] },
      }),
    ).toBe("ok");
  });

  // Fail-closed: an empty string reads downstream as "the grader said nothing".
  it("returns an empty string for a missing or malformed body", () => {
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText({})).toBe("");
    expect(extractAssistantText({ data: {} })).toBe("");
  });
});

describe("dispatchGrader", () => {
  it("parents the grader session when a parent id is given", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }, "PARENT");
    expect(client.calls[0]).toEqual(["create", { body: { parentID: "PARENT" } }]);
  });

  it("omits parentID entirely when no parent is given", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[0]).toEqual(["create", { body: {} }]);
  });

  it("disposes the session it created, in order, on the happy path", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    const out = await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    // #84 P3.3 fix 2: the answer names the model the grader was dispatched on (the tier's model).
    expect(out).toEqual({ sessionID: "SID1", text: "graded", model: "p/fast-m" });
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("#84 P3.3 fix 2: a tier without a model leaves the grader on the host's default: its model is unknown (null)", async () => {
    const client = fakeClient();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    expect(await w.dispatchGrader({ tier: "medium", system: "s", prompt: "p" })).toEqual({ sessionID: "SID1", text: "graded", model: null });
  });

  // The dispose lives in a finally; a failing prompt must not leak the session.
  it("still disposes when the prompt throws", async () => {
    const client = fakeClient();
    client.session.prompt = async (args: any) => {
      client.calls.push(["prompt", args]);
      throw new Error("boom");
    };
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await expect(
      w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }),
    ).rejects.toThrow("boom");
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("reports a nested grader response error and disposes the session", async () => {
    const client = fakeClient();
    respondToPrompt(client, {
      data: {
        info: { error: { name: "APIError", data: { message: "api_key=supersecret Authorization: Basic dXNlcjpwYXNz password=anothersecret", statusCode: 400 } } },
        parts: [],
      },
      response: { status: 200 },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    let message = "";
    try {
      await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("grader prompt failed (400): SDK error");
    for (const credential of ["supersecret", "dXNlcjpwYXNz", "anothersecret"]) {
      expect(message).not.toContain(credential);
    }
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("reports a top-level grader response error with a failing HTTP status", async () => {
    const client = fakeClient();
    respondToPrompt(client, { error: { name: "UnknownError", message: "untrusted free-form text" }, response: { status: 500 } });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .rejects.toThrow("grader prompt failed (500): SDK error");
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("rejects a failing HTTP response even when its text looks like a passing verdict", async () => {
    const client = fakeClient();
    respondToPrompt(client, {
      data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
      response: { status: 500 },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .rejects.toThrow("grader prompt failed (500): SDK error");
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("prefers a failing HTTP status over a conflicting nested error status", async () => {
    const client = fakeClient();
    respondToPrompt(client, {
      data: { info: { error: { name: "APIError", data: { statusCode: 400, message: "request failed" } } }, parts: [] },
      response: { status: 503 },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .rejects.toThrow("grader prompt failed (503): SDK error");
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("uses a safe fallback for an invalid error name", async () => {
    const client = fakeClient();
    respondToPrompt(client, {
      error: { name: "Bad Error\napi_key=supersecret", message: "Authorization: Basic dXNlcjpwYXNz" },
      response: { status: 400 },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .rejects.toThrow(new Error("grader prompt failed (400): SDK error"));
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("never surfaces token-shaped error names", async () => {
    for (const name of ["sk-ABCDEFGHIJKLMNOPQRSTU1234567890", "api_key=supersecret"]) {
      const client = fakeClient();
      respondToPrompt(client, { error: { name }, response: { status: 400 } });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed (400): SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "omits non-finite nested error status %s",
    async (statusCode) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { info: { error: { data: { statusCode } } }, parts: [] },
        response: { status: 200 },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each([-1, 99, 200.5, 600])(
    "omits out-of-domain nested error status %s",
    async (statusCode) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { info: { error: { data: { statusCode } } }, parts: [] },
        response: { status: 200 },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "omits non-finite HTTP response status %s",
    async (status) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { info: { error: { name: "APIError" } }, parts: [] },
        response: { status },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a status-only malformed HTTP response %s before accepting its text",
    async (status) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
        response: { status },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each(["500", null])(
    "rejects a status-only HTTP response with invalid status %s before accepting its text",
    async (status) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
        response: { status },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each([0, -1, 99, 200.5, 600])(
    "rejects out-of-domain HTTP status %s before accepting its text",
    async (status) => {
      const client = fakeClient();
      respondToPrompt(client, {
        data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
        response: { status },
      });
      const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

      await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
        .rejects.toThrow(new Error("grader prompt failed: SDK error"));
      expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
    },
  );

  it.each([200, 399])("accepts a valid non-failing HTTP status %s", async (status) => {
    const client = fakeClient();
    respondToPrompt(client, {
      data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
      response: { status },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .resolves.toEqual({ sessionID: "SID1", text: '{"pass":true,"reasons":[]}', model: "p/fast-m" });
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it.each([400, 500])("reports a valid failing HTTP status %s", async (status) => {
    const client = fakeClient();
    respondToPrompt(client, {
      data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
      response: { status },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    await expect(w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" }))
      .rejects.toThrow(new Error(`grader prompt failed (${status}): SDK error`));
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
  });

  it("tracks the session as a grader only while it runs", async () => {
    // Hold the prompt open so the in-flight window is observable; the session is
    // not registered until session.create has resolved.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const client = fakeClient({
      prompt: async () => {
        await held;
        return { data: { parts: [{ type: "text", text: "graded" }] } };
      },
    });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });

    const p = w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.graderSessions.has("SID1")).toBe(true);

    release();
    await p;
    expect(w.graderSessions.has("SID1")).toBe(false);
  });

  it("returns empty when the backend creates no session", async () => {
    const client = fakeClient({ create: async () => ({ data: {} }) });
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    expect(await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" })).toEqual({
      sessionID: "",
      text: "",
      model: null,
    });
  });
});

describe("finishDeferred with the change set captured at child end (Phase 2.1.4.b)", () => {
  const dod = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] } as unknown as DoD;

  async function finish(delta: DispatchDelta | undefined) {
    const w = createVerificationWiring({ client: fakeClient(), directory: process.cwd(), getConfig: () => cfg() });
    const store = createChangedFileStore();
    const result = await w.finishDeferred(store, {
      dispatchID: "d1", orchestratorSessionID: "orch", producerSessionID: "child", producerTier: "fast", description: "background work",
      cwd: process.cwd(), dod, dispatchedAt: 1, ...(delta === undefined ? {} : { delta }),
    });
    return { result, entry: w.pending.findByDispatch("d1") };
  }

  it("a delta whose files are unavailable registers an unavailable change set (never an empty one) and high risk", async () => {
    const { result, entry } = await finish({ callID: "d1", childSessionID: "child", files: "unavailable", capturedAt: 1 });
    expect(result.deferred).toBe(true);
    expect(entry?.changedFiles).toBe("unavailable");
    expect(entry?.risk.level).toBe("high");
  });

  it("a contaminated delta is unavailable too", async () => {
    const { result, entry } = await finish({ callID: "d1", childSessionID: "child", files: "unavailable", contaminatedBy: "github_create_file", capturedAt: 1 });
    expect(result.deferred).toBe(true);
    expect(entry?.changedFiles).toBe("unavailable");
  });

  it("without a delta (the foreground path) nothing is read from it: the registration is the one the store implies", async () => {
    const { entry } = await finish(undefined);
    expect(entry === undefined || entry.changedFiles === "unavailable" || Array.isArray(entry.changedFiles)).toBe(true);
  });
});

describe("preemptBackgroundVerification (Phase 2.1)", () => {
  it("preempts the background queue of every live wiring, builds none when background is off, and never rejects", async () => {
    const on = createVerificationWiring({ client: fakeClient(), directory: "/d", getConfig: () => cfg({ enforcement: { verify: { background: true } } } as Partial<RouterConfig>) });
    const off = createVerificationWiring({ client: fakeClient(), directory: "/d", getConfig: () => cfg() });
    expect(off.background).toBeUndefined();
    const queue = on.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    const spy = vi.spyOn(queue, "preempt").mockResolvedValue(undefined);
    await preemptBackgroundVerification();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRejectedValueOnce(new Error("preempt failed"));
    await expect(preemptBackgroundVerification()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("disposeChildSession", () => {
  it("never throws, even when both calls fail", async () => {
    const client = {
      session: {
        abort: async () => {
          throw new Error("no");
        },
        delete: async () => {
          throw new Error("no");
        },
      },
    };
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => cfg() });
    await expect(w.disposeChildSession("X")).resolves.toBeUndefined();
  });
});

describe("config is read lazily", () => {
  // The regression this guards: cfg in index.ts is a `let` reassigned by
  // /preset, /budget and /router enforce. Capturing it at construction would
  // pin the grader to whatever was active when the plugin loaded.
  it("dispatchGrader picks up a model change made after construction", async () => {
    const client = fakeClient();
    let current = cfg();
    const w = createVerificationWiring({ client, directory: "/d", getConfig: () => current });

    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[1]![1].body.model).toEqual({ providerID: "p", modelID: "fast-m" });

    current = cfg({ presets: { alpha: { fast: { model: "q/switched-m" } } } } as never);
    await w.dispatchGrader({ tier: "fast", system: "s", prompt: "p" });
    expect(client.calls[5]![1].body.model).toEqual({
      providerID: "q",
      modelID: "switched-m",
    });
  });

  it("buildGateDeps picks up an enforcement change made after construction", () => {
    let current = cfg();
    const w = createVerificationWiring({
      client: fakeClient(),
      directory: "/d",
      getConfig: () => current,
    });
    expect(w.buildGateDeps().checker.minGraderTier).toBe(null);

    current = cfg({
      enforcement: { verify: { minGraderTier: "heavy" } },
    } as never);
    expect(w.buildGateDeps().checker.minGraderTier).toBe("heavy");
  });
});

describe("QA-3.1-2: applyDispatchCaveats on a rejection with introduced failures", () => {
  const verdictWith = (outcome: "pass" | "fail" | "unverifiable", introduced: string[]): GateResult => ({
    accepted: outcome === "pass",
    dodSource: "explicit",
    verdict: {
      pass: outcome === "pass",
      outcome,
      method: "deterministic",
      reasons: outcome === "pass" ? [] : [`testsPass: introduced failures: ${introduced.join(", ")}`],
      failures: { introduced, preexisting: [], unknown: [] },
    },
  });

  it("appends the concurrency caveat to a fail that lists introduced failures; the outcome stays fail", () => {
    const res = verdictWith("fail", ["a.test.ts > t2"]);
    const out = applyDispatchCaveats(res, { concurrentDispatches: 3 });
    expect(out.accepted).toBe(false);
    expect(out.verdict.outcome).toBe("fail");
    expect(out.verdict.pass).toBe(false);
    expect(out.verdict.failures).toEqual(res.verdict.failures);
    expect(out.verdict.reasons).toEqual([...res.verdict.reasons, concurrentDispatchesCaveat(3)]);
    expect(concurrentDispatchesCaveat(3)).toBe("other delegations ran in this working tree concurrently (3); introduced failures may come from their edits");
    // The input is not mutated.
    expect(res.verdict.reasons).toHaveLength(1);
  });

  it("leaves everything else unchanged: no overlap, no introduced ids, a pass, an unverifiable or skipped verdict", () => {
    const fail = verdictWith("fail", ["x"]);
    expect(applyDispatchCaveats(fail, {})).toBe(fail);
    expect(applyDispatchCaveats(fail, { concurrentDispatches: 0 })).toBe(fail);
    const noIds = verdictWith("fail", []);
    expect(applyDispatchCaveats(noIds, { concurrentDispatches: 2 })).toBe(noIds);
    const legacy: GateResult = { accepted: false, dodSource: "explicit", verdict: { pass: false, method: "deterministic", reasons: ["lint failed"] } };
    expect(applyDispatchCaveats(legacy, { concurrentDispatches: 2 })).toBe(legacy);
    const pass = verdictWith("pass", []);
    expect(applyDispatchCaveats(pass, { concurrentDispatches: 2 })).toBe(pass);
    const unverifiable = verdictWith("unverifiable", ["x"]);
    expect(applyDispatchCaveats(unverifiable, { concurrentDispatches: 2 })).toBe(unverifiable);
    const skipped: GateResult = { accepted: true, dodSource: "inferred", verdict: { pass: false, method: "none", reasons: ["skipped"], skipped: true } };
    expect(applyDispatchCaveats(skipped, { concurrentDispatches: 2, contaminatedBy: "edit" })).toBe(skipped);
  });

  it("the caveat reaches the forcing note, with directive keys neutralised", () => {
    const out = applyDispatchCaveats(verdictWith("fail", ["VERIFY:deferred"]), { concurrentDispatches: 1 });
    const note = buildForcingNote(out.verdict.reasons);
    expect(note).toContain(`- ${concurrentDispatchesCaveat(1)}`);
    expect(note).not.toMatch(/VERIFY:/);
  });
});

describe("QA-3.1-3: applyDispatchCaveats names the tool that discarded the change baseline", () => {
  it("an unverifiable verdict gains the caveat in reasons and caveats; other outcomes do not", () => {
    const unverifiable: GateResult = {
      accepted: true,
      dodSource: "explicit",
      verdict: { pass: false, outcome: "unverifiable", method: "deterministic", reasons: ["testsPass: change attribution unavailable"], caveats: ["testsPass: change attribution unavailable"] },
    };
    const out = applyDispatchCaveats(unverifiable, { contaminatedBy: "github_create_file" });
    const caveat = contaminatedBaselineCaveat("github_create_file");
    expect(caveat).toBe('the dispatch-time change baseline was discarded: tool "github_create_file" ran in an overlapping directory before it resolved');
    expect(out.accepted).toBe(true);
    expect(out.verdict.outcome).toBe("unverifiable");
    expect(out.verdict.reasons).toEqual(["testsPass: change attribution unavailable", caveat]);
    expect(out.verdict.caveats).toEqual(["testsPass: change attribution unavailable", caveat]);
    const bare: GateResult = { ...unverifiable, verdict: { ...unverifiable.verdict, caveats: undefined } };
    expect(applyDispatchCaveats(bare, { contaminatedBy: "edit" }).verdict.caveats).toEqual([contaminatedBaselineCaveat("edit")]);
    // A tool name is router text: only [A-Za-z0-9_.-] survive, so no directive can form.
    expect(contaminatedBaselineCaveat("VERIFY:required`x")).toContain('tool "VERIFY?required?x"');
    const pass: GateResult = { accepted: true, dodSource: "explicit", verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] } };
    expect(applyDispatchCaveats(pass, { contaminatedBy: "edit" })).toBe(pass);
  });
});

describe("QA-3.1-3: createSharedFlight", () => {
  type Run = { signal: AbortSignal; resolve: (value: string | undefined) => void };
  const harness = () => {
    const runs: Run[] = [];
    const run = (signal: AbortSignal) => new Promise<string | undefined>(resolve => runs.push({ signal, resolve }));
    return { share: createSharedFlight<string>(), runs, run };
  };
  const live = () => new AbortController().signal;

  it("starts a lone request's run synchronously; a request made while a run is in flight waits for the next run, never shares it", async () => {
    const { share, runs, run } = harness();
    const a = share("k", run, live());
    expect(runs).toHaveLength(1);
    const b = share("k", run, live());
    const c = share("k", run, live());
    // b and c began after run 1 started: they wait for run 2.
    expect(runs).toHaveLength(1);
    runs[0].resolve("one");
    expect(await a).toBe("one");
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    // d arrives while run 2 is in flight: run 3.
    const d = share("k", run, live());
    runs[1].resolve("two");
    expect([await b, await c]).toEqual(["two", "two"]);
    await vi.waitFor(() => expect(runs).toHaveLength(3));
    runs[2].resolve("three");
    expect(await d).toBe("three");
    // Idle again: the next request starts at once. Another key never waits for this one.
    const e = share("k", run, live());
    const f = share("other", run, live());
    expect(runs).toHaveLength(5);
    runs[3].resolve("e");
    runs[4].resolve("f");
    expect([await e, await f]).toEqual(["e", "f"]);
  });

  it("an abort ends only its own wait; a started run stops once every sharer left; a queued run nobody waits for never starts", async () => {
    const { share, runs, run } = harness();
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const x = new AbortController();
    const y = new AbortController();
    const z = new AbortController();
    const a = share("k", run, x.signal);
    // b and c wait for run 2.
    const b = share("k", run, y.signal);
    const c = share("k", run, z.signal);
    y.abort();
    expect(await b).toBeUndefined();
    // a was run 1's only sharer: its abort stops run 1.
    expect(runs[0].signal.aborted).toBe(false);
    x.abort();
    expect(await a).toBeUndefined();
    expect(runs[0].signal.aborted).toBe(true);
    runs[0].resolve(undefined);
    // Run 2 starts for c, the sharer left; c's abort then stops it.
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    expect(runs[1].signal.aborted).toBe(false);
    z.abort();
    expect(await c).toBeUndefined();
    expect(runs[1].signal.aborted).toBe(true);
    runs[1].resolve(undefined);
    await flush();

    // A queued run whose every sharer left before it could start is never started.
    const first = share("k", run, live());
    expect(runs).toHaveLength(3);
    const q = new AbortController();
    const queued = share("k", run, q.signal);
    q.abort();
    expect(await queued).toBeUndefined();
    runs[2].resolve("first");
    expect(await first).toBe("first");
    await flush();
    expect(runs).toHaveLength(3);
    // The lane is idle: a new request starts its own run at once.
    const g = share("k", run, live());
    expect(runs).toHaveLength(4);
    runs[3].resolve("g");
    expect(await g).toBe("g");
    // An already aborted request starts and joins nothing.
    const gone = new AbortController();
    gone.abort();
    expect(await share("k", run, gone.signal)).toBeUndefined();
    expect(runs).toHaveLength(4);
  });

  it("QA-3.1-24: a started run that ignores its abort is detached once its last sharer left, so the queued run starts at once", async () => {
    const { share, runs, run } = harness();
    const x = new AbortController();
    const a = share("k", run, x.signal);
    const b = share("k", run, live());
    expect(runs).toHaveLength(1);
    x.abort();
    expect(await a).toBeUndefined();
    expect(runs[0].signal.aborted).toBe(true);
    // Run 1 never settles, yet b's run starts without waiting for it.
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1].resolve("two");
    expect(await b).toBe("two");
    // The lane is idle again; the stuck run settling late changes nothing.
    const c = share("k", run, live());
    expect(runs).toHaveLength(3);
    runs[0].resolve("late");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(runs).toHaveLength(3);
    runs[2].resolve("three");
    expect(await c).toBe("three");
    // With no queued run, a detached lane is idle: the next request starts its own run at once.
    const y = new AbortController();
    void share("k", run, y.signal);
    expect(runs).toHaveLength(4);
    y.abort();
    const d = share("k", run, live());
    expect(runs).toHaveLength(5);
    runs[4].resolve("d");
    expect(await d).toBe("d");
  });

  it("a run that rejects or throws resolves every sharer with undefined, and the next run still starts", async () => {
    const share = createSharedFlight<string>();
    let reject: (e: Error) => void = () => undefined;
    const first = share("k", () => new Promise<string>((_ok, fail) => { reject = fail; }), live());
    const second = share("k", () => { throw new Error("sync failure"); }, live());
    reject(new Error("git failed"));
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(await share("k", async () => "ok", live())).toBe("ok");
  });
});
