import { describe, expect, it } from "vitest";
import { filterSensitiveDiff, filterSensitiveGrep, isSensitivePath, SENSITIVE_PATH_PATTERNS } from "../../src/router/sensitive-paths";
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
