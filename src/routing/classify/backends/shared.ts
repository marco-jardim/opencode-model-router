/**
 * Helpers shared by the three model backends (design section 4, "Shared").
 *
 * Everything here is pure except `raceTimeout` / `gatherSamples` (timers) and
 * the logging helpers. Randomness is always injected.
 */

import { scrubState } from "../scrub";
import {
  BACKEND_PROMPT,
  CONFIDENCE,
  RAW_ANSWER_MAX_CHARS,
  type BackendId,
  type BackendResult,
  type BackendStatus,
  type ChoiceOption,
  type ClassifierLogger,
  type ClassifierState,
  type Risk,
  type Scope,
  type TaskClass,
} from "../types";

// ---------------------------------------------------------------------------
// Model reference
// ---------------------------------------------------------------------------

export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string;
}

/** `provider/model[#variant]` → parts, or null. The model id may itself contain `:` and `.`. */
export function parseModelRef(ref: string): ModelRef | null {
  if (typeof ref !== "string") return null;
  let rest = ref.trim();
  let variant: string | undefined;
  const hash = rest.lastIndexOf("#");
  if (hash > 0) {
    const v = rest.slice(hash + 1).trim();
    if (v !== "") variant = v;
    rest = rest.slice(0, hash);
  }
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const providerID = rest.slice(0, slash).trim();
  const id = rest.slice(slash + 1).trim();
  if (providerID === "" || id === "") return null;
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** Fisher–Yates on a copy; `random` is a uniform [0, 1) source. */
export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const r = random();
    const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** 8 lowercase hex chars; marks one call's delimiters so the task text cannot forge them. */
export function makeNonce(random: () => number): string {
  const r = random();
  const n = Math.min(2 ** 32 - 1, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * 2 ** 32)));
  return n.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

export interface RenderedPrompt<L extends string = string> {
  readonly system: string;
  readonly user: string;
  /** `system` + blank line + `user`, for APIs that take one prompt string. */
  readonly prompt: string;
  /** The option labels in the shuffled order of this request. */
  readonly labels: L[];
}

export interface RenderedBatch<L extends string = string> extends RenderedPrompt<L> {
  readonly nonce: string;
  /** The delimited item blocks alone (what TypeSafe sends as `state`). */
  readonly blocks: string;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

function optionLines(options: readonly ChoiceOption[]): string {
  return options.map((o) => `- ${o.label}: ${o.description}`).join("\n");
}

/** Consumes `random` for the shuffle first, then for the nonce. */
export function renderSinglePrompt<L extends string>(
  state: ClassifierState,
  choices: readonly ChoiceOption<L>[],
  random: () => number,
): RenderedPrompt<L> {
  const ordered = shuffle(choices, random);
  const nonce = makeNonce(random);
  const labels = ordered.map((o) => o.label);
  const system = fill(BACKEND_PROMPT.single, { nonce, options: optionLines(ordered) });
  const user =
    "<<<TASK " +
    nonce +
    "\n" +
    state.text +
    "\nTASK " +
    nonce +
    ">>>\n\n" +
    fill(BACKEND_PROMPT.singleFinal, { labels: labels.join(", ") });
  return { system, user, prompt: system + "\n\n" + user, labels };
}

export function renderBatchPrompt<L extends string>(
  states: readonly ClassifierState[],
  choices: readonly ChoiceOption<L>[],
  random: () => number,
): RenderedBatch<L> {
  const ordered = shuffle(choices, random);
  const nonce = makeNonce(random);
  const labels = ordered.map((o) => o.label);
  const count = String(states.length);
  const system = fill(BACKEND_PROMPT.batch, { count, nonce, options: optionLines(ordered) });
  const blocks = states
    .map((s, i) => {
      const n = String(i + 1);
      return "<<<ITEM " + n + " " + nonce + "\n" + s.text + "\nITEM " + n + " " + nonce + ">>>";
    })
    .join("\n\n");
  const user = blocks + "\n\n" + fill(BACKEND_PROMPT.batchFinal, { count, labels: labels.join(", ") });
  return { system, user, prompt: system + "\n\n" + user, labels, nonce, blocks };
}

// ---------------------------------------------------------------------------
// Answer parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /^```(?:[a-zA-Z0-9_-]*[ \t]*\r?\n)?([\s\S]*?)\r?\n?```$/;

function stripFence(text: string): string {
  const t = text.trim();
  const m = FENCE_RE.exec(t);
  return m ? (m[1] ?? "").trim() : t;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * One label from an answer, or null. Exact match only after trimming quotes,
 * emphasis and trailing punctuation: "implement because…" is invalid.
 */
export function parseLabel<L extends string>(raw: string, labels: readonly L[]): L | null {
  if (typeof raw !== "string") return null;
  let text = stripFence(raw);
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const record = asRecord(parsed);
    if (record === null) return null;
    const field = ["label", "class", "category"]
      .map((key) => record[key])
      .find((v): v is string => typeof v === "string");
    if (field === undefined) return null;
    text = field;
  }
  const cleaned = text.toLowerCase().replace(/^[\s"'`*]+/, "").replace(/[\s"'`*.!]+$/, "");
  return labels.find((l) => l === cleaned) ?? null;
}

const BATCH_LINE_RE = /^\s*(?:item\s*)?(\d+)\s*[:.)-]\s*(.+?)\s*$/i;

/** One entry per item, in item order; unparsable or missing items are null. */
export function parseBatchLabels<L extends string>(
  raw: string,
  count: number,
  labels: readonly L[],
): Array<L | null> {
  const out: Array<L | null> = Array.from({ length: count }, () => null);
  if (typeof raw !== "string") return out;
  const text = stripFence(raw);
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const list = asRecord(parsed)?.labels;
    if (Array.isArray(list)) {
      for (let i = 0; i < count; i++) {
        const item: unknown = list[i];
        out[i] = typeof item === "string" ? parseLabel(item, labels) : null;
      }
      return out;
    }
  }
  const seen = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const m = BATCH_LINE_RE.exec(line);
    if (m === null) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count || seen.has(n)) continue;
    seen.add(n);
    out[n - 1] = parseLabel(m[2] ?? "", labels);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

export type VoteResult =
  | { readonly status: "ok"; readonly label: TaskClass; readonly confidence: number }
  | { readonly status: "disagree"; readonly confidence: 0 }
  | { readonly status: "invalid" };

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** `samples = 1`: the label or invalid. `samples = 3`: a label with at least 2 votes wins. */
export function vote(labels: readonly (TaskClass | null)[], samples: 1 | 3): VoteResult {
  if (samples === 1) {
    const label = labels[0] ?? null;
    return label === null
      ? { status: "invalid" }
      : { status: "ok", label, confidence: CONFIDENCE.backendSingleSample };
  }
  const counts = new Map<TaskClass, number>();
  let valid = 0;
  for (const label of labels) {
    if (label === null) continue;
    valid++;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let winner: TaskClass | null = null;
  let best = 0;
  for (const [label, n] of counts) {
    if (n > best) {
      best = n;
      winner = label;
    }
  }
  if (winner !== null && best >= 2) {
    return { status: "ok", label: winner, confidence: round2(best / 3) };
  }
  return valid >= 2 ? { status: "disagree", confidence: 0 } : { status: "invalid" };
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export type Settled<T> =
  | { readonly kind: "value"; readonly v: T }
  | { readonly kind: "error"; readonly e: unknown }
  | { readonly kind: "timeout" };

/**
 * Race `promise` against a timer. Never rejects: the promise is observed through
 * `then(onValue, onError)`, so an abandoned call that rejects later cannot raise
 * an unhandled rejection. The timer is cleared on settle and unref'd when the
 * runtime supports it (a pending classification must not keep the process alive).
 */
export function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<Settled<T>> {
  return new Promise<Settled<T>>((resolve) => {
    const delay = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    const timer = setTimeout(() => resolve({ kind: "timeout" }), delay);
    (timer as { unref?: () => void }).unref?.();
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve({ kind: "value", v });
      },
      (e: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "error", e });
      },
    );
  });
}

export interface Gathered<T> {
  /** One entry per request, in start order; unsettled ones are `timeout`. */
  readonly settled: Array<Settled<T>>;
  readonly timedOut: boolean;
}

/**
 * Start `count` requests together and wait for all of them, as a group, for at
 * most `timeoutMs`. On timeout the controller is aborted (best effort) and the
 * answers that already settled are kept. Never rejects, never throws.
 */
export async function gatherSamples<T>(
  count: number,
  timeoutMs: number,
  controller: AbortController,
  start: (index: number, signal: AbortSignal) => Promise<T>,
): Promise<Gathered<T>> {
  const slots: Array<Settled<T> | null> = Array.from({ length: count }, () => null);
  const running: Array<Promise<void>> = [];
  for (let i = 0; i < count; i++) {
    running.push(
      (async () => start(i, controller.signal))().then(
        (v) => {
          slots[i] = { kind: "value", v };
        },
        (e: unknown) => {
          slots[i] = { kind: "error", e };
        },
      ),
    );
  }
  const raced = await raceTimeout(Promise.all(running), timeoutMs);
  const timedOut = raced.kind === "timeout";
  const settled = slots.map((slot): Settled<T> => slot ?? { kind: "timeout" });
  if (timedOut) controller.abort();
  return { settled, timedOut };
}

// ---------------------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------------------

/** Error → short, scrubbed reason. Never contains state text (errors are not built from it). */
export function reasonOf(error: unknown): string {
  let message: unknown = error;
  if (typeof error === "object" && error !== null && "message" in error) {
    message = (error as { message?: unknown }).message;
  }
  let text: string;
  try {
    text = String(message);
  } catch {
    text = "unprintable error";
  }
  return scrubState(text).slice(0, 200);
}

export function cutRaw(text: string): string {
  return scrubState(text).slice(0, RAW_ANSWER_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Outcomes, results and logging
// ---------------------------------------------------------------------------

export interface BackendRuntime {
  readonly id: BackendId;
  readonly logger: ClassifierLogger;
  readonly now: () => number;
  /** `disabled` reasons already logged by this instance. */
  readonly disabledLogged: Set<string>;
}

export function createRuntime(
  id: BackendId,
  logger: ClassifierLogger,
  now: (() => number) | undefined,
): BackendRuntime {
  return { id, logger, now: now ?? Date.now, disabledLogged: new Set() };
}

/** Logger calls must not break the never-throws contract of a backend. */
export function safeWarn(logger: ClassifierLogger, message: string, extra?: Record<string, unknown>): void {
  try {
    logger.warn(message, extra);
  } catch (error) {
    console.error(`[model-router] classifier logger failed: ${reasonOf(error)}`);
  }
}

/** What a backend concluded, before it becomes a `BackendResult`. */
export interface Outcome {
  readonly status: BackendStatus;
  readonly label?: TaskClass;
  readonly confidence?: number;
  readonly raw: string | null;
  readonly reason?: string;
  readonly risk?: Risk;
  readonly scope?: Scope;
}

export function buildResult(
  rt: BackendRuntime,
  outcome: Outcome,
  calls: number,
  latencyMs: number,
): BackendResult {
  const reason = outcome.reason === undefined ? {} : { reason: outcome.reason };
  if (outcome.status === "ok" && outcome.label !== undefined) {
    return {
      facts: {
        class: outcome.label,
        confidence: outcome.confidence ?? CONFIDENCE.backendSingleSample,
        source: rt.id,
        ...(outcome.risk ? { risk: outcome.risk } : {}),
        ...(outcome.scope ? { scope: outcome.scope } : {}),
      },
      raw: outcome.raw,
      status: "ok",
      latencyMs,
      calls,
    };
  }
  if (outcome.status === "disagree") {
    return {
      facts: { class: "other", confidence: 0, source: rt.id },
      raw: outcome.raw,
      status: "disagree",
      ...reason,
      latencyMs,
      calls,
    };
  }
  return {
    facts: { class: "other", confidence: 0, source: "unknown" },
    raw: outcome.raw,
    status: outcome.status === "ok" ? "invalid" : outcome.status,
    ...reason,
    latencyMs,
    calls,
  };
}

/**
 * Log every non-ok result once per occurrence as `classifier <id>: <status> (<reason>)`
 * (one line per distinct status/reason for a batch); `disabled` once per
 * instance and reason. Never logs state text, prompts, keys or headers.
 */
export function logResults(rt: BackendRuntime, results: readonly BackendResult[]): void {
  const groups = new Map<string, { result: BackendResult; items: number }>();
  for (const result of results) {
    if (result.status === "ok") continue;
    const key = `${result.status}\u0000${result.reason ?? ""}`;
    const group = groups.get(key);
    if (group) group.items++;
    else groups.set(key, { result, items: 1 });
  }
  for (const [key, { result, items }] of groups) {
    if (result.status === "disabled") {
      if (rt.disabledLogged.has(key)) continue;
      rt.disabledLogged.add(key);
    }
    const extra: Record<string, unknown> = { latencyMs: result.latencyMs, calls: result.calls };
    if (results.length > 1) extra.items = items;
    safeWarn(rt.logger, `classifier ${rt.id}: ${result.status} (${result.reason ?? "no reason"})`, extra);
  }
}

/** A finished single classification: build, log, return. */
export function finish(rt: BackendRuntime, outcome: Outcome, calls: number, startedAt: number): BackendResult {
  const result = buildResult(rt, outcome, calls, Math.max(0, rt.now() - startedAt));
  logResults(rt, [result]);
  return result;
}

/** A finished batch: build each, log the distinct non-ok outcomes once. */
export function finishMany(
  rt: BackendRuntime,
  outcomes: readonly Outcome[],
  calls: number,
  startedAt: number,
): BackendResult[] {
  const latencyMs = Math.max(0, rt.now() - startedAt);
  const results = outcomes.map((outcome) => buildResult(rt, outcome, calls, latencyMs));
  logResults(rt, results);
  return results;
}

// ---------------------------------------------------------------------------
// Sample resolution (host and openai-compatible)
// ---------------------------------------------------------------------------

export interface SampleAnswer {
  readonly label: TaskClass | null;
  readonly raw: string | null;
  /** Why `label` is null, when the backend knows (non-JSON body, no content…). */
  readonly reason?: string;
}

interface HasRaw {
  readonly raw: string | null;
  readonly reason?: string;
}

/** Combine the settled requests' labels for ONE item into an outcome (vote, then failure mapping). */
export function resolveOutcome(
  labels: readonly (TaskClass | null)[],
  settled: readonly Settled<HasRaw>[],
  samples: 1 | 3,
  timedOut: boolean,
  timeoutMs: number,
): Outcome {
  const verdict = vote(labels, samples);
  let raw: string | null = null;
  for (const s of settled) {
    if (s.kind === "value" && s.v.raw !== null) {
      raw = s.v.raw;
      break;
    }
  }
  if (verdict.status === "ok") {
    return { status: "ok", label: verdict.label, confidence: verdict.confidence, raw };
  }
  if (verdict.status === "disagree") {
    return { status: "disagree", confidence: 0, raw, reason: "samples disagree" };
  }
  if (timedOut) {
    return { status: "timeout", raw, reason: `no answer within ${timeoutMs} ms` };
  }
  for (const s of settled) {
    if (s.kind === "error") return { status: "error", raw, reason: reasonOf(s.e) };
  }
  for (const s of settled) {
    if (s.kind === "value" && s.v.reason !== undefined) return { status: "invalid", raw, reason: s.v.reason };
  }
  return { status: "invalid", raw, reason: "answer is not one of the labels" };
}

/** Result of a call that could not run (misconfiguration). */
export function disabled(rt: BackendRuntime, reason: string, startedAt: number): BackendResult {
  return finish(rt, { status: "disabled", raw: null, reason }, 0, startedAt);
}

/** `disabled` for every item of a batch. */
export function disabledMany(
  rt: BackendRuntime,
  count: number,
  reason: string,
  startedAt: number,
): BackendResult[] {
  return finishMany(
    rt,
    Array.from({ length: count }, (): Outcome => ({ status: "disabled", raw: null, reason })),
    0,
    startedAt,
  );
}

/** Belt and braces: wrap a backend body so an unexpected throw becomes an `error` result. */
export async function guarded(
  rt: BackendRuntime,
  startedAt: number,
  run: () => Promise<BackendResult>,
): Promise<BackendResult> {
  try {
    return await run();
  } catch (error) {
    return finish(rt, { status: "error", raw: null, reason: reasonOf(error) }, 0, startedAt);
  }
}

export async function guardedMany(
  rt: BackendRuntime,
  count: number,
  startedAt: number,
  run: () => Promise<BackendResult[]>,
): Promise<BackendResult[]> {
  try {
    return await run();
  } catch (error) {
    return finishMany(
      rt,
      Array.from({ length: count }, (): Outcome => ({ status: "error", raw: null, reason: reasonOf(error) })),
      0,
      startedAt,
    );
  }
}
