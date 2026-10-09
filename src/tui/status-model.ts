/**
 * Pure status model for the v2 TUI status views (#90, plan §2 D2–D5/D7, amendments A3, A5, A9). No host
 * imports: the host shapes are mirrored structurally and minimally; the TUI views (P1.3) read the host
 * context, call these functions and render the strings.
 *
 * - G1 main footer: {@link effectiveMainEffort} (A3): nothing when a variant is selected (the host row shows
 *   it), the applied effort of the prompt's current model when the server channel reports one, else `default`.
 * - G2 child view: {@link childStatus} (A5): the latest assistant message's model, before it the session's.
 * - G3 running row: {@link runningChildren}: the family's running children, stable order, at most `max` rows.
 * - Labels and layout: {@link modelLabel}, {@link effortLabel}, {@link formatRow}, width-aware
 *   {@link displayWidth} / {@link truncate}.
 * - Options (D7): {@link parseOptions}, defaults plus one notice per problem.
 *
 * Empty and whitespace-only strings count as absent everywhere; an effort or variant `"default"` too.
 */

/** Mirrors the host's `Model.Ref`: `variant` is absent when none was selected. */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/** Mirrors an entry of the host's model list (`data.location.model.list()`). */
export interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  variants?: readonly string[];
}

export interface SessionLike {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  model?: ModelRef;
  time?: { created?: number };
}

export interface MessageLike {
  id: string;
  role: string;
  agent?: string;
  model?: ModelRef;
  time?: { created?: number };
}

/** The effort a session's own turn actually applied, as reported by the server channel (P1.2); may be absent. */
export interface AppliedEffort {
  effort: string;
  providerID: string;
  modelID: string;
}

/** The prompt's current model (`ui.model.current()`). */
export interface CurrentModel {
  providerID: string;
  modelID: string;
}

/** Mirrors the host's `data.session.status(id)`. */
export type SessionStatus = "idle" | "running";

/** An assistant message that carries a usable model ref. */
export type AssistantWithModel = MessageLike & { model: ModelRef };

export interface MainEffortInput {
  /** The selected variant (`ui.model.current()?.variant`). */
  selectedVariant?: string;
  /** The applied effort of the main session, from the server channel. */
  applied?: AppliedEffort;
  /** The prompt's current model; `applied` is used only when it was recorded for this model. */
  current?: CurrentModel;
}

export interface ChildStatusInput {
  session: SessionLike;
  messages: readonly MessageLike[];
  models: readonly ModelInfo[];
  applied?: AppliedEffort;
}

export interface ChildStatus {
  model: string;
  effort: string;
  agent?: string;
}

export interface RunningChildrenInput {
  rootID: string;
  /** Ids of the root's family, root included (`data.session.family(rootID)`). */
  family: readonly string[];
  status(id: string): SessionStatus;
  sessions(id: string): SessionLike | undefined;
  messages(id: string): readonly MessageLike[];
  models: readonly ModelInfo[];
  /** The server channel's applied effort per session; absent when there is no channel. */
  applied?(id: string): AppliedEffort | undefined;
  /** Row limit, clamped to ≥ 1 (NaN → 1). */
  max: number;
}

export interface RunningRow {
  id: string;
  agent: string;
  model: string;
  effort: string;
}

export interface RunningChildren {
  rows: RunningRow[];
  /** Running children beyond `max` (rendered as `+k`). */
  overflow: number;
}

export interface StatusOptions {
  enabled: boolean;
  /** G1: effort in the main prompt footer. */
  footer: boolean;
  /** G2: model and effort in a child session view. */
  childView: boolean;
  /** G3: running delegates above the main composer. */
  runningRow: boolean;
  maxRows: number;
}

export interface ParsedOptions {
  options: StatusOptions;
  notices: string[];
}

export const DEFAULT_EFFORT = "default";
/** Model label of a running child for which neither a message nor the session carries a model ref. */
export const UNKNOWN_MODEL = "unknown";
/** Agent label of a running child without agent and title. */
export const FALLBACK_AGENT = "subagent";
export const ELLIPSIS = "…";
export const ROW_SEPARATOR = " · ";
export const STATUS_NOTICE_PREFIX = "model-router status: ";
export const MAX_ROWS_MIN = 1;
export const MAX_ROWS_MAX = 20;
export const STATUS_OPTION_KEYS = ["enabled", "footer", "childView", "runningRow", "maxRows"] as const;
export const DEFAULT_STATUS_OPTIONS: Readonly<StatusOptions> = Object.freeze({
  enabled: true,
  footer: true,
  childView: true,
  runningRow: true,
  maxRows: 4,
});

const FLAG_KEYS = ["enabled", "footer", "childView", "runningRow"] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(STATUS_OPTION_KEYS);

/** The trimmed value, or undefined when absent, not a string, or blank. */
function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** An effort or variant worth showing: non-blank and not `"default"`. */
function effortValue(value: string | undefined): string | undefined {
  const text = nonEmpty(value);
  return text === DEFAULT_EFFORT ? undefined : text;
}

function hasRef(ref: ModelRef | undefined): ref is ModelRef {
  return ref !== undefined && nonEmpty(ref.id) !== undefined;
}

function sameModel(applied: AppliedEffort, providerID: string, modelID: string): boolean {
  return applied.providerID === providerID && applied.modelID === modelID;
}

/** A missing or non-finite `time.created` sorts as the oldest. */
function createdOf(time: { created?: number } | undefined): number {
  const created = time?.created;
  return typeof created === "number" && Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY;
}

/** -1, 0 or 1, locale-independent. */
function compare(a: number | string, b: number | string): number {
  return Number(a > b) - Number(a < b);
}

function displayName(info: ModelInfo): string {
  return nonEmpty(info.name) ?? info.id;
}

function labelOf(ref: ModelRef, models: readonly ModelInfo[]): string {
  const own = models.find((m) => m.providerID === ref.providerID && m.id === ref.id);
  const label = own === undefined ? ref.id : displayName(own);
  const shared = models.some((m) => m.providerID !== ref.providerID && displayName(m) === label);
  return shared && ref.providerID !== "" ? `${label} (${ref.providerID})` : label;
}

/**
 * Display label of a model ref: the `name` of the list entry with the same `providerID` and `id`, else the raw
 * `id`. When another provider's entry shows the same label, ` (<providerID>)` is appended (this also covers an
 * unknown ref whose id equals another provider's display name). Undefined ref or blank id → undefined.
 */
export function modelLabel(ref: ModelRef | undefined, models: readonly ModelInfo[]): string | undefined {
  return hasRef(ref) ? labelOf(ref, models) : undefined;
}

/**
 * Effort label: `effectiveEffort`, else the ref's variant, else `"default"`; blank values and `"default"` count
 * as absent. A variant is shown as recorded even when the model's `variants` list does not contain it.
 */
export function effortLabel(ref: ModelRef | undefined, effectiveEffort?: string): string {
  return effortValue(effectiveEffort) ?? effortValue(ref?.variant) ?? DEFAULT_EFFORT;
}

/**
 * G1 (A3): undefined when a variant is selected (non-empty; the host row already shows it); otherwise the
 * applied effort when it was recorded for the prompt's current model; otherwise `"default"`.
 */
export function effectiveMainEffort(input: MainEffortInput): string | undefined {
  const { selectedVariant, applied, current } = input;
  if (selectedVariant !== undefined && selectedVariant !== "") return undefined;
  if (applied !== undefined && current !== undefined && sameModel(applied, current.providerID, current.modelID)) {
    return effortValue(applied.effort) ?? DEFAULT_EFFORT;
  }
  return DEFAULT_EFFORT;
}

function isAssistantWithModel(message: MessageLike): message is AssistantWithModel {
  return message.role === "assistant" && hasRef(message.model);
}

/**
 * The latest assistant message with a usable model ref, by `time.created` (missing → oldest); on equal times
 * the later array entry wins.
 */
export function latestAssistant(messages: readonly MessageLike[]): AssistantWithModel | undefined {
  let latest: AssistantWithModel | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (!isAssistantWithModel(message)) continue;
    const created = createdOf(message.time);
    if (created >= latestTime) {
      latest = message;
      latestTime = created;
    }
  }
  return latest;
}

/**
 * G2 (A5): model and effort of a session. Ref: the latest assistant message's model, else `session.model`;
 * no ref → undefined. Effort: `applied.effort` when it was recorded for the ref's provider/model, else the
 * ref's variant, else `"default"`. Agent: `session.agent`, else the latest assistant message's agent.
 */
export function childStatus(input: ChildStatusInput): ChildStatus | undefined {
  const { session, messages, models, applied } = input;
  const latest = latestAssistant(messages);
  const ref = latest?.model ?? (hasRef(session.model) ? session.model : undefined);
  if (ref === undefined) return undefined;
  const effective = applied !== undefined && sameModel(applied, ref.providerID, ref.id) ? applied.effort : undefined;
  const model = labelOf(ref, models);
  const effort = effortLabel(ref, effective);
  const agent = nonEmpty(session.agent) ?? nonEmpty(latest?.agent);
  return agent === undefined ? { model, effort } : { model, effort, agent };
}

/**
 * G3: running children of the family. Kept: ids other than the root (duplicates once) whose session exists,
 * has a `parentID` and has status `"running"`. Order: `session.time.created` ascending (missing → first),
 * then id. At most `max` rows (clamped to ≥ 1); `overflow` counts the rest. A running child without any model
 * ref gets `model: "unknown"`, `effort: "default"`; agent falls back to `session.title`, then `"subagent"`.
 */
export function runningChildren(input: RunningChildrenInput): RunningChildren {
  const limit = Number.isNaN(input.max) ? MAX_ROWS_MIN : Math.max(MAX_ROWS_MIN, Math.floor(input.max));
  const seen = new Set<string>();
  const running: Array<{ id: string; session: SessionLike; created: number }> = [];
  for (const id of input.family) {
    if (id === input.rootID || seen.has(id)) continue;
    seen.add(id);
    const session = input.sessions(id);
    if (session === undefined || nonEmpty(session.parentID) === undefined) continue;
    if (input.status(id) !== "running") continue;
    running.push({ id, session, created: createdOf(session.time) });
  }
  running.sort((a, b) => compare(a.created, b.created) || compare(a.id, b.id));
  const rows = running.slice(0, limit).map(({ id, session }): RunningRow => {
    const status = childStatus({
      session,
      messages: input.messages(id),
      models: input.models,
      applied: input.applied?.(id),
    });
    return {
      id,
      agent: status?.agent ?? nonEmpty(session.agent) ?? nonEmpty(session.title) ?? FALLBACK_AGENT,
      model: status?.model ?? UNKNOWN_MODEL,
      effort: status?.effort ?? DEFAULT_EFFORT,
    };
  });
  return { rows, overflow: running.length - rows.length };
}

const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const RE_CONTROL = /^\p{Cc}$/u;
const RE_ZERO_WIDTH = /^[\p{Cf}\p{M}]$/u;
const RE_MARK = /^\p{M}$/u;
const RE_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;

/** East Asian Wide and Fullwidth ranges (emoji-presentation code points are matched separately). */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff],
  [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f265],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

function isRegional(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/** Joins the previous cluster: combining marks (variation selectors included), ZWJ, skin tones, tag characters. */
function isExtender(ch: string, cp: number): boolean {
  return RE_MARK.test(ch) || cp === ZWJ || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0020 && cp <= 0xe007f);
}

function codePointWidth(ch: string, cp: number): number {
  if (RE_ZERO_WIDTH.test(ch)) return 0;
  if (RE_EMOJI_PRESENTATION.test(ch) || WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  return 1;
}

interface Cluster {
  text: string;
  width: number;
}

interface OpenCluster extends Cluster {
  /** False after a control character: nothing joins it. */
  joinable: boolean;
  afterZwj: boolean;
  regional: number;
}

/**
 * Splits text into display clusters: a base code point with its combining marks, variation selectors, skin
 * tones and tags, ZWJ sequences, and regional-indicator pairs. Surrogate pairs are never split. Width: the
 * base's (control and format characters, combining marks 0; wide/fullwidth and emoji 2; else 1), and 2 when a
 * narrow base takes VS16 (emoji presentation).
 */
function clusters(text: string): Cluster[] {
  const out: Cluster[] = [];
  let open: OpenCluster | undefined;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const control = RE_CONTROL.test(ch);
    if (
      open !== undefined &&
      open.joinable &&
      !control &&
      (open.afterZwj || isExtender(ch, cp) || (open.regional === 1 && isRegional(cp)))
    ) {
      open.text += ch;
      if (cp === VS16 && open.width === 1) open.width = 2;
      if (isRegional(cp)) open.regional += 1;
      open.afterZwj = cp === ZWJ;
      continue;
    }
    if (open !== undefined) out.push({ text: open.text, width: open.width });
    open = {
      text: ch,
      width: control ? 0 : codePointWidth(ch, cp),
      joinable: !control,
      afterZwj: cp === ZWJ,
      regional: isRegional(cp) ? 1 : 0,
    };
  }
  if (open !== undefined) out.push({ text: open.text, width: open.width });
  return out;
}

/** Terminal columns of `text`: East Asian wide/fullwidth and emoji 2, combining marks and control characters 0. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(text)) width += cluster.width;
  return width;
}

/**
 * `text` cut to at most `width` columns (floored); a cut appends `…` (1 column) and never splits a cluster
 * (surrogate pair, base + combining marks, ZWJ sequence, flag). Width ≤ 0 or NaN → `""`.
 */
export function truncate(text: string, width: number): string {
  const limit = Math.floor(width);
  if (!(limit > 0)) return "";
  const parts = clusters(text);
  let total = 0;
  for (const part of parts) total += part.width;
  if (total <= limit) return text;
  const budget = limit - 1;
  let used = 0;
  let out = "";
  for (const part of parts) {
    if (used + part.width > budget) break;
    used += part.width;
    out += part.text;
  }
  return out + ELLIPSIS;
}

/** Non-blank parts joined with ` · `, truncated to `width`. */
export function formatRow(parts: readonly string[], width: number): string {
  return truncate(parts.filter((part) => part.trim() !== "").join(ROW_SEPARATOR), width);
}

function notice(text: string): string {
  return `${STATUS_NOTICE_PREFIX}${text}`;
}

/**
 * D7: TUI plugin options. Undefined/null → defaults, no notice. Not an object (or an array) → defaults and one
 * notice. Each flag must be a boolean and `maxRows` an integer from 1 to 20; an invalid value keeps the default
 * and adds a notice. Unknown keys are ignored with one notice that lists them.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  const options: StatusOptions = { ...DEFAULT_STATUS_OPTIONS };
  const notices: string[] = [];
  if (raw === undefined || raw === null) return { options, notices };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    notices.push(notice("options must be an object; using the defaults."));
    return { options, notices };
  }
  const record = raw as Record<string, unknown>;
  for (const key of FLAG_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === "boolean") options[key] = value;
    else notices.push(notice(`option "${key}" must be true or false; using ${String(DEFAULT_STATUS_OPTIONS[key])}.`));
  }
  const maxRows = record.maxRows;
  if (maxRows !== undefined) {
    if (typeof maxRows === "number" && Number.isInteger(maxRows) && maxRows >= MAX_ROWS_MIN && maxRows <= MAX_ROWS_MAX) {
      options.maxRows = maxRows;
    } else {
      notices.push(
        notice(
          `option "maxRows" must be an integer from ${MAX_ROWS_MIN} to ${MAX_ROWS_MAX}; using ${DEFAULT_STATUS_OPTIONS.maxRows}.`,
        ),
      );
    }
  }
  const unknown = Object.keys(record).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length > 0) {
    notices.push(notice(`unknown options ignored: ${unknown.map((key) => JSON.stringify(key)).join(", ")}.`));
  }
  return { options, notices };
}
