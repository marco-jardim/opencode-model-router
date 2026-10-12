/**
 * test/unit/edges.test.ts
 *
 * Cross-repo P3c.1 (docs/design/cross-repo-phase3-plan.md, item (c), SD-P3c-1..10, D24 = Tier A): the dependency edges a root
 * declares outside `node_modules`, parsed as text. Real temporary directories; the file primitives are spied through the
 * injectable `EdgeIO` (stat before read, bounds, no filesystem call on a UNC spec). Targets need not exist: nothing resolves them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  declaredEdges,
  defaultEdgeIO,
  EDGE_EXTENDS_DEPTH_MAX,
  EDGE_FILE_BYTES_MAX,
  EDGE_FILES_MAX,
  EDGE_LIMITS,
  EDGE_OVERRIDES_DEPTH_MAX,
  EDGE_TSCONFIG_VARIANTS_MAX,
  EDGE_VIAS,
  EDGE_WORKSPACES_MAX,
  EDGES_MAX,
  type DeclaredEdge,
  type DeclaredEdges,
  type EdgeIO,
  parseJsonc,
  SITE_PACKAGES_ENTRIES_MAX,
  SITE_PACKAGES_FILES_MAX,
  workspaceDirsSync,
  workspacePatterns,
} from "../../src/verify/edges";
import {
  admissionContext,
  dependencyTargets,
  EDGE_UNADMITTED_NAMES_MAX,
  type DependencyIO,
  type EdgeContext,
  resolveEdgeTarget,
  workspaceDirs,
} from "../../src/verify/perimeter";
import { gitTopOf } from "../../src/verify/git-top";
import type { RepoLocation } from "../../src/routing/roles/admission";

let tmp: string;
let parent: string;
let app: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omr-edges-"));
  parent = path.join(tmp, "parent");
  app = path.join(parent, "app");
  fs.mkdirSync(app, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Writes `<app>/<rel>` (parents created) and returns its path. */
function write(rel: string, content: string): string {
  const file = path.join(app, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeJson(rel: string, value: unknown): string {
  return write(rel, JSON.stringify(value, null, 2));
}

/** `[via, spec, from]` per edge, in order. */
function triples(result: DeclaredEdges): [string, string, string][] {
  return result.edges.map((edge) => [edge.via, edge.spec, edge.from]);
}

type Call = { op: "stat" | "readFile" | "readdir"; p: string; max?: number };

/** `defaultEdgeIO`, every call recorded in order. */
function spyIO(): { io: EdgeIO; calls: Call[] } {
  const calls: Call[] = [];
  const io: EdgeIO = {
    stat: (p) => {
      calls.push({ op: "stat", p });
      return defaultEdgeIO.stat(p);
    },
    readFile: (p) => {
      calls.push({ op: "readFile", p });
      return defaultEdgeIO.readFile(p);
    },
    readdir: (dir, max) => {
      calls.push({ op: "readdir", p: dir, max });
      return defaultEdgeIO.readdir(dir, max);
    },
  };
  return { io, calls };
}

const reads = (calls: Call[]): string[] => calls.filter((call) => call.op === "readFile").map((call) => call.p);

/** A Python `repr` of a string, single-quoted (as setuptools writes the finder's `MAPPING`). */
const pyRepr = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

describe("parseJsonc (SD-P3c-7)", () => {
  it("keeps comment-like text inside strings", () => {
    expect(parseJsonc('{"a": "http://x/*y*/", "b": "// not a comment", "c": "x\\"//y", "d": "x\\\\"}')).toEqual({
      a: "http://x/*y*/",
      b: "// not a comment",
      c: 'x"//y',
      d: "x\\",
    });
  });

  it("removes line and block comments outside strings", () => {
    const text = '// head\n{\n  /* block\n spanning */ "a": 1, // tail\n  "b": /* inline */ [2]\n}\n// end';
    expect(parseJsonc(text)).toEqual({ a: 1, b: [2] });
  });

  it("drops a leading BOM", () => {
    expect(parseJsonc('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });

  it("removes trailing commas before } and ], comments between included", () => {
    expect(parseJsonc('{"a": [1, 2,], "b": {"c": 1,}, "d": [3, // x\n], "e": ",}",}')).toEqual({ a: [1, 2], b: { c: 1 }, d: [3], e: ",}" });
  });

  it("gives undefined for invalid text", () => {
    expect(parseJsonc('{"a": }')).toBeUndefined();
    expect(parseJsonc('{"a": 1 /* unterminated')).toBeUndefined();
    expect(parseJsonc('{"a": "unterminated')).toBeUndefined();
    expect(parseJsonc("")).toBeUndefined();
    expect(parseJsonc("[1,,]")).toBeUndefined();
  });
});

describe("A1 package.json path specs", () => {
  it("reads file:/link:/portal: in every field, overrides leaves to depth 4, resolutions and pnpm.overrides", () => {
    writeJson("package.json", {
      name: "app",
      dependencies: { a: "file:../lib-a", inside: "file:./packages/x" },
      devDependencies: { b: "link:../lib-b" },
      optionalDependencies: { c: "portal:../lib-c" },
      peerDependencies: { d: "file:../lib-d" },
      overrides: { e: "file:../lib-e", nested: { ".": "file:../lib-f", deeper: { x: { y: "file:../lib-g" } } } },
      resolutions: { "h/**": "portal:../lib-h" },
      pnpm: { overrides: { i: "link:../lib-i" } },
    });
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([
      ["package.json dependencies (file:)", "../lib-a", "package.json"],
      ["package.json devDependencies (link:)", "../lib-b", "package.json"],
      ["package.json optionalDependencies (portal:)", "../lib-c", "package.json"],
      ["package.json peerDependencies (file:)", "../lib-d", "package.json"],
      ["package.json overrides (file:)", "../lib-e", "package.json"],
      ["package.json overrides (file:)", "../lib-f", "package.json"],
      ["package.json overrides (file:)", "../lib-g", "package.json"],
      ["package.json resolutions (portal:)", "../lib-h", "package.json"],
      ["package.json pnpm.overrides (link:)", "../lib-i", "package.json"],
    ]);
    expect(result.edges.every((edge) => edge.kind === "package" && edge.unc === undefined)).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it("does not read overrides leaves deeper than EDGE_OVERRIDES_DEPTH_MAX, and says so", () => {
    expect(EDGE_OVERRIDES_DEPTH_MAX).toBe(4);
    writeJson("package.json", { overrides: { a: { b: { c: { d: { e: "file:../too-deep" } } } } } });
    const result = declaredEdges(app);
    expect(result.edges).toEqual([]);
    expect(result.incomplete).toBe(true);
  });

  it("ignores tarballs, workspace:, npm:, git and http URLs and plain semver", () => {
    writeJson("package.json", {
      dependencies: {
        semver: "^1.2.3",
        tag: "latest",
        ws: "workspace:*",
        alias: "npm:other@1.0.0",
        git: "git+https://github.com/x/y.git",
        gh: "github:x/y",
        ssh: "git@github.com:x/y.git",
        http: "https://example.com/y.tgz",
        tgz: "file:../pkg.tgz",
        targz: "file:../pkg.tar.gz",
        empty: "file:",
        notString: 3,
      },
    });
    expect(declaredEdges(app)).toEqual({ edges: [], incomplete: false });
  });

  it("converts a file:// URL with fileURLToPath", () => {
    const target = path.join(parent, "lib-url");
    writeJson("package.json", { dependencies: { u: pathToFileURL(target).href } });
    expect(triples(declaredEdges(app))).toEqual([["package.json dependencies (file:)", target, "package.json"]]);
  });

  it("drops targets inside the root and keeps the first declaration of a target", () => {
    writeJson("package.json", {
      dependencies: { inside: "file:./vendor/x", self: "file:.", a: "file:../lib-a" },
      devDependencies: { again: "link:../lib-a/", also: "portal:../app/../lib-a" },
    });
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([["package.json dependencies (file:)", "../lib-a", "package.json"]]);
    expect(result.incomplete).toBe(false);
  });

  it("skips a malformed package.json", () => {
    write("package.json", '{ "dependencies": { "a": "file:../lib-a" ');
    expect(declaredEdges(app)).toEqual({ edges: [], incomplete: false });
  });
});

describe("A2 tsconfig / jsconfig", () => {
  it("reads extends, references, rootDirs, typeRoots, include and files; ignores outputs and package extends", () => {
    write(
      "tsconfig.json",
      [
        "{",
        '  // a line comment with "quotes"',
        "  /* a block comment */",
        '  "extends": ["./tsconfig.base.json", "@tsconfig/node20/tsconfig.json", "../shared/tsconfig.json"],',
        '  "compilerOptions": {',
        '    "rootDirs": ["src", "../gen"],',
        '    "typeRoots": ["./node_modules/@types", "../types"],',
        '    "outDir": "../out",',
        '    "declarationDir": "../decl",',
        '    "tsBuildInfoFile": "../tsbuild/app.tsbuildinfo",',
        "  },",
        '  "references": [{ "path": "../lib-c" }, { "path": "./packages/a" }],',
        '  "include": ["src/**/*", "../lib-d/src/**/*.ts"],',
        '  "files": ["../lib-e/index.ts"],',
        "}",
      ].join("\n"),
    );
    writeJson("tsconfig.base.json", { compilerOptions: { typeRoots: ["../base-types"] } });
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([
      ["tsconfig typeRoots", "../base-types", "tsconfig.base.json"],
      ["tsconfig extends", "../shared/tsconfig.json", "tsconfig.json"],
      ["tsconfig references", "../lib-c", "tsconfig.json"],
      ["tsconfig rootDirs", "../gen", "tsconfig.json"],
      ["tsconfig typeRoots", "../types", "tsconfig.json"],
      ["tsconfig include", "../lib-d/src/", "tsconfig.json"],
      ["tsconfig files", "../lib-e/index.ts", "tsconfig.json"],
    ]);
    expect(result.edges.every((edge) => edge.kind === "tsconfig")).toBe(true);
    expect(result.incomplete).toBe(false);
  });

  it("cuts paths values to their static prefix, against the file's directory without baseUrl", () => {
    writeJson("tsconfig.json", {
      compilerOptions: {
        paths: { "@lib/*": ["../lib-b/src/*"], "@one": ["../lib-one/index.ts"], "@pre/*": ["../lib-p/pre-*"], "*": ["*"] },
      },
    });
    expect(triples(declaredEdges(app))).toEqual([
      ["tsconfig paths", "../lib-b/src/", "tsconfig.json"],
      ["tsconfig paths", "../lib-one/index.ts", "tsconfig.json"],
      ["tsconfig paths", "../lib-p/", "tsconfig.json"],
    ]);
  });

  it("resolves paths prefixes against baseUrl, and reads an outside baseUrl itself", () => {
    writeJson("tsconfig.json", { compilerOptions: { baseUrl: "./src", paths: { "@lib/*": ["../../lib-b/src/*"] } } });
    writeJson("jsconfig.json", { compilerOptions: { baseUrl: "../vendor", paths: { "x/*": ["x/*"] } } });
    expect(triples(declaredEdges(app))).toEqual([
      ["tsconfig paths", path.join("./src", "../../lib-b/src/"), "tsconfig.json"],
      ["tsconfig baseUrl", "../vendor", "jsconfig.json"],
      ["tsconfig paths", path.join("../vendor", "x/"), "jsconfig.json"],
    ]);
  });

  it("follows an extends chain inside the root to EDGE_EXTENDS_DEPTH_MAX, appending .json, and says when it is cut", () => {
    expect(EDGE_EXTENDS_DEPTH_MAX).toBe(4);
    writeJson("tsconfig.json", { extends: "./chain1" });
    for (let n = 1; n <= 5; n++) writeJson(`chain${n}.json`, { extends: `./chain${n + 1}.json`, compilerOptions: { typeRoots: [`../t${n}`] } });
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(triples(result).map(([, spec, from]) => [spec, from])).toEqual([
      ["../t4", "chain4.json"],
      ["../t3", "chain3.json"],
      ["../t2", "chain2.json"],
      ["../t1", "chain1.json"],
    ]);
    expect(reads(calls)).not.toContain(path.join(app, "chain5.json"));
    expect(result.incomplete).toBe(true);
  });

  it("detects an extends cycle and reads each file once", () => {
    writeJson("tsconfig.json", { extends: "./a.json", compilerOptions: { typeRoots: ["../t0"] } });
    writeJson("a.json", { extends: "./b.json", compilerOptions: { typeRoots: ["../ta"] } });
    writeJson("b.json", { extends: ["./a.json", "./tsconfig.json"], compilerOptions: { typeRoots: ["../tb"] } });
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(triples(result).map(([, spec]) => spec)).toEqual(["../tb", "../ta", "../t0"]);
    expect(result.incomplete).toBe(false);
    const read = reads(calls);
    expect(new Set(read).size).toBe(read.length);
  });

  it("names an extends target outside the root as an edge and never reads it", () => {
    writeJson("tsconfig.json", { extends: "../outside/tsconfig.json" });
    const outside = path.join(parent, "outside", "tsconfig.json");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, JSON.stringify({ compilerOptions: { typeRoots: ["../never-read"] } }));
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(triples(result)).toEqual([["tsconfig extends", "../outside/tsconfig.json", "tsconfig.json"]]);
    expect(calls.some((call) => call.p === outside)).toBe(false);
  });

  it("reads JSONC (BOM, comments, trailing commas) and skips a malformed config", () => {
    write("tsconfig.json", '\uFEFF{ // c\n "references": [{"path": "../lib-c"},],\n}');
    write("jsconfig.json", '{ "references": [{"path": "../never"}] ');
    expect(triples(declaredEdges(app))).toEqual([["tsconfig references", "../lib-c", "tsconfig.json"]]);
  });

  it("reads at most EDGE_TSCONFIG_VARIANTS_MAX root tsconfig.*.json variants, in code-unit order", () => {
    expect(EDGE_TSCONFIG_VARIANTS_MAX).toBe(8);
    for (let n = 1; n <= 10; n++) {
      const id = String(n).padStart(2, "0");
      writeJson(`tsconfig.v${id}.json`, { references: [{ path: `../ref-${id}` }] });
    }
    const result = declaredEdges(app);
    expect(triples(result).map(([, spec, from]) => [spec, from])).toEqual(
      ["01", "02", "03", "04", "05", "06", "07", "08"].map((id) => [`../ref-${id}`, `tsconfig.v${id}.json`]),
    );
    expect(result.incomplete).toBe(true);
  });
});

describe("A3 Python editable installs in an in-repo venv", () => {
  it("reads a win32 layout: .pth path lines (import lines skipped), the finder MAPPING by regex, .egg-link first line", () => {
    const mylib = path.join(parent, "py-lib", "src", "mylib");
    const other = path.join(parent, "py-other");
    const ns = path.join(parent, "py-ns");
    const egg = path.join(parent, "py-egg");
    write(".venv/pyvenv.cfg", "home = C:\\Python312\nversion = 3.12.4\n");
    const site = ".venv/Lib/site-packages";
    write(`${site}/__editable__.mylib-0.1.pth`, "import __editable___mylib_0_1_finder; __editable___mylib_0_1_finder.install()\n");
    write(
      `${site}/__editable___mylib_0_1_finder.py`,
      [
        "import sys",
        "from importlib.machinery import ModuleSpec, PathFinder",
        "from importlib.machinery import all_suffixes as module_suffixes",
        "from importlib.util import spec_from_file_location",
        "from itertools import chain",
        "from pathlib import Path",
        "",
        `MAPPING: dict[str, str] = {'mylib': ${pyRepr(mylib)}, 'mylib_extra': "${other.replace(/\\/g, "\\\\")}"}`,
        `NAMESPACES: dict[str, list[str]] = {'ns_pkg': [${pyRepr(ns)}]}`,
        "PATH_PLACEHOLDER = '__editable__.mylib-0.1.finder' + \".__path_hook__\"",
        "",
        "",
        "class _EditableFinder:  # MetaPathFinder",
        "    @classmethod",
        "    def find_spec(cls, fullname: str, path=None, target=None) -> ModuleSpec | None:  # type: ignore",
        "        return None",
        "",
        "",
        "def install():",
        "    if not any(finder == _EditableFinder for finder in sys.meta_path):",
        "        sys.meta_path.append(_EditableFinder)",
        "",
      ].join("\n"),
    );
    write(`${site}/distutils-precedence.pth`, "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'\n");
    write(`${site}/legacy.pth`, "# a comment\n../../../../py-legacy\n\nimport\tsys\n../../../src\n");
    write(`${site}/old.egg-link`, `${egg}\n.\n`);
    write(`${site}/notes.txt`, "../../../../never\n");
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([
      ["python editable install", mylib, ".venv/Lib/site-packages/__editable___mylib_0_1_finder.py"],
      ["python editable install", other, ".venv/Lib/site-packages/__editable___mylib_0_1_finder.py"],
      ["python editable install", "../../../../py-legacy", ".venv/Lib/site-packages/legacy.pth"],
      ["python editable install", egg, ".venv/Lib/site-packages/old.egg-link"],
    ]);
    expect(result.edges.every((edge) => edge.kind === "python")).toBe(true);
    expect(result.edges.some((edge) => edge.spec === ns)).toBe(false);
  });

  it("reads a posix layout (venv/lib/python3.*/site-packages)", () => {
    const target = path.join(parent, "py-posix");
    write("venv/pyvenv.cfg", "home = /usr/bin\n");
    write("venv/lib/python3.12/site-packages/__editable__.posix-1.0.pth", `${target}\n`);
    expect(triples(declaredEdges(app))).toEqual([
      ["python editable install", target, "venv/lib/python3.12/site-packages/__editable__.posix-1.0.pth"],
    ]);
  });

  it("reads no venv without pyvenv.cfg, and prefers .venv over venv", () => {
    write(".venv/Lib/site-packages/a.pth", "../../../../no-cfg\n");
    expect(declaredEdges(app).edges).toEqual([]);
    write("venv/pyvenv.cfg", "");
    write("venv/Lib/site-packages/b.pth", "../../../../from-venv\n");
    write(".venv/pyvenv.cfg", "");
    expect(triples(declaredEdges(app)).map(([, spec]) => spec)).toEqual(["../../../../no-cfg"]);
  });
});

describe("A4 Go replace and go.work", () => {
  it("reads local replace targets, single and block, comments stripped; module-path replacements ignored", () => {
    const abs = path.join(parent, "go-abs");
    write(
      "go.mod",
      [
        "module example.com/app",
        "",
        "go 1.22",
        "",
        "require example.com/lib v1.0.0 // indirect",
        "",
        "replace example.com/lib => ../go-lib // a local checkout",
        "replace example.com/fork v1.2.0 => example.com/myfork v1.2.1",
        `replace example.com/abs => \`${abs}\``,
        "replace (",
        "\texample.com/a => ./vendor-a",
        "\texample.com/b v1.0.0 => ../go-b",
        "\texample.com/c => github.com/x/c v0.1.0",
        '\t"example.com/d" => "../go d" // quoted',
        ")",
        "// replace example.com/e => ../go-e",
        "use ../not-in-go-mod",
        "",
      ].join("\n"),
    );
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([
      ["go.mod replace", "../go-lib", "go.mod"],
      ["go.mod replace", abs, "go.mod"],
      ["go.mod replace", "../go-b", "go.mod"],
      ["go.mod replace", "../go d", "go.mod"],
    ]);
    expect(result.edges.every((edge) => edge.kind === "go")).toBe(true);
  });

  it("reads go.work use, single and block, and its local replace", () => {
    write(
      "go.work",
      [
        "go 1.22",
        "",
        "use .",
        "use ../go-single // one",
        "use (",
        "\t./sub",
        "\t../go-block // a comment",
        "\t`../go raw`",
        ")",
        "replace example.com/w v1.0.0 => ../go-work-replace",
        "replace example.com/m => example.com/m2 v1.0.0",
        "",
      ].join("\r\n"),
    );
    expect(triples(declaredEdges(app))).toEqual([
      ["go.work use", "../go-single", "go.work"],
      ["go.work use", "../go-block", "go.work"],
      ["go.work use", "../go raw", "go.work"],
      ["go.work replace", "../go-work-replace", "go.work"],
    ]);
  });
});

describe("workspace packages", () => {
  it("reads each workspace package's package.json and tsconfig.json; edges carry the declaring file", () => {
    writeJson("package.json", { name: "app", workspaces: ["packages/*"], dependencies: { "lib-b": "file:../lib-b" } });
    writeJson("packages/a/package.json", { dependencies: { x: "file:../../../lib-x", y: "workspace:*", sib: "file:../b" } });
    writeJson("packages/a/tsconfig.json", { extends: "../../tsconfig.base.json", references: [{ path: "../../../lib-y" }] });
    writeJson("tsconfig.base.json", { compilerOptions: { typeRoots: ["../base-types"] } });
    writeJson("packages/b/package.json", { devDependencies: { "lib-b": "link:../../../lib-b" } });
    const result = declaredEdges(app);
    expect(triples(result)).toEqual([
      ["package.json dependencies (file:)", "../lib-b", "package.json"],
      ["tsconfig typeRoots", "../base-types", "tsconfig.base.json"],
      ["package.json dependencies (file:)", "../../../lib-x", "packages/a/package.json"],
      ["tsconfig references", "../../../lib-y", "packages/a/tsconfig.json"],
    ]);
    expect(result.incomplete).toBe(false);
  });

  it("workspacePatterns reads an array or { packages }, strings only", () => {
    expect(workspacePatterns({ workspaces: ["a/*", 3, "b"] })).toEqual(["a/*", "b"]);
    expect(workspacePatterns({ workspaces: { packages: ["c/*"], nohoist: ["x"] } })).toEqual(["c/*"]);
    expect(workspacePatterns({ workspaces: "a/*" })).toEqual([]);
    expect(workspacePatterns({})).toEqual([]);
  });

  it("the synchronous workspace matcher agrees with perimeter.ts workspaceDirs", async () => {
    for (const dir of ["packages/a", "packages/b", "packages/.hidden", "packages/node_modules", "packages/lib-c", "apps/web", "tools/x1", "tools/y"]) {
      fs.mkdirSync(path.join(app, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(app, "packages", "file.txt"), "");
    const patterns = [
      "packages/*",
      "packages/**",
      "packages/lib-*",
      "packages/*/inner",
      "apps/web",
      "apps/missing",
      "./apps/*",
      "!packages/b",
      "../outside/*",
      "/abs/*",
      "tools/x*",
      "",
      ".",
      "packages\\*",
    ];
    for (const pattern of patterns) {
      for (const limit of [64, 1, 0]) {
        const sync = workspaceDirsSync(app, pattern, limit);
        const viaAsync = await workspaceDirs(app, pattern, limit);
        expect([...sync].sort(), `${pattern} (limit ${limit})`).toEqual([...viaAsync].sort());
      }
    }
  });
});

describe("bounds (SD-P3c-4)", () => {
  it("pins the plan's bounds", () => {
    expect(EDGE_FILE_BYTES_MAX).toBe(1024 * 1024);
    expect(EDGE_FILES_MAX).toBe(128);
    expect(EDGES_MAX).toBe(64);
    expect(EDGE_WORKSPACES_MAX).toBe(64);
    expect(SITE_PACKAGES_ENTRIES_MAX).toBe(4000);
    expect(SITE_PACKAGES_FILES_MAX).toBe(64);
    expect(EDGE_LIMITS).toEqual({
      bytes: EDGE_FILE_BYTES_MAX,
      files: EDGE_FILES_MAX,
      edges: EDGES_MAX,
      workspaces: EDGE_WORKSPACES_MAX,
      extendsDepth: EDGE_EXTENDS_DEPTH_MAX,
      tsconfigVariants: EDGE_TSCONFIG_VARIANTS_MAX,
      entries: SITE_PACKAGES_ENTRIES_MAX,
      siteFiles: SITE_PACKAGES_FILES_MAX,
    });
  });

  it("stats every file (size check) before reading it, every kind included", () => {
    writeJson("package.json", { workspaces: ["packages/*"], dependencies: { a: "file:../lib-a" } });
    writeJson("packages/p/package.json", { dependencies: { b: "file:../../../lib-b" } });
    writeJson("packages/p/tsconfig.json", { references: [{ path: "../../../lib-c" }] });
    writeJson("tsconfig.json", { extends: "./tsconfig.base.json" });
    writeJson("tsconfig.base.json", { include: ["../lib-d/**"] });
    write("go.mod", "module x\nreplace a => ../go-a\n");
    write("go.work", "use ../go-w\n");
    write(".venv/pyvenv.cfg", "");
    write(".venv/Lib/site-packages/x.pth", "../../../../py-x\n");
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(result.edges.map((edge) => edge.kind).sort()).toEqual(["go", "go", "package", "package", "python", "tsconfig", "tsconfig"]);
    const read = reads(calls);
    expect(read.length).toBe(8);
    for (const file of read) {
      const at = calls.findIndex((call) => call.op === "readFile" && call.p === file);
      expect(calls.slice(0, at).some((call) => call.op === "stat" && call.p === file), file).toBe(true);
    }
    expect(calls.filter((call) => call.op === "readdir").every((call) => call.max === SITE_PACKAGES_ENTRIES_MAX)).toBe(true);
  });

  it("does not read a file larger than EDGE_FILE_BYTES_MAX, and says so", () => {
    const file = writeJson("package.json", { description: "x".repeat(EDGE_FILE_BYTES_MAX), dependencies: { a: "file:../lib-a" } });
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(result).toEqual({ edges: [], incomplete: true });
    expect(reads(calls)).not.toContain(file);
    expect(calls.some((call) => call.op === "stat" && call.p === file)).toBe(true);
  });

  it("reads at most limits.files files, and says so", () => {
    writeJson("package.json", { dependencies: { a: "file:../lib-a" } });
    writeJson("tsconfig.json", { references: [{ path: "../lib-b" }] });
    write("go.mod", "replace a => ../go-a\n");
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io, { ...EDGE_LIMITS, files: 2 });
    expect(reads(calls)).toEqual([path.join(app, "package.json"), path.join(app, "tsconfig.json")]);
    expect(triples(result).map(([, spec]) => spec)).toEqual(["../lib-a", "../lib-b"]);
    expect(result.incomplete).toBe(true);
  });

  it("reads at most EDGE_FILES_MAX files by default", () => {
    writeJson("package.json", { workspaces: ["packages/*"] });
    for (let n = 0; n < EDGE_WORKSPACES_MAX; n++) {
      const id = String(n).padStart(2, "0");
      writeJson(`packages/p${id}/package.json`, {});
      writeJson(`packages/p${id}/tsconfig.json`, {});
    }
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(reads(calls).length).toBe(EDGE_FILES_MAX);
    expect(result.incomplete).toBe(true);
  });

  it("reads at most EDGE_WORKSPACES_MAX workspace packages, and says so", () => {
    writeJson("package.json", { workspaces: ["packages/*"] });
    for (let n = 0; n <= EDGE_WORKSPACES_MAX; n++) writeJson(`packages/p${String(n).padStart(2, "0")}/package.json`, {});
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(reads(calls).filter((file) => file.includes(`${path.sep}packages${path.sep}`)).length).toBe(EDGE_WORKSPACES_MAX);
    expect(result.incomplete).toBe(true);
  });

  it("keeps at most EDGES_MAX distinct targets; duplicates do not count", () => {
    const dependencies: Record<string, string> = {};
    for (let n = 0; n < EDGES_MAX; n++) dependencies[`d${n}`] = `file:../e${n}`;
    writeJson("package.json", { dependencies, devDependencies: { again: "link:../e0", also: "file:../e1/" } });
    const exact = declaredEdges(app);
    expect(exact.edges.length).toBe(EDGES_MAX);
    expect(exact.incomplete).toBe(false);
    writeJson("package.json", { dependencies: { ...dependencies, over: "file:../e-over" } });
    const over = declaredEdges(app);
    expect(over.edges.length).toBe(EDGES_MAX);
    expect(over.edges.some((edge) => edge.spec === "../e-over")).toBe(false);
    expect(over.incomplete).toBe(true);
  });

  it("bounds the site-packages listing and the editable-install files read", () => {
    write(".venv/pyvenv.cfg", "");
    for (let n = 0; n < 8; n++) write(`.venv/Lib/site-packages/p${n}.pth`, `../../../../py-${n}\n`);
    const listing = declaredEdges(app, defaultEdgeIO, { ...EDGE_LIMITS, entries: 5 });
    expect(listing.edges.length).toBeLessThanOrEqual(5);
    expect(listing.incomplete).toBe(true);
    const { io, calls } = spyIO();
    const files = declaredEdges(app, io, { ...EDGE_LIMITS, siteFiles: 2 });
    expect(reads(calls).filter((file) => file.endsWith(".pth"))).toEqual(
      ["p0.pth", "p1.pth"].map((name) => path.join(app, ".venv", "Lib", "site-packages", name)),
    );
    expect(files.incomplete).toBe(true);
  });

  it("the default EdgeIO readdir returns at most max + 1 names", () => {
    for (let n = 0; n < 10; n++) write(`many/f${n}`, "");
    expect(defaultEdgeIO.readdir(path.join(app, "many"), 3).length).toBe(4);
    expect(defaultEdgeIO.readdir(path.join(app, "many"), 20).length).toBe(10);
  });
});

describe("UNC and device specs (SD-P3c-3)", () => {
  it("flags a UNC or device spec of every kind and never touches it", () => {
    writeJson("package.json", {
      dependencies: { a: "file:\\\\uncsrv9\\share\\lib", b: "link://uncsrv9/share/lib2" },
    });
    writeJson("tsconfig.json", { extends: "//uncsrv9/share/tsconfig.json", references: [{ path: "\\\\?\\C:\\uncsrv9-device" }] });
    write("go.mod", "replace example.com/u => \\\\uncsrv9\\go\n");
    write(".venv/pyvenv.cfg", "");
    write(".venv/Lib/site-packages/u.pth", "\\\\uncsrv9\\py\n");
    const { io, calls } = spyIO();
    const result = declaredEdges(app, io);
    expect(result.edges.map((edge) => [edge.kind, edge.spec, edge.unc])).toEqual([
      ["package", "\\\\uncsrv9\\share\\lib", true],
      ["package", "//uncsrv9/share/lib2", true],
      ["tsconfig", "//uncsrv9/share/tsconfig.json", true],
      ["tsconfig", "\\\\?\\C:\\uncsrv9-device", true],
      ["go", "\\\\uncsrv9\\go", true],
      ["python", "\\\\uncsrv9\\py", true],
    ]);
    expect(calls.filter((call) => call.p.toLowerCase().includes("uncsrv9"))).toEqual([]);
  });

  it("a file://host URL is a UNC path on win32, and is skipped elsewhere", () => {
    writeJson("package.json", { dependencies: { u: "file://uncsrv9/share/lib" } });
    const result = declaredEdges(app);
    if (process.platform === "win32") expect(result.edges).toEqual([
      { kind: "package", spec: "\\\\uncsrv9\\share\\lib", via: "package.json dependencies (file:)", from: "package.json", unc: true },
    ]);
    else expect(result.edges).toEqual([]);
  });

  it("never reads a UNC root", () => {
    const { io, calls } = spyIO();
    expect(declaredEdges("\\\\uncsrv9\\share\\app", io)).toEqual({ edges: [], incomplete: true });
    expect(calls).toEqual([]);
  });
});

describe("via vocabulary (SD-P3c-5)", () => {
  it("is fixed, frozen and duplicate-free, and names the plan's labels", () => {
    expect(Object.isFrozen(EDGE_VIAS)).toBe(true);
    expect(new Set(EDGE_VIAS).size).toBe(EDGE_VIAS.length);
    for (const label of [
      "package.json dependencies (file:)",
      "package.json devDependencies (link:)",
      "package.json resolutions (portal:)",
      "package.json pnpm.overrides (file:)",
      "tsconfig extends",
      "tsconfig references",
      "tsconfig paths",
      "tsconfig baseUrl",
      "tsconfig rootDirs",
      "tsconfig typeRoots",
      "tsconfig include",
      "tsconfig files",
      "python editable install",
      "go.mod replace",
      "go.work use",
      "go.work replace",
    ]) {
      expect(EDGE_VIAS).toContain(label);
    }
    expect(EDGE_VIAS.length).toBe(7 * 3 + 8 + 4);
  });

  it("every edge's via is in EDGE_VIAS and its from is the declaring file relative to the root, '/' separated", () => {
    writeJson("package.json", { workspaces: ["packages/*"], dependencies: { a: "portal:../lib-a" } });
    writeJson("packages/p/package.json", { dependencies: { b: "link:../../../lib-b" } });
    writeJson("tsconfig.json", { compilerOptions: { baseUrl: "../base" } });
    write("go.mod", "replace a => ../go-a\n");
    write("go.work", "use ../go-w\n");
    write(".venv/pyvenv.cfg", "");
    write(".venv/Lib/site-packages/x.egg-link", "../../../../py-x\n.\n");
    const result = declaredEdges(app);
    expect(result.edges.length).toBe(6);
    for (const edge of result.edges) {
      expect(EDGE_VIAS).toContain(edge.via);
      expect(edge.from).not.toContain("\\");
      expect(fs.existsSync(path.join(app, ...edge.from.split("/")))).toBe(true);
    }
    expect(result.edges.map((edge) => edge.from)).toContain("packages/p/package.json");
  });
});

describe("edge admission (P3c.2b)", () => {
  // Canonical spellings (os.tmpdir() may hold a short or linked component): real paths are compared as text.
  let root: string;
  let rParent: string;
  let rApp: string;
  let lib: string;
  let outsideLib: string;
  /** Every link made here, removed itself (never recursed through) before the temporary tree. */
  const links: string[] = [];

  const via = (kind: DeclaredEdge["kind"]) => (kind === "python" ? "python editable install" : "package.json dependencies (file:)");

  /** A declared edge of `rApp` (or of `ctx.root`), declared in `from`. */
  function edge(spec: string, kind: DeclaredEdge["kind"] = "package", from = "package.json"): DeclaredEdge {
    return { kind, spec, via: via(kind), from };
  }

  /** A git repository found without git: a `.git` directory. */
  function gitRepo(dir: string): string {
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  }

  /** A directory link: a junction on win32, a dir symlink on posix. */
  function link(target: string, at: string): void {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
    links.push(at);
  }

  function location(worktree: string): RepoLocation {
    return { repository: worktree, name: path.basename(worktree), worktree, branch: "main", head: null, worktrees: [] };
  }

  /** The edge admission of `rApp`: parent `rParent`, depth 1, no exclude; nothing is another worktree of W unless said. */
  function context(opts: { root?: string; workingSet?: RepoLocation[]; sameRepository?: (top: string) => boolean } = {}): EdgeContext {
    return {
      ...admissionContext({ parents: [rParent], depth: 1, exclude: [] }, opts.workingSet ?? []),
      root: opts.root ?? rApp,
      sameRepository: opts.sameRepository ?? (() => false),
    };
  }

  type DepCall = { op: string; p: string };

  /** The default dependency primitives, every call recorded in order (the IO spy). */
  function spyDependencyIO(): { io: DependencyIO; calls: DepCall[] } {
    const calls: DepCall[] = [];
    const record = <T>(op: string, p: string, run: () => T): T => {
      calls.push({ op, p });
      return run();
    };
    const io: DependencyIO = {
      lstat: (p) => record("lstat", p, () => fs.lstatSync(p)),
      readlink: (p) => record("readlink", p, () => fs.readlinkSync(p)),
      realpath: (p) => record("realpath", p, () => fs.realpathSync.native(p)),
      gitTop: (dir, ceiling) => record("gitTop", dir, () => gitTopOf(dir, ceiling)),
      stat: (p) => record("stat", p, () => defaultEdgeIO.stat(p)),
      readFile: (p) => record("readFile", p, () => defaultEdgeIO.readFile(p)),
      readdir: (dir, max) => record("readdir", dir, () => defaultEdgeIO.readdir(dir, max)),
    };
    return { io, calls };
  }

  /** Whether a call touched `at` or anything inside it (compared as text). */
  const touched = (calls: DepCall[], at: string): boolean => {
    const key = path.resolve(at).toLowerCase();
    return calls.some((call) => {
      const p = path.resolve(call.p).toLowerCase();
      return p === key || p.startsWith(`${key}${path.sep}`);
    });
  };

  beforeEach(() => {
    root = fs.realpathSync.native(tmp);
    rParent = path.join(root, "parent");
    rApp = gitRepo(path.join(rParent, "app"));
    lib = gitRepo(path.join(rParent, "lib-b"));
    fs.mkdirSync(path.join(lib, "src"), { recursive: true });
    outsideLib = gitRepo(path.join(root, "outside", "lib-x"));
  });

  afterEach(() => {
    for (const at of links.splice(0)) if (fs.existsSync(at)) fs.rmSync(at, { recursive: false, force: true });
  });

  it("a target below a parent resolves to its git top level and is admitted", () => {
    const { io } = spyDependencyIO();
    const ctx = context();
    expect(resolveEdgeTarget(edge("../lib-b"), ctx, rApp, io)).toEqual({ status: "admitted", top: lib });
    expect(resolveEdgeTarget(edge("../lib-b/src"), ctx, rApp, io)).toEqual({ status: "admitted", top: lib });
    // The spec resolves against the declaring file's directory.
    expect(resolveEdgeTarget(edge("../../../lib-b", "package", "packages/p/package.json"), ctx, rApp, io)).toEqual({ status: "admitted", top: lib });
    // A working-set worktree outside every parent is admitted as well (F4).
    const withWorkingSet = context({ workingSet: [location(outsideLib)] });
    expect(resolveEdgeTarget(edge("../../outside/lib-x"), withWorkingSet, rApp, io)).toEqual({ status: "admitted", top: outsideLib });
  });

  it("a target outside every parent and every working-set worktree, or a UNC spec, is unadmitted, named from the text, with no filesystem call", () => {
    const { io, calls } = spyDependencyIO();
    const ctx = context();
    expect(resolveEdgeTarget(edge("../../outside/lib-x"), ctx, rApp, io)).toEqual({ status: "unadmitted", at: outsideLib, name: "lib-x" });
    expect(resolveEdgeTarget({ ...edge("\\\\server\\share\\lib-u"), unc: true }, ctx, rApp, io))
      .toEqual({ status: "unadmitted", at: "\\\\server\\share\\lib-u", name: "lib-u" });
    expect(resolveEdgeTarget(edge("//server/share/lib-v"), ctx, rApp, io)).toEqual({ status: "unadmitted", at: "//server/share/lib-v", name: "lib-v" });
    expect(calls).toEqual([]);
  });

  it("a junction below a parent that leads out of the parents is unadmitted, its top level never looked up", () => {
    const escape = path.join(rParent, "escape");
    link(outsideLib, escape);
    const { io, calls } = spyDependencyIO();
    expect(resolveEdgeTarget(edge("../escape"), context(), rApp, io)).toEqual({ status: "unadmitted", at: escape, name: "escape" });
    expect(calls).toEqual([{ op: "realpath", p: escape }]);
  });

  it("a missing dist below an admitted repository resolves through the nearest existing ancestor below the parent", () => {
    const { io, calls } = spyDependencyIO();
    expect(resolveEdgeTarget(edge("../lib-b/dist/index.js"), context(), rApp, io)).toEqual({ status: "admitted", top: lib });
    expect(calls.filter((call) => call.op === "realpath").map((call) => call.p))
      .toEqual([path.join(lib, "dist", "index.js"), path.join(lib, "dist"), lib]);
    // Nothing exists below the parent: unadmitted, and the parent itself is never realpath'ed.
    const missing = spyDependencyIO();
    const notCloned = path.join(rParent, "not-cloned");
    expect(resolveEdgeTarget(edge("../not-cloned"), context(), rApp, missing.io)).toEqual({ status: "unadmitted", at: notCloned, name: "not-cloned" });
    expect(missing.calls).toEqual([{ op: "realpath", p: notCloned }]);
  });

  it("a target at, inside or above W's top level is skipped with no filesystem call", () => {
    const { io, calls } = spyDependencyIO();
    const ctx = context();
    for (const spec of [".", "./packages/p", "../app/src", ".."]) {
      expect(resolveEdgeTarget(edge(spec), ctx, rApp, io)).toEqual({ status: "skipped", reason: "insideW" });
    }
    // W below its top level: a sibling package of W is still W's repository.
    const nested = context({ root: path.join(rApp, "packages", "p") });
    expect(resolveEdgeTarget(edge("../q"), nested, rApp, io)).toEqual({ status: "skipped", reason: "insideW" });
    expect(calls).toEqual([]);
  });

  it("another worktree of W's repository is skipped as sameRepository", () => {
    // `<parent>/app-wt` is a linked worktree of `<parent>/app`: its `.git` file names a git directory whose common dir is app's.
    const gitDir = path.join(rApp, ".git", "worktrees", "app-wt");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
    const appWt = path.join(rParent, "app-wt");
    fs.mkdirSync(appWt, { recursive: true });
    fs.writeFileSync(path.join(appWt, ".git"), `gitdir: ${gitDir}\n`);

    const { io } = spyDependencyIO();
    const ctx = context({ sameRepository: (top) => top === appWt });
    expect(resolveEdgeTarget(edge("../app-wt"), ctx, rApp, io)).toEqual({ status: "skipped", reason: "sameRepository" });

    // Through dependencyTargets, "same repository" is read from the git common directories (QA-1 F11).
    fs.writeFileSync(path.join(rApp, "package.json"), JSON.stringify({ dependencies: { wt: "file:../app-wt", b: "file:../lib-b" } }));
    const result = dependencyTargets(rApp, admissionContext({ parents: [rParent], depth: 1, exclude: [] }, []), io);
    expect(result.targets).toEqual([{ origin: "edge", at: lib, via: "package.json dependencies (file:)", from: "package.json" }]);
  });

  it("a path with a node_modules segment is skipped with no filesystem call", () => {
    const { io, calls } = spyDependencyIO();
    const ctx = context();
    expect(resolveEdgeTarget(edge("../lib-b/node_modules/x"), ctx, rApp, io)).toEqual({ status: "skipped", reason: "nodeModules" });
    expect(resolveEdgeTarget(edge("../lib-b/Node_Modules/x"), ctx, rApp, io)).toEqual({ status: "skipped", reason: "nodeModules" });
    expect(calls).toEqual([]);
  });

  it("a Python path line outside every parent is dropped silently; below a parent it is admitted", () => {
    const { io, calls } = spyDependencyIO();
    const ctx = context();
    const pth = ".venv/Lib/site-packages/x.pth";
    expect(resolveEdgeTarget(edge(outsideLib, "python", pth), ctx, rApp, io)).toEqual({ status: "skipped", reason: "pythonOutside" });
    expect(resolveEdgeTarget({ ...edge("\\\\server\\share\\py", "python", pth), unc: true }, ctx, rApp, io))
      .toEqual({ status: "skipped", reason: "pythonOutside" });
    expect(calls).toEqual([]);
    expect(resolveEdgeTarget(edge(lib, "python", pth), ctx, rApp, io)).toEqual({ status: "admitted", top: lib });
  });

  it("dependencyTargets: link targets first, then edge targets once per top, at most EDGE_UNADMITTED_NAMES_MAX unadmitted names", () => {
    const libC = gitRepo(path.join(rParent, "lib-c"));
    link(libC, path.join(rApp, "node_modules", "lib-c"));
    const outside = Array.from({ length: EDGE_UNADMITTED_NAMES_MAX + 2 }, (_, i) => `o${i}`);
    fs.writeFileSync(path.join(rApp, "package.json"), JSON.stringify({
      dependencies: {
        b: "file:../lib-b",
        "b-src": "file:../lib-b/src", // Same top as b: one target.
        c: "file:../lib-c", // Already a link target: one target.
        self: "file:./packages/p", // Inside W: skipped.
        ...Object.fromEntries(outside.map((name) => [name, `file:../../outside/${name}`])),
      },
    }));
    const { io, calls } = spyDependencyIO();
    const result = dependencyTargets(rApp, admissionContext({ parents: [rParent], depth: 1, exclude: [] }, []), io);

    expect(result.targets[0]).toEqual({ origin: "link", at: libC });
    expect(result.targets.slice(1).every((target) => target.origin === "edge")).toBe(true);
    const edges = result.targets.slice(1);
    expect(edges.filter((target) => !("fixed" in target))).toEqual([
      { origin: "edge", at: lib, via: "package.json dependencies (file:)", from: "package.json" },
    ]);
    const unadmitted = edges.filter((target) => "fixed" in target);
    expect(unadmitted).toHaveLength(EDGE_UNADMITTED_NAMES_MAX);
    for (const target of unadmitted) {
      expect(target).toMatchObject({ fixed: "unadmitted", via: "package.json dependencies (file:)", from: "package.json" });
      expect(outside).toContain("name" in target ? target.name : undefined);
      expect(target.at).toBe(path.join(root, "outside", "name" in target ? target.name : ""));
    }
    expect(result.unadmittedMore).toBe(2);
    expect(result.incomplete).toBe(false);
    // Text first: nothing outside the parents was touched.
    expect(touched(calls, path.join(root, "outside"))).toBe(false);
  });
});
