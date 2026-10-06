# Implementation Plan — Cost-Aware Routing Engine (#74): typed task decisions, outcome-calibrated tiers, session-aware effort bumps

> **Status:** Ready for execution (revision 2, 2026-10-06: owner decisions on native roles, dogfooding checkpoints and self-measurement; see §7)
> **Handover:** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md` (ships with this plan as the kickoff prompt; rewritten at every checkpoint and before every restart request; the resume point after every host restart)
> **Owner:** Marco Jardim
> **Executor:** one high-capability LLM orchestrator, start to finish, delegating per the `[tier:X]` annotations below.
> **Base:** `origin/master` at `v2.2.0` (`968bf0f`). Target release: **`2.3.0`**.
> **Host:** OpenCode **v2 2.0.22** (`anomalyco/opencode` tag `v2.0.22` = `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`; `@opencode/plugin` 2.0.22, already the typecheck target in `D:\git\opencode-model-router\package.json:55`). OpenCode v1 is **not** changed by this plan (see D1).
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) — this feature; [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) — the TypeSafe/Jev suggestion that inspired it.
> **Scope:** the router picks `(agent, model#variant, retry policy, verification depth)` per dispatch from an expected-cost formula fed by (1) typed task facts decided in code and (2) a scoreboard of verified outcomes; failed verifications retry on the **same child session** with a higher variant before paying for a bigger model; a cost doctor flags waste outside the router; all behind `routing.engine`, default `static` (= today).
> **Decision record:** `D:\git\opencode-model-router\docs\adr\0005-cost-aware-routing-engine.md` (written in Phase 3.1).
> **QA reports:** `D:\git\opencode-model-router\docs\qa\cost-aware-routing\`.

---

## 0. Execution directives (read first — these override defaults)

### 0.1 Run the whole plan without stopping

Execute Phase 0.P → Wave 1 → Wave 2 → Wave 3 continuously, iterating phase by phase and wave by wave, **without pausing for confirmation**. Stop and ask the human **only** when one of these occurs:

1. **Ambiguity that only the human can resolve** — two or more valid readings of a requirement whose outcomes differ materially, and neither this plan (§1.5 decisions included) nor the code settles it.
2. **Critical problem** — a security regression (a dispatch that escapes the depth guard, a classifier backend that leaks a secret or sends more of the prompt than `maxStateChars`), data loss risk (a git ref, a user file, the main checkout, the user's `tiers.json` or `opencode.json`), or a published artifact that is broken.
3. **Blocking problem** — an assumption this plan depends on is disproven by a pre-flight spike and no alternative written in this plan applies, or the same failure persists after the recovery rule in §0.8.
4. **A dogfood checkpoint needs a host restart** (§0.11): the synced plugin code is not live in the executing session and no in-process reload is available. This stop is expected, short, and scripted: write the handover, ask the human (in Portuguese) to restart OpenCode v2, and resume from the handover when told to.

Everything else — test failures, QA findings, type errors, merge conflicts, refactors needed to land a phase — is work to be done, not a reason to stop. Status messages to the human at checkpoints (§0.11) are not stops.

### 0.2 Definitive solutions only

A high-capability agent executes this plan end to end. **Do not** ship stubs, TODO placeholders, feature flags that hide half-built code, "phase 1 of N" partial behaviour, or temporary shims. Every phase delivers the **final** implementation of its sub-objective:

- Wave 1 builds complete, final components (config surface, classifier, outcome store and cost accounting, decision kernel, ladder algebra). Nothing in Wave 1 is replaced later; Wave 2 only consumes it.
- Wave 2 wires the components into the v2 adapter and the plugin. When Wave 2 closes, #74 is fully solved in code on OpenCode v2.
- Wave 3 documents, proves end to end, reviews globally and releases. It adds no behaviour.

The four `routing.engine` modes are **product features**, not delivery stages: all four ship complete in this release. A phase that finds a component from an earlier phase wrong **fixes** it (in the owner's files, per §0.6), never works around it.

### 0.3 Commit often

- Commit at the end of **every subtask** that leaves the tree green (typecheck + the tests the subtask touches). Never commit a red tree.
- Conventional commits, matching the repo: `feat(routing): …`, `feat(escalate): …`, `feat(compat): …`, `fix(routing): …`, `test(routing): …`, `docs(routing): …`, `chore(release): …`. Reference the issue in the body (`Refs #74`).
- Push the phase branch after every commit, so no work exists only locally.
- QA fixes are their own commits: `fix(<scope>): address QA-<phase>-<n> <summary>`.
- **No AI attribution, ever:** no `Co-Authored-By` trailer naming a model or vendor, and no "Generated with …" line, in any commit or PR. Tell every delegate the same.

### 0.4 Paths

Every file reference in dispatches, commits, QA reports and code comments uses the **full path**. Paths in this plan are written against the main checkout root `D:\git\opencode-model-router`. Inside a phase worktree, the root is replaced by that worktree's root (for example `D:\git\opencode-model-router\src\routing\engine\kernel.ts` → `D:\git\omr-car-p14\src\routing\engine\kernel.ts`). The session working directory `D:\git\Claude-model-router` resolves to the same repository (`git rev-parse --show-toplevel` → `D:\git\opencode-model-router`). Always use the `D:\git\opencode-model-router` form.

### 0.5 Model-router annotations

Every task carries a routing tag that the router honours (`[tier:X]` → delegate to X):

| Tag | Use for |
|---|---|
| `[tier:fast]` | Context gathering, pre-flight checks, spikes that only observe, running tests/CI and reporting results |
| `[tier:medium]` | Implementation, test writing, docs, applying QA fixes, merges with mechanical conflicts |
| `[tier:heavy]` | Reasoning-dense design (decision kernel, ladder algebra, hook ordering, cost-unit semantics), and **every QA review** |

**QA is always a `[tier:heavy]` task. Always apply this rule.** After **every** phase (0.P and 3.4 included), and once for the whole change set, delegate to heavy QA an **adversarial** review of the work done. The reviewer's job is to break the work, not to confirm it. The QA reviewer is never the same dispatch that produced the work it reviews.

Heavy dispatches follow the router protocol: gather context with `[tier:fast]` first and paste it into the heavy prompt, because heavy reasons over the context it is given. QA dispatches use `CAP:none` **with** a `reason:` line in the same dispatch (an adversarial review must read every changed file). Without the `reason:` line the router silently ignores `CAP:none`.

**Dispatch acceptance blocks.** The installed plugin scopes `testsPass` to affected tests, so `check: testsPass` is safe in dispatches. Always set `cwd:` to the phase worktree:

```
[acceptance]
cwd: D:\git\omr-car-p14
check: testsPass
criteria: <plain-language success condition from the task>
deliverable: D:\git\omr-car-p14\src\routing\engine\kernel.ts
[/acceptance]
```

- Use `VERIFY:required` on any dispatch whose output a later task in the same phase builds on (types, exported APIs, the module a test file imports). Leaf tasks (a test file nobody imports, a doc section) use the default `VERIFY:deferred`.
- Before a phase's QA review, call `router_verify` with `pending: true`. Every handle must come back `pass`. A `fail` is fixed before QA starts; an `unverifiable` is re-checked with the scoped command `npx vitest run --maxWorkers=2 <files>` and its result is recorded in the phase QA report.

### 0.6 Parallelism and file safety

Maximise parallel work, but orchestrate it so **no file is ever written by two agents at once, and no agent reads a file that another agent is editing.**

1. **Ownership map.** §2 gives every file exactly one owning phase per wave. A task may write only the files in its phase's write-set. Files not listed are read-only for everyone.
2. **Isolation by worktree.** Each concurrently running phase works in its own git worktree, on its own branch, created from the integration branch `car/main` (phase ids without the dot, `1.4` → `p14`): `git -C D:\git\opencode-model-router worktree add -b car/p14 D:\git\omr-car-p14 car/main`. An agent reads and writes only inside its own worktree, and never opens another phase's worktree.
3. **Reads of in-flight files.** When a wave starts, the orchestrator tags the tip of `car/main` as `car/wave-<n>-base`. A file owned by another in-flight phase is read **only** from that tag (`git -C D:\git\omr-car-p14 show car/wave-1-base:src/router/config.ts`), which nobody moves. A phase with a dependency edge on a phase merged during the wave rebases onto `car/main` after that merge and then reads the merged files from its own worktree.
4. **Serial integration.** Only the orchestrator merges phase branches into `car/main`, in its own worktree `D:\git\omr-car-main`, one at a time, and only after the phase's QA is clean. After each merge it runs `npm run typecheck` and the capped full suite (rule 9). Conflicts are resolved by the orchestrator, never by two agents.
5. **Cross-phase dependencies.** A phase (or a task marked with a dependency edge) that needs another phase's output starts only after that phase is merged into `car/main`. The dependency graph in §3 is authoritative: anything without an edge between them runs in parallel.
6. **Within a phase.** Subtasks that write disjoint files in the same worktree may run in parallel. Two subtasks that write the same file run one after the other. A test-writing subtask whose test imports a module that another subtask is still writing waits for that subtask's commit (the module is "in edit" until it is committed).
7. **Shared single-writer files.** `D:\git\opencode-model-router\CHANGELOG.md`, `D:\git\opencode-model-router\package.json`, `D:\git\opencode-model-router\package-lock.json`, `D:\git\opencode-model-router\README.md`, `D:\git\opencode-model-router\src\index.ts`, `D:\git\opencode-model-router\src\compat\v2-hooks.ts` and `D:\git\opencode-model-router\src\router\config.ts` have one owner each per wave (§2). Other phases record what they need in their QA report under "handoff to <owner phase>", and the owner applies it.
8. **Main checkout.** `D:\git\opencode-model-router` (branch `master`) is where the live opencode sessions load the plugin from, including the session executing this plan. Never edit its tree by hand, check out another branch in it, or run `npm ci` in it during execution. The only operations allowed on it are: creating worktrees from it; Phase 0.P's commit of this plan, the handover and the plans index; the **dogfood syncs of §0.11** (a fast-forward of `master` to `car/main` plus `npm ci` when `package-lock.json` changed, performed only by the orchestrator, only at a checkpoint, only after that wave's QA and capped full suite are green, and always preceded by a rollback tag `car/sync-<n>-prev`); and the final sync in Phase 3.4.
9. **Do not saturate the machine.**
   - **Full-suite runs are always capped and serialized:** `npx vitest run --maxWorkers=2`, run only by the orchestrator, one at a time across all worktrees. Never run a bare `npm test`.
   - **Scoped runs may be accelerated:** `npx vitest run <files>` or `npx vitest related <src files> --run` with vitest's default parallelism. Independent scoped runs from different agents may run concurrently.
   - **`npm ci` in new worktrees runs one at a time.**
   - **Smoke tests against a real OpenCode 2.0.22 host run one at a time** (they bind ports and write to the host's data directory).

### 0.7 Pre-flight before each phase, QA after each phase

- **Before** every phase: run the standard pre-flight (§0.9) plus the phase's own items. A failed item is fixed before the phase starts. If it cannot be fixed, §0.1 decides whether to stop. A finding that this plan explicitly schedules for a later phase is not fixed early: it is recorded in the phase QA report under "deferred by plan", naming the phase that owns it.
- **After** every phase: a `[tier:heavy]` senior QA engineer performs an **adversarial review** of the phase diff. Every finding carries a severity: `blocking`, `critical`, `major`, `minor` or `nit`.
- **Bounded QA rounds.** Round 1: fix every finding, then heavy QA re-reviews the fixes. Round 2: fix every finding. From round 3 on: fix only `blocking`, `critical` and `major`, re-review only those fixes; a `minor` or `nit` raised from round 3 on is recorded as "accepted — QA round limit" with a one-line rationale. **"Zero open findings" means:** no `blocking`, `critical` or `major` is open, and every round-1 and round-2 finding is fixed.
- The report is saved to `D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-<id>.md` (inside the phase worktree, committed with the phase). Finding ids are `QA-<phase>-<n>`; global findings are `QA-G-<n>`.
- Each QA report has the sections: `## Pre-flight` (results and spike evidence), `## Implementation notes` (including any approved deviation from this plan, marked *Amended during implementation*), `## Findings` (id, severity, file:line, description, resolution commit), `## Deferred by plan`, `## Handoffs`, and `## Verdict` (open findings: 0).
- After Wave 3's proof phase: the same for the whole change set (global QA, Phase 3.3).

### 0.8 Failure recovery

After **3 consecutive failed attempts on the same issue**: stop editing, revert to the last green commit, write down what was tried and the exact failure, and re-dispatch the problem to `[tier:heavy]` with that record. If heavy's approach also fails, it is a blocking problem under §0.1: ask the human.

### 0.9 Standard pre-flight checklist (applies to every phase)

`[tier:fast]` runs these and reports. The orchestrator reads the report before starting the phase.

- [ ] The phase worktree exists, is on the right branch, and `git status` is clean.
- [ ] The phase branch is based on the current tip of `car/main`, with every merged dependency included.
- [ ] Every dependency phase listed in §3 is merged and its QA report shows zero open findings.
- [ ] `npm ci` has completed in the worktree (serialized, §0.6.9). Then `npm run typecheck` and `npx vitest run --maxWorkers=2` pass there. The orchestrator runs the full suite once per phase, one worktree at a time.
- [ ] The phase's write-set (§2) does not overlap any other in-flight phase's write-set.
- [ ] No orphaned `node`/`vitest`/`opencode` processes from earlier phases are running (Windows: `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='opencode.exe' OR Name='bun.exe'"`, filtered to command lines that contain a worktree path).
- [ ] `router_verify` with `pending: true` reports no unverified delegation left from the previous phase.
- [ ] The phase-specific pre-flight items below pass, spikes included.

### 0.10 Execution conduct (binding for the executing orchestrator)

1. **Iterate continuously.** Phase to phase, wave to wave, without pausing. Stop **only** on §0.1.
2. **Take over when delegation itself is the blocker.** If a delegate returns a hand-back with zero tool calls, verbose or circular output, or the same dispatch fails twice with `NEED MORE:`/`ESCALATE:`: re-dispatch once with an explicit instruction to attempt the work; if that fails too, do the work yourself, log it in `D:\git\opencode-model-router\docs\qa\cost-aware-routing\run-log.md` (what, why, when), then return to delegating. Taking over is a recovery tool, not the default. (The plugin's false-refusal banner describes exactly this recovery; §1.1 records that it fired repeatedly during planning.)
3. **Pre-flight before every phase** (§0.9 + the phase items). Fix everything it finds, except findings explicitly scheduled for a later phase (record them as "deferred by plan").
4. **Heavy senior QA after every phase.** QA is always a `[tier:heavy]` task. Always apply this rule. Delegate to heavy QA an **adversarial** review of the work done. Fix the findings per the bounded rounds of §0.7.
5. **Always delegate through the model-router, preferring atomic tasks.** One dispatch is one small, verifiable unit: a function, a test file, one doc section. Coding goes to `@medium`; the tasks this plan tags `[tier:heavy]` go to `@heavy`. Split heavy work: `@heavy` designs or writes the dense core; `@fast` runs tests and reports; `@medium` fixes what the results show. Every dispatch carries the 7 sections (task, expected outcome, tools, must do, must not do, context, environment) and the ENVIRONMENT line: working directory = the phase worktree, `Platform: win32`, `Shell: pwsh`.
6. **Never run the full suite unless it is needed.** Test only what the change touches. The full suite runs only at the §0.9 pre-flight, after each merge, and at the release. Accelerate scoped runs (`npx vitest run <files>`, `--maxWorkers=50%`, `--pool=threads`, `--no-isolate` for pure unit files). Only full-suite runs stay capped and serialized.
7. **Commit often** (§0.3): after every green subtask, and push immediately.
8. **Talk to the human in Portuguese** (short, direct). Code, docs, commits, QA reports, issue comments and PRs are in English, matching the repo.
9. **Issue tracking.** At each wave boundary, post one short progress comment on #74 (what merged, the next wave). The PR closes #74 and #73. Phase 0.P checks for Linear usage (none known at planning time); if none, record "Linear: not used" in `phase-0P.md`.
10. **No swallowed errors in new code.** New code logs through the plugin logger and stays best-effort: it never rethrows into a real session, and a failing classifier backend, outcome store or advisor never blocks a dispatch.
11. **Never instruct the orchestrator model to set `model` on `subagent`.** The host's own argument description says "NEVER set this unless the user explicitly asks" (`packages/core/src/tool/plugin/subagent.ts:36–38` at `v2.0.22`). The router sets `model` **programmatically** in the hook (as it already does for `subagentTiers`); the protocol text never asks the LLM to do it.
12. **Pin every dispatch whose tier is mandated.** From checkpoint DF2 on (§0.11), every QA dispatch and every dispatch of a task this plan tags `[tier:heavy]` carries the line `[route pin]` in its prompt (D13). The engine never switches a pinned dispatch. This is how "QA is always heavy" survives `enforce` while the plan measures itself.
13. **Worktrees are always named in the handover.** Whenever work is happening outside the base checkout, the handover lists, per open worktree: its working directory (`D:\git\omr-car-<id>`), its branch, the phase it serves, and the base directory `D:\git\opencode-model-router` it was created from. A resumed session must be able to `cd` into the right worktree from the handover alone.
14. **Bounded QA re-reviews.** Fix everything from rounds 1 and 2; from round 3 on, only `blocking`, `critical` and `major` (§0.7). Never re-review the same implementation until the reviewer runs out of findings.
15. **Every dispatch is atomic.** One function, one test file, one doc section, one spike. Complex coding (hook ordering, kernel, ladder algebra, runner changes) may go to `@heavy`; the run-and-collect that follows goes to `@fast`, the fix-what-failed to `@medium`.

### 0.11 Dogfooding: the plan measures itself (checkpoints DF0–DF5)

The workload that calibrates the scoreboard is **this plan's own execution**. As soon as a mode is merged and proven, the executing session runs under it, and every later dispatch of the plan becomes a measured sample. Modes are raised one step at a time, each with a checkpoint that records the numbers of the period that just ended.

**Why this works.** The executing session loads the plugin from `D:\git\opencode-model-router` (`master`). A checkpoint fast-forwards `master` to `car/main` (merged, QA-clean, full suite green), so the new code is what the session's next dispatches run through. Mode changes are **config only** (`routing.engine` in the active `tiers.json`), which the plugin hot-reloads (PR #71); they never need a restart. Only **code** syncs may need one.

**Checkpoints.** Each is a numbered task in §3, executed by the orchestrator itself (never delegated), in this order:

| Id | When | Sync | Mode after | Records |
|---|---|---|---|---|
| DF0 | Phase 0.P | commit plan + handover + index on `master` | `static` | baseline: dispatches, false refusals and verdicts visible in the existing `*.scorecard.log` files of the planning session (0.P.2 directory); the **active config path** of the running host (0.P.6) |
| DF1 | after Wave 1 merges | `master` ← `car/main` | `static` | the live session still receives byte-identical protocol text (`/router` output and the `R:` line compared with 0.P.3); plugin load errors: none |
| DF2 | after Phase 2.2 merges | `master` ← `car/main` | **`shadow`** | DF1→DF2 period summary (static); from here every dispatch writes a decision row |
| DF3 | after Phase 2.4 merges | `master` ← `car/main` | **`advise`** | shadow-period summary: agreement rate, would-switch count, estimated savings, false refusals per `(agent, model#variant)`, verdict rates per key |
| DF4 | after Phase 3.2 is green | `master` ← `car/main` | **`enforce`** (`profile: balanced`, `margin: 0.2`) | advise-period summary; pins active (§0.10.12) |
| DF5 | Phase 3.4 | release sync | per D17 | enforce-period summary; the final `dogfood.md` report; the final mode left in the active config per D17 |

**Checkpoint procedure (DF1–DF4).**
1. Preconditions: the wave/phase QA report shows zero open findings; `npm run typecheck` and `npx vitest run --maxWorkers=2` are green in `D:\git\omr-car-main`; `router_verify pending: true` is empty.
2. `git -C D:\git\opencode-model-router tag car/sync-<n>-prev master` (rollback point), then `git -C D:\git\opencode-model-router merge --ff-only car/main`; `npm ci` there only if `package-lock.json` changed (serialized, §0.6.9).
3. **Liveness probe.** Run `/router` in the executing session. The output must show the marker the merged code adds (`router: engine=<mode> build=<short sha of car/main>`; the marker is added in Phase 1.1 to the `/router` output from the plugin's own package version + git sha file written at build time, see 1.1.6). If the marker is absent or stale, the code is not live: write the handover (§0.11 "Handover"), post the restart request in Portuguese, and **stop** (§0.1.4). When the human says to resume, re-run the probe first; if still stale, this is a blocking problem (§0.1.3).
4. Record the period summary with `npm run routing:stats -- --since <previous checkpoint ISO time>` (script from Phase 1.3) into `D:\git\opencode-model-router\docs\qa\cost-aware-routing\dogfood.md` under `## DF<n>`, plus the wall-clock time lost to the restart, if any.
5. Raise the mode by editing **only** `routing.engine` (and at DF4 `profile`/`margin`) in the active router config found in 0.P.6 — the global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (amendment A6), never the bundled `tiers.json`; confirm with `/router` that the new mode is live (config hot reload). Post a two-line status to the human in Portuguese (mode now live, headline numbers). Continue the plan.

**Rollback.** If after a sync the live plugin misbehaves (hook errors in the opencode log, dispatches failing to start, `/router` erroring): first set `routing.engine: static` in the active config (hot reload, instant). If the problem persists, `git -C D:\git\opencode-model-router reset --hard car/sync-<n>-prev`, request a restart, record the incident in `run-log.md` and open a QA finding (`QA-DF<n>-1`, severity `critical`) that the owning phase fixes before the sync is retried.

**Handover.** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md` ships with this plan (revision 0 = the kickoff prompt) and is rewritten at every checkpoint and before every restart request with: the checkpoint id, the sha of `master` and `car/main`, the active config path and its current `routing` block, the next task id, every open worktree (working directory, branch, phase, and the base directory `D:\git\opencode-model-router`), the last `routing:stats` snapshot, the open QA findings if any, and the exact sentence to tell the human. After a restart the orchestrator reads this file first and resumes from "next task id" without re-doing merged work.

**What is measured (the plugin's own observability, built in Wave 1–2).**
- `decisions.jsonl` (D15): one row per dispatch with `ts, mode, sessionID, childSessionID, facts, chosen, best, switched, pinned, unit, costs, confidence, reason`.
- The outcome store: per key, Beta counts, measured USD/tokens, false refusals, variant-step successes.
- `npm run routing:stats` (`D:\git\opencode-model-router\scripts\routing-stats.ts`, Phase 1.3): aggregates both over a time window into the dogfood table: dispatches, by class, by agent/model#variant, agreement rate (`best == chosen`), switched count and share, estimated savings in the decision unit (`Σ C(chosen) − C(best)` over non-pinned rows), measured cost per dispatch where USD, false-refusal rate per key, verdict rates per key, variant steps taken and their pass rate, resume-vs-fresh counts. `/router stats` (Phase 2.4) prints the same table in-session.
- Caveat written into `dogfood.md`: the workload is this plan (implementation-heavy, QA-heavy, pinned heavy dispatches); the numbers are evidence of behaviour, not a benchmark.

---

## 1. Problem and design

### 1.1 Evidence (current code at `v2.2.0`, host at `v2.0.22`)

**What exists and is reused (plugin).**
- Tiers are agents with a fixed model and a `costRatio` (`D:\git\opencode-model-router\src\router\config.ts` ≈85–109 `TierConfig`, ≈111 `Preset = Record<string, TierConfig>`, ≈1383–1388 cost/steps defaults by conventional name). `getActiveTiers` at `D:\git\opencode-model-router\src\router\protocol.ts` ≈7–9.
- The routing taxonomy is **prose generated from config**: `buildTaskTaxonomy` (`protocol.ts` ≈45–54) reads `cfg.taskPatterns`; empty → no `R:` line (`D:\git\opencode-model-router\test\unit\protocol.test.ts:69`). `buildDecomposeHint` (≈68–80) sorts tiers by `costRatio`.
- A deterministic rules classifier already exists in embryo: `classifyTrivial` (`D:\git\opencode-model-router\src\router\sessions.ts` ≈286–331) uses `taskPatterns` keywords plus shape gates (`MAX_TRIVIAL_CHARS`, `MULTI_STEP_RE`, `ENUMERATION_RE`, `DISTRIBUTIVE_RE`, path counts). It only exempts trivial fast dispatches from enforcement.
- The escalation ladder is a cascade: `nextAction` (`D:\git\opencode-model-router\src\escalate\ladder.ts` ≈119–189): accept → give up on `unverifiable` → cost ceiling → max attempts → **retry within tier with `effortBump`** (≈153–174) → escalate. `maxAttemptsPerTier` defaults to **1** (≈216), so the within-tier step never gets a second attempt unless configured; `buildEffortBump` (≈226–241) needs `tier.effort` and a ceiling. The effort override is applied per session through `chat.params`/the v2 context hook (`D:\git\opencode-model-router\src\escalate\effort-override.ts` ≈51–90; `D:\git\opencode-model-router\src\index.ts` ≈705–713), not through a model variant.
- The `delegate` tool **creates a new producer session per ladder attempt** (`D:\git\opencode-model-router\src\index.ts` ≈613–616 "Every ladder iteration creates its own producer session", ≈728–736 create, ≈764–770 prompt, ≈949–954 discard, ≈1014–1017 loop). Native `task` verification is observational: on failure it only appends a note suggesting the next tier (≈1595–1603).
- Verification outcomes are `pass | fail | unverifiable` (`D:\git\opencode-model-router\src\verify\types.ts:14`); `TrajectoryState` keeps verdict, attempts, escalations, final tier, `costUnits` (= `costRatio`, not money) per session in memory (`D:\git\opencode-model-router\src\telemetry\trajectory.ts` ≈18–42, ≈115–143, ≈155–235) and writes `${sid}.scorecard.log` from the `event` hook (`D:\git\opencode-model-router\src\index.ts` ≈1710–1720). There is **no cross-session aggregate**.
- Zero-tool-call hand-backs are already detected per child session (`FALSE-REFUSAL SUSPECT` banner, `D:\git\opencode-model-router\src\index.ts` ≈1382–1385; `D:\git\opencode-model-router\test\integration\session-lifecycle.test.ts:233`). They are not aggregated per tier.
- The v2 adapter (`D:\git\opencode-model-router\src\compat\v2-hooks.ts`): translates `subagent_type`/`task_id` ↔ `agent`/`sessionID` (≈23–24, ≈37–58); already calls `ctx.agent.list()` (≈119, ≈319); already **sets `args.model` on the `subagent` call** for `subagentTiers` (≈316–326); applies the legacy `tool.execute.before` and reassigns `event.input = nativeArgs(...)` (≈329, ≈346); its event loop (≈417–435) handles only `session.created`, `session.deleted`, `session.text.ended`. Producers on v2 run through `native.execute` in `D:\git\opencode-model-router\src\compat\v2-client.ts` ≈74–98 (model/variant at ≈88–92).
- Config hot reload (PR #71) re-reads `tiers.json` on `chat.message`/the prompt hook; the deferred catalog check validates tier models against the provider catalog (`D:\git\opencode-model-router\src\index.ts` ≈516–527, ≈1190–1200).
- The smoke harness drives a real host with a scripted provider for v1 and v2 (`D:\git\opencode-model-router\test\smoke\helpers\scripted-provider.ts`, `task_id`/`sessionID` at ≈80–83; `D:\git\opencode-model-router\test\smoke\depth-effort.smoke.test.ts` proves resume at ≈330–347). `npm run smoke:v2` exists.

**What the host provides (OpenCode `v2.0.22`, verified in source).**
- `subagent` tool input: `agent`, `description`, `prompt`, `model?` (`"providerID/modelID"` or `"providerID/modelID#variant"`), `sessionID?`, `background?` (`packages/core/src/tool/plugin/subagent.ts:29–48`). `resolveModel` validates the model and the variant against the live catalog (`:75–98`). `subagent_depth` (default 1) is enforced (`:117–133`); `mode: "primary"` agents are rejected (`:136–137`). **Resuming** with `sessionID` reuses the child; a different `model` calls `sessions.switchModel`, a different `agent` calls `switchAgent`, history preserved (`:153–182`). Model precedence for a new child: `override ?? agent.model ?? parent.model` (`:184`), for **any** agent. At each model request the tool description is rewritten with "Available subagents:" — id and description of every non-primary, non-hidden, permitted agent (`:284–301`), so custom agent descriptions are visible to the orchestrator.
- Hooks: the host executes the tool with `event.input` **as returned by the hooks** (`packages/core/src/tool.ts:271–280`); reassigning `event.input` is the official pattern (the built-in `packages/core/src/plugin/tool-input-repair.ts:33`); only `execute.before` may fail, which rejects the call (`packages/core/src/plugin/hooks.ts:23`).
- Agents are roles: `Agent.Info { id, name, model?, request, system?, description?, mode, hidden, color?, steps?, permissions }` (`packages/schema/src/agent.ts:23–35`). User config `agents.<id>` sets `model` (with `#variant`), `system`, `description`, `mode`, `hidden`, `steps`, `permissions`, `disabled` on **any** agent, hidden ones included (`packages/core/src/config/plugin/agent.ts:77–107`); legacy `small_model` migrates to `agents.title.model` (`packages/core/src/config/normalize.ts:135–151`). Native agents: `build`, `plan` (primary), `general` (subagent; denies `question`, `subagent`), `explore` (subagent; read-only: grep/glob/read/webfetch/websearch; denies bash and `subagent`), hidden primaries `compaction`, `title`, `summary` (`packages/core/src/plugin/agent.ts`).
- Cost: every finished step computes `cost = calculateCost(model.cost, tokens)` and publishes the **durable** event `session.step.ended` with required `cost: Money.USD` and `tokens: TokenUsage.Info {input, output, reasoning, cache{read, write}}` for any session, children included (`packages/core/src/session/runner/step.ts:236–244`, `packages/schema/src/session-event.ts:358–371`, `packages/schema/src/token-usage.ts`). **A model with no catalog pricing yields `Money.USD.zero`, not "unknown"** (`packages/core/src/session/usage.ts:22–28`); the Copilot billed amount is not used (`TODO(#35765)`). On the assistant message, `cost` and `tokens` are optional (`packages/schema/src/session-message.ts:226–227`).
- Variants are **synthesized by the host**, not read from models.dev: `Variant.resolve(model, supports)` per provider package protocol (`packages/core/src/variant.ts:16–39`, default `EFFORTS = ["low","medium","high"]`, provider-specific lists), from `reasoning_options` (`packages/core/src/models-dev.ts:105, 186–192`). `switchModel` is a no-op when nothing changed and otherwise publishes `ModelSelected`; it has no compaction logic (`packages/core/src/session/session.ts:97–109`).
- One-shot generation: `POST /api/experimental/generate` `{ prompt, model? }` → `{ data: { text } }` (`packages/protocol/src/groups/generate.ts:8–16`); without `model` it uses `config.model` (the user's default) or the first loadable model (`packages/core/src/model-resolver.ts:402–415`). Text only, no schema, no logprobs. Credentials are the user's (`packages/core/src/generate.ts`).

**The owner's installation (planning-time facts, re-verified in 0.P).** `opencode --version` = `v2.0.22`. Router preset `anthropic`: `fast = anthropic/claude-sonnet-5-5#low (1x)`, `medium = anthropic/claude-sonnet-5-5#medium (5x)`, `heavy = anthropic/claude-opus-5-5#xhigh (20x)`; `enforcement.escalate = { ladder: [fast, medium, heavy], maxAttemptsPerTier: 1, maxTotalAttempts: 4, costCeiling.multiple: 4 }`; no `subagentTiers`; `taskPatterns` as shipped. `C:\Users\Marquinho\.config\opencode\opencode.json`: no default `model`; `agent.explore.model = anthropic/claude-haiku-4-5`; provider `openai` configured; `agents.title.model`/`agents.summary.model` unset. models.dev lists prices for `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`, `openai/gpt-6-luna`, `opencode/deepseek-v4.1-flash` and no `variants` key for any of them (the host synthesizes them).

**Planning-session evidence of waste.** During planning, 5 of 12 `@fast` dispatches returned with zero tool calls claiming to lack filesystem or web tools; each was a full round lost; the recovery that worked was re-dispatching with "attempt first". The plugin's false-refusal banner prescribes the same recovery, but nothing learns from it per tier. This plan makes those hand-backs a **failure signal in the scoreboard** (M3).

### 1.2 Behaviour to preserve

- With no `routing` block in `tiers.json`, every observable behaviour of `2.2.0` is unchanged: identical protocol text (snapshot test), identical `R:` line, identical ladder decisions (golden fixtures in `D:\git\opencode-model-router\test\unit\` stay byte-identical), identical dispatch headers, identical scorecard logs, no new files written to disk.
- OpenCode **v1** hosts: unchanged in every mode. The `routing` block is parsed and validated on v1 but `engine` is forced to `static` with one logged notice.
- `subagentTiers` keeps working exactly as today (the engine's `model` override composes with it: engine first, `subagentTiers` only fills a missing `model`).
- The depth guard, the hard-block guard, the verification gate, `router_verify`, `delegate`, `/tiers`, `/preset`, `/budget`, `/router`, `/bypass`, `/annotate-plan` keep their contracts; `/annotate-plan` output gains lines, never loses any.
- The orchestrator protocol never instructs the LLM to set `model` (§0.10.11).

### 1.3 Mechanisms (all implemented by this plan)

| Id | Mechanism | Lives in |
|---|---|---|
| M1 | **Configuration surface** `routing.*`, `tiers.<t>.candidates[]`, `enforcement.escalate.variantSteps` — validated, defaulted, hot-reloaded | `src/router/config.ts`, `docs/CONFIG_REFERENCE.md` |
| M2 | **Task classifier**: rules layer (generalised `classifyTrivial` shape gates + `taskPatterns`) → typed-fields line `[route …]` from the orchestrator → optional model backend (`host`, `openai-compatible`, `typesafe`) → `unknown`. Output: `TaskFacts { class, risk, scope, needs[], confidence, source }` | `src/routing/classify/*` |
| M3 | **Outcome store + cost accounting**: Beta posteriors per `(class × agent × model#variant)` from verdicts and false refusals; measured cost/tokens from `session.step.ended`; cost-unit rule; zero-cost-is-unknown rule; decay; bounded JSON persistence | `src/routing/outcomes/*` |
| M4 | **Decision kernel**: expected cost of the whole cascade per candidate; profiles; margin rule; degenerate case = static taxonomy; `R:` line generator; per-turn suggestion; plan fan-out | `src/routing/engine/*` |
| M5 | **Session-aware ladder algebra**: variant steps on the same model before model steps; resume-vs-fresh decision by context fraction; `maxAttemptsPerTier` semantics with `variantSteps` | `src/escalate/ladder.ts` (+ new `src/escalate/variants.ts`) |
| M6 | **v2 telemetry ingestion**: `session.step.ended` → store; child session ↔ dispatch facts; verdicts and false refusals → store | `src/compat/v2-hooks.ts`, `src/routing/outcomes/ingest.ts` |
| M7 | **Dispatch-time routing on v2**: `execute.before` runs M2+M4 per `subagent` call; `shadow` records, `advise` injects the generated `R:` line and a per-turn hint through the context hook, `enforce` reassigns `event.input.model`/`agent` under the margin rule; `[route …]` parsed and stripped; plan `[route …]` annotations honoured | `src/compat/v2-hooks.ts`, `src/routing/wire/*` |
| M8 | **Cost doctor + commands + plan annotation**: advisor findings (title/summary models, unpriced models, missing variants, subscription pricing caveat) in `/router` and a once-per-day notice; `/annotate-plan` emits `[route …]` per step using batched classification | `src/routing/advisor/*`, `src/index.ts` (command owner) |

### 1.4 Configuration surface (all optional; absent = today)

```jsonc
{
  "presets": {
    "anthropic": {
      "fast":   { "model": "anthropic/claude-sonnet-5-5", "variant": "low",    "costRatio": 1 },
      "medium": { "model": "anthropic/claude-sonnet-5-5", "variant": "medium", "costRatio": 5,
                  "candidates": [ { "variant": "medium", "costRatio": 5 }, { "variant": "high", "costRatio": 8 } ] },
      "heavy":  { "model": "anthropic/claude-opus-5-5",   "variant": "xhigh",  "costRatio": 20 }
    }
  },
  "enforcement": { "escalate": { "variantSteps": "auto" } },           // auto | none; v2 only, default auto
  "routing": {
    "engine": "static",                                                 // static | shadow | advise | enforce
    "profile": "balanced",                                              // frugal | balanced | safe
    "margin": 0.2,                                                      // enforce: switch only if C(best) <= (1 - margin) * C(chosen)
    "minClassConfidence": 0.7,
    "detection": { "deterministic": 0.95, "grader": 0.7, "none": 0.3 },  // d by verification depth
    "classifier": {
      "backend": "rules",                                               // rules | host | openai-compatible | typesafe
      "model": null,                                                    // catalog ref "provider/model[#variant]"; REQUIRED when backend != rules
      "baseUrl": null, "apiKeyEnv": null,                               // openai-compatible / typesafe only
      "timeoutMs": 1500, "samples": 1, "maxStateChars": 2000,
      "presets": {}                                                     // per-preset override of model/backend
    },
    "roles": { "search": ["explore"], "implement": ["general"],         // class -> ordered agent ids appended to the router tiers' ladders;
               "debug": ["general"], "review": ["general"] },            // this is the v2 default (D12); v1 default is {}; set {} to disable
    "outcomes": { "path": null, "halfLifeDays": 14, "maxEffectiveSamples": 50 },
    "sessionReuse": { "maxContextFraction": 0.6 },
    "advisor": { "enabled": true, "noticeIntervalHours": 24 }
  }
}
```

### 1.5 Decisions taken (the executor does not re-open these)

- **D1 — v2 only; v1 opt-in is text-only.** The engine, the ladder's variant/session steps, telemetry ingestion and the advisor run only under `D:\git\opencode-model-router\src\v2.ts`/`src\compat\v2-hooks.ts`. On v1 the `routing` block validates, `engine` is coerced to `static` with one `[model-router] routing.engine ignored on OpenCode v1` log line, and `variantSteps` is ignored. The one v1 effect, **opt-in only**: when the user sets `routing.roles` explicitly on v1, the static `R:` line lists those agents as destinations for their classes (prose only; no model override, no engine). With no `routing` block, no v1 code path changes behaviour; v1 goldens stay byte-identical.
- **D2 — Default is `static` and equals `2.2.0`.** A snapshot test pins the protocol text and the `R:` line for the shipped `tiers.json`; the engine with no outcome data and no `routing` block must reproduce the static taxonomy exactly (the degenerate case is a tested property, not a hope).
- **D3 — The classifier is never an agent.** It runs through the host `generate` endpoint (with an explicit `model`) or a direct OpenAI-compatible/TypeSafe HTTP call. It is never registered with `agent.transform`, never appears in the protocol, never creates a session. `backend != rules` without `model` is a **validation error**.
- **D4 — Probabilities come from outcomes only.** The classifier's confidence (logprobs or sample agreement) gates only whether the engine trusts the *class*; it never enters `p_t`. `p_t` is the Beta posterior of verified outcomes. `unverifiable` verdicts update nothing. A false-refusal (zero tool calls) counts as a **failure** for that `(class × agent × model#variant)`.
- **D5 — Cost-unit rule.** Within one decision, all candidates are compared in the same unit: USD if every candidate has catalog pricing (non-empty `Model.Info.cost`) or ≥3 measured samples; otherwise `costRatio` units for all. Never mix.
- **D6 — Zero cost with empty pricing is unknown.** A `session.step.ended` with `cost == 0` for a model whose catalog `cost` array is empty is stored as `cost: null` (tokens still stored). Subscription providers (OpenCode Go, Copilot) report catalog prices that are not what is billed; the advisor says so, the engine uses them as relative weights only.
- **D7 — Priors from the static taxonomy, strength 5.** For class `c` whose static tier is `t0`: a candidate at the same rank → `Beta(4, 1)`; each rank above → mean `+0.05` (cap `0.95`); each rank below → mean `−0.25` (floor `0.3`); same strength `α+β = 5`. Native/user agents without a static rank inherit the rank of the role they are listed under in `routing.roles`.
- **D8 — Expected cost of the cascade.** For candidate `k` with successor `next(k)` on its ladder (next variant of the same model, then next model; terminal successor = give up at cost `U`):
  `C(k) = c_k + tax_k + (1 − p_k) · [ d · C(next(k)) + (1 − d) · U ]`.
  `c_k` per D5; `tax_k` = mean final-message tokens of class `c` on `k` × `remainingTurnsEstimate` (default 4) × orchestrator cache-read price, **0 until measured** (never invented); `d` from `routing.detection` by the dispatch's `[acceptance]` checks (deterministic check present → `deterministic`; LLM grader scheduled → `grader`; else `none`); `U = profile[risk]` with `frugal = {low 3, medium 8, high 20}`, `balanced = {5, 15, 40}`, `safe = {10, 30, 100}` in cost units where `fast = 1`.
- **D9 — Margin rule for `enforce`.** The engine replaces the orchestrator's choice only if `C(best) ≤ (1 − margin) · C(chosen)`, `TaskFacts.confidence ≥ minClassConfidence`, the candidate agent's permissions cover `TaskFacts.needs`, and the candidate is not below `floorTier`. Otherwise the orchestrator's choice stands and the engine records a `kept` decision. The engine never moves a dispatch **down** a rank when `d == none` and `risk == high`, and never switches a dispatch whose prompt carries `[route pin]` (D13): pinned dispatches are logged with `pinned: true` and `switched: false`, and their `best` is still computed for the statistics.
- **D10 — Variant steps before model steps, on the same session.** On v2 with `variantSteps: "auto"`, a failed verification first retries on the same model's next variant (catalog order, validated against `model.variants`), resuming the child session with the ladder's forcing message; variant steps do **not** consume `maxAttemptsPerTier` but **do** count toward `maxTotalAttempts` and the cost ceiling. Only when no higher variant exists does the ladder escalate the model. The producer-side `effortOverrides` path stays for v1 and for models without variants.
- **D11 — Resume vs fresh.** A retry or escalation **resumes** the child session (`sessionID` + `model`, and `agent` when the role changes) when the child's last-step `tokens.input + cache.read + cache.write + output` is below `sessionReuse.maxContextFraction × limit.context` of the **next** model; otherwise it starts a fresh session exactly as today. The decision and both numbers are logged.
- **D12 — Roles are agents; native agents are candidates by default on v2; no nested delegation.** `routing.roles` maps classes to ordered agent ids; router tiers are always in every ladder. **Default on v2:** `roles = { search: ["explore"], implement: ["general"], debug: ["general"], review: ["general"] }`; `roles: {}` disables native candidates; on v1 the default is `{}` (D1). A native or user agent candidate gets, as rungs, its own configured model first (from `ctx.agent.list()`, e.g. the owner's `agent.explore.model = anthropic/claude-haiku-4-5`) followed by the `candidates` ladder of the router tier that owns the class in the static taxonomy (applied by per-call `model` override, D8 priors by inherited rank). Candidate agents must be `mode != primary`, `hidden == false`, and permitted for the parent; the permission filter against `TaskFacts.needs` applies (e.g. `explore` is excluded when `needs` contains `shell`). The plugin never raises `subagent_depth`; the depth guard stays.
- **D13 — Typed fields channel.** The orchestrator may add one line `[route class=<c> risk=<r> scope=<s> needs=<a,b> pin]` to a dispatch prompt (only when the protocol asks for it, in `advise`/`enforce`). `pin` (bare flag) means "the tier is mandated by a plan or by policy; do not switch" (D9). It is parsed and **stripped** in `execute.before`, like `CAP:` and `VERIFY:`. Unknown values are ignored field by field.
- **D14 — Classifier state is bounded and English.** State sent to a model backend = `description` + `[acceptance]` block + first `maxStateChars` characters of the prompt, with `[route …]`, `CAP:`, `VERIFY:` lines removed; never file contents, never the orchestrator's system prompt. Instructions and option descriptions are English; options always include `other`/`unknown`; option order is shuffled per call and a disagreement between two orders lowers confidence to `0`.
- **D15 — Persistence.** The outcome store is one JSON file plus an append-only JSONL decision log under the directory that already holds `*.scorecard.log` (located in 0.P), bounded (`decisions.jsonl` ≤ 5 MB, rotated), written atomically (temp + rename), never on the hot path of a dispatch (flushed on `session.idle`/`session.deleted` and at most every 30 s).
- **D16 — Release `2.3.0`**, one PR, closes #74 and #73.
- **D17 — The plan dogfoods itself, and the final mode is decided by its own numbers.** Modes are raised at the checkpoints of §0.11 and never skipped. At DF5 the active config is left at `enforce` if, during the enforce period (DF4→DF5), no **switched** dispatch ended in a `fail` verdict; otherwise it is left at `advise`. The rule, the counts and the resulting mode are written in `dogfood.md`, and the human is told in the final status (not asked).
- **D18 — Observability is a deliverable, not a debug aid.** The decision log, the outcome store, `npm run routing:stats` and `/router stats` are part of the release, documented in `docs\ROUTING_ENGINE.md`, tested, and used by the checkpoints. A checkpoint without a `routing:stats` summary is not complete.

#### Amended during implementation (Phase 0.P spike verdicts; evidence and rationale in `D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-0P.md`, same ids)

- **A1 → D5/D6.** *Unpriced* = catalog `cost` empty, or every field of every cost entry (all tiers) is 0. Observed unpriced: `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5` (all-zero), `openai/gpt-6-luna`, `openai/gpt-6-luna-fast` (empty). Their step costs are stored as `null`. Every tier model of the live `hybrid-2` preset is unpriced, so the dogfood (DF1–DF5) measures decisions and savings in `costRatio` units.
- **A2 → F4/2.4.** Suggestions come from the live catalog only, never hard-coded ids. "Cheapest" = lowest `input + output` price per token among priced models whose catalog entry supports tool calls; S4 did not check tool support. Priced examples on this machine: `opencode-go/deepseek-v4.1-flash` (0.15/0.6), `opencode-go/gpt-6-luna` (0.1/0.5). `opencode/deepseek-v4.1-flash` does not exist here. Variant sets differ per model.
- **A3 → M6/2.1.** The same `session.step.ended` (same event id) is delivered once to **each** live location's plugin instance (S3b: 2 instances, 2 raw deliveries, 1 event). Ingestion dedupes by event id with a **module (process) scope** set, the dispatch registry is module scope too, only registered child sessions are recorded, and the outcome store has a single writer per process.
- **A4 → M2 `host` backend.** Uses the plugin client `ctx.generate.text({prompt, model})`, which resolves `model` in the **dispatching location's** config (S5: it never touched the base location), not the server base config; any error (including `Model unavailable` or a credentials error) → `unknown` within `timeoutMs`, no retry loop. The real-credential path is checked live at checkpoint DF3 as a bounded one-shot with an owner-named model (Checkpoint DF3 text, A13), before Phase 3.1 writes the docs; Phase 3.1 documents `host` as *experimental* unless that check passed.
- **A5 → D11.** Resume when `lastStepTokens + estimatedTokens(nextPrompt) < sessionReuse.maxContextFraction × inputBudget(next)`, with `inputBudget(m) = limit.input ?? (limit.context − limit.output)` of the **next** model (estimate = chars/4 of forcing message + dispatch prompt); otherwise fresh. Host auto-compaction runs but does not guarantee fit (S6).
- **A6 → §0.11 / §2.** Checkpoints edit `routing.*` in `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (global override layer), never the bundled `D:\git\opencode-model-router\tiers.json`. Phase 1.1.4 proves hot reload re-reads that layer.
- **A7 → D10 / 3.2.** Effort delivery depends on the provider route: same-model variant changes on `claude-sonnet-5-5`/`claude-opus-5-5` (Anthropic Messages) travel in-band (`{"role":"system","output_config":{"effort":…}}`) with the top-level effort unchanged (the host's stated intent is cache preservation; not measured); a `default` → variant step changes the top-level `thinking` object; `claude-haiku-4-5` variants map to `thinking.budget_tokens` at the top level; the OpenAI Responses route (live @fast) was not exercised. Provider acceptance of in-band effort is unverified. Tests assert the effective effort.
- **A8 → §0.11.** Plugin code is loaded once per process by dynamic `import()`; every code sync (DF1–DF4) requires a host restart.
- **A9 → D10 / 1.5.** A child without a variant is stored as `variant "default"` (not in `variants[]`) and sends no effort. Phase 1.5.1 defines its rank; the ladder never emits a variant absent from `variants[]`.
- **A10 → D5 / D11.** `cost[]` may hold context-tiered entries (e.g. `opencode-go/gpt-6-luna` and the `openrouter`/`amazon-bedrock` listings of `gpt-6-luna` carry a `tier: {type: "context", size: 272000}` entry; `openai/gpt-6-luna*` have `cost []`); price lookup picks the entry by input size. Context checks use `inputBudget(m)` of A5.
- **A11 → D9 / D12.** The host re-checks permissions after `execute.before` rewrites `agent` (`Subagent denied: explore`). `enforce` applies the permission filter before any swap. With native permissions `explore` gets read-only tools (`glob, grep, read, subagent, webfetch, websearch`) and `general` the full set; an agent switch on resume changes the tool set and system prompt (S2-agent-native), so D12's `needs` filter must read the agent's **evaluated** permissions, never assume them from the agent id.
- **A12 → §0.6.8.** Phase 0.P work is merged via `car/p0p` → `car/main`, then `master` is fast-forwarded to `car/main` (docs and a gated smoke test only; no plugin code; no restart).
- **A14 → §0.6.9 / §0.10.6 (QA-1.1-1, QA-1.1-17).** Never run vitest with `--pool=threads`: env redirects of `HOME`/`USERPROFILE` do not reach `os.homedir()` in worker threads, and config tests then write the user's real `~/.config/opencode` files. A global vitest setup file mocks `os.homedir()` to a temp dir and fails fast if a test resolves the real home.
- **A15 → D2 / D10 (QA-1.1-4).** `enforcement.escalate.variantSteps` defaults to `"none"` when the config has no `routing` block, and to `"auto"` (v2) when it has one; an explicit value always wins. With no `routing` block the ladder is byte-identical to 2.2.0.
- **A16 → D9 (QA-1.1-16).** `enforce` switches only if `C(best) < (1 − margin) · C(chosen)` (strict); exactly at the boundary the choice is kept; `best == chosen` is never a switch.
- **A17 → D10 (QA-1.5-1, QA-1.5-2).** Budget reserve: on a tier with variant info, a variant step or a plain retry is taken only if `maxTotalAttempts − totalAttempts − 1 ≥ H`, `H` = number of ladder tiers above the current one; otherwise the ladder escalates. Every action carries the `costRatio` of the rung it runs (from `resolveCandidates`), and the runner charges that, not the tier's base ratio.
- **A17a → D10 (QA-1.5-17/18/21).** The A17 reserve applies only when variant steps are enabled for the session (`policy.variants` present). The ladder never re-runs a `(model, variant)` that already failed in the same ladder: `LadderState.triedByModel` records the highest rung run per model, and an escalation into a tier whose base is covered enters at `nextVariant(to.ladder, triedByModel[to.model])` or skips the tier when none exists. Tiers configured with `effort`/`thinking`/`reasoning` are never treated as covered and never used as a coverage source.
- **A20 → D10 (QA-1.5-8).** A tier that sets both `variant` and `effort`/`thinking`/`reasoning` stays on the effort-bump path only (empty variant ladder), so effort is never delivered twice; the 2.4 advisor reports it and suggests `candidates`.
- **A21 → §3 1.5.1 (QA-1.5-11).** `nextAction` order is accept → unverifiable → **max total → cost ceiling** → variant step → retry within tier → escalate (the 2.2.0 code order the goldens pin).
- **A22 → M2 (QA-1.2-22/23/29).** The orchestrator's `[route …]` line is recognised only as the **first** non-empty line of the dispatch prompt; on a conflict the first line's `pin` is kept. Inside MUST NOT DO / constraint sections, negated prohibitions ("never force-push") do not raise risk.
- **A23 → D8 / D9 / M4 (Phase 1.4.1 design E1–E7, `docs\qa\cost-aware-routing\phase-1.4.md`).** `best` is drawn only from the orchestrator's choice and candidates passing the permission, floor and never-down filters; below `minClassConfidence` the kernel does not read the store; `U` in USD is scaled by the USD price of one `costRatio` unit (cheapest candidate), else the decision falls back to ratio units; the generated `R:` line is `buildTaskTaxonomy(cfg)` plus an optional ` | by class: c→@agent` suffix, and a class moves only when the winner has ≥ 5 recorded outcomes (same rule for plan annotation); a native-agent cascade is its own model, then the owning tier's rungs, then the next router tier; `next(k)` is fixed per candidate; `Decision.confidence` = class confidence × n/(n+5) of the winner (reported, not decisive).
- **A24 → D9 (QA-1.4-6).** Evidence gate in the kernel: a switch to a candidate whose expected cost is lower than the chosen one (a "down" switch) requires ≥ 5 recorded outcomes for that candidate's key; otherwise the decision is `kept` with reason `evidence`. Only switches to a strictly higher rank are ungated; every other switch (down, or sideways at equal rank, including a lower variant of the same model) requires ≥ 5 recorded outcomes on `best` (QA-1.4-15). Priors alone never move a dispatch down or sideways in `enforce`.
- **A25 → D8 (QA-1.4-1/2).** The kernel prices the router block by simulating the 1.5 runner (`buildEscalatePolicy` + `newLadderState`/`nextAction`/`advance`, including retries, `maxTotalAttempts`, the cost ceiling and covered-tier skips), not a fixed `next(k)` chain; other-model `candidates` rungs are not modelled. A native agent's own-model rung takes the rank of the matching preset rung when one exists (`min(owningRank, matched.rank)`); the inherited rank applies only when no rung matches. Agents without a configured model get an own-model rung on the parent's model.
- **A26 → 2.4.4 (QA-1.4-19).** `/annotate-plan` pins every step whose final tag is `[tier:heavy]` (tagged, QA, or engine-chosen), not only tagged/QA steps; annotation reports the number of steps it pinned.
- **A27 → D9 / A24 (QA-2.2-4).** The A24 evidence requirement filters the candidate set BEFORE the argmin. A candidate is eligible as best only if it has evidence (≥ minOutcomes trusted outcomes for the class) or is a strictly higher rank than the chosen one. The unfiltered argmin is logged in the row's trace for stats. Rationale: with D12 default roles the single-argmin-then-gate rule left enforce inert for 4 of 8 classes and suppressed upward switches.
- **A28 → 1.1 handoff / 2.4 (QA-2.2-11).** Phase 2.4 owns the v1 system-transform hunk in `src\index.ts` for the 1.1 handoff (text-only `R:` line for explicit `routing.roles`), with a v1 snapshot test.
- **A29 → D11 / 2.3 (QA-2.3-9).** D11's "last step" context for resume uses the LARGEST step token count seen in the current execution (conservative: only causes more fresh starts).
- **A30 → D9 / 2.2 / 2.4 (QA-2.4-R2-3).** A dispatch that resumes an existing child (`task_id`/`sessionID`) is never switched by the engine in any mode; the kernel's decision is still logged but `switched` is false with reason `kept:resume`, and `routing:stats` / `/router stats` exclude resume rows from routing metrics (agreement, switched, savings, per-class and per-key dispatch counts, the evidence gate) and report them only on their own line. The same holds for the floor-tier lift. Implemented in `src\routing\wire\dispatch.ts` (the single 2.2 change of 2.4 round 2) and `src\routing\outcomes\stats.ts`.
- **A30 amended (QA-2.4-R3-1):** a resume never moves the child from where it runs because of the router. If the resume names the orchestrator's original pick for that child and the child runs on a router-applied agent/model, args are rewritten to the running agent/model (reason `kept:resume:running`). If the orchestrator names a different agent on purpose, it is honoured, with `floorLift` applied (never below the floor). No evidence switch on resumes. Implemented in `src\routing\wire\dispatch.ts` (`runningAfterRouter`; the registry record gained `picked`, the agent the orchestrator named) and applied in `enforce` only; `shadow`/`advise` leave the args alone and say in the row what `enforce` would do. A child the registry does not know (swept, a restart) or that belongs to another orchestrator is left as the orchestrator named it; a pinned resume is never rewritten.
- **A31 → F4 / 2.4 / acceptance 8 (QA-3.1-17, QA-2.4-1):** the cost doctor has no `summary` finding; `title-model-unset` follows the host's own title pick (`selectTitle` / `Model.small`, v2.0.22 `core/src/session/context.ts`, `core/src/model.ts`); acceptance criterion 8 reads "reports an unset `agents.title.model` when the host's own pick would fall back to the session model". No host consumer of a summary model was found in `core/src/session` (2.4 QA). A wider search found no consumer of the summary agent anywhere in `packages/core/src` (checked on host source v2.0.20, `D:\git\opencode-rich-footer-host-v2`).
- **A32 → F4 / 2.4 (QA-2.4-R2-1):** in `advise`/`enforce`, advisor notices are delivered as a synthetic transcript entry (`ctx.session.synthetic`) one user turn late, throttled per project (a state file and a lock under the outcomes directory) with a weekly reminder; never in the system prompt or the user's message. In `static`/`shadow` the notice is a log line with a memory-only throttle and no file.
- **A33 → F4 / §1.1 (QA-3.1-5):** the F4/§0 premise that `maxAttemptsPerTier: 1` means "every failure escalates straight to a bigger model" is false: `nextAction` retries the same tier once first; the `attempts-without-variants` finding is reworded accordingly (a failed verification re-runs the same rung once in a fresh child, then escalates; variant steps would retry a higher variant on the same session).
- **A18 → D3 / D14 / D15 (QA-1.1-2, QA-1.2-9).** The project-local override layer (`<repo>/.opencode/opencode-model-router.overrides.jsonc`) may not set `routing.classifier.{backend, model, baseUrl, apiKeyEnv, presets}` or `routing.outcomes.path`; those keys are dropped from that layer with a one-time warning. HTTP backends refuse to send a key over plain `http:` to a non-loopback host.
- **A19 → D4 / D14 (QA-1.2-8).** A backend label replaces the rules class only if it is one of the classes the rules matched (or rules matched none); otherwise the rules class stands. Backend confidence is capped below `minClassConfidence` unless it agrees with rules.
- **A13 → §0.11 DF3 / D3 / D14.** The classifier model of any live `host`/HTTP backend check is named by the owner, never picked automatically (task text leaves the machine to that provider's account, and the override file is global). Without that decision the DF3 live check is skipped and `host` ships as experimental. **Owner decision (2026-10-06): the DF3 check uses `opencode-go/deepseek-v4.1-flash`.**

### 1.6 Target flows

**F1 — Real-time dispatch (v2, `engine != static`).** `execute.before` for `subagent`: parse and strip `[route …]` → `TaskFacts` via M2 (rules → typed fields → backend if confidence < `minClassConfidence` and backend configured → `unknown`) → candidates = ladder of the chosen/static tier ∪ `routing.roles[class]`, filtered by permissions vs `needs` → M4 computes `C(k)` with M3 posteriors/costs → decision `{ agent, model#variant, confidence, reason, kept|switched }` → `shadow`: log only; `advise`: log + (hint already injected at the context hook for this turn); `enforce`: log + `event.input = nativeArgs(...)` with `agent`/`model` replaced when D9 holds. The subagent id → dispatch facts are remembered for M6. Latency budget of the local path: < 5 ms; backend calls bounded by `timeoutMs` and never block on failure.

**F2 — Failed verification (v2).** `delegate` ladder: `nextAction` returns `retry` with `variant` (D10) or `escalate` with `model`/`agent`; the runner resumes or recreates per D11; the forcing message is the resumed session's next prompt; the verdict feeds M3.

**F3 — Annotated plan.** `/annotate-plan` classifies every step (rules per step; one batched backend call when configured; validated per step; rules fallback), computes the start tier per step with M4, and emits `[tier:X]` + `[route class=… risk=… d=…]` + `[acceptance]` per step. At execution, a `[route …]` present in the prompt is authoritative for `TaskFacts` (source `plan`).

**F4 — Cost doctor.** On config load and on `/router`: findings for unset `agents.title.model`/`agents.summary.model` (suggest the cheapest priced, tool-call-capable model from the catalog, e.g. `opencode/deepseek-v4.1-flash` when present), unpriced models in any ladder (D6), tiers with `effort`/`variant` that the catalog does not offer, subscription-pricing caveat, `maxAttemptsPerTier: 1` with `variantSteps: none`. Once per `noticeIntervalHours` a one-line notice is appended to the orchestrator's context (advise/enforce) or logged (shadow/static).

### 1.7 Pre-flight spikes that gate the design (Phase 0.P)

| Spike | Hypothesis | If disproven |
|---|---|---|
| S1 | On host 2.0.22, reassigning `event.input` with a different `agent` and `model#variant` in `tool.hook("execute.before")` is honoured for `subagent` (new session uses the swapped agent/model) | `enforce` is limited to `model` only (S1b); if `model` also fails, `enforce` is removed from the release and documented as unsupported on 2.0.22 (blocking → ask the human) |
| S2 | Resuming a child with `sessionID` + a higher `#variant` switches the model and keeps history; `agent` switch on resume works | D10 keeps variant steps but D11 forces fresh sessions (resume disabled); if variant switch itself fails, D10 falls back to `effortOverrides` |
| S3 | `session.step.ended` events for child sessions reach `ctx.event.subscribe` in the plugin with `cost` and `tokens` | M3 reads `client.session.messages` on `session.idle` instead (fallback written in Phase 2.1) |
| S4 | `ctx.model.list()` (or the catalog the adapter already queries) returns `variants` in ascending effort order and `cost` for the owner's models; `sonnet-5-5` and `opus-5-5` expose `low/medium/high/xhigh`-style ids | ladders read explicit `candidates` only; auto variant discovery disabled with an advisor finding |
| S5 | `POST /api/experimental/generate` with an explicit `model` works from the plugin's v2 client with the user's credentials | `host` backend removed; `openai-compatible` remains |
| S6 | After `switchModel` to a model with a smaller context, the next prompt compacts or errors predictably | D11 threshold uses the **smaller** of the two context limits |
| S7 | A plugin code change on disk in `D:\git\opencode-model-router` is picked up by the running host without a restart | Not a design dependency: every checkpoint of §0.11 probes liveness and requests a restart when stale (§0.1.4). The verdict only sets the expectation for how many restarts the run will need |

---

## 2. File ownership map

One owner per file per wave. "New" files are created by their owner. Everything not listed is read-only.

| Phase | Write-set (full paths under `D:\git\opencode-model-router\`) |
|---|---|
| 0.P | `docs\qa\cost-aware-routing\phase-0P.md`, `docs\qa\cost-aware-routing\run-log.md`, `docs\qa\cost-aware-routing\dogfood.md` (new; DF0 baseline), `docs\plans\cost-aware-routing-engine-handover.md` (exists; rewritten), `test\smoke\routing-spikes.smoke.test.ts` (new; spike harness kept as a test). Committed on `master` (the §0.6.8 exception). |
| orchestrator only | `docs\plans\cost-aware-routing-engine-handover.md` and `docs\qa\cost-aware-routing\dogfood.md` after 0.P (rewritten at every checkpoint, committed on `master` with the sync); the **active router config** of the running host — per amendment A6 the global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (only `routing.engine`, `routing.profile`, `routing.margin` — and at DF3 `routing.classifier` (A4) — are ever edited, only at checkpoints) |
| 1.1 | `src\router\config.ts`, `src\router\build-info.ts` (new; version + git sha marker), `docs\CONFIG_REFERENCE.md`, `test\unit\config.routing.test.ts` (new), `test\unit\config.validate.test.ts` (append only) |
| 1.2 | `src\routing\classify\types.ts`, `src\routing\classify\rules.ts`, `src\routing\classify\route-line.ts`, `src\routing\classify\backends\host.ts`, `src\routing\classify\backends\openai-compatible.ts`, `src\routing\classify\backends\typesafe.ts`, `src\routing\classify\index.ts` (all new), `src\router\sessions.ts` (only to export the shape-gate regexes and `normTaskKw`; `classifyTrivial` behaviour unchanged), `test\unit\routing-classify*.test.ts` (new) |
| 1.3 | `src\routing\outcomes\store.ts`, `src\routing\outcomes\beta.ts`, `src\routing\outcomes\cost.ts`, `src\routing\outcomes\persist.ts`, `src\routing\outcomes\stats.ts`, `src\routing\outcomes\index.ts` (new), `scripts\routing-stats.ts` (new), `package.json` (Wave 1 owner: the `routing:stats` script line only), `test\unit\routing-outcomes*.test.ts` (new) |
| 1.4 | `src\routing\engine\kernel.ts`, `src\routing\engine\ladders.ts`, `src\routing\engine\protocol-line.ts`, `src\routing\engine\plan.ts`, `src\routing\engine\index.ts` (new), `test\unit\routing-engine*.test.ts` (new) |
| 1.5 | `src\escalate\ladder.ts`, `src\escalate\variants.ts` (new), `test\unit\ladder*.test.ts` (append; goldens untouched), `test\unit\escalate-variants.test.ts` (new) |
| 2.1 | `src\compat\v2-hooks.ts` (event loop section only, this wave), `src\routing\outcomes\ingest.ts` (new), `src\router\sessions.ts` (dispatch-facts registry), `test\unit\v2-hooks.test.ts` (append), `test\integration\routing-ingest.test.ts` (new) |
| 2.2 | `src\compat\v2-hooks.ts` (execute.before and context-hook sections; **starts after 2.1 merges**), `src\routing\wire\dispatch.ts`, `src\routing\wire\hint.ts` (new), `src\router\protocol.ts` (hook to swap the `R:` line), `test\integration\routing-dispatch.test.ts` (new), `test\unit\protocol.test.ts` (append) |
| 2.3 | `src\index.ts` (delegate ladder runner sections), `src\compat\v2-client.ts` (resume + model/agent on `native.execute`), `test\integration\routing-ladder-resume.test.ts` (new), `test\integration\delegate-timeout.test.ts` (append) |
| 2.4 | `src\routing\advisor\findings.ts`, `src\routing\advisor\index.ts` (new), `src\index.ts` (commands `/router`, `/annotate-plan`; **starts after 2.3 merges**), `test\integration\routing-advisor.test.ts`, `test\integration\annotate-plan-route.test.ts` (new) |
| 3.1 | `README.md`, `docs\ROUTING_ENGINE.md` (new), `docs\adr\0005-cost-aware-routing-engine.md` (new), `docs\CONFIG_REFERENCE.md` (routing section polish), `docs\plans\README.md`, `CHANGELOG.md` |
| 3.2 | `test\smoke\routing-engine.smoke.test.ts` (new), `test\smoke\helpers\scripted-provider.ts` (extend scripts; may add an OpenAI-Responses script mode for scenario 7), `package.json` (Wave 3 owner: `smoke:routing` script) |
| 3.3 | `docs\qa\cost-aware-routing\global.md` |
| 3.4 | `package.json`, `package-lock.json`, `CHANGELOG.md` (release entry), `docs\qa\cost-aware-routing\dogfood.md` (final report), `docs\adr\0005-cost-aware-routing-engine.md` (evidence section only), tags |

---

## 3. Waves, phases, tasks

### Dependency graph

```
0.P ─┬─> 1.1 ─┬─> 1.4 ─┬─> 2.2 ─> 2.4 ─> 3.1 ─> 3.2 ─> 3.3 ─> 3.4
     ├─> 1.2 ─┤        │
     ├─> 1.3 ─┘        │
     └─> 1.5 ──────────┴─> 2.3 ─┘
                 2.1 ─────────> 2.2        (2.1 depends on 1.3)
```

Wave 1: 1.1, 1.2, 1.3, 1.5 start in parallel after 0.P; 1.4 starts when 1.1, 1.2 and 1.3 are merged. Wave 2: 2.1 starts when 1.3 is merged (it may overlap Wave 1's tail); 2.2 after 1.4 and 2.1; 2.3 after 1.5 and 2.1; 2.4 after 2.2 and 2.3 (it owns `src\index.ts` after 2.3 releases it). Wave 3 is serial.

---

### Phase 0.P — Execution pre-flight (once) `[tier:fast]` (+ `[tier:heavy]` spike verdicts)

**Goal.** Prove the six host hypotheses of §1.7 on the owner's real OpenCode 2.0.22, locate runtime directories, and freeze planning-time facts.

**Pre-flight (phase-specific).**
- [ ] `opencode --version` prints `v2.0.22`; `node_modules\@opencode\plugin\package.json` in the worktree is `2.0.22`.
- [ ] `git -C D:\git\opencode-model-router status` clean on `master` at `968bf0f` or later; create `car/main` from it and `D:\git\omr-car-main`.
- [ ] Linear check (§0.10.9).

**Tasks.**
- 0.P.1 `[tier:fast]` Create the spike harness `D:\git\opencode-model-router\test\smoke\routing-spikes.smoke.test.ts` from `D:\git\opencode-model-router\test\smoke\depth-effort.smoke.test.ts` and `D:\git\opencode-model-router\test\smoke\helpers\scripted-provider.ts` (v2 host only). Each spike is one `it(...)` that records evidence to `D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-0P.md`.
  - 0.P.1.a S1: a test plugin hook reassigns `event.input` for `subagent` with `agent: "general"` → `"explore"` and `model: "<fast model>#<variant>"`; assert the child session's `agent` and `model` via `ctx.session.get`.
  - 0.P.1.b S2: dispatch, then resume with `sessionID` + higher variant; assert `session.model.variant` changed and message count grew (history kept); then resume with a different `agent`; assert `session.agent`.
  - 0.P.1.c S3: subscribe to `ctx.event.subscribe`; assert a `session.step.ended` for the child with `cost` and `tokens` fields; record the shape verbatim.
  - 0.P.1.d S4: dump `ctx.model.list()` (or the adapter's catalog call) for the owner's tiers' models: `variants[].id` in order, `cost[]`, `limit.context`. Record for `anthropic/claude-sonnet-5-5`, `anthropic/claude-opus-5-5`, `anthropic/claude-haiku-4-5`, `openai/gpt-6-luna`, `opencode/deepseek-v4.1-flash` (if the provider is configured).
  - 0.P.1.e S5: call `POST /api/experimental/generate` through the plugin's v2 client with `model` = the cheapest priced model; assert `data.text` non-empty; record latency.
  - 0.P.1.f S6: resume a child after `switchModel` to a model with a smaller `limit.context` and a prompt sized above it; record whether compaction ran or an error surfaced.
- 0.P.2 `[tier:fast]` Locate the directory where `*.scorecard.log` is written (`D:\git\opencode-model-router\src\index.ts` ≈1710–1720) and record its absolute path on this machine; confirm it is writable and outside any git worktree.
- 0.P.3 `[tier:fast]` Record the exact current protocol text and `R:` line for the shipped `D:\git\opencode-model-router\tiers.json` into `D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-0P.md` (Phase 1.4's snapshot test uses it).
- 0.P.4 `[tier:heavy]` Read the spike evidence and issue a verdict per hypothesis (`confirmed` / `confirmed with caveat` / `disproven → alternative <id>`), amending §1.5/§1.7 in this plan file under "Amended during implementation" if needed.
- 0.P.5 **Orchestrator — do this first, before any worktree exists.** Commit this plan, `D:\git\opencode-model-router\docs\plans\README.md` and `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md` on `master` (`docs(plans): add cost-aware routing engine plan (#74)`), push, then create `car/main` from that commit and the worktree `D:\git\omr-car-main`. Nothing else is ever committed on `master` outside §0.6.8.
- 0.P.6 `[tier:fast]` Locate the **active router config** of the running host: follow `loadConfig(ctx.location.directory)` in `D:\git\opencode-model-router\src\router\config.ts` (resolution order, global path), run `/router` in the executing session and match its reported preset/tiers against the candidate files. At planning time the session reported preset `hybrid-2` while `D:\git\opencode-model-router\tiers.json` holds `anthropic`, so the active file is **not** the repo's. Record the absolute path, the active preset and the current `routing` block (if any) in `phase-0P.md` and in the handover. This path is the only config the checkpoints edit.
- 0.P.7 `[tier:fast]` Spike S7 — **code liveness after a sync.** Create an empty worktree-free probe: tag `master`, append nothing; instead verify how the host loads the plugin (bundled at startup vs. read on each session) by reading `D:\git\opencode-model-router\docs\OPENCODE_V2.md` "Loading" and the host's plugin loader (`packages/core/src/plugin/host.ts` and `packages/plugin/src/host.ts` at `v2.0.22`). Record whether a code change on disk is picked up without a restart. This decides whether DF1–DF4 will stop for restarts; it does not change the procedure.
- 0.P.8 **Orchestrator** DF0 baseline: from the scorecard directory (0.P.2), count the planning session's dispatches, false refusals and verdicts; write `## DF0` in `D:\git\opencode-model-router\docs\qa\cost-aware-routing\dogfood.md` with those counts and the active config snapshot; write the first handover (§0.11) with "next task id: 1.1.1".

```
[acceptance]
cwd: D:\git\omr-car-p0p
check: run command="npx cross-env RUN_OC_SMOKE_V2_SPIKES=1 npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts" expect=passed
criteria: (amended, QA-0P-17/30) the check runs every isolated-host spike (S1, S1-deny, S2, S2-agent-native, S2b, S3, S3b, S5, S6, cleanup) with S4 skipped; S4 runs only under the manual opt-in `RUN_OC_SPIKE_LIVE_CATALOG=1` (read-only GETs of the live service) and skips, never fails, when the live location is absent; committed evidence comes from one run (same runId, fresh recordedAt); phase-0P.md holds verbatim evidence and a heavy verdict per hypothesis; scorecard directory and active config path recorded; plan, index and handover committed on master; DF0 written
deliverable: D:\git\omr-car-p0p\docs\qa\cost-aware-routing\phase-0P.md
[/acceptance]
```

**Acceptance criteria.** All seven spikes ran; every verdict is written; any disproven hypothesis has its alternative selected in the plan; no spike left the host's data directory with orphan sessions (cleanup asserted); the active config path is known and recorded; DF0 is written.
**Definition of Done.** Spike test committed and green; `phase-0P.md` complete; plan, index and handover committed on `master`; `car/main` and `D:\git\omr-car-main` exist; `dogfood.md` has `## DF0`; heavy QA of the spike evidence has zero open findings.
**QA.** `[tier:heavy]` adversarial review of the spike design: does each spike actually test the hypothesis it claims (e.g. S1 must assert the *child session*, not the hook's own variable)?

---

### Wave 1 — Final components (parallel)

#### Phase 1.1 — Configuration surface (M1) `[tier:medium]`

**Goal.** `routing.*`, `tiers.<t>.candidates[]`, `enforcement.escalate.variantSteps` parsed, validated, defaulted, documented. Hot reload covered.

**Pre-flight.** Standard + read `D:\git\opencode-model-router\src\router\config.ts` validation style (≈819–830 for `taskPatterns`) and the existing `EnforcementConfig` (≈124–179).

**Tasks.**
- 1.1.1 Types: `RoutingConfig`, `ClassifierConfig`, `OutcomesConfig`, `AdvisorConfig`, `SessionReuseConfig`, `TierCandidate` added to `D:\git\opencode-model-router\src\router\config.ts`; `TierConfig.candidates?: TierCandidate[]`; `EscalateConfig.variantSteps?: "auto" | "none"`.
- 1.1.2 Validation in `validateConfig`: enums; `margin ∈ [0, 0.9]`; `minClassConfidence ∈ [0, 1]`; `detection.* ∈ [0, 1]`; `classifier.backend != rules` ⇒ `model` is a non-empty `provider/model[#variant]` string (D3); `openai-compatible`/`typesafe` ⇒ `baseUrl` is an `http(s)` URL; `timeoutMs ∈ [100, 30000]`; `samples ∈ {1, 3}`; `maxStateChars ∈ [200, 20000]`; `roles` values are non-empty arrays of agent ids (format `^[a-z0-9_-]+$`); `candidates[]` entries inherit the tier's `model` when omitted, must not repeat `(model, variant)`, `costRatio > 0`; `outcomes.halfLifeDays ∈ [1, 365]`; `maxEffectiveSamples ∈ [5, 1000]`; `sessionReuse.maxContextFraction ∈ (0, 0.95]`; `advisor.noticeIntervalHours ∈ [1, 720]`.
- 1.1.3 Defaults: a `resolveRouting(cfg)` accessor returning a fully-populated, frozen object (never `undefined` fields downstream); `resolveCandidates(tierName, cfg)` returning the ladder for a tier (default: the single `(model, variant, costRatio)` of the tier).
- 1.1.4 Hot reload: confirm the existing reload path returns the new fields; add nothing new to the reload mechanism.
- 1.1.5 `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md`: a `routing` section with every key, type, default, range and one example per `engine` mode; `candidates`; `variantSteps`; the v2 default of `roles` and the v1 text-only opt-in (D1, D12).
- 1.1.6 Build marker for the liveness probe (§0.11): `D:\git\opencode-model-router\src\router\build-info.ts` exporting `{ version, sha }` where `version` is the package version and `sha` is read at load time from `D:\git\opencode-model-router\.git\HEAD` → ref file (best-effort, `"unknown"` when unavailable, never throws); `/router` output gains one line `router: engine=<mode> build=<version>+<sha7>`. Check in pre-flight whether the repo has a build step (`package.json` scripts) — if it does, the sha is emitted at build time instead and the runtime read is the fallback.
- 1.1.7 Host-aware defaults: `resolveRouting(cfg, host: "v1" | "v2")` applies the `roles` default per D12 and coerces `engine` to `static` on v1 (D1), returning the applied values so `/router` can show them.

**Tests (new `D:\git\opencode-model-router\test\unit\config.routing.test.ts`; append to `config.validate.test.ts`).** Every validation rule above has a passing and a failing case; `classifier.backend: "host"` without `model` throws with a message naming the key; `candidates` with a duplicate `(model, variant)` throws; `candidates` omitting `model` inherits; unknown keys inside `routing` are rejected (consistent with the file's existing policy — check and match); `resolveRouting` on an empty config equals the documented defaults (snapshot) **per host**: v2 → D12 default roles, v1 → `{}` and `engine: static` even when the file says `enforce`; `roles: {}` on v2 yields no native candidates; `resolveCandidates` for a tier without `candidates` returns exactly one entry; a `routing` block on a config whose active preset lacks a tier named in `roles` is accepted (roles may reference native agents) but `roles` naming an empty string is rejected; `build-info` returns `"unknown"` sha without throwing when `.git` is absent, and the `/router` line format is pinned.

**Acceptance criteria.** All rules validated and documented; defaults snapshot pinned; existing config tests unchanged and green.
**Definition of Done.** Typecheck green; `npx vitest run test/unit/config*.test.ts` green; docs section complete; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: find a config that passes validation but crashes a downstream consumer (e.g. `margin: 0.9` with `profile: safe`), inconsistent defaults between code and docs, and reload regressions.

#### Phase 1.2 — Task classifier (M2) `[tier:heavy]` design of the rules and the backend contract + `[tier:medium]` implementation

**Goal.** `classify(input): Promise<TaskFacts>` with four sources, bounded, never throwing.

**Pre-flight.** Standard + `[tier:fast]` pastes `classifyTrivial` and its regexes (`D:\git\opencode-model-router\src\router\sessions.ts` ≈240–331) and the shipped `taskPatterns` into the heavy design dispatch.

**Tasks.**
- 1.2.1 `[tier:heavy]` Design `D:\git\opencode-model-router\src\routing\classify\types.ts`: `TaskClass = "search" | "recon" | "mechanical" | "implement" | "debug" | "design" | "review" | "other"`, `Risk`, `Scope`, `Need = "shell" | "web" | "edit" | "network" | "external_dir"`, `TaskFacts { class, risk, scope, needs, confidence, source: "rules" | "route-line" | "plan" | "host" | "openai-compatible" | "typesafe" | "unknown" }`, the `ClassifierBackend` interface (`classify(state, options) → { facts, raw }`, `classifyMany(states[])` for plan fan-out), and the rules table: keyword sets per class derived from `taskPatterns` **plus** shape gates; `needs` inferred from verbs/tools named (`rg`, `git`, `npm` → shell; `http`, `fetch`, `docs` → web; `edit`, `implement`, `fix` → edit).
- 1.2.2 `[tier:medium]` `rules.ts`: deterministic, pure, < 1 ms; exports `classifyByRules(text, cfg): TaskFacts` with confidence from keyword agreement (one class matched → 0.8; two classes → 0.5 with the higher-cost class winning; none → `other`/0.2). Export the shape regexes from `sessions.ts` without changing `classifyTrivial`.
- 1.2.3 `[tier:medium]` `route-line.ts`: parse/strip `[route class=… risk=… scope=… needs=…]` (D13); tolerant to order, spacing and unknown fields; returns `{ facts, stripped }`; source `route-line` (confidence 0.9) or `plan` when the line carries `d=`.
- 1.2.4 `[tier:medium]` Backends (D14): `host.ts` (`ctx.generate.text({ prompt, model })` from the plugin context with explicit `model` — amendment A4: resolves at the dispatching location, never the raw `/api/experimental/generate` route; unit tests use a fake `ctx.generate`; prompt = fixed English instruction + shuffled options + state; parse the single label; validate against the option set; invalid → `unknown`), `openai-compatible.ts` (chat completions with `response_format` JSON schema when available, else the same parse; `apiKeyEnv` read at call time; `samples: 3` → majority with agreement as confidence), `typesafe.ts` (`POST https://api.typesafe.ai/v1/systemone` with one `choice` per fact; `confidence` from the answer; `apiKeyEnv` required). All three: `timeoutMs` via `AbortController`, errors → `unknown` with a logged reason, no retries, no state beyond D14.
- 1.2.5 `[tier:medium]` `index.ts`: `classify()` composition in the order rules → route line (overrides rules when present) → backend (only when `confidence < minClassConfidence` and a backend is configured) → final; `classifyMany()` for plans (rules per item, one batched backend call, per-item validation, rules fallback).

**Tests (`D:\git\opencode-model-router\test\unit\routing-classify.rules.test.ts`, `-route-line.test.ts`, `-backends.test.ts`, `-index.test.ts`).** Rules: each class has ≥3 positive prompts and ≥2 adversarial negatives (e.g. "do not refactor" still matches `review`, "grep then implement" → `implement`); shape gates reproduce `classifyTrivial` on its own fixtures; `needs` inference including `rg --no-ignore` → shell; empty/whitespace/10 kB prompts; non-English prompt → confidence capped at 0.5. Route line: every field optional; duplicated line → first wins and both stripped; malformed `needs` ignored; `d=` sets source `plan`. Backends (mocked HTTP): label outside the option set → `unknown`; timeout → `unknown` within `timeoutMs + 50 ms`; non-JSON → `unknown`; `samples: 3` with 2/3 agreement → confidence 0.67; option shuffle changes the request but not the parse; state truncation at `maxStateChars` with the `[acceptance]` block preserved whole when it fits; secrets: `apiKeyEnv` unset → backend disabled with a logged reason, never a thrown error. Index: backend not called when rules are confident; backend called once per `classifyMany` for 50 items; backend failure leaves rules facts.

**Acceptance criteria.** `classify` never throws or hangs; every source documented; `classifyTrivial` behaviour and its tests unchanged.
**Definition of Done.** Typecheck green; classify tests green; no network in unit tests; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: prompt injection through the task text into the backend instruction; state leaks beyond D14; non-determinism in rules; mislabeled high-risk tasks as `mechanical`.

#### Phase 1.3 — Outcome store and cost accounting (M3) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal.** A pure, testable store: posteriors, costs, decay, cost-unit rule, bounded persistence.

**Pre-flight.** Standard + the scorecard directory path from 0.P.2; the `session.step.ended` shape from S3.

**Tasks.**
- 1.3.1 `[tier:heavy]` Design `D:\git\opencode-model-router\src\routing\outcomes\beta.ts` (Beta with exponential decay by `halfLifeDays` applied lazily on read, effective-sample cap `maxEffectiveSamples`, priors per D7), `cost.ts` (per-key cost statistics: `measuredUSD` mean/n, `tokens` mean by field, `finalMessageTokens` mean for `tax`, the D5 unit rule as `compareUnit(candidates) → "usd" | "ratio"`, the D6 null rule), `store.ts` (key `${class}|${agent}|${provider}/${model}#${variant ?? "default"}`, `recordVerdict`, `recordFalseRefusal`, `recordStep`, `posterior(key)`, `cost(key)`, `snapshot()`), `persist.ts` (D15: atomic JSON write, JSONL decision log with rotation, load with schema version and corruption recovery → fresh store + logged warning).
- 1.3.2 `[tier:medium]` Implement all four modules; no I/O in `beta`/`cost`/`store`; `persist` is the only module touching disk, injected clock and fs for tests.
- 1.3.3 `[tier:medium]` Self-measurement surface (D18): `D:\git\opencode-model-router\src\routing\outcomes\stats.ts` — `summarize(store, decisions, { since, until }) → StatsTable` with exactly the columns of §0.11 "What is measured" (dispatches, by class, by key, agreement rate, switched count/share, pinned count, estimated savings in the decision unit, measured USD per dispatch where available, false-refusal rate per key, verdict rates per key, variant steps taken and pass rate, resume-vs-fresh counts) and `renderMarkdown(table)`; pure, no I/O. `D:\git\opencode-model-router\scripts\routing-stats.ts`: reads the store JSON and `decisions.jsonl` from the directory of D15 (or `--dir`), accepts `--since <ISO>` / `--until <ISO>` / `--json`, prints the markdown table; exits non-zero on a corrupted store with a clear message. `package.json` script `"routing:stats": "npx tsx scripts/routing-stats.ts"` (confirm `tsx` availability in pre-flight; fall back to `node --import tsx` or a `bun` invocation matching the repo's existing scripts).

**Tests (`D:\git\opencode-model-router\test\unit\routing-outcomes.beta.test.ts`, `.cost.test.ts`, `.store.test.ts`, `.persist.test.ts`, `.stats.test.ts`).** Stats: empty window → all zeros, no NaN; agreement with 0 non-pinned rows → `n/a`, not division by zero; mixed units in a window → savings reported per unit separately, never summed; `--since` boundary inclusive; markdown renders deterministically (snapshot); the script runs against the fixture directory and matches the module output byte for byte. Beta: prior means per D7 for ranks −2..+2; `pass`/`fail`/`refusal` updates; `unverifiable` no-op; decay halves counts after `halfLifeDays`; cap keeps mean within 1e-9 when counts exceed the cap; clock going backwards does not inflate counts. Cost: unit rule with 0/1/all priced candidates; `cost == 0` with empty pricing → null and excluded from means; token means per field; `finalMessageTokens` separated from step tokens. Store: key normalisation (`default` variant), unknown key → prior, snapshot round-trip equality, 10 000 records performance under 50 ms. Persist: atomic write leaves no partial file on simulated crash; corrupted JSON → fresh store + warning; JSONL rotates at the limit; concurrent flush calls coalesce.

**Acceptance criteria.** Pure core, injected I/O, every D-rule covered by a test.
**Definition of Done.** Typecheck green; outcome tests green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: numeric stability (α, β overflow/underflow), key collisions between native and router agents with the same id, decay drift, persistence races with the existing scorecard writer.

#### Phase 1.4 — Decision kernel, protocol line and plan fan-out (M4) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal.** `decide(facts, candidates, store, cfg) → Decision`, `generateTaxonomy(store, cfg) → string`, `annotateSteps(steps, …)`; the degenerate case equals the static taxonomy.

**Pre-flight.** Standard + 1.1, 1.2, 1.3 merged; 0.P.3 snapshot available.

**Tasks.**
- 1.4.1 `[tier:heavy]` Design `D:\git\opencode-model-router\src\routing\engine\ladders.ts` (build candidate ladders: for each tier, `candidates[]` in order; `next(k)` = next variant of the same model, then the first candidate of the next tier; `routing.roles[class]` agents appended with their inherited rank; permission filter against `needs`; cycle guard), `kernel.ts` (D8 recursion with memoisation; `U` by profile and risk; `d` by detection; the D9 margin rule; `Decision { chosen, best, switched, confidence, reason, costs: Record<key, number>, unit }`), `protocol-line.ts` (the `R:` line from argmin per class; identical to `buildTaskTaxonomy` output when the store is empty and `roles` is empty — enforced by the snapshot test), `plan.ts` (`annotateSteps`: `[tier:X]` + `[route …]` per step; `d` inferred from each step's `[acceptance]` checks).
- 1.4.2 `[tier:medium]` Implement; pure functions only; < 2 ms per decision for 12 candidates.

**Tests (`D:\git\opencode-model-router\test\unit\routing-engine.ladders.test.ts`, `.kernel.test.ts`, `.protocol-line.test.ts`, `.plan.test.ts`).** Ladders: single-candidate tiers; variants before models; roles with native agents, including the v2 default roles (D12) — `explore` gets its own configured model first, then the `fast` ladder; `general` gets its model then the `medium` ladder; `needs: [shell]` excludes `explore`; empty ladder after filtering → decision `kept` with reason; cycle in `next` impossible by construction (property test over random ladders). Kernel: `pin` → `kept`, `pinned: true`, `best` still computed. Kernel: worked examples from the design discussion — `p = (0.6, 0.9, 0.95)`, `U = 100`: `d = 1` → fast; `d = 0.5` → medium (asserted numerically); margin exactly at the boundary → `kept`; `risk high` + `d none` never moves down; `unit` switches to ratio when one candidate is unpriced; `tax` is 0 when unmeasured; terminal give-up cost; memoisation does not leak across calls. Protocol line: **snapshot equality with 0.P.3** for the shipped `tiers.json` and an empty store; a store with strong evidence moves `search` to `explore` when listed in `roles`; deterministic ordering. Plan: 20-step plan annotated in one pass; existing `[tier:X]` tags preserved; `[acceptance]` with `testsPass` → `d=deterministic`.

**Acceptance criteria.** D2 proven by test; D8/D9 covered numerically; pure and fast.
**Definition of Done.** Typecheck green; engine tests green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: find inputs where the kernel prefers an infinite escalation, mis-compares units, or where `generateTaxonomy` differs from the static line by whitespace.

#### Phase 1.5 — Session-aware ladder algebra (M5) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal.** `nextAction` gains variant steps and resume decisions without changing any existing golden output when `variantSteps` is `none` or the host is v1.

**Pre-flight.** Standard + S2/S4/S6 verdicts; `[tier:fast]` pastes `D:\git\opencode-model-router\src\escalate\ladder.ts` and the golden fixtures list into the heavy dispatch.

**Tasks.**
- 1.5.1 `[tier:heavy]` Design `D:\git\opencode-model-router\src\escalate\variants.ts` (`VariantLadder` from catalog `variants[].id` in catalog order ∪ explicit `candidates`, `nextVariant(model, current)`, validation against the catalog), and the ladder extension: `LadderState` gains `currentVariant`, `variantSteps`, `childSessionID`, `lastStepTokens`, `nextModelContext`; `LadderAction` gains `variant`, `model`, `agent`, `resume: boolean`; `nextAction` order becomes accept → unverifiable → cost ceiling → max total → **variant step (D10)** → retry within tier (existing) → escalate; `advance` updates the new fields; `resumeDecision(state, cfg)` per D11.
- 1.5.2 `[tier:medium]` Implement with the existing goldens untouched: with `variantSteps: "none"` or no catalog, every existing test and fixture passes byte-identical.

**Tests (`D:\git\opencode-model-router\test\unit\escalate-variants.test.ts`; append to `ladder*.test.ts`).** Variant ladder from `[low, medium, high, xhigh]`; current `xhigh` → no next; unknown current → first above base; explicit `candidates` override catalog order; variant steps count toward `maxTotalAttempts` and cost ceiling but not `maxAttemptsPerTier`; `maxAttemptsPerTier: 1` + `variantSteps: auto` still yields one variant retry before escalation; resume decision at exactly the threshold → fresh; context limit of the **next** model used; `escalate` carries `resume: true` only under the threshold; goldens: run the full existing ladder suite with the new fields defaulted and diff outputs (must be empty).

**Acceptance criteria.** New algebra fully tested; existing goldens byte-identical.
**Definition of Done.** Typecheck green; ladder suites green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: infinite variant loops, off-by-one in attempt counting, resume with a stale `childSessionID` after a fresh start, cost-ceiling bypass through variant steps.

#### Checkpoint DF1 — after Phases 1.4 and 1.5 are merged (orchestrator only, §0.11)

Sync `master` ← `car/main` (rollback tag first); liveness probe via `/router` (`build=` marker from 1.1.6); confirm the live protocol text and `R:` line are byte-identical to 0.P.3 (the live session is the D2 proof on real traffic); run `npm run routing:stats` (empty store expected — the script must handle it); record `## DF1` in `dogfood.md`; mode stays `static`; rewrite the handover ("next task id: 2.1.1"). If the probe is stale → restart request (§0.1.4), then resume from the handover.

---

### Wave 2 — Integration on OpenCode v2

#### Phase 2.1 — Telemetry ingestion (M6) `[tier:medium]`

**Goal.** Child-session outcomes and costs flow into the store on v2.

**Pre-flight.** Standard + 1.3 merged + S3 verdict.

**Tasks.**
- 2.1.1 Dispatch-facts registry in `D:\git\opencode-model-router\src\router\sessions.ts`: `rememberDispatch(childSessionID, { facts, agent, model, variant, tier, acceptance, parentSessionID })` keyed by child session, TTL-swept with the existing store sweeper.
- 2.1.2 `D:\git\opencode-model-router\src\routing\outcomes\ingest.ts`: handlers `onStepEnded(event)`, `onVerdict(childSessionID, outcome)`, `onFalseRefusal(childSessionID)`, `onSessionGone(childSessionID)` → store calls per D4/D6; flush scheduling per D15.
- 2.1.3 `D:\git\opencode-model-router\src\compat\v2-hooks.ts` event loop (≈417–435): add the `session.step.ended` branch (child sessions only, by registry membership) and `session.idle`/`session.deleted` flush; wire verdict and false-refusal call sites (the verification `tool.execute.after` path and the `FALSE-REFUSAL` banner site) to `ingest`. v1 code untouched (D1).

**Tests (`D:\git\opencode-model-router\test\integration\routing-ingest.test.ts`; append `test\unit\v2-hooks.test.ts`).** Fake `ctx.event.subscribe` stream: step events for an unknown session ignored; for a registered child → store updated with cost/tokens; `cost: 0` + unpriced model → null; verdict `pass`/`fail`/`unverifiable` effects; false refusal → failure; registry TTL eviction stops ingestion; flush coalescing; event loop survives a throwing handler (logged, loop continues); 1 000 events under 100 ms.

**Acceptance criteria.** Every outcome signal reaches the store on v2; nothing on v1.
**Definition of Done.** Typecheck green; ingest tests green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: event ordering (verdict before last step), double counting on resumed sessions, registry memory growth, disk writes on the dispatch hot path.

#### Phase 2.2 — Dispatch-time routing on v2 (M7) `[tier:heavy]` hook design + `[tier:medium]` implementation

**Goal.** `shadow`, `advise`, `enforce` live in `execute.before` and the context hook; `[route …]` parsed and stripped; plan annotations honoured; `R:` line generated.

**Pre-flight.** Standard + 1.4 and 2.1 merged + S1 verdict; `[tier:fast]` pastes the `execute.before` block (`v2-hooks.ts` ≈312–347) and the context-hook block (the system-transform bridge, ≈278) into the heavy dispatch.

**Tasks.**
- 2.2.1 `[tier:heavy]` Design `D:\git\opencode-model-router\src\routing\wire\dispatch.ts`: `routeDispatch(event, cfg, store, catalog) → { input, decision }` composing M2 → ladders → M4; ordering relative to the existing `subagentTiers` override (engine first; `subagentTiers` only fills a missing `model`), the legacy `tool.execute.before` (runs after routing so headers see the final agent), `[route …]` stripping before header injection, and `enforce` writing `agent`/`model` into the returned input per D9. Design `hint.ts`: the per-turn suggestion text (≤ 2 lines, agent id + description + reason) and the generated `R:` swap in the context hook.
- 2.2.2 `[tier:medium]` Implement `dispatch.ts`, `hint.ts`; wire in `v2-hooks.ts` `execute.before` and the context hook; add the `protocol.ts` seam (`buildTaskTaxonomy` accepts an optional precomputed line); `rememberDispatch` call after the final input is known; decision logged to the JSONL (D15) in every mode except `static`.
- 2.2.3 `[tier:medium]` Protocol text for `advise`/`enforce`: one paragraph instructing the orchestrator to add the `[route …]` line (D13), to add `pin` when the tier is mandated by a plan tag or by policy (QA, §0.10.12), and to read the per-turn hint; never mentions `model` (§0.10.11). `static`/`shadow` protocol text unchanged (snapshot).
- 2.2.4 `[tier:medium]` Decision log rows per §0.11 "What is measured" (`pinned`, `switched`, `best`, `chosen`, `unit`, `costs`, `confidence`, `reason`, timestamps), written through the D15 persister in every mode except `static`.

**Tests (`D:\git\opencode-model-router\test\integration\routing-dispatch.test.ts`; append `test\unit\protocol.test.ts`).** Fake v2 ctx (pattern of `test\unit\v2-hooks.test.ts`): `static` → input untouched, no log; `shadow` → input untouched, decision logged with `switched` computed; `advise` → input untouched, hint present in context output, `R:` line replaced only when the store has data; `enforce` + margin satisfied → `event.input.agent`/`model` replaced, header still injected, `[route …]` stripped; `enforce` + margin not satisfied → `kept`; `enforce` + `[route pin]` → input untouched, row has `pinned: true` and a computed `best`; the `pin` line is stripped like the others; `needs: [shell]` with `explore` best → `kept` with reason; `subagentTiers` interplay both ways; classifier backend timeout → rules facts, dispatch proceeds; plan `[route … d=…]` authoritative; `event.input` reassignment preserves unrelated fields (`background`, `sessionID`); latency of the local path < 5 ms over 100 dispatches; a throwing engine never blocks the dispatch (logged).

**Acceptance criteria.** All four modes behave as specified; snapshots prove `static` unchanged.
**Definition of Done.** Typecheck green; dispatch tests green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: hook ordering races with `subagentTiers` and the depth banner; prompt-injection via `[route …]` crafted by a delegate's output (a `pin` or a class smuggled through a tool result must not reach the parser: only the orchestrator's own prompt text is parsed); enforce moving a `high`-risk task down; hint text that contradicts the generated `R:` line.

#### Checkpoint DF2 — after Phase 2.2 is merged (orchestrator only, §0.11) → `shadow`

Sync `master` ← `car/main`; liveness probe; `routing:stats --since <DF1>` recorded as `## DF2` (static period); set `routing.engine: shadow` in the active config (0.P.6); confirm via `/router` (`engine=shadow`); from this point every dispatch of the plan — including Phase 2.3, 2.4 and Wave 3 — writes a decision row and feeds the store. Start adding `[route pin]` to QA and `[tier:heavy]` dispatches (§0.10.12). Status to the human; handover rewritten ("next task id: 2.3.1").

#### Phase 2.3 — Ladder wiring: resume with variant/model on v2 (M5 in `delegate`) `[tier:medium]` (+ `[tier:heavy]` for the runner changes)

**Goal.** `delegate` retries resume the child with `sessionID` + `model#variant` (and `agent` on escalation) per D10/D11; fresh sessions remain the fallback.

**Pre-flight.** Standard + 1.5 and 2.1 merged + S2/S6 verdicts; `[tier:fast]` pastes `D:\git\opencode-model-router\src\index.ts` ≈600–1020 and `src\compat\v2-client.ts` ≈60–110 into the heavy dispatch.

**Tasks.**
- 2.3.1 `[tier:heavy]` Runner design: `runProducerAttempt` gains `{ resumeSessionID?, model?, agent?, forcingMessage }`; on v2, `native.execute` receives `sessionID` and `model` (`provider/model#variant`) and `agent`; the per-attempt discard (≈949–954) is skipped when the next action resumes; catalog variant validation before the call (ToolFailure otherwise → fall back to fresh session + `effortOverrides`, logged).
- 2.3.2 `[tier:medium]` Implement in `src\index.ts` and `src\compat\v2-client.ts`; v1 runner unchanged; `LadderState` fed with `lastStepTokens` from the registry (2.1).

**Tests (`D:\git\opencode-model-router\test\integration\routing-ladder-resume.test.ts`; append `delegate-timeout.test.ts`).** Fail → variant step resumes the same `sessionID` with `model: same#next` and the forcing message as the prompt; second fail with no higher variant → escalate with `agent` switch, resume when under threshold, fresh when over; `variantSteps: none` → today's behaviour (diff against existing fixtures); invalid variant from catalog → fresh + `effortOverrides`; timeouts and cancellation still interrupt resumed children; cost ceiling counts resumed attempts; v1 path unchanged (existing tests).

**Acceptance criteria.** Resume path proven in integration; fallback proven; v1 untouched.
**Definition of Done.** Typecheck green; ladder/delegate suites green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: resumed session not a child of the current session (host rejects — handled?), background children, orphaned sessions on failure paths, forcing message duplication.

#### Phase 2.4 — Cost doctor, commands and plan annotation (M8) `[tier:medium]`

**Goal.** `/router` shows the advisor; once-per-interval notice; `/annotate-plan` emits `[route …]`.

**Pre-flight.** Standard + 2.2 and 2.3 merged; `[tier:fast]` pastes the `/router` and `/annotate-plan` command handlers (`src\index.ts` ≈1844–1864) and the config/catalog accessors.

**Tasks.**
- 2.4.1 `D:\git\opencode-model-router\src\routing\advisor\findings.ts`: finding types with id, severity, message, suggested config snippet; checks per F4 (`agents.title.model`/`agents.summary.model` unset → suggest cheapest priced tool-call-capable model from the catalog; unpriced models in any ladder; `effort`/`variant` without a catalog variant; subscription-pricing caveat for providers `opencode`/`github-copilot`; `maxAttemptsPerTier: 1` with `variantSteps: none`).
- 2.4.2 `index.ts` of the advisor: `runAdvisor(cfg, hostConfig, catalog) → Finding[]`, throttled notice state persisted next to the outcome store.
- 2.4.3 `/router` output section "Cost doctor"; notice injection in the context hook (advise/enforce) or log (static/shadow).
- 2.4.4 `/annotate-plan`: call `classifyMany` + `annotateSteps`; `[route …]` after each `[tier:X]` (with `pin` when the step is tagged `[tier:heavy]` or is a QA step); existing output lines preserved verbatim (regression snapshot of the current command on the README example).
- 2.4.5 `/router stats [--since <ISO>]`: prints `renderMarkdown(summarize(...))` from 1.3.3 for the current store; `/router` (no args) gains the one-line engine/build marker (1.1.6) and the last checkpoint id read from `dogfood.md` if present.

**Tests (`D:\git\opencode-model-router\test\integration\routing-advisor.test.ts`, `annotate-plan-route.test.ts`).** Each finding fires and clears on the matching config; cheapest-model suggestion ignores models without `tool_call`; notice fires once per interval across restarts (persisted); `/annotate-plan` snapshot before/after on three plans (README example, this plan's §3 excerpt, a plan with no `[acceptance]` blocks); heavy-tagged steps get `pin`; batched classification called once; backend failure → rules; `/router stats` output equals the script output for the same store and window.

**Acceptance criteria.** Findings correct on the owner's config fixture (title/summary unset → finding present); annotation additive; stats in-session.
**Definition of Done.** Typecheck green; advisor/annotate tests green; QA zero open findings.
**QA.** `[tier:heavy]` adversarial: advisor suggesting a model the user cannot access, notice spam, annotation corrupting plans with nested code blocks.

#### Checkpoint DF3 — after Phase 2.4 is merged (orchestrator only, §0.11) → `advise`

Sync; liveness probe; `routing:stats --since <DF2>` recorded as `## DF3` (shadow period: agreement rate, would-switch count and share, estimated savings per unit, false refusals per key, verdict rates per key); set `routing.engine: advise`; **live classifier credential check (amendments A4/A13, QA-0P-26/38/39) — a bounded one-shot, run only if the owner has named the classifier model** (handover §2 "Owner decisions"; never chosen automatically): (1) in the override set `routing.classifier = { "backend": "host", "model": <owner's model>, "timeoutMs": 10000 }`; (2) trigger it deterministically with `/annotate-plan` on a two-step sample plan without `[route …]` lines (F3: one batched backend call); (3) record in `dogfood.md` `## DF3` the facts `source` per step, the latency and any verbatim error; (4) **immediately restore** `routing.classifier` to its absent/`rules` state in the override, whatever the outcome (the override is global and affects every session on the machine); (5) Phase 3.1.1 does not start until `## DF3` holds this result or the line "skipped: owner did not name a classifier model". `host` is documented as *experimental* unless step (3) shows `source: "host"` for both steps; confirm `/router` shows `engine=advise` and that the next orchestrator turn receives the generated `R:` line and a hint (the executor can see its own context); status to the human; handover ("next task id: 3.1.1"). Wave 3 runs under `advise`.

---

### Wave 3 — Document, prove, review, release

#### Phase 3.1 — Docs, ADR, changelog `[tier:medium]`

**Tasks.** `D:\git\opencode-model-router\docs\ROUTING_ENGINE.md` (concepts, the four modes, the formula with a worked example, the cost-unit and zero-cost rules, classifier backends with Ollama / OpenCode Go / TypeSafe examples, roles with native agents, session-aware ladder, cost doctor, privacy of D14, v1 note); `D:\git\opencode-model-router\docs\adr\0005-cost-aware-routing-engine.md` (context, decisions D1–D16, alternatives considered: tiers as agents only, Jev in the critical path, nested delegation); `README.md` section + links; `docs\CONFIG_REFERENCE.md` polish; `docs\plans\README.md` entry; `CHANGELOG.md` unreleased entry crediting #73.

**Tests.** `npx vitest run test/unit/docs*.test.ts` if the repo has doc-link tests (check in pre-flight); markdown link check on new files.
**Acceptance / DoD / QA.** Every config key documented with its default; every D-decision in the ADR; heavy QA reads the docs against the code and flags any divergence as `major`.

#### Phase 3.2 — End-to-end proof on real OpenCode 2.0.22 `[tier:medium]` (+ `[tier:fast]` runs)

**Tasks.** `D:\git\opencode-model-router\test\smoke\routing-engine.smoke.test.ts` using the scripted provider on the v2 host: (1) `shadow` — one dispatch, verify a decision row in the JSONL and a step record in the store; (2) `advise` — hint present in the child-less orchestrator context, `R:` line generated after seeding the store; (3) `enforce` — orchestrator asks for `heavy` on a `search` task with `testsPass`-free acceptance; engine swaps to the fast model; assert the child session's model; (4) ladder — scripted failing verification → resumed child with the next variant → pass; assert single child session and `tokens` growth; (5) advisor — `/router` output contains the title/summary finding on a config without them; (6) v1 untouched — run the existing `smoke:v1` suite unchanged; (7) OpenAI Responses effort delivery (amendment A7, QA-0P-26) — extend the scripted provider with an OpenAI-Responses script for a `gpt-6`-class model with variants, resume with a higher variant, and assert the effective effort on the wire (in-band or top-level); if the scripted provider cannot speak the Responses protocol, record `unverifiable` with the reason in `phase-3.2.md` and keep A7's caveat in `docs\ROUTING_ENGINE.md`. The real-credential `host` classifier check is owned by checkpoint DF3 (A4). `package.json` gains `smoke:routing`.

**Acceptance / DoD / QA.** Scenarios 1–6 green against the real host and scenario 7 green or `unverifiable` with a recorded reason, run serially (§0.6.9); evidence (session ids, store excerpts) in `phase-3.2.md`; heavy QA checks that each scenario asserts host state, not plugin logs alone.

#### Checkpoint DF4 — after Phase 3.2 is merged and green (orchestrator only, §0.11) → `enforce`

Sync; liveness probe; `routing:stats --since <DF3>` recorded as `## DF4` (advise period); set `routing.engine: enforce`, `routing.profile: balanced`, `routing.margin: 0.2`; confirm `/router`; verify on the very next non-pinned dispatch that the decision row has `switched` computed and, if switched, that the child session's model/agent match the row (`ctx.session.get` through the plugin client or the smoke helper); status to the human; handover ("next task id: 3.3"). Phases 3.3 and 3.4 run under `enforce` with pins on QA.

#### Phase 3.3 — Global senior QA review `[tier:heavy]` CAP:none — reason: whole-change adversarial review across every file of the plan.

Adversarial review of the whole diff `car/main` vs `v2.2.0`: D1 (v1 byte-identical: run v1 goldens and `smoke:v1`), D2 (static snapshot), D14 (privacy), D9 (never down on high risk without detection), persistence safety, hook ordering, docs vs code, test coverage of every D-rule, dead code, error swallowing (§0.10.10). Report `D:\git\opencode-model-router\docs\qa\cost-aware-routing\global.md`. Fix per §0.7 bounded rounds. Zero open findings before 3.4.

#### Phase 3.4 — Release `2.3.0` and local sync `[tier:medium]` (+ `[tier:fast]` verification)

**Tasks.**
- 3.4.1 **Checkpoint DF5 (orchestrator).** `routing:stats --since <DF4>` recorded as `## DF5` (enforce period). Apply D17: count switched dispatches with a `fail` verdict in the period; leave the active config at `enforce` if zero, else `advise`; write the rule, the counts and the result in `dogfood.md`. Write the `## Summary` of `dogfood.md`: one table across DF1–DF5 (dispatches, agreement, switched, savings per unit, measured USD where available, false refusals, variant steps and pass rate, restarts and time lost), plus the workload caveat (§0.11). Copy the summary table into the "Evidence" section of `D:\git\opencode-model-router\docs\adr\0005-cost-aware-routing-engine.md` and into the PR body.
- 3.4.2 Version bump; `CHANGELOG.md` release entry; PR from `car/main` to `master` closing #74 and #73 (body in English, credits #73 and TypeSafe's docs as inspiration, lists the modes, the v1 note and the dogfood summary); after merge: tag `v2.3.0`, publish per the repo's release process (check `D:\git\opencode-model-router\docs\MIGRATION.md`/release notes for the exact steps), sync `D:\git\opencode-model-router` `master`, remove worktrees `D:\git\omr-car-*` and the `car/sync-*-prev` tags, final `npx vitest run --maxWorkers=2` on `master`, post the closing comment on #74 and #73 with the dogfood summary, final status to the human in Portuguese including the mode left active (D17).

**Acceptance / DoD / QA.** Published package installs in a clean directory and loads on OpenCode 2.0.22 with the shipped `tiers.json` (static) without any new log line; `dogfood.md` has DF0–DF5 and the summary; the active config holds the D17 mode; heavy QA verifies the release artefacts, the clean-install check and that every number in the summary is reproducible from the store and the decision log with `routing:stats`.

---

## 4. Global acceptance, Definition of Done, QA

### 4.1 Global acceptance criteria

1. With no `routing` block, `2.3.0` is observationally identical to `2.2.0` on v1 and v2 (snapshots, goldens, `smoke:v1`, `smoke:v2`).
2. `shadow` records a decision and a cost/outcome row for every v2 dispatch without altering it.
3. `advise` injects the generated `R:` line and a per-turn hint; the protocol never asks the LLM to set `model`.
4. `enforce` swaps `agent`/`model#variant` only under D9 and is proven on the real host (3.2.3).
5. A failed verification on v2 retries on the same child with the next variant before escalating the model, and resumes or restarts per D11 (3.2.4).
6. Costs are USD where priced, `costRatio` otherwise, never mixed (D5); unpriced zero is unknown (D6).
7. The classifier never sends more than D14 allows and never blocks a dispatch.
8. The cost doctor reports the owner's unset `agents.title.model`/`agents.summary.model`.
9. `/annotate-plan` output is a superset of today's.
10. Every D-decision has at least one test naming it in its title.
11. Native agents are default candidates on v2 (`explore`, `general` per D12) and absent on v1 unless configured (D1); `roles: {}` disables them.
12. The plan measured itself: `dogfood.md` holds DF0–DF5 with `routing:stats` output for every period, every number reproducible from the store and the decision log; no pinned dispatch was ever switched (query over `decisions.jsonl`: `pinned && switched` = 0).
13. The restart protocol was followed every time a sync was not live: each restart is logged in `run-log.md` with its duration, and no merged work was redone after a resume.

### 4.2 Global Definition of Done

- All phases merged into `car/main` with zero open QA findings each; global QA zero open findings.
- `npm run typecheck` and the capped full suite green on `master` after the release merge.
- Docs, ADR 0005, CHANGELOG, plans index updated; README links resolve.
- `v2.3.0` tagged and published; clean install verified; worktrees removed; #74 and #73 closed with a final comment.

### 4.3 Global QA

Phase 3.3 as specified; the reviewer is a fresh `[tier:heavy]` dispatch with `CAP:none` and a `reason:` line, given the full diff and every phase QA report.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Host 2.0.22 ignores a swapped `agent` in `event.input` (S1) | `enforce` degrades to `model`-only; documented; still useful (same agent, cheaper rung) |
| Variant order from the catalog is not ascending effort (S4) | explicit `candidates` per tier; advisor finding when auto-discovery is disabled |
| Scoreboard bias: only the chosen rung is observed | escalations teach ("fast failed, medium passed"); priors from the static taxonomy; `shadow` first; no exploration in this release (recorded in ADR as future work) |
| Unpriced/subscription models distort costs | D5/D6; advisor caveat; `costRatio` as the universal fallback |
| Classifier backend latency on the hot path | `timeoutMs` 1.5 s default, async with rules result already computed; backend only when rules are unsure |
| Privacy of task text sent to a backend | D14 bound and documented; rules default; local Ollama recommended for `enforce` |
| Resumed sessions overflow the next model's context (S6) | D11 threshold on the smaller limit; fresh-session fallback |
| `src\index.ts` contention | single owner per wave (§2); 2.4 starts after 2.3 |
| A dogfood sync breaks the executing session's own plugin | syncs only after wave QA + full suite green; `routing.engine: static` is a hot-reloadable kill switch; `car/sync-<n>-prev` rollback tag; incident becomes a `critical` QA finding (§0.11 Rollback) |
| Host restarts lose the orchestrator's working context | handover rewritten before every restart request and at every checkpoint; "next task id" resumes without redoing merged work; the human observes and says when to resume |
| `enforce` downgrades a QA or heavy-mandated dispatch during the plan | `[route pin]` on every QA and `[tier:heavy]` dispatch (§0.10.12, D9, D13); acceptance 12 checks `pinned && switched = 0` |
| Dogfood numbers over-read as a benchmark | the workload caveat is mandatory in `dogfood.md`, the ADR and the PR; D17 uses only a safety rule (no switched dispatch failed), not a savings claim, to pick the final mode |

## 6. Out of scope

- OpenCode v1 behaviour changes of any kind.
- Exploration/bandit sampling of cheaper rungs (future work; ADR notes it).
- Raising `subagent_depth` or any nested delegation.
- A UI for the scoreboard; `/router` text output only.
- Changing the user's `opencode.json` automatically (the advisor only suggests).

## 7. Review log

### Revision 1 — initial plan (2026-10-05)

Written after verifying, in source, every host capability it relies on (OpenCode tag `v2.0.22`) and every plugin seam it extends (`v2.2.0`); the evidence and line references are in §1.1. Open items deliberately pushed to Phase 0.P spikes rather than assumed: S1–S6.

### Revision 2 — owner decisions and self-measurement (2026-10-06)

Owner decisions: (1) native agents (`explore`, `general`) are candidates **by default on v2**, opt-in on v1 as prose only (D1, D12 amended; 1.1.7, 1.4 tests); (2) the host pin `v2.0.22` acknowledged. Added at the owner's request: the plan **dogfoods itself** — §0.11 checkpoints DF0–DF5 raise `routing.engine` from `static` to `shadow`, `advise` and `enforce` as each mode is merged and proven, with the plan's own dispatches as the calibration workload; a scripted restart protocol when a code sync is not live (§0.1.4, handover file); `[route pin]` so QA and heavy-mandated dispatches are never switched (§0.10.12, D9, D13); built-in observability as a deliverable (D18: decision log columns, `src\routing\outcomes\stats.ts`, `scripts\routing-stats.ts`, `/router stats`, build marker for the liveness probe); D17 decides the final mode from the enforce-period numbers; new spike S7 (code liveness) and task 0.P.6 (active config path — the running session reported `hybrid-2` while the repo's `tiers.json` holds `anthropic`); acceptance 11–13; risks for syncs, restarts, pins and over-reading the numbers.
