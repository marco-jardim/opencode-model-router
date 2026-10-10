import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAdmission,
  defaultAdmissionDeps,
  parseWorktreeEntries,
  type AdmissionDeps,
} from "../../src/routing/roles/admission";

const isWin = process.platform === "win32";
const SHA = "3f2c1a9b8e7d6c5b4a39281706f5e4d3c2b1a090";

/** Records every deps call, by name and argument, in order. */
function recording(base: AdmissionDeps): { deps: AdmissionDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: AdmissionDeps = {
    listWorktrees: (cwd) => { calls.push(`listWorktrees ${cwd}`); return base.listWorktrees(cwd); },
    showToplevel: (cwd) => { calls.push(`showToplevel ${cwd}`); return base.showToplevel(cwd); },
    realpath: (path) => { calls.push(`realpath ${path}`); return base.realpath(path); },
    isDirectory: (path) => { calls.push(`isDirectory ${path}`); return base.isDirectory(path); },
    readdir: (path) => { calls.push(`readdir ${path}`); return base.readdir(path); },
    platform: base.platform,
    now: () => base.now(),
  };
  return { deps, calls };
}

/** Deps that fail the test if anything is called. */
function untouchable(platform: NodeJS.Platform): AdmissionDeps {
  const boom = (what: string) => (): never => { throw new Error(`unexpected ${what}`); };
  return {
    listWorktrees: boom("listWorktrees"), showToplevel: boom("showToplevel"), realpath: boom("realpath"),
    isDirectory: boom("isDirectory"), readdir: boom("readdir"), platform, now: () => 0,
  };
}

/** A fake win32 world (runs on every host): D:\Git\App is a repository with one worktree on main. */
function fakeWin(clock: { t: number }): AdmissionDeps {
  return {
    listWorktrees: async () => `worktree D:/Git/App\nHEAD ${SHA}\nbranch refs/heads/main\n\n`,
    showToplevel: async () => "D:/Git/App",
    realpath: (path) => {
      const native = path.replace(/\//g, "\\");
      if (/^d:\\git\\app$/i.test(native)) return "D:\\Git\\App";
      if (/^d:\\git$/i.test(native)) return "D:\\Git";
      return native;
    },
    isDirectory: () => true,
    readdir: () => [],
    platform: "win32",
    now: () => clock.t,
  };
}

describe("parseWorktreeEntries", () => {
  it("reads branch, detached, locked and prunable entries; the first block is the main worktree", () => {
    const porcelain = [
      "worktree D:/git/app", `HEAD ${SHA}`, "branch refs/heads/main", "",
      "worktree D:/git/app-hotfix", "HEAD 1111111111111111111111111111111111111111", "detached", "",
      "worktree C:/Temp/app-login", "HEAD 2222222222222222222222222222222222222222", "branch refs/heads/feat/login", "locked on a removable drive", "",
      "worktree C:/Temp/app-old", "HEAD 3333333333333333333333333333333333333333", "branch refs/heads/old", "prunable gitdir file points to non-existent location", "",
      "worktree C:/Temp/app-locked", "HEAD 4444444444444444444444444444444444444444", "branch refs/heads/l", "locked", "",
    ].join("\r\n");
    expect(parseWorktreeEntries(porcelain)).toEqual([
      { path: "D:/git/app", head: SHA, branch: "main", detached: false, bare: false, prunable: false },
      { path: "D:/git/app-hotfix", head: "1111111111111111111111111111111111111111", branch: null, detached: true, bare: false, prunable: false },
      { path: "C:/Temp/app-login", head: "2222222222222222222222222222222222222222", branch: "feat/login", detached: false, bare: false, prunable: false },
      { path: "C:/Temp/app-old", head: "3333333333333333333333333333333333333333", branch: "old", detached: false, bare: false, prunable: true },
      { path: "C:/Temp/app-locked", head: "4444444444444444444444444444444444444444", branch: "l", detached: false, bare: false, prunable: false },
    ]);
  });

  it("reads a bare main entry and a bare prunable marker without a reason", () => {
    const porcelain = "worktree /srv/app.git\nbare\n\nworktree /work/app-a\nHEAD 5555555555555555555555555555555555555555\nbranch refs/heads/a\nprunable\n";
    expect(parseWorktreeEntries(porcelain)).toEqual([
      { path: "/srv/app.git", head: null, branch: null, detached: false, bare: true, prunable: false },
      { path: "/work/app-a", head: "5555555555555555555555555555555555555555", branch: "a", detached: false, bare: false, prunable: true },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseWorktreeEntries("")).toEqual([]);
  });
});

describe("admission without git (fake deps)", () => {
  it.each([
    "\\\\host\\share\\repo",
    "//host/share/repo",
    "\\\\?\\D:\\git\\repo",
    "\\\\.\\D:\\git\\repo",
    "\\\\?\\UNC\\host\\share\\repo",
  ])("refuses the network or device path %s before any deps call", async (root) => {
    const admission = createAdmission({ parents: ["D:\\git"], depth: 2, exclude: [] }, untouchable("win32"));
    const admitted = await admission.admit(root, ["D:\\git\\app"]);
    expect(admitted).toEqual({ ok: false, reason: expect.stringContaining("is a network or device path") });
    const resolved = await admission.resolve({ root, branch: "main" }, { sessionRepository: "D:\\git\\app" });
    expect(resolved).toEqual({ ok: false, reason: expect.stringContaining("is a network or device path") });
  });

  it("refuses an 8.3 short-name segment and a .. segment before any deps call", async () => {
    const admission = createAdmission({ parents: ["D:\\git"], depth: 2, exclude: [] }, untouchable("win32"));
    expect(await admission.admit("D:\\git\\APP-A~1")).toEqual({ ok: false, reason: expect.stringContaining("8.3 short-name") });
    expect(await admission.admit("D:\\git\\app\\..\\..\\Windows")).toEqual({ ok: false, reason: expect.stringContaining("contains a .. segment") });
    expect(await admission.admit("git\\app")).toEqual({ ok: false, reason: expect.stringContaining("is not an absolute path") });
  });

  it("never runs git in a root outside the parents that no known repository lists", async () => {
    const { deps, calls } = recording(fakeWin({ t: 0 }));
    const admission = createAdmission({ parents: ["D:\\git"], depth: 2, exclude: [] }, deps);
    const result = await admission.admit("E:\\work\\x", ["D:\\git\\app"]);
    expect(result).toEqual({
      ok: false,
      reason: "root=E:\\work\\x is not below routing.repoParents (D:\\git) and is not a worktree of a repository in this session: no work root. Clone it or add a worktree below D:\\git.",
    });
    expect(calls).toEqual(["listWorktrees D:\\git\\app"]);
  });

  it("compares case-insensitively on win32 (fake win32 host)", async () => {
    const admission = createAdmission({ parents: ["D:\\Git"], depth: 2, exclude: [] }, fakeWin({ t: 0 }));
    const result = await admission.admit("d:/git/APP");
    expect(result).toEqual({
      ok: true,
      location: {
        repository: "D:\\Git\\App", name: "App", worktree: "D:\\Git\\App", branch: "main", head: SHA,
        worktrees: [{ path: "D:/Git/App", head: SHA, branch: "main", detached: false, bare: false, prunable: false }],
      },
    });
    const named = await admission.resolve({ root: "D:\\GIT\\app", repo: "app" }, { sessionRepository: "D:\\Git\\App" });
    expect(named.ok).toBe(true);
  });

  it("caches show-toplevel and the worktree list for 5 s", async () => {
    const clock = { t: 1_000 };
    const { deps, calls } = recording(fakeWin(clock));
    const admission = createAdmission({ parents: ["D:\\Git"], depth: 2, exclude: [] }, deps);
    const count = (name: string): number => calls.filter((call) => call.startsWith(`${name} `)).length;
    expect((await admission.admit("D:\\Git\\App")).ok).toBe(true);
    expect([count("showToplevel"), count("listWorktrees")]).toEqual([1, 1]);
    clock.t = 5_999;
    expect((await admission.admit("d:\\git\\app")).ok).toBe(true);
    expect([count("showToplevel"), count("listWorktrees")]).toEqual([1, 1]);
    clock.t = 6_000;
    expect((await admission.admit("D:\\Git\\App")).ok).toBe(true);
    expect([count("showToplevel"), count("listWorktrees")]).toEqual([2, 2]);
  });

  it("refuses when no root, repo or branch is declared", async () => {
    const admission = createAdmission({ parents: ["D:\\git"], depth: 2, exclude: [] }, untouchable("win32"));
    expect(await admission.resolve({}, { sessionRepository: "D:\\git\\app" })).toEqual({ ok: false, reason: expect.stringContaining("no root=, repo= or branch=") });
    expect(await admission.resolve({ repo: "..\\app" }, { sessionRepository: "D:\\git\\app" })).toEqual({ ok: false, reason: expect.stringContaining("is not a bare repository name") });
  });
});

describe("admission with real git", { timeout: 60_000 }, () => {
  let base = "";
  let parent = "";
  let outside = "";
  let mainSha = "";
  const env: NodeJS.ProcessEnv = {};

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const repo = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  };

  const config = () => ({ parents: [parent], depth: 2, exclude: [join(parent, "archive", "*")] });
  const session = () => ({ sessionRepository: join(parent, "alpha") });

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-admission-")));
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    writeFileSync(join(base, "gitconfig"), "");
    env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
    parent = join(base, "parent");
    outside = join(base, "outside");
    repo(join(parent, "alpha"));
    mkdirSync(join(parent, "alpha", "src"));
    git(join(parent, "alpha"), "worktree", "add", "-q", "-b", "feat/login", join(outside, "alpha-login"));
    mainSha = git(join(parent, "alpha"), "rev-parse", "HEAD");
    repo(join(parent, "solo"));
    repo(join(parent, "org", "beta"));
    repo(join(parent, "org", "deep", "gamma"));
    repo(join(parent, "archive", "old"));
    repo(join(parent, "dup"));
    repo(join(parent, "org", "dup"));
    mkdirSync(join(parent, "plain"));
    repo(join(outside, "target"));
    symlinkSync(join(outside, "target"), join(parent, "link"), isWin ? "junction" : "dir");
  }, 120_000);

  afterAll(() => {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  it("refuses the parent itself", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).admit(parent);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(`root=${parent} is itself a parent in routing.repoParents`) });
  });

  it("admits repositories 1 and 2 levels below a parent and refuses 3", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const one = await admission.admit(join(parent, "alpha"));
    expect(one).toMatchObject({ ok: true, location: { repository: join(parent, "alpha"), name: "alpha", worktree: join(parent, "alpha"), branch: "main", head: mainSha } });
    expect(one.ok && one.location.worktrees.map((entry) => entry.branch)).toEqual(["main", "feat/login"]);
    const two = await admission.admit(join(parent, "org", "beta"));
    expect(two).toMatchObject({ ok: true, location: { repository: join(parent, "org", "beta"), name: "beta", branch: "main" } });
    const gamma = join(parent, "org", "deep", "gamma");
    expect(await admission.admit(gamma)).toEqual({
      ok: false,
      reason: `root=${gamma} is 3 levels below ${parent}; repositories are admitted 1 to 2 levels below a parent (routing.repoDepth).`,
    });
  });

  it("refuses a subdirectory of a repository and a directory that is not a repository", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.admit(join(parent, "alpha", "src"))).toEqual({ ok: false, reason: expect.stringContaining("is not the top level of a git repository") });
    expect(await admission.admit(join(parent, "plain"))).toEqual({ ok: false, reason: expect.stringContaining("is not the top level of a git repository") });
  });

  it("refuses an excluded repository", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).admit(join(parent, "archive", "old"));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("is excluded by routing.repoExclude") });
  });

  it("refuses a junction that leads outside the parent", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).admit(join(parent, "link"));
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(`leads outside ${parent} through a link`) });
  });

  it("admits a linked worktree outside the parents only through a known repository", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const login = join(outside, "alpha-login");
    expect(await admission.admit(login)).toEqual({ ok: false, reason: expect.stringContaining("is not below routing.repoParents") });
    const known = await admission.admit(login, [join(parent, "alpha")]);
    expect(known).toMatchObject({ ok: true, location: { repository: join(parent, "alpha"), name: "alpha", worktree: login, branch: "feat/login", head: mainSha } });
  });

  it("finds repo= 1 and 2 levels below a parent", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.resolve({ repo: "solo" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "solo"), name: "solo" } });
    expect(await admission.resolve({ repo: "beta" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "org", "beta"), name: "beta" } });
  });

  it("refuses a name shared by two repositories, naming both", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "dup" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `repo=dup matches 2 repositories: ${join(parent, "dup")} and ${join(parent, "org", "dup")}: no work root. Name one with root="<path>".`,
    });
  });

  it("refuses repo= without branch= when the repository has several worktrees", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "alpha" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `repo=alpha has 2 worktrees: ${join(parent, "alpha")} → main; ${join(outside, "alpha-login")} → feat/login: no work root. Add branch=<name>, or name one with root="<path>".`,
    });
  });

  it("picks the worktree on branch= for repo=, and the session repository's for branch= alone", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const login = join(outside, "alpha-login");
    expect(await admission.resolve({ repo: "alpha", branch: "feat/login" }, session())).toMatchObject({ ok: true, location: { worktree: login, branch: "feat/login", name: "alpha" } });
    expect(await admission.resolve({ repo: "alpha", branch: "main" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "alpha"), branch: "main" } });
    expect(await admission.resolve({ branch: "feat/login" }, session())).toMatchObject({ ok: true, location: { worktree: login, branch: "feat/login" } });
    expect(await admission.resolve({ repo: "alpha", branch: "nope" }, session())).toEqual({ ok: false, reason: expect.stringContaining("no worktree of alpha is on nope") });
  });

  it("refuses root= with a branch= it is not on, naming the worktree that is", async () => {
    const root = join(parent, "alpha");
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ root, branch: "feat/login" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `root=${root} declares branch=feat/login, but that worktree is on main (HEAD ${mainSha.slice(0, 7)}): no work root. The worktree on feat/login is ${join(outside, "alpha-login")} — use repo=alpha branch=feat/login.`,
    });
  });

  it("refuses root= with a repo= it does not belong to, and admits an agreeing root + repo + branch", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.resolve({ root: join(parent, "solo"), repo: "alpha" }, session())).toEqual({ ok: false, reason: expect.stringContaining("belongs to repo=solo") });
    const login = join(outside, "alpha-login");
    expect(await admission.resolve({ root: login, repo: "alpha", branch: "feat/login" }, { sessionRepository: join(parent, "solo") })).toMatchObject({ ok: true, location: { worktree: login } });
  });

  it.runIf(isWin)("matches case-insensitively on win32", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).admit(join(parent.toUpperCase(), "ALPHA"));
    expect(result).toMatchObject({ ok: true, location: { worktree: join(parent, "alpha"), name: "alpha" } });
  });
});
