/**
 * test/integration/pending-list-transform.test.ts
 *
 * Phase 2.4.4 (plan section 1.5-20; pending.ts R9 buildPendingListBlock): the system transform
 * lists the calling orchestrator's still-unverified delegations, at most 5 and newest first, as
 * one block that is only pushed when the list is non-empty, and never for a subagent.
 *
 * Entries are registered directly in the plugin's own registry, with the shape 2.4.2's
 * finishDeferred registers; no dispatch runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import { PENDING_LIST_LIMIT, type PendingRegistry } from "../../src/verify/pending";
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

const root = resolve("pending-list-project");
const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "testsPass", command: "npm test" }] };
const HEADER = "[router] Unverified delegations in this session (newest first):";

type Transform = (input: { sessionID?: string; model?: { providerID: string; modelID: string } }, output: { system: string[] }) => Promise<void>;

/** Session ids whose session.get answers with a parent: subagents. */
const children = new Set<string>(["child"]);

async function makePlugin(): Promise<Transform> {
  const ctx = {
    directory: root,
    worktree: root,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: children.has(path.id) ? { parentID: "orch" } : {} }),
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
    dispatchedAt: Date.now(),
    dod: DOD,
    reference: Promise.resolve({ kind: "none", reason: "no reference captured" }),
    changedFiles: [],
    risk: { level: n % 2 === 0 ? "low" : "high", reasons: ["some reason"] },
  });
  if (!r.ok) throw new Error(r.detail);
  return r.handle;
}

async function systemFor(transform: Transform, sessionID: string | undefined): Promise<string[]> {
  const output = { system: [] as string[] };
  await transform(sessionID === undefined ? { model: { providerID: "p", modelID: "m" } } : { sessionID, model: { providerID: "p", modelID: "m" } }, output);
  return output.system;
}

const pendingBlock = (system: readonly string[]): string | undefined => system.find(s => s.startsWith(HEADER));

describe("the pending list in the orchestrator's system prompt (2.4.4)", () => {
  let home = "";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-pending-list-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.MODEL_ROUTER_ENFORCE = "1";
    invalidateConfigCache();
    plugin.wiring = undefined;
  });

  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("is absent when the orchestrator has no unverified delegation (the prompt does not grow)", async () => {
    const transform = await makePlugin();
    const system = await systemFor(transform, "orch");
    expect(system).toHaveLength(1);
    expect(pendingBlock(system)).toBeUndefined();
  });

  it("lists the orchestrator's entries as one block after the protocol: at most 5, newest first", async () => {
    const transform = await makePlugin();
    const handles = Array.from({ length: 7 }, (_, i) => register("orch", i));
    const system = await systemFor(transform, "orch");
    expect(system).toHaveLength(2);
    const block = pendingBlock(system);
    expect(system[1]).toBe(block);
    const lines = (block ?? "").split("\n");
    const items = lines.filter(l => l.startsWith("- vrf_"));
    expect(items).toHaveLength(PENDING_LIST_LIMIT);
    const newestFirst = [...handles].reverse();
    expect(items.map(l => l.slice(2, 2 + 28))).toEqual(newestFirst.slice(0, PENDING_LIST_LIMIT));
    expect(items[0]).toBe(`- ${handles[6]} \u00b7 risk low \u00b7 work 6`);
    expect(lines).toContain("- ... and 2 more");
    expect(lines[lines.length - 1]).toContain("call `router_verify` with the handles that matter, or with `pending: true`");
  });

  it("a verified entry leaves the list; the last one leaving removes the block", async () => {
    const transform = await makePlugin();
    const [first, second] = [register("orch", 1), register("orch", 2)];
    const claim = registry().markVerifying("orch", second);
    if (claim.kind !== "claimed") throw new Error(claim.kind);
    claim.settle({ verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] }, retryable: false });
    const block = pendingBlock(await systemFor(transform, "orch")) ?? "";
    expect(block).toContain(first);
    expect(block).not.toContain(second);
    const last = registry().markVerifying("orch", first);
    if (last.kind !== "claimed") throw new Error(last.kind);
    // An entry being verified is not "unverified" either.
    expect(pendingBlock(await systemFor(transform, "orch"))).toBeUndefined();
    last.settle({ verdict: { pass: true, outcome: "pass", method: "deterministic", reasons: [] }, retryable: false });
    expect(pendingBlock(await systemFor(transform, "orch"))).toBeUndefined();
  });

  it("a TTL-expired entry leaves the list at read time, with no sweep", async () => {
    // Faked before the plugin starts, so the registry's clock is the fake Date.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const transform = await makePlugin();
      const handle = register("orch", 1);
      expect(pendingBlock(await systemFor(transform, "orch"))).toContain(handle);
      vi.setSystemTime(Date.now() + 3_600_000 - 1);
      expect(pendingBlock(await systemFor(transform, "orch"))).toContain(handle);
      vi.setSystemTime(Date.now() + 1);
      expect(pendingBlock(await systemFor(transform, "orch"))).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sessions never see each other's entries", async () => {
    const transform = await makePlugin();
    const mine = register("orch", 1);
    const system = await systemFor(transform, "orch2");
    expect(pendingBlock(system)).toBeUndefined();
    expect(pendingBlock(await systemFor(transform, "orch"))).toContain(mine);
  });

  it("is never injected for a subagent, nor without a session id", async () => {
    const transform = await makePlugin();
    register("child", 1);
    expect(pendingBlock(await systemFor(transform, "child"))).toBeUndefined();
    register("orch", 1);
    expect(await systemFor(transform, undefined)).toEqual([]);
  });
});
