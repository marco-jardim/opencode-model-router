import { createHash } from "node:crypto";
import { realpath as fsRealpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  gitEnvironment,
  gitExecutable,
  hardeningArgs,
  inheritedSafeDirectoryArgs,
  isNetworkOrDevicePath,
  spawnBounded,
  workRootGuards,
} from "../router/git-tools.js";
import { PLAN_ID_PATTERN, type IsoTime, type PlanId } from "./types.js";

/**
 * Where the executor keeps its state (2.2.1). Nothing here touches the filesystem or runs git at module load; every
 * function that does takes its seams through {@link ExecutorPathsDeps}, so unit tests need no real repository.
 *
 * The executor home lives in the repository's git **common** directory, never in a worktree's private git directory
 * (`<common>\worktrees\<id>`): the main checkout and every linked worktree of one repository therefore resolve to the
 * same home, and removing a worktree never removes a plan's ledger.
 */

/** Name of the executor directory inside the git common directory (2.2.1.a). */
export const EXECUTOR_HOME_DIRNAME = "omr-executor";

/** Name of the directory under the executor home that holds the slot markers (2.2.1.b). */
export const SLOT_MARKERS_DIRNAME = "slots";

/** Result of one git run: the exit code (null when killed) and both streams as text. */
export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs git with `args` in `cwd`. The default is hardened, has no shell and bounds time and output. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRunResult>;

/** Test seams for {@link resolveExecutorHome}; every field is optional and defaults to the real thing. */
export interface ExecutorPathsDeps {
  /** Replaces the whole git invocation (executable choice, hardening, spawning). */
  git?: GitRunner;
  /** Replaces `fs.promises.realpath`. */
  realpath?: (path: string) => Promise<string>;
  /** Aborts the default git runner. */
  signal?: AbortSignal;
  /** Time bound for the default git runner (ms). */
  timeoutMs?: number;
}

/** Bound on a `rev-parse --git-common-dir` answer: one path line. */
const GIT_OUTPUT_LIMIT = 64 * 1024;
/** Default time bound for the git call (ms). */
const GIT_TIMEOUT_MS = 15_000;

/**
 * The default {@link GitRunner}: the git executable is chosen outside `dir`'s work root (`workRootGuards`), run with the
 * router's hardening arguments, a scrubbed `GIT_*` environment and the user's `safe.directory` values, never through a shell.
 */
function defaultGitRunner(deps: ExecutorPathsDeps): GitRunner {
  return async (args, cwd) => {
    const executable = gitExecutable(workRootGuards(cwd));
    const trusted = await inheritedSafeDirectoryArgs(executable);
    const result = await spawnBounded(executable, [...hardeningArgs(), ...trusted, ...args], cwd, {
      env: gitEnvironment(),
      signal: deps.signal,
      timeoutMs: deps.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBytes: GIT_OUTPUT_LIMIT,
    });
    if (result.truncated) throw new Error("git output exceeds its size bound");
    return { code: result.code, stdout: result.output.toString("utf8"), stderr: result.stderr.toString("utf8") };
  };
}

/**
 * `<realpath of git rev-parse --git-common-dir>\omr-executor` (2.2.1.a), resolved from `dir`.
 *
 * `--git-common-dir` is relative to `dir` in a main checkout (`.git`) and absolute in a linked worktree, so it is resolved
 * against `dir` first and then through `realpath` (symlinks, junctions, case on Windows), which makes both give one home.
 * Throws when `dir` is not in a git repository, when git reports a network or device path, or when the directory does not
 * exist. Creates nothing: the ledger store creates the directory when it opens a plan.
 */
export async function resolveExecutorHome(dir: string, deps: ExecutorPathsDeps = {}): Promise<string> {
  const git = deps.git ?? defaultGitRunner(deps);
  const real = deps.realpath ?? fsRealpath;
  const run = await git(["rev-parse", "--git-common-dir"], dir);
  if (run.code !== 0) {
    throw new Error(`Cannot resolve the git common directory of ${dir} (${run.code}): ${run.stderr.trim()}`);
  }
  const reported = run.stdout.replace(/\r?\n$/, "");
  if (reported.trim() === "") throw new Error(`git reported no common directory for ${dir}`);
  if (isNetworkOrDevicePath(reported)) throw new Error("Refusing executor home: git reports a network or device path");
  const common = await real(resolve(dir, reported));
  return join(common, EXECUTOR_HOME_DIRNAME);
}

/** True when `id` is a well-formed plan id (`PLAN_ID_PATTERN`, 2.2.1.c). */
export function isPlanId(id: unknown): id is PlanId {
  return typeof id === "string" && PLAN_ID_PATTERN.test(id);
}

/** Returns `id` or throws unless it matches `PLAN_ID_PATTERN`: the id becomes a path segment, so it is never trusted unchecked. */
export function assertPlanId(id: string): PlanId {
  if (!isPlanId(id)) throw new Error(`Invalid plan id: ${JSON.stringify(id)}`);
  return id;
}

/** `<home>\<planId>\` (2.2.1.b); throws on a plan id that is not a valid path segment. */
export function planDir(home: string, planId: PlanId): string {
  return join(home, assertPlanId(planId));
}

/** `<home>\slots\` (2.2.1.b). */
export function slotMarkersDir(home: string): string {
  return join(home, SLOT_MARKERS_DIRNAME);
}

/** Object keys sorted at every depth, so equal options always serialise to the same text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort()) sorted[key] = (v as Record<string, unknown>)[key];
    return sorted;
  }) ?? "";
}

/**
 * A new plan id, `p-<yyyymmdd>-<6 hex of sha256(path + digest + options)>` (2.2.1.c).
 *
 * `path + digest + options` is the plain concatenation of the three: `planPath` as the caller passes it (canonicalise it
 * first), the plan file's digest, and the compile options (a string is used verbatim; anything else as key-sorted JSON).
 * The date is the UTC day of `now` (a `Date` or an ISO time). The result always satisfies `PLAN_ID_PATTERN`.
 */
export function newPlanId(planPath: string, digest: string, options: unknown, now: Date | IsoTime): PlanId {
  const when = typeof now === "string" ? new Date(now) : now;
  if (Number.isNaN(when.getTime())) throw new Error("newPlanId needs a valid time");
  const day = when.toISOString().slice(0, 10).replace(/-/g, "");
  const optionsText = typeof options === "string" ? options : canonicalJson(options);
  const hex = createHash("sha256").update(planPath + digest + optionsText).digest("hex").slice(0, 6);
  return assertPlanId(`p-${day}-${hex}`);
}
