/**
 * #108 slice 2: `router_run({ summary: "failures" })` (OpenCode v2 roles mode, where `router_run` exists). Opt-in, for a vitest
 * npm script only: the router appends `--reporter=json --outputFile=<OS temp>/omr-run-<uuid>.json` to the script's arguments,
 * reads that report after the run, deletes it, and answers with the counts and the failing tests grouped by file (the first
 * error block of each) within {@link RUN_SUMMARY_MAX_BYTES}. Without `summary` nothing changes, and the plan executor's checks
 * (which share `planRun`) never set it.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { reportPathAllowed } from "../verify/runner";
import { stripUrlUserinfo } from "./git-tools";

/** Bound of a summarized `router_run` answer (status line included), in UTF-8 bytes. */
export const RUN_SUMMARY_MAX_BYTES = 4096;
/** The report files of `summary: "failures"`: `<OS temp>/omr-run-<uuid>.json`; nothing else is read or deleted. */
export const RUN_REPORT_NAME_RE = /^omr-run-[0-9a-f-]{36}\.json$/;
/** A larger report is not read (its size is checked first; the summary then falls back to the output's last lines). */
export const RUN_REPORT_MAX_BYTES = 8 * 1024 * 1024;
/** A caller argument, a fixed argument or a script-body token that sets vitest's reporter or output file. */
export const REPORTER_OPTION_RE = /^--(?:reporters?|outputFile|output-file)(?:[.=]|$)/;
/** Lines of a failure's first error block, and characters per line. */
const ERROR_BLOCK_LINES = 4;
const LINE_MAX_CHARS = 200;
/** Characters of a failing test's name line. */
const NAME_MAX_CHARS = 300;
/** Room kept for the omitted-count line. */
const OMITTED_RESERVE_BYTES = 260;

/** A fresh report path in `tmp`, the OS temp directory the caller read once (`os.tmpdir()`) and checks it against. */
export function newRunReportPath(tmp: string): string {
  return join(tmp, `omr-run-${randomUUID()}.json`);
}

/**
 * The verify runner's report-path guard with this tool's report names: only a file the router named, directly in `tmp` (absolute),
 * may be read or deleted. A relative `tmp` (a relative TEMP/TMPDIR) admits nothing.
 */
export function runReportPathAllowed(path: string, tmp: string): boolean {
  return reportPathAllowed(path, tmp, process.platform, RUN_REPORT_NAME_RE);
}

/**
 * Why a package.json script body cannot be summarized, or undefined when it can. It must be one `vitest` command (its first word
 * `vitest`) whose appended arguments reach vitest as options: nothing the script shell would chain, pipe, redirect or substitute
 * (`;`, `&`, `|`, `<`, `>`, backquote, `$(`, a line break), no `#` (a comment would swallow them), no trailing backslash, no `--`
 * argument (vitest would read them as file filters), no quote, backslash, `$`, `%` or `^` inside an option name (the shell could
 * make another option of it), and no `--reporter`/`--outputFile` of its own.
 */
export function vitestScriptRefusal(body: string): string | undefined {
  const text = body.trim();
  if (!/^vitest(?:\s|$)/.test(text)) return "does not start with vitest";
  if (/[;&|<>`\r\n]|\$\(/.test(text)) return "is not a single vitest command (it chains, pipes, redirects or substitutes)";
  if (text.includes("#")) return "has a # (the script shell may read the rest as a comment)";
  if (text.endsWith("\\")) return "ends with a backslash";
  const tokens = text.split(/\s+/);
  if (tokens.includes("--")) return "has a -- argument (vitest would read the appended options as file filters)";
  for (const token of tokens) {
    const bare = token.replace(/^["']+/, "");
    if (REPORTER_OPTION_RE.test(bare)) return "already sets --reporter or --outputFile";
    if (bare.startsWith("-") && /["'\\$%^]/.test(bare.split("=")[0]!)) return "has a quote or escape inside an option name";
  }
  return undefined;
}

/** ANSI CSI escape sequences (colours, cursor moves). */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** Control characters (line breaks and tabs included) and the Unicode line and paragraph separators. */
const CONTROL_RE = /[\p{Cc}\u2028\u2029]+/gu;

/**
 * Report text shown on one line (a test name, an ancestor title, a file path): ANSI escapes removed, control characters and
 * line breaks flattened to one space, credentials redacted (as the raw output is). A name cannot start a line of its own.
 */
export function oneLine(text: string): string {
  return stripUrlUserinfo(text.replace(ANSI_RE, "").replace(CONTROL_RE, " ")).trim();
}

/** One failing test (or a file-level error) and the first block of its error message. */
export interface VitestFailure { readonly name: string; readonly error?: string }
/** The failures of one test file, in report order. */
export interface VitestFileFailures { readonly file: string; readonly failures: readonly VitestFailure[] }
/** What a summary needs from a vitest (jest-compatible) JSON report. Counts the report does not carry are undefined. */
export interface VitestReportSummary {
  readonly total?: number;
  readonly passed?: number;
  readonly failed?: number;
  readonly skipped?: number;
  readonly files?: number;
  readonly failedFiles?: number;
  readonly groups: readonly VitestFileFailures[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A test file's name as shown: relative to the work root with `/` separators when inside it, else as reported. */
function shownFile(cwd: string, file: string): string {
  const below = relative(cwd, file);
  return below !== "" && !below.startsWith("..") && !isAbsolute(below) ? below.split(sep).join("/") : file;
}

/** At most `max` characters of one line, marked when cut. */
function clip(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * The first block of an error message: ANSI codes removed, credentials redacted, leading blank lines skipped, then lines up
 * to the first blank line or stack frame (`at …`, `❯ …`), at most {@link ERROR_BLOCK_LINES} lines of {@link LINE_MAX_CHARS},
 * other control characters in a line flattened to a space (the renderer indents every line it shows).
 */
export function firstErrorBlock(message: string): string | undefined {
  const lines = stripUrlUserinfo(message.replace(ANSI_RE, "")).split(/\r\n|[\n\r\u2028\u2029]/).map(line => line.replace(CONTROL_RE, " "));
  const start = lines.findIndex(line => line.trim() !== "");
  if (start === -1) return undefined;
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === "" || /^\s*(?:at\s|❯\s)/.test(line) || block.length === ERROR_BLOCK_LINES) break;
    block.push(clip(line.trimEnd(), LINE_MAX_CHARS));
  }
  return block.length === 0 ? undefined : block.join("\n");
}

/** Parse a vitest `--reporter=json` report; undefined when it is not one (not JSON, no `testResults` array). */
export function parseVitestReport(text: string, cwd: string): VitestReportSummary | undefined {
  let report: unknown;
  try { report = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(report) || !Array.isArray(report.testResults)) return undefined;
  const groups: VitestFileFailures[] = [];
  for (const suite of report.testResults.filter(isRecord)) {
    if (typeof suite.name !== "string") continue;
    const results = Array.isArray(suite.assertionResults) ? suite.assertionResults.filter(isRecord) : [];
    const failures: VitestFailure[] = [];
    const message = typeof suite.message === "string" ? suite.message : "";
    const fileError = message.trim() === "" ? undefined : firstErrorBlock(message);
    for (const result of results.filter(entry => entry.status === "failed")) {
      const titles = Array.isArray(result.ancestorTitles) ? result.ancestorTitles.map(String) : [];
      const name = [...titles, String(result.title ?? result.fullName ?? "(unnamed test)")].map(oneLine).join(" > ");
      const messages = Array.isArray(result.failureMessages) ? result.failureMessages : [];
      const error = typeof messages[0] === "string" ? firstErrorBlock(messages[0]) : undefined;
      failures.push({ name, ...(error === undefined ? {} : { error }) });
    }
    if (fileError !== undefined || (suite.status === "failed" && failures.length === 0)) {
      failures.unshift({ name: "(file error)", ...(fileError === undefined ? {} : { error: fileError }) });
    }
    if (failures.length > 0) groups.push({ file: oneLine(shownFile(cwd, suite.name)), failures });
  }
  const pending = count(report.numPendingTests);
  const todo = count(report.numTodoTests);
  const total = count(report.numTotalTests);
  const passed = count(report.numPassedTests);
  const failed = count(report.numFailedTests);
  const skipped = pending === undefined && todo === undefined ? undefined : (pending ?? 0) + (todo ?? 0);
  const files = count(report.numTotalTestSuites);
  const failedFiles = count(report.numFailedTestSuites);
  return {
    ...(total === undefined ? {} : { total }), ...(passed === undefined ? {} : { passed }), ...(failed === undefined ? {} : { failed }),
    ...(skipped === undefined ? {} : { skipped }), ...(files === undefined ? {} : { files }), ...(failedFiles === undefined ? {} : { failedFiles }),
    groups,
  };
}

const bytes = (text: string) => Buffer.byteLength(text);
const known = (value: number | undefined) => value === undefined ? "?" : String(value);

/** The last lines of `output` within `max` bytes (whole lines only; the first, possibly cut, line is dropped). */
function outputTail(output: string, max: number): string {
  if (max <= 0 || output.trim() === "") return "";
  if (bytes(output) <= max) return output.endsWith("\n") ? output : `${output}\n`;
  const raw = Buffer.from(output);
  const tail = raw.subarray(raw.length - max).toString("utf8");
  const newline = tail.indexOf("\n");
  const whole = newline === -1 ? "" : tail.slice(newline + 1);
  return whole === "" || whole.endsWith("\n") ? whole : `${whole}\n`;
}

/** Cut `text` to `max` bytes at a line end (a last safety bound; the renderers below already stay within it). */
function fitBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const kept = Buffer.from(text).subarray(0, max).toString("utf8").replace(/\uFFFD+$/, "");
  const newline = kept.lastIndexOf("\n");
  return newline > 0 ? kept.slice(0, newline + 1) : kept;
}

/**
 * The answer of a summarized run whose report could be read: `status` (the usual status line), the counts, then the failures
 * grouped by file. The cut rule, at most `max` bytes in all:
 * 1. Failure names first, in report order (a file's `FAIL <file>` line with its first shown failure); the first one that does
 *    not fit ends the list.
 * 2. Then the first error block of each listed failure, in order, as long as it fits (one that does not is skipped).
 * 3. A last line gives the exact number of failures (and files) not listed and of error blocks left out.
 * A run that exited non-zero although the report lists no failure gets the output's last lines instead.
 */
export function renderFailureSummary(status: string, report: VitestReportSummary, exitCode: number | null, output: string,
  max = RUN_SUMMARY_MAX_BYTES): string {
  const head = `${status}\n[router_run] vitest: ${known(report.failed)} failed, ${known(report.passed)} passed, ${known(report.skipped)} skipped `
    + `of ${known(report.total)} tests; ${known(report.failedFiles)} of ${known(report.files)} test files failed\n`;
  if (report.groups.length === 0) {
    if (exitCode === 0) return fitBytes(head, max);
    const label = `[router_run] the run ended with exit code ${exitCode ?? "none"} but its report lists no failing test; the last lines of its output:\n`;
    return fitBytes(`${head}${label}${outputTail(output, max - bytes(head) - bytes(label))}`, max);
  }
  type Item = { group: number; name: string; error: string | undefined };
  const items: Item[] = report.groups.flatMap((group, index) => group.failures.map(failure => ({
    group: index, name: `  × ${clip(failure.name, NAME_MAX_CHARS)}\n`, error: failure.error === undefined ? undefined : `${failure.error.split("\n").map(line => `    ${line}`).join("\n")}\n`,
  })));
  const fileLine = (group: number) => `FAIL ${clip(report.groups[group]!.file, NAME_MAX_CHARS)}\n`;
  const room = max - bytes(head) - OMITTED_RESERVE_BYTES;
  // 1. Names.
  let used = 0;
  let listed = 0;
  for (const item of items) {
    const first = listed === 0 || items[listed - 1]!.group !== item.group;
    const cost = bytes(item.name) + (first ? bytes(fileLine(item.group)) : 0);
    if (used + cost > room) break;
    used += cost;
    listed++;
  }
  // 2. Error blocks, in order, while they fit.
  const withError = new Set<number>();
  let missingErrors = 0;
  for (let index = 0; index < listed; index++) {
    const error = items[index]!.error;
    if (error === undefined) continue;
    if (used + bytes(error) <= room) {
      used += bytes(error);
      withError.add(index);
    } else missingErrors++;
  }
  let body = "";
  for (let index = 0; index < listed; index++) {
    const item = items[index]!;
    if (index === 0 || items[index - 1]!.group !== item.group) body += fileLine(item.group);
    body += item.name;
    if (withError.has(index)) body += item.error;
  }
  // 3. What was left out, exactly.
  const rest = items.slice(listed);
  const restFiles = new Set(rest.map(item => item.group)).size;
  const parts = [
    rest.length > 0 ? `${rest.length} more ${rest.length === 1 ? "failure" : "failures"} in ${restFiles} ${restFiles === 1 ? "file" : "files"}` : "",
    missingErrors > 0 ? `the error ${missingErrors === 1 ? "block" : "blocks"} of ${missingErrors} listed ${missingErrors === 1 ? "failure" : "failures"}` : "",
  ].filter(Boolean);
  const omitted = parts.length === 0 ? ""
    : `[router_run] not shown, to keep this summary within ${max} bytes: ${parts.join("; ")}. Run without summary for the full output.\n`;
  return fitBytes(`${head}${body}${omitted}`, max);
}

/** The answer of a summarized run without a usable report: `status`, why, and the output's last lines, within `max` bytes. */
export function renderSummaryUnavailable(status: string, reason: string, output: string, max = RUN_SUMMARY_MAX_BYTES): string {
  const head = `${status}\n[router_run] vitest summary unavailable: ${reason}; the last lines of the output:\n`;
  return fitBytes(`${head}${outputTail(output, max - bytes(head))}`, max);
}
