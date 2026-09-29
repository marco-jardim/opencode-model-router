import { describe, it, expect, vi } from "vitest";
import {
  applyDispatchCaveats,
  concurrentDispatchesCaveat,
  contaminatedBaselineCaveat,
  createSharedFlight,
  createVerificationWiring,
  extractAssistantText,
} from "../../src/verify/wiring";
import { buildForcingNote } from "../../src/verify/dispatch";
import type { GateResult } from "../../src/verify/gate";
import type { RouterConfig } from "../../src/router/config";

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
    expect(out).toEqual({ sessionID: "SID1", text: "graded" });
    expect(client.calls.map((c) => c[0])).toEqual(["create", "prompt", "abort", "delete"]);
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
      .resolves.toEqual({ sessionID: "SID1", text: '{"pass":true,"reasons":[]}' });
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
    });
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
