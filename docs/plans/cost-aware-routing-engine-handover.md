# Handover — Cost-Aware Routing Engine (#74)

> **Revision:** 5 — Phase 3.3 complete, sync 5 done, awaiting the owner's restart; next: Phase 3.4 (2026-10-07). Rewritten by the executing orchestrator at every checkpoint (DF0–DF5) and before every restart request (plan §0.11).
> **Plan:** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` (revision 2 + "Amended during implementation" A1–A35 in §1.5). Read it in full before doing anything.
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) (this work), [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) (inspiration; close together with #74).

---

## 1. Resume prompt (paste into a fresh OpenCode v2 session opened in `D:\git\opencode-model-router`)

```text
You are the executing orchestrator for the plan
D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md (revision 2, amendments A1–A35).
Resume point and operating notes: D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md.

Read both files completely before acting. Then resume from the "next task id" in handover §2 and
execute the plan to the end — Wave 1, Wave 2, Wave 3, release 2.3.0 — following the plan's §0
directives, which are binding and override your defaults. The rules that matter most:

1. Iterate continuously, phase after phase, wave after wave. Stop ONLY for: an ambiguity only the
   human can settle; a critical problem (security, data loss, broken artifact); a blocking problem;
   or a dogfood checkpoint whose code sync is not live and needs a host restart (§0.1.4 / §0.11).
   Spike S7 proved every code sync needs a restart (amendment A8): sync 5 is awaiting one.
   Run npm ci only if package-lock.json changed, and finish it before asking for a restart.
2. If the model-router blocks you repeatedly (zero-tool hand-backs, "no tools" claims, cap banners,
   the same dispatch failing twice) re-dispatch once with an explicit "attempt the work first"
   instruction; if that fails, take over MOMENTARILY, log it in
   D:\git\opencode-model-router\docs\qa\cost-aware-routing\run-log.md, then return to delegating.
3. Pre-flight before EVERY phase (§0.9 + the phase's items). Fix everything it finds, except findings
   the plan schedules for a later phase ("deferred by plan").
4. Heavy adversarial QA after EVERY phase and once globally (CAP:none with a reason: line). Fix
   every finding from rounds 1 and 2; from round 3 on, only blocking, critical and major (§0.7).
5. Delegate atomic tasks through the model-router: coding → @medium; [tier:heavy] tasks and dense
   cores → @heavy (if you are Opus, router rule 9 says do heavy-tier work yourself, but QA stays a
   separate @heavy dispatch); run-and-collect → @fast; fix-what-failed → @medium. Every dispatch
   carries the 7 sections and ENVIRONMENT (working directory = the phase worktree, win32, pwsh).
6. Full suite only at §0.9 pre-flight, after each merge, and at release, capped (--maxWorkers=2)
   and serialized. Scoped runs otherwise.
7. Commit after every green subtask, conventional commits, Refs #74, push at once. No AI
   attribution in any commit or PR, ever.
8. Phase worktrees D:\git\omr-car-p<id> on car/p<id> from car/main; never edit the base checkout
   except the §0.6.8 exceptions. Keep §2 of this handover listing every open worktree.
9. Dogfood checkpoints (§0.11): mode changes go to the GLOBAL OVERRIDE FILE
   C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc (amendment A6),
   never the bundled tiers.json. From DF2 on, add "[route pin]" to every QA and [tier:heavy]
   dispatch. Stale liveness probe → rewrite this handover and ask the human (in Portuguese) to
   restart OpenCode v2.
10. Linear: not used. GitHub: one short progress comment on #74 at each wave boundary.
11. Talk to the human in Portuguese, short and direct. Code, docs, commits, QA reports, issue
    comments and PRs are in English.
```

---

## 2. Execution state

| Item | Value |
|---|---|
| Checkpoint reached | **Phase 3.3 complete; sync 5 done, awaiting the owner's restart** (liveness probe pending). DF4 is in `enforce`; next: **Phase 3.4**. |
| Done (Wave 2) | **Phase 2.1:** merged `a08229c`, QA PASS round 3 (report: `docs\qa\cost-aware-routing\phase-2.1.md`). **Phases 2.2 and 2.3:** integrated on `car/p22` and merged into `car/main` as `2878319`; QA: 2.2 round 2 PASS; integration round 1 PASS with all fixes applied; 2.3 round 3 PASS. **Plan amendments:** A27 (evidence filter before argmin), A28 (2.4 owns the v1 `R:` line hunk), A29 (largest step for resume context). **Capped suite on `car/main` @ `2878319`:** 137 files passed, 3 skipped; 11387 tests passed, 66 skipped; 255 s. |
| Done (DF3 / Wave 3) | **DF3:** `advise` at 2026-10-06T20:32Z; host classifier consulted once, recorded **EXPERIMENTAL**. **Phase 3.1:** docs, ADR 0005 and changelog; QA PASS after 3 rounds. **Phase 3.2:** real-host smoke 12/12 on OpenCode 2.0.22, re-run 12/12 on 2.0.24; QA PASS after 2 rounds. |
| Done (DF4) | `enforce` since 2026-10-07T00:52Z, profile `balanced`, margin `0.2` (precise enforce-period start: **2026-10-07T00:51:45Z**). Host is now OpenCode **2.0.24**. A restart during `npm ci` caused a sync incident; details and recovery are in `docs\qa\cost-aware-routing\run-log.md`. |
| Done (Phase 3.3) | Global QA by three parallel heavy reviewers (areas A/B/C). Round 1: 1 critical, 8 major and the minors; all fixed. Round 2: 0 major+, all findings fixed. Round 3: **PASS**. **A34:** never-down capability rank, weaker detection, A30 rewrite preconditions. **A35:** project layer may only tighten classifier bounds. Report: `docs\qa\cost-aware-routing\global.md`. **Capped suite on `84c3434`: 146 files / 11675 tests green.** `exec.test.ts` lowPriority is a known load flake that predates this work. |
| Sync 5 | Base `master` fast-forwarded to **`93db126`** at **2026-10-07T03:40:45Z**; rollback tag **`car/sync-5-prev` = `64e523a`**. No `npm ci` was run because `package-lock.json` is unchanged. **Awaiting the owner's restart.** This sync makes the Phase 3.3 never-down and privacy fixes live in `enforce` after the restart. |
| **Next task id** | **Phase 3.4**, after the owner's restart and a liveness probe confirming sync 5 (`93db126`) and `engine=enforce`. **3.4.1 / DF5:** run `routing:stats` with bounded windows; the enforce period starts **2026-10-07T00:51:45Z**. Apply D17 using the new `d17Mode` line. Measure the cache-read share (QA-G-A1 handoff in `run-log.md`, including token totals, denominator and sample windows). Write the dogfood Summary table **DF1–DF5** and copy it into **ADR 0005 Evidence**. |
| Next (3.4.2 / release) | Version **2.3.0**, CHANGELOG release entry, PR `car/main` → `master` closing **#74 and #73**, tag `v2.3.0`, publish per `docs\MIGRATION.md` / release notes, clean-install check, remove the `omr-car-*` worktrees and `car/sync-*-prev` tags, final capped suite on `master`, closing comments. |
| `master` | Sync 5: `93db126`; rollback tag `car/sync-5-prev` = `64e523a`. |
| `car/main` | Phase 3.3 merged; `93db126` at sync 5 (this revision is a subsequent docs-only checkpoint). |
| Base directory | `D:\git\opencode-model-router` (branch `master`); the session alias `D:\git\Claude-model-router` is the same repository — always use the `D:\git\opencode-model-router` form in dispatches |
| Integration worktree | `D:\git\omr-car-main` on `car/main` (base `D:\git\opencode-model-router`); capped suite green on `84c3434`: 146 files / 11675 tests. |
| Phase worktrees | `D:\git\omr-car-p21`, `omr-car-p22`, `omr-car-p23`, `omr-car-p24`, `omr-car-p31`, `omr-car-p32`, `omr-car-p33`, `omr-car-p33b`, `omr-car-p33c`, `omr-car-p33d` and `omr-car-pcred` (all under `D:\git`) are merged and can be removed at Phase 3.4. p11–p15 and p0p were removed earlier. Keep integration worktree `D:\git\omr-car-main` until release cleanup. |
| Other worktrees on the machine (not ours; never touch) | `D:\git\opencode-model-router-v2` (`fix/gate-task-cwd`), `D:\git\opencode-model-router-release` (`release/1.13.0`), `D:\git\opencode-model-router-agent-options-gate` (`fix/agent-options-provider-gate`), detached worktrees under `C:\Users\Marquinho\AppData\Local\Temp\` |
| Active router config | Plugin loaded from `D:\git\opencode-model-router`; bundled `tiers.json` + global state. **Checkpoint edit target:** `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`; do not change bundled `tiers.json` for dogfood mode switches. |
| Current routing settings | Engine `enforce`, profile `balanced`, margin `0.2`. Preserve unrelated override settings. |
| Scorecard / D15 directory | `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` |
| Host | OpenCode **2.0.24**; Phase 3.2 real-host smoke re-run: 12/12. |
| Open QA findings | Global QA round 3 **PASS**; no open major+ findings. Plan amendments A1–A35 in §1.5. Read `docs\qa\cost-aware-routing\global.md` and the DF5 handoff in `run-log.md` before Phase 3.4; cache-read share measurement remains outstanding (QA-G-A1 / QA-2.2-10). |
| 0.P close-out | done: QA PASS, `car/p0p` merged into `car/main`, capped suite green, `master` fast-forwarded, `D:\git\omr-car-p0p` removed, Wave-1 comment posted on #74 |
| Owner decisions | **DF3 live classifier check model (A13): `opencode-go/deepseek-v4.1-flash`** — decided by the owner on 2026-10-06; one-shot completed, recorded EXPERIMENTAL. **Open (from QA-2.3-13), not blocking:** on `hybrid-2` and `anthropic` the medium/heavy tiers carry `effort`, so ladder escalations never resume (effort path) and variant steps exist only on the fast tier. The owner should decide whether to use `candidates` or drop `effort` where `variant` is set; Phase 2.4's advisor surfaces it. |
| Sessions — global QA | Area A `ses_eebd8b1dcffeLJmDfL3DOVKa9y`; B `ses_eebd89074ffe4ot426iFHDqH9P`; C `ses_eec25975affeVHygmODlDSRYxj`; rounds 2–3 `ses_eebab6bfaffevZEkEpiFOKJzvw`. |
| Sessions — fix producers | C/integration `ses_eebd8265fffedp6hRQY9wpI19D`; never-down (@heavy) `ses_eebca0bf2fferJb0AydKkDHZa2`; privacy `ses_eebc9cd46ffeJhanBXDON5Edyl`; adapter `ses_eebc9774affeFw4Y706lHAvx7h`. |
| Sessions — Phase 3 producers | 3.1 `ses_eed10fba7ffeR0CNi3jebIFOVL`; 3.2 `ses_eed02d357ffeI6JbqM9B1u0yYY`. |
| Spike evidence hygiene | Any spike re-run that is not meant to replace the evidence: `git -C <worktree> checkout -- docs/qa/cost-aware-routing/spikes` afterwards (QA-0P-42) |
| Liveness probe / slash commands | If the orchestrator cannot type `/router` or `/annotate-plan`, use the host API route for a session command or ask the human to type it. Sync 5 liveness is pending; do not treat the file sync as proof that the running host loaded it. |
| Recorded `routing:stats` | Advise-period stats (`--since 2026-10-06T20:32:23Z`, before the DF4 incident): 112 decision rows, 28 resumes, 20 pinned, agreement 67/67, switched 0, kept for lack of evidence 23 of 84 fresh. `pinned && switched` = 0 over all 191 decision rows. DF5 must use bounded windows and the new `d17Mode` line. |
| Sync procedure rule | Run `npm ci` **only if `package-lock.json` changed** between the rollback tag and the new head, and always finish it **before asking for a restart**. Never sync while a restart may be pending (DF4 incident, `run-log.md`). |
| Sentence for the human | "Sync 5 concluído; as correções da fase 3.3 ainda precisam do reinício para ficar ativas. Reinicie o OpenCode v2 e diga 'retomar'." (restart pending) |

---

## 3. Facts settled in Phase 0.P (details: `docs\qa\cost-aware-routing\phase-0P.md`; rules: plan §1.5 A1–A12)

- **Hook swap works and permissions are re-checked** (S1, S1-deny): `enforce` must filter by evaluated permissions before swapping (A11).
- **Resume with a new variant/model works**; same-model effort travels in-band on Anthropic Messages, haiku uses thinking budgets, OpenAI route unverified (S2, S2b, A7). A child without a variant is stored as `default` (A9).
- **Agent switch on resume changes tools and system prompt**; native `explore` is read-only (S2-agent-native).
- **`session.step.ended` reaches the plugin once per live location instance** — dedupe by event id at process scope (S3b, A3).
- **Every live tier model is unpriced** → dogfood numbers are in `costRatio` units (A1).
- **`ctx.generate.text` works from the plugin** (isolated host); real credentials are checked live at DF3 (A4).
- **Every code sync needs a host restart** (S7, A8).
- **The live v2 protocol text uses `subagent(agent=…)`**; Phase 1.4's D2 snapshot pins both forms.
- `tsx` is not installed; there is no build step.

## 4. Delegation behaviour observed (expect it again)

- `@fast` may claim it has no shell/filesystem; it does have read/glob/grep. Give it read/glob/grep-only tasks, or run shell checks yourself. Its glob of the scorecard directory returned 0 of 12 631 files — verify counts with pwsh.
- `@medium` may end a turn mid-task ("I'll finish…"); check `git status`/`git log` and resume the same session.
- `rg` patterns in pwsh: single quotes. In pwsh scripts never name a helper function `R` (alias of `Invoke-History`).
- Web reads: code-mode `execute` + `fetch` (host source at the pinned sha; GitHub API needs a `User-Agent`).

## 5. Troubleshooting

| Symptom | What to do |
|---|---|
| A delegate returns `NEED MORE` with zero tool calls | Re-dispatch once with a three-concrete-calls preamble; second failure: do it yourself, log in `run-log.md`. |
| `CAP:none` ignored | It needs a `reason:` line in the same dispatch. |
| `router_verify pending: true` shows `unverifiable` | Re-run `npx vitest run --maxWorkers=2 <files>` yourself; record in the phase QA report. |
| After a dogfood sync, `/router` does not show `build=<new sha>` | Expected (A8). Rewrite §2 with the exact next task id; tell the human: "Sync DF<n> concluído; o código novo não está ativo na sessão. Reinicie o OpenCode v2 e diga 'retomar'." Stop. On resume, probe again first. |
| After a sync the plugin misbehaves | 1) set `routing.engine: static` in the override file (hot reload); 2) if still broken: `git -C D:\git\opencode-model-router reset --hard car/sync-<n>-prev`, request a restart, log it, open `QA-DF<n>-1` (critical). |
| A restart races with `npm ci` | Follow the DF4 incident mitigation in `run-log.md`: run `npm ci` only if `package-lock.json` changed, finish it before requesting a restart, and never sync while a restart may be pending. |
| Config change not reflected by `/router` | You edited the wrong file: the target is the global override file (A6). |
| Full suite slow or flaky under parallel worktrees | Capped (`--maxWorkers=2`) and serialized; smoke tests serial; `npm ci` one worktree at a time. |
| Merge conflict in `src\index.ts` / `src\compat\v2-hooks.ts` | Single-owner files per wave; only the orchestrator merges, in `D:\git\omr-car-main`, one phase at a time. |
| A QA reviewer keeps finding minors on round 3+ | Fix only blocking/critical/major; record the rest as "accepted — QA round limit". |


## 6. Wave 1 notes

- **Never run vitest with `--pool=threads`** (A14): a Phase 1.1 test wrote the user's real `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (`{"routing":{"engine":"enforce"}}`) under threads; the orchestrator deleted it at ≈03:25. Phase 1.1 adds a global home guard (`test\setup\home-guard.ts`).
- Delegates frequently end a turn mid-task ("Tools are available again…"); resume the same session with "finish, do not end your turn until committed/pushed/clean". The router grader's "NOT ACCEPTED" verdicts on those were based on a truncated injected criterion, not the deliverable — do not escalate on them.
- Reviewer sessions (@heavy): 1.1 `ses_ef023787effeEObHxLv3MGeGY3`, 1.2 `ses_ef0234eb4ffevS1GTHmwcKeFUl`, 1.3 `ses_ef0231f14ffekDb3IRcSoChUDO`, 1.5 `ses_ef022ef72ffeAqMqtMr0BJxicE`. Producer sessions (@medium): 1.1 `ses_ef0521c71ffehscJXwyETnXMvV`, 1.2 `ses_ef03cb9e0ffe2SaokGGLv5GoPT`, 1.3 `ses_ef03c8de2ffekddgvTJIIsof1p`, 1.5 `ses_ef03c5af9ffeuuv113Ch6t0O7A`.
- Owner decision resolved: `opencode-go/deepseek-v4.1-flash` for the DF3 live check (A13); the one-shot is complete and recorded EXPERIMENTAL (see §2).
