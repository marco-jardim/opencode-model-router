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

## Findings

## Fixes

## Deferred findings

## Handoffs

## Verdict
