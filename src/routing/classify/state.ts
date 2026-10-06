/**
 * D14 classifier state — the ONLY text a model backend may send off the machine.
 * Design section 3 of `docs/qa/cost-aware-routing/phase-1.2.md`.
 *
 * Contents, in order: a one-line description, the first `[acceptance]` block
 * (whole or omitted, never cut), the prompt head with code blocks replaced by a
 * placeholder. Secrets are scrubbed before anything is bounded, `<<<` / `>>>`
 * are neutralised so the state cannot close the backend's delimiter, and the
 * whole text is at most `maxStateChars` long. Nothing else is ever read: no
 * file contents, no system prompt, no session history.
 */

import { replaceFences, replaceIndentedBlocks } from "./fences";
import { scrubState } from "./scrub";
import { collapseLongRuns } from "./text";
import {
  ACCEPTANCE_BLOCK_RE,
  CODE_BLOCK_PLACEHOLDER,
  DIRECTIVE_LINE_RES,
  RULES_MAX_CHARS,
  STATE_DESCRIPTION_MAX_CHARS,
  type ClassifierState,
} from "./types";

/** Used when `maxStateChars` is not a finite number. */
const FALLBACK_STATE_CHARS = 200;
/** Upper bound of the budget; a smaller configured value is honoured as given. */
const MAX_STATE_CHARS = 20_000;
const TASK_HEADER = "Task:\n";
const OPEN_TAG = "[acceptance]";
const CLOSE_TAG = "[/acceptance]";

const ACCEPTANCE_ALL_RE = new RegExp(ACCEPTANCE_BLOCK_RE.source, "gi");

/** Only the upper bound clamps (QA-1.2-18): an operator who asks for 100 characters gets at most 100. */
function budgetOf(value: number): number {
  if (!Number.isFinite(value)) return FALLBACK_STATE_CHARS;
  return Math.min(MAX_STATE_CHARS, Math.max(0, Math.floor(value)));
}

/** Neutralise the delimiter runs so state text can never close or forge a block. */
function neutralize(text: string): string {
  return text.replaceAll("<<<", "\u2039\u2039\u2039").replaceAll(">>>", "\u203a\u203a\u203a");
}

function dropDirectiveLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !DIRECTIVE_LINE_RES.some((re) => re.test(line)))
    .join("\n");
}

/**
 * The first `[acceptance]` block and the text without any block, found with
 * `indexOf` over the WHOLE prompt (an acceptance block conventionally sits at
 * the end, past where the head of a long prompt is cut) in linear time.
 */
function splitAcceptance(text: string): { readonly first: string | null; readonly rest: string } {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) {
    // Case folding changed the length (rare Unicode): offsets are unusable, fall back to the bounded regex.
    const head = text.slice(0, RULES_MAX_CHARS);
    const match = ACCEPTANCE_BLOCK_RE.exec(head);
    return { first: match === null ? null : match[0], rest: head.replace(ACCEPTANCE_ALL_RE, "") };
  }
  let first: string | null = null;
  const parts: string[] = [];
  let pos = 0;
  for (;;) {
    const open = lower.indexOf(OPEN_TAG, pos);
    if (open === -1) break;
    const close = lower.indexOf(CLOSE_TAG, open + OPEN_TAG.length);
    if (close === -1) break; // an unclosed tag is ordinary text
    const end = close + CLOSE_TAG.length;
    if (first === null) first = text.slice(open, end);
    parts.push(text.slice(pos, open));
    pos = end;
  }
  parts.push(text.slice(pos));
  return { first, rest: parts.join("") };
}

export function buildClassifierState(
  input: { description?: string; prompt: string },
  maxStateChars: number,
): ClassifierState {
  const budget = budgetOf(maxStateChars);

  // Nothing below runs a regex over more than RULES_MAX_CHARS characters of the prompt (QA-1.2-11),
  // except the linear indexOf scan that keeps a trailing acceptance block reachable.
  const { first, rest } = splitAcceptance(String(input.prompt ?? ""));
  const acceptanceRaw =
    first === null || first.length > RULES_MAX_CHARS ? null : dropDirectiveLines(first);
  const bodyRaw = collapseLongRuns(
    replaceIndentedBlocks(
      replaceFences(dropDirectiveLines(rest.slice(0, RULES_MAX_CHARS)), CODE_BLOCK_PLACEHOLDER),
      CODE_BLOCK_PLACEHOLDER,
    )
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    "[long token omitted]",
  );

  // Scrub first, then bound: a secret cut in half by the bound would no longer match a token shape.
  const description = neutralize(
    scrubState(String(input.description ?? "").slice(0, RULES_MAX_CHARS).replace(/\s+/g, " ").trim()),
  ).slice(0, STATE_DESCRIPTION_MAX_CHARS);
  const acceptance = acceptanceRaw === null ? null : neutralize(scrubState(acceptanceRaw));
  const body = neutralize(scrubState(bodyRaw));

  const parts: string[] = [];
  let used = 0;
  if (description !== "") {
    const part = "Description: " + description;
    parts.push(part);
    used += part.length + 1;
  }
  let acceptanceIncluded = false;
  if (acceptance !== null && acceptance.length <= Math.floor((budget - used) / 2)) {
    const part = "Acceptance:\n" + acceptance;
    parts.push(part);
    used += part.length + 1;
    acceptanceIncluded = true;
  }
  const room = budget - used - TASK_HEADER.length;
  if (room > 0 && body !== "") parts.push(TASK_HEADER + body.slice(0, room));
  const truncated = body.length > Math.max(room, 0);

  const text = parts.join("\n").slice(0, budget);
  const state = { text, maxStateChars: budget, truncated, acceptanceIncluded };
  // The only cast that creates the brand: every ClassifierState comes from here.
  return state as unknown as ClassifierState;
}