import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";

/** The shipped entry points: v1 `main`, the v2 server entry and the v2 TUI entry (#90). */
const ENTRY_POINTS = ["src/index.ts", "server.ts", "tui.ts"] as const;

/** Traverse local static imports/re-exports and literal dynamic imports/require calls from shipped entry points. */
function missingImports(paths: readonly string[], read: (path: string) => string): string[] {
  const shipped = new Set(paths);
  const visited = new Set<string>();
  const pending: string[] = [...ENTRY_POINTS];
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
      "tui.ts": 'export { default } from "./src/tui/plugin";',
      "src/tui/plugin.ts": "",
    };
    expect(missingImports(Object.keys(files), (p) => files[p]!)).toEqual(["src/helper.ts -> ./omitted"]);
  });
  it("N3: import-closure guard follows the tui.ts entry (#90)", () => {
    const files: Record<string, string> = {
      "src/index.ts": "",
      "server.ts": "",
      "tui.ts": 'export { default } from "./src/tui/plugin";',
      "src/tui/plugin.ts": 'import type { HostContext } from "./host-types";\nimport { parseOptions } from "./status-model";',
      "src/tui/host-types.ts": "",
    };
    expect(missingImports(Object.keys(files), (p) => files[p]!)).toEqual(["src/tui/plugin.ts -> ./status-model"]);
    delete files["tui.ts"];
    expect(missingImports(Object.keys(files), (p) => files[p]!)).toEqual(["tui.ts"]);
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
    // #90: the v2 TUI entry and its modules ship; no JSX, no root index.* (A2, A9).
    expect(paths).toContain("tui.ts");
    for (const file of TUI_CLOSURE) expect(paths).toContain(file);
    expect(paths.filter((p) => p.endsWith(".tsx"))).toEqual([]);
    expect(paths.filter((p) => /^index\./.test(p))).toEqual([]);
    expect(missingImports(paths, (p) => readFileSync(p, "utf8"))).toEqual([]);
  });
});

/** Source text without block comments and whole-line `//` comments (so prose never reads as an import). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every module specifier of a source: static imports/re-exports (type-only included), side-effect imports, literal `import()`/`require()`. */
function specifiersOf(text: string): string[] {
  const pattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?|\b(?:import|require)\s*\()\s*["']([^"']+)["']/g;
  return [...stripComments(text).matchAll(pattern)].map((match) => match[1]!);
}

/** Every file the TUI entry reaches through relative imports, and every bare specifier on the way. */
function tuiClosure(read: (path: string) => string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = ["tui.ts"];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of specifiersOf(read(file))) {
      if (!specifier.startsWith(".")) {
        bare.add(specifier);
        continue;
      }
      const base = posix.normalize(posix.join(posix.dirname(file), specifier));
      pending.push(base.endsWith(".ts") ? base : `${base}.ts`);
    }
  }
  return { files: [...files].sort(), bare: [...bare].sort() };
}

const TUI_CLOSURE = ["src/tui/effort-rpc.ts", "src/tui/host-types.ts", "src/tui/plugin.ts", "src/tui/status-model.ts"] as const;
/** Packages the host serves to TUI plugins (A2); a bundled copy breaks 2.0.25+ or shadows the host's Solid. */
const HOST_PACKAGE = /^(?:solid-js|effect|@opentui\/.+|@opencode\/.+)$/;

describe("packaging: v2 TUI entry (#90 P1.3, amendments A2/A9)", () => {
  const read = (path: string): string => readFileSync(path, "utf8");
  const pkg = JSON.parse(read("package.json")) as {
    main?: unknown;
    exports?: unknown;
    files?: unknown;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    bundleDependencies?: unknown;
    bundledDependencies?: unknown;
  };

  it("lists tui.ts in files next to server.ts and src/", () => {
    expect(pkg.files).toEqual(expect.arrayContaining(["server.ts", "tui.ts", "src/"]));
  });

  it("keeps v1 on main: no exports map, main is ./src/index.ts", () => {
    expect(Object.hasOwn(pkg, "exports")).toBe(false);
    expect(pkg.main).toBe("./src/index.ts");
  });

  it("has no root index.* (v1's TUI loader falls back to it for local sources)", () => {
    expect(readdirSync(".").filter((name) => /^index\./i.test(name))).toEqual([]);
  });

  it("declares no host package as a dependency, optional or peer dependency, and bundles nothing", () => {
    for (const deps of [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies]) {
      expect(Object.keys(deps ?? {}).filter((name) => HOST_PACKAGE.test(name))).toEqual([]);
    }
    expect(pkg.bundleDependencies).toBeUndefined();
    expect(pkg.bundledDependencies).toBeUndefined();
  });

  it("root tui.ts only re-exports the default of ./src/tui/plugin", () => {
    expect(existsSync("tui.ts")).toBe(true);
    expect(stripComments(read("tui.ts")).trim()).toMatch(/^export \{ default \} from "\.\/src\/tui\/plugin(?:\.ts)?";$/);
  });

  it("the TUI closure reaches only its own modules, solid-js and @opentui/solid", () => {
    const closure = tuiClosure(read);
    expect(closure.files).toEqual([...TUI_CLOSURE, "tui.ts"]);
    expect(closure.bare).toEqual(["@opentui/solid", "solid-js"]);
  });

  it("each TUI module imports exactly what it may", () => {
    expect(specifiersOf(read("src/tui/status-model.ts"))).toEqual([]);
    expect(specifiersOf(read("src/tui/effort-rpc.ts"))).toEqual([]);
    expect(specifiersOf(read("src/tui/host-types.ts"))).toEqual([]);
    expect([...new Set(specifiersOf(read("src/tui/plugin.ts")))].sort()).toEqual([
      "./effort-rpc",
      "./host-types",
      "./status-model",
      "@opentui/solid",
      "solid-js",
    ]);
  });

  it("takes only createElement, insert and setProp from @opentui/solid", () => {
    const source = stripComments(read("src/tui/plugin.ts"));
    const named = [...source.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["']@opentui\/solid["']/g)];
    expect(named).toHaveLength(1);
    expect(specifiersOf(source).filter((specifier) => specifier === "@opentui/solid")).toHaveLength(1);
    const names = named[0]![1]!.split(",").map((name) => name.trim()).filter((name) => name !== "");
    expect(names.sort()).toEqual(["createElement", "insert", "setProp"]);
  });

  it("keeps Solid in the TUI: no file under src/ outside src/tui/ imports solid-js or @opentui/solid", () => {
    const sources = readdirSync("src", { recursive: true })
      .map((name) => posix.join("src", String(name).replace(/\\/g, "/")))
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path) && !path.startsWith("src/tui/"));
    expect(sources.length).toBeGreaterThan(0);
    const offenders = sources.flatMap((path) =>
      specifiersOf(read(path))
        .filter((specifier) => /^(?:solid-js|@opentui\/solid)(?:\/|$)/.test(specifier))
        .map((specifier) => `${path} -> ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("ships no JSX: no .tsx under src/tui or at the root", () => {
    const tui = readdirSync("src/tui", { recursive: true }).map(String);
    expect(tui.filter((name) => name.endsWith(".tsx"))).toEqual([]);
    expect(readdirSync(".").filter((name) => name.endsWith(".tsx"))).toEqual([]);
  });
});
