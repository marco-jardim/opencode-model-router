/**
 * #84 P2.3 T2.3.4: authority enforcement end to end on OpenCode v2 roles mode (plan §2.2, §2.5, §2.8; spikes S3, S8, S11;
 * amendments P-3, P-12, P-13, P-17). Through the v2 adapter's own hook shapes (permission `evaluate`, session `context`, tool
 * `execute.before`/`execute.after`) around the real plugin, the real binding registry and the real authority ladder:
 * - I3: a role child can only use its dispatch grant — catalog filtered per session, native actions refused by `evaluate`, plugin
 *   tools refusing by themselves; under an allow-all parent too (#77 P2 lesson);
 * - I4: needs-derived grants never mix local/exec/write with egress; raw shell never granted;
 * - I5: parallel identical dispatches bind exactly by their own nonce; conflicting markers → unknown, never a union;
 * - I9: unknown binding → max ∩ local (+ the ladder for dynamic roles), `external_directory` denied, `router_run` refuses; hook
 *   errors fail closed for role agents (empty catalog, annotated; explicit deny) and leave other agents unchanged;
 * - T2.3.3: request → `ESCALATE: authority` → resume widens that child only, the floor is recomputed, the row records it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import {
  canonicalAuthorityPath, insideWorkRoot, registerV2Hooks, roleActionOf, roleAuthorityDecision, roleCatalogFailureNotice, roleToolKept,
} from "../../src/compat/v2-hooks";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath, validateConfig, type RouterConfig } from "../../src/router/config";
import { resetDispatchRegistry } from "../../src/router/sessions";
import { buildRoleLadder } from "../../src/routing/engine/ladders";
import { acquireOutcomes } from "../../src/routing/outcomes";
import type { DecisionRow, OutcomesBundle } from "../../src/routing/outcomes/types";
import { resetIngestState } from "../../src/routing/outcomes/ingest";
import { BINDING_NOTES, bind, currentBinding, resetBindingRegistryForTests } from "../../src/routing/roles/binding";
import { GRANT_NOTES } from "../../src/routing/roles/policy";
import { resetAuthorityForTests } from "../../src/routing/roles/authority";
import { createDispatchRouter, resetDispatchRouting, roleMaxActions, routedRoleOf } from "../../src/routing/wire/dispatch";
import { createEngineRuntime } from "../../src/routing/wire/runtime";
import { resolveRoles } from "../../src/router/roles";

// Each adapter test starts the real plugin (several seconds on a loaded machine): above vitest's 5 s default.
vi.setConfig({ testTimeout: 60_000 });

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
});

function temp(prefix = "omr-p23-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

const ROLES = { routing: { delegation: "roles" } };
const TIERS = ["fast", "medium", "heavy"];

/** HOME redirected to a temp dir whose global override holds `override`; returns the home and the loaded config. */
function home(override: Record<string, unknown> = {}): { dir: string; cfg: RouterConfig } {
  const dir = temp("omr-p23-home-");
  vi.stubEnv("HOME", dir); vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  return { dir, cfg: loadConfig(dir) };
}

/** A catalog listing every role rung model of the active preset, with its variants. */
function catalogOf(cfg: RouterConfig) {
  const byModel = new Map<string, Set<string>>();
  for (const tier of TIERS) {
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

async function plugin(directory: string): Promise<Record<string, any>> {
  const hooks = await ModelRouterPlugin({
    directory, worktree: directory, routerHost: "v2",
    client: {
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) },
      app: { log: vi.fn(async () => ({})) },
    },
  } as unknown as RouterPluginInput) as Record<string, any>;
  cleanups.push(async () => { await hooks.dispose?.(); });
  return hooks;
}

type Sessions = Record<string, Record<string, unknown>>;

/**
 * A minimal v2 host around the adapter: sessions by id (root has no parent), the agent map the adapter's transform PUBLISHES (so
 * the evaluate hook reads the real max policies), recorded tool/session/permission hooks, a per-session first message.
 */
function host(directory: string, cfg: RouterConfig, sessions: Sessions) {
  const toolHooks: Record<string, (event: any) => Promise<void>> = {};
  const sessionHooks: Record<string, (event: any) => Promise<void>> = {};
  const permissionHooks: Record<string, (event: any) => Promise<void>> = {};
  const agents: Record<string, any> = {};
  const register = () => ({ dispose: vi.fn(async () => {}) });
  const session = (id: string) => sessions[id] ?? (id === "root"
    ? { id, agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, location: { directory } }
    : { id, parentID: "root", agent: "explorer", location: { directory } });
  const ctx = {
    location: { directory, project: { directory } },
    agent: {
      reload: vi.fn(async () => {}),
      list: vi.fn(async () => ({ data: Object.values(agents) })),
      transform: vi.fn(async (cb: any) => {
        cb({ update: (id: string, apply: (agent: any) => void) => {
          agents[id] ??= { id, mode: "subagent", permissions: [], request: { settings: {}, headers: {}, body: {} } };
          apply(agents[id]);
        } });
        return register();
      }),
    },
    command: { reload: vi.fn(async () => {}), transform: vi.fn(async (cb: any) => { cb({ add: () => {} }); return register(); }) },
    model: { list: vi.fn(async () => ({ data: catalogOf(cfg) })) },
    tool: {
      transform: vi.fn(async (cb: any) => { cb({ add: () => {}, update: () => {} }); return register(); }),
      hook: vi.fn(async (name: string, cb: any) => { toolHooks[name] = cb; return register(); }),
    },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => session(sessionID)),
      context: vi.fn(async ({ sessionID }: { sessionID: string }) => (sessions[sessionID]?.messages as unknown[] | undefined) ?? []),
      update: vi.fn(async () => {}), prompt: vi.fn(async () => {}), synthetic: vi.fn(async () => {}),
      hook: vi.fn(async (name: string, cb: any) => { sessionHooks[name] = cb; return register(); }),
    },
    permission: { hook: vi.fn(async (name: string, cb: any) => { permissionHooks[name] = cb; return register(); }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    } },
  };
  return {
    ctx, agents, toolHooks, sessionHooks, permissionHooks,
    async start(hooks: Record<string, any>) {
      cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, undefined, { hostSettleMs: 0 }));
    },
  };
}

type Host = ReturnType<typeof host>;

/** The full catalog a host advertises under a parent that grants everything (S11 section 10). */
const FULL_CATALOG = ["read", "glob", "grep", "edit", "write", "patch", "execute", "shell", "subagent", "webfetch", "websearch", "router_run",
  "router_git_status", "router_git_diff", "router_request_authority", "router_verify", "todowrite", "mcp_tool", "context7_query-docs"];

/** One context build of `sessionID` as `agent` with `tools` advertised; returns the kept tool names (sorted). */
async function catalog(v2: Host, sessionID: string, agent: string, tools: readonly string[] = FULL_CATALOG): Promise<string[]> {
  const event = {
    sessionID, agent, model: { providerID: "anthropic", id: "claude-opus-5-5" }, options: {}, system: [], messages: [],
    tools: Object.fromEntries(tools.map((name) => [name, {}])),
  };
  await v2.sessionHooks.context!(event);
  return Object.keys(event.tools).sort();
}

/** One permission evaluation as the host sends it (`effect` = what the session rules decided before plugins). */
async function evaluate(v2: Host, sessionID: string, agent: string, action: string, resources: string[], effect = "allow") {
  const event: Record<string, unknown> = { sessionID, agent, action, resources, effect };
  await v2.permissionHooks.evaluate!(event);
  return event as { effect: string; message?: string };
}

/** A child's own tool call through the adapter's `execute.before` (rejects when refused). */
function toolCall(v2: Host, sessionID: string, agent: string, tool: string, input: Record<string, unknown>, id = `${sessionID}-${tool}-${Math.random()}`) {
  return v2.toolHooks["execute.before"]!({ sessionID, agent, messageID: "m", id, tool, input });
}

const toolCtx = (sessionID: string) => ({ sessionID, messageID: "m", agent: "x", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} });

const parentCall = (id: string, child: string, agent: string, text: string) => ({
  sessionID: "root", agent: "build", messageID: "m", id, tool: "subagent", input: { agent, prompt: "x" }, status: "completed",
  result: { output: { status: "completed", output: text, sessionID: child }, content: [{ type: "text", text }] },
});
const resultText = (event: { result: { content: Array<{ text?: string }> } }): string => event.result.content.map((part) => part.text ?? "").join("\n");

/**
 * A fresh role dispatch from the root through the adapter (route → nonce → pending entry); the child session then carries the
 * nonce in its title and as the last line of its first message, as the host would create it. Returns the input the host runs.
 */
async function dispatch(
  v2: Host, sessions: Sessions, callID: string, child: string, agent: string, prompt: string, location: string, description = "look around",
): Promise<Record<string, unknown>> {
  const event = { sessionID: "root", agent: "build", messageID: "m", id: callID, tool: "subagent", input: { agent, description, prompt } as Record<string, unknown> };
  await v2.toolHooks["execute.before"]!(event);
  sessions[child] = {
    id: child, parentID: "root", agent, title: event.input.description, location: { directory: location },
    messages: [{ role: "user", content: [{ type: "text", text: event.input.prompt }] }],
  };
  return event.input;
}

const kindOf = (cfg: RouterConfig, child: string) => currentBinding(child, { maxOf: (agent) => roleMaxActions(resolveRoles(cfg, "v2").get(agent)) })?.kind;

// ---------------------------------------------------------------------------
// Pure helpers (the enforcement matrix)
// ---------------------------------------------------------------------------

describe("enforcement helpers (T2.3.1, T2.3.2)", () => {
  it("maps host actions and tool names to role actions; anything else is no role action", () => {
    expect(["read", "glob", "grep", "edit", "webfetch", "websearch", "router_run"].map(roleActionOf)).toEqual(["read", "glob", "grep", "edit", "webfetch", "websearch", "router_run"]);
    expect(["write", "patch", "multiedit", "apply_patch"].map(roleActionOf)).toEqual(["edit", "edit", "edit", "edit"]);
    expect(roleActionOf("router_git_status")).toBe("router_git");
    expect(roleActionOf("context7_query-docs")).toBe("context7");
    expect(roleActionOf("external_directory")).toBe("external_directory");
    for (const other of ["execute", "shell", "bash", "subagent", "task", "todowrite", "mcp_tool", "router_verify", "list"]) expect(roleActionOf(other), other).toBeUndefined();
  });

  it("keeps a tool only when its action is granted; never execute; the ladder for dynamic roles only", () => {
    const local = { actions: new Set(["read", "glob", "grep", "router_git"] as const) };
    expect(FULL_CATALOG.filter((name) => roleToolKept(name, local, true)).sort()).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status", "router_request_authority"]);
    expect(FULL_CATALOG.filter((name) => roleToolKept(name, local, false)).sort()).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
    const all = { actions: new Set(["read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch", "context7", "execute"] as const) };
    expect(roleToolKept("execute", all, true)).toBe(false);
    expect(roleToolKept("shell", all, true)).toBe(false);
    expect(roleToolKept("subagent", all, true)).toBe(false);
  });

  it("canonical paths: `..` resolved, missing tails kept, wildcards refused; win32 8.3, UNC and drive-relative refused before any filesystem call", () => {
    const root = temp();
    mkdirSync(join(root, "src"));
    expect(canonicalAuthorityPath(join(root, "src", "..", "src", "new.ts"), root)).toBe(join(root, "src", "new.ts"));
    expect(canonicalAuthorityPath("src/a/b.ts", root)).toBe(join(root, "src", "a", "b.ts"));
    expect(canonicalAuthorityPath(join(root, "*"), root)).toBeUndefined();
    expect(canonicalAuthorityPath("", root)).toBeUndefined();
    const touched: string[] = [];
    const realpath = (p: string) => { touched.push(p); return p; };
    const win = { platform: "win32" as const, realpath };
    expect(canonicalAuthorityPath("C:\\git\\OMR-RT~1\\a.ts", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("C:\\git\\wt\\FILE~12.TXT", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("\\\\attacker\\share\\x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("//attacker/share/x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("\\\\?\\C:\\Windows\\x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("C:Windows\\x", "C:\\git", win)).toBeUndefined();
    expect(touched).toEqual([]);
    expect(canonicalAuthorityPath("C:/git/wt/../other/x.ts", "C:\\git", win)).toBe("C:\\git\\other\\x.ts");
    // An ancestor that cannot be resolved for another reason than "missing" refuses.
    const denied = (p: string): string => { throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" }); };
    expect(canonicalAuthorityPath("C:\\git\\x", "C:\\git", { platform: "win32", realpath: denied })).toBeUndefined();
  });

  it("work-root containment uses the max policy's matcher: the root and below; never a prefix sibling; case folded on win32 only", () => {
    const root = join(tmpdir(), "omr-p23-root");
    expect(insideWorkRoot(root, root)).toBe(true);
    expect(insideWorkRoot(join(root, "src", "a.ts"), root)).toBe(true);
    expect(insideWorkRoot(`${root}-evil`, root)).toBe(false);
    expect(insideWorkRoot(join(`${root}-evil`, "a.ts"), root)).toBe(false);
    expect(insideWorkRoot(dirname(root), root)).toBe(false);
    expect(insideWorkRoot(join(root, "a.ts"), join(tmpdir(), "omr-*"))).toBe(false); // a wildcard root contains nothing
    expect(insideWorkRoot(join(root.toUpperCase(), "a.ts"), root)).toBe(process.platform === "win32");
  });

  it("decision matrix: action × binding state → allow/deny (I3, I9, P-13)", () => {
    const root = temp();
    const session = temp();
    const exact = { kind: "exact" as const, grant: { actions: new Set(["read", "glob", "grep", "router_git", "edit"] as const), notes: [], workRoot: root } };
    const unknown = { kind: "unknown" as const, grant: { actions: new Set(["read", "glob", "grep", "router_git"] as const), notes: [], workRoot: null } };
    const noRoot = { kind: "exact" as const, grant: { actions: new Set(["read"] as const), notes: [], workRoot: null } };
    const egress = { kind: "exact" as const, grant: { actions: new Set(["webfetch", "websearch"] as const), notes: [], workRoot: root } };
    const decide = (binding: typeof exact | typeof unknown | typeof noRoot | typeof egress, action: string, paths: string[] = [], dynamic = false) =>
      roleAuthorityDecision({ action, paths, binding, dynamic, sessionDirectory: session, fallbackRoot: session }).allow;
    // exact binding with a work root
    expect(decide(exact, "read", [join(root, "a.ts")])).toBe(true);
    expect(decide(exact, "edit", [join(root, "src", "a.ts")])).toBe(true);
    expect(decide(exact, "write", [join(root, "b.ts")])).toBe(true);
    expect(decide(exact, "read", [join(session, "a.ts")])).toBe(false); // the session directory is not this dispatch's root
    expect(decide(exact, "read", [join(root, "..", "x.ts")])).toBe(false);
    expect(decide(exact, "external_directory", [`${root.replaceAll("\\", "/")}/src/*`])).toBe(true);
    expect(decide(exact, "external_directory", [`${root.replaceAll("\\", "/")}/../other/*`])).toBe(false);
    expect(decide(exact, "external_directory", [`${session.replaceAll("\\", "/")}/*`])).toBe(false);
    expect(decide(exact, "external_directory", [])).toBe(false);
    expect(decide(exact, "router_git_status")).toBe(true);
    expect(decide(exact, "router_run")).toBe(false); // not granted
    expect(decide(exact, "webfetch")).toBe(false);
    for (const never of ["execute", "shell", "subagent", "task", "todowrite", "mcp_tool"]) expect(decide(exact, never), never).toBe(false);
    expect(decide(exact, "router_request_authority", [], true)).toBe(true);
    expect(decide(exact, "router_request_authority", [], false)).toBe(false);
    // unknown binding (I9): local only, inside the fallback root; external_directory denied even inside it
    expect(decide(unknown, "read", [join(session, "a.ts")])).toBe(true);
    expect(decide(unknown, "read", [join(root, "a.ts")])).toBe(false);
    expect(decide(unknown, "edit", [join(session, "a.ts")])).toBe(false);
    expect(decide(unknown, "external_directory", [`${session.replaceAll("\\", "/")}/*`])).toBe(false);
    expect(decide(unknown, "router_run")).toBe(false);
    expect(decide(unknown, "router_request_authority", [], true)).toBe(true);
    // exact without a work root: no external_directory
    expect(decide(noRoot, "external_directory", [`${root.replaceAll("\\", "/")}/*`])).toBe(false);
    // a grant without a local action never gets external_directory (researcher, §2.2)
    expect(decide(egress, "external_directory", [`${root.replaceAll("\\", "/")}/*`])).toBe(false);
    expect(decide(egress, "webfetch")).toBe(true);
    expect(decide(egress, "read", [join(root, "a.ts")])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End to end through the adapter
// ---------------------------------------------------------------------------

describe("general with needs=[]: local only; the authority ladder widens that child only (I3, T2.3.3)", () => {
  it("edit denied → request → ESCALATE: authority → resume → edit granted on a tier ≥ the recomputed floor", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    const prompt = "Look at the parser module and report its entry points";
    await dispatch(v2, sessions, "p1", "g1", "general", prompt, dir);
    await dispatch(v2, sessions, "p3", "g2", "general", prompt, dir);
    expect(routedRoleOf("p1")?.window.floor).toBe("fast");
    // First context hook binds (P-2): local grant, the ladder advertised (dynamic role).
    expect(await catalog(v2, "g1", "general")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status", "router_request_authority"]);
    expect(kindOf(cfg, "g1")).toBe("exact");
    const file = join(dir, "a.ts");
    const denied = await evaluate(v2, "g1", "general", "edit", [file]);
    expect(denied.effect).toBe("deny");
    expect(denied.message).toMatch(/^Permission denied by role agent general for this dispatch: edit is not in this dispatch's grant/);
    await expect(toolCall(v2, "g1", "general", "edit", { path: file, oldString: "a", newString: "b" })).rejects.toThrow(/Refused for role agent general/);
    await toolCall(v2, "g1", "general", "read", { path: file }); // a granted call passes (and marks the role session)
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    expect(await tools.router_request_authority!.execute({ actions: ["edit"], reason: "the fix needs an edit" }, toolCtx("g1"))).toMatch(/Authority request recorded: edit/);
    const first = parentCall("p1", "g1", "general", "ESCALATE: authority\nedit is needed");
    await v2.toolHooks["execute.after"]!(first);
    expect(resultText(first)).toContain("[router] @general asked for more authority: edit.");
    // The resume widens the exact binding and recomputes the floor: write without exec, no detection → medium (§2.3).
    const resume = { sessionID: "root", agent: "build", messageID: "m", id: "p2", tool: "subagent", input: { agent: "general", sessionID: "g1", prompt: "continue" } as Record<string, unknown> };
    await v2.toolHooks["execute.before"]!(resume);
    const routed = routedRoleOf("p2")!;
    expect([...routed.grant.actions]).toContain("edit");
    expect(routed.window.floor).toBe("medium");
    expect(TIERS.indexOf(routed.tier)).toBeGreaterThanOrEqual(TIERS.indexOf("medium"));
    expect(routed.notes).toContain(BINDING_NOTES.widened(["edit"]));
    // The widened grant is live in the next evaluate and catalog of THAT child …
    expect((await evaluate(v2, "g1", "general", "edit", [file])).effect).toBe("allow");
    expect(await catalog(v2, "g1", "general")).toEqual(expect.arrayContaining(["edit", "patch", "write"]));
    await toolCall(v2, "g1", "general", "edit", { path: file, oldString: "a", newString: "b" });
    // … and only of that child: its sibling of the same parent and agent keeps the local grant.
    expect(await catalog(v2, "g2", "general")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status", "router_request_authority"]);
    expect((await evaluate(v2, "g2", "general", "edit", [file])).effect).toBe("deny");
  });

  it("the resume's decision row records the widened grant (rows, T2.3.3)", async () => {
    const bundled = JSON.parse(readFileSync(join(process.cwd(), "tiers.json"), "utf-8")) as Record<string, unknown>;
    const cfg = validateConfig({ ...bundled, activePreset: "anthropic", outcomes: { path: temp("omr-p23-outcomes-") }, routing: { delegation: "roles", engine: "shadow" } });
    const main = temp("omr-p23-main-");
    let captured: OutcomesBundle | null = null;
    const logger = { warn: vi.fn() };
    const runtime = createEngineRuntime({
      loadConfig: () => cfg, listAgents: async () => [], listModels: async () => catalogOf(cfg), logger,
      acquire: (options) => { captured = acquireOutcomes(options); return captured; },
    });
    cleanups.push(async () => { await runtime.dispose(); });
    const root = { id: "root", agent: "build", model: { providerID: "anthropic", id: "claude-opus-5-5" }, permissions: [], location: { directory: main } };
    const router = createDispatchRouter({
      runtime, graderAgent: "router-grader", directory: main, logger, env: {},
      getSession: async (id) => (id === "root" ? root : { id, parentID: "root", agent: "general", location: { directory: main } }),
      listWorktrees: async () => `worktree ${main.replace(/\\/g, "/")}\nHEAD 0\nbranch refs/heads/main\n`,
    });
    const freshInput = { agent: "general", description: "look", prompt: `[route class=search risk=low scope=single root=${main}]\nlook at the parser` };
    const fresh = await router.route({ callID: "r1", sessionID: "root", agent: "build", args: { ...freshInput }, cfg });
    expect([...fresh.role!.grant.actions]).not.toContain("edit");
    router.commit("r1", { ...freshInput, prompt: fresh.prompt, description: fresh.description, model: fresh.model });
    router.onSessionCreated({ sessionID: "child-g", parentID: "root", agent: "general", title: fresh.description });
    const maxOf = (agent: string) => roleMaxActions(resolveRoles(cfg, "v2").get(agent));
    expect((await bind("child-g", async () => ({ parentID: "root", agent: "general", title: fresh.description!, firstText: fresh.prompt! }), { maxOf })).kind).toBe("exact");
    const resumeInput = { agent: "general", sessionID: "child-g", prompt: "continue" };
    const resumed = await router.route({ callID: "r2", sessionID: "root", agent: "build", args: { ...resumeInput }, cfg, widened: ["edit"] });
    router.commit("r2", { ...resumeInput, model: resumed.model });
    const bundle = captured as OutcomesBundle | null;
    expect(bundle).not.toBeNull();
    await bundle!.flusher.flushNow();
    const rows = (await bundle!.persister.readRows()).rows.filter((row): row is DecisionRow => row.kind === "decision");
    const row = rows.find((r) => r.resume === true && r.childSessionID === "child-g");
    expect(row).toBeDefined();
    expect(row!.grant).toContain("edit");
    expect(row!.binding).toBe("exact");
    expect(row!.reason).toContain(BINDING_NOTES.widened(["edit"]));
    expect(TIERS.indexOf(row!.tier!)).toBeGreaterThanOrEqual(TIERS.indexOf("medium"));
  });
});

describe("needs-derived grants (I4)", () => {
  it("needs=web,edit on a local role → local grant + notes; needs=shell → exec + note, never raw shell", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single needs=web,edit]\nfind the parser and its docs online", dir);
    const explorer = routedRoleOf("e1")!;
    expect([...explorer.grant.actions].sort()).toEqual(["glob", "grep", "read", "router_git"]);
    expect(explorer.grant.notes).toEqual(expect.arrayContaining([GRANT_NOTES.web, GRANT_NOTES.edit]));
    expect(await catalog(v2, "x1", "explorer")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
    await dispatch(v2, sessions, "g1", "y1", "general", "[route class=implement risk=low scope=single needs=web,edit]\nfix the parser using the online docs", dir);
    const general = routedRoleOf("g1")!;
    expect([...general.grant.actions].sort()).toEqual(["edit", "glob", "grep", "read", "router_git"]);
    expect(general.grant.notes).toContain(GRANT_NOTES.web);
    expect(await catalog(v2, "y1", "general")).not.toEqual(expect.arrayContaining(["webfetch"]));
    await dispatch(v2, sessions, "g2", "y2", "general", "[route class=implement risk=low scope=single needs=shell]\nrun the build script", dir);
    const shell = routedRoleOf("g2")!;
    expect([...shell.grant.actions]).toContain("router_run");
    expect(shell.grant.notes).toContain(GRANT_NOTES.shell);
    const kept = await catalog(v2, "y2", "general");
    expect(kept).toContain("router_run");
    expect(kept).not.toContain("shell");
    expect((await evaluate(v2, "y2", "general", "shell", ["npm test"])).effect).toBe("deny");
  });
});

describe("binding (I5, I9)", () => {
  it("parallel identical dispatches bind exactly by their own nonce; a child carrying two dispatches' markers is unknown", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    const prompt = "[route class=implement risk=low scope=single needs=edit]\nfix the typo in the parser";
    const a = await dispatch(v2, sessions, "pa", "ca", "general", prompt, dir, "fix typo");
    const b = await dispatch(v2, sessions, "pb", "cb", "general", prompt, dir, "fix typo");
    expect(a.description).not.toBe(b.description); // each its own nonce
    expect(await catalog(v2, "ca", "general")).toContain("edit");
    expect(await catalog(v2, "cb", "general")).toContain("edit");
    expect(kindOf(cfg, "ca")).toBe("exact");
    expect(kindOf(cfg, "cb")).toBe("exact");
    expect(currentBinding("ca", { maxOf: () => ["read"] })?.candidates).toEqual(["pa"]);
    expect(currentBinding("cb", { maxOf: () => ["read"] })?.candidates).toEqual(["pb"]);
    // Two more identical dispatches; a child whose title names one and whose first message names the other → unknown.
    const c = await dispatch(v2, sessions, "pc", "cc", "general", prompt, dir, "fix typo");
    const d = await dispatch(v2, sessions, "pd", "cd", "general", prompt, dir, "fix typo");
    sessions.mixed = { ...sessions.cc!, id: "mixed", title: c.description, messages: [{ role: "user", content: [{ type: "text", text: d.prompt }] }] };
    // Unknown binding: max ∩ local, plus the ladder (dynamic role); no edit, no router_run, never execute.
    expect(await catalog(v2, "mixed", "general")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status", "router_request_authority"]);
    expect(kindOf(cfg, "mixed")).toBe("unknown");
    expect((await evaluate(v2, "mixed", "general", "edit", [join(dir, "a.ts")])).effect).toBe("deny");
    const external = await evaluate(v2, "mixed", "general", "external_directory", [`${dir.replaceAll("\\", "/")}/*`]);
    expect(external.effect).toBe("deny");
    await toolCall(v2, "mixed", "general", "read", { path: join(dir, "a.ts") }); // local stays usable inside the session directory
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    expect(await tools.router_run!.execute({ script: "test", cwd: dir }, toolCtx("mixed"))).toMatch(/no bound work root \(I9\)/);
    // A fixed role under an unknown binding: max ∩ local, no ladder.
    sessions.lost = { id: "lost", parentID: "root", agent: "explorer", title: "no marker", location: { directory: dir } };
    expect(await catalog(v2, "lost", "explorer")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
  });
});

describe("inherited grants and other sessions (I3, #77 P2 lesson)", () => {
  it("an allow-all parent cannot re-open anything; sibling and non-role sessions are untouched; Code Mode execute is absent", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single]\nfind the parser", dir);
    await dispatch(v2, sessions, "i1", "w1", "implementer", "[route class=implement risk=low scope=single needs=edit]\nfix the parser", dir);
    // The parent's session rules allowed everything (effect "allow" before plugins): every action outside the grant is refused.
    for (const [action, resources] of [["shell", ["npm test"]], ["shell", ["*"]], ["edit", [join(dir, "a.ts")]], ["subagent", ["general"]],
      ["webfetch", ["https://example.com"]], ["todowrite", ["*"]], ["execute", ["*"]], ["external_directory", ["C:/Windows/*"]], ["router_run", ["*"]]] as const) {
      const event = await evaluate(v2, "x1", "explorer", action, [...resources]);
      expect([action, event.effect]).toEqual([action, "deny"]);
    }
    expect((await evaluate(v2, "x1", "explorer", "read", [join(dir, "a.ts")])).effect).toBe("allow");
    // A sensitive read stays an ask (never widened to allow).
    expect((await evaluate(v2, "x1", "explorer", "read", [join(dir, ".env")])).effect).toBe("ask");
    // Catalog under an allow-all parent (the host advertises everything): filtered per session to the grant; execute absent.
    const explorer = await catalog(v2, "x1", "explorer");
    const implementer = await catalog(v2, "w1", "implementer");
    expect(explorer).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
    expect(implementer).toEqual(expect.arrayContaining(["edit", "write", "read"]));
    for (const kept of [explorer, implementer]) for (const never of ["execute", "shell", "subagent", "webfetch", "todowrite", "mcp_tool"]) expect(kept).not.toContain(never);
    await expect(toolCall(v2, "x1", "explorer", "execute", { code: "tools.opencode.session_rename({ title: 'x' })" })).rejects.toThrow(/never available to a role agent/);
    // The same tool map object filtered for one session leaves another session's map alone; non-role agents are not filtered.
    expect(await catalog(v2, "root", "build")).toEqual([...FULL_CATALOG].sort());
    expect(await catalog(v2, "x1", "explorer")).toEqual(explorer);
    expect((await evaluate(v2, "root", "build", "shell", ["npm test"])).effect).toBe("allow");
  });
});

describe("hook errors (I9, P-3)", () => {
  it("evaluate: a role agent's error is an explicit deny; a protected tier stays a plain deny; other agents are unchanged", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single]\nfind the parser", dir);
    v2.ctx.agent.list.mockRejectedValueOnce(new Error("boom"));
    const role = await evaluate(v2, "x1", "explorer", "read", [join(dir, "a.ts")]);
    expect(role).toMatchObject({ effect: "deny", message: expect.stringMatching(/^Permission denied by role agent explorer: the router could not check/) });
    v2.ctx.agent.list.mockRejectedValueOnce(new Error("boom"));
    const tier = await evaluate(v2, "t1", "fast", "read", [join(dir, "a.ts")]);
    expect(tier.effect).toBe("deny");
    expect(tier.message).toBeUndefined();
    v2.ctx.agent.list.mockRejectedValueOnce(new Error("boom"));
    expect(await evaluate(v2, "root", "build", "read", [join(dir, "a.ts")])).toEqual(expect.objectContaining({ effect: "allow" }));
    // An error inside the role check itself (the session lookup for relative paths) refuses too.
    v2.ctx.session.get.mockRejectedValueOnce(new Error("lookup down"));
    expect((await evaluate(v2, "x1", "explorer", "read", ["src/a.ts"])).effect).toBe("deny");
  });

  it("context: any error empties a role session's catalog and is annotated for the parent; other agents still see the error", async () => {
    const { dir, cfg } = home(ROLES);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single]\nfind the parser", dir);
    const broken = { sessionID: "x1", agent: "explorer", options: {}, system: [], messages: [], tools: Object.fromEntries(FULL_CATALOG.map((name) => [name, {}])) };
    await v2.sessionHooks.context!(broken); // no model: the hook body throws
    expect(Object.keys(broken.tools)).toEqual([]);
    await v2.sessionHooks.context!({ ...broken, tools: { read: {} } }); // annotated once per attempt
    const end = parentCall("e1", "x1", "explorer", "DONE: nothing found");
    await v2.toolHooks["execute.after"]!(end);
    const text = resultText(end);
    expect(text).toContain(roleCatalogFailureNotice("explorer", "x1"));
    expect(text.split(roleCatalogFailureNotice("explorer", "x1")).length).toBe(2);
    await expect(v2.sessionHooks.context!({ sessionID: "root", agent: "build", options: {}, system: [], messages: [], tools: { read: {} } })).rejects.toThrow();
  });
});

describe("work roots (I3, P-13): the dispatch's own worktree only", () => {
  const hasGit = (): boolean => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

  it.skipIf(!hasGit())("allows the bound worktree, denies another worktree, the base checkout and outside paths (incl. `..`, case, 8.3); router_run refuses a foreign cwd", async () => {
    const base = temp("omr-p23-repo-");
    const main = join(base, "main");
    mkdirSync(main);
    git(["init", "-q"], main);
    writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
    git(["add", "a.ts"], main);
    git(["commit", "-q", "-m", "init"], main);
    git(["worktree", "add", "-q", "-b", "b1", join(base, "wt-1")], main);
    git(["worktree", "add", "-q", "-b", "b2", join(base, "wt-2")], main);
    const wt1 = realpathSync.native(join(base, "wt-1"));
    const wt2 = realpathSync.native(join(base, "wt-2"));
    const other = join(base, "other");
    mkdirSync(other);
    const { cfg } = home(ROLES);
    const hooks = await plugin(main);
    const sessions: Sessions = {};
    const v2 = host(main, cfg, sessions);
    await v2.start(hooks);
    const slash = (p: string) => p.replaceAll("\\", "/");
    await dispatch(v2, sessions, "e1", "x1", "explorer", `[route class=search risk=low scope=single root=${wt1}]\nfind the parser`, main);
    expect(routedRoleOf("e1")?.workRoot).toBe(wt1);
    expect(await catalog(v2, "x1", "explorer")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
    const ext = (path: string) => evaluate(v2, "x1", "explorer", "external_directory", [`${slash(path)}/*`]);
    expect((await ext(wt1)).effect).toBe("allow");
    expect((await ext(join(wt1, "src", "deep"))).effect).toBe("allow");
    const sibling = await ext(wt2); // the max policy lists every worktree; only the per-session narrowing refuses it
    expect(sibling.effect).toBe("deny");
    expect(sibling.message).toMatch(/outside this dispatch's work root/);
    expect((await ext(other)).effect).toBe("deny");
    expect((await evaluate(v2, "x1", "explorer", "external_directory", [`${slash(wt1)}/../wt-2/*`])).effect).toBe("deny");
    expect((await evaluate(v2, "x1", "explorer", "external_directory", [`${slash(wt1)}/../../${base.split(/[\\/]/).pop()}/main/*`])).effect).toBe("deny");
    // Native reads: inside the bound root only (the base checkout is the session directory, not the work root).
    const read = (path: string) => evaluate(v2, "x1", "explorer", "read", [path]);
    expect((await read(join(wt1, "a.ts"))).effect).toBe("allow");
    expect((await read(join(main, "a.ts"))).effect).toBe("deny");
    expect((await read(join(wt2, "a.ts"))).effect).toBe("deny");
    expect((await read(join(wt1, "..", "wt-2", "a.ts"))).effect).toBe("deny");
    expect((await read("a.ts")).effect).toBe("deny"); // relative → the session directory (base checkout)
    if (process.platform === "win32") {
      expect((await read(join(wt1.toUpperCase(), "a.ts"))).effect).toBe("allow"); // case folded on win32, as the host matches
      expect((await read(join(wt2.toUpperCase(), "a.ts"))).effect).toBe("deny");
      expect((await read(join(base, "WT-1~1", "a.ts"))).effect).toBe("deny"); // an 8.3 spelling is refused, never expanded
      expect((await evaluate(v2, "x1", "explorer", "external_directory", [`${slash(base)}/WT-1~1/*`])).effect).toBe("deny");
    }
    // The tool side (execute.before): the file of read/edit and the search root of glob/grep (default: the session directory).
    await toolCall(v2, "x1", "explorer", "read", { path: join(wt1, "a.ts") });
    await expect(toolCall(v2, "x1", "explorer", "read", { path: join(main, "a.ts") })).rejects.toThrow(/outside this dispatch's work root/);
    await toolCall(v2, "x1", "explorer", "grep", { pattern: "export", path: wt1 });
    await expect(toolCall(v2, "x1", "explorer", "grep", { pattern: "export" })).rejects.toThrow(/outside this dispatch's work root/);
    await expect(toolCall(v2, "x1", "explorer", "glob", { pattern: "**/*.ts", path: wt2 })).rejects.toThrow(/outside this dispatch's work root/);
    // An unknown binding gets no external_directory even where the max policy allows it (I9).
    sessions.lost = { id: "lost", parentID: "root", agent: "explorer", title: "no marker", location: { directory: main } };
    const lost = await evaluate(v2, "lost", "explorer", "external_directory", [`${slash(wt1)}/*`]);
    expect(lost.effect).toBe("deny");
    expect(lost.message).toMatch(/binding unknown/);
    // router_run: the runner's own work root only (the tool refuses a foreign cwd itself; no evaluate fires for plugin tools).
    await dispatch(v2, sessions, "r1", "z1", "runner", `[route class=mechanical risk=low scope=single root=${wt1}]\nrun the unit tests`, main);
    expect([...routedRoleOf("r1")!.grant.actions]).toContain("router_run");
    expect(await catalog(v2, "z1", "runner")).toContain("router_run");
    await toolCall(v2, "z1", "runner", "read", { path: join(wt1, "a.ts") });
    const tools = hooks.tool as Record<string, { execute: (args: unknown, ctx: unknown) => Promise<string> }>;
    expect(await tools.router_run!.execute({ script: "test", cwd: wt2 }, toolCtx("z1"))).toMatch(/cwd is not this dispatch's work root/);
    expect(await tools.router_run!.execute({ script: "test", cwd: main }, toolCtx("z1"))).toMatch(/cwd is not this dispatch's work root/);
    // A general child with a local grant: router_run is not in its grant, so the tool refuses even its own root.
    await dispatch(v2, sessions, "g1", "y1", "general", `[route class=search risk=low scope=single root=${wt1}]\nlook at the parser`, main);
    await toolCall(v2, "y1", "general", "read", { path: join(wt1, "a.ts") });
    expect(await tools.router_run!.execute({ script: "test", cwd: wt1 }, toolCtx("y1"))).toMatch(/no bound work root \(I9\)/);
    await expect(toolCall(v2, "y1", "general", "router_run", { script: "test", cwd: wt1 })).rejects.toThrow(/not in this dispatch's grant/);
  }, 60_000);
});

describe("tiers mode is untouched (I1)", () => {
  it("no role narrowing: host agents keep their catalog and permissions", async () => {
    const { dir, cfg } = home();
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    expect(await catalog(v2, "g1", "general")).toEqual([...FULL_CATALOG].sort());
    expect((await evaluate(v2, "g1", "general", "edit", [join(dir, "a.ts")])).effect).toBe("allow");
    expect((await evaluate(v2, "g1", "general", "external_directory", ["C:/elsewhere/*"], "ask")).effect).toBe("ask");
    await toolCall(v2, "g1", "general", "edit", { path: join(dir, "a.ts"), oldString: "a", newString: "b" });
  });
});
