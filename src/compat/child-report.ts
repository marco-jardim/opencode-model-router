/**
 * #174: the host's report of a finished child session in its parent's history (memo §4.4, C2), in both envelopes the host
 * writes:
 *
 * - OpenCode 2.0.x: `<subagent sessionID="X" state="S" …>BODY</subagent>`
 * - OpenCode 2.3+: `<background-result kind="subagent" sessionID="X" state="S" description="…">BODY</background-result>`
 *   (a synthetic history entry; the host repeats the description on a line after the closing tag).
 *
 * The ONE matcher behind the completion scan, the held-result matcher, the `[router` defang, the fail-closed redaction and the
 * compaction hook, so they cannot drift apart. Attributes may come in any order and extra ones are tolerated. The closing tag
 * is the opening tag's own; an element without one runs to the end of the text, as the 2.0.x matcher did. A
 * `<background-result>` of another `kind` is no child report.
 *
 * Pure, and used by the v2 adapter only: src/index.ts (the v1 entry) reaches this module through background.ts, whose v1 imports
 * are constants and types, so loading it does nothing there.
 */

export type ChildReportTag = "subagent" | "background-result";

/** The opening tag of one child report. */
export interface ChildReportOpening {
  /** Where the opening tag starts (its `<`). */
  readonly index: number;
  /** Where the body starts (just past the opening tag's `>`); the end of the text for a tag that is not terminated. */
  readonly bodyStart: number;
  /** false: no `>` follows the tag name anywhere in the text (a cut-off tag). It has no body. */
  readonly terminated: boolean;
  readonly tag: ChildReportTag;
  /** The `sessionID` attribute (never empty). */
  readonly child: string;
  /** The `state` attribute, when there is one (`completed`, `error`, `cancelled`, the router's own `held` …). */
  readonly state: string | undefined;
  /** The `description` attribute, when there is one. */
  readonly description: string | undefined;
}

/** One child report: its opening tag, its body and where it ends. */
export interface ChildReport extends ChildReportOpening {
  readonly body: string;
  /** Just past the element: past its closing tag, or the end of the text when it has none. */
  readonly end: number;
  readonly closed: boolean;
}

/** Where an opening tag of either envelope may start. */
const CANDIDATE = /<(subagent|background-result)\s/g;
/**
 * The strict form of an opening tag, tried first at each candidate (sticky): `name="value"` pairs only, then `>`. A value may
 * hold `>` here, but no line break: a quote a crafted value leaves open cannot run into the body (the 2.3+ body starts on a
 * new line) and pair with a quote there. A tag that is not of this form (a value the host did not escape, with a lone `"`)
 * ends at the FIRST `>` after its name, so a lone quote can never pair with a quote of the body and carry the tag past it; its
 * body may then start too early, never too late.
 */
const STRICT_OPENING = /<(subagent|background-result)((?:\s+[^\s="<>]+="[^"\n\r]*")*)\s*>/y;
const ATTRIBUTE = /([^\s="<>]+)="([^"]*)"/g;

/** The closing tag of an envelope. */
export function childReportClose(tag: ChildReportTag): string {
  return `</${tag}>`;
}

/** A cheap pre-check: false only when `text` cannot hold a child report. */
export function mayHoldChildReport(text: string): boolean {
  return text.includes("<subagent") || text.includes("<background-result");
}

/** The opening-tag finder of one text: the first `>` at or after a position is found once for increasing positions. */
function openingScanner(text: string): (from: number, child?: string) => ChildReportOpening | undefined {
  const lastGt = text.lastIndexOf(">");
  let gtFrom = 0;
  let gtAt = -2;
  const firstGtFrom = (from: number): number => {
    if (from > lastGt) return -1;
    if (gtFrom <= from && gtAt >= from) return gtAt;
    gtFrom = from;
    gtAt = text.indexOf(">", from);
    return gtAt;
  };
  const strict = new RegExp(STRICT_OPENING.source, "y");
  const openingAt = (index: number, tag: ChildReportTag): ChildReportOpening | undefined => {
    const nameEnd = index + 1 + tag.length;
    let attributes: string;
    let bodyStart: number;
    let terminated = true;
    const gt = firstGtFrom(nameEnd);
    strict.lastIndex = index;
    const match = gt < 0 ? null : strict.exec(text);
    if (match !== null) {
      attributes = match[2] ?? "";
      bodyStart = index + match[0].length;
    } else if (gt >= 0) {
      attributes = text.slice(nameEnd, gt);
      bodyStart = gt + 1;
    } else {
      // No `>` anywhere after the name: a cut-off tag. Its attributes are read up to the next `<`, best effort.
      const lt = text.indexOf("<", nameEnd);
      attributes = text.slice(nameEnd, lt < 0 ? text.length : lt);
      bodyStart = text.length;
      terminated = false;
    }
    const values = new Map<string, string>();
    for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
      if (name !== undefined && value !== undefined && !values.has(name)) values.set(name, value);
    }
    const child = values.get("sessionID");
    if (child === undefined || child === "") return undefined;
    const kind = values.get("kind");
    if (tag === "background-result" && kind !== undefined && kind !== "subagent") return undefined;
    return { index, bodyStart, terminated, tag, child, state: values.get("state"), description: values.get("description") };
  };
  const candidates = new RegExp(CANDIDATE.source, "g");
  return (from, child) => {
    candidates.lastIndex = from;
    // A candidate that is no report, or another child's, is passed by one tag name only (never by its body), so a report
    // that sits inside it is still found.
    for (let match = candidates.exec(text); match !== null; match = candidates.exec(text)) {
      const opening = openingAt(match.index, match[1] === "background-result" ? "background-result" : "subagent");
      if (opening !== undefined && (child === undefined || opening.child === child)) return opening;
    }
    return undefined;
  };
}

/**
 * The first child-report opening tag at or after `from` (of `child` only, when given). A tag with no `>` after it is returned
 * with `terminated: false` (the held matcher cuts through the end of the text from it).
 */
export function nextChildReportOpening(text: string, from = 0, child?: string): ChildReportOpening | undefined {
  if (!mayHoldChildReport(text)) return undefined;
  return openingScanner(text)(from, child);
}

function reportOf(text: string, opening: ChildReportOpening, at: number): ChildReport {
  const close = childReportClose(opening.tag);
  const closed = at >= opening.bodyStart;
  const end = closed ? at + close.length : text.length;
  return { ...opening, body: text.slice(opening.bodyStart, closed ? at : text.length), end, closed };
}

/**
 * The child report a text STARTS with (after leading blanks), or undefined. It is the whole message the host writes for one
 * report (C2): its body runs to the LAST closing tag of its own envelope in the text, so a closing tag and a further report
 * forged inside the child's text neither end it early nor add a report.
 */
export function leadingChildReport(text: string): ChildReport | undefined {
  const start = text.length - text.trimStart().length;
  if (!text.startsWith("<subagent", start) && !text.startsWith("<background-result", start)) return undefined;
  const opening = openingScanner(text)(start);
  if (opening === undefined || opening.index !== start || !opening.terminated) return undefined;
  return reportOf(text, opening, text.lastIndexOf(childReportClose(opening.tag)));
}

/** Every child report of `text`, in order; a text that starts with one is that one report ({@link leadingChildReport}). */
export function childReports(text: string): ChildReport[] {
  if (!mayHoldChildReport(text)) return [];
  const leading = leadingChildReport(text);
  if (leading !== undefined) return [leading];
  const found: ChildReport[] = [];
  const next = openingScanner(text);
  let from = 0;
  for (let opening = next(from); opening !== undefined; opening = next(from)) {
    // Not terminated: no `>` follows, so no later tag is terminated either. A cut-off tag has no body.
    if (!opening.terminated) break;
    const report = reportOf(text, opening, text.indexOf(childReportClose(opening.tag), opening.bodyStart));
    found.push(report);
    from = report.end;
  }
  return found;
}

/**
 * `text` with the body of every child report replaced by what `rewrite` returns for it (`undefined` keeps it). The tags stay,
 * and so does everything outside the elements. Pure.
 */
export function rewriteChildReportBodies(text: string, rewrite: (report: ChildReport) => string | undefined): string {
  let out = "";
  let last = 0;
  for (const report of childReports(text)) {
    const next = rewrite(report);
    if (next === undefined || next === report.body) continue;
    out += text.slice(last, report.bodyStart) + next;
    last = report.bodyStart + report.body.length;
  }
  return last === 0 ? text : out + text.slice(last);
}
