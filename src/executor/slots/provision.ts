/**
 * Slot provisioning (Phase 2.4.4, memo section 5): detects the package managers of a slot's
 * checkout, plans their install commands (argv arrays, never a shell) and runs them under a
 * machine-wide lock per manager, with bounded output and a timeout per step.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { envLookup, firstOutside, isFullPath, isInside, realFileOrUndefined, stripUrlUserinfo } from "../../router/git-tools";
import {
  isCredentialEnv, npmConfigPins, npmHardeningFlags, resolveNodeExecutable, resolveNpmCli, resolveSystemShell, runEnvironment,
  type RunHost,
} from "../../router/run-tools";
import { CLEANUP_RETRIES, CLEANUP_RETRY_BASE_MS, DEPENDENCY_FILES, TRANSIENT_FS_CODES } from "../../verify/reference";
import {
  ExecutorError, type Clock, type ExecutorConfig, type FileSystem, type ProcessResult, type SlotRecord, type Spawner,
} from "../types";

export type Manager = "pnpm" | "npm" | "yarn" | "uv" | "poetry" | "pip";

const NODE_MANAGERS: readonly Manager[] = ["npm", "pnpm", "yarn"];
const PYTHON_MANAGERS: readonly Manager[] = ["pip", "poetry", "uv"];
const ALL_MANAGERS: readonly Manager[] = ["npm", "pip", "pnpm", "poetry", "uv", "yarn"];

function isManager(name: string): name is Manager {
  return (ALL_MANAGERS as readonly string[]).includes(name);
}

function baseName(repoPath: string): string {
  return repoPath.split("/").at(-1) ?? "";
}

/** Tracked paths under a dependency directory are never manifests. */
function underDependencyDir(repoPath: string): boolean {
  return repoPath.split("/").slice(0, -1).some((segment) => segment === "node_modules" || segment === ".venv");
}

/**
 * Node: DEPENDENCY_FILES basenames at any depth; pip: requirements*.txt, pyproject.toml, setup.py, setup.cfg;
 * uv: uv.lock, pyproject.toml; poetry: poetry.lock, pyproject.toml. Matched against the slot's tracked paths
 * (`git ls-files -z`), never under node_modules/ or .venv/.
 */
export const PROVISION_MANIFESTS: Readonly<Record<Manager, (repoPath: string) => boolean>> = {
  npm: (p) => !underDependencyDir(p) && DEPENDENCY_FILES.has(baseName(p)),
  pnpm: (p) => !underDependencyDir(p) && DEPENDENCY_FILES.has(baseName(p)),
  yarn: (p) => !underDependencyDir(p) && DEPENDENCY_FILES.has(baseName(p)),
  pip: (p) => !underDependencyDir(p)
    && (/^requirements.*\.txt$/.test(baseName(p)) || ["pyproject.toml", "setup.py", "setup.cfg"].includes(baseName(p))),
  uv: (p) => !underDependencyDir(p) && ["uv.lock", "pyproject.toml"].includes(baseName(p)),
  poetry: (p) => !underDependencyDir(p) && ["poetry.lock", "pyproject.toml"].includes(baseName(p)),
};

/** The directory each manager installs into, relative to the slot root. */
export const DEPENDENCY_DIRS: Readonly<Record<Manager, readonly string[]>> = {
  npm: ["node_modules"], pnpm: ["node_modules"], yarn: ["node_modules"],
  pip: [".venv"], uv: [".venv"], poetry: [".venv"],
};

/** Managers whose install does not prune: `fresh` deletes these directories first. */
const FRESH_REMOVES: Readonly<Partial<Record<Manager, string>>> = { pip: ".venv", poetry: ".venv" };

export const PROVISION_STEP_TIMEOUT_MS = 1_200_000;
/** Output kept per step: head and tail. */
export const PROVISION_OUTPUT_KEEP_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 60_000;
const TAIL_LINES = 12;
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 60_000;
const LOCK_STALE_RECHECK_MS = 1_000;
const LOCK_POLL_MIN_MS = 500;
const LOCK_POLL_MAX_MS = 5_000;

export interface Detection {
  managers: Manager[];
  yarnBerry: boolean;
  editable: boolean;
  /** Repo-relative manifest path -> sha256 of the on-disk bytes. */
  manifests: Record<string, string>;
  python: string | null;
  /** Yarn berry: the `yarnPath` of `.yarnrc.yml` (slot-relative), when it names one. */
  yarnPath?: string;
}

function fail(message: string, detail: Record<string, string | number> = {}): ExecutorError {
  return new ExecutorError("E_PROVISION", message, detail);
}

function overrideKeys(config: Pick<ExecutorConfig, "provision">): Manager[] {
  return config.provision === "auto" ? [] : Object.keys(config.provision).filter(isManager);
}

async function readOptional(fs: FileSystem, path: string): Promise<string | null> {
  const st = await fs.lstat(path);
  if (st === null || st.kind !== "file") return null;
  return fs.readText(path);
}

function hasDependencies(pkg: unknown): boolean {
  if (typeof pkg !== "object" || pkg === null) return false;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const value: unknown = Reflect.get(pkg, field);
    if (typeof value === "object" && value !== null && Object.keys(value).length > 0) return true;
  }
  return false;
}

async function detectNode(slot: string, tracked: ReadonlySet<string>, fs: FileSystem, forced: readonly Manager[]): Promise<Manager[]> {
  const fromOverride = forced.filter((m) => NODE_MANAGERS.includes(m));
  if (fromOverride.length > 0) return fromOverride;
  let pkg: unknown = null;
  if (tracked.has("package.json")) {
    const text = await readOptional(fs, joinPath(slot, "package.json"));
    if (text !== null) {
      try {
        pkg = JSON.parse(text);
      } catch (error) {
        throw fail(`package.json in ${slot} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const declared: unknown = typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "packageManager") : undefined;
  if (typeof declared === "string") {
    const name = declared.split("@")[0] ?? "";
    if (name === "pnpm" || name === "npm" || name === "yarn") return [name];
  }
  const lockfiles: Array<[string, Manager]> = [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "npm"], ["yarn.lock", "yarn"]];
  const present = lockfiles.filter(([file]) => tracked.has(file));
  if (present.length === 1) return [present[0]![1]];
  if (present.length > 1) {
    throw fail(`ambiguous lockfiles in ${slot} (${present.map(([file]) => file).join(", ")}); set packageManager or executor.provision`);
  }
  if (pkg !== null && hasDependencies(pkg)) {
    throw fail(`package.json in ${slot} declares dependencies but no lockfile is committed; commit a lockfile (pnpm-lock.yaml, package-lock.json or yarn.lock)`);
  }
  return [];
}

interface PythonProject { managers: Manager[]; editable: boolean }

async function detectPython(slot: string, tracked: ReadonlySet<string>, fs: FileSystem, forced: readonly Manager[]): Promise<PythonProject> {
  const pyproject = tracked.has("pyproject.toml") ? await readOptional(fs, joinPath(slot, "pyproject.toml")) : null;
  const buildSystem = pyproject !== null && /^\s*\[build-system\]/m.test(pyproject);
  const backend = pyproject === null ? null : /^\s*build-backend\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? null;
  const editable = backend === "setuptools.build_meta" || (backend === null && tracked.has("setup.py"));
  const fromOverride = forced.filter((m) => PYTHON_MANAGERS.includes(m));
  if (fromOverride.length > 0) return { managers: fromOverride, editable: fromOverride.includes("pip") && editable };
  if (tracked.has("uv.lock")) return { managers: ["uv"], editable: false };
  if (tracked.has("poetry.lock")) return { managers: ["poetry"], editable: false };
  if (tracked.has("requirements.txt") || buildSystem) return { managers: ["pip"], editable };
  return { managers: [], editable: false };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function joinPath(root: string, rel: string): string {
  const api = /^[A-Za-z]:[\\/]|^[\\/]{2}/.test(root) ? win32 : posix;
  return api.join(root, ...rel.split("/"));
}

/** Which managers a slot needs, and the manifests whose change triggers re-provisioning. */
export async function detectManagers(slot: string, tracked: readonly string[], fs: FileSystem,
  config: Pick<ExecutorConfig, "provision" | "python">): Promise<Detection> {
  const usable = tracked.filter((p) => !underDependencyDir(p));
  const set = new Set(usable);
  const forced = overrideKeys(config);
  const node = await detectNode(slot, set, fs, forced);
  const python = await detectPython(slot, set, fs, forced);
  const managers = [...node, ...python.managers].sort();
  const yarnrc = managers.includes("yarn") ? await readOptional(fs, joinPath(slot, ".yarnrc.yml")) : null;
  const yarnBerry = yarnrc !== null;
  const yarnPath = yarnrc === null ? undefined : /^\s*yarnPath:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(yarnrc)?.[1];
  const manifests: Record<string, string> = {};
  for (const manager of managers) {
    for (const rel of usable) {
      if (!PROVISION_MANIFESTS[manager](rel) || rel in manifests) continue;
      const text = await readOptional(fs, joinPath(slot, rel));
      if (text !== null) manifests[rel] = sha256(text);
    }
  }
  return {
    managers, yarnBerry, editable: python.editable, manifests,
    python: config.python === "auto" ? null : config.python,
    ...(yarnPath === undefined ? {} : { yarnPath }),
  };
}

/** True when the slot's recorded managers or manifests differ from what is detected now. */
export function needsProvision(rec: Pick<SlotRecord, "managers" | "manifests">, d: Detection): boolean {
  const recorded = [...rec.managers].sort();
  if (recorded.length !== d.managers.length || recorded.some((m, i) => m !== d.managers[i])) return true;
  const have = Object.keys(rec.manifests);
  const want = Object.keys(d.manifests);
  if (have.length !== want.length) return true;
  return want.some((path) => rec.manifests[path] !== d.manifests[path]);
}

export interface ProvisionStep {
  manager: Manager;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  label: string;
  /** Run the step only when `command <condition>` (same env and cwd) exits 0. */
  condition?: string[];
}

export interface ProvisionHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeExecPath?: string;
  /** workRootGuards(slot): no tool binary may live inside these (G4). */
  guards: readonly string[];
}

type Provision = Pick<ExecutorConfig, "provision" | "python">;

function api(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** run-tools throws plain refusals; surface them as E_PROVISION with the same text. */
function resolving<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw fail(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pathDirs(host: ProvisionHost): string[] {
  const raw = envLookup(host.env, "PATH") ?? "";
  return raw.split(host.platform === "win32" ? ";" : ":").map((entry) => entry.replace(/^"|"$/g, ""))
    .filter((entry) => entry !== "" && isFullPath(entry, host.platform));
}

/** An existing regular file, as found, with the found path and its real path both outside the guards. */
function locate(path: string, host: ProvisionHost): string | undefined {
  if (!isFullPath(path, host.platform)) return undefined;
  const real = realFileOrUndefined(path);
  if (real === undefined) return undefined;
  const found = api(host.platform).normalize(path);
  if (firstOutside([found], host.guards) === undefined || firstOutside([real], host.guards) === undefined) return undefined;
  return found;
}

const STORE_STUB_RE = /[\\/]Microsoft[\\/]WindowsApps[\\/]/i;

/** A bare name as `.exe` (win32) on an absolute PATH entry outside the guards. */
function findExecutable(name: string, host: ProvisionHost): string | undefined {
  const file = host.platform === "win32" && !/\.(exe|com)$/i.test(name) ? `${name}.exe` : name;
  for (const dir of pathDirs(host)) {
    const found = locate(api(host.platform).join(dir, file), host);
    if (found !== undefined) return found;
  }
  return undefined;
}

function requireTool(manager: Manager, host: ProvisionHost, hint: string): string {
  const found = findExecutable(manager, host);
  if (found !== undefined) return found;
  throw fail(`${manager} was not found on PATH (an absolute PATH entry outside the work root); ${hint} or set executor.provision`,
    { manager });
}

/** A node entry script beside a package manager's launcher, run as `node <entry>`. */
function entryBesideLauncher(launcher: string, entries: readonly string[], host: ProvisionHost): string | undefined {
  const p = api(host.platform);
  for (const dir of pathDirs(host)) {
    const launchers = host.platform === "win32" ? [`${launcher}.cmd`, `${launcher}.exe`] : [launcher];
    if (!launchers.some((name) => realFileOrUndefined(p.join(dir, name)) !== undefined)) continue;
    for (const entry of entries) {
      const found = locate(p.join(dir, entry), host);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

interface NodeTools { node: string; runHost: RunHost }

function nodeTools(host: ProvisionHost): NodeTools {
  const runHost: RunHost = { platform: host.platform, env: host.env, nodeExecPath: host.nodeExecPath };
  return { node: resolving("node executable", () => resolveNodeExecutable(runHost, host.guards)), runHost };
}

function corepackEntry(name: string, node: string, host: ProvisionHost): string | undefined {
  const p = api(host.platform);
  return locate(p.join(p.dirname(node), "node_modules", "corepack", "dist", name), host);
}

interface Resolved { command: string; prefix: string[] }

function resolvePython(d: Detection, config: Provision, host: ProvisionHost): Resolved {
  const wanted = d.python ?? (config.python === "auto" ? null : config.python);
  let resolved: Resolved;
  if (wanted !== null) {
    const found = isFullPath(wanted, host.platform) ? locate(wanted, host) : findExecutable(wanted, host);
    if (found === undefined) throw fail(`executor.python "${wanted}" was not found as an absolute file or an executable on PATH outside the work root`, { python: wanted });
    resolved = { command: found, prefix: [] };
  } else if (host.platform === "win32") {
    const launcher = findExecutable("py", host);
    if (launcher === undefined) throw fail("Python was not found (py.exe on PATH); install Python 3 or set executor.python", { manager: "pip" });
    resolved = { command: launcher, prefix: ["-3"] };
  } else {
    const found = findExecutable("python3", host);
    if (found === undefined) throw fail("python3 was not found on PATH; install Python 3 or set executor.python", { manager: "pip" });
    resolved = { command: found, prefix: [] };
  }
  if (STORE_STUB_RE.test(resolved.command) || STORE_STUB_RE.test(realFileOrUndefined(resolved.command) ?? "")) {
    throw fail(`${resolved.command} is the Microsoft Store Python stub; install Python 3 or set executor.python`, { python: resolved.command });
  }
  return resolved;
}

function stepEnv(host: ProvisionHost, shell: string, extra: Record<string, string>): Record<string, string> {
  const base = runEnvironment(host.env, host.platform, shell, { guards: host.guards });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isCredentialEnv(key)) env[key] = value;
  }
  const fixed: Record<string, string> = {
    CI: "1", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", PIP_NO_INPUT: "1", UV_PYTHON_DOWNLOADS: "never", ...extra,
  };
  for (const [name, value] of Object.entries(fixed)) {
    if (host.platform === "win32") {
      for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    }
    env[name] = value;
  }
  return env;
}

function venvPython(slot: string, platform: NodeJS.Platform): string {
  const p = api(platform);
  return platform === "win32" ? p.join(slot, ".venv", "Scripts", "python.exe") : p.join(slot, ".venv", "bin", "python");
}

const BARE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/;

/** Plans the install commands of the detected managers (E_PROVISION on a missing binary). */
export function planProvision(slot: string, d: Detection, host: ProvisionHost, config: Provision): ProvisionStep[] {
  const p = api(host.platform);
  let tools: NodeTools | undefined;
  const node = (): NodeTools => (tools ??= nodeTools(host));
  const shell = resolving("system shell", () => resolveSystemShell(
    { platform: host.platform, env: host.env, nodeExecPath: host.nodeExecPath }, host.guards));
  const overrides: Record<string, string[][]> = config.provision === "auto" ? {} : config.provision;

  const step = (manager: Manager, command: string, args: string[], label: string,
    extra: Record<string, string> = {}, condition?: string[]): ProvisionStep => ({
    manager, command, args, env: stepEnv(host, shell, extra), cwd: slot, timeoutMs: PROVISION_STEP_TIMEOUT_MS, label,
    ...(condition === undefined ? {} : { condition }),
  });

  const npmFlags = (): string[] => {
    const { node: nodePath, runHost } = node();
    const cli = resolving("npm-cli.js", () => resolveNpmCli(nodePath, host.platform, host.guards));
    const pins = resolving("npm configuration", () => npmConfigPins(nodePath, cli, runHost.env, host.platform, host.guards));
    return [cli, ...npmHardeningFlags(shell, pins).filter((flag) => flag !== "--workspaces=false")];
  };

  const overrideStep = (manager: Manager, argv: readonly string[], index: number): ProvisionStep => {
    const [program, ...rest] = argv;
    const label = `${manager} override ${index + 1}`;
    if (program === undefined || program === "") throw fail(`executor.provision.${manager}[${index}] is an empty argv`, { manager });
    if (program === "node") return step(manager, node().node, rest, label);
    if (program === "npm") return step(manager, node().node, [...npmFlags(), ...rest], label);
    if (program === "python") {
      const python = resolvePython(d, config, host);
      return step(manager, python.command, [...python.prefix, ...rest], label);
    }
    if (/\.(cmd|bat|ps1)$/i.test(program)) {
      throw fail(`executor.provision.${manager}[${index}]: ${program} needs a shell; use "node <entry.js>" or an .exe instead`, { manager });
    }
    let command: string | undefined;
    if (isFullPath(program, host.platform)) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(program)) throw fail(`executor.provision.${manager}[${index}]: ${program} must not contain a ".." segment`, { manager });
      if (host.platform === "win32" && !/\.(exe|com)$/i.test(program)) {
        throw fail(`executor.provision.${manager}[${index}]: ${program} must be an .exe or .com on Windows`, { manager });
      }
      command = locate(program, host);
    } else if (BARE_NAME_RE.test(program)) {
      command = findExecutable(program, host);
    } else {
      throw fail(`executor.provision.${manager}[${index}]: ${program} must be absolute or a bare name`, { manager });
    }
    if (command === undefined) {
      throw fail(`executor.provision.${manager}[${index}]: ${program} was not found as an executable outside the work root; install it or fix the path`, { manager });
    }
    return step(manager, command, rest, label);
  };

  const steps: ProvisionStep[] = [];
  for (const manager of d.managers) {
    const override = overrides[manager];
    if (override !== undefined) {
      override.forEach((argv, index) => steps.push(overrideStep(manager, argv, index)));
      continue;
    }
    switch (manager) {
      case "npm":
        steps.push(step("npm", node().node, [...npmFlags(), "ci", "--prefer-offline", "--no-audit", "--no-fund"], "npm ci"));
        break;
      case "pnpm": {
        const args = ["install", "--frozen-lockfile", "--prefer-offline", "--config.confirm-modules-purge=false"];
        const exe = findExecutable("pnpm", host);
        if (exe !== undefined) {
          steps.push(step("pnpm", exe, args, "pnpm install"));
          break;
        }
        const entry = entryBesideLauncher("pnpm", [p.join("node_modules", "pnpm", "bin", "pnpm.cjs")], host)
          ?? corepackEntry("pnpm.js", node().node, host);
        if (entry === undefined) {
          throw fail("pnpm was not found (pnpm.exe on PATH, pnpm.cmd beside node_modules\\pnpm, or corepack in the node install); install pnpm or enable corepack, or set executor.provision", { manager });
        }
        steps.push(step("pnpm", node().node, [entry, ...args], "pnpm install"));
        break;
      }
      case "yarn": {
        const args = d.yarnBerry ? ["install", "--immutable"] : ["install", "--frozen-lockfile", "--non-interactive"];
        let entry: string | undefined;
        if (d.yarnBerry && d.yarnPath !== undefined) {
          const wanted = p.resolve(slot, d.yarnPath);
          if (!isInside(p.resolve(slot), wanted) || realFileOrUndefined(wanted) === undefined) {
            throw fail(`yarnPath ${d.yarnPath} in .yarnrc.yml is missing or outside ${slot}; commit the release file or set executor.provision`, { manager });
          }
          entry = wanted;
        } else if (!d.yarnBerry) {
          entry = entryBesideLauncher("yarn", ["yarn.js", p.join("node_modules", "yarn", "bin", "yarn.js")], host);
        }
        entry ??= corepackEntry("yarn.js", node().node, host);
        if (entry === undefined) {
          throw fail("yarn was not found (yarn.cmd on PATH with its yarn.js, or corepack in the node install); install yarn or enable corepack, or set executor.provision", { manager });
        }
        steps.push(step("yarn", node().node, [entry, ...args], "yarn install"));
        break;
      }
      case "uv": {
        const exe = requireTool("uv", host, "install uv (https://docs.astral.sh/uv/)");
        const python = d.python ?? (config.python === "auto" ? null : config.python);
        steps.push(step("uv", exe, ["sync", "--frozen", ...(python === null ? [] : ["--python", python])], "uv sync"));
        break;
      }
      case "poetry": {
        const exe = requireTool("poetry", host, "install poetry");
        steps.push(step("poetry", exe, ["install", "--no-interaction"], "poetry install", { POETRY_VIRTUALENVS_IN_PROJECT: "true" }));
        break;
      }
      case "pip": {
        const python = resolvePython(d, config, host);
        const venv = venvPython(slot, host.platform);
        steps.push(step("pip", python.command, [...python.prefix, "-m", "venv", ".venv"], "pip venv"));
        const requirements = ["requirements.txt", "requirements-dev.txt"].filter((file) => file in d.manifests);
        if (requirements.length > 0) {
          steps.push(step("pip", venv, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input",
            ...requirements.flatMap((file) => ["-r", file])], "pip install"));
        }
        if (d.editable) {
          steps.push(step("pip", venv, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input",
            "--no-build-isolation", "-e", "."], "pip install -e .", {}, ["-c", "import setuptools"]));
        }
        break;
      }
    }
  }
  return steps;
}

/** `%LOCALAPPDATA%\omr-executor\locks\<manager>.lock` (POSIX: `$HOME/.cache/omr-executor/locks/<manager>.lock`). */
export function managerLockPath(m: Manager, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const base = envLookup(env, "LOCALAPPDATA") ?? win32.join(envLookup(env, "USERPROFILE") ?? homedir(), "AppData", "Local");
    return win32.join(base, "omr-executor", "locks", `${m}.lock`);
  }
  return posix.join(envLookup(env, "HOME") ?? homedir(), ".cache", "omr-executor", "locks", `${m}.lock`);
}

export interface Provisioner {
  provision(slot: string, d: Detection, o: { fresh: boolean; signal?: AbortSignal }): Promise<void>;
}

interface LockBody { pid: number; hostname: string; startedAt: number; heartbeatAt: number }

function parseLock(text: string): LockBody | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const pid: unknown = Reflect.get(value, "pid");
    const host: unknown = Reflect.get(value, "hostname");
    const startedAt: unknown = Reflect.get(value, "startedAt");
    const heartbeatAt: unknown = Reflect.get(value, "heartbeatAt");
    if (typeof pid !== "number" || typeof host !== "string" || typeof startedAt !== "number" || typeof heartbeatAt !== "number") return null;
    return { pid, hostname: host, startedAt, heartbeatAt };
  } catch {
    // An unreadable lock body is a damaged lock: the caller treats null as stale.
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code: unknown = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const HINTS: Readonly<Record<Manager, string>> = {
  npm: "package-lock.json may be out of sync with package.json; run npm install and commit the lockfile",
  pnpm: "pnpm-lock.yaml may be out of date; run pnpm install and commit the lockfile",
  yarn: "yarn.lock may be out of date; run yarn install and commit the lockfile",
  uv: "uv.lock may be out of date; run uv lock and commit it",
  poetry: "poetry.lock may be out of date; run poetry lock and commit it",
  pip: "check requirements*.txt and the Python version, or set executor.python or executor.provision",
};

/** In-process chain per lock path: waiters in this process queue here, so they never poll the file against each other. */
const CHAINS = new Map<string, Promise<void>>();

export function createProvisioner(deps: {
  spawner: Spawner; fs: FileSystem; clock: Clock; host: ProvisionHost; config: Provision;
}): Provisioner {
  const { spawner, fs, clock, host, config } = deps;
  const p = api(host.platform);
  const uvCache = new Map<string, Promise<string | null>>();

  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
    const handle = clock.setTimer(ms, () => { signal?.removeEventListener("abort", onAbort); resolve(); });
    const onAbort = (): void => { clock.clearTimer(handle); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const aborted = (slot: string, signal?: AbortSignal): void => {
    if (signal?.aborted) throw fail(`provisioning of ${slot} was aborted`, { slot });
  };

  /** Creates `path` and every missing parent (the FileSystem port's mkdir is not recursive). */
  async function ensureDir(path: string): Promise<void> {
    const missing: string[] = [];
    let cur = path;
    for (;;) {
      if (await fs.lstat(cur) !== null) break;
      missing.push(cur);
      const up = p.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
    for (const dir of missing.reverse()) {
      try {
        await fs.mkdir(dir);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  }

  async function removeRetrying(path: string, recursive: boolean): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rm(path, { recursive });
        return;
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return;
        if (code === undefined || !TRANSIENT_FS_CODES.has(code) || attempt >= CLEANUP_RETRIES) throw error;
        await sleep(CLEANUP_RETRY_BASE_MS * 2 ** attempt);
      }
    }
  }

  /** lstat gate: a real directory is removed recursively; a link or a file only itself, never what a link points to. */
  async function removeDependencyDir(slot: string, rel: string): Promise<void> {
    const target = p.join(slot, rel);
    const st = await fs.lstat(target);
    if (st === null) return;
    await removeRetrying(target, st.kind === "dir");
  }

  async function freshen(slot: string, d: Detection): Promise<void> {
    for (const manager of d.managers) {
      const rel = FRESH_REMOVES[manager] ?? (manager === "yarn" && !d.yarnBerry ? "node_modules" : undefined);
      if (rel !== undefined) await removeDependencyDir(slot, rel);
    }
  }

  /** Heartbeat write: tmp + rename, but only while `held()` is true, so a release can never be undone by a late beat. */
  async function writeLock(path: string, body: LockBody, held: () => boolean = () => true): Promise<void> {
    const tmp = `${path}.${clock.randomHex(8)}.tmp`;
    await fs.writeText(tmp, JSON.stringify(body), { fsync: true });
    if (!held()) {
      await removeRetrying(tmp, false);
      return;
    }
    await fs.rename(tmp, path);
  }

  /** Holds the machine-wide lock of `manager` while `work` runs. */
  async function withManagerLock<T>(manager: Manager, slot: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const lockPath = managerLockPath(manager, host.env, host.platform);
    const previous = CHAINS.get(lockPath) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    CHAINS.set(lockPath, tail);
    try {
      await previous;
      const deadline = clock.now() + PROVISION_STEP_TIMEOUT_MS;
      await ensureDir(p.dirname(lockPath));
      const body = await acquireFileLock(manager, slot, lockPath, deadline, signal);
      let beat: { readonly id: number } | undefined;
      let stopped = false;
      let inFlight: Promise<void> | undefined;
      const schedule = (): void => {
        if (stopped) return;
        beat = clock.setTimer(LOCK_HEARTBEAT_MS, () => {
          if (stopped) return;
          body.heartbeatAt = clock.now();
          // A failed beat is retried on the next one; the lock only goes stale after LOCK_STALE_MS.
          const write = writeLock(lockPath, body, () => !stopped).then(schedule, schedule);
          inFlight = write;
        });
      };
      schedule();
      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await work() };
      } catch (error) {
        outcome = { ok: false, error };
      }
      stopped = true;
      if (beat !== undefined) clock.clearTimer(beat);
      // A beat still writing must finish (and see `stopped`) before the lock is removed, or its rename would recreate it.
      if (inFlight !== undefined) await inFlight;
      let releaseError: unknown;
      try {
        await removeRetrying(lockPath, false);
      } catch (error) {
        releaseError = error;
      }
      if (!outcome.ok) throw outcome.error;
      if (releaseError !== undefined) {
        throw fail(`could not release the ${manager} install lock ${lockPath}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`, { manager, slot });
      }
      return outcome.value;
    } finally {
      release();
      if (CHAINS.get(lockPath) === tail) CHAINS.delete(lockPath);
    }
  }

  async function acquireFileLock(manager: Manager, slot: string, lockPath: string, deadline: number,
    signal: AbortSignal | undefined): Promise<LockBody> {
    let delay = LOCK_POLL_MIN_MS;
    for (;;) {
      aborted(slot, signal);
      const now = clock.now();
      const body: LockBody = { pid: spawner.pid, hostname: spawner.hostname, startedAt: now, heartbeatAt: now };
      try {
        await fs.writeText(lockPath, JSON.stringify(body), { exclusive: true, fsync: true });
        return body;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const taken = await takeOverIfStale(lockPath, signal);
      if (taken) continue;
      if (clock.now() + delay > deadline) {
        throw fail(`timed out waiting for the ${manager} install lock ${lockPath} while provisioning ${slot}; another install is running, or remove a stale lock`, { manager, slot });
      }
      await sleep(delay, signal);
      delay = Math.min(delay * 2, LOCK_POLL_MAX_MS);
    }
  }

  const isStale = (text: string | null): boolean => {
    if (text === null) return false;
    const body = parseLock(text);
    if (body === null) return true;
    if (body.hostname === spawner.hostname && !spawner.isAlive(body.pid)) return true;
    return clock.now() - body.heartbeatAt > LOCK_STALE_MS;
  };

  async function readLock(lockPath: string): Promise<string | null> {
    try {
      return await fs.readText(lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  /** True when the lock is gone (removed or taken over) and the caller should retry creating it at once. */
  async function takeOverIfStale(lockPath: string, signal: AbortSignal | undefined): Promise<boolean> {
    const first = await readLock(lockPath);
    if (first === null) return true;
    if (!isStale(first)) return false;
    await sleep(LOCK_STALE_RECHECK_MS, signal);
    const second = await readLock(lockPath);
    if (second === null) return true;
    if (second !== first || !isStale(second)) return false;
    const stale = `${lockPath}.${clock.randomHex(8)}.stale`;
    try {
      await fs.rename(lockPath, stale);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    const moved = await readLock(stale);
    if (moved !== null && moved !== second && !isStale(moved)) {
      // Someone refreshed the lock between the read and the rename: put it back unless a new one exists.
      try {
        await fs.writeText(lockPath, moved, { exclusive: true, fsync: true });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    await removeRetrying(stale, false);
    return true;
  }

  const tailOf = (r: ProcessResult): string => {
    const lines = `${r.stderr}\n${r.stdout}`.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line !== "");
    return stripUrlUserinfo(lines.slice(-TAIL_LINES).join("\n"));
  };

  /** UV_CACHE_DIR on the slot's drive when `uv cache dir` is on another one (win32 only). */
  async function uvCacheOverride(step: ProvisionStep, slot: string, signal?: AbortSignal): Promise<Record<string, string>> {
    if (host.platform !== "win32" || step.manager !== "uv" || "UV_CACHE_DIR" in step.env) return {};
    let pending = uvCache.get(step.command);
    if (pending === undefined) {
      pending = spawner.run(step.command, ["cache", "dir"], {
        cwd: slot, timeoutMs: PROBE_TIMEOUT_MS, env: step.env, maxOutputBytes: PROVISION_OUTPUT_KEEP_BYTES, signal,
      }).then((r) => (r.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] ?? null : null), () => null);
      uvCache.set(step.command, pending);
    }
    const cacheDir = await pending;
    const slotDrive = /^[A-Za-z]:/.exec(slot)?.[0];
    const cacheDrive = cacheDir === null ? undefined : /^[A-Za-z]:/.exec(cacheDir)?.[0];
    if (slotDrive === undefined || cacheDrive === undefined || slotDrive.toLowerCase() === cacheDrive.toLowerCase()) return {};
    return { UV_CACHE_DIR: win32.join(`${slotDrive}\\`, ".omr-cache", "uv") };
  }

  async function runStep(step: ProvisionStep, slot: string, signal?: AbortSignal): Promise<void> {
    aborted(slot, signal);
    const env = { ...step.env, ...(await uvCacheOverride(step, slot, signal)) };
    const common = { cwd: step.cwd, env, maxOutputBytes: 2 * PROVISION_OUTPUT_KEEP_BYTES, signal };
    try {
      if (step.condition !== undefined) {
        const probe = await spawner.run(step.command, step.condition, { ...common, timeoutMs: PROBE_TIMEOUT_MS });
        if (probe.code !== 0) return;
      }
      const result = await spawner.run(step.command, step.args, { ...common, timeoutMs: step.timeoutMs });
      if (result.code === 0 && result.signal === null) return;
      const how = result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit ${result.code}`;
      throw fail(`${step.label} failed in ${slot} (${how}): ${tailOf(result)} — ${HINTS[step.manager]}`,
        { manager: step.manager, slot, label: step.label });
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw fail(`${step.label} could not run in ${slot}: ${stripUrlUserinfo(message)} — ${HINTS[step.manager]}`,
        { manager: step.manager, slot, label: step.label });
    }
  }

  return {
    async provision(slot, d, o) {
      const steps = planProvision(slot, d, host, config);
      aborted(slot, o.signal);
      if (o.fresh) await freshen(slot, d);
      for (const manager of d.managers) {
        const own = steps.filter((s) => s.manager === manager);
        if (own.length === 0) continue;
        await withManagerLock(manager, slot, o.signal, async () => {
          for (const step of own) await runStep(step, slot, o.signal);
        });
      }
    },
  };
}
