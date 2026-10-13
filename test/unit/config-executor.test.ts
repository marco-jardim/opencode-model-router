import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ROUTING_DEFAULTS,
  collectRoutingNotices,
  configAsWritten,
  configuredV2OnlyKeys,
  findUnknownRoutingKeys,
  getConfigNotices,
  invalidateConfigCache,
  loadConfig,
  overridePath,
  resetRoutingWarnings,
  resolveRouting,
  slotsDirProblem,
  validateConfig,
  validateSlotsDir,
  type RouterConfig,
} from "../../src/router/config";
import { EXECUTOR_LIMITS } from "../../src/executor/types";
import { removeDirWhenReleased } from "../helpers/remove-dir";

// The plugin booted by the QA-4.1-9 test must not sweep reference directories (as in finish-attach.test.ts).
vi.mock("../../src/verify/reference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/verify/reference")>()),
  gcStaleReferences: async () => ({ removed: [], kept: [], failed: [] }),
}));

const bundled = JSON.parse(readFileSync(fileURLToPath(new URL("../../tiers.json", import.meta.url)), "utf-8")) as Record<
  string,
  unknown
>;

/** A validated config whose `routing.executor` is `executor`, as written. */
function cfgWith(executor: unknown): RouterConfig {
  return validateConfig({ ...bundled, routing: { executor } });
}

function executorOf(executor: unknown, host: "v1" | "v2" = "v2") {
  return resolveRouting(cfgWith(executor), host).executor;
}

/** The Appendix C defaults, written out independently of ROUTING_DEFAULTS. */
const APPENDIX_C_DEFAULTS = {
  maxParallel: 4,
  slotsDir: null,
  approve: "ask",
  crossPhase: "gate",
  land: "ff-when-clean",
  batchMax: 4,
  maxAttempts: 3,
  qaMaxRounds: 3,
  integrationChecks: "auto",
  phaseSuite: "auto",
  provision: "auto",
  python: "auto",
  sharedContextChars: 12000,
  capacityCooldownMs: 120000,
  capacityPauseMs: 900000,
  wakeDebounceMs: 5000,
  circuitBreaker: { failureRatio: 0.4, minAttempts: 5, consecutiveFailures: 3 },
};

const INTEGER_KEYS = [
  "maxParallel",
  "batchMax",
  "maxAttempts",
  "qaMaxRounds",
  "sharedContextChars",
  "capacityCooldownMs",
  "capacityPauseMs",
  "wakeDebounceMs",
] as const;

describe("routing.executor — defaults", () => {
  beforeEach(() => resetRoutingWarnings());

  it("resolves the Appendix C defaults for an empty config, with and without a routing block", () => {
    expect(resolveRouting(undefined, "v2").executor).toEqual(APPENDIX_C_DEFAULTS);
    expect(resolveRouting(validateConfig({ ...bundled }), "v2").executor).toEqual(APPENDIX_C_DEFAULTS);
    expect(executorOf({})).toEqual(APPENDIX_C_DEFAULTS);
    expect(ROUTING_DEFAULTS.executor).toEqual(APPENDIX_C_DEFAULTS);
  });

  it("keeps the ranges of Appendix C in EXECUTOR_LIMITS", () => {
    expect(EXECUTOR_LIMITS).toEqual({
      maxParallel: [1, 8],
      batchMax: [1, 8],
      maxAttempts: [1, 6],
      qaMaxRounds: [1, 8],
      sharedContextChars: [0, 60000],
      capacityCooldownMs: [10000, 3600000],
      capacityPauseMs: [60000, 86400000],
      wakeDebounceMs: [1000, 60000],
      failureRatio: [0.1, 1],
      minAttempts: [1, 50],
      consecutiveFailures: [1, 50],
    });
  });

  it("applies a partial block key by key", () => {
    const executor = executorOf({ maxParallel: 2, approve: "auto", circuitBreaker: { minAttempts: 9 } });
    expect(executor).toEqual({
      ...APPENDIX_C_DEFAULTS,
      maxParallel: 2,
      approve: "auto",
      circuitBreaker: { failureRatio: 0.4, minAttempts: 9, consecutiveFailures: 3 },
    });
  });

  it("returns a deeply frozen value that aliases nothing it was given", () => {
    const written = {
      integrationChecks: [{ script: "test", args: [] as string[] }],
      phaseSuite: [{ script: "lint", args: ["--fix"] }],
      provision: { npm: [["npm", "ci"]] },
    };
    const cfg = cfgWith(written);
    const executor = resolveRouting(cfg, "v2").executor;
    expect(Object.isFrozen(executor)).toBe(true);
    expect(Object.isFrozen(executor.circuitBreaker)).toBe(true);
    expect(Object.isFrozen(executor.integrationChecks)).toBe(true);
    expect(Object.isFrozen((executor.integrationChecks as readonly unknown[])[0])).toBe(true);
    expect(Object.isFrozen(executor.provision)).toBe(true);
    expect(Object.isFrozen((executor.provision as Record<string, unknown[]>).npm)).toBe(true);
    expect(Object.isFrozen((executor.provision as Record<string, unknown[][]>).npm![0])).toBe(true);
    expect(executor.provision).not.toBe(written.provision);
    expect(executor.provision).toEqual(written.provision);
    expect(executor.phaseSuite).toEqual(written.phaseSuite);
  });
});

describe("routing.executor — numeric ranges", () => {
  beforeEach(() => resetRoutingWarnings());

  it.each(INTEGER_KEYS)("%s accepts both edges of its range", (key) => {
    const [min, max] = EXECUTOR_LIMITS[key];
    expect(executorOf({ [key]: min })[key]).toBe(min);
    expect(executorOf({ [key]: max })[key]).toBe(max);
  });

  it.each(INTEGER_KEYS)("%s falls back to its default outside the range, for a fraction and for a non-number", (key) => {
    const [min, max] = EXECUTOR_LIMITS[key];
    const fallback = APPENDIX_C_DEFAULTS[key];
    for (const bad of [min - 1, max + 1, min + 0.5, "5", null, true, [1], {}]) {
      expect(executorOf({ [key]: bad })[key], `${key}=${JSON.stringify(bad)}`).toBe(fallback);
    }
  });

  it("circuitBreaker.failureRatio accepts 0.1, 1 and fractions between, and rejects the rest", () => {
    expect(executorOf({ circuitBreaker: { failureRatio: 0.1 } }).circuitBreaker.failureRatio).toBe(0.1);
    expect(executorOf({ circuitBreaker: { failureRatio: 1 } }).circuitBreaker.failureRatio).toBe(1);
    expect(executorOf({ circuitBreaker: { failureRatio: 0.55 } }).circuitBreaker.failureRatio).toBe(0.55);
    for (const bad of [0.09, 0, -0.5, 1.01, 2, "0.5", null]) {
      expect(executorOf({ circuitBreaker: { failureRatio: bad } }).circuitBreaker.failureRatio, JSON.stringify(bad)).toBe(0.4);
    }
  });

  it.each(["minAttempts", "consecutiveFailures"] as const)("circuitBreaker.%s accepts 1 and 50, and rejects the rest", (key) => {
    expect(executorOf({ circuitBreaker: { [key]: 1 } }).circuitBreaker[key]).toBe(1);
    expect(executorOf({ circuitBreaker: { [key]: 50 } }).circuitBreaker[key]).toBe(50);
    const fallback = APPENDIX_C_DEFAULTS.circuitBreaker[key];
    for (const bad of [0, 51, 2.5, "3", null]) {
      expect(executorOf({ circuitBreaker: { [key]: bad } }).circuitBreaker[key], JSON.stringify(bad)).toBe(fallback);
    }
  });

  it("ignores a circuitBreaker that is not an object", () => {
    expect(executorOf({ circuitBreaker: 3 }).circuitBreaker).toEqual(APPENDIX_C_DEFAULTS.circuitBreaker);
  });

  it("does not let one invalid key spoil a valid sibling", () => {
    const executor = executorOf({ maxParallel: 99, batchMax: 2 });
    expect(executor.maxParallel).toBe(4);
    expect(executor.batchMax).toBe(2);
  });
});

describe("routing.executor — enums", () => {
  it.each([
    ["approve", ["ask", "auto"], "ask"],
    ["crossPhase", ["gate", "inferred"], "gate"],
    ["land", ["ff-when-clean", "manual"], "ff-when-clean"],
  ] as const)("%s accepts %j and falls back to %s", (key, values, fallback) => {
    for (const value of values) expect(executorOf({ [key]: value })[key]).toBe(value);
    for (const bad of ["Ask", "", "sometimes", 1, null, true]) {
      expect(executorOf({ [key]: bad })[key], JSON.stringify(bad)).toBe(fallback);
    }
  });
});

describe("routing.executor — slotsDir", () => {
  it("accepts null and an absolute drive path", () => {
    expect(executorOf({ slotsDir: null }).slotsDir).toBeNull();
    expect(executorOf({ slotsDir: "D:\\.omr-slots" }).slotsDir).toBe("D:\\.omr-slots");
    expect(executorOf({ slotsDir: "D:/work/slots" }).slotsDir).toBe("D:/work/slots");
  });

  it.each([
    ["a relative path", "slots"],
    ["a rooted path without a drive", "\\slots"],
    ["a drive-relative path", "C:slots"],
    ["a drive root", "C:\\"],
    ["a drive root with a forward slash", "C:/"],
    ["a drive root that .. reaches", "C:\\slots\\.."],
    ["a UNC path", "\\\\server\\share\\slots"],
    ["a device path", "\\\\?\\C:\\slots"],
    ["a glob", "C:\\slots\\*"],
    ["a glob in the middle", "C:\\*\\slots"],
    ["a number", 5],
    ["an empty string", ""],
  ])("falls back to null for %s", (_label, bad) => {
    expect(executorOf({ slotsDir: bad }).slotsDir).toBeNull();
  });

  it("names the broken rule in slotsDirProblem", () => {
    expect(slotsDirProblem("C:\\.omr-slots\\p1")).toBeUndefined();
    expect(slotsDirProblem("C:\\a*")).toContain("'*'");
    expect(slotsDirProblem("\\\\srv\\sh\\x")).toContain("UNC");
    expect(slotsDirProblem("C:\\")).toContain("drive root");
    expect(slotsDirProblem("rel")).toContain("absolute");
  });
});

describe("validateSlotsDir — repository-relative rules", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "omr-slots-"));
  const repo = join(sandbox, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  mkdirSync(join(sandbox, "slots"), { recursive: true });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  const isWin = process.platform === "win32";
  // Native: a temporary directory under an 8.3 short name (`MARQUI~1`) is spelled out, which slotsDirProblem requires.
  const real = realpathSync.native(sandbox);

  it.runIf(isWin)("accepts a sibling directory, existing or not", () => {
    expect(validateSlotsDir(join(real, "slots"), join(real, "repo"))).toEqual({ ok: true });
    expect(validateSlotsDir(join(real, "not-yet", "plan-1"), join(real, "repo"))).toEqual({ ok: true });
  });

  it.runIf(isWin)("refuses the repository itself and anything inside it, in any letter case", () => {
    const top = join(real, "repo");
    for (const inside of [top, join(top, "sub"), join(top, "new", "dir"), top.toUpperCase(), join(top, "SUB").toLowerCase()]) {
      const verdict = validateSlotsDir(inside, top);
      expect(verdict.ok, inside).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toContain("inside");
    }
  });

  it.runIf(isWin)("refuses an ancestor of the repository, in any letter case", () => {
    const top = join(real, "repo");
    for (const ancestor of [real, real.toUpperCase(), join(real, "..")]) {
      const verdict = validateSlotsDir(ancestor, top);
      expect(verdict.ok, ancestor).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toMatch(/ancestor|drive root/);
    }
  });

  it.runIf(isWin)("refuses another drive", () => {
    const letter = parse(real).root[0]!.toUpperCase() === "Z" ? "Y" : "Z";
    const verdict = validateSlotsDir(`${letter}:\\.omr-slots\\p1`, join(real, "repo"));
    expect(verdict).toEqual({ ok: false, reason: "must be on the repository's drive" });
  });

  it("applies the repository-independent rules first", () => {
    expect(validateSlotsDir("C:\\", repo).ok).toBe(false);
    expect(validateSlotsDir("C:\\a\\*", repo).ok).toBe(false);
    expect(validateSlotsDir("rel", repo).ok).toBe(false);
  });

  it.runIf(isWin)("QA-4.1-4: refuses a path that reaches into the repository through a junction", () => {
    const top = join(real, "repo");
    const link = join(real, "junction-to-repo");
    symlinkSync(top, link, "junction");
    for (const inside of [link, join(link, "sub"), join(link, "new", "dir")]) {
      const verdict = validateSlotsDir(inside, top);
      expect(verdict.ok, inside).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toContain("inside");
    }
    // The repository reached through the junction: the sibling is still fine, its inside still is not.
    expect(validateSlotsDir(join(real, "slots"), link)).toEqual({ ok: true });
    expect(validateSlotsDir(join(top, "sub"), link)).toEqual({ ok: false, reason: "must not be inside the repository" });
  });

  it.runIf(isWin)("QA-4.1-4: accepts a sibling worktree whose name extends the repository's", () => {
    const top = join(real, "repo");
    mkdirSync(join(real, "repo-wt"), { recursive: true });
    expect(validateSlotsDir(join(real, "repo-wt"), top)).toEqual({ ok: true });
    expect(validateSlotsDir(join(real, "repo-wt", "slots"), top)).toEqual({ ok: true });
    expect(validateSlotsDir(join(real, "repo.wt", "slots"), top)).toEqual({ ok: true });
  });

  it("QA-4.1-4: compares forward-slash drive paths with the host's path rules, on every OS", () => {
    // On win32 these are paths on the working directory's drive; on posix the posix branch compares them as relative names.
    const drive = isWin ? parse(process.cwd()).root.slice(0, 2) : "C:";
    const top = `${drive}/omr-qa-4-1-4-missing/repo`;
    expect(validateSlotsDir(`${top}/slots`, top)).toEqual({ ok: false, reason: "must not be inside the repository" });
    expect(validateSlotsDir(`${drive}/omr-qa-4-1-4-missing`, top)).toEqual({ ok: false, reason: "must not be an ancestor of the repository" });
    expect(validateSlotsDir(`${drive}/omr-qa-4-1-4-missing/repo-wt`, top)).toEqual({ ok: true });
  });

  it.each([
    ["a trailing dot", "C:\\work\\slots."],
    ["a segment ending in a dot", "C:\\work.\\slots"],
    ["a dot segment", "C:\\work\\.\\slots"],
    ["a trailing space", "C:\\work\\slots "],
    ["a segment ending in a space", "C:\\work \\slots"],
    ["an 8.3 short name", "C:\\PROGRA~1\\slots"],
    ["an 8.3 short name with an extension", "C:\\work\\SLOTS~12.DIR"],
    ["a forward-slash short name", "C:/work/REPO~2/slots"],
  ])("QA-4.1-4: refuses %s, in slotsDirProblem, the config and validateSlotsDir alike", (_label, bad) => {
    expect(slotsDirProblem(bad), bad).toBeDefined();
    expect(executorOf({ slotsDir: bad }).slotsDir, bad).toBeNull();
    expect(validateSlotsDir(bad, repo).ok, bad).toBe(false);
  });

  it("QA-4.1-4: names the trailing-character and short-name rules, and keeps a plain '~' or dot", () => {
    expect(slotsDirProblem("C:\\work\\slots.")).toContain("ending in '.' or a space");
    expect(slotsDirProblem("C:\\work\\slots ")).toContain("ending in '.' or a space");
    expect(slotsDirProblem("C:\\PROGRA~1\\slots")).toContain("8.3 short name");
    for (const ok of ["C:\\work\\a~b", "C:\\work\\~slots", "C:\\work\\.omr-slots", "C:\\work\\slots.d", "C:\\work\\slots\\"]) {
      expect(slotsDirProblem(ok), ok).toBeUndefined();
    }
  });
});

describe("routing.executor — run references, provision and python", () => {
  it("accepts auto and a list of {script, args} for integrationChecks, defaulting args to []", () => {
    expect(executorOf({ integrationChecks: "auto" }).integrationChecks).toBe("auto");
    expect(executorOf({ integrationChecks: [] }).integrationChecks).toEqual([]);
    expect(executorOf({ integrationChecks: [{ script: "test" }, { script: "lint", args: ["--quiet"] }] }).integrationChecks).toEqual([
      { script: "test", args: [] },
      { script: "lint", args: ["--quiet"] },
    ]);
  });

  it.each([
    ["off", "off"],
    ["a string that is not a mode", "sometimes"],
    ["a bare object", { script: "test" }],
    ["an entry without a script", [{ args: [] }]],
    ["an entry with an empty script", [{ script: " " }]],
    ["an entry that is a string", ["test"]],
    ["args that is not an array", [{ script: "test", args: "-x" }]],
    ["args with a non-string", [{ script: "test", args: [1] }]],
    ["one bad entry among good ones", [{ script: "test" }, { script: 3 }]],
  ])("integrationChecks falls back to auto for %s", (_label, bad) => {
    expect(executorOf({ integrationChecks: bad }).integrationChecks).toBe("auto");
  });

  it("accepts auto, off and a list for phaseSuite, and falls back to auto otherwise", () => {
    expect(executorOf({ phaseSuite: "auto" }).phaseSuite).toBe("auto");
    expect(executorOf({ phaseSuite: "off" }).phaseSuite).toBe("off");
    expect(executorOf({ phaseSuite: [{ script: "test:all", args: [] }] }).phaseSuite).toEqual([{ script: "test:all", args: [] }]);
    for (const bad of ["on", 1, [{ script: 1 }], [{}]]) {
      expect(executorOf({ phaseSuite: bad }).phaseSuite, JSON.stringify(bad)).toBe("auto");
    }
  });

  it("accepts auto and an object of argv arrays for provision, and falls back to auto otherwise", () => {
    expect(executorOf({ provision: "auto" }).provision).toBe("auto");
    expect(executorOf({ provision: {} }).provision).toEqual({});
    expect(executorOf({ provision: { npm: [["npm", "ci"], ["npm", "run", "build"]], pip: [] } }).provision).toEqual({
      npm: [["npm", "ci"], ["npm", "run", "build"]],
      pip: [],
    });
    for (const bad of [
      "npm ci",
      ["npm", "ci"],
      { npm: "npm ci" },
      { npm: ["npm", "ci"] },
      { npm: [[]] },
      { npm: [[""]] },
      { npm: [["npm", 1]] },
      JSON.parse('{"__proto__": [["x"]]}'),
    ]) {
      expect(executorOf({ provision: bad }).provision, JSON.stringify(bad)).toBe("auto");
    }
  });

  it("accepts auto and an absolute path for python, and falls back to auto otherwise", () => {
    const absolute = join(parse(process.cwd()).root, "Python312", "python.exe");
    expect(executorOf({ python: "auto" }).python).toBe("auto");
    expect(executorOf({ python: absolute }).python).toBe(absolute);
    for (const bad of ["python", "python3", ".\\python.exe", "", 3, null]) {
      expect(executorOf({ python: bad }).python, JSON.stringify(bad)).toBe("auto");
    }
  });
});

describe("routing.executor — warnings and notices", () => {
  beforeEach(() => resetRoutingWarnings());

  it("resolveRouting warns once per invalid entry on v2 and applies the default", () => {
    const logger = { warn: vi.fn() };
    const routing: unknown = { executor: { maxParallel: 99, approve: "x" } };
    const raw = { ...cfgWith({}), routing } as RouterConfig;
    const executor = resolveRouting(raw, "v2", logger).executor;
    expect(executor.maxParallel).toBe(4);
    expect(executor.approve).toBe("ask");
    const messages = logger.warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toEqual([
      "routing.executor.maxParallel must be an integer from 1 to 8 (got 99); using 4",
      "routing.executor.approve must be ask|auto (got \"x\"); using ask",
    ]);
    resolveRouting(raw, "v2", logger);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it("collectRoutingNotices reports invalid executor entries from the raw block", () => {
    const rawRouting = { executor: { wakeDebounceMs: 5, circuitBreaker: { failureRatio: 2 }, python: "py" } };
    const notices = collectRoutingNotices(rawRouting, cfgWith(rawRouting.executor));
    expect(notices).toEqual(
      expect.arrayContaining([
        "routing.executor.wakeDebounceMs must be an integer from 1000 to 60000 (got 5); using 5000",
        "routing.executor.circuitBreaker.failureRatio must be a number from 0.1 to 1 (got 2); using 0.4",
        "routing.executor.python must be \"auto\" or an absolute path (got \"py\"); using auto",
      ]),
    );
  });

  it("ignores a routing.executor that is not an object, with a notice", () => {
    expect(executorOf("fast")).toEqual(APPENDIX_C_DEFAULTS);
    expect(collectRoutingNotices({ executor: "fast" }, cfgWith({}))).toContain(
      'routing.executor must be an object (got "fast"); ignored',
    );
  });

  it("notices unknown executor keys, nested ones included", () => {
    expect(findUnknownRoutingKeys({ executor: { maxParalel: 2, circuitBreaker: { ratio: 1 }, approve: "ask" } })).toEqual([
      "routing.executor.maxParalel",
      "routing.executor.circuitBreaker.ratio",
    ]);
    expect(findUnknownRoutingKeys({ executor: Object.fromEntries(Object.keys(APPENDIX_C_DEFAULTS).map((k) => [k, 1])) })).toEqual([]);
  });
});

describe("routing.executor — OpenCode v1", () => {
  beforeEach(() => resetRoutingWarnings());

  it("lists every configured executor key, leaf by leaf, for the v1 notice", () => {
    expect(
      configuredV2OnlyKeys({
        routing: { executor: { maxParallel: 2, slotsDir: null, circuitBreaker: { failureRatio: 0.5, minAttempts: 3 }, land: undefined } },
      }),
    ).toEqual([
      "routing.executor.maxParallel",
      "routing.executor.slotsDir",
      "routing.executor.circuitBreaker.failureRatio",
      "routing.executor.circuitBreaker.minAttempts",
    ]);
  });

  it("lists an invalid value too, and nothing for an absent or empty block", () => {
    expect(configuredV2OnlyKeys({ routing: { executor: { maxParallel: "many" } } })).toEqual(["routing.executor.maxParallel"]);
    expect(configuredV2OnlyKeys({ routing: { executor: {} } })).toEqual([]);
    expect(configuredV2OnlyKeys({ routing: {} })).toEqual([]);
    expect(configuredV2OnlyKeys({ routing: { executor: 3 } })).toEqual([]);
  });

  it("lists the executor keys after the background and leases keys, in a fixed order", () => {
    expect(
      configuredV2OnlyKeys({ routing: { executor: { approve: "auto" }, leases: { mode: "off" }, background: { mode: "off" } } }),
    ).toEqual(["routing.background.mode", "routing.leases.mode", "routing.executor.approve"]);
  });

  it("ignores every executor key on v1: the defaults apply and nothing is logged here", () => {
    const logger = { warn: vi.fn() };
    const cfg = cfgWith({ maxParallel: 8, approve: "auto", slotsDir: "D:\\slots", circuitBreaker: { minAttempts: 40 } });
    expect(resolveRouting(cfg, "v1", logger).executor).toEqual(APPENDIX_C_DEFAULTS);
    const raw: RouterConfig = { ...cfg, routing: { executor: { maxParallel: 99 } } };
    expect(resolveRouting(raw, "v1", logger).executor).toEqual(APPENDIX_C_DEFAULTS);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("routing.executor — trust (D18): project-local override", () => {
  let home = "";
  let project = "";
  let saved: { HOME: string | undefined; USERPROFILE: string | undefined };
  const projectFile = (): string => join(project, ".opencode", "opencode-model-router.overrides.jsonc");
  const writeProject = (data: unknown): void => {
    writeFileSync(projectFile(), JSON.stringify(data), "utf-8");
    invalidateConfigCache();
  };
  const writeGlobal = (data: unknown): void => {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify(data), "utf-8");
    invalidateConfigCache();
  };
  const TRUSTED = {
    slotsDir: "D:\\project-chosen-slots",
    integrationChecks: [{ script: "evil", args: [] }],
    phaseSuite: [{ script: "evil", args: [] }],
    provision: { npm: [["curl", "evil.example"]] },
    python: join(parse(process.cwd()).root, "evil", "python.exe"),
  };

  beforeEach(() => {
    saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    home = mkdtempSync(join(tmpdir(), "oc-mr-executor-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    if (homedir() !== home) throw new Error(`os.homedir() is "${homedir()}", not the temporary home "${home}"`);
    project = mkdtempSync(join(tmpdir(), "oc-mr-executor-proj-"));
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, ".opencode"), { recursive: true });
    resetRoutingWarnings();
    invalidateConfigCache();
  });

  afterEach(() => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    invalidateConfigCache();
  });

  it("drops the five trusted keys from the project layer, keeps the others, and says so in one notice", () => {
    // A-4.1-2: the project layer may only tighten, so the kept keys are tighter than the defaults.
    writeProject({ routing: { executor: { ...TRUSTED, maxParallel: 2, circuitBreaker: { minAttempts: 2 } } } });
    const executor = resolveRouting(loadConfig(project), "v2").executor;
    expect(executor).toEqual({
      ...APPENDIX_C_DEFAULTS,
      maxParallel: 2,
      circuitBreaker: { failureRatio: 0.4, minAttempts: 2, consecutiveFailures: 3 },
    });
    const notices = getConfigNotices(project).map((n) => n.message);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      `ignoring routing.executor.slotsDir, routing.executor.integrationChecks, routing.executor.phaseSuite, routing.executor.provision, routing.executor.python from ${projectFile()}: only the global override may set it`,
    );
  });

  it.each(Object.keys(TRUSTED) as Array<keyof typeof TRUSTED>)("drops %s alone and leaves an executor block that carried nothing else empty", (key) => {
    writeProject({ routing: { executor: { [key]: TRUSTED[key] } } });
    expect(resolveRouting(loadConfig(project), "v2").executor).toEqual(APPENDIX_C_DEFAULTS);
    expect(getConfigNotices(project).map((n) => n.message)).toEqual([
      `ignoring routing.executor.${key} from ${projectFile()}: only the global override may set it`,
    ]);
  });

  it("does not switch routing on when the project file's only routing content was a trusted key", () => {
    writeProject({ routing: { executor: { slotsDir: TRUSTED.slotsDir } } });
    expect(loadConfig(project).routing).toBeUndefined();
  });

  it("honours the trusted keys from the global layer, and the project layer cannot replace them", () => {
    const python = TRUSTED.python;
    writeGlobal({
      routing: {
        executor: {
          slotsDir: "D:\\global-slots",
          integrationChecks: [{ script: "test", args: [] }],
          phaseSuite: "off",
          provision: { npm: [["npm", "ci"]] },
          python,
        },
      },
    });
    writeProject({ routing: { executor: { ...TRUSTED, land: "manual" } } });
    const executor = resolveRouting(loadConfig(project), "v2").executor;
    expect(executor).toMatchObject({
      slotsDir: "D:\\global-slots",
      integrationChecks: [{ script: "test", args: [] }],
      phaseSuite: "off",
      provision: { npm: [["npm", "ci"]] },
      python,
      land: "manual", // an untrusted key still applies from the project layer when it tightens (A-4.1-2)
    });
  });

  /** The notices about `routing.executor` (other routing notices are not under test here). */
  const messages = (): string[] => getConfigNotices(project).map((n) => n.message).filter((m) => m.includes("routing.executor"));
  const executorNow = () => resolveRouting(loadConfig(project), "v2").executor;
  const tightenNotice = (key: string): string =>
    `A18: ignoring routing.executor.${key} from ${projectFile()}: project overrides may only tighten the lower-layer value (A-4.1-2)`;

  it.each([
    ["null", null],
    ["an empty array", []],
    ["a string", "x"],
    ["zero", 0],
  ])("QA-4.1-2: a project executor that is %s cannot reset the global trusted keys", (_label, bad) => {
    const python = TRUSTED.python;
    writeGlobal({ routing: { executor: { phaseSuite: "off", python } } });
    writeProject({ routing: { executor: bad } });
    const executor = executorNow();
    expect(executor.phaseSuite).toBe("off");
    expect(executor.python).toBe(python);
    expect(messages()).toEqual([`ignoring routing.executor from ${projectFile()}: only the global override may set it`]);
  });

  it("QA-4.1-2: a non-object classifier or outcomes block in the project layer is dropped the same way", () => {
    writeProject({ routing: { classifier: null, outcomes: [], margin: 0.1 } });
    expect(loadConfig(project).routing?.margin).toBe(0.1);
    expect(getConfigNotices(project).map((n) => n.message)).toContain(
      `ignoring routing.classifier, routing.outcomes from ${projectFile()}: only the global override may set it`,
    );
  });

  it.each([
    ["approve", "auto", "ask"],
    ["land", "ff-when-clean", "manual"],
    ["crossPhase", "inferred", "gate"],
  ] as const)("A-4.1-2: the project may set %s only to its tightest value", (key, loose, tight) => {
    writeGlobal({ routing: { executor: { [key]: tight } } });
    writeProject({ routing: { executor: { [key]: loose } } });
    expect(executorNow()[key]).toBe(tight);
    expect(messages()).toEqual([tightenNotice(key)]);

    // An invalid project value would mean the default; it cannot loosen the lower value either.
    writeProject({ routing: { executor: { [key]: "bogus" } } });
    expect(executorNow()[key]).toBe(tight);

    writeGlobal({ routing: { executor: { [key]: loose } } });
    writeProject({ routing: { executor: { [key]: tight } } });
    expect(executorNow()[key]).toBe(tight);
    expect(messages()).toEqual([]);

    // Restating the lower value is not a loosening.
    writeProject({ routing: { executor: { [key]: loose } } });
    expect(executorNow()[key]).toBe(loose);
    expect(messages()).toEqual([]);
  });

  it.each([
    ["approve", "auto"],
    ["crossPhase", "inferred"],
  ] as const)("A-4.1-2: without a global value the project cannot loosen %s past its default", (key, loose) => {
    writeProject({ routing: { executor: { [key]: loose } } });
    expect(executorNow()[key]).toBe(APPENDIX_C_DEFAULTS[key]);
    expect(messages()).toEqual([tightenNotice(key)]);
  });

  it.each(["maxParallel", "batchMax", "maxAttempts", "qaMaxRounds", "sharedContextChars"] as const)(
    "A-4.1-2: %s from the project is min(lower layer, project value)",
    (key) => {
      const [min, max] = EXECUTOR_LIMITS[key];
      const lower = min + 1;
      writeGlobal({ routing: { executor: { [key]: lower } } });
      writeProject({ routing: { executor: { [key]: max } } });
      expect(executorNow()[key]).toBe(lower);
      expect(messages()).toEqual([tightenNotice(key)]);

      writeProject({ routing: { executor: { [key]: min } } });
      expect(executorNow()[key]).toBe(min);
      expect(messages()).toEqual([]);

      // An invalid project value would mean the (higher) default.
      writeProject({ routing: { executor: { [key]: "many" } } });
      expect(executorNow()[key]).toBe(lower);
      expect(messages()).toEqual([tightenNotice(key)]);

      // Without a global value the default is the ceiling.
      writeGlobal({});
      writeProject({ routing: { executor: { [key]: max } } });
      expect(executorNow()[key]).toBe(APPENDIX_C_DEFAULTS[key]);
      expect(messages()).toEqual([tightenNotice(key)]);
    },
  );

  it("A-4.1-2: the timing keys are not budgets, the project may raise them", () => {
    writeProject({ routing: { executor: { capacityCooldownMs: 600000, wakeDebounceMs: 10000 } } });
    expect(executorNow()).toMatchObject({ capacityCooldownMs: 600000, wakeDebounceMs: 10000 });
    expect(messages()).toEqual([]);
  });

  it.each([
    ["failureRatio", 0.3, 0.9, 0.2],
    ["minAttempts", 3, 20, 2],
    ["consecutiveFailures", 2, 10, 1],
  ] as const)("A-4.1-2: circuitBreaker.%s from the project may only be lowered", (key, lower, looser, tighter) => {
    writeGlobal({ routing: { executor: { circuitBreaker: { [key]: lower } } } });
    writeProject({ routing: { executor: { circuitBreaker: { [key]: looser } } } });
    expect(executorNow().circuitBreaker[key]).toBe(lower);
    expect(messages()).toEqual([tightenNotice(`circuitBreaker.${key}`)]);

    writeProject({ routing: { executor: { circuitBreaker: { [key]: tighter } } } });
    expect(executorNow().circuitBreaker[key]).toBe(tighter);
    expect(messages()).toEqual([]);

    writeGlobal({});
    writeProject({ routing: { executor: { circuitBreaker: { [key]: looser } } } });
    expect(executorNow().circuitBreaker[key]).toBe(APPENDIX_C_DEFAULTS.circuitBreaker[key]);
    expect(messages()).toEqual([tightenNotice(`circuitBreaker.${key}`)]);
  });

  it("A-4.1-2: a project circuitBreaker that is not an object cannot reset the lower values", () => {
    const tight = { failureRatio: 0.2, minAttempts: 2, consecutiveFailures: 1 };
    writeGlobal({ routing: { executor: { circuitBreaker: tight } } });
    writeProject({ routing: { executor: { circuitBreaker: null } } });
    expect(executorNow().circuitBreaker).toEqual(tight);
    expect(messages()).toEqual([tightenNotice("circuitBreaker")]);
  });

  it("QA-4.1-9: an invalid executor value is a v2-only notice, and configAsWritten still names its key", () => {
    writeGlobal({ routing: { executor: { maxParallel: 99 } } });
    const cfg = loadConfig(project);
    expect(cfg.routing?.executor?.maxParallel).toBeUndefined();
    const executorKeys = (raw: unknown): string[] => configuredV2OnlyKeys(raw).filter((k) => k.startsWith("routing.executor."));
    expect(executorKeys(cfg)).toEqual([]);
    expect(executorKeys(configAsWritten(cfg))).toEqual(["routing.executor.maxParallel"]);
    expect(getConfigNotices(project)).toContainEqual({
      message: "routing.executor.maxParallel must be an integer from 1 to 8 (got 99); using 4",
      v2Only: true,
    });
  });
});

describe("routing.executor — the OpenCode v1 notice through the plugin (QA-4.1-9)", () => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omr-v1-executor-notice-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  afterEach(async () => {
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await removeDirWhenReleased(home);
  });

  it("names the invalid keys in the one v1 notice and logs no executor validation issue", async () => {
    vi.resetModules();
    const config = await import("../../src/router/config");
    const fresh = await import("../../src/index");
    mkdirSync(dirname(config.overridePath()), { recursive: true });
    writeFileSync(config.overridePath(), JSON.stringify({ routing: { executor: { maxParallel: 99, approve: "x" } } }), "utf-8");
    config.invalidateConfigCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fresh.default({
        directory: home, worktree: home, project: {}, serverUrl: new URL("http://localhost"), $: () => undefined,
        client: { session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) } },
      } as unknown as Parameters<typeof fresh.default>[0]);
      const lines = warn.mock.calls.map((c) => c.join(" "));
      const notices = lines.filter((line) => line.includes("OpenCode v2; ignored"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("[router] the plan executor requires OpenCode v2; ignored: ");
      expect(notices[0]).toContain("routing.executor.maxParallel");
      expect(notices[0]).toContain("routing.executor.approve");
      expect(lines.filter((line) => line.includes("routing.executor.") && line.includes("must be"))).toEqual([]);
      expect(lines.filter((line) => line.includes("using 4"))).toEqual([]);
      expect(config.getConfigNotices(home).filter((n) => n.message.includes("routing.executor"))).toEqual([]);
    } finally {
      warn.mockRestore();
      config.setConfigNoticeHost(undefined);
    }
  });
});
