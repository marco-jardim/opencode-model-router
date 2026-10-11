# Critical-Path Execution — background-first dispatch and a parallel plan executor (OpenCode v2)

> **Status:** Ready for execution (plan QA: five adversarial rounds, all findings fixed; see the end of this file) **Date:** 2026-10-10
> **Owner:** Marco Jardim (solo developer; no review gate)
> **Host scope:** OpenCode v2 only. OpenCode v1 is in feature freeze ([AGENTS.md](../../AGENTS.md), "Host support policy"):
> every feature in this plan is inert on v1, with at most one notice per process, and v1 output stays byte-identical.
> **Base branch:** `master` (`origin/master`) **Branch prefix:** `cpx/` **Integration branch:** `cpx/main` (worktree
> `D:\git\omr-cpx-main`)
> **Dedicated worktree (§0.13):** another implementation of this repository is in progress in the main checkout
> `D:\git\opencode-model-router`. This plan lives and runs only in `D:\git\omr-cpx-main` (branch `cpx/main`, created
> 2026-10-10 from `origin/master` `b716ee9`, no upstream), in its phase worktrees and in its dogfood worktree. It never
> touches the main checkout.
> **ADR:** `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md` (Phase 0.1)
> **Handover (resume state):** `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md` (§0.11)
> **Kickoff:** the prompt that starts execution is §0 of the handover file.
> **QA reports:** `D:\git\omr-cpx-main\docs\qa\critical-path-execution\` **Issue:** none yet (§0.3)
> **Executor of this plan:** one high-capability orchestrator LLM using the model router in roles mode, from Pre-flight 0.P to
> Phase 6.2 without interruption (§0.1).
> **Dogfood (§0.12):** the plan runs on its own implementation as it lands. At DF-1, after Phase 2.1, the running OpenCode
> host switches to the plan's build, so dispatches made after the DF-1 restart run with background-first dispatch, leases, the cache-stable turn
> state, telemetry and persistent pending verifications. At DF-2, after Phase 5.1, the executor itself runs Phase 6.1 of
> this plan on the real repository. Real use is the acceptance test; every dogfood fault becomes a finding with a
> regression test.

---

## Objective

A large plan (about 100 small or medium tasks, several waves and phases, 1k+ lines) must finish in a wall-clock time as
close as possible to its **critical path**, and the human must stop acting as the scheduler. Today the owner manually
backgrounds slow delegations and long test runs, and the orchestrator session sits blocked on work it does not depend on.

The definitive solution has two parts that share one engine:

1. **Background-first dispatch** for every OpenCode v2 delegation. Long dispatches return at once and the orchestrator keeps
   working. Every router guarantee is applied **when the child completes**, not when the tool call returns: budget and
   authority annotations, deferred and required verification, change-set capture, telemetry. Per-turn router state leaves
   the system prompt, so the orchestrator's prompt cache survives every wake-up. Pending verifications survive restarts.
2. **A plan executor.** A plan, annotated or not, is compiled into a durable dependency graph (the ledger). Ready tasks are
   launched in parallel in isolated git worktree slots, verified, and integrated by a serial queue into a plan integration
   branch that is always green. Phase suites with culprit bisection, revert and reopen, an automated QA → fix loop,
   adaptive concurrency, an inbox for questions and restart recovery let it run unattended. Tasks are launched by the
   executor itself through the router's existing child-runner path when the host allows it (C14), otherwise by the
   orchestrator by reference.

### Problem today (evidence; anchors from commit `b7984b3`, re-based in 0.P.4 to the recorded `origin/master` commit)

| # | Symptom | Evidence |
|---|---|---|
| P1 | Every role dispatch is forced to the foreground | `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈78-87 (`nativeArgs`), ≈1539-1540, ≈1604 (`roleForeground = true`), ≈1631; `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts` ≈1764-1769. Rationale P-5: annotate the result in `execute.after` (`D:\git\omr-cpx-main\docs\plans\role-tier-assurance-delegation-plan.md` ≈1111-1113) |
| P2 | Every verified dispatch is forced to the foreground | `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈86, ≈1746-1748 |
| P3 | A dispatch the user backgrounds loses every guarantee | early return `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1746-1761 before the legacy after-hook ≈1775; `D:\git\omr-cpx-main\docs\qa\role-tier\phase-p01.md` ≈92; `D:\git\omr-cpx-main\docs\OPENCODE_V2.md` ≈108-116 |
| P4 | Per-turn state lives in the system prompt, so each change invalidates the cached history (cache order: tools → system → messages) | `D:\git\omr-cpx-main\src\index.ts` ≈3057-3074; `D:\git\omr-cpx-main\src\routing\wire\hint.ts` ≈213-215; the cost doctor was already moved out for this reason (`D:\git\omr-cpx-main\src\index.ts` ≈3045-3047, QA-2.4-9) |
| P5 | Pending verifications are in memory, expire in 1 h and vanish on restart | `D:\git\omr-cpx-main\src\verify\pending.ts` ≈340-341; `D:\git\omr-cpx-main\src\router\config.ts` ≈2991 |
| P6 | No dispatch duration is recorded | `DecisionRow` in `D:\git\omr-cpx-main\src\routing\outcomes\types.ts` ≈583-603 |
| P7 | A plan is a flat ordered list without dependencies; step ids are line numbers | `D:\git\omr-cpx-main\src\routing\engine\plan.ts` ≈46-84, ≈273; `D:\git\omr-cpx-main\src\routing\commands\annotate-plan.ts` ≈287 |
| P8 | No isolation and no integration; concurrency is only counted | no apply/rebase/merge code in `D:\git\omr-cpx-main\src\verify` or `D:\git\omr-cpx-main\src\router`; `D:\git\omr-cpx-main\src\verify\dispatch.ts` ≈456-463 |
| P9 | Nothing prevents two agents from writing, or reading while another writes, the same file | `D:\git\omr-cpx-main\src\verify\dispatch.ts` ≈209-238 (attribution after the fact) |
| P10 | `router_run` blocks its caller for up to 10 min | `D:\git\omr-cpx-main\src\router\run-tools.ts` ≈99, ≈853-861 |

### Target (proven in Phase 6.1, gated in §5)

- On a dedicated fixture run with no 429, no question and no restart: makespan ≤ 1.3 × max(CP, W/p, ΣI), where CP and W
  come from task durations scripted before the run, p is the configured `maxParallel` and ΣI is the measured serial
  integration time.
- No idle-with-ready interval longer than 10 s: whenever a ready task and free capacity exist, it is launched (launcher A, ADR 0007 D14). *Amended by A-0.1-2.*
- No file is written by two agents at once.
- No file in a shared working tree is read through an agent's file or search tools while a child agent holds its write
  lease. A `router_run` started in that tree is annotated as possibly contaminated, or refused under
  `routing.leases.run: "refuse"`.
- The plan's own execution after DF-1 and DF-2 (§0.12) shows these properties under real use.
- The plan integration branch never points at a commit whose integration checks failed.
- A host restart mid-plan loses no completed work and integrates no task twice.
- On v2, consecutive orchestrator requests are byte-identical through the previous request's messages.

---

<!-- plan-context -->
**Context for every task of this plan** (sent verbatim to every delegated task by the plan executor; it contains no
paths on purpose, because each task runs in its own worktree or slot).
- Repository: the opencode-model-router OpenCode plugin (TypeScript, Node 22+, vitest). The OpenCode v2 adapter is the
  `compat` v2 hooks module; the legacy plugin entry is the root `index` module. New features are OpenCode v2 only and
  inert on v1, as the repository's AGENTS.md "Host support policy" requires.
- Work only inside your work root; the paths in your task are already rewritten to it. Write only the files listed in
  your task's `Writes:`.
- Never run git and never commit: the executor commits for you. Never add AI attribution (no `Co-Authored-By` naming a
  model or vendor, no "Generated with …") in code, comments, docs or messages.
- Never suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`), never leave an empty `catch`, never delete,
  skip or weaken a test, a golden or a docs-drift pin.
- Check your work with `router_run` (`typecheck`, and `test-files` with repo-relative forward-slash test paths).
- Finish with `DONE:` (what changed, check results), or `NEED MORE:` / `ESCALATE:` with the reason.
- QA tasks return only the `FINDINGS_FORMAT` JSON, with no `DONE:` line.
<!-- /plan-context -->

## 0. Execution directives (read first — these override defaults)

### 0.1 Run the whole plan without stopping

Execute Pre-flight 0.P, then every phase as soon as its start rule (§0.6-2) allows, wave after wave, through Phase 6.2,
**without pausing for confirmation**. After any host restart or context compaction, **re-read the handover file first**
(§0.11) and continue from its "next action". Stop and ask the human **only** when one of these occurs:

1. **Ambiguity that blocks all reasonable progress** and is not resolved by this plan, ADR 0007 or the code. An ambiguity
   with a reasonable default is resolved with the recommended option, recorded, and is not a stop (§0.14-1).
2. **Critical problem:** a security regression, a risk of data loss in a user repository or worktree, a change that would
   alter OpenCode v1 behavior, or a corrupted git state that cannot be restored from a known-good commit.
3. **Blocking problem:** a host contract (§2, C1–C15) contradicts its decision row in a way its fallback does not cover;
   the failure-recovery path (§0.8) is exhausted; or a `blocking` or `critical` QA finding is still open after the
   bounded rounds (§0.7). Missing binaries, configuration and the shell are checked once in 0.P, so they stop
   the run there and never mid-plan.

**Planned human actions** are not interruptions. They are prepared so that the human only restarts OpenCode and types
`continue`:
- the 0.P.3 configuration stop (only if something is missing);
- the 0.P.3.f owner consent;
- the DF-0 switch (0.P.6) when needed;
- dogfood switches DF-1 and DF-2 (§0.12);
- a dogfood rollback (§0.12-6);
- the 6.2.5 restart.

A rate-limit or usage-limit error is never a stop and never a failed attempt (§0.6-11).

Everything else — QA findings, test failures, conflicts between phase branches, drifted line anchors, dogfood faults
that have a workaround — is resolved without asking.

### 0.2 Definitive solutions only

- Each phase delivers its component in final form. **Do not** ship stubs, TODO placeholders, mock implementations in
  `D:\git\omr-cpx-main\src\`, flags that hide half-built code, or "minimal now, real later" splits.
- Where a host contract decides between two designs (C5, C6, C11, C14, C15), the phase implements the branch ADR 0007
  selected, and only that branch. That is a decided design, not a partial delivery.
- The interfaces fixed in Phase 1.4 (`D:\git\omr-cpx-main\src\executor\types.ts`) are the only cross-phase
  contract. An amendment is recorded in ADR 0007 and applied by the orchestrator (or one implementer it dispatches) in
  `D:\git\omr-cpx-main`. Each in-flight phase merges `cpx/main` at its next point with no writer in flight.
- Never suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`), never write an empty `catch`, never delete,
  skip or weaken a failing test or a docs-drift pin.

### 0.3 Commit often

- The orchestrator commits each finished task as soon as its verification passes, with
  `git -C <worktree> add -- <that task's Writes:>` then commit, and only while no sibling task holding a write lease in
  that worktree is in flight (otherwise right after it finishes). "Green" = that task's verification verdict, plus
  `npm run typecheck` at each join of the phase's "Order:" line. Never commit a red tree.
- Conventional Commits, `type(scope): summary`. Scopes: `outcomes`, `cache`, `leases`, `background`, `pending`,
  `executor`, `ledger`, `compile`, `slots`, `integrate`, `plan`, `docs`, `test`.
- There is no issue for this plan. If the owner opens one, commit bodies carry `Refs #<n>`; until then no `Refs` trailer.
- QA fixes are their own commits: `fix(<scope>): address QA-<phase>-<n> <summary>`.
- **No AI attribution, ever:** no `Co-Authored-By` trailer naming a model or vendor, no "Generated with …" line, in any
  commit, PR, code comment or doc. Every delegate is told this in its MUST NOT DO section.
- Push after every commit: `git -C D:\git\omr-cpx-p<id> push -u origin cpx/p<id>`.
- `D:\git\omr-cpx-main\CHANGELOG.md` is written only by the orchestrator, in `D:\git\omr-cpx-main`, when a phase
  merges. It adds one bullet per user-visible change under `## [Unreleased]`, using Keep a Changelog headings.

### 0.4 Paths

- Every file reference in dispatches, commits, QA reports and code comments uses the **full path**.
- This plan writes full paths under `D:\git\omr-cpx-main\`, the plan's integration worktree (§0.13). In a dispatch,
  substitute the dispatch's worktree root: in Phase 2.1, `D:\git\omr-cpx-main\src\compat\background.ts` is
  `D:\git\omr-cpx-p21\src\compat\background.ts`; in an executor slot, the slot root. Before every dispatch and every
  file read of its own, the orchestrator checks that nothing it sends or runs names `D:\git\opencode-model-router`: the
  guard applies to `root=`, `cwd:`, `Writes:`/`Reads:` lines, tool arguments and shell commands; prose that names the
  off-limits checkout is allowed. A hit is a defect and is never sent (§0.13). *Amended by QA-0.P-10/QA-0.P-20:* the
  guard compares **normalized** paths (case-folded, `/` → `\`, trailing separator trimmed; a prefix match), because the
  router normalizes `root=` before validating it, and it has one scope list:
  - `D:\git\opencode-model-router` and the other implementation's worktree `D:\git\opencode-model-router-cross-repo`:
    never in `root=`, `cwd:`, `Writes:`/`Reads:`, a tool argument or a shell command that reads, writes or runs there;
  - `D:\git\omr-cpx-dogfood-*`: never in `root=`, `cwd:` or `Writes:`, and never written by a command (they are valid
    git worktrees, so the router would accept them, but a dogfood worktree is never edited, §0.12-1); running its
    scripts read-only (§0.12-5 `routing-stats.ts`) is allowed.

  Prose, and log-search patterns that only match text in a log file, are allowed for all three.
- The substitution also applies to the orchestrator's own reads and writes of phase files (phase reports, implementation
  notes, handoffs): they live in the phase worktree. Only these are literal paths in `D:\git\omr-cpx-main`: the
  handover, `CHANGELOG.md`, `dogfood.md`, `preflight.md`, `global.md`, the plan file and its amendments, ADR 0007
  amendments, `src\executor\types.ts` amendments, and `.opencode\`. In a dispatch every path is substituted: a literal
  file is read as its committed copy in the dispatch's worktree. Literal paths apply only to the orchestrator's own
  reads and writes.
- **Single exception: command-line arguments.** Arguments that tools require to be repo-relative use forward slashes.
  This covers `router_run` arguments, whose charset has no `\`
  (`D:\git\omr-cpx-main\src\router\run-tools.ts` ≈78), and vitest file and `--coverage.include` arguments.
  Example: `test/unit/leases.test.ts`. Everywhere else, full paths.
- Line anchors (`≈1604`) come from commit `b7984b3`. 0.P.4 re-bases them to the recorded `origin/master` commit, and each
  phase pre-flight re-verifies the anchors it uses.

### 0.5 Model-router annotations

| Tag | Use |
|---|---|
| [tier:fast] | lookups, anchor checks, running commands and collecting output |
| [tier:medium] | implementation, tests, docs, writing memos and reports that heavy returned, QA fixes |
| [tier:heavy] | design memos for concurrency, state machines and git invariants; **all QA** |

- **QA is always a [tier:heavy] task. Always apply this rule.** QA is an adversarial review of the work done: the reviewer's
  job is to break it (races, invariants, security, Windows, v1 drift, docs that lie), not to summarize it.
- Route lines in this plan are dispatch-ready. Put each one, **as written (no backticks)**, as the **first line** of the
  dispatch prompt. They carry `root=` (the phase worktree) and `tier=X pin` (protocol rule: a plan step carrying
  `[tier:X]` is dispatched with `tier=X pin`).
- Every task routed with `d=deterministic`, and every `VERIFY:required` task, carries an `[acceptance]` block. Copy that
  block verbatim into the dispatch, with `cwd:` set to the phase worktree.
- Before every phase DoD, run `router_verify` with `pending: true`; every handle must pass.
- Heavy dispatches get context gathered first by [tier:fast] / explorer and pasted into the prompt; never ask heavy "what
  is in this file". Heavy QA uses `CAP:none` **with** a `reason:` line.
- Roles:
  - explorer: recon;
  - runner: commands;
  - implementer: code, tests, docs, memo and report write-ups;
  - architect: design text, read-only;
  - reviewer: QA, read-only, may run checks.

  Architect and reviewer return text. The orchestrator, or an implementer it dispatches, writes that text into the
  ADR or report. **Roles never run git** (§0.10-2).

### 0.6 Parallelism and file safety

Goal: maximum parallelism with zero shared-file hazards — **no file is ever written by two agents at once, and no file is
read by an agent while another agent is editing it.**

1. **Ownership (§3) is law:** a phase writes only the files §3 assigns to it, **including the existing tests of those files**
   (§3.2 note). No two phases that can be in flight together own the same file.

   A phase that needs a change in a file it does not own gets it through an interface in its own files. The owner wires
   it, and the handoff (with the exact text when it is documentation) is recorded in both phase reports under
   `## Handoffs`.
2. **Phase start rule:** a phase starts as soon as (a) every phase in its "Depends on" is merged into `cpx/main`, and (b) no
   in-flight phase writes a file in its write set. Waves only group ownership; they are not barriers.

   At start, the orchestrator runs, in this order:
   1. `git -C D:\git\omr-cpx-main tag cpx/p<id>-base cpx/main`;
   2. `git -C D:\git\omr-cpx-main worktree add -b cpx/p<id> D:\git\omr-cpx-p<id> cpx/p<id>-base`;
   3. `npm ci` in `D:\git\omr-cpx-p<id>`. `npm ci` runs one worktree at a time, to avoid npm-cache EBUSY/EPERM errors on
      Windows. The orchestrator runs no `npm ci` while `router_plan action=status` shows a slot provisioning.

   `<id>` drops the dot: Phase 2.1 → `p21`. Parallel phases never share a working tree.
3. **Within a phase**, the "Order:" line says which tasks may run together. Tasks run in parallel only when their `Writes:`
   are disjoint and no task's `Reads:` intersects another in-flight task's `Writes:`.

   The orchestrator keeps the live table of in-flight write sets in the handover file (§0.11). It never dispatches a task
   whose `Reads:` or `Writes:` intersects the table; such a task waits until the holder commits.
4. **Read-only work** (pre-flight recon, anchor checks) runs before any writer starts in that worktree, or reads immutable
   refs (`router_git_show` at a commit or tag), never files under edit.
5. **QA** reads the phase branch at a fixed commit after every writer has finished and committed. Fixers start only after
   the QA report is final. A re-review reads the new fixed commit after every fixer has committed.
6. **Hubs** have one writer task at a time inside their owning phase:
   - `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`
   - `D:\git\omr-cpx-main\src\index.ts`
   - `D:\git\omr-cpx-main\src\router\config.ts`
   - `D:\git\omr-cpx-main\src\router\protocol.ts`
   - `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`
   - `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`
   - `D:\git\omr-cpx-main\test\golden\`
   - `D:\git\omr-cpx-main\package.json`
   - `D:\git\omr-cpx-main\vitest.config.ts`
7. **Only the orchestrator merges**, serially, in `D:\git\omr-cpx-main`, as soon as a phase's QA is clean:
   1. Run `git -C D:\git\omr-cpx-main merge --no-ff cpx/p<id>`.
   2. Run `npm run typecheck` and the phase's tests.
   3. Run the merged phase's scoped tests plus the tests affected by any conflict resolution (§0.6-9).
   4. Push.

   Conflicts are resolved by the orchestrator, or by one dispatched implementer, never by two agents.
8. **Maximize throughput:**
   - Dispatch every independent task of a phase in one message.
   - Interleave the dispatches of all phases that may run.
   - Never wait idle while a ready task exists.
   - **The running router changes only at the dogfood switches (§0.12).**
     - Before DF-1 it forces role dispatches to the foreground (P1), so parallelism comes from several dispatches per
       message and from concurrent phases.
     - From DF-1 on, long dispatches run in the background. The orchestrator keeps dispatching and working on other
       ready tasks, ends its turn when nothing independent remains, and is woken by completions.
     - From DF-2 on, Phase 6.1 runs through the executor.
9. **Testing policy (owner rule: never the full suite unless this plan requires it).**
   - Test only what a change touches: the existing tests of the touched files (named after the source, or whose `describe` targets it), the tests of new files, and the tests that import a changed non-hub module. Explorer selects them, or the orchestrator runs `npx vitest related --run <changed files>` in its shell.
   - The full suite runs only in the Phase 6.2 pre-flight (once, with coverage, before the PR); CI runs it again on the PR. The executor's phase suite (3.2.4) is a product feature and is not governed by this rule.
   - Accelerate: run independent scoped runs in parallel (several runner dispatches in one message, several worktrees at once); scoped runs use a high worker count, `--maxWorkers=<n>` with `<n>` = the machine's cores minus 2, recorded in 0.P.3.b (split it when two or more worktrees run tests at the same time); `--pool=threads` or `--no-isolate` only for pure-unit files and only after checking `D:\git\omr-cpx-main\vitest.config.ts` (setup files, the home guard).
   - `npm run typecheck` runs at each join of a phase's "Order:" line and before each merge.
   - Smoke suites stay serialized, one at a time across all worktrees (`fileParallelism: false`).
   - Windows flakes (history: #88): a failure that disappears on an isolated rerun (`--maxWorkers=1`) is recorded and fixed as a flake, never skipped.
10. **Isolation from the other implementation (§0.13).** Nothing in this plan reads, writes, runs or checks out anything in
    the main checkout `D:\git\opencode-model-router`.

    The other implementation reaches this plan only through `origin/master`. When `origin/master` moves during execution,
    the orchestrator syncs at the next point with no phase start pending:
    1. runs `git -C D:\git\omr-cpx-main fetch origin`;
    2. merges `origin/master` into `cpx/main` in `D:\git\omr-cpx-main`;
    3. resolves conflicts there;
    4. runs typecheck and the tests affected by the files the merge changed;
    5. records the merge in the handover.

    In-flight phases pick it up at their next point with no writer in flight. A conflict that changes this plan's design
    (for example, the other implementation reworked a file a merged phase depends on) is recorded as an amendment, and
    the affected phases re-run their QA.
11. **Rate limits of the owner's subscriptions** (unknown limits):
    - **Caps:** at most 4 dispatches in flight per provider, of which at most 2 are [tier:heavy].
    - **429 or overload:** halve that provider's cap for 10 min, then restore it one step per successful dispatch.
    - **Usage-limit error:** stop dispatching to that provider until its reset time, record it in the handover, and keep
      working: when a provider is paused, dispatch only tasks whose `[tier:X]` maps to a model of another provider in
      `tiers.json`; the others wait for the reset. When no work remains for another provider, end the turn and resume at the
      reset time.
    - A rate-limit or usage-limit error never counts as a failed attempt (§0.8) and is never a stop.
    - From DF-1 on, the router's own telemetry (`D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`)
      provides the data; from DF-2 on, the executor's capacity controller applies this rule to Phase 6.1.

### 0.7 Pre-flight before each phase, QA after each phase

- **Before any task of a phase:**
  - Run §0.9 plus the phase's own pre-flight items.
  - Record the results under `## Pre-flight` in the phase report.
  - Fix a failed item before the phase starts, or correct this plan with an amendment recorded in the report and in
    `cpx/main`.
- **After the phase's last task and its new tests**, run the senior QA review:
  - [tier:heavy], adversarial, on the phase branch at a fixed commit.
  - Severities: `blocking`, `critical`, `major`, `minor`, `nit`.
  - Finding ids: `QA-<phase>-<n>`.
- **Fix loop — bounded rounds (owner rule):**
  1. Round 1: every finding of every severity gets a [tier:medium] fix ([tier:heavy] when complex, §0.14-3), with a regression test where code changed, in its own commit.
  2. Round 2: heavy re-reviews the round-1 fixes and every area they touched. Every round-2 finding is fixed the same way.
  3. After round 2, only `blocking`, `critical` and `major` findings are fixed; `minor` and `nit` findings are recorded under `## Deferred findings` in the report. Do not re-review to exhaustion: a round 3 runs only when round 2 produced a `blocking`, `critical` or `major` finding, is limited to those fixes, and is the last. A `blocking` or `critical` finding still open after round 3 is a stop (§0.1-3); a `major` one is fixed and verified by its tests without another review.
- **Report:** `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-<id>.md`.
  - It has **one writer: the orchestrator**, or an implementer it dispatches with the heavy output pasted.
  - It is committed in the phase worktree with the phase.
  - Sections: `## Pre-flight`, `## Implementation notes`, `## Findings`, `## Fixes`, `## Deferred findings`, `## Handoffs`, `## Verdict`.

### 0.8 Failure recovery

After **3 consecutive failed attempts on the same issue**:

1. Stop editing.
2. Revert to the last green commit of the phase branch.
3. Record what was attempted and the exact failure in the report and the handover.
4. Dispatch [tier:heavy] with that context pasted.

If heavy's direction also fails after 2 attempts, it is a stop condition (§0.1-3).

### 0.9 Standard pre-flight checklist (every phase)

- [ ] Every phase in "Depends on" is merged in `cpx/main` and its report shows zero open findings.
- [ ] No in-flight phase writes a file in this phase's write set (§3), including the existing tests it owns.
- [ ] Phase worktree created from `cpx/main`, tag `cpx/p<id>-base` set, `npm ci` ran, `git status` clean.
- [ ] `npm run typecheck` green. Scoped baseline at the base: the existing tests of the files this phase owns (§3.2), with
      pre-existing failures listed by test name; that list must not grow.
- [ ] Every line anchor this phase cites re-verified by explorer against the worktree; drifted anchors recorded.
- [ ] The existing test files whose subject is a file this phase owns are listed (named after the source file, or whose `describe` targets it; hub imports
      excluded, §3.2) and checked against other
      in-flight phases.
- [ ] From Wave 1 on, `npm run smoke:cpx` is green (the host contracts still hold).
- [ ] The interfaces of `D:\git\omr-cpx-main\src\executor\types.ts` this phase implements or consumes are unchanged
      since its base, or the change is a recorded ADR amendment.
- [ ] The phase report exists with `## Pre-flight` filled; the handover lists the phase as running.

### 0.10 Execution conduct

1. **Dispatch format.** Every dispatch carries the 7 sections (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO,
   CONTEXT, ENVIRONMENT), plus the task's `Writes:` and `Reads:` lines. ENVIRONMENT:
   `Working directory is D:\git\omr-cpx-p<id> (git worktree of the opencode-model-router repository, branch cpx/p<id>). Platform: win32. Shell: pwsh. Paths are absolute. You are already here; do not ask for permission to read or write inside it.`
2. **Shell work.** The orchestrator runs it with its own shell tool, or through an explicitly dispatched `fast` **tier**
   agent (`agent: fast`) given the exact command list. This covers git (worktree add and remove, commit, push, merge,
   tag), `npm ci`, `npx …` (coverage, smoke suites with `cross-env`) and `gh`. Roles never run these.
3. **Commands for roles through `router_run`:**
   - typecheck: `{script: "typecheck", cwd: "D:\git\omr-cpx-p<id>"}`;
   - scoped tests: `{script: "test-files", args: ["--maxWorkers=<n>", "test/unit/x.test.ts"], cwd: "D:\git\omr-cpx-p<id>"}` (`<n>` per §0.6-9)
     with repo-relative, forward-slash paths in `args`;
   0.P.3.e checks that the `test-files` entry exists. Smoke suites (`smoke:cpx`, `smoke:cpx:provision`, `smoke:cpx:e2e`
   and the other `smoke:*` scripts) can exceed `router_run`'s 600 s default, so they always run through §0.10-2. Every
   smoke run sets `OMR_SMOKE_EVIDENCE_DIR=$env:TEMP\omr-evidence` (0.1.0.e), so no tracked evidence file is rewritten.
   Anything `router_run` refuses goes through §0.10-2.
4. **Smoke prerequisites.** Smoke tests need `OPENCODE_V2_BIN`, an absolute path to the OpenCode v2 executable
   (`D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts` ≈127-131).
5. **Style.** New source files follow the style of their neighbors (sample 2–3 files first). Comments only where behavior
   is not obvious from the code.
6. **Docs.** Every user-visible change is documented in the same phase. A phase that does not own the doc file hands off
   the exact text to that file's next owner, recorded in both reports. A CHANGELOG bullet is added at merge (§0.3).
7. **New `routing.*` config keys.** Each one:
   - is declared with a doc comment and its default in `ROUTING_DEFAULTS`, and resolved in `resolveRouting`
     (`D:\git\omr-cpx-main\src\router\config.ts` ≈3024-3042, ≈3120);
   - is validated with its range;
   - is documented as a row of the routing table in `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`. Rows are
     written without the `routing.` prefix (`| \`executor.maxParallel\` |`); object defaults expand into leaf rows.
   - is pinned by `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts` (≈306-314).
8. **v1.** Every new behavior and every registration is gated on `ctx.routerHost === "v2"`.
   - On v1, a configured `routing.background.*`, `routing.leases.*` or `routing.executor.*` key
     logs one notice per process (`<feature> requires OpenCode v2; ignored`).
   - v1 goldens, v1 help text and v1 `/router stats` output stay byte-identical.
   - Run `npm run smoke:v1` when an OpenCode 1.x executable is on `PATH`.
9. **Golden updates.** Only intentional **v2** text changes update goldens. Existing snapshots in
   `D:\git\omr-cpx-main\test\golden\__snapshots\` stay unchanged, and new v2 snapshots are added. Each change is
   listed with its reason in the phase report.
10. **Coverage.** Every new or changed source file meets at least the existing gate of its directory in
    `D:\git\omr-cpx-main\vitest.config.ts`:
    - `src/router/**` and `src/verify/**`: 90 lines, 90 branches, 90 functions, plus the per-file CI gates;
    - `src/executor/**`: 90/90/90, a gate added in Phase 1.4;
    - elsewhere: at least 90 lines and 85 branches.

    Coverage runs through §0.10-2:
    `npx vitest run --coverage --coverage.include=src/executor/ledger.ts test/unit/executor-ledger.test.ts`.

### 0.11 Handover file

`D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md` is written only by the orchestrator, in
`D:\git\omr-cpx-main`.

**Contents:**
- phase states (waiting, running, QA round n, merged);
- in-flight dispatches with role, session id and `Writes:`/`Reads:`;
- QA round counters;
- amendments;
- the `origin/master` sync state;
- the single **next action**.

The file already exists: the plan author created it with the kickoff prompt and the troubleshooting notes (its sections 0–6), which the orchestrator keeps up to date; its §7 'Live state' holds the items above.

**Updates:** at every dispatch boundary. Committed at every merge and every 10 updates
(`docs(plan): update critical-path execution handover`).

### 0.12 Dogfood protocol — the plan runs on its own implementation

**Purpose.** The scripted end-to-end tests (6.1) prove behavior deterministically. Dogfooding proves it under real models,
the real host, the owner's real subscriptions and this real plan. Both are required.

1. **Build isolation.**
   - The host loads the router from a dogfood worktree checked out **detached** at a dogfood tag. Each switch uses a
     **new** worktree: `D:\git\omr-cpx-dogfood-df<n>` at tag `cpx/df<n>` (`D:\git\omr-cpx-dogfood-df<n>.<k>` at
     `cpx/df<n>.<k>` for fix re-switches). `npm ci` runs in it.
   - A dogfood worktree is never edited, and nothing is committed from it. It is removed only after the host no longer
     loads it; earlier ones are kept for rollback until 6.2.5.
   - Phase worktrees and `D:\git\omr-cpx-main` are never loaded by the host, so edits in progress never affect the running
     router.
2. **Plugin entry, scoped away from the other implementation (§0.13-5).**
   - 0.P.3.f records how the running OpenCode loads the router: the plugin entry, its config file and the current target.
   - It backs that config file up to `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup` (outside every repository, never
     committed).
   - A switch points the router plugin entry at that switch's dogfood worktree, using the narrowest scope the host
     supports.
     The scopes, in order of preference:
     1. **A config scoped to this plan's OpenCode process.** A separate config file outside every repository, for
        example `$env:LOCALAPPDATA\omr-cpx\opencode.dogfood.json`, selected for this plan's OpenCode launch through the
        host's config-path environment variable. The owner's other sessions keep their router.
     2. **A project-level config** in `D:\git\omr-cpx-main` that the host merges over the global one. It is never
        committed, and it must not load the router twice; the self-check verifies this.
     3. **The global plugin entry.** Only with the owner's explicit consent at 0.P.3.f, because the other
        implementation's sessions then also run on the dogfood build after their next restart.

     0.P.3.f records the chosen scope, the exact launch or config change, and how to revert it.
3. **Switch procedure (DF-n).**
   1. Precondition, on `cpx/main` (during the DF-2 freeze: the `cpx/pdf2-<k>` head after its QA), with shell runs per
      §0.10-2: the triggering phase is merged (during the freeze: its QA passed); typecheck, the scoped tests of every phase merged since the previous switch,
      `npm run smoke:cpx` and `npm run smoke:v2` are green. Then tag `cpx/df<n>` (`cpx/df<n>.<k>` for a fix re-switch)
      and push the tag.
   2. Drain: dispatch nothing new; while a plan runs, first `router_plan action=pause` (`resume` after the self-check).
      Wait until every in-flight dispatch has finished and its work is committed. Before
      the restart, run `router_verify pending:true` until every handle is settled. After DF2.1.b, settle other handles
      only with `router_verify handles=[…]` (never `pending:true`) until DF2.4.a. Write the handover next action:
      "DF-n self-check".
   3. Create the switch's own worktree with
      `git -C D:\git\omr-cpx-main worktree add --detach D:\git\omr-cpx-dogfood-df<n> cpx/df<n>`, then run `npm ci`
      there.
   4. Point the plugin entry (§0.12-2) at `D:\git\omr-cpx-dogfood-df<n>` and record the exact change in the handover.
      Before every restart, write the exact revert command into the handover and show it to the owner.
   5. **Planned human action:** "Restart OpenCode in the recorded way, continue the same session in
      `D:\git\omr-cpx-main`, and type `continue`."
   6. After the restart, re-read the handover and run the DF-n self-check. If it passes, resume. If it fails, apply
      §0.12-6.
4. **Fault policy.**
   - Record every deviation seen while dogfooding as `DF-<n>-<k>` in
     `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`, with its evidence. Deviations include: a
     wrong or missing annotation, a false lease refusal or a missed one, a lost completion, a cache break, a held result
     leak, a crash, a wrong estimate, a stalled plan.
   - Each fault is fixed in a **dogfood fix phase** `pdf<n>-<k>`: worktree `D:\git\omr-cpx-pdf<n>-<k>`, branch
     `cpx/pdf<n>-<k>`, base tag `cpx/pdf<n>-<k>-base`, created from `cpx/main`. It owns exactly the files of the fix,
     follows the start rule (§0.6-2) and the full phase cycle: pre-flight, fix, regression test, heavy QA, merge. A fault
     in a file owned by an in-flight phase is fixed as an added task of that phase, with its QA.
   - A re-switch to `cpx/df<n>.<k>` happens only when the fault hinders execution. Otherwise the fix rides the next
     switch. During the DF-2 freeze, `cpx/df2.<k>` is tagged on the `cpx/pdf2-<k>` head after its QA, and the pdf
     branch is merged into `cpx/main` right after the landing (freeze rule, section "Dogfood switch DF-2").
5. **Metrics.** From 0.P on, the handover records each phase's start and end wall-clock time and the time of every
   dispatch. `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` records, per time window (before DF-1,
   from the handover's timestamps; after DF-1; under DF-2):
   - the number of background dispatches, and the share of dispatches forced to the foreground;
   - the orchestrator's idle-with-ready time, taken from its own dispatch log;
   - the orchestrator cache-read share and dispatch durations: the orchestrator runs
     `node D:\git\omr-cpx-dogfood-df<n>\scripts\routing-stats.ts` in its shell, with `--dir <routing.outcomes.path>`
     when that key is set (on v2 its output equals `/router stats`, D18);
   - lease refusals and contaminated `router_run` annotations;
   - pending verifications recovered after a restart.

   From DF-2 on, the executor's Appendix D metrics are recorded for Phase 6.1. 6.2.0 compares the time windows before
   DF-1, after DF-1 and under DF-2, and reports the result in ADR 0007 and `D:\git\omr-cpx-main\docs\EXECUTOR.md`.
6. **Rollback.** If the dogfood build blocks execution and there is no workaround:
   1. Run the revert command recorded in the handover: restore the plugin entry from the backup, or point it back at the
      previous dogfood worktree.
   2. Planned human action: restart.
   3. Continue on the previous build.

   The fault is fixed under §0.12-4 before the next switch.

### 0.13 Dedicated worktree — another implementation is in progress in the main checkout

1. **The main checkout is off-limits.** `D:\git\opencode-model-router` holds another implementation of this repository,
   in progress and owned by the owner. At plan time it is on local `master` at `71dcfab`, 1 commit ahead of and 6 behind
   `origin/master`. This plan never does any of the following there:
   - read, edit or stage files;
   - commit, stash, clean, reset or restore;
   - check out a branch, pull or fetch into its branch;
   - run commands.

   This plan also never pushes to `master`.
2. **The plan's home** is `D:\git\omr-cpx-main`, branch `cpx/main`. The plan author created it on 2026-10-10 from
   `origin/master` (`b716ee9`).
   - It has no upstream, so a bare `git push` cannot target `master`. 0.P.1 sets its upstream to `origin/cpx/main`.
   - At creation it contains this plan file and its handover file, both untracked; 0.P.1 commits them.
   - Every phase worktree, every dogfood worktree and every executor slot are created from `cpx/main` with
     `git -C D:\git\omr-cpx-main …`. They share the repository's object store; nothing is cloned.
3. **Delegates.** Every dispatch's work root (`root=`) is a phase worktree, `D:\git\omr-cpx-main` or an executor slot,
   never the main checkout. Paths in this plan under `D:\git\omr-cpx-main\` mean the same repo-relative path in the
   dispatch's worktree (§0.4).
4. **The orchestrator session** runs with its directory at `D:\git\omr-cpx-main` (moved there on 2026-10-10). After any
   restart, open or continue the session there.
5. **Shared global state** with the other implementation, and how it is contained:
   - the OpenCode configuration: the global override (`routing.workRoots`, 0.P.3.c; the trusted
     `routing.executor.slotsDir` and `routing.executor.phaseSuite`, DF-2 pre-flight; additive only), the project and
     global layers (plan-scoped keys live only in the project layer of
     `D:\git\omr-cpx-main`), and the dogfood plugin entry (§0.12-2, scoped per 0.P.3.f);
   - the machine-wide verification slot;
   - the provider subscriptions, whose shared limits are handled by §0.6-11;
   - the git object store, the ref namespaces `cpx/*` and `omr/*`, and `git worktree list`: every phase worktree and
     slot is visible to the other implementation's role agents. Slot GC never runs `git worktree prune` (2.4.3.c);
   - the executor home `<git common dir>\omr-executor\`, which lives in the repository's git common directory (inside
     the main checkout's `.git`) and is accessed only through `router_plan`, never by path: recovery adopts only ledgers
     whose `repo.toplevel` is the plugin session's toplevel (D16), and 6.2.3 removes this run's plans with
     `router_plan action=purge`;
   - the outcome store directory (`routing.outcomes.path`, default `%TEMP%\opencode-model-router-trajectory`),
     including `pending.jsonl`.

   Nothing else is shared.
6. **Delivery** is the PR `cpx/main` → `master` (6.2.4). This plan never updates the local `master` of the main checkout.
   The owner pulls when the other implementation allows it.

### 0.14 Owner execution rules (binding; restated in the handover's kickoff prompt)

1. **Iterate continuously.** Stop only for a blocking or critical problem (§0.1). An ambiguity is a stop only when it
   blocks all reasonable progress; otherwise take the recommended option, record it in the handover and the phase
   report, and continue.
2. **Momentary takeover.** When the model-router blocks the work repeatedly — verbose, circular or off-target output from
   a less capable agent, zero-tool-call hand-backs, budget exhaustion twice on the same task, NEED MORE/ESCALATE loops —
   re-dispatch once with an explicit instruction to attempt the work. If it fails again, the orchestrator does the
   blocked read or implementation itself: it is a top-tier model, extremely intelligent and capable. It keeps the
   ownership and file-safety rules (§0.6), logs the takeover in the handover (§0.11), and goes back to delegating. This
   overrides the router protocol's limit on the orchestrator's direct calls, for that task only.
3. **Delegation.** Always through the model-router, preferring atomic tasks (one module, one test file, or about 20
   edits). Implementation goes to implementer roles at [tier:medium]; complex coding (concurrency, state machines, git
   invariants, races, recovery) may be pinned [tier:heavy]. Heavy gets the heavy lift only: explorer gathers the context
   first and it is pasted in; running the tests and collecting the results go to runner dispatches ([tier:fast]);
   mechanical fixes after heavy work go to [tier:medium].
4. **QA** is always [tier:heavy] and adversarial, after every phase, with bounded rounds (§0.7).
5. **Pre-flight** fixes everything it finds; only what the plan schedules for a later phase is documented ("deferred by
   plan").
6. **Tests:** never the full suite unless this plan requires it; only what the change touches; accelerated (§0.6-9).
7. **Commit often** (§0.3).
8. **Tracking.** Linear is not used by this project (checked 2026-10-10: no Linear references in the repository and no
   Linear integration in the session). If Phase 0.P finds Linear in use, update the matching issues at every phase
   boundary. GitHub: no issue for this plan; if the owner opens one, add `Refs #<n>` to commits and comment at each wave
   boundary.
9. **Worktree reporting.** The handover always records the working worktree directory (`D:\git\omr-cpx-main`, and each
   phase worktree in flight) and the base repository directory (`D:\git\opencode-model-router`, off-limits, §0.13);
   every dispatch's ENVIRONMENT names its worktree.

---

## 1. Design (ADR 0007 records these decisions)

### 1.1 Decisions

| Id | Decision |
|---|---|
| D1 | **Background-first** (`routing.background.mode`, default `auto`). An explicit model `background` value is honored. When it is unset, the dispatch runs in the background if any of these holds: the estimate has `n ≥ minSamples` and p50 ≥ `routing.background.minPredictedMs` (default 45000); the acceptance block has `testsPass` or `buildPasses`; it is a plan task. An estimate whose `source` is `"prior"` never selects background by itself. Required verification runs in the background only when C4 and C15 hold (D3); otherwise it stays in the foreground, as today. `off` reproduces today's `nativeArgs` exactly: `background:false` only for verifying or routed role calls; otherwise the caller's value passes through and no key is added. |
| D2 | **Guarantees at completion.** A completion processor keyed by child session id runs everything that today's `execute.after` does for a finished dispatch: budget and authority signals, deferred-verification registration, change-set capture at child end, verification enqueue, timing. It runs exactly once per child attempt, triggered by whichever comes first: the child's execution-end event or the completion message seen in the parent's context. User-backgrounded dispatches (P3) get the same guarantees. **Foreground** dispatches keep today's in-result annotation in `execute.after`; the end-event trigger is suppressed while that call's `execute.after` is pending, so `off` and foreground output stay byte-identical. For **background** dispatches, the annotations (budget, authority, depth banner, verification handle) go in the turn-state tail's "completed" section (Appendix B), on every request of the parent's next turn. When the context hook builds the first request after a completion, it waits up to 2000 ms for `settled(child)`. If the child is not settled by then, the section shows "router guarantees pending" and the annotation appears in the next request. Past messages are never rewritten for annotations, and nothing is appended to history for them. |
| D3 | **Held results** (only when C4 and C15 hold). For a background dispatch under required verification, the host's completion message is rewritten, for the life of the session, to a fixed placeholder (`held — verdict pending (vrf_…)`) that never changes, including in compaction (C15). On the verdict, a new synthetic entry delivers the output with the verdict (PASS) or the findings (FAIL) and wakes the parent once (`resume: true`). A `subagent` resume of a held child is refused until its verdict. Plan tasks never need holding: their output is consumed by the executor, and integration requires a PASS. |
| D4 | **Cache-stable turn state.** On v2, all per-turn router state is rendered by one builder into a tail, regenerated on every request and never persisted. The state covers: in-flight dispatches, held results, pending verdicts, unread late notices (kept until `router_verify` reads them), the advise hint, plan state and inbox. *Amended by A-0.1-2:* The tail is a new last message with role `user` (C5). The context hook also sets `cache: {type: "ephemeral"}` on a copy of the last text part of the last real message, so the host's only message breakpoint sits on real history and never on the tail (ADR 0007 D4; C5/D4/O8). *Amended by A-1.2-1:* the hint target is the last non-blank text part of the last real message, else its last `tool-result` or `media` part, else no hint, never an earlier message; "never on the tail" holds while the host's four-marker budget is used (with a single system part, no tools or no router hint the host may mark the tail itself). The system prompt stays byte-stable. v1 keeps today's system-prompt path. |
| D5 | **Prompt-cache TTL.** *Withdrawn by A-0.1-3 (QA-0.1-17), OpenCode v2.0.26: no `routing.promptCache.ttl` key, no TTL hint, the system array is never changed; the text below is superseded and kept as history. Reinstating needs a host that lets plugins set the tools breakpoint TTL (ADR 0007 D5).* *Amended by A-0.1-2:* C6 holds: the plugin `CacheHint` `cache: {type: "ephemeral", ttlSeconds: 3600}` reaches the wire as `cache_control {type: "ephemeral", ttl: "1h"}`. `routing.promptCache.ttl` (`"auto" | "5m" | "1h"`, default `"auto"` = `1h` while the session has background activity or a running plan, otherwise the host default). While it resolves to `1h`, a copy of the last system part and the D4 hint part carry the hint; every other breakpoint stays the host's. No TTL is emitted until the real-provider acceptance check of ADR 0007 O11 is recorded. |
| D6 | **Telemetry.** Every dispatch's start, end, role, class, scope, tier, model and outcome goes to `timings.jsonl`; every orchestrator turn's input, cache-read and cache-write tokens go to `turns.jsonl`; both live in the outcome store. An estimator gives p50/p90 per (role, class, scope), falling back to (role, class), then role, then a prior of 480000 ms. *Amended by A-0.1-2:* A timing row also carries `capacity` (`"rate-limit" | "overload" | "usage-limit" | null`: the last capacity class the child met, from event fields, ADR 0007 D13); rows with a non-null `capacity` are excluded from estimates. The retained-context age of each launcher A launch is an Appendix D metric. |
| D7 | **File leases.** Only **child (delegated) sessions** take leases: on first write, an exclusive lease on the file, keyed by repository and normalized repo-relative path. A root session (the orchestrator or any plain user session) takes none; its writes are refused only while a child holds that file. While a child holds a write lease in a working tree, another session in the **same tree** is affected as follows: a **read** of that file is refused, naming the holder; a **directory search** omits leased files and adds a count; a **`router_run`** runs, and its result carries `[router] ran while <holder> edits <n> file(s); result may be contaminated` (refused instead when `routing.leases.run` is `"refuse"`); a **plugin verification run** is deferred until the lease ends or its deadline passes, then runs with today's contamination caveat. A child's leases end at its execution end, its interrupt, or the 6 h sweep. Plan-task leases end at integration. Predicted footprints are scheduling hints; leases are the enforcement. |
| D8 | **Ledger.** The ledger lives under `<git common dir>\omr-executor\<planId>\`: a rotated journal plus an atomic snapshot, with a single-writer lock, a schema version, and an fsync before any externally visible step. The ledger, not the conversation, is the source of truth. |
| D9 | **Compiler.** It runs in four steps. 1. Deterministic extraction: waves, phases, task ids, subtasks, annotations (backticked or not), acceptance blocks, ownership tables, dependency graph blocks, explicit dependency phrases, file paths. 2. One architect dispatch for the residue; its JSON is merged **monotonically** and can only add edges and footprints. 3. Validation: acyclic, known ids, paths inside the repository, concurrency closure. 4. An estimate. Unannotated tasks are classified by the routing engine. |
| D10 | **Isolation.** Plan tasks run in a pool of git worktree slots on the repository's drive. Each slot has its own dependencies, installed once: never a shared `node_modules` or virtualenv, because workspace links and editable installs would load another checkout's code (`D:\git\omr-cpx-main\src\verify\reference.ts` ≈71-78). Between tasks a slot is reset to the integration head; ignored dependency directories survive. A dependency manifest change for any supported manager triggers a re-provision. Integration checks and phase suites first remove every other ignored file. Slot markers live in the executor home, outside every worktree. |
| D11 | **Integration queue.** One per repository, serial. A verified task is rebased onto the integration head in its slot, integration checks run there, and the integration branch moves by **fast-forward only**. A conflict re-queues the task with the conflict as context. Waiting tasks are checked in batches and bisected on failure. When a phase is fully integrated, its full suite runs on the integration commit. A failure is bisected to the culprit, whose revert is built and checked in a slot before it is fast-forwarded, and the culprit is reopened. |
| D12 | **Scheduler.** A task is ready when its dependencies (including phase gates) are integrated or `done`, capacity is free, and its predicted writes are not held. Priority is the bottom level (longest remaining path by estimated duration); ties go by plan order. |
| D13 | **Adaptive capacity.** Per provider, additive-increase/multiplicative-decrease on rate-limit, overload and usage-limit errors. It is capped by `routing.executor.maxParallel` (default 4, because subscription limits are unknown), *Amended by A-0.1-2:* whose valid range is 1–8, the largest concurrency proven by C13 (background children) and C14 (retained launches); raising it needs an ADR amendment backed by `smoke:cpx`. Signals come from event fields (ADR 0007 D13): `session.retry.scheduled` or the `session.hook("retry")` call (429 `provider.rate-limit`, 529 `provider.internal`) and `session.step.failed` (`provider.quota`); the provider comes from the preceding `session.step.started` `model.providerID`. For plan children only, the retry hook stops host retries when the provider is paused or a step has retried longer than `capacityCooldownMs`. |
| D14 | *Amended by A-0.1-2:* **Launcher A** (C14 holds; ADR 0007 D14). The executor launches plan tasks through the router's child runner (`D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈96-236). The runner calls the native `subagent` tool, awaited with `background: false`, using the context retained from the bound orchestrator's latest router tool call, an executor-owned `signal` and a record-only `progress`. It binds the role (agent), model, grant and work root explicitly at child creation (`onCreated`); the child's first context hook fails closed for an unbound plan child. The executor writes the decision row and the timing start itself, because a retained launch fires no `subagent` hook. It applies ADR 0007's six launch guards. Launcher B is not built. A shared plan-context block comes first in every task prompt, so children of the same role reuse the provider cache. |
| D15 | **Unattended operation.** Questions and exhausted tasks are parked in an inbox while independent branches continue. QA steps run as plan tasks that return structured findings; the executor turns the findings into fix tasks and re-review tasks (always [tier:heavy]) until zero findings, with the owner's bounded-round policy: findings of rounds 1 and 2 all produce fix tasks; from round 3 on only `blocking`, `critical` and `major` findings do; the cap is `executor.qaMaxRounds` rounds (default 3), then raises an inbox item. A circuit breaker pauses a phase on systemic failure. *Amended by A-0.1-2:* The orchestrator is woken only for inbox items, a paused phase, plan completion, a `manual` or `preflight` task entering `ready` (once), and a stale launch context (ADR 0007 D14 guard 3). Wakes use the plugin's `ctx.session.synthetic({…, resume: true})` (ADR 0007 O6/O6b), debounced and never twice for the same state. |
| D16 | **Recovery.** On plugin start, every running ledger of the repository is reconciled with host evidence. Recovery adopts only ledgers whose `repo.toplevel` is the plugin session's toplevel. Finished children are processed. Children still alive are adopted, never re-dispatched. *Amended by A-0.1-2:* Lost children are re-queued with a new attempt of outcome `lost`, which does not count toward `maxAttempts`. A child in flight at a host restart is lost (C12: no terminal event, inactive, no completion). Processing dedupes against the persisted pending store and the ledger. A half-done integration is completed or rolled back idempotently. `/plan adopt <planId>` rebinds a plan to a new orchestrator session. |
| D17 | **Gates.** A phase's QA loop gates the next wave (`routing.executor.crossPhase`, default `gate`). With `inferred`, a later task starts when its own inferred dependencies are integrated. |
| D18 | **Trust.** The keys that execute commands or widen permissions (`executor.slotsDir`, `executor.provision`, `executor.python`, `executor.integrationChecks`, `executor.phaseSuite`) are honored only from `tiers.json` and the global override, never from a project-local override, under the existing trust layer (`D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md` ≈883-885). `slotsDir` must be: absolute; on the repository's drive; not a drive root; neither inside nor an ancestor of the repository; free of `*`. |
| D19 | **v1 inert.** Nothing in this plan changes v1 behavior or output (§0.10-8). |
| D20 | **Out of scope.** Cross-repository plans (a separate plan; the ledger is keyed by repository so it can extend), a background mode for `router_run` (long shells run as background runner dispatches or as plugin-run integration checks), *Amended by A-0.1-2:* launching through `session.create` (listed by the v2.0.26 client and plugin session API; parent link, binding, hooks and completion delivery unobserved, ADR 0007 O14), and intercepting provider requests outside the plugin API. |

### 1.2 Executor architecture

```
plan.md ──/plan run──▶ compiler ──▶ ledger (DAG, footprints, states, metrics)  ◀── recovery (plugin start)
                                         │
                       scheduler + capacity ──▶ launcher A: child runner (retained context)   ─┐
                                         │                                                      │
                                         ▼                                                     ▼
                          child in slot-k (background, role bound, leases until integrated)
                                         │ ends
                         commit in slot → verification (gate, cwd = slot) → PASS
                                         ▼
           integration queue: rebase on integration head → clean → checks → ff-only omr/<planId>/integration
                                         │ phase fully integrated → phase suite on the integration commit
                                         │ fail → bisect → revert (built and checked in a slot) → reopen
                                         ▼
           QA task (findings JSON) → fix tasks → re-review → gate passed → next wave → … → landing (ff-only when clean)
```

Ledger schema and transitions: Appendix A. Turn-state tail: Appendix B. Config keys: Appendix C. Metrics: Appendix D.

---

## 2. Host contracts (pinned in Phase 0.1) and decision table

Each contract becomes a permanent assertion in `D:\git\omr-cpx-main\test\smoke\cpx-host-contract.smoke.test.ts`
(`npm run smoke:cpx`). Phase 0.1 observes the host, then the architect fixes each row's branch in ADR 0007, then the
tests assert it.

| Id | Contract to pin | If it holds | If it does not hold (fallback) |
|---|---|---|---|
| C1 | `subagent` with `background: true` returns at once with `{status: "running", sessionID}`; `execute.after` fires exactly once for that call | in-flight registration in `execute.after` | register in `execute.before` with the call id; bind the child on `session.created` |
| C2 | When a background child finishes, the host injects a completion message into the parent (shape `<subagent sessionID=… state=…>…`) and wakes an idle parent | completion processor triggered from it (D2) | the router posts its own completion entry (`ctx.session.synthetic`, `resume: true`) after processing |
| C3 | A completion arriving while the parent is mid-turn is delivered, never lost | no extra handling | the processor keeps an undelivered set and re-posts after the parent's turn ends |
| C4 | The parent's `session.hook("context")` sees the completion message in `event.messages` and can rewrite it in place for that request (history keeps the original) | D3 held placeholder | **no holding:** under required verification the dispatch stays in the foreground (today's behavior); D1 never chooses background for it |
| C5 | A part or message appended in the context hook is sent to the provider, is not persisted, and keeps the earlier request prefix byte-identical (checked on captured request bodies) | tail as the last message, with the role the observation accepts | tail appended to the **newest** message only (latest tool-result or user message); if that is impossible too, G4 is recorded unattainable and v2 keeps today's delivery (D4) |
| C6 | A plugin can set a 1-hour cache hint on a system part and the provider request carries it | D5 implemented | `routing.promptCache.ttl` not added |
| C7 | `session.execution.succeeded/failed/interrupted` carry the child session id; after completion `ctx.session.context({sessionID: child})` returns the child's final text | processor and recovery read results | recovery re-queues children whose result cannot be read |
| C8 | A user-backgrounded running subagent produces the same running acknowledgement in `execute.after` | covered through C1 | register on the first child event after the call started |
| C9 | `execute.before` receives the target paths of `read`, `write`, `edit`, `multiedit`, `patch`, `apply_patch`, `glob`, `grep`, `list` and `router_run`'s cwd; `execute.after` can rewrite `glob`/`grep` results | leases in the tool hooks | writes enforced through `ctx.permission.hook("evaluate")` resources (`D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1228); search filtering not available and documented |
| C10 | A 429, overload (529) or usage-limit error surfaces as `session.step.failed` with identifying fields after the host's own retries | capacity signals (D13) | match the error text patterns recorded by the observation |
| C11 | The parent's stored history keeps the `subagent` arguments as the model wrote them, not the `execute.before`-mutated ones | launcher B expands in `execute.before` | launcher B keeps route line + `VERIFY:required` + `[acceptance]` + `[plan P:T]` in `args.prompt` and injects only `PLAN CONTEXT` and `TASK` in the child's context hook |
| C12 | After a host restart, a background child that was in flight still delivers its completion | recovery relies on it | recovery reads child state and result through C7; re-queues when neither is available |
| C13 | Six background children, and then `maxParallel` children, run concurrently; a parent interrupt does not kill them | `maxParallel` clamp = largest count observed | record the cap; on parent interrupt the runtime re-queues killed children |
| C14 | The child runner path (`D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈96-222) can start a child outside any LLM tool call, using a retained orchestrator context that stays valid for hours (or is refreshed on each orchestrator tool call). The child's own tool calls fire the router's hooks (guards, grants, leases). Several such children run concurrently. The parent's history gets no message from them. | **launcher A** | **launcher B** |
| C15 | The compaction request of a session can be rewritten by a plugin (`session.hook("compaction")` or an equivalent) | held placeholder applied in compaction (D3) | no holding (same as C4 fallback) |

*Amended by A-0.1-2:* **Decided (ADR 0007, revision 2026-10-11).** The rows above keep their pre-observation wording. The decided
branches are: C6 holds on the wire but D5 is withdrawn (A-0.1-3: the host's tools breakpoint keeps its 5-minute TTL; no TTL hint, no O11); C10 holds on different events (429/529 →
`session.retry.scheduled`, no `session.step.failed` within 75 s; usage limit → `session.step.failed`
`provider.quota`; reset instant only in `error.message`; the retry hook can stop retries); C9 holds for
`read`/`write`/`edit`/`glob`/`grep` (`list`, `multiedit`, `patch`, `apply_patch` not advertised; `router_run`
keys from its own schema); C12 does not hold for children in flight; C13 cap 8; C14 holds (launcher A, router
guards apply to retained children, agent and model honoured).

---

## 3. Ownership and execution order

### 3.1 Phases, dependencies and start rule

| Wave | Phase | Depends on |
|---|---|---|
| 0 | 0.1 Host contracts and ADR 0007 | 0.P |
| 1 | 1.1 Telemetry · 1.2 Turn state and cache · 1.3 Leases · 1.4 Executor contracts | 0.1 (each) |
| 2 | 2.1 Background-first dispatch | 1.1, 1.2, 1.3 |
| — | **DF-1 dogfood switch** (§0.12, section "Dogfood switch DF-1") | 2.1 (drain in-flight dispatches first) |
| 2 | 2.2 Ledger | 1.4 |
| 2 | 2.3 Compiler | 1.1, 1.3, 1.4 |
| 2 | 2.4 Slots and provisioning | 1.4 |
| 3 | 3.1 Scheduler, capacity, launcher, runtime | 2.1, 2.2, 2.3, 2.4 |
| 3 | 3.2 Integration queue | 2.1, 2.2, 2.4 |
| 4 | 4.1 Operator surface | 3.1, 3.2 |
| 4 | 4.2 Unattended operation and recovery | 3.1, 3.2 |
| 5 | 5.1 Assembly and registration | 4.1, 4.2 |
| — | **DF-2 dogfood switch** (§0.12, section "Dogfood switch DF-2") | 5.1 |
| 6 | 6.1 End-to-end, documentation, ADR final (run by the executor under DF-2) | DF-2 |
| 6 | 6.2 Global QA and delivery | 6.1 |

Start rule: §0.6-2. Waves group ownership and are not barriers. For example, 2.2 and 2.4 start as soon as 1.4 is merged.
A dogfood switch drains in-flight dispatches. Phases already in flight resume after the restart, on the new build.

### 3.2 Ownership (writes)

**Note — existing tests:** a phase also owns the existing test files whose subject is a file it owns: the test named after
that source file or whose `describe` targets it. Importing a hub (`D:\git\omr-cpx-main\src\index.ts`,
`D:\git\omr-cpx-main\src\router\config.ts`) does not make a test its subject. Each phase lists its existing tests by full
path in its pre-flight. An overlap between phases that can run together goes to the earlier phase in §3.1, with a
handoff to the other.

Every phase report (`D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-<id>.md`) is written by the
orchestrator.

| Phase | Owns (writes); *(new)* = created by the phase |
|---|---|
| orchestrator | `D:\git\omr-cpx-main\CHANGELOG.md` (only in `D:\git\omr-cpx-main`); `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md` (copy in `cpx/main`, amendments); `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md` *(new)*; `D:\git\omr-cpx-main\docs\plans\README.md` (0.P entry: links only the plan and the handover); `D:\git\omr-cpx-main\src\executor\types.ts` (ADR amendments only, in `D:\git\omr-cpx-main`); `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md` (amendments, in `D:\git\omr-cpx-main`; none during the DF-2 freeze); `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` *(new)*; every phase report; the dogfood worktrees `D:\git\omr-cpx-dogfood-df<n>` and the plugin entry of the OpenCode config (§0.12); merges and tags |
| 0.1 | `D:\git\omr-cpx-main\test\smoke\cpx-host-contract.smoke.test.ts` *(new)*, `D:\git\omr-cpx-main\test\smoke\probe\cpx-probe-plugin.js` *(new)*, `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`, `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.ts` *(new)*, `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.test.ts` *(new)* (amendment A-0.1-1: the v1-frozen `scripted-provider.ts` and its test are read only), `D:\git\omr-cpx-main\package.json`, `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md` *(new)* |
| 1.1 | `D:\git\omr-cpx-main\src\routing\outcomes\types.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts` *(new)*, `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts` *(new)*, `D:\git\omr-cpx-main\src\routing\outcomes\stats.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\index.ts`, `D:\git\omr-cpx-main\src\routing\commands\stats.ts`, the existing tests of `D:\git\omr-cpx-main\src\routing\commands\stats.ts` (listed in pre-flight), `D:\git\omr-cpx-main\scripts\routing-stats.ts`, `D:\git\omr-cpx-main\docs\ROUTING_ENGINE.md`, `D:\git\omr-cpx-main\test\integration\routing-advisor.test.ts`, `D:\git\omr-cpx-main\test\unit\outcomes-timings.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\outcomes-durations.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\outcomes-turns.test.ts` *(new)* |
| 1.2 | `D:\git\omr-cpx-main\src\compat\turn-state.ts` *(new)*, `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\routing\wire\hint.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`, `D:\git\omr-cpx-main\docs\VERIFICATION.md`, `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\test\golden\` (new v2 snapshots only), `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`, `D:\git\omr-cpx-main\test\unit\turn-state.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\v2-turn-state.test.ts` *(new)*, `D:\git\omr-cpx-main\test\smoke\cpx-cache-prefix.smoke.test.ts` *(new)* |
| 1.3 | `D:\git\omr-cpx-main\src\router\leases.ts` *(new)*, `D:\git\omr-cpx-main\src\router\tool-paths.ts` *(new)*, `D:\git\omr-cpx-main\src\verify\dispatch.ts`, the existing tests of `D:\git\omr-cpx-main\src\verify\dispatch.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\unit\leases.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\tool-paths.test.ts` *(new)* |
| 1.4 | `D:\git\omr-cpx-main\src\executor\types.ts` *(new)*, `D:\git\omr-cpx-main\vitest.config.ts`, `D:\git\omr-cpx-main\test\unit\executor-types.test.ts` *(new)* |
| 2.1 | `D:\git\omr-cpx-main\src\compat\background.ts` *(new)*, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts`, `D:\git\omr-cpx-main\src\verify\wiring.ts`, `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\verify\dispatch.ts`, `D:\git\omr-cpx-main\src\verify\reference.ts` (2.4 only reads it), `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\src\router\protocol.ts`, `D:\git\omr-cpx-main\test\golden\` (new v2 snapshots only), `D:\git\omr-cpx-main\test\golden\roles-protocol.golden.test.ts` (intentional v2 change: update `GOLDEN`), `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\docs\ROLES.md`, `D:\git\omr-cpx-main\docs\VERIFICATION.md`, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`, `D:\git\omr-cpx-main\test\unit\protocol.test.ts`, `D:\git\omr-cpx-main\test\unit\protocol-directives.test.ts`, the existing tests of `D:\git\omr-cpx-main\src\verify\wiring.ts`, `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts` and `D:\git\omr-cpx-main\src\verify\reference.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\smoke\role-spikes.smoke.test.ts`, `D:\git\omr-cpx-main\test\unit\background-policy.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\completion-processor.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\pending-persist.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\v2-background.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\v2-leases.test.ts` *(new)*, `D:\git\omr-cpx-main\test\smoke\cpx-background.smoke.test.ts` *(new)* |
| 2.2 | `D:\git\omr-cpx-main\src\executor\ledger.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\paths.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-ledger.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\executor-ledger-crash.test.ts` *(new)*, `D:\git\omr-cpx-main\test\fixtures\cpx\ledger\` *(new)* |
| 2.3 | `D:\git\omr-cpx-main\src\executor\compile\parse.ts`, `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`, `D:\git\omr-cpx-main\src\executor\compile\edges.ts`, `D:\git\omr-cpx-main\src\executor\compile\residue.ts`, `D:\git\omr-cpx-main\src\executor\compile\validate.ts`, `D:\git\omr-cpx-main\src\executor\compile\estimate.ts`, `D:\git\omr-cpx-main\src\executor\compile\index.ts` *(all new)*; `D:\git\omr-cpx-main\test\unit\executor-compile-parse.test.ts`, `D:\git\omr-cpx-main\test\unit\executor-compile-footprint.test.ts`, `D:\git\omr-cpx-main\test\unit\executor-compile-edges.test.ts`, `D:\git\omr-cpx-main\test\unit\executor-compile-residue.test.ts`, `D:\git\omr-cpx-main\test\unit\executor-compile-real-plans.test.ts` *(all new)*; `D:\git\omr-cpx-main\test\fixtures\cpx\plans\` *(new, frozen copies)* |
| 2.4 | `D:\git\omr-cpx-main\src\executor\git.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\slots\pool.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\slots\provision.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\slots\env.ts` *(new)*, `D:\git\omr-cpx-main\src\router\run-tools.ts`, `D:\git\omr-cpx-main\src\verify\exec.ts`, the existing tests of `D:\git\omr-cpx-main\src\router\run-tools.ts` and `D:\git\omr-cpx-main\src\verify\exec.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\unit\executor-git.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-slots.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-provision.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\executor-slots-git.test.ts` *(new)*, `D:\git\omr-cpx-main\test\fixtures\cpx\repos\` *(new)*, `D:\git\omr-cpx-main\test\smoke\cpx-provision.smoke.test.ts` *(new)* |
| 3.1 | `D:\git\omr-cpx-main\src\executor\schedule.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\capacity.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\launch.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\expand.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\runtime.ts` *(new)*, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\compat\v2-client.ts`, `D:\git\omr-cpx-main\src\routing\roles\binding.ts`, the existing tests of `D:\git\omr-cpx-main\src\compat\v2-client.ts` and `D:\git\omr-cpx-main\src\routing\roles\binding.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`, `D:\git\omr-cpx-main\test\unit\executor-schedule.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-capacity.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-launch.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-expand.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-runtime.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\v2-executor-launch.test.ts` *(new)* |
| 3.2 | `D:\git\omr-cpx-main\src\executor\integrate\queue.ts`, `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`, `D:\git\omr-cpx-main\src\executor\integrate\bisect.ts`, `D:\git\omr-cpx-main\src\executor\integrate\phase-suite.ts`, `D:\git\omr-cpx-main\src\executor\integrate\land.ts` *(all new)*; `D:\git\omr-cpx-main\src\verify\runner.ts` and `D:\git\omr-cpx-main\src\verify\slot.ts` (exports only); `D:\git\omr-cpx-main\test\unit\executor-integrate-queue.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-integrate-bisect.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\executor-integrate-git.test.ts` *(new)*, `D:\git\omr-cpx-main\test\fixtures\cpx\integrate\` *(new)* |
| 4.1 | `D:\git\omr-cpx-main\src\executor\tool.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\command.ts` *(new)*, `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\src\commands\output.ts`, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`, `D:\git\omr-cpx-main\docs\EXECUTOR.md` *(new)*, `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\src\executor\instructions.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-instructions.test.ts` *(new)*, the existing tests of `D:\git\omr-cpx-main\src\commands\output.ts` and of `D:\git\omr-cpx-main\src\router\config.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\unit\executor-tool.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-command.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\config-executor.test.ts` *(new)* |
| 4.2 | `D:\git\omr-cpx-main\src\executor\unattended.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\qa-loop.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\recovery.ts` *(new)*, `D:\git\omr-cpx-main\src\executor\runtime.ts`, `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\test\unit\executor-unattended.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-qa-loop.test.ts` *(new)*, `D:\git\omr-cpx-main\test\unit\executor-recovery.test.ts` *(new)*, `D:\git\omr-cpx-main\test\integration\executor-recovery-restart.test.ts` *(new)* |
| 5.1 | `D:\git\omr-cpx-main\src\executor\create.ts` *(new)*, `D:\git\omr-cpx-main\src\v2.ts`, `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\router\role-agents.ts`, `D:\git\omr-cpx-main\docs\EXECUTOR.md`, `D:\git\omr-cpx-main\docs\ROLES.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\test\golden\` (new v1-map snapshot only), the existing tests of `D:\git\omr-cpx-main\src\v2.ts` and `D:\git\omr-cpx-main\src\router\role-agents.ts` (listed in pre-flight), `D:\git\omr-cpx-main\test\integration\v2-executor-assembly.test.ts` *(new)* |
| 6.1 | `D:\git\omr-cpx-main\test\smoke\cpx-e2e.smoke.test.ts` *(new)*, `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\` *(new)*, `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.ts`, `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.test.ts` (amendment A-0.1-1), `D:\git\omr-cpx-main\docs\EXECUTOR.md`, `D:\git\omr-cpx-main\README.md`, `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\docs\ROLES.md`, `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`, `D:\git\omr-cpx-main\docs\plans\README.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts` |
| 6.2 | `D:\git\omr-cpx-main\docs\EXECUTOR.md` and `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md` (6.2.0); any file named by a global QA finding; the orchestrator serializes fixes so each file has one writer at a time |

---

## 4. Waves and phases

### Pre-flight 0.P — plan-level setup

Runs once, before Phase 0.1. Shell steps run in the orchestrator's shell or through an `agent: fast` tier dispatch
(§0.10-2); they carry no route line because roles cannot run them.

**Order:** 0.P.1 → 0.P.3 → 0.P.6 → 0.P.2 → 0.P.4 → 0.P.5 → QA. The configuration check comes before the first role dispatch,
because role agents get no authority in `D:\git\omr-cpx-main` without `routing.workRoots`.

**Tasks**
- **0.P.1** [tier:fast] Verify the dedicated worktree (§0.13) and commit the plan in `cpx/main` (orchestrator shell or
  `agent: fast`).
  Writes: `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md` (commit only),
  `D:\git\omr-cpx-main\docs\plans\README.md`, `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md`.
  Reads: `D:\git\omr-cpx-main\`.
  - 0.P.1.a Verify §0.13-2. Any difference is a stop (§0.1-2):
    - `git -C D:\git\omr-cpx-main worktree list` shows `D:\git\omr-cpx-main` on `cpx/main`;
    - `git -C D:\git\omr-cpx-main status --porcelain=v1 --untracked-files=all` shows
      exactly two untracked files: `?? docs/plans/critical-path-execution-handover.md` and
      `?? docs/plans/critical-path-execution-plan.md`;
    - `git -C D:\git\omr-cpx-main rev-parse --abbrev-ref "cpx/main@{upstream}"` fails, because there is no upstream.
  - 0.P.1.b Run `git -C D:\git\omr-cpx-main fetch origin`. If `origin/master` moved past `b716ee9`, run
    `git -C D:\git\omr-cpx-main merge --ff-only origin/master`; `cpx/main` has no commits of its own yet. Record the
    resulting commit as the plan base, then run `npm ci` in `D:\git\omr-cpx-main`.
  - 0.P.1.c Prepare the plan files:
    - add this plan's entry to `D:\git\omr-cpx-main\docs\plans\README.md`. It links only the plan and the handover, so
      the docs-drift link checks pass; 6.1.5.d adds the ADR, `D:\git\omr-cpx-main\docs\EXECUTOR.md` and QA
      links;
    - update the existing handover file's §7 'Live state' (all phases `waiting`, next action `0.P.3`).
  - 0.P.1.d Commit and push:
    - commit `docs(plan): add critical-path execution plan` with the plan, the README and the handover;
    - push with `git -C D:\git\omr-cpx-main push -u origin cpx/main`. The upstream becomes `origin/cpx/main`, never
      `master`.

    From now on, plan amendments are committed only in `D:\git\omr-cpx-main`.
- **0.P.2** [tier:fast] Baseline in the integration worktree:
  [route class=other risk=low scope=repo needs=shell d=none root=D:\git\omr-cpx-main tier=fast pin]
  Writes: none. Reads: `D:\git\omr-cpx-main\`.
  - 0.P.2.a `router_run {script: "typecheck", cwd: "D:\git\omr-cpx-main"}`; return the result.
  - 0.P.2.b Scoped baseline: the existing tests of the files Phases 0.1 and 1.1–1.4 own (§0.6-9; the full suite is not
    run here). The orchestrator runs them in its shell and records the result and every failing test name.
- **0.P.3** [tier:fast] Environment, configuration and authority check (orchestrator shell or `agent: fast`). Any item that
  fails becomes **one** blocking stop **now** that lists all missing items, so no later phase stops for them.
  Writes: none. Reads: environment, `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`.
  - 0.P.3.a `OPENCODE_V2_BIN` is set and absolute, and `& $env:OPENCODE_V2_BIN --version` reports ≥ 2.0.24. Record the
    version; ADR 0007 records it as the version under test.
  - 0.P.3.b Tool versions: `node --version` ≥ 22.18 (or ≥ 23.6); `git --version` ≥ 2.40; `pnpm --version` present; `py -3 --version`
    ≥ 3.10, with the `venv` and `pip` modules; `uv --version` optional, recorded; `gh --version` present and
    `gh auth status` OK (needed only by 6.2.4); free space on `D:` ≥ 10 GB; record the machine's core count (for §0.6-9).
  - 0.P.3.c Configuration layers:
    - if `routing.delegation: "roles"` is not already in effect for sessions in `D:\git\omr-cpx-main`, set it in
      `D:\git\omr-cpx-main\.opencode\opencode-model-router.overrides.jsonc` (project layer, gitignored), never globally;
    - the global override gets only `routing.workRoots` entries `D:/git/omr-cpx-main`, `D:/git/omr-cpx-p*`,
      `D:/git/omr-cpx-pdf*`, `D:/git/omr-cpx-scratch*`, `D:/git/omr-cpx-e2e*` (additive; not the dogfood worktrees).
      *Amended by QA-0.P-1/QA-0.P-15:* the scratch and e2e entries are globs because a literal entry is resolved with
      `realpath` whenever the role agents are registered — at plugin start and at every refresh after a config-file
      change (`D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1174-1182, ≈1354) — and dropped when the directory does
      not exist at that moment (`D:\git\omr-cpx-main\src\router\role-agents.ts` ≈198-205, ≈257-260); both directories
      are created later. Validate with `externalDirectoryPatterns([], <entries>)` (`problems: []`). **An edit to the
      global override reaches every running router on the machine at its next prompt**, the other implementation's
      included; the owner is told before each such edit, and it is recorded in the handover. The executor keys are set
      later, in the DF-2 pre-flight.

    Without the work roots, role agents get no write or run authority in phase worktrees
    (`D:\git\omr-cpx-main\docs\ROLES.md` ≈179-193). If something is missing, the human adds it and restarts OpenCode;
    then resume at 0.P.6 (the DF-0 restart can be combined with this one) using the handover file.
  - 0.P.3.d The orchestrator session has a shell tool, or an `agent: fast` dispatch can run `git --version`. If neither
    works, stop.
  - 0.P.3.e `routing.run.commands` resolves an entry named `test-files`
    (`D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md` ≈1023-1027). If it does not, the human restores it.
  - 0.P.3.f Dogfood prerequisites (§0.12-2):
    - record how the running OpenCode loads the router: plugin entry, config file path, current target, and
      OpenCode's log directory;
    - back up that config file to `$env:LOCALAPPDATA\omr-cpx\opencode-config.backup`;
    - determine the narrowest plugin-entry scope the host supports (§0.12-2 order: process-scoped config, project config,
      global entry) by reading the host's config documentation and testing a no-op change; record the scope, the exact
      launch or config change, and its revert;
    - confirm that the owner accepts the two planned dogfood restarts (DF-1, DF-2), the dogfood spend on their
      subscriptions (capped by §0.6-11), and the chosen scope. Only the global scope affects the other implementation's
      sessions, and it needs explicit consent.

    If the owner declines, record it: the plan then runs without §0.12, and G13 is recorded as not run.
- **0.P.4** [tier:fast] Re-base every anchor of "Problem today", §1, §2 and the phase pre-flights from `b7984b3` to the
  recorded `origin/master` commit, and record the new values in the handover file:
  [route class=recon risk=low scope=repo d=none root=D:\git\omr-cpx-main tier=fast pin]
  Writes: none (the orchestrator records the result). Reads: `D:\git\omr-cpx-main\src\`, `D:\git\omr-cpx-main\docs\`,
  `D:\git\omr-cpx-main\test\`.
- **0.P.5** Orchestrator: write `D:\git\omr-cpx-main\docs\qa\critical-path-execution\preflight.md` with the 0.P.1–0.P.4
  results and commit `docs(qa): critical-path execution pre-flight`; push. Phase 0.1's base tag is created by the start
  rule (§0.6-2), not here.
- **0.P.6** Orchestrator + planned human action: DF-0 baseline. If 0.P.3.f found that the router is loaded from a working
  tree that can change (for example the main checkout), switch now (§0.12-3; at the base only typecheck exists as a
  precondition) to tag `cpx/df0` = the plan base in `D:\git\omr-cpx-dogfood-df0`, with the recorded
  scope. Otherwise record that the current target is pinned. Self-check after a switch: exactly one `router_verify`
  tool is registered, and OpenCode's plugin-load log (the newest file under the log directory recorded in 0.P.3.f)
  names `D:\git\omr-cpx-dogfood-df0`. *Amended by QA-0.P-6/QA-0.P-9 (applies to every DF self-check, DF1.4.a and
  DF2.4.0 included):* the log file is shared by every OpenCode server on the machine, so the check is scoped to the
  plan server's run: the orchestrator runs a marker shell command with a **fresh literal nonce**
  (`Write-Output omr-selfcheck-<nonce>`, never reused) and takes the `run=` id of the **newest** `spawning process`
  line carrying it. *Amended by QA-0.P-18/QA-0.P-24:* within that run the set of `loading plugin` ids must **equal** the
  plugin list of the regenerated process-scoped `opencode.json`, each exactly once, except that
  `D:\\git\\opencode-telegram-plugin` may be absent (recorded baseline: no OpenCode server on this machine loads it,
  before or after the DF-0 switch); no id outside that list may appear, with the router entry's entrypoint
  exactly `file:///D:/git/omr-cpx-dogfood-df<n>[.<k>]/server.ts` of the build being switched to (so no second router
  build — an older dogfood build, a phase worktree or the main checkout — can be loaded; the host's watcher on
  `…\.git\worktrees\omr-cpx-main\HEAD` is expected), and the server process is the versioned OpenCode executable
  recorded in 0.P.3.a (the version ADR 0007 records). The handover records each build that passes; a rollback
  (§0.12-6) returns to the **last build that passed its self-check**.
  Writes: none (the handover records the result). Reads: the 0.P.3.f record in the handover.
- **0.P.QA** [tier:heavy] Senior QA of the setup. CAP:none — reason: needs the setup, the configuration and the plan
  together.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-main tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-main\` at the fixed QA commit.
  Adversarial focus:
  - the base commit is not `origin/master`;
  - the plan copy differs from the reviewed plan;
  - the `workRoots` pattern does not match the worktree names used in §0.6-2;
  - an anchor was re-based to the wrong line;
  - the handover is missing a field required by §0.11;
  - a binary is missing that a later phase needs;
  - DF-0 left the router on a moving build or loaded it twice.
- **0.P.FIX** The orchestrator fixes every QA-0.P finding (setup and plan amendments in `D:\git\omr-cpx-main`) and heavy
  re-reviews, per §0.7.

**New tests:** none (no code). The baseline from 0.P.2 is the regression reference for every phase.

**Acceptance criteria:**
- `cpx/main` is at the recorded `origin/master` commit, plus the plan, its README entry and the handover.
- Every binary, configuration item and authority path the plan needs is present.
- Anchors are re-based.
- The router build is pinned (DF-0 done, or the current target recorded as pinned).

**Definition of Done:** the acceptance items hold; `D:\git\omr-cpx-main\docs\qa\critical-path-execution\preflight.md`
committed; QA-0.P has zero open findings; handover
next action = "start Phase 0.1".

---

### Wave 0

#### Phase 0.1 — Host contract pins and ADR 0007 [tier:medium] harness and probes + [tier:heavy] decisions

**Worktree:** `D:\git\omr-cpx-p01` (branch `cpx/p01`) · **Depends on:** 0.P

**Goal:** every host behavior the design depends on (§2, C1–C15) is observed on the real OpenCode v2 host, decided in ADR
0007 (including launcher A or B), and pinned by a permanent smoke test whose failure message names the decision.

**Pre-flight (in addition to §0.9)**
- [ ] Read the harness:
  - `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`: `v2Executable` ≈127, `HostOptions` ≈649-698,
    `RoutingHost` ≈708, the plugin list ≈776 and ≈799, `spawn` ≈816, `stop()` ≈870, the isolation of HOME/XDG and
    credentials ≈765-768 and ≈812-814;
  - `D:\git\omr-cpx-main\test\smoke\helpers\scripted-provider.ts`: error path ≈108-111, usage ≈130-133;
  - `D:\git\omr-cpx-main\test\smoke\probe\probe-plugin.js`.
- [ ] Read the existing background test `D:\git\omr-cpx-main\test\smoke\role-spikes.smoke.test.ts` ≈211-218 and
      ≈706-725, and the child runner `D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈96-222 (retained contexts).
- [ ] Confirm `@opencode/client` resolves from `D:\git\omr-cpx-p01\node_modules`. It is loaded by `loadClient`,
      `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts` ≈134.
- [ ] Find where smoke runs write evidence: `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts` ≈1070-1072
      and `D:\git\omr-cpx-main\test\smoke\routing-engine.smoke.test.ts` ≈14. They write tracked files under
      `D:\git\omr-cpx-main\docs\qa\cost-aware-routing\evidence-3.2\`.

**Order:** 0.1.0 → 0.1.1 → 0.1.2 → 0.1.3 → 0.1.4 → (0.1.5 ∥ 0.1.6) → QA.

**Tasks**
- **0.1.0** [tier:medium] VERIFY:required Harness extensions.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`,
  `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.ts` *(new)*,
  `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.test.ts` *(new)*.
  Reads: `D:\git\omr-cpx-main\test\smoke\helpers\scripted-provider.ts`, `D:\git\omr-cpx-main\test\smoke\v2-registration.smoke.test.ts`.
  *Amendment A-0.1-1 (Phase 0.1 pre-flight):* `test\smoke\helpers\scripted-provider.ts`, its test, `fetch-safe-port.ts`,
  the four v1 smoke files, `vitest.smoke.config.ts`, `test\setup\smoke-tmp-guard.ts` and `scripts\smoke-v1-preflight.mjs`
  are pinned byte-identical to `V1_BASE_COMMIT` `bd1ecd1` by `D:\git\omr-cpx-main\test\smoke\routing-engine.smoke.test.ts`
  scenario `6-v1-untouched` (v1 feature freeze). The 0.1.0.c/d additions therefore live in a new
  `CpxScriptedProvider` (`cpx-scripted-provider.ts`) that reuses `ScriptedProvider` without changing it, and
  `routing-host.ts` accepts it through a new option; the unit tests go to `cpx-scripted-provider.test.ts`, run with the
  smoke config and by `smoke:cpx`.
  - 0.1.0.a `HostOptions.extraPlugins` (absolute paths, loaded after the router).
  - 0.1.0.b `RoutingHost.restart()`, which stops the host process and starts it again with the same root and XDG state.
  - 0.1.0.c Scripted provider additions:
    - responses for HTTP 429, 529 overloaded, and a usage-limit body with a reset time;
    - a per-request delay;
    - cache usage fields (`cache_read_input_tokens`, `cache_creation_input_tokens`);
    - capture of every request body, readable by the test.
  - 0.1.0.d Unit tests for each addition in `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.test.ts`.
    `npm run smoke:keyless` stays green (orchestrator shell).
  - 0.1.0.e An `OMR_SMOKE_EVIDENCE_DIR` override in `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`.
    When it is set, evidence goes to that directory instead of the tracked evidence files. Unset, behavior is unchanged.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: buildPasses
  check: testsPass
  criteria: every addition is covered by a unit test; existing smoke helpers keep their behavior when the new options are unset
  [/acceptance]
- **0.1.1** [tier:medium] VERIFY:required Probe plugin.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\probe\cpx-probe-plugin.js`.
  Reads: `D:\git\omr-cpx-main\test\smoke\probe\probe-plugin.js`, `D:\git\omr-cpx-main\src\compat\v2-client.ts`.
  - 0.1.1.a A minimal v2 plugin, used only by the contract smoke, that records JSON lines to the path in `CPX_PROBE_OUT`:
    - events `session.created`, `session.execution.*`, `session.step.failed`;
    - `execute.before` and `execute.after` of `subagent`, file and search tools and `router_run`: tool, argument keys,
      path arguments, result status;
    - every context-hook call: session id, message ids, roles, first 200 characters of each text part;
    - every compaction-hook call, if the hook exists.
  - 0.1.1.b Mutations switched by `CPX_PROBE_MODE`, one each:
    - `rewrite-completion`;
    - `append-tail-system` and `append-tail-user` (last message), and `append-tail-newest` (newest message);
    - `cache-hint-1h`;
    - `mutate-subagent-prompt`;
    - `filter-grep`;
    - `rewrite-compaction`;
    - `retained-launch`: register a tool `cpx_probe_capture` that retains its tool context; then, after the turn ends,
      start three children through the native `subagent` tool with that context, the way
      `D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈110-170 does.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: fileExists path=D:\git\omr-cpx-p01\test\smoke\probe\cpx-probe-plugin.js
  criteria: the probe loads in the v2 host through extraPlugins and each mode performs only its own mutation
  [/acceptance]
- **0.1.2** [tier:medium] VERIFY:required Observation smoke and scripts.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\cpx-host-contract.smoke.test.ts`, `D:\git\omr-cpx-main\package.json`.
  Reads: `D:\git\omr-cpx-main\test\smoke\probe\cpx-probe-plugin.js`, `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`,
  `D:\git\omr-cpx-main\test\smoke\helpers\scripted-provider.ts`, `D:\git\omr-cpx-main\test\smoke\depth-effort.smoke.test.ts`.
  - 0.1.2.a Scripts:
    - `"smoke:cpx": "cross-env RUN_OC_SMOKE_CPX=1 vitest run --config vitest.smoke.config.ts test/smoke/helpers/cpx-scripted-provider test/smoke/cpx-host-contract test/smoke/cpx-cache-prefix test/smoke/cpx-background"`
      (A-0.1-1 adds the provider's unit tests);
    - `"smoke:cpx:provision": "cross-env RUN_OC_SMOKE_CPX=1 vitest run --config vitest.smoke.config.ts test/smoke/cpx-provision"`;
    - `"smoke:cpx:e2e": "cross-env RUN_OC_SMOKE_CPX=1 vitest run --config vitest.smoke.config.ts test/smoke/cpx-e2e"`.
  - 0.1.2.b Gate `const RUN = process.env.RUN_OC_SMOKE_CPX === "1"; const d = RUN ? describe : describe.skip;`. Fail hard
    when `RUN` is set without `OPENCODE_V2_BIN`, following the pattern of
    `D:\git\omr-cpx-main\test\smoke\depth-effort.smoke.test.ts` ≈24-27 and ≈197-198.
  - 0.1.2.c One `describe` per contract C1–C15, in **observation mode**. Each scenario uses the scripted provider, waits
    on events (never fixed sleeps), and writes its observation to `CPX_PROBE_OUT`, which defaults to
    `$env:TEMP\omr-cpx-probe\`.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: buildPasses
  check: fileExists path=D:\git\omr-cpx-p01\test\smoke\cpx-host-contract.smoke.test.ts
  criteria: with RUN_OC_SMOKE_CPX=1 every C1–C15 scenario writes an observation; without it every test is skipped; the three scripts exist in D:\git\omr-cpx-main\package.json
  [/acceptance]
- **0.1.3** [tier:fast] Run `npm run smoke:cpx` three times (orchestrator shell or `agent: fast`) and paste the three
  observation sets and any variance into the report.
  Writes: none. Reads: the observation files in `$env:TEMP\omr-cpx-probe\`.
- **0.1.4** [tier:heavy] CAP:4 ADR 0007 text (returned, not written).
  [route class=design risk=high scope=repo d=none root=D:\git\omr-cpx-p01 tier=heavy pin]
  Writes: none. Reads (pasted): §1 and §2 of this plan, the 0.1.3 observations, the header of
  `D:\git\omr-cpx-main\docs\adr\0006-role-tier-assurance-delegation.md`.
  - 0.1.4.a The header in the ADR 0006 format. Status "Accepted (measurements pending Phase 6.1)"; Depends on ADR 0002,
    0005, 0006; Plan link; host version under test.
  - 0.1.4.b Decisions D1–D20, each with its rationale and the alternatives rejected. For C1–C15: the observed behavior
    and the chosen branch. For the launcher: A or B, with the C14 evidence; if A, the context-refresh rule and how
    children are bound.
  - 0.1.4.c "Consequences for later phases": the exact branch each phase implements (C5 placement, C6, C9, C11, C14,
    C15 and the C13 clamp).
- **0.1.5** [tier:medium] Write the ADR file from the 0.1.4 text verbatim.
  [route class=implement risk=low scope=single needs=edit d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`. Reads: the pasted 0.1.4 text.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: fileExists path=D:\git\omr-cpx-p01\docs\adr\0007-critical-path-execution.md
  criteria: the ADR contains every decision D1–D20 and a decided branch for every contract C1–C15
  [/acceptance]
- **0.1.6** [tier:medium] VERIFY:required Turn every observation into an assertion of the decided branch. Each assertion
  message names the contract and the decision (`C11/D14: stored subagent args must be the model's original`).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\cpx-host-contract.smoke.test.ts`. Reads:
  `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: buildPasses
  criteria: npm run smoke:cpx is green three consecutive times (orchestrator shell); each of C1–C15 has at least one assertion; no fixed sleeps
  [/acceptance]
- **0.1.QA** [tier:heavy] Senior QA (§0.7). CAP:none — reason: the smoke, the probe, the harness and the ADR must be read
  together.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p01 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p01\` at the fixed QA commit.
  Adversarial focus:
  - a test that passes without exercising the host;
  - timing-based flakiness;
  - observations that do not support the ADR branch drawn from them;
  - for C14: a "valid for hours" claim with no test of validity after the turn ended, and children whose hooks were not
    observed;
  - env vars or temp dirs leaking between scenarios (Windows EBUSY,
    `D:\git\omr-cpx-main\test\helpers\remove-dir.ts`);
  - harness changes that alter existing smoke behavior.
- **0.1.FIX** [tier:medium] Fix every QA-0.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p01 tier=medium pin]
  Writes: the files named by the findings (owned by 0.1). Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-0.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p01
  check: buildPasses
  check: testsPass
  criteria: every QA-0.1 finding listed in the dispatch is fixed, with a regression assertion where behavior changed
  [/acceptance]

**New tests:**
- The scripted-provider unit tests.
- The contract smoke: 15 scenarios. Edge cases inside them:
  - completion during a busy parent step (C3);
  - a failed and an interrupted child (C7);
  - *Amended by A-0.1-2:* restart with one child finished before it and one in flight (C12; `restart()` is one call, so the downtime is not hit: ADR 0007 O10);
  - 6 children, `maxParallel` children, and a parent interrupt (C13);
  - 429 followed by success (C10);
  - *Amended by A-0.1-2:* retained-context launch after the turn ended and 60 s later, eight children at once, router enforced with a no-router control,
    agent and model honoured, parent history unchanged (C14), and an active-root interrupt during retained launches (C14b);
  - compaction with a held placeholder (C15).

**Acceptance criteria:**
- Every one of C1–C15 is observed, decided in ADR 0007 and asserted.
- A host behavior change fails `npm run smoke:cpx` with the decision id in the message.
- `npm run smoke:keyless` stays green.

**Definition of Done:**
- §0.9 met at start.
- `npm run smoke:cpx` green 3 times.
- `npm run smoke:keyless`, typecheck and the phase's scoped tests (§0.6-9) green.
- `router_verify pending:true` passes.
- ADR committed; `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-0.1.md` with zero open findings;
  pushed; merged.

---

### Wave 1 (1.1 ∥ 1.2 ∥ 1.3 ∥ 1.4)

#### Phase 1.1 — Telemetry: dispatch timings, duration model, orchestrator turns [tier:medium]

**Worktree:** `D:\git\omr-cpx-p11` · **Depends on:** 0.1

**Goal:** the router records how long every dispatch takes and what each orchestrator turn reads from the cache, and
predicts how long the next dispatch will take.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts` (≈108-124, ≈139-163, ≈223-253, ≈620);
  - `D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts` (≈437, ≈705-717, ≈753, ≈771-783 `onExecutionEnded`
    and its `eventId` dedupe);
  - `D:\git\omr-cpx-main\src\routing\outcomes\types.ts` (≈302, ≈541-603, ≈714-724);
  - `D:\git\omr-cpx-main\src\routing\outcomes\stats.ts`;
  - `D:\git\omr-cpx-main\scripts\routing-stats.ts`;
  - `runStatsCommand` in `D:\git\omr-cpx-main\src\routing\commands\stats.ts`, and list its existing tests by full path;
  - `D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts` ≈105-131 and `D:\git\omr-cpx-main\src\index.ts` ≈661-676, to
    confirm that ingest is null under `routing.engine: "static"` (the reason timings live in their own module).
- [ ] Read the D18 equality test `D:\git\omr-cpx-main\test\integration\routing-advisor.test.ts` ≈641-660 and
      `D:\git\omr-cpx-main\test\integration\routing-ingest.test.ts` ≈1454-1531.
- [ ] Note: `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` is not owned here. The wiring of the timing recorder is a
      handoff to Phase 2.1 (task 2.1.5.c): on v2, 2.1 creates the recorder whatever the engine; record the exact calls
      2.1 must make.

**Order:** 1.1.1 → 1.1.2 → 1.1.3 → (1.1.4 ∥ 1.1.5) → 1.1.6 → QA.

**Tasks**
- **1.1.1** [tier:medium] VERIFY:required Rows and persistence.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\routing\outcomes\types.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts`.
  Reads: `D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\stats.ts`.
  - 1.1.1.a `DispatchTimingRow {kind: "dispatch-timing", v: 1, ts, parentSessionID, childSessionID, callID, role, class,
    scope, tier, model, background, startedAt, endedAt, durationMs, outcome: "succeeded"|"failed"|"interrupted"|"unknown", capacity: "rate-limit"|"overload"|"usage-limit"|null}` (*Amended by A-0.1-2*).
  - 1.1.1.b `OrchestratorTurnRow {kind: "orchestrator-turn", v: 1, ts, sessionID, turn, steps, input, cacheRead,
    cacheWrite}`. A turn is the set of steps between two prompt events of a root session.
  - 1.1.1.c `timings.jsonl` and `turns.jsonl` next to `decisions.jsonl`. They use the same append path and rotation rule,
    and a reader that tolerates a torn last line. No prompt or output text is stored.
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: buildPasses
  check: testsPass
  criteria: both row kinds round-trip through write, rotate and read; a torn last line is skipped with one warning
  [/acceptance]
- **1.1.2** [tier:medium] VERIFY:required Timing recorder `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts` (new).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts`. Reads: `D:\git\omr-cpx-main\src\routing\outcomes\types.ts`,
  `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts` (read only).
  - 1.1.2.a `createTimingRecorder({dir, now})` is independent of `routing.engine` and works with `static`.
    `D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts` is not changed; `onExecutionEnded` stays untouched. The
    recorder exposes `recordDispatchStart`, `onExecutionOutcome`, `markRootSession`, `onRootPrompt`, `onRootStep`, `onCapacitySignal` (*Amended by A-0.1-2*) and
    `sweep`:
    - `recordDispatchStart({childSessionID, parentSessionID, callID, role, class, scope, tier, model, background, at})`;
    - `onExecutionOutcome(childSessionID, eventId, outcome, at)`, which closes the timing and appends the row, deduped
      by `eventId` like the existing end path;
    - *Amended by A-0.1-2:* `onCapacitySignal(childSessionID, capacity, at)` records the latest capacity class on an open timing
      (ADR 0007 D6/D13); a closed timing ignores it.
  - 1.1.2.b Root sessions:
    - `markRootSession(sessionID)` (from `session.created` without `parentID`, or lazily on the first step of an
      unregistered session whose `ctx.session.get` has no `parentID`);
    - `onRootPrompt(sessionID, at)`, which marks a turn boundary;
    - `onRootStep(sessionID, tokens)` aggregates root steps into `OrchestratorTurnRow`, written at each boundary and on
      sweep.
  - 1.1.2.c Bounds and idempotency:
    - the open-start map holds at most 1000 entries (LRU);
    - an open start older than 6 h is closed as `unknown` by `sweep()` and excluded from estimates;
    - a second outcome for the same attempt is ignored;
    - `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts` appends each row before returning (no coalesced flush).
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: buildPasses
  check: testsPass
  criteria: D:\git\omr-cpx-main\src\routing\outcomes\ingest.ts is unchanged and the existing routing-ingest tests pass unchanged; the recorder's entry points are idempotent, bounded, and work with routing.engine static
  [/acceptance]
- **1.1.3** [tier:medium] VERIFY:required Estimator and exports.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\index.ts`.
  Reads: `D:\git\omr-cpx-main\src\routing\outcomes\types.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts`,
  `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts`.
  - 1.1.3.a `createDurationModel(seams: {readTimings, now}, opts?: {window?: 50, maxAgeDays?: 30, priorMs?: 480000,
    minSamples?: 5})` provides:
    - `estimate({role, class, scope}) → {p50, p90, n, source: "exact"|"role-class"|"role"|"prior"}`; *Amended by A-0.1-2:* rows whose `capacity` is not null are excluded;
    - `observe(row)` for live updates.
  - 1.1.3.b Estimation rules:
    - fallback order: exact, then (role, class), then role, then the prior;
    - a level is used only with at least `minSamples` samples;
    - only `succeeded` rows count;
    - percentiles use nearest rank over the newest `window` rows of the key that fall within `maxAgeDays`.
  - 1.1.3.c `D:\git\omr-cpx-main\src\routing\outcomes\index.ts` exports every new symbol of 1.1. This task is the only writer of that file.
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: buildPasses
  check: testsPass
  criteria: estimates follow the fallback chain; the prior is labeled source "prior"
  [/acceptance]
- **1.1.4** [tier:medium] VERIFY:required Stats output.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\routing\outcomes\stats.ts`, `D:\git\omr-cpx-main\src\routing\commands\stats.ts`,
  the existing tests of `D:\git\omr-cpx-main\src\routing\commands\stats.ts` (listed in pre-flight),
  `D:\git\omr-cpx-main\scripts\routing-stats.ts`, `D:\git\omr-cpx-main\test\integration\routing-advisor.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`.
  - 1.1.4.a Add a "Dispatch durations" table (role × p50, p90, n) and an "Orchestrator cache-read share" line (p50 and p10
    of `cacheRead / (input + cacheRead + cacheWrite)` per turn, plus the number of turns).
  - 1.1.4.b `runStatsCommand` passes the host to `runStatsCli`, which renders the new sections only for v2;
    `D:\git\omr-cpx-main\scripts\routing-stats.ts` renders them whenever the rows exist. v1 `/router stats` output stays
    byte-identical.
  - 1.1.4.c On v2, both renderers print identical text (D18), and the D18 test is extended with seeded rows.
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: buildPasses
  check: testsPass
  criteria: on v2, /router stats and D:\git\omr-cpx-main\scripts\routing-stats.ts print identical text with and without the new rows; output without rows equals the pre-phase output; v1 /router stats output is byte-identical
  [/acceptance]
- **1.1.5** [tier:medium] Docs in `D:\git\omr-cpx-main\docs\ROUTING_ENGINE.md`.
  [route class=implement risk=low scope=single needs=edit d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\ROUTING_ENGINE.md`. Reads: `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`.
  - 1.1.5.a Document `timings.jsonl`, `turns.jsonl`, the estimator and the new stats sections.
  - 1.1.5.b Handoff from 1.2: replace the sentence near ≈122 that says the hint "is the last system part" with the text
    that ADR 0007's C5 decision makes true (on v2 the hint is in the per-turn router state, or stays the last system part
    under the C5 fallback).
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: testsPass
  criteria: docs-drift tests stay green; every new file and stats line is documented
  [/acceptance]
- **1.1.6** [tier:medium] VERIFY:required New tests (list below).
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\outcomes-timings.test.ts`, `D:\git\omr-cpx-main\test\unit\outcomes-durations.test.ts`,
  `D:\git\omr-cpx-main\test\unit\outcomes-turns.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\routing\outcomes\types.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts`,
  `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`,
  `D:\git\omr-cpx-main\src\routing\outcomes\stats.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\index.ts`,
  `D:\git\omr-cpx-main\src\routing\commands\stats.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets §0.10-10 for D:\git\omr-cpx-main\src\routing\outcomes\durations.ts, D:\git\omr-cpx-main\src\routing\outcomes\timings.ts and the changed regions of D:\git\omr-cpx-main\src\routing\outcomes\persist.ts
  [/acceptance]
- **1.1.QA** [tier:heavy] Senior QA. CAP:none — reason: the outcome store, the timing recorder and stats interact across
  files.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p11 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p11\` at the fixed QA commit.
  Adversarial focus:
  - unbounded growth;
  - clock skew and non-monotonic `Date.now`;
  - rotation races between two processes;
  - orphan starts polluting estimates;
  - an outlier dominating p90;
  - text drift between the two stats renderers;
  - any v1 output change;
  - prompt text leaking into rows;
  - the `eventId` dedupe weakened.
- **1.1.FIX** [tier:medium] Fix every QA-1.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p11 tier=medium pin]
  Writes: the 1.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p11
  check: buildPasses
  check: testsPass
  criteria: every QA-1.1 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Dispatch timings:
  - start then outcome produces one row with the right duration;
  - an outcome without a start produces no row and one debug log;
  - two outcomes produce one row;
  - a duplicate `eventId` is ignored;
  - with 1001 open starts the oldest is evicted;
  - a start older than 6 h is closed as `unknown` and excluded from estimates;
  - each row is on disk when the recorder call returns (no coalesced flush);
  - *Amended by A-0.1-2:* a row with a non-null `capacity` round-trips and is excluded from estimates.
- Estimator:
  - 0, 4, 5 and 60 samples per level;
  - the full fallback chain;
  - only `succeeded` rows count;
  - window and age limits;
  - a single 10× outlier;
  - an empty store returns the prior, labeled `"prior"`.
- Orchestrator turns:
  - zero-token steps (no division by zero);
  - cache-write-only turns;
  - multi-step turns;
  - child sessions excluded;
  - a turn boundary at the prompt event.
- Store files:
  - rotation while appending;
  - a torn last line;
  - a future schema version skipped.
- Engine `static` still records timings and turns.
- D18 equality with and without the new rows.

**Acceptance criteria:**
- Every dispatch outcome produces exactly one timing row.
- Every orchestrator turn produces one turn row.
- Estimates follow the documented fallback.
- Stats render identically in both renderers, and v1 output is unchanged.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- Docs updated.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 1.2 — Cache-stable turn state and prompt-cache TTL [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p12` · **Depends on:** 0.1 (C5, C6)

**Goal:** on v2 the system prompt is byte-stable for a session, every per-turn router state is delivered in one tail placed
per C5, unread late notices persist until read, and v1 is unchanged.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - `D:\git\omr-cpx-main\src\index.ts` ≈3015-3074 (system assembly; pending ≈3057-3061; late notices ≈3065-3074)
    and ≈1914-1919 (`router_verify`);
  - `D:\git\omr-cpx-main\src\routing\wire\hint.ts` ≈64 and ≈204-215;
  - the context hook in `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1363-1480 (≈1422-1443 system part
    identity; ≈1445-1472 message shape);
  - *Not applicable (A-0.1-3, QA-0.1-31):* `ROUTING_DEFAULTS` and `resolveRouting` in `D:\git\omr-cpx-main\src\router\config.ts` (no TTL key is added).
- [ ] Read the ADR 0007 decisions for C5 (placement) and C6 (D5 is withdrawn by A-0.1-3: no TTL).
- [ ] List the golden snapshots that contain the pending or late blocks or the hint. They must stay unchanged; new v2
      snapshots are added.

**Order:** 1.2.1 → (1.2.2 ∥ 1.2.3) → 1.2.4 → 1.2.5 → 1.2.6 → 1.2.7 → QA.

**Tasks**
- **1.2.1** [tier:heavy] CAP:4 Design memo (returned; the orchestrator records it under `## Implementation notes`).
  [route class=design risk=high scope=multi d=none root=D:\git\omr-cpx-p12 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts, the C5 and C6 rows of
  `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  The memo covers:
  - *Amended by A-0.1-2 and A-1.2-1:* the tail placement per C5 (new last `user` message) and the D4 breakpoint hint: on a copy of the last non-blank text part of
    the last real message, else its last `tool-result` or `media` part, else no hint; never on an earlier message; the
    host may mark the tail itself when its four-marker budget is not used (ADR 0007 D4, O12);
  - keeping host part identity and order in the system array;
  - the provider registry API;
  - the size bound and the overflow line;
  - determinism rules: no clocks in the system; ages rounded to minutes in the tail only;
  - *Not applicable (A-0.1-3):* the TTL rule per C6/D5 (D5 is withdrawn; no `ttlSeconds` hint, the system array is never changed, no O11 gate);
  - the late-notice retention rule (kept and rendered until `router_verify` returns the handle);
  - a proof that v1 does not regress.
- **1.2.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\compat\turn-state.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\compat\turn-state.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.2.md` (`## Implementation notes`).
  - 1.2.2.a `registerTurnStateProvider({name, order, render(sessionID): string | undefined, active?(sessionID): boolean})`
    returns an unregister function. A duplicate name is rejected.
  - 1.2.2.b `buildTurnState(sessionID): string | undefined`:
    - renders the providers in `order`, each section trimmed;
    - caps the total at 6000 characters, ending with an overflow line `… N more lines`;
    - adds `(router_plan action=status)` to that line only while a plan provider reports activity;
    - wraps the result in `<router-state>…</router-state>` (Appendix B);
    - skips a provider that throws and logs that once per provider name.
  - 1.2.2.c `hasActivity(sessionID)`.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: buildPasses
  check: testsPass
  criteria: output is deterministic for equal provider outputs; the 6000-character bound holds
  [/acceptance]
- **1.2.3** *Not applicable: superseded by A-0.1-3 (QA-0.1-17, QA-0.1-31).* ADR 0007 D5 is withdrawn on OpenCode v2.0.26: no `routing.promptCache.ttl` key, no config row, no drift pin, no TTL hint, no O11. The task has no route line and no acceptance block.
- **1.2.4** [tier:medium] VERIFY:required Turn-state providers, v2 only. The v1 path stays byte-identical.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\routing\wire\hint.ts`.
  Reads: `D:\git\omr-cpx-main\src\compat\turn-state.ts`, `D:\git\omr-cpx-main\src\verify\pending.ts`.
  - 1.2.4.a The pending list and the late notices become providers instead of `output.system.push`.
  - 1.2.4.b A notice taken from the background queue stays in a per-session buffer, rendered every turn, until
    `router_verify` returns its handle.
  - 1.2.4.c The advise hint becomes a provider.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: buildPasses
  check: testsPass
  criteria: on v2 no system part is pushed for pending, late or hint; v1 legacy transform output equals the golden byte for byte
  [/acceptance]
- **1.2.5** [tier:medium] VERIFY:required Context hook.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`. Reads: `D:\git\omr-cpx-main\src\compat\turn-state.ts`. *Amended by A-0.1-3 (QA-0.1-31):* `src\router\config.ts` is no longer read; the TTL key is not added.
  - 1.2.5.a *Amended by A-0.1-2 and A-1.2-1:* On every request of a root session with non-empty state, append the tail as a new last `user` message (C5), and set
    `cache: {type: "ephemeral"}` (no TTL) on a copy of the last non-blank `text` part of the last real message; if that
    message has none, on its last `tool-result` or `media` part; if it has neither, no hint (never an earlier message;
    D4, O12 observed on v2.0.26). Host message objects are never mutated.
  - 1.2.5.b *Not applicable (A-0.1-3):* D5 is withdrawn. A system part's identity, order and text are never changed; the system array is never changed.
  - 1.2.5.c *Not applicable (A-0.1-3):* D5 is withdrawn; no `ttlSeconds` hint is set on any part. No part other than the D4 hint part gets a hint.
  - 1.2.5.d *Amended by A-0.1-2:* Child sessions get no tail and no hint.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: buildPasses
  check: testsPass
  criteria: consecutive context builds keep event.system deep-equal and host parts identical by reference while the state changes. *Amended by A-0.1-3 (QA-0.1-31):* no TTL is resolved or set, and no system part's `cache` differs
  [/acceptance]
- **1.2.6** [tier:medium] VERIFY:required Docs, drift pins and goldens.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\VERIFICATION.md`, `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\test\golden\` (new v2 snapshots).
  Reads: `D:\git\omr-cpx-main\src\compat\turn-state.ts`.
  - 1.2.6.a `D:\git\omr-cpx-main\docs\VERIFICATION.md`: on v2, the pending list and late notices arrive in the
    per-turn router state; notices stay until read.
  - 1.2.6.b `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`: a new "Per-turn router state" section.
  - 1.2.6.c Drift pins for both, and for the config key if 1.2.3 added it.
  - 1.2.6.d New v2 golden snapshots; existing ones unchanged.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: testsPass
  criteria: docs-drift green; existing snapshot files byte-identical; new v2 snapshots added with reasons in the report
  [/acceptance]
- **1.2.7** [tier:medium] VERIFY:required New tests, and updates to the existing v2-hooks tests.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\turn-state.test.ts`, `D:\git\omr-cpx-main\test\integration\v2-turn-state.test.ts`,
  `D:\git\omr-cpx-main\test\smoke\cpx-cache-prefix.smoke.test.ts`, `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\compat\turn-state.ts`, `D:\git\omr-cpx-main\src\index.ts`,
  `D:\git\omr-cpx-main\src\routing\wire\hint.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`,
  `D:\git\omr-cpx-main\src\router\config.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets §0.10-10 for D:\git\omr-cpx-main\src\compat\turn-state.ts
  [/acceptance]
- **1.2.QA** [tier:heavy] Senior QA. CAP:none — reason: cache stability depends on every writer of the system array and the
  messages.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p12 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p12\` at the fixed QA commit.
  Adversarial focus:
  - per-turn variability left in the system array: Map order, config reload, model switch, enforcement-mode flips, hint
    memo expiry;
  - the tail persisted into history;
  - the tail changing an older message;
  - a provider exception breaking a request;
  - late notices lost;
  - v1 drift;
  - *Not applicable (A-0.1-3):* TTL emission (D5 is withdrawn); instead, any `ttlSeconds` or any change to the system array is a defect;
  - a hint on the tail, on more than one message, or left on an earlier message;
  - a tail in child sessions.
- **1.2.FIX** [tier:medium] Fix every QA-1.2 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p12 tier=medium pin]
  Writes: the 1.2-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.2.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p12
  check: buildPasses
  check: testsPass
  criteria: every QA-1.2 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Builder:
  - provider order;
  - empty state returns `undefined`;
  - exactly 6000 and 6001 characters;
  - the overflow line with and without plan activity;
  - a throwing provider;
  - a duplicate name;
  - unregister.
- Adapter:
  - three context builds while the pending list goes 0 → 2 → 1: `event.system` is deep-equal and host parts are identical
    by reference, while the tail differs;
  - the advise hint is in the tail;
  - *Amended by A-0.1-2:* child sessions get no tail and no hint;
  - *Amended by A-1.2-1:* the hint is on the last non-blank text part of the last real message, else on its last `tool-result` or `media` part, else absent, and never on an earlier message;
  - an unread late notice is rendered on two consecutive turns and disappears after `router_verify`.
- v1: the legacy system transform output is byte-identical to the existing golden.
- Smoke (scripted provider):
  - *Amended by A-0.1-2:* request N+1 equals request N byte for byte through request N's last real message, except for the `cache_control`
    object request N put on that message (the moved D4 hint); request N's tail is absent from request N+1;
  - *Amended by A-1.2-1:* the single message breakpoint sits on the last real message, never on the tail, while the host's four-marker budget is used (with a single system part, no tools, or no router hint the host may mark the tail itself); on v2.0.26 a request whose last real message is a tool result carries the marker on the `tool_result` block (O12, observed);
  - *Not applicable (A-0.1-3):* no `ttl: "1h"` appears on any block.

**Acceptance criteria:**
- On v2 no router-generated system part changes between the turns of a session.
- All dynamic state is in the tail.
- Notices persist until read.
- v1 output is unchanged.
- *Amended by A-0.1-3 (QA-0.1-31):* No TTL is set (D5 is withdrawn); the only breakpoint is the D4 ephemeral hint on the last real message.

**Definition of Done:**
- §0.9 met.
- Tests, typecheck and `npm run smoke:cpx` green; coverage met.
- New v2 goldens explained.
- docs-drift green.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 1.3 — File lease registry [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p13` · **Depends on:** 0.1 (C9)

**Goal:** one pure registry that guarantees single-writer files and no reads under another agent's edit in the same tree,
and one extractor that turns any file, search or `router_run` tool call into normalized targets. Wiring happens in 2.1
(shared tree) and 3.1 (plan tasks).

**Pre-flight (in addition to §0.9)**
- [ ] Read `D:\git\omr-cpx-main\src\verify\dispatch.ts`:
  - ≈101 (write tools);
  - ≈468-488 (`record` and the `apply_patch` header parse).

  List its existing tests.
- [ ] Read ADR 0007 C9 (argument shapes per tool, including `router_run`).
- [ ] Read `verifyRoleRepository` in `D:\git\omr-cpx-main\src\router\git-tools.ts` ≈968-972 (repository key from
      `--git-common-dir`).

**Order:** 1.3.1 → (1.3.2 ∥ 1.3.3) → 1.3.4 → QA.

**Tasks**
- **1.3.1** [tier:heavy] CAP:3 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=single d=none root=D:\git\omr-cpx-p13 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts, the C9 row of
  `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  The memo covers:
  - key normalization:
    - case folding on win32;
    - separators;
    - `..`;
    - trailing dots and spaces;
    - realpath of the nearest existing ancestor (junctions and symlinks);
    - 8.3 short names;
    - the repo-relative form;
  - scopes: `until-complete` and `until-integrated`;
  - re-entrancy, release, sweep;
  - deny-not-wait: no deadlock by construction, with a note on livelock;
  - search filtering;
  - only child (delegated) sessions hold leases; a root session never holds one, and its writes are refused only while a
    child holds the file;
  - the `router_run` rule: under a foreign write lease in the same tree it runs and is annotated as possibly
    contaminated; refused only when `runMode` is `"refuse"`.
- **1.3.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\router\tool-paths.ts`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p13 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\tool-paths.ts`, `D:\git\omr-cpx-main\src\verify\dispatch.ts`.
  Reads: the C9 row of `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`, the existing tests of
  `D:\git\omr-cpx-main\src\verify\dispatch.ts`.
  - 1.3.2.a `toolTargets(tool, args, cwd) → {access: "read"|"write"|"search"|"run"|"none", paths, roots}`. It handles:
    - *Amended by A-0.1-2:* `read`, `write`, `edit` (`path`; observed, C9);
    - `multiedit`, `patch`, `list` (shapes from the existing router code only; not advertised by v2.0.26, ADR 0007 O9);
    - `apply_patch`: multi-file add, update, delete and move, where both the old and the new path are writes (shape from the existing router code only; not advertised, ADR 0007 O9);
    - `glob`, `grep` (`path` root + `pattern`; observed);
    - `router_run`, whose access is `run` with its cwd as the root (`cwd` from the router's own schema, `src\router\run-tools.ts` ≈160, ≈882-885);
    - a write-class call whose target cannot be extracted returns `access: "write"` with no paths, which 2.1 refuses for a
      child session while a foreign write lease exists in the tree.
  - 1.3.2.b The `apply_patch` header parser moves here, and `D:\git\omr-cpx-main\src\verify\dispatch.ts` imports it
    back with unchanged behavior.
  [acceptance]
  cwd: D:\git\omr-cpx-p13
  check: buildPasses
  check: testsPass
  criteria: existing verify dispatch tests pass unchanged; every C9 tool shape maps to the right access and paths
  [/acceptance]
- **1.3.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\router\leases.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p13 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\leases.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.3.md` (`## Implementation notes`).
  - 1.3.3.a `createLeaseRegistry(seams: {realpath, repoKeyOf, now}, opts: {runMode: "annotate" | "refuse"})` provides:
    - `acquireWrite(holder, path)`;
    - `checkRead(reader, path)`;
    - `checkRun(runner, tree) → {ok: true} | {ok: true, contaminatedBy: Holder[]} | {ok: false, holders: Holder[]}` (the
      last only when `runMode` is `"refuse"`);
    - `filterSearchResults(reader, tree, paths)`;
    - `release(holderID)`;
    - `releaseTask(taskRef)`;
    - `sweep()`, `snapshot()`, `restore(snapshot)`.

    A holder is `{holderID, tree, isChild, taskRef?, scope, acquiredAt}`.
  - 1.3.3.b *Amended by A-1.3-1 (Phase 1.3, ADR 0007 D7):* Conflict rules:
    - a write conflicts across every tree of the same repository;
    - a read or run conflicts only in the same physical tree, with a different **owner** (ownership is the task,
      `taskRef ?? holderID`, not the session: sessions of one task never conflict with each other); the read, search and
      run restrictions apply to another child session only, and a root session is never refused a read, a search or a
      run;
    - a run also conflicts with leases under the run directory (include leases), not only those of the run tree;
    - a path spelling that cannot be keyed and may still name any file (device path, drive-relative path, rooted path
      without a drive, 8.3 short name in a missing path) fails closed;
    - a root (non-child) session never acquires a lease; its write to a file a child holds is refused.
  - 1.3.3.c *Amended by A-1.3-1:* Limits: a cap of 10 000 leases, with a clear refusal when full. The `checkRun` cost is the leases of the run tree plus those under the run directory, not O(1) (all leases, up to the cap, when a child's run directory cannot be keyed).
  [acceptance]
  cwd: D:\git\omr-cpx-p13
  check: buildPasses
  check: testsPass
  criteria: every spelling of one file maps to one lease; conflicts name the holder
  [/acceptance]
- **1.3.4** [tier:medium] VERIFY:required New tests.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p13 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\leases.test.ts`, `D:\git\omr-cpx-main\test\unit\tool-paths.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\router\leases.ts`, `D:\git\omr-cpx-main\src\router\tool-paths.ts`,
  `D:\git\omr-cpx-main\src\verify\dispatch.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p13
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/router gate (90 lines, 90 branches, 90 functions) for D:\git\omr-cpx-main\src\router\leases.ts and D:\git\omr-cpx-main\src\router\tool-paths.ts
  [/acceptance]
- **1.3.QA** [tier:heavy] Senior QA. CAP:none — reason: path normalization and concurrency semantics need adversarial inputs
  across both modules.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p13 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p13\` at the fixed QA commit.
  Adversarial focus:
  - two spellings of one file getting two leases;
  - a rename or move escaping the lease;
  - `apply_patch` moving a file into a leased path;
  - holders never released;
  - a read under a foreign lease allowed through `grep`;
  - a `router_run` under a foreign lease neither annotated nor (under `refuse`) refused;
  - a root session holding or blocking a lease;
  - a behavior change in `D:\git\omr-cpx-main\src\verify\dispatch.ts`.
- **1.3.FIX** [tier:medium] Fix every QA-1.3 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p13 tier=medium pin]
  Writes: the 1.3-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.3.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p13
  check: buildPasses
  check: testsPass
  criteria: every QA-1.3 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Normalization: the same file in different spellings maps to one key:
  - case;
  - separators;
  - `..`;
  - trailing dot or space;
  - a junction created in the test;
  - an 8.3 name where the volume supports it.
- A path outside the repository gets its own key space.
- Conflicts:
  - A holds X and B writes X: conflict naming A;
  - B reads X in A's tree: `underEdit`;
  - B reads X in another tree: allowed;
  - B runs `router_run` in A's tree: allowed and annotated with A (refused under `runMode: "refuse"`);
  - B runs `router_run` in another tree: allowed;
  - A re-acquires X: allowed (re-entrant);
  - the orchestrator (root) edits X, then a child reads X and runs `router_run`: both allowed;
  - a root write to a file a child holds: refused, naming the child;
- Scopes: `until-complete` ends at `release`; `until-integrated` ends only at `releaseTask`.
- `filterSearchResults` omits exactly the leased files and reports their count.
- Sweep backstop at 6 h; refusal when the cap is reached; snapshot and restore.
- Every C9 tool shape, including:
  - `apply_patch` with add, update, delete and move;
  - empty args;
  - non-string paths, ignored and never thrown.

**Acceptance criteria:**
- The registry enforces single-writer and no-read-under-edit for every spelling of a path, annotates (or, under
  `runMode: "refuse"`, refuses) a `router_run` under a foreign lease, and never gives a lease to a root session.
- The extractor covers every C9 tool.
- Verify dispatch behavior is unchanged.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 1.4 — Executor contracts [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p14` · **Depends on:** 0.1

**Goal:** the types, interfaces and task state machine (Appendix A) that every executor module implements or consumes.
Phases 2.2–2.4 and 3.x build in parallel against this fixed contract, and `src/executor/**` is gated by coverage.

**Pre-flight (in addition to §0.9)**
- [ ] Appendix A; *Amended by A-0.1-2:* ADR 0007 decisions C7, C13, C14, D13, D14 and D16 (launcher A, its six guards, the `capacity` and `lost` attempt
  outcomes and the counting rule).
- [ ] Sample the style of `D:\git\omr-cpx-main\src\verify\types.ts` and
      `D:\git\omr-cpx-main\src\compat\child-session.ts`; read the coverage thresholds in
      `D:\git\omr-cpx-main\vitest.config.ts` ≈18-31 and ≈65-76.

**Order:** 1.4.1 → 1.4.2 → (1.4.3 ∥ 1.4.4) → QA.

**Tasks**
- **1.4.1** [tier:heavy] CAP:4 Contract memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=multi d=none root=D:\git\omr-cpx-p14 tier=heavy pin]
  Writes: none. Reads (pasted): Appendix A, ADR decisions.
  The memo specifies:
  - every state and every legal transition, with its trigger;
  - every interface method, with pre- and postconditions and error behavior;
  - the seams: `Clock`, `GitRunner`, `Spawner`, `FileSystem`, `HostSessions`, `ChildRunner`.
- **1.4.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\types.ts`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p14 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\types.ts`.
  Reads: the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`
  (`## Implementation notes`).
  The file defines:
  - the ledger data: `LEDGER_SCHEMA = 1`, `LedgerV1`, `TaskNode`, `Edge`, `Footprint`, `TaskState` (including `done`),
    `GateState`, `Attempt` (with `nonce`), `InboxItem`, `SlotRecord`, `IntegrationEntry`;
  - the `ExecutorEvent` union, including `metric` and `integration-step` events;
  - `TASK_TRANSITIONS` with `canTransition`, including `ready` → `pending` when `add-tasks` adds an unsatisfied
    dependency;
  - the guards `isLedgerV1` and `isTaskNode`;
  - `FINDINGS_FORMAT`, the JSON schema a QA task returns: `{findings: [{id, severity, files, problem, fix}]}`;
  - the interfaces (`LedgerStore` includes `remove(planId)`) `LedgerStore`, `PlanCompiler`, `SlotPool`, `IntegrationQueue`, `Scheduler`, `CapacityController`,
    `TaskLauncher` (launcher A only, ADR 0007 D14; *Amended by A-0.1-2*), `ExecutorRuntime`, `RecoveryService`, `UnattendedPolicy`, `QaLoop`;
  - `ExecutorConfig`.
  [acceptance]
  cwd: D:\git\omr-cpx-p14
  check: buildPasses
  criteria: the types encode Appendix A exactly, including done, cancel paths, blocked-on-revert and commit-failure transitions
  [/acceptance]
- **1.4.3** [tier:medium] VERIFY:required Coverage gate: add `"src/executor/**/*.ts": { branches: 90, lines: 90, functions: 90 }`
  to `D:\git\omr-cpx-main\vitest.config.ts`.
  [route class=implement risk=low scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p14 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\vitest.config.ts`. Reads: `D:\git\omr-cpx-main\.github\workflows\test.yml`.
  [acceptance]
  cwd: D:\git\omr-cpx-p14
  check: testsPass
  criteria: the threshold exists; the existing thresholds are unchanged
  [/acceptance]
- **1.4.4** [tier:medium] VERIFY:required New tests in `D:\git\omr-cpx-main\test\unit\executor-types.test.ts`.
  [route class=implement risk=low scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p14 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-types.test.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p14
  check: testsPass
  check: buildPasses
  criteria: every (from, to) pair of TaskState is tested against TASK_TRANSITIONS; guards reject 200 fuzzed malformed ledgers
  [/acceptance]
- **1.4.QA** [tier:heavy] Senior QA. CAP:none — reason: the contract constrains every later phase.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p14 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p14\` at the fixed QA commit.
  Adversarial focus:
  - a state with no exit;
  - any path to `integrated` that skips `verified`;
  - a missing state for restart adoption, a parent interrupt, an abort or a revert;
  - seams that force real I/O in unit tests;
  - unserializable fields;
  - *Amended by A-0.1-2:* a `TaskLauncher` contract that cannot express the D14 guards (confirmation timeout, stale context, refresh wake,
    recorded age, unrequested interrupt, no launch after a restart before the first router tool call).
- **1.4.FIX** [tier:medium] Fix every QA-1.4 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p14 tier=medium pin]
  Writes: the 1.4-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p14
  check: buildPasses
  check: testsPass
  criteria: every QA-1.4 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- The exhaustive transition matrix.
- Terminal states (`integrated` except to `reverted`, `done`, `cancelled`) have no other exits.
- Guards on fuzzed JSON: missing fields, wrong types, a newer schema, extra fields preserved.
- A typed test double for every interface compiles and is used once.

**Acceptance criteria:**
- The contract encodes Appendix A exactly.
- No path from `pending` to `integrated` skips `verified`.
- `src/executor/**` is gated at 90/90/90.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

---

### Wave 2 (2.1 ∥ 2.2 ∥ 2.3 ∥ 2.4; each starts when its own dependencies are merged)

#### Phase 2.1 — Background-first dispatch with completion-time guarantees [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p21` · **Depends on:** 1.1, 1.2, 1.3

**Goal:** on v2:
- long dispatches run in the background by default;
- every router guarantee is applied exactly once when the child completes, including for dispatches the user backgrounds;
- required verification never exposes an unverified result: it is held when C4 and C15 hold, and stays in the foreground
  otherwise;
- pending verifications survive restarts;
- agents in a shared working tree never write the same file nor read a file under another agent's edit; a `router_run`
  under a foreign lease is annotated as possibly contaminated (refused under `routing.leases.run: "refuse"`).

**Pre-flight (in addition to §0.9)**
- [ ] Read and paste into the design memo:
  - `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈78-87, ≈200-206, ≈299-355, ≈830, ≈1363-1480, ≈1504-1640,
    ≈1700-1810, ≈1819-1880;
  - `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts` ≈241, ≈358-420, ≈1048, ≈1764-1769;
  - `D:\git\omr-cpx-main\src\index.ts` ≈2154-2158, ≈2297-2440, ≈3031-3032;
  - `D:\git\omr-cpx-main\src\verify\wiring.ts` ≈1237-1249, ≈1403-1410, ≈1444-1520, ≈1557, ≈1668-1710, ≈2132-2137;
  - `D:\git\omr-cpx-main\src\verify\pending.ts` ≈76-78, ≈114-154, ≈340-341, ≈435-446, ≈1745-1780;
  - `D:\git\omr-cpx-main\src\verify\dispatch.ts` ≈219-238, ≈287-301, ≈374-445;
  - `D:\git\omr-cpx-main\src\router\protocol.ts` ≈69, ≈216, ≈450.
- [ ] Read the ADR 0007 decisions for C1, C2, C3, C4, C7, C8, C9, C13 and C15, and the 1.1 handoff (the
      timing-recorder calls to wire).
- [ ] The Wave 1 APIs in `cpx/main`:
  - from 1.1: `createTimingRecorder` (`recordDispatchStart`, `onExecutionOutcome`, `markRootSession`, `onRootPrompt`,
    `onRootStep`, `onCapacitySignal`, `sweep`) and `createDurationModel`; *Amended by A-0.1-2*
  - from 1.2: `registerTurnStateProvider`;
  - from 1.3: `createLeaseRegistry`, `toolTargets`.
- [ ] List the existing tests of `D:\git\omr-cpx-main\src\verify\wiring.ts`,
      `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts`,
      `D:\git\omr-cpx-main\src\router\protocol.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` and
      `D:\git\omr-cpx-main\src\verify\reference.ts`. They are owned by this phase.

**Order:** 2.1.1 → (2.1.2 ∥ 2.1.3) → 2.1.4 → 2.1.5 → 2.1.6 → 2.1.7 → 2.1.8 → QA.

**Tasks**
- **2.1.1** [tier:heavy] CAP:6 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=repo d=none root=D:\git\omr-cpx-p21 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts and ADR decisions.
  The memo covers:
  - the dispatch state machine: decided → acknowledged → child-ended → processed → annotated | held → verdict →
    released;
  - the race matrix for every ordering of acknowledgement, execution-end event, completion message, verdict, parent
    interrupt, child resume, compaction (including a held completion in the latest turn, which the host keeps out of
    the compaction request: ADR 0007 O13), verdict delivery to a busy parent, and restart (*Amended by A-0.1-2*);
  - idempotency keys;
  - the bounded wait in the context hook (2000 ms);
  - the single `finishDispatch` path shared by foreground and background;
  - background annotations delivered in the turn-state "completed" section (D2); foreground annotations stay in the
    tool result;
  - the held placeholder, kept for the session's life (C4 and C15), or the foreground fallback;
  - the pending persistence format and its reload rules;
  - lease wiring points and their messages;
  - deferral of verification under a foreign lease;
  - memory bounds;
  - v1 inertness.
- **2.1.2** [tier:medium] VERIFY:required Config keys (declared before any code uses them):
  - `routing.background.mode` (`"auto"|"model"|"off"`, default `"auto"`);
  - `routing.background.minPredictedMs` (integer 0–3600000, default 45000);
  - `routing.leases.mode` (`"enforce"|"off"`, default `"enforce"`);
  - `routing.leases.run` (`"annotate"|"refuse"`, default `"annotate"`);
  - on v1, a configured key logs one notice and is ignored.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.1.md` (`## Implementation notes`).
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: the keys resolve through ROUTING_DEFAULTS/resolveRouting with range validation; routing table rows exist and are pinned
  [/acceptance]
- **2.1.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\compat\background.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\compat\background.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.1.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`,
  `D:\git\omr-cpx-main\src\router\leases.ts`.
  - 2.1.3.a `decideBackground(input)` follows D1 exactly:
    - an estimate with `source: "prior"` never selects background by itself;
    - required verification may run in the background only if `holdingAvailable` (C4 and C15);
    - `off` reproduces `nativeArgs` exactly.
  - 2.1.3.b `InFlightRegistry`, keyed by call id and child session id. Live dispatches are capped at 1000. The per-session
    rendering state (held placeholders) is kept until `session.deleted`.
  - 2.1.3.c `CompletionProcessor.process(childSessionID, trigger)`:
    - runs once per child attempt; a resumed child is a new attempt;
    - calls the injected `finishDispatch`;
    - records the timing outcome;
    - releases the `until-complete` leases;
    - renders the annotations in the turn-state "completed" section for the parent's next turn (D2); for a foreground
      call, the in-result annotation of `execute.after` is kept and the end-event trigger is suppressed while that
      call's `execute.after` is pending;
    - exposes `settled(childSessionID, timeoutMs)`.
  - 2.1.3.d `HeldResults`, only when holding is available:
    - the placeholder text is a pure function of the handle and never changes;
    - on the verdict, it posts one synthetic entry through the plugin API (`ctx.session.synthetic({sessionID, text,
      description, metadata, resume: true})`, ADR 0007 O6b; *Amended by A-0.1-2*) with the output and the verdict (PASS) or the
      findings (FAIL);
    - it refuses a `subagent` resume of a held child until the verdict.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: decideBackground matches D1 for every row of its table; process() is idempotent per attempt
  [/acceptance]
- **2.1.4** [tier:medium] VERIFY:required Finish path, held state, pending persistence and verification deferral. Foreground
  behavior must stay byte-identical.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\verify\wiring.ts`,
  `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\verify\dispatch.ts`,
  `D:\git\omr-cpx-main\src\verify\reference.ts`, and the existing tests of
  `D:\git\omr-cpx-main\src\verify\reference.ts` (listed in pre-flight).
  Reads: `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\router\leases.ts`.
  - 2.1.4.a In `D:\git\omr-cpx-main\src\index.ts`, extract `finishDispatch({callID, childSessionID, outputText,
    status})` from the legacy `tool.execute.after`. It covers budget and authority signals and deferred registration
    (≈2436).
  - 2.1.4.b `D:\git\omr-cpx-main\src\verify\dispatch.ts` computes the delta at child end, and
    `D:\git\omr-cpx-main\src\verify\wiring.ts` deferred finish accepts it.
  - 2.1.4.c `D:\git\omr-cpx-main\src\verify\pending.ts`:
    - gains a `held` handle state and verdict callbacks;
    - persists entries (handle, session, DoD, change set, reference commit, risk, description, state, createdAt) to
      `pending.jsonl` in the outcome store, append-only with tombstones;
    - reloads them on start within `pendingTtlMs`;
    - turns an entry whose reference commit is gone into `unverifiable` with a reason;
    - persists only when `ctx.routerHost === "v2"` (v1 unchanged);
    - persists the serialized dispatch reference (commit, tracked and untracked digests, links) so a reloaded handle
      verifies exactly; when it cannot be re-materialized, the reloaded handle is marked approximate;
    - reference GC at plugin start (`D:\git\omr-cpx-main\src\verify\reference.ts` ≈2052) spares references named by
      reloaded pending entries: export `keepReferences(keys)` from `D:\git\omr-cpx-main\src\verify\reference.ts`, which
      marks reloaded references active before the start-time GC delay.

    The orchestrator records an ADR 0007 amendment: DoD and description text are stored on disk in the outcome store.
  - 2.1.4.d `D:\git\omr-cpx-main\src\verify\wiring.ts` defers a plugin verification run while another holder has
    a write lease in the same tree, until the lease ends or the verification deadline passes; then it runs with the
    existing contamination caveat.
  - 2.1.4.e Export `preemptBackgroundVerification(): Promise<void>` from
    `D:\git\omr-cpx-main\src\verify\wiring.ts` (it aborts an in-flight background verification run, as the
    foreground `testsPass` path does today). Handoff to 3.2.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: all existing verification, pending and index tests pass unchanged; a pending handle survives a simulated restart and verifies through router_verify
  [/acceptance]
- **2.1.5** [tier:medium] VERIFY:required v2 wiring (one writer task for both files).
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts`.
  Reads: `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\compat\turn-state.ts`,
  `D:\git\omr-cpx-main\src\routing\outcomes\timings.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`,
  `D:\git\omr-cpx-main\src\router\tool-paths.ts`.
  - 2.1.5.a `execute.before`:
    - `decideBackground` replaces the forced foreground (`nativeArgs` ≈78-87, ≈1539-1540, ≈1604, ≈1631;
      `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts` ≈1764-1769);
    - every routed dispatch calls `recordDispatchStart`;
    - a resume of a held child is refused.
  - 2.1.5.b `execute.after` with `status === "running"` (≈1746-1761) registers the dispatch in flight, including
    user-backgrounded calls (C8), instead of returning without guarantees.
  - 2.1.5.c Event loop (≈1819-1880), per the 1.1 handoff. *Amended by A-1.1-1:* the recorder is acquired with
    `acquireTimingRecorder`, and the call points are those of the "Handoffs" section of
    `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.1.md`, which is binding. On v2 it creates the timing recorder
    (`acquireTimingRecorder`, replacing `createTimingRecorder`) whatever `routing.engine` is, and `createDurationModel` over `timings.jsonl`; it calls
    `observe` for each row the recorder appends, and `decideBackground` receives `estimate({role, class, scope})`:
    - *Amended by A-0.1-2:* `session.retry.scheduled` (`provider.rate-limit` → rate-limit,
      `provider.internal`/529 → overload, other types by status) and `session.step.failed` with `provider.quota`
      (→ usage-limit) call `onCapacitySignal` for that session (ADR 0007 D6/D13);
    - a child execution end calls `CompletionProcessor.process` and `onExecutionOutcome` (outcome taken from the event
      type);
    - `session.created` without `parentID` calls `markRootSession`, and lazily, on the first step of an unregistered
      session whose `ctx.session.get` has no `parentID`, calls `markRootSession`;
    - a root prompt calls `onRootPrompt`;
    - root step tokens feed the turn rows through `onRootStep`.
  - 2.1.5.d Context hook:
    - *Amended by A-0.1-2:* held placeholders are applied (C4) by replacing the held child's `<subagent sessionID="<id>" …>…</subagent>`
      element wherever it occurs in a text part (a whole message, or embedded text such as the compaction record's
      retained latest turn; ADR 0007 D3, O13);
    - turn-state providers "in flight" and "held" are registered (Appendix B);
    - turn-state provider "completed" (Appendix B);
    - *Amended by A-0.1-2:* the compaction hook applies the held placeholders with the same matcher (C15 holds; the hook receives every turn
      except the latest).
  - 2.1.5.e Leases, for every v2 child session (C9); root sessions take none (D7):
    - file tools and `router_run` in `execute.before` go through `toolTargets`, then `acquireWrite`, `checkRead` or
      `checkRun`;
    - a write or read conflict throws a refusal that names the holder (role, description, child session id) and tells
      the agent to finish without that file or return `NEED MORE: lease <path>`;
    - a `router_run` under a foreign lease runs, and its result carries the annotation
      `[router] ran while <holder> edits <n> file(s); result may be contaminated`; it is refused, naming the holder,
      only under `routing.leases.run: "refuse"`;
    - `execute.after` of `glob` and `grep` calls `filterSearchResults` and adds a one-line note;
    - leases are released on child execution end, interrupt or failure.
  - 2.1.5.f v2 only: one startup info log `[router] plugin root <realpath>`. *QA-0.P-16:* the phase records where
    the line lands (the router logger writes through `console.warn` when it has no client,
    `D:\git\omr-cpx-main\src\router\logger.ts` ≈103-110) and whether that sink tags it with the server's run id; Phase
    2.1 QA checks it. The DF gates do not depend on it.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: every row of the 2.1.1 race matrix has a test; guarantees run exactly once per child attempt; held results never leak; mode off equals the pre-phase golden behavior
  [/acceptance]
- **2.1.6** [tier:medium] VERIFY:required Protocol text, v2 only.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\protocol.ts`, `D:\git\omr-cpx-main\src\index.ts` (call site
  ≈3031-3032 only, after 2.1.4 committed), `D:\git\omr-cpx-main\test\golden\` (new v2 snapshots),
  `D:\git\omr-cpx-main\test\unit\protocol.test.ts`, `D:\git\omr-cpx-main\test\unit\protocol-directives.test.ts`,
  `D:\git\omr-cpx-main\test\golden\roles-protocol.golden.test.ts` (intentional v2 change: update `GOLDEN`).
  Reads: the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.1.md`
  (`## Implementation notes`).
  - 2.1.6.a The roles protocol, which is v2 only, and a host-aware `assembleSystemPrompt(cfg, model, enfOn, host)` add the
    background rules on v2:
    - after dispatching background work, continue any independent work;
    - when none remains, end the turn — the router wakes you;
    - never poll or sleep;
    - a held result is not usable until its verdict;
    - never report a task done while dispatches are listed in flight;
    - a lease refusal is resolved by waiting for the holder, not by retrying.
  - 2.1.6.b The v1 prompt stays byte-identical. Existing snapshots are unchanged; v2 snapshots are added.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: existing snapshot files byte-identical; new v2 snapshots contain the background rules; v1 tiers prompt unchanged; the roles protocol stays within the tiers protocol byte length (D:\git\omr-cpx-main\test\golden\roles-protocol.golden.test.ts ≈85); that pin is not weakened
  [/acceptance]
- **2.1.7** [tier:medium] VERIFY:required Docs.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\docs\ROLES.md`,
  `D:\git\omr-cpx-main\docs\VERIFICATION.md`, `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`,
  `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts`, `D:\git\omr-cpx-main\src\verify\wiring.ts`,
  `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\verify\dispatch.ts`,
  `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\router\config.ts`,
  `D:\git\omr-cpx-main\src\router\protocol.ts`.
  - 2.1.7.a `D:\git\omr-cpx-main\docs\OPENCODE_V2.md` ≈108-116: background-first behavior and the C4/C15
    condition for holding.
  - 2.1.7.b `D:\git\omr-cpx-main\docs\ROLES.md`: background and lease sections.
  - 2.1.7.c `D:\git\omr-cpx-main\docs\VERIFICATION.md`: required verification in the background, and pending
    handles surviving restarts.
  - 2.1.7.d Drift pins for all three.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: testsPass
  criteria: docs-drift green; every user-visible behavior of 2.1 is documented
  [/acceptance]
- **2.1.8** [tier:medium] VERIFY:required New tests, and updates to existing tests.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes:
  - new: `D:\git\omr-cpx-main\test\unit\background-policy.test.ts`,
    `D:\git\omr-cpx-main\test\unit\completion-processor.test.ts`,
    `D:\git\omr-cpx-main\test\unit\pending-persist.test.ts`,
    `D:\git\omr-cpx-main\test\integration\v2-background.test.ts`,
    `D:\git\omr-cpx-main\test\integration\v2-leases.test.ts`,
    `D:\git\omr-cpx-main\test\smoke\cpx-background.smoke.test.ts`;
  - updated: `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`,
    `D:\git\omr-cpx-main\test\smoke\role-spikes.smoke.test.ts`. Update ≈211-218 and ≈706-725: `off` reproduces
    the old rewrite; `auto` with a thin store adds no background key.

  Reads: `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`,
  `D:\git\omr-cpx-main\src\routing\wire\dispatch.ts`, `D:\git\omr-cpx-main\src\verify\wiring.ts`,
  `D:\git\omr-cpx-main\src\verify\pending.ts`, `D:\git\omr-cpx-main\src\verify\dispatch.ts`,
  `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\router\config.ts`,
  `D:\git\omr-cpx-main\src\router\protocol.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets §0.10-10 for D:\git\omr-cpx-main\src\compat\background.ts and the changed regions
  [/acceptance]
- **2.1.QA** [tier:heavy] Senior QA. CAP:none — reason: races span v2-hooks, the processor, verification, persistence and
  leases.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p21 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p21\` at the fixed QA commit.
  Adversarial focus:
  - any path where a held output reaches the orchestrator before its verdict: host text, a resume, compaction, a restart,
    the TUI;
  - an older message whose rendering changes (a cache break);
  - guarantees running twice or never;
  - `off` not identical to today;
  - registry or per-session state leaks;
  - persisted pending entries replayed for the wrong session;
  - a lease never released after a crash or interrupt;
  - a refusal an agent cannot act on;
  - any v1 change;
  - a verified user-backgrounded call that still bypasses acceptance.
- **2.1.FIX** [tier:medium] Fix every QA-2.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p21 tier=medium pin]
  Writes: the 2.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p21
  check: buildPasses
  check: testsPass
  criteria: every QA-2.1 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Policy table: every mode × explicit `true`/`false`/unset × estimate source (prior or n ≥ 5) × estimate below/at/above
  the threshold × `testsPass` × plan task × holding available or not.
- With `routing.engine: "static"`, a dispatch writes a timing row through the v2 adapter; after 5 sampled rows of one
  key with p50 ≥ 45 s, the next dispatch of that key goes to the background.
- Completion processing:
  - every ordering of acknowledgement, end event and completion message results in one processing, and the annotation
    appears in the tail of the parent's first request after completion (or in the next one, after the 2000 ms bound,
    with "router guarantees pending" before it);
  - a child that failed, was interrupted, was resumed (a new attempt), or never ends (bounded; `unknown` at sweep).
- Holding:
  - required verification with holding: the placeholder never changes across 3 requests; PASS posts output and verdict
    and wakes once; FAIL posts findings;
  - a resume while held is refused;
  - *Amended by A-0.1-2:* compaction keeps the placeholder, including a held completion in the latest turn (smoke, O13);
  - the verdict entry reaches a busy parent and an idle one (smoke);
  - without holding, the dispatch stays in the foreground.
- A user-backgrounded verified call is verified at completion (P3 fixed).
- Pending persistence:
  - restart with 3 open handles: reloaded and verifiable;
  - an expired entry is dropped;
  - a missing reference commit gives `unverifiable`;
  - reference GC at plugin start spares the references named by reloaded pending entries.
- Leases:
  - two implementers write one file: the second is refused, naming the holder;
  - a reader in the same tree is refused; a `router_run` there is annotated (refused under `refuse`);
  - in another worktree, both are allowed;
  - the orchestrator's own edits take no lease and never block a child;
  - a grep result is filtered with a count;
  - leases are released on end, interrupt and failure;
  - a verification run is deferred and then runs with the caveat.
- `off` gives arguments and results identical to the pre-phase behavior; v1 is inert, with one notice per configured key.
- Smoke: a background implementer dispatch returns at once; the orchestrator's next scripted step runs before the child
  ends; the annotation appears in the turn-state tail of the next request.

**Acceptance criteria:**
- Background is the default for long dispatches on v2.
- Every guarantee happens exactly once at completion.
- No held result is visible before its verdict.
- Pending handles survive restarts.
- Shared-tree leases are enforced.
- `off` restores today's behavior.

**Definition of Done:**
- §0.9 met.
- `npm run typecheck`, the phase's scoped tests (§0.6-9) and `npm run smoke:cpx` green.
- In the orchestrator shell, these are green: `npm run smoke:v2`, `npm run smoke:routing`, `npm run smoke:v2:e2e`, and
  `npx cross-env RUN_OC_SMOKE_ROLES=1 RUN_OC_SMOKE_ROLE_SPIKES=1 vitest run --config vitest.smoke.config.ts test/smoke/roles.smoke.test.ts test/smoke/role-spikes.smoke.test.ts`.
- Coverage met.
- New v2 goldens explained; docs updated.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Dogfood switch DF-1 — the rest of the plan runs on background-first dispatch [tier:fast] switch + [tier:heavy] QA

**Worktrees:**
- `D:\git\omr-cpx-dogfood-df1`: the build the host loads, a new worktree checked out at tag `cpx/df1`;
- `D:\git\omr-cpx-scratch`: a throwaway worktree for the probes, branch `cpx/scratch-df1` from `cpx/main`, removed at the
  end of the switch.

**Depends on:** 2.1.

**Goal:** from here on, the orchestrator and every delegate of this plan run on the plan's own build. Background-first
dispatch, completion-time guarantees, leases, the cache-stable turn state, telemetry and persistent pending
verifications are then exercised for real, by the plan's remaining phases.

**Pre-flight (in addition to §0.12-3 step 1)**
- [ ] 2.1 is merged. `cpx/main` is green on typecheck, the scoped tests of every phase merged since the previous switch, `npm run smoke:cpx` and `npm run smoke:v2`
      (orchestrator shell).
- [ ] The 0.P.3.f record exists: plugin-entry scope, change, revert, and owner consent.
- [ ] `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` exists in `D:\git\omr-cpx-main` with
      the metrics of every phase finished so far: the "before DF-1" baseline, from the handover's timestamps.

**Tasks**
- **DF1.1** Orchestrator: tag `cpx/df1` on `cpx/main` and push it. Drain in-flight dispatches. Set the handover next
  action to "DF-1 self-check".
- **DF1.2** Orchestrator: create `D:\git\omr-cpx-dogfood-df1` at `cpx/df1` (§0.12-3 step 3) and apply the plugin-entry
  change in the recorded scope. Record both, and the exact revert command, in the handover. Set
  `verify.pendingTtlMs: 86400000` in `D:\git\omr-cpx-main\.opencode\opencode-model-router.overrides.jsonc` before the
  DF-1 restart (read at plugin start, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md` ≈407); it stays until DF2.4.a
  removes it.
- **DF1.3** Planned human action: restart OpenCode in the recorded way, continue the same session in
  `D:\git\omr-cpx-main`, and type `continue`.
- **DF1.4** Self-check probes on the new build. Create `D:\git\omr-cpx-scratch` with
  `git -C D:\git\omr-cpx-main worktree add -b cpx/scratch-df1 D:\git\omr-cpx-scratch cpx/main`, then `npm ci`.
  Writes: `D:\git\omr-cpx-scratch\docs\dogfood-probe.md` (DF1.4.c only). Reads: `D:\git\omr-cpx-scratch\`,
  `C:\Users\Marquinho\.local\share\opencode\log\opencode.log` (QA-0.P-16), `/router stats`.
  - DF1.4.a **Build loaded.** *Amended by QA-0.P-16:* pass when the run-scoped self-check of 0.P.6 (marker run id,
    `loading plugin` set equal to the regenerated config, router entrypoint
    `file:///D:/git/omr-cpx-dogfood-df1/server.ts`, versioned server executable) passes in
    `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`, `git -C <root> rev-parse HEAD` equals
    `git -C D:\git\omr-cpx-main rev-parse cpx/df1^{commit}`, and exactly one `router_verify` tool is registered. The
    2.1.5.f `[router] plugin root <realpath>` line is supporting evidence only when its sink tags it with that run.
  - DF1.4.b **Background.** Dispatch a runner with an acceptance block containing `check: testsPass`:
    [route class=other risk=low scope=single needs=shell d=deterministic root=D:\git\omr-cpx-scratch tier=fast pin]
    ```
    [acceptance]
    cwd: D:\git\omr-cpx-scratch
    check: testsPass
    criteria: the scoped tests of D:\git\omr-cpx-scratch\test\unit\turn-state.test.ts pass
    [/acceptance]
    ```
    Pass: the call returns a running acknowledgement at once; the orchestrator makes another tool call before the child
    ends; after completion, the turn-state tail shows the "completed" section with its verification handle.
  - DF1.4.c **Leases.** Every dispatch below uses `background: true`. Child 1 writes
    `D:\git\omr-cpx-scratch\docs\dogfood-probe.md`, then runs
    `router_run {script: "test-files", args: ["--maxWorkers=2", "test/unit"], cwd: "D:\git\omr-cpx-scratch"}` before
    returning. This is a probe exception to §0.6-9: no other suite runs during the drain.
    [route class=implement risk=low scope=single needs=edit,shell d=none root=D:\git\omr-cpx-scratch tier=fast pin]
    The orchestrator waits until `git -C D:\git\omr-cpx-scratch status --porcelain` shows the file (a probe exception to
    the no-polling rule, at most once per 10 s), then dispatches:
    - child 2, writing the same file:
      [route class=implement risk=low scope=single needs=edit,shell d=none root=D:\git\omr-cpx-scratch tier=fast pin]
    - an explorer reading it:
      [route class=recon risk=low scope=single d=none root=D:\git\omr-cpx-scratch tier=fast pin]
    - a runner running
      `router_run {script: "test-files", args: ["--maxWorkers=2", "test/unit/turn-state.test.ts"], cwd: "D:\git\omr-cpx-scratch"}`:
      [route class=other risk=low scope=single needs=shell d=none root=D:\git\omr-cpx-scratch tier=fast pin]

    Pass, while child 1 holds the file:
    - the second child is refused with the holder named;
    - the explorer's read is refused;
    - the runner's result carries the contamination annotation.

    After child 1 ends, the read is allowed.
  - DF1.4.d **Telemetry.** The orchestrator runs `node D:\git\omr-cpx-dogfood-df1\scripts\routing-stats.ts` in its
    shell, with `--dir <routing.outcomes.path>` when that key is set (on v2 its output equals `/router stats`, D18). It shows dispatch-duration rows for the probes, and the
    orchestrator cache-read-share line.
  - DF1.4.e **Cache.** Record the cache-read share over the first 5 orchestrator turns, from the same `routing-stats.ts`
    run. A p50 below 0.5 is a DF fault to
    investigate. Prefix stability itself is proven by `D:\git\omr-cpx-main\test\smoke\cpx-cache-prefix.smoke.test.ts`.
  - DF1.4.f **Held results.** Only if C4 and C15 hold: dispatch a runner in the background with `VERIFY:required`:
    [route class=other risk=low scope=single needs=shell d=deterministic root=D:\git\omr-cpx-scratch tier=fast pin]
    [acceptance]
    cwd: D:\git\omr-cpx-scratch
    check: testsPass
    criteria: the scoped tests of D:\git\omr-cpx-scratch\test\unit\turn-state.test.ts pass
    [/acceptance]
    Pass: the completion shows the fixed placeholder until its verdict, then the output with the verdict.
  - DF1.4.h **Cleanup.** Remove the scratch worktree and its branch
    (`git -C D:\git\omr-cpx-main worktree remove D:\git\omr-cpx-scratch`, `git -C D:\git\omr-cpx-main branch -D cpx/scratch-df1`).
- **DF1.5** Orchestrator: record every probe result and every deviation (`DF-1-<k>`) in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`, and commit
  `docs(qa): DF-1 dogfood self-check`.
- **DF1.QA** [tier:heavy] Senior QA of the switch. CAP:none — reason: needs the probe evidence, the build and the
  config change together.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-main tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-main\` at the fixed QA commit, and the DF-1 evidence in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`.
  Adversarial focus:
  - a probe that passed without exercising the new build (an old build loaded, or the router loaded twice);
  - a scope change that also moved the other implementation's sessions without consent;
  - a deviation recorded as a pass;
  - leftover scratch state;
  - a missing rollback path.
- **DF1.FIX** Every finding is fixed:
  - a probe or record issue by the orchestrator;
  - a code fault in a dogfood fix phase `pdf1-<k>` (§0.12-4), with a regression test.

  Heavy re-reviews per §0.7.

**New tests:** probes DF1.4.a–f on the real host; a regression test for every DF-1 fault (in its fix phase).

**Acceptance criteria:**
- Probes DF1.4.a–e pass, and f when C4 and C15 hold.
- The scratch worktree is removed.
- `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` records the evidence.
- The other implementation's sessions are unaffected, or the owner consented.

**Definition of Done:**
- The acceptance criteria hold.
- DF1.QA has zero open findings.
- Every DF-1 fault is fixed and merged, or tracked to a fix phase that does not hinder execution.
- The handover next action names the next phase.

#### Phase 2.2 — Durable ledger store [tier:medium]

**Worktree:** `D:\git\omr-cpx-p22` · **Depends on:** 1.4

**Goal:** `LedgerStore` (Appendix A) persists a plan crash-safely in the repository's git common directory:
- one writer at a time, readers without a lock;
- an fsync before any externally visible step.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - `D:\git\omr-cpx-main\src\routing\file-lock.ts` (API and stale detection);
  - the retry pattern in `D:\git\omr-cpx-main\src\routing\outcomes\persist.ts` ≈223-253;
  - `D:\git\omr-cpx-main\test\helpers\remove-dir.ts`.
- [ ] Read the `--git-common-dir` resolution in `D:\git\omr-cpx-main\src\verify\reference.ts` ≈2056 and
      `inspectGit` in `D:\git\omr-cpx-main\src\router\git-tools.ts` ≈992.

**Order:** 2.2.1 → 2.2.2 → 2.2.3 → QA.

**Tasks**
- **2.2.1** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\paths.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p22 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\paths.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`,
  `D:\git\omr-cpx-main\src\router\git-tools.ts`.
  - 2.2.1.a `resolveExecutorHome(dir)`: the realpath of `git rev-parse --git-common-dir` + `\omr-executor\`, run through
    hardened git with no shell.
  - 2.2.1.b Directories: `planDir(home, planId)` and `slotMarkersDir(home)` (`<home>\slots\`).
  - 2.2.1.c `planId`:
    - validation `^[a-z0-9][a-z0-9-]{2,40}$`;
    - `newPlanId(planPath, digest, options, now)` hashes path + digest + compile options and returns
      `p-<yyyymmdd>-<6 hex of sha256(path + digest + options)>`.
  [acceptance]
  cwd: D:\git\omr-cpx-p22
  check: buildPasses
  check: testsPass
  criteria: the main checkout and a linked worktree resolve to the same home
  [/acceptance]
- **2.2.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\ledger.ts` implementing `LedgerStore`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p22 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\ledger.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`,
  `D:\git\omr-cpx-main\src\executor\paths.ts`, `D:\git\omr-cpx-main\src\routing\file-lock.ts`.
  - 2.2.2.a **Journal.** `events.<firstSeq>.jsonl` holds one `ExecutorEvent` per line, with a strictly increasing `seq`.
    An fsync runs after **every** transition into `dispatched`, `running`, `completed`, `integrating`, `integrated`,
    `reverted` or `cancelled`, after every Attempt write, gate change and inbox write, and before the step becomes
    visible outside the plugin (a launch, a prompt returned to the host, a git ref move).
  - 2.2.2.b **Snapshot.** `ledger.json` is written to `ledger.json.tmp-<pid>-<rand>`, fsynced, then renamed. On Windows,
    EPERM and EBUSY are retried within a 2 s budget. A snapshot is taken every 200 events and on close. After a
    snapshot the journal is **rotated** to a new file and old journal files are deleted only after a successful
    snapshot. Readers retry when the snapshot `seq` and the first journal `seq` do not match.
  - 2.2.2.c **Load** = the snapshot, plus a replay of the events with a greater `seq`.
    - A torn last line is dropped with one warning.
    - A `seq` gap, or an illegal transition (`canTransition`), fails the load and names the offending event.
  - 2.2.2.d **Schema.** A newer schema is refused. Older ones migrate through an explicit table (empty at v1; tested).
  - 2.2.2.e **Single writer.** A lock file holds `{pid, hostname, sessionID, startedAt, heartbeatAt}`, with a 10 s
    heartbeat. The lock is stale when the pid is dead on this host or the heartbeat is older than 60 s. Takeover happens
    only through `takeover(reason)`, which is journaled. Readers never take the lock.
  - 2.2.2.f `remove(planId)` deletes the plan directory; only for completed or aborted plans.
  [acceptance]
  cwd: D:\git\omr-cpx-p22
  check: buildPasses
  check: testsPass
  criteria: no crash point loses an fsynced event or yields a ledger that fails replay; readers see a consistent state during rotation
  [/acceptance]
- **2.2.3** [tier:medium] VERIFY:required New tests, including a crash test that kills a child process mid-write.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p22 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-ledger.test.ts`, `D:\git\omr-cpx-main\test\integration\executor-ledger-crash.test.ts`,
  `D:\git\omr-cpx-main\test\fixtures\cpx\ledger\`. Reads: `D:\git\omr-cpx-main\src\executor\ledger.ts`,
  `D:\git\omr-cpx-main\src\executor\paths.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p22
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/executor gate (90/90/90)
  [/acceptance]
- **2.2.QA** [tier:heavy] Senior QA. CAP:none — reason: crash consistency and locking need the store, its tests and the
  lock helper together.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p22 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p22\` at the fixed QA commit.
  Adversarial focus:
  - torn writes at every step;
  - a visible step (launch, ref move) not preceded by an fsync;
  - two processes holding the lock;
  - a takeover while the old writer is alive but slow;
  - antivirus holding the temp file;
  - replay accepting an illegal transition;
  - a reader losing events during rotation;
  - a ledger written into a worktree's private git dir.
- **2.2.FIX** [tier:medium] Fix every QA-2.2 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p22 tier=medium pin]
  Writes: the 2.2-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.2.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p22
  check: buildPasses
  check: testsPass
  criteria: every QA-2.2 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Round trip of a 500-task ledger.
- Snapshot cadence and journal rotation; a concurrent reader during rotation.
- Crash points, injected by killing a child process:
  - after a journal write, before the snapshot;
  - during the temp write;
  - after the temp write, before the rename;
  - between a `dispatched` fsync and the launch.

  In every case the load yields the last fsynced state.
- Load errors:
  - a torn last line;
  - a `seq` gap;
  - an illegal transition;
  - a newer schema;
  - unknown extra fields, which are preserved.
- Lock:
  - a second writer is refused, with the holder's info;
  - stale by dead pid;
  - stale by heartbeat;
  - a journaled takeover;
  - readers never blocked.

**Acceptance criteria:**
- Persistence is crash-safe, single-writer and schema-checked.
- Every externally visible step is preceded by an fsync.
- Readers need no lock.
- Everything lives in the git common dir.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 2.3 — Plan compiler [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p23` · **Depends on:** 1.1 (duration model), 1.3 (`toolTargets`), 1.4

**Goal:** `PlanCompiler` turns any plan, annotated or not, into a validated ledger draft:
- tasks with stable ids, routes, acceptance, footprints and typed dependency edges;
- an estimate;
- one architect dispatch to fill the residue.

The result is safe to run in parallel.

**Pre-flight (in addition to §0.9)**
- [ ] Read the parsing building blocks:
  - `splitPlan` and the tag helpers in `D:\git\omr-cpx-main\src\routing\commands\annotate-plan.ts` (≈45, ≈50,
    ≈244-292, ≈348-355);
  - `annotateSteps` and the route-line format in `D:\git\omr-cpx-main\src\routing\engine\plan.ts` (≈90,
    ≈134-183, ≈293-400);
  - `parseRouteLine` in `D:\git\omr-cpx-main\src\routing\classify\route-line.ts` (≈43, ≈53, ≈131-167,
    ≈199-206, ≈280);
  - `parseAcceptanceBlock` in `D:\git\omr-cpx-main\src\verify\dod.ts` (≈50-51, ≈230-299).
- [ ] Count the tasks of the four sample plans by hand, including pre-flight items, and record the counts. These are the frozen fixture inputs of
      2.3.7:
  - `D:\git\omr-cpx-main\docs\plans\delegation-depth-and-effort-bump-plan.md`;
  - `D:\git\omr-cpx-main\docs\plans\verification-resource-budget-plan.md` (graph block ≈473-482);
  - `D:\git\omr-cpx-main\docs\plans\role-tier-assurance-delegation-plan.md`;
  - `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`, from `cpx/main`.

**Order:** 2.3.1 → (2.3.2 ∥ 2.3.3) → 2.3.4 → 2.3.5 → 2.3.6 → 2.3.7 → QA.

**Tasks**
- **2.3.1** [tier:heavy] CAP:6 Design memo (returned; recorded by the orchestrator). It ties each rule to an excerpt of the
  sample plans.
  [route class=design risk=high scope=multi d=none root=D:\git\omr-cpx-p23 tier=heavy pin]
  Writes: none. Reads (pasted): excerpts of the four plans and the pre-flight code.
  The memo covers:
  - the recognized grammar: waves; phases; pre-flight; tasks; subtasks; QA and FIX steps; ownership tables in both
    formats; graph blocks; `Writes:` and `Reads:` lines;
  - the id grammar and how ids stay stable;
  - footprint rules and their confidence;
  - edge kinds, with precedence and evidence;
  - the residue protocol and its JSON schema;
  - validation and the concurrency closure;
  - the estimate formula.
- **2.3.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\compile\parse.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\compile\parse.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.3.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\routing\commands\annotate-plan.ts`,
  `D:\git\omr-cpx-main\src\routing\classify\route-line.ts`, `D:\git\omr-cpx-main\src\verify\dod.ts`, `D:\git\omr-cpx-main\src\routing\engine\plan.ts`.
  - 2.3.2.a Structure:
    - `### Wave N`;
    - phase headings: `#### Phase X.Y …`, `#### P1.1 …`, `## Phase …`;
    - the blocks "Pre-flight", "Tasks", "New tests", "Acceptance criteria", "Definition of Done", "QA review" and
      "Order:".
  - 2.3.2.b Task ids:
    - the leading token of a top-level list item matching
      `^(?:\*\*)?(?:T|P)?\d+(?:\.(?:\d+|[A-Z]{1,4}))+[a-z]?(?:\*\*)?`. This accepts `1.1.1`, `**1.1.1**`, `T1.1.1`,
      `0.P.1`, `1.1.QA` and `1.1.FIX`;
    - subtasks: `X.Y.Z.a`;
    - a plan without ids falls back to `splitPlan` with ids `S<8 hex of sha1(normalized first line)>-<ordinal among equal
      hashes>`.
  - 2.3.2.c Annotations per task:
    - `[tier:X]`;
    - the route line, unwrapped when backticked, then `parseRouteLine`;
    - `VERIFY:` and `CAP:`;
    - the first `[acceptance]` block (`parseAcceptanceBlock`);
    - `Writes:` and `Reads:` lines;
    - QA steps become `kind: "qa"` and FIX steps `kind: "fix"`;
    - a task with no route line whose text starts with "Orchestrator" or "Planned human action" becomes
      `kind: "manual"`.
  - 2.3.2.d Unannotated tasks: one `annotateSteps` call gives role, tier and route line.
  - 2.3.2.e Shared plan context: if the plan contains a block delimited by `<!-- plan-context -->` and
    `<!-- /plan-context -->`, that block is the shared context. Otherwise the text before the first wave heading, with
    every absolute path under a worktree root replaced once, at compile time, by `<worktree>\<repo-relative path>`.
    Either way it is capped at `sharedContextChars`.
  - 2.3.2.f Special sections:
    - headings `#### Dogfood switch DF-<n> …` are phase-like sections with ids `DF<n>.<k>` and `DF<n>.QA`; their tasks
      are `manual`; they are never part of a `phases` run. In `Depends on:`, `DF-<n>` is an external gate, satisfied by
      `doneBefore`;
    - pre-flight checklist items compile as `kind: "preflight"` tasks handled like `manual`, before the phase's first
      task. "New tests", "Acceptance
      criteria" and "Definition of Done" are gate metadata, never tasks, when the phase has explicit task ids;
    - `X.Y.FIX` steps are not launched; they become the `QaLoop` fix template for that phase.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: every id form above is recognized; backticked and plain annotations parse identically
  [/acceptance]
- **2.3.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.3.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\router\tool-paths.ts`.
  - 2.3.3.a Path extraction:
    - absolute paths under the repository or any of its worktrees. Roots come from `git worktree list --porcelain`;
      other roots such as `D:\git\omr-<prefix>-<id>` are mapped through a repo-relative suffix that exists;
    - repo-relative paths that contain a separator;
    - backticked file names resolved through `git ls-files`, used only when the match is unique;
    - new files marked `*(new)*` or introduced by a create verb, when their parent exists or is created earlier;
    - URLs, and paths outside the repository or on another drive, are ignored and reported.
  - 2.3.3.b Write versus read classification:
    - `Writes:` lines and ownership-table rows count as writes (`explicit`, `ownership`);
    - write verbs also count as writes (`explicit`): "In `X`:", implement, create, add to, modify, update, replace,
      tests in, move, delete;
    - `Reads:` lines and other mentions count as reads (`inferred`);
    - an editing role with no write path is `unknown`.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: footprints for this plan's tasks equal their Writes:/Reads: lines; worktree-root paths map to repo-relative paths
  [/acceptance]
- **2.3.4** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\compile\edges.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\compile\edges.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.3.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\executor\compile\parse.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`.
  - 2.3.4.a Structural edges:
    - a phase's "Depends on" line;
    - inside a phase, the "Order:" line when present, otherwise pre-flight → tasks → tests → QA → gate;
    - FIX steps come after QA;
    - with `crossPhase: "gate"`, the next wave comes after the previous wave's gates; with `"inferred"`, only after its
      inferred dependencies.
  - 2.3.4.b Explicit edges:
    - phrases "after", "depends on", "requires", "blocked by", "once … is merged", "merged first", "builds on",
      "codes against", "uses the API from", each with a task or phase id;
    - graph blocks with `->`, `→` or `-->`.
  - 2.3.4.c Contract-first: inside a phase, a task that creates an interface, contract, types or schema precedes the tasks
    that read or write its files.
  - 2.3.4.d Conflict serialization: when two tasks could run concurrently and their write sets overlap, or one writes what
    the other reads, an edge is added in plan order (`kind: "conflict"`).
  - 2.3.4.e Every edge carries `kind`, `confidence` and the evidence span.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: the explicit dependencies of the sample plans are present as edges; this plan's Depends on and Order lines produce exactly its intended graph
  [/acceptance]
- **2.3.5** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\compile\residue.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\compile\residue.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.3.md` (`## Implementation notes`).
  - 2.3.5.a The residue request covers tasks with `unknown` or low-confidence footprints, plus the candidate implicit
    dependencies. It is rendered as a ready architect dispatch prompt: route line first, with a JSON schema.
  - 2.3.5.b Response validation: schema, known ids, and paths that resolve inside the repository.
  - 2.3.5.c Monotone merge: the residue adds edges and footprints only, and never removes or weakens deterministic ones.
    The draft is then re-validated.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: a residue that deletes, weakens or escapes the repository is rejected with a precise error
  [/acceptance]
- **2.3.6** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\compile\validate.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\estimate.ts`, `D:\git\omr-cpx-main\src\executor\compile\index.ts`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\compile\validate.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\estimate.ts`, `D:\git\omr-cpx-main\src\executor\compile\index.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\compile\parse.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`, `D:\git\omr-cpx-main\src\executor\compile\edges.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\residue.ts`, `D:\git\omr-cpx-main\src\routing\outcomes\durations.ts`.
  - 2.3.6.a Validation:
    - cycles, reporting the minimal cycle;
    - unknown and duplicate ids;
    - paths outside the repository;
    - the concurrency closure: after conflict edges, no two tasks without a path between them overlap in writes, or in
      a write and a read.
  - 2.3.6.b Estimate:
    - W;
    - CP, from bottom levels with the 1.1 duration model;
    - width;
    - expected makespan max(CP, W/p, ΣI_est);
    - a compact summary.
  - 2.3.6.c `compile(planPath, opts) → {draft, residueRequest?, summary}` implements `PlanCompiler`. `opts.phases` (ids)
    compiles only those phases; `opts.doneBefore` (a phase id) records every task of earlier phases as `done` with the
    evidence "merged before the run", so edges into them are satisfied. `doneBefore` also sets every earlier phase gate
    to `passed`.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: the closure property holds on every fixture; a 300-task synthetic plan compiles in under 2 s
  [/acceptance]
- **2.3.7** [tier:medium] VERIFY:required New tests and frozen fixtures.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes:
  - `D:\git\omr-cpx-main\test\unit\executor-compile-parse.test.ts`,
    `D:\git\omr-cpx-main\test\unit\executor-compile-footprint.test.ts`,
    `D:\git\omr-cpx-main\test\unit\executor-compile-edges.test.ts`,
    `D:\git\omr-cpx-main\test\unit\executor-compile-residue.test.ts`,
    `D:\git\omr-cpx-main\test\unit\executor-compile-real-plans.test.ts`;
  - in `D:\git\omr-cpx-main\test\fixtures\cpx\plans\`: frozen copies of the four sample plans, the hand counts,
    and synthetic plans.

  Reads: `D:\git\omr-cpx-main\src\executor\compile\parse.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\footprint.ts`, `D:\git\omr-cpx-main\src\executor\compile\edges.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\residue.ts`, `D:\git\omr-cpx-main\src\executor\compile\validate.ts`,
  `D:\git\omr-cpx-main\src\executor\compile\estimate.ts`, `D:\git\omr-cpx-main\src\executor\compile\index.ts`,
  and the sample plans in `D:\git\omr-cpx-p23\docs\plans\`.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: testsPass
  check: buildPasses
  criteria: tests read only the frozen fixtures, never D:\git\omr-cpx-main\docs\plans\; every edge case listed under New tests exists; coverage meets the src/executor gate
  [/acceptance]
- **2.3.QA** [tier:heavy] Senior QA. CAP:none — reason: compiler correctness is judged against real plans and adversarial
  plan text.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p23 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p23\` at the fixed QA commit.
  Adversarial focus:
  - a missed dependency that lets two tasks race on one file (closure bypass);
  - false edges that serialize independent work;
  - a residue that removes or weakens data;
  - paths escaping the repository (`..`, other drives, UNC);
  - ids that change when unrelated lines are edited;
  - fences and inline code confusing the parser;
  - quadratic blowups;
  - tests depending on the owner's checkout.
- **2.3.FIX** [tier:medium] Fix every QA-2.3 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p23 tier=medium pin]
  Writes: the 2.3-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.3.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p23
  check: buildPasses
  check: testsPass
  criteria: every QA-2.3 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Frozen real plans:
  - task counts equal the hand counts;
  - every id is recognized;
  - at least 80% of editing tasks have a write footprint;
  - the explicit edges are present ("1.3.4 starts after Phase 1.1 is merged", the verification plan's graph block).
- This plan:
  - every `X.Y.Z`, `X.Y.QA`, `X.Y.FIX` and `0.P.n` id;
  - footprints equal its `Writes:`/`Reads:` lines;
  - edges equal §3.1 and the "Order:" lines;
  - this plan compiled with `phases: ["6.1"]` and `doneBefore: "6.1"`: only 6.1's tasks, with every earlier dependency
    satisfied; orchestrator steps compile as `manual`;
  - this plan with `phases: ["6.1"]`, `doneBefore: "6.1"` yields exactly 6.1.1–6.1.5 and 6.1.QA, with the pre-flight
    items as `preflight` tasks and 6.1.4 as `manual`; 6.1's pre-flight manual tasks are ready at approval; 6.1.1 becomes
    ready after they are reported done.
- Parser inputs:
  - an unannotated flat list;
  - headings only;
  - nested subtasks;
  - fences that contain list items;
  - inline code paths;
  - both separator styles;
  - paths in other worktrees;
  - a path on another drive (ignored and reported).
- Errors:
  - a graph cycle;
  - duplicate ids;
  - a residue that adds a cycle;
  - a residue that deletes an edge, changes a write set or points outside the repository.
- Lines inserted above a task leave its id unchanged.
- A 300-task plan compiles in under 2 s.

**Acceptance criteria:**
- The compiler produces a valid, concurrency-safe draft for real and unannotated plans.
- Ids are stable.
- The residue merge is monotone.
- Tests are hermetic.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 2.4 — Worktree slot pool and provisioning [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p24` · **Depends on:** 1.4

**Goal:** `SlotPool` gives each plan task an isolated, provisioned worktree on the repository's drive.
- It resets the worktree between tasks without reinstalling.
- It cleans ignored build outputs before checks.
- It runs Node and Python commands with the slot's own dependencies.
- It never touches anything it did not create.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - `spawnBounded`, `gitEnvironment` and `hardeningArgs` in `D:\git\omr-cpx-main\src\router\git-tools.ts`
    (≈582, ≈145-149, ≈152);
  - in `D:\git\omr-cpx-main\src\verify\reference.ts`: worktree creation, junctions and drift (≈236-238,
    ≈346-356, ≈859-907, ≈1296, ≈1663-1673, ≈1764-1845);
  - in `D:\git\omr-cpx-main\src\router\run-tools.ts`: npm resolution without a shell (≈551-554) and the spawn
    env (≈855);
  - `mergeEnv` in `D:\git\omr-cpx-main\src\verify\exec.ts` ≈396.

  List the existing tests of `D:\git\omr-cpx-main\src\router\run-tools.ts` and
  `D:\git\omr-cpx-main\src\verify\exec.ts`.
- [ ] Measure on this machine and record:
  - `pnpm install --frozen-lockfile` with a warm store, in a fresh worktree of a fixture;
  - `py -3 -m venv .venv` plus `pip install -r requirements.txt`;
  - whether the pnpm store is on `D:`.

**Order:** 2.4.1 → 2.4.2 → 2.4.4 → 2.4.3 → 2.4.5 → 2.4.6 → QA.

**Tasks**
- **2.4.1** [tier:heavy] CAP:5 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=multi d=none root=D:\git\omr-cpx-p24 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts and measurements.
  The memo covers:
  - slot layout, with markers kept in the executor home;
  - the lifecycle: absent → creating → provisioning → ready ⇄ leased → resetting → ready; broken; retired;
  - provisioning detection, the argv per manager, and `PROVISION_MANIFESTS`;
  - the env model on Windows and POSIX;
  - the drift rule;
  - the clean-for-checks rule;
  - GC safety rules;
  - commit identity;
  - the hooks policy;
  - Windows hazards: long paths, EBUSY, antivirus, handles held open in `node_modules`.
- **2.4.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\git.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\git.ts`. Reads: `D:\git\omr-cpx-main\src\router\git-tools.ts`,
  the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.4.md` (`## Implementation notes`).
  - 2.4.2.a Base: `spawnBounded`, the hardened environment, `-c core.longpaths=true`, and `-c core.hooksPath=<empty dir>`.
  - 2.4.2.b Commit identity is read once from the repository's effective config with the user's normal environment, and
    passed as `-c user.name=… -c user.email=…`. If it is missing, raise an actionable error; never use a made-up
    identity. Every executor commit message is `<type>(<scope>): <task title> [<planId>:<taskId>]`: type from the task
    kind (`feat`, `fix`, `test`, `docs`; `revert` for reverts), scope = the phase id; no trailers; the message is
    validated against `^[a-z]+\([\w.-]+\): .{1,72}` and truncated at a word boundary.
  - 2.4.2.c Ref names are validated with `git check-ref-format`. Plan and task ids are encoded so that no ref can be
    injected.
  - 2.4.2.d Operations:
    - worktrees: `worktreeAdd` (detached), `worktreeRemove` (never `git worktree prune`);
    - working tree: `checkoutDetach`, `cleanTracked` (`clean -ffd`), `cleanForChecks` (`clean -ffdx` with an `-e`
      exclusion for each dependency directory of the detected managers: `node_modules`, `.venv`, `.yarn`, `.pnp.*`);
    - commits: `addAll`, `commit`, `revParse`, `diffNames`;
    - history: `rebaseOnto`, `rebaseAbort`, `cherryPick`, `mergeFfOnly`, `revert`, `tag`, `isAncestor`;
    - inspection: `statusPorcelain`;
    - refs: `deleteRefs(prefix)`, only for refs under `omr/<planId>/`, validated per 2.4.2.c;
    - `branchForce`, only under `omr/`.
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: buildPasses
  check: testsPass
  criteria: no operation runs a shell; hooks never run; ids with ref-unsafe characters are rejected or encoded
  [/acceptance]
- **2.4.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\slots\pool.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\slots\pool.ts`. Reads: `D:\git\omr-cpx-main\src\executor\git.ts`,
  `D:\git\omr-cpx-main\src\executor\types.ts`, `D:\git\omr-cpx-main\src\executor\slots\provision.ts`,
  the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.4.md` (`## Implementation notes`).
  - 2.4.3.a Layout:
    - `slotsDir` comes from `ExecutorConfig` (trusted and validated, D18);
    - it contains `slot-<n>\`, `integration\` and `ci\`;
    - markers are `<markersDir>\<slot>.json` (planId, repo key, kind, state, provisioned manifest digests, createdAt),
      where `markersDir` is injected and is the executor home's `slots\`;
    - nothing is written into the repository's `info/exclude`.
  - 2.4.3.b `acquire(planId, taskId, baseCommit)`, `release(slot)`, and `reset(slot, commit)` (checkout detached, then
    clean tracked). When the `PROVISION_MANIFESTS` digests differ, the slot is re-provisioned.
  - 2.4.3.c GC:
    - removes only directories under `slotsDir` that have a valid marker whose plan is completed or aborted, or unknown
      for 7 days;
    - runs `worktreeRemove` of the marked slot, then removes the directory within the EBUSY budget; never
      `git worktree prune`, only `git worktree remove` of marked slots;
    - never follows a junction or symlink out of the slot;
    - reports anything without a marker and never touches it;
    - runs automatically when a plan is completed or aborted, and on `router_plan action=gc`.
  - 2.4.3.d Markers left in `creating`, `provisioning` or `resetting` are repaired or retired on next use.
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: buildPasses
  check: testsPass
  criteria: GC never removes an unmarked directory or anything reached through a link; concurrent acquire never double-leases a slot
  [/acceptance]
- **2.4.4** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\slots\provision.ts`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\slots\provision.ts`. Reads: `D:\git\omr-cpx-main\src\router\run-tools.ts`,
  `D:\git\omr-cpx-main\src\verify\reference.ts` (`DEPENDENCY_FILES`, read only), the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.4.md` (`## Implementation notes`).
  - 2.4.4.a `PROVISION_MANIFESTS` per manager:
    - Node: the exported `DEPENDENCY_FILES`;
    - pip: `requirements*.txt`, `pyproject.toml`, `setup.py`, `setup.cfg`;
    - uv: `uv.lock` and `pyproject.toml`;
    - poetry: `poetry.lock` and `pyproject.toml`.
  - 2.4.4.b Detection and argv:
    - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile --prefer-offline`;
    - `package-lock.json` → `npm ci --prefer-offline --no-audit --no-fund`;
    - `yarn.lock` → `yarn install --frozen-lockfile` (classic), or `yarn install --immutable` when `.yarnrc.yml` exists;
    - `uv.lock` → `uv sync --frozen`;
    - `poetry.lock` → `poetry install --no-interaction` with `POETRY_VIRTUALENVS_IN_PROJECT=true`;
    - pip → `<python> -m venv .venv`, then `.venv\Scripts\python -m pip install -r requirements.txt`, plus
      `requirements-dev.txt` when present. An editable `-e .` install runs only when the project declares a build
      backend and setuptools imports in the venv, with `--no-build-isolation`.
  - 2.4.4.c Trusted per-repository overrides (`executor.provision`, argv arrays) take precedence.
  - 2.4.4.d Execution:
    - entry scripts are resolved without a shell, as `D:\git\omr-cpx-main\src\router\run-tools.ts` does for npm;
    - `UV_CACHE_DIR` is set to `<slotsDir drive>\.omr-cache\uv` when the default cache is on another drive;
    - output is bounded, every command has a timeout, and errors are actionable;
    - installs are serialized per package manager across the machine, with a lock at
      `$env:LOCALAPPDATA\omr-executor\locks\<manager>.lock` on Windows (`$HOME/.cache/omr-executor/locks` on POSIX).
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: buildPasses
  check: testsPass
  criteria: a change to any manifest of the slot's managers triggers re-provisioning; a missing manager binary yields an actionable error
  [/acceptance]
- **2.4.5** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\slots\env.ts` and its two users.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\slots\env.ts`, `D:\git\omr-cpx-main\src\router\run-tools.ts`,
  `D:\git\omr-cpx-main\src\verify\exec.ts`. Reads: `D:\git\omr-cpx-main\src\executor\slots\pool.ts`.
  - 2.4.5.a `slotEnvFor(cwd)` applies when `cwd` is inside a registered slot (marker lookup, cached). It returns
    `{VIRTUAL_ENV, PATH}`: the slot's `.venv\Scripts` (or `.venv/bin`) and `node_modules\.bin` first, and `PYTHONPATH`
    removed.
  - 2.4.5.b It is applied in the spawn env of `D:\git\omr-cpx-main\src\router\run-tools.ts` and in `mergeEnv` of
    `D:\git\omr-cpx-main\src\verify\exec.ts`.
  - 2.4.5.c Handoff to 5.1: the role-agent permission for `slotsDir` (`D:\git\omr-cpx-main\src\router\role-agents.ts`).
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: buildPasses
  check: testsPass
  criteria: existing run-tools and exec tests pass unchanged; outside a slot the environment is unchanged
  [/acceptance]
- **2.4.6** [tier:medium] VERIFY:required New tests, fixtures and the provisioning smoke.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-git.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-slots.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-provision.test.ts`,
  `D:\git\omr-cpx-main\test\integration\executor-slots-git.test.ts`,
  `D:\git\omr-cpx-main\test\smoke\cpx-provision.smoke.test.ts` and
  `D:\git\omr-cpx-main\test\fixtures\cpx\repos\`:
  - `node-npm` and `node-pnpm`, with zero registry dependencies;
  - `py-pip`, with `requirements.txt` and no `-e .`, plus a `tests` package;
  - `py-uv`.

  Reads: `D:\git\omr-cpx-main\src\executor\git.ts`, `D:\git\omr-cpx-main\src\executor\slots\pool.ts`,
  `D:\git\omr-cpx-main\src\executor\slots\provision.ts`, `D:\git\omr-cpx-main\src\executor\slots\env.ts`,
  `D:\git\omr-cpx-main\src\router\run-tools.ts`, `D:\git\omr-cpx-main\src\verify\exec.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: testsPass
  check: buildPasses
  criteria: unit and integration tests are offline; a Python test run in a slot imports the slot's source; coverage meets the src/executor and src/router/src/verify gates
  [/acceptance]
- **2.4.QA** [tier:heavy] Senior QA. CAP:none — reason: filesystem, git and process safety on Windows across five modules.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p24 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p24\` at the fixed QA commit.
  Adversarial focus:
  - any delete or clean outside a marked slot, including links pointing out and forged markers;
  - `clean -x` without the dependency exclusions;
  - a slot importing the main checkout's code (editable install, workspace link, `PYTHONPATH`);
  - env leaking between slots;
  - ref-name injection;
  - made-up commit identities or hooks running;
  - long-path and EBUSY failures;
  - concurrent acquire races;
  - stale build outputs surviving into checks.
- **2.4.FIX** [tier:medium] Fix every QA-2.4 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p24 tier=medium pin]
  Writes: the 2.4-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-2.4.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p24
  check: buildPasses
  check: testsPass
  criteria: every QA-2.4 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Real git in temporary repositories:
  - a slot goes through create, lease, reset (tracked changes gone, `node_modules` and `.venv` kept), drift and
    re-provision, then retire;
  - `cleanForChecks` removes `dist\` and keeps the dependency directories;
  - GC with a marked directory, an unmarked one (it survives) and a junction pointing out (its target survives).
- Concurrency: `acquire` called 8 times on 4 slots succeeds exactly 4 times; the rest wait or are refused per the
  contract.
- Ref names: `omr/p-20261010-abc123/t/1.1.1` is valid; ids with spaces, `..`, `~`, `^` or `:` are rejected or encoded.
- `deleteRefs`: deletes exactly the refs under `omr/<planId>/`; any other prefix (`omr/` alone, `cpx/`, another plan's
  prefix) is refused.
- Identity and hooks: with the repository config present it is used; when absent, an actionable error; a failing hook
  never runs.
- Commit messages: `<type>(<scope>): <task title> [<planId>:<taskId>]` for each task kind and for reverts; no trailers;
  the format is validated; a long title is truncated at a word boundary.
- Provisioning:
  - detection for every lockfile combination, and overrides;
  - a missing manager binary;
  - drift on `requirements.txt`, `pyproject.toml`, `uv.lock`, `poetry.lock` and `pnpm-lock.yaml`;
  - two concurrent provisions of the same manager run one after the other.
- `slotEnvFor`: inside a slot, outside, nested paths, case differences; `PYTHONPATH` is removed.
- uv tests skip, with a recorded reason, when `uv` is absent.
- Smoke (`npm run smoke:cpx:provision`, orchestrator shell):
  - pnpm and pip slots are provisioned;
  - `pytest` in a slot reports the slot's module path;
  - a second task reuses the slot without reinstalling (timed).

**Acceptance criteria:**
- Slots are isolated, provisioned and reusable, each with its own environment.
- Checks run on clean outputs.
- GC cannot touch foreign directories.

**Definition of Done:**
- §0.9 met.
- Tests, typecheck and the provisioning smoke green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

---

### Wave 3 (3.1 ∥ 3.2)

#### Phase 3.1 — Scheduler, adaptive capacity, launcher and executor runtime [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p31` · **Depends on:** 2.1, 2.2, 2.3, 2.4

**Goal:** the runtime drives a compiled plan to completion:
- it computes the ready set by critical-path priority within adaptive capacity;
- it launches ready tasks into slots with launcher A (ADR 0007 D14: executor-direct through the child runner) (*Amended by A-0.1-2*);
- it binds each child's role and work root;
- it holds plan-task leases until integration and hands verified tasks to the integration queue through its interface;
- it records the metrics of Appendix D.

**Pre-flight (in addition to §0.9)**
- [ ] *Amended by A-0.1-2:* ADR 0007 decisions C10, C13, C14, D13 and D14 (launcher A and its six guards, context capture, binding, launch
  signal and progress, capacity signals, the retry-hook stop).
- [ ] The Wave 2 APIs in `cpx/main`:
  - `CompletionProcessor` and the turn-state providers (2.1);
  - `LedgerStore` (2.2);
  - `PlanCompiler` (2.3);
  - `SlotPool` and `slotEnvFor` (2.4);
  - `IntegrationQueue`, `UnattendedPolicy` and `QaLoop` interfaces (1.4).
- [ ] Read:
  - the child runner in `D:\git\omr-cpx-main\src\compat\v2-client.ts` ≈96-242;
  - the binding API in `D:\git\omr-cpx-main\src\routing\roles\binding.ts`;
  - routing in `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1541-1616 (where `dispatchRouter.route` reads
    the route line and sets `args.agent` and `args.model`);
  - the legacy verification flag in `D:\git\omr-cpx-main\src\index.ts` ≈2154-2158;
  - step failures in `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈200-206 and ≈299-338.

  List the existing tests of `D:\git\omr-cpx-main\src\compat\v2-client.ts` and
  `D:\git\omr-cpx-main\src\routing\roles\binding.ts`.

**Order:** 3.1.1 → (3.1.2 ∥ 3.1.3 ∥ 3.1.4) → 3.1.5 → 3.1.6 → 3.1.7 → 3.1.8 → QA.

**Tasks**
- **3.1.1** [tier:heavy] CAP:6 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=repo d=none root=D:\git\omr-cpx-p31 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts and ADR decisions. *Amended by A-1.4-1:* the lease seam of the runtime follows addendum A3 of `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`, which is binding.
  The memo covers:
  - the runtime event model;
  - the ready-set algorithm and its priority order;
  - *Amended by A-0.1-2:* the capacity AIMD parameters and the retry-hook stop rule (plan children only; provider paused, or retried longer than
    `capacityCooldownMs`);
  - launcher A: context capture (router tool calls of the bound orchestrator) and staleness; the six D14 guards and their
    timeouts; binding at `onCreated` and the fail-closed first-context check; the attempt nonce; the executor-owned
    signal and the record-only progress; the dispatch-time work the executor does itself (decision row, timing start,
    in-flight registration);
  - liveness: who wakes the orchestrator and when, with debouncing and never twice for the same state;
  - the plan-task verification path: verified in the slot, integrated only after PASS;
  - learned edges from `NEED MORE: lease`;
  - the metric events.
- **3.1.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\schedule.ts` (`Scheduler`).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\schedule.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`,
  the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-3.1.md` (`## Implementation notes`).
  - 3.1.2.a `readySet(ledger, inFlight, leases, capacity)` returns tasks that pass every check:
    - every edge kind and gate state is satisfied, with dependencies `integrated` or `done`;
    - their predicted writes are not held (soft check);
    - per-provider capacity is free.

    Tasks are ordered by bottom level (p50 plus the maximum successor bottom level); ties go by plan order.
  - 3.1.2.b `addLearnedEdge(holderTask, blockedTask)`.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: for 100 seeded random DAGs with p = 4, makespan ≤ (2 − 1/p) × max(CP, W/p); the order matches an independent reference list scheduler written in the test within 1.0–1.15×
  [/acceptance]
- **3.1.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\capacity.ts` (`CapacityController`).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\capacity.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`, the C10 and C13
  rows of `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  - 3.1.3.a Each provider starts at `maxParallel` (valid range 1–8, ADR 0007 D13; *Amended by A-0.1-2*), with a per-provider heavy cap of 2
    ([tier:heavy] dispatches).
  - 3.1.3.b *Amended by A-0.1-2:* On the first retry signal of a step (`session.hook("retry")` or `session.retry.scheduled`, deduped per session and
    attempt) with `provider.rate-limit`/429 or `provider.internal`/529 (unknown type: by status), capacity halves (floor 1) and holds for `capacityCooldownMs`. After each
    success with no signal within the cooldown, it grows by 1, up to the cap.
  - 3.1.3.c *Amended by A-0.1-2:* A `session.step.failed` with `error.type = "provider.quota"` pauses the provider until the first ISO-8601 instant in
    `error.message` that lies in the future, or else for `capacityPauseMs` (headers are not surfaced, C10), and raises one
    inbox item through `UnattendedPolicy`.
  - 3.1.3.d Every change emits a `metric` event.
  - 3.1.3.e *Amended by A-0.1-2:* For plan-task children only, the `session.hook("retry")` handler sets `decision.retry = false` when
    the provider is paused or the step's first retry signal is older than `capacityCooldownMs`. The attempt ends
    `capacity` and the task returns to `ready` uncounted. Other sessions are observed only (decision unchanged).
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: halving, floor, cooldown, recovery and pause behave per the memo; providers are independent
  [/acceptance]
- **3.1.4** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\expand.ts`: the task prompt.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\expand.ts`. Reads: `D:\git\omr-cpx-main\src\executor\types.ts`,
  the design memo in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-3.1.md` (`## Implementation notes`).
  - 3.1.4.a *Amended by A-0.1-3 (QA-0.1-21):* The prompt sent to the child is assembled from these parts, in order:
    - `PLAN CONTEXT` (shared and identical for every task);
    - the launch header `[plan <planId>:<taskId>#<attempt>]`;
    - `TASK`: id, title, text, subtasks, `Writes:`/`Reads:` from the footprint, ENVIRONMENT for the slot, and the attempt
      context (conflict, findings or the human's answer);
    - for `kind: "qa"`, the `FINDINGS_FORMAT` instruction.

    The task's route line (with `root=<slot>` and `tier=X pin` when the task carries `[tier:X]`), `VERIFY:required` and
    the acceptance block (with `cwd: <slot>`) are consumed by the executor and are not sent verbatim. *Amended by
    A-1.4-1:* `formatLaunchPrompt` follows the addenda A1–A3 of
    `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`, which are binding.

    The prompt is byte-identical for the same task attempt. The expansion rewrites, in the route line, the acceptance
    block (`cwd:` and every `path=`), the task text and the subtasks, every absolute path whose prefix is a worktree
    root listed by `git worktree list --porcelain` or the task's declared `root=` to the same repo-relative path under
    the slot. Prefixes match on path-segment boundaries. An unmappable absolute path inside the repository fails the
    expansion, and so does a rewritten slot path longer than 260 characters unless `core.longpaths` is set in the slot.
    `TASK` carries a MUST NOT DO section: no AI attribution in code, comments or docs; never run git; write only the
    `Writes:` paths.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: the expansion is byte-stable per attempt; the reference grammar accepts S-style fallback ids; plan text never reaches the route line
  [/acceptance]
- **3.1.5** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\launch.ts` (`TaskLauncher`, launcher A) (*Amended by A-0.1-2*). *Amended by A-1.4-1:* the `bootID` and the context pin follow the addenda A1–A3 of `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`, which are binding.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\launch.ts`, `D:\git\omr-cpx-main\src\compat\v2-client.ts`,
  `D:\git\omr-cpx-main\src\routing\roles\binding.ts`. Reads: `D:\git\omr-cpx-main\src\executor\expand.ts`, the C14 row of
  `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  - 3.1.5.a Launcher A:
    - *Amended by A-0.1-2:* launch through the child runner with the context retained from the bound orchestrator's latest router tool call,
      an executor-owned `signal` and a record-only `progress`; `background: false`, awaited;
    - in `onCreated` (before the child is prompted), bind its role, grant and work root (= slot) through
      `D:\git\omr-cpx-main\src\routing\roles\binding.ts`; pass `agent` and `model` explicitly (C14: honoured);
    - select the model through the routing kernel from the task's route line;
    - write the decision row, `recordDispatchStart` and the in-flight registration itself (a retained launch fires no
      `subagent` hook: C14 `routerDecisionRows === 0`);
    - record the child id and the attempt nonce (fsynced, D8) before awaiting;
    - apply the six D14 guards: confirmation within 30 s; a stale context returns the task to `ready` uncounted and
      stops further launches with it; one refresh wake through `ctx.session.synthetic({…, resume: true})`; the context
      age as a `metric` event; an unrequested `session.execution.interrupted` is `lost`; no launch after a restart before
      the first router tool call in the adopted session;
    - completion is the runner's result, with the child's `session.execution.*` event as the fallback trigger (D2).
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: a launched child carries the bound role and root before its first tool call; no task is launched twice; existing v2-client and binding tests pass unchanged
  [/acceptance]
- **3.1.6** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\runtime.ts` (`ExecutorRuntime`).
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\runtime.ts`. Reads: `D:\git\omr-cpx-main\src\executor\schedule.ts`,
  `D:\git\omr-cpx-main\src\executor\capacity.ts`, `D:\git\omr-cpx-main\src\executor\launch.ts`, `D:\git\omr-cpx-main\src\executor\types.ts`.
  - 3.1.6.a **Launch.** For each task in the ready set:
    1. acquire a slot and reset it;
    2. acquire `until-integrated` leases for the predicted writes;
    3. move the ledger to `dispatched` (fsync);
    4. launch.
  - 3.1.6.b **Lifecycle.**
    - The task is `running` once launched or acknowledged.
    - On completion with changes: commit on `omr/<planId>/t/<taskId>` (attempt n), then `verifying` in the slot.
      - PASS → `verified`, then `IntegrationQueue.enqueue`.
      - FAIL → `failed` with the findings; back to `ready` when attempts remain, otherwise parked through
        `UnattendedPolicy`.
    - On completion without changes: `done`.
    - A commit failure → `failed`.
    - `NEED MORE: lease <path>` → a learned edge, then `ready`.
    - A QA-kind result goes to `QaLoop`.
  - 3.1.6.c **Integration results.**
    - `integrated` → release the leases and the slot, then re-evaluate the successors.
    - `conflict` → reset the slot; back to `ready` with the conflict context.
    - `failed` → handled as in 3.1.6.b.
  - 3.1.6.d **Liveness.** *Amended by A-0.1-2:* Launcher A launches immediately. An inbox item, a paused phase, plan completion, a `manual` or `preflight` task
    entering `ready`, and a stale launch context each wake the orchestrator once (D15), debounced by `wakeDebounceMs`.
  - 3.1.6.e **Metrics.** `metric` events record idle-with-ready intervals, wake-ups and launches. Turn-state provider
    "plan" (Appendix B).
  - 3.1.6.f `manual` and `preflight` tasks are never launched; they are listed in the turn-state ready section as
    `manual` (with their kind) and wait for `router_plan action=done`.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: the full lifecycle reaches integrated or done with a queue test double; leases persist until integration; metric events are emitted
  [/acceptance]
- **3.1.7** [tier:medium] VERIFY:required Wiring in `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` and
  `D:\git\omr-cpx-main\src\compat\background.ts` (one writer task).
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`, `D:\git\omr-cpx-main\src\compat\background.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\runtime.ts`, `D:\git\omr-cpx-main\src\executor\launch.ts`.
  - 3.1.7.a *Amended by A-0.1-2:* Retained-context capture on every router tool call of the bound orchestrator session. In the child's first
    context hook, a child whose prompt carries a plan task header and has no binding is refused every tool call (fail
    closed).
  - 3.1.7.b Plan-task leases use the `until-integrated` scope.
  - 3.1.7.c *Amended by A-0.1-2:* `session.retry.scheduled`, `session.step.failed` and the registered `session.hook("retry")` handler feed the
    capacity signals (ADR 0007 D13); the provider comes from the preceding `session.step.started` `model.providerID`.
  - 3.1.7.d Plan-task completions are routed to the runtime.
  - 3.1.7.e Root-session idle tracking.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: existing v2-hooks tests pass unchanged; the executor integration test passes for the selected launcher
  [/acceptance]
- **3.1.8** [tier:medium] VERIFY:required New tests, with typed test doubles for `IntegrationQueue`, `UnattendedPolicy`
  and `QaLoop`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-schedule.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-capacity.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-launch.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-expand.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-runtime.test.ts`,
  `D:\git\omr-cpx-main\test\integration\v2-executor-launch.test.ts`, plus
  `D:\git\omr-cpx-main\test\unit\v2-hooks.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\schedule.ts`, `D:\git\omr-cpx-main\src\executor\capacity.ts`,
  `D:\git\omr-cpx-main\src\executor\launch.ts`, `D:\git\omr-cpx-main\src\executor\expand.ts`,
  `D:\git\omr-cpx-main\src\executor\runtime.ts`, `D:\git\omr-cpx-main\src\compat\v2-hooks.ts`,
  `D:\git\omr-cpx-main\src\compat\background.ts`, `D:\git\omr-cpx-main\src\compat\v2-client.ts`,
  `D:\git\omr-cpx-main\src\routing\roles\binding.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/executor gate
  [/acceptance]
- **3.1.QA** [tier:heavy] Senior QA. CAP:none — reason: scheduling, capacity, launching, leases and host wiring interact.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p31 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p31\` at the fixed QA commit.
  Adversarial focus:
  - starvation and priority inversion;
  - capacity drift after failures, interrupts or restarts;
  - AIMD oscillation;
  - a task launched twice or while not ready;
  - a child running unbound (A) or with the wrong root;
  - an expired retained context that silently stalls the plan;
  - an expansion that is not byte-stable;
  - plan text injected into the route line;
  - *Amended by A-0.1-2:* lost or looping wake-ups (stale-context and D15 wakes);
  - a launch that uses the retained `signal` or `progress`;
  - a retry-hook stop applied to a non-plan session;
  - leases released before integration;
  - missing metric events.
- **3.1.FIX** [tier:medium] Fix every QA-3.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p31 tier=medium pin]
  Writes: the 3.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-3.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p31
  check: buildPasses
  check: testsPass
  criteria: every QA-3.1 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Scheduler:
  - shapes: diamond, chain, wide fan-out, two phases with a gate, `crossPhase: inferred`;
  - bottom-level order and plan-order ties;
  - a soft write overlap delays the second task;
  - a learned edge;
  - `done` satisfies its dependents;
  - the 100-seed bound and the reference comparison.
- Capacity: one 429, three in a row, recovery after the cooldown, a usage-limit pause with one inbox item, two providers; *Amended by A-0.1-2:* a retry-hook stop for a plan child (attempt `capacity`, uncounted); the orchestrator's and user
  sessions' retries untouched; a quota message without a future instant → `capacityPauseMs`; an unknown type by status.
- Expansion: byte-stable per attempt and different for the next attempt; the launch header `[plan <planId>:<taskId>#<attempt>]` (*amended by A-0.1-2:* no launcher B grammar); route line root and tier; the
  acceptance `cwd`; the QA findings instruction; the MUST NOT DO section of `TASK`; Phase 6.1 of the frozen copy of this
  plan, with the worktree list (`D:\git\omr-cpx-main`, declared root `D:\git\omr-cpx-p61`) injected through the
  `GitRunner` seam and `path.win32` used for drive paths on every OS, expands with no `D:\git\omr-cpx-p61` and no
  `D:\git\omr-cpx-main` path left; a prefix that ends inside a path segment is not rewritten; an unmappable absolute
  path, and a slot path over 260 characters without `core.longpaths`, fail the expansion.
- Launcher A:
  - a child bound before its first tool call;
  - a refreshed context;
  - an expired context, which wakes the orchestrator once;
  - a nonce recorded before the await;
  - no parent-history message;
  - *Amended by A-0.1-2:* a confirmation timeout; a stale context (no attempt counted, no further launch with it); one
    refresh wake per stale period; the age metric; an unrequested interrupt → `lost`; no launch after a restart before
    the first router tool call; the launch never uses the retained `signal` or `progress`; the decision row and timing
    start written by the executor; an unbound plan child refused in its first context hook.
- Manual tasks: *Amended by A-0.1-2:* a manual task becoming ready wakes the orchestrator once.
- Runtime: the full lifecycle with test doubles; FAIL with attempts left and exhausted; a conflict; a no-change task
  reaching `done`; a commit failure; leases held until integration.

**Acceptance criteria:**
- *Amended by A-0.1-2:* Ready work is launched immediately (launcher A); a stale context produces exactly one wake.
- Capacity adapts to errors.
- Plan tasks are verified before integration and keep their leases until integrated.
- The metrics are recorded.

**Definition of Done:**
- §0.9 met.
- Tests, typecheck and `npm run smoke:cpx` green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 3.2 — Integration queue, phase suite, bisection and landing [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p32` · **Depends on:** 2.1 (`preemptBackgroundVerification`), 2.2, 2.4

**Goal:** `IntegrationQueue` keeps the plan integration branch green at every commit:
- it integrates verified tasks by rebase, clean checks and fast-forward;
- it runs each phase's full suite and reverts the culprit of a failure, through a checked slot;
- it records integration metrics;
- it tags phases;
- it lands the plan only when that is safe.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - the affected-test planning in `D:\git\omr-cpx-main\src\verify\runner.ts` (≈37-82, ≈588-597, ≈847-852,
    ≈4530-4586);
  - `D:\git\omr-cpx-main\src\verify\batch.ts` ≈245-256;
  - `acquireSlot` in `D:\git\omr-cpx-main\src\verify\slot.ts` (≈1556);
  - foreground preemption in `D:\git\omr-cpx-main\src\verify\wiring.ts` ≈1403-1410.
- [ ] Decide which `D:\git\omr-cpx-main\src\verify\runner.ts` and `D:\git\omr-cpx-main\src\verify\slot.ts`
      exports this phase needs (exports only), and record them.

**Order:** 3.2.1 → 3.2.2 → 3.2.3 → (3.2.4 ∥ 3.2.5) → 3.2.6 → QA.

**Tasks**
- **3.2.1** [tier:heavy] CAP:6 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=multi d=none root=D:\git\omr-cpx-p32 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts.
  The memo states the invariants:
  - **I1:** the integration branch advances only by `merge --ff-only`, to a commit whose integration checks passed in a
    slot, reverts included;
  - **I2:** published integration history changes only by new commits;
  - **I3:** one integration at a time per repository;
  - **I4:** every step is journaled before and after;
  - **I5:** the owner's checkout is touched only by landing, fast-forward only, and only when clean.

  It also covers batching and bisection, the culprit revert and reopen, flaky handling, check selection, and the clean
  step before checks.
- **3.2.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`, `D:\git\omr-cpx-main\src\verify\runner.ts`
  (exports only), `D:\git\omr-cpx-main\src\verify\slot.ts` (exports only). Reads: `D:\git\omr-cpx-main\src\executor\git.ts`,
  `D:\git\omr-cpx-main\src\executor\slots\env.ts`, `D:\git\omr-cpx-main\src\verify\wiring.ts`.
  - 3.2.2.a Before checks, run `cleanForChecks`.
  - 3.2.2.b The checks:
    - typecheck, when the project defines one;
    - affected tests through the verification runner (Node and pytest);
    - the trusted `executor.integrationChecks`.
  - 3.2.2.c Checks run under the machine-wide verification slot with foreground priority, calling
    `preemptBackgroundVerification()` before `acquireSlot`.
  - 3.2.2.d The result is pass or fail, with the failing test ids.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: buildPasses
  check: testsPass
  criteria: stale ignored outputs never influence a check; existing runner and slot tests pass unchanged
  [/acceptance]
- **3.2.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\integrate\queue.ts` (`IntegrationQueue`).
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\integrate\queue.ts`. Reads: `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`, `D:\git\omr-cpx-main\src\executor\git.ts`.
  - 3.2.3.a `enqueue(task)`: in the task's slot, run `rebaseOnto(integrationHead, taskBase, taskBranch)`.
    - A conflict → `rebaseAbort`, then `conflict` with the paths and summaries of both sides.
    - A clean rebase → checks. Pass → `mergeFfOnly` in the integration worktree, then `integrated` with the commit range.
      Fail → `failed` with the output.
  - 3.2.3.b Batching: when 2 or more tasks wait, stack up to `batchMax` in one slot and check once.
    - Pass → fast-forward all of them.
    - Fail → bisect by halves; innocent tasks integrate.
  - 3.2.3.c Every step is journaled (I4), and so are the `integration-step` start and end events (Appendix D).
    `resume()` completes or rolls back the step in progress. *Amended by A-1.4-1:* `resume()` and the history journal follow addenda A1-3 and A2 of `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`, which are binding.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: buildPasses
  check: testsPass
  criteria: after every step of every test the integration branch is at a commit whose checks passed
  [/acceptance]
- **3.2.4** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\integrate\phase-suite.ts` and
  `D:\git\omr-cpx-main\src\executor\integrate\bisect.ts`.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\integrate\phase-suite.ts`,
  `D:\git\omr-cpx-main\src\executor\integrate\bisect.ts`. Reads: `D:\git\omr-cpx-main\src\executor\integrate\queue.ts`, `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`.
  - 3.2.4.a When every task of a phase is integrated, the full suite (`executor.phaseSuite`; default: the repository's
    `test` script, or pytest) runs in the `ci` slot after `cleanForChecks`. It runs at the integration commit, in the
    background, at low priority. Each `{script, args}` entry resolves like `router_run`: a `routing.run.commands` entry
    (whose argument patterns apply) or an allowlisted `package.json` script (which takes no arguments). The run's cwd is
    the `ci` slot.
  - 3.2.4.b Pass → the gate becomes `awaiting-qa`.
  - 3.2.4.c Fail → rerun the failing ids twice. Failing ids that also fail at the phase's base commit are recorded as
    pre-existing and not bisected.
    - Both reruns pass → flaky: an inbox note, and the gate proceeds.
    - Otherwise:
      1. Bisect over the phase's integrated task ranges, running only the failing ids, to find the culprit.
      2. Build the revert of the culprit range in a slot on top of the integration head, run the checks, then
         `mergeFfOnly` (I1).
      3. The culprit becomes `reverted`, then `ready` with the failure as context.
      4. Tasks integrated after the culprit are re-checked with the failing ids.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: buildPasses
  check: testsPass
  criteria: the integration branch never moves to an unchecked revert; culprits are identified exactly in the test scenarios
  [/acceptance]
- **3.2.5** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\integrate\land.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\integrate\land.ts`. Reads: `D:\git\omr-cpx-main\src\executor\git.ts`.
  - 3.2.5.a Phase tags `omr/<planId>/phase-<id>`.
  - 3.2.5.b In `ff-when-clean` mode, landing requires all three:
    - the base branch is checked out in the owner's checkout;
    - `git status --porcelain` is empty there;
    - the base head is an ancestor of the integration head.

    Then `merge --ff-only`. Otherwise, an inbox item with the exact commands.
  - 3.2.5.c In `manual` mode: a report only. Never force, never a non-fast-forward.
  - 3.2.5.d `repo.toplevel` = realpath of `git rev-parse --show-toplevel` in the directory of the session that compiled
    the plan; `baseBranch` = the branch checked out there. Landing touches only that worktree.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: buildPasses
  check: testsPass
  criteria: dirty, diverged or not-checked-out bases never change; the clean case fast-forwards
  [/acceptance]
- **3.2.6** [tier:medium] VERIFY:required New tests, with real git in temporary repositories.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-integrate-queue.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-integrate-bisect.test.ts`,
  `D:\git\omr-cpx-main\test\integration\executor-integrate-git.test.ts`,
  `D:\git\omr-cpx-main\test\fixtures\cpx\integrate\`.
  Reads: `D:\git\omr-cpx-main\src\executor\integrate\queue.ts`,
  `D:\git\omr-cpx-main\src\executor\integrate\checks.ts`, `D:\git\omr-cpx-main\src\executor\integrate\bisect.ts`,
  `D:\git\omr-cpx-main\src\executor\integrate\phase-suite.ts`, `D:\git\omr-cpx-main\src\executor\integrate\land.ts`,
  `D:\git\omr-cpx-main\src\verify\runner.ts`, `D:\git\omr-cpx-main\src\verify\slot.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/executor gate
  [/acceptance]
- **3.2.QA** [tier:heavy] Senior QA. CAP:none — reason: git invariants under failure, batching and restart need the whole
  integration package.
  [route class=review risk=high scope=multi needs=shell d=none root=D:\git\omr-cpx-p32 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p32\` at the fixed QA commit.
  Adversarial focus:
  - any sequence that leaves the branch red or rewritten;
  - a batch bisection that blames an innocent task or loops;
  - a revert that conflicts;
  - a restart between the rebase and the fast-forward;
  - landing over a dirty or diverged checkout;
  - flaky handling that hides a real failure;
  - a missed transitive breakage (`D:\git\omr-cpx-main\docs\VERIFICATION.md` ≈260), which the phase suite must
    catch;
  - stale outputs.
- **3.2.FIX** [tier:medium] Fix every QA-3.2 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p32 tier=medium pin]
  Writes: the 3.2-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-3.2.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p32
  check: buildPasses
  check: testsPass
  criteria: every QA-3.2 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Single tasks:
  - a clean rebase fast-forwards;
  - a conflict → `conflict`, with the paths;
  - failing checks → `failed`, and the branch is unchanged;
  - a stale `dist\` file that would make a check pass is cleaned first, and the check fails as it should.
- Batches of 4 with 0, 1 and 2 failing tasks: the correct culprits; innocent tasks integrate.
- A phase-suite failure with the culprit at position 3 of 6: the revert is checked in a slot, then fast-forwarded; the
  culprit is reopened; later tasks are re-checked.
- Flaky failure: an inbox note, and no revert.
- A `phaseSuite` entry naming a `routing.run.commands` entry (`test-files`) resolves and runs in the `ci` slot.
- A revert that conflicts: the culprit is parked, and the branch is unchanged.
- A restart injected after every journaled step: `resume()` reaches the same final state, with no double integration.
- Landing:
  - clean and an ancestor: fast-forward;
  - dirty, diverged, or not checked out: an inbox item, and nothing changes;
  - the owner checkout is a linked worktree while the main worktree has another branch and a dirty tree: the main
    worktree is never read or written.

**Acceptance criteria:**
- I1–I5 hold in every test.
- Suite failures are attributed and reverted automatically through checked commits.
- Landing is fast-forward only, and only when safe.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

---

### Wave 4 (4.1 ∥ 4.2)

#### Phase 4.1 — Operator surface: `router_plan`, `/plan`, executor config and user docs [tier:medium]

**Worktree:** `D:\git\omr-cpx-p41` · **Depends on:** 3.1, 3.2

**Goal:**
- `router_plan` and `/plan` exist as factories that take an `ExecutorRuntime`; Phase 5.1 registers them.
- Every executor config key is declared, validated, trusted per D18 and documented.
- User documentation starts in `D:\git\omr-cpx-main\docs\EXECUTOR.md`.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - the tool registration shape (`D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1309-1332;
    `D:\git\omr-cpx-main\src\index.ts` ≈1315, ≈1914-1919);
  - command handling (`D:\git\omr-cpx-main\src\index.ts` ≈2912-2916, ≈3092-3101;
    `D:\git\omr-cpx-main\src\compat\v2-hooks.ts` ≈1280-1307);
  - help text in `D:\git\omr-cpx-main\src\commands\output.ts` ≈245;
  - the trust layer (`D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md` ≈883-885).
- [ ] Appendix C and `ExecutorConfig` (1.4). List the existing tests of `D:\git\omr-cpx-main\src\commands\output.ts`
      and of config resolution (`D:\git\omr-cpx-main\src\router\config.ts`).

**Order:** 4.1.1 → 4.1.2 → 4.1.3 → 4.1.4 → 4.1.5 → 4.1.6 → QA.

**Tasks**
- **4.1.1** [tier:medium] VERIFY:required Executor config keys (Appendix C, Phase 4.1 rows).
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`, `D:\git\omr-cpx-main\test\unit\config-executor.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\types.ts`.
  - 4.1.1.a Keys are added to `ROUTING_DEFAULTS` and `resolveRouting`, validated for range, and resolved into
    `ExecutorConfig`.
  - 4.1.1.b D18 trust:
    - the trusted keys are dropped from the project-local override, with the existing one-line notice;
    - `slotsDir` is validated: absolute, on the repository's drive, not a drive root, neither inside nor an ancestor of
      the repository, and free of `*`;
    - `slotsDir` defaults to `null`, which means computed.
  - 4.1.1.c On v1, any `routing.executor.*` key logs one notice and is ignored.
  - 4.1.1.d The routing table rows have no `routing.` prefix, and object keys expand into leaf rows.
    `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md` gets a "Trust" subsection.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: buildPasses
  check: testsPass
  criteria: every key's default, range edges, invalid values and trust drop are tested; drift pins every row
  [/acceptance]
- **4.1.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\tool.ts`: the factory
  `createRouterPlanTool(runtime)`.
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\tool.ts`. Reads: `D:\git\omr-cpx-main\src\executor\runtime.ts`, `D:\git\omr-cpx-main\src\executor\types.ts`.
  - 4.1.2.a `action` values:
    - `compile` (`path`, optional `phases: string[]`, optional `doneBefore: string`): returns the summary, or the residue
      dispatch prompt;
    - `residue`: takes the architect's JSON text;
    - `approve`;
    - `status`: renders the full board, including the Appendix D metrics;
    - `ready`;
    - `add-tasks` (may add dependencies to a `ready` task, which returns it to `pending`);
    - `answer` (inbox id, text);
    - `done` (task id; `manual` and `preflight` tasks only);
    - `pause`, `resume`, `abort`, `land`;
    - `adopt` (planId);
    - `gc` (slot GC for completed or aborted plans);
    - `export` (planId: the ledger snapshot plus journal as JSON text);
    - `purge` (planId; completed or aborted plans only: slot GC, `deleteRefs` for `omr/<planId>/`, `LedgerStore.remove`).
  - 4.1.2.b Strict schema. An action on a plan owned by another live session is refused. Outputs are compact and
    actionable.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: buildPasses
  check: testsPass
  criteria: every action validates input and ownership; compile → residue → approve round-trips on a fixture plan
  [/acceptance]
- **4.1.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\command.ts` and help text.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\command.ts`, `D:\git\omr-cpx-main\src\commands\output.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-command.test.ts`. Reads: `D:\git\omr-cpx-main\src\executor\tool.ts`.
  - 4.1.3.a The factory `createPlanCommand(runtime)` handles:
    - `/plan run <path> [--phases <ids>] [--done-before <id>]`, `/plan status [planId]`, `/plan inbox`;
    - `/plan answer <id> <text>`;
    - `/plan pause|resume|abort <planId>`, `/plan land <planId>`, `/plan adopt <planId>`.

    Each becomes orchestrator instructions through the existing command path. Quoted Windows paths may contain spaces.
  - 4.1.3.b The help text appears only on v2. The v1 help output stays byte-identical.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: buildPasses
  check: testsPass
  criteria: every subcommand parses; unknown subcommands print help; v1 help unchanged
  [/acceptance]
- **4.1.4** [tier:medium] VERIFY:required User docs.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\EXECUTOR.md` (new), `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`. Reads: `D:\git\omr-cpx-main\src\executor\tool.ts`,
  `D:\git\omr-cpx-main\src\executor\command.ts`, `D:\git\omr-cpx-main\src\router\config.ts`,
  `D:\git\omr-cpx-main\src\commands\output.ts`, `D:\git\omr-cpx-main\src\router\protocol.ts`.
  - 4.1.4.a `D:\git\omr-cpx-main\docs\EXECUTOR.md` covers: concepts; `/plan` and `router_plan`; config; trust.
  - 4.1.4.b `D:\git\omr-cpx-main\docs\OPENCODE_V2.md` gets a "Plan executor" section that links to it.
  - 4.1.4.c Drift pins for the commands and actions tables.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: testsPass
  criteria: every command, action and key in code appears in D:\git\omr-cpx-main\docs\EXECUTOR.md; drift fails when one is removed
  [/acceptance]
- **4.1.5** [tier:medium] VERIFY:required New tests.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-tool.test.ts` plus additions to
  `D:\git\omr-cpx-main\test\unit\executor-command.test.ts` and
  `D:\git\omr-cpx-main\test\unit\config-executor.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\tool.ts`, `D:\git\omr-cpx-main\src\executor\command.ts`,
  `D:\git\omr-cpx-main\src\router\config.ts`, `D:\git\omr-cpx-main\src\commands\output.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/executor and src/router gates
  [/acceptance]
- **4.1.6** [tier:medium] VERIFY:required Executor instructions as a turn-state provider section (v2 only, rendered only
  while a plan is running in the session), never system-prompt text.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\instructions.ts` (new),
  `D:\git\omr-cpx-main\test\unit\executor-instructions.test.ts` (new). Reads: `D:\git\omr-cpx-main\src\executor\tool.ts`,
  `D:\git\omr-cpx-main\src\executor\expand.ts`, `D:\git\omr-cpx-main\src\compat\turn-state.ts`.
  - 4.1.6.a The text:
    - *Amended by A-0.1-2:* run `manual` tasks listed in the router state and report them with `router_plan action=done`;
      never edit a slot or the plan file; never report the plan done while `router_plan action=status` says running;
      answer inbox items only with the human's answer or with text this plan already states.
  - 4.1.6.b The module exports a turn-state provider (the `registerTurnStateProvider` shape of 1.2); its registration is a
    handoff to 5.1.2. The system prompt, the v1 prompt and the existing snapshots are unchanged.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: buildPasses
  check: testsPass
  criteria: the text renders only while a plan runs in the session, inside the turn-state tail; the system prompt is unchanged
  [/acceptance]
- **4.1.QA** [tier:heavy] Senior QA. CAP:none — reason: config trust, tool, commands and docs must be read together.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p41 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p41\` at the fixed QA commit.
  Adversarial focus:
  - an approval bypass;
  - acting on a plan owned by another session;
  - malformed residue JSON being accepted;
  - a trusted key settable from a repository;
  - a `slotsDir` that escapes validation (drive root, UNC, a junction into the repository);
  - help or stats changes on v1;
  - docs that do not match the code.
- **4.1.FIX** [tier:medium] Fix every QA-4.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p41 tier=medium pin]
  Writes: the 4.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p41
  check: buildPasses
  check: testsPass
  criteria: every QA-4.1 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Every action with valid input, missing fields, wrong types, an unknown plan, and a plan owned by another session.
- `approve: auto` skips the stop.
- `add-tasks` with a cycle or an out-of-repository path is rejected.
- Every config key: default, range edges, invalid values, and the trust drop from the project-local override.
- `slotsDir` validation: a drive root, a UNC path, a path inside the repository, an ancestor, `*`.
- v1: no tool and no help change; one notice per configured key.
- `/plan run` with `--phases` and `--done-before`; `done` on a non-manual task is refused.
- `compile` with `phases`/`doneBefore` produces the same draft as `/plan run --phases --done-before`.
- `gc` removes only the slots of completed or aborted plans.
- The executor instructions render only while a plan runs, inside the turn-state tail; the system prompt is unchanged.
- `add-tasks` that adds an unsatisfied dependency to a `ready` task returns it to `pending`.
- `export` returns the snapshot plus journal; `purge` is refused for a running plan and removes slots, refs and the
  ledger of a completed or aborted one.

**Acceptance criteria:**
- The surface factories, config, trust rules and user docs are complete and v2-only.

**Definition of Done:**
- §0.9 met.
- Tests, typecheck and docs-drift green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 4.2 — Unattended operation, QA loop and restart recovery [tier:heavy] design + [tier:medium] implementation

**Worktree:** `D:\git\omr-cpx-p42` · **Depends on:** 3.1, 3.2

**Goal:** a plan runs to the end without the human, except for genuine questions and systemic failures:
- QA steps loop automatically into fixes and re-reviews;
- restarts, crashes and new orchestrator sessions never lose or duplicate work.

**Pre-flight (in addition to §0.9)**
- [ ] ADR 0007 decisions C7, C12, C13 and C14.
- [ ] Read the runtime (3.1) and `resume()` of the queue (3.2) in `cpx/main`, and `FINDINGS_FORMAT` (1.4).

**Order:** 4.2.1 → (4.2.2 ∥ 4.2.3 ∥ 4.2.4) → 4.2.5 → 4.2.6 → QA.

**Tasks**
- **4.2.1** [tier:heavy] CAP:6 Design memo (returned; recorded by the orchestrator).
  [route class=design risk=high scope=repo d=none root=D:\git\omr-cpx-p42 tier=heavy pin]
  Writes: none. Reads (pasted): the pre-flight excerpts and ADR decisions.
  The memo covers:
  - inbox and parking semantics;
  - detecting `ESCALATE: human`, and an ambiguity stated in a `NEED MORE:`;
  - blocking propagation;
  - the circuit breaker math;
  - the QA loop: grouping findings into fix tasks by file so their write sets stay disjoint; re-review; the bounded-round policy (fix tasks for every finding in rounds 1–2, only blocking/critical/major from round 3, `executor.qaMaxRounds` default 3, minor and nit left after round 2 deferred); the outcome when the cap is reached;
  - the reconciliation matrix (ledger state × host evidence → action), including adopting a live child that carries this
    task's nonce;
  - lock takeover and `adopt` rules;
  - the duplicate-prevention invariants.
- **4.2.2** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\unattended.ts` (`UnattendedPolicy`).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\unattended.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.2.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\executor\types.ts`.
  - *Amended by A-1.4-1:* the `qa-cap` inbox item and its answers (`accept`, `fix`) follow addendum A1 (QA8, QA9) of `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md`, which is binding.
  - 4.2.2.a Inbox items: `{id, kind, severity, taskId, text, options}`.
  - 4.2.2.b Parking:
    - a task is parked on `ESCALATE: human`, on an ambiguity, or when its attempts are exhausted;
    - its dependents become `blocked`;
    - independent work continues;
    - `answer` returns the task to `ready` with the answer in its attempt context.
  - 4.2.2.c A circuit breaker per phase:
    - it trips at `failureRatio` 0.4 over at least `minAttempts` 5, or at `consecutiveFailures` 3;
    - flaky failures are excluded;
    - on a trip it pauses the phase, raises one critical inbox item, and wakes the orchestrator once to present the inbox
      to the human. This is the only unattended stop.
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: buildPasses
  check: testsPass
  criteria: parking blocks exactly the dependents; the breaker trips only per the thresholds
  [/acceptance]
- **4.2.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\qa-loop.ts` (`QaLoop`).
  [route class=implement risk=medium scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\qa-loop.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.2.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\executor\types.ts`.
  - 4.2.3.a A QA task's result is parsed against `FINDINGS_FORMAT`. If it does not parse, the QA attempt is retried once
    with the error, then an inbox item is raised.
  - 4.2.3.b Zero findings → the gate becomes `passed`.
  - 4.2.3.c Otherwise, under the owner's bounded-round policy:
    - fix tasks are created for every finding in rounds 1–2, and only for `blocking`, `critical` and `major` findings from
      round 3 on (`kind: "fix"`, [tier:medium], grouped by file, writes = the cited files); they copy the
      phase's `X.Y.FIX` route line and acceptance block when present;
    - a re-review task depends on all of them; it copies the QA task's route line (`class=review`, `d=none`,
      `tier=heavy pin`), so QA stays [tier:heavy];
    - the round counter increases.
  - 4.2.3.d After `executor.qaMaxRounds` rounds (default 3), an open `blocking`, `critical` or `major` finding raises a critical inbox item. `minor` and `nit` findings left after round 2 are recorded as deferred in the ledger, not fixed; then the gate passes.
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: buildPasses
  check: testsPass
  criteria: fix tasks of one round have disjoint write sets; the loop terminates within the cap
  [/acceptance]
- **4.2.4** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\recovery.ts` (`RecoveryService`).
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\recovery.ts`. Reads: the design memo in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.2.md` (`## Implementation notes`),
  `D:\git\omr-cpx-main\src\executor\ledger.ts`,
  `D:\git\omr-cpx-main\src\executor\integrate\queue.ts`.
  - 4.2.4.a On start, open every `running` ledger of this repository and reconcile each task. Recovery adopts only
    ledgers whose `repo.toplevel` is the plugin session's toplevel:
    - `ready` with a live child that carries its nonce → adopt it;
    - `dispatched` or `running` whose child finished (C7) → process the result;
    - a child still alive → adopt it;
    - *Amended by A-0.1-2:* a lost child (C12: in flight at the restart) → reset the slot, then `ready` with a new attempt of outcome `lost`,
      which does not count toward `maxAttempts`;
    - `completed` or `verifying` → run verification again;
    - `verified` → re-enqueue;
    - `integrating` → `IntegrationQueue.resume()`.
  - 4.2.4.b Slots are validated by marker; `until-integrated` leases are rebuilt from the ledger.
  - 4.2.4.c `adopt(planId, sessionID)` takes over a stale lock and rebinds the orchestrator session.
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: buildPasses
  check: testsPass
  criteria: every cell of the reconciliation matrix has a test; a restart never launches or integrates a task twice
  [/acceptance]
- **4.2.5** [tier:medium] VERIFY:required Integrate into the runtime, and re-feed completions after a restart (one writer
  task).
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\runtime.ts`, `D:\git\omr-cpx-main\src\compat\background.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\unattended.ts`, `D:\git\omr-cpx-main\src\executor\qa-loop.ts`,
  `D:\git\omr-cpx-main\src\executor\recovery.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: buildPasses
  check: testsPass
  criteria: the runtime uses the real policy, QA loop and recovery through their interfaces; existing 3.1 tests pass unchanged
  [/acceptance]
- **4.2.6** [tier:medium] VERIFY:required New tests, including a real process restart.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\unit\executor-unattended.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-qa-loop.test.ts`,
  `D:\git\omr-cpx-main\test\unit\executor-recovery.test.ts`,
  `D:\git\omr-cpx-main\test\integration\executor-recovery-restart.test.ts`.
  Reads: `D:\git\omr-cpx-main\src\executor\unattended.ts`, `D:\git\omr-cpx-main\src\executor\qa-loop.ts`,
  `D:\git\omr-cpx-main\src\executor\recovery.ts`, `D:\git\omr-cpx-main\src\executor\runtime.ts`,
  `D:\git\omr-cpx-main\src\compat\background.ts`.
  - 4.2.6.a Handoff to 5.1: the exact text of the `D:\git\omr-cpx-main\docs\EXECUTOR.md` sections "Unattended
    operation", "QA loop" and "Recovery".
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the src/executor gate
  [/acceptance]
- **4.2.QA** [tier:heavy] Senior QA. CAP:none — reason: recovery correctness spans the ledger, the runtime, the queue and
  host evidence.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p42 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p42\` at the fixed QA commit.
  Adversarial focus:
  - a restart cell that launches twice, integrates twice or strands a task;
  - two sessions driving one plan;
  - a parked task whose dependents still run;
  - a breaker that never trips, or trips on one flaky test;
  - an answer applied to the wrong attempt;
  - a QA loop that never ends, or whose fix tasks overlap;
  - recovery touching another repository's ledgers.
- **4.2.FIX** [tier:medium] Fix every QA-4.2 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p42 tier=medium pin]
  Writes: the 4.2-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.2.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p42
  check: buildPasses
  check: testsPass
  criteria: every QA-4.2 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Parking:
  - a task is parked on `ESCALATE: human`;
  - its dependents become `blocked` while its siblings continue;
  - an answer resumes the task, with the answer in its attempt context.
- Circuit breaker:
  - 2 of 5 failing: no trip;
  - 2 of 4 failing, below `minAttempts`: no trip;
  - 3 consecutive failures: trip;
  - a flaky failure: no trip.
- QA loop:
  - 0 findings;
  - 3 findings on 2 files, giving 2 fix tasks with disjoint writes, then a re-review;
  - round 3 creates fix tasks only for blocking/critical/major findings; minor and nit findings after round 2 are recorded as deferred; an open blocking/critical/major after `qaMaxRounds` raises the critical inbox item;
  - an unparsable result.
- Reconciliation: one test per matrix cell, including a restart during each of these:
  - the launch;
  - the rebase;
  - the fast-forward;
  - the phase suite;
  - provisioning.
- Real restart:
  1. Kill the plugin host mid-plan, with two tasks in flight and one integrating.
  2. Restart it.
  3. Expect the same final ledger and integration branch as an uninterrupted run.
- `adopt`: when the old session is gone, the plan is taken over; when it is alive, adoption is refused with the holder's
  info.

**Acceptance criteria:**
- Unattended runs stop only for real questions or systemic failure.
- QA loops terminate.
- Any restart converges to the same result as an uninterrupted run.

**Definition of Done:**
- §0.9 met.
- Tests and typecheck green; coverage met.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

---

### Wave 5

#### Phase 5.1 — Assembly and registration [tier:medium]

**Worktree:** `D:\git\omr-cpx-p51` · **Depends on:** 4.1, 4.2

**Goal:** the executor is assembled from all of its components and registered only on v2. It starts recovery when the
plugin starts and disposes cleanly. Role agents may work in slots. The user docs cover unattended operation and
recovery.

**Pre-flight (in addition to §0.9)**
- [ ] Read:
  - plugin assembly in `D:\git\omr-cpx-main\src\v2.ts` ≈32-62 (v2 takes its tools and commands from the legacy
    hooks, ≈55-56);
  - the tool and command maps in `D:\git\omr-cpx-main\src\index.ts` (≈1315, ≈1914-1919, ≈2912-2916,
    ≈3092-3101);
  - `D:\git\omr-cpx-main\src\router\role-agents.ts` ≈148, ≈194, ≈209.
- [ ] Read the handoffs from 2.4 (role-agent permission) and 4.2 (`D:\git\omr-cpx-main\docs\EXECUTOR.md` text).
- [ ] List the existing tests of `D:\git\omr-cpx-main\src\v2.ts`,
      `D:\git\omr-cpx-main\src\router\role-agents.ts`, and the `D:\git\omr-cpx-main\src\index.ts`
      registration.

**Order:** 5.1.1 → 5.1.2 → (5.1.3 ∥ 5.1.4) → 5.1.5 → QA.

**Tasks**
- **5.1.1** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\src\executor\create.ts`.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\executor\create.ts`. Reads: every `D:\git\omr-cpx-main\src\executor\`
  module, `D:\git\omr-cpx-main\src\executor\paths.ts`.
  - 5.1.1.a `createExecutor(ctx, cfg)` assembles the ledger store, compiler, slot pool, integration queue, scheduler,
    capacity, launcher, runtime, unattended policy, QA loop and recovery. The executor home comes from
    `D:\git\omr-cpx-main\src\executor\paths.ts`.
  - 5.1.1.b It starts `RecoveryService` on plugin start and disposes every timer, lock and child on plugin dispose. The
    runtime calls `SlotPool.gc()` when a plan reaches `completed` or `aborted`.
  - 5.1.1.c It returns `undefined` on v1.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: buildPasses
  check: testsPass
  criteria: assembly with real components starts, recovers a seeded running ledger, and disposes without leaked handles
  [/acceptance]
- **5.1.2** [tier:medium] VERIFY:required Registration, v2 only.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\v2.ts`, `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\test\golden\`
  (new v1-map snapshot). Reads: `D:\git\omr-cpx-main\src\executor\create.ts`, `D:\git\omr-cpx-main\src\executor\tool.ts`,
  `D:\git\omr-cpx-main\src\executor\command.ts`, `D:\git\omr-cpx-main\src\executor\instructions.ts`.
  - 5.1.2.a `router_plan` and `/plan` are registered only when `ctx.routerHost === "v2"`; on v2 it also registers the
    executor instructions provider (4.1.6 handoff).
  - 5.1.2.b On v1:
    - the tool and command maps are byte-identical;
    - the first configured executor key or `/plan` use logs one notice.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: buildPasses
  check: testsPass
  criteria: v1 tool and command maps unchanged (golden comparison); on v2 the tool and command exist
  [/acceptance]
- **5.1.3** [tier:medium] VERIFY:required Role-agent permission for the slots directory. This is the handoff from 2.4.
  [route class=implement risk=high scope=single needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\src\router\role-agents.ts`. Reads: `D:\git\omr-cpx-main\src\router\config.ts`.
  - 5.1.3.a At agent registration, the resolved and trusted `slotsDir` (D18) is allowed as an `external_directory` root,
    so role agents bound to a slot root pass the work-root checks.
  - 5.1.3.b Nothing else is widened.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: buildPasses
  check: testsPass
  criteria: a role bound to a slot can read, write and run there; a path outside slotsDir is still refused; existing role-agent tests pass unchanged
  [/acceptance]
- **5.1.4** [tier:medium] VERIFY:required Docs.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\EXECUTOR.md`, `D:\git\omr-cpx-main\docs\ROLES.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`. Reads: the 4.2 handoff text in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-4.2.md` (`## Handoffs`).
  - 5.1.4.a `D:\git\omr-cpx-main\docs\EXECUTOR.md`: insert the 4.2 sections, and add "Assembly and lifecycle".
  - 5.1.4.b `D:\git\omr-cpx-main\docs\ROLES.md` "Work roots": the slots directory, and that `routing.workRoots`
    is not needed for it.
  - 5.1.4.c Handoff to 6.1: the README tool-list entry for `router_plan` and `/plan` (exact text recorded in the
    report). The CHANGELOG bullet is added by the orchestrator at the 5.1 merge.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: testsPass
  criteria: docs-drift green; the inserted sections match the handoff text and the code
  [/acceptance]
- **5.1.5** [tier:medium] VERIFY:required New tests in `D:\git\omr-cpx-main\test\integration\v2-executor-assembly.test.ts`,
  plus updates to the existing tests of `D:\git\omr-cpx-main\src\v2.ts` and
  `D:\git\omr-cpx-main\src\router\role-agents.ts`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\integration\v2-executor-assembly.test.ts` and the existing tests of
  `D:\git\omr-cpx-main\src\v2.ts` and `D:\git\omr-cpx-main\src\router\role-agents.ts` (listed by path
  in the pre-flight).
  Reads: `D:\git\omr-cpx-main\src\executor\create.ts`, `D:\git\omr-cpx-main\src\v2.ts`,
  `D:\git\omr-cpx-main\src\index.ts`, `D:\git\omr-cpx-main\src\router\role-agents.ts`.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: testsPass
  check: buildPasses
  criteria: every edge case listed under New tests exists; coverage meets the gates
  [/acceptance]
- **5.1.QA** [tier:heavy] Senior QA. CAP:none — reason: assembly, registration, permissions and lifecycle cut across every
  module.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p51 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p51\` at the fixed QA commit.
  Adversarial focus:
  - any v1 surface change;
  - a permission wider than the slots directory;
  - recovery running twice, or for another repository;
  - leaks on dispose;
  - registration order bugs;
  - docs that contradict the code.
- **5.1.FIX** [tier:medium] Fix every QA-5.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p51 tier=medium pin]
  Writes: the 5.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-5.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p51
  check: buildPasses
  check: testsPass
  criteria: every QA-5.1 finding listed in the dispatch is fixed with a regression test
  [/acceptance]

**New tests**
- Assembly on v2: the tool and command exist, and recovery runs once.
- v1: maps unchanged, and one notice.
- Dispose: no timers, locks or child processes remain.
- A plan reaching `completed` or `aborted` triggers `SlotPool.gc()` once.
- A role bound to a slot is allowed; a sibling directory outside `slotsDir` is refused.
- An untrusted `slotsDir` from a project-local override is ignored.

**Acceptance criteria:**
- The executor is fully assembled on v2 and absent on v1.
- Recovery starts with the plugin.
- Slot permissions are exactly as wide as `slotsDir`.

**Definition of Done:**
- §0.9 met.
- Tests, typecheck and docs-drift green.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Dogfood switch DF-2 — the executor runs the end of this plan [tier:fast] switch + [tier:heavy] QA

**Worktrees:** `D:\git\omr-cpx-dogfood-df2` (new) at tag `cpx/df2`; `D:\git\omr-cpx-scratch` (DF2.1.b to DF2.4); the
executor's slots for this plan, under the trusted `slotsDir` `D:\git\.omr-cpx-slots` · **Depends on:** 5.1

**Goal:**
- the full router, executor included, runs the rest of the plan;
- pending verifications are proven to survive a real restart;
- Phase 6.1 of this plan is executed by the executor on the real repository: compile, launch into slots, verify,
  integrate, phase suite, QA loop, landing into `cpx/main`.

**Pre-flight (in addition to §0.12-3 step 1)**
- [ ] 5.1 is merged. `cpx/main` is green on typecheck, the scoped tests of every phase merged since the previous switch, `npm run smoke:cpx`, `npm run smoke:cpx:provision`
      and `npm run smoke:v2` (orchestrator shell). No separate full-suite run: the executor's phase suite records failures
      that also fail at the phase base as pre-existing (3.2.4.c); the trusted `routing.executor.phaseSuite` runs with the
      §0.6-9 worker count.
- [ ] Every DF-1 fault is closed, or recorded as not hindering execution.
- [ ] `D:\git\omr-cpx-main\.opencode\opencode-model-router.overrides.jsonc` (project layer) has
      `routing.executor.capacityCooldownMs: 600000` (§0.6-11). The global override gets, additively, the trusted
      `routing.executor.slotsDir` = `D:/git/.omr-cpx-slots` and
      `routing.executor.phaseSuite: [{"script": "test-files", "args": ["--maxWorkers=<n>"]}]`. *QA-0.P-15:* the global
      override reaches every running router at its next prompt, so before writing these keys the orchestrator tells the
      owner (a build without them, such as the other implementation's, logs "ignoring unknown routing key: executor")
      and records it in the handover.
- [ ] A hand count of this plan (tasks per phase including pre-flight items, and the edges of its "Depends on" and
      "Order:" lines) is recorded in the handover, for DF2.4.c.
- [ ] Phase 6.1's pre-flight (§0.9 and its own items) ran on `cpx/main`, and
      `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md` is committed with `## Pre-flight` before
      approve. Its findings and fixes are written from `router_plan action=status` after the landing.
- [ ] The freeze rule (before DF2.5) is recorded in the handover.
- [ ] `D:\git\omr-cpx-main` is clean (`git status --porcelain` empty), so the executor can land by fast-forward.

**Tasks**
- **DF2.1** Orchestrator: tag `cpx/df2` and push it. Drain in-flight dispatches. Commit the handover with the next action
  "DF-2 self-check".
  - DF2.1.b After the 5.1 DoD, in `D:\git\omr-cpx-scratch` (created with
    `git -C D:\git\omr-cpx-main worktree add --detach D:\git\omr-cpx-scratch cpx/main` and `npm ci`, removed after
    DF2.4), dispatch one runner with `VERIFY:deferred` and an acceptance block with `check: testsPass`; record its
    handle; do not verify it; then drain and restart. The restart follows right after this dispatch, and
    `verify.pendingTtlMs` has been 24 h since DF1.2, so the handle does not expire before DF2.4.a.
    [route class=other risk=low scope=single needs=shell d=deterministic root=D:\git\omr-cpx-scratch tier=fast pin]
    [acceptance]
    cwd: D:\git\omr-cpx-scratch
    check: testsPass
    criteria: the scoped tests of D:\git\omr-cpx-scratch\test\unit\turn-state.test.ts pass
    [/acceptance]
- **DF2.2** Orchestrator: create `D:\git\omr-cpx-dogfood-df2` at `cpx/df2` (§0.12-3 step 3), run `npm ci`, and apply
  the plugin-entry change in the recorded scope. Record the change and the exact revert command in the handover. Check
  that the `verify.pendingTtlMs: 86400000` override set in DF1.2 is still in place for this restart; DF2.4.a removes it.
- **DF2.3** Planned human action: restart OpenCode in the recorded way, continue the same session in
  `D:\git\omr-cpx-main`, and type `continue`.
- **DF2.4** Self-check probes.
  Writes: none. Reads: `D:\git\omr-cpx-scratch\`, `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`
  (QA-0.P-16), `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`, the handover.
  - DF2.4.0 **Build loaded.** *Amended by QA-0.P-16:* pass when the run-scoped self-check of 0.P.6 (marker run id,
    `loading plugin` set equal to the regenerated config, router entrypoint
    `file:///D:/git/omr-cpx-dogfood-df2/server.ts`, versioned server executable) passes in
    `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`, `git -C <root> rev-parse HEAD` equals
    `git -C D:\git\omr-cpx-main rev-parse cpx/df2^{commit}`, and exactly one `router_verify` tool is registered. The
    2.1.5.f `[router] plugin root <realpath>` line is supporting evidence only when its sink tags it with that run.
  - DF2.4.a **Pending survives a restart.** `router_verify` on the DF2.1.b handle returns a verdict, not "unknown
    handle". Then remove the `verify.pendingTtlMs` override set in DF1.2.
  - DF2.4.b **Executor registered.** `router_plan` and `/plan` exist; recovery ran once at startup, with no ledgers yet.
  - DF2.4.c **Compile this plan.** Run `router_plan action=compile` on
    `D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md`. Pass:
    - task counts and edges equal the hand count recorded in the DF-2 pre-flight;
    - zero cycles;
    - footprints equal the `Writes:` lines;
    - orchestrator-run steps (no route line, "Orchestrator:") are compiled as `manual`.

    Then abort the draft (`router_plan action=abort`) and remove `D:\git\omr-cpx-scratch`
    (`git -C D:\git\omr-cpx-main worktree remove D:\git\omr-cpx-scratch`).

**Freeze.** From DF2.5 until the landing, `cpx/main` is frozen: no commit, merge, `origin/master` sync or pdf merge in
`D:\git\omr-cpx-main`. Handover updates go to `$env:LOCALAPPDATA\omr-cpx\handover-df2.md` and are committed right after
the landing. Any plan-scoped OpenCode or router config lives under `D:\git\omr-cpx-main\.opencode\` (gitignored).
Immediately before approve, `git -C D:\git\omr-cpx-main status --porcelain` is empty. During the freeze, `cpx/df2.<k>` is
tagged on the `cpx/pdf2-<k>` head after its QA, and the pdf branch is merged into `cpx/main` right after the landing.
Deviations and the 6.1.4 metrics go to `$env:LOCALAPPDATA\omr-cpx\handover-df2.md` and are copied into
`D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` and
`D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md` after the landing.

- **DF2.5** Run Phase 6.1 through the executor:
  1. Call
     `router_plan action=compile path=D:\git\omr-cpx-main\docs\plans\critical-path-execution-plan.md phases=["6.1"] doneBefore="6.1"`,
     check that the summary lists only 6.1's tasks (pre-flight items as `preflight`, 6.1.4 as `manual`), then
     `router_plan action=approve`. The executor then:
     - provisions its slots;
     - launches 6.1's tasks by priority, under the capacity rule of §0.6-11;
     - verifies and integrates them into `omr/<planId>/integration`;
     - runs the phase suite;
     - runs the QA loop with heavy re-reviews;
     - lands into `cpx/main` by fast-forward.
  2. The orchestrator reports 6.1's pre-flight manual tasks done (already run in the DF-2 pre-flight), then runs 6.1.4
     when the ready set lists it, and reports it with `router_plan action=done`. It answers inbox items itself when the answer is in this plan; otherwise they are §0.1
     stops.
- **DF2.6** Orchestrator: record the executor's Appendix D metrics for Phase 6.1 and every deviation (`DF-2-<k>`) in
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`, and commit.
- **DF2.QA** [tier:heavy] Senior QA of the switch and of the executor run. CAP:none — reason: needs the ledger, the
  integration history, the metrics and the probe evidence together.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-main tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-main\` at the fixed QA commit. Pasted into the dispatch, never read by path: the
  ledger evidence (the output of `router_plan action=export` for the Phase 6.1 plan) and the DF-2 handover
  (`$env:LOCALAPPDATA\omr-cpx\handover-df2.md`).
  Adversarial focus:
  - a probe that passed on the wrong build;
  - an integration commit on `cpx/main` whose checks did not pass;
  - a task launched twice;
  - a lease violation in the ledger;
  - an idle-with-ready interval over 10 s that was not explained;
  - a QA loop that ended without zero findings;
  - a landing that was not a fast-forward;
  - any effect on the main checkout or on `master`.
- **DF2.FIX** Every finding is fixed:
  - a code fault in a dogfood fix phase `pdf2-<k>` (§0.12-4), with a regression test. During the freeze, `cpx/df2.<k>`
    is tagged on the `cpx/pdf2-<k>` head after its QA, and the branch is merged into `cpx/main` right after the landing;
  - a run fault by re-running the affected 6.1 tasks through the executor after the fix is switched in
    (`cpx/df2.<k>`).

  Heavy re-reviews per §0.7.

**Fallback:** if a DF-2 fault blocks the executor and has no workaround:
1. Roll back to the last build that passed its self-check (`cpx/df1` or its latest `cpx/df1.<k>`, as recorded in the
   handover; QA-0.P-18) (§0.12-6).
2. Run Phase 6.1 as a normal phase in `D:\git\omr-cpx-p61`.
3. Record G13 as not met, with the fault, and report it to the owner in the 6.2.4 PR body. It is not a 6.2 finding.

**New tests:** probes DF2.4.0–c and the executor run of Phase 6.1 on the real host; a regression test for every DF-2
fault.

**Acceptance criteria:**
- DF2.4.0–c pass.
- Phase 6.1 lands in `cpx/main` through the executor, with every invariant I1–I5 visible in the ledger and the git
  history.
- `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` records the metrics.

**Definition of Done:**
- The acceptance criteria hold.
- DF2.QA has zero open findings.
- Every DF-2 fault is fixed and merged.
- The handover next action is "Phase 6.2".

---

### Wave 6 (6.1 → 6.2)

#### Phase 6.1 — End-to-end proof, documentation and ADR finalization [tier:medium]

**Runs under DF-2, through the executor.** Its tasks run in executor slots (the `root=` and `cwd:` values below are
rewritten to the slot), integrate into `omr/<planId>/integration`, and land into `cpx/main`. Under the DF-2 fallback, it
runs as a normal phase in `D:\git\omr-cpx-p61` (branch `cpx/p61`). · **Depends on:** DF-2 (and 5.1)

**Goal:** prove G1–G12 end to end on the real OpenCode v2 host with deterministic scripted models, and finish the user
documentation. The dogfood comparison (§0.12-5) is written in 6.2.0.

**Pre-flight (in addition to §0.9)**
- [ ] `npm run smoke:cpx` is green on `cpx/main`.
- [ ] List the scripted-provider features still missing: scripted tool calls that write files, `ESCALATE:` replies,
      structured QA findings, per-call durations.
- [ ] Read `D:\git\omr-cpx-main\docs\ROLES.md`, `D:\git\omr-cpx-main\docs\OPENCODE_V2.md` and
      `D:\git\omr-cpx-main\docs\EXECUTOR.md` as merged.

**Order:** (6.1.1 ∥ 6.1.2) → 6.1.3 → 6.1.4 → 6.1.5 → QA.

**Tasks**
- **6.1.1** [tier:medium] VERIFY:required Scripted-provider additions, with unit tests.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p61 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.ts`, `D:\git\omr-cpx-main\test\smoke\helpers\cpx-scripted-provider.test.ts`
  (amendment A-0.1-1: the v1-frozen `scripted-provider.ts` and its test stay byte-identical).
  Reads: the pre-flight list in `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p61
  check: buildPasses
  check: testsPass
  criteria: every missing feature is added and unit-tested; npm run smoke:keyless stays green (orchestrator shell)
  [/acceptance]
- **6.1.2** [tier:medium] VERIFY:required Fixtures in `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\`.
  [route class=implement risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p61 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\`. Reads: `D:\git\omr-cpx-main\test\fixtures\cpx\repos\`.
  - 6.1.2.a Three repositories, all offline:
    - `node-pnpm`: TypeScript with a `typecheck` script;
    - `node-npm`;
    - `py-pip`: pytest, `requirements.txt` only.
  - 6.1.2.b Plan `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\throughput.md`: 24 tasks over 2 waves and 4
    phases, with an ownership table, explicit and implicit dependencies, scripted durations, and QA steps that return
    zero findings. It has no failure, question, 429 or restart (G8).
  - 6.1.2.c Plan `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\resilience.md`, the same shape plus:
    - a hidden overlap that only leases catch;
    - a task that breaks a test only the phase suite sees;
    - an `ESCALATE: human` task;
    - a QA step with two findings;
    - a 429 burst;
    - a host restart point;
    - one ad hoc background dispatch (not a plan task), with its annotation checked in the tail;
    - one user-backgrounded call, verified at completion;
    - one dispatch under required verification, held until its verdict (only when C4 and C15 hold).
  [acceptance]
  cwd: D:\git\omr-cpx-p61
  check: fileExists path=D:\git\omr-cpx-p61\test\fixtures\cpx\e2e\throughput.md
  check: fileExists path=D:\git\omr-cpx-p61\test\fixtures\cpx\e2e\resilience.md
  criteria: both plans compile with the 2.3 compiler; D:\git\omr-cpx-main\test\fixtures\cpx\e2e\throughput.md has no failure, question, 429 or restart
  [/acceptance]
- **6.1.3** [tier:medium] VERIFY:required `D:\git\omr-cpx-main\test\smoke\cpx-e2e.smoke.test.ts`.
  [route class=implement risk=high scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p61 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\test\smoke\cpx-e2e.smoke.test.ts`. Reads: the fixtures in
  `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\` and `D:\git\omr-cpx-main\test\smoke\helpers\routing-host.ts`.
  - 6.1.3.a Drive `/plan run` with a scripted orchestrator and scripted children for both plans, once per fixture
    repository.
  - 6.1.3.b Assert G1–G12 (§5.1) with measured numbers taken from the ledger's metric events:
    - makespan, CP and W (scripted durations), ΣI;
    - idle-with-ready intervals;
    - request-prefix equality;
    - lease conflicts;
    - branch greenness after every integration;
    - restart equivalence.
  [acceptance]
  cwd: D:\git\omr-cpx-p61
  check: buildPasses
  criteria: npm run smoke:cpx:e2e (orchestrator shell) is green three consecutive runs; every G1–G12 has an assertion that can fail
  [/acceptance]
- **6.1.4** Orchestrator: run the end-to-end smoke on the integrated 6.1 code. Create `D:\git\omr-cpx-e2e` with
  `git -C D:\git\omr-cpx-main worktree add --detach D:\git\omr-cpx-e2e <integration head>` (under DF-2 the head comes
  from `router_plan action=status`; under the fallback, `cpx/p61`), run `npm ci`, run `npm run smoke:cpx:e2e` three
  times there, record the Appendix D metrics in the report (under DF-2: in
  `$env:LOCALAPPDATA\omr-cpx\handover-df2.md`, per the freeze rule), then remove the worktree. Green: under DF-2 report
  `router_plan action=done task=6.1.4`. Red: `router_plan action=add-tasks` with a fix task that 6.1.4 depends on (or a
  fix in `D:\git\omr-cpx-p61` under the fallback), then rerun.
  Writes: none. Reads: `D:\git\omr-cpx-e2e\`.
- **6.1.5** [tier:medium] VERIFY:required Documentation.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p61 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\EXECUTOR.md`, `D:\git\omr-cpx-main\README.md`,
  `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`, `D:\git\omr-cpx-main\docs\ROLES.md`,
  `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`, `D:\git\omr-cpx-main\docs\plans\README.md`,
  `D:\git\omr-cpx-main\test\unit\docs-drift.test.ts`.
  Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` as committed (read in the task's worktree or
  slot; read-only, owned by the orchestrator).
  - 6.1.5.a `D:\git\omr-cpx-main\docs\EXECUTOR.md`:
    - the final safety model: leases, slots, invariants I1–I5;
    - Windows notes: slots on the same drive, the pnpm store, `UV_CACHE_DIR`, long paths;
    - troubleshooting and metrics;
    - an owner checklist for the next real plan.
  - 6.1.5.b An "Executing plans" section in `D:\git\omr-cpx-main\README.md`, and cross-links in
    `D:\git\omr-cpx-main\docs\OPENCODE_V2.md` and `D:\git\omr-cpx-main\docs\ROLES.md`.
  - 6.1.5.c ADR 0007: status Accepted; the measured results are added in 6.2.0.
  - 6.1.5.d The plans README entry is marked done.
  - 6.1.5.e Drift pins for the `D:\git\omr-cpx-main\docs\EXECUTOR.md` tables and the ADR decision list.
  [acceptance]
  cwd: D:\git\omr-cpx-p61
  check: testsPass
  check: fileExists path=D:\git\omr-cpx-p61\docs\EXECUTOR.md
  criteria: every command, action and config key in code appears in D:\git\omr-cpx-main\docs\EXECUTOR.md; drift fails when one is removed
  [/acceptance]
- **6.1.QA** [tier:heavy] Senior QA. CAP:none — reason: the end-to-end test is the evidence for the global criteria.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-p61 tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-p61\` (under DF-2, the integration head of the 6.1 plan) at the fixed QA commit.
  Adversarial focus:
  - assertions that cannot fail: tautological metrics, a CP computed from the schedule it judges, an observed p used as
    the bound;
  - scenarios that skip the hard paths;
  - flakiness;
  - docs describing behavior the code does not have.
- **6.1.FIX** [tier:medium] Fix every QA-6.1 finding.
  [route class=debug risk=medium scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p61 tier=medium pin]
  Writes: the 6.1-owned files named by the findings. Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p61
  check: buildPasses
  check: testsPass
  criteria: every QA-6.1 finding listed in the dispatch is fixed
  [/acceptance]

**New tests:**
- The scripted-provider unit tests.
- The end-to-end smoke: 2 plans × 3 repositories.
- The docs-drift pins.

Edge cases are those listed in 6.1.2.

**Acceptance criteria:**
- G1–G12 asserted green in three consecutive runs.
- Docs complete and pinned.
- The ADR is final.

**Definition of Done:**
- §0.9 met.
- Typecheck, the phase's scoped tests (§0.6-9), `npm run smoke:cpx` and `npm run smoke:cpx:e2e` green.
- `router_verify pending:true` passes.
- Zero open findings; pushed; merged.

#### Phase 6.2 — Global senior QA, fixes and delivery [tier:heavy]

**Worktrees:** QA reads `D:\git\omr-cpx-main` at a fixed commit; fixes run in `D:\git\omr-cpx-p62` (branch `cpx/p62`)
· **Depends on:** 6.1

**Pre-flight (in addition to §0.9)**
- [ ] Every phase report shows zero open findings, and `cpx/main` contains every phase merge.
- [ ] In the orchestrator shell, these are green on `cpx/main`:
  - `npm run typecheck`;
  - the full suite with coverage, once: `npx vitest run --coverage --maxWorkers=<n>` (orchestrator shell), meeting every
    threshold in `D:\git\omr-cpx-main\vitest.config.ts` (§0.6-9);
  - `npm run smoke:cpx`, `npm run smoke:cpx:provision`, `npm run smoke:cpx:e2e`;
  - `npm run smoke:keyless`, `npm run smoke:v2`, `npm run smoke:routing`, `npm run smoke:v2:e2e`;
  - `npx cross-env RUN_OC_SMOKE_ROLES=1 RUN_OC_SMOKE_ROLE_SPIKES=1 vitest run --config vitest.smoke.config.ts test/smoke/roles.smoke.test.ts test/smoke/role-spikes.smoke.test.ts`;
  - `npm run smoke:v1`, when an OpenCode 1.x executable is available. Otherwise record it as not run; the v1 goldens are
    then the evidence.

**Order:** 6.2.0 → 6.2.QA → 6.2.FIX (loop) → 6.2.4 → 6.2.3 → 6.2.5.

**Tasks**
- **6.2.0** [tier:medium] VERIFY:required Dogfood report: write the "Measured on its own implementation" section of
  `D:\git\omr-cpx-main\docs\EXECUTOR.md` from `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` (time
  windows per G13) and, in `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`, the measured results of the
  scripted end-to-end runs (the 6.1.4 metrics, copied into
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md` after the landing) and of the dogfood. It is
  merged into `cpx/main` before 6.2.QA.
  [route class=implement risk=low scope=multi needs=edit,shell d=deterministic root=D:\git\omr-cpx-p62 tier=medium pin]
  Writes: `D:\git\omr-cpx-main\docs\EXECUTOR.md`, `D:\git\omr-cpx-main\docs\adr\0007-critical-path-execution.md`.
  Reads: `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md`. Pasted into the dispatch, not read by path:
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` and
  `D:\git\omr-cpx-main\docs\plans\critical-path-execution-handover.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p62
  check: testsPass
  criteria: docs-drift green; numbers equal D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md and D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-6.1.md
  [/acceptance]
- **6.2.QA** [tier:heavy] Global adversarial QA on `cpx/main` at a fixed commit. CAP:none — reason: whole-feature invariants
  span every new module and every hub.
  [route class=review risk=high scope=repo needs=shell d=none root=D:\git\omr-cpx-main tier=heavy pin]
  Writes: none. Reads: `D:\git\omr-cpx-main\` at the fixed QA commit.
  Focus:
  - verify every G1–G12 against code and tests, not reports, and G13 against
    `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`, the Phase 6.1 ledger (the pasted output of
    `router_plan action=export`) and the integration history;
  - the §0.13 isolation: the main checkout is off-limits (§0.13-1): no change to `D:\git\opencode-model-router` and no
    push to `master` outside the PR;
  - the five safety invariants end to end:
    - single writer;
    - no read or run under edit;
    - an always-green integration branch;
    - nothing integrated without PASS;
    - nothing deleted outside marked slots;
  - security:
    - no shell anywhere;
    - ref-name and path injection from plan text;
    - D18 trust;
    - hardened git;
    - no credentials in logs or rows;
  - races across the background processor, the executor runtime and recovery;
  - Windows behavior;
  - v1 inertness and byte-identical v1 output;
  - per-turn overhead;
  - docs accuracy;
  - leftover TODOs, dead config and unused exports.
- **6.2.FIX** [tier:medium] Fix every finding in `D:\git\omr-cpx-p62`, one writer per file at a time. Each fix gets a
  regression test. Heavy re-reviews per §0.7, in bounded rounds; then merge into `cpx/main`.
  [route class=debug risk=high scope=repo needs=edit,shell d=deterministic root=D:\git\omr-cpx-p62 tier=medium pin]
  Writes: files named by the findings (serialized). Reads: the global findings, pasted from
  `D:\git\omr-cpx-main\docs\qa\critical-path-execution\global.md`.
  [acceptance]
  cwd: D:\git\omr-cpx-p62
  check: buildPasses
  check: testsPass
  criteria: every global finding is fixed with a regression test; no v1 output changes
  [/acceptance]
- **6.2.3** Orchestrator: clean up after the merge (6.2.4).
  1. Complete or abort every ledger this run created, then run `router_plan action=purge` for each (slot GC,
     `omr/<planId>/*` refs, ledger removal); check that nothing remains under `D:\git\.omr-cpx-slots`.
  2. Remove every `D:\git\omr-cpx-p*` and `D:\git\omr-cpx-pdf<n>-<k>` worktree and its local and remote branch
     (`cpx/p*`, `cpx/pdf<n>-<k>`).
  3. Delete every `cpx/p*-base` and `cpx/pdf<n>-<k>-base` tag locally (they are never pushed). Keep the `cpx/df*` tags
     until 6.2.5.
- **6.2.4** Orchestrator: deliver. First rerun every pre-flight command on `cpx/main`, complete the CHANGELOG, and push
  `cpx/main`.
  1. Open the pull request `cpx/main` → `master` with `gh pr create`. The body summarizes the feature, the measured
     results (scripted and dogfood) and the QA reports, with no AI attribution.
  2. Wait for CI to pass on every job, including the merged coverage gate. A CI failure is a 6.2 finding: fix it in
     `D:\git\omr-cpx-p62` (§0.7), merge, push, and wait again.
  3. Merge with `gh pr merge --merge`. No review is required (solo developer).
  4. Never touch the main checkout `D:\git\opencode-model-router` (§0.13). Tell the owner:
     - the files this plan changed that the other implementation may also touch (`git diff --stat` of the merge);
     - that the local `master` should be updated only when the other implementation allows it;
     - the reinstall or restart steps.
- **6.2.5** Orchestrator plus a planned human action: leave dogfood.
  1. Restore the plugin entry, using the recorded revert from 0.P.3.f, to the target the owner chooses (the merged
     `master` build or the previous target).
  2. Ask the owner to restart OpenCode.
  3. After the restart, when the host no longer loads them, remove every `D:\git\omr-cpx-dogfood-df*` worktree with
     `git -C D:\git\omr-cpx-main worktree remove <path>`, and delete the `cpx/df*` tags locally and remotely.
  4. Keep `D:\git\omr-cpx-main` and `cpx/main` until the owner removes them.

**New tests:** a regression test for every global finding that changed code.

**Acceptance criteria:**
- G1–G13 re-verified by the global QA against code and tests.
- Every global finding fixed.
- CI green.
- The PR merged.

**Definition of Done:** §5.2.

**Report:** `D:\git\omr-cpx-main\docs\qa\critical-path-execution\global.md`.

---

## 5. Global acceptance, Definition of Done and QA

### 5.1 Global acceptance criteria

| Id | Criterion | Proven in |
|---|---|---|
| G1 | **Background-first.** On v2 with the default config, a dispatch returns a running acknowledgement at once when it has a sampled estimate ≥ 45 s, `testsPass`/`buildPasses`, or is a plan task, and the orchestrator's next step runs before the child ends. A dispatch with only the prior adds no background key. `off` reproduces today's `nativeArgs` exactly. | 2.1, 6.1 |
| G2 | **Guarantees at completion.** Annotations, deferred registration, change-set capture, verification enqueue and timing happen exactly once per child attempt, for foreground, background and user-backgrounded dispatches. | 2.1, 6.1 |
| G3 | **Held results.** When C4 and C15 hold, a background child's output under required verification is never visible to the orchestrator before its verdict, including after compaction. PASS posts output and verdict, FAIL posts findings, and the parent is woken once. When C4 or C15 do not hold, such dispatches stay in the foreground. | 2.1, 6.1 |
| G4 | **Cache stability.** On v2, consecutive orchestrator requests are byte-identical through the previous request's messages, including across held → released. Dynamic state appears only in the tail. *Amended by A-0.1-3 (QA-0.1-31):* D5 is withdrawn, so no TTL is set: each request carries one ephemeral breakpoint (no TTL) on the last real message, and the system array never changes. If C5 made this unattainable, ADR 0007 records it. | 1.2, 2.1, 6.1 |
| G5 | **Compilation.** The frozen copies of the three largest plans and of this plan compile with every task id recognized, ≥ 80% write-footprint coverage for editing tasks, zero cycles, and their explicit dependencies present. Unannotated plans compile through the classifier. | 2.3 |
| G6 | **File safety.** No file is written by two agents at once. In a shared tree, no file is read through an agent's file or search tools while a child agent holds its write lease; a `router_run` there is annotated as possibly contaminated (refused under `routing.leases.run: "refuse"`); plugin verification runs are deferred. Enforced in code and proven by tests, for ad hoc and plan dispatches; observed in real use under DF-1 and DF-2. | 1.3, 2.1, 3.1, 6.1 |
| G7 | **Integration.** The plan integration branch never points at a commit whose integration checks failed, reverts included. Phase-suite failures are bisected, and the culprit is reverted through a checked slot and reopened automatically. | 3.2, 6.1 |
| G8 | **Throughput.** On `D:\git\omr-cpx-main\test\fixtures\cpx\e2e\throughput.md`: makespan ≤ 1.3 × max(CP, W/p, ΣI). CP and W come from the durations scripted before the run, p is the configured `maxParallel`, ΣI is the measured serial integration time. No idle-with-ready interval exceeds 10 s. | 3.1, 6.1 |
| G9 | **Durability.** A host restart mid-plan converges to the same ledger and integration branch as an uninterrupted run, with no task launched or integrated twice. Pending verifications outside plans survive restarts. | 2.1, 2.2, 4.2, 6.1 |
| G10 | **Unattended.** A question parks only its task and dependents, and independent work continues. QA loops turn findings into fixes and re-reviews automatically. The circuit breaker is the only automatic stop. There are zero polling turns. | 4.2, 6.1 |
| G11 | **Adaptive capacity.** A 429 burst halves the provider's capacity, which recovers to the cap after successes. A usage-limit error pauses the provider with one inbox item. | 3.1, 6.1 |
| G12 | **Non-regression.** v1 unchanged: goldens, help, stats, and `smoke:v1` where available. docs-drift green. Typecheck, the full suite, every smoke suite in 6.2's pre-flight, and the coverage thresholds all green. PR CI green on every job. | every phase, 6.2 |
| G13 | **Dogfood.** Every dispatch made after the DF-1 restart ran on the DF-1/DF-2 build (handover timestamps), with every rollback recorded. Phase 6.1 was executed by the executor on this repository end to end: compile → launch → verify → integrate → phase suite → QA loop → fast-forward into `cpx/main`. Every dogfood fault `DF-<n>-<k>` has a regression test and is closed. `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md` and `D:\git\omr-cpx-main\docs\EXECUTOR.md` report the metrics per time window (before DF-1, after DF-1, under DF-2), including the share of dispatches forced to the foreground. The main checkout and the other implementation were never touched (§0.13). | DF-1, DF-2, 6.1, 6.2 |

### 5.2 Global Definition of Done

- [ ] Every phase DoD is met, and every phase report and
      `D:\git\omr-cpx-main\docs\qa\critical-path-execution\global.md` show zero open findings.
- [ ] G1–G13 are verified: G1–G12 by tests on `cpx/main`, not by reports; G13 by
      `D:\git\omr-cpx-main\docs\qa\critical-path-execution\dogfood.md`, the ledger of the Phase 6.1 run (the pasted
      output of `router_plan action=export`) and the integration history.
- [ ] No `root=`, `cwd:`, tool argument or shell command in the handover, the reports or the dispatch logs names
      `D:\git\opencode-model-router`.
- [ ] The dogfood plugin entry is restored and the dogfood worktree removed (6.2.5), or the owner's decision to keep
      them is recorded.
- [ ] Every command in the Phase 6.2 pre-flight is green; coverage thresholds are met; PR CI is green on every job.
- [ ] ADR 0007 is Accepted with measured results.
- [ ] These are updated:
  - `D:\git\omr-cpx-main\docs\EXECUTOR.md`;
  - `D:\git\omr-cpx-main\README.md`;
  - `D:\git\omr-cpx-main\docs\ROLES.md`;
  - `D:\git\omr-cpx-main\docs\OPENCODE_V2.md`;
  - `D:\git\omr-cpx-main\docs\VERIFICATION.md`;
  - `D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`;
  - `D:\git\omr-cpx-main\docs\ROUTING_ENGINE.md`;
  - `D:\git\omr-cpx-main\docs\plans\README.md`.
- [ ] CHANGELOG `## [Unreleased]` is complete.
- [ ] No phase worktree, phase branch (local or remote), `cpx/p*-base` tag or fixture slot remains.
      `router_plan action=purge` ran for every plan this run created; nothing remains under `D:\git\.omr-cpx-slots`.
- [ ] The PR is merged into `master`, and the owner has been told to pull and restart.
- [ ] No commit, PR or file contains AI attribution.

### 5.3 Global QA

Phase 6.2 is the global senior QA review: [tier:heavy], adversarial. Every finding is fixed and re-reviewed under §0.7.

---

## Appendix A — Ledger schema v1 and task state machine

*Amended by A-1.4-1:* where the contract addenda A1–A3 of `D:\git\omr-cpx-main\docs\qa\critical-path-execution\phase-1.4.md` change this appendix, those addenda are binding.

```ts
interface LedgerV1 {
  schema: 1;
  planId: string;                          // ^[a-z0-9][a-z0-9-]{2,40}$
  planPath: string;                        // absolute
  planDigest: string;                      // sha256 of the plan text at compile time
  repo: { key: string; toplevel: string; baseBranch: string; baseCommit: string };  // key = realpath(git common dir)
  integration: { branch: string; worktree: string; head: string };                  // branch = omr/<planId>/integration
  launcher: "A";                           // ADR 0007 D14
  status: "compiling" | "awaiting-residue" | "awaiting-approval" | "running" | "paused" | "completed" | "aborted";
  orchestrator: { sessionID: string; boundAt: string };
  config: ExecutorConfig;                  // resolved snapshot at approval
  sharedContext: string;
  waves: Array<{ id: string; phases: string[] }>;
  phases: Array<{ id: string; title: string; wave: string; dependsOn: string[]; gate: GateState;
                  qaRound: number; paused: boolean; tag: string | null }>;
  tasks: Record<string, TaskNode>;
  edges: Edge[];
  inbox: InboxItem[];
  seq: number;
}
type GateState = "pending" | "suite-running" | "suite-failed" | "awaiting-qa" | "qa-running" | "passed";
interface TaskNode {
  id: string; title: string; phase: string | null;
  kind: "preflight" | "task" | "tests" | "qa" | "fix" | "manual";
  text: string; subtasks: string[];
  route: { line: string; role: string; tier: "fast" | "medium" | "heavy" | null; pin: boolean };
  verify: "required" | "deferred" | "none"; acceptance: string | null;
  footprint: { writes: string[]; reads: string[];          // repo-relative, normalized
               confidence: "explicit" | "ownership" | "inferred" | "unknown";
               sources: Array<"path" | "ownership" | "writes-line" | "llm" | "learned"> };
  estimate: { p50: number; p90: number; source: string };
  state: TaskState; attempts: Attempt[];
  slot: string | null; branch: string | null;               // omr/<planId>/t/<encoded taskId>
  integrated: { from: string; to: string } | null;
}
type TaskState = "pending" | "ready" | "dispatched" | "running" | "completed" | "verifying" | "verified"
  | "integrating" | "integrated" | "done" | "failed" | "conflict" | "parked" | "blocked" | "reverted" | "cancelled";
interface Edge { from: string; to: string;
  kind: "structural" | "explicit" | "graph" | "contract" | "conflict" | "llm" | "learned";
  confidence: "high" | "medium" | "low"; evidence: string }
interface Attempt { n: number; nonce: string; callID: string | null; childSessionID: string | null; startedAt: string;
  endedAt: string | null; outcome: "succeeded" | "failed" | "interrupted" | "lost" | "capacity" | null;
  verdict: "pass" | "fail" | "unverifiable" | null; context: string }   // conflict, findings or answer
interface InboxItem { id: string; kind: "question" | "failure" | "usage-limit" | "landing" | "flaky" | "qa-cap" | "breaker";
  severity: "info" | "blocking" | "critical"; taskId: string | null; text: string; options: string[];
  answer: string | null; createdAt: string }
```

**Legal transitions** (`TASK_TRANSITIONS`). Anything else is rejected by `canTransition` and by ledger replay. Every
transition into `dispatched`, `running`, `completed`, `integrating`, `integrated`, `reverted` or `cancelled` is fsynced
before any externally visible step (D8).

| From | To | Trigger |
|---|---|---|
| pending | ready | dependencies are `integrated` or `done` |
| pending | blocked | a dependency was parked, or failed terminally |
| pending | cancelled | plan aborted |
| ready | dispatched | launch (launcher A) |
| ready | blocked | a dependency was reverted |
| ready | cancelled | abort |
| ready | running | recovery adopts a live child carrying this attempt's nonce |
| ready | done | a `manual` or `preflight` task reported done (`router_plan action=done`) |
| ready | pending | `add-tasks` added an unsatisfied dependency |
| dispatched | running | child created or acknowledged |
| dispatched | ready | launch refused, aborted before start, or not confirmed (stale context, D14 guard 2; attempt outcome `lost`) |
| dispatched | failed | host error |
| dispatched | blocked | a dependency was reverted |
| dispatched | cancelled | abort |
| running | completed | child ended |
| running | failed | child failed |
| running | parked | `ESCALATE: human` |
| running | ready | child lost (recovery or an unrequested interrupt; outcome `lost`), a capacity stop (D13; outcome `capacity`), or `NEED MORE: lease` |
| running | blocked | a dependency was reverted |
| running | cancelled | abort |
| completed | verifying | committed in the slot |
| completed | done | no changes |
| completed | failed | commit failed |
| verifying | verified | PASS |
| verifying | failed | FAIL or unverifiable |
| verifying | cancelled | abort |
| verified | integrating | dequeued |
| verified | cancelled | abort |
| integrating | integrated | fast-forward done |
| integrating | conflict | rebase conflict |
| integrating | failed | integration checks failed |
| integrating | cancelled | abort, only after `resume()` rolled the step back |
| integrated | reverted | culprit of a phase-suite failure |
| conflict, failed, reverted | ready | attempts left |
| conflict, failed, reverted | parked | attempts exhausted |
| parked, blocked | ready | answer received, or dependency recovered |
| completed, failed, conflict, reverted | cancelled | abort |
| parked, blocked | cancelled | abort |

`integrated` is terminal except for `reverted`. `done` and `cancelled` are terminal. `integrated` is reachable only
through `verified` → `integrating`. Tasks are created `pending`, or `done` through a `task-created` event (for
`doneBefore`). A `manual` or `preflight` task stays `ready` until reported done; its failures go through `add-tasks`.

*Amended by A-0.1-2:* Attempts whose outcome is `lost` or `capacity` do not count toward `maxAttempts` (ADR 0007 D13, D14, D16).

## Appendix B — Turn-state tail (v2, regenerated on every request, never persisted)

```
<router-state>
in flight (2): ses_ab12 implementer "fix lease release" 6m/~9m · ses_cd34 runner "scoped tests" 2m/~4m
completed (1): ses_gh78 implementer "add ledger" 9m — budget 31/40 · verification vrf_a1b2 (deferred, risk low)
held (1): ses_ef56 verdict pending (vrf_9f2c) — do not use its output yet
verdicts unread (1): vrf_7a10 FAIL — router_verify vrf_7a10 for the findings
plan p-20261010-a1b2c3 · launcher A · wave 2 · phase 2.1 · integrated 14/52 · in flight 4 · capacity anthropic 3/4, openai 1/2 · QA 1.4 passed
inbox (1): Q-3 (question, 2.3.4) — router_plan action=status
</router-state>
```

**Rules:**
- Section order is fixed; empty sections are omitted.
- *Amended by A-0.1-2:* A stale launch context (D14) appends `· launch context stale — call router_plan action=status` to the plan
  line until a router tool call refreshes it.
- Elapsed times are rounded to minutes.
- Total size is at most 6000 characters, with an overflow line.
- Root sessions only.
- An unread verdict is rendered on every turn until `router_verify` reads it.
- A completed entry is rendered on every request of the parent's next turn, then dropped.

## Appendix C — Configuration keys

All keys are v2 only. They are documented as rows of the routing table in
`D:\git\omr-cpx-main\docs\CONFIG_REFERENCE.md`, without the `routing.` prefix.

| Key | Type | Default | Range / values | Trusted only (D18) | Phase |
|---|---|---|---|---|---|
| `routing.promptCache.ttl` | — | — | **Not added (A-0.1-3):** ADR 0007 D5 is withdrawn on OpenCode v2.0.26; no key, no TTL hint | — | — |
| `routing.background.mode` | string | `"auto"` | `"auto"`, `"model"`, `"off"` | no | 2.1 |
| `routing.background.minPredictedMs` | integer | `45000` | 0–3600000 | no | 2.1 |
| `routing.leases.mode` | string | `"enforce"` | `"enforce"`, `"off"` | no | 2.1 |
| `routing.leases.run` | string | `"annotate"` | `"annotate"`, `"refuse"` | no | 2.1 |
| `routing.executor.maxParallel` | integer | `4` | 1–8 (largest concurrency proven by C13 and C14; ADR 0007 D13) | no | 4.1 |
| `routing.executor.slotsDir` | string or null | `null` (computed: `<repo parent>\.omr-slots\<repo>-<hash>`) | absolute; on the repository's drive; not a drive root; neither inside nor an ancestor of the repository; no `*` | **yes** | 4.1 |
| `routing.executor.approve` | string | `"ask"` | `"ask"`, `"auto"` | no | 4.1 |
| `routing.executor.crossPhase` | string | `"gate"` | `"gate"`, `"inferred"` | no | 4.1 |
| `routing.executor.land` | string | `"ff-when-clean"` | `"ff-when-clean"`, `"manual"` | no | 4.1 |
| `routing.executor.batchMax` | integer | `4` | 1–8 | no | 4.1 |
| `routing.executor.maxAttempts` | integer | `3` | 1–6 | no | 4.1 |
| `routing.executor.qaMaxRounds` | integer | `3` | 1–8 | no | 4.1 |
| `routing.executor.integrationChecks` | string or array | `"auto"` | `"auto"` or `[{script, args}]` | **yes** | 4.1 |
| `routing.executor.phaseSuite` | string or array | `"auto"` | `"auto"`, `"off"` or `[{script, args}]` | **yes** | 4.1 |
| `routing.executor.provision` | string or object | `"auto"` | `"auto"` or `{ <manager>: string[][] }` (argv arrays) | **yes** | 4.1 |
| `routing.executor.python` | string | `"auto"` | `"auto"` (`py -3` on Windows, `python3` elsewhere) or an absolute path | **yes** | 4.1 |
| `routing.executor.sharedContextChars` | integer | `12000` | 0–60000 | no | 4.1 |
| `routing.executor.capacityCooldownMs` | integer | `120000` | 10000–3600000 | no | 4.1 |
| `routing.executor.capacityPauseMs` | integer | `900000` | 60000–86400000 | no | 4.1 |
| `routing.executor.wakeDebounceMs` | integer | `5000` | 1000–60000 | no | 4.1 |
| `routing.executor.circuitBreaker.failureRatio` | number | `0.4` | 0.1–1 | no | 4.1 |
| `routing.executor.circuitBreaker.minAttempts` | integer | `5` | 1–50 | no | 4.1 |
| `routing.executor.circuitBreaker.consecutiveFailures` | integer | `3` | 1–50 | no | 4.1 |

**Notes.** `executor.phaseSuite` and `executor.integrationChecks`: each `{script, args}` entry resolves like
`router_run`: a `routing.run.commands` entry (whose argument patterns apply) or an allowlisted `package.json` script
(which takes no arguments). The run's cwd is the `ci` slot for the phase suite, and the slot being checked for
integration checks (3.2.3.a).

## Appendix D — Metrics

Recorded as ledger `metric` and `integration-step` events by 3.1 and 3.2, rendered by `router_plan action=status`, and
asserted in Phase 6.1.

| Metric | Definition | Source |
|---|---|---|
| Plan efficiency | makespan / max(CP, W/p, ΣI) | ledger task timestamps, scripted or estimated durations, integration-step events |
| Idle-with-ready | intervals during which a ready task and free capacity existed with nothing launched | runtime `metric` events |
| Orchestrator cache-read share | p50 and p10 of cacheRead / (input + cacheRead + cacheWrite) per orchestrator turn | `turns.jsonl` (1.1) |
| Conflict rate | integration conflicts / integrated tasks | queue events |
| Rework rate | attempts beyond the first / tasks | ledger attempts |
| Integration wait | p50 and p90 of the time from `verified` to `integrated` | integration-step events |
| Capacity events | decreases, pauses, recoveries and retry-hook stops per provider | capacity `metric` events |
| Retained-context age | age of the retained orchestrator context at each launcher A launch; the largest age at which a launch succeeded (6.2.0 writes it into ADR 0007) | runtime `metric` events (3.1) |
| Human stops | inbox items of severity blocking or critical, and their time to answer | ledger inbox |

---

## Plan QA record

The plan was reviewed adversarially by [tier:heavy] before execution (round 1: 5 blocking, 5
critical, 33 major, 17 minor and 3 nit findings, 63 in total). Every finding was fixed in this text.

**Blocking**
- Base branch `master`.
- The plan copied into `cpx/main`.
- The `workRoots` check in 0.P.3.
- Assembly moved to a new Phase 5.1.
- Phase 0.1 owns and extends the harness.

**Critical**
- v2-only protocol and goldens.
- D18 trust for command-executing keys.
- Foreground fallback when C4 or C15 fail.
- fsync before visible steps, plus nonce adoption.
- Append-only annotations and a stable held placeholder.

**Major**
- `onExecutionOutcome` added; `onExecutionEnded` unchanged.
- `router_run` usage and the shell route for coverage and `npm ci`.
- Existing-test ownership.
- Full paths and `Writes:`/`Reads:` on every task.
- Route lines without backticks.
- Acceptance blocks on every deterministic or required task.
- Coverage gates aligned with `D:\git\omr-cpx-main\vitest.config.ts`, and `src/executor` gated.
- Every v2 smoke suite in the DoDs.
- Phase start by dependencies, not wave barriers.
- `slotsDir` permission moved to 5.1.
- Intra-phase "Order:" lines.
- Launcher A evaluated through C14.
- Solo delivery with CI and merge.
- The handover file.
- The live run replaced by an owner dogfood checklist.
- A measurable G8.
- Appendix A extended (`done`, cancel, blocked-on-revert, commit failure).
- Orchestrator turn rows.
- Pending persistence (P5).
- Python drift manifests.
- `cleanForChecks`.
- The C11 and C5 fallbacks corrected.
- G6 scope, including `router_run`.
- The task-id grammar.
- `off` semantics.
- The prior never selects background.
- v1-only registration.
- Revert through a checked slot.
- Metric events.
- C15 compaction.
- The pip fixture without `-e .`.
- Serialized full suites.

**Minor and nits**
- 0.P and 6.2 got acceptance criteria, DoD and QA.
- Reports have one writer.
- Slot markers live outside the worktrees.
- The journal is rotated.
- `/plan adopt`.
- Docs handoffs.
- `ROUTING_DEFAULTS`.
- The C13 clamp.
- The overflow hint.
- Unread notices persist.
- Smoke scripts split.
- Cleanup.
- Amendment merges.
- Held resume refused.
- uv skips.
- Git steps without route lines.
- `router_verify` in DoDs.
- `remove` added to the API list.
- Tag order.
- Host ≥ 2.0.24.

**Round 2** — 28 new findings (1 critical, 8 major, 17 minor, 2 nits) and 2 unresolved round-1 findings (QA-PLAN-14,
QA-PLAN-16); all fixed: root sessions take no leases and `router_run` is annotated, not refused (R2-1, R2-2); launcher B
protocol task 4.1.6 (R2-3); 2.3 depends on 1.3 (R2-4); intra-phase orders fixed (R2-5, R2-6); background annotations in
the turn-state tail, foreground unchanged (R2-7); `preemptBackgroundVerification` export and 3.2 depends on 2.1 (R2-8);
provider rate-limit rule §0.6-11 (R2-9); and the minor items R2-10 to R2-28.

**Owner directives added after round 2** — dogfood on its own implementation (§0.12, switches DF-1 and DF-2, G13); a
dedicated worktree because another implementation is in progress in the main checkout (§0.13).

**Round 3** — 41 findings (3 blocking, 3 critical, 21 major, 12 minor, 2 nits) and 5 open round-2 items; all fixed. Key
changes: the canonical path prefix is the plan's own worktree `D:\git\omr-cpx-main\`; DF-0 baseline and one dogfood
worktree per switch; `router_plan compile` takes `phases`/`doneBefore`; manual tasks, dogfood sections and pre-flight
items compile correctly; the executor rewrites worktree paths to slots; `cpx/main` is frozen during the DF-2 run;
telemetry no longer depends on `routing.engine`; executor instructions live in the turn-state tail; shared state with
the other implementation is listed and contained (§0.13-5).

**Round 4** — 21 findings (9 major, 10 minor, 2 nits), no blocking or critical; all fixed. Key changes: a path-free
`plan-context` block for children; Conventional Commit messages for executor commits; the executor home is reached only
through `router_plan` (`export`, `purge`); phase files live in the phase worktree; the DF-2 freeze routes fixes through
`cpx/pdf2-<k>` tags; the duration model is wired into background decisions; manual-task failures have a legal
transition; DF-0 runs before the first role dispatch.

**Round 5** — 10 findings (2 major, 6 minor, 2 nits), no blocking or critical; all fixed without a further review round,
at the owner's request: 6.1 metrics reach ADR 0007 through 6.2.0; the DF-1 lease probe holds its lease long enough;
`phaseSuite`/`integrationChecks` resolution; `deleteRefs`; literal paths are orchestrator-only; DF-0 resume point;
Node ≥ 22.18; DF-2 switch procedure and the 24 h pending TTL from DF-1; QA tasks return JSON only.

**Amendment log** (inline markers read *Amended by A-…*; A-0.1-1 and A-0.1-2 are listed in the handover file's "Amendments"):
- **A-0.1-3** (QA-0.1-17, -18, -20, -21, -22, -25, -26, -27) — applies ADR 0007's QA revision of 2026-10-11 to Phase 0.1: D5 is withdrawn on OpenCode v2.0.26 (no `routing.promptCache.ttl`, no TTL hint, the system array is never changed; 1.2.3 and 1.2.5.b/c do not apply; O11 does not apply); `provider.quota`, host-ended `provider.rate-limit` and host-ended `provider.internal` with status 529 close an attempt as `capacity` (uncounted, outside the circuit breaker; a `provider.internal` with any other status is not capacity: the attempt is `failed` and counted, QA-0.1-30); the retry-hook stop and quota retry-hook calls are capacity signals; launcher-A prompt order is PLAN CONTEXT, launch header, TASK; launcher B leftovers removed; launches never use the retained `signal` and never forward `progress`; D7 lists the `router_git_*` tools, and `shell`/`execute` are not covered by leases. Items marked A-0.1-3 in the text: D5 row, C6 decided branch, 1.2.1 memo, 1.2.3, 1.2.5.b/c, the 1.2 QA focus and smoke bullets, 3.1.4.a, Appendix C `routing.promptCache.ttl`. Added by QA-0.1-30 and QA-0.1-31: `provider.internal` is overload only with status 529 (`classifyProviderError` agrees with the Phase 1.1 `classifyCapacity`); 1.2.3 is reduced to a superseded note (route line and acceptance block removed); 1.2.5 no longer reads `src\router\config.ts`, and its acceptance no longer mentions a TTL resolution; global acceptance G4 and the 1.2 exit bullet state that no TTL is set.
- **A-1.1-1** (Phase 1.1) — 2.1.5.c acquires the timing recorder with `acquireTimingRecorder` and makes the calls listed under "Handoffs" in `docs\qa\critical-path-execution\phase-1.1.md`.
- **A-1.2-1** (QA-1.2-12, -16) — the D4 hint goes on the last non-blank text part of the last real message, else on its last `tool-result` or `media` part, else no hint, never an earlier message. Observed on v2.0.26: the `tool_result` block carries the marker. "Never on the tail" holds only while the host's four-marker budget is used. Changed in the D4 row, 1.2.1 memo, 1.2.5.a and the 1.2 test bullets.
- **A-1.3-1** (Phase 1.3, ADR 0007 D7) — 1.3.3.b/c: read, search and run restrictions apply to another child session (root sessions are never refused); lease ownership is the task (`taskRef`); read/run conflicts are decided per owner; a run also conflicts with leases under the run directory; unkeyable spellings fail closed; `checkRun` costs the leases of the run tree plus those under the run directory, not O(1).
- **A-1.4-1** (Phase 1.4 contract addenda A1–A3) — `docs\qa\critical-path-execution\phase-1.4.md` addenda are binding where they change Appendix A, 3.1.1 (lease seam, A3), 3.1.4 (`formatLaunchPrompt`), 3.1.5 (`bootID`, context pin), 3.2.3.c (`resume()`, A1-3/A2) and 4.2.2 (`qa-cap` answers). The addenda are not copied into the plan.

**Owner execution rules for the implementation session** — §0.14 (continuous iteration, momentary takeover, atomic delegation with [tier:heavy] for complex coding and lighter test runs, bounded QA rounds, pre-flight fix-or-document, Linear not used, worktree reporting), the testing policy (§0.6-9: scoped, accelerated, full suite only in 6.2), the bounded executor QA loop (default 3 rounds), and the handover's kickoff prompt.
