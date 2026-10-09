# Phase P1.2 — effort rpc channel (server side) (#90)

Branch `msd/p12` (worktree `D:\git\omr-msd-p12`), merged into `msd/main` at `b74e726`.

## Pre-flight

- `npm run typecheck` green; the 12 test files covering the touched code green at `439862f` (implementer).
- Host (medium tier lookup at tags): the legacy `chat.params` bridge is `ctx.session.hook("context", …)`;
  `v2.0.24:packages/core/src/session/model-request.ts:236-248` pre-fills `options` with `{ maxTokens }` only for
  primary/compaction; `:258-260` reads the hooked `options` back into the provider request; `:403-411` `context` fires
  only for `primary` requests (compaction/generate/title use their own hooks) and for root sessions too. Unchanged at
  v2.0.26 except an unrelated xAI MIME check.
- A3 question (implementer, repo evidence): `agentOptions` is filled only from agents whose definition changed and that
  carry `options` (`src/compat/v2-hooks.ts:1127-1139`); only the router's tier loop writes `options`
  (`src/index.ts:2797-2800`, all `mode: "subagent"`); role, plugin and `subagentTiers` agents never get options. A root
  session's agent therefore never carries a router effort; a test pins that a `build` root turn records no effort. G1
  stays `effort default` unless something else sets an effort on a root turn (then the channel reports it).

## Implementation

- `src\tui\effort-rpc.ts` (no imports): `effortRpc` `{ id: "opencode-model-router.effort", methods: { effortOf } , events: {} }`,
  JSON Schema input `{ sessionID }`, output `{ effort?, variant?, providerID?, modelID?, agent?, thinkingBudget?, at? }`.
- `src\tui\effort-channel.ts`: bounded store (1000 sessions, least-recently-written eviction, `forget`), `appliedEffort`
  (Claude models read `effort` first, others `reasoningEffort` first, via the router's `isClaudeModel`),
  `appliedThinkingBudget`, `effortOfHandler` (invalid input → `{}`), `registerEffortChannel` (feature-detected; bounded
  2 s wait; a late registration is kept and disposed on cleanup; never throws; logs once).
- `src\compat\v2-hooks.ts`: `normalizeAgentOptions` extracted (identical result); one store per adapter instance;
  recording after `legacy["chat.params"]` (read-only on `event.options`); role fail-closed path records what is sent;
  non-role failure forgets and rethrows unchanged; `session.deleted` forgets; registration once per setup in tiers and
  roles mode, disposed with the other registrations. v1 path untouched (test: no store, no registration).

Commits: `3258b17` (feature), `44fb78b` (QA round 1), `8209e67` (QA round 2).

## Tests

`test\unit\tui.effort-channel.test.ts` 76 tests. Reviewer runs: 4 unit files 1402 passed/1 skipped; integration
`roles-authority` + `routing-dispatch` 149 passed/1 skipped. Implementer round 2: 3 unit files 234 passed/1 skipped;
`roles-authority` 48 passed/1 skipped. On `msd/main` after the merge: 8 touched files 495 passed/1 skipped; typecheck
green. Three integration failures seen once when the implementer ran 6 integration files concurrently with unit files
passed alone (load, recorded; `routing-ladder-resume` does not load the changed code).

## QA

| Round | Verdict | Findings |
|---|---|---|
| 1 (heavy reviewer) | PASS | 6 minor + 6 nits: register without timeout, context hook scope (settled by the executor from `model-request.ts:408-411`), weak two-setup test, missing OpenAI/budget/failure tests, budget not expressible, variant vs effort rule for P1.3, non-string id, no forget on delete, Claude key order, alias note, extraction outside the hunk (justified by A3), A3 evidence (this report). All fixed in `44fb78b`. |
| 2 (same reviewer) | PASS | R2-1 `integer` schema risk → `number` + sanitize check; R2-2 role path records; R2-3 non-role failure forgets; R2-4 comments; R2-5 late registration kept. All fixed in `8209e67`. |

Handed to P1.3: QA-6 (when the channel's `variant` and `effort` both exist and differ, show the variant or both).
Handed to P2.1: call `effortOf` on 2.0.24/2.0.25/2.0.26 after a real turn. Handed to P2.2: thinking-budget tiers show
`thinkingBudget`, not an effort level.

## Verdict

DONE. 0 open blocking/critical/major.
