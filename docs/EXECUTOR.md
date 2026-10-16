# Plan executor

> **Status: assembled and registered on OpenCode v2 only.** The `router_plan` tool, the `/plan` command and the executor
> instructions are registered on v2; running a plan requires the [assembly preconditions](#assembly-and-lifecycle).
> OpenCode v1 is unchanged: no executor tool, command or instructions are registered there, and the
> `routing.executor.*` keys are ignored with one notice per process (see
> [OpenCode v1 fallback](ROLES.md#opencode-v1-fallback) for how v2-only features behave there).

The plan executor runs a written plan (a Markdown file of phases and tasks) with several subagents at once, without
letting a half-finished task touch your checkout. This page describes what it does, the `/plan` command, the
`router_plan` tool, the configuration and the trust rules. See also [OpenCode v2](OPENCODE_V2.md).

## Concepts

- **Ledger and DAG.** A plan is compiled into a ledger: tasks, the dependencies between them (a directed acyclic graph),
  and the phases they belong to. The ledger is stored on disk under the plan's id, so a plan survives a restart. The
  compile step reports the number of tasks, phases and edges, the total work, the critical path, the width (how many
  tasks can run at once) and the expected makespan. Tasks that need a human (manual tasks) are listed apart.
  A task the compiler cannot place on its own may need a "residue" step: the compiler returns a prompt that an
  architect-role (or heavy-tier) subagent answers with JSON, which is merged back into the ledger.
- **Parallel tasks in isolated slots.** Ready tasks launch in parallel (up to `routing.executor.maxParallel`) into
  isolated worktree slots. Each slot is a separate git worktree, so tasks never write into your checkout or into each
  other.
- **Verified in the slot.** A task is checked inside its slot before it counts as done. A failing task is retried, with
  at most `routing.executor.maxAttempts` attempts per task.
- **Serial integration queue.** Verified tasks are merged one at a time through a serial queue into an integration
  branch. After each integration the integration checks run (`routing.executor.integrationChecks`), so the integration
  branch stays **always green**: a change that breaks the checks is not kept.
- **Phase suites with culprit bisection.** When a phase ends, its suite runs (`routing.executor.phaseSuite`). If the
  suite fails, the executor bisects the integrated tasks to find the culprit instead of blaming the whole phase.
- **QA rounds.** A phase gate runs automatic QA rounds up to `routing.executor.qaMaxRounds`; at the cap the human
  may accept or request another fix round. See [QA loop](#qa-loop).
- **Inbox.** When the executor needs a decision from you, it puts an item in the plan's inbox. `/plan inbox` lists the
  open items and `/plan answer <id> <text>` answers one; both use the running (or paused) plan of the session, and
  `--plan <planId>` names another plan.
- **Landing is fast-forward only.** A finished plan lands on your branch by fast-forward, never by a merge commit, and
  only when the checkout is clean (`routing.executor.land`: `ff-when-clean`, or `manual` to leave it to you).
- **One active plan per process.** A process runs one plan at a time. A plan is owned by the session that runs it; a
  plan owned by another session is refused, and `adopt` takes over a running or paused plan whose session is gone (a plan awaiting approval is never adopted: the user approves it in its own session, or it is compiled again).

## Safety model

**Slots isolate work; leases enforce ownership.** Each task gets a validated git worktree and its own `node_modules`
or `.venv`, never a dependency-directory junction into the owner's checkout. Slots reset to the integration head
between tasks; dependency-manifest drift triggers re-provisioning. Check preparation cleans other generated files
before verification/integration checks. Slot markers and the durable ledger live outside the worktrees.

Declared write footprints guide scheduling, but are not permission grants. Enforced leases protect actual writes,
including undeclared overlaps: in one checkout a foreign holder blocks writes and child reads, searches omit leased
files, and `router_run` annotates contamination (or refuses under `routing.leases.run: "refuse"`). Plugin verification
waits for conflicting leases until release or its deadline. Plan-task holders also conflict on the same repo-relative
path across linked worktrees of the repository; ordinary children in different checkouts do not. Root sessions take
no leases and are not refused reads, searches or runs, but cannot write a file a child holds in that checkout.
Plan-task leases normally survive child completion through integration; parking and retry cleanup release resources.
See [File leases](ROLES.md#file-leases) for the exact refusals and limits.

The integration queue preserves these invariants, including during batching, culprit reverts and recovery:

| Invariant | Guarantee |
|---|---|
| **I1** | The integration branch advances only by `merge --ff-only`, to a commit whose integration checks passed in a slot, reverts included. |
| **I2** | Published integration history changes only by new commits, never by rewriting published commits. |
| **I3** | One integration at a time per repository, protected by in-process and cross-process locking. |
| **I4** | Every integration step is journaled before and after its git writes; recovery reconciles those steps idempotently. |
| **I5** | The owner's checkout is touched only by landing, fast-forward only, and only when clean. |

The scheduler prioritizes the longest estimated remaining path (bottom level), then plan order. Physical slots are
claimed in that launch-priority order: the base lookup is awaited inside the queued claim, so a faster lookup cannot
let a lower-priority task take the slot first. Preparation can overlap after claims; priority is not a promise that
children finish in order. Provider capacity, leases, gates and available slots can still limit parallelism.

These are router guarantees, not an OS sandbox or a proof that tests are complete. Tools outside the lease hooks
(`shell`, `execute`) are not lease-covered; trusted package/check scripts run code. Do not edit slots, executor state
or the running plan by hand. A dirty or diverged owner branch is not force-reset to make landing succeed.

## Assembly and lifecycle

The tool and command are registered on **OpenCode v2 only**. The executor is assembled at plugin start only when:

- the project is a git repository;
- `routing.delegation: "roles"` was selected **at start** (switching from tiers later needs a restart);
- `routing.leases.mode: "enforce"` is set;
- a plan-task verifier is available and `enforcement.verify.require` is **not** `"never"`;
- the host supplies the lease registry and child runner, and no other executor owns the process.

Repository discovery runs only when the executor preconditions hold and the location is inside
`routing.workRoots` (when configured); an ineligible location does no executor discovery.

When assembly is unavailable, `/plan` and `router_plan` show
`the plan executor is not available: <reason>` rather than launching work. The exact reasons are:

| Reason | What to check |
|---|---|
| `routing.delegation must be roles at start` | Select roles mode and restart OpenCode. |
| `routing.leases.mode must be enforce` | Enable enforced file leases. |
| `no plan-task verifier` | The host must supply the plan-task verification engine. |
| `enforcement.verify.require is never` | Choose a verification requirement other than `never`. |
| `the location is outside routing.workRoots` | Start inside a configured work root, or adjust the global `routing.workRoots`. |
| `not a git repository` | Start in a git repository. |
| `the lease registry is not available` | The host's lease adapter is missing. |
| `the child runner is not available` | The host's child runner is missing. |
| `another plan executor already owns this process` | One executor already holds the process claim. |
| `repository discovery failed: <error>` | Git common-directory/path discovery failed; the error follows the prefix. |
| `assembly failed: <error>` | Assembly failed; the error follows the prefix. |

Before initialization the reason is `not initialized`; after disposal it is `disposed`. There is **one executor per
process**, across plugin instances, and one active plan at a time. The first plugin copy to assemble takes a
process-wide claim and that location owns the executor until it disposes. A copy refused only by the claim (a hot reload
starts the new copy before the old one has disposed) waits: when the holder's disposal releases the claim, the waiting
copy assembles its executor and starts it once (its recovery runs once), or, failing that, retries the first time one of
its plan tools is used. If several copies wait, one takes the claim and the others keep waiting; a copy disposed while
it waits never assembles. The handed-over executor is wired exactly like one assembled at start: the copy's adapter
adopts it through the same path, so it gets the plan state and manual-ready line, the executor instructions, the host
events of its plan children, the retry stop for those children and the launcher metrics. The adapter disposes it in the
same order as one assembled at start (runtime, then launcher, before the lease registry and the child runner go), which
releases the claim. An executor that finishes assembling after its copy began to dispose is not adopted: it is disposed
at once, and that also releases the claim.
An earlier configuration or repository-discovery reason is preserved when the child runner is also missing.

The executor home is **`<git common dir>\omr-executor`** (`EXECUTOR_HOME_DIRNAME = "omr-executor"`), shared by the
main checkout and linked worktrees. It holds ledgers, slot markers and locks; it is not a task work root. Repository
discovery creates nothing; state is created when a plan is opened. The slots root is separate: a configured
`routing.executor.slotsDir` is a **root**, and each plan uses **`<root>\<planId>`**, fixed in its draft at compile.
The default is **`<drive>:\.omr-slots\<planId>`** on the location's repository-toplevel drive, not the first listed
worktree's drive. Existing slot and integration worktrees do not block the slots-root allowance after a restart or
`/router-reload`; a root inside or above a non-slot worktree is still refused. A repository without a drive-letter
path has no computed default and must configure `slotsDir`. Slot pools open lazily per plan and do not reopen after
collection.

The v2 adapter starts the runtime; **recovery runs once at start**, not during assembly. Existing plans reconcile
their durable state before the first scheduling tick (see [Recovery](#recovery)). Automatic slot garbage collection
runs once a completed or aborted plan is **finished and settled**: no live child or unsettled launch handle and no open
integration entry. Aborted plans need no phase tags; a completed plan's passed phase is settled when it is tagged, its
tag gave up, or the tag exists elsewhere. A status change alone is not enough; paused plans keep their slots. Manual
`router_plan action=gc` works on a finished plan once nothing is live, without waiting for phase tags.

Disposal clears tool/command access first, then disposes the runtime (unsubscribes host events, clears runtime timers
and verifier observations, cancels running plan-task verifications, aborts launcher-owned children, settles work already
running, disposes each integration queue before closing its ledger writer). It then closes all slot pools, clears settle
timers and releases the process claim. The adapter disposes runtime then launcher before its background processor;
launcher disposal is idempotent.
A verification cut by disposal is re-verified at the next start, never treated as a pass.

Plan control belongs to the **root orchestrator**: a session at depth 0, with no parent. All state-changing and authority
actions — `compile`, `residue`, `approve`, `adopt`, `abort`, `purge`, `land`, `answer`, `pause`, `resume`, `add-tasks`,
`done` and `gc` — are root-only, with **no bound-plan-child exception**; a failed parent lookup refuses. The read-only
actions `status`, `ready`, `export` and `/plan inbox` (`status inbox=true`) allow a root session or an exactly bound
plan child reading **only its own plan**, named explicitly by `planId` (or the command's plan id/`--plan`). A child
bound to plan A cannot read plan B. The same rule guards `router_plan` and `/plan`; other actions remain root-only.
Approval still requires the human's decision under `approve: "ask"`; root access is not approval.

While a plan runs, the v2 adapter registers the executor instructions as a **per-turn state provider at order 61**,
immediately after the plan provider at order 60. They are not inserted into the cached system prompt, and no executor
provider is registered on v1. The instructions tell the orchestrator to report manual tasks, never edit slots or the
plan file, and never claim completion while the plan is running.

## `/plan` command

An existing user-defined `/plan` command is preserved: on v2 the router logs one conflict warning and leaves
`router_plan` available instead. On v1 that user command runs without an executor `/plan` notice.
The v2 adapter checks the host's command registry before registering the executor command; registry rebuilds do not
repeat the warning or replace the user's command.

`/plan` turns what you type into an instruction for the orchestrator, which then calls `router_plan` with exact
arguments. Input that does not parse prints the `/plan` help instead. Quote a path that holds spaces
(`"C:\My Plans\x.md"`); backslashes are literal. A quote needs its closing quote: `/plan run C:\Users\O'Brien\p.md`
prints the help (`unterminated quote`), so wrap such a path in the other quote (`"C:\Users\O'Brien\p.md"`). Only the
answer text of `/plan answer` is taken as typed, apostrophes included.

| Command | What it does | `router_plan` call |
|---|---|---|
| `/plan run <path> [--phases <ids>] [--done-before <id>]` | Compiles the plan file and shows its summary; it does not start the plan. `<path>` is absolute, or relative to the project directory. When the compiler asks for a residue step, the orchestrator dispatches the residue prompt to an architect and passes its JSON back (`action=residue`). The plan then waits for your approval (`/plan approve`), unless `approve` is `auto`. `--phases` limits the run to the listed phase ids, comma separated without spaces (`--phases 1.1,1.2`); `--done-before` treats every phase before the given id as done. | `action=compile` |
| `/plan approve <planId>` | Approves a compiled plan and starts it. With `approve: "ask"` (the default) a plan starts only this way or when you approve that plan after seeing its summary; your request to compile or run it is not approval, and the model never approves on its own. | `action=approve` |
| `/plan status [planId]` | Shows the plan board: status, tasks, inbox and metrics. Without an id: the running or paused plan of this session, else the plan the runtime finds for this session. | `action=status` |
| `/plan inbox [--plan <planId>]` | Shows only the open inbox items, and how to answer them. Without `--plan`: the running or paused plan of this session; when the session has none, the plan the runtime finds for this session (which may be a finished one, so its answer hint names `--plan`). `--plan=<planId>` and `--plan="<planId>"` work too. | `action=status inbox=true` |
| `/plan answer [--plan <planId>] <id> <text>` | Answers inbox item `<id>`. Without `--plan` the plan is the running or paused plan of this session; when the session runs none, the answer is refused and asks for `--plan`. | `action=answer` |
| `/plan pause <planId>` | No new task starts; running ones finish. | `action=pause` |
| `/plan resume <planId>` | Resumes a paused plan. | `action=resume` |
| `/plan abort <planId>` | Stops the plan. Work already integrated stays. | `action=abort` |
| `/plan land <planId>` | Requests landing of the integration branch. | `action=land` |
| `/plan adopt <planId>` | Takes over a running or paused plan whose owning session is gone. | `action=adopt` |

## `router_plan` tool

`router_plan` is the orchestrator's tool. Every call has an `action`; each action accepts only its own arguments
(anything else is refused) and answers in text, never with an error thrown. A plan owned by another session is refused.

| Action | Arguments | What it does |
|---|---|---|
| `compile` | `path`; optional `phases`, `doneBefore` | Compiles the plan file; a relative `path` is resolved against the project directory. Returns the summary, or the residue prompt to dispatch. With `routing.executor.approve = "auto"` a finished draft is approved at once; with `"ask"` the answer tells the model to stop: the plan is not approved, a request to compile or run it is not approval, and `approve` is called only when the user approves that plan after seeing the summary, or types `/plan approve <planId>`. |
| `residue` | `planId`, `text` | Merges the architect's JSON reply to the residue prompt; then the same approval rule as `compile` applies. |
| `approve` | `planId` | Approves a draft and starts running it. With `approve: "ask"` it is called only when the user approves this plan after seeing its summary, or types `/plan approve <planId>`; a request to compile or run the plan is not approval. |
| `status` | optional `planId`, `inbox` | Shows the board. `inbox=true` shows only the inbox section. Without `planId`: the running or paused plan of the calling session, else the plan the runtime finds for that session. |
| `ready` | `planId` | Lists the tasks that can launch now and the manual ones. |
| `add-tasks` | `planId`, `text` | Adds tasks to a plan (reopening finished ones when needed). |
| `answer` | `inboxId`, `text`; optional `planId` | Answers an inbox item. Without `planId` the plan is the running or paused plan of the calling session, never an older finished one; when the session runs none, the call is refused and asks for `planId`. |
| `done` | `planId`, `task` | Reports a manual (or preflight) task as done. |
| `pause` | `planId` | Pauses the plan: no new task starts, running ones finish. |
| `resume` | `planId` | Resumes a paused plan. |
| `abort` | `planId` | Aborts the plan; integrated work stays. |
| `land` | `planId` | Requests landing (fast-forward only). |
| `adopt` | `planId` | Takes over a running or paused plan whose session is gone; never a plan awaiting approval. |
| `gc` | none | Removes the slots of finished plans; reports the ones it did not remove. |
| `export` | `planId` | Returns the plan's ledger as text. |
| `purge` | `planId` | Removes a completed or aborted plan: slots, `omr/<planId>/` refs and ledger. |

## Task routing and write footprints

Tasks without a `[route ...]` line are annotated automatically. Before role selection, an ordinary task's
nonempty write footprint (from `Writes:` or inferred from phase ownership) takes precedence over an inferred
read-only class. The compiler uses an edit-capable class and includes `edit` in its needs, preserving its tier,
pin, risk and existing needs. A `Reads:` label cannot turn a declared writer into an explorer. Explorer and other
read-only role permissions are not widened.

An explicitly authored read-only route on a writer is not silently replaced: compilation refuses it with
`route-write-conflict`, the task id and source line. Choose an edit-capable class and `needs=edit`, or correct the
write declaration. Manual, preflight and QA tasks, and tasks with `Writes: none`, are excluded from this automatic
writer reconciliation.

## Verification of plan tasks

Plan tasks use the same dispatch verification engine as `router_verify`: the definition of done (DoD), scope and check
placements, change observation, deterministic checks, independent grader, timeouts and caveats. A task's
`[acceptance]` block supplies its DoD; a task without an `[acceptance]` block gets the inferred DoD from its text and
title, not an unchecked pass.

The **base is the slot reset commit** captured before launch; the **candidate is the slot HEAD** after the router
commits the child's changes. Before the gate, HEAD must be on the task branch and the base must be an ancestor of the
candidate. Checks see a fresh snapshot after `cleanForChecks`. The changed-file set is the union of observed files and
the committed diff from base to candidate (including renames), not just the files the child reports.

**Declared writers must produce a diff.** With a nonempty `footprint.writes`, no changes to commit means
`commit-failed` with detail `no changes`, whether `VERIFY` is `required`, `deferred` or `none`. The failure counts
toward `routing.executor.maxAttempts` and the circuit breaker; the normal retry path retries while attempts remain,
then parks exhausted work. A `DONE` claim or an already-implemented/idempotent explanation is not an exception.
This is the [owner's 2026-10-14 amendment to M39](qa/critical-path-execution/phase-3.1.md#owner-amendment-to-m39-2026-10-14).
With an empty write footprint, no-change success remains allowed: resources are released and phase gates are
reconciled, including dependent phases, so eligible QA can launch without another orchestrator turn.

**Plan-task verification is never deferred**, even with `VERIFY:deferred`: the required gate runs synchronously in
the slot before integration, with no pending handle or deferred footer. A mixed acceptance block is graded in two
passes: deterministic checks first, then, only after a check pass, the grader judges the criteria. Both must pass; a
check failure dispatches no grader.

The independent grader judges the **child's final text**, trimmed, scrubbed and capped at 32000 characters; if it is
empty or unavailable, it judges the router's fixed commit description instead. The producer is identified by its
**role agent**, not the task's routed fast/medium/heavy tier. A role name is unknown on the grader's tier ladder, so
it selects the top tier (`heavy` on the shipped ladder), never a cheaper grader based on the task's routed tier. The
grader is a child of the plan's orchestrator and runs in the verification scope. R11 lineage is skipped: each attempt
starts from a fresh slot reset rather than reusing an earlier attempt's verdict.

The gate deadlines are:

| Pass | Deadline in milliseconds |
|---|---|
| Checks | `max(gateBudgetMs, 600000)` (`PLAN_TASK_CHECKS_MIN_MS`: 600000, ten minutes) |
| Grader | `max(gateBudgetMs, graderTimeoutMs(tier, override) + 60000)` (`PLAN_TASK_GRADER_SLACK_MS`: 60000, one minute of slack) |

Here `gateBudgetMs` is the resolved verification gate budget and `override` is
`enforcement.verify.graderTimeoutMs`. A timeout aborts the gate and interrupts its graders. A transient unverifiable
result (a retryable verdict, or `grader dispatch failed:`) gets at most **two internal re-runs**
(`PLAN_TASK_TRANSIENT_RERUNS`: 2), with **30 s then 60 s** backoff (`PLAN_TASK_RERUN_BACKOFF_MS`: `[30000, 60000]`).
This allowance is shared across both passes of a mixed block; a real fail is not internally re-run. Once returned to
the runtime, an **unverifiable result costs an attempt and is a breaker sample**, just like a failed verification.
Non-strict acceptance of an unverifiable dispatch does not turn a plan task into a pass.

Restart fallbacks **fail closed**. Without the pre-launch observation, the fallback accepts only a readable reset
commit with no child commits (the router's own commit, identified by its attempt trailer, may sit directly on that
base). Extra commits or a planned verification perimeter make the result unverifiable: missing observations of other
repositories are not guessed. An unreadable orchestrator, branch, diff or fresh snapshot likewise cannot pass.

During a task's gate, its own lease holders — the child and `plan:<planId>:<taskId>` — are exempt from the `testsPass`
lease wait **for that slot tree only**. Other holders, and all holders of any other tree, are still waited for; this
self-exemption is released when the pass ends.

## Configuration

The keys live under `routing.executor` in `tiers.json` or an override file. Their types, defaults and ranges are in the
[Configuration reference](CONFIG_REFERENCE.md); this page names each one. A value outside its range, of the wrong type
or not in the listed values logs one warning, and the default applies.

| Key | Default | Meaning |
|---|---|---|
| `routing.executor.maxParallel` | `4` | Tasks that run at once. |
| `routing.executor.slotsDir` | `null` | Root for slot worktrees; each plan uses `<root>\<planId>`. `null` is computed as `<repo drive>:\.omr-slots\<planId>`. Global override only. |
| `routing.executor.approve` | `"ask"` | `ask`: a compiled plan starts only after you approve it, by `/plan approve <planId>` or by approving that plan after seeing its summary; the model never approves on its own. `auto` starts the plan on its own; only the bundled `tiers.json` or the global override can choose it, a project-local override can only set `ask` (see [Trust](#trust)). |
| `routing.executor.crossPhase` | `"gate"` | `gate`: a phase starts after the previous phase's gate passed; `inferred`: later tasks may start once their own dependencies are met. |
| `routing.executor.land` | `"ff-when-clean"` | Fast-forward when the checkout is clean, or `manual`. |
| `routing.executor.batchMax` | `4` | Most tasks dispatched in one batch. |
| `routing.executor.maxAttempts` | `3` | Counted attempts per task before exhausted work is parked. |
| `routing.executor.qaMaxRounds` | `3` | Automatic QA-round cap of a phase gate; further fixes need an inbox answer. |
| `routing.executor.integrationChecks` | `"auto"` | Extra checks run after each integration. The auto-detected checks always run (the `typecheck` and `test` scripts of `package.json`, and pytest when the project configures it); a list of commands is added to them, it never replaces them. `"auto"` adds nothing. Global override only. |
| `routing.executor.phaseSuite` | `"auto"` | Suite run at a phase gate (`off` skips it). Global override only. |
| `routing.executor.provision` | `"auto"` | How a slot worktree is provisioned. Global override only. |
| `routing.executor.python` | `"auto"` | The Python interpreter the executor's helpers use. Global override only. |
| `routing.executor.sharedContextChars` | `12000` | Characters of shared plan context given to each task. |
| `routing.executor.capacityCooldownMs` | `120000` | Cooldown of a model after a capacity error. |
| `routing.executor.capacityPauseMs` | `900000` | How long the executor pauses when every model is out of capacity. |
| `routing.executor.wakeDebounceMs` | `5000` | Debounce of the executor's wake-ups. |
| `routing.executor.circuitBreaker.failureRatio` | `0.4` | Failure ratio above which the circuit breaker opens, once `minAttempts` attempts were made (strictly `F > ratio·N`). |
| `routing.executor.circuitBreaker.minAttempts` | `5` | Attempts needed before the failure ratio counts. |
| `routing.executor.circuitBreaker.consecutiveFailures` | `3` | Consecutive failures that open the circuit breaker on their own. |

The resolved plan slots directory is checked when the plan is compiled and approved: an absolute drive path, on the
repository's drive, neither inside nor an ancestor of the repository. A configured `slotsDir` is a root: the executor
appends `<planId>`, so plans never share the same plan directory. Leave `slotsDir` at `null` to use
`<repo drive>:\.omr-slots\<planId>`.

## Trust

Five keys decide where the executor writes and which commands, argument lists and interpreter it runs in your checkout:
`routing.executor.slotsDir`, `routing.executor.integrationChecks`, `routing.executor.phaseSuite`,
`routing.executor.provision` and `routing.executor.python`. They are honoured from the bundled `tiers.json` and the
**global** override only. In a project-local override they are dropped with a one-line notice
(`ignoring routing.executor.slotsDir from <path>: only the global override may set it`), because a repository you open
must not be able to make the plugin run its commands. The other `routing.executor.*` keys tune limits and modes and may
be set in either file, but a project-local override may only tighten them (amendment A-4.1-2): `approve` only to `ask`,
`land` only to `manual`, `crossPhase` only to `gate`, and the numeric budgets and circuit-breaker values only lower; a
looser value from a project file does not apply. The rule is spelled out in
[Trust: which file may set what](CONFIG_REFERENCE.md#trust-which-file-may-set-what).

## Unattended operation

The executor keeps independent work moving when one task needs help. `ESCALATE:` or an ambiguous child result parks
that task with a blocking question; exhausted retries or repeatedly unparsable QA output park it with a blocking
failure. Parking releases its slot and file leases. Pending dependents become blocked (directly `dep-parked`,
transitively `dep-blocked`); unrelated tasks may still run. Answering the task's park item makes it ready again and
passes the answer into its next attempt's context. Dependents become ready only once their dependency edges are
satisfied, not merely because someone answered a question.

Use `/plan inbox` to see open items and `/plan answer <id> <text>` to answer them (or add `--plan <planId>`). Inbox ids
have a prefix and a plan-wide increasing number, for example `Q-1`:

| Kind | Prefix | Meaning |
|---|---|---|
| Question | `Q-` | A decision or clarification is needed. |
| Failure | `F-` | A task or executor operation needs intervention. |
| Usage limit | `U-` | Capacity/usage-limit intervention. |
| Landing | `L-` | Landing needs attention. |
| Flaky | `K-` | A flaky check, excluded from breaker samples. |
| QA cap | `R-` | QA hit its cap, or a finding was explicitly deferred. |
| Breaker | `B-` | A phase's circuit breaker opened. |

Raised inbox text is bounded to **4000 characters plus an ellipsis** when truncated. An identical open item (same
kind, task and bounded text) is not raised twice. The orchestrator answers only with the human's answer or with text
the plan already states; it must not invent approval or a decision.

Only `succeeded` and `failed` attempts consume `maxAttempts` (default **3**, integer range **1–6**). Capacity, lost
and interrupted outcomes do not. A fail or unverifiable verification verdict is a failure sample, as is a systemic
post-child commit failure (including missing git identity or no changes when writes were declared). Flaky attempts
are excluded from the breaker. Samples are rebuilt from the ledger, per phase, using only attempts ended after its
newest breaker item; answering that item does not reopen the old sample window.

The breaker has two independent rules (X11), where `N` is the sample count, `F` the number of failures and `C` the
trailing consecutive failures:

- Ratio: once `N ≥ minAttempts`, open only when **`F > ratio·N`**, not at equality (a floating-point epsilon protects
  the equality boundary).
- Consecutive: open when **`C ≥ n`**, where `n = consecutiveFailures`, regardless of `minAttempts`.

Defaults are `failureRatio = 0.4` (range **0.1–1**), `minAttempts = 5` and `consecutiveFailures = 3` (both integer
ranges **1–50**). Opening pauses that phase and creates one critical `B-` item; other independent phases are not
paused by that item. Answering it unpauses the phase only when no other open critical item belongs to that phase.

## QA loop

A phase QA task returns a JSON report. The parser uses the **last fenced `json` block** of the final answer, or the
whole answer if none exists. The top-level object has only `findings`; each finding has exactly `id`, `severity`,
`files`, `problem` and `fix` (no additional fields):

```json
{"findings":[{"id":"QA-1","severity":"major","files":["src/example.ts"],"problem":"Describe the defect","fix":"Describe the correction"}]}
```

An empty `findings` array is clean. Ids are 1–64 characters, start with a letter or digit, and otherwise contain only
letters, digits, `.`, `_` or `-`. `problem` is non-empty, `fix` may be empty, and `files` is an array of non-empty
strings (the array may be empty). Severities are `blocking`, `critical`, `major`, `minor` and `nit`.

`qaMaxRounds` defaults to **3** (integer range **1–8**). With another round available, rounds 1–2 fix every finding;
from round 3 only `blocking`, `critical` and `major` are fixed. Minor/nit findings then become closed informational
`R-` items with answer `deferred`. At the configured cap, minor/nit findings alone pass and are deferred; any blocking
severity instead pauses the phase with a critical `R-` item. `/plan answer <id> accept` accepts and records the
remaining findings as deferred, passing the gate; `fix` creates another fix/re-review round. Human-authorised `fix`
can extend beyond the configured cap, but round **999** offers only `accept`.

Findings with overlapping normalised repository-relative file paths are grouped into one fix task with the union of
those paths as its Writes. Absolute paths, empty paths and `..` segments are not usable file targets. Findings without
a usable file form a separate file-less group, which runs after the file-backed fixes and must request any lease it
needs. A round has at most **999** fix groups (overflow merges into the last file-backed group). Fix ids are
`<phaseId>.FIX<round>-<index>`; the next review is `<phaseId>.QA<round+1>` and depends on all fixes. A phase's
`<phaseId>.FIX` template supplies the fix route, verification and acceptance when present; otherwise fixes use
`implementer`, pinned `medium`, with required verification. Re-reviews retain the original review instructions and
previous findings without recursively duplicating prior review text.

The first unparsable QA result fails the attempt and counts toward retries; the second parks the task with a blocking
`F-` item. It never silently passes the gate.

## Recovery

At start the recovery service scans running and paused plans for this repository, then the runtime reconciles their
durable ledgers before scheduling. A plan from another repository is passive and read-only: this process does not
recover, resume or tick it, acquire its writer lock, change its writer epoch or rotate its journal. Status remains
available; mutate or adopt it from a session in its own repository. A live writer lock is not taken over.
When several plans could run, a running plan is chosen before a
paused one, then by plan id; the others stay passive rather than launching a second plan.

Recovery uses evidence, not a guess that an old child stopped. A recorded child must carry the matching launch header
(plan, task, attempt and nonce), and a slot marker must name that plan and task. A child is finished only when its
context ends with an explicit terminal `idle` entry **with an outcome**; `idle` alone is not completion. A live child
is adopted and rebound to its role, grant and slot work root. A missing or mismatching child is lost; orphans still
running for this plan are interrupted. A dispatched attempt with no child is requeued immediately.

A `running` child whose launching process is provably dead on the same host, and whose stored history shows no tool
call in flight, is requeued at once; a child stopped inside a tool, whose processes (for example a `router_run` test) can
outlive the host, gets the **60 s** liveness probation like any other unknown child.
Unknown liveness enters a **60 s** probation window, polled every **10 s**. A host event or changed context proves
life; an explicit terminal entry is processed as a result. A silent child past the deadline is interrupted before its
slot is reset and its attempt requeued as lost. If interruption fails **5 tries**, one blocking failure item is raised
and the task keeps waiting; the executor does not reset a slot a child might still be writing.

Completed or verifying tasks are reverified; verified tasks are re-enqueued; an integrating task resumes the serial
integration queue. The router's attempt trailer prevents recovery from making a duplicate commit. Gates, capacity
state, leases, blocked dependencies and missed breaker failures are rebuilt from durable state before the first tick.
Recovered verification/completion pipelines run outside that barrier and wait for any current router-tool context of the
owning root, requesting the launch gate's wake (awaiting the first router call, or no context) even with no ready producer.
The verification fallback after a restart remains [fail closed](#verification-of-plan-tasks), so a lost observation
can cost a counted attempt rather than grant an unchecked pass.

`/plan adopt <planId>` explicitly transfers a running or paused plan when its owning session is gone. It never adopts
a plan awaiting approval. Recovery and adoption do not turn a compile/run request into approval.

## Windows notes

- **Same drive, short root.** Keep slots on the repository's drive, outside every non-slot worktree; the default
  `<repo drive>:\.omr-slots\<planId>` is intentionally short. Configure a different root only in the global override.
  Moving slots to another drive is refused, not a way around checkout isolation.
- **pnpm store.** Each slot has its own `node_modules`; pnpm's content-addressed store may be shared. For efficient
  hard links keep that store on the slots' drive. Check `pnpm store path` in the intended environment and configure
  pnpm there if needed; the executor does not relocate its store. Auto provisioning uses a frozen lockfile and
  `--prefer-offline`, not a promise of offline installation: warm the store or provide registry access beforehand.
- **Python and uv.** Use a real Python installation (`py -3` by default on Windows, or global `routing.executor.python`),
  not the Microsoft Store stub. Installs target each slot's `.venv`. For uv on Windows, if `uv cache dir` reports a
  different drive and the step environment has no `UV_CACHE_DIR`, provisioning sets `UV_CACHE_DIR` to
  `<slots drive>:\.omr-cache\uv`; an existing value is preserved. Make that drive writable and leave room for caches.
- **Long paths and open handles.** Executor git commands set `core.longpaths=true`, but task-path expansion checks
  the slot's own `core.longpaths`: a rewritten path over 260 characters is refused when it is off. Prefer short
  repository/slot paths and enable long-path support in the tools you use; git's flag does not fix every package tool.
  For `EBUSY`/access-denied cleanup failures, close terminals, watchers and processes holding slot files (and check
  antivirus interference). Never delete a slot that a live or probationary child may still write.

## Troubleshooting

Start with `/plan status <planId>` and `/plan inbox --plan <planId>`, then `router_plan action=export planId=<planId>`
for durable evidence. Do not repair the journal or markers by hand.

| Symptom | Next step |
|---|---|
| Executor unavailable | Use the exact reason in [Assembly and lifecycle](#assembly-and-lifecycle); roles mode must be selected at start. |
| `awaiting-approval` or `awaiting-residue` | Review and approve that plan, or have the orchestrator merge the architect's residue JSON. Neither status is a running plan. |
| Ready work does not launch | Inspect paused phases, dependencies, lease holders, provider capacity and inbox items. `router_plan action=ready planId=<planId>` is a readiness view, not proof that a physical slot is available. |
| Stale launch-context notice | Make a root `router_plan action=status` call in the owning session to supply a fresh tool context. Repeated status polling or sleeps are not scheduling. |
| `E_PROVISION` | Read the manager/slot and error tail. Commit the correct root manifest and lockfile, install the manager outside the work root on absolute PATH entries, or set a trusted global provision/interpreter override. Do not share another checkout's dependencies. |
| Lease refusal / contaminated run | Wait for the named holder or answer the parked task's inbox item once the conflict is resolved; repeating the same tool call does not release a lease. |
| Failed or unverifiable task | Inspect the verification/commit failure and attempt count; fix the cause before exhausting retries or answering a breaker. Missing git identity and a declared writer with no diff are failures, not successful no-ops. |
| Quiet `running` child after restart | D16 uses launcher liveness plus stored tool history: a provably dead same-host launcher with no tool in flight requeues immediately. An open tool call keeps the 60 s probation because its process tree may survive; do not reset its slot yourself. |
| Recovery or re-verification cannot progress | Supply a fresh context with a root `router_plan action=status` call in the owning session; recovered verification waits without spending grader retries. If the owning session is gone, the owner runs `router_plan action=adopt` from their session so the plan gets a live root. If it still cannot progress, preserve the export and host error evidence; never force a task to passed. |
| Landing or GC refused | Clean/resolve the owner's checkout without discarding work; landing is fast-forward only. GC requires a finished, non-live plan; paused plans deliberately retain slots. |

## Metrics and observations

`/plan status` shows launch/wake counts and accumulated `idle-with-ready` milliseconds for the attached runtime; it is
not a historical performance report. Export the ledger for durable `metric` events: `launch`, `wake`, `capacity`,
`context-age`, `counter` and `idle-with-ready`. Capacity reductions/pauses explain throttling; a context-age notice
explains why a fresh root tool call is needed. Dispatch durations (`timings.jsonl`) and orchestrator cache tokens
(`turns.jsonl`) live in the outcome store; `npm run routing:stats` in a clone summarizes them. Scope by run/session and
time, since the default store may also contain other sessions. No timing row is proof of a verification pass.

**Opt-in v2 observations** add diagnostic JSONL, not a routing setting. Before starting OpenCode v2, set
`MODEL_ROUTER_V2_OBSERVATIONS` to an **existing, writable directory**. The adapter writes `<pid>-<file-id>.jsonl` per
setup; it does not create the directory, and absent/unopenable paths leave observations off. v1 never activates it.
Collect every file after graceful adapter disposal; keep streams separate. A usable stream has contiguous `seq`
from 1, a final `kind: "end"` seal and `dropped=failed=0`. A crash without a seal, gaps, overflow or writer faults are
**unknown evidence, not a pass**. Streams are capped at 50,000 events / 16 MiB; large metric-only ledger snapshots can
exhaust that cap. Native arguments use stream-local HMAC fingerprints, not raw prompt/path/credential values.
Scheduler, completion-effect and service rows allow offline correlation; effect rows record invocations, not proof
that the invoked operation succeeded.

### Reading G8

The throughput smoke reconstructs and records these values; they are **not fields on the status board**:

- `bound = 1.3 × max(CP_eff, W_auth/p, ΣI_service)`, with authored work `W_auth`, configured parallelism `p` and
  `CP_eff` from the **pre-run dependency graph**, including phase gates and attributable intrinsic verification,
  integration and phase-suite service. Raw CP/ΣI remain diagnostics. Queueing, resource waits, launch/preparation,
  cold initialization, idle and driver holds never enlarge a denominator term. Shared-batch service is assigned in
  full to each member (an antichain) but counted once in serial integration's service union.
- **`g8Ratio = makespan/bound`**, and **`g8BoundMet = makespan <= bound`**: the bound is met iff **`g8Ratio <= 1.0`**.
  A ratio above 1 means the measured bound was missed, not that another 1.3 multiplier is allowed. Under owner amendment
  **A-6.1-2**, this bound is measured and disclosed, **not a Phase 6.1 acceptance gate**. `service-unattributed` grading
  is recognized evidence at zero intrinsic credit, so the computed bound is conservative; missing/malformed service
  evidence still fails closed.
- **Idle ceiling: 10,000 ms per predicate-A episode**, still asserted independently of the makespan metric. Predicate A
  means a running plan, an idle orchestrator and at least one durably ready automatic task with satisfied
  dependencies/phase admission and observed provider capacity, with no successful launch inside the episode. It does
  not require an already prepared physical slot; slot waits do not shorten the episode. Ledger idle
  fragments and the status total alone cannot prove completeness: use independent scheduler/slot observations and
  correlate `idle-close` creation with the ledger. Missing facts remain unknown, not assumed eligible or idle-free.

The [Phase 6.1 report](qa/critical-path-execution/phase-6.1.md) records evidence and limitations. Under **A-6.1-3**, the
remaining `unmeasured` subcases need a real-use soak, not new synthetic smoke cases: at least **5 working days** with
observations enabled on real plans, analysed offline by `scripts/soak-analyze.mjs`. Each observable criterion
(G1, G2, G6, G8, G9) needs at least **3 observed occurrences and zero violations**. Unobserved criteria (expected G3,
G11) are disclosed gaps in the Phase 6.2 PR alongside G13 and G8's bound; G5 stays with 2.3 and G12's full matrix with
6.2. The soak is also executor dogfood evidence toward G13, which remains unmet until the owner decides. The owner
may change the soak criteria; absence of evidence is never a pass.

## Owner checklist for the next real plan

- [ ] Start in the intended git repository on OpenCode v2 with roles selected at start, enforced leases and an available
  verifier; review global command/provision overrides. Keep `approve: "ask"` unless unattended approval is intentional.
- [ ] Commit root manifests/lockfiles, check tools and cache access, choose a short same-drive slots root, and establish
  clean baseline checks. Do not depend on untracked inputs or another checkout's `node_modules`/`.venv`.
- [ ] Give tasks stable ids, explicit dependencies, accurate `Writes:` and acceptance blocks; distinguish manual,
  preflight and QA work. Use edit-capable routes for writers and keep independent writes disjoint where possible.
- [ ] Enable observations in an existing directory before startup, record the host/build/config and plan scope, and
  preserve all streams for the real-use soak. Arrange graceful collection; truncated evidence cannot establish a pass.
- [ ] Run `/plan run <path>`; review counts, residue, dependencies, manual tasks and estimates before approving that
  specific plan. Let the executor own the plan file, task slots and ledger while it runs.
- [ ] Watch status/inbox at decision points, supply actual human answers, report manual work via `action=done`, and
  refresh context on a stale-context wake. Do not poll/sleep, invent approval or bypass a failed verification.
- [ ] After completion, export the ledger and collect observations/metrics, inspect the integration result and request
  landing only into a clean checkout. Resolve dirty/diverged branches without force-resetting them; collect slots only
  once children and integration work have settled.
- [ ] Record outcomes, idle episodes, G8 bound/ratio and evidence gaps separately from pass claims. For the soak, retain
  the working-day window and occurrence/violation counts; carry unmet G13 and unobserved criteria to owner review.
