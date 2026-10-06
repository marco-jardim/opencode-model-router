/**
 * Phase 2.4 (M8): the cost doctor — findings, the `/router` section and the throttled notice.
 *
 * The findings tests run `runAdvisor` over configs built from the shipped `tiers.json` and hand-made host catalogs and
 * agent lists (pure, no host). Nothing here touches the real user directories: HOME and the temp directory are
 * redirected by the test setup, and every state directory is a fresh temp directory.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath, routerStatusLines, validateConfig } from "../../src/router/config";
import { DECISIONS_FILE, acquireOutcomes, makeKey } from "../../src/routing/outcomes";
import type { DecisionRow } from "../../src/routing/outcomes";
import { readLastCheckpoint } from "../../src/routing/commands/stats";
import { advisorSettings, createAdvisorNotifier } from "../../src/routing/advisor";
import type { AdvisorFs, AdvisorNotifierDeps, AdvisorSettings } from "../../src/routing/advisor";
import type { RouterConfig, TierConfig } from "../../src/router/config";
import { buildEscalatePolicy } from "../../src/escalate/ladder";
import {
  HOST_SMALL_MODEL_FAMILIES,
  catalogFromProviders,
  cheapestTitleModel,
  formatFindings,
  formatNotice,
  hostConfigFromAgents,
  hostSmallModel,
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
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    limit: { context: 1_000_000, output: 64_000 },
    ...over,
  };
}

const CATALOG: AdvisorCatalogModel[] = [model(SONNET), model(OPUS, { cost: [{ input: 15, output: 75, cache: { read: 1.5, write: 18 } }] })];

const noHost: HostConfigView = { agents: [] };
const hostWith = (...agents: Array<Record<string, unknown>>): HostConfigView => hostConfigFromAgents(agents);
/** An anthropic session (priced Sonnet) whose title agent has no model; with CATALOG_CHEAP the host finds no small model for it. */
const TITLE_HOST = hostConfigFromAgents(
  [{ id: "title", mode: "primary", hidden: true }, { id: "summary", mode: "primary", hidden: true }],
  { providerID: "anthropic", modelID: "claude-sonnet-5-5" },
);
const CHEAP = model("x/cheap", { cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] });
const CATALOG_CHEAP: AdvisorCatalogModel[] = [...CATALOG, CHEAP];

function ids(findings: readonly Finding[]): FindingId[] {
  return findings.map((f) => f.id);
}
function find(findings: readonly Finding[], id: FindingId, subject?: string): Finding | undefined {
  return findings.find((f) => f.id === id && (subject === undefined || f.subject === subject));
}

// ---------------------------------------------------------------------------
// The title model and the cheapest-model suggestion (F4, A2)
// ---------------------------------------------------------------------------

describe("cost doctor: the title model (QA-2.4-1, QA-2.4-2, QA-2.4-11)", () => {
  const cheap = model("opencode-go/deepseek-v4.1-flash", { cost: [{ input: 0.15, output: 0.6, cache: { read: 0, write: 0 } }] });
  const haiku = model("anthropic/claude-haiku-4-5", { family: "claude-haiku", cost: [{ input: 1, output: 5, cache: { read: 0.1, write: 1.25 } }] });
  /** An anthropic session on a priced Sonnet; the title agent has no model of its own. */
  const host = (primary: { providerID: string; modelID: string | null } | null = { providerID: "anthropic", modelID: "claude-sonnet-5-5" }): HostConfigView =>
    hostConfigFromAgents([{ id: "title", mode: "primary", hidden: true }, { id: "summary", mode: "primary", hidden: true }], primary);
  const doctor = (catalog: AdvisorCatalogModel[], hostView: HostConfigView | null = host()) => runAdvisor(cfgOf({ routing: {} }), hostView, catalog);

  it("does NOT fire when the host's own pick finds a small model of the session's provider (a claude-haiku for an anthropic session)", () => {
    expect(find(doctor([...CATALOG, haiku, cheap]), "title-model-unset")).toBeUndefined();
    // …for each family the host looks for, in any order of the catalog
    for (const family of HOST_SMALL_MODEL_FAMILIES) {
      const small = model("anthropic/some-small", { family });
      expect(hostSmallModel([...CATALOG, small], "anthropic")?.family).toBe(family);
      expect(find(doctor([...CATALOG, small, cheap]), "title-model-unset")).toBeUndefined();
    }
  });

  it("the host's pick is by family order and by provider, and only among eligible models (enabled, active, text in and out)", () => {
    const luna = model("anthropic/lunar", { family: "gpt-luna" });
    const flash = model("anthropic/flashy", { family: "gemini-flash" });
    expect(hostSmallModel([flash, haiku, luna], "anthropic")?.id).toBe("lunar"); // gpt-luna first
    expect(hostSmallModel([haiku, flash], "anthropic")?.id).toBe("flashy"); // gemini-flash before claude-haiku
    expect(hostSmallModel([model("openai/claude-haiku-x", { family: "claude-haiku" })], "anthropic")).toBeNull(); // another provider's
    for (const broken of [
      { ...haiku, enabled: false },
      { ...haiku, status: "beta" },
      { ...haiku, status: "deprecated" },
      { ...haiku, capabilities: { tools: true, input: ["image"], output: ["text"] } },
      { ...haiku, capabilities: { tools: true, input: ["text"], output: ["image"] } },
      { ...haiku, capabilities: null },
    ]) {
      expect(hostSmallModel([broken], "anthropic"), JSON.stringify(broken.status ?? broken.capabilities)).toBeNull();
    }
    expect(hostSmallModel([model("anthropic/plain", { family: "something-else" })], "anthropic")).toBeNull();
  });

  it("fires when the host would find no small model for the session's provider, with the cheapest eligible priced model and the right target", () => {
    const findings = doctor([...CATALOG, cheap]);
    const title = find(findings, "title-model-unset", "title");
    expect(title?.severity).toBe("saving");
    expect(title?.target).toBe("host"); // QA-2.4-2: this fix is for opencode.json, not the router overrides
    expect(title?.snippet).toBe(JSON.stringify({ agents: { title: { model: "opencode-go/deepseek-v4.1-flash" } } }));
    expect(title?.snippetV1).toBe(`${JSON.stringify({ agent: { title: { model: "opencode-go/deepseek-v4.1-flash" } } })} or ${JSON.stringify({ small_model: "opencode-go/deepseek-v4.1-flash" })}`);
    expect(title?.message).toContain("finds no small model of anthropic");
    expect(title?.message).toContain("gpt-luna, gemini-flash-lite, gemini-flash, claude-haiku");
    expect(title?.message).toContain("anthropic/claude-sonnet-5-5"); // what is paid today: the session's own model
    expect(title?.message).toContain("subscription provider"); // D6: opencode-go prices are relative weights
    expect(title?.message).not.toContain("most expensive model in the session"); // the old, wrong claim
  });

  it("never reports a summary model: the host has no consumer of one", () => {
    expect(ids(doctor([...CATALOG, cheap])).filter((id) => String(id).includes("summary"))).toEqual([]);
    expect(find(doctor([...CATALOG, cheap]), "title-model-unset", "summary")).toBeUndefined();
  });

  it("stays silent when the title agent has a model, is not listed, or the session's provider or the catalog is unknown", () => {
    const set = hostConfigFromAgents([{ id: "title", mode: "primary", hidden: true, model: { providerID: "openai", id: "gpt-6-luna", variant: "low" } }], { providerID: "anthropic", modelID: "claude-sonnet-5-5" });
    expect(find(doctor([...CATALOG, cheap], set), "title-model-unset")).toBeUndefined();
    expect(find(doctor([...CATALOG, cheap], hostConfigFromAgents([], { providerID: "anthropic", modelID: "x" })), "title-model-unset")).toBeUndefined();
    expect(find(doctor([...CATALOG, cheap], host(null)), "title-model-unset")).toBeUndefined(); // the pick cannot be predicted
    expect(find(runAdvisor(cfgOf({ routing: {} }), host(), null), "title-model-unset")).toBeUndefined();
    expect(find(doctor([...CATALOG, cheap], null), "title-model-unset")).toBeUndefined();
  });

  it("claims no saving when the session's own model is already the cheapest, or when nothing priced can be suggested", () => {
    const cheapSession = [model(SONNET, { cost: [{ input: 0.1, output: 0.1, cache: { read: 0, write: 0 } }] }), model(OPUS), cheap];
    expect(find(doctor(cheapSession), "title-model-unset")).toBeUndefined();
    expect(find(doctor([model("x/unpriced", { cost: [] }), ...CATALOG.map((m) => ({ ...m, cost: [] }))]), "title-model-unset")).toBeUndefined();
  });

  it("suggests with the host's test (enabled, active, text in and out), not with tool support; skips disabled, beta, text-less and unpriced models", () => {
    const noTools = model("x/no-tools", { capabilities: { tools: false, input: ["text"], output: ["text"] }, cost: [{ input: 0.2, output: 0.2, cache: { read: 0, write: 0 } }] });
    expect(cheapestTitleModel([...CATALOG, noTools, cheap])?.ref).toBe("x/no-tools"); // tools are not needed for a title
    const ineligible = [
      model("x/disabled", { enabled: false, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/enabled-unset", { enabled: undefined as unknown as boolean, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/beta", { status: "beta", cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/old", { status: "deprecated", cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/image-out", { capabilities: { tools: true, input: ["text"], output: ["image"] }, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/no-capabilities", { capabilities: null, cost: [{ input: 0.01, output: 0.01, cache: { read: 0, write: 0 } }] }),
      model("x/unpriced", { cost: [] }),
      model("x/zero", { cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }),
    ];
    expect(cheapestTitleModel([...ineligible, ...CATALOG, cheap])?.ref).toBe("opencode-go/deepseek-v4.1-flash");
    expect(cheapestTitleModel(ineligible)).toBeNull();
  });

  it("never suggests a model that is not in the catalog it was given (randomised catalogs), and never when the host already has a small model", () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const families = [...HOST_SMALL_MODEL_FAMILIES, "other"];
    for (let round = 0; round < 300; round += 1) {
      const catalog = Array.from({ length: 1 + Math.floor(next() * 8) }, (_, n) =>
        model(`p${Math.floor(next() * 3)}/m${n}`, {
          family: families[Math.floor(next() * families.length)]!,
          enabled: next() > 0.3,
          status: next() > 0.8 ? "deprecated" : next() > 0.8 ? "beta" : "active",
          capabilities: next() > 0.4 ? { tools: next() > 0.3, input: next() > 0.2 ? ["text"] : ["image"], output: next() > 0.2 ? ["text"] : ["image"] } : null,
          cost: next() > 0.3 ? [{ input: Math.floor(next() * 20) / 4, output: Math.floor(next() * 40) / 4, cache: { read: 0, write: 0 } }] : [],
        }),
      );
      const providerID = `p${Math.floor(next() * 3)}`;
      const finding = find(runAdvisor(cfgOf({ routing: {} }), hostConfigFromAgents([{ id: "title", mode: "primary", hidden: true }], { providerID, modelID: null }), catalog), "title-model-unset");
      if (finding === undefined) continue;
      expect(hostSmallModel(catalog, providerID)).toBeNull(); // fires only when the host would find nothing
      const ref = (JSON.parse(finding.snippet ?? "null") as { agents: { title: { model: string } } }).agents.title.model;
      const entry = catalog.find((m) => `${m.providerID}/${m.id}` === ref);
      expect(entry).toBeDefined();
      expect(entry?.enabled).toBe(true);
      expect(entry?.status).toBe("active");
      expect(entry?.capabilities?.input?.some((i) => i.startsWith("text"))).toBe(true);
      expect(entry?.capabilities?.output?.some((o) => o.startsWith("text"))).toBe(true);
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
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_HOST, [...CATALOG, poisoned], { warn });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toContain("check title-model failed");
    expect(JSON.stringify(warn.mock.calls[0]![1])).toContain("exploded");
    expect(find(findings, "variant-effort")).toBeDefined(); // a later check still ran
    expect(() => runAdvisor(cfgOf({ routing: {} }), TITLE_HOST, [...CATALOG, poisoned])).not.toThrow(); // and with no logger
  });

  it("findings are sorted warning, saving, info", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_HOST, CATALOG_CHEAP);
    const order = findings.map((f) => f.severity);
    expect(order).toEqual([...order].sort((a, b) => ["warning", "saving", "info"].indexOf(a) - ["warning", "saving", "info"].indexOf(b)));
    expect(new Set(order).size).toBeGreaterThan(1);
  });

  it("formatFindings renders a header, one line per finding and the fix snippet, and says what was skipped", () => {
    const findings = runAdvisor(cfgOf({ routing: {} }), TITLE_HOST, CATALOG_CHEAP);
    const lines = formatFindings(findings);
    expect(lines[0]).toMatch(/^Cost doctor: \d+ findings? \(\d+ warning, \d+ saving, \d+ info\)$/);
    expect(lines.some((l) => l.startsWith("  [saving] title-model-unset (title): "))).toBe(true);
    expect(lines).toContain(`      fix (opencode.json): ${JSON.stringify({ agents: { title: { model: "x/cheap" } } })}`); // a host fix names the host file
    expect(lines.some((l) => l.startsWith("      v1 form (opencode.json): ") && l.includes("small_model"))).toBe(true);
    expect(lines.some((l) => l.startsWith("      fix (opencode-model-router.overrides.jsonc): "))).toBe(true); // a router fix names the overrides file
    expect(formatFindings([])).toEqual(["Cost doctor: no findings."]);
    expect(formatFindings([], { hostKnown: false, catalogKnown: false })[0]).toContain("agent list and model catalog were unavailable");
    expect(formatFindings([], { hostKnown: true, catalogKnown: false })[0]).toContain("model catalog was unavailable");
  });

  it("the notice is one line, mentions /router, and exists only when a warning or a saving does", () => {
    const warning: Finding = { id: "variant-effort", severity: "warning", target: "router", subject: "medium", message: "x".repeat(400), snippet: null, snippetV1: null, bundledTier: false, notify: true };
    const info: Finding = { id: "unpriced-model", severity: "info", target: "router", subject: "", message: "just so you know", snippet: null, snippetV1: null, bundledTier: false, notify: false };
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

  it("QA-2.4-16: an agent whose mode is not subagent, primary or all is not judged: mode is null and the agent checks stay silent", () => {
    const view = hostConfigFromAgents([{ id: "fast", mode: "weird", hidden: false }, { id: "medium", hidden: false }, { id: "explore", mode: 7, hidden: false, model: { providerID: "anthropic", id: "claude-haiku-4-5" } }]);
    expect(view.agents.map((a) => a.mode)).toEqual([null, null, null]);
    const cfgTst = cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: { engine: "shadow" } });
    const findings = runAdvisor(cfgTst, view, CATALOG);
    expect(find(findings, "tier-agent-unavailable", "fast")).toBeUndefined(); // unknown mode: not judged
    expect(find(findings, "tier-agent-unavailable", "medium")).toBeUndefined();
    expect(find(findings, "tier-agent-unavailable", "heavy")).toBeDefined(); // genuinely absent from the list
    expect(find(findings, "native-role-unmatched-rung", "explore")).toBeUndefined();
  });

  it("catalogFromProviders reads a config.providers() payload (enabled models with cost and capabilities) and rejects other shapes", () => {
    const payload = {
      providers: [
        { id: "anthropic", models: { "claude-haiku-4-5": { id: "claude-haiku-4-5", status: "active", enabled: true, family: "claude-haiku", capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, cost: [{ input: 1, output: 5, cache: { read: 0, write: 0 } }], variants: [{ id: "high" }] } } },
        { id: "p", models: { keyed: { status: "beta" }, junk: 3 } },
        { name: "no id", models: {} },
      ],
      default: {},
    };
    const catalog = catalogFromProviders(payload);
    expect(catalog?.map((m) => `${m.providerID}/${m.id}`)).toEqual(["anthropic/claude-haiku-4-5", "p/keyed"]);
    expect(catalog?.[0]).toMatchObject({ enabled: true, status: "active", family: "claude-haiku", capabilities: { tools: true, input: ["text", "image"], output: ["text"] } });
    expect(catalog?.[1]).toMatchObject({ status: "beta", capabilities: null });
    expect(hostSmallModel(catalog ?? [], "anthropic")?.id).toBe("claude-haiku-4-5"); // what the adapter hands over is enough for the host's pick
    expect(catalogFromProviders(undefined)).toBeNull();
    expect(catalogFromProviders({ providers: "x" })).toBeNull();
    expect(catalogFromProviders({ providers: [] })).toEqual([]);
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

// ---------------------------------------------------------------------------
// The throttled notice (2.4.2; reworked for QA-2.4-5, -6, -7, -8, -10)
// ---------------------------------------------------------------------------

function memoryFs(files: Map<string, string> = new Map(), options: { failWrites?: boolean; failReads?: boolean } = {}): AdvisorFs & { files: Map<string, string> } {
  return {
    files,
    async mkdirp() {},
    async readText(path) {
      if (options.failReads === true && path.endsWith("advisor-notice.json")) throw new Error("disk unreadable");
      return files.get(path) ?? null;
    },
    async writeDurable(path, data) {
      if (options.failWrites === true) throw new Error("disk full");
      files.set(path, data);
    },
    async appendText(path, data) {
      files.set(path, (files.get(path) ?? "") + data);
    },
    async rename(from, to) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
    },
    async unlink(path) {
      files.delete(path);
    },
    async stat() {
      return null;
    },
    async readdir() {
      return [];
    },
    // synchronous body: like O_EXCL, exactly one of two racing callers creates the file
    async createExclusive(path, data) {
      if (files.has(path)) return false;
      files.set(path, data);
      return true;
    },
  };
}

const HOUR = 3_600_000;
const STATE_PATH = join("/state", "advisor-notice.json");
const LOCK_PATH = join("/state", "advisor-notice.lock");
const stateOf = (fs: ReturnType<typeof memoryFs>): Record<string, unknown> => JSON.parse(fs.files.get(STATE_PATH) ?? "null") as Record<string, unknown>;

describe("cost doctor: the throttled notice (context delivery)", () => {
  const settings = (over: Partial<AdvisorSettings> = {}): AdvisorSettings => ({ dir: "/state", intervalMs: 24 * HOUR, deliver: "context", ...over });
  /** One finding that notifies: the title agent has no model and the host finds no small model. */
  const withFinding = async () => ({ host: TITLE_HOST, catalog: CATALOG_CHEAP });
  /** The same finding plus a second one, so the fingerprint differs. */
  const withTwoFindings = async () => ({
    host: TITLE_HOST,
    catalog: [model(SONNET), model(OPUS, { cost: [{ input: 15, output: 75, cache: { read: 1.5, write: 18 } }] }), CHEAP],
  });
  const without = async () => ({ host: noHost, catalog: CATALOG });
  /** A ladder whose catalog matches and carries no effort: only informational findings. */
  const QUIET_CFG = () => cfgOf({ preset: "tst", presets: { tst: OWNER }, routing: {} });

  function notifier(fs: ReturnType<typeof memoryFs>, clock: { now: number }, extra: Partial<AdvisorNotifierDeps> = {}) {
    const warn = vi.fn();
    const gather = vi.fn(extra.gather ?? withFinding);
    const instance = createAdvisorNotifier({
      settings: () => settings(),
      config: () => cfgOf({ routing: {} }),
      logger: { warn },
      now: () => clock.now,
      fs,
      sleep: async () => undefined,
      ...extra,
      gather,
    });
    return { instance, warn, gather };
  }
  /** One turn: start a check when due, wait for it, and take a pending notice. */
  async function turn(n: ReturnType<typeof notifier>): Promise<string | null> {
    n.instance.poll();
    await n.instance.settled();
    return n.instance.take();
  }

  it("fires once: the check runs in the background, the notice is handed over once, and the state records what the user was told", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const n = notifier(fs, clock);
    expect(n.instance.maybePending()).toBe(true); // the persisted state has not been read yet
    n.instance.poll();
    await n.instance.settled();
    expect(n.instance.maybePending()).toBe(true);
    expect(stateOf(fs)).toMatchObject({ version: 2, pendingFingerprint: "title-model-unset:title", lastNoticeAt: null });
    const text = await n.instance.take();
    expect(text).toContain("[model-router] Cost doctor:");
    expect(text).toMatch(/\(\d+ warning, \d+ saving\)/);
    expect(await n.instance.take()).toBeNull(); // exactly once
    expect(n.instance.maybePending()).toBe(false);
    expect(stateOf(fs)).toMatchObject({ pendingText: null, pendingFingerprint: null, noticedFingerprint: "title-model-unset:title", lastNoticeAt: "2026-10-06T12:00:00.000Z", lastRunAt: "2026-10-06T12:00:00.000Z" });
    expect(fs.files.has(LOCK_PATH)).toBe(false); // the lock is always released
    expect(n.gather).toHaveBeenCalledTimes(1);
  });

  it("QA-2.4-5: an unchanged set of findings is not announced again, a changed one is, and an unchanged one is only a weekly reminder", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const n = notifier(fs, clock);
    expect(await turn(n)).not.toBeNull();
    clock.now += 25 * HOUR; // the next check is due, nothing changed
    expect(await turn(n)).toBeNull();
    expect(n.gather).toHaveBeenCalledTimes(2);
    expect(stateOf(fs)).toMatchObject({ lastRunAt: "2026-10-07T13:00:00.000Z", lastNoticeAt: "2026-10-06T12:00:00.000Z" });
    for (let day = 0; day < 4; day += 1) {
      clock.now += 25 * HOUR;
      expect(await turn(n)).toBeNull(); // checked every day, never repeated
    }
    clock.now += 48 * HOUR; // more than 7 days after the notice: a reminder
    expect(await turn(n)).not.toBeNull();
    // a different set of findings is news, even the day after
    const changing = notifier(fs, clock, { gather: withTwoFindings, config: () => cfgOf({ routing: {} }) });
    clock.now += 25 * HOUR;
    const second = await turn(changing);
    expect(second === null || second.includes("worth a look")).toBe(true);
  });

  it("a different notice-worthy set is announced; findings that go away and come back are announced again", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    let which: () => Promise<{ host: HostConfigView | null; catalog: AdvisorCatalogModel[] | null }> = withFinding;
    const n = notifier(fs, clock, { gather: () => which(), config: () => cfgOf({ routing: {} }) });
    expect(await turn(n)).not.toBeNull();
    which = async () => ({ host: TITLE_HOST, catalog: CATALOG }); // no cheaper model any more: the title finding is gone, the effort ones are bundled
    clock.now += 25 * HOUR;
    expect(await turn(n)).toBeNull();
    expect(stateOf(fs)).toMatchObject({ noticedFingerprint: null }); // cleared: a return is a change
    which = withFinding;
    clock.now += 25 * HOUR;
    expect(await turn(n)).not.toBeNull();
  });

  it("is throttled across restarts: a new notifier over the same state neither checks nor notices inside the interval", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    expect(await turn(notifier(fs, clock))).not.toBeNull();
    clock.now += 3 * HOUR;
    const restarted = notifier(fs, clock);
    expect(await turn(restarted)).toBeNull();
    expect(restarted.gather).not.toHaveBeenCalled();
  });

  it("QA-2.4-8: a notice a process produced and never delivered is persisted and delivered by the next process at its first turn, without a host call", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const first = notifier(fs, clock);
    first.instance.poll();
    await first.instance.settled();
    expect(stateOf(fs).pendingText).toContain("Cost doctor"); // produced, not delivered: the process "dies" here
    clock.now += 5 * 60_000;
    const second = notifier(fs, clock);
    expect(second.instance.maybePending()).toBe(true);
    const text = await second.instance.take(); // the very first turn
    expect(text).toContain("Cost doctor");
    expect(second.gather).not.toHaveBeenCalled();
    expect(stateOf(fs)).toMatchObject({ pendingText: null, noticedFingerprint: "title-model-unset:title" });
    expect(await notifier(fs, clock).instance.take()).toBeNull();
  });

  it("QA-2.4-6/10: two processes never both deliver one notice, and never both produce one", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    // both decide at the same time: one pending notice results, delivered once
    const a = notifier(fs, clock);
    const b = notifier(fs, clock);
    a.instance.poll();
    b.instance.poll();
    await Promise.all([a.instance.settled(), b.instance.settled()]);
    const delivered = await Promise.all([a.instance.take(), b.instance.take(), a.instance.take(), b.instance.take()]);
    expect(delivered.filter((text) => text !== null)).toHaveLength(1);
    expect(fs.files.has(LOCK_PATH)).toBe(false);
    // a notice pending in the state: two fresh processes race to take it
    const fs2 = memoryFs();
    const first = notifier(fs2, clock);
    first.instance.poll();
    await first.instance.settled();
    const c = notifier(fs2, clock);
    const d = notifier(fs2, clock);
    const raced = await Promise.all([c.instance.take(), d.instance.take()]);
    expect(raced.filter((text) => text !== null)).toHaveLength(1);
  });

  it("a fresh lock held by another process makes this one wait (nothing decided, backed off); a stale or unreadable lock is taken over", async () => {
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const busy = memoryFs(new Map([[LOCK_PATH, String(clock.now - 1_000)]]));
    const n = notifier(busy, clock);
    n.instance.poll();
    await n.instance.settled();
    expect(busy.files.has(STATE_PATH)).toBe(false);
    expect(n.instance.maybePending()).toBe(true); // it will read the state again next time
    n.instance.poll();
    await n.instance.settled();
    expect(n.gather).toHaveBeenCalledTimes(1); // inside the 30 s back-off: no second attempt
    busy.files.delete(LOCK_PATH);
    clock.now += 60_000;
    expect(await turn(n)).not.toBeNull();
    for (const stale of [String(clock.now - 120_000), "garbage"]) {
      const fs = memoryFs(new Map([[LOCK_PATH, stale]]));
      expect(await turn(notifier(fs, clock))).not.toBeNull();
      expect(fs.files.has(LOCK_PATH)).toBe(false);
    }
  });

  it("QA-2.4-10: log mode throttles in memory only, reads and writes no file, logs a changed set and a weekly reminder", async () => {
    const fs = memoryFs();
    const read = vi.spyOn(fs, "readText");
    const write = vi.spyOn(fs, "writeDurable");
    const lock = vi.spyOn(fs, "createExclusive");
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const logged = (n: ReturnType<typeof notifier>): number => n.warn.mock.calls.filter(([m]) => String(m).startsWith("[model-router] Cost doctor:")).length;
    const n = notifier(fs, clock, { settings: () => settings({ deliver: "log" }) });
    n.instance.poll();
    await n.instance.settled();
    expect(logged(n)).toBe(1);
    expect(n.instance.maybePending()).toBe(false);
    expect(await n.instance.take()).toBeNull(); // log mode never hands a notice to the context
    clock.now += 25 * HOUR;
    n.instance.poll();
    await n.instance.settled();
    expect(logged(n)).toBe(1); // unchanged
    clock.now += 8 * 24 * HOUR;
    n.instance.poll();
    await n.instance.settled();
    expect(logged(n)).toBe(2); // weekly reminder
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(fs.files.size).toBe(0);
    const restarted = notifier(fs, clock, { settings: () => settings({ deliver: "log" }) });
    restarted.instance.poll();
    await restarted.instance.settled();
    expect(logged(restarted)).toBe(1); // memory only: a new process says it again
  });

  it("a check with nothing worth a notice persists its time, so it does not run again inside the interval", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    const quiet = notifier(fs, clock, { gather: without, config: QUIET_CFG });
    expect(await turn(quiet)).toBeNull();
    expect(stateOf(fs)).toMatchObject({ lastNoticeAt: null, noticedFingerprint: null, pendingText: null });
    clock.now += HOUR;
    expect(await turn(quiet)).toBeNull();
    expect(quiet.gather).toHaveBeenCalledTimes(1);
  });

  it("is inert when settings say so: no host call, no read, no write, no lock", async () => {
    const fs = memoryFs();
    const spies = [vi.spyOn(fs, "readText"), vi.spyOn(fs, "writeDurable"), vi.spyOn(fs, "createExclusive")];
    const { instance, gather } = notifier(fs, { now: 0 }, { settings: () => null });
    for (let i = 0; i < 3; i += 1) {
      instance.poll();
      await instance.settled();
      expect(instance.maybePending()).toBe(false);
      expect(await instance.take()).toBeNull();
    }
    expect(gather).not.toHaveBeenCalled();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("a failing host call is logged, never thrown, nothing is written, and the next try waits for the back-off", async () => {
    const fs = memoryFs();
    const clock = { now: Date.parse("2026-10-06T12:00:00Z") };
    let fail = true;
    const n = notifier(fs, clock, { backoffMs: 10 * 60_000, gather: async () => { if (fail) throw new Error("host down"); return withFinding(); } });
    n.instance.poll();
    await n.instance.settled();
    expect(n.warn.mock.calls.some(([m, extra]) => String(m).includes("the check failed") && JSON.stringify(extra).includes("host down"))).toBe(true);
    expect(fs.files.has(STATE_PATH)).toBe(false);
    clock.now += 5 * 60_000;
    n.instance.poll();
    await n.instance.settled();
    expect(n.gather).toHaveBeenCalledTimes(1); // inside the back-off
    fail = false;
    clock.now += 6 * 60_000;
    expect(await turn(n)).not.toBeNull();
    expect(n.gather).toHaveBeenCalledTimes(2);
  });

  it("an unwritable state file is logged and the notice is still delivered (once, in this process)", async () => {
    const fs = memoryFs(new Map(), { failWrites: true });
    const n = notifier(fs, { now: Date.parse("2026-10-06T12:00:00Z") });
    const text = await turn(n);
    expect(text).toContain("Cost doctor");
    expect(await n.instance.take()).toBeNull();
    expect(n.warn.mock.calls.some(([m]) => String(m).includes("could not save the notice state"))).toBe(true);
  });

  it("an unreadable state file is reported and treated as absent; a state of another version is rewritten", async () => {
    for (const content of ["{not json", JSON.stringify({ version: 1, lastRunAt: "2026-10-06T00:00:00Z", lastNoticeAt: null, fingerprint: "" })]) {
      const fs = memoryFs(new Map([[STATE_PATH, content]]));
      const n = notifier(fs, { now: Date.parse("2026-10-06T12:00:00Z") });
      expect(await turn(n)).not.toBeNull();
      expect(n.warn.mock.calls.some(([m]) => String(m).includes("unreadable or of another version"))).toBe(true);
      expect(stateOf(fs)).toMatchObject({ version: 2 });
    }
    const failing = memoryFs(new Map(), { failReads: true });
    const n = notifier(failing, { now: Date.parse("2026-10-06T12:00:00Z") });
    expect(await turn(n)).not.toBeNull(); // no coordination possible: it still delivers
    expect(n.warn.mock.calls.some(([m]) => String(m).includes("could not read the notice state"))).toBe(true);
  });

  it("advisorSettings: inactive on v1, without a routing block, with enabled or notify false; delivery follows the engine; the interval has a floor", () => {
    const env = { tmpdir: "/tmp-x", homedir: "/home-x" };
    expect(advisorSettings(cfgOf({ routing: {} }), "v1", env)).toBeNull();
    expect(advisorSettings(cfgOf(), "v2", env)).toBeNull(); // no routing block: today's behaviour, byte for byte
    expect(advisorSettings(cfgOf({ routing: { advisor: { enabled: false } } }), "v2", env)).toBeNull();
    expect(advisorSettings(cfgOf({ routing: { advisor: { notify: false } } }), "v2", env)).toBeNull(); // QA-2.4-5
    expect(advisorSettings(cfgOf({ routing: { engine: "advise", advisor: { notify: true } } }), "v2", env)).not.toBeNull();
    const shadow = advisorSettings(cfgOf({ routing: { engine: "shadow", advisor: { noticeIntervalHours: 2 } } }), "v2", env);
    expect(shadow).toMatchObject({ deliver: "log", intervalMs: 2 * HOUR });
    expect(shadow?.dir).toBe(join("/tmp-x", "opencode-model-router-trajectory"));
    expect(advisorSettings(cfgOf({ routing: { engine: "advise" } }), "v2", env)?.deliver).toBe("context");
    const absolute = process.platform === "win32" ? "C:\\data\\omr" : "/data/omr";
    expect(advisorSettings(cfgOf({ routing: { engine: "enforce", outcomes: { path: absolute } } }), "v2", env)).toMatchObject({ deliver: "context", dir: absolute });
    expect(advisorSettings(cfgOf({ routing: { engine: "static" } }), "v2", env)?.deliver).toBe("log");
    // QA-2.4-7: the validator refuses 0 and 0.5; a config built around it still never checks more often than hourly
    const bypass = (hours: number): RouterConfig => {
      const base = cfgOf({ routing: { engine: "advise" } });
      return { ...base, routing: { ...base.routing, advisor: { enabled: true, noticeIntervalHours: hours } } };
    };
    for (const hours of [0, 0.01, -5, Number.NaN]) {
      expect(advisorSettings(bypass(hours), "v2", env)?.intervalMs, `hours=${hours}`).toBeGreaterThanOrEqual(HOUR);
    }
    expect(advisorSettings(bypass(0), "v2", env)?.intervalMs).toBe(HOUR);
    expect(advisorSettings(bypass(Number.NaN), "v2", env)?.intervalMs).toBe(24 * HOUR);
    expect(() => cfgOf({ routing: { advisor: { noticeIntervalHours: 0 } } })).toThrow(/noticeIntervalHours must be a number >= 1/);
  });
});

describe("cost doctor: findings on bundled tiers never notify (QA-2.4-5)", () => {
  it("variant-effort on the unmodified bundled anthropic preset is listed (bundledTier) but is not notice-worthy", () => {
    const findings = runAdvisor(cfgOf({ preset: "anthropic", routing: {} }), noHost, CATALOG);
    const effort = findings.filter((f) => f.id === "variant-effort");
    expect(effort.length).toBeGreaterThan(0);
    expect(effort.every((f) => f.bundledTier && !f.notify)).toBe(true);
    expect(noticeWorthy(findings)).toBe(false);
    expect(formatNotice(findings)).toBeNull();
    // still shown in /router, with the reason
    const lines = formatFindings(findings);
    expect(lines.some((l) => l.includes("[warning] variant-effort (medium)") && l.includes("never in a notice"))).toBe(true);
  });

  it("a tier the user changed notifies again, and so do host findings and findings on the user's own preset", () => {
    const modified = structuredClone(shipped.presets as Record<string, Record<string, Partial<TierConfig>>>).anthropic!;
    modified.medium = { ...modified.medium!, costRatio: 6 }; // an override touched it
    const findings = runAdvisor(cfgOf({ preset: "anthropic", presets: { anthropic: modified }, routing: {} }), noHost, CATALOG);
    const bySubject = new Map(findings.filter((f) => f.id === "variant-effort").map((f) => [f.subject, f]));
    expect(bySubject.get("medium")).toMatchObject({ bundledTier: false, notify: true });
    expect(bySubject.get("fast")).toMatchObject({ bundledTier: true, notify: false });
    expect(noticeWorthy(findings)).toBe(true);
    const own = runAdvisor(cfgOf({ preset: "tst", presets: { tst: { ...OWNER, fast: { ...OWNER.fast!, effort: "low" } } }, routing: {} }), noHost, CATALOG);
    expect(find(own, "variant-effort", "fast")).toMatchObject({ bundledTier: false, notify: true });
    const title = runAdvisor(cfgOf({ routing: {} }), TITLE_HOST, CATALOG_CHEAP);
    expect(find(title, "title-model-unset")).toMatchObject({ bundledTier: false, notify: true }); // not tier-scoped
    expect(findings.filter((f) => f.severity === "info").every((f) => !f.notify)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In the plugin: the /router section and the notice in the orchestrator's context
// ---------------------------------------------------------------------------

describe("cost doctor in the plugin", () => {
  type Hooks = {
    "command.execute.before"(input: unknown, output: { parts: Array<{ text: string }> }): Promise<void>;
    "experimental.chat.system.transform"(input: unknown, output: { system: string[] }): Promise<void>;
    "chat.message"(input: unknown, output: { message: unknown; parts: Array<{ type?: string; text: string; synthetic?: boolean }> }): Promise<void>;
    dispose(): Promise<void>;
  };
  let home: string;
  let store: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Hooks[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "router-doctor-"));
    store = join(home, "store");
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

  interface Host {
    readonly agents?: () => Promise<readonly unknown[]>;
    readonly catalog?: () => Promise<readonly unknown[]>;
    readonly logs: string[];
    readonly agentCalls: () => number;
    /** `client.config.providers()` calls (what `/router` already made at 1fc94a3, and what the doctor now reuses). */
    readonly providerCalls: () => number;
    /** `routerCatalog` calls: the doctor no longer makes any. */
    readonly catalogCalls: () => number;
    /** What the plugin handed to the host's synthetic-message call (`ctx.session.synthetic`). */
    readonly synthetic: Array<{ sessionID: string; text: string; description: string }>;
  }

  /** Raw host records (Agent.Info / Model.Info) as the v2 adapter hands them over. */
  const rawAgents = (titleModel?: { providerID: string; id: string }): unknown[] => [
    { id: "title", mode: "primary", hidden: true, ...(titleModel === undefined ? {} : { model: titleModel }) },
    { id: "summary", mode: "primary", hidden: true },
    ...["fast", "medium", "heavy"].map((id) => ({ id, mode: "subagent", hidden: false })),
  ];
  const rawCatalog = (): unknown[] => [
    ...CATALOG,
    model("opencode-go/deepseek-v4.1-flash", { cost: [{ input: 0.15, output: 0.6, cache: { read: 0, write: 0 } }] }),
  ];

  async function plugin(over: { routing?: Record<string, unknown> | null; host?: "v1" | "v2"; agents?: Host["agents"]; catalog?: Host["catalog"]; parents?: Record<string, string>; synthetic?: boolean | "fail" }): Promise<{ hooks: Hooks; host: Host }> {
    const routing = over.routing === undefined ? null : over.routing;
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", ...(routing === null ? {} : { routing }) }));
    invalidateConfigCache();
    const logs: string[] = [];
    let agentCalls = 0;
    let providerCalls = 0;
    let catalogCalls = 0;
    const synthetic: Host["synthetic"] = [];
    const agents = over.agents ?? (async () => rawAgents());
    const catalog = over.catalog ?? (async () => rawCatalog());
    /** The v2 adapter's `config.providers()` payload: enabled models per provider, with cost and capabilities. */
    const providers = async (): Promise<{ data: unknown }> => {
      providerCalls += 1;
      const byProvider = new Map<string, Record<string, unknown>>();
      for (const entry of await catalog()) {
        const m = entry as AdvisorCatalogModel;
        const models = byProvider.get(m.providerID) ?? {};
        models[m.id] = m;
        byProvider.set(m.providerID, models);
      }
      return { data: { providers: [...byProvider].map(([id, models]) => ({ id, models })), default: {} } };
    };
    const ctx = {
      directory: home,
      worktree: home,
      client: {
        app: { log: async (request: { body: { message: string } }) => { logs.push(request.body.message); return {}; } },
        session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(over.parents?.[path.id] === undefined ? {} : { parentID: over.parents[path.id] }) } }) },
        ...((over.host ?? "v2") === "v2" ? { config: { providers } } : {}),
      },
      ...((over.host ?? "v2") === "v2"
        ? {
            routerHost: "v2" as const,
            routerAgents: async () => { agentCalls += 1; return agents(); },
            routerCatalog: async () => { catalogCalls += 1; return catalog(); },
            ...(over.synthetic === false
              ? {}
              : {
                  routerSynthetic: async (notice: { sessionID: string; text: string; description: string }) => {
                    if (over.synthetic === "fail") throw new Error("session is gone");
                    synthetic.push(notice);
                  },
                }),
          }
        : {}),
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as Hooks;
    instances.push(hooks);
    return { hooks, host: { logs, agentCalls: () => agentCalls, providerCalls: () => providerCalls, catalogCalls: () => catalogCalls, synthetic } };
  }

  const ask = async (hooks: Hooks, args = ""): Promise<string> => {
    const out = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router", arguments: args }, out);
    return out.parts[0]?.text ?? "";
  };
  const turn = async (hooks: Hooks, sessionID = "root-1"): Promise<string[]> => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID, model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, output);
    return output.system;
  };
  /** A user message arriving at the `chat.message` hook; returns the parts the plugin left on it (the user's own first). */
  const userMessage = async (hooks: Hooks, sessionID: string, text: string): Promise<Array<{ type?: string; text: string; synthetic?: boolean }>> => {
    const output = { message: { agent: "build" }, parts: [{ type: "text", text }] as Array<{ type?: string; text: string; synthetic?: boolean }> };
    await hooks["chat.message"]({ sessionID, agent: "build" }, output);
    return output.parts;
  };
  async function until(condition: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  }

  it("/router shows the Cost doctor on v2: the title finding with its cheapest-model fix, from the host's own agents and catalog", async () => {
    const { hooks } = await plugin({ routing: { engine: "shadow", outcomes: { path: store } } });
    await turn(hooks); // the host's title pick depends on the session's provider: the first orchestrator turn tells the router which
    const text = await ask(hooks);
    expect(text).toContain("Cost doctor: ");
    expect(text).toContain("[saving] title-model-unset (title)");
    expect(text).toContain(`fix (opencode.json): ${JSON.stringify({ agents: { title: { model: "opencode-go/deepseek-v4.1-flash" } } })}`);
    expect(text).toContain("v1 form (opencode.json): ");
    expect(text).toContain("small_model");
    expect(text).toContain("[warning] variant-effort"); // the bundled anthropic preset carries variant + effort (QA-2.3-13)
    expect(text).toContain("Decision log: a ladder-attempt row's confidence"); // decision 16
    expect(text.indexOf("router: engine=shadow")).toBeLessThan(text.indexOf("Cost doctor: "));
  });

  it("the finding clears once the host has a title model", async () => {
    const { hooks } = await plugin({ routing: {}, agents: async () => rawAgents({ providerID: "openai", id: "gpt-6-luna" }) });
    await turn(hooks);
    const text = await ask(hooks);
    expect(text).not.toContain("title-model-unset");
    expect(text).not.toContain("summary-model-unset");
  });

  it("before the first orchestrator turn the title check is skipped and says so (the session's provider is not known yet)", async () => {
    const { hooks } = await plugin({ routing: {} });
    const text = await ask(hooks);
    expect(text).not.toContain("title-model-unset");
    expect(text).toContain("the session's model is not known yet");
  });

  it("shows what was skipped when the host's agents or catalog are unavailable, and still prints the rest of /router", async () => {
    const { hooks, host } = await plugin({ routing: {}, agents: async () => { throw new Error("agents down"); }, catalog: async () => { throw new Error("catalog down"); } });
    const text = await ask(hooks);
    expect(text).toContain("agent list and model catalog were unavailable");
    expect(text).toContain("/router overrides");
    expect(host.logs.some((m) => m.includes("the host agent list is unavailable"))).toBe(true);
  });

  it("routing.advisor.enabled false switches the section off, and v1 has no section at all", async () => {
    expect(await ask((await plugin({ routing: { advisor: { enabled: false } } })).hooks)).toContain("Cost doctor: disabled");
    const v1 = await plugin({ routing: {}, host: "v1" });
    expect(await ask(v1.hooks)).not.toContain("Cost doctor");
  });

  it("advise: the notice is a synthetic transcript entry, once; the user's prompt is byte-identical; the system prompt never carries it (QA-2.4-R2-1)", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "advise", outcomes: { path: store } } });
    const first = await turn(hooks);
    expect(first.some((p) => p.includes("Cost doctor"))).toBe(false); // the first turn only starts the check
    let seen = 0;
    await until(() => {
      void userMessage(hooks, "root-1", "hello").then((parts) => {
        seen += 1;
        expect(parts).toEqual([{ type: "text", text: "hello" }]); // the user's message is untouched, with or without a pending notice
      });
      return host.synthetic.length > 0;
    });
    expect(host.synthetic).toHaveLength(1);
    expect(host.synthetic[0]).toMatchObject({ sessionID: "root-1", description: "Model router cost doctor" });
    expect(host.synthetic[0]!.text).toContain("[model-router] Cost doctor:");
    expect(host.synthetic[0]!.text).toContain("say it once");
    expect(seen).toBeGreaterThan(0);
    const parts = await userMessage(hooks, "root-1", "again");
    expect(parts).toEqual([{ type: "text", text: "again" }]);
    expect(host.synthetic).toHaveLength(1); // handed over once
    expect((await turn(hooks)).some((p) => p.includes("Cost doctor"))).toBe(false); // and the system prompt never carries it
    await until(() => (existsSync(store) ? readdirSync(store) : []).includes("advisor-notice.json"));
    expect(readdirSync(store).filter((name) => name.endsWith(".lock"))).toEqual([]); // the lock is released
    // a restart: same directory, nothing is due and nothing is pending
    const again = await plugin({ routing: { engine: "advise", outcomes: { path: store } } });
    for (let i = 0; i < 3; i += 1) {
      expect(await userMessage(again.hooks, `s${i}`, "hi")).toEqual([{ type: "text", text: "hi" }]);
      await turn(again.hooks, `s${i}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(again.host.synthetic).toHaveLength(0);
    expect(again.host.agentCalls()).toBe(0); // throttled before any host call
  });

  it("QA-2.4-8: a notice a previous process left pending is delivered at the first user message of the next one, without a host call", async () => {
    const first = await plugin({ routing: { engine: "advise", outcomes: { path: store } } });
    await turn(first.hooks);
    await until(() => {
      try {
        return (JSON.parse(readFileSync(join(store, readdirSync(store).find((n) => n.startsWith("advisor-notice") && n.endsWith(".json"))!), "utf-8")) as { pendingText: string | null }).pendingText !== null;
      } catch {
        return false; // not written yet
      }
    });
    await first.hooks.dispose();
    instances.splice(instances.indexOf(first.hooks), 1);
    const second = await plugin({ routing: { engine: "advise", outcomes: { path: store } } });
    expect(await userMessage(second.hooks, "root-9", "first message")).toEqual([{ type: "text", text: "first message" }]);
    await until(() => second.host.synthetic.length > 0);
    expect(second.host.synthetic[0]).toMatchObject({ sessionID: "root-9", description: "Model router cost doctor" });
    expect(second.host.synthetic[0]!.text).toContain("Cost doctor");
    expect(second.host.agentCalls()).toBe(0);
  });

  it("a subagent's or a grader's message never takes the notice; the root session still gets it afterwards", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "advise", outcomes: { path: store } }, parents: { "child-1": "root-1" } });
    await turn(hooks);
    await until(() => (existsSync(store) ? readdirSync(store) : []).some((n) => n.startsWith("advisor-notice") && n.endsWith(".json")));
    expect(await userMessage(hooks, "child-1", "do the thing")).toEqual([{ type: "text", text: "do the thing" }]);
    expect(host.synthetic).toHaveLength(0);
    await userMessage(hooks, "root-1", "hello");
    await until(() => host.synthetic.length === 1);
    expect(host.synthetic[0]!.sessionID).toBe("root-1");
  });

  it("without a synthetic-message call on the host (v1, an older adapter) the notice is a log line, once, and the user's message is untouched", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "advise", outcomes: { path: store } }, synthetic: false });
    await turn(hooks);
    await until(() => (existsSync(store) ? readdirSync(store) : []).some((n) => n.startsWith("advisor-notice") && n.endsWith(".json")));
    expect(await userMessage(hooks, "root-1", "hello")).toEqual([{ type: "text", text: "hello" }]);
    expect(host.logs.filter((m) => m.startsWith("[model-router] Cost doctor:"))).toHaveLength(1);
    await userMessage(hooks, "root-1", "again");
    expect(host.logs.filter((m) => m.startsWith("[model-router] Cost doctor:"))).toHaveLength(1);
  });

  it("a failing synthetic call is logged and never reaches the turn", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "advise", outcomes: { path: store } }, synthetic: "fail" });
    await turn(hooks);
    await until(() => (existsSync(store) ? readdirSync(store) : []).some((n) => n.startsWith("advisor-notice") && n.endsWith(".json")));
    expect(await userMessage(hooks, "root-1", "hello")).toEqual([{ type: "text", text: "hello" }]);
    await until(() => host.logs.some((m) => m.includes("notice not delivered")));
  });

  it("shadow: the notice is logged, never delivered into the session", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "shadow", outcomes: { path: store } } });
    await turn(hooks);
    await until(() => host.logs.some((m) => m.startsWith("[model-router] Cost doctor:")));
    expect(await userMessage(hooks, "root-1", "hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(host.synthetic).toHaveLength(0);
    expect((await turn(hooks)).some((p) => p.includes("Cost doctor"))).toBe(false);
    expect((existsSync(store) ? readdirSync(store) : []).some((n) => n.startsWith("advisor-notice"))).toBe(false); // log mode writes no state file (QA-2.4-10)
  });

  it("routing.advisor.notify: false silences the notice in every mode, and the /router section stays", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "advise", outcomes: { path: store }, advisor: { notify: false } } });
    await turn(hooks);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await userMessage(hooks, "root-1", "hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(host.synthetic).toHaveLength(0);
    expect(host.logs.some((m) => m.includes("Cost doctor:"))).toBe(false);
    expect(existsSync(store) ? readdirSync(store) : []).toEqual([]);
    expect(await ask(hooks)).toContain("Cost doctor: ");
  });

  it("without a routing block nothing runs and nothing is written (§1.2): no host call, no log line, no file", async () => {
    const { hooks, host } = await plugin({ routing: null });
    const system = await turn(hooks);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await turn(hooks);
    expect(system.some((p) => p.includes("Cost doctor"))).toBe(false);
    expect(host.agentCalls()).toBe(0);
    expect(host.logs.some((m) => m.includes("Cost doctor"))).toBe(false);
    expect(readdirSync(home).sort()).not.toContain("store");
  });

  /** `/router` as 1fc94a3 printed it (the help text, frozen from that commit's `buildRouterHelp`), before the status lines. */
  const ROUTER_HELP_1FC94A3 = [
    "# Model Router",
    "Enforcement: **advisory**",
    "",
    "Commands:",
    "- `/router enforce <off|advisory|enforced>` — set hard-block enforcement (persisted)",
    "- `/router overrides` — show the global + project override file paths and precedence",
    "- `/router models [provider]` — list valid model ids from your configured providers",
    "- `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`",
  ].join("\n");

  it("QA-2.4-3: without a routing block a bare /router on v2 is byte-identical to 1fc94a3's, and makes no agent or model-list call", async () => {
    const { hooks, host } = await plugin({ routing: null });
    await turn(hooks); // even after an orchestrator turn
    const text = await ask(hooks);
    const status = routerStatusLines(loadConfig(home), "v2");
    expect(text).toBe(`${ROUTER_HELP_1FC94A3}\n${status.join("\n")}\n\n`.replace(/\n\n$/, "")); // help, then the status lines, nothing else
    expect(text).not.toContain("Cost doctor");
    expect(text).not.toContain("last checkpoint");
    expect(text).not.toContain("/router stats");
    expect(host.agentCalls()).toBe(0);
    expect(host.catalogCalls()).toBe(0);
    expect(host.providerCalls()).toBe(1); // the model check `/router` always made: one call, as before
  });

  it("QA-2.4-3: with a routing block the doctor reads the SAME config.providers() call as the model check, never routerCatalog", async () => {
    const { hooks, host } = await plugin({ routing: { engine: "shadow", outcomes: { path: store } } });
    await turn(hooks);
    const before = host.providerCalls();
    const text = await ask(hooks);
    expect(text).toContain("Cost doctor: ");
    expect(text).toContain("/router stats");
    expect(text).toMatch(/^router: last checkpoint=DF\d+$/m);
    expect(host.providerCalls() - before).toBe(1);
    expect(host.catalogCalls()).toBe(0);
  });

  it("QA-2.4-15: a failure inside the doctor prints a one-line error for it, logs it, and keeps the rest of /router", async () => {
    const poisoned = { get id(): string { throw new Error("agent record exploded"); } };
    const { hooks, host } = await plugin({ routing: { engine: "shadow", outcomes: { path: store } }, agents: async () => [poisoned] });
    const text = await ask(hooks);
    expect(text).toContain("Cost doctor: unavailable (Error: agent record exploded).");
    expect(text).toContain("/router overrides");
    expect(host.logs.some((m) => m.includes("cost doctor failed"))).toBe(true);
  });
});
