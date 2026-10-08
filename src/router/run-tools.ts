/**
 * `router_run`: the structured run tool of roles mode (plan P1.3, #84). It runs one
 * allowlisted entry in the dispatch's work root and reports the exit code; it is the
 * only exec-class action a role is ever granted (§2.2).
 *
 * Trust model (T1.3.2).
 * - The tool never spawns a shell itself: every spawn is `shell: false` with a fixed
 *   argv (`spawnBounded`), and a caller only picks an entry name, plus arguments when
 *   the entry declares them (each one allowlisted, never interpreted by the tool).
 * - npm script bodies (`package.json` `scripts`, including the `pre<name>`/`post<name>`
 *   hooks npm runs with them) are TRUSTED REPOSITORY CONTENT, executed by npm's script
 *   shell exactly as `npm run <name>` would. The tool pins WHICH npm, node and shell run
 *   them (none may come from the repository, #77 G4; a repo `.npmrc` cannot redirect
 *   `script-shell` or `node-options` because command-line flags outrank every npmrc
 *   file and the environment), but it does not and cannot make the script itself safe.
 * - Because an edit can change what a script does, a grant holding both write and exec
 *   is floored at medium/heavy by the §2.3 floor table: write + exec is as strong as
 *   running code the agent wrote.
 * - Residual (§2.2): scripts may reach the network, and repository content is a prompt
 *   injection vector the separation rule does not cover.
 *
 * Authority (S11, P-10, P-12, I9). No `evaluate` hook fires for plugin tools, so the tool
 * checks its own authority: the session must be bound to a work root (resolver injected
 * by P2.1), and `cwd` must name that root after canonicalisation. The tool never reads
 * `context.directory`, `context.worktree` or the session location: under the v2 bridge
 * they name the main checkout, not a sibling worktree.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { tool } from "@opencode-ai/plugin";
import type { RunConfig } from "./roles";
import {
  dropPartialCredential, envLookup, errorMessage, firstOutside, nearestCheckout, realFileOrUndefined, spawnBounded,
  stripUrlUserinfo, type BoundedLabel, type BoundedResult,
} from "./git-tools";

export const RUN_TOOL_NAME = "router_run";
/** Every caller argument must match this allowlist (no spaces, quotes or shell metacharacters on any platform). */
export const RUN_ARG_RE = /^[A-Za-z0-9_./:=@+-]{1,200}$/;
/** An entry name: never option-like (it is an npm argv element). */
export const RUN_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:@+-]{0,199}$/;
export const RUN_MAX_ARGS = 50;
/** Total output bound: the first RUN_HEAD_BYTES and the last RUN_TAIL_BYTES of stdout+stderr. */
export const RUN_OUTPUT_BYTES = 64 * 1024;
export const RUN_HEAD_BYTES = 16 * 1024;
export const RUN_TAIL_BYTES = RUN_OUTPUT_BYTES - RUN_HEAD_BYTES;
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;
const RUN_LABEL: BoundedLabel = { message: "router_run", tag: "router_run", program: "the run" };
/** Bun's temporary node directory (`bun run` puts a node link to bun first on PATH; see verify/runner.ts F.1). */
const BUN_NODE_DIR_RE = /^bun-node-[0-9a-f]+$/i;
/** Command executables refused outright: a shell (or `env`) would make the fixed argv a script. */
const SHELL_RE = /^(cmd|command|powershell|pwsh|sh|bash|dash|zsh|ksh|mksh|ash|csh|tcsh|fish|busybox|wsl|wscript|cscript|mshta|env)$/i;
/** Package-manager front ends that read repository config (`.npmrc` `script-shell`, `node-options`) themselves. */
const SHIM_RE = /^(npx|pnpm|pnpx|yarn|yarnpkg|corepack|bun|bunx)$/i;

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
   * The work root bound to a session (P2.1 wires it to the dispatch binding). null, or
   * anything that is not a non-empty string, means unbound: the tool refuses (I9).
   */
  resolveWorkRoot: (sessionID: string) => string | null;
  /** P1.4 `run` signal. A throwing recorder never hides the run's result. */
  recordRun?: (e: RunRecord) => void;
  /** Test seam: the node executable (absolute; still refused inside the work root). Default: F.1 lookup. */
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

interface Host { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; nodeExecPath?: string }

class RunRefused extends Error {}
const refuse = (message: string) => new RunRefused(message);

function pathApi(platform: NodeJS.Platform) { return platform === "win32" ? win32 : posix; }

/** Absolute and, on win32, rooted at a drive letter or UNC host (a root-relative `\dir` names no one file). */
export function isFullPath(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return path.startsWith("/");
  return /^[A-Za-z]:[\\/]|^[\\/]{2}[^\\/]+[\\/][^\\/]/.test(path);
}

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

/**
 * `commands.<name>.args` lists the caller arguments an entry accepts: an exact string,
 * or a prefix ending in `*` (`test/*`, `--reporter=*`). A caller argument starting with
 * `-` matches only a pattern that itself starts with `-` (so `*` never admits an
 * option such as `--output`). Absent or empty: the entry takes no caller arguments.
 */
export function argAllowed(patterns: readonly string[], arg: string): boolean {
  return patterns.some(pattern => {
    if (typeof pattern !== "string") return false;
    if (!pattern.endsWith("*")) return pattern === arg;
    const prefix = pattern.slice(0, -1);
    return arg.startsWith(prefix) && (!arg.startsWith("-") || prefix.startsWith("-"));
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

/**
 * The hardened environment of a run: every `npm_*` variable (any case: npm_config_*,
 * NPM_CONFIG_*, inherited npm_lifecycle_* and npm_package_*), NODE_OPTIONS and PREFIX (npm's
 * global-config location) are dropped; CI=1; on win32 ComSpec names the validated shell.
 * PATH and everything else are kept.
 */
export function runEnvironment(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, shell?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || /^npm_/i.test(key) || /^(NODE_OPTIONS|PREFIX)$/i.test(key)) continue;
    env[key] = value;
  }
  const set = (name: string, value: string) => {
    if (platform === "win32") for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
    env[name] = value;
  };
  set("CI", "1");
  if (platform === "win32" && shell !== undefined) set("ComSpec", shell);
  return env;
}

function guardsFor(root: string): string[] {
  const checkout = nearestCheckout(root);
  return checkout && checkout !== root ? [root, checkout] : [root];
}

function pathEntries(host: Host): string[] {
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

/**
 * The node that runs npm-cli.js (verify/runner.ts F.1 rules): the explicit seam; else
 * process.execPath when the runtime really is node (opencode hosts plugins in Bun);
 * else the first node on an absolute PATH entry that is not Bun's temporary link. The
 * first candidate outside the work root and its checkout wins (G4).
 */
export function resolveNodeExecutable(host: Host, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  if (host.nodeExecPath !== undefined) {
    const real = isFullPath(host.nodeExecPath, host.platform) ? realFileOrUndefined(host.nodeExecPath) : undefined;
    if (real === undefined) throw refuse(`node executable is not an absolute path to a file: ${host.nodeExecPath}`);
    if (firstOutside([real], guards) === undefined) throw refuse(`refusing a node executable inside the work root: ${real}`);
    return real;
  }
  const candidates: string[] = [];
  const add = (path: string | undefined) => { if (path !== undefined && !candidates.includes(path)) candidates.push(path); };
  const runtimeIsNode = process.versions.bun === undefined && /^node(\.exe)?$/i.test(P.basename(process.execPath))
    && !BUN_NODE_DIR_RE.test(P.basename(P.dirname(process.execPath)));
  if (runtimeIsNode) add(realFileOrUndefined(process.execPath));
  for (const dir of pathEntries(host)) {
    if (BUN_NODE_DIR_RE.test(P.basename(dir))) continue;
    const real = realFileOrUndefined(P.join(dir, host.platform === "win32" ? "node.exe" : "node"));
    if (real === undefined || /^bun(\.exe)?$/i.test(P.basename(real))) continue;
    if (!runtimeIsNode && sameFile(real, process.execPath)) continue; // Bun's win32 hard link
    add(real);
  }
  const selected = firstOutside(candidates, guards);
  if (selected !== undefined) return selected;
  throw refuse(candidates.length === 0 ? "node executable not found (no node runtime and no node on an absolute PATH entry)"
    : `refusing a node executable inside the work root: ${candidates[0]}`);
}

/** npm-cli.js of the node install (never a .cmd/.ps1 shim, never resolved from the repository). */
export function resolveNpmCli(node: string, platform: NodeJS.Platform, guards: readonly string[]): string {
  const P = pathApi(platform);
  const dir = P.dirname(node);
  const candidates = [P.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
    ...(platform === "win32" ? [] : [P.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")])]
    .map(realFileOrUndefined).filter((path): path is string => path !== undefined);
  const selected = firstOutside(candidates, guards);
  if (selected !== undefined) return selected;
  throw refuse(candidates.length === 0 ? `npm-cli.js not found in the node install of ${node}`
    : `refusing npm-cli.js inside the work root: ${candidates[0]}`);
}

/** npm's script shell: %ComSpec% (else %SystemRoot%\System32\cmd.exe) on win32, /bin/sh on POSIX; absolute, existing, outside the work root. */
export function resolveSystemShell(host: Host, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  const wanted = host.platform === "win32"
    ? [envLookup(host.env, "ComSpec"), P.join(envLookup(host.env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe")]
    : ["/bin/sh"];
  const candidates = wanted.filter((path): path is string => typeof path === "string" && isFullPath(path, host.platform))
    .map(realFileOrUndefined).filter((path): path is string => path !== undefined);
  const selected = firstOutside(candidates, guards);
  if (selected === undefined) throw refuse("no absolute system shell outside the work root (ComSpec / System32\\cmd.exe / /bin/sh)");
  return selected;
}

/**
 * A configured command's executable (argv[0]): an absolute path to a file outside the
 * work root, or a bare name found on an absolute PATH entry outside it (`.exe`/`.com`
 * only on win32: `.cmd`/`.bat` need a shell). Shells, `env` and package-manager front
 * ends are refused; `node` and `npm` are handled by the caller.
 */
export function resolveCommandExecutable(program: string, host: Host, guards: readonly string[]): string {
  const P = pathApi(host.platform);
  const stem = P.basename(program).replace(/\.(exe|com|cmd|bat|ps1)$/i, "");
  if (SHELL_RE.test(stem)) throw refuse(`command executable "${stem}" is a shell; router_run never spawns a shell (use a package.json script)`);
  if (SHIM_RE.test(stem)) throw refuse(`command executable "${stem}" reads repository configuration itself; use an "npm" command or a package.json script`);
  const runnable = (path: string) => host.platform !== "win32" || /\.(exe|com)$/i.test(path);
  if (host.platform === "win32" && /\.(cmd|bat|ps1)$/i.test(program)) throw refuse(`command executable must be a .exe or .com on Windows: ${program}`);
  if (isFullPath(program, host.platform)) {
    const real = realFileOrUndefined(program);
    if (real === undefined) throw refuse(`command executable not found: ${program}`);
    if (!runnable(real)) throw refuse(`command executable must be a .exe or .com on Windows: ${program}`);
    if (firstOutside([real], guards) === undefined) throw refuse(`refusing a command executable inside the work root: ${real}`);
    return real;
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/.test(program)) throw refuse(`command executable must be absolute or a bare name: ${program}`);
  const file = host.platform === "win32" && !/\.(exe|com)$/i.test(program) ? `${program}.exe` : program;
  if (!runnable(file)) throw refuse(`command executable must be a .exe or .com on Windows: ${program}`);
  const candidates = pathEntries(host).map(dir => realFileOrUndefined(P.join(dir, file)))
    .filter((path): path is string => path !== undefined);
  const selected = firstOutside([...new Set(candidates)], guards);
  if (selected !== undefined) return selected;
  throw refuse(candidates.length === 0 ? `command executable "${program}" not found on an absolute PATH entry`
    : `refusing a command executable inside the work root: ${candidates[0]}`);
}

/** Flags that pin npm's script shell and node options and keep npm in the work root (they outrank every npmrc file). */
export function npmHardeningFlags(shell: string): string[] {
  return [`--script-shell=${shell}`, "--node-options=", "--workspaces=false", "--update-notifier=false"];
}

function packageScriptExists(root: string, name: string, platform: NodeJS.Platform): void {
  const file = pathApi(platform).join(root, "package.json");
  let pkg: unknown;
  try {
    if (statSync(file).size > MAX_PACKAGE_JSON_BYTES) throw refuse("package.json is larger than 4 MiB");
    pkg = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error instanceof RunRefused) throw error;
    throw refuse(`no readable package.json in the work root (${errorMessage(error)})`);
  }
  const scripts = typeof pkg === "object" && pkg !== null ? (pkg as { scripts?: unknown }).scripts : undefined;
  if (typeof scripts !== "object" || scripts === null || !Object.hasOwn(scripts, name) || typeof (scripts as Record<string, unknown>)[name] !== "string") {
    throw refuse(`package.json has no script "${name}"`);
  }
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

/**
 * Resolve a call into a spawnable plan. `root` must come from authorizeCwd. Commands
 * win over scripts of the same name. Package.json scripts take no caller arguments
 * (`RunConfig` has no per-script knob): parameterised runs need a `commands` entry
 * declaring `args`, e.g. `{ "argv": ["npm", "run", "test", "--"], "args": ["test/*"] }`.
 */
export function planRun(input: RunInput, root: string, config: RunConfig, host: Host): RunPlan {
  const name = input.script;
  if (typeof name !== "string" || !RUN_NAME_RE.test(name)) throw refuse("invalid entry name");
  const args = validateRunArgs(input.args ?? []);
  const guards = guardsFor(root);
  const timeoutMs = effectiveTimeout(config.timeoutMs);
  const commands = config.commands ?? {};
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  let executable: string;
  let argv: string[];
  let shell: string | undefined;
  if (command !== undefined) {
    if (!Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some(part => typeof part !== "string" || part === "")) {
      throw refuse(`routing.run.commands.${name} has no valid argv`);
    }
    const patterns = command.args ?? [];
    if (args.length > 0 && patterns.length === 0) throw refuse(`"${name}" takes no caller arguments (its entry declares no args)`);
    args.forEach((arg, index) => { if (!argAllowed(patterns, arg)) throw refuse(`argument ${index + 1} is not among the arguments "${name}" declares`); });
    const [program, ...fixed] = command.argv as string[];
    if (program === "node") {
      executable = resolveNodeExecutable(host, guards);
      argv = [...fixed, ...args];
    } else if (program === "npm") {
      // Caller options before `--` would be npm flags and could undo the hardening flags.
      if (!fixed.includes("--") && args.some(arg => arg.startsWith("-"))) throw refuse(`option-like arguments to the npm command "${name}" need a "--" in its argv`);
      executable = resolveNodeExecutable(host, guards);
      shell = resolveSystemShell(host, guards);
      argv = [resolveNpmCli(executable, host.platform, guards), ...npmHardeningFlags(shell), ...fixed, ...args];
    } else {
      executable = resolveCommandExecutable(program!, host, guards);
      argv = [...fixed, ...args];
    }
  } else if (scriptAllowed(config.scripts ?? [], name)) {
    if (args.length > 0) throw refuse(`package.json scripts take no caller arguments; declare a routing.run.commands entry with "args" for "${name}"`);
    packageScriptExists(root, name, host.platform);
    executable = resolveNodeExecutable(host, guards);
    shell = resolveSystemShell(host, guards);
    argv = [resolveNpmCli(executable, host.platform, guards), ...npmHardeningFlags(shell), "run", name];
  } else {
    throw refuse(`"${name}" is not in routing.run.scripts or routing.run.commands`);
  }
  assertArgv(executable, argv, host.platform);
  if (shell === undefined && host.platform === "win32") {
    // ComSpec for anything the command starts: the validated system shell when one exists.
    try { shell = resolveSystemShell(host, guards); } catch { shell = undefined; }
  }
  return { kind: command !== undefined ? "command" : "script", name, executable, argv, cwd: root, env: runEnvironment(host.env, host.platform, shell), timeoutMs };
}

/** Drop the leading partial line (or token) of a tail window: the cut may fall inside a credential. */
export function dropLeadingPartial(text: string): string {
  const newline = text.indexOf("\n");
  if (newline !== -1) return text.slice(newline + 1);
  const space = text.search(/\s/);
  return space === -1 ? "" : text.slice(space + 1);
}

/**
 * Bounded, credential-redacted output: at each cut point the partial token is dropped
 * first (dropPartialCredential at the head's end, dropLeadingPartial at the tail's
 * start), then complete credentials are redacted (stripUrlUserinfo), then the notice.
 */
export function renderRunOutput(result: Pick<BoundedResult, "output" | "truncated" | "tail" | "omitted">): string {
  const tail = result.tail ?? Buffer.alloc(0);
  const omitted = result.omitted ?? 0;
  if (!result.truncated || (omitted === 0 && result.tail !== undefined)) {
    return stripUrlUserinfo(Buffer.concat([result.output, tail]).toString("utf8"));
  }
  const head = stripUrlUserinfo(dropPartialCredential(result.output.toString("utf8")));
  const rest = result.tail === undefined ? "" : stripUrlUserinfo(dropLeadingPartial(tail.toString("utf8")));
  const notice = `[router_run] output truncated: ${omitted > 0 ? `${omitted} bytes omitted; ` : ""}showing at most the first ${RUN_HEAD_BYTES} and the last ${RUN_TAIL_BYTES} bytes (bound ${RUN_OUTPUT_BYTES} bytes)`;
  return `${head}${head.endsWith("\n") || head === "" ? "" : "\n"}${notice}\n${rest}`;
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
    mergeStderr: true, settleOnFailure: true, label: RUN_LABEL,
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
      + "No shell is spawned by the tool; arguments are accepted only when the entry declares them, each 1-200 characters of [A-Za-z0-9_./:=@+-]. "
      + "cwd must be the dispatch's work root. Output (stdout and stderr) is bounded to 64 KiB and redacted; the run is time-limited.",
    args: {
      script: tool.schema.string().describe("Entry name: a script listed in routing.run.scripts (e.g. test, typecheck) or a routing.run.commands entry"),
      args: tool.schema.array(tool.schema.string()).optional().describe("Arguments, only for command entries that declare them"),
      cwd: tool.schema.string().describe("Absolute path of the dispatch's work root"),
    },
    async execute(input, context) {
      try {
        const platform = deps.platform ?? process.platform;
        // Authority first (P-10, I9): nothing else is looked at for an unbound session.
        const root = authorizeCwd(deps.resolveWorkRoot(context.sessionID), (input as { cwd?: unknown } | undefined)?.cwd, platform);
        const parsed = inputSchema.parse(input);
        const plan = planRun(parsed, root, deps.config(), { platform, env: deps.env ?? process.env, ...(deps.nodeExecPath !== undefined ? { nodeExecPath: deps.nodeExecPath } : {}) });
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
