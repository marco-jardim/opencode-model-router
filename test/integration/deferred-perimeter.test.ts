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
import type { CheckPlacement } from "../../src/verify/types";
import { createHash } from "node:crypto";
import { LINK_DRIFT_CAVEAT } from "../../src/verify/wiring";

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
  /** P2e QA-1 #5b: paths whose fs/promises realpath fails, with the error code. */
  realpathFails: new Map<string, string>(),
}));

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realReal = actual.realpath as (p: string, ...rest: unknown[]) => Promise<string>;
  const realpath = async (p: string, ...rest: unknown[]): Promise<string> => {
    const code = state.realpathFails.get(String(p));
    if (code !== undefined) throw Object.assign(new Error(`${code}: realpath ${String(p)}`), { code });
    return realReal(p, ...rest);
  };
  return { ...actual, realpath, default: { ...actual, realpath } };
});

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
/** Junctions a test made; each is removed itself (never recursed through) before the temporary home. */
const junctions: string[] = [];
const junction = (target: string, at: string): void => {
  fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
  junctions.push(at);
};
/** W links `target` through node_modules/<name> (a package link, as at dispatch). */
const linkInW = (target: string, name = path.basename(target)): void => {
  fs.mkdirSync(path.join(work, "node_modules"), { recursive: true });
  junction(target, path.join(work, "node_modules", name));
};
/** Removes W's node_modules/<name> link itself (never recursing through it). */
const unlinkInW = (target: string, name = path.basename(target)): void => {
  void target;
  fs.rmSync(path.join(work, "node_modules", name), { recursive: false, force: true });
};

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
  dod?: DoD;
  placements?: readonly (CheckPlacement | undefined)[];
}

/** The digests of the producer's file right after it returned (the file is never touched again: no drift). */
const digestsOf = (file: string): Map<string, string> =>
  new Map([[file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]]);

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
    dod: reg.dod ?? FILE_DOD,
    digests: Promise.resolve(digestsOf(resolve(work, "index.ts"))),
    reference: Promise.resolve(reg.captured === true
      ? { kind: "captured" as const, reference: { ...REF, root: work } }
      : { kind: "none" as const, reason: "not requested" }),
    changedFiles: [{ path: resolve(work, "index.ts"), status: " M" }],
    risk: { level: "low", reasons: [] } as unknown as Parameters<typeof wiring.pending.register>[0]["risk"],
    ...(reg.unattributedWriters !== undefined ? { unattributedWriters: reg.unattributedWriters } : {}),
    ...(reg.perimeter !== undefined ? { perimeter: reg.perimeter } : {}),
    ...(reg.placements !== undefined ? { placements: reg.placements } : {}),
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
  // Native: the long form of every path (os.tmpdir() can be an 8.3 short name on Windows), as a canonical placement cwd is.
  const real = (dir: string): string => fs.realpathSync.native(dir);
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
  state.realpathFails.clear();
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
  for (const junction of junctions.splice(0)) fs.rmSync(junction, { recursive: false, force: true });
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

/** The outcome router_verify reported for `handle` (its first report line). */
const outcomeOf = (out: string, handle: string): string | undefined =>
  new RegExp(`^- ${handle} \u00b7 .* \u00b7 (pass|fail|unverifiable)`, "m").exec(out)?.[1];
const ANY_LINK_CAVEAT = /the linked repository /;

describe("S11 link drift (P2e.4a)", () => {
  /** lib-b as W's frozen link target: its head and fingerprint at return are treeOf(libB, HEAD_B)'s. */
  const libLink = (): DeferredPerimeter["links"][number] => ({ at: libB, root: libB, name: "lib-b", head: HEAD_B, fingerprint: "fp-lib-b" });

  it("unchanged → pass", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, treeOf(libB, HEAD_B));
    const handle = register({ perimeter: frozen("unchanged", { links: [libLink()] }) });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("pass");
    expect(out).not.toMatch(ANY_LINK_CAVEAT);
    // One hardened snapshot of the link root for the call.
    expect(state.calls.filter(at => at === libB)).toHaveLength(1);
  });

  it("changed since return → UNVERIFIED with the S11 caveat", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, treeOf(libB, "c".repeat(40)));
    const handle = register({ perimeter: frozen("unchanged", { links: [libLink()] }) });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("unverifiable");
    expect(out).toContain(LINK_DRIFT_CAVEAT.changed("lib-b", libB));
  });

  it("fail stays fail + caveat", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, { ...treeOf(libB, HEAD_B), fingerprint: "fp-changed" });
    const dod: DoD = { ...FILE_DOD, checks: [{ kind: "fileExists", path: "missing.ts" }] };
    const handle = register({ dod, perimeter: frozen("unchanged", { links: [libLink()] }) });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("fail");
    expect(out).toContain(LINK_DRIFT_CAVEAT.changed("lib-b", libB));
  });

  it("cannot be re-observed → never pass", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, undefined);
    const handle = register({ perimeter: frozen("unchanged", { links: [libLink()] }) });
    const out = await verify(h, handle);
    // P2e QA-1 #5a: an unobserved link is transient: not judged (the handle stays open), never a pass.
    expect(out).toMatch(new RegExp(`^- ${handle} \u00b7 .* \u00b7 not judged`, "m"));
    expect(outcomeOf(out, handle)).toBeUndefined();
    expect(out).toContain(LINK_DRIFT_CAVEAT.unobserved("lib-b", libB));
  });

  it("a working-set root that is not a link changed → no caveat", async () => {
    const h = await makePlugin();
    state.byDir.set(libB, treeOf(libB, "c".repeat(40)));
    const handle = register({ perimeter: frozen("unchanged", { workingSet: [{ root: libB, name: "lib-b" }], links: [] }) });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("pass");
    expect(out).not.toMatch(ANY_LINK_CAVEAT);
    expect(state.calls).not.toContain(libB);
  });

  it("no perimeter → no link snapshot", async () => {
    const h = await makePlugin();
    state.byDir.set(libB, treeOf(libB, "c".repeat(40)));
    const handle = register({});
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("pass");
    expect(out).not.toMatch(ANY_LINK_CAVEAT);
    expect(new Set(state.calls)).toEqual(new Set([work]));
  });
});

describe("placements at router_verify (P2e.4b)", () => {
  const NOTHING_RAN = /check 2 \(fileExists\) cwd=\S+ no longer resolves to the same repository since the producer returned; nothing ran/;
  /** Check 1 runs in W (it covers W's change, I3); check 2 is placed in lib-b, a git repository holding lib.txt (W does not). */
  const placedDod: DoD = { ...FILE_DOD, checks: [{ kind: "fileExists", path: "index.ts" }, { kind: "fileExists", path: "lib.txt" }] };
  const gitRepo = (dir: string): void => {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  };

  it("the gate gets the frozen placements; a placed check runs in its cwd", async () => {
    const h = await makePlugin();
    gitRepo(libB);
    fs.writeFileSync(path.join(libB, "lib.txt"), "lib\n", "utf-8");
    const placements: readonly (CheckPlacement | undefined)[] = [undefined, { cwd: libB, top: libB, foreign: true }];
    const handle = register({ dod: placedDod, placements });
    const out = await verify(h, handle);
    // The registry froze a copy at register (R3): the gate gets that copy, equal to what was registered.
    expect(acceptSpy.mock.calls[0]?.[0].checkPlacements).toEqual(placements);
    // lib.txt exists only in lib-b: the pass proves check 2 ran there.
    expect(outcomeOf(out, handle)).toBe("pass");
  });

  it("I3 uncovered → unverifiable", async () => {
    const h = await makePlugin();
    gitRepo(libB);
    fs.writeFileSync(path.join(libB, "lib.txt"), "lib\n", "utf-8");
    const dod: DoD = { ...FILE_DOD, checks: [{ kind: "fileExists", path: "lib.txt" }] };
    const handle = register({ dod, placements: [{ cwd: libB, top: libB, foreign: true }] });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("unverifiable");
    expect(out).toMatch(/is not covered by any check root/);
  });

  it("a junction swapped under the placement → nothing ran", async () => {
    const h = await makePlugin();
    gitRepo(libB);
    const libC = path.join(home, "lib-c");
    fs.mkdirSync(libC, { recursive: true });
    gitRepo(libC);
    const placed = fs.realpathSync(libC);
    const handle = register({ dod: placedDod, placements: [undefined, { cwd: placed, top: placed, foreign: true }] });
    // After return: lib-c is replaced by a junction to lib-b (another repository).
    fs.rmSync(libC, { recursive: true, force: true });
    junction(libB, libC);
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("unverifiable");
    expect(out).toMatch(NOTHING_RAN);
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it("git top changed → nothing ran", async () => {
    const h = await makePlugin();
    gitRepo(libB);
    const sub = path.join(libB, "sub");
    fs.mkdirSync(sub, { recursive: true });
    const handle = register({ dod: placedDod, placements: [undefined, { cwd: sub, top: libB, foreign: true }] });
    // After return: sub became its own repository, so its top is no longer lib-b.
    gitRepo(sub);
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("unverifiable");
    expect(out).toMatch(NOTHING_RAN);
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it("no placements → accept gets no checkPlacements key", async () => {
    const h = await makePlugin();
    const handle = register({});
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle)).toBe("pass");
    const delegation = acceptSpy.mock.calls[0]?.[0];
    expect(delegation !== undefined && "checkPlacements" in delegation).toBe(false);
  });
});

describe("P2e QA round 1", () => {
  /** A frozen link target `dir` (named after it) whose state at return is treeOf(dir, HEAD_B). */
  const linkTo = (dir: string): DeferredPerimeter["links"][number] =>
    ({ at: dir, root: dir, name: path.basename(dir), head: HEAD_B, fingerprint: `fp-${path.basename(dir)}` });
  const notJudged = (out: string, handle: string): boolean => new RegExp(`^- ${handle} \u00b7 .* \u00b7 not judged`, "m").test(out);

  it("#2 a link retargeted after return → UNVERIFIED with S11 (the old target and the new one), no git on the new one", async () => {
    const h = await makePlugin();
    const libX = path.join(home, "lib-x");
    fs.mkdirSync(libX, { recursive: true });
    linkInW(libB);
    state.byDir.set(libB, treeOf(libB, HEAD_B));
    const handle = register({ perimeter: frozen("unchanged", { links: [linkTo(libB)] }) });
    // After return: W's node_modules/lib-b now points at lib-x.
    unlinkInW(libB);
    linkInW(libX, "lib-b");
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle), out).toBe("unverifiable");
    expect(out).toContain(LINK_DRIFT_CAVEAT.changed("lib-b", libB));
    expect(out).toContain(LINK_DRIFT_CAVEAT.changed("lib-x", fs.realpathSync.native(libX)));
    expect(state.calls).not.toContain(fs.realpathSync.native(libX));
  });

  it("#4 a link target swapped to a non-admitted directory → unobserved, never snapshotted", async () => {
    const h = await makePlugin();
    const libC = path.join(home, "lib-c");
    const outside = path.join(home, "outside");
    fs.mkdirSync(libC, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    linkInW(libC);
    state.byDir.set(libC, treeOf(libC, HEAD_B));
    const handle = register({ perimeter: frozen("unchanged", { links: [{ ...linkTo(libC), admit: root => !root.includes("outside") }] }) });
    // After return: lib-c itself is replaced by a junction to a directory its admission refuses.
    fs.rmSync(libC, { recursive: true, force: true });
    junction(outside, libC);
    const out = await verify(h, handle);
    expect(out).toContain(LINK_DRIFT_CAVEAT.unobserved("lib-c", libC));
    expect(outcomeOf(out, handle)).not.toBe("pass");
    // No snapshot (no git) of lib-c, nor of where it now points.
    expect(state.calls).not.toContain(libC);
    expect(state.calls).not.toContain(fs.realpathSync.native(outside));
  });

  it("#5a an unobserved link (no snapshot in time) → not judged: the handle stays open for another router_verify", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, undefined);
    const handle = register({ perimeter: frozen("unchanged", { links: [linkTo(libB)] }) });
    const out = await verify(h, handle);
    expect(notJudged(out, handle), out).toBe(true);
    expect(out).toContain(LINK_DRIFT_CAVEAT.unobserved("lib-b", libB));
    expect(captured.wiring?.pending.listUnverified("orch").map(entry => entry.handle)).toContain(handle);
    // Observable again: the next call judges it.
    state.byDir.set(libB, treeOf(libB, HEAD_B));
    const again = await verify(h, handle);
    expect(outcomeOf(again, handle), again).toBe("pass");
  });

  it("#5a control: a changed link stays a final UNVERIFIED", async () => {
    const h = await makePlugin();
    linkInW(libB);
    state.byDir.set(libB, treeOf(libB, "c".repeat(40)));
    const handle = register({ perimeter: frozen("unchanged", { links: [linkTo(libB)] }) });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle), out).toBe("unverifiable");
    expect(captured.wiring?.pending.listUnverified("orch").map(entry => entry.handle)).not.toContain(handle);
  });

  it("#5b a placement whose realpath fails with EPERM → not judged (could not be checked), not drift", async () => {
    const h = await makePlugin();
    fs.mkdirSync(path.join(libB, ".git"), { recursive: true });
    const placedDod: DoD = { ...FILE_DOD, checks: [{ kind: "fileExists", path: "index.ts" }, { kind: "fileExists", path: "lib.txt" }] };
    const handle = register({ dod: placedDod, placements: [undefined, { cwd: libB, top: libB, foreign: true }] });
    state.realpathFails.set(libB, "EPERM");
    const out = await verify(h, handle);
    expect(notJudged(out, handle), out).toBe(true);
    expect(out).toMatch(/check 2 \(fileExists\) cwd=\S+ could not be checked since the producer returned \(EPERM\); nothing ran/);
    expect(out).not.toMatch(/no longer resolves to the same repository/);
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it("#5b control: a placement whose cwd is gone (ENOENT) is drift: final, nothing ran", async () => {
    const h = await makePlugin();
    const gone = path.join(home, "gone");
    fs.mkdirSync(path.join(gone, ".git"), { recursive: true });
    const placedDod: DoD = { ...FILE_DOD, checks: [{ kind: "fileExists", path: "index.ts" }, { kind: "fileExists", path: "lib.txt" }] };
    const cwd = fs.realpathSync.native(gone);
    const handle = register({ dod: placedDod, placements: [undefined, { cwd, top: cwd, foreign: true }] });
    fs.rmSync(gone, { recursive: true, force: true });
    const out = await verify(h, handle);
    expect(outcomeOf(out, handle), out).toBe("unverifiable");
    expect(out).toMatch(/no longer resolves to the same repository since the producer returned; nothing ran/);
  });
});
