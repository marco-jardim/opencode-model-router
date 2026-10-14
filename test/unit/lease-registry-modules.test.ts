import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeaseRegistry, type HolderInput } from "../../src/router/leases";
import type { LeaseRegistryHandle } from "../../src/compat/background";

type BackgroundModule = typeof import("../../src/compat/background");
type Options = Parameters<BackgroundModule["acquireLeaseRegistry"]>[0];
const handles: LeaseRegistryHandle[] = [];
const tree = join(tmpdir(), "omr-lease-module-test");
const seams = { realpath: (path: string) => path, repoKeyOf: () => undefined, now: () => 100 };
const plan: HolderInput = { holderID: "plan-child", tree, isChild: true, taskRef: "p:T1", scope: "until-integrated" };
const live: HolderInput = { ...plan, holderID: "live-child", taskRef: "p:T2" };
const empty = { version: 1, takenAt: 100, holders: [], leases: [] };
let seq = 0;

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release();
  vi.restoreAllMocks();
});

async function copies(): Promise<[BackgroundModule, BackgroundModule]> {
  vi.resetModules();
  const a = await import("../../src/compat/background");
  vi.resetModules();
  const b = await import("../../src/compat/background");
  expect(a.acquireLeaseRegistry).not.toBe(b.acquireLeaseRegistry);
  return [a, b];
}

function options(): Options {
  return { runMode: "annotate", snapshotPath: join(tree, `snapshot-${seq++}.json`), seams, logger: { warn: vi.fn() } };
}

function acquire(module: BackgroundModule, opts: Options): LeaseRegistryHandle {
  const handle = module.acquireLeaseRegistry(opts);
  handles.push(handle);
  return handle;
}

function previousSnapshot() {
  const registry = createLeaseRegistry(seams, { runMode: "annotate" });
  expect(registry.acquireWrite(plan, "saved.ts").ok).toBe(true);
  expect(registry.acquireWrite({ holderID: "old-ad-hoc", tree, isChild: true, scope: "until-complete" }, "old.ts").ok).toBe(true);
  return registry.snapshot();
}

describe("process-wide lease registry across separately imported modules", () => {
  it("shares identity, first options and refs, while observation neither creates nor retains a registry", async () => {
    const [a, b] = await copies();
    const opts = options();
    expect(b.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
    const one = acquire(a, opts);
    const two = acquire(b, { ...opts, runMode: "refuse", seams: { ...seams, now: () => 999 } });
    expect(two.registry).toBe(one.registry);
    expect(b.peekLeaseRegistry(opts.snapshotPath)).toBe(one.registry);
    expect(one.registry.acquireWrite(plan, "live.ts").ok).toBe(true);
    expect(two.registry.snapshot().takenAt).toBe(100);
    expect(two.registry.checkRun({ holderID: "runner", tree, isChild: true }, tree)).toMatchObject({ ok: true, fileCount: 1, contaminatedBy: [{ holderID: plan.holderID }] });
    const separate = acquire(b, options());
    expect(separate.registry).not.toBe(one.registry);
    await one.release();
    await one.release();
    const three = acquire(a, opts);
    expect(three.registry).toBe(two.registry);
    await two.release();
    expect(b.peekLeaseRegistry(opts.snapshotPath)).toBe(three.registry);
    await three.release();
    expect(a.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
    const fresh = acquire(b, opts);
    expect(fresh.registry).not.toBe(one.registry);
    expect(fresh.registry.snapshot().leases).toEqual([]);
  });

  it("shares release listeners across copies, isolates faults, honours unsubscribe and starts fresh after final disposal", async () => {
    const [a, b] = await copies();
    const opts = options();
    const one = acquire(a, opts), two = acquire(b, opts);
    const first = vi.fn(), second = vi.fn();
    const offFault = one.onRelease(() => { throw new Error("broken listener"); });
    const offFirst = one.onRelease(first);
    const offSecond = two.onRelease(second);
    two.notifyReleased();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(opts.logger.warn).toHaveBeenCalledWith("[router] lease release listener failed", { error: "broken listener" });
    offFault();
    offFirst();
    one.notifyReleased();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    await one.release();
    two.notifyReleased();
    expect(second).toHaveBeenCalledTimes(3);
    offSecond();
    await two.release();
    acquire(a, opts).notifyReleased();
    expect(second).toHaveBeenCalledTimes(3);
  });

  it("initializes once under competing starts, drops complete holders, and never replays a snapshot over live or released leases", async () => {
    const [a, b] = await copies();
    const opts = options();
    const snapshot = previousSnapshot();
    const firstLoad = vi.fn(() => snapshot), laterLoad = vi.fn(() => empty);
    const [one, two] = await Promise.all([
      Promise.resolve().then(() => acquire(a, { ...opts, loadSnapshot: firstLoad })),
      Promise.resolve().then(() => acquire(b, { ...opts, loadSnapshot: laterLoad })),
    ]);
    expect(one.registry).toBe(two.registry);
    expect(firstLoad).toHaveBeenCalledOnce();
    expect(laterLoad).not.toHaveBeenCalled();
    expect(one.registry.snapshot().holders.map(holder => holder.holderID)).toEqual([plan.holderID]);
    expect(two.registry.acquireWrite(live, "saved.ts")).toMatchObject({ ok: false, reason: "held" });
    expect(two.registry.acquireWrite(live, "live.ts").ok).toBe(true);
    const third = acquire(a, { ...opts, loadSnapshot: laterLoad });
    expect(third.registry.snapshot().leases).toHaveLength(2);
    one.registry.releaseTask(plan.taskRef!);
    const fourth = acquire(b, { ...opts, loadSnapshot: firstLoad });
    expect(fourth.registry.snapshot().leases.map(lease => lease.holderID)).toEqual([live.holderID]);
    expect(firstLoad).toHaveBeenCalledOnce();
    expect(laterLoad).not.toHaveBeenCalled();
    for (const handle of [one, two, third, fourth]) await handle.release();
    const restarted = acquire(b, { ...opts, loadSnapshot: firstLoad });
    expect(restarted.registry).not.toBe(one.registry);
    expect(firstLoad).toHaveBeenCalledTimes(2);
    expect(restarted.registry.snapshot().holders.map(holder => holder.holderID)).toEqual([plan.holderID]);
  });

  it.each(["absent", "malformed", "invalid", "unreadable", "no-loader"] as const)("a %s initial snapshot is not retried by a later adapter", async kind => {
    const [a, b] = await copies();
    const opts = options();
    const load = vi.fn(() => {
      if (kind === "absent") throw Object.assign(new Error("absent"), { code: "ENOENT" });
      if (kind === "malformed") return JSON.parse("{") as unknown;
      if (kind === "unreadable") throw new Error("unreadable");
      return { version: -1 };
    });
    const one = acquire(a, { ...opts, ...(kind === "no-loader" ? {} : { loadSnapshot: load }) });
    expect(one.registry.acquireWrite(live, "live.ts").ok).toBe(true);
    const later = vi.fn(() => empty);
    const two = acquire(b, { ...opts, loadSnapshot: later });
    expect(two.registry).toBe(one.registry);
    expect(later).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(kind === "no-loader" ? 0 : 1);
    expect(two.registry.snapshot().leases.map(lease => lease.holderID)).toEqual([live.holderID]);
    expect(opts.logger.warn).toHaveBeenCalledTimes(kind === "absent" || kind === "no-loader" ? 0 : 1);
  });

  it("does not expose partially initialized state to a reentrant loader or leak a reference when refusing it", async () => {
    const [a, b] = await copies();
    const opts = options();
    const snapshot = previousSnapshot();
    const handle = acquire(a, { ...opts, loadSnapshot: () => {
      expect(b.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
      expect(() => b.acquireLeaseRegistry(opts)).toThrow("initialization is already in progress");
      return snapshot;
    } });
    expect(opts.logger.warn).not.toHaveBeenCalled(); // Loader assertions must not have been swallowed as a restore failure.
    expect(handle.registry.snapshot().leases).toHaveLength(1);
    await handle.release();
    expect(b.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
  });

  it.each([null, 17, {}, { version: 2, registries: new Map() }, { version: 1, registries: {} }])("replaces foreign global state: %j", async foreign => {
    const [a, b] = await copies();
    const key = Symbol.for("opencode-model-router.leases@1");
    const saved: unknown = Reflect.get(globalThis, key);
    Reflect.set(globalThis, key, foreign);
    try {
      const opts = options();
      expect(b.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
      expect(Reflect.get(globalThis, key)).toBe(foreign); // A probe does not even initialize or replace the process container.
      const one = acquire(a, opts), two = acquire(b, opts);
      expect(one.registry).toBe(two.registry);
      expect(Reflect.get(globalThis, key)).toMatchObject({ version: 1, registries: expect.any(Map) });
      await one.release();
      await two.release();
      expect(a.peekLeaseRegistry(opts.snapshotPath)).toBeUndefined();
    } finally {
      if (saved === undefined) Reflect.deleteProperty(globalThis, key);
      else Reflect.set(globalThis, key, saved);
    }
  });
});
