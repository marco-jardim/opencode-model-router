/**
 * #84 P3.3 global QA round 1: QA-G-A2-1 (router_run's cwd check never reaches a network host) and QA-G-A2-6 (credential
 * environment names). `node:fs` is wrapped so every call that names a network/device path is recorded and answered locally
 * (ENOENT, or a fake for the UNC roots below): no test here may ever touch the network, before or after the fix.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeCwd, isCredentialEnv, runEnvironment } from "../../src/router/run-tools";

/** Fake UNC directories: their "real path" (realpathSync.native) and that they are directories (statSync). */
const fakeUnc = new Map<string, string>();
/** Every fs call whose first argument looks like a network or device path, or names the attacker host. */
const touched: string[] = [];

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const remote = (path: unknown): path is string => typeof path === "string" && (/^[\\/]{2}/.test(path) || /attacker/i.test(path));
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${path}'`), { code: "ENOENT" });
  const guard = <F extends (...args: any[]) => any>(name: string, original: F, local?: (path: string, ...rest: any[]) => unknown): F =>
    ((path: unknown, ...rest: unknown[]) => {
      if (remote(path)) {
        touched.push(`${name}:${path}`);
        if (local !== undefined) return local(path, ...rest);
        throw enoent(path);
      }
      return original(path, ...rest);
    }) as F;
  const native = guard("realpath", actual.realpathSync.native, path => {
    const real = fakeUnc.get(path.toLowerCase());
    if (real === undefined) throw enoent(path);
    return real;
  });
  const realpathSync = Object.assign(guard("realpath", actual.realpathSync), { native });
  const statSync = guard("stat", actual.statSync, path => {
    if (![...fakeUnc.values()].some(real => real.toLowerCase() === path.toLowerCase())) throw enoent(path);
    return { isDirectory: () => true, isFile: () => false };
  });
  const lstatSync = guard("lstat", actual.lstatSync);
  const existsSync = guard("exists", actual.existsSync, () => false);
  const openSync = guard("open", actual.openSync);
  const wrapped = { ...actual, realpathSync, statSync, lstatSync, existsSync, openSync };
  return { ...wrapped, default: wrapped };
});

const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;
let root: string;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "router-run-cwd-")));
  touched.length = 0;
  fakeUnc.clear();
});
afterEach(() => {
  rmSync(root, RM);
  fakeUnc.clear();
});

const refusal = (bound: string, cwd: string, platform: NodeJS.Platform = "win32"): string => {
  try {
    authorizeCwd(bound, cwd, platform);
  } catch (error) {
    return (error as Error).message;
  }
  return "accepted";
};

describe("QA-G-A2-1: router_run's cwd never reaches a network host", () => {
  it.skipIf(process.platform !== "win32")("refuses a UNC, device or //host cwd before any filesystem call when the root is local", () => {
    for (const cwd of [
      "\\\\attacker\\share\\x", "//attacker/share/x", "\\\\?\\UNC\\attacker\\share\\x", "\\\\.\\UNC\\attacker\\share\\x",
      "\\\\attacker.example\\share", "\\/attacker\\share\\x",
    ]) {
      expect(refusal(root, cwd), cwd).toMatch(/cwd is not this dispatch's work root/);
    }
    expect(touched).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("a device-path spelling of the local root is refused without a filesystem call on it", () => {
    for (const cwd of [`\\\\?\\${root}`, `\\\\.\\${root}`]) expect(refusal(root, cwd), cwd).toMatch(/cwd is not this dispatch's work root/);
    expect(touched).toEqual([]);
  });

  it("compares the text first: the bound root as written (separators, case on win32, trailing separator) needs no realpath of the cwd", () => {
    const bound = "\\\\attacker\\share\\root";
    fakeUnc.set(bound.toLowerCase(), bound);
    expect(refusal(bound, "\\\\ATTACKER\\share\\root\\")).toBe("accepted");
    expect(refusal(bound, "//attacker/share/root")).toBe("accepted");
    // Only the bound root itself was resolved (once per call); never the cwd as written.
    expect(touched.filter(call => call.startsWith("realpath:"))).toEqual([`realpath:${bound}`, `realpath:${bound}`]);
  });

  it("a UNC cwd on the bound root's own \\\\host\\share is resolved; one on another host or share is refused unresolved", () => {
    const bound = "\\\\attacker\\share\\root";
    fakeUnc.set(bound.toLowerCase(), bound);
    fakeUnc.set("\\\\attacker\\share\\alias", bound); // e.g. a link on the same share
    expect(refusal(bound, "\\\\attacker\\share\\alias")).toBe("accepted");
    expect(touched).toContain("realpath:\\\\attacker\\share\\alias");
    touched.length = 0;
    for (const cwd of ["\\\\attacker\\other\\root", "\\\\attacker2\\share\\root", "\\\\?\\UNC\\other\\share\\root", "\\\\.\\pipe\\x"]) {
      expect(refusal(bound, cwd), cwd).toMatch(/cwd is not this dispatch's work root/);
    }
    expect(touched.filter(call => !call.endsWith(bound))).toEqual([]);
  });

  it("a local cwd still resolves (links, 8.3, case) and a foreign local cwd is still refused", () => {
    expect(authorizeCwd(root, root)).toBe(root);
    expect(refusal(root, join(root, "missing"), process.platform)).toMatch(/cwd is not this dispatch's work root/);
    expect(refusal(root, "relative", process.platform)).toMatch(/cwd must be the absolute path/);
  });
});

describe("QA-G-A2-6: credential environment names", () => {
  it("PASSWORD and PWD count without a leading `_` (PGPASSWORD, MYSQL_PWD); the working-directory variables PWD and OLDPWD stay", () => {
    for (const name of ["PGPASSWORD", "MYSQL_PWD", "DB_PWD", "REDISPASSWORD", "SMTP_PASSWD", "pgpassword", "DB_PASSWORD"]) {
      expect(isCredentialEnv(name), name).toBe(true);
    }
    for (const name of ["PWD", "OLDPWD", "pwd", "PATH", "HOME", "INIT_CWD"]) expect(isCredentialEnv(name), name).toBe(false);
    const env = runEnvironment({ PWD: "/w", OLDPWD: "/o", PGPASSWORD: "p", MYSQL_PWD: "m", HOME: "/h" }, "linux");
    expect(env).toEqual({ PWD: "/w", OLDPWD: "/o", HOME: "/h", CI: "1" });
  });
});
