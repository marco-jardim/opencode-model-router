// #84 P2.1 T2.1.2: the role dispatch path of `src/routing/wire/dispatch.ts`, driven with the call shapes the v2 adapter uses
// (`route({ callID: event.id, sessionID, agent, args, tierModel, cfg })`, then `commit(event.id, event.input)`). Real runtime,
// real classifier (rules), real binding registry; git and the clock of the work-root check are injected. Temp directories only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, type RouterConfig } from "../../src/router/config";
import { rememberDispatch, resetDispatchRegistry } from "../../src/router/sessions";
import { buildRoleLadder } from "../../src/routing/engine/ladders";
import { acquireOutcomes } from "../../src/routing/outcomes";
import type { DecisionRow, OutcomesBundle } from "../../src/routing/outcomes/types";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { bind, bindingRegistrySize, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import {
  ROLE_REFUSALS,
  RoleDispatchRefusal,
  createDispatchRouter,
  nextRoleTier,
  normalizeRootText,
  parseWorktreeList,
  resetDispatchRouting,
  resolveRoleWorkRoot,
  roleEscalationHint,
  roleEscalationHintFor,
  roleMaxActions,
  routedRoleOf,
  routedWorkRoot,
  type DispatchRouter,
  type RouteOutcome,
} from "../../src/routing/wire/dispatch";
import { createEngineRuntime, type EngineRuntime } from "../../src/routing/wire/runtime";
import { resolveRoles } from "../../src/router/roles";

const bundled = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")) as Record<string, unknown>;
const logger = { warn: vi.fn() };
const PACKAGE_JSON = realpathSync.native(join(process.cwd(), "package.json"));

function config(routing: Record<string, unknown>, extra: Record<string, unknown> = {}): RouterConfig {
  return validateConfig({ ...bundled, activePreset: "anthropic", ...extra, routing });
}

/** `provider/model[#variant]` of a tier's first role rung (what the role path sets for a dispatch on that tier). */
function tierRef(cfg: RouterConfig, tier: string): string {
  const ladder = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "probe", window: { floor: tier, ceiling: tier, pinned: null } });
  const c = ladder.candidates[0]!;
  return c.variant === null || c.variant === "default" ? c.model : `${c.model}#${c.variant}`;
}

/** A catalog listing every rung model of the preset with its variants (or with none). */
function catalogOf(cfg: RouterConfig, withVariants: boolean) {
  const byModel = new Map<string, Set<string>>();
  for (const tier of ["fast", "medium", "heavy"]) {
    const ref = tierRef(cfg, tier);
    const [model, variant] = ref.split("#") as [string, string | undefined];
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
  worktree: string;
  outside: string;
  listModels: ReturnType<typeof vi.fn>;
  listWorktrees: ReturnType<typeof vi.fn>;
  realpath: ReturnType<typeof vi.fn>;
  session: Record<string, unknown>;
  bundle: () => OutcomesBundle | null;
  rows(): Promise<DecisionRow[]>;
}

const cleanups: Array<() => Promise<void>> = [];
let seq = 0;

function makeWorld(routing: Record<string, unknown>, opts: { extra?: Record<string, unknown>; variants?: boolean; bypassed?: boolean; env?: Record<string, string> } = {}): World {
  const main = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-p21b-main-")));
  const worktree = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-p21b-wt-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-p21b-out-")));
  const outcomes = mkdtempSync(join(tmpdir(), "omr-p21b-outcomes-"));
  const cfg = config({ outcomes: { path: outcomes }, ...routing }, opts.extra ?? {});
  let captured: OutcomesBundle | null = null;
  const listModels = vi.fn(async () => catalogOf(cfg, opts.variants ?? true));
  const runtime = createEngineRuntime({
    loadConfig: () => cfg,
    listAgents: async () => [],
    listModels,
    logger,
    acquire: (options) => {
      captured = acquireOutcomes(options);
      return captured;
    },
  });
  const listWorktrees = vi.fn(async (_cwd: string) =>
    `worktree ${main.replace(/\\/g, "/")}\nHEAD 0123\nbranch refs/heads/main\n\nworktree ${worktree.replace(/\\/g, "/")}\nHEAD 4567\nbranch refs/heads/wt\n`);
  const realpath = vi.fn((path: string) => realpathSync.native(path));
  const session: Record<string, unknown> = {
    id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "xhigh" },
    permissions: [], location: { directory: main },
  };
  const router = createDispatchRouter({
    runtime,
    getSession: async (id) => (id === "root" ? session : { id, parentID: "root", agent: "explorer", location: { directory: main } }),
    graderAgent: "router-grader",
    directory: main,
    logger,
    listWorktrees,
    realpath,
    isBypassed: () => opts.bypassed === true,
    env: opts.env ?? {},
  });
  cleanups.push(async () => {
    await runtime.dispose();
    for (const dir of [main, worktree, outside, outcomes]) rmSync(dir, { recursive: true, force: true });
  });
  return {
    cfg, router, runtime, main, worktree, outside, listModels, listWorktrees, realpath, session,
    bundle: () => captured,
    async rows() {
      const bundle = captured;
      if (bundle === null) return [];
      await bundle.flusher.flushNow();
      return (await bundle.persister.readRows()).rows.filter((row): row is DecisionRow => row.kind === "decision");
    },
  };
}

/** One `subagent` call in the adapter's legacy vocabulary, as `execute.before` hands it to `route()`. */
function call(world: World, args: Record<string, unknown>) {
  const callID = `call-${++seq}`;
  return { callID, sessionID: "root", agent: "build", args: { description: "work item", ...args }, cfg: world.cfg } as const;
}

/** What the adapter does with the outcome, then the input the host executes (`commit`). */
function applied(input: Record<string, unknown>, outcome: RouteOutcome): Record<string, unknown> {
  return {
    ...input,
    ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
    ...(outcome.model === undefined ? {} : { model: outcome.model }),
    ...(outcome.description === undefined ? {} : { description: outcome.description }),
  };
}

beforeEach(() => {
  resetDispatchRouting();
  resetDispatchRegistry();
  resetBindingRegistryForTests();
  resetIngestState();
  logger.warn.mockClear();
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("tiers mode and tier agents are untouched (I1)", () => {
  it("tiers mode: a role-named agent takes the tier path (static: untouched, no host call)", async () => {
    const world = makeWorld({ delegation: "tiers", engine: "static" });
    const c = call(world, { agent: "explorer", prompt: "find the config loader" });
    expect(await world.router.route(c)).toEqual({ mode: "static" });
    expect(await world.runtime.prepareRoles!("explorer", world.cfg)).toBeNull();
    expect(world.listModels).not.toHaveBeenCalled();
    expect(world.listWorktrees).not.toHaveBeenCalled();
    expect(routedRoleOf(c.callID)).toBeUndefined();
  });

  it("roles mode: a tier agent, an unknown agent and a disabled role keep the tier path", async () => {
    const world = makeWorld({ delegation: "roles", engine: "static" }, { extra: { roleAgents: { researcher: { enabled: false } } } });
    expect(resolveRoles(world.cfg, "v2").has("researcher")).toBe(false);
    for (const agent of ["medium", "no-such-agent", "researcher"]) {
      const c = call(world, { agent, prompt: "[route class=implement risk=low scope=single]\nchange x" });
      expect(await world.router.route(c), agent).toEqual({ mode: "static" });
      expect(routedRoleOf(c.callID), agent).toBeUndefined();
    }
  });
});

describe("role dispatch path", () => {
  it("static engine: the static default inside the bounds, nonce markers at the anchors, no row, an exact binding", async () => {
    const world = makeWorld({ delegation: "roles", engine: "static" });
    const input = { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind where the config is loaded\nreport file:line", description: "find loader" };
    const c = call(world, input);
    const outcome = await world.router.route(c);
    const role = outcome.role!;
    expect(outcome.mode).toBe("static");
    expect(role.agent).toBe("explorer");
    expect(role.window).toMatchObject({ floor: "fast", ceiling: "medium" });
    expect(["fast", "medium"]).toContain(role.tier);
    expect(outcome.model).toBe(tierRef(world.cfg, role.tier));
    expect(outcome.decisionID).toBeUndefined();
    expect(role.decisionID).toBeNull();
    // markers: the nonce line is the LAST prompt line, the suffix the END of the description; the route line is stripped
    expect(role.nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    const lines = outcome.prompt!.split("\n");
    expect(lines[lines.length - 1]).toBe(`OMR_NONCE=${role.nonce}`);
    expect(outcome.prompt!.startsWith("find where the config is loaded\nreport file:line\n")).toBe(true);
    expect(outcome.description).toBe(`find loader [nonce ${role.nonce}]`);
    // the work root without root= is the session directory (canonical long form)
    expect(role.workRoot).toBe(world.main);
    expect(routedWorkRoot(c.callID)).toBe(world.main);
    expect(world.listWorktrees).not.toHaveBeenCalled();

    world.router.commit(c.callID, applied({ ...input, description: "find loader" }, outcome));
    expect(world.bundle()).toBeNull(); // static: no store, no rows
    const binding = await bind("child-1", async () => ({ parentID: "root", agent: "explorer", title: outcome.description!, firstText: outcome.prompt! }), {
      maxOf: (name) => roleMaxActions(resolveRoles(world.cfg, "v2").get(name)),
    });
    expect(binding.kind).toBe("exact");
    expect(binding.budget).toBe(role.budget);
    expect([...binding.grant.actions]).toEqual(["read", "glob", "grep", "router_git"]);
  });

  it("enforce: an implementer in a listed worktree gets the canonical root, edit, the authority floor and a row with the role extension", async () => {
    const world = makeWorld({ delegation: "roles", engine: "enforce" });
    // Another spelling of the same worktree: upper-cased only where paths are case-insensitive (win32); elsewhere a different case is a different path.
    const spelled = world.worktree.replace(/\\/g, "/");
    const rootText = `${process.platform === "win32" ? spelled.toUpperCase() : spelled}/`;
    const input = { agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${rootText}]\nadd a guard to parse()` };
    const c = call(world, input);
    const outcome = await world.router.route(c);
    const role = outcome.role!;
    if (process.platform === "win32") expect(role.workRoot).toBe(world.worktree);
    expect([...role.grant.actions]).toContain("edit");
    expect(role.tier).toBe("medium"); // write without exec, detection none → medium (§2.3)
    expect(outcome.model).toBe(tierRef(world.cfg, "medium"));
    expect(outcome.mode).toBe("enforce");
    expect(outcome.decisionID).toBe(role.decisionID);
    expect(world.listWorktrees).toHaveBeenCalledWith(world.main);

    world.router.commit(c.callID, applied(input, outcome));
    const rows = await world.rows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      kind: "decision", mode: "enforce", decisionID: role.decisionID, role: "implementer", tier: "medium",
      explore: false, propensity: 1, resume: false, childSessionID: null,
      detection: { effective: "none" },
    });
    // QA-P21-1-11: a fresh dispatch row claims no binding; the child's observed kind is written when it binds (noteBinding).
    expect(row.binding).toBeUndefined();
    expect(row.grant).toEqual([...role.grant.actions].sort());
    expect(Array.isArray(row.boundsReasons)).toBe(true);
    expect(row.boundsReasons).toContain("floor:authority");
    expect(row.chosen.key.startsWith("implement|role:implementer|")).toBe(true);
    expect(row.chosen.origin).toBe("role");
  });

  it("root= outside the session's worktrees: no work root, a note, write withheld — and no filesystem call on it", async () => {
    const world = makeWorld({ delegation: "roles", engine: "static" });
    const input = { agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${world.outside}]\nchange x` };
    const outcome = await world.router.route(call(world, input));
    const role = outcome.role!;
    expect(role.workRoot).toBeNull();
    expect(role.requestedRoot).toBe(world.outside);
    expect(role.notes.some((note) => note.includes("neither the session directory nor a worktree"))).toBe(true);
    expect([...role.grant.actions]).not.toContain("edit");
    expect(world.realpath).not.toHaveBeenCalledWith(world.outside);
  });

  it("a malformed first route line refuses the role dispatch (never a fallback)", async () => {
    const world = makeWorld({ delegation: "roles", engine: "enforce" });
    const c = call(world, { agent: "implementer", prompt: "[route class=implement risk=low\nchange x" });
    const refusal = await world.router.route(c).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RoleDispatchRefusal);
    expect((refusal as RoleDispatchRefusal).reason).toBe(ROLE_REFUSALS.malformed);
    expect(routedRoleOf(c.callID)).toBeUndefined();
    world.router.commit(c.callID, { agent: "implementer", prompt: "x" }); // nothing was decided: no row
    expect(await world.rows()).toHaveLength(0);
  });

  it("a tier= pin above the ceiling is clamped into the window", async () => {
    const world = makeWorld({ delegation: "roles", engine: "advise" });
    const outcome = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single tier=heavy]\nfind x" }));
    expect(outcome.role!.tier).toBe("medium");
    expect(outcome.role!.window.pinned).toBe("medium");
    expect(outcome.model).toBe(tierRef(world.cfg, "medium"));
  });

  it("an explicit caller model is kept inside the bounds, lifted to the floor below them, clamped above the ceiling", async () => {
    const world = makeWorld({ delegation: "roles", engine: "enforce" });
    const kept = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind x", model: tierRef(world.cfg, "medium") }));
    expect(kept.role!.tier).toBe("medium");
    expect(kept.model).toBe(tierRef(world.cfg, "medium"));

    const lifted = await world.router.route(call(world, { agent: "implementer", prompt: `[route class=implement risk=low scope=single needs=edit root=${world.worktree}]\nchange x`, model: tierRef(world.cfg, "fast") }));
    expect(lifted.role!.window.floor).toBe("medium");
    expect(lifted.role!.tier).toBe("medium");
    expect(lifted.model).toBe(tierRef(world.cfg, "medium"));

    const clamped = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single]\nfind y", model: tierRef(world.cfg, "heavy") }));
    expect(clamped.role!.tier).toBe("medium");
  });

  it("a resume never moves below the child's running tier and registers no pending entry", async () => {
    const world = makeWorld({ delegation: "roles", engine: "enforce" });
    const [model, variant] = tierRef(world.cfg, "medium").split("#") as [string, string | undefined];
    rememberDispatch("child-r", {
      facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      agent: "explorer", model, variant: variant ?? null, tier: "medium", parentSessionID: "root", decisionID: "d0", step: "dispatch", picked: "explorer",
    });
    const before = bindingRegistrySize().pending;
    const input = { agent: "explorer", prompt: "find the rest", sessionID: "child-r" };
    const c = call(world, input);
    const outcome = await world.router.route(c);
    expect(outcome.role!.tier).toBe("medium");
    expect(outcome.role!.window.floor).toBe("medium");
    expect(outcome.role!.nonce).toBeNull();
    expect(outcome.description).toBeUndefined();
    expect(outcome.prompt).toBeUndefined(); // nothing stripped, no nonce line on a resume
    world.router.commit(c.callID, applied(input, outcome));
    expect(bindingRegistrySize().pending).toBe(before);
    const rows = await world.rows();
    expect(rows[0]).toMatchObject({ resume: true, childSessionID: "child-r", switched: false, explore: false });
    expect(rows[0]!.reason.startsWith("kept:resume")).toBe(true);
  });

  it("a catalog without the tier variant: the variant is dropped, the tier model kept", async () => {
    const world = makeWorld({ delegation: "roles", engine: "static" }, { variants: false });
    const outcome = await world.router.route(call(world, { agent: "explorer", prompt: "[route class=search risk=low scope=single tier=medium]\nfind x" }));
    const ref = tierRef(world.cfg, "medium");
    expect(outcome.model).toBe(ref.split("#")[0]);
    if (ref.includes("#")) expect(outcome.role!.notes.some((note) => note.includes("is not in the host catalog"))).toBe(true);
  });

  it("effective detection: deterministic only when the router's gate runs the acceptance checks (S10/P-9); none when nothing verifies (QA-G-B-7)", async () => {
    const prompt = `[route class=implement risk=low scope=single needs=edit d=deterministic]\nchange x\n[acceptance]\ncheck: fileExists path=${PACKAGE_JSON}\n[/acceptance]`;
    const on = makeWorld({ delegation: "roles", engine: "static" });
    expect((await on.router.route(call(on, { agent: "implementer", prompt }))).role!.detection).toBe("deterministic");
    // QA-G-B-7: these three pinned the defect (`grader`) — enforcement off, /bypass and `require: never` run no verification at all.
    const off = makeWorld({ delegation: "roles", engine: "static" }, { extra: { enforcement: { mode: "off" } } });
    expect((await off.router.route(call(off, { agent: "implementer", prompt }))).role!.detection).toBe("none");
    const bypassed = makeWorld({ delegation: "roles", engine: "static" }, { bypassed: true });
    expect((await bypassed.router.route(call(bypassed, { agent: "implementer", prompt }))).role!.detection).toBe("none");
    const never = makeWorld({ delegation: "roles", engine: "static" }, { extra: { enforcement: { verify: { require: "never" } } } });
    expect((await never.router.route(call(never, { agent: "implementer", prompt }))).role!.detection).toBe("none");
    // A gate that runs but cannot back `deterministic` (a criteria-only block: the checker) stays `grader`.
    const criteria = `[route class=implement risk=low scope=single needs=edit d=grader]\nchange x\n[acceptance]\ncriteria: the change is minimal\n[/acceptance]`;
    expect((await on.router.route(call(on, { agent: "implementer", prompt: criteria }))).role!.detection).toBe("grader");
    // …and a cwd outside the root the gate verifies in runs nothing either (the gate refuses it: unverifiable).
    expect((await on.router.route(call(on, { agent: "implementer", prompt: criteria, cwd: on.outside }))).role!.detection).toBe("none");
  });

  it("a delegate's dispatch is not parsed, but runs on the floor rung of the local-only window (QA-P21-1-1)", async () => {
    const world = makeWorld({ delegation: "roles", engine: "enforce" });
    world.session.parentID = "grand-parent";
    const outcome = await world.router.route(call(world, { agent: "explorer", prompt: "[route tier=medium]\nfind x", model: tierRef(world.cfg, "medium") }));
    expect(outcome.prompt).toBeUndefined(); // the route line is not parsed or stripped
    expect(outcome.description).toBeUndefined(); // no nonce, no pending entry
    expect(outcome.role!.tier).toBe("fast");
    expect(outcome.model).toBe(tierRef(world.cfg, "fast"));
  });

  // #84 P3.3 DF-2 (live): the authority-ladder probe dispatched `general` into a sibling worktree; the classifier ran in the SESSION
  // directory, so the probe file's absolute path inside the worktree read as `external_dir`.
  it("QA-G-B-3: the DF-2 ladder probe — classified in its own root: no edit, no external_dir, a local grant; the matched need terms are traced", async () => {
    const world = makeWorld({ delegation: "roles", engine: "shadow" });
    const file = join(world.worktree, "tmp.txt");
    const prompt = `[route class=other risk=low scope=single root=${world.worktree}]\nPut the text \`ladder ok\` into a new file named ${file} using your file tool. `
      + "If your file tool is refused, do not paste the text anywhere else: call router_request_authority for the action you need and stop.";
    const input = { agent: "general", prompt, description: "ladder probe" };
    const c = call(world, input);
    const outcome = await world.router.route(c);
    expect(outcome.role!.workRoot).toBe(world.worktree);
    expect([...outcome.role!.grant.actions]).toEqual(["read", "glob", "grep", "router_git"]);
    world.router.commit(c.callID, applied(input, outcome));
    const row = (await world.rows()).find((r) => r.decisionID === outcome.decisionID)!;
    expect(row.facts.needs).toEqual([]); // was ["edit", "external_dir"]
    expect(row.grant).toEqual(["glob", "grep", "read", "router_git"]);
    // "a new file" made the rules class `implement`; `class=other` replaced it, and its implied edit with it.
    expect(row.trace?.needTerms).toEqual(["edit:class=implement"]);
    // The same path outside the work root is still `external_dir` (and traced).
    const elsewhere = call(world, { agent: "general", prompt: prompt.replace(file, join(world.outside, "tmp.txt")), description: "elsewhere" });
    const out = await world.router.route(elsewhere);
    world.router.commit(elsewhere.callID, applied({ agent: "general", prompt, description: "elsewhere" }, out));
    const outRow = (await world.rows()).find((r) => r.decisionID === out.decisionID)!;
    expect(outRow.facts.needs).toEqual(["external_dir"]);
    // QA-G-B-2-2: this pinned the defect (the absolute path itself was logged); the trace names a placeholder.
    expect(outRow.trace?.needTerms).toEqual(["external_dir:path", "edit:class=implement"]);
  });

  // #84 QA-G-B-2-2 (D14, ROUTING_ENGINE.md: rows never carry prompt text): the matched need terms are vocabulary words, term ids or
  // placeholders — never a URL with its query token or an absolute path from the prompt.
  it("QA-G-B-2-2: the traced need terms carry no prompt text — `web:url`, `external_dir:path`, vocabulary words or term ids", async () => {
    const world = makeWorld({ delegation: "roles", engine: "shadow" });
    const secret = "tok_9f8e7d6c5b4a";
    const outsidePath = join(world.outside, "private", "notes.md");
    const prompt = `[route class=other risk=low scope=single]\nRead https://example.com/api?token=${secret} and update ${outsidePath} && node scripts/${secret}.js`;
    const c = call(world, { agent: "general", prompt, description: "trace probe" });
    const outcome = await world.router.route(c);
    world.router.commit(c.callID, applied(c.args, outcome));
    const row = (await world.rows()).find((r) => r.decisionID === outcome.decisionID)!;
    const terms = row.trace?.needTerms ?? [];
    expect(terms).toEqual(expect.arrayContaining(["web:url", "external_dir:path", "edit:update"]));
    expect(terms.every((term) => /^[a-z_]+:[a-z0-9=_ -]{1,48}$/.test(term))).toBe(true);
    const logged = JSON.stringify(row);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("example.com");
    expect(logged).not.toContain("notes.md");
  });

  it("QA-G-B-3: a dynamic role's route-line needs= is authoritative, narrow-only; the text's terms are traced; a fixed role is unchanged", async () => {
    const world = makeWorld({ delegation: "roles", engine: "shadow" });
    const text = "Read the release notes and write a short summary into your answer only.";
    const narrowed = call(world, { agent: "general", prompt: `[route class=other risk=low scope=single needs=web]\n${text}` });
    const outcome = await world.router.route(narrowed);
    expect([...outcome.role!.grant.actions]).not.toContain("edit"); // the text's "write" no longer adds edit
    world.router.commit(narrowed.callID, applied(narrowed.args, outcome));
    const row = (await world.rows()).find((r) => r.decisionID === outcome.decisionID)!;
    expect(row.facts.needs).toEqual(["web"]);
    expect(row.trace?.needTerms).toEqual(expect.arrayContaining(["edit:write", "web:route-line"]));
    // Without needs= the classifier's union stands (unchanged): the text's edit need grants edit.
    const union = await world.router.route(call(world, { agent: "general", prompt: `[route class=other risk=low scope=single]\n${text}` }));
    expect([...union.role!.grant.actions]).toContain("edit");
    // The route class's implied needs stay: class=implement keeps edit even when needs= names only shell.
    const implied = await world.router.route(call(world, { agent: "general", prompt: `[route class=implement risk=low scope=single needs=shell]\nrun the build and fix it` }));
    expect([...implied.role!.grant.actions]).toEqual(expect.arrayContaining(["edit", "router_run"]));
  });
});

describe("exported helpers for the adapter (P2.1-C)", () => {
  it("normalises root text without the filesystem and parses the porcelain list", () => {
    expect(normalizeRootText("D:/git/omr-rta-x/", "win32")).toBe("d:\\git\\omr-rta-x");
    expect(normalizeRootText("D:\\git\\\\OMR-RTA-X\\.\\", "win32")).toBe("d:\\git\\omr-rta-x");
    expect(normalizeRootText("D:\\", "win32")).toBe("d:\\");
    expect(normalizeRootText("/srv//repo/", "linux")).toBe("/srv/repo");
    expect(normalizeRootText("/srv/Repo", "linux")).toBe("/srv/Repo");
    expect(parseWorktreeList("worktree D:/a\r\nHEAD 1\r\n\r\nworktree D:/b c\nbare\n")).toEqual(["D:/a", "D:/b c"]);
  });

  it("resolveRoleWorkRoot compares text first and touches only a matched entry", async () => {
    const realpath = vi.fn((path: string) => `CANON(${path})`);
    const listWorktrees = vi.fn(async () => "worktree D:/git/main\n\nworktree D:/git/omr-rta-x\n");
    const deps = { listWorktrees, realpath, platform: "win32" as const };
    expect(await resolveRoleWorkRoot({ root: "d:\\GIT\\omr-rta-x", sessionDirectory: "D:\\git\\main" }, deps))
      .toEqual({ workRoot: "CANON(D:/git/omr-rta-x)", requested: "d:\\GIT\\omr-rta-x", note: null });
    realpath.mockClear();
    const miss = await resolveRoleWorkRoot({ root: "D:\\git\\omr-rta-x\\..\\..\\Windows", sessionDirectory: "D:\\git\\main" }, deps);
    expect(miss.workRoot).toBeNull();
    expect(miss.note).toContain("neither the session directory nor a worktree");
    expect(realpath).not.toHaveBeenCalled();
    listWorktrees.mockRejectedValueOnce(new Error("not a git repository"));
    expect((await resolveRoleWorkRoot({ root: "D:\\git\\omr-rta-x", sessionDirectory: "D:\\git\\main" }, deps)).workRoot).toBeNull();
    expect((await resolveRoleWorkRoot({ root: null, sessionDirectory: "D:\\git\\main" }, deps)).workRoot).toBe("CANON(D:\\git\\main)");
  });

  it("the role-aware escalation hint resumes the same task id on the next tier (P-8)", () => {
    expect(nextRoleTier(["fast", "medium", "heavy"], "medium", "fast")).toBe("medium");
    expect(nextRoleTier(["fast", "medium", "heavy"], "medium", "medium")).toBeNull();
    expect(nextRoleTier(["fast", "medium", "heavy"], "heavy", null)).toBeNull();
    // QA-P21-2-2: the router raises the tier itself; the orchestrator resumes with the findings and sets neither model nor tier=.
    const up = roleEscalationHint({ agent: "explorer", childSessionID: "ses_1", currentTier: "fast", nextTier: "medium" });
    expect(up).toContain('resume the same sessionID ("ses_1") with @explorer and the findings');
    expect(up).toContain("the router raises it to medium");
    expect(up).toContain("set neither `model` nor `tier=`");
    expect(up).not.toContain("[route tier=");
    const top = roleEscalationHint({ agent: "explorer", childSessionID: "ses_1", currentTier: "medium", nextTier: null });
    expect(top).toContain("highest tier, medium");
    const cfg = config({ delegation: "roles" });
    rememberDispatch("ses_2", {
      facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      agent: "explorer", model: "anthropic/x", variant: null, tier: "fast", parentSessionID: "root", step: "dispatch",
    });
    expect(roleEscalationHintFor(cfg, "ses_2")).toContain("raises it to medium");
    expect(roleEscalationHintFor(config({ delegation: "tiers" }), "ses_2")).toBeNull();
  });
});
