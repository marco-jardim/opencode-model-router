/**
 * Global vitest setup (QA-1.1-1, QA-1.1-17, amendment A14): no test may reach the
 * real user home directory.
 *
 * `src/router/config.ts` builds the global override file and the persisted state
 * file from `os.homedir()`. Tests redirect `process.env.HOME` / `USERPROFILE` to a
 * temp dir, but `os.homedir()` is native code: it follows the env only in a
 * forked process, never in a worker thread, and on Windows it ignores `HOME`
 * altogether. A redirect that does not reach `homedir()` makes a test write the
 * user's real `~/.config/opencode/*` files, which drive a live OpenCode session.
 *
 * So `node:os` `homedir` (named export and `default`) is replaced for every test
 * file with a function that resolves the home the way the tests intend it, from
 * `process.env` in JavaScript, which is correct in every pool:
 *
 *  - a test that redirected `HOME` and/or `USERPROFILE` (a value different from
 *    the one the worker started with) gets that value;
 *  - a test that redirected nothing gets a private, empty temp dir that is removed
 *    after the file, never the real home;
 *  - if the value to return IS the real home (a test pointing `HOME` at it, or
 *    restoring it wrongly) the call throws: fail fast, before anything is written.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

const guard = vi.hoisted(() => ({
  realHome: "",
  isolatedHome: "",
  original: { HOME: undefined as string | undefined, USERPROFILE: undefined as string | undefined },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const win = process.platform === "win32";
  const normalize = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, "");
    return win ? trimmed.toLowerCase() : trimmed;
  };

  const homedir = (): string => {
    // The platform's own variable first, as os.homedir() would.
    const names = win ? (["USERPROFILE", "HOME"] as const) : (["HOME", "USERPROFILE"] as const);
    let resolved = guard.isolatedHome;
    for (const name of names) {
      const value = process.env[name];
      if (value !== undefined && value !== "" && value !== guard.original[name]) {
        resolved = value;
        break;
      }
    }
    if (guard.realHome !== "" && normalize(resolved) === normalize(guard.realHome)) {
      throw new Error(
        `home-guard: a test resolved the real home directory (${resolved}). ` +
          "Point HOME/USERPROFILE at a temp dir instead (see test/setup/home-guard.ts, amendment A14).",
      );
    }
    return resolved;
  };

  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Runs once per test file, before it is imported: capture what is real.
const realOs = await vi.importActual<typeof import("node:os")>("node:os");
guard.realHome = realOs.homedir();
guard.original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
guard.isolatedHome = mkdtempSync(join(realOs.tmpdir(), "omr-home-guard-"));

afterAll(() => {
  rmSync(guard.isolatedHome, { recursive: true, force: true });
});
