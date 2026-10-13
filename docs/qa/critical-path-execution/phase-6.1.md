# Phase 6.1 — End-to-end proof, documentation and ADR finalization

Runs under DF-2, through the plan executor (DF2.5): compiled with `phases=["6.1"] doneBefore="6.1"`, launched into
slots under `D:\git\.omr-cpx-slots\<planId>`, integrated into `omr/<planId>/integration`, landed into `cpx/main`.
Findings and fixes are written from `router_plan action=status` after the landing (freeze rule, DF-2).

## Pre-flight

Run by the orchestrator on `cpx/main` at `39067ce` (2026-10-13), before approve.

- §0.9: `cpx/main` clean; `tsc --noEmit` clean; Phase 5.1 merged (`272b82d`); the scoped tests of every phase merged
  since DF-1.3 green (76 executor/v2/golden/docs/roles files 4132 passed / 4 skipped after the 5.1 merge; sync-1 set
  187 files 10451 passed).
- `npm run smoke:cpx` green on `cpx/main`: 57/57. Also `smoke:cpx:provision` 4/4 and `smoke:v2` 2/2 (DF-2 pre-flight).
- Scripted-provider features still missing (`test\smoke\helpers\cpx-scripted-provider.ts` and the frozen base
  `scripted-provider.ts`):
  - scripted tool calls that write files: **missing** (tool calls carry an arbitrary name and input; nothing writes);
  - `ESCALATE:` replies: **missing** (fault kinds are rate-limit, overloaded, usage-limit, invalid-request);
  - structured QA findings: **missing** (replies are text or `tool_use` only);
  - per-call durations: **partial** (a scripted delay exists; no per-call duration is recorded on `CpxRequest`).
- `docs\ROLES.md`, `docs\OPENCODE_V2.md` and `docs\EXECUTOR.md` read as merged at `272b82d`: EXECUTOR.md has the 4.2
  sections, "Assembly and lifecycle" and "Verification of plan tasks"; OPENCODE_V2.md says the executor is registered on
  v2 only; ROLES.md "Work roots" covers the trusted slots root.
- Dry-run compile of this plan with the executor compiler (`phases=["6.1"] doneBefore="6.1"`, live repository view):
  - tasks: `6.1.PF1..PF3` preflight, `6.1.1`, `6.1.2`, `6.1.5` task, `6.1.3` tests, `6.1.4` manual, `6.1.QA` qa;
    `6.1.FIX` is a template, not a node (the QA loop creates fix tasks);
  - footprints equal the `Writes:` lines after amendment A-DF2-1, except `6.1.2`, whose `Writes:` is a directory with
    no tracked files and so writes ⊤ (A-DF2-2): a conflict edge `6.1.1 > 6.1.2` serialises the two;
  - 6.1 tasks without an `[acceptance]` block: `6.1.4` (manual) and `6.1.QA` (review); the executor verifies neither.

## Amendments (DF-2 pre-flight)

- **A-DF2-1:** 6.1.1's amendment note names the v1-frozen provider without a path, so the compiler no longer reads
  `test\smoke\helpers\scripted-provider.ts` as a write of 6.1.1.
- **A-DF2-2:** 6.1.2 keeps its directory `Writes:` (the fixture set is not known in advance); it writes ⊤ and runs after
  6.1.1 instead of in parallel. Recorded as a makespan caveat in the 6.1.4 metrics.
