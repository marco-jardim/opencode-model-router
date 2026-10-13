/**
 * src/verify/edges.ts
 *
 * Cross-repo P3c.1 (docs/design/cross-repo-phase3-plan.md, item (c), SD-P3c-1..10, owner decision D24 = Tier A): the dependency
 * edges a root DECLARES outside `node_modules`, read as text (I11) and never evaluated (SD-P3c-7). Nothing here touches git,
 * realpaths a target or decides admission: a spec is returned as written (relative to the declaring file's directory), and the
 * caller admits it (P3c.2b). Tier A only:
 * - A1 `package.json` `file:`/`link:`/`portal:` specs (root and workspace manifests);
 * - A2 `tsconfig.json`, `tsconfig.*.json`, `jsconfig.json` (root) and each workspace `tsconfig.json`, as JSONC;
 * - A3 Python editable installs in an in-repo venv (`.venv`/`venv` with `pyvenv.cfg`);
 * - A4 Go `replace … => <local path>` in `go.mod`/`go.work` and `go.work` `use`.
 * Bounded (SD-P3c-4): every file is stat'ed before it is read, at most `EDGE_FILE_BYTES_MAX` bytes; at most `EDGE_FILES_MAX`
 * files and `EDGES_MAX` distinct targets per root; `incomplete` is set when a bound cuts. Malformed files are skipped.
 * Not read (outside Tier A or later tiers): `pnpm-workspace.yaml` (workspaces come from `package.json` only, perimeter.ts rules),
 * bare-path dependency specs without a protocol (`"../x"`), tsconfig outputs (`outDir`, `declarationDir`, `tsBuildInfoFile`).
 */
import { opendirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { perimeterKey } from "./git-top";

/** SD-P3c-4: a file larger than this is skipped (and the result is `incomplete`). */
export const EDGE_FILE_BYTES_MAX = 1024 * 1024;
/** SD-P3c-4: at most this many files are read per root (every manifest, tsconfig, venv and Go file counts). */
export const EDGE_FILES_MAX = 128;
/** SD-P3c-4: at most this many distinct targets per root. */
export const EDGES_MAX = 64;
/**
 * QA-1 M1: a spec longer than this is never walked, and is unadmitted (perimeter.ts `resolveEdgeTarget`, which re-exports it).
 * QA-2 F-2: such a spec never takes its target's place either: a later spelling of the same target is still kept.
 */
export const EDGE_SPEC_MAX = 4096;
/** SD-P3c-4: at most this many workspace packages are read per root. */
export const EDGE_WORKSPACES_MAX = 64;
/** SD-P3c-4: a tsconfig `extends` chain is followed at most this deep, and only inside the declaring root. */
export const EDGE_EXTENDS_DEPTH_MAX = 4;
/** QA-1 M2: at most this many entries of one tsconfig `extends` array are read (each may cost a stat); past it, `incomplete`. */
export const EDGE_EXTENDS_ENTRIES_MAX = 8;
/** QA-1 M2: at most this many `workspaces` patterns are read (each wildcard one costs a directory listing); past it, `incomplete`. */
export const EDGE_WORKSPACE_PATTERNS_MAX = 64;
/** QA-1 M2: the directory entries the `workspaces` wildcard listings read in total, per root; past it, `incomplete`. */
export const EDGE_WORKSPACE_ENTRIES_MAX = 8000;
/** A2: at most this many root `tsconfig.*.json` variants are read. */
export const EDGE_TSCONFIG_VARIANTS_MAX = 8;
/** A1: npm `overrides` string leaves are read at most this deep. */
export const EDGE_OVERRIDES_DEPTH_MAX = 4;
/** SD-P3c-4: one site-packages listing reads at most this many entries. */
export const SITE_PACKAGES_ENTRIES_MAX = 4000;
/** SD-P3c-4: at most this many `.pth`, editable finder and `.egg-link` files are read. */
export const SITE_PACKAGES_FILES_MAX = 64;

/** The bounds of one `declaredEdges` call (SD-P3c-4); injectable for tests. */
export interface EdgeLimits {
  readonly bytes: number;
  readonly files: number;
  readonly edges: number;
  readonly workspaces: number;
  readonly extendsDepth: number;
  readonly tsconfigVariants: number;
  /** One directory listing (site-packages, the root, a workspace wildcard's parent, a venv's `lib`) reads at most this many names. */
  readonly entries: number;
  readonly siteFiles: number;
}

/** The default `declaredEdges` bounds. */
export const EDGE_LIMITS: EdgeLimits = Object.freeze({
  bytes: EDGE_FILE_BYTES_MAX,
  files: EDGE_FILES_MAX,
  edges: EDGES_MAX,
  workspaces: EDGE_WORKSPACES_MAX,
  extendsDepth: EDGE_EXTENDS_DEPTH_MAX,
  tsconfigVariants: EDGE_TSCONFIG_VARIANTS_MAX,
  entries: SITE_PACKAGES_ENTRIES_MAX,
  siteFiles: SITE_PACKAGES_FILES_MAX,
});

/** Tier A edge kinds (D24): A1 `package`, A2 `tsconfig`, A3 `python`, A4 `go`. */
export type EdgeKind = "package" | "tsconfig" | "python" | "go";

/** A1: the `package.json` fields read, `pnpm.overrides` spelled as a path. */
export const PACKAGE_EDGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "overrides",
  "resolutions",
  "pnpm.overrides",
] as const;
export type PackageEdgeField = (typeof PACKAGE_EDGE_FIELDS)[number];

/** A1: the path protocols read (`file://` URLs count as `file:`). */
export const PACKAGE_EDGE_PROTOCOLS = ["file:", "link:", "portal:"] as const;
export type PackageEdgeProtocol = (typeof PACKAGE_EDGE_PROTOCOLS)[number];

/** A2: the tsconfig/jsconfig keys read. */
export const TSCONFIG_EDGE_KEYS = ["extends", "references", "paths", "baseUrl", "rootDirs", "typeRoots", "include", "files"] as const;
export type TsconfigEdgeKey = (typeof TSCONFIG_EDGE_KEYS)[number];

/** SD-P3c-5: the fixed vocabulary an edge is described with (never the raw spec). */
export type EdgeVia =
  | `package.json ${PackageEdgeField} (${PackageEdgeProtocol})`
  | `tsconfig ${TsconfigEdgeKey}`
  | "python editable install"
  | "go.mod replace"
  | "go.work use"
  | "go.work replace";

/** SD-P3c-5: every `via` label, in a fixed order. */
export const EDGE_VIAS: readonly EdgeVia[] = Object.freeze([
  ...PACKAGE_EDGE_FIELDS.flatMap(field => PACKAGE_EDGE_PROTOCOLS.map(protocol => `package.json ${field} (${protocol})` as const)),
  ...TSCONFIG_EDGE_KEYS.map(key => `tsconfig ${key}` as const),
  "python editable install" as const,
  "go.mod replace" as const,
  "go.work use" as const,
  "go.work replace" as const,
]);

/** One declared dependency edge of a root. */
export interface DeclaredEdge {
  readonly kind: EdgeKind;
  /**
   * The target as declared, a path to resolve against the declaring file's directory (`path.dirname(path.join(root, from))`):
   * the protocol stripped, a `file://` URL converted, a tsconfig glob cut to its static prefix and joined to `baseUrl`. Never
   * echoed to users (SD-P3c-5).
   */
  readonly spec: string;
  readonly via: EdgeVia;
  /** The declaring file, relative to the root, "/" separated. */
  readonly from: string;
  /** The spec names a UNC share or a device path: it was never resolved, and is never admitted (SD-P3c-3). */
  readonly unc?: true;
}

/** The result of `declaredEdges`: `incomplete` when a bound cut the reading. */
export interface DeclaredEdges {
  readonly edges: DeclaredEdge[];
  readonly incomplete: boolean;
}

/** The file primitives `declaredEdges` uses, synchronous (it runs at dispatch start, F9); injectable for tests. */
export interface EdgeIO {
  /** Follows links; throws when absent. */
  readonly stat: (p: string) => { isFile(): boolean; isDirectory(): boolean; readonly size: number };
  readonly readFile: (p: string) => string;
  /** The names in `dir`, in directory order, at most `max + 1` of them (so a caller sees a cut); throws when unreadable. */
  readonly readdir: (dir: string, max: number) => string[];
}

function boundedNames(dir: string, max: number): string[] {
  const handle = opendirSync(dir);
  try {
    const names: string[] = [];
    for (let entry = handle.readSync(); entry !== null && names.length <= max; entry = handle.readSync()) names.push(entry.name);
    return names;
  } finally {
    handle.closeSync();
  }
}

/** The default `EdgeIO`: `node:fs`, synchronous. */
export const defaultEdgeIO: EdgeIO = {
  stat: (p) => statSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  readdir: (dir, max) => boundedNames(dir, max),
};

/**
 * SD-P3c-7: JSON with comments (tsconfig, jsconfig), parsed without evaluating anything: a leading BOM is dropped, `//` and
 * `/* … *\/` comments outside strings are removed, a trailing comma before `}` or `]` is removed, then `JSON.parse`. Invalid
 * text (an unterminated comment or string included) gives `undefined`.
 */
export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  /** The index in `out` of a comma that is, so far, the last significant token. */
  let comma = -1;
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      if (i >= n) return undefined;
      i++;
      out.push(text.slice(start, i));
      comma = -1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return undefined;
      out.push(" ");
      i = end + 2;
      continue;
    }
    if ((c === "}" || c === "]") && comma >= 0) out[comma] = "";
    if (c === ",") comma = out.length;
    else if (!/\s/.test(c)) comma = -1;
    out.push(c);
    i++;
  }
  try {
    return JSON.parse(out.join(""));
  } catch {
    return undefined;
  }
}

/** A spec naming a UNC share or a device path (`\\server\share`, `\\?\…`, `//server/share`): never resolved (QA-1 #3). */
export function isUncSpec(spec: string): boolean {
  return /^[\\/]{2}/.test(spec);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function insideOrEqual(child: string, parent: string): boolean {
  const c = perimeterKey(child);
  const p = perimeterKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** An absolute spelling on either platform: `/x`, `\x`, `C:\x`, `C:/x`, UNC. */
function isAbsoluteSpec(spec: string): boolean {
  return path.isAbsolute(spec) || /^[\\/]/.test(spec) || /^[A-Za-z]:[\\/]/.test(spec);
}

/** A relative (`./`, `../`, `.`, `..`) or absolute spelling, not a package name. */
function isPathSpec(spec: string): boolean {
  return /^\.\.?(?:[\\/]|$)/.test(spec) || isAbsoluteSpec(spec);
}

/**
 * The `workspaces` patterns of a `package.json` (an array, or `{ packages: [...] }`), strings only. Shared with the consumer
 * discovery in perimeter.ts.
 */
export function workspacePatterns(manifest: Record<string, unknown>): string[] {
  const field = manifest.workspaces;
  const packages = typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as { packages?: unknown }).packages
    : field;
  return Array.isArray(packages) ? packages.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * One code unit as a case-insensitive, non-unicode regular expression compares it (ECMA-262 Canonicalize): its upper case
 * when that is one code unit, and not an ASCII one for a non-ASCII unit; else itself.
 */
function foldUnit(unit: string): string {
  const upper = unit.toUpperCase();
  return upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
}

/** `text` with every code unit folded by `foldUnit` (one unit each, so the length and every `*` position are kept). */
function foldUnits(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldUnit(text.charAt(i));
  return out;
}

/**
 * Cross-repo P3c QA-2 F-1: a directory entry name is at most 255 code units (posix NAME_MAX, NTFS's 255 UTF-16 units), so a
 * `workspaces` segment with more literal (non-`*`) characters matches no entry, and its directory is never listed.
 */
export const WORKSPACE_SEGMENT_LITERALS_MAX = 255;

/** A one-segment `workspaces` pattern prepared once (QA-2 F-1): whether one directory entry name matches it. */
export type WorkspaceSegmentMatcher = (name: string) => boolean;

/**
 * The matcher of `pattern`, the pattern scanned once (separator check, literal count, case folding); `undefined` when it holds
 * a separator or more than `maxLiterals` literal characters (it matches nothing). Each name is folded once per call.
 */
function compileSegment(pattern: string, ignoreCase: boolean, maxLiterals: number): WorkspaceSegmentMatcher | undefined {
  if (/[\\/]/.test(pattern)) return undefined;
  let literals = 0;
  for (let i = 0; i < pattern.length; i++) if (pattern.charCodeAt(i) !== 42) literals += 1;
  if (literals > maxLiterals) return undefined;
  const folded = ignoreCase ? foldUnits(pattern) : pattern;
  return (name: string): boolean => {
    if (literals > name.length || /[\\/]/.test(name)) return false;
    const subject = ignoreCase ? foldUnits(name) : name;
    let p = 0;
    let n = 0;
    let star = -1;
    let mark = 0;
    while (n < subject.length) {
      if (p < folded.length && folded.charCodeAt(p) === 42) {
        star = p;
        p += 1;
        mark = n;
      } else if (p < folded.length && folded.charCodeAt(p) === subject.charCodeAt(n)) {
        p += 1;
        n += 1;
      } else if (star >= 0) {
        // The last `*` takes one more character (never a separator: `name` holds none), and the rest is matched again.
        p = star + 1;
        mark += 1;
        n = mark;
      } else {
        return false;
      }
    }
    while (p < folded.length && folded.charCodeAt(p) === 42) p += 1;
    return p === folded.length;
  };
}

/**
 * Cross-repo P3c QA-2 F-1: the matcher of the one-segment `workspaces` pattern `pattern` (`workspaceSegmentMatches` rules),
 * prepared once for a whole directory listing; `undefined` when no directory entry can match it (a separator, or more than
 * `WORKSPACE_SEGMENT_LITERALS_MAX` literal characters), so the caller lists nothing.
 */
export function prepareWorkspaceSegment(
  pattern: string,
  ignoreCase: boolean = process.platform === "win32",
): WorkspaceSegmentMatcher | undefined {
  return compileSegment(pattern, ignoreCase, WORKSPACE_SEGMENT_LITERALS_MAX);
}

/**
 * Cross-repo P3c QA-1 C1: whether the directory entry `name` matches the one-segment `workspaces` pattern `pattern`, whose only
 * wildcard is `*` (`**` is one), a run of any characters but a separator; case-insensitive on win32 (`ignoreCase`), as the
 * regular expression it replaces. No regular expression is built from repository text: two pointers, the last `*` the only
 * backtracking point, so the time is at most quadratic in `name` (a directory entry) and linear in `pattern`. A pattern holding
 * a separator matches nothing (a segment never holds one). One-shot: a listing prepares the pattern once
 * (`prepareWorkspaceSegment`, QA-2 F-1).
 */
export function workspaceSegmentMatches(pattern: string, name: string, ignoreCase: boolean = process.platform === "win32"): boolean {
  return compileSegment(pattern, ignoreCase, Number.POSITIVE_INFINITY)?.(name) ?? false;
}

/** The directories of one `workspaces` pattern, whether the listing was cut at `entries` names, and how many names it read. */
function matchWorkspace(
  w: string,
  pattern: string,
  limit: number,
  io: EdgeIO,
  entries: number,
): { dirs: string[]; cut: boolean; listed: number } {
  if (pattern.startsWith("!") || path.isAbsolute(pattern) || /^[\\/]/.test(pattern)) return { dirs: [], cut: false, listed: 0 };
  const segments = pattern.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return { dirs: [], cut: false, listed: 0 };
  const last = segments[segments.length - 1] ?? "";
  const head = segments.slice(0, -1);
  if (head.some((segment) => segment.includes("*"))) return { dirs: [], cut: false, listed: 0 };
  if (!last.includes("*")) return { dirs: [path.join(w, ...segments)], cut: false, listed: 0 };
  // QA-2 F-1: the segment is prepared once, before the listing; one no entry name can match is not listed at all.
  const matches = prepareWorkspaceSegment(last);
  if (matches === undefined) return { dirs: [], cut: false, listed: 0 };
  const base = path.join(w, ...head);
  let children: string[];
  try {
    children = io.readdir(base, entries);
  } catch {
    return { dirs: [], cut: false, listed: 0 };
  }
  // Code-unit order: fs.readdir's (libuv sorts with strcmp) on posix, and NTFS order for same-case names on win32.
  const dirs = children
    .slice(0, entries)
    .sort(byCodeUnit)
    .filter((child) => !child.startsWith(".") && child !== "node_modules" && matches(child))
    .slice(0, limit)
    .map((child) => path.join(base, child));
  return { dirs, cut: children.length > entries, listed: Math.min(children.length, entries + 1) };
}

/**
 * The synchronous twin of perimeter.ts `workspaceDirs` (same rules): the directories of one `workspaces` pattern, inside W
 * only: literal segments, and a wildcard (`*`, `**`) in the last segment only, matched one level deep. Negations, absolute
 * paths, `..` and inner wildcards give none. At most `limit` directories from a wildcard.
 */
export function workspaceDirsSync(w: string, pattern: string, limit: number, io: EdgeIO = defaultEdgeIO): string[] {
  return matchWorkspace(w, pattern, limit, io, SITE_PACKAGES_ENTRIES_MAX).dirs;
}

const TARBALL = /\.(?:tgz|tar\.gz|tar)$/i;

/** A1: the path of a `file:`/`link:`/`portal:` spec (a `file://` URL converted), or `undefined` for every other spec. */
function packagePathSpec(raw: string): { protocol: PackageEdgeProtocol; path: string } | undefined {
  const spec = raw.trim();
  const match = /^(file|link|portal):/.exec(spec);
  if (match === null) return undefined;
  const protocol = `${match[1]}:` as PackageEdgeProtocol;
  let target = spec.slice(match[0].length);
  if (protocol === "file:" && target.startsWith("//")) {
    try {
      target = fileURLToPath(spec);
    } catch {
      return undefined;
    }
  }
  if (target.trim() === "" || TARBALL.test(target)) return undefined;
  return { protocol, path: target };
}

/** A2: a glob's static prefix: the directory part before the first `*` or `?` (`../lib/*` → `../lib/`, `*` → `.`). */
function staticPrefix(glob: string): string {
  const wild = glob.search(/[*?]/);
  if (wild < 0) return glob;
  const head = glob.slice(0, wild);
  const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
  return cut < 0 ? "." : head.slice(0, cut + 1);
}

/** A2: a `paths` prefix against `baseUrl` (itself relative to the declaring file), or the prefix alone without one. */
function joinBaseUrl(baseUrl: string | undefined, prefix: string): string {
  if (baseUrl === undefined || isAbsoluteSpec(prefix)) return prefix;
  if (isUncSpec(baseUrl)) return `${baseUrl.replace(/[\\/]+$/, "")}/${prefix}`;
  return path.join(baseUrl, prefix);
}

/** A4: a line without its `//` comment (a `//` inside a quoted or raw string is kept). */
function stripGoComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "`") quote = c;
    else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

/** A4: the tokens of a directive's arguments: interpreted (`"…"`) and raw (`` `…` ``) strings, or bare words. */
function goTokens(args: string): string[] {
  const tokens: string[] = [];
  for (const match of args.matchAll(/"((?:\\.|[^"\\])*)"|`([^`]*)`|(\S+)/g)) {
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : (match[2] ?? match[3] ?? ""));
  }
  return tokens;
}

/** A4: a local replacement path (`./`, `../`, `/`, a drive); anything else is a module path. */
function isLocalGoPath(token: string): boolean {
  return /^\.\.?(?:[\\/]|$)/.test(token) || isAbsoluteSpec(token);
}

/** A3: one `'…'` or `"…"` Python string literal's text, with `\\`, `\'` and `\"` unescaped. */
function pythonString(body: string): string {
  return body.replace(/\\(['"\\])/g, "$1");
}

/** A3: the files of a site-packages directory that declare editable installs. */
const SITE_FILE = /(?:\.pth|\.egg-link)$|^__editable___.*_finder\.py$/i;

const LINE_TERMINATORS = "\n\r\u2028\u2029";
const WHITESPACE = /\s/;

/**
 * A3, QA-1 M2: the body of an editable finder's `MAPPING` dict literal, as the multiline regular expression
 * `^MAPPING\s*(?::[^=\n]*)?=\s*\{([^}]*)\}` finds it first (group 1), in linear time: each `MAPPING` at a line start is parsed
 * forward once; a `MAPPING` whose annotation starts before where the previous one's stopped fails as that one did, and once
 * no `}` follows a `{` none follows any later one either. Undefined when there is none.
 */
export function finderMappingBody(text: string): string | undefined {
  let stopped = -1; // Where the last annotation scan stopped: a later scan starting before it ends there too, as that one did.
  for (let at = text.indexOf("MAPPING"); at >= 0; at = text.indexOf("MAPPING", at + 7)) {
    if (at > 0 && !LINE_TERMINATORS.includes(text[at - 1]!)) continue;
    let i = at + 7;
    while (i < text.length && WHITESPACE.test(text[i]!)) i += 1;
    if (text[i] === ":") {
      if (i < stopped) continue;
      i += 1;
      while (i < text.length && text[i] !== "=" && text[i] !== "\n") i += 1;
      stopped = i;
    }
    if (text[i] !== "=") continue;
    i += 1;
    while (i < text.length && WHITESPACE.test(text[i]!)) i += 1;
    if (text[i] !== "{") continue;
    const close = text.indexOf("}", i + 1);
    if (close < 0) return undefined; // No `}` after this `{`: none after a later one either.
    return text.slice(i + 1, close);
  }
  return undefined;
}

/**
 * A3, QA-1 M2: the values of the `'key': 'value'` pairs of a finder `MAPPING` body (each value's text, still escaped), in
 * linear time. It replaces the regular expression `(['"])(?:\\.|(?!\1)[^\\])*\1\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2`, which
 * retried at every quote and so was quadratic on `'\'\'\'…`: string literals are read left to right as Python reads them, each
 * once (a quote inside a literal opens none); a literal followed by `:` and another literal is a pair. The two agree on the
 * `repr` text setuptools writes. An unclosed literal ends the reading (the file is no valid Python past it).
 */
export function finderMappingValues(body: string): string[] {
  const values: string[] = [];
  /** The end (after the closing quote) of the string literal opening at `start`, or -1 when it is not closed. */
  const literalEnd = (start: number): number => {
    const quote = body[start];
    for (let i = start + 1; i < body.length; i++) {
      if (body[i] === "\\") i += 1;
      else if (body[i] === quote) return i + 1;
    }
    return -1;
  };
  const isQuote = (c: string | undefined): boolean => c === "'" || c === '"';
  let i = 0;
  while (i < body.length) {
    if (!isQuote(body[i])) {
      i += 1;
      continue;
    }
    const keyEnd = literalEnd(i);
    if (keyEnd < 0) return values; // Unclosed: no valid Python past it.
    let j = keyEnd;
    while (j < body.length && WHITESPACE.test(body[j]!)) j += 1;
    if (body[j] !== ":") {
      i = keyEnd;
      continue;
    }
    j += 1;
    while (j < body.length && WHITESPACE.test(body[j]!)) j += 1;
    if (!isQuote(body[j])) {
      i = j;
      continue;
    }
    const valueEnd = literalEnd(j);
    if (valueEnd < 0) return values;
    values.push(body.slice(j + 1, valueEnd - 1));
    i = valueEnd;
  }
  return values;
}

/**
 * Cross-repo P3c.1 (SD-P3c-1..10, D24): the dependency edges `root` declares outside `node_modules`, Tier A only (see the
 * module comment). Targets lexically inside `root` are not edges and are dropped; the others are de-duplicated (first
 * declaration wins) and capped at `limits.edges`. Synchronous, never throws, never evaluates repository code; every file is
 * stat'ed (size checked) before it is read, and read at most once.
 */
export function declaredEdges(root: string, io: EdgeIO = defaultEdgeIO, limits: EdgeLimits = EDGE_LIMITS): DeclaredEdges {
  const edges: DeclaredEdge[] = [];
  if (isUncSpec(root)) return { edges, incomplete: true }; // A UNC root is never read.
  const base = path.resolve(root);
  const targets = new Set<string>();
  const seen = new Set<string>();
  let files = 0;
  let incomplete = false;

  const isFile = (file: string): boolean => {
    try {
      return io.stat(file).isFile();
    } catch {
      return false;
    }
  };
  const isDirectory = (dir: string): boolean => {
    try {
      return io.stat(dir).isDirectory();
    } catch {
      return false;
    }
  };
  const list = (dir: string): string[] => {
    let names: string[];
    try {
      names = io.readdir(dir, limits.entries);
    } catch {
      return [];
    }
    if (names.length <= limits.entries) return names;
    incomplete = true;
    return names.slice(0, limits.entries);
  };
  /** Stat (size check), then read: `undefined` when absent, not a file, already read, too large or past the file cap. */
  const readText = (file: string): string | undefined => {
    const key = perimeterKey(file);
    if (seen.has(key)) return undefined;
    let size: number;
    try {
      const stat = io.stat(file);
      if (!stat.isFile()) return undefined;
      size = stat.size;
    } catch {
      return undefined;
    }
    seen.add(key);
    if (size > limits.bytes || files >= limits.files) {
      incomplete = true;
      return undefined;
    }
    files += 1;
    let text: string;
    try {
      text = io.readFile(file);
    } catch {
      return undefined;
    }
    if (text.length > limits.bytes) {
      incomplete = true;
      return undefined;
    }
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  };
  const add = (kind: EdgeKind, raw: string, via: EdgeVia, file: string): void => {
    const spec = raw.trim();
    if (spec === "" || spec.includes("\0")) return;
    if (kind === "tsconfig" && spec.includes("${configDir}")) return; // The config's own directory.
    const unc = isUncSpec(spec);
    let key: string;
    if (unc) {
      key = `unc:${spec.replace(/\\/g, "/").toLowerCase()}`;
    } else {
      const target = path.resolve(path.dirname(file), spec);
      if (insideOrEqual(target, base)) return;
      // QA-2 F-2: an overlong spec (never walked, so unadmitted) keys apart: it never drops a later spelling of its target.
      key = spec.length > EDGE_SPEC_MAX ? `overlong:${perimeterKey(target)}` : perimeterKey(target);
    }
    if (targets.has(key)) return;
    if (targets.size >= limits.edges) {
      incomplete = true;
      return;
    }
    targets.add(key);
    const from = path.relative(base, file).split(path.sep).join("/");
    edges.push(unc ? { kind, spec, via, from, unc: true } : { kind, spec, via, from });
  };

  /** A1: one `package.json`; returns the manifest (for `workspaces`). */
  const packageJson = (dir: string): Record<string, unknown> | undefined => {
    const file = path.join(dir, "package.json");
    const text = readText(file);
    if (text === undefined) return undefined;
    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!isRecord(manifest)) return undefined;
    const overrides = (value: unknown, depth: number, out: string[]): string[] => {
      if (!isRecord(value)) return out;
      for (const entry of Object.values(value)) {
        if (typeof entry === "string") out.push(entry);
        else if (isRecord(entry) && depth > 1) overrides(entry, depth - 1, out);
        else if (isRecord(entry)) incomplete = true;
      }
      return out;
    };
    for (const field of PACKAGE_EDGE_FIELDS) {
      const value = field === "pnpm.overrides" ? (isRecord(manifest.pnpm) ? manifest.pnpm.overrides : undefined) : manifest[field];
      const specs = field === "overrides"
        ? overrides(value, EDGE_OVERRIDES_DEPTH_MAX, [])
        : isRecord(value) ? Object.values(value).filter((entry): entry is string => typeof entry === "string") : [];
      for (const spec of specs) {
        const target = packagePathSpec(spec);
        if (target !== undefined) add("package", target.path, `package.json ${field} (${target.protocol})`, file);
      }
    }
    return manifest;
  };

  /** A2: one tsconfig/jsconfig (JSONC), and the `extends` chain inside the root up to `limits.extendsDepth`. */
  const tsconfig = (file: string, depth: number): void => {
    const text = readText(file);
    if (text === undefined) return;
    const config = parseJsonc(text);
    if (!isRecord(config)) return;
    const dir = path.dirname(file);
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    const extendsSpecs = typeof config.extends === "string" ? [config.extends] : strings(config.extends);
    // QA-1 M2: at most EDGE_EXTENDS_ENTRIES_MAX entries, each followed (a stat or two) only while the file cap has room.
    if (extendsSpecs.length > EDGE_EXTENDS_ENTRIES_MAX) incomplete = true;
    for (const spec of extendsSpecs.slice(0, EDGE_EXTENDS_ENTRIES_MAX)) {
      if (!isPathSpec(spec)) continue; // A package name: resolved through node_modules, not an edge.
      add("tsconfig", spec, "tsconfig extends", file);
      if (isUncSpec(spec)) continue;
      const target = path.resolve(dir, spec);
      if (!insideOrEqual(target, base)) continue;
      if (depth >= limits.extendsDepth) {
        incomplete = true;
        continue;
      }
      if (files >= limits.files) {
        // Past the file cap: not stat'ed at all (a cut), unless it was read already (a cycle, no cut).
        if (!seen.has(perimeterKey(target)) && !seen.has(perimeterKey(`${target}.json`))) incomplete = true;
        continue;
      }
      tsconfig(isFile(target) || target.toLowerCase().endsWith(".json") ? target : `${target}.json`, depth + 1);
    }
    for (const reference of Array.isArray(config.references) ? config.references : []) {
      if (isRecord(reference) && typeof reference.path === "string") add("tsconfig", reference.path, "tsconfig references", file);
    }
    const options = isRecord(config.compilerOptions) ? config.compilerOptions : {};
    const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : undefined;
    if (baseUrl !== undefined) add("tsconfig", baseUrl, "tsconfig baseUrl", file);
    if (isRecord(options.paths)) {
      for (const values of Object.values(options.paths)) {
        for (const value of strings(values)) add("tsconfig", joinBaseUrl(baseUrl, staticPrefix(value)), "tsconfig paths", file);
      }
    }
    for (const value of strings(options.rootDirs)) add("tsconfig", value, "tsconfig rootDirs", file);
    for (const value of strings(options.typeRoots)) add("tsconfig", value, "tsconfig typeRoots", file);
    for (const value of strings(config.include)) add("tsconfig", staticPrefix(value), "tsconfig include", file);
    for (const value of strings(config.files)) add("tsconfig", staticPrefix(value), "tsconfig files", file);
  };

  /** A4: `go.mod` (`replace`) or `go.work` (`use`, `replace`), single and block forms. */
  const goFile = (file: string, work: boolean): void => {
    const text = readText(file);
    if (text === undefined) return;
    const directive = (verb: string, args: string): void => {
      if (verb === "replace") {
        const arrow = args.indexOf("=>");
        const target = arrow < 0 ? undefined : goTokens(args.slice(arrow + 2))[0];
        if (target !== undefined && isLocalGoPath(target)) add("go", target, work ? "go.work replace" : "go.mod replace", file);
      } else if (verb === "use" && work) {
        const target = goTokens(args)[0];
        if (target !== undefined) add("go", target, "go.work use", file);
      }
    };
    let block: string | undefined;
    for (const raw of text.split(/\r?\n|\r/)) {
      const line = stripGoComment(raw).trim();
      if (line === "") continue;
      if (block !== undefined) {
        if (line === ")") block = undefined;
        else directive(block, line);
        continue;
      }
      const open = /^(\w+)\s*\($/.exec(line);
      if (open !== null) {
        block = open[1];
        continue;
      }
      const single = /^(\w+)\s+(.+)$/.exec(line);
      if (single !== null) directive(single[1]!, single[2]!);
    }
  };

  /** A3: the editable installs of the root's venv (`.venv`, else `venv`, holding `pyvenv.cfg`). */
  const venv = (): void => {
    const home = [".venv", "venv"].map((name) => path.join(base, name)).find((dir) => isFile(path.join(dir, "pyvenv.cfg")));
    if (home === undefined) return;
    const candidates = [path.join(home, "Lib", "site-packages")];
    for (const name of list(path.join(home, "lib")).filter((entry) => entry.startsWith("python3.")).sort(byCodeUnit)) {
      candidates.push(path.join(home, "lib", name, "site-packages"));
    }
    const site = candidates.find(isDirectory);
    if (site === undefined) return;
    const names = list(site).filter((name) => SITE_FILE.test(name)).sort(byCodeUnit);
    if (names.length > limits.siteFiles) incomplete = true;
    for (const name of names.slice(0, limits.siteFiles)) {
      const file = path.join(site, name);
      const text = readText(file);
      if (text === undefined) continue;
      const lower = name.toLowerCase();
      if (lower.endsWith(".pth")) {
        for (const line of text.split(/\r?\n|\r/)) {
          const entry = line.trim();
          if (entry === "" || entry.startsWith("#") || /^import[ \t]/.test(entry)) continue; // `import` lines run code: skipped.
          add("python", entry, "python editable install", file);
        }
      } else if (lower.endsWith(".egg-link")) {
        add("python", text.split(/\r?\n|\r/)[0] ?? "", "python editable install", file);
      } else {
        // setuptools >= 64 editable finder: the `MAPPING` dict literal, read as text in linear time (QA-1 M2), never executed.
        const mapping = finderMappingBody(text);
        if (mapping === undefined) continue;
        for (const value of finderMappingValues(mapping)) add("python", pythonString(value), "python editable install", file);
      }
    }
  };

  const manifest = packageJson(base);
  tsconfig(path.join(base, "tsconfig.json"), 0);
  tsconfig(path.join(base, "jsconfig.json"), 0);
  const variants = list(base).filter((name) => /^tsconfig\..+\.json$/i.test(name)).sort(byCodeUnit);
  if (variants.length > limits.tsconfigVariants) incomplete = true;
  for (const name of variants.slice(0, limits.tsconfigVariants)) tsconfig(path.join(base, name), 0);
  goFile(path.join(base, "go.mod"), false);
  goFile(path.join(base, "go.work"), true);
  venv();
  if (manifest !== undefined) {
    const dirs = new Map<string, string>();
    // QA-1 M2: at most EDGE_WORKSPACE_PATTERNS_MAX patterns, their listings reading EDGE_WORKSPACE_ENTRIES_MAX names in total.
    const patterns = workspacePatterns(manifest);
    if (patterns.length > EDGE_WORKSPACE_PATTERNS_MAX) incomplete = true;
    let listed = 0;
    for (const pattern of patterns.slice(0, EDGE_WORKSPACE_PATTERNS_MAX)) {
      if (dirs.size > limits.workspaces) break;
      const budget = Math.max(0, Math.min(limits.entries, EDGE_WORKSPACE_ENTRIES_MAX - listed));
      if (budget === 0 && pattern.includes("*")) {
        incomplete = true; // A wildcard needs a listing, and the total is spent; a literal pattern lists nothing.
        continue;
      }
      const found = matchWorkspace(base, pattern, limits.workspaces + 1 - dirs.size, io, budget);
      listed += found.listed;
      if (found.cut) incomplete = true;
      for (const dir of found.dirs) {
        const key = perimeterKey(dir);
        if (key !== perimeterKey(base) && !dirs.has(key)) dirs.set(key, dir);
      }
    }
    if (dirs.size > limits.workspaces) incomplete = true;
    for (const dir of [...dirs.values()].slice(0, limits.workspaces)) {
      packageJson(dir);
      tsconfig(path.join(dir, "tsconfig.json"), 0);
    }
  }
  return { edges, incomplete };
}
