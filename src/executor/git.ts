// src/executor/git.ts
// Phase 2.4.2: hardened git operations for the executor (design memo 2.4.1 §2 in
// docs/qa/critical-path-execution/phase-2.4.md). Every git call goes through an injected `GitRunner`, which never
// spawns a shell; hooks never run (empty `core.hooksPath` directory), signing and editors are off, and an in-slot call
// never trusts the slot's own `.git` (explicit `--git-dir`/`--work-tree` after `verifySlotPointers`).

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  gitEnvironment, gitExecutable, gitPointers, hardeningArgs, isNetworkOrDevicePath, spawnBounded, stripUrlUserinfo,
  workRootGuards,
} from "../router/git-tools";
import {
  ExecutorError, GIT_ID_PATTERN, PLAN_ID_PATTERN,
  type FileSystem, type GitRunner, type JsonValue, type PhaseId, type PlanId, type ProcessResult, type ProcOpts,
  type TaskId, type TaskNode,
} from "./types";

// ---------------------------------------------------------------------------------------------------------------
// §2.1 Runner and argv
// ---------------------------------------------------------------------------------------------------------------

export const MIN_GIT_VERSION = [2, 33, 0] as const;
export const GIT_OP_TIMEOUT_MS = 120_000;
export const GIT_WORKTREE_ADD_TIMEOUT_MS = 600_000;
export const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Bytes of stderr kept in an `E_GIT` detail. */
const GIT_STDERR_TAIL_BYTES = 2048;

/** Error a production `GitRunner` throws; `code` is `ETIMEDOUT`, `EOUTPUT` or `ABORT_ERR`. */
class GitRunnerError extends Error {
  readonly code: "ETIMEDOUT" | "EOUTPUT" | "ABORT_ERR";
  constructor(code: "ETIMEDOUT" | "EOUTPUT" | "ABORT_ERR", message: string) {
    super(message);
    this.name = "GitRunnerError";
    this.code = code;
  }
}

/** Variables that would redirect a "user" mode git call to another repository, object store or namespace. */
const USER_MODE_DROPPED_ENV: ReadonlySet<string> = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
]);

function userEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...(extra ?? {}) };
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (!USER_MODE_DROPPED_ENV.has(key.toUpperCase())) out[key] = value;
  }
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/**
 * Hardened env: `gitEnvironment(extra)` with the C locale forced (`LC_ALL=C`, `LANGUAGE=`), so the git messages the
 * executor parses (`Would remove ...`) are never translated.
 */
export function hardenedEnvironment(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...gitEnvironment({ ...(extra ?? {}) }) };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper === "LC_ALL" || upper === "LANGUAGE") delete env[key];
  }
  env.LC_ALL = "C";
  env.LANGUAGE = "";
  return env;
}

/**
 * Production GitRunner: `spawnBounded(gitExecutable(workRootGuards(toplevel)), args, cwd, {env, timeoutMs, maxBytes, signal})`.
 * mode "hardened": env = `gitEnvironment(o.env ?? {})` (`o.env` is EXTRA, never a replacement) with `LC_ALL=C` and an
 * empty `LANGUAGE` forced.
 * mode "user": the process environment minus GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE,
 * GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_NAMESPACE and GIT_CEILING_DIRECTORIES, plus
 * GIT_TERMINAL_PROMPT=0; used for the identity read only.
 * A timeout throws `{code: "ETIMEDOUT"}`, truncated output `{code: "EOUTPUT"}`, an abort `{code: "ABORT_ERR"}`.
 * Never a shell (git-tools `spawnBounded` spawns with `shell: false`).
 */
export function createGitRunner(o: { mode: "hardened" | "user"; toplevel: string }): GitRunner {
  let executable: string | undefined;
  return {
    async run(args: readonly string[], p: ProcOpts): Promise<ProcessResult> {
      try { p.service?.prepare(); } catch { /* Diagnostics only. */ }
      try {
        if (p.stdin !== undefined) throw new Error("the git runner does not support stdin");
        executable ??= gitExecutable(workRootGuards(o.toplevel));
        const env = o.mode === "hardened" ? hardenedEnvironment(p.env) : userEnvironment(p.env);
        const started = Date.now();
        const bounds = { env, timeoutMs: p.timeoutMs, maxBytes: p.maxOutputBytes ?? GIT_MAX_OUTPUT_BYTES, settleOnFailure: true,
          ...(p.service === undefined ? {} : { service: p.service }) };
        const result = await spawnBounded(executable, args, p.cwd, p.signal === undefined ? bounds : { ...bounds, signal: p.signal });
        if (result.failure !== undefined) {
          throw new GitRunnerError(result.failure.endsWith("timed out") ? "ETIMEDOUT" : "ABORT_ERR", result.failure);
        }
        if (result.truncated) throw new GitRunnerError("EOUTPUT", `git output exceeds ${bounds.maxBytes} bytes`);
        return {
          code: result.code, signal: null, stdout: result.output.toString("utf8"), stderr: result.stderr.toString("utf8"),
          truncated: false, durationMs: Date.now() - started,
        };
      } finally {
        // Preparation can throw before spawnBounded owns the hook. Its completed child is already closed here.
        try { p.service?.end("error"); } catch { /* Diagnostics only. */ }
      }
    },
  };
}

export interface GitContext {
  /** `<home>\git\no-hooks`: an empty real directory created by the executor. */
  hooksDir: string;
  /** `<home>\git\slot-excludes`. */
  excludesFile: string;
  /** DV6 snapshot of the user's line-ending configuration. */
  conversion: { autocrlf: string | null; eol: string | null };
}

/**
 * `hardeningArgs()` (git-tools) then, in this order (a later `-c` wins over the NUL hooksPath it sets):
 * core.longpaths, core.hooksPath, core.excludesFile, core.editor, sequence.editor, the signing switches, the
 * rebase/merge switches, rerere, submodule.recurse, advice.detachedHead, user.useConfigOnly, then core.autocrlf and
 * core.eol when the snapshot has them.
 */
export function executorGitArgs(c: GitContext): string[] {
  const args = [
    ...hardeningArgs(),
    "-c", "core.longpaths=true", "-c", `core.hooksPath=${c.hooksDir}`, "-c", `core.excludesFile=${c.excludesFile}`,
    "-c", "core.editor=:", "-c", "sequence.editor=:",
    "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", "-c", "tag.forceSignAnnotated=false",
    "-c", "rebase.updateRefs=false", "-c", "rebase.autoStash=false", "-c", "rebase.autoSquash=false",
    "-c", "merge.autoStash=false",
    "-c", "rerere.enabled=false", "-c", "submodule.recurse=false", "-c", "advice.detachedHead=false",
    "-c", "user.useConfigOnly=true",
  ];
  if (c.conversion.autocrlf !== null) args.push("-c", `core.autocrlf=${c.conversion.autocrlf}`);
  if (c.conversion.eol !== null) args.push("-c", `core.eol=${c.conversion.eol}`);
  return args;
}

/** Fixed content of `slot-excludes` (DV5): ignore rules never affect tracked files. */
export const SLOT_EXCLUDES_CONTENT = [
  "node_modules/", "/.venv/", "/.yarn/cache/", "/.yarn/unplugged/", "/.yarn/install-state.gz", "/.pnp.*", "*.egg-info/",
].join("\n") + "\n";

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

function invalid(message: string, detail: JsonValue = null): ExecutorError {
  return new ExecutorError("E_INVALID_INPUT", message, detail);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function foldCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= max ? text : bytes.subarray(bytes.length - max).toString("utf8").replace(/^\uFFFD+/, "");
}

function splitNul(text: string): string[] {
  return text.split("\0").filter(part => part !== "");
}

function gitFailure(op: string, r: ProcessResult): ExecutorError {
  const stderr = tailBytes(stripUrlUserinfo(r.stderr), GIT_STDERR_TAIL_BYTES);
  return new ExecutorError("E_GIT", `git ${op} failed (exit ${r.code ?? r.signal ?? "unknown"})`, { op, code: r.code, stderr });
}

function requireCommit(value: string, what: string): string {
  if (!GIT_ID_PATTERN.test(value)) throw invalid(`${what} is not a full git object id`, { value: value.slice(0, 80) });
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// §2.3 Identity
// ---------------------------------------------------------------------------------------------------------------

export interface CommitIdentity { name: string; email: string }

const identityCache = new WeakMap<GitRunner, Map<string, Promise<CommitIdentity & { conversion: GitContext["conversion"] }>>>();

async function readConfig(userGit: GitRunner, toplevel: string, key: string): Promise<string | null> {
  const r = await userGit.run(["config", "--includes", "--get", key], { cwd: toplevel, timeoutMs: GIT_OP_TIMEOUT_MS, maxOutputBytes: 64 * 1024 });
  if (r.code === 1) return null;
  if (r.code !== 0) throw gitFailure(`config ${key}`, r);
  return r.stdout.replace(/\r?\n$/, "");
}

function identityValue(raw: string | null, key: string, toplevel: string): string {
  const missing = () => new ExecutorError("E_IDENTITY",
    `No git commit identity for ${toplevel}: run git config user.name "…" and git config user.email "…" (repository or global). ` +
    "The executor never invents one.", { toplevel, key });
  if (raw === null) throw missing();
  if (/[\0\r\n<>]/.test(raw)) throw new ExecutorError("E_IDENTITY", `${key} contains a character that is not allowed in a commit identity`, { toplevel, key });
  const value = raw.trim();
  if (value === "") throw missing();
  return value;
}

function conversionValue(raw: string | null, key: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(value)) throw new ExecutorError("E_GIT", `unsupported ${key} value`, { key });
  return value;
}

/**
 * Once per runner and toplevel (cached): the user's effective `user.name`/`user.email`
 * (`config --includes --get`, cwd = toplevel). A missing or empty value is `E_IDENTITY`; a value with NUL, CR, LF, `<` or
 * `>` is `E_IDENTITY`. Never `git var` (it can synthesise an identity). The same read snapshots `core.autocrlf`/`core.eol`
 * (DV6). A failed read is not cached.
 */
export function readCommitIdentity(userGit: GitRunner, toplevel: string): Promise<CommitIdentity & { conversion: GitContext["conversion"] }> {
  let perRunner = identityCache.get(userGit);
  if (perRunner === undefined) { perRunner = new Map(); identityCache.set(userGit, perRunner); }
  const key = foldCase(toplevel);
  const cached = perRunner.get(key);
  if (cached !== undefined) return cached;
  const pending = (async () => {
    const [name, email, autocrlf, eol] = await Promise.all([
      readConfig(userGit, toplevel, "user.name"), readConfig(userGit, toplevel, "user.email"),
      readConfig(userGit, toplevel, "core.autocrlf"), readConfig(userGit, toplevel, "core.eol"),
    ]);
    return {
      name: identityValue(name, "user.name", toplevel), email: identityValue(email, "user.email", toplevel),
      conversion: { autocrlf: conversionValue(autocrlf, "core.autocrlf"), eol: conversionValue(eol, "core.eol") },
    };
  })();
  perRunner.set(key, pending);
  pending.catch(() => { perRunner.delete(key); });
  return pending;
}

// ---------------------------------------------------------------------------------------------------------------
// §2.4 Commit messages
// ---------------------------------------------------------------------------------------------------------------

export type CommitType = "feat" | "fix" | "test" | "docs" | "revert";
export const COMMIT_TITLE_MAX = 72;
/** Plan 2.4.2.b pattern, applied to the whole subject; `.{1,72}` bounds the TITLE. */
export const COMMIT_SUBJECT_PATTERN =
  /^(feat|fix|test|docs|revert)\(([\w.-]+)\): (.{1,72}) \[([a-z0-9][a-z0-9-]{2,40}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})\]$/;

/**
 * task -> feat, or docs when `footprint.writes` is non-empty and every path ends in `.md` or starts with `docs/`;
 * fix -> fix; tests -> test; qa -> docs; manual/preflight -> E_INVALID_INPUT (they never commit).
 */
export function commitTypeFor(t: Pick<TaskNode, "kind" | "footprint">): Exclude<CommitType, "revert"> {
  switch (t.kind) {
    case "task": {
      const writes = t.footprint.writes;
      return writes.length > 0 && writes.every(w => w.endsWith(".md") || w.startsWith("docs/")) ? "docs" : "feat";
    }
    case "fix": return "fix";
    case "tests": return "test";
    case "qa": return "docs";
    default: throw invalid(`a ${t.kind} task never commits`, { kind: t.kind });
  }
}

/**
 * `<type>(<scope>): <title> [<planId>:<taskId>]`. The title has C0/C1 controls replaced by spaces, whitespace collapsed
 * and is trimmed; if empty it becomes the task id. Longer than 72: cut at the last space at or before 72 when that
 * leaves at least 20 chars, else a hard cut at 72, then trimmed. One line, no body, no trailers. Throws
 * E_INVALID_INPUT when the result fails `COMMIT_SUBJECT_PATTERN`.
 */
export function formatCommitMessage(i: { type: CommitType; scope: string; title: string; planId: PlanId; taskId: TaskId }): string {
  let title = i.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (title === "") title = i.taskId;
  if (title.length > COMMIT_TITLE_MAX) {
    const space = title.lastIndexOf(" ", COMMIT_TITLE_MAX);
    title = space >= 20 ? title.slice(0, space) : title.slice(0, COMMIT_TITLE_MAX);
    if (/[\ud800-\udbff]$/.test(title)) title = title.slice(0, -1);
    title = title.trimEnd();
  }
  const subject = `${i.type}(${i.scope}): ${title} [${i.planId}:${i.taskId}]`;
  if (!COMMIT_SUBJECT_PATTERN.test(subject)) throw invalid("commit subject does not match the executor pattern", { subject: subject.slice(0, 200) });
  return subject;
}

// ---------------------------------------------------------------------------------------------------------------
// §2.5 Ref names
// ---------------------------------------------------------------------------------------------------------------

const REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Injective, case-fold-safe encoding of an id into one ref component. Accepts `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` only
 * (anything else is E_INVALID_INPUT). Per char: `[a-z0-9-]` kept; `[A-Z]` lower-cased; `_` -> `__`; `.` kept unless the
 * next char is `.` or it is the last char, then `_0`. With any uppercase, `_u` + the lowercase hex of the bitmask of
 * uppercase positions is appended. If the result ends in `.lock`, that `.` becomes `_0`.
 * `1.1.1` -> `1.1.1`; `2.4.QA` -> `2.4.qa_u30`; `a..b` -> `a_0.b`; `x.lock` -> `x_0lock`; `t_1` -> `t__1`.
 */
export function encodeRefId(id: string): string {
  if (typeof id !== "string" || !REF_ID_PATTERN.test(id)) throw invalid("id cannot be encoded into a ref name", { id: String(id).slice(0, 80) });
  let out = "";
  let mask = 0n;
  for (let n = 0; n < id.length; n++) {
    const c = id.charAt(n);
    if (c >= "A" && c <= "Z") { out += c.toLowerCase(); mask |= 1n << BigInt(n); }
    else if (c === "_") out += "__";
    else if (c === ".") out += n === id.length - 1 || id.charAt(n + 1) === "." ? "_0" : ".";
    else out += c;
  }
  if (mask !== 0n) out += `_u${mask.toString(16)}`;
  if (out.endsWith(".lock")) out = `${out.slice(0, -5)}_0lock`;
  return out;
}

export function planRefPrefix(planId: PlanId): string {
  if (typeof planId !== "string" || !PLAN_ID_PATTERN.test(planId)) throw invalid("invalid plan id", { planId: String(planId).slice(0, 80) });
  return `omr/${planId}/`;
}
/** `omr/<planId>/t/<encoded taskId>`. */
export function taskBranchName(planId: PlanId, taskId: TaskId): string {
  return `${planRefPrefix(planId)}t/${encodeRefId(taskId)}`;
}
/** `omr/<planId>/integration`. */
export function integrationBranchName(planId: PlanId): string {
  return `${planRefPrefix(planId)}integration`;
}
/** `omr/<planId>/phase/<encoded phaseId>`. */
export function phaseTagName(planId: PlanId, phaseId: PhaseId): string {
  return `${planRefPrefix(planId)}phase/${encodeRefId(phaseId)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// §2.6 Operations
// ---------------------------------------------------------------------------------------------------------------

export interface GitOpsDeps {
  git: GitRunner; userGit: GitRunner; fs: FileSystem; planId: PlanId;
  toplevel: string; executorHome: string; timeoutMs?: number;
}
export type Conflict = { ok: false; conflicts: string[] };
export interface WorktreeEntry { path: string; head: string | null; /** Full ref, e.g. `refs/heads/x`. */ branch: string | null; /** Lock reason ("" for none given). */ locked: string | null }
export interface StatusEntry { xy: string; path: string; orig: string | null }

export interface GitOps {
  readonly planId: PlanId;
  /** The git version as `major.minor.patch`; E_GIT if it is below MIN_GIT_VERSION. */
  version(): Promise<string>;
  /** `git check-ref-format refs/heads/<name>`, cached per name; E_INVALID_INPUT when invalid. */
  checkRefFormat(name: string): Promise<void>;
  /** Throws E_SLOT_BROKEN unless the slot's `.git` is a linked-worktree pointer into this repository (memo §2.2). */
  verifySlotPointers(slot: string): Promise<{ gitdir: string; common: string }>;
  // cwd = toplevel
  /** `worktree add --detach --lock --reason <lockReason> <path> <commit>`. */
  worktreeAdd(path: string, commit: string, lockReason: string): Promise<void>;
  /**
   * pre: lstat(path) is ENOENT (else E_GIT, never runs). Unlocks when locked with exactly `lockReason`, then
   * `worktree remove --force <path>` (drops the admin entry only). Never `worktree prune`. A path git does not list is a no-op.
   */
  worktreeRemove(path: string, lockReason: string): Promise<void>;
  worktreeList(): Promise<WorktreeEntry[]>;
  // cwd = slot, explicit --git-dir/--work-tree
  checkoutDetach(slot: string, commit: string): Promise<void>;
  /** `clean -q -ffdx -e <keep>...`: ignored files of the previous owner go too; only `keep` survives. */
  cleanTracked(slot: string, keep: readonly string[]): Promise<void>;
  /**
   * `checkout --force HEAD -- .`, `clean -q -ffdx -e <keep>...`, then nothing may remain to clean and `statusPorcelain` must
   * be empty (E_GIT listing the dirty paths otherwise). Tracked changes are reverted: 3.1 commits before it calls this.
   */
  cleanForChecks(slot: string, keep: readonly string[]): Promise<void>;
  /** The paths `clean -ffndx -e <keep>...` would remove (same vector as the real clean), "/"-separated, directories end in "/". */
  cleanPreview(slot: string, keep: readonly string[]): Promise<string[]>;
  /** `ls-files -z --cached` (index), optionally limited to literal pathspecs. */
  lsFiles(slot: string, pathspecs?: readonly string[]): Promise<string[]>;
  /** Index entries of mode 120000. */
  trackedLinks(slot: string): Promise<string[]>;
  statusPorcelain(slot: string): Promise<StatusEntry[]>;
  addAll(slot: string): Promise<void>;
  /** Validates `message` against COMMIT_SUBJECT_PATTERN; returns the new HEAD. */
  commit(slot: string, message: string): Promise<string>;
  /** `cwd` is the toplevel or a slot. */
  revParse(cwd: string, rev: string): Promise<string>;
  diffNames(cwd: string, from: string, to: string): Promise<string[]>;
  rebaseOnto(slot: string, onto: string, upstream: string, observation?: ServiceObservation): Promise<{ ok: true; head: string } | Conflict>;
  rebaseAbort(slot: string): Promise<void>;
  cherryPick(slot: string, commits: readonly string[]): Promise<{ ok: true; head: string } | Conflict>;
  revert(slot: string, commit: string, message: string): Promise<{ ok: true; head: string } | Conflict>;
  mergeFfOnly(cwd: string, commit: string, observation?: ServiceObservation): Promise<{ ok: boolean; head: string }>;
  isAncestor(a: string, b: string): Promise<boolean>;
  tag(name: string, commit: string): Promise<void>;
  deleteRefs(prefix: string): Promise<string[]>;
  /**
   * Compare-and-swap move of `refs/heads/<name>` (`update-ref --no-deref`); `expectedOld` is required, `null` meaning the
   * branch must not exist. Refuses a symbolic ref and a branch checked out in any worktree.
   */
  branchForce(name: string, commit: string, expectedOld: string | null, observation?: ServiceObservation): Promise<void>;
}

interface OpsContext { args: string[]; identity: CommitIdentity }
type ServiceObservation = import("./observations").ServiceObservation;
interface GitService {
  observation: ServiceObservation; stage: string; preparation: ReturnType<ServiceObservation["start"]>;
}
interface Call { op: string; args: readonly string[]; timeoutMs?: number; identity?: boolean; service?: GitService }

const LOCK_REASON_PATTERN = /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,200}$/;

export function createGitOps(d: GitOpsDeps): GitOps {
  const planPrefix = planRefPrefix(d.planId);
  const timeoutMs = d.timeoutMs ?? GIT_OP_TIMEOUT_MS;
  const toplevel = d.toplevel;
  const gitHome = join(d.executorHome, "git");
  const hooksDir = join(gitHome, "no-hooks");
  const excludesFile = join(gitHome, "slot-excludes");
  const refFormatCache = new Map<string, boolean>();
  let versionCache: string | undefined;
  let contextPromise: Promise<OpsContext> | undefined;
  let commonCache: string | undefined;

  // ---- context: hooks directory, excludes file, identity and conversion snapshot ----

  async function ensureDir(p: string): Promise<void> {
    const st = await d.fs.lstat(p);
    if (st !== null) {
      if (st.kind !== "dir") throw new ExecutorError("E_GIT", "executor git directory is not a real directory", { path: p });
      return;
    }
    try { await d.fs.mkdir(p); } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }

  async function prepareFiles(): Promise<void> {
    await ensureDir(d.executorHome);
    await ensureDir(gitHome);
    await ensureDir(hooksDir);
    const hooks = await d.fs.lstat(hooksDir);
    if (hooks === null || hooks.kind !== "dir") throw new ExecutorError("E_GIT", "hooks directory is not a real directory", { path: hooksDir });
    if ((await d.fs.readdir(hooksDir)).length !== 0) throw new ExecutorError("E_GIT", "hooks directory is not empty", { path: hooksDir });
    const existing = await d.fs.lstat(excludesFile);
    if (existing !== null && existing.kind !== "file") throw new ExecutorError("E_GIT", "slot excludes path is not a file", { path: excludesFile });
    if (existing === null || (await d.fs.readText(excludesFile)) !== SLOT_EXCLUDES_CONTENT) {
      await d.fs.writeText(excludesFile, SLOT_EXCLUDES_CONTENT, { fsync: true });
    }
  }

  function context(): Promise<OpsContext> {
    if (contextPromise !== undefined) return contextPromise;
    const pending = (async (): Promise<OpsContext> => {
      await prepareFiles();
      const { conversion, ...identity } = await readCommitIdentity(d.userGit, toplevel);
      return { args: executorGitArgs({ hooksDir, excludesFile, conversion }), identity };
    })();
    contextPromise = pending;
    pending.catch(() => { if (contextPromise === pending) contextPromise = undefined; });
    return pending;
  }

  // ---- running ----

  function gitService(observation: ServiceObservation | undefined, stage: string): GitService | undefined {
    return observation === undefined ? undefined : { observation, stage, preparation: observation.start("service-prep", "git-preparation") };
  }

  async function exec(op: string, cwd: string, args: readonly string[], limit: number, diagnostic?: GitService): Promise<ProcessResult> {
    let result: ProcessResult;
    diagnostic?.preparation?.end("completed");
    const service = diagnostic?.observation.execution(diagnostic.stage);
    try {
      result = await d.git.run(args, { cwd, timeoutMs: limit, maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
        ...(service === undefined ? {} : { service }) });
      service?.end(result.code === 0 && !result.truncated ? "pass" : "fail");
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      throw new ExecutorError("E_GIT", `git ${op} could not run: ${stripUrlUserinfo(errorText(error)).slice(0, 300)}`,
        { op, code: errorCode(error) ?? null, stderr: "" });
    } finally {
      service?.end("error");
      if (diagnostic !== undefined) diagnostic.preparation = diagnostic.observation.start("service-prep", "git-result");
    }
    if (result.truncated) throw new ExecutorError("E_GIT", `git ${op} output was truncated`, { op, code: result.code, stderr: "" });
    return result;
  }

  function identityArgs(x: OpsContext, wanted: boolean | undefined): string[] {
    return wanted === true ? ["-c", `user.name=${x.identity.name}`, "-c", `user.email=${x.identity.email}`] : [];
  }

  /** The hooks directory is re-checked before every call: an op can run a hook only from a non-empty directory. */
  async function assertHooksEmpty(): Promise<void> {
    const st = await d.fs.lstat(hooksDir);
    if (st === null || st.kind !== "dir") throw new ExecutorError("E_GIT", "hooks directory is not a real directory", { path: hooksDir });
    if ((await d.fs.readdir(hooksDir)).length !== 0) throw new ExecutorError("E_GIT", "hooks directory is not empty", { path: hooksDir });
  }

  /** cwd = toplevel. */
  async function inRepo(c: Call): Promise<ProcessResult> {
    const x = await context();
    await assertHooksEmpty();
    return exec(c.op, toplevel, [...x.args, ...identityArgs(x, c.identity), ...c.args], c.timeoutMs ?? timeoutMs, c.service);
  }

  /** cwd = slot, after the pointer check, with explicit --git-dir/--work-tree. */
  async function inSlot(slot: string, c: Call): Promise<ProcessResult> {
    const { gitdir } = await verifySlotPointers(slot);
    const x = await context();
    await assertHooksEmpty();
    const scope = [`--git-dir=${gitdir}`, `--work-tree=${slot}`];
    return exec(c.op, slot, [...x.args, ...identityArgs(x, c.identity), ...scope, ...c.args], c.timeoutMs ?? timeoutMs, c.service);
  }

  /** The toplevel itself, otherwise a slot. */
  function inDir(cwd: string, c: Call): Promise<ProcessResult> {
    return foldCase(resolve(cwd)) === foldCase(resolve(toplevel)) ? inRepo(c) : inSlot(cwd, c);
  }

  async function ok(result: Promise<ProcessResult>, op: string): Promise<ProcessResult> {
    const r = await result;
    if (r.code !== 0) throw gitFailure(op, r);
    return r;
  }

  // ---- version and ref names ----

  async function version(): Promise<string> {
    if (versionCache !== undefined) return versionCache;
    const r = await ok(exec("version", toplevel, ["--version"], timeoutMs), "version");
    const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(r.stdout);
    if (m === null) throw new ExecutorError("E_GIT", "cannot parse the git version", { op: "version", code: r.code, stderr: "" });
    const found = [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
    const text = found.join(".");
    for (let n = 0; n < MIN_GIT_VERSION.length; n++) {
      const have = found[n] ?? 0;
      const need = MIN_GIT_VERSION[n] ?? 0;
      if (have > need) break;
      if (have < need) throw new ExecutorError("E_GIT", `git ${text} is older than the required ${MIN_GIT_VERSION.join(".")}`, { op: "version", code: 0, stderr: text });
    }
    versionCache = text;
    return text;
  }

  async function checkRefFormat(name: string): Promise<void> {
    const known = refFormatCache.get(name);
    if (known === true) return;
    if (known === false) throw invalid("invalid ref name", { name: name.slice(0, 120) });
    const wellFormed = typeof name === "string" && name !== "" && name.length <= 250 && !name.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(name);
    if (!wellFormed) { refFormatCache.set(String(name), false); throw invalid("invalid ref name", { name: String(name).slice(0, 120) }); }
    const r = await exec("check-ref-format", toplevel, [...hardeningArgs(), "check-ref-format", `refs/heads/${name}`], timeoutMs);
    if (r.code === 0) { refFormatCache.set(name, true); return; }
    if (r.code === 1) { refFormatCache.set(name, false); throw invalid("invalid ref name", { name: name.slice(0, 120) }); }
    throw gitFailure("check-ref-format", r);
  }

  async function planRef(name: string, what: string): Promise<string> {
    if (typeof name !== "string" || !name.startsWith(planPrefix) || name.length === planPrefix.length) {
      throw invalid(`${what} must be under ${planPrefix}`, { name: String(name).slice(0, 120) });
    }
    await checkRefFormat(name);
    return name;
  }

  // ---- slot pointers (memo §2.2) ----

  async function samePath(a: string, b: string): Promise<boolean> {
    if (foldCase(resolve(a)) === foldCase(resolve(b))) return true;
    try {
      return foldCase(await d.fs.realpath(a)) === foldCase(await d.fs.realpath(b));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  }

  function repoCommonDir(): string {
    if (commonCache !== undefined) return commonCache;
    let pointers;
    try { pointers = gitPointers(toplevel); } catch (error) {
      throw new ExecutorError("E_GIT", `cannot read the repository pointers: ${errorText(error)}`, { toplevel });
    }
    if (pointers === undefined) throw new ExecutorError("E_GIT", "the toplevel is not a git checkout", { toplevel });
    commonCache = pointers.common;
    return pointers.common;
  }

  async function verifySlotPointers(slot: string): Promise<{ gitdir: string; common: string }> {
    if (typeof slot !== "string" || !isAbsolute(slot)) throw invalid("slot path must be absolute", { slot: String(slot).slice(0, 200) });
    const broken = (why: string) => new ExecutorError("E_SLOT_BROKEN", `slot ${slot}: ${why}`, { slot, why });
    const slotStat = await d.fs.lstat(slot);
    if (slotStat === null) throw broken("the slot directory does not exist");
    if (slotStat.kind !== "dir") throw broken(`the slot is not a real directory (${slotStat.kind})`);
    try {
      // The slot itself must not be a link: its real path is its parent's real path plus its own name.
      const parentReal = await d.fs.realpath(dirname(slot));
      if (foldCase(await d.fs.realpath(slot)) !== foldCase(join(parentReal, basename(slot)))) throw broken("the slot resolves through a link");
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      throw broken(`cannot resolve the slot (${errorText(error)})`);
    }
    let pointers;
    try { pointers = gitPointers(slot); } catch (error) { throw broken(errorText(error)); }
    if (pointers === undefined) throw broken(".git is missing or names no git directory");
    if (!pointers.file) throw broken(".git is not a regular file");
    if (!pointers.linked) throw broken(".git does not name a linked worktree");
    const common = repoCommonDir();
    if (!(await samePath(pointers.common, common))) throw broken("its common directory is not the repository's");
    if (!(await samePath(dirname(pointers.gitdir), join(common, "worktrees"))) || basename(pointers.gitdir) === "") {
      throw broken("its git directory is not under <common>/worktrees");
    }
    let back: string;
    try { back = await d.fs.readText(join(pointers.gitdir, "gitdir")); } catch (error) {
      throw broken(`cannot read the worktree back-pointer (${errorText(error)})`);
    }
    const target = (back.split(/\r?\n/, 1)[0] ?? "").trim();
    if (target === "" || back.length > 4096 || isNetworkOrDevicePath(target)) throw broken("its back-pointer is unusable");
    // Lexical on purpose: a realpath would follow a link planted at the slot's `.git` or at the back-pointer's target.
    if (foldCase(resolve(pointers.gitdir, target)) !== foldCase(resolve(join(slot, ".git")))) throw broken("its back-pointer does not return to the slot");
    return { gitdir: pointers.gitdir, common };
  }

  // ---- worktrees ----

  async function worktreeList(): Promise<WorktreeEntry[]> {
    const r = await ok(inRepo({ op: "worktree list", args: ["worktree", "list", "--porcelain"] }), "worktree list");
    const entries: WorktreeEntry[] = [];
    let current: WorktreeEntry | undefined;
    for (const raw of r.stdout.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line.startsWith("worktree ")) {
        current = { path: resolve(line.slice("worktree ".length)), head: null, branch: null, locked: null };
        entries.push(current);
      } else if (current === undefined) continue;
      else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
      else if (line === "locked") current.locked = "";
      else if (line.startsWith("locked ")) current.locked = line.slice("locked ".length);
    }
    return entries;
  }

  function requireLockReason(reason: string): string {
    if (typeof reason !== "string" || !LOCK_REASON_PATTERN.test(reason)) throw invalid("invalid worktree lock reason", { reason: String(reason).slice(0, 80) });
    return reason;
  }

  async function worktreeAdd(path: string, commit: string, lockReason: string): Promise<void> {
    if (typeof path !== "string" || !isAbsolute(path)) throw invalid("worktree path must be absolute", { path: String(path).slice(0, 200) });
    requireCommit(commit, "commit");
    requireLockReason(lockReason);
    await version();
    await ok(inRepo({
      op: "worktree add", timeoutMs: GIT_WORKTREE_ADD_TIMEOUT_MS, identity: true,
      args: ["worktree", "add", "--detach", "--lock", "--reason", lockReason, path, commit],
    }), "worktree add");
  }

  async function worktreeRemove(path: string, lockReason: string): Promise<void> {
    if (typeof path !== "string" || !isAbsolute(path)) throw invalid("worktree path must be absolute", { path: String(path).slice(0, 200) });
    requireLockReason(lockReason);
    if ((await d.fs.lstat(path)) !== null) {
      throw new ExecutorError("E_GIT", "worktree directory still exists; remove it before dropping the worktree entry", { op: "worktree remove", path });
    }
    const entry = (await worktreeList()).find(w => foldCase(w.path) === foldCase(resolve(path)));
    if (entry === undefined) return;
    if (entry.locked !== null) {
      if (entry.locked !== lockReason) {
        throw new ExecutorError("E_GIT", "worktree is locked by someone else", { op: "worktree remove", path, reason: entry.locked.slice(0, 200) });
      }
      await ok(inRepo({ op: "worktree unlock", args: ["worktree", "unlock", path] }), "worktree unlock");
    }
    await ok(inRepo({ op: "worktree remove", args: ["worktree", "remove", "--force", path] }), "worktree remove");
  }

  // ---- working tree ----

  async function exists(p: string): Promise<boolean> {
    return (await d.fs.lstat(p)) !== null;
  }

  async function checkoutDetach(slot: string, commit: string): Promise<void> {
    requireCommit(commit, "commit");
    const { gitdir } = await verifySlotPointers(slot);
    const states: Array<{ files: string[]; quit: string[] }> = [
      { files: ["rebase-merge", "rebase-apply"], quit: ["rebase", "--quit"] },
      { files: ["CHERRY_PICK_HEAD", "sequencer"], quit: ["cherry-pick", "--quit"] },
      { files: ["REVERT_HEAD", "sequencer"], quit: ["revert", "--quit"] },
      { files: ["MERGE_HEAD"], quit: ["merge", "--quit"] },
    ];
    for (const state of states) {
      let present = false;
      for (const file of state.files) present = present || await exists(join(gitdir, file));
      if (present) await ok(inSlot(slot, { op: state.quit.join(" "), args: state.quit }), state.quit.join(" "));
    }
    await ok(inSlot(slot, { op: "checkout", identity: true, args: ["checkout", "--detach", "--force", commit, "--"] }), "checkout");
  }

  function cleanExcludes(keep: readonly string[]): string[] {
    const excludes: string[] = [];
    for (const k of keep) {
      if (typeof k !== "string" || k === "" || k.length > 400 || /[\u0000-\u001f\u007f]/.test(k)) throw invalid("invalid clean exclusion", { keep: String(k).slice(0, 80) });
      excludes.push("-e", k);
    }
    return excludes;
  }

  /** Reads one git C-quoted path (`"a\tb"`, octal escapes are UTF-8 bytes) or returns the text unchanged. */
  function unquoteGitPath(text: string): string {
    if (text.length < 2 || !text.startsWith("\"") || !text.endsWith("\"")) return text;
    const bytes: number[] = [];
    const body = text.slice(1, -1);
    const simple: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "\"": 34 };
    for (let n = 0; n < body.length; n++) {
      const c = body.charAt(n);
      if (c !== "\\") { bytes.push(...Buffer.from(c, "utf8")); continue; }
      const next = body.charAt(n + 1);
      const octal = /^[0-3][0-7]{2}$/.exec(body.slice(n + 1, n + 4));
      if (octal !== null) { bytes.push(parseInt(octal[0], 8)); n += 3; continue; }
      const code = simple[next];
      if (code === undefined) { bytes.push(92); continue; }
      bytes.push(code);
      n += 1;
    }
    return Buffer.from(bytes).toString("utf8");
  }

  /**
   * The paths `git clean -ffndx -e <keep>` would delete, relative to the slot with "/" separators (a directory ends in "/").
   * The same argument vector as the real clean (`cleanTracked`, `cleanForChecks`), so the caller can sweep exactly what git deletes.
   */
  async function cleanPreview(slot: string, keep: readonly string[]): Promise<string[]> {
    const r = await ok(inSlot(slot, { op: "clean -n", args: ["-c", "core.quotePath=false", "clean", "-ffndx", ...cleanExcludes(keep)] }), "clean -n");
    const out: string[] = [];
    for (const raw of r.stdout.split("\n")) {
      const line = raw.replace(/\r$/, "");
      if (line === "") continue;
      const prefix = line.startsWith("Would remove ") ? "Would remove " : line.startsWith("Would skip repository ") ? "Would skip repository " : null;
      if (prefix === null) throw new ExecutorError("E_GIT", "unparseable git clean preview line", { op: "clean -n", code: 0, stderr: line.slice(0, 200) });
      out.push(unquoteGitPath(line.slice(prefix.length)));
    }
    return out;
  }

  /** Reset-time clean: `-x` so ignored files of the previous owner do not carry over; only `keep` survives. */
  async function cleanTracked(slot: string, keep: readonly string[]): Promise<void> {
    await ok(inSlot(slot, { op: "clean", args: ["clean", "-q", "-ffdx", ...cleanExcludes(keep)] }), "clean");
  }

  /**
   * Before the clean: `checkout --force HEAD -- .` restores every tracked file the agent changed or deleted (the 3.1 task
   * runner commits before it calls this, so nothing worth keeping is reverted). After it the status must be empty.
   */
  async function cleanForChecks(slot: string, keep: readonly string[]): Promise<void> {
    const excludes = cleanExcludes(keep);
    await ok(inSlot(slot, { op: "checkout", identity: true, args: ["checkout", "--force", "HEAD", "--", "."] }), "checkout");
    await ok(inSlot(slot, { op: "clean", args: ["clean", "-q", "-ffdx", ...excludes] }), "clean");
    const left = await ok(inSlot(slot, { op: "clean -n", args: ["clean", "-ffndx", ...excludes] }), "clean -n");
    if (left.stdout.trim() !== "") {
      throw new ExecutorError("E_GIT", "files remain after clean", { op: "clean -n", code: 0, stderr: tailBytes(left.stdout, GIT_STDERR_TAIL_BYTES) });
    }
    const dirty = await statusPorcelain(slot);
    if (dirty.length !== 0) {
      throw new ExecutorError("E_GIT", `${dirty.length} path(s) still differ from HEAD after the clean`, {
        op: "status", code: 0, stderr: dirty.slice(0, 20).map(e => `${e.xy} ${e.path}`).join("\n").slice(0, GIT_STDERR_TAIL_BYTES),
      });
    }
  }

  /** The tracked paths of the index (pathspec-limited with `pathspecs`, matched literally), "/"-separated. */
  async function lsFiles(slot: string, pathspecs: readonly string[] = []): Promise<string[]> {
    for (const p of pathspecs) if (typeof p !== "string" || p === "" || /[\u0000-\u001f\u007f]/.test(p)) throw invalid("invalid pathspec", { pathspec: String(p).slice(0, 80) });
    const r = await ok(inSlot(slot, {
      op: "ls-files", args: ["ls-files", "-z", "--cached", "--full-name", ...(pathspecs.length === 0 ? [] : ["--", ...pathspecs.map(p => `:(literal)${p}`)])],
    }), "ls-files");
    return splitNul(r.stdout);
  }

  /** The tracked paths whose index mode is 120000 (symlinks): the only links a sweep must leave in place. */
  async function trackedLinks(slot: string): Promise<string[]> {
    const r = await ok(inSlot(slot, { op: "ls-files -s", args: ["ls-files", "-s", "-z", "--full-name"] }), "ls-files -s");
    const out: string[] = [];
    for (const entry of splitNul(r.stdout)) {
      const tab = entry.indexOf("\t");
      if (tab > 0 && entry.startsWith("120000 ")) out.push(entry.slice(tab + 1));
    }
    return out;
  }

  async function statusPorcelain(slot: string): Promise<StatusEntry[]> {
    const r = await ok(inSlot(slot, {
      op: "status", args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    }), "status");
    const parts = r.stdout.split("\0");
    const out: StatusEntry[] = [];
    for (let n = 0; n < parts.length; n++) {
      const entry = parts[n] ?? "";
      if (entry === "") continue;
      if (entry.length < 4 || entry.charAt(2) !== " ") throw new ExecutorError("E_GIT", "unparseable git status entry", { op: "status", code: 0, stderr: "" });
      const xy = entry.slice(0, 2);
      const renamed = xy.includes("R") || xy.includes("C");
      out.push({ xy, path: entry.slice(3), orig: renamed ? (parts[++n] ?? null) : null });
    }
    return out;
  }

  // ---- commits ----

  async function addAll(slot: string): Promise<void> {
    await ok(inSlot(slot, { op: "add", args: ["add", "--all"] }), "add");
  }

  function requireMessage(message: string): string {
    if (typeof message !== "string" || !COMMIT_SUBJECT_PATTERN.test(message)) throw invalid("commit message does not match the executor pattern", { message: String(message).slice(0, 200) });
    return message;
  }

  function commitArgs(message: string): string[] {
    return ["commit", "--no-verify", "--no-gpg-sign", "--cleanup=verbatim", "-m", message];
  }

  async function revParse(cwd: string, rev: string): Promise<string> {
    if (typeof rev !== "string" || rev === "" || rev.length > 300 || /[\u0000-\u001f\u007f]/.test(rev)) throw invalid("invalid revision", { rev: String(rev).slice(0, 120) });
    const r = await ok(inDir(cwd, { op: "rev-parse", args: ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`] }), "rev-parse");
    const oid = r.stdout.trim();
    if (!GIT_ID_PATTERN.test(oid)) throw new ExecutorError("E_GIT", "rev-parse did not print an object id", { op: "rev-parse", code: r.code, stderr: "" });
    return oid;
  }

  async function commit(slot: string, message: string): Promise<string> {
    requireMessage(message);
    await ok(inSlot(slot, { op: "commit", identity: true, args: commitArgs(message) }), "commit");
    return revParse(slot, "HEAD");
  }

  async function diffNames(cwd: string, from: string, to: string): Promise<string[]> {
    requireCommit(from, "from");
    requireCommit(to, "to");
    const r = await ok(inDir(cwd, { op: "diff", args: ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", from, to, "--"] }), "diff");
    return splitNul(r.stdout);
  }

  /** After a failed cherry-pick/revert: read the conflicted paths, abort, and report them. */
  async function conflictOutcome(op: string, slot: string, failed: ProcessResult, abort: readonly string[], resetFallback: boolean): Promise<Conflict> {
    const listed = await ok(inSlot(slot, { op: `${op} conflicts`, args: ["diff", "--name-only", "--diff-filter=U", "-z"] }), `${op} conflicts`);
    const conflicts = [...new Set(splitNul(listed.stdout))];
    const aborted = await inSlot(slot, { op: `${op} --abort`, args: abort });
    if (aborted.code !== 0) {
      if (!resetFallback) throw gitFailure(`${op} --abort`, aborted);
      await ok(inSlot(slot, { op: "reset", args: ["reset", "--hard", "--quiet", "HEAD"] }), "reset");
    }
    if (conflicts.length === 0) throw gitFailure(op, failed);
    return { ok: false, conflicts };
  }

  async function rebaseOnto(slot: string, onto: string, upstream: string, observation?: ServiceObservation): Promise<{ ok: true; head: string } | Conflict> {
    const diagnostic = gitService(observation, "rebase");
    try {
      requireCommit(onto, "onto");
      requireCommit(upstream, "upstream");
      const r = await inSlot(slot, { op: "rebase", identity: true, args: ["rebase", "--onto", onto, upstream], service: diagnostic });
      if (r.code === 0) return { ok: true, head: await revParse(slot, "HEAD") };
      const failed = gitFailure("rebase", r);
      let conflicts: string[] = [];
      try {
        // Git can refuse before starting a rebase. An abort then only masks the initiating failure.
        if (await rebaseInProgress(slot)) {
          const listed = await ok(inSlot(slot, { op: "rebase conflicts", args: ["diff", "--name-only", "--diff-filter=U", "-z"] }), "rebase conflicts");
          conflicts = [...new Set(splitNul(listed.stdout))];
          await rebaseAbort(slot);
        }
      } catch (cleanup) {
        throw new ExecutorError(cleanup instanceof ExecutorError ? cleanup.code : "E_GIT",
          `${failed.message}; rebase cleanup failed: ${tailBytes(stripUrlUserinfo(errorText(cleanup)), GIT_STDERR_TAIL_BYTES)}`,
          { original: failed.detail, cleanup: cleanup instanceof ExecutorError ? cleanup.detail : null });
      }
      if (conflicts.length === 0) throw failed;
      return { ok: false, conflicts };
    } catch (error) { diagnostic?.preparation?.end("error"); throw error; }
    finally { diagnostic?.preparation?.end("completed"); }
  }

  async function rebaseInProgress(slot: string): Promise<boolean> {
    const { gitdir } = await verifySlotPointers(slot);
    return await exists(join(gitdir, "rebase-merge")) || await exists(join(gitdir, "rebase-apply"));
  }

  async function rebaseAbort(slot: string): Promise<void> {
    if (!(await rebaseInProgress(slot))) return;
    await ok(inSlot(slot, { op: "rebase --abort", args: ["rebase", "--abort"] }), "rebase --abort");
  }

  async function cherryPick(slot: string, commits: readonly string[]): Promise<{ ok: true; head: string } | Conflict> {
    if (commits.length === 0) throw invalid("no commits to cherry-pick");
    for (const c of commits) requireCommit(c, "commit");
    const r = await inSlot(slot, { op: "cherry-pick", identity: true, args: ["cherry-pick", "--no-edit", ...commits] });
    if (r.code === 0) return { ok: true, head: await revParse(slot, "HEAD") };
    return conflictOutcome("cherry-pick", slot, r, ["cherry-pick", "--abort"], false);
  }

  async function revert(slot: string, commitId: string, message: string): Promise<{ ok: true; head: string } | Conflict> {
    requireCommit(commitId, "commit");
    requireMessage(message);
    const r = await inSlot(slot, { op: "revert", identity: true, args: ["revert", "--no-commit", commitId] });
    if (r.code !== 0) return conflictOutcome("revert", slot, r, ["revert", "--abort"], true);
    await ok(inSlot(slot, { op: "commit", identity: true, args: commitArgs(message) }), "commit");
    return { ok: true, head: await revParse(slot, "HEAD") };
  }

  async function isAncestor(a: string, b: string): Promise<boolean> {
    requireCommit(a, "a");
    requireCommit(b, "b");
    const r = await inRepo({ op: "merge-base", args: ["merge-base", "--is-ancestor", a, b] });
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw gitFailure("merge-base", r);
  }

  async function mergeFfOnly(cwd: string, commitId: string, observation?: ServiceObservation): Promise<{ ok: boolean; head: string }> {
    const diagnostic = gitService(observation, "merge");
    try {
      requireCommit(commitId, "commit");
      const before = await revParse(cwd, "HEAD");
      if (!(await isAncestor(before, commitId))) return { ok: false, head: before };
      await ok(inDir(cwd, { op: "merge", identity: true, args: ["merge", "--ff-only", "--no-edit", commitId], service: diagnostic }), "merge");
      return { ok: true, head: await revParse(cwd, "HEAD") };
    } catch (error) { diagnostic?.preparation?.end("error"); throw error; }
    finally { diagnostic?.preparation?.end("completed"); }
  }

  // ---- refs ----

  async function tag(name: string, commitId: string): Promise<void> {
    requireCommit(commitId, "commit");
    await planRef(name, "tag name");
    await ok(inRepo({ op: "tag", identity: true, args: ["tag", name, commitId] }), "tag");
  }

  async function deleteRefs(prefix: string): Promise<string[]> {
    if (typeof prefix !== "string" || !prefix.startsWith(planPrefix) || !prefix.endsWith("/")) {
      throw invalid(`prefix must be ${planPrefix} or a deeper "/"-terminated prefix of it`, { prefix: String(prefix).slice(0, 120) });
    }
    if (prefix.slice(0, -1).split("/").some(segment => segment === "" || segment.includes(".."))) {
      throw invalid("prefix has an empty or '..' segment", { prefix: prefix.slice(0, 120) });
    }
    await checkRefFormat(`${prefix}x`);
    const listed = await ok(inRepo({
      op: "for-each-ref",
      args: ["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/heads/${prefix}`, `refs/tags/${prefix}`],
    }), "for-each-ref");
    const found: Array<{ ref: string; oid: string }> = [];
    for (const line of listed.stdout.split("\n")) {
      if (line === "") continue;
      const [ref = "", oid = ""] = line.replace(/\r$/, "").split("\0");
      const under = ref.startsWith(`refs/heads/${prefix}`) || ref.startsWith(`refs/tags/${prefix}`);
      if (!under || !GIT_ID_PATTERN.test(oid)) continue;
      found.push({ ref, oid });
    }
    const checkedOut = new Set((await worktreeList()).map(w => w.branch).filter((b): b is string => b !== null));
    const deleted: string[] = [];
    for (const { ref, oid } of found) {
      if (checkedOut.has(ref)) continue;
      await ok(inRepo({ op: "update-ref -d", identity: true, args: ["update-ref", "-d", "--no-deref", ref, oid] }), "update-ref -d");
      deleted.push(ref);
    }
    return deleted;
  }

  async function branchForce(name: string, commitId: string, expectedOld: string | null, observation?: ServiceObservation): Promise<void> {
    const diagnostic = gitService(observation, "cas");
    try {
      requireCommit(commitId, "commit");
      await planRef(name, "branch name");
      if (expectedOld !== null && (typeof expectedOld !== "string" || expectedOld === "")) throw invalid("expectedOld is required: a full object id, or null for a branch that must not exist");
      const old = expectedOld === null ? "0".repeat(commitId.length) : requireCommit(expectedOld, "expectedOld");
      const ref = `refs/heads/${name}`;
      if ((await worktreeList()).some(w => w.branch === ref)) {
        throw new ExecutorError("E_GIT", "branch is checked out in a worktree", { op: "update-ref", code: null, stderr: name.slice(0, 200) });
      }
      const symbolic = await inRepo({ op: "symbolic-ref", args: ["symbolic-ref", "-q", ref] });
      if (symbolic.code === 0) throw new ExecutorError("E_GIT", "branch is a symbolic ref", { op: "symbolic-ref", code: 0, stderr: name.slice(0, 200) });
      if (symbolic.code !== 1) throw gitFailure("symbolic-ref", symbolic);
      await ok(inRepo({ op: "update-ref", identity: true, args: ["update-ref", "--no-deref", ref, commitId, old], service: diagnostic }), "update-ref");
    } catch (error) { diagnostic?.preparation?.end("error"); throw error; }
    finally { diagnostic?.preparation?.end("completed"); }
  }

  return {
    planId: d.planId, version, checkRefFormat, verifySlotPointers, worktreeAdd, worktreeRemove, worktreeList,
    checkoutDetach, cleanTracked, cleanForChecks, cleanPreview, lsFiles, trackedLinks, statusPorcelain, addAll, commit, revParse, diffNames,
    rebaseOnto, rebaseAbort, cherryPick, revert, mergeFfOnly, isAncestor, tag, deleteRefs, branchForce,
  };
}
