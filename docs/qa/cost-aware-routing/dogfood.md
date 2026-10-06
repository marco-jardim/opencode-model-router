# Dogfood — the cost-aware routing plan measures itself (#74)

> Workload caveat: the workload is this plan's own execution (implementation-heavy, QA-heavy, pinned heavy dispatches). The numbers are evidence of behaviour, not a benchmark.

## DF0 — baseline (Phase 0.P, 2026-10-06)

**Mode after checkpoint:** `static` (no `routing` block).

**Active config.** Plugin loaded from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:189`); bundled `D:\git\opencode-model-router\tiers.json` + `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` `{"activePreset":"hybrid-2","activeMode":"normal","enforcementMode":"advisory"}`; no global or project override file. Preset `hybrid-2`: `@fast=gpt-6-luna-fast/medium(1x) @medium=claude-sonnet-5-5/xhigh(5x) @heavy=claude-opus-5-5/xhigh(20x)`. Checkpoints edit `routing.*` in `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (plan amendment A6).

**Source.** `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory\*.scorecard.log`, files last written in `[2026-10-05T00:00, 2026-10-06T00:58)` local time (the planning window, ending at the plan file's last write). The scorecard carries no parent session id, so the window may include child sessions of other concurrent sessions.

| Metric | Value |
|---|---|
| Child-session scorecards (≈ dispatches) | 413 |
| by tier | fast 73 · medium 194 · heavy 74 · no tier 72 |
| scorecards with `tool_calls=0` on every turn | 0 |
| last-turn stop reason | none 224 · read_budget 95 · iteration_cap 78 · anti_self_script 13 · redundant_read 2 · cumulative_iteration_cap 1 |
| verdicts | not recorded by the scorecard |

**What the baseline cannot show.** The planning session observed 5 of 12 `@fast` dispatches returning with zero tool calls and a "no tools" claim (handover §3.4), yet no scorecard in the window has `tool_calls=0`: the scorecard counts tool calls across turns and does not flag a "no tools" hand-back, and it stores no verification verdict. Both signals are first measured from DF2 on, by `decisions.jsonl` and the outcome store (D4, D15). Execution session so far (from 2026-10-06 ≈01:00): 2 `@fast` dispatches in Phase 0.P, the first a zero-progress "no shell" hand-back (re-dispatched, see `run-log.md`).

**Restarts so far:** 0. Expected: one per code sync (DF1–DF4), per spike S7.
