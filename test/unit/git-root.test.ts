/**
 * Phase 3b.2 (docs/design/cross-repo-phase3-plan.md, "Contract: resolution order and texts"): `resolveGitRoot` resolves a
 * `router_git_*` `root` against the read set and admission. Every dependency is a fake: no git, no real filesystem.
 */
import { describe, expect, it, vi } from "vitest";
import type { Admission, AdmissionLookup, RepoLocation, WorktreeEntry } from "../../src/routing/roles/admission";
import {
  GIT_ROOT_TEXT_HINT,
  resolveGitRoot,
  type GitRootContext,
  type GitRootDeps,
} from "../../src/routing/roles/git-root";
import { displaySafe } from "../../src/routing/roles/read-set";

const W = "D:\\git\\app";
const P = "D:\\repos";
const WS = "E:\\elsewhere\\lib-wt";
const CTX: GitRootContext = { workRoot: W, parents: [P], workingSet: [WS] };
const KNOWN = [W, "D:\\repos\\session"];

function wt(path: string, branch: string | null, extra: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return { path, head: "0123456789abcdef", branch, detached: branch === null, bare: false, prunable: false, ...extra };
}

function loc(worktree: string, extra: Partial<RepoLocation> = {}): RepoLocation {
  const repository = extra.repository ?? worktree;
  const name = extra.name ?? (repository.split("\\").pop() ?? repository);
  return { repository, name, worktree, branch: "main", head: "0123456789abcdef", worktrees: [wt(worktree, "main")], ...extra };
}

interface Fake {
  /** Directories that exist, canonical (every link target is one too). */
  dirs?: string[];
  /** Files that exist, canonical. */
  files?: string[];
  /** Link (junction) text → canonical target. */
  links?: Record<string, string>;
  /** nearestCheckout answers per canonical path (default: the path itself). */
  tops?: Record<string, string | undefined>;
  readSet?: (real: string) => boolean;
  admit?: (root: string, known?: readonly string[]) => Promise<Admission>;
  find?: (name: string) => Promise<AdmissionLookup>;
  signal?: AbortSignal;
  deadlineAt?: number;
}

function harness(fake: Fake = {}) {
  const links = fake.links ?? {};
  const dirs = new Set([...(fake.dirs ?? [W, "D:\\repos\\lib", "D:\\repos\\lib\\src", "D:\\repos\\lib-feat", "D:\\repos\\team\\lib", WS]), ...Object.values(links)]);
  const files = new Set(fake.files ?? []);
  for (const file of files) dirs.delete(file);
  const realpath = vi.fn((path: string): string => {
    const target = links[path];
    if (target !== undefined) return target;
    if (dirs.has(path) || files.has(path)) return path;
    throw new Error(`ENOENT: ${path}`);
  });
  const isDirectory = vi.fn((path: string): boolean => dirs.has(path));
  const nearestCheckout = vi.fn((path: string): string | undefined => (fake.tops !== undefined && path in fake.tops ? fake.tops[path] : path));
  const inReadSet = vi.fn(
    fake.readSet ?? ((real: string): boolean => real.toLowerCase().startsWith(`${P.toLowerCase()}\\`) || real === WS || real === W),
  );
  const admit = vi.fn<(root: string, known?: readonly string[]) => Promise<Admission>>(
    fake.admit ?? (async (root: string): Promise<Admission> => ({ ok: true, location: loc(links[root] ?? root) })),
  );
  const find = vi.fn<(name: string) => Promise<AdmissionLookup>>(
    fake.find ?? (async (): Promise<AdmissionLookup> => ({ found: [], refused: [], searched: [], capped: false })),
  );
  const deps: GitRootDeps = {
    realpath,
    isDirectory,
    nearestCheckout,
    inReadSet,
    admission: { admit, find },
    known: KNOWN,
    platform: "win32",
    ...(fake.signal === undefined ? {} : { signal: fake.signal }),
    ...(fake.deadlineAt === undefined ? {} : { deadlineAt: fake.deadlineAt }),
  };
  const calls = (): number =>
    realpath.mock.calls.length + isDirectory.mock.calls.length + nearestCheckout.mock.calls.length + inReadSet.mock.calls.length + admit.mock.calls.length + find.mock.calls.length;
  return { deps, realpath, isDirectory, nearestCheckout, inReadSet, admit, find, calls };
}

describe("resolveGitRoot — text checks (step 2), no dependency call", () => {
  const cases: Array<[string, string, string]> = [
    ["leading whitespace", " D:\\repos\\lib", "has leading or trailing whitespace"],
    ["trailing whitespace", "lib ", "has leading or trailing whitespace"],
    ["longer than 4096 characters", `D:\\repos\\${"a".repeat(4100)}`, "is longer than 4096 characters"],
    ["a network path", "\\\\host\\share\\lib", "is a network or device path"],
    ["a device path", "\\\\?\\D:\\repos\\lib", "is a network or device path"],
    ["a relative path", "..\\mcp-reader", "is not an absolute path with a drive letter"],
    ["a colon after the drive", "D:\\repos\\lib:stream", "contains a colon after the drive letter"],
    ["a .. segment", "D:\\repos\\..\\lib", "contains a .. segment"],
    ["an 8.3 short name", "D:\\repos\\LIBRAR~1", "contains an 8.3 short-name component"],
    ["a .git segment", "D:\\repos\\lib\\.git", "names a .git directory"],
    ["a .git segment below", "D:\\repos\\lib\\.git\\hooks", "names a .git directory"],
    ["an empty name", "", "is empty"],
    ["a dot name", ".", "is not a bare repository name"],
    ["a dot-dot name", "..", "is not a bare repository name"],
    ["a wildcard name", "lib*", "contains a wildcard"],
    ["an 8.3 name", "LIBRAR~1", "contains an 8.3 short-name component"],
    ["the name .git", ".git", "names a .git directory"],
  ];
  for (const [label, value, problem] of cases) {
    it(`refuses ${label}`, async () => {
      const h = harness();
      const result = await resolveGitRoot(value, CTX, h.deps);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason.startsWith("root=")).toBe(true);
      expect(result.reason).toContain(problem);
      expect(result.reason.endsWith(GIT_ROOT_TEXT_HINT)).toBe(true);
      expect(h.calls()).toBe(0);
    });
  }

  it("uses the exact contract text", async () => {
    const h = harness();
    expect(await resolveGitRoot("..\\mcp-reader", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=..\\mcp-reader is not an absolute path with a drive letter; pass the absolute top level of a repository or its name",
    });
    expect(h.calls()).toBe(0);
  });
});

describe("resolveGitRoot — text gate (step 3)", () => {
  it("refuses a path outside the work root, the parents and the working set before any call", async () => {
    const h = harness();
    expect(await resolveGitRoot("C:\\Windows", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=C:\\Windows is outside this dispatch's read set (the work root, the session's repositories and the repositories below D:\\repos); nothing ran",
    });
    expect(h.calls()).toBe(0);
  });

  it("refuses a parent itself as outside the read set", async () => {
    const h = harness();
    const result = await resolveGitRoot("D:\\repos", CTX, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("is outside this dispatch's read set");
    expect(h.calls()).toBe(0);
  });

  it("refuses a junction from outside the parents into R without resolving it", async () => {
    const h = harness({ links: { "C:\\junction-into-repos": "D:\\repos\\lib" } });
    const result = await resolveGitRoot("C:\\junction-into-repos", CTX, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("is outside this dispatch's read set");
    expect(h.calls()).toBe(0);
  });

  it("answers the work root itself (any spelling) as inWorkRoot, with no call", async () => {
    for (const value of [W, "d:\\git\\APP", "D:/git/app", "D:\\git\\app\\"]) {
      const h = harness();
      expect(await resolveGitRoot(value, CTX, h.deps)).toEqual({ ok: true, inWorkRoot: true });
      expect(h.calls()).toBe(0);
    }
  });

  it("refuses a path inside the work root with a path= hint", async () => {
    const h = harness();
    expect(await resolveGitRoot("D:\\git\\app\\src\\lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\git\\app\\src\\lib is inside your work root D:\\git\\app; omit root and pass path=src\\lib",
    });
    expect(h.calls()).toBe(0);
  });

  it("continues for a path below a parent", async () => {
    const h = harness();
    const result = await resolveGitRoot("D:\\repos\\lib", CTX, h.deps);
    expect(result.ok).toBe(true);
    expect(h.realpath).toHaveBeenCalledWith("D:\\repos\\lib");
    expect(h.admit).toHaveBeenCalledTimes(1);
  });

  it("continues for a working-set worktree outside the parents (F6: the git cwd is admission's worktree)", async () => {
    const h = harness({
      admit: async () => ({ ok: true, location: loc(WS, { repository: "D:\\repos\\lib", name: "lib", branch: "feature" }) }),
    });
    expect(await resolveGitRoot(WS, CTX, h.deps)).toEqual({
      ok: true,
      inWorkRoot: false,
      root: WS,
      repository: "D:\\repos\\lib",
      name: "lib",
      branch: "feature",
      workRoot: W,
      provenance: "[router: read from lib (feature) at E:\\elsewhere\\lib-wt — read-only in this dispatch]",
    });
    expect(h.admit).toHaveBeenCalledWith(WS, KNOWN);
  });
});

describe("resolveGitRoot — filesystem steps (4–6)", () => {
  it("refuses a missing directory (step 4) before R and admission", async () => {
    const h = harness();
    expect(await resolveGitRoot("D:\\repos\\missing", CTX, h.deps)).toEqual({ ok: false, reason: "root=D:\\repos\\missing is not a directory; nothing ran" });
    expect(h.inReadSet).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("refuses a file (step 4)", async () => {
    const h = harness({ files: ["D:\\repos\\file.txt"] });
    expect(await resolveGitRoot("D:\\repos\\file.txt", CTX, h.deps)).toEqual({ ok: false, reason: "root=D:\\repos\\file.txt is not a directory; nothing ran" });
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("re-checks the canonical path against the work root (step 4)", async () => {
    const same = harness({ links: { "D:\\repos\\app-link": W } });
    expect(await resolveGitRoot("D:\\repos\\app-link", CTX, same.deps)).toEqual({ ok: true, inWorkRoot: true });
    expect(same.admit).not.toHaveBeenCalled();
    const inside = harness({ dirs: [W, "D:\\git\\app\\pkg"], links: { "D:\\repos\\pkg-link": "D:\\git\\app\\pkg" } });
    expect(await resolveGitRoot("D:\\repos\\pkg-link", CTX, inside.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\pkg-link is inside your work root D:\\git\\app; omit root and pass path=pkg",
    });
    expect(inside.admit).not.toHaveBeenCalled();
  });

  it("refuses a junction below a parent that leads outside R (step 5)", async () => {
    const h = harness({ links: { "D:\\repos\\junction-out": "C:\\outside\\repo" } });
    expect(await resolveGitRoot("D:\\repos\\junction-out", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\junction-out resolves to C:\\outside\\repo, outside this dispatch's read set; nothing ran",
    });
    expect(h.inReadSet).toHaveBeenCalledWith("C:\\outside\\repo");
    expect(h.nearestCheckout).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("refuses a directory inside a repository with a top-level hint (step 6)", async () => {
    const h = harness({ tops: { "D:\\repos\\lib\\src": "D:\\repos\\lib" } });
    expect(await resolveGitRoot("D:\\repos\\lib\\src", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\lib\\src is inside the repository at D:\\repos\\lib; pass root=D:\\repos\\lib and path=src",
    });
    expect(h.admit).not.toHaveBeenCalled();
  });
});

describe("resolveGitRoot — admission (step 7)", () => {
  it("maps ': no work root.' to '; nothing ran.'", async () => {
    const h = harness({
      admit: async () => ({ ok: false, reason: "root=D:\\repos\\lib is excluded by routing.repoExclude (D:\\repos\\lib): no work root." }),
    });
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\lib is excluded by routing.repoExclude (D:\\repos\\lib); nothing ran.",
    });
    expect(h.admit).toHaveBeenCalledWith("D:\\repos\\lib", KNOWN);
  });

  it("keeps a hint after the mapped phrase", async () => {
    const h = harness({
      admit: async () => ({ ok: false, reason: "root=D:\\repos\\lib is not below routing.repoParents (D:\\repos) and is not a worktree of a repository in this session: no work root. Clone it or add a worktree below D:\\repos." }),
    });
    const result = await resolveGitRoot("D:\\repos\\lib", CTX, h.deps);
    expect(result).toEqual({
      ok: false,
      reason: "root=D:\\repos\\lib is not below routing.repoParents (D:\\repos) and is not a worktree of a repository in this session; nothing ran. Clone it or add a worktree below D:\\repos.",
    });
  });

  it("appends '; nothing ran.' to a reason without ': no work root.' (repoDepth)", async () => {
    const h = harness({
      admit: async () => ({ ok: false, reason: "root=D:\\repos\\lib is 2 levels below D:\\repos; repositories are admitted 1 level below a parent (routing.repoDepth)." }),
    });
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\lib is 2 levels below D:\\repos; repositories are admitted 1 level below a parent (routing.repoDepth); nothing ran.",
    });
  });

  it("refuses when the admitted worktree is not the canonical path (drift)", async () => {
    const h = harness({ admit: async () => ({ ok: true, location: loc("D:\\repos\\other") }) });
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=D:\\repos\\lib: the admitted worktree D:\\repos\\other resolves to D:\\repos\\lib; nothing ran",
    });
  });

  it("succeeds with the read-provenance line", async () => {
    const h = harness();
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({
      ok: true,
      inWorkRoot: false,
      root: "D:\\repos\\lib",
      repository: "D:\\repos\\lib",
      name: "lib",
      branch: "main",
      workRoot: W,
      provenance: "[router: read from lib (main) at D:\\repos\\lib — read-only in this dispatch]",
    });
    expect(h.find).not.toHaveBeenCalled();
  });

  it("names a detached worktree as detached", async () => {
    const h = harness({ admit: async () => ({ ok: true, location: loc("D:\\repos\\lib", { branch: null }) }) });
    const result = await resolveGitRoot("D:\\repos\\lib", CTX, h.deps);
    expect(result.ok && !result.inWorkRoot ? result.provenance : "").toBe("[router: read from lib (detached) at D:\\repos\\lib — read-only in this dispatch]");
  });

  it("passes unsafe names and branches through displaySafe", async () => {
    const name = "lib\u001b[31mred\u202e";
    const branch = "feat\u0007\u2028x";
    const h = harness({ admit: async () => ({ ok: true, location: loc("D:\\repos\\lib", { name, branch }) }) });
    const result = await resolveGitRoot("D:\\repos\\lib", CTX, h.deps);
    expect(result.ok && !result.inWorkRoot).toBe(true);
    if (!result.ok || result.inWorkRoot) return;
    expect(result.provenance).toBe(`[router: read from ${displaySafe(name)} (${displaySafe(branch)}) at D:\\repos\\lib — read-only in this dispatch]`);
    expect(result.provenance).not.toMatch(/[\u0000-\u001f\u2028\u202e]/);
    expect(result.name).toBe(name);
    expect(result.branch).toBe(branch);
  });
});

describe("resolveGitRoot — names (step 8)", () => {
  const lookup = (found: RepoLocation[], searched: string[] = []): AdmissionLookup => ({ found, refused: [], searched, capped: false });

  it("refuses a name that matches nothing", async () => {
    const h = harness({ find: async () => lookup([], ["D:\\repos\\nope", "D:\\repos\\*\\nope"]) });
    expect(await resolveGitRoot("nope", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=nope matches no repository below routing.repoParents (searched D:\\repos\\nope, D:\\repos\\*\\nope); nothing ran",
    });
    expect(h.find).toHaveBeenCalledWith("nope");
    expect(h.realpath).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("refuses a name that matches several repositories", async () => {
    const h = harness({
      find: async () => lookup([loc("D:\\repos\\lib"), loc("D:\\repos\\team\\lib")]),
    });
    expect(await resolveGitRoot("lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=lib matches 2 repositories: D:\\repos\\lib, D:\\repos\\team\\lib; nothing ran. Pass root as one of these absolute paths",
    });
    expect(h.realpath).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("refuses a repository with several usable worktrees", async () => {
    const worktrees = [wt("D:/repos/lib", "main"), wt("D:/repos/lib-feat", "feat"), wt("D:/repos/lib-old", null)];
    const h = harness({ find: async () => lookup([loc("D:\\repos\\lib", { worktrees })]) });
    expect(await resolveGitRoot("lib", CTX, h.deps)).toEqual({
      ok: false,
      reason: "root=lib has 3 worktrees: D:\\repos\\lib → main; D:\\repos\\lib-feat → feat; D:\\repos\\lib-old → detached at 0123456; nothing ran. Pass root as one of these absolute paths",
    });
    expect(h.realpath).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("resolves a worktree-directory name through the path steps", async () => {
    const worktrees = [wt("D:/repos/lib", "main"), wt("D:/repos/lib-feat", "feat")];
    const h = harness({
      find: async () => lookup([loc("D:\\repos\\lib-feat", { repository: "D:\\repos\\lib", name: "lib", branch: "feat", worktrees })]),
      admit: async (root) => ({ ok: true, location: loc(root, { repository: "D:\\repos\\lib", name: "lib", branch: "feat", worktrees }) }),
    });
    const result = await resolveGitRoot("lib-feat", CTX, h.deps);
    expect(result).toEqual({
      ok: true,
      inWorkRoot: false,
      root: "D:\\repos\\lib-feat",
      repository: "D:\\repos\\lib",
      name: "lib",
      branch: "feat",
      workRoot: W,
      provenance: "[router: read from lib (feat) at D:\\repos\\lib-feat — read-only in this dispatch]",
    });
    expect(h.realpath).toHaveBeenCalledWith("D:\\repos\\lib-feat");
    expect(h.admit).toHaveBeenCalledWith("D:\\repos\\lib-feat", [...KNOWN, "D:\\repos\\lib"]);
  });

  it("resolves a repository with a single worktree through the path steps", async () => {
    const h = harness({ find: async () => lookup([loc("D:\\repos\\lib", { worktrees: [wt("D:/repos/lib", "main"), wt("D:/repos/lib-bare", null, { bare: true })] })]) });
    const result = await resolveGitRoot("LIB", CTX, h.deps);
    expect(result.ok && !result.inWorkRoot ? result.provenance : result).toBe("[router: read from lib (main) at D:\\repos\\lib — read-only in this dispatch]");
    expect(h.find).toHaveBeenCalledWith("LIB");
    expect(h.realpath).toHaveBeenCalledWith("D:\\repos\\lib");
    expect(h.inReadSet).toHaveBeenCalledWith("D:\\repos\\lib");
    expect(h.admit).toHaveBeenCalledWith("D:\\repos\\lib", [...KNOWN, "D:\\repos\\lib"]);
  });

  it("applies the path steps' refusals to the single worktree", async () => {
    const h = harness({
      links: { "D:\\repos\\lib": "C:\\outside\\lib" },
      find: async () => lookup([loc("D:\\repos\\lib")]),
    });
    const result = await resolveGitRoot("lib", CTX, h.deps);
    expect(result).toEqual({ ok: false, reason: "root=D:\\repos\\lib resolves to C:\\outside\\lib, outside this dispatch's read set; nothing ran" });
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("passes unsafe listed paths and branches through displaySafe", async () => {
    const odd = "feat\u202eevil";
    const worktrees = [wt("D:/repos/lib", "main"), wt("D:/repos/lib-odd", odd)];
    const h = harness({ find: async () => lookup([loc("D:\\repos\\lib", { worktrees })]) });
    const result = await resolveGitRoot("lib", CTX, h.deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(`D:\\repos\\lib-odd → ${displaySafe(odd)}`);
    expect(result.reason).not.toContain("\u202e");
  });
});

describe("resolveGitRoot — deadline and abort (step 9)", () => {
  it("refuses once the deadline has passed, before any filesystem or admission call", async () => {
    const h = harness({ deadlineAt: Date.now() - 1 });
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({ ok: false, reason: "root=D:\\repos\\lib: resolving the repository timed out; nothing ran" });
    expect(h.realpath).not.toHaveBeenCalled();
    expect(h.admit).not.toHaveBeenCalled();
  });

  it("refuses an aborted call, before find", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await resolveGitRoot("lib", CTX, h.deps)).toEqual({ ok: false, reason: "root=lib: resolving the repository was aborted; nothing ran" });
    expect(h.find).not.toHaveBeenCalled();
  });

  it("stops waiting for admission at the deadline", async () => {
    const h = harness({ deadlineAt: Date.now() + 30, admit: () => new Promise<Admission>(() => undefined) });
    expect(await resolveGitRoot("D:\\repos\\lib", CTX, h.deps)).toEqual({ ok: false, reason: "root=D:\\repos\\lib: resolving the repository timed out; nothing ran" });
    expect(h.admit).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for the name lookup on abort", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal, find: () => new Promise<AdmissionLookup>(() => undefined) });
    const pending = resolveGitRoot("lib", CTX, h.deps);
    setTimeout(() => controller.abort(), 5);
    expect(await pending).toEqual({ ok: false, reason: "root=lib: resolving the repository was aborted; nothing ran" });
    expect(h.find).toHaveBeenCalledTimes(1);
  });

  it("does not let a text refusal wait for the deadline", async () => {
    const h = harness({ deadlineAt: Date.now() - 1 });
    const result = await resolveGitRoot("C:\\Windows", CTX, h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("is outside this dispatch's read set");
    expect(h.calls()).toBe(0);
  });
});
