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
import { gitWorktreeList, resolveRoleWorkRoot } from "../../src/routing/wire/dispatch";

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
    commonDir: (cwd) => { calls.push(`commonDir ${cwd}`); return base.commonDir(cwd); },
    gitEntry: (dir) => { calls.push(`gitEntry ${dir}`); return base.gitEntry(dir); },
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
    isDirectory: boom("isDirectory"), readdir: boom("readdir"), commonDir: boom("commonDir"), gitEntry: boom("gitEntry"), platform, now: () => 0,
  };
}

/** A fake win32 world (runs on every host): D:\Git\App is a repository with one worktree on main. */
function fakeWin(clock: { t: number }): AdmissionDeps {
  return {
    listWorktrees: async () => `worktree D:/Git/App\nHEAD ${SHA}\nbranch refs/heads/main\n\n`,
    showToplevel: async () => "D:/Git/App",
    commonDir: async () => "D:/Git/App/.git",
    gitEntry: () => true,
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

  it("QA-R1 F7: repo= skips dot-dirs, node_modules and excluded dirs, runs no git without a .git entry, and caps the notes", async () => {
    const children = ["node_modules", ".cache", "skipped", ...Array.from({ length: 12 }, (_, i) => `o${String(i + 1)}`)];
    const { deps, calls } = recording({
      ...fakeWin({ t: 0 }),
      showToplevel: async () => undefined,
      gitEntry: (dir) => !/\\o12\\x$/i.test(dir),
      readdir: (path) => (/^d:\\git$/i.test(path) ? children : []),
    });
    const admission = createAdmission({ parents: ["D:\\git"], depth: 2, exclude: ["D:\\git\\skipped"] }, deps);
    const result = await admission.resolve({ repo: "x" }, { sessionRepository: "D:\\git\\app" });
    const reason = result.ok ? "" : result.reason;
    expect(result.ok).toBe(false);
    expect(calls.filter((call) => /node_modules|\\\.cache|\\skipped/i.test(call))).toEqual([]);
    expect(calls).toContain("showToplevel D:\\git\\o11\\x");
    expect(calls).not.toContain("showToplevel D:\\git\\o12\\x");
    // 13 refusals (D:\git\x and o1..o12): 10 quoted, then a count
    expect(reason.match(/is not the top level of a git repository/g)?.length).toBe(10);
    expect(reason).toContain("and 3 more");

    const wide = recording({
      ...fakeWin({ t: 0 }),
      gitEntry: () => false,
      readdir: (path) => (/^d:\\git$/i.test(path) ? Array.from({ length: 3000 }, (_, i) => `d${String(i)}`) : []),
    });
    const capped = await createAdmission({ parents: ["D:\\git"], depth: 2, exclude: [] }, wide.deps).resolve({ repo: "x" }, { sessionRepository: "D:\\git\\app" });
    expect(capped.ok ? "" : capped.reason).toContain("stopped after 2000 directories");
    expect(new Set(wide.calls.filter((call) => call.startsWith("isDirectory "))).size).toBe(2000);
    expect(wide.calls.filter((call) => call.startsWith("showToplevel "))).toEqual([]);
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

describe("Q10 (real git): repo= also matches the directory name of a linked worktree", { timeout: 60_000 }, () => {
  let base = "";
  let parent = "";
  let outside = "";
  const env: NodeJS.ProcessEnv = {};

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const repo = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  };

  const config = () => ({ parents: [parent], depth: 2, exclude: [] as string[] });
  const session = () => ({ sessionRepository: join(parent, "lib-main") });

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-admission-q10-")));
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    writeFileSync(join(base, "gitconfig"), "");
    env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
    parent = join(base, "parent");
    outside = join(base, "outside");
    // lib-main: worktrees lib-wt (below the parent, branch wt-branch) and lib-other (outside, branch feat/other).
    repo(join(parent, "lib-main"));
    git(join(parent, "lib-main"), "worktree", "add", "-q", "-b", "wt-branch", join(parent, "lib-wt"));
    git(join(parent, "lib-main"), "worktree", "add", "-q", "-b", "feat/other", join(outside, "lib-other"));
    // A repository named shared, and a worktree directory shared of another repository.
    repo(join(parent, "shared"));
    repo(join(parent, "other"));
    git(join(parent, "other"), "worktree", "add", "-q", "-b", "b-shared", join(parent, "org", "shared"));
    // Two worktree directories named twin, of different repositories.
    repo(join(parent, "a1"));
    git(join(parent, "a1"), "worktree", "add", "-q", "-b", "a-twin", join(parent, "twin"));
    repo(join(parent, "b1"));
    git(join(parent, "b1"), "worktree", "add", "-q", "-b", "b-twin", join(parent, "org", "twin"));
    // A worktree directory c-wt of repository c1 (a unique name).
    repo(join(parent, "c1"));
    git(join(parent, "c1"), "worktree", "add", "-q", "-b", "c-branch", join(parent, "c-wt"));
    // Two detached worktree directories named dtwin, of different repositories.
    repo(join(parent, "dt1"));
    git(join(parent, "dt1"), "worktree", "add", "-q", "--detach", join(parent, "dtwin"));
    repo(join(parent, "dt2"));
    git(join(parent, "dt2"), "worktree", "add", "-q", "--detach", join(parent, "org", "dtwin"));
  }, 120_000);

  afterAll(() => {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  it("admits root= + repo= when repo= is the directory name of that very worktree (or its repository name)", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const wt = join(parent, "lib-wt");
    expect(await admission.resolve({ root: wt, repo: "lib-wt" }, session())).toMatchObject({ ok: true, location: { name: "lib-main", worktree: wt, branch: "wt-branch" } });
    expect(await admission.resolve({ root: wt, repo: "lib-wt", branch: "wt-branch" }, session())).toMatchObject({ ok: true, location: { worktree: wt } });
    expect(await admission.resolve({ root: wt, repo: "lib-main" }, session())).toMatchObject({ ok: true, location: { worktree: wt } });
  });

  it("refuses root= + repo= naming the directory of another worktree, with a hint that never suggests the refused name", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const wt = join(parent, "lib-wt");
    const cwt = join(parent, "c-wt");
    const result = await admission.resolve({ root: wt, repo: "c-wt" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `root=${wt} declares repo=c-wt, but that worktree belongs to repo=lib-main (${join(parent, "lib-main")}): no work root. repo=c-wt is the work root ${cwt} (repository c1) — use root=${cwt}, or repo=lib-main for this worktree.`,
    });
    // An ambiguous directory name (two repositories have a worktree twin) falls back to the repository name of the root.
    expect(await admission.resolve({ root: wt, repo: "twin" }, session())).toEqual({
      ok: false,
      reason: `root=${wt} declares repo=twin, but that worktree belongs to repo=lib-main (${join(parent, "lib-main")}): no work root. Use repo=lib-main, or name a worktree of twin with root="<path>".`,
    });
    // The main checkout of the same repository is not the worktree lib-wt either.
    const main = await admission.resolve({ root: join(parent, "lib-main"), repo: "lib-wt" }, session());
    expect(main.ok).toBe(false);
    const reason = main.ok ? "" : main.reason;
    expect(reason).toContain("belongs to repo=lib-main");
    expect(reason).toContain("repo=lib-main for this worktree");
    expect(reason).not.toContain("use repo=lib-wt");
  });

  it("renders a detached worktree in an ambiguity list as detached at <sha7>", async () => {
    const sha = (dir: string): string => git(dir, "rev-parse", "HEAD").slice(0, 7);
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "dtwin" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `repo=dtwin matches 2 work roots: ${join(parent, "dtwin")} (repository dt1, detached at ${sha(join(parent, "dt1"))}) and ${join(parent, "org", "dtwin")} (repository dt2, detached at ${sha(join(parent, "dt2"))}): no work root. Name one with root="<path>".`,
    });
    expect(result.ok ? "" : result.reason).not.toContain("branch detached");
  });

  it("binds the linked worktree whose directory is named X", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "lib-wt" }, session());
    expect(result).toMatchObject({ ok: true, location: { repository: join(parent, "lib-main"), name: "lib-main", worktree: join(parent, "lib-wt"), branch: "wt-branch" } });
  });

  it("binds the same worktree for the directory name + the branch of that worktree", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "lib-wt", branch: "wt-branch" }, session());
    expect(result).toMatchObject({ ok: true, location: { repository: join(parent, "lib-main"), worktree: join(parent, "lib-wt"), branch: "wt-branch" } });
  });

  it("binds the worktree of the repository on another branch (pick), whatever its directory is called", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.resolve({ repo: "lib-wt", branch: "feat/other" }, session())).toMatchObject({
      ok: true,
      location: { repository: join(parent, "lib-main"), worktree: join(outside, "lib-other"), branch: "feat/other" },
    });
    expect(await admission.resolve({ repo: "lib-wt", branch: "main" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "lib-main"), branch: "main" } });
    expect(await admission.resolve({ repo: "lib-wt", branch: "nope" }, session())).toEqual({ ok: false, reason: expect.stringContaining("no worktree of lib-main is on nope") });
  });

  it("refuses a repository named X and a worktree directory X of another repository as ambiguous, listing both", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const reason = `repo=shared matches 2 work roots: ${join(parent, "shared")} (repository shared, branch main) and ${join(parent, "org", "shared")} (repository other, branch b-shared): no work root. Name one with root="<path>".`;
    expect(await admission.resolve({ repo: "shared" }, session())).toEqual({ ok: false, reason });
    expect(await admission.resolve({ repo: "shared", branch: "main" }, session())).toEqual({ ok: false, reason });
  });

  it("refuses two worktree directories named X of different repositories as ambiguous, listing both", async () => {
    const result = await createAdmission(config(), defaultAdmissionDeps()).resolve({ repo: "twin" }, session());
    expect(result).toEqual({
      ok: false,
      reason: `repo=twin matches 2 work roots: ${join(parent, "twin")} (repository a1, branch a-twin) and ${join(parent, "org", "twin")} (repository b1, branch b-twin): no work root. Name one with root="<path>".`,
    });
  });

  it("leaves repository-name lookups unchanged", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.resolve({ repo: "a1" }, session())).toEqual({
      ok: false,
      reason: `repo=a1 has 2 worktrees: ${join(parent, "a1")} → main; ${join(parent, "twin")} → a-twin: no work root. Add branch=<name>, or name one with root="<path>".`,
    });
    expect(await admission.resolve({ repo: "a1", branch: "a-twin" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "twin"), name: "a1" } });
    expect(await admission.resolve({ repo: "lib-main", branch: "wt-branch" }, session())).toMatchObject({ ok: true, location: { worktree: join(parent, "lib-wt") } });
    expect(await admission.resolve({ repo: "nowhere" }, session())).toEqual({ ok: false, reason: expect.stringContaining("repo=nowhere matches no repository below routing.repoParents") });
  });
});

describe("QA round 1 (real git): every admission passes the final gates", { timeout: 60_000 }, () => {
  let base = "";
  let parent = "";
  let outside = "";
  const env: NodeJS.ProcessEnv = {};

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init");
  };
  const app = (): string => join(parent, "app");
  const config = () => ({ parents: [parent], depth: 2, exclude: [join(parent, "secret*")] });

  beforeAll(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-admission-qa-")));
    for (const [key, value] of Object.entries(process.env)) if (!key.toUpperCase().startsWith("GIT_")) env[key] = value;
    writeFileSync(join(base, "gitconfig"), "");
    env.GIT_CONFIG_GLOBAL = join(base, "gitconfig");
    env.GIT_CONFIG_NOSYSTEM = "1";
    parent = join(base, "parent");
    outside = join(base, "outside");
    repo(app());
    git(app(), "worktree", "add", "-q", "-b", "secret", join(parent, "secret-wt"));
    git(app(), "worktree", "add", "-q", "-b", "wt-in", join(parent, "wt-in"));
    git(app(), "worktree", "add", "-q", "-b", "wt-out", join(outside, "wt-out"));
    repo(join(outside, "victim"));
    // Two listed worktrees of app are swapped for links to a separate repository.
    for (const listed of [join(parent, "wt-in"), join(outside, "wt-out")]) {
      rmSync(listed, { recursive: true, force: true });
      symlinkSync(join(outside, "victim"), listed, isWin ? "junction" : "dir");
    }
    repo(join(parent, "org"));
  }, 120_000);

  afterAll(() => {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  });

  it("F1: an excluded linked worktree of an admitted repository is refused by admit, by repo= + branch= and by the text match", async () => {
    const secret = join(parent, "secret-wt");
    const admission = createAdmission(config(), defaultAdmissionDeps());
    expect(await admission.admit(secret, [app()])).toEqual({ ok: false, reason: expect.stringContaining("is excluded by routing.repoExclude") });
    expect(await admission.resolve({ repo: "app", branch: "secret" }, { sessionRepository: app() }))
      .toEqual({ ok: false, reason: expect.stringContaining("is excluded by routing.repoExclude") });
    const viaText = await resolveRoleWorkRoot(
      { root: secret, sessionDirectory: app() },
      { listWorktrees: gitWorktreeList, realpath: (path) => realpathSync.native(path), platform: process.platform },
      { admission },
    );
    expect(viaText).toMatchObject({ workRoot: null, note: expect.stringContaining("is excluded by routing.repoExclude") });
    // the repository itself is still admitted
    expect(await admission.resolve({ repo: "app", branch: "main" }, { sessionRepository: app() })).toMatchObject({ ok: true, location: { worktree: app() } });
  });

  it("F2: a listed worktree that leads out through a link is refused, naming the link; rule 2 never overturns rule 1", async () => {
    const admission = createAdmission(config(), defaultAdmissionDeps());
    const victim = join(outside, "victim");
    const inside = join(parent, "wt-in");
    const below = await admission.admit(inside, [app()]);
    expect(below).toEqual({ ok: false, reason: expect.stringContaining(`root=${inside} leads outside ${parent} through a link`) });
    expect(below.ok ? "" : below.reason).toContain(victim);
    const out = join(outside, "wt-out");
    const listed = await admission.admit(out, [app()]);
    expect(listed).toEqual({ ok: false, reason: expect.stringContaining(`root=${out}`) });
    expect(listed.ok ? "" : listed.reason).toContain("through a link");
    expect(listed.ok ? "" : listed.reason).toContain(victim);
  });

  it("F4: a repository that is itself a configured parent is refused, whichever parent would admit it", async () => {
    const org = join(parent, "org");
    const admission = createAdmission({ parents: [parent, org], depth: 2, exclude: [] }, defaultAdmissionDeps());
    expect(await admission.admit(org)).toEqual({ ok: false, reason: expect.stringContaining("routing.repoParents entry") });
    expect(await admission.admit(app())).toMatchObject({ ok: true, location: { worktree: app() } });
  });
});
