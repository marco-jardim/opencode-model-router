import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnvironment, gitExecutable } from "../../src/router/git-tools";
import { filterSensitiveDiff, filterSensitiveGrep, isSensitivePath, sensitiveGitPathspecs, SENSITIVE_PATH_PATTERNS } from "../../src/router/sensitive-paths";
import { evaluatePermission, permissionRules, readOnlyPermissions } from "../../src/router/read-only";

describe("shared sensitive paths", () => {
  it.each(SENSITIVE_PATH_PATTERNS)("matches %s at every depth with corresponding read asks", pattern => {
    const name = pattern.replaceAll("*", "secret");
    for (const path of [name, `nested/${name}`, `C:\\repo\\nested\\${name.replaceAll("/", "\\")}`]) {
      expect(isSensitivePath(path)).toBe(true);
      expect(evaluatePermission(permissionRules(readOnlyPermissions()), "read", path)).toBe("ask");
      expect(isSensitivePath(path.toUpperCase(), "win32")).toBe(true);
    }
  });
  it("keeps examples and ordinary id helpers readable, and handles dot components", () => {
    for (const path of [".env.example", "nested/.env.example", "src/id_utils.ts", "id_other", "credentials.ts"])
      expect(isSensitivePath(path)).toBe(false);
    expect(evaluatePermission(permissionRules(readOnlyPermissions()), "read", "src/id_utils.ts")).toBe("allow");
    expect(isSensitivePath(".aws/./credentials")).toBe(true);
    expect(isSensitivePath(".ENV", "linux")).toBe(false);
    expect(isSensitivePath(".ENV.EXAMPLE", "win32")).toBe(false);
  });
  it.each(["prod.env", "secret.env", "prod.env.local", "deploy/prod.env"])("protects env suffix %s across read/grep/diff", path => {
    expect(evaluatePermission(permissionRules(readOnlyPermissions()), "read", path)).toBe("ask");
    expect(isSensitivePath(path)).toBe(true);
    expect(filterSensitiveGrep(`Found 1 matches\n${path}:\n  Line 1: PRIVATE_MARKER`)).not.toContain("PRIVATE_MARKER");
    expect(filterSensitiveDiff(`diff --git a/${path} b/${path}\n+PRIVATE_MARKER\n`)).not.toContain("PRIVATE_MARKER");
  });
  it.each(["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"])("agrees on exact key names, extensions and public key exception: %s", key => {
    for (const [path, sensitive] of [[key, true], [`${key}.bak`, true], [`${key}.pub`, false], [`${key}_helpers/x.ts`, false]] as const) {
      expect(isSensitivePath(path)).toBe(sensitive);
      expect(evaluatePermission(permissionRules(readOnlyPermissions()), "read", path)).toBe(sensitive ? "ask" : "allow");
    }
  });
  it("Git exclusion helpers hide every pattern while keeping env examples, public keys and helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "sensitive-pathspec-"));
    const git = (...args: string[]) => execFileSync(gitExecutable(), args, { cwd: root, env: gitEnvironment(), encoding: "utf8" });
    const sensitive = ["prod.env", "secret.env", "prod.env.local", "deploy/prod.env", ".env", ".env.local",
      ...SENSITIVE_PATH_PATTERNS.map(pattern => `nested/${pattern.replaceAll("*", "secret")}`)];
    const ordinary = [".env.example", "prod.env.example", "id_rsa.pub", "nested/id_ed25519.pub", "id_rsa_helpers/x.ts"];
    try {
      git("init", "-q");
      for (const path of [...sensitive, ...ordinary]) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), sensitive.includes(path) ? "PRIVATE_MARKER\n" : "PUBLIC_MARKER\n");
      }
      git("add", "-f", ".");
      const names = git("ls-files", "--cached", "--", ...sensitiveGitPathspecs()).trim().split(/\r?\n/).sort();
      expect(names).toEqual([...ordinary].sort());
      const diff = git("diff", "--cached", "--", ...sensitiveGitPathspecs());
      expect(diff).not.toContain("PRIVATE_MARKER"); expect(diff).toContain("PUBLIC_MARKER");
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  });
  it("keeps grep truncation notices even after a final sensitive block", () => {
    const notice = "(Results are truncated: showing first 1 results. Consider using a more specific path or pattern.)";
    const output = filterSensitiveGrep(`Found 1 matches\n/repo/prod.env:\n  Line 1: PRIVATE_MARKER\n\n${notice}`);
    expect(output).not.toContain("PRIVATE_MARKER"); expect(output).toContain(notice);
    expect(output).toContain("1 matches in sensitive files withheld");
  });
  it("keeps the next commit's header and message after withholding a diff section", () => {
    const next = `commit ${"b".repeat(64)}\nAuthor: Test\n\n    KEEP_MESSAGE\n`;
    const output = filterSensitiveDiff(`commit ${"a".repeat(40)}\n\ndiff --git a/secret.env b/secret.env\n+PRIVATE_MARKER\n${next}`);
    expect(output).not.toContain("PRIVATE_MARKER"); expect(output).toContain(next);
  });
  it("withholds whole grep blocks and counts matching lines rather than files", () => {
    const output = filterSensitiveGrep("Found 4 matches\nC:\\repo\\.env:\n  Line 1: SECRET\n  Line 2: SECRET\n\n/repo/id_rsa:\n  Line 1: SECRET\n\n/repo/src/id_utils.ts:\n  Line 3: PUBLIC");
    expect(output).not.toContain("SECRET");
    expect(output).toContain("PUBLIC");
    expect(output).toContain("3 matches in sensitive files withheld; use read (asks for approval)");
    expect(filterSensitiveGrep("No matches found")).toBe("No matches found");
  });
  it.each([
    'diff --git a/.env b/public.txt\nrename from .env\nrename to public.txt\n+SECRET\n',
    'diff --git a/public.txt b/id_rsa\n+SECRET\n',
    'diff --git "a/path with space/cert.pem" "b/path with space/cert.pem"\n+SECRET\n',
    'diff --git "a/\\056env" "b/\\056env"\n+SECRET\n',
    'diff --cc nested/.env\n+SECRET\n',
  ])("drops sensitive diff sections, including renames and C-quoted names", section => {
    const ordinary = "diff --git a/src/id_utils.ts b/src/id_utils.ts\n+PUBLIC\n";
    const output = filterSensitiveDiff(`commit test\n${section}${ordinary}`);
    expect(output).not.toContain("SECRET");
    expect(output).toContain("sensitive diff section withheld");
    expect(output).toContain(ordinary);
  });
});
