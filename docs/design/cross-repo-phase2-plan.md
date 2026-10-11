# Cross-repo Phase 2 — implementation plan

Design: `docs/design/cross-repo.md` §7. Issue #107. Pre-flight at HEAD `cf17944` (2026-10-10).

## Owner decisions (2026-10-10)

| # | Decision |
|---|---|
| OD1 | **B.** On OpenCode v2, a tier dispatch (task or `delegate`) whose DoD has a per-check `cwd=` is unverifiable: "per-check cwd= is honoured only in roles mode". `scope=` is ignored on tiers. v1 stays inert (feature freeze): the keys are ignored there, documented. |
| OD2 | A consumer check is a `testsPass`, `buildPasses`, `lintClean` or `run` check whose root is in the consumer. `fileExists`/`schemaMatch` do not count. No consumer caveat when W's change set is empty. |
| OD3 | A second-level external link inside a pinned target fails closed: the first-level pin is unusable, so `external-link`. |
| OD4 | P2a–P2d (with the P2.7 interim rule) land first and get their own heavy QA. P2e (deferred P) follows alone, with its own QA. |
| OD5 | The configured roles protocol teaches per-check `cwd=`/`scope=full` (one clause after the cross-repo sentence, `src/router/protocol.ts:66-68`). The configured golden changes on purpose; the default golden stays byte-identical. |
| OD6 | Role dispatches get a location line naming their work root (dogfood finding; the dead "location line" follow-up). Part of Phase 2 (batch P2g). |

Decided under D1–D13 (no owner input): placements resolved by the caller and passed to the gate (SD1); `captureRootOf(scope)` helper instead of a new `VerificationScope` field (SD2); a relative `cwd=` resolves against W and stays in W, anything else must be absolute, without `.git`, inside R (SD3); a refused `cwd=` or an invalid `scope=` makes the whole DoD unverifiable, nothing runs (SD4); placements applied per check inside `runDeterministic`, output byte-identical without placements (SD5); a check in a foreign repository gets reference `none` and its failure is unverifiable, never "fail", never `onFailure` (SD6); I3 across check roots as a new refusal only when placements exist (SD7); any per-check key prevents deferral until P2e (SD8); new keys parsed only at a token boundary (SD9); consumer discovery async and bounded at the gate, over working-set seeds, no git (SD10); pins = P's hardened dispatch snapshot of a link root + bounded digest of its ignored files excluding `node_modules` (SD11).

## Pre-flight findings

| # | Sev. | Finding | Resolution |
|---|---|---|---|
| F1 | blocking | The P2.7 interim rule is not implemented; the only `cross-repo` fallback is `store.perimeterOf(id) !== undefined` (`wiring.ts:1857-1859`). A deferred handle would drop placements. | P2a.3, before the gate honours placements. |
| F2 | minor → blocking for P2e | `prepareClaim` never sets `prepared.perimeter` (`wiring.ts:2135-2149`), read at `:2183`. | P2e.3. |
| F3 | major | Consumer discovery (and the P1 consumer note) does not exist. | P2b.3. |
| F4 | major | A new `captureRoot` field breaks exact-object assertions (`roles.runtime.test.ts:974-979`). | `captureRootOf` helper (SD2). |
| F5 | major | `finishDeferred`'s `input.cwd` is both capture root and stored check base. | Optional `captureRoot` on the finish input (P2a.4). |
| F6 | major | Foreign failures would be reported through `onFailure` and become "fail" (`deterministic.ts:1696-1698`, `gate.ts:175-184`). | P2b.1. |
| F7 | major | The planner resolves relative changed paths against the check cwd (`runner.ts:4411`). | Make them absolute against the change root before foreign placements (P2b.2b). |
| F8 | major | Pinning must use hardened git; `reference.ts` git is not hardened. | Pins ride on P's hardened snapshots (P2d). |
| F10 | minor | Nested workspace links are not perimeter-discovered. | Stay `external-link`; document. |
| F11 | minor | `parseKvPairs` matches `key=` inside unquoted values. | SD9. |
| F12 | minor | The run signal credits W for a check that runs elsewhere. | P2c.2. |
| F13 | minor | `noChangeGateSpawnsNothing` (`wiring.ts:506-508`) ignores `testScope:"full"`. | P2e.2. |
| F15 | minor | The `delegate` path (`index.ts:1443`) is a tier path. | Covered by OD1 (P2b.7). |
| F16 | minor | Stale line references in §7. | P2f. |
| F17 | minor | I3 means a DoD whose only check is a consumer check cannot pass. | Read I3 literally, fail closed. |
| F19 | minor | `work-root.ts` cannot import `read-set.ts` (cycle); `gitTopOf` is private. | New `src/routing/roles/check-placement.ts`; move `gitTopOf` to `src/verify/git-top.ts`. |

Stale references: `docs-drift.test.ts:1078-1079`/`:1156` → `:1083-1084`/`:1162`; `index.ts:2164-2169` → `:2490-2494` (capture `:2215-2219`, `:2547`, deferral `:2512-2528`); `gate.ts:246-292` → `accept` `:200-414`; `dispatch.ts:671-678` → `src/routing/wire/dispatch.ts:740-747`; `wiring.ts:1795-1850` → `checkDrift` `:2037-2045`, `prepareClaim` `:2060-2150`, `runClaimGate` `:2160-2226`; `wiring.ts:1683-1686` → `:1857-1859`; `reference.ts:1764-1798`/`:1820-1845` → `:1780-1816`/`:1818-1881`; `reference.test.ts:1291-1358` → about `:1396-1440`; `roles-authority.test.ts:833` → `:1137`.

## Tasks

Each task is test-first, one commit (`type(scope): … ` + `Refs #107`), `npm run typecheck` plus only the touched test files. Full suite, goldens and heavy adversarial QA at the end of each lot (lot 1 = P2a–P2d, P2g, P2f-partial; lot 2 = P2e).

### P2a — parsing, placement resolution, capture root, interim rule
- **P2a.1** `src/verify/dod.ts`: `Check.cwd?`/`Check.scope?` (raw text), read at a token boundary in the check branch (`:261-275`); `parseKvPairs` unchanged. Tests `test/unit/dod.test.ts` "parseAcceptanceBlock — per-check cwd= and scope= (cross-repo P2.1)".
- **P2a.2** `src/verify/types.ts` `CheckPlacement`, `PlacementResolution`; `src/verify/git-top.ts` (moved `gitTopOf`); `src/routing/roles/check-placement.ts` `resolveCheckPlacements`; `work-root.ts` `captureRootOf`. Tests `test/unit/check-placement.test.ts`.
- **P2a.3** `src/index.ts`: `roleReadSetFor(routed)` factored from `readProvenanceLine` (`:601-610`); resolve placements at `:2492-2494`; interim rule at `:2512`. Tests `test/integration/check-placement.test.ts` "interim deferral (P2.7 interim)".
- **P2a.4** Capture at W: `index.ts:2216`, `:2547` → `captureRootOf(scope)`; `finishDeferred` gets `captureRoot` used only by `observeChange` (`wiring.ts:1851`); registration `cwd` unchanged; `delegate` untouched. Tests "capture anchored at W (I2, P2.3)".

### P2c — dispatch-time detection and run signal
- **P2c.1** `src/routing/wire/dispatch.ts`: `roleGateOutsideWorkRoot` (`:740-747`) true on any refused placement; `roleGateDeferred` (`:713-726`) false when placements exist; callers `:1808-1823`. Tests `roles-dispatch.test.ts` "detection with per-check check roots (P2.5)".
- **P2c.2** `acceptanceScriptsOf(dod)` in `src/routing/outcomes/signals.ts`, used by `index.ts:1162-1174`; no run signal when a check has its own `cwd=`. Docs sentence in `docs/ROLES.md` + docs-drift pin.

### P2b — gate grouping, I3, consumer caveat
- **P2b.1** `runDeterministic` per-check deps (`deterministic.ts:1669-1698`, `:1506`, lint `:1565-1578`); foreign failure → unverifiable, no `onFailure`; reference none.
- **P2b.2a** `gate.ts` `Delegation.checkPlacements?`/`refusedCheck?`; refusal after `:299`; pass placements at `:370-373`.
- **P2b.2b** I3 across check roots after the mixed check; relative changed paths made absolute for foreign placements.
- **P2b.3** Consumer discovery: `PerimeterSeed.origin`/`linked` (`dispatch.ts:81-97`), `discoverConsumers` in `perimeter.ts`, `perimeterAtGate` (`wiring.ts:1567-1613`) adds `consumers`, `PerimeterObservation.consumers?`.
- **P2b.4** Consumer caveat (D6, OD2) in `gate.ts` between I5 (`:399-404`) and I8 (`:407`).
- **P2b.5** Wire placements into `accept` (`index.ts:2608-2619`); S8 integration cases.
- **P2b.6** Docs (`docs/ROLES.md`, `docs/VERIFICATION.md` "Checks in other repositories"), protocol clause (OD5) + configured golden, `CHANGELOG.md` `[Unreleased]`, docs-drift pins.
- **P2b.7** OD1: v2 tier dispatch (task and `delegate`) with a per-check `cwd=` → unverifiable, nothing runs; v1 inert. Tests in `gate.test.ts`/integration; docs + changelog.

### P2d — pinning
- **P2d.1** `snapshotTree` ignored-files digest option (hardened `git ls-files --others --ignored --exclude-standard -z`), `TreeSnapshot.ignored?`.
- **P2d.2** `src/verify/pin.ts`: `pinOf`, `samePin`, one-level link scan (OD3 fail closed).
- **P2d.3** Pins at dispatch from linked perimeter seeds (`wiring.ts:1508-1513`), attached at the gate.
- **P2d.4** Materialize step 7 honours pins (`reference.ts:1849-1875`, `DispatchReference.pins?`).
- **P2d.5** S6/S7 integration, docs (`docs/VERIFICATION.md:280-293`, I6 wording), changelog.

### P2g — role location line (OD6)
- Short design pass first (prompt surface, I9 goldens, the dead location line in `src/router/dispatch-header.ts`), then implement with goldens changed on purpose.

### P2e — deferred P (lot 2, own QA)
- **P2e.1** `pending.ts` R3/`PendingRegistration` store P at return, link-root fingerprints, consumers and placements.
- **P2e.2** `finishDeferred` observes P (`observeChange(..., true)`), removes the `:1855-1859` fallback, `staticScoping` per placement, fix F13.
- **P2e.3** `prepareClaim` sets `prepared.perimeter`; S11 link-target drift caveat in `judgeVerdict`; `runClaimGate` re-validates placements.
- **P2e.4** Lift the interim rule (`index.ts:2512`, `roleGateDeferred`).
- **P2e.5** Docs and changelog.

### P2f — close-out
- Fix stale references in design §7, add "Phase 2 implemented (notes)", update the handover, run the Phase 2 live dogfood (script in the pre-flight report: recreate the junction with `New-Item -ItemType Junction`, remove it with `cmd /c rmdir`, never `Remove-Item -Recurse`).

## Risks and guards
- Goldens: only the configured roles-protocol golden (OD5) and the P2g goldens change, on purpose.
- v1: parsed keys are read only on v2 paths; every task has a tier/v1-inert test. `smoke:v1` cannot run on this machine.
- Deferred semantics: the interim rule lands before any placement is honoured; the registration's `cwd` is unchanged.
- False fail / false pass: F6 and F7 have dedicated tests.
- Cost: consumer full suites run inside `gateBudgetMs` (timeout → unverifiable); discovery bounded; pin digests in the background perimeter snapshot.
- Windows: with `core.autocrlf` on, every reference is approximate (`reference.ts:1701-1705`), so S7 cannot be proven live there.
