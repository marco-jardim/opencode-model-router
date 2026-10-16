# Phase 2.2 — Durable ledger store

Worktree `D:\git\omr-cpx-p22`, branch `cpx/p22`, base tag `cpx/p22-base` = `558e5b8`. Started 2026-10-11 06:17.

## Pre-flight

- [x] Depends on: merged into `cpx/main` (Wave 1 merges `12d42b7`, `6d310eb`, `d4d731b`, `a9e32c1`; 0.1 final `915b96a`).
- [x] Worktree from `cpx/main` at `558e5b8` (tag `cpx/p22-base`, pushed), `npm ci`, clean; typecheck green; `smoke:cpx` 52/52 and `smoke:keyless`/`smoke:v1` = baseline at `915b96a`.
- [x] Anchors and task list (explorer `ses_ed5b8fcf1ffekca1nfk7hM00V2`): no write-set overlap between Wave-2 phases; within 2.1, `src\index.ts` (2.1.4 then 2.1.6) and `docs-drift.test.ts` (2.1.2 then 2.1.7) are sequential.
- [x] `src\routing\file-lock.ts` `withLock` uses a 30 s mtime stale model; 2.2.2.e needs pid + heartbeat: the ledger lock is its own implementation (file-lock.ts stays read-only).

## Implementation notes

- 2.2.1 (implementer `ses_ed5b63587ffe5TGkCUmyYxWAtb`): `src\executor\paths.ts` — `resolveExecutorHome` = `realpath(resolve(dir, git rev-parse --git-common-dir))\omr-executor` (never under `worktrees\<id>`), `planDir`, `slotMarkersDir`, `newPlanId` = `p-<yyyymmdd>-<6 hex of sha256(planPath+digest+options)>`; injected git/realpath seams.

## Findings

Three QA rounds.

- Round 1: 14 findings (QA-2.2-1 to -14), fixed in `48df526`. The commit names -1 to -12 and -14; -13 is not named in the commit message.
- Round 2: 9 findings (QA-2.2-15 to -23), fixed in `257277f`. The commit names -15 to -20, -22 and -23; -21 is not named in the commit message.
- Round 3: 1 finding.
  - QA-2.2-24 (major): fixed in commit `073e5bf`.

## Fixes

- Round 1, `48df526`: writer epochs in journal names, per-holder beat files, lock checks before every destructive step, exclusive creates and guarded takeovers (-1/-2/-5); rolled-back integrations reopen (-3); exact adopt reason (-4); rotation and snapshot ordering (-6/-7); create cleanup (-8); store-stamped lock tokens (-9); UNC checks after resolve (-10); async dir fsync (-11); live wake keys (-12); reserved plan id slots (-14).
- Round 2, `257277f`: per-epoch snapshots (-16), history repaired before journal deletion (-17), lock-aware deletes with a removal tombstone (-18), rotation after an unacknowledged batch (-15), unknown outcome on E_LOCK_LOST documented (-19), drafts with integrating tasks refused (-20), Windows device names refused as plan ids (-22), dead state removed (-23).
- Round 3, `073e5bf`: QA-2.2-24 (fenced appends never re-create a journal; history repair follows the loader's trust rules).
- Coverage top-up `fe3a178` (tests only): raised `src/executor/ledger.ts` branch coverage, which was 89.86 before it, above the CI gate.

## Coverage

Measured by the orchestrator on 2026-10-12 with `npx vitest run --coverage` on `test/unit/executor-ledger.test.ts`, `test/unit/executor-ledger-coverage.test.ts`, `test/unit/executor-paths.test.ts` and `test/integration/executor-ledger-crash.test.ts`: 248 tests passed.

| File | Statements | Branches | Functions | Lines |
| --- | --- | --- | --- | --- |
| `src/executor/ledger.ts` | 97.59 | 96.01 | 98.88 | 98.14 |
| `src/executor/paths.ts` | 97.95 | 94.73 | 100 | 100 |

- CI gate: per file 90/90/90 on `src/executor/`; both files are above it.
- Top-up commit `fe3a178` is tests only (`ledger.ts` branches were 89.86 before it).
- Minor note: eight `src/executor/ledger.ts` branches cannot be reached without `src` changes: `sameStrings` at line 303 (never called); the `?? ""` fallbacks at lines 91/94; line 527; line 546 (empty migration table); line 964; line 1036; line 1187; lines 1338/1339. Left for a later cleanup (see Deferred findings).

## Deferred findings

- Minor, later cleanup: the eight unreachable `src/executor/ledger.ts` branches listed under Coverage. Removing or covering them needs `src` changes; the coverage top-up in this phase was tests only.

## Handoffs

- To 3.2: the A1-3a rolled-back exemption and `resume()`.
- To 3.2: `E_LOCK_LOST` means the outcome is unknown; callers must treat it as such.

## Plan amendments

- A-2.2-1: plan 2.2.2.b names single snapshot/journal files. The implementation uses per-epoch file names `ledger.<epoch>.json` and `events.<first>.<epoch>.jsonl`, plus per-holder beat files. The plan text is amended to match (applied by the orchestrator in `cpx/main`).

## Verdict

Done, pending merge into `cpx/main`.
