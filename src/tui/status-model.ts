/**
 * Pure status model for the v2 TUI status views (#90, plan §2 D2–D5/D7, amendments A3, A5, A9). No host
 * imports: the host shapes are mirrored structurally and minimally; the TUI views (P1.3) read the host
 * context, call these functions and render the strings.
 *
 * - G1 main footer: {@link effectiveMainEffort} (A3): nothing when a variant is selected (the host row shows
 *   it), the applied effort of the prompt's current model when the server channel reports one for a turn that
 *   ran without a variant, else `default`.
 * - G2 child view: {@link childStatus} (A5): the latest assistant message's model, before it the session's.
 * - G3 running row: {@link runningChildren}: every running delegate of the family, stable order, at most `max`
 *   rows.
 * - Labels and layout: {@link modelLabel}, {@link effortLabel}, {@link formatRow}, width-aware
 *   {@link displayWidth} / {@link truncate}; rendered text is sanitised (control, bidi and line-separator
 *   characters → space) and measured as rendered.
 * - Options (D7): {@link parseOptions}, defaults plus at most one notice.
 *
 * Empty and whitespace-only strings count as absent everywhere, and an effort or variant `"default"` too, except
 * `selectedVariant` in {@link effectiveMainEffort}: it follows the host row's truthiness, so any non-empty
 * string (`" "` and `"default"` included) counts as selected.
 */

/** Mirrors the host's `Model.Ref`: `variant` is absent when none was selected. */
export interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

/**
 * Mirrors an entry of the host's model list (`data.location.model.list()`). Only `id`, `providerID`, `name` and
 * `variants` are read; the host's entries, with all their other fields, are assignable as they are.
 */
export interface ModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly name?: string;
  readonly variants?: ReadonlyArray<{ readonly id: string }>;
}

/**
 * A host timestamp: epoch milliseconds, or an Effect `DateTime.Utc` (v2 decodes `time.created` to one; it carries
 * `epochMilliseconds`). `time.created` may also be `null`: it sorts as the oldest.
 */
export type CreatedTime = number | { readonly epochMilliseconds: number };

export interface SessionLike {
  id: string;
  parentID?: string;
  agent?: string;
  title?: string;
  model?: ModelRef;
  time?: { created?: CreatedTime | null };
}

/** A session message. v2 tags it with `type` (`"assistant"`, `"user"`, `"model-switched"`, …); a legacy `role` is read when `type` is absent. */
export interface MessageLike {
  id: string;
  type?: string;
  role?: string;
  agent?: string;
  model?: ModelRef;
  time?: { created?: CreatedTime | null };
}

/** The effort a session's own turn actually applied, as reported by the server channel (P1.2); may be absent. */
export interface AppliedEffort {
  effort: string;
  /** The recorded turn's variant; absent (or blank, or `"default"`) when the turn ran without one. */
  variant?: string;
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
  /** The selected variant (`ui.model.current()?.variant`); any non-empty string counts as selected. */
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
  /** Row limit, see {@link clampMax}: floored, below 1 or NaN → 1, Infinity → all rows. */
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
  /** At most one notice, listing every problem. */
  notices: string[];
}

export const DEFAULT_EFFORT = "default";
/** Model label of a running child for which neither a message nor the session carries a model ref. */
export const UNKNOWN_MODEL = "unknown";
/** Agent label of a running child without agent and title. */
export const FALLBACK_AGENT = "subagent";
/**
 * `…` (U+2026) and `·` (U+00B7, in {@link ROW_SEPARATOR}) are East Asian Ambiguous; like every Ambiguous
 * character they are counted as 1 column (narrow terminals).
 */
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
/** `formatRow` shrinks this many leading parts before it cuts the whole row. */
const SHRINK_PARTS = 2;

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

/** Epoch milliseconds of `time.created` (a number or a `DateTime.Utc`); missing, null or non-finite sorts as the oldest. */
function createdOf(time: { created?: CreatedTime | null } | undefined): number {
  const created = time?.created;
  const millis = created !== null && typeof created === "object" ? created.epochMilliseconds : created;
  return typeof millis === "number" && Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
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
 * G1 (A3): undefined when a variant is selected (any non-empty string, as the host row decides; the row already
 * shows it). Otherwise the applied effort when it was recorded for the prompt's current model by a turn without
 * a variant; a turn that ran with a variant the user has since cleared is stale. Otherwise `"default"`.
 */
export function effectiveMainEffort(input: MainEffortInput): string | undefined {
  const { selectedVariant, applied, current } = input;
  if (selectedVariant !== undefined && selectedVariant !== "") return undefined;
  if (
    applied !== undefined &&
    current !== undefined &&
    sameModel(applied, current.providerID, current.modelID) &&
    effortValue(applied.variant) === undefined
  ) {
    return effortValue(applied.effort) ?? DEFAULT_EFFORT;
  }
  return DEFAULT_EFFORT;
}

function isAssistantWithModel(message: MessageLike): message is AssistantWithModel {
  return (message.type ?? message.role) === "assistant" && hasRef(message.model);
}

/**
 * The latest assistant message (`type`, else legacy `role`, `"assistant"`) with a usable model ref, by
 * `time.created` (missing → oldest); on equal times the later array entry wins.
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
 * @internal Row limit of {@link runningChildren}: a number ≥ 1 is floored (Infinity → all rows); anything else
 * (below 1, NaN, not a number) → 1.
 */
export function clampMax(value: unknown): number {
  return typeof value === "number" && value >= MAX_ROWS_MIN ? Math.floor(value) : MAX_ROWS_MIN;
}

/**
 * G3: every running delegate of the family. Kept: ids other than the root (duplicates once) whose status is
 * `"running"` and whose session exists and has a `parentID`; the session is looked up only for running ids.
 * Grandchildren (`parentID` ≠ root) are kept too: the row lists every running delegate of the family. Order:
 * `session.time.created` ascending (missing → first), then id. At most `max` rows ({@link clampMax});
 * `overflow` counts the rest. A running child without any model ref gets `model: "unknown"`,
 * `effort: "default"`; agent falls back to `session.title`, then `"subagent"`.
 */
export function runningChildren(input: RunningChildrenInput): RunningChildren {
  const limit = clampMax(input.max);
  const seen = new Set<string>();
  const running: Array<{ id: string; session: SessionLike; created: number }> = [];
  for (const id of input.family) {
    if (id === input.rootID || seen.has(id)) continue;
    seen.add(id);
    if (input.status(id) !== "running") continue;
    const session = input.sessions(id);
    if (session === undefined || nonEmpty(session.parentID) === undefined) continue;
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
const SOFT_HYPHEN = 0x00ad;
const RE_ZERO_WIDTH = /^[\p{Cf}\p{M}]$/u;
const RE_MARK = /^\p{M}$/u;
const RE_SPACING_MARK = /^\p{Mc}$/u;
const RE_EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const RE_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
/**
 * Control characters (`\p{Cc}`), bidi controls (ALM U+061C, LRM, RLM, LRE–RLO, LRI–PDI) and the line and
 * paragraph separators (U+2028, U+2029): each becomes one space in rendered and measured text.
 */
const RE_UNSAFE = /[\p{Cc}\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
const RE_WHITESPACE_RUN = /\s+/gu;

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

/**
 * Spacing marks (`\p{Mc}`) and the soft hyphen take 1 column; other marks and format characters 0; wide,
 * fullwidth and emoji-presentation 2; everything else (East Asian Ambiguous included) 1.
 */
function codePointWidth(ch: string, cp: number): number {
  if (cp === SOFT_HYPHEN || RE_SPACING_MARK.test(ch)) return 1;
  if (RE_ZERO_WIDTH.test(ch)) return 0;
  if (RE_EMOJI_PRESENTATION.test(ch) || WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return 2;
  return 1;
}

interface Cluster {
  text: string;
  width: number;
}

interface OpenCluster extends Cluster {
  /** The base is `\p{Extended_Pictographic}`. */
  pictographic: boolean;
  /** A pictographic cluster that ends in a ZWJ: the next pictograph joins it. */
  afterZwj: boolean;
  regional: number;
}

function joins(open: OpenCluster, ch: string, cp: number): boolean {
  return (open.afterZwj && RE_PICTOGRAPHIC.test(ch)) || isExtender(ch, cp) || (open.regional === 1 && isRegional(cp));
}

/**
 * Splits text into display clusters: a base code point with its combining marks, variation selectors, skin
 * tones and tags, pictographic ZWJ sequences, and regional-indicator pairs. Surrogate pairs are never split. A
 * ZWJ joins the next code point only when the open cluster is pictographic and that code point is
 * `\p{Extended_Pictographic}`; a leading or orphan ZWJ joins nothing after it. Width: the base's (see
 * `codePointWidth`), plus 1 per joined spacing mark; at least 2 once a pictograph joins after a ZWJ, and 2 when
 * a narrow base takes VS16 (emoji presentation). Expects sanitised text (see {@link sanitise}).
 */
function clusters(text: string): Cluster[] {
  const out: Cluster[] = [];
  let open: OpenCluster | undefined;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (open !== undefined && joins(open, ch, cp)) {
      if (open.afterZwj && RE_PICTOGRAPHIC.test(ch)) open.width = Math.max(open.width, 2);
      else if (RE_SPACING_MARK.test(ch)) open.width += 1;
      else if (cp === VS16 && open.width === 1) open.width = 2;
      open.text += ch;
      if (isRegional(cp)) open.regional += 1;
      open.afterZwj = cp === ZWJ && open.pictographic;
      continue;
    }
    if (open !== undefined) out.push({ text: open.text, width: open.width });
    open = {
      text: ch,
      width: codePointWidth(ch, cp),
      pictographic: RE_PICTOGRAPHIC.test(ch),
      afterZwj: false,
      regional: isRegional(cp) ? 1 : 0,
    };
  }
  if (open !== undefined) out.push({ text: open.text, width: open.width });
  return out;
}

/**
 * Terminal columns of `text` as rendered: East Asian wide/fullwidth and emoji 2; combining (non-spacing) marks
 * and format characters 0; spacing marks, the soft hyphen and East Asian Ambiguous characters 1; every
 * character that {@link sanitise} turns into a space (control, bidi control, line/paragraph separator) 1, so
 * raw and sanitised text measure the same.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of clusters(sanitise(text))) width += cluster.width;
  return width;
}

/** Each control character, bidi control and line/paragraph separator (`RE_UNSAFE`) replaced by one space. */
function sanitise(text: string): string {
  return text.replace(RE_UNSAFE, " ");
}

/**
 * `text`, sanitised (see {@link sanitise}), cut to at most `width` columns
 * (floored); a cut appends `…` (1 column) and never splits a cluster (surrogate pair, base + combining marks,
 * ZWJ sequence, flag). Width ≤ 0 or NaN → `""`.
 */
export function truncate(text: string, width: number): string {
  const limit = Math.floor(width);
  if (!(limit > 0)) return "";
  const safe = sanitise(text);
  const parts = clusters(safe);
  let total = 0;
  for (const part of parts) total += part.width;
  if (total <= limit) return safe;
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

/** A row part as rendered: sanitised, whitespace runs collapsed to one space, trimmed. */
function cleanPart(part: string): string {
  return sanitise(part).replace(RE_WHITESPACE_RUN, " ").trim();
}

/**
 * Non-blank parts (sanitised, whitespace runs collapsed, trimmed) joined with ` · ` in at most `width` columns
 * (floored). Too wide: the first part shrinks first, to the room left by the trailing parts and separators
 * (at least 1 column, `…` included); still too wide: the second part the same way; only then the whole row is
 * cut from the end. Width ≤ 0 or NaN → `""`.
 */
export function formatRow(parts: readonly string[], width: number): string {
  const limit = Math.floor(width);
  if (!(limit > 0)) return "";
  const cells = parts.map(cleanPart).filter((part) => part !== "");
  let row = cells.join(ROW_SEPARATOR);
  for (let i = 0; i < SHRINK_PARTS && i < cells.length && displayWidth(row) > limit; i++) {
    const rest = displayWidth(row) - displayWidth(cells[i]);
    cells[i] = truncate(cells[i], Math.max(1, limit - rest));
    row = cells.join(ROW_SEPARATOR);
  }
  return truncate(row, limit);
}

/** `record[key]` when `key` is an own property; inherited keys count as absent. */
function ownValue(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/** The one options notice, sanitised (a key may carry bidi or separator characters). */
function optionsNotice(problems: readonly string[], fallback: string): string {
  return sanitise(`${STATUS_NOTICE_PREFIX}invalid TUI options (${problems.join("; ")}); ${fallback}`);
}

/**
 * D7: TUI plugin options. Undefined/null → defaults, no notice. Not an object (or an array) → defaults and the
 * notice `model-router status: invalid TUI options (not an object); using the defaults`. Only own keys are read.
 * Each flag must be a boolean and `maxRows` an integer from 1 to 20; an invalid value keeps the default. Unknown
 * keys are ignored. All problems (flags, then `maxRows`, then unknown keys) go into one sanitised notice:
 * `model-router status: invalid TUI options (<problem>; …); using defaults for those keys`.
 */
export function parseOptions(raw: unknown): ParsedOptions {
  const options: StatusOptions = { ...DEFAULT_STATUS_OPTIONS };
  if (raw === undefined || raw === null) return { options, notices: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { options, notices: [optionsNotice(["not an object"], "using the defaults")] };
  }
  const problems: string[] = [];
  for (const key of FLAG_KEYS) {
    const value = ownValue(raw, key);
    if (value === undefined) continue;
    if (typeof value === "boolean") options[key] = value;
    else problems.push(`"${key}" must be true or false`);
  }
  const maxRows = ownValue(raw, "maxRows");
  if (maxRows !== undefined) {
    if (typeof maxRows === "number" && Number.isInteger(maxRows) && maxRows >= MAX_ROWS_MIN && maxRows <= MAX_ROWS_MAX) {
      options.maxRows = maxRows;
    } else {
      problems.push(`"maxRows" must be an integer from ${MAX_ROWS_MIN} to ${MAX_ROWS_MAX}`);
    }
  }
  const unknownKeys = Object.keys(raw).filter((key) => !KNOWN_KEYS.has(key));
  if (unknownKeys.length > 0) problems.push(`unknown keys ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`);
  const notices = problems.length === 0 ? [] : [optionsNotice(problems, "using defaults for those keys")];
  return { options, notices };
}
