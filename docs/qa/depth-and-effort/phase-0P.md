# Phase 0.P — Execution pre-flight

Plan: the `de/main` copy `D:\git\omr-de-main\docs\plans\delegation-depth-and-effort-bump-plan.md`
(revision 4, amendments in §1.7). The untracked main-checkout copy is the unamended revision 3 (blob
`f6f69e1`), kept only for the 3.4.5 hash check. Integration branch `de/main`, worktree
`D:\git\omr-de-main`.

## Pre-flight

### 0.P.1 Baseline

| Item | Result |
|---|---|
| `git -C D:\git\opencode-model-router status --porcelain` | only `?? docs/plans/delegation-depth-and-effort-bump-handover.md` and `?? docs/plans/delegation-depth-and-effort-bump-plan.md` |
| `master` vs `origin/master` | both `46f443fa5fb73dab4b5b7fc8fde329062ed33493` |
| `package.json` version | `2.0.0` |
| `gh auth status` | logged in as `marco-jardim`, scopes `gist, read:org, repo, workflow` |
| node / npm | `v24.21.0` / `12.0.2` |
| Linear | **not used**: no `linear.app` URL and no Linear-like issue key in the repo or `.github` |
| `de/main` | created from `origin/master`; worktree `D:\git\omr-de-main`; plan and handover committed in `174505d` (blobs `f6f69e11c34d7ba79aa5d8ac87e3aa9dd334f6a9` plan, `1640b9c2d97821c228ac1fc0f0ffe90a566aab30` handover; both equal the main-checkout copies) |
| CI on `master` at `46f443f` | `Test` and `smoke-keyless` green |

Baseline in `D:\git\omr-de-main` (0.P.1.c):

| Command | Result |
|---|---|
| `npm ci` | exit 0 (350 packages; npm reports 1 high-severity advisory, pre-existing on `master`, see Deferred) |
| `npm run typecheck` | exit 0 |
| `npx vitest run --maxWorkers=2` | **101 files passed, 3 skipped; 3645 tests passed, 65 skipped** (211.5 s) |
| `npm run smoke:keyless` (v1 1.18.19 first on `PATH`, after `d8a9a42`) | **3 files, 9 tests passed** |
| `npm run smoke:v2` (`OPENCODE_V2_BIN` = OpenCode 2.0.22) | **1 file, 2 tests passed** |
| Orphan `node`/`opencode` processes matching `*omr-*` | none |

Local smoke environment (A10). The machine's `opencode` on `PATH` is the scoop OpenCode **2.0.22**
(`C:\Users\Marquinho\scoop\apps\opencode2\current\opencode.exe`). The keyless lane targets the CI pin
`opencode-ai@1.18.19`, installed privately (never globally):

```powershell
npm i --prefix C:\Users\Marquinho\AppData\Local\Temp\Claude\oc-v1 opencode-ai@1.18.19
# keyless lane (v1 native exe first on PATH, for this call only)
$env:PATH = "C:\Users\Marquinho\AppData\Local\Temp\Claude\oc-v1\node_modules\opencode-windows-x64\bin;" + $env:PATH ; npm run smoke:keyless
# v2 lane
$env:OPENCODE_V2_BIN = "C:\Users\Marquinho\scoop\apps\opencode2\current\opencode.exe" ; npm run smoke:v2
```

Before the fix, with v1 on `PATH`, 4 keyless tests failed (registration and subagent-tiers read the
developer's real `opencode-model-router.state.json`): the fixtures set only `HOME`, but
`src\router\config.ts:284` and ≈377–383 resolve the override and state files with `os.homedir()`,
which reads `USERPROFILE` on Windows. Fixed in `d8a9a42`
(`test(smoke): isolate USERPROFILE alongside HOME on Windows`).

### 0.P.2 Unknowns

- **a. Guard API.** `guardBeforeCall` (`src\guard\enforce.ts:77–121`) returns
  `BeforeResult { block; message?; mode; guard? }` (`:58–63`). Called at `src\index.ts:1201–1210`;
  on `res.block` it records `trajectoryStore.recordToolEvent(sid, { tool, readOnly, blocked: true,
  selfScript })` and throws `new Error(res.message)` (`:1214–1221`). Mode:
  `EnforcementMode = "off" | "advisory" | "enforced"` (`src\router\enforcement.ts:7`), resolved by
  `resolveEnforcementMode` from `enforcement.mode` (default `"advisory"`), the env gate
  (`MODEL_ROUTER_ENFORCE`: `"1"` enforced, `"0"` off) and `enforcement.perTier`
  (`src\router\enforcement.ts:16–46`). Bundled `tiers.json:4–6`: `"mode": "advisory"`. Advisory
  never blocks: it records the would-block and sets a pending note (`src\guard\enforce.ts:113–120`).
  `guardBeforeCall` also downgrades enforced → advisory for trivial sessions (`:88–94`).
  Order in the `task` before-hook today: verification `startDispatch` (`src\index.ts:1105–1121`) →
  prompt repair / `promptRefusal` throw (`:1128–1153`) → `guardBeforeCall` (`:1196–1221`).
- **b. `delegate` refusal form.** `execute(): Promise<string>`; every refusal and failure path
  **returns** a `[router] …` string (`src\index.ts` ≈853–915, catch at ≈914–915). The tool is only
  registered when `enableDelegateTool` is true (`:504`).
- **c. Trajectory store.** `trajectoryStore.recordToolEvent(sessionID, event)`
  (`src\telemetry\trajectory.ts:188–191`) increments `toolCallCount` for every event, blocked ones
  included (`:73–81`); `toolCallCount(sessionID)` (`:193–194`) is what the false-refusal detector
  reads for the child (`src\index.ts:1236–1245`). The after-hook records events only for
  `sessionStore.isSubagent(sid)` sessions (`:1262–1279`).
- **d. v2 bridge tests:** `D:\git\opencode-model-router\test\unit\v2-hooks.test.ts`.
- **e. Ladder callers:** only the `delegate` tool, `src\index.ts:880` (`nextAction`) and `:912`
  (`advance`). (`advance` in `src\verify\batch.ts` and `src\verify\wiring.ts` are unrelated locals.)
- **f. Grader parent.** `dispatchGrader(req, parentSessionID?, inFlight?)`
  (`src\verify\wiring.ts:1200–1239`). `delegate` path: `buildGateDeps(toolCtx?.sessionID, …)`
  (`src\index.ts:755`) → the caller (orchestrator) session. Native `task` path: gate deps built with
  `undefined` (`src\index.ts:1382`).
- **g. Preset table** (`tiers.json`; `activePreset: "anthropic"` at `:2`; family per
  `isClaudeModel` `src\router\protocol.ts:149–154`, `isOpenAIModel` `src\router\agent-options.ts`;
  adaptive-only list `src\router\protocol.ts:163–168`):

  | Preset | Tier | Model | Effort | Variant | Family | D7 bumpable | Bound |
  |---|---|---|---|---|---|---|---|
  | anthropic (active) | fast | anthropic/claude-sonnet-5-5 | low | low | claude | no (variant) | — |
  | anthropic (active) | medium | anthropic/claude-sonnet-5-5 | medium | medium | claude | no (variant) | — |
  | anthropic (active) | heavy | anthropic/claude-opus-5-5 | xhigh | xhigh | claude (adaptive-only) | no (variant) | — |
  | openai | fast / medium / heavy | gpt-6-luna-fast / gpt-6.1-sol-fast / gpt-6-astra-fast | — | — / xhigh / max | openai | no (no effort) | — |
  | github-copilot | fast / medium | claude-haiku-4.5 / claude-sonnet-5 | — | — | claude | no (no effort) | — |
  | github-copilot | heavy | claude-fable-5-1 | — | — | claude (adaptive-only) | no (no effort) | — |
  | google | all | gemini-* | — | — | other | no | — |
  | zai | fast / medium / heavy | glm-4.7 / glm-5.3 / glm-5.3 | — | — / high / max | other | no | — |
  | hybrid | fast / medium | gpt-6-luna-fast / gpt-6-astra-fast | — | medium / high | openai | no | — |
  | hybrid | heavy | anthropic/claude-opus-5-5 | xhigh | xhigh | claude (adaptive-only) | no (variant) | — |
  | fable-effort | fast | anthropic/claude-fable-5-1 | low | — | claude (adaptive-only) | **yes** | xhigh |
  | fable-effort | medium | anthropic/claude-fable-5-1 | high | — | claude (adaptive-only) | **yes** | xhigh |
  | fable-effort | heavy | anthropic/claude-fable-5-1 | xhigh | — | claude (adaptive-only) | no (base = bound) | xhigh |

  **Finding for 0.P.5:** the active preset has **zero** bumpable tiers; the bump is inert by default
  and applies to `fable-effort` and user-configured tiers. No bundled tier sets `thinking.budgetTokens`
  or `reasoning.effort`.
- **h. Producer id before prompt.** v1 native path: `session.create` → `registerProducer(sid)` →
  `session.prompt({ path: { id: producerSid } })` (`src\index.ts` ≈626–669). v2 `routerChildRunner`
  (`src\v2.ts:19` → `src\compat\v2-client.ts:60–135`): `onCreated(sessionID)` is awaited inside the
  native subagent's `progress` callback, which the native tool runs after creating the child and before
  prompting it (`v2-client.ts:97–108`). Cleanup: per attempt ≈833–848; outer `finally` disposes every
  producer (≈916–924).
- **i. Smoke harness.** No keyless smoke captures provider requests or scripts a tool call: they spawn
  real `opencode` (`debug agent`, `serve`) (`registration.smoke.test.ts:45,64`,
  `vitest.smoke.config.ts:17–20`, `deferred-catalog.smoke.test.ts:70,193`). `smoke:v2` runs
  `v2-registration.smoke.test.ts` with `OPENCODE_V2_BIN`; `smoke:v2:e2e` needs provider keys.
  Therefore Spike B built its own capturing rig (below).

### 0.P.3 Spike A — v2 refusal path

**Superseded by Spike A2 (host level, below).** The original bridge-only run is kept for the record;
QA-0.P-1 showed it cannot prove host behaviour (it supplied the caller id itself).

#### Spike A2 — host level (authoritative)

Rig: `C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\spike-a2\` (sources `rig.mjs`,
`observer-v1.mjs`, `observer-v2\`, `router-copy\` with provenance hashes, `captures.jsonl`,
`scripted-responses.jsonl`, `v1-hooks.jsonl`, `v2-hooks.jsonl`, `runs.jsonl`, `report.mjs`,
`cleanup.json`; section "Spike A2" of `..\REPORT.md`). Real OpenCode 1.18.19 and 2.0.22; a keyless
Anthropic-Messages SSE stub scripts the model's tool calls; the observer plugin's before-hook throws
`DEPTH-REFUSAL-SENTINEL` for a marked dispatch (v2: a native `{ id, setup }` plugin with
`ctx.tool.hook("execute.before")`, not a bridge mock).

| Scenario | v1 1.18.19 | v2 2.0.22 |
|---|---|---|
| R1 foreground refused | before-hook `sessionID` = root; next request carries `tool_result` `is_error: true`, content `DEPTH-REFUSAL-SENTINEL`; final `ok`; exit 0 | same (content `{"error":{"type":"unknown","message":"DEPTH-REFUSAL-SENTINEL"},…}`) |
| R2 background refused | not applicable: v1 `task` has no `background` parameter | `background: true` seen; caller = root; `is_error: true`; final `ok`; exit 0 |
| R3 resume refused | same root; `task_id` = existing child; `is_error: true`; final `ok`; exit 0 | same, native `sessionID` arg |
| R4 child dispatches | caller = child, `parentID` = root, refused (needs `general.permission.task: "allow"`: v1's default `general` has no `task` tool) | caller = child, `parentID` = root, refused (default `general`) |
| R5 real router `delegate` producer | `chat.params`: `agent: "fast"`, `model: { providerID: "anthropic", id: "claude-sonnet-4-5" }` (no `modelID`) | `context`: `agent: "fast"`, `model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "default" }` |

R5 loaded the real router from a hashed copy of the worktree's `src\` (the package has no build step;
`main` is `./src/index.ts`), with `delegate` enabled, enforcement off and verification `never`.

#### Original bridge-level run

Scratch test `D:\git\omr-de-main\test\scratch\spike-a.test.ts` (deleted; never committed) registered
the real `registerV2Hooks` with `createV2Runtime(ctx).withToolContext` and a legacy
`"tool.execute.before"` that throws `DEPTH-REFUSAL-SENTINEL`, then drove the captured `execute.before`
with `subagent` events: foreground, `background: true`, and resume (`sessionID: "ses_child"`).
`npx vitest run test/scratch/spike-a.test.ts --maxWorkers=2` → 3/3 passed.

- The handler rejects with the **same** `Error` object in all three cases; zero `unhandledRejection`
  events. No catch surrounds the legacy call (`src\compat\v2-hooks.ts:272–290`; `within` →
  `withToolContext` uses `finally` only, `src\compat\v2-client.ts:149–161`).
- The legacy hook received `input.sessionID = "ses_caller"` in all three cases; the resume target
  appears only in `output.args.sessionID`/`task_id`.
- One `execute.before` registration; no background or resume branch skips it. The router's own v2
  `childRunner` calls the native `subagent` tool's `execute` directly (`v2-client.ts:74–117`), which
  is covered by the `delegate` tool's own guard (D3), so it is not a bypass.
- The installed v2 types (`node_modules\@opencode\plugin\dist\promise\tool.d.ts:29–37`) give the
  event shape but no documented throw contract. How the host renders the rejection is the mechanism
  the existing `enforced` guard already relies on for blocking on v2.

### 0.P.4 Spike B — per-session effort via `chat.params`

Rig outside the repo: `C:\Users\Marquinho\AppData\Local\Temp\Claude\spike-b\` (`REPORT.md`, sources,
`captures.jsonl`, `isolation-captures.jsonl`, `extension-captures.jsonl`, hook logs, cleanup proofs).
Real OpenCode **1.18.19** and **2.0.22**, isolated `HOME`/`USERPROFILE`/`XDG_*`/`APPDATA`, fake keys,
providers `openai`/`anthropic` pointed at a loopback stub that records each request body and answers
400. Models `openai/gpt-5`, `anthropic/claude-sonnet-4-5`, plus adaptive-only `claude-fable-5` and
`claude-opus-4-7` controls.

Primary scenarios (wire field: OpenAI `reasoning.effort`, Claude `output_config.effort`):

| Scenario | v1 OpenAI | v2 OpenAI | v1 Claude | v2 Claude |
|---|---|---|---|---|
| S1 baseline | medium | medium | absent | absent |
| S2 hook writes `reasoning_effort`/`effort` = high | **medium (dropped)** | **medium (dropped)** | high | high |
| S3 agent registered with the same keys | **medium (dropped)** | high (bridge translates) | high | high |
| S4 clean session (a separate `opencode run`) | medium | medium | absent | absent |
| S5 agent low + hook high | **medium** | **low** | high | high |
| hook writes native `reasoningEffort` = high | high | high | — | — |
| agent native `reasoningEffort` low + hook native high | high | high | — | — |

Hook shapes: v1 `chat.params` `output` keys `temperature, topP, topK, maxOutputTokens, options`; v2
`context` event keys `sessionID, model, system, messages, options, agent, tools`, and the bridge passes
`event.options` itself as the legacy `output`. Same-process isolation comes from `isolation.mjs` (one
`opencode serve` per version, pids 65588 and 54512, distinct sessions): the override reaches only the
marked session, for Claude `effort` and for OpenAI native `reasoningEffort`. Non-effort payload
equality: S1 vs S2 holds for Claude; for OpenAI S1 vs S2 compares two unchanged requests (the
snake-case key was dropped), so the meaningful OpenAI comparisons are native-key hook vs
agent-registered (extension cases `a` vs `d`) and CLEAN vs CAMEL in the isolation run, both equal
outside `reasoning` on v1 and v2 (checked by the 0.P QA reviewer). The v1 and v2 isolation hook logs
mix three runs; only the final run maps to `isolation-run.log`.

Extension — native keys, agent-registered (`v1 | v2` wire subtrees):

| Registered options | v1 | v2 |
|---|---|---|
| `reasoningEffort: "high"` | `reasoning.effort: high` | same |
| `reasoning_summary: "detailed"` | `reasoning.summary: auto` (**dropped**) | `detailed` (bridge) |
| `reasoningSummary: "detailed"` | `detailed` | `detailed` |
| `budget_tokens: 8000` | **absent (dropped)** | `thinking.budget_tokens: 8000` (bridge) |
| `thinking: { type: "enabled", budgetTokens: 8000 }` | `thinking.budget_tokens: 8000` | same |
| `effort: "high"` + `thinking` | both sent | both sent |
| `effort: "xhigh"` (claude-fable-5, opus-4-7) | `output_config.effort: xhigh` | same |

Title generation: v1 calls `chat.params` for the title with the **same** `sessionID`
(`agent: "title"`, `model: openai/gpt-5.4-nano`); v2 uses a separate `title` hook (no `agent`), which
the bridge does not forward.

Fallback facts (corrected per QA-0.P-9): the legacy SDK `SessionPromptData` has no `variant`
(`node_modules\@opencode-ai\sdk\dist\gen\types.gen.d.ts:2244–2269`), but the v1 host's HTTP API does
honour a per-message `variant` (isolation `v1-openai-same-VARIANT` sent `reasoning.effort: high`); the
`body.variant?` at `…\@opencode-ai\sdk\dist\v2\gen\types.gen.d.ts:8358–8383` is the v1 host's newer
SDK, not OpenCode 2, which has no per-message variant. Catalog variants: GPT-5
`minimal, low, medium, high`; Claude Sonnet 4.5 `high, max` (thinking budgets 16000/31999, not effort).

## Implementation notes

0.P.5 verdicts (orchestrator, heavy tier) are written into the plan as §1.7 A1–A10 and the §2
updates. Summary:

- **D9:** primary mechanism confirmed on v1 and v2, **with provider-native keys** (`effort`,
  `reasoningEffort`), a v1/v2 target seam (`output.options` vs flat `event.options`) and a
  producer-only gate on agent + model identity (A3).
- **D6 (owner decision 2026-10-05, follow D6 literally):** the depth guard uses the existing mode
  resolution; the bundled default `advisory` warns instead of blocking. G1 and D12.1 amended (A1).
- **Pre-existing bug (owner decision 2026-10-05, fix in 1.3):** `buildAgentOptions` emits snake-case
  keys that OpenCode v1 drops, so OpenAI `effort`/`reasoning.*` and Claude `thinking.budgetTokens`
  never reach the provider on v1. 1.3.2b switches to native keys; 2.3 adjusts the v2 bridge (A4).
- **D4, D3, D10, M5 timing:** confirmed against the code (A2, A6–A8).
- **D7 reach:** zero bumpable tiers in the active preset; not a stop (A5).
- **§2:** placeholder resolved (`test\unit\v2-hooks.test.ts`); 1.3 gains
  `test\integration\fable-effort-preset.test.ts` and `test\smoke\registration.smoke.test.ts`; 3.1
  gains `docs\PER_TURN_EFFORT.md` and `docs\OPENCODE_V2.md`.

Pre-flight fix applied: `d8a9a42` (smoke Windows isolation).

## Findings

Round 1 (heavy QA, adversarial). Resolution commit: the commit that adds this table (plan revision 4).

| Id | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0.P-1 | critical | Spike A, A9 | Bridge-only spike could not prove host rendering, background/resume hook firing or caller id (circular) | Spike A2 on real 1.18.19/2.0.22 with a scripted stub; A9 rewritten; 3.2.1(c)/(d) mandatory |
| QA-0.P-2 | major | A1 banner channel | `setPendingNote` is one slot, overwritten, `isSubagent`-gated, lost when the after-hook does not run | A1: own per-call channel (`delegate` return string; `task` by `callID` before the `isSubagent` branch; v2 background in the bridge; dropped on failure) + tests |
| QA-0.P-3 | major | plan sections assuming block-by-default | 2.1.1, 2.3.6, 3.1.4, 3.2.1(c), M2, §1.6, §5, scope line | A1 "Superseded text" list; 2.1.1 signature and `DepthGuardResult`; 3.1.4 edited directly |
| QA-0.P-4 | major | A3 seam | One legacy `chat.params` handler gets `event.options` on v2; v1 write would nest `options` | A3: explicit `routerHost: "v2"` from `src\v2.ts`; flat on v2, `output.options` on v1; no creation; bridge test |
| QA-0.P-5 | major | A4 | v1 behaviour change not recorded | A4 risk list, grader-temperature/thinking check, CHANGELOG flag (3.1.4) |
| QA-0.P-6 | major | A7, 2.3.3 | v2 grader creation point (`onCreated`) missed | A7 amended; both creation points; v2 grader test |
| QA-0.P-7 | major | A3 gate | v2 producer identity unobserved | Spike A2 R5 observed it on both hosts; host-level proof added to 2.3 DoD |
| QA-0.P-8 | minor | preset table | zai medium variant; adaptive-only marks | Table corrected |
| QA-0.P-9 | minor | Spike B record | S4 label, OpenAI comparison, fallback facts, mixed logs | Record corrected; A3 fallback facts corrected |
| QA-0.P-10 | minor | A1 trivial | Rationale weak; tier source unpinned | Orchestrator decision with the bypass rationale; tier = `sessionStore.getTier(callerSid)` |
| QA-0.P-11 | minor | A1 banner text | After-the-fact banner invited redoing finished work | Reworded |
| QA-0.P-12 | minor | before-hook order, `/bypass` | Order incomplete; `/bypass` disables the guard | A11: order corrected; depth guard first; `/bypass` decision documented under D11 |
| QA-0.P-13 | minor | refs | `de/wave-1-base` missing | Tagged after QA closes (recorded under Verdict) |
| QA-0.P-14 | minor | run log, plan header, §7 | Missing entries | Run log completed; plan revision 4 and §7 row |
| QA-0.P-15 | nit | smoke isolation | Other env vars inherited | A12: 1.3 hardens both smoke files |
| QA-0.P-16 | nit | A5 | Captured model ids not named | A5 names `claude-fable-5`, `claude-opus-4-7` |
| QA-0.P-17 | nit | `src\router\config.ts:40` | Comment names `reasoning_effort` | Handoff to 1.1 (A4) |

Round 2 (re-review of `d17fb66`; the reviewer checked the Spike A2 raw captures, hook logs, run
summaries and stdout, and confirmed R1–R5). All fixed in the commit that adds this table.

| Id | Severity | Where | Finding | Resolution |
|---|---|---|---|---|
| QA-0.P-R2-1 | major | §1.4, D1, 1.1.3, 1.1 acceptance | Still described blocking as the default meaning; 1.1 would document it | Amended in place; added to A1's superseded list |
| QA-0.P-R2-2 | minor | A1 `task` banner key | `callID` alone can collide; no-`callID` case unspecified | Key `${sessionID}:${callID}`; no `callID` → no banner, one warning |
| QA-0.P-R2-3 | minor | A1 v2 delivery | Contradiction for non-completed results; no precedent; double delivery risk | Failed/non-completed → no banner; v2: symbol on `output`, bridge map by `event.id`, sole deliverer; no-double-delivery assertion |
| QA-0.P-R2-4 | minor | A3 seam typing | `RouterPluginInput` lives in an unowned file | `src\compat\child-session.ts` (type only) added to 2.3's write-set |
| QA-0.P-R2-5 | minor | A4 grader bullet | Graders never get tier options (no `agent`), so the test was moot | Bullet replaced with the fact and evidence; test dropped |
| QA-0.P-R2-6 | minor | A9 | Router-bridge async throw and v2 `running` banner not observed on a host | Made explicit requirements of 3.2.1(c) |
| QA-0.P-R2-7 | minor | 2.3 gate, 3.2.1, §4.2 | Gate relied on an unversioned temp rig; CI cannot run v2 | 2.3 uses a hashed copy; 3.2 versions `test\smoke\helpers\scripted-provider.ts`; v1 legs in CI via `smoke:keyless`; v2 legs local evidence; §4.2 amended |
| QA-0.P-R2-8 | minor | A11 `/bypass` | `delegate.execute` does not check `bypassed` | 2.3.2.d checks it too; 2.3.6 tests both paths |
| QA-0.P-R2-9 | nit | A7 | Native-path grader recorded at 1 though the caller is known | Pass `orchestratorSessionID` as creator |
| QA-0.P-R2-10 | nit | A12 | Isolated cache forces models.dev fetches | `OPENCODE_DISABLE_MODELS_FETCH=true`; run on Windows and CI before merge |
| QA-0.P-R2-11 | nit | A3 gate rationale | Title leak scope overstated | Rationale scoped |
| QA-0.P-R2-12 | nit | §1.7 order | A10 out of order | Note added (numbering is the reference) |

Per §0.7, no further review round: the round-2 fixes are text amendments, and the only major one
(R2-1) is a direct in-place amendment checked by the orchestrator.

## Deferred by plan

- Docs that name the snake-case option keys (`README.md:282,483,491`,
  `docs\CONFIG_REFERENCE.md:606,626,632,652,687,697,698`, `docs\PER_TURN_EFFORT.md:94,95,109,137`,
  `docs\OPENCODE_V2.md:48,49`) → Phase 3.1.
- v2 bridge registration translation precedence (`src\compat\v2-hooks.ts:125–135`) → Phase 2.3.
- The npm advisory reported by `npm ci` (1 high) and Dependabot alert #2 on `master` are pre-existing
  and unrelated to this plan; dependency changes are out of scope (lockfile owner is 3.4, and the
  previous handover forbids merging dependency bumps during execution).

## Handoffs

- **To 1.1:** the `reasoning_effort` comment at `src\router\config.ts:40` (A4, QA-0.P-17).
- **To 1.3:** A4 (native keys in `buildAgentOptions`, test updates, grader-temperature/thinking check),
  A12 (smoke isolation hardening).
- **To 2.1:** A1 (mode per caller, `DepthGuardResult` with `banner`, banner text, no trivial
  downgrade, both modes in tests).
- **To 2.2:** A3 (target options object, no creation, producer-only gate, native keys).
- **To 2.3:** A1 per-call banner channel and tests, A2 recording, A3 host seam (`src\v2.ts`) and bridge
  test, A3 host-level proof (Spike A2 rig), A4 bridge translation, A7 both grader creation points, A8
  explicit clear in the outer `finally`, A11 order and `/bypass`.
- **To 3.1:** A1 documentation of advisory vs enforced, A4 `Fixed` entry (v1 behaviour change) and
  key-name docs, A5 preset table, A11 `/bypass` under D11.
- **To 3.2:** 3.2.1(c)/(d) mandatory with the scripted stub; both modes.

## Verdict

Open findings: **0** (no blocking, critical or major open; every round-1 and round-2 finding fixed).
`de/wave-1-base` is tagged on the commit that adds this verdict (sha recorded in `run-log.md`).
