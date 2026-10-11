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

## Fixes

## Deferred findings

## Handoffs

## Verdict
