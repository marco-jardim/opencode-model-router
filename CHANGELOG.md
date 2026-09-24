# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.13.0] - 2026-09-24

A forced delegation of a request that carries no task produced a `task` call with no
prompt, which the harness rejected with a terse schema error. The router now repairs
such calls or refuses them readably. This release also gives the orchestrator's
read-only allowance a single consistent statement, and stops explicit thinking and
reasoning fields from reaching Claude models that cannot use them.

### Added

- **`taskPromptRepair` fills in or refuses prompt-less `task` calls.** A forced
  delegation of a request that carries no task — a bare greeting sent through an
  explicit tier mention, say — made the model emit a `task` call with a description
  and a tier but no prompt, and the harness rejected it with a bare schema error
  naming the missing key. The `task` before-hook now repairs the call ahead of the
  dispatch header: when `prompt` is absent, `null` or blank and `description` is a
  non-empty string, the trimmed description becomes the prompt and the call proceeds
  with the dispatch header applied normally. When there is no usable description the
  call is refused with a `[router]` error saying that `task` needs a non-empty
  `prompt`, and that a request carrying no task (a greeting, an acknowledgement)
  should be answered directly rather than delegated. A prompt of a non-string type
  is left for the harness, and frozen args that cannot be repaired are left alone.
  The flag defaults to `true`; set `taskPromptRepair: false` to restore the previous
  behaviour. Non-boolean values are rejected by `validateConfig`. See
  `docs/CONFIG_REFERENCE.md`.

### Changed

- **The orchestrator's read-only allowance is stated as one mechanism.** The injected
  protocol gave the same rule three incompatible readings: the orchestrator line said
  information-gathering should be dispatched to @fast rather than run directly, then
  capped direct read-only calls at about two per turn, and the rules array added a
  separate licence for trivial single-call work that acknowledged neither. Dispatch
  is now the stated default, and direct calls are a named allowance for lookups that
  settle a question outright; the trivial-work rules in the shipped `tiers.json` now
  spend that allowance instead of competing with it, and the per-mode overrides are
  reconciled the same way. No cap number moved: the base allowance is still two,
  budget mode is still one, and the dispatch baselines are unchanged. Only the
  protocol prose changed, so the injected prompt and the README's measured
  prompt-size figures move by the length of the new wording. The README's sample
  rules line is regenerated from the shipped configuration; it had shown eight rules
  where the shipped array has ten.

### Fixed

- **The invalid-effort warning goes through the plugin logger.** Every other
  `buildAgentOptions` warning passed the plugin logger, but an unrecognised `effort`
  value always went to `console.warn`, even when a logger was supplied. It now uses
  the logger like its siblings; without one the behaviour is unchanged.

- **Explicit `thinking` and `reasoning` fields are gated for Claude models.**
  `buildAgentOptions` emitted `budget_tokens` and `reasoning_effort` /
  `reasoning_summary` without consulting the model, so a tier on an adaptive-only
  model — the bundled `anthropic` preset's `@medium` is `anthropic/claude-opus-5-5` —
  that also set `thinking.budgetTokens` registered a manual thinking budget on a model
  that only accepts adaptive thinking (the HTTP 400 this is said to cause is reported,
  not reproduced here; see the provider gate in `docs/CONFIG_REFERENCE.md`), and the
  budget outranked the `effort` that would have applied. A Claude tier now never
  registers `reasoning_*` (OpenAI parameters), and a tier on a model whose wire-compat
  catalogue entry carries `rejects_disabled_thinking` (`claude-opus-5-5`,
  `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5-1`, matched by the new
  `isAdaptiveOnlyClaudeModel`) never registers `budget_tokens`; the budget is then
  treated as unset, so `effort` still applies. Each drop warns once per tier.
  Non-Claude tiers are unchanged. Ids of the form
  `<provider>/<namespace>.claude-…`, such as `bedrock/us.anthropic.claude-…`, are not
  recognised as Claude, so they get no Claude prompt prefix, no Anthropic effort
  routing and no gate; the README had claimed they were detected and now says so.

## [1.12.1] - 2026-09-23

The delegate instruction filter introduced in 1.12.0 never removed anything in a live
session, and the change that makes it take effect would, on its own, have deleted
unrelated system-prompt text. Both are fixed together.

### Fixed

- **`delegateInstructions` stripping now reaches the request.** The filter ended with
  `output.system = output.system.flatMap(...)`, which rebinds the hook's output
  property. opencode keeps its own reference to the array it passes to
  `experimental.chat.system.transform` and reads that reference back after the hook
  returns, so every removal was computed and then discarded. Protocol injection had
  always worked only because it used `push`, which mutates the same array. The
  filter now writes its result back with `splice` over the original array and never
  rebinds `output.system`. The 1.12.0 tests passed because they asserted on the
  rebound property rather than on the array the host still holds.

- **Removal is bounded to the instruction file's own text.** A block was defined as
  running from its `Instructions from:` marker to the next marker or the end of the
  entry, which was correct only while each instruction file arrived as its own array
  element. The runtime joins the agent prompt, every instruction file and any
  trailing system text into one string, so the last block extended to the end of
  everything: a reproduction with a trailing `<mcp_instructions>` block lost the whole
  MCP section along with `CLAUDE.md`, shrinking the prompt from 839 to 465 characters.
  The filter now reads the file named by the marker (cached per path and revalidated
  against its modification time) and removes exactly the marker line plus the longest
  rendering of the file's contents — as read, LF-to-CRLF, CRLF-to-LF, or any of those
  with trailing whitespace trimmed — that is an exact prefix of the block, keeping
  whatever follows. If the file cannot be read or does not match, the block is kept
  whole: leaving an instruction in place is unhelpful, deleting an unknown span of
  the system prompt is not recoverable. The reader is an optional fourth parameter
  (`InstructionFileReader`), so tests exercise the logic without touching disk; the
  plugin's call site is unchanged.

## [1.12.0] - 2026-09-23

A subagent was refusing dispatched work outright — returning `ESCALATE: The Task tool
is not available in this session` or `the available tools here are not the
Read/Grep/Glob/Bash tools described in the request` — without making a single tool
call. This release is about the several independent causes behind that, and about an
acceptance gate that was rejecting work for its own inability to check it.

### Fixed

- **The orchestrator delegation protocol no longer leaks into subagent sessions.**
  Classification was an allowlist of tier names: `if (!input.agent ||
  !tierNames.includes(input.agent))`. So `general`, `explore`, every
  markdown-defined agent and — by construction — every agent mapped through
  `subagentTiers` was never recognised as a child, because
  `resolveSubagentOverrides` deliberately skips any name that collides with a tier.
  The two features were mutually exclusive. Unrecognised children were then told
  `You are the orchestrator: route each task to the right tier and delegate it with
  Task(...)`, which is a MANDATORY instruction they have no tool to satisfy, and a
  literal-minded model refuses the dispatch rather than improvising. Children are now
  classified by `parentID`, from the `session.created` event with a memoised
  `session.get` fallback — the code comment had claimed this mechanism for some time,
  but the only event handler began `if (event?.type !== "session.idle") return;` and
  no `session.created` branch existed. Grader sessions are excluded too; they are
  created synchronously and would otherwise stall until their budget expired. The
  guard also now fails closed: a transform with no session id no longer injects.

- **Tier prompts no longer assert a missing capability.** All six shipped prompts
  ended their opening paragraph with `You have no Task tool and cannot sub-delegate.`
  The statement is true — the runtime denies `task` to children on its own — but
  training a hand-back reflex next to orchestrator text demanding delegation is what
  produced `I cannot invoke a medium subagent… dispatch it from the orchestrator`.
  The sentence is replaced with `You execute this dispatch yourself and do not
  re-delegate it`, and a provider-neutral tool-authority clause is appended once at
  agent assembly: your own schema is authoritative, tool names in a dispatch are
  descriptive and vary by provider, an empty search result is a result, and refusing
  because a named tool looks unavailable is not an acceptable answer. This matters
  most in a mixed-family setup, where a dispatch written in one vendor's tool
  vocabulary reads to another vendor's model as a list of tools it does not have.

- **Reading a different region of an already-opened file is no longer flagged as
  redundant.** The read fingerprint was the path alone, so lines 400–600 of a file
  whose first 200 lines had been read collided with the earlier call and produced
  `[⚠ REDUNDANT]`. Combined with prompts that said to stop immediately on that
  marker, it halted legitimate work. The fingerprint now includes any range
  arguments; a read with no range keeps its previous fingerprint exactly, so no
  banner output moved. The prompts now say the marker means stop repeating ground you
  already covered, and that a different region is not a repeat.

- **The announced read-only budget is the one actually charged.** The dispatch header
  resolved the cap from `tierCaps`, while enforcement resolved it from the dispatch's
  own `CAP:` directive and the `reason:` justification rule, so the header could
  announce a budget the guard would not honour. Both sides now read the same
  directive through the same parser, and a test pins their equality so neither can
  drift alone.

- **Subagent-tier mappings now carry a tier.** An agent listed in `subagentTiers` was
  correctly excluded from protocol injection but remained untiered, which silently
  disabled its caps, verification and escalation. It now resolves to its mapped tier.
  Alongside it: a non-2xx `session.get` is no longer cached as "root" (the generated
  client resolves rather than throws, so the error object was read as an absent
  `parentID`), failed lookups are retried after 30s instead of every step, and
  `session.deleted` evicts the classification state.

- **A polynomial-ReDoS finding in delegate instruction filtering.** CodeQL flagged the
  path normalizer behind `delegateInstructions`, the same class as the two 1.11.1
  fixes. Its trailing-slash strip, `/\/+$/`, re-scanned a run of slashes from every
  start offset, so a project directory or an `Instructions from:` marker path made of
  many slashes cost O(n²). It is now a linear backwards scan with identical semantics:
  trim, backslashes to slashes, lower-case, then drop trailing slashes.

### Added

- **Orchestrator instruction files are stripped from delegate sessions**
  (`delegateInstructions`, default `strip-global`). opencode injects instruction
  files — `AGENTS.md`, a global `CLAUDE.md` — into every session, children included.
  A global orchestrator persona therefore reached every delegate telling it to fire
  a `fast` agent via `Task` for any read-only work, and to treat a dispatch's
  `REQUIRED TOOLS` list as a whitelist. Project-local files are kept by default
  because they usually carry conventions the delegate needs; `strip-all` removes
  every instruction file, `keep` restores the previous behaviour.

- **A mechanical dispatch header on every tier dispatch** (`dispatchHeader`, default
  on). Roughly 260 tokens stating the tier identity, that the delegate executes the
  work itself, the working directory and that it is already there, that tool names
  are descriptive rather than restrictive, that empty results are results and
  `.gitignore` filtering is not a broken tool, and the resolved read budget with what
  the runtime's banners mean. This is dispatch hygiene that previously had to be
  retyped by hand into every prompt, which is exactly the kind of thing that stops
  being done.

- **Hand-backs made without trying are detected** (`falseRefusalDetection`, default
  on). A child that returns `ESCALATE:` / `NEED MORE:` / `SCOPE GROWTH:` with a
  capability complaint and **zero recorded tool calls** gets its result annotated for
  the orchestrator: no tool call was observed, so the capability claim is untested
  rather than demonstrated, and a tier escalation on that result is suppressed. The
  detector requires all three signals together, so a genuine scope hand-back after
  real work is untouched.

- **A third verification outcome: `unverifiable`, distinct from a failed check**
  (`enforcement.verify.strictUnverifiable`, default off). The gate was rejecting —
  and the ladder escalating a tier on — its own inability to check: a command the
  allowlist refused, `buildPasses` in a repo with no build script, a grader that
  timed out, a path it could not resolve. None of those are evidence that the
  producer failed. They are now reported as caveats on an accepted result, which
  never claims the check passed; `strictUnverifiable` restores rejection, but
  terminates the ladder instead of escalating. Grader timeouts also scale with tier
  (60s / 180s / 600s) rather than a flat 60s a thinking model cannot meet.

- **`testsPass` is judged against a measured baseline** (`enforcement.verify.testBaseline`,
  default on; `baselineTimeoutMs`, default 60s). A suite with pre-existing unrelated
  failures made every delegation unacceptable. A dispatch-time baseline is now
  captured out of band, keyed by working directory, `HEAD`, a working-tree
  fingerprint and the exact test command, and cached across dispatches. It is
  discarded the moment it could have been contaminated by the producer's own edits,
  because a contaminated baseline errs in the dangerous direction: a newly introduced
  failure would appear in both runs and be excused. Equal failure counts or equal
  non-zero exit codes do not prove the identities are unchanged, so they yield
  `unverifiable` rather than a pass. A green baseline followed by a failure still
  rejects. The grader is also handed the producer's own change delta instead of an
  unqualified dirty tree, so it stops reporting "no files were modified" against
  changes that predate the dispatch.

## [1.11.1] - 2026-08-24

### Added

- **Community health files.** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, a
  pull request template, and a bug report form. The contributing guide writes down the
  parts that are easy to miss from outside: golden snapshots are parameterized over every
  preset and must be regenerated, model refs are only format-validated so the provider id
  has to be checked against the models.dev catalog, and a new preset also needs a
  `fallback.global` chain plus the README and config-reference counts.

### Fixed

- **Two polynomial-ReDoS findings on LLM-influenced input.** CodeQL flagged the guard's
  ad-hoc script detection (`isSelfScript`) and the subagent task-result parser. The guard
  now caps the command it scans at 20k characters and fails closed above that: truncating
  would let padding push a redirect past the scan window, and a shell command that long is
  itself a signal. The task-result parser dropped its regex entirely for a linear `indexOf`
  scan — even a lazy capture backtracks polynomially on repeated open tags with no close —
  keeping the same semantics: first open tag, first close tag after it, case-insensitive,
  trimmed at the use site, raw output as the fallback.

## [1.11.0] - 2026-08-24

### Added

- **A `zai` preset, routing GLM models through the Z.AI Coding Plan.** `@fast` takes
  `glm-4.7`, `@medium` and `@heavy` share `glm-5.3` at `high` and `max` effort. Contributed
  by @MarCYK in
  [#37](https://github.com/marco-jardim/opencode-model-router/pull/37), closing
  [#18](https://github.com/marco-jardim/opencode-model-router/issues/18).

  Landed with three fixes on top. The preset originally named the `zai` provider, but
  `glm-5.3` is not published under it in the models.dev catalog opencode resolves against
  — it exists only under `zai-coding-plan`, whose reasoning options (`low`/`high`/`max`)
  are also what make the `high` and `max` variants valid. All three tiers now point at
  `zai-coding-plan/*` and say so in their descriptions, since the plan is a prerequisite.
  `fallback.global` gained a `zai-coding-plan` chain, so a Z.AI outage now fails over
  instead of dead-ending. And `costRatio` follows the `fable-effort` precedent — `1`/`3`/`6`
  as an estimated token-spend multiplier, not a price difference, because `@medium` and
  `@heavy` are the same model on a flat-rate plan where the catalog prices every model at
  zero.

## [1.10.0] - 2026-08-20

Minor release. Config errors are caught at load instead of drifting to a later turn,
the logging path 1.9.0 introduced is finished — it was losing messages entirely in
short-lived processes, and one warning had never been routed through it at all — and
there is now a smoke lane that needs no credential and therefore actually runs.

### Added

- **A credential-free smoke lane, running on every push.** `opencode debug agent`
  loads the plugin, runs the `config` hook, resolves overrides and registers agents
  with no API key and no model call, so an end-to-end check of registration costs
  ~20s. The existing smoke lane is gated on secrets, which made it a green no-op on
  forks — and meant the only test covering the `config` hook had been asserting the
  pre-1.8.0 anthropic preset for a whole release without anyone finding out. Those
  pins are repaired, and the new lane asserts that **stderr is empty**, which is
  coverage unit tests structurally cannot provide: they hand the plugin a stub client,
  so they have neither a real SDK receiver nor a real process's stderr to check.

- **A malformed tier `model` is rejected when the config loads, not on some later
  turn.** `"model": "claude-sonnet-5"` — a ref missing its provider — used to validate
  clean and only surface as a catalog issue on a turn that happened to have the catalog
  in hand, or never, if the fetch failed. The `provider/model` shape needs no network,
  so it is now decided at load, alongside the existing `effort` and `promptStyle`
  checks. `parseModelRef` moved to `config.ts` (re-exported from `catalog.ts`) so load
  validation and catalog lookup share one definition of well-formed: passing the first
  now guarantees parsing in the second. Observed by @MetalbolicX in
  [#17](https://github.com/marco-jardim/opencode-model-router/issues/17); implementation
  is independent of the fork's.

  Behaviour change for an existing malformed config: an overrides file carrying a bad
  ref is now dropped with a warning naming the offending value, and the bundled
  defaults stand. Startup is never blocked — the layer-drop path already guaranteed
  that, and there is now a test pinning it for this case specifically.

### Fixed

- **The orphaned-pattern warning no longer suggests a fix that cannot apply.** It still
  told the user a provider rename was the likely cause and to update
  `modelGenerations.strong` to match. Since 1.9.0 normalizes separators, a rename is
  matched rather than orphaned, so the only way to reach the warning is a user-authored
  pattern naming something genuinely absent. The copy now says that and forecloses the
  separator fix explicitly.

- **Passive warnings are no longer lost in short-lived processes.** 1.9.0 sent them to
  opencode's log fire-and-forget, which is right for a hook — a warning must never
  block one — but in `opencode run` or `opencode debug` the post never settled before
  the process exited, and the console fallback never fired because nothing had failed.
  The warning reached neither the log nor the terminal. The plugin API has
  `dispose?: () => Promise<void>`, and opencode calls *and awaits* it even on a
  two-second run, so the logger now tracks in-flight posts and `dispose` drains them.
  The tracked promise is the already-`catch`-wrapped one, so a failing post can never
  reject out of teardown. ([#36](https://github.com/marco-jardim/opencode-model-router/issues/36))

- **The `opencode-anthropic-fix` dependency notice reaches the log instead of the
  terminal.** 1.9.0 routed five of the six `warnAgentOptionsEffortOnce` call sites
  through the logger and missed the one in `index.ts`, so that warning kept writing to
  stderr — the exact symptom the change existed to remove. Found by running a real
  process, not by a test; there is now a test.

## [1.9.0] - 2026-08-20

Minor release. One real bug — prompt-style resolution broke when a provider renamed a
model across separators — plus the diagnostics that were compensating for it, which are
gone now that the cause is fixed.

### Fixed

- **`promptStyle: "auto"` survives a provider renaming a model across separators.**
  `isStrongModel` matched patterns case-insensitively but not separator-insensitively, so
  the moment a provider shipped `claude-opus-4.8` where the pattern said `opus-4-8`, the
  tier silently stopped resolving as strong and dropped from `goal-oriented` to
  `prescriptive` — a different system prompt, with nothing said. Matching now normalizes
  case and `.`, `-`, `_` on both sides. The provider boundary is preserved: `/` is not
  normalized, so a pattern cannot match across it. A pattern consisting only of
  separators now matches nothing instead of everything.

  This is not hypothetical drift. Our own `tiers.json` carries the same model as
  `anthropic/claude-haiku-4-5` and `github-copilot/claude-haiku-4.5`, because each
  provider spells it its own way.

- **Passive warnings go to opencode's log instead of the terminal.** `console.warn`
  from a plugin lands on the server's stderr, which the TUI does not own, so a warning
  painted over whatever the terminal was drawing. Stale-model, orphaned-pattern and
  agent-option warnings now post to `POST /log` via `client.app.log` with a
  `model-router` service tag and structured `extra`. Fire-and-forget and fail-soft: a
  server without the endpoint, a rejected post, a post that resolves reporting an error,
  and a synchronous throw all fall back to `console.warn`, so a diagnostic is never
  silently dropped.

  Config-parse warnings deliberately still use `console.warn`. They are emitted from
  `loadConfig`, which runs before a client exists, and they only fire on a malformed
  override file — a case where being loud is the point.

### Removed

- **`modelGenerations.claude5x`.** The field was declared, type-validated on load and
  documented in three places, and never read by anything. `isStrongModel` reads
  `strong`, and the default `strong` list was a module-level constant computed once
  from the built-in array, so a user's `claude5x` could not reach it. Setting it did
  nothing, and passing validation implied otherwise. An existing config carrying the key
  still loads — unknown keys under `modelGenerations` are ignored, not rejected.

  The note that `strong` was "a superset of `claude5x` by construction — every Claude 5.x
  model is a strong model" is gone with it. It had stopped being true in both directions:
  `claude-opus-5` was strong without being in `claude5x`, and `claude-sonnet-5` ships on
  two tiers as a Claude 5 model that is deliberately not strong. `strong` is curated per
  model, and the docs now say so.

- **Near-miss detection for orphaned strong-model patterns.** It existed to spot exactly
  the rename the matcher now absorbs, so under the fixed matcher a near miss *is* a match
  and can no longer be an orphan — the code was unreachable. The `/router models` output
  and the passive warning both drop the "served under a different separator" hint. What
  remains is narrower and honest: a pattern **you** wrote in `modelGenerations.strong`
  that matches nothing your providers serve is still reported, because that is a claim
  about your environment that turned out to be wrong. Shipped defaults are never
  reported — most of a cross-provider union is unserved on any given install, and saying
  so is noise you cannot act on.

### Changed

- **`@opencode-ai/plugin` peer range is now `>=1.0.0 <2.0.0`.** The open-ended `>=1.0.0`
  claimed compatibility with a major version that does not exist yet and whose plugin API
  is by definition unknown.

## [1.8.0] - 2026-08-19

Minor release: every vendor preset is refreshed to the current generation of models.
No routing logic changed — the tier structure, patterns and enforcement behavior are
the same, only the model ids (and the reasoning effort attached to them) move forward.

### Changed

- **`anthropic` preset** now routes `fast` → `sonnet-5`, `medium` → `opus-5` at `high`
  effort, and `heavy` → `fable-5` at `max`.
- **`openai` preset** now routes `fast` → `gpt-5.6-luna-fast`, `medium` →
  `gpt-5.6-terra-fast` at `high` effort, and `heavy` → `gpt-5.6-sol-fast` at `xhigh`.
- **`google` preset** now routes `fast` → `gemini-3.5-flash-lite`, `medium` →
  `gemini-3.7-flash`, and `heavy` → `gemini-3.1-pro-preview`.
- **`github-copilot` preset** now routes `medium` → `claude-sonnet-5` and `heavy` →
  `claude-fable-5`.
- **`hybrid` preset** now routes `medium` → `gpt-5.6-terra-fast` and `heavy` →
  `claude-opus-5` at `max` effort.

## [1.7.0] - 2026-08-19

Minor release: live model-catalog discovery and validation — `/router models`, stale-model
and fallback-chain checks, orphaned strong-pattern detection with near-miss naming — plus
`subagentTiers` for routing pre-existing subagents, resolved prompt style in `/tiers`, and
a set of enforcement and noise fixes. Routing behavior is unchanged unless you opt into
the new keys.

### Added

- **Near-miss reporting for orphaned strong-model patterns.** When a pattern matches
  nothing served, `/router models` and the startup warning now name any served model
  that matches once `.`, `-` and `_` are normalized away. The known failure is a
  provider moving between separator styles rather than a wrong name, so this turns
  "this matches nothing" into "this matches nothing, and here is the id it means".

- **`subagentTiers`, opt-in routing for your own subagents.** A map of agent name to
  tier name repoints pre-existing custom subagents at the active preset's models, so
  they follow `/preset` instead of pinning a model id in their own agent files. A
  subagent that declares no `model` otherwise inherits the model of whoever invoked it,
  which quietly runs cheap read-only helpers at orchestrator prices. Absent or empty
  means no agent is touched.
- **`/router models [provider]`** lists valid model ids from opencode's live provider
  catalog, with each provider's default and any `deprecated`/`alpha`/`beta` status.
- **Stale-model validation.** Bare `/router` checks the active preset's tier models
  against the catalog and reports missing or deprecated ids with the closest valid
  suggestions; the same check is logged once per session. Report-only, so the plugin
  never changes a model for you. A bad model id previously failed silently on every
  subagent dispatch.

### Fixed

- **Orphaned-pattern warnings the user could not act on.** A pattern from the shipped
  default list is now reported only when a near-miss proves the model is served under a
  drifted separator; a pattern you wrote in `modelGenerations.strong` is still always
  reported. An anthropic-only install no longer warns that `claude-mythos-5` matches
  nothing — that provider simply does not sell it.

- **Dormant fallback chains reported as broken.** `fallback-provider-unknown` now fires
  only when the active preset actually routes to that provider. The shipped chains cover
  every provider, so a single-provider install was warning about chains that are inert by
  design. Chain entries naming a preset that does not exist are still reported.

- Removed a stale `buildAgentOptions` from `src/commands/output.ts`. It was live when
  the presentation layer was extracted, but `src/router/agent-options.ts` later became
  the real implementation and gained `effort` handling. The orphan was reachable only
  from its own test, and importing it by mistake would have silently dropped `effort`.

- **`thinking.budgetTokens: 0` no longer swallows a tier's `effort`.** Behavior change:
  suppression used `budgetTokens != null` while emission required a truthy value, so a
  Claude tier with `thinking: { budgetTokens: 0 }` plus `effort` warned that "explicit
  thinking wins" and then registered neither key. A truthy `budgetTokens` is now the
  single notion of "thinking was asked for": `0` is ignored (one-time notice per tier)
  and `effort` applies normally.
- **Enforced-mode hard blocks now apply to non-trivial `@fast` recon.** Trivial
  classification exempted *any* `fast`-tier dispatch whose text matched a `fast`
  taskPattern stem (`read`, `search`, `grep`, …) from enforcement, so a multi-file
  recon dispatch was treated as "trivial" and `guardBeforeCall` downgraded
  `enforced` → `advisory`. The `read_budget` guard could therefore never
  hard-block a `@fast` subagent — the precise runaway it exists to bound.
  `classifyTrivial` now additionally requires single-shot shape: at most one named
  file path (well-known extensionless files like `Makefile` or `LICENSE` count),
  no multi-step marker (numbered or colon-numbered lists, sequencing words, `;`,
  `&&`), no enumeration of three or more subjects, no multiple imperative lines,
  no distributive breadth quantifier (`every` / `all` over a plural or collective
  target class, as in `read all guard modules` — partitive depth over a single
  file such as `read every line of package.json` stays trivial), and a length
  backstop. Genuine single-shot lookups stay exempt, and real work
  was never trivial either way. Present since
  proportional enforcement landed (`80abf05`) and shipped in every release that
  included it. The `enforcement.proportional.trivialBypass` knob and its semantics
  are unchanged.

## [1.6.0] - 2026-08-18

Minor release: a salvage port of the features worth keeping from an abandoned branch —
per-tier reasoning effort, goal-oriented prompts, session-resume accounting, time-boxes
on every verification hop, and idle eviction for the delegation store. Routing behavior
is unchanged unless you opt into the new keys.

### Added

- **Per-tier `effort`.** Each tier may declare a reasoning-effort level that is forwarded
  to the provider on dispatch. The bundled `fable-effort` preset uses it to run all three
  tiers on the same model at different effort levels, so the cost ladder comes from
  reasoning depth rather than model size.
- **Goal-oriented prompt styles.** `promptStyle` (`auto` | `prescriptive` | `goal-oriented`),
  `modelGenerations`, and `tierPromptsGoalOriented` let a tier ship a goal-oriented prompt
  instead of the terse rule list. Under `auto` a tier switches to the goal-oriented text
  when its model matches a declared newer generation; everything else keeps the prescriptive
  prompt.
- **Session-resume accounting.** A resumed session no longer restarts its budget: the
  cumulative ceiling carries across resumes, and registration now returns a `RegisterResult`
  so callers can see whether a dispatch was newly counted or replayed.
- **Time-boxes on delegate, grader, and gate.** `delegateTimeoutMs` (default 600000),
  `graderTimeoutMs` (default 60000), and `gateBudgetMs` (default 90000) bound each hop.
  They are fail-closed: a hop that runs out of budget is reported as unmet, never as
  silently satisfied.
- **Idle-TTL eviction for the delegation store.** Entries idle for more than an hour are
  swept, throttled to at most one sweep every five minutes. The sweep is timer-less — it
  piggybacks on store access — so it adds no background handles and nothing to unref in
  tests.
- **`cwd`-scoped verification.** A delegation may carry a `cwd`, which scopes the
  deterministic file checks and the grader's session lookup to that directory.
- **Evidence-grounding clauses in the medium and heavy tier prompts.** Subagents are told
  to check each reported claim against a tool result from the same session and to say so
  explicitly when a claim is unverified.
- **An explicit `enforcement` block in `tiers.json`.** Every key is now written out at the
  value that was previously the effective default, so the shipped behavior is unchanged and
  readable rather than implicit. `validateEnforcement` type-checks every shipped key.

### Changed

- **`CAP:none` now requires a `reason:` line.** A dispatch that says `CAP:none` without a
  `reason:` line in its text falls back to the tier's baseline cap instead of lifting it.
  The protocol states this in two places (rule 7 and the per-dispatch paragraph), which is
  the whole of this release's prompt growth: the routing protocol goes from 2,970 to 3,089
  characters, and the Claude and enforcement paths grow by the same 119 characters. See the
  token-overhead table in the README.
- **Under `promptStyle: "auto"`, some bundled tiers switch to goal-oriented prompts.** Tiers
  whose model is `claude-fable-5` or `claude-opus-4-8` — `anthropic.heavy`, `hybrid.heavy`,
  and all three `fable-effort` tiers — now receive the goal-oriented text. Set
  `promptStyle` to `prescriptive` to keep the previous prompts.

### Fixed

- **Child-session disposal is idempotent.** Disposing a session that was already disposed
  is a no-op instead of throwing.
- **Gate-timeout aborts are scoped per delegation.** A gate that runs out of budget aborts
  only its own delegation; concurrent delegations are no longer cancelled with it.
- **`fileExists` reasons are honest about absolute paths.** The reason string reports the
  path that was actually checked rather than the relative form that was passed in.
- **No more orphan `lastTouch` entries.** Touch records are removed with their delegation
  instead of accumulating for the lifetime of the process.

### Deliberately not ported

Several things from the source branch were left behind on purpose. The **lessons memory store**
(~800 lines) has no measurement behind it — if it is revisited it must arrive opt-in and
default-false rather than as a new always-on subsystem. The **anti-context-anxiety clause**,
the **INTENT section**, and the **workspace-root line** would re-add the prose that [#21]
deliberately removed. Flipping `activePreset` to `"opus"` would change the default for every
user, and flipping `enforcement.mode` to `"enforced"` would turn an advisory layer into a
blocking one; both stay as they are. `src/guard/smoke-evidence.ts` is test-support only and
carries no runtime behavior, so it was left as optional and not ported.

### Credits

Refactors [#26], [#27], and [#28] by Lucas Húngaro were merged while this port was in
progress, and the ported code is built on top of them.

[#26]: https://github.com/marco-jardim/opencode-model-router/pull/26
[#27]: https://github.com/marco-jardim/opencode-model-router/pull/27
[#28]: https://github.com/marco-jardim/opencode-model-router/pull/28

## [1.5.0] - 2026-08-18

Minor release: update-safe configuration overrides, so customizations survive the plugin
updates that overwrite the cached package file.

### Added

- **Update-safe config overrides.** `~/.config/opencode/opencode-model-router.overrides.jsonc`
  (global) and `<repo>/.opencode/opencode-model-router.overrides.jsonc` (project) are
  deep-merged over the bundled `tiers.json` — specify only the keys you want to change.
  The project file is located by searching upward to the repo root and wins over the
  global file, which wins over the bundled defaults. Models, tiers, and whole presets can
  now be customized without editing the cached package file, which every plugin update
  overwrites. An overrides file can also define an entirely new preset — `model` is the
  only required field per tier: `costRatio`/`steps` default to the conventional `1`/`5`/`20`
  and `30`/`50`/`120` by tier name when omitted, and `description`/`whenToUse` are optional.
  Contributed by Lucas Húngaro. ([#22], closes [#2] and [#4])
- **JSONC in the override files.** `//` and `/* */` comments and trailing commas are
  accepted, via a small zero-dependency parser (`src/router/jsonc.ts`). No new runtime
  dependencies.
- **`/router overrides`** — prints the global and project override paths, which of them
  exist, and the merge precedence.

### Fixed

- **The upward search for the project override file is now bounded.** It stops at a
  `.git`, `.hg`, or `.svn` marker, at 16 levels above the working directory, or at the
  user's home directory. A tree containing no repo marker previously walked all the way
  to the filesystem root, so running opencode from a non-repo directory could silently
  adopt an unrelated ancestor's override file. `package.json` is deliberately not treated
  as a repo marker: in a monorepo it would stop the walk at `packages/<pkg>/` before
  reaching the repo-root `.opencode/`. ([`8710a84`])

[`8710a84`]: https://github.com/marco-jardim/opencode-model-router/commit/8710a84
[#2]: https://github.com/marco-jardim/opencode-model-router/issues/2
[#4]: https://github.com/marco-jardim/opencode-model-router/issues/4
[#22]: https://github.com/marco-jardim/opencode-model-router/pull/22

## [1.4.0] - 2026-08-18

Minor release: session lifecycle fixes, more reliable read-only delegation, and a
smaller routing protocol with measured overhead documentation.

### Fixed

- **Grader and producer child sessions are now parented and disposed.** The plugin
  previously created backend sessions for every grader and producer attempt but never
  aborted or deleted them, including on the happy path, leaving orphaned top-level
  sessions in the TUI. ([`40c9b94`])
- **Layer-2 grading now skips read-only research delegations** when the DoD is inferred,
  checker-only, and no files changed. This prevents false "not accepted" notes on
  legitimate research results. Contributed by Lucas Húngaro. ([#20])
- README prompt-overhead figures now use measured character counts and explicit token
  estimate ranges. The previous `~210 tokens` claim understated the former default
  Claude path by roughly eight to nine times.

### Added

- A drift test now pins the acceptance-check grammar shared by the `/annotate-plan`
  template, `parseAcceptanceBlock`, and the delegation protocol. ([`19171ea`])

### Changed

- **The delegation protocol was rewritten without dropping routing rules.** On the
  default Claude path it is 46.6% smaller, from 7,006 to 3,742 characters. Contributed
  by Lucas Húngaro. ([#21])
- **The anti-narration guardrail is now opt-in.** Set the top-level `antiNarration`
  boolean to `true` to restore the prompt clause and detector; the default is `false`.
  ([#21])
- The package now declares Node.js 20 or later through `engines.node`. ([`6fa9bab`])

[`19171ea`]: https://github.com/marco-jardim/opencode-model-router/commit/19171ea
[`40c9b94`]: https://github.com/marco-jardim/opencode-model-router/commit/40c9b94
[`6fa9bab`]: https://github.com/marco-jardim/opencode-model-router/commit/6fa9bab
[#20]: https://github.com/marco-jardim/opencode-model-router/pull/20
[#21]: https://github.com/marco-jardim/opencode-model-router/pull/21

## [1.3.1] - 2026-08-16

Patch release: bug fixes, documentation, and release-engineering only. No runtime
behaviour changes beyond the corrected `github-copilot` model identifiers.

### Fixed

- **`github-copilot` preset model IDs** now use the dot-separated form the provider
  actually serves (`claude-haiku-4.5`, `claude-sonnet-4.6`, `claude-opus-4.6`) instead of
  the dash-separated variants, and the non-existent `/thinking` suffix has been dropped
  from the `@heavy` tier. Delegations under this preset previously referenced models that
  could not be resolved. ([#10], fixes [#9])
- Golden snapshot for the `github-copilot` delegation protocol realigned with the
  corrected identifiers above.

### Added

- **Continuous integration.** A `Test` workflow runs `npm ci`, the full suite, and
  `npm run typecheck` on Node 24 for every pull request and every push to `master`.
- **Automated publishing via npm Trusted Publishing (OIDC).** Pushing a `v*` tag builds
  and publishes from GitHub Actions with SLSA provenance attestation and no long-lived
  npm token. Third-party actions are pinned by commit SHA.
- **`package-lock.json` is now tracked**, making installs reproducible across
  contributors and CI. It is not included in the published tarball.

### Changed

- README install and configuration instructions corrected and expanded, including how the
  `tiers.json` cache behaves. ([#7])
- Development dependencies `vitest` and `@vitest/coverage-v8` upgraded to 4.x. Both are
  bumped in lockstep because `@vitest/coverage-v8` pins an exact `vitest` peer; Dependabot
  is now configured to group them. Dev-only — no effect on the published package. ([#8])

[#7]: https://github.com/marco-jardim/opencode-model-router/pull/7
[#8]: https://github.com/marco-jardim/opencode-model-router/pull/8
[#9]: https://github.com/marco-jardim/opencode-model-router/issues/9
[#10]: https://github.com/marco-jardim/opencode-model-router/pull/10

## [1.3.0]

### Changed — advisory enforcement is now the default

- **Default enforcement mode flipped `off` → `advisory`.** With `enforcement.mode`
  unset, every non-trivial delegation is now verified and any miss surfaces a
  non-blocking forcing-note; the orchestrator system prompt grows by ~200 tokens for
  the DoD/acceptance section, and subagents may receive non-blocking guard banners.
  Nothing is ever hard-blocked in `advisory`. To restore the previous byte-identical
  behaviour (zero added tokens, zero new latency), set `"mode": "off"` explicitly, run
  `/router enforce off`, or set `MODEL_ROUTER_ENFORCE=0`.
- **The custom `delegate` tool is now hidden by default.** Delegation routes through the
  native `Task()` tool so subagents render inline in the TUI instead of running in an
  invisible orphan session (fixes the `delegate [tier=…, task=…]` stall). The
  independently-verified `delegate` tool remains available behind an opt-in flag.
- The acceptance forcing-note now includes tier-escalation guidance
  (`Task(subagent_type="<nextTier>")`) when a delegated result is not accepted.

### Added

- `experimental.verifiedDelegateTool` config flag in `tiers.json`, and the
  `MODEL_ROUTER_VERIFIED_DELEGATE=1` environment variable, to opt back into the
  authoritative `delegate` tool.

## [1.2.0]

### Added — Enforced delegation (opt-in, default OFF)

A three-layer enforcement system that makes tiered delegation *reliable* instead of
advisory. **It is opt-in and disabled by default**: with `enforcement.mode` unset (or
`"off"`), behaviour is byte-identical to previous releases — no added prompt tokens, no
new runtime behaviour. Enable per repo via `enforcement.mode` in `tiers.json`, per run
via the `MODEL_ROUTER_ENFORCE=1` environment variable, or per session via
`/router enforce <off|advisory|enforced>`. Enforcement applies only to subagent/delegate
sessions; the orchestrator session is never gated.

- **Layer 1 — hard-block guard** (`tool.execute.before`): an in-band, throw-to-block
  guard for subagent sessions. Enforces a tool-call budget ceiling, anti-redundancy
  (repeated identical reads), and anti-self-script (ad-hoc `bash` execution such as
  heredocs / `node -e` / `cat >`), with an optional deliverable-first rule. Writing
  source files is *never* blocked by default (`blockScriptWrites` is opt-in).
  `off` is a no-op, `advisory` surfaces a banner, `enforced` blocks.
- **Layer 2 — independent acceptance gate**: turns "the producer says it's done" into
  "the output was objectively accepted". A Definition-of-Done is parsed from an
  `[acceptance]` block (Mode B) or auto-inferred from the dispatch (Mode A) and checked
  either deterministically (`run` / `fileExists` / `schemaMatch` / `testsPass` /
  `buildPasses` / `lintClean` behind an allowlisted exec/fs seam) or by an **independent
  grader** in a fresh session at a tier ≥ the producer's. Fail-closed: any error,
  unparseable verdict, or non-independent grader counts as a failure. Never silently
  accepts a non-trivial delegation that lacks a checkable DoD.
- **Layer 3 — quality-escalation ladder**: on a failed gate the authoritative `delegate`
  tool retries, then escalates `fast → medium → heavy`, then returns an honest
  `status: unmet` — never a fake pass. Provably terminating (bounded by
  `maxAttemptsPerTier`, `maxTotalAttempts`, and a cost ceiling) and composes with the
  existing advisory provider-failover chain without double-counting attempts.

### Added — tooling & APIs

- New `delegate` tool (authoritative produce → verify → escalate in one call) alongside
  the existing raw `Task()` path (advisory-grade verify-dispatch).
- New `/router enforce <off|advisory|enforced>` command (persisted atomically).
- New `enforcement` configuration block in `tiers.json` (fully validated; see
  `docs/CONFIG_REFERENCE.md`). Per-mode example presets in `docs/ENFORCEMENT_PRESETS.md`.
- TypeScript + Vitest test infrastructure, golden-snapshot characterization tests, and a
  coverage gate. Documentation suite: `docs/ENFORCEMENT.md`, `docs/VERIFICATION.md`,
  `docs/ESCALATION.md`, `docs/CONFIG_REFERENCE.md`, `docs/MIGRATION.md`, and ADRs
  `docs/adr/0000`–`0002`.

### Security

- Secret scrubbing (`scrubText`) is applied to every model-visible string the enforcement
  layers emit — forcing messages, grader prompts, scorecards, and trajectory dumps.
- The deterministic verifier runs only allowlisted binaries, rejects shell
  metacharacters, and blocks interpreter eval flags (`node -e`, `python -c`, …).

### Notes

- Default is OFF; upgrading changes nothing until you opt in. See `docs/MIGRATION.md`.
- The bundled per-mode enforcement presets are **preliminary** (tuned from fixtures, not
  field telemetry) and are documented rather than written into `tiers.json`.
