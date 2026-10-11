import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProvisioner, detectManagers, managerLockPath, needsProvision, planProvision, PROVISION_MANIFESTS,
  type Detection, type ProvisionHost,
} from "../../src/executor/slots/provision";
import { CLEANUP_RETRIES, CLEANUP_RETRY_BASE_MS, TRANSIENT_FS_CODES } from "../../src/verify/reference";
import type { Clock, ExecutorConfig, FileSystem, FsStat, ProcessResult, ProcOpts, Spawner } from "../../src/executor/types";

type Cfg = Pick<ExecutorConfig, "provision" | "python">;
const AUTO: Cfg = { provision: "auto", python: "auto" };
const WIN = process.platform === "win32";
const SLOT = WIN ? "C:\\omr-test\\slots\\slot-1" : "/omr-test/slots/slot-1";

// ---------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------

type Node = "dir" | "junction" | { text: string };

function errno(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

interface MemFs extends FileSystem {
  nodes: Map<string, Node>;
  removed: Array<{ path: string; recursive: boolean }>;
  put(path: string, text: string): void;
}

function key(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function memFs(): MemFs {
  const nodes = new Map<string, Node>();
  const removed: MemFs["removed"] = [];
  const parent = (p: string): string => key(p).split("/").slice(0, -1).join("/");
  return {
    nodes,
    removed,
    put(path, text) { nodes.set(key(path), { text }); },
    async readText(p) {
      const n = nodes.get(key(p));
      if (n === undefined || typeof n === "string" || !("text" in n)) throw errno("ENOENT", p);
      return n.text;
    },
    async writeText(p, data, o) {
      if (o?.exclusive === true && nodes.has(key(p))) throw errno("EEXIST", p);
      nodes.set(key(p), { text: data });
    },
    async appendText(p, data) {
      const n = nodes.get(key(p));
      nodes.set(key(p), { text: `${n !== undefined && typeof n === "object" ? n.text : ""}${data}` });
    },
    async rename(a, b) {
      const n = nodes.get(key(a));
      if (n === undefined) throw errno("ENOENT", a);
      nodes.delete(key(a));
      nodes.set(key(b), n);
    },
    async rm(p, o) {
      if (!nodes.has(key(p))) throw errno("ENOENT", p);
      removed.push({ path: p, recursive: o.recursive });
      nodes.delete(key(p));
    },
    async mkdir(p) {
      if (nodes.has(key(p))) throw errno("EEXIST", p);
      nodes.set(key(p), "dir");
    },
    async readdir(p) {
      const base = key(p);
      return [...nodes.keys()].filter(k => parent(k) === base).map(k => k.split("/").at(-1) ?? "");
    },
    async lstat(p): Promise<FsStat | null> {
      const n = nodes.get(key(p));
      if (n === undefined) return null;
      if (n === "dir" || n === "junction") return { kind: n, size: 0, mtimeMs: 0 };
      return { kind: "file", size: n.text.length, mtimeMs: 0 };
    },
    async realpath(p) { return p; },
    async fsyncDir() { /* nothing to flush in memory */ },
  };
}

interface FakeClock extends Clock {
  advance(ms: number): void;
  pending(): number;
}

/** Deterministic time: timers fire only when `advance` moves the clock past them. */
function fakeClock(start = 1_000_000): FakeClock {
  let now = start;
  let nextId = 1;
  let rand = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    iso: (ms) => new Date(ms ?? now).toISOString(),
    setTimer(ms, fn) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return { id }; },
    clearTimer(h) { timers.delete(h.id); },
    randomHex(bytes) { rand += 1; return rand.toString(16).padStart(bytes * 2, "0"); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/** Lets every queued promise continuation run (no timers involved). */
function settle(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

interface Call { command: string; args: string[]; opts: ProcOpts; startSeq: number; endSeq: number | null; resolve(r?: Partial<ProcessResult>): void; reject(e: Error): void }

interface FakeSpawner extends Spawner {
  calls: Call[];
  /** When true each run stays pending until the test resolves it. */
  hold: boolean;
  alive: Set<number>;
  reply: (command: string, args: string[]) => Partial<ProcessResult> | undefined;
}

let seq = 0;

function fakeSpawner(): FakeSpawner {
  const s: FakeSpawner = {
    calls: [], hold: true, alive: new Set(), reply: () => undefined, pid: 4242, hostname: "host-a",
    isAlive(pid) { return s.alive.has(pid); },
    run(command, args, opts) {
      return new Promise<ProcessResult>((resolve, reject) => {
        const finish = (r: Partial<ProcessResult> = {}): void => {
          call.endSeq = seq++;
          resolve({ code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, ...r });
        };
        const call: Call = { command, args: [...args], opts, startSeq: seq++, endSeq: null, resolve: finish, reject: (e) => { call.endSeq = seq++; reject(e); } };
        s.calls.push(call);
        if (!s.hold) finish(s.reply(command, [...args]));
      });
    },
  };
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------------------------

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function detect(files: Record<string, string>, tracked: string[] = Object.keys(files), config: Cfg = AUTO): Promise<Detection> {
  const fs = memFs();
  for (const [rel, text] of Object.entries(files)) fs.put(join(SLOT, ...rel.split("/")), text);
  return detectManagers(SLOT, tracked, fs, config);
}

const PKG = JSON.stringify({ name: "x", version: "1.0.0" });
const PKG_DEPS = JSON.stringify({ name: "x", dependencies: { left: "1.0.0" } });

describe("detectManagers: node", () => {
  it("finds nothing in an empty checkout and for a package.json with no dependencies", async () => {
    await expect(detect({})).resolves.toMatchObject({ managers: [], manifests: {}, yarnBerry: false, editable: false, python: null });
    await expect(detect({ "package.json": PKG })).resolves.toMatchObject({ managers: [] });
  });

  it.each([
    [["package-lock.json"], "npm"], [["pnpm-lock.yaml"], "pnpm"], [["yarn.lock"], "yarn"],
  ])("one lockfile %j selects %s", async (locks, manager) => {
    const files: Record<string, string> = { "package.json": PKG_DEPS };
    for (const l of locks) files[l] = "lock";
    await expect(detect(files)).resolves.toMatchObject({ managers: [manager] });
  });

  it.each([
    [["package-lock.json", "pnpm-lock.yaml"]], [["package-lock.json", "yarn.lock"]], [["pnpm-lock.yaml", "yarn.lock"]],
    [["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]],
  ])("ambiguous lockfiles %j are refused", async (locks) => {
    const files: Record<string, string> = { "package.json": PKG };
    for (const l of locks) files[l] = "lock";
    await expect(detect(files)).rejects.toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("ambiguous lockfiles") });
  });

  it("packageManager decides, even with several lockfiles", async () => {
    const pkg = JSON.stringify({ packageManager: "pnpm@9.1.0" });
    await expect(detect({ "package.json": pkg, "package-lock.json": "l", "pnpm-lock.yaml": "l" })).resolves.toMatchObject({ managers: ["pnpm"] });
    await expect(detect({ "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }) })).resolves.toMatchObject({ managers: ["yarn"] });
    await expect(detect({ "package.json": JSON.stringify({ packageManager: "bun@1.0.0" }), "yarn.lock": "l" })).resolves.toMatchObject({ managers: ["yarn"] });
  });

  it("dependencies without a lockfile and an unparsable package.json are E_PROVISION", async () => {
    await expect(detect({ "package.json": PKG_DEPS })).rejects.toThrow(/no lockfile is committed/);
    await expect(detect({ "package.json": "{ nope" })).rejects.toMatchObject({ code: "E_PROVISION" });
  });

  it.each(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"])(
    "%s without a package.json at the slot root is E_PROVISION, never a project found above the slot", async (lock) => {
      await expect(detect({ [lock]: "lock" })).rejects.toMatchObject({
        code: "E_PROVISION", message: expect.stringContaining(`lockfile without package.json at ${SLOT}`),
      });
      // A package.json that is not tracked at the root (only in a subdirectory) does not count.
      await expect(detect({ [lock]: "lock", "sub/package.json": PKG })).rejects.toThrow(/lockfile without package.json/);
      await expect(detect({ [lock]: "lock", "package.json": PKG })).resolves.toMatchObject({ managers: expect.any(Array) });
    });

  it("reads package.json only when it is tracked", async () => {
    await expect(detect({ "package.json": PKG_DEPS }, [])).resolves.toMatchObject({ managers: [] });
  });

  it("ignores manifests under node_modules and .venv", async () => {
    const d = await detect({ "node_modules/x/package-lock.json": "l", ".venv/requirements.txt": "r" });
    expect(d.managers).toEqual([]);
    expect(d.manifests).toEqual({});
  });

  it("detects yarn berry and its yarnPath from .yarnrc.yml", async () => {
    const files = { "package.json": PKG, "yarn.lock": "l", ".yarnrc.yml": "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-4.0.0.cjs # pinned\n" };
    const d = await detect(files);
    expect(d).toMatchObject({ managers: ["yarn"], yarnBerry: true, yarnPath: ".yarn/releases/yarn-4.0.0.cjs" });
    const classic = await detect({ "package.json": PKG, "yarn.lock": "l" });
    expect(classic.yarnBerry).toBe(false);
    expect(classic.yarnPath).toBeUndefined();
    const berryNoPath = await detect({ "package.json": PKG, "yarn.lock": "l", ".yarnrc.yml": "nodeLinker: pnp\n" });
    expect(berryNoPath.yarnBerry).toBe(true);
    expect(berryNoPath.yarnPath).toBeUndefined();
  });
});

describe("detectManagers: python", () => {
  const PYPROJECT_SETUPTOOLS = '[build-system]\nrequires = ["setuptools"]\nbuild-backend = "setuptools.build_meta"\n';

  it.each([
    ["requirements.txt", { "requirements.txt": "pytest\n" }, ["pip"], false],
    ["uv.lock", { "uv.lock": "version = 1\n", "pyproject.toml": "[project]\nname='x'\n" }, ["uv"], false],
    ["poetry.lock", { "poetry.lock": "x", "pyproject.toml": "[project]\nname='x'\n" }, ["poetry"], false],
    ["uv.lock beats poetry.lock and requirements", { "uv.lock": "x", "poetry.lock": "x", "requirements.txt": "x" }, ["uv"], false],
    ["poetry.lock beats requirements", { "poetry.lock": "x", "requirements.txt": "x" }, ["poetry"], false],
    ["build-system without lock", { "pyproject.toml": PYPROJECT_SETUPTOOLS }, ["pip"], true],
    ["flit backend is not editable-by-setuptools", { "pyproject.toml": '[build-system]\nrequires=["flit"]\nbuild-backend = "flit_core.buildapi"\n' }, ["pip"], false],
    ["setup.py with requirements", { "requirements.txt": "x", "setup.py": "from setuptools import setup\n" }, ["pip"], true],
    ["pyproject without build-system or lock", { "pyproject.toml": "[project]\nname='x'\n" }, [], false],
  ] as Array<[string, Record<string, string>, string[], boolean]>)("%s", async (_name, files, managers, editable) => {
    await expect(detect(files)).resolves.toMatchObject({ managers, editable });
  });

  it("sorts node and python managers together", async () => {
    const d = await detect({ "package.json": PKG, "pnpm-lock.yaml": "l", "requirements.txt": "x" });
    expect(d.managers).toEqual(["pip", "pnpm"]);
  });

  it("records the sha256 of every manifest of the detected managers", async () => {
    const d = await detect({ "requirements.txt": "pytest\n", "pyproject.toml": "[project]\n", "README.md": "x" });
    expect(d.manifests).toEqual({ "requirements.txt": sha("pytest\n"), "pyproject.toml": sha("[project]\n") });
    const nested = await detect({ "package.json": PKG, "package-lock.json": "l", "sub/package.json": PKG });
    expect(Object.keys(nested.manifests).sort()).toEqual(["package-lock.json", "package.json", "sub/package.json"]);
  });

  it("matches manifests per manager", () => {
    expect(PROVISION_MANIFESTS.pip("requirements-dev.txt")).toBe(true);
    expect(PROVISION_MANIFESTS.pip("a/setup.cfg")).toBe(true);
    expect(PROVISION_MANIFESTS.uv("uv.lock")).toBe(true);
    expect(PROVISION_MANIFESTS.uv("requirements.txt")).toBe(false);
    expect(PROVISION_MANIFESTS.poetry("poetry.lock")).toBe(true);
    expect(PROVISION_MANIFESTS.pnpm("pnpm-lock.yaml")).toBe(true);
    expect(PROVISION_MANIFESTS.npm("node_modules/a/package.json")).toBe(false);
  });
});

describe("detectManagers: overrides", () => {
  it("an override forces its manager without any lockfile", async () => {
    const d = await detect({}, [], { provision: { pnpm: [["pnpm", "install"]] }, python: "auto" });
    expect(d.managers).toEqual(["pnpm"]);
    const py = await detect({ "requirements.txt": "x" }, ["requirements.txt"], { provision: { uv: [["uv", "sync"]] }, python: "auto" });
    expect(py.managers).toEqual(["uv"]);
  });

  it("an override replaces auto-detection within its ecosystem only", async () => {
    const d = await detect({ "package.json": PKG, "package-lock.json": "l", "uv.lock": "x" }, undefined, { provision: { pnpm: [["pnpm", "i"]] }, python: "auto" });
    expect(d.managers).toEqual(["pnpm", "uv"]);
  });

  it("ignores override keys that are not managers and carries executor.python", async () => {
    const d = await detect({}, [], { provision: { make: [["make"]] }, python: "C:\\py\\python.exe" });
    expect(d.managers).toEqual([]);
    expect(d.python).toBe("C:\\py\\python.exe");
  });
});

describe("needsProvision (drift)", () => {
  const base: Record<string, string> = {
    "requirements.txt": "pytest==8.0\n", "pyproject.toml": "[project]\nname='x'\n", "uv.lock": "a", "poetry.lock": "a",
    "package.json": PKG, "pnpm-lock.yaml": "a",
  };

  it.each([
    ["requirements.txt", { "requirements.txt": "pytest==8.0\n" }],
    ["pyproject.toml", { "requirements.txt": "x", "pyproject.toml": "[project]\nname='x'\n" }],
    ["uv.lock", { "uv.lock": "a", "pyproject.toml": "[project]\nname='x'\n" }],
    ["poetry.lock", { "poetry.lock": "a", "pyproject.toml": "[project]\nname='x'\n" }],
    ["pnpm-lock.yaml", { "package.json": PKG, "pnpm-lock.yaml": "a" }],
  ])("a change to %s is drift, an unchanged tree is not", async (file, files) => {
    const before = await detect(files);
    const rec = { managers: [...before.managers], manifests: { ...before.manifests } };
    expect(needsProvision(rec, await detect(files))).toBe(false);
    const changed = { ...files, [file]: `${files[file as keyof typeof files] ?? ""}\n# changed` };
    expect(needsProvision(rec, await detect(changed))).toBe(true);
    expect(Object.keys(base)).toContain(file);
  });

  it("flags a different manager set, an added manifest and a removed manifest", async () => {
    const pip = await detect({ "requirements.txt": "x" });
    const rec = { managers: [...pip.managers], manifests: { ...pip.manifests } };
    expect(needsProvision(rec, await detect({ "uv.lock": "x" }))).toBe(true);
    expect(needsProvision(rec, await detect({ "requirements.txt": "x", "requirements-dev.txt": "y" }))).toBe(true);
    expect(needsProvision({ managers: ["pip"], manifests: { "requirements.txt": sha("x"), "requirements-dev.txt": sha("y") } }, pip)).toBe(true);
    expect(needsProvision({ managers: [], manifests: {} }, await detect({}))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// planProvision against a directory of stand-in executables
// ---------------------------------------------------------------------------------------------------------------

describe("planProvision", () => {
  let root = "";
  let bin = "";
  let emptyBin = "";
  const exe = (name: string): string => (WIN ? `${name}.exe` : name);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "omr-prov-"));
    bin = join(root, "bin");
    emptyBin = join(root, "empty");
    mkdirSync(bin);
    mkdirSync(emptyBin);
    for (const name of ["pnpm", "uv", "poetry", "py", "python3", "pytool"]) writeFileSync(join(bin, exe(name)), "");
    mkdirSync(join(root, "Microsoft", "WindowsApps"), { recursive: true });
    writeFileSync(join(root, "Microsoft", "WindowsApps", exe("python")), "");
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  function hostWith(dir: string, extra: Record<string, string> = {}): ProvisionHost {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "path") env[k] = v;
    env.PATH = [dir, ...(WIN ? [] : ["/usr/bin", "/bin"])].join(delimiter);
    Object.assign(env, extra);
    return { env, platform: process.platform, nodeExecPath: process.execPath, guards: [] };
  }

  const det = (managers: Detection["managers"], more: Partial<Detection> = {}): Detection => ({
    managers, yarnBerry: false, editable: false, manifests: {}, python: null, ...more,
  });

  it("plans pnpm with a frozen lockfile and an environment without credentials", () => {
    const host = hostWith(bin, { NPM_TOKEN: "secret", GITHUB_TOKEN: "secret", GH_TOKEN: "secret", OPENAI_API_KEY: "secret" });
    const [step, ...rest] = planProvision(SLOT, det(["pnpm"]), host, AUTO);
    expect(rest).toHaveLength(0);
    expect(step).toMatchObject({ manager: "pnpm", cwd: SLOT, label: "pnpm install" });
    expect(step?.command).toBe(join(bin, exe("pnpm")));
    // The project is the slot, never a pnpm workspace above it (a pnpm-workspace.yaml in an ancestor, e.g. the home directory).
    expect(step?.args).toEqual(["--dir", SLOT, "install", "--ignore-workspace", "--frozen-lockfile", "--prefer-offline",
      "--config.confirm-modules-purge=false"]);
    const env = Object.fromEntries(Object.entries(step?.env ?? {}).map(([k, v]) => [k.toUpperCase(), v]));
    expect(env["CI"]).toBe("1");
    expect(env["PIP_NO_INPUT"]).toBe("1");
    expect(env["UV_PYTHON_DOWNLOADS"]).toBe("never");
    for (const name of ["NPM_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY"]) expect(env[name]).toBeUndefined();
    expect(JSON.stringify(step?.env)).not.toContain("secret");
  });

  it("plans uv sync --frozen, with --python when executor.python is set", () => {
    const host = hostWith(bin);
    expect(planProvision(SLOT, det(["uv"]), host, AUTO)[0]).toMatchObject({ manager: "uv", args: ["sync", "--frozen"], label: "uv sync" });
    const python = join(bin, exe("pytool"));
    const withPython = planProvision(SLOT, det(["uv"], { python }), host, { provision: "auto", python });
    expect(withPython[0]?.args).toEqual(["sync", "--frozen", "--python", python]);
  });

  it("plans poetry into an in-project virtual environment", () => {
    const [step] = planProvision(SLOT, det(["poetry"]), hostWith(bin), AUTO);
    expect(step).toMatchObject({ manager: "poetry", args: ["install", "--no-interaction"] });
    expect(step?.env["POETRY_VIRTUALENVS_IN_PROJECT"]).toBe("true");
  });

  it("plans pip as venv, requirements and a conditional editable install", () => {
    const python = join(bin, exe("pytool"));
    const manifests = { "requirements.txt": "h", "requirements-dev.txt": "h2" };
    const steps = planProvision(SLOT, det(["pip"], { manifests, editable: true, python }), hostWith(bin), { provision: "auto", python });
    expect(steps.map(s => s.label)).toEqual(["pip venv", "pip install", "pip install -e ."]);
    expect(steps[0]?.args).toEqual(["-m", "venv", ".venv"]);
    expect(steps[1]?.args).toEqual(["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", "requirements.txt", "-r", "requirements-dev.txt"]);
    expect(steps[1]?.command).toBe(WIN ? join(SLOT, ".venv", "Scripts", "python.exe") : join(SLOT, ".venv", "bin", "python"));
    expect(steps[2]?.args).toContain("--no-build-isolation");
    expect(steps[2]?.args.slice(-2)).toEqual(["-e", "."]);
    expect(steps[2]?.condition).toEqual(["-c", "import setuptools"]);
    expect(steps[0]?.condition).toBeUndefined();
  });

  it("uses the py launcher with -3 on Windows and python3 elsewhere", () => {
    const [venv] = planProvision(SLOT, det(["pip"]), hostWith(bin), AUTO);
    if (WIN) {
      expect(venv?.command).toBe(join(bin, "py.exe"));
      expect(venv?.args).toEqual(["-3", "-m", "venv", ".venv"]);
    } else {
      expect(venv?.command).toBe(join(bin, "python3"));
      expect(venv?.args).toEqual(["-m", "venv", ".venv"]);
    }
  });

  it.each([
    ["uv", /uv was not found on PATH.*install uv/],
    ["poetry", /poetry was not found on PATH.*install poetry/],
    ["pip", WIN ? /py\.exe on PATH.*set executor\.python/ : /python3 was not found.*set executor\.python/],
  ] as Array<[Detection["managers"][number], RegExp]>)("a missing %s binary is E_PROVISION naming the remedy", (manager, pattern) => {
    expect(() => planProvision(SLOT, det([manager]), hostWith(emptyBin), AUTO)).toThrow(pattern);
    try {
      planProvision(SLOT, det([manager]), hostWith(emptyBin), AUTO);
    } catch (error) {
      expect(error).toMatchObject({ code: "E_PROVISION" });
    }
  });

  it("refuses an executor.python that is not found", () => {
    const python = join(emptyBin, exe("nopython"));
    expect(() => planProvision(SLOT, det(["pip"], { python }), hostWith(bin), { provision: "auto", python })).toThrow(/was not found/);
  });

  it("refuses the Microsoft Store Python stub", () => {
    const python = join(root, "Microsoft", "WindowsApps", exe("python"));
    expect(() => planProvision(SLOT, det(["pip"], { python }), hostWith(bin), { provision: "auto", python })).toThrow(/Microsoft Store Python stub/);
  });

  it("refuses a tool inside a guarded directory", () => {
    const host = { ...hostWith(bin), guards: [bin] };
    expect(() => planProvision(SLOT, det(["uv"]), host, AUTO)).toThrow(/uv was not found/);
  });

  describe("overrides", () => {
    const plan = (argv: string[], manager: Detection["managers"][number] = "pnpm") =>
      planProvision(SLOT, det([manager]), hostWith(bin), { provision: { [manager]: [argv] }, python: "auto" });

    it("replace the default steps and keep the argv", () => {
      const steps = planProvision(SLOT, det(["pnpm"]), hostWith(bin), { provision: { pnpm: [["pnpm", "install", "--ignore-scripts"], ["pnpm", "rebuild"]] }, python: "auto" });
      expect(steps.map(s => s.label)).toEqual(["pnpm override 1", "pnpm override 2"]);
      expect(steps[0]?.command).toBe(join(bin, exe("pnpm")));
      expect(steps[0]?.args).toEqual(["install", "--ignore-scripts"]);
      expect(steps[1]?.args).toEqual(["rebuild"]);
    });

    it("run node and python through the resolved interpreters", () => {
      expect(plan(["node", "scripts/setup.js", "x"])[0]).toMatchObject({ command: process.execPath, args: ["scripts/setup.js", "x"] });
      const python = join(bin, exe("pytool"));
      const steps = planProvision(SLOT, det(["pip"], { python }), hostWith(bin), { provision: { pip: [["python", "-m", "pip", "list"]] }, python });
      expect(steps[0]?.command).toBe(python);
      expect(steps[0]?.args).toEqual(["-m", "pip", "list"]);
    });

    it.each([
      [[""], /empty argv/], [["fetch.cmd"], /needs a shell/], [["fetch.bat", "x"], /needs a shell/], [["a/b"], /absolute or a bare name/],
      [["no-such-tool-xyz"], /was not found as an executable/], [["-rf"], /absolute or a bare name/],
    ] as Array<[string[], RegExp]>)("refuse %j", (argv, pattern) => {
      expect(() => plan(argv)).toThrow(pattern);
    });

    it("refuse an empty list entry, a relative-looking path with .. and (Windows) a non-exe absolute file", () => {
      expect(() => plan([])).toThrow(/empty argv/);
      const dotted = WIN ? `${bin}\\..\\bin\\${exe("pnpm")}` : `${bin}/../bin/pnpm`;
      expect(() => plan([dotted])).toThrow(/\.\./);
      if (WIN) expect(() => plan([join(bin, "pnpm.txt")])).toThrow(/\.exe or \.com/);
    });

    it("accept an absolute executable", () => {
      expect(plan([join(bin, exe("pytool")), "go"])[0]).toMatchObject({ command: join(bin, exe("pytool")), args: ["go"] });
    });

    it("refuse an absolute executable that does not exist and a script that needs a shell", () => {
      expect(() => plan([join(bin, exe("ghost"))])).toThrow(/was not found as an executable outside the work root/);
      expect(() => plan(["setup.ps1"])).toThrow(/needs a shell/);
      expect(() => plan(["C:\\tools\\fetch.CMD"])).toThrow(/needs a shell/);
    });

    it("resolve `python` through the launcher when executor.python is auto, or the configured bare name", () => {
      const auto = planProvision(SLOT, det(["pip"]), hostWith(bin), { provision: { pip: [["python", "-V"]] }, python: "auto" })[0];
      expect(auto?.command).toBe(join(bin, WIN ? "py.exe" : "python3"));
      expect(auto?.args).toEqual(WIN ? ["-3", "-V"] : ["-V"]);
      const named = planProvision(SLOT, det(["pip"]), hostWith(bin), { provision: { pip: [["python", "-V"]] }, python: "pytool" })[0];
      expect(named).toMatchObject({ command: join(bin, exe("pytool")), args: ["-V"] });
      expect(() => planProvision(SLOT, det(["pip"]), hostWith(bin), { provision: { pip: [["python", "-V"]] }, python: "no-such-python" }))
        .toThrow(/executor\.python "no-such-python" was not found as an absolute file or an executable on PATH/);
    });
  });

  it("passes executor.python to uv even when the detection carries none", () => {
    const python = join(bin, exe("pytool"));
    const [step] = planProvision(SLOT, det(["uv"]), hostWith(bin), { provision: "auto", python });
    expect(step?.args).toEqual(["sync", "--frozen", "--python", python]);
  });

  it("plans pip with only the requirement files that exist and no editable install", () => {
    const only = planProvision(SLOT, det(["pip"], { manifests: { "requirements-dev.txt": "h" } }), hostWith(bin), AUTO);
    expect(only.map(s => s.label)).toEqual(["pip venv", "pip install"]);
    expect(only[1]?.args.slice(-2)).toEqual(["-r", "requirements-dev.txt"]);
    expect(only[1]?.args).not.toContain("requirements.txt");
    expect(planProvision(SLOT, det(["pip"]), hostWith(bin), AUTO).map(s => s.label)).toEqual(["pip venv"]);
  });

  it("finds tools on a PATH written as Path with quoted and relative entries", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "path") env[k] = v;
    env[WIN ? "Path" : "PATH"] = [`"${bin}"`, "relative-dir", "", ...(WIN ? [] : ["/usr/bin", "/bin"])].join(delimiter);
    const host: ProvisionHost = { env, platform: process.platform, nodeExecPath: process.execPath, guards: [] };
    expect(planProvision(SLOT, det(["uv"]), host, AUTO)[0]?.command).toBe(join(bin, exe("uv")));
  });

  it.skipIf(!WIN)("replaces inherited variables of the fixed environment whatever their case", () => {
    const [step] = planProvision(SLOT, det(["poetry"]), hostWith(bin, { ci: "0", Pip_No_Input: "0", poetry_virtualenvs_in_project: "false" }), AUTO);
    const keys = Object.keys(step?.env ?? {});
    for (const name of ["CI", "PIP_NO_INPUT", "POETRY_VIRTUALENVS_IN_PROJECT"]) {
      expect(keys.filter(k => k.toUpperCase() === name)).toEqual([name]);
    }
    expect(step?.env["CI"]).toBe("1");
    expect(step?.env["POETRY_VIRTUALENVS_IN_PROJECT"]).toBe("true");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// planProvision for the node managers, against a stand-in node install
// ---------------------------------------------------------------------------------------------------------------

describe("planProvision: node package managers", () => {
  let root = "";
  let withCorepack = "";
  let bareNode = "";
  let emptyBin = "";
  let yarnBin = "";
  let slotDir = "";
  let pnpmBin = "";
  const exe = (name: string): string => (WIN ? `${name}.exe` : name);
  const touch = (path: string): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "omr-prov-node-"));
    withCorepack = join(root, "node-a", exe("node"));
    bareNode = join(root, "node-b", exe("node"));
    emptyBin = join(root, "empty");
    yarnBin = join(root, "yarn-bin");
    pnpmBin = join(root, "pnpm-bin");
    slotDir = join(root, "slot");
    mkdirSync(emptyBin);
    touch(withCorepack);
    touch(join(root, "node-a", "node_modules", "corepack", "dist", "pnpm.js"));
    touch(join(root, "node-a", "node_modules", "corepack", "dist", "yarn.js"));
    touch(bareNode);
    touch(join(yarnBin, WIN ? "yarn.cmd" : "yarn"));
    touch(join(yarnBin, "node_modules", "yarn", "bin", "yarn.js"));
    touch(join(pnpmBin, "pnpm.cmd"));
    touch(join(pnpmBin, "node_modules", "pnpm", "bin", "pnpm.cjs"));
    touch(join(slotDir, ".yarn", "releases", "yarn-4.0.0.cjs"));
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  function hostWith(dir: string, nodeExecPath: string | undefined): ProvisionHost {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "path") env[k] = v;
    env.PATH = [dir, ...(WIN ? [] : ["/usr/bin", "/bin"])].join(delimiter);
    return { env, platform: process.platform, nodeExecPath, guards: [] };
  }

  const det = (managers: Detection["managers"], more: Partial<Detection> = {}): Detection => ({
    managers, yarnBerry: false, editable: false, manifests: {}, python: null, ...more,
  });

  it("plans npm ci through the node install's npm-cli.js with hardening flags", () => {
    const [step, ...rest] = planProvision(SLOT, det(["npm"]), hostWith(emptyBin, process.execPath), AUTO);
    expect(rest).toHaveLength(0);
    expect(step).toMatchObject({ manager: "npm", label: "npm ci", command: process.execPath, cwd: SLOT });
    expect(step?.args.at(0)).toMatch(/npm-cli\.js$/);
    expect(step?.args.slice(-6)).toEqual(["--prefix", SLOT, "ci", "--prefer-offline", "--no-audit", "--no-fund"]);
    expect(step?.args.indexOf("--prefix")).toBeLessThan(step?.args.indexOf("ci") ?? -1);
    expect(step?.args).not.toContain("--workspaces=false");
  });

  it("runs an `npm` override through npm-cli.js too", () => {
    const [step] = planProvision(SLOT, det(["npm"]), hostWith(emptyBin, process.execPath),
      { provision: { npm: [["npm", "rebuild", "esbuild"]] }, python: "auto" });
    expect(step?.label).toBe("npm override 1");
    expect(step?.command).toBe(process.execPath);
    expect(step?.args.at(0)).toMatch(/npm-cli\.js$/);
    expect(step?.args.slice(-2)).toEqual(["rebuild", "esbuild"]);
  });

  it("plans npm as E_PROVISION when the node install has no npm-cli.js", () => {
    expect(() => planProvision(SLOT, det(["npm"]), hostWith(emptyBin, bareNode), AUTO)).toThrow(/npm-cli\.js: npm-cli\.js not found/);
  });

  it("plans pnpm through corepack's pnpm.js when no pnpm executable is on PATH", () => {
    const [step] = planProvision(SLOT, det(["pnpm"]), hostWith(emptyBin, withCorepack), AUTO);
    expect(step).toMatchObject({ manager: "pnpm", command: withCorepack, label: "pnpm install" });
    expect(step?.args).toEqual([join(root, "node-a", "node_modules", "corepack", "dist", "pnpm.js"),
      "--dir", SLOT, "install", "--ignore-workspace", "--frozen-lockfile", "--prefer-offline", "--config.confirm-modules-purge=false"]);
  });

  it.skipIf(!WIN)("plans pnpm through pnpm.cjs beside a pnpm.cmd launcher", () => {
    const [step] = planProvision(SLOT, det(["pnpm"]), hostWith(pnpmBin, withCorepack), AUTO);
    expect(step?.command).toBe(withCorepack);
    expect(step?.args[0]).toBe(join(pnpmBin, "node_modules", "pnpm", "bin", "pnpm.cjs"));
  });

  it("refuses pnpm that is neither on PATH nor in corepack", () => {
    const attempt = (): unknown => planProvision(SLOT, det(["pnpm"]), hostWith(emptyBin, bareNode), AUTO);
    expect(attempt).toThrow(/pnpm was not found/);
    try {
      attempt();
    } catch (error) {
      expect(error).toMatchObject({ code: "E_PROVISION" });
    }
  });

  it("plans yarn classic through yarn.js beside the launcher, then through corepack", () => {
    const beside = planProvision(SLOT, det(["yarn"]), hostWith(yarnBin, withCorepack), AUTO)[0];
    expect(beside).toMatchObject({ manager: "yarn", command: withCorepack, label: "yarn install" });
    expect(beside?.args).toEqual([join(yarnBin, "node_modules", "yarn", "bin", "yarn.js"),
      "--cwd", SLOT, "install", "--frozen-lockfile", "--non-interactive"]);
    const viaCorepack = planProvision(SLOT, det(["yarn"]), hostWith(emptyBin, withCorepack), AUTO)[0];
    expect(viaCorepack?.args[0]).toBe(join(root, "node-a", "node_modules", "corepack", "dist", "yarn.js"));
  });

  it("plans yarn berry with the committed yarnPath, or corepack when none is named", () => {
    const named = planProvision(slotDir, det(["yarn"], { yarnBerry: true, yarnPath: ".yarn/releases/yarn-4.0.0.cjs" }), hostWith(emptyBin, withCorepack), AUTO)[0];
    expect(named?.args).toEqual([join(slotDir, ".yarn", "releases", "yarn-4.0.0.cjs"), "install", "--immutable"]);
    expect(named?.cwd).toBe(slotDir);
    const unnamed = planProvision(slotDir, det(["yarn"], { yarnBerry: true }), hostWith(yarnBin, withCorepack), AUTO)[0];
    expect(unnamed?.args).toEqual([join(root, "node-a", "node_modules", "corepack", "dist", "yarn.js"), "install", "--immutable"]);
  });

  it.each([
    ["a yarnPath that does not exist", ".yarn/releases/missing.cjs"],
    ["a yarnPath outside the slot", "../outside.cjs"],
  ])("refuses %s", (_name, yarnPath) => {
    expect(() => planProvision(slotDir, det(["yarn"], { yarnBerry: true, yarnPath }), hostWith(emptyBin, withCorepack), AUTO))
      .toThrow(/is missing or outside/);
  });

  it("refuses yarn that is neither beside a launcher nor in corepack", () => {
    expect(() => planProvision(SLOT, det(["yarn"]), hostWith(emptyBin, bareNode), AUTO)).toThrow(/yarn was not found/);
    expect(() => planProvision(slotDir, det(["yarn"], { yarnBerry: true }), hostWith(emptyBin, bareNode), AUTO)).toThrow(/yarn was not found/);
  });

  it("reports an unusable node executable as E_PROVISION", () => {
    const missing = join(root, "nowhere", exe("node"));
    expect(() => planProvision(SLOT, det(["yarn"]), hostWith(yarnBin, missing), AUTO)).toThrow(/node executable: .*not an absolute path to a file/);
    expect(() => planProvision(SLOT, det(["npm"]), hostWith(yarnBin, missing), AUTO)).toThrow(/node executable/);
    const guarded = { ...hostWith(yarnBin, withCorepack), guards: [join(root, "node-a")] };
    expect(() => planProvision(SLOT, det(["yarn"]), guarded, AUTO)).toThrow(/inside the work root/);
  });

  it("runs a `node` override with the resolved node and the slot as cwd", () => {
    const [step] = planProvision(SLOT, det(["pnpm"]), hostWith(emptyBin, withCorepack), { provision: { pnpm: [["node", "scripts/x.js"]] }, python: "auto" });
    expect(step).toMatchObject({ command: withCorepack, args: ["scripts/x.js"], cwd: SLOT, label: "pnpm override 1" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// managerLockPath
// ---------------------------------------------------------------------------------------------------------------

describe("managerLockPath", () => {
  it("uses LOCALAPPDATA, then USERPROFILE on Windows", () => {
    expect(managerLockPath("uv", { LOCALAPPDATA: "C:\\L" }, "win32")).toBe("C:\\L\\omr-executor\\locks\\uv.lock");
    expect(managerLockPath("pnpm", { USERPROFILE: "C:\\U" }, "win32")).toBe("C:\\U\\AppData\\Local\\omr-executor\\locks\\pnpm.lock");
    expect(managerLockPath("pip", { Localappdata: "C:\\M" }, "win32")).toBe("C:\\M\\omr-executor\\locks\\pip.lock");
  });
  it("uses HOME/.cache elsewhere", () => {
    expect(managerLockPath("npm", { HOME: "/home/a" }, "linux")).toBe("/home/a/.cache/omr-executor/locks/npm.lock");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createProvisioner: locks, sequencing, failures
// ---------------------------------------------------------------------------------------------------------------

describe("createProvisioner", () => {
  let root = "";
  let bin = "";
  const exe = (name: string): string => (WIN ? `${name}.exe` : name);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "omr-prov2-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    for (const name of ["uv", "poetry", "pytool", "py", "python3"]) writeFileSync(join(bin, exe(name)), "");
  });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  const LAD = WIN ? "C:\\omr-test\\lad" : "/omr-test/lad";

  /** `probeUvCache`: leave UV_CACHE_DIR unset so the provisioner asks `uv cache dir` (otherwise the rule is skipped). */
  function host(probeUvCache = false): ProvisionHost {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (k.toLowerCase() !== "path" && k.toUpperCase() !== "UV_CACHE_DIR") env[k] = v;
    env.PATH = [bin, ...(WIN ? [] : ["/usr/bin", "/bin"])].join(delimiter);
    if (!probeUvCache) env.UV_CACHE_DIR = LAD;
    env.LOCALAPPDATA = LAD;
    env.HOME = LAD;
    return { env, platform: process.platform, nodeExecPath: process.execPath, guards: [] };
  }

  const detection = (managers: Detection["managers"], more: Partial<Detection> = {}): Detection => ({
    managers, yarnBerry: false, editable: false, manifests: {}, python: null, ...more,
  });

  function setup(cfg: Cfg = AUTO, probeUvCache = false) {
    const fs = memFs();
    const clock = fakeClock();
    const spawner = fakeSpawner();
    const h = host(probeUvCache);
    const provisioner = createProvisioner({ spawner, fs, clock, host: h, config: cfg });
    const lock = (m: Detection["managers"][number]): string => managerLockPath(m, h.env, h.platform);
    return { fs, clock, spawner, provisioner, lock };
  }

  const slot = (n: number): string => (WIN ? `C:\\omr-test\\slots\\slot-${n}` : `/omr-test/slots/slot-${n}`);

  it("a heartbeat rename still in flight when the step ends cannot recreate the lock after release", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    const realRename = fs.rename.bind(fs);
    let renameStarted = false;
    let openRename: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { openRename = resolve; });
    fs.rename = async (a, b) => {
      renameStarted = true;
      await gate;
      await realRename(a, b);
    };
    const run = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    expect(fs.nodes.has(key(lock("uv")))).toBe(true);
    clock.advance(10_000);
    await settle();
    expect(renameStarted).toBe(true);
    spawner.hold = false;
    spawner.calls[0]?.resolve();
    await settle();
    openRename();
    await run;
    expect(fs.nodes.has(key(lock("uv")))).toBe(false);
    expect([...fs.nodes.keys()].filter(k => k.endsWith(".tmp"))).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("runs two provisions of the same manager one after the other", async () => {
    const { spawner, provisioner, fs, lock } = setup();
    const a = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    const b = provisioner.provision(slot(2), detection(["uv"]), { fresh: false });
    await settle();
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.opts.cwd).toBe(slot(1));
    expect(fs.nodes.has(key(lock("uv")))).toBe(true);
    spawner.calls[0]?.resolve();
    await a;
    await settle();
    expect(spawner.calls).toHaveLength(2);
    expect(spawner.calls[1]?.opts.cwd).toBe(slot(2));
    expect(spawner.calls[1]?.startSeq).toBeGreaterThanOrEqual(spawner.calls[0]?.endSeq ?? Number.POSITIVE_INFINITY);
    spawner.calls[1]?.resolve();
    await b;
    expect(fs.nodes.has(key(lock("uv")))).toBe(false);
  });

  it("does not serialise different managers", async () => {
    const { spawner, provisioner } = setup();
    const a = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    const b = provisioner.provision(slot(2), detection(["poetry"]), { fresh: false });
    await settle();
    expect(spawner.calls).toHaveLength(2);
    spawner.calls.forEach(c => c.resolve());
    await Promise.all([a, b]);
  });

  it("runs the managers of one slot in order, each under its own lock", async () => {
    const { spawner, provisioner, fs, lock } = setup();
    const done = provisioner.provision(slot(1), detection(["poetry", "uv"]), { fresh: false });
    await settle();
    expect(spawner.calls.map(c => c.args[0])).toEqual(["install"]);
    expect(fs.nodes.has(key(lock("poetry")))).toBe(true);
    spawner.calls[0]?.resolve();
    await settle();
    expect(fs.nodes.has(key(lock("poetry")))).toBe(false);
    expect(spawner.calls.map(c => c.args[0])).toEqual(["install", "sync"]);
    spawner.calls[1]?.resolve();
    await done;
  });

  it("releases the lock and reports the failure with the manager's hint", async () => {
    const { spawner, provisioner, fs, lock } = setup();
    spawner.hold = false;
    spawner.reply = () => ({ code: 2, stderr: "fatal: could not fetch https://user:hunter2@example.test/pkg.tgz\nlockfile mismatch" });
    const error = await provisioner.provision(slot(1), detection(["uv"]), { fresh: false }).then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "E_PROVISION" });
    const message = (error as Error).message;
    expect(message).toContain("uv sync failed");
    expect(message).toContain("exit 2");
    expect(message).toContain("lockfile mismatch");
    expect(message).toContain("uv lock");
    expect(message).not.toContain("hunter2");
    expect(fs.nodes.has(key(lock("uv")))).toBe(false);
  });

  it("reports a signal exit and a spawn failure", async () => {
    const killed = setup();
    killed.spawner.hold = false;
    killed.spawner.reply = () => ({ code: null, signal: "SIGKILL" });
    await expect(killed.provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toThrow(/signal SIGKILL/);
    const broken = setup();
    const done = broken.provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    broken.spawner.calls[0]?.reject(new Error("spawn EACCES https://u:pw@h.test/"));
    const error = await done.then(() => null, (e: unknown) => e);
    expect(error).toMatchObject({ code: "E_PROVISION" });
    expect((error as Error).message).toContain("could not run");
    expect((error as Error).message).not.toContain("pw@");
    expect(broken.fs.nodes.has(key(broken.lock("uv")))).toBe(false);
  });

  it("a failure in the first of two serialised provisions does not block the second", async () => {
    const { spawner, provisioner } = setup();
    const a = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    const b = provisioner.provision(slot(2), detection(["uv"]), { fresh: false });
    await settle();
    spawner.calls[0]?.resolve({ code: 1 });
    await expect(a).rejects.toMatchObject({ code: "E_PROVISION" });
    await settle();
    expect(spawner.calls).toHaveLength(2);
    spawner.calls[1]?.resolve();
    await expect(b).resolves.toBeUndefined();
  });

  it("refuses an already aborted signal before touching anything", async () => {
    const { spawner, provisioner, fs } = setup();
    const ac = new AbortController();
    ac.abort();
    await expect(provisioner.provision(slot(1), detection(["uv"]), { fresh: true, signal: ac.signal })).rejects.toThrow(/aborted/);
    expect(spawner.calls).toHaveLength(0);
    expect(fs.removed).toHaveLength(0);
  });

  it("runs the conditional editable install only when the probe succeeds", async () => {
    const python = join(bin, exe("pytool"));
    const cfg: Cfg = { provision: "auto", python };
    const d = detection(["pip"], { editable: true, python, manifests: { "requirements.txt": "h" } });
    for (const probeCode of [0, 1]) {
      const { spawner, provisioner } = setup(cfg);
      spawner.hold = false;
      spawner.reply = (_c, args) => (args[0] === "-c" ? { code: probeCode } : undefined);
      await provisioner.provision(slot(1), d, { fresh: false });
      const editable = spawner.calls.filter(c => c.args.includes("-e"));
      expect(editable).toHaveLength(probeCode === 0 ? 1 : 0);
      expect(spawner.calls.filter(c => c.args[0] === "-c")).toHaveLength(1);
    }
  });

  it("fresh removes .venv recursively when it is a directory, and only the link when it is a junction", async () => {
    const python = join(bin, exe("pytool"));
    const cfg: Cfg = { provision: "auto", python };
    const real = setup(cfg);
    real.spawner.hold = false;
    real.fs.nodes.set(key(join(slot(1), ".venv")), "dir");
    await real.provisioner.provision(slot(1), detection(["pip"], { python }), { fresh: true });
    const dependencyRemovals = (m: MemFs) => m.removed.filter(r => !r.path.endsWith(".lock"));
    expect(dependencyRemovals(real.fs)).toEqual([{ path: join(slot(1), ".venv"), recursive: true }]);
    const linked = setup(cfg);
    linked.spawner.hold = false;
    linked.fs.nodes.set(key(join(slot(1), ".venv")), "junction");
    await linked.provisioner.provision(slot(1), detection(["pip"], { python }), { fresh: true });
    expect(dependencyRemovals(linked.fs)).toEqual([{ path: join(slot(1), ".venv"), recursive: false }]);
    const kept = setup(cfg);
    kept.spawner.hold = false;
    kept.fs.nodes.set(key(join(slot(1), ".venv")), "dir");
    await kept.provisioner.provision(slot(1), detection(["pip"], { python }), { fresh: false });
    expect(dependencyRemovals(kept.fs)).toHaveLength(0);
  });

  it("takes over a lock whose owner died on this host", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    const now = clock.now();
    fs.put(lock("uv"), JSON.stringify({ pid: 777, hostname: "host-a", startedAt: now, heartbeatAt: now }));
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    expect(spawner.calls).toHaveLength(0);
    clock.advance(1_000);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
    expect([...fs.nodes.keys()].some(k => k.endsWith(".stale"))).toBe(false);
  });

  it("takes over a damaged lock and a lock with a stale heartbeat from another host", async () => {
    for (const body of ["{not json", JSON.stringify({ pid: 1, hostname: "other", startedAt: 0, heartbeatAt: 0 })]) {
      const { spawner, provisioner, clock, fs, lock } = setup();
      fs.put(lock("uv"), body);
      const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
      await settle();
      clock.advance(1_000);
      await settle();
      expect(spawner.calls).toHaveLength(1);
      spawner.calls[0]?.resolve();
      await done;
    }
  });

  it("waits for a live lock and goes on once it is removed", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    const now = clock.now();
    fs.put(lock("uv"), JSON.stringify({ pid: 9, hostname: "other", startedAt: now, heartbeatAt: now }));
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    clock.advance(500);
    await settle();
    expect(spawner.calls).toHaveLength(0);
    fs.nodes.delete(key(lock("uv")));
    clock.advance(1_000);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
  });

  it("gives up waiting for a lock that never frees", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), JSON.stringify({ pid: 9, hostname: "other", startedAt: 0, heartbeatAt: Number.MAX_SAFE_INTEGER }));
    const outcome = provisioner.provision(slot(1), detection(["uv"]), { fresh: false }).then(() => null, (e: unknown) => e);
    for (let i = 0; i < 400; i++) {
      await settle();
      clock.advance(5_000);
    }
    const error = await outcome;
    expect(error).toMatchObject({ code: "E_PROVISION" });
    expect((error as Error).message).toMatch(/timed out waiting for the uv install lock/);
    expect(spawner.calls).toHaveLength(0);
    expect(fs.nodes.has(key(lock("uv")))).toBe(true);
  });

  it("refreshes the lock heartbeat while a step runs", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    const first = await fs.readText(lock("uv"));
    clock.advance(10_000);
    await settle();
    const second = await fs.readText(lock("uv"));
    expect(JSON.parse(second).heartbeatAt).toBeGreaterThan(JSON.parse(first).heartbeatAt);
    spawner.calls[0]?.resolve();
    await done;
    expect(clock.pending()).toBe(0);
  });

  it.skipIf(!WIN)("moves UV_CACHE_DIR to the slot's drive when uv's cache is on another drive (probed once)", async () => {
    const { spawner, provisioner } = setup(AUTO, true);
    spawner.hold = false;
    spawner.reply = (_c, args) => (args[0] === "cache" ? { stdout: "E:\\cache\\uv\n" } : undefined);
    await provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await provisioner.provision(slot(2), detection(["uv"]), { fresh: false });
    const syncs = spawner.calls.filter(c => c.args[0] === "sync");
    expect(syncs).toHaveLength(2);
    for (const c of syncs) expect(c.opts.env?.["UV_CACHE_DIR"]).toBe("C:\\.omr-cache\\uv");
    expect(spawner.calls.filter(c => c.args[0] === "cache")).toHaveLength(1);
  });

  it.skipIf(!WIN)("leaves UV_CACHE_DIR alone on the same drive or when the probe fails", async () => {
    const same = setup(AUTO, true);
    same.spawner.hold = false;
    same.spawner.reply = (_c, args) => (args[0] === "cache" ? { stdout: "c:\\cache\\uv\n" } : undefined);
    await same.provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    expect(same.spawner.calls.find(c => c.args[0] === "sync")?.opts.env?.["UV_CACHE_DIR"]).toBeUndefined();
    const failed = setup(AUTO, true);
    failed.spawner.hold = false;
    failed.spawner.reply = (_c, args) => (args[0] === "cache" ? { code: 1 } : undefined);
    await failed.provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    expect(failed.spawner.calls.find(c => c.args[0] === "sync")?.opts.env?.["UV_CACHE_DIR"]).toBeUndefined();
  });

  it("refuses to plan when the manager binary is missing, before taking any lock", async () => {
    const fs = memFs();
    const h = host();
    h.env.PATH = join(root, "nothing");
    const spawner = fakeSpawner();
    const provisioner = createProvisioner({ spawner, fs, clock: fakeClock(), host: h, config: AUTO });
    await expect(provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toMatchObject({ code: "E_PROVISION" });
    expect(fs.nodes.size).toBe(0);
  });

  // -------------------------------------------------------------------------------------------------------------
  // Lock takeover races, release failures, aborts, heartbeat failures
  // -------------------------------------------------------------------------------------------------------------

  const STALE_LOCK = JSON.stringify({ pid: 1, hostname: "other", startedAt: 0, heartbeatAt: 0 });
  const liveLock = (clock: Clock, pid = 9): string => {
    const now = clock.now();
    return JSON.stringify({ pid, hostname: "other", startedAt: now, heartbeatAt: now });
  };
  const outcomeOf = (run: Promise<void>): Promise<unknown> => run.then(() => null, (e: unknown) => e);

  it("treats a stale lock that vanishes before it can be moved aside as taken over", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    const realRename = fs.rename.bind(fs);
    let renames = 0;
    fs.rename = async (a, b) => {
      renames += 1;
      if (renames === 1) fs.nodes.delete(key(a));
      await realRename(a, b);
    };
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    clock.advance(1_000);
    await settle();
    expect(renames).toBe(1);
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
    expect(fs.nodes.has(key(lock("uv")))).toBe(false);
  });

  it("surfaces a failure to move a stale lock aside and frees the in-process queue", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    const realRename = fs.rename.bind(fs);
    fs.rename = async () => { throw errno("EIO", "rename"); };
    const failed = outcomeOf(provisioner.provision(slot(1), detection(["uv"]), { fresh: false }));
    await settle();
    clock.advance(1_000);
    await settle();
    expect(await failed).toMatchObject({ code: "EIO" });
    expect(spawner.calls).toHaveLength(0);
    fs.rename = realRename;
    const next = provisioner.provision(slot(2), detection(["uv"]), { fresh: false });
    await settle();
    clock.advance(1_000);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.opts.cwd).toBe(slot(2));
    spawner.calls[0]?.resolve();
    await next;
  });

  it.each([[false], [true]])("puts back a lock its owner refreshed while it was being moved aside (a newer lock exists: %s)", async (newerExists) => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    let refreshed = "";
    let newer = "";
    const realRename = fs.rename.bind(fs);
    let moved = false;
    fs.rename = async (a, b) => {
      if (!moved && key(a) === key(lock("uv"))) {
        moved = true;
        refreshed = liveLock(clock, 9);
        newer = liveLock(clock, 10);
        fs.put(a, refreshed);
        await realRename(a, b);
        if (newerExists) fs.put(a, newer);
        return;
      }
      await realRename(a, b);
    };
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    clock.advance(1_000);
    await settle();
    expect(moved).toBe(true);
    expect(spawner.calls).toHaveLength(0);
    expect(await fs.readText(lock("uv"))).toBe(newerExists ? newer : refreshed);
    expect([...fs.nodes.keys()].some(k => k.endsWith(".stale"))).toBe(false);
    fs.nodes.delete(key(lock("uv")));
    clock.advance(500);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
  });

  it("surfaces a failure to put a refreshed lock back", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    const realRename = fs.rename.bind(fs);
    const realWrite = fs.writeText.bind(fs);
    let moved = false;
    fs.rename = async (a, b) => {
      if (!moved && key(a) === key(lock("uv"))) {
        moved = true;
        fs.put(a, liveLock(clock));
      }
      await realRename(a, b);
    };
    fs.writeText = async (p, data, o) => {
      if (moved && o?.exclusive === true && key(p) === key(lock("uv"))) throw errno("EIO", p);
      await realWrite(p, data, o);
    };
    const failed = outcomeOf(provisioner.provision(slot(1), detection(["uv"]), { fresh: false }));
    await settle();
    clock.advance(1_000);
    await settle();
    expect(await failed).toMatchObject({ code: "EIO" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("does not take over a lock that changed during the staleness recheck", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    fs.put(lock("uv"), liveLock(clock));
    clock.advance(1_000);
    await settle();
    expect(spawner.calls).toHaveLength(0);
    expect([...fs.nodes.keys()].some(k => k.endsWith(".stale"))).toBe(false);
    fs.nodes.delete(key(lock("uv")));
    clock.advance(500);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
  });

  it("goes on at once when a stale lock disappears during the recheck", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), STALE_LOCK);
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    fs.nodes.delete(key(lock("uv")));
    clock.advance(1_000);
    await settle();
    expect(spawner.calls).toHaveLength(1);
    spawner.calls[0]?.resolve();
    await done;
  });

  it("surfaces a lock that cannot be read", async () => {
    const { spawner, provisioner, fs, lock } = setup();
    fs.put(lock("uv"), liveLock(fakeClock()));
    const realRead = fs.readText.bind(fs);
    fs.readText = async (p) => {
      if (key(p) === key(lock("uv"))) throw errno("EIO", p);
      return realRead(p);
    };
    await expect(provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toMatchObject({ code: "EIO" });
    expect(spawner.calls).toHaveLength(0);
  });

  it("creates the lock directory chain, tolerating a concurrent mkdir and refusing other errors", async () => {
    const racy = setup();
    racy.spawner.hold = false;
    const realMkdir = racy.fs.mkdir.bind(racy.fs);
    let raced = false;
    racy.fs.mkdir = async (p) => {
      if (!raced) {
        raced = true;
        await realMkdir(p);
        throw errno("EEXIST", p);
      }
      await realMkdir(p);
    };
    await racy.provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    expect(raced).toBe(true);
    expect(racy.spawner.calls).toHaveLength(1);
    const denied = setup();
    denied.fs.mkdir = async (p) => { throw errno("EACCES", p); };
    await expect(denied.provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toMatchObject({ code: "EACCES" });
    expect(denied.spawner.calls).toHaveLength(0);
  });

  it("reports an install lock that cannot be released, but the step's own failure wins", async () => {
    const stuck = setup();
    stuck.spawner.hold = false;
    const realRm = stuck.fs.rm.bind(stuck.fs);
    stuck.fs.rm = async (p, o) => {
      if (key(p) === key(stuck.lock("uv"))) throw errno("EIO", p);
      await realRm(p, o);
    };
    const released = await outcomeOf(stuck.provisioner.provision(slot(1), detection(["uv"]), { fresh: false }));
    expect(released).toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("could not release the uv install lock") });
    expect((released as Error).message).toContain("EIO");

    const both = setup();
    both.spawner.hold = false;
    both.spawner.reply = () => ({ code: 3, stderr: "boom" });
    const realRm2 = both.fs.rm.bind(both.fs);
    both.fs.rm = async (p, o) => {
      if (key(p) === key(both.lock("uv"))) throw errno("EIO", p);
      await realRm2(p, o);
    };
    const failed = await outcomeOf(both.provisioner.provision(slot(1), detection(["uv"]), { fresh: false }));
    expect((failed as Error).message).toContain("uv sync failed");
    expect((failed as Error).message).not.toContain("release");
  });

  it("retries a transient failure to remove the lock with a growing delay, then gives up", async () => {
    const transient = [...TRANSIENT_FS_CODES][0] ?? "EBUSY";
    const drive = async (failures: number) => {
      const s = setup();
      s.spawner.hold = false;
      const realRm = s.fs.rm.bind(s.fs);
      let attempts = 0;
      s.fs.rm = async (p, o) => {
        if (key(p) === key(s.lock("uv"))) {
          attempts += 1;
          if (attempts <= failures) throw errno(transient, p);
        }
        await realRm(p, o);
      };
      const outcome = outcomeOf(s.provisioner.provision(slot(1), detection(["uv"]), { fresh: false }));
      for (let i = 0; i < CLEANUP_RETRIES + 2; i++) {
        await settle();
        s.clock.advance(CLEANUP_RETRY_BASE_MS * 2 ** CLEANUP_RETRIES);
      }
      return { result: await outcome, attempts, s };
    };
    const recovered = await drive(2);
    expect(recovered.result).toBeNull();
    expect(recovered.attempts).toBe(3);
    expect(recovered.s.fs.nodes.has(key(recovered.s.lock("uv")))).toBe(false);
    const hopeless = await drive(Number.MAX_SAFE_INTEGER);
    expect(hopeless.result).toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("could not release") });
    expect(hopeless.attempts).toBe(CLEANUP_RETRIES + 1);
  });

  it("stops waiting for a held lock when the signal aborts", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    fs.put(lock("uv"), liveLock(clock));
    const ac = new AbortController();
    const outcome = outcomeOf(provisioner.provision(slot(1), detection(["uv"]), { fresh: false, signal: ac.signal }));
    await settle();
    ac.abort();
    await settle();
    expect(await outcome).toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("was aborted") });
    expect(spawner.calls).toHaveLength(0);
    expect(clock.pending()).toBe(0);
  });

  it("does not start the next step of a slot once the signal aborted", async () => {
    const python = join(bin, exe("pytool"));
    const { spawner, provisioner, fs, lock } = setup({ provision: "auto", python });
    const ac = new AbortController();
    const d = detection(["pip"], { python, manifests: { "requirements.txt": "h" } });
    const outcome = outcomeOf(provisioner.provision(slot(1), d, { fresh: false, signal: ac.signal }));
    await settle();
    expect(spawner.calls).toHaveLength(1);
    ac.abort();
    spawner.calls[0]?.resolve();
    expect(await outcome).toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("was aborted") });
    expect(spawner.calls).toHaveLength(1);
    expect(fs.nodes.has(key(lock("pip")))).toBe(false);
  });

  it("survives a failed heartbeat write and beats again on the next interval", async () => {
    const { spawner, provisioner, clock, fs, lock } = setup();
    const realRename = fs.rename.bind(fs);
    let renames = 0;
    fs.rename = async (a, b) => {
      renames += 1;
      if (renames === 1) throw errno("EIO", a);
      await realRename(a, b);
    };
    const done = provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    await settle();
    const first = await fs.readText(lock("uv"));
    clock.advance(10_000);
    await settle();
    expect(await fs.readText(lock("uv"))).toBe(first);
    clock.advance(10_000);
    await settle();
    expect(JSON.parse(await fs.readText(lock("uv"))).heartbeatAt).toBeGreaterThan(JSON.parse(first).heartbeatAt);
    spawner.calls[0]?.resolve();
    await done;
    expect(renames).toBe(2);
  });

  it("keeps only the last twelve lines of a failed step and names an unknown signal", async () => {
    const lines = Array.from({ length: 20 }, (_v, i) => `L${String(i + 1).padStart(2, "0")}`);
    const long = setup();
    long.spawner.hold = false;
    long.spawner.reply = () => ({ code: 1, stderr: lines.join("\r\n") });
    const message = ((await outcomeOf(long.provisioner.provision(slot(1), detection(["uv"]), { fresh: false }))) as Error).message;
    expect(message).toContain("L20");
    expect(message).toContain("L09");
    expect(message).not.toContain("L08");
    const unknown = setup();
    unknown.spawner.hold = false;
    unknown.spawner.reply = () => ({ code: null, signal: null });
    await expect(unknown.provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toThrow(/signal unknown/);
    const odd = setup();
    odd.spawner.hold = false;
    odd.spawner.reply = () => ({ code: 0, signal: "SIGTERM" });
    await expect(odd.provisioner.provision(slot(1), detection(["uv"]), { fresh: false })).rejects.toThrow(/exit 0/);
  });

  it("wraps a non-Error spawn rejection as a could-not-run failure", async () => {
    const { spawner, provisioner, fs, lock } = setup();
    spawner.run = () => Promise.reject<ProcessResult>("boom");
    const error = await outcomeOf(provisioner.provision(slot(1), detection(["poetry"]), { fresh: false }));
    expect(error).toMatchObject({ code: "E_PROVISION", message: expect.stringContaining("poetry install could not run") });
    expect((error as Error).message).toContain("boom");
    expect((error as Error).message).toContain("poetry lock");
    expect(fs.nodes.has(key(lock("poetry")))).toBe(false);
  });

  it.skipIf(!WIN)("treats a failing `uv cache dir` spawn as no override", async () => {
    const { spawner, provisioner } = setup(AUTO, true);
    const realRun = spawner.run.bind(spawner);
    spawner.hold = false;
    spawner.run = (command, args, opts) => (args[0] === "cache" ? Promise.reject(new Error("spawn failed")) : realRun(command, args, opts));
    await provisioner.provision(slot(1), detection(["uv"]), { fresh: false });
    expect(spawner.calls.find(c => c.args[0] === "sync")?.opts.env?.["UV_CACHE_DIR"]).toBeUndefined();
  });
});
