# Handover — Cost-Aware Routing Engine (#74)

> **Revision:** 1 — Phase 0.P closing (2026-10-06). Rewritten by the executing orchestrator at every checkpoint (DF0–DF5) and before every restart request (plan §0.11).
> **Plan:** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` (revision 2 + "Amended during implementation" A1–A12 in §1.5). Read it in full before doing anything.
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) (this work), [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) (inspiration; close together with #74).

---

## 1. Resume prompt (paste into a fresh OpenCode v2 session opened in `D:\git\opencode-model-router`)

```text
You are the executing orchestrator for the plan
D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md (revision 2, amendments A1–A12).
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
| Checkpoint reached | **DF0** (Phase 0.P; baseline in `docs\qa\cost-aware-routing\dogfood.md` `## DF0`) |
| **Next task id** | **0.P close-out** if `car/p0p` is not yet merged into `car/main` (merge, capped suite, fast-forward `master`, post the Wave-1 start comment on #74); otherwise **1.1.1** (and in parallel 1.2.1, 1.3.1, 1.5.1 per the dependency graph) |
| `master` | `8e7a890` (`docs(plans): add cost-aware routing engine plan (#74)`); fast-forwarded to `car/main` after the 0.P merge (amendment A12; docs + gated smoke test only, no restart) |
| `car/main` | `8e7a890` until the 0.P merge |
| Base directory | `D:\git\opencode-model-router` (branch `master`); the session alias `D:\git\Claude-model-router` is the same repository — always use the `D:\git\opencode-model-router` form in dispatches |
| Integration worktree | `D:\git\omr-car-main` on `car/main` (base `D:\git\opencode-model-router`; `npm ci` done; typecheck + capped suite green at `8e7a890`: 109 files passed, 3 skipped) |
| Phase worktrees | `D:\git\omr-car-p0p` on `car/p0p`, Phase 0.P, base `D:\git\opencode-model-router` — remove after the merge. Pattern for the next ones: `D:\git\omr-car-p<id>` on `car/p<id>` (`1.4` → `p14`) from `car/main` |
| Other worktrees on the machine (not ours; never touch) | `D:\git\opencode-model-router-v2` (`fix/gate-task-cwd`), `D:\git\opencode-model-router-release` (`release/1.13.0`), `D:\git\opencode-model-router-agent-options-gate` (`fix/agent-options-provider-gate`), detached worktrees under `C:\Users\Marquinho\AppData\Local\Temp\` |
| Active router config | Plugin loaded from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:189`); bundled `D:\git\opencode-model-router\tiers.json` + state `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` (`activePreset: hybrid-2`, `activeMode: normal`, `enforcementMode: advisory`); no override files. **Checkpoint edit target:** `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (create at DF2 with only the `routing` block) |
| Current `routing` block | none (engine = `static` by absence) |
| Scorecard / D15 directory | `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` |
| Host | OpenCode `v2.0.22`; source `anomalyco/opencode` @ `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`; `@opencode/plugin` 2.0.22 |
| Open QA findings | see `docs\qa\cost-aware-routing\phase-0P.md` Verdict |
| Last `routing:stats` | n/a (script arrives in Phase 1.3); DF0 baseline from scorecards |
| Sentence for the human | n/a (no restart pending) |

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
