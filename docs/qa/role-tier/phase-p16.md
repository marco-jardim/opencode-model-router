# Phase P1.6 — Binding and authority modules (issue #84)

Plan: `D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-plan.md` §2.4, §2.5, §5 P1.6, §9 R6/R7.
Spikes: `D:\git\omr-rta-main\docs\qa\role-tier\spikes.md` (S2, S3, S6, S7; P-2, P-17).
Branch: `rta/p16`. Worktree: `D:\git\omr-rta-p16`.

## Pre-flight

| Check | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p16` on `rta/p16`, from `origin/rta/main` @ `2ab0c40` |
| `npm ci` | ok |
| Typecheck (`tsc --noEmit`) | exit 0 |
| Baseline | none needed: new files only (`src/routing/roles/binding.ts`, `src/routing/roles/authority.ts`, two test files) |
| Contracts | P1.1 (`src/router/roles.ts`) and P1.2 (`src/routing/roles/policy.ts`: `DispatchGrant`) merged; `grantFor` not depended on |
| Spikes read | S2, S3, S6, S7 |
| Ownership conflicts | none |

## Implementation

| Commit | Purpose |
|---|---|
| `40ed16d` | feat(roles): binding contracts (T1.6.0) |
| `1ef4de6` | feat(roles): lazy child-dispatch binding (T1.6.1): process-wide registry, lazy `bind`, eviction, widening |
| `e4aa3ec` | feat(roles): authority ladder (T1.6.2): `router_request_authority` tool definition and request state |
| `c0e8e68` | test(roles): binding and authority tests with the I5 interleaving property (T1.6.3) |
| `9697678` | fix(roles): QA round 1: marker-only binding, role-max views, call-bound authority requests |
| `225b69f` | fix(roles): QA round 2: anchored nonce markers, no nonce-less path, call attached at annotation |
| this commit | docs(roles): P1.6 phase report; one-line residual note in the `binding.ts` header |

Final design (contract changes recorded in plan amendment R7):

| Area | Behaviour |
|---|---|
| Registry | `globalThis` under `Symbol.for("opencode-model-router.role-binding@2")`: one registry and one decision per child for every plugin instance |
| Registration | `registerPending`: nonce must match `^[A-Za-z0-9_-]{16,128}$` (`newDispatchNonce()` = UUID); budget finite > 0; non-absolute work root → null; retired or duplicate nonce, deleted parent, expired entry → refused; TTL 30 min, cap 512 |
| Binding | markers only at anchors (title trailing ` [nonce …]`, prompt last non-empty line `OMR_NONCE=…`); disagreement or no nonce → unknown; live unclaimed entry of the same parent and agent → exact and claimed; anything else → unknown; failed or parentless lookups are not cached |
| Grants | stored unrestricted; every view = decision ∩ caller's `maxOf(agent)`, then separation, then work-root rule; unknown = max ∩ local; never a union; `intersection` kind kept in the contract but never produced |
| Eviction | `evictCall(parent, callID)`; `evict(sessionID)` for deleted sessions (children and parents, tombstoned 30 min); bound children LRU 4096 |
| Ladder | requests recorded without a call; `markAnnotated(child, callID, parent?)` attaches the call; `discardAuthority` drops unattached or same-call records; `consumeAuthority(…, { afterCall })` widens recorded ∩ current role max once and returns `none` / `dropped` (with reason) / `widened`; TTL 30 min, cap 512; child reasons cleaned (`cleanReason`) and quoted (`quoteChildText`); state under `Symbol.for("opencode-model-router.role-authority@2")` |

## Tests

| File | Tests | Result |
|---|---|---|
| `test/unit/roles.binding.test.ts` | 37 | pass |
| `test/unit/roles.authority.test.ts` | 28 | pass |
| Total (`npx vitest run … --maxWorkers=4`) | 65 | pass |

| Module | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| `src/routing/roles/binding.ts` | 100% | 100% (160/160) | 100% | 100% |
| `src/routing/roles/authority.ts` | 100% | 100% (135/135) | 100% | 100% |

Property test (I5): seeded generator (mulberry32, no dependency), 400 seeds × 90 steps of random interleavings: registrations with reused call ids,
child spawns whose text quotes or forges marker syntax, lost or disagreeing anchors, missing first messages, concurrent binds with different
role maxes, lookup failures, call completion, parent and child deletion, cache loss, TTL jumps, `widen` and request→annotate→consume.
Asserted for every child: grant ⊆ the caller's max; no `execute`; separation; `router_run` only with an absolute root; ⊆ every candidate's
grant (never a union); I5 — non-unknown ⊆ the child's own dispatch grant, unknown ⊆ max ∩ local (plus widened actions); concurrent callers
share one decision. Non-vacuity: > 2000 checks, > 500 exact, > 500 unknown, every clean first decision of a pending dispatch's child exact.

## Findings

| Round | Id | Severity | Status | Resolution |
|---|---|---|---|---|
| 1 | QA-P16-1-1 | critical | fixed | no counting past nonce-bound dispatches; claims |
| 1 | QA-P16-1-2 | major | fixed | marker nonces only; disagreement → unknown |
| 1 | QA-P16-1-3 | major | fixed | required `maxOf`; every view ∩ the caller's max; `widen` requires `max` |
| 1 | QA-P16-1-4 | major | fixed | requests tied to the annotated call; first resume only; TTL; parent eviction |
| 1 | QA-P16-1-5 | major | fixed | `newDispatchNonce()`; `evictCall(parent, callID)`; nonces never un-retired |
| 1 | QA-P16-1-6 | major | fixed | property test rewritten without restated rules; new generators |
| 1 | QA-P16-1-7 | minor | fixed | deleted-session tombstones; no store for a deleted parent or child |
| 1 | QA-P16-1-8 | minor | fixed | non-absolute work roots → null; `!workRoot` checks |
| 1 | QA-P16-1-9 | minor | fixed | control tokens stripped; `quoteChildText` |
| 1 | QA-P16-1-10 | minor | fixed | parentless or agentless lookups not cached |
| 1 | QA-P16-1-11 | minor | rejected (executor) | the smoke-file change came from `rta/main` (fx1 merge), not from P1.6 |
| 1 | QA-P16-1-12 | nit | fixed | advertised tool schema = enforced schema |
| 1 | QA-P16-1-13 | nit | fixed | `roles` required in `roleFor` and deps |
| 1 | QA-P16-1-14 | nit | fixed | budget null documented (role default); non-finite budget refused |
| 2 | QA-P16-2-1 | major | fixed | nonce pattern enforced; nonce-less path removed (R7) |
| 2 | QA-P16-2-2 | minor | fixed | anchored markers (title suffix, last prompt line) |
| 2 | QA-P16-2-3 | minor | fixed | requests recorded without a call; call attached by `markAnnotated`; `dispatchOf` optional |
| 2 | N1 | nit | fixed | brackets → parentheses; leading return-contract prefixes stripped |
| 2 | N2 | nit | fixed | versioned `Symbol.for` keys |
| 2 | N3 | nit | fixed | `consumeAuthority` returns a `dropped` reason |
| 3 | — | — | PASS | no open finding |

Accepted at the QA round limit (non-blocking):

| Item | Note |
|---|---|
| Lost-markers residual | a child that lost both own markers but whose anchors carry a live, unclaimed sibling's nonce binds to it; effectively unreachable (unguessable UUID); documented in the `binding.ts` header |
| Open record outliving its call | stays until TTL if P2.1 runs neither `discardAuthority` nor `consumeAuthority` |
| Parentless records | survive `evictAuthority(parent)` until TTL |
| Expired annotated record | `consumeAuthority` returns `none` instead of a drop reason |
| R7 | now recorded in the plan |

## Handoffs

| To | Item |
|---|---|
| P2.1 | Register every role dispatch with `newDispatchNonce()`; append `nonceTitleSuffix` at the END of the description and `noncePromptLine` as the LAST prompt line; verify on v2 that the host appends nothing after it and does not truncate the title |
| P2.1 | `SessionLookup.firstText` = the first message's text parts joined |
| P2.1 | Pass `maxOf` = `roleMax` on every `bind` / `currentBinding` call |
| P2.1 | `execute.after`: `markAnnotated(child, callID, parent)` on `ESCALATE: authority`, else `discardAuthority(child, callID)`; then `evictCall(parent, callID)` |
| P2.1 | `session.deleted`: `evict(sessionID)` and `evictAuthority(sessionID)` |
| P2.1 | Resume `execute.before`: `consumeAuthority(child, deps, { afterCall })`; show `dropped` reasons; recompute the floor on `widened` |
| P2.1 | Present child reasons with `quoteChildText` |
| P2.3 | The unknown-binding catalog still includes `router_request_authority` |

## Takeovers

None.

## Verdict

**PASS** — 0 open blocking, critical or major findings after QA round 3.
