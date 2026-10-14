import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundRuns, createIntegrateGit, createIntegrationChecks, type ResolvedCommand } from "../../src/executor/integrate/checks";
import { createPhaseSuiteRunner } from "../../src/executor/integrate/phase-suite";
import type { StepJournal } from "../../src/executor/integrate/queue";
import { createRunResolver } from "../../src/executor/integrate/run-resolver";
import type { GitOps } from "../../src/executor/git";
import { registerSlot, unregisterSlot } from "../../src/executor/slots/env";
import type { Clock, LedgerV1, SlotLease, SlotPool, SlotRecord } from "../../src/executor/types";
import { gitEnvironment, gitExecutable, hardeningArgs } from "../../src/router/git-tools";
import type { RunConfig } from "../../src/router/roles";
import { runArgv } from "../../src/verify/exec";
import { removeDirWhenReleased } from "../helpers/remove-dir";

const stub = <T>(value: Partial<T>): T => value as T;
const roots: string[] = [];
const registered: string[] = [];
afterEach(async () => {
  for (const root of registered.splice(0)) unregisterSlot(root);
  for (const root of roots.splice(0)) await removeDirWhenReleased(root);
});

function gitResult(cwd: string, args: readonly string[]) {
  const result = spawnSync(gitExecutable(), [...hardeningArgs(), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnvironment(), encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.error !== undefined) throw result.error;
  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, durationMs: 0, truncated: false };
}
function git(cwd: string, ...args: string[]): string {
  const result = gitResult(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Probe { executable: string; cwd: string; path: string; venv: string; pythonpath: string | null; source: string }

async function fixture(setting: "auto" | "configured" = "configured") {
  await mkdir(resolve("tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(join(resolve("tmp"), "execution-slot-")));
  roots.push(root);
  const repo = join(root, "repo"), integration = join(root, "integration"), ciPath = join(root, "ci");
  await mkdir(repo);
  git(repo, "init", "-q");
  // A real executable stands in for Python, so this test needs no installed pytest. Like an editable install,
  // its imports read the checkout owning the interpreter, not cwd: a stale integration binary cannot pass as CI.
  await writeFile(join(repo, "probe.cjs"), [
    "const fs = require('node:fs'), path = require('node:path');",
    "const imports = path.resolve(path.dirname(process.execPath), '..', '..');",
    "console.log(JSON.stringify({ executable: process.execPath, cwd: process.cwd(), path: process.env.PATH ?? process.env.Path,",
    "  venv: process.env.VIRTUAL_ENV, pythonpath: process.env.PYTHONPATH ?? null, source: fs.readFileSync(path.join(imports, 'source.txt'), 'utf8') }));",
    "process.exit(fs.existsSync(path.join(imports, 'regression.txt')) ? 1 : 0);",
  ].join("\n"));
  const pkg = (historical: boolean) => JSON.stringify({ scripts: { test: "python probe.cjs", ...(historical ? { historical: "node probe.cjs" } : {}) } });
  await writeFile(join(repo, "package.json"), pkg(false));
  await writeFile(join(repo, "source.txt"), "base");
  const commit = (message: string): string => { git(repo, "add", "."); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); };
  const c0 = commit("base");
  await writeFile(join(repo, "source.txt"), "c1");
  const c1 = commit("first [plan:T1]");
  await writeFile(join(repo, "regression.txt"), "broken");
  const c2 = commit("regression [plan:T2]");
  await writeFile(join(repo, "source.txt"), "c3");
  await writeFile(join(repo, "package.json"), pkg(true));
  const c3 = commit("third [plan:T3]");
  await writeFile(join(repo, "source.txt"), "advanced-integration");
  const c9 = commit("integration advanced");
  git(repo, "worktree", "add", "--detach", integration, c9);
  git(repo, "worktree", "add", "--detach", ciPath, c9);
  const binDir = (cwd: string): string => join(cwd, ".venv", process.platform === "win32" ? "Scripts" : "bin");
  const binary = (cwd: string): string => join(binDir(cwd), process.platform === "win32" ? "python.exe" : "python");
  for (const cwd of [integration, ciPath]) {
    await mkdir(binDir(cwd), { recursive: true });
    await copyFile(process.execPath, binary(cwd));
    const info = await stat(binary(cwd));
    registerSlot({ root: cwd, managers: ["pip", "npm"], bins: [{ path: binary(cwd), size: info.size, mtimeMs: info.mtimeMs }] });
    registered.push(cwd);
  }
  const config: RunConfig = { scripts: ["historical"], commands: { test: { argv: ["python", "probe.cjs"] }, suite: { argv: ["python", "probe.cjs"] } }, timeoutMs: 10_000 };
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = ""; // No host Python fallback may hide a rejected/missing registered binary.
  const resolver = createRunResolver(() => config, { platform: process.platform, env });
  const ledger = stub<LedgerV1>({ planId: "plan", integration: stub<LedgerV1["integration"]>({ worktree: integration }),
    config: stub<LedgerV1["config"]>({ integrationChecks: "auto", python: "auto", phaseSuite: setting === "auto" ? "auto" : [{ script: "suite", args: [] }] }) });
  const ci: SlotLease = { slot: "ci", path: ciPath, planId: "plan", owner: "ci", commit: c9 };
  const intSlot: SlotLease = { ...ci, slot: "integration", path: integration, owner: "integration" };
  const prepared: Array<{ cwd: string; commit: string }> = [];
  const pool = stub<SlotPool>({
    reset: async (slot, sha) => {
      const cwd = slot === "ci" ? ciPath : integration;
      git(cwd, "reset", "--hard", sha);
      prepared.push({ cwd, commit: sha });
    },
    cleanForChecks: async () => {}, // The probe writes nothing; the provisioned, untracked binaries must survive resets.
    list: async () => [ci, intSlot].map(s => stub<SlotRecord>({ path: s.path })),
  });
  const ops = stub<GitOps>({
    revParse: async (cwd, ref) => git(cwd, "rev-parse", ref),
    revert: async (cwd, sha, message) => {
      git(cwd, "revert", "--no-commit", sha);
      git(cwd, "commit", "-qm", message);
      return { ok: true, head: git(cwd, "rev-parse", "HEAD") };
    },
  });
  const guard = { assertWriteCwd: async () => {} };
  const igit = createIntegrateGit({ run: async (args, opts) => gitResult(opts.cwd, args) }, guard);
  const background = new BackgroundRuns(), clock = stub<Clock>({ now: () => Date.now() }), logger = { warn: () => {} };
  const executed: Array<{ command: ResolvedCommand; commit: string; probe: Probe }> = [];
  const checks = createIntegrationChecks({ ledger: () => ledger, pool, git: ops, igit, resolver, guard, background, clock, logger,
    preemptForeground: async () => {}, acquire: async () => ({ lost: false, release: async () => {} }),
    spawn: async (command, opts) => {
      const cwd = command.cwd ?? opts.cwd;
      const result = await runArgv(command.file, command.args, { ...opts, cwd, env: command.env, timeoutMs: 10_000 });
      expect(result.stderr).toBe("");
      executed.push({ command, commit: git(cwd, "rev-parse", "HEAD"), probe: JSON.parse(result.stdout) as Probe });
      return { exitCode: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, durationMs: 0 };
    },
  });
  const runner = createPhaseSuiteRunner({ checks, igit, git: ops, pool, resolver, background, clock, logger });
  const journal = (): StepJournal => ({
    entry: { id: "i-1", kind: "phase-suite", phaseId: "p1", taskIds: [], slot: "ci", baseHead: c0, candidate: null },
    signal: new AbortController().signal, start: async () => {}, end: async () => {}, counter: () => {}, ...guard,
  });
  const selected = await runner.resolve(ledger, "p1", c3);
  if (selected.kind !== "runs") throw new Error(`suite resolution: ${JSON.stringify(selected)}`);
  return { runner, checks, resolver, journal, commands: selected.commands, ci, intSlot, prepared, executed, binary, binDir,
    c0, c1, c2, c3, c9, integration, ciPath };
}

describe("prepared execution-slot command resolution", () => {
  it.each(["auto", "configured"] as const)("uses the registered %s suite/base/bisect/revert binary and environment, not integration's install", async setting => {
    const f = await fixture(setting);
    const original = JSON.stringify(f.commands);
    expect(f.commands[0]).toMatchObject({ file: f.binary(f.integration), resolution: { cwd: f.integration, env: { VIRTUAL_ENV: join(f.integration, ".venv") } } });
    const verdict = await f.runner.run({ planId: "plan", phaseId: "p1", slot: f.ci, commit: f.c3, base: f.c0, commands: f.commands,
      ranges: [{ taskId: "T1", from: f.c0, to: f.c1 }, { taskId: "T2", from: f.c1, to: f.c2 }, { taskId: "T3", from: f.c2, to: f.c3 }] }, f.journal());
    expect(verdict).toEqual({ kind: "culprit", range: { taskId: "T2", from: f.c1, to: f.c2 }, ids: [], files: [] });
    expect(f.executed.map(r => r.commit)).toEqual([f.c3, f.c3, f.c3, f.c0, f.c2, f.c1]);
    expect(f.prepared).toEqual(f.executed.map(r => ({ cwd: f.ciPath, commit: r.commit })));
    expect(f.executed.map(r => r.probe.source)).toEqual(["c3", "c3", "c3", "base", "c1", "c1"]);
    for (const { command, probe } of f.executed) {
      expect(command.file).toBe(f.binary(f.ciPath));
      expect(probe).toMatchObject({ executable: f.binary(f.ciPath), cwd: f.ciPath, venv: join(f.ciPath, ".venv") });
      expect(probe.path.split(delimiter).slice(0, 2)).toEqual([f.binDir(f.ciPath), join(f.ciPath, "node_modules", ".bin")]);
      expect(probe.path).not.toContain(f.integration);
    }
    expect(git(f.integration, "rev-parse", "HEAD")).toBe(f.c9);

    f.executed.length = 0;
    const reverted = await f.runner.revert({ planId: "plan", phaseId: "p1", slot: f.intSlot, head: f.c9, suiteCommit: f.c3,
      culprit: { taskId: "T2", from: f.c1, to: f.c2 }, regression: { ids: [], files: [], commands: f.commands } }, f.journal());
    expect(reverted).toMatchObject({ kind: "ok", reverted: [f.c2] });
    expect(f.executed).toHaveLength(2); // The revert's own tests, then the original suite regression.
    for (const { command, commit, probe } of f.executed) {
      expect(commit).toBe(git(f.integration, "rev-parse", "HEAD"));
      expect(command.file).toBe(f.binary(f.integration));
      expect(probe).toMatchObject({ executable: f.binary(f.integration), cwd: f.integration, venv: join(f.integration, ".venv"), source: "advanced-integration" });
      expect(probe.path.split(delimiter).slice(0, 2)).toEqual([f.binDir(f.integration), join(f.integration, "node_modules", ".bin")]);
      expect(probe.path).not.toContain(f.ciPath);
    }
    expect(JSON.stringify(f.commands)).toBe(original);
  }, 30_000);

  it("reauthorizes package scripts in the historical checkout for suite and revert regression checks before spawning", async () => {
    const f = await fixture();
    const allowed = await f.resolver.resolve({ script: "historical", args: [] }, f.integration);
    if (!allowed.ok) throw new Error(allowed.reason);
    const expected = { reason: "resolve", message: 'historical: package.json has no script "historical"' };
    const result = await f.checks.runCommands({ slot: f.ci, commit: f.c0, commands: [allowed.command], prepare: true, mode: "full",
      priority: "background", signal: new AbortController().signal });
    expect(result).toMatchObject({ verdict: "error", error: expected });
    expect(git(f.ciPath, "rev-parse", "HEAD")).toBe(f.c0);
    const regression = await f.checks.run({ slot: f.intSlot, base: f.c9, candidate: f.c0, priority: "foreground", signal: new AbortController().signal,
      extra: { ids: [], files: [], commands: [allowed.command] } });
    expect(regression).toMatchObject({ verdict: "error", ...expected });
    expect(f.executed).toEqual([]);
  }, 30_000);

  it.each([false, true])("preserves explicit environment overrides and explicit cwd=%s, even equal to inherited defaults", async overrideCwd => {
    const f = await fixture();
    const original = f.commands[0]!;
    const inheritedPath = Object.entries(original.resolution!.env).find(([key]) => key.toUpperCase() === "PATH")![1];
    const command = { ...original, ...(overrideCwd ? { cwd: f.integration } : {}),
      env: { [process.platform === "win32" ? "path" : "PATH"]: inheritedPath, VIRTUAL_ENV: "explicit-venv", PYTHONPATH: "explicit-imports" } };
    const result = await f.checks.runCommands({ slot: f.ci, commit: f.c0, commands: [command], prepare: true, mode: "full",
      priority: "background", signal: new AbortController().signal });
    expect(result.error).toBeNull();
    expect(f.executed).toHaveLength(1);
    const cwd = overrideCwd ? f.integration : f.ciPath;
    expect(f.executed[0]?.probe).toEqual({ executable: f.binary(cwd), cwd, path: inheritedPath, venv: "explicit-venv", pythonpath: "explicit-imports",
      source: overrideCwd ? "advanced-integration" : "base" });
    expect(command.cwd).toBe(overrideCwd ? f.integration : undefined);
    expect(command.env.VIRTUAL_ENV).toBe("explicit-venv");
  }, 30_000);
});
