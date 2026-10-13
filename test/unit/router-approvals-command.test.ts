/**
 * Cross-repo P4.7: `/router approve <path>`, `/router repos`, `/router revoke <path>` (commands/approvals.ts), on temp git
 * repositories with an injected store directory and clock.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  APPROVALS_CHANGED,
  approvalReloadLine,
  approvalsChangedOf,
  isRouterApprovalSubcommand,
  markApprovalsChanged,
  parseApprovalPath,
  runRouterApprovals,
  type RouterApprovalsOptions,
} from "../../src/commands/approvals";
import { ROUTER_APPROVAL_HELP_LINES, buildRouterHelp } from "../../src/commands/output";
import type { RouterPluginInput } from "../../src/compat/child-session";
import ModelRouterPlugin from "../../src/index";
import { invalidateConfigCache, overridePath, resetRolesWarnings } from "../../src/router/config";
import type { RepoLocation } from "../../src/routing/roles/admission";
import { approvalsPath, readApprovals, resetApprovalsState } from "../../src/routing/roles/approvals";
import { addToWorkingSet, forgetWorkingSet, workingSetOf } from "../../src/routing/wire/working-set";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);

let base: string;
let storeDir: string;
let ext: string;
let parent: string;
let inner: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=omr", "-c", "user.email=omr@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir: string, origin?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  if (origin !== undefined) git(dir, "remote", "add", "origin", origin);
}

let now = T0;
const opts = (over: Partial<RouterApprovalsOptions> = {}): RouterApprovalsOptions => ({
  parents: [parent],
  exclude: [],
  days: 14,
  env: { dir: storeDir, now: () => now, warn: () => {} },
  ...over,
});

const storeBytes = (): string | undefined => {
  const file = approvalsPath({ dir: storeDir });
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
};

beforeAll(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-p47-")));
  storeDir = path.join(base, "store");
  ext = path.join(base, "ext");
  parent = path.join(base, "parent");
  inner = path.join(parent, "inner");
  worktree = path.join(base, "ext-feat");
  initRepo(ext, "https://u:tok@example.invalid/x.git");
  initRepo(inner);
  git(ext, "worktree", "add", "-q", "-b", "feat", worktree);
}, 60_000);

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  now = T0;
  resetApprovalsState();
  fs.rmSync(storeDir, { recursive: true, force: true });
  forgetWorkingSet("orch-p47");
});

describe("parseApprovalPath and the marker", () => {
  it("takes the rest of the arguments, one pair of quotes removed", () => {
    expect(parseApprovalPath("  D:\\x  ")).toBe("D:\\x");
    expect(parseApprovalPath("\"D:\\my repo\"")).toBe("D:\\my repo");
    expect(parseApprovalPath("'/srv/my repo'")).toBe("/srv/my repo");
    expect(parseApprovalPath("D:\\my repo")).toBe("D:\\my repo");
    expect(parseApprovalPath("   ")).toBeUndefined();
    expect(parseApprovalPath("\"\"")).toBeUndefined();
  });

  it("the reload line: usable now, or restart (constant off, or a failed reload)", () => {
    const approved = { kind: "approve", path: "/ext/app" } as const;
    expect(approvalReloadLine(approved, true)).toBe("Role agents reloaded; dispatch again with root=/ext/app.");
    expect(approvalReloadLine(approved, false)).toBe("Restart OpenCode to use it.");
    expect(approvalReloadLine(approved, true, "boom")).toBe("The role agents could not be reloaded (boom). Restart OpenCode to use it.");
    const revoked = { kind: "revoke", path: "/ext/app" } as const;
    expect(approvalReloadLine(revoked, true)).toBe("Role agents reloaded; root=/ext/app is no longer allowed.");
    expect(approvalReloadLine(revoked, false)).toContain("restart OpenCode");
  });

  it("knows its subcommands", () => {
    expect(["approve", "repos", "revoke"].every(isRouterApprovalSubcommand)).toBe(true);
    expect(isRouterApprovalSubcommand("stats")).toBe(false);
  });

  it("marks an output non-enumerably: copies and JSON never carry it", () => {
    const parts: { type: string; text: string }[] = [{ type: "text", text: "x" }];
    markApprovalsChanged(parts, { kind: "approve", path: "/ext/app" });
    expect(approvalsChangedOf(parts)).toEqual({ kind: "approve", path: "/ext/app" });
    expect(Object.keys(parts)).toEqual(["0"]);
    expect(Object.getOwnPropertyDescriptor(parts, APPROVALS_CHANGED)?.enumerable).toBe(false);
    expect(JSON.stringify(parts)).toBe("[{\"type\":\"text\",\"text\":\"x\"}]");
    expect(approvalsChangedOf([...parts])).toBeUndefined();
    expect(approvalsChangedOf([{ type: "text", text: "x" }])).toBeUndefined();
  });
});

describe("/router approve", () => {
  it("approves a main worktree outside the parents: stores it and prints the identity from git", async () => {
    const result = await runRouterApprovals("approve", ` "${ext}" `, opts());
    expect(result.change).toEqual({ kind: "approve", path: ext });
    expect(result.text).toContain(`Approved repository ${ext}`);
    expect(result.text).toContain("origin:  https://example.invalid/x.git");
    expect(result.text).not.toContain("tok");
    const head = git(ext, "rev-parse", "HEAD");
    expect(result.text).toContain(`branch:  main @ ${head.slice(0, 12)}`);
    expect(result.text).toContain("roots:   1 root commit");
    expect(result.text).toContain("expires: 2026-10-26");
    const read = readApprovals({ dir: storeDir, now: () => now });
    expect(read.approvals).toHaveLength(1);
    expect(read.approvals[0]).toMatchObject({ path: ext, origin: "https://example.invalid/x.git", approvedAt: T0, lastUsedAt: T0 });
    expect(read.approvals[0]?.roots).toEqual([head]);
  }, 30_000);

  it("says no approval is needed below a configured parent, and stores nothing", async () => {
    const result = await runRouterApprovals("approve", inner, opts());
    expect(result.change).toBeUndefined();
    expect(result.text).toContain(`No approval needed: ${inner} is inside routing.repoParents`);
    expect(storeBytes()).toBeUndefined();
  }, 30_000);

  it("refuses a protected location, an excluded path and a linked worktree; the store is unchanged", async () => {
    const first = await runRouterApprovals("approve", ext, opts());
    expect(first.change).toBeDefined();
    const before = storeBytes();
    expect(before).toBeDefined();

    const home = await runRouterApprovals("approve", os.homedir(), opts());
    expect(home.change).toBeUndefined();
    expect(home.text).toMatch(/^Not approved: /);
    expect(home.text).toContain("Nothing was stored.");

    const root = await runRouterApprovals("approve", path.parse(base).root, opts());
    expect(root.change).toBeUndefined();
    expect(root.text).toMatch(/^Not approved: /);

    const excluded = await runRouterApprovals("approve", worktree, opts({ exclude: [path.join(base, "ext-*")] }));
    expect(excluded.change).toBeUndefined();
    expect(excluded.text).toContain("routing.repoExclude");

    const linked = await runRouterApprovals("approve", worktree, opts());
    expect(linked.change).toBeUndefined();
    expect(linked.text).toContain("approve the main worktree");

    const missing = await runRouterApprovals("approve", path.join(base, "nope"), opts());
    expect(missing.change).toBeUndefined();
    expect(missing.text).toContain("does not resolve");

    expect(storeBytes()).toBe(before);
  }, 30_000);

  it("prints the usage without a path", async () => {
    const result = await runRouterApprovals("approve", "  ", opts());
    expect(result.change).toBeUndefined();
    expect(result.text).toMatch(/^Usage: \/router approve <path>/);
    expect(storeBytes()).toBeUndefined();
  });
});

describe("/router repos", () => {
  it("lists the approvals from the store only, marked expired or excluded", async () => {
    expect((await runRouterApprovals("repos", "", opts())).text).toMatch(/^No approved repositories/);
    await runRouterApprovals("approve", ext, opts());
    const listed = await runRouterApprovals("repos", "", opts());
    expect(listed.change).toBeUndefined();
    expect(listed.text).toContain(`- ${ext}\n`);
    expect(listed.text).toContain("origin: https://example.invalid/x.git");
    expect(listed.text).toContain("approved: 2026-10-12 10:00 UTC; last used: 2026-10-12 10:00 UTC; expires: 2026-10-26 10:00 UTC");

    now = T0 + 15 * DAY;
    expect((await runRouterApprovals("repos", "", opts())).text).toContain(`- ${ext}  [expired]`);
    now = T0;
    const excluded = await runRouterApprovals("repos", "", opts({ exclude: [path.join(base, "e*")] }));
    expect(excluded.text).toContain(`- ${ext}  [excluded by routing.repoExclude (`);
  }, 30_000);

  it("counts the entries the store validation dropped, and lists the rest", async () => {
    await runRouterApprovals("approve", ext, opts());
    const file = approvalsPath({ dir: storeDir });
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number; approvals: unknown[] };
    data.approvals.push({ path: "relative\\path", commonDir: "x", roots: ["nothex"], origin: "none", approvedAt: T0, lastUsedAt: T0 });
    fs.writeFileSync(file, JSON.stringify(data));
    const listed = await runRouterApprovals("repos", "", opts());
    expect(listed.text).toContain(`- ${ext}`);
    expect(listed.text).toContain("1 invalid entry was ignored.");
    expect(listed.text).not.toContain("relative");
  }, 30_000);

  it("reports an invalid store and never writes it", async () => {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(approvalsPath({ dir: storeDir }), "{not json");
    const listed = await runRouterApprovals("repos", "", opts());
    expect(listed.text).toContain("is invalid (is not valid JSON)");
    const revoked = await runRouterApprovals("revoke", ext, opts());
    expect(revoked.text).toMatch(/^Not revoked: /);
    const approved = await runRouterApprovals("approve", ext, opts());
    expect(approved.change).toBeUndefined();
    expect(approved.text).toMatch(/^Not approved: /);
    expect(approved.text).toContain(approvalsPath({ dir: storeDir }));
    expect(storeBytes()).toBe("{not json");
  });
});

describe("/router approve|repos|revoke through the plugin (SD-P4-10, S1, S5)", () => {
  type RouterRun = { text: string; marked: boolean };
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    vi.unstubAllEnvs();
    invalidateConfigCache();
    resetRolesWarnings();
  });

  /** A fresh HOME (the store and the override live below it) with a parents dir and a git repository outside it. */
  function home(): { dir: string; parents: string; repo: string } {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-p47-home-")));
    temps.push(dir);
    vi.stubEnv("HOME", dir);
    vi.stubEnv("USERPROFILE", dir);
    vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
    const parents = path.join(dir, "parents");
    fs.mkdirSync(parents, { recursive: true });
    const repo = path.join(dir, "outside");
    initRepo(repo);
    return { dir, parents, repo };
  }

  const rolesWith = (parents: string[]) => ({
    routing: { engine: "static", delegation: "roles", repoParents: parents.map((p) => p.replaceAll("\\", "/")) },
  });

  /** `/router <args>` typed in `sessionID`; `parentOf` gives the host's parent of a session, `"throw"` a failed lookup. */
  async function router(dir: string, override: Record<string, unknown>, args: string, opts: {
    host?: "v2";
    sessionID?: string;
    parentOf?: (id: string) => string | undefined | "throw";
  } = {}): Promise<RouterRun> {
    fs.mkdirSync(path.dirname(overridePath()), { recursive: true });
    fs.writeFileSync(overridePath(), JSON.stringify(override));
    invalidateConfigCache();
    resetRolesWarnings();
    const get = async ({ path: p }: { path: { id: string } }) => {
      const parent = opts.parentOf?.(p.id);
      if (parent === "throw") throw new Error("lookup down");
      return { data: { id: p.id, ...(parent === undefined ? {} : { parentID: parent }) } };
    };
    const hooks = await ModelRouterPlugin({
      directory: dir, worktree: dir, ...(opts.host === undefined ? {} : { routerHost: opts.host }),
      client: { session: { get }, app: { log: async () => ({}) } },
    } as unknown as RouterPluginInput) as Record<string, any>;
    try {
      const output = { parts: [] as Array<{ type: string; text: string }> };
      await hooks["command.execute.before"]({ command: "router", arguments: args, sessionID: opts.sessionID ?? "root" }, output);
      return { text: output.parts.map((part) => part.text).join("\n\n"), marked: approvalsChangedOf(output.parts) !== undefined };
    } finally {
      await hooks.dispose?.();
    }
  }

  const storeNow = (): string | undefined => (fs.existsSync(approvalsPath()) ? fs.readFileSync(approvalsPath(), "utf8") : undefined);

  it("a top-level human session on v2 in roles mode with parents: approve stores and marks, repos lists, revoke removes", async () => {
    const { dir, parents, repo } = home();
    const cfg = rolesWith([parents]);
    const helpRun = await router(dir, cfg, "help", { host: "v2" });
    for (const line of ROUTER_APPROVAL_HELP_LINES) expect(helpRun.text).toContain(line);

    const approved = await router(dir, cfg, `approve "${repo}"`, { host: "v2" });
    expect(approved.text).toContain(`Approved repository ${repo}`);
    expect(approved.marked).toBe(true);
    expect(readApprovals().approvals.map((a) => a.path)).toEqual([repo]);

    const listed = await router(dir, cfg, "repos", { host: "v2" });
    expect(listed.text).toContain(`- ${repo}`);
    expect(listed.marked).toBe(false);

    const revoked = await router(dir, cfg, `revoke ${repo}`, { host: "v2" });
    expect(revoked.text).toContain(`Revoked the approval of ${repo}.`);
    expect(revoked.marked).toBe(true);
    expect(readApprovals().approvals).toEqual([]);
  }, 60_000);

  it("a child session, a failed session lookup, no parents, tiers mode and v1: the help, unchanged; the store bytes unchanged", async () => {
    const { dir, parents, repo } = home();
    const cfg = rolesWith([parents]);
    await router(dir, cfg, `approve ${repo}`, { host: "v2" });
    const before = storeNow();
    expect(before).toBeDefined();
    const other = path.join(dir, "other");

    // From a child (the host reports a parent) or with a failed lookup: the help without the approval lines.
    const childHelp = await router(dir, cfg, "help", { host: "v2", sessionID: "child", parentOf: (id) => (id === "child" ? "root" : undefined) });
    expect(childHelp.text).not.toContain("/router approve");
    for (const args of [`approve ${other}`, `revoke ${repo}`, "repos"]) {
      const child = await router(dir, cfg, args, { host: "v2", sessionID: "child", parentOf: (id) => (id === "child" ? "root" : undefined) });
      expect(child.text, args).toBe(childHelp.text);
      expect(child.marked).toBe(false);
      const failed = await router(dir, cfg, args, { host: "v2", parentOf: () => "throw" });
      expect(failed.text, args).toBe(childHelp.text);
    }
    expect(storeNow()).toBe(before);

    // No parents, tiers mode, v1: `/router approve X` is `/router help`, byte for byte, without the approval lines.
    const inert: Array<[string, Record<string, unknown>, "v2" | undefined]> = [
      ["no parents", rolesWith([]), "v2"],
      ["tiers mode", { routing: { engine: "static", repoParents: [parents.replaceAll("\\", "/")] } }, "v2"],
      ["v1", cfg, undefined],
    ];
    for (const [label, config, host] of inert) {
      const opts = host === undefined ? {} : { host };
      const help = await router(dir, config, "help", opts);
      expect(help.text, label).not.toContain("/router approve");
      expect((await router(dir, config, `approve ${other}`, opts)).text, label).toBe(help.text);
      expect((await router(dir, config, `revoke ${repo}`, opts)).text, label).toBe(help.text);
    }
    expect(storeNow()).toBe(before);
  }, 60_000);
});

describe("router help (SD-P4-10)", () => {
  it("lists approve, repos and revoke only when they are available; otherwise the help is unchanged", () => {
    const plain = buildRouterHelp("advisory", { stats: true });
    expect(buildRouterHelp("advisory", { stats: true, approvals: false })).toBe(plain);
    const listed = buildRouterHelp("advisory", { stats: true, approvals: true });
    for (const line of ROUTER_APPROVAL_HELP_LINES) expect(listed).toContain(line);
    expect(listed.split("\n").filter((line) => !ROUTER_APPROVAL_HELP_LINES.includes(line)).join("\n")).toBe(plain);
  });
});

describe("/router revoke", () => {
  const location = (worktreePath: string, approval?: string): RepoLocation => ({
    repository: ext,
    name: "ext",
    worktree: worktreePath,
    branch: "main",
    head: "abc1234def",
    worktrees: [],
    ...(approval === undefined ? {} : { approval }),
  });

  it("removes the approval and drops the repository from every working set", async () => {
    await runRouterApprovals("approve", ext, opts());
    addToWorkingSet("orch-p47", location(ext, ext));
    addToWorkingSet("orch-p47", location(worktree, ext));
    const result = await runRouterApprovals("revoke", `"${ext}"`, opts());
    expect(result.change).toEqual({ kind: "revoke", path: ext });
    expect(result.text).toContain(`Revoked the approval of ${ext}.`);
    expect(result.text).toContain("Removed from the working sets (2 bindings).");
    expect(readApprovals({ dir: storeDir, now: () => now }).approvals).toEqual([]);
    expect(workingSetOf("orch-p47")).toEqual([]);
  }, 30_000);

  it("an unknown path changes nothing", async () => {
    await runRouterApprovals("approve", ext, opts());
    const before = storeBytes();
    const result = await runRouterApprovals("revoke", path.join(base, "other"), opts());
    expect(result.change).toBeUndefined();
    expect(result.text).toMatch(/^No approval for /);
    expect(storeBytes()).toBe(before);
  }, 30_000);
});
