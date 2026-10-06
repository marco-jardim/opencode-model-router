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

import { scrubText } from "../../guard/scrub";
import {
  ACCEPTANCE_BLOCK_RE,
  CODE_BLOCK_PLACEHOLDER,
  DIRECTIVE_LINE_RES,
  FENCED_CODE_RE,
  STATE_DESCRIPTION_MAX_CHARS,
  type ClassifierState,
} from "./types";

const MIN_STATE_CHARS = 200;
const MAX_STATE_CHARS = 20_000;
const TASK_HEADER = "Task:\n";

const ACCEPTANCE_ALL_RE = new RegExp(ACCEPTANCE_BLOCK_RE.source, "gi");
const FENCED_ALL_RE = new RegExp(FENCED_CODE_RE.source, "gm");

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Neutralise the delimiter runs so state text can never close or forge a block. */
function neutralize(text: string): string {
  return text.replaceAll("<<<", "\u2039\u2039\u2039").replaceAll(">>>", "\u203a\u203a\u203a");
}

function dropDirectiveLines(prompt: string): string {
  return prompt
    .split(/\r?\n/)
    .filter((line) => !DIRECTIVE_LINE_RES.some((re) => re.test(line)))
    .join("\n");
}

export function buildClassifierState(
  input: { description?: string; prompt: string },
  maxStateChars: number,
): ClassifierState {
  const budget = clamp(maxStateChars, MIN_STATE_CHARS, MAX_STATE_CHARS);

  const prompt = dropDirectiveLines(String(input.prompt ?? ""));
  const acceptanceMatch = ACCEPTANCE_BLOCK_RE.exec(prompt);
  const acceptanceRaw = acceptanceMatch === null ? null : acceptanceMatch[0];
  const bodyRaw = prompt
    .replace(ACCEPTANCE_ALL_RE, "")
    .replace(FENCED_ALL_RE, CODE_BLOCK_PLACEHOLDER)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Scrub first, then bound: a secret cut in half by the bound would no longer match a token shape.
  const description = neutralize(
    scrubText(String(input.description ?? "").replace(/\s+/g, " ").trim()),
  ).slice(0, STATE_DESCRIPTION_MAX_CHARS);
  const acceptance = acceptanceRaw === null ? null : neutralize(scrubText(acceptanceRaw));
  const body = neutralize(scrubText(bodyRaw));

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
