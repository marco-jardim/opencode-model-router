import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { ChildSessionRequest, RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import { buildAgentOptions } from "../../src/router/agent-options";

const captured = vi.hoisted(() => ({
  stores: [] as import("../../src/escalate/effort-override").EffortOverrideStore[],
  prepare: vi.fn(), dispose: vi.fn(),
}));
vi.mock("../../src/escalate/effort-override", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/escalate/effort-override")>();
  return { ...original, createEffortOverrideStore: (...args: Parameters<typeof original.createEffortOverrideStore>) => {
    const store = original.createEffortOverrideStore(...args);
    vi.spyOn(store, "clear");
    vi.spyOn(store, "set");
    captured.stores.push(store);
    return store;
  } };
});
vi.mock("../../src/verify/wiring", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/verify/wiring")>();
  return { ...original, createVerificationWiring: (...args: Parameters<typeof original.createVerificationWiring>) => {
    const wiring = original.createVerificationWiring(...args);
    return { ...wiring,
      prepareVerification: (...params: Parameters<typeof wiring.prepareVerification>) => {
        captured.prepare();
        return wiring.prepareVerification(...params);
      },
      disposeChildSession: (...params: Parameters<typeof wiring.disposeChildSession>) => {
        captured.dispose(...params);
        return wiring.disposeChildSession(...params);
      },
    };
  } };
});

type TestHooks = Record<string, (input: unknown, output?: unknown) => Promise<void>> & {
  dispose(): Promise<void>;
  tool: { delegate: { execute(args: { task: string; tier: string; acceptance: string }, ctx?: { sessionID: string }): Promise<string> } };
};
type Model = { providerID: string; modelID: string };
type Prompt = { path: { id: string }; body: { agent?: string; model?: Model; system?: string; parts: { text: string }[] } };
const acceptance = "[acceptance]\ncriteria: the result is correct\n[/acceptance]";
let counter = 0;

describe("effort bump plugin wiring", () => {
  let dir: string;
  const instances: TestHooks[] = [];
  const scorecards: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ladder-effort-"));
    vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
    captured.stores.length = 0;
    captured.prepare.mockReset(); captured.dispose.mockReset();
    configure();
  });
  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
    invalidateConfigCache();
    for (const file of scorecards.splice(0)) rmSync(file, { force: true });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function configure(preset = "fable-effort", effortBump = true, verify: Record<string, unknown> = {}) {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: preset, enforcement: { escalate: { effortBump }, verify } }));
    invalidateConfigCache();
  }

  async function setup(host: "v1" | "v2", results = [false, true], fault?: "abort" | "timeout",
    onProducer?: (hooks: TestHooks, sid: string, agent: string, model: Model | undefined, attempt: number) => Promise<void>) {
    let hooks: TestHooks;
    const producers: Array<{ sid: string; agent: string; model: Model | undefined; options: Record<string, unknown>; text: string }> = [];
    const excluded: Record<string, unknown>[] = [];
    const graders: Record<string, unknown>[] = [];
    const tiers = getActiveTiers(loadConfig());
    const fast = tiers.fast;
    async function params(sessionID: string, agent: string, model: Model | undefined) {
      const options: Record<string, unknown> = {};
      const output = host === "v2" ? options : { options };
      await hooks["chat.params"]({ sessionID, agent, model: model && { providerID: model.providerID, id: model.modelID } }, output);
      return options;
    }
    async function prompt(sid: string, agent: string, model: Model | undefined, text: string, grader: boolean) {
      const options = await params(sid, agent, model);
      if (grader) {
        graders.push(options);
        return JSON.stringify({ pass: results.shift() ?? false, reasons: ["scripted verdict"] });
      }
      producers.push({ sid, agent, model, options, text });
      excluded.push(await params(sid, "title", model), await params("orchestrator", "build", model));
      await onProducer?.(hooks, sid, agent, model, producers.length);
      if (producers.length === 2 && fault === "abort") throw new DOMException("producer aborted", "AbortError");
      if (producers.length === 2 && fault === "timeout") return new Promise<string>(() => undefined);
      return "producer output";
    }
    const ctx = {
      directory: dir, worktree: dir,
      client: { session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
        create: async () => ({ data: { id: `effort-${counter++}` } }),
        prompt: async (request: Prompt) => ({ data: { parts: [{ type: "text", text: await prompt(request.path.id, request.body.agent ?? "grader", request.body.model, request.body.parts[0].text, request.body.system !== undefined) }] } }),
        delete: async () => ({}),
      } },
      ...(host === "v2" ? { routerHost: "v2" as const, routerChildRunner: {
        run: async (request: ChildSessionRequest) => {
          const sessionID = `effort-v2-${counter++}`;
          await request.onCreated(sessionID);
          return { sessionID, text: await prompt(sessionID, request.agent ?? "grader", request.model, request.prompt, request.system !== undefined) };
        },
        dispose: async () => undefined,
      } } : {}),
    };
    hooks = await ModelRouterPlugin(ctx as unknown as RouterPluginInput) as unknown as TestHooks;
    instances.push(hooks);
    return { hooks, producers, excluded, graders, fast, params,
      run: (task = "VERIFY:required\ndo x", criteria = acceptance) => hooks.tool.delegate.execute({ tier: "fast", task, acceptance: criteria }, { sessionID: "orchestrator" }),
    };
  }

  function assertCleared(producers: { sid: string }[]) {
    expect(captured.stores).toHaveLength(1);
    const store = captured.stores[0];
    expect(store.size()).toBe(0);
    const clear = vi.mocked(store.clear);
    for (const { sid } of producers) {
      const disposals = captured.dispose.mock.calls.flatMap(([id], index) => id === sid ? [index] : []);
      expect(disposals.length).toBeGreaterThan(0);
      for (const index of disposals) {
        expect(clear.mock.calls.some(([id], i) => id === sid && clear.mock.invocationCallOrder[i] < captured.dispose.mock.invocationCallOrder[index])).toBe(true);
      }
    }
  }

  for (const host of ["v1", "v2"] as const) {
    it(`${host}: keeps the effort policy, model and override on the same config snapshot`, async () => {
      const f = await setup(host, [false, true], undefined, async (_hooks, _sid, _agent, _model, attempt) => {
        if (attempt === 1) configure("anthropic");
      });
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(f.producers[1].options).toEqual({ effort: "medium" });
      expect(f.producers[1].model).toEqual(f.producers[0].model);
      expect(captured.stores[0].set).toHaveBeenCalledWith(f.producers[1].sid, "fast", f.fast, "medium");
      assertCleared(f.producers);
    });

    it.each(["error", "unprintable", "failed logger"])(`${host}: contains a grader-params %s without skipping the independent effort override`, async (failure) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      if (failure === "failed logger") warn.mockImplementation(() => { throw new Error("logger unavailable"); });
      const error: unknown = failure === "error" ? new Error("params unavailable") : Object.create(null);
      const outputs: Record<string, unknown>[] = [];
      const f = await setup(host, [false, true], undefined, async (hooks, sid, agent, model, attempt) => {
        if (attempt !== 2) return;
        for (let call = 0; call < 2; call++) {
          let reads = 0;
          const input = { get sessionID() { if (reads++ === 0) throw error; return sid; }, agent, model };
          const options: Record<string, unknown> = {};
          await hooks["chat.params"](input, host === "v1" ? { options } : options);
          outputs.push(options);
        }
      });
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(outputs).toEqual([{ effort: "medium" }, { effort: "medium" }]);
      expect(warn.mock.calls.filter(([text]) => String(text).includes("grader temperature not applied"))).toHaveLength(1);
      assertCleared(f.producers);
    });

    it(`${host}: session.deleted clears a live bumped producer before normal cleanup`, async () => {
      const sizes: number[] = [];
      const after: Record<string, unknown>[] = [];
      const f = await setup(host, [false, true], undefined, async (hooks, sid, agent, model, attempt) => {
        if (attempt !== 2) return;
        sizes.push(captured.stores[0].size());
        await hooks.event({ event: { type: "session.deleted", properties: { info: { id: sid } } } });
        sizes.push(captured.stores[0].size());
        const options: Record<string, unknown> = {};
        await hooks["chat.params"]({ sessionID: sid, agent, model }, host === "v1" ? { options } : options);
        after.push(options);
      });
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(sizes).toEqual([1, 0]);
      expect(after).toEqual([{}]);
      assertCleared(f.producers);
    });

    it(`${host}: applies medium only to the retry, reports fast@medium, and clears on success`, async () => {
      vi.stubEnv("MODEL_ROUTER_TRAJECTORY_DEBUG", "1");
      const f = await setup(host);
      expect(f.fast.effort).toBe("low");
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(f.producers.map(p => p.options)).toEqual([{}, { effort: buildAgentOptions({ ...f.fast, effort: "medium" }).effort }]);
      expect(f.producers.map(p => p.agent)).toEqual(["fast", "fast"]);
      expect(f.producers[1].model).toEqual(f.producers[0].model);
      expect(f.excluded).toEqual([{}, {}, {}, {}]);
      expect(f.graders).toEqual(host === "v1" ? [{}, {}] : [{ temperature: 0 }, { temperature: 0 }]);
      const file = join(tmpdir(), "opencode-model-router-trajectory", `${f.producers[1].sid}.delegate.log`);
      scorecards.push(file);
      expect(readFileSync(file, "utf8")).toContain("final_tier=fast@medium");
      assertCleared(f.producers);
      expect(await f.params(f.producers[1].sid, "fast", f.producers[1].model)).toEqual({});
    });

    it(`${host}: escalation drops the override and preserves the three-attempt cost ceiling`, async () => {
      const f = await setup(host, [false, false, false]);
      const result = await f.run();
      expect(result).toContain("cost ceiling exceeded");
      expect(result).toContain("3 attempt(s)");
      expect(f.producers.map(p => p.agent)).toEqual(["fast", "fast", "medium"]);
      expect(f.producers.map(p => p.options)).toEqual([{}, { effort: "medium" }, {}]);
      assertCleared(f.producers);
    });

    it.each(["abort", "timeout"] as const)(`${host}: clears the bumped producer after %s`, async fault => {
      configure("fable-effort", true, { delegateTimeoutMs: 1000 });
      const f = await setup(host, [false, true], fault);
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(f.producers.map(p => p.options)).toEqual([{}, { effort: "medium" }, {}]);
      assertCleared(f.producers);
    });

    it(`${host}: the outer finally clears an override when verification preparation throws`, async () => {
      captured.prepare.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("prepare failed"); });
      const f = await setup(host);
      expect(await f.run()).toContain("fail-closed");
      expect(f.producers[1].options).toEqual({ effort: "medium" });
      assertCleared(f.producers);
    });

    it(`${host}: deferred cleanup clears before disposal without running a grader`, async () => {
      const f = await setup(host);
      const result = await f.run("VERIFY:deferred\ndo x", "[acceptance]\ncheck: testsPass\n[/acceptance]");
      expect(result).toContain("unverified");
      expect(f.graders).toHaveLength(0);
      assertCleared(f.producers);
    });

    it(`${host}: a variant-based tier retries without an override`, async () => {
      configure("anthropic");
      const f = await setup(host);
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(f.producers.map(p => p.options)).toEqual([{}, {}]);
      expect(captured.stores[0].set).not.toHaveBeenCalled();
      assertCleared(f.producers);
    });

    it(`${host}: bypass does not skip a ladder's effort bump`, async () => {
      const f = await setup(host);
      await f.hooks["command.execute.before"]({ command: "bypass", arguments: "on" }, { parts: [] });
      expect(await f.run()).toContain("[router ✓ verified:");
      expect(f.producers[1].options).toEqual({ effort: "medium" });
      assertCleared(f.producers);
    });
  }
});
