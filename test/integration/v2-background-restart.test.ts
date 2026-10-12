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
 */
import { afterEach, describe, expect, it } from "vitest";
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
