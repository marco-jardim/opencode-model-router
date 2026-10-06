# Dogfood — the cost-aware routing plan measures itself (#74)

> Workload caveat: the workload is this plan's own execution (implementation-heavy, QA-heavy, pinned heavy dispatches). The numbers are evidence of behaviour, not a benchmark.

## DF0 — baseline (Phase 0.P, 2026-10-06)

**Mode after checkpoint:** `static` (no `routing` block).

**Active config.** Plugin loaded from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:189`); bundled `D:\git\opencode-model-router\tiers.json` + `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` `{"activePreset":"hybrid-2","activeMode":"normal","enforcementMode":"advisory"}`; no global or project override file. Preset `hybrid-2`: `@fast=gpt-6-luna-fast/medium(1x) @medium=claude-sonnet-5-5/xhigh(5x) @heavy=claude-opus-5-5/xhigh(20x)`. Checkpoints edit `routing.*` in `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (plan amendment A6).

**Cost unit for every checkpoint.** All tier models of the live `hybrid-2` preset are unpriced in the live catalog (`openai/gpt-6-luna-fast`: `cost []`; `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`: all-zero prices — plan amendment A1). Decisions, estimated savings and D17 inputs in DF1–DF5 are therefore in **`costRatio` units** (fast = 1), never USD.

**Source.** `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory\*.scorecard.log`, files last written in `[2026-10-05T00:00, 2026-10-06T00:58)` local time (the planning window, ending at the plan file's last write). The scorecard carries no parent session id, so the window may include child sessions of other concurrent sessions.

| Metric | Value |
|---|---|
| Child sessions with ≥1 scorecard line | 413 |
| by tier | fast 73 · medium 194 · heavy 74 · no tier 72 |
| of those, `tool_calls=0` on every line | 0 |
| last-line stop reason | none 224 · read_budget 95 · iteration_cap 78 · anti_self_script 13 · redundant_read 2 · cumulative_iteration_cap 1 |
| verdicts | not recorded by the scorecard |

**Bias: the baseline undercounts exactly the false refusals.** A scorecard is written on `session.idle` only when the session has guard state (`D:\git\opencode-model-router\src\index.ts:1710–1713`, `guardStore.get(sid)`), which tool activity creates. A child that returns with zero tool calls therefore most likely writes no scorecard at all — which is why the 5 zero-tool `@fast` hand-backs observed during planning (handover §3.4) do not appear, and why "sessions with ≥1 scorecard line" is not a dispatch count. Verdicts are not stored either. Both signals are first measured from DF2 on, by `decisions.jsonl` and the outcome store (D4, D15). Execution session so far (from 2026-10-06 ≈01:00): 2 `@fast` dispatches in Phase 0.P, the first a "no shell" hand-back (re-dispatched, see `run-log.md`).

**Restarts so far:** 0. Expected: one per code sync (DF1–DF4), per spike S7.

## DF1 — after Wave 1 (2026-10-06T09:35Z)

**Mode after checkpoint:** `static` (no `routing` block anywhere; no override file).

**Sync:** `master` fast-forwarded to `car/main` @ `88847cb` (Phases 1.1, 1.2, 1.3, 1.4, 1.5 merged, each QA PASS with 0 open findings; plan amendments A14–A26). Rollback tag `car/sync-1-prev` = previous `master` (`3b3dba4`). `package-lock.json` unchanged → no `npm ci` in the base checkout. Capped full suite on `car/main` @ `88847cb`: 127 files passed, 3 skipped; 11 036 tests passed, 66 skipped.

**Liveness:** code sync requires a host restart (A8). Probe after restart: `/router` must show `router: engine=static build=2.2.0+88847cb` (first 7 of the synced sha); the live protocol text and `R:` line must be byte-identical to 0.P.3 (v2-adapted SHA-256s pinned in Phase 1.4).

**`routing:stats` (DF0 → DF1):** `node scripts/routing-stats.ts` → `routing-stats: no outcome data in C:\Users\MARQUI~1\AppData\Local\Temp\opencode-model-router-trajectory`; table all zeros (`Dispatches 0`, agreement `n/a`). Expected: the outcome store and decision log start writing at DF2 (`shadow`).

**Incident in the period:** a Phase 1.1 test run with `--pool=threads` wrote the user's real `opencode-model-router.overrides.jsonc` (`{"routing":{"engine":"enforce"}}`); the orchestrator deleted it at ≈03:25, before any engine code was live (A14; global home guard added). Restart time lost: recorded at resume.
**Liveness result (resume, 2026-10-06T11:41:54Z):** `/router` shows `router: engine=static build=2.2.0+8ce54f2` — the DF1 code is live. Restart wall-clock: sync at 2026-10-06T09:35Z, probe at 2026-10-06T11:41:54Z (includes the human's idle time; not attributable to the restart alone). Live protocol text: not re-captured from the restarted session; byte-identity is enforced by the Phase 1.4 D2 snapshot tests (raw and v2 forms) on the synced commit.

## DF2 — after Phases 2.1, 2.2 and 2.3 (2026-10-06)

**Status:** DF2 complete. Shadow period started at 2026-10-06T15:28:34Z.

**Mode after checkpoint:** `shadow` (override file `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` = `{"routing":{"engine":"shadow"}}`, created at 2026-10-06T15:28:34Z, after the liveness check below).

**Sync:** `master` in the base checkout fast-forwarded to `car/main` @ `2878319` (Phase 2.1 `a08229c`, Phases 2.2 and 2.3 `2878319`; QA PASS on each, plan amendments A27–A29). Rollback tag `car/sync-2-prev` = previous `master` (`8ce54f2`). The sync was done at 2026-10-06T15:22:43Z. Capped full suite on `car/main` @ `2878319`: 137 files passed, 3 skipped; 11 387 tests passed, 66 skipped; 255 s.

**Liveness (inferred, not observed):** code sync requires a host restart (A8). The host restarted at 2026-10-06T15:27:38Z (`opencode.log`, run `998fe258`, `cli starting version=2.0.22`, cwd `D:\git\opencode-model-router`), after the sync at 15:22:43Z, so the synced code (`2.2.0+2878319`) was the code that loaded. The `/router` marker line itself was not captured: liveness was inferred from the restart timing, not read from the `engine=… build=…` line. The restart cost about 4 min 55 s between sync and restart (includes the human's idle time; not attributable to the restart alone).

**`routing:stats` before shadow:** `no outcome data`, every metric 0 (`Dispatches 0`, agreement `n/a`, no store, no decision log).

**Override file:** created at 2026-10-06T15:28:34Z with `{"routing":{"engine":"shadow"}}` (hot reload, no restart).

**First live shadow row:** at 2026-10-06T15:28:41Z, 7 s after the override, in `decisions.jsonl` of the D15 directory: `mode: "shadow"`, `switched: false`, `chosen` = `best` = `router:fast`. The row reached disk in ≈7 s.

**Observation for DF3:** the rules classifier labelled a file-listing task as `review` with confidence 0.5. That is below `routing.minClassConfidence` (0.7), so the dispatch has a decision row but no verdict or refusal rows and nothing is recorded in the outcome store (QA-2.1-10: statistics cover trusted classes only). A listing task should read as `search`/`recon`: DF3 should check how many of the shadow period's rows are below the threshold (`Dispatches` against `Pass + Fail + Unverifiable` in `routing:stats`, and `/router stats`) before judging agreement or savings, and whether the rules need a listing keyword.

**Open owner decision (QA-2.3-13), not blocking:** on `hybrid-2` and `anthropic` the medium/heavy tiers carry `effort`, so ladder escalations never resume and variant steps exist only on the fast tier. Phase 2.4's cost doctor now reports it as the `variant-effort` finding in `/router` (suggesting `candidates` and dropping `effort`).