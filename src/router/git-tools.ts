import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { tool } from "@opencode-ai/plugin";
import { filterSensitiveDiff, isSensitivePath, sensitiveGitPathspecs } from "./sensitive-paths";

export const GIT_OPERATIONS = ["status", "log", "diff", "show", "blame", "ls_files"] as const;
export type GitOperation = typeof GIT_OPERATIONS[number];
export const GIT_TOOL_NAMES = GIT_OPERATIONS.map(name => `router_git_${name}`);
export interface GitInput { path?: string; ref?: string; limit?: number; mode?: "patch" | "stat" | "name-only" | "cached" }
/** Extra inspection context: the session's project worktree (discovery boundary) and pre-resolved executables. */
export interface GitInspectOptions { worktree?: string; executables?: readonly string[] }

const MAX_BYTES = 64 * 1024;
const DEADLINE_MS = 15_000;
/** After a kill is requested: fall back to child.kill() if the process has not exited yet. */
const KILL_FALLBACK_MS = 500;
/** After a kill is requested: settle even if neither `exit` nor `close` arrives. */
const SETTLE_GRACE_MS = 1_000;
/** After `exit`: how long helpers that inherited the pipes may keep `close` from firing. */
const DRAIN_AFTER_KILL_MS = 200;
const DRAIN_AFTER_EXIT_MS = 1_000;
/** How long a settled call waits for taskkill to finish removing the tree. */
const KILL_WAIT_MS = 300;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_LINK_CHECKS = 50_000;
const MAX_LINKED_EXCLUDES = 200;
const LSTAT_BATCH = 64;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const DRIVER_KEYS = /^(filter|diff)\.(.+)\.(clean|smudge|process|textconv|command)$/;
const REPOSITORY_QUERY = "^((filter|diff)\\..+\\.(clean|smudge|process|textconv|command)|core\\.(autocrlf|eol|safecrlf|longpaths))$";
const INHERITED_QUERY = "^(core\\.(autocrlf|eol|safecrlf|longpaths)|safe\\.directory)$";
const BOOLEAN = /^(true|false|yes|no|on|off|1|0)$/i;
/** Non-executing settings Git for Windows commonly keeps in system/global config (G9). Nothing here can name a program. */
const INHERITED_VALUES = new Map<string, RegExp>([
  ["core.autocrlf", /^(true|false|input|yes|no|on|off|1|0)$/i],
  ["core.eol", /^(lf|crlf|native)$/i],
  ["core.safecrlf", /^(true|false|warn|yes|no|on|off|1|0)$/i],
  ["core.longpaths", BOOLEAN],
  ["safe.directory", /^[^\x00-\x1f\x7f]{0,4096}$/],
]);
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)$/i;
const WINDOWS_SPOOF = /[\u00a0\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** lstat that reports a missing path (or a file used as a directory) as undefined. */
function lstatOrUndefined(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined;
    throw error;
  }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
}

function realpath(path: string): string { return realpathSync.native(path); }

export function validateRef(ref: string): string {
  if (!ref || ref.length > 200 || ref.startsWith("-") || !/^[A-Za-z0-9._/@{}~^-]+$/.test(ref)) {
    throw new Error("Invalid git ref: use at most 200 ref characters, never an option or rev:path; use read for sensitive files (asks for approval)");
  }
  return ref;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

/**
 * Literal repo-relative paths only. Existing ancestors are checked too: none may
 * resolve outside the repository or be a symlink/junction (G5), and on Windows
 * device names, trailing dots/spaces and spoofing characters are rejected (G13).
 */
export function validatePath(root: string, path: string, platform: NodeJS.Platform = process.platform): string {
  if (!path || path.length > 4096 || path.startsWith("-") || /[\x00-\x1f:]/.test(path)
    || isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid git path: expected a relative path inside the repository");
  }
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(part => part !== "" && part !== ".");
  if (platform === "win32") {
    if (WINDOWS_SPOOF.test(path)) throw new Error("Invalid git path: no-break space or bidirectional control character");
    for (const part of parts) {
      if (/[. ]$/.test(part)) throw new Error("Invalid git path: trailing dot or space in a path component");
      if (WINDOWS_DEVICE.test(part.split(".")[0]!.trimEnd())) throw new Error("Invalid git path: reserved Windows device name");
    }
  }
  const absolute = resolve(root, normalized);
  if (!inside(root, absolute)) throw new Error("Git path escapes repository");
  let ancestor = absolute;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  if (!inside(realpath(root), realpath(ancestor))) throw new Error("Git path symlink escapes repository");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stats = lstatOrUndefined(current);
    if (!stats) break;
    if (stats.isSymbolicLink() && (index < parts.length - 1 || isDirectory(current))) {
      throw new Error("Git path crosses a symlinked or junction directory");
    }
  }
  return normalized;
}

function strippedEnvironment(): NodeJS.ProcessEnv {
  // Inherited GIT_CONFIG_COUNT/KEY/VALUE, GIT_DIR, tracing, helpers and alternate
  // object directories must not redirect inspection or re-enable executable config.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
}

export function gitEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Pathspecs carry explicit `:(literal)` magic instead of GIT_LITERAL_PATHSPECS, so
  // the tools can add `:(exclude,literal)` pathspecs for linked directories (G5).
  return { ...strippedEnvironment(), GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat", GIT_NO_LAZY_FETCH: "1", ...extra };
}

export function hardeningArgs(): string[] {
  return ["--no-optional-locks", "--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=",
    "-c", `core.hooksPath=${NULL_DEVICE}`, "-c", "protocol.allow=never",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "color.ui=false",
    // G2: signature display would run gpg.program; blank every signing program too.
    "-c", "log.showSignature=false", "-c", "gpg.program=", "-c", "gpg.ssh.program=", "-c", "gpg.x509.program=",
    // G3: diff's opportunistic index refresh writes .git even with --no-optional-locks.
    "-c", "diff.autoRefreshIndex=false", "-c", "core.splitIndex=false", "-c", "index.threads=1"];
}

function validateInput(operation: GitOperation, input: GitInput): { ref?: string } {
  if (!GIT_OPERATIONS.includes(operation)) throw new Error("Invalid git operation");
  if (input.path && isSensitivePath(input.path)) throw new Error("Sensitive git path refused; use read (asks for approval)");
  const ref = input.ref === undefined ? undefined : validateRef(input.ref);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50)) throw new Error("Git log limit must be 1..50");
  if (input.mode !== undefined && !["patch", "stat", "name-only", "cached"].includes(input.mode)) throw new Error("Invalid git diff mode");
  if (operation === "blame" && input.path === undefined) throw new Error("Git blame requires path");
  return { ref };
}

/**
 * Fixed argv for one inspection. `config` holds additional top-level options
 * (neutralized drivers, inherited settings, attribute source) placed right after
 * the hardening; `exclude` lists repository paths hidden with exclude pathspecs.
 */
export function gitArgv(operation: GitOperation, input: GitInput, root: string,
  extra: { config?: readonly string[]; exclude?: readonly string[] } = {}): string[] {
  const { ref } = validateInput(operation, input);
  const path = input.path === undefined ? undefined : validatePath(root, input.path);
  const args = [...hardeningArgs(), ...(extra.config ?? [])];
  switch (operation) {
    case "status": args.push("status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=all"); break;
    case "log": args.push("log", "--patch", "--src-prefix=a/", "--dst-prefix=b/", "--submodule=short", "--no-show-signature", "--no-ext-diff", "--no-textconv", `--max-count=${input.limit ?? 20}`, "--format=medium", ...(ref ? [ref] : [])); break;
    case "diff": args.push("diff", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--submodule=short",
      ...(input.mode && input.mode !== "patch" ? [`--${input.mode}`] : []), ...(ref ? [ref] : [])); break;
    case "show": args.push("show", "--src-prefix=a/", "--dst-prefix=b/", "--no-show-signature", "--no-ext-diff", "--no-textconv", "--format=medium", "--submodule=short", ref ?? "HEAD"); break;
    case "blame":
      // G6: never read blame.ignoreRevsFile (it may name a file outside the repository).
      // Blame takes one literal path, not a pathspec.
      args.push("blame", "--no-textconv", "--no-ignore-revs-file", ...(ref ? [ref] : []));
      return [...args, "--", path ?? ""];
    case "ls_files": args.push("ls-files", "--cached"); break;
  }
  // Blame accepts one literal filename, not exclusion pathspecs: explicit
  // sensitive paths were refused above. Status/ls-files may list names only.
  return [...args, "--", ...(path ? [`:(literal)${path}`] : []),
    ...(["show", "diff", "log"].includes(operation) ? sensitiveGitPathspecs() : []),
    ...(extra.exclude ?? []).map(dir => `:(exclude,literal)${dir}`)];
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function realFile(path: string): string | undefined {
  try {
    const real = realpath(path);
    return statSync(real).isFile() ? real : undefined;
  } catch (error) {
    if (errorCode(error) === undefined) throw error;
    return undefined; // missing, unreadable or a broken link: not a candidate
  }
}

function registryGitInstall(env: NodeJS.ProcessEnv): string[] {
  const reg = join(envValue(env, "SystemRoot") ?? "C:\\Windows", "System32", "reg.exe");
  const found: string[] = [];
  for (const key of ["HKLM\\SOFTWARE\\GitForWindows", "HKCU\\SOFTWARE\\GitForWindows"]) {
    const result = spawnSync(reg, ["query", key, "/v", "InstallPath"], { encoding: "utf8", windowsHide: true, timeout: 5_000, shell: false });
    const match = /InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(result.stdout ?? "");
    if (match?.[1]) found.push(join(match[1], "cmd", "git.exe"));
  }
  return found;
}

/**
 * Every plausible git executable, best first, as real paths. On Windows the Git
 * for Windows install (Program Files, else the installer's registry key) is
 * preferred over PATH; git.cmd/git.bat, relative PATH entries and cwd lookups are
 * never considered. Callers filter candidates that live inside the session (G4).
 */
export function gitCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const found: string[] = [];
  const add = (file: string) => {
    if (!isAbsolute(file)) return;
    const real = realFile(file);
    if (real && !found.includes(real)) found.push(real);
  };
  if (platform === "win32") {
    for (const name of ["ProgramFiles", "ProgramW6432"]) {
      const base = envValue(env, name);
      if (base) add(join(base, "Git", "cmd", "git.exe"));
    }
    if (found.length === 0) registryGitInstall(env).forEach(add);
  }
  for (const entry of (envValue(env, "PATH") ?? "").split(platform === "win32" ? ";" : delimiter)) {
    const dir = entry.replace(/^"|"$/g, "");
    if (dir && isAbsolute(dir)) add(join(dir, platform === "win32" ? "git.exe" : "git"));
  }
  return found;
}

let loadedCandidates: readonly string[] | undefined;
/** Resolved once (at plugin load, when gitTools() is built) and reused for every call. */
function defaultCandidates(): readonly string[] {
  loadedCandidates ??= gitCandidates();
  return loadedCandidates;
}

/** First candidate whose real path is outside every guarded directory. Nothing is spawned. */
export function selectGitExecutable(candidates: readonly string[], guarded: readonly string[]): string {
  if (candidates.length === 0) throw new Error("Git executable not found (Git for Windows install or absolute PATH entries)");
  const guards = guarded.map(dir => existsSync(dir) ? realpath(dir) : dir);
  for (const candidate of candidates) if (!guards.some(dir => inside(dir, candidate))) return candidate;
  throw new Error(`Refusing git executable inside the session repository: ${candidates[0]}`);
}

/** Git executable for the plugin process, without session guards (setup and tests). */
export function gitExecutable(): string {
  return selectGitExecutable(defaultCandidates(), []);
}

/** Empty tree id of the repository's object format, the `--attr-source` that disables in-tree attributes. */
export function emptyTreeId(format: string): string {
  if (format === "sha1") return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  if (format === "sha256") return "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";
  throw new Error("Unsupported repository object format");
}

/**
 * Remove URL credentials (G10): the whole `user:pass@` of scheme URLs (even with
 * a `/` or `@` in the password), scp-style `user[:pass]@host:path` anchored at the
 * start of a token, and credential-like query parameters. `image@sha256:` digests
 * and e-mail addresses are left alone.
 */
export function stripUrlUserinfo(text: string): string {
  // Quantifiers are bounded so minified single-line output cannot backtrack quadratically.
  return text
    .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)((?:(?![a-z][a-z0-9+.-]{0,31}:\/\/)\S)+)/gi, (_match, scheme: string, rest: string) => scheme + stripAuthority(rest))
    .replace(/(^|[\s"'`<>()[\]{}=,;])[^\s"'`<>()[\]{}=,;@/:]+(?::\S{0,256}?)?@(?!(?:sha|md|blake)\d*:)([A-Za-z0-9._-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\]):(?=\S)/g, "$1$2:")
    .replace(/([?&;][a-z0-9_.-]{0,64}?(?:token|password|passwd|pwd|secret|api[_-]?key|sig|signature|credential)=)[^\s&#"'<>]+/gi, "$1***");
}

function stripAuthority(rest: string): string {
  const separator = rest.search(/[/?#]/);
  const authority = separator === -1 ? rest : rest.slice(0, separator);
  // Normal case: the userinfo ends at the last @ of the authority (a password may hold @).
  const at = authority.lastIndexOf("@");
  if (at > 0) return rest.slice(at + 1);
  if (!authority.includes(":")) return rest;
  // `user:pa/ss@host`: the password itself contains a slash. Use the last @ that
  // is not a path segment such as /@scope/name (over-redaction is the safe side).
  for (let index = rest.lastIndexOf("@"); index > 0; index = rest.lastIndexOf("@", index - 1)) {
    if (rest[index - 1] !== "/") return rest.slice(index + 1);
  }
  return rest;
}

/**
 * Truncated output may end inside a credential, before the @ that identifies it.
 * Drop the final token from its last plausible credential start (a `scheme:` or
 * `user:`/`user@` at a token boundary); a token without `:`/`@` is kept, so a
 * minified single-line file still returns content.
 */
export function dropPartialCredential(text: string): string {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  const token = text.slice(start);
  if (!/[:@]/.test(token)) return text;
  let cut = -1;
  for (const found of token.matchAll(/(?:^|["'`<>()[\]{}=,;])(?=[^\s"'`<>()[\]{}=,;@/:]+[:@])/g)) cut = found.index + found[0].length;
  return cut === -1 ? text : text.slice(0, start + cut);
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== "win32") {
    try { process.kill(-pid, "SIGKILL"); } catch (error) {
      if (errorCode(error) !== "ESRCH") throw error; // ESRCH: the group already exited
    }
    return;
  }
  await new Promise<void>((done) => {
    const killer = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"],
      { shell: false, windowsHide: true, stdio: "ignore" });
    killer.once("error", error => {
      console.warn(`[model-router] router_git: taskkill failed to start (${error.message}); terminating git directly`);
      child.kill();
      done();
    });
    killer.once("close", () => done());
  });
}

interface BoundedOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv; separateStderr?: boolean }
interface BoundedResult { code: number | null; output: Buffer; stderr: Buffer; truncated: boolean }

/**
 * Spawn with byte, time and abort bounds. Settles on `close`, or shortly after
 * `exit` when helpers that inherited the pipes (MSYS sh/sleep re-parented away
 * from taskkill's tree) keep `close` from firing (G7).
 */
function spawnBounded(executable: string, args: readonly string[], cwd: string, options: BoundedOptions = {}): Promise<BoundedResult> {
  if (options.signal?.aborted) return Promise.reject(new Error("Git inspection aborted"));
  if (!isDirectory(cwd)) return Promise.reject(new Error("Git inspection directory does not exist"));
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env: options.env ?? gitEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    const max = options.maxBytes ?? MAX_BYTES;
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let errorBytes = 0;
    let truncated = false;
    let exited = false;
    let settled = false;
    let failure: string | undefined;
    let killing: Promise<void> | undefined;
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, run: () => void) => {
      const timer = setTimeout(() => { timers.delete(timer); run(); }, ms);
      timers.add(timer);
      return timer;
    };
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      options.signal?.removeEventListener("abort", abort);
      child.stdout.destroy(); child.stderr.destroy();
      outcome();
    };
    const finish = (code: number | null) => {
      if (settled) return;
      const done = () => settle(() => failure ? reject(new Error(failure))
        : resolveResult({ code, output: Buffer.concat(chunks), stderr: Buffer.concat(errors), truncated }));
      if (!killing) { done(); return; }
      void Promise.race([killing, new Promise(wait => setTimeout(wait, KILL_WAIT_MS))]).then(done);
    };
    const stop = () => {
      if (killing || settled) return;
      killing = killTree(child).catch((error: unknown) => {
        console.warn(`[model-router] router_git: could not kill the git process tree (${errorMessage(error)})`);
        child.kill("SIGKILL");
      });
      later(KILL_FALLBACK_MS, () => { if (!exited) child.kill("SIGKILL"); });
      later(SETTLE_GRACE_MS, () => finish(null));
    };
    const abort = () => { failure ??= "Git inspection aborted"; stop(); };
    const deadline = later(options.timeoutMs ?? DEADLINE_MS, () => { failure ??= "Git inspection timed out"; stop(); });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, max - bytes));
      if (kept.length) chunks.push(kept);
      bytes += kept.length;
      if (kept.length < chunk.length) { truncated = true; stop(); }
    };
    const collectError = (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, 8 * 1024 - errorBytes));
      if (kept.length) errors.push(kept);
      errorBytes += kept.length;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", options.separateStderr ? collectError : collect);
    child.once("error", error => settle(() => reject(error)));
    child.once("exit", code => {
      exited = true;
      clearTimeout(deadline); timers.delete(deadline);
      later(killing ? DRAIN_AFTER_KILL_MS : DRAIN_AFTER_EXIT_MS, () => finish(code));
    });
    child.once("close", code => finish(code));
  });
}

/** Internal runner; executable/argv/bounds are never exposed as tool input. */
export async function runBoundedProcess(executable: string, args: string[], cwd: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const result = await spawnBounded(executable, args, cwd, options);
  const max = options.maxBytes ?? MAX_BYTES;
  let text = result.output.toString("utf8");
  // A byte boundary must not expose part of a credential: trim BEFORE redacting.
  if (result.truncated) text = dropPartialCredential(text);
  text = stripUrlUserinfo(text);
  if (result.truncated) return `${text}\n[truncated: output exceeds ${max} bytes]`;
  if (result.code !== 0) throw new Error(`Git inspection failed (${result.code}): ${text}`);
  return text;
}

interface Budget { signal?: AbortSignal; timeoutMs: () => number }

async function query(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, budget: Budget, maxBytes = 1024 * 1024): Promise<BoundedResult> {
  const result = await spawnBounded(executable, args, cwd, { env, signal: budget.signal, timeoutMs: budget.timeoutMs(), maxBytes, separateStderr: true });
  if (result.truncated) throw new Error("Git inspection metadata exceeds its size bound");
  return result;
}

function queryFailure(label: string, result: BoundedResult): Error {
  return new Error(`${label} (${result.code}): ${stripUrlUserinfo(result.stderr.toString("utf8").trim())}`);
}

const attrSourceSupport = new Map<string, boolean>();
/** `--attr-source` exists from Git 2.40. Cached per executable once known. */
async function supportsAttrSource(executable: string, budget: Budget): Promise<boolean> {
  const known = attrSourceSupport.get(executable);
  if (known !== undefined) return known;
  const cwd = dirname(executable);
  const result = await query(executable, ["version"], cwd, gitEnvironment({ GIT_CEILING_DIRECTORIES: dirname(cwd) }), budget);
  const version = /git version (\d+)\.(\d+)/.exec(result.output.toString("utf8"));
  if (result.code !== 0 || !version) throw queryFailure("Cannot determine the git version", result);
  const supported = Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 40);
  attrSourceSupport.set(executable, supported);
  return supported;
}

/** Parse `git config -z --get-regexp` output into allowlisted `key=value` pairs (G9). */
export function parseInheritedConfig(raw: string): string[] {
  const pairs: string[] = [];
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
    const allowed = INHERITED_VALUES.get(key);
    // A value-less entry is boolean true (meaningless for safe.directory).
    const value = newline === -1 ? (key === "safe.directory" ? undefined : "true") : entry.slice(newline + 1);
    if (allowed && value !== undefined && allowed.test(value)) pairs.push(`${key}=${value}`);
  }
  return pairs;
}

const inheritedCache = new Map<string, readonly string[]>();
/**
 * System and global values of the allowlist, read as plain git would see them
 * (honouring the user's GIT_CONFIG_SYSTEM/GLOBAL/NOSYSTEM). Cached per executable
 * and configuration location.
 */
async function inheritedConfig(executable: string, budget: Budget): Promise<readonly string[]> {
  const passed: Record<string, string> = {};
  for (const name of ["GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    const value = process.env[name];
    if (value !== undefined) passed[name] = value;
  }
  const key = JSON.stringify([executable, passed, process.env.HOME, process.env.USERPROFILE, process.env.XDG_CONFIG_HOME]);
  const cached = inheritedCache.get(key);
  if (cached) return cached;
  const cwd = dirname(executable);
  const env: NodeJS.ProcessEnv = { ...strippedEnvironment(), ...passed, GIT_CEILING_DIRECTORIES: dirname(cwd),
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
  // `git config --system` ignores GIT_CONFIG_NOSYSTEM, so honour it here (git boolean: yes/on/true/non-zero).
  const nosystem = passed.GIT_CONFIG_NOSYSTEM ?? "";
  const scopes = /^(true|yes|on)$/i.test(nosystem) || (/^-?\d+$/.test(nosystem) && Number(nosystem) !== 0) ? ["--global"] : ["--system", "--global"];
  const pairs: string[] = [];
  for (const scope of scopes) {
    const result = await query(executable, [...hardeningArgs(), "config", scope, "-z", "--get-regexp", INHERITED_QUERY], cwd, env, budget, 64 * 1024);
    // 1: nothing set. Other failures (unreadable/malformed file) only lose fidelity.
    if (result.code === 0) pairs.push(...parseInheritedConfig(result.output.toString("utf8")));
  }
  inheritedCache.set(key, pairs);
  return pairs;
}

/**
 * Repository-level (local, worktree, included) driver programs and line-ending
 * settings. Every configured filter/diff program is blanked with `-c key=` (G1);
 * filters also become optional so a blank one is not a hard failure.
 */
async function repositoryConfig(executable: string, root: string, env: NodeJS.ProcessEnv, base: string[], budget: Budget): Promise<{ neutralize: string[]; overridden: Set<string> }> {
  const result = await query(executable, [...base, "config", "-z", "--name-only", "--get-regexp", REPOSITORY_QUERY], root, env, budget);
  if (result.code !== 0 && result.code !== 1) throw queryFailure("Cannot read repository configuration", result);
  const neutralize: string[] = [];
  const overridden = new Set<string>();
  const optional = new Set<string>();
  for (const key of result.output.toString("utf8").split("\0").filter(Boolean)) {
    const driver = DRIVER_KEYS.exec(key);
    if (!driver) { overridden.add(key.toLowerCase()); continue; }
    // `-c` splits at the first '=': such a key cannot be blanked, so refuse the repository.
    if (key.includes("=")) throw new Error("Refusing repository: a filter/diff driver name contains '=' and cannot be neutralized");
    neutralize.push("-c", `${key}=`);
    if (driver[1] === "filter") optional.add(`filter.${driver[2]}.required=false`);
  }
  for (const setting of optional) neutralize.push("-c", setting);
  return { neutralize, overridden };
}

/** Operations that read working-tree files. */
function readsWorktree(operation: GitOperation, input: GitInput): boolean {
  if (operation === "status") return true;
  if (operation === "diff") return input.mode !== "cached" && !(input.ref ?? "").includes("..");
  return false;
}

/**
 * Tracked directories that are now symlinks/junctions (G5). Node reports
 * junctions as symbolic links. Prefixes are deduplicated, checked shallow-first
 * in bounded batches, and descendants of a linked/missing directory are skipped.
 */
export async function linkedTrackedDirectories(root: string, trackedPaths: Iterable<string>, budget?: Budget): Promise<string[]> {
  const dirs = new Set<string>();
  for (const path of trackedPaths) {
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      const dir = path.slice(0, slash);
      if (dirs.has(dir)) break; // its ancestors were added with it
      dirs.add(dir);
    }
  }
  if (dirs.size > MAX_LINK_CHECKS) throw new Error(`Repository has too many tracked directories to verify for links (${dirs.size} > ${MAX_LINK_CHECKS})`);
  const levels = new Map<number, string[]>();
  for (const dir of dirs) {
    const depth = dir.split("/").length;
    levels.set(depth, [...(levels.get(depth) ?? []), dir]);
  }
  const blocked = new Set<string>();
  const linked: string[] = [];
  for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
    const level: string[] = [];
    for (const dir of levels.get(depth) ?? []) {
      const parent = dir.lastIndexOf("/");
      if (parent !== -1 && blocked.has(dir.slice(0, parent))) blocked.add(dir);
      else level.push(dir);
    }
    for (let index = 0; index < level.length; index += LSTAT_BATCH) {
      if (budget?.signal?.aborted) throw new Error("Git inspection aborted");
      budget?.timeoutMs();
      await Promise.all(level.slice(index, index + LSTAT_BATCH).map(async dir => {
        let stats: Stats | undefined;
        try { stats = await lstat(join(root, dir)); } catch (error) {
          if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
        }
        if (stats?.isDirectory()) return;
        blocked.add(dir);
        if (stats?.isSymbolicLink()) linked.push(dir);
      }));
    }
  }
  return linked.sort();
}

/** Paths named by `diff --numstat -z` records; renames/copies report the new path, as --name-only does. */
export function numstatNames(raw: string, complete = true): string[] {
  const fields = raw.split("\0");
  if (!complete) fields.pop(); // a field cut by the byte bound
  const names: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const tab = field.indexOf("\t", field.indexOf("\t") + 1);
    if (field === "" || tab === -1) continue;
    const path = field.slice(tab + 1);
    if (path) { names.push(path); continue; }
    const renamed = fields[index + 2];
    if (renamed) names.push(renamed);
    index += 2;
  }
  return names;
}

/**
 * `diff --name-only` without the index auto-refresh (G3) also lists files whose
 * stat data is stale but whose content is unchanged. --numstat compares content,
 * so name-only output is derived from it instead.
 */
async function diffNames(executable: string, argv: string[], root: string, env: NodeJS.ProcessEnv, budget: Budget): Promise<string> {
  const args = argv.flatMap(arg => arg === "--name-only" ? ["--numstat", "-z"] : [arg]);
  const result = await spawnBounded(executable, args, root, { env, signal: budget.signal, timeoutMs: budget.timeoutMs(), separateStderr: true });
  if (!result.truncated && result.code !== 0) throw queryFailure("Git inspection failed", result);
  const names = numstatNames(result.output.toString("utf8"), !result.truncated);
  const text = stripUrlUserinfo(names.map(name => `${name}\n`).join(""));
  return result.truncated ? `${text}[truncated: output exceeds ${MAX_BYTES} bytes]` : text;
}

function nearestRepository(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (dirname(current) === current) return undefined;
  }
}

/** The project worktree when it contains the session directory, else the session directory itself. */
function sessionBoundary(session: string, worktree: string | undefined): string {
  if (worktree && isAbsolute(worktree) && isDirectory(worktree)) {
    const real = realpath(worktree);
    if (dirname(real) !== real && inside(real, session)) return real;
  }
  return session;
}

export async function inspectGit(operation: GitOperation, input: GitInput, directory: string, signal?: AbortSignal, options: GitInspectOptions = {}): Promise<string> {
  // Discovery and inspection share one tool-call deadline, not two 15 s waits.
  const deadline = performance.now() + DEADLINE_MS;
  const budget: Budget = { signal, timeoutMs: () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Git inspection timed out");
    return remaining;
  } };
  validateInput(operation, input);
  if (!isDirectory(directory)) throw new Error("Session directory does not exist");
  const session = realpath(directory);
  const boundary = sessionBoundary(session, options.worktree);
  // G4: never run a git that lives in the session's tree, checked before anything is spawned.
  const nearest = nearestRepository(session);
  const executable = selectGitExecutable(options.executables ?? defaultCandidates(), [session, boundary, ...(nearest ? [nearest] : [])]);
  const attrSource = await supportsAttrSource(executable, budget);
  const inherited = await inheritedConfig(executable, budget);
  const trusted = inherited.filter(pair => pair.startsWith("safe.directory=")).flatMap(pair => ["-c", pair]);
  const base = [...hardeningArgs(), ...trusted];
  // G11: discovery cannot climb above the session's worktree.
  const env = gitEnvironment(dirname(boundary) === boundary ? {} : { GIT_CEILING_DIRECTORIES: dirname(boundary) });
  const shown = await runBoundedProcess(executable, [...base, "rev-parse", "--show-toplevel", ...(attrSource ? ["--show-object-format"] : [])],
    session, { signal, timeoutMs: budget.timeoutMs(), env });
  const [top = "", format = ""] = shown.trim().split(/\r?\n/);
  if (!top || !isAbsolute(top) || !existsSync(top)) throw new Error("Cannot resolve repository toplevel");
  const root = realpath(top);
  if (!inside(boundary, root)) throw new Error("Repository toplevel is outside the session worktree");
  if (inside(root, executable)) throw new Error(`Refusing git executable inside the repository: ${executable}`);
  const repository = await repositoryConfig(executable, root, env, base, budget);
  const config = [...trusted,
    ...inherited.filter(pair => !pair.startsWith("safe.directory=") && !repository.overridden.has(pair.slice(0, pair.indexOf("=")))).flatMap(pair => ["-c", pair]),
    ...repository.neutralize, ...(attrSource ? [`--attr-source=${emptyTreeId(format)}`] : [])];
  let linked: string[] = [];
  if (readsWorktree(operation, input)) {
    const index = await query(executable, [...base, "ls-files", "-z", "--cached"], root, env, budget, MAX_INDEX_BYTES);
    if (index.code !== 0) throw queryFailure("Cannot list tracked files", index);
    linked = await linkedTrackedDirectories(root, index.output.toString("utf8").split("\0").filter(Boolean), budget);
    if (linked.length > MAX_LINKED_EXCLUDES) throw new Error("Refusing inspection: too many tracked directories were replaced by links");
  }
  let inspected = input;
  if (operation === "show") {
    const commit = await query(executable, [...base, "rev-parse", "--verify", "--end-of-options", `${input.ref ?? "HEAD"}^{commit}`], root, env, budget);
    const oid = commit.output.toString("utf8").trim();
    if (commit.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) {
      throw new Error("Git show requires a commit (not a blob/tree); use read for sensitive files (asks for approval)");
    }
    inspected = { ...input, ref: oid };
  }
  const argv = gitArgv(operation, inspected, root, { config, exclude: linked });
  const raw = operation === "diff" && input.mode === "name-only"
    ? await diffNames(executable, argv, root, env, budget)
    : await runBoundedProcess(executable, argv, root, { signal, timeoutMs: budget.timeoutMs(), env });
  const output = ["show", "diff", "log"].includes(operation) ? filterSensitiveDiff(raw) : raw;
  if (linked.length === 0) return output;
  return `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}[router_git] skipped tracked directories replaced by symlinks/junctions: ${linked.slice(0, 20).join(", ")}${linked.length > 20 ? ", ..." : ""}`;
}

export function gitTools() {
  // G4: resolve the git executable once, at plugin load.
  const executables = defaultCandidates();
  const inputSchema = tool.schema.object({
    path: tool.schema.string().optional(), ref: tool.schema.string().optional(),
    limit: tool.schema.number().int().min(1).max(50).optional(),
    mode: tool.schema.enum(["patch", "stat", "name-only", "cached"]).optional(),
  }).strict();
  return Object.fromEntries(GIT_OPERATIONS.map(operation => [`router_git_${operation}`, tool({
    description: `Read-only git ${operation.replaceAll("_", "-")} in the session repository. No shell, helpers, arbitrary options or writes. Output is bounded to 64 KiB and 15 seconds. Paths are literal and repository-relative.`,
    args: {
      path: tool.schema.string().optional().describe("Literal repository-relative path; required for blame"),
      ...(operation === "log" || operation === "diff" || operation === "show" || operation === "blame"
        ? { ref: tool.schema.string().optional().describe("Ref or diff range, at most 200 characters; never an option") } : {}),
      ...(operation === "log" ? { limit: tool.schema.number().int().min(1).max(50).optional() } : {}),
      ...(operation === "diff" ? { mode: tool.schema.enum(["patch", "stat", "name-only", "cached"]).optional() } : {}),
    },
    async execute(input, context) {
      try {
        return await inspectGit(operation, inputSchema.parse(input), context.directory, context.abort, { worktree: context.worktree, executables });
      } catch (error) {
        // G12: report, never throw into the session; messages are credential-redacted.
        return `[router_git] error: ${stripUrlUserinfo(errorMessage(error))}`;
      }
    },
  })]));
}
