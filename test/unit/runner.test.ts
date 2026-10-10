import { afterAll, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath as fsRealpath } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  detectRunner,
  effectiveWorkers,
  isNoAffected,
  isScopedSpec,
  isUnverifiable,
  planScopedRun,
  planStaticScoping,
  resolveEntry,
  REPORT_NAME_RE,
  CONFIG_SIZE_LIMIT,
  SETUP_REF_LIMIT,
  DEFAULT_PYTHON_FILES,
  SEARCH_LIMIT,
  STEM_MATCH_LIMIT,
  JS_TEST_GLOBS,
  PY_TEST_GLOBS,
  type ChangedPath,
  type DetectedRunner,
  type PlanScopedRunInput,
  type RunnerHost,
  type ScopedSpec,
  type TestSearchSeam,
  type Unverifiable,
} from "../../src/verify/runner";
import {
  isUnscoped,
  planRerun,
  planScopedLint,
  readResult,
  type LintSpec,
  type PlannerFs,
  type RunnerFs,
  type RunResult,
} from "../../src/verify/runner";
import type { FsSeam } from "../../src/verify/types";

// ---------------------------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------------------------

const UUID = "0123abcd-0000-4000-8000-00000000abcd";
const FIX = path.resolve(__dirname, "../fixtures/runner");

const POSIX_HOST: Partial<RunnerHost> = {
  platform: "linux",
  execPath: "/usr/bin/node",
  tmpdir: "/tmp",
  cores: 8,
  pathEnv: "",
  pytestAddopts: "",
  env: {},
  randomId: () => UUID,
};

const WIN_HOST: Partial<RunnerHost> = {
  ...POSIX_HOST,
  platform: "win32",
  execPath: "C:\\node\\node.exe",
  tmpdir: "C:\\Temp",
};

/** In-memory fs. `links` maps a directory prefix to its target, like a pnpm symlink. */
function memFs(files: Record<string, string>, win = false, links: Record<string, string> = {}, throwOn: string[] = []): FsSeam {
  const P = win ? path.win32 : path.posix;
  const k = (p: string) => (win ? p.toLowerCase() : p);
  const map = new Map(Object.entries(files).map(([p, c]) => [k(P.normalize(p)), c]));
  const follow = (p: string) => {
    let q = P.normalize(p);
    for (const [from, to] of Object.entries(links)) {
      if (k(q).startsWith(k(from) + P.sep)) q = to + q.slice(from.length);
    }
    return k(q);
  };
  return {
    fileExists: async (p) => map.has(follow(p)),
    readFile: async (p) => {
      const v = map.get(follow(p));
      if (v === undefined || throwOn.includes(p)) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

/** Real fs over the static fixtures, with a virtual `.git` at each given root (git cannot commit one). */
function fixtureFs(...roots: string[]): FsSeam {
  return {
    fileExists: async (p) => {
      if (path.basename(p) === ".git") return roots.some((r) => path.join(r, ".git") === p);
      return existsSync(p);
    },
    readFile: async (p) => readFileSync(p, "utf8"),
  };
}

const VITEST_PKG = JSON.stringify({ name: "vitest", version: "4.1.11", bin: { vitest: "./vitest.mjs" } });
const JEST_PKG = JSON.stringify({ name: "jest", version: "30.5.2", bin: "./bin/jest.js" });

function jsRepo(scripts: Record<string, string> = {}, extra: Record<string, string> = {}, root = "/r"): Record<string, string> {
  return {
    [`${root}/.git`]: "",
    [`${root}/package.json`]: JSON.stringify({ name: "app", scripts }),
    [`${root}/node_modules/vitest/package.json`]: VITEST_PKG,
    [`${root}/node_modules/vitest/vitest.mjs`]: "",
    [`${root}/node_modules/jest/package.json`]: JEST_PKG,
    [`${root}/node_modules/jest/bin/jest.js`]: "",
    ...extra,
  };
}

function pyRepo(extra: Record<string, string> = {}): Record<string, string> {
  return { "/r/.git": "", "/usr/bin/pytest": "", "/usr/bin/uv": "", ...extra };
}

function stubSearch(content: Record<string, readonly string[] | undefined> = {}, names: Record<string, readonly string[] | undefined> = {}): TestSearchSeam {
  return {
    findByContent: vi.fn(async (_root: string, needle: string) => (needle in content ? content[needle] : [])),
    findByName: vi.fn(async (_root: string, n: readonly string[]) => (n[0] in names ? names[n[0]] : [])),
  };
}

function input(over: Partial<PlanScopedRunInput> & { files?: Record<string, string>; win?: boolean }): PlanScopedRunInput {
  const { files, win, ...rest } = over;
  return {
    command: "vitest",
    cwd: "/r",
    changedFiles: [],
    budget: { maxWorkers: 2 },
    fs: memFs(files ?? jsRepo(), win),
    search: stubSearch(),
    host: win ? WIN_HOST : { ...POSIX_HOST, pathEnv: "/usr/bin" },
    ...rest,
  };
}

const changed = (...paths: string[]): ChangedPath[] => paths.map((p) => ({ path: p }));

function expectS6(x: object, code: string, reason?: string): void {
  expect(isUnverifiable(x)).toBe(true);
  const u = x as Unverifiable;
  expect(u.code).toBe(code);
  if (reason !== undefined) expect(u.reason).toBe(reason);
}

/** E2E-1: a changed pytest module that no test maps to is S6, never NoAffected (so: classified as a module). */
function expectUnmapped(x: object, rel: string): void {
  expectS6(x, "unmapped-module", `no test file maps to the changed module ${rel}`);
}

function spec(x: object): ScopedSpec {
  expect(isScopedSpec(x), JSON.stringify(x)).toBe(true);
  return x as ScopedSpec;
}

async function detect(command: string, files = jsRepo(), host = POSIX_HOST, cwd = "/r"): Promise<DetectedRunner> {
  const r = await detectRunner(command, cwd, memFs(files, host.platform === "win32"), host);
  expect(isUnverifiable(r), JSON.stringify(r)).toBe(false);
  return r as DetectedRunner;
}

async function detectS6(command: string, code: string, reason?: string, files = jsRepo()): Promise<void> {
  expectS6(await detectRunner(command, "/r", memFs(files), POSIX_HOST), code, reason);
}

// ---------------------------------------------------------------------------------------------
// B. Detection
// ---------------------------------------------------------------------------------------------

describe("detectRunner: direct forms", () => {
  it.each([
    ["vitest", "vitest", "direct"],
    ["npx vitest run", "vitest", "npx"],
    ["pnpm exec vitest", "vitest", "pnpm-exec"],
    ["jest", "jest", "direct"],
    ["npx jest", "jest", "npx"],
    ["pnpm exec jest --ci", "jest", "pnpm-exec"],
    ["pytest", "pytest", "direct"],
    ["uv run pytest -x", "pytest", "uv-run"],
  ])("%s", async (cmd, kind, launcher) => {
    const d = await detect(cmd);
    expect(d.kind).toBe(kind);
    expect(d.launcher).toBe(launcher);
    expect(d.source).toEqual({ type: "command" });
    expect(d.runnerCwd).toBe("/r");
    expect(d.gitRoot).toBe("/r");
  });

  it("uses the process defaults when no host is given", async () => {
    const root = path.join(FIX, "single");
    const d = await detectRunner("vitest", root, fixtureFs(root));
    expect(isUnverifiable(d)).toBe(false);
    expect((d as DetectedRunner).gitRoot).toBe(root);
  });

  it("no git root -> S6", async () => {
    expectS6(await detectRunner("vitest", "/r/a", memFs({}), POSIX_HOST), "no-git-root", "no git repository at or above /r/a");
  });
});

describe("detectRunner: package scripts", () => {
  const scripts = { test: "vitest run", lint: "jest" };
  it.each([
    ["npm test", "npm", "test"],
    ["npm t", "npm", "test"],
    ["npm run lint", "npm", "lint"],
    ["npm run-script lint", "npm", "lint"],
    ["pnpm test", "pnpm", "test"],
    ["pnpm t", "pnpm", "test"],
    ["pnpm run lint", "pnpm", "lint"],
    ["yarn test", "yarn", "test"],
    ["yarn run lint", "yarn", "lint"],
    ["bun run test", "bun", "test"],
  ])("%s -> scripts.%s", async (cmd, manager, name) => {
    const d = await detect(cmd, jsRepo(scripts));
    expect(d.source).toEqual({ type: "script", manager, name: name === "lint" ? "lint" : "test", packageJson: "/r/package.json" });
    expect(d.kind).toBe(name === "lint" ? "jest" : "vitest");
  });

  it("bun test is Bun's own runner -> S6 (O.1)", async () => {
    await detectS6("bun test", "bun-test", `"bun test" runs Bun's built-in test runner, not scripts.test (use "bun run test")`, jsRepo(scripts));
  });

  it("vitest run --coverage: coverage dropped with a note, and the pre hook noted", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm test", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.keptArgs).toEqual([]);
    expect(d.notes).toContain("coverage disabled for the scoped run");
    expect(d.notes).toContain("scripts.pretest is not run by the scoped command");
    expect(d.runnerCwd).toBe(root);
  });

  it("jest script with extra flags keeps them and records the cap", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm run unit", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.kind).toBe("jest");
    expect(d.keptArgs).toEqual(["--ci"]);
    expect(d.userWorkers).toEqual({ count: 4 });
  });

  it.each([
    ["npm run bad", "composite", 'composite scripts.bad: "&&"'],
    ["npm run seq", "composite", 'composite scripts.seq: ";"'],
    ["npm run dot", "unsupported-command", 'unsupported command "dotenv" in scripts.dot'],
    ["npm run xenvc", "composite", 'composite scripts.xenvc: "&&"'],
    ["npm run nested", "unsupported-command", 'unsupported command "npm" in scripts.nested'],
    ["npm run quote", "unterminated-quote", "unterminated quote in scripts.quote"],
  ])("fixture %s -> S6 naming the construct", async (cmd, code, reason) => {
    const root = path.join(FIX, "single");
    expectS6(await detectRunner(cmd, root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform }), code, reason);
  });

  it("cross-env X=1 Y=\"a b\" vitest run -> env", async () => {
    const root = path.join(FIX, "single");
    const d = (await detectRunner("npm run xenv", root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform })) as DetectedRunner;
    expect(d.env).toEqual({ X: "1", Y: "a b" });
    expect(d.kind).toBe("vitest");
  });

  it("missing, non-string, unparseable and absent package.json", async () => {
    const root = path.join(FIX, "single");
    const h = { ...POSIX_HOST, platform: process.platform };
    expectS6(await detectRunner("npm run num", root, fixtureFs(root), h), "no-script", `package.json has no string scripts.num: ${path.join(root, "package.json")}`);
    expectS6(await detectRunner("npm run nope", root, fixtureFs(root), h), "no-script");
    const broken = path.join(FIX, "broken-json");
    expectS6(await detectRunner("npm test", broken, fixtureFs(broken), h), "bad-package-json", `unreadable package.json: ${path.join(broken, "package.json")}`);
    await detectS6("npm test", "bad-package-json", undefined, { "/r/.git": "", "/r/package.json": "[]" });
    await detectS6("npm test", "no-script", undefined, { "/r/.git": "", "/r/package.json": "{}" });
    await detectS6("npm test", "no-package-json", "no package.json between /r and the git root", { "/r/.git": "" });
  });

  it("nearest package.json wins, walking up to the git root", async () => {
    const files = jsRepo({ test: "jest" }, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    const d = await detect("npm test", files, POSIX_HOST, "/r/pkg/src");
    expect(d.kind).toBe("vitest");
    expect(d.runnerCwd).toBe("/r/pkg");
  });

  it("npm: flags before -- are ignored with a note, args after -- are appended", async () => {
    const d = await detect("npm test --silent -- --bail 1 -t x", jsRepo({ test: "vitest" }));
    expect(d.keptArgs).toEqual(["-t", "x"]);
    expect(d.notes).toContain("npm options ignored: --silent");
    expect(d.notes).toContain("early-exit option dropped for a full failure inventory");
    const d2 = await detect("npm test --silent", jsRepo({ test: "vitest" }));
    expect(d2.keptArgs).toEqual([]);
  });

  it("pnpm/yarn/bun: tokens after the script name are appended minus a leading --", async () => {
    expect((await detect("pnpm test -- -t x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["-t", "x"]);
    expect((await detect("yarn test -t x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["-t", "x"]);
  });

  it("script env merges over command-level cross-env, and pnpm exec is allowed inside a script", async () => {
    const d = await detect("cross-env A=1 B=2 npm test", jsRepo({ test: "cross-env B=3 pnpm exec jest" }));
    expect(d.env).toEqual({ A: "1", B: "3" });
    expect(d.launcher).toBe("pnpm-exec");
  });

  it("package-manager heads other than exec inside a script -> unsupported", async () => {
    await detectS6("npm test", "unsupported-command", 'unsupported command "bun" in scripts.test', jsRepo({ test: "bun test" }));
    await detectS6("npm test", "unsupported-command", 'unsupported command "pnpm" in scripts.test', jsRepo({ test: "pnpm build" }));
  });
});

describe("detectRunner: C parsing", () => {
  it.each([
    ["vitest run && eslint .", "&&"],
    ["vitest || x", "||"],
    ["vitest | x", "|"],
    ["vitest & x", "&"],
    ["vitest > out", ">"],
    ["vitest < in", "<"],
    ["vitest `x`", "`"],
    ["vitest $(x)", "$("],
    ["vitest $HOME", "$"],
    ["vitest %FOO%", "%FOO%"],
    ["vitest\nx", "newline"],
    ["vitest\rx", "newline"],
    ["cross-env X=1 vitest run && eslint .", "&&"],
  ])("composite %j -> %s", async (cmd, construct) => {
    await detectS6(cmd, "composite", `composite command: "${construct}"`);
  });

  it("a bare 50% is not a composite construct", async () => {
    expect((await detect("vitest --maxWorkers=50%")).userWorkers).toEqual({ percent: 50 });
  });

  it("tokenizer: quotes, escapes, joins and literal backslashes", async () => {
    const d = await detect(`vitest -t "a \\"b\\" c" -t 'x y' a"b c"d --root C:\\x ""`);
    expect(d.keptArgs).toEqual(["-t", 'a "b" c', "-t", "x y", "--root", "C:\\x"]);
    expect(d.notes).toContain("vitest filters dropped: ab cd, ");
  });

  it.each([`vitest "run`, `vitest 'run`])("unterminated %s", async (cmd) => {
    await detectS6(cmd, "unterminated-quote", "unterminated quote in command");
  });

  it.each([
    ["dotenv -- vitest run", "dotenv"],
    ["npx -y vitest", "npx -y"],
    ["npx", "npx"],
    ["pnpm dlx vitest", "pnpm dlx"],
    ["pnpm exec mocha", "pnpm exec mocha"],
    ["pnpm exec", "pnpm exec"],
    ["uv run python -c x", "uv run python"],
    ["uv run", "uv run"],
    ["uv pip install", "uv pip"],
    ["uv", "uv"],
    ["uvx pytest", "uvx"],
    ["node --test", "node"],
    ["mocha", "mocha"],
    ["cross-env-shell vitest", "cross-env-shell"],
    ["cross-env X=1", "cross-env"],
    ["npm install", "npm install"],
    ["npm run", "npm run"],
    ["pnpm install", "pnpm install"],
    ["yarn", "yarn"],
    ["bun x", "bun x"],
    ["", ""],
  ])("unsupported %j -> %j", async (cmd, prefix) => {
    await detectS6(cmd, "unsupported-command", `unsupported command "${prefix}" in command`);
  });

  it("inline env without cross-env -> S6", async () => {
    await detectS6("CI=1 vitest", "inline-env", 'inline environment assignment "CI=" in command (only cross-env is supported)');
  });

  it("cross-env later assignment of the same name wins", async () => {
    expect((await detect("cross-env X=1 X=2 vitest")).env).toEqual({ X: "2" });
  });
});

// ---------------------------------------------------------------------------------------------
// D. User arguments
// ---------------------------------------------------------------------------------------------

describe("detectRunner: vitest arguments", () => {
  it("drops adapter-owned flags and keeps the rest in order", async () => {
    const d = await detect(
      "vitest run --reporter json --outputFile=x --coverage.reporter=text --coverage.all --changed HEAD --watch --config v.ts --browser --sequence.shuffle --globals --typecheck.enabled=true x",
    );
    expect(d.keptArgs).toEqual(["--config", "v.ts", "--browser", "--sequence.shuffle", "--globals", "--typecheck.enabled=true"]);
    expect(d.notes).toEqual(["coverage disabled for the scoped run", "vitest filters dropped: x"]);
  });

  it.each([
    ["vitest", undefined],
    ["vitest --maxWorkers 4", { count: 4 }],
    ["vitest --maxWorkers=1 --max-workers=8", { count: 8 }],
    ["vitest --maxWorkers=50%", { percent: 50 }],
    ["vitest --no-file-parallelism", { count: 1 }],
    ["vitest --fileParallelism=false", { count: 1 }],
  ])("%s -> cap %j", async (cmd, cap) => {
    expect((await detect(cmd)).userWorkers).toEqual(cap);
  });

  it("no-file-parallelism is kept; cap tokens are removed", async () => {
    expect((await detect("vitest --no-file-parallelism --maxWorkers=3")).keptArgs).toEqual(["--no-file-parallelism"]);
  });

  it.each(["abc", "0", "1.5", "-1", "0%", "150%", "99999999999999999999"])("invalid cap %s is ignored with a note", async (v) => {
    const d = await detect(`vitest --maxWorkers=${v}`);
    expect(d.userWorkers).toBeUndefined();
    expect(d.notes).toContain(`invalid worker cap "${v}" ignored`);
  });

  it("a cap with no value is invalid", async () => {
    expect((await detect("vitest --maxWorkers")).notes).toContain('invalid worker cap "" ignored');
  });

  it("-- is unsupported", async () => {
    await detectS6("vitest run -- a", "unsupported-argument", 'unsupported vitest argument "--" in command');
  });

  it.each(["bench", "list", "init", "typecheck"])("subcommand %s -> S6", async (sub) => {
    await detectS6(`vitest ${sub}`, "unsupported-subcommand", `unsupported vitest subcommand "${sub}" in command`);
  });

  it("only the first positional is a subcommand", async () => {
    expect((await detect("vitest run related")).notes).toContain("vitest filters dropped: related");
  });

  it.each(["--foo=1", "--bar", "--foo bar", "-z"])("unknown option %s fails closed (QA-1.3-10)", async (a) => {
    await detectS6(`vitest ${a}`, "unsupported-argument", `unsupported vitest argument "${a.split(" ")[0]}" in command`);
  });
});

describe("detectRunner: jest arguments", () => {
  it("drops, caps and keeps per D.3", async () => {
    const d = await detect("jest --json --reporters default summary --ci --outputFile o.json --bail --testPathPatterns a b -e --coverage x");
    expect(d.keptArgs).toEqual(["--ci", "--testPathPatterns", "a", "b", "-e"]);
    expect(d.notes).toEqual(["early-exit option dropped for a full failure inventory", "coverage disabled for the scoped run", "jest filters dropped: x"]);
  });

  it.each([
    ["jest -w4", { count: 4 }],
    ["jest -w 3", { count: 3 }],
    ["jest --maxWorkers=25%", { percent: 25 }],
    ["jest -i", { count: 1 }],
    ["jest --runInBand", { count: 1 }],
  ])("%s -> cap %j", async (cmd, cap) => {
    const d = await detect(cmd);
    expect(d.userWorkers).toEqual(cap);
    expect(d.keptArgs).toEqual([]);
  });

  it("--showConfig -> S6", async () => {
    await detectS6("jest --showConfig", "unsupported-argument", 'unsupported jest argument "--showConfig" in command');
  });

  it("-c=value is kept; -cvalue is S6 because yargs reads it as grouped flags (QA-1.3-10)", async () => {
    expect((await detect("jest -c=jest.config.js")).keptArgs).toEqual(["-c=jest.config.js"]);
    await detectS6("jest -cjest.config.js", "unsupported-argument", 'unsupported jest argument "-cjest.config.js" in command');
  });
});

describe("detectRunner: pytest arguments and xdist evidence", () => {
  it("drops the adapter's own flags, keeps the rest", async () => {
    const d = await detect("pytest -q -p no:cacheprovider -pno:cacheprovider -p myplugin -rA --cov src --junitxml=j.xml -x -k slow", pyRepo());
    expect(d.keptArgs).toEqual(["-p", "myplugin", "-rA", "-k", "slow"]);
    expect(d.xdist).toBe(false);
    expect(d.covInConfig).toBe(false);
  });

  it("-p with no value is kept as a flag", async () => {
    expect((await detect("pytest -p", pyRepo())).keptArgs).toEqual(["-p"]);
  });

  it.each([
    ["pytest -n4", { count: 4 }, true],
    ["pytest -n auto", { auto: true }, true],
    ["pytest --numprocesses=logical", { auto: true }, true],
    ["pytest -n 0", { count: 0 }, true],
    ["pytest --dist loadfile", undefined, true],
    ["pytest -n 2 -p no:xdist", { count: 2 }, false],
    ["pytest -pno:xdist -n 2", { count: 2 }, false],
  ])("%s -> cap %j, xdist %s", async (cmd, cap, xdist) => {
    const d = await detect(cmd, pyRepo());
    expect(d.userWorkers).toEqual(cap);
    expect(d.xdist).toBe(xdist);
  });

  it("a percent cap is invalid for pytest", async () => {
    expect((await detect("pytest -n 50%", pyRepo())).notes).toContain('invalid worker cap "50%" ignored');
  });

  it("positionals become absolute path scopes", async () => {
    expect((await detect("pytest tests/unit", pyRepo())).pathScopes).toEqual(["/r/tests/unit"]);
  });

  it.each(["tests/x.py::test_a", "tests/*.py", "../out"])("path scope %s -> S6", async (p) => {
    await detectS6(`pytest ${p}`, "unsupported-argument", `unsupported pytest argument "${p}" in command`, pyRepo());
  });

  it.each(["--co", "--collect-only", "--version", "-h"])("%s -> S6", async (f) => {
    await detectS6(`pytest ${f}`, "unsupported-argument", undefined, pyRepo());
  });

  it("config addopts supply xdist, cov and the cap from the nearest config dir", async () => {
    const files = pyRepo({
      "/r/pyproject.toml": '[tool.pytest.ini_options]\naddopts = ["-n", "auto", "--cov=pkg"]\n',
      "/r/sub/pytest.ini": "[pytest]\naddopts = -n 1\n",
    });
    const root = await detect("pytest", files);
    expect(root).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { auto: true } });
    const sub = await detect("pytest", files, POSIX_HOST, "/r/sub");
    expect(sub).toMatchObject({ xdist: true, covInConfig: false, userWorkers: { count: 1 } });
  });

  it("a command cap wins over the config value", async () => {
    const d = await detect("pytest -n 3", pyRepo({ "/r/setup.cfg": "[tool:pytest]\naddopts = -n 1" }));
    expect(d.userWorkers).toEqual({ count: 3 });
  });

  it("PYTEST_ADDOPTS is evidence too", async () => {
    const d = await detect("pytest", pyRepo(), { ...POSIX_HOST, pytestAddopts: "-n 6 --cov" });
    expect(d).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 6 } });
  });

  it("an unreadable config file is noted, not fatal", async () => {
    const files = pyRepo({ "/r/tox.ini": "x" });
    const r = (await detectRunner("pytest", "/r", memFs(files, false, {}, ["/r/tox.ini"]), POSIX_HOST)) as DetectedRunner;
    expect(r.notes).toContain("unreadable pytest config ignored: /r/tox.ini");
    expect(r.xdist).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// E. Worker cap
// ---------------------------------------------------------------------------------------------

describe("effectiveWorkers (section 1.5-11)", () => {
  const B = { maxWorkers: 2 };
  it("follows the section E table", () => {
    expect(effectiveWorkers(undefined, B, 8)).toBe(2);
    expect(effectiveWorkers({ count: 1 }, B, 8)).toBe(1);
    expect(effectiveWorkers({ count: 8 }, B, 8)).toBe(2);
    expect(effectiveWorkers({ count: 0 }, B, 8)).toBe(0);
    expect(effectiveWorkers({ percent: 50 }, B, 16)).toBe(2);
    expect(effectiveWorkers({ percent: 50 }, B, 1)).toBe(1);
    expect(effectiveWorkers({ percent: 1 }, { maxWorkers: 8 }, 16)).toBe(1);
    expect(effectiveWorkers({ auto: true }, B, 1)).toBe(1);
    expect(effectiveWorkers({ auto: true }, B, 16)).toBe(2);
  });

  it("invalid budget, cores and caps fall back safely", () => {
    expect(effectiveWorkers(undefined, { maxWorkers: 0 }, 8)).toBe(1);
    expect(effectiveWorkers(undefined, { maxWorkers: 1.5 }, 8)).toBe(1);
    expect(effectiveWorkers({ auto: true }, { maxWorkers: 4 }, Number.NaN)).toBe(1);
    expect(effectiveWorkers({ count: -1 }, B, 8)).toBe(2);
    expect(effectiveWorkers({ percent: 150 }, B, 8)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// F. Entry resolution
// ---------------------------------------------------------------------------------------------

describe("resolveEntry", () => {
  const req = (kind: "vitest" | "jest" | "pytest" | "eslint", launcher: "direct" | "uv-run" = "direct", gitRoot = "/r") => ({ kind, launcher, gitRoot });

  it("vitest object bin and jest string bin from static fixtures", async () => {
    const root = path.join(FIX, "single");
    const h = { ...POSIX_HOST, platform: process.platform };
    expect(await resolveEntry({ kind: "vitest", launcher: "npx", gitRoot: root }, root, fixtureFs(root), h)).toEqual({
      file: "/usr/bin/node",
      prefix: [path.join(root, "node_modules", "vitest", "vitest.mjs")],
      entry: path.join(root, "node_modules", "vitest", "vitest.mjs"),
      version: "4.1.11",
    });
    const j = await resolveEntry({ kind: "jest", launcher: "direct", gitRoot: root }, root, fixtureFs(root), h);
    expect(j).toMatchObject({ entry: path.join(root, "node_modules", "jest", "bin", "jest.js"), version: "30.5.2" });
  });

  it("monorepo: hoisted runner found at the root from a package cwd", async () => {
    const root = path.join(FIX, "monorepo");
    const app = path.join(root, "packages", "app");
    const e = await resolveEntry({ kind: "vitest", launcher: "direct", gitRoot: root }, app, fixtureFs(root), { ...POSIX_HOST, platform: process.platform });
    expect(e).toMatchObject({ entry: path.join(root, "node_modules", "vitest", "vitest.mjs") });
  });

  it("pnpm .pnpm store layout: the lexical symlink path goes into argv", async () => {
    const store = "/r/node_modules/.pnpm/vitest@4.1.11/node_modules/vitest";
    const fs = memFs({ "/r/.git": "", [`${store}/package.json`]: VITEST_PKG, [`${store}/vitest.mjs`]: "" }, false, { "/r/node_modules/vitest": store });
    expect(await resolveEntry(req("vitest"), "/r", fs, POSIX_HOST)).toMatchObject({ entry: "/r/node_modules/vitest/vitest.mjs" });
  });

  it("runner missing -> runner not installed; yarn pnp named", async () => {
    const root = path.join(FIX, "no-runner");
    expectS6(
      await resolveEntry({ kind: "jest", launcher: "direct", gitRoot: root }, root, fixtureFs(root), { ...POSIX_HOST, platform: process.platform }),
      "runner-not-installed",
      "runner not installed: jest",
    );
    expectS6(await resolveEntry(req("eslint"), "/r", memFs({ "/r/.pnp.cjs": "" }), POSIX_HOST), "yarn-pnp", "yarn Plug'n'Play has no node_modules to resolve eslint from");
    expectS6(await resolveEntry(req("vitest"), "/elsewhere", memFs({ "/elsewhere/node_modules/vitest/package.json": VITEST_PKG }), POSIX_HOST), "runner-not-installed");
  });

  it.each([
    ["{", "unreadable package.json /r/node_modules/vitest/package.json"],
    [JSON.stringify({ name: "evil", bin: "./v.js" }), 'package name is not "vitest"'],
    [JSON.stringify({ name: "vitest" }), "no bin entry"],
    [JSON.stringify({ name: "vitest", bin: { other: "./v.js" } }), "no bin entry"],
    [JSON.stringify({ name: "vitest", bin: "../../evil.js" }), "bin escapes the package directory"],
    [JSON.stringify({ name: "vitest", bin: "." }), "bin escapes the package directory"],
    [JSON.stringify({ name: "vitest", bin: "./v.sh" }), "bin is not a .js, .mjs or .cjs file"],
    [JSON.stringify({ name: "vitest", bin: "./missing.cjs" }), "bin entry missing: /r/node_modules/vitest/missing.cjs"],
  ])("bad bin %s", async (pj, detail) => {
    const fs = memFs({ "/r/node_modules/vitest/package.json": pj });
    expectS6(await resolveEntry(req("vitest"), "/r", fs, POSIX_HOST), "bad-bin", `invalid bin for vitest: ${detail}`);
  });

  it("no version field is fine", async () => {
    const fs = memFs({ "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", bin: { eslint: "bin/eslint.js" } }), "/r/node_modules/eslint/bin/eslint.js": "" });
    const e = await resolveEntry(req("eslint"), "/r", fs, POSIX_HOST);
    expect(e).toEqual({ file: "/usr/bin/node", prefix: ["/r/node_modules/eslint/bin/eslint.js"], entry: "/r/node_modules/eslint/bin/eslint.js" });
  });

  it("pytest: first absolute PATH hit, relative entries skipped", async () => {
    const fs = memFs({ "/cwd-rel/pytest": "", "/opt/py/bin/pytest": "", "/usr/bin/pytest": "" });
    const e = await resolveEntry(req("pytest"), "/r", fs, { ...POSIX_HOST, pathEnv: ".:bin::/opt/py/bin:/usr/bin" });
    expect(e).toEqual({ file: "/opt/py/bin/pytest", prefix: [], entry: "/opt/py/bin/pytest" });
  });

  it("pytest on win32 uses pytest.exe and the ; delimiter", async () => {
    const fs = memFs({ "C:\\py\\Scripts\\pytest.exe": "" }, true);
    const e = await resolveEntry(req("pytest", "direct", "C:\\repo"), "C:\\repo", fs, { ...WIN_HOST, pathEnv: "C:\\nope;C:\\py\\Scripts" });
    expect(e).toMatchObject({ file: "C:\\py\\Scripts\\pytest.exe" });
  });

  it("pytest venv fallback and missing", async () => {
    const fs = memFs({ "/r/.venv/bin/pytest": "" });
    const r = await resolveEntry(req("pytest"), "/r/sub", fs, POSIX_HOST);
    expect(r).toMatchObject({ file: "/r/.venv/bin/pytest" });
    const win = await resolveEntry(req("pytest", "direct", "C:\\r"), "C:\\r", memFs({ "C:\\r\\.venv\\Scripts\\pytest.exe": "" }, true), WIN_HOST);
    expect(win).toMatchObject({ file: "C:\\r\\.venv\\Scripts\\pytest.exe" });
    expectS6(await resolveEntry(req("pytest"), "/r", memFs({}), POSIX_HOST), "runner-not-installed", "runner not installed: pytest");
  });

  it("uv: PATH only", async () => {
    const e = await resolveEntry(req("pytest", "uv-run"), "/r", memFs({ "/usr/bin/uv": "" }), { ...POSIX_HOST, pathEnv: "/usr/bin" });
    expect(e).toEqual({ file: "/usr/bin/uv", prefix: ["run", "pytest"], entry: "/usr/bin/uv" });
    expectS6(await resolveEntry(req("pytest", "uv-run"), "/r", memFs({ "/r/.venv/bin/pytest": "" }), POSIX_HOST), "runner-not-installed", "runner not installed: uv");
  });
});

// ---------------------------------------------------------------------------------------------
// G + H. planScopedRun
// ---------------------------------------------------------------------------------------------

const vitestArgs = (files: string[], n = 2) => [
  "/r/node_modules/vitest/vitest.mjs", "related", ...files, "--run", "--passWithNoTests", `--maxWorkers=${n}`,
  "--coverage.enabled=false", "--reporter=json", `--outputFile=/tmp/omr-verify-${UUID}.json`,
];

describe("planScopedRun: empty and unavailable", () => {
  it("unavailable -> S6; [] -> NoAffected", async () => {
    expectS6(await planScopedRun(input({ changedFiles: "unavailable" })), "attribution-unavailable", "change attribution unavailable");
    expect(await planScopedRun(input({ changedFiles: [] }))).toEqual({ noAffected: true, note: "no changed files, no affected tests" });
  });

  it("detection failures pass through", async () => {
    expectS6(await planScopedRun(input({ command: "vitest && x", changedFiles: changed("a.ts") })), "composite");
  });
});

describe("planScopedRun: vitest", () => {
  const src = { "/r/src/a.ts": "", "/r/src/b.ts": "" };

  it("builds the H argv with absolute sorted inputs, never a --", async () => {
    const s = spec(await planScopedRun(input({ files: jsRepo({}, src), changedFiles: changed("src/b.ts", "/r/src/a.ts", "src/a.ts") })));
    expect(s.file).toBe("/usr/bin/node");
    expect(s.args).toEqual(vitestArgs(["/r/src/a.ts", "/r/src/b.ts"]));
    expect(s.args).not.toContain("--");
    expect(s).toMatchObject({ runner: "vitest", mode: "related", cwd: "/r", env: {}, gitRoot: "/r", entry: "/r/node_modules/vitest/vitest.mjs", inputsAreTests: false, workers: 2 });
    expect(s.reportPath).toBe(`/tmp/omr-verify-${UUID}.json`);
    expect(REPORT_NAME_RE.test(path.posix.basename(s.reportPath))).toBe(true);
  });

  it.each([
    ["vitest", undefined, 2],
    ["vitest --maxWorkers=1", undefined, 1],
    ["vitest --maxWorkers=8", undefined, 2],
    ["vitest --maxWorkers 4", undefined, 2],
    ["vitest --maxWorkers=abc", undefined, 2],
    ["vitest --maxWorkers=50%", 1, 1],
    ["vitest --maxWorkers=50%", 16, 2],
  ])("%s (cores %s) -> exactly one --maxWorkers=%i", async (command, cores, n) => {
    const s = spec(await planScopedRun(input({ command, cores, files: jsRepo({}, src), changedFiles: changed("src/a.ts") })));
    const caps = s.args.filter((a) => a.startsWith("--maxWorkers") || a.startsWith("--max-workers"));
    expect(caps).toEqual([`--maxWorkers=${n}`]);
    expect(s.workers).toBe(n);
  });

  it("cross-env env reaches the spec", async () => {
    const s = spec(await planScopedRun(input({ command: 'cross-env X=1 Y="a b" vitest run', files: jsRepo({}, src), changedFiles: changed("src/a.ts") })));
    expect(s.env).toEqual({ X: "1", Y: "a b" });
  });

  it("monorepo fixture: script in a package, runner hoisted to the root", async () => {
    const root = path.join(FIX, "monorepo");
    const app = path.join(root, "packages", "app");
    const s = spec(
      await planScopedRun({
        command: "npm test",
        cwd: app,
        changedFiles: changed("src/math.ts"),
        budget: { maxWorkers: 2 },
        fs: fixtureFs(root),
        search: stubSearch(),
        host: { ...POSIX_HOST, platform: process.platform, tmpdir: tmpdir() },
      }),
    );
    expect(s.cwd).toBe(app);
    expect(s.entry).toBe(path.join(root, "node_modules", "vitest", "vitest.mjs"));
    expect(s.inputs).toEqual([path.join(app, "src", "math.ts")]);
    expect(s.args.filter((a) => a.startsWith("--maxWorkers"))).toEqual(["--maxWorkers=2"]);
    expect(path.dirname(s.reportPath)).toBe(path.resolve(tmpdir()));
  });

  it("runner missing -> S6 runner not installed", async () => {
    const files = { "/r/.git": "", "/r/package.json": "{}", "/r/src/a.ts": "" };
    expectS6(await planScopedRun(input({ files, changedFiles: changed("src/a.ts") })), "runner-not-installed", "runner not installed: vitest");
  });

  it("docs-only change needs no runner at all", async () => {
    const files = { "/r/.git": "", "/r/README.md": "", "/r/LICENSE": "", "/r/.github/workflows/ci.yml": "" };
    expect(await planScopedRun(input({ files, changedFiles: changed("README.md", "LICENSE", ".github/workflows/ci.yml") }))).toEqual({
      noAffected: true,
      note: "no affected tests: no changed file is a test input",
    });
  });
});

describe("planScopedRun: changed-file normalization", () => {
  it("drops files outside the git root and .. traversal leaving it; keeps inside-root .. normalized", async () => {
    const files = jsRepo({}, { "/r/packages/b/x.ts": "" });
    const s = spec(
      await planScopedRun(input({ cwd: "/r", files, changedFiles: changed("/other/x.ts", "src/../../x.ts", "packages/a/../b/x.ts", ".", "bad\0.ts") })),
    );
    expect(s.inputs).toEqual(["/r/packages/b/x.ts"]);
    expect(s.notes).toEqual(expect.arrayContaining([
      "dropped outside the git root: /other/x.ts",
      "dropped outside the git root: src/../../x.ts",
      "dropped outside the git root: .",
      "dropped a path containing a NUL byte",
    ]));
  });

  it("everything dropped -> S6 attribution-unavailable, never NoAffected (QA-1.3-7)", async () => {
    expectS6(
      await planScopedRun(input({ changedFiles: changed("../x.ts", "bad\0.ts") })),
      "attribution-unavailable",
      "change attribution unavailable: no changed path lies inside the git root",
    );
  });

  it("win32: drive-letter case, separators and other drives", async () => {
    const files = {
      "C:\\repo\\.git": "",
      "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
      "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
      "C:\\repo\\src\\a.ts": "",
    };
    const s = spec(
      await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed("c:\\repo\\src\\a.ts", "src/a.ts", "C:\\REPO\\SRC\\A.TS", "D:\\repo\\src\\a.ts") })),
    );
    expect(s.inputs).toEqual(["C:\\repo\\src\\a.ts"]);
    expect(s.file).toBe("C:\\node\\node.exe");
    expect(s.reportPath).toBe(`C:\\Temp\\omr-verify-${UUID}.json`);
    expect(s.notes).toContain("dropped outside the git root: D:\\repo\\src\\a.ts");
  });

  it("spaces and unicode stay one argv element each", async () => {
    const f = "/r/src/my file ü 日本.ts";
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { [f]: "" }), changedFiles: changed("src/my file ü 日本.ts") })));
    expect(s.args).toContain(f);
  });

  it("security: hostile names never become flags or shell text", async () => {
    const names = ["--config=evil.js", "a&b.ts", "$(rm -rf).ts", `q"u'o.ts`, "-n"];
    const extra = Object.fromEntries(names.map((n) => [`/r/${n}`, ""]));
    const v = spec(await planScopedRun(input({ files: jsRepo({}, extra), changedFiles: changed(...names) })));
    for (const n of names) expect(v.args).toContain(`/r/${n}`);
    for (const n of names) expect(v.args).not.toContain(n);
    expect(v.args).not.toContain("--");
    expect(v.inputs.every((i) => i.startsWith("/r/"))).toBe(true);

    const j = spec(await planScopedRun(input({ command: "jest", files: jsRepo({}, extra), changedFiles: changed(...names) })));
    const dd = j.args.indexOf("--");
    expect(dd).toBeGreaterThan(0);
    expect(j.args.slice(dd + 1)).toEqual(j.inputs);
  });
});

describe("planScopedRun: deletions, renames, config triggers", () => {
  it("deleted source with stem-matching tests runs those tests", async () => {
    const search = stubSearch({ math: ["/r/test/math.test.ts", "/r/test/gone.test.ts", "/outside/x.test.ts"] });
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { "/r/test/math.test.ts": "" }), changedFiles: changed("src/math.ts"), search })));
    expect(s.inputs).toEqual(["/r/test/math.test.ts"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "math", JS_TEST_GLOBS);
  });

  it("index and __init__ use the parent directory name", async () => {
    const search = stubSearch({ util: ["/r/t/util.test.ts"] });
    const s = spec(await planScopedRun(input({ files: jsRepo({}, { "/r/t/util.test.ts": "" }), changedFiles: changed("src/util/index.ts"), search })));
    expect(s.inputs).toEqual(["/r/t/util.test.ts"]);
  });

  it("deleted source with none -> S6; search failure; too common", async () => {
    expectS6(await planScopedRun(input({ changedFiles: changed("src/math.ts") })), "deleted-no-tests", 'deleted source src/math.ts: no test file references "math"');
    expectS6(await planScopedRun(input({ changedFiles: changed("src/math.ts"), search: stubSearch({ math: undefined }) })), "search-failed", "test search failed for src/math.ts");
    const many = Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => `/r/t/${i}.test.ts`);
    expectS6(
      await planScopedRun(input({ changedFiles: changed("src/math.ts"), search: stubSearch({ math: many }) })),
      "stem-too-common",
      'deleted source src/math.ts: "math" appears in 21 test files (limit 20)',
    );
  });

  it("deleted test file -> note only", async () => {
    expect(await planScopedRun(input({ changedFiles: changed("test/a.test.ts", "src/__tests__/b.ts") }))).toEqual({
      noAffected: true,
      note: "no affected tests: no changed file is a test input",
    });
  });

  it("rename: the destination is an input, the source goes through the stem search", async () => {
    const search = stubSearch({ old: ["/r/t/old.test.ts"] });
    const s = spec(
      await planScopedRun(input({ files: jsRepo({}, { "/r/src/new.ts": "", "/r/t/old.test.ts": "" }), changedFiles: [{ path: "src/new.ts", previousPath: "src/old.ts" }], search })),
    );
    expect(s.inputs).toEqual(["/r/src/new.ts", "/r/t/old.test.ts"]);
  });

  it.each([
    ["vitest", "vitest.config.ts"],
    ["vitest", "packages/a/vite.config.mjs"],
    ["vitest", "tsconfig.build.json"],
    ["vitest", "packages/a/package.json"],
    ["jest", "babel.config.js"],
    ["jest", ".babelrc"],
    ["jest", "jest.config.ts"],
  ])("%s: %s -> config-changed", async (command, f) => {
    expectS6(await planScopedRun(input({ command, changedFiles: changed("src/a.ts", f) })), "config-changed", `config file changed: ${f}`);
  });

  it("the package.json that supplied the script is a trigger even when deleted", async () => {
    const files = jsRepo({}, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }) });
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files, changedFiles: changed("package.json") })), "config-changed", "config file changed: pkg/package.json");
  });

  it("win32 trigger names match case-insensitively", async () => {
    const files = { "C:\\repo\\.git": "" };
    expectS6(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed("Vitest.Config.ts") })), "config-changed", "config file changed: Vitest.Config.ts");
  });
});

describe("planScopedRun: jest", () => {
  it("argv: kept args, then adapter flags, then -- and files", async () => {
    const s = spec(await planScopedRun(input({ command: "npx jest --ci -w 8", files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts") })));
    expect(s.args).toEqual([
      "/r/node_modules/jest/bin/jest.js", "--ci", "--findRelatedTests", "--passWithNoTests", "--maxWorkers=2", "--coverage=false", "--json",
      `--outputFile=/tmp/omr-verify-${UUID}.json`, "--", "/r/src/a.ts",
    ]);
    expect(s.workers).toBe(2);
  });
});

describe("planScopedRun: pytest", () => {
  const mods = { "/r/src/pkg/mod.py": "", "/r/tests/test_mod.py": "", "/r/tests/pkg/mod_test.py": "" };
  const nameSearch = () => stubSearch({}, { "test_mod.py": ["/r/tests/test_mod.py", "/r/tests/pkg/mod_test.py"] });

  it("src/pkg/mod.py -> tests/test_mod.py and tests/pkg/mod_test.py", async () => {
    const search = nameSearch();
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py"), search })));
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_mod.py", "mod_test.py"]);
    expect(s.inputs).toEqual(["/r/tests/pkg/mod_test.py", "/r/tests/test_mod.py"]);
    expect(s.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "--maxfail=0", "--rootdir=/r", "--", "/r/tests/pkg/mod_test.py", "/r/tests/test_mod.py"]);
    expect(s).toMatchObject({ file: "/usr/bin/pytest", inputsAreTests: true, workers: null, env: { PYTEST_XDIST_AUTO_NUM_WORKERS: "2" } });
  });

  it("xdist, cov in config and uv run", async () => {
    const files = pyRepo({ ...mods, "/r/pytest.ini": "[pytest]\naddopts = -n auto --cov" });
    const s = spec(await planScopedRun(input({ command: "uv run pytest -x", files, changedFiles: changed("tests/test_mod.py") })));
    expect(s.file).toBe("/usr/bin/uv");
    expect(s.args).toEqual(["run", "pytest", "-q", "-p", "no:cacheprovider", `--junitxml=/tmp/omr-verify-${UUID}.xml`, "--maxfail=0", "-c", "/r/pytest.ini", "--rootdir=/r", "-n", "2", "--no-cov", "--", "/r/tests/test_mod.py"]);
    expect(s.workers).toBe(2);
  });

  it("-n 0 stays 0 and the auto env uses min(cores, budget)", async () => {
    const s = spec(await planScopedRun(input({ command: "pytest -n 0", cores: 1, files: pyRepo(mods), changedFiles: changed("tests/test_mod.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "0"]);
    expect(s.env.PYTEST_XDIST_AUTO_NUM_WORKERS).toBe("1");
  });

  it("conftest.py changed -> S6", async () => {
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/conftest.py") })), "config-changed", "config file changed: tests/conftest.py");
  });

  it("E2E-1: a module no test maps to -> S6 unmapped-module, never NoAffected; non-py skipped", async () => {
    const search = stubSearch();
    const r = await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py", "data.json"), search }));
    expectUnmapped(r, "src/pkg/mod.py");
    // QA-G-10: the module's name as a whole word, over the test files and conftest.py.
    expect(search.findByContent).toHaveBeenCalledWith("/r", "mod", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"], { word: true });
    // A data file alone is not a module: nothing to map.
    expect(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("data.json") }))).toEqual({
      noAffected: true,
      note: "no affected tests: no changed file is a test input",
    });
  });

  it("name or content search failure -> S6", async () => {
    const search = stubSearch({}, { "test_mod.py": undefined });
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py"), search })), "search-failed");
    const content = stubSearch({ mod: undefined }, { "test_mod.py": ["/r/tests/test_mod.py"] });
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(mods), changedFiles: changed("src/pkg/mod.py"), search: content })), "search-failed", "test search failed for src/pkg/mod.py");
    expect(content.findByName).not.toHaveBeenCalled();
  });

  it("path scopes and runnerCwd filter test inputs", async () => {
    const files = pyRepo({ ...mods, "/r/other/test_x.py": "" });
    const r = await planScopedRun(input({ command: "pytest tests/unit", files, changedFiles: changed("tests/test_mod.py", "other/test_x.py") }));
    expect(r).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
  });

  it("deleted module: content and name hits; none -> S6; failures; too common", async () => {
    const files = pyRepo({ "/r/tests/test_mod.py": "", "/r/tests/test_use.py": "" });
    const ok = spec(
      await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: ["/r/tests/test_use.py"] }, { "test_mod.py": ["/r/tests/test_mod.py"] }) })),
    );
    expect(ok.inputs).toEqual(["/r/tests/test_mod.py", "/r/tests/test_use.py"]);
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py") })), "deleted-no-tests");
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: undefined }) })), "search-failed");
    const many = Array.from({ length: 21 }, (_, i) => `/r/tests/test_${i}.py`);
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: stubSearch({ mod: many }) })), "stem-too-common");
    const s = stubSearch({ mod: ["/r/tests/test_use.py"] });
    await planScopedRun(input({ command: "pytest", files, changedFiles: changed("src/mod.py"), search: s }));
    expect(s.findByContent).toHaveBeenCalledWith("/r", "mod", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"]);
  });

  it("deleted test file -> note", async () => {
    const r = await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_gone.py") }));
    expect(r).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
  });
});

/**
 * A git-like TestSearchSeam over an in-memory tree, as the wiring runs it (git ls-files by basename;
 * git grep -F, -w with options.word, over ":(glob)**<slash><basename pattern>" pathspecs).
 */
function treeSearch(files: Record<string, string>, root = "/r"): TestSearchSeam {
  const under = Object.keys(files).filter((p) => p.startsWith(`${root}/`) && p !== `${root}/.git`);
  const glob = (g: string) => {
    const pat = g.replace(/^:\(glob\)\*\*\//, "").replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
    const re = new RegExp(`^${pat}$`);
    return (p: string) => re.test(path.posix.basename(p));
  };
  return {
    findByName: vi.fn(async (_r: string, names: readonly string[]) => under.filter((p) => names.includes(path.posix.basename(p)))),
    // options.regex: the QA-G-2 seam's git grep -E, kept so these tests replay the pre-QA-G-10 planner faithfully.
    findByContent: vi.fn(async (_r: string, needle: string, globs: readonly string[], options?: { readonly word?: boolean; readonly regex?: boolean }) => {
      const esc = options?.regex === true ? needle : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = options?.word === true ? new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`) : new RegExp(esc);
      const match = globs.map(glob);
      // git grep matches one line at a time.
      return under.filter((p) => match.some((m) => m(p)) && files[p].split("\n").some((line) => re.test(line)));
    }),
  };
}

/** A bound for a hang, not a performance assertion: real git spawns are slow under Windows load and v8 coverage (issue #88). */
const REAL_GIT_TIMEOUT_MS = 60_000;

/**
 * QA-G-10: runs `fn` with a TestSearchSeam over a real git repository holding the /r files of
 * `files`, with the wiring's argv (git grep -l -z -F [-w] --untracked; git ls-files with bracketed
 * names). Paths come back under /r, so memFs(files) serves the planner the same tree.
 */
async function withGitTree(files: Record<string, string>, fn: (search: TestSearchSeam) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "omr-qag10-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const keys = Object.keys(files).filter((p) => p.startsWith("/r/") && p !== "/r/.git");
    for (const p of keys) {
      if (keys.some((q) => q.startsWith(`${p}/`))) continue; // a directory marker for memFs
      const abs = path.join(dir, ...p.slice(3).split("/"));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, files[p]);
    }
    const git = (args: string[]): string | undefined => {
      const r = spawnSync("git", ["--no-optional-locks", "-C", dir, ...args], { encoding: "utf8" });
      return r.status === 0 ? r.stdout : r.status === 1 && args[0] === "grep" ? "" : undefined;
    };
    const under = (out: string | undefined) => out?.split("\0").filter(Boolean).map((rel) => `/r/${rel}`);
    const lit = (n: string) => n.replace(/[*?[\]\\]/g, (c) => (c === "\\" ? "[\\\\]" : `[${c}]`));
    await fn({
      findByName: vi.fn(async (_r: string, names: readonly string[]) =>
        under(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...names.map((n) => `:(glob)**/${lit(n)}`)])),
      ),
      // options.regex: as in treeSearch, the QA-G-2 seam's -E.
      findByContent: vi.fn(async (_r: string, needle: string, globs: readonly string[], options?: { readonly word?: boolean; readonly regex?: boolean }) =>
        under(git(["grep", "-l", "-z", options?.regex === true ? "-E" : "-F", ...(options?.word === true ? ["-w"] : []), "--untracked", "-e", needle, "--", ...globs])),
      ),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe("E2E-1: pytest maps a changed module to the tests that import it, and fails closed", () => {
  // The e2e fixture's layout and contents (test/fixtures/projects/pytest-app), in memory under /r.
  const PYAPP = path.resolve(__dirname, "../fixtures/projects/pytest-app");
  const rels = [
    "pyproject.toml", "app/__init__.py", "app/mod01.py", "app/mod02.py", "tests/conftest.py",
    "tests/test_mod01_1.py", "tests/test_mod01_2.py", "tests/test_mod01_3.py", "tests/test_mod02_1.py", "tests/test_mod03_1.py",
    "extra/test_preexisting.py",
  ];
  // memFs knows files only; "/r/tests" makes the testpaths directory exist (PlannerFs.fileExists accepts directories).
  const fixture = (extra: Record<string, string> = {}): Record<string, string> =>
    pyRepo({ "/r/tests": "", ...Object.fromEntries(rels.map((r) => [`/r/${r}`, readFileSync(path.join(PYAPP, r), "utf8")])), ...extra });
  const plan = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "uv run pytest", files, changedFiles: changed(...paths), search: treeSearch(files), ...over }));

  it("the fixture really has the layout under test", () => {
    expect(readFileSync(path.join(PYAPP, "pyproject.toml"), "utf8")).toMatch(/testpaths = \["tests"\]/);
    expect(readFileSync(path.join(PYAPP, "tests/test_mod02_1.py"), "utf8")).toContain("from app.mod02 import value02");
    expect(readFileSync(path.join(PYAPP, "extra/test_preexisting.py"), "utf8")).toContain("from app.mod01 import value01");
  });

  it("app/mod02.py -> tests/test_mod02_1.py (was NoAffected: no test is named test_mod02.py)", async () => {
    const r = await plan(fixture(), ["app/mod02.py"]);
    expect(isNoAffected(r), JSON.stringify(r)).toBe(false);
    const s = spec(r);
    expect(s.inputs).toEqual(["/r/tests/test_mod02_1.py"]);
    expect(s.file).toBe("/usr/bin/uv");
    expect(s.args.slice(0, 2)).toEqual(["run", "pytest"]);
    expect(s.args.slice(s.args.indexOf("--"))).toEqual(["--", "/r/tests/test_mod02_1.py"]);
  });

  it("testpaths bound the inputs: extra/test_preexisting.py imports app.mod01 but the user's run never collects it", async () => {
    const s = spec(await plan(fixture(), ["app/mod01.py"]));
    expect(s.inputs).toEqual(["/r/tests/test_mod01_1.py", "/r/tests/test_mod01_2.py", "/r/tests/test_mod01_3.py"]);
    // Once it is copied into tests/ (the e2e pre-existing failure), it is one of the module's tests.
    const pre = fixture({ "/r/tests/test_preexisting.py": readFileSync(path.join(PYAPP, "extra/test_preexisting.py"), "utf8") });
    expect(spec(await plan(pre, ["app/mod01.py"])).inputs).toContain("/r/tests/test_preexisting.py");
    // A changed test file outside testpaths is not one of the run's tests either.
    expect(await plan(fixture(), ["extra/test_preexisting.py"])).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
  });

  it("every import spelling maps; a longer name that merely contains the stem does not", async () => {
    const files = fixture({
      "/r/tests/test_a.py": "import app.mod02\n",
      "/r/tests/test_b.py": "from app import mod01, mod02 as m\n",
      "/r/tests/test_c.py": "from app import (\n    mod02,\n)\n",
      "/r/tests/pkg/__init__.py": "",
      "/r/tests/pkg/helper.py": "X = 1\n",
      "/r/tests/pkg/test_d.py": "from .helper import X\nfrom . import helper\n",
      "/r/tests/test_e.py": "from app.mod020 import x\nimport app.mod02x\n",
    });
    expect(spec(await plan(files, ["app/mod02.py"])).inputs).toEqual([
      "/r/tests/test_a.py", "/r/tests/test_b.py", "/r/tests/test_c.py", "/r/tests/test_mod02_1.py",
    ]);
    expect(spec(await plan(files, ["tests/pkg/helper.py"])).inputs).toEqual(["/r/tests/pkg/test_d.py"]);
  });

  it("fails closed: no test maps, a conftest.py references the module, or the search fails -> S6", async () => {
    expectUnmapped(await plan(fixture({ "/r/app/orphan.py": "" }), ["app/orphan.py"]), "app/orphan.py");
    // A module only extra/ (outside testpaths) imports maps to nothing the user's run collects.
    expectUnmapped(await plan(fixture({ "/r/app/mod09.py": "", "/r/extra/test_nine.py": "import app.mod09\n" }), ["app/mod09.py"]), "app/mod09.py");
    const viaFixture = fixture({ "/r/tests/conftest.py": "import pytest\nfrom app.mod02 import value02\n" });
    expectS6(
      await plan(viaFixture, ["app/mod02.py"]),
      "unmapped-module",
      "changed module app/mod02.py is referenced by tests/conftest.py: the tests its fixtures reach cannot be mapped",
    );
    const failing: TestSearchSeam = { findByName: vi.fn(async () => []), findByContent: vi.fn(async () => undefined) };
    expectS6(await plan(fixture(), ["app/mod02.py"], { search: failing }), "search-failed", "test search failed for app/mod02.py");
    // One unmapped module in a change makes the whole change S6, even when another one maps.
    expectUnmapped(await plan(fixture({ "/r/app/orphan.py": "" }), ["app/mod02.py", "app/orphan.py"]), "app/orphan.py");
  });

  it("QA-G-2 (C1): app/app.py, named like its package, maps to the tests that may import it, not to every `from app.modNN` test", async () => {
    const files = fixture({ "/r/app/app.py": "X = 1\n", "/r/tests/test_app_use.py": "from app.app import X\n" });
    expect(spec(await plan(files, ["app/app.py"])).inputs).toEqual(["/r/tests/test_app_use.py"]);
    // Imported by no test: S6 unmapped-module (every fixture test names "app" only as `from app.modNN import`).
    expectUnmapped(await plan(fixture({ "/r/app/app.py": "X = 1\n" }), ["app/app.py"]), "app/app.py");
    // QA-G-10: `from app import X` and `import app` are kept (with app/ on sys.path they would load
    // app/app.py): one over-included test, never the full set.
    const pkg = fixture({ "/r/app/app.py": "", "/r/tests/test_pkg.py": "from app import X\nimport app\n" });
    expect(spec(await plan(pkg, ["app/app.py"])).inputs).toEqual(["/r/tests/test_pkg.py"]);
  });

  it("QA-G-10: app/app.py drops a file only when every `app` heads a longer one-line import path; any other use keeps it", async () => {
    const files = fixture({
      "/r/app/app.py": "",
      "/r/tests/test_p1.py": "import app.app as m\n",
      "/r/tests/test_p2.py": "from app import mod01, app\n",
      "/r/tests/test_p3.py": "from app import (\n    mod01,\n    app as a,\n)\n",
      "/r/tests/test_p4.py": "from app import mod01, \\\n    app\n",
      "/r/tests/test_p5.py": "import app\nx = app.app.X\n",
      "/r/tests/test_p6.py": "from app.app.sub import X\n",
      // Kept on doubt: an imported name, a bare package import, a statement the line parse does not
      // take (`;`, a continuation, spaces around the dot), a string, a comment, an attribute chain.
      "/r/tests/test_k1.py": "from app.app_utils import X\nfrom app.mod01 import app\n",
      "/r/tests/test_k2.py": "import app\nfrom app import application\n",
      "/r/tests/test_k3.py": "import app.mod01; import os\n",
      "/r/tests/test_k4.py": "import app.mod01, \\\n    app.mod03\n",
      "/r/tests/test_k5.py": 'import importlib\nm = importlib.import_module("app.mod01")\n',
      "/r/tests/test_k6.py": "from app . mod01 import value01\n",
      "/r/tests/test_k7.py": "from app.mod01 import value01  # app\n",
      "/r/tests/test_k8.py": "import app.mod01\nvalue = app.mod01.value01(1)\n",
      // Dropped: every `app` heads a longer import path (LF, CRLF, CR; tabs, relative, `as`, a comment).
      "/r/tests/test_d1.py": "from app.mod01 import value01\nimport app.mod01, app.mod03 as m3  # note\n",
      "/r/tests/test_d2.py": "from ..app.mod02 import (\r\n    value02,\r\n)\r\n\tfrom\tapp.mod01\timport(value01)\r\n",
      "/r/tests/test_d3.py": "if True:\r    import app.mod01 as m\r    from .app.mod03 import value03\r",
    });
    expect(spec(await plan(files, ["app/app.py"])).inputs).toEqual([
      ...["k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8"].map((k) => `/r/tests/test_${k}.py`),
      ...["p1", "p2", "p3", "p4", "p5", "p6"].map((k) => `/r/tests/test_${k}.py`),
    ]);
    // A namespace directory (no app/__init__.py) may make `app` the module itself: nothing is dropped.
    const ns = Object.fromEntries(Object.entries(files).filter(([p]) => p !== "/r/app/__init__.py"));
    expectS6(await plan(ns, ["app/app.py"]), "stem-too-common");
    const rel = fixture({
      "/r/tests/pkg/__init__.py": "",
      "/r/tests/pkg/util.py": "",
      "/r/tests/pkg/test_r1.py": "from .util import X\n",
      "/r/tests/pkg/test_r2.py": "from .. import pkg\nfrom . import (\n  other,\n)\n",
      "/r/tests/pkg/test_r3.py": "from .. import util\n",
      "/r/tests/pkg/test_r4.py": "from .pkg import util\n",
    });
    expect(spec(await plan(rel, ["tests/pkg/util.py"])).inputs).toEqual(["/r/tests/pkg/test_r1.py", "/r/tests/pkg/test_r3.py", "/r/tests/pkg/test_r4.py"]);
  });

  it("QA-G-2: a module outside a package also matches its bare top-level imports", async () => {
    const files = pyRepo({
      "/r/tests": "",
      "/r/lib/helpers.py": "",
      "/r/tests/test_h1.py": "import os, helpers\n",
      "/r/tests/test_h2.py": "from helpers import f\n",
      "/r/tests/test_h3.py": "import helpers_x\nfrom helpersx import f\n",
    });
    const s = spec(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("lib/helpers.py"), search: treeSearch(files) })));
    expect(s.inputs).toEqual(["/r/tests/test_h1.py", "/r/tests/test_h2.py"]);
  });

  it("QA-G-2: more than STEM_MATCH_LIMIT importing test files -> S6 stem-too-common; __init__.py keeps the word search", async () => {
    const many = Object.fromEntries(Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => [`/r/tests/test_imp${i}.py`, "from app.mod02 import value02\n"]));
    const s6 = await plan(fixture(many), ["app/mod02.py"]);
    expectS6(s6, "stem-too-common", `changed module app/mod02.py: ${STEM_MATCH_LIMIT + 2} test files import it (limit ${STEM_MATCH_LIMIT})`);
    // Exactly at the limit still maps.
    const atLimit = Object.fromEntries(Object.entries(many).slice(0, STEM_MATCH_LIMIT - 1));
    expect(spec(await plan(fixture(atLimit), ["app/mod02.py"])).inputs).toHaveLength(STEM_MATCH_LIMIT);
    // A package's __init__.py runs on every import of the package: every fixture test names "app".
    const search = treeSearch(fixture(many));
    expectS6(await plan(fixture(many), ["app/__init__.py"], { search }), "stem-too-common");
    expect(search.findByContent).toHaveBeenCalledWith("/r", "app", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"], { word: true });
  });

  /**
   * QA-G-10: the finding's corpus for app/mod02.py. Every shape imports it; QA-G-2's import-shaped
   * git grep -E missed the first four (a false pass: `[router ✓ verified]` over a failing importer).
   */
  const CORPUS: Record<string, string> = {
    paren_two_on_line: "from app import (\n    mod01, mod02,\n)\n",
    isort_grid: "from app import (mod01, mod03, mod04,\n                 mod05, mod02)\n",
    backslash_cont: "from app import mod01, \\\n    mod03, mod02\n",
    paren_last_no_comma_crlf: "from app import (\r\n    mod01,\r\n    mod02\r\n)\r\n",
    as_alias: "import app.mod02 as m\n",
    from_as: "from app import mod02 as m\n",
    paren_one_per_line: "from app import (\n    mod01,\n    mod02,\n)\n",
    paren_last_no_comma_lf: "from app import (\n    mod01,\n    mod02\n)\n",
    importlib: 'import importlib\nm = importlib.import_module("app.mod02")\n',
    dunder_import: 'm = __import__("app.mod02")\n',
    rel_from_pkg: "from ..app import mod02\n",
    rel_dotted: "from ..app.mod02 import value02\n",
    attr_chain: "import app\nx = app.mod02.value02(1)\n",
  };
  /** A longer name that merely contains the stem. */
  const DECOY = "from app import mod020\nimport app.mod020x\nfrom app.mod020 import mod02x\n";
  /** The corpus (and the decoy) as test files, with every line end rewritten to `eol` when given. */
  const corpus = (eol?: string): Record<string, string> =>
    Object.fromEntries(
      Object.entries({ ...CORPUS, decoy: DECOY }).map(([k, c]) => [`/r/tests/test_q_${k}.py`, eol === undefined ? c : c.replace(/\r?\n/g, eol)]),
    );
  const CORPUS_HITS = [...Object.keys(CORPUS).map((k) => `/r/tests/test_q_${k}.py`), "/r/tests/test_mod02_1.py"].sort();

  it.each([
    ["as written (LF, one CRLF file)", undefined],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("QA-G-10: every corpus import layout selects its test, %s; the mod020 decoy does not", async (_eol, eol) => {
    const files = fixture(corpus(eol));
    expect(spec(await plan(files, ["app/mod02.py"])).inputs).toEqual(CORPUS_HITS);
  });

  it.each([
    ["as written (LF, one CRLF file)", undefined],
    ["CRLF", "\r\n"],
  ])("QA-G-10: the same through real git grep -F -w (the wiring's argv), %s", async (_eol, eol) => {
    const files = fixture(corpus(eol));
    await withGitTree(files, async (search) => {
      expect(spec(await plan(files, ["app/mod02.py"], { search })).inputs).toEqual(CORPUS_HITS);
      expect(search.findByContent).toHaveBeenCalledWith("/r", "mod02", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"], { word: true });
    });
  }, REAL_GIT_TIMEOUT_MS);

  it("QA-G-10 (C1) through real git: app/app.py maps to its importer only, not to the fixture's `from app.modNN` tests", async () => {
    const files = fixture({ "/r/app/app.py": "X = 1\n", "/r/tests/test_app_use.py": "from app.app import (\r\n    X,\r\n)\r\n" });
    await withGitTree(files, async (search) => {
      expect(spec(await plan(files, ["app/app.py"], { search })).inputs).toEqual(["/r/tests/test_app_use.py"]);
    });
  }, REAL_GIT_TIMEOUT_MS);

  it("QA-G-10: regex metacharacter stems match literally, through real git", async () => {
    const files = fixture({
      "/r/app/mod+1.py": "",
      "/r/app/mod.1.py": "",
      "/r/app/a(b).py": "",
      "/r/tests/test_lit_plus.py": "# mod+1\n",
      "/r/tests/test_dec_plus.py": "# modd1 moddd1 mod1\n",
      "/r/tests/test_lit_dot.py": "# mod.1\n",
      "/r/tests/test_dec_dot.py": "# modx1 mod_1\n",
      "/r/tests/test_lit_paren.py": "# a(b)\n",
      "/r/tests/test_dec_paren.py": "# ab a b\n",
    });
    await withGitTree(files, async (search) => {
      expect(spec(await plan(files, ["app/mod+1.py"], { search })).inputs).toEqual(["/r/tests/test_lit_plus.py"]);
      expect(spec(await plan(files, ["app/mod.1.py"], { search })).inputs).toEqual(["/r/tests/test_lit_dot.py"]);
      expect(spec(await plan(files, ["app/a(b).py"], { search })).inputs).toEqual(["/r/tests/test_lit_paren.py"]);
    });
  }, REAL_GIT_TIMEOUT_MS);

  it("QA-G-10: index.py is searched by its own name (QA-G-2 searched app/index.py as `app.app`)", async () => {
    const files = fixture({
      "/r/app/index.py": "",
      "/r/tests/test_i1.py": "from app.index import X\n",
      "/r/tests/test_i2.py": "from app import (mod01,\n    index)\n",
    });
    const search = treeSearch(files);
    expect(spec(await plan(files, ["app/index.py"], { search })).inputs).toEqual(["/r/tests/test_i1.py", "/r/tests/test_i2.py"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "index", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"], { word: true });
    // The name search keeps the stem (the directory name): test_app.py.
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_app.py", "app_test.py"]);
  });

  it("QA-G-17: a deleted index.py is searched by its own name, so its importers run (was a false pass)", async () => {
    // app/index.py is deleted (not in the tree); two tests still import it and will fail with ImportError.
    const files = fixture({
      "/r/tests/test_i1.py": "from app.index import x\n",
      "/r/tests/test_i2.py": "from .index import x\n",
    });
    const search = treeSearch(files);
    expect(spec(await plan(files, ["app/index.py"], { search })).inputs).toEqual(["/r/tests/test_i1.py", "/r/tests/test_i2.py"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "index", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_app.py", "app_test.py"]);
    // Inside a test package: tests/pkg/index.py deleted, its sibling imports it relatively.
    const pkg = fixture({ "/r/tests/pkg/__init__.py": "", "/r/tests/pkg/test_rel.py": "from .index import helper\n" });
    expect(spec(await plan(pkg, ["tests/pkg/index.py"])).inputs).toEqual(["/r/tests/pkg/test_rel.py"]);
    // Fail-closed rules are unchanged: no reference -> S6, more than STEM_MATCH_LIMIT -> S6.
    expectS6(await plan(fixture(), ["app/index.py"]), "deleted-no-tests", 'deleted source app/index.py: no test file references "index"');
    const many = Object.fromEntries(Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => [`/r/tests/test_ix${i}.py`, "from app.index import x\n"]));
    expectS6(
      await plan(fixture(many), ["app/index.py"]),
      "stem-too-common",
      `deleted source app/index.py: "index" appears in ${STEM_MATCH_LIMIT + 1} test files (limit ${STEM_MATCH_LIMIT})`,
    );
  });

  it("QA-G-17: a deleted ordinary module keeps its search name; a deleted __init__.py is S6 (QA-G-22)", async () => {
    // app/mod02.py deleted: searched as "mod02", finds its importer.
    const files = Object.fromEntries(Object.entries(fixture()).filter(([p]) => p !== "/r/app/mod02.py"));
    const search = treeSearch(files);
    expect(spec(await plan(files, ["app/mod02.py"], { search })).inputs).toEqual(["/r/tests/test_mod02_1.py"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "mod02", [...PY_TEST_GLOBS, ":(glob)**/conftest.py"]);
    // tests/pkg/__init__.py deleted: was a spec of the package name's importers ("pkg"), now S6 before any search.
    const init = fixture({ "/r/tests/pkg/test_p.py": "from tests.pkg import helper\n" });
    const initSearch = treeSearch(init);
    expectS6(
      await plan(init, ["tests/pkg/__init__.py"], { search: initSearch }),
      "unmapped-module",
      "package structure changed: tests/pkg/__init__.py deleted; pytest import paths may shift",
    );
    expect(initSearch.findByContent).not.toHaveBeenCalled();
  });

  describe("QA-G-18..22: a deleted pytest file's conftest and test importers run, a deleted __init__.py is S6, or the plan is S6", () => {
    const GLOBS = [...PY_TEST_GLOBS, ":(glob)**/conftest.py"];
    const UNMAPPABLE = ": the tests its fixtures reach cannot be mapped";
    /** The fixture tests that import the app package (`from app.modNN import ...`); extra/ is outside testpaths. */
    const APP = ["/r/tests/test_mod01_1.py", "/r/tests/test_mod01_2.py", "/r/tests/test_mod01_3.py", "/r/tests/test_mod02_1.py", "/r/tests/test_mod03_1.py"];
    const without = (files: Record<string, string>, gone: string) => Object.fromEntries(Object.entries(files).filter(([p]) => p !== gone));
    // X2: a fixture of tests/api/conftest.py imports the deleted app.helpers; test_unit.py only says "helpers" in a comment.
    const X2 = fixture({
      "/r/tests/api/conftest.py": "import pytest\nfrom app.helpers import make\n\n@pytest.fixture\ndef made():\n    return make()\n",
      "/r/tests/api/test_api.py": "def test_api(made):\n    assert made\n",
      "/r/tests/unit/test_unit.py": "# string helpers\ndef test_unit():\n    assert 'a'.upper() == 'A'\n",
    });
    // X3: tests/test_base.py renamed to tests/base.py; test_a follows it, test_b still imports test_base.
    const X3 = pyRepo({
      "/r/tests": "",
      "/r/tests/base.py": "class Base:\n    pass\n",
      "/r/tests/test_a.py": "from base import Base\n",
      "/r/tests/test_b.py": "from test_base import Base\n",
      "/r/tests/test_c.py": "def test_base_case():\n    pass\n",
    });
    const RENAMED: ChangedPath[] = [{ path: "tests/base.py", previousPath: "tests/test_base.py" }];
    // X4: tests/pkg/__init__.py deleted; test_rel.py imports relatively; test_other.py matches "pkg" only inside "pkgutil".
    const X4 = fixture({
      "/r/tests/pkg/helper.py": "X = 1\n",
      "/r/tests/pkg/test_rel.py": "from . import helper\n\ndef test_rel():\n    assert helper.X == 1\n",
      "/r/tests/test_other.py": "import pkgutil\n",
    });
    // X1: app/__init__.py re-exports from the deleted app/index.py; test_util.py only calls list.index.
    const X1 = fixture({ "/r/app/__init__.py": "from .index import VERSION\n", "/r/tests/test_util.py": "def test_util():\n    assert [1, 2].index(2) == 1\n" });

    it("QA-G-19: a deleted module a nested conftest.py imports -> S6 unmapped-module (was a spec without the conftest's tests)", async () => {
      const search = treeSearch(X2);
      expectS6(await plan(X2, ["app/helpers.py"], { search }), "unmapped-module", `deleted source app/helpers.py: tests/api/conftest.py references "helpers"${UNMAPPABLE}`);
      expect(search.findByContent).toHaveBeenCalledWith("/r", "helpers", GLOBS);
      // X2b: a deleted index.py, with an `.index(` decoy test.
      const x2b = fixture({
        "/r/tests/api/conftest.py": "from app.index import make\n",
        "/r/tests/api/test_api.py": "def test_api():\n    pass\n",
        "/r/tests/unit/test_unit.py": "def test_unit():\n    assert [1, 2].index(2) == 1\n",
      });
      expectS6(await plan(x2b, ["app/index.py"]), "unmapped-module", `deleted source app/index.py: tests/api/conftest.py references "index"${UNMAPPABLE}`);
      // Control X2c: the same module, modified, is S6 through the existing-module search.
      expectS6(
        await plan({ ...X2, "/r/app/helpers.py": "def make():\n    return 1\n" }, ["app/helpers.py"]),
        "unmapped-module",
        `changed module app/helpers.py is referenced by tests/api/conftest.py${UNMAPPABLE}`,
      );
      // A conftest hit that is not a file in the tree is not one.
      const ghost = stubSearch({ helpers: ["/r/tests/gone/conftest.py", "/r/tests/unit/test_unit.py"] });
      expect(spec(await plan(X2, ["app/helpers.py"], { search: ghost })).inputs).toEqual(["/r/tests/unit/test_unit.py"]);
    });

    it("QA-G-20: a deleted or renamed-away test file other tests import runs them (was a spec or NoAffected without them)", async () => {
      const search = treeSearch(X3);
      const s = spec(await plan(X3, [], { changedFiles: RENAMED, search }));
      expect(s.inputs).toEqual(["/r/tests/test_a.py", "/r/tests/test_b.py"]);
      expect(s.notes).toContain("deleted test file not run: tests/test_base.py");
      // Its Python name as a whole word: test_c's test_base_case is not a reference.
      expect(search.findByContent).toHaveBeenCalledWith("/r", "test_base", GLOBS, { word: true });
      // X3b: deleted alone (was NoAffected), imported as a module, through its package, or relatively.
      const x3b = pyRepo({
        "/r/tests": "",
        "/r/tests/test_b.py": "import test_base\n",
        "/r/tests/test_d.py": "from tests.test_base import Base\n",
        "/r/tests/pkg/__init__.py": "",
        "/r/tests/pkg/test_e.py": "from .test_base import Base\n",
        "/r/tests/test_f.py": "import test_base_extra\n",
      });
      expect(spec(await plan(x3b, ["tests/test_base.py"])).inputs).toEqual(["/r/tests/pkg/test_e.py", "/r/tests/test_b.py", "/r/tests/test_d.py"]);
      // A test file nothing names keeps only its note, as before.
      expect(await plan(pyRepo({ "/r/tests/test_x.py": "" }), ["tests/test_base.py"])).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
      // Fail closed: a conftest.py that names it, too many importers, a failed search.
      const conf = pyRepo({ "/r/tests/sub/conftest.py": "from test_base import helper\n", "/r/tests/sub/test_s.py": "" });
      expectS6(await plan(conf, ["tests/test_base.py"]), "unmapped-module", `deleted test file tests/test_base.py: tests/sub/conftest.py references "test_base"${UNMAPPABLE}`);
      const many = pyRepo(Object.fromEntries(Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => [`/r/tests/test_u${i}.py`, "import test_base\n"])));
      expectS6(
        await plan(many, ["tests/test_base.py"]),
        "stem-too-common",
        `deleted test file tests/test_base.py: "test_base" appears in ${STEM_MATCH_LIMIT + 1} test files (limit ${STEM_MATCH_LIMIT})`,
      );
      expectS6(await plan(pyRepo(), ["tests/test_base.py"], { search: stubSearch({ test_base: undefined }) }), "search-failed", "test search failed for tests/test_base.py");
    });

    it("QA-G-20: a deleted test file is a pending search, statically and under SEARCH_LIMIT", async () => {
      const { search: _s, ...rest } = input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_base.py") });
      expect(await planStaticScoping(rest)).toEqual({ scopable: true, runner: "pytest", pendingSearches: 1, notes: ["deleted test file not run: tests/test_base.py"] });
      const gone = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `tests/test_g${i}.py`);
      expectS6(await plan(pyRepo(), gone), "too-many-searches", `too many changed modules to map: ${SEARCH_LIMIT + 1} test searches (limit ${SEARCH_LIMIT})`);
    });

    /** QA-G-22: the S6 every deleted or renamed-away __init__.py gives, before any search. */
    const pkgChanged = (rel: string) => `package structure changed: ${rel} deleted; pytest import paths may shift`;
    const noSearch = (search: TestSearchSeam) => {
      expect(search.findByContent).not.toHaveBeenCalled();
      expect(search.findByName).not.toHaveBeenCalled();
    };
    // QA-G-22 repro: tests/pkg/__init__.py deleted; tests/pkg is now put first on sys.path, and its
    // utils.py (only g) shadows src/utils.py (f) for tests/test_uses.py, which never names "pkg".
    const G22 = pyRepo({
      "/r/tests": "",
      "/r/pytest.ini": "[pytest]\npythonpath = src\n",
      "/r/src/utils.py": "def f():\n    return 1\n",
      "/r/tests/pkg/utils.py": "def g():\n    return 2\n",
      "/r/tests/pkg/test_p.py": "def test_p():\n    assert True\n",
      "/r/tests/test_uses.py": "import utils\n\ndef test_u():\n    assert utils.f() == 1\n",
    });

    it("QA-G-22: a deleted test-package __init__.py whose modules shadow others -> S6 unmapped-module (was a spec of tests/pkg/test_p.py)", async () => {
      const search = treeSearch(G22);
      expectS6(await plan(G22, ["tests/pkg/__init__.py"], { search }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      noSearch(search);
      // A subpackage shadowing a source package (tests/api/helpers/ over src/helpers/) is the same S6.
      const sub = pyRepo({
        "/r/tests": "",
        "/r/pytest.ini": "[pytest]\npythonpath = src\n",
        "/r/src/helpers/__init__.py": "def f():\n    return 1\n",
        "/r/tests/api/helpers/__init__.py": "",
        "/r/tests/api/test_api.py": "def test_api():\n    pass\n",
        "/r/tests/test_h.py": "from helpers import f\n",
      });
      expectS6(await plan(sub, ["tests/api/__init__.py"]), "unmapped-module", pkgChanged("tests/api/__init__.py"));
    });

    it("QA-G-21/22: a deleted __init__.py is S6 in every shape 68edf52 mapped (was a spec of the package's tests)", async () => {
      // X4, the QA-G-21 repro: was ["tests/pkg/test_rel.py", "tests/test_other.py"].
      const search = treeSearch(X4);
      expectS6(await plan(X4, ["tests/pkg/__init__.py"], { search }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      noSearch(search);
      // X4 without the decoy: was ["tests/pkg/test_rel.py"].
      expectS6(await plan(without(X4, "/r/tests/test_other.py"), ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // Subdirectories and a namesake: was ["tests/pkg/sub/test_deep.py", "tests/pkg/test_mod01_1.py", "tests/test_mod01_1.py"].
      const deep = fixture({ "/r/tests/pkg/sub/test_deep.py": "", "/r/tests/pkg/test_mod01_1.py": "" });
      expectS6(await plan(deep, ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // A deleted source package __init__.py (app/ lies outside testpaths): was the five `from app.modNN` tests.
      const app = without(fixture({ "/r/app/test_in.py": "from . import mod01\n" }), "/r/app/__init__.py");
      expectS6(await plan(app, ["app/__init__.py"]), "unmapped-module", pkgChanged("app/__init__.py"));
      // At the git root: was ["tests/test_mod01_1.py"] through the "." listing.
      const root = treeSearch(fixture());
      expectS6(await plan(fixture(), ["__init__.py"], { search: root }), "unmapped-module", pkgChanged("__init__.py"));
      noSearch(root);
      // python_files that match __init__.py do not make it a leaf test file: was ["tests/pkg/test_rel.py"].
      const star = pyRepo({ "/r/pytest.ini": "[pytest]\npython_files = *.py\n", "/r/tests/pkg/test_rel.py": "from . import helper\n" });
      expectS6(await plan(star, ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // Was S6 unmapped-module "deleted package … conftest.py loses its package", stem-too-common (21 in the
      // package; 11 plus 11 namesakes) and search-failed (listing, name search): one reason for all now.
      const conf = fixture({ "/r/tests/pkg/conftest.py": "from . import helper\n", "/r/tests/pkg/sub/test_s.py": "" });
      expectS6(await plan(conf, ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      const crowd = fixture(Object.fromEntries(Array.from({ length: STEM_MATCH_LIMIT + 1 }, (_, i) => [`/r/tests/pkg/test_p${i}.py`, ""])));
      expectS6(await plan(crowd, ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      const pairs = fixture(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`/r/tests/pkg/test_d${i}.py`, `/r/tests/other/test_d${i}.py`]).flat().map((p) => [p, ""])));
      expectS6(await plan(pairs, ["tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      const failing = stubSearch({ pkg: undefined }, { "test_rel.py": undefined });
      expectS6(await plan(X4, ["tests/pkg/__init__.py"], { search: failing }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      noSearch(failing);
    });

    it("QA-G-22/23: any gone __init__.py in the change set is S6, renamed away, beside mapped files, statically and before SEARCH_LIMIT", async () => {
      // Renamed away (the rename source is gone): tests/pkg -> tests/pkg2, as git reports the moved __init__.py.
      const moved = fixture({ "/r/tests/pkg2/__init__.py": "", "/r/tests/pkg2/test_rel.py": "from . import helper\n" });
      const renamed: ChangedPath[] = [{ path: "tests/pkg2/__init__.py", previousPath: "tests/pkg/__init__.py" }];
      expectS6(await plan(moved, [], { changedFiles: renamed }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // Beside a changed test that maps and a module that maps: the whole change is S6, not a spec of them.
      expectS6(await plan(G22, ["tests/test_uses.py", "src/utils.py", "tests/pkg/__init__.py"]), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // QA-G-23 shape: an untracked test beside the deleted __init__.py no longer turns the S6 into a spec of it.
      const drift = fixture({ "/r/tests/Pkg/helper.py": "", "/r/tests/Pkg/test_rel.py": "from . import helper\n", "/r/tests/Pkg/test_new.py": "def test_new():\n    pass\n" });
      const driftSearch = treeSearch(drift);
      expectS6(await plan(drift, ["tests/Pkg/__init__.py", "tests/Pkg/test_new.py"], { search: driftSearch }), "unmapped-module", pkgChanged("tests/Pkg/__init__.py"));
      noSearch(driftSearch);
      // Outside testpaths and runnerCwd scopes too: pytest's import of anything under it may shift.
      expectS6(await plan(fixture({ "/r/extra/pkg/test_x.py": "" }), ["extra/pkg/__init__.py"]), "unmapped-module", pkgChanged("extra/pkg/__init__.py"));
      // Static scoping decides it without a search (was {scopable: true, pendingSearches: 1}).
      const { search: _s, ...rest } = input({ command: "uv run pytest", files: G22, changedFiles: changed("tests/pkg/__init__.py") });
      expectS6(await planStaticScoping(rest), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // It comes before SEARCH_LIMIT: 51 gone modules plus a gone __init__.py name the package change.
      const gone = [...Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `app/gone${i}.py`), "tests/pkg/__init__.py"];
      expectS6(await plan(G22, gone), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      // A kept __init__.py is a module as before (G22 control: test_p.py edited maps to itself).
      expect(spec(await plan({ ...G22, "/r/tests/pkg/__init__.py": "" }, ["tests/pkg/test_p.py"])).inputs).toEqual(["/r/tests/pkg/test_p.py"]);
    });

    it("QA-G-22: win32 compares the gone __init__.py's name case-insensitively", async () => {
      const files = { "C:\\repo\\.git": "", "C:\\repo\\tests\\pkg\\test_p.py": "" };
      const r = await planScopedRun(input({ win: true, command: "pytest", files, cwd: "C:\\repo", changedFiles: changed("tests\\pkg\\__INIT__.py") }));
      expectS6(r, "unmapped-module", pkgChanged("tests/pkg/__INIT__.py"));
    });

    it("QA-G-18: a deleted module its package's __init__.py still imports runs the package's importers (was a spec through an .index( decoy)", async () => {
      const search = treeSearch(X1);
      expect(spec(await plan(X1, ["app/index.py"], { search })).inputs).toEqual([...APP, "/r/tests/test_util.py"]);
      expect(search.findByContent).toHaveBeenCalledWith("/r", "app", GLOBS, { word: true });
      // X1b: app/helpers.py, the same shape.
      expect(spec(await plan(fixture({ "/r/app/__init__.py": "from .helpers import make\n" }), ["app/helpers.py"])).inputs).toEqual(APP);
      // An __init__.py that does not name it adds no package search (the fixture's docstring).
      const plain = without(X1, "/r/app/__init__.py");
      const plainFiles = { ...plain, "/r/app/__init__.py": fixture()["/r/app/__init__.py"] };
      const plainSearch = treeSearch(plainFiles);
      expect(spec(await plan(plainFiles, ["app/index.py"], { search: plainSearch })).inputs).toEqual(["/r/tests/test_util.py"]);
      expect(plainSearch.findByContent).not.toHaveBeenCalledWith("/r", "app", GLOBS, { word: true });
      // One that cannot be read is taken to name it.
      expect(spec(await plan(plainFiles, ["app/index.py"], { fs: memFs(plainFiles, false, {}, ["/r/app/__init__.py"]) })).inputs).toEqual([...APP, "/r/tests/test_util.py"]);
      // A conftest.py that imports the package -> S6.
      const conf = { ...X1, "/r/tests/api/conftest.py": "import app\n" };
      expectS6(await plan(conf, ["app/index.py"]), "unmapped-module", `deleted source app/index.py: tests/api/conftest.py references "app"${UNMAPPABLE}`);
    });

    it("QA-G-18..22: the same plans through real git (the wiring's argv)", async () => {
      await withGitTree(X2, async (search) => {
        expectS6(await plan(X2, ["app/helpers.py"], { search }), "unmapped-module", `deleted source app/helpers.py: tests/api/conftest.py references "helpers"${UNMAPPABLE}`);
      });
      await withGitTree(X3, async (search) => {
        expect(spec(await plan(X3, [], { changedFiles: RENAMED, search })).inputs).toEqual(["/r/tests/test_a.py", "/r/tests/test_b.py"]);
      });
      const x4 = { ...X4, "/r/tests/pkg/sub/test_deep.py": "", "/r/tests/pkgutil/test_near.py": "" };
      await withGitTree(x4, async (search) => {
        // Was ["tests/pkg/sub/test_deep.py", "tests/pkg/test_rel.py", "tests/test_other.py"].
        expectS6(await plan(x4, ["tests/pkg/__init__.py"], { search }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
        noSearch(search);
      });
      await withGitTree(G22, async (search) => {
        expectS6(await plan(G22, ["tests/pkg/__init__.py"], { search }), "unmapped-module", pkgChanged("tests/pkg/__init__.py"));
      });
      await withGitTree(X1, async (search) => {
        expect(spec(await plan(X1, ["app/index.py"], { search })).inputs).toEqual([...APP, "/r/tests/test_util.py"]);
      });
    }, REAL_GIT_TIMEOUT_MS);
  });

  describe("QA-G-10: app/app.py keeps a hit it cannot prove is not an importer", () => {
    // Dropped when read: its only `app` heads `app.mod01`.
    const X = "/r/tests/test_x.py";
    const files = fixture({ "/r/app/app.py": "", [X]: "from app.mod01 import value01\n" });
    const withStat = (size: (p: string) => number): PlannerFs => ({
      ...memFs(files),
      stat: async (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return { isFile: true, size: size(p), dev: 1, ino: 1 };
      },
    });
    const kept = async (over: Partial<PlanScopedRunInput>, f = files) => expect(spec(await plan(f, ["app/app.py"], over)).inputs).toEqual([X]);

    it("dropped when read, with and without fs.stat", async () => {
      expectUnmapped(await plan(files, ["app/app.py"]), "app/app.py");
      expectUnmapped(await plan(files, ["app/app.py"], { fs: withStat((p) => files[p].length) }), "app/app.py");
    });
    it("a read that fails", () => kept({ fs: memFs(files, false, {}, [X]) }));
    it("a stat that fails", () => kept({ fs: withStat((p) => { if (p === X) throw new Error("EACCES"); return files[p].length; }) }));
    it("a file over CONFIG_SIZE_LIMIT, by fs.stat (not read) or by its read length", async () => {
      const fs = withStat((p) => (p === X ? CONFIG_SIZE_LIMIT + 1 : files[p].length));
      const read = vi.spyOn(fs, "readFile");
      await kept({ fs });
      expect(read).not.toHaveBeenCalledWith(X);
      const big = { ...files, [X]: files[X] + "#".repeat(CONFIG_SIZE_LIMIT) };
      await kept({}, big);
    });
    it("a read that finds no occurrence git found", async () => {
      const search: TestSearchSeam = { findByName: vi.fn(async () => []), findByContent: vi.fn(async () => [X]) };
      await kept({ search }, { ...files, [X]: "import os\n" });
    });
  });

  it("QA-G-3: a stem with glob metacharacters maps only by literal name and content", async () => {
    const files = fixture({ "/r/app/mod0[1-2]_[1-3].py": "", "/r/tests/test_mod0[1-2]_[1-3].py": "" });
    const search = treeSearch(files);
    expect(spec(await plan(files, ["app/mod0[1-2]_[1-3].py"], { search })).inputs).toEqual(["/r/tests/test_mod0[1-2]_[1-3].py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_mod0[1-2]_[1-3].py", "mod0[1-2]_[1-3]_test.py"]);
  });
});

describe("G.8b: testpaths decide which test inputs the user's run collects", () => {
  const TP = (v: string) => ({ "/r/pyproject.toml": `[tool.pytest.ini_options]\ntestpaths = ${v}\n` });
  const TREE = {
    // memFs knows files only: these make the directories exist.
    "/r/tests": "",
    "/r/it": "",
    "/r/extra": "",
    "/r/app/m.py": "",
    "/r/tests/test_m.py": "import app.m\n",
    "/r/extra/test_m_extra.py": "import app.m\n",
    "/r/it/test_m_it.py": "from app import m\n",
  };
  const plan = (files: Record<string, string>, over: Partial<PlanScopedRunInput> = {}, cwd = "/r") => {
    const all = pyRepo({ ...TREE, ...files });
    return planScopedRun(input({ command: "pytest", cwd, files: all, changedFiles: changed("/r/app/m.py"), search: treeSearch(all), ...over }));
  };
  const inputsOf = async (...a: Parameters<typeof plan>) => spec(await plan(...a)).inputs;
  const ALL = ["/r/extra/test_m_extra.py", "/r/it/test_m_it.py", "/r/tests/test_m.py"];

  it("TOML arrays and strings, ini values; the union of the entries that exist", async () => {
    expect(await inputsOf(TP('["tests"]'))).toEqual(["/r/tests/test_m.py"]);
    expect(await inputsOf(TP('"tests it"'))).toEqual(["/r/it/test_m_it.py", "/r/tests/test_m.py"]);
    expect(await inputsOf({ "/r/pytest.ini": "[pytest]\ntestpaths =\n    tests\n    gone\n" })).toEqual(["/r/tests/test_m.py"]);
    expect(await inputsOf({ "/r/tox.ini": "[pytest]\ntestpaths = it\n" })).toEqual(["/r/it/test_m_it.py"]);
    expect((await detect("pytest", pyRepo({ ...TREE, ...TP('["tests", "it"]') }))).collectScopes).toEqual(["/r/tests", "/r/it"]);
  });

  it("anything that makes pytest collect elsewhere keeps every test under runnerCwd", async () => {
    // No testpaths, empty, only missing entries, a glob, or an unreadable value.
    expect(await inputsOf({})).toEqual(ALL);
    expect(await inputsOf(TP("[]"))).toEqual(ALL);
    expect(await inputsOf(TP('["gone"]'))).toEqual(ALL);
    expect(await inputsOf(TP('["test*"]'))).toEqual(ALL);
    expect(await inputsOf({ "/r/pytest.ini": "[pytest]\ntestpaths = 'open\n" })).toEqual(ALL);
    // Overrides on the command line, in addopts and in PYTEST_ADDOPTS; --pyargs; --rootdir.
    expect(await inputsOf(TP('["tests"]'), { command: "pytest -o testpaths=extra" })).toEqual(ALL);
    expect(await inputsOf({ "/r/pytest.ini": "[pytest]\ntestpaths = tests\naddopts = -o testpaths=extra\n" })).toEqual(ALL);
    expect(await inputsOf(TP('["tests"]'), { host: { ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts: "--override-ini=testpaths=it" } })).toEqual(ALL);
    expect(await inputsOf(TP('["tests"]'), { command: "pytest --pyargs" })).toEqual(ALL);
    expect(await inputsOf(TP('["tests"]'), { command: "pytest --rootdir=." })).toEqual(ALL);
    // A path argument replaces testpaths.
    expect(await inputsOf(TP('["tests"]'), { command: "pytest extra" })).toEqual(["/r/extra/test_m_extra.py"]);
  });

  it("a glob entry beside a literal one drops the testpaths bound, so an importer the glob collects still runs (QA-3.1-13)", async () => {
    // pytest expands `pkg*/tests` to /r/pkgA/tests. Keeping only the literal `tests` would never run
    // pkgA's importer of app.m, which could hide its failure.
    const pkg = { "/r/pkgA/tests": "", "/r/pkgA/tests/test_m_pkg.py": "import app.m\n" };
    const withPkg = [...ALL, "/r/pkgA/tests/test_m_pkg.py"].sort();
    for (const tp of ['["tests", "pkg*/tests"]', '["pkg?/tests", "tests"]', '["tests", "pkg[A]/tests"]']) {
      expect((await inputsOf({ ...pkg, ...TP(tp) })).slice().sort()).toEqual(withPkg);
      expect((await detect("pytest", pyRepo({ ...TREE, ...pkg, ...TP(tp) }))).collectScopes).toBeUndefined();
    }
    expect(await inputsOf({ ...pkg, "/r/pytest.ini": "[pytest]\ntestpaths =\n    tests\n    pkg*/tests\n" })).toEqual(expect.arrayContaining(["/r/pkgA/tests/test_m_pkg.py"]));
    // Control: the literal entries alone keep the bound.
    expect(await inputsOf({ ...pkg, ...TP('["tests"]') })).toEqual(["/r/tests/test_m.py"]);
  });

  it("testpaths apply only when pytest starts in its rootdir, and on every release line", async () => {
    // Started from /r/tests with the config at /r: the rootdir is /r, so pytest collects /r/tests.
    const sub = await plan(TP('["it"]'), {}, "/r/tests");
    expect(spec(sub).inputs).toEqual(["/r/tests/test_m.py"]);
    // pytest 9 reads pytest.toml (testpaths = tests); pytest 7/8 read pytest.ini (no testpaths): union.
    const lines = { "/r/pytest.toml": '[pytest]\ntestpaths = ["tests"]\n', "/r/pytest.ini": "[pytest]\n" };
    expect(await inputsOf(lines)).toEqual(ALL);
    const agree = { "/r/pytest.toml": '[pytest]\ntestpaths = ["tests"]\n', "/r/pytest.ini": "[pytest]\ntestpaths = it\n" };
    expect(await inputsOf(agree)).toEqual(["/r/it/test_m_it.py", "/r/tests/test_m.py"]);
  });
});

describe("planScopedRun: report path and argv length", () => {
  it("tmpdir inside the repo -> S6", async () => {
    const files = jsRepo({}, { "/r/src/a.ts": "" });
    expectS6(
      await planScopedRun(input({ files, changedFiles: changed("src/a.ts"), host: { ...POSIX_HOST, tmpdir: "/r/tmp" } })),
      "tmpdir-in-repo",
      "temp dir is inside the repository: /r/tmp",
    );
  });

  it("too many inputs -> S6 argv-too-long", async () => {
    const names = Array.from({ length: 400 }, (_, i) => `src/${"x".repeat(80)}${i}.ts`);
    const files = jsRepo({}, Object.fromEntries(names.map((n) => [`/r/${n}`, ""])));
    expectS6(await planScopedRun(input({ files, changedFiles: changed(...names) })), "argv-too-long", "too many inputs for one command line: 400 files");
  });
});

// ---------------------------------------------------------------------------------------------
// planStaticScoping
// ---------------------------------------------------------------------------------------------

describe("planStaticScoping", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };

  it("unavailable, empty and detection failures", async () => {
    expectS6(await st({ changedFiles: "unavailable" }), "attribution-unavailable");
    expect(isNoAffected(await st({ changedFiles: [] }))).toBe(true);
    expectS6(await st({ command: "bun test", changedFiles: changed("a.ts") }), "bun-test");
  });

  it("counts pending searches without running any", async () => {
    expect(await st({ files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts", "src/gone.ts") })).toEqual({
      scopable: true,
      runner: "vitest",
      pendingSearches: 1,
      notes: [],
    });
    expect(await st({ command: "pytest", files: pyRepo({ "/r/src/m.py": "" }), changedFiles: changed("src/m.py", "src/g.py") })).toMatchObject({
      scopable: true,
      runner: "pytest",
      pendingSearches: 2,
    });
  });

  it("nothing decidable -> NoAffected; static S6s still apply", async () => {
    expect(await st({ changedFiles: changed("docs/a.md") })).toEqual({ noAffected: true, note: "no affected tests: no changed file is a test input" });
    expectS6(await st({ changedFiles: changed("vitest.config.ts") }), "config-changed");
    expectS6(await st({ files: jsRepo({}, { "/r/a.ts": "" }), changedFiles: changed("a.ts"), host: { ...POSIX_HOST, tmpdir: "/r" } }), "tmpdir-in-repo");
    expectS6(await st({ files: { "/r/.git": "", "/r/a.ts": "" }, changedFiles: changed("a.ts") }), "runner-not-installed");
  });

  it("pytest entry notes surface (venv fallback)", async () => {
    const r = await st({ command: "pytest", files: { "/r/.git": "", "/r/.venv/bin/pytest": "", "/r/tests/test_a.py": "" }, changedFiles: changed("tests/test_a.py") });
    expect(r).toMatchObject({ scopable: true, pendingSearches: 0, notes: ["pytest resolved from /r/.venv/bin/pytest"] });
  });
});

// ---------------------------------------------------------------------------------------------
// I. readResult
// ---------------------------------------------------------------------------------------------

const REPORTS = path.join(FIX, "reports");
const RPT_JSON = `/tmp/omr-verify-${UUID}.json`;
const RPT_XML = `/tmp/omr-verify-${UUID}.xml`;

/** A captured report with its placeholders substituted. `root` is JSON-escaped for .json reports. */
function report(name: string, root: string): string {
  const raw = readFileSync(path.join(REPORTS, name), "utf8");
  const r = name.endsWith(".json") ? JSON.stringify(root).slice(1, -1) : root;
  return raw.split("<ROOT>").join(r).split("<REPO>").join("repo").split("<PYTHON>").join("py").split("<HOST>").join("host");
}

/** In-memory RunnerFs that records reads and unlinks. */
function resultFs(files: Record<string, string>, unlinkFails = false): RunnerFs & { unlinked: string[]; reads: string[] } {
  const unlinked: string[] = [];
  const reads: string[] = [];
  return {
    unlinked,
    reads,
    fileExists: async (p) => p in files,
    readFile: async (p) => {
      reads.push(p);
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p];
    },
    unlink: async (p) => {
      unlinked.push(p);
      if (unlinkFails) throw new Error(`EPERM ${p}`);
    },
  };
}

function mkSpec(over: Partial<ScopedSpec> = {}): ScopedSpec {
  return {
    runner: "vitest",
    mode: "related",
    file: "/usr/bin/node",
    args: [],
    cwd: "/root/vitest-proj",
    env: {},
    reportPath: RPT_JSON,
    gitRoot: "/root",
    entry: "/root/node_modules/vitest/vitest.mjs",
    inputs: [],
    inputsAreTests: false,
    workers: 2,
    notes: [],
    ...over,
  };
}

const exec = (code: number, stdout = "", stderr = "") => ({ code, stdout, stderr });

async function read(sp: ScopedSpec, files: Record<string, string>, code: number, host = POSIX_HOST, stdout = ""): Promise<RunResult & { fs: ReturnType<typeof resultFs> }> {
  const fs = resultFs(files);
  const r = await readResult(sp, exec(code, stdout), fs, host);
  return { ...r, fs };
}

describe("readResult: vitest JSON", () => {
  it("failures give <file> > <ancestors> > <title> ids and delete the report", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-fail.json", "/root") }, 1);
    expect(r.failingIds).toEqual(["test/str.test.js > str > bad"]);
    expect(r.failingFiles).toEqual(["/root/vitest-proj/test/str.test.js"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false, source: "report" });
    expect(r.note).toBeUndefined();
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("pass and zero tests", async () => {
    const pass = await read(mkSpec(), { [RPT_JSON]: report("vitest-pass.json", "/root") }, 0);
    expect(pass).toMatchObject({ failingIds: [], failingFiles: [], total: 1, complete: true, collectionError: false });
    const none = await read(mkSpec(), { [RPT_JSON]: report("vitest-none.json", "/root") }, 0);
    expect(none).toMatchObject({ failingIds: [], total: 0, complete: true });
  });

  it("an import-time throw (assertionResults []) is a bare file id and a collection error", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-collect-error.json", "/root") }, 1);
    expect(r.failingIds).toEqual(["test/throws.test.js"]);
    expect(r.failingFiles).toEqual(["/root/vitest-proj/test/throws.test.js"]);
    expect(r).toMatchObject({ collectionError: true, complete: true, total: 1 });
  });

  it("non-zero exit with a report listing no failure is incomplete", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-pass.json", "/root") }, 1);
    expect(r).toMatchObject({ complete: false, collectionError: false, note: "runner exited 1 but its report lists no failure" });
  });

  it("tolerates odd suite shapes: non-record, nameless, no assertionResults, no titles, no total", async () => {
    const json = JSON.stringify({
      testResults: [
        null,
        { status: "failed" },
        { name: "/root/vitest-proj/a.test.ts", status: "failed", assertionResults: [{ status: "failed", title: "t" }] },
        { name: "/root/vitest-proj/b.test.ts", status: "passed" },
      ],
    });
    const r = await read(mkSpec(), { [RPT_JSON]: json }, 1);
    expect(r).toMatchObject({ failingIds: ["a.test.ts > t"], total: undefined, complete: true, collectionError: false });
  });
});

describe("readResult: jest JSON (win32 names)", () => {
  const W = { ...WIN_HOST };
  const wspec = (over: Partial<ScopedSpec> = {}) =>
    mkSpec({ runner: "jest", cwd: "C:\\root\\jest-proj", gitRoot: "C:\\root", reportPath: `C:\\Temp\\omr-verify-${UUID}.json`, ...over });
  const at = `C:\\Temp\\omr-verify-${UUID}.json`;

  it("failures map to cwd-relative / ids and native failingFiles", async () => {
    const r = await read(wspec(), { [at]: report("jest-fail.json", "C:\\root") }, 1, W);
    expect(r.failingIds).toEqual(["test/str.test.js > str > bad"]);
    expect(r.failingFiles).toEqual(["C:\\root\\jest-proj\\test\\str.test.js"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false });
    expect(r.fs.unlinked).toEqual([at]);
  });

  it("'Test suite failed to run' (numRuntimeErrorTestSuites) is a collection error", async () => {
    const r = await read(wspec(), { [at]: report("jest-collect-error.json", "C:\\root") }, 1, W);
    expect(r.failingIds).toEqual(["test/broken.test.js"]);
    expect(r).toMatchObject({ collectionError: true, complete: true, total: 1 });
  });

  it("numRuntimeErrorTestSuites alone marks a collection error", async () => {
    const r = await read(wspec(), { [at]: JSON.stringify({ numRuntimeErrorTestSuites: 1, numTotalTests: 0, testResults: [] }) }, 1, W);
    expect(r).toMatchObject({ failingIds: [], collectionError: true, complete: true, total: 0 });
  });

  it("pass and none", async () => {
    expect(await read(wspec(), { [at]: report("jest-pass.json", "C:\\root") }, 0, W)).toMatchObject({ failingIds: [], total: 1, complete: true });
    expect(await read(wspec(), { [at]: report("jest-none.json", "C:\\root") }, 0, W)).toMatchObject({ failingIds: [], total: 0, complete: true });
  });

  it("the tmpdir check is case-insensitive on win32", async () => {
    const lower = `c:\\temp\\omr-verify-${UUID}.json`;
    const r = await read(wspec({ reportPath: lower }), { [lower]: report("jest-pass.json", "C:\\root") }, 0, W);
    expect(r.source).toBe("report");
    expect(r.fs.unlinked).toEqual([lower]);
  });
});

describe("readResult: fallback to text", () => {
  it("truncated JSON falls back to observeTests: incomplete, collection error on non-zero exit", async () => {
    const full = report("vitest-fail.json", "/root");
    const r = await read(mkSpec(), { [RPT_JSON]: full.slice(0, 200) }, 1, POSIX_HOST, "FAIL test/str.test.js > str > bad\n");
    expect(r).toMatchObject({
      failingIds: ["test/str.test.js > str > bad"],
      failingFiles: ["/root/vitest-proj/test/str.test.js"],
      total: undefined,
      complete: false,
      collectionError: true,
      source: "text",
      note: "runner exited 1 without a usable report",
    });
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("vitest syntax error: exit 1 and no report is never a pass", async () => {
    const r = await read(mkSpec(), {}, 1);
    expect(r).toMatchObject({ failingIds: [], collectionError: true, complete: false, source: "text" });
    expect(r.fs.unlinked).toEqual([RPT_JSON]);
  });

  it("exit 0 without a report is noted and incomplete", async () => {
    const r = await read(mkSpec(), {}, 0);
    expect(r).toMatchObject({ collectionError: false, complete: false, note: "runner exited 0 without writing its report" });
  });

  it("a JSON value without testResults is unusable", async () => {
    expect((await read(mkSpec(), { [RPT_JSON]: "[]" }, 1)).source).toBe("text");
    expect((await read(mkSpec(), { [RPT_JSON]: "{}" }, 1)).source).toBe("text");
  });

  it("pytest FAILED lines map files; ids without a separator have no file", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p" });
    const r = await read(sp, {}, 1, POSIX_HOST, "FAILED tests/test_a.py::test_x - boom\n--- FAIL: TestGo (0.01s)\n");
    expect(r.failingIds).toEqual(["TestGo", "tests/test_a.py::test_x"]);
    expect(r.failingFiles).toEqual(["/root/p/tests/test_a.py"]);
  });

  it("a report already deleted (unlink rejects) still yields a result", async () => {
    const fs = resultFs({}, true);
    const r = await readResult(mkSpec(), exec(1), fs, POSIX_HOST);
    expect(r.source).toBe("text");
    expect(fs.unlinked).toEqual([RPT_JSON]);
  });
});

describe("readResult: N.4 report path guard", () => {
  for (const bad of ["/etc/passwd", "/tmp/evil.json", `/tmp/sub/omr-verify-${UUID}.json`, `/r/omr-verify-${UUID}.json`, `/tmp/omr-verify-${UUID}.txt`]) {
    it(`never reads or deletes ${bad}`, async () => {
      const fs = resultFs({ [bad]: report("vitest-pass.json", "/root") });
      const r = await readResult(mkSpec({ reportPath: bad }), exec(0), fs, POSIX_HOST);
      expect(fs.unlinked).toEqual([]);
      expect(fs.reads).toEqual([]);
      expect(r).toMatchObject({ source: "text", complete: false, note: `report path rejected: ${bad}` });
    });
  }

  it("uses the process tmpdir by default", async () => {
    const p = path.join(tmpdir(), `omr-verify-${UUID}.json`);
    const fs = resultFs({ [p]: report("vitest-pass.json", "/root") });
    await readResult(mkSpec({ reportPath: p, cwd: "/root/vitest-proj" }), exec(0), fs);
    expect(fs.unlinked).toEqual([p]);
  });
});

describe("readResult: pytest junit", () => {
  const inputs = ["/root/pytest-proj/tests/test_math.py", "/root/pytest-proj/tests/test_str.py", "/root/pytest-proj/tests/test_broken.py"];
  const pspec = (over: Partial<ScopedSpec> = {}) =>
    mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/pytest-proj", gitRoot: "/root", inputs, inputsAreTests: true, ...over });

  it("classname maps to the file via the longest module suffix", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-fail.xml", "/root") }, 1);
    expect(r.failingIds).toEqual(["tests/test_str.py::TestStr::test_bad"]);
    expect(r.failingFiles).toEqual(["/root/pytest-proj/tests/test_str.py"]);
    expect(r).toMatchObject({ total: 3, complete: true, collectionError: false, source: "report" });
    expect(r.fs.unlinked).toEqual([RPT_XML]);
  });

  it("xdist report (ANSI escapes, reordered cases) gives the same ids", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-xdist-fail.xml", "/root") }, 1);
    expect(r.failingIds).toEqual(["tests/test_str.py::TestStr::test_bad"]);
    expect(r.total).toBe(3);
  });

  it("collection <error> is a bare file id, not counted in total (exit 2)", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-collect-error.xml", "/root") }, 2);
    expect(r.failingIds).toEqual(["tests/test_broken.py"]);
    expect(r).toMatchObject({ collectionError: true, total: 0, complete: true });
  });

  it("exit 5: nothing collected from test-file inputs is incomplete (QA-1.3-19); pass is complete", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({
      failingIds: [],
      total: 0,
      complete: false,
      note: "pytest ran no tests although a test file was passed",
    });
    expect(await read(pspec(), { [RPT_XML]: report("pytest-pass.xml", "/root") }, 0)).toMatchObject({ failingIds: [], total: 1, complete: true });
  });

  it("exit 4 and 3 are incomplete with their notes", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-missing.xml", "/root") }, 4)).toMatchObject({ complete: false, note: "pytest usage error (exit 4)" });
    expect(await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 3)).toMatchObject({ complete: false, note: "pytest internal error (exit 3)" });
  });

  it("exit 1 with no failure in the report is incomplete", async () => {
    expect(await read(pspec(), { [RPT_XML]: report("pytest-pass.xml", "/root") }, 1)).toMatchObject({ complete: false, note: "runner exited 1 but its report lists no failure" });
  });

  it("unmapped classnames keep a raw id and make the result incomplete", async () => {
    const r = await read(pspec({ inputs: [] }), { [RPT_XML]: report("pytest-fail.xml", "/root") }, 1);
    expect(r).toMatchObject({ failingIds: ["tests.test_str.TestStr::test_bad"], failingFiles: [], complete: false, note: "pytest classname not mapped to a test file: tests.test_str.TestStr" });
    const c = await read(pspec({ inputs: [] }), { [RPT_XML]: report("pytest-collect-error.xml", "/root") }, 2);
    expect(c).toMatchObject({ failingIds: ["tests.test_broken"], collectionError: true, complete: false });
  });

  it("setup <error> is a failure; entities decode; <skipped> is not a failure; truncated XML falls back", async () => {
    const xml =
      '<?xml version="1.0"?><testsuites><testsuite>' +
      '<testcase classname="tests.test_math" name="test_p[a&amp;b&#65;&#x42;&lt;&gt;&quot;&apos;]"><error message="fixture failed">x</error></testcase>' +
      '<testcase classname="tests.test_math" name="test_s"><skipped message="s"/></testcase>' +
      "<testcase /></testsuite></testsuites>";
    const r = await read(pspec(), { [RPT_XML]: xml }, 1);
    // The attribute-less <testcase /> is a passing case (QA-1.3-22: classname "" alone is not a collection error).
    expect(r.failingIds).toEqual(["tests/test_math.py::test_p[a&bAB<>\"']"]);
    expect(r).toMatchObject({ total: 3, collectionError: false, complete: true });
    const t = await read(pspec(), { [RPT_XML]: report("pytest-fail.xml", "/root").slice(0, 300) }, 1);
    expect(t.source).toBe("text");
  });
});

describe("readResult: per-file test counts (Phase 2.2 P1)", () => {
  const sum = (c: Readonly<Record<string, number>> | undefined) => Object.values(c ?? {}).reduce((a, b) => a + b, 0);
  const pyInputs = ["/root/pytest-proj/tests/test_math.py", "/root/pytest-proj/tests/test_str.py", "/root/pytest-proj/tests/test_broken.py"];
  const pspec = (over: Partial<ScopedSpec> = {}) =>
    mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/pytest-proj", gitRoot: "/root", inputs: pyInputs, inputsAreTests: true, ...over });

  for (const [name, code] of [["vitest-fail.json", 1], ["vitest-pass.json", 0], ["vitest-none.json", 0], ["vitest-collect-error.json", 1]] as const) {
    it(`vitest ${name}: keys are cwd-relative and the counts sum to total`, async () => {
      const r = await read(mkSpec(), { [RPT_JSON]: report(name, "/root") }, code);
      expect(r.testsByFile).toBeDefined();
      expect(sum(r.testsByFile)).toBe(r.total);
      for (const k of Object.keys(r.testsByFile ?? {})) expect(k.startsWith("/") || k.includes("\\")).toBe(false);
    });
  }

  it("vitest: the failing file's key is the prefix of its failing ids", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-fail.json", "/root") }, 1);
    expect(r.testsByFile?.["test/str.test.js"]).toBeGreaterThan(0);
  });

  it("an import-time throw counts 0 tests for its file", async () => {
    const r = await read(mkSpec(), { [RPT_JSON]: report("vitest-collect-error.json", "/root") }, 1);
    expect(r.testsByFile?.["test/throws.test.js"]).toBe(0);
  });

  for (const [name, code] of [["jest-fail.json", 1], ["jest-pass.json", 0], ["jest-none.json", 0]] as const) {
    it(`jest ${name} (win32 names): "/" keys that sum to total`, async () => {
      const at = `C:\\Temp\\omr-verify-${UUID}.json`;
      const sp = mkSpec({ runner: "jest", cwd: "C:\\root\\jest-proj", gitRoot: "C:\\root", reportPath: at });
      const r = await read(sp, { [at]: report(name, "C:\\root") }, code, { ...WIN_HOST });
      expect(sum(r.testsByFile)).toBe(r.total);
      for (const k of Object.keys(r.testsByFile ?? {})) expect(k.includes("\\") || /^[A-Za-z]:/.test(k)).toBe(false);
    });
  }

  it("jest-fail: the failing file is keyed like its ids", async () => {
    const at = `C:\\Temp\\omr-verify-${UUID}.json`;
    const sp = mkSpec({ runner: "jest", cwd: "C:\\root\\jest-proj", gitRoot: "C:\\root", reportPath: at });
    const r = await read(sp, { [at]: report("jest-fail.json", "C:\\root") }, 1, { ...WIN_HOST });
    expect(r.testsByFile?.["test/str.test.js"]).toBeGreaterThan(0);
  });

  for (const [name, code] of [["pytest-fail.xml", 1], ["pytest-xdist-fail.xml", 1], ["pytest-pass.xml", 0], ["pytest-none.xml", 5]] as const) {
    it(`pytest ${name}: counts per mapped input sum to total`, async () => {
      const r = await read(pspec(), { [RPT_XML]: report(name, "/root") }, code);
      expect(r.testsByFile).toBeDefined();
      expect(sum(r.testsByFile)).toBe(r.total);
    });
  }

  it("pytest: the failing file's key matches its ids", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-fail.xml", "/root") }, 1);
    expect(r.testsByFile?.["tests/test_str.py"]).toBeGreaterThan(0);
  });

  it("pytest: collection pseudo-cases are not counted", async () => {
    const r = await read(pspec(), { [RPT_XML]: report("pytest-collect-error.xml", "/root") }, 2);
    expect(r.total).toBe(0);
    expect(r.testsByFile).toEqual({});
  });

  it("pytest: entity-encoded classnames map; unmapped cases are not counted", async () => {
    const xml =
      '<?xml version="1.0"?><testsuites><testsuite>' +
      '<testcase classname="tests.test_math" name="a"/>' +
      '<testcase name="b" classname="tests.test_math"></testcase>' +
      '<testcase classname="tests.test_&#115;tr.TestStr" name="c"/>' +
      '<testcase classname="elsewhere.mod" name="d"/>' +
      "</testsuite></testsuites>";
    const r = await read(pspec(), { [RPT_XML]: xml }, 0);
    expect(r.total).toBe(4);
    expect(r.testsByFile).toEqual({ "tests/test_math.py": 2, "tests/test_str.py": 1 });
  });

  it("the zero-test guard keeps the counts; the text fallback has none", async () => {
    const none = await read(pspec(), { [RPT_XML]: report("pytest-none.xml", "/root") }, 5);
    expect(none.complete).toBe(false);
    expect(none.testsByFile).toEqual({});
    const text = await read(mkSpec(), {}, 1);
    expect(text.source).toBe("text");
    expect(text.testsByFile).toBeUndefined();
    const truncated = await read(mkSpec(), { [RPT_JSON]: report("vitest-fail.json", "/root").slice(0, 200) }, 1);
    expect(truncated.testsByFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// planRerun (1.3.2.e)
// ---------------------------------------------------------------------------------------------

describe("planRerun", () => {
  const budget = { maxWorkers: 2 };
  const host = { ...POSIX_HOST, pathEnv: "/usr/bin" };
  const VITEST_ENTRY = "/r/node_modules/vitest/vitest.mjs";

  it("vitest: run exactly the existing files, never a --, workers capped", async () => {
    const files = jsRepo({}, { "/r/test/a.test.ts": "", "/r/test/b.test.ts": "" });
    const det = await detect("vitest run --maxWorkers=8 --silent", files);
    const r = spec(
      await planRerun(det, ["/r/test/b.test.ts", "/r/test/a.test.ts", "/r/test/gone.test.ts", "rel.test.ts", "/elsewhere/x.test.ts", "/r/test/a.test.ts"], "/r", budget, {
        fs: memFs(files),
        host,
      }),
    );
    expect(r.args).toEqual([
      VITEST_ENTRY, "run", "/r/test/a.test.ts", "/r/test/b.test.ts", "--silent", "--passWithNoTests", "--maxWorkers=2",
      "--coverage.enabled=false", "--reporter=json", `--outputFile=${RPT_JSON}`,
    ]);
    expect(r.args).not.toContain("--");
    expect(r).toMatchObject({ mode: "rerun", inputsAreTests: true, workers: 2, cwd: "/r", gitRoot: "/r", file: "/usr/bin/node", entry: VITEST_ENTRY });
    expect(r.notes).toEqual([
      "rerun file missing in this tree: test/gone.test.ts",
      "rerun file dropped (relative or outside the git root): rel.test.ts",
      "rerun file dropped (relative or outside the git root): /elsewhere/x.test.ts",
    ]);
  });

  it("jest: --runTestsByPath with -- before the files", async () => {
    const files = jsRepo({}, { "/r/test/a.test.js": "" });
    const det = await detect("jest -i", files);
    const r = spec(await planRerun(det, ["/r/test/a.test.js"], "/r", budget, { fs: memFs(files), host, cores: 4 }));
    expect(r.args).toEqual([
      "/r/node_modules/jest/bin/jest.js", "--runTestsByPath", "--passWithNoTests", "--maxWorkers=1", "--coverage=false", "--json",
      `--outputFile=${RPT_JSON}`, "--", "/r/test/a.test.js",
    ]);
  });

  it("pytest: same argv as scoped, -- before the files", async () => {
    const files = pyRepo({ "/r/tests/test_a.py": "" });
    const det = await detect("pytest", files, host);
    const r = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r", budget, { fs: memFs(files), host }));
    expect(r.file).toBe("/usr/bin/pytest");
    expect(r.args).toEqual(["-q", "-p", "no:cacheprovider", `--junitxml=${RPT_XML}`, "--maxfail=0", "--rootdir=/r", "--", "/r/tests/test_a.py"]);
    expect(r.workers).toBeNull();
  });

  it("reference worktree: the current tree's entry is reused, ids stay cwd-relative", async () => {
    const cur = jsRepo();
    const det = await detect("vitest", cur);
    const entry = await resolveEntry(det, "/r", memFs(cur), host);
    if (isUnverifiable(entry)) throw new Error(entry.reason);
    const refFiles = { "/ref/.git": "", "/ref/test/a.test.ts": "" };
    const withEntry = spec(await planRerun(det, ["/ref/test/a.test.ts"], "/ref", budget, { fs: memFs(refFiles), host, entry }));
    expect(withEntry).toMatchObject({ cwd: "/ref", gitRoot: "/ref", entry: VITEST_ENTRY, inputs: ["/ref/test/a.test.ts"] });
    expectS6(await planRerun(det, ["/ref/test/a.test.ts"], "/ref", budget, { fs: memFs(refFiles), host }), "runner-not-installed");
  });

  it("nothing left -> NoAffected; no git root and tmpdir-in-repo -> S6", async () => {
    const det = await detect("vitest");
    expect(await planRerun(det, ["/r/test/gone.test.ts"], "/r", budget, { fs: memFs(jsRepo()), host })).toEqual({
      noAffected: true,
      note: "no rerun: none of the test files exist in this tree",
    });
    expectS6(await planRerun(det, ["/x/a.test.ts"], "/x", budget, { fs: memFs({ "/x/a.test.ts": "" }), host }), "no-git-root");
    const files = jsRepo({}, { "/r/a.test.ts": "" });
    expectS6(await planRerun(det, ["/r/a.test.ts"], "/r", budget, { fs: memFs(files), host: { ...host, tmpdir: "/r/tmp" } }), "tmpdir-in-repo");
  });

  it("entry notes (pytest venv) are carried", async () => {
    const files = { "/r/.git": "", "/r/.venv/bin/pytest": "", "/r/tests/test_a.py": "" };
    const det = await detect("pytest", files, POSIX_HOST);
    const r = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r", budget, { fs: memFs(files), host: POSIX_HOST }));
    expect(r.notes).toEqual(["pytest resolved from /r/.venv/bin/pytest"]);
  });
});

// ---------------------------------------------------------------------------------------------
// K. planScopedLint (1.3.2.g)
// ---------------------------------------------------------------------------------------------

const ESLINT_ENTRY = "/r/node_modules/eslint/bin/eslint.js";
function lintRepo(version = "9.1.0", scripts: Record<string, string> = {}, extra: Record<string, string> = {}): Record<string, string> {
  return jsRepo(scripts, {
    "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", version, bin: { eslint: "./bin/eslint.js" } }),
    [ESLINT_ENTRY]: "",
    "/r/src/a.ts": "",
    "/r/src/b.vue": "",
    "/r/lib/c.js": "",
    "/r/README.md": "",
    ...extra,
  });
}

async function lint(command: string, changedFiles: ChangedPath[] | "unavailable", files = lintRepo(), host: Partial<RunnerHost> = POSIX_HOST) {
  const { search: _s, ...rest } = input({ command, changedFiles, files, win: host.platform === "win32" });
  return planScopedLint({ ...rest, host });
}

function lintSpec(x: object): LintSpec {
  expect(isUnscoped(x) || isNoAffected(x), JSON.stringify(x)).toBe(false);
  return x as LintSpec;
}

function expectUnscoped(x: object, reason: string): void {
  expect(x).toEqual({ unscoped: true, reason });
}

describe("planScopedLint", () => {
  it("plain eslint v9: every existing changed file, absolute, with --no-warn-ignored (QA-1.3-9)", async () => {
    const r = lintSpec(await lint("eslint --fix --cache .", changed("src/a.ts", "README.md", "src/b.vue", "src/gone.ts", "../out.ts")));
    const all = ["/r/README.md", "/r/src/a.ts", "/r/src/b.vue"];
    expect(r.args).toEqual([ESLINT_ENTRY, "--cache", "--no-warn-ignored", ...all]);
    expect(r).toMatchObject({ runner: "eslint", file: "/usr/bin/node", cwd: "/r", gitRoot: "/r", entry: ESLINT_ENTRY, inputs: all, workers: null });
    expect(r.notes).toEqual(["dropped outside the git root: ../out.ts"]);
  });

  it("npm run lint script: --ext, path scopes and --concurrency capped", async () => {
    const files = lintRepo("9.1.0", { lint: "eslint --ext .vue,ts --concurrency 4 src" });
    const r = lintSpec(await lint("npm run lint", changed("src/a.ts", "src/b.vue", "lib/c.js"), files));
    expect(r.args).toEqual([ESLINT_ENTRY, "--ext", ".vue,ts", "--concurrency=2", "--no-warn-ignored", "/r/src/a.ts", "/r/src/b.vue"]);
    expect(r.workers).toBe(2);
  });

  it("--ext= form, --concurrency off kept, --concurrency=auto", async () => {
    const a = lintSpec(await lint("eslint --ext=vue --concurrency off", changed("src/a.ts", "src/b.vue")));
    expect(a.args).toEqual([ESLINT_ENTRY, "--ext=vue", "--concurrency", "off", "--no-warn-ignored", "/r/src/a.ts", "/r/src/b.vue"]);
    expect(a.workers).toBeNull();
    expect(lintSpec(await lint("npx eslint --concurrency=auto", changed("src/a.ts"))).args).toContain("--concurrency=2");
  });

  it("eslint < 9: extension filter, no --no-warn-ignored; --max-warnings -> Unscoped", async () => {
    const r = lintSpec(await lint("pnpm exec eslint", changed("src/a.ts", "src/b.vue", "README.md"), lintRepo("8.57.0")));
    expect(r.args).toEqual([ESLINT_ENTRY, "/r/src/a.ts"]);
    expect(await lint("eslint", changed("README.md", "src/b.vue"), lintRepo("8.57.0"))).toEqual({ noAffected: true, note: "no changed lintable files" });
    expect(lintSpec(await lint("eslint --ext .vue", changed("src/a.ts", "src/b.vue"), lintRepo("8.57.0"))).inputs).toEqual(["/r/src/b.vue"]);
    expectUnscoped(await lint("eslint --max-warnings 0", changed("src/a.ts"), lintRepo("8.57.0")), "eslint <9 cannot scope ignored files under --max-warnings");
    expectUnscoped(await lint("eslint --max-warnings=0", changed("src/a.ts"), lintRepo("8.57.0")), "eslint <9 cannot scope ignored files under --max-warnings");
  });

  it("composites and unsupported commands -> Unscoped with the B/C reason", async () => {
    expectUnscoped(await lint("npm run lint", changed("src/a.ts"), lintRepo("9.1.0", { lint: "tsc && eslint ." })), 'composite scripts.lint: "&&"');
    expectUnscoped(await lint("next lint", changed("src/a.ts")), 'unsupported command "next" in command');
    expectUnscoped(await lint("vitest", changed("src/a.ts")), 'unsupported command "vitest" in command');
    expectUnscoped(await lint("pytest", changed("src/a.ts")), 'unsupported command "pytest" in command');
    expectUnscoped(await lint("uv run pytest", changed("src/a.ts")), 'unsupported command "uv run pytest" in command');
    expectUnscoped(await lint("npx vitest", changed("src/a.ts")), 'unsupported command "npx vitest" in command');
    expectUnscoped(await lint("eslint --init", changed("src/a.ts")), 'unsupported eslint argument "--init" in command');
    expectUnscoped(await lint("eslint src/**", changed("src/a.ts")), 'eslint glob pattern in command: "src/**"');
    expectUnscoped(await lint("eslint ../elsewhere", changed("src/a.ts")), 'unsupported eslint argument "../elsewhere" in command');
  });

  it("unavailable, empty, config changes, nothing lintable, not installed", async () => {
    expectUnscoped(await lint("eslint", "unavailable"), "change attribution unavailable");
    expect(await lint("eslint", [])).toEqual({ noAffected: true, note: "no changed lintable files" });
    expectUnscoped(await lint("eslint", changed("src/a.ts", "eslint.config.js")), "eslint config changed: eslint.config.js");
    expectUnscoped(await lint("eslint", changed("pkg/.eslintrc.json")), "eslint config changed: pkg/.eslintrc.json");
    expect(await lint("eslint src", changed("README.md", "lib/c.js"))).toEqual({ noAffected: true, note: "no changed lintable files" });
    expectUnscoped(await lint("eslint", changed("src/a.ts"), jsRepo({}, { "/r/src/a.ts": "" })), "runner not installed: eslint");
  });

  it("win32: config trigger match is case-insensitive", async () => {
    const files = Object.fromEntries(Object.entries(lintRepo()).map(([k, v]) => [`C:${k.replace(/\//g, "\\")}`, v]));
    const host = { ...WIN_HOST };
    const { search: _s, ...rest } = input({ command: "eslint", changedFiles: changed("ESLint.Config.JS"), files, win: true, cwd: "C:\\r" });
    expectUnscoped(await planScopedLint({ ...rest, host }), "eslint config changed: ESLint.Config.JS");
    const ok = await planScopedLint({ ...rest, changedFiles: changed("src\\A.TS"), host });
    expect(lintSpec(ok).inputs).toEqual(["C:\\r\\src\\A.TS"]);
  });

  it("too many files -> Unscoped", async () => {
    const extra: Record<string, string> = {};
    const names: string[] = [];
    for (let i = 0; i < 300; i++) {
      const n = `src/${"x".repeat(120)}${i}.ts`;
      extra[`/r/${n}`] = "";
      names.push(n);
    }
    expectUnscoped(await lint("eslint", changed(...names), lintRepo("9.1.0", {}, extra)), "too many inputs for one command line: 300 files");
  });
});

// ---------------------------------------------------------------------------------------------
// QA round 1 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-1..15)
// ---------------------------------------------------------------------------------------------

/**
 * memFs plus a native-like realpath: `aliases` maps an alias prefix (an 8.3 name, a junction, a
 * symlink) to its target. Directories exist when a file lies below them. On win32 the realpath
 * result carries a \\?\ prefix, which the planner must strip.
 */
function aliasFs(files: Record<string, string>, win: boolean, aliases: Record<string, string>): PlannerFs {
  const P = win ? path.win32 : path.posix;
  const k = (p: string) => (win ? p.toLowerCase() : p);
  const known = new Map(Object.entries(files).map(([p, c]) => [k(P.normalize(p)), c]));
  const real = (p: string) => {
    const q = P.normalize(p);
    for (const [from, to] of Object.entries(aliases)) {
      if (k(q) === k(from) || k(q).startsWith(k(from) + P.sep)) return to + q.slice(from.length);
    }
    return q;
  };
  const exists = (p: string) => known.has(k(p)) || [...known.keys()].some((f) => f.startsWith(k(p) + P.sep));
  return {
    fileExists: async (p) => exists(real(p)),
    readFile: async (p) => {
      const v = known.get(k(real(p)));
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    realpath: async (p) => {
      const r = real(p);
      if (!exists(r)) throw new Error(`ENOENT ${p}`);
      return win ? `\\\\?\\${r}` : r;
    },
  };
}

function jsonReport(numTotalTests: number): string {
  return JSON.stringify({ numTotalTests, numRuntimeErrorTestSuites: 0, testResults: [] });
}

describe("QA-1.3-1: canonical paths through the realpath seam", () => {
  const REAL = "/real/r";
  const files = jsRepo({}, { [`${REAL}/src/a.js`]: "", [`${REAL}/test/a.test.js`]: "" }, REAL);

  it("a symlinked or junction cwd plans on the real paths, so jest's realpath'd rootDir matches", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const d = (await detectRunner("jest", "/link", fs, POSIX_HOST)) as DetectedRunner;
    expect(d).toMatchObject({ gitRoot: REAL, runnerCwd: REAL });
    const s = spec(await planScopedRun(input({ command: "jest", cwd: "/link", fs, changedFiles: changed("/link/src/a.js", "test/a.test.js") })));
    expect(s).toMatchObject({ cwd: REAL, gitRoot: REAL, inputs: [`${REAL}/src/a.js`, `${REAL}/test/a.test.js`] });
    expect(s.lexicalPaths).toBeUndefined();
    expect(s.args.slice(-3)).toEqual(["--", `${REAL}/src/a.js`, `${REAL}/test/a.test.js`]);
  });

  it("win32 8.3 short names and \\\\?\\ results canonicalize to the long spelling", async () => {
    const LONG = "C:\\Users\\Marquinho\\p";
    const w = {
      [`${LONG}\\.git`]: "",
      [`${LONG}\\node_modules\\jest\\package.json`]: JEST_PKG,
      [`${LONG}\\node_modules\\jest\\bin\\jest.js`]: "",
      [`${LONG}\\src\\a.js`]: "",
    };
    const fs = aliasFs(w, true, { "C:\\Users\\MARQUI~1": "C:\\Users\\Marquinho" });
    const s = spec(await planScopedRun(input({ win: true, command: "jest", cwd: "C:\\Users\\MARQUI~1\\p", fs, changedFiles: changed("src\\a.js") })));
    expect(s).toMatchObject({ cwd: LONG, gitRoot: LONG, inputs: [`${LONG}\\src\\a.js`] });
  });

  it("a deleted file keeps its lexical tail below the nearest real ancestor", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const search = stubSearch({ gone: [`${REAL}/test/a.test.js`] });
    const s = spec(await planScopedRun(input({ command: "jest", cwd: "/link", fs, search, changedFiles: changed("/link/src/deep/gone.js") })));
    expect(s.inputs).toEqual([`${REAL}/test/a.test.js`]);
  });

  it("a path whose every ancestor is missing stays lexical", async () => {
    const fs = aliasFs({}, false, {});
    expectS6(await detectRunner("jest", "/nowhere", fs, POSIX_HOST), "no-git-root", "no git repository at or above /nowhere");
  });

  it("planRerun canonicalizes cwd and test files", async () => {
    const fs = aliasFs(files, false, { "/link": REAL });
    const det = await detect("jest", files, POSIX_HOST, REAL);
    const r = spec(await planRerun(det, ["/link/test/a.test.js"], "/link", { maxWorkers: 2 }, { fs, host: POSIX_HOST }));
    expect(r).toMatchObject({ cwd: REAL, gitRoot: REAL, inputs: [`${REAL}/test/a.test.js`] });
  });

  it("without realpath the spec is marked lexical", async () => {
    const s = spec(await planScopedRun(input({ command: "jest", files, cwd: REAL, changedFiles: changed("src/a.js") })));
    expect(s.lexicalPaths).toBe(true);
    const r = spec(await planRerun(await detect("jest", files, POSIX_HOST, REAL), [`${REAL}/test/a.test.js`], REAL, { maxWorkers: 2 }, { fs: memFs(files), host: POSIX_HOST }));
    expect(r.lexicalPaths).toBe(true);
  });

  describe("readResult: a total of 0 is never a vacuous pass", () => {
    const at = RPT_JSON;
    const run = (over: Partial<ScopedSpec>, total = 0, code = 0) => read(mkSpec({ runner: "jest", ...over }), { [at]: jsonReport(total) }, code);

    it.each<[string, Partial<ScopedSpec>, string]>([
      ["rerun", { mode: "rerun", inputs: ["/root/vitest-proj/test/a.test.js"], inputsAreTests: true }, "rerun ran no tests although every input is a test file"],
      ["rerun (vitest)", { runner: "vitest", mode: "rerun", inputs: ["/root/vitest-proj/test/a.test.js"] }, "rerun ran no tests although every input is a test file"],
      ["jest related given a test file", { inputs: ["/root/vitest-proj/src/a.js", "/root/vitest-proj/test/a.test.js"] }, "jest ran no tests although a test file was passed"],
      ["jest related given a __tests__ file", { inputs: ["/root/vitest-proj/src/__tests__/a.js"] }, "jest ran no tests although a test file was passed"],
      ["jest planned without realpath", { inputs: ["/root/vitest-proj/src/a.js"], lexicalPaths: true }, "jest ran no tests and the paths were not canonicalized (no realpath seam)"],
    ])("%s -> complete false", async (_name, over, note) => {
      expect(await run(over)).toMatchObject({ total: 0, complete: false, note });
    });

    it("related over sources only with canonical paths: 0 stays a complete result (jest and vitest)", async () => {
      expect(await run({ inputs: ["/root/vitest-proj/src/a.js"] })).toMatchObject({ total: 0, complete: true });
      expect(await run({ runner: "vitest", inputs: ["/root/vitest-proj/src/a.js"] })).toMatchObject({ total: 0, complete: true });
    });

    it("the guard never touches a run with tests, failures or a collection error", async () => {
      expect(await run({ mode: "rerun" }, 2)).toMatchObject({ total: 2, complete: true });
      const withError = JSON.stringify({ numTotalTests: 0, numRuntimeErrorTestSuites: 1, testResults: [] });
      expect(await read(mkSpec({ runner: "jest", mode: "rerun" }), { [at]: withError }, 1)).toMatchObject({ complete: true, collectionError: true });
      const failed = JSON.stringify({ numTotalTests: 0, testResults: [{ name: "/root/vitest-proj/a.test.js", status: "failed", assertionResults: [] }] });
      expect(await read(mkSpec({ runner: "jest", mode: "rerun" }), { [at]: failed }, 1)).toMatchObject({ complete: true, failingIds: ["a.test.js"] });
    });

    it("pytest rerun with exit 5 (nothing collected) is incomplete", async () => {
      const sp = mkSpec({ runner: "pytest", mode: "rerun", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"] });
      expect(await read(sp, { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({ total: 0, complete: false });
    });
  });

  describe("real filesystem: a junction (win32) or symlink to the repo", () => {
    const base = mkdtempSync(path.join(tmpdir(), "omr-qa131-"));
    afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const repo = path.join(base, "repo");
    for (const [rel, body] of Object.entries({
      ".git": "gitdir: elsewhere",
      "package.json": JSON.stringify({ name: "x", scripts: { test: "jest" } }),
      "node_modules/jest/package.json": JEST_PKG,
      "node_modules/jest/bin/jest.js": "",
      "src/str.js": "",
    })) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), body);
    }
    const link = path.join(base, "link");
    symlinkSync(repo, link, "junction");
    const realFs: PlannerFs = {
      fileExists: async (p) => existsSync(p),
      readFile: async (p) => readFileSync(p, "utf8"),
      realpath: (p) => fsRealpath(p),
    };

    it("plans with the native realpath, whatever spelling tmpdir() and the link use", async () => {
      const canonical = realpathSync.native(repo);
      const host = { ...POSIX_HOST, platform: process.platform, tmpdir: path.parse(base).root + "omr-no-such-tmp" };
      const s = spec(
        await planScopedRun({ command: "npm test", cwd: link, changedFiles: changed(path.join(link, "src", "str.js")), budget: { maxWorkers: 2 }, fs: realFs, search: stubSearch(), host }),
      );
      expect(s.cwd).toBe(canonical);
      expect(s.gitRoot).toBe(canonical);
      expect(s.inputs).toEqual([path.join(canonical, "src", "str.js")]);
      expect(s.lexicalPaths).toBeUndefined();
    });
  });
});

describe("QA-1.3-7: win32 path spellings and fully dropped change sets", () => {
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
    "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
    "C:\\repo\\src\\a.ts": "",
  };

  it.each(["\\\\?\\C:\\repo\\vitest.config.mjs", "\\\\.\\C:\\repo\\vitest.config.mjs", "//?/C:/repo/vitest.config.mjs"])("%s is a config trigger", async (p) => {
    expectS6(await planScopedRun(input({ win: true, files: W, cwd: "C:\\repo", changedFiles: changed(p) })), "config-changed", "config file changed: vitest.config.mjs");
  });

  it("\\\\?\\UNC\\ becomes \\\\server\\share", async () => {
    const u = { "\\\\srv\\share\\repo\\.git": "", "\\\\srv\\share\\repo\\conftest.py": "" };
    const r = await planScopedRun(input({ win: true, command: "pytest", files: u, cwd: "\\\\srv\\share\\repo", changedFiles: changed("\\\\?\\UNC\\srv\\share\\repo\\conftest.py") }));
    expectS6(r, "config-changed", "config file changed: conftest.py");
  });

  it("a symlink named like a trigger is a trigger even when its target is not", async () => {
    const fs = aliasFs(jsRepo({}, { "/r/cfg/base.ts": "" }), false, { "/r/vitest.config.ts": "/r/cfg/base.ts" });
    expectS6(await planScopedRun(input({ fs, changedFiles: changed("vitest.config.ts") })), "config-changed", "config file changed: cfg/base.ts");
  });

  it("the prefix is only stripped on win32", async () => {
    const r = await planScopedRun(input({ changedFiles: changed("//?/r/vitest.config.ts") }));
    expectS6(r, "attribution-unavailable");
  });

  it("static scoping and lint: every path outside -> S6 / Unscoped", async () => {
    const { search: _s, ...rest } = input({ changedFiles: changed("/elsewhere/a.ts") });
    expectS6(await planStaticScoping(rest), "attribution-unavailable", "change attribution unavailable: no changed path lies inside the git root");
    expectUnscoped(await lint("eslint", changed("/elsewhere/a.ts")), "change attribution unavailable: no changed path lies inside the git root");
  });
});

describe("QA-1.3-11: the tmpdir must be absolute and outside the repo", () => {
  const files = jsRepo({}, { "/r/src/a.ts": "", "/r/test/a.test.ts": "", "/r/tmp/keep": "" });

  it("a relative tmpdir -> S6 tmpdir-in-repo (scoped, static, rerun)", async () => {
    const host = { ...POSIX_HOST, tmpdir: "tmp" };
    const why = "temp dir is not an absolute path: tmp";
    expectS6(await planScopedRun(input({ files, host, changedFiles: changed("src/a.ts") })), "tmpdir-in-repo", why);
    const { search: _s, ...rest } = input({ files, host, changedFiles: changed("src/a.ts") });
    expectS6(await planStaticScoping(rest), "tmpdir-in-repo", why);
    expectS6(await planRerun(await detect("vitest", files), ["/r/test/a.test.ts"], "/r", { maxWorkers: 2 }, { fs: memFs(files), host }), "tmpdir-in-repo", why);
  });

  it("a tmpdir that is a link into the repo -> S6", async () => {
    const fs = aliasFs(files, false, { "/tmpx": "/r/tmp" });
    const host = { ...POSIX_HOST, tmpdir: "/tmpx" };
    expectS6(await planScopedRun(input({ fs, host, changedFiles: changed("src/a.ts") })), "tmpdir-in-repo", "temp dir is inside the repository: /tmpx");
  });

  it("readResult never touches a report when the tmpdir or the report path is relative", async () => {
    for (const [tmp, rp] of [["tmp", `tmp/omr-verify-${UUID}.json`], ["/tmp", `omr-verify-${UUID}.json`]]) {
      const fs = resultFs({ [rp]: jsonReport(1) });
      const r = await readResult(mkSpec({ reportPath: rp }), exec(0), fs, { ...POSIX_HOST, tmpdir: tmp });
      expect(r).toMatchObject({ source: "text", complete: false, note: `report path rejected: ${rp}` });
      expect(fs.reads).toEqual([]);
      expect(fs.unlinked).toEqual([]);
    }
  });
});

describe("QA-1.3-12: malformed junit never rejects", () => {
  const pspec = () => mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs: ["/root/p/tests/test_math.py"], inputsAreTests: true });
  const xml = (name: string) =>
    `<?xml version="1.0"?><testsuites><testsuite><testcase classname="tests.test_math" name="${name}"><failure/></testcase></testsuite></testsuites>`;

  it.each([
    ["&#x110000;", "&#x110000;"],
    ["&#1114112;", "&#1114112;"],
    ["&#xD800;", "&#xD800;"],
    ["&#99999999999999999999999;", "&#99999999999999999999999;"],
    ["&#x10FFFF;&#xE000;&#55295;", "\u{10FFFF}\uE000\uD7FF"],
  ])("%s decodes to %j", async (raw, decoded) => {
    const r = await read(pspec(), { [RPT_XML]: xml(`t[${raw}]`) }, 1);
    expect(r.failingIds).toEqual([`tests/test_math.py::t[${decoded}]`]);
    expect(r.source).toBe("report");
  });

  it("a parser exception falls back to text and still deletes the report", async () => {
    const base = mkSpec();
    const hostile: ScopedSpec = {
      ...base,
      get cwd(): string {
        throw new Error("boom");
      },
    };
    const fs = resultFs({ [RPT_JSON]: report("vitest-fail.json", "/root") });
    const r = await readResult(hostile, exec(1), fs, POSIX_HOST);
    expect(r).toMatchObject({ source: "text", complete: false, collectionError: true, note: "report could not be parsed: boom" });
    expect(fs.unlinked).toEqual([RPT_JSON]);
    const odd = { ...base, get cwd(): string { throw "str"; } };
    expect((await readResult(odd, exec(1), resultFs({ [RPT_JSON]: report("vitest-fail.json", "/root") }), POSIX_HOST)).note).toBe("report could not be parsed: str");
  });
});

describe("QA-1.3-14: argv length counts win32 quoting and the program path", () => {
  const W = (extra: Record<string, string>) => ({
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\vitest\\package.json": VITEST_PKG,
    "C:\\repo\\node_modules\\vitest\\vitest.mjs": "",
    ...extra,
  });

  it("paths with spaces that fit unquoted but not quoted -> S6", async () => {
    const names = Array.from({ length: 296 }, (_, i) => `src\\${String(i).padStart(3, "0")} ${"x".repeat(80)}.ts`);
    const files = W(Object.fromEntries(names.map((n) => [`C:\\repo\\${n}`, ""])));
    const plain = names.reduce((n, f) => n + `C:\\repo\\${f}`.length + 1, 0);
    expect(plain).toBeLessThan(30000 - 300);
    expectS6(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", changedFiles: changed(...names) })), "argv-too-long", "too many inputs for one command line: 296 files");
  });

  it("posix counts the program path too", async () => {
    const names = Array.from({ length: 280 }, (_, i) => `src/${String(i).padStart(3, "0")}${"x".repeat(92)}.ts`);
    const files = jsRepo({}, Object.fromEntries(names.map((n) => [`/r/${n}`, ""])));
    const long = { ...POSIX_HOST, pathEnv: "/usr/bin", execPath: `/${"n".repeat(300)}/node` };
    expectS6(await planScopedRun(input({ files, host: long, changedFiles: changed(...names) })), "argv-too-long");
    expect(isScopedSpec(await planScopedRun(input({ files, changedFiles: changed(...names) })))).toBe(true);
  });

  it("quotes, trailing backslashes and empty arguments are counted without failing a normal plan", async () => {
    const files = W({ 'C:\\repo\\src\\q"u o.ts': "" });
    const s = spec(await planScopedRun(input({ win: true, files, cwd: "C:\\repo", command: `vitest -t "" --dir 'C:\\a b\\'`, changedFiles: changed('src\\q"u o.ts') })));
    expect(s.args).toContain('C:\\repo\\src\\q"u o.ts');
    expect(s.args).toContain("C:\\a b\\");
  });
});

describe("QA-1.3-2: early-exit options are dropped for a full failure inventory", () => {
  const EE = "early-exit option dropped for a full failure inventory";
  const mods = { "/r/tests/test_a.py": "" };

  it.each(["-x", "--exitfirst", "--maxfail 3", "--maxfail=3", "-xq", "-qx"])("pytest %s", async (a) => {
    const d = await detect(`pytest ${a} -v`, pyRepo(mods));
    expect(d.keptArgs).toEqual(["-v"]);
    expect(d.notes).toContain(EE);
    const s = spec(await planScopedRun(input({ command: `pytest ${a}`, files: pyRepo(mods), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.filter((x) => x === "-x" || x.startsWith("--maxfail"))).toEqual(["--maxfail=0"]);
  });

  it.each(["--bail 1", "--bail=1"])("vitest %s", async (a) => {
    const d = await detect(`vitest ${a} --silent`);
    expect(d.keptArgs).toEqual(["--silent"]);
    expect(d.notes).toContain(EE);
  });

  it.each(["--bail", "-b", "--bail=2", "-b 1", "-ib"])("jest %s", async (a) => {
    const d = await detect(`jest ${a} --ci`);
    expect(d.keptArgs).toEqual(["--ci"]);
    expect(d.notes).toContain(EE);
  });
});

describe("QA-1.3-10: option spellings are normalized before the D tables", () => {
  it.each([
    ["--update-snapshot", []],
    ["-u", []],
    ["-ou", []],
    ["-uo", []],
    ["--watch-all", []],
    ["--watch-all=false", []],
    ["--list-tests", []],
    ["-f", []],
    ["--only-failures", []],
    ["--onlyFailures", []],
    ["--no-coverage", []],
    ["--detect-open-handles", ["--detect-open-handles"]],
    ["--test-name-pattern x", ["--test-name-pattern", "x"]],
    ["-ie", ["-e"]],
    ["-ic cfg.js", ["-c", "cfg.js"]],
  ])("jest %s -> kept %j", async (a, kept) => {
    expect((await detect(`jest ${a}`)).keptArgs).toEqual(kept);
  });

  it.each([
    ["-iw4", { count: 4 }],
    ["--max-workers=3", { count: 3 }],
    ["--run-in-band", { count: 1 }],
  ])("jest %s -> cap %j", async (a, cap) => {
    expect((await detect(`jest ${a}`)).userWorkers).toEqual(cap);
  });

  it.each(["-tfoo", "-oz", "-z", "--frobnicate", "--frobnicate=1", "--test-failure-exit-code 0"])("jest %s fails closed", async (a) => {
    await detectS6(`jest ${a}`, "unsupported-argument", `unsupported jest argument "${a.split(" ")[0]}" in command`);
  });

  it.each([
    ["--merge-reports=.vitest-reports", []],
    ["--merge-reports", []],
    ["--pass-with-no-tests", []],
    ["-uw", []],
    ["-u=1", []],
    ["--no-file-parallelism", ["--no-file-parallelism"]],
    ["--test-name-pattern x", ["--test-name-pattern", "x"]],
    ["-ut x", ["-t", "x"]],
    ["-t=x", ["-t=x"]],
    ["--typecheck.only", ["--typecheck.only"]],
  ])("vitest %s -> kept %j", async (a, kept) => {
    expect((await detect(`vitest ${a}`)).keptArgs).toEqual(kept);
  });

  it.each(["-cfoo", "-w4", "-tu", "-uz", "--poolOptions.threads.maxThreads=8", "--pool-options.forks.max-forks=8"])("vitest %s fails closed", async (a) => {
    await detectS6(`vitest ${a}`, "unsupported-argument", `unsupported vitest argument "${a}" in command`);
  });

  it("pytest and eslint keep rule g: = form and flags kept, a value-looking next token is ambiguous", async () => {
    expect((await detect("pytest --foo=1 --bar --baz", pyRepo())).keptArgs).toEqual(["--foo=1", "--bar", "--baz"]);
    await detectS6("pytest --reruns 2", "ambiguous-option", 'ambiguous pytest option "--reruns" in command: cannot tell whether "2" is its value', pyRepo());
    expectUnscoped(await lint("eslint --foo bar", changed("src/a.ts")), 'ambiguous eslint option "--foo" in command: cannot tell whether "bar" is its value');
  });

  it("vitest --max-workers is the cap under either spelling", async () => {
    expect((await detect("vitest --max-workers 8")).userWorkers).toEqual({ count: 8 });
    expect((await detect("vitest --max-workers=1 --maxWorkers=6")).userWorkers).toEqual({ count: 6 });
  });
});

describe("QA-1.3-3b: pytest grouped short flags follow argparse", () => {
  it.each([
    ["-qn3", { count: 3 }, true, []],
    ["-vn 2", { count: 2 }, true, ["-v"]],
    ["-qk slow", undefined, false, ["-k", "slow"]],
    ["-vrA", undefined, false, ["-v", "-rA"]],
    ["-qpno:xdist -n 2", { count: 2 }, false, ["-pno:xdist"]],
    ["-vvv", undefined, false, ["-v", "-v", "-v"]],
  ])("%s -> cap %j, xdist %s, kept %j", async (a, cap, xdist, kept) => {
    const d = await detect(`pytest ${a}`, pyRepo());
    expect(d.userWorkers).toEqual(cap);
    expect(d.xdist).toBe(xdist);
    expect(d.keptArgs).toEqual(kept);
  });

  it("an -n inside a group is capped in the argv", async () => {
    const s = spec(await planScopedRun(input({ command: "pytest -qn3", files: pyRepo({ "/r/tests/test_a.py": "" }), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "2"]);
    expect(s.args.filter((x) => x.startsWith("-qn") || x === "-n3")).toEqual([]);
  });

  it.each(["-qz", "-zq", "--tx=3*popen", "--tx 3*popen"])("%s -> S6", async (a) => {
    await detectS6(`pytest ${a}`, "unsupported-argument", `unsupported pytest argument "${a.split(" ")[0]}" in command`, pyRepo());
  });
});

describe("QA-1.3-6: package-manager location options are S6", () => {
  it.each([
    ["npm test -w packages/app", "npm -w"],
    ["npm test --workspace=packages/app", "npm --workspace=packages/app"],
    ["npm test --workspaces", "npm --workspaces"],
    ["npm test -ws", "npm -ws"],
    ["npm test --prefix x", "npm --prefix"],
    ["npm run test --include-workspace-root", "npm --include-workspace-root"],
    ["npm test foo", "npm foo"],
    ["npm -w a test", "npm -w"],
    ["pnpm test --filter app", "pnpm --filter"],
    ["pnpm test -C dir", "pnpm -C"],
    ["pnpm run test --dir=x", "pnpm --dir=x"],
    ["pnpm --filter app test", "pnpm --filter"],
    ["yarn test --cwd x", "yarn --cwd"],
    ["bun run test --filter=x", "bun --filter=x"],
  ])("%s -> unsupported %j", async (cmd, prefix) => {
    await detectS6(cmd, "unsupported-command", `unsupported command "${prefix}" in command`, jsRepo({ test: "vitest" }));
  });

  it("harmless npm options are ignored with a note; after -- everything reaches the script", async () => {
    const d = await detect("npm test -s --if-present --loglevel=silent --color=always -- -t x", jsRepo({ test: "vitest" }));
    expect(d.keptArgs).toEqual(["-t", "x"]);
    expect(d.notes).toContain("npm options ignored: -s --if-present --loglevel=silent --color=always");
    expect((await detect("pnpm test -- --dir x", jsRepo({ test: "vitest" }))).keptArgs).toEqual(["--dir", "x"]);
  });
});

describe("QA-1.3-3a/c: every xdist source is found, so the cap always lands", () => {
  const T = { "/r/tests/test_a.py": "" };
  const nArgs = (s: ScopedSpec) => s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2);
  const plan = async (command: string, files: Record<string, string>, host: Partial<RunnerHost> = { ...POSIX_HOST, pathEnv: "/usr/bin" }) =>
    spec(await planScopedRun(input({ command, files: pyRepo({ ...T, ...files }), host, changedFiles: changed("tests/test_a.py") })));

  it("(a) cross-env PYTEST_ADDOPTS in a script", async () => {
    const files = pyRepo({ ...T, "/r/package.json": JSON.stringify({ scripts: { test: 'cross-env PYTEST_ADDOPTS="-n 3" pytest' } }) });
    const d = await detect("npm test", files);
    expect(d).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    const s = spec(await planScopedRun(input({ command: "npm test", files, changedFiles: changed("tests/test_a.py") })));
    expect(nArgs(s)).toEqual(["-n", "2"]);
    expect(s.env.PYTEST_ADDOPTS).toBe("-n 3");
  });

  it("(a) the cross-env value replaces the host one for the cap; both count as evidence", async () => {
    const host = { ...POSIX_HOST, pytestAddopts: "-n 6 --cov" };
    expect(await detect('cross-env PYTEST_ADDOPTS="-n 1" pytest', pyRepo(), host)).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 1 } });
    expect(await detect("cross-env PYTEST_ADDOPTS= pytest", pyRepo(), { ...POSIX_HOST, pytestAddopts: "-p no:xdist" })).toMatchObject({ xdist: false });
  });

  it.each([
    ["/r/.pytest.ini", "[pytest]\naddopts = -n 3\n"],
    ["/r/pytest.toml", '[pytest]\naddopts = ["-n", "3"]\n'],
    ["/r/.pytest.toml", "[pytest]\naddopts = '-n 3'\n"],
    ["/r/pyproject.toml", '[tool.pytest]\naddopts = ["-n", "3"]\n'],
    ["/r/pyproject.toml", '[ "tool" . pytest . ini_options ] # c\naddopts = """\n-n 3\n"""\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = '''-n 3'''\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = [\n  "-n", # workers\n  \'3\',\n]\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n \\u0033 -k \\"a b\\" -m \\t\\\\x"\n'],
    ["/r/tox.ini", "[tox]\nenv = py\n[pytest]\n; comment\naddopts =\n    -n 3\n    --cov\n"],
    ["/r/setup.cfg", "[metadata]\nname = x\n[tool:pytest] # c\naddopts: -n 3\n"],
    ["/pytest.ini", "[pytest]\naddopts = -n 3\n"],
  ])("(c) %s is read the way pytest reads it", async (f, text) => {
    const d = await detect("pytest", pyRepo({ [f]: text }));
    expect(d).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(nArgs(await plan("pytest", { [f]: text }))).toEqual(["-n", "2"]);
  });

  it("(c) files pytest skips do not stop the search", async () => {
    const files = pyRepo({
      "/r/sub/pyproject.toml": "[project]\nname = 'x'\n[[tool.pytest.ini_options]]\n",
      "/r/sub/tox.ini": "[tox]\n[testenv]\ncommands = pytest -n 9\n",
      "/r/sub/setup.cfg": "[metadata]\n",
      "/r/pytest.ini": "[pytest]\naddopts = -n 3\n",
    });
    expect(await detect("pytest", files, POSIX_HOST, "/r/sub")).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });

  it("(c) the first accepted file in a directory wins, even an empty pytest.ini (every pytest line)", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "", "/r/tox.ini": "[pytest]\naddopts = -n 3\n" }))).toMatchObject({ xdist: false });
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\n", "/r/.pytest.ini": "[pytest]\naddopts = -n 3\n" }))).toMatchObject({ xdist: false });
  });

  it("(c) -c / --config-file: only that file, in its format", async () => {
    const files = { "/r/cfg/unit.ini": "[pytest]\naddopts = -n 3\n", "/r/cfg/unit.toml": "[tool.pytest.ini_options]\naddopts = '-n 4'\n", "/r/pytest.ini": "[pytest]\n" };
    expect(await detect("pytest -c cfg/unit.ini", pyRepo(files))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(await detect("pytest --config-file=cfg/unit.toml", pyRepo(files))).toMatchObject({ xdist: true, userWorkers: { count: 4 } });
    expect(await detect("pytest -c cfg/missing.ini", pyRepo(files))).toMatchObject({ xdist: false });
    expect((await detect("pytest -c cfg/unit.ini", pyRepo({}), POSIX_HOST)).pytestFacts).toMatchObject({ configFile: "/r/cfg/unit.ini" });
  });

  it("(c) -o addopts replaces the config's addopts", async () => {
    const files = pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" });
    expect(await detect('pytest -o "addopts=-n 4"', files)).toMatchObject({ xdist: true, userWorkers: { count: 4 } });
    expect(await detect("pytest -o addopts=", files)).toMatchObject({ xdist: false });
    expect(await detect("pytest --override-ini=addopts=--cov", files)).toMatchObject({ xdist: false, covInConfig: true });
  });

  it("(c) QA-1.3-43: the spec is pinned to the user's config, so a nearer one is never read", async () => {
    const files = { "/r/pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-q'\n", "/r/tests/unit/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/unit/test_u.py": "" };
    expect(await detect("pytest", pyRepo(files))).toMatchObject({ xdist: false });
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed("tests/unit/test_u.py") })));
    expect(s.args.slice(s.args.indexOf("--maxfail=0"), s.args.indexOf("--"))).toEqual(["--maxfail=0", "-c", "/r/pyproject.toml", "--rootdir=/r"]);
    expect(s.workers).toBeNull();
    const det = await detect("pytest", pyRepo(files));
    const r = spec(await planRerun(det, ["/r/tests/unit/test_u.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(r.args).toContain("-c");
    expect(nArgs(r)).toEqual([]);
  });

  it("(c) a DetectedRunner without pytestFacts keeps what it knew", async () => {
    const { pytestFacts: _f, ...det } = await detect("pytest -n 1 --dist load", pyRepo(T));
    const r = spec(await planRerun({ ...det, covInConfig: true }, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(T)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(nArgs(r)).toEqual(["-n", "1"]);
    expect(r.args).toContain("--no-cov");
    const bare = spec(await planRerun({ ...det, xdist: false }, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(T)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(bare.workers).toBeNull();
  });

  it("(c) unreadable config notes are not repeated at spec time", async () => {
    const files = pyRepo({ ...T, "/r/tox.ini": "x" });
    const s = spec(await planScopedRun(input({ command: "pytest", fs: memFs(files, false, {}, ["/r/tox.ini"]), changedFiles: changed("tests/test_a.py") })));
    expect(s.notes.filter((n) => n.startsWith("unreadable pytest config"))).toEqual(["unreadable pytest config ignored: /r/tox.ini"]);
  });

  it.each([
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = -n 3\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n 3\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "-n 3'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = """-n \\\n 3"""\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = '''-n 3\n"],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = [ 3 ]\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\q"\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\u12"\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\naddopts = "\\uD800"\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = 'a\nb'\n"],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\naddopts = \"-k 'x\"\n"],
    ["/r/pytest.ini", "[pytest]\naddopts = -k \"x\n"],
  ])("(c) addopts the adapter cannot read -> S6 (%s)", async (f, text) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "addopts" in ${f}`);
  });

  it("(c) a table without addopts, and an ini key without a value, are simply empty", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": "[tool.pytest.ini_options]\nminversion = '6'\n[tool.other]\naddopts = '-n 9'\n" }))).toMatchObject({ xdist: false });
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\nnot a key line\n  -n 9\n[other]\naddopts = -n 9\n" }))).toMatchObject({ xdist: false });
  });
});

describe("QA-1.3-13: a positional in addopts or PYTEST_ADDOPTS is S6", () => {
  it.each([
    [{ "/r/pytest.ini": "[pytest]\naddopts = tests\n" }, "", "tests", "addopts of /r/pytest.ini"],
    [{ "/r/pytest.ini": "[pytest]\naddopts = --foo data.txt\n", "/r/data.txt": "" }, "", "data.txt", "addopts of /r/pytest.ini"],
    [{}, "-q tests/", "tests/", "PYTEST_ADDOPTS"],
  ])("%j with PYTEST_ADDOPTS %j -> S6 naming %s", async (files, env, token, where) => {
    const r = await detectRunner("pytest", "/r", memFs(pyRepo(files)), { ...POSIX_HOST, pytestAddopts: env });
    expectS6(r, "unsupported-argument", `unsupported pytest argument "${token}" in ${where}`);
  });

  it("an unknown option's value that names no file is kept as a value", async () => {
    expect(await detect("pytest", pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = --reruns 2 --doctest-modules -ra\n" }))).toMatchObject({ xdist: false });
  });

  it("cross-env PYTEST_ADDOPTS and -o addopts are checked too; unterminated quotes are S6", async () => {
    await detectS6('cross-env PYTEST_ADDOPTS="tests" pytest', "unsupported-argument", 'unsupported pytest argument "tests" in PYTEST_ADDOPTS', pyRepo());
    await detectS6('pytest -o "addopts=tests"', "unsupported-argument", 'unsupported pytest argument "tests" in -o addopts', pyRepo());
    await detectS6(`pytest -o "addopts=-k 'x"`, "unterminated-quote", "unterminated quote in -o addopts", pyRepo());
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo()), { ...POSIX_HOST, pytestAddopts: '-k "x' }), "unterminated-quote", "unterminated quote in PYTEST_ADDOPTS");
  });

  it("the spec-time lookup applies the same rule (see also QA-1.3-3c)", async () => {
    const files = { "/r/tests/unit/pytest.ini": "[pytest]\naddopts = more_tests\n", "/r/tests/unit/test_u.py": "" };
    expect(await detect("pytest", pyRepo(files))).toMatchObject({ xdist: false });
    expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed("tests/unit/test_u.py") })), "unsupported-argument");
    const det = await detect("pytest", pyRepo(files));
    expectS6(await planRerun(det, ["/r/tests/unit/test_u.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }), "unsupported-argument");
  });
});

describe("QA-1.3-4/8/15: config triggers", () => {
  it.each([".pytest.ini", "pytest.toml", ".pytest.toml", "sub/pytest.toml", "uv.lock", "poetry.lock", "pdm.lock", "Pipfile.lock", "requirements.txt", "requirements-dev.txt"])(
    "pytest: %s -> config-changed",
    async (f) => {
      expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_a.py", f) })), "config-changed", `config file changed: ${f}`);
    },
  );

  it.each(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "pnpm-workspace.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"])(
    "vitest and jest: lockfile or workspace file %s -> config-changed",
    async (f) => {
      for (const command of ["vitest", "jest"]) {
        expectS6(await planScopedRun(input({ command, changedFiles: changed(f) })), "config-changed", `config file changed: ${f}`);
      }
      expectUnscoped(await lint("eslint", changed("src/a.ts", f)), `eslint config changed: ${f}`);
    },
  );

  it.each(["vitest.setup.ts", "setupTests.ts", "src/setup-tests.js", "global-setup.ts", "globalSetup.mts", "jest.setup.js", "test-setup.tsx", "src/app.setup.ts", "test.setup.cjs"])(
    "vitest and jest: setup file %s -> config-changed",
    async (f) => {
      for (const command of ["vitest", "jest"]) {
        expectS6(await planScopedRun(input({ command, changedFiles: changed(f) })), "config-changed", `config file changed: ${f}`);
      }
    },
  );

  it("a test named like a setup file, and other names, are ordinary inputs", async () => {
    const files = jsRepo({}, { "/r/src/setup.test.ts": "", "/r/src/setupHelper.ts": "", "/r/src/__tests__/setup.ts": "" });
    const s = spec(await planScopedRun(input({ files, changedFiles: changed("src/setup.test.ts", "src/setupHelper.ts", "src/__tests__/setup.ts") })));
    expect(s.inputs).toEqual(["/r/src/__tests__/setup.ts", "/r/src/setup.test.ts", "/r/src/setupHelper.ts"]);
    expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/setup.ts") })))).toBe(true);
  });
});

describe("QA-1.3-5: a --config / -c file is a config trigger", () => {
  const files = jsRepo({}, { "/r/cfg/unit.config.mjs": "", "/r/src/a.ts": "" });

  it.each([
    ["vitest run --config cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["vitest -c=cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["vitest --config=./cfg/../cfg/unit.config.mjs", "cfg/unit.config.mjs"],
    ["jest --config cfg/j.json", "cfg/j.json"],
    ["jest -c=cfg/j.json", "cfg/j.json"],
  ])("%s: %s changed -> config-changed", async (command, f) => {
    expectS6(await planScopedRun(input({ command, files, changedFiles: changed("src/a.ts", f) })), "config-changed", `config file changed: ${f}`);
  });

  it("pytest -c / --config-file and eslint -c / --config", async () => {
    expectS6(await planScopedRun(input({ command: "pytest -c cfg/unit.ini", files: pyRepo(), changedFiles: changed("cfg/unit.ini") })), "config-changed", "config file changed: cfg/unit.ini");
    expectS6(await planScopedRun(input({ command: "pytest --config-file cfg/u.cfg", files: pyRepo(), changedFiles: changed("cfg/u.cfg") })), "config-changed");
    expectUnscoped(await lint("eslint -c cfg/lint.mjs", changed("src/a.ts", "cfg/lint.mjs")), "eslint config changed: cfg/lint.mjs");
    expectUnscoped(await lint("eslint --config=cfg/lint.mjs", changed("cfg/lint.mjs")), "eslint config changed: cfg/lint.mjs");
  });

  it("the value resolves against the runner's cwd (a package script) and through realpath", async () => {
    const pkg = jsRepo({}, { "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest --config conf/v.mjs" } }), "/r/pkg/conf/v.mjs": "" });
    const d = await detect("npm test", pkg, POSIX_HOST, "/r/pkg");
    expect(d.configFiles).toEqual(["/r/pkg/conf/v.mjs"]);
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files: pkg, changedFiles: changed("conf/v.mjs") })), "config-changed", "config file changed: pkg/conf/v.mjs");
    const fs = aliasFs({ ...files, "/r/real/cfg.mjs": "" }, false, { "/r/cfg/link.mjs": "/r/real/cfg.mjs" });
    expectS6(await planScopedRun(input({ command: "vitest --config cfg/link.mjs", fs, changedFiles: changed("real/cfg.mjs") })), "config-changed", "config file changed: real/cfg.mjs");
  });

  it("an unrelated change still plans normally", async () => {
    expect(isScopedSpec(await planScopedRun(input({ command: "vitest --config cfg/unit.config.mjs", files, changedFiles: changed("src/a.ts") })))).toBe(true);
  });
});

describe("QA-1.3-9: eslint >= 9 lints what its flat config matches", () => {
  it("a .vue change is passed on (the QA repro: eslint ., src/App.vue)", async () => {
    const r = lintSpec(await lint("eslint .", changed("src/App.vue"), lintRepo("9.1.0", {}, { "/r/src/App.vue": "" })));
    expect(r.inputs).toEqual(["/r/src/App.vue"]);
    expect(r.args.slice(-2)).toEqual(["--no-warn-ignored", "/r/src/App.vue"]);
  });

  it("an unknown version counts as < 9", async () => {
    const files = jsRepo({}, { "/r/node_modules/eslint/package.json": JSON.stringify({ name: "eslint", bin: { eslint: "./bin/eslint.js" } }), [ESLINT_ENTRY]: "", "/r/src/App.vue": "" });
    expect(await lint("eslint", changed("src/App.vue"), files)).toEqual({ noAffected: true, note: "no changed lintable files" });
  });
});

// ---------------------------------------------------------------------------------------------
// QA round 2 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-18..28)
// ---------------------------------------------------------------------------------------------

describe("QA-1.3-18: JS tools run under node, never under Bun or a compiled binary", () => {
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\jest\\package.json": JEST_PKG,
    "C:\\repo\\node_modules\\jest\\bin\\jest.js": "",
    "C:\\repo\\src\\a.js": "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  };
  const winPlan = (host: Partial<RunnerHost>, files: Record<string, string> = W, fs?: PlannerFs) =>
    planScopedRun(input({ win: true, command: "jest", files, cwd: "C:\\repo", changedFiles: changed("src\\a.js"), host, ...(fs ? { fs } : {}) }));
  const bunHost = (execPath: string, pathEnv: string, pathExt = ".COM;.EXE;.BAT;.CMD") => ({ ...WIN_HOST, execPath, pathEnv, pathExt });

  it.each(["C:\\Users\\M\\.bun\\bin\\bun.exe", "C:\\tools\\opencode.exe"])("execPath %s -> node.exe from PATH", async (execPath) => {
    const s = spec(await winPlan(bunHost(execPath, "rel\\bin;C:\\nope;C:\\Program Files\\nodejs")));
    expect(s.file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(s.args[0]).toBe("C:\\repo\\node_modules\\jest\\bin\\jest.js");
  });

  it("PATHEXT order decides, as in the shell: a node.cmd shim first -> S6; .exe first -> the exe", async () => {
    const files = { ...W, "C:\\shim\\node.cmd": "", "C:\\shim\\node.exe": "" };
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\shim;C:\\Program Files\\nodejs", ".CMD;.EXE"), files), "node-not-found", "node on PATH is not an executable file: C:\\shim\\node.cmd");
    expect(spec(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\shim", ".EXE;.CMD"), files)).file).toBe("C:\\shim\\node.exe");
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\Program Files\\nodejs", ".CMD; ;bat")), "node-not-found", "node not found: no absolute PATH entry has a node executable");
  });

  it("no node anywhere -> S6 for tests, Unscoped for lint; pytest needs no node", async () => {
    expectS6(await winPlan(bunHost("C:\\b\\bun.exe", "C:\\nope")), "node-not-found", "node not found: no absolute PATH entry has a node executable");
    const noNode = { ...POSIX_HOST, execPath: "/home/u/.bun/bin/bun", pathEnv: "/usr/bin" };
    expectUnscoped(await lint("eslint", changed("src/a.ts"), lintRepo(), noNode), "node not found: no absolute PATH entry has a node executable");
    const py = spec(await planScopedRun(input({ command: "pytest", files: pyRepo({ "/r/tests/test_a.py": "" }), host: noNode, changedFiles: changed("tests/test_a.py") })));
    expect(py.file).toBe("/usr/bin/pytest");
  });

  it("host.nodePath wins over execPath and PATH; a relative one -> S6", async () => {
    expect(spec(await winPlan({ ...WIN_HOST, nodePath: "D:\\n\\node.exe" })).file).toBe("D:\\n\\node.exe");
    expectS6(await winPlan({ ...WIN_HOST, nodePath: "node.exe" }), "node-not-found", "node path is not absolute: node.exe");
  });

  it("the default execPath is used only when the runtime is not Bun", async () => {
    // The host platform must be the real one: the default execPath is process.execPath.
    const win = process.platform === "win32";
    const { execPath: _e, ...noExec } = win ? WIN_HOST : POSIX_HOST;
    const pathNode = win ? "C:\\opt\\node\\node.exe" : "/opt/node/bin/node";
    const files = win ? { ...W, [pathNode]: "" } : jsRepo({}, { "/r/src/a.js": "", [pathNode]: "" });
    const host = { ...noExec, platform: process.platform, pathEnv: win ? "C:\\opt\\node" : "/opt/node/bin" };
    const run = async () =>
      spec(await planScopedRun(input({ win, command: "jest", files, host, cwd: win ? "C:\\repo" : "/r", changedFiles: changed(win ? "src\\a.js" : "src/a.js") }))).file;
    expect(await run()).toBe(process.execPath);
    Object.defineProperty(process.versions, "bun", { value: "1.3.14", configurable: true });
    try {
      expect(await run()).toBe(pathNode);
    } finally {
      Reflect.deleteProperty(process.versions, "bun");
    }
  });

  it("a PATH node that realpaths to bun (bun run's temporary link) is skipped", async () => {
    const files = jsRepo({}, { "/r/src/a.js": "", "/home/u/.bun/bin/bun": "", "/usr/local/bin/node": "" });
    const fs = aliasFs(files, false, { "/tmp/bun-node-1/node": "/home/u/.bun/bin/bun" });
    const host = { ...POSIX_HOST, execPath: "/home/u/.bun/bin/bun", pathEnv: "/tmp/bun-node-1:/usr/local/bin" };
    expect(spec(await planScopedRun(input({ command: "jest", fs, host, changedFiles: changed("src/a.js") }))).file).toBe("/usr/local/bin/node");
    const wfs = aliasFs({ ...W, "C:\\Users\\u\\.bun\\bin\\bun.exe": "" }, true, { "C:\\Temp\\bun-node-1\\node.exe": "C:\\Users\\u\\.bun\\bin\\bun.exe" });
    const wspec = spec(await winPlan(bunHost("C:\\Users\\u\\.bun\\bin\\bun.exe", "C:\\Temp\\bun-node-1;C:\\Program Files\\nodejs"), W, wfs));
    expect(wspec.file).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("a realpath failure keeps the PATH node", async () => {
    const base = memFs(jsRepo({}, { "/r/src/a.js": "", "/usr/local/bin/node": "" }));
    const fs: PlannerFs = { ...base, realpath: async (p) => (p === "/usr/local/bin/node" ? Promise.reject(new Error("EACCES")) : p) };
    const host = { ...POSIX_HOST, execPath: "/b/bun", pathEnv: "/usr/local/bin" };
    expect(spec(await planScopedRun(input({ command: "jest", fs, host, changedFiles: changed("src/a.js") }))).file).toBe("/usr/local/bin/node");
  });
});

describe("QA-1.3-19: the zero-test guard covers every runner; lexical mode stays fail-closed", () => {
  const zero = (over: Partial<ScopedSpec>) => read(mkSpec(over), { [RPT_JSON]: jsonReport(0) }, 0);

  it.each<[string, Partial<ScopedSpec>, string]>([
    ["vitest lexical related over sources", { runner: "vitest", inputs: ["/root/vitest-proj/src/str.js"], lexicalPaths: true }, "vitest ran no tests and the paths were not canonicalized (no realpath seam)"],
    ["vitest related given a test file", { runner: "vitest", inputs: ["/root/vitest-proj/src/str.js", "/root/vitest-proj/test/str.test.js"] }, "vitest ran no tests although a test file was passed"],
    ["jest lexical", { runner: "jest", inputs: ["/root/vitest-proj/src/str.js"], lexicalPaths: true }, "jest ran no tests and the paths were not canonicalized (no realpath seam)"],
  ])("%s -> complete false", async (_n, over, note) => {
    expect(await zero(over)).toMatchObject({ total: 0, complete: false, note });
  });

  it("pytest scoped (inputs are tests) with 0 tests is incomplete; a spec without inputs is left alone", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"], inputsAreTests: true });
    expect(await read(sp, { [RPT_XML]: report("pytest-none.xml", "/root") }, 5)).toMatchObject({ complete: false, note: "pytest ran no tests although a test file was passed" });
    expect(await zero({ runner: "vitest", inputs: [], lexicalPaths: true })).toMatchObject({ total: 0, complete: true });
  });

  it("win32 lexical mode: ::$DATA spellings of a trigger or a rerun file are the file itself", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "", "C:\\repo\\tests\\test_a.py": "" };
    const host = { ...WIN_HOST, pathEnv: "C:\\py" };
    for (const f of ["conftest.py::$DATA", "pytest.ini::$data", "tests\\conftest.py::$DATA"]) {
      const r = await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host, changedFiles: changed(f) }));
      expectS6(r, "config-changed", `config file changed: ${f.replace(/::\$data$/i, "").replace(/\\/g, "/")}`);
    }
    const det = await detect("pytest", W, host, "C:\\repo");
    const r = spec(await planRerun(det, ["C:\\repo\\tests\\test_a.py::$DATA"], "C:\\repo", { maxWorkers: 2 }, { fs: memFs(W, true), host }));
    expect(r.inputs).toEqual(["C:\\repo\\tests\\test_a.py"]);
    const posix = await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("conftest.py::$DATA") }));
    expect(isNoAffected(posix)).toBe(true);
  });

  describe("real filesystem: vitest through a junction (win32) or symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "omr-qa1319-"));
    afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const repo = path.join(base, "repo");
    for (const [rel, body] of Object.entries({
      ".git": "gitdir: elsewhere",
      "package.json": JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
      "node_modules/vitest/package.json": VITEST_PKG,
      "node_modules/vitest/vitest.mjs": "",
      "src/str.js": "",
      "test/str.test.js": "",
    })) {
      mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), body);
    }
    const link = path.join(base, "vlink");
    symlinkSync(repo, link, "junction");
    const lexicalFs: RunnerFs = {
      fileExists: async (p) => existsSync(p),
      readFile: async (p) => readFileSync(p, "utf8"),
      unlink: async (p) => rmSync(p, { force: true }),
    };
    const host = { ...POSIX_HOST, platform: process.platform, tmpdir: base };

    it.each(["src/str.js", "test/str.test.js"])("changed %s: a 0-test report from the lexical plan is incomplete", async (f) => {
      const plan = { command: "npm test", cwd: link, changedFiles: changed(path.join(link, f)), budget: { maxWorkers: 2 }, search: stubSearch(), host };
      const s = spec(await planScopedRun({ ...plan, fs: lexicalFs }));
      expect(s).toMatchObject({ runner: "vitest", cwd: link, lexicalPaths: true });
      writeFileSync(s.reportPath, JSON.stringify({ numTotalTests: 0, testResults: [] }));
      const r = await readResult(s, exec(0), lexicalFs, host);
      expect(r).toMatchObject({ total: 0, complete: false });
      expect(existsSync(s.reportPath)).toBe(false);
      const real = spec(await planScopedRun({ ...plan, fs: { ...lexicalFs, realpath: (p) => fsRealpath(p) } }));
      expect(real.cwd).toBe(realpathSync.native(repo));
      expect(real.lexicalPaths).toBeUndefined();
    });
  });
});

describe("QA-1.3-20: TOML spellings of addopts the parser does not read fail closed", () => {
  it.each([
    ["/r/pyproject.toml", 'tool.pytest.ini_options.addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool]\npytest.ini_options.addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool.pytest]\nini_options = { addopts = "-n 3" }\n'],
    ["/r/pyproject.toml", '[tool]\npytest = { ini_options = { addopts = "-n 3" } }\n'],
    ["/r/pyproject.toml", 'tool = { pytest = { addopts = ["-n", "3"] } }\n'],
    ["/r/pyproject.toml", '[project]\nname = "x"\n[tool . "pytest"]\n"ini_options" . addopts = "-n 3"\n'],
    ["/r/pyproject.toml", '[[tool.pytest.ini_options]]\naddopts = "-n 3"\n'],
    ["/r/pytest.toml", 'pytest.addopts = ["-n", "3"]\n'],
  ])("%s %j -> S6", async (f, text) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "addopts" in ${f}`);
  });

  it("other keys, other tables and the bare form still plan", async () => {
    const text = [
      'tool.black.line-length = 100',
      '[tool.pytest.ini_options]',
      '"testpaths" = ["tests"]',
      'markers = { slow = "x" }',
      'addopts = "-n 3"',
      '[tool.other]',
      'pytest.addopts = "-n 9"',
      '"addopts" = "-n 9"',
      'ini_options = { addopts = "-n 9" }',
    ].join("\n");
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });
});

describe("QA-1.3-21: the config every pytest release line would read counts", () => {
  const det = (files: Record<string, string>, command = "pytest") => detect(command, pyRepo(files));

  it("pytest 8 skips pytest.toml, pytest 7.0 skips .pytest.ini: their pick is read too", async () => {
    expect(await det({ "/r/pytest.toml": "[pytest]\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(await det({ "/r/.pytest.ini": "[pytest]\n", "/r/tox.ini": "[pytest]\naddopts = -n 3 --cov\n" })).toMatchObject({ xdist: true, covInConfig: true, userWorkers: { count: 3 } });
    const s = spec(await planScopedRun(input({ command: "pytest", files: pyRepo({ "/r/pytest.toml": "[pytest]\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/test_a.py": "" }), changedFiles: changed("tests/test_a.py") })));
    expect(s.args.slice(s.args.indexOf("-n"), s.args.indexOf("-n") + 2)).toEqual(["-n", "2"]);
  });

  it("pytest 7/8 ignore the native [tool.pytest] table and keep walking; the lowest cap wins", async () => {
    expect(await det({ "/r/pyproject.toml": '[tool.pytest]\naddopts = ["-n", "1"]\n', "/r/tox.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true, userWorkers: { count: 1 } });
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "auto"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ userWorkers: { count: 3 } });
    const d = await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "abc"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" });
    expect(d).toMatchObject({ userWorkers: { count: 3 } });
    expect(d.notes).toContain('invalid worker cap "abc" ignored');
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-n", "2"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n abc\n" })).toMatchObject({ userWorkers: { count: 2 } });
  });

  it("-p no:xdist in one line's config does not disable the -n another line reads", async () => {
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-p", "no:xdist"]\n', "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" })).toMatchObject({ xdist: true });
    expect(await det({ "/r/pytest.ini": "[pytest]\naddopts = -n 3 -p no:xdist\n" })).toMatchObject({ xdist: false });
    expect(await det({ "/r/pytest.toml": '[pytest]\naddopts = ["-p", "no:xdist", "-n", "3"]\n' })).toMatchObject({ xdist: true });
    expect(await det({ "/r/pytest.ini": "[pytest]\naddopts = -p no:xdist\n" }, "pytest -n 3")).toMatchObject({ xdist: false });
  });

  it("a file only an older line reads can still be S6; -c toml is read both ways", async () => {
    const bad = '[tool.pytest]\naddopts = ["-q"]\n[tool.pytest.ini_options]\naddopts = -n 3\n';
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ "/r/pyproject.toml": bad })), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "addopts" in /r/pyproject.toml');
    expect(await det({ "/r/cfg/x.toml": '[tool.pytest.ini_options]\naddopts = "-n 3"\n' }, "pytest -c cfg/x.toml")).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expectS6(await detectRunner("pytest -c cfg/x.toml", "/r", memFs(pyRepo({ "/r/cfg/x.toml": '[tool.pytest]\nini_options.addopts = "-n 3"\n' })), POSIX_HOST), "unsupported-argument");
  });
});

describe("QA-1.3-22: classname=\"\" alone is a real test, not a collection error", () => {
  const pspec = () => mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs: ["/root/p/tests/test_w.py"], inputsAreTests: true });
  const xml = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite>${cases}</testsuite></testsuites>`;

  it("pytest -c elsewhere: a green run outside the rootdir stays green", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="test_workers" time="0.01"/>') }, 0);
    expect(r).toMatchObject({ failingIds: [], total: 1, collectionError: false, complete: true });
  });

  it("a failing test with classname=\"\" is unmapped, so never a pass", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="test_workers"><failure message="x"/></testcase>') }, 1);
    expect(r).toMatchObject({ failingIds: ["::test_workers"], collectionError: false, complete: false, note: 'pytest classname not mapped to a test file: "" (test_workers)' });
  });

  it("the collection-failure <error> is still a collection error, with or without a classname", async () => {
    const r = await read(pspec(), { [RPT_XML]: xml('<testcase classname="" name="p.tests.test_w"><error message="collection failure">E</error></testcase>') }, 2);
    expect(r).toMatchObject({ failingIds: ["tests/test_w.py"], collectionError: true, total: 0 });
  });
});

describe("QA-1.3-25: junit parsing is linear", () => {
  it("700 inputs x 20000 failing testcases parse in well under a second", async () => {
    const inputs = Array.from({ length: 700 }, (_, i) => `/root/p/tests/pkg${i}/sub${i % 7}/test_m${i}.py`);
    const cases: string[] = [];
    for (let j = 0; j < 20000; j++) {
      const k = j % 700;
      cases.push(`<testcase classname="p.tests.pkg${k}.sub${k % 7}.test_m${k}.TestC" name="test_${j}" time="0.001"><failure message="boom">x</failure></testcase>`);
    }
    const text = `<?xml version="1.0"?><testsuites><testsuite>${cases.join("")}</testsuite></testsuites>`;
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root", inputs, inputsAreTests: true });
    const t0 = performance.now();
    const r = await read(sp, { [RPT_XML]: text }, 1);
    const ms = performance.now() - t0;
    expect(r).toMatchObject({ total: 20000, complete: true, source: "report" });
    expect(r.failingIds).toHaveLength(20000);
    expect(r.failingIds).toContain("tests/pkg399/sub0/test_m399.py::TestC::test_19999");
    expect(r.failingIds).toContain("tests/pkg699/sub6/test_m699.py::TestC::test_19599");
    expect(ms).toBeLessThan(1000);
  });

  it("QA-2.2-1: without a rootdir a suffix shared by several inputs is ambiguous (never the first input); a unique suffix maps", async () => {
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root", gitRoot: "/root", inputs: ["/root/a/test_x.py", "/root/b/test_x.py", "/root/c/a/test_x.py"], inputsAreTests: true });
    const xml = '<testsuites><testcase classname="test_x" name="t"><failure/></testcase><testcase classname="c.a.test_x.K" name="u"><failure/></testcase></testsuites>';
    expect(await read(sp, { [RPT_XML]: xml }, 1)).toMatchObject({
      failingIds: ["c/a/test_x.py::K::u", "test_x::t"],
      failingFiles: ["/root/c/a/test_x.py"],
      complete: false,
      note: "pytest classname maps to more than one test file: test_x",
      testsByFile: { "c/a/test_x.py": 1 },
    });
  });
});

describe("QA-2.2-1: junit classnames map by the exact rootdir-relative path", () => {
  const X = "/r/tests/test_x.py";
  const Y = "/r/tests/test_y.py";
  const SUB = "/r/sub/tests/test_x.py";
  const WIN_XML = `C:\\Temp\\omr-verify-${UUID}.xml`;
  const pspec = (args: string[], inputs = [SUB, X, Y], cwd = "/r") =>
    mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd, gitRoot: "/r", args: [...args, "--", ...inputs], inputs, inputsAreTests: true });
  const xml = (...cases: string[]) => `<?xml version="1.0"?><testsuites><testsuite>${cases.join("")}</testsuite></testsuites>`;
  const pass = (classname: string, name: string) => `<testcase classname="${classname}" name="${name}"/>`;
  const fail = (classname: string, name: string) => `<testcase classname="${classname}" name="${name}"><failure message="boom">x</failure></testcase>`;
  const qa = xml(fail("tests.test_x", "test_1"), pass("sub.tests.test_x", "test_1"), pass("sub.tests.test_x", "test_2"), pass("tests.test_y", "test_1"));

  it("the pinned rootdir tells tests/test_x.py from sub/tests/test_x.py", async () => {
    const r = await read(pspec(["--junitxml=x", "--rootdir=/r"]), { [RPT_XML]: qa }, 1);
    expect(r).toMatchObject({ failingIds: ["tests/test_x.py::test_1"], failingFiles: [X], total: 4, complete: true });
    expect(r.testsByFile).toEqual({ "sub/tests/test_x.py": 2, "tests/test_x.py": 1, "tests/test_y.py": 1 });
  });

  it("without a rootdir the same report is ambiguous: incomplete, and the case is charged to no file", async () => {
    const r = await read(pspec(["--junitxml=x"]), { [RPT_XML]: qa }, 1);
    expect(r).toMatchObject({
      failingIds: ["tests.test_x::test_1"],
      failingFiles: [],
      complete: false,
      note: "pytest classname maps to more than one test file: tests.test_x",
    });
    expect(r.testsByFile).toEqual({ "sub/tests/test_x.py": 2, "tests/test_y.py": 1 });
  });

  it("an ambiguous PASSING case also makes the run incomplete", async () => {
    const r = await read(pspec(["--junitxml=x"]), { [RPT_XML]: xml(pass("tests.test_x", "ok"), pass("tests.test_y", "ok")) }, 0);
    expect(r).toMatchObject({ failingIds: [], total: 2, complete: false, note: "pytest classname maps to more than one test file: tests.test_x" });
    expect(r.testsByFile).toEqual({ "tests/test_y.py": 1 });
  });

  it("the two-token form, a relative value against cwd, and the last value wins", async () => {
    const r = await read(pspec(["--rootdir=/elsewhere", "--rootdir", ".."], [SUB, X, Y], "/r/tests"), { [RPT_XML]: qa }, 1);
    expect(r).toMatchObject({ failingIds: ["test_x.py::test_1"], failingFiles: [X], complete: true });
    expect(r.testsByFile).toEqual({ "../sub/tests/test_x.py": 2, "test_x.py": 1, "test_y.py": 1 });
  });

  it("a rootdir pytest would expand, an empty one, or one after -- is not trusted: the suffix rule applies", async () => {
    for (const args of [["--rootdir=$HOME"], ["--rootdir="], ["--"]]) {
      const sp = pspec(args);
      const r = await read({ ...sp, args: [...sp.args, "--rootdir=/r"] }, { [RPT_XML]: qa }, 1);
      expect(r, JSON.stringify(args)).toMatchObject({ complete: false, note: "pytest classname maps to more than one test file: tests.test_x" });
    }
    const win = await read(
      mkSpec({ runner: "pytest", reportPath: WIN_XML, cwd: "C:\\r", gitRoot: "C:\\r", args: ["--rootdir=%ROOT%"], inputs: ["C:\\r\\sub\\tests\\test_x.py", "C:\\r\\tests\\test_x.py"], inputsAreTests: true }),
      { [WIN_XML]: xml(fail("tests.test_x", "t")) },
      1,
      WIN_HOST,
    );
    expect(win).toMatchObject({ complete: false, note: "pytest classname maps to more than one test file: tests.test_x" });
  });

  it("classes nested in the module keep their names in the id", async () => {
    const r = await read(pspec(["--rootdir=/r"]), { [RPT_XML]: xml(fail("tests.test_x.TestA.TestB", "test_1"), pass("sub.tests.test_x.TestC", "ok")) }, 1);
    expect(r).toMatchObject({ failingIds: ["tests/test_x.py::TestA::TestB::test_1"], failingFiles: [X], complete: true });
    expect(r.testsByFile).toEqual({ "sub/tests/test_x.py": 1, "tests/test_x.py": 1 });
  });

  it("with a rootdir, a module next to a package of the same name is ambiguous", async () => {
    const pkg = "/r/tests/test_x/TestA.py";
    const r = await read(pspec(["--rootdir=/r"], [X, pkg]), { [RPT_XML]: xml(fail("tests.test_x.TestA", "test_1")) }, 1);
    expect(r).toMatchObject({ failingFiles: [], complete: false, note: "pytest classname maps to more than one test file: tests.test_x.TestA" });
  });

  it("an input outside the rootdir gets no key; its case is unmapped", async () => {
    const r = await read(pspec(["--rootdir=/r/sub"], [SUB, X]), { [RPT_XML]: xml(fail("tests.test_x", "t"), pass("", "outside")) }, 1);
    expect(r).toMatchObject({ failingIds: ["sub/tests/test_x.py::t"], failingFiles: [SUB], complete: true });
    const out = await read(pspec(["--rootdir=/r/sub"], [X]), { [RPT_XML]: xml(fail("tests.test_x", "t")) }, 1);
    expect(out).toMatchObject({ failingFiles: [], complete: false, note: "pytest classname not mapped to a test file: tests.test_x" });
  });

  it("win32: a rootdir in another case and a drive-relative input resolve", async () => {
    const inputs = ["C:\\R\\sub\\tests\\test_x.py", "C:\\R\\tests\\test_x.py"];
    const sp = mkSpec({ runner: "pytest", reportPath: WIN_XML, cwd: "C:\\R", gitRoot: "C:\\R", args: ["--rootdir=c:\\r"], inputs, inputsAreTests: true });
    const r = await read(sp, { [WIN_XML]: xml(fail("tests.test_x", "t"), pass("sub.tests.test_x", "ok")) }, 1, WIN_HOST);
    expect(r).toMatchObject({ failingIds: ["tests/test_x.py::t"], failingFiles: ["C:\\R\\tests\\test_x.py"], complete: true });
    expect(r.testsByFile).toEqual({ "sub/tests/test_x.py": 1, "tests/test_x.py": 1 });
    const other = await read({ ...sp, inputs: ["D:\\x\\tests\\test_x.py"], args: ["--rootdir=C:\\R"] }, { [WIN_XML]: xml(fail("tests.test_x", "t")) }, 1, WIN_HOST);
    expect(other).toMatchObject({ complete: false, note: "pytest classname not mapped to a test file: tests.test_x" });
  });
});

describe("QA-1.3-25: malformed junit stays linear", () => {

  it.each([
    ["8000 unclosed testcases", `<testsuites>${'<testcase classname="a" name="b">'.repeat(8000)}</testsuites>`],
    ["an unclosed testcase before a closed one", '<testsuites><testcase classname="a" name="b"><testcase classname="a" name="c"><failure/></testcase></testsuites>'],
    ["a start tag cut short", "<testsuites></testsuites><testcase classname="],
  ])("malformed: %s -> text fallback, fast", async (_n, xml) => {
    const t0 = performance.now();
    const r = await read(mkSpec({ runner: "pytest", reportPath: RPT_XML, inputs: ["/root/vitest-proj/tests/test_a.py"] }), { [RPT_XML]: xml }, 1);
    expect(r).toMatchObject({ source: "text", complete: false });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("<testcases> and a bare <testcase> at the end are not cases", async () => {
    const xml = '<testsuites><testcases/><testcase classname="tests.test_math" name="ok"/></testsuites><testcase';
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root/p", inputs: ["/root/p/tests/test_math.py"], inputsAreTests: true });
    expect(await read(sp, { [RPT_XML]: xml }, 0)).toMatchObject({ total: 1, complete: true, source: "report" });
  });
});

describe("QA-1.3-23: Python dependency files are pytest triggers", () => {
  it.each(["requirements/base.txt", "requirements/dev.in", "deps/requirements/ci.txt", "requirements-dev.in", "constraints.txt", "constraints-py312.txt", "Pipfile", "setup.py", "src/setup.py"])(
    "%s -> config-changed",
    async (f) => {
      expectS6(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("tests/test_a.py", f) })), "config-changed", `config file changed: ${f}`);
    },
  );

  it("win32 matches the directory and the extension case-insensitively; other files are not triggers", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "" };
    const r = await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host: { ...WIN_HOST, pathEnv: "C:\\py" }, changedFiles: changed("Requirements\\Base.TXT") }));
    expectS6(r, "config-changed", "config file changed: Requirements/Base.TXT");
    for (const f of ["requirements/README.md", "docs/notes.txt", "requirements.md"]) {
      expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed(f) })))).toBe(true);
    }
    expect(isNoAffected(await planScopedRun(input({ changedFiles: changed("requirements/base.txt") })))).toBe(true);
  });
});

describe("QA-1.3-24: npm workspace configuration outside the command line is S6", () => {
  const files = (extra: Record<string, string>) => jsRepo({ test: "vitest" }, { "/r/src/a.ts": "", "/r/pkg/package.json": JSON.stringify({ scripts: { test: "vitest" } }), ...extra });
  const plan = (extra: Record<string, string>, over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "npm test", files: files(extra), changedFiles: changed("src/a.ts"), ...over }));

  it.each([
    ["workspace=packages/app", "npm workspace"],
    ["workspaces = true", "npm workspaces"],
    ["; c\nworkspace[] = a", "npm workspace"],
    ["  Workspace=x", "npm workspace"],
  ])(".npmrc %j -> S6 %s", async (npmrc, prefix) => {
    expectS6(await plan({ "/r/.npmrc": npmrc }), "unsupported-command", `unsupported command "${prefix}" in /r/.npmrc`);
  });

  it("the .npmrc of any directory from cwd up to the git root counts; unreadable -> S6", async () => {
    expectS6(await plan({ "/r/pkg/.npmrc": "workspace=x" }, { cwd: "/r/pkg" }), "unsupported-command", 'unsupported command "npm workspace" in /r/pkg/.npmrc');
    const fs = memFs(files({ "/r/.npmrc": "x" }), false, {}, ["/r/.npmrc"]);
    expectS6(await plan({}, { fs }), "unsupported-command", 'unsupported command "npm" in /r/.npmrc (unreadable)');
  });

  it("npm_config_workspace(s) in the host env (any case) or cross-env -> S6", async () => {
    const host = (env: Record<string, string>) => ({ ...POSIX_HOST, pathEnv: "/usr/bin", env });
    expectS6(await plan({}, { host: host({ NPM_CONFIG_WORKSPACE: "packages/app" }) }), "unsupported-command", 'unsupported command "npm NPM_CONFIG_WORKSPACE" in the environment');
    expectS6(await plan({}, { host: host({ npm_config_workspaces: "true" }) }), "unsupported-command", 'unsupported command "npm npm_config_workspaces" in the environment');
    expectS6(await plan({}, { command: "cross-env npm_config_workspace=a npm test" }), "unsupported-command", 'unsupported command "npm npm_config_workspace" in cross-env');
    expect(isScopedSpec(await plan({}, { host: host({ npm_config_workspace: "", npm_config_prefix: "/opt/npm" }) }))).toBe(true);
  });

  it("prefix, comments, include-workspace-root alone and other managers still plan", async () => {
    for (const npmrc of ["prefix=packages/app", "# workspace=x", "include-workspace-root=true", "workspaces-update=false"]) {
      expect(isScopedSpec(await plan({ "/r/.npmrc": npmrc })), npmrc).toBe(true);
    }
    expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=x" }, { command: "pnpm test" }))).toBe(true);
    expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=x" }, { command: "vitest" }))).toBe(true);
  });
});

describe("QA-1.3-28: the setup-file trigger follows 1.6's rule", () => {
  it("setup.ts and SetupWizard.tsx outside a test directory are application inputs", async () => {
    const files = jsRepo({}, { "/r/src/setup.ts": "", "/r/src/SetupWizard.tsx": "", "/r/src/setupEnvironment.ts": "" });
    for (const command of ["vitest", "jest"]) {
      const s = spec(await planScopedRun(input({ command, files, changedFiles: changed("src/setup.ts", "src/SetupWizard.tsx", "src/setupEnvironment.ts") })));
      expect(s.inputs).toEqual(["/r/src/SetupWizard.tsx", "/r/src/setup.ts", "/r/src/setupEnvironment.ts"]);
    }
  });

  it("win32 matches case-insensitively", async () => {
    const W = { "C:\\repo\\.git": "" };
    expectS6(await planScopedRun(input({ win: true, files: W, cwd: "C:\\repo", changedFiles: changed("SetupTests.TS") })), "config-changed", "config file changed: SetupTests.TS");
  });
});

describe("QA-1.3-26: process-backed searches are bounded", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };
  const why = (n: number) => `too many changed modules to map: ${n} test searches (limit ${SEARCH_LIMIT})`;

  it("more than SEARCH_LIMIT deleted sources -> S6 before any search, in both planners", async () => {
    const gone = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `src/gone${i}.ts`);
    const search = stubSearch();
    expectS6(await planScopedRun(input({ changedFiles: changed(...gone), search })), "too-many-searches", why(SEARCH_LIMIT + 1));
    expect(search.findByContent).not.toHaveBeenCalled();
    expectS6(await st({ changedFiles: changed(...gone) }), "too-many-searches", why(SEARCH_LIMIT + 1));
  });

  it("pytest modules count too; exactly SEARCH_LIMIT still plans", async () => {
    const mods = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `src/m${i}.py`);
    const files = pyRepo({ ...Object.fromEntries(mods.map((m) => [`/r/${m}`, ""])), "/r/tests/test_all.py": "" });
    const search = stubSearch(Object.fromEntries(mods.map((_, i) => [`m${i}`, ["/r/tests/test_all.py"]])));
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed(...mods), search })), "too-many-searches", why(SEARCH_LIMIT + 1));
    expect(search.findByName).not.toHaveBeenCalled();
    expect(search.findByContent).not.toHaveBeenCalled();
    const ok = spec(await planScopedRun(input({ command: "pytest", files, changedFiles: changed(...mods.slice(1)), search })));
    expect(ok.inputs).toEqual(["/r/tests/test_all.py"]);
    expect(search.findByName).toHaveBeenCalledTimes(SEARCH_LIMIT);
    expect(search.findByContent).toHaveBeenCalledTimes(SEARCH_LIMIT);
    expect(await st({ command: "pytest", files, changedFiles: changed(...mods.slice(1)) })).toMatchObject({ scopable: true, pendingSearches: SEARCH_LIMIT });
  });
});

describe("QA-1.3-27: planStaticScoping runs the spec-time pytest config lookup", () => {
  const st = (over: Parameters<typeof input>[0]) => {
    const { search: _s, ...rest } = input(over);
    return planStaticScoping(rest);
  };

  it("a nearer tests/unit/pytest.ini the user's run does not read: S6 from both planners (QA-1.3-43)", async () => {
    const files = pyRepo({ "/r/tests/unit/pytest.ini": "[pytest]\naddopts = tests\n", "/r/tests/unit/test_x.py": "" });
    const reason = "unsupported pytest config for the scoped inputs: /r/tests/unit/pytest.ini instead of none";
    expectS6(await planScopedRun(input({ command: "pytest", files, changedFiles: changed("tests/unit/test_x.py") })), "unsupported-argument", reason);
    expectS6(await st({ command: "pytest", files, changedFiles: changed("tests/unit/test_x.py") }), "unsupported-argument", reason);
  });

  it("static notes carry the lookup's notes; with only pending searches there is nothing to look up", async () => {
    const files = pyRepo({ "/r/tests/test_x.py": "", "/r/src/m.py": "", "/r/tests/tox.ini": "x" });
    const fs = memFs(files, false, {}, ["/r/tests/tox.ini"]);
    expect(await st({ command: "pytest", fs, changedFiles: changed("tests/test_x.py") })).toMatchObject({
      scopable: true,
      pendingSearches: 0,
      notes: ["unreadable pytest config ignored: /r/tests/tox.ini"],
    });
    expect(await st({ command: "pytest", fs, changedFiles: changed("src/m.py") })).toEqual({ scopable: true, runner: "pytest", pendingSearches: 1, notes: [] });
    expect(await st({ files: jsRepo({}, { "/r/src/a.ts": "" }), changedFiles: changed("src/a.ts") })).toEqual({ scopable: true, runner: "vitest", pendingSearches: 0, notes: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// QA round 3 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-29..37)
// ---------------------------------------------------------------------------------------------

/** The "-n <N>" the adapter appended, or [] when it appended none. */
function xdistArgs(s: ScopedSpec): string[] {
  const i = s.args.indexOf("-n");
  return i < 0 ? [] : s.args.slice(i, i + 2);
}

describe("QA-1.3-31: iniconfig's key:value and decoded TOML keys reach the worker cap", () => {
  const planPy = (files: Record<string, string>, command = "pytest") =>
    planScopedRun(input({ command, files: pyRepo({ "/r/tests/test_a.py": "", ...files }), changedFiles: changed("tests/test_a.py") }));

  it.each([
    ["/r/pytest.ini", "[pytest]\naddopts:-n 3\n"],
    ["/r/tox.ini", "[pytest]\naddopts:-n 3\n"],
    ["/r/setup.cfg", "[tool:pytest]\naddopts:-n 3\n"],
    ["/r/pytest.ini", "[pytest]\naddopts: -o x=y -n 3\n"],
    ["/r/pytest.ini", "[pytest]\naddopts =-n 3\n"],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\n"add\\u006fpts" = "-n 3"\n'],
    ["/r/pyproject.toml", '[tool."py\\u0074est".ini_options]\naddopts = "-n 3"\n'],
    ["/r/pytest.toml", '[pytest]\n"add\\u006fpts" = ["-n", "3"]\n'],
    ["/r/pyproject.toml", '[tool.pytest.ini_options]\n"addopts" = "-n 3"\n'],
    ["/r/pyproject.toml", "[tool.pytest.ini_options]\n'addopts' = '-n 3'\n"],
    ["/r/pyproject.toml", '[ tool . "pytest" . ini_options ]\naddopts = "-n 3"\n'],
  ])("%s %j: the cap lands", async (f, text) => {
    expect(await detect("pytest", pyRepo({ [f]: text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
    expect(xdistArgs(spec(await planPy({ [f]: text })))).toEqual(["-n", "2"]);
  });

  it.each([
    ['[tool.pytest.ini_options]\n"add\\qopts" = "-n 3"\n', 'unsupported pytest argument ""add\\qopts"" in /r/pyproject.toml'],
    ['[tool."py\\qtest".ini_options]\naddopts = "-n 3"\n', 'unsupported pytest argument "tool."py\\qtest".ini_options" in /r/pyproject.toml'],
    ['tool.pytest.ini_options."add\\u006fpts" = "-n 3"\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
    ['[tool.pytest.ini_options]\naddopts = "-n 1"\naddopts = "-n 3"\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
    ['[tool.pytest.ini_options]\naddopts = "-n 1"\n[tool.pytest]\naddopts = ["-n", "3"]\n', 'unsupported pytest argument "addopts" in /r/pyproject.toml'],
  ])("undecodable, dotted or repeated: %j -> S6", async (text, reason) => {
    expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ "/r/pyproject.toml": text })), POSIX_HOST), "unsupported-argument", reason);
  });

  it("values are skipped whole: a header or key inside a string, array or inline table is not one", async () => {
    const text = [
      "[tool.pytest.ini_options]",
      'description = """',
      '[[ -n "$X" ]]',
      "[tool.other]",
      'addopts = "-n 9"',
      '"""',
      "markers = [",
      '  "a: [x] # not a comment",',
      "  # ] a comment",
      '  ["nested"],',
      "]",
      'x = { a = "}", b = [1, 2] }',
      "y = '''",
      "addopts = 'lit'",
      "'''",
      'z = """q""""',
      'w = "a\\"b"',
      'addopts = "-n 3"',
    ].join("\n");
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: true, userWorkers: { count: 3 } });
  });

  it("broken values and headers: the rest of the line or file is skipped, never read as pytest's", async () => {
    // A header that is not a key path belongs to no table: its keys are ignored.
    const odd = '[x y]\naddopts = "-n 9"\n[tool.pytest.ini_options]\naddopts = "-n 3"\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": odd }))).toMatchObject({ userWorkers: { count: 3 } });
    const unterminated = '[tool.pytest.ini_options]\nx = "abc\naddopts = "-n 3"\ny = """never\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": unterminated }))).toMatchObject({ userWorkers: { count: 3 } });
    const openArray = '[tool.pytest.ini_options]\naddopts = "-n 3"\nx = [ "a", { b = \'c\' }\n[tool.pytest.ini_options.more]\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": openArray }))).toMatchObject({ userWorkers: { count: 3 } });
    const openInArray = '[tool.pytest.ini_options]\nx = [ "a\naddopts = "-n 3"\n';
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": openInArray }))).toMatchObject({ userWorkers: { count: 3 } });
  });

  it("a dotted key defines the pytest table, so the file stops the search; an array table does not", async () => {
    const files = { "/r/sub/pyproject.toml": "tool.pytest.ini_options.markers = []\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" };
    const d = await detect("pytest", pyRepo(files), POSIX_HOST, "/r/sub");
    expect(d.xdist).toBe(false);
    const arr = { "/r/sub/pyproject.toml": "[[tool.pytest.ini_options]]\nmarkers = []\n", "/r/pytest.ini": "[pytest]\naddopts = -n 3\n" };
    expect(await detect("pytest", pyRepo(arr), POSIX_HOST, "/r/sub")).toMatchObject({ xdist: true });
  });
});

describe("QA-1.3-33: pytest's python_files decides which changed files are tests", () => {
  const DJANGO = "[pytest]\npython_files = tests.py test_*.py *_tests.py\n";
  const planPy = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed(...paths), ...over }));

  it("pytest-django: tests.py and *_tests.py are test files, not modules", async () => {
    const files = { "/r/pytest.ini": DJANGO, "/r/pkg/tests.py": "", "/r/pkg/str_tests.py": "" };
    const s = spec(await planPy(files, ["pkg/tests.py", "pkg/str_tests.py"]));
    expect(s.inputs).toEqual(["/r/pkg/str_tests.py", "/r/pkg/tests.py"]);
    // Without the setting they are modules, and no test is named after them.
    expectUnmapped(await planPy({ "/r/pkg/tests.py": "" }, ["pkg/tests.py"]), "pkg/tests.py");
  });

  it("modules are looked up by the names python_files gives them; a literal name gives none", async () => {
    const search = stubSearch({}, { "test_models.py": ["/r/pkg/test_models.py"] });
    const files = { "/r/pytest.ini": DJANGO, "/r/pkg/models.py": "", "/r/pkg/test_models.py": "" };
    expect(spec(await planPy(files, ["pkg/models.py"], { search })).inputs).toEqual(["/r/pkg/test_models.py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["test_models.py", "models_tests.py"]);
    const only = { "/r/pytest.ini": "[pytest]\npython_files = tests.py\n", "/r/pkg/models.py": "" };
    const none = stubSearch();
    expectUnmapped(await planPy(only, ["pkg/models.py"], { search: none }), "pkg/models.py");
    expect(none.findByName).not.toHaveBeenCalled();
  });

  it("TOML arrays and strings, the -o override on the command line, in addopts and in PYTEST_ADDOPTS", async () => {
    const cases: [Record<string, string>, string, Partial<PlanScopedRunInput>][] = [
      [{ "/r/pyproject.toml": '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n' }, "pytest", {}],
      [{ "/r/pyproject.toml": '[tool.pytest.ini_options]\npython_files = "check_*.py other.py"\n' }, "pytest", {}],
      [{ "/r/pytest.toml": '[pytest]\npython_files = ["check_*.py"]\n' }, "pytest", {}],
      [{}, "pytest -o python_files=check_*.py", {}],
      [{}, 'pytest -o "python_files=a.py check_*.py"', {}],
      [{ "/r/pytest.ini": "[pytest]\naddopts = -o python_files=check_*.py\n" }, "pytest", {}],
      [{}, "pytest", { host: { ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts: "--override-ini=python_files=check_*.py" } }],
    ];
    for (const [files, command, over] of cases) {
      const s = spec(await planPy({ ...files, "/r/src/check_x.py": "" }, ["src/check_x.py"], { command, ...over }));
      expect(s.inputs, command).toEqual(["/r/src/check_x.py"]);
    }
  });

  it("an unreadable python_files is S6 unless the command line overrides it", async () => {
    const bad: [string, string][] = [
      ["/r/pyproject.toml", "[tool.pytest.ini_options]\npython_files = 3\n"],
      ["/r/pytest.ini", "[pytest]\npython_files = 'open\n"],
      ["/r/pyproject.toml", 'tool.pytest.ini_options.python_files = ["x.py"]\n'],
    ];
    for (const [f, text] of bad) {
      expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: text })), POSIX_HOST), "unsupported-argument", `unsupported pytest argument "python_files" in ${f}`);
      expect(await detect("pytest -o python_files=t.py", pyRepo({ [f]: text }))).toMatchObject({ pythonFiles: expect.arrayContaining(["t.py"]) });
    }
    expectS6(await detectRunner("pytest -o \"python_files='x\"", "/r", memFs(pyRepo()), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "python_files" in command');
    const inAddopts = pyRepo({ "/r/pytest.ini": "[pytest]\naddopts = -o \"python_files='x\"\n" });
    expectS6(await detectRunner("pytest", "/r", memFs(inAddopts), POSIX_HOST), "unsupported-argument", 'unsupported pytest argument "python_files" in addopts of /r/pytest.ini');
  });

  it("a -o addopts override still reads python_files from the config, and ignores its odd addopts", async () => {
    const text = '[tool.pytest.ini_options]\npython_files = ["check_*.py"]\n"addopts" = 3\n';
    const d = await detect('pytest -o "addopts=-q"', pyRepo({ "/r/pyproject.toml": text }));
    expect(d.pythonFiles).toEqual(["check_*.py"]);
  });

  it("the union: a release line without a config, or a config without the key, keeps the defaults", async () => {
    expect((await detect("pytest", pyRepo())).pythonFiles).toEqual([...DEFAULT_PYTHON_FILES]);
    const toml = await detect("pytest", pyRepo({ "/r/pytest.toml": '[pytest]\npython_files = ["tests.py"]\n' }));
    expect(toml.pythonFiles).toEqual([...DEFAULT_PYTHON_FILES, "tests.py"]);
    const both = await detect("pytest", pyRepo({ "/r/pytest.toml": '[pytest]\npython_files = ["tests.py"]\n', "/r/pytest.ini": "[pytest]\npython_files = tests.py\n" }));
    expect(both.pythonFiles).toEqual(["tests.py"]);
  });

  it("with a path argument the config above it counts as well", async () => {
    const files = { "/r/tests/pytest.ini": "[pytest]\npython_files = check_*.py\n", "/r/tests/check_a.py": "" };
    expect(spec(await planPy(files, ["tests/check_a.py"], { command: "pytest tests" })).inputs).toEqual(["/r/tests/check_a.py"]);
    expectUnmapped(await planPy(files, ["tests/check_a.py"]), "tests/check_a.py");
  });

  it("path patterns match the whole path; content hits are re-checked; globs follow the patterns", async () => {
    const files = { "/r/pytest.ini": "[pytest]\npython_files = tests/*.py check_*.py\n", "/r/tests/sub/helper.py": "", "/r/lib/gone_dep.py": "" };
    expect(spec(await planPy(files, ["tests/sub/helper.py"])).inputs).toEqual(["/r/tests/sub/helper.py"]);
    const search = stubSearch({ gone: ["/r/tests/sub/helper.py", "/r/lib/gone_dep.py"] });
    const s = spec(await planPy(files, ["src/gone.py"], { search }));
    expect(s.inputs).toEqual(["/r/tests/sub/helper.py"]);
    expect(search.findByContent).toHaveBeenCalledWith("/r", "gone", [":(glob)**/*.py", ":(glob)**/check_*.py", ":(glob)**/conftest.py"]);
    expect(search.findByName).toHaveBeenCalledWith("/r", ["check_gone.py"]);
  });

  it("fnmatch: ?, sets, negated sets, ranges, unclosed brackets and repeated stars", async () => {
    const patterns = "t?st_[a-c]*.py [!x]x_*.py foo[.py **_spec.py []a]*.py r[a-].py";
    const files: Record<string, string> = { "/r/pytest.ini": `[pytest]\npython_files = ${patterns}\n` };
    const tests = ["tast_b1.py", "yx_1.py", "foo[.py", "a_b_spec.py", "]z.py", "r-.py"];
    const modules = ["tast_d1.py", "xx_1.py", "foo.py", "spec.py", "bz.py", "rb.py"];
    for (const f of [...tests, ...modules]) files[`/r/p/${f}`] = "";
    // Every module maps to one of the tests (E2E-1: an unmapped module is S6), so the inputs are the tests.
    const search: TestSearchSeam = { findByContent: vi.fn(async () => ["/r/p/tast_b1.py"]), findByName: vi.fn(async () => []) };
    const s = spec(await planPy(files, [...tests, ...modules].map((f) => `p/${f}`), { search }));
    expect(search.findByContent).toHaveBeenCalledTimes(modules.length);
    expect(s.inputs.map((p) => path.posix.basename(p)).sort()).toEqual([...tests].sort());
  });

  it("win32 matches python_files case-insensitively, with either separator", async () => {
    const W = { "C:\\repo\\.git": "", "C:\\py\\pytest.exe": "", "C:\\repo\\pytest.ini": "[pytest]\npython_files = TESTS.py Unit/*.py\n", "C:\\repo\\pkg\\tests.py": "", "C:\\repo\\unit\\a.py": "" };
    const r = spec(await planScopedRun(input({ win: true, command: "pytest", files: W, cwd: "C:\\repo", host: { ...WIN_HOST, pathEnv: "C:\\py" }, changedFiles: changed("pkg\\tests.py", "unit\\a.py") })));
    expect(r.inputs).toEqual(["C:\\repo\\pkg\\tests.py", "C:\\repo\\unit\\a.py"]);
  });
});

describe("QA-1.3-34: config files are size-capped and read once per plan", () => {
  const big = "#".repeat(CONFIG_SIZE_LIMIT + 1);

  it("a pytest config over the limit is S6 config-too-large, even one pytest would skip", async () => {
    for (const f of ["/r/pyproject.toml", "/pyproject.toml", "/r/tox.ini"]) {
      expectS6(await detectRunner("pytest", "/r", memFs(pyRepo({ [f]: big })), POSIX_HOST), "config-too-large", `config file too large to read: ${f} (limit ${CONFIG_SIZE_LIMIT} bytes)`);
    }
    expectS6(await detectRunner("pytest -c cfg/x.ini", "/r", memFs(pyRepo({ "/r/cfg/x.ini": big })), POSIX_HOST), "config-too-large");
  });

  it("with fs.stat the size is checked before the read, and a directory is unreadable", async () => {
    const base = memFs(pyRepo({ "/r/pyproject.toml": "small", "/r/tox.ini": "[pytest]\n" }));
    const reads: string[] = [];
    const fs: PlannerFs = {
      ...base,
      readFile: async (p) => {
        reads.push(p);
        return base.readFile(p);
      },
      stat: async (p) => ({ isFile: !p.endsWith("tox.ini"), size: p.endsWith(".toml") ? BigInt(CONFIG_SIZE_LIMIT + 1) : 10, dev: 1, ino: 1 }),
    };
    expectS6(await detectRunner("pytest", "/r", fs, POSIX_HOST), "config-too-large");
    expect(reads).not.toContain("/r/pyproject.toml");
    const dirFs: PlannerFs = { ...fs, stat: async (p) => ({ isFile: !p.endsWith("tox.ini"), size: 10, dev: 1, ino: 1 }) };
    const d = await detectRunner("pytest", "/r", { ...dirFs, fileExists: async (p) => p !== "/r/pyproject.toml" && (await base.fileExists(p)) }, POSIX_HOST);
    expect((d as DetectedRunner).notes).toContain("unreadable pytest config ignored: /r/tox.ini");
  });

  it("each config file is read once per plan, across detection, the spec-time lookup and the release lines", async () => {
    const files = pyRepo({ "/r/pyproject.toml": '[tool.pytest.ini_options]\naddopts = "-n 3"\n', "/r/tests/test_a.py": "" });
    const base = memFs(files);
    const reads: string[] = [];
    const fs: FsSeam = { ...base, readFile: async (p) => (reads.push(p), base.readFile(p)) };
    spec(await planScopedRun(input({ command: "pytest tests", fs, changedFiles: changed("tests/test_a.py") })));
    expect(reads.filter((p) => p === "/r/pyproject.toml")).toHaveLength(1);
  });

  it("a config just under the limit, in the worst line shape, parses quickly", async () => {
    const text = `[tool.pytest.ini_options]\n${"a=1\n".repeat(Math.floor((CONFIG_SIZE_LIMIT - 40) / 4))}`;
    const t0 = performance.now();
    expect(await detect("pytest", pyRepo({ "/r/pyproject.toml": text }))).toMatchObject({ xdist: false });
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
describe("QA-1.3-29: setup files are triggers under a superset of 1.6's rule", () => {
  const planJs = (command: string, extra: Record<string, string>, paths: string[]) =>
    planScopedRun(input({ command, files: jsRepo({}, extra), changedFiles: changed(...paths) }));
  // risk.ts (vrb/p16) SETUP_FILE, every alternative: the runner rule must contain it.
  const RISK = ["a.setup.tsx", "setupTests.ts", "setup-tests.js", "test-setup.ts", "global-setup.ts", "globalSetup.mts", "vitest.setup.ts", "jest.setup.cjs", "setup-jest.js", "jest-setup.js", "vitest-setup.ts", "global-teardown.js"];
  const MORE = ["test/setup.js", "tests/setup.ts", "src/test/setup.tsx", "spec/teardown.mjs", "jest/setup.cjs", "__setup__/../testing/setup.js", "jest.setupAfterEnv.js", "jestSetup.ts", "testSetup.ts", "tests.setup.ts", "setupVitest.ts", "setupJest.js", "setupEnv.js", "setupAfterEnv.ts", "setupFilesAfterEnv.ts", "globalTeardown.ts", "global.setup.e2e.ts"];

  it.each([...RISK, ...MORE])("%s -> config-changed under vitest and jest", async (f) => {
    for (const command of ["vitest", "jest"]) {
      const r = await planJs(command, {}, [f]);
      expect(isUnverifiable(r) && r.code === "config-changed", `${command} ${f}: ${JSON.stringify(r)}`).toBe(true);
    }
  });

  it("test files stay inputs even with a setup-like name; pytest is unaffected", async () => {
    const extra = { "/r/test/jest-setup.test.js": "", "/r/__tests__/setup.js": "" };
    expect(spec(await planJs("jest", extra, ["test/jest-setup.test.js", "__tests__/setup.js"])).inputs).toEqual(["/r/__tests__/setup.js", "/r/test/jest-setup.test.js"]);
    expect(isNoAffected(await planScopedRun(input({ command: "pytest", files: pyRepo(), changedFiles: changed("test/setup.js") })))).toBe(true);
  });

  it("files a jest config names statically are triggers, whatever their name", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ "/r/jest.config.js": "module.exports = { setupFilesAfterEnv: ['<rootDir>/src/testing/bootstrap.ts'] };" }, "src/testing/bootstrap.ts"],
      [{ "/r/package.json": JSON.stringify({ name: "app", jest: { setupFiles: ["./tools/env.js"] } }) }, "tools/env.js"],
      [{ "/r/jest.config.json": JSON.stringify({ rootDir: "src", globalSetup: "<rootDir>/boot.js" }) }, "src/boot.js"],
      [{ "/r/jest.config.ts": "export default { globalTeardown: '<rootDir>/tools/polyfills' }" }, "tools/polyfills.ts"],
      [{ "/r/jest.config.ts": "export default { setupFiles: ['./tools/shim'] }" }, "tools/shim/index.js"],
      [{ "/r/jest.config.js": "module.exports = { setupFiles: [/* c */ ...base, require.resolve(\"./a/b.js\"), // it's\n 'c/d.js', `e/f.js`] }" }, "c/d.js"],
      [{ "/r/jest.config.js": "module.exports = { setupFiles: [/* c */ ...base, require.resolve(\"./a/b.js\")] }" }, "a/b.js"],
      [{ "/r/jest.config.js": "module.exports = { \"setupFiles\": [path.join(__dirname, 'x/y.js')] }" }, "x/y.js"],
    ];
    for (const [extra, f] of cases) {
      const r = await planJs("jest", { ...extra, [`/r/${f}`]: "" }, [f]);
      expect(r, `${f}: ${JSON.stringify(extra)}`).toEqual({ unverifiable: true, code: "config-changed", reason: `config file changed: ${f}` });
    }
  });

  it("vitest configs and the --config file count; parent configs add triggers too", async () => {
    const vcfg = "export default defineConfig({ test: { setupFiles: ['./src/vitest-boot.ts'], globalSetup: \"./scripts/gs.ts\" } })";
    for (const f of ["src/vitest-boot.ts", "scripts/gs.ts"]) {
      expectS6(await planJs("vitest", { "/r/vitest.config.ts": vcfg }, [f]), "config-changed", `config file changed: ${f}`);
    }
    expectS6(await planJs("vitest run --config cfg/unit.mjs", { "/r/cfg/unit.mjs": "export default { test: { setupFiles: 'boot.js' } }" }, ["cfg/boot.js"]), "config-changed");
    const mono = { "/r/pkg/package.json": JSON.stringify({ name: "p", scripts: { test: "jest" } }), "/r/jest.config.js": "module.exports = { setupFiles: ['<rootDir>/shared/boot.js'] }" };
    expectS6(await planScopedRun(input({ command: "npm test", cwd: "/r/pkg", files: jsRepo({}, mono), changedFiles: changed("/r/shared/boot.js") })), "config-changed");
  });

  it("globs, templates with ${}, empty values and non-literal values name nothing", async () => {
    const cfg = "module.exports = { setupFiles: ['src/*.js', `${root}/a.js`, '', \"unterminated\n], globalSetup: makePath(), rootDir: dirs }";
    const s = spec(await planJs("jest", { "/r/jest.config.js": cfg, "/r/src/a.js": "" }, ["src/a.js"]));
    expect(s.inputs).toEqual(["/r/src/a.js"]);
  });

  it("an oversized runner config is S6; an unreadable one is skipped", async () => {
    const big = "x".repeat(CONFIG_SIZE_LIMIT + 1);
    expectS6(await planJs("jest", { "/r/jest.config.js": big, "/r/src/a.js": "" }, ["src/a.js"]), "config-too-large", `config file too large to read: /r/jest.config.js (limit ${CONFIG_SIZE_LIMIT} bytes)`);
    const fs = memFs(jsRepo({}, { "/r/jest.config.js": "x", "/r/src/a.js": "" }), false, {}, ["/r/jest.config.js"]);
    expect(spec(await planScopedRun(input({ command: "jest", fs, changedFiles: changed("src/a.js") }))).inputs).toEqual(["/r/src/a.js"]);
  });

  it("win32: names match case-insensitively, references by key", async () => {
    const W = { ...Object.fromEntries(Object.entries(jsRepo()).map(([k, v]) => [k.replace(/^\/r/, "C:\\repo").replace(/\//g, "\\"), v])), "C:\\repo\\jest.config.js": "module.exports = { setupFiles: ['<rootDir>/Tools/Env.js'] }" };
    const host = WIN_HOST;
    for (const f of ["JEST-SETUP.JS", "Test\\Setup.js", "tools\\env.js"]) {
      expectS6(await planScopedRun(input({ win: true, command: "jest", files: W, cwd: "C:\\repo", host, changedFiles: changed(f) })), "config-changed");
    }
  });
});

describe("QA-1.3-38: a test file the runner's config excludes stays an input (G.8a)", () => {
  const PW = { "/r/playwright.config.ts": "export default defineConfig({ testDir: './e2e' })" };
  const VCFG = "export default mergeConfig(viteConfig, defineConfig({ test: { environment: 'jsdom', exclude: [...configDefaults.exclude, 'e2e/**'] } }))";
  const plan = (command: string, extra: Record<string, string>, paths: string[]) =>
    planScopedRun(input({ command, files: jsRepo({}, { "/r/e2e/login.spec.ts": "", "/r/src/a.ts": "", ...extra }), changedFiles: changed(...paths) }));

  it("create-vue shape: the e2e spec is an input, and a run of it that reports 0 tests is unverifiable", async () => {
    const extra = { ...PW, "/r/vitest.config.ts": VCFG };
    const s = spec(await plan("vitest", extra, ["e2e/login.spec.ts"]));
    expect(s.inputs).toEqual(["/r/e2e/login.spec.ts"]);
    expect(s.notes.filter((n) => n.includes("playwright"))).toEqual([]);
    expect(spec(await plan("vitest", extra, ["e2e/login.spec.ts", "src/a.ts"])).inputs).toEqual(["/r/e2e/login.spec.ts", "/r/src/a.ts"]);
    const r = await read(s, { [RPT_JSON]: jsonReport(0) }, 0);
    expect(r).toMatchObject({ total: 0, complete: false, note: "vitest ran no tests although a test file was passed" });
  });

  it.each<[string, string, Record<string, string>, string]>([
    [
      "(a) coverage.exclude, Playwright testMatch",
      "vitest",
      {
        "/r/vitest.config.js": "export default { test: { include: ['tests/unit/**/*.test.js'], coverage: { exclude: ['tests/**'] } } }",
        "/r/playwright.config.js": "module.exports = { testDir: './tests', testMatch: '**/*.e2e.js' }",
      },
      "tests/unit/math.test.js",
    ],
    [
      "(b) coverage.exclude, no Playwright testDir",
      "vitest",
      { "/r/vitest.config.js": "export default { test: { coverage: { exclude: ['test/**', 'e2e/**'] } } }", "/r/playwright.config.js": "module.exports = { testMatch: 'e2e/**/*.pw.js' }" },
      "test/math.test.js",
    ],
    [
      "(c) typecheck.exclude, Playwright testIgnore",
      "vitest",
      { "/r/vitest.config.js": "export default { test: { typecheck: { exclude: ['tests/**'] } } }", "/r/playwright.config.js": "module.exports = { testDir: './tests', testIgnore: '**/unit/**' }" },
      "tests/unit/math.test.js",
    ],
    ["test.exclude", "vitest", { ...PW, "/r/vitest.config.ts": "export default { test: { exclude: ['**/e2e/**'] } }" }, "e2e/login.spec.ts"],
    ["--exclude", "vitest run --exclude e2e/**", PW, "e2e/login.spec.ts"],
    ["jest testPathIgnorePatterns", "jest", { ...PW, "/r/jest.config.js": "module.exports = { testPathIgnorePatterns: ['/node_modules/', '<rootDir>/e2e/'] }" }, "e2e/login.spec.ts"],
  ])("%s: the changed test file is an input", async (_n, command, extra, f) => {
    expect(spec(await plan(command, { ...extra, [`/r/${f}`]: "" }, [f])).inputs).toEqual([`/r/${f}`]);
  });

  it("Playwright configs are not read: an oversized one changes nothing", async () => {
    const big = { "/r/vitest.config.ts": VCFG, "/r/playwright.config.ts": "x".repeat(CONFIG_SIZE_LIMIT + 1) };
    expect(spec(await plan("vitest", big, ["e2e/login.spec.ts"])).inputs).toEqual(["/r/e2e/login.spec.ts"]);
  });
});
describe("QA-1.3-32: .npmrc keys as npm's ini parser reads them, and npx", () => {
  const files = (extra: Record<string, string>) => jsRepo({ test: "vitest", ptest: "npx vitest run" }, { "/r/src/a.ts": "", ...extra });
  const plan = (extra: Record<string, string>, command = "npm test", over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command, files: files(extra), changedFiles: changed("src/a.ts"), ...over }));

  it.each([
    ['"workspace" = packages/app', "npm workspace"],
    ["'workspaces' = true", "npm workspaces"],
    ["\uFEFFworkspace=packages/app", "npm workspace"],
    ['"work\\u0073pace"=x', "npm workspace"],
    ["'\"workspace\"'=x", "npm workspace"],
    ["workspaces", "npm workspaces"],
    ["workspace;note=x", "npm workspace"],
    ["  WORKSPACE[] = a", "npm workspace"],
    ["[section]\nworkspace=a", "npm workspace"],
  ])(".npmrc %j -> S6 %s", async (npmrc, prefix) => {
    expectS6(await plan({ "/r/.npmrc": npmrc }), "unsupported-command", `unsupported command "${prefix}" in /r/.npmrc`);
  });

  it.each(['"workspaces-update" = false', "=workspace", "work\\;space=1", "wo\\rkspace=1", "a\\", "'\"'=1", "[workspace]", "# workspace=x"])(".npmrc %j still plans", async (npmrc) => {
    expect(isScopedSpec(await plan({ "/r/.npmrc": npmrc })), npmrc).toBe(true);
  });

  it("npx reads the same config, as a command or inside any package script", async () => {
    const why = 'unsupported command "npm workspace" in /r/.npmrc';
    expectS6(await plan({ "/r/.npmrc": "workspace=packages/app" }, "npx vitest run"), "unsupported-command", why);
    expectS6(await plan({ "/r/.npmrc": "workspace=packages/app" }, "pnpm run ptest"), "unsupported-command", why);
    const host = { ...POSIX_HOST, pathEnv: "/usr/bin", env: { npm_config_workspace: "packages/app" } };
    expectS6(await plan({}, "npx jest", { host }), "unsupported-command", 'unsupported command "npm npm_config_workspace" in the environment');
    expectS6(await plan({}, "cross-env NPM_CONFIG_WORKSPACES=true npx vitest"), "unsupported-command", 'unsupported command "npm NPM_CONFIG_WORKSPACES" in cross-env');
    for (const command of ["vitest run", "pnpm exec vitest", "yarn test"]) {
      expect(isScopedSpec(await plan({ "/r/.npmrc": "workspace=packages/app" }, command)), command).toBe(true);
    }
  });

  it("an oversized .npmrc is S6 config-too-large", async () => {
    expectS6(await plan({ "/r/.npmrc": "x".repeat(CONFIG_SIZE_LIMIT + 1) }), "config-too-large");
  });
});
/** memFs plus a stat seam: `ids` gives a file's ino (the same ino = hard links), `dirs` are directories. */
function statFs(files: Record<string, string>, win: boolean, ids: Record<string, number> = {}, dirs: string[] = []): PlannerFs {
  const base = memFs(files, win);
  const k = (p: string) => (win ? p.toLowerCase() : p);
  const idOf = new Map(Object.entries(ids).map(([p, i]) => [k(p), i]));
  const dirSet = new Set(dirs.map(k));
  const auto = new Map<string, number>();
  const inoOf = (p: string) => {
    const known = idOf.get(k(p)) ?? auto.get(k(p));
    if (known !== undefined) return known;
    auto.set(k(p), 1000 + auto.size);
    return 999 + auto.size;
  };
  return {
    ...base,
    fileExists: async (p) => dirSet.has(k(p)) || base.fileExists(p),
    stat: async (p) => {
      if (dirSet.has(k(p))) return { isFile: false, size: 0, dev: 1, ino: 5 };
      if (!(await base.fileExists(p))) throw new Error(`ENOENT ${p}`);
      return { isFile: true, size: 10, dev: 1n, ino: BigInt(inoOf(p)) };
    },
  };
}

describe("QA-1.3-30: Bun's temporary node is never taken for node", () => {
  const BUN = "C:\\Users\\u\\.bun\\bin\\bun.exe";
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\jest\\package.json": JEST_PKG,
    "C:\\repo\\node_modules\\jest\\bin\\jest.js": "",
    "C:\\repo\\src\\a.js": "",
    [BUN]: "",
    "C:\\Users\\u\\AppData\\Local\\Temp\\bun-node-0d9b296af\\node.exe": "",
    "C:\\Tools\\hl\\node.exe": "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  };
  const plan = (host: Partial<RunnerHost>, fs: PlannerFs) =>
    planScopedRun(input({ win: true, command: "jest", fs, cwd: "C:\\repo", changedFiles: changed("src\\a.js"), host: { ...WIN_HOST, ...host } }));
  const PATH = "C:\\Users\\u\\AppData\\Local\\Temp\\bun-node-0d9b296af;C:\\Tools\\hl;C:\\Program Files\\nodejs";
  const links = { [BUN]: 7, "C:\\Users\\u\\AppData\\Local\\Temp\\bun-node-0d9b296af\\node.exe": 7, "C:\\Tools\\hl\\node.exe": 7 };

  it("a bun-node-<hex> directory is skipped, and so is a hard link to the runtime under any name", async () => {
    expect(spec(await plan({ execPath: BUN, pathEnv: PATH }, statFs(W, true, links))).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expectS6(await plan({ execPath: BUN, pathEnv: PATH.replace(";C:\\Program Files\\nodejs", "") }, statFs(W, true, links)), "node-not-found");
  });

  it("`bun --bun run`: an execPath named node.exe inside bun-node-<hex> is not node", async () => {
    const host = { execPath: "C:\\Users\\u\\AppData\\Local\\Temp\\bun-node-0d9b296af\\node.exe", pathEnv: PATH };
    expect(spec(await plan(host, statFs(W, true, links))).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    const posix = jsRepo({}, { "/r/src/a.js": "", "/tmp/bun-node-ab12/node": "", "/usr/bin/node": "" });
    const s = spec(await planScopedRun(input({ command: "jest", files: posix, changedFiles: changed("src/a.js"), host: { ...POSIX_HOST, execPath: "/tmp/bun-node-ab12/node", pathEnv: "/tmp/bun-node-ab12:/usr/bin" } })));
    expect(s.file).toBe("/usr/bin/node");
  });

  it("identity needs real ids: ino 0 or no stat for the runtime proves nothing", async () => {
    const zero = { [BUN]: 0, "C:\\Tools\\hl\\node.exe": 0 };
    expect(spec(await plan({ execPath: BUN, pathEnv: "C:\\Tools\\hl" }, statFs(W, true, zero))).file).toBe("C:\\Tools\\hl\\node.exe");
    const { [BUN]: _b, ...noRuntime } = W;
    expect(spec(await plan({ execPath: BUN, pathEnv: "C:\\Tools\\hl" }, statFs(noRuntime, true, links))).file).toBe("C:\\Tools\\hl\\node.exe");
  });
});

describe("QA-1.3-36: executables must be files on full paths", () => {
  const W = {
    "C:\\repo\\.git": "",
    "C:\\repo\\node_modules\\jest\\package.json": JEST_PKG,
    "C:\\repo\\node_modules\\jest\\bin\\jest.js": "",
    "C:\\repo\\src\\a.js": "",
    "C:\\repo\\tests\\test_a.py": "",
    "\\Users\\x\\node.exe": "",
    "\\Users\\x\\pytest.exe": "",
    "\\Users\\x\\uv.exe": "",
    "\\\\srv\\share\\bin\\node.exe": "",
    "C:\\Program Files\\nodejs\\node.exe": "",
  };
  const plan = (host: Partial<RunnerHost>, fs: PlannerFs = memFs(W, true), command = "jest", file = "src\\a.js") =>
    planScopedRun(input({ win: true, command, fs, cwd: "C:\\repo", changedFiles: changed(file), host: { ...WIN_HOST, execPath: "C:\\b\\bun.exe", ...host } }));

  it("win32 PATH entries need a drive or a UNC host", async () => {
    expect(spec(await plan({ pathEnv: "\\Users\\x;C:\\Program Files\\nodejs" })).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(spec(await plan({ pathEnv: "\\Users\\x;\\\\srv\\share\\bin" })).file).toBe("\\\\srv\\share\\bin\\node.exe");
    expectS6(await plan({ pathEnv: "\\Users\\x" }, memFs(W, true), "pytest", "tests\\test_a.py"), "runner-not-installed", "runner not installed: pytest");
    expectS6(await plan({ pathEnv: "\\Users\\x" }, memFs(W, true), "uv run pytest", "tests\\test_a.py"), "runner-not-installed", "runner not installed: uv");
    expectS6(await plan({ nodePath: "\\Users\\x\\node.exe" }), "node-not-found", "node path is not absolute: \\Users\\x\\node.exe");
  });

  it("with stat, a directory named node.exe or pytest.exe is skipped, and a configured node must be a file", async () => {
    const dirs = ["C:\\nd\\node.exe", "C:\\nd\\pytest.exe", "C:\\repo\\.venv\\Scripts\\pytest.exe"];
    const fs = statFs(W, true, {}, dirs);
    expect(spec(await plan({ pathEnv: "C:\\nd;C:\\Program Files\\nodejs" }, fs)).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expectS6(await plan({ pathEnv: "C:\\nd" }, fs, "pytest", "tests\\test_a.py"), "runner-not-installed");
    expectS6(await plan({ nodePath: "C:\\nd\\node.exe" }, fs), "node-not-found", "node path is not a file: C:\\nd\\node.exe");
    expectS6(await plan({ nodePath: "C:\\missing\\node.exe" }, fs), "node-not-found", "node path is not a file: C:\\missing\\node.exe");
    expect(spec(await plan({ nodePath: "C:\\Program Files\\nodejs\\node.exe" }, fs)).file).toBe("C:\\Program Files\\nodejs\\node.exe");
  });

  it("with stat, an execPath named node must exist; without stat it is trusted as before", async () => {
    const host = { execPath: "C:\\missing\\node.exe", pathEnv: "C:\\Program Files\\nodejs" };
    expect(spec(await plan(host, statFs(W, true))).file).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(spec(await plan(host)).file).toBe("C:\\missing\\node.exe");
    expect(spec(await plan({ ...host, execPath: "C:\\Program Files\\nodejs\\node.exe", pathEnv: "" }, statFs(W, true))).file).toBe("C:\\Program Files\\nodejs\\node.exe");
  });
});
describe("QA-1.3-35: readResult relativises by prefix when a path is plainly below the base", () => {
  const vjson = (names: string[]) =>
    JSON.stringify({
      numTotalTests: names.length,
      testResults: names.map((name) => ({ name, status: "failed", assertionResults: [{ status: "failed", ancestorTitles: ["s"], title: "t" }] })),
    });
  const WSPEC = (cwd: string) => mkSpec({ cwd, gitRoot: "C:\\Root", reportPath: "C:\\Temp\\omr-verify-0123abcd-0000-4000-8000-00000000abcd.json" });
  const wread = (sp: ScopedSpec, text: string) => read(sp, { [sp.reportPath]: text }, 1, { ...WIN_HOST, tmpdir: "C:\\Temp" });

  it("win32: either separator, any case, a drive root; odd paths take P.relative", async () => {
    const r = await wread(WSPEC("C:\\Root\\proj"), vjson(["c:/root/PROJ/test/A.test.js", "C:\\Root\\proj\\x\\y.test.js", "C:\\Root\\other\\z.test.js", "C:\\Root\\proj\\a\\..\\b.test.js", "C:\\Root\\proj\\\\d.test.js", "C:\\Root\\proj"]));
    expect(r.failingIds).toEqual(["", "../other/z.test.js > s > t", "b.test.js > s > t", "d.test.js > s > t", "test/A.test.js > s > t", "x/y.test.js > s > t"].map((x) => (x === "" ? " > s > t" : x)).sort());
    const root = await wread(WSPEC("C:\\"), vjson(["C:\\t\\a.test.js"]));
    expect(root.failingIds).toEqual(["t/a.test.js > s > t"]);
  });

  it("posix: prefix, a root cwd, and a sibling that only shares the prefix text", async () => {
    const r = await read(mkSpec({ cwd: "/root/p" }), { [RPT_JSON]: vjson(["/root/p/t/a.test.js", "/root/pp/b.test.js", "/root/p/./c.test.js"]) }, 1);
    expect(r.failingIds).toEqual(["../pp/b.test.js > s > t", "c.test.js > s > t", "t/a.test.js > s > t"]);
    const top = await read(mkSpec({ cwd: "/" }), { [RPT_JSON]: vjson(["/x/a.test.js"]) }, 1);
    expect(top.failingIds).toEqual(["x/a.test.js > s > t"]);
  });

  it("junit: a passing case is counted without decoding it, and relativisation is per file", async () => {
    const cases = Array.from({ length: 5000 }, (_, i) => `<testcase classname="tests.test_m" name="ok_${i}" x="&#x110000;"/>`).join("");
    const xml = `<testsuites>${cases}<testcase classname="tests.test_m" name="bad"><failure/></testcase></testsuites>`;
    const sp = mkSpec({ runner: "pytest", reportPath: RPT_XML, cwd: "/root/p", gitRoot: "/root/p", inputs: ["/root/p/tests/test_m.py"], inputsAreTests: true });
    expect(await read(sp, { [RPT_XML]: xml }, 1)).toMatchObject({ total: 5001, failingIds: ["tests/test_m.py::bad"], complete: true });
  });
});
// ---------------------------------------------------------------------------------------------
// QA round 4 (docs/qa/verification-resource-budget/phase-1.3.md, QA-1.3-38..42)
// ---------------------------------------------------------------------------------------------

describe("QA-1.3-41: jest's inline JSON --config is the config itself", () => {
  const BOOT = "src/testing/bootstrap.js";
  const planJest = (command: string, extra: Record<string, string> = {}, paths = [BOOT]) =>
    planScopedRun(input({ command, files: jsRepo({}, { [`/r/${BOOT}`]: "", "/r/src/a.js": "", ...extra }), changedFiles: changed(...paths) }));

  it.each([
    `jest --config '{"setupFilesAfterEnv":["./src/testing/bootstrap.js"]}'`,
    `jest -c '{"rootDir":"src","setupFiles":["./testing/bootstrap"]}'`,
    `jest --config='{"setup\\u0046ilesAfterEnv":["./src/te\\u0073ting/bootstrap.js"]}'`,
    `jest --config '{"projects":[{"globalSetup":"./src/testing/bootstrap.js"}]}'`,
  ])("%s -> the setup file it names is a trigger", async (command) => {
    expectS6(await planJest(command), "config-changed", `config file changed: ${BOOT}`);
  });

  it("the value is not a config path; other changes still plan, with the value kept", async () => {
    const command = `jest --config '{"setupFiles":["./src/testing/bootstrap.js"]}'`;
    const d = await detect(command);
    expect(d.configFiles).toEqual([]);
    expect(d.inlineConfigs).toEqual(['{"setupFiles":["./src/testing/bootstrap.js"]}']);
    expect(spec(await planJest(command, {}, ["src/a.js"])).args).toContain('{"setupFiles":["./src/testing/bootstrap.js"]}');
    // vitest has no inline form: the value stays a path.
    expect((await detect("vitest --config '{}'")).inlineConfigs).toBeUndefined();
  });

  it("an inline value that does not parse is S6", async () => {
    expectS6(await planJest("jest --config '{bad}'"), "unsupported-argument", 'unsupported jest argument "{bad}" in command');
  });

  it("JSON config files are read with JSON.parse too, so escaped keys and paths count", async () => {
    const escaped = '{"setup\\u0046iles":["./src/te\\u0073ting/bootstrap.js"]}';
    expectS6(await planJest("jest", { "/r/jest.config.json": escaped }), "config-changed");
    expectS6(await planJest("jest", { "/r/package.json": `{"name":"app","jest":${escaped}}` }), "config-changed");
    // QA-1.3-46: a JSON config jest cannot parse fails the user's run: S6, whatever changed.
    const why = "unsupported jest config: /r/jest.config.json does not parse as JSON";
    expectS6(await planJest("jest", { "/r/jest.config.json": '{"setupFiles":["./src/testing/bootstrap.js"],}' }), "unsupported-argument", why);
    expectS6(await planJest("jest", { "/r/jest.config.json": "{" }, ["src/a.js"]), "unsupported-argument", why);
  });
});

describe("QA-1.3-46: JSON configs are read with comments stripped, as jest-config does", () => {
  const BOOT = "src/testing/bootstrap.js";
  const planJest = (extra: Record<string, string>, paths = [BOOT]) =>
    planScopedRun(input({ command: "jest", files: jsRepo({}, { [`/r/${BOOT}`]: "", "/r/src/a.js": "", ...extra }), changedFiles: changed(...paths) }));

  it.each([
    '{ // local setup\n  "setup\\u0046ilesAfterEnv": ["./src/te\\u0073ting/bootstrap.js"]\n}\n',
    '{ /* a\n block */ "setup\\u0046iles": [ "./src/te\\u0073ting/bootstrap.js" /* trailing */ ] }',
    '{ "x": "a \\" // not a comment", "setup\\u0046iles": ["./src/te\\u0073ting/bootstrap.js"] }\r\n// last line',
    '{ "x": "\\\\", "setup\\u0046iles": ["./src/te\\u0073ting/bootstrap.js"] } /* unterminated',
  ])("%j names the file", async (cfg) => {
    expectS6(await planJest({ "/r/jest.config.json": cfg }), "config-changed", `config file changed: ${BOOT}`);
  });

  it("a comment marker inside a string is kept; an unparseable package.json is skipped like jest skips it", async () => {
    expect(spec(await planJest({ "/r/jest.config.json": '{ "testEnvironment": "node // x /* y" }' }, ["src/a.js"])).inputs).toEqual(["/r/src/a.js"]);
    const pkg = '{ "name": "app", // not JSON\n "jest": { "setup\\u0046iles": ["./src/te\\u0073ting/bootstrap.js"] } }';
    expectS6(await planJest({ "/r/package.json": pkg }), "config-changed");
    expect(spec(await planJest({ "/r/sub/package.json": "{ nope", "/r/sub/b.js": "" }, ["sub/b.js"])).inputs).toEqual(["/r/sub/b.js"]);
  });
});

describe("QA-1.3-42: only references that can name a changed file are resolved", () => {
  const planJest = (cfg: string, paths: string[], extra: Record<string, string> = {}) =>
    planScopedRun(input({ command: "jest", files: jsRepo({}, { "/r/jest.config.js": cfg, ...extra }), changedFiles: changed(...paths) }));

  it("a config just under the limit, full of literals, plans quickly and still finds the real reference", async () => {
    const cfg = `module.exports = { setupFiles: [${"'a',".repeat(260000)} './tools/boot.js'] }`;
    expect(cfg.length).toBeLessThan(CONFIG_SIZE_LIMIT);
    const t0 = performance.now();
    expectS6(await planJest(cfg, ["tools/boot.js"], { "/r/tools/boot.js": "" }), "config-changed", "config file changed: tools/boot.js");
    expect(spec(await planJest(cfg, ["src/a.js"], { "/r/src/a.js": "" })).inputs).toEqual(["/r/src/a.js"]);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("distinct references that all end in a changed name are bounded; repeats count once", async () => {
    const boot = { "/r/tools/boot.js": "" };
    const many = Array.from({ length: SETUP_REF_LIMIT + 1 }, (_, i) => `"d${i}/boot"`).join(",");
    const why = (where: string) => `too many setup references in ${where} (limit ${SETUP_REF_LIMIT})`;
    expectS6(await planJest(`module.exports = { setupFiles: [${many}] }`, ["tools/boot.js"], boot), "config-too-large", why("/r/jest.config.js"));
    const inline = await planScopedRun(input({ command: `jest --config '{"setupFiles":[${many}]}'`, files: jsRepo({}, boot), changedFiles: changed("tools/boot.js") }));
    expectS6(inline, "config-too-large", why("the inline jest --config"));
    const same = Array.from({ length: SETUP_REF_LIMIT + 1 }, () => "'./tools/boot'").join(",");
    expectS6(await planJest(`module.exports = { setupFiles: [${same}] }`, ["tools/boot.js"], boot), "config-changed");
    // A rootDir multiplies the bases; the rest of the budget still covers a handful of references.
    expectS6(await planJest("module.exports = { rootDir: 'tools', setupFiles: ['<rootDir>/boot.js'] }", ["tools/boot.js"], boot), "config-changed");
  });

  it.each([
    ["<rootDir>", "index.js"],
    ["./tools/shim/", "tools/shim/index.js"],
    ["./tools/shim/.", "tools/shim/index.js"],
    ["./tools/shim/x/..", "tools/shim/index.js"],
    ["./tools/boot", "tools/boot.ts"],
  ])("reference %j still names %s", async (ref, f) => {
    expectS6(await planJest(`module.exports = { setupFiles: ['${ref}'] }`, [f], { [`/r/${f}`]: "" }), "config-changed", `config file changed: ${f}`);
  });

  it("win32: a backslash reference is split on either separator", async () => {
    const W = {
      ...Object.fromEntries(Object.entries(jsRepo()).map(([k, v]) => [k.replace(/^\/r/, "C:\\repo").replace(/\//g, "\\"), v])),
      "C:\\repo\\jest.config.js": "module.exports = { setupFiles: ['.\\\\Tools\\\\Env.js'] }",
      "C:\\repo\\tools\\env.js": "",
    };
    expectS6(await planScopedRun(input({ win: true, command: "jest", files: W, cwd: "C:\\repo", host: WIN_HOST, changedFiles: changed("tools\\env.js") })), "config-changed");
  });
});

describe("QA-1.3-39: -c, -o, -p and --rootdir in PYTEST_ADDOPTS count like the command's", () => {
  const H = (pytestAddopts: string): Partial<RunnerHost> => ({ ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts });
  const planPy = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed(...paths), ...over }));
  const CI = { "/r/ci/ci.ini": "[pytest]\npython_files = check_*.py\naddopts = -n 3\n", "/r/tests/check_math.py": "" };

  it("host PYTEST_ADDOPTS -c: python_files and the cap come from that file", async () => {
    const s = spec(await planPy(CI, ["tests/check_math.py"], { host: H("-c ci/ci.ini --rootdir=.") }));
    expect(s.inputs).toEqual(["/r/tests/check_math.py"]);
    expect(xdistArgs(s)).toEqual(["-n", "2"]);
    expectUnmapped(await planPy(CI, ["tests/check_math.py"]), "tests/check_math.py");
  });

  it("cross-env PYTEST_ADDOPTS -c through a package script", async () => {
    const files = { ...CI, "/r/package.json": JSON.stringify({ name: "p", scripts: { test: 'cross-env PYTEST_ADDOPTS="-c ci/ci.ini --rootdir=." pytest' } }) };
    const s = spec(await planPy(files, ["tests/check_math.py"], { command: "npm test" }));
    expect(s.inputs).toEqual(["/r/tests/check_math.py"]);
    expect(xdistArgs(s)).toEqual(["-n", "2"]);
  });

  it("the command's -c wins; a host value that cross-env replaces does not choose the config", async () => {
    const files = { ...CI, "/r/other.ini": "[pytest]\n" };
    expectUnmapped(await planPy(files, ["tests/check_math.py"], { command: "pytest -c other.ini", host: H("-c ci/ci.ini") }), "tests/check_math.py");
    expectUnmapped(await planPy(files, ["tests/check_math.py"], { command: "cross-env PYTEST_ADDOPTS=-q pytest", host: H("-c ci/ci.ini") }), "tests/check_math.py");
    expectUnmapped(await planPy(files, ["tests/check_math.py"], { command: "cross-env PYTEST_ADDOPTS= pytest", host: H("-c ci/ci.ini") }), "tests/check_math.py");
  });

  it("-o addopts= and -o python_files= in PYTEST_ADDOPTS override the config's keys", async () => {
    const files = { "/r/pytest.ini": "[pytest]\naddopts = -n 3\npython_files = 'open\n", "/r/tests/check_x.py": "" };
    const s = spec(await planPy(files, ["tests/check_x.py"], { host: H("-o addopts=-q -o python_files=check_*.py") }));
    expect(s.inputs).toEqual(["/r/tests/check_x.py"]);
    expect(xdistArgs(s)).toEqual([]);
    expectS6(await planPy(files, ["tests/check_x.py"]), "unsupported-argument", 'unsupported pytest argument "python_files" in /r/pytest.ini');
    const plain = { "/r/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/test_x.py": "" };
    expectS6(await planPy(plain, ["tests/test_x.py"], { host: H('-o "addopts=-n 2 \'x"') }), "unterminated-quote", "unterminated quote in -o addopts");
  });

  it("-p no:xdist in a host value that cross-env replaces disables nothing", async () => {
    const files = { "/r/tests/test_a.py": "" };
    expect(xdistArgs(spec(await planPy(files, ["tests/test_a.py"], { command: "cross-env PYTEST_ADDOPTS=-n4 pytest", host: H("-p no:xdist") })))).toEqual(["-n", "2"]);
    expect(xdistArgs(spec(await planPy(files, ["tests/test_a.py"], { command: "pytest -n 4", host: H("-p no:xdist") })))).toEqual([]);
  });

  it("a -c from PYTEST_ADDOPTS is a config trigger", async () => {
    expectS6(await planPy(CI, ["ci/ci.ini"], { host: H("-c ci/ci.ini") }), "config-changed", "config file changed: ci/ci.ini");
    expect((await detect("pytest -c ci/ci.ini", pyRepo(CI), H("-c ci/ci.ini"))).configFiles).toEqual(["/r/ci/ci.ini"]);
  });
});

describe("QA-1.3-40: pytest's per-argument config fallback (determine_setup)", () => {
  const H = (pytestAddopts: string): Partial<RunnerHost> => ({ ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts });
  const planPy = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed(...paths), ...over }));
  const BASE = { "/r/tests/a/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/a/test_w.py": "", "/r/tests/b/test_b.py": "" };
  const TWO = ["tests/a/test_w.py", "tests/b/test_b.py"];

  const AB = "pytest tests/a tests/b";
  /** The options between "--maxfail=0" and the "-n"/"--" the adapter appends: the QA-1.3-43 pin. */
  const pinOf = (s: ScopedSpec) => s.args.slice(s.args.indexOf("--maxfail=0") + 1, s.args.findIndex((x, i) => i > s.args.indexOf("--maxfail=0") && (x === "-n" || x === "--")));

  it("(a) path arguments: tests/a/pytest.ini decides python_files for tests/b, and the spec reads it too", async () => {
    const files = { "/r/tests/a/pytest.ini": "[pytest]\npython_files = check_*.py\n", "/r/tests/b/check_math.py": "" };
    const s = spec(await planPy(files, ["tests/b/check_math.py"], { command: AB }));
    expect(s.inputs).toEqual(["/r/tests/b/check_math.py"]);
    expect(pinOf(s)).toEqual(["-c", "/r/tests/a/pytest.ini", "--rootdir=/r/tests/a"]);
    expectUnmapped(await planPy(files, ["tests/b/check_math.py"], { command: "pytest tests/b" }), "tests/b/check_math.py");
  });

  it("(b) the user's plain pytest never falls back, and the pinned --rootdir keeps the spawn from falling back", async () => {
    const s = spec(await planPy(BASE, TWO));
    expect(pinOf(s)).toEqual(["--rootdir=/r"]);
    expect(xdistArgs(s)).toEqual([]);
    // With path arguments the user's run does fall back, and so does the pinned spec.
    const ab = spec(await planPy(BASE, TWO, { command: AB }));
    expect(pinOf(ab)).toEqual(["-c", "/r/tests/a/pytest.ini", "--rootdir=/r/tests/a"]);
    expect(xdistArgs(ab)).toEqual(["-n", "2"]);
    // planStaticScoping runs the same lookup (QA-1.3-27): a config only the fallback reads counts only when the user's run falls back.
    const bad = pyRepo({ ...BASE, "/r/tests/a/pytest.ini": "[pytest]\naddopts = tests\n" });
    expect(isUnverifiable(await planStaticScoping(input({ command: "pytest", files: bad, changedFiles: changed(...TWO) })))).toBe(false);
    const why = 'unsupported pytest argument "tests" in addopts of /r/tests/a/pytest.ini';
    expectS6(await planStaticScoping(input({ command: AB, files: bad, changedFiles: changed(...TWO) })), "unsupported-argument", why);
  });

  it("the first argument with a config wins, in the user's order", async () => {
    const files = { "/r/tests/a/pytest.ini": "[pytest]\n", "/r/tests/b/pytest.ini": "[pytest]\naddopts = -n 3\n", "/r/tests/a/test_w.py": "", "/r/tests/b/test_b.py": "" };
    expect(xdistArgs(spec(await planPy(files, TWO, { command: AB })))).toEqual([]);
    expect(xdistArgs(spec(await planPy(files, TWO, { command: "pytest tests/b tests/a" })))).toEqual(["-n", "2"]);
  });

  it("no fallback below a setup.py or with a --rootdir; an empty --rootdir is none", async () => {
    const withSetup = spec(await planPy({ ...BASE, "/r/setup.py": "" }, TWO, { command: AB }));
    expect([pinOf(withSetup), xdistArgs(withSetup)]).toEqual([["--rootdir=/r"], []]);
    const setupDir = { fs: statFs(pyRepo({ ...BASE, "/r/setup.py": "" }), false, {}, ["/r/setup.py"]), command: AB };
    expect(xdistArgs(spec(await planPy(BASE, TWO, setupDir)))).toEqual(["-n", "2"]);
    const given = spec(await planPy(BASE, TWO, { command: `${AB} --rootdir=/r` }));
    expect([pinOf(given), xdistArgs(given)]).toEqual([[], []]);
    expect(xdistArgs(spec(await planPy(BASE, TWO, { command: AB, host: H("--rootdir /r") })))).toEqual([]);
    const empty = spec(await planPy(BASE, TWO, { command: `${AB} --rootdir=` }));
    expect([pinOf(empty), xdistArgs(empty)]).toEqual([["-c", "/r/tests/a/pytest.ini", "--rootdir=/r/tests/a"], ["-n", "2"]]);
  });

  it("a table-less pyproject.toml stops pytest >= 8.1 only: when the releases then disagree, the spawn's own lookup must agree (QA-1.3-49)", async () => {
    const toml = { "/r/tests/a/pytest.toml": '[pytest]\naddopts = ["-n", "3"]\n', "/r/tests/a/test_w.py": "", "/r/tests/b/test_b.py": "" };
    // pytest 9 falls back to tests/a/pytest.toml, which pytest 8 and 7 do not know: two rootdirs.
    // The spawn's own arguments fall back the same way on every release, so nothing is pinned.
    const own = spec(await planPy(toml, TWO, { command: AB }));
    expect([pinOf(own), xdistArgs(own)]).toEqual([[], ["-n", "2"]]);
    // With only tests/b as input, the spawn's pytest 9 would not reach tests/a/pytest.toml.
    expectS6(await planPy(toml, ["tests/b/test_b.py"], { command: AB }), "unsupported-argument", "unsupported pytest rootdir: the pytest releases pick /r/tests/a or /r");
    const s = spec(await planPy({ ...toml, "/r/pyproject.toml": "[project]\n" }, TWO, { command: AB }));
    expect([pinOf(s), xdistArgs(s)]).toEqual([["--rootdir=/r"], []]);
    const base = { ...BASE, "/r/pyproject.toml": "[project]\n" };
    expect(pinOf(spec(await planPy(base, TWO, { command: AB })))).toEqual([]);
    expectS6(await planPy(base, ["tests/b/test_b.py"], { command: AB }), "unsupported-argument");
  });

  it("a bad config found by the fallback is S6", async () => {
    const files = { ...BASE, "/r/tests/a/pytest.ini": "[pytest]\npython_files = 'open\n" };
    expectS6(await planPy(files, TWO, { command: AB }), "unsupported-argument", 'unsupported pytest argument "python_files" in /r/tests/a/pytest.ini');
  });
});

describe("QA-1.3-43: the spec reads the config the user's run reads", () => {
  const planPy = (files: Record<string, string>, paths: string[], over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command: "pytest", files: pyRepo(files), changedFiles: changed(...paths), ...over }));
  const pinOf = (s: ScopedSpec) => s.args.slice(s.args.indexOf("--maxfail=0") + 1, s.args.indexOf("--"));

  it("(a) monorepo: a package pyproject.toml with a pytest table is not read by `pytest packages`", async () => {
    const files = {
      "/r/pyproject.toml": "[tool.pytest.ini_options]\nmarkers = ['integration']\n",
      "/r/packages/foo/pyproject.toml": "[tool.pytest.ini_options]\naddopts = \"-m 'not integration'\"\n",
      "/r/packages/foo/tests/test_x.py": "",
    };
    const s = spec(await planPy(files, ["packages/foo/tests/test_x.py"], { command: "pytest packages" }));
    expect(pinOf(s)).toEqual(["-c", "/r/pyproject.toml", "--rootdir=/r"]);
    // planStaticScoping and planRerun pin the same way.
    const { search: _s, ...st } = input({ command: "pytest packages", files: pyRepo(files), changedFiles: changed("packages/foo/tests/test_x.py") });
    expect(await planStaticScoping(st)).toMatchObject({ scopable: true });
    const det = await detect("pytest packages", pyRepo(files));
    const r = spec(await planRerun(det, ["/r/packages/foo/tests/test_x.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(pinOf(r)).toEqual(["-c", "/r/pyproject.toml", "--rootdir=/r"]);
  });

  it("(b) root pytest.ini plus tests/unit/pytest.ini: the root one is pinned", async () => {
    const files = { "/r/pytest.ini": "[pytest]\n", "/r/tests/unit/pytest.ini": "[pytest]\naddopts = -m \"not slow\"\n", "/r/tests/unit/test_s.py": "" };
    expect(pinOf(spec(await planPy(files, ["tests/unit/test_s.py"])))).toEqual(["-c", "/r/pytest.ini", "--rootdir=/r"]);
  });

  it("a rerun in a reference tree pins that tree's config, with the user's path arguments moved along", async () => {
    const files = { "/r/pytest.ini": "[pytest]\n", "/r/tests/test_a.py": "" };
    const det = await detect("pytest tests", pyRepo(files));
    const ref = { "/ref/.git": "", "/usr/bin/pytest": "", "/ref/tests/pytest.ini": "[pytest]\n", "/ref/pytest.ini": "[pytest]\n", "/ref/tests/test_a.py": "" };
    const r = spec(await planRerun(det, ["/ref/tests/test_a.py"], "/ref", { maxWorkers: 2 }, { fs: memFs(ref), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(pinOf(r)).toEqual(["-c", "/ref/tests/pytest.ini", "--rootdir=/ref/tests"]);
  });

  it("no config anywhere: only --rootdir; a nearer config or package pyproject.toml for the inputs is S6", async () => {
    expect(pinOf(spec(await planPy({ "/r/tests/test_a.py": "" }, ["tests/test_a.py"])))).toEqual(["--rootdir=/r"]);
    expectS6(await planPy({ "/r/tests/pyproject.toml": "[project]\n", "/r/tests/test_a.py": "" }, ["tests/test_a.py"]), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/tests/pyproject.toml instead of none");
  });

  it("a table-less pyproject.toml the user's run also takes is not pinned with -c while the inputs' lookup agrees, else it is (QA-1.3-49)", async () => {
    const files = { "/r/pyproject.toml": "[project]\n", "/r/tests/test_a.py": "" };
    expect(pinOf(spec(await planPy(files, ["tests/test_a.py"])))).toEqual(["--rootdir=/r"]);
    const nested = { ...files, "/r/tests/pyproject.toml": "[project]\n" };
    expect(pinOf(spec(await planPy(nested, ["tests/test_a.py"])))).toEqual(["-c", "/r/pyproject.toml", "--rootdir=/r"]);
    // pytest < 8.1 reads no inifile there and so cuts no conftest.py; the -c pin would cut one above the rootdir.
    const why = "unsupported pytest config for the scoped inputs: /r/tests/pyproject.toml instead of /r/pyproject.toml";
    expectS6(await planPy({ ...nested, "/conftest.py": "" }, ["tests/test_a.py"]), "unsupported-argument", why);
  });

  it("pytest.toml (pytest 9 only): no single file to pin, the inputs' lookup agrees release by release", async () => {
    const files = { "/r/pytest.toml": "[pytest]\n", "/r/tests/test_a.py": "" };
    expect(pinOf(spec(await planPy(files, ["tests/test_a.py"])))).toEqual(["--rootdir=/r"]);
    expectS6(await planPy({ ...files, "/r/tests/pytest.ini": "[pytest]\n" }, ["tests/test_a.py"]), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/tests/pytest.ini instead of /r/pytest.toml");
  });

  it("a -c or --rootdir the run already gives is honoured, never doubled", async () => {
    const files = { "/r/ci/ci.ini": "[pytest]\n", "/r/pytest.ini": "[pytest]\n", "/r/tests/test_a.py": "" };
    const c = spec(await planPy(files, ["tests/test_a.py"], { command: "pytest -c ci/ci.ini" }));
    expect(c.args.filter((x) => x === "-c" || x.startsWith("--rootdir"))).toEqual(["-c"]);
    const env = spec(await planPy(files, ["tests/test_a.py"], { host: { ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts: "-c ci/ci.ini" } }));
    expect(pinOf(env)).toEqual([]);
    const root = spec(await planPy(files, ["tests/test_a.py"], { command: "pytest --rootdir=/r" }));
    expect(root.args.filter((x) => x === "-c" || x.startsWith("--rootdir"))).toEqual(["--rootdir=/r", "-c"]);
    // A DetectedRunner built without pytestFacts still has them in its kept arguments.
    const { pytestFacts: _f, ...det } = await detect("pytest -c ci/ci.ini --rootdir=/r", pyRepo(files));
    const r = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(pinOf(r)).toEqual([]);
    const { pytestFacts: _g, ...plain } = await detect("pytest --tb=short", pyRepo(files));
    expect(pinOf(spec(await planRerun(plain, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } })))).toEqual(["-c", "/r/pytest.ini", "--rootdir=/r"]);
    expectS6(await planRerun({ ...plain, keptArgs: ["--bogus", "x"] }, ["/r/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(files)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }), "ambiguous-option");
  });

  it("a rootdir pytest would expand variables in is never pinned: S6 unless the spawn's own lookup agrees (QA-1.3-49)", async () => {
    const files = { "/r$x/.git": "", "/usr/bin/pytest": "", "/r$x/tests/test_a.py": "" };
    const plan = (f: Record<string, string>) => planScopedRun(input({ command: "pytest", cwd: "/r$x", files: f, changedFiles: changed("tests/test_a.py") }));
    expect(pinOf(spec(await plan(files)))).toEqual([]);
    expectS6(await plan({ ...files, "/r$x/tests/pyproject.toml": "[project]\n" }), "unsupported-argument", "unsupported pytest rootdir: pytest expands variables in /r$x");
    const W = { "C:\\r%x%\\.git": "", "C:\\bin\\pytest.exe": "", "C:\\r%x%\\tests\\test_a.py": "", "C:\\r%x%\\tests\\pyproject.toml": "[project]\n" };
    const w = await planScopedRun(input({ win: true, command: "pytest", cwd: "C:\\r%x%", files: W, host: { ...WIN_HOST, pathEnv: "C:\\bin" }, changedFiles: changed("tests\\test_a.py") }));
    expectS6(w, "unsupported-argument", "unsupported pytest rootdir: pytest expands variables in C:\\r%x%");
  });

  it("the rootdir is the common ancestor of cwd and the arguments, or the ancestor at a filesystem root", async () => {
    // Reachable through planRerun: planScopedRun only takes inputs below runnerCwd.
    const host = { ...POSIX_HOST, pathEnv: "/usr/bin" };
    const files = pyRepo({ "/r/sub/.keep": "", "/r/tests/test_a.py": "" });
    const det = await detect("pytest ../tests", files, POSIX_HOST, "/r/sub");
    const s = spec(await planRerun(det, ["/r/tests/test_a.py"], "/r/sub", { maxWorkers: 2 }, { fs: memFs(files), host }));
    expect(pinOf(s)).toEqual(["--rootdir=/r"]);
    const top = { "C:\\.git": "", "C:\\bin\\pytest.exe": "", "C:\\a\\test_a.py": "", "C:\\b\\.keep": "" };
    const wh = { ...WIN_HOST, tmpdir: "D:\\Temp", pathEnv: "C:\\bin" };
    const d2 = await detect("pytest ..\\a", top, wh, "C:\\b");
    const t = spec(await planRerun(d2, ["C:\\a\\test_a.py"], "C:\\b", { maxWorkers: 2 }, { fs: memFs(top, true), host: wh }));
    expect(pinOf(t)).toEqual(["--rootdir=C:\\a"]);
  });
});

describe("QA-1.3-47: the argv length is checked before the pytest config lookup", () => {
  it("2000 inputs in 2000 directories: S6 argv-too-long with a handful of fs checks", async () => {
    const paths = Array.from({ length: 2000 }, (_, i) => `d${i}/test_${i}.py`);
    const base = memFs(pyRepo(Object.fromEntries(paths.map((p) => [`/r/${p}`, ""]))));
    let calls = 0;
    const fs: FsSeam = { fileExists: (p) => (calls++, base.fileExists(p)), readFile: base.readFile };
    const why = "too many inputs for one command line: 2000 files";
    expectS6(await planScopedRun(input({ command: "pytest", fs, changedFiles: changed(...paths) })), "argv-too-long", why);
    expect(calls).toBeLessThan(2000 + 100);
    const { search: _s, ...st } = input({ command: "pytest", fs, changedFiles: changed(...paths) });
    expectS6(await planStaticScoping(st), "argv-too-long", why);
    const det = await detect("pytest", pyRepo(Object.fromEntries(paths.map((p) => [`/r/${p}`, ""]))));
    expectS6(await planRerun(det, paths.map((p) => `/r/${p}`), "/r", { maxWorkers: 2 }, { fs, host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }), "argv-too-long", why);
  });
});
describe("QA-1.3-44: setup files a project's own config names are triggers", () => {
  const BOOT = "packages/a/testing/boot.js";
  const plan = (command: string, extra: Record<string, string>, paths = [BOOT]) =>
    planScopedRun(input({ command, files: jsRepo({}, { [`/r/${BOOT}`]: "", "/r/src/a.js": "", ...extra }), changedFiles: changed(...paths) }));

  it("jest: packages/a/jest.config.js under the root config's projects", async () => {
    const extra = {
      "/r/jest.config.js": "module.exports = { projects: ['<rootDir>/packages/a'] };\n",
      "/r/packages/a/jest.config.js": "module.exports = { setupFilesAfterEnv: ['<rootDir>/testing/boot.js'] };\n",
    };
    expectS6(await plan("jest", extra), "config-changed", `config file changed: ${BOOT}`);
    expect(spec(await plan("jest", extra, ["src/a.js"])).inputs).toEqual(["/r/src/a.js"]);
  });

  it("vitest: packages/a/vitest.config.mjs under test.projects, and a deleted setup file", async () => {
    const extra = {
      "/r/vitest.config.mjs": "export default { test: { projects: ['packages/a'] } };\n",
      "/r/packages/a/vitest.config.mjs": "export default { test: { setupFiles: ['./testing/boot.js'] } };\n",
    };
    expectS6(await plan("vitest", extra), "config-changed", `config file changed: ${BOOT}`);
    const { [`/r/${BOOT}`]: _gone, ...rest } = jsRepo({}, { "/r/src/a.js": "", ...extra });
    expectS6(await planScopedRun(input({ files: rest, changedFiles: changed(BOOT) })), "config-changed", `config file changed: ${BOOT}`);
  });

  it("vitest: an inline project's literal root is a base", async () => {
    const extra = { "/r/vitest.config.ts": "export default defineConfig({ test: { projects: [{ test: { root: './packages/b', setupFiles: ['./boot/init.js'] } }] } });\n" };
    expectS6(await plan("vitest", { ...extra, "/r/packages/b/boot/init.js": "" }, ["packages/b/boot/init.js"]), "config-changed", "config file changed: packages/b/boot/init.js");
  });

  it("only modules are walked from: test files and non-JS files add no directory", async () => {
    const files = jsRepo({}, { "/r/a/b/c/x.test.js": "", "/r/a/b/c/notes.json": "", "/r/a/b/c/d.js": "" });
    const base = memFs(files);
    const probed: string[] = [];
    const fs: FsSeam = { fileExists: (p) => (/config/.test(p) && probed.push(p), base.fileExists(p)), readFile: base.readFile };
    spec(await planScopedRun(input({ fs, changedFiles: changed("a/b/c/x.test.js", "a/b/c/notes.json") })));
    expect(probed.filter((p) => p.startsWith("/r/a"))).toEqual([]);
    spec(await planScopedRun(input({ fs, changedFiles: changed("a/b/c/d.js") })));
    expect(new Set(probed.filter((p) => p.startsWith("/r/a")).map((p) => path.posix.dirname(p)))).toEqual(new Set(["/r/a/b/c", "/r/a/b", "/r/a"]));
  });

  it("the cheap S6s come first, so a large change reads no project config", async () => {
    const names = Array.from({ length: 400 }, (_, i) => `d${i}/${"x".repeat(80)}.ts`);
    const base = memFs(jsRepo({}, Object.fromEntries(names.map((n) => [`/r/${n}`, ""]))));
    let probes = 0;
    const fs: FsSeam = { fileExists: (p) => (/config/.test(p) && probes++, base.fileExists(p)), readFile: base.readFile };
    expectS6(await planScopedRun(input({ fs, changedFiles: changed(...names) })), "argv-too-long", "too many inputs for one command line: 400 files");
    const gone = Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => `g${i}/m.ts`);
    expectS6(await planScopedRun(input({ fs, changedFiles: changed(...gone) })), "too-many-searches");
    expect(probes).toBe(0);
  });
});

describe("QA-1.3-45: the jest --rootDir argument and scalar call values", () => {
  const BOOT = "src/testing/bootstrap.js";
  const planJest = (command: string, cfg: string, paths = [BOOT]) =>
    planScopedRun(input({ command, files: jsRepo({}, { [`/r/${BOOT}`]: "", "/r/src/a.js": "", "/r/jest.config.js": cfg }), changedFiles: changed(...paths) }));

  it.each(["jest --rootDir src", "jest --root-dir=src", "jest --rootDir=/r/src"])("(a) %s is a base and the <rootDir>", async (command) => {
    expectS6(await planJest(command, "module.exports = { setupFilesAfterEnv: ['<rootDir>/testing/bootstrap.js'] };"), "config-changed", `config file changed: ${BOOT}`);
    expectS6(await planJest(command, "module.exports = { setupFiles: ['testing/bootstrap'] };"), "config-changed");
  });

  it.each([
    "module.exports = { globalSetup: require.resolve('./src/testing/bootstrap.js') };",
    "module.exports = { globalSetup: path.resolve(__dirname, 'src/testing/bootstrap.js'), other: 1 };",
    "module.exports = { globalTeardown: process.env.CI ? './src/testing/bootstrap.js' : undefined };",
    "module.exports = { setupFiles: [['./nested'], /* c */ './src/testing/bootstrap.js'] };",
    "module.exports = { setupFiles: someList, globalSetup: `./src/testing/bootstrap.js` };",
  ])("(b) %s names the file", async (cfg) => {
    expectS6(await planJest("jest", cfg), "config-changed", `config file changed: ${BOOT}`);
  });

  it("(b) the value ends at the enclosing bracket, a template with ${}, or an unterminated string", async () => {
    expect(spec(await planJest("jest", "module.exports = { a: { globalSetup: x }, b: './src/testing/bootstrap.js' };")).inputs).toEqual([`/r/${BOOT}`]);
    expect(spec(await planJest("jest", "module.exports = { globalSetup: `./src/${d}/bootstrap.js` };")).inputs).toEqual([`/r/${BOOT}`]);
    expect(spec(await planJest("jest", "module.exports = { globalSetup: require('x\n'), b: './src/testing/bootstrap.js' };")).inputs).toEqual([`/r/${BOOT}`]);
    expect(spec(await planJest("jest", "module.exports = { globalSetup: 'unterminated")).inputs).toEqual([`/r/${BOOT}`]);
  });
});

describe("QA-1.3-48: plugin option values are path arguments of pytest's config lookup", () => {
  const host = (pytestAddopts = ""): Partial<RunnerHost> => ({ ...POSIX_HOST, pathEnv: "/usr/bin", pytestAddopts });
  const planPy = (files: Record<string, string>, command: string, over: Partial<PlanScopedRunInput> = {}) =>
    planScopedRun(input({ command, files: pyRepo(files), changedFiles: changed("tests/unit/test_s.py"), ...over }));
  const pinOf = (s: ScopedSpec) => s.args.slice(s.args.indexOf("--maxfail=0") + 1, s.args.indexOf("--"));
  // The QA layout: root pytest.ini, tests/unit/pytest.ini with -m "not slow", .coveragerc and src/.
  const FILES = {
    "/r/pytest.ini": "[pytest]\naddopts = -ra\n",
    "/r/tests/unit/pytest.ini": '[pytest]\naddopts = -m "not slow"\n',
    "/r/.coveragerc": "[run]\n",
    "/r/src": "",
    "/r/tests/unit/test_s.py": "",
  };
  const ROOT = ["-c", "/r/pytest.ini", "--rootdir=/r"];
  const UNIT = ["-c", "/r/tests/unit/pytest.ini", "--rootdir=/r/tests/unit"];

  it.each([
    ["pytest --cov src tests/unit", ROOT],
    ["pytest --cov=src --cov-config .coveragerc tests/unit", ROOT],
    ["pytest tests/unit --cov-report html --html src/r.html --cov src", ROOT],
    ["pytest --cov=src --cov-config=.coveragerc tests/unit", UNIT],
    ["pytest --cov missing tests/unit", UNIT],
    ["pytest --timeout -1 tests/unit", UNIT],
  ])("%s", async (command, pin) => {
    expect(pinOf(spec(await planPy(FILES, command)))).toEqual(pin);
  });

  it("the free arguments are kept in order, with a node id's :: part removed", async () => {
    const d = await detect("pytest --cov src::x tests/unit --timeout .coveragerc", pyRepo(FILES));
    expect(d.pytestFacts?.freeArgs).toEqual([
      { path: "/r/src", plugin: true, kept: false },
      { path: "/r/tests/unit", plugin: false, kept: true },
      { path: "/r/.coveragerc", plugin: true, kept: true },
    ]);
    expect(d.pathScopes).toEqual(["/r/tests/unit"]);
    expect((await detect("pytest tests/unit --timeout=5", pyRepo(FILES))).pytestFacts?.freeArgs).toBeUndefined();
  });

  it("PYTEST_ADDOPTS values count, before the command's; planStaticScoping and planRerun agree", async () => {
    expect(pinOf(spec(await planPy(FILES, "pytest tests/unit", { host: host("--cov-config .coveragerc") })))).toEqual(ROOT);
    expect(pinOf(spec(await planPy(FILES, "pytest tests/unit", { host: host("--cov-config=.coveragerc") })))).toEqual(UNIT);
    // The nested config is read only when src is not a free argument: its positional is S6 then.
    const bad = pyRepo({ ...FILES, "/r/tests/unit/pytest.ini": "[pytest]\naddopts = tests\n" });
    const st = (command: string) => {
      const { search: _s, ...rest } = input({ command, files: bad, changedFiles: changed("tests/unit/test_s.py") });
      return planStaticScoping(rest);
    };
    expect(await st("pytest --cov src tests/unit")).toMatchObject({ scopable: true });
    expectS6(await st("pytest --cov=src tests/unit"), "unsupported-argument", 'unsupported pytest argument "tests" in addopts of /r/tests/unit/pytest.ini');
    const det = await detect("pytest --cov src tests/unit", pyRepo(FILES));
    const ref = Object.fromEntries(Object.entries(pyRepo(FILES)).map(([k, v]) => [k.replace(/^\/r\//, "/ref/"), v]));
    const r = spec(await planRerun(det, ["/ref/tests/unit/test_s.py"], "/ref", { maxWorkers: 2 }, { fs: memFs(ref), host: host() }));
    expect(pinOf(r)).toEqual(["-c", "/ref/pytest.ini", "--rootdir=/ref"]);
    // The value is looked up in the reference tree: gone there, it does not count.
    const { "/ref/src": _gone, ...noSrc } = ref;
    const g = spec(await planRerun(det, ["/ref/tests/unit/test_s.py"], "/ref", { maxWorkers: 2 }, { fs: memFs(noSrc), host: host() }));
    expect(pinOf(g)).toEqual(["-c", "/ref/tests/unit/pytest.ini", "--rootdir=/ref/tests/unit"]);
  });

  it("the spawn's lookup sees the values of the plugin options it keeps and of PYTEST_ADDOPTS", async () => {
    // setup.py fixes the user's rootdir at /r with no inifile; from tests alone pytest >= 8.1 would take tests/pyproject.toml.
    const files = { "/r/setup.py": "", "/r/tests/pyproject.toml": "[project]\n", "/r/lib": "", "/r/tests/test_a.py": "" };
    const plan = (command: string, over: Partial<PlanScopedRunInput> = {}) => planScopedRun(input({ command, files: pyRepo(files), changedFiles: changed("tests/test_a.py"), ...over }));
    expect(pinOf(spec(await plan("pytest --timeout lib tests")))).toEqual(["--rootdir=/r"]);
    expect(pinOf(spec(await plan("pytest tests", { host: host("--cov lib") })))).toEqual(["--rootdir=/r", "--no-cov"]);
    // --cov is dropped from the spec, so the spawn looks from tests and finds its pyproject.toml.
    expectS6(await plan("pytest --cov lib tests"), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/tests/pyproject.toml instead of none");
  });
});

describe("QA-1.3-49: a package pyproject.toml without a pytest table", () => {
  const planPy = (files: Record<string, string>, command: string, paths: string[]) =>
    planScopedRun(input({ command, files: pyRepo(files), changedFiles: changed(...paths) }));
  const pinOf = (s: ScopedSpec) => s.args.slice(s.args.indexOf("--maxfail=0") + 1, s.args.indexOf("--"));
  const UV = {
    "/r/pyproject.toml": "[project]\nname = 'ws'\n\n[tool.uv.workspace]\nmembers = ['packages/*']\n",
    "/r/packages/a/pyproject.toml": "[project]\nname = 'a'\n",
    "/r/packages/a/tests/test_a.py": "",
  };
  const A = ["packages/a/tests/test_a.py"];
  const BACKEND = { "/r/backend/pyproject.toml": "[project]\nname = 'backend'\n", "/r/backend/tests/test_a.py": "" };
  const B = ["backend/tests/test_a.py"];

  it("(i) uv workspace, `pytest`: the root pyproject.toml is pinned with -c", async () => {
    expect(pinOf(spec(await planPy(UV, "pytest", A)))).toEqual(["-c", "/r/pyproject.toml", "--rootdir=/r"]);
    const { search: _s, ...st } = input({ command: "pytest", files: pyRepo(UV), changedFiles: changed(...A) });
    expect(await planStaticScoping(st)).toMatchObject({ scopable: true });
    // A --rootdir the run gives leaves no rootdir to check the file's directory against.
    expectS6(await planPy(UV, "pytest --rootdir=/r", A), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/packages/a/pyproject.toml instead of /r/pyproject.toml");
  });

  it("(ii) `pytest packages/a` and (iii) `pytest backend`: the spawn's own lookup matches, nothing is pinned", async () => {
    expect(pinOf(spec(await planPy(UV, "pytest packages/a", A)))).toEqual([]);
    expect(pinOf(spec(await planPy(BACKEND, "pytest backend", B)))).toEqual([]);
    const det = await detect("pytest packages/a", pyRepo(UV));
    const r = spec(await planRerun(det, ["/r/packages/a/tests/test_a.py"], "/r", { maxWorkers: 2 }, { fs: memFs(pyRepo(UV)), host: { ...POSIX_HOST, pathEnv: "/usr/bin" } }));
    expect(pinOf(r)).toEqual([]);
  });

  it("(iv) `pytest` with only backend/pyproject.toml stays S6", async () => {
    expectS6(await planPy(BACKEND, "pytest", B), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/backend/pyproject.toml instead of none");
  });

  it("no -c pin for a table-less pyproject.toml when a release reads an accepted config", async () => {
    const files = { "/r/pytest.toml": "[pytest]\n", "/r/pyproject.toml": "[project]\n", "/r/tests/pytest.ini": "[pytest]\n", "/r/tests/test_a.py": "" };
    expectS6(await planPy(files, "pytest", ["tests/test_a.py"]), "unsupported-argument", "unsupported pytest config for the scoped inputs: /r/tests/pytest.ini instead of /r/pytest.toml");
  });
});

describe("QA-1.3-50: a path built from several literals in one call", () => {
  const BOOT = "src/testing/bootstrap.js";
  const plan = (command: string, cfg: string, cfgName = "jest.config.js", extra: Record<string, string> = {}) =>
    planScopedRun(input({ command, files: jsRepo({}, { [`/r/${BOOT}`]: "", "/r/src/a.js": "", [`/r/${cfgName}`]: cfg, ...extra }), changedFiles: changed(BOOT) }));

  it.each([
    "module.exports = { globalSetup: path.join(__dirname, 'src', 'testing', 'bootstrap.js') };",
    "module.exports = { globalSetup: path.resolve(__dirname, 'src/testing', 'bootstrap.js') };",
    "module.exports = { setupFiles: [path.join(process.cwd(), 'src', 'testing', 'bootstrap')] };",
    "module.exports = { globalSetup: path.join(__dirname, /* dir */ 'src', 'testing', 'bootstrap.js',) };",
    "module.exports = { globalSetup: path.resolve('src', 'testing', 'bootstrap.js') };",
    "export default { globalSetup: path.join(import.meta.dirname, 'src', 'testing', 'bootstrap.js') };",
  ])("anchored: %s", async (cfg) => {
    expectS6(await plan("jest", cfg), "config-changed", `config file changed: ${BOOT}`);
  });

  it.each([
    "module.exports = { globalSetup: path.join(ROOT, 'testing', 'bootstrap.js') };",
    "module.exports = { globalSetup: path.join(here(), '..', 'testing', 'bootstrap.js') };",
    "module.exports = { globalSetup: path.join(__dirname, 'src', dir, 'bootstrap.js') };",
    "module.exports = { globalSetup: path.join(`${root}`, '<rootDir>', 'testing', 'bootstrap') };",
  ])("floating, matched by the path tail: %s", async (cfg) => {
    expectS6(await plan("jest", cfg), "config-changed", `config file changed: ${BOOT}`);
  });

  it("vitest: setupFiles joined the same way, and a directory index", async () => {
    const cfg = "export default { test: { setupFiles: [path.resolve(__dirname, 'src', 'testing', 'bootstrap.js')] } };";
    expectS6(await plan("vitest", cfg, "vitest.config.mjs"), "config-changed", `config file changed: ${BOOT}`);
    const idx = "export default { test: { setupFiles: [path.resolve(base, 'src', 'boot')] } };";
    const r = await planScopedRun(input({ files: jsRepo({}, { "/r/src/boot/index.js": "", "/r/vitest.config.mjs": idx }), changedFiles: changed("src/boot/index.js") }));
    expectS6(r, "config-changed", "config file changed: src/boot/index.js");
  });

  it.each([
    "module.exports = { globalSetup: path.join(ROOT, 'other', 'bootstrap.js') };",
    "module.exports = { globalSetup: path.join(__dirname, 'lib', 'bootstrap.js') };",
    "module.exports = { setupFiles: ['src', 'testing/bootstrap.js'] };",
    "module.exports = { globalSetup: path.join(ROOT, '..'), setupFiles: f() };",
  ])("no false trigger: %s", async (cfg) => {
    expect(spec(await plan("jest", cfg)).inputs).toEqual([`/r/${BOOT}`]);
  });

  it("floating tails count against SETUP_REF_LIMIT", async () => {
    const calls = Array.from({ length: SETUP_REF_LIMIT + 1 }, (_, i) => `path.join(x, 'd${i}', 'bootstrap.js')`).join(", ");
    expectS6(await plan("jest", `module.exports = { setupFiles: [${calls}] };`), "config-too-large", `too many setup references in /r/jest.config.js (limit ${SETUP_REF_LIMIT})`);
  });
});

describe("QA-1.3-51: the JS config probe lists each directory once", () => {
  /** memFs plus a readdir derived from its paths; `listed` records every call, `over` replaces a listing. */
  function listingFs(files: Record<string, string>, over: Record<string, string[] | "reject"> = {}) {
    const base = memFs(files);
    const listed: string[] = [];
    const probed: string[] = [];
    const fs: PlannerFs = {
      fileExists: (p) => (/config/.test(p) && probed.push(p), base.fileExists(p)),
      readFile: base.readFile,
      readdir: async (dir) => {
        listed.push(dir);
        const o = over[dir];
        if (o === "reject") throw new Error(`EACCES ${dir}`);
        if (o) return o;
        return [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]))];
      },
    };
    return { fs, listed, probed };
  }
  const CFG = "export default { test: { setupFiles: ['./boot/init.js'] } };\n";
  const files = jsRepo({}, { "/r/a/b/c/d.js": "", "/r/a/b/vitest.config.mjs": CFG, "/r/a/b/boot/init.js": "" });

  it("one listing per directory and plan, no fileExists per config name, same triggers", async () => {
    const { fs, listed, probed } = listingFs(files);
    spec(await planScopedRun(input({ fs, changedFiles: changed("a/b/c/d.js") })));
    expect(probed).toEqual([]);
    expect([...listed].sort()).toEqual(["/r", "/r/a", "/r/a/b", "/r/a/b/c"]);
    listed.length = 0;
    const { search: _s, ...st } = input({ fs, changedFiles: changed("a/b/boot/init.js", "a/b/c/d.js") });
    expectS6(await planStaticScoping(st), "config-changed", "config file changed: a/b/boot/init.js");
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("a name listed only in another case is what fileExists says; an unlistable directory falls back to fileExists", async () => {
    const f = jsRepo({}, { "/r/a/vitest.config.mjs": "export default { test: { setupFiles: ['./init.js'] } };\n", "/r/a/init.js": "" });
    const plan = (fs: PlannerFs) => planScopedRun(input({ fs, changedFiles: changed("a/init.js") }));
    // A case-insensitive file system: the listing spells it Vitest.config.mjs, fileExists finds vitest.config.mjs.
    expectS6(await plan(listingFs(f, { "/r/a": ["Vitest.config.mjs", "init.js"] }).fs), "config-changed", "config file changed: a/init.js");
    // A case-sensitive one: vitest looks for vitest.config.mjs and does not find Vitest.config.mjs.
    const { "/r/a/vitest.config.mjs": cfg, ...rest } = f;
    const upper = { ...rest, "/r/a/Vitest.config.mjs": cfg };
    expect(spec(await plan(listingFs(upper).fs)).inputs).toEqual(["/r/a/init.js"]);
    const { fs, probed } = listingFs(f, { "/r/a": "reject" });
    expectS6(await plan(fs), "config-changed", "config file changed: a/init.js");
    expect(probed.filter((p) => p.startsWith("/r/a/"))).toContain("/r/a/vitest.config.mjs");
  });
});