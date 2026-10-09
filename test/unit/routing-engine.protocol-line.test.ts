import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  validateConfig,
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
import { withLegacyPresets } from "../helpers/legacy-presets";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_NEEDS: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
const HAIKU = "anthropic/claude-haiku-4-5";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Issue #77: rename moved from fast to medium; all other protocol bytes retained. */
const R_HASH = "6ace4a35c29f8972a86e67e705830aaff964c78997b654c4b13a139b5b0563fe";

/**
 * The `anthropic` fast tier moved from Sonnet 5.5 to Haiku 5.5 (low). The previous D2 hashes are kept here: the lineage
 * test below proves the new protocol is the old one with only that model name changed.
 */
const ANTHROPIC_FAST_SONNET_D2 = {
  raw: "96c9fa385ca8104f72730ab9aff1d6b6d83a98c1be6c8dd857a6ed129fb38b60",
  v2: "85d07a3a46c79abc1b15caa65bfff0757912d5e33a6b8ec0deff6b81fae592b1",
  chars: 3249,
} as const;

/**
 * 2.6.0 moved the `anthropic` fast tier from Haiku 5.5 low to Haiku 5.5 medium and the medium tier from Sonnet 5.5 medium to
 * Sonnet 5.5 high. The 2.5.0 (Haiku low) D2 hashes are kept here: the lineage test below proves the current protocol is that
 * text with only these two tier tokens changed.
 */
const ANTHROPIC_FAST_HAIKU_LOW_D2 = {
  raw: "a1b84e7a68b96016cafdef434aa5fdd2d8824ad7e363fa481b4ea4f3eedff130",
  v2: "75b71b88e8dc6b2b38701015492abecb4962983374630181979fc9293ed36cc5",
  chars: 3248,
} as const;

/** The two `anthropic` tier tokens 2.6.0 changed, as `[current, 2.5.0]`. */
const ANTHROPIC_2_6_0_TIERS: ReadonlyArray<readonly [string, string]> = [
  ["@fast=claude-haiku-5-5/medium(1x)", "@fast=claude-haiku-5-5/low(1x)"],
  ["@medium=claude-sonnet-5-5/high(5x)", "@medium=claude-sonnet-5-5/medium(5x)"],
];

const D2: Readonly<Record<string, { raw: string; rawChars: number; v2: string; v2Chars: number }>> = {
  anthropic: {
    raw: "5d0a043b6c865b10563385fe4b50ca95a258cac7cd6dae477ad0ebb998c58847",
    rawChars: 3249,
    v2: "6725dbc85e24cb324dcb3edea4336aceeaa7a60fca2eb87fc75773ee8658509a",
    v2Chars: 3249,
  },
  "hybrid-2": {
    raw: "f79fde6484ae5a8f4ca64dc0b1a89910bd55e12f649f39e54e4817d770877211",
    rawChars: 3288,
    v2: "f9fd9f713f80942d01c3d23ca236164d03e72bd1d8730ab55f1d5081a19c19e0",
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
  rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  invalidateConfigCache();
});

/**
 * The shipped `tiers.json` under an empty HOME, with `activePreset` forced. `hybrid-2` left the bundled file in 2.6.0: its 2.5.0
 * block comes from the legacy fixture, validated like the bundled file, so its D2 hashes stay those of the 2.5.0 text.
 */
function shipped(activePreset: string, routing?: RouterConfig["routing"]): RouterConfig {
  const cfg = loadConfig(ROOT);
  expect(cfg.activeMode).toBe("normal");
  const presets =
    activePreset === "hybrid-2"
      ? {
          ...cfg.presets,
          "hybrid-2": validateConfig(withLegacyPresets(JSON.parse(readFileSync(join(ROOT, "tiers.json"), "utf8")), ["hybrid-2"])).presets["hybrid-2"]!,
        }
      : cfg.presets;
  return { ...cfg, presets, activePreset, ...(routing === undefined ? {} : { routing }) };
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

describe("D2 lineage: anthropic fast tier on Haiku 5.5", () => {
  it("the protocol is the 2.5.0 text with only the fast and medium tier tokens changed, and the Sonnet-era text with also the fast model name changed", () => {
    const cfg = shipped("anthropic");
    const raw = buildDelegationProtocol(cfg);
    const v2 = v2Instructions(raw);
    for (const [current] of ANTHROPIC_2_6_0_TIERS) expect(raw.split(current).length - 1).toBe(1);
    const to250 = (text: string) => ANTHROPIC_2_6_0_TIERS.reduce((t, [current, old]) => t.replace(current, old), text);
    expect(sha256(to250(raw))).toBe(ANTHROPIC_FAST_HAIKU_LOW_D2.raw);
    expect(to250(raw)).toHaveLength(ANTHROPIC_FAST_HAIKU_LOW_D2.chars);
    expect(sha256(to250(v2))).toBe(ANTHROPIC_FAST_HAIKU_LOW_D2.v2);
    expect(raw.split("claude-haiku-5-5").length - 1).toBe(1);
    const back = (text: string) => to250(text).replace("claude-haiku-5-5", "claude-sonnet-5-5");
    expect(sha256(back(raw))).toBe(ANTHROPIC_FAST_SONNET_D2.raw);
    expect(back(raw)).toHaveLength(ANTHROPIC_FAST_SONNET_D2.chars);
    expect(sha256(back(v2))).toBe(ANTHROPIC_FAST_SONNET_D2.v2);
  });
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
    ["v2 enforce with routing.roles = {}", "v2", { engine: "enforce", roles: {} }],
    ["v2 enforce with the D12 default roles", "v2", { engine: "enforce" }],
    ["v2 static (the default engine)", "v2", undefined],
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
          const swapped = protocol.replace(base, () => generated);
          expect(sha256(swapped)).toBe(D2[preset]!.raw);
          expect(sha256(v2Instructions(swapped))).toBe(D2[preset]!.v2);
          expect(protocol.split("\n").find((line) => line.startsWith("R:"))).toBe(generated);
        });
      }
    }
  }

  it("priors alone never move a class, even when the kernel would switch (margin 0)", () => {
    const cfg = shipped("anthropic", { engine: "enforce", margin: 0 });
    const routing = resolveRouting(cfg, "v2");
    // Not vacuous: on priors alone the kernel's argmin for `implement` is another rung at margin 0, and only the
    // A24 evidence gate (no recorded outcomes) keeps it from switching.
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
    expect(decision.argmin?.key).not.toBe(decision.chosen.key);
    expect(decision.best?.key).toBe(decision.chosen.key); // A27: the argmin has no recorded outcomes, so it is not `best`
    expect(decision.reasonCode).toBe("kept:evidence");
    expect(decision.switched).toBe(false);
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
  /** The engine that acts on the line (QA-1.4-5): `advise` and `enforce` only. */
  const enforce = (extra: Partial<NonNullable<RouterConfig["routing"]>> = {}): NonNullable<RouterConfig["routing"]> => ({ engine: "enforce", roles, ...extra });

  it("≥ 5 strong outcomes move the class; the suffix follows the unchanged R: line", () => {
    const cfg = shipped("anthropic", enforce());
    const base = buildTaskTaxonomy(cfg);
    const store = storeWith(20, 20);
    expect(store.posterior(EXPLORE_KEY).n).toBeGreaterThanOrEqual(MIN_EVIDENCE_TO_MOVE);
    expect(taxonomy(cfg, "v2", store)).toBe(`${base} | by class: search→@explore`);
    expect(taxonomy(shipped("anthropic", enforce({ engine: "advise" })), "v2", store)).toBe(`${base} | by class: search→@explore`);
  });

  it("QA-1.4-5: engine static or shadow never touches the protocol text, whatever the evidence", () => {
    const store = storeWith(20, 20);
    for (const engine of ["static", "shadow"] as const) {
      const cfg = shipped("anthropic", enforce({ engine }));
      expect(resolveRouting(cfg, "v2").engine).toBe(engine);
      expect(taxonomy(cfg, "v2", store)).toBe(buildTaskTaxonomy(cfg));
    }
    // The default engine (no `engine` key) is `static`.
    const defaulted = shipped("anthropic", { roles });
    expect(taxonomy(defaulted, "v2", store)).toBe(buildTaskTaxonomy(defaulted));
  });

  it("the evidence gate: the same winner with fewer than 5 effective outcomes leaves the line static", () => {
    const cfg = shipped("anthropic", enforce());
    expect(MIN_EVIDENCE_TO_MOVE).toBe(5);
    const base = buildTaskTaxonomy(cfg);
    // Four passes on explore and nothing else: explore is cheaper but has n = 4 < 5.
    expect(taxonomy(cfg, "v2", storeWith(4, 0))).toBe(base);
  });

  it("the same store without roles, or on v1, or without agents, keeps the line", () => {
    const store = storeWith(20, 20);
    const noRoles = shipped("anthropic", enforce({ roles: {} }));
    expect(taxonomy(noRoles, "v2", store)).toBe(buildTaskTaxonomy(noRoles));
    const configured = shipped("anthropic", { roles });
    expect(taxonomy(configured, "v1", store)).toBe(buildTaskTaxonomy(configured) + " | by class: search→@explore"); // v1 prose comes from roles, not the store
    expect(taxonomy(configured, "v1", null)).toBe(taxonomy(configured, "v1", store));
    // Agents unavailable: the role candidate cannot exist, so nothing can move.
    const enforced = shipped("anthropic", enforce());
    expect(taxonomy(enforced, "v2", store, null)).toBe(buildTaskTaxonomy(enforced));
  });

  it("a role agent that cannot cover the class needs never moves it", () => {
    const cfg = shipped("anthropic", enforce({ roles: { mechanical: ["explore"] } }));
    // mechanical implies `edit`, which explore (web only) does not grant.
    const store = createOutcomeStore();
    const key = `mechanical|host:explore|${HAIKU}#default` as OutcomeKey;
    for (let i = 0; i < 30; i++) store.recordVerdict(key, "pass", { attemptID: `m${i}`, step: "dispatch" });
    expect(taxonomy(cfg, "v2", store)).toBe(buildTaskTaxonomy(cfg));
  });

  it("an empty taskPatterns config yields `R: by class: …` only when a class moves", () => {
    const cfg = { ...shipped("anthropic", enforce()), taskPatterns: {} };
    expect(taxonomy(cfg, "v2", createOutcomeStore())).toBe("");
    expect(taxonomy(cfg, "v2", storeWith(20, 20))).toBe("R: by class: search→@explore");
  });

  it("QA-1.4-11: a bare `R:` base (every pattern list empty) becomes `R: by class: …`, never `R: | by class: …`", () => {
    const cfg = { ...shipped("anthropic", enforce()), taskPatterns: { fast: [] as string[], medium: [] as string[] } };
    expect(buildTaskTaxonomy(cfg)).toBe("R:");
    expect(taxonomy(cfg, "v2", createOutcomeStore())).toBe("R:");
    expect(taxonomy(cfg, "v2", storeWith(20, 20))).toBe("R: by class: search→@explore");
    expect(taxonomy({ ...cfg, routing: { roles } }, "v1", null)).toBe("R: by class: search→@explore");
  });

  it("QA-1.4-11: a function replacer substitutes the line verbatim, `$` sequences in agent ids included", () => {
    const tricky = "ex$&plo$1re$$";
    const cfg = shipped("anthropic", { roles: { search: [tricky] } });
    const agents: HostAgentInfo[] = [...tierAgents(), native(tricky, HAIKU, ["web"])];
    const generated = taxonomy(cfg, "v1", null, agents);
    expect(generated).toBe(`${buildTaskTaxonomy(cfg)} | by class: search→@${tricky}`);
    const protocol = buildDelegationProtocol(cfg);
    const base = buildTaskTaxonomy(cfg);
    // A string replacement would expand `$&` / `$1` / `$$`; the function replacer does not.
    expect(protocol.replace(base, generated)).not.toContain(generated);
    const swapped = protocol.replace(base, () => generated);
    expect(swapped).toContain(generated);
    expect(swapped.split("\n").find((line) => line.startsWith("R:"))).toBe(generated);
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
