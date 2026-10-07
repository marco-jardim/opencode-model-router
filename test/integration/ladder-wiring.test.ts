/**
 * test/integration/ladder-wiring.test.ts
 *
 * Drives the REAL plugin factory with a fake ctx to prove Layer-3 escalation
 * ladder wiring (retry-same-tier, escalate, give_up paths).
 *
 * No live models, no network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { getActiveTiers } from "../../src/router/protocol";
import type { ChildSessionRequest, RouterPluginInput } from "../../src/compat/child-session";

// ---------------------------------------------------------------------------
// Globally unique session counter (prevents duplicate IDs across all tests).
// ---------------------------------------------------------------------------

let sessionCounter = 0;

// ---------------------------------------------------------------------------
// Fake ctx builder
// ---------------------------------------------------------------------------

function makeCtxWithQueues(
  dir: string,
  producerCalls: Array<{ tier: string; text: string }>,
  graderQueue: string[],
) {
  return {
    directory: dir,
    worktree: dir,
    project: {} as any,
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as any,
    client: {
      session: {
        create: async () => ({
          data: { id: `sess_${sessionCounter++}` },
        }),
        prompt: async (opts: any) => {
          if (opts?.body?.system !== undefined) {
            // GRADER call (dispatchGrader always sets body.system)
            const text =
              graderQueue.shift() ?? '{"pass":true,"reasons":[]}';
            return { data: { parts: [{ type: "text", text }] } };
          }
          // PRODUCER call
          producerCalls.push({
            tier: opts?.body?.agent ?? "",
            text: opts?.body?.parts?.[0]?.text ?? "",
          });
          return {
            data: { parts: [{ type: "text", text: "producer output" }] },
          };
        },
      },
    } as any,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Layer-3 escalation ladder wiring", () => {
  let dir: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  const acceptance =
    "[acceptance]\ncriteria: the result is correct\n[/acceptance]";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml3-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome !== undefined) {
      process.env.HOME = savedHome;
    } else {
      delete process.env.HOME;
    }
    if (savedUserProfile !== undefined) {
      process.env.USERPROFILE = savedUserProfile;
    } else {
      delete process.env.USERPROFILE;
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    invalidateConfigCache();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // CASE A: retry within the same tier, then pass
  // -------------------------------------------------------------------------

  it("CASE A: retry-same-tier -> PASS", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["nope"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do x",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ verified:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(2);
    expect(producerCalls[1]!.tier).toBe("fast");
    expect(producerCalls[1]!.text).toContain("[router escalation]");
  });

  // -------------------------------------------------------------------------
  // CASE B: exhaust fast retries, escalate to medium, then pass
  // -------------------------------------------------------------------------

  it("CASE B: escalate -> PASS", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    const graderQueue = [
      '{"pass":false,"reasons":["a"]}',
      '{"pass":false,"reasons":["b"]}',
      '{"pass":true,"reasons":[]}',
    ];

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do y",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router ✓ verified:");
    expect(result).not.toContain("status: unmet");
    expect(producerCalls.length).toBe(3);
    expect(producerCalls[2]!.tier).toBe("medium");
  });

  // -------------------------------------------------------------------------
  // CASE C: exhaust all attempts, give_up
  // -------------------------------------------------------------------------

  it("CASE C: give_up after maxTotalAttempts", async () => {
    const producerCalls: Array<{ tier: string; text: string }> = [];
    // Provide more than enough failures to ensure the queue never runs dry.
    const graderQueue = Array<string>(6).fill(
      '{"pass":false,"reasons":["bad"]}',
    );

    const hooks: any = await ModelRouterPlugin(
      makeCtxWithQueues(dir, producerCalls, graderQueue) as any,
    );

    const result: string = await hooks.tool.delegate.execute({
      task: "do z",
      tier: "fast",
      acceptance,
    });

    expect(result).toContain("[router status: unmet]");
    expect(result).toContain("attempt(s)");
    expect(result).not.toContain("[router ✓");
    // fast(1)+fast(1)+medium(5)=7 > firstAttemptCost(1)*costMultiple(4)=4 → cost ceiling
    // fires after 3 attempts, not 4.
    expect(producerCalls.length).toBe(3);
  });
});

describe("effortBump false preserves the v2.0.0 golden ladder scenarios", () => {
  type Hook = (input: unknown, output?: unknown) => Promise<void>;
  type TestHooks = Record<string, Hook> & {
    dispose(): Promise<void>;
    tool: { delegate: { execute(args: { task: string; tier: string; acceptance: string }): Promise<string> } };
  };
  type Body = { agent?: string; model?: { providerID: string; modelID: string }; system?: string; parts: { type: string; text: string }[] };
  let dir: string;
  const instances: TestHooks[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ladder-off-"));
    vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    vi.stubEnv("MODEL_ROUTER_VERIFIED_DELEGATE", "1");
    fs.mkdirSync(path.dirname(overridePath()), { recursive: true });
    fs.writeFileSync(overridePath(), JSON.stringify({ activePreset: "fable-effort", enforcement: { escalate: { effortBump: false } } }));
    invalidateConfigCache();
  });
  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    vi.unstubAllEnvs(); invalidateConfigCache();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  for (const host of ["v1", "v2"] as const) {
    it.each([
      { name: "A: retry then pass", verdicts: [false, true], tiers: ["fast", "fast"], accepted: true },
      { name: "B: escalate then pass", verdicts: [false, false, true], tiers: ["fast", "fast", "medium"], accepted: true },
      { name: "C: cost ceiling", verdicts: [false, false, false], tiers: ["fast", "fast", "medium"], accepted: false },
    ])(`${host} CASE $name: unchanged dispatch bodies and chat.params`, async scenario => {
      const tiers = getActiveTiers(loadConfig());
      const bodies: Body[] = [];
      const outputs: unknown[] = [];
      const inputs: unknown[] = [];
      const childArgs: unknown[] = [];
      const verdicts = [...scenario.verdicts];
      let hooks: TestHooks;
      const prompt = async (sid: string, body: Body) => {
        if (body.system !== undefined) return JSON.stringify({ pass: verdicts.shift(), reasons: ["bad"] });
        bodies.push(body);
        const options = { effort: tiers[body.agent!].effort, sentinel: "preserve" };
        const output = host === "v1" ? { temperature: 0.7, options } : { temperature: 0.7, ...options };
        inputs.push(structuredClone(output));
        await hooks["chat.params"]({ sessionID: sid, agent: body.agent, model: body.model }, output);
        outputs.push(output);
        return "producer output";
      };
      hooks = await ModelRouterPlugin({
        directory: dir, worktree: dir,
        client: { session: {
          create: async () => ({ data: { id: `golden-off-${sessionCounter++}` } }),
          prompt: async ({ path, body }: { path: { id: string }; body: Body }) => ({ data: { parts: [{ type: "text", text: await prompt(path.id, body) }] } }),
          delete: async () => ({}),
        } },
        ...(host === "v2" ? { routerHost: "v2", routerChildRunner: {
          run: async (request: ChildSessionRequest) => {
            const sid = `golden-off-v2-${sessionCounter++}`;
            await request.onCreated(sid);
            if (request.system === undefined) {
              const { signal, onCreated, ...args } = request;
              childArgs.push(args);
            }
            const body: Body = { model: request.model && { providerID: request.model.providerID, modelID: request.model.modelID }, agent: request.agent, parts: [{ type: "text", text: request.prompt }], ...(request.system !== undefined ? { system: request.system } : {}) };
            return { sessionID: sid, text: await prompt(sid, body) };
          },
          dispose: async () => undefined,
        } } : {}),
      } as unknown as RouterPluginInput) as unknown as TestHooks;
      instances.push(hooks);
      const result = await hooks.tool.delegate.execute({ task: "do x", tier: "fast", acceptance: "[acceptance]\ncriteria: the result is correct\n[/acceptance]" });
      const expected = scenario.tiers.map((agent, index) => {
        const [providerID, ...ids] = tiers[agent].model.split("/");
        return { model: { providerID, modelID: ids.join("/") }, agent, parts: [{ type: "text", text: index === 0 ? "do x" : "[router escalation] previous attempt did not pass verification:\n- bad\nNEXT: retry with these failures addressed.\n\ndo x" }] };
      });
      expect(bodies).toEqual(expected);
      expect(outputs).toEqual(inputs);
      if (host === "v2") expect(childArgs).toEqual(expected.map(body => ({ parentSessionID: undefined, agent: body.agent, model: { ...body.model, variant: tiers[body.agent].variant }, prompt: body.parts[0].text })));
      if (scenario.accepted) expect(result).toBe("producer output\n\n[router ✓ verified: checker]");
      else {
        expect(result).toContain("3 attempt(s) across 1 escalation(s)");
        expect(result).toContain("cost ceiling exceeded");
        expect(result).not.toContain("[router ✓");
      }
    });
  }

  it("registers exactly the same agent names with both features on or off", async () => {
    const names: string[][] = [];
    for (const enabled of [false, true]) {
      fs.writeFileSync(overridePath(), JSON.stringify({ activePreset: "fable-effort", enforcement: { maxDelegationDepth: enabled ? 1 : null, escalate: { effortBump: enabled } } }));
      invalidateConfigCache();
      const hooks = await ModelRouterPlugin({ directory: dir, worktree: dir, client: {} } as unknown as RouterPluginInput) as unknown as TestHooks;
      instances.push(hooks);
      const config: { agent?: Record<string, unknown> } = {};
      await hooks.config(config);
      names.push(Object.keys(config.agent ?? {}).sort());
    }
    expect(names[0]).toContain("fast");
    expect(names[1]).toEqual(names[0]);
  });
});
