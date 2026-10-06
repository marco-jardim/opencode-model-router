/**
 * Phase 2.4 (M8): the cost doctor — findings, the `/router` section and the throttled notice.
 *
 * The findings tests run `runAdvisor` over configs built from the shipped `tiers.json` and hand-made host catalogs and
 * agent lists (pure, no host). Nothing here touches the real user directories: HOME and the temp directory are
 * redirected by the test setup, and every state directory is a fresh temp directory.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, validateConfig } from "../../src/router/config";
import { DECISIONS_FILE, acquireOutcomes, makeKey } from "../../src/routing/outcomes";
import type { DecisionRow } from "../../src/routing/outcomes";
import { readLastCheckpoint } from "../../src/routing/commands/stats";
import type { RouterConfig, TierConfig } from "../../src/router/config";
import { buildEscalatePolicy } from "../../src/escalate/ladder";
import {
  cheapestToolModel,
  formatFindings,
  formatNotice,
  hostConfigFromAgents,
  noticeWorthy,
  runAdvisor,
} from "../../src/routing/advisor";
import type { AdvisorCatalogModel, Finding, FindingId, HostConfigView } from "../../src/routing/advisor";

const here = dirname(fileURLToPath(import.meta.url));
const shipped: Record<string, unknown> = JSON.parse(readFileSync(join(here, "../../tiers.json"), "utf-8"));

const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

interface CfgOver {
  readonly preset?: string;
  readonly presets?: Record<string, Record<string, Partial<TierConfig>>>;
  /** `undefined` = no routing block at all. */
  readonly routing?: Record<string, unknown>;
  readonly escalate?: Record<string, unknown>;
}

function cfgOf(over: CfgOver = {}): RouterConfig {
  const raw = structuredClone(shipped) as Record<string, unknown>;
  const presets = raw.presets as Record<string, Record<string, unknown>>;
  for (const [name, preset] of Object.entries(over.presets ?? {})) {
    presets[name] = Object.fromEntries(
      Object.entries(preset).map(([tier, config]) => [tier, { description: "test tier", whenToUse: ["testing"], ...config }]),
    );
  }
  raw.activePreset = over.preset ?? "anthropic";
  if (over.routing !== undefined) raw.routing = over.routing;
  if (over.escalate !== undefined) {
    const enforcement = raw.enforcement as Record<string, unknown>;
    enforcement.escalate = { ...(enforcement.escalate as Record<string, unknown>), ...over.escalate };
  }
  return validateConfig(raw);
}

const OWNER: Record<string, Partial<TierConfig>> = {
  fast: { model: SONNET, variant: "low", costRatio: 1 },
  medium: { model: SONNET, variant: "medium", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};

function model(ref: string, over: Partial<AdvisorCatalogModel> = {}): AdvisorCatalogModel {
  const [providerID, ...rest] = ref.split("/");
  return {
    providerID: providerID!,
    id: rest.join("/"),
    enabled: true,
    status: "active",
    capabilities: { tools: true },
    variants: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    limit: { context: 1_000_000, output: 64_000 },
    ...over,
  };
}

const CATALOG: AdvisorCatalogModel[] = [model(SONNET), model(OPUS, { cost: [{ input: 15, output: 75, cache: { read: 1.5, write: 18 } }] })];

const noHost: HostConfigView = { agents: [] };
const hostWith = (...agents: Array<Record<string, unknown>>): HostConfigView => hostConfigFromAgents(agents);
const TITLE_SUMMARY = hostWith(
  { id: "title", mode: "primary", hidden: true },
  { id: "summary", mode: "primary", hidden: true },
);

function ids(findings: readonly Finding[]): FindingId[] {
  return findings.map((f) => f.id);
}
function find(findings: readonly Finding[], id: FindingId, subject?: string): Finding | undefined {
  return findings.find((f) => f.id === id && (subject === undefined || f.subject === subject));
}

// ---------------------------------------------------------------------------
// Title / summary models and the cheapest-model suggestion (F4, A2)
// ---------------------------------------------------------------------------

describe("cost doctor: title and summary models", () => {
  const cheap = model("opencode-go/deepseek-v4.1-flash", { cost: [{ input: 0.15, output: 0.6, cache: { read: 0, write: 0 } }] });

  it("fires for each unset model and suggests the cheapest priced, enabled, tool-capable model of the catalog", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [...CATALOG, cheap]);
    const title = find(findings, "title-model-unset", "title");
    const summary = find(findings, "summary-model-unset", "summary");
    expect(title?.severity).toBe("saving");
    expect(title?.snippet).toBe(JSON.stringify({ agents: { title: { model: "opencode-go/deepseek-v4.1-flash" } } }));
    expect(summary?.snippet).toBe(JSON.stringify({ agents: { summary: { model: "opencode-go/deepseek-v4.1-flash" } } }));
    expect(title?.message).toContain("subscription provider"); // D6: opencode-go prices are relative weights
  });

  it("clears when the host agent has a model, per agent", () => {
    const set = hostWith({ id: "title", mode: "primary", hidden: true, model: { providerID: "openai", id: "gpt-6-luna", variant: "low" } }, { id: "summary", mode: "primary", hidden: true });
    const findings = runAdvisor(cfgOf({ routing: {} }), set, [...CATALOG, cheap]);
    expect(find(findings, "title-model-unset")).toBeUndefined();
    expect(find(findings, "summary-model-unset")).toBeDefined();
  });

  it("says nothing about an agent the host does not list, and nothing at all without an agent list", () => {
    expect(ids(runAdvisor(cfgOf({ routing: {} }), noHost, [...CATALOG, cheap])).filter((id) => id.endsWith("model-unset"))).toEqual([]);
    expect(ids(runAdvisor(cfgOf({ routing: {} }), null, [...CATALOG, cheap])).filter((id) => id.endsWith("model-unset"))).toEqual([]);
  });

  it("ignores models without tool calls, unpriced, all-zero priced, disabled and deprecated ones", () => {
    const cheaper = [
      model("x/no-tools", { capabilities: { tools: false }, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/no-capabilities", { capabilities: null, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/unpriced", { cost: [] }),
      model("x/zero", { cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }),
      model("x/disabled", { enabled: false, cost: [{ input: 0.02, output: 0.02, cache: { read: 0, write: 0 } }] }),
      model("x/enabled-unset", { enabled: undefined as unknown as boolean, cost: [{ input: 0.02, output: 0.02, cache: { read: 0, write: 0 } }] }),
      model("x/old", { status: "deprecated", cost: [{ input: 0.03, output: 0.03, cache: { read: 0, write: 0 } }] }),
    ];
    const pick = cheapestToolModel([...cheaper, ...CATALOG, cheap]);
    expect(pick?.ref).toBe("opencode-go/deepseek-v4.1-flash");
    expect(cheapestToolModel(cheaper)).toBeNull();
  });

  it("with no usable model it still reports the finding but suggests nothing", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [model("x/unpriced", { cost: [] })]);
    const title = find(findings, "title-model-unset");
    expect(title?.snippet).toBeNull();
    expect(title?.message).toContain("no enabled, priced model");
  });

  it("with an unknown catalog it does not claim the catalog is empty and suggests nothing", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, null);
    const title = find(findings, "title-model-unset");
    expect(title?.snippet).toBeNull();
    expect(title?.message).toContain("unavailable");
  });

  it("never suggests a model that is not in the catalog it was given (randomised catalogs)", () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 200; round += 1) {
      const catalog = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, n) =>
        model(`p${Math.floor(next() * 3)}/m${n}`, {
          enabled: next() > 0.3,
          status: next() > 0.8 ? "deprecated" : "active",
          capabilities: next() > 0.4 ? { tools: next() > 0.3 } : null,
          cost: next() > 0.3 ? [{ input: Math.floor(next() * 20) / 4, output: Math.floor(next() * 40) / 4, cache: { read: 0, write: 0 } }] : [],
        }),
      );
      const pick = cheapestToolModel(catalog);
      if (pick === null) continue;
      const entry = catalog.find((m) => `${m.providerID}/${m.id}` === pick.ref);
      expect(entry).toBeDefined();
      expect(entry?.enabled).toBe(true);
      expect(entry?.capabilities?.tools).toBe(true);
      expect(entry?.status).not.toBe("deprecated");
      expect(pick.price).toBeGreaterThan(0);
      for (const other of catalog) {
        if (other.enabled !== true || other.status === "deprecated" || other.capabilities?.tools !== true) continue;
        const entryPrice = other.cost as Array<{ input: number; output: number }>;
        if (entryPrice.length === 0 || (entryPrice[0]!.input === 0 && entryPrice[0]!.output === 0)) continue;
        expect(entryPrice[0]!.input + entryPrice[0]!.output).toBeGreaterThanOrEqual(pick.price);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ladder against the catalog (QA-1.1-9)
// ---------------------------------------------------------------------------

describe("cost doctor: ladder rungs against the catalog", () => {
  const owner = (over: CfgOver = {}): RouterConfig => cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {}, ...over });

  it("a catalog that matches the ladder yields no catalog finding", () => {
    const findings = runAdvisor(owner(), noHost, CATALOG);
    expect(ids(findings).filter((id) => ["model-not-in-catalog", "no-tool-support", "variant-not-offered", "effort-not-offered"].includes(id))).toEqual([]);
  });

  it("model-not-in-catalog fires for a missing, disabled or deprecated model and clears when it is there", () => {
    expect(find(runAdvisor(owner(), noHost, [CATALOG[0]!]), "model-not-in-catalog", "heavy")).toBeDefined();
    expect(find(runAdvisor(owner(), noHost, [CATALOG[0]!, { ...CATALOG[1]!, enabled: false }]), "model-not-in-catalog", "heavy")?.message).toContain("not enabled or deprecated");
    expect(find(runAdvisor(owner(), noHost, CATALOG), "model-not-in-catalog")).toBeUndefined();
  });

  it("no-tool-support fires for a rung whose model has no tool calls", () => {
    const findings = runAdvisor(owner(), noHost, [CATALOG[0]!, { ...CATALOG[1]!, capabilities: { tools: false } }]);
    expect(find(findings, "no-tool-support", "heavy")?.severity).toBe("warning");
  });

  it("variant-not-offered fires for a variant the model lacks (and for a candidate rung's variant), never for an omitted one", () => {
    const lacking = runAdvisor(owner(), noHost, [model(SONNET, { variants: [{ id: "high" }] }), CATALOG[1]!]);
    expect(find(lacking, "variant-not-offered", "fast")?.message).toContain("only high");
    expect(find(lacking, "variant-not-offered", "medium")).toBeDefined();
    const withCandidate = cfgOf({
      preset: "tst",
      presets: { tst: { ...OWNER, medium: { ...OWNER.medium!, candidates: [{ variant: "medium", costRatio: 5 }, { variant: "turbo", costRatio: 8 }] } } },
      routing: {},
    });
    expect(find(runAdvisor(withCandidate, noHost, CATALOG), "variant-not-offered", "medium")?.message).toContain("turbo");
    const bare = cfgOf({ preset: "tst", presets: { tst: { fast: { model: SONNET, costRatio: 1 }, medium: { model: SONNET, costRatio: 5 }, heavy: OWNER.heavy! } }, routing: {} });
    expect(find(runAdvisor(bare, noHost, [model(SONNET, { variants: [] }), CATALOG[1]!]), "variant-not-offered")).toBeUndefined();
  });

  it("effort-not-offered is informational and fires only when the catalog lists variants without that effort", () => {
    const efforts = cfgOf({ preset: "tst", presets: { tst: { fast: { model: SONNET, effort: "low", costRatio: 1 }, medium: OWNER.medium!, heavy: OWNER.heavy! } }, routing: {} });
    expect(find(runAdvisor(efforts, noHost, CATALOG), "effort-not-offered")).toBeUndefined();
    const narrow = runAdvisor(efforts, noHost, [model(SONNET, { variants: [{ id: "high" }, { id: "max" }] }), CATALOG[1]!]);
    expect(find(narrow, "effort-not-offered", "fast")?.severity).toBe("info");
  });

  it("every catalog check stays silent when the catalog is unknown or empty", () => {
    for (const catalog of [null, []] as const) {
      const findings = runAdvisor(owner(), noHost, catalog);
      expect(ids(findings).filter((id) => ["model-not-in-catalog", "no-tool-support", "variant-not-offered", "unpriced-model"].includes(id))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Variant ladders (1.5 handoffs, A20, F5)
// ---------------------------------------------------------------------------

describe("cost doctor: variant ladders", () => {
  it("variant-effort fires for every bundled-preset tier that sets variant and effort (QA-2.3-13) and matches the runner's own policy", () => {
    const cfg = cfgOf({ preset: "anthropic", routing: {} });
    const findings = runAdvisor(cfg, noHost, CATALOG);
    const flagged = findings.filter((f) => f.id === "variant-effort").map((f) => f.subject).sort();
    const policy = buildEscalatePolicy(cfg, { host: "v2", variantSteps: "auto", catalog: (m) => CATALOG.find((c) => `${c.providerID}/${c.id}` === m) ?? null });
    const effortTiers = Object.entries(policy.variants?.perTier ?? {}).filter(([, info]) => info.effortConfigured === true).map(([name]) => name).sort();
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged).toEqual(effortTiers); // the advisor and the ladder agree on which tiers lose their variant steps
    const medium = find(findings, "variant-effort", "medium");
    expect(medium?.severity).toBe("warning");
    expect(medium?.message).toContain("candidates");
    expect(medium?.message).toContain("Drop the effort");
    const snippet = JSON.parse(medium?.snippet ?? "null") as { presets: Record<string, Record<string, { candidates: Array<{ variant: string; costRatio?: number }> }>> };
    const candidates = snippet.presets.anthropic!.medium!.candidates;
    expect(candidates[0]).toEqual({ variant: "medium", costRatio: 5 }); // the tier's own rung first (a list without it is ignored)
    expect(candidates.slice(1).map((c) => c.variant)).toEqual(["high", "xhigh", "max"]);
  });

  it("clears without effort on the tier, and does not fire without a routing block (variant steps are then off)", () => {
    const noEffort = cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {} });
    expect(find(runAdvisor(noEffort, noHost, CATALOG), "variant-effort")).toBeUndefined();
    const withoutRouting = cfgOf({ preset: "anthropic" });
    expect(find(runAdvisor(withoutRouting, noHost, CATALOG), "variant-effort")).toBeUndefined();
    const explicitNone = cfgOf({ preset: "anthropic", routing: {}, escalate: { variantSteps: "none" } });
    expect(find(runAdvisor(explicitNone, noHost, CATALOG), "variant-effort")).toBeUndefined();
  });

  it("reports rejected candidates, candidates on another model and tiers covered by a variant ladder", () => {
    const cfg = cfgOf({
      preset: "tst",
      presets: {
        tst: {
          fast: { model: SONNET, variant: "low", costRatio: 1, candidates: [{ variant: "low", costRatio: 1 }, { variant: "turbo", costRatio: 2 }, { model: OPUS, variant: "high", costRatio: 9 }] },
          medium: OWNER.medium!,
          heavy: OWNER.heavy!,
        },
      },
      routing: {},
    });
    const findings = runAdvisor(cfg, noHost, CATALOG);
    expect(find(findings, "rejected-candidates", "fast")?.message).toContain("turbo");
    expect(find(findings, "foreign-candidates", "fast")?.message).toContain(`${OPUS}#high`);
    // medium's base (sonnet#medium) is covered by what fast's variant ladder reaches: fast has candidates low only, so nothing
    expect(find(findings, "covered-tier", "medium")).toBeUndefined();
    const catalogLadder = runAdvisor(cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {} }), noHost, CATALOG);
    expect(find(catalogLadder, "covered-tier", "medium")?.message).toContain("#xhigh");
  });

  it("variant-ladder-budget fires when a tier's variant steps reach maxTotalAttempts - 1 and clears with a larger budget", () => {
    const base = cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {} });
    const fired = find(runAdvisor(base, noHost, CATALOG), "variant-ladder-budget", "fast");
    expect(fired?.severity).toBe("info");
    expect(fired?.message).toContain("low → medium → high → xhigh");
    const roomy = cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {}, escalate: { maxTotalAttempts: 8 } });
    expect(find(runAdvisor(roomy, noHost, CATALOG), "variant-ladder-budget")).toBeUndefined();
  });

  it("attempts-without-variants fires with variantSteps none and one attempt per tier, and clears otherwise", () => {
    const none = cfgOf({ preset: "tst", presets: { tst: OWNER }, escalate: { variantSteps: "none", maxAttemptsPerTier: 1 } });
    expect(find(runAdvisor(none, noHost, CATALOG), "attempts-without-variants")?.snippet).toBe(JSON.stringify({ enforcement: { escalate: { variantSteps: "auto" } } }));
    const twice = cfgOf({ preset: "tst", presets: { tst: OWNER }, escalate: { variantSteps: "none", maxAttemptsPerTier: 2 } });
    expect(find(runAdvisor(twice, noHost, CATALOG), "attempts-without-variants")).toBeUndefined();
    const auto = cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {} });
    expect(find(runAdvisor(auto, noHost, CATALOG), "attempts-without-variants")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pricing, roles, tier agents, classifier model
// ---------------------------------------------------------------------------

describe("cost doctor: pricing, roles and agents", () => {
  const owner = (over: CfgOver = {}): RouterConfig => cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {}, ...over });

  it("unpriced-model lists the ladder's unpriced models and clears when they are priced", () => {
    const unpriced = [model(SONNET, { cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }), model(OPUS, { cost: [] })];
    const finding = find(runAdvisor(owner(), noHost, unpriced), "unpriced-model");
    expect(finding?.severity).toBe("info");
    expect(finding?.subject).toBe(`${SONNET}, ${OPUS}`);
    expect(finding?.message).toContain("costRatio");
    expect(find(runAdvisor(owner(), noHost, CATALOG), "unpriced-model")).toBeUndefined();
  });

  it("subscription-pricing fires when a ladder model's provider is a subscription provider", () => {
    const sub = cfgOf({ preset: "tst", presets: { tst: { ...OWNER, fast: { model: "github-copilot/gpt-6-luna", costRatio: 1 } } }, routing: {} });
    const catalog = [...CATALOG, model("github-copilot/gpt-6-luna")];
    expect(find(runAdvisor(sub, noHost, catalog), "subscription-pricing")?.subject).toBe("github-copilot");
    expect(find(runAdvisor(owner(), noHost, CATALOG), "subscription-pricing")).toBeUndefined();
  });

  it("native-role-unmatched-rung fires for a role agent whose model is no rung, only with a live engine", () => {
    const host = hostWith({ id: "explore", mode: "subagent", hidden: false, model: { providerID: "anthropic", id: "claude-haiku-4-5" } });
    const shadow = owner({ routing: { engine: "shadow" } });
    const finding = find(runAdvisor(shadow, host, CATALOG), "native-role-unmatched-rung", "explore");
    expect(finding?.message).toContain("anthropic/claude-haiku-4-5");
    expect(finding?.message).toContain("tier fast");
    expect(find(runAdvisor(owner({ routing: { engine: "static" } }), host, CATALOG), "native-role-unmatched-rung")).toBeUndefined();
    const matching = hostWith({ id: "explore", mode: "subagent", hidden: false, model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" } });
    expect(find(runAdvisor(shadow, matching, CATALOG), "native-role-unmatched-rung")).toBeUndefined();
    const noModel = hostWith({ id: "explore", mode: "subagent", hidden: false });
    expect(find(runAdvisor(shadow, noModel, CATALOG), "native-role-unmatched-rung")).toBeUndefined();
  });

  it("tier-agent-unavailable fires for a tier the host does not offer as a subagent, and clears when it does", () => {
    const missing = hostWith({ id: "fast", mode: "subagent", hidden: false }, { id: "medium", mode: "subagent", hidden: false }, { id: "build", mode: "primary", hidden: false });
    const findings = runAdvisor(owner(), missing, CATALOG);
    expect(find(findings, "tier-agent-unavailable", "heavy")?.message).toContain("agent-unavailable");
    expect(find(findings, "tier-agent-unavailable", "fast")).toBeUndefined();
    const hidden = hostWith({ id: "fast", mode: "subagent", hidden: true }, { id: "medium", mode: "subagent", hidden: false }, { id: "heavy", mode: "primary", hidden: false });
    expect(find(runAdvisor(owner(), hidden, CATALOG), "tier-agent-unavailable", "fast")?.message).toContain("hidden");
    expect(find(runAdvisor(owner(), hidden, CATALOG), "tier-agent-unavailable", "heavy")?.message).toContain("primary");
    const all = hostWith(...["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false })));
    expect(find(runAdvisor(owner(), all, CATALOG), "tier-agent-unavailable")).toBeUndefined();
    expect(find(runAdvisor(owner(), noHost, CATALOG), "tier-agent-unavailable")).toBeUndefined();
  });

  it("classifier-model-missing fires only for the host backend whose model the catalog lacks", () => {
    const missing = owner({ routing: { classifier: { backend: "host", model: "openai/gpt-6-luna#low", timeoutMs: 1000 } } });
    expect(find(runAdvisor(missing, noHost, CATALOG), "classifier-model-missing")?.subject).toBe("openai/gpt-6-luna#low");
    const present = runAdvisor(missing, noHost, [...CATALOG, model("openai/gpt-6-luna")]);
    expect(find(present, "classifier-model-missing")).toBeUndefined();
    const http = owner({ routing: { classifier: { backend: "openai-compatible", model: "ollama/llama3", baseUrl: "http://localhost:11434/v1" } } });
    expect(find(runAdvisor(http, noHost, CATALOG), "classifier-model-missing")).toBeUndefined();
    expect(find(runAdvisor(owner(), noHost, CATALOG), "classifier-model-missing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure policy and rendering
// ---------------------------------------------------------------------------

describe("cost doctor: failure policy and rendering", () => {
  it("a throwing check is logged and skipped, the other checks still run, nothing is thrown", () => {
    const poisoned = model("x/poison", {});
    Object.defineProperty(poisoned, "capabilities", { get: () => { throw new Error("catalog getter exploded"); } });
    const warn = vi.fn();
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [...CATALOG, poisoned], { warn });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain("check side-models failed");
    expect(JSON.stringify(warn.mock.calls[0]![1])).toContain("exploded");
    expect(find(findings, "variant-effort")).toBeDefined(); // a later check still ran
    expect(() => runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [...CATALOG, poisoned])).not.toThrow(); // and with no logger
  });

  it("findings are sorted warning, saving, info", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [...CATALOG, model("x/cheap", { cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] })]);
    const order = findings.map((f) => f.severity);
    expect(order).toEqual([...order].sort((a, b) => ["warning", "saving", "info"].indexOf(a) - ["warning", "saving", "info"].indexOf(b)));
    expect(new Set(order).size).toBeGreaterThan(1);
  });

  it("formatFindings renders a header, one line per finding and the fix snippet, and says what was skipped", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_SUMMARY, [...CATALOG, model("x/cheap", { cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] })]);
    const lines = formatFindings(findings);
    expect(lines[0]).toMatch(/^Cost doctor: \d+ findings? \(\d+ warning, \d+ saving, \d+ info\)$/);
    expect(lines.some((l) => l.startsWith("  [saving] title-model-unset (title): "))).toBe(true);
    expect(lines).toContain(`      fix: ${JSON.stringify({ agents: { title: { model: "x/cheap" } } })}`);
    expect(formatFindings([])).toEqual(["Cost doctor: no findings."]);
    expect(formatFindings([], { hostKnown: false, catalogKnown: false })[0]).toContain("agent list and model catalog were unavailable");
    expect(formatFindings([], { hostKnown: true, catalogKnown: false })[0]).toContain("model catalog was unavailable");
  });

  it("the notice is one line, mentions /router, and exists only when a warning or a saving does", () => {
    const warning: Finding = { id: "variant-effort", severity: "warning", subject: "medium", message: "x".repeat(400), snippet: null };
    const info: Finding = { id: "unpriced-model", severity: "info", subject: "", message: "just so you know", snippet: null };
    expect(noticeWorthy([info])).toBe(false);
    expect(formatNotice([info])).toBeNull();
    expect(noticeWorthy([info, warning])).toBe(true);
    const notice = formatNotice([info, warning]);
    expect(notice).not.toBeNull();
    expect(notice).not.toContain("\n");
    expect(notice).toContain("/router");
    expect(notice!.length).toBeLessThan(400);
    expect(notice).toContain("1 finding worth a look (1 warning, 0 saving)");
  });

  it("hostConfigFromAgents reads id, model reference, mode and hidden, and skips junk", () => {
    const view = hostConfigFromAgents([
      { id: "title", mode: "primary", hidden: true },
      { id: "explore", mode: "subagent", model: { providerID: "anthropic", id: "claude-haiku-4-5", variant: "high" } },
      { mode: "subagent" },
      null,
      "x",
    ]);
    expect(view.agents).toEqual([
      { id: "title", model: null, mode: "primary", hidden: true },
      { id: "explore", model: "anthropic/claude-haiku-4-5#high", mode: "subagent", hidden: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// /router stats and the checkpoint line (2.4.5, D18)
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "routing-stats.ts");
const KEY_MEDIUM = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");
const KEY_EXPLORE = makeKey("search", { origin: "host", id: "explore" }, "anthropic", "claude-haiku-4-5");

function choiceOf(key: string, agent: string, origin: "router" | "host", model: string) {
  return { key: key as DecisionRow["chosen"]["key"], agent, origin, model, variant: "default" };
}

function decisionRow(id: string, ts: string, over: Partial<DecisionRow> = {}): DecisionRow {
  return {
    v: 1,
    kind: "decision",
    ts,
    sessionID: "s1",
    decisionID: id,
    mode: "shadow",
    childSessionID: null,
    facts: { class: "implement", risk: "low", scope: "single", needs: ["edit"], confidence: 0.9, source: "rules" },
    chosen: choiceOf(KEY_MEDIUM, "medium", "router", "anthropic/claude-sonnet-5-5"),
    best: choiceOf(KEY_EXPLORE, "explore", "host", "anthropic/claude-haiku-4-5"),
    switched: true,
    pinned: false,
    unit: "ratio",
    costs: { [KEY_MEDIUM]: 5, [KEY_EXPLORE]: 2 },
    confidence: 0.7,
    reason: "switched: cheaper",
    step: "dispatch",
    resume: false,
    ...over,
  };
}

describe("/router stats and the checkpoint line", () => {
  type Hooks = { "command.execute.before"(input: unknown, output: { parts: Array<{ text: string }> }): Promise<void>; dispose(): Promise<void> };
  let home: string;
  let store: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Hooks[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "router-stats-"));
    store = join(home, "store");
    mkdirSync(store, { recursive: true });
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    invalidateConfigCache();
  });

  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  async function plugin(routing: Record<string, unknown> | null, host: "v2" | "v1" = "v2"): Promise<Hooks> {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify(routing === null ? {} : { routing }));
    invalidateConfigCache();
    const ctx = { directory: home, worktree: home, client: {}, ...(host === "v2" ? { routerHost: "v2" as const } : {}) };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as Hooks;
    instances.push(hooks);
    return hooks;
  }

  const ask = async (hooks: Hooks, args: string): Promise<string> => {
    const out = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router", arguments: args }, out);
    return out.parts[0]?.text ?? "";
  };

  const script = (...args: string[]) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000 });
    return { stdout: result.stdout, stderr: result.stderr, status: result.status };
  };

  function seed(...rows: DecisionRow[]): void {
    writeFileSync(join(store, DECISIONS_FILE), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  const ROWS = [
    decisionRow("D0", "2026-10-05T10:00:00.000Z"), // before the window
    decisionRow("D1", "2026-10-06T10:00:00.000Z", { reason: "kept:evidence: the cheapest option needs 5 outcomes", switched: false, trace: { routeLines: { count: 0, conflict: false, edgeOnly: true }, backend: null, argmin: choiceOf(KEY_EXPLORE, "explore", "host", "anthropic/claude-haiku-4-5") } }),
    decisionRow("D2", "2026-10-06T11:00:00.000Z", { resume: true }),
  ];

  it("prints exactly the stdout of scripts/routing-stats.ts for the same store and window", async () => {
    seed(...ROWS);
    const hooks = await plugin({ engine: "shadow", outcomes: { path: store } });
    const since = "2026-10-06T00:00:00Z";
    const reference = script("--dir", store, "--since", since);
    expect(reference.status).toBe(0);
    const text = await ask(hooks, `stats --since ${since}`);
    expect(`${text}\n`).toBe(reference.stdout);
    expect(text).toContain("| Dispatches | 2 |"); // D0 is outside the window
    expect(text).toContain("| Kept for lack of evidence (A27) | 1 of 2 routed dispatches |");
    expect(text).toContain("| Orchestrator resumes (task_id / sessionID; not a ladder step) | 1 of 2 routed dispatches |");
    expect(text).toContain(`| ${KEY_EXPLORE.replace(/\|/g, "\\|")} | 1 |`); // the trace.argmin table (A27, DF3)
    expect(text).toContain("cover trusted classes only"); // QA-2.1-10
    // no window: all three rows; and the JSON form is the script's too
    expect(`${await ask(hooks, "stats")}\n`).toBe(script("--dir", store).stdout);
    expect(`${await ask(hooks, "stats --json")}\n`).toBe(script("--dir", store, "--json").stdout);
  });

  it("flushes the rows still queued in memory first, so the table is current", async () => {
    seed(ROWS[1]!);
    const hooks = await plugin({ engine: "shadow", outcomes: { path: store } });
    const bundle = acquireOutcomes({ dir: store, tuning: {}, logger: { warn: () => undefined } });
    try {
      await bundle.ready;
      bundle.flusher.enqueue(decisionRow("Q1", "2026-10-06T12:00:00.000Z"));
      expect(bundle.flusher.pendingRows).toBe(1);
      const text = await ask(hooks, "stats");
      expect(text).toContain("| Dispatches | 2 |");
      expect(bundle.flusher.pendingRows).toBe(0);
    } finally {
      await bundle.release();
    }
  });

  it("static: reads the directory without creating or quarantining anything, and --dir overrides the configured store", async () => {
    seed(ROWS[1]!, ROWS[2]!);
    const before = readdirSync(store).sort();
    const hooks = await plugin(null); // no routing block: the engine is static
    const text = await ask(hooks, `stats --dir ${store}`);
    expect(text).toContain("| Dispatches | 2 |");
    expect(readdirSync(store).sort()).toEqual(before); // read-only: no outcomes.json, no temp files
    expect(`${text}\n`).toBe(script("--dir", store).stdout);
  });

  it("a usage error comes back as the script prints it, and an empty store says so", async () => {
    const hooks = await plugin({ engine: "shadow", outcomes: { path: store } });
    const bad = await ask(hooks, "stats --bogus");
    expect(bad).toContain("routing-stats: unknown argument: --bogus");
    expect(bad).toContain("Usage: node scripts/routing-stats.ts");
    const empty = await ask(hooks, "stats");
    expect(empty).toContain("| Dispatches | 0 |");
    expect(empty).toContain(`routing-stats: no outcome data in ${store}`);
    const dir = join(home, "elsewhere");
    expect(await ask(hooks, `stats --dir ${dir}`)).toContain("routing-stats: no outcome data in");
  });

  it("works on a v1 host too (read-only over the configured directory)", async () => {
    seed(ROWS[1]!);
    const hooks = await plugin({ outcomes: { path: store } }, "v1");
    expect(await ask(hooks, "stats")).toContain("| Dispatches | 1 |");
    expect(readdirSync(store)).toEqual([DECISIONS_FILE]);
  });

  it("the help lists /router stats, and the bare /router shows the marker and the last checkpoint", async () => {
    const hooks = await plugin({ engine: "shadow", outcomes: { path: store } });
    const bare = await ask(hooks, "");
    expect(bare).toContain("`/router stats [--since <ISO>]`");
    expect(bare).toMatch(/^router: engine=shadow build=\S+\+\S+$/m);
    expect(bare).toMatch(/^router: last checkpoint=DF\d+$/m);
  });

  it("readLastCheckpoint takes the last `## DF<n>` heading, and is null without a record", () => {
    const root = join(home, "plugin");
    mkdirSync(join(root, "docs", "qa", "cost-aware-routing"), { recursive: true });
    expect(readLastCheckpoint(() => root)).toBeNull();
    writeFileSync(join(root, "docs", "qa", "cost-aware-routing", "dogfood.md"), "# Dogfood\n\n## DF0 — baseline\n\ntext ## DF9 not a heading\n\n## DF1 — after wave 1\n\n### DF7 sub\n\n## DF2 — after phase 2.2\n\n## Summary\n");
    expect(readLastCheckpoint(() => root)).toBe("DF2");
    expect(readLastCheckpoint(() => { throw new Error("no root"); })).toBeNull();
  });
});
