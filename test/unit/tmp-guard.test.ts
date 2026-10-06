// QA-2.1-4: no test may reach the real temp directory, which holds the live scorecard files and, from DF2 on, the
// live outcome store and decision log of a running OpenCode session. The guard lives in test/setup/home-guard.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import os, { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DEFAULT_OUTCOMES_DIRNAME } from "../../src/routing/outcomes/types";
import { resolveOutcomesDir } from "../../src/routing/outcomes/persist";
import { assertTmpIsGuarded, guardedTmpdir, REAL_TMPDIR_ENV, sameDir } from "../setup/home-guard";

const realTmp = (): string => {
  const value = process.env[REAL_TMPDIR_ENV];
  if (value === undefined || value === "") throw new Error("the guard did not record the real temp dir");
  return value;
};

afterEach(() => vi.unstubAllEnvs());

describe("temp directory guard", () => {
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
    expect(() => assertTmpIsGuarded(() => join(realTmp(), "..", "Temp"))).toThrow(/real temp directory/);
  });
});
