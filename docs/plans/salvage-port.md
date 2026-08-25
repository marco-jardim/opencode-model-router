# Plan: Salvage Port — Fable 5 Work into the Post-1.5.0 Line

**Status:** COMPLETE — executed 2026-08-18, released as npm 1.6.0 (tag `v1.6.0`, SLSA/Trusted Publishing). Final commit range: `f55c46d..f89e752` (Waves 0–4; 55 commits incl. third-party merges #26/#27/#28). No phase abandoned. Deviations from spec recorded in phase QA: P6 unknown-style handling ships throw-at-load + runtime auto-rule degradation instead of the plan's warn+prescriptive fallback (stricter, internally consistent); P7's `task_id` framing was aspirational — resume is same-session same-tier re-registration, as salvaged. Rejected list fully honored (`activePreset` stays `anthropic`, mode stays `advisory`, no lessons/memory code). Residual QA findings filed as issue #30. `salvage-local-work` untouched. Suite 918 → 1200 tests / 61 files.
**Author:** marco-jardim
**Created:** 2026-08-18
**Revised:** 2026-08-18 (post-review: reconnaissance wave, QA protocol, ownership enforcement, abandonment criteria)
**Target branch:** `master` (currently `3c8f77b`, npm 1.5.0, 918 tests / 42 files)
**Source branch:** `salvage-local-work` (`eec22f9`, 61 unpushed commits, 77 files, +7142/−238)
**Merge base:** `b8bef975bdf23e41d90ce2b82944c5e9be231fde`

---

## Execution Directives (READ FIRST — BINDING)

1. **Do not merge `salvage-local-work`.** This is a selective port, feature by feature. A 61-commit merge with nine conflicting files is unreviewable, and roughly a third of the branch is work this plan deliberately rejects.

2. **Run the waves back to back without pausing for approval.** Finish a wave, run its QA review, apply the fixes the protocol requires, start the next wave. Do not stop to report progress or ask whether to continue.

3. **Stop and ask a human only for:**
   - **Genuine ambiguity** — two defensible readings with materially different outcomes.
   - **A blocking problem** — CI red for a cause not fixable inside the phase; a conflict with a third-party PR in flight; anything that would change a published default; suspected data loss.
   - **Scope growth** — a phase needs work this plan did not anticipate and cannot absorb without touching a file another phase owns.
   - **An expired external dependency** — see the Wave 3 gate timeout.

   A failing test you just wrote is not a blocker; it is the phase not being done.

4. **Commit often.** One commit per task, not per phase. Every commit leaves `master` green — `npm test` and `npm run typecheck` both pass before pushing. Never push red and fix forward.

5. **`git show salvage-local-work:<path>` is the reference, not the source of truth.** Port intent and tests; re-derive integration against today's code. `protocol.ts` was rewritten by #21, `config.ts` grew the JSONC overrides in #22, `index.ts` gained session cleanup in `40c9b94` and a bounded config walk in `8710a84`.

6. **Never regenerate a golden snapshot to make a test pass without reading the diff.** If a snapshot moved, the emitted prompt moved. Confirm that was intended before accepting with `npx vitest run -u`.

7. **This plan file is immutable during execution.** Do not tick its checkboxes, do not annotate it, do not record progress in it. It would become a file written by several agents at once, violating the ownership rule below. Progress lives in commits and in the session's todo list. The only permitted edit is Phase 9's final disposition.

8. **Every dispatch carries its environment.** Each subagent prompt must state the working directory, platform and shell explicitly, plus the paths that dispatch owns. Subagents inherit nothing. A dispatch without an environment block is malformed — reissue it.

9. **Never resume a subagent across a phase boundary.** A resumed session carries frozen context from when it was created and will report stale state confidently. Within a phase, resuming is fine. Across phases, always dispatch fresh.

10. **Budget.** Each phase has a dispatch ceiling. Exceeding it is a signal the phase is mis-scoped — stop and re-plan the phase rather than continuing to spend. Ceilings are stated per phase.

11. **Declare your working directory.** If the work happens anywhere other than the repository's base directory, the handover must state **both** paths — base and working — and every dispatch must carry the working one. Mixing them is not a theoretical hazard: during the session that produced this plan, roughly a dozen acceptance checks failed spuriously because the verifier ran in the base directory while the work happened in a separate clone. See the Working Directory section below before starting.

---

## Working Directory

**Base repository:** `D:\git\opencode-model-router`
**Working directory for this plan:** `D:\git\opencode-model-router` — the same. No worktree, no separate clone.

That equality is deliberate and worth preserving. The acceptance verifier runs in the process's current working directory. When work happens elsewhere, the verifier reads the wrong tree: it looks for commits that exist only in the other clone, finds none, and rejects correct work. That produced about a dozen false rejections in the session before this one, until the base clone was cleaned and the two were unified.

**If you must use a git worktree or a separate clone** — for an experiment, a conflicting checkout, or parallel branches — then:

- State **both** paths at the top of the handover: base directory and working directory.
- Put the working directory in the environment block of **every** dispatch (Directive 8).
- Expect acceptance checks to fail spuriously, and verify against the remote with `gh api` rather than trusting the local verdict.
- Never leave scratch files in the base directory. The previous session found ten stray `pr22*.json`-style artefacts there, written by subagents that had been told not to touch it.

Platform: `win32`. Shell: `pwsh`. Paths in dispatches use backslashes; most git and npm commands accept forward slashes, but do not mix the two inside one path.

---

## Context: Why This Plan Exists

On 2026-08-18 a cleanup of the working clone revealed that `D:\git\opencode-model-router` held 61 commits from 2026-06-12 to 2026-07-16 that were never pushed. They were preserved on `salvage-local-work` before the reset. The branch implements a 7-phase plan (`docs/plans/fable5-guidance-improvements.md`) adding per-tier effort, goal-oriented prompts, a lessons memory store, session resume, store eviction, workspace-root resolution and a hardened acceptance gate.

None of it is on `master` — `git ls-tree -r master` has zero matches for `memory/lessons`, `prompt-style`, `fable-effort`, `resume`, `idle-sweep` or `workspace`.

`master` went elsewhere over the same period: CI, dependency management, releases 1.3.1 → 1.5.0, a protocol rewrite that halved its size (#21), a Layer-2 grading skip (#20), a JSONC override system (#22), child-session cleanup (`40c9b94`) and a bounded project-config search (`8710a84`).

**The two lines are not compatible by default.** Several salvage features add clauses to a protocol that was just cut in half. This plan ports what still earns its place.

---

## Scope

### Ports

| # | Feature | Source | Wave |
|---|---------|--------|------|
| S1 | Verification path scoping | `src/verify/paths.ts` | 1 |
| S2 | Idle-TTL store eviction | `src/router/idle-sweep.ts` | 1 |
| S3 | Progress-claim grounding clause | `tiers.json` `tierPrompts` | 1 |
| S4 | `enforcement` block shipped in `tiers.json` | `tiers.json` | 1 |
| S5 | Delegate + grader prompt time-box | `src/index.ts` | 2 |
| S6 | Per-tier `effort` + `fable-effort` preset | `src/router/agent-options.ts` | 3 |
| S7 | Goal-oriented prompt styles | `src/router/prompts.ts` | 3 |
| S8 | Session resume via `task_id` | `src/router/sessions.ts`, `src/guard/store.ts` | 3 |

### Does not port

| Feature | Reason |
|---------|--------|
| Lessons memory store (~800 lines) | Adds protocol tokens immediately after #21 cut 52%; writes into the user's workspace; effectiveness never measured. Revisit as opt-in, default `false`, after Wave 4. |
| Anti-context-anxiety clause (I7) | Re-adds prose #21 deliberately removed. Direction conflict, not text conflict. |
| INTENT dispatch section (I8) | Same. |
| Workspace-root protocol line (I9) | Per-message token cost for on-demand information. The `workspace.ts` module ports if a phase needs it; the protocol line does not. |
| `activePreset: "opus"` | Changes the default preset for every existing user, and **git automerges it with no conflict marker**. Guarded by R1. |
| `src/guard/smoke-evidence.ts` | Test-support only. Optional, Wave 4. |

---

## Parallelism & File Ownership

1. **A file has exactly one owning phase per wave.** The owner is the only agent permitted to write it. Ownership is declared in the phase header and in the Wave 0 manifest.

2. **Do not read a file another agent is currently writing.** Either wait for that phase to commit, or serialise the two phases. There is no third option.

3. **`src/index.ts` is a mutually exclusive resource.** At most one phase per wave modifies it, and that phase runs **last**, after every concurrent phase has committed. It is the largest conflict surface with bucket (c).

4. **Golden snapshots are regenerated once per wave**, at the serialisation point, by a single agent — never mid-wave by two phases.

5. **Ownership is verified mechanically, not promised.** Every phase's DoD includes:
   ```
   git diff --name-only <phase-base>..HEAD
   ```
   The result must be a subset of the phase's declared owned paths. A file outside the set means the phase failed, regardless of whether tests pass. This check is not optional and is not satisfied by assertion.

6. **Dispatch pattern.** Read-only exploration → `@fast`, in parallel, several per message. Implementation → `@medium`, one agent per owned file set. QA review → `@heavy`, single-threaded, after the phase's commits land.

---

## Pre-Flight Protocol

**Every phase runs a pre-flight check before its first implementation task.** Wave 0 answers the questions that decide the *shape* of the waves; a phase's own pre-flight answers the questions that decide how that phase is *built*, against the tree as it stands the moment the phase starts. Both are needed — Wave 0's findings age as commits land.

A pre-flight is `[tier:fast]`, read-only, and produces findings, not edits.

**What to do with what it finds:**

- **Fixable inside this phase's owned paths** — fix it, in this phase, before or alongside the tasks. Do not carry a known defect forward and do not file an issue for something you are already standing in front of.
- **Belongs to a later phase in this plan** — document it. Write it into the phase's summary commit message, naming the phase that owns it. Do not fix it; that is how parallel work gets corrupted. The owning phase's pre-flight will surface it again with the file in hand.
- **Belongs to no phase in this plan** — file a GitHub issue with the evidence, and continue. The plan does not expand to absorb every defect the repository contains.
- **Invalidates the phase** — check the phase's Abandonment Criteria. If they are met, abandon; if they are not but the phase can no longer be built as written, that is scope growth under Directive 3: stop and ask.

A pre-flight that reports "nothing found" on a phase touching code written months ago is more likely to be an incurious pre-flight than a clean tree. Say what was checked, not only what was found.

---

## QA Review Protocol

**Every phase ends with an adversarial senior review at `[tier:heavy]`, and every defect it finds inside that phase's owned paths gets fixed before the phase closes.** A phase whose review found problems and left them unfixed is not done. The default is to fix; the exceptions below are narrow and each requires a written reason.

Written this way because "fix everything the review raises" and "write only your owned files" are contradictory orders unless the collision is resolved in advance.

**Reviewer is never the producer.** The agent that implemented a phase does not review it. The agent that reviews does not apply the fixes. Producer and grader are separate dispatches with separate context.

**Findings are triaged into three buckets:**

- **In-scope** — the defect is in a file this phase owns. Fix it now, in this phase.
- **Out-of-scope** — the defect is real but lives in a file another phase owns, or in code no phase in this plan touches. **Do not fix it.** Record it: file a GitHub issue with the reviewer's evidence, and if the owner is a later phase in this plan, note it so that phase picks it up. Fixing it in place is what corrupts parallel work.
- **Rejected** — the reviewer is wrong, or the finding is a preference rather than a defect. Write down why, in one sentence, and move on. A reviewer being unconvinced is not by itself a defect.

**Two rounds, then stop.** A phase gets at most two review→fix→re-review cycles. Anything the second re-review still raises is filed as an issue with its severity, and the phase closes. An adversarial reviewer will always find something; the loop needs a floor or it does not terminate.

**Escalation.** If the second re-review raises something the reviewer marks as *critical* — data loss, a changed public default, a security boundary — that is a blocking problem under Directive 3. Stop and ask.

---

## Red-Green Protocol

Every phase must demonstrate that its new tests actually detect the regression they claim to. The mechanism is prescribed, not left to judgement, because an unattended revert has already corrupted a file in this repository's history.

```bash
# 1. New tests are written and passing against the new code.
npx vitest run <test-file>

# 2. Park ONLY the source change. Never edit the file to revert it.
git stash push -- <source-path>

# 3. The new test MUST now fail. Capture the failure verbatim.
npx vitest run <test-file>

# 4. Restore.
git stash pop

# 5. Green again.
npx vitest run <test-file>
```

Rules: use `git stash push -- <path>`, never a manual edit — the Edit tool has accepted a non-matching `oldString` and reported success. A test that passes in step 3 is vacuous; either it tests nothing, or it tests something the old code already did. Both are defects. Guard tests that legitimately pass in both states are permitted, but must be labelled as guards, not counted as regression detectors.

---

## Abandonment & Rollback

**Abandonment.** Every phase states conditions under which it is dropped rather than forced. A plan that assumes everything in scope ships will ship something that should not have. When a phase is abandoned: revert its commits, record the reason in the Wave's summary commit, and continue. Abandoning a phase is a success of the process, not a failure of it.

**Rollback.** Each phase is a contiguous commit range and every commit in it is green, so `git revert <first>..<last>` is always safe. A phase that is discovered to be bad after its wave closes is reverted as a unit — not patched forward — unless the fix is smaller than the revert.

**Never rewrite pushed history.** No force-push, no amend of anything already on `origin/master`.

---

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| R1 | `activePreset: "opus"` arrives via a clean automerge | Medium | High — every user's preset changes silently | Wave 0 records the current value; Phase 3 pre-flight greps for it; global DoD asserts it is unchanged from `3c8f77b` |
| R2 | Wave 3 collides with bucket (c) | High if run early | High — kills a third-party PR | Hard gate with timeout, below |
| R3 | Snapshot regeneration masks an unintended prompt change | Medium | Medium — silent behaviour drift | Directive 6; every snapshot hunk explained in the wave's QA review |
| R4 | Ported tests pass vacuously | Medium | High — false confidence | Red-Green Protocol, mandatory per phase |
| R5 | `enforcement` block flips a default | Medium | High — graders start hard-blocking | Phase 3 ships `advisory`; behavioural-invariance test is the phase's central assertion |
| R6 | `effort` breaks providers rejecting unknown options | Low | Medium | Phase 5 asserts the key is omitted entirely when unset — the PR #19 lesson |
| R7 | The lessons store arrives transitively | Low | Medium | No ported module may import `src/memory/`; global DoD greps for it |
| R8 | A phase writes outside its owned paths | Medium | High — corrupts parallel work | Mechanical ownership check in every phase DoD |
| R9 | QA loop fails to terminate | Medium | Medium — unbounded cost | Two-round cap in the QA Review Protocol |

---

# WAVE 0 — Reconnaissance

**Why this exists:** the first draft of this plan put a pre-flight inside each phase, each with a gate that could defer its integration to a later wave. Two such gates firing together would have left Wave 1 delivering modules nothing calls — while the global DoD forbids exactly that. Reconnaissance is therefore hoisted out of the phases and run once, up front, before any implementation is dispatched.

**Concurrency:** every task below is read-only and independent. Dispatch them **all in parallel, in a single message**. This is the cheapest wave and it determines the shape of every wave after it.

**Dispatch ceiling:** 6.

### Tasks

- **T0.1** `[tier:fast]` Read `git show salvage-local-work:src/verify/paths.ts`. Determine whether the producer's working directory is reachable at check time **without** modifying `index.ts`. Report the exact call path.
- **T0.2** `[tier:fast]` Enumerate every `sessionID`-keyed store on `master`: name, file, whether anything deletes from it today, and whether `40c9b94`'s disposal already covers it. Identify a hook that can drive an opportunistic sweep, and state whether it lives in `index.ts`.
- **T0.3** `[tier:fast]` Record `master`'s current `activePreset` value verbatim (R1). Confirm `tiers.json` has no top-level `enforcement` key. List every `enforcement` field `config.ts` reads today with the default it applies.
- **T0.4** `[tier:fast]` Read the `master` delegate loop after `40c9b94`. Identify precisely where a timeout must wrap, and how an aborted prompt interacts with `disposeChildSession`.
- **T0.5** `[tier:fast]` Check the PR queue: is bucket (c) open, merged, or unopened? Record the answer with a date.
- **T0.6** `[tier:fast]` Confirm `src/guard/store.ts`, `src/router/sessions.ts`, `src/verify/deterministic.ts` and `src/verify/checker.ts` are unmodified by `master` since the merge base.

### Output — the Wave Manifest

Wave 0 produces one artefact, committed as `docs/plans/salvage-port-manifest.md`:

- For each of Phases 1–4: the **final** owned-path list, and whether it touches `index.ts`.
- Which Wave 1 phases can genuinely run in parallel, given the above.
- Where any deferred integration lands.
- The recorded `activePreset` value, for the global DoD to assert against.
- Bucket (c)'s status and the date checked.

**If reconnaissance shows that both S1 and S2 need `index.ts`,** restructure Wave 1 as: two phases landing pure modules with unit tests (explicitly permitted to have no caller until Wave 2), and Wave 2 absorbing both integrations plus the time-box. Record that decision in the manifest. **Do not ask** — this contingency is pre-authorised.

### Acceptance Criteria (W0)

```
[acceptance]
check: fileExists path=docs/plans/salvage-port-manifest.md
criteria: The manifest states final owned paths for every phase in Waves 1 and 2, names which phases may run concurrently, records master's current activePreset verbatim, and records bucket (c)'s status with the date it was checked.
deliverable: docs/plans/salvage-port-manifest.md committed to master.
[/acceptance]
```

### Definition of Done (W0)

- [ ] All six tasks reported.
- [ ] Manifest committed; CI green (docs-only, no test change expected).
- [ ] No source file modified in this wave.
- [ ] `activePreset` recorded verbatim.

---

# WAVE 1 — Zero-Conflict Corrections

**Goal:** land everything that touches no file bucket (c) will rewrite.

**Concurrency:** as determined by the Wave 0 manifest. Default assumption — Phases 1, 2 and 3 dispatch simultaneously; none owns `index.ts`.

---

## Phase 1 — Verification Path Scoping

**Owned paths:** `src/verify/paths.ts`, `src/verify/deterministic.ts`, `src/verify/checker.ts`, `test/unit/cwd-scoping.test.ts` *(final list per manifest)*
**Dispatch ceiling:** 8.

**Why:** deterministic DoD checks resolve relative paths against the *router's* cwd, not the producer subagent's. A `check: fileExists path=src/foo.ts` against a subagent working elsewhere silently checks the wrong file.

**Success signal** — how we know this was worth doing, beyond "tests pass": a check written against a subagent's own tree resolves correctly where it previously resolved against the router's tree. Demonstrate with one concrete before/after case in the phase's final commit message.

### Pre-Flight (P1) `[tier:fast]`

- [ ] Re-read the Wave 0 manifest entry for this phase; confirm the owned-path list still holds.
- [ ] Read `src/verify/deterministic.ts` and `src/verify/checker.ts` as they stand now. Where exactly does each relative path get resolved today, and against what?
- [ ] Does any existing test assert the *current* (router-cwd) resolution? If so, it will need updating, and that update must be justified rather than silently applied — a test asserting the bug is still a test.
- [ ] Does the salvage `paths.ts` import anything that no longer exists?

Handle findings per the Pre-Flight Protocol.

### Tasks

- **T1.1** `[tier:medium]` Port `resolveBaseDir(cwd, routerDir)` and `resolveAgainst(baseDir, p)`. Keep the purity contract: path math only, no `fs`, no `exec`, no network. Preserve the explanatory comment.
- **T1.2** `[tier:medium]` Port `test/unit/cwd-scoping.test.ts` and adapt to today's layout.
- **T1.3** `[tier:medium]` Wire `resolveAgainst` into the deterministic `fileExists` and `run` checks — only if the manifest says this is reachable without `index.ts`.
- **T1.4** `[tier:fast]` Commit each task separately.

### New Tests (P1)

- `resolveBaseDir` returns the router dir when cwd is `undefined`, empty, or whitespace.
- `resolveBaseDir` prefers the producer cwd when both are present.
- `resolveAgainst` leaves an absolute path untouched — POSIX **and** Windows drive-letter forms.
- `resolveAgainst` joins a relative path onto the base dir.
- `..` traversal behaves as documented; the test states what the intended behaviour is rather than pinning whatever happens.
- **Edge:** a UNC path (`\\server\share\x`) is not mangled.
- **Edge:** a path containing spaces round-trips.
- **Edge:** empty string as `p` — assert the intended behaviour explicitly.
- **Cross-platform:** passes on `ubuntu-latest` and `windows-latest`. No hardcoded `/` in assertions.

### Acceptance Criteria (P1)

```
[acceptance]
check: testsPass
check: buildPasses
check: fileExists path=src/verify/paths.ts
check: fileExists path=test/unit/cwd-scoping.test.ts
criteria: Deterministic checks resolve relative paths against the producer's working directory when known and the router directory otherwise; paths.ts performs no I/O.
deliverable: src/verify/paths.ts plus tests, committed with CI green on all six matrix jobs.
[/acceptance]
```

### Definition of Done (P1)

- [ ] All tasks committed, each commit green.
- [ ] Red-Green Protocol executed; step-3 failure pasted verbatim.
- [ ] **Ownership check:** `git diff --name-only <phase-base>..HEAD` ⊆ owned paths.
- [ ] `grep -r "memory/lessons" src/` returns nothing (R7).
- [ ] Success signal demonstrated in the final commit message.
- [ ] `npm run typecheck` exit 0; CI green on all six matrix jobs.

### Abandonment Criteria (P1)

Drop the phase if the producer's working directory turns out not to be knowable at check time even with `index.ts` changes — the feature has no foundation and a partial version would resolve against a plausible-looking wrong directory, which is worse than today's honest wrong directory.

### Senior QA Review (P1) `[tier:heavy]`

Reviewer must not be the implementing agent.

- Does `paths.ts` genuinely perform no I/O? Grep for `fs`, `child_process`, `net`.
- Verify the red-green evidence rather than trusting it. Re-run step 3 independently.
- Does resolution behave identically on win32 and POSIX, or do the tests encode only the host that ran them?
- Traversal hazard: can a crafted `path=` in an `[acceptance]` block reach outside the intended tree, and does that matter under this threat model?
- Ownership: did the phase write anything outside its declared paths?

Triage findings per the QA Review Protocol. Two rounds maximum.

---

## Phase 2 — Idle-TTL Store Eviction

**Owned paths:** `src/router/idle-sweep.ts`, `src/guard/store.ts`, `src/router/sessions.ts`, `test/unit/store-eviction.test.ts` *(final list per manifest)*
**Dispatch ceiling:** 8.

**Why:** every `sessionID`-keyed store grows unbounded for the process lifetime. This is a leak, not a feature.

**Success signal:** insert N entries, sweep, and show the store returns to its expected size — the leak is closed, not deferred.

### Pre-Flight (P2) `[tier:fast]`

- [ ] Re-read the Wave 0 store inventory; confirm nothing landed since that changes it.
- [ ] For each store in scope: does it already have a `touch()` or last-access timestamp, or must one be added? Adding one changes every write path — size that before starting.
- [ ] Confirm `40c9b94`'s `disposeChildSession` and a TTL sweep cannot double-delete. If they can, that interaction is this phase's problem, not a later one.
- [ ] Identify the hook that will drive the sweep and confirm it fires often enough to matter but not so often that the throttle is doing all the work.

Handle findings per the Pre-Flight Protocol.

### Tasks

- **T2.1** `[tier:medium]` Port `idle-sweep.ts`: `DEFAULT_IDLE_TTL_MS` (1h), `IDLE_SWEEP_THROTTLE_MS` (5min), `createIdleTtlSweeper`. No timers — opportunistic invocation only.
- **T2.2** `[tier:medium]` Add `sweepIdle(nowMs, ttlMs)` to each store the manifest identifies as lacking one, plus `touch()` on access.
- **T2.3** `[tier:medium]` Port `test/unit/store-eviction.test.ts`.
- **T2.4** `[tier:fast]` Commit each task separately.

### New Tests (P2)

- A sweep evicts an entry older than the TTL; retains one inside it.
- `touch()` refreshes the deadline and prevents the next sweep from evicting.
- The throttle throttles: two calls inside `throttleMs` run the sweepers **once**.
- The throttle releases after `throttleMs`.
- A throwing sweeper does not prevent the others running and does not propagate.
- **Edge:** empty store sweeps without error.
- **Edge:** clock skew — a future `lastTouched` is not evicted and does not throw.
- **Edge:** churn bound — the success-signal test above.
- **Interaction:** a session disposed by `40c9b94`'s path and then swept does not double-delete or throw.

### Acceptance Criteria (P2)

```
[acceptance]
check: testsPass
check: buildPasses
check: fileExists path=src/router/idle-sweep.ts
check: fileExists path=test/unit/store-eviction.test.ts
criteria: Every sessionID-keyed store can evict idle entries; the sweeper is throttled, never timer-scheduled, and a throwing sweeper cannot break the others.
deliverable: idle-sweep.ts plus store support and tests, committed with CI green.
[/acceptance]
```

### Definition of Done (P2)

- [ ] All tasks committed, each commit green.
- [ ] Every store from the manifest either sweeps or has a written reason it need not.
- [ ] Red-Green Protocol executed for eviction and throttle.
- [ ] **Ownership check** passes.
- [ ] No `setInterval`/`setTimeout` introduced.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P2)

Drop if the manifest shows `40c9b94`'s disposal already covers every store on every path — the leak would already be closed and this would be redundant machinery.

### Senior QA Review (P2) `[tier:heavy]`

- Independently enumerate `sessionID`-keyed maps and compare against the phase's list. Is the leak closed, or only for the stores it remembered?
- Can the sweeper evict a live session? Trace touch points — an entry touched only at creation and swept at 1h would kill a long-running delegation.
- Is the throttle monotonic, or vulnerable to system clock changes?
- Does anything now depend on sweep ordering?
- Ownership check.

Triage per protocol. Two rounds maximum.

---

## Phase 3 — Prompt Grounding and Shipped `enforcement` Block

**Owned paths:** `tiers.json`, `src/router/config.ts`, `docs/CONFIG_REFERENCE.md`, `test/unit/config.validate.test.ts`
**Dispatch ceiling:** 10.

**Two independent changes share this phase because they share one file — not because they are related.** They are implemented as two separable commit groups, 3A and 3B, each with its own tests and its own revert path. **If 3B fails QA, 3A still ships.** Do not let the coupling of the file become a coupling of the decisions.

**3A — Grounding clause.** Attacks progress-narration by prevention in the subagent prompt, which is strictly better than the detector #21 disabled for false positives.
**Success signal:** the clause appears in the medium/heavy assembled prompts, and the character cost is measured and stated.

**3B — Shipped `enforcement` block.** `tiers.json` ships no `enforcement` today; that absence is the root of the PR #19 impasse, because the documented `graderTemperature` default of `0` exists only as a `?? 0` in code.
**Success signal:** the effective config is byte-identical before and after — the block documents reality rather than changing it.

### Pre-Flight (P3) `[tier:fast]`

- [ ] Re-read the Wave 0 record of `activePreset` and of every `enforcement` default `config.ts` applies today (R1).
- [ ] For each field 3B intends to ship: establish its current effective default **from the code**, not from the documentation. Where the two disagree, the code wins and the docs are wrong — record which.
- [ ] Measure the character cost of the 3A grounding clause per tier prompt now, so the abandonment threshold can be evaluated rather than guessed.
- [ ] Confirm the override deep-merge (#22) handles a partial `enforcement` object without wiping siblings. If it does not, that is a defect in a file this phase owns — fix it here.

Handle findings per the Pre-Flight Protocol.

### Tasks — 3A

- **T3A.1** `[tier:medium]` Append the grounding clause to the `medium` and `heavy` tier prompts. Leave `fast` unless the manifest says otherwise.
- **T3A.2** `[tier:medium]` Golden coverage for its presence and absence.
- **T3A.3** `[tier:fast]` Commit.

### Tasks — 3B

- **T3B.1** `[tier:medium]` Add the `enforcement` block with **`mode: "advisory"`** and every other field set to the current effective default recorded in the Wave 0 manifest.
- **T3B.2** `[tier:medium]` Extend `validateConfig` to validate the block's shape, following the existing per-section validator style and reusing the fail-soft path.
- **T3B.3** `[tier:medium]` Document every shipped field in `CONFIG_REFERENCE.md`, including that `mode` defaults to `advisory` and what `enforced` would change.
- **T3B.4** `[tier:fast]` Commit each task separately.

**Gate on 3B:** if any shipped value would differ from the current effective default, **do not ship that field.** A block that silently changes behaviour is a blocker under Directive 3.

### New Tests (P3)

- **3B central:** the effective config resolved from the shipped block is deep-equal, field by field, to the effective config resolved before it existed.
- `mode` is `advisory` in the bundled file — asserted, so a future edit to `enforced` fails CI.
- `activePreset` equals the value the manifest recorded — asserted (R1).
- `validateConfig` rejects a malformed block with a message naming the offending field.
- An override may set individual `enforcement` fields; the deep merge preserves siblings.
- **Edge:** an unknown `enforcement.mode` is rejected, not silently accepted.
- **Edge:** `enforcement: {}` in an override does not wipe the bundled defaults.
- **3A golden:** the assembled prompt for `medium` and `heavy` contains the clause; `fast` does not.

### Acceptance Criteria (P3)

```
[acceptance]
check: testsPass
check: buildPasses
check: fileExists path=docs/CONFIG_REFERENCE.md
criteria: tiers.json ships an enforcement block whose every value equals the previously implicit default, mode is advisory, activePreset is unchanged from the Wave 0 manifest value, and the grounding clause is present in the medium and heavy tier prompts only.
deliverable: tiers.json, config validation, docs and tests, committed as two separably revertable groups.
[/acceptance]
```

### Definition of Done (P3)

- [ ] 3A and 3B committed as distinct, independently revertable groups.
- [ ] Behavioural-invariance test present and passing.
- [ ] `activePreset` assertion present and passing (R1).
- [ ] Goldens regenerated only after reading the diff and confirming the only change is the grounding clause.
- [ ] Character cost of the clause measured and stated in the commit message.
- [ ] **Ownership check** passes.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P3)

Abandon **3B alone** if any field's current effective default cannot be established with certainty — shipping a guess is worse than shipping nothing. Abandon **3A alone** if the measured character cost exceeds ~400 characters per assembled prompt, which would meaningfully erode the #21 saving for a preventive measure of unproven effect.

### Senior QA Review (P3) `[tier:heavy]`

- Diff the effective config before and after, field by field. Any difference is a defect.
- Is `advisory` genuinely the current default, or did the implementer assume it?
- Does the grounding clause read as an instruction a model will follow, or as prose it will skim? Compare against the wording #21 removed — is this re-adding the kind of text just cut?
- Confirm the measured character cost independently.
- Does shipping the block change anything for PR #19? Record the finding for the maintainer as an out-of-scope item; do not act on the PR from inside this phase.
- `activePreset` (R1) and ownership check.

Triage per protocol. Two rounds maximum.

---

## Wave 1 Serialisation Point

Single agent, sequential:

- [ ] `[tier:fast]` Regenerate goldens once if needed. Read the diff; explain every hunk.
- [ ] `[tier:fast]` Full suite and typecheck on a clean clone.
- [ ] `[tier:fast]` Push; confirm CI green on all six matrix jobs.

### Wave 1 Acceptance Criteria

```
[acceptance]
check: testsPass
check: buildPasses
criteria: All Wave 1 phases are merged, CI is green on all six matrix jobs, no phase wrote outside its owned paths, and no behavioural default changed.
deliverable: master advanced, npm version unchanged.
[/acceptance]
```

---

# WAVE 2 — Guarded Integration

**Goal:** the one wave that touches `src/index.ts` before bucket (c). Deliberately small and single-threaded to minimise what Lucas has to carry.

**Concurrency:** none.

---

## Phase 4 — Delegate Time-Box and Deferred Wiring

**Owned paths:** `src/index.ts`, `src/verify/gate.ts`, `src/verify/dispatch.ts`, one new integration test file
**Dispatch ceiling:** 12.

**Why:** if `session.prompt` never returns, the delegate hangs with no ceiling. `40c9b94` made child sessions get disposed; it did not put a clock on them.

**Success signal:** a hung producer returns within the configured ceiling instead of never, and the run ends `status: unmet` rather than fabricating a pass.

### Pre-Flight (P4) `[tier:fast]`

Wave 0 covered most of this. Re-check only what can have changed since:

- [ ] **Bucket (c) status.** If it opened since Wave 0, read its diff and confirm this phase's `index.ts` edits sit outside the extracted region. If they collide, stop and ask.
- [ ] Confirm which Wave 1 wiring was deferred here and fold it into the task list.

### Tasks

- **T4.1** `[tier:medium]` Timeout around the producer `session.prompt`, defaulting to `enforcement.verify.delegateTimeoutMs`, falling back to 600 000 ms.
- **T4.2** `[tier:medium]` Same for the grader dispatch.
- **T4.3** `[tier:medium]` On timeout: abort and dispose via the existing `disposeChildSession`, record an honest `status: unmet`, never fabricate a pass.
- **T4.4** `[tier:medium]` Ship the field in the Phase 3B block; document it.
- **T4.5** `[tier:medium]` Absorb deferred Wave 1 wiring.
- **T4.6** `[tier:fast]` Commit each task separately.

### New Tests (P4)

Use fake timers throughout. A test that depends on real wall-clock timing is flaky by construction and will be rejected.

- A producer prompt that never resolves is cut off and the delegate returns.
- A grader prompt that never resolves is cut off; the gate returns an honest unmet verdict.
- A timed-out session is disposed exactly once — assert `session.abort` and `session.delete` call counts.
- The timeout is configurable and a custom value is honoured.
- A prompt resolving just under the ceiling is **not** cut off.
- **Edge:** a timeout on the last ladder attempt yields `status: unmet`, not a crash.
- **Edge:** the abort does not leak into the parent orchestrator session.
- **Edge:** a timeout of `0` or negative is rejected by validation, not treated as "no timeout".
- **Interaction:** `session-lifecycle.test.ts` passes unmodified.

### Acceptance Criteria (P4)

```
[acceptance]
check: testsPass
check: buildPasses
check: run command="npx vitest run test/integration/session-lifecycle.test.ts" expect=passed
criteria: Producer and grader prompts are time-boxed with a configurable ceiling; a timeout disposes the child session exactly once and produces an honest unmet verdict rather than a fabricated pass.
deliverable: timeout support in src/index.ts with integration coverage, committed with CI green.
[/acceptance]
```

### Definition of Done (P4)

- [ ] All tasks committed, each commit green.
- [ ] Red-Green Protocol executed for the timeout tests.
- [ ] `session-lifecycle.test.ts` unmodified and passing.
- [ ] The `index.ts` diff is minimal — no refactoring, reordering or reformatting, because bucket (c) must carry it.
- [ ] All new timing tests use fake timers.
- [ ] **Ownership check** passes.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P4)

Drop if the SDK offers no way to actually cancel an in-flight prompt. A timeout that stops waiting while the session keeps running and billing is worse than no timeout, because it looks like a ceiling and is not one.

### Senior QA Review (P4) `[tier:heavy]`

- Does the timeout cancel the underlying work, or merely stop waiting for it? This is the abandonment criterion — verify it rather than assuming.
- Is disposal idempotent under a timeout-then-completion race?
- Could 600 s fire during a legitimate heavy-tier task? Is it defensible and documented as configurable where users will look?
- How large is the `index.ts` diff? Every gratuitous line makes bucket (c) harder.
- Are the tests deterministic under fake timers?
- Ownership check.

Triage per protocol. Two rounds maximum.

---

## Wave 2 Serialisation Point

- [ ] `[tier:fast]` Full suite, typecheck, snapshot review, push, CI green.
- [ ] `[tier:fast]` If bucket (c) is open, post a short note on it stating exactly which `index.ts` lines moved and why — the same courtesy already extended for `40c9b94` and `8710a84`.

---

# WAVE 3 — Feature Port

## Gate

**Wave 3 does not begin while bucket (c) is open.**

**Timeout:** if bucket (c) has neither opened nor merged **21 days** after Wave 2 closes, stop and ask the maintainer to choose: proceed without it and accept that Lucas rebases onto the result, or keep waiting. Do not decide this alone, and do not wait indefinitely — an unbounded external dependency is how a plan dies quietly.

**Concurrency:** Phases 5, 6 and 7 own disjoint files and run in parallel, converging at a serialisation point where a single agent applies each wiring into `index.ts` sequentially.

---

## Phase 5 — Per-Tier Effort

**Owned paths:** `src/router/agent-options.ts`, `test/unit/effort.test.ts`, `test/integration/fable-effort-preset.test.ts`, `test/golden/fable-effort-preset.golden.test.ts`, and the `effort` field plus `fable-effort` preset in `tiers.json`
**Dispatch ceiling:** 12.

**Why:** the highest-value feature in the salvage set and the only one nobody else is working on. Reasoning-effort levels are how current frontier models differentiate, and `fable-effort` — one model, three effort levels — is legitimate for anyone with access to a single strong model.

**Success signal:** three agents register on one model with three distinct efforts, and a tier with no `effort` sends no effort key at all.

### Pre-Flight (P5) `[tier:fast]`

- [ ] Confirm bucket (c) merged; read where agent registration now lives.
- [ ] Current registration option shape; where `variant` is handled, since `effort` sits beside it.
- [ ] Provider matrix: which providers accept an effort parameter, under what key, and what happens on an unknown key. **Precedent: PR #19 showed Azure reasoning models reject an explicit `temperature` outright.**
- [ ] What the salvage branch's "empty-thinking conflict fix" was.

### Tasks

- **T5.1** `[tier:medium]` Port `agent-options.ts`: `buildAgentOptions`, effort constants, warn-once dedup.
- **T5.2** `[tier:medium]` Add `effort` to the tier config type and validate it.
- **T5.3** `[tier:medium]` Add the `fable-effort` preset. **Do not change `activePreset`** (R1).
- **T5.4** `[tier:medium]` Port the unit, integration and golden tests.
- **T5.5** `[tier:fast]` Document `effort` in `CONFIG_REFERENCE.md` and `README.md`, including which providers honour it.
- **T5.6** `[tier:fast]` Commit each task separately.

### New Tests (P5)

- A tier with `effort` produces the option in the registration payload.
- **A tier without `effort` omits the key entirely** — not `undefined`, not a default. Assert the actual object, not the type (R6).
- An invalid value warns once and falls back rather than throwing.
- Warn-once dedups across repeated registrations, and is keyed tightly enough not to suppress a different warning.
- `effort` and `variant` coexist without clobbering.
- `fable-effort` registers three agents on one model with three efforts.
- **Edge:** effort on a provider that does not support it — assert the documented behaviour.
- **Edge:** each boundary of the allowed set, plus one outside it.
- **Edge:** an override adding `effort` merges without disturbing siblings.
- **Golden:** the `fable-effort` assembled prompt is pinned.

### Acceptance Criteria (P5)

```
[acceptance]
check: testsPass
check: buildPasses
check: fileExists path=src/router/agent-options.ts
criteria: Per-tier effort resolves into agent registration options, is omitted entirely when unset, warns once and degrades safely when invalid, and fable-effort is selectable without changing the default preset.
deliverable: effort support and the fable-effort preset, documented and tested, committed with CI green.
[/acceptance]
```

### Definition of Done (P5)

- [ ] All tasks committed, each commit green.
- [ ] Omit-when-unset test present and passing (R6).
- [ ] `activePreset` unchanged (R1).
- [ ] Red-Green Protocol executed.
- [ ] Docs state which providers honour `effort`.
- [ ] **Ownership check** passes.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P5)

Drop if the pre-flight finds no provider in the shipped presets that honours an effort parameter — the feature would be configuration with no effect, which is worse than absent because users would configure it and believe it worked.

### Senior QA Review (P5) `[tier:heavy]`

- Is the key omitted when unset, or is `undefined` being serialised? Inspect the actual payload.
- On a provider rejecting unknown options, is the failure loud, silent or fatal? PR #19 is the precedent.
- Does `fable-effort` advertise savings that exist? Check the cost-ratio labelling honestly.
- Is the golden pinning something meaningful, or restating the config?
- Ownership check.

Triage per protocol. Two rounds maximum.

---

## Phase 6 — Goal-Oriented Prompt Styles

**Owned paths:** `src/router/prompts.ts`, `test/unit/prompt-style.test.ts`, `test/unit/guard-style-independence.test.ts`, `test/integration/prompt-style-mixed.test.ts`, `test/golden/prompt-style.golden.test.ts`
**Dispatch ceiling:** 12.

**Why:** tier prompts enumerate stop conditions step by step. Strong models do better with a goal and constraints. Same direction #21 took for the orchestrator protocol, applied one layer down to subagent prompts — complementary, not redundant.

**Success signal:** caps are enforced identically under both styles, proven by test, while the goal-oriented form is measurably shorter.

### Pre-Flight (P6) `[tier:fast]`

- [ ] Read the salvage `prompts.ts` and its docstring in full.
- [ ] Where `tierPrompts` are consumed after bucket (c).
- [ ] Confirm the guard enforces caps from **config**, never from prompt text. The phase depends on this being true.
- [ ] Check the strong-model pattern list against models actually shipped in today's presets. A list naming models nobody uses is dead code.
- [ ] Measure the character delta between the two styles per tier.

### Tasks

- **T6.1** `[tier:medium]` Port `prompts.ts`: `GOAL_ORIENTED_TIER_PROMPTS`, `isStrongModel`, `resolvePromptStyle`, `selectTierPrompt`.
- **T6.2** `[tier:medium]` Add `promptStyle`, `modelGenerations`, `tierPromptsGoalOriented` to the config type and validation.
- **T6.3** `[tier:medium]` Default `promptStyle` to `auto`.
- **T6.4** `[tier:medium]` Port the four test files.
- **T6.5** `[tier:fast]` Document the three styles and the auto-resolution rule.
- **T6.6** `[tier:fast]` Commit each task separately.

### New Tests (P6)

- `auto` resolves goal-oriented for a strong model, prescriptive for a weak one.
- An explicit style overrides `auto` regardless of model.
- **Guard independence:** caps enforced identically under both styles. The safety-critical test of the phase.
- An unknown style falls back to prescriptive with a warning rather than emitting nothing.
- A mixed configuration works.
- **Edge:** empty `modelGenerations.strong` resolves everything prescriptive without crashing.
- **Edge:** a model matching multiple patterns resolves deterministically.
- **Edge:** a tier with no prompt in either style degrades safely.
- **Golden:** both styles pinned per tier.

### Acceptance Criteria (P6)

```
[acceptance]
check: testsPass
check: buildPasses
check: fileExists path=src/router/prompts.ts
criteria: Tier prompts resolve to goal-oriented or prescriptive form by explicit setting or model-strength auto-detection, and runtime guard enforcement is provably identical under both.
deliverable: prompt-style resolution with a guard-independence proof, committed with CI green.
[/acceptance]
```

### Definition of Done (P6)

- [ ] All tasks committed, each commit green.
- [ ] Guard-independence test present and passing.
- [ ] Character delta per tier measured and recorded in the commit message.
- [ ] Red-Green Protocol executed.
- [ ] **Ownership check** passes.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P6)

Drop if the guard turns out to read anything from prompt text — the de-prescription would then be a behaviour change disguised as a wording change, and the phase's central safety claim would be false.

### Senior QA Review (P6) `[tier:heavy]`

- Do goal-oriented prompts preserve every constraint the prescriptive ones encoded? Compare clause by clause.
- Is the strong-model list maintainable, or does it rot the moment a model is renamed — as happened in issue #9?
- Does auto-resolution ever pick goal-oriented for a model that needs steps?
- Is guard independence proven by the test, or merely asserted?
- Is the measured delta consistent with what the docs now claim?
- Ownership check.

Triage per protocol. Two rounds maximum.

---

## Phase 7 — Session Resume via `task_id`

**Owned paths:** `src/router/sessions.ts`, `src/guard/store.ts`, `test/unit/sessions-resume.test.ts`, `test/unit/guard-resume.test.ts`, `test/integration/resume-flow.test.ts`
**Dispatch ceiling:** 12.

**Why:** resuming a subagent by `task_id` resets its cap and redundancy accounting, so a resumed agent silently gets a fresh budget.

**Success signal:** repeated resumes cannot exceed the cumulative ceiling — demonstrated by a test that deliberately attacks it.

### Pre-Flight (P7) `[tier:fast]`

- [ ] Read the salvage `sessions.ts`/`store.ts` diffs and the three test files.
- [ ] Confirm `task_id` still arrives on the task tool's args in today's opencode, under that name.
- [ ] Confirm bucket (c) merged; check whether it moved session registration.
- [ ] Confirm Phase 2 eviction and resume tracking do not fight — a resumed session must not have been swept.

**Gate:** if `task_id` is no longer available, **stop and ask.** The feature has no foundation; drop it rather than fake it.

### Tasks

- **T7.1** `[tier:medium]` Detect and register resume from `task_id`.
- **T7.2** `[tier:medium]` Reset per-dispatch caps on resume while accumulating against a cumulative ceiling derived from the configured budget, not a hardcoded number.
- **T7.3** `[tier:medium]` Same for the guard budget.
- **T7.4** `[tier:medium]` Record resume events and dispatch counts in telemetry.
- **T7.5** `[tier:medium]` Port the three test files.
- **T7.6** `[tier:fast]` Document resume semantics and the cumulative ceiling.
- **T7.7** `[tier:fast]` Commit each task separately.

### New Tests (P7)

- A resumed dispatch gets a fresh per-dispatch cap.
- The cumulative ceiling is enforced across resumes and blocks when exceeded — the success-signal test.
- Resume is distinguishable from a retry attempt; they must not share a counter.
- Resume after eviction behaves defined-ly; assert the intended behaviour explicitly.
- Telemetry records the resume with the correct dispatch count.
- **Edge:** an unseen `task_id` is a fresh dispatch, not a resume.
- **Edge:** a malformed or empty `task_id` does not throw.
- **Edge:** the same `task_id` resumed twice concurrently does not corrupt counters.
- **Edge:** a cumulative ceiling of zero or one behaves sanely.

### Acceptance Criteria (P7)

```
[acceptance]
check: testsPass
check: buildPasses
criteria: Resuming by task_id preserves cumulative accounting while resetting the per-dispatch cap, a cumulative ceiling bounds total spend across resumes, and resume is never confused with retry.
deliverable: resume support across sessions and guard stores with unit and integration coverage, committed with CI green.
[/acceptance]
```

### Definition of Done (P7)

- [ ] All tasks committed, each commit green.
- [ ] Resume-vs-retry distinction tested.
- [ ] Interaction with Phase 2 eviction tested.
- [ ] Red-Green Protocol executed.
- [ ] **Ownership check** passes.
- [ ] CI green on all six matrix jobs.

### Abandonment Criteria (P7)

Drop if `task_id` is unavailable, or if the cumulative ceiling cannot be enforced without a hardcoded constant — an unenforceable ceiling is a false guarantee.

### Senior QA Review (P7) `[tier:heavy]`

- Attack the ceiling arithmetic deliberately: can repeated resumes escape the cap?
- Is the ceiling derived from configured budget or hardcoded?
- What happens when resume and eviction race?
- Is the telemetry honest — does a resumed dispatch count as one or two, and which is correct?
- Does anything change for users who never resume? It must not.
- Ownership check.

Triage per protocol. Two rounds maximum.

---

## Wave 3 Serialisation Point

Single agent, sequential:

- [ ] `[tier:medium]` Apply Phase 5, 6 and 7 wiring into `src/index.ts` one at a time, committing between each.
- [ ] `[tier:fast]` Regenerate goldens once; read and explain every hunk.
- [ ] `[tier:fast]` Full suite, typecheck, push, CI green on all six matrix jobs.

---

# WAVE 4 — Consolidation

## Phase 8 — Global QA, Documentation and Release

**Owned paths:** `README.md`, `CHANGELOG.md`, `docs/*`, `package.json`
**Dispatch ceiling:** 10.

### Pre-Flight (P8) `[tier:fast]`

- [ ] Enumerate every feature landed in Waves 1–3; confirm each is documented.
- [ ] Diff `README.md` claims against measured reality. The last release corrected seven stale token figures; do not reintroduce that class of error.
- [ ] Confirm every ported module has at least one caller or is deleted.
- [ ] Confirm nothing from the rejected list crept in.
- [ ] Measure the assembled prompt before and after the whole port.
- [ ] List every issue filed by a phase QA review, with severity.

### Tasks

- **T8.1** `[tier:medium]` Update `README.md` with measured numbers.
- **T8.2** `[tier:medium]` Write the `CHANGELOG` entry, stating plainly which parts were deliberately not ported and why.
- **T8.3** `[tier:medium]` Update `CONFIG_REFERENCE.md`, `VERIFICATION.md`, `LINE_REFERENCES.md`.
- **T8.4** `[tier:fast]` Triage the filed issues: close what the port already fixed, label the rest.
- **T8.5** `[tier:fast]` Cut the release: version bump, tag, publish via Trusted Publishing, GitHub Release.
- **T8.6** `[tier:fast]` Commit each task separately.

### New Tests (P8)

- **Documentation-drift test:** every top-level `tiers.json` key appears in `CONFIG_REFERENCE.md`. Cheap, and prevents rot this repo has already suffered twice.
- Every measured figure in `README.md` either has a corresponding assertion or is labelled an estimate with its divisor stated.

### Global Acceptance Criteria

```
[acceptance]
check: testsPass
check: buildPasses
check: lintClean
criteria: All ported features are documented with measured numbers, no rejected feature leaked in, no default changed for an existing user, the published package contains no test or scratch files, and the release carries SLSA provenance.
deliverable: a released version on npm with a GitHub Release, CHANGELOG entry and updated docs.
[/acceptance]
```

### Global Definition of Done

- [ ] Every phase's DoD ticked, or the phase formally abandoned with its reason recorded.
- [ ] Every QA review closed within the two-round cap; residual findings filed as issues with severity.
- [ ] `activePreset` identical to the Wave 0 manifest value (R1).
- [ ] `grep -r "memory/lessons" src/` returns nothing (R7).
- [ ] No `setInterval`/`setTimeout` outside test files.
- [ ] **Every ported module has a caller.** Modules landed callerless in Wave 1 under the manifest's contingency must be wired by end of Wave 2, or deleted.
- [ ] Test count strictly greater than 918; no existing test deleted or weakened to pass.
- [ ] Ownership checks passed in every phase.
- [ ] CI green on all six matrix jobs.
- [ ] `npm pack --dry-run` file list unchanged except for genuinely new `src/` modules.
- [ ] Published with SLSA provenance via Trusted Publishing; no long-lived token.
- [ ] `salvage-local-work` still exists locally and is untouched.

### Global Senior QA Review `[tier:heavy]`

Reviewer must not have implemented any phase.

- **Behavioural invariance.** Install the published package with no config; confirm routing is identical to 1.5.0. Any difference not in the CHANGELOG as intentional is a defect.
- **Token honesty.** Measure the assembled prompt across presets against every figure in the README.
- **Dead code.** Is every ported module reachable? An unreferenced module is worse than none.
- **Test quality.** Sample five new tests at random and verify each fails against the pre-change code. Vacuous tests are the failure mode this plan most fears.
- **Third-party impact.** Did the port break, conflict with or silently supersede any open PR? Check #13 and #19 specifically.
- **Rejected-scope leakage.** Confirm nothing from the rejected table landed.
- **Windows.** Confirm the matrix actually exercised the new path code on `windows-latest`.

Triage per protocol. Two rounds maximum. A *critical* finding on the second re-review is a blocking problem — stop and ask.

---

## Phase 9 — Plan Disposition

- **T9.1** `[tier:fast]` Mark this file complete: add a status line recording the final commit range, which phases were abandoned and why, and the issues filed. This is the only permitted edit to this file, and it happens once, at the end.

---

## Deferred / Rejected — Rationale for the Record

| Item | Decision | Rationale |
|------|----------|-----------|
| Lessons memory store | Deferred past Wave 4 | ~800 lines; adds protocol tokens right after #21 removed 52%; writes into the user's workspace; effectiveness never measured. If revisited: opt-in, default `false`, with a measured claim. |
| Anti-context-anxiety clause | Rejected | Re-adds prose #21 deliberately removed. |
| INTENT dispatch section | Rejected | Same. |
| Workspace-root protocol line | Rejected | Per-message token cost for on-demand information. |
| `activePreset: "opus"` | Rejected | Changes every existing user's preset; automerges with no conflict marker. Guarded by R1. |
| `enforcement.mode: "enforced"` | Rejected | Ships `advisory`; `enforced` stays opt-in. |
| `smoke-evidence.ts` | Optional, Wave 4 | Test-support only. |

---

## Appendix — Commands

```bash
# Read a file as it exists on the salvage branch, without checking it out
git show salvage-local-work:src/verify/paths.ts

# What each line changed in one file since the merge base
git diff b8bef97..salvage-local-work -- src/router/config.ts
git diff b8bef97..master              -- src/router/config.ts

# Conflict probe, writes nothing
git merge-tree b8bef97 master salvage-local-work

# Ownership check for a phase
git diff --name-only <phase-base>..HEAD

# Red-green, per protocol
git stash push -- <source-path>
npx vitest run <test-file>
git stash pop

# Regenerate goldens after a deliberate prompt change
npx vitest run -u
```

**Known conflict surface** (`git merge-tree`, 9 files): `assembled-prompt.golden.test.ts.snap` (19 hunks), `protocol.golden.test.ts.snap` (15), `README.md` (6), `src/index.ts` (5), `src/router/protocol.ts` (2), `CHANGELOG.md` (1), `docs/LINE_REFERENCES.md` (1), `src/router/config.ts` (1), `test/unit/protocol.test.ts` (1).

Snapshots are regenerated, never hand-merged. `README.md` and `CHANGELOG.md` are rewritten, never merged.
