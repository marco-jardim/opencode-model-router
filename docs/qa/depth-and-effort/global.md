# Phase 3.3.1 — Global senior QA review

- **Scope:** `git -C D:\git\omr-de-main diff origin/master...de/main`. Merge base and `origin/master` are
  both `46f443f`; `de/main` HEAD is `59096ad`. That is 184 commits and 52 files (+101 348 / −162 lines;
  87 472 of the added lines are the two ladder golden fixtures).
- **Against:** plan §4.1 G1–G6 and §1.7 A1–A15
  (`docs/plans/delegation-depth-and-effort-bump-plan.md`). Inputs were the phase reports
  `phase-0P.md` … `phase-3.2.md` and `run-log.md`.
- **Method:** I read every `src/` change in full: `depth.ts`, `depth-guard.ts`, `effort-override.ts`, and the
  diffs of `index.ts`, `ladder.ts`, `agent-options.ts`, `config.ts`, `compat/v2-hooks.ts`,
  `compat/child-session.ts`, `v2.ts` and `verify/wiring.ts`. I also read every changed user doc and every
  modified pre-existing test, and checked the binary of the real v1 host.
- **Evidence runs:**
  - adversarial scratch tests under `test/scratch/` (deleted before this commit);
  - a scoped coverage run;
  - `npx tsc --noEmit`.
  - No full suite or smoke run (owned by the orchestrator, last green at `400f2d6`; `59096ad` changes
    only a type assertion in a smoke helper test and the run log).

## Attacks attempted and outcomes

### 1. Bypass the depth guard in enforced mode (G1)

| # | Attack | Outcome |
|---|---|---|
| 1.1 | Find a `task` before-hook path that skips the guard | **Held.** In `src/index.ts:1218–1235`, the guard is the first statement after `if (bypassed) return` for `input.tool === "task"`. That is before `observeEdit` (`:1238`), `startDispatch` (`:1251`), prompt repair and header rewrite. On v2 the bridge maps `subagent` → `task` (`v2-hooks.ts:60`, `:289`) and awaits the legacy hook without catching it, so the refusal reaches the host. |
| 1.2 | Find other host paths that create a subagent without the hook | **None found on v1.** The installed v1 1.18.19 binary (`…\oc-v1\node_modules\opencode-windows-x64\bin\opencode.exe`, strings scan) fires `tool.execute.before` for: registry tools; MCP tools; MCP resource tools; the command-subtask path, which builds a `task` part and triggers the hook with `tool: task`; and CodeMode child tools, which are MCP-only. The binary has the `experimental.batch_tool` config flag and a TUI renderer, but no `batch` tool implementation. The router's own v2 `childRunner` calls `subagent` without the hook; the plan accepts this in A9, because the `delegate` call is guarded in `execute`. |
| 1.3 | `delegate` from a depth-1 caller | **Held.** Scratch: the D5 text is returned and `session.create` is never called. The guard (`index.ts:620–632`) runs before the `try`, so no producer, baseline or override exists. |
| 1.4 | A producer or grader that the backend reports as a **root** dispatches with `task`, or nests a `delegate` | **Held.** Scratch, enforced: the mock backend reports every session as having no `parentID`. A `delegate` from root `O` runs a producer and a grader, and each of them calls `task` and then `delegate` from inside its prompt. Every call is refused: the plugin pin (`recordPluginChild`, `index.ts:704`; `wiring.ts:1232`, `:1257`) outranks the backend root (`depth.ts:362`). |
| 1.5 | Race: the child's first `task` arrives before `session.created` | **Held.** Scratch: no event and no prior lookup. The lazy walk resolves `C → O` and refuses with `depth 1; max 1`. |
| 1.6 | Delete the root, then dispatch from its child while the backend no longer knows the root | **Held.** Scratch: `session.deleted(O)` is followed by `get(O)` rejecting. `C` keeps its resolved memo (`depth.ts:499`, F4) and is refused. |
| 1.7 | Seed a root from the fail-open default | **Held.** `getParent` shortcuts only on `sessionRootMemo.get(id) === true` (`index.ts:383`). That value is written only from a backend answer (`:321`), never from `resolveIsRootSession`'s `?? true` (`:295`). Covered by `depth-guard-wiring` "does not seed a failed transform lookup as a root". |
| 1.8 | Background, `task_id` resume, v2 foreground and background | **Held** by `depth-guard-wiring.test.ts` (resume, v2 symbol channel), `v2-hooks.test.ts`, and the 3.2 host smoke at `400f2d6` (orchestrator: v1 17 passed / 11 skipped, v2 19 / 9). The before-hook judges the **caller** in every case. |
| 1.9 | Evictions or idle sweep | **Accepted residual, documented.** An evicted or expired node re-resolves through the backend, which costs one lookup. Losing a non-reproducible pin (an unparented producer or native grader idle for 60 min) is F2, accepted in ADR 0004 "Consequences" and `phase-1.2.md`. I found no new path. |
| 1.10 | `perTier` / env gate | **By design (A1/D6), documented.** Scratch: `mode: "enforced"` with `perTier.fast: "advisory"` lets a `fast` child dispatch with only a banner. `MODEL_ROUTER_ENFORCE=0` turns it off, and `=1` overrides `perTier`. README, CHANGELOG, CONFIG_REFERENCE and ADR D6 state this precedence exactly (`enforcement.ts:15–46`). |
| 1.11 | Prototype-named tier (`perTier["toString"]` is inherited) | **Not model-reachable.** A model-supplied `delegate` tier is clamped to the ladder (`ladder.ts` `resolveStartTier`). `getTier` returns only registered tier agents. A user-named prototype tier would give a non-mode value, which the guard turns into `advisory` **with a warning** (`depth-guard.ts:88–93`). This lookup is pre-existing in `enforcement.ts`. Not a finding. |
| 1.12 | `/bypass` | **Documented user toggle (A11).** It is a slash command (`command.execute.before`, `index.ts:1998–2011`), so a model cannot invoke it. It is stated in README, CONFIG_REFERENCE and ADR D11. |
| 1.13 | Trivial downgrade | **Held.** `resolveEnforcementMode` has no trivial step. CONFIG_REFERENCE states the exemption. |
| 1.14 | A refused call flagged as a false refusal (D4) | **Held.** `task` records `blocked: true` unconditionally (`index.ts:1224–1228`). `delegate` records it for callers that are not subagents (`:625–627`); for known subagents the normal after-hook counts it (`:1413`). Covered by `depth-guard-wiring` "counts a refused delegate … once", "records refused attempts … known only to the backend" and "records a refused delegate after a fail-open transform". |

### 2. Brick an orchestrator (G2)

| # | Attack | Outcome |
|---|---|---|
| 2.1 | An extra backend call per dispatch from a seeded root | **Held.** Scratch, enforced: `system.transform(O)` followed by 5 `task` dispatches gives 1 `session.get(O)`. |
| 2.2 | Unseeded root | **Held.** Scratch: 5 dispatches with no transform give exactly 1 `session.get`. |
| 2.3 | Backend down for the root | **Held.** Scratch, enforced: `get(O)` always rejects. All 5 dispatches resolve, none is refused, and there are ≤ 2 backend calls (the root lookup plus one depth lookup; both are then throttled for 30 s). A hanging backend costs at most the 2 s deadline per caller per 30 s throttle window (`depth.ts:5`, `:4`), as ADR D2 states. |
| 2.4 | Refuse a root | **Not reachable.** Depth 0 + 1 > max needs max < 1, which validation rejects (`config.ts`: safe integer from 1 to 32). Roots are never recorded as plugin children. Only a backend that reports a session as its own parent can saturate a root (cycle → 32), which is the D2 fail-closed rule. |
| 2.5 | A throw into a session | **Held.** `checkDispatch` never rejects: every seam is contained (`depth-guard.ts:86–135`) and the tracker's public methods never throw (`depth.ts:132–151`). Banner stash and delivery, refusal recording, `chat.params` (both blocks) and `session.created` recording are each wrapped in `try`, and their failures are logged. The only throw is the intended D5 refusal. |
| 2.6 | Root results change | **Held on v1.** No banner and no `unbannered` copy; `depth-guard-wiring` "keeps a root result byte-identical to disabling the depth guard". **v2 note:** router-modified v2 `subagent` results now keep the host envelope (QA-2.3-1, `v2-hooks.ts:341–371`). This intentional fix also applies to roots and is documented under CHANGELOG "Changed" and OPENCODE_V2. Dispatch, structured output and metadata are unchanged, so it is not a G2 dispatch change. |

### 3. Make the bump unsafe (G4, G5)

| # | Attack | Outcome |
|---|---|---|
| 3.1 | An effort that `buildAgentOptions` would downgrade, drop or warn about, or a lowered effort | **Held.** Scratch property sweep:<br>• 7 model ids (Anthropic, Fable adaptive-only, OpenAI, Copilot `gpt-4o`, OpenRouter Claude, Gemini, Bedrock Claude) × 5 base × 5 `effortBumpMax` × 3 extras (none, `thinking.budgetTokens`, `reasoning.summary`), with `maxAttemptsPerTier: 4`.<br>• Every ladder-emitted `action.effort` is sent unchanged by the builder, never below base, never with a null ceiling, and is accepted and applied by the store.<br>• The only builder warnings are about non-effort keys: `reasoning.*` on Claude, and the adaptive-only budget drop. Their warn-once keys (`reasoning-claude:<tier>`, `thinking-adaptive-only:<tier>`) are the ones registration already used. |
| 3.2 | Add attempts, exceed the cost ceiling, or change v2.0.0 when the bump is off | **Held.** The bump only decorates a `retry` action (`ladder.ts:153–173`), and the check order is unchanged. Bump-off policies have no `effortBump` key (`:221–223`), and the golden replays pass. Scratch on `tiers.json` (`fable-effort`, start `fast`):<br>• bump on: `fast@low → fast@medium → medium@high → stop: cost ceiling exceeded`;<br>• bump off: `fast@low → fast@low → medium@high → stop: cost ceiling exceeded`;<br>• `costCeiling.multiple: 5`: `… → medium@xhigh → stop: max total attempts (4)`.<br>This matches A14, ADR D8, CONFIG_REFERENCE and README. |
| 3.3 | Leak to another session, title call or grader | **Held.** Scratch: the same producer id with `agent: "title"`, and another session with the same agent and model, get nothing. `ladder-effort-wiring.test.ts` covers title, orchestrator and grader exclusion, and cleanup before disposal on success, escalation, abort, timeout, deferred, prepare-throw and `session.deleted`, on v1 and v2. The store is keyed by producer id and gated on agent and model identity (`effort-override.ts:122–133`). |
| 3.4 | Config snapshot skew | **Held.** The policy, the producer model and the override tier all come from one `activeCfg` (`index.ts:656`, `:706`, `:734`). This is tested in "keeps the effort policy, model and override on the same config snapshot". |
| 3.5 | Bundled preset table | **Held.** Scratch over `tiers.json`: only `fable-effort` gives `fast {low→xhigh}` and `medium {high→xhigh}`; `anthropic`, `openai`, `github-copilot`, `google`, `zai` and `hybrid` give `null`. This matches the CONFIG_REFERENCE table, the README and ADR D7. |

### 4. Protocol text and agent list (G5, G6)

- `git diff --name-only origin/master...de/main` lists none of these paths, so none of them has a diff:
  `src/router/protocol.ts`, `src/router/sessions.ts`, `tiers.json`, `test/golden/` (including
  `__snapshots__/protocol.golden.test.ts.snap`), `test/unit/prompt-measurement.test.ts`,
  `src/router/prompts.ts`, `src/router/instructions.ts`, `package.json`, `package-lock.json` and `.github/`.
- The agent-registration code in `index.ts` is untouched. The v2 agent transform changes only how option
  aliases are normalized (`v2-hooks.ts:127–135`). **No agent is added.**

### 5. Doc claims against code

Checked, all consistent with the code:

- the D5 refusal and A1 banner texts (`depth-guard.ts:32–38`), byte-for-byte in CONFIG_REFERENCE and ADR;
- the defaults (1, `true`, `"xhigh"`; `config.ts` `resolveDepthLimit` / `resolveEffortBump`) and the 1–32 cap;
- env › `perTier` › `mode` precedence;
- `/bypass` scope (guard off, bump on; `chat.params` has no `bypassed` check, `index.ts:1081`);
- family ceilings (OpenAI `high`, Claude `max`) and the eligibility rules (`effortCeilingFor`, `buildEffortBump`);
- the A14 traces;
- bounded maps (1 000 banners, v1 and v2; 1 000 overrides; 10 000 nodes; 60 min TTL, `idle-sweep.ts`; 2 s
  deadline; 30 s throttle);
- banner order (v1 before verification text, `index.ts:1397–1411` then `:1595–1598`; v2 after);
- the v1 native-key registration fix, including `thinking` on non-Claude families, and Bedrock Claude
  treated as an unknown family (`protocol.ts` `isClaudeModel`);
- the v2 alias normalization and per-turn merge of modified agents only;
- the PER_TURN_EFFORT preset quotes (`anthropic.heavy`: `claude-opus-5-5`, `variant`/`effort` `xhigh`).

The `phase-3.1.md` "To 3.3" handoff is **applied**:

- CONFIG_REFERENCE `:1123–1151` describes the `delegate` gate, ladder and bump as running in `off`,
  `advisory` and `enforced`. This matches `index.ts:599–1026`, which has no mode check.
- The old "Verification gates acceptance" sentence is gone (grep: no match).

One stale evidence statement is filed as QA-G-2.

### 6. AI attribution

- `git log origin/master..de/main --format=%B`: 184 bodies, no `Co-authored-by` / `Co-Authored-By`,
  `Generated with` or `Signed-off-by`.
- `%(trailers)` is empty for every commit, and there is one author and committer
  (`marco-jardim <marcoeojardim@gmail.com>`).
- "Claude" and "Anthropic" appear only as provider names in two subjects: `bbc69d6` "preserve Anthropic
  protocol shapes" and `86311a9` "clarify Claude effort ceiling".
- Added doc lines mention attribution only as the rule against it, plus "Claude Code 2.1.280" as a product
  reference. The credit to @MetalbolicX is a prose line (CHANGELOG, ADR), not a trailer.

### 7. Coverage (§4.2)

- **Command:** `OMR_COVERAGE_ARTIFACT=1 npx vitest run <12 files> --maxWorkers=50% --coverage
  --coverage.reporter=json`.
- **Test files (12):**
  - `test/unit`: `depth`, `depth-guard`, `effort-override`, `effort-ceiling`, `effort`, `ladder`,
    `config-depth-effort`, `config.validate`, `config.overrides`;
  - `test/integration`: `depth-guard-wiring`, `ladder-effort-wiring`, `ladder-wiring`.
- **Result:** 12 files, 5 727 tests passed.
- New lines are the `+` hunks of the diff, mapped onto the v8 statement and branch maps.

| File | Lines | Branches | New lines | New branches |
|---|---|---|---|---|
| `src/router/depth.ts` | 100 % (433/433) | 97.25 % (318/327) | 100 % | 97.25 % |
| `src/router/depth-guard.ts` | 98.61 % (71/72) | 100 % (44/44) | 98.61 % | 100 % |
| `src/escalate/effort-override.ts` | 100 % (86/86) | 100 % (73/73) | 100 % | 100 % |
| `src/escalate/ladder.ts` | 100 % | 100 % | 100 % (34/34) | 100 % (40/40) |
| `src/router/agent-options.ts` | 100 % | 100 % | 100 % (18/18) | 100 % (25/25) |
| `src/router/config.ts` | 90.58 % (whole file) | 86.23 % (whole file) | 100 % (58/58) | 97.06 % (66/68) |

Every target of 95 % or more is met: whole-file for the three new modules, new code for the other three.
The full suite only adds coverage.

### 8. Other checks

- **Typecheck:** `npx tsc --noEmit` exits 0 at `59096ad`, after the scratch files were removed.
- **Modified pre-existing tests** (the `deferred-verification` depth opt-out, the key renames in
  `fable-effort-preset` and the registration smoke, `docs-drift`, and the smoke isolation): none weakens
  an assertion unrelated to #66/#67. The opt-out is reset by `invalidateConfigCache` in that file's
  `beforeEach` and `afterEach`.
- **Phase reports:** every one ends with "Open findings: 0". The QA-1.3-R2 rows marked "open" are
  resolved in `phase-1.3.md:415` (`d894a6c`).
- **A1 "entry dropped" on v1 failure:** the stash lingers until FIFO eviction or `session.deleted`. This
  was accepted in the 2.3 design (`phase-2.3.md:386`), is disclosed in ADR D6, is bounded, and is never
  delivered. Not a finding.

## Handoffs (A15)

- `phase-3.1.md` "To 3.3": **applied** (§5).
- `phase-3.2.md` "To 3.3/3.4" (follow-up issue for deferred-catalog's `XDG_DATA_HOME` log lookup):
  **deferred to 3.4/orchestrator**. Opening an issue is outside this review's write-set.
- `phase-3.2.md` "To 3.4" (`smoke:keyless` / `smoke:v2` file additions) and `phase-3.1.md` "To 3.4"
  (CHANGELOG heading): **deferred by plan to 3.4**. Until 3.4 adds `depth-effort.smoke.test.ts` to
  `smoke:keyless`, the new v1 host legs run in CI only in the credentialed `npm run smoke` lane.
- G6 "CI green on every OS × Node combination": not verifiable in this dispatch; it is a 3.4 pre-flight
  item.

## Findings

| ID | Severity | File:line | Description | Resolution |
|---|---|---|---|---|
| QA-G-1 | nit | `docs/qa/depth-and-effort/run-log.md:56` | A blank line splits the "Full-suite runs" table. The `400f2d6` row (`:57`, which also records the typecheck failure and its `59096ad` fix) renders as a stray pipe-delimited paragraph, not as a table row. | resolved (`f041a26`, round 2) |
| QA-G-2 | nit | `docs/adr/0004-delegation-depth-and-effort-bump.md:251–255` | The ADR's evidence section cites only the Phase 2.3 host proof and says the report records "**not a fresh host run** after those fixes". Phase 3.2 has since run the end-to-end host smoke (`test/smoke/depth-effort.smoke.test.ts`) on the final code at `400f2d6` (v1 17 passed / 11 skipped, v2 19 / 9, `phase-3.2.md`), and no user doc or the ADR cites it (grep `phase-3.2` / `depth-effort.smoke`: no match). The statement is accurate as scoped to `phase-2.3.md`, but understates the shipped evidence. | resolved (`f041a26`, round 2) |

## Verdict

**Open findings: 0 (QA-G-1 and QA-G-2 were fixed in `f041a26` and confirmed in round 2; round 2 found nothing new).**

- **G1–G5 hold** under every in-process attack attempted, with the accepted residuals that D2/F2/F6 and
  D11 already document.
- **G6:** protocol, golden and prompt-measurement files, the agent list, `tiers.json` and the package files
  are untouched. Typecheck is green. The CI matrix is left to 3.4.
- **Coverage** targets are met.
- **History** carries no AI attribution.

Under §0.7, round 1 fixes every finding whatever its severity, so 3.3.2 owns QA-G-1 and QA-G-2. Both
are docs-only edits.

## Round 1 resolutions (3.3.2, orchestrator in `D:\git\omr-de-main`)

- QA-G-1: the blank lines that split the run-log full-suite table were removed.
- QA-G-2: ADR 0004's evidence section now cites the Phase 3.2 end-to-end smoke on the final code and its mutation check (`docs/qa/depth-and-effort/phase-3.2.md`).

## Round 2

Scope: only `f041a26`. `git diff e42b360..f041a26 --stat` lists three files: the ADR (+7), `run-log.md` (−2) and
this file (+6). No code, test or other doc changed after round 1.

| Finding | Status | Evidence |
|---|---|---|
| QA-G-1 | resolved | Both blank lines are gone (after the 1.3 row and after the 2.3 row). `run-log.md:45–55` is now one contiguous table: a header, a separator and nine rows, with the `400f2d6` row at `:55`. |
| QA-G-2 | resolved | ADR `:256–262` adds "End-to-end smoke on the final code", which matches `phase-3.2.md` on every point. **File names:** `:27`, `:30`, and both files exist. **Hosts:** 1.18.19 and 2.0.22 (`:80`, `:453`). **Coverage:** the three accepted config keys, enforced and advisory foreground/resume, and v2-only background (`:272–281`). **Mutation list:** `depth`/`bump`/`cap`, meaning `maxDelegationDepth: null`, `effortBump: false` and `effortBumpMax` omitted (`:285–300`, `:455–469`). The key names match `src/router/config.ts:126`, `:175` and `:177`. "The merged code" is backed by the `400f2d6` run-log row (`run-log.md:55`). |

Observation, not a finding: ADR `:260` calls the bump "producer-only". On the hosts, that was captured as
cross-session isolation. `phase-3.2.md:104` and `:281` leave the same-producer-session A3 gate to
integration/unit proof, and the ADR already places that gate there (`:236–238`, `:266`). No edit is needed.

New findings: none.

