/**
 * test/integration/v2-leases.test.ts
 *
 * Phase 2.1 (task 2.1.8): file leases over the real plugin behind the real v2 adapter (`routing.leases.mode: "enforce"`), driven
 * through a fake host (test/helpers/v2-bg-host.ts). A child session takes a lease on the files it edits until its execution ends;
 * the orchestrator (a root session) takes none.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLeaseRegistry, createLeaseGuard } from "../../src/compat/background";
import { createLeaseRegistry } from "../../src/router/leases";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

let host: BgHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  restoreEnv();
});

const ROOT = "orch";
const A = "child-a";
const B = "child-b";

async function boot(run: "annotate" | "refuse" = "annotate", extra: Record<string, unknown> = {}): Promise<BgHost> {
  host = await bootBgHost({
    overrides: { routing: { leases: { mode: "enforce", run }, background: { mode: "auto" } }, ...extra },
    sessions: { [ROOT]: {}, [A]: { parentID: ROOT, agent: "general" }, [B]: { parentID: ROOT, agent: "general" } },
  });
  return host;
}

let seq = 0;
function tool(sessionID: string, name: string, input: unknown, extra: Partial<ToolEvent> = {}): ToolEvent {
  seq += 1;
  return { sessionID, agent: sessionID === ROOT ? "build" : "general", messageID: `m${seq}`, id: `call-${seq}`, tool: name, input, ...extra };
}

function file(h: BgHost, name: string): string {
  const path = join(h.project, name);
  mkdirSync(h.project, { recursive: true });
  writeFileSync(path, "x\n");
  return path;
}

const edit = (sessionID: string, path: string) => tool(sessionID, "edit", { filePath: path, path, oldString: "x", newString: "y" });
const read = (sessionID: string, path: string) => tool(sessionID, "read", { filePath: path, path });

function end(h: BgHost, sessionID: string, kind: "succeeded" | "failed" | "interrupted"): Promise<void> {
  h.emit({ type: `session.execution.${kind}`, id: `ev-${seq++}`, created: 1, data: { sessionID } });
  return h.drain();
}

describe("leases: writers", () => {
  it("two implementers writing one file: the second is refused and the refusal names the holder", async () => {
    const h = await boot();
    const f = file(h, "shared.ts");
    await h.before(edit(A, f));
    await expect(h.before(edit(B, f))).rejects.toThrow(/Refused: .*shared\.ts is being edited by session child-a/);
    await expect(h.before(edit(B, f))).rejects.toThrow(/NEED MORE: lease/);
    await expect(h.before(edit(B, f))).rejects.toThrow(/Do not retry: the lease ends when that session ends/);
  });

  it("the holder itself may edit its file again", async () => {
    const h = await boot();
    const f = file(h, "own.ts");
    await h.before(edit(A, f));
    await expect(h.before(edit(A, f))).resolves.toBeDefined();
  });

  it("different files do not conflict", async () => {
    const h = await boot();
    await h.before(edit(A, file(h, "a.ts")));
    await expect(h.before(edit(B, file(h, "b.ts")))).resolves.toBeDefined();
  });
});

describe("leases: readers and runs", () => {
  it("a reader in the same tree is refused while the file is under edit", async () => {
    const h = await boot();
    const f = file(h, "busy.ts");
    await h.before(edit(A, f));
    await expect(h.before(read(B, f))).rejects.toThrow(/Refused: .*busy\.ts is under edit by session child-a/);
  });

  it("a read of a file nobody edits is allowed", async () => {
    const h = await boot();
    await h.before(edit(A, file(h, "one.ts")));
    await expect(h.before(read(B, file(h, "two.ts")))).resolves.toBeDefined();
  });

  it("a router_run in the tree is annotated with the contamination note under run: annotate", async () => {
    const h = await boot("annotate");
    await h.before(edit(A, file(h, "w.ts")));
    const run = tool(B, "router_run", { script: "test", cwd: h.project });
    await h.before(run);
    const after = await h.after({ ...run, status: "completed", result: { content: [{ type: "text", text: "ok" }] } });
    const text = JSON.stringify(after.result);
    expect(text).toContain("[router] ran while ");
    expect(text).toContain("edits 1 file(s); result may be contaminated");
  });

  it("a router_run in the tree is refused under run: refuse, naming the holder", async () => {
    const h = await boot("refuse");
    await h.before(edit(A, file(h, "w.ts")));
    await expect(h.before(tool(B, "router_run", { script: "test", cwd: h.project }))).rejects.toThrow(
      /Refused: router_run in .* while session child-a edits 1 file\(s\) there/,
    );
  });

  it("a router_run with no one editing is untouched", async () => {
    const h = await boot("refuse");
    const run = tool(B, "router_run", { script: "test", cwd: h.project });
    await h.before(run);
    const after = await h.after({ ...run, status: "completed", result: { content: [{ type: "text", text: "ok" }] } });
    expect(JSON.stringify(after.result)).not.toContain("contaminated");
  });
});

describe("leases: trees", () => {
  it("in another worktree both are allowed", async () => {
    const h = await boot();
    const other = join(h.home, "worktree-2");
    mkdirSync(other, { recursive: true });
    h.sessions.set(B, { parentID: ROOT, agent: "general", directory: other });
    const fa = file(h, "same-name.ts");
    const fb = join(other, "same-name.ts");
    writeFileSync(fb, "x\n");
    await h.before(edit(A, fa));
    await expect(h.before(edit(B, fb))).resolves.toBeDefined();
    await expect(h.before(read(B, fb))).resolves.toBeDefined();
  });
});

describe("leases: the orchestrator", () => {
  it("a root session's edits take no lease and never block a child", async () => {
    const h = await boot();
    const f = file(h, "root-edit.ts");
    await h.before(edit(ROOT, f));
    await expect(h.before(edit(A, f))).resolves.toBeDefined();
    await expect(h.before(read(B, f))).rejects.toThrow(/under edit by session child-a/);
  });

  it("a root session's reads are never refused", async () => {
    const h = await boot();
    const f = file(h, "root-read.ts");
    await h.before(edit(A, f));
    await expect(h.before(read(ROOT, f))).resolves.toBeDefined();
  });

  it("a root write of a file a child holds is refused with the wait message", async () => {
    const h = await boot();
    const f = file(h, "held-by-child.ts");
    await h.before(edit(A, f));
    await expect(h.before(edit(ROOT, f))).rejects.toThrow(/Refused: .*held-by-child\.ts is being edited by .*Wait for that session to end/);
  });
});

describe("leases: search results", () => {
  async function grepAfter(h: BgHost, warmUp: boolean) {
    const leased = file(h, "leased.ts");
    const free = file(h, "free.ts");
    await h.before(edit(A, leased));
    if (warmUp) await h.before(read(B, free)); // the guard resolves the child's actor on its first file / run tool call
    const grep = tool(B, "grep", { pattern: "needle" });
    await h.before(grep);
    const after = await h.after({
      ...grep,
      status: "completed",
      result: {
        content: [{ type: "text", text: `${leased}:3:needle\n${free}:5:needle` }],
        output: [{ entry: { path: leased }, line: 3 }, { entry: { path: free }, line: 5 }],
      },
    });
    return { leased, free, text: JSON.stringify(after.result) };
  }

  // D1: afterSearch resolves the child's actor itself, so a grep that is the child's first tool call is filtered too.
  it("D1: a grep result is filtered even when it is the child's first tool call", async () => {
    const h = await boot();
    const { leased, text } = await grepAfter(h, false);
    expect(text).not.toContain(leased.replace(/\\/g, "\\\\"));
  });

  it("a grep result is filtered of files under edit by another holder, with a count", async () => {
    const h = await boot();
    const leased = file(h, "leased.ts");
    const free = file(h, "free.ts");
    await h.before(edit(A, leased));
    await h.before(read(B, free)); // the guard resolves the child's actor on its first file / run tool call
    const grep = tool(B, "grep", { pattern: "needle" });
    await h.before(grep);
    const after = await h.after({
      ...grep,
      status: "completed",
      result: {
        content: [{ type: "text", text: `${leased}:3:needle\n${free}:5:needle` }],
        output: [{ entry: { path: leased }, line: 3 }, { entry: { path: free }, line: 5 }],
      },
    });
    const result = after.result as { content: Array<{ text: string }>; output: Array<{ entry: { path: string } }> };
    const joined = result.content.map((p) => p.text).join("\n");
    expect(joined).toContain(free);
    expect(joined).not.toContain(leased);
    expect(joined).toContain("[router] 1 result(s) omitted: under edit by session child-a.");
    expect(result.output.map((m) => m.entry.path)).toEqual([free]);
  });

  it("a grep with no leased hit is left as the host sent it", async () => {
    const h = await boot();
    const free = file(h, "free.ts");
    const grep = tool(B, "grep", { pattern: "needle" });
    await h.before(grep);
    const original = { content: [{ type: "text", text: `${free}:5:needle` }], output: [{ entry: { path: free }, line: 5 }] };
    const after = await h.after({ ...grep, status: "completed", result: original });
    expect(JSON.stringify(after.result)).not.toContain("omitted");
  });
});

describe("leases: release", () => {
  for (const kind of ["succeeded", "interrupted", "failed"] as const) {
    it(`the lease ends when the holder's execution ${kind}`, async () => {
      const h = await boot();
      const f = file(h, `rel-${kind}.ts`);
      await h.before(edit(A, f));
      await expect(h.before(edit(B, f))).rejects.toThrow(/being edited by/);
      await end(h, A, kind);
      await expect(h.before(edit(B, f))).resolves.toBeDefined();
    });
  }

  it("a release of one holder leaves the other holder's lease in place", async () => {
    const h = await boot();
    const fa = file(h, "fa.ts");
    const fb = file(h, "fb.ts");
    const c = "child-c";
    h.sessions.set(c, { parentID: ROOT, agent: "general" });
    await h.before(edit(A, fa));
    await h.before(edit(B, fb));
    await end(h, A, "succeeded");
    await expect(h.before(edit(c, fa))).resolves.toBeDefined();
    await expect(h.before(edit(c, fb))).rejects.toThrow(/being edited by session child-b/);
  });
});

describe("leases: unknown targets", () => {
  // D6 (memo 14.1/17): `toolTargets` reports `gitRootRequired` for a router_git_* call when no git root is known, and the
  // guard refuses it as an unknown target while another child edits files. Here the session directory is not inside a
  // git repository (gitRootOf -> undefined) and child A holds a write lease.
  it("D6: a router_git_* call without a git root names no file the router can check, while another child edits", async () => {
    const h = await boot();
    await h.before(edit(A, file(h, "g.ts")));
    await expect(h.before(tool(B, "router_git_diff", {}))).rejects.toThrow(/names no file the router can check, and session child-a is editing files/);
    await expect(h.before(tool(B, "router_git_diff", {}))).rejects.toThrow(/NEED MORE: lease/);
  });

  it("the same call with nobody editing is allowed", async () => {
    const h = await boot();
    await expect(h.before(tool(B, "router_git_diff", {}))).resolves.toBeDefined();
  });
});

describe("acquireLeaseRegistry: the process-wide registry (ref-counted)", () => {
  const seams = { realpath: (path: string) => path, repoKeyOf: () => undefined, now: () => 1 };
  const logger = { warn: vi.fn() };

  it("two holders of one snapshot path share a registry; the last release discards it", async () => {
    const one = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-a", logger });
    const two = acquireLeaseRegistry({ runMode: "refuse", seams, snapshotPath: "snap-a", logger });
    expect(two.registry).toBe(one.registry); // the first acquirer's registry (and run mode) win
    await one.release();
    await one.release(); // idempotent
    const still = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-a", logger });
    expect(still.registry).toBe(two.registry);
    await two.release();
    await still.release();
    const fresh = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-a", logger });
    expect(fresh.registry).not.toBe(two.registry);
    await fresh.release();
  });

  it("different snapshot paths do not share", async () => {
    const a = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-b", logger });
    const b = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-c", logger });
    expect(a.registry).not.toBe(b.registry);
    await a.release();
    await b.release();
  });

  it("notifyReleased calls every subscriber, survives one that throws, and honours the unsubscribe", async () => {
    const warn = vi.fn();
    const handle = acquireLeaseRegistry({ runMode: "annotate", seams, snapshotPath: "snap-d", logger: { warn } });
    const calls: string[] = [];
    handle.onRelease(() => {
      throw new Error("listener broke");
    });
    const off = handle.onRelease(() => calls.push("second"));
    handle.notifyReleased();
    expect(calls).toEqual(["second"]);
    expect(warn).toHaveBeenCalledWith("[router] lease release listener failed", { error: "listener broke" });
    off();
    handle.notifyReleased();
    expect(calls).toEqual(["second"]);
    await handle.release();
  });
});

describe("leases: a host lookup that never answers (memo 14.1)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a session kind lookup that hangs is bounded: the call proceeds with root semantics and the lookup is warned once", async () => {
    vi.useFakeTimers();
    const dir = join(tmpdir(), "omr-lease-hang");
    const registry = createLeaseRegistry({ realpath: (path) => path, repoKeyOf: () => undefined, now: () => 1 }, { runMode: "annotate" });
    const warn = vi.fn();
    const guard = createLeaseGuard({
      registry, sessionKind: () => new Promise<"root" | "child">(() => undefined), sessionDir: async () => dir, gitRootOf: () => undefined,
      holderLabel: (id) => `session ${id}`, planTaskOf: () => undefined, events: { onRelease: () => () => undefined }, logger: { warn },
    });
    const pending = guard.before({ sessionID: "ses_hang", tool: "edit", args: { filePath: join(dir, "a.txt") }, callID: "call-1" });
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).resolves.toEqual({});
    expect(warn).toHaveBeenCalledWith("[router] lease session kind lookup failed; treating as root", expect.objectContaining({ error: expect.stringContaining("timed out") }));
  });

  it("a session directory lookup that hangs is bounded: no lease check, the call is not refused", async () => {
    vi.useFakeTimers();
    const registry = createLeaseRegistry({ realpath: (path) => path, repoKeyOf: () => undefined, now: () => 1 }, { runMode: "annotate" });
    const guard = createLeaseGuard({
      registry, sessionKind: async () => "child", sessionDir: () => new Promise<string>(() => undefined), gitRootOf: () => undefined,
      holderLabel: (id) => `session ${id}`, planTaskOf: () => undefined, events: { onRelease: () => () => undefined },
    });
    const pending = guard.before({ sessionID: "ses_hang2", tool: "edit", args: { filePath: "a.txt" }, callID: "call-2" });
    await vi.advanceTimersByTimeAsync(5_100);
    await expect(pending).resolves.toEqual({});
  });
});

describe("leases: verification deferral (waitTreeFree, memo 14.4)", () => {
  const TREE = join(tmpdir(), "omr-lease-wait");

  function guardWithHolder() {
    const registry = createLeaseRegistry({ realpath: (path) => path, repoKeyOf: () => undefined, now: () => 1 }, { runMode: "annotate" });
    registry.acquireWrite({ holderID: "holder", tree: TREE, isChild: true, scope: "until-complete" }, join(TREE, "a.ts"));
    const listeners = new Set<() => void>();
    let clock = 0;
    const guard = createLeaseGuard({
      registry, sessionKind: async () => "child", sessionDir: async () => TREE, gitRootOf: () => undefined,
      holderLabel: (id) => `session ${id}`, planTaskOf: () => undefined,
      events: { onRelease: (cb) => { listeners.add(cb); return () => void listeners.delete(cb); } },
      now: () => clock,
    });
    return { guard, listeners, tick: (ms: number) => { clock += ms; } };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at once when nobody edits the tree", async () => {
    const { guard } = guardWithHolder();
    const result = await guard.waitTreeFree(join(tmpdir(), "omr-lease-other-tree"), { producer: "p" }, 10_000, new AbortController().signal);
    expect(result.holders).toEqual([]);
    expect(result.fileCount).toBe(0);
  });

  it("waits for a release, then runs with no remaining holders", async () => {
    vi.useFakeTimers();
    const { guard, listeners } = guardWithHolder();
    const waiting = guard.waitTreeFree(TREE, { producer: "verify-owner" }, 60_000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    guard.releaseChild("holder");
    for (const cb of [...listeners]) cb(); // the event loop's notifyReleased
    await vi.advanceTimersByTimeAsync(10);
    const result = await waiting;
    expect(result.holders).toEqual([]);
  });

  it("at the deadline it gives up and reports the holders that remain (the run then carries the caveat)", async () => {
    vi.useFakeTimers();
    const { guard, tick } = guardWithHolder();
    const waiting = guard.waitTreeFree(TREE, { producer: "verify-owner" }, 6_000, new AbortController().signal);
    tick(6_001);
    await vi.advanceTimersByTimeAsync(6_100);
    const result = await waiting;
    expect(result.holders).toEqual(["holder"]);
    expect(result.fileCount).toBe(1);
  });

  it("a zero deadline does not wait at all", async () => {
    const { guard } = guardWithHolder();
    const result = await guard.waitTreeFree(TREE, { producer: "verify-owner" }, 0, new AbortController().signal);
    expect(result.holders).toEqual(["holder"]);
    expect(result.waitedMs).toBe(0);
  });

  it("an aborted wait returns promptly and never throws", async () => {
    vi.useFakeTimers();
    const { guard } = guardWithHolder();
    const abort = new AbortController();
    const waiting = guard.waitTreeFree(TREE, { producer: "verify-owner" }, 600_000, abort.signal);
    await vi.advanceTimersByTimeAsync(10);
    abort.abort();
    await vi.advanceTimersByTimeAsync(10);
    await expect(waiting).resolves.toBeDefined();
  });
});

describe("leases: off", () => {
  it("with routing.leases.mode off nothing is checked", async () => {
    host = await bootBgHost({
      overrides: { routing: { leases: { mode: "off" } } },
      sessions: { [ROOT]: {}, [A]: { parentID: ROOT }, [B]: { parentID: ROOT } },
    });
    const f = file(host, "x.ts");
    await host.before(edit(A, f));
    await expect(host.before(edit(B, f))).resolves.toBeDefined();
  });
});
