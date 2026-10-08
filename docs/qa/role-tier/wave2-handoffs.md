# Wave 2 handoffs (collected from the Wave 1 phase reports and the spikes report)

Sources are under `docs/qa/role-tier/` on `rta/main`. Executor-owned file; phases read it, never write it.

## P2.1

1. Log the v1 notice by calling `resolveRolesRouting` next to `resolveRouting` at `src/index.ts` ≈474. (phase-p11.md:100)
2. Consume `RoleTable.droppedAgents` / `replacedRoles` at registration and pass the real context7 flag to `resolveRoleTable`. (phase-p11.md:101)
3. Register `general` from `HOST_NATIVE_ROLE_NAMES`, replacing the host-native agent in roles mode only (T2.1.1). (phase-p11.md:102)
4. Carry `RouteLineParse.malformed` into `ClassifyTrace.routeLines.malformed` and refuse a role dispatch whose first line is malformed. (phase-p12.md:97)
5. Build detection only via `effectiveDetection({ routerGate, claim, acceptance })`; never pass `ClassifyResult.detection` as effective. (phase-p12.md:98)
6. When `RoleDecision.dispatch === null`, refuse the role dispatch; never fall back to `buildEscalatePolicy`/`buildLadder` or a tier agent. (phase-p12.md:99)
7. The role runner uses `roleEscalatePolicy(cfg, window, session)`. (phase-p12.md:100)
8. Normalise `root=` and compare it with `git worktree list --porcelain` before any filesystem call; no match → `workRoot` null. (phase-p12.md:101)
9. Pass `roleTierOrder(cfg, session)` as `tierBounds(…, { tiers })`. (phase-p12.md:102)
10. Import the role API from `src/routing/engine/kernel.ts` and `src/routing/engine/ladders.ts` (engine/index.ts exports are pinned by a test). (phase-p12.md:103)
11. Register `routerRunTool(deps)` and `gitTools({ resolveWorkRoot })`, both `(sessionID) => WorkRootAnswer`; `router_run` refuses `{ role: false }`. (phase-p13.md:102)
12. List `router_run` and `router_git_*` explicitly in role agent allows (P-12). (phase-p13.md:103)
13. Wire `recordRun` to the P1.4 `run` signal (`at` = run start; `exitCode: null` on timeout/abort/signal). (phase-p13.md:104)
14. Residual (informational): a user-owned `~/.npmrc` `globalconfig` outranks `--globalconfig`. (phase-p13.md:105)
15. Call `onSignal` / `onVerdict` from the hooks; verdict rows only through `onVerdict`. (phase-p14.md:110)
16. Re-dispatch: `onSignal(prev.childSessionID, obs, { expectDecisionID: prev.decisionID })`. (phase-p14.md:111)
17. Fill `DispatchText` `class`, `role`, `endedAt`, `returnPrefix`, `budgetExhausted`, `authorityRequested`. (phase-p14.md:112)
18. Pass the orchestrator's prompt without the router header. (phase-p14.md:113)
19. Write `role` and `tier` on role decision rows. (phase-p14.md:114)
20. Unknown-binding rows use reason `note:binding:unknown`. (phase-p14.md:115)
21. `IngestSettings.roleAgentIds` comes from `resolveRoles`. (phase-p14.md:116)
22. Fold host step limits and context overflow into `budgetExhausted`. (phase-p14.md:117)
23. Always pass the real guard state and `editsObserved`. (phase-p14.md:118)
24. `captureBudget(child, sessionStore.readCapReached(child))` into the task artefact at return (`index.ts` ≈1934) and the deferred record (≈1902). (phase-p15.md:112)
25. Pass `incomplete: isIncompleteVerdict(verdict)` to `buildForcingNote` (≈2026, ≈1397) and `nextAction` (≈1376). (phase-p15.md:113)
26. `returnContract: true` on the gate artefact for role agents. (phase-p15.md:114)
27. Pass `profile` from `roleGuardProfile(role, tier, routeLine.budget)` to `guardBeforeCall` / `guardAfterCall` (≈1758, ≈1849). (phase-p15.md:115)
28. Annotate `budgetExhausted` on the parent result in `execute.after`; host `steps` = top budget + `REFUSAL_CAP` + margin (P-4, P-5). (phase-p15.md:116)
29. The `class=review|recon|search` reader signal needs a non-static routing engine. (phase-p15.md:117)
30. Pass the routed decision's `root` to `buildDispatchHeader` for v2 shadow/advise/enforce. (phase-p15.md:118)
31. Register every role dispatch with `newDispatchNonce()`; append `nonceTitleSuffix` to the END of the description and `noncePromptLine` as the LAST prompt line. (phase-p16.md:102)
32. `SessionLookup.firstText` = first message's text parts joined. (phase-p16.md:103)
33. Pass `maxOf = roleMax` on every `bind` / `currentBinding` call. (phase-p16.md:104)
34. In `execute.after`: `markAnnotated(child, callID, parent)` on `ESCALATE: authority`, else `discardAuthority(child, callID)`; then `evictCall(parent, callID)`. (phase-p16.md:105)
35. On `session.deleted`: `evict(sessionID)` and `evictAuthority(sessionID)`. (phase-p16.md:106)
36. Resume `execute.before`: `consumeAuthority(child, deps, { afterCall })`; show `dropped` reasons; recompute the floor on `widened`. (phase-p16.md:107)
37. Present child reasons with `quoteChildText`. (phase-p16.md:108)
38. Register the floor tier's model (+variant) on every role agent as fallback (P-1). (spikes.md)
39. Role-aware escalation hint: resume the same child on a higher tier via `sessionID` + per-call `model#variant` (P-8). (spikes.md)
40. P-5: extend `background:false` forcing to role dispatches when verification is off or `require: never`, with a separate force-foreground flag (not `verifying`). (spikes.md, phase-p01.md)
41. P-7: rewrite `explore → explorer` in `execute.before` only in roles mode, via `subagent_type` (legacy shape). (spikes.md)
42. P-11: write `routing.workRoots` as canonical long-form `external_directory` allow rules at role agent registration; for a glob root canonicalise the static prefix, keep the glob tail. (spikes.md, phase-p01.md)
43. P-18: in roles mode `router_git_*` take the bound work root. (spikes.md)
44. P-19: role agents are registered through the router (router hooks enforce policy under a granting parent); `protectedAgent()` must be true for every role agent (plugin marker / `"*": "deny"`), unit-tested. (spikes.md, phase-p01.md)
45. `execute` absent from every role agent's whole max policy (strip reads `agent.permissions`). (phase-p01.md)

## P2.2

No item addressed to P2.2 directly. Indirect: the roles protocol must instruct the orchestrator to put `root=` on the first route line and the work root in ENVIRONMENT, to never set `model`, and to resume the same task id after `ESCALATE: authority` or a budget annotation.

## P2.3

1. An unknown binding is role max ∩ LOCAL, never `grantFor(…, null)`. (phase-p12.md:104)
2. The unknown-binding catalog still includes `router_request_authority`. (phase-p16.md:109)
3. P-3: wrap the context hook in try/catch; on error the role catalog is EMPTY and the degradation is annotated in `execute.after`; the evaluate hook denies with an explicit message instead of throwing. (spikes.md)
4. Work root from the router's binding, never `session.location`; `execute` denied to every role agent. (spikes.md)
5. P-12: plugin tools listed in allows; the tool still checks authority itself. (spikes.md)
6. P-13: narrow `external_directory` per session in `permission.hook("evaluate")` to the bound work root (canonical long form, `read-only.ts:24-28` matcher); unknown binding → deny; normalise before matching (`omr-rta-x/../../Windows`). (spikes.md, phase-p11 QA carry-forward)
7. P-17: P3.1 I3 test under a parent without grants and under an allow-all parent; I9 hook-error test expects an empty catalog. (spikes.md)

## P3.1 / P3.2

1. P3.2: role details in `docs/ROLES.md`; `routing.run` docs (`commands.args` patterns, npm limits, `.npmrc` refusals, credential stripping and what stays reachable, pre/post hooks run). (phase-p11.md, phase-p13.md)
2. P3.1: POSIX-only tests run on Linux CI; the pre-existing `6 v1 untouched` smoke failure (stale pin `71815eb`). (phase-p13.md, phase-p01.md)
3. P3.2 CHANGELOG: downgrading past P1.4 is unsupported; explicit `[acceptance]` lists over 4000 code points are no longer graded in full; §2.9 behaviour changes. (phase-p14.md, phase-p15.md)
