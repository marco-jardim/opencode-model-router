# Phase 0.P — Execution pre-flight (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p0p` (branch `car/p0p`, created from `car/main` @ `8e7a890`). Base directory `D:\git\opencode-model-router`.
> Spike harness: `D:\git\opencode-model-router\test\smoke\routing-spikes.smoke.test.ts` — gated by `RUN_OC_SMOKE_V2_SPIKES=1` (isolated hosts); S4 additionally needs the manual opt-in `RUN_OC_SPIKE_LIVE_CATALOG=1` (read-only GETs of the user's running service; no generation); skipped otherwise.
> Evidence: `D:\git\opencode-model-router\docs\qa\cost-aware-routing\spikes\*.json`, all from one run (`runId 14487af3-…`, harness blob `c6d2054`, commit `d9e2358`).

## Pre-flight

### Standard (§0.9) and phase-specific items

| Item | Result |
|---|---|
| `git status` on `master` before 0.P.5 | three plan files only (`docs/plans/README.md` M, plan and handover ??) at `968bf0f` |
| 0.P.5 | `master` → `8e7a890` `docs(plans): add cost-aware routing engine plan (#74)`, pushed; `car/main` created from it and pushed; worktree `D:\git\omr-car-main` on `car/main` |
| `opencode --version` | `opencode v2.0.22` |
| `@opencode/plugin` devDependency | `2.0.22` |
| `npm ci` | `D:\git\omr-car-main` then `D:\git\omr-car-p0p`, serialized; one blocked optional install script (`msgpackr-extract`), no effect on tests |
| `npm run typecheck` (`D:\git\omr-car-main`) | exit 0 |
| `npx vitest run --maxWorkers=2` (`D:\git\omr-car-main`) | `Test Files 109 passed \| 3 skipped (112)`, `Tests 9127 passed \| 65 skipped (9192)`, 226.83 s. The default config collects 112 files (smoke files use `vitest.smoke.config.ts`). |
| Linear (§0.10.9) | **Linear: not used.** The only "linear" hits are the "Linear: not used" lines of `docs/qa/depth-and-effort/phase-0P.md:19` and `run-log.md:14`. |
| `tsx` | not installed. Phase 1.3 must not assume `npx tsx` (handoff). |
| Build step | none. Phase 1.1.6 uses the runtime `.git` read. |

### 0.P.2 — Scorecard directory

- Written at `D:\git\opencode-model-router\src\index.ts:1706–1717` on `session.idle`: `join(tmpdir(), "opencode-model-router-trajectory")`, **only when guard state exists for the session** (`guardStore.get(sid)`, `:1710–1713`), appending one line per idle.
- On this machine: `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory` — exists, writable, outside any git worktree, 12 631 `*.scorecard.log` files at 2026-10-06 01:27.
- Line format: `[router scorecard | tier=<t> | ttfa=<n> | read:exec=<r>:<e> | self_scripts=<n> | tool_calls=<n> | blocks=<n> | stop=<reason>]`. No verdict, no false-refusal flag, no parent session id.
- This is the D15 directory for the outcome store and `decisions.jsonl`.

### 0.P.3 — Protocol text and `R:` line (v2.2.0 code, shipped `tiers.json`, mode `normal`)

Captured by executing `buildDelegationProtocol(cfg)` (`src\router\protocol.ts:87`) and `buildTaskTaxonomy(cfg)` (`protocol.ts:45`) after `loadConfig` (`src\router\config.ts:1442`) with `HOME`/`USERPROFILE` pointed at an empty directory (no global override/state layer), preset set in memory.

| Preset | Tiers line | Protocol SHA-256 (chars) | `R:` SHA-256 |
|---|---|---|---|
| `anthropic` (shipped `activePreset`) | `@fast=claude-sonnet-5-5/low(1x) @medium=claude-sonnet-5-5/medium(5x) @heavy=claude-opus-5-5/xhigh(20x)` | `ee7e33eed9ee3068bc8eb9f2a7492abaed6c428bbf10372bba51f2e92d152af2` (3249) | `5aca1a71c1450dd61deb2a65c411c9ee03e26b835e3704fe4d81df45bee42452` |
| `hybrid-2` (live on this machine) | `@fast=gpt-6-luna-fast/medium(1x) @medium=claude-sonnet-5-5/xhigh(5x) @heavy=claude-opus-5-5/xhigh(20x)` | `392ff439845c7c96d3f6728111f50c69e4f46315e79db0c4a252507a402a6d33` (3288) | same |

`R:` line (identical for both presets; built from the global `taskPatterns`):

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

**Live v2 text differs from `buildDelegationProtocol` output.** The protocol the executing orchestrator receives on OpenCode v2 (this session's system prompt) reads `` `subagent(agent="fast"|"medium"|"heavy", prompt="...")` `` instead of `` `Task(subagent_type=…)` `` and "several subagent calls in one message" instead of "several Task calls in one message"; the rest is byte-identical to the `hybrid-2` text, prefixed by the Claude `AUTHORITY OVERRIDE` block (`assembleSystemPrompt`, `protocol.ts:314`). Phase 1.4's D2 snapshot pins both forms (handoff).

### 0.P.6 — Active router config of the running host

- The host loads the plugin from `D:\git\opencode-model-router` (`C:\Users\Marquinho\.config\opencode\opencode.json:187–189`).
- `loadConfig` layers (`src\router\config.ts:1406–1412`, `1529–1614`): bundled `<plugin root>\tiers.json` → global override `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` → nearest project override `<ancestor>\.opencode\opencode-model-router.overrides.jsonc` → persisted state `C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json` (its `activePreset` replaces the config's).
- On this machine: bundled `D:\git\opencode-model-router\tiers.json` (`activePreset: "anthropic"`, line 2; `hybrid-2` at line 291; no `routing` block); no global or project override file; state = `{"activePreset":"hybrid-2","activeMode":"normal","enforcementMode":"advisory"}`.
- **Active config = bundled `tiers.json` + state `activePreset: hybrid-2`.** Current `routing` block: none (engine `static` by absence).
- **Checkpoint edit target (A6):** `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`, created at DF2 with only `{ "routing": { … } }`.

### 0.P.7 — Spike S7 (code liveness after a sync)

The host loads a plugin with a plain dynamic `import()`: `packages/plugin/src/host.ts` `load(entrypoint) → importModule(entrypoint)`; `packages/util/src/runtime/import.bun.ts` `importModule = (s) => import(s)`; `import.node.ts` uses `vm.Script("import(...)")` with the main-context loader. No cache-busting, no watcher; ESM modules are cached per process. **Verdict: disproven** — a code change on disk needs a host restart. Every code sync (DF1–DF4) needs one; config-only mode changes do not. Expected restarts: 4.

### 0.P.1 / 0.P.4 — Spikes and verdicts

Harness: isolated `opencode serve` hosts (private HOME/XDG, **allowlisted environment** — no provider credentials reach them, asserted) with a scripted Anthropic-Messages provider and a probe plugin that rewrites `subagent` input in `tool.hook("execute.before")`, records `ctx.event.subscribe` deliveries tagged by plugin instance, can call `ctx.generate.text`, and tags provider requests. The main host runs with a global allow-all permission fixture; a second host (S2-agent-native) runs with the host's **native** agent permissions. Child sessions are read back through the host client (`session.get` / `session.list({parentID})` / `session.context`, `model.list`); S3/S3b read the probe plugin's subscription log by design (that is the hypothesis); the child id is taken from the tool result and a dispatch fails unless exactly one child is identified. Each spike deletes its sessions; `cleanup` asserts 0 sessions remain, kills each host tree with `taskkill /T /F` and asserts the port is closed. The harness makes **no** live generate call; `RUN_OC_SPIKE_LIVE_CATALOG=1` enables only S4's read-only GETs (`/api/debug/location`, `/api/model`, `/api/provider`) of the user's running service.

Committed evidence: one run, `runId 14487af3-8e39-4c68-9580-2ada78ff2d00`, harness blob `c6d20542e47922d8c36f6e189a6fdafe22a68252`, commit `d9e2358`.

| Run | Command | Result |
|---|---|---|
| evidence run | `npx cross-env RUN_OC_SMOKE_V2_SPIKES=1 RUN_OC_SPIKE_LIVE_CATALOG=1 npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts --reporter=verbose` | `Tests 11 passed (11)`, 18.85 s |
| acceptance check | same without `RUN_OC_SPIKE_LIVE_CATALOG` | `Tests 10 passed \| 1 skipped (11)` (S4 skipped), 17.35 s |
| no env | — | `Tests 11 skipped (11)` |

| Spike | Observed (host state / wire) | Verdict |
|---|---|---|
| **S1** swapped `agent`+`model` in `execute.before` | hook: `agent general→explore`, `model anthropic/claude-sonnet-5-5#max`; stored child: `agent "explore"`, model `{anthropic, claude-sonnet-5-5, variant "max"}`; wire effort `max` | **confirmed** (scripted provider, allow-all fixture) |
| **S1-deny** same swap with `{subagent, explore, deny}` for the parent | rewrite applied, then the host refused: `Subagent denied: explore` (`Permission.BlockedError`); no `explore` child; 0 provider requests for `explore` during the spike; control `general` dispatch completed | **host re-checks permissions after the rewrite** → A11 |
| **S2** resume with `sessionID` + higher variant; agent switch on resume (allow-all fixture) | stored variant `low→max` on the same child; message count 3→7→11; resume with `agent: explore` → stored agent `general→explore`, model unchanged; wire: top-level effort unchanged, new effort in an in-band `{"role":"system","content":[],"output_config":{"effort":…}}` message (`session/runner/to-llm-message.ts` `modelSwitched()`); tools 12/12/12, system-prompt hash changes on the agent switch | **confirmed with caveat**: in-band delivery is the host's request building; acceptance by the real provider API is unverified |
| **S2-agent-native** agent switch under native permissions | stored agents `general, general, explore, general`; tools 11 → 11 → **6** → 11; `general`: `edit, glob, grep, read, shell, skill, subagent, webfetch, websearch, write, execute`; `explore`: `glob, grep, read, subagent, webfetch, websearch`; system-prompt SHA-256 `a5373be9…` (7 989 chars) → `cfa0baff…` (7 003 chars) on the switch and back to `a5373be9…` on the return; a variant-only resume changes neither | **confirmed**: an agent switch on resume changes tools and system prompt → A11 |
| **S2b** model switch on resume; mixed sequences | `sonnet#low → opus#low` on resume: wire model `claude-opus-5-5`; `→ opus#high`: in-band `high`; model+variant together: top-level `high`; fresh child at `#high`: top-level `high`; **A#low → A#high → B#xhigh**: req 3 `claude-opus-5-5`, top-level `xhigh`, no new in-band message; **no variant**: stored `variant "default"`, no effort sent, resume to `#high` → in-band `high` and the top-level `thinking` object changes; **`claude-haiku-4-5` high→max**: no `output_config.effort`, no in-band message, top-level `thinking.budget_tokens` `16000 → 31999` | **confirmed with caveats** → A7, A9 |
| **S3** `session.step.ended` reaches the plugin (one plugin instance) | `session.step.ended` raw 1 = deduped 1; `cost 0.01073`, `tokens {input 5340, output 5, reasoning 0, cache {read 0, write 0}}` (= 5340×2e-6 + 5×1e-5 at the isolated catalog price) | **confirmed** |
| **S3b** same, with two live locations (after S5) | raw session events 22 → deduped 11; `session.step.ended` raw 2 → deduped 1; both deliveries carry the **same event id**, one per plugin instance (project location and the config location) | **confirmed: one delivery per live location instance** → A3 |
| **S4** catalog variants/cost/context (live service, read-only, opt-in) | explicit already-live location `D:\git\opencode-model-router`; live location set unchanged (asserted). `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`: variants `low, medium, high, xhigh, max`, one cost entry with **every field 0**, context 1 000 000; `anthropic/claude-haiku-4-5`: `high, max`, all-zero cost, context 200 000; `openai/gpt-6-luna` and **`openai/gpt-6-luna-fast`** (live @fast): `none, low, medium, high, xhigh, max`, cost `[]`, context 400 000 / input 272 000 / output 128 000; `opencode/deepseek-v4.1-flash` absent, `opencode-go/deepseek-v4.1-flash` present (`low, high, max`, input 0.15 / output 0.6); `opencode-go/gpt-6-luna` 0.1 / 0.5. Every variant list in host effort order (asserted). Unpriced flags set for all five `anthropic`/`openai` models above. Tool-call support not checked | **confirmed with caveats** → A1, A2, A10 |
| **S5** `generate` with explicit `model` | **plugin path** `ctx.generate.text({prompt, model})`: succeeded on the first call (7 ms), then 6 / 6 ms; the base location stayed not live — the plugin path resolves at the dispatching (already warm) location. **Raw route** `POST /api/experimental/generate`: first call 400 `Model unavailable`; immediate retry 400; retry after 272 ms without a catalog read 200 → time-based lazy init of the base location. **No live call** (removed, QA-0P-27) | **confirmed for the plugin client on the isolated host**; real-credential path → checkpoint DF3 (A4) |
| **S6** switch to a smaller context, oversize prompt | alias `anthropic/spike-small` (`limit.context` 12 000), 72 021-char prompt: auto compaction (`session.compaction.started/ended`, `reason: "auto"`) ran before the primary request; the primary request still exceeded the limit (≈23 346 tokens **estimated by the scripted provider** from body length) because the oversize incoming message is kept as recent context; child finished. Events: raw 48 → deduped 24, `step.ended` raw 4 → deduped 2 (two instances). The scripted provider never returns an overflow error, so the error branch was not observable | **confirmed** (it compacts) → A5 |
| **S7** code liveness | see 0.P.7 | **disproven** → A8 |

## Implementation notes

The amendment texts are canonical in the plan, §1.5 "Amended during implementation" (same ids A1–A12); this list gives only the evidence behind each.

- **A1 (D5/D6, unpriced = empty or all-zero)** — S4 cost entries. Live step costs of 0 are inferred from the host's catalog-price computation (S3), not measured on the live host. Consequence: the dogfood is in `costRatio` units.
- **A2 (F4, catalog-only suggestions; "cheapest" defined)** — S4 prices; tool support not checked by S4.
- **A3 (M6, process-scope dedupe, module-scope registry, single writer)** — S3b, S6 event counts.
- **A4 (M2 `host` backend via `ctx.generate.text`, errors → `unknown`, live check at DF3)** — S5.
- **A5 (D11 resume rule with `inputBudget`)** — S6; S4 `limit.output` 128 000 on the wire (S2b `max_tokens`).
- **A6 (checkpoints edit the global override file)** — 0.P.6.
- **A7 (effort delivery per provider route)** — S2, S2b (including haiku and `default`).
- **A8 (restart per code sync)** — 0.P.7.
- **A9 (`default` variant)** — S2b no-variant case.
- **A10 (tiered prices, `inputBudget`)** — S4 `gpt-6-luna*` entries.
- **A11 (permission re-check; evaluated permissions for `needs`)** — S1-deny, S2-agent-native.
- **A12 (0.P merges via `car/main`, then `master` fast-forward)** — §0.6.8.
- **A13 (owner names the live classifier model; DF3 check is a bounded one-shot, then restored)** — QA-0P-38/39.
- **0.P.4 executor.** Verdicts issued by the orchestrator (Opus) per router rule 9; producer (`@medium` harness) ≠ judge. QA is a separate `@heavy` dispatch.

## Findings

**Round 1** (`@heavy`, adversarial): 0 blocking, 1 critical, 8 major, 11 minor, 5 nit. Round 2 judged 20 resolved and 5 partially resolved (QA-0P-1, 3, 17, 18, 20); the partial ones were completed in round 2 (see the resolution column).

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0P-1 | critical | harness S5 | S5 used the raw HTTP route, not the plugin client | probe calls `ctx.generate.text` (`5113977`); live check given an owner: checkpoint DF3 (QA-0P-26) |
| QA-0P-2 | major | harness S4 | live read not opt-in; could start a location | opt-in gate, explicit already-live location, location set asserted unchanged — `5113977` |
| QA-0P-3 | major | S3 / A3 | duplicate delivery unrecorded | counts recorded (`5113977`); duplicate delivery demonstrated by S3b (`d9e2358`); A3 rewritten |
| QA-0P-4 | major | S1 | permission re-check after rewrite untested | `S1-deny` — `5113977`; A11 |
| QA-0P-5 | major | A7 | in-band effort generalised | haiku case (`5113977`); A7 per route |
| QA-0P-6 | major | A5 | `min()` rule not derived from S6 | A5 rewritten |
| QA-0P-7 | major | — | `default` variant missing | no-variant case (`5113977`); A9 |
| QA-0P-8 | major | S4 / dogfood | live @fast model unchecked; unit unstated | `gpt-6-luna-fast` recorded (`5113977`); A1 + `dogfood.md` |
| QA-0P-9 | major | `dogfood.md` | zero-tool contradiction | scorecard written only with guard state (`src\index.ts:1710–1713`); bias stated |
| QA-0P-10 | minor | A1 | inference as fact; tiered cost, `limit.input` | A1 wording; A10 |
| QA-0P-11 | minor | evidence | two runs | single run with `runId` + harness blob — `d9e2358` |
| QA-0P-12 | minor | harness S3 | `waitFor` returned on `[]` | `5113977` |
| QA-0P-13 | minor | harness S5 | catalog-read claim unproven | time-based lazy init shown — `5113977` |
| QA-0P-14 | minor | harness S4 | order not asserted | asserted; `unpriced` flag — `5113977` |
| QA-0P-15 | minor | harness env | denylist | allowlist + assertion — `5113977` |
| QA-0P-16 | minor | teardown | Windows tree kill | `taskkill /T /F` + port check — `5113977` |
| QA-0P-17 | minor | plan 0.P acceptance | vacuous check | deterministic isolated-host `check:` + manual live criterion (QA-0P-30) |
| QA-0P-18 | minor | docs | ids/targets misaligned; §2 / §0.11 step 5 named `tiers.json` | plan canonical, this file references it; §2 row and §0.11 step 5 amended; handover rewritten |
| QA-0P-19 | minor | harness S2b | variant-then-model order | `5113977` |
| QA-0P-20 | minor | harness S2 | agent switch tools unrecorded | S2-agent-native under native permissions (`d9e2358`) |
| QA-0P-21 | nit | harness | `clip()` truncated notes | `5113977` |
| QA-0P-22 | nit | this file | overstated harness description | reworded |
| QA-0P-23 | nit | this file | template-mismatch run unlogged | `run-log.md` |
| QA-0P-24 | nit | harness | `data[0]` fallback | exactly-one-child assertion — `5113977` |
| QA-0P-25 | nit | evidence | username path, provider list | redacted — `5113977` |

**Round 2** (`@heavy`, re-review of the fixes): 0 blocking, 0 critical, 3 major, 7 minor, 2 nit. All fixed in round 2.

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0P-26 | major | plan A4/A7, 3.1, 3.2 | deferred checks had no owner; docs come before 3.2 | A4 live check owned by checkpoint DF3 (before 3.1); Phase 3.2 scenario 7 (OpenAI Responses effort); §2 row allows `routing.classifier` at DF3 |
| QA-0P-27 | major | harness, docs | live gate also unlocked a paid generate | live generate branch removed; gate documented as read-only GETs — `d9e2358` |
| QA-0P-28 | major | plan §0.11 step 5, handover | still said "edit the active `tiers.json`" | step 5 amended to the override file; handover rewritten at 0.P close |
| QA-0P-29 | minor | S3/S6, A3 | condition for duplicates never set up; registry scope | S3b (two instances) and S6 counts (`d9e2358`); A3 states module scope for dedupe set and registry |
| QA-0P-30 | minor | plan acceptance; harness S4 | no `check:`; S4 failed when not live | `check:` line runs isolated spikes; S4 skips with a recorded reason — `d9e2358` |
| QA-0P-31 | minor | A7 | "cache preserved" unobserved | qualified as host intent; `default` → variant changes top-level `thinking` |
| QA-0P-32 | minor | A5 | `max_tokens` ignored without `limit.input` | `inputBudget = limit.input ?? (limit.context − limit.output)` |
| QA-0P-33 | minor | S2 / D12 | allow-all hid tool differences | S2-agent-native — `d9e2358`; A11 + handoff to 2.2 |
| QA-0P-34 | minor | A2 | "cheapest" contradicted by S4; "tiered" wrong | "cheapest" defined; examples corrected |
| QA-0P-35 | minor | A4 | "worked cold" overstated; resolution location | A4 + S5 row: resolves at the dispatching location; handoff to 1.2 |
| QA-0P-36 | nit | harness S1-deny | run-wide capture count | spike-scoped count — `d9e2358` |
| QA-0P-37 | nit | harness notes, this file, run-log | wording; row order | S6 "estimated", S4 "inferred" (`d9e2358`); "verbatim"/"all fixed in round 1" removed; run-log reordered |

**Round 3** (`@heavy`, re-review of the round-2 fixes): all 12 round-2 findings and the 5 round-1 partials resolved; new: 0 blocking, 0 critical, 3 major, 3 minor, 2 nit. Per §0.7 only the majors must be fixed; the minors and nits that are factual corrections to the plan were fixed anyway, the rest are accepted.

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0P-38 | major | plan DF3, A4, §2 | live classifier check picked the provider automatically, wrote the global override, never reverted, no owner consent | A13: the owner names the model or the check is skipped; one-shot with immediate restore of `routing.classifier`; DF3 text rewritten |
| QA-0P-39 | major | plan DF3 | check might never trigger (`[route …]` overrides rules); 1.5 s timeout; 3.1 not blocked | deterministic trigger (`/annotate-plan` on a two-step sample, one batched backend call), `timeoutMs: 10000` for the check, 3.1.1 blocked until `## DF3` holds the result or the skip line |
| QA-0P-40 | major | plan 1.2.4 | task text still said raw `/api/experimental/generate` | 1.2.4 now specifies `ctx.generate.text` (A4) with a fake `ctx.generate` in unit tests |
| QA-0P-41 | minor | plan 3.2 | "all six green"; write-set too narrow for scenario 7 | fixed: "1–6 green, 7 green or `unverifiable`"; write-set allows an OpenAI-Responses script mode |
| QA-0P-42 | minor | harness `:516`, `:520` | every acceptance run rewrites tracked evidence files with a new runId | accepted — QA round limit: the handover instructs `git checkout -- docs/qa/cost-aware-routing/spikes` after any re-run that is not an evidence run |
| QA-0P-43 | minor | handover, Handoffs | close-out steps, "to 3.1" handoff | fixed: handover close-out list and "to 3.1" handoff |
| QA-0P-44 | nit | harness `:877` | stale `service.json` with the live gate on throws instead of skipping | accepted — QA round limit (only reachable with the manual live opt-in) |
| QA-0P-45 | nit | plan A10, this file S5 row, A4 vs DF3 | wrong tiered-cost example; stale latencies; experimental wording mismatch | fixed: A10 example, S5 6/6 ms and 272 ms, A4/DF3 aligned |

**Round 3 re-review** of QA-0P-38/39/40 (`acf092b`): all three resolved; no new blocking/critical/major. Minors raised, accepted — QA round limit:

| Id | Sev. | Finding | Disposition |
|---|---|---|---|
| QA-0P-46 | minor | DF3 sample steps may score ≥ `minClassConfidence` on rules and skip the backend (fails safe: `host` stays experimental) | accepted — QA round limit; DF3 executor phrases the two sample steps without taxonomy keywords |
| QA-0P-47 | minor | `/annotate-plan` trigger may need the human to type it if no host command route exists | accepted — QA round limit; handover row "Liveness probe / slash commands" covers it |
| QA-0P-48 | minor | during the DF3 one-shot every session on the machine can call the `host` classifier | accepted — QA round limit; run the check with no other sessions active |
| QA-0P-49 | minor | 1.2 tests say "mocked HTTP" for `host`; `AbortController` may not cancel `ctx.generate.text` | accepted — QA round limit; handoff to 1.2 (race against a timer; fake `ctx.generate`) |

## Deferred by plan

- `tsx` absent → `routing:stats` invocation decided in Phase 1.3 (plan troubleshooting row).
- DF0 limits (no verdicts / false-refusal flags; zero-tool children write no scorecard) → measured from DF2 on by the decision log and outcome store (Phases 1.3, 2.1, 2.2).
- Real-credential `host` classifier path (A4) → checkpoint DF3.
- OpenAI Responses effort delivery (A7) → Phase 3.2 scenario 7.

## Handoffs

- **to 1.1** — 1.1.4: test that a change to the global override file is picked up by hot reload (A6). 1.1.6: runtime `.git` read only. Config validation must accept `routing.classifier` with `backend: "host"` + a catalog model (used at DF3).
- **to 1.2** — `host` backend via `ctx.generate.text`; the classifier model must resolve at the dispatching location; errors → `unknown` (A4); enforce `timeoutMs` by racing the call against a timer (an abandoned call may still complete and bill); unit tests use a fake `ctx.generate`, not mocked HTTP (QA-0P-49).
- **to 1.3** — `tsx` not installed; unpriced = empty or all-zero, all tiers; tiered price lookup (A1, A10).
- **to 1.4** — D2 snapshot pins the raw builder output (SHA-256 above) and the v2-adapted text; every live candidate compares in `costRatio` today (A1).
- **to 1.5** — D11 rule with `inputBudget` (A5, A10); rank of `default` (A9); variant catalogs differ per model; haiku variants are thinking budgets (A7).
- **to 2.1** — module-scope dedupe set and registry; single writer (A3).
- **to 2.2** — permission filter before any `enforce` swap; `needs` from evaluated permissions, not agent ids (A11).
- **to 2.4** — advisor: unpriced per A1; suggestions per A2.
- **to 3.1** — document `host` as *experimental* unless `dogfood.md` `## DF3` shows the live check passed (A4, A13); do not start 3.1.1 before `## DF3` holds the result or the skip line.
- **to 3.2** — effective-effort assertions (A7); scenario 7 (green or `unverifiable` with reason).

## Verdict

**PASS — open findings: 0** (no blocking/critical/major open; every round-1 and round-2 finding fixed; QA-0P-42, 44, 46–49 accepted under the round limit). Phase 0.P DoD: spike harness committed and green on the acceptance check (10 passed, 1 skipped); verdict per hypothesis written; scorecard directory and active config recorded; `car/main` and `D:\git\omr-car-main` exist; `dogfood.md` has `## DF0`; amendments A1–A13 in the plan.
