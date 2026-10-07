# QA — plugin-level `agents` block (#81)

## 1. Pre-flight

- Base: `master` @ `ceb343c` (worktree `D:\git\omr-agents`, branch `feat/plugin-agents`).
- Linear: not used.
- Host for the real-host smoke: OpenCode 2.0.24 (isolated HOME/XDG, never the live config or store).

## 2. Design

- Schema: `agents: Record<name, { tier, description, prompt?, steps?, readOnly?, allowTools?, permission? }>`.
- Validation runs on the merged config (tiers.json + global override) in `buildConfig`, after the persisted
  preset is applied. It never throws: an invalid entry is removed from `cfg.agents` and reported as a
  `router: config notice:` line naming `agents.<name>[.<field>]`. The layer, `routing` and every other entry
  are kept (#80).
- Reserved names: `fast`, `medium`, `heavy`, every tier of the active preset, the grader agents, and the host
  primary/hidden agents `build`, `plan`, `title`, `summary`, `compaction`.
- A `tier` the active preset does not define: the entry is skipped (notice) for this preset only; a `/preset`
  rebuild re-checks it.

## 3. Precedence and layer rules

- tiers.json and the global override may define `agents`. A project override may not (A18): a cloned
  repository must not be able to register agents with permissions. The block is stripped from the project
  layer with a notice; the rest of that layer still applies.
- opencode.json precedence: it wins for the fields it sets; its permission rules go after the router's and its
  `tools` are merged over ours; one-time notice. `agents.<name>.tier` wins over `subagentTiers[<name>]`.
- Phantom names: a `subagentTiers` name that no agent defines is skipped, never created (v1 at config time; v2
  re-checks at the first prompt and refreshes once when the host registers it later).

## 4. Tests

- `test/unit/plugin-agents.test.ts`: validation (unknown keys, reserved names, unknown tier, missing policy,
  `bash`→`shell` alias, `allowTools` rejecting shell/edit/subagent/read), layer rules (project `agents`
  stripped with a notice and the rest of the layer kept; a bad entry dropped while `routing` stays), permission
  builders (deny-by-default first, sensitive asks after each read grant, user deny stays deny).
- `test/unit/plugin-agents-v1.test.ts`: v1 registration shape, precedence and the one-time notice, `tier` vs
  `subagentTiers`, phantom skip, preset switch, grep filter for a readOnly plugin agent.
- `test/unit/plugin-agents-v2.test.ts`: v2 registration, permissions under identical and drifted host defaults,
  explicit-permission fail-closed, session grant vs deny, late host agents after the prompt refresh, notices,
  and `GRADER_AGENT_NAME === V2_GRADER_AGENT`.
- Without an `agents` block nothing changes: `test/golden` and the related suites stay green.

## 5. Real-host smoke

Gated scenario in `test/smoke/` (isolated v2 host; global override defines `reviewer` (heavy, readOnly,
`router_git_*`) and `runner` (fast, explicit permission). Asserts the host's agent list (mode, tier model,
permission rules, no `*:*:allow`) and that child sessions are refused shell/edit (and non-allowed shell
commands for `runner`). Run once with evidence writing OFF (`OMR_UPDATE_READONLY_EVIDENCE` unset; the scenario writes no files):
`RUN_OC_SMOKE_ROUTING=1 npx vitest run --config vitest.smoke.config.ts test/smoke/plugin-agents.smoke.test.ts` → 1 passed.
The smoke found a real bug the unit harness could not: the config hook builds plugin agents in the v1 vocabulary
(`bash`, `task`), so on v2 a `shell: { "npm test*": "allow" }` rule was published as action `bash` and never
applied to the host's `shell` action. The v2 transform now maps `bash`→`shell`, `task`→`subagent` for plugin
agents (unit test: "publishes the v2 vocabulary").

## 6. Residual risks and known limits

- `allowTools` and shell patterns are permission rules, not a sandbox (see `docs/READ_ONLY_TIERS.md`).
- A host agent with the same name as a plugin agent that the host registers **after** the router's setup cannot
  be told apart from the router's own agent; the same-name notice is based on the setup-time agent list.
- Host-seed fields win: for a same-name host agent, `mode`, `model`, `variant` and `description` read from the
  host at setup override the router's values (opencode.json wins for the fields it sets).
- A `readOnly` agent whose `permission` only adds deny/ask rules cannot grant anything; grants go in `allowTools`.
- Wildcard read grants other than `*` get the sensitive globs denied at that position (stricter than needed).
- v2 `ctx.agent.list()` is called per prompt only while a `subagentTiers` name is still pending.