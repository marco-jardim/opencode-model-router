/**
 * #84 P2.1 T2.1.5: the role dispatch path end to end, with the call shapes the v2 adapter uses (`route()` then `commit()`), a real
 * engine runtime and classifier, the real binding registry and decision log; plus the plugin's hook shapes for E6/E7. Covers:
 * tiers mode untouched, every role × class default, pins, a resume at a higher running rung, explicit models (kept / lifted /
 * pinned over), unknown agent and disabled role, `engine: static`, two plugin instances, a catalog without the tier variant
 * (bare model, next rung, refusal), the runner mark, deferred verification and detection, and the binding rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, validateConfig, type RouterConfig } from "../../src/router/config";
import { resolveRoles } from "../../src/router/roles";
import { DISPATCH_HEADER_PREFIX, stripDispatchHeader } from "../../src/router/dispatch-header";
import { lookupDispatch, markRunnerDispatch, rememberDispatch, resetDispatchRegistry, resetRunnerTokens, runnerDescription } from "../../src/router/sessions";
import { TASK_CLASSES } from "../../src/routing/classify/types";
import { buildRoleLadder, roleTierOrder } from "../../src/routing/engine/ladders";
import { acquireOutcomes } from "../../src/routing/outcomes";
import type { DecisionRow, OutcomesBundle } from "../../src/routing/outcomes/types";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { bind, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import {
  CARRIED_ACCEPTANCE_NOTE, PIN_OVER_CALLER_REASON, RoleDispatchRefusal, VARIANT_NO_CANDIDATE_REASON, createDispatchRouter, pendingResumeRaise, resetDispatchRouting,
  roleAttemptVerification, type RoleAttemptChanges,
  roleEscalationAfterFail, roleGateDeferred, roleGateOutsideWorkRoot, roleMaxActions, routedRoleOf, type DispatchRouter, type RouteOutcome,
} from "../../src/routing/wire/dispatch";
import { createEngineRuntime, type EngineRuntime } from "../../src/routing/wire/runtime";
import { execFileSync } from "node:child_process";
import type { Admission, AdmissionConfig, AdmissionService, RepoLocation } from "../../src/routing/roles/admission";
import { forgetWorkingSet, workingSetOf } from "../../src/routing/wire/working-set";

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

function makeWorld(cfg: RouterConfig, opts: {
  catalog?: Catalog; main?: string; routerVerifyEnabled?: () => boolean;
  createAdmission?: (config: AdmissionConfig) => Pick<AdmissionService, "admit" | "resolve">;
  /** The session directory's worktree top level (`git rev-parse --show-toplevel`); undefined: the real hardened git. */
  showToplevel?: (cwd: string) => Promise<string | undefined>;
  /** Real git for the worktree list, the admission and the toplevel (no fakes). */
  realGit?: boolean;
} = {}): World {
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
    ...(opts.realGit === true ? {} : { listWorktrees: async () => `worktree ${main.replace(/\\/g, "/")}\nHEAD 0\nbranch refs/heads/main\n` }),
    ...(opts.showToplevel === undefined ? {} : { showToplevel: opts.showToplevel }),
    env: {},
    ...(opts.routerVerifyEnabled === undefined ? {} : { routerVerifyEnabled: opts.routerVerifyEnabled }),
    ...(opts.createAdmission === undefined ? {} : { createAdmission: opts.createAdmission }),
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

describe("detection with per-check check roots (P2.5)", () => {
  const detectionOf = async (world: World, checks: string, opts: { verify?: boolean } = {}): Promise<string | undefined> => {
    const verify = opts.verify === false ? "" : "VERIFY: required\n";
    const prompt = `[route class=implement risk=low scope=single needs=edit root=${world.main}]\n${verify}change x\n[acceptance]\n${checks}\n[/acceptance]`;
    return (await world.router.route(call(world, { agent: "implementer", prompt }))).role!.detection;
  };

  it("every check root in W → deterministic", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    mkdirSync(join(world.main, "pkg"), { recursive: true });
    expect(await detectionOf(world, "check: testsPass cwd=pkg\ncheck: fileExists path=x.txt scope=full")).toBe("deterministic");
  });

  it("a check cwd outside W and outside R → not deterministic", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const outside = temp("omr-p25-outside-");
    expect(await detectionOf(world, `check: testsPass cwd=${outside}`)).not.toBe("deterministic");
    expect(await detectionOf(world, "check: testsPass cwd=../escape")).not.toBe("deterministic");
  });

  it("an invalid scope= → not deterministic", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    expect(await detectionOf(world, "check: testsPass scope=everything")).not.toBe("deterministic");
  });

  it("VERIFY:deferred (the default) with per-check keys is not deferred; without keys it is unchanged", async () => {
    const cfg = config({ delegation: "roles", engine: "static" });
    const world = makeWorld(cfg);
    mkdirSync(join(world.main, "pkg"), { recursive: true });
    const keyed = "[acceptance]\ncheck: testsPass cwd=pkg\n[/acceptance]";
    const plain = "[acceptance]\ncheck: testsPass\n[/acceptance]";
    expect(roleGateDeferred(cfg, `change x\n${keyed}`, "")).toBe(false);
    expect(roleGateDeferred(cfg, `change x\n[acceptance]\ncheck: testsPass scope=full\n[/acceptance]`, "")).toBe(false);
    expect(roleGateDeferred(cfg, `change x\n${plain}`, "")).toBe(true);
    expect(await detectionOf(world, "check: testsPass cwd=pkg", { verify: false })).toBe("deterministic");
    expect(await detectionOf(world, "check: testsPass", { verify: false })).not.toBe("deterministic");
  });

  it("roleGateOutsideWorkRoot accepts a check root in the read set and refuses it without one", () => {
    const root = temp("omr-p25-w-");
    const elsewhere = temp("omr-p25-r-");
    const prompt = `change x\n[acceptance]\ncheck: testsPass cwd=${elsewhere}\n[/acceptance]`;
    expect(roleGateOutsideWorkRoot(root, prompt, "")).toBe(true);
    expect(roleGateOutsideWorkRoot(root, prompt, "", undefined, () => false)).toBe(true);
    expect(roleGateOutsideWorkRoot(root, prompt, "", undefined, () => true)).toBe(false);
    expect(roleGateOutsideWorkRoot(root, "change x\n[acceptance]\ncheck: testsPass\n[/acceptance]", "")).toBe(false);
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
    // Q8 (FLIPPED ON PURPOSE: an exactly bound resume used to carry the role header): the resume declares no target, there is no
    // routing.repoParents and its work root is the session directory, so no header; the carried block stays last.
    expect(resumed.prompt!.startsWith(DISPATCH_HEADER_PREFIX)).toBe(false);
    expect(stripDispatchHeader(resumed.prompt!)).toBe(`continue and finish\nVERIFY: required\n${acceptance}`);
    world.router.commit(rc.callID, applied(resumeInput, resumed));
    expect(lookupDispatch("child-w")?.verification).toEqual({ block: acceptance, directives: ["VERIFY: required"] }); // a 2nd resume carries it too
    // A resume naming its own acceptance keeps its own (nothing carried).
    const own = await world.router.route(call(world, { agent: "implementer", sessionID: "child-w", prompt: "fix it\n[acceptance]\ncriteria: the generator runs\n[/acceptance]" }));
    // Q8: no header and nothing carried: the router leaves the resume's prompt untouched (none is returned)
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

  // #84 P3.3 global QA round 2 (area B)
  it("QA-G-B N-a: a resume carries the resumed dispatch's `d=` claim with its block (a d=grader dispatch stays grader)", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const acceptance = "[acceptance]\ncriteria: the parser reports every error with its line\n[/acceptance]";
    const fresh = await freshChild(world, "child-c", {
      agent: "implementer", description: "errors",
      prompt: `[route class=implement risk=low scope=single needs=edit d=grader root=${world.main}]\nimprove the parser errors\n${acceptance}`,
    });
    expect(fresh.role!.detection).toBe("grader");
    const resumed = await world.router.route(call(world, { agent: "implementer", sessionID: "child-c", prompt: "continue and finish" }));
    expect(resumed.role!.detection).toBe("grader"); // was none: the resume's own text names no d=
    expect(lookupDispatch("child-c")?.verification?.claim).toBe("grader");
  });

  // Q9 (FLIPPED ON PURPOSE): this test dispatched with a root= outside the session's worktrees to get a child bound without a work
  // root and resumed it. That fresh dispatch is now REFUSED. A child without a work root can still be created through the router
  // when the session directory cannot be resolved (a dispatch that declares nothing then gets no work root, not a refusal); the
  // resume rule (a resume of an exactly bound child keeps the child's grant, never the resume's own root) is covered by the
  // QA-G-B-1 tests above and the exact-resume target tests below.
  it("QA-G-B N-b / Q9: a fresh dispatch with a root= outside the session's worktrees is refused, so no child is bound without a work root", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const other = temp("omr-g-noroot-");
    const refusal = await world.router.route(call(world, {
      agent: "implementer", description: "no root", prompt: `[route class=implement risk=low scope=single needs=edit root=${other}]\nchange x`,
    })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RoleDispatchRefusal);
    expect((refusal as RoleDispatchRefusal).reason).toContain("neither the session directory nor a worktree");
  });

  describe("Q9 (QA round 3): an exact resume that declares a target", () => {
    const RESUME = (fields: string): string => `[route class=implement risk=low scope=single needs=edit ${fields}]\ncontinue and finish`;
    const refusalOfResume = async (world: World, child: string, prompt: string): Promise<RoleDispatchRefusal | undefined> => {
      const result = await world.router.route(call(world, { agent: "implementer", sessionID: child, prompt })).then(() => undefined, (error: unknown) => error);
      if (result === undefined) return undefined;
      expect(result).toBeInstanceOf(RoleDispatchRefusal);
      return result as RoleDispatchRefusal;
    };

    it("a child bound by root=: the same root proceeds; another root, repo=/branch= or an invalid root= is refused, admission never asked", async () => {
      const resolve = vi.fn(async (): Promise<Admission> => ({ ok: false, reason: "never" }));
      const admit = vi.fn(async (): Promise<Admission> => ({ ok: false, reason: "never" }));
      const created = vi.fn(() => ({ admit, resolve }));
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: created });
      await freshChild(world, "child-q9r", { agent: "implementer", description: "bound", prompt: RESUME(`root=${world.main}`) });
      const refusal = `this child is bound to ${world.main}; a resume cannot change its work root: dispatch a new child`;

      const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-q9r", prompt: RESUME(`root=${world.main}`) }));
      expect(same.role!.workRoot).toBe(world.main);
      expect(same.role!.grant.workRoot).toBe(world.main);
      expect([...same.role!.grant.actions]).toContain("edit");

      const other = temp("omr-q9-resume-other-");
      expect((await refusalOfResume(world, "child-q9r", RESUME(`root=${other}`)))?.reason).toBe(refusal);
      expect((await refusalOfResume(world, "child-q9r", RESUME("branch=main")))?.reason).toBe(refusal); // no location: cannot be shown to match
      expect((await refusalOfResume(world, "child-q9r", RESUME("repo=app")))?.reason).toBe(refusal);
      expect((await refusalOfResume(world, "child-q9r", RESUME("root=../elsewhere")))?.reason).toBe(refusal);
      expect((await refusalOfResume(world, "child-q9r", RESUME("branch=a..b")))?.message)
        .toBe(`[router] role dispatch @implementer refused: ${refusal}`);
      // a resume that declares nothing is untouched
      expect(await refusalOfResume(world, "child-q9r", "continue")).toBeUndefined();
      // D17: a repo= / branch= the text fast path cannot match is resolved like a fresh dispatch's (here: refused by admission, so the
      // resume is refused as before); a root= is not asked to admission without routing.repoParents. Nothing is ever adopted.
      expect(resolve).toHaveBeenCalledTimes(2); // repo=app, branch=main
      expect(admit).not.toHaveBeenCalled();
    });

    it("a child bound by branch= through admission: the same repo=/branch= proceeds without admission; another branch is refused", async () => {
      const resolve = vi.fn(async (input: { repo?: string; branch?: string }): Promise<Admission> => (
        input.branch === "dev" || input.repo === "other"
          ? { ok: false, reason: "no such target" }
          : { ok: true, location: { repository: world.main, name: "app", worktree: world.main, branch: "main", head: "abc1234", worktrees: [] } }
      ));
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit: vi.fn(), resolve }) });
      await freshChild(world, "child-q9b", { agent: "implementer", description: "bound", prompt: RESUME("branch=main") });
      expect(resolve).toHaveBeenCalledTimes(1);

      const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-q9b", prompt: RESUME("repo=app branch=main") }));
      expect(same.role!.workRoot).toBe(world.main);
      expect(same.role!.grant.location).toMatchObject({ name: "app", branch: "main" });
      const byRoot = await world.router.route(call(world, { agent: "implementer", sessionID: "child-q9b", prompt: RESUME(`root=${world.main} branch=main`) }));
      expect(byRoot.role!.workRoot).toBe(world.main);
      expect(resolve).toHaveBeenCalledTimes(1); // the resumes ran no admission

      const refusal = `this child is bound to ${world.main} (repository app, branch main); a resume cannot change its work root: dispatch a new child`;
      expect((await refusalOfResume(world, "child-q9b", RESUME("branch=dev")))?.reason).toBe(refusal);
      expect((await refusalOfResume(world, "child-q9b", RESUME("repo=other")))?.reason).toBe(refusal);
      expect(resolve).toHaveBeenCalledTimes(3); // D17: only the two declarations the text fast path could not match were resolved
    });

    // D17 (cross-repo QA, major): a resume that repeats the route line that bound the child is never refused, whatever the spelling.
    describe("D17: a resume repeating its binding target", () => {
      const locationFor = (name: string, worktree: string, branch: string): RepoLocation =>
        ({ repository: worktree, name, worktree, branch, head: "abc1234", worktrees: [] });

      it("repo=<worktree directory> (Q10: the location's name is the repository's) proceeds; another branch of it is refused", async () => {
        const wt = temp("omr-d17-lib-wt-");
        const other = temp("omr-d17-lib-other-");
        const resolve = vi.fn(async (input: { branch?: string }): Promise<Admission> => ({
          ok: true, location: locationFor("lib-main", input.branch === "dev" ? other : wt, input.branch ?? "feat"),
        }));
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit: vi.fn(), resolve }) });
        await freshChild(world, "child-d17q", { agent: "implementer", description: "bound", prompt: RESUME("repo=lib-wt") });
        expect(resolve).toHaveBeenCalledTimes(1);

        const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17q", prompt: RESUME("repo=lib-wt") }));
        expect(same.role!.workRoot).toBe(wt);
        expect(same.role!.grant.workRoot).toBe(wt); // the grant stays the bound one
        expect(same.role!.grant.location).toMatchObject({ name: "lib-main", worktree: wt });
        expect(resolve).toHaveBeenCalledTimes(2); // the text fast path failed: the declaration was resolved like a fresh dispatch's

        const refusal = await refusalOfResume(world, "child-d17q", RESUME("repo=lib-wt branch=dev"));
        expect(refusal?.reason).toBe(`this child is bound to ${wt} (repository lib-main, branch feat); a resume cannot change its work root: dispatch a new child`);
        expect(resolve).toHaveBeenCalledTimes(3);
      });

      it("repo=<worktree directory> branch=<main branch> bound to the main checkout proceeds when repeated", async () => {
        const resolve = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationFor("lib-main", world.main, "main") }));
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit: vi.fn(), resolve }) });
        await freshChild(world, "child-d17m", { agent: "implementer", description: "bound", prompt: RESUME("repo=lib-wt branch=main") });
        const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17m", prompt: RESUME("repo=lib-wt branch=main") }));
        expect(same.role!.workRoot).toBe(world.main);
        expect(same.role!.grant.workRoot).toBe(world.main);
        expect(same.role!.grant.location).toMatchObject({ name: "lib-main", branch: "main" });
      });

      it("branch=refs/heads/<b> repeated proceeds on the text fast path: admission is not called again", async () => {
        const resolve = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationFor("app", world.main, "main") }));
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit: vi.fn(), resolve }) });
        await freshChild(world, "child-d17r", { agent: "implementer", description: "bound", prompt: RESUME("branch=refs/heads/main") });
        expect(resolve).toHaveBeenCalledTimes(1);
        const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17r", prompt: RESUME("branch=refs/heads/main") }));
        expect(same.role!.workRoot).toBe(world.main);
        const bare = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17r", prompt: RESUME("repo=app branch=main") }));
        expect(bare.role!.workRoot).toBe(world.main);
        expect(resolve).toHaveBeenCalledTimes(1);
      });

      it("a root= spelled through a junction proceeds; a root= that resolves elsewhere is refused; the grant stays the bound one", async () => {
        const parent = temp("omr-d17-parent-");
        const elsewhere = temp("omr-d17-elsewhere-");
        const admit = vi.fn(async (root: string): Promise<Admission> => {
          const real = realpathSync.native(root);
          return { ok: true, location: locationFor("app", real, "main") };
        });
        const world = makeWorld(config({ delegation: "roles", engine: "static", repoParents: [parent] }), {
          createAdmission: () => ({ admit, resolve: vi.fn() }),
        });
        const link = join(temp("omr-d17-link-"), "main-link");
        symlinkSync(world.main, link, "junction");
        await freshChild(world, "child-d17j", { agent: "implementer", description: "bound", prompt: RESUME(`root=${world.main}`) });
        expect(admit).not.toHaveBeenCalled(); // the session directory itself binds by text

        const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17j", prompt: RESUME(`root=${link}`) }));
        expect(same.role!.workRoot).toBe(world.main);
        expect(same.role!.grant.workRoot).toBe(world.main);
        expect(admit).toHaveBeenCalledTimes(1);

        const refusal = await refusalOfResume(world, "child-d17j", RESUME(`root=${elsewhere}`));
        expect(refusal?.reason).toBe(`this child is bound to ${world.main}; a resume cannot change its work root: dispatch a new child`);
      });

      it("the text fast path runs no admission (root= equal to the bound work root)", async () => {
        const parent = temp("omr-d17-parent-");
        const admit = vi.fn(async (): Promise<Admission> => ({ ok: false, reason: "never" }));
        const resolve = vi.fn(async (): Promise<Admission> => ({ ok: false, reason: "never" }));
        const world = makeWorld(config({ delegation: "roles", engine: "static", repoParents: [parent] }), { createAdmission: () => ({ admit, resolve }) });
        await freshChild(world, "child-d17t", { agent: "implementer", description: "bound", prompt: RESUME(`root=${world.main}`) });
        const same = await world.router.route(call(world, { agent: "implementer", sessionID: "child-d17t", prompt: RESUME(`root=${world.main}`) }));
        expect(same.role!.workRoot).toBe(world.main);
        expect(admit).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
      });
    });
  });

  it("QA-G-B-2-1: a carried testsPass is deterministic only once the attempt that introduced it was gated (its change baseline)", async () => {
    const world = makeWorld(config({ delegation: "roles", engine: "static" }));
    const acceptance = "[acceptance]\ncheck: testsPass\n[/acceptance]";
    const fresh = await freshChild(world, "child-t", {
      agent: "implementer", description: "tests",
      prompt: `[route class=implement risk=low scope=single needs=edit root=${world.main}]\nVERIFY: required\nchange the generator\n${acceptance}`,
    });
    expect(fresh.role!.detection).toBe("deterministic");
    const resumeOf = async () => (await world.router.route(call(world, { agent: "implementer", sessionID: "child-t", prompt: "continue and finish" }))).role!;
    // No gate saw attempt 1: its change set is unknown, so the carried testsPass cannot cover it.
    expect((await resumeOf()).detection).not.toBe("deterministic");
    // Attempt 1's gate recorded its change baseline: the resume is judged on the cumulative change set.
    roleAttemptVerification("child-t", {
      changedFiles: [{ path: join(world.main, "gen.ts"), status: "written" }], changeBaseline: "available", reference: { kind: "none", reason: "test" },
    }, { carried: false });
    const resumed = await resumeOf();
    expect(resumed.carried).toBe(true);
    expect(resumed.detection).toBe("deterministic");
  });

  describe("QA-G-B-2-1 / I7: a carried acceptance is judged on the tree its introducing attempt was gated on", () => {
    const REF = { kind: "none" as const, reason: "test" };
    const SWITCH = "the working tree X switched from branch main to branch feat/x during the dispatch; the checks would verify another branch";
    const INHERITED = "the working tree X switched from branch main to branch inherited during the dispatch; the checks would verify another branch";
    const snapOf = (world: World, head: string, branch?: string | null) => ({ cwd: world.main, root: world.main, head, ...(branch === undefined ? {} : { branch }) });
    const acceptanceChild = (world: World, child: string) => freshChild(world, child, {
      agent: "implementer", description: "tests",
      prompt: `[route class=implement risk=low scope=single needs=edit root=${world.main}]\nVERIFY: required\nchange the generator\n[acceptance]\ncheck: testsPass\n[/acceptance]`,
    });
    /** Route and commit the "continue and finish" resume of `child`: it carries the acceptance (the baseline is re-registered). */
    const attemptOf = (world: World, head: string, branch?: string | null, branchSwitch?: string): RoleAttemptChanges => ({
      changedFiles: [], changeBaseline: "available", reference: REF, snapshot: snapOf(world, head, branch), ...(branchSwitch === undefined ? {} : { branchSwitch }),
    });
    async function resume(world: World, child: string): Promise<void> {
      const input = { agent: "implementer", sessionID: child, prompt: "continue and finish" };
      const rc = call(world, input);
      const routed = await world.router.route(rc);
      expect(routed.role!.carried).toBe(true);
      world.router.commit(rc.callID, applied(input, routed));
    }

    it("carries the branch switch and the snapshot of the attempt through: own, carried without a baseline, carried with one", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-i1");
      const snapshot = snapOf(world, "A", "main");
      const prepared = attemptOf(world, "A", "main", SWITCH);
      // Own path.
      expect(roleAttemptVerification("child-i1", prepared, { carried: false })).toMatchObject({ branchSwitch: SWITCH, snapshot });
      // Carried with a baseline, the current tree on another branch: the switch of this very dispatch takes precedence.
      const onOther = attemptOf(world, "A", "other", SWITCH);
      expect(roleAttemptVerification("child-i1", onOther, { carried: true })).toMatchObject({ branchSwitch: SWITCH, snapshot: onOther.snapshot });
      // Carried without a baseline (the introducing attempt was never gated).
      await acceptanceChild(world, "child-i2");
      const noBaseline = roleAttemptVerification("child-i2", prepared, { carried: true });
      expect(noBaseline).toMatchObject({ branchSwitch: SWITCH, snapshot, changeBaseline: "unavailable" });
    });

    it("a carried attempt on another branch than the introducing attempt's is a switch; staying on the branch is not", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-l1");
      await acceptanceChild(world, "child-l2");
      const own = (child: string) => roleAttemptVerification(child, attemptOf(world, "A", "main"), { carried: false });
      own("child-l1"); own("child-l2");
      await resume(world, "child-l1"); await resume(world, "child-l2"); // the baseline goes through frozenVerification
      const carried = (child: string, branch: string) => roleAttemptVerification(child, attemptOf(world, "A", branch), { carried: true });
      expect(carried("child-l1", "other").branchSwitch).toMatch(/switched from branch main to branch other since the attempt that introduced this acceptance/);
      expect(carried("child-l2", "main").branchSwitch).toBeUndefined();
    });

    it("a switch found during the introducing attempt is inherited by the carried attempts, even on the branch the tree came back to", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-h");
      roleAttemptVerification("child-h", attemptOf(world, "A", "main", INHERITED), { carried: false });
      await resume(world, "child-h");
      const carried = roleAttemptVerification("child-h", attemptOf(world, "A", "main"), { carried: true });
      expect(carried.branchSwitch).toBe(`in an earlier attempt of this acceptance: ${INHERITED}`);
    });

    it("B3: a switch found by a carried attempt is recorded and inherited by the next carried attempt, even back on the branch", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-b3");
      roleAttemptVerification("child-b3", attemptOf(world, "A", "main"), { carried: false });
      await resume(world, "child-b3");
      // Carried attempt 2 finds a switch of its own.
      expect(roleAttemptVerification("child-b3", attemptOf(world, "A", "other", SWITCH), { carried: true }).branchSwitch).toBe(SWITCH);
      await resume(world, "child-b3");
      // Carried attempt 3: no switch of its own, the tree is back on main.
      const third = roleAttemptVerification("child-b3", attemptOf(world, "A", "main"), { carried: true });
      expect(third.branchSwitch).toBeDefined();
      expect(third.branchSwitch).toContain(SWITCH);
    });

    it("B9: a carried attempt with a recorded tree but no current snapshot cannot confirm the branch, and names the recorded root", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-b9");
      roleAttemptVerification("child-b9", attemptOf(world, "A", "main"), { carried: false });
      await resume(world, "child-b9");
      const blind: RoleAttemptChanges = { ...attemptOf(world, "A", "main"), snapshot: undefined };
      expect(roleAttemptVerification("child-b9", blind, { carried: true }).branchSwitch).toBe(
        `cannot confirm the branch of ${world.main}: the working tree could not be read for this carried attempt, so the checks could verify another branch. Send a fresh [acceptance] block, or re-dispatch.`);
    });

    it("B11: an inherited switch reason carries the 'earlier attempt' prefix exactly once across carried attempts", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-b11");
      const PREFIX = "in an earlier attempt of this acceptance: ";
      roleAttemptVerification("child-b11", attemptOf(world, "A", "main", INHERITED), { carried: false });
      await resume(world, "child-b11");
      expect(roleAttemptVerification("child-b11", attemptOf(world, "A", "main"), { carried: true }).branchSwitch).toBe(`${PREFIX}${INHERITED}`);
      await resume(world, "child-b11");
      const second = roleAttemptVerification("child-b11", attemptOf(world, "A", "main"), { carried: true }).branchSwitch;
      expect(second).toBe(`${PREFIX}${INHERITED}`);
      expect(second!.split(PREFIX)).toHaveLength(2);
      // A switch found by the carried attempt itself is returned unprefixed.
      await acceptanceChild(world, "child-b11b");
      roleAttemptVerification("child-b11b", attemptOf(world, "A", "main"), { carried: false });
      await resume(world, "child-b11b");
      expect(roleAttemptVerification("child-b11b", attemptOf(world, "A", "other", SWITCH), { carried: true }).branchSwitch).toBe(SWITCH);
    });

    it("QA2 F3c: an own attempt that could not confirm its branch is not the lineage's switch; a later readable carried attempt on the branch has none", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-f3c");
      const UNCONFIRMED = `cannot confirm the branch of ${world.main}: the working tree could not be read when the dispatch started, so the checks could verify another branch. Re-dispatch, or send a fresh [acceptance] block.`;
      // The own attempt still reports its own reason to its own gate ...
      expect(roleAttemptVerification("child-f3c", attemptOf(world, "A", "main", UNCONFIRMED), { carried: false }).branchSwitch).toBe(UNCONFIRMED);
      await resume(world, "child-f3c");
      // ... but it is not recorded: the carried attempt, readable and on the same branch, inherits nothing.
      expect(roleAttemptVerification("child-f3c", attemptOf(world, "A", "main"), { carried: true }).branchSwitch).toBeUndefined();
      // The same for a carried attempt that itself could not confirm: it is not recorded for the next one either.
      await resume(world, "child-f3c");
      expect(roleAttemptVerification("child-f3c", attemptOf(world, "A", "main", UNCONFIRMED), { carried: true }).branchSwitch).toBe(UNCONFIRMED);
      await resume(world, "child-f3c");
      expect(roleAttemptVerification("child-f3c", attemptOf(world, "A", "main"), { carried: true }).branchSwitch).toBeUndefined();
    });

    it("control: carried attempts on the same branch with snapshots record no switch", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-ctl");
      roleAttemptVerification("child-ctl", attemptOf(world, "A", "main"), { carried: false });
      await resume(world, "child-ctl");
      expect(roleAttemptVerification("child-ctl", attemptOf(world, "A", "main"), { carried: true }).branchSwitch).toBeUndefined();
      await resume(world, "child-ctl");
      expect(roleAttemptVerification("child-ctl", attemptOf(world, "B", "main"), { carried: true }).branchSwitch).toBeUndefined();
    });

    it("the unattributed writers of the introducing attempt are unioned into the carried attempts (P0.3)", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      await acceptanceChild(world, "child-w1");
      await acceptanceChild(world, "child-w2");
      const withWriters = (...writers: string[]): RoleAttemptChanges => ({ ...attemptOf(world, "A", "main"), ...(writers.length > 0 ? { unattributedWriters: writers } : {}) });
      // Own attempts: the writers of the attempt itself are returned.
      expect(roleAttemptVerification("child-w1", withWriters("bash"), { carried: false }).unattributedWriters).toEqual(["bash"]);
      roleAttemptVerification("child-w2", withWriters("bash"), { carried: false });
      await resume(world, "child-w1"); await resume(world, "child-w2"); // the baseline goes through frozenVerification
      // A carried attempt that ran nothing unobservable still reports the introducing attempt's writers.
      expect(roleAttemptVerification("child-w1", withWriters(), { carried: true }).unattributedWriters).toEqual(["bash"]);
      // A carried attempt with another tool: the union, sorted and without duplicates.
      expect(roleAttemptVerification("child-w2", withWriters("router_run"), { carried: true }).unattributedWriters).toEqual(["bash", "router_run"]);
    });
  });
});

// ---------------------------------------------------------------------------
// E6 / E7 through the plugin's hook shapes
// ---------------------------------------------------------------------------

describe("cross-repo P1.4: the work root bound through admission", () => {
  beforeEach(() => forgetWorkingSet("root"));
  afterEach(() => forgetWorkingSet("root"));

  it("[route … repo=<name>] binds that repository below routing.repoParents: the location on the grant, the working set updated", async () => {
    const parent = temp("omr-p14-parent-");
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(parent, name));
      execFileSync("git", ["init", "-q", "-b", "main", join(parent, name)], { stdio: "ignore" });
    }
    const beta = realpathSync.native(join(parent, "beta"));
    const world = makeWorld(config({ delegation: "roles", engine: "static", repoParents: [parent] }));
    const outcome = await world.router.route(call(world, {
      agent: "implementer", prompt: "[route class=implement risk=low scope=single needs=edit repo=beta]\nchange x",
    }));
    expect(outcome.role!.workRoot).toBe(beta);
    expect(outcome.role!.grant.workRoot).toBe(beta);
    expect(outcome.role!.grant.location).toMatchObject({ name: "beta", repository: beta, worktree: beta, branch: "main" });
    expect([...outcome.role!.grant.actions]).toContain("edit");
    expect(workingSetOf("root").map((location) => location.worktree)).toEqual([beta]);
  });

  it("I9: without routing.repoParents and without repo=/branch= no admission is built; branch= alone builds one (once per config) and asks it", async () => {
    const created: AdmissionConfig[] = [];
    const reason = "repo=main branch=feat: no worktree of main is on feat (main): no work root.";
    const resolve = vi.fn(async (): Promise<Admission> => ({ ok: false, reason }));
    const admit = vi.fn(async (): Promise<Admission> => ({ ok: false, reason: "never" }));
    const world = makeWorld(config({ delegation: "roles", engine: "static" }), {
      createAdmission: (admissionConfig) => {
        created.push(admissionConfig);
        return { admit, resolve };
      },
    });
    const plain = await world.router.route(call(world, {
      agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${world.main}]\nchange x`,
    }));
    expect(plain.role!.workRoot).toBe(world.main);
    expect(plain.role!.grant.location).toBeUndefined();
    expect(created).toEqual([]);

    // Q9 (FLIPPED ON PURPOSE: the refused branch= used to give a null work root and no edit; the dispatch is now refused)
    const branched = await world.router.route(call(world, { agent: "implementer", prompt: "[route class=implement risk=low scope=single needs=edit branch=feat]\nchange x" })).catch((error: unknown) => error);
    expect(branched).toBeInstanceOf(RoleDispatchRefusal);
    expect((branched as RoleDispatchRefusal).reason).toBe(reason);
    expect((branched as RoleDispatchRefusal).message).toBe(`[router] role dispatch @implementer refused: ${reason}`);
    expect(resolve).toHaveBeenCalledWith({ branch: "feat" }, { sessionRepository: world.main, known: [world.main] });
    await world.router.route(call(world, { agent: "implementer", prompt: "[route class=implement risk=low scope=single needs=edit branch=feat]\nchange y" })).catch(() => undefined);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(1);
    expect(created[0]?.parents).toEqual([]);
    expect(admit).not.toHaveBeenCalled();
    expect(workingSetOf("root")).toEqual([]);
  });

  const locationOf = (worktree: string): RepoLocation => ({ repository: worktree, name: "app", worktree, branch: "main", head: "abc1234", worktrees: [] });
  const EDIT_PROMPT = (fields: string): string => `[route class=implement risk=low scope=single needs=edit ${fields}]\nchange x`;

  describe("QA round 1", () => {
    /** Q9: the refusal a dispatch ends in (undefined when it was routed). */
    const refusalOf = async (world: World, prompt: string): Promise<RoleDispatchRefusal | undefined> => {
      const result = await world.router.route(call(world, { agent: "implementer", prompt })).then(() => undefined, (error: unknown) => error);
      if (result === undefined) return undefined;
      expect(result).toBeInstanceOf(RoleDispatchRefusal);
      return result as RoleDispatchRefusal;
    };

    // Q9 (FLIPPED ON PURPOSE: an invalid branch= / repo= used to give a null work root and a note on the outcome; the dispatch
    // is now refused with that note).
    it("F3 / Q9: an invalid branch= / repo= refuses the dispatch with the note; admission is never asked", async () => {
      const resolve = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationOf("never") }));
      const admit = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationOf("never") }));
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit, resolve }) });
      const badBranch = await refusalOf(world, EDIT_PROMPT("branch=a..b"));
      expect(badBranch?.reason).toBe("branch=a..b is not a valid branch name: no work root. Fix the route line.");
      expect(badBranch?.message).toBe("[router] role dispatch @implementer refused: branch=a..b is not a valid branch name: no work root. Fix the route line.");
      const badRepo = await refusalOf(world, EDIT_PROMPT("repo=.dotfiles branch=main"));
      expect(badRepo?.reason).toContain("repo=.dotfiles is not a valid repository name: no work root. Fix the route line.");
      const dup = await refusalOf(world, EDIT_PROMPT("branch=main branch=other"));
      expect(dup?.reason).toContain("branch=other is not a valid branch name: no work root. Fix the route line.");
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });

    // QA round 3 (Q9): an invalid root= used to be an ignored key: no declared target, so the dispatch ran in the session directory
    // WITH edit. It is an invalid declaration now, refused like an invalid repo= / branch=.
    it("Q9: an invalid, bare, duplicate or unbalanced root= refuses the dispatch with the note; admission is never asked", async () => {
      const resolve = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationOf("never") }));
      const admit = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationOf("never") }));
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit, resolve }) });
      const note = (value: string): string => `root=${value} is not a valid absolute work root: no work root. Fix the route line.`;
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["root=../app-b", "../app-b"],
        ["root=D:\\git\\x\\..\\y", "D:\\git\\x\\..\\y"],
        ["root=\\\\host\\share\\r", "\\\\host\\share\\r"],
        ["root=D:git\\r", "D:git\\r"],
        ["root", ""],
        ["root=\"D:\\My Work", "\"D:\\My"],
        [`root=${world.main} root=D:\\b`, "D:\\b"],
      ];
      for (const [fields, value] of cases) {
        const refusal = await refusalOf(world, EDIT_PROMPT(fields));
        expect(refusal?.reason, fields).toBe(note(value));
        expect(refusal?.message, fields).toBe(`[router] role dispatch @implementer refused: ${note(value)}`);
      }
      expect(resolve).not.toHaveBeenCalled();
      expect(admit).not.toHaveBeenCalled();
    });

    it("Q9: the refusal note is escaped before it reaches the orchestrator (no bidi or control text)", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }));
      const refusal = await refusalOf(world, EDIT_PROMPT("root=rel\u202edir"));
      expect(refusal).toBeInstanceOf(RoleDispatchRefusal);
      expect(refusal?.reason).not.toContain("\u202e");
      expect(refusal?.message).not.toContain("\u202e");
      expect(refusal?.reason).toContain("is not a valid absolute work root: no work root. Fix the route line.");
    });

    it("Q9: an unknown repo= is refused with admission's note; a route line without repo=/branch=/root= is not refused", async () => {
      const reason = "repo=ghost is not a repository below routing.repoParents: no work root.";
      const resolve = vi.fn(async (): Promise<Admission> => ({ ok: false, reason }));
      const admit = vi.fn(async (): Promise<Admission> => ({ ok: false, reason }));
      const parent = temp("omr-q9-parent-");
      const world = makeWorld(config({ delegation: "roles", engine: "static", repoParents: [parent] }), { createAdmission: () => ({ admit, resolve }) });
      const unknown = await refusalOf(world, EDIT_PROMPT("repo=ghost"));
      expect(unknown?.reason).toBe(reason);
      expect(unknown?.message).toBe(`[router] role dispatch @implementer refused: ${reason}`);
      expect(await refusalOf(world, "[route class=implement risk=low scope=single needs=edit]\nchange x")).toBeUndefined();
      expect(await refusalOf(world, "change x")).toBeUndefined();
    });

    it("F3: a git-valid but unusual branch (renovate/foo+bar) is bound through admission", async () => {
      const resolve = vi.fn(async (): Promise<Admission> => ({ ok: true, location: locationOf(world.main) }));
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), { createAdmission: () => ({ admit: vi.fn(), resolve }) });
      const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=renovate/foo+bar") }));
      expect(resolve).toHaveBeenCalledWith({ branch: "renovate/foo+bar" }, expect.anything());
      expect(outcome.role!.workRoot).toBe(world.main);
    });

    it("F9: without routing.repoParents a bound branch= does not grow the working set", async () => {
      const world = makeWorld(config({ delegation: "roles", engine: "static" }), {
        createAdmission: () => ({ admit: vi.fn(), resolve: async (): Promise<Admission> => ({ ok: true, location: locationOf(world.main) }) }),
      });
      const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=main") }));
      expect(outcome.role!.workRoot).toBe(world.main);
      expect(outcome.role!.grant.location).toBeDefined();
      expect(workingSetOf("root")).toEqual([]);
    });

    it("F5: with routing.repoParents the working set gets the GRANT's location once the dispatch is accepted", async () => {
      const parent = temp("omr-qa1-parent-");
      const world = makeWorld(config({ delegation: "roles", engine: "static", repoParents: [parent] }), {
        createAdmission: () => ({ admit: vi.fn(), resolve: async (): Promise<Admission> => ({ ok: true, location: locationOf(world.main) }) }),
      });
      const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=main") }));
      expect(workingSetOf("root")).toEqual([outcome.role!.grant.location]);
    });

    describe("F6: the session started in a subdirectory", () => {
      const subWorld = (): { world: World; top: string; sub: string; resolve: ReturnType<typeof vi.fn> } => {
        const top = temp("omr-qa1-top-");
        const sub = join(top, "sub");
        mkdirSync(sub);
        // the real admission refuses a `root=` that is not a worktree root; without `root=` it answers by branch
        const resolve = vi.fn(async (decl: { root?: string }): Promise<Admission> => decl.root === undefined
          ? { ok: true, location: locationOf(top) } : { ok: false, reason: `root=${decl.root} is not a worktree root: no work root.` });
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { main: sub, showToplevel: async () => top, createAdmission: () => ({ admit: vi.fn(), resolve }) });
        return { world, top, sub, resolve };
      };

      it("branch= alone keeps the session directory as the work root; the location is the worktree's", async () => {
        const { world, top, sub } = subWorld();
        const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=main") }));
        expect(outcome.role!.workRoot).toBe(sub);
        expect(outcome.role!.grant.location?.worktree).toBe(top);
      });

      it("root=<session directory> branch= is accepted when the worktree on that branch contains it", async () => {
        const { world, top, sub, resolve } = subWorld();
        const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT(`root="${sub}" branch=main`) }));
        expect(outcome.role!.workRoot).toBe(sub);
        expect(outcome.role!.requestedRoot).toBe(sub);
        expect(outcome.role!.grant.location?.worktree).toBe(top);
        expect(resolve).toHaveBeenCalledTimes(2);
      });

      it("root=<session directory> branch= is still refused when the branch's worktree does not contain it", async () => {
        const { sub } = subWorld();
        const elsewhere = temp("omr-qa1-else-");
        const resolve = vi.fn(async (decl: { root?: string }): Promise<Admission> => decl.root === undefined
          ? { ok: true, location: locationOf(elsewhere) } : { ok: false, reason: "root mismatch: no work root." });
        const other = makeWorld(config({ delegation: "roles", engine: "static" }), { main: sub, createAdmission: () => ({ admit: vi.fn(), resolve }) });
        // Q9 (FLIPPED ON PURPOSE: used to be a null work root with the note on the outcome; now the dispatch is refused with it)
        const refusal = await refusalOf(other, EDIT_PROMPT(`root="${sub}" branch=main`));
        expect(refusal?.reason).toBe("root mismatch: no work root.");
      });
    });

    describe("QA round 2: the session directory must belong to the bound worktree (real git)", () => {
      const git = (cwd: string, ...args: string[]): void => {
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd, stdio: "ignore" });
      };
      const repoWithFeatWorktree = (): { top: string; feat: string } => {
        const top = temp("omr-qa2-top-");
        git(top, "init", "-q", "-b", "main");
        git(top, "commit", "--allow-empty", "-q", "-m", "init");
        mkdirSync(join(top, ".wt"));
        git(top, "worktree", "add", "-q", join(top, ".wt", "feat"), "-b", "feat");
        return { top, feat: realpathSync.native(join(top, ".wt", "feat")) };
      };

      it("(a) a session in a worktree nested inside main's, with branch=main: never the nested worktree under main's location", async () => {
        const { top, feat } = repoWithFeatWorktree();
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { main: feat, realGit: true });
        const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=main") }));
        expect(outcome.role!.workRoot).not.toBe(feat);
        expect(outcome.role!.grant.location?.worktree).toBe(top);
        expect(outcome.role!.workRoot).toBe(top);
      });

      it("(b) root=<session directory> branch=main with the session in the nested worktree is refused", async () => {
        const { feat } = repoWithFeatWorktree();
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { main: feat, realGit: true });
        // Q9 (FLIPPED ON PURPOSE: used to be a null work root without edit; now the dispatch is refused)
        const refusal = await refusalOf(world, EDIT_PROMPT(`root="${feat}" branch=main`));
        expect(refusal).toBeDefined();
        expect(refusal?.reason).toContain("no work root");
      });

      it("(c) a plain subdirectory of main with branch=main keeps the session directory as the work root", async () => {
        const { top } = repoWithFeatWorktree();
        const sub = join(top, "sub");
        mkdirSync(sub);
        const world = makeWorld(config({ delegation: "roles", engine: "static" }), { main: sub, realGit: true });
        const outcome = await world.router.route(call(world, { agent: "implementer", prompt: EDIT_PROMPT("branch=main") }));
        expect(outcome.role!.workRoot).toBe(sub);
        expect(outcome.role!.grant.location?.worktree).toBe(top);
      });
    });
  });
});

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
