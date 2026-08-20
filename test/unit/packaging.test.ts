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
    // npm's --json shape is NOT stable across majors: through npm 11 this is an
    // array of package entries, and npm 12 returns an object keyed by package
    // name. Normalising both is what keeps this test surviving an npm upgrade
    // instead of dying with `parsed.flatMap is not a function` — which is how
    // it actually failed on npm 12.0.2, and is the "flaky packaging test" a
    // contributor reported (it looked intermittent because it tracks whichever
    // npm happens to be on the machine, not anything in this repo).
    type PackEntry = { files: Array<{ path: string }> };
    const parsed = JSON.parse(raw) as PackEntry[] | Record<string, PackEntry>;
    const entries: PackEntry[] = Array.isArray(parsed)
      ? parsed
      : Object.values(parsed);
    // If a future npm returns a third shape, fail here naming it rather than
    // silently reporting an empty file list.
    expect(entries.length).toBeGreaterThan(0);
    const paths = entries
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
