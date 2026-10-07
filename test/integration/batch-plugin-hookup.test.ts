/**
 * QA-2.2-20: the plugin's two hookups of the S5 batch coordinator (index.ts, 2.2.3).
 *
 * - The idle-TTL sweeper list calls the wiring's sweepVerification() (batch.ts B11 sweep).
 * - Plugin dispose awaits the wiring's disposeVerification() before it returns.
 *
 * The real wiring is kept; only those two members are wrapped, to count the sweeps and to hold
 * the dispose open until the test releases it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";

const spy = vi.hoisted(() => ({
  sweeps: 0,
  disposeCalls: 0,
  disposed: false,
  release: (): void => {},
}));

vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      return {
        ...wiring,
        sweepVerification: () => {
          spy.sweeps++;
          return wiring.sweepVerification();
        },
        disposeVerification: async () => {
          spy.disposeCalls++;
          await new Promise<void>(resolve => {
            spy.release = resolve;
          });
          await wiring.disposeVerification();
          spy.disposed = true;
        },
      };
    },
  };
});

type PluginContext = Parameters<typeof ModelRouterPlugin>[0];
type ChatMessageOutput = Parameters<NonNullable<Awaited<ReturnType<typeof ModelRouterPlugin>>["chat.message"]>>[1];

describe("plugin hookups of the batch coordinator (QA-2.2-20)", () => {
  let dir = "";
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    // Hermetic home: never read the developer's real config or state file.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "omr-batch-hookup-"));
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    invalidateConfigCache();
    Object.assign(spy, { sweeps: 0, disposeCalls: 0, disposed: false, release: () => {} });
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    invalidateConfigCache();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("the idle sweeper calls sweepVerification, and plugin dispose awaits disposeVerification", async () => {
    const ctx = {} as PluginContext;
    const hooks = await ModelRouterPlugin(ctx);
    // The first chat.message runs the idle sweeper (it self-throttles afterwards). The hook reads
    // only the parts of its output.
    const output: Partial<ChatMessageOutput> = { parts: [] };
    await hooks["chat.message"]?.({ sessionID: "S", agent: "fast" }, output as ChatMessageOutput);
    expect(spy.sweeps).toBe(1);

    const dispose = hooks.dispose;
    if (dispose === undefined) throw new Error("the plugin has no dispose hook");
    let returned = false;
    const disposing = dispose().then(() => {
      returned = true;
    });
    await vi.waitFor(() => expect(spy.disposeCalls).toBe(1));
    // Plugin dispose is still waiting for the coordinator's dispose.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(returned).toBe(false);
    spy.release();
    await disposing;
    expect(spy.disposed).toBe(true);
  });
});
