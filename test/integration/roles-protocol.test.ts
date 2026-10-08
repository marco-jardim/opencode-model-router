/**
 * P2.2 integration (plan #84 T2.2.4): the roles surface end to end. The protocol text itself is pinned by
 * test/golden/roles-protocol.golden.test.ts; here the pieces meet: protocol presence by mode and host, the advisor findings
 * (each fires and clears), the role × tier statistics next to tier rows, and `/router stats` against `scripts/routing-stats.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoleLines, buildRouterHelp } from "../../src/commands/output";
import { validateConfig, type RouterConfig } from "../../src/router/config";
import { assembleRolesSystemPrompt, assembleSystemPrompt, buildDelegationProtocol, buildRolesProtocol } from "../../src/router/protocol";
import { resolveRoles } from "../../src/router/roles";
import { ROLE_BUDGET_LOW_SHARE, runAdvisor, type AdvisorExtras, type Finding, type FindingId } from "../../src/routing/advisor";
import { runStatsCommand } from "../../src/routing/commands/stats";
import { createPersister, nodePersistDeps, renderMarkdown, runStatsCli, summarize, summarizeRoles } from "../../src/routing/outcomes";
import { signalRow, type SignalObservation } from "../../src/routing/outcomes/signals";
import {
  ANNOTATION_REASON,
  DECISIONS_FILE,
  makeKey,
  type DecisionRow,
  type LogRow,
  type OutcomeKey,
  type SignalKind,
} from "../../src/routing/outcomes/types";

const base = validateConfig(JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")));

function tiersCfg(): RouterConfig {
  return { ...base, activeMode: undefined };
}

function rolesCfg(extra: Partial<RouterConfig> = {}): RouterConfig {
  return { ...tiersCfg(), routing: { ...(base.routing ?? {}), delegation: "roles" }, ...extra } as RouterConfig;
}

const WINDOW = { since: null, until: null };
const logger = { warn: () => undefined };

// ---------------------------------------------------------------------------
// Protocol presence (I1)
// ---------------------------------------------------------------------------

describe("roles protocol presence", () => {
  it("tiers mode: the protocol is byte-identical to the tier protocol and carries no roles text", () => {
    const cfg = tiersCfg();
    const roles = resolveRoles(cfg, "v2");
    expect(roles.size).toBe(0);
    expect(buildRolesProtocol(cfg, roles)).toBe("");
    expect(assembleRolesSystemPrompt(cfg, roles, "anthropic/claude-sonnet-4-6", true)).toBe("");
    expect(assembleSystemPrompt(cfg, "anthropic/claude-sonnet-4-6", true)).toContain(buildDelegationProtocol(cfg));
    expect(assembleSystemPrompt(cfg, "anthropic/claude-sonnet-4-6", true)).not.toContain("Role Delegation Protocol");
  });

  it("v2 roles mode: the roles protocol is present", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    expect(roles.size).toBeGreaterThan(0);
    const text = buildRolesProtocol(cfg, roles);
    expect(text).toContain("## Role Delegation Protocol (MANDATORY)");
    for (const name of roles.keys()) expect(text).toContain(`- ${name}:`);
  });

  it("a disabled role is absent from the menu", () => {
    const cfg = rolesCfg({ roleAgents: { architect: { enabled: false } } } as Partial<RouterConfig>);
    const roles = resolveRoles(cfg, "v2");
    expect(roles.has("architect")).toBe(false);
    const text = buildRolesProtocol(cfg, roles);
    expect(text).not.toContain("- architect:");
    expect(text).toContain("- explorer:");
  });

  it("v1 never shows roles, whatever the config says", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v1");
    expect(roles.size).toBe(0);
    expect(buildRolesProtocol(cfg, roles)).toBe("");
    expect(buildRouterHelp("off", { roles: roles.values() })).toBe(buildRouterHelp("off"));
  });

  it("/router lists role lines in roles mode only", () => {
    const roles = resolveRoles(rolesCfg(), "v2");
    const lines = buildRoleLines(roles.values());
    expect(lines[0]).toBe("Roles:");
    expect(lines.length).toBe(roles.size + 1);
    const explorer = lines.find((l) => l.includes("`explorer`"));
    expect(explorer).toMatch(/\(explore\): tiers fast\.\.medium \| authority fixed: read/);
    const help = buildRouterHelp("off", { roles: roles.values() });
    expect(help).toContain("Roles:\n- `explorer`");
    expect(buildRouterHelp("off", { roles: resolveRoles(tiersCfg(), "v2").values() })).toBe(buildRouterHelp("off"));
  });
});

// ---------------------------------------------------------------------------
// Stats fixtures
// ---------------------------------------------------------------------------

const R_FAST = makeKey("implement", { origin: "role", id: "implementer" }, "anthropic", "claude-haiku-4-5");
const R_MED = makeKey("implement", { origin: "role", id: "implementer" }, "anthropic", "claude-sonnet-5-5");
const TIER_KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");

function choiceOf(key: OutcomeKey, agent: string, origin: "router" | "role") {
  return { key, agent, origin, model: key.split("|")[2]?.split("#")[0] ?? "", variant: "default" };
}

function dispatch(id: string, minute: number, over: Partial<DecisionRow> = {}): DecisionRow {
  const ts = new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString();
  return {
    v: 1,
    kind: "decision",
    ts,
    sessionID: "p1",
    decisionID: id,
    mode: "enforce",
    childSessionID: `c-${id}`,
    facts: { class: "implement", risk: "low", scope: "file", needs: ["edit"], confidence: 0.9, source: "rules" },
    chosen: choiceOf(R_FAST, "implementer", "role"),
    best: choiceOf(R_FAST, "implementer", "role"),
    switched: false,
    pinned: false,
    unit: "ratio",
    costs: { [R_FAST]: 0.3 },
    confidence: 0.8,
    reason: "kept",
    step: "dispatch",
    resume: false,
    role: "implementer",
    tier: "fast",
    ...over,
  };
}

function signal(of: DecisionRow, kind: SignalKind, outcome: SignalObservation["outcome"], weight: number, minute: number): DecisionRow {
  return {
    ...signalRow(
      { ts: new Date(Date.UTC(2026, 9, 6, 10, minute)).toISOString(), sessionID: of.sessionID, decisionID: of.decisionID, mode: of.mode, childSessionID: of.childSessionID, facts: of.facts, chosen: of.chosen, step: of.step },
      { kind, outcome, weight },
    ),
  };
}

const TIER_ROW = dispatch("T1", 0, { role: undefined, tier: undefined, chosen: choiceOf(TIER_KEY, "medium", "router"), best: choiceOf(TIER_KEY, "medium", "router"), costs: { [TIER_KEY]: 1 } });
const ROLE_A = dispatch("R1", 5);
const ROLE_B = dispatch("R2", 10, { chosen: choiceOf(R_MED, "implementer", "role"), best: choiceOf(R_MED, "implementer", "role"), tier: "medium", costs: { [R_MED]: 0.6 } });
const ROLE_C = dispatch("R3", 15, { binding: "unknown" });

const TIER_ONLY: LogRow[] = [TIER_ROW];
const MIXED: LogRow[] = [
  TIER_ROW,
  ROLE_A,
  ROLE_B,
  ROLE_C,
  signal(ROLE_A, "run", "pass", 1, 20),
  signal(ROLE_B, "verdict", "fail", 1, 21),
  signal(ROLE_B, "budget", "none", 0, 22),
  { ...ROLE_C, reason: `${ANNOTATION_REASON}binding:unknown`, ts: new Date(Date.UTC(2026, 9, 6, 10, 23)).toISOString() },
];

describe("stats with mixed tier and role rows", () => {
  it("tier-only logs render exactly as today", () => {
    expect(summarizeRoles(null, TIER_ONLY, WINDOW).byRoleTier).toEqual([]);
    const outputs: string[] = [];
    const io = fakeIo(TIER_ONLY, outputs);
    return runStatsCli([], io).then((exit) => {
      expect(exit).toBe(0);
      expect(outputs.join("")).toBe(renderMarkdown(summarize(null, TIER_ONLY, WINDOW)));
      expect(outputs.join("")).not.toContain("By role");
    });
  });

  it("role rows add the role × tier table after the tier report, which is unchanged", async () => {
    const outputs: string[] = [];
    expect(await runStatsCli([], fakeIo(MIXED, outputs))).toBe(0);
    const text = outputs.join("");
    const tierReport = renderMarkdown(summarize(null, MIXED, WINDOW));
    expect(text.startsWith(tierReport)).toBe(true);
    const section = text.slice(tierReport.length);
    expect(section).toContain("### By role × tier");
    expect(section).toMatch(/\| implementer \| fast \| 2 \| 1 \| 0 \|/);
    expect(section).toMatch(/\| implementer \| medium \| 1 \| 0 \| 1 \|/);
    expect(section).toContain("| Budget exhaustions |");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("--json carries a `roles` key only when role rows exist", async () => {
    const tier: string[] = [];
    await runStatsCli(["--json"], fakeIo(TIER_ONLY, tier));
    expect(JSON.parse(tier.join(""))).not.toHaveProperty("roles");
    const mixed: string[] = [];
    await runStatsCli(["--json"], fakeIo(MIXED, mixed));
    expect(JSON.parse(mixed.join("")).roles.byRoleTier.length).toBe(2);
  });
});

function fakeIo(rows: LogRow[], out: string[]) {
  return {
    defaultDir: "/default",
    open: (dir: string) => ({
      dir,
      load: async () => ({ status: "missing" as const, snapshot: { version: 1 as const, entries: {} }, dropped: 0, savedAt: null, message: null }),
      readRows: async () => ({ rows, skipped: 0, files: ["decisions.jsonl"], oldestTs: null, generations: 0 }),
    }),
    stdout: (t: string) => void out.push(t),
    stderr: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// /router stats equals the script
// ---------------------------------------------------------------------------

describe("/router stats equals scripts/routing-stats.ts for role rows", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function storeWith(rows: LogRow[]): string {
    const dir = mkdtempSync(join(tmpdir(), "omr-roles-stats-"));
    dirs.push(dir);
    writeFileSync(join(dir, DECISIONS_FILE), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    return dir;
  }

  it("the in-session command prints the driver's stdout, role section included", async () => {
    const dir = storeWith(MIXED);
    const result = await runStatsCommand(`--dir ${dir}`, { cfg: tiersCfg(), host: "v1", logger });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("### By role × tier");
    let direct = "";
    const exit = await runStatsCli(["--dir", dir], {
      defaultDir: dir,
      open: (d) => createPersister(d, nodePersistDeps({ warn: () => undefined })),
      stdout: (t) => void (direct += t),
      stderr: () => undefined,
    });
    expect(exit).toBe(0);
    expect(result.stdout).toBe(direct);
  });

  // Node without default type stripping (< 22.18) cannot run the script: skipped there; the driver equality above still holds.
  it.skipIf(!scriptRuns())("the script prints the same bytes", async () => {
    const dir = storeWith(MIXED);
    const script = execFileSync(process.execPath, ["scripts/routing-stats.ts", "--dir", dir], { cwd: process.cwd(), encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    expect(script).toContain("### By role × tier");
    const result = await runStatsCommand(`--dir ${dir}`, { cfg: tiersCfg(), host: "v1", logger });
    expect(script).toBe(result.stdout);
  });

  it("a tier-only log WITH a verdict signal row renders byte-identical to the tier report, in markdown and JSON", async () => {
    const rows: LogRow[] = [TIER_ROW, signal(TIER_ROW, "verdict", "pass", 1, 20)];
    const roles = summarizeRoles(null, rows, WINDOW);
    expect(roles.byRoleTier).toEqual([]);
    expect(roles.unattributed.signals).toBeGreaterThan(0); // the tier signal is unattributed, yet no role section
    const md: string[] = [];
    await runStatsCli([], fakeIo(rows, md));
    expect(md.join("")).toBe(renderMarkdown(summarize(null, rows, WINDOW)));
    const json: string[] = [];
    await runStatsCli(["--json"], fakeIo(rows, json));
    expect(json.join("")).toBe(JSON.stringify(summarize(null, rows, WINDOW), null, 2) + "\n");
  });
});

function scriptRuns(): boolean {
  try {
    execFileSync(process.execPath, ["scripts/routing-stats.ts", "--help"], { cwd: process.cwd(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Advisor findings: each fires and clears
// ---------------------------------------------------------------------------

function findingIds(findings: readonly Finding[]): FindingId[] {
  return findings.map((f) => f.id);
}

const run = (cfg: RouterConfig, extras: AdvisorExtras = {}) => runAdvisor(cfg, null, null, undefined, { host: "v2", ...extras });
/** No `host` in the extras: the host generation is unknown. */
const runUnknownHost = (cfg: RouterConfig, extras: AdvisorExtras = {}) => runAdvisor(cfg, null, null, undefined, extras);

describe("advisor role findings fire and clear", () => {
  const ALL_DISABLED = Object.fromEntries(["explorer", "researcher", "runner", "implementer", "reviewer", "architect", "general"].map((n) => [n, { enabled: false }]));

  it("an unknown host (no extras.host) keeps every role finding silent", () => {
    const stats = summarizeRoles(null, MIXED, WINDOW);
    const violating = rolesCfg({ subagentTiers: { explore: "fast" }, agents: { implementer: { description: "x", model: "anthropic/claude-sonnet-5-5", allowTools: ["edit", "bash", "webfetch"] } } } as unknown as Partial<RouterConfig>);
    // The same config does fire with the host known to be v2 (so the silence is the host, not the fixture).
    expect(findingIds(run(violating, { roleStats: stats, tierDispatches: 50 }))).toEqual(expect.arrayContaining(["role-separation", "native-explore-aliased", "role-binding-unknown"]));
    for (const id of ROLE_IDS) expect(findingIds(runUnknownHost(violating, { roleStats: stats, tierDispatches: 50 }))).not.toContain(id);
    expect(findingIds(runUnknownHost(rolesCfg({ roleAgents: ALL_DISABLED } as unknown as Partial<RouterConfig>)))).not.toContain("roles-none-enabled");
  });

  it("roles-none-enabled (info) fires on v2 roles mode with no enabled role and clears with one, on v1 or in tiers mode", () => {
    const none = rolesCfg({ roleAgents: ALL_DISABLED } as unknown as Partial<RouterConfig>);
    const fired = run(none).find((f) => f.id === "roles-none-enabled");
    expect(fired?.severity).toBe("info");
    expect(fired?.notify).toBe(false);
    expect(findingIds(run(rolesCfg()))).not.toContain("roles-none-enabled");
    expect(findingIds(run(rolesCfg({ roleAgents: { ...ALL_DISABLED, general: { enabled: true } } } as unknown as Partial<RouterConfig>)))).not.toContain("roles-none-enabled");
    expect(findingIds(run(none, { host: "v1" }))).not.toContain("roles-none-enabled");
    expect(findingIds(run({ ...tiersCfg(), roleAgents: ALL_DISABLED } as RouterConfig))).not.toContain("roles-none-enabled");
  });

  it("buildRoleLines skips a disabled role", () => {
    const roles = [...resolveRoles(rolesCfg(), "v2").values()];
    const off = roles.map((r) => (r.agent === "architect" ? { ...r, enabled: false } : r));
    expect(buildRoleLines(off).some((l) => l.includes("`architect`"))).toBe(false);
    expect(buildRoleLines(off).some((l) => l.includes("`explorer`"))).toBe(true);
  });

  const ROLE_IDS: FindingId[] = ["role-separation", "roles-on-legacy-host", "role-budget-low", "role-range-clamped", "role-binding-unknown", "native-explore-aliased", "role-usage-share", "roles-none-enabled"];

  it("tiers mode: no role finding at all, whatever the statistics say", () => {
    const stats = summarizeRoles(null, MIXED, WINDOW);
    const found = findingIds(run(tiersCfg(), { host: "v2", roleStats: stats, tierDispatches: 50 }));
    for (const id of ROLE_IDS) expect(found).not.toContain(id);
    expect(findingIds(run(tiersCfg()))).toEqual(findingIds(runAdvisor(tiersCfg(), null, null)));
  });

  it("roles-on-legacy-host (info) fires on v1 roles mode and clears on v2 or tiers mode", () => {
    const fired = run(rolesCfg(), { host: "v1" }).find((f) => f.id === "roles-on-legacy-host");
    expect(fired?.severity).toBe("info");
    expect(fired?.notify).toBe(false);
    expect(findingIds(run(rolesCfg(), { host: "v2" }))).not.toContain("roles-on-legacy-host");
    expect(findingIds(run(tiersCfg(), { host: "v1" }))).not.toContain("roles-on-legacy-host");
    expect(findingIds(run(rolesCfg()))).not.toContain("roles-on-legacy-host");
  });

  it("native-explore-aliased (info) fires while the explorer role is enabled and clears when it is disabled or on v1", () => {
    const fired = run(rolesCfg({ subagentTiers: { explore: "fast" } })).find((f) => f.id === "native-explore-aliased");
    expect(fired?.severity).toBe("info");
    expect(fired?.message).toContain("subagentTiers.explore (fast)");
    const disabled = rolesCfg({ roleAgents: { explorer: { enabled: false } } } as Partial<RouterConfig>);
    expect(findingIds(run(disabled))).not.toContain("native-explore-aliased");
    expect(findingIds(run(rolesCfg(), { host: "v1" }))).not.toContain("native-explore-aliased");
    expect(findingIds(run(tiersCfg()))).not.toContain("native-explore-aliased");
  });

  it("role-separation (warning) fires for a #81 agent with a role name that breaks the rule and clears when it is removed or compliant", () => {
    const violating = rolesCfg({ agents: { implementer: { description: "x", model: "anthropic/claude-sonnet-5-5", allowTools: ["edit", "bash", "webfetch"] } } } as unknown as Partial<RouterConfig>);
    const fired = run(violating).find((f) => f.id === "role-separation");
    expect(fired?.severity).toBe("warning");
    expect(fired?.subject).toBe("implementer");
    expect(fired?.notify).toBe(true);
    expect(findingIds(run(rolesCfg()))).not.toContain("role-separation");
    expect(findingIds(run({ ...tiersCfg(), agents: violating.agents } as RouterConfig)).includes("role-separation")).toBe(false);
  });

  it("role-range-clamped (info) fires when a role's range had to be placed or clamped and clears with a fitting range", () => {
    const wide = rolesCfg({ roleAgents: { explorer: { tierRange: { floor: "fast", ceiling: "heavy" } } } } as unknown as Partial<RouterConfig>);
    const fired = run(wide).filter((f) => f.id === "role-range-clamped");
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]?.severity).toBe("info");
    expect(fired[0]?.subject).toBe("explorer");
    expect(findingIds(run(rolesCfg()))).not.toContain("role-range-clamped");
  });

  it("role-budget-low (warning) fires above the share and clears below it, with too few dispatches, or in tiers mode", () => {
    const rows = (exhausted: number, total: number): LogRow[] => {
      const out: LogRow[] = [];
      for (let i = 0; i < total; i++) {
        const d = dispatch(`B${i}`, i);
        out.push(d);
        if (i < exhausted) out.push(signal(d, "budget", "none", 0, 30 + i));
      }
      return out;
    };
    const stats = (exhausted: number, total: number) => summarizeRoles(null, rows(exhausted, total), WINDOW);
    expect(ROLE_BUDGET_LOW_SHARE).toBe(0.2);
    const fired = run(rolesCfg(), { roleStats: stats(3, 10) }).find((f) => f.id === "role-budget-low");
    expect(fired?.subject).toBe("implementer");
    expect(fired?.severity).toBe("warning");
    expect(findingIds(run(rolesCfg(), { roleStats: stats(1, 10) }))).not.toContain("role-budget-low");
    expect(findingIds(run(rolesCfg(), { roleStats: stats(3, 4) }))).not.toContain("role-budget-low");
    expect(findingIds(run(tiersCfg(), { roleStats: stats(3, 10) }))).not.toContain("role-budget-low");
    expect(findingIds(run(rolesCfg()))).not.toContain("role-budget-low");
  });

  it("role-binding-unknown (warning) fires when unknown-binding rows exist and clears without them", () => {
    const withUnknown = summarizeRoles(null, MIXED, WINDOW);
    const fired = run(rolesCfg(), { roleStats: withUnknown }).find((f) => f.id === "role-binding-unknown");
    expect(fired?.severity).toBe("warning");
    expect(fired?.message).toContain("1 child session");
    const clean = summarizeRoles(null, [ROLE_A, ROLE_B], WINDOW);
    expect(findingIds(run(rolesCfg(), { roleStats: clean }))).not.toContain("role-binding-unknown");
    expect(findingIds(run(tiersCfg(), { roleStats: withUnknown }))).not.toContain("role-binding-unknown");
  });

  it("role-usage-share (info) reports the share of role dispatches and clears when no tier is named or data is thin", () => {
    const stats = summarizeRoles(null, [ROLE_A, ROLE_B, ROLE_C], WINDOW);
    const fired = run(rolesCfg(), { roleStats: stats, tierDispatches: 2 }).find((f) => f.id === "role-usage-share");
    expect(fired?.severity).toBe("info");
    expect(fired?.message).toContain("3 of 5 dispatches (60%) went to a role");
    expect(findingIds(run(rolesCfg(), { roleStats: stats, tierDispatches: 0 }))).not.toContain("role-usage-share");
    expect(findingIds(run(rolesCfg(), { roleStats: stats, tierDispatches: 1 }))).not.toContain("role-usage-share");
    expect(findingIds(run(rolesCfg(), { roleStats: stats }))).not.toContain("role-usage-share");
    expect(findingIds(run(tiersCfg(), { roleStats: stats, tierDispatches: 2 }))).not.toContain("role-usage-share");
  });
});
