import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const NAMES = ["TEMP", "TMP", "TMPDIR", "OMR_SMOKE_REAL_TMPDIR"] as const;
let original: Partial<Record<(typeof NAMES)[number], string | undefined>> | undefined;
let isolated: string | undefined;

/** Global setup runs before worker creation, so native os.tmpdir() and spawned hosts inherit isolation. */
export function setup(): void {
  const real = tmpdir();
  original = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  isolated = join(real, `omr-smoke-tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(isolated);
  process.env.OMR_SMOKE_REAL_TMPDIR = real;
  for (const name of ["TEMP", "TMP", "TMPDIR"]) process.env[name] = isolated;
}

export function teardown(): void {
  try {
    if (isolated !== undefined) fs.rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn(`smoke-tmp-guard: cannot remove ${isolated}: ${String(error)}`);
  } finally {
    if (original !== undefined) for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    isolated = undefined;
    original = undefined;
  }
}

/** Keyed lanes retain host providers/auth, but the router's homedir-based override/state is private.
 * OpenCode v2 Windows `debug paths` confirms XDG roots (with /opencode appended) are honored.
 * These lanes deliberately share host config/data; they are NOT fully isolated/keyless hosts.
 */
export function keyedSmokeEnv(): NodeJS.ProcessEnv {
  if (!process.env.OMR_SMOKE_REAL_TMPDIR) throw new Error("keyed smoke requires vitest.smoke.config.ts temp guard");
  const realHome = homedir();
  const home = join(tmpdir(), `keyed-home-${process.pid}`);
  fs.mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(realHome, ".config"),
    XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(realHome, ".local", "share"),
  };
}
