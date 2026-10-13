/**
 * Deterministic risk signal for deferred delegations (plan §1.5-17, Phase 1.6.2).
 *
 * Pure and synchronous: no process, no fs, no network. The caller runs the static planner
 * (`planStaticScoping`) and passes its result in as `scopingPlan`.
 *
 * Paths: classification is done on repo-relative paths (QA-1.6-9). Pass the git root as `root`;
 * absolute paths under it are made relative (after `\` → `/`, case-insensitively for drive-letter
 * roots). CONTRACT (QA-1.6-22): `root` must be the git top-level the paths were resolved against
 * (`git rev-parse --show-toplevel`, real path, as tree.ts uses) — never the delegation cwd: a
 * subdirectory root strips inner segments such as `tests/` and can under-rate. Exposing the
 * top-level on `TreeSnapshot` and passing it here is deferred to 2.1/2.4. An absolute path that cannot be made relative is classified conservatively: it never
 * counts as documentation. Paths are deduplicated (normalised, case-folded for drive-letter paths)
 * before counting (QA-1.6-15).
 *
 * Status: two-character porcelain XY codes count as deleted/renamed when D/R appears in EITHER
 * column (`MD`, `AD`, ` D`, `RM`); other forms (`D`, `deleted`, `R100`) match on the first letter.
 *
 * Callers must not pass `[]` when attribution failed (e.g. `snapshotTree` returned undefined):
 * `[]` means "nothing changed" and is rated low (QA-1.6-14; the unknown case is 2.4's).
 *
 * Fixed table (evaluated in this order; the level is the maximum of every matching row, then the
 * adjustment rows apply once):
 *
 * | #  | Condition                                                         | Level / effect         |
 * |----|-------------------------------------------------------------------|------------------------|
 * | 1  | no changed files                                                  | low, stop              |
 * | 2  | every changed file is documentation (see isDocPath)               | low, stop              |
 * | 3  | 1–5 changed files                                                 | low                    |
 * | 4  | 6–15 changed files                                                | medium                 |
 * | 5  | 16 or more changed files                                          | high                   |
 * | 6  | a test file was deleted, or renamed to a non-test path            | high                   |
 * | 7  | a test file (incl. snapshots) was modified (added, changed, renamed) | medium              |
 * | 8  | a non-test file was deleted or any file was renamed               | medium                 |
 * | 9  | config / lock / CI / test-setup file changed (see isConfigPath)   | medium                 |
 * | 10 | scoping impossible (Unverifiable, S6), or the full suite runs     | medium                 |
 * |    | (FullScopePlan: REASONS.fullScope instead)                        |                        |
 * | 11 | producer tier "fast"                                              | medium                 |
 * | 12 | no reference captured                                             | +1 step (max high)     |
 *
 * Documentation (row 2): not a test or config path, and either a `.md/.mdx/.rst/.adoc` file
 * anywhere, `LICENSE.txt`/`CHANGELOG.txt`, or a doc/asset file type
 * (`md mdx rst txt adoc png jpg jpeg gif svg webp`) under a `docs/` directory.
 *
 * Rows 1–2 short-circuit: nothing else is evaluated. A `NoAffected` scoping plan adds the
 * informational reason REASONS.noAffected without changing the level. Reasons are stable strings
 * (they are shown to the orchestrator) and appear in table order.
 */
import type { ChangedPath, StaticScoping } from "./runner";

export type RiskLevel = "low" | "medium" | "high";
export type ProducerTier = "fast" | "medium" | "heavy" | (string & {});

/**
 * Cross-repo P2e (QA-1 #6): the scoping "plan" of a DoD whose every testsPass check runs the full suite (`scope=full`, or the
 * dispatch's full scope): nothing is planned, so it is neither scoped nor S6. Row 10 then rates it medium with the neutral
 * REASONS.fullScope instead of REASONS.unverifiable.
 */
export interface FullScopePlan {
  readonly fullScope: true;
}
export const FULL_SCOPE_PLAN: FullScopePlan = { fullScope: true };

export interface RiskInput {
  readonly changedFiles: readonly ChangedPath[];
  /** Whether a reference (baseline) exists for this delegation. Only presence matters. */
  readonly reference: boolean;
  readonly producerTier: ProducerTier;
  readonly scopingPlan: StaticScoping | FullScopePlan;
  /** Git root; absolute changed paths are made relative to it before classification. */
  readonly root?: string;
}

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly reasons: string[];
}

export const SMALL_CHANGE_MAX = 5;
export const MEDIUM_CHANGE_MAX = 15;

export const REASONS = {
  empty: "no changes attributed",
  docsOnly: "documentation-only change",
  small: "1-5 files changed",
  mediumCount: "6-15 files changed",
  largeCount: "16 or more files changed",
  testDeleted: "a test file was deleted",
  testModified: "a test file was modified",
  deletedOrRenamed: "files were deleted or renamed",
  configChanged: "config, lock or CI files changed",
  unverifiable: "scoping impossible (S6): the change cannot be verified by scoped tests",
  fullScope: "the full suite runs (scope=full)",
  noAffected: "no affected tests found by static scoping",
  fastTier: "produced by the fast tier",
  noReference: "no reference captured: risk raised one step",
} as const;

const ORDER: readonly RiskLevel[] = ["low", "medium", "high"];

function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

function base(p: string): string {
  const n = norm(p);
  return n.slice(n.lastIndexOf("/") + 1);
}

const DRIVE = /^[a-z]:\//i;

function isAbsolute(n: string): boolean {
  return n.startsWith("/") || DRIVE.test(n);
}

/** Repo-relative form, or null when the path is absolute and not under `root`. */
function relativize(p: string, root: string | undefined): string | null {
  const n = norm(p).replace(/^(\.\/)+/, "");
  if (!isAbsolute(n)) return n;
  if (root === undefined) return null;
  let r = norm(root);
  while (r.endsWith("/")) r = r.slice(0, -1); // linear trim (QA-1.6-32)
  const fold = DRIVE.test(r);
  const nc = fold ? n.toLowerCase() : n;
  const rc = fold ? r.toLowerCase() : r;
  return nc.startsWith(`${rc}/`) ? n.slice(r.length + 1) : null;
}

const DOC_ANYWHERE = /\.(md|mdx|rst|adoc)$/i;
const DOC_UNDER_DOCS = /\.(md|mdx|rst|txt|adoc|png|jpe?g|gif|svg|webp)$/i;

export function isDocPath(p: string): boolean {
  const n = norm(p);
  if (isTestPath(n) || isConfigPath(n)) return false;
  const b = base(n);
  return (
    DOC_ANYWHERE.test(b) ||
    /^(LICENSE|CHANGELOG)\.txt$/i.test(b) ||
    (/(^|\/)docs\//i.test(n) && DOC_UNDER_DOCS.test(b))
  );
}

export function isTestPath(p: string): boolean {
  const n = norm(p);
  const b = base(n);
  return (
    /(^|\/)(test|tests|__tests__|__snapshots__)\//.test(n) ||
    /\.snap$/.test(b) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(b) ||
    /^test_.*\.py$/.test(b) ||
    /_test\.py$/.test(b)
  );
}

/**
 * Test-setup files (QA-1.6-21, adjustment to the §1.5-17 extension): `*.setup.<js/ts>` or the
 * conventional basenames below. Both alternatives are anchored and linear-time; generic
 * `*setup*` names (`src/setup.ts`, `SetupWizard.tsx`) are application code, not config.
 */
const SETUP_FILE =
  /\.setup\.[cm]?[jt]sx?$|^(setupTests|setup-tests|test-setup|global-setup|globalSetup|vitest\.setup|jest\.setup|setup-jest|jest-setup|vitest-setup|global-teardown|globalTeardown|setupVitest|setup-vitest|testSetup)\.[cm]?[jt]sx?$/i; // QA-1.6-36

export function isConfigPath(p: string): boolean {
  const n = norm(p);
  const b = base(n);
  return (
    /(^|\/)\.github\//.test(n) ||
    b === "package.json" ||
    b === "package-lock.json" ||
    b === "npm-shrinkwrap.json" ||
    b === "yarn.lock" ||
    b === "pnpm-lock.yaml" ||
    b === "bun.lockb" ||
    b === "bun.lock" ||
    b === "poetry.lock" ||
    b === "uv.lock" ||
    b === "Pipfile.lock" ||
    b === "Pipfile" ||
    /^tsconfig.*\.json$/.test(b) ||
    /^(vite|vitest|jest)\.config\./.test(b) ||
    /^playwright\.config\./.test(b) ||
    /^vitest\.workspace\./.test(b) ||
    SETUP_FILE.test(b) ||
    b === "conftest.py" ||
    b === "pyproject.toml" ||
    b === "pytest.ini" ||
    b === "tox.ini" ||
    b === "setup.cfg" ||
    b === "setup.py" ||
    b === ".gitlab-ci.yml" ||
    b === "Makefile" ||
    b === "CMakeLists.txt" ||
    /^(requirements|constraints).*\.txt$/.test(b) ||
    /^requirements.*\.in$/.test(b) || // pip-tools sources (QA-1.6-31)
    /(^|\/)requirements\/[^/]*\.(txt|in)$/i.test(n) // any-case folder, .in sources (QA-1.6-36)
  );
}

const PORCELAIN = /^[ .MTADRCU?!]{2}$/;

function statusHas(status: string | undefined, letter: "D" | "R"): boolean {
  if (status === undefined) return false;
  if (PORCELAIN.test(status)) return status.includes(letter);
  return status.trim().charAt(0).toUpperCase() === letter;
}

interface Classified {
  readonly path: string | null;
  readonly previousPath: string | null | undefined;
  readonly deleted: boolean;
  readonly renamed: boolean;
}

export function assessRisk(input: RiskInput): RiskAssessment {
  const { changedFiles, reference, producerTier, scopingPlan, root } = input;

  if (changedFiles.length === 0) return { level: "low", reasons: [REASONS.empty] };

  const files: Classified[] = changedFiles.map((f) => ({
    path: relativize(f.path, root),
    previousPath: f.previousPath === undefined ? undefined : relativize(f.previousPath, root),
    deleted: statusHas(f.status, "D"),
    renamed: f.previousPath !== undefined || statusHas(f.status, "R"),
  }));
  // Unresolvable absolute paths fall back to their full normalised form (conservative: may
  // over-match test/config patterns, never counts as documentation).
  const cls = (rel: string | null, raw: string): string => rel ?? norm(raw);
  const doc = (rel: string | null | undefined): boolean => rel === undefined || (rel !== null && isDocPath(rel));

  if (files.every((f) => doc(f.path) && doc(f.previousPath))) {
    return { level: "low", reasons: [REASONS.docsOnly] };
  }

  let idx = 0;
  const reasons: string[] = [];
  const hit = (level: RiskLevel, reason: string): void => {
    idx = Math.max(idx, ORDER.indexOf(level));
    reasons.push(reason);
  };

  const keys = new Set(
    changedFiles.map((f, i) => {
      const k = cls(files[i]!.path, f.path);
      return DRIVE.test(norm(f.path)) || (root !== undefined && DRIVE.test(norm(root))) ? k.toLowerCase() : k;
    }),
  );
  const n = keys.size;
  if (n <= SMALL_CHANGE_MAX) hit("low", REASONS.small);
  else if (n <= MEDIUM_CHANGE_MAX) hit("medium", REASONS.mediumCount);
  else hit("high", REASONS.largeCount);

  const paths = changedFiles.map((f, i) => {
    const c = files[i]!;
    const prev = f.previousPath === undefined ? undefined : cls(c.previousPath ?? null, f.previousPath);
    return { ...c, cur: cls(c.path, f.path), prev };
  });
  const touchesTest = (f: (typeof paths)[number]): boolean =>
    isTestPath(f.cur) || (f.prev !== undefined && isTestPath(f.prev));
  const testGone = (f: (typeof paths)[number]): boolean =>
    (f.deleted && touchesTest(f)) || (f.prev !== undefined && isTestPath(f.prev) && !isTestPath(f.cur));

  if (paths.some(testGone)) hit("high", REASONS.testDeleted);
  else if (paths.some(touchesTest)) hit("medium", REASONS.testModified);

  if (paths.some((f) => (f.deleted && !touchesTest(f)) || f.renamed)) {
    hit("medium", REASONS.deletedOrRenamed);
  }
  if (paths.some((f) => isConfigPath(f.cur) || (f.prev !== undefined && isConfigPath(f.prev)))) {
    hit("medium", REASONS.configChanged);
  }

  if ("fullScope" in scopingPlan && scopingPlan.fullScope === true) hit("medium", REASONS.fullScope);
  else if ("unverifiable" in scopingPlan && scopingPlan.unverifiable === true) hit("medium", REASONS.unverifiable);
  else if ("noAffected" in scopingPlan && scopingPlan.noAffected === true) reasons.push(REASONS.noAffected);

  if (producerTier === "fast") hit("medium", REASONS.fastTier);

  if (!reference) {
    idx = Math.min(idx + 1, ORDER.length - 1);
    reasons.push(REASONS.noReference);
  }

  return { level: ORDER[idx] ?? "high", reasons };
}
