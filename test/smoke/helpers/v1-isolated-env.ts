/**
 * The environment of the v1 keyless smoke's `opencode serve` host (#68, #95 item 2).
 *
 * The caller's environment is NOT inherited: only the system variables of V1_ENV_ALLOWLIST pass (matched
 * case-insensitively; Windows names are case-insensitive), so no provider key and no OPENCODE_* / XDG_* / APPDATA /
 * LOCALAPPDATA of the caller reaches the host. HOME/USERPROFILE and every config/data/cache/state/temp root are repointed
 * under the temp home and created, so opencode writes its config, data, cache, state and log there.
 *
 * The allowlist and the directory layout are the ones test/smoke/helpers/routing-host.ts gives the v2 `opencode serve`
 * host. They are kept here rather than imported because this file is v1-frozen: scenario `6-v1-untouched` of
 * test/smoke/routing-engine.smoke.test.ts pins it (V1_REVIEWED_BASES), while the v2 harness is outside that freeze.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** System variables the host may inherit (matched case-insensitively). */
export const V1_ENV_ALLOWLIST: readonly string[] = ["PATH", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"];

/** Every root opencode (or the runtime) resolves from the environment, as a subfolder of the temp home. */
export const V1_ISOLATED_DIRS: Readonly<Record<string, string>> = {
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
  TEMP: "tmp",
  TMP: "tmp",
  TMPDIR: "tmp",
};

/** The host environment under `home`: allowlisted system variables, then HOME/USERPROFILE and V1_ISOLATED_DIRS (created). */
export function isolatedEnv(home: string): Record<string, string> {
  const allowed = new Set(V1_ENV_ALLOWLIST);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  for (const [name, dir] of Object.entries(V1_ISOLATED_DIRS)) {
    env[name] = path.join(home, dir);
    fs.mkdirSync(env[name], { recursive: true });
  }
  return env;
}

/** Where opencode writes its log for a host started with `env`: $XDG_DATA_HOME/opencode/log. */
export function opencodeLogDir(env: Record<string, string>): string {
  return path.join(env.XDG_DATA_HOME, "opencode", "log");
}
