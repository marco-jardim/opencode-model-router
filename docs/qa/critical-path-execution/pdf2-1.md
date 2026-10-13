# Dogfood fix phase pdf2-1 — executor work loss, stale base, orchestrator-shell criteria, read cap

Base `a682009` (tag `cpx/pdf2-1-base`), worktree `D:\git\omr-cpx-pdf2-1`, branch `cpx/pdf2-1`. Opened during DF2.5
(Phase 6.1 through the executor), which is paused on these faults. Design: architect `ses_ec90ae674ffe8Nf6KIa9NkfQaB`.

## Faults (from the ledger of `critical-path-execution-plan-6-1-db-6-1`)

- **DF-2-4 (blocking):** work of an interrupted attempt is destroyed. Every child stop (`ESCALATE:`, `NEED MORE:`) parks
  the task and releases its slot; the next attempt's `launchStep` always resets the slot (`runtime.ts:1430-1432`);
  `NEED MORE: budget` is classified as an ambiguity (`runtime.ts:269`), never resumed. 6.1.1 lost a finished attempt;
  6.1.2 cannot finish inside one dispatch and loops.
- **DF-2-5:** executor launches carry no `CAP:` line and drop the route's `budget=` (`expand.ts:307`).
- **DF-2-6:** the compile takes `baseCommit = rev-parse HEAD` in the plan file's checkout (`compile/index.ts:343-351,
  657`), not the base branch tip; `acquireSpecial` starts at the toplevel's live HEAD (`pool.ts:1400`).
- **DF-2-7:** `criteria:` lines marked "(orchestrator shell)" reach the child prompt and the grader, so children escalate
  for checks only the orchestrator may run.

## Design

- **(a) Resume on `NEED MORE: budget`.** New classification `budget` (and the router budget note). The same attempt
  resumes the same child session (`ChildRunRequest.resumeSessionID`, honoured by the runner, `v2-client.ts:194`) with
  "continue and finish", keeping slot, leases and branch; event `attempt-resumed`, `Attempt.resumes` (optional); cap
  `BUDGET_RESUMES = 3`, then park with cause `budget-cap`. `E_NO_CONTEXT` parks (work kept by (b)). No new
  `verifier.begin`. The launcher confirms a resume on its first step and creates no child.
- **(b) No lost work.** Before any reset or release of a slot the task still holds, a WIP snapshot (`git add -A`,
  commit with trailer `Omr-Wip: <plan>/<task>/<n>/<nonce>`, never `Omr-Attempt`) is stored at
  `refs/heads/omr/<plan>/wip/<task>`. After the reset, the next attempt restores it with `cherry-pick --no-commit` on top
  of the integration head (HEAD stays the base) and its prompt says the previous work is in the work root. Conflict:
  reset and park, ref kept. A dirty slot with no owner goes to `omr/<plan>/orphan/<slot>-<ts>`. Purge removes the refs.
  The verifier's base/candidate is unchanged (one task commit with every attempt's work); integration sees one
  `Omr-Attempt` commit per task.
- **(c) Fresh base.** `baseBranch` from the toplevel (detached HEAD refused), `baseCommit = rev-parse
  refs/heads/<baseBranch>` at compile; approve re-reads it and refuses `E_STALE_BASE` when it moved; `acquireSpecial`
  starts at the ledger's integration head. `ff-when-clean` landing unchanged.
- **(d)** One predicate `/\(orchestrator shell\)/i` in `expand.ts` (prompt: skipped, plus a note that the orchestrator
  runs them) and `plan-task.ts` (dropped from the grader's criteria).
- **(e)** `expand.ts` keeps `budget=` and writes one `CAP:` line (task CAP, else `CAP:12` for editing tasks). Also check
  why a `CAP:none` + `reason:` dispatch was capped at 12 (`index.ts:1711-1716`).

## Recovery of the paused 6.1 plan (orchestrator decision)

Abort and recompile under `cpx/df2.1` (base becomes the live `cpx/main` tip; no landing amendment). Q-7/Q-8 are not
answered. Salvage (`%LOCALAPPDATA%\omr-cpx\df2-salvage`) is seeded before approve as WIP refs of the new plan from a
scratch worktree (never a slot); the executor restores them at attempt 1 (A-DF2-4). The "(orchestrator shell)"
smoke criterion is run by the orchestrator after 6.1.1 integrates (A-DF2-3).

## Tasks

- W1 [heavy] runtime/types/ledger/unattended/git: (a) runtime + (b) snapshot/restore + contract types.
- W2 [medium] launch/expand/plan-task: (a) launcher resume, (d), (e).
- W3 [medium] compile/pool/create + docs/CHANGELOG: (c), EXECUTOR.md.
- W4 [medium] `test/integration/v2-executor-resume.test.ts`: A13 budget resume, A14 escalate with a dirty slot keeps
  work across attempts, A15 stale base refused.
- QA [heavy], fixes per §0.7, tag `cpx/df2.1` on the head.
