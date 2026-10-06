/**
 * Text hygiene shared by the rules and the D14 state builder.
 */

/** A single run of this many path/word characters is a blob (base64, minified code, a hostile string), never prose. */
// Anchored at the start of a run (the lookbehind): an unanchored `{200,}` rescans a 199-character run from
// every offset, which is itself quadratic.
const LONG_RUN_RE = /(?<![\w./\\@+-])[\w./\\@+-]{200,}/g;
const LONG_SPACE_RE = /(?<!\s)\s{200,}/g;

/**
 * Collapse runs that make the shape-gate and enumeration regexes of
 * `classifyTrivial` (written for 240-character prompts) quadratic on a long
 * prompt: runs of 200+ `[\w./\\@+-]` characters become one `placeholder` word,
 * runs of 200+ whitespace characters become a blank line (QA-1.2-7). Linear.
 */
export function collapseLongRuns(text: string, placeholder = "longrun"): string {
  if (text.length < 200) return text;
  return text.replace(LONG_RUN_RE, placeholder).replace(LONG_SPACE_RE, "\n\n");
}
