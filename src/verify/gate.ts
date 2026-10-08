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
import type { DeterministicDeps } from "./types";
import type { DoD } from "./dod";
import { isCheckable } from "./dod";
import { runDeterministic } from "./deterministic";
import { incompleteVerdict, isIncompleteVerdict, runChecker } from "./checker";
import type { ArtefactView, CheckerDeps } from "./checker";
import type { BudgetSnapshot } from "../guard/enforce";
import { isAbsolute } from "node:path";
import { isWithinDir, resolveBaseDir } from "./paths";

/** The concrete, inspectable result of a delegation (artefact contract §3.3). */
export interface Artefact {
  changeBaseline?: "available" | "unavailable";
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
  const effectiveBaseDir = resolveBaseDir(
    delegation.cwd,
    workRoot ?? deps.deterministic.cwd,
  );
  // Backstop for a caller that did not check its cwd: lexical only (no filesystem call); a checked canonical cwd always passes.
  if (workRoot !== undefined && !isWithinDir(effectiveBaseDir, workRoot)) return refuseCwd(effectiveBaseDir);
  const canonical = deps.canonicalPath ?? ((path: string) => path);

  let verdict: Verdict;
  if (dod.kind === "deterministic") {
    const canonicalBase = canonical(effectiveBaseDir);
    if (artefact.changedFiles.length > 0 && artefact.changedFiles.every(
      ({ path }) => isAbsolute(path) && !isWithinDir(canonical(path), canonicalBase),
    )) {
      // QA-P33F1-1 nit 1: a cwd: narrower than the work root, with work elsewhere in the root → widen (or drop) the cwd:.
      const narrowed = workRoot !== undefined && !isWithinDir(canonical(workRoot), canonicalBase)
        && artefact.changedFiles.some(({ path }) => isWithinDir(canonical(path), canonical(workRoot)));
      const hint = workRoot === undefined
        ? `Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.`
        : narrowed
          ? `The [acceptance] block's "cwd:" narrows verification to ${effectiveBaseDir} inside the work root ${workRoot}: widen "cwd:" to where the work landed, or remove it (the checks then run in the work root).`
          : `A role dispatch is verified only inside its work root ${workRoot}: the work belongs there.`;
      const reason = `the producer changed files only outside ${effectiveBaseDir} (e.g. ${artefact.changedFiles[0].path}); checks run there cannot see them. ${hint}`;
      return gateResult({ pass: false, outcome: "unverifiable", method: "none", reasons: [reason], caveats: [reason] }, dodSource, deps.strictUnverifiable);
    }
    verdict = await runDeterministic(dod, {
      ...deps.deterministic,
      cwd: effectiveBaseDir,
    });
  } else {
    // "checker" is the only remaining checkable kind.
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

  return gateResult(verdict, dodSource, deps.strictUnverifiable);
}
