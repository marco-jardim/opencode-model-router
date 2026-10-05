# Phase 3.1: docs, ADR, changelog. QA review

Branch `de/p31` (worktree `D:\git\omr-de-p31`), reviewed range `origin/de/main..aa1dee6`:
`009754e` (README), `474b0df` (CHANGELOG), `d22dd5e` (CONFIG_REFERENCE), `6b72ec5` (PER_TURN_EFFORT),
`bba8ad7` (OPENCODE_V2), `d1521a9` (ADR 0004), `aa1dee6` (plans index). Issues #66, #67.
Reviewer: adversarial senior QA (`[tier:heavy]`, CAP:none). The reviewer did not write these docs.
Reviewed against: the shipped code in `src/` and `tiers.json` at `aa1dee6` (unchanged since `de/main`),
plan §1.4, §1.7 A1–A15 and Phase 3.1 (`:1383–1420`), and every "To 3.1" handoff in
`docs/qa/depth-and-effort/phase-*.md` (A15).

## Pre-flight

| Check | Result |
|---|---|
| Worktree base | `de/p31` was created from `de/wave-3-base` = `183b0dd`; `origin/de/main` is also `183b0dd`, and `git log origin/de/main..HEAD` lists exactly the seven docs commits above. |
| Capped full suite | Run by the orchestrator on the identical source tree on `de/main` `45b40f9`: **108 files passed / 3 skipped, 9084 tests passed / 65 skipped**. `183b0dd` adds only `docs/qa`, and the seven 3.1 commits touch only docs. The suite was not re-run in this review (dispatch rule). |
| docs-drift | `npx vitest run test/unit/docs-drift.test.ts --maxWorkers=50%` at `aa1dee6`: **1 file, 6/6 passed**. |
| D5 / A1 texts | A temporary script compared every doc copy with `depthLimitMessage` / `depthAdvisoryBanner` (`src/router/depth-guard.ts:32–38`), after normalising `${d}` to `${depth}`. `docs/CONFIG_REFERENCE.md:187` (A1), `:193` (D5), and ADR `:86` (D5), `:109` (A1) are **byte-exact**. The script was deleted afterwards. |
| Relative links | A temporary checker resolved all 54 relative links in the seven files, including GitHub heading anchors: **0 broken**. Deleted afterwards. |
| Snake-case keys | `rg reasoning_effort\|reasoning_summary\|budget_tokens` over README, CONFIG_REFERENCE, PER_TURN_EFFORT, OPENCODE_V2 and the ADR finds only the intentional alias mentions (`OPENCODE_V2.md:51`, ADR `:220`). |
| AI attribution | Commit bodies (`git log origin/de/main..HEAD --format=%B`) carry only `Refs #66` / `Refs #67`, with no trailers. Added lines contain no attribution. "Claude Code 2.1.280" is a product reference. See QA-3.1-10 for a local path. |
| Credit wording | `CHANGELOG.md:10` and ADR `:16` read exactly "Observations by @MetalbolicX in opencode-smart-router (#17); implementation written from scratch." The ADR adds "No code from that project was used." Neither implies co-authorship. |

### "To 3.1" handoffs (A15)

| Source | Handoff | Applied where / missing |
|---|---|---|
| `phase-0P.md` | A1: advisory vs enforced, and how to enforce | README `:946–951`; CONFIG_REFERENCE `:169–182`, `:1118–1119`; ADR D1 `:35–36`, D6 `:89–105`; CHANGELOG `:30–35`. **Applied.** CHANGELOG omits `perTier` (QA-3.1-3). |
| `phase-0P.md` | A4 `Fixed` entry (v1 behaviour change) and key names (README `:282,483,491`; CONFIG_REFERENCE; PER_TURN_EFFORT `:94,95,109,137`; OPENCODE_V2 `:48,49`) | CHANGELOG `:45–67`; README `:282–287`, `:495`; CONFIG_REFERENCE `:742–744`, `:763`, `:769`, `:775–782`, provider-gate table and `:842–846`; PER_TURN_EFFORT `:93–99`, `:111–112`, `:140`; OPENCODE_V2 `:46–56`. **Applied.** Case gaps: QA-3.1-4. README `:282` mechanism: QA-3.1-2. |
| `phase-0P.md` | A5 preset table | CONFIG_REFERENCE `:584–603`; README `:980–986`. **Applied.** Both match `tiers.json`. **Missing from the ADR** (QA-3.1-6). |
| `phase-0P.md` | A11 `/bypass` under D11 | README `:955–956`; CONFIG_REFERENCE `:199–200`; ADR D11 `:201–204`. **Applied.** |
| `phase-1.1.md` | QA-1.1-8 (a) shipped/applied table, (b) enforced-mode list, (c) `perTier` | (a) CONFIG_REFERENCE `:1074–1076`, `:1104–1106`; (b) `:1118–1119`; (c) `:178–182`. **Applied.** The CHANGELOG repeats (c)'s incomplete wording (QA-3.1-3). |
| `phase-1.1.md` | QA-1.1-R2-4: `perTier` condition at `:161` and in the truth table | CONFIG_REFERENCE `:161`, `:680–681`. **Applied.** |
| `phase-1.1.md` | Final pass: D11 limits, `reasoning_effort` → `reasoningEffort` row, A1 wording in README/CHANGELOG | CONFIG_REFERENCE `:213–214`, `:763`; README `:946–956`; CHANGELOG `:30–35`. **Applied.** |
| `phase-1.1.md` (deferred) | ADR: ratio-based cost of bumped attempts (§6) | ADR D8 `:154–156`; CONFIG_REFERENCE `:571–572`. **Applied.** |
| `phase-1.2.md` | No "To 3.1" handoff. Residuals F2/F6 | Published in ADR Consequences `:252–266`. Informational. |
| `phase-1.3.md` | CHANGELOG `Fixed` cases: OpenAI regex (Copilot/OpenRouter/Azure `gpt-*`, `gpt-oss` via Ollama/Groq, `-o1`/`-o3` false positives); Claude budget → `thinking`; unknown family (Bedrock Claude, Gemini); remedy | CHANGELOG `:47–67`. **Applied as handed off.** The handoff itself under-lists what the code now sends (QA-3.1-4). |
| `phase-1.3.md` | Preset table (A5); default-cost trace; D8 "four attempts" wording (QA-1.3-3); bumped retry charged at tier ratio (F4) | CONFIG_REFERENCE `:584–603`; ADR D8 `:143–156`; README `:983–986`. **Applied.** |
| `phase-1.3.md` | QA-1.3-9 docs drift (README `:282,483,491`; CONFIG_REFERENCE `:668–760`) | **Applied** (grep clean). |
| `phase-1.3.md` | QA-1.3-R2-2 / A14: give both traces | ADR `:147–150`; CONFIG_REFERENCE `:598–600`. **Applied.** |
| `phase-1.3.md` (deferred) | "D7 reach … the ADR and CONFIG_REFERENCE will publish the table" | CONFIG_REFERENCE: **applied**. ADR: **missing** (QA-3.1-6). |
| `phase-2.1.md` (deferred) | D11 limits in ADR and README; no trivial downgrade | README `:955–956`; ADR D11; CONFIG_REFERENCE `:197–198`, `:1129`; ADR `:104–105`. **Applied.** |
| `phase-2.2.md` (deferred) | Key names and the v1 behaviour change (A4); provider acceptance unverified | See the A4 row. "Unverified" notes are at CHANGELOG `:57–58`, `:62`; CONFIG_REFERENCE `:580–582`, `:845–846`; ADR `:269–277`. **Applied.** |
| `phase-2.3.md` (deferred) | A1, A4, A5, A14, D11 incl. `/bypass`, N11 | See rows above. N11: CONFIG_REFERENCE `:572–574`, ADR `:201–202`. **Applied.** The README bump section omits N11 (QA-3.1-12). |
| `phase-2.3.md` | F2: banner position differs by host | CONFIG_REFERENCE `:202–203`; ADR `:115–116`. **Applied** for native dispatch. Delegate position: QA-3.1-7. |
| `phase-2.3.md` (QA-2.3-R2-3) | CHANGELOG entry: v2 envelope retention and fallback conditions | CHANGELOG `:36–43`; OPENCODE_V2 `:111–119`; ADR `:280–284`. **Applied.** It is placed under `Changed`, not `Fixed` as handed off. Accepted, because it changes visible layout. |
| `phase-2.3.md` | Withdraw F1 (no parentage change to announce) | ADR D3 `:61–62` keeps backend parentage, and the CHANGELOG has no parentage note. **Applied.** |
| `phase-2.3.md` | v2 `experimental.subagent_depth` (default 1); the lower cap wins; raising only the router key or a top-level `subagent_depth` does not help on v2 | README `:958–960`; CONFIG_REFERENCE `:216–221`; ADR `:206–209`; CHANGELOG `:34–35`. **Applied.** |
| `phase-2.3.md` | The v1 rig needed top-level `subagent_depth: 4` to lift a v1 1.18.19 host cap; default unverified | ADR `:210–212` only. README and CONFIG_REFERENCE do not say that v1 has a host cap. **Partially applied** (QA-3.1-5). |
| `phase-2.3.md` | v2 `general` needs an explicit `subagent` permission | CONFIG_REFERENCE `:221–222`; ADR `:209–210`. **Applied.** README is silent (QA-3.1-5). |
| `phase-2.3.md` | v2 resumes only a direct child | ADR `:210`. **Applied.** |
| `phase-2.3.md` | Exemptions: `perTier` applies, `perTier: "off"` and `MODEL_ROUTER_ENFORCE=0` disable; `/bypass` covers both paths; the bump ignores `/bypass` | CONFIG_REFERENCE `:178–182`, `:198–200`, `:572–574`; ADR D6, D11; README `:950–951`, `:956`. **Applied.** Gaps: CHANGELOG `perTier` (QA-3.1-3), README N11 (QA-3.1-12). |
| `phase-2.3.md` | Refusal shapes (delegate: normal result; task: `is_error`) | CONFIG_REFERENCE `:196–197`; ADR D4 `:74–75`. **Applied.** |
| `phase-2.3.md` | v1 graders run on the default `build` agent, which has `task`; depth-limited at creator depth + 1 | ADR D3 `:57–65` covers the depth record. The `build`/`task` fact is **missing** (QA-3.1-5). |
| plan A9 (dispatch focus) | v1's default `general` has no `task` tool, so v1 nesting needs an agent with task permission | **Missing** everywhere (QA-3.1-5). |

## Implementation notes

Method: every behavioural sentence in the seven diffs was mapped to the code line that implements it. Claims that
held are listed below. The ones that did not are in `## Findings`. No source, test or other doc was edited. The two
temporary scripts (template comparison, link check) ran from `%TEMP%` and were deleted.

Claims verified against code (no finding):

| Doc claim | Code |
|---|---|
| `maxDelegationDepth` defaults to `1`; `null` disables; safe integer 1–32 (README `:943`, `:953`; CONFIG_REFERENCE `:159`, `:210`; ADR `:30–33`; CHANGELOG `:14–15`) | `resolveDepthLimit` `src/router/config.ts:1369–1372`; validation `:787–798`; `MAX_DELEGATION_DEPTH_LIMIT = 32` `:724`; `MAX_DEPTH_HOPS = 32` `src/router/depth.ts:3` |
| `effortBump` defaults to `true`, `effortBumpMax` to `"xhigh"` (CONFIG_REFERENCE `:543–544`; ADR `:128–129`; CHANGELOG `:16–18`) | `resolveEffortBump` `src/router/config.ts:1375–1381` |
| Judges `callerDepth + 1 > max`; advisory → banner, enforced → D5, off → no lookup | `src/router/depth-guard.ts:98`, `:143–148` |
| Env gate `1`/`0` beats `perTier`, which beats `mode`; tier = caller's tier | `src/router/enforcement.ts:20–46`; `src/index.ts:397–401` |
| `/bypass` skips the guard on both paths but not the bump | `src/index.ts:620` (delegate), `:1219` (task/subagent before-hook); `chat.params` `:1081–1112` and the ladder `:952–1013` have no bypass check |
| Task refusal is a thrown error recorded as a blocked tool event; delegate returns D5 as text before any session is created | `src/index.ts:1221–1233`; `:620–632` (before `session.create` at `:724`) |
| v1 banner precedes verification text and is not graded; v2 banner follows verification text | `src/index.ts:1398–1411`, then `:1448` grades `unbannered`, and verification appends at `:1595–1603`; `src/compat/v2-hooks.ts:344`, `:356` |
| Banner maps bounded at 1,000; dropped on non-completed v2 results; v2 background `running` result carries it | `src/index.ts:422`; `src/compat/v2-hooks.ts:296`, `:312`, `:316–330` |
| Eligibility: explicit valid effort, no variant, known family, no winning budget / `reasoning.effort`; Claude ceiling `max`, OpenAI `high`; adaptive-only budget does not disqualify | `effortCeilingFor` `src/router/agent-options.ts:72–83`; `buildEffortBump` `src/escalate/ladder.ts:226–241` |
| One step per same-tier retry, retained at the bound; escalation resets; no extra attempt; checks ordered total → cost | `src/escalate/ladder.ts:134–174`, `:191–209` |
| `maxAttemptsPerTier` = retries after the first attempt; cost ceiling checks recorded cost after an attempt (CONFIG_REFERENCE `:541`, `:546–551`) | `src/escalate/ladder.ts:135–154`; `src/index.ts:973–977` (`recordAttempt` with tier `costRatio`) |
| `fable-effort` trace `fast@low → fast@medium → medium@high`, cost 5 > 4, stops; multiple `5` admits `medium@xhigh` | `tiers.json` costs 1/3/6; ladder `:135–151` |
| Preset table (CONFIG_REFERENCE `:588–593`, README `:980–983`) | `tiers.json`: `anthropic` all variants; `fable-effort` low/high/xhigh, no variants; `hybrid` OpenAI tiers have no effort, `heavy` has a variant; `openai`/`github-copilot`/`google`/`zai` have no effort |
| Native keys `reasoningEffort`/`reasoningSummary`/`thinking: { type: "enabled", budgetTokens }`; Claude gate; unknown family passes explicit fields | `src/router/agent-options.ts:115–204` |
| Override applies only for matching session, agent and model (case-insensitive); writes flat on v2 and to `output.options` on v1; removes the `reasoning_effort` alias; bounded at 1,000; cleared on all four exits | `src/escalate/effort-override.ts:52–111`, `:114–165`; `src/index.ts:1103`, `:817`, `:946`, `:1023`, `:1652` |
| v2 bridge keeps native keys and fills aliases only when the native value is `undefined`; the per-turn merge fills only absent keys | `src/compat/v2-hooks.ts:129–133`, `:214–216` |
| v2 envelope retained only for `subagent` with a host text part and a trimmed-prefix match; otherwise one full text part plus non-text parts | `src/compat/v2-hooks.ts:345–363` |
| D2: 2 s lookup deadline, 30 s retry throttle; roots seeded only from successful lookups | `src/router/depth.ts:4–5`; `src/index.ts:302–330` |

## Findings

Round 1, at `aa1dee6`.

| ID | Severity | File:line | Description | Resolution |
|---|---|---|---|---|
| QA-3.1-1 | major | `docs/CONFIG_REFERENCE.md:1110–1112`, `:1122–1126` | **The reference says the ladder, and now the effort bump, run only in `enforced` mode. The code runs them in every mode.** `:1110–1112` reads: "In advisory mode every guard, ladder and verification rule is evaluated … but nothing is ever blocked or retried". `:1122–1126` lists, under "Changing `mode` to `"enforced"` turns those same evaluations into actions": "With `escalate.effortBump` enabled, an eligible failed attempt first retries at higher effort". That sentence was added by this plan (`6aa8c74`) and survived the 3.1 final pass. The `delegate` ladder has no enforcement-mode input. `buildEscalatePolicy` (`src/escalate/ladder.ts:211–223`) and `nextAction` (`:119–189`) read no mode. The loop at `src/index.ts:656–657` and `:952–1013` retries on any unaccepted gate result. `accept` takes only `mode?: "modeA" \| "modeB"` (`src/verify/gate.ts:46`). `src/index.ts:530–532` states "the delegate tool verifies in every mode". The shipped bump test runs at the bundled `advisory` (`tiers.json:5`) with `MODEL_ROUTER_ENFORCE=""` and no mode override (`test/integration/ladder-effort-wiring.test.ts:59`, `:75`). It contradicts README `:967–971` and CHANGELOG `:22–23` ("by default"), which match the code. A reader of the reference concludes the bump cannot happen at the default mode. Fix: state that the `delegate` ladder and its effort bump run in every enforcement mode, and remove the bump from the enforced-only list. Scope "nothing is ever … retried" to the native `task` path, or reword `:1110–1126` together. | Fixed in `b8668ce`: rewrote the block to separate mode-dependent guards/native verification from the mode-independent delegate gate, retries, escalation and effort bump; removed the enforced-only gate/ladder claims. Rechecked the cited ladder, index and gate code. |
| QA-3.1-2 | minor | `README.md:282–284` | **`variant` is listed among the tier options "applied per turn through the v2 `session` context hook".** The context hook copies only the keys of the agent's registered `options` bag (`src/compat/v2-hooks.ts:126–135`, `:214–216`), and `buildAgentOptions` never emits `variant` (`src/router/agent-options.ts:101–205`). V2 applies a tier's variant at registration, through the agent's model reference (`src/compat/v2-hooks.ts:146`, `modelRef(definition.model, definition.variant)`). The variant still reaches v2 requests; only the mechanism is misattributed, on a line that 3.1 rewrote. Fix: drop `variant` from that list, or note that it is applied through the agent model at registration. | Fixed in `5776e7e`: removed variant from the per-turn list and documented model-reference registration; rechecked the cited bridge and option builder. |
| QA-3.1-3 | minor | `CHANGELOG.md:32–34` | **The `Changed` depth entry's "how to enforce" and opt-out list ignore the caller-tier `perTier` override.** "Set `enforcement.mode: "enforced"` or `MODEL_ROUTER_ENFORCE=1` to enforce it" does not hold for a caller tier whose `enforcement.perTier` entry is `advisory` or `off`. With the gate unset, `perTier[callerTier]` wins over `mode` (`src/router/enforcement.ts:39–46`, tier from `sessionStore.getTier(caller)` at `src/index.ts:397–401`). `perTier: "off"` is also an opt-out missing from "Enforcement mode `off` and `/bypass on` also disable the check". QA-1.1-8(c) raised the same gap for CONFIG_REFERENCE, which now has it (`:178–182`, `:198–199`), as does README `:950–951`. Fix: add "unless the caller tier's `enforcement.perTier` entry overrides `mode`; `perTier: "off"` also disables it". | Fixed in `386ca75`: added caller-tier precedence, its off opt-out and the environment override; rechecked enforcement.ts and the caller-tier lookup. |
| QA-3.1-4 | minor | `CHANGELOG.md:53–62` | **The v1 behaviour-change case list under-reports what the registration fix now sends.** (a) OpenAI-family tiers with `thinking.budgetTokens` now send `thinking`. Non-Claude budgets are not gated (`src/router/agent-options.ts:116`, `:201–203`), and CONFIG_REFERENCE `:842–844` documents it. The CHANGELOG mentions `thinking` only for Claude and unknown-family tiers. (b) The OpenAI bullet says those models "with configured effort" now receive `reasoningEffort`. An explicit `reasoning.effort` also does (`agent-options.ts:142–145`), as plan A4 states ("a configured `effort` or `reasoning.*`"). (c) The false-positive regex is broader than "`-o1`/`-o3`". `(^\|[/\-_])o[134]([/\-_]\|$)` (`agent-options.ts:55`) also matches `o4`, `_`/`/` separators and bare ids. Fix: add the OpenAI+`thinking` and `reasoning.effort` cases, and describe the pattern as `o1`/`o3`/`o4` delimited by `/`, `-` or `_`. | Fixed in `40196ec`: added OpenAI thinking delivery, explicit reasoning.effort mapping and all o1/o3/o4 delimiters/boundaries; rechecked agent-options.ts. |
| QA-3.1-5 | minor | `README.md:955–960`; `docs/CONFIG_REFERENCE.md:207–222` | **Host facts that limit the guard on v1 are not documented.** (a) On v1, the default `general` agent has no `task` tool. The host turns its call into `invalid`, so v1 nesting needs an agent with task permission (plan A9; `phase-0P.md:136`). (b) The v1 1.18.19 rig needed a top-level `subagent_depth: 4` to lift a v1 host cap (`phase-2.3.md` "To 3.1 (from QA 2.3)"). Only ADR `:210–212` mentions the fixture. README `:958` names only "OpenCode 2" as having its own cap, which implies v1 has none, so a v1 user raising `maxDelegationDepth` in enforced mode can still be capped by the host. (c) v1 native-path graders run on the default `build` agent, which has `task` (`phase-2.3.md` handoff). Only their depth record is documented (ADR `:57–65`). (d) README omits v2's `general` `subagent` permission requirement (present in CONFIG_REFERENCE `:221–222`). Fix: add a short host-limits note covering (a)–(c) to CONFIG_REFERENCE's delegation-depth section, and (b) and (d) to the README paragraph, marking the v1 cap's default as unverified. | Fixed in `0b355ba`: added v1 general/task, build graders and the observed top-level host cap to CONFIG_REFERENCE; README now covers the v1 cap and v2 general permission. Rechecked the cited phase-0P/phase-2.3 evidence; v1 default/upstream documentation remain explicitly unverified. |
| QA-3.1-6 | minor | `docs/adr/0004-delegation-depth-and-effort-bump.md:120–132` | **The ADR does not record D7's reach.** It never states that the default `anthropic` preset has no bumpable tier, or that only `fable-effort` fast/medium are eligible. `rg preset\|hybrid\|bumpable` over the ADR finds no such statement. `phase-1.3.md` "Deferred by plan" says "the ADR and CONFIG_REFERENCE will publish the table". A5 and `tiers.json` make this the main consequence of D7: on a default install the bump never runs, even with `delegate` enabled. Fix: add the A5 result (or link CONFIG_REFERENCE `:584–603`) under D7 or Consequences. | Fixed in `065dcf2`: D7 now states that active/default anthropic has no bumpable tier and only fable-effort fast/medium qualify at defaults, with a link to the preset table. Checked tiers.json and the ceiling/bump builders. |
| QA-3.1-7 | nit | ADR `:113`; `docs/CONFIG_REFERENCE.md:202–203` | **The delegate banner position is not as described.** The ADR says "`delegate` appends it to its return". On an accepted result the banner sits before the verification suffix (`withDepthBanner(producerText) + buildAcceptedSuffix(…)`, `src/index.ts:992`). On a deferred result it sits before the footer (`appendRouterFooter(withDepthBanner(producerText), …)`, `:968`). CONFIG_REFERENCE gives the position only for native dispatch. Fix: say that on `delegate` the banner follows the producer text and precedes router suffixes/footers. | Fixed in `601e6f6`: both docs place the delegate banner after producer text and before the verification suffix/deferred footer; rechecked index.ts:968,992. |
| QA-3.1-8 | nit | ADR `:117` | **"Failed/non-completed results have no banner" is stated as fact for v1.** The v1 after-hook appends the banner whenever it runs for `task`, with no status check (`src/index.ts:1398–1411`). The v1 half rests on the host not invoking the after-hook for a failed call, which `phase-2.3.md` F4 records as unverified. The next clause partly hedges this. Fix: "On v2, non-completed results get no banner (`v2-hooks.ts:312`); on v1, a failed call is expected not to reach the after-hook (unverified), …". | Fixed in `601e6f6`: distinguished the v2 status check from the unverified v1 host expectation and documented the v1 hook's lack of a status check; rechecked both hooks and F4. |
| QA-3.1-9 | nit | ADR `:255–256` | **Wrong source cited for the node bound.** "The default is 10,000 tracked nodes and a 60-minute idle TTL (`src/router/idle-sweep.ts`)". The 10,000 is `DEFAULT_DEPTH_MAX_ENTRIES` in `src/router/depth.ts:6`; only the TTL is in `idle-sweep.ts:1`. | Fixed in `de797d1`: attributed the node bound to depth.ts and the TTL to idle-sweep.ts; checked both constants. |
| QA-3.1-10 | nit | ADR `:229` | **A machine-local evidence path in a published ADR.** `C:\Users\Marquinho\AppData\Local\Temp\Claude\p23-host-proof\` cannot be followed by readers and exposes a user-profile path. Its tool-named temp directory can also be misread as attribution, although no attribution statement is made. Fix: describe the rig as retained locally by the owner, with hashes in `phase-2.3.md`, without the absolute path. | Fixed in `de797d1`: replaced the ADR's absolute path with the scripted keyless provider, real host versions and phase-0P/phase-2.3 evidence references; retained local-owner/provenance context. |
| QA-3.1-11 | nit | `docs/OPENCODE_V2.md:50–52` | **The scope of alias normalization is ambiguous.** "For option bags from other sources, it still normalizes legacy aliases" suggests any agent's options. The bridge normalizes, and later applies per turn, only agent definitions that the router's `config` hook changed (`src/compat/v2-hooks.ts:128`). Unmodified agents are skipped entirely. Fix: "for options merged into router-registered agents". | Fixed in `5776e7e`: limited normalization/per-turn merging to definitions changed by the router config hook, including the parallel ADR wording; rechecked v2-hooks.ts:124–146,214–216. |
| QA-3.1-12 | nit | `README.md:973–978`; `CHANGELOG.md:22–24` | **The README and CHANGELOG eligibility lists omit two conditions.** Neither states the recognised-family condition: an unknown family has no ceiling (`src/router/agent-options.ts:82`), which "room below the effective ceiling" only implies. The README bump section also does not say that `/bypass` leaves the bump active (N11; `src/index.ts:1101–1104`). Directly above, at `:956`, it says `/bypass on` disables the depth guard. CONFIG_REFERENCE `:560` and `:572–574` have both. | Fixed in `065dcf2`: added recognised Claude/OpenAI family eligibility in both lists and explicit README wording that bypass leaves the ladder/bump active; rechecked effortCeilingFor, the ladder and chat.params. |

### Round 1 resolution verification (2026-10-05)

All 12 round-1 findings have documentation fixes in the commits above. The original
review and verdict below are retained as historical evidence; these resolutions
are submitted for the next independent QA pass, not a new acceptance verdict.

- Rechecked the cited implementation ranges in `src/escalate/ladder.ts`,
  `src/verify/gate.ts`, `src/index.ts`, `src/router/agent-options.ts`,
  `src/router/enforcement.ts`, `src/compat/v2-hooks.ts`, `src/router/depth.ts`
  and `src/router/idle-sweep.ts`; host claims were checked against the phase-0P
  and phase-2.3 fixture reports, not a new host run.
- `npx vitest run test/unit/docs-drift.test.ts --maxWorkers=50%`: **1 file, 6/6 passed**.
- Inline Node assertions: **4/4 D5/A1 templates byte-exact** against depth-guard.ts
  after normalising `${d}` to `${depth}`; **57 relative links/anchors valid** across
  the seven Phase 3.1 docs; bundled preset reach checked against `tiers.json`.
- `git diff 400dd7e..HEAD --check`: clean before this resolution-record commit.
- Docs only; no tests added, no full suite or real-provider smoke run. The original
  `## [Unreleased]` heading and credit wording remain unchanged.

## Deferred by plan

- Real-provider acceptance of bumped values and of newly delivered v1 options (A5, `phase-2.2.md`). This cannot be
  shown keylessly. The docs correctly mark it unverified (CHANGELOG `:57–58`, `:62`; CONFIG_REFERENCE `:580–582`; ADR
  `:235–239`, `:269–277`).
- End-to-end smoke proof (`test/smoke/depth-effort.smoke.test.ts`) and its `package.json` script: Phase 3.2 → 3.4.
  The docs cite only the Phase 2.3 host proof and state that it was not re-run after the 2.3 fixes (ADR `:235–239`).
- The CHANGELOG release heading: Phase 3.4 (below).
- Observed, not filed (pre-`v2.0.0` text outside this plan's write intent): CONFIG_REFERENCE `:1120–1121` ("Verification
  gates acceptance" only in enforced mode) describes the `delegate` gate as mode-dependent too. The fix for QA-3.1-1
  should reword `:1110–1126` as one block. Otherwise, Phase 3.3 should re-check it.

## Handoffs

- **To 3.1 (fix round):** QA-3.1-1 to QA-3.1-12. Under §0.7, every round-1 finding is fixed, whatever its severity.
  Docs only. Re-run `test/unit/docs-drift.test.ts`, the D5/A1 byte comparison and the link check after the fixes.
- **To 3.4 (release):** rename `## [Unreleased]` (`CHANGELOG.md:8`) to `## [2.1.0] - <release date>`.
  - Keep the credit line (`:10`) verbatim, directly under the new heading.
  - If the convention keeps one, start a fresh empty `## [Unreleased]` above it.
  - The file uses reference links for issues and PRs (`CHANGELOG.md:843–845`). If `[#66]` / `[#67]` links are added,
    never add one for `#17`, which is opencode-smart-router's issue, not this repository's.
- **To 3.3:** confirm that QA-3.1-1's rewrite matches the `delegate` path in `off`, `advisory` and `enforced`, and
  check the pre-existing `:1120–1121` sentence noted above.

## Verdict

**Not accepted in round 1.** Open findings: **12** (1 major: QA-3.1-1; 5 minor: QA-3.1-2 to -6; 6 nit:
QA-3.1-7 to -12). No blocking or critical findings.

- The D5 refusal and A1 banner are byte-exact. The defaults, the 32 cap, the precedence of env gate over `perTier`
  over `mode`, the `/bypass` scope, the preset table, the ceilings, both A14 traces, the native keys and the v2
  envelope rules all match the code.
- The credit wording is exact, all relative links resolve, and there is no AI attribution.
- The major finding is a CONFIG_REFERENCE passage, extended by this plan, that confines the effort bump to enforced
  mode. The shipped `delegate` ladder bumps in every mode.
