import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

/** Traverse local static imports/re-exports and literal dynamic imports/require calls from shipped entry points. */
function missingImports(paths: readonly string[], read: (path: string) => string): string[] {
  const shipped = new Set(paths);
  const visited = new Set<string>();
  const pending = ["src/index.ts", "server.ts"];
  const missing: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!shipped.has(file)) { missing.push(file); continue; }
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    const text = read(file);
    const imports = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?|\b(?:import|require)\s*\()\s*["'](\.[^"']+)["']/g;
    for (const match of text.matchAll(imports)) {
      const specifier = match[1]!;
      const base = posix.normalize(posix.join(posix.dirname(file), specifier));
      const resolved = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find((p) => shipped.has(p));
      if (resolved === undefined) missing.push(`${file} -> ${specifier}`);
      else pending.push(resolved);
    }
  }
  return missing.sort();
}

// Plan C4 / R9: tests and dev-only config must NEVER ship in the npm package.
// The package.json `files` allowlist is the mechanism; this test is the guard
// that proves it stays correct as the test/ tree and tooling grow.
describe("packaging: published tarball excludes tests and dev config (plan C4)", () => {
  it("N2: import-closure guard catches an omitted transitive module", () => {
    const files: Record<string, string> = {
      "src/index.ts": 'export { helper } from "./helper";',
      "src/helper.ts": 'import("./omitted");',
      "server.ts": 'import "./src/index";',
    };
    expect(missingImports(Object.keys(files), (p) => files[p]!)).toEqual(["src/helper.ts -> ./omitted"]);
  });
  it("npm pack --dry-run ships only the allowlisted files", { timeout: 60_000 }, () => {
    const raw = execSync("npm pack --dry-run --json", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
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
    expect(paths).toContain("server.ts");
    expect(paths).toContain("src/v2.ts");
    expect(paths).toContain("tiers.json");
    expect(missingImports(paths, (p) => readFileSync(p, "utf8"))).toEqual([]);
  });
});
