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
 * A test file that mocks `node:os` itself replaces this mock, and with it the
 * guard. Such a file must keep the guard by including
 * `homedir: guardedHomedir` (see `test/unit/tree.test.ts`); the `beforeEach`
 * below fails every test of a file whose `os.homedir()` resolves the real home.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeEach, vi } from "vitest";

const guard = vi.hoisted(() => ({
  realHome: "",
  isolatedHome: "",
  original: { HOME: undefined as string | undefined, USERPROFILE: undefined as string | undefined },
}));

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

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: guardedHomedir, default: { ...actual, homedir: guardedHomedir } };
});

// Runs once per test file, before it is imported: capture what is real.
const realOs = await vi.importActual<typeof import("node:os")>("node:os");
guard.realHome = realOs.homedir();
guard.original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
guard.isolatedHome = mkdtempSync(join(realOs.tmpdir(), "omr-home-guard-"));

// A dynamic import goes through the test file's own module mocks, so this sees
// exactly the `homedir` the code under test sees.
beforeEach(async () => {
  assertHomeIsGuarded((await import("node:os")).homedir);
});

afterAll(() => {
  rmSync(guard.isolatedHome, { recursive: true, force: true });
});
