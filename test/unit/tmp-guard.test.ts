// QA-2.1-4: no test may reach the real temp directory, which holds the live scorecard files and, from DF2 on, the
// live outcome store and decision log of a running OpenCode session. The guard lives in test/setup/home-guard.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import os, { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { DEFAULT_OUTCOMES_DIRNAME } from "../../src/routing/outcomes/types";
import { resolveOutcomesDir } from "../../src/routing/outcomes/persist";
import { assertTmpIsGuarded, guardedTmpdir, REAL_TMPDIR_ENV, RUN_ID_ENV, sameDir } from "../setup/home-guard";
import { removeRunGuardDirs } from "../setup/global-guard";
import { keyedSmokeEnv, setup as setupSmoke, teardown as teardownSmoke } from "../setup/smoke-tmp-guard";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const realTmp = (): string => {
  const value = process.env[REAL_TMPDIR_ENV];
  if (value === undefined || value === "") throw new Error("the guard did not record the real temp dir");
  return value;
};

afterEach(() => vi.unstubAllEnvs());

// Includes native Node subprocesses and isolated-directory creation/cleanup.
describe("temp directory guard", { timeout: 60_000 }, () => {
  it("R2-6: smoke cleanup failure warns but restores the environment", () => {
    const names = ["TEMP", "TMP", "TMPDIR", "OMR_SMOKE_REAL_TMPDIR"];
    const before = names.map((name) => process.env[name]);
    setupSmoke();
    const dir = process.env.TEMP!;
    const remove = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw new Error("EPERM"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => teardownSmoke()).not.toThrow();
      expect(names.map((name) => process.env[name])).toEqual(before);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
    } finally {
      remove.mockRestore();
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("N10: native child homedir inherits the private home, not just the os mock", () => {
    expect(process.env.HOME).toBe(homedir());
    expect(process.env.USERPROFILE).toBe(homedir());
    const child = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { encoding: "utf8" });
    expect(child).toBe(homedir());
    expect(child).toContain("omr-home-guard-");
  });

  it("N10: a test can still redirect only HOME or only USERPROFILE", () => {
    const other = join(tmpdir(), "custom-home");
    vi.stubEnv("HOME", other);
    expect(homedir()).toBe(other);
    vi.unstubAllEnvs();
    vi.stubEnv("USERPROFILE", other);
    expect(homedir()).toBe(other);
  });
  it("QA-G-C2/C10: smoke setup isolates native child temp and keyed home, teardown restores env", () => {
    const names = ["TEMP", "TMP", "TMPDIR", "OMR_SMOKE_REAL_TMPDIR"];
    const before = names.map((name) => process.env[name]);
    const real = tmpdir();
    let privateTmp = "";
    try {
      setupSmoke();
      privateTmp = process.env.TEMP ?? "";
      expect(process.env.OMR_SMOKE_REAL_TMPDIR).toBe(real);
      expect(privateTmp).toContain("omr-smoke-tmp-");
      expect(existsSync(privateTmp)).toBe(true);
      const env = keyedSmokeEnv();
      expect(env.HOME).toBe(env.USERPROFILE);
      expect(env.HOME).not.toBe(homedir());
      expect(env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
      expect(env.XDG_DATA_HOME).toBe(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
      const native = JSON.parse(execFileSync(process.execPath, ["-e", "console.log(JSON.stringify({home:require('node:os').homedir(),tmp:require('node:os').tmpdir()}))"], { env, encoding: "utf8" })) as { home: string; tmp: string };
      expect(native).toEqual({ home: env.HOME, tmp: privateTmp });
    } finally { teardownSmoke(); }
    expect(existsSync(privateTmp)).toBe(false);
    expect(names.map((name) => process.env[name])).toEqual(before);
  });
  it("os.tmpdir(), named and default, is the guarded private dir and never the real one", () => {
    expect(tmpdir).toBe(guardedTmpdir);
    expect(os.tmpdir).toBe(guardedTmpdir);
    expect(sameDir(tmpdir(), realTmp())).toBe(false);
    expect(existsSync(tmpdir())).toBe(true);
  });

  it("TEMP, TMP and TMPDIR point at the same private dir", () => {
    for (const name of ["TEMP", "TMP", "TMPDIR"]) expect(process.env[name]).toBe(tmpdir());
  });

  it("the default outcomes and scorecard directory cannot be the real one", () => {
    const dir = resolveOutcomesDir(null, { tmpdir: tmpdir(), homedir: homedir() });
    expect(dir).toBe(join(tmpdir(), DEFAULT_OUTCOMES_DIRNAME));
    expect(sameDir(dir, join(realTmp(), DEFAULT_OUTCOMES_DIRNAME))).toBe(false);
  });

  it("honours a redirect to another temp dir", () => {
    const other = join(tmpdir(), "elsewhere");
    for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, other);
    expect(tmpdir()).toBe(other);
  });

  it("throws when a test points the temp dir back at the real one", () => {
    for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, realTmp());
    expect(() => tmpdir()).toThrow(/resolved the real temp directory/);
    expect(() => assertTmpIsGuarded(() => realTmp())).toThrow(/os\.tmpdir\(\) resolves the real temp directory/);
  });

  it("assertTmpIsGuarded accepts the private dir and the real dir under another spelling is still rejected", () => {
    expect(() => assertTmpIsGuarded(tmpdir)).not.toThrow();
    expect(() => assertTmpIsGuarded(() => `${realTmp()}${process.platform === "win32" ? "\\" : "/"}`)).toThrow(/real temp directory/);
    expect(() => assertTmpIsGuarded(() => `${realTmp()}${sep}nested${sep}..`)).toThrow(/real temp directory/);
    if (process.platform === "win32") {
      expect(() => assertTmpIsGuarded(() => realTmp().toUpperCase())).toThrow(/real temp directory/);
    }
    // Case folding is a Windows spelling alias, not a POSIX filesystem rule.
    expect(sameDir(join(realTmp(), "CaseProbe"), join(realTmp(), "caseprobe"))).toBe(process.platform === "win32");
  });
});

describe("global guard teardown (QA-2.1-R2-6)", () => {
  it("this run''s workers tag their guard directories with the run id the global setup chose", () => {
    const runId = process.env[RUN_ID_ENV];
    expect(runId).toBeTruthy();
    expect(tmpdir().split(/[\\/]/).pop()).toContain(`omr-tmp-guard-${runId}-`);
  });

  it("removes the directories of one run, empty or not, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "omr-gg-test-"));
    try {
      for (const name of ["omr-home-guard-RUN1-aaaaaa", "omr-tmp-guard-RUN1-bbbbbb", "omr-tmp-guard-RUN2-cccccc", "omr-home-guard-dddddd", "unrelated"]) mkdirSync(join(root, name));
      mkdirSync(join(root, "omr-tmp-guard-RUN1-eeeeee", "inner"), { recursive: true });
      const logs: string[] = [];
      expect(removeRunGuardDirs(root, "RUN1", (message) => logs.push(message))).toBe(3);
      expect(readdirSync(root).sort()).toEqual(["omr-home-guard-dddddd", "omr-tmp-guard-RUN2-cccccc", "unrelated"]);
      expect(logs).toEqual([]);
      expect(removeRunGuardDirs(root, "")).toBe(0); // no run id: never guess
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("logs, and does not throw, when a directory cannot be removed or the root cannot be listed", () => {
    const root = mkdtempSync(join(tmpdir(), "omr-gg-test-"));
    try {
      mkdirSync(join(root, "omr-tmp-guard-RUN1-aaaaaa"));
      mkdirSync(join(root, "omr-home-guard-RUN1-bbbbbb"));
      const logs: string[] = [];
      const removed = removeRunGuardDirs(root, "RUN1", (message) => logs.push(message), (path) => {
        if (path.endsWith("aaaaaa")) throw new Error("EBUSY: resource busy");
      });
      expect(removed).toBe(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/cannot remove .*aaaaaa: EBUSY/);
      const missing: string[] = [];
      expect(removeRunGuardDirs(join(root, "nope"), "RUN1", (message) => missing.push(message))).toBe(0);
      expect(missing[0]).toMatch(/cannot list/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
