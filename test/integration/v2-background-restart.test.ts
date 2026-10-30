/**
 * test/integration/v2-background-restart.test.ts
 *
 * Phase 2.1 QA round 2: what a restart hands the next process, through the real plugin behind the real v2 adapter (fake host of
 * test/helpers/v2-bg-host.ts; a previous process's pending.jsonl is written before boot, the adoption of the parent starts the
 * recovery, and `settled()` waits for it: no polling, no sleeps).
 *
 * - QA-2.1-17: a restored hold WITH its child text is never gated without its verification data: no restored entry (the change
 *   set died with the old process) ends UNVERIFIABLE "verification data lost in restart"; a verdict the gate reached before the
 *   restart (its `verified` state record) is posted as it was, never recomputed.
 * - QA-2.1-29: a restored hold whose `inflight` recovery is skipped is settled, not left held until the TTL.
 * - QA-2.1-34: an adoption refused by another live pid's claim is tried again at a later sighting (rate-limited), and a claim
 *   nobody re-stamps goes stale (a crashed owner whose pid was reused never blocks recovery).
 * - DF-1-10: a session a live sibling instance of this process owns (another booted location: another module copy, its fresh
 *   beat file in `pending.instances`) is never adopted nor settled `lost in restart`; a dead sibling (stale beat) still is.
 * - QA-SYNC1-13: a restored held role dispatch gets its journaled routed-role snapshot back (placements, never the tier refusal).
 * - QA-SYNC1-17: a branch switch seen on a restored head names the window up to the check after the restart.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADOPTION_RETRY_MS, ROUTER_FINISH_ATTACH, type FinishAttach } from "../../src/compat/background";
import { processToken } from "../../src/compat/v2-hooks";
import { currentBinding, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import { readRoleOrphans, resetRoleOrphansForTests } from "../../src/routing/roles/orphans";
import { ROLE_REFUSALS } from "../../src/routing/wire/dispatch";
import { AFTER_RESTART_WINDOW } from "../../src/verify/branch";
import { CLAIM_STALE_MS, HEAD_LOST_REASON, PENDING_INSTANCES_DIRNAME, PERIMETER_LOST_REASON, unattributedRisk } from "../../src/verify/pending";
import { bootBgHost, restoreEnv, type BgHost, type NativeSubagentStub, type SyntheticCall } from "../helpers/v2-bg-host";

let host: BgHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  restoreEnv();
  resetBindingRegistryForTests();
  resetRoleOrphansForTests();
});

const ORCH = "orch";
const CHILD = "child-1";
const EVENT_CHILD = "child-event";

async function boot(records: ReadonlyArray<Record<string, unknown>>, sessions: Record<string, { parentID?: string }> = {}): Promise<BgHost> {
  host = await bootBgHost({
    overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
    sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH }, [EVENT_CHILD]: { parentID: ORCH }, ...sessions },
    journalText: records.map((record) => `${JSON.stringify(record)}\n`).join(""),
  });
  return host;
}

/** The first sight of a child of ORCH adopts ORCH's journaled records (memo 11.3). */
function adoptOrchestrator(h: BgHost): void {
  h.emit({ type: "session.created", id: `ev-created-${EVENT_CHILD}`, created: 1, data: { sessionID: EVENT_CHILD, parentID: ORCH } });
}

function verdictPosts(h: BgHost): SyntheticCall[] {
  return h.synthetic.filter((s) => s.sessionID === ORCH && s.text.startsWith("<router-verdict "));
}

describe("restart recovery of held results (QA-2.1-17)", () => {
  it.each(["refuse", "allow"] as const)("recovers a lost role dispatch in %s mode, with matching wake and resume behaviour", async (resume) => {
    const callID = `call-orphan-restart-${resume}`;
    host = await bootBgHost({
      overrides: { routing: { delegation: "roles", orphans: { resume }, background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH, agent: "explorer" } },
      journalText: `${JSON.stringify({
        v: 1, kind: "inflight", key: `${CHILD}\u0000${callID}`, callID, parentSessionID: ORCH, childSessionID: CHILD,
        at: Date.now(), agent: "explorer", role: "explorer", description: "old work", verifying: false,
        verificationMode: "none", hold: null, process: "previous-process",
      })}\n`,
    });
    const h = host;
    h.childContext.set(CHILD, [{ role: "user", content: [{ type: "text", text: "find a symbol\nOMR_NONCE=orphan-restart-12345678" }] }]);
    // The parent's execute.before adopts its journaled records, even without an earlier context or event.
    await h.before({ sessionID: ORCH, agent: "build", messageID: "m", id: "recover-before-resume", tool: "todowrite", input: {} });
    await h.settled();
    const wakes = h.synthetic.filter((s) => s.metadata?.router !== undefined && s.text.includes("was lost in a restart"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text.includes("Dispatch a fresh task: resuming it is refused.")).toBe(resume === "refuse");
    expect(wakes[0]?.resume).toBe(true);
    expect(readRoleOrphans().counters.lost).toBe(1);
    const later = h.before({ sessionID: ORCH, agent: "build", messageID: "m", id: `later-stale-resume-${resume}`, tool: "subagent",
      input: { agent: "explorer", sessionID: CHILD, description: "continue", prompt: "continue" } });
    if (resume === "refuse") {
      await expect(later).rejects.toThrow(ROLE_REFUSALS.staleResume(CHILD));
      expect(currentBinding(CHILD, { maxOf: () => [] })?.cause).toBe("unregistered");
    } else {
      await expect(later).resolves.toBeDefined();
      expect(currentBinding(CHILD, { maxOf: () => [] })).toBeUndefined();
    }
    await h.settled();
    expect(h.synthetic.filter((s) => s.text.includes("was lost in a restart"))).toHaveLength(1);
  }, 30_000);

  it("keeps a same-process journaled role attempt live instead of refusing its Code Mode resume", async () => {
    const callID = "call-orphan-live";
    host = await bootBgHost({
      overrides: { routing: { delegation: "roles", background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH, agent: "explorer" } },
      journalText: `${JSON.stringify({
        v: 1, kind: "inflight", key: `${CHILD}\u0000${callID}`, callID, parentSessionID: ORCH, childSessionID: CHILD,
        at: Date.now(), agent: "explorer", role: "explorer", description: "live work", verifying: false,
        verificationMode: "none", hold: null, process: processToken(),
      })}\n`,
    });
    const h = host;
    h.childContext.set(CHILD, [
      { role: "user", content: [{ type: "text", text: "find a symbol\nOMR_NONCE=orphan-live-12345678" }] },
      { role: "assistant", content: [{ type: "text", text: "half way" }], time: { created: 1 } },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    await expect(h.before({ sessionID: ORCH, agent: "build", messageID: "m", id: "live-role-resume", tool: "execute",
      input: { code: `await subagent({ task_id: "${CHILD}", prompt: "continue" })` } })).resolves.toBeDefined();
    expect(currentBinding(CHILD, { maxOf: () => [] })).toBeUndefined();
    expect(h.synthetic.filter((s) => s.text.includes("was lost in a restart"))).toHaveLength(0);
    expect(readRoleOrphans().counters).toEqual({ refused: 0, lost: 0 });
  }, 30_000);

  it("a restored hold with its child text but no restored entry ends UNVERIFIABLE: verification data lost in restart", async () => {
    const handle = `vrf_${"a".repeat(24)}`;
    const h = await boot([
      {
        v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-r1", label: 'fast "write a"',
        dispatch: { prompt: "write src/a.ts", description: "write a", subagentType: "fast" }, at: Date.now(),
      },
      { v: 1, kind: "hold-text", handle, text: "I wrote src/a.ts", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain(handle);
    expect(posts[0]?.text).toContain("I wrote src/a.ts");
    expect(posts[0]?.text).toContain("verification data lost in restart");
    // Never gated on an empty change set (the pre-fix "read-only delegation" for a writing child).
    expect(posts[0]?.text).not.toContain("read-only");
    expect(posts[0]?.text).not.toContain("PASS");
  });

  it("a verdict the gate reached before the restart is posted as it was (with the child text), never recomputed", async () => {
    const handle = `vrf_${"b".repeat(24)}`;
    const h = await boot([
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-r2", label: 'fast "write b"', dispatch: { prompt: "write src/b.ts" }, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "I wrote src/b.ts", status: "succeeded", at: Date.now() },
      {
        v: 1, kind: "state", handle, state: "verified", at: Date.now(),
        verdict: { pass: false, outcome: "fail", method: "deterministic", reasons: ["2 tests failed"], caveats: [] },
      },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("I wrote src/b.ts");
    expect(posts[0]?.text).toContain("[router] FAIL — 2 tests failed");
    expect(posts[0]?.text).not.toContain("verification data lost in restart");
  });

  it("a failed child's journaled text (status failed) is never gated after a restart: lost in restart", async () => {
    const handle = `vrf_${"d".repeat(24)}`;
    const h = await boot([
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-r3", at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "partial output of a failed child", status: "failed", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("lost in restart");
    expect(posts[0]?.text).not.toContain("partial output of a failed child");
  });
});

describe("QA-SYNC1-3: a restored held entry is never re-gated with fewer checks than before the restart", () => {
  /** A held pending entry as the previous process journaled it (no change, a testsPass-only DoD from the hold's prompt). */
  const heldEntry = (handle: string, callID: string, over: Record<string, unknown>): Record<string, unknown> => ({
    v: 1, kind: "entry", handle, parent: ORCH, child: CHILD, callID, producer: CHILD, tier: "fast",
    changedFiles: [], changedFilesDropped: 0, reference: null, risk: unattributedRisk(), description: "write c",
    root: null, cwd: process.cwd(), state: "held", createdAt: Date.now(), dispatchedAt: Date.now(), ...over,
  });
  const prompt = "write src/c.ts\n[acceptance]\ncheck: testsPass\n[/acceptance]";

  it("a restored held entry without dispatch posts UNVERIFIABLE promptly, not at the pending TTL", async () => {
    const handle = `vrf_${"7".repeat(24)}`;
    const callID = "call-missing-restored-dispatch";
    const h = await boot([
      heldEntry(handle, callID, { changedFiles: "unavailable" }),
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "DONE: wrote src/c.ts", status: "succeeded", at: Date.now() },
    ]);
    await h.settled(); // restore the pending entry, without adopting the adapter's hold yet
    const attach: unknown = Reflect.get(h.hooks, ROUTER_FINISH_ATTACH);
    if (typeof attach !== "function") throw new Error("no finish API");
    const posts: Array<{ verdict: string; text: string }> = [];
    const api = (attach as FinishAttach)({ host: "v2", held: { verdict: async (_handle, verdict) => { posts.push(verdict); } } });
    if (api === undefined) throw new Error("finish API not attached");
    // Exercise the recovery boundary when the optional dispatch is absent (restored: undefined), not `{}`.
    await api.finish({ callID, parentSessionID: ORCH, childSessionID: CHILD, outputText: "DONE: wrote src/c.ts",
      status: "succeeded", mode: "background", heldHandle: handle, endedAt: Date.now() });
    await api.idle(); // no clock advance or TTL sweep
    expect(posts).toHaveLength(1);
    expect(posts[0]?.verdict).toBe("UNVERIFIABLE");
    expect(posts[0]?.text).toContain("UNVERIFIABLE");
    expect(posts[0]?.text).toContain("DONE: wrote src/c.ts");
    expect(posts[0]?.text).not.toContain("read-only delegation");
    expect(posts[0]?.text).not.toContain("PASS");
    const verify = h.hooks.tool?.router_verify;
    if (verify === undefined) throw new Error("no router_verify tool");
    const context = { sessionID: ORCH, messageID: "m-missing-dispatch", agent: "build", abort: new AbortController().signal };
    const report = await verify.execute({ handles: [handle] }, context as unknown as Parameters<typeof verify.execute>[1]);
    expect(report).toContain("cached verdict; nothing was run");
    expect(report).not.toContain("held background result");
  });

  for (const [flag, reason] of [["hadPerimeter", PERIMETER_LOST_REASON], ["hadHead", HEAD_LOST_REASON]] as const) {
    it(`an entry journaled with ${flag} posts UNVERIFIABLE "${reason.slice(0, 40)}…", never PASS`, async () => {
      // Handles are hex (HANDLE_PATTERN): a non-hex handle drops the entry record, and the finish then reads "data lost".
      const handle = `vrf_${(flag === "hadHead" ? "c" : "f").repeat(24)}`;
      const callID = `call-sync1-${flag}`;
      const h = await boot([
        heldEntry(handle, callID, { [flag]: true }),
        { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, label: 'fast "write c"', dispatch: { prompt, description: "write c", subagentType: "fast" }, at: Date.now() },
        { v: 1, kind: "hold-text", handle, text: "I wrote src/c.ts", status: "succeeded", at: Date.now() },
      ]);
      adoptOrchestrator(h);
      await h.settled();
      const posts = verdictPosts(h);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.text).toContain("I wrote src/c.ts");
      expect(posts[0]?.text).toContain(`[router] UNVERIFIABLE — ${reason}`);
      expect(posts[0]?.text).not.toContain("verification data lost in restart");
      expect(posts[0]?.text).not.toContain("PASS");
    });
  }

  it("QA-SYNC1-2: a restored held task is gated in its journaled workRoot: a cwd outside it is refused, naming that root", async () => {
    const handle = `vrf_${"8".repeat(24)}`;
    const callID = "call-sync1-workRoot";
    const workRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-sync1-w-")));
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-sync1-o-")));
    const h = await boot([
      heldEntry(handle, callID, { cwd: outside }),
      {
        v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, label: 'fast "write w"',
        dispatch: { prompt, description: "write w", subagentType: "fast", cwd: outside, workRoot }, at: Date.now(),
      },
      { v: 1, kind: "hold-text", handle, text: "I wrote src/w.ts", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    // Without the journaled work root the check would run in `outside`; with it, the gate refuses that cwd and names the root.
    expect(posts[0]?.text).toContain(basename(workRoot));
    expect(posts[0]?.text).not.toContain("verification data lost in restart");
    expect(posts[0]?.text).not.toContain("PASS");
  }, 60_000);

  it("an entry journaled with its dispatch-time head is re-gated with the branch check: a head on another branch is refused", async () => {
    const handle = `vrf_${"9".repeat(24)}`;
    const callID = "call-sync1-dispatchHead";
    // The tree the gate reads now is this checkout (the entry's cwd); the journaled head names another branch at another commit.
    const dispatchHead = { root: realpathSync.native(process.cwd()), head: "0".repeat(40), branch: "qa-sync1-not-this-branch" };
    const h = await boot([
      heldEntry(handle, callID, { hadHead: true, dispatchHead }),
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, label: 'fast "write c"', dispatch: { prompt, description: "write c", subagentType: "fast" }, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "I wrote src/c.ts", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("I wrote src/c.ts");
    // The branch check ran on the restored head (its reason), instead of being skipped or replaced by "lost in restart".
    // QA-SYNC1-17: the window runs from the dispatch to the gate after the restart, and the reason says so.
    expect(posts[0]?.text).toContain(AFTER_RESTART_WINDOW);
    // A restored held entry settles in place: never re-deferred (a new unattributed handle) by the restarted process.
    expect(posts[0]?.text).not.toContain("deferred to router_verify");
    expect(posts[0]?.text).not.toContain(HEAD_LOST_REASON);
    expect(posts[0]?.text).not.toContain("verification data lost in restart");
    expect(posts[0]?.text).not.toContain("PASS");
  }, 60_000);

  it("QA-SYNC1-13: a restored held role dispatch with a per-check cwd= inside its root is placed there, never refused as a tier dispatch", async () => {
    const handle = `vrf_${"7".repeat(24)}`;
    const callID = "call-sync1-routed";
    const workRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-sync1-r-")));
    execFileSync("git", ["init", "-q"], { cwd: workRoot }); // a work tree the gate can prepare its verification in
    // The checked file exists only under the work root's `sub`: the check passes only when placed there.
    mkdirSync(join(workRoot, "sub"), { recursive: true });
    writeFileSync(join(workRoot, "sub", "inner.ts"), "export {};\n", "utf-8");
    const rolePrompt = "write sub/inner.ts\n[acceptance]\ncheck: fileExists path=inner.ts cwd=sub\n[/acceptance]";
    const h = await boot([
      heldEntry(handle, callID, { cwd: workRoot, description: "write r" }),
      {
        v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, label: 'fast "write r"',
        dispatch: {
          prompt: rolePrompt, description: "write r", subagentType: "fast", cwd: workRoot, workRoot,
          // The routed-role snapshot the dispatch journaled (the live record died with the old process).
          routed: { verifyRoot: workRoot, parentSessionID: ORCH, resumeID: null },
        },
        at: Date.now(),
      },
      { v: 1, kind: "hold-text", handle, text: "I wrote sub/inner.ts", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("I wrote sub/inner.ts");
    // Without the snapshot the restored gate reads a tier dispatch and refuses the per-check cwd= (OD1=B).
    expect(posts[0]?.text).not.toContain("honoured only in roles mode");
    expect(posts[0]?.text).not.toContain("is outside the work root");
    expect(posts[0]?.text).not.toContain("verification data lost in restart");
    // Placed in the role's root: `sub/inner.ts` exists there, so the check passes.
    expect(posts[0]?.text).toContain("PASS");
    expect(posts[0]?.text).not.toContain("UNVERIFIABLE");
  }, 60_000);

  it("QA-SYNC1-13 control: a malformed routed-role snapshot is dropped; the restored gate refuses the per-check cwd= as before", async () => {
    const handle = `vrf_${"6".repeat(24)}`;
    const callID = "call-sync1-routed-malformed";
    const workRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-sync1-m-")));
    execFileSync("git", ["init", "-q"], { cwd: workRoot });
    mkdirSync(join(workRoot, "sub"), { recursive: true });
    writeFileSync(join(workRoot, "sub", "inner.ts"), "export {};\n", "utf-8");
    const rolePrompt = "write sub/inner.ts\n[acceptance]\ncheck: fileExists path=inner.ts cwd=sub\n[/acceptance]";
    const h = await boot([
      heldEntry(handle, callID, { cwd: workRoot, description: "write m" }),
      {
        v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID, label: 'fast "write m"',
        dispatch: {
          prompt: rolePrompt, description: "write m", subagentType: "fast", cwd: workRoot, workRoot,
          // `carried` without a resumed child is malformed (and so is an unknown key): the snapshot is dropped.
          routed: { verifyRoot: workRoot, parentSessionID: ORCH, resumeID: null, carried: true },
        },
        at: Date.now(),
      },
      { v: 1, kind: "hold-text", handle, text: "I wrote sub/inner.ts", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain("honoured only in roles mode");
    expect(posts[0]?.text).not.toContain("PASS");
  }, 60_000);
});

describe("a refused adoption is tried again at a later sighting, rate-limited (QA-2.1-34)", () => {
  it("another live pid's fresh claim refuses it; once the claim is stale, a sighting ADOPTION_RETRY_MS later adopts and posts", async () => {
    const handle = `vrf_${"e".repeat(24)}`;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      const h = await boot([
        { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-q34", label: 'fast "write e"', dispatch: { prompt: "write src/e.ts" }, at: t0 },
        { v: 1, kind: "hold-text", handle, text: "I wrote src/e.ts", status: "succeeded", at: t0 },
      ], { "child-event-2": { parentID: ORCH }, "child-event-3": { parentID: ORCH } });
      // ORCH is claimed by another live process (its pid: the parent of this one), freshly re-stamped.
      const claim = join(dirname(h.journalPath), "pending.claims", ORCH);
      const writeClaim = (at: number): void => {
        mkdirSync(dirname(claim), { recursive: true });
        writeFileSync(claim, `${JSON.stringify({ pid: process.ppid, token: "other-process", at })}\n`);
      };
      writeClaim(t0);
      const sight = (child: string): void => {
        h.emit({ type: "session.created", id: `ev-created-${child}`, created: 1, data: { sessionID: child, parentID: ORCH } });
      };
      sight(EVENT_CHILD);
      await h.settled();
      expect(verdictPosts(h)).toEqual([]);
      // The owner crashed and its pid was reused: nobody re-stamps the claim. A sighting within ADOPTION_RETRY_MS of the
      // refusal does not try again (rate limit).
      writeClaim(t0 - CLAIM_STALE_MS - 1_000);
      vi.setSystemTime(t0 + ADOPTION_RETRY_MS - 1);
      sight("child-event-2");
      await h.settled();
      expect(verdictPosts(h)).toEqual([]);
      // The next sighting after ADOPTION_RETRY_MS adopts the very same records: the restored hold gets its verdict, once.
      vi.setSystemTime(t0 + ADOPTION_RETRY_MS + 1);
      sight("child-event-3");
      await h.settled();
      const posts = verdictPosts(h);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.text).toContain(handle);
      expect(posts[0]?.text).toContain("I wrote src/e.ts");
      expect(JSON.parse(readFileSync(claim, "utf8"))).toMatchObject({ pid: process.pid });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DF-1-10: a sibling plugin instance of this process (another booted location, another module copy) owns the session", () => {
  const RUNNING = (handle: string, at: number): Array<Record<string, unknown>> => [
    {
      v: 1, kind: "inflight", key: `${CHILD}\u0000call-df110`, callID: "call-df110", parentSessionID: ORCH, childSessionID: CHILD,
      label: 'medium "implement"', agent: "medium", description: "implement", verifying: true, verificationMode: "required", handle, hold: handle, at,
    },
    { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-df110", label: 'medium "implement"', dispatch: { prompt: "implement it" }, at },
  ];
  /** The owner's live background dispatch of ORCH: acknowledged as running, so its `inflight` and `hold` records are journaled. */
  const startRunningDispatch = async (h: BgHost): Promise<void> => {
    h.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await h.drain();
    const call = await h.before({
      sessionID: ORCH, agent: "build", messageID: "m-df110", id: "call-df110-live", tool: "subagent",
      input: { agent: "fast", description: "background work", prompt: "do the work", background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await h.after({ ...call, status: "completed", result: running });
    await h.settled();
  };
  /** The owner's child ends (failed: its verdict is UNVERIFIABLE without running a gate) and the owner posts that verdict. */
  const completeRunningDispatch = async (h: BgHost): Promise<void> => {
    h.childContext.set(CHILD, [{ role: "assistant", content: [{ type: "text", text: "partial work" }], finish: "stop", time: { created: 1, completed: 2 } }]);
    h.emit({ type: "session.execution.failed", id: `ev-end-${CHILD}-failed`, created: 2, data: { sessionID: CHILD } });
    await h.drain();
    // The processor journals (file I/O) before it posts, which microtask turns alone do not cover.
    await vi.waitFor(() => expect(verdictPosts(h)).toHaveLength(1));
    await h.settled();
  };
  /** The sibling instance's claim of ORCH (this pid, a token this module copy never issued) and its beat file. */
  const writeSibling = (h: BgHost, claimAt: number, beatAt: number | undefined): void => {
    const stateDir = dirname(h.journalPath);
    mkdirSync(join(stateDir, "pending.claims"), { recursive: true });
    writeFileSync(join(stateDir, "pending.claims", ORCH), `${JSON.stringify({ pid: process.pid, token: "sibling-instance", at: claimAt })}\n`);
    if (beatAt === undefined) return;
    mkdirSync(join(stateDir, PENDING_INSTANCES_DIRNAME), { recursive: true });
    writeFileSync(join(stateDir, PENDING_INSTANCES_DIRNAME, "sibling-instance"), `${JSON.stringify({ pid: process.pid, token: "sibling-instance", at: beatAt })}\n`);
  };

  it("DF-1-10 a live sibling's running hold is never settled `lost in restart`: the adoption is refused and the records stay dormant", async () => {
    const handle = `vrf_${"f".repeat(24)}`;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      const h = await boot(RUNNING(handle, t0), { "child-event-2": { parentID: ORCH } });
      writeSibling(h, t0, t0);
      adoptOrchestrator(h);
      await h.settled();
      expect(verdictPosts(h)).toEqual([]);
      expect(h.synthetic.some((s) => s.text.includes("lost in restart"))).toBe(false);
      // The sibling keeps beating: a later sighting is refused again, nothing is posted, the claim stays the sibling's.
      vi.setSystemTime(t0 + ADOPTION_RETRY_MS + 1);
      writeSibling(h, t0 + ADOPTION_RETRY_MS, t0 + ADOPTION_RETRY_MS);
      h.emit({ type: "session.created", id: "ev-created-child-event-2", created: 1, data: { sessionID: "child-event-2", parentID: ORCH } });
      await h.settled();
      expect(verdictPosts(h)).toEqual([]);
      expect(JSON.parse(readFileSync(join(dirname(h.journalPath), "pending.claims", ORCH), "utf8"))).toMatchObject({ token: "sibling-instance" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("DF-1-10 two real instances over one journal (second from another module copy): the second never settles the owner's running dispatch; the owner delivers exactly one verdict", async () => {
    const owner = await bootBgHost({
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH }, [EVENT_CHILD]: { parentID: ORCH } },
    });
    host = owner;
    await startRunningDispatch(owner);
    // The host boots another location: a second instance, from a separately loaded copy of the plugin modules, on the same
    // per-user journal (same home), reloads it and sights ORCH.
    vi.resetModules();
    const copy = await import("../helpers/v2-bg-host");
    const second = await copy.bootBgHost({
      home: owner.home,
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {}, [CHILD]: { parentID: ORCH }, [EVENT_CHILD]: { parentID: ORCH } },
    });
    try {
      adoptOrchestrator(second);
      await second.settled();
      expect(second.synthetic).toEqual([]);
      expect(owner.synthetic.some((s) => s.text.includes("lost in restart"))).toBe(false);
      // The owner's child completes: its verdict is delivered once, by the owner, under its handle.
      await completeRunningDispatch(owner);
      await owner.settled();
      await second.settled();
      const posts = verdictPosts(owner);
      expect(posts).toHaveLength(1);
      expect(posts[0]?.text).not.toContain("lost in restart");
      expect(second.synthetic).toEqual([]);
    } finally {
      // The shared home goes with the first dispose; the owner (`host`) disposes after it.
      await second.dispose();
    }
  });

  it("DF-1-10 a dead sibling (stale beat) still yields `lost in restart` for its hold, once", async () => {
    const handle = `vrf_${"0".repeat(24)}`;
    const t0 = Date.now();
    const h = await boot([{ v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-df110-dead", at: t0 }]);
    writeSibling(h, t0, t0 - CLAIM_STALE_MS - 1_000);
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain(handle);
    expect(posts[0]?.text).toContain("lost in restart");
    expect(JSON.parse(readFileSync(join(dirname(h.journalPath), "pending.claims", ORCH), "utf8"))).toMatchObject({ pid: process.pid });
  });
});

describe("DF-1.1-1: the caller (orchestrator) agent survives the journal, so a completion's grader launches as it", () => {
  const journalRecords = (h: BgHost): Array<Record<string, unknown>> =>
    readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);

  it("a background dispatch journals the CALLER agent next to the dispatched one, never in its place", async () => {
    const h = await boot([]);
    h.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await h.drain();
    const call = await h.before({
      sessionID: ORCH, agent: "build", messageID: "m-df111", id: "call-df111-live", tool: "subagent",
      input: { agent: "fast", description: "background work", prompt: "do the work", background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await h.after({ ...call, status: "completed", result: running });
    await h.settled();
    const inflight = journalRecords(h).filter((r) => r.kind === "inflight" && r.callID === "call-df111-live");
    expect(inflight.length).toBeGreaterThan(0);
    for (const record of inflight) {
      expect(record.callerAgent).toBe("build");
      expect(record.agent).toBe("fast");
    }
    // QA-PDF12-2: the dispatch is held (verification required), and its hold journals the caller next to the dispatched agent.
    const holds = journalRecords(h).filter((r) => r.kind === "hold" && r.callID === "call-df111-live");
    expect(holds.length).toBeGreaterThan(0);
    for (const record of holds) expect(record.callerAgent).toBe("build");
  });

  it("an old journal entry without the field (inflight and hold) still loads and settles once", async () => {
    const handle = `vrf_${"c".repeat(24)}`;
    const h = await boot([
      {
        v: 1, kind: "inflight", key: `${CHILD}\u0000call-df111-old`, callID: "call-df111-old", parentSessionID: ORCH, childSessionID: CHILD,
        label: 'fast "old"', agent: "fast", description: "old", verifying: true, verificationMode: "required", handle, hold: handle, at: Date.now(),
      },
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-df111-old", label: 'fast "old"', dispatch: { prompt: "old work" }, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "old output", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    expect(verdictPosts(h)).toHaveLength(1);
  });

  it("a hold journaled with its caller agent loads and settles once", async () => {
    const handle = `vrf_${"e".repeat(24)}`;
    const h = await boot([
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-df111-new", callerAgent: "build", dispatch: { prompt: "new work" }, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "new output", status: "succeeded", at: Date.now() },
    ]);
    adoptOrchestrator(h);
    await h.settled();
    expect(verdictPosts(h)).toHaveLength(1);
  });
});

describe("DF-1.1-1: a restored held completion's grader launches as the journaled caller agent (real adapter, native subagent)", () => {
  const CALL = "call-df111-restored";
  const criteriaPrompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
  const overrides = { routing: { background: { mode: "auto" }, leases: { mode: "off" } } };
  const sessions = { [ORCH]: { agent: "build" }, [CHILD]: { parentID: ORCH }, [EVENT_CHILD]: { parentID: ORCH } };
  const readJournal = (path: string): Array<Record<string, unknown>> =>
    readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  const denied = (): Error => new Error("Tool.Error: Subagent denied: model-router-grader");

  it("DF-1.1-1 a hold journaled with callerAgent `build` whose gate a restart cut: the re-run grader reaches the native subagent with agent `build`", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    // Process A: a held background `fast` dispatch from `build`; its grader never answers, so the restart cuts the gate.
    let released = false;
    const waiting: Array<(error: Error) => void> = [];
    const firstStub: NativeSubagentStub = {
      calls: [],
      respond: () => (released ? Promise.reject(denied()) : new Promise((_resolve, reject) => { waiting.push(reject); })),
    };
    const a = await bootBgHost({ overrides, sessions, nativeSubagent: firstStub });
    host = a;
    execFileSync("git", ["init", "-q"], { cwd: a.project }); // a work tree the gate can prepare its verification in
    a.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await a.drain();
    const call = await a.before({
      sessionID: ORCH, agent: "build", messageID: "m-df111-r", id: CALL, tool: "subagent",
      input: { agent: "fast", description: "explain the parser", prompt: criteriaPrompt, background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await a.after({ ...call, status: "completed", result: running });
    await a.settled();
    a.childContext.set(CHILD, [{ role: "assistant", content: [{ type: "text", text: "The parser starts in parse()." }], finish: "stop", time: { created: 1, completed: 2 } }]);
    a.emit({ type: "session.execution.succeeded", id: `ev-end-${CHILD}-succeeded`, created: 2, data: { sessionID: CHILD } });
    await a.drain();
    // The gate waits on A's grader: the hold, its child text and its pending entry are journaled; no verdict is.
    let snapshot: Array<Record<string, unknown>> = [];
    await vi.waitFor(() => {
      expect(firstStub.calls.length).toBeGreaterThan(0);
      snapshot = readJournal(a.journalPath);
      const hold = snapshot.find((r) => r.kind === "hold" && r.callID === CALL);
      expect(hold).toBeDefined();
      expect(snapshot.some((r) => r.kind === "hold-text" && r.handle === hold?.handle)).toBe(true);
      expect(snapshot.some((r) => r.kind === "entry" && r.callID === CALL)).toBe(true);
    }, { timeout: 25_000 });
    const hold = snapshot.find((r) => r.kind === "hold" && r.callID === CALL);
    // The caller agent is journaled with the hold, next to the dispatched agent of the inflight record.
    expect(hold?.callerAgent).toBe("build");
    for (const launched of firstStub.calls) expect(launched.agent).toBe("build");
    // A dies here: what it journaled until now is what the next process gets. Only the hold path recovers it (no `inflight`).
    const kept = snapshot.filter((r) => r.kind !== "inflight" && r.kind !== "processed");
    released = true;
    for (const reject of waiting.splice(0)) reject(denied());
    await a.settled();
    // Every spelling of A's home a record may hold (as given, resolved, with forward slashes), longest first.
    const homesA = [...new Set([a.home, realpathSync(a.home), realpathSync.native(a.home)].flatMap((p) => [p, p.replace(/\\/g, "/")]))]
      .sort((x, y) => y.length - x.length);
    await a.dispose();
    host = undefined;
    // Process B: a fresh home whose journal is A's cut one (A's paths moved to B's home).
    const homeB = mkdtempSync(join(tmpdir(), "omr-df111-restart-"));
    const escaped = (path: string): string => JSON.stringify(path).slice(1, -1);
    const moved = (line: string): string => homesA.reduce((text, homeA) => text.split(escaped(homeA)).join(escaped(homeB)), line);
    const journalText = kept.map((record) => `${moved(JSON.stringify(record))}\n`).join("");
    const secondStub: NativeSubagentStub = { calls: [] }; // answers with the host's denial
    // QA-PDF12-1: B's parent runs another agent now (`plan`), so only the journaled caller can yield `build`.
    const b = await bootBgHost({ home: homeB, overrides, sessions: { ...sessions, [ORCH]: { agent: "plan" } }, journalText, nativeSubagent: secondStub });
    host = b;
    execFileSync("git", ["init", "-q"], { cwd: b.project });
    adoptOrchestrator(b);
    await b.settled();
    await vi.waitFor(() => expect(secondStub.calls.length).toBeGreaterThan(0), { timeout: 25_000 });
    await b.settled();
    for (const launched of secondStub.calls) {
      expect(launched.agent).toBe("build");
      expect(launched.sessionID).toBe(ORCH);
    }
  }, 60_000);
});

describe("QA-PDF12-1/-2: after a restart, the grader launches as the caller on either recovery path, even for an old entry", () => {
  const criteriaPrompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
  const overrides = { routing: { background: { mode: "auto" }, leases: { mode: "off" } } };
  const sessionsA = { [ORCH]: { agent: "build" }, [CHILD]: { parentID: ORCH }, [EVENT_CHILD]: { parentID: ORCH } };
  const childDone = [{ role: "assistant", content: [{ type: "text", text: "The parser starts in parse()." }], finish: "stop", time: { created: 1, completed: 2 } }];
  const readJournal = (path: string): Array<Record<string, unknown>> =>
    readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  const denied = (): Error => new Error("Tool.Error: Subagent denied: model-router-grader");

  /**
   * Process A: a held background `fast` dispatch from `build` whose grader never answers, so A dies with the gate cut. Process
   * B, whose parent session runs `plan` by now, adopts A's journal. `keepInflight`: B recovers through the `inflight` record
   * (the completion processor's finish); otherwise through the restored hold. `oldEntry`: the records lose their caller fields
   * (a journal written before they existed). Returns B's grader launches and B's journal.
   */
  const restart = async (callID: string, opts: { keepInflight: boolean; oldEntry: boolean; parentAssistantID?: string }) => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    let released = false;
    const waiting: Array<(error: Error) => void> = [];
    const firstStub: NativeSubagentStub = {
      calls: [],
      respond: () => (released ? Promise.reject(denied()) : new Promise((_resolve, reject) => { waiting.push(reject); })),
    };
    const a = await bootBgHost({ overrides, sessions: sessionsA, nativeSubagent: firstStub });
    host = a;
    execFileSync("git", ["init", "-q"], { cwd: a.project });
    a.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await a.drain();
    const call = await a.before({
      sessionID: ORCH, agent: "build", messageID: `m-${callID}`, id: callID, tool: "subagent",
      input: { agent: "fast", description: "explain the parser", prompt: criteriaPrompt, background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await a.after({ ...call, status: "completed", result: running });
    await a.settled();
    a.childContext.set(CHILD, childDone);
    a.emit({ type: "session.execution.succeeded", id: `ev-end-${CHILD}-succeeded`, created: 2, data: { sessionID: CHILD } });
    await a.drain();
    let snapshot: Array<Record<string, unknown>> = [];
    await vi.waitFor(() => {
      expect(firstStub.calls.length).toBeGreaterThan(0);
      snapshot = readJournal(a.journalPath);
      const hold = snapshot.find((r) => r.kind === "hold" && r.callID === callID);
      expect(hold).toBeDefined();
      expect(snapshot.some((r) => r.kind === "inflight" && r.callID === callID)).toBe(true);
      expect(snapshot.some((r) => r.kind === "hold-text" && r.handle === hold?.handle)).toBe(true);
      expect(snapshot.some((r) => r.kind === "entry" && r.callID === callID)).toBe(true);
    }, { timeout: 25_000 });
    // Both records carry the caller (agent and message) as A journaled them.
    for (const record of snapshot.filter((r) => (r.kind === "inflight" || r.kind === "hold") && r.callID === callID)) {
      expect(record.callerAgent).toBe("build");
      expect(record.callerMessageID).toBe(`m-${callID}`);
    }
    // A dies before it journals `processed`; what it journaled until now is what B gets.
    const withoutCaller = (record: Record<string, unknown>): Record<string, unknown> => {
      if (!opts.oldEntry) return record;
      return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "callerAgent" && key !== "callerMessageID"));
    };
    const kept = snapshot.filter((r) => r.kind !== "processed" && (opts.keepInflight || r.kind !== "inflight")).map(withoutCaller);
    released = true;
    for (const reject of waiting.splice(0)) reject(denied());
    await a.settled();
    const homesA = [...new Set([a.home, realpathSync(a.home), realpathSync.native(a.home)].flatMap((p) => [p, p.replace(/\\/g, "/")]))]
      .sort((x, y) => y.length - x.length);
    await a.dispose();
    host = undefined;
    const homeB = mkdtempSync(join(tmpdir(), "omr-pdf12-restart-"));
    const escaped = (path: string): string => JSON.stringify(path).slice(1, -1);
    const moved = (line: string): string => homesA.reduce((text, homeA) => text.split(escaped(homeA)).join(escaped(homeB)), line);
    const journalText = kept.map((record) => `${moved(JSON.stringify(record))}\n`).join("");
    const secondStub: NativeSubagentStub = { calls: [] }; // answers with the host's denial
    // B's parent runs another agent now (`plan`): only the journaled caller yields `build`.
    const b = await bootBgHost({ home: homeB, overrides, sessions: { ...sessionsA, [ORCH]: { agent: "plan" } }, journalText, nativeSubagent: secondStub });
    host = b;
    execFileSync("git", ["init", "-q"], { cwd: b.project });
    b.childContext.set(CHILD, childDone); // the child's finished history, which an `inflight` recovery reads
    // The parent's own history, whose latest assistant message an old entry (no journaled message id) falls back to.
    if (opts.parentAssistantID !== undefined) {
      b.childContext.set(ORCH, [
        { id: "m-parent-user", role: "user", content: [{ type: "text", text: "go" }] },
        { id: opts.parentAssistantID, role: "assistant", content: [{ type: "text", text: "dispatching" }] },
      ]);
    }
    adoptOrchestrator(b);
    await b.settled();
    await vi.waitFor(() => expect(secondStub.calls.length).toBeGreaterThan(0), { timeout: 25_000 });
    await b.settled();
    return { calls: secondStub.calls, journal: readJournal(b.journalPath) };
  };
  /** The completion processor journals `processed` for what it finished: present only when the `inflight` path recovered it. */
  const processedHere = (journal: ReadonlyArray<Record<string, unknown>>, callID: string): boolean =>
    journal.some((r) => r.kind === "processed" && r.callID === callID && r.child === CHILD);

  it("QA-PDF12-2 a kept `inflight` record recovers through the completion processor: its grader launches as the journaled caller, with the journaled message", async () => {
    const callID = "call-pdf122-inflight";
    const { calls, journal } = await restart(callID, { keepInflight: true, oldEntry: false });
    expect(processedHere(journal, callID)).toBe(true);
    for (const launched of calls) {
      expect(launched.agent).toBe("build");
      expect(launched.messageID).toBe(`m-${callID}`);
      expect(launched.callID).toBe(callID);
    }
  }, 60_000);

  it("QA-PDF12-1 an old `inflight` entry without its caller: the grader launches as the parent's current agent (`plan`), never undefined", async () => {
    const callID = "call-pdf121-inflight";
    const { calls, journal } = await restart(callID, { keepInflight: true, oldEntry: true });
    expect(processedHere(journal, callID)).toBe(true);
    for (const launched of calls) expect(launched.agent).toBe("plan");
  }, 60_000);

  it("QA-PDF12-1 an old hold without its caller (no `inflight`): the re-run grader launches as the parent's current agent (`plan`), never undefined", async () => {
    const callID = "call-pdf121-hold";
    const { calls, journal } = await restart(callID, { keepInflight: false, oldEntry: true });
    expect(processedHere(journal, callID)).toBe(false);
    for (const launched of calls) expect(launched.agent).toBe("plan");
  }, 60_000);

  it("QA-PDF12-12 an old `inflight` entry without its message id: the grader's context carries the parent's latest assistant message id", async () => {
    const callID = "call-pdf1212-inflight";
    const { calls } = await restart(callID, { keepInflight: true, oldEntry: true, parentAssistantID: "m-parent-latest" });
    expect(calls.length).toBeGreaterThan(0);
    for (const launched of calls) expect(launched.messageID).toBe("m-parent-latest");
  }, 60_000);

  it("QA-PDF12-12 an old hold without its message id (no `inflight`): the re-run grader's context carries the parent's latest assistant message id", async () => {
    const callID = "call-pdf1212-hold";
    const { calls } = await restart(callID, { keepInflight: false, oldEntry: true, parentAssistantID: "m-parent-latest" });
    expect(calls.length).toBeGreaterThan(0);
    for (const launched of calls) expect(launched.messageID).toBe("m-parent-latest");
  }, 60_000);

  it("QA-PDF12-12 an old entry whose parent history cannot be read keeps the empty message id", async () => {
    const callID = "call-pdf1212-none";
    const { calls } = await restart(callID, { keepInflight: false, oldEntry: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const launched of calls) expect(launched.messageID).toBe("");
  }, 60_000);
});

describe("DF-1.1-1: the call claims are process-wide across module copies", () => {
  it("a second module copy of the registry cannot claim a callID the first copy holds; it can after the first lets go", async () => {
    const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
    const record = {
      callID: "call-df111-claim", parentSessionID: ORCH, agent: "fast", description: "d", verifying: false, verificationMode: "none" as const,
      decision: { background: true, hold: false, reason: "prior" as const }, at: Date.now(),
    };
    const first = await import("../../src/compat/background");
    vi.resetModules();
    const second = await import("../../src/compat/background");
    expect(second.createInFlightRegistry).not.toBe(first.createInFlightRegistry);
    const a = first.createInFlightRegistry({ now: Date.now, logger: quiet });
    const b = second.createInFlightRegistry({ now: Date.now, logger: quiet });
    try {
      expect(a.decide(record)).toBe(true);
      expect(b.decide(record)).toBe(false);
      a.dispose();
      expect(b.decide(record)).toBe(true);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

describe("QA-PDF12-6: two plugin instances of one process receive the same call", () => {
  it("QA-PDF12-6 exactly one instance claims the call, and only its background decision reaches the input", async () => {
    process.env.MODEL_ROUTER_ENFORCE = "1";
    const overrides = { routing: { background: { mode: "auto" }, leases: { mode: "off" } } };
    const criteriaPrompt = ["Explain the parser.", "", "[acceptance]", "criteria: the explanation names the parser's entry point", "[/acceptance]"].join("\n");
    const records = (path: string): Array<Record<string, unknown>> => {
      try {
        return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    };
    const owner = await bootBgHost({ overrides, sessions: { [ORCH]: { agent: "build" }, [CHILD]: { parentID: ORCH } } });
    host = owner;
    owner.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await owner.drain();
    // A second instance from another module copy (its own home): it sees ORCH as a child session, so on its own it keeps a
    // verifying call in the foreground.
    vi.resetModules();
    const copy = await import("../helpers/v2-bg-host");
    const second = await copy.bootBgHost({ overrides, sessions: { [ORCH]: { parentID: "ses_root_pdf126", agent: "build" }, [CHILD]: { parentID: ORCH } } });
    try {
      const input = { agent: "fast", description: "explain the parser", prompt: criteriaPrompt, background: true };
      const alone = await second.before({ sessionID: ORCH, agent: "build", messageID: "m-pdf126-alone", id: "call-pdf126-alone", tool: "subagent", input: { ...input } });
      expect((alone.input as Record<string, unknown>).background).toBe(false);
      // The same call reaches both: the owner claims it first and sends it to the background.
      const event = { sessionID: ORCH, agent: "build", messageID: "m-pdf126", id: "call-pdf126", tool: "subagent", input: { ...input } as unknown };
      await owner.before(event);
      expect((event.input as Record<string, unknown>).background).toBe(true);
      // The second instance lost the claim: it leaves the owner's background flag as it found it.
      await second.before(event);
      expect((event.input as Record<string, unknown>).background).toBe(true);
      const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
      const ownerDone = await owner.after({ ...event, status: "completed", result: structuredClone(running) });
      const secondDone = await second.after({ ...event, status: "completed", result: structuredClone(running) });
      // QA-PDF12-10: the copy that lost the claim does not treat the call as verifying, so it never says acceptance needs a
      // foreground return; the owner's notice (the result is held) is the one the call carries.
      expect(JSON.stringify(secondDone.result)).not.toContain("automatic acceptance requires");
      expect(JSON.stringify(ownerDone.result)).toContain("held until verification finishes");
      await owner.settled();
      await second.settled();
      // Only the owner acknowledged and journaled the dispatch.
      expect(records(owner.journalPath).filter((r) => r.kind === "inflight" && r.callID === "call-pdf126")).toHaveLength(1);
      expect(records(second.journalPath).some((r) => r.kind === "inflight" && r.callID === "call-pdf126")).toBe(false);
    } finally {
      await second.dispose();
    }
  }, 30_000);
});

describe("QA-DF1-21: an adopted dispatch of this very process whose child is still running", () => {
  // Each test its own call id: the in-flight registry's call claims are process-wide.
  const record = (process: string, callID: string): Record<string, unknown> => ({
    v: 1, kind: "inflight", key: `${CHILD}\u0000${callID}`, callID, parentSessionID: ORCH, childSessionID: CHILD,
    // `at`: now (a record older than the attempt sweep age is closed, never recovered).
    label: "fast", at: Date.now(), agent: "fast", description: "background work", verifying: false, verificationMode: "none", hold: null, process,
  });
  const lostNotices = (h: BgHost): SyntheticCall[] => h.synthetic.filter((s) => s.sessionID === ORCH && /lost in|Dispatch it again/.test(s.text));
  /** The child's last step is cut: text, no step end, no execution end. */
  const midStep = (h: BgHost): void => {
    h.childContext.set(CHILD, [{ type: "assistant", role: "assistant", content: [{ type: "text", text: "half way" }], time: { created: 1 } }]);
  };
  const parentRequest = async (h: BgHost): Promise<string> => {
    const event = {
      sessionID: ORCH, agent: "build", model: { providerID: "anthropic", id: "claude-sonnet-5-5" }, options: {},
      system: [{ type: "text", text: "Host instructions" }], messages: [{ id: "m-user", role: "user", content: [{ type: "text", text: "next" }] }], tools: {},
    };
    await h.context(event);
    return JSON.stringify(event.messages);
  };

  it("QA-DF1-21 an evicted location's dispatch (same process) stays dormant until its end event, never `lost in restart`", async () => {
    const h = await boot([record(processToken(), "call-qa21-same")]);
    midStep(h);
    await parentRequest(h); // the root request that teaches the adapter ORCH is a root (only a root's request carries the tail)
    adoptOrchestrator(h);
    await h.settled();
    expect(lostNotices(h)).toHaveLength(0);
    // Its end event processes it like any running background dispatch.
    h.childContext.set(CHILD, [{ role: "assistant", content: [{ type: "text", text: "DONE: finished" }], finish: "stop", time: { created: 1, completed: 2 } }]);
    h.emit({ type: "session.execution.succeeded", id: "ev-end-qa21", created: 3, data: { sessionID: CHILD } });
    await h.settled();
    const tail = await parentRequest(h);
    expect(tail).toContain("Completed since your last turn");
    expect(lostNotices(h)).toHaveLength(0);
    expect(tail).not.toContain("lost in");
  });

  it("QA-DF1-21 (guard) the same unfinished child journaled by another process is still lost in restart", async () => {
    const h = await boot([record("another-process", "call-qa21-other")]);
    midStep(h);
    await parentRequest(h);
    adoptOrchestrator(h);
    await h.settled();
    await vi.waitFor(() => expect(h.synthetic.map((s) => `${s.sessionID}|${s.text.slice(0, 160)}`).join("\n")).toMatch(/lost in/), { timeout: 3_000 });
    expect(lostNotices(h)).toHaveLength(1);
  });
});

describe("QA-PDF12-14: the caller lookups of a rebuilt context", () => {
  const parentReads = (h: BgHost): { count(): number } => {
    const original = h.childContext.get.bind(h.childContext);
    let reads = 0;
    vi.spyOn(h.childContext, "get").mockImplementation((key: string) => {
      if (key === ORCH) reads += 1;
      return original(key);
    });
    return { count: () => reads };
  };

  it("QA-PDF12-14 restored holds of one parent share one lookup of the parent's history, however many they are", async () => {
    const readsFor = async (holds: number): Promise<number> => {
      const children = Array.from({ length: holds }, (_, i) => `child-hold-${i}`);
      const records = children.flatMap((child, i): Array<Record<string, unknown>> => {
        const handle = `vrf_${String(i).repeat(24)}`;
        return [
          { v: 1, kind: "hold", handle, parent: ORCH, child, callID: `call-pdf1214-${holds}-${i}`, dispatch: { prompt: "old work" }, at: Date.now() },
          { v: 1, kind: "hold-text", handle, text: "old output", status: "succeeded", at: Date.now() },
        ];
      });
      const h = await boot(records, Object.fromEntries(children.map((child) => [child, { parentID: ORCH }])));
      const reads = parentReads(h);
      adoptOrchestrator(h);
      await h.settled();
      expect(verdictPosts(h)).toHaveLength(holds);
      const count = reads.count();
      await h.dispose();
      host = undefined;
      vi.restoreAllMocks();
      return count;
    };
    const one = await readsFor(1);
    expect(one).toBeGreaterThan(0);
    expect(await readsFor(4)).toBe(one);
  }, 30_000);

  /** The completion processor journals `processed` right after its `finish` returned: proof the finish (and its lookups) ran. */
  const processedHere = (h: BgHost, callID: string): boolean =>
    readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line.trim() !== "")
      .some((line) => {
        const r = JSON.parse(line) as Record<string, unknown>;
        return r.kind === "processed" && r.callID === callID;
      });
  /**
   * A live background dispatch whose call carries no message id (so its caller's message is NOT journaled and a finish that
   * needs it must look it up in the parent's history), whose child then ends with `ending`. Returns the parent-history reads
   * made from the child's end until the processor journaled `processed` for the call.
   */
  const completeWith = async (callID: string, ending: "succeeded" | "failed"): Promise<number> => {
    const h = await boot([]);
    h.emit({ type: "session.created", id: `ev-created-${CHILD}`, created: 1, data: { sessionID: CHILD, parentID: ORCH } });
    await h.drain();
    const call = await h.before({
      sessionID: ORCH, agent: "build", messageID: "", id: callID, tool: "subagent",
      input: { agent: "fast", description: "background work", prompt: "do the work", background: true },
    });
    const running = { output: { sessionID: CHILD, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: CHILD } };
    await h.after({ ...call, status: "completed", result: running });
    await h.settled();
    // The dispatch runs in the background and its record carries no caller message: a lookup is needed at its finish.
    const inflight = readFileSync(h.journalPath, "utf8").split("\n").filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>).filter((r) => r.kind === "inflight" && r.callID === callID);
    expect(inflight.length).toBeGreaterThan(0);
    for (const record of inflight) expect(record.callerMessageID).toBeUndefined();
    const reads = parentReads(h);
    h.childContext.set(CHILD, [{ role: "assistant", content: [{ type: "text", text: "partial" }], finish: "stop", time: { created: 1, completed: 2 } }]);
    h.emit({ type: `session.execution.${ending}`, id: `ev-end-${callID}-${ending}`, created: 3, data: { sessionID: CHILD } });
    await h.drain();
    // The processor journals (file I/O) around its finish, which microtask turns alone do not cover.
    await vi.waitFor(() => expect(processedHere(h, callID)).toBe(true), { timeout: 10_000 });
    const count = reads.count();
    await h.settled();
    return count;
  };

  it("QA-PDF12-14 a completion that succeeded looks the caller's message up when its record has none (control)", async () => {
    expect(await completeWith("call-pdf1214-ok", "succeeded")).toBeGreaterThan(0);
  }, 30_000);

  it("QA-PDF12-14 a completion that did not succeed skips the caller lookup, although its record has no caller message", async () => {
    expect(await completeWith("call-pdf1214-failed", "failed")).toBe(0);
  }, 30_000);
});

describe("a restored hold whose recovery is skipped (QA-2.1-29)", () => {
  it("is settled UNVERIFIABLE instead of staying held until the TTL", async () => {
    const handle = `vrf_${"c".repeat(24)}`;
    const h = await boot([
      {
        v: 1, kind: "inflight", key: `${CHILD}\u0000call-dup`, callID: "call-dup", parentSessionID: ORCH, childSessionID: CHILD,
        label: 'fast "x"', agent: "fast", description: "x", verifying: true, verificationMode: "required", handle, hold: handle, at: Date.now(),
      },
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-dup", at: Date.now() },
    ], { "orch-2": {} });
    // A live background dispatch of another root session claims the same call id in this process first, so the recovery's
    // `decide` is refused and no attempt is acknowledged for the restored record.
    await h.before({
      sessionID: "orch-2", agent: "build", messageID: "m-dup", id: "call-dup", tool: "subagent",
      input: { agent: "fast", description: "x", prompt: "do the work", background: true },
    });
    adoptOrchestrator(h);
    await h.settled();
    const posts = verdictPosts(h);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain(handle);
    expect(posts[0]?.text).toContain("lost in restart");
  });
});

describe("a restored executor child's end event has no compat-side effect (phase 4.2 memo section 10)", () => {
  // Executor-owned attempts are never journaled by the compat layer (adapterRecords skips them), so after a restart the
  // compat layer knows nothing of an executor child: its end event must not create a record, post to the parent or wake it.
  const EXEC_CHILD = "exec-child-1";
  const journalText = (h: BgHost): string => {
    try {
      return readFileSync(h.journalPath, "utf8");
    } catch {
      return "";
    }
  };
  const parentTail = async (h: BgHost): Promise<string> => {
    const event = {
      sessionID: ORCH, agent: "build", model: { providerID: "anthropic", id: "claude-sonnet-5-5" }, options: {},
      system: [{ type: "text", text: "Host instructions" }], messages: [{ id: "m-user", role: "user", content: [{ type: "text", text: "next" }] }], tools: {},
    };
    await h.context(event);
    return JSON.stringify(event.messages);
  };

  it("after a restart, session.execution.succeeded of a child nobody journaled leaves the journal, the parent and the wakes untouched", async () => {
    const handle = `vrf_${"7".repeat(24)}`;
    // The previous process left one unrelated held result of ORCH: the control that proves this host shows a post when there is one.
    const h = await boot([
      { v: 1, kind: "hold", handle, parent: ORCH, child: CHILD, callID: "call-exec-control", dispatch: { prompt: "write src/x.ts" }, at: Date.now() },
      { v: 1, kind: "hold-text", handle, text: "I wrote src/x.ts", status: "succeeded", at: Date.now() },
    ], { [EXEC_CHILD]: { parentID: ORCH } });
    await parentTail(h); // teaches the adapter that ORCH is a root
    adoptOrchestrator(h);
    await h.settled();
    expect(verdictPosts(h)).toHaveLength(1); // the control: the restored hold was settled once
    await parentTail(h); // drains whatever the adoption queued for the parent's next request
    const before = { synthetic: h.synthetic.length, steer: h.deliveries.steer, wake: h.deliveries.wake, journal: journalText(h) };

    // The executor child is sighted after the restart, finishes, and its end event arrives.
    h.emit({ type: "session.created", id: `ev-created-${EXEC_CHILD}`, created: 4, data: { sessionID: EXEC_CHILD, parentID: ORCH } });
    await h.drain();
    h.childContext.set(EXEC_CHILD, [{ role: "assistant", content: [{ type: "text", text: "DONE: executor attempt finished" }], finish: "stop", time: { created: 1, completed: 2 } }]);
    h.emit({ type: "session.execution.succeeded", id: `ev-end-${EXEC_CHILD}-succeeded`, created: 5, data: { sessionID: EXEC_CHILD } });
    await h.drain();
    await h.settled();

    // No record: nothing was journaled for the child (no inflight, hold, entry or processed), the journal is byte-identical.
    expect(journalText(h)).toBe(before.journal);
    expect(journalText(h)).not.toContain(EXEC_CHILD);
    // No parent message: no result post, no synthetic entry, no completion notice in the parent's next request.
    expect(h.synthetic).toHaveLength(before.synthetic);
    expect(h.synthetic.some((s) => s.text.includes(EXEC_CHILD) || s.text.includes("executor attempt finished"))).toBe(false);
    expect(verdictPosts(h)).toHaveLength(1);
    const tail = await parentTail(h);
    expect(tail).not.toContain(EXEC_CHILD);
    expect(tail).not.toContain("Completed since your last turn");
    // No wake: nothing was delivered to the parent as a steer or a wake.
    expect(h.deliveries).toEqual({ steer: before.steer, wake: before.wake });
  });
});
