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
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADOPTION_RETRY_MS } from "../../src/compat/background";
import { processToken } from "../../src/compat/v2-hooks";
import { CLAIM_STALE_MS, PENDING_INSTANCES_DIRNAME } from "../../src/verify/pending";
import { bootBgHost, restoreEnv, type BgHost, type SyntheticCall } from "../helpers/v2-bg-host";

let host: BgHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  restoreEnv();
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
    for (const record of journalRecords(h).filter((r) => r.kind === "hold" && r.callID === "call-df111-live")) expect(record.callerAgent).toBe("build");
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
