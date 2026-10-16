# Phase 0.1 — Host contract pins and ADR 0007

Worktree `D:\git\omr-cpx-p01`, branch `cpx/p01`, base tag `cpx/p01-base` = `584e0cf` (then fast-forwarded to
`cpx/main` `6891570`, which carries the revert `9943abe` and amendment A-0.1-1). Started 2026-10-10 20:37.

## Pre-flight

§0.9:
- [x] Depends on 0.P: done (`D:\git\omr-cpx-main\docs\qa\critical-path-execution\preflight.md`, verdict done; 7
      minor/nit deferred to the DF-1 pre-flight, none in this phase's files).
- [x] No phase in flight; no write-set overlap.
- [x] Worktree created from `cpx/main`, tag `cpx/p01-base` set and pushed, `npm ci` ran (357 packages), `git status` clean;
      branch pushed with upstream `origin/cpx/p01`.
- [x] `npm run typecheck`: exit 0. Scoped baseline of the owned files' tests:
      `npm run smoke:keyless` (v1 1.18.35 first on `PATH`, `OPENCODE_CONFIG_DIR` removed,
      `OMR_SMOKE_EVIDENCE_DIR=$env:TEMP\omr-evidence`): **5 files passed, 27 tests passed, 11 skipped** (v2-host halves
      not requested), 368 s. It includes `test/smoke/helpers/scripted-provider.test.ts`. Failing list: empty.
- [x] Anchors re-verified by explorer (`ses_ed7d1437fffefP40S5OZKDZqXM`). All hold except two drifts:
      `routing-host.ts` "plugin list ≈776" — the `plugins` array is at ≈799 (≈776 writes the probe file; the
      plugin-state wait list is ≈826); `stop()` is at ≈842 (a memoised wrapper over `doStop` ≈843-872; ≈870 is the root
      removal inside it). `v2-client.ts` child runner spans ≈96-230.
- [x] Existing tests whose subject is an owned file: `test\smoke\helpers\scripted-provider.test.ts` (no longer owned,
      see A-0.1-1); `routing-host.ts` has none; `package.json` → `test\unit\packaging.test.ts` (the `files` allowlist).
      No other phase in flight.
- [x] `smoke:cpx` — not applicable (Wave 0 creates it).
- [x] `src\executor\types.ts` — not applicable (Phase 1.4).
- [x] This report exists; the handover lists the phase as running.

Phase items:
- [x] Harness read (explorer report pasted into the 0.1.0 dispatch): `HostOptions` ≈649-698, `RoutingHost` ≈708,
      `boot` builds env/config/plugins ≈765-830, `spawn` ≈816, `stop()`/`doStop` ≈842-872, isolation ≈765-768 and
      ≈812-814, scripted provider error path ≈108-111 and usage ≈130-133.
- [x] `test\smoke\probe\probe-plugin.js` is a throwaway spike file, not used by the harness (the harness embeds
      `PROBE_PLUGIN` ≈417 and writes it to `<root>\probe-plugin\server.mjs`); it hard-codes a log directory inside the
      off-limits main checkout, so the new probe must not copy that pattern.
- [x] Background tests `test\smoke\role-spikes.smoke.test.ts` ≈211-218, ≈706-725 and the child runner
      `src\compat\v2-client.ts` ≈96-230 read.
- [x] `@opencode/client` 2.0.22 resolves through `node_modules\@opencode\plugin\node_modules\@opencode\client` (not
      top-level); `loadClient` ≈134-144 tries that path.
- [x] Evidence writing: `runScenario` (`routing-host.ts` ≈1062-1077) always writes
      `docs\qa\cost-aware-routing\evidence-3.2\<id>.json` (tracked) — 0.1.0.e adds the `OMR_SMOKE_EVIDENCE_DIR` override.

Pre-flight finding, fixed by amendment:
- **A-0.1-1.** `test\smoke\routing-engine.smoke.test.ts` scenario `6-v1-untouched` pins `scripted-provider.ts`, its
  test, `fetch-safe-port.ts`, the four v1 smoke files, `vitest.smoke.config.ts`, `test\setup\smoke-tmp-guard.ts` and
  `scripts\smoke-v1-preflight.mjs` byte-identical to `V1_BASE_COMMIT` `bd1ecd1` (v1 feature freeze). The plan had 0.1.0
  (and 6.1.1) write `scripted-provider.ts` / `scripted-provider.test.ts`. Amended in `cpx/main` (`6891570`): the
  additions go to a new `test\smoke\helpers\cpx-scripted-provider.ts` + test that reuse `ScriptedProvider` unchanged,
  and `smoke:cpx` runs the new unit tests. The same pin showed that the 0.P fix `46dac26` (deferred-catalog smoke)
  broke the freeze; reverted in `9943abe`.

## Implementation notes

| Task | Dispatch | Commit(s) | Result |
|---|---|---|---|
| 0.1.0 harness | implementer `ses_ed7caa421ffe2GuCUQq18En3n1` | `06e9840` | `HostOptions.extraPlugins`, `RoutingHost.restart()`, `HostOptions.provider` → `CpxFront` in front of the host's `RoutingProvider` (faults rate-limit / overloaded / usage-limit, later invalid-request; per-request delay; cache usage fields; request capture), `evidenceDir()` honouring `OMR_SMOKE_EVIDENCE_DIR`. Note: the host uses its own `RoutingProvider`, not `ScriptedProvider`, so the front wraps any fixture; `CpxScriptedProvider extends ScriptedProvider` exists for standalone use. `cpx-scripted-provider.test.ts` 22 → 24 tests, green. v1-frozen files byte-identical (A-0.1-1). |
| 0.1.1 probe | implementer `ses_ed7c5ff2dffeQKgDuOStO4Kr40` | `b996991` | `test\smoke\probe\cpx-probe-plugin.js`, default export `{ id, setup(ctx) }`, loaded through a generated plugin directory (`server.mjs` + `package.json` exports) whose preamble sets the probe env. |
| 0.1.2 observation smoke | implementer `ses_ed7c16461ffeBRBUvVmPUV3FQ6` (3 batches + C14 hooks) | `aef7992`, `a138c8c`, `4b1af17`, `8592eb3` | `smoke:cpx`, `smoke:cpx:provision`, `smoke:cpx:e2e` scripts (`smoke:cpx` also runs the provider unit tests, A-0.1-1); C1–C15 in observation mode, one `C<n>.json` per contract under `%TEMP%\omr-cpx-probe`. |
| 0.1.3 three runs | orchestrator shell | — | First set: runs 1 and 3 failed in C7 only — a race between the C7 failure mechanism (a fixture error) and `callMany`'s `provider.errors` abort (isolated C7: FAIL, FAIL, PASS). Fixed deterministically in `1e8566b` (the failing child gets a non-retryable `invalid-request` fault from the front; isolated C7 4/4). Second set: 3/3 green (39/39 each, 415-433 s). Digest of the three sets: `tmp\cpx-obs\digest.txt` (gitignored), variance recorded in the ADR evidence table. |
| 0.1.4 ADR text | architect, heavy pin `ses_ed780d877ffeBExnn0buXlUxCE` | — | Branches decided; D5 withdrawn (C6 does not hold); C12 does not hold for children in flight; launcher A; tail as a last `user` message; `maxParallel` clamp 8; C10 signals are `session.retry.scheduled` fields; open observations O1–O10. |
| 0.1.5 ADR file | orchestrator shell (verbatim copy of the 0.1.4 text; takeover: mechanical copy) | `54531a8` | `docs\adr\0007-critical-path-execution.md`; one link fixed (`phase-0.1.md`). |
| 0.1.6 assertions | implementer `ses_ed7c16461ffeBRBUvVmPUV3FQ6` | `ddb0376` + C15 check fix | Every contract asserts its decided branch (`C<n>/D<k>` in the message) after writing its observation; O1–O6 observed and asserted (O3: 8 concurrent retained launches; O5: a successful compaction carries the placeholder; O6: `session.synthetic` with `resume: true` wakes an idle parent). The C15 "original kept" check now uses a pre-compaction snapshot and the full message log, because a successful compaction collapses `session.context`. |

## Findings

### Round 1 (heavy reviewer `ses_ed735b776ffeBl88hVndizsRn5`, at `97b210e`) — 16 findings (2 critical, 6 major, 7 minor, 1 nit)

| Id | Sev. | Finding (short) |
|---|---|---|
| QA-0.1-1 | critical | C6/O8 decided without the plugin API's own `CacheHint` (`part.cache = {type, ttlSeconds}` → `cache_control ttl "1h"`); D5 likely withdrawn wrongly; under D4 the auto tail breakpoint lands on the volatile tail |
| QA-0.1-2 | critical | C14 never observed the router on retained children (enforcement off; "router" evidence was the harness probe's own evaluate hook); agent/model binding not shown |
| QA-0.1-3 | major | ADR evidence/decision tables contradict the O-items and the current smoke (stale keys, 3+3 vs 8 children, C15 failed vs succeeded); runs not identified |
| QA-0.1-4 | major | "Resolved" O-items and ADR facts not pinned (O4a/O4b fate, O5 full log vacuous, O6 resume:false, D13 providerID source, D14 decision rows / first-context order) |
| QA-0.1-5 | major | O3 8-way proof relies on a fixed 3 s hold |
| QA-0.1-6 | major | C12 "woke after restart" not measured; child A's end races the kill |
| QA-0.1-7 | major | C10 usage-limit evidence is the test's own invented body; reset pattern fitted to it; `session.hook("retry")` not evaluated; "never" unscoped |
| QA-0.1-8 | major | ADR departs from the plan with no recorded amendment (D5, C10 branch, D6 classes and age, D13 range, launcher A vs plan 1.4/3.1/D15) |
| QA-0.1-9 | minor | C9 keys of unadvertised `list`/`router_run` are the test's own input |
| QA-0.1-10 | minor | C9 model-side evidence taken from the latest tool-result request, whichever call |
| QA-0.1-11 | minor | C15 summary check vacuous; held text not a real completion; `succeeded` accepted any non-failed status |
| QA-0.1-12 | minor | O4b depends on the probe replacing the retained `signal`/`progress` |
| QA-0.1-13 | minor | O6/interrupt/context proven only through the HTTP client, not the plugin session API |
| QA-0.1-14 | minor | Observation files collide across runs; teardown leaks silent; `afterAll` stops at the first error |
| QA-0.1-15 | minor | 0.1.0 harness additions (`restart`, plugin order, front wiring, listen slicing) had no unit tests |
| QA-0.1-16 | nit | Missing `DECISIONS` entry passes silently; empty `smoke:cpx:*` scripts; `hostVersion` throws pre-observation; preamble bypasses the credential check; O2 pin landed after the cited commit |

### Round 2 (heavy reviewer `ses_ed6d2b4f0ffemMGmg0LRz4rF5A`, at `c05fc6a`) — 13 findings (5 major, 6 minor, 2 nit)

QA-0.1-17 (major) D5 reinstated without testing the full 1-hour layout (tools, first and last system part, message) and the provider's TTL ordering rule; -18 (major) the O11 real-provider gate was open-ended ("or the first DF session"); -19 (major) launcher A's binding timing unproven (`progress` awaited before the child's first context; session move); -20 (major) quota / host-ended rate-limit attempts counted toward `maxAttempts`; -21 (major) 3.1.4.a launcher prompt order and stale acceptance; -22 launcher B leftovers; -23 ADR facts stated as checked but only recorded (C5 marker count, C6 both requests, C10 persistent 529, retry hook on usage limits, headers, C13 empty children, C14 refusal count, decision-row control); -24 C12 delivery measured loosely (last parent request, new process after restart, long absence waits); -25 the runner could use the retained `signal`/`progress`; -26 `router_git_*` tools missing from the D7 table; -27 capacity signals on retry-hook stops and quota calls; -28 (nit) probe agent log and stale C10 comment, report rows for QA-0.1-3/-8; -29 (nit) observation run dirs never pruned.
## Fixes

### Round 1

| Id | Fix | Commit |
|---|---|---|
| QA-0.1-1 | Probe sets `cache: {type:"ephemeral", ttlSeconds:3600}` on the last system part (`cache-hint-1h`) and on the last real message (`cache-hint-1h-message`); C6 asserts the observed branch: **1 h ttl reaches the wire on both** → C6 holds, D5 to be reinstated in the ADR. C5 adds `append-tail-user+hint-last-real`: with a manual hint on the last real message the wire breakpoint moves to that message and off the tail (asserted, both requests); plain user tail → breakpoint on the tail. | `672c727`, `4f63434` |
| QA-0.1-2 | C14 runs the router **enforced**; children launched as `cpx-child` with an explicit `model`; each child repeats a `read` so the router's guards refuse (`DENIED:`); per-child checks for agent, wire model, read hook and a router refusal; a `withoutRouter` control host shows no refusal. | `672c727` |
| QA-0.1-3 | ADR regenerated from the round-1 runs. | `25d2ec4` |
| QA-0.1-4 | O4a/O4b fates, O5 full log (`anyApiReturnsPreCompaction`), O6 `resume:false` no wake, D13 `session.step.started` `model.providerID`, D14 `routerDecisionRows === 0` and first-context-before-first-tool are asserted. | `4f63434` |
| QA-0.1-5 | C14 batch 1 parked with `Gates` until all 8 wait at once (`peakWaiting === 8`). | `672c727` |
| QA-0.1-6 | C12 waits for A's terminal line and stored completion before `restart()`, classifies the wake against the restart window, and asserts exactly one stored completion and one wire delivery for A. | `4f63434` |
| QA-0.1-7 | CpxFront usage-limit variants; host classification observed and asserted: "usage limit" wording → `provider.quota` (with or without reset sentence or headers), the control 429 → `provider.rate-limit`; only the message text carries the reset time (headers are not surfaced); persistent-fault claims scoped to the 75 s window; `session.hook("retry")` observed, and setting `decision = {retry:false}` makes the host fail the step (`retry-stop` branch "stops"). | `b95f74a` |
| QA-0.1-8 | Plan amendment A-0.1-2 in `cpx/main`. | `71242b2` |
| QA-0.1-9 | Unadvertised `list`/`router_run`: only `advertised === false` asserted; keys recorded as unobserved. | `b95f74a` |
| QA-0.1-10 | C9 model-side request selected by `tool_use_id`; `promptError` asserted undefined. | `b95f74a` |
| QA-0.1-11 | `status === "completed"` required; summary claim dropped; C15-real compacts a session holding a real `<subagent>` completion with completion+compaction rewrites; asserted placeholder on the wire, no raw envelope. Observed: the host compacts the history except the latest turn when the session has more than one turn. | `b95f74a`, `7b11504` |
| QA-0.1-12 | The probe records whether the retained `signal`/`progress` were replaced; a host launches with the retained signal (recorded). | `672c727` |
| QA-0.1-13 | O6b drives `ctx.session.context` / `interrupt` / `synthetic({resume:true})` from the plugin; asserted. | `b95f74a`, `7b11504` |
| QA-0.1-14 | Per-run observation dirs + `latest`; teardown result asserted; `afterAll` collects errors. | `4f63434` |
| QA-0.1-15 | `test\smoke\helpers\routing-host.test.ts` (stub host via mocked spawn): plugin order, front wiring, `restart()`, listen slicing, `evidenceDir`; run by `smoke:cpx`. | `1332166` |
| QA-0.1-16 | Missing `DECISIONS` entry throws; `hostVersion` never throws; credential-shaped preamble keys refused; `smoke:cpx` includes the harness tests. `smoke:cpx:provision`/`:e2e` stay as specified by the plan (their files arrive in 2.4 and 6.1) — recorded. | `4f63434` |

Post-phase smoke checks (orchestrator shell, 2026-10-10/11): `npm run smoke:keyless` 5 files, 27 passed, 11 skipped (= baseline); `routing-engine.smoke.test.ts` scenario `6-v1-untouched` passed; full `routing-engine` smoke 12/13 — scenario `5-advisor` fails **also at the phase base** (`cpx/p01-base`, scratch worktree, same message), so it is pre-existing on OpenCode 2.0.26 (PF-4, recorded in the handover), not caused by this phase.

### Round 2

| Id | Fix | Commit |
|---|---|---|
| QA-0.1-17 | C6 `all` variant: 1 h hints on the first and last system part, the last tool and the last real message. Observed on 2.0.26: system and message blocks carry `ttl:"1h"`, the tools breakpoint keeps the host's 5-minute marker (no cache field on the context event's tools), so the provider's TTL order would be violated → **D5 withdrawn** (ADR 0007, A-0.1-3); Phase 1.2 built without D5. | `6e9b645`, ADR `915b96a` |
| QA-0.1-18 | O11 moot with D5 withdrawn; "or the first DF session" removed. | ADR/plan `915b96a` |
| QA-0.1-19 | Probe `progress` awaits 2 s and calls `ctx.session.move`; C14 asserts `progress` resolved before each child's first context hook and every move ok (2 batches × 8 children). | `6e9b645` |
| QA-0.1-20 | `capacity` and `lost` outcomes uncounted (ADR D13, executor contract `src\executor\types.ts`). | ADR `915b96a`, 1.4 |
| QA-0.1-21 | Launch prompt order PLAN CONTEXT → header → TASK (ADR D14, plan 3.1.4.a, `formatLaunchPrompt`). | ADR/plan `915b96a`, 1.4 |
| QA-0.1-22 | Launcher B removed from ADR D14, C11, D15, the 3.1 row and the consequences. | `915b96a` |
| QA-0.1-23 | Asserted: C5 1–4 markers with exactly one message marker per request; C6 per request (≥ 2 requests); C10 no `step.failed` and no terminal event within 75 s for 429 and 529; usage-limit retry hook receives `{retry:false}`; no `headers` field reaches the error (a `response.body` with the provider's JSON does — recorded as `responseBodySurfaced`); C13 non-empty children; C14 `signalReplaced`/`progressReplaced`, duplicate-read refusals 5 of 6 per child, and a decision-row positive control (waits for the flushed row of an ordinary call, then recounts the retained children from the same read). Retry delays recorded, not asserted. | `582f309`, `4072d97` |
| QA-0.1-24 | C12: A's completion exactly once in the last parent request, no wake for A after the restart, a second probe `loaded` line from a new pid, absence waits 10 s. | `582f309` |
| QA-0.1-10 (re-opened) | C9 requires `selectedBy === "tool_use_id"`; the fallback is recorded and fails. | `582f309` |
| QA-0.1-25 | ADR D14: launches never use the retained `signal` nor forward `progress`. | `915b96a` |
| QA-0.1-26 | ADR D7 table: `router_git_*` row; `shell`/`execute` not covered (Phase 1.3 `toolTargets`). | `915b96a` |
| QA-0.1-27 | ADR D13 capacity-signal bullet. | `915b96a` |
| QA-0.1-28 | Probe logs `childAgent ?? chosen.agent`; stale comment replaced; report rows above. | `6e9b645` |
| QA-0.1-29 | `pruneOldRuns()` keeps the 5 newest run dirs (8-hex names only). | `6e9b645` |

Smoke runs on 2.0.26: full contract file at `582f309` (16/18; the two failures were the new C10 header check over-matching a body-only `response` and the C14 control reading before the 30 s flush — both checks corrected in `4072d97`); C10 and C14 re-run at `4072d97` green.
### Round 3 (heavy reviewer `ses_ed5c949ecffet2FVBH5Vxy4oBH`, at `915b96a`; majors only) — 2 major

QA-0.1-18, -19, -21 fixed; -17 fixed in smoke/probe/ADR/src; -20 counting fixed. New: QA-0.1-30 (major) `provider.internal` with any status classified as capacity (contradicting ADR D6/D13 and the timing classifier; a persistent 5xx would loop uncounted) → fixed: overload only at 529, consistency test against `classifyCapacity` (`558e5b8`); QA-0.1-31 (major) live plan text still required the withdrawn TTL (1.2.3 block, 1.2.5 Reads/acceptance, G4) → fixed (`558e5b8`, A-0.1-3 log).
Recorded, not fixed (minor/nit): the withdrawal premise (tools breakpoint stays 5-minute) is recorded, not asserted, and two C6 check texts still say "D5 decision"; the ADR evidence header names `7b11504` and the D5 withdrawal / C14 binding cite no run; `progressTookMs ≥ 2000` and `directoryAfter` not asserted; D13 does not mention `interrupted` as uncounted; ADR/plan show the launch header without ` nonce=<32 hex>`, and 3.1.4's acceptance does not pin the prompt order (3.1 owns it); O11(b) wording; probe-mode list misses `cache-hint-1h-all`.

Final gate (orchestrator shell, 1× by the owner's decision): `npm run smoke:cpx` at `915b96a` — 4 files, 52/52 passed (host contract incl. all round-2 checks, cache-prefix, harness tests); `npm run smoke:keyless` (OpenCode 1.18.35 on PATH) — 27 passed, 11 skipped (= baseline); typecheck 0.
## Deferred findings

- Round-3 recorded minors above: ADR wording items go to the Phase 6.1 ADR finalization (the plan schedules ADR finalization there); the launch-header nonce and prompt-order pins go to 3.1 (owner of the launcher and its tests).

## Handoffs

- Phase 1.2 built without D5 (withdrawn); 1.4 carries QA-0.1-20/-21/-25 in the executor contract; 1.3 carries QA-0.1-26 in `toolTargets`.

## Verdict

PASS after QA round 3 (round-3 majors QA-0.1-30/-31 fixed in `558e5b8`; no round 4 by rule).
