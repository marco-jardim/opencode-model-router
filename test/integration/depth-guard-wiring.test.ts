import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { ChildSessionRequest, RouterPluginInput } from "../../src/compat/child-session";
import { DEPTH_BANNER, TASK_VERIFICATION } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { depthAdvisoryBanner, depthLimitMessage } from "../../src/router/depth-guard";
import { DEFAULT_DEPTH_TIMEOUT_MS } from "../../src/router/depth";

const captured = vi.hoisted(() => ({
  pending: undefined as ReturnType<typeof import("../../src/verify/wiring").createVerificationWiring>["pending"] | undefined,
}));
const observed = vi.hoisted(() => ({
  startDispatch: vi.fn(), prepareVerification: vi.fn(),
  observeEdit: vi.fn(), record: vi.fn(), clear: vi.fn(),
}));
vi.mock("../../src/verify/wiring", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/verify/wiring")>();
  return { ...original, createVerificationWiring: (...args: Parameters<typeof original.createVerificationWiring>) => {
    const wiring = original.createVerificationWiring(...args);
    captured.pending = wiring.pending;
    return { ...wiring,
      startDispatch: (...params: Parameters<typeof wiring.startDispatch>) => {
        observed.startDispatch();
        return wiring.startDispatch(...params);
      },
      prepareVerification: (...params: Parameters<typeof wiring.prepareVerification>) => {
        observed.prepareVerification();
        return wiring.prepareVerification(...params);
      },
    };
  } };
});
vi.mock("../../src/verify/dispatch", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/verify/dispatch")>();
  return { ...original, createChangedFileStore: (...args: Parameters<typeof original.createChangedFileStore>) => {
    const store = original.createChangedFileStore(...args);
    return { ...store,
      observeEdit: (...params: Parameters<typeof store.observeEdit>) => { observed.observeEdit(); return store.observeEdit(...params); },
      record: (...params: Parameters<typeof store.record>) => { observed.record(); return store.record(...params); },
      clear: (...params: Parameters<typeof store.clear>) => { observed.clear(); return store.clear(...params); },
    };
  } };
});

type Hook = (input: unknown, output?: unknown) => Promise<void>;
type TestHooks = Record<string, Hook> & {
  dispose(): Promise<void>;
  tool: { delegate: { execute(args: { task: string; tier?: string; acceptance?: string }, ctx?: { sessionID?: string }): Promise<string> } };
};

function makeCtx(dir: string) {
  const get = vi.fn(async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: undefined as string | undefined } }));
  let counter = 0;
  const create = vi.fn(async (_opts: { body?: { parentID?: string } }): Promise<{ data: { id?: string } }> => ({ data: { id: `producer-${counter++}` } }));
  const prompt = vi.fn(async (_opts: { path: { id: string }; body: { system?: string; parts?: { text?: string }[] } }) => ({
    data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] },
  }));
  return { directory: dir, worktree: dir, client: { session: { get, create, prompt, delete: vi.fn(async () => ({})) } } };
}

describe("delegation depth plugin wiring", () => {
  let dir: string;
  const instances: TestHooks[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "depth-wiring-"));
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    vi.clearAllMocks();
    invalidateConfigCache();
  });

  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    invalidateConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(ctx: ReturnType<typeof makeCtx> & Pick<RouterPluginInput, "routerChildRunner" | "routerHost"> = makeCtx(dir)) {
    const hooks = await ModelRouterPlugin(ctx as unknown as RouterPluginInput) as unknown as TestHooks;
    instances.push(hooks);
    return { hooks, get: ctx.client.session.get };
  }

  function configure(enforcement: Record<string, unknown>) {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ enforcement }));
    invalidateConfigCache();
  }

  async function created(hooks: TestHooks, id: string, parentID?: string) {
    await hooks.event({ event: { type: "session.created", properties: { info: { id, parentID } } } });
  }

  async function seed(hooks: TestHooks) {
    await hooks["experimental.chat.system.transform"]({ sessionID: "O", model: {} }, { system: [] });
    await created(hooks, "C", "O");
  }

  const taskInput = (sessionID = "C", callID: string | undefined = "call") => ({ tool: "task", sessionID, callID });
  const taskOutput = () => ({ args: { prompt: "inspect the project", subagent_type: "fast" } });
  const countBanners = (text: string) => (text.match(/GUARD:delegation_depth/g) ?? []).length;
  const delegateArgs = { task: "VERIFY:required\nDo the work", tier: "fast", acceptance: "[acceptance]\ncriteria: correct\n[/acceptance]" };

  for (const mode of ["enforced", "advisory"] as const) {
    describe(mode, () => {
      beforeEach(() => { vi.stubEnv("MODEL_ROUTER_ENFORCE", mode === "enforced" ? "1" : ""); });

      async function dispatch(hooks: TestHooks, sid = "C", depth = 1, max = 1, callID = "call", args = taskOutput().args) {
        const input = taskInput(sid, callID);
        const before = { args };
        if (mode === "enforced") {
          const unchanged = { ...args };
          await expect(hooks["tool.execute.before"](input, before)).rejects.toThrow(depthLimitMessage(depth, max));
          expect(before.args).toEqual(unchanged);
          expect(TASK_VERIFICATION in before).toBe(false);
        } else {
          await hooks["tool.execute.before"](input, before);
          const after = { output: "producer output" };
          await hooks["tool.execute.after"]({ ...input, args: before.args }, after);
          expect(countBanners(after.output)).toBe(1);
          expect(after.output).toContain(depthAdvisoryBanner(depth, max));
        }
      }

      it("allows a seeded root without a second backend lookup", async () => {
        const { hooks, get } = await setup();
        await seed(hooks);
        const input = taskInput("O");
        await hooks["tool.execute.before"](input, taskOutput());
        const out = { output: "done" };
        await hooks["tool.execute.after"](input, out);
        expect(countBanners(out.output)).toBe(0);
        expect(get).toHaveBeenCalledTimes(1);
      });

      it("guards a created child before verification, prompt edits or file-store writes", async () => {
        const { hooks } = await setup();
        await seed(hooks);
        vi.clearAllMocks();
        await dispatch(hooks);
        if (mode === "enforced") {
          for (const spy of Object.values(observed)) expect(spy).not.toHaveBeenCalled();
        }
      });

      it("records refused attempts even when the caller is known only to the backend", async () => {
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: { id: path.id, parentID: path.id === "C" ? "O" : undefined } }));
        const { hooks } = await setup(ctx);
        await dispatch(hooks);
        const handback = (sid: string) => ({ output: `task_id: ${sid}\n<task_result>NEED CONTEXT: I cannot dispatch; handing back because tools are unavailable.</task_result>`, metadata: { sessionId: sid } });
        const out = handback("C");
        await hooks["tool.execute.after"](taskInput("O", "return"), out);
        // Advisory's after-hook is not tracked for this backend-only caller; D4 applies to blocks.
        if (mode === "enforced") expect(out.output).not.toContain("FALSE-REFUSAL SUSPECT");
        const control = handback("untouched");
        await hooks["tool.execute.after"](taskInput("O", "control"), control);
        expect(control.output).toContain("FALSE-REFUSAL SUSPECT");
      });

      it("allows depth one at limit two and guards depth two", async () => {
        configure({ maxDelegationDepth: 2 });
        const { hooks } = await setup();
        await seed(hooks);
        await created(hooks, "G", "C");
        await hooks["tool.execute.before"](taskInput(), taskOutput());
        const out = { output: "done" };
        await hooks["tool.execute.after"](taskInput(), out);
        expect(countBanners(out.output)).toBe(0);
        await dispatch(hooks, "G", 2, 2);
      });

      it.each(["null", "off"])("%s skips depth lookup and banner delivery", async (disabled) => {
        if (disabled === "null") configure({ maxDelegationDepth: null });
        else vi.stubEnv("MODEL_ROUTER_ENFORCE", "0");
        const { hooks, get } = await setup();
        await hooks["tool.execute.before"](taskInput(), taskOutput());
        const out = { output: "done" };
        await hooks["tool.execute.after"](taskInput(), out);
        expect(get).not.toHaveBeenCalled();
        expect(countBanners(out.output)).toBe(0);
      });

      it("fails open and warns once when the backend rejects", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockRejectedValue(new Error("backend unavailable"));
        const { hooks } = await setup(ctx);
        for (const callID of ["one", "two"]) await hooks["tool.execute.before"](taskInput("C", callID), taskOutput());
        expect(warn.mock.calls.filter(([text]) => String(text).includes("cannot resolve"))).toHaveLength(1);
      });

      it("shares one two-session walk across 50 concurrent task calls", async () => {
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: { id: path.id, parentID: path.id === "C" ? "O" : undefined } }));
        const { hooks, get } = await setup(ctx);
        await Promise.all(Array.from({ length: 50 }, (_, i) => dispatch(hooks, "C", 1, 1, `concurrent-${i}`)));
        expect(get.mock.calls.map(([request]) => request.path.id)).toEqual(["C", "O"]);
      });

      it("fails open on a never-settling lookup and warns once", async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockImplementation(() => new Promise(() => undefined));
        const { hooks, get } = await setup(ctx);
        const calls = Promise.all(["one", "two"].map(callID => hooks["tool.execute.before"](taskInput("C", callID), taskOutput())));
        await vi.advanceTimersByTimeAsync(DEFAULT_DEPTH_TIMEOUT_MS + 1);
        await expect(calls).resolves.toEqual([undefined, undefined]);
        expect(get).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.filter(([text]) => String(text).includes("cannot resolve"))).toHaveLength(1);
      });

      it("fails open when session.deleted cancels the pending lookup and warns once", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockImplementation(() => new Promise(() => undefined));
        const { hooks, get } = await setup(ctx);
        const calls = Promise.all(["one", "two"].map(callID => hooks["tool.execute.before"](taskInput("C", callID), taskOutput())));
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
        await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "C" } } } });
        await expect(calls).resolves.toEqual([undefined, undefined]);
        expect(warn.mock.calls.filter(([text]) => String(text).includes("cannot resolve"))).toHaveLength(1);
      });

      it("resolves an out-of-order child and accepts the later event without conflict", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: { id: path.id, parentID: path.id === "C" ? "O" : undefined } }));
        const { hooks, get } = await setup(ctx);
        await dispatch(hooks);
        expect(get).toHaveBeenCalledTimes(2);
        await created(hooks, "C", "O");
        expect(warn.mock.calls.flat().join(" ")).not.toContain("conflicting evidence");
        await dispatch(hooks, "C", 1, 1, "later");
        expect(get).toHaveBeenCalledTimes(2);
      });

      it("does not seed a failed transform lookup as a root", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const ctx = makeCtx(dir);
        ctx.client.session.get.mockRejectedValueOnce(new Error("transient"));
        ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: { id: path.id, parentID: path.id === "C" ? "O" : undefined } }));
        const { hooks } = await setup(ctx);
        const system = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]({ sessionID: "C", model: {} }, system);
        expect(system.system.length).toBeGreaterThan(0);
        await dispatch(hooks);
      });

      it("guards task_id resumes from a child but allows the root", async () => {
        const { hooks } = await setup();
        await seed(hooks);
        const args = { ...taskOutput().args, task_id: "existing" };
        await dispatch(hooks, "C", 1, 1, "resume", args);
        await expect(hooks["tool.execute.before"](taskInput("O"), { args })).resolves.toBeUndefined();
      });

      it("bypass skips the guard and its backend lookup", async () => {
        const { hooks, get } = await setup();
        await hooks["command.execute.before"]({ command: "bypass", arguments: "on" }, { parts: [] });
        const before = taskOutput();
        await hooks["tool.execute.before"](taskInput(), before);
        const after = { output: "unchanged" };
        await hooks["tool.execute.after"](taskInput(), after);
        expect(after.output).toBe("unchanged");
        expect(get).not.toHaveBeenCalled();
      });

      it("forgets a deleted child's depth", async () => {
        const { hooks, get } = await setup();
        await seed(hooks);
        await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "C" } } } });
        await hooks["tool.execute.before"](taskInput(), taskOutput());
        const out = { output: "done" };
        await hooks["tool.execute.after"](taskInput(), out);
        expect(get).toHaveBeenCalledWith({ path: { id: "C" } });
        expect(countBanners(out.output)).toBe(0);
      });

      it("records a native grader at its caller's depth plus one without changing its backend parent", async () => {
        configure({ maxDelegationDepth: 2 });
        const ctx = makeCtx(dir);
        const { hooks } = await setup(ctx);
        await seed(hooks);
        let graderCalls = 0;
        ctx.client.session.prompt.mockImplementation(async ({ path, body }) => {
          expect(body.system).toBeDefined();
          graderCalls++;
          await dispatch(hooks, path.id, 2, 2, "grader-task");
          expect(ctx.client.session.get.mock.calls.some(([req]) => req.path.id === path.id)).toBe(false);
          return { data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] } };
        });
        const before = { args: { prompt: "[acceptance]\ncriteria: correct\n[/acceptance]", subagent_type: "fast" } };
        await hooks["tool.execute.before"](taskInput(), before);
        const out = { output: "unwrapped producer output" };
        await hooks["tool.execute.after"]({ ...taskInput(), args: before.args }, out);
        expect(graderCalls).toBe(1);
        expect(out.output).toContain("[router ✓ verified:");
        expect(ctx.client.session.create.mock.calls[0][0].body).toEqual({});
      });

      describe("delegate", () => {
        beforeEach(() => { vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1"); });

        it.each(["accepted", "unmet", "fail-closed", "create-failed"] as const)("guards a child before the %s return path", async (outcome) => {
          const ctx = makeCtx(dir);
          if (outcome === "unmet") ctx.client.session.prompt.mockResolvedValue({ data: { parts: [{ type: "text", text: '{"pass":false,"reasons":["incorrect"]}' }] } });
          if (outcome === "fail-closed") ctx.client.session.create.mockRejectedValue(new Error("cannot create"));
          if (outcome === "create-failed") ctx.client.session.create.mockResolvedValue({ data: {} });
          const { hooks } = await setup(ctx);
          await seed(hooks);
          vi.clearAllMocks();
          const result = await hooks.tool.delegate.execute(delegateArgs, { sessionID: "C" });
          if (mode === "enforced") {
            expect(result).toBe(depthLimitMessage(1, 1));
            expect(ctx.client.session.create).not.toHaveBeenCalled();
            expect(ctx.client.session.prompt).not.toHaveBeenCalled();
            for (const spy of Object.values(observed)) expect(spy).not.toHaveBeenCalled();
            expect(captured.pending?.listUnverified("C")).toEqual([]);
          } else {
            expect(countBanners(result)).toBe(1);
            expect(result).toContain(depthAdvisoryBanner(1, 1));
            const marker = { accepted: "[router ✓ verified:", unmet: "[router status: unmet]", "fail-closed": "delegate failed (fail-closed)", "create-failed": "could not create a producer session" }[outcome];
            expect(result).toContain(marker);
            if (outcome === "accepted") expect(result.indexOf("GUARD:delegation_depth")).toBeLessThan(result.indexOf(marker));
            else expect(result.endsWith(depthAdvisoryBanner(1, 1))).toBe(true);
            const graders = ctx.client.session.prompt.mock.calls.filter(([opts]) => opts.body.system !== undefined);
            expect(JSON.stringify(graders)).not.toContain("GUARD:delegation_depth");
          }
        });

        it("keeps a root result byte-identical to disabling the depth guard", async () => {
          const { hooks } = await setup();
          await seed(hooks);
          const guarded = await hooks.tool.delegate.execute(delegateArgs, { sessionID: "O" });
          configure({ maxDelegationDepth: null });
          const disabled = await setup();
          const unguarded = await disabled.hooks.tool.delegate.execute(delegateArgs, { sessionID: "O" });
          expect(guarded).toContain("[router ✓ verified:");
          expect(guarded).toBe(unguarded);
          expect(countBanners(guarded)).toBe(0);
        });

        it.each(["v1", "v2"] as const)("records %s producers and graders with and without a caller before their first prompt", async (host) => {
          for (const caller of [undefined, "O"]) {
            const ctx = makeCtx(dir);
            let hooks: TestHooks;
            let nestedCalls = 0;
            const checkProducer = async (sid: string) => {
              nestedCalls++;
              const before: Record<PropertyKey, unknown> = taskOutput();
              if (mode === "enforced") {
                await expect(hooks["tool.execute.before"](taskInput(sid, "nested"), before)).rejects.toThrow(depthLimitMessage(1, 1));
              } else {
                await hooks["tool.execute.before"](taskInput(sid, "nested"), before);
                if (host === "v2") expect(before[DEPTH_BANNER]).toBe(depthAdvisoryBanner(1, 1));
                else {
                  const after = { output: "nested output" };
                  await hooks["tool.execute.after"](taskInput(sid, "nested"), after);
                  expect(countBanners(after.output)).toBe(1);
                }
              }
              expect(ctx.client.session.get.mock.calls.some(([req]) => req.path.id === sid)).toBe(false);
            };
            ctx.client.session.prompt.mockImplementation(async (opts) => {
              await checkProducer(opts.path.id);
              return { data: { parts: [{ type: "text", text: '{"pass":true,"reasons":[]}' }] } };
            });
            let childCounter = 0;
            const run = vi.fn(async (request: ChildSessionRequest) => {
              const sid = `host-child-${childCounter++}`;
              await request.onCreated(sid);
              await checkProducer(sid);
              return { sessionID: sid, text: '{"pass":true,"reasons":[]}' };
            });
            ({ hooks } = await setup(host === "v2" ? { ...ctx, routerHost: "v2", routerChildRunner: { run, dispose: vi.fn(async () => undefined) } } : ctx));
            if (caller) await seed(hooks);
            const result = await hooks.tool.delegate.execute(delegateArgs, caller ? { sessionID: caller } : undefined);
            expect(result).toContain("[router ✓ verified:");
            expect(nestedCalls).toBe(2);
            if (host === "v1") expect(ctx.client.session.create.mock.calls[0][0].body).toEqual(caller ? { parentID: caller } : {});
            else {
              expect(run.mock.calls[0][0].parentSessionID).toBe(caller);
              expect(ctx.client.session.create).not.toHaveBeenCalled();
            }
          }
        });

        it("bypass lets a child's delegate run the ladder without depth lookups or banners", async () => {
          const ctx = makeCtx(dir);
          const { hooks } = await setup(ctx);
          await seed(hooks);
          await hooks["command.execute.before"]({ command: "bypass", arguments: "on" }, { parts: [] });
          vi.clearAllMocks();
          const result = await hooks.tool.delegate.execute(delegateArgs, { sessionID: "C" });
          expect(result).toContain("[router ✓ verified:");
          expect(countBanners(result)).toBe(0);
          expect(ctx.client.session.create).toHaveBeenCalled();
          expect(ctx.client.session.get).not.toHaveBeenCalled();
        });
      });
    });
  }

  it("records a refused delegate after a fail-open transform so its hand-back is not a false refusal", async () => {
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
    vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ctx = makeCtx(dir);
    ctx.client.session.get.mockRejectedValueOnce(new Error("transient"));
    ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: { id: path.id, parentID: path.id === "C" ? "O" : undefined } }));
    const { hooks } = await setup(ctx);
    const system = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "C", model: {} }, system);
    expect(system.system.length).toBeGreaterThan(0);
    expect(await hooks.tool.delegate.execute(delegateArgs, { sessionID: "C" })).toBe(depthLimitMessage(1, 1));
    expect(ctx.client.session.create).not.toHaveBeenCalled();
    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    // Even the generic after-hook does not record this caller: the failed
    // transform never marked it as a subagent, unlike a session.created event.
    await hooks["tool.execute.after"]({ tool: "delegate", sessionID: "C", callID: "blocked" }, { output: depthLimitMessage(1, 1) });
    for (const sid of ["C", "untouched"]) {
      const out = { output: `task_id: ${sid}\n<task_result>NEED CONTEXT: I cannot dispatch; handing back because tools are unavailable.</task_result>`, metadata: { sessionId: sid } };
      await hooks["tool.execute.after"](taskInput("O", `return-${sid}`), out);
      expect(out.output.includes("FALSE-REFUSAL SUSPECT")).toBe(sid === "untouched");
    }
  });

  it.each(["deferred subagent", "v2 repair"])("refuses the %s fixture dispatch with the default limit before registering anything", async (shape) => {
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
    const ctx = makeCtx(dir);
    const sid = shape === "deferred subagent" ? "sub" : "root";
    ctx.client.session.get.mockImplementation(async ({ path }) => ({ data: {
      id: path.id,
      // Match the v2 fixture's unconditional parent: even root points to itself.
      parentID: shape === "v2 repair" ? "root" : path.id === "sub" ? "orch" : undefined,
    } }));
    const { hooks } = await setup(ctx);
    const args = shape === "deferred subagent"
      ? { subagent_type: "fast", prompt: "VERIFY:deferred\nImplement it.\n[acceptance]\ncheck: testsPass\ncheck: fileExists path=missing.ts\n[/acceptance]", description: "the work" }
      : { subagent_type: "fast", description: "Investigate every source file" };
    const before = { args: { ...args } };
    await expect(hooks["tool.execute.before"]({ ...taskInput(sid), args }, before))
      .rejects.toThrow(depthLimitMessage(shape === "v2 repair" ? 32 : 1, 1));
    expect(before.args).toEqual(args);
    expect(TASK_VERIFICATION in before).toBe(false);
    for (const spy of Object.values(observed)) expect(spy).not.toHaveBeenCalled();
    expect(captured.pending?.listUnverified(sid)).toEqual([]);
    expect(ctx.client.session.create).not.toHaveBeenCalled();
  });

  it("composes with the Layer-1 iteration budget on the same advisory task", async () => {
    configure({ guard: { budget: 1, sameOpRetryCap: 1 } });
    const { hooks } = await setup();
    await seed(hooks);
    await hooks["chat.message"]({ sessionID: "C", agent: "fast" }, { parts: [] });
    for (const callID of ["first", "second"]) {
      const input = taskInput("C", callID);
      const before = taskOutput();
      await hooks["tool.execute.before"](input, before);
      const out = { output: "done" };
      await hooks["tool.execute.after"]({ ...input, args: before.args }, out);
      expect(countBanners(out.output)).toBe(1);
      if (callID === "second") expect(out.output.match(/GUARD:iteration_cap/g)).toHaveLength(1);
    }
  });

  it("delivers per-call banners once, isolates abandoned calls and purges deleted sessions", async () => {
    const { hooks } = await setup();
    await seed(hooks);
    await hooks["tool.execute.before"](taskInput("C", "abandoned"), taskOutput());
    await hooks["tool.execute.before"](taskInput("C", "live"), taskOutput());
    for (const count of [1, 0]) {
      const out = { output: "done" };
      await hooks["tool.execute.after"](taskInput("C", "live"), out);
      expect(countBanners(out.output)).toBe(count);
    }
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "C" } } } });
    const out = { output: "done" };
    await hooks["tool.execute.after"](taskInput("C", "abandoned"), out);
    expect(countBanners(out.output)).toBe(0);
  });

  it("warns once per session without a callID and delivers no banner", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hooks } = await setup();
    await seed(hooks);
    for (let n = 0; n < 2; n++) {
      const input = { tool: "task", sessionID: "C" };
      await hooks["tool.execute.before"](input, taskOutput());
      const out = { output: "done" };
      await hooks["tool.execute.after"](input, out);
      expect(countBanners(out.output)).toBe(0);
    }
    expect(warn.mock.calls.filter(([text]) => String(text).includes("without callID"))).toHaveLength(1);
  });

  it("never sends the depth banner to the native-path grader or changes its parentID", async () => {
    const ctx = makeCtx(dir);
    const { hooks } = await setup(ctx);
    await seed(hooks);
    const input = taskInput();
    const before = { args: { prompt: "[acceptance]\ncriteria: correct\n[/acceptance]", subagent_type: "fast" } };
    await hooks["tool.execute.before"](input, before);
    const out = { output: "unwrapped producer output" };
    await hooks["tool.execute.after"]({ ...input, args: before.args }, out);
    expect(countBanners(out.output)).toBe(1);
    const graders = ctx.client.session.prompt.mock.calls.filter(([opts]) => opts.body.system !== undefined);
    expect(graders).toHaveLength(1);
    expect(JSON.stringify(graders)).not.toContain("GUARD:delegation_depth");
    expect(ctx.client.session.create.mock.calls[0][0].body?.parentID).toBeUndefined();
  });

  it("uses the v2 symbol channel without also stashing a v1 banner", async () => {
    const ctx = { ...makeCtx(dir), routerHost: "v2" as const };
    const { hooks } = await setup(ctx);
    await seed(hooks);
    const before: Record<PropertyKey, unknown> = taskOutput();
    await hooks["tool.execute.before"](taskInput(), before);
    expect(before[DEPTH_BANNER]).toBe(depthAdvisoryBanner(1, 1));
    const out = { output: "done" };
    await hooks["tool.execute.after"](taskInput(), out);
    expect(countBanners(out.output)).toBe(0);
  });

  it("starts without lookups and seeds a root with only its transform lookup", async () => {
    const { hooks, get } = await setup();
    expect(get).not.toHaveBeenCalled();
    await hooks["experimental.chat.system.transform"]({ sessionID: "O", model: {} }, { system: [] });
    expect(get).toHaveBeenCalledExactlyOnceWith({ path: { id: "O" } });
    await hooks["experimental.chat.system.transform"]({ sessionID: "O", model: {} }, { system: [] });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("records creation and deletion without backend calls", async () => {
    const { hooks, get } = await setup();
    for (const type of ["session.created", "session.deleted"]) {
      await hooks.event({ event: { type, properties: { info: { id: "C", parentID: "O" } } } });
    }
    expect(get).not.toHaveBeenCalled();
  });
});
