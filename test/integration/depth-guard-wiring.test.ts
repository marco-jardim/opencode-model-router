import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache } from "../../src/router/config";

type Hook = (input: unknown, output?: unknown) => Promise<void>;
type TestHooks = Record<string, Hook> & { dispose(): Promise<void> };

function makeCtx(dir: string) {
  const get = vi.fn(async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, parentID: undefined as string | undefined } }));
  return { directory: dir, worktree: dir, client: { session: { get } } };
}

describe("delegation depth plugin wiring", () => {
  let dir: string;
  const instances: TestHooks[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "depth-wiring-"));
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    invalidateConfigCache();
  });

  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    invalidateConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function setup(ctx = makeCtx(dir)) {
    const hooks = await ModelRouterPlugin(ctx as unknown as RouterPluginInput) as unknown as TestHooks;
    instances.push(hooks);
    return { hooks, get: ctx.client.session.get };
  }

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
