/**
 * `[route …]` line (D13) — parse, strip and apply. Design L1–L3 of
 * `docs/qa/cost-aware-routing/phase-1.2.md`.
 *
 * Pure. The route line is a typed override written by the orchestrator or by
 * `/annotate-plan`; it is read from its own line only (a `[route …]` mention
 * inside a sentence is text) and every route line is stripped from the prompt.
 */

import { fenceMask } from "./fences";
import {
  CLASS_IMPLIED_NEEDS,
  CONFIDENCE,
  DETECTIONS,
  NEEDS,
  RISKS,
  ROUTE_LINE_MAX_CHARS,
  ROUTE_LINE_RE,
  SCOPES,
  TASK_CLASSES,
  type Detection,
  type Need,
  type Risk,
  type RouteLine,
  type RouteLineParse,
  type Scope,
  type TaskClass,
  type TaskFacts,
} from "./types";

const ROUTE_MENTION_RE = /\[route/i;
/**
 * `needs=shell, edit , network`: whitespace around the commas of a needs list is
 * not a separator (QA-1.2-14). A word followed by `=` starts the next field, so
 * `needs=shell, class=debug` keeps its two fields.
 */
const NEEDS_LIST_RE = /(\bneeds=[a-z_]*)((?:\s*,\s*[a-z_]+(?![a-z_]|\s*=))+)/gi;
const LINE_SPLIT_RE = /(\r\n|\n|\r)/;

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function stripTail(value: string): string {
  return value.replace(/[,;]+$/, "");
}

/** `pin` values: bare / true / yes / 1 → true; false / no / 0 → false; anything else → undefined. */
function parsePin(value: string | null): boolean | undefined {
  if (value === null) return true;
  if (value === "true" || value === "yes" || value === "1") return true;
  if (value === "false" || value === "no" || value === "0") return false;
  return undefined;
}

function parseNeeds(value: string): readonly Need[] | undefined {
  const found = new Set<Need>();
  for (const token of value.split(",")) {
    const t = token.trim();
    if (isMember(NEEDS, t)) found.add(t);
  }
  if (found.size === 0) return undefined;
  return NEEDS.filter((need) => found.has(need));
}

/** L2: the fields of one route line body. */
function parseFields(body: string): RouteLine {
  let taskClass: TaskClass | undefined;
  let risk: Risk | undefined;
  let scope: Scope | undefined;
  let needs: readonly Need[] | undefined;
  let detection: Detection | undefined;
  let pin = false;
  const ignored: string[] = [];
  const seen = new Set<string>();

  const tokens = body
    .replace(/\s*=\s*/g, "=")
    .replace(NEEDS_LIST_RE, (_whole, head: string, tail: string) => head + tail.replace(/\s+/g, ""))
    .split(/\s+/)
    .filter((token) => token !== "");
  for (const token of tokens) {
    const eq = token.indexOf("=");
    const key = stripTail((eq === -1 ? token : token.slice(0, eq)).toLowerCase());
    const value = eq === -1 ? null : stripTail(token.slice(eq + 1).toLowerCase());
    if (key === "") {
      ignored.push(token);
      continue;
    }
    if (seen.has(key)) {
      ignored.push(`dup:${key}`);
      continue;
    }
    seen.add(key);
    switch (key) {
      case "class":
        if (value !== null && isMember(TASK_CLASSES, value)) taskClass = value;
        else ignored.push(key);
        break;
      case "risk":
        if (value !== null && isMember(RISKS, value)) risk = value;
        else ignored.push(key);
        break;
      case "scope":
        if (value !== null && isMember(SCOPES, value)) scope = value;
        else ignored.push(key);
        break;
      case "needs": {
        const parsed = value === null ? undefined : parseNeeds(value);
        if (parsed) needs = parsed;
        else ignored.push(key);
        break;
      }
      case "d":
        if (value !== null && isMember(DETECTIONS, value)) detection = value;
        else ignored.push(key);
        break;
      case "pin": {
        const parsed = parsePin(value);
        if (parsed === undefined) ignored.push(key);
        else pin = parsed;
        break;
      }
      default:
        ignored.push(key);
    }
  }

  return {
    ...(taskClass ? { class: taskClass } : {}),
    ...(risk ? { risk } : {}),
    ...(scope ? { scope } : {}),
    ...(needs ? { needs } : {}),
    ...(detection ? { detection } : {}),
    pin,
    ignored,
  };
}

/** Leading whitespace of 4+ columns (tabs count 4): an indented code block, not a directive. */
const INDENTED_CODE_RE = /^(?: {0,3}\t| {4})/;
const QUOTED_RE = /^\s*>/;

/**
 * Only a plain, unquoted, unindented, outside-any-fence, short line can be a
 * route line: anything else is text quoted or pasted into the prompt (a file,
 * a log, an issue) and must neither steer routing nor be stripped.
 */
function isRecognisable(line: string, inFence: boolean): boolean {
  return (
    !inFence &&
    line.length <= ROUTE_LINE_MAX_CHARS &&
    !INDENTED_CODE_RE.test(line) &&
    !QUOTED_RE.test(line) &&
    ROUTE_LINE_RE.test(line)
  );
}

function canonical(line: RouteLine): string {
  return JSON.stringify([line.class, line.risk, line.scope, line.needs, line.detection, line.pin]);
}

/**
 * Several route lines: when they differ in any field the parse is a conflict.
 * The effective line keeps the FIRST line's class/risk/scope/needs only where no
 * other line carries a different value for the same field, and never `d` or
 * `pin` (those would let a smuggled second line pin a model or skip checks).
 */
function resolveConflict(lines: readonly RouteLine[]): RouteLine {
  const first = lines[0]!;
  const ignored = [...first.ignored, "conflict"];
  const contradicted = (pick: (l: RouteLine) => unknown): boolean => {
    const mine = JSON.stringify(pick(first));
    return lines.some((other) => {
      const theirs = pick(other);
      return theirs !== undefined && JSON.stringify(theirs) !== mine;
    });
  };
  const keep = <T>(field: string, value: T | undefined, pick: (l: RouteLine) => unknown): T | undefined => {
    if (value === undefined) return undefined;
    if (contradicted(pick)) {
      ignored.push(`conflict:${field}`);
      return undefined;
    }
    return value;
  };
  const taskClass = keep("class", first.class, (l) => l.class);
  const risk = keep("risk", first.risk, (l) => l.risk);
  const scope = keep("scope", first.scope, (l) => l.scope);
  const needs = keep("needs", first.needs, (l) => l.needs);
  if (lines.some((l) => l.detection !== undefined)) ignored.push("conflict:d");
  if (lines.some((l) => l.pin)) ignored.push("conflict:pin");
  return {
    ...(taskClass ? { class: taskClass } : {}),
    ...(risk ? { risk } : {}),
    ...(scope ? { scope } : {}),
    ...(needs ? { needs } : {}),
    pin: false,
    ignored,
  };
}

/**
 * Where a route line is recognised (A22): `first` = only the first non-empty line
 * of the text (the protocol: the orchestrator's directive is the first line),
 * `edges` = the first or the last non-empty line, `any` = anywhere outside
 * fences, quotes and indented code. Elsewhere a `[route …]` line is plain text
 * and stays in the prompt.
 */
export type RouteLinePositions = "first" | "edges" | "any";

export interface RouteLineOptions {
  /** Default `any` for the parser itself; `classify` defaults to `first`. */
  readonly positions?: RouteLinePositions;
}

/**
 * L1 + L2: find every recognisable route line, parse them, strip them. Route
 * lines are whole lines; the terminator that follows a dropped line goes with
 * it, everything else is kept byte for byte (including route-looking lines in
 * fences, indented code and quotes).
 */
export function parseRouteLine(text: string, options: RouteLineOptions = {}): RouteLineParse {
  if (typeof text !== "string") {
    return { line: null, count: 0, stripped: "", conflict: false, edgeOnly: true };
  }
  if (!ROUTE_MENTION_RE.test(text)) {
    return { line: null, count: 0, stripped: text, conflict: false, edgeOnly: true };
  }
  const positions = options.positions ?? "any";
  const parts = text.split(LINE_SPLIT_RE);
  const lines: string[] = [];
  for (let i = 0; i < parts.length; i += 2) lines.push(parts[i]!);
  const fenced = fenceMask(lines);

  let firstNonEmpty = -1;
  let lastNonEmpty = -1;
  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    if (firstNonEmpty === -1) firstNonEmpty = i;
    lastNonEmpty = i;
  });

  const kept: string[] = [];
  const parsed: RouteLine[] = [];
  let edgeOnly = true;
  for (let i = 0; i < lines.length; i++) {
    const terminator = parts[2 * i + 1];
    const line = lines[i]!;
    const atEdge = i === firstNonEmpty || i === lastNonEmpty;
    const placed = positions === "any" || (positions === "edges" ? atEdge : i === firstNonEmpty);
    if (!placed || !isRecognisable(line, fenced[i]!)) {
      kept.push(line);
      if (terminator !== undefined) kept.push(terminator);
      continue;
    }
    if (!atEdge) edgeOnly = false;
    parsed.push(parseFields(ROUTE_LINE_RE.exec(line)?.[1] ?? ""));
  }
  if (parsed.length === 0) {
    return { line: null, count: 0, stripped: kept.join(""), conflict: false, edgeOnly: true };
  }
  const conflict = new Set(parsed.map(canonical)).size > 1;
  return {
    line: conflict ? resolveConflict(parsed) : parsed[0]!,
    count: parsed.length,
    stripped: kept.join(""),
    conflict,
    edgeOnly,
  };
}
const RISK_ORDER: readonly Risk[] = RISKS;

function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/**
 * L3: merge a route line over rules facts. Class and scope override; risk may
 * only rise; needs are unioned (and completed by the class's implied needs and
 * by `network` ⇒ `shell`). A valid class makes the route line the source and
 * sets confidence 0.9; without one, confidence and source stay the base's.
 */
export function applyRouteLine(base: TaskFacts, line: RouteLine): TaskFacts {
  const taskClass = line.class ?? base.class;
  const needs = new Set<Need>([...base.needs, ...(line.needs ?? []), ...CLASS_IMPLIED_NEEDS[taskClass]]);
  if (needs.has("network")) needs.add("shell");
  const hasClass = line.class !== undefined;
  return {
    class: taskClass,
    risk: maxRisk(base.risk, line.risk ?? base.risk),
    scope: line.scope ?? base.scope,
    needs: NEEDS.filter((need) => needs.has(need)),
    confidence: hasClass ? CONFIDENCE.routeLine : base.confidence,
    source: hasClass ? (line.detection ? "plan" : "route-line") : base.source,
  };
}
