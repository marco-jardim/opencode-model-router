# Handover — Role × Tier × Assurance delegation (#84)

> **Revision:** 1 — plan written, reviewed (PLAN-1…21 → R0) and amended (R1 dogfood + owner rules, R2 restarts);
> execution **not started**; next: **P0.1 pre-flight** (2026-10-07). The executing orchestrator rewrites §2 and §8 at
> every phase merge, wave close, dogfood checkpoint and **before every restart request** (plan §0.1).
> **Plan:** `role-tier-assurance-delegation-plan.md` in this folder. Read it in full before doing anything.
> **Issues:** [#84](https://github.com/marco-jardim/opencode-model-router/issues/84) (this work).
> [#80](https://github.com/marco-jardim/opencode-model-router/issues/80) is open and **must not be implemented**
> (owner's instruction); the plan works around it (§0.7: validate overrides in a temp HOME, never write keys the live
> code does not know).

**Where these files live.** Until P0.1 creates `rta/main`, the plan and this handover exist only on the branch
`docs/role-tier-plan`, checked out in the worktree `D:\git\omr-plan-rta` (base directory of the repository:
`D:\git\opencode-model-router`, which stays on `master` and does **not** contain them yet). From P0.1 on, the
canonical copies are in the integration worktree `D:\git\omr-rta-main` (branch `rta/main`); amend and commit them
there only, and treat `D:\git\omr-plan-rta` as frozen.

---

## 1. Kickoff prompt (paste into a fresh OpenCode v2 session opened in `D:\git\opencode-model-router`)

```text
You are the executing orchestrator for issue #84, plan
D:\git\omr-plan-rta\docs\plans\role-tier-assurance-delegation-plan.md
(after P0.1 the canonical copy is D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-plan.md).
Resume point, environment, considerations and troubleshooting:
D:\git\omr-plan-rta\docs\plans\role-tier-assurance-delegation-handover.md
(after P0.1: D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-handover.md).

Read both files completely before acting. Then start at the "next task id" in handover §2 and
execute the plan to the end — Wave 0, Wave 1, DF-1, Wave 2, DF-2, Wave 3, release 2.4.0 —
following the plan's §0 directives, which are binding and override your defaults. The rules that
matter most:

1. Iterate continuously, phase after phase, wave after wave, without stopping to report. Stop ONLY
   for: a blocking or critical problem; an ambiguity only the human can settle; an OpenCode v2
   restart (every code sync into the base checkout needs one — DF-1, DF-2 and the P3.4 return to
   master — because the host imports plugin code once per process); the v2.4.0 publish
   confirmation. Before any stop, rewrite handover §2 with the exact next task id. Ask in Portuguese.
2. If the model-router blocks the work repeatedly because a less capable agent is verbose, cut off
   or stuck (progress notes instead of results, repeated NEED MORE, guard denials, the same dispatch
   failing twice), TEMPORARILY take over and do the blocked read or implementation yourself — you
   are a top-tier model — then return to delegating. Log every takeover in the phase QA report.
3. Pre-flight before EVERY phase (plan §5 standard pre-flight + the phase's items). Fix everything
   it finds; if the plan schedules the problem for a later phase, only document it as a handoff.
4. Senior heavy adversarial QA after EVERY phase and once globally (P3.3). Fix every finding of
   rounds 1 and 2; from round 3 on, fix only blocking, critical and major. Never loop reviews on the
   same implementation until findings run out.
5. Always delegate through the model-router, preferring atomic tasks (one goal per dispatch):
   lookups → @fast (read-only: read/glob/grep/router_git_*; it cannot run commands or edit);
   implementation, tests, mechanical fixes → @medium; complex coding → @heavy for the heavy lift
   only, with running and collecting tests in separate lighter dispatches. QA is ALWAYS a heavy-tier
   task: a separate @heavy dispatch (producer ≠ reviewer) whose prompt starts with
   [route class=review risk=high pin]. From DF-2 on, the implementation dogfoods itself: dispatch
   through the role agents (explorer, runner, implementer, reviewer, architect, researcher); tier
   agents only as a recorded fallback. Every dispatch has the 7 sections (TASK, EXPECTED OUTCOME,
   TOOLS, MUST DO, MUST NOT DO, CONTEXT, ENVIRONMENT) with full paths in the PHASE WORKTREE.
6. Never run the full suite when a scoped run answers the question. Test only what the change
   touches: the phase's test files plus `npx vitest related <changed files> --run --maxWorkers=4`.
   Accelerate with parallel dispatches over disjoint test sets and background smokes. Never
   --pool=threads. The capped full suite (--maxWorkers=2) only at wave integration, before a sync
   and in P3.4.
7. Commit after every green subtask, conventional commits, body "Refs #84", push at once. No AI
   attribution and no Co-Authored-By in any commit or PR, ever (tell every delegate the same).
8. Work only in worktrees: D:\git\omr-rta-main (integration, you only) and D:\git\omr-rta-<id> per
   phase. The base checkout D:\git\opencode-model-router is what the live host loads; it is written
   only by DF-1, DF-2 and P3.4. After every dispatch run
   `git -C D:\git\opencode-model-router status --porcelain`; non-empty output is a blocking incident.
   Keep handover §3 listing every open worktree.
9. Linear is not used. GitHub: one short progress comment on #84 at each wave close and dogfood
   checkpoint.
10. Talk to the human in Brazilian Portuguese, short and direct. Code, docs, commits, QA reports,
    issue comments and PRs are in English.
```

---

## 2. Execution state

| Item | Value |
|---|---|
| Checkpoint reached | Plan complete and reviewed; nothing executed |
| **Next task id** | **P0.1 pre-flight** (create `rta/main` from `origin/docs/role-tier-plan`, the integration worktree `D:\git\omr-rta-main`, the draft PR `rta/main → master`; capped full suite baseline) |
| Plan branch | `docs/role-tier-plan` (pushed); first commit `47f1e88`; this handover and R1/R2 in the following commit |
| `rta/main` | not created |
| Draft PR `rta/main → master` | not opened |
| Base checkout | `D:\git\opencode-model-router` on `master` @ `eeab36b`, clean |
| Live host | OpenCode **v2.0.24**, plugin loaded from the base checkout |
| Owner state (`C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json`, never write) | `activePreset: anthropic`, `activeMode: normal`, `enforcementMode: advisory` (the owner set `enforced` at 21:27Z and switched back to `advisory` in the evening) |
| Owner override (`C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`) | `routing {engine: enforce, profile: balanced, margin: 0.2}`; `subagentTiers {explore: fast}`; `agents`: `runner` (fast, explicit shell allowlist), `reviewer` (heavy, readOnly + `router_git_*`/`context7_*`), `researcher` (fast, readOnly + `webfetch`/`websearch`/`brave_*`/`context7_*`) |
| Live agent models | `fast`, `explore`, `runner`, `researcher`: `anthropic/claude-haiku-5-5#low`; `medium`: `anthropic/claude-sonnet-5-5#medium`; `heavy`, `reviewer`: `anthropic/claude-opus-5-5#xhigh`; `title`/`summary`: `anthropic/claude-haiku-5-5` (pinned in `C:\Users\Marquinho\.config\opencode\opencode.json`) |
| Dogfood | DF-1 pending; DF-2 pending |
| Restart stops | none requested yet; three planned (DF-1, DF-2, P3.4) |
| Plan amendments | R0, R1, R2; next free id: R3 |

---

## 3. Directories and worktrees

| Path | Branch | Purpose |
|---|---|---|
| `D:\git\opencode-model-router` | `master` @ `eeab36b` | **Base directory** of the repository. The live host loads the plugin from here. Written only by DF-1/DF-2 (local branch `rta/live`) and P3.4 |
| `D:\git\omr-plan-rta` | `docs/role-tier-plan` | Where the plan and this handover were written; frozen once `rta/main` exists; removed in T3.4.5 |
| `D:\git\omr-rta-main` | `rta/main` (created in P0.1) | Integration worktree; executor only; merges, plan amendments, handover, dogfood record |
| `D:\git\omr-rta-<id>` | `rta/<id>` | One per phase: `p01`, `p11`…`p16`, `p21`…`p23`, `p31`…`p34` |
| `D:\git\opencode` | (host source, tags `v1.18.34`, `v2.0.22`) | Read-only reference for hook, permission and agent semantics; the live host is 2.0.24 |
| `D:\git\opencode-model-router-agent-options-gate` (`fix/agent-options-provider-gate`), `D:\git\opencode-model-router-release` (`release/1.13.0`), `D:\git\opencode-model-router-v2` (`fix/gate-task-cwd`), `C:\Users\Marquinho\AppData\Local\Temp\omr-regress`, `C:\Users\Marquinho\AppData\Local\Temp\opencode\omr-old` | — | Older worktrees unrelated to this plan. **Do not touch or remove** |

Every dispatch prompt names the phase worktree as its working directory and translates the plan's base-checkout
paths into it (plan "Path convention").

---

## 4. Planning-session considerations (why the plan looks like this)

- **The central bet.** A dispatch is role × tier × assurance. The orchestrator picks the role (intent). The router
  picks the model per call, inside a floor set by authority × *effective* detection. Positive evidence comes only
  from checks the router itself observes. The earlier "orchestrator picks the tier" and "`general` auto with full
  tools" ideas were dropped (plan §1.3).
- **Do not expect savings from learning yet.** The cost-aware engine made 0 switches in 220+ dispatches and has 23
  verdict rows in 247 decisions (E1/E2). Savings come from structural defaults first. Exploration exists but is off
  (`rate: 0`); the owner decides whether to use 0.05 at the end.
- **Guard root causes (found while planning).** `DEFAULT_GUARD_BUDGET = 25` is at
  `D:\git\opencode-model-router\src\guard\enforce.ts:20`. The "3 consecutive non-producing actions" denial is at
  `D:\git\opencode-model-router\src\guard\guards.ts:223-227`. Denied calls are charged and later flagged as repeats.
  Under `enforced`, the plan's own @heavy reviewer was denied 10 of 26 calls even with `CAP:none` + `reason:`.
  `CAP:none` lifts only the read-only counter. The owner is in `advisory` now, so these warn instead of denying. DF-1
  makes the fix live.
- **E8 (false "NOT ACCEPTED").** The cited criterion is the router directive at
  `D:\git\opencode-model-router\src\router\dispatch-header.ts:20`. The candidate cut site is
  `D:\git\opencode-model-router\src\verify\dod.ts:62`, still unconfirmed: spike S5 / T0.1.2 settles it.
- **Spikes decide mechanics.** S1–S10 settle every host behaviour the design relies on. When a spike disproves a
  mechanism, write an amendment R<n> whose replacement keeps I1–I9 and continue. Ask the human only if no
  replacement keeps them.
- **Separation rule.** No grant mixes local read, exec or write with egress. Raw shell is egress, so it never appears
  in roles mode. Context7 is egress too (queries leave the machine). The researcher's `execute` (needed for
  `brave_*`) stays off unless S8 proves that Code Mode inner calls are permission-checked and that the catalog can be
  narrowed per session. Residual risks are documented, not solved: repo scripts may reach the network, repo content
  can carry injection, and flows routed through the orchestrator are not covered.
- **v1** gets nothing new except the mode-independent §2.9 fixes, each with a before/after golden. The roles keys are
  validated but inert there.
- **#80 trap.** One invalid override value drops the whole layer, including `routing`. Never write a key the live code
  does not know: owner-config writes happen only after the liveness probe of the code that accepts them. Always
  validate in a temp HOME and keep a `.bak-<yyyy-MM-dd_HH-mm-ss>` backup.
- **Restarts are expensive (A8).** Plugin code is imported once per process; only config hot-reloads. The plan has
  exactly three restart stops. Batch post-DF-2 fixes into P3.4's sync unless they block Wave 3.
- **Literature.** Only L1–L14 are verified. The researcher could not verify Hybrid LLM, SWE-agent, Agentless,
  RAG-MCP, "Lost in the Middle", bandit-routing papers, Progent, AgentDojo (as a separate source) or Greshake et al.
  Do not cite them in the ADR without verifying them first (title, authors, arXiv id, URL).
- **Reference sessions** (evidence only, do not resume for new work): researcher `ses_ee6f0bcefffeU7TvRn4G8MJq0R`
  (literature L1–L14); plan reviewer `ses_ee6e6dee9ffef2QQoPWOt1Pn6G` (PLAN-1…21, notes draft at
  `C:\Users\Marquinho\AppData\Local\Temp\Claude\rta-plan-review-draft.md`, a temp file that may be gone);
  guard-denied @fast `ses_ee6f0ba89ffenfzGLa5sDIrf6R` (E6).
- **Release mechanics.** Pushing a `v*` tag triggers `.github\workflows\publish.yml` (npm trusted publishing with
  provenance). No GitHub Release objects have been created since v1.11.1; do not create one unless asked.

---

## 5. Delegation behaviour observed (expect it again)

- **Cut-offs at about 25 tool calls** (the guard budget), even with `CAP:none` + `reason:`. Resume the **same session
  id** with "continue and finish; do not end your turn until committed, pushed and `git status` clean". Never restart
  from scratch. Resuming preserved all work every time.
- **@medium ends a turn mid-task** ("I'll finish…", "Tools are available again…"). Check `git status` / `git log` in
  the worktree and resume the same session.
- **NEED MORE with zero tool calls.** Re-dispatch once with "attempt the work first: make these three concrete calls
  …". On a second failure, take over (plan §0.9.2) and log it.
- **@fast is read-only (#78):** read/glob/grep/`router_git_*` only, no shell, no edit. Give runs to @medium (from DF-2
  on, `runner`). Its glob stops at 100 results, so use narrow patterns, and verify counts with pwsh when they matter.
- **Router grader "NOT ACCEPTED"** citing "…do not ask to be re-dispa…" is a false negative until DF-1 (E8). Verify
  with git and the scoped tests; do not escalate on it.
- **`[router] unverified · vrf_…` footer.** Call `router_verify` (handles, or `pending: true`) before building on a
  medium/high-risk result. If it returns `unverifiable`, run the scoped tests yourself and record them in the QA
  report.
- **"socket connection was closed unexpectedly"** is a host/provider streaming error, not the router. Resume the same
  session.
- **Stray files.** Subagents have written files into the base checkout through .NET `WriteAllText` with relative
  paths. Every MUST NOT DO says "full paths only; never relative .NET writes". The `status --porcelain` check runs
  after every dispatch.
- **Delegates must label severities.** QA prompts require each finding to carry an id, severity
  (blocking|critical|major|minor|nit), location, problem and concrete fix, ending with a one-line verdict.

---

## 6. Troubleshooting

| Symptom | What to do |
|---|---|
| "read/draft budget exhausted (3 consecutive non-producing actions)" or "tool-call budget 25 exhausted" | The owner is in `enforced` again (check `state.json` read-only; never write it). Use plan §0.2.6: a notes file every second read, ≤ 15 information calls, split by area. DF-1 removes the cause |
| "DENIED: you already ran this exact read" after a denial | Same root cause: the denied call was recorded. Read a different range, or take the content from the notes file |
| `CAP:none` ignored | It needs a `reason:` line in the same dispatch, and it lifts only the read-only counter, not the 25-call budget |
| After a sync, `/router` does not show `build=<new sha>` | Expected: the code is not live until a restart (A8). Rewrite §2 and send the §7 message; stop. On resume, probe first |
| After a restart: `failed to load plugin … Cannot find package '@opencode-ai/plugin'` | `npm ci` raced the restart (DF4 incident). Let `npm ci` finish in `D:\git\opencode-model-router` and ask for another restart: the host caches the failed resolve |
| `Unknown agent: fast` (or a role agent) | The plugin is not loaded. Work directly with your own tools, check `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`, roll back if needed (§0.7), then make a restart stop |
| Fast-forward blocked by `.git\index.lock` | Confirm no git process runs (`Get-Process git -ErrorAction SilentlyContinue`), then remove the lock |
| Config change not reflected | Wrong file. The target is `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`, not `tiers.json` or `opencode.json`. Agent changes apply at the next orchestrator prompt |
| Routing silently back to defaults after an override write | The layer was dropped by an invalid value (#80). Restore the backup at once, then validate in a temp HOME |
| `tsx` probe fails on `@opencode-ai/plugin` exports | Probe through a temporary vitest file in the phase worktree that writes its output to a file; delete the file afterwards |
| vitest finds no files for a glob | vitest does not expand globs under pwsh; list the files |
| A test touched the real HOME or the live store | Never `--pool=threads` (cost-aware A14). Keep `test\setup\home-guard.ts` and `test\setup\global-guard.ts`; treat it as a blocking incident |
| `test\unit\exec.test.ts` `lowPriority` fails locally | Known WMI-timeout flake; re-run that file once |
| Windows CI job: EBUSY/ENOTEMPTY or a hook timeout in unchanged files | `gh run rerun <run-id> --failed`. Never weaken a new test to get green |
| CI does not run on a branch | CI runs only on PRs and `master`. Use the draft PR `rta/main → master` |
| `gh` body with quotes or newlines breaks in pwsh | Write the body to a file under `$env:TEMP` and pass `--body-file` |
| `rg` in pwsh | Single-quote patterns. Never name a pwsh helper function `R` (alias of `Invoke-History`) |
| Web or GitHub reads | Code Mode `execute` + `fetch`; the GitHub API needs a `User-Agent` header |
| Slow or flaky runs with many worktrees | `npm ci` one worktree at a time; capped suite serialized; real-host smokes serial and in the background |
| Merge conflict in a hot file (`src\index.ts`, `src\compat\v2-hooks.ts`, `src\routing\wire\dispatch.ts`, `src\router\config.ts`) | One owner per wave (plan §4). Only the executor merges, in `D:\git\omr-rta-main`, one phase at a time, with a `[tier:heavy]` integration review |
| QA keeps finding minors on round 3+ | Fix only blocking/critical/major; record the rest as "accepted — QA round limit" |
| Anything that would print `C:\Users\Marquinho\.config\opencode\opencode.json` | Do not print it: its `mcp` block holds plaintext API keys (rotation has been recommended to the owner) |

---

## 7. Restart stop — the messages to the human

Rewrite §2 first (next task id = the liveness probe of the checkpoint), commit and push the handover in
`D:\git\omr-rta-main`, then send:

- DF-1: "DF-1 sincronizado (`rta/live` @ `<sha>`, rollback `rta/df1-prev`). O código novo só fica ativo depois de
  reiniciar o OpenCode v2. Reinicie e diga 'retomar'."
- DF-2: "DF-2 sincronizado (`rta/live` @ `<sha>`, rollback `rta/df2-prev`). Depois do restart eu valido o código,
  migro seu override para o modo roles (com backup) e passo a executar a Wave 3 pelos role agents. Reinicie e diga
  'retomar'."
- P3.4: "Merge em `master` feito (`<sha>`), CI verde. Preciso de duas coisas: reiniciar o OpenCode v2 (a base volta
  para `master`) e sua confirmação para publicar a 2.4.0 no npm (push da tag `v2.4.0`). Reinicie e diga 'retomar e
  publicar' ou 'retomar sem publicar'."
- Unplanned: state the cause in one line (log excerpt), the rollback already applied and what will be checked after
  the restart.

On resume, always run the liveness probe (plan §0.7) before anything else.

---

## 8. Phase log (the executor updates this table)

| Phase | Worktree | Status | QA rounds / verdict | Merge sha | Report |
|---|---|---|---|---|---|
| P0.1 | `D:\git\omr-rta-p01` | pending | — | — | `docs\qa\role-tier\phase-p01.md` |
| P1.1 | `D:\git\omr-rta-p11` | pending | — | — | `docs\qa\role-tier\phase-p11.md` |
| P1.2 | `D:\git\omr-rta-p12` | pending | — | — | `docs\qa\role-tier\phase-p12.md` |
| P1.3 | `D:\git\omr-rta-p13` | pending | — | — | `docs\qa\role-tier\phase-p13.md` |
| P1.4 | `D:\git\omr-rta-p14` | pending | — | — | `docs\qa\role-tier\phase-p14.md` |
| P1.5 | `D:\git\omr-rta-p15` | pending | — | — | `docs\qa\role-tier\phase-p15.md` |
| P1.6 | `D:\git\omr-rta-p16` | pending | — | — | `docs\qa\role-tier\phase-p16.md` |
| DF-1 | base checkout (`rta/live`) | pending | — | — | `docs\qa\role-tier\dogfood.md` |
| P2.1 | `D:\git\omr-rta-p21` | pending | — | — | `docs\qa\role-tier\phase-p21.md` |
| P2.2 | `D:\git\omr-rta-p22` | pending | — | — | `docs\qa\role-tier\phase-p22.md` |
| P2.3 | `D:\git\omr-rta-p23` | pending | — | — | `docs\qa\role-tier\phase-p23.md` |
| DF-2 | base checkout (`rta/live`) | pending | — | — | `docs\qa\role-tier\dogfood.md` |
| P3.1 | `D:\git\omr-rta-p31` | pending | — | — | `docs\qa\role-tier\phase-p31.md` |
| P3.2 | `D:\git\omr-rta-p32` | pending | — | — | `docs\qa\role-tier\phase-p32.md` |
| P3.3 | `D:\git\omr-rta-main` + `rta/p33-fix-<n>` | pending | — | — | `docs\qa\role-tier\global.md` |
| P3.4 | `D:\git\omr-rta-main`, base checkout | pending | — | — | `docs\qa\role-tier\phase-p34.md` |
