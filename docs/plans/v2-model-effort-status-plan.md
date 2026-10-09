# Plan — v2 TUI: model and effort/variant for the main session and every delegated session (#90)

Status: approved for execution (owner, 2026-10-09). Issue: [#90](https://github.com/marco-jardim/opencode-model-router/issues/90).
Handover: `D:\git\opencode-model-router\docs\plans\v2-model-effort-status-handover.md`.

## 0. Execution rules (binding for the executor)

0.1 **Iterate continuously.** Run the plan wave after wave without stopping. Stop only for: (a) an ambiguity that only the
human can resolve, (b) a blocking or critical problem you cannot fix, (c) an OpenCode restart (the human restarts), (d) the
publish gate in P3.2. Everything else is resolved and recorded, not asked.

0.2 **Pre-flight before every phase.** Re-read the phase, confirm its inputs exist (merged predecessors, worktree on the
right base, `npm ci` done, `npm run typecheck` green, the touched tests green at the base), and check the live host log
(`C:\Users\Marquinho\.local\share\opencode\log\opencode.log`) for `failed to load plugin` lines that are not
`spawning process`. Fix everything found. If a finding is scheduled for a later phase of this plan, only record it in the
phase report.

0.3 **Senior QA after every phase. QA is always a heavy-tier task.** Dispatch a `reviewer` (heavy..heavy) that did not
produce the work, adversarial, read-only, with the diff range, the plan section and the facts (test results) pasted.
Fix every finding of rounds 1 and 2. From round 3 on, fix only blocking, critical and major findings; minors are recorded
as "accepted — QA round limit". Do not loop reviews to exhaustion. The global QA (P3.1) follows the same rule.

0.4 **Delegate through model-router, always**, with atomic tasks and role agents (roles mode is live for the owner):
`explorer` lookups, `implementer` code, `runner` test runs (`router_run`: script `typecheck`; command `test-files` with
args `test/<file>`), `reviewer` QA, `architect` design, `researcher` web/docs. Complex coding → `implementer` with
`[route … tier=heavy pin]` only where the task below carries `[tier:heavy]`. The heavy lift goes to heavy; running and
collecting tests goes to lighter dispatches (`runner`). If a less capable delegate is repeatedly blocked or verbose for the
same step, take over that read or edit yourself, finish it, record the takeover in the phase report, and resume delegating.

0.5 **Parallelism, safely.** Maximise parallel dispatches, but one owner per file at a time: a file is written by exactly
one agent per phase; no agent reads a file while another is editing it (give readers a committed SHA instead). Phases in
the same wave run in separate git worktrees on separate branches; the file ownership table in §4 is binding. Merges into
the integration branch are done by the executor only, sequentially.

0.6 **Commit often.** Conventional Commits, body `Refs #90`, never an AI attribution or `Co-Authored-By` line. Delegates
cannot commit; the executor commits after each green group and pushes.

0.7 **Tests.** Never run the full suite unless needed. Run only what a change touches (`router_run test-files` with the
touched files), in parallel, `--maxWorkers` as high as the machine allows. The capped full suite runs once at P3.1
pre-flight and once on `master` in P3.2. Every phase ends with new tests (good coverage, edge cases, negative cases).

0.8 **Definitive solution only.** No interim deliveries that do not solve the goal. Every phase ships its part complete.

0.9 **Paths.** Always full paths in dispatches and reports.

0.10 **Host scope.** OpenCode **v2 only, minimum 2.0.24**, verified on 2.0.25 and 2.0.26. OpenCode v1 is in feature freeze
(`D:\git\opencode-model-router\AGENTS.md`): v1 behaviour and v1 goldens must stay byte-identical; `npm run smoke:v1` stays
green.

0.11 **External source.** `D:\git\opencode` (OpenCode monorepo) may always be updated: `git -C D:\git\opencode fetch --tags
--prune origin` and `git -C D:\git\opencode merge --ff-only @{u}` on `dev` before use. Read host code only at tags
(`git -C D:\git\opencode show v2.0.24:<path>`, `git grep -n <pat> v2.0.24 -- <pathspec>`); `dev` is a different,
restructured API (its `packages/plugin/src/tui` is gone) and must not be targeted. Role agents cannot read outside this
repo's worktrees: use the `medium` tier agent (explicit tier dispatch) for host-source research.

0.12 **Live host safety.** Never write in the base checkout `D:\git\opencode-model-router` except for the sync steps in
DF-1/P3.2. Never print `C:\Users\Marquinho\.config\opencode\opencode.json`. Never write
`C:\Users\Marquinho\.config\opencode\opencode-model-router.state.json`. Any change to an owner config file is validated
first in a temp HOME, backed up (`<file>.bak-<timestamp>`), and recorded with its SHA-256 in the phase report.

0.13 **Tracking.** Linear is not used. Comment on GitHub #90 at each wave close and at DF-1.

## 1. Goal and facts

### 1.1 Goal (owner, 2026-10-09)
- G1 **Main session**: the prompt footer shows the effort/variant of the main session's current model.
- G2 **Each delegated (child) session view**: shows that session's model and effort/variant.
- G3 **Main session while delegations run**: a row above the composer lists the running delegates (agent, model,
  effort/variant). Option B chosen by the owner; the host's inline `Subagent` line is not changed.

### 1.2 Host facts at v2.0.24 (verified in the source, `D:\git\opencode` tags v2.0.24–v2.0.26)
- F1 Main footer: `PromptMetadataRow` (`packages/tui/src/component/prompt/metadata.tsx:63-146`) renders
  `Agent · model provider · variant`; the variant shows only when one is selected (`:69`); no effort is shown. Variant
  selection: `local.model.variant.current()` (`packages/tui/src/context/local.tsx:472-478`), per session draft + per
  model preference (`:239-278`, `:488-491`). Core maps variant → effort (`packages/core/src/session/runner/to-llm-message.ts:234-236`).
- F2 Child session view (`packages/tui/src/routes/session/index.tsx:1448-1459`): no `Prompt`, so no `prompt.footer*`
  slots; `session.composer.top` (input `{sessionID}`) renders in parent and child views; sidebar slots render when shown.
- F3 TUI slots (`packages/plugin/src/tui/context.ts` SlotMap): `app`, `home.footer`, `home.footer.status`,
  `prompt.footer`, `prompt.footer.status`, `prompt.footer.file` (prompt only), `session.composer.top`, `session.panel`,
  `sidebar.content`, `sidebar.footer`. Placements: `prepend`, `append`, `before`, `after`, `replace`.
- F4 Delegation tool is `subagent` (`packages/core/src/tool/plugin/subagent.ts:17`); its inline line
  (`routes/session/index.tsx:3087-3133`) shows `input.model` only. The call input is persisted (`Tool.Called`,
  `runner/publish-llm-event.ts:468-475`) before plugin `execute.before` runs (`core/src/tool.ts:271`), so a server plugin
  cannot change that line (why G3 uses a composer row).
- F5 TUI plugin module: `export default Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`
  (`packages/plugin/src/tui/plugin.ts`); TUI config key `plugins` (`packages/tui/src/config/index.tsx:45-52, :79`);
  local discovery `<config>/plugins/*`, `.opencode/plugins/*`; entry resolution `Host.resolve`
  (`packages/plugin/src/host.ts:43`): `{ server: entry(["server",""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }`.
- F6 Context data: `data.session.get(id)` (`.model` = `Model.Ref {id, providerID, variant?}`, `.parentID`),
  `data.session.message.list(sessionID)` (assistant `model: Model.Ref`, `packages/schema/src/session-message.ts:55,216`),
  `data.session.family(id)`, `data.session.status(id)` (`"idle" | "running"`), `data.location.model.list()` (names,
  `variants`), `ui.model.current()` (`{providerID, modelID, variant?}`), `data.on/listen` (server events only, no custom
  events), `storage.store` / `storage.memory`, `client` (SDK).
- F7 2.0.25+: plugins must use the host's `effect` and `@opencode/plugin` (bundled copies → load error); only
  `@opencode/plugin/tui` and `solid-js` imports are safe. `@opentui/*` peers ≥ 0.5.14 (2.0.24) → ≥ 0.5.17 (2.0.26).
  The TUI plugin API surface above is unchanged through 2.0.26. `dev` HEAD is incompatible.
- F8 The router knows a delegate's model and variant before the child starts (`src/compat/v2-hooks.ts:1496-1562`,
  `src/routing/wire/dispatch.ts:1400`); effort reaches the child per turn via `chat.params` (`agentOptions`,
  `v2-hooks.ts:1377-1380`) and, on ladder escalations, via `effortOverrides` (`src/index.ts:1986`,
  `src/escalate/effort-override.ts:114-145`). With the owner's presets the effort equals the variant name, except after
  an effort escalation without a variant step.
- F9 This package has no `exports` map (`main: ./src/index.ts`, root `server.ts` re-exports `./src/v2`); v2 finds
  `server.ts` today. How `entry(["tui"])` resolves without an `exports` map is unverified (S1).

## 2. Design (binding unless P0.1 amends it)

- D1 **One package, two entries.** Keep the server plugin as is; add a TUI entry (`tui.tsx` at the package root or an
  `exports["./tui"]` mapping, decided by S1 without changing how v1 and the v2 server entry load).
- D2 **Pure core + thin views.** `D:\git\opencode-model-router\src\tui\status-model.ts` (pure, no host imports):
  label formatting (`modelLabel`, `effortLabel`), effective-effort resolution, child-session selection, truncation.
  `D:\git\opencode-model-router\src\tui\plugin.tsx`: registers slots, reads context, renders. All host access is
  feature-detected; a slot never throws (errors render nothing and are logged once).
- D3 **G1** slot `prompt.footer.status` (placement decided in S5): `effort <value>`, where value = selected variant →
  the variant of the session's last assistant message → the agent's configured variant → `default`. Shown only in root
  sessions (no `parentID`). No duplication when the metadata row already shows the selected variant (S3 decides the exact
  rule; acceptance in P1.3).
- D4 **G2** slot `session.composer.top` in a child session: `<model name> · <effort/variant>` of that session's latest
  assistant message (fallback `session.model`), reactive while it runs.
- D5 **G3** slot `session.composer.top` in a root session: one compact row per running child (`data.session.family` ∩
  `status === "running"`): `<agent> · <model> · <effort>`, at most N rows (N from plugin options, default 4) plus `+k`.
  Nothing when no child runs.
- D6 **Effort source.** Default: the message `model.variant`. If S4 finds a reliable server→TUI channel, the server plugin
  publishes the router's effective effort per child (effort override on escalations) and the TUI prefers it; otherwise
  the escalation case is documented as a limitation (one sentence in the docs). Decided in P0.1, recorded as amendment A1.
- D7 **Options.** TUI plugin options (`plugins: [{ package, options }]`): `enabled` (default true), `footer` (G1),
  `childView` (G2), `runningRow` (G3), `maxRows`. Invalid options → defaults + one notice.
- D8 **Packaging.** No bundled `effect`/`@opencode/plugin` (F7); `files` includes the TUI entry; typecheck covers `.tsx`
  (JSX for `@opentui/solid`, decided in S6).

## 3. Waves, phases, tasks

Annotation: `[role:<r>]` is the role to dispatch; `[tier:X]` means add `tier=X pin` to the route line; `[executor]` is
done by the executing orchestrator. Every dispatch starts with a route line, e.g.
`[route class=implement risk=medium scope=multi needs=edit,shell root=D:\git\omr-msd-p13]`.

### Wave 0

#### P0.1 Prerequisites and spikes
Pre-flight: §0.2; PR #89 (v1 feature freeze) merged into `master`; `D:\git\opencode` fetched and fast-forwarded.
- T0.1.1 [executor] Owner override gets `routing.workRoots: ["D:/git/omr-msd-*"]` (temp-HOME validation, backup) and the
  owner restarts OpenCode (restart stop) — role agents only work in worktrees listed at plugin start or matched by
  `routing.workRoots`. Create the integration worktree `D:\git\omr-msd-main` (branch `msd/main` from `origin/master`
  + this plan), `npm ci`, push; open draft PR `msd/main → master`.
- T0.1.2 Spikes [role:medium tier agent for host source; role:implementer for repo probes], each with evidence in
  `D:\git\omr-msd-main\docs\qa\model-effort-status\spikes.md`:
  - S1 entry resolution: how 2.0.24 resolves `tui` for a package without `exports`; whether adding `exports` breaks the v1
    loader (`main`) or the v2 server entry; pick D1's form.
  - S2 the owner's TUI config file (path, format) and how a package plugin is listed with options.
  - S3 effective variant when none is selected (`core/src/session/context.ts:104-113`), and the duplication rule for D3.
  - S4 server→TUI channel for the router's effective effort (plugin `rpc` entry, `storage.store`, server events,
    session fields); verdict for D6.
  - S5 slot placement semantics (`append` vs `replace` on `prompt.footer.status`, ordering with built-ins), reactivity
    of `data.session.message.list` while a child runs, and when a child's first assistant message (with `model`) exists.
  - S6 build/typecheck of a `.tsx` TUI entry in this repo (tsconfig JSX for `@opentui/solid`), allowed imports (F7),
    dev dependencies needed for types only.
  - S7 test strategy: unit-render of Solid components with a fake context (feasible libraries), and an automated
    real-host proof (headless terminal capture of the 2.0.24 TUI, e.g. node-pty + xterm-headless) — or, if impossible,
    the exact manual check for DF-1.
- T0.1.3 [executor] Amendments A1… in §8 from the spike verdicts; adjust §4 ownership if needed.
Tests: spike scripts committed under `D:\git\omr-msd-main\test\spikes\` only if they are reused later; otherwise evidence only.
Acceptance: every S1–S7 has a verdict with file:line or run evidence; D1/D3/D6/D7/D8 decided.
DoD: spikes.md committed; amendments written; QA PASS.
QA [role:reviewer, heavy]: wrong-ref reading (must be v2.0.24 tags), unverified claims, v1 risk of S1's choice.

### Wave 1 (parallel worktrees, ownership §4)

#### P1.1 Status model (pure) [tier:heavy]
Worktree `D:\git\omr-msd-p11`. Pre-flight §0.2.
- T1.1.1 `D:\git\omr-msd-p11\src\tui\status-model.ts`: types mirroring `Model.Ref`/`ModelInfo` minimally (no host
  import), `modelLabel(ref, models)` (display name, fallback id, provider suffix rules), `effortLabel(ref, effectiveEffort?)`,
  `effectiveMainEffort(inputs)` (D3 chain), `childStatus(session, messages)` (D4), `runningChildren(family, status,
  sessions, messages, max)` (D5), width-aware truncation, stable ordering.
- T1.1.2 Options parsing (D7) with notices.
Tests: `D:\git\omr-msd-p11\test\unit\tui.status-model.test.ts` — unknown model id, missing variant, variant not in the
model's list, empty/huge family, mixed idle/running, child without messages yet, model switch mid-session, unicode and
long names, invalid options, deterministic ordering.
Acceptance: 100% branch coverage of the module; no host import; typecheck green.
DoD: tests green, committed; QA PASS.

#### P1.2 Effort channel (server side) — only if A1 says feasible [tier:heavy]
Worktree `D:\git\omr-msd-p12`. Pre-flight §0.2.
- T1.2.1 Publish the router's effective effort per child session (static tier effort, escalation override, role
  dispatch variant) through the channel chosen in S4; v2 only (`D:\git\omr-msd-p12\src\compat\v2-hooks.ts` and a new
  `D:\git\omr-msd-p12\src\tui\effort-channel.ts`); nothing on v1.
Tests: unit tests for the published value per path (tier, role, escalation, resume, unknown child), v1 inert test.
Acceptance: the value equals what `chat.params` applies; tiers mode output unchanged except the channel.
DoD/QA as standard. If A1 says infeasible, P1.2 is dropped and P2.2 documents the limitation.

#### P1.3 TUI plugin entry and packaging [tier:heavy]
Worktree `D:\git\omr-msd-p13`. Pre-flight §0.2 (needs P1.1 merged; reads `status-model.ts` at its merge SHA).
- T1.3.1 `D:\git\omr-msd-p13\src\tui\plugin.tsx` (+ the root entry from S1): `Plugin.define`, slots for G1/G2/G3 per
  D3–D5, options D7, feature detection, error isolation, cleanup on dispose.
- T1.3.2 Packaging: `D:\git\omr-msd-p13\package.json` (`files`, entry, peer/dev deps per S6/F7),
  `D:\git\omr-msd-p13\tsconfig.json` JSX settings; v1 load path untouched.
- T1.3.3 If P1.2 exists: consume the channel, prefer it over the message variant.
Tests: `D:\git\omr-msd-p13\test\unit\tui.plugin.test.ts` (fake context: slots registered, root vs child behaviour,
missing context members, thrown host errors render nothing, options off), `D:\git\omr-msd-p13\test\unit\packaging.test.ts`
additions (TUI entry shipped, no bundled `effect`/`@opencode/plugin`, v1 `main` unchanged), v1 golden untouched.
Acceptance: typecheck green; tests green; `npm pack` contents checked.
DoD/QA as standard.

### Wave 2

#### P2.1 Real-host proof [tier:heavy]
Worktree `D:\git\omr-msd-p21`. Pre-flight §0.2.
- T2.1.1 Gated smoke `D:\git\omr-msd-p21\test\smoke\tui-status.smoke.test.ts` (method from S7) on an isolated 2.0.24
  host with scripted providers: G1 footer text, G2 child view text, G3 running row appears while a scripted child runs and
  disappears after; repeat on 2.0.25 and 2.0.26 (scoop `opencode2` versions or downloaded binaries in a temp dir).
- T2.1.2 v1 untouched: `npm run smoke:v1` with OpenCode 1.18.35 first on PATH; v1 goldens unchanged.
Acceptance: all scenarios pass on the three versions, or a version-specific failure is fixed.
DoD/QA as standard.

#### P2.2 Docs
Worktree `D:\git\omr-msd-p22`. Pre-flight §0.2.
- `D:\git\omr-msd-p22\README.md` (how to enable the TUI entry, screenshot-free text), new
  `D:\git\omr-msd-p22\docs\TUI_STATUS.md`, `D:\git\omr-msd-p22\docs\CONFIG_REFERENCE.md` (TUI options),
  `D:\git\omr-msd-p22\CHANGELOG.md` `[Unreleased]`, docs-drift pins in `D:\git\omr-msd-p22\test\unit\docs-drift.test.ts`
  (options table vs the parser, slot names vs code).
Acceptance: docs match code; docs-drift green. DoD/QA as standard.

#### DF-1 Owner dogfood [executor]
Sync the base checkout to `msd/main` per the previous plans' sync protocol (tag `msd/df1-prev`, clean tree, liveness
probe), add the TUI plugin to the owner's TUI config (validated, backup), restart stop. On resume: the owner confirms G1,
G2, G3 on screen (and pastes `/router`); record in `D:\git\omr-msd-main\docs\qa\model-effort-status\dogfood.md`.

### Wave 3

#### P3.1 Global QA [role:reviewer, heavy ×3 in parallel]
Pre-flight: capped full suite on `msd/main`; CI green on the draft PR head.
Areas: A correctness/UX and host-API use; B packaging, compatibility 2.0.24–2.0.26, v1 freeze; C tests, docs, evidence.
Fixes on `msd/p31-fix-<n>`; rounds per §0.3. Report `D:\git\omr-msd-main\docs\qa\model-effort-status\global.md`.

#### P3.2 Release 2.5.0
Version bump + CHANGELOG entry, release review [role:reviewer, heavy], PR ready, CI green on head, merge with a merge
commit, CI green on the merge SHA, base checkout to `master` (restart stop combined with the **publish question**:
"retomar e publicar" / "retomar sem publicar"), liveness probe, tag `v2.5.0`, `npm view`, clean install; cleanup of
`D:\git\omr-msd-*` worktrees, `msd/*` branches, tags; remove `routing.workRoots` from the owner override (validated,
backup); close #90.

## 4. File ownership (binding)
| Phase | Owns (writes) |
|---|---|
| P1.1 | `src\tui\status-model.ts`, `test\unit\tui.status-model.test.ts` |
| P1.2 | `src\tui\effort-channel.ts`, the channel hunk of `src\compat\v2-hooks.ts`, `test\unit\tui.effort-channel.test.ts` |
| P1.3 | `src\tui\plugin.tsx`, root TUI entry, `package.json`, `tsconfig.json`, `test\unit\tui.plugin.test.ts`, `test\unit\packaging.test.ts` |
| P2.1 | `test\smoke\tui-status.smoke.test.ts`, `test\smoke\helpers\*` (additive) |
| P2.2 | `README.md`, `CHANGELOG.md`, `docs\**` except `docs\plans` and `docs\qa`, `test\unit\docs-drift.test.ts` |
| executor | `docs\plans\**`, `docs\qa\model-effort-status\**`, merges |
P1.1 and P1.2 run in parallel; P1.3 starts after P1.1 is merged (and after P1.2 when it exists); P2.1 and P2.2 in parallel.

## 5. Per-phase acceptance and DoD (standard)
- Acceptance: the phase's listed criteria + typecheck green + touched tests green + new tests with edge cases.
- DoD: committed and pushed; merged into `msd/main` by the executor; phase report
  `D:\git\omr-msd-main\docs\qa\model-effort-status\phase-<id>.md` (pre-flight, implementation, tests, QA rounds and
  findings table, takeovers, verdict); QA PASS with 0 open blocking/critical/major.

## 6. Global acceptance
1. G1, G2, G3 visible on a real 2.0.24 host and on 2.0.25 and 2.0.26 (P2.1 evidence) and confirmed by the owner (DF-1).
2. Nothing changes on OpenCode v1 (goldens unchanged, `smoke:v1` green, v1 loader untouched).
3. The server plugin's behaviour is unchanged except the P1.2 channel (if any).
4. A TUI failure never breaks the TUI: every slot renders nothing on error (tests).
5. Package ships the TUI entry without bundled `effect`/`@opencode/plugin`; clean install from npm verified.
6. Docs match code (docs-drift green); CHANGELOG entry.
7. CI green on the merge SHA; capped suite green on `master`.
8. Global QA PASS (0 open blocking/critical/major).

## 7. Global DoD
`master` contains the change; `v2.5.0` published after the human gate; owner live with the TUI plugin; worktrees,
branches and tags cleaned; `routing.workRoots` removed again; #90 closed with the summary.

## 8. Amendments
Evidence: `D:\git\omr-msd-main\docs\qa\model-effort-status\spikes.md`.

- A1 (D6, S4) **Effort channel feasible: plugin rpc, pull.** P1.2 runs. A plain-object definition (id
  `opencode-model-router.effort`, JSON-Schema `input`/`output`, `events: {}`, no imports) in
  `src\tui\effort-rpc.ts`, shared by both entries; the v2 server plugin registers it with `ctx.rpc.register(def,
  handlers)` at setup and answers `effortOf({ sessionID })` from router memory (route-time agent/model/variant, the
  child's applied effort, the escalation override). The TUI calls `context.client.rpc(def).effortOf({ sessionID })`
  inside a tracked computation: it pulls again whenever the session's `data.session.status(id)` changes or the id/count
  of its latest `data.session.message.list(id)` entry changes, and re-pulls every 5 s while `status === "running"`
  (trigger-driven pulls are debounced to the same interval). It
  never calls from `setup` (setup is awaited inside the serialized reconciliation, `context.tsx:182-184,639-641`). On
  `rpc.unavailable` it retries with bounded backoff; on any other error it falls back to the message variant. Push
  through rpc `events` exists at v2.0.24 (`core/src/rpc.ts:87-104`) and is not used in this release. The registry is
  per location and a re-register with the same id appends (last answers), so tiers mode and several instances are
  safe; the handler must read the same module state the routing writes. Nothing on v1. No `rpc` package subpath.
- A2 (D1, D8, S1, S6) **Root `tui.ts`, no `exports` map, no JSX.** `tui.ts` (package root) re-exports
  `src\tui\plugin.ts` (not `.tsx`): the host's Solid transform skips `node_modules`. Views use the `@opentui/solid`
  reconciler primitives (`createElement`, `insert`, `setProp`) and `solid-js`; the default export is a plain
  `{ id, setup }` object. Runtime imports allowed: `@opentui/solid`, `solid-js` only (served by the host); no new
  `dependencies`. Host context typed structurally in `src\tui\host-types.ts`; the three `@opentui/solid` functions in an
  ambient `src\tui\opentui-solid.d.ts`; `solid-js` as devDependency. `tsconfig.json` unchanged unless P1.3 proves a need.
- A3 (D3, S3) **G1 rule.** Slot `prompt.footer.status`, placement `append`, root sessions (or no session yet): render
  `effort default` when `ui.model.current()?.variant` is unset (the host row shows no variant), nothing when a variant is
  selected (the host row shows it). The "last assistant message / agent variant" steps of D3 are dropped (already folded
  into the selection; the message describes a past turn). QA P0.1 QA-3: P1.2 records, for every session (root
  included), the effort its own `chat.params` actually applied (read `event.options` after `legacy["chat.params"]`,
  `src\compat\v2-hooks.ts:1380`, v2 path only), and `effortOf` answers for root sessions too. G1 renders
  `effort <applied>` when no variant is selected and the channel reports one, `effort default` otherwise. P1.2
  pre-flight states with evidence whether `agentOptions` can hold an effort key for an agent that runs a root session;
  if it cannot, that is recorded and G1 keeps `default`. Applied effort = the `reasoningEffort` in `event.options` after
  the router's hook, whatever set it, normalised as at `src\compat\v2-hooks.ts:1132`, recorded with the turn's
  `{providerID, modelID}`. G1 uses it only when that model equals `ui.model.current()`; otherwise `effort default`.
  P1.2 pre-flight also records whether core pre-fills `event.options` before the hook.
- A4 (D7, S2) **Options and auto-load.** The TUI entry is auto-loaded (`optional`, no options) for every v2 user who
  lists the package in the server config (`context.tsx:301-305`). The TUI plugin id is `opencode-model-router.status`,
  deliberately not the package name: a `tui.json` entry whose `package` equals an already-loaded plugin id is treated as
  an enable selector and its `options` are dropped (`context.tsx:326-332`). Options come from
  `{ "package": "<spec or local path>", "options": … }`; that entry replaces the auto-loaded registration by id
  (`context.tsx:390`). Disable with `-opencode-model-router.status` or `options.enabled: false`. UNVERIFIED: a
  `tui.json` npm entry is resolved with `install: true` (`:306`) and may install a second copy whose version differs from
  the server's; checked at the P3.2 clean install. Local paths must be the package directory, not `tui.ts`
  (`context.tsx:333-341` skips a file silently). Put `-<id>` after any explicit entry for the same plugin (`:396`).
- A5 (D4, S5) **G2 sources.** Latest assistant message `model` (after `Step.Started`), before it the child's
  `session.get(id).model`; the P1.2 effort preferred when available. `data.session.message.sync(id)` once per child when
  the list is empty (feature-detected).
- A6 (S5) **G3 running signal.** `data.session.status(child) === "running"` is used; whether it is set before the first
  response is verified in P2.1 on the real host; a failure there is fixed in P2.1 (owner P1.3 code reopened via a
  `msd/p21-fix` branch).
- A7 (S7) **Tests.** Unit: pure core in vitest; views with a fake context and a mocked `@opentui/solid`, Solid
  reactivity from the reactive build. Real host (P2.1): Node + `@lydell/node-pty` + `@xterm/headless` (devDependencies,
  owned by P2.1), `--standalone` mandatory, local-path plugin entries, wait for a real PID and kill only spawned PIDs,
  env gate `RUN_OC_SMOKE_TUI=1`, script `smoke:tui`.
- A8 (§4) **Ownership.** P1.2 also owns `src\tui\effort-rpc.ts` and the registration hunk of the v2 entry
  (`src\v2*.ts` or `src\compat\v2-hooks.ts`). P1.3 owns `tui.ts`, `src\tui\plugin.ts`, `src\tui\host-types.ts`,
  `src\tui\opentui-solid.d.ts` (instead of `plugin.tsx`). P2.1 owns `package.json`/`package-lock.json` changes for its
  devDependencies and the `smoke:tui` script.
- A9 (§3, QA P0.1 QA-4/QA-10/QA-11) **Task text superseded.** P1.1 `effectiveMainEffort` takes
  `{ selectedVariant?, appliedEffort? }` (A3), not the D3 chain. P1.3 writes `src\tui\plugin.ts` + root `tui.ts`, no JSX,
  `tsconfig.json` unchanged (A2); the packaging test also pins that the package has no root `index.*` (v1's TUI loader
  falls back to a root `index.{ts,tsx,js,mjs,cjs}` for local sources, `v1.18.35:packages/opencode/src/plugin/shared.ts:136-157`).
  P1.3 acceptance gains: the `npm pack` tarball installed into a temp `node_modules` and loaded by path on 2.0.24, 2.0.25
  and 2.0.26 (probe B1 method, executor or a tier agent with shell), and asserts
  `Bun.resolveSync("opencode-model-router/tui", dir)` returns the installed `tui.ts` for `dir` = both the temp install
  root and the package dir (the package-name branch). P2.1 adds the scenarios "server config only, no
  `tui.json`" for a local path and for a `node_modules` install, on the three versions.
- A10 (S2 correction, found in the P1.3 A9 run) **The v2 TUI config file is `cli.json`, not `tui.json`.**
  `v2.0.24:packages/cli/src/config/config.ts:31` `path.join(global.config, "cli.json")` (same at v2.0.26); its schema is
  `{ $schema?, ...Config.Info.fields }` (`cli/src/config/schema.ts:6-9`, the TUI `Config.Info` with `plugins`).
  `tui.json` is a v1 legacy file read only by `cli/src/config/migrate.ts` (key `plugin`, `[pkg, options]` pairs) when
  `cli.json` does not exist. Owner file: `C:\Users\Marquinho\.config\opencode\cli.json` (exists). Every "`tui.json`" in
  A4/A9/§3 means `cli.json`; P2.1, P2.2 and DF-1 use `cli.json`. The P0.1 probe rendered because its server config also
  listed the probe (auto-load), not through `tui.json`.
- A11 (P1.3 QA) **TUI entry rules found on the real hosts.** (a) G2 shows `<agent> · <model> · <effort>` (the agent
  identifies the delegate; D4 amended). (b) Every relative specifier in the TUI closure carries an explicit `.ts`
  (`tui.ts` → `./src/tui/plugin.ts`; `allowImportingTsExtensions`, `noEmit`): with an extensionless re-export the
  2.0.24–2.0.26 hosts loaded `plugin.ts` without serving `solid-js` (`Cannot find package 'solid-js'` from
  `node_modules`); pinned by the packaging test. (c) The host swallows TUI plugin `console.*` output: user-facing notices
  (invalid options, no Solid owner) are toasts. (d) When the channel's `variant` and `effort` differ, child views show
  `<effort> (<variant>)` (P1.2 QA-6).

## 9. Risks
| Risk | Mitigation |
|---|---|
| `entry(["tui"])` needs an `exports` map that changes v1 or server loading | S1 decides; packaging tests pin v1 `main` and the server entry |
| Effort ≠ variant after an effort escalation | S4 channel (P1.2) or documented limitation |
| TUI cannot be driven headlessly | S7 picks the strongest automatable proof; DF-1 owner check is mandatory anyway |
| Host 2.0.25+ rejects bundled `effect` | F7: import only `@opencode/plugin/tui` + `solid-js`; packaging test |
| Windows CI timing flakes (#88) | re-run the failed jobs; never change unrelated tests |
