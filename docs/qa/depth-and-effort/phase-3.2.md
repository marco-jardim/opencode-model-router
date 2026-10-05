# Phase 3.2 — Versioned real-host depth and effort proof

## Pre-flight

- Branch `de/p32`, base `183b0dd` (`de/wave-3-base`); dependencies already installed.
- Read plan Phase 3.2 and amendments §1.7 A1/A3: scripted-provider (c)/(d) are mandatory,
  not credential-gated. Read the To 3.2 handoffs in `phase-0P.md` and `phase-2.3.md`.
- Reused the retained Phase 2.3 Anthropic Messages SSE rig, not its product-code copy.
  The smoke loads this checkout's package entrypoint through project-level config.
- Read `vitest.smoke.config.ts`, the deferred-catalog and native-v2 registration smoke
  conventions, and the two wiring integration fixtures used for the mutation check.
- 0.P.2.i found no existing keyless request-capture/tool-call harness: v1 used
  `debug agent`/`serve`, and v2 provider e2e required credentials. This phase adds the
  missing versioned capture path without changing either existing lane's script.
- Scope: no `src/`, package script, or workflow edits; no full-suite run. Integration
  mutations are temporary fixture-config changes and are restored before commit.
- Scratch commands, complete logs, HTTP captures, hook records, configs and process
  exits: `C:\Users\Marquinho\AppData\Local\Temp\Claude\p32-smoke\`.

## Implementation notes

### Versioned fixtures

Initial test/helper commit: `8c7ec2c2b9587986ab421f1bcae949994a23edb9`.
Final round-1 test revision: `85d5c180f75aa4c5267ba3c78c7b436dab70ab2f`.

- `test/smoke/helpers/scripted-provider.ts`: local-only keyless Anthropic Messages
  server, SSE and non-stream replies, request capture, marker-driven native tool and
  delegate calls, deterministic failing-then-passing grader replies, start/stop.
- `test/smoke/depth-effort.smoke.test.ts`: v1 on PATH under `RUN_OC_SMOKE_KEYLESS=1`
  or `RUN_OC_SMOKE=1`; v2 independently requires `RUN_OC_SMOKE_V2=1` and
  `OPENCODE_V2_BIN`. Explicitly requesting v2 without its binary fails a configuration
  test inside the v2 describe, not collection: any enabled v1 tests still execute.
  With the flag unset, the skipped describe is named `(set RUN_OC_SMOKE_V2=1 and
  OPENCODE_V2_BIN to run)` (shown by the verbose reporter). Neither condition prevents
  v1 execution, though a requested, misconfigured v2 leg makes the overall run fail.
- `test/smoke/helpers/scripted-provider.test.ts`: four protocol/barrier tests pin
  non-stream tool calls, non-retryable Anthropic-shaped errors, SSE ping/order, and
  background leaf release only after the parent tool result is captured.
- The config/inventory matrix requires a fresh `serve` process per variant: router
  config is process-CWD-scoped, so reusing one server with different HTTP directory
  parameters does not load each project's router overrides. Processes are stopped
  between variants, and the unset control is shared for all three keys (seven starts).
  Warning assertions require the key's actual `must be` validation diagnostic, not
  merely an INFO log containing a fixture path named `invalid`.
  Streaming tool scenarios use independent
  `run` processes (v2 `--standalone --auto`) to preserve deterministic project config,
  fresh runtime state and native foreground/background tool handling.
- Every fixture isolates HOME, USERPROFILE, XDG, APPDATA, LOCALAPPDATA and temp paths;
  strips inherited OPENCODE/router/provider credential settings; disables model fetch;
  and uses a fake key and loopback URL. The outer lane runner unsets XDG/OPENCODE first,
  so the older deferred-catalog test's fixed HOME-based log lookup is not redirected.
- Observers only log identities/parent IDs/native results and add capture headers.
  They do not enforce depth, modify tool output, register tier agents or set effort.
- Native host caps are lifted separately: v1 `subagent_depth: 4`, v2
  `experimental.subagent_depth: 4`, plus explicit general-agent dispatch permission.
  The router has `maxDelegationDepth: 1` (2 in the explicit accepted-bound test).
  V1 resume uses native `task_id`. V2 advisory resume uses the caller's
  own existing child, not a sibling. Completed v2 results must retain the model-visible
  `<subagent sessionID=` envelope; background results must carry structured `running`.
- Optional `SMOKE_DEPTH_EFFORT_ARTIFACTS` retains secret-free evidence. Processes and
  stub sockets are closed and exact allocated fixture directories removed even after
  assertion failures. `SMOKE_DEPTH_EFFORT_MUTATION=depth|bump|cap` alters fixture config only.

### Initial verification runs (historical; superseded by round-1 reruns below)

Commands were run in `D:\git\omr-de-p32`. The outer PowerShell runner removes
inherited `XDG_*`, `OPENCODE_*`, router and provider variables before setting the
requested lane's flags; v1's bin directory is first on PATH. Equivalent invocations
after that cleanup (environment assignments shown in shell-neutral notation):

```text
RUN_OC_SMOKE_KEYLESS=1 npx vitest run --config vitest.smoke.config.ts test/smoke/depth-effort.smoke.test.ts
RUN_OC_SMOKE_V2=1 OPENCODE_V2_BIN=<2.0.22 exe> npx vitest run --config vitest.smoke.config.ts test/smoke/depth-effort.smoke.test.ts
npm run smoke:keyless
OPENCODE_V2_BIN=<2.0.22 exe> npm run smoke:v2
npx vitest run test/integration/depth-guard-wiring.test.ts test/integration/ladder-effort-wiring.test.ts
```

Pinned binaries were checked with `--version`: v1 **1.18.19**, v2 **2.0.22**
(`versions.json`). All host lanes below were serialized; no full suite was run.

| Run | Result | Duration | Full output |
|---|---|---|---|
| New file, v1 keyless | 5 passed, 9 v2 tests skipped | 181.56 s | `new-v1/output.log` |
| New file, v2 native | 9 passed, 5 v1 tests skipped | 35.25 s | `new-v2/output.log` |
| New file, v1 post-mutation foreground + bump assertions | 3 passed, 11 skipped | 43.33 s | `new-v1-filtered/output.log` |
| Two restored integration files | 91 passed | 19.71 s | `integration/output.log` |
| `npm run smoke:keyless` | 3 files, 9 passed | 57.67 s | `keyless/output.log` |
| `npm run smoke:v2` | 1 file, 2 passed | 3.13 s | `v2/output.log` |

Initial assertion coverage (the original file's 14 tests included these grouped checks):

| Assertion | v1 1.18.19 | v2 2.0.22 | Captured/observed evidence |
|---|---|---|---|
| (a) Three keys set/unset/invalid; invalid warns without blocking startup | PASS | PASS | Seven starts per host; unset baseline shared by three keys; each invalid key emits its actual `must be` diagnostic; inventory API remains 200 |
| (b) No new agents | PASS | PASS | Full sorted native inventory equals unset baseline for every valid/invalid variant; fast/medium/heavy present; v2 plugin active state checked |
| (c) Enforced foreground | PASS | PASS | Root dispatch succeeds; child result `is_error: true`, exact `depthLimitMessage(1, 1)`; turn continues to `ok` |
| (c) Advisory foreground | PASS | PASS | Child dispatch succeeds; exact banner once at the end; v2 session envelope retained |
| (c) Enforced background/resume | Not in v1 matrix | PASS | Both native inputs exercised; existing resume target captured; exact D5 result |
| (c) Advisory background | Not in v1 matrix | PASS | Wire banner once; native output and metadata both `running`; structured output also has banner once |
| (c) Advisory resume | Not in v1 matrix | PASS | Existing direct child resumed; banner once; completed session envelope/handle retained |
| (d) Bump enabled | PASS | PASS | Two distinct producer sessions: `output_config.effort` low → medium; scripted graders fail then pass; verified delegate output |
| (d) Cross-session isolation only | PASS | PASS | Root-session title, separate graders and orchestrator have no effort; does not exercise A3 on the producer's own session |
| (d) Bump disabled | PASS | PASS | Two producer attempts both carry low |

Representative initial stdout summaries:

```text
new-v1:     Test Files 1 passed; Tests 5 passed | 9 skipped (14)
new-v2:     Test Files 1 passed; Tests 9 passed | 5 skipped (14)
keyless:    Test Files 3 passed; Tests 9 passed (9)
v2:         Test Files 1 passed; Tests 2 passed (2)
integration Test Files 2 passed; Tests 91 passed (91)
```

`summary.json` additionally checks every expected exit code and confirms from mutation
captures that depth was null without provider/tool errors, and bump was false with
wire efforts `['low', 'low']`. No skipped test is represented as passed: the other
host's describe is skipped in each dedicated lane. Both hosts were run explicitly.

Cleanup (`cleanup.json`): **67 recorded host processes** and **49 distinct stub ports**
across successful and unsuccessful attempts checked; no matching rig processes,
recorded hosts, unrecorded marker-driven CLI/v1 server candidates or stub listeners
remained. A pre-existing unrelated OpenCode 2 managed service was left untouched.
Strict targeted TypeScript checking passed after the final native inventory changes;
`src/`, `package.json` and both integration files have zero Git diff.

#### Retained unsuccessful fixture attempts

The initial v1 invocation exceeded the shell's 120-second command timeout after
producing config and depth captures; that incomplete invocation is retained under
`new-v1-shell-timeout/` and is not counted as a successful run. Subsequent complete
lanes run with no outer shell timeout (each individual test/process remains bounded).
The first complete v1 run passed all four provider scenarios, but a directory-routed
inventory request exceeded its 20-second deadline. That run is retained under
`new-v1-location-attempt/`. Investigation also exposed the process-CWD limitation above;
the final fixture starts per-variant servers and bounds each request at 60 seconds.
The new files passed targeted strict TypeScript checking (`tsc --ignoreConfig --noEmit
--strict --skipLibCheck --module ESNext --moduleResolution Bundler --target ES2022
--types node` with the two new files as entrypoints).
Gate-off control: with all RUN_OC flags disabled, the new file reports **14 skipped**
in **329 ms**, without launching fixtures (`gating.log`).
The first v2 run passed all eight provider scenarios, but its inventory API returned
401 because native v2 requires authentication. The corrected matrix uses a generated
temporary password and Basic auth, matching `v2-registration.smoke.test.ts`; the
password is not retained in artifacts. Original output: `new-v2-auth-attempt/output.log`.
The next v2 inventory attempt observed the native API's initially empty catalog;
like the existing registration smoke, the final test now waits for this plugin's
`state.status === "active"` and then re-reads the catalog. That unsuccessful fixture
attempt is retained under `new-v2-readiness-attempt/` (all eight provider tests passed).

### Configuration-only mutation check

Integration mutations (temporary edits, now restored with zero Git diff):

| Config mutation | Assertion | Observed failure |
|---|---|---|
| `maxDelegationDepth: null` | depth wiring / enforced / guards a created child before verification, prompt edits or file-store writes | Promise resolved `undefined` instead of rejecting |
| `maxDelegationDepth: null` | depth wiring / advisory / same test | Banner count expected 1, received 0 |
| `effortBump: false` | ladder wiring / v1 / keeps the effort policy, model and override on the same config snapshot | Expected `{ effort: "medium" }`, received `{}` |
| `effortBump: false` | ladder wiring / v2 / same test | Expected `{ effort: "medium" }`, received `{}` |

Command selected only those assertions across the two integration files: **4 expected
failures, 87 skipped**. Full output: `integration-both-filtered/output.log`.
After restoring fixture config, those two files passed **91/91** in **19.71 s**;
output: `integration/output.log`. No mutation was made to feature code or expectations.

Smoke mutations use the committed test-only fixture switch, never a source change:

| Config mutation | Assertion names (each host) | v1 | v2 | Observed failure |
|---|---|---|---|---|
| `maxDelegationDepth: null` | `enforced foreground: root allowed; child refused with exact D5` | KILLED | KILLED | Expected `is_error: true`, received `undefined` (dispatch actually completed) |
| `maxDelegationDepth: null` | `advisory foreground: root allowed; child proceeds with exactly one banner` | KILLED | KILLED | Banner split expected length 2, received 1 (no banner) |
| `effortBump: false` | `bumps only the retry producer from low to medium` | KILLED | KILLED | Captured `['low', 'low']`, expected `['low', 'medium']` |

These are **six expected smoke assertion failures**, not startup/provider errors.
Each depth mutation lane reported 2 failed / 12 skipped; each bump mutation lane
reported 1 failed / 13 skipped. Commands used `-t foreground` or `-t 'bumps only'`
with `SMOKE_DEPTH_EFFORT_MUTATION=depth` or `bump`. Logs/captures:
`new-v1-depth-filtered/`, `new-v1-bump-filtered/`, `new-v2-depth-filtered/`,
`new-v2-bump-filtered/`. The outer runner clears the switch before restored runs.
The v1 restored assertions pass 3/3; the final whole-file v2 run is also unmutated.

### A3 evidence boundary (QA-3.2-4)

The host fixture dispatches parented producers through the real delegate. Neither
pinned host emits a title/auxiliary request on those producers' own sessions. The
captured title belongs to the root; graders have separate sessions. Accordingly the
smoke proves **cross-session isolation only**, not sensitivity to removing the A3
agent/model gate. No observer-generated hook call is presented as host evidence.

Same-session gate evidence is deliberately at the integration/unit layer:

- `test/integration/ladder-effort-wiring.test.ts`, both `v1: applies medium only to
  the retry, reports fast@medium, and clears on success` and the equivalent `v2:`
  test: the fixture calls `params(producerSid, "title", producerModel)` during each
  producer attempt, including the live bumped attempt; `f.excluded` must remain
  `[{}, {}, {}, {}]`. This exercises the plugin's same-session agent gate.
- `test/unit/effort-override.test.ts`, `leaves target unchanged for a non-producer
  input %j`: cases retain the producer session but change agent, provider, model ID,
  or supply conflicting `id`/`modelID`. These pin the identity checks themselves.

These named tests are re-run on the final test revision; host PASS rows must not be
used to claim that the same-session identity-gate mutation was killed at host level.

### Round-1 mutation expansion (QA-3.2-3)

The final-revision rerun uses `SMOKE_DEPTH_EFFORT_MUTATION=depth` with filter
`enforced|advisory|accepts maxDelegationDepth`, not `foreground` alone. It exercises
v1 foreground/resume and v2 foreground/background/resume in **both** modes, plus
the accepted depth-two boundary. The v2 enforced-resume off-control may still be a
native error because it targets an existing sibling; the kill must therefore be at
the **exact D5 message** assertion, not merely `is_error`. Captures and failure names
are retained per test and tabulated in the final-revision results below.

The bump mutation selects `bumps only|accepts effortBumpMax`, proving both the first
bump and the new repeated-retry bound assertion are sensitive to bump-off config.
The original four config-only integration mutations are repeated and restored too.

## Round-1 final-revision verification (2026-10-05)

All results in this section were run against committed test revision
**`85d5c180f75aa4c5267ba3c78c7b436dab70ab2f`**. This report-only follow-up does not
change those test bytes. Unlike the historical initial results above, every host
artifact includes the revision and SHA-256 hashes of all three test/helper files.
`summarize.mjs` validated all **47 artifacts**, expected lane exit codes, mutation
kill counts, config values, successful host turns, and captured effort sequences.
No product source or expectations were mutated; the two integration fixtures were
temporarily config-mutated, then restored byte-equivalently in Git. No full suite ran.

Evidence root: **`C:\Users\Marquinho\AppData\Local\Temp\Claude\p32-r1\`**.
It retains `run.ps1`, `hosts.ps1`, `tested-revision.txt`, `tested-hashes.json`,
`versions.json`, `summary.json`, `cleanup.json`, and each lane's `result.json`,
`output.log`, and host `artifacts/`. Each invocation clears inherited XDG, OpenCode,
router and provider variables; v1's native bin is first on PATH, and only explicit
v2 lanes receive `OPENCODE_V2_BIN`. Binaries report **1.18.19** and **2.0.22**.
Prior attempt evidence under `p32-smoke/` and QA evidence under `p32-qa/` remain intact.

### Final run outputs

| Lane / output under evidence root | Result | Duration |
|---|---|---|
| `new-v2/output.log` | 11 passed, 9 v1 skipped | 42.75 s |
| `restored-v1/output.log` | **9 passed**, 11 v2 skipped | **216.75 s** |
| `restored-v2/output.log` | **11 passed**, 9 v1 skipped | **38.38 s** |
| `integration/output.log` | **1,261 passed** across the two wiring files (91) and effort-override unit file (1,170), including named A3 exclusions | 8.29 s |
| `protocol/output.log` | **4 passed** | 262 ms |
| `missing-v2/output.log` | Expected collection failure: `Set OPENCODE_V2_BIN to the OpenCode 2 executable when RUN_OC_SMOKE_V2=1` | 275 ms |
| `gating/output.log` | 20 skipped; verbose v2 describe includes the opt-in instructions | 280 ms |

Targeted strict TypeScript checking passed for `depth-effort.smoke.test.ts` and
`helpers/scripted-provider.test.ts` (which imports the provider helper), using
`tsc --ignoreConfig --noEmit --strict --skipLibCheck --module ESNext
--moduleResolution Bundler --target ES2022 --types node` before freezing the revision.
The unchanged package lanes' historical results above are not claimed as reruns here.
`npm run smoke` already sets `RUN_OC_SMOKE=1` and selects all of `test/smoke`;
`vitest.smoke.config.ts` includes `test/smoke/**/*.test.ts`. Thus the credentialed
`smoke.yml` lane (secrets-gated, 20-minute job, pinned v1) **already collects the v1
depth/effort tests and all four ungated helper tests**. It now carries approximately
217 seconds of additional local v1 runtime; Linux runtime has not been measured here.
The fixture still isolates HOME/XDG, strips provider/router settings, and writes
projects outside this checkout, so neither credentials nor `layer2-gate`'s repo-root
config are used. The remaining v1 CI script change for 3.4 is adding both files to
the explicit `smoke:keyless` list, not enabling them for the credentialed lane.

### Final per-host assertion table

| Assertion | v1 1.18.19 | v2 2.0.22 | Evidence |
|---|---|---|---|
| Set/unset/invalid configuration and unchanged full inventory | PASS | PASS | Seven starts; valid values emit no validation/layer-drop warning; invalid values warn and still start; full sorted catalogs equal baseline |
| Accepted depth 2 has an effect | PASS | PASS | Depth-1 child dispatch succeeds without banner; depth-2 grandchild gets exact D5 for limit 2 |
| Accepted `effortBump: false` has an effect | PASS | PASS | Both producer requests remain low |
| Accepted `effortBumpMax: "medium"` bounds repeated retries | PASS | PASS | Base low; two failed grades then pass; three producers send low → medium → medium with `maxAttemptsPerTier: 2` |
| Enforced foreground | PASS | PASS | Root succeeds; child gets exact literal D5; turn continues |
| Enforced resume | PASS (`task_id`) | PASS (`sessionID`) | Existing target handle exercised; exact literal D5 |
| Enforced background | Not supported by host | PASS | Native background input; exact D5 |
| Advisory foreground and resume | PASS | PASS | Child succeeds; exact literal A1 once; root has **no** delegation-depth banner; v2 completed envelope retained |
| Advisory background | Not supported by host | PASS | Wire/structured banner once; native `running` output/metadata; parent-result-controlled barrier replaces sleep |
| Bump enabled and cross-session isolation | PASS | PASS | Producer low → medium; root title, separate graders and later orchestrator have no bumped effort |
| Same-producer-session A3 identity gate | Integration/unit proof | Integration/unit proof | Not claimed as host coverage; named cases in A3 section pass in the 1,261-test targeted run |

### Final mutation kill table

Depth lanes use filter `enforced|advisory|accepts maxDelegationDepth`; bump lanes use
`bumps only|accepts effortBumpMax`. All smoke mutations use only
`SMOKE_DEPTH_EFFORT_MUTATION=depth|bump`. Recorded host turns exit 0; the failures
below are assertion kills, not startup/provider failures.

| Config mutation / assertion | v1 | v2 | Failure observed |
|---|---|---|---|
| Depth null / accepted depth-two boundary | KILLED | KILLED | `expected undefined to be true` at refused `is_error` |
| Depth null / enforced foreground | KILLED | KILLED | `expected undefined to be true` |
| Depth null / enforced resume | KILLED | KILLED | v1: missing `is_error`; v2: exact D5 replaced by native `Session … is not a child of the current session` |
| Depth null / enforced background | N/A | KILLED | `expected undefined to be true` |
| Depth null / advisory foreground | KILLED | KILLED | Banner split length 1, expected 2 |
| Depth null / advisory resume | KILLED | KILLED | Banner split length 1, expected 2 |
| Depth null / advisory background | N/A | KILLED | Banner split length 1, expected 2 |
| Bump false / first retry | KILLED | KILLED | Received low → low, expected low → medium |
| Bump false / repeated bounded retry | KILLED | KILLED | Received low → low → low, expected low → medium → medium |

| Mutation output | Expected failed / skipped | Duration |
|---|---|---|
| `new-v1-depth-filtered/output.log` | 5 / 15 | 77.94 s |
| `new-v2-depth-filtered/output.log` | 7 / 13 | 22.49 s |
| `new-v1-bump-filtered/output.log` | 2 / 18 | 29.57 s |
| `new-v2-bump-filtered/output.log` | 2 / 18 | 6.14 s |
| `integration-both-filtered/output.log` | 4 / 1,257 | 1.77 s |

The integration filter `guards a created child|keeps the effort policy` repeats the
four original config-only kills: enforced promise resolved instead of rejecting;
advisory banner count 0 instead of 1; v1 and v2 `{}` instead of `{ effort: "medium" }`.
Restored integration and both complete host legs are green as shown above. Total:
**16 smoke kills + 4 integration kills** on the frozen revision.

Cleanup rechecked **75 recorded host processes** and **47 stub ports**. All of
`remainingRecordedHosts`, `matchingRigProcesses`, `unrecordedScenarioCandidates`,
and `listeners` were empty. Unrelated managed services/TUI sessions were left alone.

## Findings

QA round 1 (adversarial, `[tier:heavy]`, 2026-10-05) of `8c7ec2c` and `e067225`.
Original detailed findings and line references remain in review commit `8441cae`.
The table below records the round-1 implementation resolutions. The round-2 review
below accepted all 12, with residual gaps tracked separately as R2-1 and R2-2.

| ID | Severity | Location | Finding | Resolution |
|---|---|---|---|---|
| QA-3.2-1 | major | Config acceptance matrix | Inventory equality alone cannot prove valid config was accepted or took effect. | `5a185ba`: no valid-value validation/layer-drop warnings; behavioral depth-2, bump-off, and medium-cap repeated-retry proofs pass on both hosts. |
| QA-3.2-2 | minor | Revision provenance | Initial v1 and mutation evidence predates final fixture edits. | `85d5c18`: embedded revision/source hashes; both full hosts and all mutation lanes rerun on this SHA, verified across 47 artifacts; outputs above. |
| QA-3.2-3 | minor | Mutation matrix | Missing v2 background/resume kills, particularly exact D5 on enforced resume. | `612277f`: expanded protocol; final runs kill all six v2 dispatch legs, depth-2 boundary, both effort assertions, and the four integration assertions. |
| QA-3.2-4 | minor | A3 evidence scope | Host title requests do not share a producer session; no host proof of same-session identity gate. | `174eac2`: claims corrected to cross-session isolation; named same-session integration/unit cases pass in final targeted run. Host-gate mutation coverage explicitly not claimed. |
| QA-3.2-5 | minor | Root dispatch assertions | Advisory root could carry an erroneous depth banner unnoticed. | `2d427e5`: every root dispatch result must exclude the delegation-depth banner; both host matrices pass. |
| QA-3.2-6 | minor | Native v2 gate | Explicit v2 request without binary silently skips; describe lacks opt-in instructions. | `73a9ef4`: missing-binary request fails explicitly; disabled describe names both flags. `missing-v2/` and verbose `gating/` verify both paths. |
| QA-3.2-7 | minor | Native v1 resume | No CI resume leg; helper writes v2 key in caller-resume branch. | `21f7642`: native `task_id` branch fixed; enforced/advisory v1 resume pass and both are mutation-killed. |
| QA-3.2-8 | minor | Background timing | Fixed 500 ms leaf delay makes native running-state assertion timing-dependent. | `bd839d1`: parent-tool-result barrier replaces sleep; host native running checks and helper synchronization test pass. |
| QA-3.2-9 | minor | Deferred catalog isolation | Earlier XDG log-path limitation neither fixed nor formally deferred. | `c47a3b2`: accepted pre-existing limit and clean-env workaround recorded; 3.3/3.4 follow-up issue handoff, not a source fix. |
| QA-3.2-10 | nit | Parent assertion | Assertion merely repeats child-ID derivation. | `65df3cb`: tautology removed; both final hosts pass. |
| QA-3.2-11 | nit | Scripted provider protocol | Non-Anthropic/retryable errors; non-stream tool loss; no ping. | `bbc69d6`: HTTP 400 Anthropic error shape, retained non-stream tool calls, SSE ping; protocol regression tests pass. |
| QA-3.2-12 | nit | Comments / wire contract | Unset comment wrong; imported expectations follow product wording changes. | `986340e`: `{}` comment corrected; independent literal D5/A1 strings pin wire text and are checked against imported formatters; host tests pass. |

### Round 2

The review observations below describe the pre-fix revision `60c851c` and its retained
round-1 evidence. Subsequent fixes and host reruns have their own revision/evidence
section below; historical artifact counts and line references are not current claims.

QA round 2 (adversarial re-review, `[tier:heavy]`, 2026-10-05) of the round-1 fixes, diff
`8441cae..60c851c`: `65df3cb`, `2d427e5`, `73a9ef4`, `21f7642`, `986340e`, `bbc69d6`,
`bd839d1`, `5a185ba`, `174eac2`, `c47a3b2`, `612277f`, `85d5c18`, `60c851c`. No host was rerun
because no finding needed it. The review read the test, helper and helper test at `85d5c18`, the
report, `src/router/config.ts`, `src/escalate/ladder.ts`, the workflows, `package.json` and
`vitest.smoke.config.ts`, plus the evidence under
`C:\Users\Marquinho\AppData\Local\Temp\Claude\p32-r1\`.

**Revision fingerprint.**
- `85d5c18..60c851c` touches only this report.
- `8441cae..HEAD` has zero diff in `src/`, `test/integration/`, `test/unit/`, `package.json` and `.github/`.
- SHA-256 of `git show 85d5c18:<file>` (`core.autocrlf=input`, so the working tree is byte-identical):

  | File | SHA-256 |
  |---|---|
  | `depth-effort.smoke.test.ts` | `4ab5262d…c526a` |
  | `helpers/scripted-provider.ts` | `d58eef46…eeda5` |
  | `helpers/scripted-provider.test.ts` | `b8714152…e8762` |

- These hashes equal `tested-hashes.json`.
- QA independently parsed all **47/47** host artifacts: every one has `revision` `85d5c180…` and these three `sourceHashes`. Per lane: new-v2 11, restored-v1 9, restored-v2 11, v1-depth 5, v2-depth 7, v1-bump 2, v2-bump 2.
- Every lane's `result.json` has the same revision (`run.ps1` also throws if HEAD moves during a run).
- `typecheck.log` contains no diagnostics.

**Mutation kill table: honest, re-derived from the logs.** Every kill is the claimed assertion failing, not `run()` failing. Each mutated artifact has host turns that exited 0, `summarize.mjs` enforces this, and the failure frames point at the asserting lines of `85d5c18`.

| Lane | Failed | Assertion frames |
|---|---|---|
| v1 depth | 5 | `:281:33` refused `is_error`; `:327:38` enforced foreground and resume; `:332:62` banner split |
| v2 depth | 7 | as v1, plus `:329:29` for enforced resume: native `Session ses_… ` text instead of D5, which is exactly the QA-3.2-3 concern |
| v1/v2 bump | 2 / 2 | `:293:64` low → low → low; `:365:66` low → low |
| Integration | 4 | `depth-guard-wiring.test.ts:142` and `:149` via `:169`; `ladder-effort-wiring.test.ts:150` |

Restored lanes: v1 9 passed / 11 skipped (216.75 s); v2 11 / 9 (38.38 s); integration 1,261 passed; protocol 4 passed. `cleanup.json` shows 0 remaining recorded hosts, rig processes, unrecorded candidates and listeners.

**Regression checks on the fixes:**

- **Barrier (`bd839d1`): no deadlock; every wait has a bound.**
  - The gate is armed synchronously, before the `background: true` tool_use reply leaves the provider, so a leaf can never arrive before its gate exists.
  - Release comes from the first parent request whose history pairs a `tool_result` with that background `tool_use`. `stop()` also releases, and a leaf cancelled that way is destroyed, not answered.
  - A wait that is never released is bounded by `run()`'s 90 s SIGKILL, then the 120 s test timeout and teardown `stop()`. Enforced background arms the gate and releases it on the refused result, with no leaf.
  - In all four host background artifacts the order is `armed → result-observed → leaf-waiting → leaf-released`:
    - restored-v2 `4mVkf5` (advisory) and `qUq8hB` (enforced: `armed → result-observed` only);
    - new-v2 `Jd9CNE`;
    - the v2 depth-mutation pair `oR9AIT`/`YrwB5G`.
  - So on 2.0.22 the leaf's first provider request arrives after the parent's result, and the hold never engages at host level. `running` is deterministic either way. The hold path itself is exercised only by the helper test. That is an observation, not a defect.
  - Residual, not reachable with the fixture's 200/400 replies: if a host retried the dispatching request, `background.set` would replace an armed gate and orphan its waiter. `closeAllConnections` still lets `stop()` resolve.
- **v2 gate in CI (`73a9ef4`): skipped, not failed.**
  - No workflow sets `RUN_OC_SMOKE_V2` or `OPENCODE_V2_BIN`.
  - With the flag unset, `V2` is false, so the module-scope throw is not reached and the v2 describe is `describe.skip`.
  - `restored-v1` is exactly the keyless CI configuration: `RUN_OC_SMOKE_KEYLESS=1`, `RUN_OC_*`/`OPENCODE_*` cleared, no v2 binary. It exits 0 with 9 passed / 11 skipped.
  - `gating/`: 20 skipped, exit 0. `missing-v2/`: collection fails with the explicit message, exit 1.
  - Wording gap: R2-3.
- **v1 resume leg (`21f7642`): no extra permission needed; CI runtime fits, unmeasured on Linux.**
  - The fixture already grants `agent.general.permission.task: "allow"` and `subagent_depth: 4` (test `:97-100`). Both resumed sessions are `general`, and the restored-v1 resume artifacts show the dispatches succeeding.
  - The resume tests take 16.2 s / 16.7 s (mutated v1 lane). The whole v1 file went from 181.56 s to 216.75 s on this Windows host.
  - Together with today's `smoke:keyless` (57.67 s locally), that is about 4.6 min of test time inside the 10-minute `smoke-keyless.yml` job, before `npm ci` and the CLI install.
  - Not measured on ubuntu-latest. 3.4 must re-measure there and replace the job's stale "~40s" comment.
  - The leg does not assert that a resume actually happened: R2-1.
- **Anthropic error shape (`bbc69d6`).**
  - 400 `{type:"error",error:{type:"invalid_request_error",message}}` makes fixture faults fail fast instead of being retried as 5xx.
  - Non-stream tool calls keep `tool_use`/`stop_reason: "tool_use"`, and the SSE `ping` is in the right position (helper tests 1–3).
  - No host run hit the error path: every `run()` asserts `provider.errors` is empty, and every mutated turn exited 0. So "non-retryable" rests on HTTP semantics and is not observed host behaviour. Acceptable for a fault path.
- **Behavioural "set" legs (`5a185ba`).**
  - The valid-value log check rejects strings the product actually emits: `must be` (validators), plus `combined overrides are invalid … dropping conflicting layer(s)`, `dropped override layer` and `ignoring <path>: …` (`src/router/config.ts:1192-1301`). A rejected valid value now fails the set leg.
  - `maxDelegationDepth: 2` is discriminating both ways. The default is 1 (`resolveDepthLimit`, `config.ts:1369-1372`), which fails `allowed` at `:278`. `null` fails at `:281`, and that kill is recorded on both hosts.
  - `effortBump: false` is discriminating against the default `true`, which would give low → medium.
  - `effortBumpMax: "medium"` is discriminating only by inference: R2-2.

Round-1 resolution status:

| ID | Status | Evidence |
|---|---|---|
| QA-3.2-1 | resolved (residual → R2-2) | A rejected valid value now fails the set leg. Depth 2 and bump-off behaviour discriminate on both hosts. The effortBumpMax "took effect" proof is inference only (R2-2). |
| QA-3.2-2 | resolved | 47/47 artifacts and all 12 lane results carry `85d5c18` and the blob hashes above; failure frames match `85d5c18` lines. |
| QA-3.2-3 | resolved | v2 depth lane: 7 kills, including enforced resume at the exact-D5 assertion `:329`, and enforced/advisory background at `:327`/`:332`; v1 5 kills; 4 integration kills. |
| QA-3.2-4 | resolved | Report and handoff claim cross-session isolation only; test comment `:367-369`. The named same-session cases exist (`ladder-effort-wiring.test.ts:195`, `effort-override.test.ts:60`) and are in the 1,261-pass run. |
| QA-3.2-5 | resolved | `:354` excludes `[⚠ GUARD:delegation_depth]` from every root `tool_result`; passes on both restored hosts. |
| QA-3.2-6 | resolved (wording → R2-3) | Explicit failure (`missing-v2/`), opt-in text in the skipped describe name (`gating/` verbose). |
| QA-3.2-7 | resolved (residual → R2-1) | v1 enforced/advisory resume legs run under the keyless gate. The helper caller branch writes `task_id` on v1 (helper `:83`). Both legs are mutation-killed. |
| QA-3.2-8 | resolved | Sleep removed; the barrier is tied to the parent's captured result. Host order and bounds are as above. |
| QA-3.2-9 | resolved (deferred by plan) | Accepted pre-existing limit plus the 3.3/3.4 follow-up recorded under "Deferred by plan" and "Handoffs". |
| QA-3.2-10 | resolved | Tautological `.some(...)` removed. |
| QA-3.2-11 | resolved | 400 Anthropic error shape, non-stream `tool_use`, `ping`; helper tests 1–3 pass. |
| QA-3.2-12 | resolved | `{}` comment `:243`; literal D5/A1 `:20-21`, cross-checked against the formatters at `:302-303`. |

Round-2 findings and implementation resolutions (original review: `3e4530e`):

| ID | Severity | file:line | Description | Resolution |
|---|---|---|---|---|
| QA-3.2-R2-1 | minor | v1 resume assertions | A guarded call carrying `task_id` did not prove the host resumed an existing session. | `2195bf4`: both v1 modes resume the setup caller and assert identical child ID plus its completed `<task id="…"` result; advisory also asserts the nested grandchild ID and existing task envelope. Enforced nested resume remains refused, not falsely claimed as completed. |
| QA-3.2-R2-2 | minor | Medium-cap fixture and evidence | Bump-off proves sensitivity to bumping, not to the cap itself. | `3dfabb7`: `SMOKE_DEPTH_EFFORT_MUTATION=cap` omits only `effortBumpMax` from serialized config, preserving the low → medium → medium assertion. Both-host uncapped controls are recorded below. |
| QA-3.2-R2-3 | nit | Missing-binary gate / report | Module-scope throw prevents v1 collection too; handoff understated overall failure. | `41feb40`: missing binary is a failing test within the v2 describe; enabled v1 still executes. Versioned-fixture and 3.4 notes distinguish v1 execution from the overall red run. |
| QA-3.2-R2-4 | nit | Barrier helper test | Default timeout precedes its own deadline; pending leaf can reject unhandled on failure. | `a45be03`: explicit 10 s test timeout above 5 s poll deadline; requests have immediate rejection handlers, leaf rejection is a settled outcome, and teardown aborts and settles all tracked requests before stopping providers. |
| QA-3.2-R2-5 | nit | CI notes / 3.4 handoff | Credentialed `smoke.yml` already collects these v1 and helper tests. | `a0ce7ec`: documents existing broad `npm run smoke` selection, secrets gate, runtime and isolation; remaining keyless additions are both files, plus runtime-comment update/follow-up. No package/workflow edits here. |

### Round-2 fix verification — tested revision and cap control

Test revision: **`a0ce7ec5a15c489ca571d5043dfd23a96d915a1f`**. The later resolution
report commit changes documentation only. Evidence is retained separately from the
round-1 artifacts in **`C:\Users\Marquinho\AppData\Local\Temp\Claude\p32-r2\`**:
`run.ps1`, `hosts.ps1`, `tested-revision.txt`, `tested-hashes.json`, `versions.json`,
per-lane `result.json`/`output.log` and host `artifacts/`. The runner uses a clean
environment per invocation, isolated HOME/profile/appdata/temp directories, v1's
native bin first on PATH, and `OPENCODE_V2_BIN` only for explicitly selected v2 lanes.
Versions were rechecked: v1 **1.18.19**, v2 **2.0.22**.

R2-2 adds a distinct config-only control, not another bump-off run:

```text
SMOKE_DEPTH_EFFORT_MUTATION=cap
npx vitest run --config vitest.smoke.config.ts test/smoke/depth-effort.smoke.test.ts -t "accepts effortBumpMax"
```

The runner enables each host separately. Both captured override objects **omit**
`effortBumpMax`, retain `effortBump: true`, `maxAttemptsPerTier: 2` and
`maxTotalAttempts: 3`, and both host turns exit 0. The unchanged assertion expects
low → medium → medium; captured producer requests instead carry
**low → medium → high on both v1 and v2**, killing the cap assertion. Logs and
captures are in `new-v1-cap-filtered/` and `new-v2-cap-filtered/`. This directly
discriminates the medium cap from the unset configuration at the wire, rather than
inferring it from source or relying on the earlier bump-off mutation.

#### Round-2 final run outputs

All repository test runs below used **`a0ce7ec5a15c489ca571d5043dfd23a96d915a1f`**.
`summary.json` validates the expected outcomes and all **34 host artifacts'** revision
and source hashes, including the retained failed v2 attempt. It also compares each
uncapped override to the passing capped override and verifies that deleting only
`effortBumpMax` makes the objects identical. The original depth/bump-off mutation
results remain round-1 evidence on `85d5c18`; they were not rerun in this dispatch.

| Output under `p32-r2/` | Result | Duration |
|---|---|---|
| `restored-v1/output.log` | **9 passed**, 11 v2 skipped; both v1 resume identity/envelope assertions pass | **214.34 s** |
| `restored-v2/output.log` | **11 passed**, 9 v1 skipped; unchanged revision rerun after the port failure below | **46.13 s** |
| `protocol/output.log` | **4 passed**, no unhandled errors reported | **320 ms** |
| `new-v1-cap-filtered/output.log` | **1 expected kill**, 19 skipped; received low → medium → high instead of low → medium → medium | 18.74 s |
| `new-v2-cap-filtered/output.log` | **1 expected kill**, 19 skipped; same wire mismatch | 3.34 s |
| `mixed-missing-v2-filtered/output.log` | **1 v1 passed**, 1 expected v2 failure, 8 skipped; proves v1 executes rather than collection being blocked | 22.37 s |
| `gating/output.log` | 20 skipped; verbose v2 name contains both opt-in variables | 326 ms |
| `restored-v2-bad-port-attempt/output.log` | Retained unsuccessful attempt: 10 passed, 1 inventory failure, 9 skipped | 30.86 s |

R2-1: both v1 resume legs now have a successful **root-to-existing-caller** resume,
with the same child ID and a matching completed `<task id="…"` result. Advisory also
asserts that the nested task resumes the existing grandchild and returns its exact
task ID. In enforced mode the nested resume is correctly refused with D5; that
refused dispatch is not claimed to have completed a native resume.

R2-3: the mixed-gate run sets both v1 and v2 opt-ins but omits `OPENCODE_V2_BIN`,
selecting `enforced resume|requires OPENCODE_V2_BIN`. The v1 resume test passes;
only the v2 configuration test fails with `Set OPENCODE_V2_BIN to the OpenCode 2
executable when RUN_OC_SMOKE_V2=1`. The overall exit is intentionally 1, not a
claim that a misconfigured combined lane is green.

R2-4 failure-path control: `barrier-fault/` retains an **external copy** of the final
helper test/provider, a minimal Vitest config and `output.log`/`result.json`. Only
that copy's poll/expected event was changed to unreachable, plus port logging;
the repository test was not modified. It deliberately left the leaf waiting at
the five-second deadline. Result: **1 expected assertion failure, 3 passed** in
**5.27 s**; the barrier test's event-sequence diff appeared at 5.013 s, not a test
timeout. No unhandled rejection/error was reported, and the recorded failure-control
port **1240** had no listener afterward. This is a teardown fault-injection control,
separate from the config-only cap mutations and from the unmodified 4/4 helper run.
The temporary dependency junction was removed; the fault-copy evidence remains.

The unsuccessful v2 attempt is not hidden or counted as a pass. Its baseline server
announced `http://127.0.0.1:3659`; Node fetch rejected it with `TypeError: fetch failed`,
caused by `Error: bad port`, before inventory assertions. This is the Fetch restricted
port case exposed by a host-assigned port. A single fresh full-v2 invocation on the
**same code and config** passed 11/11. No port-selection product/test change was made;
retain this independent harness limitation for follow-up rather than attributing it
to the five round-2 fixes.

Targeted strict TypeScript checking passed (`typecheck.log`), with the same two test
entrypoints and compiler options recorded for round 1. No full suite, integration
rerun, live-provider lane, or Linux CI run was performed in this dispatch.

Cleanup (`cleanup.json`) checked **53 recorded host processes and 34 stub ports**,
including the unsuccessful attempt: no remaining recorded hosts, matching rig
processes, unrecorded scenario candidates, or listeners. The additional fault-control
port check is in `barrier-fault/result.json`. Unrelated services were left untouched.

## Deferred by plan

- **QA-3.2-9 / A15:** the inherited `XDG_DATA_HOME` versus fixed HOME-based log lookup
  in `deferred-catalog.smoke.test.ts` is an accepted **pre-existing test-isolation
  limit**, outside the Phase 3.2 write-set (and not assigned to another phase's code
  write-set). The workaround for these runs is a clean calling environment with
  `XDG_*` and `OPENCODE_*` removed. This does not repair that older test for developers
  who invoke the lane from an arbitrary shell; the new fixture is independently isolated.
- Full suite and global QA are owned by the orchestrator/3.3; not run in this dispatch.
- Package script and release changes belong to 3.4.
- Live-provider acceptance, pricing and latency are not proven by this keyless fixture.
- V2 host legs remain local evidence: both `smoke.yml` (credentialed) and
  `smoke-keyless.yml` install pinned v1, not v2. The credentialed lane already selects
  these v1/helper tests; keyless needs the explicit file-list additions in 3.4.

## Handoffs

- **To 3.3/3.4:** open a follow-up issue to make deferred-catalog's log lookup honor
  `XDG_DATA_HOME`, or remove that variable in its child environment. Carry the clean-env
  workaround until fixed. No issue was opened by this dispatch; this is an explicit
  follow-up, not a claim that the earlier 2.3 isolation handoff was implemented.
- **To 3.4:** append `test/smoke/depth-effort.smoke.test.ts` **and**
  `test/smoke/helpers/scripted-provider.test.ts` to `smoke:keyless`. No addition to
  `npm run smoke`/`smoke.yml` is needed: that credentialed lane already selects both.
  Update the keyless workflow's obsolete "Two files, ~40s" runtime comment if its
  write-set permits; otherwise carry it as an explicit follow-up. Local added v1
  time is about 217 s; the 10-minute keyless budget still needs Linux CI confirmation.
  Also append it to `smoke:v2`; that script sets `RUN_OC_SMOKE_V2=1`, so it requires
  `OPENCODE_V2_BIN`. Without it, the v2 describe fails its configuration test, but
  enabled v1 tests are still collected and executed. An inherited v2 opt-in without
  the binary makes the overall keyless run red, not skipped. Do not gate v1 on v2.
- **To 3.1:** document independent host nesting limits and dispatch permissions;
  v2 resumes direct children only; advisory results preserve the v2 session envelope.
  Captured root titles, separate graders and the next orchestrator request have no
  bumped effort (cross-session isolation). The same-producer-session A3 identity gate
  is integration/unit evidence, not a host claim. This is not live-provider acceptance.
- **To QA:** inspect mutation sensitivity, full registry equality, native envelope
  preservation and the fact that observer plugins do not implement either feature.

## Verdict

**Open findings: 0 (every round-1 and round-2 finding fixed)**

- All 12 round-1 findings were resolved in the round-2 review. The residual resume
  and cap-control gaps are now closed by R2-1 and R2-2 fixes and host evidence.
- All five round-2 findings have finding-specific commits, filled resolution entries,
  and final-revision verification above. The report-only resolution commit changes
  no tested code. This is scoped finding closure, not a claim of a full-suite or
  live-provider run.
- Existing deferred isolation/CI handoffs and the retained restricted-port attempt
  remain explicit limitations; none is silently presented as repaired by these fixes.

History: the round-1 verdict was **changes required** (1 major, 8 minor, 3 nit), retained in `8441cae`.

Original QA observations (historical, supplemented by the final-revision results above):

- **Core proofs.** Bump on gives producer efforts low → medium and bump off gives low → low. Foreground
  depth gives the exact D5 text and exactly one banner. Each of these assertions failed under a
  config-only mutation on both hosts (see QA-3.2-2 for the revision caveat).
- **No empty-capture passes.** `run()` requires exit 0, no fixture errors and a final `ok`. Each scenario
  requires its `find` to hit, and the bump leg requires each role to be present.
- **Observers.** The observer plugins only log and add headers. They implement neither feature.
- **Isolation.** The fixtures strip `OPENCODE_*`, `XDG_*`, `MODEL_ROUTER_*` and provider variables, and
  repoint HOME, USERPROFILE, XDG_*, APPDATA, LOCALAPPDATA and the temp directories.
- **CI v1 leg (corrected in R2-5).** It already runs in secrets-enabled `smoke.yml`
  via `npm run smoke` and `RUN_OC_SMOKE=1`, along with the four ungated helper tests.
  Adding both files to `smoke:keyless` in 3.4 extends that coverage to secretless CI:
  - same `RUN_OC_SMOKE_KEYLESS` gate and the same `opencode` on PATH as `registration`/`deferred-catalog`;
  - the opencode-ai 1.18.19 postinstall links the native binary into the npm bin, so SIGKILL reaches the
    real process, not a Node wrapper;
  - the plugin loads from `main: ./src/index.ts`, with no build step;
  - the v1 child gets `subagent_depth: 4` and `general` `task: allow`, as the spikes needed.

  Not verified: a run on Linux or the credentialed workflow itself in this dispatch.
  The round-1 local v1 leg took 217 s. Account for this in the credentialed lane's
  20-minute budget and the keyless lane's 10-minute budget; update the keyless runtime
  comment in 3.4 if owned there, or track the comment as a follow-up.
- **Cleanup after the QA reruns.** No process had `omr-`, `p32` or `depth-effort` in its command line, no
  `omr-depth-effort-*` temp directory was left, and the set of OpenCode processes matched the set before
  the runs. The pre-existing OpenCode 2 service and the TUI sessions were left untouched.
