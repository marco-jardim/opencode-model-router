// #68 / #95 item 2: the v1 deferred-catalog smoke host must not inherit the caller's environment. With an XDG_DATA_HOME
// inherited from the parent, opencode used to write its log there while the smoke searched under its temp HOME. These
// cases pin the env builder and the log location the smoke reads, without spawning opencode.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { V1_ENV_ALLOWLIST, V1_ISOLATED_DIRS, isolatedEnv, opencodeLogDir } from "../smoke/helpers/v1-isolated-env";

let home = "";
let outside = "";

/** True when `dir` is `root` itself or below it. */
const within = (dir: string, root: string): boolean => {
  const rel = path.relative(root, dir);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "omr-v1env-home-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "omr-v1env-outside-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of [home, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("v1 smoke isolated env (#68, #95)", () => {
  it("drops an inherited XDG_DATA_HOME and reads opencode's log from the isolated data dir", () => {
    const inherited = path.join(outside, "xdg-data");
    vi.stubEnv("XDG_DATA_HOME", inherited);
    expect(process.env.XDG_DATA_HOME).toBe(inherited);

    const env = isolatedEnv(home);
    expect(env.XDG_DATA_HOME).toBe(path.join(home, "data"));
    expect(Object.values(env).some((value) => value.includes(inherited))).toBe(false);

    const logDir = opencodeLogDir(env);
    expect(logDir).toBe(path.join(home, "data", "opencode", "log"));
    expect(within(logDir, home)).toBe(true);
    expect(within(logDir, inherited)).toBe(false);
    // Nothing is created at the inherited location.
    expect(fs.existsSync(inherited)).toBe(false);
  });

  it("repoints HOME/USERPROFILE and every XDG, APPDATA, LOCALAPPDATA and temp root under the temp home, and creates them", () => {
    for (const name of [...Object.keys(V1_ISOLATED_DIRS), "HOME", "USERPROFILE"]) vi.stubEnv(name, path.join(outside, name));

    const env = isolatedEnv(home);
    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    for (const [name, dir] of Object.entries(V1_ISOLATED_DIRS)) {
      expect(env[name], name).toBe(path.join(home, dir));
      expect(fs.statSync(env[name]).isDirectory(), name).toBe(true);
    }
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("passes only allowlisted system variables: no provider key, OPENCODE_* or other caller variable", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key");
    vi.stubEnv("OPENAI_API_KEY", "sk-not-a-real-key");
    vi.stubEnv("OPENCODE_CONFIG_DIR", path.join(outside, "opencode-config"));
    vi.stubEnv("OPENCODE_CONFIG", path.join(outside, "opencode.json"));
    vi.stubEnv("OMR_V1ENV_PROBE", "leak");

    const env = isolatedEnv(home);
    const allowed = new Set(V1_ENV_ALLOWLIST);
    const repointed = new Set(["HOME", "USERPROFILE", ...Object.keys(V1_ISOLATED_DIRS)]);
    const stray = Object.keys(env).filter((name) => !allowed.has(name.toUpperCase()) && !repointed.has(name));
    expect(stray).toEqual([]);
    expect(Object.values(env).some((value) => value.includes(outside))).toBe(false);
    // PATH is kept (whatever its case on this platform), so `opencode` still resolves.
    const pathName = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH");
    if (pathName !== undefined) expect(env[pathName]).toBe(process.env[pathName]);
  });
});
