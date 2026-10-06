/**
 * `src/v2.ts` hands the plugin the host objects the cost doctor and `/annotate-plan` read (Phase 2.4): the agents of THIS location
 * (QA-2.4-16) and the host `generate`. The plugin factory, the runtime and the hook registration are replaced by recorders, so only the
 * wiring in `v2.ts` is under test.
 */
import { describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin";

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
