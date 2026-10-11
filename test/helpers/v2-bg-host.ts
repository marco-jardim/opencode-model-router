/**
 * test/helpers/v2-bg-host.ts
 *
 * Phase 2.1 (task 2.1.8): a fake Claude Code v2 host for the background / lease integration tests. It drives the REAL plugin
 * (`src/index.ts`, `routerHost: "v2"`) behind the REAL adapter (`registerV2Hooks`). The host owns:
 *  - the tool hooks (`execute.before` / `execute.after`) and session hooks (`context`, `prompt`, `compaction`) the adapter registers;
 *  - an event queue the adapter's event loop consumes (`emit`), with a `drain` that waits until the loop took everything;
 *  - a session table (parent, directory) and `session.context` results per child;
 *  - every `session.synthetic` call, recorded.
 * Nothing sleeps: waits are microtask turns or an explicit fake clock of the test.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { registerV2Hooks } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { removeDirWhenReleased } from "./remove-dir";

export interface SessionSpec {
  parentID?: string;
  directory?: string;
  agent?: string;
}

export interface SyntheticCall {
  sessionID: string;
  text: string;
  description?: string;
  metadata?: Record<string, unknown>;
  resume?: boolean;
}

export interface ToolEvent {
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  tool: string;
  input?: unknown;
  status?: string;
  result?: unknown;
  error?: unknown;
}

type AnyHook = (event: never) => Promise<void>;

export interface BgHost {
  home: string;
  project: string;
  sessions: Map<string, SessionSpec>;
  /** `session.context(child)` answers; `undefined` = an empty context. */
  childContext: Map<string, unknown[]>;
  synthetic: SyntheticCall[];
  sessionHooks: Record<string, (event: never) => Promise<void>>;
  toolHooks: Record<string, (event: never) => Promise<void>>;
  hooks: Hooks;
  /** Queue a host event for the adapter's event loop. */
  emit(event: unknown): void;
  /** Resolves when the event loop consumed everything queued and settled its async work (bounded microtask turns). */
  drain(): Promise<void>;
  before(event: ToolEvent): Promise<ToolEvent>;
  after(event: ToolEvent): Promise<ToolEvent>;
  context(event: unknown): Promise<void>;
  dispose(): Promise<void>;
}

export interface BootOptions {
  /** Written to the global override file before anything reads the config. */
  overrides?: Record<string, unknown>;
  sessions?: Record<string, SessionSpec>;
  /** Extra `ctx.session` members (e.g. no `synthetic`). */
  omitSynthetic?: boolean;
  omitCompaction?: boolean;
  /** A fixed pending.jsonl text written under the outcomes dir before boot (a previous process's journal). */
  journalText?: string;
  /** Re-use a home from an earlier boot (a restart). */
  home?: string;
  routerHost?: "v2" | "v1";
}

const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ENFORCE: process.env.MODEL_ROUTER_ENFORCE };

export function restoreEnv(): void {
  for (const [key, value] of [["HOME", saved.HOME], ["USERPROFILE", saved.USERPROFILE], ["MODEL_ROUTER_ENFORCE", saved.ENFORCE]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateConfigCache();
}

export async function bootBgHost(options: BootOptions = {}): Promise<BgHost> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "omr-v2-bg-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(dirname(overridePath()), { recursive: true });
  // The outcome store (and pending.jsonl next to it) lives under the test's home: a restart re-uses `options.home`.
  const outcomes = join(home, "outcomes");
  const given = (options.overrides ?? {}) as { routing?: Record<string, unknown> };
  writeFileSync(overridePath(), JSON.stringify({ ...given, routing: { ...(given.routing ?? {}), outcomes: { path: outcomes } } }), "utf-8");
  invalidateConfigCache();

  const sessions = new Map<string, SessionSpec>(Object.entries(options.sessions ?? {}));
  const childContext = new Map<string, unknown[]>();
  const synthetic: SyntheticCall[] = [];
  const sessionHooks: Record<string, (event: never) => Promise<void>> = {};
  const toolHooks: Record<string, (event: never) => Promise<void>> = {};
  const queue: unknown[] = [];
  let wake = (): void => undefined;
  let waiting = false;
  const registrations: Array<{ dispose: () => Promise<void> }> = [];
  const register = () => {
    const value = { dispose: async () => undefined };
    registrations.push(value);
    return value;
  };
  const noop = async () => register();

  const sessionGet = async ({ sessionID }: { sessionID: string }) => {
    const spec = sessions.get(sessionID);
    return {
      id: sessionID,
      ...(spec?.parentID === undefined ? {} : { parentID: spec.parentID }),
      ...(spec?.agent === undefined ? {} : { agent: spec.agent }),
      location: { directory: spec?.directory ?? project },
    };
  };

  const session: Record<string, unknown> = {
    get: sessionGet,
    update: async () => undefined,
    context: async ({ sessionID }: { sessionID: string }) => childContext.get(sessionID) ?? [],
    prompt: async () => undefined,
    hook: async (name: string, cb: (event: never) => Promise<void>) => {
      if (name === "compaction" && options.omitCompaction === true) throw new Error("compaction hook unsupported");
      sessionHooks[name] = cb;
      return register();
    },
  };
  if (options.omitSynthetic !== true) {
    session.synthetic = async (input: SyntheticCall) => {
      synthetic.push(input);
    };
  }

  const ctx = {
    location: { directory: project, project: { directory: project } },
    agent: { reload: async () => undefined, list: async () => ({ data: [] }), transform: noop },
    command: { reload: async () => undefined, transform: noop },
    tool: {
      transform: noop,
      hook: async (name: string, cb: (event: never) => Promise<void>) => {
        toolHooks[name] = cb;
        return register();
      },
    },
    session,
    permission: { hook: noop },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        signal.addEventListener("abort", () => wake(), { once: true });
        while (!signal.aborted) {
          if (queue.length > 0) yield queue.shift();
          else {
            waiting = true;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            waiting = false;
          }
        }
      },
    },
  };

  if (options.journalText !== undefined) {
    mkdirSync(outcomes, { recursive: true });
    writeFileSync(join(outcomes, "pending.jsonl"), options.journalText, "utf-8");
  }

  const hooks = await ModelRouterPlugin({
    directory: project,
    worktree: project,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    ...(options.routerHost === "v1" ? {} : { routerHost: "v2" }),
    client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
  } as unknown as Parameters<typeof ModelRouterPlugin>[0]);

  const cleanup = await registerV2Hooks(ctx as unknown as Context, hooks);

  const turns = async (n = 40): Promise<void> => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };
  const hook = (table: Record<string, (event: never) => Promise<void>>, name: string): AnyHook => {
    const found = table[name];
    if (found === undefined) throw new Error(`the adapter registered no ${name} hook`);
    return found;
  };

  return {
    home,
    project,
    sessions,
    childContext,
    synthetic,
    sessionHooks,
    toolHooks,
    hooks,
    emit(event) {
      queue.push(event);
      wake();
    },
    async drain() {
      for (let i = 0; i < 200 && (queue.length > 0 || !waiting); i += 1) await turns(5);
      await turns();
    },
    async before(event) {
      await hook(toolHooks, "execute.before")(event as never);
      return event;
    },
    async after(event) {
      await hook(toolHooks, "execute.after")(event as never);
      return event;
    },
    async context(event) {
      await hook(sessionHooks, "context")(event as never);
    },
    async dispose() {
      await cleanup();
      invalidateConfigCache();
      await removeDirWhenReleased(home);
    },
  };
}

/** `vi.fn`-free helper kept for symmetry with other harnesses. */
export const noopFn = vi.fn();
