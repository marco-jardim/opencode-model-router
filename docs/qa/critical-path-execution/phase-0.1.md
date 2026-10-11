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

## Fixes

## Deferred findings

## Handoffs

## Verdict
