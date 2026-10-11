/**
 * test/integration/deferred-perimeter.test.ts
 *
 * Cross-repo Phase 2 (P2e.3, docs/design/cross-repo-phase2-plan.md "P2e"): router_verify gates a deferred entry with the
 * perimeter frozen at return (PendingEntry.perimeter), not with a fresh one.
 * - I4/I8 are decided from the frozen observation's root statuses (never re-snapshotted at router_verify).
 * - D6: consumers are discovered at router_verify over the frozen working set.
 * - The frozen pins reach materialize, and pinNow admits exactly the frozen links.
 * - An entry with no perimeter takes no extra snapshot or discovery.
 *
 * Entries are registered directly through the wiring's pending registry (nothing registers a perimeter yet), then claimed through
 * the real router_verify. The tree snapshot is pinned per directory through the `src/verify/tree` mock seam
 * (perimeter.test.ts's harness); the gate (`accept`) is spied to read the artefact and deps it was handed.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache } from "../../src/router/config";
import * as gateModule from "../../src/verify/gate";
import type { PerimeterObservation } from "../../src/verify/gate";
import type { TreeSnapshot } from "../../src/verify/dispatch";
import type { DoD } from "../../src/verify/dod";
import type { DispatchReference } from "../../src/verify/reference";
import type { DeferredPerimeter } from "../../src/verify/pending";
import type { LinkPin } from "../../src/verify/pin";

const state = vi.hoisted(() => ({
  /** What snapshotTree resolves with for a directory (else `fallback`). */
  byDir: new Map<string, unknown>(),
  fallback: undefined as unknown,
  /** Every directory the router snapshotted, in order. */
  calls: [] as string[],
  /** discoverConsumers calls: the W root and the candidate roots. */
  discoveries: [] as { w: string; roots: string[] }[],
  /** The reference deps (pinNow) of every scope opener the wiring built. */
  openers: [] as { pinNow: (root: string) => Promise<unknown> }[],
}));

const captured = vi.hoisted(() => ({ wiring: undefined as import("../../src/verify/wiring").VerificationWiring | undefined }));

vi.mock("../../src/verify/tree", () => ({
  snapshotTree: async (at: string) => {
    state.calls.push(at);
    return state.byDir.has(at) ? state.byDir.get(at) : state.fallback;
  },
}));
vi.mock("../../src/verify/perimeter", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/perimeter")>();
  return {
    ...actual,
    discoverConsumers: (...args: Parameters<typeof actual.discoverConsumers>) => {
      state.discoveries.push({ w: args[0], roots: args[1].map(candidate => candidate.root) });
      return actual.discoverConsumers(...args);
    },
  };
});
vi.mock("../../src/verify/deterministic", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/deterministic")>();
  return {
    ...actual,
    createScopeOpener: (deps: Parameters<typeof actual.createScopeOpener>[0]) => {
      if (deps.reference?.pinNow !== undefined) state.openers.push({ pinNow: deps.reference.pinNow });
      return actual.createScopeOpener(deps);
    },
  };
});
vi.mock("../../src/verify/wiring", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/verify/wiring")>();
  return {
    ...actual,
    createVerificationWiring: (...args: Parameters<typeof actual.createVerificationWiring>) => {
      const wiring = actual.createVerificationWiring(...args);
      captured.wiring = wiring;
      return wiring;
    },
  };
});

const HEAD_W = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const FILE_DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "fileExists", path: "index.ts" }] };
const ANY_I4 = /during the dispatch, and the producer ran /;
const CONSUMER_CAVEAT = /links this work root \(node_modules\/app-a\) and no check ran there/;

let home = "";
let work = "";
let libB = "";
let consumer = "";
let acceptSpy: MockInstance<typeof gateModule.accept>;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

const treeOf = (rootDir: string, head: string): TreeSnapshot => ({
  cwd: rootDir, root: rootDir, head, branch: "main", fingerprint: `fp-${path.basename(rootDir)}`, dirty: true,
  files: [{ path: resolve(rootDir, "index.ts"), status: " M" }], digests: new Map(),
});

const observation = (status: "changed" | "unchanged"): PerimeterObservation => ({
  w: { root: work, name: "app-a", branch: "main", head: HEAD_W },
  roots: [{ root: libB, name: "lib-b", status, branch: "main", head: HEAD_B }],
});

const REF: DispatchReference = { root: "", head: "HEAD", commit: "HEAD", untracked: new Map(), tracked: new Map(), captureReasons: [], capturedAt: 0 };

interface Harness { hooks: any } // eslint-disable-line @typescript-eslint/no-explicit-any

async function makePlugin(): Promise<Harness> {
  const ctx = {
    directory: work,
    worktree: work,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        get: async () => ({ data: {} }),
        create: async () => ({ data: { id: "sess_1" } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "unused" }] } }),
        abort: async () => ({}),
        delete: async () => ({}),
      },
    },
  };
  return { hooks: await ModelRouterPlugin(ctx as unknown as Parameters<typeof ModelRouterPlugin>[0]) };
}

interface Registered {
  perimeter?: DeferredPerimeter;
  unattributedWriters?: readonly string[];
  captured?: boolean;
}

/** Registers a pending entry of the plugin's own wiring (as the deferred finish would) and returns its handle. */
function register(reg: Registered): string {
  const wiring = captured.wiring;
  if (wiring === undefined) throw new Error("the plugin built no wiring");
  const result = wiring.pending.register({
    orchestratorSessionID: "orch",
    dispatchID: "d1",
    producerSessionID: "child1",
    producerTier: "fast",
    description: "the work",
    cwd: work,
    root: work,
    dispatchedAt: Date.now(),
    dod: FILE_DOD,
    reference: Promise.resolve(reg.captured === true
      ? { kind: "captured" as const, reference: { ...REF, root: work } }
      : { kind: "none" as const, reason: "not requested" }),
    changedFiles: [{ path: resolve(work, "index.ts"), status: " M" }],
    risk: { level: "low", reasons: [] } as unknown as Parameters<typeof wiring.pending.register>[0]["risk"],
    ...(reg.unattributedWriters !== undefined ? { unattributedWriters: reg.unattributedWriters } : {}),
    ...(reg.perimeter !== undefined ? { perimeter: reg.perimeter } : {}),
  });
  if (!result.ok) throw new Error(`register failed: ${result.code} ${result.detail}`);
  return result.handle;
}

const frozen = (
  status: "changed" | "unchanged",
  extra: { workingSet?: DeferredPerimeter["workingSet"]; links?: DeferredPerimeter["links"]; pins?: readonly LinkPin[] } = {},
): DeferredPerimeter => ({
  observation: observation(status),
  workingSet: extra.workingSet ?? [{ root: libB, name: "lib-b" }],
  links: extra.links ?? [],
  pins: Promise.resolve(extra.pins ?? []),
});

const verify = async (h: Harness, handle: string): Promise<string> =>
  h.hooks.tool.router_verify.execute({ handles: [handle] }, { sessionID: "orch" });
const gateResults = async (): Promise<string> => JSON.stringify(await Promise.all(acceptSpy.mock.results.map(result => result.value)));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-deferred-perimeter-"));
  const real = (dir: string): string => fs.realpathSync(dir);
  fs.mkdirSync(path.join(home, "app-a"), { recursive: true });
  work = real(path.join(home, "app-a"));
  libB = path.join(home, "lib-b");
  consumer = path.join(home, "consumer-c");
  fs.mkdirSync(libB, { recursive: true });
  fs.mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
  libB = real(libB);
  consumer = real(consumer);
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "app-a" }), "utf-8");
  fs.writeFileSync(path.join(work, "index.ts"), "export {};\n", "utf-8");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.MODEL_ROUTER_ENFORCE = "1";
  process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
  invalidateConfigCache();
  captured.wiring = undefined;
  state.byDir.clear();
  state.calls.length = 0;
  state.discoveries.length = 0;
  state.openers.length = 0;
  state.fallback = treeOf(work, HEAD_W);
  acceptSpy = vi.spyOn(gateModule, "accept");
});

afterEach(() => {
  acceptSpy.mockRestore();
  for (const key of ["HOME", "USERPROFILE"] as const) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete process.env.MODEL_ROUTER_ENFORCE;
  delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
  invalidateConfigCache();
  // The consumer's link is removed itself first: rmSync must never recurse through a junction into app-a.
  fs.rmSync(path.join(consumer, "node_modules", "app-a"), { recursive: false, force: true });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("deferred perimeter at router_verify", () => {
  it("I4 frozen changed + writers → unverifiable", async () => {
    const h = await makePlugin();
    const handle = register({ perimeter: frozen("changed"), unattributedWriters: ["bash"] });
    const out = await verify(h, handle);
    expect(out).toMatch(ANY_I4);
    expect(out).toContain("lib-b");
    expect(await gateResults()).toMatch(/"outcome":"unverifiable"/);
  });

  it("a root that changed only after return → no I4", async () => {
    const h = await makePlugin();
    // Frozen unchanged at return; lib-b's tree then changes on disk. router_verify never snapshots it again.
    state.byDir.set(libB, treeOf(libB, "c".repeat(40)));
    const handle = register({ perimeter: frozen("unchanged"), unattributedWriters: ["bash"] });
    const out = await verify(h, handle);
    expect(out).not.toMatch(ANY_I4);
    expect(state.calls).not.toContain(libB);
  });

  it("I8 names P as at return", async () => {
    const h = await makePlugin();
    const handle = register({ perimeter: frozen("changed") });
    const out = await verify(h, handle);
    expect(out).not.toMatch(ANY_I4);
    const scope = /verified scope: app-a \(main @ aaaaaaa\); also observed: lib-b \(main @ bbbbbbb, changed during the dispatch\)/;
    expect(await gateResults()).toMatch(scope);
    expect(state.calls).not.toContain(libB);
  });

  it("D6 consumer found at router_verify → UNVERIFIED with the consumer caveat", async () => {
    const h = await makePlugin();
    fs.symlinkSync(work, path.join(consumer, "node_modules", "app-a"), process.platform === "win32" ? "junction" : "dir");
    const handle = register({ perimeter: frozen("unchanged", { workingSet: [{ root: consumer, name: "consumer-c" }] }) });
    const out = await verify(h, handle);
    // Discovery ran over the frozen working set only, with W = the observation's W root.
    expect(state.discoveries).toEqual([{ w: work, roots: [consumer] }]);
    expect(out).toMatch(CONSUMER_CAVEAT);
    expect(out).toContain("consumer-c");
    expect(out).not.toMatch(/\bpass$/m);
    expect(acceptSpy.mock.calls[0]?.[1].perimeter?.consumers).toEqual([{ root: consumer, name: "consumer-c", entry: "app-a" }]);
  });

  it("pins reach materialize; pinNow admits the frozen link", async () => {
    const h = await makePlugin();
    const pins: readonly LinkPin[] = [{ kind: "pinned", root: libB, head: HEAD_B, fingerprint: "pinned-fp", ignored: "ign", nested: [] }];
    state.byDir.set(libB, { ...treeOf(libB, HEAD_B), ignored: "ign" });
    const other = path.join(home, "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    state.byDir.set(other, { ...treeOf(other, HEAD_B), ignored: "ign" });
    const link = { at: path.join(work, "node_modules", "lib-b"), root: libB, name: "lib-b", head: HEAD_B, fingerprint: "pinned-fp", admit: () => true };
    const handle = register({ captured: true, perimeter: frozen("unchanged", { pins, links: [link] }) });
    await verify(h, handle);
    // The SAME pins array rides on the captured reference the gate was handed.
    const reference = acceptSpy.mock.calls[0]?.[2].deterministic.reference;
    expect(reference?.kind).toBe("captured");
    if (reference?.kind !== "captured") return;
    expect(reference.reference.pins).toBe(pins);
    // pinNow admits exactly the frozen link's root, not another directory.
    const opener = state.openers.at(-1);
    expect(opener).toBeDefined();
    expect(await opener?.pinNow(libB)).toMatchObject({ kind: "pinned", root: libB });
    expect(await opener?.pinNow(other)).toEqual({ kind: "unpinnable", root: other, why: "not-admitted" });
  });

  it("no perimeter → no extra snapshot or discovery", async () => {
    const h = await makePlugin();
    const handle = register({ captured: true });
    await verify(h, handle);
    expect(state.discoveries).toEqual([]);
    expect(new Set(state.calls)).toEqual(new Set([work]));
    const artefact = acceptSpy.mock.calls[0]?.[1];
    expect(artefact && "perimeter" in artefact).toBe(false);
    const reference = acceptSpy.mock.calls[0]?.[2].deterministic.reference;
    expect(reference?.kind).toBe("captured");
    if (reference?.kind === "captured") expect("pins" in reference.reference).toBe(false);
  });
});
