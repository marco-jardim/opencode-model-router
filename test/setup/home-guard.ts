/**
 * Global vitest setup (QA-1.1-1, QA-1.1-17, QA-1.1-22, amendment A14): no test may
 * reach the real user home directory.
 *
 * `src/router/config.ts` builds the global override file and the persisted state
 * file from `os.homedir()`. Tests redirect `process.env.HOME` / `USERPROFILE` to a
 * temp dir, but `os.homedir()` is native code: it follows the env only in a
 * forked process, never in a worker thread, and on Windows it ignores `HOME`
 * altogether. A redirect that does not reach `homedir()` makes a test write the
 * user's real `~/.config/opencode/*` files, which drive a live OpenCode session.
 *
 * So `node:os` `homedir` (named export and `default`) is replaced for every test
 * file with {@link guardedHomedir}, which resolves the home the way the tests
 * intend it, from `process.env` in JavaScript, correct in every pool:
 *
 *  - a test that redirected `HOME` and/or `USERPROFILE` (a value different from
 *    the one the worker started with) gets that value;
 *  - a test that redirected nothing gets a private, empty temp dir that is removed
 *    after the file, never the real home;
 *  - if the value to return IS the real home (compared after `realpath`, so a
 *    trailing slash, a `..` segment, a different case or an 8.3 short name does
 *    not hide it) the call throws: fail fast, before anything is written.
 *
 * The same goes for the temp directory (QA-2.1-4): `os.tmpdir()` (named export and
 * `default`) and `TEMP`/`TMP`/`TMPDIR` point at a private temp dir per test file,
 * removed afterwards. Code that writes under `os.tmpdir()` by default, notably the
 * scorecard directory `<tmpdir>/opencode-model-router-trajectory` that also holds
 * the outcome store and the decision log, can therefore never reach the real one
 * (which a live OpenCode session may be writing to). A test that points
 * `TEMP`/`TMP`/`TMPDIR` back at the real temp dir makes `tmpdir()` throw.
 *
 * A test file that mocks `node:os` itself replaces this mock, and with it the
 * guard. Such a file must keep the guard by including
 * `homedir: guardedHomedir` (see `test/unit/tree.test.ts`); the `beforeEach`
 * below fails every test of a file whose `os.homedir()` resolves the real home.
 */
import { mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, vi } from "vitest";

const guard = vi.hoisted(() => ({
  realHome: "",
  isolatedHome: "",
  original: { HOME: undefined as string | undefined, USERPROFILE: undefined as string | undefined },
  realTmp: "",
  isolatedTmp: "",
  originalTmp: {} as Record<string, string | undefined>,
  /** Why a stale guard directory could not be removed (kept so the catch below is not empty). */
  tidyNotes: [] as string[],
}));

/** Environment variables `os.tmpdir()` reads, in the platform's own order. */
const TMP_ENV = process.platform === "win32" ? (["TEMP", "TMP"] as const) : (["TMPDIR", "TMP", "TEMP"] as const);
/** Holds the real temp dir for the whole process, so a later test file of the same process still knows it. */
export const REAL_TMPDIR_ENV = "OMR_TEST_REAL_TMPDIR";

const WINDOWS = process.platform === "win32";

/** A comparable form of a directory: real path when it exists, else normalized; case-folded on Windows. */
function canonical(path: string): string {
  let resolved: string;
  try {
    resolved = realpathSync.native(path);
  } catch {
    // Not on disk (yet): `resolve` still removes `..` segments and doubled separators.
    resolved = resolve(path);
  }
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return WINDOWS ? trimmed.toLowerCase() : trimmed;
}

/** True when `a` and `b` name the same directory, whatever their spelling. */
export function sameDir(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/**
 * The guarded `os.homedir()`: the HOME/USERPROFILE a test redirected, else a
 * private empty temp dir; throws instead of ever returning the real home.
 */
export function guardedHomedir(): string {
  // The platform's own variable first, as os.homedir() would.
  const names = WINDOWS ? (["USERPROFILE", "HOME"] as const) : (["HOME", "USERPROFILE"] as const);
  let resolved = guard.isolatedHome;
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "" && value !== guard.original[name]) {
      resolved = value;
      break;
    }
  }
  if (guard.realHome !== "" && sameDir(resolved, guard.realHome)) {
    throw new Error(
      `home-guard: a test resolved the real home directory (${resolved}). ` +
        "Point HOME/USERPROFILE at a temp dir instead (see test/setup/home-guard.ts, amendment A14).",
    );
  }
  return resolved;
}

/**
 * Fails when `homedir()` names the real home: the check run before every test
 * against the `os` module that test file actually sees. Exported so the guard
 * itself can be tested.
 */
export function assertHomeIsGuarded(homedir: () => string): void {
  const home = homedir();
  if (guard.realHome !== "" && sameDir(home, guard.realHome)) {
    throw new Error(
      `home-guard: os.homedir() resolves the real home directory (${home}) in this test file. ` +
        "A file that mocks node:os itself must include `homedir: guardedHomedir` from test/setup/home-guard.ts " +
        "(amendment A14).",
    );
  }
}

/**
 * The guarded `os.tmpdir()`: the TEMP/TMP/TMPDIR a test redirected (the setup itself points them at a private
 * dir), else that private dir; throws instead of ever returning the real temp dir.
 */
export function guardedTmpdir(): string {
  let resolved = guard.isolatedTmp;
  for (const name of TMP_ENV) {
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      resolved = value;
      break;
    }
  }
  if (guard.realTmp !== "" && sameDir(resolved, guard.realTmp)) {
    throw new Error(
      `home-guard: a test resolved the real temp directory (${resolved}), which holds the live scorecard and outcome files. ` +
        "Point TEMP/TMP/TMPDIR at a temp dir instead (see test/setup/home-guard.ts, QA-2.1-4).",
    );
  }
  return resolved;
}

/** Fails when `tmpdir()` names the real temp dir; run before every test against the `os` module the file sees. */
export function assertTmpIsGuarded(tmpdir: () => string): void {
  const dir = tmpdir();
  if (guard.realTmp !== "" && sameDir(dir, guard.realTmp)) {
    throw new Error(
      `home-guard: os.tmpdir() resolves the real temp directory (${dir}) in this test file. ` +
        "A file that mocks node:os itself must include `tmpdir: guardedTmpdir` from test/setup/home-guard.ts (QA-2.1-4).",
    );
  }
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: guardedHomedir,
    tmpdir: guardedTmpdir,
    default: { ...actual, homedir: guardedHomedir, tmpdir: guardedTmpdir },
  };
});

// Runs once per test file, before it is imported: capture what is real.
const realOs = await vi.importActual<typeof import("node:os")>("node:os");
guard.realHome = realOs.homedir();
guard.original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
// The real temp dir is read once per process: after the first file the environment already points at a private dir.
guard.realTmp = process.env[REAL_TMPDIR_ENV] ?? realOs.tmpdir();
process.env[REAL_TMPDIR_ENV] = guard.realTmp;
guard.isolatedHome = mkdtempSync(join(guard.realTmp, "omr-home-guard-"));
guard.isolatedTmp = mkdtempSync(join(guard.realTmp, "omr-tmp-guard-"));
for (const name of ["TEMP", "TMP", "TMPDIR"]) {
  guard.originalTmp[name] = process.env[name];
  process.env[name] = guard.isolatedTmp;
}

// A dynamic import goes through the test file's own module mocks, so this sees
// exactly the `homedir` the code under test sees.
beforeEach(async () => {
  const os = await import("node:os");
  assertHomeIsGuarded(os.homedir);
  assertTmpIsGuarded(os.tmpdir);
});

// A skipped test file never runs `afterAll` and its worker is not always given the chance to exit cleanly, but its setup
// file did create these dirs. Remove what an earlier run left: only EMPTY guard dirs (`rmdir` refuses anything else)
// that are old enough not to belong to a worker that is starting right now.
const STALE_GUARD_DIR_MS = 10 * 60_000;
for (const name of readdirSync(guard.realTmp)) {
  if (!/^omr-(home|tmp)-guard-/.test(name)) continue;
  const path = join(guard.realTmp, name);
  if (sameDir(path, guard.isolatedHome) || sameDir(path, guard.isolatedTmp)) continue;
  try {
    if (Date.now() - statSync(path).mtimeMs > STALE_GUARD_DIR_MS) rmdirSync(path);
  } catch (error) {
    guard.tidyNotes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

afterAll(() => {
  rmSync(guard.isolatedHome, { recursive: true, force: true });
  rmSync(guard.isolatedTmp, { recursive: true, force: true });
  for (const [name, value] of Object.entries(guard.originalTmp)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
