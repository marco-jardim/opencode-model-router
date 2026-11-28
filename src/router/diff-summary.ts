/**
 * #108 slice 1: the stat-first `router_git_diff` of OpenCode v2 roles mode (role agents only; tiers mode, the root session
 * and OpenCode v1 keep the plain patch). Pure helpers: the git calls are in git-tools.ts (`inspectGit` with `summary`).
 *
 * - A `patch`/`cached` diff without `path` whose patch exceeds {@link DIFF_SUMMARY_THRESHOLD_BYTES} is answered with one
 *   line per file (`+added -removed`), never hunks; `path` (or `mode: "stat"` / `"name-only"`) gives the usual output.
 * - Lockfiles, snapshots, and goldens and fixtures that are not code or tests ({@link excludedKind}, by a file's new path)
 *   are always listed as `content excluded (<kind>, +a/-b)` instead of their hunks, even in a small patch: their presence
 *   is never dropped, their content is fetched with `path`.
 * - Sensitive files (sensitive-paths.ts) appear in a summary by name only, as `sensitive: content withheld`.
 * - Every list is bounded to {@link SUMMARY_MAX_BYTES} and gives the exact number of entries it leaves out, if any; in a
 *   summary, notes of at most 1 KiB (git's warnings, the skipped-links notice) may follow that line.
 * - No content hash (slice 1).
 */

/** A `patch`/`cached` diff without `path` whose patch is larger than this many bytes is summarized. */
export const DIFF_SUMMARY_THRESHOLD_BYTES = 8 * 1024;
/** Bound of a summary, and of the excluded-content list after a patch, in UTF-8 bytes. */
export const SUMMARY_MAX_BYTES = 4096;
/** Bound of the notes (git's warnings, skipped linked directories) a summary carries, inside {@link SUMMARY_MAX_BYTES}. */
const FOOTER_MAX_BYTES = 1024;
/** Room kept for the last line (the omitted count). */
const OMITTED_RESERVE_BYTES = 240;

/** Lockfiles, by exact file name at any depth. */
export const LOCKFILE_NAMES: readonly string[] = Object.freeze([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock",
  "poetry.lock", "uv.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock", "go.sum",
]);

export type ExcludedKind = "lockfile" | "snapshot" | "fixture" | "golden";

/**
 * File extensions of code (compared case-insensitively). A golden or fixture with one of these, or a test file
 * ({@link TEST_FILE_RE}), is never excluded: code and tests are always shown, wherever they live.
 */
export const CODE_EXTENSIONS: readonly string[] = Object.freeze([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".pyi", ".go", ".rs", ".java", ".kt",
  ".kts", ".scala", ".groovy", ".rb", ".php", ".cs", ".fs", ".vb", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm",
  ".swift", ".dart", ".lua", ".pl", ".pm", ".r", ".ex", ".exs", ".erl", ".clj", ".zig", ".nim", ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".psm1", ".psd1", ".bat", ".cmd",
]);
/** A test file by name: `<name>.test.<ext>` or `<name>.spec.<ext>`. */
export const TEST_FILE_RE = /\.(?:test|spec)\.[^./]+$/i;

/** A file name that is code or a test ({@link CODE_EXTENSIONS}, {@link TEST_FILE_RE}). */
function codeOrTest(name: string): boolean {
  const lower = name.toLowerCase();
  return TEST_FILE_RE.test(name) || CODE_EXTENSIONS.some(extension => lower.endsWith(extension));
}

/**
 * The fixed list (#108 P10) of paths whose content a role's `router_git_diff` leaves out by default, for a
 * repository-relative, `/`-separated path: a lockfile ({@link LOCKFILE_NAMES}), a snapshot (`**\/__snapshots__/**`,
 * `*.snap` at any depth), a golden (`test/golden/**`) or a fixture (`**\/fixtures/**`). A golden or fixture that is code or
 * a test ({@link CODE_EXTENSIONS}, {@link TEST_FILE_RE}) is not excluded. Undefined for any other path.
 */
export function excludedKind(path: string): ExcludedKind | undefined {
  const segments = path.split("/").filter(segment => segment !== "");
  const name = segments.at(-1) ?? "";
  const directories = segments.slice(0, -1);
  if (LOCKFILE_NAMES.includes(name)) return "lockfile";
  if (directories.includes("__snapshots__") || name.endsWith(".snap")) return "snapshot";
  if (codeOrTest(name)) return undefined;
  if (segments.length > 2 && segments[0] === "test" && segments[1] === "golden") return "golden";
  if (directories.includes("fixtures")) return "fixture";
  return undefined;
}

/** One record of `git diff --numstat -z`: the (new) path, the old path of a rename or copy, and the line counts (absent: binary). */
export interface NumstatEntry {
  readonly path: string;
  readonly from?: string;
  readonly added?: number;
  readonly removed?: number;
}

/** Parse `git diff --numstat -z`: `<added>\t<removed>\t<path>\0`, or `<added>\t<removed>\t\0<from>\0<to>\0` for a rename. */
export function parseNumstat(raw: string): NumstatEntry[] {
  const fields = raw.split("\0");
  const entries: NumstatEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const record = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(fields[index]!);
    if (record === null) continue;
    const counts = record[1] === "-" || record[2] === "-" ? {} : { added: Number(record[1]), removed: Number(record[2]) };
    if (record[3] !== "") {
      entries.push({ path: record[3]!, ...counts });
      continue;
    }
    const from = fields[index + 1];
    const to = fields[index + 2];
    index += 2;
    if (from && to) entries.push({ path: to, from, ...counts });
  }
  return entries;
}

/**
 * The excluded kind of an entry, by its new path only: a file renamed out of a fixture directory into the code is shown, one
 * renamed into it is listed (both its names are then left out of the patch).
 */
export function entryExcludedKind(entry: NumstatEntry): ExcludedKind | undefined {
  return excludedKind(entry.path);
}

/** An entry of a summary: a changed file, a file whose content is excluded, or a sensitive file (name only). */
export interface SummaryEntry extends NumstatEntry {
  readonly excluded?: ExcludedKind;
  readonly sensitive?: boolean;
}

/** How a path is shown (git's quoting, credential redaction): supplied by git-tools.ts. */
export type PathDisplay = (path: string) => string;

/** One line of a summary or of the excluded-content list. A sensitive entry never shows its counts. */
export function summaryLine(entry: SummaryEntry, display: PathDisplay): string {
  const name = entry.from === undefined ? display(entry.path) : `${display(entry.from)} => ${display(entry.path)}`;
  if (entry.sensitive === true) return `${name} | sensitive: content withheld`;
  if (entry.excluded !== undefined) {
    return `${name} | content excluded (${entry.excluded}, ${entry.added === undefined ? "binary" : `+${entry.added}/-${entry.removed ?? 0}`})`;
  }
  return `${name} | ${entry.added === undefined ? "binary" : `+${entry.added} -${entry.removed ?? 0}`}`;
}

const bytes = (text: string) => Buffer.byteLength(text);

/** `text` cut to at most `max` UTF-8 bytes at a line end (or, for one long line, a character), marked when cut. */
function boundedText(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const marker = "\n[router_git] notes cut\n";
  let kept = Buffer.from(text).subarray(0, Math.max(0, max - bytes(marker))).toString("utf8").replace(/\uFFFD+$/, "");
  const newline = kept.lastIndexOf("\n");
  if (newline > 0) kept = kept.slice(0, newline);
  return `${kept}${marker}`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The category counts of `entries`: `2 changed, 1 content excluded, 1 sensitive` (empty categories left out). */
function categories(entries: readonly SummaryEntry[]): string {
  const sensitive = entries.filter(entry => entry.sensitive === true).length;
  const excluded = entries.filter(entry => entry.sensitive !== true && entry.excluded !== undefined).length;
  const changed = entries.length - sensitive - excluded;
  return [changed > 0 ? `${changed} changed` : "", excluded > 0 ? `${excluded} content excluded` : "", sensitive > 0 ? `${sensitive} sensitive` : ""]
    .filter(Boolean).join(", ");
}

/**
 * Lines of `entries` in order after `head`, while the whole text (with the omitted-count line and `footer`) stays within
 * `max` bytes. The first entry that does not fit ends the list; the omitted line gives the exact count of the rest.
 */
function boundedList(head: string, entries: readonly SummaryEntry[], display: PathDisplay, footer: string, max: number,
  omitted: (rest: readonly SummaryEntry[]) => string): string {
  const notes = footer === "" ? "" : boundedText(footer.endsWith("\n") ? footer : `${footer}\n`, FOOTER_MAX_BYTES);
  let text = `${head}\n`;
  let shown = 0;
  for (const entry of entries) {
    const line = `${summaryLine(entry, display)}\n`;
    if (bytes(text) + bytes(line) + OMITTED_RESERVE_BYTES + bytes(notes) > max) break;
    text += line;
    shown++;
  }
  const rest = entries.slice(shown);
  if (rest.length > 0) text += `${omitted(rest)}\n`;
  return `${text}${notes}`;
}

/** Why the patch was not shown: it exceeds the threshold, or too many excluded files to leave out of it. */
export type SummaryReason = "large" | "many-excluded";

/**
 * The summary of a role's `router_git_diff`: a header with the totals (sensitive files' counts left out), one line per
 * file in git's order, the exact count of the lines left out, then `footer` (git's warnings, skipped directories; cut to
 * 1 KiB). At most {@link SUMMARY_MAX_BYTES} bytes.
 */
export function renderDiffSummary(entries: readonly SummaryEntry[], display: PathDisplay, options: { reason: SummaryReason; footer?: string }): string {
  const counted = entries.filter(entry => entry.sensitive !== true);
  const added = counted.reduce((sum, entry) => sum + (entry.added ?? 0), 0);
  const removed = counted.reduce((sum, entry) => sum + (entry.removed ?? 0), 0);
  const why = options.reason === "large"
    ? `the patch exceeds ${DIFF_SUMMARY_THRESHOLD_BYTES / 1024} KiB, so no hunks are shown`
    : "too many files with excluded content to leave out of the patch, so no hunks are shown";
  const head = `[router_git] diff summary: ${plural(entries.length, "file")}${entries.length > 0 ? ` (${categories(entries)})` : ""}, `
    + `+${added} -${removed}${counted.length < entries.length ? " outside sensitive files" : ""}; ${why}. `
    + "Call router_git_diff again with path for one file's patch.";
  return boundedList(head, entries, display, options.footer ?? "", SUMMARY_MAX_BYTES,
    rest => `[router_git] ${plural(rest.length, "more entry", "more entries")} not shown (${categories(rest)}) to keep this summary within `
      + `${SUMMARY_MAX_BYTES} bytes; call again with path for one file.`);
}

/** The list of files left out of a small patch (their kinds and counts), appended after it. At most {@link SUMMARY_MAX_BYTES} bytes. */
export function renderExcludedList(entries: readonly SummaryEntry[], display: PathDisplay): string {
  if (entries.length === 0) return "";
  return boundedList("[router_git] content excluded from this patch (call router_git_diff again with path to see one):", entries, display, "",
    SUMMARY_MAX_BYTES, rest => `[router_git] ${plural(rest.length, "more excluded entry", "more excluded entries")} not shown to keep this list within `
      + `${SUMMARY_MAX_BYTES} bytes.`);
}
