import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
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

const CHECK_ID = "check.test.js > check";
interface ScopedProbe { kind: string; cwd: string; venv: string; pythonpath: string | null; marker: string | null }

/** Real router resolution, registered slots and child processes; the green package test is not the configured check. */
async function scopedFixture(configured = false, configChanged = false) {
  await mkdir(resolve("tmp"), { recursive: true });
  const root = await realpath(await mkdtemp(join(resolve("tmp"), "scoped-command-")));
  roots.push(root);
  const repo = join(root, "repo"), integration = join(root, "integration"), ciPath = join(root, "ci");
  await mkdir(repo);
  git(repo, "init", "-q");
  const probe = (kind: string) => `fs.appendFileSync('executed.jsonl', JSON.stringify({ kind: '${kind}', cwd: process.cwd(),
    venv: process.env.VIRTUAL_ENV, pythonpath: process.env.PYTHONPATH ?? null, marker: process.env.EXPLICIT_CHECK ?? null }) + '\\n');`;
  const pkg = JSON.stringify({ type: "module", scripts: { test: "vitest run" } });
  await writeFile(join(repo, "package.json"), pkg);
  await writeFile(join(repo, "vitest.config.mjs"), "export default { test: { include: ['check.test.js'], maxWorkers: 1 } };\n");
  const test = [
    "import fs from 'node:fs'; import { test, expect } from 'vitest';",
    "test('check', () => {", probe("package"),
    "expect(process.env.CHECK_FAIL === '1' || fs.existsSync('package-fails')).toBe(false);", "});",
  ].join("\n");
  await writeFile(join(repo, "check.test.js"), test);
  await writeFile(join(repo, "custom-check.cjs"), [
    "const fs = require('node:fs');", probe("configured"),
    `console.log(' FAIL  ${CHECK_ID}\\n Tests  1 failed (1)');`, "process.exit(1);",
  ].join("\n"));
  const commit = (message: string): string => { git(repo, "add", "."); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); };
  const base = commit("base");
  await writeFile(join(repo, configChanged ? "package.json" : "check.test.js"), `${configChanged ? pkg : test}\n`);
  const candidate = commit("candidate");
  git(repo, "worktree", "add", "--detach", integration, base);
  git(repo, "worktree", "add", "--detach", ciPath, candidate);
  for (const cwd of [integration, ciPath]) {
    const bin = join(cwd, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await symlink(resolve("node_modules/vitest"), join(cwd, "node_modules", "vitest"), process.platform === "win32" ? "junction" : "dir");
    if (process.platform === "win32") {
      await writeFile(join(bin, "vitest.cmd"), `@"${process.execPath}" "%~dp0..\\vitest\\vitest.mjs" %*\r\n`);
    } else await symlink("../vitest/vitest.mjs", join(bin, "vitest"));
    registerSlot({ root: cwd, managers: ["pip", "npm"] });
    registered.push(cwd);
  }
  const config: RunConfig = { scripts: ["test"], commands: configured ? { test: { argv: ["node", "custom-check.cjs"] } } : {}, timeoutMs: 15_000 };
  const resolver = createRunResolver(() => config);
  const selected = await resolver.resolve({ script: "test", args: [] }, integration);
  if (!selected.ok) throw new Error(selected.reason);
  const ci: SlotLease = { slot: "ci", path: ciPath, planId: "plan", owner: "ci", commit: candidate };
  const pool = stub<SlotPool>({
    reset: async (_slot, sha) => { git(ciPath, "reset", "--hard", sha); }, cleanForChecks: async () => {},
    list: async () => [stub<SlotRecord>({ path: ciPath }), stub<SlotRecord>({ path: integration })],
  });
  const ops = stub<GitOps>({ revParse: async (cwd, ref) => git(cwd, "rev-parse", ref) });
  const guard = { assertWriteCwd: async () => {} };
  const igit = createIntegrateGit({ run: async (args, opts) => gitResult(opts.cwd, args) }, guard);
  const ledger = stub<LedgerV1>({ planId: "plan", integration: stub<LedgerV1["integration"]>({ worktree: integration }),
    config: stub<LedgerV1["config"]>({ integrationChecks: "auto", python: "auto" }) });
  const background = new BackgroundRuns(), clock = stub<Clock>({ now: () => Date.now() }), logger = { warn: () => {} };
  const executed: Array<{ command: ResolvedCommand; cwd: string; exitCode: number }> = [];
  const checks = createIntegrationChecks({ ledger: () => ledger, pool, git: ops, igit, resolver, guard, background, clock, logger,
    preemptForeground: async () => {}, acquire: async () => ({ lost: false, release: async () => {} }),
    spawn: async (command, opts) => {
      const result = await runArgv(command.file, command.args, { ...opts, env: command.env, timeoutMs: 15_000 });
      executed.push({ command, cwd: opts.cwd, exitCode: result.code });
      return { exitCode: result.code, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, durationMs: 0 };
    },
  });
  const runner = createPhaseSuiteRunner({ checks, igit, git: ops, pool, resolver, background, clock, logger });
  const journal: StepJournal = {
    entry: { id: "i-1", kind: "phase-suite", phaseId: "p1", taskIds: [], slot: "ci", baseHead: base, candidate: null },
    signal: new AbortController().signal, start: async () => {}, end: async () => {}, counter: () => {}, ...guard,
  };
  const request = { slot: ci, base, candidate, priority: "foreground" as const, signal: journal.signal };
  const probes = async (cwd: string): Promise<ScopedProbe[]> => (await readFile(join(cwd, "executed.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as ScopedProbe);
  return { checks, resolver, runner, journal, request, command: selected.command, executed, probes, ci, integration, ciPath, base, candidate };
}

describe("scoped command identity and context", () => {
  it.each(["affected", "unchanged", "config"] as const)("runs the configured failing check, not the green package test (%s)", async change => {
    const f = await scopedFixture(true, change === "config");
    expect(f.command.source).toBe("run-command");
    const result = await f.checks.run({ ...f.request, ...(change === "unchanged" ? { base: f.candidate } : {}) });
    expect(result).toMatchObject({ verdict: "fail", failingIds: [CHECK_ID], failingFiles: [join(f.ciPath, "check.test.js")], flakyIds: [],
      components: [{ name: "tests", scope: "full", exitCode: 1 }] });
    expect(f.executed).toHaveLength(1); // Neither an affected-file plan nor a confirmation rerun may replace this command.
    expect(f.executed[0]).toMatchObject({ cwd: f.ciPath, command: { file: f.command.file, args: ["custom-check.cjs"] } });
    expect(await f.probes(f.ciPath)).toEqual([{ kind: "configured", cwd: f.ciPath, venv: join(f.ciPath, ".venv"), pythonpath: null, marker: null }]);
  }, 30_000);

  it("keeps the configured check in both attributable suite reruns", async () => {
    const f = await scopedFixture(true);
    const result = await f.runner.run({ planId: "plan", phaseId: "p1", slot: f.ci, commit: f.candidate, base: null, commands: [f.command], ranges: [] }, f.journal);
    expect(result).toEqual({ kind: "unattributed", ids: [CHECK_ID], reason: "no-base" });
    expect(f.executed.map(r => r.command.args)).toEqual([["custom-check.cjs"], ["custom-check.cjs"], ["custom-check.cjs"]]);
    expect((await f.probes(f.ciPath)).map(p => p.kind)).toEqual(["configured", "configured", "configured"]);
  }, 30_000);

  it.each(["env", "cwd", "both"] as const)("preserves explicit %s in suite file reruns by running the full resolved command", async override => {
    const f = await scopedFixture();
    const cwd = override === "env" ? f.ciPath : f.integration;
    if (override !== "env") await writeFile(join(f.integration, "package-fails"), "fail only in the explicit cwd");
    const env = { CHECK_FAIL: "1", EXPLICIT_CHECK: "kept", VIRTUAL_ENV: "explicit-venv", PYTHONPATH: "explicit-imports" };
    const command = { ...f.command, ...(override === "env" ? {} : { cwd }), ...(override === "cwd" ? {} : { env }) };
    const original = JSON.stringify(command);
    const result = await f.checks.runCommands({ slot: f.ci, commit: f.candidate, commands: [command], prepare: true, mode: { rerun: [CHECK_ID] },
      requireRun: true, priority: "background", signal: f.journal.signal });
    expect(result).toMatchObject({ verdict: "fail", ids: [CHECK_ID], files: [join(cwd, "check.test.js")], idsUnparsed: false, error: null });
    expect(f.executed).toHaveLength(1);
    expect(f.executed[0]).toMatchObject({ cwd, command: { file: command.file, args: command.args, resolution: { cwd } } });
    expect(await f.probes(cwd)).toEqual([{ kind: "package", cwd, venv: override === "cwd" ? join(cwd, ".venv") : "explicit-venv",
      pythonpath: override === "cwd" ? null : "explicit-imports", marker: override === "cwd" ? null : "kept" }]);
    expect(JSON.stringify(command)).toBe(original);
  }, 30_000);

  it("preserves explicit context in revert regression file runs after an ordinary scoped integration check", async () => {
    const f = await scopedFixture();
    const command = { ...f.command, cwd: f.integration, env: { CHECK_FAIL: "1", EXPLICIT_CHECK: "regression", VIRTUAL_ENV: "explicit-venv", PYTHONPATH: "explicit-imports" } };
    const result = await f.checks.run({ ...f.request, extra: { ids: [CHECK_ID], files: [join(f.ciPath, "check.test.js")], commands: [command] } });
    expect(result).toMatchObject({ verdict: "fail", failingIds: [CHECK_ID], components: [
      { name: "tests", scope: "spec", exitCode: 0 }, { name: "regression", scope: "full", exitCode: 1 },
    ] });
    expect(f.executed).toHaveLength(2);
    expect(f.executed[1]).toMatchObject({ cwd: f.integration, command: { args: command.args, resolution: { cwd: f.integration } } });
    expect(await f.probes(f.integration)).toEqual([{ kind: "package", cwd: f.integration, venv: "explicit-venv", pythonpath: "explicit-imports", marker: "regression" }]);
  }, 30_000);

  it("retains ordinary package-script scoping, confirmation and suite file reruns in the registered execution slot", async () => {
    const f = await scopedFixture();
    expect(f.command.source).toBe("package-script");
    const passing = await f.checks.run(f.request);
    expect(passing).toMatchObject({ verdict: "pass", components: [{ name: "tests", scope: "spec" }] });
    await writeFile(join(f.ciPath, "package-fails"), "reproducible");
    const failing = await f.checks.run(f.request);
    expect(failing).toMatchObject({ verdict: "fail", failingIds: [CHECK_ID], flakyIds: [], components: [{ name: "tests", scope: "rerun" }] });
    const rerun = await f.checks.runCommands({ slot: f.ci, commit: f.candidate, commands: [f.command], prepare: true, mode: { rerun: [CHECK_ID] },
      requireRun: true, priority: "background", signal: f.journal.signal });
    expect(rerun).toMatchObject({ verdict: "fail", ids: [CHECK_ID], idsUnparsed: false, error: null });
    expect(f.executed).toHaveLength(4);
    for (const { command, cwd } of f.executed) {
      expect(command.args).toContain(join(f.ciPath, "node_modules", "vitest", "vitest.mjs"));
      expect(command.args.some(arg => arg.startsWith("--outputFile"))).toBe(true);
      expect(command.resolution?.cwd).toBe(f.ciPath);
      expect(cwd).toBe(f.ciPath);
    }
    expect(await f.probes(f.ciPath)).toEqual(Array.from({ length: 4 }, () => ({ kind: "package", cwd: f.ciPath,
      venv: join(f.ciPath, ".venv"), pythonpath: null, marker: null })));
  }, 30_000);
});
