/**
 * `[route …]` line (D13) — parse, strip and apply. Design L1–L3 of
 * `docs/qa/cost-aware-routing/phase-1.2.md`.
 *
 * Pure. The route line is a typed override written by the orchestrator or by
 * `/annotate-plan`; it is read from its own line only (a `[route …]` mention
 * inside a sentence is text) and every route line is stripped from the prompt.
 */

import {
  CLASS_IMPLIED_NEEDS,
  CONFIDENCE,
  DETECTIONS,
  NEEDS,
  RISKS,
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

/**
 * L1 + L2: find every route line, parse the first, strip all of them. Route
 * lines are whole lines; the terminator that follows a dropped line goes with
 * it, everything else is kept byte for byte.
 */
export function parseRouteLine(text: string): RouteLineParse {
  if (typeof text !== "string" || !ROUTE_MENTION_RE.test(text)) {
    return { line: null, count: 0, stripped: typeof text === "string" ? text : "" };
  }
  const parts = text.split(LINE_SPLIT_RE);
  const kept: string[] = [];
  let line: RouteLine | null = null;
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i]!;
    const terminator = parts[i + 1];
    const m = ROUTE_LINE_RE.exec(part);
    if (m === null) {
      kept.push(part);
      if (terminator !== undefined) kept.push(terminator);
      continue;
    }
    count++;
    if (line === null) line = parseFields(m[1] ?? "");
  }
  return { line, count, stripped: kept.join("") };
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
