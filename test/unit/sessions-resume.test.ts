/**
 * test/unit/sessions-resume.test.ts
 *
 * Resume accounting in the session store. A "resume" is a same-session,
 * same-tier re-registration at chat.message — how an opencode task_id resume
 * manifests to the plugin. It resets the per-dispatch cap but preserves
 * cumulative usage and read fingerprints.
 */

import { describe, expect, it } from "vitest";
import {
  CUMULATIVE_CAP_MULTIPLIER,
  createSessionStore,
} from "../../src/router/sessions";
import { DEFAULT_IDLE_TTL_MS } from "../../src/router/idle-sweep";
import type { RouterConfig } from "../../src/router/config";

const cfg = {
  tierCaps: { fast: 8, medium: 5, heavy: 3 },
} as unknown as RouterConfig;
const tierNames = ["fast", "medium", "heavy"];

function dispatch(text: string) {
  return { parts: [{ type: "text", text }] };
}

function readCall(
  store: ReturnType<typeof createSessionStore>,
  sessionID: string,
  file: string,
): string {
  const out: Record<string, unknown> = {};
  store.recordToolCall({ sessionID, tool: "read", args: { file_path: file } }, out);
  return String(out.output ?? "");
}

describe("createSessionStore — per-dispatch resume caps", () => {
  it("resets per-dispatch calls on same-tier resume and keeps a cumulative ceiling", () => {
    const store = createSessionStore();

    const first = store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_cap" },
      dispatch("lookup CAP:2"),
      cfg,
      tierNames,
    );
    expect(first).toEqual({ registered: true, resumed: false });
    expect(readCall(store, "ses_resume_cap", "a.ts")).toContain("[cap: 1/2]");
    expect(readCall(store, "ses_resume_cap", "b.ts")).toContain("⚠ CAP REACHED (2/2)");

    const resumed = store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_cap" },
      dispatch("second dispatch CAP:3"),
      cfg,
      tierNames,
    );
    expect(resumed).toEqual({ registered: true, resumed: true });
    expect(readCall(store, "ses_resume_cap", "c.ts")).toContain("[cap: 1/3]");

    // Current cap is 3, so cumulative ceiling is 9. The 10th total read trips it.
    for (let i = 4; i <= 9; i += 1) {
      if (i === 6 || i === 9) {
        store.registerFromChatMessage(
          { agent: "fast", sessionID: "ses_resume_cap" },
          dispatch("another dispatch CAP:3"),
          cfg,
          tierNames,
        );
      }
      expect(readCall(store, "ses_resume_cap", `${i}.ts`)).not.toContain(
        "CUMULATIVE BUDGET EXCEEDED",
      );
    }
    const over = readCall(store, "ses_resume_cap", "ten.ts");
    expect(over).toContain("[cap: 2/3]");
    expect(over).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 10/9 across 4 dispatches");
  });

  it("ATTACK: many resumes each under the per-dispatch cap still hit the ceiling", () => {
    const store = createSessionStore();
    const sessionID = "ses_resume_attack";
    const cap = 4;
    const ceiling = cap * CUMULATIVE_CAP_MULTIPLIER;

    let total = 0;
    let banner = "";
    // 8 dispatch rounds x 3 reads each = 24 reads, every round strictly under
    // the per-dispatch cap of 4 — the per-dispatch cap NEVER fires.
    for (let round = 1; round <= 8; round += 1) {
      store.registerFromChatMessage(
        { agent: "fast", sessionID },
        dispatch(`round ${round} CAP:${cap}`),
        cfg,
        tierNames,
      );
      for (let call = 1; call <= 3; call += 1) {
        total += 1;
        banner = readCall(store, sessionID, `r${round}-c${call}.ts`);
        expect(banner).not.toContain("CAP REACHED");
        if (total <= ceiling) {
          expect(banner).not.toContain("CUMULATIVE BUDGET EXCEEDED");
        } else {
          expect(banner).toContain("CUMULATIVE BUDGET EXCEEDED");
          expect(banner).toContain(`${total}/${ceiling}`);
        }
      }
    }
    expect(total).toBe(24);
    expect(banner).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 24/12 across 8 dispatches");
  });

  it("never emits the cumulative line for a single-dispatch session, even when it overruns 3x its cap", () => {
    const store = createSessionStore();
    const sessionID = "ses_single_dispatch_overrun";

    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("one dispatch only CAP:2"),
      cfg,
      tierNames,
    );

    // 10 reads on a cap of 2 — well past the 6 the ceiling would use. Banners
    // are advisory, so an ignoring subagent can get here; the cumulative line
    // is for RESUMES only and must stay silent.
    let last = "";
    for (let i = 1; i <= 10; i += 1) {
      last = readCall(store, sessionID, `${i}.ts`);
      expect(last).not.toContain("CUMULATIVE BUDGET EXCEEDED");
      expect(last).not.toContain("across 1 dispatches");
    }
    expect(last).toContain("[cap: 10/2]");
    expect(last).toContain("⚠ CAP REACHED (10/2)");

    // The very first resume makes the accumulated overrun visible.
    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("now resumed CAP:2"),
      cfg,
      tierNames,
    );
    expect(readCall(store, sessionID, "after-resume.ts")).toContain(
      "⚠ CUMULATIVE BUDGET EXCEEDED: 11/6 across 2 dispatches",
    );
  });

  it("does not apply a cumulative ceiling when the current cap is CAP:none", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_none" },
      dispatch("unbounded CAP:none reason: stress test"),
      cfg,
      tierNames,
    );

    let last = "";
    for (let i = 1; i <= 12; i += 1) {
      if (i === 5 || i === 9) {
        store.registerFromChatMessage(
          { agent: "fast", sessionID: "ses_resume_none" },
          dispatch("still unbounded CAP:none reason: stress test"),
          cfg,
          tierNames,
        );
      }
      last = readCall(store, "ses_resume_none", `${i}.ts`);
    }

    expect(last).toContain("[cap: 4/∞]");
    expect(last).not.toContain("CUMULATIVE BUDGET EXCEEDED");
  });

  it("applies the current resumed cap to the cumulative ceiling", () => {
    const store = createSessionStore();
    const sessionID = "ses_resume_moving_ceiling";

    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("first dispatch CAP:8"),
      cfg,
      tierNames,
    );

    for (let i = 1; i <= 8; i += 1) {
      expect(readCall(store, sessionID, `${i}.ts`)).not.toContain(
        "CUMULATIVE BUDGET EXCEEDED",
      );
    }

    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("resumed dispatch CAP:2"),
      cfg,
      tierNames,
    );

    const over = readCall(store, sessionID, "nine.ts");
    expect(over).toContain("[cap: 1/2]");
    expect(over).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 9/6 across 2 dispatches");
  });

  it("behaves sanely with a tiny cap of 1", () => {
    const store = createSessionStore();
    const sessionID = "ses_resume_tiny";

    for (let round = 1; round <= 4; round += 1) {
      store.registerFromChatMessage(
        { agent: "fast", sessionID },
        dispatch(`round ${round} CAP:1`),
        cfg,
        tierNames,
      );
      const banner = readCall(store, sessionID, `tiny-${round}.ts`);
      expect(banner).toContain("[cap: 1/1]");
      expect(banner).toContain("⚠ CAP REACHED (1/1)");
      // Ceiling is 1 x 3 = 3; the 4th cumulative read trips it.
      if (round <= 3) {
        expect(banner).not.toContain("CUMULATIVE BUDGET EXCEEDED");
      } else {
        expect(banner).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 4/3 across 4 dispatches");
      }
    }
  });
});

describe("createSessionStore — resume redundancy fingerprints", () => {
  it("preserves seen fingerprints across same-tier resume", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "medium", sessionID: "ses_resume_seen" },
      dispatch("inspect CAP:3"),
      cfg,
      tierNames,
    );
    expect(readCall(store, "ses_resume_seen", "same.ts")).not.toContain("REDUNDANT");

    store.registerFromChatMessage(
      { agent: "medium", sessionID: "ses_resume_seen" },
      dispatch("resume inspect CAP:3"),
      cfg,
      tierNames,
    );

    const repeated = readCall(store, "ses_resume_seen", "same.ts");
    expect(repeated).toContain("[cap: 1/3]");
    expect(repeated).toContain("⚠ REDUNDANT");
    expect(repeated).toContain("call #1");

    expect(readCall(store, "ses_resume_seen", "different.ts")).not.toContain("REDUNDANT");
  });
});

describe("createSessionStore — resume detection boundaries", () => {
  it("resets only on same-tier chat.message re-registration", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_detect" },
      dispatch("first CAP:4"),
      cfg,
      tierNames,
    );
    expect(readCall(store, "ses_resume_detect", "a.ts")).toContain("[cap: 1/4]");
    expect(readCall(store, "ses_resume_detect", "b.ts")).toContain("[cap: 2/4]");

    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_detect" },
      dispatch("resume CAP:4"),
      cfg,
      tierNames,
    );
    expect(readCall(store, "ses_resume_detect", "c.ts")).toContain("[cap: 1/4]");
  });

  it("starts fresh when the same sessionID is re-registered with a different tier", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_resume_retarget" },
      dispatch("first CAP:2"),
      cfg,
      tierNames,
    );
    expect(readCall(store, "ses_resume_retarget", "same.ts")).toContain("[cap: 1/2]");

    const retargeted = store.registerFromChatMessage(
      { agent: "heavy", sessionID: "ses_resume_retarget" },
      dispatch("retarget CAP:3"),
      cfg,
      tierNames,
    );
    expect(retargeted).toEqual({ registered: true, resumed: false });
    const repeated = readCall(store, "ses_resume_retarget", "same.ts");
    expect(repeated).toContain("[cap: 1/3]");
    expect(repeated).not.toContain("REDUNDANT");
  });

  it("distinguishes a resume from a retry: a new session gets its own counters", () => {
    const store = createSessionStore();

    store.registerFromChatMessage(
      { agent: "medium", sessionID: "ses_original" },
      dispatch("attempt CAP:2"),
      cfg,
      tierNames,
    );
    readCall(store, "ses_original", "a.ts");
    readCall(store, "ses_original", "b.ts");

    // Resume of the SAME session: cumulative accounting continues.
    const resumed = store.registerFromChatMessage(
      { agent: "medium", sessionID: "ses_original" },
      dispatch("resume CAP:2"),
      cfg,
      tierNames,
    );
    expect(resumed).toEqual({ registered: true, resumed: true });
    for (const f of ["c.ts", "d.ts", "e.ts", "f.ts"]) readCall(store, "ses_original", f);
    const cumulative = readCall(store, "ses_original", "g.ts");
    expect(cumulative).toContain("⚠ CUMULATIVE BUDGET EXCEEDED: 7/6 across 2 dispatches");

    // A retry / escalation is a NEW session: fresh dispatch, fresh cumulative.
    const retry = store.registerFromChatMessage(
      { agent: "heavy", sessionID: "ses_retry" },
      dispatch("retry after failure CAP:2"),
      cfg,
      tierNames,
    );
    expect(retry).toEqual({ registered: true, resumed: false });
    // Same file as the original session: no cross-session fingerprint bleed.
    const retryBanner = readCall(store, "ses_retry", "a.ts");
    expect(retryBanner).toContain("[cap: 1/2]");
    expect(retryBanner).not.toContain("REDUNDANT");
    expect(retryBanner).not.toContain("CUMULATIVE BUDGET EXCEEDED");
  });

  it("treats a re-registration after idle eviction as a fresh session", () => {
    let clock = 1_000;
    const store = createSessionStore({ now: () => clock });
    const sessionID = "ses_resume_evicted";

    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("first CAP:2"),
      cfg,
      tierNames,
    );
    readCall(store, sessionID, "same.ts");
    const beforeEviction = readCall(store, sessionID, "same.ts");
    expect(beforeEviction).toContain("[cap: 2/2]");
    expect(beforeEviction).toContain("⚠ REDUNDANT");

    // Idle past the TTL, then sweep: Phase-2 eviction drops all state.
    clock += DEFAULT_IDLE_TTL_MS + 1;
    store.sweep(clock);
    expect(store.isSubagent(sessionID)).toBe(false);
    expect(store.getTier(sessionID)).toBeNull();

    const afterEviction = store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("post-eviction CAP:2"),
      cfg,
      tierNames,
    );
    // Not a resume: dispatches restart at 1 and `seen` is empty.
    expect(afterEviction).toEqual({ registered: true, resumed: false });
    const fresh = readCall(store, sessionID, "same.ts");
    expect(fresh).toContain("[cap: 1/2]");
    expect(fresh).not.toContain("REDUNDANT");
    expect(fresh).not.toContain("CUMULATIVE BUDGET EXCEEDED");
  });

  it("does not corrupt counters when the same session is resumed twice in a row", () => {
    const store = createSessionStore();
    const sessionID = "ses_resume_twice";

    store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("first CAP:3"),
      cfg,
      tierNames,
    );
    readCall(store, sessionID, "a.ts");

    // Two back-to-back registrations with no tool call in between (the hook
    // can fire twice for one logical resume).
    const r1 = store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("resume one CAP:3"),
      cfg,
      tierNames,
    );
    const r2 = store.registerFromChatMessage(
      { agent: "fast", sessionID },
      dispatch("resume two CAP:3"),
      cfg,
      tierNames,
    );
    expect(r1).toEqual({ registered: true, resumed: true });
    expect(r2).toEqual({ registered: true, resumed: true });

    const banner = readCall(store, sessionID, "b.ts");
    // calls restarted at 1; cumulative is 2 (not double-counted, not lost).
    expect(banner).toContain("[cap: 1/3]");
    expect(banner).not.toContain("CUMULATIVE BUDGET EXCEEDED");

    for (let i = 0; i < 8; i += 1) readCall(store, sessionID, `filler-${i}.ts`);
    const over = readCall(store, sessionID, "final.ts");
    expect(over).toContain("across 3 dispatches");
  });

  it("returns unregistered for non-tier agents and recordToolCall remains a no-op for unknown sessions", () => {
    const store = createSessionStore();
    const ignored = store.registerFromChatMessage(
      { agent: "builder", sessionID: "ses_not_tier" },
      dispatch("not a tier"),
      cfg,
      tierNames,
    );
    expect(ignored).toEqual({ registered: false, resumed: false });

    const out: Record<string, unknown> = { output: "RESULT" };
    store.recordToolCall({ sessionID: "missing", tool: "read", args: { file_path: "x.ts" } }, out);
    expect(out.output).toBe("RESULT");
  });

  it("never throws on malformed or empty registration input", () => {
    const store = createSessionStore();

    expect(() =>
      store.registerFromChatMessage({ sessionID: "ses_no_agent" }, dispatch("x"), cfg, tierNames),
    ).not.toThrow();
    expect(
      store.registerFromChatMessage({ agent: "", sessionID: "ses_empty_agent" }, dispatch("x"), cfg, tierNames),
    ).toEqual({ registered: false, resumed: false });
    expect(
      store.registerFromChatMessage({ agent: "fast", sessionID: "" }, undefined, cfg, tierNames),
    ).toEqual({ registered: true, resumed: false });
    // Empty sessionID is still a key: a second same-tier message resumes it.
    expect(
      store.registerFromChatMessage({ agent: "fast", sessionID: "" }, null, cfg, tierNames),
    ).toEqual({ registered: true, resumed: true });
    expect(() =>
      store.registerFromChatMessage({ agent: "fast", sessionID: "ses_junk" }, { parts: "nope" }, cfg, tierNames),
    ).not.toThrow();
  });
});
