import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// Plan C4 / R9: tests and dev-only config must NEVER ship in the npm package.
// The package.json `files` allowlist is the mechanism; this test is the guard
// that proves it stays correct as the test/ tree and tooling grow.
describe("packaging: published tarball excludes tests and dev config (plan C4)", () => {
  it("npm pack --dry-run ships only the allowlisted files", () => {
    const raw = execSync("npm pack --dry-run --json", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const paths = parsed
      .flatMap((p) => p.files.map((f) => f.path.replace(/\\/g, "/")))
      .sort();

    // MUST NOT ship tests, docs, tmp, coverage, or dev config.
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("docs/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("tmp/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("coverage/"))).toBe(false);
    expect(paths).not.toContain("tsconfig.json");
    expect(paths).not.toContain("vitest.config.ts");

    // MUST ship the runtime entry point and config.
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("tiers.json");
  });
});
