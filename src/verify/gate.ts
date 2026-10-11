/**
 * src/verify/gate.ts — Layer 2 acceptance gate (PURE orchestration core).
 *
 * The gate is the single decision point that turns "the producer says it
 * finished" into "the producer's output was objectively accepted". It is
 * shared by BOTH usage modes (Mode A on-the-fly dispatch and Mode B plan
 * annotation) and by BOTH wirings (Option (i) verify-dispatch around the
 * built-in `task` tool, and Option (ii) the plugin-owned `delegate` tool),
 * so there is exactly ONE accept/verify code path (GA-5).
 *
 * Design invariants:
 *  - The former "FAIL-CLOSED: a verification error never yields acceptance"
 *    policy is available via strictUnverifiable; default acceptance has caveats.
 *  - NEVER silently accept a non-trivial delegation that has no checkable DoD.
 *  - producer != grader and grader >= producer are enforced inside runChecker;
 *    the gate never grades anything itself.
 *  - PURE: all side-effecting work (exec/fs/grader dispatch) is injected via
 *    deps; this module imports no fs/network/SDK.
 */
import type { Verdict } from "./types";
import type { CheckPlacement, DeterministicDeps } from "./types";
import type { DoD } from "./dod";
import { isCheckable } from "./dod";
import { runDeterministic } from "./deterministic";
import { incompleteVerdict, isIncompleteVerdict, runChecker } from "./checker";
import type { ArtefactView, CheckerDeps } from "./checker";
import type { BudgetSnapshot } from "../guard/enforce";
import { isAbsolute, resolve } from "node:path";
import { isWithinDir, resolveBaseDir } from "./paths";
import { toolLabel } from "./dispatch";
import { perimeterKey } from "./git-top";

/** How many outside paths the mixed-change-set reason names before "and N more". */
const MAX_OUTSIDE_LISTED = 5;

/** Cross-repo P1.8: one repository of a perimeter, as the gate names it. */
export interface PerimeterRepo {
  readonly root: string;
  readonly name: string;
  readonly branch?: string;
  readonly head?: string;
}

/**
 * Cross-repo P1.8: an extra root of P and its change since the dispatch. "unobserved": no snapshot at either end, past the cap,
 * or a perimeter that could not be planned (I4 refuses it when writers ran). "unadmitted" (QA-1 F4): a linked directory whose
 * repository is not admitted, or that is not a git repository; never snapshotted, and only named in I8.
 */
export interface PerimeterRoot extends PerimeterRepo {
  readonly status: "changed" | "unchanged" | "unobserved" | "unadmitted";
  /** QA-1 F11: a worktree of W's own repository; I4 suggests `branch=<branch>` rather than `repo=<name>`. */
  readonly sameRepository?: boolean;
}

/** QA-1 F10: the name of the placeholder root a perimeter that could not be planned holds (fail closed). */
export const PERIMETER_UNPLANNED = "perimeter could not be planned";

/** Cross-repo P1.8 (I8): the perimeter P of a dispatch: W, then its other roots (at least one). */
export interface PerimeterObservation {
  readonly w: PerimeterRepo;
  readonly roots: readonly PerimeterRoot[];
  /**
   * Cross-repo P2b.3 (D6): working-set worktrees other than W whose `node_modules` link into W, found by `discoverConsumers`.
   * Absent or empty: none known, no consumer caveat.
   */
  readonly consumers?: readonly { readonly root: string; readonly name?: string; readonly entry: string }[];
  /**
   * Cross-repo QA-2 #2: working-set worktrees whose consumer discovery stopped on its entry budget before it finished. A
   * repository there may link W unchecked, so a would-be pass with a change carries a caveat per entry.
   */
  readonly consumersIncomplete?: readonly { readonly root: string; readonly name?: string }[];
}

/** The concrete, inspectable result of a delegation (artefact contract §3.3). */
export interface Artefact {
  changeBaseline?: "available" | "unavailable";
  /**
   * The git top-level the change set was observed in (snapshot.root). Paths outside it (absolute, or relative ones that climb
   * out with `..`), mixed with paths inside, make the verdict unverifiable (S4/F3). Absent: the effective base directory stands
   * in for it.
   */
  changeRoot?: string;
  /**
   * I7 (P0.2, S9/S12): the working tree switched branch during the dispatch or since the producer returned; the reason, worded
   * by the wiring (branch.ts branchSwitchReason / branchUnconfirmedReason). Present: the verdict is unverifiable with it on
   * either verifier and nothing runs, since the change set and the checks would describe another branch.
   */
  branchSwitch?: string;
  /**
   * I5 (P0.3, S1/S3/S10): tools the producer lineage ran that can write files the router cannot observe (dispatch.ts
   * isUnattributedWriter), sorted. With an empty, available change set, a pass carries a caveat and is never a verified pass.
   */
  unattributedWriters?: string[];
  /**
   * Cross-repo P1.8 (I4, I8): the perimeter P the wiring observed (wiring.ts observeChange): W, then each extra root with its
   * change status since the dispatch. Absent: the dispatch has no perimeter (one repository), and nothing below changes.
   */
  perimeter?: PerimeterObservation;
  changedFiles: { path: string; status: string }[];
  finalReturnText: string;
  declaredOutputs: string[];
  producerSessionID: string;
  producerTier: string;
  /** The producer follows the return contract (role agents, P2.1); absent = a router tier. */
  returnContract?: boolean;
  /**
   * QA-P15-2-5: the producer's guard budget state captured when its task
   * returned (enforce.ts captureBudget, with sessions.ts readCapReached). Absent:
   * read live when the gate runs (the synchronous task path runs it right after
   * the return).
   */
  budget?: BudgetSnapshot;
}

/** The delegation being judged: its DoD plus dispatch-time classification. */
export interface Delegation {
  dod: DoD;
  /** Trivial dispatches (classified at dispatch, m2) bypass verification (GA-6). */
  trivial?: boolean;
  /** Mode A (on-the-fly) vs Mode B (plan annotation) — drives the no-DoD message. */
  mode?: "modeA" | "modeB";
  /**
   * Working directory the producer was told to work in. When present it becomes
   * the base directory for verification: relative deterministic-check paths
   * resolve against it, and the grader is scoped to it. Absent means "the
   * router's own directory", which is the pre-existing behaviour exactly.
   */
  cwd?: string;
  /**
   * #84 P3.3 DF2-F1: the validated work root of a ROLE dispatch (plan §2.2; `routedWorkRoot`). Present: verification runs in
   * it — the default base when `cwd` is absent, the base a relative `cwd` resolves against — and a `cwd` outside it is refused
   * (unverifiable, nothing runs). Absent (tier dispatches): unchanged (I1). Set from `verificationScope` (index.ts): the child's
   * bound work root, else its canonical session directory (QA-P33F1-1-1, 1-3), with `cwd` the checked canonical directory.
   */
  workRoot?: string;
  /**
   * QA-P33F1-1-2: the `cwd:` the caller found outside `workRoot` by P2.3's containment rule (`verificationScope.refused`, as
   * written). With `workRoot`, the gate refuses it (unverifiable) without resolving it.
   */
  refusedCwd?: string;
  /**
   * Fix-1 review nit: where the requested cwd (`cwd` / `refusedCwd`) came from — the call's own `cwd` argument or the
   * `[acceptance]` block's `cwd:` (work-root.ts `requestedVerificationCwdSource`). Only names the source in a refusal; absent:
   * the refusal names neither.
   */
  cwdSource?: "argument" | "acceptance";
  /**
   * Cross-repo P2.4: where each check of `dod.checks` runs, index-aligned (undefined: no `cwd=`/`scope=` key). Absent: every
   * check runs in the base directory, and nothing below changes.
   */
  checkPlacements?: readonly (CheckPlacement | undefined)[];
  /**
   * Cross-repo P2.4 (SD4): the first check whose `cwd=` is outside the work root and its read set (`why: "outside"`) or whose
   * `scope=` is not affected/full (`why: "scope"`); `index` is 0-based. With it the gate refuses (unverifiable, nothing runs).
   */
  refusedCheck?: { readonly index: number; readonly kind: string; readonly text: string; readonly why: "outside" | "scope" | "tier" };
}

export interface GateDeps {
  deterministic: DeterministicDeps;
  checker: CheckerDeps;
  /**
   * verify.require: "never" disables the gate (accept without verifying);
   * "whenDoDPresent" (default) and "always" both verify when the DoD is
   * checkable and apply the no-DoD policy otherwise.
   */
  require?: "never" | "whenDoDPresent" | "always";
  strictUnverifiable?: boolean;
  /**
   * Canonicalizes a path for the outside-the-base check: one directory can be spelled several
   * ways (a Windows 8.3 short name, a symlink such as macOS /var -> /private/var), and a lexical
   * comparison would call the producer's own files "outside". Absent means lexical comparison.
   */
  canonicalPath?: (path: string) => string;
}

export interface GateResult {
  accepted: boolean;
  verdict: Verdict;
  /** Convenience mirror of dod.source for the caller's trajectory record. */
  dodSource: DoD["source"];
}

export function gateResult(verdict: Verdict, dodSource: DoD["source"], strictUnverifiable = false): GateResult {
  const outcome = verdict.outcome ?? (verdict.pass ? "pass" : "fail");
  const caveats = verdict.caveats ?? (outcome === "unverifiable" ? verdict.reasons : []);
  return {
    // QA-P15-1-1: an incomplete return (progress note, budget stop) is never accepted;
    // as an unverifiable outcome it still gets no next-tier hint and moves no evidence.
    accepted: outcome !== "fail" && !isIncompleteVerdict(verdict) && !(strictUnverifiable && caveats.length > 0),
    verdict: { ...verdict, outcome, ...(caveats.length ? { caveats } : {}) },
    dodSource,
  };
}

export function unverifiableGateResult(reason: string, dodSource: DoD["source"], strictUnverifiable = false, completedFailures: string[] = []): GateResult {
  // An outer timeout must never erase a genuine failure already observed.
  return gateResult({
    pass: false,
    outcome: completedFailures.length ? "fail" : "unverifiable",
    method: "none",
    reasons: [...completedFailures, reason],
    caveats: [reason],
  }, dodSource, strictUnverifiable);
}

function view(artefact: Artefact): ArtefactView {
  return {
    finalReturnText: artefact.finalReturnText,
    changedFiles: artefact.changedFiles,
    changeBaseline: artefact.changeBaseline,
    declaredOutputs: artefact.declaredOutputs,
  };
}

/**
 * Decide whether a delegation's artefact meets its DoD.
 * Returns acceptance separately from successful verification: unavailable
 * checks carry caveats and reject only under strictUnverifiable.
 */
export async function accept(
  delegation: Delegation,
  artefact: Artefact,
  deps: GateDeps,
): Promise<GateResult> {
  const dod = delegation.dod;
  const dodSource = dod.source;
  const require = deps.require ?? "whenDoDPresent";

  // verify.require === "never": Layer 2 is configured off; do not gate.
  if (require === "never") {
    return {
      accepted: true,
      verdict: {
        pass: false,
        method: "none",
        skipped: true,
        reasons: ["verification disabled (verify.require=never)"],
      },
      dodSource,
    };
  }

  // Trivial dispatch (classified at dispatch, m2) carrying only an AUTO-INFERRED
  // DoD: bypass verification overhead (GA-6 proportional). An explicit author
  // [acceptance] block (source "explicit"/"annotation") is a deliberate request
  // to verify and is always honored, even for a trivially-classified dispatch.
  if (delegation.trivial && dod.source === "inferred") {
    return {
      accepted: true,
      verdict: {
        pass: false,
        method: "none",
        skipped: true,
        reasons: ["trivial dispatch; verification skipped (auto-inferred DoD)"],
      },
      dodSource,
    };
  }

  // No checkable DoD: apply the proportional / never-silently-accept policy.
  if (!isCheckable(dod)) {
    if (delegation.trivial) {
      return {
        accepted: true,
        verdict: {
          pass: false,
          method: "none",
          skipped: true,
          reasons: ["trivial dispatch; verification skipped"],
        },
        dodSource,
      };
    }
    const reason =
      delegation.mode === "modeB"
        ? "no acceptance block on a non-trivial plan task (Mode B is strict): add an [acceptance] ... [/acceptance] block to this task"
        : "no checkable DoD for a non-trivial dispatch (Mode A): provide an [acceptance] block or let auto-inference supply one";
    return {
      accepted: false,
      verdict: { pass: false, method: "none", skipped: true, reasons: [reason] },
      dodSource,
    };
  }

  // Checkable DoD: dispatch on the normalized kind. normalizeDoD() guarantees
  // a checkable DoD is "deterministic" (when any checks exist) or "checker"
  // (criteria only), which realises verify.preferDeterministic at
  // DoD-construction time. Verifier limitations are distinct from failed checks;
  // the gate applies strictUnverifiable centrally, without fabricating a pass.
  // A delegation that declared a working directory must be verified against
  // THAT directory, not the router's. Both verifiers get the same effective
  // base dir so a deterministic check and a grader can never disagree about
  // where the work was supposed to land.
  // QA-P15-1-2 / 2-6 / I7: a budget stop, or a contract follower's progress note,
  // is incomplete under either verifier — never a failure, never a next-tier hint.
  // Judged on the snapshot captured when the task returned (artefact.budget, 2-5).
  const stopped = incompleteVerdict(artefact, {
    progressNotes: true,
    ladder: deps.checker.ladder,
    budgetSnapshot: deps.checker.budgetSnapshot,
  });
  if (stopped) return gateResult(stopped, dodSource, deps.strictUnverifiable);

  // DF2-F1: a role dispatch is verified in its work root (its default base, and the base of a relative cwd), never the router's.
  const workRoot = delegation.workRoot;
  const refuseCwd = (cwd: string): GateResult => {
    // Refused like any path outside the role's work root (§2.2): no check runs and no grader is dispatched there.
    // The text names where the cwd came from (fix-1 review nit): the call's `cwd` argument, or the [acceptance] block's `cwd:`.
    const [subject, remedy] = delegation.cwdSource === "argument"
      ? [`the call's cwd argument ${cwd}`, `Drop the "cwd" argument (the checks then run in the work root) or name a directory inside it.`]
      : delegation.cwdSource === "acceptance"
        ? [`the [acceptance] block's cwd ${cwd}`, `Remove "cwd:" (the checks then run in the work root) or name a directory inside it.`]
        : [`the requested cwd ${cwd}`, `Name no cwd (the checks then run in the work root) or one inside it.`];
    const reason = `${subject} is outside this role dispatch's work root ${workRoot}; the router verifies a role dispatch only inside its work root. ${remedy}`;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  };
  // QA-P33F1-1-2: the caller decided containment with P2.3's rule (routing/roles/work-root.ts verificationScope); a refused cwd
  // is never resolved here (a UNC/device path reaches no filesystem call).
  if (workRoot !== undefined && delegation.refusedCwd !== undefined) return refuseCwd(delegation.refusedCwd);
  // Cross-repo P2.4 (SD4): a check's `cwd=` outside the work root and its read set, or a `scope=` that is neither affected nor
  // full: nothing runs, whichever verifier the DoD names.
  if (delegation.refusedCheck !== undefined) {
    const { index, kind, text, why } = delegation.refusedCheck;
    // OD1=B: a tier dispatch (no routed role) honours no per-check `cwd=`; `text` is the cwd as written.
    const reason = why === "outside"
      ? `check ${index + 1} (${kind}) cwd=${text} is outside the work root ${workRoot ?? deps.deterministic.cwd} and its read set; nothing ran`
      : why === "tier"
        ? `check ${index + 1} (${kind}) cwd=${text}: a per-check cwd= is honoured only in roles mode; nothing ran`
        : `check ${index + 1} (${kind}) scope=${text} is not affected or full; nothing ran`;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  }
  const effectiveBaseDir = resolveBaseDir(
    delegation.cwd,
    workRoot ?? deps.deterministic.cwd,
  );
  // Backstop for a caller that did not check its cwd: lexical only (no filesystem call); a checked canonical cwd always passes.
  if (workRoot !== undefined && !isWithinDir(effectiveBaseDir, workRoot)) return refuseCwd(effectiveBaseDir);
  // I7 (P0.2, S9/S12): the verified tree switched branch. The change set and either verifier would describe another branch, so
  // nothing runs; before the all-outside and mixed checks, whose reasons would then be about the wrong change set.
  if (artefact.branchSwitch !== undefined) {
    const reason = artefact.branchSwitch;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  }
  // I4 (cross-repo P1.8): another repository of the perimeter changed during the dispatch (or could not be observed: fail
  // closed), and the producer ran a tool whose writes cannot be attributed. The checks here cannot cover a write there.
  const perimeterRefusal = perimeterChangeReasons(artefact, artefact.perimeter?.w.root ?? artefact.changeRoot ?? effectiveBaseDir);
  if (perimeterRefusal.length > 0) {
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: perimeterRefusal, caveats: perimeterRefusal }, dodSource, deps.strictUnverifiable);
  }
  const canonical = deps.canonicalPath ?? ((path: string) => path);
  // S4/F3: some changes inside the change root and some absolute ones outside it. Neither verifier can see the outside ones
  // (the runner drops them with a note; the grader checks against, and runs in, the working directory), so the change set
  // cannot be verified as a whole. A relative path is root-relative, hence inside unless it climbs out (`../x`). The root is
  // the observed git top-level, else the base directory.
  const refuseMixedOutside = (): GateResult | undefined => {
    // No absolute path and no `..` segment: nothing can be outside, and no canonicalisation (a filesystem call) is needed.
    if (!artefact.changedFiles.some(({ path }) => isAbsolute(path) || path.split(/[\\/]/).includes(".."))) return undefined;
    const root = artefact.changeRoot ?? effectiveBaseDir;
    const canonicalRoot = canonical(root);
    const outsideRoot = artefact.changedFiles
      .map(({ path }) => path)
      .filter(path => !isWithinDir(canonical(isAbsolute(path) ? path : resolve(root, path)), canonicalRoot));
    if (outsideRoot.length === 0 || outsideRoot.length === artefact.changedFiles.length) return undefined;
    const listed = outsideRoot.slice(0, MAX_OUTSIDE_LISTED).join(", ")
      + (outsideRoot.length > MAX_OUTSIDE_LISTED ? ` and ${outsideRoot.length - MAX_OUTSIDE_LISTED} more` : "");
    const reason = `the producer also changed files outside ${root}: ${listed}; checks scoped to ${root} cannot see them, so the change set cannot be verified as a whole. Verify those paths in their own repository, or dispatch that work separately.`;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  };

  // Every change is outside the base directory (neither verifier can see any of them): an absolute path outside the canonical
  // base, or a relative one that climbs out of it (`../x`, resolved against the base). Same refusal for both verifiers (C1).
  const refuseAllOutside = (): GateResult | undefined => {
    if (artefact.changedFiles.length === 0) return undefined;
    // No absolute path and no `..` segment: nothing can be outside, and no canonicalisation (a filesystem call) is needed.
    if (!artefact.changedFiles.some(({ path }) => isAbsolute(path) || path.split(/[\\/]/).includes(".."))) return undefined;
    const canonicalBase = canonical(effectiveBaseDir);
    const isOutside = (path: string): boolean => {
      if (isAbsolute(path)) return !isWithinDir(canonical(path), canonicalBase);
      // A relative path without a `..` segment cannot leave the base: no canonicalisation (a filesystem call) is needed.
      if (!path.split(/[\\/]/).includes("..")) return false;
      return !isWithinDir(canonical(resolve(effectiveBaseDir, path)), canonicalBase);
    };
    if (!artefact.changedFiles.every(({ path }) => isOutside(path))) return undefined;
    // QA-P33F1-1 nit 1: a cwd: narrower than the work root, with work elsewhere in the root → widen (or drop) the cwd:.
    const narrowed = workRoot !== undefined && !isWithinDir(canonical(workRoot), canonicalBase)
      && artefact.changedFiles.some(({ path }) => isAbsolute(path) && isWithinDir(canonical(path), canonical(workRoot)));
    const hint = workRoot === undefined
      ? `Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`
      : narrowed
        ? `The [acceptance] block's "cwd:" narrows verification to ${effectiveBaseDir} inside the work root ${workRoot}: widen "cwd:" to where the work landed, or remove it (the checks then run in the work root).`
        : `A role dispatch is verified only inside its work root ${workRoot}: the work belongs there.`;
    const reason = `the producer changed files only outside ${effectiveBaseDir} (e.g. ${artefact.changedFiles[0].path}); checks run there cannot see them. ${hint}`;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  };

  // Cross-repo P2.4 (I3, SD7): with placed checks, every changed path must lie inside some check root: the top of a placed check,
  // or the change root for an unplaced one (an undefined top covers nothing). Otherwise part of the change is seen by no check.
  const refuseUncoveredByCheckRoots = (): GateResult | undefined => {
    const placements = delegation.checkPlacements;
    if (placements === undefined || !placements.some(placement => placement !== undefined)) return undefined;
    // QA-3 #1: an unavailable change baseline leaves the change list unknown (often []), not empty.
    const baselineUnavailable = artefact.changeBaseline === "unavailable";
    if (artefact.changedFiles.length === 0 && !baselineUnavailable) return undefined;
    const changeRoot = artefact.changeRoot ?? effectiveBaseDir;
    const tops: string[] = [];
    for (let index = 0; index < (dod.checks ?? []).length; index++) {
      const placement = placements[index];
      // QA-3 #5: an unplaced check, or a non-foreign placement without a top, runs in (covers) the change root.
      const top = placement === undefined || (placement.foreign !== true && placement.top === undefined) ? changeRoot : placement.top;
      if (top !== undefined && !tops.includes(top)) tops.push(top);
    }
    // QA round 2 M1: coverage is decided by tops. A placement inside W whose top is a nested repository (submodule, vendored)
    // does not run in the change root, so it does not cover it (the same placement is refused by I3 when the baseline is known).
    const canonicalChangeRoot = canonical(changeRoot);
    const coversChangeRoot = tops.some(top => isWithinDir(canonicalChangeRoot, canonical(top)));
    if (baselineUnavailable && !coversChangeRoot) {
      const reason = `the change in the work root could not be observed and no check runs there (${tops.length > 0 ? tops.join(", ") : "no check root"}); nothing ran`;
      return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
    }
    if (artefact.changedFiles.length === 0) return undefined;
    const canonicalTops = tops.map(top => canonical(top));
    const uncovered = artefact.changedFiles
      .map(({ path }) => path)
      .filter(path => {
        const absolute = canonical(isAbsolute(path) ? path : resolve(changeRoot, path));
        return !canonicalTops.some(top => isWithinDir(absolute, top));
      });
    if (uncovered.length === 0) return undefined;
    const listed = uncovered.slice(0, MAX_OUTSIDE_LISTED).join(", ")
      + (uncovered.length > MAX_OUTSIDE_LISTED ? ` and ${uncovered.length - MAX_OUTSIDE_LISTED} more` : "");
    const reason = `the change in ${listed} is not covered by any check root (${tops.length > 0 ? tops.join(", ") : "no check root"}); nothing ran`;
    return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
  };

  let verdict: Verdict;
  if (dod.kind === "deterministic") {
    const allOutside = refuseAllOutside();
    if (allOutside) return allOutside;
    const mixed = refuseMixedOutside();
    if (mixed) return mixed;
    const uncovered = refuseUncoveredByCheckRoots();
    if (uncovered) return uncovered;
    const placements = delegation.checkPlacements;
    // F7: a check placed in another repository resolves relative changed paths against its own cwd, which is not where they were
    // observed: with such a check, hand the runner absolute paths (against the change root).
    const changed = deps.deterministic.changedFiles;
    const hasForeign = placements?.some(placement => placement?.foreign === true) === true;
    const changeRoot = artefact.changeRoot ?? effectiveBaseDir;
    verdict = await runDeterministic(dod, {
      ...deps.deterministic,
      cwd: effectiveBaseDir,
      ...(hasForeign && changed !== undefined && changed !== "unavailable"
        ? {
          changedFiles: changed.map(file => ({
            ...file,
            path: isAbsolute(file.path) ? file.path : resolve(changeRoot, file.path),
            ...(file.previousPath !== undefined
              ? { previousPath: isAbsolute(file.previousPath) ? file.previousPath : resolve(changeRoot, file.previousPath) }
              : {}),
          })),
        }
        : {}),
      ...(placements !== undefined ? { placements } : {}),
    });
  } else {
    // "checker" is the only remaining checkable kind.
    const allOutside = refuseAllOutside();
    if (allOutside) return allOutside;
    const mixed = refuseMixedOutside();
    if (mixed) return mixed;
    verdict = await runChecker(
      {
        criteria: dod.criteria,
        artefact: view(artefact),
        producerTier: artefact.producerTier,
        producerSessionID: artefact.producerSessionID,
        ...(artefact.returnContract !== undefined ? { returnContract: artefact.returnContract } : {}),
        ...(artefact.budget !== undefined ? { budget: artefact.budget } : {}),
        // Only when the delegation actually declared one (or is a role dispatch: its work root, DF2-F1). Passing the router's
        // own directory here would scope every existing grader and add a
        // working-directory line to every existing prompt for no reason.
        ...(delegation.cwd || workRoot !== undefined ? { workingDir: effectiveBaseDir } : {}),
      },
      deps.checker,
    );
  }

  // I5 (P0.3): nothing observed changed, but the producer ran a tool whose writes the router cannot see. The checks passed on
  // a tree that may not hold the producer's work, so the pass is not a verified pass.
  const writers = artefact.unattributedWriters ?? [];
  if (writers.length > 0 && artefact.changeBaseline === "available" && artefact.changedFiles.length === 0
    && (verdict.outcome ?? (verdict.pass ? "pass" : "fail")) === "pass") {
    const caveat = unattributedWritersCaveat(artefact.changeRoot ?? effectiveBaseDir, writers);
    verdict = { ...verdict, pass: false, outcome: "unverifiable", reasons: [...verdict.reasons, caveat], caveats: [...(verdict.caveats ?? []), caveat] };
  }
  // D6 (cross-repo P2b.4, OD2): a would-be pass with a change, where a working-set worktree links this work root (a consumer) and
  // no testsPass/buildPasses/lintClean/run check is placed in it: nothing ran there, so the pass is not a verified pass.
  const consumerCaveats = unverifiedConsumerCaveats(artefact, dod, delegation.checkPlacements);
  if (consumerCaveats.length > 0 && (verdict.outcome ?? (verdict.pass ? "pass" : "fail")) === "pass") {
    verdict = { ...verdict, pass: false, outcome: "unverifiable", reasons: [...verdict.reasons, ...consumerCaveats], caveats: [...(verdict.caveats ?? []), ...consumerCaveats] };
  }
  // I8 (cross-repo P1.8): a pass names the perimeter it was scoped to. Evidence only: the outcome is unchanged. QA-1 F6: a pass
  // renders its notes, not its reasons (buildAcceptedSuffix), so the line is a note too; a note never makes the pass unverified.
  if (artefact.perimeter !== undefined && artefact.perimeter.roots.length > 0
    && (verdict.outcome ?? (verdict.pass ? "pass" : "fail")) === "pass") {
    const scope = verifiedScopeLine(artefact.perimeter);
    verdict = { ...verdict, reasons: [...verdict.reasons, scope], notes: [...(verdict.notes ?? []), scope] };
  }

  return gateResult(verdict, dodSource, deps.strictUnverifiable);
}

/** OD2: the check kinds that exercise a consumer; `fileExists` and `schemaMatch` do not. */
const CONSUMER_CHECK_KINDS: ReadonlySet<string> = new Set(["testsPass", "buildPasses", "lintClean", "run"]);

/**
 * D6 (cross-repo P2b.4, OD2): one caveat per consumer of W (artefact.perimeter.consumers) that no consumer check is placed in
 * (placement.top equals the consumer root, `perimeterKey` normalisation). [] when there is no perimeter, no consumer, or the
 * change set is empty.
 */
function unverifiedConsumerCaveats(
  artefact: Artefact,
  dod: DoD,
  placements: readonly (CheckPlacement | undefined)[] | undefined,
): string[] {
  // QA-3 #1: an unavailable change baseline counts as a non-empty change set (the change is unknown, not absent).
  if (artefact.changedFiles.length === 0 && artefact.changeBaseline !== "unavailable") return [];
  const consumers = artefact.perimeter?.consumers ?? [];
  const checks = dod.kind === "deterministic" ? dod.checks ?? [] : [];
  const covered = new Set<string>();
  checks.forEach((check, index) => {
    const top = placements?.[index]?.top;
    if (top !== undefined && CONSUMER_CHECK_KINDS.has(check.kind)) covered.add(perimeterKey(top));
  });
  const unchecked = consumers
    .filter(consumer => !covered.has(perimeterKey(consumer.root)))
    .map(consumer => `${consumer.name ?? consumer.root} at ${consumer.root} links this work root (node_modules/${consumer.entry}) and no check ran there; add a check such as: check: testsPass cwd="${consumer.root}" scope=full`);
  // QA-2 #2: discovery stopped on its budget; a repository there may link this work root unchecked.
  // QA round 2 M2: cleared by the same coverage as a consumer (a consumer check placed with its top equal to that root).
  const incomplete = (artefact.perimeter?.consumersIncomplete ?? [])
    .filter(entry => !covered.has(perimeterKey(entry.root)))
    .map(entry => `consumer discovery stopped before finishing ${entry.name ?? entry.root} at ${entry.root}; a repository there may link this work root unchecked; add a check such as: check: testsPass cwd="${entry.root}" scope=full`);
  return [...unchecked, ...incomplete];
}

/** I5 (P0.3): the caveat for an empty change set when the producer ran tools whose writes the router cannot observe. */
export function unattributedWritersCaveat(root: string, writers: readonly string[]): string {
  return `no change was observed in ${root} but the producer ran ${listedTools(writers)}; a write those tools made cannot be seen, so this is not a verified pass`;
}

/** At most MAX_OUTSIDE_LISTED tool names, sanitised (toolLabel), then "and N more". */
function listedTools(writers: readonly string[]): string {
  return writers.slice(0, MAX_OUTSIDE_LISTED).map(toolLabel).join(", ")
    + (writers.length > MAX_OUTSIDE_LISTED ? ` and ${writers.length - MAX_OUTSIDE_LISTED} more` : "");
}

/**
 * I4 (cross-repo P1.8): one unverifiable reason per extra root of the perimeter that changed during the dispatch, or whose
 * snapshot was unavailable at either end (fail closed), when the producer lineage ran an unattributable writer; [] otherwise.
 * `w` names where the checks run.
 */
export function perimeterChangeReasons(artefact: Pick<Artefact, "perimeter" | "unattributedWriters">, w: string): string[] {
  const writers = artefact.unattributedWriters ?? [];
  if (artefact.perimeter === undefined || writers.length === 0) return [];
  const tools = listedTools(writers);
  return artefact.perimeter.roots.filter(root => root.status === "changed" || root.status === "unobserved").map(root => {
    if (root.name === PERIMETER_UNPLANNED) {
      return `the verification ${PERIMETER_UNPLANNED} when the dispatch started, and the producer ran ${tools}; a write in another repository cannot be ruled out, so the checks in ${w} do not cover it. Re-dispatch, or verify it there.`;
    }
    const what = root.status === "changed" ? "also changed during the dispatch" : "could not be observed during the dispatch";
    // QA-1 F11: another worktree of W's own repository is reached by its branch, not by the repository's name.
    const target = root.sameRepository === true && root.branch !== undefined ? `branch=${root.branch}` : `repo=${root.name}`;
    return `the repository ${root.name} at ${root.root} ${what}, and the producer ran ${tools}; a write there cannot be attributed, so the checks in ${w} do not cover it. Dispatch that work with ${target}, or verify it there.`;
  });
}

/**
 * I8 (cross-repo P1.8): the evidence line of a pass whose perimeter holds more than W. QA-1 F6 (I4 "otherwise → a note"): a root
 * that changed without an unattributable writer is shown as changed.
 */
export function verifiedScopeLine(perimeter: PerimeterObservation): string {
  const show = (repo: PerimeterRepo, suffix = ""): string =>
    `${repo.name} (${repo.branch ?? "detached"} @ ${repo.head !== undefined && repo.head !== "" ? repo.head.slice(0, 7) : "unknown"}${suffix})`;
  const others = perimeter.roots.map(root => {
    if (root.name === PERIMETER_UNPLANNED) return PERIMETER_UNPLANNED;
    if (root.status === "unadmitted") return `${root.name} (not admitted)`;
    if (root.status === "unobserved") return `${root.name} (not observed)`;
    return root.status === "changed" ? show(root, ", changed during the dispatch") : show(root);
  });
  return `verified scope: ${show(perimeter.w)}; also observed: ${others.join(", ")}`;
}
