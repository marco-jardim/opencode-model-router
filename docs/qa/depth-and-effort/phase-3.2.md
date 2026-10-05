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
| (d) No auxiliary/session leak | PASS | PASS | Title, graders and orchestrator all actually requested and have no effort; last request is the orchestrator's |
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

## Findings

| ID | Severity | Finding | Disposition |
|---|---|---|---|

## Deferred by plan

- Full suite and global QA are owned by the orchestrator/3.3; not run in this dispatch.
- Package script and release changes belong to 3.4.
- Live-provider acceptance, pricing and latency are not proven by this keyless fixture.
- V2 host legs remain local evidence: the CI lane has the pinned v1 binary, not v2.

## Handoffs

- **To 3.4:** append `test/smoke/depth-effort.smoke.test.ts` to `smoke:keyless`.
  Also append it to `smoke:v2`; its `RUN_OC_SMOKE_V2` gate enables only the v2 describe
  when `OPENCODE_V2_BIN` is configured. Do not make v1 proof depend on v2 availability.
- **To 3.1:** document independent host nesting limits and dispatch permissions;
  v2 resumes direct children only; advisory results preserve the v2 session envelope.
  Effort bumps are verified on producer requests only; titles, graders and the next
  orchestrator request retain their own options. This is not live-provider acceptance.
- **To QA:** inspect mutation sensitivity, full registry equality, native envelope
  preservation and the fact that observer plugins do not implement either feature.

## Verdict

pending QA
