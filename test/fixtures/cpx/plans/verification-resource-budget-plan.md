# Implementation Plan — Verification Resource Budget for `opencode-model-router`

> **Status:** Ready to execute
> **Owner:** Marco Jardim
> **Executor:** one high-capability LLM orchestrator, start to finish, delegating per the `[tier:X]` annotations below.
> **Base:** `origin/master` at tag `v1.14.0` (commit `60c2de3`). Target release: **`1.15.0`**.
> **Scope:** keep the acceptance gate a real guardrail for delegated implementation work while removing
> its CPU/RAM cost: the router must **never run a full test suite per delegation**.

---

## 0. Execution directives (read first — these override defaults)

### 0.1 Run the whole plan without stopping

Execute Wave 1 → Wave 2 → Wave 3 continuously, iterating phase by phase, **without pausing for
confirmation**. Stop and ask the human **only** when one of these occurs:

1. **Ambiguity that only the human can resolve** — two or more valid readings of a requirement whose
   outcomes differ materially, and neither this plan nor the code settles it.
2. **Critical problem** — data loss risk (e.g. a cleanup path that could delete a real
   `node_modules`, a user file or a git ref), a security regression (command injection, allowlist
   bypass), or a published artifact that is broken.
3. **Blocking problem** — an assumption this plan depends on is disproven by a pre-flight spike and
   no alternative in this plan applies, or the same failure persists after the recovery rule in §0.8.

Everything else — test failures, QA findings, lint errors, refactors needed to land a phase — is
work to be done, not a reason to stop.

### 0.2 Definitive solutions only

A high-capability agent executes this plan end to end. **Do not** ship stubs, TODO placeholders,
feature flags that disable half-built code, "phase 1 of N" partial behaviour, or temporary
compatibility shims. Every phase delivers the final implementation of its sub-objective. Wave 1
builds complete, final components; Wave 2 integrates them into the final pipeline; Wave 3 proves it
end to end and releases it. No phase exists only to be replaced later.

### 0.3 Commit often

- Commit at the end of **every subtask** that leaves the tree green (typecheck + the tests the
  subtask touches). Never commit a red tree.
- Conventional commits, matching the repo: `feat(verify): …`, `fix(verify): …`, `test(verify): …`,
  `docs(verify): …`, `chore(release): …`.
- Push the phase branch after every commit so no work exists only locally.
- QA fixes are their own commits (`fix(verify): address QA-<phase>-<n> …`).

### 0.4 Paths

Every file reference in dispatches, commits, QA reports and code comments that point at files uses
the **full path**. Repo root: `D:\git\opencode-model-router`. Never edit files in that main
checkout directly (see §0.6.4): all work happens in worktrees under `D:\git\`.

### 0.5 Model-router annotations

Every task carries a routing tag the router honours (`[tier:X]→delegate X`):

| Tag | Use for |
|---|---|
| `[tier:fast]` | Context gathering, pre-flight checks, running tests/CI and reporting results, mechanical file moves |
| `[tier:medium]` | Implementation, test writing, refactors, docs, applying QA fixes |
| `[tier:heavy]` | Reasoning-dense design (attribution semantics, cleanup safety, security of command construction) and **every QA review** |

**QA is always a `[tier:heavy]` task. Always apply this rule.** Every phase and the global
review delegate to heavy for an **adversarial** review of the work done: the reviewer's job is
to break it, not to confirm it.

Heavy dispatches follow the router protocol: gather context with `[tier:fast]` first and paste it
into the heavy prompt; heavy reasons over supplied context. QA dispatches may use
`CAP:none` **with** a `reason:` line (an adversarial review must read every changed file).

The router honours `CAP:none` **only** when the dispatch text also carries a `reason:` line. Every
dispatch marked `CAP:none` below copies its reason into the dispatch as a separate `reason: …` line.

**Dispatch acceptance blocks while executing this plan:** use scoped checks such as
`check: run command="npx vitest run --maxWorkers=2 D:\git\omr-p13\test\unit\runner.test.ts"`, **never**
`check: testsPass`, until `1.15.0` is installed. The plugin loaded by the executing
session is the one this plan replaces, and a bare `testsPass` would run this repo's full suite per
delegation.

### 0.6 Parallelism and file safety

Maximise parallel work, but orchestrate it so **no file is ever written by two agents at once, and
no agent reads a file another agent is editing.**

1. **Ownership map.** §2 assigns every file a single owning phase per wave. A task may write only
   files in its phase's write-set. Files not listed are read-only for everyone.
2. **Isolation by worktree.** Each concurrently running phase works in its own git worktree on
   its own branch, created from the wave's integration branch. Phase ids are written without the
   dot (`1.3` → `p13`):
   `git -C D:\git\opencode-model-router worktree add -b vrb/p13 D:\git\omr-p13 vrb/wave-1`.
   An agent reads and writes only inside its own worktree. It never opens another phase's worktree.
   Reads of files owned by another in-flight phase come from the **wave base branch**, which no one
   edits while the wave runs.
3. **Serial integration.** Only the orchestrator merges phase branches into `vrb/wave-<n>`, one at a
   time, after that phase's QA is clean. It runs the full unit suite (capped, §0.6.7) after each merge. Conflicts are
   resolved by the orchestrator, never by two agents.
4. **Cross-phase dependencies.** A phase that needs another phase's output (types, APIs) starts only
   after that phase is merged into the wave branch. The dependency graph in §3 is authoritative;
   anything without an edge between them runs in parallel.
5. **Shared single-writer files.** `D:\git\opencode-model-router\CHANGELOG.md`,
   `D:\git\opencode-model-router\vitest.config.ts`,
   `D:\git\opencode-model-router\.github\workflows\test.yml` and
   `D:\git\opencode-model-router\package.json` each have exactly one owner in the whole plan (§2).
   Other phases record what they need in their QA report and the owner applies it.
6. **Main checkout.** `D:\git\opencode-model-router` (branch `master`) is the directory the live
   opencode sessions load the plugin from. Never edit, check out a branch, or run `npm ci` there
   during execution, except in Phase 0.P and the final sync in Phase 3.3.
7. **Do not recreate the problem this plan fixes.** Parallel agents share one machine:
   - **This repo's own test suite always runs capped:** `npx vitest run --maxWorkers=2 …`, never a
     bare `npm test` (this repo's `vitest.config.ts` sets no worker cap, so a bare run uses every core).
   - **Full-suite runs of this repo are serialized:** only the orchestrator runs them, and only one
     at a time across all worktrees (pre-flights and post-merge checks). Delegated agents run only
     the test files they touch.
   - **`npm ci` in new worktrees runs one at a time.**

### 0.7 Pre-flight before each phase, QA after each phase

- **Before** every phase: run the standard pre-flight (§0.9) plus the phase's specific
  items. A failed pre-flight item is fixed before the phase starts. If it cannot be fixed, §0.1 decides
  whether to stop.
- **After** every phase: a `[tier:heavy]` senior QA engineer performs an **adversarial review** of
  the phase diff. **Every finding is fixed**, whatever its severity. The fixes are then re-reviewed
  by heavy QA until the review reports zero open findings. The report is saved to
  `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-<id>.md` (inside the
  phase worktree, committed with the phase).
- After Wave 3: the same for the whole change set (global QA, §4.3).

### 0.8 Failure recovery

After **3 consecutive failed attempts on the same issue**: stop editing, revert to the last green
commit, write down what was tried and the exact failure, and re-dispatch the problem to `[tier:heavy]`
with that record. If heavy's approach also fails, this is a blocking problem under §0.1: ask the human.

### 0.9 Standard pre-flight checklist (applies to every phase)

`[tier:fast]` runs these and reports; the orchestrator reads the report before starting the phase.

- [ ] The worktree for the phase exists, is on the right branch, and `git status` is clean.
- [ ] The phase branch is based on the current tip of `vrb/wave-<n>` (after all merged dependencies).
- [ ] Every dependency phase listed in §3 is merged and its QA report shows zero open findings.
- [ ] `npm ci` completed in the worktree (serialized, §0.6.7). Then `npm run typecheck` and
      `npx vitest run --maxWorkers=2` pass there. This is this repo's own suite: the orchestrator runs
      it once per phase, one worktree at a time, **not** per delegation.
- [ ] The phase's write-set (§2) does not overlap any other in-flight phase's write-set.
- [ ] No orphaned `node`/`vitest` processes from earlier phases are running
      (Windows: `Get-CimInstance Win32_Process -Filter "Name='node.exe'"`, filtered to command lines
      that contain the worktree path; POSIX: `pgrep -af <worktree path>`).
- [ ] No stale `omr-ref-*` worktrees are left over (`git -C D:\git\opencode-model-router worktree list`).
- [ ] The phase-specific pre-flight items below pass (spikes included).


### 0.10 Execution conduct (binding for the executing orchestrator)

1. **Iterate continuously.** Go from phase to phase and wave to wave without pausing. Stop **only**
   for a blocking or critical problem as defined in §0.1. A QA finding, a red test, a failed spike
   with a documented alternative, or a merge conflict is work, not a stop.
2. **Take over when delegation itself is the blocker.** If the model-router repeatedly blocks
   progress, you take over **momentarily** and do the blocked reading or implementation yourself.
   Typical cases: a less capable subagent returning verbose, circular or off-target output; cap
   banners exhausting a delegate before it reaches the answer; the same dispatch failing twice with
   `NEED MORE:`/`ESCALATE:` loops. You are a top-tier model, extremely intelligent and capable.
   Record in the run log what you took over and why, then return to delegating for the next task.
   Taking over is a recovery tool, not the default.
3. **Pre-flight before every phase** (§0.9 + the phase items). **Fix everything it finds.** If a
   finding is explicitly scheduled for a later phase of this plan, do not fix it early: document it
   in the phase's QA report under "deferred by plan", with the phase that owns it.
4. **Heavy senior QA after every phase.** QA is always a `[tier:heavy]` task. Always apply this rule.
   Delegate to heavy QA an **adversarial** review of the work done, then fix **every** finding and
   re-review until clean (§0.7).
5. **Always delegate through the model-router, preferring atomic tasks.** One dispatch = one small,
   verifiable unit: a function, a test file, one doc section. Coding tasks go to `@medium`; a coding
   task that is genuinely complex (concurrency, cleanup safety, verdict algebra, command
   construction) may go to `@heavy`. Split heavy work: `@heavy` does the reasoning-dense lift (design
   or the hard code). Running tests, collecting results and applying mechanical fixes go to lighter
   delegations (`@fast` to run and report, `@medium` to fix).
6. **Test only what the change touches.** Never run the full suite unless it is actually needed:
   the per-phase §0.9 run, post-merge integration and the release. A task's verification runs the
   test files for the modules it changed (`npx vitest run <files>`, or `npx vitest related <src files> --run`).
   **Accelerate scoped runs:** they may use vitest's default parallelism or higher
   (`--maxWorkers=50%` or more, `--pool=threads` when the suite is compatible,
   `--no-isolate` for pure unit files), and independent scoped runs from different agents may run
   concurrently. The only runs that stay capped and serialized are **full-suite** runs of this repo
   (§0.6.7), because many of them at once saturate the machine this plan is meant to protect.
7. **Commit often** (§0.3): after every green subtask, and push immediately.
8. **Issue tracking.** This repo does not use Linear. At planning time, a search of the repo for
   Linear URLs or issue keys found none. GitHub PRs are the tracking record. If Linear references
   appear later, update the matching issue at each phase boundary.

---

## 1. Problem and design

### 1.1 Evidence

Two opencode sessions with many subagents drove a 16-core Windows machine to 80–100% CPU.
A process monitor traced the load to `cmd.exe /d /s /c "npm test"` → `vitest run` → 8–16
workers. The router's dispatch-time test baseline launched them **one second after each `task`
dispatch**, including read-only ones. `1.14.0` fixed three defects:

- tree kill on timeout and abort (`D:\git\opencode-model-router\src\verify\exec.ts`);
- no baseline for read-only dispatches;
- one capture per directory and command, per process.

**It still runs the full suite up to twice for every delegation whose DoD carries `testsPass`**:
a dispatch-time baseline, then the `testsPass` check after the producer returns. The injected
protocol tells orchestrators to prefer `testsPass` in acceptance blocks, so that means most
implementation delegations. The native `task` path also has no gate budget at all
(`accept(…)` is not wrapped in `withTimeout` there). The owner's constraints:

1. **The router must not run a test suite per delegation.**
2. **Verification must never slow implementation down.** The owner runs many sessions and many
   subagents in parallel on one machine and prefers speed to absolute safety. The fast tier is
   already a mid-tier model (Sonnet 5 class).
3. **No CPU is spent on verification nobody asked for.** Verification runs only when the
   orchestrator marks a delegation as fundamental or explicitly asks for a verdict. No background
   verification by default.
4. **The orchestrator decides the risk.** It sets, per dispatch, how long to wait for the reference
   and whether the verification is fundamental. The router supplies a deterministic risk signal
   and a way to get the verdict on demand. It never forces the wait.

### 1.2 Guardrail semantics to preserve

Whenever a verification **does** run (a `VERIFY:required` dispatch or a `router_verify` call,
S7), `testsPass` must still:

- **reject** a delegation that introduces a failing test (green → red, or a new failure next to
  old ones);
- **not blame** a producer for failures that already existed when it was dispatched;
- say **`unverifiable`** (accepted with a caveat, or rejected under `strictUnverifiable`), never a
  false pass, when it cannot tell those two apart.

A delegation that is **not** verified is never reported as verified. It carries an explicit
"unverified" disclaimer, its risk signal and the handle to verify it later.

### 1.3 The seven mechanisms (all implemented by this plan)

| # | Mechanism | Replaces |
|---|---|---|
| S1 | **Affected-test scoping.** `testsPass` runs only the tests related to the producer's changed files (`vitest related`, `jest --findRelatedTests`, pytest module mapping). The command is built by a runner adapter and spawned **without a shell**. | full-suite `npm test` |
| S2 | **Failure-only recheck at a dispatch reference.** At dispatch, only a git reference is captured (`git stash create` or HEAD, plus hashes of untracked files) — no tests. Only when scoped tests fail are **those failing test files** re-run in an ephemeral worktree at the reference, to separate pre-existing failures from introduced ones. | dispatch-time full-suite baseline |
| S3 | **Machine-wide verification slot.** A cross-process semaphore (lock files in the OS temp dir) allows at most `maxConcurrentVerifications` (default `max(1, floor(cores/8))`, as in §1.4; *amended during implementation*) verification commands at a time, across every opencode process on the machine. | per-process, per-cwd mutex only |
| S4 | **Per-run resource caps.** The adapter adds the runner's worker cap (`--maxWorkers=N`, default 2). Every verification command runs at below-normal OS priority. The gate budget's abort signal reaches the process tree. | uncapped workers at normal priority; gate timeout that abandons the command without killing it |
| S5 | **Batching.** Verification requests (from `VERIFY:required` gates, `router_verify` calls, or background runs if enabled) for the same runner root that arrive within `batchWindowMs` are merged into one scoped run over the union of changed files. Failures are attributed back per request. | one run per producer |
| S6 | **The full suite is CI's job.** The router never falls back to a full suite. When scoping is impossible (unknown runner, composite script, config-file change), the result is `unverifiable` with a caveat. A full suite runs only with explicit `testScope: "full"`. | silent full-suite fallback |
| S7 | **Verification on the orchestrator's terms.** Each dispatch carries `VERIFY:required` or `VERIFY:deferred` (the default) and optionally `VERIFY_WAIT:<n>s`. A **deferred** delegation returns immediately with an "unverified" disclaimer, a deterministic risk signal and a handle (`vrf_…`). **No verification process runs** unless the orchestrator calls the new `router_verify` tool with that handle, or `background: true` is configured. A **required** delegation is gated synchronously (S1–S6) and keeps the escalation ladder. The reference capture waits at most `VERIFY_WAIT` (default 5 s) before the producer starts, and never blocks beyond that. | unconditional synchronous gate on every `testsPass` DoD |

### 1.4 Configuration surface (`enforcement.verify`, all optional)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `testScope` | `"affected" \| "full"` | `"affected"` | S1/S6. `"full"` is the explicit opt-in to run the whole suite. It still gets S2–S5. |
| `maxWorkers` | integer ≥ 1 | `2` | S4. Worker cap the adapter passes to runners that support one. |
| `lowPriority` | boolean | `true` | S4. Run verification commands at below-normal priority. |
| `maxConcurrentVerifications` | integer ≥ 1 | `max(1, floor(os.availableParallelism() / 8))` | S3. Machine-wide verification slots (2 on a 16-core machine: at most 2 × `maxWorkers` = 4 cores for verification). |
| `defaultVerify` | `"deferred" \| "required"` | `"deferred"` | S7. Mode for dispatches that carry no `VERIFY:` directive. |
| `captureWaitMs` | integer ≥ 0 | `5000` | S7. Default for `VERIFY_WAIT`: the longest the dispatch waits for the reference capture before the producer starts. `0` = never wait. |
| `background` | boolean | `false` | S7. When `true`, deferred verifications also run in the background (slot, low priority) and failures reach the orchestrator as late notices. Off by default: no CPU for verdicts nobody asked for. |
| `pendingTtlMs` | integer ≥ 1 | `3600000` | S7. How long an unverified delegation stays verifiable through `router_verify` (its reference and change set are kept that long). |
| `slotWaitMs` | integer ≥ 0 | `60000` | S3. Maximum wait for a slot; on expiry the check is `unverifiable` ("verification slot busy"). |
| `batchWindowMs` | integer ≥ 0 | `2000` | S5. Coalescing window; `0` disables batching. |
| `failureRecheck` | boolean | `true` | S2. When `false`, no reference is captured and no recheck runs: a green scoped run still passes, and any scoped failure is `unverifiable` (it can neither be excused nor proven introduced). |
| `recheckTimeoutMs` | integer ≥ 1 | `60000` | S2. Budget for the reference re-run. |
| `testBaseline` | boolean | — | **Deprecated.** Accepted. `false` maps to `failureRecheck: false`. Logs a one-time deprecation warning through the plugin logger. |
| `baselineTimeoutMs` | integer ≥ 1 | `15000` (was `60000`) | Now bounds the whole git-only reference capture, which continues in the background after `VERIFY_WAIT` expires (§1.5-14). |
| `gateBudgetMs` | integer ≥ 1 | `90000` (unchanged) | The deadline for every synchronous verification: a `VERIFY:required` gate (now also in the native `task` path) and each `router_verify` call. Every S2–S5 step is bounded by it (§1.5-13). |

### 1.5 Decisions taken (the executor does not re-open these)

1. **No shell for generated commands.** Scoped commands are spawned as
   `process.execPath <runner JS entry> <args…>`, with the entry resolved from the runner package's
   `bin` in `node_modules`, or as native executables (`pytest`, `uv`) with an args array. Changed
   file paths are passed as argv, never interpolated into a shell string. User-supplied `check`
   commands keep today's allowlist + `FORBIDDEN_SHELL` validation and shell execution.
2. **Identities come from machine-readable reporters.** vitest `--reporter=json --outputFile`, jest
   `--json --outputFile`, pytest `--junitxml`, written to a temp file. Text parsing
   (`observeTests` in `D:\git\opencode-model-router\src\verify\baseline.ts`) remains only a fallback.
3. **pytest support is bounded.** The allowlist gains `pytest`, and `uv` only in the exact form
   `uv run pytest …` (`uv run <other>` stays forbidden). Affected set = changed test files plus
   `test_<stem>.py`/`<stem>_test.py` files for changed modules. A change to `conftest.py`,
   `pyproject.toml`, `pytest.ini`, `setup.cfg` or `tox.ini` makes scoping impossible → S6
   `unverifiable`.
   *Amended during implementation (phase-1.3.md, QA-1.3-4, -5, -8, -23; phase 3.1 E2E-1):* the
   trigger list also holds `.pytest.ini`, `pytest.toml`, `.pytest.toml`, a `-c`/`--config-file`
   value, the Python lock and dependency files (`uv.lock`, `poetry.lock`, `pdm.lock`,
   `Pipfile.lock`, `Pipfile`, `setup.py`, `requirements*.txt`, `requirements*.in`,
   `constraints*.txt`, and any `*.txt`/`*.in` below a directory named `requirements`). The affected
   set honours `python_files` and maps a changed module to every test that names its stem as a whole
   word, plus the name-matched tests; a module no test maps to is S6 `unmapped-module`.
4. **Package-script resolution.** `npm|pnpm|yarn|bun test` resolves `scripts.test` from the nearest
   `package.json`. A single `vitest …`/`jest …` invocation is rewritten into its scoped form. A
   leading `cross-env K=V …` prefix is supported: its assignments go into the spec's `env`. A
   composite script (`&&`, `;`, `|`, several commands, or any other wrapper) is S6 `unverifiable`.
5. **Deleted and renamed sources.** They cannot be passed to `related`. Tests are added by searching
   test files for the module's stem (`git grep -l -F <stem> -- <test globs>`). If none are found,
   the result for that file is S6 `unverifiable`.
6. **No changed files.** With change attribution available and an empty change set, `testsPass`
   passes with the note "no changed files, no affected tests". With attribution unavailable, it is
   `unverifiable`.
7. **Approximate references never excuse.** If an untracked file that existed at dispatch was
   modified or deleted by the time of the recheck, the reference cannot be rebuilt exactly. A
   reference-side failure then does not excuse anything → `unverifiable`.
8. **Collection/setup errors at the reference** (missing generated files, env) mean the reference is
   unusable → `unverifiable`, never "pre-existing".
9. **Release as `1.15.0` (minor).** Two behaviour changes: `testsPass` narrows from "suite is green"
   to "affected tests pass", and delegations are deferred (unverified) by default. Each has a
   one-key opt-out that restores the previous behaviour: `testScope: "full"` and
   `defaultVerify: "required"`, plus the deprecated keys still load. So nothing breaks without an
   opt-out, and the CHANGELOG states both changes prominently.
10. **Scope of `lintClean`.** When the resolved lint command is a plain `eslint` invocation, or a
    package script that is one, it is scoped to changed lintable files in the same adapter (same
    no-shell, cap and slot rules). Otherwise it is unchanged, but runs under S3/S4.
11. **Worker cap conflicts.** If the user's script already sets a worker cap, the spec uses
    `min(user value, maxWorkers)`, emitted exactly once. The router never raises a cap.
12. **Explicit `run` checks run as written.** A `check: run command="…"` is an explicit instruction,
    so it is not rewritten or scoped. It does run under the slot (S3), at low priority, and under the
    gate deadline (S4). The protocol text (Phase 2.3) steers orchestrators away from full-suite `run`
    checks. G1 is stated accordingly.
13. **One deadline per synchronous verification.** A `VERIFY:required` gate (in the `delegate` tool
    **and** the native `task` path) and each `router_verify` call get a deadline of `gateBudgetMs` and
    an `AbortController`. Every wait and command inside it (slot wait, scoped run, S2 recheck, batch
    wait) is bounded by `min(its own configured budget, time remaining until the deadline)`. The
    recheck is skipped (→ `unverifiable`, reason "gate budget exhausted before recheck") when less
    than 10 s remain. The native `task` path gains the same `withTimeout` + abort wrapping as the
    `delegate` path for required gates. Deferred delegations run no gate at all, so there is nothing
    to bound.
14. **The reference capture waits at most `VERIFY_WAIT`.** For every dispatch whose DoD carries
    `testsPass`, whatever its mode, the dispatch awaits `captureReference` for at most `VERIFY_WAIT`
    (default `captureWaitMs` = 5 s), then lets the producer start regardless. The capture keeps
    running (git only, ≤ `baselineTimeoutMs`). It stays valid only if no edit is observed in an
    overlapping directory before it resolves; otherwise it is discarded, and any later verdict says
    "no reference: pre-existing failures cannot be told apart". Capturing even for deferred
    delegations is deliberate: it is cheap (git only, no tests), and a later `router_verify` needs it.
15. **Dispatch directives.** Parsed from the dispatch text with the same rules as `CAP:`
    (`parseCapDirective` in `D:\git\opencode-model-router\src\router\sessions.ts`: first occurrence
    wins, and instructional examples injected by the router itself are ignored):
    - `VERIFY:required` / `VERIFY:deferred`: case-insensitive value, anything else is ignored with a
      log line; absent means `defaultVerify`.
    - `VERIFY_WAIT:<n>s` / `VERIFY_WAIT:<n>ms`: `0` allowed, capped at `baselineTimeoutMs`; absent
      means `captureWaitMs`.

    An explicit acceptance block with deterministic checks does **not** imply `required`: the
    orchestrator states the mode. The directives stay in the dispatch text, which is harmless to the
    subagent.

    *Amended during implementation (QA-G-4, owner decision):* the mode only governs a DoD that
    contains `testsPass` (§1.5-16). A DoD without `testsPass` (for example `buildPasses`, `lintClean`,
    `run` or `fileExists` only, or criteria only) keeps the synchronous gate of the pre-plan router
    in either mode, so for it an acceptance block does imply a synchronous gate and `VERIFY:deferred`
    has no effect. A DoD that contains `testsPass` defers as a whole (its build, lint, `run` and
    criteria checks too), also when the producer changed nothing (QA-G-1). The only exception is a
    `testsPass`-only DoD whose producer provably changed nothing. It takes the required gate, which
    passes it ("no changed files", §1.5-6) without spawning a process.
16. **Deferred result format.** A deferred delegation's result is returned unchanged, with a
    `[router]` footer appended:
    - "unverified";
    - the handle `vrf_<id>`;
    - the risk signal (§1.5-17);
    - the one-line instruction "call `router_verify` with this handle before building on this work
      if the risk matters".

    A deferred delegation is **never** labelled accepted or verified.
17. **Risk signal: deterministic, no process spawn.** It is computed only from data the router
    already holds (the changed-file set, git status of those files, the reference state and the
    producer tier). It never runs a test runner, a listing command or an LLM. Fields:
    - changed file count;
    - deleted and renamed count;
    - whether any test file was modified or deleted;
    - whether config, lock or CI files changed (`package.json`, lockfiles, `tsconfig*.json`,
      `vitest|jest.config.*`, `conftest.py`, `pyproject.toml`, `.github/**`);
    - whether the scoping would be impossible (S6 reason, decided statically by the runner adapter's
      planning, which spawns nothing);
    - whether a reference exists;
    - the producer tier.

    It is rolled into `low|medium|high` by a fixed, documented table. It is advice; nothing is
    blocked by it.
18. **`router_verify` tool.** A new plugin tool registered next to `delegate`.
    - **Input:** `handles: string[]`, or `"pending"` for every unverified delegation of the calling
      session.
    - **Behaviour:** it runs the S1–S6 pipeline (the same path as a required gate) for those delegations, batched (S5),
      under the slot (S3) and caps (S4), bounded by one `gateBudgetMs` deadline. It returns one
      verdict per handle with the same wording as a required gate, and marks those delegations
      verified.
    - **Tree drift:** the tree may have changed since the producer finished (other agents edited).
      The run always uses the current tree, and the verdict says so when the producer's files were
      modified afterwards ("tree drifted since delegation; verdict reflects current state").
    - **Rejections:** a rejected verdict includes the forcing note with the suggested next tier, but
      triggers **no** automatic retry. Escalation is the orchestrator's call.
19. **Background verification is opt-in (`background: true`).** When on, deferred delegations are
    queued for background verification (slot, low priority, batched, coalesced so that a newer
    request for the same files supersedes an older queued one). Introduced failures reach the
    orchestrator as a late notice through `experimental.chat.system.transform` on its next turn,
    deduplicated per handle and dropped when the session is gone. When off (the default), the queue
    does not exist and nothing is spawned.
20. **Pending list in the orchestrator prompt.** The system transform lists the calling session's
    still-unverified delegations: at most 5, newest first, handle + risk + short description. This
    is text only and costs no CPU, so the orchestrator can decide before its final answer. Entries
    leave the list once verified or when older than `pendingTtlMs`.

### 1.6 Target flow

```
dispatch (task / delegate)   directives: VERIFY:required|deferred (default deferred), VERIFY_WAIT:<n>s (default 5 s)
  └─ DoD has testsPass (and failureRecheck)? ──no──► nothing
        └─yes─► reference.capture(cwd)            git only; the dispatch awaits it ≤ VERIFY_WAIT, then the
                                                  producer starts anyway and the capture continues ≤ baselineTimeoutMs
producer returns
  ├─ VERIFY:deferred ─► return result NOW + footer [router] unverified · vrf_<id> · risk low|medium|high
  │                     register pending (TTL pendingTtlMs); spawn NOTHING
  │                     (background:true only → queue background verification → late notice on failure)
  │     later, only if the orchestrator decides:  router_verify(["vrf_<id>"] | "pending")
  │           └─ same synchronous pipeline as below (deadline = gateBudgetMs) → verdict, no auto-retry
  └─ VERIFY:required ─► gate.accept  (deadline = now + gateBudgetMs, AbortController; every step ≤ remaining)
        ─► testsPass
        ├─ adapter.resolve(command, changedFiles)  → scoped spec | unverifiable(S6)
        ├─ batch.submit(spec)                      window batchWindowMs (S5)
        │    └─ slot.acquire (S3) ─► runShellArgs(spec, lowPriority, maxWorkers, signal) (S4)
        ├─ green ─────────────────────────────────► pass
        └─ failures F ─► attribute to this request
              └─ reference.recheck(F) (S2, slot + caps, ≤ recheckTimeoutMs)
                    ├─ F ⊆ failing@ref (exact ref) ──► pass, note "no worse than before"
                    ├─ some f ∉ failing@ref ─────────► fail, name the introduced ones
                    └─ ref approximate/unusable ─────► unverifiable
```

---

## 2. File ownership map

Paths are relative to each phase's worktree, whose root mirrors `D:\git\opencode-model-router`.
The same file appears under exactly one phase per wave.

| File | Wave 1 owner | Wave 2 owner | Wave 3 owner |
|---|---|---|---|
| `D:\git\opencode-model-router\src\router\config.ts` | 1.1 | — | — |
| `D:\git\opencode-model-router\src\verify\exec.ts` | 1.2 | — | — |
| `D:\git\opencode-model-router\src\verify\types.ts` | 1.2 | 2.1 | — |
| `D:\git\opencode-model-router\src\verify\runner.ts` (new) | 1.3 | — | — |
| `D:\git\opencode-model-router\src\verify\deterministic.ts` | 1.3 (allowlist constants only) | 2.1 | — |
| `D:\git\opencode-model-router\src\verify\slot.ts` (new) | 1.4 | — | — |
| `D:\git\opencode-model-router\src\verify\reference.ts` (new) | 1.5 | — | — |
| `D:\git\opencode-model-router\src\verify\directives.ts` (new), `D:\git\opencode-model-router\src\verify\risk.ts` (new) | 1.6 | — | — |
| `D:\git\opencode-model-router\src\verify\pending.ts` (new) | — | 2.4 | — |
| `D:\git\opencode-model-router\src\router\protocol.ts` | — | 2.3 | — |
| `D:\git\opencode-model-router\src\verify\baseline.ts` | — | 2.1 | — |
| `D:\git\opencode-model-router\src\verify\dispatch.ts` | — | 2.1 | — |
| `D:\git\opencode-model-router\src\verify\wiring.ts` | — | 2.1, then 2.2, then 2.4 (sequential) | — |
| `D:\git\opencode-model-router\src\verify\batch.ts` (new) | — | 2.2 | — |
| `D:\git\opencode-model-router\src\index.ts` | — | 2.1 (required gate, deadline, reference GC), then 2.4 (directives, deferred path, `router_verify`, system transform), then 2.3 (acceptance-block guidance text) — sequential | — |
| `D:\git\opencode-model-router\docs\**`, `D:\git\opencode-model-router\README.md`, `D:\git\opencode-model-router\CHANGELOG.md` | — | 2.3 | 3.3 (CHANGELOG version header only) |
| `D:\git\opencode-model-router\test\unit\config-verify-budget.test.ts` (new) | 1.1 | 2.3 (docs-consistency case only) | — |
| `D:\git\opencode-model-router\test\unit\exec.test.ts` | 1.2 | — | — |
| `D:\git\opencode-model-router\test\unit\runner.test.ts` (new) + `D:\git\opencode-model-router\test\fixtures\runner\**` (new) | 1.3 | — | — |
| `D:\git\opencode-model-router\test\unit\slot.test.ts` (new) | 1.4 | — | — |
| `D:\git\opencode-model-router\test\unit\reference.test.ts` (new) | 1.5 | — | — |
| `D:\git\opencode-model-router\test\unit\directives.test.ts` (new), `D:\git\opencode-model-router\test\unit\risk.test.ts` (new) | 1.6 | — | — |
| `D:\git\opencode-model-router\test\unit\deferred-verification.test.ts` (new), `D:\git\opencode-model-router\test\unit\router-verify-tool.test.ts` (new) | — | 2.4 | — |
| `D:\git\opencode-model-router\test\unit\baseline.test.ts`, `D:\git\opencode-model-router\test\unit\baseline-wiring.test.ts`, `D:\git\opencode-model-router\test\unit\tests-pass-pipeline.test.ts` (new) | — | 2.1 | — |
| `D:\git\opencode-model-router\test\unit\batch.test.ts` (new), `D:\git\opencode-model-router\test\unit\batch-wiring.test.ts` (new) | — | 2.2 | — |
| `D:\git\opencode-model-router\test\golden\**` | — | 2.3 | — |
| `D:\git\opencode-model-router\test\integration\verify-resource-budget.test.ts` (new), `D:\git\opencode-model-router\test\fixtures\projects\**` (new), `D:\git\opencode-model-router\test\smoke\**` | — | — | 3.1 |
| `D:\git\opencode-model-router\vitest.config.ts`, `D:\git\opencode-model-router\.github\workflows\test.yml` | — | — | 3.1 |
| `D:\git\opencode-model-router\package.json`, `D:\git\opencode-model-router\package-lock.json` | — | — | 3.3 |
| `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-<id>.md` | each phase writes only its own file | same | same |

---

## 3. Waves, phases, tasks

### Dependency graph

```
Phase 0.P ─► Wave 1: 1.1 ║ 1.2 ║ 1.3 ║ 1.4 ║ 1.5 ║ 1.6   (all parallel; 1.3 and 1.5 code against
                                                            the ExecSeam/ArgvSeam contract of task 1.2.2
                                                            and are merged after 1.2; 1.4 and 1.6 need
                                                            no seam; 1.6's static-scoping flag uses the
                                                            1.3 planning API, merged after 1.3)
         ─► Wave 2: 2.1.1 (design) ─► 2.1.2–2.1.6 ─► 2.2.3 (wiring) ─► 2.4.2–2.4.6 ─► 2.3
                    2.1.1 (design) ─► 2.2.1–2.2.2 (batch.ts core, parallel with 2.1.2–2.1.6)
                    2.1.1 (design) ─► 2.4.1 (pending.ts core, parallel with 2.1.2–2.1.6 and 2.2)
         ─► Wave 3: 3.1 ─► 3.2 (global QA) ─► 3.3 (release)
```

Merge order into `vrb/wave-1`: 1.1, 1.2, then 1.4, 1.3, 1.5, 1.6. Parallel **work** is not affected:
task 1.2.2 commits the seam types first, and the orchestrator pastes them verbatim into the 1.3 and
1.5 dispatches, so those phases need not wait for 1.2's merge. Only their merge waits.

---

### Phase 0.P — Execution pre-flight (once) `[tier:fast]`

Not a delivery phase. It prepares a safe workspace.

- [ ] **0.P.1** Sync the main checkout so the executing sessions run `1.14.0` (tree kill,
      no read-only baseline). `D:\git\opencode-model-router` has a local edit to `tiers.json` that
      is already upstream in `1.14.0`. Verify that with
      `git -C D:\git\opencode-model-router diff origin/master -- tiers.json`: it must differ **only**
      in the medium `description` line. Then run `git -C D:\git\opencode-model-router checkout -- tiers.json`
      and `git -C D:\git\opencode-model-router pull --ff-only`. If the diff shows anything else, this
      is a §0.1 critical item (user data): stop and ask.
- [ ] **0.P.2** Record in the run log that the opencode sessions must be restarted to load `1.14.0`,
      and tell the human once in the progress update. This is not a blocker and needs no answer.
- [ ] **0.P.3** Create the integration branch from the branch that carries this plan, so every wave
      branch contains it: `git -C D:\git\opencode-model-router fetch origin` then
      `git -C D:\git\opencode-model-router branch vrb/wave-1 origin/docs/verification-budget-plan`.
      Confirm that `origin/docs/verification-budget-plan` is `origin/master` plus plan commits only
      (`git log origin/master..origin/docs/verification-budget-plan --stat` touches only
      `D:\git\opencode-model-router\docs\plans\verification-resource-budget-plan.md` and
      `D:\git\opencode-model-router\docs\plans\verification-resource-budget-handover.md`). Push it.
- [ ] **0.P.4** Record machine facts in the run log: OS, core count, Node version, and whether
      `uv`/`pytest` are on PATH (for the pytest spikes).

---

### Wave 1 — Final components (parallel)

Each phase ships a finished, fully tested module. Wave 2 wires them in without changing their
contracts, except for defects that QA finds.

#### Phase 1.1 — Configuration surface `[tier:medium]`

**Goal:** every key in §1.4 is typed, validated, defaulted and documented in code, and the
deprecated keys map correctly.

**Pre-flight (in addition to §0.9)**
- [ ] Read `D:\git\opencode-model-router\src\router\config.ts` `EnforcementConfig.verify` and the
      `validateConfig` verify block (currently around the `testBaseline` checks) and the override
      deep-merge (`deepMerge`). Confirm that deep-merge keeps sibling keys (a user override that sets
      only `maxWorkers` must keep the defaults for the other keys).

**Tasks**
- **1.1.1** `[tier:medium]` Extend `EnforcementConfig.verify` in
  `D:\git\opencode-model-router\src\router\config.ts` with the §1.4 keys, each with a JSDoc line
  giving its default.
  - 1.1.1.a Add validation in `validateConfig` with error messages in the existing
    `tiers.json: enforcement.verify.<key> must be …` form. Integers are checked with
    `Number.isInteger`; `testScope` against the literal union.
  - 1.1.1.b Export a pure `resolveVerifyBudget(cfg): VerifyBudget` returning fully defaulted values,
    including `baselineTimeoutMs` (new default `15000`) and `gateBudgetMs`. It applies the deprecation
    mapping (`testBaseline: false` → `failureRecheck: false`). An explicit `failureRecheck` wins over
    the deprecated key. Any existing reads of `baselineTimeoutMs`/`gateBudgetMs` defaults elsewhere
    (`D:\git\opencode-model-router\src\verify\wiring.ts`, `D:\git\opencode-model-router\src\index.ts`)
    are listed in the QA report for Phase 2.1 to switch over; 1.1 does not edit those files (§2).
  - 1.1.1.c Emit the deprecation warning once per process through the plugin logger seam that
    config already uses. Do not use `console`.
  - *Amended during implementation (phase-1.1.md, QA-1.1-1, QA-1.1-7):* the warning lives in
    `warnDeprecatedVerifyKeys(cfg, logger)` (required logger, once-per-process flag reset by
    `resetVerifyBudgetWarnings()`), so `resolveVerifyBudget(cfg, { cores? })` stays pure. A non-object
    `enforcement.verify` (`null`, a string, a number, an array, or a `verify: null` override) now
    throws `tiers.json: enforcement.verify must be an object`. This is an approved deviation from the
    acceptance line "existing config tests pass unchanged": the permissive-skip test in
    `config.validate.test.ts` was split so `verify` throws while `escalate`/`perTier` are unchanged.
- **1.1.2** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\config-verify-budget.test.ts`.

**New tests (coverage ≥ 90% lines and branches for the new code; edge cases required)**
- Defaults when `verify` is absent, empty, or partially set; deep-merged overrides keep sibling defaults.
- Every key rejects wrong types: `0` for the ≥1 keys, negative numbers, `NaN`, `Infinity`, `1.5`,
  strings, `null` where not allowed.
- `testScope` rejects `"all"` and `"Affected"` (case-sensitive).
- `slotWaitMs: 0` and `batchWindowMs: 0` are valid and mean "no wait" and "no batching";
  `captureWaitMs: 0` is valid and means "never wait for the reference".
- `defaultVerify` accepts only `"deferred"`/`"required"` and defaults to `"deferred"`; `background`
  defaults to `false`.
- The `maxConcurrentVerifications` default is computed from an **injected** core count
  (`resolveVerifyBudget(cfg, { cores })`): 1 core → 1, 8 → 1, 16 → 2, 64 → 8. An explicit value
  always wins.
- Deprecation: `testBaseline: false` → `failureRecheck: false`; `testBaseline: true` → no change;
  explicit `failureRecheck: true` + `testBaseline: false` → `true`; the warning fires once across
  repeated resolves.

**Acceptance criteria**
- `resolveVerifyBudget` is the **only** place defaults are applied, and it is pure and synchronous.
- Existing config tests pass unchanged.

**Definition of Done**
- §0.9 items hold on the phase branch; tests above pass; `npm run typecheck` is clean; the heavy QA
  report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.1.md` has zero open findings; commits are pushed.

**QA review** `[tier:heavy]` CAP:none — reason: adversarial review must read the full config diff and all callers of `validateConfig`.
Adversarial focus: the deep-merge interaction (can an override delete a default?), validation
bypass through `null`/prototype keys (`__proto__`), deprecation precedence, and warning spam.

---

#### Phase 1.2 — Process controls (S4 priority, abort, argv spawn) `[tier:medium]`

**Goal:** a single process layer that every verification command goes through. It kills the whole
tree, runs at low priority, honours an abort signal, and can spawn argv (no shell) as well as a shell
string.

**Pre-flight (in addition to §0.9)**
- [ ] **Spike A (Windows priority)** `[tier:fast]`: in a scratch dir under `%TEMP%`, verify
      empirically which mechanism makes **grandchildren** of a spawned process run below normal:
      (a) `os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)` right after
      `spawn`; (b) the `cmd /c start "" /B /WAIT /BELOWNORMAL …` wrapper (check that the exit code
      propagates for `.cmd` targets like `npm.cmd`). Record the priority class of grandchildren
      (`Get-CimInstance Win32_Process | select ProcessId,Priority`) and whether exit codes survive.
      Pick the mechanism that is deterministic for grandchildren **and** keeps exit codes. If neither
      does both, use (a) and document the startup race in the code comment.
- [ ] **Spike B (POSIX)**: confirm `nice -n 10` (prepended to the argv) is inherited by
      grandchildren and preserves the exit code. Use CI's ubuntu runner through a throwaway workflow
      on the phase branch if no POSIX host is available; delete the workflow afterwards.

**Tasks**
- **1.2.1** `[tier:medium]` Extend `D:\git\opencode-model-router\src\verify\exec.ts`:
  - 1.2.1.a `runShell(command, opts)` gains `lowPriority?: boolean` and `env?: Record<string,string>`.
    Priority uses the mechanism chosen in the spikes.
  - 1.2.1.b New `runArgv(file, args, opts)`: same options, same result shape and tree-kill
    semantics, `shell: false`, arguments passed as an array. The two share one internal
    implementation (no duplicated kill or timeout logic).
  - 1.2.1.c An abort signal that is already aborted never spawns (keep the current behaviour); a
    signal that aborts mid-run kills the tree.
- **1.2.2** `[tier:medium]` In `D:\git\opencode-model-router\src\verify\types.ts`, widen `ExecSeam`
  opts to `{ cwd?, timeoutMs?, signal?, lowPriority?, env? }` and add
  `ArgvSeam = (file, args, opts) => Promise<ExecResult>`. **This is the contract 1.3 and 1.5 code
  against (§3 graph).** Write it first and commit it as the phase's first commit, so it can be
  quoted verbatim into 1.3/1.5 dispatches.
- **1.2.3** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\exec.test.ts`, using
  real processes (no mocks), extending the four existing cases.

**New tests (edge cases required)**
- Tree kill for `runArgv` on timeout and on abort (grandchild verified dead), on both platforms.
- The low-priority grandchild is observed at below-normal priority (Windows: `Priority` ≤ 6; POSIX:
  `ps -o ni` ≥ 10). Skip only with an explicit platform guard that has a reason string.
- The exit code survives the priority wrapper, for success, failure (3) and a `.cmd` target on Windows.
- `env` is merged over `process.env`, not replacing it (`PATH` is still present).
- Paths with spaces, quotes, `&`, `$()`, `%VAR%` and unicode in **argv** reach the child byte-for-byte
  (the child echoes `process.argv` as JSON), which proves no shell interpretation.
- Output over `maxBuffer` is truncated without hanging.
- A spawn error (non-existent executable) resolves `{code:1, timedOut:false}` with the error in
  `stderr`, and never rejects.
- Abort after natural exit is a no-op (no `taskkill` of a recycled PID: a `settled` guard).

**Acceptance criteria**
- No verification code path spawns a process except through `runShell`/`runArgv`.
  `rg "child_process" D:\git\omr-p12\src` lists only `exec.ts` and the pre-existing `tree.ts`
  (which only runs git with a timeout and is out of scope). New modules (`reference.ts`,
  `runner.ts`, `batch.ts`, `slot.ts`) must receive `ArgvSeam` by injection and never import
  `child_process`. Phase 3.2 re-checks this across the final tree.
  *Amended during implementation (QA-1.2-12, phase 3.2):* the unused `exec as nodeExec` import in
  `src/index.ts` predated this plan and is deleted. `rg "import .*child_process" src` now lists only
  `exec.ts` and `tree.ts`; the other `child_process` hits (`reference.ts`, `runner.ts`, `wiring.ts`)
  are comments stating the module does not import it.
- A killed run reports `timedOut: true` and a non-zero code on both platforms.

**Definition of Done** — as in 1.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.2.md`.

**QA review** `[tier:heavy]` CAP:none — reason: process-lifecycle review must read exec.ts, its tests and the spike logs together.
Adversarial focus: PID reuse after exit, the priority race, zombie handles, Windows `.cmd` quoting,
`detached` side effects on POSIX (a detached child that survives opencode exit), and a signal
listener leak across many runs.

---

#### Phase 1.3 — Runner adapter (S1 scoping, S4 worker caps, identities) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** a pure-planning plus I/O-seamed module that turns `(checkCommand, cwd, changedFiles,
budget)` into either an executable **scoped run spec** or an `unverifiable` reason. It also parses
results into failing identities and can build a "re-run exactly these test files" spec for S2.

**Pre-flight (in addition to §0.9)**
- [ ] **Spike C (runner CLIs)** `[tier:fast]`: in throwaway fixture projects under `%TEMP%`, pin the
      exact behaviour of the versions in use (vitest 4.x, jest 29/30, pytest 8/9):
      `vitest related <files> --run --passWithNoTests --maxWorkers=N --reporter=json --outputFile=<f>`;
      `vitest list` (can it list the tests related to given files **without running them**? This
      decides the S5 attribution path);
      `jest --findRelatedTests <files> --listTests` and
      `jest --findRelatedTests <files> --passWithNoTests --maxWorkers=N --json --outputFile=<f>`;
      `pytest <files> -q -p no:cacheprovider --junitxml=<f>`, with and without `-n auto` in
      `addopts` (what does `PYTEST_XDIST_AUTO_NUM_WORKERS` do?).
      Record the exit codes for: all passed, some failed, none found, collection error, and the JSON/XML shapes.
- [ ] Gather `[tier:fast]`: `isCommandAllowed`, `FORBIDDEN_SHELL`, `INTERPRETERS` and
      `resolveRepoCommand` from `D:\git\opencode-model-router\src\verify\deterministic.ts`, and
      `observeTests` from `D:\git\opencode-model-router\src\verify\baseline.ts`, to paste into the
      heavy design dispatch.

**Tasks**
- **1.3.1** `[tier:heavy]` Design note (committed as the header comment of
  `D:\git\opencode-model-router\src\verify\runner.ts`): the spec type, the runner-detection decision
  table, argument construction per runner, identity-extraction formats, and the S6 reasons. It
  implements §1.5 decisions 1–6, 10 and 11 exactly, and chooses the S5 attribution path from Spike C.
  For JS runners the spec is always `{ file: process.execPath, args: [<resolved bin entry>, …] }`, so
  no `.cmd` shim and no shell are ever involved on Windows.
- **1.3.2** `[tier:medium]` Implement `D:\git\opencode-model-router\src\verify\runner.ts`:
  - 1.3.2.a `detectRunner(command, cwd, fs)`: direct invocations (`vitest`, `npx vitest`,
    `pnpm exec vitest`, `jest`, `pytest`, `uv run pytest`) and package scripts (§1.5-4). The nearest
    `package.json` is found by walking up from `cwd` to the git root.
  - 1.3.2.b `resolveEntry(runner, cwd, fs)`: the runner's JS entry from
    `node_modules/<pkg>/package.json` `bin` (walk up for hoisted and pnpm layouts), or the native
    executable for pytest/uv. When it is missing → `unverifiable("runner not installed")`.
  - 1.3.2.c `planScopedRun({command, cwd, changedFiles, budget})` → `ScopedSpec | Unverifiable`:
    normalizes paths, drops files outside the git root, and handles deletions and renames (§1.5-5),
    config-file triggers (§1.5-3) and the empty set (§1.5-6). It adds the `maxWorkers` flag and the
    reporter output file under `os.tmpdir()`, and returns `{file, args, cwd, env, reportPath, runner}`.
  - 1.3.2.d `planListRelated(...)`: only if Spike C proved a non-executing listing exists; otherwise
    the function does not exist and 2.2 uses the per-request re-run fallback (§3 Phase 2.2).
  - 1.3.2.e `planRerun(runner, testFiles, cwd, budget)` → spec that runs exactly those test files
    (used by S2 and S5).
  - 1.3.2.f `readResult(spec, execResult, fs)` → `{ failingIds: string[], failingFiles: string[],
    collectionError: boolean, total: number }`. It reads the report file, falls back to
    `observeTests`, and always deletes the report file.
  - 1.3.2.g Lint scoping (§1.5-10): `planScopedLint(...)` for plain `eslint`.
- **1.3.3** `[tier:medium]` In `D:\git\opencode-model-router\src\verify\deterministic.ts`, add
  `pytest` to `DEFAULT_ALLOWLIST`, and the `uv` special case in `isCommandAllowed` (only
  `uv run pytest …`). Keep all existing allowlist tests green.
- **1.3.4** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\runner.test.ts`, with
  static fixtures under `D:\git\opencode-model-router\test\fixtures\runner\` (package.json variants,
  fake `node_modules` layouts, captured reporter outputs from Spike C). No real test runs in unit
  tests: those happen in 3.1.

**New tests (edge cases required)**
- Detection for each direct form, and `npm test`/`pnpm test`/`yarn test`/`bun test` → the script,
  for vitest and jest scripts with extra flags (`vitest run --coverage` → coverage flag dropped for
  scoped runs).
- Composite scripts (`vitest run && eslint .`, `npm run a; npm run b`, `dotenv -- vitest run`) →
  `unverifiable`, with the reason naming the construct. `cross-env X=1 Y="a b" vitest run` →
  supported, `env` = `{X:"1", Y:"a b"}` (§1.5-4). `cross-env` followed by a composite → `unverifiable`.
- Monorepo: `cwd` in a package, runner hoisted to the root; pnpm `.pnpm` store layout; runner missing → `unverifiable`.
- Changed files: outside the git root (dropped); `..` traversal (dropped); absolute Windows paths with
  a different drive letter case; paths with spaces and unicode; a deleted source that has
  stem-matching tests; a deleted source with none (`unverifiable`); a rename; only non-code files
  (docs) → affected set empty → pass note.
- pytest: `conftest.py` changed → `unverifiable`; `src/pkg/mod.py` → `tests/test_mod.py` and `tests/pkg/mod_test.py`; `uv run pytest` allowed, `uv run python -c` refused.
- `readResult`: JSON with failures, zero tests, a collection error, a truncated or missing report
  file (falls back to text), a report file already deleted.
- Worker cap (§1.5-11): no user flag → `--maxWorkers=<budget>`; user `--maxWorkers=1` with
  budget 2 → `1`; user `--maxWorkers=8` → `2`; user `--maxWorkers=50%` (percent form) →
  `min(ceil(0.5 × os.availableParallelism()), 2)`, tested with an injected core count of 1 and 16; the
  flag appears exactly once; the `--maxWorkers 4` two-token form is recognised too.

**Acceptance criteria**
- `runner.ts` performs **no** process spawning: it returns specs and uses `fs` only through the seam.
- Every S6 path returns a reason string that names what made scoping impossible.

**Definition of Done** — as in 1.1; branch coverage of `runner.ts` ≥ 90%; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.3.md`.

**QA review** `[tier:heavy]` CAP:none — reason: security-sensitive command construction; the reviewer must read runner.ts, the allowlist change and every fixture.
Adversarial focus: **command injection** through file names, script contents and package.json
`bin` paths; allowlist bypass through `uv`; paths that escape the repo; wrong detection that silently
runs a full suite; the reporter file being written inside the repo (it must be in the temp dir).

---

#### Phase 1.4 — Machine-wide verification slot (S3) `[tier:medium]`

**Goal:** a cross-process counting semaphore that works across separate opencode processes on the
same machine, recovers from crashes and never deadlocks.

**Pre-flight (in addition to §0.9)**
- [ ] Confirm that `fs.open(path, "wx")` is atomic on NTFS and ext4 for this use: two processes racing
      100 times, exactly one wins per slot (spike script `[tier:fast]`).
- [ ] Confirm that `process.kill(pid, 0)` distinguishes dead from alive and from EPERM on both platforms.

**Tasks**
- **1.4.1** `[tier:medium]` `D:\git\opencode-model-router\src\verify\slot.ts`:
  `acquireSlot({ max, waitMs, signal, meta })` → `{ release(): Promise<void> } | { busy: true }`.
  - 1.4.1.a Lock files live at `path.join(os.tmpdir(), "opencode-model-router", "verify-slots", "slot-<i>.lock")`
    and contain JSON `{pid, hostname, token, startedAt, cwd, command}`. `token` is a random UUID per
    acquisition, used for ownership checks.
  - 1.4.1.b **Heartbeat.** While a slot is held, the holder refreshes the file's mtime every 5 s
    (`fs.utimes`, with an unref'd timer). The hold can span a whole batch plus recheck, so it cannot
    be bounded by any single command budget.
  - 1.4.1.c **Stale detection.** A lock is stale if (a) its `hostname` equals this host **and** its
    PID is dead, or (b) its heartbeat (mtime) is older than 30 s, whatever the host. A lock from
    another host is **never** judged by PID (the PID space is not ours), only by heartbeat. Stale
    files are removed with a compare-before-delete: re-read the content, delete only if the `token`
    is unchanged. This avoids deleting a freshly re-acquired slot.
  - 1.4.1.d Waiting uses exponential backoff with jitter (250 ms → 2 s), honours `signal`, and stops at `waitMs`.
  - 1.4.1.e `release()` is idempotent and stops the heartbeat. It deletes only its own file (token
    check). Slots are also released on `process.on("exit")`, synchronously, as best effort.
  - 1.4.1.f If the temp dir is unwritable, degrade to an in-process semaphore with the same API,
    and log the degradation once through the logger seam.
- **1.4.2** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\slot.test.ts`. They
  include **real multi-process** cases that spawn child Node processes which acquire slots.

**New tests (edge cases required)**
- N processes × `max=1`: never two holders at once (each holder records its enter/exit timestamps
  in a shared file; assert no overlap). With `max=2`, at most two.
- A crashed holder (child killed with SIGKILL/`taskkill /F`) → its slot is reclaimed by the next
  waiter within the backoff window.
- A recycled PID (the file names a live but unrelated PID) whose heartbeat stopped is reclaimed
  after 30 s. A live holder whose hold lasts 3× the longest command budget keeps its slot, because
  its heartbeat is fresh.
- A lock written with a foreign `hostname` and a dead-looking PID but a fresh heartbeat is **not**
  reclaimed. The same lock with a heartbeat older than 30 s is reclaimed.
- A heartbeat timer does not keep the process alive (unref), and stops on release.
- `waitMs=0` → an immediate `busy`. An abort while waiting → resolves `busy` promptly and leaks no timers.
- Release twice; release after the file was already reclaimed as stale (it must not delete the new
  owner's file).
- An unwritable temp dir (point `TMPDIR`/`TEMP` at a read-only dir) → in-process fallback and one
  log line.
- A corrupt or empty lock file is treated as stale.

**Acceptance criteria**
- No busy-wait: CPU during a 10 s wait is negligible (assert fewer than N wake-ups).
- Every exit path releases the slot (success, throw, abort).

**Definition of Done** — as in 1.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.4.md`.

**QA review** `[tier:heavy]` CAP:none — reason: concurrency review must read slot.ts and every multi-process test.
Adversarial focus: TOCTOU between the stale check and delete, a two-winner race, starvation,
a deadlock when one process holds a slot and waits on another, clock changes, and antivirus file
locks on Windows (EBUSY/EPERM on unlink must be retried, not treated as success).

---

#### Phase 1.5 — Dispatch reference and ephemeral worktree (S2 infrastructure) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** capture a cheap git reference of the tree as it was when a producer was dispatched, and
later materialize an **exact** or explicitly **approximate** copy of it in which failing tests can
be re-run safely. Cleanup must never touch real data.

**Pre-flight (in addition to §0.9)**
- [ ] **Spike D (junction safety)** `[tier:fast]`, critical: on Windows, create a junction
      `worktree\node_modules` → `repo\node_modules`. Then verify that each removal method leaves the
      **target** intact: `fs.rm(junction, {recursive:true, force:true})`, `fs.unlink`, `fs.rmdir`, and
      `git worktree remove --force` with the junction still inside. Record which methods are safe.
      Same check on POSIX for directory symlinks. **Any method that deletes target contents is
      banned in code.** If `git worktree remove --force` follows junctions, links must be removed
      before it runs.
- [ ] **Spike E**: confirm that `git stash create` produces a commit with staged and unstaged tracked
      changes, excludes untracked files, returns an empty string on a clean tree, and does not change
      the working tree, index or stash list.
- [ ] Gather `[tier:fast]`: `snapshotTree` from `D:\git\opencode-model-router\src\verify\tree.ts`
      (how it hashes untracked files) and the `TreeSnapshot` type from
      `D:\git\opencode-model-router\src\verify\dispatch.ts`.

**Tasks**
- **1.5.1** `[tier:heavy]` Design note (the header comment of
  `D:\git\opencode-model-router\src\verify\reference.ts`): what the reference contains, what exact
  vs approximate means (§1.5-7), the materialization steps, the link strategy for every ignored
  `node_modules` directory in the repo (root and workspace packages), the cleanup order proven safe
  by Spike D, and crash GC.
- **1.5.2** `[tier:medium]` Implement `D:\git\opencode-model-router\src\verify\reference.ts`:
  - 1.5.2.a `captureReference(cwd, signal, deps: { argv: ArgvSeam, fs })` →
    `{ root, commit, untracked: Map<relPath, sha256> } | undefined`, using `git stash create` or `HEAD`.
    Every git call goes through the injected `ArgvSeam` (the contract in task 1.2.2), so it gets tree
    kill, abort and a timeout; `reference.ts` never imports `child_process`. Unit tests inject a
    thin real implementation (`runArgv` from 1.2, available once 1.2 is merged; until then a local
    test helper with the same signature built on `node:child_process.execFile` **inside the test
    file only**).
  - 1.5.2.b `materialize(ref, currentTree, signal)` → `{ dir, exact: boolean, dispose() }`:
    `git worktree add --detach <os.tmpdir()>/omr-ref-<pid>-<rand> <commit>`. It copies the untracked
    files whose current hash matches the reference hash (`exact=false` if any file is missing or
    changed), then links `node_modules` directories.
  - 1.5.2.c `dispose()`: unlink the links first (only with the methods Spike D proved safe), then
    `git worktree remove --force`, then remove the directory if it is still there. Idempotent.
    Must never throw into the caller: failures are logged.
  - 1.5.2.d `gcStaleReferences(root)`: remove `omr-ref-*` worktrees whose owner PID is dead or which
    are older than 1 h; `git worktree prune`. Called at plugin start (wired in 2.1).
- **1.5.3** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\reference.test.ts`, using
  **real temporary git repositories** created in `os.tmpdir()` (no git mocks).

**New tests (edge cases required)**
- Clean tree → the reference is HEAD; dirty tracked → the stash commit contains the dirty content;
  staged + unstaged mixed; the stash list is unchanged after capture.
- Untracked files: unchanged → copied (exact); modified after dispatch → `exact=false`; deleted →
  `exact=false`; a new untracked file after dispatch → not copied, and exact is unaffected.
- `node_modules` at the root and in `packages/a/node_modules` are linked; after `dispose()`, **the
  real `node_modules` directories and a sentinel file inside them still exist** (the key safety test,
  on Windows with junctions and on POSIX with symlinks).
- `dispose()` twice; `dispose()` after the directory was deleted externally; `dispose()` while a
  process still holds a file open in the worktree (Windows EBUSY → retried, then logged).
- GC: a stale worktree left by a killed PID is removed; a live owner's worktree is kept.
- Capture on a repo with submodules → `undefined` (the same refusal as `snapshotTree`); outside a
  git repo → `undefined`; an abort mid-capture leaves no partial state.
- Paths with spaces and unicode in the repo path and the temp path.

**Acceptance criteria**
- The capture runs only git, finishes under `baselineTimeoutMs`, and does not modify the repo
  (working tree, index, stash, refs), which the tests assert by `git status`/`git stash list`/`git for-each-ref` before and after.
- Every cleanup method in the code is on Spike D's safe list.

**Definition of Done** — as in 1.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.5.md`.

**QA review** `[tier:heavy]` CAP:none — reason: data-safety review must read reference.ts, the spike D log and every cleanup test.
Adversarial focus: **any path that could delete real data** (junction following, a wrong directory
passed to `rm`, GC removing a non-`omr-ref` worktree), a reference that claims `exact` when it is
not, secrets copied into the temp dir (untracked `.env` files: copy only what already existed and
is needed, and document it), and temp-dir exhaustion.

---

#### Phase 1.6 — Dispatch directives and risk signal (S7 core) `[tier:medium]`

**Goal:** two pure modules. One parses the orchestrator's per-dispatch verification choices. The
other computes the deterministic risk signal that goes with every deferred delegation. Neither
spawns a process.

**Pre-flight (in addition to §0.9)**
- [ ] Gather `[tier:fast]`: `parseCapDirective` and its tests
      (`D:\git\opencode-model-router\src\router\sessions.ts`, plus the test files that
      `rg -l parseCapDirective D:\git\omr-p16\test` lists), and the dispatch-header text in
      `D:\git\opencode-model-router\src\router\dispatch-header.ts` that injects instructional `CAP:`
      examples the parser must ignore.
- [ ] The static-scoping flag needs `planScopedRun` from 1.3. Code against the 1.3 function
      signature (pasted from the 1.3.1 design note), and merge after 1.3.

**Tasks**
- **1.6.1** `[tier:medium]` `D:\git\opencode-model-router\src\verify\directives.ts`:
  `parseVerifyDirectives(text, defaults)` → `{ mode: "required" | "deferred", waitMs: number,
  source: "directive" | "default" }`. It follows §1.5-15 exactly and reuses the same
  "ignore router-injected examples" rule as `parseCapDirective`: import the shared helper if one
  exists; otherwise add the rule here and **do not** edit `sessions.ts`.
  *Amended during implementation (phase-1.6.md, QA-1.6-18, QA-1.6-33):* `source` is split into
  `modeSource` and `waitSource` (each `"directive" | "default"`). Unlike `CAP:`, a non-upper-case
  `VERIFY`/`VERIFY_WAIT` key counts only when its value ends the line (or is followed by another
  directive key or a table pipe, QA-1.6-27), so prose such as "please verify: required that …" is
  not a directive.
- **1.6.2** `[tier:medium]` `D:\git\opencode-model-router\src\verify\risk.ts`:
  `assessRisk({ changedFiles, reference, producerTier, scopingPlan })` →
  `{ level: "low" | "medium" | "high", reasons: string[] }`. It uses the fixed table from §1.5-17,
  written as a table in the file header, and is pure and synchronous.
- **1.6.3** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\directives.test.ts`
  and `D:\git\opencode-model-router\test\unit\risk.test.ts`.

**New tests (edge cases required)**
- Directives:
  - case variants (`verify:Required`);
  - first occurrence wins; unknown value → default + log;
  - `VERIFY_WAIT:0s`, `VERIFY_WAIT:750ms`, and `VERIFY_WAIT:99999s` → capped at `baselineTimeoutMs`;
  - malformed values (`VERIFY_WAIT:-1s`, `VERIFY_WAIT:abc`, `VERIFY_WAIT:5`) → default;
  - directives inside a router-injected instructional example → ignored;
  - a directive inside a fenced code block of the prompt → still parsed, the same behaviour as `CAP:`
    (assert parity with `parseCapDirective` on the same inputs);
  - `CAP:` and `VERIFY:` together, in either order.
- Risk:
  - every row of the table has a test;
  - boundaries (the exact file-count thresholds);
  - a test file deleted → `high`;
  - only docs changed → `low`;
  - a lockfile or `.github/**` changed → at least `medium`;
  - no reference → the level rises one step, with a reason;
  - scoping impossible → a reason is present;
  - an empty change set → `low`, with the reason "no changes attributed";
  - the reasons are stable strings (they are shown to the orchestrator).

**Acceptance criteria**
- Neither module imports `child_process`, `fs` or the network; `risk.ts` takes the scoping plan as
  input (the caller runs the static planner).

**Definition of Done** — as in 1.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-1.6.md`.

**QA review** `[tier:heavy]` — adversarial focus: directive injection by the **subagent** (it cannot
set its own mode, because directives are read from the dispatch text only, never from the
subagent's output); parity gaps with `CAP:` parsing; a risk table that rates a destructive change
(a test deleted, a CI file changed) as `low`.

---

### Wave 2 — Integration: the final `testsPass` pipeline

`vrb/wave-2` is branched from `vrb/wave-1` after all Wave 1 phases are merged and clean.

#### Phase 2.1 — testsPass pipeline, gate abort, dispatch reference `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** `testsPass` works as in §1.6: scoped (S1), under the slot (S3), with caps and the gate
abort (S4), with a failure-only recheck at the reference (S2), and never a full suite unless
`testScope: "full"` is set (S6). The dispatch-time test baseline code is **removed**.

**Pre-flight (in addition to §0.9)**
- [ ] All five Wave 1 QA reports are clean; `vrb/wave-2` contains them.
- [ ] Gather `[tier:fast]`: the current `beginVerification`/`prepareVerification`/`execSeam`
      (`D:\git\opencode-model-router\src\verify\wiring.ts`), the baseline store in
      `createChangedFileStore` (`D:\git\opencode-model-router\src\verify\dispatch.ts`),
      `runCommandCheck` (`D:\git\opencode-model-router\src\verify\deterministic.ts`), `compareTests`
      (`D:\git\opencode-model-router\src\verify\baseline.ts`), and both gate call sites in
      `D:\git\opencode-model-router\src\index.ts` (`delegate` tool: `accept(` wrapped in
      `withTimeout(…, gateBudgetMs, "verification gate")`; native `task` in `tool.execute.after`).

**Tasks**
- **2.1.1** `[tier:heavy]` Design the pipeline and the verdict algebra (written as the header of
  the new `testsPass` section in `D:\git\opencode-model-router\src\verify\deterministic.ts`). It must
  include a truth table covering: {scoped result green / failures / collection error / timeout / slot
  busy / S6 unverifiable} × {recheck exact-and-all-preexisting / exact-and-some-introduced /
  approximate / unusable / disabled / timed out / skipped for deadline}, with the resulting `ok`,
  `unverifiable`, `reason` and `note`. It preserves the §1.2 guarantees. It also fixes, as exported
  TypeScript types in `D:\git\opencode-model-router\src\verify\types.ts` committed **before any other
  2.1 or 2.2 work starts**:
  - `Deadline` (§1.5-13);
  - `ScopedOutcome`, `RecheckOutcome`;
  - `ScopedExecutor = (spec, deadline) => Promise<ScopedOutcome>`: slot + caps + run + `readResult`;
  - `Rechecker = (reference, failingFiles, deadline) => Promise<RecheckOutcome>`;
  - the signature of `judgeScoped(scoped, recheck)`.

  Phase 2.2's `batch.ts` consumes exactly these types, so it has no hidden dependency on 2.1's internals.
- **2.1.2** `[tier:medium]` Replace the testsPass branch of `runCommandCheck` with the pipeline
  (the batch hook is a direct call for now; 2.2 swaps in the coordinator behind the same function
  signature).
  - 2.1.2.a `DeterministicDeps` (`D:\git\opencode-model-router\src\verify\types.ts`) gains
    `argv: ArgvSeam`, `changedFiles`, `reference`, `slot`, `budget`, `signal`. The old
    `testBaseline` member is removed.
  - 2.1.2.b `buildPasses`, `lintClean` and `run` also run under the slot, with low priority and the
    signal; `lintClean` uses scoping (§1.5-10).
  - 2.1.2.c `testScope: "full"` runs the resolved full command, and still uses S2–S4.
- **2.1.3** `[tier:medium]` `D:\git\opencode-model-router\src\verify\dispatch.ts` +
  `D:\git\opencode-model-router\src\verify\wiring.ts`: `beginVerification` becomes async and captures
  a reference (1.5) instead of running tests, only for DoDs with `testsPass` and only when
  `failureRecheck` is on. Delete the test-baseline cache (`cache`, `baselines`) and `baseline()`.
  **Keep `observeEdit` contamination**, now applied to the in-flight reference capture (§1.5-14):
  an edit observed in an overlapping directory before the capture resolves discards the reference.
  Keep the changed-file tracking (`bySession`, `delta`) intact. `prepareVerification` returns the
  reference and the changed files. References follow the existing TTL sweep. A retry keeps the
  original dispatch's reference, so a failed attempt can never become its own reference.
- **2.1.4** `[tier:medium]` `D:\git\opencode-model-router\src\verify\baseline.ts`: replace
  `compareTests` with `judgeScoped(scoped, recheck | undefined)` implementing the 2.1.1 table. Keep
  `observeTests` as the text fallback that `runner.ts` uses.
- **2.1.5** `[tier:medium]` `D:\git\opencode-model-router\src\index.ts`:
  - 2.1.5.a Gate deadline (§1.5-13): in **both** call sites, create a `Deadline` and an
    `AbortController` per gate invocation, and pass both into the gate deps.
    - `delegate` tool: keep its `withTimeout(… "verification gate")` and abort the controller when
      it rejects.
    - Native `task` path in `tool.execute.after`: `accept(…)` is currently unwrapped. Wrap it in the
      same `withTimeout(accept(…), gateBudgetMs, "verification gate")`, with the same abort-on-reject
      and the same `unverifiableGateResult` fallback as the `delegate` path.

    Either way, the running command tree dies with the gate.
  - 2.1.5.b **Bounded wait** for the reference capture (§1.5-14). The `task` before-hook
    (`tool.execute.before`, where `beginVerification` is called today) and the `delegate` dispatch
    both await `beginVerification(…)` for at most `captureWaitMs`, then proceed. The capture keeps
    running up to `baselineTimeoutMs`. Phase 2.4 replaces the fixed `captureWaitMs` with the
    per-dispatch `VERIFY_WAIT`. A timeout or error means "no reference" and must never block or fail
    the dispatch.

  Scope note: 2.1 builds the **synchronous (required) path**, which `router_verify` also reuses.
  Until 2.4 is merged, every `testsPass` DoD takes that path. 2.4 adds the mode routing that makes
  deferred the default. Both land in the same release; no intermediate behaviour ships.
  - 2.1.5.c Call `gcStaleReferences` once at plugin start, fire-and-forget, with logged failures.
  - 2.1.5.d Switch every read of `baselineTimeoutMs`/`gateBudgetMs` defaults to `resolveVerifyBudget`
    (the list comes from the Phase 1.1 QA report).
- **2.1.6** `[tier:medium]` Rewrite `D:\git\opencode-model-router\test\unit\baseline.test.ts` and
  `D:\git\opencode-model-router\test\unit\baseline-wiring.test.ts` to the new model (no behaviour
  from the removed cache is kept alive), and add
  `D:\git\opencode-model-router\test\unit\tests-pass-pipeline.test.ts`.

**New tests (edge cases required)**
- Every row of the 2.1.1 truth table is a test case (table-driven).
- A read-only dispatch → no reference, no command. An implementation dispatch → a reference is
  captured and **zero** test commands run at dispatch (assert through the seams).
- A green scoped run → pass, and **no** recheck is attempted.
- A failure introduced by the producer (green at the reference) → rejected, naming only the new test.
- A pre-existing failure (failing at an exact reference) → accepted with the "no worse than before"
  note that states the suite is not green.
- Mixed: one pre-existing and one introduced → rejected, naming only the introduced one.
- Approximate reference + failure → `unverifiable`; with `strictUnverifiable` → rejected as unverifiable.
- `failureRecheck: false` (and the deprecated `testBaseline: false`) → no reference is captured at
  dispatch, a green scoped run passes, any scoped failure is `unverifiable`; assert that no
  worktree is ever created.
- Slot busy past `slotWaitMs` → `unverifiable` "verification slot busy"; the gate budget expiring
  while waiting for the slot → the wait is cancelled, and no process is spawned afterwards.
- Gate budget expiry during a scoped run → the tree is killed (assert through the argv seam
  receiving an aborted signal).
- `testScope: "full"` → the full command runs once, no dispatch-time run, S2 applies to its failures.
- Escalation interplay: a rejected verdict still triggers the ladder exactly as before
  (reuse the existing escalation assertions in the rewritten `baseline.test.ts`).
- **Deadline:** with `gateBudgetMs` = 5 s, a slot wait configured at 60 s is cut at the remaining
  time; a scoped run that ends with 8 s left skips the recheck (→ `unverifiable`, "gate budget
  exhausted before recheck"). No step ever outlives the deadline (assert through the seam
  timestamps under fake timers).
- **Native `task` gate budget:** an `accept` that exceeds `gateBudgetMs` in the `tool.execute.after`
  path yields the `unverifiable` gate result, aborts the controller and kills the tree. Before this
  plan it hung without limit, so this is a new regression test.
- **Bounded capture wait:** the producer prompt (`delegate`) and the `task` execution start when
  `captureReference` resolves or when `captureWaitMs` expires, whichever is first (fake timers: a
  capture at 2 s → start at 2 s; a capture at 20 s → start at 5 s, and the capture still completes
  and is usable if no edit was observed). A capture that throws never fails the dispatch.
- **Contamination:** an `edit` observed for the directory while the capture is in flight → the
  reference is discarded → a later scoped failure is `unverifiable`.
- **Retry:** an escalated retry reuses the first dispatch's reference, never a new one taken after
  the failed attempt.

**Acceptance criteria**
- `rg "testBaseline|baselines\.|compareTests" D:\git\omr-p21\src` returns only the deprecated config
  key handling in `config.ts`.
- With default config, **no code path runs a test command at dispatch time**, and **no code path runs
  a full suite** (proven by tests that assert the argv of every spawned spec).

**Definition of Done** — as in 1.1; full unit suite (`npx vitest run --maxWorkers=2`, §0.6.7) + typecheck green; coverage of changed `D:\git\opencode-model-router\src\verify\*` files ≥ 90% lines/branches (measured with `npx vitest run --maxWorkers=2 --coverage --coverage.include=src/verify/**`); QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-2.1.md`.

**QA review** `[tier:heavy]` CAP:none — reason: the verdict algebra is the guardrail itself; the reviewer must read the whole pipeline, both gate call sites and the truth-table tests.
Adversarial focus: **false passes** (any path where an introduced failure is excused), a stale
reference reused across retries (a failed attempt must never become its own reference, same rule as
before), the attribution of changed files under concurrent subagents, leaked slots/worktrees on
every exception path, and behaviour when the gate is aborted between the scoped run and the recheck.

---

#### Phase 2.2 — Batching coordinator (S5) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** concurrent `testsPass` checks for the same runner root become one scoped run, with correct
per-request verdicts.

**Parallelism:** tasks 2.2.1–2.2.2 (the new file `D:\git\opencode-model-router\src\verify\batch.ts`
and its unit tests) start as soon as task 2.1.1 has committed its exported types. They then run
**in parallel with tasks 2.1.2–2.1.6**, coding only against the 1.3 spec types and the 2.1.1
`Deadline`/`ScopedExecutor`/`Rechecker` types, which are cherry-picked onto `vrb/p22` from the 2.1.1
commit. Task 2.2.3 (wiring) starts only after 2.1 is merged, because it writes
`D:\git\opencode-model-router\src\verify\wiring.ts`.

**Pre-flight (in addition to §0.9)**
- [ ] Spike C's result on non-executing related-test listing is recorded; it selects attribution mode
      A (listing) or B (per-request re-run of the failing files only).

**Tasks**
- **2.2.1** `[tier:heavy]` Design (the header of `batch.ts`):
  - the batch key `(git root, runner, resolved entry, env signature)`;
  - window semantics: it opens at the first request and closes at `batchWindowMs`, or earlier when a
    configured maximum size is reached;
  - requests that arrive while a batch is running join the **next** window;
  - attribution:
    - mode A: list the related tests per request and assign each failing file to every request whose
      related set contains it;
    - mode B: when the union run fails, re-run only the failing files once per request, scoped to
      that request's affected set, all under one slot hold;
  - how S2 is shared: one recheck for the union of the failing files, with results distributed;
  - cancellation: one requester's abort does not cancel the batch unless all requesters have aborted.
- **2.2.2** `[tier:medium]` Implement `D:\git\opencode-model-router\src\verify\batch.ts` with an
  injected clock and seams, plus `D:\git\opencode-model-router\test\unit\batch.test.ts`.
- **2.2.3** `[tier:medium]` Wire it into `D:\git\opencode-model-router\src\verify\wiring.ts`: one
  coordinator per plugin instance, with an eviction sweep that shares the existing TTL sweep. Add
  `D:\git\opencode-model-router\test\unit\batch-wiring.test.ts`.

**New tests (edge cases required)**
- 5 requests inside the window → exactly 1 scoped run over the union; 5 correct verdicts.
- Requests for different roots or runners → separate batches that run in parallel only as far as the
  slot allows (`maxConcurrentVerifications`).
- `batchWindowMs: 0` → every request runs alone (the old behaviour, still scoped).
- Union green → all pass. Union fails in a file related to only one request → only that request is
  rejected; the others pass. A failing file related to two requests → both are judged through S2.
- A pre-existing failure that is related to all requests → a single shared recheck; all pass with the note.
- A requester aborts mid-batch → the others still get verdicts; all abort → the run is killed.
- A request arriving while a batch runs → the next window, never merged into the running union.
- Changed-file overlap between requests (the same file edited by two producers) → the union is
  deduplicated.
- A window timer under fake timers: no leaked timers after the coordinator is disposed.

**Acceptance criteria**
- In the wiring test with 5 concurrent `testsPass` gates, the argv seam sees ≤ 1 scoped run + ≤ 1
  recheck per window.
  *Amended during implementation (phase-2.2.md, D2 and D4):* that bound holds for a passing batch
  and for a shared reference. A failing vitest/jest union costs 1 + n runs (mode B: the pooled run,
  then each member's own attribution run). The maximum window size is a coordinator option
  (`BATCH_MAX_REQUESTS`, default 8), not a config key.
- Verdicts are identical to running each request alone (property test over random change sets and
  failure assignments, using the fake runner seam).

**Definition of Done** — as in 2.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-2.2.md`.

**QA review** `[tier:heavy]` CAP:none — reason: attribution correctness under concurrency; the reviewer must read batch.ts, its wiring and the property tests.
Adversarial focus: misattribution that excuses a producer, starvation (a steady stream of requests
that keeps a window open forever), memory growth of the coordinator, and interaction with the
gate budget (a batch longer than one requester's budget).

---

#### Phase 2.4 — Deferred verification, `router_verify`, pending list (S7) `[tier:heavy]` design + `[tier:medium]` implementation

**Goal:** by default, no delegation waits for verification and no verification process runs. The
orchestrator decides per dispatch (`VERIFY:required|deferred`, `VERIFY_WAIT`) and can fetch a verdict
at any time with `router_verify`. Background verification exists only behind `background: true`.

**Parallelism:** task 2.4.1 (the new file `D:\git\opencode-model-router\src\verify\pending.ts` and its
unit tests) starts once 2.1.1's types are committed, and runs in parallel with 2.1.2–2.1.6 and 2.2.
Tasks 2.4.2–2.4.6 start after 2.2.3 is merged, because they write
`D:\git\opencode-model-router\src\verify\wiring.ts` and `D:\git\opencode-model-router\src\index.ts`.

**Pre-flight (in addition to §0.9)**
- [ ] 2.1 and 2.2 are merged and their QA is clean (for tasks 2.4.2+).
- [ ] Gather `[tier:fast]`:
  - the `tool:` registration block with the `delegate` tool in
    `D:\git\opencode-model-router\src\index.ts` (the `tool({ … })` pattern and its arg schema);
  - the `experimental.chat.system.transform` hook;
  - `tool.execute.before`/`tool.execute.after` for `task`;
  - the forcing-note builder (`buildForcingNote`);
  - how session ids of the orchestrator vs its subagents are told apart
    (`D:\git\opencode-model-router\src\router\sessions.ts`).
- [ ] **Spike F** `[tier:fast]`: confirm in a scratch plugin (or the existing smoke harness) that a
      second plugin tool can be registered next to `delegate`, that its `execute` can run for up to
      `gateBudgetMs` without the host timing it out, and that text appended to a native `task` tool
      output in `tool.execute.after` reaches the orchestrator verbatim (it does today for forcing
      notes; re-confirm with a footer that contains a handle).

**Tasks**
- **2.4.1** `[tier:heavy]` design, then `[tier:medium]` implementation of
  `D:\git\opencode-model-router\src\verify\pending.ts`: the pending registry, keyed by
  `vrf_<random>` handle.
  - **Entry:** `{ orchestratorSessionID, dispatchID, producerSessionID, description, cwd, dod,
    reference promise, changedFiles, risk, createdAt, state: "unverified" | "verifying" | "verified" }`.
  - **Operations:** `register`, `get`, `listUnverified(sessionID, limit)`, `markVerifying` (a
    second concurrent `router_verify` for the same handle joins the in-flight run instead of starting
    another), `settle(verdict)`, and TTL eviction (`pendingTtlMs`) through the existing sweep.
  - **Scoping:** an orchestrator can only see and verify **its own** handles. A handle from another
    session is an "unknown handle".
- **2.4.2** `[tier:medium]` Route by mode in `D:\git\opencode-model-router\src\index.ts` and
  `D:\git\opencode-model-router\src\verify\wiring.ts`:
  - parse the directives with `parseVerifyDirectives` (1.6) from the dispatch text at dispatch;
  - start the reference capture and await it for at most `waitMs` (§1.5-14);
  - on return, **required** → the 2.1 synchronous gate (unchanged, including escalation);
  - **deferred** → no gate: compute the changed files and the static scoping plan (1.3 planner,
    no spawn), compute the risk (1.6), register the pending entry, and append the §1.5-16 footer to
    the result, in both the native `task` output and the `delegate` tool return.
- **2.4.3** `[tier:medium]` Register the `router_verify` tool (§1.5-18) next to `delegate`.
  - **Arg schema:** `{ handles: string[] } | { pending: true }`.
  - **Execution:** it runs the synchronous pipeline through the 2.2 batch coordinator under one
    `gateBudgetMs` deadline, and returns a compact per-handle verdict list (handle, verdict, named
    introduced failures, notes and caveats, drift notice, suggested next tier on rejection).
  - **Registration:** the tool is registered whenever verification is enabled; it does not depend on
    `enableDelegateTool`.
- **2.4.4** `[tier:medium]` System transform (§1.5-20): list the calling session's unverified
  delegations (≤ 5, newest first). Keep it to one short block, emitted only when the list is
  non-empty, so the prompt does not grow for sessions that never defer.
- **2.4.5** `[tier:medium]` Background mode (§1.5-19), only when `background: true`:
  - a per-plugin-instance queue with coalescing (a newer request for an overlapping file set
    supersedes a queued older one);
  - it runs through the same batch coordinator, slot and caps;
  - late notices are queued per orchestrator session and emitted once by the system transform;
  - the queue object is not even constructed when `background` is `false` (assert by test).
- **2.4.6** `[tier:medium]` Tests in `D:\git\opencode-model-router\test\unit\deferred-verification.test.ts`
  and `D:\git\opencode-model-router\test\unit\router-verify-tool.test.ts`.

**New tests (edge cases required)**
- **Default deferred, zero cost:** a `testsPass` delegation with no directive returns immediately
  with the footer. The argv seam records **zero** spawns, and the slot is never acquired (assert on
  the seams). The only process-free work is git capture, which also goes through a seam and is
  asserted to be git-only.
- **Latency:** with a capture seam that resolves after 20 s and `VERIFY_WAIT:5s`, the producer
  starts at 5 s (fake timers). With `VERIFY_WAIT:0s` it starts at 0. A capture that resolves at 2 s
  under a 5 s wait → the producer starts at 2 s, not 5 s.
- **Capture after the wait:** the capture resolves after the producer started. Valid if no edit was
  observed in between; discarded if one was. A later `router_verify` says "no reference".
- **Required:** `VERIFY:required` → the synchronous gate runs, rejection escalates exactly as in 2.1.
  `defaultVerify: "required"` with no directive → the same.
- **`router_verify`:**
  - a single handle and `pending: true`;
  - an unknown handle; a handle from another session (→ unknown); an expired handle (TTL);
  - two concurrent calls for the same handle → one run;
  - several handles → one batched run;
  - drift (the producer's file edited after the producer returned) → the verdict carries the drift
    notice;
  - the deadline expires mid-run → `unverifiable` for the handles not yet judged, and the tree is
    killed;
  - a rejected verdict → forcing note + suggested tier, and **no** retry dispatched (assert no new
    session is created).
- **Pending list:** it appears only when non-empty, is capped at 5 and orders newest first; a
  verified entry leaves it; a TTL-expired one leaves it; sessions never see each other's entries.
- **Background (only when `background: true`):**
  - a queued deferred delegation is verified with no `router_verify` call;
  - an introduced failure produces exactly one late notice on the next transform;
  - a green result produces no notice;
  - coalescing drops a superseded queued request;
  - with `background: false`, the queue does not exist and nothing is spawned across 50 deferred
    delegations.
- **Subagent cannot self-select:** a producer whose final text contains `VERIFY:required` or
  `router_verify` does not change its own mode or trigger a verification.

**Acceptance criteria**
- With the default config, N parallel implementation delegations spawn **no** verification
  processes and add at most `VERIFY_WAIT` (≤ 5 s by default, usually under 1 s) to dispatch latency
  and **0 ms** to result latency.
- Every deferred result carries the footer; no deferred result is ever labelled accepted or verified.
- *Amended during implementation (phase-2.1.md QA-2.1-6, phase-2.4.md; T11 residual):* a native
  `task` re-dispatch after a rejection captures a reference that already contains the rejected
  attempt, so a failure that attempt introduced would read as pre-existing. Accepted as a residual,
  mitigated by the per-session rejection lineage: proven-introduced ids are remembered and such a
  pass becomes `unverifiable` with a caveat naming the earlier delegation. The ledger matches ids
  only, so a renamed test escapes it. The `delegate` ladder keeps its first reference.

**Definition of Done** — as in 2.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-2.4.md`.

**QA review** `[tier:heavy]` CAP:none — reason: the reviewer must read the mode routing in both call paths, the tool, the registry and the transform together.
Adversarial focus:
- a path where a deferred delegation is reported as verified, or a required one silently becomes
  deferred;
- handle leakage across sessions;
- unbounded registry growth;
- the transform bloating the prompt;
- `router_verify` running without a deadline;
- background code paths reachable with `background: false`;
- a slow capture that still blocks the producer beyond `VERIFY_WAIT`.

---

#### Phase 2.3 — Protocol, documentation, ADR, changelog `[tier:medium]`

**Goal:** everything a user or orchestrator reads describes the final behaviour exactly.

**Pre-flight (in addition to §0.9)**
- [ ] 2.1, 2.2 and 2.4 are merged and their QA is clean (the docs describe merged behaviour only).

**Tasks**
- **2.3.1** `[tier:medium]` Protocol text.
  - **Acceptance-block guidance** in `D:\git\opencode-model-router\src\index.ts` (near
    `"check: <testsPass | buildPasses | …>"` and `"Prefer deterministic checks …"`): `testsPass`
    means "the tests affected by the producer's changes pass; the full suite is CI's job", and
    acceptance blocks should prefer `testsPass` over hand-written full-suite `run` commands.
  - **Per-dispatch sentence** in `D:\git\opencode-model-router\src\router\protocol.ts`, next to the
    existing `CAP:N` sentence: explain `VERIFY:required|deferred` and `VERIFY_WAIT:<n>s`. Deferred is
    the default and returns immediately with a handle and a risk level. Use `VERIFY:required` when
    later work depends on this delegation being correct, or `router_verify` before building on a
    deferred result whose risk is medium or high. Unverified delegations are listed in the prompt
    until verified.
  - **Size:** keep it to two short sentences, following the terse style of the `CAP:` sentence. The
    added prompt size is measured and reported.

  Regenerate the goldens under
  `D:\git\opencode-model-router\test\golden\` and review the diff line by line (only the intended
  text may change). Update the README's measured prompt-size figures if they move.
- **2.3.2** `[tier:medium]` `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md`: add the §1.4
  keys to the `verify` table; rewrite "Test and changed-file baselines" into
  "Affected-test verification" (S1–S7, reference capture, recheck, slot, batching, the deprecations);
  add a "Deferred verification" section (the directives, the footer format, the risk table,
  `router_verify`, the pending list, `background`, and an explicit statement that by default an
  unverified delegation is **not** checked unless the orchestrator asks). Document the
  `router_verify` tool in `D:\git\opencode-model-router\docs\COMMAND_REFERENCE_INDEX.md` alongside
  `delegate`.
- **2.3.3** `[tier:medium]` `D:\git\opencode-model-router\docs\VERIFICATION.md` and
  `D:\git\opencode-model-router\docs\FLOW_DIAGRAMS.md`: the new flow (§1.6).
- **2.3.4** `[tier:medium]` ADR `D:\git\opencode-model-router\docs\adr\0003-affected-test-verification.md`:
  context (the incident with its evidence, and the owner's constraints from §1.1), decision (S1–S7),
  and consequences:
  - what `testsPass` no longer proves, and why CI is the full-suite gate;
  - that deferred-by-default trades the enforced-verification guarantee for speed, which is the
    owner's explicit choice. The router's own motivating evidence (instructed models false-finish)
    is cited as the known risk, mitigated by the risk signal, the pending list and `router_verify`.

  Alternatives rejected: the dispatch-time full baseline; running the full suite at low priority
  only; background verification on by default.
- **2.3.5** `[tier:medium]` `D:\git\opencode-model-router\CHANGELOG.md` `## [Unreleased]`:
  - **Added:** the keys, the directives, `router_verify`, the pending list, pytest.
  - **Changed:** the `testsPass` semantics, deferred verification by default, the deprecations.
  - **Fixed:** the gate abort kills the tree; the native `task` required gate has a budget.

  Written in the house style of the 1.14.0 entry. It must say plainly that, by default, delegations
  are no longer verified unless the orchestrator asks.
- **2.3.6** `[tier:medium]` `D:\git\opencode-model-router\docs\plans\README.md`: list this plan
  under Active plans.

**New tests**
- The golden snapshots are updated and reviewed. `D:\git\opencode-model-router\test\unit\packaging.test.ts`
  still passes (new `src` files ship; no test fixtures ship).
- A docs consistency test in
  `D:\git\opencode-model-router\test\unit\config-verify-budget.test.ts` (2.3 owns this file in Wave 2
  per §2): every key in `resolveVerifyBudget`'s defaults appears in
  `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md` with the same default.

**Acceptance criteria**
- No document still claims that dispatches "warm" a test cache or that `testsPass` runs the suite.
  Check with `rg -n "warm|baseline capture|full suite" D:\git\omr-p23\docs D:\git\omr-p23\README.md` and review every hit.

**Definition of Done** — as in 1.1; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-2.3.md`.

**QA review** `[tier:heavy]` — adversarial focus: docs that promise more than the code does
(especially about what `unverifiable` means and about Windows), protocol text that would lead an
orchestrator to write full-suite `run` checks, protocol text that implies deferred delegations are
checked automatically, and golden diffs that include unintended text.

---

### Wave 3 — Prove it end to end, then release

`vrb/wave-3` is branched from `vrb/wave-2` after all Wave 2 phases are merged and clean.

#### Phase 3.1 — End-to-end fixtures, resource benchmark, CI `[tier:medium]` (+ `[tier:fast]` runs)

**Goal:** prove on real runners, on Windows and Linux, that the guardrail holds and the resource
bound holds.

**Pre-flight (in addition to §0.9)**
- [ ] Waves 1–2 are merged and clean; the full unit suite (`npx vitest run --maxWorkers=2`) is green on `vrb/wave-3`.

**Tasks**
- **3.1.1** `[tier:medium]` Fixture projects under `D:\git\opencode-model-router\test\fixtures\projects\`:
  `vitest-app` (≥ 40 test files, a module graph where each source has 1–3 related tests),
  `jest-app` (≥ 20 test files) and `pytest-app` (≥ 20 test files, with a `conftest.py`). Each has one
  deliberately pre-existing failing test that can be switched on with an env-free mechanism: a
  separate file that the test setup copies in. Dependencies are installed by the test setup into a
  temp copy, **never committed**; they are cached in CI.
- **3.1.2** `[tier:medium]` `D:\git\opencode-model-router\test\integration\verify-resource-budget.test.ts`,
  gated by `RUN_VERIFY_E2E=1`, which drives the real wiring (plugin factory + gate) against temp
  git copies of the fixtures:
  - 3.1.2.a Guardrail matrix per runner, driven through **both** entry points: `VERIFY:required`
    dispatches, and deferred dispatches followed by `router_verify`. Introduced failure → rejected;
    pre-existing → accepted with the note; pre-existing + introduced → rejected naming only the
    introduced; docs-only change → pass note; `conftest.py` change → `unverifiable`.
  - 3.1.2.b **Resource bound:** 5 concurrent `VERIFY:required` implementation gates on `vitest-app`,
    then 5 deferred delegations verified by one `router_verify({pending:true})`, with the defaults.
    A process sampler polls every 100 ms (Windows: `Get-CimInstance Win32_Process`; POSIX: `ps -eo pid,ppid,ni,args`)
    and records the descendant processes of the test process. Assert:
    - peak concurrent runner worker processes ≤ `maxWorkers` × `maxConcurrentVerifications`;
    - no descendant runs above below-normal priority;
    - no test command started at dispatch;
    - no command ever ran the full file set (from the argv records);
    - the total number of runs is ≤ 1 per batch window + rechecks.
  - 3.1.2.c **Two plugin instances** (two child processes, simulating two opencode sessions) → the
    slot limits them jointly.
  - 3.1.2.d **No orphans:** force the gate budget to expire mid-run; 3 s later no attributable
    descendant is alive. *Amended during implementation (phase-1.2.md round 2):* "no descendant"
    became "no attributable descendant" (see G4 and its known limits).
  - 3.1.2.e **Cleanup:** after the suite, no `omr-ref-*` worktrees remain, and the fixture's real
    `node_modules` sentinel file still exists.
  - 3.1.2.f **Deferred costs nothing:** 20 parallel deferred implementation delegations on
    `vitest-app` with the default config. The sampler must observe **zero** runner processes and no
    slot files. Each result returns with the footer within 50 ms of the producer finishing, and each
    dispatch waits ≤ `VERIFY_WAIT` for the capture (with a real repo, measured and reported; expected
    < 1 s).
    *Amended during implementation (phase-3.1.md, QA-3.1-3):* the after-hook is bounded by the 2 s
    git-only snapshot (`DEFERRED_FINISH_MS`), not 50 ms. With 20 parallel dispatches the capture
    wait p50 is about 1.0 s (measured 964 ms), not < 1 s. A 100 ms sampler interval is unreachable on
    Windows (one `Get-CimInstance` poll takes longer); the tests assert a median interval ≤ 500 ms
    on Windows and ≤ 250 ms on POSIX (`SAMPLER_MEDIAN_INTERVAL_MAX_MS`, QA-3.1-5), and a capture
    wait p50 ≤ 1.5 s.
  - 3.1.2.g **Orchestrator control:** a dispatch with `VERIFY_WAIT:0s` starts the producer without
    waiting; `VERIFY:required` blocks until a verdict; `router_verify` after drift reports the drift.
  - 3.1.2.h **Background opt-in:** with `background: true`, an introduced failure in a deferred
    delegation surfaces as one late notice; with `background: false` (repeat 3.1.2.f), nothing runs.
- **3.1.3** `[tier:medium]` `D:\git\opencode-model-router\.github\workflows\test.yml`: add an `e2e`
  job (`ubuntu-latest` and `windows-latest`, Node 22) that runs with `RUN_VERIFY_E2E=1` and has
  `uv`/pytest set up. Every new third-party action is **pinned by full commit SHA with a version
  comment**, like the existing `actions/checkout`/`actions/setup-node` lines; resolve the SHA from the
  action's release tag with `gh api`.

  Coverage: platform-specific branches (Windows tree kill and priority vs POSIX process groups and
  `nice`, junction vs symlink) cannot all be covered on one OS. So:
  - these branches are isolated in small per-platform functions;
  - a new `coverage` job (ubuntu-latest, Node 22) and the Windows `e2e` job each produce coverage;
  - the enforced gate combines both reports (upload the artifacts, merge with
    `npx nyc merge`/`istanbul-merge` or vitest's `--merge-reports`, whichever works with the
    installed vitest; decide in the pre-flight of this phase).

  `D:\git\opencode-model-router\vitest.config.ts`: per-file coverage thresholds of ≥ 90% lines and
  branches for `src/verify/{exec,runner,slot,reference,batch,directives,risk,pending}.ts`, evaluated on the merged report,
  and keep the
  existing per-directory gates.
- **3.1.4** `[tier:medium]` Smoke: extend
  `D:\git\opencode-model-router\test\smoke\layer2-gate.smoke.test.ts` so that, in real opencode:
  - a `VERIFY:required` delegation with a `testsPass` acceptance block runs a scoped command
    (asserted from the plugin log);
  - a deferred one returns the footer and spawns nothing;
  - the `router_verify` tool is registered and callable.
- **3.1.5** `[tier:fast]` Run the full unit suite (`npx vitest run --maxWorkers=2`), the e2e suite locally on Windows (serialized, never alongside another full run), and the smoke
  keyless lane, then push and collect the CI results for every job; report.

**New tests** — as listed in 3.1.2 and 3.1.4 (this phase *is* the system-level test phase).

**Acceptance criteria** — the global criteria G1–G8 (§4.1) are demonstrated by passing tests on
both OSes in CI.

**Definition of Done** — as in 1.1; the CI `test`, `e2e`, `smoke-keyless`, CodeQL and GitGuardian
checks are green; QA report `D:\git\opencode-model-router\docs\qa\verification-resource-budget\phase-3.1.md`.
*Amended during implementation (QA-3.1-23):* this repository has no CodeQL workflow; the security
gates are GitGuardian and the GitHub Advanced Security PR check, whose 'Code scanning AI findings'
job fails on infrastructure (CAPIError 400), not on code. Enabling CodeQL default setup is an owner
repo-settings decision.

**QA review** `[tier:heavy]` CAP:none — reason: the reviewer must judge whether the e2e assertions actually prove G1–G8 or can pass vacuously.
Adversarial focus: sampling that could miss short-lived workers (the poll interval vs worker
lifetime; assert a minimum observed count so the sampler provably saw workers), tests that pass
because nothing ran, flaky timing, and fixtures that differ from real repos (pnpm layout, monorepo).

---

#### Phase 3.2 — Global senior QA review `[tier:heavy]` CAP:none — reason: whole-change adversarial review across every file of the plan.

**Pre-flight**
- [ ] Every phase QA report shows zero open findings; CI on `vrb/wave-3` is green.
- [ ] `[tier:fast]` produces the review packet: the full diff `git diff origin/master...vrb/wave-3`,
      the file list, the e2e and bench output, the spike logs, and every phase QA report.

**Task**
- **3.2.1** `[tier:heavy]` Adversarial global review against §1.2, §1.5 and G1–G8. It is saved to
  `D:\git\opencode-model-router\docs\qa\verification-resource-budget\global.md`. It must at least
  attempt to:
  - construct a false pass;
  - construct a command injection;
  - make cleanup delete real data;
  - deadlock the slot;
  - run a full suite with the default config;
  - make a deferred delegation spawn a verification process, or be labelled verified, with the
    default config;
  - make a subagent choose its own verification mode, or read another session's handles;
  - make the dispatch wait longer than `VERIFY_WAIT`;
  - leave an orphan process.

  Each attempt is recorded with its outcome.
- **3.2.2** `[tier:medium]` Fix **every** finding (own commits), then re-run the §0.9 checks and the
  e2e suite. **3.2.3** `[tier:heavy]` Re-review the fixes. Repeat until zero open findings (§0.8
  applies to repeated failures).

**Acceptance / DoD** — zero open findings in `global.md`; CI green after the fixes.

---

#### Phase 3.3 — Release `1.15.0` and local sync `[tier:medium]` (+ `[tier:fast]` verification)

**Pre-flight**
- [ ] Phase 3.2 closed with zero findings; `vrb/wave-3` is green in CI.
- [ ] `npm view opencode-model-router version` is lower than `1.15.0`. If another release landed in
      between, rebase `vrb/wave-3` on `master`, re-run 3.1.5, and release as the next minor after it
      (update the version everywhere this phase mentions `1.15.0`).

**Tasks**
- **3.3.1** `[tier:medium]` Open the PR `vrb/wave-3` → `master` titled
  `feat(verify): affected-test verification under a machine-wide resource budget`. The body gives the
  summary, S1–S7, the evidence, the G1–G8 proof links and the QA report links. It ends with the
  repo's PR attribution line.
- **3.3.2** `[tier:fast]` Watch the CI; on red, route per §0.8 (fix on the branch, never merge red).
- **3.3.3** `[tier:medium]` Merge with a merge commit (the repo convention). On `master`: set
  `D:\git\opencode-model-router\package.json` and `package-lock.json` to `1.15.0`, and rename
  `## [Unreleased]` to `## [1.15.0] - <date>` in `D:\git\opencode-model-router\CHANGELOG.md`.
  Commit `chore(release): 1.15.0`, push, tag `v1.15.0`, push the tag.
- **3.3.4** `[tier:fast]` Watch the `Publish Package` workflow, then poll the registry until
  `latest` is `1.15.0`. The publish log must show `+ opencode-model-router@1.15.0` and the
  provenance statement.
- **3.3.5** `[tier:fast]` Sync the main checkout (the plugin that the live sessions load):
  `git -C D:\git\opencode-model-router pull --ff-only` (the tree must be clean first; if it is not,
  this is a §0.1 critical item: stop and ask). Remove every `D:\git\omr-*` worktree and every
  `vrb/*` branch, locally and on the remote. Then tell the human to restart the opencode sessions.

**Acceptance / DoD** — `1.15.0` is `latest` on npm with provenance; `master` is tagged; the main
checkout is at `v1.15.0`; no `omr-*` worktrees or `vrb/*` branches remain.

---

## 4. Global acceptance, Definition of Done, QA

### 4.1 Global acceptance criteria

- **G1 — No suite per delegation.** With the default config, no delegation (read-only or
  implementation) runs a test command at dispatch, and no command that the router builds itself
  (`testsPass`, `lintClean` scoping, S2 rechecks, S5 batches) ever runs the full test set. The one
  exception is an explicit `check: run command="…"` written by the orchestrator, which runs as
  written (§1.5-12) but still under S3, S4 and the gate deadline. The injected protocol steers
  orchestrators away from full-suite `run` checks. Proven by 3.1.2.b, the 2.1 argv assertions and
  the 2.3 golden protocol text.
- **G2 — The guardrail holds when verification runs.** For `VERIFY:required` gates and
  `router_verify` calls, introduced failures are rejected and named; pre-existing failures (exact
  reference) are accepted with an explicit "suite not green" note; anything unprovable is
  `unverifiable`. An unverified delegation is never labelled accepted or verified. Proven by the 2.1
  truth-table tests, the 2.4 tests and the 3.1.2.a runner matrix.
- **G3 — Bounded CPU/RAM.** Peak concurrent runner workers from verification ≤ `maxWorkers` ×
  `maxConcurrentVerifications` (default 2 × `max(1, floor(cores/8))`) machine-wide, across opencode
  processes, all at below-normal priority. Proven by 3.1.2.b and 3.1.2.c on Windows and Linux.
- **G4 — Nothing outlives its budget.** Every synchronous verification (a required gate in the
  `delegate` and the native `task` paths, and each `router_verify` call) has one deadline
  (`gateBudgetMs`). No slot wait, run, recheck or batch step outlives it by more than the 2 s kill
  grace: the run resolves and releases its slot at most 2 s after the deadline, even when a
  descendant still holds its output pipes. Its expiry kills every process still attributable to the
  run, and no attributable process is alive 3 s after the deadline on a machine that is not
  saturated by normal-priority load. Attributable means:
  - on POSIX, a member of the run's process group;
  - on Windows, a descendant reachable from the live direct child or, once the direct child has
    exited, a child it created during its lifetime and that child's live tree, found by the
    creation-time sweep.

  `timedOut: true` means the deadline or abort fired while something still held the run, so a kill
  was attempted; it does not prove that anything was killed. A case that cannot be told apart counts
  as a kill (fail-closed): on Windows, the grace settling the run while a sweep that pinned trees is
  still reporting, even if the leftover exited on its own (QA-1.2-28).

  Known limits, each still bounded by the 2 s grace for the run and its slot:
  - (a) a descendant whose parent died before the kill (Windows; for example an MSYS `sleep.exe`
    started by a git filter, which escaped `taskkill /T`) or that left the process group with
    `setsid` (POSIX) is not killed;
  - (b) the Windows sweep needs Windows PowerShell 5.1 in FullLanguage mode; where PowerShell is
    blocked or under Constrained Language Mode it kills nothing (reported on stderr);
  - (c) under normal-priority CPU saturation the Windows sweep can finish after 3 s: it may complete
    up to 60 s after the kill request (`SWEEP_TIMEOUT_MS`, QA-3.1-19), and host exit's `taskkill`
    can be cut at its limit;
  - (d) on Windows, opencode's exit reaches in-flight descendants only through the exit hook; death
    by an unhandled signal skips that hook on every platform.

  Proven by 1.2, the 2.1 deadline and native-`task` tests, the 2.4 `router_verify` deadline test,
  and 3.1.2.d. *Amended during implementation (phase-1.2.md round 2, QA-1.2-14, -21, -28;
  QA-3.1-19):* the original text claimed "kills the whole process tree; no orphans after 3 s".
- **G5 — Safe cleanup.** No reference worktree survives a run or a crash (GC). No cleanup path
  touches real `node_modules` or user files. Proven by 1.5 and 3.1.2.e.
- **G6 — Compatibility.** Existing configs load unchanged; the deprecated keys work with a warning;
  `testScope: "full"` restores full-suite semantics (still resource-bounded);
  `defaultVerify: "required"` restores synchronous gating for every `testsPass` delegation; `npm test`,
  typecheck, smoke-keyless, CodeQL and GitGuardian are green on ubuntu/windows × Node 20/22/24.
  *Amended during implementation (QA-3.1-23):* this repository has no CodeQL workflow; the
  security gates are GitGuardian and the GitHub Advanced Security PR check, whose 'Code scanning
  AI findings' job fails on infrastructure (CAPIError 400), not on code. Enabling CodeQL default
  setup is an owner repo-settings decision.
- **G7 — Speed first, zero idle cost.** With the default config:
  - verification adds **0 ms** to the time a delegation's result reaches the orchestrator;
  - the dispatch waits at most `VERIFY_WAIT` (default 5 s) for the git-only reference capture;
  - **no verification process is spawned** unless a dispatch says `VERIFY:required`, the orchestrator
    calls `router_verify`, or `background: true` is configured.

  Proven by the 2.4 tests and 3.1.2.f. *Amended during implementation (QA-G-4, owner decision;
  QA-G-1):* the exception is a DoD **without** `testsPass`. It keeps the synchronous gate, and its
  checks (a build, lint or `run` command, or the grader) run before return, as they did before this
  plan (§1.5-15).
  A DoD containing `testsPass` spawns nothing before return, also when the producer changed nothing:
  it defers as a whole with risk `low`. The one non-deferred case is a `testsPass`-only DoD whose
  producer provably changed nothing; its required gate passes with no process ("no changed files").
  Proven by the QA-G-1 tests in `test/integration/deferred-verification.test.ts` on both dispatch
  paths.
- **G8 — The orchestrator is in control and informed.** Per dispatch, the orchestrator chooses the
  mode and the wait. Every deferred result carries a deterministic risk level and a handle, and
  unverified delegations stay listed in its prompt until verified or expired. A subagent can never
  change its own verification mode. Proven by the 1.6, 2.4 and 3.1.2.g tests.

### 4.2 Global Definition of Done

- [ ] All phases meet their DoD; every phase QA report and `global.md` show zero open findings.
- [ ] G1–G8 are demonstrated by tests that run in CI on both OSes.
- [ ] Coverage is ≥ 90% lines and branches for `src/verify/{exec,runner,slot,reference,batch,directives,risk,pending}.ts`,
      enforced in `D:\git\opencode-model-router\vitest.config.ts` on the Windows + Linux merged
      coverage report (3.1.3).
- [ ] The executing session never saturated the machine: the run log records that every full run
      of this repo's suite was capped and serialized (§0.6.7).
- [ ] Docs, ADR 0003, CHANGELOG and the protocol text describe the shipped behaviour exactly.
- [ ] `1.15.0` is published with provenance; the main checkout is synced; no temporary worktrees or
      branches remain.
- [ ] Final report to the human: what shipped, the G1–G8 evidence (the CI links and measured peak
      process counts), the known limits (runners without scoping → `unverifiable`), and the
      reminder to restart the opencode sessions.

### 4.3 Global QA

Phase 3.2 is the global senior QA review: `[tier:heavy]`, adversarial, with every finding fixed and
re-reviewed until clean. The global DoD cannot be ticked before it closes.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Related-test detection misses a dependency (dynamic imports, config-driven tests), so an introduced failure goes unseen | Accepted by design: CI runs the full suite (S6). The ADR states it; `testScope: "full"` is the opt-in for repos that need it. The 3.1 fixtures include one dynamic-import case to document the behaviour. |
| Reference worktree differs from the dispatch tree (ignored generated files, env) | The exact/approximate flag; collection errors at the reference → `unverifiable`, never an excuse (§1.5-7, §1.5-8). |
| Windows junction cleanup deletes real `node_modules` | Spike D gate, a code-level ban on unsafe methods, sentinel-file tests on real junctions, and a heavy QA focus in 1.5 and 3.2. |
| Cross-process lock left behind by a crash blocks verification | Stale detection by PID, hostname and age; compare-before-delete; the busy result after `slotWaitMs` is `unverifiable`, never a hang. |
| Runner CLI differences across versions | Spike C pins the behaviour; the reporter-file parsing falls back to text; an unknown shape → `unverifiable`. |
| Deferred-by-default lets the orchestrator build on broken work (the "instructed models false-finish" risk from the router's own motivation) | The owner's explicit trade-off (§1.1), stated in the ADR and CHANGELOG. Mitigated by the risk level on every deferred result, the pending list in the prompt, `router_verify`, `VERIFY:required` for fundamental work, `defaultVerify: "required"` and `background: true` as opt-ins, and CI as the final gate. |
| A descendant escapes the deadline kill: its parent died first (Windows), it called `setsid` (POSIX), PowerShell is blocked or under Constrained Language Mode, normal-priority load starves the Windows sweep, or opencode dies by an unhandled signal (the exit hook is skipped) | *Amended during implementation (phase-1.2.md round 2).* The run and its slot are released 2 s after the deadline anyway (force-closed pipes, `timedOut: true` and a stderr note). POSIX process groups and pinned Windows trees are killed, and Node-forked workers die with their parent (libuv job). On Windows, host exit reaches descendants only through the exit hook. Verification descendants run below normal priority, so a survivor cannot starve the machine. Under load the Windows sweep may complete up to 60 s after the kill request (`SWEEP_TIMEOUT_MS`, QA-3.1-19). The sweep's own failure is reported on stderr (QA-1.2-15). 3.1.2.d asserts the 3 s no-orphans rule for an attributable tree. |
| The executing session's own plugin runs full suites during execution | Phase 0.P syncs to `1.14.0`; §0.5 forbids `check: testsPass` in dispatches until `1.15.0`. |

## 6. Out of scope

- Remote or containerized verification.
- Caching test results across sessions.
- Scoping for runners other than vitest, jest, pytest and eslint: they return `unverifiable` with a reason naming the runner.
- Changing the escalation ladder, grader policy or DoD inference rules, beyond consuming the new verdicts.
