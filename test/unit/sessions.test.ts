import { describe, it, expect } from "vitest";
import {
  parseCapDirective,
  buildCapBanner,
  createSessionStore,
  DEFAULT_TIER_CAPS,
  type SubagentState,
  type Cap,
} from "../../src/router/sessions";
import type { RouterConfig } from "../../src/router/config";

describe("parseCapDirective", () => {
  it("parses CAP:none (with/without space, any case) → 'none'", () => {
    expect(parseCapDirective("CAP:none")).toBe("none");
    expect(parseCapDirective("CAP: none")).toBe("none");
    expect(parseCapDirective("cap:NONE")).toBe("none");
  });
  it("parses positive integers", () => {
    expect(parseCapDirective("use CAP:5 please")).toBe(5);
    expect(parseCapDirective("cap:3")).toBe(3);
  });
  it("returns null for zero, negatives, non-numeric, and absent", () => {
    expect(parseCapDirective("CAP:0")).toBeNull();
    expect(parseCapDirective("CAP:-1")).toBeNull();
    expect(parseCapDirective("CAP:abc")).toBeNull();
    expect(parseCapDirective("no directive here")).toBeNull();
  });
});

function st(partial: Partial<SubagentState> & { cap: Cap; calls: number }): SubagentState {
  return { tierName: "fast", seen: new Map(), ...partial };
}

describe("buildCapBanner", () => {
  it("emits the cap line with numeric cap", () => {
    const b = buildCapBanner(st({ cap: 8, calls: 1 }), false, undefined, "read");
    expect(b).toContain("[cap: 1/8]");
    expect(b).not.toContain("CAP REACHED");
    expect(b).not.toContain("CAP WARNING");
  });
  it("renders ∞ for cap 'none' and never warns/blocks", () => {
    const b = buildCapBanner(st({ cap: "none", calls: 99 }), false, undefined, "read");
    expect(b).toContain("[cap: 99/∞]");
    expect(b).not.toContain("CAP REACHED");
    expect(b).not.toContain("CAP WARNING");
  });
  it("adds a REDUNDANT line citing the previous call #", () => {
    const b = buildCapBanner(st({ cap: 8, calls: 3 }), true, 1, "grep");
    expect(b).toContain("⚠ REDUNDANT");
    expect(b).toContain("grep");
    expect(b).toContain("call #1");
  });
  it("adds CAP REACHED when no calls remain", () => {
    const b = buildCapBanner(st({ cap: 8, calls: 8 }), false, undefined, "read");
    expect(b).toContain("⚠ CAP REACHED (8/8)");
  });
  it("adds CAP WARNING when 1–2 calls remain", () => {
    expect(buildCapBanner(st({ cap: 8, calls: 7 }), false, undefined, "read")).toContain("1 read-only call");
    expect(buildCapBanner(st({ cap: 8, calls: 6 }), false, undefined, "read")).toContain("2 read-only call");
  });
});

const cfg = {
  tierCaps: { fast: 8, medium: 5, heavy: 3 },
} as unknown as RouterConfig;
const tierNames = ["fast", "medium", "heavy"];

function dispatch(text: string) {
  return { parts: [{ text }] };
}

describe("createSessionStore", () => {
  it("starts with no tracked sessions", () => {
    const store = createSessionStore();
    expect(store.isSubagent("ses_x")).toBe(false);
  });

  it("ignores messages whose agent is not a tier name", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "build", sessionID: "ses_a" }, dispatch("work"), cfg, tierNames);
    expect(store.isSubagent("ses_a")).toBe(false);
  });

  it("tracks a subagent session dispatched to a tier agent", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "fast", sessionID: "ses_b" }, dispatch("do recon"), cfg, tierNames);
    expect(store.isSubagent("ses_b")).toBe(true);
  });

  it("recordToolCall is a no-op for untracked sessions", () => {
    const store = createSessionStore();
    const out: Record<string, unknown> = { output: "RESULT" };
    store.recordToolCall({ sessionID: "ses_unknown", tool: "read", args: { file_path: "a" } }, out);
    expect(out.output).toBe("RESULT");
  });

  it("appends a cap banner to read-only tool output, preserving existing text", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "fast", sessionID: "ses_c" }, dispatch("recon"), cfg, tierNames);
    const out: Record<string, unknown> = { output: "RESULT" };
    store.recordToolCall({ sessionID: "ses_c", tool: "read", args: { file_path: "a.ts" } }, out);
    expect(out.output).toContain("RESULT\n\n");
    expect(out.output).toContain("[cap: 1/8]");
  });

  it("ignores non-read-only tools (e.g. edit) for tracked sessions", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "fast", sessionID: "ses_d" }, dispatch("recon"), cfg, tierNames);
    const out: Record<string, unknown> = { output: "EDITED" };
    store.recordToolCall({ sessionID: "ses_d", tool: "edit", args: { file_path: "a.ts" } }, out);
    expect(out.output).toBe("EDITED");
  });

  it("honors a CAP:N override from the dispatch text", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "fast", sessionID: "ses_e" }, dispatch("tight lookup CAP:2"), cfg, tierNames);
    const o1: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_e", tool: "read", args: { file_path: "a.ts" } }, o1);
    expect(o1.output).toContain("[cap: 1/2]");
    const o2: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_e", tool: "read", args: { file_path: "b.ts" } }, o2);
    expect(o2.output).toContain("⚠ CAP REACHED (2/2)");
  });

  it("flags a redundant identical read", () => {
    const store = createSessionStore();
    store.registerFromChatMessage({ agent: "medium", sessionID: "ses_f" }, dispatch("recon"), cfg, tierNames);
    const o1: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_f", tool: "read", args: { file_path: "same.ts" } }, o1);
    expect(o1.output).not.toContain("REDUNDANT");
    const o2: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_f", tool: "read", args: { file_path: "same.ts" } }, o2);
    expect(o2.output).toContain("⚠ REDUNDANT");
    expect(o2.output).toContain("call #1");
  });

  it("falls back to DEFAULT_TIER_CAPS when cfg has no tierCaps", () => {
    const store = createSessionStore();
    const bareCfg = {} as unknown as RouterConfig;
    store.registerFromChatMessage({ agent: "heavy", sessionID: "ses_g" }, dispatch("design"), bareCfg, tierNames);
    const out: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_g", tool: "read", args: { file_path: "a.ts" } }, out);
    expect(out.output).toContain(`/${DEFAULT_TIER_CAPS.heavy}]`);
  });

  // --- extractDispatchText shape coverage: the CAP override only resolves if the
  // dispatch text was extracted from that payload shape, so the banner cap proves it. ---
  it("extracts dispatch text from a raw string part", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_h" },
      { parts: ["please keep it tight CAP:4"] },
      cfg,
      tierNames,
    );
    const out: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_h", tool: "read", args: { file_path: "a.ts" } }, out);
    expect(out.output).toContain("[cap: 1/4]");
  });

  it("extracts dispatch text from a part's `content` field", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_i" },
      { parts: [{ content: "scoped lookup CAP:6" }] },
      cfg,
      tierNames,
    );
    const out: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_i", tool: "read", args: { file_path: "a.ts" } }, out);
    expect(out.output).toContain("[cap: 1/6]");
  });

  it("falls back to message.content when parts yield no text", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_j" },
      { parts: [{ irrelevant: true }], message: { content: "do it CAP:7" } },
      cfg,
      tierNames,
    );
    const out: Record<string, unknown> = {};
    store.recordToolCall({ sessionID: "ses_j", tool: "read", args: { file_path: "a.ts" } }, out);
    expect(out.output).toContain("[cap: 1/7]");
  });
});

describe("createSessionStore — getTier", () => {
  it("returns the tier name after registerFromChatMessage for a tier agent", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "fast", sessionID: "ses_tier1" },
      dispatch("explore the repo"),
      cfg,
      tierNames,
    );
    expect(store.getTier("ses_tier1")).toBe("fast");
  });

  it("returns the tier name for a heavy agent", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "heavy", sessionID: "ses_tier2" },
      dispatch("architecture review"),
      cfg,
      tierNames,
    );
    expect(store.getTier("ses_tier2")).toBe("heavy");
  });

  it("returns null for an unknown / unregistered session", () => {
    const store = createSessionStore();
    expect(store.getTier("unknown-session")).toBeNull();
  });

  it("returns null for a session registered via a non-tier agent", () => {
    const store = createSessionStore();
    store.registerFromChatMessage(
      { agent: "unknown-agent", sessionID: "ses_tier3" },
      dispatch("do something"),
      cfg,
      tierNames,
    );
    expect(store.getTier("ses_tier3")).toBeNull();
  });
});