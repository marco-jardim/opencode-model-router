/**
 * #84 P2.1 T2.1.5: the role dispatch path end to end, with the call shapes the v2 adapter uses (`route()` then `commit()`), a real
 * engine runtime and classifier, the real binding registry and decision log; plus the plugin's hook shapes for E6/E7. Covers:
 * tiers mode untouched, every role × class default, pins, a resume at a higher running rung, explicit models (kept / lifted /
 * pinned over), unknown agent and disabled role, `engine: static`, two plugin instances, a catalog without the tier variant
 * (bare model, next rung, refusal), the runner mark, deferred verification and detection, and the binding rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, validateConfig, type RouterConfig } from "../../src/router/config";
import { resolveRoles } from "../../src/router/roles";
import { lookupDispatch, markRunnerDispatch, rememberDispatch, resetDispatchRegistry, resetRunnerTokens, runnerDescription } from "../../src/router/sessions";
import { TASK_CLASSES } from "../../src/routing/classify/types";
import { buildRoleLadder, roleTierOrder } from "../../src/routing/engine/ladders";
import { acquireOutcomes } from "../../src/routing/outcomes";
import type { DecisionRow, OutcomesBundle } from "../../src/routing/outcomes/types";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { bind, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import {
  CARRIED_ACCEPTANCE_NOTE, PIN_OVER_CALLER_REASON, RoleDispatchRefusal, VARIANT_NO_CANDIDATE_REASON, createDispatchRouter, pendingResumeRaise, resetDispatchRouting,
  roleEscalationAfterFail, roleGateDeferred, roleMaxActions, routedRoleOf, type DispatchRouter, type RouteOutcome,
} from "../../src/routing/wire/dispatch";
import { createEngineRuntime, type EngineRuntime } from "../../src/routing/wire/runtime";

const bundled = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")) as Record<string, unknown>;
const logger = { warn: vi.fn() };

function config(routing: Record<string, unknown>, extra: Record<string, unknown> = {}): RouterConfig {
  return validateConfig({ ...bundled, activePreset: "anthropic", ...extra, routing });
}

/** `provider/model[#variant]` of a tier's first role rung. */
function tierRef(cfg: RouterConfig, tier: string): string {
  const c = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "probe", window: { floor: tier, ceiling: tier, pinned: null } }).candidates[0]!;
  return c.variant === null || c.variant === "default" ? c.model : `${c.model}#${c.variant}`;
}

type Catalog = Array<{ providerID: string; id: string; variants: Array<{ id: string }>; limit: { context: number; output: number }; cost: never[] }>;

/** Every rung model of the active preset, with its variants unless `withVariants` is false. */
function catalogOf(cfg: RouterConfig, withVariants = true): Catalog {
  const byModel = new Map<string, Set<string>>();
  for (const tier of ["fast", "medium", "heavy"]) {
    const [model, variant] = tierRef(cfg, tier).split("#") as [string, string | undefined];
    const set = byModel.get(model) ?? new Set<string>();
    if (variant !== undefined) set.add(variant);
    byModel.set(model, set);
  }
  return [...byModel].map(([model, variants]) => {
    const [providerID, id] = model.split("/") as [string, string];
    return { providerID, id, variants: withVariants ? [...variants].map((v) => ({ id: v })) : [], limit: { context: 200_000, output: 32_000 }, cost: [] };
  });
}

interface World {
  cfg: RouterConfig;
  router: DispatchRouter;
  runtime: EngineRuntime;
  main: string;
  bundle: () => OutcomesBundle | null;
  rows(): Promise<DecisionRow[]>;
}

const cleanups: Array<() => Promise<void>> = [];
const temps: string[] = [];
let seq = 0;

function temp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function makeWorld(cfg: RouterConfig, opts: { catalog?: Catalog; main?: string; routerVerifyEnabled?: () => boolean } = {}): World {
  const main = opts.main ?? temp("omr-p21-int-main-");
  let captured: OutcomesBundle | null = null;
  const runtime = createEngineRuntime({
    loadConfig: () => cfg,
    listAgents: async () => [],
    listModels: async () => opts.catalog ?? catalogOf(cfg),
    logger,
    acquire: (options) => {
      captured = acquireOutcomes(options);
      return captured;
    },
  });
  const session = { id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [], location: { directory: main } };
  const router = createDispatchRouter({
    runtime,
    getSession: async (id) => (id === "root" ? session : { id, parentID: "root", agent: "explorer", location: { directory: main } }),
    graderAgent: "router-grader",
    directory: main,
    logger,
    listWorktrees: async () => `worktree ${main.replace(/\\/g, "/")}\nHEAD 0\nbranch refs/heads/main\n`,
    env: {},
    ...(opts.routerVerifyEnabled === undefined ? {} : { routerVerifyEnabled: opts.routerVerifyEnabled }),
  });
  cleanups.push(async () => { await runtime.dispose(); });
  return {
    cfg, router, runtime, main,
    bundle: () => captured,
    async rows() {
      const bundle = captured;
      if (bundle === null) return [];
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows.filter((row): row is DecisionRow => row.kind === "decision");
    },
  };
}

function call(world: World, args: Record<string, unknown>) {
  return { callID: `int-${++seq}`, sessionID: "root", agent: "build", args: { description: "work item", ...args }, cfg: world.cfg } as const;
}

function applied(input: Record<string, unknown>, outcome: RouteOutcome): Record<string, unknown> {
  return {
    ...input,
    ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
    ...(outcome.model === undefined ? {} : { model: outcome.model }),
    ...(outcome.description === undefined ? {} : { description: outcome.description }),
  };
}

const outcomesDir = (): Record<string, unknown> => ({ outcomes: { path: temp("omr-p21-int-outcomes-") } });

beforeEach(() => {
  resetDispatchRouting();
  resetDispatchRegistry();
  resetBindingRegistryForTests();
  resetIngestState();
  resetRunnerTokens();
  logger.warn.mockClear();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
  invalidateConfigCache();
});

describe("tiers mode is untouched (I1)", () => {
  it("a role-named agent in tiers mode takes the tier path (static: untouched)", async () => {
    const world = makeWorld(config({ delegation: "tiers", engine: "static" }));
    for (const agent of ["explorer", "implementer", "general"]) {
      const c = call(world, { agent, prompt: "[route class=implement risk=low scope=single]\nchange x", model: "anthropic/anything" });
      expect(await world.router.route(c), agent).toEqual({ mode: "static" });
      expect(routedRoleOf(c.callID)).toBeUndefined();
    }
  });

  it("roles mode: an unknown agent and a disabled role take the tier path", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }, { roleAgents: { researcher: { enabled: false } } }));
    for (const agent of ["no-such-agent", "researcher", "medium"]) {
      const c = call(world, { agent, prompt: "find x" });
      expect(await world.router.route(c), agent).toEqual({ mode: "static" });
    }
  });
});

describe("role × class defaults, pins, resumes and explicit models", () => {
  it("every enabled role and every class: the static default inside the window, on its tier's rung", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const order = roleTierOrder(world.cfg);
    for (const spec of resolveRoles(world.cfg, "v2").values()) {
      for (const cls of TASK_CLASSES) {
        const outcome = await world.router.route(call(world, { agent: spec.agent, prompt: `[route class=${cls} risk=low scope=single]\ndo the ${cls} work` }));
        const role = outcome.role!;
        const at = order.indexOf(role.tier);
        expect([spec.agent, cls, at >= order.indexOf(role.window.floor) && at <= order.indexOf(role.window.ceiling)]).toEqual([spec.agent, cls, true]);
        expect(order.indexOf(role.window.floor)).toBeGreaterThanOrEqual(order.indexOf(spec.tierRange.floor));
        expect(outcome.model).toBe(tierRef(world.cfg, role.tier));
      }
    }
  });

  it("pins: inside → honoured, below the floor → lifted, above the ceiling → clamped", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const pin = async (agent: string, line: string) => (await world.router.route(call(world, { agent, prompt: `${line}\nwork` }))).role!;
    expect((await pin("implementer", `[route class=implement risk=low scope=single needs=edit tier=heavy root=${world.main}]`)).tier).toBe("heavy");
    expect((await pin("implementer", `[route class=implement risk=low scope=single needs=edit tier=fast root=${world.main}]`)).tier).toBe("medium");
    expect((await pin("explorer", "[route class=search risk=low scope=single tier=heavy]")).tier).toBe("medium");
  });

  it("a resume at a higher running rung never moves below it", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "enforce", ...outcomesDir() }));
    const [model, variant] = tierRef(world.cfg, "heavy").split("#") as [string, string | undefined];
    rememberDispatch("child-h", {
      facts: { class: "implement", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      agent: "implementer", model, variant: variant ?? null, tier: "heavy", parentSessionID: "root", decisionID: "d-h", step: "dispatch", picked: "implementer",
    });
    const outcome = await world.router.route(call(world, { agent: "implementer", prompt: "[route class=mechanical risk=low scope=single tier=fast]\ncontinue", sessionID: "child-h" }));
    expect(outcome.role!.tier).toBe("heavy");
    expect(outcome.model).toBe(tierRef(world.cfg, "heavy"));
  });

  it("explicit models: kept inside the bounds, lifted below them; a route-line pin wins over the caller model (QA-P21-1-5)", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "enforce", ...outcomesDir() }));
    const kept = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind x", model: tierRef(world.cfg, "medium") }));
    expect(kept.model).toBe(tierRef(world.cfg, "medium"));
    const lifted = await world.router.route(call(world, { agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${world.main}]\nchange x`, model: tierRef(world.cfg, "fast") }));
    expect(lifted.model).toBe(tierRef(world.cfg, "medium"));
    const input = { agent: "explorer", prompt: "[route class=search risk=low scope=single tier=fast]\nfind y", model: tierRef(world.cfg, "medium") };
    const c = call(world, input);
    const pinned = await world.router.route(c);
    expect(pinned.role!.window.pinned).toBe("fast");
    expect(pinned.model).toBe(tierRef(world.cfg, "fast"));
    world.router.commit(c.callID, applied(input, pinned));
    const row = (await world.rows()).find((r) => r.decisionID === pinned.decisionID);
    expect(row?.reason.startsWith(PIN_OVER_CALLER_REASON)).toBe(true);
  });
});

describe("engines, instances and the runner", () => {
  it("engine static in roles mode: the router still sets the model, and writes no row", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const input = { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind x" };
    const c = call(world, input);
    const outcome = await world.router.route(c);
    expect(outcome.model).toBe(tierRef(world.cfg, outcome.role!.tier));
    expect(outcome.decisionID).toBeUndefined();
    world.router.commit(c.callID, applied(input, outcome));
    expect(world.bundle()).toBeNull();
  });

  it("two plugin instances: only the first routes a call (A3)", async () => {
    const cfg = config({ delegation: "roles", engine: "static" });
    const first = makeWorld(cfg);
    const second = makeWorld(cfg, { main: first.main });
    const c = call(first, { agent: "explorer", prompt: "find x" });
    expect((await first.router.route(c)).role).toBeDefined();
    expect(await second.router.route(c)).toEqual({ mode: "static" });
  });

  it("a call the delegate runner announced is left alone (the runner mark)", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "enforce", ...outcomesDir() }));
    const prompt = "[route class=search risk=low scope=single]\nfind x";
    markRunnerDispatch({ parentSessionID: "root", agent: "explorer", prompt });
    const c = call(world, { agent: "explorer", prompt, description: runnerDescription("explorer") });
    expect(await world.router.route(c)).toEqual({ mode: "static" });
    expect(routedRoleOf(c.callID)).toBeUndefined();
  });
});

describe("a catalog without the tier variant (QA-P21-1-6)", () => {
  /** A preset whose medium rung is a variant of the fast model: the bare model ranks as fast. */
  function variantWorld(heavyVariants: string[]) {
    const cfg = config({ delegation: "roles", engine: "enforce", ...outcomesDir() }, {
      activePreset: "vtest",
      presets: {
        ...(bundled.presets as Record<string, unknown>),
        vtest: {
          fast: { model: "p/x", costRatio: 1, description: "fast" },
          medium: { model: "p/x", variant: "high", costRatio: 5, description: "medium" },
          heavy: { model: "p/y", variant: "max", costRatio: 20, description: "heavy" },
        },
      },
    });
    const catalog: Catalog = [
      { providerID: "p", id: "x", variants: [], limit: { context: 200_000, output: 32_000 }, cost: [] },
      { providerID: "p", id: "y", variants: heavyVariants.map((id) => ({ id })), limit: { context: 200_000, output: 32_000 }, cost: [] },
    ];
    return makeWorld(cfg, { catalog });
  }
  const medium = (world: World) => ({ agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${world.main}]\nchange x` });

  it("bundled preset: the bare tier model is kept when it reaches the floor", async () => {
    const cfg = config({ delegation: "roles", engine: "static" });
    const world = makeWorld(cfg, { catalog: catalogOf(cfg, false) });
    const outcome = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single tier=medium]\nfind x" }));
    expect(outcome.model).toBe(tierRef(cfg, "medium").split("#")[0]);
  });

  it("the bare model ranks below the window floor: the next window rung present in the catalog is dispatched", async () => {
    const world = variantWorld(["max"]);
    const input = medium(world);
    const c = call(world, input);
    const outcome = await world.router.route(c);
    expect(outcome.role!.window.floor).toBe("medium");
    expect(outcome.model).toBe("p/y#max");
    expect(outcome.role!.tier).toBe("heavy");
    expect(outcome.role!.notes.some((note) => note.includes("ranks below the window floor"))).toBe(true);
    world.router.commit(c.callID, applied(input, outcome));
    const row = (await world.rows()).find((r) => r.decisionID === outcome.decisionID)!;
    expect(row.capability?.dispatched).not.toBeNull();
  });

  it("no window rung present at or above the floor: the role dispatch is refused", async () => {
    const world = variantWorld([]);
    const refusal = await world.router.route(call(world, medium(world))).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RoleDispatchRefusal);
    expect((refusal as RoleDispatchRefusal).reason).toContain(VARIANT_NO_CANDIDATE_REASON);
  });
});

describe("detection and binding rows", () => {
  it("QA-P21-1-2: a deferred testsPass acceptance is not router-gated; VERIFY: required is", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const acceptance = "[acceptance]\ncheck: testsPass\n[/acceptance]";
    const deferred = await world.router.route(call(world, { agent: "implementer", prompt: `[route class=implement risk=low scope=single]\nchange x\n${acceptance}` }));
    expect(deferred.role!.detection).not.toBe("deterministic");
    const required = await world.router.route(call(world, { agent: "implementer", prompt: `[route class=implement risk=low scope=single]\nVERIFY: required\nchange x\n${acceptance}` }));
    expect(required.role!.detection).toBe("deterministic");
  });

  it("QA-P21-1-11: a fresh row claims no binding; the observed kind is written when the child binds, once", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "enforce", ...outcomesDir() }));
    const exactInput = { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind x" };
    const exactCall = call(world, exactInput);
    const exact = await world.router.route(exactCall);
    world.router.commit(exactCall.callID, applied(exactInput, exact));
    world.router.noteBinding("child-e", { kind: "exact", decisionID: exact.decisionID! });
    world.router.noteBinding("child-e", { kind: "exact", decisionID: exact.decisionID! });

    const unknownInput = { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind y", description: "find y" };
    const unknownCall = call(world, unknownInput);
    const unknown = await world.router.route(unknownCall);
    world.router.commit(unknownCall.callID, applied(unknownInput, unknown));
    world.router.onSessionCreated({ sessionID: "child-u", parentID: "root", agent: "explorer", title: unknown.description });
    world.router.noteBinding("child-u", { kind: "unknown", decisionID: null });

    const rows = await world.rows();
    const dispatchRows = rows.filter((r) => !r.reason.startsWith("note:"));
    for (const row of dispatchRows) expect(row.binding).toBeUndefined();
    const notes = rows.filter((r) => r.reason.startsWith("note:binding:"));
    expect(notes.map((r) => [r.decisionID, r.childSessionID, r.reason, r.binding])).toEqual([
      [exact.decisionID, "child-e", "note:binding:exact", "exact"],
      [unknown.decisionID, "child-u", "note:binding:unknown", "unknown"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// QA round 2 of P2.1: the resume path
// ---------------------------------------------------------------------------

describe("QA round 2: the resume path", () => {
  const maxOf = (cfg: RouterConfig) => (agent: string) => roleMaxActions(resolveRoles(cfg, "v2").get(agent));

  it("QA-P21-2-1: an exactly bound child keeps its grant on a resume — edit + the widened router_run is a write+exec floor, never fast", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const acceptance = `VERIFY: required\n[acceptance]\ncheck: fileExists path=${join(world.main, "out.txt")}\n[/acceptance]`;
    const input = { agent: "general", prompt: `[route class=mechanical risk=low scope=single needs=edit root=${world.main}]\nfix a typo in one comment of src/a.ts\n${acceptance}`, description: "typo" };
    const c = call(world, input);
    const fresh = await world.router.route(c);
    expect(fresh.role!.detection).toBe("deterministic");
    expect(fresh.role!.tier).toBe("fast"); // write without exec, deterministic, low/single
    world.router.commit(c.callID, applied(input, fresh));
    world.router.onSessionCreated({ sessionID: "child-g", parentID: "root", agent: "general", title: fresh.description });
    const binding = await bind("child-g", async () => ({ parentID: "root", agent: "general", title: fresh.description!, firstText: fresh.prompt! }), { maxOf: maxOf(world.cfg) });
    expect(binding.kind).toBe("exact");
    expect([...binding.grant.actions]).toContain("edit");
    const resume = async (prompt: string) => (await world.router.route({ ...call(world, { agent: "general", sessionID: "child-g", prompt }), widened: ["router_run"] })).role!;
    const deterministic = await resume(`continue\n${acceptance}`);
    expect([...deterministic.grant.actions]).toEqual(expect.arrayContaining(["edit", "router_run"]));
    expect(deterministic.tier).toBe("medium"); // write + exec, deterministic
    // QA-G-B-1: this pinned the defect (`heavy`: the resume's own text, "continue", has no acceptance). A resume without its own
    // [acceptance] carries the resumed dispatch's (and its VERIFY: lines): still write + exec, deterministic → medium.
    const plain = await resume("continue");
    expect(plain.detection).toBe("deterministic");
    expect(plain.tier).toBe("medium");
  });

  it("QA-P21-2-2: a raise recorded after a FAIL is applied by that parent's next resume only, once", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const [model, variant] = tierRef(world.cfg, "fast").split("#") as [string, string | undefined];
    rememberDispatch("child-x", {
      facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      agent: "explorer", model, variant: variant ?? null, tier: "fast", parentSessionID: "root", step: "dispatch", picked: "explorer",
    });
    const hint = roleEscalationAfterFail(world.cfg, "child-x", "root");
    expect(hint).toContain("the router raises it to medium");
    expect(pendingResumeRaise("child-x", "another-parent")).toBeNull();
    expect(pendingResumeRaise("child-x", "root")).toBe("medium");
    const resume = async () => (await world.router.route(call(world, { agent: "explorer", sessionID: "child-x", prompt: "[route class=search risk=low scope=single]\naddress the findings" }))).role!;
    const raised = await resume();
    expect(raised.window.floor).toBe("medium");
    expect(raised.tier).toBe("medium");
    expect(pendingResumeRaise("child-x", "root")).toBeNull();
    expect((await resume()).window.floor).toBe("fast"); // consumed once
  });

  it("QA-P21-2 nit 3: without router_verify nothing is deferred, so the router's gate backs a deterministic detection", async () => {
    const cfg = config({ delegation: "roles", engine: "static" });
    const prompt = "[route class=implement risk=low scope=single]\nchange x\n[acceptance]\ncheck: testsPass\n[/acceptance]";
    expect(roleGateDeferred(cfg, prompt, "")).toBe(true);
    expect(roleGateDeferred(cfg, prompt, "", { verifyEnabled: false })).toBe(false);
    const withVerify = makeWorld(cfg);
    expect((await withVerify.router.route(call(withVerify, { agent: "implementer", prompt }))).role!.detection).not.toBe("deterministic");
    const withoutVerify = makeWorld(cfg, { routerVerifyEnabled: () => false });
    expect((await withoutVerify.router.route(call(withoutVerify, { agent: "implementer", prompt }))).role!.detection).toBe("deterministic");
  });
});

// ---------------------------------------------------------------------------
// #84 P3.3 global QA round 1 (QA-G-B-1, QA-G-B nit N1)
// ---------------------------------------------------------------------------

describe("P3.3 global QA round 1: resumes keep the resumed dispatch's facts and acceptance", () => {
  const maxOf = (cfg: RouterConfig) => (agent: string) => roleMaxActions(resolveRoles(cfg, "v2").get(agent));

  /** A fresh dispatch committed, claimed by `child` and bound exactly to it; the routed outcome. */
  async function freshChild(world: World, child: string, input: { agent: string; prompt: string; description: string }) {
    const c = call(world, input);
    const fresh = await world.router.route(c);
    world.router.commit(c.callID, applied(input, fresh));
    world.router.onSessionCreated({ sessionID: child, parentID: "root", agent: input.agent, title: fresh.description });
    const binding = await bind(child, async () => ({ parentID: "root", agent: input.agent, title: fresh.description!, firstText: fresh.prompt! }), { maxOf: maxOf(world.cfg) });
    expect(binding.kind).toBe("exact");
    return fresh;
  }

  it("QA-G-B-1: a 'continue' resume of a high-risk local child with edit widened is floored on the child's risk (heavy), under its class", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "shadow", ...outcomesDir() }));
    const fresh = await freshChild(world, "child-s", { agent: "general", prompt: "[route class=search risk=high]\nlook at how the parser reports errors", description: "look" });
    expect([...fresh.role!.grant.actions]).not.toContain("edit");
    expect(lookupDispatch("child-s")?.facts).toMatchObject({ class: "search", risk: "high" });
    const resumeInput = { agent: "general", sessionID: "child-s", prompt: "continue" };
    const rc = { ...call(world, resumeInput), widened: ["edit" as const] };
    const resumed = await world.router.route(rc);
    expect([...resumed.role!.grant.actions]).toContain("edit");
    expect(resumed.role!.window.floor).toBe("heavy"); // write without exec, no detection, risk high (§2.3); was medium on "continue"'s own risk
    expect(resumed.role!.class).toBe("search");
    world.router.commit(rc.callID, applied(resumeInput, resumed));
    const row = (await world.rows()).find((r) => r.decisionID === resumed.decisionID)!;
    expect(row.facts).toMatchObject({ class: "search", risk: "high" });
    expect(lookupDispatch("child-s")?.facts).toMatchObject({ class: "search", risk: "high" });
  });

  it("QA-G-B-1: an attempt raised after a FAIL is recorded under the class the child was dispatched under", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "shadow", ...outcomesDir() }));
    await freshChild(world, "child-f", { agent: "general", prompt: "[route class=search risk=low scope=single]\nfind where the lexer is built", description: "find" });
    expect(lookupDispatch("child-f")?.tier).toBe("fast");
    expect(roleEscalationAfterFail(world.cfg, "child-f", "root")).toContain("the router raises it to medium");
    const resumeInput = { agent: "general", sessionID: "child-f", prompt: "[route class=debug risk=low scope=single]\naddress the findings" };
    const rc = call(world, resumeInput);
    const raised = await world.router.route(rc);
    expect(raised.role!.tier).toBe("medium");
    expect(raised.role!.class).toBe("search");
    world.router.commit(rc.callID, applied(resumeInput, raised));
    expect(lookupDispatch("child-f")).toMatchObject({ tier: "medium", facts: { class: "search" } });
  });

  it("QA-G-B-1: a budget resume ('continue and finish') of a write+exec child with deterministic acceptance keeps the original floor and is verified on it", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const acceptance = `[acceptance]\ncheck: fileExists path=${join(world.main, "out.txt")}\n[/acceptance]`;
    const fresh = await freshChild(world, "child-w", {
      agent: "implementer", description: "build",
      prompt: `[route class=implement risk=low scope=single needs=edit,shell root=${world.main}]\nVERIFY: required\nbuild the generator and run its script\n${acceptance}`,
    });
    expect([...fresh.role!.grant.actions]).toEqual(expect.arrayContaining(["edit", "router_run"]));
    expect(fresh.role!.detection).toBe("deterministic");
    expect(fresh.role!.window.floor).toBe("medium"); // write + exec, deterministic
    expect(lookupDispatch("child-w")?.verification).toEqual({ block: acceptance, directives: ["VERIFY: required"] });
    const resumeInput = { agent: "implementer", sessionID: "child-w", prompt: "continue and finish" };
    const rc = call(world, resumeInput);
    const resumed = await world.router.route(rc);
    expect(resumed.role!.detection).toBe("deterministic");
    expect(resumed.role!.window.floor).toBe("medium"); // was heavy: write + exec without detection
    expect(resumed.role!.notes).toContain(CARRIED_ACCEPTANCE_NOTE);
    // The router's gate verifies the resume on the same acceptance: it is carried in the prompt the host runs.
    expect(resumed.prompt).toBe(`continue and finish\nVERIFY: required\n${acceptance}`);
    world.router.commit(rc.callID, applied(resumeInput, resumed));
    expect(lookupDispatch("child-w")?.verification).toEqual({ block: acceptance, directives: ["VERIFY: required"] }); // a 2nd resume carries it too
    // A resume naming its own acceptance keeps its own (nothing carried).
    const own = await world.router.route(call(world, { agent: "implementer", sessionID: "child-w", prompt: "fix it\n[acceptance]\ncriteria: the generator runs\n[/acceptance]" }));
    expect(own.prompt).toBeUndefined();
    expect(own.role!.notes).not.toContain(CARRIED_ACCEPTANCE_NOTE);
  });

  it("QA-G-B nit N1: an explicit caller model that wins after an exploration draw is recorded as no exploration", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "enforce", exploration: { rate: 0.2 }, ...outcomesDir() }));
    const medium = tierRef(world.cfg, "medium");
    // explorer (fast..medium), class review: the static default is medium, the floor fast — the draw can go down to fast.
    const prompt = `[route class=review risk=low scope=single]\nVERIFY: required\nreview the parser\n[acceptance]\ncheck: fileExists path=${join(world.main, "x.txt")}\n[/acceptance]`;
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const input = { agent: "explorer", prompt, model: medium };
      const c = call(world, input);
      const outcome = await world.router.route(c);
      expect(outcome.model).toBe(medium); // the caller's model wins every time
      world.router.commit(c.callID, applied(input, outcome));
      ids.push(outcome.decisionID!);
    }
    const rows = (await world.rows()).filter((r) => ids.includes(r.decisionID));
    expect(rows).toHaveLength(60);
    const drawn = rows.filter((r) => /[[;] ?explore[;\]]/.test(r.reason)); // the kernel's own draw (its reason list)
    expect(drawn.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.explore).toBe(false);
      expect(row.reason.startsWith("kept:caller-model")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// E6 / E7 through the plugin's hook shapes
// ---------------------------------------------------------------------------

describe("E6/E7 through the hook shapes", () => {
  async function rolesPlugin(): Promise<Record<string, any>> {
    const home = temp("omr-p21-int-home-");
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "1");
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ routing: { delegation: "roles" } }));
    invalidateConfigCache();
    const hooks = await ModelRouterPlugin({
      directory: home, worktree: home, routerHost: "v2",
      client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) } },
    } as unknown as RouterPluginInput) as Record<string, any>;
    cleanups.push(async () => { await hooks.dispose?.(); });
    return hooks;
  }

  /** Distinct reads by `agent` in `child` until a guard blocks one; the index and message of the block. */
  async function readUntilBlocked(hooks: Record<string, any>, child: string, agent: string, max: number) {
    for (let i = 0; i < max; i++) {
      const args = { filePath: `/x/${child}-${i}.ts` };
      try {
        await hooks["tool.execute.before"]({ tool: "read", sessionID: child, agent, callID: `${child}-${i}` }, { args });
      } catch (error) {
        return { at: i, message: String(error) };
      }
      await hooks["tool.execute.after"]({ tool: "read", sessionID: child, agent, callID: `${child}-${i}`, args }, { title: "", output: "x", metadata: {} });
    }
    return null;
  }

  it("E6: a reader role is never denied for reading; a producer role hits the read/draft guard. E7: the reader's budget is its role budget", async () => {
    const hooks = await rolesPlugin();
    const cfg = config({ delegation: "roles" });
    const explorer = resolveRoles(cfg, "v2").get("explorer")!;
    const reader = await readUntilBlocked(hooks, "e6-reader", "explorer", 200);
    expect(reader?.at).toBe(explorer.budget[explorer.tierRange.floor]);
    expect(reader?.message).not.toContain("read/draft budget exhausted");
    const producer = await readUntilBlocked(hooks, "e6-producer", "implementer", 200);
    expect(producer).not.toBeNull();
    expect(producer?.message).toContain("read/draft budget exhausted");
  });
});
