import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { v2Instructions } from "../../src/compat/v2-hooks";
import {
  findProjectOverride,
  invalidateConfigCache,
  loadConfig,
  resolveRouting,
} from "../../src/router/config";
import type { RouterConfig, RouterHost } from "../../src/router/config";
import { buildDelegationProtocol, buildTaskTaxonomy } from "../../src/router/protocol";
import { decide } from "../../src/routing/engine/kernel";
import { buildLadder, resolveChosen } from "../../src/routing/engine/ladders";
import { MIN_EVIDENCE_TO_MOVE, generateTaxonomy } from "../../src/routing/engine/protocol-line";
import type { EngineStoreView, HostAgentInfo } from "../../src/routing/engine/types";
import type { Need } from "../../src/routing/classify/types";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import type { OutcomeKey } from "../../src/routing/outcomes/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_NEEDS: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
const HAIKU = "anthropic/claude-haiku-4-5";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 0.P.3 (phase-0P.md) `R:` line hash, identical for every shipped preset. */
const R_HASH = "5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452";

const D2: Readonly<Record<string, { raw: string; rawChars: number; v2: string; v2Chars: number }>> = {
  anthropic: {
    raw: "ee7e33eed9ee3068bc8eb9f2a7492abaed6c428bbf10372bba51f2e92d152af2",
    rawChars: 3249,
    v2: "aa24cbbf7e558c4f9bd8130fe378a1cdee12e9e9bafef684f57fa4ba9bc59817",
    v2Chars: 3249,
  },
  "hybrid-2": {
    raw: "392ff439845c7c96d3f6728111f50c69e4f46315e79db0c4a252507a402a6d33",
    rawChars: 3288,
    v2: "10c2437a28b312f6745512fa6ca69867808b1d2efe897e0e6bb3b0235381370b",
    v2Chars: 3288,
  },
};

let savedHome: string | undefined;
let savedUserProfile: string | undefined;
let tmpHome: string;

beforeEach(() => {
  savedHome = process.env.HOME;
  savedUserProfile = process.env.USERPROFILE;
  tmpHome = mkdtempSync(join(tmpdir(), "omr-engine-protocol-"));
  mkdirSync(tmpHome, { recursive: true });
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  invalidateConfigCache();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserProfile;
  rmSync(tmpHome, { recursive: true, force: true });
  invalidateConfigCache();
});

/** The shipped `tiers.json` under an empty HOME, with `activePreset` forced. */
function shipped(activePreset: string, routing?: RouterConfig["routing"]): RouterConfig {
  const cfg = loadConfig(ROOT);
  expect(cfg.activeMode).toBe("normal");
  return { ...cfg, activePreset, ...(routing === undefined ? {} : { routing }) };
}

function tierAgents(): HostAgentInfo[] {
  return ["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false, permitted: true, grants: ALL_NEEDS }));
}

function native(id: string, model: string | null, grants: readonly Need[], over: Partial<HostAgentInfo> = {}): HostAgentInfo {
  return { id, ...(model === null ? {} : { model }), mode: "subagent", hidden: false, permitted: true, grants, ...over };
}

const EXPLORE = native("explore", HAIKU, ["web"]);
const GENERAL = native("general", "anthropic/claude-sonnet-5-5", ["shell", "web", "edit", "network"]);
const AGENTS: HostAgentInfo[] = [...tierAgents(), EXPLORE, GENERAL];

function taxonomy(cfg: RouterConfig, host: RouterHost, store: EngineStoreView | null, agents: readonly HostAgentInfo[] | null = AGENTS): string {
  return generateTaxonomy({ cfg, routing: resolveRouting(cfg, host), host, store, agents });
}

// ---------------------------------------------------------------------------
// D2 — byte identity with the shipped protocol
// ---------------------------------------------------------------------------

describe("D2 snapshot: raw protocol text (0.P.3)", () => {
  it("the shipped config has no project override on this worktree", () => {
    expect(findProjectOverride(ROOT)).toBeUndefined();
  });

  for (const preset of Object.keys(D2)) {
    it(`${preset}: buildDelegationProtocol and the R: line hash like phase 0.P.3`, () => {
      const cfg = shipped(preset);
      const protocol = buildDelegationProtocol(cfg);
      expect(sha256(protocol)).toBe(D2[preset]!.raw);
      expect(protocol).toHaveLength(D2[preset]!.rawChars);
      expect(sha256(buildTaskTaxonomy(cfg))).toBe(R_HASH);
    });
  }
});

describe("D2 snapshot: v2-adapted protocol text", () => {
  for (const preset of Object.keys(D2)) {
    it(`${preset}: v2Instructions(buildDelegationProtocol) hashes as recorded in the 1.4 design`, () => {
      const cfg = shipped(preset);
      const v2 = v2Instructions(buildDelegationProtocol(cfg));
      expect(sha256(v2)).toBe(D2[preset]!.v2);
      expect(v2).toHaveLength(D2[preset]!.v2Chars);
      expect(v2).toContain('subagent(agent="fast"|"medium"|"heavy", prompt="...")');
      expect(v2).toContain("(several subagent calls in one message)");
      expect(v2).not.toContain("Task(");
      expect(v2).not.toContain("subagent_type");
    });
  }
});

describe("D2 degenerate case: no evidence ⇒ the generated line IS the shipped line", () => {
  const stores: ReadonlyArray<readonly [string, () => EngineStoreView | null]> = [
    ["no store", () => null],
    ["an empty store", () => createOutcomeStore()],
  ];
  const modes: ReadonlyArray<readonly [string, RouterHost, RouterConfig["routing"]]> = [
    ["v2 with routing.roles = {}", "v2", { roles: {} }],
    ["v2 with the D12 default roles", "v2", undefined],
    ["v1 without routing", "v1", undefined],
  ];

  for (const preset of Object.keys(D2)) {
    for (const [storeName, makeStore] of stores) {
      for (const [modeName, host, routing] of modes) {
        it(`${preset} / ${storeName} / ${modeName}`, () => {
          const cfg = shipped(preset, routing);
          const base = buildTaskTaxonomy(cfg);
          const generated = taxonomy(cfg, host, makeStore());
          expect(generated).toBe(base);
          expect(sha256(generated)).toBe(R_HASH);

          // The 2.2 seam: swap the generated line into the protocol; both texts stay byte-identical.
          const protocol = buildDelegationProtocol(cfg);
          const swapped = protocol.replace(base, generated);
          expect(sha256(swapped)).toBe(D2[preset]!.raw);
          expect(sha256(v2Instructions(swapped))).toBe(D2[preset]!.v2);
          expect(protocol.split("\n").find((line) => line.startsWith("R:"))).toBe(generated);
        });
      }
    }
  }

  it("priors alone never move a class, even when the kernel would switch (margin 0)", () => {
    const cfg = shipped("anthropic", { margin: 0 });
    const routing = resolveRouting(cfg, "v2");
    // Not vacuous: on priors alone the kernel itself switches `implement` away from medium at margin 0.
    const facts = { class: "implement", risk: "medium", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } as const;
    const decision = decide({
      facts,
      chosen: resolveChosen({ cfg, agents: AGENTS, agent: "medium" })!,
      ladder: buildLadder({ cfg, routing, facts, agents: AGENTS }),
      detection: "none",
      pin: false,
      routing,
      store: createOutcomeStore(),
    });
    expect(decision.switched).toBe(true);
    expect(taxonomy(cfg, "v2", createOutcomeStore())).toBe(buildTaskTaxonomy(cfg));
  });
});

// ---------------------------------------------------------------------------
// Evidence moves a class
// ---------------------------------------------------------------------------

const FAST_KEY = "search|router:fast|anthropic/claude-sonnet-5-5#low" as OutcomeKey;
const EXPLORE_KEY = `search|host:explore|${HAIKU}#default` as OutcomeKey;

function storeWith(passesOnExplore: number, failsOnFast: number) {
  const store = createOutcomeStore();
  for (let i = 0; i < passesOnExplore; i++) store.recordVerdict(EXPLORE_KEY, "pass", { attemptID: `e${i}`, step: "dispatch" });
  for (let i = 0; i < failsOnFast; i++) store.recordVerdict(FAST_KEY, "fail", { attemptID: `f${i}`, step: "dispatch" });
  return store;
}

describe("evidence moves search to explore when listed in roles", () => {
  const roles = { search: ["explore"] };

  it("≥ 5 strong outcomes move the class; the suffix follows the unchanged R: line", () => {
    const cfg = shipped("anthropic", { roles });
    const base = buildTaskTaxonomy(cfg);
    const store = storeWith(20, 20);
    expect(store.posterior(EXPLORE_KEY).n).toBeGreaterThanOrEqual(MIN_EVIDENCE_TO_MOVE);
    expect(taxonomy(cfg, "v2", store)).toBe(`${base} | by class: search→@explore`);
  });

  it("the evidence gate: the same winner with fewer than 5 effective outcomes leaves the line static", () => {
    const cfg = shipped("anthropic", { roles });
    expect(MIN_EVIDENCE_TO_MOVE).toBe(5);
    const base = buildTaskTaxonomy(cfg);
    // Four passes on explore and nothing else: explore is cheaper but has n = 4 < 5.
    expect(taxonomy(cfg, "v2", storeWith(4, 0))).toBe(base);
  });

  it("the same store without roles, or on v1, or without agents, keeps the line", () => {
    const store = storeWith(20, 20);
    const noRoles = shipped("anthropic", { roles: {} });
    expect(taxonomy(noRoles, "v2", store)).toBe(buildTaskTaxonomy(noRoles));
    const configured = shipped("anthropic", { roles });
    expect(taxonomy(configured, "v1", store)).toBe(buildTaskTaxonomy(configured) + " | by class: search→@explore"); // v1 prose comes from roles, not the store
    expect(taxonomy(configured, "v1", null)).toBe(taxonomy(configured, "v1", store));
    // Agents unavailable: the role candidate cannot exist, so nothing can move.
    expect(taxonomy(configured, "v2", store, null)).toBe(buildTaskTaxonomy(configured));
  });

  it("a role agent that cannot cover the class needs never moves it", () => {
    const cfg = shipped("anthropic", { roles: { mechanical: ["explore"] } });
    // mechanical implies `edit`, which explore (web only) does not grant.
    const store = createOutcomeStore();
    const key = `mechanical|host:explore|${HAIKU}#default` as OutcomeKey;
    for (let i = 0; i < 30; i++) store.recordVerdict(key, "pass", { attemptID: `m${i}`, step: "dispatch" });
    expect(taxonomy(cfg, "v2", store)).toBe(buildTaskTaxonomy(cfg));
  });

  it("an empty taskPatterns config yields `R: by class: …` only when a class moves", () => {
    const cfg = { ...shipped("anthropic", { roles }), taskPatterns: {} };
    expect(taxonomy(cfg, "v2", createOutcomeStore())).toBe("");
    expect(taxonomy(cfg, "v2", storeWith(20, 20))).toBe("R: by class: search→@explore");
  });
});

// ---------------------------------------------------------------------------
// v1 roles prose
// ---------------------------------------------------------------------------

describe("v1 roles line", () => {
  const roles = { review: ["general"], search: ["explore", "build", "ghost"], implement: [] as string[] };
  const agents: HostAgentInfo[] = [
    native("explore", HAIKU, ["web"]),
    native("general", null, ["shell"]),
    native("build", "anthropic/claude-sonnet-5-5", ALL_NEEDS, { mode: "primary" }),
  ];

  it("lists the available agents per class in TASK_CLASSES order, skipping empty classes and primary/hidden/unknown agents", () => {
    const cfg = shipped("anthropic", { roles });
    expect(taxonomy(cfg, "v1", null, agents)).toBe(`${buildTaskTaxonomy(cfg)} | by class: search→@explore review→@general`);
  });

  it("hidden, unpermitted or reserved destinations drop out; no agents ⇒ no line", () => {
    const cfg = shipped("anthropic", { roles });
    const hidden = agents.map((a) => (a.id === "explore" ? { ...a, hidden: true } : a));
    expect(taxonomy(cfg, "v1", null, hidden)).toBe(`${buildTaskTaxonomy(cfg)} | by class: review→@general`);
    const denied = agents.map((a) => (a.id === "general" ? { ...a, permitted: false } : a));
    expect(taxonomy(cfg, "v1", null, denied)).toBe(`${buildTaskTaxonomy(cfg)} | by class: search→@explore`);
    expect(taxonomy(cfg, "v1", null, null)).toBe(buildTaskTaxonomy(cfg));
    expect(taxonomy(shipped("anthropic", { roles: { search: ["build", "plan"] } }), "v1", null, agents)).toBe(buildTaskTaxonomy(cfg));
  });

  it("several destinations of one class are joined with `/`", () => {
    const cfg = shipped("anthropic", { roles: { search: ["explore", "general"] } });
    expect(taxonomy(cfg, "v1", null, agents)).toBe(`${buildTaskTaxonomy(cfg)} | by class: search→@explore/@general`);
  });

  it("without configured roles (rolesSource none) the v1 line is the shipped one", () => {
    const cfg = shipped("anthropic");
    expect(resolveRouting(cfg, "v1").applied.rolesSource).toBe("none");
    expect(taxonomy(cfg, "v1", null, agents)).toBe(buildTaskTaxonomy(cfg));
  });

  it("never reads the store on v1", () => {
    const cfg = shipped("anthropic", { roles });
    const reads: string[] = [];
    const spy: EngineStoreView = {
      posterior: (key) => {
        reads.push(key);
        throw new Error("v1 must not read the store");
      },
      cost: () => {
        throw new Error("v1 must not read the store");
      },
      classTokenProfile: () => {
        throw new Error("v1 must not read the store");
      },
    };
    expect(taxonomy(cfg, "v1", spy, agents)).toContain("by class: search→@explore");
    expect(reads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("deterministic ordering", () => {
  it("equal inputs give equal strings; the roles key order does not matter", () => {
    const a = shipped("anthropic", { roles: { review: ["general"], search: ["explore"], debug: ["general"] } });
    const b = shipped("anthropic", { roles: { debug: ["general"], search: ["explore"], review: ["general"] } });
    const first = taxonomy(a, "v1", null);
    expect(taxonomy(a, "v1", null)).toBe(first);
    expect(taxonomy(b, "v1", null)).toBe(first);
    expect(first).toBe(`${buildTaskTaxonomy(a)} | by class: search→@explore debug→@general review→@general`);
    const store = storeWith(20, 20);
    expect(taxonomy(a, "v2", store)).toBe(taxonomy(a, "v2", store));
  });

  it("never emits a trailing or a double space", () => {
    const cfg = shipped("anthropic", { roles: { search: ["explore"], review: ["general"] } });
    for (const text of [taxonomy(cfg, "v1", null), taxonomy(cfg, "v2", storeWith(20, 20))]) {
      expect(text).not.toMatch(/ {2}/);
      expect(text).toBe(text.trimEnd());
    }
  });
});
