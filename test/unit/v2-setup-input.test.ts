/**
 * `src/v2.ts` hands the plugin the host objects the cost doctor and `/annotate-plan` read (Phase 2.4): the agents of THIS location
 * (QA-2.4-16) and the host `generate`. The plugin factory, the runtime and the hook registration are replaced by recorders, so only the
 * wiring in `v2.ts` is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";
import { readFileSync } from "node:fs";
import * as configModule from "../../src/router/config";
import * as gitTools from "../../src/router/git-tools";
import * as executorModule from "../../src/executor/create";
import { createV2Runtime } from "../../src/compat/v2-client";

const captured: { input?: Record<string, unknown> } = {};

vi.mock("../../src/index", () => ({
  default: vi.fn(async (input: Record<string, unknown>) => {
    captured.input = input;
    return {};
  }),
}));
vi.mock("../../src/compat/v2-client", () => ({
  createV2Runtime: vi.fn(() => ({ client: {}, childRunner: {} })),
}));
vi.mock("../../src/compat/v2-hooks", () => ({
  registerV2Hooks: vi.fn(async () => async () => undefined),
}));

import v2Plugin from "../../src/v2";

const bundled = JSON.parse(readFileSync(new URL("../../tiers.json", import.meta.url), "utf8")) as Record<string, unknown>;
function configuration(delegation = "tiers", leases = "enforce", require = "always", workRoots: string[] = []) {
  return configModule.validateConfig({ ...bundled, routing: { delegation, leases: { mode: leases }, workRoots },
    enforcement: { verify: { require } } });
}
beforeEach(() => { vi.spyOn(configModule, "loadConfig").mockReturnValue(configuration()); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); captured.input = undefined; });

function context(extra: Record<string, unknown> = {}) {
  return {
    location: { directory: "/project/sub", project: { directory: "/project" } },
    agent: { list: vi.fn(async (_options?: unknown) => ({ data: [{ id: "title" }] })) },
    model: { list: vi.fn(async (_options?: unknown) => ({ data: [] })) },
    session: { synthetic: vi.fn(async (_input: unknown) => undefined) },
    ...extra,
  };
}

describe("src/v2.ts: the host objects the plugin receives", () => {
  it.each([
    ["tiers mode", "tiers", "enforce", "always", []],
    ["leases off", "roles", "off", "always", []],
    ["verification never", "roles", "enforce", "never", []],
    ["outside workRoots", "roles", "enforce", "always", [process.platform === "win32" ? "E:/allowed" : "/allowed"]],
  ] as const)("runs no executor discovery git in %s", async (_label, delegation, leases, require, workRoots) => {
    vi.mocked(configModule.loadConfig).mockReturnValue(configuration(delegation, leases, require, [...workRoots]));
    const spawn = vi.spyOn(gitTools, "spawnBounded").mockRejectedValue(new Error("unexpected discovery git"));
    const prepare = vi.spyOn(executorModule, "prepareExecutor");
    await v2Plugin.setup(context() as unknown as Plugin.Context);
    expect(prepare).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("discovers an eligible roles/enforce location inside workRoots", async () => {
    const root = process.platform === "win32" ? "D:/project" : "/project";
    const directory = `${root}/sub`;
    vi.mocked(configModule.loadConfig).mockReturnValue(configuration("roles", "enforce", "always", [root]));
    const prepare = vi.spyOn(executorModule, "prepareExecutor").mockResolvedValue({ ok: false, reason: "test repository unavailable" });
    await v2Plugin.setup(context({ location: { directory, project: { directory: root } } }) as unknown as Plugin.Context);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(directory);
  });

  it("explains a missing child runner rather than leaving the executor not initialized", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue(configuration("roles"));
    vi.spyOn(executorModule, "prepareExecutor").mockResolvedValue({ ok: true, toplevel: "/project", home: "/project/.git/omr-executor" });
    vi.mocked(createV2Runtime).mockReturnValueOnce({ client: {} } as unknown as ReturnType<typeof createV2Runtime>);
    await v2Plugin.setup(context() as unknown as Plugin.Context);
    const access = captured.input?.routerExecutor as executorModule.ExecutorAccess;
    expect(access.runtime()).toBeNull();
    expect(access.unavailable()).toBe("the plan executor is not available: the child runner is not available");
  });

  it.each([
    ["configuration gate", "tiers", "routing.delegation must be roles at start"],
    ["repository discovery", "roles", "the repository toplevel could not be resolved"],
    ["workRoots gate", "roles", "the location is outside routing.workRoots"],
  ])("QA-5.1-23 a missing child runner does not overwrite the earlier %s reason", async (label, delegation, reason) => {
    const workRoots = label === "workRoots gate" ? [process.platform === "win32" ? "E:/allowed" : "/allowed"] : [];
    vi.mocked(configModule.loadConfig).mockReturnValue(configuration(delegation, "enforce", "always", workRoots));
    vi.spyOn(executorModule, "prepareExecutor").mockResolvedValue({ ok: false, reason });
    vi.mocked(createV2Runtime).mockReturnValueOnce({ client: {} } as unknown as ReturnType<typeof createV2Runtime>);
    await v2Plugin.setup(context() as unknown as Plugin.Context);
    const access = captured.input?.routerExecutor as executorModule.ExecutorAccess;
    expect(access.runtime()).toBeNull();
    expect(access.unavailable()).toBe(`the plan executor is not available: ${reason}`);
  });

  it("hands over the late executor access, plan annotate port and slot verifier port (Phase 5.1 D1)", async () => {
    await v2Plugin.setup(context() as unknown as Plugin.Context);
    expect(captured.input?.routerExecutor).toEqual(expect.objectContaining({
      runtime: expect.any(Function), unavailable: expect.any(Function), set: expect.any(Function), clear: expect.any(Function),
    }));
    expect(captured.input?.routerOnPlanAnnotate).toEqual(expect.any(Function));
    expect(captured.input?.routerOnSlotVerifier).toEqual(expect.any(Function));
  });
  it("routerAgents lists the agents of this plugin instance's location (QA-2.4-16)", async () => {
    const ctx = context();
    await v2Plugin.setup(ctx as unknown as Plugin.Context);
    const routerAgents = captured.input?.routerAgents as () => Promise<readonly unknown[]>;
    await expect(routerAgents()).resolves.toEqual([{ id: "title" }]);
    expect(ctx.agent.list).toHaveBeenCalledWith({ location: { directory: "/project/sub" } });
  });

  it("routerSynthetic is the host's synthetic transcript entry that does not resume the session: the call the adapter uses for its own notices (QA-2.4-R2-1)", async () => {
    const ctx = context();
    await v2Plugin.setup(ctx as unknown as Plugin.Context);
    const routerSynthetic = captured.input?.routerSynthetic as (notice: { sessionID: string; text: string; description: string }) => Promise<void>;
    await expect(routerSynthetic({ sessionID: "ses_1", text: "hello", description: "Model router cost doctor" })).resolves.toBeUndefined();
    expect(ctx.session.synthetic).toHaveBeenCalledTimes(1);
    expect(ctx.session.synthetic).toHaveBeenCalledWith({ sessionID: "ses_1", text: "hello", description: "Model router cost doctor", resume: false });
  });

  it("routerCatalog keeps listing the models of the location, and routerGenerate is the host's generate when it has one", async () => {
    const generate = { text: vi.fn() };
    const ctx = context({ generate });
    await v2Plugin.setup(ctx as unknown as Plugin.Context);
    expect(captured.input?.routerGenerate).toBe(generate);
    await (captured.input?.routerCatalog as () => Promise<unknown>)();
    expect(ctx.model.list).toHaveBeenCalledWith({ location: { directory: "/project/sub" } });
    const withoutGenerate = context();
    await v2Plugin.setup(withoutGenerate as unknown as Plugin.Context);
    expect(captured.input).not.toHaveProperty("routerGenerate");
  });
});
