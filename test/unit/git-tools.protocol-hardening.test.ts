/**
 * Phase 4 QA (m5): the shared hardening refuses every transport on the command line, so a partial clone's promisor cannot run
 * an `ext::` command on a lazy fetch, even when the repository allows `protocol.ext.allow=always` and the git in use ignores
 * GIT_NO_LAZY_FETCH (before 2.44). Real git.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gitRootCommits } from "../../src/routing/roles/admission";
import { gitEnvironment, hardeningArgs, PROTOCOL_HARDENING } from "../../src/router/git-tools";

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const hasNode = spawnSync("node", ["--version"], { encoding: "utf8" }).status === 0;

/** The router's environment without GIT_NO_LAZY_FETCH: what a git before 2.44 sees. */
function oldGitEnvironment(): NodeJS.ProcessEnv {
  const env = gitEnvironment();
  delete env.GIT_NO_LAZY_FETCH;
  return env;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnvironment() });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe.skipIf(!hasGit || !hasNode)("git hardening vs a promisor's lazy fetch (real git)", () => {
  let dir: string;
  let repo: string;
  let marker: string;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omr-lazy-fetch-")));
    repo = path.join(dir, "repo");
    marker = path.join(dir, "ext-command-ran");
    const script = path.join(dir, "ext.js");
    fs.writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    fs.mkdirSync(repo);
    git(repo, ["init", "--quiet"]);
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, ["add", "a.txt"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "one"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    // A partial clone whose promisor is an `ext::` command the repository allows, and whose HEAD commit is missing.
    git(repo, ["config", "core.repositoryformatversion", "1"]);
    git(repo, ["config", "extensions.partialClone", "origin"]);
    git(repo, ["config", "remote.origin.url", `ext::node ${script.replaceAll("\\", "/").replaceAll(" ", "% ")}`]);
    git(repo, ["config", "remote.origin.promisor", "true"]);
    git(repo, ["config", "protocol.ext.allow", "always"]);
    const object = path.join(repo, ".git", "objects", head.slice(0, 2), head.slice(2));
    fs.chmodSync(object, 0o666);
    fs.rmSync(object);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const revList = (config: readonly string[], env: NodeJS.ProcessEnv) =>
    spawnSync("git", [...config, "rev-list", "--max-parents=0", "HEAD", "--"], { cwd: repo, encoding: "utf8", env, timeout: 20_000 });

  it("control: a generic protocol.allow=never alone lets the repository's ext::allow run the promisor command", () => {
    const result = revList(["-c", "protocol.allow=never"], oldGitEnvironment());
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);

  it("the shared hardening refuses the lazy fetch without GIT_NO_LAZY_FETCH: rev-list fails and the ext command never runs", () => {
    const result = revList(hardeningArgs(), oldGitEnvironment());
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  it("the router's rev-list (gitRootCommits) fails without running the ext command", async () => {
    await expect(gitRootCommits(repo)).resolves.toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  }, 30_000);

  it("PROTOCOL_HARDENING is part of hardeningArgs", () => {
    expect(hardeningArgs().join("\u0000")).toContain(PROTOCOL_HARDENING.join("\u0000"));
  });
});
