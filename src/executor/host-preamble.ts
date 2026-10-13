// QA-4.2-1: the v2 host's native-subagent preamble, shared by the v2 adapter (M41 launch-header matching) and recovery
// (R1 launch-header evidence). A leaf module with no imports, so both can use it without an import cycle.

/**
 * QA-3.1-16: the v2 host puts this exact line (ending in "\n", or "\r\n") before the first user message of every native-subagent
 * child (recorded in docs/qa/role-tier/evidence/roots-handoffs.json, ladder.json), so a launcher prompt reaches the child either
 * at offset 0 or right after this one line; no other leading text counts.
 */
export const HOST_SUBAGENT_PREAMBLE = "You are a subagent spawned by another session.";

/** The text after the host's one preamble line when it starts with exactly that line, else the text unchanged (QA-3.1-16). */
export function withoutHostPreamble(text: string): string {
  for (const eol of ["\n", "\r\n"]) {
    if (text.startsWith(HOST_SUBAGENT_PREAMBLE + eol)) return text.slice(HOST_SUBAGENT_PREAMBLE.length + eol.length);
  }
  return text;
}
