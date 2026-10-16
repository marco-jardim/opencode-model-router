/**
 * test/golden/v1-system-transform.golden.test.ts
 *
 * Phase 1.2 (task 1.2.4), step 1: a characterisation of what the legacy (v1) `experimental.chat.system.transform`
 * puts into `output.system` for a root session with two pending delegations and one late notice. It was recorded
 * from the code before the turn-state providers existed and must stay byte-identical afterwards: on v1 nothing
 * moves out of the system array.
 *
 * The plugin is driven without `routerHost: "v2"` and without a turn-state registry attached through `ROUTER_TURN_STATE_ATTACH` (a v1 host). Pending entries are
 * registered in the plugin's own registry; the late notice comes from the background queue's `takeNotices`.
 * Handles are random, so they are replaced by `<handle-N>` in order of first appearance before the comparison.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import type { LateNotice, PendingRegistry } from "../../src/verify/pending";
import type { DoD } from "../../src/verify/dod";

const plugin = vi.hoisted(() => ({ wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined }));
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      plugin.wiring = wiring;
      return wiring;
    },
  };
});
vi.mock("../../src/verify/reference", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const root = resolve("v1-system-transform-project");
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const LATE_HANDLE = "vrf_0123456789abcdef01234567";

type Transform = (input: { sessionID?: string; model?: { providerID: string; modelID: string } }, output: { system: string[] }) => Promise<void>;

async function makePlugin(): Promise<Transform> {
  const ctx = {
    directory: root,
    worktree: root,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => ({ data: { id: "never" } }),
        prompt: async () => ({ data: { parts: [] } }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  const hooks = (await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0])) as unknown as Record<string, Transform>;
  const transform = hooks["experimental.chat.system.transform"];
  if (transform === undefined) throw new Error("no system transform");
  return transform;
}

function registry(): PendingRegistry {
  if (plugin.wiring === undefined) throw new Error("the plugin built no wiring");
  return plugin.wiring.pending;
}

function register(sessionID: string, n: number): string {
  const r = registry().register({
    orchestratorSessionID: sessionID,
    dispatchID: `task:${sessionID}:${n}`,
    producerSessionID: `producer-${sessionID}-${n}`,
    producerTier: "fast",
    description: `work ${n}`,
    cwd: root,
    root,
    dispatchedAt: 1_000_000 + n,
    dod: DOD,
    reference: Promise.resolve({ kind: "none", reason: "no reference captured" }),
    changedFiles: [],
    risk: { level: n % 2 === 0 ? "low" : "high", reasons: ["some reason"] },
  });
  if (!r.ok) throw new Error(r.detail);
  return r.handle;
}

/** Handles are random: number them by first appearance. */
function normalizeHandles(system: readonly string[]): string[] {
  const seen = new Map<string, string>();
  return system.map(part => part.replace(/vrf_[0-9a-f]{24}/g, handle => {
    let label = seen.get(handle);
    if (label === undefined) {
      label = `<handle-${seen.size + 1}>`;
      seen.set(handle, label);
    }
    return label;
  }));
}

describe("v1 system transform golden (Phase 1.2 characterisation)", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-v1-system-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const overrides = join(home, ".config/opencode/opencode-model-router.overrides.jsonc");
    mkdirSync(dirname(overrides), { recursive: true });
    writeFileSync(overrides, JSON.stringify({ enforcement: { verify: { background: true } } }), "utf-8");
    invalidateConfigCache();
    plugin.wiring = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("v1-system-transform-2-pending-1-late: protocol, then the pending list, then the late notice, all in output.system", async () => {
    const transform = await makePlugin();
    const queue = plugin.wiring?.background;
    if (queue === undefined) throw new Error("background: true built no queue");
    register("orch", 1);
    register("orch", 2);
    const notice: LateNotice = { handle: LATE_HANDLE, description: "late work", introduced: ["a.test.ts > t2"], outcome: "fail" };
    vi.spyOn(queue, "takeNotices").mockReturnValueOnce([notice]);

    const output = { system: [] as string[] };
    await transform({ sessionID: "orch", model: { providerID: "p", modelID: "m" } }, output);

    expect(output.system).toHaveLength(3);
    expect(output.system[1]).toContain("[router] Unverified delegations");
    expect(output.system[2]).toContain("[router] Background verification found introduced failures:");
    const rendered = normalizeHandles(output.system).map((part, i) => `===== output.system[${i}] =====\n${part}\n`).join("");
    await expect(rendered).toMatchFileSnapshot("__snapshots__/v1-system-transform.system.txt");
  });
});
