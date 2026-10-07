# Phase 3.3 — global QA of cost-aware routing (#74)

Three parallel reviewers covered areas **A**, **B** and **C**. Part C was implemented on `car/p33`; the other producers are now integrated: `car/p33b` (never-down, commit-time rows) via `4b60d78`, `car/p33c` (privacy/config/pricing) via `e7ef8c0`, and `car/p33d` (adapter/docs) via `c7addec`. Post-integration handoffs are closed below. This is not final release acceptance: criteria #12 and #13 remain pending DF5 / Phase 3.4, with explicitly accepted limits preserved.

## Part A

### Reviewer summary

Area A reviewed v1/static compatibility, adapter and hook ordering, the native runner, and integration documentation over `v2.2.0..d3f6ffc`. The reviewer found no blocking/critical issue; D1/D2 held in the reviewed snapshots/goldens. A1 was major: the QA-2.2-10 prompt-cache measurement handoff had been dropped. Other findings were phantom decision rows, v1 warning delivery, ungated statistics, resume identity accounting, location ownership suppressing hooks, stale defensive-token commentary, unused exports and missing documented limits. The source review record is `g-probe-a/report-part-A.md` in the reviewer's temp evidence directory; the committed fixes below are the durable references.

| Finding | Resolution | Commit(s) |
|---|---|---|
| QA-G-A1, major | Advise-only stable class/destination hint; no live numbers, previous pick or reason, and no hint in enforce. Document that a separate system part does not preserve cached history; restore the cache-read-share measurement to DF5. | `e36c853` |
| QA-G-A2, minor | Hold the decision row until `commit()` after the hook chain accepts the call. Rejected calls write nothing; successful/unresolved calls write exactly once. | `14af9df`, documentation `350e893` |
| QA-G-A3, minor | Thread the plugin logger through v1 role/stat routing resolution, including hot reload, instead of falling through to `console.warn`. | `e36c853` |
| QA-G-A4, nit | Without a routing block, `/router stats` retains legacy help behavior on v1/v2. | `e36c853` |
| QA-G-A5, minor | A resumed attempt's row waits for matching host progress/result identity confirmation. Reject a stray result even without progress, clean up and use the fresh-attempt fallback; document that path. | `e36c853` |
| QA-G-A6, minor | The receiving live instance acts even if another location appears to own the session; process-wide call claims, not directory preference, prevent duplicate work. | `e36c853` |
| QA-G-A7, nit | Correct runner-token comments: measured hosts 2.0.22/2.0.24 do not deliver those internal tool-before hooks; the token remains defensive for hosts that do. Do not claim broader defense than tested. | `e36c853` |
| QA-G-A8, nit | Remove unused route-line-key and advisor memo-reset exports. | `e36c853` |
| QA-G-A9, nit | Document coarse credential-skip diagnostics and the lack of false-refusal detection for `delegate` producers (native-subagent result path only). | `e36c853` |

## Part B

### Reviewer summary

Area B reviewed the policy invariants (especially high-risk/no-detection never-down), claimed versus actual verification, resume rewrites, classifier privacy and project overrides, catalog pricing, observability, named D-rule coverage and acceptance evidence. The unsafe paths were not just a missing table row: an external/native agent's capped candidate rank could understate the pick's actual model capability, a route `d=` claim could exaggerate verification, and a resume rewrite could evade needs/never-down checks. Privacy probes also exposed trailing-acceptance credential signals and project budget widening. These paths now have targeted regressions, and the two post-merge omissions in parser/plan annotation are fixed.

| Finding | Resolution | Commit(s) |
|---|---|---|
| QA-G-B1 | Compare against the pick's capability rank from the preset's model ladder, not only its capped candidate/role rank. | `35058ea`, A34 docs `350e893` |
| QA-G-B2 | Use the weaker of route-line detection claims and the prompt's actual acceptance checks for dispatch/hints. Apply the same rule to plan annotation in the post-integration handoff, with unbacked-claim and real-check controls. | `654557d`, `350e893`, follow-up `d01d1a6` |
| QA-G-B3 | A30 running-agent rewrites require a still-usable agent, needs coverage, and D9 never-down; otherwise send the resume as named. | `abaddd7`, `350e893` |
| QA-G-B4 | Credential gate and classifier state use the same raw description/acceptance/body sources, including a trailing acceptance block. | `7372fec` |
| QA-G-B5 | Project overrides may tighten, never widen, inherited classifier max-state/samples/timeout budgets. Preserve source layers and surface clamping notices. | `8c772a7` |
| QA-G-B6 | Never-down also rejects the pick's own model at a lower or unproved variant at the same capability rank. | `35058ea`, `350e893` |
| QA-G-B7 | A catalog variant step that reaches another preset tier's same-model rung costs at least that rung's ratio, rather than inheriting only the cheaper starting tier's ratio. Explicit candidate/base pricing remains distinct. | `7d8d544` |
| QA-G-B8 | Record effective/claimed detection and pick/dispatched capability ranks; show the high-risk d=none audit. Post-integration parser preserves validated fields, tolerates old rows and discards malformed metadata without losing the decision. A real flusher → disk → summarize/render test proves a numerical audit, not n/a. | `ed75aaa`, `350e893`, follow-up `cbbc3ab` |
| QA-G-B9 | Fill named D-rule gaps and expose the tested D17 mode calculation in statistics for the enforce-period checkpoint. | `8c772a7` |
| QA-G-B10 | Record sync/restart timings and qualifications; correct the Phase 3.3 ledger to ONE unplanned host restart (02:17:33Z). The second interruption aborted subagent runs without restarting the host. | `e36c853`, corrected by `7349b2c` |
| QA-G-B11 | Remove acceptance `cwd:` lines from classifier state before backend transmission. | `7372fec` |

### Per-D named-title coverage

Re-ran the reviewer's existing `C:\Users\Marquinho\AppData\Local\Temp\opencode\g-probe-b\p10-dcov.mjs` from this worktree after integration. It scans literal `it`/`test`/`describe` titles under `test/`; these are **title hits**, not independent executed tests or proof of complete semantic coverage. Parameterized titles count once; unrelated D-label reuse can also match (for example a depth-guard D5). The regression suites and evidence remain the substantive proof.

| Decision | Reviewer baseline | Post-integration title hits |
|---|---:|---:|
| D1 | 5 | 6 |
| D2 | 5 | 5 |
| D3 | 1 | 1 |
| D4 | 4 | 4 |
| D5 | 5 | 5 |
| D6 | 4 | 4 |
| D7 | 4 | 4 |
| D8 | 6 | 6 |
| D9 | 5 | 6 |
| D10 | 4 | 4 |
| D11 | 7 | 7 |
| D12 | 6 | 6 |
| D13 | 3 | 3 |
| D14 | 3 | 3 |
| D15 | 4 | 4 |
| D16 | 1 | 1 |
| D17 | 4 | 4 |
| D18 | 7 | 7 |

### Global acceptance criteria 1–13

Numbering follows plan §4.1. “Addressed” here means the finding is resolved in code/tests/docs; it does not imply a new live-host smoke was run after these fixes. The historical real-host evidence is in [Phase 3.2](phase-3.2.md).

| # | Criterion | Status after fixes / evidence and qualification |
|---|---|---|
| 1 | No routing block preserves 2.2.0 on v1/v2 | Addressed: A4 restores legacy `/router stats`; static/no-block snapshots and goldens retained. The reviewer reported D1/D2 hold; post-integration goldens passed. No new host smoke in this follow-up. |
| 2 | Shadow records without changing dispatch | Addressed: A2 writes at commit rather than for rejected calls; dispatch regressions cover modes. Outcome rates still cover trusted classes only, as documented. |
| 3 | Advise R: line/hint, no LLM model selection | Addressed: generated routing prose remains; A1 stabilizes the advise-only hint. Cache-read-share measurement is explicitly deferred to DF5, not asserted as proven. |
| 4 | Enforce only under D9, real-host path proven | B1/B2/B3 addressed capability rank, detection claims and resume rewrites; B6 closes same-model variant downshifts. B8 audit survives disk round trips. Targeted regressions are green; real-host execution evidence remains Phase 3.2, not a new smoke of every fix. |
| 5 | Variant retry before escalation; D11 resume/fresh | Addressed: existing ladder/Phase 3.2 evidence plus A5 identity-confirmed rows and documented rejected-resume fallback. Provider acceptance of in-band effort remains the existing experimental limit. |
| 6 | USD/ratio units separate; unpriced zero unknown | Addressed: existing D5/D6 coverage and B7 corrected catalog-rung pricing. |
| 7 | D14 classifier bounds/privacy; dispatch not hung | B4/B5 addressed shared credential/state sources and project-only-tightening budgets; B11 removes cwd. Classifier/config regressions and existing timeout/fallback behavior retained. |
| 8 | Cost doctor reports unset title/summary model | Addressed per documented host correction: title-model findings are supported; no summary-model consumer exists on the inspected v2 host, so no fictitious summary finding is promised. |
| 9 | Annotation additive relative to existing behavior | Addressed with C13 unsafe-anchor skipping/reporting, B2 effective-detection correction and accepted N11 pre-existing tier-tag slug behavior. New route lines are separate from headings. |
| 10 | Every D-decision named in a test title | B9 addressed; all D1–D18 have nonzero title hits in the re-run above, with the scan's limits explicitly stated. |
| 11 | v2 native candidates, v1 opt-in only; roles:{} disables | Addressed by existing D1/D12 tests; A3 preserves plugin-logger coercion on v1 reload. |
| 12 | DF0–DF5 reproducible; pinned && switched = 0 | **Pending DF5 / 3.4.** DF3/DF4 bounded copy-based outputs are recorded; DF5 and the final pinned-dispatch query must still be captured. |
| 13 | Restart ledger/durations; no merged work redone | **Pending DF5 / 3.4.** B10 timings corrected and one Phase 3.3 unplanned restart recorded. The second interruption was not a restart. Complete the final checkpoint; wall-clock sync→probe intervals are not measured service downtime. |

### DF5 handoffs

- **QA-G-A1 / QA-2.2-10 carry-over:** measure the orchestrator's cache-read share with the advise hint on against the shadow baseline. Record the inputs/denominator and workload caveat; hint stability and its absence in enforce are not a substitute for that measurement.
- Record the **D17 result** from the new `D17 mode (use the DF4→DF5 enforce-period window)` line (`d17Mode`): any failed enforced switch returns the mode to advise. Include enforced/verified/failed counts so zero failed switches is not mistaken for broad verified evidence.
- Use bounded `--since` / exclusive `--until` windows, explicitly recording the DF5 cutoff. Read a COPY of the live store with `--dir <copy>`; retain the source window and command with the output. Complete the pinned-dispatch query and restart/liveness ledger required by criteria #12/#13.

### Post-integration verification

On the integrated tree plus parser/plan follow-ups: `npm run typecheck` passed. Explicit scoped run (default pool, `--maxWorkers=2`) passed **15 files / 818 tests**, including all requested golden files:

```text
npx vitest run test/unit/routing-outcomes.persist.test.ts test/unit/routing-outcomes.stats.test.ts test/unit/routing-engine.plan.test.ts test/integration/annotate-plan-route.test.ts test/unit/docs-drift.test.ts test/integration/routing-dispatch.test.ts test/unit/routing-classify.index.test.ts test/unit/config.routing.test.ts test/golden --maxWorkers=2
npx vitest related src/routing/outcomes/persist.ts src/routing/engine/plan.ts --run --maxWorkers=2
```

The related run passed **51 files / 1561 tests**, with **3 files / 55 tests skipped**. The first plan run exposed one obsolete assertion that an unsupported `d=deterministic` claim wins; it was updated to assert effective `none` while preserving the original route text. The rerun passed 103 plan/annotation tests. No full suite, thread pool, keyed smoke, live-store write, host configuration change or service restart was performed for this follow-up.

## Part C

### Review summary

The reviewer examined outcome persistence and cross-process writes, log/statistics fidelity, smoke-test isolation, plan annotation, packaging, and the reproducibility/completeness of dogfood and user-facing documentation. Major findings were a lost-update race in snapshot persistence (the deterministic p3b interleave recorded ten passes but retained seven), smoke writes reaching the real temporary directory, and an incomplete DF3 checkpoint record. Minor findings covered duplicate rows, rotation races, timing-sensitive tests, unsafe inline-code annotation, and documentation omissions.

**Status:** C1–C13 addressed, including the C7 follow-up correction below. N1/N2/N3/N5/N7/N10 fixed; N4/N6/N8/N11 accepted. Scoped tests are green. The filtered scenario-8 smoke is not independently runnable with its existing positive-control requirements; its failed run is reported below rather than counted as a pass.

### Fixes and commits

| Finding | Fix | Commit(s) |
|---|---|---|
| QA-G-C1, major | Shared exclusive-create, mtime-stale file-lock helper, reused by advisor and the outcome flusher. `outcomes.json.lock` encloses the foreign-read/merge/snapshot-write/rename transaction. Busy locks leave the snapshot pending, warn once per failure streak and retry on a later flush without blocking dispatch. Regression interleaves two independent persisters and preserves all ten passes, even with identical mtimes. Stale-lease limitations are documented. | `be76e0a` |
| QA-G-C2, major; C10, minor | Smoke global setup records `OMR_SMOKE_REAL_TMPDIR`, redirects TEMP/TMP/TMPDIR to a private directory, then removes it and restores env. Scenario 8 explicitly uses the recorded real temp. The two keyed smoke files use private HOME/USERPROFILE and real host config/data XDG roots. Guard unit test checks native child paths. | `225ef68` |
| QA-G-C3, major | Merged `car/pcred` (including `e99330c` and `8a04b4a`) without duplicating its DF3 classifier subsection. Added DF3 sync, rollback, restart/liveness, advise-switch bounds and first-row evidence. Documented the single host backend result and the unobserved batched `source: host` criterion; host remains EXPERIMENTAL. | `2b05d40` |
| QA-G-C4/C5, minor | Recomputed DF3/DF4 using both `--since` and exclusive `--until` against a COPY of decisions/outcomes; pasted both outputs. DF3 includes the missing sixteen shadow rows. Corrected DF4 lost restart time to 35m38s including the incident, and override time to just before 00:51:45Z. | `2b05d40` |
| QA-G-C6, minor | Explained that the repository stats script does not load router config: pass `--dir <routing.outcomes.path>` when configured. Added `--dir` to the README command row. | `37a9dee` |
| QA-G-C7, minor | Dedupe repeated decision IDs and repeated signal outcomes before windowing/joins; duplicated-batch regression. Follow-up restores R2-9: a decisive pass/fail can replace an earlier unverifiable result. | `0b0ac3b`, corrected by `b5fdede` |
| QA-G-C8, minor | Re-stat immediately before rotation; leave a newly replaced under-cap live file alone. Document approximately 5 MiB sizing across batches/processes. | `0b0ac3b` |
| QA-G-C9, minor | Relax store microbenchmark bound from 50 ms to 1000 ms. | `0b0ac3b` |
| QA-G-C11, minor | Known limits: a hard exit can lose approximately 30 seconds of queued rows plus an unsaved snapshot; graceful dispose flushes, subject to persistence failures/lock contention. | `37a9dee` |
| QA-G-C12, minor | Complete Unreleased notes for `variant-effort`, `effort-variant-mismatch`, config-notice lines, A18 outcomes-path restrictions and advisor notice state/lock files. | `37a9dee` |
| QA-G-C13, minor | Skip/report a step with an unbalanced backtick run on its anchor rather than inserting a route into multiline inline code; regression test preserves the unsafe step and annotates the next safe one. | `b690792` |
| N1 | Pin persistence size/generation/flush/batch/queue/quarantine/retry/stale-temp/stale-lock constants in docs-drift; assert the documented storage/flush figures. | `63b69c0` |
| N2 | Traverse relative static imports/re-exports and literal dynamic imports/require calls from shipped entry points against `npm pack --dry-run` contents. Negative fixture proves an omitted transitive module is caught. Computed dynamic specifiers are outside this static guard. | `63b69c0` |
| N3 | `/router` statistics usage now labels the npm command “(in a clone)”. | `63b69c0` |
| N5 | After exhausted EPERM retries, a target whose stat mode confirms no write bits makes snapshots read-only for the process. A sharing violation without that evidence remains retryable. Rows continue to append; regression checks no further snapshot I/O. | `63b69c0` |
| N7 | Separate snapshot, decision-log and general flush failure streaks. One channel's failure no longer hides another's warning or recovery. | `63b69c0` |
| N10 | Unit home guard exports HOME/USERPROFILE for native children and restores them during cleanup, while preserving single-variable per-test redirects. With explicit owner approval, updated `config.routing.test.ts` to use the real-home value captured BEFORE that export rather than querying native homedir afterwards. | `63b69c0` |

### C7 semantics correction

`0b0ac3b` initially kept the first verdict for each `(kind, decisionID, attemptID)` regardless of outcome. That regressed **QA-2.1-R2-9** by discarding a later pass/fail after `unverifiable`. **Do not retain that interpretation.** `b5fdede` keeps the first decision for a decisionID, and suppresses verdict/refusal signals only when the same identity **and outcome** was already seen. For verdicts the outcome is `verdict`; for refusals it includes the `overrides` marker. Existing aggregation then excludes an unverifiable row when a decisive verdict for that attempt is present in the window. The restored regression tests both pass and fail replacements, reverse order, and duplicated replacement batches. The general duplicated-batch test remains.

### Accepted limits

- **N4 — accepted:** `--dir` accepts relative and driveless paths, which `outcomes.path` refuses. It is a repo-only CLI flag, documented as such.
- **N6 — accepted:** an orphaned advisor tmp file after a crash, and the stale-lock rename not retried on EPERM. Both are best effort and documented here; cleanup/recovery is not a durability guarantee.
- **N8 — accepted:** appendRows reads up to 5 MiB to check the last byte after a foreign write. That is a bounded cost and only happens after another process wrote. More precisely, the first append after startup also checks a pre-existing file, and the nominal 5 MiB rotation threshold can be exceeded by a batch/concurrent append.
- **N11 — accepted (corrected rationale, owner decision):** heading-only plans can contain heading steps through `headingRuns()`, and inserting `[tier:X]` in a heading can change its anchor slug. Tier tagging is pre-existing 2.2.0 template behavior: `v2.2.0:src/index.ts` instructs “Place `[tier:X]` at the START of each step, before the description” and rewrites the plan with tags without exempting headings. The new 2.3.0 route line is separate: `additionsOf()` keeps `tag` and `insertRoute` distinct, and `applyAdditions()` emits the route after the heading's line terminator. That route line does not itself alter the heading slug. The earlier “headings are never steps” premise was rejected; no annotation change is needed for this accepted pre-existing tag behavior.
- **C1 residual:** stale reclamation uses a 30-second mtime lease, not fencing. A process suspended beyond the lease, or competing stale-lock recovery, can still race. Foreign EWMA deltas beyond the sample cap remain approximate. See [Known limits](../../ROUTING_ENGINE.md#known-limits-and-experimental-parts).

### Verification

Every implementation group was typechecked before committing and pushed to `origin/car/p33`. No full suite, thread pool, or keyed provider smokes were run.

Final scoped run (default pool, `--maxWorkers=2`): **10 files, 675 tests passed**:

```text
npx vitest run test/unit/routing-outcomes.persist.test.ts test/unit/routing-outcomes.store.test.ts test/unit/routing-outcomes.stats.test.ts test/unit/routing-advisor.bundled.test.ts test/integration/routing-advisor.test.ts test/integration/annotate-plan-route.test.ts test/unit/docs-drift.test.ts test/unit/packaging.test.ts test/unit/tmp-guard.test.ts test/unit/config.routing.test.ts --maxWorkers=2
```

Related-test verification (default pool; each command uses `--run --maxWorkers=2`):

| Changed-source arguments | Result |
|---|---|
| `src/routing/file-lock.ts src/routing/outcomes/persist.ts src/routing/outcomes/types.ts src/routing/advisor/index.ts` (C1 group) | 57 files passed, 3 skipped; 1851 tests passed, 55 skipped |
| `src/routing/outcomes/stats.ts src/routing/outcomes/persist.ts` (C7/C8/C9 initial group) | 49 files passed, 3 skipped; 1461 tests passed, 55 skipped |
| `src/routing/commands/annotate-plan.ts` (C13 group) | 38 files passed, 3 skipped; 944 tests passed, 55 skipped |
| `src/routing/outcomes/stats.ts` (C7 correction) | 46 files passed, 3 skipped; 1419 tests passed, 55 skipped |
| `src/routing/outcomes/persist.ts src/commands/output.ts` (completed nits) | 50 files passed, 3 skipped; 1508 tests passed, 55 skipped |

The first nits related run exposed eight test-fixture failures in `config.routing.test.ts`: its native `homedir()` capture now correctly returned the private home, not the original home. After owner-approved correction of that capture, the targeted guard/config run passed **187 tests**, and the related run above passed. Safety assertions were retained, not weakened.

**Windows OpenCode v2 paths:** read-only `opencode debug paths` on the installed host confirmed XDG_CONFIG_HOME and XDG_DATA_HOME are honored on Windows, with `/opencode` appended. The private-home probe resolved home to the probe directory and config/data to the supplied XDG roots. This command does not start a server or open its database. Keyed lanes deliberately retain real host config/data for providers/auth; they are not fully isolated/keyless host instances and were not run.

**Filtered-smoke limitation:** the initial unquoted PowerShell invocation was rejected by npm (`Unknown cli flag: --t`). The corrected command `npm run smoke:routing '--' '-t' '8 live store'` ran scenario 8 once, with eleven other tests skipped. It failed because scenario 8 requires positive controls from the earlier scenarios (`seenSessionIDs.size > 0` and `seenProjectDirs.size > 0`):

```text
8-live-store-untouched expectation disproven:
live store 14028 -> 14028 files (+0 new ...);
0 row(s) appended ...; 0 sessions of this run seen;
0 notice file(s) added or changed ... 0 project directories of this run;
config files changed: none
```

No provider smoke was started to satisfy those controls. The generated scenario-8 evidence file was restored so the previous complete-run evidence was not replaced by this filtered run. Temp/home isolation itself is covered by unit tests that launch a native Node child. The filtered smoke is **not** reported as green.

**Dogfood safety:** DF3/DF4 stats were read from a copy of live `decisions.jsonl` and `outcomes.json`, never written to the live store. Source bounds, copy location and complete outputs are in [dogfood.md](dogfood.md). No live service or user configuration was changed.

## Round 2

**PASS — round 2: 0 blocking/critical/major; all round-2 findings fixed**

The heavy review of `d775ad1` found **7 minor and 5 nit** findings. The fixes below close all twelve. This verdict is scoped to round-2 QA; global acceptance criteria #12/#13 still await DF5 / Phase 3.4, and the previously accepted limits remain in force.

| Finding | Fix and regression evidence | Commit |
|---|---|---|
| QA-G-R2-1 | Removed the always-true ownership check, its unused instance registry and misleading “another location owns” diagnostic. The receiving instance still acts and call claims de-duplicate. Known limits now explain that a project's static opt-out relies on once-only tool-hook delivery, measured on 2.0.22/2.0.24. Unrelated-directory single-instance regression verifies no invented ownership log. | `03a5d66` |
| QA-G-R2-2 | Any host result naming the resumed child confirms its deferred row before completed-result validation or cancellation checks, including failed/aborted/timeout results. The ladder confirms again before recording a verdict as an idempotent fallback. Adapter tests cover all three statuses; integration tests cover unconfirmed failure, one row per attempt, matching verdict IDs, and the unchanged stray-resume fresh fallback. | `bdb099c` |
| QA-G-R2-3 | Inherited classifier ceilings must be valid in-range integers (samples 1 or 3); otherwise the default ceiling applies. Invalid string `"500"`, below/above-range and fractional max-state values with a project request of 8000 clamp to 2000 and emit a notice. | `ee7c61c` |
| QA-G-R2-4 | Catalog-rung price floors recognize an effort-configured same-model tier. Fast has variant low and no effort; medium has effort medium and ratio 5. The catalog retry costs 5, yielding total cost 6 and a cost-ceiling stop. Tests explicitly compare simulation with the runner trace and cost, using the supported session-policy/catalog input. | `3edff5e` |
| QA-G-R2-5 | The A27 strictly-up exemption now requires preset capability above the pick, not just a higher role candidate rank. Off-preset general@haiku versus fast on high-risk work needs evidence; a seeded-evidence control remains eligible. Capability ranks are indexed once per decision to retain linear scaling. | `3007490` |
| QA-G-R2-6 | Smoke temp teardown catches rmSync failure, warns and still restores TEMP/TMP/TMPDIR and the saved real-temp variable. A forced-EPERM regression verifies restoration. | `0cb9a93` |
| QA-G-R2-7 | D17 reports `n/a (0 enforced switches)` when the window contains no enforced switches; statistics expectations and documentation drift pins updated. | `0cb9a93` |
| QA-G-R2-8 | Inspected state.ts: it finds the first acceptance block across the whole prompt, but omits a raw block over RULES_MAX_CHARS and includes the scrubbed block only when it fits the state budget. The credential gate now follows that exact inclusion result and shares directive/cwd filtering. Single/batch regressions cover raw-limit omission, budget omission and removed cwd; B4's credential in a sent trailing acceptance block beyond the 20k prompt head stays gated. | `e7d18df` |
| QA-G-R2-9 | Canonical capability/same-model comparisons fold provider/model case, consistently with variant normalization. Mixed-case model tests cover capability rank and lower-effort detection. | `3007490` |
| QA-G-R2-10 | Removed the orphaned route-field JSDoc and replaced stale advisor lock-lease commentary with the busy-backoff description it actually documents. | `0cb9a93` |
| QA-G-R2-11 | A failed put-back rename of a freshly replaced lock warns and leaves the caller busy rather than throwing. Regression verifies no transaction runs. | `0cb9a93` |
| QA-G-R2-12 | Each dispatch-router instance adds a random 8-byte nonce to its decision IDs. Two instances with equal timestamps and first sequence numbers produce distinct rows. | `03a5d66` |

### Verification and implementation corrections

All commands used the **default pool**, `--maxWorkers=2`, and private test fixtures. Typecheck passed before each fix-group commit, and each group was pushed separately with `Refs #74`.

| Verification | Result |
|---|---|
| Explicit group 1: routing-engine.kernel, routing-engine.ladders, ladder, ladder.session, escalate-resume, escalate-attempt-recorder, routing-ladder-resume, v2-client | **8 files / 679 tests passed** |
| Explicit group 2: routing-dispatch, config.routing, config.validate, routing-classify.index, routing-outcomes.stats, docs-drift, tmp-guard, file-lock | **8 files / 875 tests passed, 1 test skipped** |
| Related run for all changed production sources below | **98 files passed, 3 skipped; 9241 tests passed, 56 skipped** |
| Additional exec isolation | **1 file; 42 tests passed, 2 skipped** |
| Typecheck and whitespace | `npm run typecheck` and `git diff --check` passed |

```text
npx vitest run test/unit/routing-engine.kernel.test.ts test/unit/routing-engine.ladders.test.ts test/unit/ladder.test.ts test/unit/ladder.session.test.ts test/unit/escalate-resume.test.ts test/unit/escalate-attempt-recorder.test.ts test/integration/routing-ladder-resume.test.ts test/unit/v2-client.test.ts --maxWorkers=2
npx vitest run test/integration/routing-dispatch.test.ts test/unit/config.routing.test.ts test/unit/config.validate.test.ts test/unit/routing-classify.index.test.ts test/unit/routing-outcomes.stats.test.ts test/unit/docs-drift.test.ts test/unit/tmp-guard.test.ts test/unit/file-lock.test.ts --maxWorkers=2
npx vitest related src/routing/wire/dispatch.ts src/index.ts src/compat/v2-client.ts src/router/config.ts src/escalate/ladder.ts src/routing/engine/kernel.ts src/routing/outcomes/stats.ts src/routing/classify/index.ts src/routing/classify/state.ts src/routing/classify/types.ts src/routing/advisor/index.ts src/routing/file-lock.ts --run --maxWorkers=2
```

Initial implementation runs exposed fixture/type errors: unsupported `buildLadder.catalog` (corrected to session input), a missing declared confirmation callback on the attempt result, and a missing mock output string. The initial combined run hit its 120-second shell deadline. A longer run then identified an actual quadratic implementation regression in the new evidence check: the 20,000-rung kernel test took approximately 133.6 seconds against its unchanged 2-second bound. Indexing capability ranks once per decision fixed it; the full kernel file and all requested related tests subsequently passed. No timeout or performance assertion was weakened.

### Pre-existing exec timing flake

The reviewer/orchestrator reported that the two `test/unit/exec.test.ts` **lowPriority** tests failed once in the capped full run on `d775ad1`, which otherwise had **11656 tests passed**, and that the file passed **42/42 runnable tests in isolation**. This is recorded as a **load-dependent, pre-existing flake, not caused by this work**. `git diff --exit-code v2.2.0 -- test/unit/exec.test.ts src/verify/exec.ts` confirmed both files are unchanged since 2.2.0. This follow-up independently reran that file: **42 passed, 2 skipped**. No full suite was rerun here and the historical full-run result is attributed to the reviewer, not represented as a new run.

No live store, user configuration or service was modified, and no keyed-provider smoke was run for round 2.
