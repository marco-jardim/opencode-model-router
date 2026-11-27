/**
 * Readers of a v2 child's own history (`ctx.session.context`), shared by the adapter (`v2-hooks.ts`) and the native child
 * runner (`v2-client.ts`). v2 only: OpenCode v1 never loads this module.
 */

/** The text of one session-context message: its `text`, else its text parts (`content` or `parts`) joined. */
export function messageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  const parts = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : undefined;
  if (parts === undefined) return undefined;
  const texts = parts.flatMap((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
    && typeof (part as Record<string, unknown>).text === "string" ? [(part as Record<string, unknown>).text as string] : []);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/**
 * The child's last assistant message of its current turn (after its newest user prompt, DF-1-4): walking back from the newest
 * entry, the first assistant entry with text; the newest user prompt ends the walk, as an answer before it belongs to an
 * earlier turn (a resume). The host's context entries are discriminated by `type` ("user" | "assistant" | "synthetic", see the
 * instruction filter in the system hook); the model-facing messages of the context hook use `role`. Both name the assistant
 * the same way. `failed` (#167): between that answer and the newest entry, an assistant entry carries an error, or the run's
 * end marker (`{ type: "idle", outcome }`) has an outcome other than "succeeded" ("failed" | "interrupted"): the turn did not
 * end in success and its text may be partial. An end marker without an outcome changes nothing.
 *
 * `final` (#167, the native runner's waited result; QA-2.1-18: text alone is not an end): the NEWEST assistant entry of the
 * turn decides. It is the answer only when it has text and ended its step (`assistantStepCompleted`); otherwise there is no
 * answer, never an earlier step's text (a draft before a tool call). Its `finish: "error"` also fails the reply.
 *
 * `after` (#167, a resume): `id` is the history's newest entry before this run (`newestEntryId`). Only entries after it count,
 * and the answer must follow a user entry, also after it, whose text contains this run's `prompt` (trimmed; the host may put
 * its preamble line before it): the host adds the prompt to the history only when the run takes it, and a resume often
 * repeats the previous prompt, so the marker tells this run's entry from an identical earlier one. A run end (`idle`) between
 * the newest such entry and the answer means the answer is a later run's. Without such an entry, with a run end between, or
 * when the marker is no longer in the history (compacted, see `historyHasEntry`), there is no answer of this run.
 */
export function lastAssistantReply(
  history: unknown, options: { final?: boolean; after?: { id: string; prompt: string } } = {},
): { text: string; failed: boolean } | undefined {
  const messages: readonly unknown[] = Array.isArray(history) ? history : [];
  const { after, final = false } = options;
  let start = 0;
  if (after !== undefined) {
    const marker = entryIndex(messages, after.id);
    if (marker < 0) return undefined;
    start = marker + 1;
  }
  const isUser = (message: unknown): boolean => {
    const m = message as { type?: unknown; role?: unknown } | null | undefined;
    return m?.type === "user" || m?.role === "user";
  };
  const normalized = (text: string): string => text.replace(/\r\n/g, "\n").trim();
  const ownPrompt = after === undefined ? "" : normalized(after.prompt);
  const isOwnPrompt = (message: unknown): boolean =>
    isUser(message) && ownPrompt !== "" && normalized(messageText(message) ?? "").includes(ownPrompt);
  let failed = false;
  for (let index = messages.length - 1; index >= start; index--) {
    const message = messages[index] as {
      type?: unknown; role?: unknown; outcome?: unknown; error?: unknown; finish?: unknown; info?: { error?: unknown; finish?: unknown };
    } | undefined;
    if (message?.type === "idle" && message.outcome !== undefined && message.outcome !== null && message.outcome !== "succeeded") {
      failed = true;
    }
    if (message?.type === "assistant" || message?.role === "assistant") {
      const error = message.error ?? message.info?.error;
      if (error !== undefined && error !== null && error !== false) failed = true;
      if (final && (message.finish ?? message.info?.finish) === "error") failed = true;
      const text = messageText(message);
      if (final && (text === undefined || !assistantStepCompleted(message))) return undefined;
      if (text !== undefined) {
        if (after !== undefined) {
          // The newest own prompt before the answer; a run end (`idle`, any outcome) between them means the answer belongs to
          // a later run than ours (ours ended, then another prompt was taken), so it is not this run's answer.
          let own = index - 1;
          while (own >= start && !isOwnPrompt(messages[own])) own--;
          if (own < start) return undefined;
          if (messages.slice(own + 1, index).some((m) => (m as { type?: unknown } | null | undefined)?.type === "idle")) return undefined;
        }
        return { text, failed };
      }
    }
    if (isUser(message)) break;
  }
  return undefined;
}

/**
 * QA-2.1-18: whether an assistant entry of a child's history ended its step (top level or under `info`): a finish reason other
 * than a tool-call continuation, or a completed time; and no tool part still `pending` or `running`. A step cut mid-stream has
 * none of these, and a `tool-calls` finish means the child meant to go on: neither is an end, whatever text it already has.
 */
export function assistantStepCompleted(message: unknown): boolean {
  if (message === null || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  const info = m.info !== null && typeof m.info === "object" ? m.info as Record<string, unknown> : undefined;
  const parts: readonly unknown[] = Array.isArray(m.content) ? m.content : Array.isArray(m.parts) ? m.parts : [];
  const toolOpen = parts.some((part) => {
    if (part === null || typeof part !== "object" || (part as Record<string, unknown>).type !== "tool") return false;
    const state = (part as Record<string, unknown>).state;
    const status = state !== null && typeof state === "object" ? (state as Record<string, unknown>).status : state ?? (part as Record<string, unknown>).status;
    // The v2 tool state is `streaming` | `running` | `completed` | `error` (`pending` is the v1 name of the first).
    return status === "streaming" || status === "pending" || status === "running";
  });
  if (toolOpen) return false;
  const finish = m.finish ?? info?.finish;
  if (typeof finish === "string" && finish !== "") return finish !== "tool-calls" && finish !== "unknown";
  const time = m.time ?? info?.time;
  // `time.completed` is set once the step ended: epoch millis on the wire, a DateTime once decoded; either counts.
  const completed = time !== null && typeof time === "object" ? (time as Record<string, unknown>).completed : undefined;
  return completed !== undefined && completed !== null && completed !== "" && completed !== false;
}

/** #167: the id of a history's newest entry (every v2 context entry carries one), or undefined when it has none. */
export function newestEntryId(history: unknown): string | undefined {
  return Array.isArray(history) && history.length > 0 ? entryId(history[history.length - 1]) : undefined;
}

/** #167: whether the history still holds the entry with this id (a resume's marker; gone after a compaction). */
export function historyHasEntry(history: unknown, id: string): boolean {
  return Array.isArray(history) && entryIndex(history, id) >= 0;
}

function entryIndex(messages: readonly unknown[], id: string): number {
  let index = messages.length - 1;
  while (index >= 0 && entryId(messages[index]) !== id) index--;
  return index;
}

function entryId(message: unknown): string | undefined {
  const id = message !== null && typeof message === "object" ? (message as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : undefined;
}
