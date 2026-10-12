/**
 * test/integration/v2-background-release.test.ts
 *
 * QA-2.1-14: a held background dispatch reserves a pending handle at its acknowledgement (`FinishApi.reserveHeld`). When the
 * child ends without a held result to verify (failed, interrupted), the reservation must be given back at once through the
 * plugin's `FinishApi.releaseHeld` (`pending.releaseHandle`): a reservation left behind counts toward the 32 per-session /
 * 128 global entry caps for `HELD_RESERVATION_TTL_MS` (7 h), and the next held dispatch would fall back to the foreground.
 *
 * Driven through the REAL plugin behind the REAL v2 adapter (test/helpers/v2-bg-host.ts). No sleeps: events are drained by
 * microtask turns and the adapter's background work is awaited with `settled()`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MAX_ENTRIES_PER_SESSION } from "../../src/verify/pending";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

let host: BgHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
  restoreEnv();
});

const ORCH = "orch";
const HELD_ACK = "Its result is held until verification finishes";

let seq = 0;
function dispatch(): ToolEvent {
  seq += 1;
  return {
    sessionID: ORCH,
    agent: "build",
    messageID: `m-release-${seq}`,
    id: `call-release-${seq}`,
    tool: "subagent",
    input: { agent: "fast", description: "background work", prompt: "do the work", background: true },
  };
}

function running(child: string): unknown {
  return { output: { sessionID: child, status: "running", output: "Working in the background" }, content: "Working in the background", metadata: { sessionID: child } };
}

function created(child: string): unknown {
  return { type: "session.created", id: `ev-created-${child}`, created: 1, data: { sessionID: child, parentID: ORCH } };
}

function ended(child: string, kind: "failed" | "interrupted"): unknown {
  return { type: `session.execution.${kind}`, id: `ev-end-${child}-${kind}`, created: 2, data: { sessionID: child } };
}

function verdictPosts(h: BgHost): number {
  return h.synthetic.filter((s) => s.sessionID === ORCH && s.text.startsWith("<router-verdict ")).length;
}

/** One explicit background dispatch of `child`: returns whether it was sent in the background and acknowledged as held. */
async function heldDispatch(h: BgHost, child: string): Promise<{ background: unknown; held: boolean }> {
  h.emit(created(child));
  await h.drain();
  const call = await h.before(dispatch());
  const background = (call.input as Record<string, unknown>).background;
  const ack = await h.after({ ...call, status: "completed", result: running(child) });
  return { background, held: JSON.stringify(ack.result).includes(HELD_ACK) };
}

describe("QA-2.1-14: a held dispatch that ends without a result frees its reservation (FinishApi.releaseHeld)", () => {
  it(`${MAX_ENTRIES_PER_SESSION + 1} failed or interrupted held dispatches in one session still leave room for a new held dispatch`, async () => {
    const count = MAX_ENTRIES_PER_SESSION + 1;
    const children = Array.from({ length: count + 1 }, (_, i) => `child-release-${i}`);
    const h = await bootBgHost({
      overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
      sessions: { [ORCH]: {}, ...Object.fromEntries(children.map((child) => [child, { parentID: ORCH }])) },
    });
    host = h;

    const childAt = (i: number): string => {
      const child = children[i];
      if (child === undefined) throw new Error(`no child ${i}`);
      return child;
    };
    for (let i = 0; i < count; i += 1) {
      const child = childAt(i);
      const sent = await heldDispatch(h, child);
      // Every one of them is held: without the release, the 33rd finds no free slot (32 reservations still counted).
      expect(sent, `dispatch ${i + 1}`).toEqual({ background: true, held: true });
      // The processor reads the child's last text at its end event (an unreadable child waits for the completion instead).
      h.childContext.set(child, [{ role: "assistant", content: [{ type: "text", text: "partial work" }] }]);
      h.emit(ended(child, i % 2 === 0 ? "failed" : "interrupted"));
      await h.settled();
      // The child produced nothing to verify: its UNVERIFIABLE verdict is posted and nothing stays reserved for it. The
      // processor journals (file I/O) before it posts; QA-2.1-21: settled() covers the end handling and the processing it
      // starts, so the verdict is posted by now (no polling).
      expect(verdictPosts(h), `dispatch ${i + 1}`).toBe(i + 1);
    }

    // After 33 held dispatches that all ended without a result, the session still has every slot: a new one is held too.
    const last = await heldDispatch(h, childAt(count));
    expect(last).toEqual({ background: true, held: true });
    // 34 dispatches, each with fsync'd journal writes (inflight, hold) on the real file system: slower than the 5 s default on Windows.
  }, 30_000);
});
