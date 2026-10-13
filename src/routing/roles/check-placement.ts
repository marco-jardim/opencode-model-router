/**
 * Cross-repo P2.2 (docs/design/cross-repo-phase2-plan.md SD3, SD4): where each check of a role dispatch runs. A check's
 * `cwd=` and `scope=` keys (parsed by `verify/dod.ts`) become a {@link CheckPlacement}; nothing calls this yet.
 *
 * - Inert for a tier dispatch (no work root W) and for a DoD whose checks carry neither key: `{}`.
 * - `scope=`: `affected` or `full`, case-insensitive; anything else refuses (`why: "scope"`).
 * - `cwd=` is refused first, before any filesystem probe, when it is a UNC path, has a `.git` segment (case-insensitive, with
 *   any trailing dots/spaces: `.git.`, `.git ` name `.git` on win32) or, on win32 only, an 8.3 short-name segment
 *   ({@link SHORT_NAME_SEGMENT}; `my-library~2` and a POSIX `backup~1` are ordinary names). A relative `cwd=` is resolved against
 *   W with {@link canonicalAuthorityPath} and must stay inside W ({@link insideWorkRoot}); one that leaves W refuses even when it
 *   lands in the read set R. An absolute `cwd=` is canonicalised and accepted inside W, else only when `deps.inReadSet` holds it
 *   (R is injected: `work-root.ts` must not import `read-set.ts`). A canonical path with a `.git` segment refuses too.
 * - A check with only `scope=` is placed at the block base (`scope.cwd`).
 * - `top` is the git top level of the placement (a `.git` walk, no git process). A placement inside W is never `foreign` (a
 *   nested `.git` in W — a vendored repository, a fixture — does not make it foreign; its own `top` is still reported); outside
 *   W, `foreign` = its top differs from W's top, or is unknown.
 *
 * The first offending check in index order refuses the whole DoD; no top is looked up for a refused DoD.
 */
import { isAbsolute } from "node:path";
import type { DoD } from "../../verify/dod";
import { gitTopOf } from "../../verify/git-top";
import type { CheckPlacement, PlacementResolution } from "../../verify/types";
import { isSlash, trimEndWhile } from "../../util/linear-trim";
import { canonicalAuthorityPath, insideWorkRoot, SHORT_NAME_SEGMENT, type VerificationScope } from "./work-root";

/** What the resolver needs beyond the DoD and the scope; every member is a seam for tests. */
export interface CheckPlacementDeps {
  /** The read-set predicate R (`read-set.ts` `readSetPredicate`) on a canonical absolute path. Absent: only W is allowed. */
  readonly inReadSet?: (absPath: string) => boolean;
  readonly canonical?: typeof canonicalAuthorityPath;
  /** The git top level of a directory; default {@link gitTopOf}. */
  readonly topOf?: (dir: string) => string | undefined;
}

/** A `.git` segment, case-insensitive, with any trailing dots/spaces (win32 strips them: `.git.` and `.git ` name `.git`). */
const GIT_SEGMENT = /(?:^|[\\/])\.git[. ]*(?=[\\/]|$)/i;

/** Refused before any filesystem probe: a UNC/device path, a `.git` segment, on win32 an 8.3 short-name segment. */
function lexicallyRefused(text: string): boolean {
  if (/^[\\/]{2}/.test(text)) return true;
  if (GIT_SEGMENT.test(text)) return true;
  return process.platform === "win32" && SHORT_NAME_SEGMENT.test(text);
}

/** A comparison key for a top level: "/" separators, no trailing separator, case-folded on win32. */
function topKey(top: string): string {
  const normalized = trimEndWhile(top.replace(/\\/g, "/"), isSlash); // linear: no `/\/+$/` (polynomial on a run of "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** The canonical directory of a `cwd=` text, or undefined when it is refused. */
function placeCwd(
  text: string,
  workRoot: string,
  canonical: typeof canonicalAuthorityPath,
  inReadSet: ((absPath: string) => boolean) | undefined,
): string | undefined {
  if (lexicallyRefused(text)) return undefined;
  const target = canonical(text, workRoot);
  if (target === undefined || GIT_SEGMENT.test(target)) return undefined; // `.git.`, a link or a junction can land in `.git`
  if (insideWorkRoot(target, workRoot)) return target;
  if (!isAbsolute(text)) return undefined; // a relative path that leaves W, even into R
  return inReadSet?.(target) === true ? target : undefined;
}

/**
 * The placements of `dod.checks` for a dispatch verified in `scope`, index-aligned (undefined for a check with neither key),
 * or the first refused check. `{}` for a tier scope or when no check carries a key.
 */
export function resolveCheckPlacements(dod: DoD, scope: VerificationScope, deps: CheckPlacementDeps = {}): PlacementResolution {
  const workRoot = scope.workRoot;
  if (workRoot === undefined) return {};
  if (!dod.checks.some((check) => check.cwd !== undefined || check.scope !== undefined)) return {};
  const canonical = deps.canonical ?? canonicalAuthorityPath;
  const topOf = deps.topOf ?? gitTopOf;
  const base = scope.cwd ?? workRoot;

  // Pass 1: validate every key in index order; the first offending check refuses, before any top lookup.
  const resolved: ({ readonly cwd: string; readonly scope?: "affected" | "full" } | undefined)[] = [];
  for (let index = 0; index < dod.checks.length; index++) {
    const check = dod.checks[index]!;
    if (check.cwd === undefined && check.scope === undefined) {
      resolved.push(undefined);
      continue;
    }
    let checkScope: "affected" | "full" | undefined;
    if (check.scope !== undefined) {
      const lower = check.scope.toLowerCase();
      if (lower !== "affected" && lower !== "full") return { refused: { index, kind: check.kind, text: check.scope, why: "scope" } };
      checkScope = lower;
    }
    let cwd = base;
    if (check.cwd !== undefined) {
      const placed = placeCwd(check.cwd, workRoot, canonical, deps.inReadSet);
      if (placed === undefined) return { refused: { index, kind: check.kind, text: check.cwd, why: "outside" } };
      cwd = placed;
    }
    resolved.push(checkScope === undefined ? { cwd } : { cwd, scope: checkScope });
  }

  // Pass 2: the top level of each placement, compared with W's. Inside W is never foreign, whatever `.git` lies below W.
  const workTop = topOf(workRoot);
  const workKey = workTop === undefined ? undefined : topKey(workTop);
  const placements: (CheckPlacement | undefined)[] = resolved.map((entry) => {
    if (entry === undefined) return undefined;
    const top = topOf(entry.cwd);
    const foreign = !insideWorkRoot(entry.cwd, workRoot) && (top === undefined || topKey(top) !== workKey);
    return entry.scope === undefined ? { cwd: entry.cwd, top, foreign } : { cwd: entry.cwd, top, foreign, scope: entry.scope };
  });
  return { placements };
}
