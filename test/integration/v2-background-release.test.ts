/**
 * test/integration/v2-background-release.test.ts
 *
 * QA-2.1-14: a held background dispatch reserves a pending handle at its acknowledgement (`FinishApi.reserveHeld`). When the
 * child ends without a held result to verify (failed, interrupted), the reservation must be given back at once through the
 * plugin's `FinishApi.releaseHeld` (`pending.releaseHandle`): a reservation left behind counts toward the 32 per-session /
 * 128 global entry caps for `HELD_RESERVATION_TTL_MS` (7 h), and the next held dispatch would fall back to the foreground.
 *
 * The same holds when the acknowledgement itself registers no attempt (the registry returns nothing or throws): the handle
 * reserved just before it is given back at once, so router_verify answers unknown for it instead of "held".
 *
 * Driven through the REAL plugin behind the REAL v2 adapter (test/helpers/v2-bg-host.ts). No sleeps: events are drained by
 * microtask turns and the adapter's background work is awaited with `settled()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ENTRIES_PER_SESSION, UNKNOWN_HANDLE_TEXT } from "../../src/verify/pending";
import { HELD_RESULT_TEXT } from "../../src/verify/wiring";
import { bootBgHost, restoreEnv, type BgHost, type ToolEvent } from "../helpers/v2-bg-host";

const ackFault = vi.hoisted(() => ({ mode: undefined as "undefined" | "throw" | undefined, handles: [] as string[] }));

// The REAL in-flight registry. With `ackFault.mode` set, its acknowledgement records the reserved handle it was given and then
// registers no attempt: it returns undefined or throws.
vi.mock("../../src/compat/background", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/compat/background")>();
  return {
    ...actual,
    createInFlightRegistry: (...args: Parameters<typeof actual.createInFlightRegistry>) => {
      const registry = actual.createInFlightRegistry(...args);
      const acknowledge = registry.acknowledge.bind(registry);
      registry.acknowledge = (callID, child, ack) => {
        const mode = ackFault.mode;
        if (mode === undefined) return acknowledge(callID, child, ack);
        if (ack.hold !== undefined) ackFault.handles.push(ack.hold.handle);
        if (mode === "throw") throw new Error("injected acknowledge failure");
        return undefined;
      };
      return registry;
    },
  };
});

let host: BgHost | undefined;

afterEach(async () => {
  ackFault.mode = undefined;
  ackFault.handles.length = 0;
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

/** The plugin's own `router_verify` tool on one handle of the orchestrator's session, as the model calls it. */
async function routerVerify(h: BgHost, handle: string): Promise<string> {
  const verify = h.hooks.tool?.router_verify;
  if (verify === undefined) throw new Error("the plugin registers no router_verify tool");
  const context = { sessionID: ORCH, messageID: "m-release-verify", agent: "build", abort: new AbortController().signal };
  const result: unknown = await verify.execute({ handles: [handle] }, context as unknown as Parameters<typeof verify.execute>[1]);
  return typeof result === "string" ? result : JSON.stringify(result);
}

describe("a held dispatch whose acknowledgement fails frees its reservation at once (FinishApi.releaseHeld)", () => {
  for (const mode of ["undefined", "throw"] as const) {
    it(`the acknowledgement ${mode === "throw" ? "throws" : "registers no attempt"}: router_verify answers unknown for the reserved handle, not held`, async () => {
      const h = await bootBgHost({
        overrides: { routing: { background: { mode: "auto" }, leases: { mode: "off" } } },
        sessions: { [ORCH]: {}, "child-ack-failed": { parentID: ORCH }, "child-ack-ok": { parentID: ORCH } },
      });
      host = h;

      ackFault.mode = mode;
      const failed = await heldDispatch(h, "child-ack-failed");
      ackFault.mode = undefined;
      await h.settled();
      // It went out in the background and a handle was reserved for its hold, but no attempt carries it: it is not held.
      expect(failed).toEqual({ background: true, held: false });
      expect(ackFault.handles).toHaveLength(1);
      const handle = ackFault.handles[0];
      if (handle === undefined) throw new Error("no handle was reserved");
      // Without the release the reservation lingers for HELD_RESERVATION_TTL_MS and router_verify answers "held" for it.
      const answer = await routerVerify(h, handle);
      expect(answer).toContain(`- ${handle} \u00b7 ${UNKNOWN_HANDLE_TEXT}`);
      expect(answer).not.toContain(HELD_RESULT_TEXT);

      // The session's next held dispatch is acknowledged and held as usual.
      expect(await heldDispatch(h, "child-ack-ok")).toEqual({ background: true, held: true });
    }, 15_000);
  }
});
