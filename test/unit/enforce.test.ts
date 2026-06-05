import { describe, it, expect } from "vitest";
import {
  formatScorecard,
  guardBeforeCall,
  buildGuardPolicy,
  type GuardStoreLike,
} from "../../src/guard/enforce";
import { newGuardState, type GuardState, type GuardPolicy } from "../../src/guard/guards";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Minimal RouterConfig stubs — no file I/O required
// ---------------------------------------------------------------------------

const baseCfg: RouterConfig = {
  activePreset: "default",
  presets: {
    default: {
      fast: { model: "m", description: "fast tier", whenToUse: [] },
    },
  },
  rules: [],
  defaultTier: "fast",
};

const enforcedCfg: RouterConfig = {
  ...baseCfg,
  enforcement: {
    mode: "enforced",
    guard: { blockSelfScript: true, budget: 100 },
  },
};

// ---------------------------------------------------------------------------
// In-memory GuardStoreLike factory
// ---------------------------------------------------------------------------

function makeStore(): { store: GuardStoreLike; notes: Map<string, string> } {
  const states = new Map<string, GuardState>();
  const notes = new Map<string, string>();
  const store: GuardStoreLike = {
    ensure(id: string, policy: GuardPolicy): GuardState {
      if (!states.has(id)) states.set(id, newGuardState(policy));
      return states.get(id)!;
    },
    get(id: string) {
      return states.get(id);
    },
    setPendingNote(id: string, note: string) {
      notes.set(id, note);
    },
    takePendingNote(id: string) {
      const n = notes.get(id);
      notes.delete(id);
      return n;
    },
  };
  return { store, notes };
}

// ---------------------------------------------------------------------------
// formatScorecard
// ---------------------------------------------------------------------------

describe("formatScorecard", () => {
  it("contains all required labelled fields", () => {
    const policy = buildGuardPolicy(baseCfg, "fast");
    const state = newGuardState(policy);
    state.toolCallCount = 4;
    state.readCount = 2;
    state.execCount = 1;
    const s = formatScorecard(state, "fast");
    expect(s).toContain("tier=fast");
    expect(s).toContain("tool_calls=4");
    expect(s).toContain("read:exec=2:1");
    expect(s).toContain("stop=none");
    expect(s).toContain("ttfa=n/a");
    expect(s).toContain("blocks=");
    expect(s).toContain("self_scripts=");
  });

  it("reflects ttfa when set", () => {
    const state = newGuardState(buildGuardPolicy(baseCfg, "fast"));
    state.ttfa = 3;
    expect(formatScorecard(state, "fast")).toContain("ttfa=3");
  });

  it("reflects lastBlock when set", () => {
    const state = newGuardState(buildGuardPolicy(baseCfg, "fast"));
    state.lastBlock = "self_script";
    expect(formatScorecard(state, "fast")).toContain("stop=self_script");
  });

  it("handles null tier as '?'", () => {
    const state = newGuardState(buildGuardPolicy(baseCfg, null));
    expect(formatScorecard(state, null)).toContain("tier=?");
  });
});

// ---------------------------------------------------------------------------
// Trivial downgrade in guardBeforeCall
// The self_script trigger: bash tool with node -e matches INLINE_SCRIPT_RE.
// ---------------------------------------------------------------------------

const selfScriptArgs = { command: "node -e 'process.exit(0)'" };

describe("guardBeforeCall — trivial downgrade", () => {
  it("enforced + trivial:false => block:true for self_script call", () => {
    const { store } = makeStore();
    const result = guardBeforeCall({
      cfg: enforcedCfg,
      tier: "fast",
      sessionID: "ses_td_1",
      tool: "bash",
      toolArgs: selfScriptArgs,
      store,
      env: {},
      trivial: false,
    });
    expect(result.block).toBe(true);
  });

  it("enforced + trivial:true => downgraded to advisory, no block, pending note set", () => {
    const { store, notes } = makeStore();
    const result = guardBeforeCall({
      cfg: enforcedCfg,
      tier: "fast",
      sessionID: "ses_td_2",
      tool: "bash",
      toolArgs: selfScriptArgs,
      store,
      env: {},
      trivial: true,
    });
    expect(result.block).toBe(false);
    expect(result.mode).toBe("advisory");
    expect(notes.get("ses_td_2")).toBeDefined();
  });

  it("enforced + trivial:true + trivialBypass:false => still enforced (opt-out)", () => {
    const cfgNoBypass: RouterConfig = {
      ...enforcedCfg,
      enforcement: {
        ...enforcedCfg.enforcement,
        proportional: { trivialBypass: false },
      },
    };
    const { store } = makeStore();
    const result = guardBeforeCall({
      cfg: cfgNoBypass,
      tier: "fast",
      sessionID: "ses_td_3",
      tool: "bash",
      toolArgs: selfScriptArgs,
      store,
      env: {},
      trivial: true,
    });
    expect(result.block).toBe(true);
  });

  it("off mode returns immediately without touching store", () => {
    const offCfg: RouterConfig = {
      ...baseCfg,
      enforcement: { mode: "off" },
    };
    const { store, notes } = makeStore();
    const result = guardBeforeCall({
      cfg: offCfg,
      tier: "fast",
      sessionID: "ses_td_4",
      tool: "bash",
      toolArgs: selfScriptArgs,
      store,
      env: {},
    });
    expect(result.block).toBe(false);
    expect(result.mode).toBe("off");
    expect(store.get("ses_td_4")).toBeUndefined();
    expect(notes.size).toBe(0);
  });
});
