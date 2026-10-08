# Role × Tier × Assurance delegation for OpenCode v2 — implementation plan

| | |
|---|---|
| Tracking issue | #84 |
| Base | `master` @ `eeab36b` (v2.3.0 + #78 read-only fast, #82 plugin agents, #83 anthropic fast on Haiku 5.5); the integration branch starts from `origin/docs/role-tier-plan` (= `master` + this plan) |
| Handover / kickoff | `D:\git\omr-plan-rta\docs\plans\role-tier-assurance-delegation-handover.md` until P0.1, then `D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-handover.md` |
| Self-test | the implementation dogfoods itself: checkpoints DF-1 (after Wave 1) and DF-2 (after Wave 2) run the integration code as the live plugin, and Wave 3 is executed through the new role agents (§0.10, §5) |
| Host scope | OpenCode **v2** (live: 2.0.24). OpenCode v1 keeps today's tier model (fallback, §2.7) except the mode-independent fixes of §2.9. |
| Target version | 2.4.0 |
| Executor | one high-capability LLM orchestrator using the model-router tiers, end to end |
| Pre-execution review | adversarial `[tier:heavy]` review PLAN-1…PLAN-21 incorporated (§9, R0) |

**Path convention.** This plan names files by their full path in the base checkout `D:\git\opencode-model-router`
for readability. **Dispatch prompts must translate every path to the phase worktree** (`D:\git\omr-rta-<id>\…`, e.g.
`D:\git\opencode-model-router\src\router\roles.ts` → `D:\git\omr-rta-p11\src\router\roles.ts`). The base checkout is
what the live host loads; only the executor writes there, at DF-1, DF-2 and P3.4 (§0.3.4, §0.7). The plan, the
handover and `docs\qa\role-tier\dogfood.md` are executor-owned and live in the integration worktree
`D:\git\omr-rta-main` (§4).

---

## 0. Directives (binding for the executor)

### 0.1 Execution loop
1. Execute the plan **continuously, wave after wave, phase after phase, without stopping to report**. Stop and ask the
   human **only** for:
   - an ambiguity that changes the design and cannot be settled from this plan, the code or the host source;
   - a critical or blocking problem (data loss, a security hole that cannot be fixed inside the plan, a broken live
     host, a CI failure that cannot be attributed, a non-empty `git status` in the base checkout);
   - the irreversible publish in P3.4 (tag `v2.4.0` → `npm publish`) — the one planned human gate;
   - **whenever an OpenCode v2 restart is needed** — after **every** code sync into the base checkout (DF-1, DF-2, the
     P3.4 return to `master`: the host imports plugin code once per process — cost-aware plan A8, i.e. *its* spike S7,
     not this plan's S7), when the
     plugin is not loaded, or when host state is stuck: stop, rewrite the handover's resume state first, then tell the
     human (in Portuguese) exactly why and what will be checked after the restart (§0.7);
   - once, at P0.1, only if heavy QA dispatches cannot complete under the owner's guard mode (§0.2.6).
2. Every phase runs: **pre-flight → tasks → tests → senior QA review → fixes → merge**. No phase is skipped and no
   phase is merged with an open blocking/critical/major finding.
3. Every phase delivers the **definitive** solution for its objective. No stubs, no placeholders, no phase whose
   output must be redone later. A task that grows is split into atomic dispatches, never into a weaker deliverable.
4. Plan changes are recorded as amendments `R<n>` in §9 with reason and evidence, committed with the plan file.

### 0.2 Delegation (model-router annotation)
1. Every task and step carries a tier tag. `[tier:fast]` = read-only lookups (read/glob/grep/`router_git_*`; @fast is
   read-only since #78 and **cannot run commands or edit**). `[tier:medium]` = implementation, tests, running
   tests/builds and interpreting them, mechanical fixes, docs. `[tier:heavy]` = hard design/security lifts
   where marked and **every QA review**. `[executor]` = the executor itself: merges into `rta/main`, the sync and
   rollback commands of §0.7 (they swap code under the running host), and edits to the executor-owned files (§4).
2. **QA is always `[tier:heavy]`**, adversarial, producer ≠ reviewer, reviewer never edits. Every QA dispatch prompt
   starts with the route line `[route class=review risk=high pin]`.
3. Heavy split: facts are gathered first (@fast or the executor) and pasted into the heavy prompt; heavy does the lift;
   @medium applies mechanical follow-ups and runs tests.
4. Atomic dispatches: one goal per dispatch; producers commit and push after every green group; on a cut-off,
   **resume the same session id** with "continue and finish" — never restart from scratch.
5. Verify every producer claim (`git log`, `git status`, test tails). Until P1.5 is live, a router "NOT ACCEPTED"
   verdict that cites a truncated criterion ("…do not ask to be re-dispa…") is a known false negative (E8).
6. Until DF-1 makes the §2.9 guard fixes live, the guard in `D:\git\opencode-model-router\src\guard\guards.ts` limits
   each dispatch (E6/E7: 25 calls, denial after 3 consecutive reads, denied calls charged) whenever the owner's
   `enforcementMode` is `enforced` (it was switched back to `advisory` on 2026-10-07 evening; in `advisory` the guard
   warns instead of denying). Every read-heavy prompt (lookups, QA) therefore
   instructs: "after every second read, append findings to `C:\Users\Marquinho\AppData\Local\Temp\Claude\<phase>-<agent>-notes.md`
   in its own turn; keep each dispatch to ≤ 15 information calls; split larger reviews by area". If heavy QA still
   cannot complete, the executor asks the human once (P0.1) whether to set `enforcementMode: advisory` for the
   duration of the plan; the executor never changes the owner's state itself.
7. Every dispatch prompt follows the 7-section structure (TASK, EXPECTED OUTCOME, TOOLS, MUST DO, MUST NOT DO,
   CONTEXT, ENVIRONMENT) with full **worktree** paths.

### 0.3 Parallelism with safe file ownership
1. **One writer per file at any time.** Each phase owns the files listed in §4; a file owned by an active phase is
   never written by anyone else.
2. **No reads of files under edit.** An agent that needs a file owned by another *active* phase reads only its
   committed state on the integration branch: `git -C D:\git\opencode-model-router show rta/main:<path>`. Exception:
   a phase's QA reviewer reads that phase's worktree while its producer is idle (no dispatch running).
3. **Contract-first commits.** When phases depend on each other's interfaces, the provider's **first commit** publishes
   exactly the contracts listed in §2.4; the executor merges that commit into `rta/main` at once; dependents rebase.
   Contracts change only by a §9 amendment. Changes to shared type files are additive only within a wave.
4. **One worktree per phase** (`D:\git\omr-rta-<id>`, branch `rta/<id>` from `rta/main`). Only the executor merges into
   `rta/main`, from the integration worktree `D:\git\omr-rta-main`; a phase is merged **as soon as its QA passes**
   (intra-wave dependencies, e.g. P2.3, rely on it). Only the dogfood checkpoints DF-1/DF-2 (local branch `rta/live`
   in the base checkout) and P3.4 touch the base checkout; only P3.4 touches `master`.
5. **Shared hot files** have exactly one owner per wave (§4). Other phases hand required changes to the owner as
   handoff items.
6. New tests go into new test files per phase; editing an existing test file follows the ownership rule.
7. Maximise parallel dispatch: independent lookups as parallel @fast calls; disjoint files to parallel @medium
   producers when the phase splits its own ownership explicitly.
8. After **every** dispatch the executor runs `git -C D:\git\opencode-model-router status --porcelain`; a non-empty
   result is a blocking incident (E12).

### 0.4 Commits
Commit after every green subtask; conventional commits (`feat(roles): …`, `fix(guard): …`, `test(roles): …`,
`docs(roles): …`), body `Refs #84`, **no AI attribution, no Co-Authored-By**; push every commit;
`npm run typecheck` before every commit.

### 0.5 Tests
- Scoped only: the phase's new/changed test files listed explicitly plus
  `npx vitest related <changed src files> --run --maxWorkers=4`. **Never `--pool=threads`.** vitest does not expand
  globs.
- The capped full suite (`npx vitest run --maxWorkers=2`, ≈6–7 min) runs only at wave integration, before a dogfood
  sync and in P3.4. Never run the full suite when a scoped run answers the question.
- Accelerate: scoped runs use `--maxWorkers=4`; disjoint scoped test sets of independent phases run as parallel
  dispatches; long real-host smokes run in the background (`Bash` with `background: true`) while other work
  continues; re-run only the failed files, never the whole set, after a fix.
- Windows: temp-dir cleanup `{ recursive: true, force: true, maxRetries: 10, retryDelay: 200 }`; no absolute
  wall-clock assertion under 50 ms (ratios or timer spies); timeouts ≥ 60 s for process-spawning tests.
- Tests use temp HOME/TEMP only (guards in `D:\git\opencode-model-router\test\setup\home-guard.ts` and
  `D:\git\opencode-model-router\test\setup\global-guard.ts`).
- Known unrelated flakes (`D:\git\opencode-model-router\test\unit\exec.test.ts` `lowPriority`, Windows EBUSY in
  pre-existing process tests) are re-run once; they never justify weakening a new test.
- New modules: ≥ 90% branch coverage measured with `--coverage --coverage.include=<file>`.

### 0.6 QA rounds
Rounds 1–2: fix **every** finding. From round 3: fix only blocking/critical/major; minors are recorded as handoffs
marked "accepted — QA round limit". Each phase
writes `D:\git\opencode-model-router\docs\qa\role-tier\phase-<id>.md` (Pre-flight, Implementation, Tests, Findings,
Handoffs, Verdict).

### 0.7 Live-system safety
- Outside the dogfood checkpoints (DF-1, DF-2), P3.4 and a §0.10 kill switch or re-sync (each recorded in its own
  dogfood.md section) never touch `C:\Users\Marquinho\.config\opencode\*`, the live store
  `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory`, the live service or the base checkout.
  Read-only copies for evidence are allowed. Never touch `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json`
  (owner state) or print secrets from `C:\Users\Marquinho\.config\opencode\opencode.json`.
- Never write files through .NET APIs with relative paths (E12).
- **Sync protocol** (DF-1, DF-2, P3.4) `[executor]`: capped full suite green on the code being synced (the
  wave-integration run counts if nothing outside `docs\` changed since); tag `rta/df<n>-prev` (or `rta/sync-prev`) at
  the base checkout's current HEAD — a re-sync keeps the original tag; move the base checkout
  (`git -C D:\git\opencode-model-router switch --no-track -C rta/live origin/rta/main` at DF-1,
  `git -C D:\git\opencode-model-router merge --ff-only origin/rta/main` on `rta/live` at DF-2); `npm ci` **only** if
  `git -C D:\git\opencode-model-router diff --quiet <previous HEAD> HEAD -- package-lock.json` exits non-zero, never
  while a restart may be pending (DF4 incident of the cost-aware plan), and always finished **before** the restart
  request.
- **Restart and liveness.** Synced code is **not live** until the host restarts (plugin code is imported once per
  process; config files hot-reload, code does not): rewrite the handover resume state, ask the human to restart
  OpenCode v2 and to paste the `/router` line `router: engine=… build=…` together with "retomar" (handover §7), stop
  (§0.1). The **liveness probe** after the restart: in the pasted `build=<version>+<sha7>`
  (`D:\git\opencode-model-router\src\router\build-info.ts`) `<sha7>` equals the first 7 hex digits of the synced
  commit; a plugin-load line for opencode-model-router newer than the restart and no `failed to load plugin` in
  `C:\Users\Marquinho\.local\share\opencode\log\opencode.log`; `opencode api get
  '/api/agent?location%5Bdirectory%5D=D%3A%5Cgit%5Copencode-model-router'` (works on the live 2.0.24, used 2026-10-07)
  lists the router agents. A marker with the previous sha means the host was not restarted: ask again, no rollback.
  A marker `unknown`, a load failure or missing router agents → rollback and a critical finding for the owning phase.
  Routing keys of the override hot-reload; whether agent registrations follow an override change without a restart is
  settled by spike S12.
- **Rollback** `[executor]`, in order: (1) restore the newest override `.bak-<timestamp>` taken by this checkpoint (hot
  reload; for DF-2 this is the §0.10 kill switch); (2) only if the code is broken: DF-1 →
  `git -C D:\git\opencode-model-router switch master`; DF-2 → `git -C D:\git\opencode-model-router reset --hard
  rta/df2-prev` on `rta/live`; P3.4 → `git -C D:\git\opencode-model-router switch --detach rta/sync-prev` (never reset
  `master`; keep `rta/live` until the P3.4 probe passes); (3) `npm ci` if `package-lock.json` differs between the two
  commits, finished before (4) the restart stop — a code rollback is not live until a restart either. A stale
  `D:\git\opencode-model-router\.git\index.lock` is removed only after confirming no git process runs.
- Owner config changes happen only at DF-2, P3.4 and a §0.10 kill switch, **only after the liveness probe shows code
  that accepts every key being written** (code that does not know a key rejects it, and an invalid value drops the
  whole layer, including `routing`, #80), always validated in a temp HOME first and backed up as
  `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc.bak-<yyyy-MM-dd_HH-mm-ss>`. After every
  write the file's SHA-256 is recorded in dogfood.md (the pre-flight baseline, §5).

### 0.8 Wave integration
[tier:medium] When every phase of a wave has passed QA and is merged: typecheck and the capped full suite on
`rta/main`; push; the draft PR `rta/main → master` (opened in P0.1) runs the 12-job CI (CI runs only on PRs/master,
E11). A wave closes only when CI is green. [tier:heavy] Hot-file merge conflicts get an integration review.

### 0.9 Owner operating rules (verbatim intent, binding)
1. Iterate continuously; stop only for a blocking or critical problem (plus the §0.1 exceptions).
2. If the model-router blocks the work repeatedly because a less capable agent is verbose, cut off or stuck
   (progress notes instead of results, repeated "NEED MORE", guard denials, the same dispatch failing twice), the
   executor — a top-tier model — **temporarily takes over and performs the blocked read or implementation itself**,
   then returns to delegating. Record each takeover in the phase QA report (what, why, which dispatch failed).
3. Pre-flight before every phase; fix everything it finds, or — when the plan assigns the problem to a later phase —
   only document it as a handoff.
4. Senior heavy QA after every phase; fix every finding of rounds 1–2; from round 3 fix only blocking/critical/major;
   never loop reviews to exhaustion on the same implementation.
5. Always delegate through the model-router, preferring atomic tasks. Complex coding may go to `[tier:heavy]` for the
   heavy lift; running and collecting tests goes to lighter delegations. In roles mode (from DF-2) the heavy lift goes
   to `implementer` with the first line `[route class=implement risk=high tier=heavy pin]` (§0.10).
6. Never run the full suite when not needed; test what the change touches; accelerate with parallelism (§0.5).
7. QA is always a heavy-tier task; adversarial review of the work done; commit often.
8. Linear: not used by this project (the repo `.env` holds only `OPENCODE_API_KEY`; no Linear references). Progress
   is tracked on GitHub issue #84 (comment at each wave close and at each dogfood checkpoint).
9. When working in a worktree outside the base directory, every handover/resume record names the worktree directory
   and the base directory (§0.3.4, handover §2).

### 0.10 Self-test (dogfooding)
The plan uses its own implementation as a live self-test as soon as it is safe:
- **DF-1** (after Wave 1 integration): the §2.9 fixes (reader guard profile, uncharged denials, criterion handling)
  go live in the base checkout after the owner's restart; the executor's own QA and lookup dispatches from Wave 2 on
  are the test — they must no longer receive "non-producing" guard warnings or denials, nor truncated-criterion
  "NOT ACCEPTED" verdicts. The tier agents' 25-call total budget is unchanged in tiers mode (E7 is solved by role
  budgets, proven at DF-2). Roles code is inert (`delegation: "tiers"`).
- **DF-2** (after Wave 2 integration): roles mode goes live for the owner (`routing.delegation: "roles"`), and **Wave 3
  is executed through the role agents**: lookups → `explorer`, test runs → `runner`, implementation → `implementer`,
  QA → `reviewer` (heavy, satisfies "QA is always heavy"), design → `architect`, web/docs research → `researcher`,
  complex coding → `implementer` with the first line `[route class=implement risk=high tier=heavy pin]`. Every role
  dispatch names its phase worktree as the work root (§2.2). The tier agents stay callable as a recorded fallback. Every role dispatch of the executor is evidence: decision rows with role,
  grant, bounds and signal fields; authority requests; budget behaviour; `router_run` use.
- A defect found by self-test is a QA finding of the phase that owns the code (or of P3.3 once Wave 3 runs). If it
  blocks work, use the **kill switch**: restore the pre-DF-2 override backup (hot reload: tiers mode,
  `subagentTiers.explore` and the custom `runner`/`reviewer`/`researcher` agents return; registration timing per S12),
  fix, re-sync (restart stop), re-apply the validated migration.
- Records: `D:\git\omr-rta-main\docs\qa\role-tier\dogfood.md`, written and committed by the executor on `rta/main`
  only, never in the base checkout: a P0.1 baseline section, then one section per checkpoint or kill-switch event
  (sync SHA, rollback tag, liveness evidence, override SHA-256, config diff, observations, `routing:stats` excerpt with
  bounded `--since/--until`). It holds aggregated counts and the decision-row fields role, grant, bounds, signal and
  model only — never prompt text, tool arguments or file contents from the live store.

---

## 1. Revised hypotheses — literature and today's evidence

### 1.1 Evidence from the runs of 2026-10-06/07
| Id | Evidence | Source |
|---|---|---|
| E1 | The cost-aware engine never switched a dispatch: DF3 79 rows (65/65 agreement), DF4 112 (67/67), DF5 56 (24/24); since DF4 220 dispatches, 101 eligible, 0 switches | `D:\git\opencode-model-router\docs\qa\cost-aware-routing\dogfood.md` |
| E2 | Outcome signal is starved: 23 verdict rows over 247 decision rows; "kept for lack of evidence" 23 of 84 fresh | DF5 record, QA-3.4 reproduction |
| E3 | The rules classifier skews: `design` 24 of 51 fresh; a file listing classified `review` @0.5 | DF2/DF3 records |
| E4 | Producers reported DONE while heavy QA then found serious defects (2.4 R1: 1 critical + 4 major; global QA R1: 1 critical + 8 major; #77 git tools R1: 3 blocking + 1 critical; #81 R1: 1 blocking + 2 critical) | `D:\git\opencode-model-router\docs\qa\` reports |
| E5 | `gpt-6-luna-fast` searched the Code Mode catalog for "shell", found nothing and returned NEED MORE although direct tools existed; denying `execute` removed the confusion | session `ses_ee9cf7d50ffeq270hLk5fBJMwY`, #77 |
| E6 | Read-only agents are denied by the producer-oriented guard: "read/draft budget exhausted (3 consecutive non-producing actions)" — hit by the read-only @fast and by this plan's own heavy review, even with `CAP:none` + `reason:`; denied calls are charged to the budget and later counted as repeats | `D:\git\opencode-model-router\src\guard\guards.ts:223-227`, sessions `ses_ee6f0ba89ffenfzGLa5sDIrf6R`, `ses_ee6e6dee9ffef2QQoPWOt1Pn6G` |
| E7 | Many dispatches cut at 25 tool calls (`DEFAULT_GUARD_BUDGET`, cumulative ×3); resuming the same session id preserved all work every time | `D:\git\opencode-model-router\src\guard\enforce.ts:20,27,43-56` |
| E8 | ≥10 false "NOT ACCEPTED" verdicts citing a criterion cut mid-sentence; the criterion is a router instruction, not an outcome | `D:\git\opencode-model-router\src\router\dispatch-header.ts:20`; candidate cut site `D:\git\opencode-model-router\src\verify\dod.ts:62` |
| E9 | Shell allow-patterns bypassable (newline, `&`, `|`, backtick, `$(`); the v1 action name `bash` silently failed on v2 (`shell`) until a real-host smoke caught it | QA-81-R2-7, #81 smoke |
| E10 | Host facts: the per-call `model` overrides the agent model; `session.created` carries parentID/agent/title; tool hooks reach only the session location's instance; `execute.before` does not fire for the runner's internal `native.execute`; same-model variant steps travel in-band | `D:\git\opencode-model-router\docs\qa\cost-aware-routing\phase-3.2.md` |
| E11 | GitHub CI runs only on PRs/master; Windows jobs flake on temp-dir cleanup and tight timing | PR #76/#78/#82/#83 runs |
| E12 | A subagent's relative-path .NET write landed an empty file in the base checkout | #81 step 6 |
| E13 | The owner's custom `researcher` combined local reads with web egress; its `brave_*` tools need Code Mode `execute`, which also exposes the whole Code Mode catalog | owner override, #81 review, PLAN-3 |

### 1.2 Literature (verified citations only)
- [L1] Chen, Zaharia, Zou. *FrugalGPT.* arXiv:2305.05176 (2023) — cascades match the best single model with large cost reductions on their benchmarks.
- [L2] Ong et al. *RouteLLM.* arXiv:2406.18665 (2024) — learned strong/weak routers cut cost >2× in some settings without quality loss.
- [L3] Aggarwal, Madaan et al. *AutoMix.* arXiv:2310.12963 (NeurIPS 2024) — routes on few-shot self-verification, a signal the authors call noisy, and still saves cost.
- [L4] Dekoninck, Baader, Vechev. *A Unified Approach to Routing and Cascading for LLMs.* arXiv:2410.10347 (2024) — quality estimators are the critical factor.
- [L5] Huang et al. *Large Language Models Cannot Self-Correct Reasoning Yet.* arXiv:2310.01798 (ICLR 2024).
- [L6] Kamoi et al. *When Can LLMs Actually Correct Their Own Mistakes?* arXiv:2406.01297 (TACL 2024) — self-correction works with reliable external feedback.
- [L7] Xiong et al. *Can LLMs Express Their Uncertainty?* arXiv:2306.13063 (ICLR 2024) — verbalized confidence is overconfident.
- [L8] Kadavath et al. *Language Models (Mostly) Know What They Know.* arXiv:2207.05221 (2022) — self-evaluation can be calibrated (format/scale dependent).
- [L9] Zheng et al. *Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena.* arXiv:2306.05685 (2023) — judges agree >80% with humans but show position, verbosity and self-enhancement bias.
- [L10] Cemri et al. *Why Do Multi-Agent LLM Systems Fail?* arXiv:2503.13657 (2025) — MAST: 14 failure modes in system design, inter-agent misalignment, task verification.
- [L11] Hong et al. *MetaGPT.* arXiv:2308.00352 (2023) — SOP-encoded roles on the authors' benchmarks.
- [L12] Beurer-Kellner et al. *Design Patterns for Securing LLM Agents against Prompt Injections.* arXiv:2506.08837 (2025) — capability separation patterns with an explicit utility trade-off.
- [L13] Debenedetti et al. *Defeating Prompt Injections by Design (CaMeL).* arXiv:2503.18813 (2025) — capability tracking blocks exfiltration; 77% vs 84% task success undefended on AgentDojo.
- [L14] MITRE CWE-78, OS command injection (non-academic, authoritative) — fixed-argv calls over command strings; denylists are weak.

Not verified at planning time and not used as support: SWE-agent, Agentless, RAG-MCP, "Lost in the Middle",
bandit-routing papers, Progent, AgentDojo as a separate source, Greshake et al.

### 1.3 Hypotheses after revision
| # | Hypothesis | Status | Basis |
|---|---|---|---|
| RH1 | Savings come first from **structural defaults** (role → class → tier; cheap models on read-only work); learned switching adds savings only once outcome signal exists | revised (was: the engine learns the savings) | L1–L4 (estimator quality is critical); E1, E2 |
| RH2 | Positive evidence only from **external verification**: deterministic checks and router-observed runs (weight 1); an independent grader (tier ≥ producer, different model) weight 0.5; self-reported DONE weight 0 — a conservative local choice | revised (was: DONE as weak positive) | E4, E8; L6, L7, L9 support discounting self-assessment; L3, L8 show it carries *some* signal, so 0 is a deliberate conservative setting |
| RH3 | A **small, explicit role set** with written contracts, plus role-aware infrastructure; every handoff has a cost | motivated, not proven | L10 (failure categories), L11; E5, E6 |
| RH4 | **Least privilege with capability separation**: no grant holds local reads/code execution together with an egress channel | partially supported: it blocks a role's own read→egress path, not flows routed through the orchestrator | L12, L13; E13 |
| RH5 | **Authority × effective detection floor**: write authority on a cheap model only behind checks the router itself runs; edit + execution never on the cheapest tier | derived | L6; D9/A34 history; PLAN-5 |
| RH6 | **Structured fixed-argv tools** for routine commands; npm script bodies still run through npm's script shell, which is pinned | supported | L14; E9 |
| RH7 | **Budget exhaustion is not model failure**; budgets belong to the role/tier; a cut-off resumes the same session | evidence-only | E6, E7 |
| RH8 | **Fewer advertised tools per role** reduce tool-selection confusion and per-turn tokens | evidence-only | E5; measured in P1.4 stats |
| RH9 | Learning cheaper tiers needs **safe exploration** (only behind effective deterministic detection) | evidence-only, experimental, **off by default** | E1, E2 |
| RH10 | Verification text is **never truncated mid-criterion**; router instructions are not gradable outcomes | evidence-only | E8 |

Dropped from the earlier proposal: "DONE as a weak positive", "`general` auto with full tools on a cheap model",
"the orchestrator picks the tier", and "`general` may receive raw shell".

---

## 2. Target design (OpenCode v2)

### 2.1 Three axes
A dispatch is **role × tier × assurance**:
- **Role** — chosen by the orchestrator (intent): capability contract (authority), prompt and return contract, guard
  profile, budget, default assurance.
- **Tier** — chosen by the router per dispatch: the class's static tier, clamped to the role range and the authority
  floor, then (engine `enforce`) the kernel's expected-cost decision with the A27 evidence gate. The router always
  sets the per-call `model` (E10).
- **Assurance** — the **effective** detection: `deterministic` only when the router's own gate
  (`D:\git\opencode-model-router\src\verify\deterministic.ts`) will run the acceptance checks for this dispatch;
  otherwise the weaker of the route-line claim and the prompt's `[acceptance]` block (A34), never stronger.

### 2.2 Roles shipped (v2, `routing.delegation: "roles"`)
Action classes: **local** = `read`, `glob`, `grep`, `router_git_*`; **exec** = `router_run`; **write** = `edit`;
**egress** = `webfetch`, `websearch`, `context7_*`, `execute`, every MCP tool, `shell` (`network` ⇒ `shell`,
`D:\git\opencode-model-router\src\routing\classify\types.ts:65-68`).

| Agent | Kind | Authority (max) | Tier range | Default assurance | Guard | Budget (calls fast/medium/heavy) |
|---|---|---|---|---|---|---|
| `explorer` | explore | local | fast–medium | none | reader | 30 / 40 / — |
| `researcher` | research | egress: `webfetch`, `websearch`, `context7_*` (+ `execute` only if S8 passes, restricted to `codeModeAllow`) — **no local** | fast–medium | none | reader | 30 / 40 / — |
| `runner` | run | local + exec | fast–medium | deterministic (router-observed run) | reader | 25 / 40 / — |
| `implementer` | implement | local + write; exec only when the task needs it | fast–heavy (floor §2.3) | from the prompt | producer | 40 / 80 / 120 |
| `reviewer` | review | local + exec | heavy–heavy | none | reader | — / — / 120 |
| `architect` | design | local | medium–heavy | none | reader | — / 80 / 120 |
| `general` (host native) | general | **dynamic**: local ∪ needs-derived {write, exec} | fast–heavy (floor §2.3) | from the prompt | producer | 40 / 80 / 120 |

Rules:
- **Separation rule (I4):** no grant contains (local or exec or write) together with egress. Needs `web` on a local
  role → local grant + note "use `researcher`". Needs `shell`/`network` in roles mode → never granted;
  `shell` maps to exec (`router_run`) and the note "raw shell is outside roles mode — dispatch a tier agent
  explicitly". Residual risk, documented: exec runs repo scripts that may reach the network; untrusted repo content
  is a prompt-injection vector the separation rule does not cover.
- No role is granted `subagent`, `task` or `delegate`.
- **Work root (R3).** Every role dispatch has one work root: the session directory, or a worktree of the same
  repository (listed by `git worktree list --porcelain`) named in the dispatch's ENVIRONMENT — this plan's executor
  dispatches into `D:\git\omr-rta-<id>` from a session in `D:\git\opencode-model-router`. `local`, `exec` and `write`
  apply inside the work root only. An `external_dir` need (`D:\git\opencode-model-router\src\routing\classify\rules.ts:558`)
  that resolves inside the dispatch's work root is satisfied, not refused; any other path outside it is denied (reads
  elsewhere, e.g. the host log, go to a tier agent or the executor). Role max policies allow `external_directory` only
  for the repository's worktree roots (recomputed from `git worktree list --porcelain` whenever agents are re-applied),
  never globally; the evaluate hook narrows to the dispatch's own work root. `router_run` takes `cwd`, which must equal
  the work root. Owners: P1.1 (spec, validator), P1.2 (work root in the grant), P1.3 (`cwd`), P2.1 (max policy),
  P2.3 (enforcement); spike S11 settles the host behaviour.
- Host native `explore` dispatched in roles mode is aliased to `explorer` (spike S9).
- The router tiers `fast`/`medium`/`heavy` stay registered and callable (explicit-tier dispatch keeps today's
  behaviour); the roles protocol stops advertising them.
- User customisation (global override layer only, A18) in `roleAgents.<name>`: `enabled`, `description`, `prompt`,
  `tierRange` (narrowing only, never below the authority floor), `budget`, `deny` (narrowing authority),
  `codeModeAllow` (researcher, after S8). Authority is never widened by configuration.
- #81 `agents` with a shipped role name: on v1 and in tiers mode they are validated exactly as today; in roles mode a
  same-named agent replaces the shipped role only if it passes the separation rule, otherwise it is dropped with a
  notice and the shipped role stays.
- Every role prompt carries the return contract (`DONE:` / `NEED MORE:` / `ESCALATE:` + evidence `file:line`); the
  implementer prompt adds "if `edit` is denied return `ESCALATE: authority`; never deliver a diff as text".

### 2.3 Tier floor
Floor = max(role range floor, authority floor, `escalate.floorTier`, the child's running rung on resume).
Risk and scope used here = max(classifier, route line): the route line can raise them, never lower them.

`authorityFloor(grant, detection, risk, scope)` (floor = max over every matching row):
| Grant contains | deterministic (effective) | grader | none |
|---|---|---|---|
| local / egress / exec only | fast | fast | fast |
| write without exec | fast if risk low **and** scope single, else medium | medium | medium; heavy if risk high |
| write + exec | medium | heavy | heavy |

Route-line `tier=` pins are honoured inside `[floor, ceiling]`; below the floor they are lifted (reason
`lift:authority`). Resumes never move below the running rung.

### 2.4 Contracts (contract-first commits)
```ts
// D:\git\opencode-model-router\src\router\roles.ts — P1.1 first commit
import type { Detection } from "../routing/classify/types"; // reuse, do not redeclare
export type RoleKind = "explore" | "research" | "run" | "implement" | "review" | "design" | "general";
export type AuthorityAction = "read" | "glob" | "grep" | "router_git" | "router_run" | "edit"
  | "webfetch" | "websearch" | "context7" | "execute";
export interface RoleSpec { agent: string; kind: RoleKind; description: string; prompt: string;
  authority: { mode: "fixed" | "dynamic"; allow: readonly AuthorityAction[]; deny: readonly AuthorityAction[] };
  tierRange: { floor: string; ceiling: string }; assurance: Detection; guard: "reader" | "producer";
  budget: Readonly<Record<string, number>>; enabled: boolean; codeModeAllow: readonly string[] }
export interface RolesRoutingConfig { delegation: "tiers" | "roles" }
export interface ExplorationConfig { rate: number; requireDetection: "deterministic" }
export interface RunConfig { scripts: readonly string[]; commands: Readonly<Record<string, { argv: readonly string[]; args?: readonly string[] }>>; timeoutMs: number }
export function resolveRoles(cfg: RouterConfig, host: "v1" | "v2"): ReadonlyMap<string, RoleSpec>; // empty on v1 / tiers mode
// D:\git\opencode-model-router\src\routing\classify\types.ts — P1.2 first commit (additive)
//   RouteLine gains `tier?: string` and `budget?: number`
// D:\git\opencode-model-router\src\routing\roles\policy.ts — P1.2 first commit
export interface DispatchGrant { actions: ReadonlySet<AuthorityAction>; notes: readonly string[]; workRoot: string }
export function grantFor(role: RoleSpec, facts: TaskFacts, widened: readonly AuthorityAction[],
  workRoot: string): DispatchGrant; // workRoot = session dir or a registered worktree root (§2.2)
export function authorityFloor(grant: DispatchGrant, detection: Detection, risk: Risk, scope: Scope): string;
export function tierBounds(role: RoleSpec, grant: DispatchGrant, facts: TaskFacts, detection: Detection,
  opts: { floorTier: string | null; runningTier: string | null; pinTier: string | null; tiers: readonly string[] }):
  { floor: string; ceiling: string; pinned: string | null; reasons: readonly string[] };
// D:\git\opencode-model-router\src\routing\outcomes\types.ts — P1.4 first commit (additive)
export type SignalKind = "verdict" | "run" | "grader" | "incomplete" | "budget" | "authority" | "redispatch";
//   OutcomeKey origin "role" → "class|role:<agent>|provider/model#variant"
//   DecisionRow optional extension: role, grant, detection, boundsReasons, budgetUsed, signal, explore, propensity, binding
// D:\git\opencode-model-router\src\routing\roles\binding.ts — P1.6 first commit
export function registerPending(entry: PendingDispatch): void;          // keyed by parent + callID
export function bind(childSessionID: string, getSession: SessionLookup): Promise<Binding>; // ambiguous → intersection, unknown → local
export function widen(childSessionID: string, actions: readonly AuthorityAction[]): DispatchGrant;
export function evict(sessionOrCallID: string): void;
// D:\git\opencode-model-router\src\router\guard-profile.ts — P1.5 first commit
export interface GuardProfile { kind: "reader" | "producer"; budget: number; cumulative: number }
//   buildGuardPolicy(cfg, tier, profile?) stays source-compatible
// D:\git\opencode-model-router\src\router\protocol.ts — P2.2 first commit
export function buildRolesProtocol(cfg: RouterConfig, roles: ReadonlyMap<string, RoleSpec>): string;
// D:\git\opencode-model-router\src\routing\wire\dispatch.ts — P2.1 first commit
export function annotateSubagentResult(kind: "budget" | "authority", childSessionID: string, text: string): void;
```

### 2.5 Dynamic authority and the authority ladder
- Grant = role max ∩ needs-derived actions (classifier `needs` and route-line `needs=`) ∪ grants widened on resume.
- **Binding** child ↔ dispatch is lazy, at the child's first context build or permission evaluation:
  `session.get(child)` → parentID/agent/title → pending dispatch. **Ambiguous → intersection; unknown → local only,
  plus a note telling the child to call `router_request_authority`.** Never a union. Pending entries live until the
  parent's `subagent` call completes (`execute.after`), capped at 30 min. Every unknown binding writes a row
  (`binding: unknown`) and raises the advisor finding `role-binding-unknown`.
- Enforcement: the agent registration carries the role's **max** policy (deny-by-default, fail-closed,
  sensitive-read asks) so the host bounds the child without the plugin hook; the permission `evaluate` hook narrows to
  the dispatch grant per session; the context hook removes non-granted tools from that session's catalog.
- Ladder: dynamic roles get `router_request_authority({ actions, reason })`. Inside the role max the request is
  recorded and the child is told to stop with `ESCALATE: authority`; the router annotates the parent's `subagent`
  result ("resume the same task_id to continue on tier X"); on that resume the grant widens and the floor is
  recomputed (the per-call model may rise). Outside the role max: refused, naming the role to use.

### 2.6 Signals and budgets
- Rows carry the §2.4 extension. Positive: deterministic pass / router-observed `router_run` exit 0 of the acceptance
  command after the child's last edit (1); grader pass with grader tier ≥ producer tier **and** grader model ≠
  producer model (0.5). Negative: deterministic fail (1); grader fail (0.5); `NEED MORE`/`ESCALATE` without budget
  exhaustion or authority request (0.5); re-dispatch of the same task to a higher tier within 30 min (0.5 on the
  previous attempt), similarity computed over the TASK + EXPECTED OUTCOME sections (or the text left after removing
  lines shared with ≥ 2 sibling dispatches). DONE alone: 0. Budget exhaustion and authority requests: recorded, no
  tier penalty.
- Role agents: total budget per role/tier (`budget=` raises it up to 2×), cumulative = budget × 3; `CAP:N` /
  `CAP:none` govern the read-only counter only; on exhaustion the child is told to return `NEED MORE: budget` with a
  progress summary, and the parent result carries resume guidance.

### 2.7 OpenCode v1 fallback
On v1 (`routerHost !== "v2"`): `routing.delegation: "roles"`, `roleAgents`, `routing.exploration` and `routing.run`
are validated but inert, with one notice ("roles delegation requires OpenCode v2; using tiers"). No role agent,
tool, hook or prompt change is registered. The v1 system prompt and registered agent/tool set hash-equal the base;
the only v1 changes are the mode-independent fixes of §2.9, each with a before/after golden.

### 2.8 Invariants (each has an owner and tests)
| Id | Invariant | Owner phases (tests) |
|---|---|---|
| I1 | Without `routing.delegation: "roles"`, v2 is byte-identical to the base except §2.9 | P1.1, P2.1, P2.2 (D1/D2 suites, goldens) |
| I2 | Every role dispatch on v2 gets a router-set model within `[floor, ceiling]`, never below the authority floor | P1.2 (property test), P2.1, P3.1 |
| I3 | A role child can never use an action outside its dispatch grant (host refusal on the real host) | P2.3, P3.1 |
| I4 | No shipped or accepted grant violates the separation rule | P1.1 (validator), P1.2, P3.1 |
| I5 | Binding ambiguity never widens authority | P1.6 (property test), P2.3, P3.1 |
| I6 | Positive evidence never comes from self-report | P1.4 |
| I7 | Budget exhaustion never counts as a tier failure | P1.4, P1.5 |
| I8 | v1 is byte-identical to the base except §2.9 | P1.1, P3.1 (hash + `smoke:v1`) |
| I9 | Role-agent enforcement fails closed when a hook errors or a binding is unknown | P2.3, P3.1 |

### 2.9 Mode-independent fixes (apply to v1, tiers mode and roles mode)
- E6: reader guard profile for the read-only `fast` tier (#78), for dispatches routed `class=review|recon|search`,
  for dispatches with `CAP:none` + `reason:`, and for reader roles; denied calls are not charged to the budget and are
  not recorded as executed by the repeat check.
- E8: verification never truncates a criterion; router directives (`D:\git\opencode-model-router\src\router\dispatch-header.ts`)
  are excluded from gradable criteria; a progress-note return is `incomplete`, not `fail`.
Each fix ships a before/after golden or snapshot; I1/I8 exempt exactly these.

---

## 3. Scope and non-goals
In scope: §2 for OpenCode v2, the §2.9 fixes, docs/ADR, real-host proof, owner config migration, version 2.4.0.
Non-goals: v1 role support; OS-level sandboxing; changing the host; learned routers; downward exploration without
effective deterministic detection; removing the tier agents; raw shell inside roles mode.

---

## 4. File ownership map
| Wave | Phase | Owns (writes) |
|---|---|---|
| 0 | P0.1 | `D:\git\opencode-model-router\test\smoke\role-spikes.smoke.test.ts` (new), `D:\git\opencode-model-router\test\smoke\helpers\routing-host.ts`, `D:\git\opencode-model-router\docs\qa\role-tier\spikes.md` (new) |
| 1 | P1.1 | `D:\git\opencode-model-router\src\router\roles.ts` (new), `D:\git\opencode-model-router\src\router\config.ts`, `D:\git\opencode-model-router\src\router\plugin-agents.ts`, `D:\git\opencode-model-router\tiers.json`, `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md` (new keys only), `D:\git\opencode-model-router\test\unit\docs-drift.test.ts`, `D:\git\opencode-model-router\test\unit\roles.config.test.ts` (new) |
| 1 | P1.2 | `D:\git\opencode-model-router\src\routing\roles\policy.ts` (new), `D:\git\opencode-model-router\src\routing\classify\route-line.ts`, `D:\git\opencode-model-router\src\routing\classify\types.ts` (additive), `D:\git\opencode-model-router\src\routing\engine\kernel.ts`, `D:\git\opencode-model-router\src\routing\engine\ladders.ts`, `D:\git\opencode-model-router\src\routing\engine\types.ts` (additive), `D:\git\opencode-model-router\src\routing\engine\simulate.ts`, `D:\git\opencode-model-router\src\routing\engine\index.ts`, `D:\git\opencode-model-router\test\unit\roles.policy.test.ts` (new), `D:\git\opencode-model-router\test\unit\roles.kernel.test.ts` (new), `D:\git\opencode-model-router\test\unit\route-line.roles.test.ts` (new) |
| 1 | P1.3 | `D:\git\opencode-model-router\src\router\run-tools.ts` (new), `D:\git\opencode-model-router\test\unit\run-tools.test.ts` (new) |
| 1 | P1.4 | `D:\git\opencode-model-router\src\routing\outcomes\types.ts`, `D:\git\opencode-model-router\src\routing\outcomes\signals.ts` (new), `D:\git\opencode-model-router\src\routing\outcomes\ingest.ts`, `D:\git\opencode-model-router\src\routing\outcomes\stats.ts`, `D:\git\opencode-model-router\src\routing\outcomes\persist.ts`, `D:\git\opencode-model-router\src\routing\outcomes\index.ts`, `D:\git\opencode-model-router\test\unit\routing-outcomes.signals.test.ts` (new) |
| 1 | P1.5 | `D:\git\opencode-model-router\src\router\guard-profile.ts` (new), `D:\git\opencode-model-router\src\guard\guards.ts`, `D:\git\opencode-model-router\src\guard\enforce.ts`, `D:\git\opencode-model-router\src\router\dispatch-header.ts`, `D:\git\opencode-model-router\src\verify\dod.ts`, `D:\git\opencode-model-router\src\verify\checker.ts` (S5 confirms or amends), `D:\git\opencode-model-router\test\unit\guards.roles.test.ts` (new), `D:\git\opencode-model-router\test\unit\verify.criteria.test.ts` (new) |
| 1 | P1.6 | `D:\git\opencode-model-router\src\routing\roles\binding.ts` (new), `D:\git\opencode-model-router\src\routing\roles\authority.ts` (new), `D:\git\opencode-model-router\test\unit\roles.binding.test.ts` (new), `D:\git\opencode-model-router\test\unit\roles.authority.test.ts` (new) |
| 2 | P2.1 | `D:\git\opencode-model-router\src\routing\wire\dispatch.ts`, `D:\git\opencode-model-router\src\routing\wire\runtime.ts`, `D:\git\opencode-model-router\src\compat\v2-hooks.ts`, `D:\git\opencode-model-router\src\index.ts`, `D:\git\opencode-model-router\src\v2.ts`, `D:\git\opencode-model-router\src\router\read-only.ts`, `D:\git\opencode-model-router\src\router\plugin-agents.ts`, `D:\git\opencode-model-router\test\integration\roles-dispatch.test.ts` (new) |
| 2 | P2.2 | `D:\git\opencode-model-router\src\router\protocol.ts`, `D:\git\opencode-model-router\src\router\prompts.ts`, `D:\git\opencode-model-router\src\routing\engine\protocol-line.ts`, `D:\git\opencode-model-router\src\routing\wire\hint.ts`, `D:\git\opencode-model-router\src\routing\advisor\findings.ts`, `D:\git\opencode-model-router\src\routing\advisor\index.ts`, `D:\git\opencode-model-router\src\routing\commands\stats.ts`, `D:\git\opencode-model-router\src\commands\output.ts`, `D:\git\opencode-model-router\scripts\routing-stats.ts`, `D:\git\opencode-model-router\test\integration\roles-protocol.test.ts` (new), `D:\git\opencode-model-router\test\golden\roles-protocol.golden.test.ts` (new) |
| 2 | P2.3 | after P2.1 merges: `D:\git\opencode-model-router\src\compat\v2-hooks.ts`, `D:\git\opencode-model-router\src\routing\wire\dispatch.ts`, `D:\git\opencode-model-router\src\index.ts`, `D:\git\opencode-model-router\test\integration\roles-authority.test.ts` (new) |
| 3 | P3.1 | `D:\git\opencode-model-router\test\smoke\roles.smoke.test.ts` (new), `D:\git\opencode-model-router\test\smoke\helpers\routing-host.ts`, `D:\git\opencode-model-router\docs\qa\role-tier\evidence\` (new) |
| 3 | P3.2 | `D:\git\opencode-model-router\docs\ROLES.md` (new), `D:\git\opencode-model-router\docs\adr\0006-role-tier-assurance-delegation.md` (new), `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md`, `D:\git\opencode-model-router\docs\ROUTING_ENGINE.md`, `D:\git\opencode-model-router\docs\READ_ONLY_TIERS.md`, `D:\git\opencode-model-router\README.md`, `D:\git\opencode-model-router\CHANGELOG.md`, `D:\git\opencode-model-router\docs\plans\README.md`, `D:\git\opencode-model-router\test\unit\docs-drift.test.ts` |
| 3 | P3.3 | read-only; fixes on the branch `rta/p33-fix-<n>` owned by the executor, one file owner at a time |
| 3 | P3.4 | `D:\git\opencode-model-router\package.json`, `D:\git\opencode-model-router\package-lock.json`, `D:\git\opencode-model-router\CHANGELOG.md` (release entry, after P3.2 merges), `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (with backup), the base checkout's switch back to `master` |
| all | executor | `D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-plan.md`, `D:\git\omr-rta-main\docs\plans\role-tier-assurance-delegation-handover.md`, `D:\git\omr-rta-main\docs\qa\role-tier\dogfood.md` (new in P0.1) — written only in the integration worktree and committed on `rta/main`, never in the base checkout; phases hand proposed amendments (e.g. T0.1.3) to the executor |
| 1→2 | DF-1 (executor) | the base checkout `D:\git\opencode-model-router` (local branch `rta/live`, tag `rta/df1-prev`) |
| 2→3 | DF-2 (executor) | the base checkout (`rta/live` fast-forward, tag `rta/df2-prev`), `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (with backup) |

Every phase also owns `D:\git\opencode-model-router\docs\qa\role-tier\phase-<id>.md`. The integration worktree
`D:\git\omr-rta-main` (branch `rta/main`) is the executor's; nobody else writes there.

---

## 5. Waves and phases

**Standard pre-flight** (every phase; recorded in its QA report):
1. [tier:medium] `git -C D:\git\opencode-model-router fetch origin`; worktree `D:\git\omr-rta-<id>` on `rta/<id>` from
   `origin/rta/main`; `npm ci` there.
2. [tier:medium] `npm run typecheck` green; the phase's contract dependencies present on `rta/main`.
3. [tier:fast] Owned files not owned by another active phase (§4); handoffs of earlier QA reports listed.
4. [tier:medium] Baseline: the test files the phase touches pass before any change (counts recorded).
5. [executor] `git -C D:\git\opencode-model-router status --porcelain` empty and its `HEAD` equal to the sha recorded at
   the last checkpoint (`eeab36b` before DF-1); SHA-256 of
   `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` equal to the last value recorded in
   dogfood.md (an owner edit to it, to `state.json` or to `opencode.json` is recorded as an owner change, not an
   incident).

**Standard Definition of Done** (every phase): every task committed and pushed with `Refs #84`; typecheck green; the
phase's test files and `vitest related` green; new modules ≥ 90% branch coverage; QA PASS with 0 open
blocking/critical/major and every round-1/2 finding fixed; QA report written; merged into `rta/main` by the executor;
ownership respected; the base checkout and the owner override unchanged by the phase (checkpoint and kill-switch
writes are the executor's, recorded in dogfood.md).

### Wave 0 — Host facts and baseline

#### P0.1 Spikes and baseline
Goal: settle every host behaviour the design depends on before product code.

Pre-flight (this order):
1. [executor] `git -C D:\git\opencode-model-router fetch origin`; create and push `rta/main` from
   `origin/docs/role-tier-plan` (= `master` @ `eeab36b` + this plan and its handover);
   `git -C D:\git\opencode-model-router worktree add D:\git\omr-rta-main rta/main`; `npm ci` there; open the draft PR
   `rta/main → master`. From here on the plan, the handover and dogfood.md are edited only in `D:\git\omr-rta-main`.
2. Standard steps 1–5 for `D:\git\omr-rta-p01` (step 5 records the first baseline).
3. [tier:medium] Capped full suite in `D:\git\omr-rta-main` (record counts).
4. [tier:fast] Record the owner's `enforcementMode` from
   `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` (read-only); apply §0.2.6.
5. [executor] Baseline section of `D:\git\omr-rta-main\docs\qa\role-tier\dogfood.md`: the §0.7 liveness commands run
   once against the live host on `master` code with their outputs (the `/router` marker format is read from
   `D:\git\opencode-model-router\src\router\build-info.ts`, no human round trip); the override's SHA-256 and the base
   checkout HEAD; the three DF-1 self-test probes run once on `master` code with their guard footers recorded. If a
   §0.7 command does not work on 2.0.24, amend §0.7 (R<n>) with the verified equivalent.

Tasks:
- T0.1.1 [tier:medium] Extend `D:\git\opencode-model-router\test\smoke\helpers\routing-host.ts` (agents registered
  without a model; OpenAI-Responses scripted provider reuse) and write
  `D:\git\opencode-model-router\test\smoke\role-spikes.smoke.test.ts` (gated `RUN_OC_SMOKE_ROLE_SPIKES=1`) for:
  - S1 an agent registered **without** a model, dispatched with per-call `model: provider/model#variant`: model and
    effort that reach the provider (Anthropic and OpenAI-Responses providers);
  - S2 at a child's first context build and first permission evaluation, does `session.get(child)` return
    parentID/agent/title; ordering versus `session.created`;
  - S3 the permission `evaluate` hook keyed by **sessionID** narrows one child only, and the context hook can remove
    tools from that session's catalog only;
  - S4 how the host surfaces a child hitting its step limit and a plugin-guard denial (finish reason, error, text);
  - S6 `execute.after` on the parent's `subagent` call can append text the parent model sees;
  - S7 resuming a child with a different per-call model and variant;
  - S8 Code Mode: are inner `tools.*` calls inside `execute` evaluated by the permission `evaluate` hook, and can the
    per-session context hook restrict the Code Mode catalog to an allowlist;
  - S9 rewriting `agent: "explore"` → `"explorer"` in `subagent` args in `execute.before`;
  - S10 does the router's verification gate run the acceptance checks for a role child (feeds effective detection);
  - S11 a deny-by-default role-style agent dispatched from a session located in `D:\git\opencode-model-router` reads,
    edits and calls a `router_run`-style tool inside a sibling worktree of the same repository: is
    `external_directory` asked or denied, can a max policy allow it for listed worktree roots only, and in which
    directory does the tool execute (feeds §2.2 work root);
  - S12 change the global override's `agents` block without restarting the host: do `/api/agent` and the
    orchestrator's agent list change, and when (feeds §0.7 and DF-2 step 3).
- T0.1.2 [tier:fast] S5: locate where verification criteria are assembled and cut (start at
  `D:\git\opencode-model-router\src\verify\dod.ts:62` and `D:\git\opencode-model-router\src\verify\checker.ts`); list
  file:line; confirm or amend P1.5's ownership.
- T0.1.3 [tier:medium] Run the spikes once (serial); write `D:\git\opencode-model-router\docs\qa\role-tier\spikes.md`
  with each result and its design consequence (confirm §2, or propose an amendment that the executor writes into §9 in
  `D:\git\omr-rta-main`).
- T0.1.4 [tier:heavy] [route class=review risk=high pin] Senior QA of the spikes.

Tests: the spike file asserts the observed host behaviour so a host upgrade that changes it fails loudly; it stays as a
regression smoke. Edge cases: two parallel children of the same agent and title (S2); a hook that throws (S3); a
child resumed twice (S7); `execute` with a tool outside the allowlist (S8).
Acceptance: S1–S12 each answered with host-state evidence; every §2 mechanism confirmed or replaced by an amendment
that keeps I1–I9.
DoD: standard; spikes report committed.
QA: `[tier:heavy]` adversarial — scripted-provider artefacts, event-ordering assumptions, conclusions stronger than
the evidence.

### Wave 1 — Core modules (P1.1–P1.6 in parallel; contract commits of P1.1, P1.2, P1.4, P1.5, P1.6 merged first)

#### P1.1 Role model and configuration
Goal: roles and every new key as validated, layered configuration; inert on v1 and in tiers mode.

Pre-flight: standard; spikes report read; [tier:fast] check `D:\git\opencode-model-router\src\routing\commands\v1-roles.ts`
(existing "roles" wording on v1) so the new notice does not collide.

Tasks:
- T1.1.1 [tier:medium] First commit: the P1.1 contracts of §2.4 in `D:\git\opencode-model-router\src\router\roles.ts`
  (`resolveRoles` returns an empty map until T1.1.3).
- T1.1.2 [tier:medium] Keys in `D:\git\opencode-model-router\src\router\config.ts` (validators, defaults, layers):
  `routing.delegation` (`"tiers"` default; global and project layers), `roleAgents` (tiers.json + global only),
  `routing.exploration` (`rate` default 0, max 0.2; global only), `routing.run` (`scripts` default
  `["test","typecheck","lint","build"]` plus `test:*`, `commands`, `timeoutMs` default 600000; global only).
- T1.1.3 [tier:heavy] Shipped role specs in `D:\git\opencode-model-router\tiers.json` `roleAgents` per §2.2 (authority,
  ranges, budgets, assurance, guard, prompts with the return contract); the separation validator over every grant
  (shipped, user-narrowed, and #81 agents with a shipped name in roles mode only); the work-root rule of §2.2 in the
  role specs.
- T1.1.4 [tier:medium] Narrowing-only customisation; per-entry drop with a notice; never drop the layer or `routing`.
- T1.1.5 [tier:medium] v1: validate, one notice, inert (§2.7).
- T1.1.6 [tier:medium] `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md` rows for the new keys (so
  `D:\git\opencode-model-router\test\unit\docs-drift.test.ts` stays green) and the drift test entries.
- T1.1.7 [tier:medium] Tests in `D:\git\opencode-model-router\test\unit\roles.config.test.ts`.

Tests (edge cases): default tiers → empty roles and unchanged config; roles on v1 → empty + one notice; a narrowing
that widens (rejected); `tierRange` below the floor (clamped + notice); separation violation in a user `agents.researcher`
with `read` in roles mode (dropped, shipped role kept) and in tiers mode (validated as today); unknown keys; invalid tier
names; project-layer `roleAgents`/`exploration`/`run` stripped; `enabled: false`; budget out of range; exploration rate
> 0.2; hot reload switching delegation; goldens unchanged.
Acceptance: shipped roles validate; invalid input drops only its entry; v1 inert; I1/I8 hold for config.
DoD: standard. QA: `[tier:heavy]` — can configuration widen authority, violate separation, or drop `routing`?

#### P1.2 Policy core, route-line keys and engine support
Goal: total, pure policy functions; `tier=`/`budget=` route keys; kernel candidates for role dispatches; exploration.

Pre-flight: standard; P1.1 and P1.4 contract commits merged.

Tasks:
- T1.2.0 [tier:medium] First commit: route-line keys `tier=fast|medium|heavy` and `budget=<int>` in
  `D:\git\opencode-model-router\src\routing\classify\route-line.ts` (identity key at line 160 extended; first-line
  rule A22 applies), `RouteLine` fields in `D:\git\opencode-model-router\src\routing\classify\types.ts`, plus the
  policy signatures in `D:\git\opencode-model-router\src\routing\roles\policy.ts`.
- T1.2.1 [tier:heavy] `grantFor`: fixed/dynamic, work root from the dispatch ENVIRONMENT (§2.2), needs mapping
  (`shell`/`network` → exec + note, `external_dir` inside the work root → satisfied, elsewhere → note,
  `web` on local roles → note), route-line `needs=`, widened grants, separation resolution; `authorityFloor` per §2.3
  including the write + exec row and max-over-rows.
- T1.2.2 [tier:medium] `tierBounds`: range ∩ authority floor ∩ `escalate.floorTier` ∩ running rung; risk/scope =
  max(classifier, route line); pin clamping with `lift:authority` / `lift:floor`.
- T1.2.3 [tier:heavy] Kernel: candidates for a role dispatch = rungs of the tiers in `[floor, ceiling]` for the role
  agent, keyed `class|role:<agent>|provider/model#variant`; static default = the class's taxonomy tier, clamped; A27
  and A34 unchanged for tier mode; `D:\git\opencode-model-router\src\routing\engine\simulate.ts` equal to the runner.
- T1.2.4 [tier:medium] Exploration: only in `enforce`, rate from config (default 0), never on pinned, resume,
  high-risk or non-effective-deterministic dispatches, only to a rung ≥ floor and < the static default; a documented
  exception to never-down with reason `explore`; deterministic RNG seeded by decisionID; rows carry `explore` and
  `propensity`.
- T1.2.5 [tier:medium] Tests in `D:\git\opencode-model-router\test\unit\roles.policy.test.ts`,
  `D:\git\opencode-model-router\test\unit\roles.kernel.test.ts`, `D:\git\opencode-model-router\test\unit\route-line.roles.test.ts`.

Tests (edge cases): the full §2.3 matrix (grant rows × detections × risk × scope); `needs=web,edit`; `needs=shell`;
`needs=external_dir`; empty and unknown needs; route line lowering risk (ignored) and raising it (applied); pin above
ceiling / below floor; resume at heavy with a fast default; `floorTier` above the role ceiling (floor wins, range
widened upward only, documented); exploration off at rate 0 and never on pinned/resume/high-risk/`d=none`; property
tests: no generated (role, facts) yields a tier below `authorityFloor` or a grant outside the role max; simulate ==
runner on role ladders; tier-mode kernel tests untouched and green.
Acceptance: I2 and I4 hold for every generated input; tier-mode decisions unchanged.
DoD: standard. QA: `[tier:heavy]` — any input below the floor, any grant beyond the max, any route-line downgrade.

#### P1.3 Structured run tool (`router_run`)
Goal: routine commands without a caller-controlled shell, fixed argv, safe on Windows and POSIX.

Pre-flight: standard; [tier:fast] read `D:\git\opencode-model-router\src\router\git-tools.ts` (process runner,
kill tree, redaction, executable resolution) for reuse.

Tasks:
- T1.3.1 [tier:heavy] `D:\git\opencode-model-router\src\router\run-tools.ts`: `router_run({ script, args?, cwd })` (`cwd` must equal the
  dispatch's work root, §2.2; default: the session directory) for a
  name in `routing.run.scripts` (package.json scripts) or `routing.run.commands`; `router_run` never spawns a shell
  itself (`shell: false`, argv asserted); npm runs as `node <npm-cli.js>` resolved from the Node install (no `.cmd`
  shims), with `--script-shell=<absolute system shell>` and `--node-options=` on the command line so a repo `.npmrc`
  cannot redirect them; executables never resolved from inside the repo (#77 G4); caller args accepted only when the
  entry declares them and each matches `^[A-Za-z0-9_./:=@+-]{1,200}$` (allowlist, not denylist); hardened env
  (no inherited `npm_config_*`, `CI=1`); timeout from config; output bound 64 KiB with notice; credential redaction
  before truncation; process-tree kill and settle (#77 G7); exit code returned to the caller and to the outcome store
  (P1.4 `run` signal via an injected recorder).
- T1.3.2 [tier:medium] Document that npm script bodies are trusted repo content run by npm's script shell; the
  floor table (§2.3) raises write + exec to medium/heavy because edits can change what a script does.
- T1.3.3 [tier:medium] Tests in `D:\git\opencode-model-router\test\unit\run-tools.test.ts`.

Tests (edge cases): a script outside the allowlist; missing `package.json`; args with `;`, `|`, `&`, newline, backtick,
`$(`, `%PATH%`, `^`, `!`, `"`, `<`, `>`, `--output`; args on an entry that declares none; a planted
`node_modules\.bin\npm.cmd`; a repo `.npmrc` with `script-shell=.\evil.cmd` and with `node-options=--require .\evil.js`
(neither honoured, marker file never created); timeout with a hanging grandchild; output > 64 KiB; secret at the cut
point; Windows path with spaces; POSIX path; exit code propagation; `cwd` outside every registered work root (refused);
`cwd` = a sibling worktree (runs there, proven by a marker file).
Acceptance: no caller-controlled shell; every injection, hijack and `.npmrc` case refused or neutralised; green on
Windows and Linux CI.
DoD: standard. QA: `[tier:heavy]` — execution outside the named entry, executable or shell hijack, env injection,
timeout bypass.

#### P1.4 Outcome signals and role statistics
Goal: RH2/RH7 in the outcome store; role × tier statistics computed.

Pre-flight: standard.

Tasks:
- T1.4.1 [tier:medium] First commit: the P1.4 contracts of §2.4 (origin `role`, `SignalKind`, the complete optional
  `DecisionRow` extension) in `D:\git\opencode-model-router\src\routing\outcomes\types.ts`; persistence keeps parsing
  old rows and ignores unknown fields.
- T1.4.2 [tier:heavy] `D:\git\opencode-model-router\src\routing\outcomes\signals.ts`: weights per §2.6; return-prefix
  detection from the child's final text; budget and authority exclusion; re-dispatch detection over TASK + EXPECTED
  OUTCOME (or sibling-deduplicated text), 30 min, higher tier; grader acceptance only with tier ≥ producer and a
  different model; `run` signal from `router_run` after the last edit.
- T1.4.3 [tier:medium] Store wiring in `D:\git\opencode-model-router\src\routing\outcomes\ingest.ts` and the barrel
  `D:\git\opencode-model-router\src\routing\outcomes\index.ts` (store API only; hook call sites are a P2.1 handoff).
- T1.4.4 [tier:medium] Stats computation in `D:\git\opencode-model-router\src\routing\outcomes\stats.ts`: by role and
  tier — dispatches, outcomes by signal kind, budget exhaustions, authority requests, unknown bindings, exploration,
  tokens per dispatch, cost units (rendering is P2.2).
- T1.4.5 [tier:medium] Tests in `D:\git\opencode-model-router\test\unit\routing-outcomes.signals.test.ts`.

Tests (edge cases): DONE alone → no positive mass; NEED MORE after budget exhaustion → `budget`; authority request →
no fail; re-dispatch of a different task sharing the 7-section boilerplate (no signal); re-dispatch to a lower tier (no
signal); grader on the producer's model (ignored); `router_run` exit 0 before the last edit (ignored); duplicated rows
(C7 dedupe); old rows; decay unchanged; tier-mode stats output unchanged for logs without role rows.
Acceptance: I6 and I7 hold; tier-mode statistics unchanged.
DoD: standard. QA: `[tier:heavy]` — can self-report, budget events or boilerplate similarity move evidence?

#### P1.5 Guard profiles, budgets and verification text (mode-independent §2.9 + role budgets)
Goal: E6, E7, E8 fixed at the root for every mode; role budgets available.

Pre-flight: standard; spikes S4, S5, S10 read.

Tasks:
- T1.5.0 [tier:medium] First commit: `D:\git\opencode-model-router\src\router\guard-profile.ts` contracts;
  `buildGuardPolicy(cfg, tier, profile?)` in `D:\git\opencode-model-router\src\guard\enforce.ts` source-compatible.
- T1.5.1 [tier:heavy] Reader profile in `D:\git\opencode-model-router\src\guard\guards.ts`: no consecutive-non-producing
  denial for the read-only `fast` tier, for `class=review|recon|search` dispatches, for `CAP:none` + `reason:`
  dispatches and for reader roles; denied calls are not charged and not recorded as executed by the repeat check;
  producer profile unchanged otherwise.
- T1.5.2 [tier:medium] Role budgets: total = role/tier budget (`budget=` up to 2×), cumulative = ×3; tier agents keep
  25/×3; exhaustion message instructs `NEED MORE: budget` with a progress summary; `budgetExhausted(sessionID)` exposed.
- T1.5.3 [tier:heavy] Verification text (files confirmed by S5): never cut a criterion mid-text; drop whole criteria
  over the budget with "n criteria omitted" (not graded); exclude `D:\git\opencode-model-router\src\router\dispatch-header.ts`
  directives from gradable criteria; classify a progress-note return as `incomplete`.
- T1.5.4 [tier:medium] Before/after goldens for the §2.9 behaviour change; tests in
  `D:\git\opencode-model-router\test\unit\guards.roles.test.ts` and `D:\git\opencode-model-router\test\unit\verify.criteria.test.ts`
  (including an E8 reproduction with the truncated criterion → no FAIL, and an E6 reproduction).

Tests (edge cases): reader with 40 reads → no denial; producer keeps the draft guard; denied call not charged; repeat
check after a denial; tier agents' budget unchanged; budget exactly at the limit; `budget=` above 2× clamped;
criteria list over the budget; one criterion longer than the budget (omitted, not cut); multi-byte text at the
boundary; existing guard and verify suites green (changes limited to §2.9 goldens).
Acceptance: E6/E7/E8 reproductions pass at unit level (end to end in P2.1/P3.1); everything else unchanged.
DoD: standard. QA: `[tier:heavy]` — can a role escape its budget; does any non-§2.9 behaviour change?

#### P1.6 Binding and authority modules
Goal: pure modules for lazy binding and the authority ladder.

Pre-flight: standard; P1.1 and P1.2 contract commits merged; spikes S2, S3, S6, S7 read.

Tasks:
- T1.6.0 [tier:medium] First commit: the binding contracts of §2.4.
- T1.6.1 [tier:heavy] `D:\git\opencode-model-router\src\routing\roles\binding.ts`: process-wide pending registry
  (parent, callID, agent, description, grant, budget, decisionID; lives until the parent call completes, cap 30 min,
  bounded size); lazy `bind` with an injected session lookup; ambiguity → intersection; unknown → local + note;
  re-binding on resume; eviction on `session.deleted` and call completion.
- T1.6.2 [tier:heavy] `D:\git\opencode-model-router\src\routing\roles\authority.ts`: `router_request_authority` tool
  definition and state (requests inside the role max recorded per child and consumed on resume; outside → refusal text
  naming the right role); `widen` for the resume path.
- T1.6.3 [tier:medium] Tests in `D:\git\opencode-model-router\test\unit\roles.binding.test.ts` and
  `D:\git\opencode-model-router\test\unit\roles.authority.test.ts`.

Tests (edge cases): two identical parallel dispatches (intersection); binding after the parent call completed
(local); parent deleted; the same child resumed twice; widening outside the max; request replay; request from a fixed
role (refused); two plugin instances (process-wide registry, one decision); property test over random interleavings:
the bound grant ⊆ every candidate grant.
Acceptance: I5 holds under all generated interleavings.
DoD: standard. QA: `[tier:heavy]` — any path to a union, to authority beyond the max, or to a stale binding.

[tier:medium] **Wave 1 integration** (§0.8).

#### Checkpoint DF-1 — the §2.9 fixes live (self-test)
Pre-flight: Wave 1 CI green; capped full suite green on `rta/main` (the wave-integration run counts if nothing outside
`docs\` changed since); base checkout clean on `master` @ `eeab36b`.
Steps:
1. [executor] Sync per §0.7 (tag `rta/df1-prev` at the base HEAD; `switch --no-track -C rta/live origin/rta/main`;
   `npm ci` only if the lockfile changed, finished before the restart request). Roles stay inert
   (`delegation: "tiers"`).
2. **Restart stop** (§0.1, handover §7): handover §2 → "next: DF-1 liveness probe, then step 3"; ask the human to
   restart OpenCode v2 and paste the `/router` line; stop. On resume: the §0.7 liveness probe and its outcomes
   (previous sha → ask again; `unknown`, load failure or missing agents → rollback and a critical finding for the
   owning Wave-1 phase).
3. [tier:medium] Self-test probes, recorded in `D:\git\omr-rta-main\docs\qa\role-tier\dogfood.md` against the P0.1
   baseline. Under `advisory` the old guard warns instead of denying, so each probe asserts no `DENIED` **and** no
   `[⚠ GUARD:read_budget]` footer: a read-only `fast` dispatch with 10 consecutive reads; a
   `[route class=review risk=high pin]` heavy dispatch with `CAP:none` + `reason:` making 20 reads (below the
   unchanged 25-call tier budget); a delegation with a long acceptance block whose verdict criteria are whole (no
   mid-sentence cut). Evidence: the delegates' tool results and a read-only copy of the live decision log.
4. [tier:medium] Comment on #84 (DF-1 done, evidence link).
Acceptance: liveness probe and self-test probes pass; no plugin load error; local rollback tag `rta/df1-prev` exists. If a probe fails, the owning Wave-1 phase
gets a finding, fixed on its branch, re-merged and re-synced before Wave 2 starts.
Rollback: §0.7.

### Wave 2 — v2 runtime (P2.1 ∥ P2.2, then P2.3)

#### P2.1 Role dispatch runtime
Goal: role agents registered and every role dispatch routed on v2 (model per call, bounds, budgets, rows, seams).

Pre-flight: standard; Wave 1 merged; handoffs from P1.4/P1.5/P1.6 listed.

Tasks:
- T2.1.0 [tier:medium] First commit: `annotateSubagentResult(kind, childSessionID, text)` seam contract.
- T2.1.1 [tier:heavy] Role agent registration in `D:\git\opencode-model-router\src\compat\v2-hooks.ts` (agent
  transform) using `D:\git\opencode-model-router\src\router\read-only.ts` and
  `D:\git\opencode-model-router\src\router\plugin-agents.ts`: the floor tier's model as registered fallback (S1), role
  prompt verbatim, steps from the top budget, the role's **max** policy deny-by-default and fail-closed (`external_directory` allowed only
  for the repository's worktree roots, §2.2), `explore`
  alias (S9), nothing on v1 or in tiers mode.
- T2.1.2 [tier:heavy] Role path in `D:\git\opencode-model-router\src\routing\wire\dispatch.ts`: classify → `grantFor` →
  effective detection (S10) → `tierBounds` → kernel (static default; `enforce` applies the decision; exploration) →
  always set `args.model`; pins and resumes per §2.3; rows with the §2.4 extension; `registerPending` (P1.6).
- T2.1.3 [tier:medium] `D:\git\opencode-model-router\src\index.ts`: register `router_run` (P1.3) for roles that grant
  it and `router_request_authority` (P1.6) for dynamic roles; guard profiles and role budgets (P1.5); signal ingestion
  call sites (P1.4) including the parent result's final text; the protocol switch at the "Inject delegation protocol"
  site (≈ line 2396) to `buildRolesProtocol` (P2.2 contract) on v2 roles mode.
- T2.1.4 [tier:medium] Budget exhaustion → `annotateSubagentResult("budget", …)` with resume guidance (S6).
- T2.1.5 [tier:medium] Tests in `D:\git\opencode-model-router\test\integration\roles-dispatch.test.ts`.

Tests (edge cases): tiers mode untouched (D1/D2 suites green, unmodified); every role × class default; pins; resume at a
higher running rung; explicit `model` in the call (kept inside bounds, lifted to the floor); unknown agent; disabled role;
`engine: static` in roles mode (static defaults applied, no rows written, documented); two plugin instances; a catalog
without the tier variant (variant dropped, tier model used); runner single-writer mark (#81) unaffected; E6/E7 end to
end through the hook shapes.
Acceptance: I1, I2 hold; rows carry the new fields; tier dispatches unchanged.
DoD: standard. QA: `[tier:heavy]` — routing below the floor, model override failures, A30/A34 interaction, runner mark.

#### P2.2 Orchestrator surface
Goal: the orchestrator sees roles on v2 roles mode; stats and advisor speak roles.

Pre-flight: standard; Wave 1 merged.

Tasks:
- T2.2.0 [tier:medium] First commit: `buildRolesProtocol` contract in `D:\git\opencode-model-router\src\router\protocol.ts`.
- T2.2.1 [tier:heavy] Roles protocol (`D:\git\opencode-model-router\src\router\protocol.ts`,
  `D:\git\opencode-model-router\src\router\prompts.ts`): role menu with intent; route-line keys (`class`, `risk`,
  `scope`, `needs`, `d`, `tier`, `budget`, `pin`); "the router chooses the model; never set `model`"; composition
  (research → implement); resume and authority-ladder instructions; cache-stable text (no per-turn content).
  `R:` line as class → role in `D:\git\opencode-model-router\src\routing\engine\protocol-line.ts`; no per-turn hint in
  roles mode (`D:\git\opencode-model-router\src\routing\wire\hint.ts`).
- T2.2.2 [tier:medium] Advisor findings (`D:\git\opencode-model-router\src\routing\advisor\findings.ts`,
  `D:\git\opencode-model-router\src\routing\advisor\index.ts`): `role-separation`, `roles-on-v1` (info),
  `role-budget-low`, `role-range-clamped`, `role-binding-unknown`, `native-explore-aliased` (info), role usage share.
- T2.2.3 [tier:medium] Rendering: `/router` role lines and `/router stats` by role
  (`D:\git\opencode-model-router\src\routing\commands\stats.ts`, `D:\git\opencode-model-router\src\commands\output.ts`,
  `D:\git\opencode-model-router\scripts\routing-stats.ts`).
- T2.2.4 [tier:medium] Tests in `D:\git\opencode-model-router\test\integration\roles-protocol.test.ts` and
  `D:\git\opencode-model-router\test\golden\roles-protocol.golden.test.ts`.

Tests (edge cases): tiers-mode protocol byte-identical (existing goldens untouched); roles protocol golden; disabled
role absent from the menu; v1 never shows roles; each advisor finding fires and clears; stats with mixed tier and role
rows; `/router stats` equals the script for role rows.
Acceptance: I1 holds; roles protocol golden reviewed; no hint part in roles mode.
DoD: standard. QA: `[tier:heavy]` — protocol text that leads the orchestrator to set models or pick tiers; prefix
stability.

#### P2.3 Authority enforcement end to end
Goal: dynamic authority, per-session narrowing and the ladder live on v2.

Pre-flight: standard; P2.1 merged into `rta/main` (P1.6 already merged); ownership of the three hot files transferred.

Tasks:
- T2.3.1 [tier:heavy] Permission `evaluate` hook keyed by session in `D:\git\opencode-model-router\src\compat\v2-hooks.ts`:
  lazy `bind`; allow iff the action is in the dispatch grant and, for paths, inside its work root (sensitive-read
  asks kept, `router_run` allowlist and `cwd`), deny
  otherwise; never widens the agent's max policy; errors fail closed for role agents and leave others unchanged.
- T2.3.2 [tier:heavy] Context hook: per-session catalog filtering to the grant (including the Code Mode catalog per
  S8); `router_request_authority` advertised only for dynamic roles.
- T2.3.3 [tier:medium] Ladder: `annotateSubagentResult("authority", …)` on requests; the resume path
  (`args.sessionID`) in `D:\git\opencode-model-router\src\routing\wire\dispatch.ts` widens via P1.6 and recomputes bounds
  (the model may rise); rows record the widening; unknown bindings recorded.
- T2.3.4 [tier:medium] Tests in `D:\git\opencode-model-router\test\integration\roles-authority.test.ts`.

Tests (edge cases): `general` with `needs=[]` → local only, edit denied, request → resume → edit granted, tier ≥ floor;
`needs=web,edit` → local grant + note; `needs=shell` → exec + note; parallel identical dispatches → intersection;
inherited parent-session `shell`/`*` allow cannot re-open anything (#77 P2 lesson); hook throws → deny for role
agents, unchanged for others (I9); sibling sessions unaffected by another session's catalog filter; Code Mode inner
call outside the allowlist denied (if S8 enabled `execute`); a path in the dispatch's own worktree work root allowed,
a path in another worktree or outside the repository denied; `router_run` with a foreign `cwd` denied.
Acceptance: I3, I4, I5, I9 hold against the spike hook shapes.
DoD: standard. QA: `[tier:heavy]` — privilege escalation, session confusion, fail-open on errors.

[tier:medium] **Wave 2 integration** (§0.8).

#### Checkpoint DF-2 — roles mode live; Wave 3 runs through the role agents (self-test)
Pre-flight: Wave 2 CI green; capped full suite green on `rta/main` (the wave-integration run counts if nothing outside
`docs\` changed since); DF-1 record complete.
Steps:
1. [executor] Sync per §0.7 (tag `rta/df2-prev`; fast-forward `rta/live` to `origin/rta/main`; `npm ci` only if the
   lockfile changed, finished first). **Restart stop** (§0.1, handover §7): handover §2 → "next: DF-2 liveness probe,
   then step 2"; ask for the restart and the `/router` line; stop. On resume: the §0.7 liveness probe and its outcomes.
2. [executor] Owner migration — only after the liveness probe passed (code that predates Wave 1 rejects the new keys
   and drops the whole override layer, #80; the DF-1 code validates `routing.delegation` but has no role runtime) —
   validated first in a temp HOME with the synced code, then written with a backup (this backup is the kill switch;
   record the new SHA-256):
   add `"delegation": "roles"` to the existing `routing` block (keep `engine`, `profile`, `margin`); remove
   `subagentTiers.explore` (aliased to `explorer`); remove the custom `agents` `runner`, `reviewer`, `researcher`
   (replaced by shipped roles); exploration stays 0.
3. [tier:medium] At the next orchestrator prompt verify through
   `opencode api get '/api/agent?location%5Bdirectory%5D=D%3A%5Cgit%5Copencode-model-router'` that the role agents exist
   with their max policies, and that the executor's system prompt now carries the roles protocol. If S12 showed that
   agent registrations need a restart, step 2 ends with a second restart stop (handover §7 "DF-2b") and this step
   runs after it.
4. [tier:medium] Self-test probes on a phase-worktree work root, each recorded with its decision row: `explorer`
   lookup (fast model, local grant); `runner` running a scoped test through `router_run` with `cwd` = the worktree;
   `implementer` small edit on a throwaway file with deterministic acceptance (floor per §2.3), reverted afterwards;
   `implementer` with `[route class=implement risk=high tier=heavy pin]` (heavy model); `general` with no needs denied
   `edit`, then `router_request_authority` → resume → edit granted; `reviewer` QA dispatch on heavy making 40 calls
   without a budget cut (role budget, E7); `researcher` web lookup without local reads; a negative probe reading a
   path outside every registered work root (denied).
5. [tier:medium] From here on, **all Wave 3 dispatches use role agents** (§0.10); tier agents only as a recorded
   fallback when a role defect blocks work.
6. [tier:medium] Comment on #84 (DF-2 done, evidence link).
Acceptance: probes pass; I2–I5 observed on the live host for the executor's own dispatches; kill switch tested in a
temp HOME (the pre-DF-2 backup yields tiers mode, the custom agents and explore → fast).
Rollback: §0.7 — first the kill switch (pre-DF-2 override backup, hot reload), then the code tag and a restart.

### Wave 3 — Proof, documentation, global QA, enablement

#### P3.1 Real-host proof (v2.0.24) and v1 fallback proof
Goal: every invariant observed on the real host.

Pre-flight: standard; Wave 2 merged; [tier:fast] live host version recorded from
`C:\Users\Marquinho\.local\share\opencode\log\opencode.log`.

Tasks:
- T3.1.1 [tier:medium] `D:\git\opencode-model-router\test\smoke\roles.smoke.test.ts` (gated `RUN_OC_SMOKE_ROLES=1`,
  isolated host, scripted providers): I2 (models per class, pin, resume), I3 (host refusal and catalog absence), I4
  (shipped grants), I5 (parallel identical dispatches), I9 (hook error), ladder end to end, `router_run` on the real
  host, budget exhaustion and resume, signal rows of each kind, zero unknown bindings in normal dispatches,
  exploration row when enabled.
- T3.1.2 [tier:medium] v1 fallback: `npm run smoke:v1` (with its preflight) green; unit proof that roles config on v1
  registers nothing and the v1 system prompt/agent/tool set hash-equal the base except §2.9 goldens.
- T3.1.3 [tier:medium] Evidence under `D:\git\opencode-model-router\docs\qa\role-tier\evidence\` (redacted, regenerated
  only behind an env flag).

Tests (edge cases): the smoke covers each invariant with a negative case (the forbidden action actually attempted by
the scripted provider); assertions on host state only.
Acceptance: all scenarios green on 2.0.24; v1 smoke green; evidence committed.
DoD: standard. QA: `[tier:heavy]` — vacuous assertions, isolation from the live store, evidence matching claims.

#### P3.2 Documentation, ADR, changelog
Goal: users can understand, enable, tune and roll back roles mode.

Pre-flight: standard; Wave 2 merged; ownership of `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md` and
`D:\git\opencode-model-router\test\unit\docs-drift.test.ts` returns to P3.2.

Tasks:
- T3.2.1 [tier:medium] `D:\git\opencode-model-router\docs\ROLES.md`: axes, roles table, action classes, floor table,
  separation rule and its residual risks, dynamic authority and ladder, budgets, signals, exploration, v1 fallback,
  migration from `subagentTiers`/#81 agents, limits (not an OS sandbox; npm script bodies are trusted repo content).
- T3.2.2 [tier:medium] `D:\git\opencode-model-router\docs\adr\0006-role-tier-assurance-delegation.md`: context
  (E1–E13), decisions, alternatives, consequences, literature §1.2 with the §1.3 qualifiers.
- T3.2.3 [tier:medium] `D:\git\opencode-model-router\docs\CONFIG_REFERENCE.md`, `D:\git\opencode-model-router\docs\ROUTING_ENGINE.md`,
  `D:\git\opencode-model-router\docs\READ_ONLY_TIERS.md`, `D:\git\opencode-model-router\README.md`,
  `D:\git\opencode-model-router\CHANGELOG.md` `[Unreleased]` (including §2.9 as a behaviour change),
  `D:\git\opencode-model-router\docs\plans\README.md`.
- T3.2.4 [tier:medium] `D:\git\opencode-model-router\test\unit\docs-drift.test.ts`: pin every new key, the roles table
  and the floor table against `authorityFloor`.

Tests (edge cases): docs-drift fails if a key, a role row or a floor cell diverges from code (negative fixtures); link
check over the new files.
Acceptance: docs-drift green; every key documented with its default; the floor table equals the code.
DoD: standard. QA: `[tier:heavy]` — docs vs code divergence is major.

#### P3.3 Global senior QA
Goal: zero open blocking/critical/major across the whole change.

Pre-flight: Waves 1–3 (P3.1, P3.2) merged; capped suite and CI green on `rta/main`.

Tasks:
- T3.3.1 [tier:heavy] [route class=review risk=high pin] Area A — security: authority, binding, separation, hooks,
  `router_run`, guards, fail-closed behaviour, prompt-injection paths (L12/L13 threat model, orchestrator-routed flows).
- T3.3.2 [tier:heavy] [route class=review risk=high pin] Area B — economy and engine: floors, kernel, exploration,
  signals, stats, I1/I2/I6/I7, simulate parity.
- T3.3.3 [tier:heavy] [route class=review risk=high pin] Area C — docs, v1 fallback, test quality, CI, evidence
  reproducibility, release readiness.
- T3.3.4 [tier:medium] Fixes per §0.6 on `rta/p33-fix-<n>` branches, one file owner at a time; re-review rounds per §0.6.

Tests: every fix adds a regression test that fails before the fix (mutation check recorded in the QA report).
Acceptance: every global criterion (§6) checked with evidence in `D:\git\opencode-model-router\docs\qa\role-tier\global.md`.
DoD: standard; global QA PASS.
QA: this phase is the QA; its fixes are re-reviewed by the area's reviewer (`[tier:heavy]`).

#### P3.4 Integration, owner enablement, release
Goal: on `master`, live for the owner, released.

Pre-flight: P3.3 PASS; CI green on the draft PR head; capped suite green; [tier:fast] live host log shows no plugin
load error.

Tasks:
- T3.4.1 [tier:medium] Version 2.4.0 in `D:\git\opencode-model-router\package.json` and
  `D:\git\opencode-model-router\package-lock.json`; `D:\git\opencode-model-router\CHANGELOG.md` release entry; PR
  `rta/main → master` ready; CI green on the exact head; merge; CI green on the merge SHA.
- T3.4.2 [executor] Before the sync, validate the owner override (migrated at DF-2) against the final code in a temp
  HOME. If a P3.x change needs an adjustment, prepare and validate it there, but write it (with a backup) only after
  the T3.4.3 liveness probe shows the final code. Exploration stays 0 (recommend 0.05 in the summary, the owner
  decides).
- T3.4.3 [executor] Move the base checkout back to `master`: `git -C D:\git\opencode-model-router switch master`,
  `merge --ff-only origin/master` (now containing the release), per the §0.7 sync protocol (tag `rta/sync-prev`).
  This is a code sync → **restart stop**, combined with the T3.4.4 publish question in one message to the human
  (handover §7). On resume: the §0.7 liveness probe (`<sha7>` of the merge commit) and its outcomes; verify through
  `opencode api get '/api/agent?location%5Bdirectory%5D=D%3A%5Cgit%5Copencode-model-router'` that role agents exist with
  their max policies; write a T3.4.2 adjustment if one was prepared; re-run the DF-2 step-4 probe set on the final
  code; act on the publish answer only if all pass — otherwise roll back (§0.7), do not publish, and ask again;
  delete the local `rta/live` branch only after the probes pass.
- T3.4.4 [tier:medium] **Human gate:** ask for confirmation, then push tag `v2.4.0` (publish workflow with provenance);
  verify `npm view opencode-model-router@2.4.0` and a clean install on an isolated 2.0.24 host.
- T3.4.5 [tier:medium] Final capped suite on `master`; cleanup of `D:\git\omr-rta-*` worktrees (including
  `D:\git\omr-rta-main`), `D:\git\omr-plan-rta`, `rta/*` and `docs/role-tier-plan` branches (local and origin) and the
  `rta/df1-prev`, `rta/df2-prev`, `rta/sync-prev` tags; close #84 with the summary (evidence, dogfood stats, rollback).

Tests (edge cases): the temp-HOME validation of the owner override (invalid layer → abort before writing); rollback
dry-run: the pre-DF-2 backup in a temp HOME yields tiers mode, the custom agents and explore → fast.
Acceptance: global criteria §6 met; owner live config in roles mode with a verified rollback path.
DoD: §7. QA: `[tier:heavy]` [route class=review risk=high pin] release review — artefacts, CI on the merge SHA, clean
install, owner migration evidence.

---

## 6. Global acceptance criteria
1. I1–I9 hold, each with unit/integration tests; I2–I5, I8, I9 also on the real host.
2. v1: goldens, v1 unit suites and `npm run smoke:v1` green; v1 prompt/agents/tools hash-equal the base except §2.9.
3. v2 tiers mode: every pre-existing test unmodified and green except the documented §2.9 goldens.
4. v2 roles mode: router-set models within bounds; shipped grants satisfy the separation rule; the authority ladder
   works end to end on the real host; zero unknown bindings in normal dispatches; role dispatches work inside a
   sibling-worktree work root, and paths outside every work root are denied.
5. `router_run`: no caller-controlled shell; injection, hijack and `.npmrc` tests pass on Windows and Linux CI.
6. Read-only agents and reviews are never denied by the producer guard; denied calls are not charged; budget
   exhaustion is recorded as `budget` and resumable.
7. No verification criterion is ever truncated; the E8 reproduction passes.
8. Stats show role × tier dispatches, signals by kind, budgets, authority requests, unknown bindings, exploration and
   tokens.
9. Docs, ADR 0006, CONFIG_REFERENCE, README, CHANGELOG complete; docs-drift green.
10. CI 12/12 green on the merge SHA; capped full suite green on `master`.
11. Global QA: zero open blocking/critical/major.
12. Owner config migrated at DF-2 with a backup: validated in a temp HOME against the synced code, written only after
    the liveness probe, verified live, and re-validated against the final code in P3.4; 2.4.0 published after human
    confirmation.
13. Self-test: P0.1 baseline, DF-1 and DF-2 recorded in `D:\git\omr-rta-main\docs\qa\role-tier\dogfood.md` (on
    `master` after the merge); Wave 3 executed
    through role agents, with the executor's own decision rows showing role, grant, bounds and signal fields, and
    every role-defect fallback to tier agents recorded and fixed.

## 7. Global Definition of Done
- All phases merged with QA PASS; reports in `D:\git\opencode-model-router\docs\qa\role-tier\`.
- `D:\git\opencode-model-router\docs\qa\role-tier\global.md` PASS.
- `master` contains the change; `v2.4.0` published after the human gate; clean install verified.
- Base checkout back on `master`, synced and clean; live host loads the plugin without error; owner in roles mode;
  dogfood record complete.
- Worktrees, `rta/*` branches and tags removed; #84 closed with the summary.

## 8. Global QA
P3.3: three fresh `[tier:heavy]` reviewers (areas A/B/C) in parallel, each given the diff `master@eeab36b..rta/main`,
every phase QA report, the spikes report and this plan, dispatched to the `reviewer` role (roles
mode since DF-2, role budget) and split by area when a dispatch is cut (resume the same session); rounds per §0.6.

## 9. Amendments
- R0 (pre-execution review, `[tier:heavy]`, findings PLAN-1…PLAN-21): route-line keys owned by P1.2 (PLAN-1);
  `general` never gets raw shell, shell is egress (PLAN-2); researcher `execute` gated by S8 (PLAN-3); `router_run`
  pins npm's script shell and uses an argument allowlist (PLAN-4); floor table with write + exec and effective
  detection, risk/scope raise-only (PLAN-5); §2.9 mode-independent fixes and reworded I1/I8 (PLAN-6); reader profile
  for the read-only tier, reviews and `CAP:none`, denied calls not charged, execution guidance under the old guard
  (PLAN-7); worktree-only paths in dispatches and a clean base checkout after every dispatch (PLAN-8); all new keys in
  P1.1 with contracts (PLAN-9); binding modules moved to Wave 1 as P1.6 (PLAN-10); ownership gaps closed (PLAN-11);
  source-compatible guard policy, unit-level acceptance in P1.5 (PLAN-12); one row-schema owner (PLAN-13);
  exploration off by default, global only, `propensity` logged (PLAN-14); binding lifetime, unknown-binding
  visibility, implementer prompt (PLAN-15); signal fixes (PLAN-16); #81 name collisions and migration order (PLAN-17);
  claims aligned with their citations (PLAN-18); spikes S8–S10 (PLAN-19); completeness items (PLAN-20); minor items
  (PLAN-21: reuse `Detection`, name the verify files, additive engine types, reviewer gets exec, `v1-roles.ts` check).
- R1 (owner directives, 2026-10-07): the implementation dogfoods itself — checkpoints DF-1/DF-2 sync the integration
  code into the base checkout on the local branch `rta/live` and Wave 3 runs through the role agents (§0.10); stop and
  notify the human whenever an OpenCode v2 restart is needed (§0.1); owner operating rules added verbatim (§0.9);
  integration starts from `origin/docs/role-tier-plan`; the owner's `enforcementMode` is back to `advisory`.
- R2 (handover review, 2026-10-07): plugin **code** is imported once per process (cost-aware plan A8 — *its* spike
  S7, not this plan's S7), so every code sync into the base checkout needs a host restart — DF-1, DF-2 and the P3.4 return to
  `master` are planned restart stops with a liveness probe (`build=` marker); only config hot-reloads. Owner override
  keys are written only after the code that accepts them is live (#80 layer drop). Rollback order: kill switch, then
  backup + reset + restart.
- R3 (heavy QA of the handover and R1/R2, findings QA-H-1…QA-H-20, round 1, all fixed): work root for role dispatches
  in sibling worktrees, `router_run` `cwd`, spike S11 (QA-H-1, critical); DF-1 probes assert the absence of guard
  footers against a P0.1 baseline (QA-H-2); rollback per checkpoint without resetting `master`, with `npm ci` when the
  lockfile differs (QA-H-3); kill switch = the pre-DF-2 override backup (QA-H-4); T3.4.2 writes only after the probe
  (QA-H-5); spike S12 on agent-registration reload and an optional DF-2b restart (QA-H-6); pre-flight step 5 and DoD
  with recorded baselines (QA-H-7); executor-owned plan/handover/dogfood files in `D:\git\omr-rta-main` (QA-H-8);
  liveness probe with the real marker format `build=<version>+<sha7>` and the `/router` line pasted by the human
  (QA-H-9; the claim that `opencode api` is missing was rejected: `opencode api get '/api/agent?…'` ran on the live
  2.0.24 on 2026-10-07); probe outcomes (QA-H-10); P0.1 pre-flight order (QA-H-11); stale lines (QA-H-12);
  `--maxWorkers=4` and no duplicate capped suites (QA-H-13); S7 disambiguation (QA-H-14); heavy coding in roles mode
  (QA-H-15); item 12 and DF-2 wording (QA-H-16); release only after the final probe set (QA-H-17); handover rows
  (QA-H-18); dogfood redaction (QA-H-19); `--no-track`, kept tags, `[executor]` steps, one round-limit wording
  (QA-H-20).

## 10. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Lazy binding impossible before the first tool call (S2) | The agent max policy bounds the child regardless; ambiguity → intersection; unknown → local + ladder; unknown bindings visible in rows and the advisor |
| Per-call model override differs for agents without a model (S1) | Register the floor tier's model as fallback; the spike decides |
| Code Mode inner calls bypass the permission hook (S8) | Researcher without `execute`; MCP search only through direct tools |
| Separation costs utility (cost unmeasured here; L13 reports 77% vs 84% for CaMeL) | Explicit composition in the protocol; ladder for misclassified needs; measured in stats |
| Classifier `needs` errors (E3) | Route-line `needs=`; ladder; authority-request counts per class for classifier tuning |
| Exploration wastes cost (RH9) | Off by default; global only; effective deterministic detection; `propensity` logged |
| Exec + network from repo scripts; untrusted repo content as injection | Documented residual risk; write + exec floors medium/heavy; not an OS sandbox |
| Orchestrators keep naming tiers | Tier agents stay valid; advisor reports role usage share |
| Host upgrade changes hook semantics | The spike file stays as a regression smoke; role agents fail closed (I9) |
| The old guard cuts plan-execution dispatches (E6/E7) | §0.2.4–0.2.6: atomic dispatches, notes file, ≤ 15 information calls, resume the same session; DF-1 removes the cause |
| A dogfood sync breaks the executor's own plugin (tier/role agents vanish: "Unknown agent", DF4 precedent) | Capped suite before every sync; `npm ci` only on a lockfile change and finished before the restart request; liveness probe after the restart; rollback = kill switch (from DF-2) or reset to the tag + another restart; the executor works directly with its own tools until the plugin is back (§0.9.2) |
| Every code sync costs a human restart (A8) | Three planned restart stops (DF-1, DF-2, P3.4), plus DF-2b only if S12 shows agent registration needs one; fixes found after DF-2 are batched into P3.4's sync, not re-synced one by one, unless they block Wave 3 |
| A roles-mode defect blocks Wave 3 | Kill switch: the pre-DF-2 override backup (hot reload); fix as a finding, re-sync (restart stop), re-apply the migration (§0.10) |
| Role agents cannot work in phase worktrees outside the session directory (classifier `external_dir`, deny-by-default) | Work root rule (§2.2, R3); spike S11 before any role code; DF-2 probes run on worktree paths with a negative probe |
