/**
 * #84 P2.1 T2.1.3 / T2.1.4: the role runtime wired into the plugin (`src/index.ts`) and the v2 adapter (`src/compat/v2-hooks.ts`):
 * protocol switch, role tools and the one work-root resolver, guard profiles, budget/authority annotations of the parent's result,
 * the authority ladder's resume, session eviction, P-5 foreground, signals with the real guard state. Tiers mode and v1 unchanged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import {
  firstMessageText, registerV2Hooks, roleAuthorityNotice, roleBudgetNotice,
} from "../../src/compat/v2-hooks";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath, resetRolesWarnings, type RouterConfig } from "../../src/router/config";
import { assembleRolesSystemPrompt, assembleSystemPrompt } from "../../src/router/protocol";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { resolveRoles } from "../../src/router/roles";
import { resetDispatchRegistry } from "../../src/router/sessions";
import { buildRoleLadder } from "../../src/routing/engine/ladders";
import { resetIngestState, type Ingest } from "../../src/routing/outcomes/ingest";
import { bind, currentBinding, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import {
  AUTHORITY_TEXT, markAnnotated, previewAuthority, requestAuthority, requestedAuthority, resetAuthorityForTests,
} from "../../src/routing/roles/authority";
import {
  resetDispatchRouting, roleGateDeferred, roleGateOutsideWorkRoot, roleRouterGate, routedRoleOf, strippedRouteRoot,
} from "../../src/routing/wire/dispatch";
import { canonicalAuthorityPath, requestedVerificationCwd, requestedVerificationCwdSource, verificationScope } from "../../src/routing/roles/work-root";
import { runSignal } from "../../src/routing/outcomes/signals";
import { registerRoleAgents } from "../../src/router/role-agents";
import { rememberDispatch } from "../../src/router/sessions";
import { ROUTER_BUDGET_NOTE_PREFIX } from "../../src/router/prompts";
import { budgetExhausted, captureBudget } from "../../src/guard/enforce";
import {
  AUTHORITY_BINDING_UNKNOWN_DROP, createHostBudgetObserver, HOST_CONTEXT_OVERFLOW_ERROR, ROLES_RESTART_NOTICE, type HostBudgetObserver,
} from "../../src/compat/v2-hooks";
import { roleAgentSteps } from "../../src/router/role-agents";
import { buildDispatchHeader, DISPATCH_HEADER_SEPARATOR } from "../../src/router/dispatch-header";
import { DEFAULT_TIER_CAPS } from "../../src/router/sessions";
import { buildForcingNote, createChangedFileStore } from "../../src/verify/dispatch";
import { buildEscalatePolicy, newLadderState, nextAction } from "../../src/escalate/ladder";
import { BUDGET_INCOMPLETE_REASON, incompleteVerdict } from "../../src/verify/checker";
import { createVerificationWiring } from "../../src/verify/wiring";
import type { DoD } from "../../src/verify/dod";
import { runAdvisor } from "../../src/routing/advisor";

// A pass-through spy on the cost doctor's entry point: the tests read the extras the plugin hands it (P2.2 wiring).
vi.mock("../../src/routing/advisor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routing/advisor")>();
  return { ...actual, runAdvisor: vi.fn(actual.runAdvisor) };
});
// QA-P21-2-4: role agent registration can be made to fail for real (every preset model unusable), like an unusable floor tier.
const registration = vi.hoisted(() => ({ broken: false }));
vi.mock("../../src/router/role-agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/router/role-agents")>();
  const unusable = (cfg: any) => ({
    ...cfg,
    presets: Object.fromEntries(Object.entries(cfg.presets ?? {}).map(([name, tiers]) => [name,
      Object.fromEntries(Object.entries(tiers as Record<string, object>).map(([tier, def]) => [tier, { ...def, model: "no-slash" }]))])),
  });
  return {
    ...actual,
    registerRoleAgents: vi.fn((agents: any, cfg: any, opts: any) => actual.registerRoleAgents(agents, registration.broken ? unusable(cfg) : cfg, opts)),
  };
});
// A pass-through spy on the run signal: the tests read what the plugin hands it (QA-P21-1-7 editsObserved).
vi.mock("../../src/routing/outcomes/signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routing/outcomes/signals")>();
  return { ...actual, runSignal: vi.fn(actual.runSignal) };
});

const temps: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  resetBindingRegistryForTests();
  resetAuthorityForTests();
  resetDispatchRouting();
  resetDispatchRegistry();
  resetIngestState();
  registration.broken = false;
});

function temp(prefix = "omr-p21c-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** HOME redirected to a temp dir whose global override holds `override`; returns the home and the loaded config. */
function home(override: Record<string, unknown> = {}, env: Record<string, string> = {}): { dir: string; cfg: RouterConfig } {
  const dir = temp("omr-p21c-home-");
  vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", env.MODEL_ROUTER_ENFORCE ?? "");
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  return { dir, cfg: loadConfig(dir) };
}

const ROLES = { routing: { delegation: "roles" } };

/** A catalog listing every role rung model of the active preset, with its variants. */
function catalogOf(cfg: RouterConfig) {
  const byModel = new Map<string, Set<string>>();
  for (const tier of ["fast", "medium", "heavy"]) {
    const c = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "probe", window: { floor: tier, ceiling: tier, pinned: null } }).candidates[0]!;
    const set = byModel.get(c.model) ?? new Set<string>();
    if (c.variant !== null && c.variant !== "default") set.add(c.variant);
    byModel.set(c.model, set);
  }
  return [...byModel].map(([model, variants]) => {
    const [providerID, id] = model.split("/") as [string, string];
    return { providerID, id, variants: [...variants].map((v) => ({ id: v })), limit: { context: 200_000, output: 32_000 }, cost: [] };
  });
}

interface Plugin {
  /** The plugin's hooks, loosely typed: the tests drive them with the v2 adapter's call shapes (which carry `agent`). */
  hooks: Record<string, any>;
  ingest: Ingest | undefined;
  log: ReturnType<typeof vi.fn>;
}

async function plugin(directory: string, host: "v1" | "v2" = "v2", extra: Record<string, unknown> = {}): Promise<Plugin> {
  let ingest: Ingest | undefined;
  const log = vi.fn(async () => ({}));
  const hooks = await ModelRouterPlugin({
    directory, worktree: directory,
    ...extra,
    ...(host === "v2" ? { routerHost: "v2" } : {}),
    client: {
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) },
      app: { log },
    },
    routerOnIngest: (created: Ingest) => { ingest = created; },
  } as unknown as RouterPluginInput) as Plugin["hooks"];
  cleanups.push(async () => { await hooks.dispose?.(); });
  return { hooks, ingest, log };
}

/** A minimal v2 host around the adapter: sessions by id (root has no parent), recorded hooks, an event queue. */
function host(directory: string, cfg: RouterConfig, sessions: Record<string, Record<string, unknown>> = {}) {
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const queue: any[] = [];
  let wake = () => {};
  const session = (id: string) => sessions[id] ?? (id === "root"
    ? { id, agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, location: { directory } }
    : { id, parentID: "root", agent: "explorer", location: { directory } });
  const ctx = {
    location: { directory, project: { directory } },
    agent: { reload: vi.fn(async () => {}), list: vi.fn(async () => ({ data: [] })), transform: vi.fn(async (cb: any) => { cb({ update: () => {} }); return register(); }) },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async (cb: any) => { cb({ add: () => {} }); return register(); }) },
    model: { list: vi.fn(async () => ({ data: catalogOf(cfg) })) },
    tool: { transform: vi.fn(async (cb: any) => { cb({ add: () => {}, update: () => {} }); return register(); }), hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }) },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => session(sessionID)),
      context: vi.fn(async () => [] as unknown[]),
      update: vi.fn(async () => {}), prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    permission: { hook: vi.fn(async () => register()) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      signal.addEventListener("abort", () => wake(), { once: true });
      while (!signal.aborted) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>((resolve) => { wake = resolve; });
      }
    } },
  };
  return {
    ctx, toolHooks, sessionHooks,
    emit(event: any) { queue.push(event); wake(); },
    async start(hooks: Record<string, any>, options: Parameters<typeof registerV2Hooks>[3] = {}) {
      // No execution-end event arrives in these tests unless one is emitted: do not wait for one by default.
      cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, undefined, { hostSettleMs: 0, listRegistrationWorktrees: async () => [], ...options })); // no real `git worktree list` at registration (seconds on Windows CI)
    },
  };
}

const toolCtx = (sessionID: string) => ({ sessionID, messageID: "m", agent: "x", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });
const parentCall = (id: string, child: string, agent: string, text: string, extra: Record<string, unknown> = {}) => ({
  sessionID: "root", agent: "build", messageID: "m", id, tool: "subagent", input: { agent, prompt: "Find the parser", ...extra }, status: "completed",
  result: { output: { status: "completed", output: text, sessionID: child }, content: [{ type: "text", text }] },
});
const resultText = (event: { result: { content: Array<{ text?: string }> } }): string => event.result.content.map((part) => part.text ?? "").join("\n");

/**
 * A fresh role dispatch from the root through the adapter (route → nonce → pending entry); its child session then carries the
 * nonce title, so its first tool call binds EXACT.
 */
async function dispatchFresh(
  v2: ReturnType<typeof host>, sessions: Record<string, Record<string, unknown>>, dir: string, callID: string, child: string, agent: string,
): Promise<Record<string, unknown>> {
  const event = { sessionID: "root", agent: "build", messageID: "m", id: callID, tool: "subagent", input: { agent, description: "look around", prompt: "Look at the parser module and report its entry points" } as Record<string, unknown> };
  await v2.toolHooks["execute.before"](event);
  sessions[child] = { id: child, parentID: "root", agent, title: event.input.description, location: { directory: dir } };
  await v2.toolHooks["execute.before"]({ sessionID: child, agent, messageID: "m", id: `${child}-t0`, tool: "read", input: { path: join(dir, "a.ts") } });
  return event.input;
}

// ---------------------------------------------------------------------------

describe("tiers mode and v1 stay unchanged (I1, I8)", () => {
  it("v2 tiers mode: no role tool, today's protocol", async () => {
    const { dir, cfg } = home();
    const { hooks } = await plugin(dir);
    expect(Object.keys(hooks.tool ?? {})).not.toContain("router_run");
    expect(Object.keys(hooks.tool ?? {})).not.toContain("router_request_authority");
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root", model: { providerID: "openai", modelID: "gpt-x" } }, output);
    const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
    expect(output.system[0]).toBe(assembleSystemPrompt(cfg, "openai/gpt-x", enfOn));
  });

  it("v1 with roles keys: tiers protocol, no role tool, the v2-only notice", async () => {
    resetRolesWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, cfg } = home(ROLES);
    const { hooks, log } = await plugin(dir, "v1");
    expect(Object.keys(hooks.tool ?? {})).not.toContain("router_run");
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root", model: { providerID: "openai", modelID: "gpt-x" } }, output);
    const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
    expect(output.system[0]).toBe(assembleSystemPrompt(cfg, "openai/gpt-x", enfOn));
    await hooks.dispose?.();
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).toMatch(/OpenCode v2/);
  });
});

describe("roles mode on v2: protocol and tools (T2.1.3)", () => {
  it("swaps in the roles protocol at the injection site", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root", model: { providerID: "openai", modelID: "gpt-x" } }, output);
    const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
    const expected = assembleRolesSystemPrompt(cfg, resolveRoles(cfg, "v2"), "openai/gpt-x", enfOn);
    expect(expected).not.toBe("");
    expect(output.system[0]).toBe(expected);
  });

  it("registers router_run and router_request_authority; the resolver refuses non-role and unbound role sessions", async () => {
    const { dir } = home(ROLES);
    const { hooks } = await plugin(dir);
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(["router_run", "router_request_authority", "router_git_status"]));
    expect(await tools.router_run!.execute({ script: "test", cwd: dir }, toolCtx("root"))).toMatch(/only available to role sessions/);
    // A role child's own call names its agent: it is a role session from then on, unbound here → no work root (I9).
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "x1", agent: "explorer", callID: "r0" }, { args: { filePath: join(dir, "a.ts") } });
    expect(await tools.router_run!.execute({ script: "test", cwd: dir }, toolCtx("x1"))).toMatch(/no bound work root \(I9\)/);
    expect(await tools.router_git_status!.execute({}, toolCtx("x1"))).toMatch(/no bound work root \(I9\)/);
  });
});

describe("guard profiles and the budget annotation (handoffs 27, 28; T2.1.4)", () => {
  it("a role child gets its role budget; on an enforced stop the parent's result carries resume guidance", async () => {
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    const explorer = resolveRoles(cfg, "v2").get("explorer")!;
    const budget = explorer.budget[explorer.tierRange.floor]!;
    let blocked: unknown;
    for (let i = 0; i <= budget && blocked === undefined; i++) {
      const args = { filePath: join(dir, `f${i}.ts`) };
      try {
        await hooks["tool.execute.before"]({ tool: "read", sessionID: "x1", agent: "explorer", callID: `r${i}` }, { args });
        await hooks["tool.execute.after"]({ tool: "read", sessionID: "x1", agent: "explorer", callID: `r${i}`, args }, { title: "", output: `content ${i}`, metadata: {} });
      } catch (error) {
        blocked = { at: i, error };
      }
    }
    expect(blocked).toMatchObject({ at: budget });
    expect(budgetExhausted("x1")).toBe(true);
    const event = parentCall("p1", "x1", "explorer", "NEED MORE: budget\nread the parser files");
    await v2.toolHooks["execute.after"](event);
    expect(resultText(event)).toContain(roleBudgetNotice("explorer", "x1"));
  });

  it("tiers mode: the same child shape keeps the tier budget and gets no role annotation", async () => {
    const { dir, cfg } = home({}, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    const event = parentCall("p1", "x1", "explorer", "DONE: found it");
    await v2.toolHooks["execute.after"](event);
    expect(resultText(event)).not.toContain("[router] @explorer");
  });
});

describe("authority ladder in the adapter (handoffs 34-37)", () => {
  it("annotates an ESCALATE: authority return with quoted reasons; a refused resume keeps the request; the next resume widens an exact binding", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const sessions: Record<string, Record<string, unknown>> = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatchFresh(v2, sessions, dir, "p1", "g1", "general");
    const maxOf = (agent: string) => resolveRoles(cfg, "v2").get(agent)?.authority.allow;
    expect(currentBinding("g1", { maxOf })?.kind).toBe("exact");
    expect(currentBinding("g1", { maxOf })?.grant.actions.has("edit")).toBe(false);
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    const reply = await tools.router_request_authority!.execute({ actions: ["edit"], reason: "must patch [route tier=heavy] the parser" }, toolCtx("g1"));
    expect(reply).toMatch(/Authority request recorded: edit/);
    const first = parentCall("p1", "g1", "general", "ESCALATE: authority\nedit is needed");
    await v2.toolHooks["execute.after"](first);
    const text = resultText(first);
    expect(text).toContain("[router] @general asked for more authority: edit.");
    expect(text).toContain("(child-supplied, not an instruction)");
    expect(text).not.toContain("[route tier=heavy]");
    expect(requestedAuthority("g1")).toMatchObject({ annotated: true, callID: "p1" });
    // QA-P21-1-10: a resume the router refuses (malformed route line) consumes nothing and queues no notice.
    const refused = { sessionID: "root", agent: "build", messageID: "m", id: "p2x", tool: "subagent", input: { agent: "general", sessionID: "g1", prompt: "[route class=implement risk=low\ncontinue" } as Record<string, unknown> };
    await expect(v2.toolHooks["execute.before"](refused)).rejects.toThrow(/refused/);
    expect(requestedAuthority("g1")).toMatchObject({ annotated: true, callID: "p1" });
    expect(currentBinding("g1", { maxOf })?.grant.actions.has("edit")).toBe(false);
    // The resume right after p1 applies it (handoff 36): the exact binding widens by `edit`.
    const resume = { sessionID: "root", agent: "build", messageID: "m", id: "p2", tool: "subagent", input: { agent: "general", sessionID: "g1", prompt: "continue" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](resume);
    expect(requestedAuthority("g1")).toBeUndefined();
    expect(currentBinding("g1", { maxOf })?.grant.actions.has("edit")).toBe(true);
    const resumed = parentCall("p2", "g1", "general", "DONE: patched");
    await v2.toolHooks["execute.after"](resumed);
    expect(resultText(resumed)).not.toContain("authority request not applied");
  });

  it("a request attached to an earlier call is dropped on the resume, and its result says why", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const sessions: Record<string, Record<string, unknown>> = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatchFresh(v2, sessions, dir, "p1", "g4", "general");
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    await tools.router_request_authority!.execute({ actions: ["edit"], reason: "patch" }, toolCtx("g4"));
    await v2.toolHooks["execute.after"](parentCall("p1", "g4", "general", "ESCALATE: authority"));
    await v2.toolHooks["execute.after"](parentCall("p1b", "g4", "general", "DONE: answered a question")); // a later call of the same child
    expect(requestedAuthority("g4")).toMatchObject({ annotated: true, callID: "p1" });
    const resume = { sessionID: "root", agent: "build", messageID: "m", id: "p2", tool: "subagent", input: { agent: "general", sessionID: "g4", prompt: "continue" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](resume);
    const resumed = parentCall("p2", "g4", "general", "DONE: done");
    await v2.toolHooks["execute.after"](resumed);
    expect(resultText(resumed)).toContain("authority request not applied: it belongs to another call than the one being resumed");
  });

  it("Q1: a child whose binding is not exact never widens; the resume drops the request with its reason", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg, { g5: { id: "g5", parentID: "root", agent: "general", location: { directory: dir } } });
    await v2.start(hooks);
    await v2.toolHooks["execute.before"]({ sessionID: "g5", agent: "general", messageID: "m", id: "t0", tool: "read", input: { path: join(dir, "a.ts") } });
    const maxOf = (agent: string) => resolveRoles(cfg, "v2").get(agent)?.authority.allow;
    expect(currentBinding("g5", { maxOf })?.kind).toBe("unknown"); // no nonce: unknown
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    await tools.router_request_authority!.execute({ actions: ["edit"], reason: "patch" }, toolCtx("g5"));
    await v2.toolHooks["execute.after"](parentCall("p1", "g5", "general", "ESCALATE: authority"));
    const resume = { sessionID: "root", agent: "build", messageID: "m", id: "p2", tool: "subagent", input: { agent: "general", sessionID: "g5", prompt: "continue" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](resume);
    expect(requestedAuthority("g5")).toBeUndefined();
    expect(currentBinding("g5", { maxOf })?.grant.actions.has("edit")).toBe(false);
    const resumed = parentCall("p2", "g5", "general", "DONE: done");
    await v2.toolHooks["execute.after"](resumed);
    expect(resultText(resumed)).toContain(AUTHORITY_BINDING_UNKNOWN_DROP);
  });

  it("a return without ESCALATE: authority drops the open request", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg, { g2: { id: "g2", parentID: "root", agent: "general", location: { directory: dir } } });
    await v2.start(hooks);
    await v2.toolHooks["execute.before"]({ sessionID: "g2", agent: "general", messageID: "m", id: "t0", tool: "read", input: { path: join(dir, "a.ts") } });
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    await tools.router_request_authority!.execute({ actions: ["edit"], reason: "patch" }, toolCtx("g2"));
    const event = parentCall("p1", "g2", "general", "DONE: nothing to patch after all");
    await v2.toolHooks["execute.after"](event);
    expect(requestedAuthority("g2")).toBeUndefined();
    expect(resultText(event)).not.toContain("asked for more authority");
  });

  it("session.deleted evicts the binding and the authority request (handoff 35)", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg, { g3: { id: "g3", parentID: "root", agent: "general", location: { directory: dir } } });
    await v2.start(hooks);
    await v2.toolHooks["execute.before"]({ sessionID: "g3", agent: "general", messageID: "m", id: "t0", tool: "read", input: { path: join(dir, "a.ts") } });
    const maxOf = (agent: string) => resolveRoles(cfg, "v2").get(agent)?.authority.allow;
    expect(currentBinding("g3", { maxOf })).toBeDefined(); // bound by the adapter before the child's tool ran
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    await tools.router_request_authority!.execute({ actions: ["edit"], reason: "patch" }, toolCtx("g3"));
    expect(requestedAuthority("g3")).toBeDefined();
    v2.emit({ type: "session.deleted", data: { sessionID: "g3" } });
    await vi.waitFor(() => expect(requestedAuthority("g3")).toBeUndefined());
    expect(currentBinding("g3", { maxOf })).toBeUndefined();
    // Tombstoned: a lookup in flight can no longer store a binding for it.
    await bind("g3", async () => ({ parentID: "root", agent: "general" }), { maxOf });
    expect(currentBinding("g3", { maxOf })).toBeUndefined();
  });
});

describe("role dispatch through the adapter (P2.1-C, P-5)", () => {
  it("roles mode: description nonce suffix, router model, foreground with verification off; tiers mode untouched", async () => {
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks, { isBypassed: () => false });
    const role = { sessionID: "root", agent: "build", messageID: "m", id: "c1", tool: "subagent", input: { agent: "explorer", description: "find parser", prompt: "Find the parser entry point" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](role);
    expect(role.input.description).toMatch(/^find parser \[nonce [A-Za-z0-9_-]{16,128}\]$/);
    expect(String(role.input.prompt)).toMatch(/\nOMR_NONCE=[A-Za-z0-9_-]{16,128}$/);
    expect(typeof role.input.model).toBe("string");
    expect(role.input.background).toBe(false);

    const tiers = home({}, { MODEL_ROUTER_ENFORCE: "0" });
    const tierPlugin = await plugin(tiers.dir);
    const tierHost = host(tiers.dir, tiers.cfg);
    await tierHost.start(tierPlugin.hooks);
    const tier = { sessionID: "root", agent: "build", messageID: "m", id: "c2", tool: "subagent", input: { agent: "fast", description: "find parser", prompt: "Find the parser entry point" } as Record<string, unknown> };
    await tierHost.toolHooks["execute.before"](tier);
    expect(tier.input.description).toBe("find parser");
    expect(Object.hasOwn(tier.input, "background")).toBe(false);
  });

  it("handoff 30: a stripped route line's root reaches the tier dispatch header (v2 shadow)", async () => {
    const { dir, cfg } = home({ routing: { engine: "shadow" } });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    const root = join(dir, "wt").replace(/\\/g, "/");
    const event = { sessionID: "root", agent: "build", messageID: "m", id: "c3", tool: "subagent", input: { agent: "fast", description: "look", prompt: `[route class=recon root=${root}]\nLook around` } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](event);
    const carried = strippedRouteRoot("c3");
    expect(carried).toBeDefined();
    expect(String(event.input.prompt)).not.toContain("[route ");
    expect(String(event.input.prompt)).toContain(`Working directory: ${carried}.`);
    // execute.after forgets it with the call.
    await v2.toolHooks["execute.after"]({ ...event, status: "error" });
    expect(strippedRouteRoot("c3")).toBeUndefined();
  });
});

describe("signals with the real guard state (handoffs 15, 23)", () => {
  it("an explicit ESCALATE with both guards observed false writes an incomplete signal; tiers mode writes none", async () => {
    const { dir } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks, ingest } = await plugin(dir);
    expect(ingest).toBeDefined();
    const onSignal = vi.spyOn(ingest!, "onSignal");
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "x2", agent: "explorer", callID: "r0" }, { args: { filePath: join(dir, "a.ts") } });
    await hooks["tool.execute.after"]({ tool: "read", sessionID: "x2", agent: "explorer", callID: "r0", args: { filePath: join(dir, "a.ts") } }, { title: "", output: "x", metadata: {} });
    const output = { title: "", output: "ESCALATE: the parser lives in another repository", metadata: { sessionId: "x2" } };
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: "p1", args: { subagent_type: "explorer", prompt: "Find the parser" } }, output);
    const kinds = onSignal.mock.calls.filter(([child]) => child === "x2").map(([, observation]) => observation.kind);
    expect(kinds).toContain("incomplete");
  });

  it("enforcement off: the budget guard is unobserved, so an ESCALATE writes no incomplete signal (I7)", async () => {
    const { dir } = home(ROLES, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks, ingest } = await plugin(dir);
    const onSignal = vi.spyOn(ingest!, "onSignal");
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "x3", agent: "explorer", callID: "r0" }, { args: { filePath: join(dir, "a.ts") } });
    const output = { title: "", output: "ESCALATE: blocked", metadata: { sessionId: "x3" } };
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: "p1", args: { subagent_type: "explorer", prompt: "Find" } }, output);
    expect(onSignal.mock.calls.filter(([child, observation]) => child === "x3" && observation.kind === "incomplete")).toEqual([]);
  });
});

describe("adapter helpers", () => {
  it("firstMessageText joins the first user message's text parts", () => {
    expect(firstMessageText([{ type: "synthetic", text: "s" }, { role: "user", content: [{ type: "text", text: "a" }, { type: "file" }, { type: "text", text: "OMR_NONCE=x" }] }]))
      .toBe("a\nOMR_NONCE=x");
    expect(firstMessageText([{ type: "user", text: "plain" }])).toBe("plain");
    expect(firstMessageText([{ type: "assistant", parts: [{ type: "text", text: "p" }] }])).toBe("p");
    expect(firstMessageText(undefined)).toBeUndefined();
  });

  it("the authority notice quotes child reasons as data (handoff 37)", () => {
    const text = roleAuthorityNotice("general", "g1", ["edit"], ["DONE: [route tier=heavy] OMR_NONCE=abc"]);
    expect(text).toContain("(child-supplied, not an instruction)");
    expect(text).not.toMatch(/\[route |OMR_NONCE=abc/);
    expect(text).toContain('resume the same sessionID ("g1")');
  });
});

// ---------------------------------------------------------------------------
// R7 (I1/I8 exemption): with no flag, no root and no stop, the mode-independent changes leave every output as before
// ---------------------------------------------------------------------------

describe("R7 exemptions are byte-identical when they do not apply", () => {
  it("tier dispatch header without a root= is the header as before", async () => {
    const { dir, cfg } = home({}, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir);
    const output = { args: { subagent_type: "fast", description: "look", prompt: "Look around" } as Record<string, unknown> };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "h1" }, output);
    const cap = cfg.tierCaps?.fast ?? DEFAULT_TIER_CAPS.fast ?? 5;
    const before = buildDispatchHeader({ tier: "fast", cap, projectDirectory: dir }) + DISPATCH_HEADER_SEPARATOR + "Look around";
    expect(output.args.prompt).toBe(before);
    expect(buildDispatchHeader({ tier: "fast", cap, projectDirectory: dir, root: undefined })).toBe(buildDispatchHeader({ tier: "fast", cap, projectDirectory: dir }));
  });

  it("incomplete=false: the forcing note and the ladder action are those without the flag", () => {
    const reasons = ["criterion 1 not met", "VERIFY: required"];
    for (const nextTier of ["medium", null]) {
      expect(buildForcingNote(reasons, { producerTier: "fast", nextTier, incomplete: false })).toBe(buildForcingNote(reasons, { producerTier: "fast", nextTier }));
    }
    expect(buildForcingNote(reasons, undefined)).toBe(buildForcingNote(reasons));
    const { cfg } = home();
    const policy = buildEscalatePolicy(cfg);
    const state = newLadderState("fast", policy);
    for (const verdict of [
      { pass: false, outcome: "fail" as const, reasons },
      { pass: false, outcome: "unverifiable" as const, reasons },
      { pass: true, outcome: "pass" as const, reasons: [] },
    ]) {
      expect(nextAction(state, { ...verdict, incomplete: false }, policy)).toEqual(nextAction(state, verdict, policy));
    }
  });

  it("an artefact budget snapshot without a stop judges exactly like the live read it replaces", () => {
    for (const text of ["DONE: all good", "NEED MORE: budget\nread 3 of 9 files", "I'll continue with the rest next.", ""]) {
      for (const producerTier of ["fast", "implementer"]) {
        const artefact = { finalReturnText: text, producerSessionID: "untracked-child", producerTier };
        const opts = { progressNotes: true };
        expect(incompleteVerdict({ ...artefact, budget: captureBudget("untracked-child", false) }, opts)).toEqual(incompleteVerdict(artefact, opts));
        expect(incompleteVerdict({ ...artefact, budget: captureBudget("untracked-child") }, opts)).toEqual(incompleteVerdict(artefact, opts));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P2.2 wiring: cost doctor extras and /router role lines
// ---------------------------------------------------------------------------

describe("P2.2 surfaces in the plugin", () => {
  const routerText = async (hooks: Record<string, any>): Promise<string> => {
    const output = { parts: [] as Array<{ text: string }> };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, output);
    return output.parts.map((part) => part.text).join("\n");
  };

  it("/router lists the roles in roles mode on v2 only", async () => {
    const roles = home(ROLES);
    const text = await routerText((await plugin(roles.dir)).hooks);
    expect(text).toContain("Roles:");
    for (const spec of resolveRoles(roles.cfg, "v2").values()) expect(text).toContain(`\`${spec.agent}\``);
    const tiers = home({ routing: { engine: "static" } });
    expect(await routerText((await plugin(tiers.dir)).hooks)).not.toContain("Roles:");
    const v1 = home(ROLES);
    expect(await routerText((await plugin(v1.dir, "v1")).hooks)).not.toContain("Roles:");
  });

  it("the cost doctor gets { host, roleStats, tierDispatches } in roles mode with a live engine; { host } otherwise", async () => {
    const advisor = vi.mocked(runAdvisor);
    const outcomes = temp("omr-p21c-outcomes-");
    const roles = home({ routing: { delegation: "roles", engine: "shadow", outcomes: { path: outcomes } } });
    advisor.mockClear();
    await routerText((await plugin(roles.dir)).hooks);
    const rolesExtras = advisor.mock.calls.at(-1)?.[4];
    expect(rolesExtras).toMatchObject({ host: "v2", tierDispatches: 0 });
    expect(rolesExtras?.roleStats).toMatchObject({ version: 1, byRoleTier: [] });

    const tiers = home({ routing: { engine: "shadow", outcomes: { path: outcomes } } });
    advisor.mockClear();
    await routerText((await plugin(tiers.dir)).hooks);
    expect(advisor.mock.calls.at(-1)?.[4]).toEqual({ host: "v2" });
  });
});

// ---------------------------------------------------------------------------
// Handoff 24 (rest): the deferred record carries the budget snapshot to router_verify
// ---------------------------------------------------------------------------

describe("router_verify judges the budget captured at return (handoff 24)", () => {
  const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "fileExists", path: "out.txt" }] };

  async function deferAndVerify(budget: ReturnType<typeof captureBudget> | undefined) {
    const dir = temp("omr-p21c-defer-");
    writeFileSync(join(dir, "out.txt"), "x");
    const { cfg } = home();
    const client = { session: { create: vi.fn(async () => ({ data: { id: "never" } })), abort: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } };
    const wiring = createVerificationWiring({ client: client as never, directory: dir, getConfig: () => cfg, logger: { warn: () => {} } });
    cleanups.push(async () => { wiring.pending.dispose(); await wiring.disposeVerification(); });
    const store = createChangedFileStore();
    await wiring.startDispatch(store, "task:orch:b1", dir, DOD, "", false);
    const finish = await wiring.finishDeferred(store, {
      dispatchID: "task:orch:b1", orchestratorSessionID: "orch", producerSessionID: "child-b1", producerTier: "fast",
      description: "work", cwd: dir, dod: DOD, dispatchedAt: Date.now(), ...(budget === undefined ? {} : { budget }),
    });
    if (!finish.deferred) throw new Error(`not deferred: ${finish.reason} ${finish.detail}`);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [finish.handle] });
    const item = report.items[0] as { result?: { verdict: { reasons: string[] } } } | undefined;
    return item?.result?.verdict.reasons ?? [];
  }

  it("a stop captured at return makes the later verdict incomplete; without a snapshot the live (untracked) state is judged", async () => {
    expect(await deferAndVerify({ tracked: true, stopped: true, usedUp: true })).toContain(BUDGET_INCOMPLETE_REASON);
    expect(await deferAndVerify(undefined)).not.toContain(BUDGET_INCOMPLETE_REASON);
  }, 60_000);
});

// #84 P3.3 DF2-F1 (fix-1 review nit): router_verify's gate of a deferred role dispatch gets its work root.
describe("router_verify judges a deferred role dispatch in its work root (DF2-F1)", () => {
  const DOD: DoD = { kind: "deterministic", source: "explicit", criteria: [], deliverable: null, checks: [{ kind: "fileExists", path: "out.txt" }] };

  async function deferAndVerify(workRoot: (dir: string) => string | undefined) {
    const dir = temp("omr-p33-defer-");
    writeFileSync(join(dir, "out.txt"), "x");
    const { cfg } = home();
    const client = { session: { create: vi.fn(async () => ({ data: { id: "never" } })), abort: vi.fn(async () => ({})), delete: vi.fn(async () => ({})) } };
    const wiring = createVerificationWiring({ client: client as never, directory: dir, getConfig: () => cfg, logger: { warn: () => {} } });
    cleanups.push(async () => { wiring.pending.dispose(); await wiring.disposeVerification(); });
    const store = createChangedFileStore();
    await wiring.startDispatch(store, "task:orch:w1", dir, DOD, "", false);
    const root = workRoot(dir);
    const finish = await wiring.finishDeferred(store, {
      dispatchID: "task:orch:w1", orchestratorSessionID: "orch", producerSessionID: "child-w1", producerTier: "implementer",
      description: "work", cwd: dir, dod: DOD, dispatchedAt: Date.now(), ...(root === undefined ? {} : { workRoot: root }),
    });
    if (!finish.deferred) throw new Error(`not deferred: ${finish.reason} ${finish.detail}`);
    const report = await wiring.verifyHandles("orch", { kind: "handles", handles: [finish.handle] });
    const item = report.items[0] as { result?: { verdict: { outcome?: string; reasons: string[] } } } | undefined;
    return item?.result?.verdict;
  }

  it("the gate re-checks the stored cwd against the work root: a cwd outside it is refused, nothing runs", async () => {
    const elsewhere = temp("omr-p33-root-");
    const refused = await deferAndVerify(() => elsewhere);
    expect(refused?.outcome).toBe("unverifiable");
    expect(refused?.reasons.join("\n")).toMatch(/outside this role dispatch's work root/);
    expect(refused?.reasons.join("\n")).toContain(elsewhere);
    expect(refused?.reasons.join("\n")).not.toContain("deterministic checks");
  }, 60_000);

  it("inside its work root it verifies as before; a tier dispatch (no work root) is unchanged (I1)", async () => {
    // The checks run (router_verify's own drift rule then decides the outcome, the same with or without a work root).
    const inside = await deferAndVerify((dir) => dir);
    const tier = await deferAndVerify(() => undefined);
    expect(inside?.reasons).toEqual(["all 1 deterministic checks passed"]);
    expect(tier?.reasons).toEqual(inside?.reasons);
    expect(inside?.outcome).toBe(tier?.outcome);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Handoff 22: the host's own stops (step limit, context overflow)
// ---------------------------------------------------------------------------

describe("host budget observer (handoff 22, S4)", () => {
  const steps = (o: HostBudgetObserver, id: string, n: number) => { for (let i = 0; i < n; i++) o.onEvent("session.step.ended", { sessionID: id }); };

  it("the step limit, a step-limit tool refusal and a context overflow are stops; a clean end is not; the rest is unobserved", () => {
    const o = createHostBudgetObserver();
    expect(o.observe("none", 5)).toBe("unobserved");
    steps(o, "a", 5);
    expect(o.observe("a", 5)).toBe(true); // S4: N steps = the host's last, tool-less step
    steps(o, "b", 2);
    expect(o.observe("b", 5)).toBe("unobserved"); // its end not seen yet: more steps may still arrive
    o.onEvent("session.execution.succeeded", { sessionID: "b" });
    expect(o.observe("b", 5)).toBe(false);
    o.onEvent("session.tool.failed", { sessionID: "c", error: { type: "tool", message: "Tools are disabled after the maximum agent steps" } });
    expect(o.observe("c", 100)).toBe(true);
    o.onEvent("session.step.failed", { sessionID: "d", error: { type: "ContextOverflowError", message: "input exceeds the context window" } });
    expect(o.observe("d", 100)).toBe(true);
    o.onEvent("session.step.failed", { sessionID: "e", error: { type: "provider", message: "rate limited" } });
    o.onEvent("session.execution.failed", { sessionID: "e" });
    expect(o.observe("e", 100)).toBe("unobserved"); // an unrecognised failure may have been an overflow: never `false`
    expect(HOST_CONTEXT_OVERFLOW_ERROR.test("prompt is too long: 210000 tokens")).toBe(true);
    // A resume starts the count over.
    o.begin("a");
    steps(o, "a", 1);
    o.onEvent("session.execution.succeeded", { sessionID: "a" });
    expect(o.observe("a", 5)).toBe(false);
    o.forget("a");
    expect(o.observe("a", 5)).toBe("unobserved");
  });

  it("settled() resolves on the execution end, or after the timeout", async () => {
    const o = createHostBudgetObserver();
    const waiting = o.settled("x", 10_000);
    o.onEvent("session.execution.succeeded", { sessionID: "x" });
    await waiting;
    const started = Date.now();
    await o.settled("y", 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });

  it("the adapter annotates a role child the host stopped on its step limit", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    const observer = createHostBudgetObserver();
    await v2.start(hooks, { hostBudget: observer, hostSettleMs: 2_000 });
    const limit = roleAgentSteps(resolveRoles(cfg, "v2").get("explorer")!);
    for (let i = 0; i < limit; i++) v2.emit({ type: "session.step.ended", data: { sessionID: "x7" } });
    v2.emit({ type: "session.execution.succeeded", data: { sessionID: "x7" } });
    await vi.waitFor(() => expect(observer.observe("x7", limit)).toBe(true));
    const event = parentCall("p1", "x7", "explorer", "Partial answer: found 3 of 5 call sites");
    await v2.toolHooks["execute.after"](event);
    expect(resultText(event)).toContain(roleBudgetNotice("explorer", "x7", "host"));
  });

  it("signals fold the host's stop into the budget observation: a budget signal instead of incomplete; unobserved suppresses it", async () => {
    const observed: Record<string, boolean | "unobserved"> = { hx: true, hy: "unobserved" };
    const { dir } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks, ingest } = await plugin(dir, "v2", { routerHostBudget: (child: string) => observed[child] ?? false });
    const onSignal = vi.spyOn(ingest!, "onSignal");
    for (const child of ["hx", "hy"]) {
      await hooks["tool.execute.before"]({ tool: "read", sessionID: child, agent: "explorer", callID: `r-${child}` }, { args: { filePath: join(dir, "a.ts") } });
      await hooks["tool.execute.after"]({ tool: "read", sessionID: child, agent: "explorer", callID: `r-${child}`, args: { filePath: join(dir, "a.ts") } }, { title: "", output: "x", metadata: {} });
      await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: `p-${child}`, args: { subagent_type: "explorer", prompt: "Find" } },
        { title: "", output: "ESCALATE: ran out of room", metadata: { sessionId: child } });
    }
    const kinds = (child: string) => onSignal.mock.calls.filter(([c]) => c === child).map(([, observation]) => observation.kind);
    expect(kinds("hx")).toContain("budget");
    expect(kinds("hx")).not.toContain("incomplete");
    expect(kinds("hy")).not.toContain("incomplete");
  });
});

// ---------------------------------------------------------------------------
// Senior QA round 1 of P2.1 (QA-P21-1-*), one test per finding
// ---------------------------------------------------------------------------

/** `provider/model[#variant]` of a tier's first role rung (what the role path sets for a dispatch on that tier). */
function rungRef(cfg: RouterConfig, tier: string): string {
  const c = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "probe", window: { floor: tier, ceiling: tier, pinned: null } }).candidates[0]!;
  return c.variant === null || c.variant === "default" ? c.model : `${c.model}#${c.variant}`;
}

describe("QA round 1 (P2.1)", () => {
  it("QA-P21-1-1: a child session dispatching implementer gets the floor rung whatever model it names, in the foreground", async () => {
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir);
    // #84 P2.3 (QA-P23-A7, approved amendment): the delegate is a TIER child — a role child may never call `subagent` (§2.2).
    const v2 = host(dir, cfg, { d1: { id: "d1", parentID: "root", agent: "medium", location: { directory: dir } } });
    await v2.start(hooks);
    for (const [i, named] of [rungRef(cfg, "fast"), rungRef(cfg, "heavy"), undefined].entries()) {
      const input: Record<string, unknown> = { agent: "implementer", description: "patch", prompt: "[route tier=heavy]\nPatch the parser", ...(named === undefined ? {} : { model: named }) };
      const event = { sessionID: "d1", agent: "medium", messageID: "m", id: `dc${i}`, tool: "subagent", input };
      await v2.toolHooks["execute.before"](event);
      expect(event.input.model).toBe(rungRef(cfg, "fast")); // implementer floor on the local-only grant
      expect(event.input.background).toBe(false);
      expect(String(event.input.prompt)).toContain("[route tier=heavy]"); // the delegate's prompt is not parsed or rewritten
      expect(event.input.description).toBe("patch"); // no nonce: nothing registered
    }
  });

  it("QA-P21-1-2: a deferred testsPass acceptance never backs a deterministic detection; VERIFY: required does", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    const acceptance = "[acceptance]\ncheck: testsPass\n[/acceptance]";
    expect(roleGateDeferred(cfg, `Do it\n${acceptance}`, "")).toBe(true); // bundled defaultVerify: deferred
    expect(roleGateDeferred(cfg, `VERIFY: required\nDo it\n${acceptance}`, "")).toBe(false);
    expect(roleGateDeferred(cfg, "Do it\n[acceptance]\ncheck: fileExists path=x.txt\n[/acceptance]", "")).toBe(false); // nothing to defer
    expect(roleRouterGate({ cfg, bypassed: false, acceptance: "deterministic", deferred: true, env: {} })).toBe(false);
    const route = async (id: string, prompt: string) => {
      const event = { sessionID: "root", agent: "build", messageID: "m", id, tool: "subagent", input: { agent: "implementer", description: "x", prompt } as Record<string, unknown> };
      await v2.toolHooks["execute.before"](event);
      return routedRoleOf(id)!.detection;
    };
    expect(await route("q2a", `[route class=implement risk=low scope=single]\nDo it\n${acceptance}`)).not.toBe("deterministic");
    expect(await route("q2b", `[route class=implement risk=low scope=single]\nVERIFY: required\nDo it\n${acceptance}`)).toBe("deterministic");
  });

  it("DF2-F1 (#84 P3.3): the detection is deterministic only when the gate can run the checks in the dispatch's work root", async () => {
    const { dir, cfg } = home(ROLES);
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    const root = realpathSync.native(dir);
    const block = (cwd?: string) => `Do it\n[acceptance]\n${cwd === undefined ? "" : `cwd: ${cwd}\n`}check: fileExists path=x.txt\n[/acceptance]`;
    expect(roleGateOutsideWorkRoot(root, block(), "")).toBe(false); // no cwd: → the work root
    expect(roleGateOutsideWorkRoot(root, block("sub"), "")).toBe(false); // relative → inside the work root
    expect(roleGateOutsideWorkRoot(root, block(join(root, "sub")), "")).toBe(false);
    expect(roleGateOutsideWorkRoot(root, block(join(root, "..")), "")).toBe(true);
    expect(roleGateOutsideWorkRoot(root, block(`${root}-v2`), "")).toBe(true); // a sibling prefix is outside
    expect(roleGateOutsideWorkRoot(null, block(), "")).toBe(true); // no validated work root
    expect(roleRouterGate({ cfg, bypassed: false, acceptance: "deterministic", outsideWorkRoot: true, env: {} })).toBe(false);
    expect(roleRouterGate({ cfg, bypassed: false, acceptance: "deterministic", outsideWorkRoot: false, env: {} })).toBe(true);
    const route = async (id: string, prompt: string, extra: Record<string, unknown> = {}) => {
      const event = { sessionID: "root", agent: "build", messageID: "m", id, tool: "subagent", input: { agent: "implementer", description: "x", prompt, ...extra } as Record<string, unknown> };
      await v2.toolHooks["execute.before"](event);
      return routedRoleOf(id)!.detection;
    };
    expect(await route("df1a", `[route class=implement risk=low scope=single]\n${block()}`)).toBe("deterministic");
    expect(routedRoleOf("df1a")!.verifyRoot).toBe(root);
    expect(await route("df1b", `[route class=implement risk=low scope=single]\n${block("sub")}`)).toBe("deterministic");
    expect(await route("df1c", `[route class=implement risk=low scope=single]\n${block(join(root, ".."))}`)).not.toBe("deterministic");
    // root= naming no worktree of this repository: no work root, so the gate cannot back a deterministic detection; it is
    // verified in the canonical session directory (QA-P33F1-1-3).
    expect(await route("df1d", `[route class=implement risk=low scope=single root=${join(root, "..")}]\n${block()}`)).not.toBe("deterministic");
    expect(routedRoleOf("df1d")!.workRoot).toBeNull();
    expect(routedRoleOf("df1d")!.verifyRoot).toBe(root);
    // QA-P33F1-1 nit 3: the call's own cwd argument wins over the block's cwd:, exactly as in the after-hook.
    expect(roleGateOutsideWorkRoot(root, block(), "", join(root, ".."))).toBe(true);
    expect(roleGateOutsideWorkRoot(root, block(join(root, "..")), "", root)).toBe(false);
    expect(roleGateOutsideWorkRoot(root, block(), "", "  ")).toBe(false); // a blank argument names no cwd
    expect(await route("df1e", `[route class=implement risk=low scope=single]\n${block()}`, { cwd: join(root, "..") })).not.toBe("deterministic");
    expect(await route("df1f", `[route class=implement risk=low scope=single]\n${block(join(root, ".."))}`, { cwd: root })).toBe("deterministic");
    // QA-P33F1-1-2: a UNC/device cwd is never inside (refused before any filesystem call).
    expect(roleGateOutsideWorkRoot(root, block("//server/share/x"), "")).toBe(true);
  });

  it("fix-1 review nit: requestedVerificationCwdSource names the input requestedVerificationCwd takes", () => {
    expect(requestedVerificationCwdSource("/x", "/y")).toBe("argument");
    expect(requestedVerificationCwd("/x", "/y")).toBe("/x");
    for (const blank of [undefined, null, "", "  ", 3]) {
      expect(requestedVerificationCwdSource(blank, "/y")).toBe("acceptance");
      expect(requestedVerificationCwd(blank, "/y")).toBe("/y");
      expect(requestedVerificationCwdSource(blank, undefined)).toBeUndefined();
      expect(requestedVerificationCwd(blank, undefined)).toBeUndefined();
    }
  });

  it("DF2-F1 / QA-P33F1-1-2: verificationScope — tiers unchanged (I1); a role root is the default; P2.3's containment rule", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scope-root-")));
    const away = realpathSync.native(mkdtempSync(join(tmpdir(), "scope-away-")));
    try {
      expect(verificationScope(undefined, undefined)).toEqual({ cwd: undefined, requested: undefined, outside: false });
      expect(verificationScope("/elsewhere", undefined)).toEqual({ cwd: "/elsewhere", requested: "/elsewhere", outside: false });
      expect(verificationScope("rel", null)).toEqual({ cwd: "rel", requested: "rel", outside: false });
      expect(verificationScope(undefined, root)).toEqual({ cwd: root, requested: root, workRoot: root, outside: false });
      expect(verificationScope("pkg", root)).toEqual({ cwd: join(root, "pkg"), requested: join(root, "pkg"), workRoot: root, outside: false });
      expect(verificationScope(away, root)).toEqual({ cwd: root, requested: undefined, workRoot: root, outside: true, refused: away });
      expect(verificationScope(`${root}-v2`, root).outside).toBe(true); // a sibling prefix
      // The checked CANONICAL directory is what the checks run in (a link inside the root is resolved) …
      const kind = process.platform === "win32" ? "junction" : "dir";
      mkdirSync(join(root, "real-pkg"));
      symlinkSync(join(root, "real-pkg"), join(root, "pkg-link"), kind);
      expect(verificationScope("pkg-link", root)).toMatchObject({ cwd: join(root, "real-pkg"), requested: join(root, "real-pkg"), outside: false });
      // … and a link inside the root that leads out of it is outside.
      symlinkSync(away, join(root, "out-link"), kind);
      expect(verificationScope("out-link", root)).toMatchObject({ outside: true, cwd: root, refused: "out-link" });
      // UNC/device paths and 8.3 spellings: refused before any filesystem call (P2.3's rule, also at dispatch time).
      const realpath = vi.fn((p: string) => p);
      const lstat = vi.fn(() => undefined);
      const canonical = (p: string, b: string) => canonicalAuthorityPath(p, b, { platform: "win32", realpath, lstat });
      for (const cwd of ["\\\\server\\share\\x", "\\\\?\\C:\\x", "//server/share", "C:\\Users\\PROGRA~1\\x"]) {
        expect(verificationScope(cwd, "C:\\repo\\wt", canonical)).toMatchObject({ outside: true, refused: cwd, cwd: "C:\\repo\\wt" });
      }
      expect(realpath).not.toHaveBeenCalled();
      expect(lstat).not.toHaveBeenCalled();
    } finally {
      for (const dir of [root, away]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.skipIf(process.platform === "win32")("QA-P33F1-1-2 (POSIX): a cwd `<root>/link/..` is where the filesystem says (outside), not `<root>`", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "scope-root-")));
    const away = realpathSync.native(mkdtempSync(join(tmpdir(), "scope-away-")));
    try {
      mkdirSync(join(away, "deep"));
      symlinkSync(join(away, "deep"), join(root, "link"), "dir");
      expect(verificationScope("link/..", root)).toMatchObject({ outside: true, cwd: root });
      expect(roleGateOutsideWorkRoot(root, `Do it\n[acceptance]\ncwd: ${join(root, "link")}/..\ncheck: fileExists path=x\n[/acceptance]`, "")).toBe(true);
    } finally {
      for (const dir of [root, away]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("QA-P21-1-3: a role child that hit its read-only CAP is a budget stop for the signals and gets the resume note", async () => {
    let snapshot: ((child: string) => ReturnType<typeof captureBudget>) | undefined;
    const { dir, cfg } = home({ ...ROLES, subagentTiers: { explorer: "fast" } }, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks, ingest } = await plugin(dir, "v2", { routerOnBudgetSnapshot: (read: typeof snapshot) => { snapshot = read; } });
    expect(snapshot).toBeDefined();
    const v2 = host(dir, cfg);
    await v2.start(hooks, { budgetSnapshot: snapshot! });
    const onSignal = vi.spyOn(ingest!, "onSignal");
    await hooks["chat.message"]({ sessionID: "c1", agent: "explorer" }, { message: { agent: "explorer" }, parts: [{ type: "text", text: "CAP:2\nFind the loader" }] });
    for (const i of [1, 2]) {
      const args = { filePath: join(dir, `c${i}.ts`) };
      await hooks["tool.execute.before"]({ tool: "read", sessionID: "c1", agent: "explorer", callID: `cr${i}` }, { args });
      await hooks["tool.execute.after"]({ tool: "read", sessionID: "c1", agent: "explorer", callID: `cr${i}`, args }, { title: "", output: "x", metadata: {} });
    }
    expect(snapshot!("c1").readCapReached).toBe(true);
    expect(budgetExhausted("c1")).toBe(false); // the guard itself did not stop it
    const event = parentCall("p1", "c1", "explorer", "NEED MORE: budget\nread 2 of 5 files");
    await v2.toolHooks["execute.after"](event);
    expect(resultText(event)).toContain(roleBudgetNotice("explorer", "c1"));
    const kinds = onSignal.mock.calls.filter(([child]) => child === "c1").map(([, observation]) => observation.kind);
    expect(kinds).toContain("budget");
    expect(kinds).not.toContain("incomplete");
  });

  it("QA-P21-1-4 + P2.2: the role hint replaces NEXT only after a FAIL; a role note never names a tier agent", async () => {
    const { dir } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks } = await plugin(dir);
    const verify = async (id: string, child: string, acceptance: string): Promise<string> => {
      rememberDispatch(child, {
        facts: { class: "implement", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
        agent: "implementer", model: "anthropic/x", variant: null, tier: "fast", parentSessionID: "root", step: "dispatch",
      });
      const args = { subagent_type: "implementer", description: "fix", prompt: `Fix the parser\n[acceptance]\n${acceptance}\n[/acceptance]` };
      await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: id }, { args: { ...args } });
      const output = { title: "", output: "DONE: fixed it", metadata: { sessionId: child } };
      await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: id, args }, output);
      return output.output;
    };
    const failed = await verify("v1", "r1", `check: fileExists path=${join(dir, "missing.txt")}`);
    expect(failed).toContain("NOT ACCEPTED");
    expect(failed).toContain('resume the same sessionID ("r1")');
    expect(failed).toContain("with @implementer and the findings");
    expect(failed).toContain("set neither `model` nor `tier=`");
    expect(failed).not.toContain("subagent_type");
    expect(failed).not.toMatch(/Task\(/);
    const unverifiable = await verify("v2", "r2", "criteria: the parser accepts every fixture");
    expect(unverifiable).not.toContain('resume the same sessionID ("r2")');
    expect(unverifiable).not.toContain("subagent_type");
  }, 60_000);

  it("QA-P21-1-7: a child that made a tool call while bypassed has unobserved edits for the run signal", async () => {
    const { dir } = home(ROLES);
    const { hooks } = await plugin(dir);
    const runs = vi.mocked(runSignal);
    const ret = async (child: string, id: string) => {
      runs.mockClear();
      await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: id, args: { subagent_type: "explorer", prompt: "Find" } },
        { title: "", output: "DONE: found", metadata: { sessionId: child } });
      return runs.mock.calls.at(-1)?.[0].editsObserved;
    };
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "b1", agent: "explorer", callID: "t1" }, { args: {} });
    expect(await ret("b1", "p1")).toBe(true);
    await hooks["command.execute.before"]({ command: "bypass", arguments: "on" }, { parts: [] });
    await hooks["tool.execute.before"]({ tool: "edit", sessionID: "b1", agent: "explorer", callID: "t2" }, { args: {} });
    await hooks["command.execute.before"]({ command: "bypass", arguments: "off" }, { parts: [] });
    expect(await ret("b1", "p2")).toBe(false);
  });

  it("QA-P21-1-8: a switch to roles mode at runtime registers nothing and asks for a restart; tools stay as started", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { dir, cfg } = home({}, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    writeFileSync(overridePath(), JSON.stringify(ROLES));
    invalidateConfigCache();
    await v2.sessionHooks.prompt({ sessionID: "root", prompt: { text: "hello" } });
    expect(JSON.stringify(warn.mock.calls)).toContain("restart OpenCode");
    expect(ROLES_RESTART_NOTICE).toContain("restart OpenCode");
    expect(Object.keys(hooks.tool ?? {})).not.toContain("router_run");
    const event = { sessionID: "root", agent: "build", messageID: "m", id: "r8", tool: "subagent", input: { agent: "explorer", description: "find", prompt: "find x" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](event);
    expect(event.input.description).toBe("find"); // no role routing: no nonce
    expect(routedRoleOf("r8")).toBeUndefined();
  });

  it("QA-P21-1-9: tiers mode returns before any resolution — a throwing resolver changes nothing", async () => {
    const agents: Record<string, Record<string, unknown>> = { explorer: { mode: "subagent", model: "host/x" } };
    const before = JSON.stringify(agents);
    const warnFn = vi.fn();
    const cfg = { routing: { delegation: "tiers" } } as unknown as RouterConfig;
    Object.defineProperty(cfg, "roleAgents", { get() { throw new Error("must not be read in tiers mode"); } });
    const result = await registerRoleAgents(agents, cfg, {
      context7: false, directory: "/nowhere", seed: {}, warn: warnFn,
      resolveTable: () => { throw new Error("must not be called in tiers mode"); },
      listWorktrees: async () => { throw new Error("must not be called in tiers mode"); },
    });
    expect(result.failed).toBe(false);
    expect(result.registered).toEqual([]);
    expect(JSON.stringify(agents)).toBe(before);
    expect(warnFn).not.toHaveBeenCalled();
  });

  it("QA-P21-1-12: the observer reads data.message and counts a retried step (same assistant message) once", () => {
    const o = createHostBudgetObserver();
    o.onEvent("session.tool.failed", { sessionID: "m1", message: "Tools are disabled after the maximum agent steps" });
    expect(o.observe("m1", 100)).toBe(true);
    o.onEvent("session.step.failed", { sessionID: "m2", assistantMessageID: "a1", message: "context_length_exceeded" });
    expect(o.observe("m2", 100)).toBe(true);
    for (const message of ["a1", "a1", "a2"]) o.onEvent("session.step.ended", { sessionID: "m3", assistantMessageID: message });
    o.onEvent("session.execution.succeeded", { sessionID: "m3" });
    expect(o.observe("m3", 3)).toBe(false); // 2 distinct steps
    expect(o.observe("m3", 2)).toBe(true);
  });

  it("QA-P21-2-2: after a verification FAIL the router raises the resumed child itself (consumed once, by that parent)", async () => {
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks } = await plugin(dir);
    const v2 = host(dir, cfg);
    await v2.start(hooks);
    rememberDispatch("rx", {
      facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      agent: "explorer", model: "anthropic/x", variant: null, tier: "fast", parentSessionID: "root", step: "dispatch",
    });
    const args = { subagent_type: "explorer", description: "find", prompt: `Find the loader\n[acceptance]\ncheck: fileExists path=${join(dir, "missing.txt")}\n[/acceptance]` };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: "root", callID: "f1" }, { args: { ...args } });
    const output = { title: "", output: "DONE: found it", metadata: { sessionId: "rx" } };
    await hooks["tool.execute.after"]({ tool: "task", sessionID: "root", agent: "build", callID: "f1", args }, output);
    expect(output.output).toContain("the router raises it to medium");
    expect(output.output).not.toContain("[route tier=");
    const resume = async (id: string) => {
      const event = { sessionID: "root", agent: "build", messageID: "m", id, tool: "subagent", input: { agent: "explorer", sessionID: "rx", prompt: "[route class=search risk=low scope=single]\naddress the findings" } as Record<string, unknown> };
      await v2.toolHooks["execute.before"](event);
      return routedRoleOf(id)!;
    };
    const raised = await resume("f2");
    expect(raised.tier).toBe("medium");
    expect(raised.notes).toContain("raise:verification-fail:medium");
    expect((await resume("f3")).notes.some((note) => note.startsWith("raise:"))).toBe(false); // consumed once
  }, 60_000);

  it("QA-P21-2-3: a role dispatch's own CAP:3 caps its child's reads (banners, CAP REACHED, budget note); no CAP, no cap", async () => {
    let snapshot: ((child: string) => ReturnType<typeof captureBudget>) | undefined;
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir, "v2", { routerOnBudgetSnapshot: (read: typeof snapshot) => { snapshot = read; } });
    const sessions: Record<string, Record<string, unknown>> = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks, { budgetSnapshot: snapshot! });
    const fresh = async (callID: string, child: string, prompt: string) => {
      const event = { sessionID: "root", agent: "build", messageID: "m", id: callID, tool: "subagent", input: { agent: "explorer", description: "find", prompt } as Record<string, unknown> };
      await v2.toolHooks["execute.before"](event);
      sessions[child] = { id: child, parentID: "root", agent: "explorer", title: event.input.description, location: { directory: dir } };
    };
    const read = async (child: string, i: number): Promise<string> => {
      const args = { path: join(dir, `${child}-${i}.ts`) };
      await v2.toolHooks["execute.before"]({ sessionID: child, agent: "explorer", messageID: "m", id: `${child}-${i}`, tool: "read", input: { ...args } });
      const output = { title: "", output: `content ${i}`, metadata: {} };
      await hooks["tool.execute.after"]({ tool: "read", sessionID: child, agent: "explorer", callID: `${child}-${i}`, args: { filePath: args.path } }, output);
      return output.output;
    };
    await fresh("k1", "capped", "CAP:3\nFind the loader");
    const outputs = [await read("capped", 1), await read("capped", 2), await read("capped", 3)];
    expect(outputs[0]).toContain("[cap: 1/3]");
    expect(outputs[2]).toContain("CAP REACHED (3/3)");
    expect(snapshot!("capped").readCapReached).toBe(true);
    const event = parentCall("k1", "capped", "explorer", "NEED MORE: budget\nread 3 files");
    await v2.toolHooks["execute.after"](event);
    expect(resultText(event)).toContain(`${ROUTER_BUDGET_NOTE_PREFIX} @explorer`);

    await fresh("k2", "uncapped", "Find the loader");
    expect(await read("uncapped", 1)).not.toContain("[cap:");
    expect(snapshot!("uncapped").readCapReached).toBe(false);
  });

  it("QA-P21-3-1: a reached read cap is a stop only with NEED MORE; a resume restarts the counter, keeping the cap", async () => {
    let snapshot: ((child: string) => ReturnType<typeof captureBudget>) | undefined;
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "1" });
    const { hooks, ingest } = await plugin(dir, "v2", { routerOnBudgetSnapshot: (read: typeof snapshot) => { snapshot = read; } });
    const sessions: Record<string, Record<string, unknown>> = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks, { budgetSnapshot: snapshot! });
    const onSignal = vi.spyOn(ingest!, "onSignal");
    const kinds = (child: string) => onSignal.mock.calls.filter(([c]) => c === child).map(([, observation]) => observation.kind);
    const dispatch = async (callID: string, child: string, prompt: string, resume = false) => {
      const event = { sessionID: "root", agent: "build", messageID: "m", id: callID, tool: "subagent", input: { agent: "explorer", description: "find", prompt, ...(resume ? { sessionID: child } : {}) } as Record<string, unknown> };
      await v2.toolHooks["execute.before"](event);
      if (!resume) sessions[child] = { id: child, parentID: "root", agent: "explorer", title: event.input.description, location: { directory: dir } };
    };
    const read = async (child: string, i: number): Promise<string> => {
      const args = { path: join(dir, `${child}-${i}.ts`) };
      await v2.toolHooks["execute.before"]({ sessionID: child, agent: "explorer", messageID: "m", id: `${child}-${i}`, tool: "read", input: { ...args } });
      const output = { title: "", output: `content ${i}`, metadata: {} };
      await hooks["tool.execute.after"]({ tool: "read", sessionID: child, agent: "explorer", callID: `${child}-${i}`, args: { filePath: args.path } }, output);
      return output.output;
    };
    const finish = async (callID: string, child: string, text: string): Promise<string> => {
      const event = parentCall(callID, child, "explorer", text);
      await v2.toolHooks["execute.after"](event);
      return resultText(event);
    };
    const atCap = async (callID: string, child: string) => {
      await dispatch(callID, child, "CAP:3\nFind the loader");
      for (const i of [1, 2, 3]) await read(child, i);
      expect(snapshot!(child).readCapReached).toBe(true);
    };

    // DONE at exactly the cap: a finished task, no budget note, no budget signal.
    await atCap("d1", "c-done");
    expect(await finish("d1", "c-done", "DONE: the loader is src/loader.ts:12")).not.toContain(ROUTER_BUDGET_NOTE_PREFIX);
    expect(kinds("c-done")).not.toContain("budget");
    // An unrelated ESCALATE at the cap is not a budget stop either (both guards observed: incomplete).
    await atCap("e1", "c-esc");
    expect(await finish("e1", "c-esc", "ESCALATE: the loader lives in another repository")).not.toContain(ROUTER_BUDGET_NOTE_PREFIX);
    expect(kinds("c-esc")).not.toContain("budget");
    expect(kinds("c-esc")).toContain("incomplete");
    // NEED MORE at the cap: the note; the resume "continue and finish" restarts the counter with the same cap; DONE: no note.
    await atCap("n1", "c-more");
    expect(await finish("n1", "c-more", "NEED MORE: budget\nread 3 of 6 files")).toContain(`${ROUTER_BUDGET_NOTE_PREFIX} @explorer`);
    expect(kinds("c-more")).toContain("budget");
    await dispatch("n2", "c-more", "continue and finish", true);
    expect(snapshot!("c-more").readCapReached).toBe(false);
    expect(await read("c-more", 4)).toContain("[cap: 1/3]");
    expect(await finish("n2", "c-more", "DONE: all six files read")).not.toContain(ROUTER_BUDGET_NOTE_PREFIX);
  });

  it("QA-P21-2-4: a role whose agent registration failed is not live — the dispatch takes the tier path, the protocol stays tiers", async () => {
    registration.broken = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let live: ((agent: string) => boolean) | undefined;
    const { dir, cfg } = home(ROLES, { MODEL_ROUTER_ENFORCE: "0" });
    const { hooks } = await plugin(dir, "v2", { routerRoleLive: (agent: string) => live?.(agent) });
    const v2 = host(dir, cfg);
    await v2.start(hooks, { onRoleLive: (isLive) => { live = isLive; } });
    expect(JSON.stringify(warn.mock.calls)).toContain("role agent registration failed");
    expect(live!("explorer")).toBe(false);
    const event = { sessionID: "root", agent: "build", messageID: "m", id: "l1", tool: "subagent", input: { agent: "explorer", description: "find", prompt: "find x" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"](event);
    expect(event.input.description).toBe("find"); // no nonce
    expect(event.input.model).toBeUndefined(); // no role model
    expect(routedRoleOf("l1")).toBeUndefined();
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root", model: { providerID: "openai", modelID: "gpt-x" } }, output);
    const enfOn = resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off";
    expect(output.system[0]).toBe(assembleSystemPrompt(cfg, "openai/gpt-x", enfOn));
  });

  it("QA-P21-2 nit 1: a context overflow named in error.data.message is a stop", () => {
    const o = createHostBudgetObserver();
    o.onEvent("session.step.failed", { sessionID: "n1", error: { type: "provider", data: { message: "prompt is too long: 230000 tokens" } } });
    expect(o.observe("n1", 100)).toBe(true);
  });

  it("QA-P21-2 nit 2: previewAuthority decides like consumeAuthority without consuming anything", () => {
    const general = resolveRoles(home(ROLES).cfg, "v2").get("general")!;
    const binding = (kind: "exact" | "unknown") => ({
      childSessionID: "pa", kind, grant: { actions: new Set(["read"] as const), notes: [], workRoot: "/w" }, candidates: [], decisionID: null, budget: null,
    });
    let kind: "exact" | "unknown" = "exact";
    const deps = { roleOf: () => general, roles: () => new Map([["general", general]]), bindingOf: () => binding(kind) as never };
    expect(previewAuthority("pa", deps, { afterCall: "c1", exactOnly: true })).toEqual({ status: "none" });
    requestAuthority("pa", { actions: ["edit"], reason: "patch" }, deps);
    expect(previewAuthority("pa", deps, { afterCall: "c1", exactOnly: true })).toEqual({ status: "dropped", reason: AUTHORITY_TEXT.dropped.notAnnotated });
    markAnnotated("pa", "c1", "root");
    expect(previewAuthority("pa", deps, { afterCall: "c2", exactOnly: true })).toEqual({ status: "dropped", reason: AUTHORITY_TEXT.dropped.otherCall });
    expect(previewAuthority("pa", deps, { afterCall: "c1", exactOnly: true })).toEqual({ status: "widened", widened: ["edit"] });
    kind = "unknown";
    expect(previewAuthority("pa", deps, { afterCall: "c1", exactOnly: true })).toEqual({ status: "dropped", reason: AUTHORITY_TEXT.dropped.bindingUnknown });
    expect(previewAuthority("pa", deps, { afterCall: "c1" })).toEqual({ status: "widened", widened: ["edit"] });
    expect(requestedAuthority("pa")).toMatchObject({ annotated: true, callID: "c1" }); // nothing consumed
  });

  it("P2.2: the budget note starts with the protocol's prefix", () => {
    expect(roleBudgetNotice("explorer", "x").startsWith(`${ROUTER_BUDGET_NOTE_PREFIX} `)).toBe(true);
    expect(roleBudgetNotice("explorer", "x", "host").startsWith(`${ROUTER_BUDGET_NOTE_PREFIX} `)).toBe(true);
  });
});
