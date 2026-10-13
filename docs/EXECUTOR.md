# Plan executor

> **Status: groundwork, not active yet.** The plan executor is OpenCode **v2 only**. The `router_plan` tool, the `/plan`
> command and the executor instructions exist in the code, but they are **not registered** yet; a later release wires
> them. Until then neither the tool nor the command is visible to the model or to the user. On OpenCode v1 the
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
- **QA rounds.** A phase gate can run QA rounds (at most `routing.executor.qaMaxRounds`). See [QA loop](#qa-loop).
- **Inbox.** When the executor needs a decision from you, it puts an item in the plan's inbox. `/plan inbox` lists the
  open items and `/plan answer <id> <text>` answers one; both use the running (or paused) plan of the session, and
  `--plan <planId>` names another plan.
- **Landing is fast-forward only.** A finished plan lands on your branch by fast-forward, never by a merge commit, and
  only when the checkout is clean (`routing.executor.land`: `ff-when-clean`, or `manual` to leave it to you).
- **One active plan per process.** A process runs one plan at a time. A plan is owned by the session that runs it; a
  plan owned by another session is refused, and `adopt` takes over a plan whose session is gone.

## `/plan` command

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
| `/plan adopt <planId>` | Takes over a plan whose owning session is gone. | `action=adopt` |

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
| `adopt` | `planId` | Takes over a plan whose session is gone. |
| `gc` | none | Removes the slots of finished plans; reports the ones it did not remove. |
| `export` | `planId` | Returns the plan's ledger as text. |
| `purge` | `planId` | Removes a completed or aborted plan: slots, `omr/<planId>/` refs and ledger. |

## Configuration

The keys live under `routing.executor` in `tiers.json` or an override file. Their types, defaults and ranges are in the
[Configuration reference](CONFIG_REFERENCE.md); this page names each one. A value outside its range, of the wrong type
or not in the listed values logs one warning, and the default applies.

| Key | Default | Meaning |
|---|---|---|
| `routing.executor.maxParallel` | `4` | Tasks that run at once. |
| `routing.executor.slotsDir` | `null` | Where the slot worktrees live; `null` is computed as `<repo drive>:\.omr-slots\<planId>`. A configured path is used verbatim and shared by every plan (see below). Global override only. |
| `routing.executor.approve` | `"ask"` | `ask`: a compiled plan starts only after you approve it, by `/plan approve <planId>` or by approving that plan after seeing its summary; the model never approves on its own. `auto` starts the plan on its own; only the bundled `tiers.json` or the global override can choose it, a project-local override can only set `ask` (see [Trust](#trust)). |
| `routing.executor.crossPhase` | `"gate"` | `gate`: a phase starts after the previous phase's gate passed; `inferred`: later tasks may start once their own dependencies are met. |
| `routing.executor.land` | `"ff-when-clean"` | Fast-forward when the checkout is clean, or `manual`. |
| `routing.executor.batchMax` | `4` | Most tasks dispatched in one batch. |
| `routing.executor.maxAttempts` | `3` | Attempts per task before it is marked failed. |
| `routing.executor.qaMaxRounds` | `3` | Most QA rounds of a phase gate. |
| `routing.executor.integrationChecks` | `"auto"` | Extra checks run after each integration. The auto-detected checks always run (the `typecheck` and `test` scripts of `package.json`, and pytest when the project configures it); a list of commands is added to them, it never replaces them. `"auto"` adds nothing. Global override only. |
| `routing.executor.phaseSuite` | `"auto"` | Suite run at a phase gate (`off` skips it). Global override only. |
| `routing.executor.provision` | `"auto"` | How a slot worktree is provisioned. Global override only. |
| `routing.executor.python` | `"auto"` | The Python interpreter the executor's helpers use. Global override only. |
| `routing.executor.sharedContextChars` | `12000` | Characters of shared plan context given to each task. |
| `routing.executor.capacityCooldownMs` | `120000` | Cooldown of a model after a capacity error. |
| `routing.executor.capacityPauseMs` | `900000` | How long the executor pauses when every model is out of capacity. |
| `routing.executor.wakeDebounceMs` | `5000` | Debounce of the executor's wake-ups. |
| `routing.executor.circuitBreaker.failureRatio` | `0.4` | Failure ratio from which the circuit breaker opens, once `minAttempts` attempts were made. |
| `routing.executor.circuitBreaker.minAttempts` | `5` | Attempts needed before the failure ratio counts. |
| `routing.executor.circuitBreaker.consecutiveFailures` | `3` | Consecutive failures that open the circuit breaker on their own. |

`slotsDir` is checked against the repository when a plan is approved: an absolute drive path, on the repository's drive,
neither inside nor an ancestor of the repository. A configured `slotsDir` is used verbatim: no `<planId>` is appended,
so every plan uses the same directory. A second plan is refused there while the slot markers of an earlier plan still
exist in it: plans that share a configured `slotsDir` run one after another, each once the earlier plan's slots are
cleaned up. Leave `slotsDir` at `null` to give each plan its own directory.

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

_Placeholder._ The text for this section arrives with Phase 4.2/5.1 (handoff 4.2.6.a).

## QA loop

_Placeholder._ The text for this section arrives with Phase 4.2/5.1 (handoff 4.2.6.a).

## Recovery

_Placeholder._ The text for this section arrives with Phase 4.2/5.1 (handoff 4.2.6.a).
