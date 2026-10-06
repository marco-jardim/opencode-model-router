# Handover — Cost-Aware Routing Engine (#74)

> **Revision:** 4 — checkpoint DF2, code sync done, awaiting the owner's restart (2026-10-06). Rewritten by the executing orchestrator at every checkpoint (DF0–DF5) and before every restart request (plan §0.11).
> **Plan:** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` (revision 2 + "Amended during implementation" A1–A29 in §1.5). Read it in full before doing anything.
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) (this work), [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) (inspiration; close together with #74).

---

## 1. Resume prompt (paste into a fresh OpenCode v2 session opened in `D:\git\opencode-model-router`)

```text
You are the executing orchestrator for the plan
D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md (revision 2, amendments A1–A29).
Resume point and operating notes: D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md.

Read both files completely before acting. Then resume from the "next task id" in handover §2 and
execute the plan to the end — Wave 1, Wave 2, Wave 3, release 2.3.0 — following the plan's §0
directives, which are binding and override your defaults. The rules that matter most:

1. Iterate continuously, phase after phase, wave after wave. Stop ONLY for: an ambiguity only the
   human can settle; a critical problem (security, data loss, broken artifact); a blocking problem;
   or a dogfood checkpoint whose code sync is not live and needs a host restart (§0.1.4 / §0.11).
   Spike S7 proved every code sync needs a restart (amendment A8): expect one at DF1–DF4.
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
| Checkpoint reached | **DF2 sync done, awaiting the owner's restart** (liveness probe pending); Wave 2 in progress — Phases 2.1, 2.2 and 2.3 merged |
| Done (Wave 2) | **Phase 2.1:** merged `a08229c`, QA PASS round 3 (report: `docs\qa\cost-aware-routing\phase-2.1.md`). **Phases 2.2 and 2.3:** integrated on `car/p22` and merged into `car/main` as `2878319`; QA: 2.2 round 2 PASS; integration round 1 PASS with all fixes applied; 2.3 round 3 PASS. **Plan amendments:** A27 (evidence filter before argmin), A28 (2.4 owns the v1 `R:` line hunk), A29 (largest step for resume context). **Capped suite on `car/main` @ `2878319`:** 137 files passed, 3 skipped; 11387 tests passed, 66 skipped; 255 s. |
| **Next task id** | **DF2 in progress.** After the owner restarts OpenCode v2 and says "retomar": (1) liveness probe — `/router` must show build `2.2.0+2878319` and `engine=static`; (2) `node scripts/routing-stats.ts` (expect an empty or no store); (3) create `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` with `{"routing":{"engine":"shadow"}}`; (4) from then on add `[route pin]` to every QA and `[tier:heavy]` dispatch. **Next after DF2:** **Phase 2.4** (advisor / `/router stats`) — it owns the A28 v1 `R:` line hunk and the handoffs from `phase-2.1.md`, `phase-2.2.md` and `phase-2.3.md` ("to 2.4"); read all three before starting. |
| `master` | fast-forwarded to `car/main` @ `2878319` at DF2 (rollback tag `car/sync-2-prev` = `8ce54f2`; previous sync: DF1, tag `car/sync-1-prev` = `3b3dba4`) |
| `car/main` | Wave 1 merged (`88847cb`) + Phase 2.1 (`a08229c`) + Phases 2.2/2.3 (`2878319`) |
| Base directory | `D:\git\opencode-model-router` (branch `master`); the session alias `D:\git\Claude-model-router` is the same repository — always use the `D:\git\opencode-model-router` form in dispatches |
| Integration worktree | `D:\git\omr-car-main` on `car/main` (base `D:\git\opencode-model-router`; `npm ci` done; capped suite green at `2878319`: 137 files passed, 3 skipped; 11387 tests passed, 66 skipped) |
| Phase worktrees | `D:\git\omr-car-p21`, `D:\git\omr-car-p22` and `D:\git\omr-car-p23` are merged and can be removed (p11–p15 were removed earlier). Integration worktree `D:\git\omr-car-main` stays. |
| Other worktrees on the machine (not ours; never touch) | `D:\git\opencode-model-router-v2` (`fix/gate-task-cwd`), `D:\git\opencode-model-router-release` (`release/1.13.0`), `D:\git\opencode-model-router-agent-options-gate` (`fix/agent-options-provider-gate`), detached worktrees under `C:\Users\Marquinho\AppData\Local\Temp\` |
| Active router config | Plugin loaded from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:189`); bundled `D:\git\opencode-model-router\tiers.json` + state `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` (`activePreset: hybrid-2`, `activeMode: normal`, `enforcementMode: advisory`); no override files yet. **Checkpoint edit target:** `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (create at DF2, after the restart and the liveness probe, with only the `routing` block) |
| Current `routing` block | none (engine = `static` by absence); becomes `{"engine":"shadow"}` at DF2 after the restart |
| Scorecard / D15 directory | `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` |
| Host | OpenCode `v2.0.22`; source `anomalyco/opencode` @ `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`; `@opencode/plugin` 2.0.22 |
| Open QA findings | none blocking. Plan amendments A1–A29 in §1.5. Handoffs to 2.4 are in the "to 2.4" sections of `docs\qa\cost-aware-routing\phase-2.1.md`, `phase-2.2.md` and `phase-2.3.md` (and the earlier `phase-1.x.md` "Handoffs" sections) — read them before starting Phase 2.4. |
| 0.P close-out | done: QA PASS, `car/p0p` merged into `car/main`, capped suite green, `master` fast-forwarded, `D:\git\omr-car-p0p` removed, Wave-1 comment posted on #74 |
| Owner decisions | **DF3 live classifier check model (A13): `opencode-go/deepseek-v4.1-flash`** — decided by the owner on 2026-10-06. Use it in the DF3 one-shot (`routing.classifier = { "backend": "host", "model": "opencode-go/deepseek-v4.1-flash", "timeoutMs": 10000 }`), then restore. **Open (from QA-2.3-13), not blocking:** on `hybrid-2` and `anthropic` the medium/heavy tiers carry `effort`, so ladder escalations never resume (effort path) and variant steps exist only on the fast tier. The owner should decide whether to use `candidates` or drop `effort` where `variant` is set; Phase 2.4's advisor surfaces it. |
| Sessions | Producers (@medium): 2.1 `ses_eeef71487ffe8FQQl2PlSiwF0W`, 2.2 `ses_eeeaa3f76ffebBSSN9hHLkra3l`, 2.3 `ses_eeeaa08e4ffe0LW8ICV6EHtuB4`. Reviewers (@heavy): 2.1 `ses_eeee7ae8bffeF09wshQ4Asc3dd`, 2.2 `ses_eee825213ffegXmVJzL8FmU4Hk`, 2.3 `ses_eee821e23ffeELNWIF0SpGl6kW`. |
| Spike evidence hygiene | Any spike re-run that is not meant to replace the evidence: `git -C <worktree> checkout -- docs/qa/cost-aware-routing/spikes` afterwards (QA-0P-42) |
| Liveness probe / slash commands | The orchestrator has no tool to type `/router` or `/annotate-plan`; at DF1 find the host API route that runs a session command (host source at the pinned sha) or ask the human to type it |
| Last `routing:stats` | DF1: `no outcome data` (all zeros). DF2 run pending, after the restart (expect an empty or no store). |
| Sentence for the human | "Sync DF2 concluído; o código novo não está ativo na sessão. Reinicie o OpenCode v2 e diga 'retomar'." (restart pending) |

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
| Config change not reflected by `/router` | You edited the wrong file: the target is the global override file (A6). |
| Full suite slow or flaky under parallel worktrees | Capped (`--maxWorkers=2`) and serialized; smoke tests serial; `npm ci` one worktree at a time. |
| Merge conflict in `src\index.ts` / `src\compat\v2-hooks.ts` | Single-owner files per wave; only the orchestrator merges, in `D:\git\omr-car-main`, one phase at a time. |
| A QA reviewer keeps finding minors on round 3+ | Fix only blocking/critical/major; record the rest as "accepted — QA round limit". |


## 6. Wave 1 notes

- **Never run vitest with `--pool=threads`** (A14): a Phase 1.1 test wrote the user's real `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (`{"routing":{"engine":"enforce"}}`) under threads; the orchestrator deleted it at ≈03:25. Phase 1.1 adds a global home guard (`test\setup\home-guard.ts`).
- Delegates frequently end a turn mid-task ("Tools are available again…"); resume the same session with "finish, do not end your turn until committed/pushed/clean". The router grader's "NOT ACCEPTED" verdicts on those were based on a truncated injected criterion, not the deliverable — do not escalate on them.
- Reviewer sessions (@heavy): 1.1 `ses_ef023787effeEObHxLv3MGeGY3`, 1.2 `ses_ef0234eb4ffevS1GTHmwcKeFUl`, 1.3 `ses_ef0231f14ffekDb3IRcSoChUDO`, 1.5 `ses_ef022ef72ffeAqMqtMr0BJxicE`. Producer sessions (@medium): 1.1 `ses_ef0521c71ffehscJXwyETnXMvV`, 1.2 `ses_ef03cb9e0ffe2SaokGGLv5GoPT`, 1.3 `ses_ef03c8de2ffekddgvTJIIsof1p`, 1.5 `ses_ef03c5af9ffeuuv113Ch6t0O7A`.
- Owner decision still pending: classifier model for the DF3 live check (A13).
