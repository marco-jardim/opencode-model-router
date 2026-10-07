# Phase 3.3 — global QA of cost-aware routing (#74)

Three parallel reviewers covered areas **A**, **B** and **C**. This report records the findings and their fixes by area; it is not a final global PASS while other areas await integration. Part C was implemented on `car/p33`; parallel producers' branches are not merged here.

## Part A

**Fixes pending merge.** The orchestrator will append the reviewer findings, commits and verification after integration.

## Part B

**Fixes pending merge.** The orchestrator will append the reviewer findings, commits and verification after integration.

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
