# P3.1 — global QA (#90)

Range `f969139..aa39ccf` (`msd/main`), fixes on `msd/p31-fix-1`.

## Pre-flight

- Capped full suite on `msd/main` `aa39ccf` (runner, `vitest run`, twice): every file green except
  `test/unit/exec.test.ts` › "a deadline after the direct child exited kills what it left running within 3 s" (timeout
  at 65 s, known Windows WMI flake, handover troubleshooting). Re-run alone by the executor: `Test Files 1 passed`,
  `Tests 42 passed | 2 skipped (44)`. Typecheck green.
- CI on PR #91 head `aa39ccf`: all green except `e2e (node 22, windows-latest)` (job 113899429013), whose Windows unit
  coverage step failed one test in `test/unit/runner.test.ts` (E2E-1 pytest mapping; no file of the range is involved);
  re-run with `gh run rerun 37953909877 --failed`. `smoke-keyless` green: run 37953909712 on `aa39ccf` (OpenCode
  1.18.19, T2.1.2 per A13b).

## Owner decision during P3.1

DF-1 dogfood → A12: G3 opt-in (`38d8f42`), real-host smoke adapted and re-run 64/64 on 2.0.24/2.0.25/2.0.26
(`af96cd8`, run `eb2b0172`, including a default-off flow with no running-delegate row while a child runs).

## Round 1 (three heavy reviewers in parallel)

| Area | Verdict | Findings |
|---|---|---|
| A correctness/UX/host API | PASS | GA-1..GA-6 minor, GA-7 nit |
| B packaging/compat/v1 | PASS | B-1..B-3 minor, B-4..B-6 nit |
| C tests/docs/evidence | FAIL | C-1 major (bare package name never loaded on a host), C-2..C-7 minor, C-8..C-11 nit |

Resolution (`1ea4354` code/tests/docs, executor docs commit after it):

| id | resolution |
|---|---|
| GA-1 | reopened views start from the session's last answer (`PullState.value`), tests |
| GA-2 | up to 3 quick re-pulls 1 s apart while running and no effort answered yet, tests |
| GA-3 | residual: `effortOf` for a session of another directory is not run on a host; worst case a 1→30 s retry or the fallback, bounded; recorded |
| GA-4 | effort-channel registration started, not awaited, before the other hooks; test with a never-settling `register` |
| GA-5 | no-owner toast reworded (`render has no Solid owner: the views are static (no live updates)`), docs and pin |
| GA-6 | documented limitation (rows fit the terminal, not the composer); with G3 opt-in the long-row case is rarer |
| GA-7 | G2 uses the same agent fallback as G3 (title, then `subagent`) |
| B-1 | comment corrected; docs state 2.0.24–2.0.26 verified, 2.0.20–2.0.23 not verified |
| B-2 / C-1 | A13a: post-publish bare-name check in P3.2 before #90 closes |
| B-3 / C-2 | A13b: CI `smoke-keyless` run 37953909712 on `aa39ccf` |
| B-4 | packaging pins: no `dependencies`, exact devDependency versions |
| B-5, B-6, C-5 | evidence header and stale names fixed |
| C-3 | tests for the no-owner throwing view and a failing box creation |
| C-4, C-9 | merge SHAs corrected (`2bbfd11`/`3c71fc1`, `7e8350d`) |
| C-6 | `status-model.ts` and `effort-channel.ts` in the merged coverage gate; executor run: 100% statements (284/284) and branches (260/260) over both files |
| C-7 | residual: the `-<id>` selector and its placement rule are cited from host source only; recorded |
| C-8 | DF-1 deviation recorded as A13d; coexistence claim moved to the owner result |
| C-10 | failure strings quoted in `phase-P1.3.md` |
| C-11 | A13c |

## Round 2 (heavy reviewer, `aa39ccf..617a8f2`)

Verdict PASS (553 unit tests in 6 files, goldens 88, typecheck green). Fixes in `d33e0f9`:

| id | resolution |
|---|---|
| R2-1 | real-host smoke re-run on `d33e0f9` (run `169dea3b`): 64/64 on 2.0.24, 2.0.25, 2.0.26, flows local / npm install / default-off; S4 `medium (low)` everywhere equals the wire (`claude-sonnet-5-5#low`, effort `medium`); G3 row 0.1–0.2 s after the child request, ~15 s before its first token; default-off flow: no row in 8 s of polling while the child runs, G2 shows the row |
| R2-2 | quick re-pulls only for delegated sessions; docs and pins |
| R2-3 | timeout message "continuing without it" |
| R2-4 | C-6: the gate measures lines and branches; the executor run reports 100% statements (284/284) and branches (260/260) for `status-model.ts` + `effort-channel.ts`. B-5: evidence header names the commits. B-6/C-5: round-1 test name and fields marked "round 1" |
| R2-5 | 2.0.20–2.0.23 outcome stated as expected, not observed |

On `msd/main` after the merge (`de35c9d`): 14 touched files incl. goldens, 642 passed; typecheck green.

## Verdict

P3.1 DONE: 0 open blocking/critical/major. Residuals: GA-3 (other-directory session), C-7 (selector from source),
A13a (bare package name after publish: gate for closing #90).
