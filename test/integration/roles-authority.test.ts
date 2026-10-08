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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import {
  canonicalAuthorityPath, insideWorkRoot, patchPaths, registerV2Hooks, roleActionOf, roleAuthorityDecision, roleCatalogFailureNotice,
  roleToolKept, toolCallPaths, unsafeSearchPattern,
} from "../../src/compat/v2-hooks";
import { evaluatePermission } from "../../src/router/read-only";
import { SHIPPED_ROLE_SPECS } from "../../src/router/roles";
import { V2_GRADER_AGENT } from "../../src/compat/v2-client";

// QA-P23-B2: a pass-through spy on the adapter's dispatch router — the tests read which observed bindings it is told about.
const noted = vi.hoisted(() => ({ calls: [] as Array<{ child: string; kind: string }> }));
vi.mock("../../src/routing/wire/dispatch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/routing/wire/dispatch")>();
  return {
    ...actual,
    createDispatchRouter: (deps: Parameters<typeof actual.createDispatchRouter>[0]) => {
      const router = actual.createDispatchRouter(deps);
      return {
        ...router,
        noteBinding: (child: string, binding: Parameters<typeof router.noteBinding>[1]) => {
          noted.calls.push({ child, kind: binding.kind });
          router.noteBinding(child, binding);
        },
      };
    },
  };
});
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
import {
  createDispatchRouter, gitWorktreeList, parseWorktreeList, resetDispatchRouting, roleMaxActions, routedRoleOf,
} from "../../src/routing/wire/dispatch";
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
  noted.calls.length = 0;
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
    async start(hooks: Record<string, any>, options: Parameters<typeof registerV2Hooks>[3] = {}) {
      cleanups.push(await registerV2Hooks(ctx as unknown as Context, hooks as Hooks, undefined, { hostSettleMs: 0, ...options }));
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
    // A win32 realpath normalises `..` lexically, as the OS does before it touches the filesystem.
    const realpath = (p: string) => { touched.push(p); return win32.normalize(p); };
    const lstat = (p: string) => { touched.push(`lstat:${p}`); throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    const win = { platform: "win32" as const, realpath, lstat };
    expect(canonicalAuthorityPath("C:\\git\\OMR-RT~1\\a.ts", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("C:\\git\\wt\\FILE~12.TXT", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("\\\\attacker\\share\\x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("//attacker/share/x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("\\\\?\\C:\\Windows\\x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("C:Windows\\x", "C:\\git", win)).toBeUndefined();
    expect(canonicalAuthorityPath("\\Windows\\x", "C:\\git", win)).toBeUndefined(); // rooted, no drive
    expect(touched).toEqual([]);
    expect(canonicalAuthorityPath("C:/git/wt/../other/x.ts", "C:\\git", win)).toBe("C:\\git\\other\\x.ts");
    // An ancestor that cannot be resolved for another reason than "missing" refuses.
    const denied = (p: string): string => { throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" }); };
    expect(canonicalAuthorityPath("C:\\git\\x", "C:\\git", { platform: "win32", realpath: denied })).toBeUndefined();
  });

  it("QA-P23-A1: the raw path goes to realpath first; only a truly missing tail is peeled; dangling links and `..` in a missing tail refuse", () => {
    const enoent = (p: string) => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
    const seen: string[] = [];
    // The raw string reaches realpath unnormalised (POSIX semantics: links before `..`).
    const posixReal = (p: string): string => { seen.push(p); if (p === "/r/link/../x") return "/elsewhere/x"; throw enoent(p); };
    expect(canonicalAuthorityPath("link/../x", "/r", { platform: "linux", realpath: posixReal, lstat: (p) => { throw enoent(p); } })).toBe("/elsewhere/x");
    expect(seen[0]).toBe("/r/link/../x");
    // An entry lstat sees but realpath cannot resolve: a dangling link refuses, wherever it is in the path.
    const exists = new Set(["/r", "/r/dangling"]);
    const real = (p: string): string => { if (p === "/r") return "/r"; throw enoent(p); };
    const lstat = (p: string): unknown => { if (exists.has(p)) return {}; throw enoent(p); };
    expect(canonicalAuthorityPath("/r/dangling", "/r", { platform: "linux", realpath: real, lstat })).toBeUndefined();
    expect(canonicalAuthorityPath("/r/dangling/x/y", "/r", { platform: "linux", realpath: real, lstat })).toBeUndefined();
    expect(canonicalAuthorityPath("/r/new/x", "/r", { platform: "linux", realpath: real, lstat })).toBe("/r/new/x");
    // A `..` left in the missing tail refuses (it could climb over the existing ancestor).
    expect(canonicalAuthorityPath("/r/missing/../x", "/r", { platform: "linux", realpath: real, lstat })).toBeUndefined();
    // Another lstat error refuses as well.
    const lstatDenied = (p: string): unknown => { throw Object.assign(new Error(`EACCES ${p}`), { code: "EACCES" }); };
    expect(canonicalAuthorityPath("/r/x", "/r", { platform: "linux", realpath: real, lstat: lstatDenied })).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("QA-P23-A1 (POSIX): `<root>/link/../x` resolves through the link, outside the root", () => {
    const base = temp();
    const root = join(base, "root");
    const inner = join(base, "outside", "inner");
    mkdirSync(root);
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(base, "outside", "secret.txt"), "s");
    symlinkSync(inner, join(root, "link"), "dir");
    const existing = canonicalAuthorityPath(`${root}/link/../secret.txt`, root)!;
    expect(existing).toBe(join(realpathSync.native(base), "outside", "secret.txt"));
    expect(insideWorkRoot(existing, root)).toBe(false);
    const missing = canonicalAuthorityPath("link/../missing/x.ts", root)!;
    expect(insideWorkRoot(missing, root)).toBe(false);
  });

  it("QA-P23-A1: a dangling link (a junction on win32) inside the root is refused, not peeled", (ctx) => {
    const base = temp();
    const root = join(base, "root");
    mkdirSync(root);
    try {
      symlinkSync(join(base, "nowhere"), join(root, "dangling"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip(); // no link creation on this machine
      return;
    }
    expect(canonicalAuthorityPath(join(root, "dangling"), root)).toBeUndefined();
    expect(canonicalAuthorityPath(join(root, "dangling", "x.ts"), root)).toBeUndefined();
    expect(roleAuthorityDecision({
      action: "edit", paths: [join(root, "dangling", "x.ts")], dynamic: false, sessionDirectory: root, fallbackRoot: root,
      binding: { kind: "exact", grant: { actions: new Set(["read", "edit"] as const), notes: [], workRoot: root } },
    }).allow).toBe(false);
  });

  it("QA-P23-A2/A3: every path a call names — filePath, path, file_path, edits[], patch headers; none or an unreadable patch → undefined", () => {
    expect(toolCallPaths("edit", { filePath: "/a", path: "b", file_path: "/c" })).toEqual(["/a", "b", "/c"]);
    expect(toolCallPaths("edit", { edits: [{ filePath: "/a" }, { path: "/b" }, { file_path: "/c" }, null] })).toEqual(["/a", "/b", "/c"]);
    expect(toolCallPaths("edit", { oldString: "x" })).toBeUndefined();
    const patch = ["*** Begin Patch", "*** Update File: src/a.ts", "*** Move to: ../out.ts", "@@", "-a", "+b", "*** Add File: /tmp/x.ts", "+x",
      "  *** Delete File: c.ts", "*** End Patch"].join("\n");
    expect(patchPaths(patch)).toEqual(["src/a.ts", "../out.ts", "/tmp/x.ts", "c.ts"]);
    expect(toolCallPaths("apply_patch", { patchText: patch })).toEqual(["src/a.ts", "../out.ts", "/tmp/x.ts", "c.ts"]);
    expect(patchPaths("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n")).toBeUndefined(); // unified diff: not the host format → refused
    expect(patchPaths("*** Begin Patch\n*** Add File:   \n+x\n*** End Patch")).toBeUndefined();
    expect(toolCallPaths("apply_patch", { patchText: "*** Begin Patch\n*** End Patch" })).toBeUndefined();
    expect(toolCallPaths("apply_patch", {})).toBeUndefined();
  });

  it("QA-P23-A9: search patterns that reach outside their root by themselves", () => {
    for (const bad of ["/etc/**", "\\Windows\\*", "C:/x/**", "c:*.ts", "\\\\server\\share\\*", "//server/share/*", "../other/**", "src/../../x", "a/..", ".."]) {
      expect(unsafeSearchPattern(bad), bad).toBe(true);
    }
    for (const ok of ["**/*.ts", "src/*.{ts,tsx}", "a..b/*.ts", "*.d.ts", "..foo"]) expect(unsafeSearchPattern(ok), ok).toBe(false);
  });

  it("QA-P23-A4: parseWorktreeList drops prunable entries and keeps git's order", () => {
    const porcelain = [
      "worktree /repo/main", "HEAD 1", "branch refs/heads/main", "",
      "worktree /repo/wt-1", "HEAD 2", "branch refs/heads/b1", "prunable gitdir file points to non-existent location", "",
      "worktree /repo/wt-2", "HEAD 3", "detached", "",
      "worktree /repo/wt-3", "HEAD 4", "prunable", "",
    ].join("\r\n");
    expect(parseWorktreeList(porcelain)).toEqual(["/repo/main", "/repo/wt-2"]);
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
    await expect(v2.ctx.agent.list()).rejects.toThrow("boom"); // still queued: a non-protected agent never reads the agent list
    // QA-P23-B3: an error inside the role check itself — the child is bound first, then the session lookup for its relative path
    // fails — refuses with the explicit message.
    expect(await catalog(v2, "x1", "explorer")).toContain("read");
    expect(kindOf(cfg, "x1")).toBe("exact");
    v2.ctx.session.get.mockRejectedValueOnce(new Error("lookup down"));
    const failed = await evaluate(v2, "x1", "explorer", "read", ["src/a.ts"]);
    expect(failed.effect).toBe("deny");
    expect(failed.message).toMatch(/could not check this dispatch's authority/);
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
    let listed = 0;
    await v2.start(hooks, { listWorktrees: (cwd) => { listed += 1; return gitWorktreeList(cwd); } });
    const slash = (p: string) => p.replaceAll("\\", "/");
    await dispatch(v2, sessions, "e1", "x1", "explorer", `[route class=search risk=low scope=single root=${wt1}]\nfind the parser`, main);
    expect(routedRoleOf("e1")?.workRoot).toBe(wt1);
    expect(await catalog(v2, "x1", "explorer")).toEqual(["glob", "grep", "read", "router_git_diff", "router_git_status"]);
    const ext = (path: string) => evaluate(v2, "x1", "explorer", "external_directory", [`${slash(path)}/*`]);
    // QA-P23-A12 / N2: concurrent evaluations of one child share one binding and one `git worktree list` run.
    const concurrent = await Promise.all([...Array(6).keys()].map((i) => (i % 2 === 0 ? ext(wt1) : ext(join(wt1, "src")))));
    expect(concurrent.map((event) => event.effect)).toEqual(Array(6).fill("allow"));
    expect(listed).toBe(1);
    expect(new Set(noted.calls.filter((call) => call.child === "x1").map((call) => call.kind))).toEqual(new Set(["exact"]));
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
    // QA-P23-A9: a glob pattern or grep include that climbs out of its search root is refused, in evaluate and in execute.before.
    await expect(toolCall(v2, "x1", "explorer", "glob", { pattern: "../wt-2/**", path: wt1 })).rejects.toThrow(/reaches outside its search root/);
    await expect(toolCall(v2, "x1", "explorer", "grep", { pattern: "x", include: `${slash(wt2)}/*.ts`, path: wt1 })).rejects.toThrow(/reaches outside/);
    const globEvent = { sessionID: "x1", agent: "explorer", action: "glob", resources: ["../wt-2/**"], effect: "allow", metadata: { root: wt1, path: wt1 } };
    await v2.permissionHooks.evaluate!(globEvent);
    expect(globEvent.effect).toBe("deny");
    // N1: the host asserts no external_directory for glob/grep — their search root (metadata.path, default `.`) is checked here.
    const grepHere = { sessionID: "x1", agent: "explorer", action: "grep", resources: ["export"], effect: "allow", metadata: { root: ".", path: wt1 } };
    await v2.permissionHooks.evaluate!(grepHere);
    expect(grepHere.effect).toBe("allow");
    const grepDefault = { sessionID: "x1", agent: "explorer", action: "grep", resources: ["export"], effect: "allow", metadata: { root: "." } };
    await v2.permissionHooks.evaluate!(grepDefault);
    expect(grepDefault.effect).toBe("deny"); // `.` is the base checkout, not this dispatch's root
    // QA-P23-A4: a listed root whose `.git` is no longer a linked worktree's file (here: a directory in its place) does not count.
    await dispatch(v2, sessions, "e2", "x2", "explorer", `[route class=search risk=low scope=single root=${wt2}]\nfind the parser`, main);
    expect(routedRoleOf("e2")?.workRoot).toBe(wt2);
    expect(await catalog(v2, "x2", "explorer")).toContain("read");
    rmSync(join(wt2, ".git"), { force: true });
    mkdirSync(join(wt2, ".git"));
    const replaced = await evaluate(v2, "x2", "explorer", "external_directory", [`${slash(wt2)}/*`]);
    expect(replaced.effect).toBe("deny");
    expect(replaced.message).toMatch(/no longer a worktree/);
  }, 60_000);
});

describe("QA round 1 (P2.3)", () => {
  async function started(override: Record<string, unknown> = ROLES) {
    const { dir, cfg } = home(override);
    const hooks = await plugin(dir);
    const sessions: Sessions = {};
    const v2 = host(dir, cfg, sessions);
    await v2.start(hooks);
    return { dir, cfg, hooks, sessions, v2 };
  }

  it("B4: the ladder's explicit allow is published for dynamic roles only — never fixed roles, tiers or the grader", async () => {
    const { v2 } = await started();
    for (const spec of SHIPPED_ROLE_SPECS) {
      const effect = evaluatePermission(v2.agents[spec.agent].permissions, "router_request_authority", "*");
      expect([spec.agent, effect]).toEqual([spec.agent, spec.authority.mode === "dynamic" ? "allow" : "deny"]);
    }
    for (const name of ["fast", "medium", "heavy", V2_GRADER_AGENT]) {
      expect([name, evaluatePermission(v2.agents[name]?.permissions ?? [], "router_request_authority", "*")]).not.toEqual([name, "allow"]);
    }
  });

  it("B1 + N3: a role session's protected-catalog or binding-lookup failure empties its catalog AND annotates the parent, again on the next attempt", async () => {
    const { dir, v2, sessions } = await started();
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single]\nfind the parser", dir);
    v2.ctx.agent.list.mockRejectedValueOnce(new Error("agents down"));
    expect(await catalog(v2, "x1", "explorer")).toEqual([]);
    const first = parentCall("e1", "x1", "explorer", "DONE: nothing");
    await v2.toolHooks["execute.after"]!(first);
    expect(resultText(first)).toContain(roleCatalogFailureNotice("explorer", "x1"));
    // N3: the call ended (catalogFailures cleared): a failure of the next attempt — here the binding lookup — is annotated again.
    await dispatch(v2, sessions, "e2", "x2", "explorer", "[route class=search risk=low scope=single]\nfind the lexer", dir);
    v2.ctx.session.get.mockRejectedValueOnce(new Error("lookup down"));
    expect(await catalog(v2, "x2", "explorer")).toEqual([]);
    // B2: a binding the registry could not keep was never reported as observed; the later, stored one is.
    expect(noted.calls.filter((call) => call.child === "x2").map((call) => call.kind)).toEqual([]);
    expect(await catalog(v2, "x2", "explorer")).toContain("read");
    expect(new Set(noted.calls.filter((call) => call.child === "x2").map((call) => call.kind))).toEqual(new Set(["exact"]));
    const second = parentCall("e2", "x2", "explorer", "DONE: nothing");
    await v2.toolHooks["execute.after"]!(second);
    expect(resultText(second)).toContain(roleCatalogFailureNotice("explorer", "x2"));
    v2.ctx.agent.list.mockRejectedValueOnce(new Error("agents down"));
    expect(await catalog(v2, "x1", "explorer")).toEqual([]);
    const third = parentCall("e3", "x1", "explorer", "DONE: nothing");
    await v2.toolHooks["execute.after"]!(third);
    expect(resultText(third)).toContain(roleCatalogFailureNotice("explorer", "x1"));
  });

  it("A8: no agent on the event and a failing session lookup — a known role session is denied; an unknown session is unchanged", async () => {
    const { dir, v2, sessions } = await started();
    await dispatch(v2, sessions, "e1", "x1", "explorer", "[route class=search risk=low scope=single]\nfind the parser", dir);
    expect(await catalog(v2, "x1", "explorer")).toContain("read"); // bound
    v2.ctx.session.get.mockRejectedValueOnce(new Error("lookup down"));
    const known: Record<string, unknown> = { sessionID: "x1", action: "read", resources: [join(dir, "a.ts")], effect: "allow" };
    await v2.permissionHooks.evaluate!(known);
    expect(known).toMatchObject({ effect: "deny", message: expect.stringMatching(/could not check this dispatch's authority/) });
    v2.ctx.session.get.mockRejectedValueOnce(new Error("lookup down"));
    const stranger: Record<string, unknown> = { sessionID: "nobody", action: "read", resources: [join(dir, "a.ts")], effect: "allow" };
    await v2.permissionHooks.evaluate!(stranger);
    expect(stranger.effect).toBe("allow");
    await expect(v2.toolHooks["execute.before"]!({ sessionID: "x1", messageID: "m", id: "t-noagent", tool: "read", input: { path: join(dir, "a.ts") } }))
      .rejects.toThrow(/calling agent is unknown/);
  });

  it("A7: a role session's call to any tool outside the role classes is refused — subagent, shell, todowrite, MCP tools", async () => {
    const { dir, v2, sessions } = await started();
    await dispatch(v2, sessions, "g1", "y1", "general", "[route class=implement risk=low scope=single needs=edit]\nfix the parser", dir);
    for (const [tool, input] of [["subagent", { agent: "implementer", description: "x", prompt: "do it" }], ["shell", { command: "npm test" }],
      ["todowrite", { todos: [] }], ["mcp_tool", {}], ["router_verify", {}]] as const) {
      await expect(toolCall(v2, "y1", "general", tool, { ...input }), tool).rejects.toThrow(/outside every role's authority/);
    }
    await toolCall(v2, "y1", "general", "router_request_authority", { actions: ["router_run"], reason: "x" }); // the ladder stays callable
  });

  it("A2/A3/A5: every path of an edit/write/apply_patch call is checked; a call naming none, or an empty evaluation, is refused", async () => {
    const { dir, v2, sessions } = await started();
    await dispatch(v2, sessions, "i1", "w1", "implementer", "[route class=implement risk=low scope=single needs=edit]\nfix the parser", dir);
    const outside = join(dirname(dir), "elsewhere.ts");
    const inside = join(dir, "src", "a.ts");
    await toolCall(v2, "w1", "implementer", "edit", { path: inside, oldString: "a", newString: "b" });
    await expect(toolCall(v2, "w1", "implementer", "edit", { path: inside, file_path: outside, oldString: "a", newString: "b" })).rejects.toThrow(/outside this dispatch's work root/);
    await expect(toolCall(v2, "w1", "implementer", "edit", { path: inside, edits: [{ filePath: inside }, { filePath: outside }] })).rejects.toThrow(/outside/);
    await expect(toolCall(v2, "w1", "implementer", "write", { content: "x" })).rejects.toThrow(/no path to check/);
    const patch = (lines: string[]) => ({ patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") });
    await toolCall(v2, "w1", "implementer", "apply_patch", patch(["*** Update File: src/a.ts", "@@", "-a", "+b", "*** Add File: src/b.ts", "+b"]));
    await expect(toolCall(v2, "w1", "implementer", "apply_patch", patch(["*** Update File: src/a.ts", "@@", "-a", "+b", `*** Add File: ${outside}`, "+x"]))).rejects.toThrow(/outside/);
    await expect(toolCall(v2, "w1", "implementer", "apply_patch", patch(["*** Update File: src/a.ts", "*** Move to: ../elsewhere.ts", "@@", "-a", "+b"]))).rejects.toThrow(/outside/);
    await expect(toolCall(v2, "w1", "implementer", "apply_patch", patch(["*** Delete File: ../elsewhere.ts"]))).rejects.toThrow(/outside/);
    await expect(toolCall(v2, "w1", "implementer", "apply_patch", { patchText: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" })).rejects.toThrow(/no path to check/);
    // A5: the host always names the resource; an evaluation without one is refused for read/edit.
    expect((await evaluate(v2, "w1", "implementer", "edit", [])).effect).toBe("deny");
    expect((await evaluate(v2, "w1", "implementer", "read", [])).effect).toBe("deny");
    expect((await evaluate(v2, "w1", "implementer", "edit", ["src/a.ts"])).effect).toBe("allow"); // Location-relative, as the host sends it
  });

  it("A11: a plugin directory that does not resolve yet is not cached as unresolvable", async () => {
    const { dir: homeDir, cfg } = home(ROLES);
    const hooks = await plugin(homeDir);
    const later = join(homeDir, "later");
    const sessions: Sessions = { lost: { id: "lost", parentID: "root", agent: "explorer", title: "no marker", location: { directory: later } } };
    const v2 = host(later, cfg, sessions);
    await v2.start(hooks);
    const before = await evaluate(v2, "lost", "explorer", "read", [join(later, "a.ts")]);
    expect(before.effect).toBe("deny");
    expect(before.message).toMatch(/no work root could be resolved/);
    mkdirSync(later);
    expect((await evaluate(v2, "lost", "explorer", "read", [join(realpathSync.native(later), "a.ts")])).effect).toBe("allow");
  });
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
