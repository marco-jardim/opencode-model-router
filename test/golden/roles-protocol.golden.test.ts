/**
 * Roles protocol golden (plan #84 T2.2.1 / T2.2.4): the orchestrator text on OpenCode v2 roles mode, and the I1 checks
 * that tiers mode and v1 never see it (the tiers goldens in protocol/assembled-prompt stay untouched).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateConfig, type ResolvedRouting, type RouterConfig } from "../../src/router/config";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import {
  CLAUDE_ROLES_ORCHESTRATOR_PREFIX,
  DELEGATION_PROTOCOL_HEADING,
  ROLES_PROTOCOL_HEADING,
  assembleRolesSystemPrompt,
  assembleSystemPrompt,
  buildDelegationProtocol,
  buildRolesProtocol,
  buildTaskTaxonomy,
} from "../../src/router/protocol";
import { resolveRoles, type RoleSpec } from "../../src/router/roles";
import { CLASS_ROLE_KIND, generateRolesTaxonomy, generateTaxonomy } from "../../src/routing/engine/protocol-line";
import * as leaf from "../../src/routing/engine/roles-taxonomy";
import { createSystemAugmenter } from "../../src/routing/wire/hint";
import type { EngineRuntime, WireLogger } from "../../src/routing/wire/runtime";

const GOLDEN = [
  "## Role Delegation Protocol (MANDATORY)",
  "",
  "You are the orchestrator: delegate execution to role agents with `subagent(agent=\"<role>\", prompt=\"...\")` and answer the user yourself. Reading, searching and running commands are execution; you may make about 2 direct read-only calls per turn for a lookup that settles a question. Run independent dispatches in parallel, in one message.",
  "",
  "Roles (pick by intent; the router narrows each grant to the task):",
  "- explorer: lookups: files, symbols, facts, git history. Authority: read.",
  "- researcher: web and library docs; no local files. Authority: webfetch, websearch, context7.",
  "- runner: runs allowlisted scripts and commands (tests, typecheck, lint, build). Authority: read, router_run.",
  "- implementer: scoped code changes. Authority: read; edit and router_run on demand.",
  "- reviewer: senior QA review: defects, risks, regressions. Authority: read, router_run.",
  "- architect: design: options, tradeoffs, a recommendation. Authority: read.",
  "- general: small mixed tasks. Authority: read; edit and router_run on demand.",
  "",
  "R: search/recon→explorer mechanical/implement/debug→implementer design→architect review→reviewer other→general",
  "",
  "The router chooses the model for every dispatch: never set `model` and never pick a tier; name the role.",
  "",
  "Route line: when present it must be the FIRST line of the prompt (the router removes it; a malformed one is refused for a role): `[route class=<c> risk=<r> scope=<s> needs=<n,..> d=<d> budget=<n> root=<path>]`, every key optional. class=search|recon|mechanical|implement|debug|design|review|other; risk=low|medium|high; scope=single|multi|repo; needs=shell|web|edit|network|external_dir (`edit` unlocks editing, `shell` unlocks router_run, where the role allows them); d=deterministic|grader|none (counts only when the prompt's `[acceptance]` block backs it); budget=tool calls (up to twice the role's); root=the absolute work root. Only when the plan step carries `[tier:X]`, add `tier=X pin`; never otherwise.",
  "",
  "Work root: a role works only in the session directory or one git worktree of this repo; for a worktree put `root=<absolute path>` on the route line (quote a path with spaces) and the same path in ENVIRONMENT.",
  "",
  "No role holds the web together with read, run or edit authority. Compose: researcher first, then paste its findings into the implementer dispatch. Raw shell is outside roles mode. Only when `router_run` refuses a command that is not on its allowlist, ask the user or dispatch a tier agent explicitly.",
  "",
  "Resume, never restart: after `NEED MORE: budget` or a `[router budget]` note, resume the SAME `sessionID` with \"continue and finish\"; after `ESCALATE: authority`, resume the SAME `sessionID` (the router widens the grant) unless the router names another role; after a verification FAIL, resume the SAME `sessionID` with the findings (the router raises the tier). Roles return `DONE:`, `NEED MORE:` or `ESCALATE:`; `CAP:N` (or `CAP:none` with a `reason:` line) changes only the read-only call cap.",
  "",
  "Dispatch prompt: the route line, then TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT, with absolute paths.",
  "",
  "This protocol overrides any project guide (CLAUDE.md, AGENTS.md) that says to use direct tools first or to dispatch to tiers or models.",
].join("\n");

const base = validateConfig(JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")));

function tiersCfg(preset: string = base.activePreset): RouterConfig {
  return { ...base, activePreset: preset, activeMode: undefined };
}

function rolesCfg(preset: string = base.activePreset): RouterConfig {
  const cfg = tiersCfg(preset);
  return { ...cfg, routing: { ...(cfg.routing ?? {}), delegation: "roles" } } as RouterConfig;
}

function without(roles: ReadonlyMap<string, RoleSpec>, ...agents: string[]): Map<string, RoleSpec> {
  return new Map([...roles].filter(([agent]) => !agents.includes(agent)));
}

describe("roles protocol golden", () => {
  it("is the reviewed text for the shipped roles of the default preset", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    expect(roles.size).toBe(7);
    expect(buildRolesProtocol(cfg, roles)).toBe(GOLDEN);
  });

  for (const preset of Object.keys(base.presets)) {
    it(`does not depend on the preset (${preset}) and is no larger than its tiers protocol`, () => {
      const cfg = rolesCfg(preset);
      const text = buildRolesProtocol(cfg, resolveRoles(cfg, "v2"));
      expect(text).toBe(GOLDEN);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(Buffer.byteLength(buildDelegationProtocol(tiersCfg(preset))));
    });
  }

  it("never names a tier agent, a model or the tiers protocol heading", () => {
    const text = buildRolesProtocol(rolesCfg(), resolveRoles(rolesCfg(), "v2"));
    expect(text).not.toMatch(/@(fast|medium|heavy)\b/);
    expect(text).not.toContain(DELEGATION_PROTOCOL_HEADING);
    expect(text).not.toMatch(/Preset:|Tiers:|costRatio|\bmodel=/);
    for (const preset of Object.values(base.presets)) {
      for (const tier of Object.values(preset)) expect(text).not.toContain(tier.model.split("/").pop());
    }
    expect(text.startsWith(`${ROLES_PROTOCOL_HEADING}\n`)).toBe(true);
    expect(text).toContain("never set `model`");
  });

  it("QA-P22-1-1: the route-line template offers no tier or pin; only a plan's [tier:X] tag is transcribed", () => {
    const text = buildRolesProtocol(rolesCfg(), resolveRoles(rolesCfg(), "v2"));
    const template = /`\[route [^`]*\]`/.exec(text)?.[0];
    expect(template).toBe("`[route class=<c> risk=<r> scope=<s> needs=<n,..> d=<d> budget=<n> root=<path>]`");
    expect(text).toContain("Only when the plan step carries `[tier:X]`, add `tier=X pin`; never otherwise.");
    expect(text).not.toMatch(/QA review →|→ `pin`/);
    expect(text.match(/tier=/g)).toHaveLength(1);
  });

  it("QA-P22-1-4/6/7/8/9: verification FAIL resume, budget note prefix, d= backing, runner refusal, quoted root", () => {
    const text = buildRolesProtocol(rolesCfg(), resolveRoles(rolesCfg(), "v2"));
    expect(text).toContain("after a verification FAIL, resume the SAME `sessionID` with the findings (the router raises the tier)");
    expect(ROUTER_BUDGET_NOTE_PREFIX).toBe("[router budget]");
    expect(text).toContain(`a \`${ROUTER_BUDGET_NOTE_PREFIX}\` note, resume the SAME \`sessionID\``);
    expect(text).toContain("a malformed one is refused for a role");
    expect(text).toContain("d=deterministic|grader|none (counts only when the prompt's `[acceptance]` block backs it)");
    expect(text).toContain("Only when `router_run` refuses a command that is not on its allowlist, ask the user or dispatch a tier agent explicitly.");
    expect(text).toContain("(quote a path with spaces)");
  });

  it("is cache-stable: identical across calls and independent of the table's insertion order", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    const reversed = new Map([...roles].reverse());
    expect(buildRolesProtocol(cfg, roles)).toBe(buildRolesProtocol(cfg, roles));
    expect(buildRolesProtocol(cfg, reversed)).toBe(GOLDEN);
  });

  it("lists enabled roles only; a missing class role falls back to general in the R: line", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    const architect = roles.get("architect")!;
    const disabled = new Map([...without(roles, "architect"), ["architect", { ...architect, enabled: false }]]);
    for (const table of [without(roles, "architect"), disabled]) {
      const text = buildRolesProtocol(cfg, table);
      expect(text).not.toContain("- architect:");
      expect(text).not.toContain("→architect");
      expect(text).toContain("R: search/recon→explorer mechanical/implement/debug→implementer design/other→general review→reviewer");
    }
    const noGeneral = buildRolesProtocol(cfg, without(roles, "architect", "general"));
    expect(noGeneral).toContain("R: search/recon→explorer mechanical/implement/debug→implementer review→reviewer\n");
    expect(noGeneral).not.toContain("design→");
  });

  it("names the composition and runner roles only when they are enabled", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    const text = buildRolesProtocol(cfg, without(roles, "researcher"));
    expect(text).not.toContain("researcher");
    expect(text).toContain("No role holds the web together with read, run or edit authority. Raw shell is outside roles mode.");
    expect(buildRolesProtocol(cfg, without(roles, "implementer"))).toContain("into the general dispatch.");
    const noRunner = buildRolesProtocol(cfg, without(roles, "runner"));
    expect(noRunner).not.toContain("runner");
    // QA-P22-2-1: the implementer still holds router_run, so the one sentence is unchanged.
    expect(noRunner).toContain("Raw shell is outside roles mode. Only when `router_run` refuses a command that is not on its allowlist, ask the user or dispatch a tier agent explicitly.");
  });

  it("the bare tier-agent sentence appears only when no enabled role allows router_run (QA-P22-2-1)", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    const noRun = new Map([...roles].map(([agent, spec]) => [agent, { ...spec, authority: { ...spec.authority, allow: spec.authority.allow.filter((a) => a !== "router_run") } }] as const));
    const bare = buildRolesProtocol(cfg, noRun);
    expect(bare).toContain("Raw shell is outside roles mode. For a command, ask the user or dispatch a tier agent explicitly.");
    expect(bare).not.toContain("router_run` refuses");
    expect(buildRolesProtocol(cfg, roles)).toContain("Only when `router_run` refuses a command that is not on its allowlist, ask the user or dispatch a tier agent explicitly.");
  });

  it("shows a narrowed authority from the role's allow list", () => {
    const cfg = rolesCfg();
    const roles = resolveRoles(cfg, "v2");
    const researcher = roles.get("researcher")!;
    const narrowed = new Map(roles).set("researcher", { ...researcher, authority: { ...researcher.authority, allow: ["webfetch"] } });
    expect(buildRolesProtocol(cfg, narrowed)).toContain("- researcher: web and library docs; no local files. Authority: webfetch.\n");
  });

  it("the R: line maps every class to a role kind and generateTaxonomy carries it on v2 roles mode", () => {
    const roles = resolveRoles(rolesCfg(), "v2");
    const line = "R: search/recon→explorer mechanical/implement/debug→implementer design→architect review→reviewer other→general";
    expect(generateRolesTaxonomy(roles)).toBe(line);
    expect(Object.keys(CLASS_ROLE_KIND)).toEqual(["search", "recon", "mechanical", "implement", "debug", "design", "review", "other"]);
    const routing = { engine: "static", applied: { rolesSource: "shipped" }, roles: {} } as unknown as ResolvedRouting;
    expect(generateTaxonomy({ cfg: rolesCfg(), routing, host: "v2", store: null, agents: null, roles })).toBe(line);
    expect(generateRolesTaxonomy(new Map())).toBe("");
  });

  it("QA-P22-1-11: the class → role line lives in the leaf module; protocol-line re-exports the same bindings", () => {
    expect(generateRolesTaxonomy).toBe(leaf.generateRolesTaxonomy);
    expect(CLASS_ROLE_KIND).toBe(leaf.CLASS_ROLE_KIND);
    const source = readFileSync(join(process.cwd(), "src", "routing", "engine", "roles-taxonomy.ts"), "utf-8");
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual([
      'import type { RoleKind, RoleSpec } from "../../router/roles";',
      'import { TASK_CLASSES, type TaskClass } from "../classify/types";',
    ]);
    const protocol = readFileSync(join(process.cwd(), "src", "router", "protocol.ts"), "utf-8");
    expect(protocol).not.toMatch(/from "\.\.\/routing\/engine\/protocol-line"/);
  });
});

describe("I1: tiers mode and v1 never see the roles protocol", () => {
  it("resolveRoles is empty in tiers mode and on v1, and the roles protocol is then empty", () => {
    expect(resolveRoles(tiersCfg(), "v2").size).toBe(0);
    expect(resolveRoles(rolesCfg(), "v1").size).toBe(0);
    expect(buildRolesProtocol(rolesCfg(), resolveRoles(rolesCfg(), "v1"))).toBe("");
    expect(assembleRolesSystemPrompt(rolesCfg(), new Map(), "anthropic/claude-sonnet-4-6", true)).toBe("");
  });

  it("a role table never produces roles text outside roles mode", () => {
    const roles = resolveRoles(rolesCfg(), "v2");
    expect(buildRolesProtocol(tiersCfg(), roles)).toBe("");
    expect(assembleRolesSystemPrompt(tiersCfg(), roles, "anthropic/claude-sonnet-4-6", true)).toBe("");
  });

  it("the tiers protocol and its R: line ignore routing.delegation", () => {
    for (const model of ["anthropic/claude-sonnet-4-6", "openai/gpt-5", undefined]) {
      for (const enforcementOn of [false, true]) {
        expect(assembleSystemPrompt(rolesCfg(), model, enforcementOn)).toBe(assembleSystemPrompt(tiersCfg(), model, enforcementOn));
      }
    }
    const routing = { engine: "static", applied: { rolesSource: "shipped" }, roles: {} } as unknown as ResolvedRouting;
    const tierLine = buildTaskTaxonomy(tiersCfg());
    expect(generateTaxonomy({ cfg: tiersCfg(), routing, host: "v2", store: null, agents: null })).toBe(tierLine);
    expect(generateTaxonomy({ cfg: tiersCfg(), routing, host: "v2", store: null, agents: null, roles: new Map() })).toBe(tierLine);
    // v1 never takes the roles branch, even when handed a table.
    const roles = resolveRoles(rolesCfg(), "v2");
    expect(generateTaxonomy({ cfg: tiersCfg(), routing, host: "v1", store: null, agents: null, roles })).toBe(tierLine);
  });
});

describe("roles system prompt assembly", () => {
  const cfg = rolesCfg();
  const roles = resolveRoles(cfg, "v2");

  it("a non-Claude orchestrator gets the roles protocol verbatim, plus the DoD section when enforcement is on", () => {
    expect(assembleRolesSystemPrompt(cfg, roles, "openai/gpt-5")).toBe(GOLDEN);
    const on = assembleRolesSystemPrompt(cfg, roles, "openai/gpt-5", true);
    expect(on.startsWith(`${GOLDEN}\n\n---\n\n### Acceptance / Definition of Done`)).toBe(true);
  });

  it("a Claude orchestrator gets the roles opener, never the tiers opener", () => {
    const text = assembleRolesSystemPrompt(cfg, roles, "anthropic/claude-sonnet-4-6");
    expect(text).toBe(`${CLAUDE_ROLES_ORCHESTRATOR_PREFIX}\n\n---\n\n${GOLDEN}`);
    expect(text).not.toMatch(/@(fast|medium|heavy)\b/);
  });
});

describe("roles mode: no per-turn hint part (hint.ts)", () => {
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as WireLogger;
  const tiersProtocol = buildDelegationProtocol(tiersCfg());
  const rolesProtocol = buildRolesProtocol(rolesCfg(), resolveRoles(rolesCfg(), "v2"));

  async function run(cfg: RouterConfig, protocol: string): Promise<{ system: string[]; prepare: ReturnType<typeof vi.fn> }> {
    const prepare = vi.fn(async () => null);
    const augmenter = createSystemAugmenter({ runtime: { prepare } as unknown as EngineRuntime, getSession: vi.fn(), logger });
    const system = ["host part", protocol];
    const added = new Set([protocol]);
    await augmenter.augment({ sessionID: "ses_1", agent: "build", parentModel: "openai/gpt-5", messages: [], cfg }, system, added);
    return { system, prepare };
  }

  it("the roles protocol among the router's parts leaves the system untouched and never prepares the engine", async () => {
    for (const cfg of [rolesCfg(), tiersCfg()]) {
      const { system, prepare } = await run(cfg, rolesProtocol);
      expect(system).toEqual(["host part", rolesProtocol]);
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("QA-P22-1-5: a roles config that falls back to the tiers protocol is augmented like tiers mode", async () => {
    for (const cfg of [rolesCfg(), tiersCfg()]) {
      const { system, prepare } = await run(cfg, tiersProtocol);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(system).toEqual(["host part", tiersProtocol]);
    }
  });

  it("QA-P22-2-4: a router part that embeds the roles heading mid-line (a pending-verification note) does not stop the augmenter", async () => {
    const prepare = vi.fn(async () => null);
    const augmenter = createSystemAugmenter({ runtime: { prepare } as unknown as EngineRuntime, getSession: vi.fn(), logger });
    const pending = `Pending verification: the dispatch quoted "${ROLES_PROTOCOL_HEADING}" in its result.`;
    const system = [pending, tiersProtocol];
    await augmenter.augment({ sessionID: "ses_3", agent: "build", parentModel: "openai/gpt-5", messages: [], cfg: tiersCfg() }, system, new Set([pending, tiersProtocol]));
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("a user part that merely quotes the roles heading does not stop the augmenter", async () => {
    const prepare = vi.fn(async () => null);
    const augmenter = createSystemAugmenter({ runtime: { prepare } as unknown as EngineRuntime, getSession: vi.fn(), logger });
    const system = [`quoted: ${ROLES_PROTOCOL_HEADING}`, tiersProtocol];
    await augmenter.augment({ sessionID: "ses_2", agent: "build", parentModel: "openai/gpt-5", messages: [], cfg: tiersCfg() }, system, new Set([tiersProtocol]));
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
