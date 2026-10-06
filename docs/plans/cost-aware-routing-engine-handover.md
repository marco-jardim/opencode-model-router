# Handover — Cost-Aware Routing Engine (#74)

> **Revision:** 0 — kickoff (2026-10-06). Rewritten by the executing orchestrator at every checkpoint (DF0–DF5) and before every restart request (plan §0.11).
> **Plan:** `D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md` (revision 2). Read it in full before doing anything.
> **Issues:** [#74](https://github.com/marco-jardim/opencode-model-router/issues/74) (this work), [#73](https://github.com/marco-jardim/opencode-model-router/issues/73) (inspiration; close together with #74).

---

## 1. Kickoff prompt (paste into a fresh OpenCode v2 session opened in `D:\git\opencode-model-router`)

```text
You are the executing orchestrator for the plan
D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-plan.md (revision 2).
Resume point and operating notes: D:\git\opencode-model-router\docs\plans\cost-aware-routing-engine-handover.md.

Read both files completely before acting. Then execute the plan from its current "next task id"
(handover §2) to the end — Phase 0.P, Wave 1, Wave 2, Wave 3, release 2.3.0 — following the plan's
§0 directives, which are binding and override your defaults. The rules that matter most:

1. Iterate continuously, phase after phase, wave after wave. Stop ONLY for: an ambiguity only the
   human can settle; a critical problem (security, data loss, broken artifact); a blocking problem
   (a spike disproves an assumption with no written alternative, or the same failure persists after
   §0.8 recovery); or a dogfood checkpoint whose code sync is not live and needs a host restart
   (§0.1.4 / §0.11). Everything else is work.
2. If the model-router blocks you repeatedly — a less capable delegate returning verbose, circular
   or off-target output, a hand-back with zero tool calls, cap banners, the same dispatch failing
   twice — re-dispatch once with an explicit "attempt the work first" instruction; if that fails,
   take over MOMENTARILY and do the blocked read or implementation yourself, log it in
   D:\git\opencode-model-router\docs\qa\cost-aware-routing\run-log.md, then return to delegating.
   You are a top-tier model, extremely intelligent and capable; taking over is a recovery tool,
   not the default.
3. Pre-flight before EVERY phase (§0.9 + the phase's items). Fix everything it finds. If a finding
   is explicitly scheduled for a later phase of the plan, do not fix it early: document it in the
   phase QA report under "deferred by plan", naming the owning phase.
4. Heavy senior QA engineer review after EVERY phase and once globally. QA is always a
   [tier:heavy] task. Always apply this rule. Delegate to heavy QA an ADVERSARIAL review of the
   work done (CAP:none with a reason: line). Fix every finding from rounds 1 and 2; from round 3
   on, fix only blocking, critical and major; never re-review the same implementation until the
   reviewer runs out of findings (§0.7).
5. Always delegate through the model-router, preferring atomic tasks (one function, one test
   file, one doc section, one spike). Coding goes to @medium; genuinely complex coding (hook
   ordering, decision kernel, ladder algebra, runner changes) and every task the plan tags
   [tier:heavy] go to @heavy. Split heavy work: @heavy does the heavy lift; running tests and
   collecting results goes to @fast; fixing what the results show goes to @medium. Every
   dispatch carries the 7 sections and the ENVIRONMENT line (working directory = the phase
   worktree, Platform: win32, Shell: pwsh).
6. Never run the full suite unless it is needed (§0.9 pre-flight, after each merge, release).
   Test only what the change touches, and accelerate scoped runs: npx vitest run <files>,
   npx vitest related <src> --run, --maxWorkers=50% or more, --pool=threads, --no-isolate for
   pure unit files, independent scoped runs concurrently. Full-suite runs stay capped
   (--maxWorkers=2) and serialized.
7. Commit often (§0.3): after every green subtask, conventional commits, Refs #74, push at once.
   No AI attribution in any commit or PR, ever.
8. Work in phase worktrees created from car/main (§0.6). Whenever work happens outside the base
   checkout, write into this handover every open worktree's working directory, branch, phase and
   the base directory D:\git\opencode-model-router. Never edit the base checkout's tree except
   for the §0.6.8 exceptions (0.P.5 commit, dogfood syncs, release sync).
9. Dogfood the plan (§0.11): at DF1–DF4, sync master <- car/main after the wave's QA and capped
   full suite are green, probe liveness with /router (build= marker), record the period with
   npm run routing:stats into docs/qa/cost-aware-routing/dogfood.md, raise routing.engine one
   step (static -> shadow -> advise -> enforce) by editing ONLY the active tiers.json found in
   0.P.6, and rewrite this handover. From DF2 on, add "[route pin]" to every QA and [tier:heavy]
   dispatch prompt. If the liveness probe is stale, rewrite this handover and ask the human (in
   Portuguese) to restart OpenCode v2; resume from the handover when told to.
10. Linear: Phase 0.P checks whether the project uses Linear (search the repo and docs for Linear
    URLs or issue keys). If it does, update the matching issues at every phase boundary; if not,
    record "Linear: not used" in phase-0P.md. GitHub: one short progress comment on #74 at each
    wave boundary.
11. Talk to the human in Portuguese, short and direct. Code, docs, commits, QA reports, issue
    comments and PRs are in English.

First actions, in this order: (a) confirm the working directory resolves to
D:\git\opencode-model-router (git rev-parse --show-toplevel) and that `git status` shows the three
uncommitted plan files listed in handover §2; (b) execute task 0.P.5 (commit them on master, push,
create car/main and D:\git\omr-car-main); (c) run the Phase 0.P pre-flight and spikes S1–S7.
```

---

## 2. Execution state

| Item | Value |
|---|---|
| Checkpoint reached | none (kickoff) |
| **Next task id** | **0.P.5** (commit plan files on `master`), then 0.P pre-flight, then 0.P.1 (spikes) |
| `master` | `968bf0f` (`chore(release): 2.2.0`) **plus three uncommitted files**: `docs\plans\cost-aware-routing-engine-plan.md` (new), `docs\plans\cost-aware-routing-engine-handover.md` (new, this file), `docs\plans\README.md` (modified) |
| `car/main` | not created yet (0.P.5 creates it from the commit above) |
| Base directory | `D:\git\opencode-model-router` (branch `master`); the session alias `D:\git\Claude-model-router` resolves to the same repository — always use the `D:\git\opencode-model-router` form in dispatches |
| Integration worktree | `D:\git\omr-car-main` on `car/main` (to be created in 0.P.5) |
| Phase worktrees | none yet; pattern `D:\git\omr-car-p<id>` on `car/p<id>` (`1.4` → `p14`), created from `car/main` |
| Other worktrees present on the machine (not ours; never touch) | `D:\git\opencode-model-router-v2` (`fix/gate-task-cwd`), `D:\git\opencode-model-router-release` (`release/1.13.0`), `D:\git\opencode-model-router-agent-options-gate` (`fix/agent-options-provider-gate`) |
| Active router config of the running host | **unknown — task 0.P.6.** The planning session's protocol reported preset `hybrid-2` (`@fast=gpt-6-luna-fast`, `@medium=claude-sonnet-5-5/xhigh`, `@heavy=claude-opus-5-5/xhigh`), while `D:\git\opencode-model-router\tiers.json` holds preset `anthropic` (sonnet-5-5#low / sonnet-5-5#medium / opus-5-5#xhigh). The file the host actually loads is elsewhere; find it via `loadConfig` in `D:\git\opencode-model-router\src\router\config.ts` and `/router`. Only that file is edited at checkpoints. |
| Current `routing` block | none (engine = `static` by absence) |
| Host | OpenCode `v2.0.22` (`opencode --version` verified); source pinned at `anomalyco/opencode` tag `v2.0.22` = `527f0b931d1f9b3ebd34e106c51b31ce5db5b075`; `@opencode/plugin` 2.0.22 in `package.json:55` |
| Open QA findings | none |
| Last `routing:stats` | n/a (script does not exist yet; Phase 1.3) |
| Sentence for the human | n/a |

---

## 3. Considerations from the planning session (read before Phase 0.P)

### 3.1 What is verified in source and what is a spike

Everything in plan §1.1 was read in the actual files (plugin at `v2.2.0`, host at tag `v2.0.22`), with line references. Treat those as facts. The six items that could **not** be settled by reading are spikes S1–S7 in §1.7; do not assume them, run them. The most consequential: S1 (does the host honour a swapped `agent` **and** `model` in `event.input` for `subagent`?), S2 (resume with a higher `#variant` keeps history and switches the model), S3 (`session.step.ended` reaches `ctx.event.subscribe` for child sessions), S4 (variant ids and order for the owner's models).

### 3.2 Facts that are easy to get wrong

- **Variants are synthesized by the host**, not listed in models.dev (`packages/core/src/variant.ts` `resolve`, default `EFFORTS = ["low","medium","high"]`, provider-specific lists; `packages/core/src/models-dev.ts:105,186–192`). The `subagent` tool validates `#variant` against `model.variants` at call time and fails with the available list (`subagent.ts:90–96`). Always read variants from the live catalog; never hard-code `xhigh`.
- **`cost = 0` means "no catalog price", not free** (`packages/core/src/session/usage.ts:22–28` returns `Money.USD.zero`). Subscription providers (`opencode` Go, `github-copilot`) report catalog prices that are not what is billed. Plan D5/D6 handle this; the advisor must say it.
- **`POST /api/experimental/generate` without `model` runs on the user's default model**, the most expensive one in a typical preset (`packages/core/src/model-resolver.ts:402–415`). The classifier backend `host` must always pass `model`; the config validation makes `backend != rules` without `model` an error (D3).
- **Agents are roles; model is per call.** `model = override ?? agent.model ?? parent.model` for any agent (`subagent.ts:184`). The host's own `agent` argument description says a name that is not an agent "most likely mean[s] a model". Never tell the LLM to set `model` (plan §0.10.11); the plugin sets it in the hook, as it already does for `subagentTiers` (`src\compat\v2-hooks.ts:316–326`).
- **Hidden agents are configurable**: `agents.title.model`, `agents.summary.model` (and `compaction`) are applied without any guard (`packages/core/src/config/plugin/agent.ts:77–107`); legacy `small_model` migrates to `agents.title.model`. The owner has neither set. The cost doctor's first finding will be exactly this.
- **The host blocks nested delegation** (`subagent_depth` default 1, `subagent.ts:117–133`) and rejects `mode: "primary"` agents as subagents (`:136–137`). Never raise the depth.
- **The orchestrator sees agent descriptions**: the `subagent` tool description is rewritten with "Available subagents:" at each model request (`subagent.ts:284–301`), filtered by `mode != primary`, `!hidden` and permissions. Hints must use the same ids.
- **`delegate` creates a new producer session per ladder attempt today** (`src\index.ts:613–616, 728–736, 1014–1017`); native `task` verification is observational and never retries. Phase 2.3 is a real change, not a tweak.
- **`maxAttemptsPerTier` defaults to 1**, so the existing `effortBump` never gets a second attempt by default. Plan D10 makes variant steps not consume that counter on v2.
- **Hooks**: the host runs the tool with `event.input` as returned by hooks (`packages/core/src/tool.ts:271–280`); reassigning `event.input` is the sanctioned pattern (`packages/core/src/plugin/tool-input-repair.ts:33`); only `execute.before` may throw to reject a call (`packages/core/src/plugin/hooks.ts:23`). The adapter already reassigns at `v2-hooks.ts:346`.
- **`switchModel` has no compaction logic** (`packages/core/src/session/session.ts:97–109`); what happens on overflow after a switch is spike S6.

### 3.3 The owner's decisions (do not re-open)

Plan §1.5 D1–D18. In particular: v2 only (v1 stays `static`; `roles` on v1 is prose-only opt-in); native agents `explore`/`general` are default candidates on v2 (D12); the four modes are features, default `static` must equal `2.2.0` byte for byte (D2); the classifier is never an agent (D3); probabilities come only from outcomes (D4); the plan dogfoods itself and picks the final mode by D17.

### 3.4 Delegation behaviour observed during planning (expect it again)

- **`@fast` returned with zero tool calls 5 times out of 12**, claiming it had no filesystem, shell or web-fetch tools. It was wrong about the filesystem (it worked in 2 other dispatches); it was right about web fetch (fast delegates had no fetch tool). What worked: a preamble that lists three concrete calls to attempt first — `(a) Get-ChildItem <dir> (b) read <file> lines 1–60 (c) search "<literal>" in <dir>` — and says "only if all three genuinely error may you return NEED MORE, quoting the errors". The third consecutive failure on the same task is the §0.8 limit: stop re-dispatching and do it yourself (§0.10.2).
- **Web reads**: do them yourself with the code-mode `execute` tool (`fetch`). Host source: `https://raw.githubusercontent.com/anomalyco/opencode/527f0b931d1f9b3ebd34e106c51b31ce5db5b075/<path>`; directory listings: `https://api.github.com/repos/anomalyco/opencode/contents/<dir>?ref=527f0b93…` (unauthenticated, 60 req/h; add a `User-Agent` header). Catalog prices: `https://models.dev/api.json`.
- **`@fast` is good at**: local file reads with explicit paths, `rg`, `gh issue view --json`, listing directories, running a scoped test file and reporting. **Not good at**: inferring where code lives, multi-hop investigations, anything needing a browser.
- The plugin's own `FALSE-REFUSAL SUSPECT` banner did **not** appear in the planning session's harness; do not rely on it to tell you a delegate did nothing — check the hand-back text for "no tools" claims.

### 3.5 Windows / shell specifics that bit during planning

- `rg` patterns with `\"` inside a double-quoted pwsh string break the regex (`unclosed group`). Use **single quotes** for patterns: `rg -n -e 'mode: "subagent"' <file>`.
- `rg` honours `.gitignore`; for `node_modules` use `--no-ignore` and read `node_modules\@opencode\plugin\…` (the v2 types) — **not** `node_modules\@opencode-ai\sdk\dist\v2\…`, which is the obsolete v2 API (`docs\OPENCODE_V2.md:12`).
- `gh` works from `D:\git\opencode-model-router` (issue #74 and the #73 comment were created with it). `gh issue view 73 --comments` printed nothing once; `--json title,body,comments` is reliable.
- `Get-ChildItem`, not `ls`; `$env:TEMP`, not `/tmp`; temp files under `C:\Users\Marquinho\AppData\Local\Temp\opencode\`.
- Process check for orphans: `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='opencode.exe' OR Name='bun.exe'"`.

### 3.6 Repository conventions to match

- Plans: `docs\plans\`, index in `docs\plans\README.md` (already updated). ADRs: `docs\adr\000N-*.md`, next number **0005**. QA: `docs\qa\<plan-slug>\phase-<id>.md`, `global.md`, `run-log.md`; ours is `docs\qa\cost-aware-routing\`.
- Tests: vitest, 121 test files; `npm run typecheck`; smoke scripts `smoke:v2` etc.; the scripted provider harness `test\smoke\helpers\scripted-provider.ts` drives a real host and already handles `task_id` (v1) vs `sessionID` (v2) (`:80–83`); `test\smoke\depth-effort.smoke.test.ts` is the template for spikes (it proves `sessionID` resume at `:330–347`).
- Golden fixtures exist for the ladder ("Keep bump-off policies byte-identical to the original golden fixture", `src\escalate\ladder.ts:221`). Phase 1.5 must leave them byte-identical.
- Existing directive channels in prompts — `CAP:N`, `CAP:none` + `reason:`, `VERIFY:required|deferred`, `[acceptance]…[/acceptance]` — are parsed in `tool.execute.before`. `[route …]` follows the same pattern (D13).
- The repo's `tiers.json` ships `taskPatterns` for fast/medium/heavy (lines ≈376–412); `classifyTrivial` (`src\router\sessions.ts:286–331`) is the rules-layer seed.

---

## 4. Troubleshooting

| Symptom | What to do |
|---|---|
| A delegate returns `NEED MORE` with zero tool calls | Re-dispatch once with the three-concrete-calls preamble (§3.4). Second failure: do it yourself, log in `run-log.md`. |
| `CAP:none` ignored by the router | It needs a `reason:` line in the same dispatch (plan §0.5). |
| `router_verify pending: true` shows `unverifiable` | Re-run the scoped command `npx vitest run --maxWorkers=2 <files>` yourself and record the result in the phase QA report. |
| Spike S1 shows the swapped `agent` ignored but `model` honoured | Plan §1.7: `enforce` becomes model-only; amend §1.5 under "Amended during implementation"; not a stop. Both ignored: blocking → ask the human. |
| Spike S4: a tier's configured `variant` is not in `model.variants` | Advisor finding + explicit `candidates` in the plan's config examples; the ladder never emits a variant the catalog does not list. |
| `npx tsx` not available for `scripts\routing-stats.ts` | Check `package.json` scripts for how the repo runs TS scripts (bun? `node --import tsx`?) and match it; add the dev dependency only if the repo already uses it elsewhere. |
| After a dogfood sync, `/router` does not show `build=<new sha>` | Code is not live. Rewrite this handover (§2 with the exact next task id), tell the human in Portuguese: "Sync DF<n> concluído; o código novo não está ativo na sessão. Reinicie o OpenCode v2 e diga 'retomar'." Stop. On resume, probe again before anything else. |
| After a sync the plugin misbehaves (hook errors in the opencode log, dispatches not starting, `/router` throwing) | 1) set `routing.engine: static` in the active config (hot reload, instant); 2) if still broken: `git -C D:\git\opencode-model-router reset --hard car/sync-<n>-prev`, request a restart, log the incident, open `QA-DF<n>-1` (critical) for the owning phase. |
| Config change not reflected by `/router` | You edited the wrong file. Re-run 0.P.6's resolution; the host loads a different `tiers.json` than the repo's. |
| Full suite slow or flaky under parallel worktrees | It must be capped (`--maxWorkers=2`) and serialized; smoke tests also serial; `npm ci` one worktree at a time (§0.6.9). |
| Merge conflict in `src\index.ts` / `src\compat\v2-hooks.ts` | Single-owner files per wave (§2). Only the orchestrator merges, in `D:\git\omr-car-main`, one phase at a time; resolve yourself, never via two agents. |
| A QA reviewer keeps finding minors on the 3rd round | §0.7: from round 3, fix only blocking/critical/major; record the rest as "accepted — QA round limit". |
| The human is unreachable at a restart request | Wait. Do not continue on stale code; do not edit the base checkout further. |

---

## 5. Checklist for the first hour

- [ ] `git -C D:\git\opencode-model-router rev-parse --show-toplevel` and `git status` → three uncommitted plan files, nothing else.
- [ ] 0.P.5: commit + push; `git branch car/main`; `git worktree add D:\git\omr-car-main car/main`.
- [ ] `npm ci` in `D:\git\omr-car-main`; `npm run typecheck`; `npx vitest run --maxWorkers=2` (capped, once).
- [ ] 0.P.6: find the active `tiers.json`; record path, preset, `routing` block here (§2) and in `phase-0P.md`.
- [ ] 0.P.2: locate the scorecard directory; 0.P.3: snapshot the live protocol text and `R:` line; 0.P.8: write `dogfood.md` `## DF0`.
- [ ] Linear check (§0.10.9).
- [ ] Spikes S1–S7 in `test\smoke\routing-spikes.smoke.test.ts` (serial, real host); heavy verdicts (0.P.4).
- [ ] Heavy QA of Phase 0.P; zero open findings; rewrite this handover (checkpoint DF0, next task id 1.1.1).
- [ ] Post the Wave-1 start comment on #74.
