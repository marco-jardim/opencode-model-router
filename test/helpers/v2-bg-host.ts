/**
 * test/helpers/v2-bg-host.ts
 *
 * Phase 2.1 (task 2.1.8): a fake Claude Code v2 host for the background / lease integration tests. It drives the REAL plugin
 * (`src/index.ts`, `routerHost: "v2"`) behind the REAL adapter (`registerV2Hooks`). The host owns:
 *  - the tool hooks (`execute.before` / `execute.after`) and session hooks (`context`, `prompt`, `compaction`) the adapter registers;
 *  - an event queue the adapter's event loop consumes (`emit`), with a `drain` that waits until the loop took everything;
 *  - a session table (parent, directory), sessions whose `session.get` fails, and `session.context` results per child;
 *  - every `session.synthetic` call, recorded.
 * Nothing sleeps: waits are microtask turns or an explicit fake clock of the test.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import type { Context } from "@opencode/plugin/promise/plugin";
import type { Hooks } from "@opencode-ai/plugin";
import { ROUTER_FINISH_ATTACH, type HeldResults } from "../../src/compat/background";
import { registerV2Hooks, V2_BACKGROUND_SETTLED } from "../../src/compat/v2-hooks";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath } from "../../src/router/config";
import { createPendingFileJournal, resolvePendingJournalDir, type PendingRecord } from "../../src/verify/pending";
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
  /** How the fake host delivered the entry: a steer to a busy parent, a wake to an idle one. */
  delivery?: "steer" | "wake";
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
  /** QA-2.1-8: the pending journal of this host (the durable per-user state dir inside `home`). */
  journalPath: string;
  sessions: Map<string, SessionSpec>;
  /** QA-2.1-25: sessions whose `session.get` lookup throws (a transient host failure) while they are in the set. */
  failingSessionLookups: Set<string>;
  /** `session.context(child)` answers; `undefined` = an empty context. */
  childContext: Map<string, unknown[]>;
  synthetic: SyntheticCall[];
  /** Count of `resume: true` entries delivered as a steer / as a wake. */
  deliveries: { steer: number; wake: number };
  /** Marks a session as mid-turn (busy) or idle for the delivery of `synthetic` entries. */
  setBusy(sessionID: string, busy: boolean): void;
  /** The held store the plugin's gate posts verdicts through (the sink the adapter attached). */
  heldSink: HeldResults;
  sessionHooks: Record<string, (event: never) => Promise<void>>;
  toolHooks: Record<string, (event: never) => Promise<void>>;
  hooks: Hooks;
  /** Queue a host event for the adapter's event loop. */
  emit(event: unknown): void;
  /** Resolves when the event loop consumed everything queued and settled its async work (bounded microtask turns). */
  drain(): Promise<void>;
  /**
   * `drain`, then waits for the adapter's background work in flight (verdict posts, recoveries, reloads; `V2_BACKGROUND_SETTLED`)
   * until none is left: what an adoption or a gate started, including its file writes, has finished. No timers.
   */
  settled(): Promise<void>;
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
  /** A previous process's pending.jsonl (JSON lines), written to `journalPath` by the real journal writer before boot. */
  journalText?: string;
  /** Re-use a home from an earlier boot (a restart). */
  home?: string;
  routerHost?: "v2" | "v1";
}

const saved = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ENFORCE: process.env.MODEL_ROUTER_ENFORCE, XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

export function restoreEnv(): void {
  for (const [key, value] of [
    ["HOME", saved.HOME], ["USERPROFILE", saved.USERPROFILE], ["MODEL_ROUTER_ENFORCE", saved.ENFORCE], ["XDG_STATE_HOME", saved.XDG_STATE_HOME],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  invalidateConfigCache();
}

export async function bootBgHost(options: BootOptions = {}): Promise<BgHost> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "omr-v2-bg-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // QA-2.1-8: the per-user pending journal dir (`resolvePendingJournalDir`) must resolve inside the test home on every platform
  // (a CI runner's own XDG_STATE_HOME would otherwise share one journal across tests). `restoreEnv` puts the old value back.
  process.env.XDG_STATE_HOME = join(home, ".local", "state");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  mkdirSync(dirname(overridePath()), { recursive: true });
  // QA-2.1-8: pending.jsonl lives in the durable per-user state dir (`resolvePendingJournalDir`), here inside the test's home (a
  // restart re-uses `options.home`). QA-2.1-26: the outcome store has its own dir, separate from the journal's, so a plugin that
  // fell back to a journal next to the outcome store would miss `journalPath` and the tests would see it.
  const journalDir = resolvePendingJournalDir({ homedir: home, platform: process.platform, xdgStateHome: process.env.XDG_STATE_HOME });
  const outcomes = join(home, "outcomes");
  const journalPath = join(journalDir, "pending.jsonl");
  const given = (options.overrides ?? {}) as { routing?: Record<string, unknown> };
  writeFileSync(overridePath(), JSON.stringify({ ...given, routing: { ...(given.routing ?? {}), outcomes: { path: outcomes } } }), "utf-8");
  invalidateConfigCache();

  const sessions = new Map<string, SessionSpec>(Object.entries(options.sessions ?? {}));
  const childContext = new Map<string, unknown[]>();
  const synthetic: SyntheticCall[] = [];
  const busy = new Set<string>();
  const deliveries = { steer: 0, wake: 0 };
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

  const failingSessionLookups = new Set<string>();
  const sessionGet = async ({ sessionID }: { sessionID: string }) => {
    if (failingSessionLookups.has(sessionID)) throw new Error(`session ${sessionID} lookup failed (fake host)`);
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
    // A host delivers a `resume: true` entry as a steer to a parent that is mid-turn and as one wake to an idle parent.
    session.synthetic = async (input: SyntheticCall) => {
      const delivery = busy.has(input.sessionID) ? "steer" : "wake";
      if (input.resume === true) deliveries[delivery] += 1;
      synthetic.push({ ...input, delivery });
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
    // The previous process's journal, written by the real journal writer: it creates its directory itself (no mkdirSync
    // workaround) and every record has reached the file before the plugin boots. `journalText` is JSON lines.
    const previous = createPendingFileJournal(journalPath, { compactAtStart: false });
    for (const line of options.journalText.split("\n")) {
      if (line.trim() === "") continue;
      await previous.append(JSON.parse(line) as PendingRecord, { fsync: true });
    }
    await previous.flush();
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

  // The sink the adapter hands the plugin's finish API: the gate's verdicts reach the held store through it.
  const attachFinish: unknown = Reflect.get(hooks, ROUTER_FINISH_ATTACH);
  let captured: HeldResults | undefined;
  // The attach slot is read-only on the plugin's hooks object, so the adapter gets a copy whose slot records the sink.
  const descriptors = Object.getOwnPropertyDescriptors(hooks);
  Reflect.deleteProperty(descriptors, ROUTER_FINISH_ATTACH);
  const seen: Hooks = Object.create(Object.getPrototypeOf(hooks), descriptors);
  if (typeof attachFinish === "function") {
    Object.defineProperty(seen, ROUTER_FINISH_ATTACH, {
      value: (input: { held: HeldResults }): unknown => {
        captured = input.held;
        return Reflect.apply(attachFinish, hooks, [input]);
      },
    });
  }

  const cleanup = await registerV2Hooks(ctx as unknown as Context, seen);

  const turns = async (n = 40): Promise<void> => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };
  const hook = (table: Record<string, (event: never) => Promise<void>>, name: string): AnyHook => {
    const found = table[name];
    if (found === undefined) throw new Error(`the adapter registered no ${name} hook`);
    return found;
  };
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 200 && (queue.length > 0 || !waiting); i += 1) await turns(5);
    await turns();
  };
  const settleBackground: unknown = Reflect.get(cleanup, V2_BACKGROUND_SETTLED);
  if (typeof settleBackground !== "function") throw new Error("the adapter exposes no V2_BACKGROUND_SETTLED");
  const settled = async (): Promise<void> => {
    await drain();
    await (settleBackground as () => Promise<void>)();
    // What the settled work handed back to the event loop (a queued event, a post's continuation) is drained too.
    await drain();
  };
  let disposed = false;

  return {
    home,
    project,
    journalPath,
    sessions,
    failingSessionLookups,
    childContext,
    synthetic,
    deliveries,
    setBusy(sessionID, isBusy) {
      if (isBusy) busy.add(sessionID);
      else busy.delete(sessionID);
    },
    get heldSink(): HeldResults {
      if (captured === undefined) throw new Error("the plugin did not attach the finish API");
      return captured;
    },
    sessionHooks,
    toolHooks,
    hooks,
    emit(event) {
      queue.push(event);
      wake();
    },
    drain,
    settled,
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
      if (disposed) return;
      disposed = true;
      // QA-2.1-8: the queued events and the work they started settle first; the adapter's cleanup then waits (bounded) for its
      // background work in flight (verdict posts, recoveries); only then is the home (and the journal in it) removed.
      await drain();
      await cleanup();
      invalidateConfigCache();
      await removeDirWhenReleased(home);
    },
  };
}

/** `vi.fn`-free helper kept for symmetry with other harnesses. */
export const noopFn = vi.fn();
