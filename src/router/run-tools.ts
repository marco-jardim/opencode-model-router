/**
 * `router_run`: the structured run tool of roles mode (plan P1.3, #84). It runs one
 * allowlisted entry in the dispatch's work root and reports the exit code; it is the
 * only exec-class action a role is ever granted (§2.2).
 *
 * Trust model (T1.3.2).
 * - The tool never spawns a shell itself: every spawn is `shell: false` with a fixed
 *   argv (`spawnBounded`), and a caller only picks an entry name, plus arguments when
 *   the entry declares them (each one allowlisted and confined to the work root, never
 *   interpreted by the tool).
 * - npm script bodies (`package.json` `scripts`, including the `pre<name>`/`post<name>`
 *   hooks npm runs with them) are TRUSTED REPOSITORY CONTENT, executed by npm's script
 *   shell exactly as `npm run <name>` would. The tool pins WHICH npm, node and shell run
 *   them (none may come from the repository or the plugin's checkout, #77 G4) and the
 *   npm settings that would change that: `--script-shell`, `--node-options=`,
 *   `--workspaces=false`, `--update-notifier=false` and `--logs-max=0` on the command
 *   line outrank every npmrc file and the environment; a work-root `.npmrc` that selects
 *   workspaces (`workspace`, `workspaces`, `include-workspace-root`) is refused, because
 *   npm would run another package's scripts. Other repository `.npmrc` settings (cache,
 *   registry, …) still apply to npm itself. The tool does not and cannot make a script safe.
 * - Because an edit can change what a script does, a grant holding both write and exec
 *   is floored at medium/heavy by the §2.3 floor table: write + exec is as strong as
 *   running code the agent wrote.
 *
 * Authority (S11, P-10, P-12, I9). No `evaluate` hook fires for plugin tools, so the tool
 * checks its own authority: the session must be bound to a work root (resolver injected
 * by P2.1), and `cwd` must name that root after canonicalisation. The tool never reads
 * `context.directory`, `context.worktree` or the session location: under the v2 bridge
 * they name the main checkout, not a sibling worktree.
 *
 * Residual risks (documented, not defended; QA-P13-1-12):
 * - The work root itself may be replaced (a junction or symlink swapped in) between the
 *   check and the spawn; the agent only writes inside the root, not its parent.
 * - POSIX: the run's process group is killed when the call settles, but a process that
 *   left the group (`setsid`, a double fork into a new session) escapes it.
 * - win32: there is no process tree once the parent has exited, so a background process
 *   a script started and left running survives a normal exit (taskkill /T only reaches
 *   the tree while the parent lives, i.e. on timeout or abort).
 * - win32 cmd.exe searches the current directory before PATH; the run sets
 *   `NoDefaultCurrentDirectoryInExePath=1`, which cmd.exe honours, but a script can unset it.
 * - npm puts `node_modules/.bin` of the work root on PATH for scripts (npm's behaviour,
 *   repository content by the trust model above); the inherited PATH is stripped of
 *   relative entries and entries inside the guarded directories.
 * - Credential redaction of the output is best effort (URL userinfo and credential-like
 *   query parameters), not a secret scanner; credential-like environment variables are
 *   not passed to the run.
 * - Agents and credential stores stay reachable (QA-P13-2-6): the ssh-agent socket
 *   (SSH_AUTH_SOCK), git credential helpers and the OS keychain, cloud CLI caches under
 *   the home directory (~/.aws, ~/.config/gcloud, ~/.azure, ~/.docker/config.json, …),
 *   and environment variables whose values carry credentials under other names (for
 *   example a URL with userinfo). A script can use them as the user can.
 * - Argument confinement is lexical (QA-P13-2-1): a caller argument never names an
 *   absolute, drive, UNC or URL path or a `..` segment, but a symlink or junction inside
 *   the work root, and the contents of an `@response` file, are repository content.
 */
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { RunConfig } from "./roles";
import {
  checkWorkRootAnswer, dropPartialCredential, envLookup, errorMessage, firstOutside, isFullPath, readBoundedRegularFile as readBounded,
  realFileOrUndefined, spawnBounded, stripUrlUserinfo, workRootGuards, type BoundedLabel, type BoundedResult, type WorkRootAnswer,
} from "./git-tools";

export { isFullPath } from "./git-tools";
export type { WorkRootAnswer } from "./git-tools";

export const RUN_TOOL_NAME = "router_run";
/** Every caller argument must match this allowlist (no spaces, quotes or shell metacharacters on any platform). */
export const RUN_ARG_RE = /^[A-Za-z0-9_./:=@+-]{1,200}$/;
/** An entry name: never option-like (it is an npm argv element). */
export const RUN_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@+-]{0,199}$/;
export const RUN_MAX_ARGS = 50;
/** Output bound: the first RUN_HEAD_BYTES and the last RUN_TAIL_BYTES of stdout+stderr (raw bytes). */
export const RUN_OUTPUT_BYTES = 64 * 1024;
export const RUN_HEAD_BYTES = 16 * 1024;
export const RUN_TAIL_BYTES = RUN_OUTPUT_BYTES - RUN_HEAD_BYTES;
/**
 * Bound of the rendered text in UTF-8 bytes (QA-P13-1-13): invalid UTF-8 decodes to
 * U+FFFD (3 bytes per invalid byte), so the decoded text is capped again.
 */
export const RUN_RENDERED_MAX_BYTES = RUN_OUTPUT_BYTES + 1024;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;
const RUN_LABEL: BoundedLabel = { message: "router_run", tag: "router_run", program: "the run" };
/** Bun's temporary node directory (`bun run` puts a node link to bun first on PATH; see verify/runner.ts F.1). */
const BUN_NODE_DIR_RE = /^bun-node-[0-9a-f]+$/i;
/** Command executables refused outright: a shell (or `env`) would make the fixed argv a script. */
const SHELL_RE = /^(cmd|command|powershell|pwsh|sh|bash|dash|zsh|ksh|mksh|ash|csh|tcsh|fish|busybox|toybox|wsl|wscript|cscript|mshta|env)$/i;
/** Package-manager front ends that read repository config (`.npmrc` `script-shell`, `node-options`) themselves. */
const SHIM_RE = /^(npx|pnpm|pnpx|yarn|yarnpkg|corepack|bun|bunx)$/i;
/** npm commands a `commands` entry may run: script runners only (never `exec`, `install`, …). Exact names. */
export const NPM_RUN_COMMANDS: ReadonlySet<string> = new Set(["run", "run-script", "test", "start", "stop", "restart"]);
/** npm flags a `commands` entry may fix before `--` (exact spellings; npm accepts abbreviations, so nothing else). */
const NPM_SAFE_FLAGS: ReadonlySet<string> = new Set(["--silent", "-s", "--quiet", "-q", "--if-present"]);
/** `.npmrc` keys that make npm run another package's scripts. */
const NPMRC_WORKSPACE_KEYS: ReadonlySet<string> = new Set(["workspace", "workspaces", "include-workspace-root"]);
/** Credential-bearing environment variable names (QA-P13-1-9). */
export const CREDENTIAL_ENV_RE = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)($|_)/i;
/** Provider credentials whose names the pattern above does not match. */
const PROVIDER_ENV: ReadonlySet<string> = new Set(["OPENAI_KEY", "AZURE_OPENAI_KEY", "COHERE_KEY", "GROQ_KEY", "MISTRAL_KEY",
  "OPENROUTER_KEY", "DEEPSEEK_KEY", "XAI_KEY", "GEMINI_KEY", "GOOGLE_KEY", "DATABASE_URL"]);

/** What the outcome store receives after every run that was spawned (P1.4 `run` signal). */
export interface RunRecord {
  sessionID: string;
  /** The entry name the caller asked for. */
  script: string;
  /** null: no exit code (timed out, aborted or killed by a signal). */
  exitCode: number | null;
  /** When the run STARTED (ms since epoch): a run that started before an edit never counts as after it. */
  at: number;
}

export interface RunToolDeps {
  /** Effective `routing.run` (global layer only, P1.1). Read on every call. */
  config: () => RunConfig;
  /**
   * The session's work-root answer (P2.1 wires it to the dispatch binding; the type is
   * shared with router_git_*, QA-P13-2-8). `{ role: false }` → refused (router_run is
   * for role sessions only); `{ role: true, root: null }` → refused (I9); `{ role: true,
   * root }` → `cwd` must name that root. Any other answer is reported as an error.
   */
  resolveWorkRoot: (sessionID: string) => WorkRootAnswer;
  /** P1.4 `run` signal. A throwing recorder never hides the run's result. */
  recordRun?: (e: RunRecord) => void;
  /**
   * Operator passthrough: exact environment variable names (case-insensitive) kept
   * although they look like credentials (e.g. a test database URL). Default: none.
   */
  envPassthrough?: readonly string[];
  /** Test seam: the node executable (absolute; still refused inside the guarded directories). Default: F.1 lookup. */
  nodeExecPath?: string;
  /** Test seam for platform-dependent resolution (shell, PATH lookup, path comparison). Default: process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam: the environment the run inherits (hardened). Default: process.env at call time. */
  env?: NodeJS.ProcessEnv;
}

export interface RunInput { script: string; args?: readonly string[]; cwd: string }

/** A resolved, spawnable run. `executable` is absolute; argv never passes through a shell. */
export interface RunPlan {
  kind: "script" | "command";
  name: string;
  executable: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface RunHost { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; nodeExecPath?: string; envPassthrough?: readonly string[] }

class RunRefused extends Error {}
const refuse = (message: string) => new RunRefused(message);

function pathApi(platform: NodeJS.Platform) { return platform === "win32" ? win32 : posix; }

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function nativeRealpath(path: string): string | undefined {
  try { return realpathSync.native(path); } catch { return undefined; }
}

/**
 * The canonical work root a call may run in (P-10, I9): the session must be bound, and
 * `cwd` must resolve (realpathSync.native: links, junctions and 8.3 names expanded) to
 * the same directory as the bound root, case-insensitively on win32.
 */
export function authorizeCwd(bound: unknown, cwd: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof bound !== "string" || bound === "") throw refuse("this session has no bound work root (I9); router_run only runs in a dispatch's work root");
  if (!isFullPath(bound, platform)) throw refuse("the bound work root is not an absolute path");
  const root = nativeRealpath(bound);
  if (root === undefined || !statSync(root).isDirectory()) throw refuse(`the bound work root does not exist: ${bound}`);
  if (typeof cwd !== "string" || !isFullPath(cwd, platform)) throw refuse(`cwd must be the absolute path of this dispatch's work root (${root})`);
  const real = nativeRealpath(cwd);
  if (real === undefined || !samePath(real, root, platform)) throw refuse(`cwd is not this dispatch's work root (${root})`);
  return root;
}

/**
 * `scripts` entries match exactly, or as a prefix when they end in `*` (`test:*` admits
 * `test:unit`, not `test:` itself); a bare `*` matches nothing.
 */
export function scriptAllowed(scripts: readonly string[], name: string): boolean {
  return scripts.some(entry => typeof entry === "string" && (entry === name
    || (entry.length > 1 && entry.endsWith("*") && name.length >= entry.length && name.startsWith(entry.slice(0, -1)))));
}

/** The option-like lead of an argument (`-x`, `@responsefile`, `+opt`), or undefined. */
export function optionLead(arg: string): string | undefined {
  return /^[-@+]/.test(arg) ? arg[0] : undefined;
}

/**
 * The argument may name a path outside the work root (QA-P13-1-1, QA-P13-2-1). Lexical:
 * - a piece starting with `/`, `\` or a drive (`X:`), where pieces start at the
 *   argument, after its option lead, after a two-character short option (`-o/abs`,
 *   `-I../x`) and after every `=`, `:`, `@` or `+` (`--define=K=/abs`, `pkg@/abs`);
 * - `:/` or `//` anywhere (URLs such as `file:///D:/x`, UNC, `--alias=x:/abs`);
 * - a `..` segment bounded by `/`, `\`, `=`, `:`, `@`, `+` or the ends, also right
 *   after a two-character short option (`-r../x.js`).
 * On win32 a leading `/switch` is refused by the same rule. Symlinks inside the work
 * root and the contents of `@response` files are repository content (not checked).
 */
export function escapesWorkRoot(arg: string): boolean {
  if (/:[\\/]|[\\/]{2}/.test(arg)) return true;
  const short = /^-[^-]/.test(arg) ? arg.slice(2) : undefined;
  const starts = [arg, arg.replace(/^[-@+]+/, ""), ...(short !== undefined ? [short] : [])];
  for (let index = 0; index < arg.length; index++) if ("=:@+".includes(arg[index]!)) starts.push(arg.slice(index + 1));
  if (starts.some(start => /^([\\/]|[A-Za-z]:)/.test(start))) return true;
  const dots = /(^|[\\/=:@+])\.\.($|[\\/=:@+])/;
  return dots.test(arg) || (short !== undefined && dots.test(short));
}

/**
 * `commands.<name>.args` lists the caller arguments an entry accepts: an exact string,
 * or a prefix ending in `*` (`test/*`, `--reporter=*`). An option-like caller argument
 * (leading `-`, `@` or `+`) matches only a pattern with the same leading character, so
 * `*` never admits `--output`, `@file` or `+opt`. Absent or empty: no caller arguments.
 * Path confinement (escapesWorkRoot) is checked separately and always applies.
 */
export function argAllowed(patterns: readonly string[], arg: string): boolean {
  const lead = optionLead(arg);
  return patterns.some(pattern => {
    if (typeof pattern !== "string" || pattern === "") return false;
    if (lead !== undefined && pattern[0] !== lead) return false;
    if (!pattern.endsWith("*")) return pattern === arg;
    return arg.startsWith(pattern.slice(0, -1));
  });
}

/** Validate caller arguments against the allowlist; the message names the argument's position, never its text. */
export function validateRunArgs(args: readonly unknown[]): string[] {
  if (args.length > RUN_MAX_ARGS) throw refuse(`at most ${RUN_MAX_ARGS} arguments`);
  return args.map((arg, index) => {
    if (typeof arg !== "string" || !RUN_ARG_RE.test(arg)) {
      throw refuse(`argument ${index + 1} refused: 1-200 characters from [A-Za-z0-9_./:=@+-] only (no spaces, quotes or shell metacharacters)`);
    }
    return arg;
  });
}

/** A credential-bearing environment variable name (QA-P13-1-9). */
export function isCredentialEnv(name: string): boolean {
  return CREDENTIAL_ENV_RE.test(name) || PROVIDER_ENV.has(name.toUpperCase());
}

function insideAny(path: string, guards: readonly string[]): boolean {
  return firstOutside([path], guards) === undefined;
}

/**
 * The hardened environment of a run:
 * - dropped: every `npm_*` variable (any case: npm_config_*, NPM_CONFIG_*, inherited
 *   npm_lifecycle_* and npm_package_*), NODE_OPTIONS, PREFIX (npm's global-config
 *   location) and credential-like variables (isCredentialEnv) unless passed through;
 * - PATH: relative entries and entries inside the guarded directories removed, so a
 *   `#!/usr/bin/env node` tool or a bare name cannot resolve into the repository; each
 *   entry is tested as written and by its real path (a link into the repository counts
 *   as inside, QA-P13-2-3e);
 * - set: CI=1; on win32 ComSpec (the validated shell) and NoDefaultCurrentDirectoryInExePath=1.
 */
export function runEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, shell?: string,
  options: { guards?: readonly string[]; passthrough?: readonly string[] } = {}): NodeJS.ProcessEnv {
  const passthrough = new Set((options.passthrough ?? []).map(name => name.toUpperCase()));
  const guards = options.guards ?? [];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || /^npm_/i.test(key) || /^(NODE_OPTIONS|PREFIX)$/i.test(key)) continue;
    if (isCredentialEnv(key) && !passthrough.has(key.toUpperCase())) continue;
    if (/^PATH$/i.test(key)) {
      const separator = platform === "win32" ? ";" : ":";
      env[key] = value.split(separator).filter(entry => {
        const dir = entry.replace(/^"|"$/g, "");
        if (dir === "" || !isFullPath(dir, platform) || insideAny(dir, guards)) return false;
        const real = guards.length > 0 ? nativeRealpath(dir) : undefined;
        return real === undefined || !insideAny(real, guards);
      }).join(separator);
      continue;
    }
    env[key] = value;
  }
  const set = (name: string, value: string) => {
    if (platform === "win32") for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    env[name] = value;
  };
  set("CI", "1");
  if (platform === "win32") {
    set("NoDefaultCurrentDirectoryInExePath", "1");
    if (shell !== undefined) set("ComSpec", shell);
  }
  return env;
}

function pathEntries(host: RunHost): string[] {
  const raw = envLookup(host.env, "PATH") ?? "";
  return raw.split(host.platform === "win32" ? ";" : ":").map(entry => entry.replace(/^"|"$/g, ""))
    .filter(entry => entry !== "" && isFullPath(entry, host.platform));
}

function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
  } catch { return false; }
}

/** An existing file as found, with its real path (QA-P13-1-3: spawn the found path, guard both spellings). */
interface Found { found: string; real: string }

function foundFile(path: string, platform: NodeJS.Platform): Found | undefined {
  if (!isFullPath(path, platform)) return undefined;
  const real = realFileOrUndefined(path);
  return real === undefined ? undefined : { found: pathApi(platform).normalize(path), real };
}

/** An operator-given executable path with a `..` segment is refused, never normalised (QA-P13-2-7). */
function refuseDotDot(path: string, what: string): void {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(path)) throw refuse(`${what} must not contain a ".." segment: ${path}`);
}

/** Both the found spelling and the real path are outside every guarded directory (G4). */
function outside(file: Found, guards: readonly string[]): boolean {
  return !insideAny(file.real, guards) && !insideAny(file.found, guards);
}

/** The program name without a Windows extension; both separators count, so a Windows path is named on POSIX too. */
function stemOf(path: string): string {
  return win32.basename(path).replace(/\.(exe|com|cmd|bat|ps1|js)$/i, "").toLowerCase();
}

/**
 * The node that runs npm-cli.js (verify/runner.ts F.1 rules): the explicit seam; else
 * process.execPath when the runtime really is node (opencode hosts plugins in Bun);
 * else the first node on an absolute PATH entry that is not Bun's temporary link. The
 * first candidate outside the guarded directories wins (G4). The path is returned as
 * found (a version-manager shim keeps its argv[0]); the real path is only checked.
 */
export function resolveNodeExecutable(host: RunHost, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  if (host.nodeExecPath !== undefined) {
    refuseDotDot(host.nodeExecPath, "node executable");
    const file = foundFile(host.nodeExecPath, host.platform);
    if (file === undefined) throw refuse(`node executable is not an absolute path to a file: ${host.nodeExecPath}`);
    if (!outside(file, guards)) throw refuse(`refusing a node executable inside the work root: ${file.found}`);
    return file.found;
  }
  const candidates: Found[] = [];
  const add = (file: Found | undefined) => { if (file !== undefined && !candidates.some(known => known.found === file.found)) candidates.push(file); };
  const runtimeIsNode = process.versions.bun === undefined && /^node(\.exe)?$/i.test(P.basename(process.execPath))
    && !BUN_NODE_DIR_RE.test(P.basename(P.dirname(process.execPath)));
  if (runtimeIsNode) add(foundFile(process.execPath, host.platform));
  for (const dir of pathEntries(host)) {
    if (BUN_NODE_DIR_RE.test(P.basename(dir))) continue;
    const file = foundFile(P.join(dir, host.platform === "win32" ? "node.exe" : "node"), host.platform);
    if (file === undefined || /^bun(\.exe)?$/i.test(P.basename(file.real))) continue;
    if (!runtimeIsNode && sameFile(file.real, process.execPath)) continue; // Bun's win32 hard link
    add(file);
  }
  const selected = candidates.find(file => outside(file, guards));
  if (selected !== undefined) return selected.found;
  throw refuse(candidates.length === 0 ? "node executable not found (no node runtime and no node on an absolute PATH entry)"
    : `refusing a node executable inside the work root: ${candidates[0]!.found}`);
}

/**
 * npm-cli.js of the node install (never a .cmd/.ps1 shim, never from a guarded
 * directory), looked up beside the node as found AND beside its real path:
 * `<dir>/node_modules/npm/bin/npm-cli.js`, and on POSIX `<dir>/../lib/node_modules/npm/…`
 * (Homebrew links `bin/node` into the Cellar while npm lives under `lib`).
 */
export function resolveNpmCli(node: string, platform: NodeJS.Platform, guards: readonly string[]): string {
  const P = pathApi(platform);
  const dirs = [P.dirname(node)];
  const real = realFileOrUndefined(node);
  if (real !== undefined && !dirs.includes(P.dirname(real))) dirs.push(P.dirname(real));
  const candidates = dirs.flatMap(dir => [P.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    ...(platform === "win32" ? [] : [P.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")])])
    .map(path => foundFile(path, platform)).filter((file): file is Found => file !== undefined);
  const selected = candidates.find(file => outside(file, guards));
  if (selected !== undefined) return selected.found;
  throw refuse(candidates.length === 0 ? `npm-cli.js not found in the node install of ${node}`
    : `refusing npm-cli.js inside the work root: ${candidates[0]!.found}`);
}

/**
 * npm's script shell, as found (never a realpath: busybox and bash pick their mode from
 * argv[0]): on win32 %ComSpec% only when its basename is cmd.exe, else
 * %SystemRoot%\System32\cmd.exe; `/bin/sh` on POSIX. Absolute, existing, outside the guards.
 */
export function resolveSystemShell(host: RunHost, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  const comspec = envLookup(host.env, "ComSpec");
  const wanted = host.platform === "win32"
    ? [...(comspec !== undefined && P.basename(comspec).toLowerCase() === "cmd.exe" ? [comspec] : []),
      P.join(envLookup(host.env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe")]
    : ["/bin/sh"];
  const selected = wanted.map(path => foundFile(path, host.platform)).find(file => file !== undefined && outside(file, guards));
  if (selected === undefined) throw refuse("no absolute system shell outside the work root (ComSpec cmd.exe / System32\\cmd.exe / /bin/sh)");
  return selected.found;
}

function refuseProgramStem(stem: string, program: string): void {
  if (SHELL_RE.test(stem)) throw refuse(`command executable "${stem}" is a shell; router_run never spawns a shell (use a package.json script)`);
  if (SHIM_RE.test(stem)) throw refuse(`command executable "${stem}" reads repository configuration itself; use an "npm" command or a package.json script`);
  if (stem === "node" || stem === "nodejs" || stem === "npm" || stem === "npm-cli") {
    throw refuse(`command executable ${program} is node or npm: write the bare name "node" or "npm" so the pinned install is used`);
  }
}

/**
 * A configured command's executable (argv[0]): an absolute path to a file outside the
 * guarded directories, or a bare name found on an absolute PATH entry outside them
 * (`.exe`/`.com` only on win32: `.cmd`/`.bat` need a shell). Shells, `env`,
 * package-manager front ends and a node/npm reached by another name or path are
 * refused (by the name and by the real file's name). Returned as found.
 */
export function resolveCommandExecutable(program: string, host: RunHost, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  refuseProgramStem(stemOf(program), program);
  const runnable = (path: string) => host.platform !== "win32" || /\.(exe|com)$/i.test(path);
  if (host.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(program)) throw refuse(`command executable must be a .exe or .com on Windows: ${program}`);
  const accept = (file: Found) => {
    if (!runnable(file.found) || !runnable(file.real)) throw refuse(`command executable must be a .exe or .com on Windows: ${program}`);
    refuseProgramStem(stemOf(file.real), program);
    return file.found;
  };
  if (isFullPath(program, host.platform)) {
    refuseDotDot(program, "command executable");
    const file = foundFile(program, host.platform);
    if (file === undefined) throw refuse(`command executable not found: ${program}`);
    if (!outside(file, guards)) throw refuse(`refusing a command executable inside the work root: ${file.found}`);
    return accept(file);
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/.test(program)) throw refuse(`command executable must be absolute or a bare name: ${program}`);
  const name = host.platform === "win32" && !/\.(exe|com)$/i.test(program) ? `${program}.exe` : program;
  const candidates = pathEntries(host).map(dir => foundFile(P.join(dir, name), host.platform))
    .filter((file): file is Found => file !== undefined);
  const selected = candidates.find(file => outside(file, guards));
  if (selected !== undefined) return accept(selected);
  throw refuse(candidates.length === 0 ? `command executable "${program}" not found on an absolute PATH entry`
    : `refusing a command executable inside the work root: ${candidates[0]!.found}`);
}

/** Where npm reads its user and global config files; pinned on the command line (QA-P13-2-2). */
export interface NpmConfigPins { userconfig: string; globalconfig: string }

/**
 * Flags that pin npm's script shell and node options, keep npm in the work root's
 * package, write no npm log file, and pin the user and global config files (a project
 * `.npmrc` can otherwise move `userconfig` to a repository file, which could then move
 * `globalconfig`). Command line flags outrank npmrc files and the environment, with one
 * exception npm 11 shows in `config ls -l` ("overridden by user"): the user's own
 * `~/.npmrc` may still set `globalconfig`; that file is user-owned, outside every work root.
 */
export function npmHardeningFlags(shell: string, pins: NpmConfigPins): string[] {
  return [`--script-shell=${shell}`, "--node-options=", "--workspaces=false", "--update-notifier=false", "--logs-max=0",
    `--userconfig=${pins.userconfig}`, `--globalconfig=${pins.globalconfig}`];
}

export { readBoundedRegularFile } from "./git-tools";

/** A config file of the work root, bounded and regular; failures are refusals. */
function readConfigFile(path: string, label: string): string | undefined {
  try { return readBounded(path, MAX_CONFIG_FILE_BYTES, label); } catch (error) { throw refuse(errorMessage(error)); }
}

/** npm's `${VAR}` / `${VAR?}` substitution (@npmcli/config env-replace), with the environment the npm child sees. */
export function npmEnvReplace(text: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  return text.replace(/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g, (original, escapes: string, name: string, modifier: string | undefined) => {
    const value = platform === "win32" ? envLookup(env, name) : env[name];
    if (escapes.length % 2) return original.slice((escapes.length + 1) / 2);
    return escapes.slice(escapes.length / 2) + (value ?? (modifier === "?" ? "" : `\${${name}}`));
  });
}

type IniDecode = (text: string) => Record<string, unknown>;
const iniCache = new Map<string, IniDecode>();

/**
 * npm's own ini parser, loaded from the resolved npm install (never from the repository):
 * the `.npmrc` checks must read keys exactly as npm does (`\r` line breaks, comments
 * cutting unquoted keys at `;`/`#`, JSON-decoded quoted keys, `key[]` arrays).
 */
export function loadNpmIni(npmCli: string, platform: NodeJS.Platform, guards: readonly string[]): IniDecode {
  const P = pathApi(platform);
  const dir = P.join(P.dirname(P.dirname(npmCli)), "node_modules", "ini");
  const cached = iniCache.get(dir);
  if (cached !== undefined) return cached;
  const real = nativeRealpath(dir);
  if (real === undefined) throw refuse(`npm's ini parser is missing from the npm install (${dir})`);
  if (insideAny(real, guards) || insideAny(dir, guards)) throw refuse(`refusing npm's ini parser inside the work root: ${dir}`);
  let loaded: { decode?: unknown; parse?: unknown };
  try { loaded = createRequire(npmCli)(dir) as typeof loaded; } catch (error) {
    throw refuse(`cannot load npm's ini parser from ${dir} (${errorMessage(error)})`);
  }
  const decode = typeof loaded.decode === "function" ? loaded.decode : loaded.parse;
  if (typeof decode !== "function") throw refuse(`npm's ini parser at ${dir} has no decode function`);
  const bound: IniDecode = text => (decode as IniDecode)(text);
  iniCache.set(dir, bound);
  return bound;
}

/**
 * The config files npm would use by default, for the npm child's environment: the user
 * config `<HOME | USERPROFILE | homedir>/.npmrc`, and the global config
 * `<prefix>/etc/npmrc` with the prefix of npm's builtin `npmrc` (env-substituted), else
 * npm's default (win32: the node directory; POSIX: its parent; DESTDIR prepended).
 */
export function npmConfigPins(node: string, npmCli: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, guards: readonly string[]): NpmConfigPins {
  const P = pathApi(platform);
  const get = (name: string) => (platform === "win32" ? envLookup(env, name) : env[name]) || undefined;
  const home = get("HOME") ?? (platform === "win32" ? get("USERPROFILE") : undefined) ?? homedir();
  const builtin = readConfigFile(P.join(P.dirname(P.dirname(npmCli)), "npmrc"), "npm's builtin npmrc");
  let prefix: string | undefined;
  if (builtin !== undefined) {
    const value = loadNpmIni(npmCli, platform, guards)(builtin).prefix;
    if (typeof value === "string" && value !== "") prefix = P.resolve(npmEnvReplace(value, env, platform));
  }
  if (prefix === undefined) {
    const execPath = platform === "win32" ? node : (realFileOrUndefined(node) ?? node);
    prefix = platform === "win32" ? P.dirname(execPath) : P.dirname(P.dirname(execPath));
    const destdir = get("DESTDIR");
    if (destdir !== undefined) prefix = P.join(destdir, prefix);
  }
  return { userconfig: P.resolve(home, ".npmrc"), globalconfig: P.resolve(prefix, "etc", "npmrc") };
}

/** The work root's package.json scripts (QA-P13-1-4: every npm plan needs one in the root itself). */
function packageScripts(root: string, platform: NodeJS.Platform): Record<string, unknown> {
  const text = readConfigFile(pathApi(platform).join(root, "package.json"), "package.json");
  if (text === undefined) throw refuse("no readable package.json in the work root (npm would walk up to another package)");
  let pkg: unknown;
  try { pkg = JSON.parse(text); } catch {
    throw refuse("no readable package.json in the work root (not valid JSON)");
  }
  const scripts = typeof pkg === "object" && pkg !== null ? (pkg as { scripts?: unknown }).scripts : undefined;
  return typeof scripts === "object" && scripts !== null ? scripts as Record<string, unknown> : {};
}

function requireScript(scripts: Record<string, unknown>, name: string): void {
  if (!Object.hasOwn(scripts, name) || typeof scripts[name] !== "string") throw refuse(`package.json has no script "${name}"`);
}

/**
 * Refuse a work-root .npmrc that selects workspaces: npm would run another package's
 * scripts (QA-P13-1-4). Keys are read with npm's own ini parser (QA-P13-2-2) and compared
 * case-insensitively; a key using `${…}` substitution is refused outright (npm
 * substitutes keys too, so `work${X?}space` is `workspace`).
 */
function checkNpmrc(root: string, platform: NodeJS.Platform, decode: IniDecode): void {
  const text = readConfigFile(pathApi(platform).join(root, ".npmrc"), ".npmrc");
  if (text === undefined) return;
  let parsed: Record<string, unknown>;
  try { parsed = decode(text); } catch { throw refuse("the work root's .npmrc cannot be parsed"); }
  for (const key of Object.keys(parsed)) {
    if (key.includes("${")) throw refuse(`the work root's .npmrc has a key with environment substitution: npm would rewrite it`);
    if (NPMRC_WORKSPACE_KEYS.has(key.toLowerCase())) throw refuse(`the work root's .npmrc sets "${key}": npm would run another package's scripts`);
  }
}

/** node, npm-cli.js, the shell and the hardening flags of an npm plan, after the work-root config checks. */
function npmLaunch(root: string, host: RunHost, guards: readonly string[]): { node: string; flags: string[]; cli: string; shell: string } {
  const node = resolveNodeExecutable(host, guards);
  const shell = resolveSystemShell(host, guards);
  const cli = resolveNpmCli(node, host.platform, guards);
  checkNpmrc(root, host.platform, loadNpmIni(cli, host.platform, guards));
  const env = runEnvironment(host.env, host.platform, shell, { guards, passthrough: host.envPassthrough ?? [] });
  return { node, cli, shell, flags: npmHardeningFlags(shell, npmConfigPins(node, cli, env, host.platform, guards)) };
}

function effectiveTimeout(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), MAX_TIMER_MS) : DEFAULT_RUN_TIMEOUT_MS;
}

function assertArgv(executable: string, argv: readonly string[], platform: NodeJS.Platform): void {
  if (!isFullPath(executable, platform)) throw new Error("router_run internal error: executable is not absolute");
  for (const arg of argv) {
    if (typeof arg !== "string" || /[\0\r\n]/.test(arg)) throw refuse("command argv elements must be strings without NUL or line breaks");
  }
}

/** cmd.exe cannot use a UNC current directory (it falls back to %SystemRoot%): refuse it for anything npm runs (QA-P13-1-7). */
function refuseUncForShell(root: string, platform: NodeJS.Platform): void {
  if (platform === "win32" && /^[\\/]{2}/.test(root)) {
    throw refuse("the work root is a UNC path: cmd.exe cannot run scripts there (it would use %SystemRoot%); map a drive letter");
  }
}

/** The bare name `node`/`npm` (with an optional Windows extension) routes to the pinned install. */
function pinnedProgram(program: string): "node" | "npm" | undefined {
  const match = /^(node|npm)(\.exe|\.cmd)?$/i.exec(program);
  return match ? match[1]!.toLowerCase() as "node" | "npm" : undefined;
}

/**
 * The fixed npm argv of a `commands` entry (QA-P13-1-5): it starts with an allowed
 * script-running command (exact name), `run`/`run-script` name a script of the work
 * root's package.json, and options before `--` are limited to NPM_SAFE_FLAGS.
 */
function checkNpmArgv(fixed: readonly string[], scripts: Record<string, unknown>, name: string): void {
  const command = fixed[0];
  if (command === undefined || !NPM_RUN_COMMANDS.has(command)) {
    throw refuse(`npm command "${name}" must start with one of ${[...NPM_RUN_COMMANDS].join(", ")}`);
  }
  const end = fixed.indexOf("--") === -1 ? fixed.length : fixed.indexOf("--");
  for (const part of fixed.slice(1, end)) {
    if (part.startsWith("-") && !NPM_SAFE_FLAGS.has(part)) throw refuse(`npm command "${name}" fixes the npm option ${part}; only ${[...NPM_SAFE_FLAGS].join(", ")} are allowed`);
  }
  if (command === "run" || command === "run-script") {
    const script = fixed[1];
    if (script === undefined || script === "--" || script.startsWith("-") || !RUN_NAME_RE.test(script)) {
      throw refuse(`npm command "${name}" must name its script right after "${command}"`);
    }
    requireScript(scripts, script);
  } else {
    requireScript(scripts, command);
  }
}

/**
 * Resolve a call into a spawnable plan. `root` must come from authorizeCwd. Commands
 * win over scripts of the same name. Package.json scripts take no caller arguments
 * (`RunConfig` has no per-script knob): parameterised runs need a `commands` entry
 * declaring `args`, e.g. `{ "argv": ["npm", "run", "test", "--"], "args": ["test/*"] }`.
 * Caller arguments never name a path outside the work root, and an option-like one
 * (`-`, `@`, `+`) needs a pattern with the same lead; a `node` entry takes option-like
 * caller arguments only when its fixed argv starts with the script (QA-P13-1-1).
 */
export function planRun(input: RunInput, root: string, config: RunConfig, host: RunHost): RunPlan {
  const name = input.script;
  if (typeof name !== "string" || !RUN_NAME_RE.test(name)) throw refuse("invalid entry name");
  const args = validateRunArgs(input.args ?? []);
  const timeoutMs = effectiveTimeout(config.timeoutMs);
  const commands = config.commands ?? {};
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  let executable: string;
  let argv: string[];
  let shell: string | undefined;
  let guards: string[] | undefined;
  const guarded = () => (guards ??= workRootGuards(root));
  if (command !== undefined) {
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(part => typeof part !== "string" || part === "")) {
      throw refuse(`routing.run.commands.${name} has no valid argv`);
    }
    const patterns = command.args ?? [];
    if (args.length > 0 && patterns.length === 0) throw refuse(`"${name}" takes no caller arguments (its entry declares no args)`);
    args.forEach((arg, index) => {
      if (escapesWorkRoot(arg)) throw refuse(`argument ${index + 1} names a path outside the work root (absolute, drive or "..")`);
      if (!argAllowed(patterns, arg)) throw refuse(`argument ${index + 1} is not among the arguments "${name}" declares`);
    });
    const [program, ...fixed] = command.argv as string[];
    const pinned = pinnedProgram(program!);
    if (pinned === "node") {
      if (args.some(arg => optionLead(arg) !== undefined) && (fixed.length === 0 || optionLead(fixed[0]!) !== undefined)) {
        throw refuse(`option-like arguments to the node command "${name}" need a fixed script first in its argv`);
      }
      executable = resolveNodeExecutable(host, guarded());
      argv = [...fixed, ...args];
    } else if (pinned === "npm") {
      refuseUncForShell(root, host.platform);
      checkNpmArgv(fixed, packageScripts(root, host.platform), name);
      // Caller options before `--` would be npm flags and could undo the hardening flags.
      if (!fixed.includes("--") && args.some(arg => arg.startsWith("-"))) throw refuse(`option-like arguments to the npm command "${name}" need a "--" in its argv`);
      const launch = npmLaunch(root, host, guarded());
      executable = launch.node;
      shell = launch.shell;
      argv = [launch.cli, ...launch.flags, ...fixed, ...args];
    } else {
      executable = resolveCommandExecutable(program!, host, guarded());
      argv = [...fixed, ...args];
    }
  } else if (scriptAllowed(config.scripts ?? [], name)) {
    if (args.length > 0) throw refuse(`package.json scripts take no caller arguments; declare a routing.run.commands entry with "args" for "${name}"`);
    refuseUncForShell(root, host.platform);
    requireScript(packageScripts(root, host.platform), name);
    const launch = npmLaunch(root, host, guarded());
    executable = launch.node;
    shell = launch.shell;
    argv = [launch.cli, ...launch.flags, "run", name];
  } else {
    throw refuse(`"${name}" is not in routing.run.scripts or routing.run.commands`);
  }
  assertArgv(executable, argv, host.platform);
  if (shell === undefined && host.platform === "win32") {
    // ComSpec for anything the command starts: the validated system shell when one exists.
    try { shell = resolveSystemShell(host, guarded()); } catch { shell = undefined; }
  }
  return {
    kind: command !== undefined ? "command" : "script", name, executable, argv, cwd: root,
    env: runEnvironment(host.env, host.platform, shell, { guards: guarded(), passthrough: host.envPassthrough ?? [] }), timeoutMs,
  };
}

/** Drop the leading partial line (or token) of a tail window: the cut may fall inside a credential. */
export function dropLeadingPartial(text: string): string {
  const newline = text.indexOf("\n");
  if (newline !== -1) return text.slice(newline + 1);
  const space = text.search(/\s/);
  return space === -1 ? "" : text.slice(space + 1);
}

/** Cap decoded text at RUN_RENDERED_MAX_BYTES of UTF-8 (U+FFFD expansion, QA-P13-1-13). */
export function capRendered(text: string, max = RUN_RENDERED_MAX_BYTES): string {
  if (Buffer.byteLength(text) <= max) return text;
  const notice = `\n[router_run] rendered output capped at ${max} bytes (undecodable bytes expand when decoded)\n`;
  const kept = Buffer.from(text).subarray(0, Math.max(0, max - Buffer.byteLength(notice))).toString("utf8").replace(/\uFFFD+$/, "");
  return `${dropPartialCredential(kept)}${notice}`;
}

/**
 * Bounded, credential-redacted output: at each cut point the partial token is dropped
 * first (dropPartialCredential at the head's end, dropLeadingPartial at the tail's
 * start), then complete credentials are redacted (stripUrlUserinfo), then the notice;
 * the decoded text is capped again (capRendered).
 */
export function renderRunOutput(result: Pick<BoundedResult, "output" | "truncated" | "tail" | "omitted">): string {
  const tail = result.tail ?? Buffer.alloc(0);
  const omitted = result.omitted ?? 0;
  if (!result.truncated || (omitted === 0 && result.tail !== undefined)) {
    return capRendered(stripUrlUserinfo(Buffer.concat([result.output, tail]).toString("utf8")));
  }
  const head = stripUrlUserinfo(dropPartialCredential(result.output.toString("utf8")));
  const rest = result.tail === undefined ? "" : stripUrlUserinfo(dropLeadingPartial(tail.toString("utf8")));
  const notice = `[router_run] output truncated: ${omitted > 0 ? `${omitted} bytes omitted; ` : ""}showing at most the first ${RUN_HEAD_BYTES} and the last ${RUN_TAIL_BYTES} bytes (bound ${RUN_OUTPUT_BYTES} bytes)`;
  return capRendered(`${head}${head.endsWith("\n") || head === "" ? "" : "\n"}${notice}\n${rest}`);
}

function statusLine(plan: RunPlan, result: BoundedResult, ms: number): string {
  const duration = `${(ms / 1000).toFixed(1)} s`;
  const what = `${plan.kind === "script" ? "package.json script" : "command"} "${plan.name}"`;
  if (result.failure?.endsWith("timed out")) return `[router_run] ${what}: timed out after ${plan.timeoutMs} ms, process tree killed; exit code: none; duration ${duration}`;
  if (result.failure !== undefined) return `[router_run] ${what}: aborted, process tree killed; exit code: none; duration ${duration}`;
  return `[router_run] ${what}: exit code: ${result.code ?? "none (killed by a signal)"}; duration ${duration}`;
}

/** Spawn a plan (shell: false), bounded by time, abort and 64 KiB of output; never rejects on a timeout or abort. */
export async function executeRunPlan(plan: RunPlan, signal?: AbortSignal): Promise<{ result: BoundedResult; text: string; ms: number }> {
  const started = performance.now();
  const result = await spawnBounded(plan.executable, plan.argv, plan.cwd, {
    env: plan.env, timeoutMs: plan.timeoutMs, signal, maxBytes: RUN_HEAD_BYTES, tailBytes: RUN_TAIL_BYTES,
    mergeStderr: true, settleOnFailure: true, label: RUN_LABEL, killGroupOnSettle: true,
  });
  const ms = performance.now() - started;
  const output = renderRunOutput(result);
  return { result, ms, text: `${statusLine(plan, result, ms)}\n${output}${output.endsWith("\n") || output === "" ? "" : "\n"}` };
}

/**
 * The `router_run` tool (not registered here: P2.1 registers it for roles whose grant
 * holds exec, with the bound work-root resolver). Errors and refusals are returned as
 * `[router_run] error: …` text, redacted, never thrown into the session; a non-zero exit
 * is a normal result.
 */
export function routerRunTool(deps: RunToolDeps) {
  const inputSchema = tool.schema.object({
    script: tool.schema.string().min(1).max(200),
    args: tool.schema.array(tool.schema.string().max(200)).max(RUN_MAX_ARGS).optional(),
    cwd: tool.schema.string().min(1).max(4096),
  }).strict();
  return tool({
    description: "Run one allowlisted package.json script or configured command in this dispatch's work root and report its exit code. "
      + "No shell is spawned by the tool; arguments are accepted only when the entry declares them, each 1-200 characters of [A-Za-z0-9_./:=@+-], never a path outside the work root. "
      + "cwd must be the dispatch's work root. Output (stdout and stderr) is bounded to 64 KiB; URL credentials in it are redacted (best effort, not a secret scanner) "
      + "and credential-like environment variables are not passed to the run; agents and credential stores (ssh-agent, git credential helpers, "
      + "cloud CLI caches in the home directory) stay reachable to scripts. The run is time-limited.",
    args: {
      script: tool.schema.string().describe("Entry name: a script listed in routing.run.scripts (e.g. test, typecheck) or a routing.run.commands entry"),
      args: tool.schema.array(tool.schema.string()).optional().describe("Arguments, only for command entries that declare them"),
      cwd: tool.schema.string().describe("Absolute path of the dispatch's work root"),
    },
    async execute(input, context) {
      try {
        const platform = deps.platform ?? process.platform;
        // Authority first (P-10, I9, QA-P13-2-8): nothing else is looked at for an unbound session.
        const answer = checkWorkRootAnswer(deps.resolveWorkRoot(context.sessionID));
        if (!answer.role) throw refuse("router_run is only available to role sessions (this session is not one)");
        if (answer.root === null) throw refuse("this session has no bound work root (I9); router_run only runs in a dispatch's work root");
        const root = authorizeCwd(answer.root, (input as { cwd?: unknown } | undefined)?.cwd, platform);
        const parsed = inputSchema.parse(input);
        const plan = planRun(parsed, root, deps.config(), {
          platform, env: deps.env ?? process.env, envPassthrough: deps.envPassthrough ?? [],
          ...(deps.nodeExecPath !== undefined ? { nodeExecPath: deps.nodeExecPath } : {}),
        });
        const at = Date.now();
        const { result, text } = await executeRunPlan(plan, context.abort);
        const exitCode = result.failure === undefined ? result.code : null;
        try { deps.recordRun?.({ sessionID: context.sessionID, script: plan.name, exitCode, at }); } catch (error) {
          console.warn(`[model-router] router_run: could not record the run (${errorMessage(error)})`);
        }
        return text;
      } catch (error) {
        const prefix = error instanceof RunRefused ? "refused: " : "";
        return `[router_run] error: ${prefix}${stripUrlUserinfo(errorMessage(error))}`;
      }
    },
  });
}
