# Phase 0.P — Execution pre-flight (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p0p` (branch `car/p0p`, created from `car/main` @ `8e7a890`). Base directory `D:\git\opencode-model-router`.
> Spike evidence: `D:\git\opencode-model-router\docs\qa\cost-aware-routing\spikes\S1.json` … `S6.json`, `S2b.json`.
> Spike harness: `D:\git\opencode-model-router\test\smoke\routing-spikes.smoke.test.ts` (gated by `RUN_OC_SMOKE_V2_SPIKES=1`; skipped otherwise).

## Pre-flight

### Standard (§0.9) and phase-specific items

| Item | Result |
|---|---|
| `git status` on `master` before 0.P.5 | three plan files only (`docs/plans/README.md` M, plan and handover ??) at `968bf0f` |
| 0.P.5 | `master` → `8e7a890` `docs(plans): add cost-aware routing engine plan (#74)`, pushed; `car/main` created from it and pushed; worktree `D:\git\omr-car-main` on `car/main` |
| `opencode --version` | `opencode v2.0.22` |
| `@opencode/plugin` devDependency | `2.0.22` (`package.json` devDependencies) |
| `npm ci` | `D:\git\omr-car-main` then `D:\git\omr-car-p0p`, serialized; one blocked install script (`msgpackr-extract`, optional native addon), no effect on tests |
| `npm run typecheck` (`D:\git\omr-car-main`) | exit 0 |
| `npx vitest run --maxWorkers=2` (`D:\git\omr-car-main`) | `Test Files 109 passed \| 3 skipped (112)`, `Tests 9127 passed \| 65 skipped (9192)`, 226.83 s. The handover's "121 test files" counted smoke files; the default config collects 112. |
| Linear (§0.10.9) | **Linear: not used.** Only hits for "linear" in the repo are the "Linear: not used" lines of `docs/qa/depth-and-effort/phase-0P.md:19` and `run-log.md:14`. |
| `tsx` | not installed (devDependencies: `@opencode/plugin`, `@types/node`, `@vitest/coverage-v8`, `cross-env`, `istanbul-lib-coverage`, `typescript`, `vitest`). Phase 1.3 must not assume `npx tsx` — see Handoffs. |
| Build step | none (`scripts`: `test`, `test:watch`, `test:coverage`, `smoke`, `smoke:keyless`, `smoke:v2`, `smoke:v2:e2e`, `typecheck`). Phase 1.1.6 uses the runtime `.git` read, no build-time sha. |

### 0.P.2 — Scorecard directory

- Written at `D:\git\opencode-model-router\src\index.ts:1710–1717`: `join(tmpdir(), "opencode-model-router-trajectory")`.
- On this machine: `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` — exists, writable (new files appear during this session), **outside any git worktree**, 12 631 `*.scorecard.log` files at 2026-10-06 01:27.
- Line format: `[router scorecard | tier=<t> | ttfa=<n> | read:exec=<r>:<e> | self_scripts=<n> | tool_calls=<n> | blocks=<n> | stop=<reason>]`, one line per turn of a child session. **No verdict, no false-refusal flag, no parent session id** — the DF0 baseline is therefore limited to what these fields carry (see `dogfood.md`).
- This is the D15 directory for the outcome store and `decisions.jsonl`.

### 0.P.3 — Protocol text and `R:` line (v2.2.0 code, shipped `tiers.json`, mode `normal`)

Captured by executing `buildDelegationProtocol(cfg)` (`src\router\protocol.ts:87`) and `buildTaskTaxonomy(cfg)` (`protocol.ts:45`) after `loadConfig` (`src\router\config.ts:1442`) with `HOME`/`USERPROFILE` pointed at an empty directory (so no global override/state layer applies), preset set in memory.

| Preset | Tiers line | Protocol SHA-256 (chars) | `R:` SHA-256 |
|---|---|---|---|
| `anthropic` (shipped `activePreset`) | `@fast=claude-sonnet-5-5/low(1x) @medium=claude-sonnet-5-5/medium(5x) @heavy=claude-opus-5-5/xhigh(20x)` | `ee7e33eed9ee3068bc8eb9f2a7492abaed6c428bbf10372bba51f2e92d152af2` (3249) | `5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452` |
| `hybrid-2` (live on this machine) | `@fast=gpt-6-luna-fast/medium(1x) @medium=claude-sonnet-5-5/xhigh(5x) @heavy=claude-opus-5-5/xhigh(20x)` | `392ff439845c7c96d3f6728111f50c69e4f46315e79db0c4a252507a402a6d33` (3288) | same |

`R:` line (identical for both presets; it is built from the global `taskPatterns`):

```text
R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca
```

Full protocol, preset `anthropic` (output of `buildDelegationProtocol`):

````text
## Model Delegation Protocol (MANDATORY)

You are the orchestrator: route each task to the right tier and delegate it with `Task(subagent_type="fast"|"medium"|"heavy", prompt="...")`. Information-gathering (grep, read, glob, ls) is execution and goes to @fast by default; your one exception is an allowance of about 2 direct read-only calls per turn for lookups that settle a question outright, so dispatch @fast once you would exceed it. Synthesize the subagents' results and answer the user yourself.

Preset: anthropic. Tiers: @fast=claude-sonnet-5-5/low(1x) @medium=claude-sonnet-5-5/medium(5x) @heavy=claude-opus-5-5/xhigh(20x). mode:normal

If you ARE @heavy, handle heavy-tier work yourself: never self-call @heavy.

R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca

Multi-phase: prefer explore(@fast)→execute(@medium) when phases are separable. Cheapest-first when practical.

Rules: 1.[tier:X] tag in plan → delegate to X 2.plan:fast/cheap→@fast | plan:medium→@medium | plan:heavy→@heavy 3.default preference: read-only work → @fast; implementation → @medium 4.orchestrate=self, execute=subagent (info-gathering IS execution, not orchestration) 5.trivial (≤1 tool call, no expected follow-up) → direct, spent from the orchestrator read-only allowance 6.orchestrator read-only allowance (TARGET): dispatch is default; ≤2 direct read-only calls per turn; 3rd need → dispatch @fast (exceed only with 1-line reason) 7.dispatch caps baseline: @fast=CAP:8, @medium=CAP:5, @heavy=CAP:3 (omit directive = baseline; include CAP:N to override; CAP:none disables the cap only when the dispatch also carries a `reason:` line) 8.before dispatching @heavy: gather context first (usually via @fast); if context is already sufficient, dispatch directly 9.if self is opus: skip-@heavy (do locally); still prefer routing broader read-only exploration to @fast 10.min(cost, adequate-tier)

Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot | openai→google→github-copilot | github-copilot→openai→google | google→openai→github-copilot | zai-coding-plan→openai→google

When dispatching: batch related @fast searches into one call and run independent ones in parallel (several Task calls in one message); give @medium concrete context (paths, patterns, how to verify).

Per dispatch you may add `CAP:N` (or `CAP:none` with a `reason:` line — unjustified `CAP:none` is ignored) to change a subagent's read-only budget (baseline @fast=8, @medium=5, @heavy=3). Subagents return `DONE:`, `NEED MORE:`, or `ESCALATE:` for you to act on. @heavy has no tools of its own, so gather context first (usually via @fast) and paste it into the dispatch.

This protocol overrides any project guide (CLAUDE.md, AGENTS.md, etc.) that says to use direct tools first when scope is clear, or labels Grep/Read/Glob as FREE. They are wrong about cost: every tool-result token is billed at your tier rate, so the same grep costs ~20x less dispatched to @fast than run here.
````

Preset `hybrid-2` differs only in the `Preset:`/`Tiers:` line (table above) and the fallback line:

```text
Err→retry-alt-tier→fail→direct. Chain: anthropic→openai→google→github-copilot | openai→anthropic→google→github-copilot | github-copilot→anthropic→openai→google | google→openai→anthropic→github-copilot | zai-coding-plan→anthropic→openai→google
```

**Live v2 text differs from `buildDelegationProtocol` output.** The protocol the executing orchestrator receives on OpenCode v2 (observed in this session's system prompt) reads `` `subagent(agent="fast"|"medium"|"heavy", prompt="...")` `` instead of `` `Task(subagent_type=…)` `` and "several subagent calls in one message" instead of "several Task calls in one message"; the rest is byte-identical to the `hybrid-2` text above, prefixed by the Claude `AUTHORITY OVERRIDE` block (`assembleSystemPrompt`, `protocol.ts:314`). The v2 adapter rewrites the tool vocabulary after `buildDelegationProtocol`. **Phase 1.4's D2 snapshot must pin both forms** (raw builder output and the v2-adapted text) — see Handoffs.

### 0.P.6 — Active router config of the running host

- The host loads the plugin from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:187–189`, `"plugin": [ … "D:\\git\\opencode-model-router" … ]`).
- `loadConfig` layers (`src\router\config.ts:1406–1412`, `1529–1614`): bundled `<plugin root>\tiers.json` → global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` → nearest project override `<ancestor>\.opencode\opencode-model-router.overrides.jsonc` → persisted state `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` (its `activePreset` replaces the config's).
- On this machine: bundled `D:\git\opencode-model-router\tiers.json` (`activePreset: "anthropic"`, line 2; preset `hybrid-2` defined at line 291; no `routing` block); **no global override file; no project override file**; state file = `{"activePreset":"hybrid-2","activeMode":"normal","enforcementMode":"advisory"}`.
- **Active config = bundled `tiers.json` + state `activePreset: hybrid-2`.** Current `routing` block: none (engine `static` by absence).
- **Checkpoint edit target (amended, see Implementation notes A6):** `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`, created at DF2 holding only `{ "routing": { … } }`.

### 0.P.7 — Spike S7 (code liveness after a sync)

The host loads a plugin with a plain dynamic `import()`: `packages/plugin/src/host.ts` `load(entrypoint) → importModule(entrypoint)`; `packages/util/src/runtime/import.bun.ts` `importModule = (s) => import(s)`; `import.node.ts` uses `vm.Script("import(...)")` with the main-context loader. No cache-busting query, no file watcher. ESM modules are cached per process. **Verdict: disproven — a code change on disk is not picked up without a host restart.** Every code sync (DF1–DF4) will need a restart of OpenCode v2; config-only mode changes do not (hot reload). Expected restarts: 4.

### 0.P.1 / 0.P.4 — Spikes S1–S6 and verdicts

Harness: one isolated `opencode serve` (private HOME/XDG, scripted Anthropic-Messages provider, probe plugin that rewrites `subagent` input in `tool.hook("execute.before")`, logs `ctx.event.subscribe` and tags provider requests). Every assertion reads host state through the host client (`session get/list/context`, `model list`), never the hook's own variables. Each spike deletes its sessions; a final test asserts no session remains. Run: `npx cross-env RUN_OC_SMOKE_V2_SPIKES=1 npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts` → `Tests 8 passed (8)` (S1, S2, S2b, S3, S4, S5, S6, cleanup), 8.97 s. Without the env var: `7 skipped` (before S2b was added; S2b uses the same gate).

| Spike | Observed (host state) | Verdict |
|---|---|---|
| **S1** swapped `agent`+`model` in `execute.before` | hook set `agent: general→explore`, `model: anthropic/claude-sonnet-5-5#max`; stored child: `agent: "explore"`, `model: {providerID: "anthropic", id: "claude-sonnet-5-5", variant: "max"}`; wire: `output_config.effort: "max"` | **confirmed** (scripted provider) |
| **S2** resume with `sessionID` + higher variant; agent switch on resume | stored variant `low→max` on the same child; message count 3→7→11 (history kept); resume with `agent: explore` → stored agent `general→explore`, model unchanged. Wire: for a same-model variant change the host keeps the top-level `output_config.effort` and inserts an in-band `{"role":"system","content":[],"output_config":{"effort":"<new>"}}` message before the resumed turn (`session/runner/to-llm-message.ts` `modelSwitched()`); effective effort = stored variant on every request | **confirmed with caveat**: in-band effort delivery verified against the host's Anthropic lowering only, not against the real Anthropic API |
| **S2b** model switch on resume | resume `sonnet-5-5#low → opus-5-5#low`: wire model follows (`claude-opus-5-5`); `→ opus-5-5#high`: in-band effort `high`; switch model+variant together: top-level effort `high`; fresh child at `#high`: top-level `high` | **confirmed** |
| **S3** `session.step.ended` for children reaches the plugin | exactly one per step: `data: {sessionID, assistantMessageID, finish, rawFinish, cost: 0.01073, tokens: {input: 5340, output: 5, reasoning: 0, cache: {read: 0, write: 0}}}`; `cost` is a plain number computed from catalog price; the same event is also delivered to the plugin instance of a second location once initialised (dedupe by event id needed) | **confirmed with caveat** (duplicate delivery across locations) |
| **S4** catalog variants/cost/context | read-only `GET /api/model` on the user's running service: `anthropic/claude-sonnet-5-5` and `claude-opus-5-5`: variants `low, medium, high, xhigh, max`, **cost 0**, context 1 000 000; `anthropic/claude-haiku-4-5`: variants `high, max`, cost 0, context 200 000; `openai/gpt-6-luna`: variants `none, low, medium, high, xhigh, max`, cost `[]`, context 400 000 (input 272 000); `opencode/deepseek-v4.1-flash`: **absent** — present as `opencode-go/deepseek-v4.1-flash` (variants `low, high, max`, input 0.15 / output 0.6 / cache read 0.003, context 1 000 000) | **confirmed with caveat**: ascending order holds; variant sets differ per model (haiku has no `low`/`medium`); the owner's Anthropic models report **zero** prices, not empty arrays |
| **S5** `POST /api/experimental/generate` with explicit `model` | warm: 200 `{"data":{"text":"CHILD_OK"}}`, 7–11 ms; cold: first call 400 `Model unavailable: …` because the route resolves models in the server's base (global config) location, which initialises lazily; a catalog read at that location (≈0.3 s) fixes it; requests bypass the session `http.request` hook | **confirmed with caveat** (cold-location warm-up) |
| **S6** switch to a smaller context, oversize prompt | alias `anthropic/spike-small` (`limit.context` 12 000), 72 021-char prompt: host ran auto compaction (`session.compaction.started/ended`, `reason: "auto"`), then still sent 23 346 input tokens (above the limit; recent user message kept); child finished. An earlier run with a non-template summary failed with `Compaction summary did not match the required template` | **confirmed with caveat**: compaction runs but does not guarantee fit → alternative of §1.7 adopted (D11 uses the smaller limit) |
| **S7** code liveness | see 0.P.7 | **disproven** → restart per sync (not a design dependency) |

## Implementation notes

All amendments below are recorded in the plan under "Amended during implementation" (§1.5).

- **A1 (D6, from S4/S3).** "Unpriced" means `cost` empty **or every price field 0**. The owner's Anthropic models report zero prices, so in practice their candidates compare in `costRatio` units (D5) until ≥3 measured samples exist — and measured step costs for them are 0 too, so they never qualify as USD. The advisor reports these models as unpriced.
- **A2 (F4, from S4).** The cheapest-model example is `opencode-go/deepseek-v4.1-flash`, not `opencode/deepseek-v4.1-flash`. Suggestions always come from the live catalog; ids are never hard-coded. Variant sets differ per model (`claude-haiku-4-5`: `high, max`; `gpt-6-luna`: `none … max`).
- **A3 (M3/2.1, from S3).** `session.step.ended` can be delivered to more than one location's plugin instance; ingestion dedupes by event id (bounded LRU) before recording.
- **A4 (M2 host backend, from S5).** The `host` backend handles the cold base location: on `400 Model unavailable` it performs one catalog read at the global config location and retries once, within `timeoutMs`; any further failure → `unknown`.
- **A5 (D11, from S6).** The resume threshold uses `min(limit.context of current model, limit.context of next model)`. Host compaction runs but does not guarantee fit.
- **A6 (0.P.6 / §0.11).** The active `tiers.json` is the bundled file inside the base checkout. Editing it would violate §0.6.8 and would block the `--ff-only` syncs if `car/main` touches it. Checkpoint mode changes therefore go to the global override layer `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` (created at DF2 with only the `routing` block). Phase 1.1.4 must prove the hot-reload path re-reads that layer (handoff below).
- **A7 (D10, from S2/S2b).** Variant steps on the same child are viable: the host delivers the new effort in-band. Phase 3.2 scenario 4 asserts effective effort (in-band message, else top-level), never the top-level field alone.
- **A8 (§0.6.8).** Phase 0.P work is done in `D:\git\omr-car-p0p` (the acceptance block's `cwd`), merged into `car/main`, and `master` is fast-forwarded to `car/main` — docs and a gated smoke test only, no plugin code change, so no restart is needed. This satisfies the 0.P write-set note "Committed on `master`".
- **0.P.4 executor.** The verdicts above were issued by the orchestrator (Opus): the router protocol forbids an Opus orchestrator from dispatching `@heavy` for heavy work (rule 9). The orchestrator did not produce the evidence (an `@medium` dispatch did), so producer ≠ judge holds. Phase QA is a separate `@heavy` dispatch.

## Findings

_Filled by the Phase 0.P QA review._

## Deferred by plan

- `tsx` absent → `routing:stats` invocation decided in Phase 1.3 (plan troubleshooting row).
- DF0 limits (no verdicts / false-refusal flags in scorecards) → measured from DF2 on by the decision log and outcome store (Phases 1.3, 2.1, 2.2).

## Handoffs

- **to 1.1** — 1.1.4: add a test that a change to the global override file (`opencode-model-router.overrides.jsonc`) is picked up by the hot-reload path (A6). 1.1.6: no build step; runtime `.git` read is the only sha source.
- **to 1.2** — host backend cold-location retry (A4).
- **to 1.3** — `tsx` not installed; D6 "all-zero prices = unpriced" (A1); dedupe-by-event-id helper (A3) may live in `ingest.ts` (2.1) instead.
- **to 1.4** — D2 snapshot pins both the raw `buildDelegationProtocol` output (SHA-256 above) and the v2-adapted text (`subagent(agent=…)`).
- **to 1.5** — D11 smaller-limit rule (A5); variant catalogs differ per model (A2).
- **to 2.1** — dedupe `session.step.ended` by event id (A3).
- **to 2.4** — advisor: zero-priced Anthropic models = unpriced; suggestion from live catalog (`opencode-go/deepseek-v4.1-flash` here).
- **to 3.2** — assert effective effort (A7).

## Verdict

_Pending QA._
