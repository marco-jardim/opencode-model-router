// Branch-coverage top-up for src/executor/slots/provision.ts: posix/win32 twins, refusal paths and edge inputs.
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProvisioner, detectManagers, managerLockPath, needsProvision, planProvision,
  type Detection, type ProvisionHost,
} from "../../src/executor/slots/provision";
import type { Clock, ExecutorConfig, FileSystem, FsStat, ProcessResult, ProcOpts, Spawner } from "../../src/executor/types";

/**
 * Virtual executables: path as found -> real path. realFileOrUndefined answers from this table first, so the planner's
 * POSIX and win32 lookups (and run-tools' node/shell resolution) can be exercised on any host without real binaries.
 */
const VIRTUAL = vi.hoisted(() => new Map<string, string>());

vi.mock("../../src/router/git-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/router/git-tools")>();
  return {
    ...actual,
    realFileOrUndefined: (path: string): string | undefined => VIRTUAL.get(path) ?? actual.realFileOrUndefined(path),
  };
});

function virtual(files: Record<string, string | true>): void {
  VIRTUAL.clear();
  for (const [path, real] of Object.entries(files)) VIRTUAL.set(path, real === true ? path : real);
}

type Cfg = Pick<ExecutorConfig, "provision" | "python">;
const AUTO: Cfg = { provision: "auto", python: "auto" };
const WIN_SLOT = "C:\\omr-test\\slots\\slot-1";
const POSIX_SLOT = "/omr-test/slots/slot-1";

// ---------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------

function errno(code: string, p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

function key(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

type Node = "dir" | "junction" | { text: string };

interface MemFs extends FileSystem {
  nodes: Map<string, Node>;
  removed: string[];
  put(path: string, text: string): void;
}

function memFs(): MemFs {
  const nodes = new Map<string, Node>();
  const removed: string[] = [];
  const parent = (p: string): string => key(p).split("/").slice(0, -1).join("/");
  return {
    nodes,
    removed,
    put(path, text) { nodes.set(key(path), { text }); },
    async readText(p) {
      const n = nodes.get(key(p));
      if (n === undefined || typeof n === "string") throw errno("ENOENT", p);
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
    async rm(p) {
      if (!nodes.has(key(p))) throw errno("ENOENT", p);
      removed.push(p);
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

/** Deterministic time: timers fire only when `advance` moves past them; `clearIgnored` keeps cleared timers armed. */
function fakeClock(o: { clearIgnored?: boolean } = {}): FakeClock {
  let now = 1_000_000;
  let nextId = 1;
  let rand = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    iso: (ms) => new Date(ms ?? now).toISOString(),
    setTimer(ms, fn) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return { id }; },
    clearTimer(h) { if (o.clearIgnored !== true) timers.delete(h.id); },
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

function settle(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

interface Call { command: string; args: string[]; opts: ProcOpts }

interface FakeSpawner extends Spawner {
  calls: Call[];
  reply: (command: string, args: string[]) => Partial<ProcessResult> | Error | undefined;
}

/** Every run resolves at once with `reply` (exit 0 by default), or rejects when `reply` returns an Error. */
function fakeSpawner(): FakeSpawner {
  const s: FakeSpawner = {
    calls: [], reply: () => undefined, pid: 4242, hostname: "host-a",
    isAlive() { return true; },
    async run(command, args, opts) {
      s.calls.push({ command, args: [...args], opts });
      const r = s.reply(command, [...args]);
      if (r instanceof Error) throw r;
      return { code: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 0, ...r };
    },
  };
  return s;
}

async function detectAt(slot: string, files: Record<string, string>, config: Cfg = AUTO): Promise<Detection> {
  const fs = memFs();
  const sep = slot.startsWith("/") ? "/" : "\\";
  for (const [rel, text] of Object.entries(files)) fs.put(`${slot}${sep}${rel.split("/").join(sep)}`, text);
  return detectManagers(slot, Object.keys(files), fs, config);
}

const det = (managers: Detection["managers"], more: Partial<Detection> = {}): Detection => ({
  managers, yarnBerry: false, editable: false, manifests: {}, python: null, ...more,
});

// ---------------------------------------------------------------------------------------------------------------
// Detection and drift
// ---------------------------------------------------------------------------------------------------------------

describe("detectManagers: edge inputs", () => {
  it("joins manifests under a POSIX slot root with POSIX separators", async () => {
    const d = await detectAt(POSIX_SLOT, { "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "l", "sub/package.json": "{}" });
    expect(d.managers).toEqual(["npm"]);
    expect(Object.keys(d.manifests).sort()).toEqual(["package-lock.json", "package.json", "sub/package.json"]);
  });

  it("a package.json that is valid JSON but not an object declares no manager and no dependencies", async () => {
    await expect(detectAt(WIN_SLOT, { "package.json": "42" })).resolves.toMatchObject({ managers: [] });
    await expect(detectAt(WIN_SLOT, { "package.json": "\"text\"" })).resolves.toMatchObject({ managers: [] });
    // `null` parses to no package at all, so a lockfile beside it has no root package.json.
    await expect(detectAt(WIN_SLOT, { "package.json": "null", "yarn.lock": "l" })).rejects.toThrow(/lockfile without package\.json/);
  });

  it("a package.json that is not a regular file is not read", async () => {
    const fs = memFs();
    fs.nodes.set(key(`${WIN_SLOT}\\package.json`), "dir");
    await expect(detectManagers(WIN_SLOT, ["package.json"], fs, AUTO)).resolves.toMatchObject({ managers: [], manifests: {} });
  });

  it("reports a non-Error JSON failure of package.json as text", async () => {
    const original = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      if (text === "{\"sentinel\":true}") throw "parser gave up";
      return original.call(JSON, text);
    });
    try {
      await expect(detectAt(WIN_SLOT, { "package.json": "{\"sentinel\":true}" })).rejects.toMatchObject({
        code: "E_PROVISION", message: expect.stringContaining("is not valid JSON: parser gave up"),
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a packageManager that is not a string falls through to the lockfiles", async () => {
    const pkg = JSON.stringify({ packageManager: 7 });
    await expect(detectAt(WIN_SLOT, { "package.json": pkg, "pnpm-lock.yaml": "l" })).resolves.toMatchObject({ managers: ["pnpm"] });
  });

  it("a pip override keeps the detected editable flag; a uv override never installs editable", async () => {
    const files = { "pyproject.toml": "[build-system]\nbuild-backend = \"setuptools.build_meta\"\n" };
    const pip = await detectAt(WIN_SLOT, files, { provision: { pip: [["python", "-m", "pip", "install", "."]] }, python: "auto" });
    expect(pip).toMatchObject({ managers: ["pip"], editable: true });
    const uv = await detectAt(WIN_SLOT, files, { provision: { uv: [["uv", "sync"]] }, python: "auto" });
    expect(uv).toMatchObject({ managers: ["uv"], editable: false });
    const pipPlain = await detectAt(WIN_SLOT, { "requirements.txt": "x" }, { provision: { pip: [["python", "-V"]] }, python: "auto" });
    expect(pipPlain).toMatchObject({ managers: ["pip"], editable: false });
  });

  it("a .yarnrc.yml that is a directory leaves yarn classic", async () => {
    const fs = memFs();
    fs.put(`${WIN_SLOT}\\package.json`, JSON.stringify({ name: "x" }));
    fs.put(`${WIN_SLOT}\\yarn.lock`, "l");
    fs.nodes.set(key(`${WIN_SLOT}\\.yarnrc.yml`), "dir");
    const d = await detectManagers(WIN_SLOT, ["package.json", "yarn.lock", ".yarnrc.yml"], fs, AUTO);
    expect(d).toMatchObject({ managers: ["yarn"], yarnBerry: false });
    expect(d.yarnPath).toBeUndefined();
  });
});

describe("needsProvision: edge inputs", () => {
  it("a different manager set or a different manifest count is drift; the order of managers is not", () => {
    expect(needsProvision({ managers: ["npm"], manifests: {} }, det(["pnpm"]))).toBe(true);
    expect(needsProvision({ managers: ["npm"], manifests: {} }, det(["npm", "pip"]))).toBe(true);
    expect(needsProvision({ managers: ["npm"], manifests: { a: "1" } }, det(["npm"], { manifests: { a: "1", b: "2" } }))).toBe(true);
    expect(needsProvision({ managers: ["pip", "npm"], manifests: { a: "1" } }, det(["npm", "pip"], { manifests: { a: "1" } }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// planProvision against virtual tools
// ---------------------------------------------------------------------------------------------------------------

const SH = "/bin/sh";
const PNODE = "/opt/node/bin/node";
const PBIN = "/opt/vbin";

function posixHost(env: NodeJS.ProcessEnv = { PATH: `relative:${PBIN}:/opt/empty`, HOME: "/home/u", LANG: "C.UTF-8" }): ProvisionHost {
  return { env, platform: "linux", nodeExecPath: PNODE, guards: [] };
}

const CMD = "C:\\Windows\\System32\\cmd.exe";
const WNODE = "C:\\vnode\\node.exe";
const WBIN = "C:\\vbin";

function winHost(): ProvisionHost {
  return {
    env: { ComSpec: CMD, SystemRoot: "C:\\Windows", PATH: WBIN, LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32", nodeExecPath: WNODE, guards: [],
  };
}

describe("planProvision on a POSIX host", () => {
  afterEach(() => { VIRTUAL.clear(); });

  it("finds a bare tool without an extension on a colon-separated PATH and builds a POSIX step environment", () => {
    virtual({ [SH]: true, [`${PBIN}/uv`]: true });
    const host = posixHost({ PATH: `relative:${PBIN}`, HOME: "/home/u", LANG: "C.UTF-8", VIRTUAL_ENV: "/home/u/venv" });
    const [step, ...rest] = planProvision(POSIX_SLOT, det(["uv"]), host, AUTO);
    expect(rest).toEqual([]);
    expect(step).toMatchObject({ manager: "uv", command: `${PBIN}/uv`, args: ["--project", POSIX_SLOT, "sync", "--frozen"], cwd: POSIX_SLOT });
    expect(step?.env["UV_PROJECT_ENVIRONMENT"]).toBe(`${POSIX_SLOT}/.venv`);
    expect(step?.env["LANG"]).toBe("C.UTF-8");
    expect(step?.env["PATH"]).toBe(PBIN);
    expect(step?.env["VIRTUAL_ENV"]).toBeUndefined();
    expect(step?.env["ComSpec"]).toBeUndefined();
  });

  it("plans pip with python3 and the virtual environment's bin/python", () => {
    virtual({ [SH]: true, [`${PBIN}/python3`]: true });
    const steps = planProvision(POSIX_SLOT, det(["pip"], { manifests: { "requirements.txt": "h" } }), posixHost(), AUTO);
    expect(steps.map(s => s.command)).toEqual([`${PBIN}/python3`, `${POSIX_SLOT}/.venv/bin/python`]);
    expect(steps[0]?.args).toEqual(["-m", "venv", ".venv"]);
    expect(steps[1]?.args.slice(-2)).toEqual(["-r", "requirements.txt"]);
  });

  it("names the remedy when python3 is missing", () => {
    virtual({ [SH]: true });
    expect(() => planProvision(POSIX_SLOT, det(["pip"]), posixHost(), AUTO))
      .toThrow(/python3 was not found on PATH; install Python 3 or set executor\.python/);
  });

  it("refuses a python3 whose real file is the Microsoft Store stub", () => {
    virtual({ [SH]: true, [`${PBIN}/python3`]: "/mnt/c/Users/u/AppData/Local/Microsoft/WindowsApps/python3.exe" });
    expect(() => planProvision(POSIX_SLOT, det(["pip"]), posixHost(), AUTO)).toThrow(/is the Microsoft Store Python stub/);
  });

  it("finds no tool when the environment has no PATH at all", () => {
    virtual({ [SH]: true, [`${PBIN}/uv`]: true });
    expect(() => planProvision(POSIX_SLOT, det(["uv"]), posixHost({ HOME: "/home/u" }), AUTO)).toThrow(/uv was not found on PATH/);
  });

  it("runs classic yarn's yarn.js found beside the yarn launcher through node", () => {
    virtual({ [SH]: true, [PNODE]: true, [`${PBIN}/yarn`]: true, [`${PBIN}/yarn.js`]: true });
    const [step] = planProvision(POSIX_SLOT, det(["yarn"]), posixHost(), AUTO);
    expect(step).toMatchObject({
      manager: "yarn", command: PNODE,
      args: [`${PBIN}/yarn.js`, "--cwd", POSIX_SLOT, "install", "--frozen-lockfile", "--non-interactive"],
    });
  });

  it("accepts an absolute override executable without an extension", () => {
    virtual({ [SH]: true, [`${PBIN}/setup-tool`]: true });
    const [step] = planProvision(POSIX_SLOT, det(["uv"]), posixHost(), { provision: { uv: [[`${PBIN}/setup-tool`, "go"]] }, python: "auto" });
    expect(step).toMatchObject({ command: `${PBIN}/setup-tool`, args: ["go"], label: "uv override 1" });
  });
});

describe("planProvision on a win32 host", () => {
  afterEach(() => { VIRTUAL.clear(); });

  it("takes an override's bare name that already ends in .exe as written", () => {
    virtual({ [CMD]: true, [`${WBIN}\\fetch-deps.exe`]: true });
    const [step] = planProvision(WIN_SLOT, det(["uv"]), winHost(), { provision: { uv: [["fetch-deps.exe", "--all"]] }, python: "auto" });
    expect(step).toMatchObject({ command: `${WBIN}\\fetch-deps.exe`, args: ["--all"], label: "uv override 1" });
  });
});

describe("managerLockPath fallbacks", () => {
  it("win32 falls back to USERPROFILE, then to the home directory", () => {
    expect(managerLockPath("npm", { USERPROFILE: "C:\\Users\\u" }, "win32")).toBe("C:\\Users\\u\\AppData\\Local\\omr-executor\\locks\\npm.lock");
    expect(managerLockPath("npm", {}, "win32")).toBe(win32.join(homedir(), "AppData", "Local", "omr-executor", "locks", "npm.lock"));
  });

  it("POSIX uses HOME, else the home directory", () => {
    expect(managerLockPath("pip", { HOME: "/home/u" }, "linux")).toBe("/home/u/.cache/omr-executor/locks/pip.lock");
    expect(managerLockPath("pip", {}, "linux")).toBe(posix.join(homedir(), ".cache", "omr-executor", "locks", "pip.lock"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// createProvisioner: freshen, lock edges and the uv cache probe
// ---------------------------------------------------------------------------------------------------------------

describe("createProvisioner edges", () => {
  const LOCK = "C:\\Users\\u\\AppData\\Local\\omr-executor\\locks\\uv.lock";
  const UV = `${WBIN}\\uv.exe`;
  const SYNC = `--project ${WIN_SLOT} sync --frozen`;

  afterEach(() => { VIRTUAL.clear(); });

  function provisioner(o: { fs?: MemFs; clock?: FakeClock; config?: Cfg } = {}) {
    const fs = o.fs ?? memFs();
    const clock = o.clock ?? fakeClock();
    const spawner = fakeSpawner();
    const prov = createProvisioner({ spawner, fs, clock, host: winHost(), config: o.config ?? AUTO });
    return { fs, clock, spawner, prov };
  }

  it("fresh removes only what a non-pruning install leaves behind; a manager without steps takes no lock", async () => {
    virtual({ [CMD]: true });
    const config: Cfg = { provision: { npm: [], pnpm: [], yarn: [], uv: [], poetry: [] }, python: "auto" };
    const classic = provisioner({ config });
    classic.fs.nodes.set(key(`${WIN_SLOT}\\node_modules`), "dir");
    classic.fs.nodes.set(key(`${WIN_SLOT}\\.venv`), "dir");
    await classic.prov.provision(WIN_SLOT, det(["npm", "pnpm", "uv", "yarn"]), { fresh: true });
    expect(classic.fs.removed.map(key)).toEqual([key(`${WIN_SLOT}\\node_modules`)]);
    expect(classic.spawner.calls).toEqual([]);
    expect([...classic.fs.nodes.keys()].filter(k => k.includes("omr-executor"))).toEqual([]);

    const berry = provisioner({ config });
    berry.fs.nodes.set(key(`${WIN_SLOT}\\node_modules`), "dir");
    berry.fs.nodes.set(key(`${WIN_SLOT}\\.venv`), "dir");
    await berry.prov.provision(WIN_SLOT, det(["poetry", "yarn"], { yarnBerry: true }), { fresh: true });
    expect(berry.fs.removed.map(key)).toEqual([key(`${WIN_SLOT}\\.venv`)]);
  });

  it("a heartbeat timer that still fires after the work finished writes nothing", async () => {
    virtual({ [CMD]: true, [UV]: true });
    const clock = fakeClock({ clearIgnored: true });
    const { fs, spawner, prov } = provisioner({ clock });
    await prov.provision(WIN_SLOT, det(["uv"]), { fresh: false });
    expect(spawner.calls.map(c => c.args.join(" "))).toEqual(["cache dir", SYNC]);
    expect(clock.pending()).toBe(1);
    clock.advance(10_000);
    await settle();
    expect(await fs.lstat(LOCK)).toBeNull();
    expect([...fs.nodes.keys()].filter(k => k.endsWith(".tmp"))).toEqual([]);
  });

  it("a lock that cannot be released for a non-Error reason is E_PROVISION naming the reason", async () => {
    virtual({ [CMD]: true, [UV]: true });
    const fs = memFs();
    const rm = fs.rm.bind(fs);
    fs.rm = async (p, o) => { if (key(p) === key(LOCK)) throw "device busy"; return rm(p, o); };
    const { prov } = provisioner({ fs });
    await expect(prov.provision(WIN_SLOT, det(["uv"]), { fresh: false })).rejects.toMatchObject({
      code: "E_PROVISION", message: expect.stringContaining(`could not release the uv install lock ${LOCK}: device busy`),
    });
  });

  it("a lock write that fails for another reason than EEXIST is rethrown and nothing runs", async () => {
    virtual({ [CMD]: true, [UV]: true });
    const fs = memFs();
    const write = fs.writeText.bind(fs);
    fs.writeText = async (p, data, o) => { if (key(p) === key(LOCK)) throw errno("EACCES", p); return write(p, data, o); };
    const { spawner, prov } = provisioner({ fs });
    await expect(prov.provision(WIN_SLOT, det(["uv"]), { fresh: false })).rejects.toMatchObject({ code: "EACCES" });
    expect(spawner.calls).toEqual([]);
  });

  it("a lock that is gone by the time it is read is retried at once", async () => {
    virtual({ [CMD]: true, [UV]: true });
    const fs = memFs();
    const write = fs.writeText.bind(fs);
    let phantom = true;
    fs.writeText = async (p, data, o) => {
      if (phantom && o?.exclusive === true && key(p) === key(LOCK)) { phantom = false; throw errno("EEXIST", p); }
      return write(p, data, o);
    };
    const { spawner, prov } = provisioner({ fs });
    await prov.provision(WIN_SLOT, det(["uv"]), { fresh: false });
    expect(phantom).toBe(false);
    expect(spawner.calls.map(c => c.args.join(" "))).toEqual(["cache dir", SYNC]);
    expect(await fs.lstat(LOCK)).toBeNull();
  });

  it.each([
    ["a number", "42"],
    ["null", "null"],
    ["a string pid", JSON.stringify({ pid: "1", hostname: "host-b", startedAt: 1, heartbeatAt: 1 })],
  ])("a lock body that is %s is damaged and taken over", async (_name, body) => {
    virtual({ [CMD]: true, [UV]: true });
    const { fs, clock, spawner, prov } = provisioner();
    fs.put(LOCK, body);
    const run = prov.provision(WIN_SLOT, det(["uv"]), { fresh: false });
    for (let i = 0; i < 20 && spawner.calls.length < 2; i += 1) {
      await settle();
      clock.advance(1_000);
    }
    await run;
    expect(spawner.calls.map(c => c.args.join(" "))).toEqual(["cache dir", SYNC]);
    expect([...fs.nodes.keys()].filter(k => k.endsWith(".stale"))).toEqual([]);
  });

  it.each([
    ["exits non-zero", { code: 1, stdout: "D:\\cache\\uv\n" }],
    ["prints nothing", { code: 0, stdout: "" }],
    ["cannot start", new Error("spawn EPERM")],
  ] as Array<[string, Partial<ProcessResult> | Error]>)("a uv cache probe that %s sets no UV_CACHE_DIR", async (_name, reply) => {
    virtual({ [CMD]: true, [UV]: true });
    const { spawner, prov } = provisioner();
    spawner.reply = (_command, args) => (args[0] === "cache" ? reply : undefined);
    await prov.provision(WIN_SLOT, det(["uv"]), { fresh: false });
    const sync = spawner.calls.find(c => c.args.includes("sync"));
    expect(sync?.command).toBe(UV);
    expect(Object.keys(sync?.opts.env ?? {})).not.toContain("UV_CACHE_DIR");
  });

  it("a uv cache on another drive moves UV_CACHE_DIR to the slot's drive", async () => {
    virtual({ [CMD]: true, [UV]: true });
    const { spawner, prov } = provisioner();
    spawner.reply = (_command, args) => (args[0] === "cache" ? { stdout: "D:\\cache\\uv\r\n" } : undefined);
    await prov.provision(WIN_SLOT, det(["uv"]), { fresh: false });
    const sync = spawner.calls.find(c => c.args.includes("sync"));
    expect(sync?.opts.env?.["UV_CACHE_DIR"]).toBe("C:\\.omr-cache\\uv");
  });
});
