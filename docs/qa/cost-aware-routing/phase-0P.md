# Phase 0.P — Execution pre-flight (cost-aware routing engine, #74)

> Worktree `D:\git\omr-car-p0p` (branch `car/p0p`, created from `car/main` @ `8e7a890`). Base directory `D:\git\opencode-model-router`.
> Spike harness: `D:\git\opencode-model-router\test\smoke\routing-spikes.smoke.test.ts` — gated by `RUN_OC_SMOKE_V2_SPIKES=1` (isolated host) and additionally `RUN_OC_SPIKE_LIVE_CATALOG=1` (read-only reads of the user's running service); skipped otherwise.
> Evidence: `D:\git\opencode-model-router\docs\qa\cost-aware-routing\spikes\{S1,S1-deny,S2,S2b,S3,S4,S5,S6,cleanup}.json`, all from **one run** (`runId 697eba92-…`, `recordedAt` 2026-10-06T04:52:06Z–04:52:16Z, harness blob `ea0ae580be66a9f6809a7ac23fa0641783d7930e`, committed in `5113977`).

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

Harness: one isolated `opencode serve` (private HOME/XDG, **allowlisted environment** — no provider credentials reach it, asserted), a scripted Anthropic-Messages provider, and a probe plugin that rewrites `subagent` input in `tool.hook("execute.before")`, records `ctx.event.subscribe` deliveries (tagged by plugin instance) and tags provider requests. Child sessions are read back through the host client (`session.get` / `session.list({parentID})` / `session.context`, `model.list`); S3 reads the probe plugin's subscription log by design (that is the hypothesis); the child id is taken from the tool result and the dispatch fails unless exactly one child is identified. Each spike deletes its sessions; the `cleanup` test asserts 0 sessions remain, kills the host tree with `taskkill /T /F` and asserts the port is closed.

Run: `npx cross-env RUN_OC_SMOKE_V2_SPIKES=1 RUN_OC_SPIKE_LIVE_CATALOG=1 npx vitest run --config vitest.smoke.config.ts test/smoke/routing-spikes.smoke.test.ts --reporter=verbose` → `Tests 9 passed (9)`, 12.73 s. Without the env vars: `Tests 9 skipped (9)`.

| Spike | Observed (host state / wire) | Verdict |
|---|---|---|
| **S1** swapped `agent`+`model` in `execute.before` | hook: `agent general→explore`, `model anthropic/claude-sonnet-5-5#max`; stored child: `agent "explore"`, model `{anthropic, claude-sonnet-5-5, variant "max"}`; wire effort `max` | **confirmed** (scripted provider, allow-all permissions) |
| **S1-deny** same swap with `{subagent, explore, deny}` for the parent | rewrite applied, then the host refused: `Subagent denied: explore` (`Permission.BlockedError`); no `explore` child; control `general` dispatch completed | **host re-checks permissions after the rewrite** → A11 |
| **S2** resume with `sessionID` + higher variant; agent switch on resume | stored variant `low→max` on the same child; message count 3→7→11; resume with `agent: explore` → stored agent `general→explore`, model unchanged. Wire: top-level effort unchanged, new effort in an in-band `{"role":"system","content":[],"output_config":{"effort":…}}` message (`session/runner/to-llm-message.ts` `modelSwitched()`). Both agents received the same 12 tools under allow-all | **confirmed with caveat**: in-band delivery is the host's request building; acceptance by the real provider API is unverified |
| **S2b** model switch on resume; mixed sequences | `sonnet#low → opus#low` on resume: wire model `claude-opus-5-5`; `→ opus#high`: in-band `high`; model+variant together: top-level `high`; fresh child at `#high`: top-level `high`; **A#low → A#high → B#xhigh**: req 3 `claude-opus-5-5`, top-level `xhigh`, no new in-band message; **no variant**: stored `variant "default"`, no effort sent (top-level or in-band), resume to `#high` → in-band `high`; **`claude-haiku-4-5` high→max**: no `output_config.effort` at all, no in-band message, `thinking.budget_tokens` `16000 → 31999` (top level) | **confirmed with caveats** → A7, A9 |
| **S3** `session.step.ended` for children reaches the plugin | raw child events 11 = deduped 11; `session.step.ended` raw 1 = deduped 1; one plugin instance; `evt_10f8e0e3a0010lD7FQAiRRfDmO` at the isolated project location; `cost 0.01073`, `tokens {input 5340, output 5, reasoning 0, cache {read 0, write 0}}` (= 5340×2e-6 + 5×1e-5 at the isolated catalog price) | **confirmed**. Multi-instance duplicate delivery was **not observed** in the recorded run (an earlier unrecorded run suggested it) → A3 is a design guard, not a finding |
| **S4** catalog variants/cost/context (live service, read-only) | read with explicit location `D:\git\opencode-model-router` (already live); live locations 13 before = 13 after (unchanged, asserted). `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`: variants `low, medium, high, xhigh, max`, one cost entry with **every field 0**, context 1 000 000; `anthropic/claude-haiku-4-5`: `high, max`, all-zero cost, context 200 000; `openai/gpt-6-luna`: `none, low, medium, high, xhigh, max`, cost `[]`, context 400 000 / input 272 000; **`openai/gpt-6-luna-fast`** (the live @fast model): same variants, cost `[]`, context 400 000 / input 272 000 / output 128 000; `opencode/deepseek-v4.1-flash` absent, `opencode-go/deepseek-v4.1-flash` present (`low, high, max`, input 0.15 / output 0.6, tiered entries). Every variant list is in host effort order (asserted). Unpriced: all five `anthropic`/`openai` models above | **confirmed with caveats** → A1, A2, A10 |
| **S5** `generate` with explicit `model` | **plugin path** `ctx.generate.text({prompt, model})` from the probe plugin: succeeded cold (7 ms), warm 9 / 6 ms; did not make the base location live. **Raw route** `POST /api/experimental/generate`: cold 400 `Model unavailable`; immediate retry 400; retry after 261 ms without any catalog read 200 → the 400 is lazy base-location initialisation, time-based. **Live credentials**: skipped by design — the base location of the live service was not live, and a call would start a plugin instance there | **confirmed for the plugin client** (isolated host); **real-credential path unverified** → A4 |
| **S6** switch to a smaller context, oversize prompt | alias `anthropic/spike-small` (`limit.context` 12 000), 72 021-char prompt: host ran auto compaction (`session.compaction.started/ended`, `reason: "auto"`) before the primary request; the primary request still exceeded the limit (≈23 000 tokens **estimated by the scripted provider** from body length, not a host count) because the oversize incoming message is kept as recent context; child finished. The scripted provider never returns an overflow error, so the error branch was not observable | **confirmed** (the hypothesis "compacts or errors predictably" holds: it compacts) → A5 |
| **S7** code liveness | see 0.P.7 | **disproven** → A8 |

## Implementation notes

The amendments are recorded verbatim in the plan, §1.5 "Amended during implementation"; ids and targets are identical in both places.

- **A1 → D5/D6.** *Unpriced* = `cost` empty, or every field of every cost entry (all tiers) is 0. Observed: `anthropic/claude-sonnet-5-5`, `claude-opus-5-5`, `claude-haiku-4-5` (all-zero), `openai/gpt-6-luna`, `openai/gpt-6-luna-fast` (empty). Their step costs will be 0 (inference from the host's catalog-price computation seen in S3; not measured on the live host) and are stored as `null`. **Consequence for the dogfood:** every tier model of the live `hybrid-2` preset is unpriced, so DF1–DF5 decisions and savings are in `costRatio` units, never USD.
- **A2 → F4/2.4.** Suggestions come from the live catalog; the cheapest priced tool-capable model here is `opencode-go/deepseek-v4.1-flash`. Variant sets differ per model.
- **A3 → M6/2.1.** Design guard: ingestion dedupes `session.step.ended` by event id **at module (process) scope** and only records events whose session is in the dispatch registry; the outcome store has a single writer per process.
- **A4 → M2 `host` backend.** The backend uses the plugin client `ctx.generate.text({prompt, model})` (worked cold on the isolated host). It treats any error — including `Model unavailable` and a credentials error such as `Generation credentials are unavailable` — as `unknown` within `timeoutMs`, no retry loop; the `openai-compatible` backend remains the alternative. The real-credential path is verified in Phase 3.2 (live smoke) before `host` is documented as supported.
- **A5 → D11.** Resume when `lastStepTokens + estimatedTokens(nextPrompt) < sessionReuse.maxContextFraction × (limit.input ?? limit.context)` of the **next** model; otherwise fresh. `estimatedTokens` = chars/4 of the forcing message plus the dispatch prompt. (Replaces the earlier `min(current, next)` wording.)
- **A6 → §0.11 / §2.** Checkpoints edit `routing.*` in `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc`, not the bundled `tiers.json` (base checkout, §0.6.8; would also block `--ff-only` syncs). Phase 1.1.4 proves the hot-reload path re-reads that layer.
- **A7 → D10 / 3.2.** Variant effort delivery depends on the provider route: for the owner's `claude-sonnet-5-5`/`claude-opus-5-5` on Anthropic Messages the host sends a same-model variant change in-band and keeps the top-level effort (prompt cache preserved); for `claude-haiku-4-5` the variant maps to `thinking.budget_tokens` at the top level (cache prefix changes); the OpenAI Responses route (live @fast) was not exercised — host source gates in-band updates on model support. Provider acceptance of in-band effort is unverified. Tests assert the *effective* effort (last in-band value, else top level, else thinking budget).
- **A8 → §0.11.** Plugin code is loaded once per process; each code sync (DF1–DF4) requires a host restart.
- **A9 → D10/1.5.** A child dispatched without a variant is stored as `variant "default"`, which is not in `variants[]`, and no effort is sent. Phase 1.5.1 defines the rank of `default` (constraint: the ladder never emits a variant absent from `variants[]`; a `default` rung's first variant step must be a listed variant).
- **A10 → D5/D11.** `cost[]` may hold context-tiered entries (`tier: {type: "context", size: 272000}`): price lookup picks the entry by input size. Context checks use `limit.input ?? limit.context`.
- **A11 → D9/D12.** The host re-checks permissions after `execute.before` rewrites `agent` (S1-deny: `Subagent denied: explore`). `enforce` must apply the permission filter **before** swapping; a swap to a denied agent would make the dispatch fail instead of falling back.
- **A12 → §0.6.8.** Phase 0.P work lives in `D:\git\omr-car-p0p`, merges into `car/main`, and `master` is fast-forwarded to `car/main` (docs and a gated smoke test only; no plugin code; no restart). This satisfies the 0.P write-set note "Committed on `master`".
- **0.P.4 executor.** Verdicts issued by the orchestrator (Opus) per router rule 9; producer (`@medium` harness) ≠ judge. Phase QA is a separate `@heavy` dispatch.

## Findings

QA round 1 (`@heavy`, adversarial): 0 blocking, 1 critical, 8 major, 11 minor, 5 nit. All fixed in round 1.

| Id | Sev. | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0P-1 | critical | harness S5 | S5 used the raw HTTP route, not the plugin client | probe calls `ctx.generate.text`; raw route kept as secondary; live call gated and skipped when it would start a location — `5113977`; A4 rewritten |
| QA-0P-2 | major | harness S4 | live read not opt-in; could start a location | `RUN_OC_SPIKE_LIVE_CATALOG=1`; explicit already-live location; before/after location set asserted unchanged — `5113977` |
| QA-0P-3 | major | S3 / A3 | duplicate delivery unrecorded; per-instance dedupe insufficient | raw vs deduped counts + location + instance recorded (`5113977`); A3 rewritten (process-scope dedupe, registry filter, single writer) |
| QA-0P-4 | major | S1 | permission re-check after rewrite untested | `S1-deny` added — host refuses (`5113977`); A11 |
| QA-0P-5 | major | A7 | in-band effort generalised beyond evidence | haiku case added (`5113977`); A7 rewritten per route |
| QA-0P-6 | major | A5 | `min()` rule not derived from S6 | S6 verdict "confirmed"; A5 rewritten (next-prompt estimate, next model's limit) |
| QA-0P-7 | major | — | `default` variant missing | no-variant case recorded (`5113977`); A9 |
| QA-0P-8 | major | S4 / dogfood | live @fast model unchecked; dogfood unit unstated | `gpt-6-luna-fast` recorded (unpriced) (`5113977`); A1 + `dogfood.md` state `costRatio` units |
| QA-0P-9 | major | `dogfood.md` | zero-tool contradiction unexplained | scorecards are written only with guard state (`src\index.ts:1710–1713`); row renamed, bias stated |
| QA-0P-10 | minor | A1 | inference stated as fact; tiered cost and `limit.input` missing | A1 wording; A10 |
| QA-0P-11 | minor | evidence | evidence from two runs | single run, `runId` + harness blob in every file — `5113977` |
| QA-0P-12 | minor | harness S3 | `waitFor` returned on `[]` | fixed — `5113977` |
| QA-0P-13 | minor | harness S5 | "catalog read fixes it" unproven | retry without catalog read recorded: time-based lazy init — `5113977` |
| QA-0P-14 | minor | harness S4 | order not asserted; empty cost accepted | order asserted; `unpriced` flag — `5113977` |
| QA-0P-15 | minor | harness env | denylist let credentials through | allowlist + assertion — `5113977` |
| QA-0P-16 | minor | harness teardown | `child.kill()` leaves the tree on Windows | `taskkill /T /F` + port-closed assertion — `5113977` |
| QA-0P-17 | minor | plan 0.P acceptance | check command could not exercise the spikes | plan acceptance block amended |
| QA-0P-18 | minor | docs | amendment ids/targets misaligned; §2 still named `tiers.json` | ids aligned (A1–A12 identical in plan and here); §2 row amended |
| QA-0P-19 | minor | harness S2b | variant-then-model order untested | case added and asserted — `5113977` |
| QA-0P-20 | minor | harness S2 | agent switch tool set unrecorded | tools per request recorded — `5113977` |
| QA-0P-21 | nit | harness | `clip()` truncated notes | only `observed` clipped — `5113977` |
| QA-0P-22 | nit | this file | "never the hook's own variables" overstated | harness description reworded |
| QA-0P-23 | nit | this file | template-mismatch run unlogged | logged in `run-log.md` |
| QA-0P-24 | nit | harness | `data[0]` child fallback | exactly-one-child assertion — `5113977` |
| QA-0P-25 | nit | evidence | username path and provider list exposed | redacted (`<home>`, `<user>`, relevant providers only) — `5113977` |

## Deferred by plan

- `tsx` absent → `routing:stats` invocation decided in Phase 1.3 (plan troubleshooting row).
- DF0 limits (no verdicts / false-refusal flags; zero-tool children write no scorecard) → measured from DF2 on by the decision log and outcome store (Phases 1.3, 2.1, 2.2).
- Real-credential `generate` path (A4) → Phase 3.2 live smoke.
- OpenAI Responses effort delivery for the live @fast model (A7) → Phase 3.2.

## Handoffs

- **to 1.1** — 1.1.4: test that a change to the global override file is picked up by hot reload (A6). 1.1.6: runtime `.git` read only.
- **to 1.2** — `host` backend via `ctx.generate.text`, errors → `unknown` (A4).
- **to 1.3** — `tsx` not installed; unpriced = empty or all-zero, all tiers; tiered price lookup (A1, A10).
- **to 1.4** — D2 snapshot pins the raw builder output (SHA-256 above) and the v2-adapted text; kernel unit = `costRatio` for every live candidate today (A1).
- **to 1.5** — D11 formula (A5, A10); rank of `default` (A9); variant catalogs differ per model; haiku variants are thinking budgets (A7).
- **to 2.1** — process-scope dedupe, registry filter, single writer (A3).
- **to 2.2** — permission filter before any `enforce` swap (A11).
- **to 2.4** — advisor: unpriced per A1; suggestion from the live catalog (A2).
- **to 3.2** — effective-effort assertions (A7); live `generate` credential check (A4); OpenAI route effort check (A7).

## Verdict

_Pending QA round 2._
