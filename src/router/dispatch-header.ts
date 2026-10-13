import { parseRouteLine } from "../routing/classify/route-line";
import { displaySafe } from "../routing/roles/read-set";

/** First characters of every router dispatch header (index.ts never adds a second one). */
export const DISPATCH_HEADER_PREFIX = "[router] You are @";

/** What index.ts (tiers) and the role dispatch path put between a header and the orchestrator's prompt. */
export const DISPATCH_HEADER_SEPARATOR = "\n\n---\n\n";

/** The header's last paragraph: the end of a header whose separator is missing. */
const FALSE_REFUSAL_PARAGRAPH = "A hand-back with zero tool calls is recorded as a false refusal.";

/**
 * Mechanical dispatch guidance, independent of provider tool vocabulary.
 * Tier identity prevents delegates routing their assignment back to another tier.
 * The directory paragraph prevents refusal of a valid path when a stale environment
 * block advertises a directory that does not exist.
 * Tool-schema authority prevents zero-call returns such as `ESCALATE: ... the
 * available tools here are not the Read/Grep/Glob/Bash tools described in the request`.
 * Empty-result guidance prevents declaring tools broken after a gitignore-filtered
 * search returns "No files found".
 * The budget paragraph makes the cap explicit and prevents halting when the
 * redundancy detector flags a legitimate non-overlapping second read of a file.
 * The final notice calls out the zero-tool-call false refusals directly.
 *
 * `root` (plan §2.2, T1.5.3a): the dispatch's work root — the route line's `root=`
 * (`routeLineRoot`) — named by the working-directory paragraph instead of the
 * project directory. Absent or empty: the header is byte-identical to before.
 *
 * Cross-repo (`docs/design/cross-repo.md` §5, P1.7), all optional and inert when absent or empty:
 * `location` names the working directory's repository, branch and head; `workingSet` and `readParents` add one paragraph
 * listing the session's repositories and where a role may read.
 */
export function buildDispatchHeader(input: {
  tier: string;
  cap: number | "none";
  projectDirectory: string | undefined;
  root?: string | null;
  location?: { readonly name: string; readonly branch: string | null; readonly head: string | null };
  workingSet?: readonly { readonly name: string; readonly branch: string | null }[];
  readParents?: readonly string[];
}): string {
  const paragraphs = [
    `${DISPATCH_HEADER_PREFIX}${input.tier}. Execute this dispatch yourself; do not route it to another tier, and do not ask to be re-dispatched.`,
  ];
  const directory = input.root || input.projectDirectory;
  if (directory) {
    paragraphs.push(...locationParagraphs(directory, {
      location: input.location,
      workingSet: input.workingSet,
      readParents: input.readParents,
      verb: "read or write",
    }));
  }
  paragraphs.push(
    'Tool names mentioned in this dispatch are descriptive and vary by provider; your own tool schema is the authority on what you can do. Never refuse or hand back work because a named tool looks unfamiliar or missing — attempt it, and if you cannot finish, name the specific step that failed.',
    'An empty result is a result. Search tools honour .gitignore, so a "no matches" answer inside an ignored path means the filter applied, not that your tools are broken; use a shell ripgrep with --no-ignore there before concluding anything is absent.',
    `${input.cap === "none" ? "Read-only budget: uncapped for this dispatch." : `Read-only budget: ${input.cap} calls.`} The runtime appends [cap: N/MAX] and [⚠ REDUNDANT] to results. Reading a different region of a file you have already opened is NOT a redundant read.`,
    // The parser takes the first directive: pin the resolved budget before the
    // instructional CAP:none example, which must not override the real dispatch.
    `CAP:${input.cap}`,
    'To change the budget, put CAP:N or CAP:none accompanied by a reason: line in the dispatch.',
    FALSE_REFUSAL_PARAGRAPH,
  );
  return paragraphs.join("\n\n");
}

type HeaderLocation = { readonly name: string; readonly branch: string | null; readonly head: string | null };
type HeaderRepository = { readonly name: string; readonly branch: string | null };

/**
 * The working-directory paragraph and, with a working set or read parents, the repositories paragraph. Shared by the tier
 * header and the role header; `verb` completes "do not ask permission to <verb> inside it". Callers escape what they pass.
 */
function locationParagraphs(
  directory: string,
  input: {
    location?: HeaderLocation;
    workingSet?: readonly HeaderRepository[];
    readParents?: readonly string[];
    verb: string;
    /** A read-only role: the repositories paragraph carries no edit clause. Absent: the tier wording, byte-identical. */
    readOnly?: boolean;
  },
): string[] {
  const where = input.location === undefined
    ? ""
    : ` (repository ${input.location.name}, branch ${input.location.branch ?? "detached"}${input.location.head ? ` at ${input.location.head.slice(0, 7)}` : ""})`;
  const paragraphs = [`Working directory: ${directory}${where}. You are already there — do not ask permission to ${input.verb} inside it.`];
  const set = input.workingSet ?? [];
  const parents = input.readParents ?? [];
  if (set.length > 0 || parents.length > 0) {
    const listed = set.length > 0
      ? `Repositories in this session: ${set.map((entry) => `${entry.name} (${entry.branch ?? "detached"})`).join(", ")}. `
      : "";
    const rest = input.readOnly === true
      ? (parents.length > 0
        ? `You may read any repository below ${parents.join(", ")}.`
        : "You read only in your working directory.")
      : parents.length > 0
        ? `You may read any repository below ${parents.join(", ")}; you edit and run only in your working directory.`
        : "You edit and run only in your working directory.";
    paragraphs.push(`${listed}${rest}`.trimEnd());
  }
  return paragraphs;
}

/**
 * The header of a role dispatch (OD6: a role delegate is told its work root). Ends with DISPATCH_HEADER_SEPARATOR so
 * stripDispatchHeader removes it before DoD inference (E8). No cap, verify directive, route line or nonce: those belong to
 * the tier header and the protocol. Every name, branch and path goes through displaySafe, so a newline, a bracket or a
 * `\n\n---\n\n` in a directory, repository or branch name can neither end the header early nor forge a line.
 * `edits` false (a read-only role): "do not ask permission to read inside it". `exactResume`: the head may be stale, so the
 * head clause is left out (as for a null head). A read-only role's repositories paragraph carries no edit clause ("You may
 * read any repository below <parents>."): it cannot edit or run anywhere, so telling it where it may is noise. A caller that
 * wants only the work root (`dispatchHeader: false` with a `root=`/`repo=` work root) passes no `workingSet` / `readParents`.
 */
export function buildRoleDispatchHeader(input: {
  agent: string;
  workRoot: string;
  edits: boolean;
  location?: HeaderLocation;
  workingSet?: readonly HeaderRepository[];
  readParents?: readonly string[];
  exactResume?: boolean;
}): string {
  const safeBranch = (branch: string | null): string | null => (branch === null ? null : displaySafe(branch));
  const location = input.location === undefined
    ? undefined
    : {
        name: displaySafe(input.location.name),
        branch: safeBranch(input.location.branch),
        head: input.exactResume || input.location.head === null ? null : displaySafe(input.location.head),
      };
  const paragraphs = [
    `${DISPATCH_HEADER_PREFIX}${displaySafe(input.agent)}. Execute this dispatch yourself.`,
    ...locationParagraphs(displaySafe(input.workRoot), {
      location,
      workingSet: input.workingSet?.map((entry) => ({ name: displaySafe(entry.name), branch: safeBranch(entry.branch) })),
      readParents: input.readParents?.map((parent) => displaySafe(parent)),
      verb: input.edits ? "read or write" : "read",
      ...(input.edits ? {} : { readOnly: true }),
    }),
  ];
  return `${paragraphs.join("\n\n")}${DISPATCH_HEADER_SEPARATOR}`;
}

/**
 * The work root a dispatch prompt names on its first-line route line (`root=`,
 * an absolute path validated by the parser), or undefined. The caller passes it
 * to buildDispatchHeader as `root`.
 */
export function routeLineRoot(prompt: string): string | undefined {
  return parseRouteLine(prompt, { positions: "first" }).line?.root;
}

/**
 * The orchestrator's prompt without the router dispatch header (R6/P-15): when
 * the text starts with DISPATCH_HEADER_PREFIX, everything up to and including the
 * first DISPATCH_HEADER_SEPARATOR is dropped. The prefix and the separator carry
 * no v1 tool vocabulary, so the v2-translated header (v2Instructions) strips the
 * same way. Without a separator, the header ends at its last paragraph; a text
 * with neither is returned unchanged.
 */
export function stripDispatchHeader(prompt: string): string {
  if (!prompt.startsWith(DISPATCH_HEADER_PREFIX)) return prompt;
  const separator = prompt.indexOf(DISPATCH_HEADER_SEPARATOR);
  if (separator !== -1) return prompt.slice(separator + DISPATCH_HEADER_SEPARATOR.length);
  const last = prompt.indexOf(FALSE_REFUSAL_PARAGRAPH);
  return last === -1 ? prompt : prompt.slice(last + FALSE_REFUSAL_PARAGRAPH.length).replace(/^\s+/, "");
}
