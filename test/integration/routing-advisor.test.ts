/**
 * Phase 2.4 (M8): the cost doctor — findings, the `/router` section and the throttled notice.
 *
 * The findings tests run `runAdvisor` over configs built from the shipped `tiers.json` and hand-made host catalogs and
 * agent lists (pure, no host). Nothing here touches the real user directories: HOME and the temp directory are
 * redirected by the test setup, and every state directory is a fresh temp directory.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { validateConfig } from "../../src/router/config";
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
