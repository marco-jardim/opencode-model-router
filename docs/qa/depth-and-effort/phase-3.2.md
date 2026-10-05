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

Test/helper commit: `8c7ec2c2b9587986ab421f1bcae949994a23edb9`.

- `test/smoke/helpers/scripted-provider.ts`: local-only keyless Anthropic Messages
  server, SSE and non-stream replies, request capture, marker-driven native tool and
  delegate calls, deterministic failing-then-passing grader replies, start/stop.
- `test/smoke/depth-effort.smoke.test.ts`: v1 on PATH under `RUN_OC_SMOKE_KEYLESS=1`
  or `RUN_OC_SMOKE=1`; v2 additionally when `OPENCODE_V2_BIN` is set. The v2-only lane
  uses `RUN_OC_SMOKE_V2=1`. Missing v2 binary is a visible skipped describe, not a
  credential-dependent omission of the v1 proof.
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
  The router still has `maxDelegationDepth: 1`. V2 advisory resume uses the caller's
  own existing child, not a sibling. Completed v2 results must retain the model-visible
  `<subagent sessionID=` envelope; background results must carry structured `running`.
- Optional `SMOKE_DEPTH_EFFORT_ARTIFACTS` retains secret-free evidence. Processes and
  stub sockets are closed and exact allocated fixture directories removed even after
  assertion failures. `SMOKE_DEPTH_EFFORT_MUTATION=depth|bump` alters fixture config only.

### Verification runs

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

Final assertion coverage (the new file's 14 tests include these grouped checks):

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

Representative final stdout summaries:

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

## Findings

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

QA round 1 (adversarial, `[tier:heavy]`, 2026-10-05) of `8c7ec2c` and `e067225`. Line numbers refer to
`8c7ec2c`.

| ID | Severity | Location | Finding | Resolution |
|---|---|---|---|---|
| QA-3.2-1 | major | `test/smoke/depth-effort.smoke.test.ts:233-245` | The "set" leg of (a) cannot fail if a valid value is rejected. An invalid value makes the router drop the **whole** override layer: `ignoring …overrides.jsonc: … must be …` / `dropping conflicting layer(s)` (`new-v1` artifact `49Zvn5`, processes 2/4/6). None of the three keys changes agent registration, so the inventory equality at :238 is identical for accepted and rejected values. The only check that tells them apart, the `must be` warning, runs only when `label === "invalid"` (:239). A validator that rejected `maxDelegationDepth: 2`, `effortBump: false` or `effortBumpMax: "high"` would still pass. `effortBumpMax` appears in no provider scenario, so no host-level evidence shows its accepted value works. | open |
| QA-3.2-2 | minor | `phase-3.2.md:77-79,163-175` | The v1 PASS row and all four smoke mutation kills come from an earlier test revision, not `8c7ec2c`. The mutation failure frames point at `:252:38`, `:257:62` and `:285:66`; in `8c7ec2c` those assertions are at :277, :282 and :310. The v2 Basic-auth and readiness edits (:184-223) came after the v1 full run (08:32-08:35) and after the mutation lanes (08:35-08:36). The 08:36:58 attempt still got 401, and the readiness attempt failed at old :209, which is now :231. The quoted assertion bodies match, so the kills very likely carry over, but the report presents them as evidence for this commit. QA rerun of `8c7ec2c`, unmutated: v1 5 passed / 9 skipped in 208.25 s; v2 9 passed / 5 skipped in 41.69 s (`C:\Users\Marquinho\AppData\Local\Temp\Claude\p32-qa\v1.log`, `v2.log`). | open |
| QA-3.2-3 | minor | `phase-3.2.md:163-175`; test `:251-300` | The smoke mutation ran only with `-t foreground`. The four v2 background/resume depth tests have no recorded kill, although A1 makes them mandatory (QA-0.P-R2-6). Reading the code: in enforced resume, only the exact-message check at :279 would catch the guard being off. With the guard off, v2 rejects the sibling resume natively, so `is_error: true` (:277) still holds, as the comment at :258-259 says. The other three should fail at :277, :282 or :289. This is inference, not evidence; plan 3.2.3 asks for evidence. | open |
| QA-3.2-4 | minor | test `:312-316`; `phase-3.2.md:96,196-197` | The "no auxiliary leak" claim goes further than the test shows. In every bump artifact the title request is in the **root** session (v1 `SUDpyp`: `title` and `build` both on `…IXfjMn`; v2 `DQj9k8`: both on `…EriSiR`). Graders run in their own sessions (v1 agent `build`, v2 `model-router-grader`). No auxiliary request shares a producer session, so these checks can only catch a cross-session leak. They cannot catch removal of the A3 producer-only agent+model gate, which exists for the same-session v1 title call; parented producers get no title request on either host (A3, QA-0.P-R2-11). The report and the 3.1 handoff still say titles "retain their own options" as if the gate were proven at host level. | open |
| QA-3.2-5 | minor | test `:297-299` | The "root allowed" check only asserts `!is_error` and the absence of the D5 substring. D5 appears only in enforced mode, so in advisory mode a depth-0 caller that wrongly gets the `delegation_depth` banner (a G2 regression) would still pass. Root results are never checked for `[⚠ GUARD:delegation_depth]`. | open |
| QA-3.2-6 | minor | test `:20-23,179`; `phase-3.2.md:30-32,191-193` | The v2 skip is silent. With `RUN_OC_SMOKE_V2=1` and no `OPENCODE_V2_BIN`, the file reports 14 skipped and exits 0, while `v2-registration.smoke.test.ts:33-35` throws in the same case. After the 3.4 handoff to `smoke:v2`, only that other file makes the lane fail. In the keyless/CI lane the default reporter prints only "9 skipped", with no leg names and no reason (QA rerun, `gating.log`). "Visible skipped describe" overstates this. | open |
| QA-3.2-7 | minor | test `:251`; helper `:70,72` | The v1 matrix is foreground-only. G1 lists `task_id` resume, and Spike A9 showed that a v1 resume reaches the before-hook. Only the v1 legs run in CI, so the host proof that runs in CI has no resume leg. The report says why v1 background is missing (v1 has no such parameter) but gives no reason for resume. The helper's v1 `task_id` branch (:70) is dead code. The caller-resume branch (:72) writes the v2 `sessionID` key even on v1, a latent bug once a v1 leg is added. | open |
| QA-3.2-8 | minor | helper `:78`; test `:286-289` | Fixed-sleep timing. The v2 advisory-background `running` assertions depend on a hard-coded 500 ms delay in every `LEAF_DONE` reply; the comment says this delay is what keeps the native result `running`. Nothing measures the margin and no host signal sets it, so a slow host can change the outcome. The same sleep slows every leaf reply on both hosts. This is local evidence only, because v2 is not in CI. | open |
| QA-3.2-9 | minor | `phase-3.2.md:44-45`; `test/smoke/deferred-catalog.smoke.test.ts:102-121,197` | The phase-2.3 "To 3.2" handoff was neither applied nor recorded as deferred-by-plan (A15). It says the deferred-catalog log lookup ignores the `XDG_DATA_HOME` its child inherits. The report only works around it in the outer runner. Once 3.4 adds the new file to `smoke:keyless`, a developer whose shell sets `XDG_DATA_HOME` still gets a false deferred-catalog failure. The new file is not affected: it sets XDG_* per fixture (:51) and reads the `--print-logs` output. | open |
| QA-3.2-10 | nit | test `:267` | Tautology. `run.childID` is defined (:127) as the `sessionID` of a hook whose `parentID === run.rootID`, so this `.some(...)` is always true once :266 passes. | open |
| QA-3.2-11 | nit | helper `:80-84,102-105` | The SSE event order matches the Anthropic Messages stream: `message_start`, `content_block_start` (tool_use with `input: {}`), `input_json_delta`/`text_delta`, `content_block_stop`, `message_delta` with stop reason and usage, `message_stop`. There are three deviations. Errors are HTTP 500 `{error: string}`, not the `{type:"error",error:{type,message}}` shape; because the SDK retries 5xx, a fixture fault can be re-captured before `errors` reports it. The non-stream branch silently drops a scripted `tool`/`input`. There are no `ping` events. Every captured request was streamed, so the current results are unaffected. | open |
| QA-3.2-12 | nit | test `:14,183,232,279` | The comment at :232 says "Empty enforcement is the unset control", but the baseline override is `{}` (:183). The expected D5 and banner texts are imported from `src` (:14), so this e2e follows any wording change rather than pinning it. Pinning presumably lives in the unit/golden tests (not verified here). | open |

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
- V2 host legs remain local evidence: the CI lane has the pinned v1 binary, not v2.

## Handoffs

- **To 3.3/3.4:** open a follow-up issue to make deferred-catalog's log lookup honor
  `XDG_DATA_HOME`, or remove that variable in its child environment. Carry the clean-env
  workaround until fixed. No issue was opened by this dispatch; this is an explicit
  follow-up, not a claim that the earlier 2.3 isolation handoff was implemented.
- **To 3.4:** append `test/smoke/depth-effort.smoke.test.ts` to `smoke:keyless`.
  Also append it to `smoke:v2`; its `RUN_OC_SMOKE_V2` gate enables only the v2 describe
  when `OPENCODE_V2_BIN` is configured. Do not make v1 proof depend on v2 availability.
- **To 3.1:** document independent host nesting limits and dispatch permissions;
  v2 resumes direct children only; advisory results preserve the v2 session envelope.
  Captured root titles, separate graders and the next orchestrator request have no
  bumped effort (cross-session isolation). The same-producer-session A3 identity gate
  is integration/unit evidence, not a host claim. This is not live-provider acceptance.
- **To QA:** inspect mutation sensitivity, full registry equality, native envelope
  preservation and the fact that observer plugins do not implement either feature.

## Verdict

**QA 3.2 round 1 (2026-10-05): changes required.** Open findings: 12 (1 major, 8 minor, 3 nit).
The DoD needs zero open findings, so this phase is not accepted yet.

What holds:

- **Core proofs.** Bump on gives producer efforts low → medium and bump off gives low → low. Foreground
  depth gives the exact D5 text and exactly one banner. Each of these assertions failed under a
  config-only mutation on both hosts (see QA-3.2-2 for the revision caveat).
- **No empty-capture passes.** `run()` requires exit 0, no fixture errors and a final `ok`. Each scenario
  requires its `find` to hit, and the bump leg requires each role to be present.
- **Observers.** The observer plugins only log and add headers. They implement neither feature.
- **Isolation.** The fixtures strip `OPENCODE_*`, `XDG_*`, `MODEL_ROUTER_*` and provider variables, and
  repoint HOME, USERPROFILE, XDG_*, APPDATA, LOCALAPPDATA and the temp directories.
- **CI v1 leg.** It should run once 3.4 appends the file to `smoke:keyless`:
  - same `RUN_OC_SMOKE_KEYLESS` gate and the same `opencode` on PATH as `registration`/`deferred-catalog`;
  - the opencode-ai 1.18.19 postinstall links the native binary into the npm bin, so SIGKILL reaches the
    real process, not a Node wrapper;
  - the plugin loads from `main: ./src/index.ts`, with no build step;
  - the v1 child gets `subagent_depth: 4` and `general` `task: allow`, as the spikes needed.

  Not verified: a run on Linux. Locally the v1 leg takes 181-208 s, which fits the 10-minute job, but the
  workflow's "~40s" comment will be stale (3.4).
- **Cleanup after the QA reruns.** No process had `omr-`, `p32` or `depth-effort` in its command line, no
  `omr-depth-effort-*` temp directory was left, and the set of OpenCode processes matched the set before
  the runs. The pre-existing OpenCode 2 service and the TUI sessions were left untouched.
