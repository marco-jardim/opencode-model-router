// Materialises one of the e2e fixture projects (test/fixtures/projects/*) into a throwaway git
// repository with its dependencies installed (plan §3.1.1). Plain node APIs only: every child
// process is spawned with an argv array and no shell; the only cmd.exe use is the Windows npm
// fallback, whose arguments are constants.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type FixtureName = "vitest-app" | "jest-app" | "pytest-app";

export interface FixtureRepo {
  dir: string;
  name: FixtureName;
  /** The command the router is asked to verify with ("npm test" or "uv run pytest"). */
  testCommand: string;
  write(rel: string, content: string): Promise<void>;
  remove(rel: string): Promise<void>;
  git(...args: string[]): string;
  commit(msg: string): string;
  head(): string;
  sentinelPath: string;
  dispose(): Promise<void>;
}

const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/projects/", import.meta.url));

interface FixtureSpec {
  testCommand: string;
  kind: "node" | "python";
  /** Pre-existing failure: source under extra/ and destination in the collected test dir. */
  extraFrom: string;
  extraTo: string;
}

const SPECS: Record<FixtureName, FixtureSpec> = {
  "vitest-app": {
    testCommand: "npm test",
    kind: "node",
    extraFrom: "extra/preexisting.test.js",
    extraTo: "test/preexisting.test.js",
  },
  "jest-app": {
    testCommand: "npm test",
    kind: "node",
    extraFrom: "extra/preexisting.test.js",
    extraTo: "test/preexisting.test.js",
  },
  "pytest-app": {
    testCommand: "uv run pytest",
    kind: "python",
    extraFrom: "extra/test_preexisting.py",
    extraTo: "tests/test_preexisting.py",
  },
};

export function e2eEnabled(): boolean {
  return process.env.RUN_VERIFY_E2E === "1";
}

/** How to launch npm without a shell: node + npm-cli.js, else `cmd.exe /d /s /c npm` on Windows. */
export function npmInvocation(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) return { command: process.execPath, prefix: [cli] };
  return { command: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/s", "/c", "npm"] };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs a command (argv array, no shell) and captures its output. */
export function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 300_000,
  env: NodeJS.ProcessEnv = process.env,
): RunResult {
  const start = Date.now();
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  const err = r.error ? `\n${String(r.error)}` : "";
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "") + err, ms: Date.now() - start };
}

export function runNpm(args: string[], cwd: string, timeoutMs?: number): RunResult {
  const { command, prefix } = npmInvocation();
  return run(command, [...prefix, ...args], cwd, timeoutMs);
}

/** Runs a fixture's own test command in `dir` (no shell). */
export function runFixtureTests(repo: Pick<FixtureRepo, "dir" | "testCommand">, timeoutMs?: number): RunResult {
  const [head, ...rest] = repo.testCommand.split(" ");
  if (head === "npm") return runNpm(rest, repo.dir, timeoutMs);
  return run(head, rest, repo.dir, timeoutMs);
}

export function toolAvailable(tool: "uv" | "npm" | "git"): boolean {
  const r = tool === "npm" ? runNpm(["--version"], process.cwd(), 30_000) : run(tool, ["--version"], process.cwd(), 30_000);
  return r.status === 0;
}

function must(r: RunResult, what: string): RunResult {
  if (r.status !== 0) {
    throw new Error(`${what} failed (exit ${String(r.status)})\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

/** One line of a runner probe log (see installRunnerProbe). */
export interface ProbeEntry {
  /** "main": the runner's main process (vitest/jest globalSetup, pytest_configure); "setupAfterEnv": jest.setup.js ran in a worker. */
  kind: "main" | "setupAfterEnv";
  t: number /* ms since the epoch, when the hook ran */;
  pid: number;
  cwd: string;
  argv: string[];
}

/** Reads a probe log; a missing log is an empty one. */
export function readProbeLog(file: string): ProbeEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => JSON.parse(l) as ProbeEntry);
}

/**
 * QA-3.1-9: makes every runner main process of the copy append one JSON line (ProbeEntry) to
 * `log`, a path outside the repo (so the probe never shows up as a tree change). vitest: a
 * `globalSetup` module; jest: a `globalSetup` module plus a line from the fixture's own
 * `jest.setup.js` (setupFilesAfterEnv, QA-3.1-15 b); pytest: a `pytest_configure` hook appended to
 * tests/conftest.py. The files are written before the fixture's first commit, so they are part of
 * every base and of every reference worktree (whose runs log their own cwd).
 */
async function installRunnerProbe(dir: string, name: FixtureName, log: string): Promise<void> {
  const L = JSON.stringify(log);
  const append = async (rel: string, text: string): Promise<void> => {
    await writeFile(join(dir, rel), readFileSync(join(dir, rel), "utf8") + text, "utf8");
  };
  const jsLine = (kind: ProbeEntry["kind"]): string =>
    `JSON.stringify({ kind: ${JSON.stringify(kind)}, t: Date.now(), pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n"`;
  if (name === "vitest-app") {
    await writeFile(
      join(dir, "argv-probe.js"),
      `// e2e probe (QA-3.1-9): one line per vitest main process.\nimport { appendFileSync } from "node:fs";\nexport default function setup() {\n  appendFileSync(${L}, ${jsLine("main")});\n}\n`,
      "utf8",
    );
    const cfg = readFileSync(join(dir, "vitest.config.js"), "utf8");
    const anchor = 'environment: "node",';
    if (!cfg.includes(anchor)) throw new Error(`vitest.config.js lacks ${anchor}`);
    await writeFile(join(dir, "vitest.config.js"), cfg.replace(anchor, `${anchor}\n    globalSetup: ["./argv-probe.js"],`), "utf8");
  } else if (name === "jest-app") {
    await writeFile(
      join(dir, "argv-probe.js"),
      `// e2e probe (QA-3.1-9): one line per jest main process.\nconst { appendFileSync } = require("node:fs");\nmodule.exports = async function setup() {\n  appendFileSync(${L}, ${jsLine("main")});\n};\n`,
      "utf8",
    );
    const cfg = readFileSync(join(dir, "jest.config.js"), "utf8");
    const anchor = 'testEnvironment: "node",';
    if (!cfg.includes(anchor)) throw new Error(`jest.config.js lacks ${anchor}`);
    await writeFile(join(dir, "jest.config.js"), cfg.replace(anchor, `${anchor}\n  globalSetup: "<rootDir>/argv-probe.js",`), "utf8");
    await append("jest.setup.js", `\n// e2e probe (QA-3.1-15 b): this setup file ran.\nrequire("node:fs").appendFileSync(${L}, ${jsLine("setupAfterEnv")});\n`);
  } else {
    await append(
      "tests/conftest.py",
      [
        "",
        "",
        "# e2e probe (QA-3.1-9): one line per pytest main process.",
        "def pytest_configure(config):",
        "    import json, os, sys, time",
        `    with open(${L}, "a", encoding="utf-8") as fh:`,
        '        fh.write(json.dumps({"kind": "main", "t": int(time.time() * 1000), "pid": os.getpid(), "cwd": os.getcwd(), "argv": sys.argv[1:]}) + "\\n")',
        "",
      ].join("\n"),
    );
  }
}

export async function prepareFixtureRepo(
  name: FixtureName,
  opts: {
    root: string;
    preexisting?: boolean;
    /** QA-3.1-9: install a runner probe logging to this file (see installRunnerProbe). */
    probeLog?: string;
  },
): Promise<FixtureRepo> {
  const spec = SPECS[name];
  const src = join(FIXTURES_DIR, name);
  const dir = join(opts.root, `${name}-${randomBytes(4).toString("hex")}`);
  await mkdir(opts.root, { recursive: true });
  await cp(src, dir, {
    recursive: true,
    filter: (p) => {
      const b = basename(p);
      return b !== "node_modules" && b !== ".venv" && b !== "__pycache__" && b !== ".pytest_cache";
    },
  });

  const git = (...args: string[]): string => must(run("git", args, dir, 60_000), `git ${args.join(" ")}`).stdout.trim();
  const head = (): string => git("rev-parse", "HEAD");
  const commit = (msg: string): string => {
    git("add", "-A");
    git("commit", "-q", "--no-verify", "-m", msg);
    return head();
  };

  if (opts.probeLog !== undefined) await installRunnerProbe(dir, name, opts.probeLog);

  git("init", "-q");
  git("config", "core.autocrlf", "false");
  git("config", "user.name", "omr e2e");
  git("config", "user.email", "omr-e2e@example.invalid");
  git("config", "commit.gpgsign", "false");
  commit("fixture");

  let sentinelPath: string;
  if (spec.kind === "node") {
    const args = ["ci", "--prefer-offline", "--no-audit", "--no-fund"];
    const cache = process.env.OMR_E2E_NPM_CACHE;
    if (cache) args.push("--cache", cache);
    must(runNpm(args, dir), `npm ${args.join(" ")} (${name})`);
    sentinelPath = join(dir, "node_modules", ".omr-e2e-sentinel");
  } else {
    must(run("uv", ["sync"], dir), `uv sync (${name})`);
    sentinelPath = join(dir, ".venv", ".omr-e2e-sentinel");
  }
  await writeFile(sentinelPath, "omr e2e sentinel\n", "utf8");

  const write = async (rel: string, content: string): Promise<void> => {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, "utf8");
  };
  const remove = async (rel: string): Promise<void> => {
    await rm(join(dir, rel), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  if (opts.preexisting) {
    await cp(join(dir, spec.extraFrom), join(dir, spec.extraTo));
    commit("preexisting failure");
  }

  const dispose = async (): Promise<void> => {
    // Phase 1.5 safety rule: never recurse through a node_modules junction/symlink into its target.
    const nm = join(dir, "node_modules");
    const st = await lstat(nm).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return undefined;
      throw e;
    });
    if (st?.isSymbolicLink()) await unlink(nm);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };

  return { dir, name, testCommand: spec.testCommand, write, remove, git, commit, head, sentinelPath, dispose };
}
