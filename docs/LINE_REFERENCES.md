# Codebase module index

Reference index for maintainers. All paths relative to the package root. Reference by file + symbol name — no line numbers (they drift).

## Plugin entry

- **`src/index.ts`** — factory function; the sole export target. Exports `export default` (the factory) plus public types only. Named value exports break the opencode loader.

## Router

- **`src/router/config.ts`** — loads, validates, and caches the effective config. Layers, lowest→highest priority: bundled `tiers.json` → global overrides (`~/.config/opencode/opencode-model-router.overrides.jsonc`) → project overrides (`<repo>/.opencode/opencode-model-router.overrides.jsonc`, located by upward search) → persisted state. Also owns `deepMerge` and the `saveActivePreset`/`saveActiveMode`/`saveEnforcementMode` state writers.
- **`src/router/protocol.ts`** — builds the orchestrator delegation protocol string and tier system prompt strings, including Claude adversarial prefixes and anti-narration clauses.
- **`src/router/sessions.ts`** — tracks per-session state: tier, read-only call counts, cap overrides, enforcement context.
- **`src/router/enforcement.ts`** — reads enforcement config; decides whether a session is subject to enforcement and at what mode.
- **`src/router/jsonc.ts`** — pure, zero-dependency JSONC support (`stripJsonc`/`parseJsonc`): strips comments + trailing commas (string-aware) so the override files can use them.
- **`src/router/prompts.ts`** — goal-oriented tier prompts and the style decision. Owns `GOAL_ORIENTED_TIER_PROMPTS` (the built-in defaults, overridable per tier via `tierPromptsGoalOriented`), `isStrongModel` (matches a model against the `modelGenerations` pattern lists), `resolvePromptStyle` (resolves `auto` to `prescriptive` or `goal-oriented`), and `selectTierPrompt` (the single entry point: picks the prompt a tier actually ships with).
- **`src/router/agent-options.ts`** — builds the per-tier provider options object from `TierConfig`, including the `effort` mapping. `buildAgentOptions` is the live one used on the agent-registration path; `warnAgentOptionsEffortOnce`/`resetAgentOptionsEffortWarnings` keep an unsupported-effort warning to one emission per key (the reset exists for tests).
- **`src/router/idle-sweep.ts`** — timer-less idle eviction for the delegation store. `createIdleTtlSweeper` returns a sweep callback that piggybacks on store access rather than holding an interval, so there is no background handle to unref. `DEFAULT_IDLE_TTL_MS` (1 h) is the idle ceiling and `IDLE_SWEEP_THROTTLE_MS` (5 min) the minimum gap between sweeps.

## Layer 1 — hard-block guard

- **`src/guard/guards.ts`** — top-level guard orchestrator; wires `tool.execute.before` decisions.
- **`src/guard/enforce.ts`** — enforcement decision engine; evaluates whether to throw, warn, or pass for a given tool call.
- **`src/guard/store.ts`** — per-session mutable guard state: call counts, fingerprints seen, bypass flags.
- **`src/guard/scrub.ts`** — sanitises tool arguments before fingerprinting to reduce false-positive redundancy hits.
- **`src/guard/fingerprint.ts`** — produces a stable canonical key for a tool call to detect redundant re-reads.
- **`src/guard/narration.ts`** — narration pattern detector; used by the `experimental.text.complete` hook.

## Layer 2 — independent acceptance gate

- **`src/verify/dod.ts`** — Definition-of-Done schema parser and builder; attaches a DoD block to delegation prompts.
- **`src/verify/deterministic.ts`** — cheap deterministic checks (exit code, file existence, output presence) run before grader dispatch.
- **`src/verify/checker.ts`** — orchestrates the full acceptance check sequence: deterministic → grader.
- **`src/verify/gate.ts`** — acceptance gate: accepts or rejects a result; emits structured `AcceptanceResult`.
- **`src/verify/dispatch.ts`** — pure helpers for the verify-dispatch wiring, not the dispatch itself. Owns the changed-file tracking (`extractChangedFile`, `createChangedFileStore`), `parseTaskResult`, `buildDelegationDoD`, `tierModel`, `shouldVerifyTask`, and the two result strings `buildForcingNote`/`buildAcceptedSuffix`. The grader dispatch used to live here; it moved to `wiring.ts` in [#28].
- **`src/verify/wiring.ts`** — the impure seam: everything that touches the OpenCode client, the filesystem, or a subprocess. `createVerificationWiring` builds the exec/fs/grader dependency bundle the pure verifiers are injected with, and is where the grader session is actually opened — scoped to `req.cwd` via `query: { directory }` when the delegation declared one. Also owns `extractAssistantText` and the bounded disposed-session memo (`DISPOSED_MEMO_MAX`) that makes child-session disposal idempotent. Single-copy by design: the second local copy of this bundle is exactly how `cwd` got dropped before.
- **`src/verify/paths.ts`** — pure path math for `cwd` scoping (no fs, exec, or network). `resolveBaseDir` picks the effective base directory for a delegation (no `cwd` → router dir, absolute → as-is, relative → joined onto the router dir); `resolveAgainst` resolves a check path against that base, leaving absolute paths alone.
- **`src/verify/timeout.ts`** — the shared time-box primitives, and the only `setTimeout` in `src/`. `withTimeout` races a promise against a budget and rejects with `RouterTimeoutError` (a distinct class so "timed out" and "failed" stay tellable apart); `timeoutMs` coerces a configured budget, falling back to the default ceiling rather than to no ceiling. Defaults: `DEFAULT_DELEGATE_PROMPT_TIMEOUT_MS`, `DEFAULT_GRADER_PROMPT_TIMEOUT_MS`, `DEFAULT_GATE_BUDGET_MS`. Its own module so `src/index.ts` and `src/verify/wiring.ts` can both import it without a cycle.
- **`src/verify/types.ts`** — shared types for the verify subsystem (`DoDBlock`, `AcceptanceResult`, `GraderRequest`, etc.).

## Layer 3 — quality-escalation ladder

- **`src/escalate/ladder.ts`** — escalation loop: retry → fast → medium → heavy, bounded by attempt and cost ceilings; emits final `status: met | unmet`.

## Telemetry

- **`src/telemetry/trajectory.ts`** — records per-session tool call trajectory for scorecard and dump on `session.idle`.

## Hooks registered by the factory (`src/index.ts`)

| Hook | Purpose |
|------|---------|
| `chat.params` | Pins grader temperature to 0 for deterministic acceptance calls. |
| `chat.message` | Subagent detection (matches `agent` field to registered tier names) + trivial task classification (skips DoD for one-liner lookups). |
| `tool.execute.before` | **Layer-1 hard-block**: throws on budget overruns, redundant reads, and throwaway-script sidesteps in enforced subagent sessions. |
| `tool.execute.after` | Cap banner injection + trajectory recording + Layer-1 state update + Option (i) verify-dispatch after delegation tools complete. |
| `experimental.text.complete` | Narration banner: scans completed text for narration patterns and appends a visible warning. |
| `event` (`session.idle`) | Scorecard / trajectory dump at session end. |
| `config` | Registers tier agents (model, prompt, steps) and slash commands. |
| `experimental.chat.system.transform` | Injects delegation protocol + DoD section into the orchestrator system prompt. |
| `command.execute.before` | Handles `/tiers`, `/preset`, `/budget`, `/bypass`, `/annotate-plan`, `/router`. |
| `tool: { delegate }` | Custom delegate tool (Option ii): authoritative delegation with full enforcement pipeline. |

## Known dead code

- **`src/commands/output.ts` → `buildAgentOptions`** — dead on the display path. Its module header describes it as the display-path counterpart to `src/router/agent-options.ts`, kept separate so `/tiers` never warns or downgrades — but nothing in `src/` calls it any more, `buildTiersOutput` included. The only remaining importer is `test/unit/commands-output.test.ts`. The live builder is `buildAgentOptions` in `src/router/agent-options.ts`. Removing this copy with its tests is a follow-up, deliberately not folded into the salvage port.

[#28]: https://github.com/marco-jardim/opencode-model-router/pull/28
