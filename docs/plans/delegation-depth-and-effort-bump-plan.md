# Implementation Plan — Delegation Depth Limit (#66) and Effort Bump Before Escalation (#67)

> **Status:** Executing (revision 4: Phase 0.P amendments in §1.7, including two owner decisions of 2026-10-05; see §7)
> **Handover:** [`delegation-depth-and-effort-bump-handover.md`](./delegation-depth-and-effort-bump-handover.md)
> **Owner:** Marco Jardim
> **Executor:** one high-capability LLM orchestrator, start to finish, delegating per the `[tier:X]` annotations below.
> **Base:** `origin/master` at `v2.0.0` (merge commit `46f443f`). Target release: **`2.1.0`**.
> **Issues:** [#66](https://github.com/marco-jardim/opencode-model-router/issues/66) — enforce a hard limit on nested delegation depth;
> [#67](https://github.com/marco-jardim/opencode-model-router/issues/67) — raise reasoning effort on the same tier before escalating.
> Both split out of [#17](https://github.com/marco-jardim/opencode-model-router/issues/17).
> **Scope:** (1) a delegate can no longer dispatch past a configured depth, enforced in code on every in-process dispatch path;
> (2) the escalation ladder spends a same-tier retry at a higher reasoning effort before paying for a more expensive tier.

---

## 0. Execution directives (read first — these override defaults)

### 0.1 Run the whole plan without stopping

Execute Phase 0.P → Wave 1 → Wave 2 → Wave 3 continuously, iterating phase by phase and wave by wave,
**without pausing for confirmation**. Stop and ask the human **only** when one of these occurs:

1. **Ambiguity that only the human can resolve** — two or more valid readings of a requirement whose
   outcomes differ materially, and neither this plan (§1.5 decisions included) nor the code settles it.
2. **Critical problem** — a security regression (a way for a delegate to bypass the depth guard
   that the plan cannot close, an allowlist bypass), data loss risk (a git ref, a user file, the
   main checkout), or a published artifact that is broken.
3. **Blocking problem** — an assumption this plan depends on is disproven by a pre-flight spike and
   no alternative written in this plan applies, or the same failure persists after the recovery rule
   in §0.8.

Everything else — test failures, QA findings, type errors, merge conflicts, refactors needed to land a
phase — is work to be done, not a reason to stop.

### 0.2 Definitive solutions only

A high-capability agent executes this plan end to end. **Do not** ship stubs, TODO placeholders,
feature flags that hide half-built code, "phase 1 of N" partial behaviour, or temporary shims. Every
phase delivers the **final** implementation of its sub-objective:

- Wave 1 builds complete, final components (the config surface, the depth tracker, the effort
  algebra). Nothing in Wave 1 is replaced later; Wave 2 only consumes it.
- Wave 2 builds the final adapters and wires both features into the plugin. When Wave 2 closes,
  #66 and #67 are fully solved in code on both OpenCode v1 and v2.
- Wave 3 documents, proves end to end, reviews globally and releases. It adds no behaviour.

No phase exists only to be replaced later. If a phase finds that a component from an earlier phase
is wrong, it is **fixed** (in the owner's files, per §0.6), not worked around.

### 0.3 Commit often

- Commit at the end of **every subtask** that leaves the tree green (typecheck + the tests the subtask
  touches). Never commit a red tree.
- Conventional commits, matching the repo: `feat(router): …`, `feat(escalate): …`, `fix(router): …`,
  `test(router): …`, `test(escalate): …`, `docs(router): …`, `chore(release): …`. Reference the issue
  in the body (`Refs #66` / `Refs #67`).
- Push the phase branch after every commit, so no work exists only locally.
- QA fixes are their own commits: `fix(<scope>): address QA-<phase>-<n> <summary>`.
- **No AI attribution, ever:** no `Co-Authored-By` trailer naming a model or vendor, and no
  "Generated with …" line, in any commit or PR. Tell every delegate the same.
- **No `Co-authored-by` for @MetalbolicX either.** None of his code is used; credit for the
  observations goes in `CHANGELOG.md` and the PR body, linking #17 (the policy stated in #17 and
  applied in `c1b9f39`).

### 0.4 Paths

Every file reference in dispatches, commits, QA reports and code comments uses the **full path**.
Paths in this plan are written against the main checkout root `D:\git\opencode-model-router`.
Inside a phase worktree, the root is replaced by that worktree's root (for example
`D:\git\opencode-model-router\src\router\depth.ts` → `D:\git\omr-de-p12\src\router\depth.ts`).
The working directory `D:\git\Claude-model-router` resolves to the same repository
(`git rev-parse --show-toplevel` → `D:\git\opencode-model-router`). Always use the
`D:\git\opencode-model-router` form.

### 0.5 Model-router annotations

Every task carries a routing tag that the router honours (`[tier:X]` → delegate to X):

| Tag | Use for |
|---|---|
| `[tier:fast]` | Context gathering, pre-flight checks, spikes that only observe, running tests/CI and reporting results |
| `[tier:medium]` | Implementation, test writing, docs, applying QA fixes, merges with mechanical conflicts |
| `[tier:heavy]` | Reasoning-dense design (depth-walk concurrency, guard bypass analysis, ladder algebra), and **every QA review** |

**QA is always a `[tier:heavy]` task. Always apply this rule.** After **every** phase (0.P and 3.4
included), and once for the whole change set, delegate to heavy QA an **adversarial** review of the
work done. The reviewer's job is to break the work, not to confirm it. The QA reviewer is never the
same dispatch that produced the work it reviews.

Heavy dispatches follow the router protocol: gather context with `[tier:fast]` first and paste it
into the heavy prompt, because heavy reasons over the context it is given. QA dispatches use
`CAP:none` **with** a `reason:` line in the same dispatch (an adversarial review must read every
changed file). Without the `reason:` line the router silently ignores `CAP:none`.

**Dispatch acceptance blocks.** The installed plugin (`2.0.0`) scopes `testsPass` to affected tests,
so `check: testsPass` is safe in dispatches. Always set `cwd:` to the phase worktree:

```
[acceptance]
cwd: D:\git\omr-de-p12
check: testsPass
criteria: <plain-language success condition from the task>
deliverable: D:\git\omr-de-p12\src\router\depth.ts
[/acceptance]
```

- Use `VERIFY:required` on any dispatch whose output a later task in the same phase builds on
  (types, exported APIs, the module a test file imports). Leaf tasks (a test file nobody imports,
  a doc section) use the default `VERIFY:deferred`.
- Before a phase's QA review, call `router_verify` with `pending: true`. Every handle must come back
  `pass`. A `fail` is fixed before QA starts; an `unverifiable` is re-checked with the scoped command
  `npx vitest run --maxWorkers=2 <files>` and its result is recorded in the phase QA report.

### 0.6 Parallelism and file safety

Maximise parallel work, but orchestrate it so **no file is ever written by two agents at once, and
no agent reads a file that another agent is editing.**

1. **Ownership map.** §2 gives every file exactly one owning phase per wave. A task may write only the
   files in its phase's write-set. Files not listed are read-only for everyone.
2. **Isolation by worktree.** Each concurrently running phase works in its own git worktree, on its own
   branch, created from the integration branch `de/main` (phase ids without the dot, `1.2` → `p12`):
   `git -C D:\git\opencode-model-router worktree add -b de/p12 D:\git\omr-de-p12 de/main`.
   An agent reads and writes only inside its own worktree, and never opens another phase's worktree.
3. **Reads of in-flight files.** When a wave starts, the orchestrator tags the tip of `de/main` as
   `de/wave-<n>-base`. A file owned by another in-flight phase is read **only** from that tag
   (`git -C D:\git\omr-de-p12 show de/wave-1-base:src/router/config.ts`), which nobody moves. A phase
   that has a dependency edge on a phase merged during the wave rebases onto `de/main` after that
   merge and then reads the merged files from its own worktree.
4. **Serial integration.** Only the orchestrator merges phase branches into `de/main`, in its own
   worktree `D:\git\omr-de-main`, one at a time, and only after the phase's QA is clean. After each
   merge it runs `npm run typecheck` and the capped full suite (rule 9). Conflicts are resolved by
   the orchestrator, never by two agents.
5. **Cross-phase dependencies.** A phase (or a task marked with a dependency edge) that needs
   another phase's output starts only after that phase is merged into `de/main`. The dependency
   graph in §3 is authoritative: anything without an edge between them runs in parallel.
6. **Within a phase.** Subtasks that write disjoint files in the same worktree may run in parallel.
   Two subtasks that write the same file run one after the other. A test-writing subtask whose test
   imports a module that another subtask is still writing waits for that subtask's commit (the
   module is "in edit" until it is committed).
7. **Shared single-writer files.** `D:\git\opencode-model-router\CHANGELOG.md`,
   `D:\git\opencode-model-router\package.json`, `D:\git\opencode-model-router\package-lock.json`,
   `D:\git\opencode-model-router\README.md` and `D:\git\opencode-model-router\src\index.ts` have one
   owner each per wave (§2). Other phases record what they need in their QA report under "handoff to
   <owner phase>", and the owner applies it.
8. **Main checkout.** `D:\git\opencode-model-router` (branch `master`) is where the live opencode
   sessions load the plugin from, including the session executing this plan. Never edit it, check
   out a branch in it, or run `npm ci` in it during execution. The exceptions are creating worktrees
   from it (a git operation that does not touch its tree), Phase 0.P's handling of this plan file,
   and the final sync in Phase 3.4.
9. **Do not saturate the machine.**
   - **Full-suite runs of this repo are always capped and serialized:** `npx vitest run --maxWorkers=2`,
     run only by the orchestrator, one at a time across all worktrees (pre-flights, post-merge checks,
     the release). Never run a bare `npm test`.
   - **Scoped runs may be accelerated:** `npx vitest run <files>` or `npx vitest related <src files> --run`
     with vitest's default parallelism. Independent scoped runs from different agents may run concurrently.
   - **`npm ci` in new worktrees runs one at a time.**

### 0.7 Pre-flight before each phase, QA after each phase

- **Before** every phase: run the standard pre-flight (§0.9) plus the phase's own items. A failed item
  is fixed before the phase starts. If it cannot be fixed, §0.1 decides whether to stop. A finding that
  this plan explicitly schedules for a later phase is not fixed early: it is recorded in the phase QA
  report under "deferred by plan", naming the phase that owns it.
- **After** every phase: a `[tier:heavy]` senior QA engineer performs an **adversarial review** of the
  phase diff. Every finding carries a severity: `blocking`, `critical`, `major`, `minor` or `nit`.
- **Bounded QA rounds.** Do not re-review the same implementation until the reviewer runs out of
  findings:
  - **Round 1:** fix every finding, whatever its severity. Then heavy QA re-reviews the fixes.
  - **Round 2:** fix every finding, whatever its severity.
  - **From round 3 on** (a further review of the same implementation): fix **only** `blocking`,
    `critical` and `major` findings, and re-review only those fixes. A `minor` or `nit` finding
    raised from round 3 on is recorded as "accepted — QA round limit" with a one-line rationale, and
    stays unfixed.
  - **Throughout this plan, "zero open findings" means:** no `blocking`, `critical` or `major` finding
    is open, and every round-1 and round-2 finding is fixed.
- The report is saved to
  `D:\git\opencode-model-router\docs\qa\depth-and-effort\phase-<id>.md` (inside the phase worktree,
  committed with the phase). Finding ids are `QA-<phase>-<n>` (for example `QA-1.2-3`); global
  findings are `QA-G-<n>`.
- Each QA report has the sections: `## Pre-flight` (results and spike evidence), `## Implementation
  notes` (including any approved deviation from this plan, marked *Amended during implementation*),
  `## Findings` (id, severity, file:line, description, resolution commit), `## Deferred by plan`,
  `## Handoffs`, and `## Verdict` (open findings: 0).
- After Wave 3's proof phase: the same for the whole change set (global QA, Phase 3.3).

### 0.8 Failure recovery

After **3 consecutive failed attempts on the same issue**: stop editing, revert to the last green
commit, write down what was tried and the exact failure, and re-dispatch the problem to `[tier:heavy]`
with that record. If heavy's approach also fails, it is a blocking problem under §0.1: ask the human.

### 0.9 Standard pre-flight checklist (applies to every phase)

`[tier:fast]` runs these and reports. The orchestrator reads the report before starting the phase.

- [ ] The phase worktree exists, is on the right branch, and `git status` is clean.
- [ ] The phase branch is based on the current tip of `de/main`, with every merged dependency included.
- [ ] Every dependency phase listed in §3 is merged and its QA report shows zero open findings.
- [ ] `npm ci` has completed in the worktree (serialized, §0.6.9). Then `npm run typecheck` and
      `npx vitest run --maxWorkers=2` pass there. This is the full suite: the orchestrator runs it once
      per phase, one worktree at a time.
- [ ] The phase's write-set (§2) does not overlap any other in-flight phase's write-set.
- [ ] No orphaned `node`/`vitest` processes from earlier phases are running (Windows:
      `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, filtered to command lines that contain
      the worktree path).
- [ ] `router_verify` with `pending: true` reports no unverified delegation left from the previous phase.
- [ ] The phase-specific pre-flight items below pass, spikes included.

### 0.10 Execution conduct (binding for the executing orchestrator)

1. **Iterate continuously.** Go from phase to phase and wave to wave without pausing. Stop **only** if
   you hit a blocking or critical problem (§0.1). A QA finding, a red test, a failed spike that has a
   documented alternative, or a merge conflict is work, not a stop.
2. **Take over when delegation itself is the blocker.** If the model-router blocks you repeatedly,
   take over **momentarily** and do the blocked read or implementation yourself. Typical causes:
   - a less capable delegate returning verbose, circular or off-target output;
   - a hand-back with zero tool calls;
   - cap banners exhausting a delegate before it reaches the answer;
   - the same dispatch failing twice with `NEED MORE:`/`ESCALATE:`.

   You are a top-tier model, extremely intelligent and capable. First re-dispatch once with an
   explicit instruction to attempt the work. If that fails as well, do the work yourself. Log it in
   `D:\git\opencode-model-router\docs\qa\depth-and-effort\run-log.md` (what, why, when), then return
   to delegating for the next task. Taking over is a recovery tool, not the default.
3. **Pre-flight before every phase** (§0.9 + the phase items). **Fix everything it finds.** If a
   finding is explicitly scheduled for a later phase of this plan, do not fix it early: only document
   it in the phase's QA report under "deferred by plan", naming the phase that owns it.
4. **Heavy senior QA after every phase.** QA is always a `[tier:heavy]` task. Always apply this rule.
   Delegate to heavy QA an **adversarial** review of the work done. Fix the findings per the bounded
   rounds of §0.7: everything in rounds 1 and 2; from round 3 on, only `blocking`, `critical` and
   `major`. Do not re-review the same implementation until the reviewer runs out of findings.
5. **Always delegate through the model-router, preferring atomic tasks.** One dispatch is one small,
   verifiable unit: a function, a test file, one doc section.
   - Coding goes to `@medium`. A coding task that is genuinely complex (async memoization, guard-bypass
     analysis, ladder algebra, hook ordering) may go to `@heavy`. The tasks this plan tags
     `[tier:heavy]` go to `@heavy`.
   - Split heavy work: `@heavy` does the heavy lift of the coding or design. The work that follows,
     running the tests and collecting the results, goes to lighter delegations (`@fast` to run and
     report, `@medium` to fix what the results show).
   - Every dispatch carries the 7 sections (task, expected outcome, tools, must do, must not do,
     context, environment) and the ENVIRONMENT line: working directory = the phase worktree,
     `Platform: win32`, `Shell: pwsh`.
6. **Never run the full suite unless it is needed.** Test only what the change touches (§0.6.9). The
   full suite runs only at the §0.9 pre-flight, after each merge, and at the release. **Accelerate
   every scoped run** with execution tuning and heavy parallelism:
   - `npx vitest run <files>` or `npx vitest related <src files> --run`;
   - `--maxWorkers=50%` or more, and `--pool=threads` when the files are compatible;
   - `--no-isolate` for pure unit files;
   - independent scoped runs from different agents concurrently.

   Only full-suite runs stay capped (`--maxWorkers=2`) and serialized.
7. **Commit often** (§0.3): after every green subtask, and push immediately.
8. **Talk to the human in Portuguese** (short, direct). Code, docs, commits, QA reports and PRs are in
   English, matching the repo.
9. **Issue tracking.**
   - **GitHub:** at each wave boundary, post one short progress comment on #66 and #67 (what merged,
     the next wave). The PR closes both.
   - **Linear:** Phase 0.P searches the repo and its docs for Linear URLs or issue keys. At planning
     time none were known, and the previous plan's search also found none. If Linear is in use,
     update the matching issues at every phase boundary as well. If it is not, record "Linear: not
     used" in `phase-0P.md` and skip it.
10. **No swallowed errors in new code.** The existing `chat.params` handler wraps its body in an empty
    `catch` (`D:\git\opencode-model-router\src\index.ts` ≈990–992). New code added there, or anywhere
    else, logs through the plugin logger instead of swallowing errors. It stays best-effort: it never
    rethrows into a real session.

---

## 1. Problem and design

### 1.1 Evidence (current code, `v2.0.0`)

**#66 — no hard depth limit.**
- Child sessions are recognised only to **suppress the orchestrator protocol**. In
  `D:\git\opencode-model-router\src\index.ts`, `lookupRootSession` (≈289–324) awaits
  `ctx.client.session.get` and memoizes "root / not root". `resolveIsRootSession` (≈268–282) treats
  unknown as root (fail-open). The `session.created` handler (≈1511–1532) calls `markChildSession`
  when `info.parentID` is a non-empty string.
- `D:\git\opencode-model-router\src\router\sessions.ts`: the `SubagentState` record (11–23) has no
  parent or depth field. `markChildSession` (≈416–420) adds the id with no cap state. `sweep`
  (≈443–448) evicts entries that have been idle for the TTL.
- A delegate still holding a `task` tool can dispatch, and its child can dispatch again. Nothing in
  code stops it; only the prompt says "do not sub-delegate".
- Dispatch entry points:
  - the native `task` tool's `"tool.execute.before"` hook (≈1099+), which can **block by throwing**
    (≈1153 prompt refusal; ≈1214–1222 `if (res.block) … throw new Error(res.message)`);
  - the registered `delegate` tool (≈504–535), whose producer sessions are created at ≈626–634 with
    `parentID` only when `toolCtx.sessionID` exists;
  - OpenCode v2 dispatches, bridged in `D:\git\opencode-model-router\src\compat\v2-hooks.ts`
    (≈272–300 `execute.before` awaits the legacy before-hook and does not catch its throw;
    ≈357–363 translates `session.created`).
- Grader sessions are created in `D:\git\opencode-model-router\src\verify\wiring.ts` (≈1237–1238) with
  `parentID: parentSessionID` when one is known.
- The false-refusal detector (`D:\git\opencode-model-router\src\index.ts` ≈1240–1245) flags a
  delegate's hand-back made after **zero** recorded tool calls. Tool calls are recorded in
  `"tool.execute.after"` (≈1232–1234), which does not run for a call whose before-hook threw.

**#67 — no effort step in the ladder.**
- `D:\git\opencode-model-router\src\escalate\ladder.ts`: `nextAction` (108–164) returns `accept`, or
  `give_up` on `unverifiable`. Otherwise it checks `maxTotalAttempts` and then the cost ceiling,
  retries the **same tier** while `attemptsThisTier < maxAttemptsPerTier`, and finally escalates via
  `nextTierAfter` (85–94) or gives up. Defaults in `buildEscalatePolicy` (182–191): ladder
  `["fast","medium","heavy"]`, `maxAttemptsPerTier: 1`, `maxTotalAttempts: 4`, `costMultiple: 4`.
- The single production caller is the `delegate` tool in `D:\git\opencode-model-router\src\index.ts`
  (state ≈566–567, `runProducerAttempt(tier, forcingNote)` ≈591–593 and ≈853–861, cost units =
  the tier's `costRatio` ≈874–878, `nextAction` ≈880–884, `advance` ≈912). Each attempt runs in its
  own producer session, which is unregistered and disposed after the gate (≈833–848).
- The producer's model and options come from the tier: `routerChildRunner` passes `agent: tier` and
  `{ ...model, variant: getActiveTiers(activeCfg)[tier]?.variant }` (≈655–660); the native prompt path
  passes `model` and `agent` (≈665–668). Effort reaches the provider only through **agent
  registration**: `buildAgentOptions(tier, name, logger)` (`index.ts` ≈1612–1620;
  `D:\git\opencode-model-router\src\router\agent-options.ts` 58–169).
- **A per-session option override already exists, for the grader:** the `"chat.params"` hook
  (`D:\git\opencode-model-router\src\index.ts` ≈980–993) pins `output.temperature` for sessions in
  `graderSessions`. The v2 bridge forwards it (`D:\git\opencode-model-router\src\compat\v2-hooks.ts`
  ≈217–222: `legacy["chat.params"]?.(input, event.options)`). The hook order is
  `chat.message → system.transform → chat.params` (comment at ≈967–978), so state registered before
  a prompt is sent is visible to `chat.params` on every LLM call of that session.
- Effort rules (`agent-options.ts`):
  - `EFFORT_LEVELS = ["low","medium","high","xhigh","max"]` (`D:\git\opencode-model-router\src\router\config.ts` 43–45).
  - Claude receives `effort`, unless a truthy `thinking.budgetTokens` takes precedence. Adaptive-only
    Claude models ignore manual budgets with a warning.
  - OpenAI receives `reasoning_effort`; `xhigh`/`max` are downgraded to `high` with a warning, and an
    explicit `reasoning.effort` wins.
  - Unknown families ignore effort with a warning.

### 1.2 Behaviour to preserve

- Orchestrator (root) sessions dispatch exactly as today. A session's depth costs at most one backend
  lookup per session for its tracked lifetime, and none when it is already known from an event, from
  the root lookup, or from the plugin's own creation.
- With `enforcement.escalate.effortBump: false`, the ladder's actions, counters, cost accounting,
  scorecard and dispatch arguments are **identical** to `v2.0.0`.
- The injected protocol text does not change. `D:\git\opencode-model-router\test\golden\__snapshots__\protocol.golden.test.ts.snap`
  and the measured prompt sizes in `D:\git\opencode-model-router\test\unit\prompt-measurement.test.ts`
  stay byte-identical.
- The set of registered agents does not change (no new agents, so nothing new appears in the `task`
  tool's subagent list).
- Existing configs load unchanged. A bad value in an overrides layer degrades the way the existing
  validation does (layer dropped with a warning naming the value; bundled defaults stand); startup is
  never prevented.
- Every v1 behaviour also holds on OpenCode v2 (the `src/compat` bridge).

### 1.3 Mechanisms (all implemented by this plan)

| # | Mechanism | Issue |
|---|---|---|
| M1 | **Depth tracker** (`src/router/depth.ts`). A session's depth is the number of `parentID` hops to its root (root = 0). It is learned from `session.created` events, from authoritative root lookups, and from sessions the plugin creates itself. When unknown, it is resolved lazily with a bounded, cycle-safe, memoized `session.get` walk. Concurrent lookups for the same session share one in-flight promise; the cache is bounded and swept. | #66 |
| M2 | **Depth guard** (`src/router/depth-guard.ts`). On every model-initiated in-process dispatch (native `task` on v1 and v2, the `delegate` tool), the caller's depth `d` is resolved. When `max` is set and `d + 1 > max`, the dispatch is refused through the existing guard's block path, before any dispatch bookkeeping. The refused call is still counted as an attempted tool call for false-refusal detection. | #66 |
| M3 | **Effort ceiling** (`effortCeilingFor` in `src/router/agent-options.ts`). For a tier, the highest effort that `buildAgentOptions` passes to the provider **unchanged and without a warning**, or `null` when a bump would have no effect or cannot be reasoned about: unknown family, a Claude explicit thinking budget that wins, an OpenAI explicit `reasoning.effort`, a configured `variant`, or no configured `effort`. | #67 |
| M4 | **Ladder effort step** (`src/escalate/ladder.ts`). A same-tier retry runs at the next effort level (one step per retry), up to `min(ceiling, effortBumpMax)`. Escalation resets to the new tier's configured effort. The bump **replaces** the plain retry's settings; it never adds an attempt. | #67 |
| M5 | **Per-session effort override** (`src/escalate/effort-override.ts`). Before a bumped attempt's prompt is sent, the producer session id is registered with its bumped tier settings. The existing `"chat.params"` hook merges `buildAgentOptions({ ...tier, effort })` into `output.options` for that session, on every LLM call. The override is cleared when the producer session is unregistered or disposed. This uses the same mechanism as the grader's temperature pin. | #67 |

### 1.4 Configuration surface (all optional)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enforcement.maxDelegationDepth` | integer 1–32 (§1.7 A13), or `null` | `1` | M2. The deepest session that a model-initiated dispatch may create. `1` means only root sessions (orchestrators) may dispatch; `2` lets a delegate dispatch one more level; `null` disables the guard. *Amended during implementation (0.P, §1.7 A1):* a dispatch past the limit is **warned** in `advisory` mode (the bundled default) and **refused** in `enforced` mode; `off` disables it. |
| `enforcement.escalate.effortBump` | boolean | `true` | M4/M5. `false` restores the `v2.0.0` ladder exactly. |
| `enforcement.escalate.effortBumpMax` | one of `EFFORT_LEVELS` | `"xhigh"` | M4. Upper bound for bumped attempts, further clamped per model by M3. |

Defaults are applied in exactly one place each: `resolveDepthLimit(cfg)` and `resolveEffortBump(cfg)`
in `D:\git\opencode-model-router\src\router\config.ts`, which are pure and synchronous.

### 1.5 Decisions taken (the executor does not re-open these)

- **D1 — Depth semantics.** Root (no `parentID`) = 0, child = parent + 1. The guard judges the
  **child that the dispatch would create**: refuse when `callerDepth + 1 > max`. With the default
  `max = 1`, orchestrators dispatch and delegates cannot. This matches the delegate rule the protocol
  already states ("do not sub-delegate"), so the protocol text stays unchanged. *Amended during
  implementation (0.P, §1.7 A1): "cannot" holds in `enforced` mode; in `advisory` mode (the bundled
  default) the delegate's dispatch proceeds with the `delegation_depth` banner.*
- **D2 — Unknown depth fails open; conflicting evidence fails closed.**
  - When the caller's depth cannot be resolved (backend error, lookup timeout of 2 s, a session the
    backend no longer knows), the dispatch is allowed, and one warning per caller session goes
    through the plugin logger. This is consistent with `resolveIsRootSession`: the guard must never
    brick an orchestrator because the backend hiccuped.
  - A **detected cycle** in the `parentID` chain, or a chain longer than `MAX_DEPTH_HOPS = 32`, is
    not unknown: the depth counts as `MAX_DEPTH_HOPS`, so any configured limit refuses it.
  - **Root is recorded only from authoritative evidence:** a backend answer with no `parentID`, or a
    `session.created` event with no `parentID`. It is never recorded from `resolveIsRootSession`'s
    fail-open default.
  - When two pieces of evidence disagree about a session (for example a root record and a later
    `parentID`), the **larger** depth wins.
- **D3 — Plugin-created sessions are never roots.** Producer sessions (the `delegate` tool, including
  every ladder retry) and grader sessions are recorded in the tracker at creation, with depth =
  creator depth + 1. When the creator is unknown (for example `toolCtx.sessionID` absent), the depth
  is 1, never 0. The guard runs once, at the model's dispatch (the `delegate` tool call), not again
  for each internal ladder attempt or grader. Anything those sessions dispatch is judged by their
  recorded depth.
- **D4 — One block path, no side effects, still counted as a tool call.**
  - The depth guard returns the same result shape as the existing guard whose result `index.ts`
    throws at ≈1214–1222. It is evaluated **first** in `"tool.execute.before"` for `task`, before the
    prompt repair and before `startDispatch`, so a refused dispatch leaves no verification,
    reference, changed-file or dispatch state behind.
  - The refused call **is** recorded as an attempted tool call of the caller in the trajectory store,
    so the false-refusal detector does not label "the guard refused my dispatch, so I did the work
    myself" as a zero-tool-call hand-back.
  - In the `delegate` tool, the guard is evaluated before any session is created, and the refusal is
    returned the way that tool already reports refusals (Phase 0.P resolves the exact form).
- **D5 — Refusal text** (exact, single line, no capability-denial priming):
  `[router] DELEGATION DEPTH LIMIT — this session is at delegation depth ${d}; enforcement.maxDelegationDepth is ${max}, so it cannot dispatch another subagent. Do this part of the work yourself and report the result; do not retry the dispatch.`
- **D6 — The guard follows the existing guard's switch and mode.** It is active exactly when the
  existing hard-block guard is active, and it uses that guard's mode semantics. If the guard has an
  advisory (warn-only) mode, a depth violation in that mode warns through the same channel instead
  of blocking. Phase 0.P resolves the switch and mode names. `maxDelegationDepth: null` disables only
  the depth guard. *Amended during implementation (0.P): resolved in §1.7 A1; the bundled default
  mode is `advisory`, so the default limit warns rather than blocks.*
- **D7 — Bump only when the plugin can reason about the result.** A tier is bumped only when it has
  an explicit `effort` and **no** `variant`.
  - Without a configured effort, the plugin cannot know the provider's default effort, and it must
    not send an effort parameter to a model that the user has not proven accepts one.
  - A variant contributes provider options that the plugin does not model (for example thinking
    budgets), which may take precedence over `effort`.
  - In every other case the retry is the plain `v2.0.0` retry.
  - The ceiling is M3. The default `effortBumpMax: "xhigh"` (owner decision, D12) is further clamped
    per family by M3: OpenAI tiers stop at `high`, and Claude tiers may reach `xhigh`. Users can lower
    it to `"high"` if a Claude model they use rejects `xhigh`.
- **D8 — Ladder algebra.**
  - On a retry: `effort = nextEffort(currentEffort ?? base, min(ceiling, effortBumpMax))`. That is one
    step up, or no change when already at the bound.
  - On an escalation: `currentEffort` resets to `null` (the new tier's configured effort).
  - Attempts, `maxTotalAttempts`, the cost-ceiling check and the order of checks are unchanged.
  - A bumped attempt costs the tier's `costRatio`. The cost model is ratio-based, and adding an effort
    multiplier is out of scope (§6).
  - The default ladder becomes `fast@base → fast@base+1 → medium@base → medium@base+1`, with the same
    four attempts.
- **D9 — Per-attempt effort mechanism: `chat.params` (M5).**
  - **Primary:** the per-session override described in M5. It needs no new agents, so nothing new
    appears in the `task` tool's subagent list. It reuses `buildAgentOptions`, so the family gating
    is identical. It follows the grader-temperature precedent on both v1 and v2.
  - **Fallback**, only if Spike B shows that keys merged into `output.options` in `chat.params` do
    not reach the provider request on v1 or on v2: a per-prompt `variant` whose catalog name equals
    the bumped level, with the same `resolveAttemptOverride` API.
  - If neither works on both v1 and v2, that is a blocking problem (§0.1.3): ask the human.
- **D10 — Scope of the bump.** The bump applies to the router-driven ladder (the `delegate` tool).
  Native `task`-path retries are made by the orchestrator, so they are out of scope (§6). If Phase 0.P
  finds that the ladder also runs on the native path, the bump applies there too, through the same
  override.
- **D11 — Scope of the guard.** The guard covers in-process dispatch tools: native `task` (v1, v2,
  v2 background, `task_id` resume) and `delegate`. It does not cover a delegate that starts a new
  `opencode` process through a shell tool, or session-creating tools registered by other plugins.
  Both are documented limits (§5, ADR), not bugs to chase in this plan.
- **D12 — Owner decisions (2026-10-05).**
  - `maxDelegationDepth` defaults to `1`. *Amended during implementation (0.P, §1.7 A1): enforced only
    when the mode resolves to `enforced`; advisory (the bundled default) warns.*
  - `effortBumpMax` defaults to `"xhigh"`.
  - The whole plan is approved for autonomous execution through the release (Phase 3.4: merge, tag,
    `npm publish`, local sync), under the §0 rules. There is no approval gate before the release.

### 1.6 Target flows

```
task / delegate call from session S
  └─ depth guard (first): d = depth(S) ── unknown → allow + warn once
                                      ├─ d+1 ≤ max or max = null → continue (existing flow)
                                      └─ d+1 > max → record attempted call; block with D5 text; no other side effects

delegate ladder, failed verdict on tier T (attempt k)
  └─ nextAction: total/cost checks (unchanged)
       ├─ retry on T at effort' → create producer session P → override.set(P, T, effort') → prompt P
       │                              chat.params(P) merges buildAgentOptions({...T, effort: effort'}) into output.options
       │                              gate → unregister/dispose P → override.clear(P)
       └─ escalate to T+1 → producer at T+1's configured effort (no override)
```

### 1.7 Amended during implementation (0.P, 2026-10-05)

*Amended during implementation (0.P).* These amendments are binding and supersede the text they
name. Evidence (file:line, spike sources and captures) is in
`D:\git\opencode-model-router\docs\qa\depth-and-effort\phase-0P.md`.

- **A1 — D6 resolved; G1 and D12 amended (owner decision, 2026-10-05: follow D6 literally;
  QA-0.P-2, -3, -10, -11).**
  - Mode = `resolveEnforcementMode({ config, tier: sessionStore.getTier(callerSid) ?? undefined, env })`
    (`src\router\enforcement.ts`), with the **same tier source** `guardBeforeCall` uses
    (`src\index.ts` ≈1201–1210), so both guards resolve one mode per call. Inputs: `enforcement.mode`
    (bundled default `"advisory"`, `tiers.json:5`), the env gate `enforcement.envGate` (default
    `MODEL_ROUTER_ENFORCE`: `"1"` → `enforced`, `"0"` → `off`) and `enforcement.perTier[<caller tier>]`.
  - `off` → no check and no depth lookup.
  - `advisory` (**the bundled default**) → the dispatch proceeds and the caller gets a banner
    (guard id `delegation_depth`), text:
    `[⚠ GUARD:delegation_depth] this session is at delegation depth ${d}; enforcement.maxDelegationDepth is ${max}. In enforced mode this dispatch would have been refused. Do not dispatch further subagents from this session; do that work yourself.`
  - `enforced` → refuse with the D5 text through the D4 path.
  - *Orchestrator decision (0.P):* the `trivial` downgrade of `guardBeforeCall` (enforced → advisory
    for trivial sessions) is **not** applied. `trivial` comes from the parent's classification of the
    dispatch; honouring it would let a trivial-classified delegate dispatch past an enforced limit with
    only a banner. `resolveEnforcementMode` has no trivial step, so this is the literal D6 reading.
  - **The banner has its own per-call channel**, independent of guard state and of `isSubagent`. It does
    **not** use `guardStore.setPendingNote`: that is one slot per session, overwritten by
    `guardBeforeCall` on the same call, and delivered only for `isSubagent` sessions with guard state
    (`src\guard\enforce.ts:113–120,138–147`, `src\guard\store.ts:49–56`, `src\index.ts:1262–1279`).
    - `delegate`: appended to that call's returned string on every return path.
    - `task` on v1: stored in a bounded map (≤ 1 000, oldest evicted) keyed
      `${input.sessionID}:${input.callID}` (the existing dispatch-key convention, `src\index.ts:1116`)
      in the before-hook; in `"tool.execute.after"`, **before** the `isSubagent` branch, appended to that
      call's output and deleted. A call without a `callID` gets no banner (one logged warning per
      session), as the existing task branch skips it (`src\index.ts:1105`).
    - `task` on v2 (`routerHost === "v2"`, A3): the before-hook does not use the map. It marks its
      `output` with a symbol carrying the banner (the `TASK_VERIFICATION` precedent,
      `src\index.ts:1108` → `src\compat\v2-hooks.ts:291`). The bridge keeps its own bounded map keyed by
      `event.id` and is the **only** deliverer on v2: it appends the banner for a completed result and
      in the completed → `running` (background) branch (≈308–318).
    - A failed or non-completed call gets **no** banner, and its entry is dropped (v1 map or bridge
      map). A banner is never delivered twice; 2.3.6 asserts it.
  - **G1 is amended:** the refusal holds when the caller's mode resolves to `enforced`. In the bundled
    default (`advisory`), a dispatch past the limit proceeds with the banner. **D12.1 is amended
    accordingly:** `maxDelegationDepth` defaults to `1`, and that limit is enforced only in `enforced`
    mode. README, CONFIG_REFERENCE, the ADR and CHANGELOG state this and show how to enforce it
    (`enforcement.mode: "enforced"` or `MODEL_ROUTER_ENFORCE=1`).
  - **Superseded text** (read every item below with this amendment):
    - the header's Scope line (1), M2 (§1.3) and the §1.6 flow: "refused" means "refused in enforced
      mode, warned in advisory mode";
    - 2.1.1: the adapter takes `mode: (callerSessionID: string | undefined) => EnforcementMode`
      (resolved by the caller with the tier source above) and returns
      `DepthGuardResult = BeforeResult & { banner?: string }`, defined in `src\router\depth-guard.ts`;
      advisory returns `{ block: false, mode: "advisory", guard: "delegation_depth", banner }`;
    - 2.1 tests, 2.3.6 tests and the 2.3 acceptance: every depth case runs in `enforced` **and** in
      `advisory` mode (advisory asserts the banner and no refusal); 2.3.6 adds: the banner plus an
      existing advisory guard on the same call, a v2 background dispatch, a failed `task` call, and a
      caller that is not `isSubagent`;
    - 3.1.4 CHANGELOG wording: "dispatches past `enforcement.maxDelegationDepth` (default `1`) are
      warned in `advisory` mode (the bundled default) and refused in `enforced` mode";
    - 3.2.1(c): runs in both modes, and covers (QA-0.P-R2-6) an `enforced` refusal **through the loaded
      router** on v2 (the bridge's async rejection to the host) for foreground, background and resume
      dispatches, plus an `advisory`-mode allowed v2 background dispatch whose `running` result shows
      the banner;
    - §1.4 row `maxDelegationDepth`, D1, 1.1.3 and the 1.1 acceptance (amended in place);
    - §5, first risk row: the default warns; enforced mode is what affects users of nested delegation.
- **A2 — D4 resolved.**
  - The guard result type is `BeforeResult` (`src\guard\enforce.ts:58–63`:
    `{ block; message?; mode; guard? }`), produced by `guardBeforeCall`.
  - A refused `task` call is recorded with
    `trajectoryStore.recordToolEvent(sid, { tool, readOnly, blocked: true })`, exactly as the existing
    block path does (`src\index.ts` ≈1214–1221). `recordToolEvent` increments `toolCallCount` for
    blocked events (`src\telemetry\trajectory.ts:73–81`), which is what the false-refusal detector reads.
  - The `delegate` tool reports refusals by **returning** a `[router] …` string (`src\index.ts`
    ≈853–915). In enforced mode it returns the D5 text before any session is created.
- **A3 — D9 decided: the primary mechanism (`chat.params`), with provider-native keys.**
  - Spike B (real OpenCode 1.18.19 and 2.0.22 against a capturing stub): an option written in
    `chat.params` reaches the HTTP body for that session only, wins over registered agent options, and
    equals the agent-registered request **when the key is provider-native**: Claude `effort` →
    `output_config.effort`; OpenAI `reasoningEffort` → `reasoning.effort`. The snake-case
    `reasoning_effort` is silently dropped on v1 and in a v2 hook write.
  - Shapes: v1 `output = { temperature, topP, topK, maxOutputTokens, options }` → write
    `output.options`. The v2 bridge passes `event.options` itself as the legacy `output` → write it
    flat.
  - **Explicit host seam (QA-0.P-4).** `src\v2.ts` passes `routerHost: "v2"` in the plugin input next to
    `routerChildRunner` (`src\v2.ts:15–21`); absent means v1. The field is declared on
    `RouterPluginInput` in `src\compat\child-session.ts:25–27` (no cast). 2.3 owns `src\v2.ts` and that
    type in Wave 2. The
    single legacy `chat.params` handler writes the effort keys flat into `output` when
    `routerHost === "v2"` and into `output.options` on v1, never both. v1 always supplies
    `output.options` (every Spike B hook log); if it is absent or not an object on v1, the handler logs
    a warning and skips. 2.3 adds a bridge test asserting that `event.options` never gains an `options`
    key and that the grader-temperature behaviour is unchanged.
  - **Producer-only gate.** v1 also calls `chat.params` for title generation with the producer's
    `sessionID` (`agent: "title"`, a small model). The override applies only when `input.agent` equals
    the registered tier name **and** the model identity (`providerID` + `modelID ?? id`) equals the
    tier's `model`; the host's `variant` is ignored (D7 excludes variant tiers; v2 reports
    `variant: "default"`). v2 title calls use a separate `title` hook, which the bridge does not
    forward. Scope of the leak the gate closes (QA-0.P-R2-11): Spike A2 R5 shows no title request for
    a parented producer on either host; the v1 title call shares the session only for producers created
    without `parentID` (`toolCtx.sessionID` absent) and for other auxiliary agents. The gate stays. **Confirmed on real hosts (Spike A2 R5, QA-0.P-7):** the router's own `delegate` producer
    shows `agent: "fast"`, `providerID: "anthropic"`, `id: "claude-sonnet-4-5"` on v1 (`chat.params`,
    no `modelID`) and on v2 (`context`, plus `variant: "default"`).
  - **2.2.1 interface amended:** `applyEffortOverride(store, input: { sessionID?: string; agent?: unknown; model?: unknown }, target: Record<string, unknown>, logger)`
    writes into the provider-options object it is given; the caller passes the right object per the
    host seam. An absent or non-object `target` → warning, no-op (2.2.1's "creates `output.options`
    when it is absent" and the matching test are superseded). The applied keys are the effort keys of
    `buildAgentOptions({ ...tier, effort })` after A4 (`effort` or `reasoningEffort`).
  - **Host-level proof is a gate (QA-0.P-7, -R2-7).** 2.3's DoD adds a run of a copy of the Spike A2
    rig (`C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\spike-a2\`, scripted keyless stub, real
    1.18.19 and 2.0.22, the plugin loaded from the phase worktree), with the copy's file hashes
    recorded in `phase-2.3.md`, and a scripted failing first attempt on a bumpable tier: the retry
    producer's captured request carries the bumped effort; the first attempt's, the title's and the
    grader's requests do not. 3.2.1(c) and (d) are **mandatory** and use a **versioned** scripted stub:
    3.2 owns the new helper `test\smoke\helpers\scripted-provider.ts` (§2). The v1 legs run in CI
    through `npm run smoke:keyless` (the lane installs v1 1.18.19; adding the file to that script is the
    existing 3.2 → 3.4 `package.json` handoff, no workflow edit). The v2 legs cannot run in CI (no
    OpenCode 2 binary there) and are recorded as local evidence in `phase-3.2.md`; §4.2 is amended
    accordingly.
  - The fallback (per-prompt `variant`) is not used, because the primary works on both hosts and the
    Claude catalog variants are thinking budgets, not effort levels. Corrected facts (QA-0.P-9): the
    v1 HTTP API does honour a per-message `variant` (Spike B isolation `v1-openai-same-VARIANT` sent
    `reasoning.effort: high`); the `body.variant?` type at
    `@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:8358–8383` belongs to the v1 host's newer SDK;
    OpenCode 2 has no per-message variant.
- **A4 — Owner decision (2026-10-05): fix the pre-existing v1 registration bug in Phase 1.3.**
  - `buildAgentOptions` emits provider-native keys only: `reasoningEffort`, `reasoningSummary`,
    `thinking: { type: "enabled", budgetTokens }` and `effort`, for the applicable family, with the
    existing precedence rules and warnings unchanged. Today it emits `reasoning_effort`,
    `reasoning_summary` and `budget_tokens`, which v1 drops silently (Spike B extension).
  - 2.3 adjusts the v2 bridge's registration translation (`src\compat\v2-hooks.ts:125–135`):
    native keys pass unchanged; the snake-case aliases stay normalized for option bags from other
    sources, and an explicit native key wins over its alias.
  - CHANGELOG gets a `Fixed` entry (3.1). The §1.2 protocol, golden-snapshot and agent-list
    guarantees are unaffected (no snapshot contains these keys).
  - §2 write-sets change as listed there.
  - **This is a v1 behaviour change (QA-0.P-5).** On v1 these settings have never reached the wire;
    after 1.3.2b they do (v2 already sent them through the bridge). Cases that can newly fail on v1:
    - OpenAI-family detection is a regex (`/\bgpt-/`, `o[134]`), so Copilot, OpenRouter or Azure
      `gpt-*` models, and non-reasoning GPT models, with a configured `effort` or `reasoning.*` now
      receive `reasoningEffort`/`reasoningSummary`. Whether the AI SDK strips them for non-reasoning
      models is **unverified**.
    - Claude tiers with `thinking.budgetTokens` now send `thinking`. Graders are not affected
      (QA-0.P-R2-5): the v1 grader prompt sends `model` and `system` but no `agent`
      (`src\verify\wiring.ts:1262–1268`), so it runs on the default agent and never receives a tier's
      registered options; on v2 the grader agent gets no tier options either, and the bridge strips the
      temperature unless pinned (`src\compat\v2-hooks.ts:219–223`). The temperature pin therefore
      never meets a tier thinking budget; no test is needed.
    - Latency and cost rise wherever a budget or effort was silently ignored before.

    The CHANGELOG `Fixed` entry (3.1) is flagged as a v1 behaviour change, lists these cases, and gives
    the remedy (remove `effort`, `reasoning.*` or `thinking` from the affected tier). Bundled presets
    are unaffected: none sets `reasoning` or `thinking`, and Claude `effort` is already the native key.
  - Handoff to 1.1 (QA-0.P-17): the comment at `src\router\config.ts:40` names `reasoning_effort`.
- **A5 — D7 reach measured (not a stop).** With the active preset `anthropic`, **no tier is bumpable**
  (every tier sets a `variant`). In `fable-effort`, `fast` (low → bound `xhigh`) and `medium`
  (high → bound `xhigh`) are bumpable and `heavy` (`xhigh`) is excluded; `hybrid.heavy` is excluded
  (variant); the OpenAI, Copilot, Google and Z.ai presets set no `effort`. The `xhigh` risk of handover
  §4.3 does not materialize for bundled presets: `fable-effort.heavy` already ships `effort: "xhigh"`
  on the same model (`anthropic/claude-fable-5-1`), and both SDK stacks forwarded `xhigh` unchanged
  for the captured `claude-fable-5` and `claude-opus-4-7` (stub only; `claude-fable-5-1` itself was not
  captured). Real-provider acceptance cannot be shown keylessly.
- **A6 — D10 confirmed.** `nextAction`/`advance` are called only by the `delegate` tool
  (`src\index.ts:880`, `:912`). The bump scope is unchanged.
- **A7 — D3 for graders (QA-0.P-6).** On the `delegate` path the grader's `parentSessionID` is the
  caller (`toolCtx.sessionID`, `src\index.ts:755`); on the native `task` path it is `undefined`
  (`src\index.ts:1382`), so a v1 grader is recorded at creator depth + 1, or 1. On v2, `dispatchGrader`
  takes the `childRunner` branch (`src\verify\wiring.ts:1205–1222`): the native `subagent` tool creates
  the grader under the active tool context's session, so the host parent is the caller even when
  `parentSessionID` is undefined, and the creation point is the `onCreated` callback (≈1217–1221).
  **2.3.3 is amended:** `onChildSessionCreated` is called at both creation points (≈1217–1221 and
  ≈1241–1243), and the 2.3.6 grader test covers v2. For native-path graders the caller is known at the
  gate (`orchestratorSessionID`, `src\index.ts:1307`) and is passed as the creator, so the grader is
  recorded at caller depth + 1 rather than 1 (QA-0.P-R2-9); 2.3 owns that line of `src\index.ts`.
- **A8 — M5 timing confirmed.** v1 native prompt path: create → `registerProducer` → prompt
  (`src\index.ts` ≈626–669). v2 `routerChildRunner`: `onCreated` is awaited in the progress callback
  before the child is prompted (`src\compat\v2-client.ts:97–108`). The override is set inside
  `registerProducer` (both paths) and cleared with the per-attempt cleanup (≈833–848) **and** in the
  outer `finally` loop (≈916–924), which today neither unregisters nor clears guard state, so the
  override clear is added to that loop explicitly.
- **A9 — Spike A, host level (QA-0.P-1).** The bridge-only scratch test (deleted) is superseded by
  Spike A2: real OpenCode 1.18.19 and 2.0.22, a keyless stub that scripts the model's dispatch calls,
  and an observer plugin whose before-hook throws. Evidence in
  `C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\spike-a2\` and `REPORT.md` there.
  - Foreground (v1, v2), background (v2; v1's `task` has no `background` parameter) and `task_id`
    resume (v1, v2): the before-hook fires with the **caller's** `sessionID`; the throw reaches the
    model as a `tool_result` with `is_error: true` carrying the message; the turn continues to its
    final answer; exit 0.
  - A child that dispatches (R4): the before-hook's `sessionID` is the **child's**, whose `parentID` is
    the root. On v1 the default `general` agent has no `task` tool (the host turns the call into its
    `invalid` tool), so v1 nesting needs an agent with task permission; v2's `general` can dispatch.
  - The router's own v2 `childRunner` calls the native `subagent` tool directly
    (`src\compat\v2-client.ts:74–117`), without the hook. It is not a bypass, because the `delegate`
    tool is guarded in its own `execute` (D3).
- **A11 — Before-hook order and `/bypass` (QA-0.P-12).** The current order in `"tool.execute.before"`
  is `observeEdit` (≈1103) → task verification `startDispatch` (≈1105–1121) → prompt repair
  (≈1128–1153) → dispatch-header rewrite (≈1156–1191) → `guardBeforeCall` (≈1196–1221). The depth
  guard runs first for dispatch calls, before `observeEdit`. *Orchestrator decision (0.P):* the hook
  returns early when the plugin is bypassed (`/bypass`, `src\index.ts:404`, ≈1835–1839); the
  user's explicit plugin-wide toggle also disables the depth guard. The `delegate` tool's `execute`
  does not check `bypassed` today (QA-0.P-R2-8), so 2.3.2.d checks it there as well and skips the depth
  guard when bypassed, keeping both dispatch paths consistent; 2.3.6 tests `/bypass` on both. This is
  listed with the D11 limits in the ADR and the README.
- **A12 — Smoke isolation hardening (QA-0.P-15, -R2-10).** 1.3 also isolates `XDG_*`, `APPDATA`,
  `LOCALAPPDATA` and `OPENCODE_*` in `test\smoke\registration.smoke.test.ts` and
  `test\smoke\subagent-tiers.smoke.test.ts`, as the v2 smoke and the Spike rigs do, and sets
  `OPENCODE_DISABLE_MODELS_FETCH=true` (or keeps a cache directory) so an isolated cache does not force
  a models.dev fetch per spawn. The lane is run on Windows (v1 1.18.19 first on `PATH`) before 1.3
  merges, and CI's `smoke-keyless` must be green on the PR.
- **A13 — `maxDelegationDepth` is capped at 32 (Phase 1.1, QA-1.1-1 and -R2-1).** *Orchestrator
  decision (1.1).* A cycle or a chain longer than `MAX_DEPTH_HOPS` counts as depth 32 (D2), so any limit
  of 33 or more would let it through and make D2's "any configured limit refuses it" false. The key is
  therefore `null` or a safe integer from 1 to 32; `src\router\config.ts` exports
  `MAX_DELEGATION_DEPTH_LIMIT = 32`, which must equal `MAX_DEPTH_HOPS` in `src\router\depth.ts` (2.1
  pins the equality with a test). §1.4 and the 1.1 test list are read with this: `100` is rejected,
  `32` is the largest accepted value.
- *Note on order:* A10 was written before A11 and A12 and sits above A11 in this list only by history
  of the edits; the numbering is the reference (QA-0.P-R2-12).
- **A10 — Local smoke environment.** `smoke:keyless` needs the CI-pinned v1 CLI (1.18.19) first on
  `PATH`, and `smoke:v2` needs `OPENCODE_V2_BIN`; the machine's default `opencode` is 2.0.22. The
  keyless fixtures now isolate `USERPROFILE` as well as `HOME` (`d8a9a42`). Commands in `phase-0P.md`.

---

## 2. File ownership map

One owner per file per wave. Every other phase reads these files only from the wave-base tag
(§0.6.3). Paths marked *(new)* do not exist yet. Phase 0.P fills the `<resolved in 0.P>` entries and
commits the updated table.

| File | Wave 1 owner | Wave 2 owner | Wave 3 owner |
|---|---|---|---|
| `D:\git\opencode-model-router\src\router\config.ts` | 1.1 | — | — |
| `D:\git\opencode-model-router\test\unit\config.validate.test.ts` | 1.1 | — | — |
| `D:\git\opencode-model-router\test\unit\config-depth-effort.test.ts` *(new)* | 1.1 | — | — |
| `D:\git\opencode-model-router\test\unit\docs-drift.test.ts` | 1.1 | — | — |
| `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md` | 1.1 | — | 3.1 |
| `D:\git\opencode-model-router\src\router\depth.ts` *(new)* | 1.2 | — | — |
| `D:\git\opencode-model-router\test\unit\depth.test.ts` *(new)* | 1.2 | — | — |
| `D:\git\opencode-model-router\src\router\agent-options.ts` | 1.3 | — | — |
| `D:\git\opencode-model-router\src\escalate\ladder.ts` | 1.3 | — | — |
| `D:\git\opencode-model-router\test\unit\ladder.test.ts` | 1.3 | — | — |
| `D:\git\opencode-model-router\test\unit\effort.test.ts` | 1.3 | — | — |
| `D:\git\opencode-model-router\test\unit\effort-ceiling.test.ts` *(new)* | 1.3 | — | — |
| `D:\git\opencode-model-router\test\unit\__fixtures__\ladder-v2.0.0-golden.json` *(new)* | 1.3 | — | — |
| `D:\git\opencode-model-router\src\router\depth-guard.ts` *(new)* | — | 2.1 | — |
| `D:\git\opencode-model-router\test\unit\depth-guard.test.ts` *(new)* | — | 2.1 | — |
| `D:\git\opencode-model-router\src\escalate\effort-override.ts` *(new)* | — | 2.2 | — |
| `D:\git\opencode-model-router\test\unit\effort-override.test.ts` *(new)* | — | 2.2 | — |
| `D:\git\opencode-model-router\src\index.ts` | — | 2.3 | — |
| `D:\git\opencode-model-router\src\compat\v2-hooks.ts` | — | 2.3 | — |
| `D:\git\opencode-model-router\src\verify\wiring.ts` (grader creation seam only, D3) | — | 2.3 | — |
| `D:\git\opencode-model-router\test\integration\ladder-wiring.test.ts` | — | 2.3 | — |
| `D:\git\opencode-model-router\test\integration\depth-guard-wiring.test.ts` *(new)* | — | 2.3 | — |
| `D:\git\opencode-model-router\test\integration\ladder-effort-wiring.test.ts` *(new)* | — | 2.3 | — |
| `D:\git\opencode-model-router\test\unit\v2-hooks.test.ts` (v2 hook-bridge tests; resolved in 0.P) | — | 2.3 | — |
| `D:\git\opencode-model-router\test\integration\fable-effort-preset.test.ts` (A4) | 1.3 | — | — |
| `D:\git\opencode-model-router\test\smoke\registration.smoke.test.ts` (A4, A12; 0.P fixed its Windows isolation in `d8a9a42`) | 1.3 | — | — |
| `D:\git\opencode-model-router\test\smoke\subagent-tiers.smoke.test.ts` (A12) | 1.3 | — | — |
| `D:\git\opencode-model-router\src\v2.ts` (A3 host seam) | — | 2.3 | — |
| `D:\git\opencode-model-router\src\compat\child-session.ts` (`RouterPluginInput` type only, A3) | — | 2.3 | — |
| `D:\git\opencode-model-router\test\smoke\helpers\scripted-provider.ts` *(new; versioned scripted stub, A3)* | — | — | 3.2 |
| `D:\git\opencode-model-router\docs\PER_TURN_EFFORT.md`, `D:\git\opencode-model-router\docs\OPENCODE_V2.md` (A4 key names) | — | — | 3.1 |
| `D:\git\opencode-model-router\CHANGELOG.md` | — | — | 3.1 (then 3.4) |
| `D:\git\opencode-model-router\README.md` | — | — | 3.1 |
| `D:\git\opencode-model-router\docs\adr\0004-delegation-depth-and-effort-bump.md` *(new)* | — | — | 3.1 |
| `D:\git\opencode-model-router\docs\plans\README.md` | — | — | 3.1 |
| `D:\git\opencode-model-router\test\smoke\depth-effort.smoke.test.ts` *(new)* | — | — | 3.2 |
| `D:\git\opencode-model-router\package.json`, `D:\git\opencode-model-router\package-lock.json` | — | — | 3.4 |
| `D:\git\opencode-model-router\docs\qa\depth-and-effort\phase-<id>.md` | each phase writes only its own report | | |
| `D:\git\opencode-model-router\docs\qa\depth-and-effort\run-log.md`, `global.md` | orchestrator only | | |
| `D:\git\opencode-model-router\docs\plans\delegation-depth-and-effort-bump-plan.md` | orchestrator only (0.P amendments, *Amended during implementation* notes) | | |

**Never written by this plan:** `D:\git\opencode-model-router\src\router\protocol.ts`,
`D:\git\opencode-model-router\src\router\sessions.ts`,
`D:\git\opencode-model-router\test\golden\__snapshots__\protocol.golden.test.ts.snap`,
`D:\git\opencode-model-router\test\unit\prompt-measurement.test.ts`,
`D:\git\opencode-model-router\tiers.json`. If a phase finds it must change one of them, that
contradicts §1.2, and §0.1.1 applies.

---

## 3. Waves, phases, tasks

### Dependency graph

```
0.P ──► 1.1 ─┬──────────────► 2.1 ─┐
       1.2 ──┘ (2.1 needs 1.1, 1.2)  ├─► 2.3 ─► 3.1 ┐
       1.3 ──(1.3.4 needs 1.1)──► 2.2 ─┘      └► 3.2 ┴─► 3.3 ─► 3.4
```

- Wave 1: **1.1, 1.2, 1.3 run in parallel** (disjoint write-sets). Task 1.3.4 waits for 1.1's merge.
- Wave 2: **2.1 ∥ 2.2** once their Wave 1 inputs are merged; **2.3** after both are merged
  (single writer of `src\index.ts`).
- Wave 3: **3.1 ∥ 3.2**, then 3.3 (global QA), then 3.4 (release).

---

### Phase 0.P — Execution pre-flight (once) `[tier:fast]` (+ `[tier:heavy]` spike verdicts)

**Goal:** a verified baseline, the integration branch with this plan committed on it, the unresolved
paths filled into §2, and the spikes that decide D4, D6 and D9.

**Tasks**
- **0.P.1** `[tier:fast]` Baseline facts:
  - 0.P.1.a `git -C D:\git\opencode-model-router status --porcelain` shows **only** two untracked
    files: this plan (`docs/plans/delegation-depth-and-effort-bump-plan.md`) and its handover
    (`docs/plans/delegation-depth-and-effort-bump-handover.md`). Anything else is a §0.1.2 stop.
    `master` equals `origin/master`; `package.json` version is `2.0.0`; `gh auth status` is OK. Record
    `node -v` and `npm -v`. Search the repo for Linear URLs or issue keys (§0.10.9) and record the
    result.
  - 0.P.1.b Create `de/main` from `origin/master`. Create worktree `D:\git\omr-de-main` on `de/main`
    (the orchestrator's merge worktree). Copy both files into it, commit
    `docs(plans): add the delegation depth and effort bump plan and handover`, and push. From here
    on, the `de/main` copies are authoritative. The untracked copies in the main checkout are left
    untouched until 3.4.5.
  - 0.P.1.c In `D:\git\omr-de-main`: `npm ci`, `npm run typecheck`, `npx vitest run --maxWorkers=2`.
    Record the counts as the baseline. Run `npm run smoke:keyless` and `npm run smoke:v2`, and record
    the results.
- **0.P.2** `[tier:fast]` Resolve the unknowns (read-only, in `D:\git\omr-de-main`), with file:line
  evidence:
  - 0.P.2.a The module and function that produce `res` / `res.block` in `"tool.execute.before"`
    (`src\index.ts` ≈1214–1222), its result type, its enforcement switch and any advisory mode (D4, D6).
  - 0.P.2.b How the `delegate` tool's `execute` reports a refusal to its caller (a returned string or
    a throw) (D4).
  - 0.P.2.c The `trajectoryStore` API that records a tool call (used by D4 to count a refused call),
    and its key (caller session id).
  - 0.P.2.d The test file for `src\compat\v2-hooks.ts` (§2 placeholder).
  - 0.P.2.e Whether `nextAction`/`advance` are called on any path other than the `delegate` tool (D10).
  - 0.P.2.f What `parentSessionID` is at the grader creation (`src\verify\wiring.ts` ≈1237) on both
    dispatch paths (D3).
  - 0.P.2.g A table of every bundled preset in `D:\git\opencode-model-router\tiers.json`: tier → model
    → `effort` → `variant` → family → whether D7 allows a bump → bound. This shows where the bump
    applies by default, for the ADR. **If no bundled tier is bumpable under D7, record it as a finding
    for 0.P.5** (the feature would be inert by default).
  - 0.P.2.h On both producer paths (`routerChildRunner` and the native session prompt), whether the
    producer session id is known **before** the prompt is sent (needed by M5), and where the session
    is unregistered and disposed (≈833–848).
  - 0.P.2.i What the keyless smoke harness (`D:\git\omr-de-main\vitest.smoke.config.ts`,
    `D:\git\omr-de-main\test\smoke\*.smoke.test.ts`) can observe: does it run a local provider stub
    that captures outgoing requests, and can it drive a scripted tool call?
- **0.P.3** `[tier:fast]` **Spike A — v2 refusal path.** In a scratch test under
  `D:\git\omr-de-main\test\scratch\` (deleted afterwards, never committed), drive the v2 bridge
  (`src\compat\v2-hooks.ts` `execute.before`) with a legacy before-hook that throws. Record whether
  the throw reaches the caller as a tool error (not an unhandled rejection or a crashed session), and
  whether v2 background dispatches pass through `execute.before` with the caller's session id. Use the
  `smoke:v2` harness if the bridge alone cannot show it.
- **0.P.4** `[tier:fast]` **Spike B — per-session effort via `chat.params` (D9).**
  - On v1 and v2, a `chat.params` handler that merges a provider option into `output.options` (v2:
    the bridged `event.options`) must change the outgoing provider request for that session only.
  - It must also produce the **same** request as an agent registered with that option through
    `buildAgentOptions`. Check one OpenAI reasoning model (`reasoning_effort`) and one Claude model
    (`effort`).
  - Use the request capture found in 0.P.2.i. If the keyless harness has no capture, use the keyed
    smoke harness when keys are present. If neither is available, read OpenCode's own merge order of
    model, agent, variant and `chat.params` options from the installed `opencode` package source in
    `node_modules`, with file:line evidence.
  - Also record the fallback: whether `session.prompt` honours a per-message `variant`, and the
    variant names that the catalog lists for the two models.
- **0.P.5** `[tier:heavy]` CAP:3. Verdicts: given the 0.P.2–0.P.4 reports pasted in, decide D9 (the
  primary mechanism or the fallback, with evidence) and confirm or amend D4, D6 and D7 against the
  real guard API, the trajectory store and the preset table. Amendments are written into the
  `de/main` copy of this plan as *Amended during implementation (0.P)*.
- **0.P.6** `[tier:medium]` In `D:\git\omr-de-main`, fill the §2 placeholders and the 0.P amendments,
  write `D:\git\omr-de-main\docs\qa\depth-and-effort\phase-0P.md`, commit
  `docs(plans): record the depth and effort pre-flight`, push, and tag `de/wave-1-base`.

**Acceptance criteria** — baseline green and recorded; every §2 placeholder resolved; D9 decided with
v1 and v2 evidence; D7's default reach known; scratch files removed.

**Definition of Done** — `phase-0P.md` committed on `de/main` with zero open findings; `de/wave-1-base`
tagged; pushed.

**QA review** `[tier:heavy]` CAP:none — reason: the spike verdicts decide the design of Wave 2; the
reviewer must read the raw spike evidence, not the summary.
Adversarial focus: does Spike B's evidence really prove that the request changed (not only the
in-memory object)? Was Spike A run against the code path a real v2 dispatch takes? Is the preset table
complete? Are D6 and D7 amendments consistent with the code?

---

### Wave 1 — Final components (parallel)

#### Phase 1.1 — Configuration surface `[tier:medium]`

**Goal:** the three keys of §1.4 are typed, validated, defaulted in one pure place each, and documented.

**Pre-flight (in addition to §0.9)**
- [ ] Read `D:\git\omr-de-p11\src\router\config.ts`: `EnforcementConfig`, `RouterConfig.enforcement.escalate`
      (≈170), `validatePresets` (≈432+), the escalate validation block (≈879–890), `EFFORT_LEVELS`
      (43–45), the deep-merge of override layers, and the degrade-with-warning path added in `c1b9f39`.
      Confirm that an override setting only `effortBump` keeps the default `effortBumpMax`.
- [ ] Read `D:\git\omr-de-p11\docs\CONFIG_REFERENCE.md` 468–480 and 553–580, and
      `D:\git\omr-de-p11\test\unit\docs-drift.test.ts` 27–37.

**Tasks**
- **1.1.1** `[tier:medium]` `VERIFY:required` In `D:\git\omr-de-p11\src\router\config.ts`:
  - 1.1.1.a Add `maxDelegationDepth?: number | null` to the enforcement config type, and
    `effortBump?: boolean` and `effortBumpMax?: EffortLevel` to the escalate type, each with a JSDoc
    line giving its default.
  - 1.1.1.b Validation in the existing error form (`tiers.json: enforcement.<key> must be …`):
    `maxDelegationDepth` must be `null` or an integer ≥ 1 (`Number.isInteger`); `effortBump` must be
    a boolean; `effortBumpMax` must be a member of `EFFORT_LEVELS` (case-sensitive). Reject
    `__proto__`/`constructor` keys the way the existing validation does.
  - 1.1.1.c Export pure, synchronous `resolveDepthLimit(cfg): number | null` (default `1`; `null` stays
    `null`) and `resolveEffortBump(cfg): { enabled: boolean; max: EffortLevel }` (defaults `true`, `"xhigh"`).
    These are the only places those defaults exist.
- **1.1.2** `[tier:medium]` Tests in `D:\git\omr-de-p11\test\unit\config-depth-effort.test.ts`;
  extend `D:\git\omr-de-p11\test\unit\config.validate.test.ts` only where existing tables need the new
  keys.
- **1.1.3** `[tier:medium]` Document the three keys in `D:\git\omr-de-p11\docs\CONFIG_REFERENCE.md`
  (type, default, meaning, the D2/D7 notes, an example). *Amended during implementation (0.P, §1.7
  A1):* the `maxDelegationDepth` entry states that a dispatch past the limit is warned in `advisory`
  mode (the bundled default), refused in `enforced` mode, and ignored in `off` mode, and how to
  enforce it. The 1.1 acceptance "exactly as in §1.4" means the amended §1.4 row. Extend
  `D:\git\omr-de-p11\test\unit\docs-drift.test.ts` so it also asserts that the three nested key paths
  appear in `CONFIG_REFERENCE.md`.

**New tests (≥ 95% lines and branches of the new code; edge cases required)**
- Absent, empty and partial `enforcement` → defaults `1`, `true`, `"xhigh"`.
- `maxDelegationDepth`:
  - `null` accepted (guard off); `1`, `2` and `100` accepted;
  - `0`, `-1`, `-0`, `1.5`, `NaN`, `Infinity`, `1e400`, `"1"`, `true`, `[]` and `{}` rejected with the
    exact message;
  - an accessor property (a getter) is not invoked twice with different results (validate a snapshot).
- `effortBump`: `true`/`false` accepted; `"true"`, `0`, `null` rejected.
- `effortBumpMax`: each of the 5 levels accepted; `"High"`, `"ultra"`, `""`, `null`, `3` rejected.
- Override layers: an override that sets only one key keeps the others; a bad override layer is
  dropped with a warning naming the offending value and the bundled defaults stand (startup not
  prevented); `__proto__` keys do not pollute.
- `resolveDepthLimit`/`resolveEffortBump` are pure: the same input gives a deep-equal output and the
  input is not mutated (frozen-object test).
- Docs drift fails when a key is removed from `CONFIG_REFERENCE.md` (negative test using a fixture string).

**Acceptance criteria**
- The three keys validate, default and document exactly as in §1.4; existing config tests pass
  unchanged; no other module applies these defaults.

**Definition of Done**
- §0.9 holds; tests above pass; `npm run typecheck` is clean; coverage target met
  (`npx vitest run --coverage <files>`); `phase-1.1.md` has zero open findings; commits are pushed;
  merged into `de/main` by the orchestrator, with typecheck and the capped suite green after the merge.

**QA review** `[tier:heavy]` CAP:none — reason: adversarial review must read the full config diff, the
override merge and every caller of the validation.
Adversarial focus: can an override layer delete a default, or set `maxDelegationDepth` to something
that slips past validation? Is the degrade path still non-bricking? Are the defaults duplicated
anywhere? Does the docs-drift test actually fail on drift?

---

#### Phase 1.2 — Depth tracker (M1) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** `D:\git\opencode-model-router\src\router\depth.ts` resolves any session's delegation depth
correctly, fast, bounded and per D2. It has no dependency on `src\index.ts`.

**Pre-flight (in addition to §0.9)**
- [ ] Read `lookupRootSession`/`resolveIsRootSession` (from `de/wave-1-base`:
      `src\index.ts` ≈253–324) and `sweep`/`evict`/TTL in `D:\git\omr-de-p12\src\router\sessions.ts`
      (≈350–448). The tracker follows the same conventions: failures throttled for 30 s, and the same
      idle TTL.
- [ ] Confirm the shape of the `client.session.get` response (`res.data.parentID`) from the code and
      from the `@opencode-ai/sdk` types in `D:\git\omr-de-p12\node_modules`.

**Tasks**
- **1.2.1** `[tier:heavy]` CAP:3. Design memo, committed as `## Implementation notes` in `phase-1.2.md`.
  Pasted context: the pre-flight excerpts. It specifies the API below, the walk algorithm, the
  in-flight sharing, the conflict rule ("larger depth wins", D2), the eviction policy and the
  concurrency invariants.
- **1.2.2** `[tier:medium]` `VERIFY:required` Implement `D:\git\omr-de-p12\src\router\depth.ts`:
  ```ts
  export const MAX_DEPTH_HOPS = 32;
  export interface DepthTrackerSeams {
    getParent(sessionID: string): Promise<string | null>; // authoritative; throws on backend error
    now(): number;
    logger: { warn(msg: string): void };
  }
  export interface DepthTracker {
    recordRoot(sessionID: string): void;                                   // authoritative evidence only (D2)
    recordCreated(sessionID: string, parentID: string | null): void;       // session.created
    recordPluginChild(sessionID: string, creatorID: string | null): void;  // D3
    depthOf(sessionID: string, opts?: { timeoutMs?: number }): Promise<number | undefined>;
    forget(sessionID: string): void;
    sweep(): void;
    size(): number;
  }
  export function createDepthTracker(seams: DepthTrackerSeams, opts?: { ttlMs?: number; maxEntries?: number }): DepthTracker;
  ```
  - 1.2.2.a Known depths are memoized. `recordCreated` with a known parent sets parent + 1
    immediately; with an unknown parent, it stores the link, and the depth is resolved lazily.
    Out-of-order events (child before parent) resolve correctly once the parent is known.
  - 1.2.2.b Conflicts keep the **larger** depth and log one warning (D2): a root record followed by a
    `parentID`, or two different parents.
  - 1.2.2.c `depthOf` walks `getParent` iteratively, stops at the first ancestor with a known depth,
    detects cycles (visited set) and caps at `MAX_DEPTH_HOPS`; both caps return `MAX_DEPTH_HOPS` (D2).
    It memoizes every node on the walked path. Concurrent `depthOf` calls for the same id share one
    in-flight promise. The `timeoutMs` default is 2000; on timeout or error it returns `undefined`,
    warns once per session id, and throttles failures for 30 s. A walk that times out never leaves a
    rejected promise unhandled.
  - 1.2.2.d `recordPluginChild` sets creator depth + 1, or 1 when the creator is unknown or `null`;
    never 0.
  - 1.2.2.e Bounded memory: TTL eviction in `sweep()` and a `maxEntries` cap (default 10 000) that
    evicts least-recently-used entries. A memoized depth is an absolute number, so evicting an
    ancestor never changes a descendant's depth. An evicted descendant is re-resolved, never assumed
    to be a root.
- **1.2.3** `[tier:medium]` Tests in `D:\git\omr-de-p12\test\unit\depth.test.ts`.

**New tests (≥ 95% lines and branches; edge cases required)**
- Root → 0; chains of 1, 2 and 5 levels; 31, 32 and 33 levels (cap boundary).
- Out-of-order `recordCreated` (grandchild, then child, then root).
- A cycle A→B→A, and a self-parent A→A → `MAX_DEPTH_HOPS`; no infinite loop (test with a step budget).
- Conflicts: `recordRoot(X)` then `recordCreated(X, P)` with P at depth 2 → 3; the reverse order →
  still 3.
- Backend error, a rejection with a non-Error value, and a hang beyond `timeoutMs` (fake timers) →
  `undefined`, one warning per session id, a throttled retry after 30 s, and no unhandled rejection
  (`process.on('unhandledRejection')` spy).
- 100 concurrent `depthOf` calls for the same id → exactly one walk (count `getParent` calls).
- A parent learned mid-walk (an event arrives during an await) → a consistent result.
- `recordPluginChild` with a `null` creator → 1, and with a creator at depth 3 → 4.
- TTL sweep and the LRU cap (cap = 3 in the test); memory does not grow past `maxEntries`. A
  descendant evicted and then queried is re-walked, never reported as 0.
- Empty-string and non-string ids are treated as "no parent" / ignored, never thrown.

**Acceptance criteria**
- Depth is exact for every acyclic chain within the cap, `MAX_DEPTH_HOPS` for cycles or overlong chains,
  and `undefined` only on backend failure or timeout. Conflicting evidence never lowers a depth. Never
  more than one backend walk per session concurrently. Memory is bounded.

**Definition of Done**
- §0.9; tests pass; typecheck clean; coverage met; `phase-1.2.md` zero open findings; pushed; merged.

**QA review** `[tier:heavy]` CAP:none — reason: adversarial review of async memoization, cycle handling
and eviction needs the full module and its tests.
Adversarial focus: unhandled promise rejections; a stale in-flight promise poisoning a later lookup;
any sequence of events, evictions and lookups that yields a **lower** depth than the truth (a guard
bypass); timer leaks; failure throttling hiding a recovered backend; LRU accounting drift.

---

#### Phase 1.3 — Effort ceiling and ladder effort step (M3, M4) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** the pure effort algebra is final: `effortCeilingFor` agrees exactly with `buildAgentOptions`,
and the ladder emits bumped retries per D7/D8 while staying identical to `v2.0.0` when the bump is off.

**Pre-flight (in addition to §0.9)**
- [ ] Read `D:\git\omr-de-p13\src\router\agent-options.ts` 1–169 in full and
      `D:\git\omr-de-p13\src\escalate\ladder.ts` in full; read
      `D:\git\omr-de-p13\test\unit\ladder.test.ts` and `D:\git\omr-de-p13\test\unit\effort.test.ts`.
- [ ] Before changing any code, capture a **golden action table** from the unmodified
      `nextAction`/`advance`/`formatLadderScorecard`. It covers every combination of verdict
      (pass/fail/unverifiable) × attempts × cost (below, at and above the ceiling) × ladder position,
      for the default policy and two custom policies (one with `maxAttemptsPerTier: 2`, one with a
      `floorTier`). Commit it as `D:\git\omr-de-p13\test\unit\__fixtures__\ladder-v2.0.0-golden.json`.

**Tasks**
- **1.3.1** `[tier:heavy]` CAP:3. Design memo in `phase-1.3.md`: the exact rules of `effortCeilingFor`
  derived from `buildAgentOptions` (the adaptive-Claude, budget-precedence, explicit
  `reasoning.effort` and `variant` cases), the `nextEffort` function, the new
  `LadderState`/`LadderAction`/`EscalatePolicy` fields, and the argument that the bump-off path is
  identical.
- **1.3.2** `[tier:medium]` `VERIFY:required` In `D:\git\omr-de-p13\src\router\agent-options.ts`, export:
  - `effortRank(level)`;
  - `nextEffort(current, bound): EffortLevel | null`;
  - `effortCeilingFor(tier: TierConfig): EffortLevel | null`, per M3/D7.

  Refactor nothing else. The family detection is reused, not duplicated.
- **1.3.2b** `[tier:medium]` `VERIFY:required` *Amended during implementation (0.P, §1.7 A4).* In the
  same file, make `buildAgentOptions` emit provider-native keys (`reasoningEffort`,
  `reasoningSummary`, `thinking: { type: "enabled", budgetTokens }`, `effort`) instead of
  `reasoning_effort`, `reasoning_summary` and `budget_tokens`, keeping every precedence rule and
  warning. Update `D:\git\omr-de-p13\test\unit\effort.test.ts`,
  `D:\git\omr-de-p13\test\integration\fable-effort-preset.test.ts` and
  `D:\git\omr-de-p13\test\smoke\registration.smoke.test.ts` (≈165) to the native keys. Record a
  handoff to 2.3 (the v2 bridge translation) and to 3.1 (docs and the CHANGELOG `Fixed` entry).
- **1.3.3** `[tier:medium]` `VERIFY:required` In `D:\git\omr-de-p13\src\escalate\ladder.ts`:
  - 1.3.3.a New fields:
    - `EscalatePolicy.effortBump?: { perTier: Record<string, { base: EffortLevel; bound: EffortLevel }> } | null`;
    - `LadderState.currentEffort: EffortLevel | null`, initialised to `null` by `newLadderState`;
    - `LadderAction.effort?: EffortLevel`.
  - 1.3.3.b `nextAction`: on the retry branch, when `policy.effortBump?.perTier[tier]` exists, set
    `effort = nextEffort(state.currentEffort ?? base, bound) ?? state.currentEffort ?? undefined`
    (one step up, or keep the current bump). Everything else is unchanged; the order of checks is
    unchanged.
  - 1.3.3.c `advance`: a retry stores `action.effort` in `currentEffort`; an escalation resets it to `null`.
  - 1.3.3.d `formatLadderScorecard` shows `tier@effort` for bumped attempts only. The output with the
    bump off is byte-identical to `v2.0.0`.
- **1.3.4** `[tier:medium]` (**dependency edge: starts after Phase 1.1 is merged; rebase `de/p13`
  first**) `buildEscalatePolicy(cfg)`:
  - When `resolveEffortBump(cfg).enabled`, build `perTier` from the active tiers, using the same
    accessor `index.ts` uses (`getActiveTiers`).
  - For each tier, `bound = min(effortCeilingFor(tier), resolveEffortBump(cfg).max)`.
  - Include a tier only when D7 allows it and `rank(bound) > rank(tier.effort)`.
  - When the bump is disabled, or no tier qualifies, `effortBump` is `null`.
- **1.3.5** `[tier:medium]` Tests: `D:\git\omr-de-p13\test\unit\effort-ceiling.test.ts` (new); extend
  `D:\git\omr-de-p13\test\unit\ladder.test.ts` and `D:\git\omr-de-p13\test\unit\effort.test.ts`.

**New tests (≥ 95% lines and branches of the new code; edge cases required)**
- **Agreement property.**
  - Fixtures: every family (OpenAI reasoning, Claude adaptive-only, Claude with a manual-budget model,
    unknown family, including Bedrock and Vertex id forms) × every configured effort × the
    thinking/reasoning/variant variants.
  - For every level `L ≤ effortCeilingFor(tier)`: `buildAgentOptions({ ...tier, effort: L })` emits `L`
    unchanged and logs **no** warning.
  - For `L` above the ceiling, it downgrades or warns.
  - `effortCeilingFor` is `null` exactly when no level would pass through unchanged, or when D7
    excludes the tier.
- `nextEffort` over the whole 5×5 grid (current × bound), including `current > bound` → `null`.
- **Golden equivalence:** with `effortBump: null`, `nextAction`, `advance` and
  `formatLadderScorecard` reproduce `ladder-v2.0.0-golden.json` exactly.
- **Bump on:**
  - the default ladder with `fast` effort `low` produces fast@low → fast@medium → medium@base →
    medium@base+1;
  - with `maxAttemptsPerTier: 2`, the steps are low → medium → high (bound high), then a fourth retry
    stays at high;
  - `maxAttemptsPerTier: 0` → no bump;
  - the cost ceiling blocks a bumped retry exactly as it blocks a plain one;
  - `unverifiable` → `give_up`, no bump;
  - `floorTier` interplay;
  - a tier whose base already equals its bound gets a plain retry.
- **`buildEscalatePolicy`:**
  - a tier without `effort` is excluded, and so is a tier with a `variant`;
  - `effortBumpMax: "low"` disables every tier;
  - `enabled: false` → `null`;
  - an OpenAI tier at `medium` gets bound `high`;
  - a Claude tier at `high` gets bound `xhigh` with the default max;
  - a Claude tier at `xhigh` with the default max `"xhigh"` is excluded (its base equals its bound);
  - with `effortBumpMax: "high"`, a Claude tier at `high` is excluded and an OpenAI tier at `medium`
    still gets bound `high`.

**Acceptance criteria**
- Bump off ≡ `v2.0.0` (golden). Bump on follows D8 exactly. The ceiling never produces a value that
  `buildAgentOptions` would alter or warn about.

**Definition of Done**
- §0.9; tests pass; typecheck clean; coverage met; `phase-1.3.md` zero open findings; pushed; merged
  after 1.1.

**QA review** `[tier:heavy]` CAP:none — reason: the reviewer must cross-check the ceiling against every
branch of buildAgentOptions and the ladder against the golden table.
Adversarial focus:
- a family or model id that makes `effortCeilingFor` disagree with `buildAgentOptions` (case,
  provider prefixes, Bedrock and Vertex model ids);
- a bump that lowers effort, or survives an escalation;
- a golden table that does not actually cover the cost-ceiling branch;
- attempt-count drift.

---

### Wave 2 — Adapters and plugin integration

At the start of Wave 2, the orchestrator tags `de/main` as `de/wave-2-base`.

#### Phase 2.1 — Depth guard adapter (M2) `[tier:medium]`

**Depends on:** 1.1, 1.2 merged.

**Goal:** `D:\git\opencode-model-router\src\router\depth-guard.ts` turns (caller session, config) into the
existing guard's result per D1–D6. It is fully tested without the plugin.

**Pre-flight (in addition to §0.9)**
- [ ] Re-read the guard result type, switch and mode identified in 0.P.2.a, and the `delegate` refusal
      form from 0.P.2.b, in `D:\git\omr-de-p21`.

**Tasks**
- **2.1.1** `[tier:medium]` `VERIFY:required` Implement:
  ```ts
  export function createDepthGuard(deps: {
    tracker: DepthTracker;
    limit: () => number | null;          // resolveDepthLimit(activeCfg), read per call (live config)
    mode: () => "off" | <the existing guard modes resolved in 0.P>; // D6
    logger: { warn(msg: string): void };
  }): {
    checkDispatch(callerSessionID: string | undefined): Promise<GuardResult>; // GuardResult = the existing guard type
  };
  export function depthLimitMessage(depth: number, max: number): string;     // D5, exact text
  ```
  - An `undefined` caller id is treated as unknown: allow and warn (D2).
  - An `"off"` mode or a `null` limit allows without a lookup (no backend call).
  - The advisory mode, if one exists, returns that mode's warning result instead of a block (D6).
- **2.1.2** `[tier:medium]` Tests in `D:\git\omr-de-p21\test\unit\depth-guard.test.ts`.

**New tests (≥ 95%; edge cases required)**
- Truth table: depth {0, 1, 2, 31, `MAX_DEPTH_HOPS`, unknown} × limit {null, 1, 2, 32} × every guard mode.
- Boundary: depth 0 with limit 1 → allow; depth 1 with limit 1 → block; depth 1 with limit 2 → allow.
- The message equals D5 byte for byte (snapshot).
- A limit changed between calls (live config) is honoured on the next call.
- No tracker call when the guard is off or the limit is `null` (spy).
- The tracker rejects or times out → allow, with exactly one warning per caller.

**Acceptance / DoD** — D1–D6 hold in the truth table; §0.9; typecheck; coverage; `phase-2.1.md` zero
open findings; pushed; merged.

**QA review** `[tier:heavy]` CAP:none — reason: guard-bypass analysis needs the adapter, the tracker and
the guard types together.
Adversarial focus: any input that yields "allow" for a provably deep caller (an off-by-one, NaN depth,
string depth, mode confusion); warning spam; a lookup on the hot path when the guard is disabled.

---

#### Phase 2.2 — Per-session effort override (M5, D9) `[tier:medium]`

**Depends on:** 1.1, 1.3 merged. Written for D9's primary mechanism. For the fallback, the module
exposes the same API and returns `{ variant }` for the prompt instead of applying options in
`chat.params`.

**Goal:** a pure, testable override store, and the function that the `chat.params` hook calls to apply
the bumped options for a producer session.

**Pre-flight (in addition to §0.9)**
- [ ] Re-read the Spike B evidence in `phase-0P.md`: the exact `output.options` shape on v1 and the
      bridged `event.options` shape on v2, and the precedence between model, agent, variant and
      `chat.params` options.
- [ ] Re-read `buildAgentOptions` and `effortCeilingFor` on `de/main`.

**Tasks**
- **2.2.1** `[tier:medium]` `VERIFY:required` `D:\git\omr-de-p22\src\escalate\effort-override.ts`:
  ```ts
  export interface EffortOverrideStore {
    set(sessionID: string, tierName: string, tier: TierConfig, effort: EffortLevel): void;
    clear(sessionID: string): void;
    has(sessionID: string): boolean;
    size(): number;
  }
  export function createEffortOverrideStore(opts?: { maxEntries?: number }): EffortOverrideStore;
  /** Merges buildAgentOptions({ ...tier, effort }) into the chat.params output for a registered session. No-op otherwise. */
  export function applyEffortOverride(
    store: EffortOverrideStore, input: { sessionID?: string }, output: { options?: Record<string, unknown> },
    logger: { warn(msg: string): void },
  ): void;
  ```
  - `set` refuses (with a warning) an effort above `effortCeilingFor(tier)`, as defence in depth
    against a ladder bug.
  - `applyEffortOverride` creates `output.options` when it is absent. It overwrites only the keys that
    `buildAgentOptions` produces for the bumped tier, and it is idempotent across repeated LLM calls
    of the same session. It never throws: errors are logged (§0.10.10).
  - The store is bounded (default 1 000 entries, oldest evicted with a warning), because a leaked
    entry must not grow memory without limit.
- **2.2.2** `[tier:medium]` Tests: `D:\git\omr-de-p22\test\unit\effort-override.test.ts`.

**New tests (≥ 95%; edge cases required)**
- Unregistered session → `output` deep-equal before and after.
- Registered OpenAI tier at `medium` bumped to `high` → `output.options` carries exactly the
  `buildAgentOptions` effort keys for `high`. The same for a Claude tier. Unrelated keys already in
  `output.options` are untouched.
- `output.options` absent → created; `output` frozen or a getter that throws → logged, no throw.
- Idempotence: applied 5 times → the same result.
- `clear` → the next apply is a no-op; `clear` of an unknown id is a no-op.
- `set` above the ceiling → refused with a warning, and `has` is false.
- Bounded store: `maxEntries` = 2, then a third `set` → the oldest is evicted, with a warning.
- Agreement: for every bumpable fixture tier from 1.3, the applied options equal
  `buildAgentOptions({ ...tier, effort })` restricted to the effort-related keys.

**Acceptance / DoD** — the override applies exactly the bumped options to registered sessions and
nothing else; bounded; never throws; §0.9; typecheck; coverage; `phase-2.2.md` zero open findings
(handoffs to 2.3 listed); pushed; merged.

**QA review** `[tier:heavy]` CAP:none — reason: the reviewer must check the merge semantics against the
Spike B evidence and buildAgentOptions.
Adversarial focus:
- an override leaking to another session (the grader, the orchestrator);
- an override surviving its producer;
- a key that the bumped options should remove but do not (an old effort key left in place by the
  tier's base options under a different name);
- a ceiling bypass;
- unbounded growth.

---

#### Phase 2.3 — Plugin wiring for both features `[tier:heavy]` design + `[tier:medium]` implementation

**Depends on:** 2.1, 2.2 merged. Sole writer of `D:\git\opencode-model-router\src\index.ts` in Wave 2.

**Goal:** #66 and #67 work end to end inside the plugin on v1 and v2. After this phase, the issues are
solved in code.

**Pre-flight (in addition to §0.9)**
- [ ] List and apply every "handoff to 2.3" recorded in `phase-2.1.md` and `phase-2.2.md`.
- [ ] Re-read, at the current line numbers in `D:\git\omr-de-p23\src\index.ts`:
      - the `"tool.execute.before"` task branch;
      - the `delegate` tool and `runProducerAttempt`;
      - the producer unregister/dispose path;
      - the `chat.params` hook;
      - the `session.created` handler;
      - `lookupRootSession`;
      - the periodic sweep;
      - the trajectory store's call recording.

      Also re-read `D:\git\omr-de-p23\src\compat\v2-hooks.ts` (`execute.before`, `chat.params` and the
      `session.created` translation) and the grader creation in `D:\git\omr-de-p23\src\verify\wiring.ts`.
- [ ] Re-run Spike A's assertion against the current bridge (it may have been affected by merges).

**Tasks**
- **2.3.1** `[tier:heavy]` CAP:3. Wiring design. Pasted context: the pre-flight excerpts. It covers:
  - the exact insertion points;
  - the order of operations in the task before-hook;
  - how `lookupRootSession`'s **authoritative** results seed the tracker (`true` → `recordRoot`; a
    `parentID` → `recordCreated`), with no second backend call;
  - how a refused call is recorded for the false-refusal detector without creating dispatch state (D4);
  - the v2 refusal path from Spike A;
  - where the effort override is set and cleared around each producer attempt.
- **2.3.2** `[tier:medium]` `VERIFY:required` Depth wiring in `D:\git\omr-de-p23\src\index.ts`:
  - 2.3.2.a Create one `DepthTracker` per plugin instance, with `getParent` built on
    `ctx.client.session.get`; call its `sweep()` from the existing periodic sweep.
  - 2.3.2.b `session.created` → `tracker.recordCreated(info.id, info.parentID ?? null)`, next to the
    existing `markChildSession`. `lookupRootSession`'s authoritative results seed the tracker (D2).
  - 2.3.2.c `"tool.execute.before"`, `task` branch: `await depthGuard.checkDispatch(input.sessionID)` as
    the **first** step. On a block: record the attempted call for the caller (D4), then throw
    `new Error(message)` (the existing block path) before the prompt repair, `startDispatch` or any
    other store write.
  - 2.3.2.d `delegate` tool `execute`: call `checkDispatch(toolCtx?.sessionID)` before any session is
    created; refuse in the tool's existing refusal form (0.P.2.b).
  - 2.3.2.e Producer creation (≈626–634) → `tracker.recordPluginChild(sid, toolCtx?.sessionID ?? null)`.
- **2.3.3** `[tier:medium]` `VERIFY:required` Grader creation in `D:\git\omr-de-p23\src\verify\wiring.ts`
  (≈1237) → `recordPluginChild(graderSid, parentSessionID ?? null)`, through a new optional
  `onChildSessionCreated?(sid, parentSid)` dependency in wiring's existing deps object. This is the
  only edit to that file.
- **2.3.4** `[tier:medium]` `VERIFY:required` v2 in `D:\git\omr-de-p23\src\compat\v2-hooks.ts`:
  - Make sure a before-hook throw reaches the v2 caller as a tool error. If Spike A showed that it
    already does, add only the test.
  - Make sure v2 background dispatches pass the caller session id to the guard.
  - Make sure the bridged `chat.params` output shape lets `applyEffortOverride` reach the provider
    options, per Spike B.
  - *Amended during implementation (0.P, §1.7 A3/A4):* the effort override reaches `event.options`
    (flat) through an explicit v2 seam, gated by agent and model identity; the registration
    translation (≈125–135) passes native keys unchanged and lets an explicit native key win over its
    snake-case alias.
- **2.3.5** `[tier:medium]` `VERIFY:required` Effort wiring in `D:\git\omr-de-p23\src\index.ts`:
  - 2.3.5.a One `EffortOverrideStore` per plugin instance.
  - 2.3.5.b `runProducerAttempt(tier, forcingNote, effort?)`: the ladder loop passes `action.effort`.
    After the producer session id is known and **before** its prompt is sent, call
    `store.set(sid, tier, tierConfig, effort)` when `effort` is set. Clear the entry in the same
    `finally` path that unregisters and disposes the producer session, so it is cleared on success,
    failure, timeout and abort.
  - 2.3.5.c The `"chat.params"` hook calls `applyEffortOverride(store, input, output, logger)`. This
    is independent of the grader-temperature branch: a session is never both.
  - 2.3.5.d The agent, model and variant passed to the producer are unchanged (the base tier's);
    `registerProducerSession` keeps the base tier. The scorecard comes from 1.3.3.d.
- **2.3.6** `[tier:medium]` Integration tests:
  `D:\git\omr-de-p23\test\integration\depth-guard-wiring.test.ts` (new),
  `D:\git\omr-de-p23\test\integration\ladder-effort-wiring.test.ts` (new), an extension of
  `D:\git\omr-de-p23\test\integration\ladder-wiring.test.ts`, and the v2 bridge test file from 0.P.

**New tests (integration through the real plugin factory with mocked client seams; edge cases required)**
- **Depth:**
  - a root `task` call → allowed, with no backend call beyond the existing root lookup;
  - a depth-1 `task` call → throws the D5 message. No `startDispatch`, reference capture or
    changed-file state was created (spies on each store), but the attempted call **is** recorded, so
    a following zero-other-calls hand-back is **not** flagged as a false refusal;
  - `delegate` from a depth-1 session → refused, no session created;
  - `maxDelegationDepth: 2` → depth-1 allowed, depth-2 refused;
  - `null` → no guard and no lookup;
  - a backend failure → allowed, with one warning;
  - a producer created without `toolCtx.sessionID` → depth 1, and its `task` call is refused;
  - grader sessions are recorded as children;
  - a `task_id` resume from a delegate is refused, and from the orchestrator it is allowed;
  - the same scenarios through the v2 bridge, including a background dispatch;
  - `session.created` events arriving after the dispatch (out of order) still resolve;
  - the fail-open default of `resolveIsRootSession` never seeds a root.
- **Effort:**
  - a failing first attempt on a bumpable tier at `low` → the second attempt's producer session gets
    the `medium` options in `chat.params` (assert on the `output.options` that the hook produces for
    that session id). The first attempt's session, the grader and the orchestrator get none;
  - escalation → no override for the next tier;
  - the override is cleared after success, failure, timeout and abort (`store.size()` returns to 0);
  - `effortBump: false` → dispatch arguments and `chat.params` outputs identical to `v2.0.0` across
    the golden scenario set;
  - a non-bumpable tier → plain retry, no override;
  - attempt count and cost ceiling unchanged; the scorecard shows `tier@effort`;
  - the same through the v2 `chat.params` bridge.
- **Protocol/golden:** the protocol snapshot and prompt measurements are unchanged (run the existing
  tests; they must pass without updating snapshots). The set of registered agents is unchanged.

**Acceptance criteria**
- #66: a delegate cannot dispatch past the limit through `task` (v1, v2, background, resume) or
  `delegate`. A refusal leaves no dispatch state behind and is not mistaken for a false refusal.
  Orchestrators are unaffected.
- #67: router ladder retries are bumped per D8 through `chat.params` on v1 and v2, scoped to the
  bumped producer session and cleared after it, and are identical to `v2.0.0` when disabled.

**Definition of Done**
- §0.9; all new and existing tests pass; typecheck clean; `npm run smoke:keyless` and `npm run smoke:v2`
  pass in the worktree; `phase-2.3.md` zero open findings; pushed; merged; after the merge, the capped
  full suite is green on `de/main`.

**QA review** `[tier:heavy]` CAP:none — reason: whole-feature adversarial review across index.ts,
v2-hooks.ts, wiring.ts and the four new modules.
Adversarial focus — try to:
- dispatch from depth ≥ 1 without being refused: v2 background, `task_id` resume, a producer created
  without `parentID`, a grader, a race between `session.created` and the first `task` call, a session
  evicted by the TTL mid-dispatch, a fail-open root seed;
- leave dispatch state behind after a refusal, or trigger the false-refusal banner on a legitimate
  post-refusal hand-back;
- make an orchestrator pay a backend call per dispatch;
- make the effort override reach the wrong session, outlive its producer, or apply when disabled;
- break the golden protocol or the agent list.

---

### Wave 3 — Document, prove, review, release

At the start of Wave 3, the orchestrator tags `de/main` as `de/wave-3-base`.

#### Phase 3.1 — Docs, ADR, changelog `[tier:medium]`

**Depends on:** 2.3 merged. Parallel with 3.2.

**Pre-flight (in addition to §0.9)**
- [ ] Collect the shipped behaviour from `phase-2.3.md` (any *Amended during implementation* notes) and
      the 0.P.2.g preset table.

**Tasks**
- **3.1.1** `[tier:medium]` `D:\git\omr-de-p31\docs\adr\0004-delegation-depth-and-effort-bump.md`:
  - context (#17, #66, #67);
  - the D1–D11 decisions and their trade-offs: fail-open versus conflicting evidence, the bump only
    when D7 allows it, the ratio-based cost, and the scope limits of D11;
  - the D9 spike evidence;
  - the alternatives rejected, including derived hidden agents: they would have added agents that the
    `task` tool can list.
- **3.1.2** `[tier:medium]` `D:\git\omr-de-p31\docs\CONFIG_REFERENCE.md`: final pass against the shipped
  behaviour (amendments from 2.x), plus a "where the bump applies with the bundled presets" table.
- **3.1.3** `[tier:medium]` `D:\git\omr-de-p31\README.md`: short sections on the delegation-depth guard
  and the effort bump, linking CONFIG_REFERENCE and the ADR.
- **3.1.4** `[tier:medium]` `D:\git\omr-de-p31\CHANGELOG.md` under `## [Unreleased]`:
  - Added: both features.
  - Changed: the ladder retry now bumps effort by default; dispatches past
    `enforcement.maxDelegationDepth` (default `1`) are warned in `advisory` mode (the bundled default)
    and refused in `enforced` mode (§1.7 A1); how to opt out of each.
  - Fixed: OpenCode v1 now receives the `effort`, `reasoning.*` and `thinking.budgetTokens` settings it
    silently dropped before, flagged as a v1 behaviour change with the cases and remedy of §1.7 A4.
  - Credit: "Observations by @MetalbolicX in opencode-smart-router (#17); implementation written from
    scratch."
- **3.1.5** `[tier:medium]` `D:\git\omr-de-p31\docs\plans\README.md`: index entry for this plan, the ADR
  and the QA folder.

**Acceptance / DoD** — every documented default, message and behaviour matches the code (QA checks each
claim against a file:line); docs-drift test green; `phase-3.1.md` zero open findings; pushed; merged.

**QA review** `[tier:heavy]` CAP:none — reason: every documented claim must be checked against the code.
Adversarial focus: a doc claim the code does not implement; a missing opt-out; an undocumented scope
limit; credit wording that implies co-authorship.

---

#### Phase 3.2 — End-to-end proof in real OpenCode `[tier:medium]` (+ `[tier:fast]` runs)

**Depends on:** 2.3 merged. Parallel with 3.1.

**Pre-flight (in addition to §0.9)**
- [ ] Re-read the 0.P.2.i harness findings, `D:\git\omr-de-p32\vitest.smoke.config.ts` and the existing
      smoke files that the new test reuses.

**Tasks**
- **3.2.1** `[tier:medium]` `D:\git\omr-de-p32\test\smoke\depth-effort.smoke.test.ts`, run in real
  opencode on v1 and v2. It always asserts:
  - (a) the plugin loads with each of the three keys set, unset and invalid; an invalid value degrades
    with the warning and never blocks startup;
  - (b) the registered agent list is identical to the baseline.

  If the harness captures provider requests (0.P.2.i), it also asserts:
  - (c) a `task` call from a child session is refused with the D5 text, and a root's is not;
  - (d) a bumped attempt's request carries the bumped effort, and the next request of a different
    session does not.

  Without a capture, (c) and (d) run only when provider keys are present, gated like
  `smoke:v2:e2e`. When they cannot run, record "not run: <reason>" in `phase-3.2.md`; G1 and G4 then
  rest on the 2.3 integration tests and the Spike A/B evidence. The script that runs the new file is a
  handoff to 3.4 (owner of `package.json`).
- **3.2.2** `[tier:fast]` Run `npm run smoke:keyless`, `npm run smoke:v2`, the new smoke file and the
  capped full suite, and record the outputs in `phase-3.2.md`.
- **3.2.3** `[tier:medium]` **Mutation check of the proofs:** temporarily disable the guard
  (`maxDelegationDepth: null`) and the bump (`effortBump: false`) through config, not code, and show
  that the corresponding integration and smoke assertions fail. Record the evidence, then restore.

**Acceptance / DoD** — every runnable assertion passes on v1 and v2; the mutation check shows that each
proof detects the feature being off; outputs recorded; `phase-3.2.md` zero open findings; pushed;
merged.

**QA review** `[tier:heavy]` CAP:none — reason: the reviewer must judge whether the tests prove the
claims or only exercise them.
Adversarial focus: assertions that would pass with the feature disabled; flaky timing; a "not run"
that hides a gap the integration tests do not cover.

---

#### Phase 3.3 — Global senior QA review `[tier:heavy]` CAP:none — reason: whole-change adversarial review across every file of the plan.

**Pre-flight**
- [ ] 3.1 and 3.2 merged; capped full suite, typecheck, `smoke:keyless` and `smoke:v2` green on `de/main`;
      every phase report shows zero open findings; `router_verify` `pending: true` is empty.
- [ ] `[tier:fast]` gathers the full diff `git -C D:\git\omr-de-main diff origin/master...de/main`, all
      phase reports, and the test outputs, and pastes them into the heavy dispatch.

**Tasks**
- **3.3.1** `[tier:heavy]` Adversarial review of the whole change against §4.1 G1–G6. Try to:
  - bypass the depth guard by any in-process path;
  - make the guard brick an orchestrator;
  - make the bump send an effort a model rejects, lower effort, add attempts, exceed the cost
    ceiling, or leak to another session;
  - change the protocol text or the agent list;
  - find a doc claim the code contradicts;
  - find an AI-attribution or co-author trailer anywhere in the branch history
    (`git log origin/master..de/main --format=%B`).

  Record every attempt and its outcome in `D:\git\omr-de-main\docs\qa\depth-and-effort\global.md`.
- **3.3.2** `[tier:medium]` Fix **every** finding (own commits, by the orchestrator serially in
  `D:\git\omr-de-main`, or in a short-lived worktree per fix), then re-run the §0.9 checks and the smoke
  tests. **3.3.3** `[tier:heavy]` Re-review the fixes, applying the bounded QA rounds of §0.7 (from
  round 3 on, only `blocking`, `critical` and `major` findings are fixed). §0.8 applies to repeated failures.

**Acceptance / DoD** — zero open findings in `global.md`; everything green after the fixes.

---

#### Phase 3.4 — Release `2.1.0` and local sync `[tier:medium]` (+ `[tier:fast]` verification)

**Pre-flight**
- [ ] Phase 3.3 closed with zero findings; `de/main` green in CI.
- [ ] `npm view opencode-model-router version` is lower than `2.1.0`. If another release landed in
      between, rebase `de/main` on `master`, re-run 3.2.2, and release as the next minor after it
      (update the version everywhere this phase mentions `2.1.0`).
- [ ] Apply the 3.2 handoffs to `package.json` (the smoke script), if any.

**Tasks**
- **3.4.1** `[tier:medium]` Open the PR `de/main` → `master` titled
  `feat(router): delegation depth limit and effort bump before escalation`. Its body has the summary,
  M1–M5, the decisions, links to the QA reports and the ADR, `Closes #66` and `Closes #67`, and the
  credit line for @MetalbolicX (#17). No AI attribution line.
- **3.4.2** `[tier:fast]` Watch CI; on red, route per §0.8 (fix on the branch, never merge red).
- **3.4.3** `[tier:medium]` Merge with a merge commit (repo convention). On `master`: set
  `D:\git\opencode-model-router\package.json` and `package-lock.json` to `2.1.0`, and rename
  `## [Unreleased]` to `## [2.1.0] - <date>` in `D:\git\opencode-model-router\CHANGELOG.md`.
  Commit `chore(release): 2.1.0`, push, tag `v2.1.0`, push the tag.
- **3.4.4** `[tier:fast]` Watch the `Publish Package` workflow, then poll the registry until `latest`
  is `2.1.0`, with the provenance statement in the publish log.
- **3.4.5** `[tier:fast]` Sync the main checkout:
  - Check that the untracked plan and handover copies in `D:\git\opencode-model-router\docs\plans\`
    match the revision each started from: compare `git hash-object` with the blob of the 0.P.1.b
    commit on `de/main`. If both match, delete them; otherwise, stop and ask (§0.1.2).
  - Check that `git -C D:\git\opencode-model-router status --porcelain` is empty, then run
    `git -C D:\git\opencode-model-router pull --ff-only`. Anything unexpected is a §0.1.2 stop.
  - Remove every `D:\git\omr-de-*` worktree, every `de/*` branch and every `de/wave-*` tag, locally
    and on the remote.
  - Tell the human to restart the opencode sessions.

**Acceptance criteria** — `2.1.0` is `latest` on npm with provenance; `master` is tagged; #66 and #67
are closed by the PR.

**Definition of Done** — the above, plus the main checkout is at `v2.1.0` with a clean tree, no
`omr-de-*` worktrees or `de/*` branches or tags remain, and `phase-3.4.md` (written in the main
checkout's `docs\qa` folder **only after** the sync, as a follow-up commit
`docs(qa): record the 2.1.0 release review` on `master`) has zero open findings.

**QA review** `[tier:heavy]` CAP:none — reason: a release review must see the PR, the tag, the publish
log and the registry state together.
Adversarial focus: version mismatch between `package.json`, the lock file, the tag and the registry;
a missing provenance statement; a CHANGELOG entry that differs from the PR; leftover branches, tags
or worktrees; an AI-attribution line in the PR or the merge commit.

---

## 4. Global acceptance, Definition of Done, QA

### 4.1 Global acceptance criteria

- **G1 — Depth is enforced in code.** *Amended during implementation (0.P, §1.7 A1): "with the
  default config" below reads "with the default limit, when the caller's enforcement mode resolves to
  `enforced`"; in `advisory` mode (the bundled default) the dispatch proceeds with the
  `delegation_depth` banner, and in `off` the guard does nothing.* With the default config, no session at depth ≥ 1 can create a
  subagent through the native `task` tool (v1, v2, v2 background, `task_id` resume) or the `delegate`
  tool. The refusal carries the D5 text, leaves no dispatch, verification or reference state behind,
  and is not flagged as a false refusal. `maxDelegationDepth: N` allows only depths `< N` to dispatch;
  `null` disables the guard. The limits of D11 are documented. Proven by 2.1, 2.3 and 3.2.
- **G2 — Orchestrators are never harmed.** Root sessions dispatch exactly as in `v2.0.0`. A session's
  depth costs at most one backend lookup per tracked lifetime. A backend failure during a depth lookup
  never blocks a dispatch (D2). Proven by 1.2, 2.1 and 2.3.
- **G3 — Plugin-created sessions are accounted for.** Producer and grader sessions are recorded with
  creator depth + 1 (never 0), are not refused at creation, and are judged by that depth when they
  dispatch. Proven by 1.2 and 2.3.
- **G4 — Effort before tier.** With the default config, a failed router-ladder attempt on a bumpable
  tier (D7) retries on the same tier one effort level higher before escalating. Attempt counts,
  `maxTotalAttempts` and the cost ceiling behave exactly as before. Escalation restores the next
  tier's configured effort. Proven by 1.3 and 2.3.
- **G5 — The bump is safe and scoped.**
  - No bumped attempt carries an effort value that `buildAgentOptions` would downgrade, drop or warn
    about.
  - Non-bumpable tiers retry exactly as in `v2.0.0`, and `effortBump: false` is identical to `v2.0.0`
    (golden).
  - The override reaches only the bumped producer session and is cleared when that session ends.
  - No agent is added.

  Proven by 1.3, 2.2, 2.3 and 3.2.
- **G6 — Compatibility.** Existing configs load unchanged; the protocol text, golden snapshots and
  prompt measurements are byte-identical; the capped suite, typecheck, `smoke:keyless` and `smoke:v2`
  are green; CI is green on every OS × Node combination the workflows define.

### 4.2 Global Definition of Done

- [ ] All phases meet their DoD; every phase QA report and `global.md` show zero open findings.
- [ ] G1–G6 are demonstrated by tests that run in CI, and the 3.2.3 mutation check shows each proof
      fails when its feature is off. *Amended during implementation (0.P, §1.7 A3):* except the v2
      host-level legs of 3.2.1(c)/(d), which CI cannot run (no OpenCode 2 binary) and which are recorded
      as local evidence in `phase-3.2.md`.
- [ ] Coverage is ≥ 95% lines and branches for `src\router\depth.ts`, `src\router\depth-guard.ts` and
      `src\escalate\effort-override.ts`, and for the new code in `src\escalate\ladder.ts`,
      `src\router\agent-options.ts` and `src\router\config.ts`.
- [ ] The run log records that every full-suite run was capped and serialized (§0.6.9), and every
      delegation takeover with its reason (§0.10.2).
- [ ] CONFIG_REFERENCE, README, ADR 0004 and CHANGELOG describe the shipped behaviour exactly, including
      the D11 scope limits, and credit @MetalbolicX without a co-author trailer.
- [ ] No commit or PR in the branch carries AI attribution.
- [ ] `2.1.0` is published with provenance; #66 and #67 are closed; the main checkout is synced and
      clean; no temporary worktrees, branches or tags remain.
- [ ] Final report to the human, in Portuguese:
  - what shipped;
  - the G1–G6 evidence (CI links);
  - the known limits: fail-open on backend errors, the D11 scope, the ratio-based cost of bumped
    attempts, and the bump only on D7-eligible tiers (with the bundled-preset table);
  - the reminder to restart the opencode sessions.

### 4.3 Global QA

Phase 3.3 is the global senior QA review: `[tier:heavy]`, adversarial, with findings fixed and
re-reviewed under the bounded rounds of §0.7. The global DoD cannot be ticked before it closes.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Default `maxDelegationDepth: 1` breaks users who rely on nested delegation | Documented as a behaviour change in CHANGELOG and README, with the opt-out (`2` or `null`). The protocol already forbade it, and the refusal tells the delegate to do the work itself. |
| Fail-open (D2) lets a deep session dispatch when the backend errors | Accepted for availability, consistent with `resolveIsRootSession`. Bounded because plugin-created sessions are recorded at creation (no lookup needed), `session.created` events populate the cache, roots are seeded only from authoritative evidence, and failures are throttled and logged. Stated in the ADR. |
| A race: the first `task` call of a fresh child arrives before its `session.created` event | The lazy `session.get` walk resolves it; tested in 1.2 and 2.3. |
| A delegate escapes the guard by starting `opencode run` from a shell, or through another plugin's session tool | Out of scope (D11), documented in the ADR and README. The router cannot see those sessions as its own children. |
| The false-refusal detector flags a delegate that obeyed the depth refusal | D4 records the refused call as an attempted tool call; tested in 2.3. |
| A bumped effort is rejected by a provider for a specific model | The bump applies only to tiers with an explicit effort and no variant (D7). The default max is `"xhigh"` (owner decision), clamped per family, and the ceiling agrees with `buildAgentOptions` (property test). `effortBumpMax: "high"` is the documented remedy for a Claude model that rejects `xhigh`. A provider error fails that attempt, and the ladder continues as for any failed attempt. |
| D7 makes the bump inert for most bundled presets | 0.P.2.g measures it, and 0.P.5 decides with that evidence. The ADR and CONFIG_REFERENCE publish the table, so users know when the bump applies. |
| An effort override leaks to another session or outlives its producer | It is keyed by producer session id, set after creation, cleared in the same `finally` that disposes the session, and bounded; tested in 2.2 and 2.3. |
| Ratio-based cost underestimates bumped attempts | Documented limit (ADR, CONFIG_REFERENCE). `effortBump: false` and `effortBumpMax` give the user control. |
| Merge conflicts in `src\index.ts` | One writer per wave (2.3 only); Wave 1 and the 2.1/2.2 adapters never touch it. |
| The executing session's own plugin changes under it | The main checkout is never edited before Phase 3.4; the work happens in `D:\git\omr-de-*` worktrees. |

## 6. Out of scope

- Effort bumps for native `task`-path retries driven by the orchestrator (unless 0.P.2.e finds the
  ladder on that path, D10).
- A cost model that weighs effort (bumped attempts cost the tier's `costRatio`).
- Bumping tiers that have no explicit `effort` or that set a `variant` (D7).
- Changing the injected protocol text, or teaching the orchestrator about depth.
- Per-tier depth limits, limits keyed by agent name, and sessions started outside the plugin's hooks
  (D11).
- Porting any code from `opencode-smart-router`.

---

## 7. Review log

### Revision 2 — senior engineering review of revision 1

| # | Finding in revision 1 | Change |
|---|---|---|
| R1 | Option A (derived hidden agents) would add agents to the registry. OpenCode's `task` tool can list hidden subagents, so the orchestrator could dispatch them directly. It also forced edits to `sessions.ts` and agent registration. The plugin already has a per-session override precedent: `chat.params` pins the grader's temperature on v1 and v2. | D9/M5 now use a per-session `chat.params` override (`effort-override.ts`), with the per-prompt `variant` as the fallback. Derived agents, D10's name mapping and the `sessions.ts` edits are removed; `sessions.ts` is never written. Phase 2.2 is rewritten, and Spike B now tests the `chat.params` path. |
| R2 | A tier's `variant` contributes provider options (for example thinking budgets) that the ceiling did not model. | D7 and M3 exclude tiers with a `variant`. 0.P.2.g measures how many bundled tiers remain bumpable, and 0.P.5 decides with that evidence. |
| R3 | Seeding the tracker from `resolveIsRootSession` would record its fail-open default as a root: a guard bypass. Conflicting evidence had no rule. | D2: roots come only from authoritative evidence; on conflict, the larger depth wins. Tests are added in 1.2 and 2.3. |
| R4 | A refused `task` call never reaches `tool.execute.after`, so a delegate that obeyed the refusal could be flagged by the false-refusal detector. | D4: the refused call is recorded as an attempted tool call, with no dispatch state. Tests are added in 2.3. |
| R5 | D6 ignored a possible advisory mode of the existing guard. | D6 follows the existing guard's mode. 2.1 tests every mode. |
| R6 | §0.6.3 told agents to read `de/main` "as it was when the wave started" while the orchestrator merges into it mid-wave. | Wave-base tags `de/wave-<n>-base`, created at each wave start. |
| R7 | The plan file sits untracked in the main checkout: 0.P's "status clean" check would fail, and 3.4's `pull --ff-only` would refuse to overwrite it. | 0.P commits the plan to `de/main` and treats the untracked copy as expected. 3.4.5 verifies and deletes it before the pull. |
| R8 | 0.P and 3.4 had no QA review, which contradicts "QA after every phase". | Both now have a heavy adversarial QA review, acceptance criteria and DoD. |
| R9 | 3.2 asked keyless smoke tests to make a model call `task`, which needs a provider. | 3.2 asserts what keyless can prove, uses request capture or keys for the rest, records "not run" honestly, and adds a mutation check proving that each test fails when its feature is off. |
| R10 | The guard's scope was unstated: a shell-launched `opencode run` or another plugin's session tool bypasses it. | D11, plus §5 and §6 entries, and documentation in the ADR and README. |
| R11 | G2 claimed "no extra backend call on the hot path", which is untestable as worded. | It is now "at most one backend lookup per session per tracked lifetime", tested in 2.3. |
| R12 | M5 needs the producer session id before its prompt is sent, on both producer paths. | Pre-flight item 0.P.2.h; 2.3.5.b sets the override before the prompt and clears it in the dispose `finally`. |
| R13 | The existing `chat.params` handler swallows errors in an empty `catch`. | §0.10.10: new code logs instead of swallowing. Phase 2.2 tests the throwing-output case. |

### Revision 3 — owner decisions and execution rules (2026-10-05)

| # | Change |
|---|---|
| O1 | D12: `maxDelegationDepth` defaults to `1`, `effortBumpMax` defaults to `"xhigh"` (clamped per family by M3), and autonomous execution is approved through the release. The `effortBumpMax` default changed from `"high"` in §1.4, D7, 1.1, 1.3 and §5. |
| O2 | §0.7 and §0.10.4: bounded QA rounds. Rounds 1 and 2 fix everything; from round 3 on, only `blocking`, `critical` and `major` findings are fixed. "Zero open findings" is redefined accordingly. |
| O3 | §0.10: the owner's execution rules restated: iterate continuously, take over momentarily when the router blocks you repeatedly, pre-flight fix-or-document, heavy coding allowed for complex tasks, heavy lift split from test runs, accelerated scoped tests, and Linear updates only if Linear is in use. |
| O4 | 0.P.1 and 3.4.5 handle the untracked handover file alongside the plan. |

### Revision 4 — Phase 0.P amendments (2026-10-05)

| # | Change |
|---|---|
| P1 | §1.7 A1–A12: the spike verdicts (D4, D6, D7 reach, D9, D10, D3, M5 timing), the host-level Spike A2, the before-hook order and `/bypass`, and smoke isolation, with the §2 updates. |
| P2 | Owner decision: follow D6 literally. The bundled `advisory` mode warns instead of refusing; G1, D12.1, 2.1, 2.3, 3.1.4, 3.2 and §5 are read with A1. |
| P3 | Owner decision: fix the pre-existing v1 registration bug (snake-case option keys dropped by OpenCode v1) in 1.3 (new task 1.3.2b), with the v2 bridge adjusted in 2.3 and the v1 behaviour change documented (A4). |
| P4 | 0.P QA round 1 (`phase-0P.md`, QA-0.P-1 to -17) applied. |
