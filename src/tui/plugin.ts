/**
 * #90 P1.3: the OpenCode v2 TUI entry (root `tui.ts` re-exports it), plan §2 D2–D7 as amended by §8 A1–A9.
 *
 * - G1 (`footer`): `prompt.footer.status` gets `effort <value>` in a root session (or the home prompt) when no variant
 *   is selected ({@link effectiveMainEffort}); nothing when one is (the host row shows it).
 * - G2 (`childView`): `session.composer.top` of a delegated session gets `<agent> · <model> · <effort>`
 *   ({@link childStatus}).
 * - G3 (`runningRow`): `session.composer.top` of a root session gets one such row per running delegate
 *   ({@link runningChildren}), then `+<k> more`.
 *
 * One claim serves G2 and G3: they target the same slot and a session is either a child or a root, so one box (empty
 * when there is nothing to show) is enough. The effort comes from the server's `effortOf` rpc (A1, per-session pollers
 * created while a view needs them), else from the message/session variant.
 *
 * No JSX: views are built with the `@opentui/solid` reconciler primitives and `solid-js`, the only runtime imports
 * besides `./status-model` and `./effort-rpc` (both import-free). Every host member is feature-detected; `setup` never
 * throws and never calls rpc; a view never throws (errors render no rows and are logged once per area with
 * `console.warn`, the context has no logging API).
 */
import { createMemo, createRenderEffect, createRoot, createSignal, onCleanup, untrack } from "solid-js";
import { createElement, insert, setProp } from "@opentui/solid";
import { effortRpc } from "./effort-rpc";
import type {
  ComposerTopInput,
  HostClient,
  HostContext,
  HostCurrentModel,
  HostMessage,
  HostModelInfo,
  HostResizeListener,
  HostSession,
  HostSlotClaim,
  PromptFooterInput,
} from "./host-types";
import {
  childStatus,
  DEFAULT_EFFORT,
  effectiveMainEffort,
  formatRow,
  parseOptions,
  runningChildren,
  STATUS_NOTICE_PREFIX,
  type AppliedEffort,
  type CurrentModel,
  type SessionStatus,
  type StatusOptions,
} from "./status-model";

/** The TUI plugin id (A4): deliberately not the package name. */
export const STATUS_PLUGIN_ID = "opencode-model-router.status";
export const FOOTER_SLOT = "prompt.footer.status";
export const COMPOSER_SLOT = "session.composer.top";
/** Poll interval while a session runs, and the debounce of trigger-driven pulls (A1). */
export const POLL_INTERVAL_MS = 5_000;
/** How long a session's channel stays off after an error other than `unavailable`. */
export const FAILURE_COOLDOWN_MS = 30_000;
/** First retry delay after an `unavailable` error; doubled per retry up to {@link BACKOFF_MAX_MS}. */
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Terminal width used when the renderer reports none. */
export const DEFAULT_WIDTH = 80;
/** Columns kept free around a row (composer padding). */
export const WIDTH_MARGIN = 4;

type Warn = (area: string, error: unknown) => void;
type Timer = ReturnType<typeof setTimeout>;
type Rows = readonly string[];

const NO_ROWS: Rows = Object.freeze([]);
const NO_MESSAGES: readonly HostMessage[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** `value` when it is a string with a non-blank character, as is (untrimmed). */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function arrayOf<T>(value: readonly T[] | null | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function sameRows(a: Rows, b: Rows): boolean {
  return a.length === b.length && a.every((row, index) => row === b[index]);
}

function sameApplied(a: AppliedEffort | undefined, b: AppliedEffort | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.effort === b.effort && a.variant === b.variant && a.providerID === b.providerID && a.modelID === b.modelID;
}

function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return error.message || error.name;
    return String(error);
  } catch {
    return "unknown error";
  }
}

/** One `console.warn` per area for the lifetime of a `setup`. */
function createWarn(): Warn {
  const seen = new Set<string>();
  return (area, error) => {
    if (seen.has(area)) return;
    seen.add(area);
    try {
      console.warn(`${STATUS_NOTICE_PREFIX}${area} failed: ${describeError(error)}`);
    } catch {
      // No console: nothing else to report to.
    }
  };
}

/**
 * The channel's `effortOf` output as an {@link AppliedEffort}: only when it carries a non-blank `effort`, `providerID`
 * and `modelID` (strings kept as sent); `variant` when it is a non-blank string.
 */
export function appliedOf(output: unknown): AppliedEffort | undefined {
  if (!isObject(output)) return undefined;
  const effort = nonBlank(Reflect.get(output, "effort"));
  const providerID = nonBlank(Reflect.get(output, "providerID"));
  const modelID = nonBlank(Reflect.get(output, "modelID"));
  if (effort === undefined || providerID === undefined || modelID === undefined) return undefined;
  const variant = nonBlank(Reflect.get(output, "variant"));
  return variant === undefined ? { effort, providerID, modelID } : { effort, variant, providerID, modelID };
}

/**
 * QA-6 (P1.2 hand-off): the channel's effort, followed by the recorded variant in parentheses when both are set and
 * differ (`high (max)`). A blank or `default` effort or variant, or an equal one (case-insensitive), leaves the effort
 * as is.
 */
export function effortWithVariant(effort: string, variant?: string): string {
  const shown = effort.trim();
  const recorded = typeof variant === "string" ? variant.trim() : "";
  if (shown === "" || shown === DEFAULT_EFFORT || recorded === "" || recorded === DEFAULT_EFFORT) return effort;
  return shown.toLowerCase() === recorded.toLowerCase() ? effort : `${shown} (${recorded})`;
}

/** The applied effort as the child views show it (QA-6). */
function childApplied(applied: AppliedEffort | undefined): AppliedEffort | undefined {
  return applied === undefined ? undefined : { ...applied, effort: effortWithVariant(applied.effort, applied.variant) };
}

/** An error the host reports while the server plugin's rpc is not (yet) registered (`rpc.unavailable`). */
export function isUnavailable(error: unknown): boolean {
  try {
    const parts: unknown[] = [error];
    if (isObject(error)) {
      for (const key of ["name", "message", "_tag", "code"]) parts.push(Reflect.get(error, key));
    }
    return parts.some((part) => typeof part === "string" && part.toLowerCase().includes("unavailable"));
  } catch {
    return false;
  }
}

/** Reads of the host context. Missing members give empty answers; a throwing host member throws to the view. */
interface Host {
  session(id: string): HostSession | undefined;
  isChild(id: string): boolean;
  messages(id: string): readonly HostMessage[];
  family(id: string): readonly string[];
  status(id: string): SessionStatus;
  models(): readonly HostModelInfo[];
  current(): HostCurrentModel | undefined;
  muted(): unknown;
}

function createHost(context: HostContext | undefined): Host {
  const sessions = () => context?.data?.session;
  const session = (id: string): HostSession | undefined => {
    const value = sessions()?.get?.(id);
    return typeof value === "object" && value !== null ? value : undefined;
  };
  return {
    session,
    isChild: (id) => nonBlank(session(id)?.parentID) !== undefined,
    messages: (id) => {
      const list = sessions()?.message?.list?.(id);
      if (list === undefined || list === null) return NO_MESSAGES;
      return arrayOf(list).filter((message) => typeof message === "object" && message !== null);
    },
    family: (id) => {
      const ids = sessions()?.family?.(id);
      if (ids === undefined || ids === null) return NO_IDS;
      return arrayOf(ids).filter((item) => typeof item === "string");
    },
    status: (id) => (sessions()?.status?.(id) === "running" ? "running" : "idle"),
    models: () =>
      arrayOf(context?.data?.location?.model?.list?.()).filter(
        (model) =>
          typeof model === "object" &&
          model !== null &&
          typeof model.id === "string" &&
          typeof model.providerID === "string",
      ),
    current: () => {
      const value = context?.ui?.model?.current?.();
      return typeof value === "object" && value !== null ? value : undefined;
    },
    muted: () => context?.theme?.textMuted,
  };
}

/** The prompt's current model as `effectiveMainEffort` reads it; undefined unless both ids are strings. */
function currentModelOf(current: HostCurrentModel | undefined): CurrentModel | undefined {
  if (current === undefined || typeof current.providerID !== "string" || typeof current.modelID !== "string") {
    return undefined;
  }
  return { providerID: current.providerID, modelID: current.modelID };
}

interface EffortClient {
  effortOf(input: { readonly sessionID: string }): unknown;
}

function isEffortClient(value: unknown): value is EffortClient {
  return isObject(value) && typeof Reflect.get(value, "effortOf") === "function";
}

interface EffortChannel {
  /**
   * The applied effort the server reported for `sessionID` (reactive). Call it inside a tracked computation: it keeps
   * the session's poller alive until that computation re-runs or is disposed. Undefined without an rpc client.
   */
  applied(sessionID: string): AppliedEffort | undefined;
  dispose(): void;
}

interface ChannelDeps {
  client(): HostClient | undefined;
  status(id: string): SessionStatus;
  messages(id: string): readonly HostMessage[];
  warn: Warn;
}

interface Poller {
  readonly id: string;
  refs: number;
  closed: boolean;
  read(): AppliedEffort | undefined;
  write(value: AppliedEffort | undefined): void;
  timer: Timer | undefined;
  inFlight: boolean;
  /** A trigger fired while a pull was in flight. */
  dirty: boolean;
  lastPull: number;
  failedUntil: number;
  /** Current `unavailable` retry delay; 0 after a success. */
  backoff: number;
  disposeRoot(): void;
}

/** What makes a session's poller pull again: its status, message count and latest message id. */
function triggerKey(deps: ChannelDeps, id: string): string {
  let status = "idle";
  let count = 0;
  let last = "";
  try {
    status = deps.status(id);
  } catch {
    // An unreadable status counts as idle.
  }
  try {
    const list = deps.messages(id);
    count = list.length;
    const tail = count > 0 ? list[count - 1] : undefined;
    last = typeof tail?.id === "string" ? tail.id : "";
  } catch {
    // An unreadable list counts as empty.
  }
  return `${status}\u0000${count}\u0000${last}`;
}

/**
 * A1: per-session pull of `effortOf`. A poller exists while a view needs its session (released pollers close on the
 * next microtask unless re-acquired). It pulls right away (on a timer, never synchronously), again when the trigger key
 * changes (debounced to {@link POLL_INTERVAL_MS} since the last pull), and every {@link POLL_INTERVAL_MS} while the
 * session runs. `unavailable` errors retry with backoff 1 s, 2 s, 4 s … {@link BACKOFF_MAX_MS}; any other error drops
 * the value (views fall back to the message variant) for {@link FAILURE_COOLDOWN_MS}.
 */
function createEffortChannel(deps: ChannelDeps): EffortChannel {
  const pollers = new Map<string, Poller>();
  let closed = false;
  let client: EffortClient | undefined;

  const hasRpc = (): boolean => {
    try {
      return typeof deps.client()?.rpc === "function";
    } catch {
      return false;
    }
  };

  const resolveClient = (): EffortClient | undefined => {
    if (client !== undefined) return client;
    const host = deps.client();
    if (host === undefined || host === null || typeof host.rpc !== "function") return undefined;
    const value = host.rpc(effortRpc);
    if (!isEffortClient(value)) throw new Error("the rpc client has no effortOf method");
    client = value;
    return client;
  };

  const isRunning = (id: string): boolean => {
    try {
      return untrack(() => deps.status(id)) === "running";
    } catch {
      return false;
    }
  };

  const schedule = (poller: Poller, delay: number): void => {
    poller.timer = setTimeout(() => {
      void pull(poller);
    }, delay);
  };

  const request = (poller: Poller): void => {
    if (poller.closed) return;
    if (poller.inFlight) {
      poller.dirty = true;
      return;
    }
    if (poller.timer !== undefined) return;
    const now = Date.now();
    schedule(poller, Math.max(0, poller.lastPull + POLL_INTERVAL_MS - now, poller.failedUntil - now));
  };

  const pull = async (poller: Poller): Promise<void> => {
    poller.timer = undefined;
    if (poller.closed) return;
    poller.inFlight = true;
    poller.dirty = false;
    poller.lastPull = Date.now();
    let result: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      const effort = resolveClient();
      if (effort === undefined) {
        poller.inFlight = false;
        return;
      }
      result = { ok: true, value: await effort.effortOf({ sessionID: poller.id }) };
    } catch (error) {
      result = { ok: false, error };
    }
    poller.inFlight = false;
    if (poller.closed) return;
    if (result.ok) {
      poller.backoff = 0;
      poller.write(appliedOf(result.value));
    } else if (isUnavailable(result.error)) {
      poller.backoff = poller.backoff === 0 ? BACKOFF_START_MS : Math.min(poller.backoff * 2, BACKOFF_MAX_MS);
      schedule(poller, poller.backoff);
      return;
    } else {
      deps.warn("effort channel", result.error);
      poller.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      poller.write(undefined);
    }
    if (poller.dirty || isRunning(poller.id)) request(poller);
  };

  const close = (poller: Poller): void => {
    if (poller.closed) return;
    poller.closed = true;
    if (poller.timer !== undefined) clearTimeout(poller.timer);
    poller.timer = undefined;
    try {
      poller.disposeRoot();
    } catch (error) {
      deps.warn("effort channel", error);
    }
    if (pollers.get(poller.id) === poller) pollers.delete(poller.id);
  };

  const open = (id: string): Poller => {
    const [read, write] = createSignal<AppliedEffort | undefined>(undefined, { equals: sameApplied });
    const poller: Poller = {
      id,
      refs: 0,
      closed: false,
      read,
      write: (value) => {
        write(value);
      },
      timer: undefined,
      inFlight: false,
      dirty: false,
      lastPull: Number.NEGATIVE_INFINITY,
      failedUntil: Number.NEGATIVE_INFINITY,
      backoff: 0,
      disposeRoot: () => undefined,
    };
    poller.disposeRoot = createRoot((dispose) => {
      createRenderEffect((previous: string | undefined) => {
        const key = triggerKey(deps, id);
        if (key !== previous) untrack(() => request(poller));
        return key;
      }, undefined);
      return dispose;
    });
    return poller;
  };

  const release = (poller: Poller): void => {
    poller.refs -= 1;
    if (poller.refs > 0 || poller.closed) return;
    queueMicrotask(() => {
      if (poller.refs <= 0) close(poller);
    });
  };

  return {
    applied(sessionID) {
      if (closed || !hasRpc()) return undefined;
      let poller = pollers.get(sessionID);
      if (poller === undefined) {
        poller = open(sessionID);
        pollers.set(sessionID, poller);
      }
      const held = poller;
      held.refs += 1;
      onCleanup(() => release(held));
      return held.read();
    },
    dispose() {
      closed = true;
      for (const poller of [...pollers.values()]) close(poller);
      pollers.clear();
    },
  };
}

interface Views {
  readonly options: StatusOptions;
  readonly host: Host;
  readonly channel: EffortChannel;
  readonly warn: Warn;
  columns(): number;
  requestSync(id: string): void;
}

/** G1: `effort <value>` in a root session or the home prompt, nothing when a variant is selected. */
function footerRows(input: PromptFooterInput | undefined, views: Views): Rows {
  const id = nonBlank(input?.sessionID);
  if (id !== undefined && views.host.isChild(id)) return NO_ROWS;
  const current = views.host.current();
  const selectedVariant = typeof current?.variant === "string" ? current.variant : undefined;
  if (effectiveMainEffort({ selectedVariant }) === undefined) return NO_ROWS;
  const model = currentModelOf(current);
  const applied = id === undefined || model === undefined ? undefined : views.channel.applied(id);
  const value = effectiveMainEffort({ selectedVariant, applied, current: model });
  return value === undefined ? NO_ROWS : [formatRow([`effort ${value}`], views.columns())];
}

/** G2 in a child session, G3 in a root session; nothing until the session is known. */
function composerRows(input: ComposerTopInput | undefined, views: Views): Rows {
  const id = nonBlank(input?.sessionID);
  if (id === undefined) return NO_ROWS;
  const { host, channel, options } = views;
  const session = host.session(id);
  if (session === undefined) return NO_ROWS;
  const messages = (child: string): readonly HostMessage[] => {
    const list = host.messages(child);
    if (list.length === 0) views.requestSync(child);
    return list;
  };
  const width = views.columns();
  if (nonBlank(session.parentID) !== undefined) {
    if (!options.childView) return NO_ROWS;
    const status = childStatus({
      session,
      messages: messages(id),
      models: host.models(),
      applied: childApplied(channel.applied(id)),
    });
    return status === undefined ? NO_ROWS : [formatRow([status.agent ?? "", status.model, status.effort], width)];
  }
  if (!options.runningRow) return NO_ROWS;
  const running = runningChildren({
    rootID: id,
    family: host.family(id),
    status: host.status,
    sessions: host.session,
    messages,
    models: host.models(),
    applied: (child) => childApplied(channel.applied(child)),
    max: options.maxRows,
  });
  const rows = running.rows.map((row) => formatRow([row.agent, row.model, row.effort], width));
  if (running.overflow > 0) rows.push(formatRow([`+${running.overflow} more`], width));
  return rows;
}

/** One `text` row, in its own root so it is disposed when the row goes away. */
function rowNode(rows: () => Rows, index: number, views: Views): { node: unknown; dispose: () => void } {
  return createRoot((dispose) => {
    const node = createElement("text");
    createRenderEffect((previous: unknown) => {
      let fg: unknown;
      try {
        fg = views.host.muted();
      } catch {
        fg = undefined;
      }
      return fg === undefined || fg === previous ? previous : setProp(node, "fg", fg, previous);
    }, undefined);
    insert(node, () => rows()[index] ?? "");
    return { node, dispose };
  });
}

/**
 * A column `box` with one `text` per row of `compute` (re-run reactively). The box always exists (a slot render must
 * return an element); with no rows it has no children and no size of its own, so it takes no height. Rows are created
 * and disposed as the count changes, never reused (a removed host node may be destroyed). A throwing `compute` gives
 * no rows and one warning for `area`.
 */
function rowsView(compute: () => Rows, area: string, views: Views): unknown {
  try {
    const rows = createMemo<Rows>(
      () => {
        try {
          return compute();
        } catch (error) {
          views.warn(area, error);
          return NO_ROWS;
        }
      },
      NO_ROWS,
      { equals: sameRows },
    );
    const count = createMemo(() => rows().length);
    const made: Array<{ node: unknown; dispose: () => void }> = [];
    const box = createElement("box");
    setProp(box, "flexDirection", "column");
    const children = createMemo(() => {
      const wanted = count();
      untrack(() => {
        while (made.length > wanted) made.pop()?.dispose();
        while (made.length < wanted) {
          try {
            made.push(rowNode(rows, made.length, views));
          } catch (error) {
            views.warn(area, error);
            break;
          }
        }
      });
      return made.map((row) => row.node);
    });
    onCleanup(() => {
      for (const row of made.splice(0)) row.dispose();
    });
    insert(box, children);
    return box;
  } catch (error) {
    views.warn(area, error);
    return undefined;
  }
}

/** The renderer's width in columns (re-read on its `resize` event when it emits one). */
function createWidth(context: HostContext | undefined, warn: Warn): { width: () => number; dispose: () => void } {
  const read = (): number => {
    try {
      const width = context?.renderer?.width;
      return typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  };
  const [width, setWidth] = createSignal(read());
  let dispose = (): void => undefined;
  try {
    const renderer = context?.renderer;
    if (renderer !== undefined && renderer !== null && typeof renderer.on === "function") {
      const listener: HostResizeListener = () => {
        setWidth(read());
      };
      renderer.on("resize", listener);
      dispose = () => {
        if (typeof renderer.off === "function") renderer.off("resize", listener);
      };
    }
  } catch (error) {
    warn("renderer", error);
  }
  return { width, dispose: () => dispose() };
}

function isDispose(value: unknown): value is () => void {
  return typeof value === "function";
}

function register(context: HostContext | undefined, claim: HostSlotClaim, cleanups: Array<() => void>, warn: Warn): void {
  try {
    const ui = context?.ui;
    if (ui === undefined || ui === null || typeof ui.slot !== "function") return;
    const dispose = ui.slot(claim);
    if (isDispose(dispose)) cleanups.push(() => dispose());
  } catch (error) {
    warn(`slot ${claim.append}`, error);
  }
}

/**
 * The TUI `setup`: options (one toast for invalid ones), then the slot claims. Returns the cleanup that disposes the
 * claims, the pollers and their timers, and the resize listener. Never throws; makes no rpc call.
 */
function setup(context: HostContext | undefined): () => void {
  const warn = createWarn();
  const cleanups: Array<() => void> = [];
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    for (const dispose of cleanups.splice(0).reverse()) {
      try {
        dispose();
      } catch (error) {
        warn("cleanup", error);
      }
    }
  };
  try {
    const { options, notices } = parseOptions(context?.options);
    if (notices.length > 0) {
      try {
        context?.ui?.toast?.show?.({ message: notices[0], variant: "warning" });
      } catch (error) {
        warn("notice", error);
      }
    }
    if (!options.enabled || !(options.footer || options.childView || options.runningRow)) return cleanup;

    const host = createHost(context);
    const channel = createEffortChannel({
      client: () => context?.client,
      status: host.status,
      messages: host.messages,
      warn,
    });
    cleanups.push(() => channel.dispose());
    const width = createWidth(context, warn);
    cleanups.push(width.dispose);
    const synced = new Set<string>();
    const views: Views = {
      options,
      host,
      channel,
      warn,
      columns: () => Math.max(0, width.width() - WIDTH_MARGIN),
      requestSync: (id) => {
        if (synced.has(id)) return;
        synced.add(id);
        queueMicrotask(() => {
          if (closed) return;
          try {
            const message = context?.data?.session?.message;
            if (typeof message?.sync !== "function") return;
            Promise.resolve(message.sync(id)).catch(() => undefined);
          } catch {
            // A failed sync leaves the list empty; the session's model is shown meanwhile.
          }
        });
      },
    };

    if (options.footer) {
      register(
        context,
        { append: FOOTER_SLOT, render: (input) => rowsView(() => footerRows(input, views), "footer view", views) },
        cleanups,
        warn,
      );
    }
    if (options.childView || options.runningRow) {
      register(
        context,
        { append: COMPOSER_SLOT, render: (input) => rowsView(() => composerRows(input, views), "composer view", views) },
        cleanups,
        warn,
      );
    }
  } catch (error) {
    warn("setup", error);
  }
  return cleanup;
}

/** A plain `{ id, setup }` (what `Plugin.define` returns); no `@opencode/plugin` import at runtime. */
export interface StatusPluginDefinition {
  readonly id: string;
  readonly setup: (context: HostContext | undefined) => () => void;
}

const plugin: StatusPluginDefinition = { id: STATUS_PLUGIN_ID, setup };

export default plugin;
