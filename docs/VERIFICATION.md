# Verification Gate (Layer 2)

Turns "the producer says it finished" into "the producer's output was objectively accepted" — producer ≠ grader; grader tier ≥ producer tier; one shared gate code path serves both wirings (GA-5).

## Live smoke lane in CI

The gated real-OpenCode smokes (`test/smoke/**`, run locally with `npm run smoke`) are excluded from the default `npm test` and from the per-push `test.yml` matrix — each one spawns a real `opencode run` against a live model.

They run in their own workflow, `.github/workflows/smoke.yml`:

- **Weekly**, on a schedule (Mondays, 07:17 UTC).
- **On demand** — Actions → *smoke* → *Run workflow* (`workflow_dispatch`).
- **Skips green without credentials.** The first step checks for the `ANTHROPIC_API_KEY` and `OPENCODE_API_KEY` secrets; if both are absent (forks, secretless checkouts) every later step is skipped and the run ends green with a `::notice`, never red.

### Dual-key gate and the smoke model

Either credential can drive the lane. **Anthropic wins when both are present** — it is the proven-stable default and needs no tier override.

| Secrets present | Model | `MODEL_ROUTER_SMOKE_MODEL` |
|---|---|---|
| `ANTHROPIC_API_KEY` (with or without the other) | `anthropic/claude-haiku-4-5` | not exported |
| `OPENCODE_API_KEY` only | `opencode-go/qwen3.7-plus` | `opencode-go/qwen3.7-plus` |
| neither | — | lane skipped green |

`MODEL_ROUTER_SMOKE_MODEL` overrides the model in both smoke files. **Unset, the Anthropic path is byte-identical to before** — no file is written and nothing is touched. An *empty* value counts as unset, because a GitHub Actions `env:` entry bound to an empty expression still exports `""`, which would otherwise slip through `??` and produce `--model ""`.

### Why an overrides file is required

`opencode run --model X` sets only the **orchestrator** model. Both smoke tests assert on behaviour inside a plugin-registered **subagent** (`Task(subagent_type="fast")`), whose model comes from the active preset's tier config — so it stays on Anthropic no matter what `--model` says. An earlier attempt that changed only `--model` produced a green run in which the guard-firing subagent was still `anthropic/claude-haiku-4-5`; that green proved nothing.

When `MODEL_ROUTER_SMOKE_MODEL` is set, each smoke file therefore also writes the project overrides file `.opencode/opencode-model-router.overrides.jsonc` (gitignored), repointing `fast`/`medium`/`heavy` of the active preset at the smoke model. Graders resolve through the same config, so they move too.

Two details that are easy to get wrong:

- **`variant: ""` is deliberate.** The bundled `anthropic` preset sets `variant: "high"` on `medium` and `variant: "max"` on `heavy`. The loader deep-merges, so siblings survive and keys cannot be deleted; `src/index.ts` applies `variant` behind a truthiness check, so an empty string is the only way to stop an Anthropic-only knob riding along to a non-Anthropic model.
- **Lifecycle is leak-free.** Each file captures any pre-existing overrides content, writes its own, and restores-or-unlinks in a `finally` — mirroring how `layer2-gate.smoke.test.ts` already manages its temporary repo-root `opencode.json`. The logic is duplicated in both files rather than shared, deliberately: each runs as an independent live process and local reasoning beats cleverness here.

`vitest.smoke.config.ts` sets `fileParallelism: false`. Two concurrent `opencode run` processes contend on the CLI's local SQLite state database and the loser exits 1 after ~0.7s with `Error: Unexpected error / database is locked`.

### Live validation record

Validated **2026-08-19** against `opencode-go/qwen3.7-plus`:

- Full lane green — `guard-hardblock` 137.5s, `layer2-gate` 94.1s, both exit 0.
- The only provider/model pair in either captured transcript was `"providerID":"opencode-go","modelID":"qwen3.7-plus"` — no Anthropic fallback anywhere. `guard-hardblock` now asserts this in-test whenever `MODEL_ROUTER_SMOKE_MODEL` is set, so a silent fallback fails the run instead of passing it.
- **Auth mechanism: the environment variable, nothing else.** Proven by moving `~/.local/share/opencode/auth.json` aside and unsetting `ANTHROPIC_API_KEY`, then running the lane green on `OPENCODE_API_KEY` alone (credential store restored byte-identically, SHA256 verified). CI needs no `opencode auth login` and no materialized `auth.json`.
- `opencode-go/mimo-v2.5` was tried first and **failed behaviourally** as orchestrator: 133.7s, exit 0, but zero read-guard markers — it never drove enough sequential reads to trip the budget. Not a gate regression; it is not a suitable smoke driver.

Cost note: the OpenCode Go arm bills against the OpenCode Zen subscription quota, not per-token Anthropic spend — the weekly lane is ~4 live model calls and is comfortably inside quota.

## Definition of Done

A DoD is an `[acceptance] ... [/acceptance]` block (alias `[dod] ... [/dod]`). **Both** the open and close tags are required (strict); a block missing either tag is silently ignored.

### Directives

```
[acceptance]
check: <kind> [key=value | key="quoted value"]   # repeatable
criteria: <free text>                              # repeatable; non-empty
deliverable: <path or description>                 # last one wins
kind: <enum>                                       # parsed; always re-derived — see Normalization
[/acceptance]
```

### Check kinds

| kind | required keys | optional keys |
|---|---|---|
| `run` | `command` | `expect` (substring in stdout/stderr; exit 0 also required) |
| `fileExists` | `path` | — |
| `schemaMatch` | `path` (JSON file to check), `schema` (inline `{…}` or path to JSON file) | — |
| `testsPass` | — | `command` (default `npm test`) |
| `buildPasses` | — | `command` (default `npm run build`) |
| `lintClean` | — | `command` (default `npm run lint`) |

`run` commands must be on the allowlist (`npm` / `npx` / `pnpm` / `yarn` / `bun` / `node` / `tsc` / `tsx` / `vitest` / `jest` / `eslint` / `prettier`) and must not contain shell metacharacters. Per-check timeout applies to all `run` calls.

### Normalization

The `kind` directive is always **re-derived** from the block's contents — the literal `kind:` value is parsed but ignored:

| condition | derived kind |
|---|---|
| has any `check:` directive | `deterministic` |
| has `criteria:` only | `checker` |
| neither | `none` |

This makes a vacuous always-pass deterministic DoD structurally impossible and prevents a SKIP from being smuggled in via an empty block.

## DoD Sourcing

### Mode A — on-the-fly (dispatch)

Parse the `[acceptance]` block from the dispatch text. If none is present, **auto-infer** one (`inferDoD`):

- Categorises the task: `bugfix` / `refactor` / `writeFile` / `impl` / `test` / `unknown`.
- Adds command-backed checks only when a command hint is available; otherwise falls back to a `checker` DoD whose criterion summarises the dispatch.
- Inference is never vacuous; source is recorded as `inferred`.

`verify.requireExplicitDoD: true` disables inference and demands an explicit block instead.

### Mode B — plan annotation

The plan's own `[acceptance]` block is the DoD (source `annotation`). A non-trivial plan task with no acceptance block is a strict plan-authoring error.

### Proportional skip (GA-6)

A **trivial** dispatch carrying only an **auto-inferred** DoD is skipped. An **explicit** or **annotation** block is always verified regardless of how the dispatch is classified.

### No-files-changed skip

A native `Task()` dispatch is also skipped when all three hold: the DoD is **inferred**, its kind is **checker** (no deterministic checks to run), and the delegation **changed no files**. Inference always synthesizes a criterion from the task's first line, so without this rule a research delegation gets graded against an imperative it was never meant to satisfy, and legitimate findings come back with a false "not accepted" note.

**Know the trade.** This is a property of the delegation, not of its intent, and the two are indistinguishable under an inferred DoD. An *implementation* delegation that reports success but writes no files is skipped by the same rule, so the grader no longer gets a chance to flag "claims the work is done but changed nothing". If you want that case verified, give the dispatch an explicit `[acceptance]` block: explicit and annotation DoDs are always verified, and a `check:` directive makes the DoD deterministic rather than checker-only, so neither condition above is met.

## Artefact

The gate verifies the artefact attributed to the producer session:

```
{
  changedFiles:      // files written/edited by the producer — not a global git diff
  finalReturnText:   // the producer's final return text
  declaredOutputs:   // outputs the producer explicitly declared
}
```

## Verdict

```ts
{
  pass:      boolean
  method:    "deterministic" | "checker" | "none"
  reasons:   string[]
  evidence?: string
  skipped?:  boolean
}
```

**Fail-closed.** Any error, timeout, unparseable grader reply, or non-independent grader yields `pass: false` with a reason. A skipped verdict is never a pass.

## Deterministic Verifier

Runs checks via an injected exec/fs seam. Key invariants:

- Command allowlist enforced; shell metacharacters rejected; per-check timeout applied.
- Whole-repo checks (`testsPass`, `buildPasses`, `lintClean`) run under a per-workspace mutex — concurrent verifications on the same repo cannot race.
- Empty checks array → SKIPPED (never PASS).

## Checker (Independent Grader) Verifier

Builds a skeptical grading prompt from the DoD criteria + assembled artefact and dispatches to a **fresh** grader session:

- Structural producer ≠ grader guarantee, plus a defensive sessionID-inequality check.
- Grader tier = `atLeastProducerTier(producer)`, raised to `verify.minGraderTier`, never below the producer.
- Grader temperature pinned via a `chat.params` hook (default `0`).
- Prompt is anti-rubber-stamp: cite evidence per criterion, default to FAIL on any uncertainty, no benefit of the doubt.
- Grader must return strict one-line JSON `{"pass":boolean,"reasons":[...]}` — unparseable response → FAIL.
- All artefact text, file paths, declared outputs, and grader reasons are scrubbed before reaching or leaving the grader.

## Two Wirings, One Gate (GA-5)

### (i) verify-dispatch — advisory

Observes the built-in `task` tool's after-hook (`<task_result>` text + child session's changed files), runs the gate, and appends a scrubbed forcing note when not accepted. Cannot retry a `task` call that already finished.

### (ii) `delegate` tool — authoritative

The plugin-owned `delegate` tool produces via the OpenCode client, runs the gate, and on FAIL hands off to the Layer-3 escalation ladder. Returns only an accepted result or an honest `status: unmet`. Never returns a fake pass.

## Time-boxes

`session.prompt` has no client-side bound, so a model or transport that never answers would leave a delegation waiting forever — no status, no disposal, nothing for the ladder to act on. Three ceilings in `src/verify/timeout.ts` turn "never returns" into an honest failed attempt:

| key | default | bounds |
|---|---|---|
| `delegateTimeoutMs` | `600000` (10 min) | one producer `session.prompt` turn |
| `graderTimeoutMs` | `60000` (1 min) | one grader `session.prompt` turn |
| `gateBudgetMs` | `90000` (90 s) | the whole acceptance gate, grader ladder included |

**Fail-closed, in both directions.** A gate that runs out of budget is `unmet` with the reason `verification gate timed out after <n>ms` — never accepted, because the one thing worse than a slow verifier is a fast fabricated pass. And an unusable configured value (zero, negative, non-finite, non-numeric) falls back to the *default* ceiling, never to "no ceiling"; `validateEnforcement` already rejects those in `tiers.json`, so `timeoutMs()` is defence in depth for config that reaches the runtime through an override layer or a hand-built `RouterConfig`.

**A real cancellation, not an abandoned wait.** Every call site pairs the rejection with `session.abort` — directly, or via `disposeChildSession`, which aborts before it deletes. The abort is a genuine server-side call, so the underlying turn actually stops.

**The gate's abort is scoped to its own delegation.** Each `accept()` call tracks the grader sessions *it* opened and aborts only those. The wiring-global grader set is shared by every concurrent delegation, so aborting that here would kill a healthy grader belonging to someone else's work — reachable with the shipped config, where a deterministic check may run a command for up to 120 s against a 90 s gate budget.

**Producer failure is not a timeout special case.** A producer that throws (including on its own ceiling) short-circuits to `pass: false` with `producer failed: <message>`; the gate is not even opened. A non-timeout gate error reports `verification failed (fail-closed)`. `RouterTimeoutError` is a distinct class precisely so these three stay distinguishable instead of collapsing into one message.

## `cwd`-scoped verification

A delegation may declare a `cwd`. When it does, verification is scoped to that directory instead of the router's own:

- **Deterministic checks.** `resolveBaseDir` (`src/verify/paths.ts`) resolves the effective base: no `cwd` → the router's directory (byte-identical to the previous behavior), an absolute `cwd` → that path, a relative one → joined onto the router directory. Every `fileExists`, `fileContains`, and command check then resolves through `resolveAgainst` and runs with `cwd` set to that base.
- **The grader session.** `req.cwd` is passed as `query: { directory: req.cwd }` when the grader session is created. Naming the directory in the prompt text is not enough: without the query parameter the grader's own tools resolve against the router's cwd, so it would report "file not found" for files that are plainly there.
- **The producer is deliberately NOT scoped.** Only the verification side takes the `cwd`. The producer runs where OpenCode put it.

An absolute check path bypasses the base directory entirely, and the failure reason says so — it names the path that was actually checked rather than claiming the file was missing "in `<cwd>`", a directory the check never looked in.

## `verify` config keys

| key | default | notes |
|---|---|---|
| `require` | `"whenDoDPresent"` | `"never"` disables the gate entirely; `"always"` auto-infers when no block is present |
| `preferDeterministic` | `true` | — |
| `graderPolicy` | `"atLeastProducerTier"` | — |
| `minGraderTier` | — | Floor on grader tier regardless of producer |
| `graderTemperature` | `0` | — |
| `requireExplicitDoD` | `false` | Mode A: `true` = demand explicit block, no inference |
| `delegateTimeoutMs` | `600000` | Producer turn ceiling — see [Time-boxes](#time-boxes) |
| `graderTimeoutMs` | `60000` | Grader turn ceiling |
| `gateBudgetMs` | `90000` | Whole-gate ceiling |

Full schema: see `docs/CONFIG_REFERENCE.md`.

## Examples

### Deterministic (derived kind: `deterministic`)

```
[acceptance]
deliverable: src/parser.ts
check: fileExists path=src/parser.ts
check: buildPasses
check: testsPass command="npm test -- --testPathPattern=parser"
check: run command="node -e \"require('./src/parser')\"" expect="loaded"
[/acceptance]
```

### Checker (derived kind: `checker`)

```
[acceptance]
deliverable: docs/ARCHITECTURE.md
criteria: Document covers data flow from ingestion to storage with a sequence diagram.
criteria: Every public API surface is listed with request/response shape.
criteria: No section is a copy-paste of the dispatch prompt.
[/acceptance]
```

### Mixed — checks win (derived kind: `deterministic`)

```
[dod]
deliverable: src/auth/token.ts
check: fileExists path=src/auth/token.ts
check: lintClean
check: testsPass
criteria: Token expiry is configurable and defaults to 15 minutes per spec.
[/dod]
```

> Because checks are present the block is `deterministic`; the `criteria:` line does not trigger a grader pass. Add a separate `[acceptance]` block with criteria only if an independent grader review is also required.

### Explicit block on a trivially classified dispatch

```
[acceptance]
deliverable: scripts/migrate.ts
check: fileExists path=scripts/migrate.ts
check: run command="npx tsx scripts/migrate.ts --dry-run" expect="0 rows affected"
[/acceptance]
```

> Even if the dispatch would be classified trivial by GA-6, an explicit block is always verified.

## See also

- `docs/CONFIG_REFERENCE.md` — full schema for the `verify` block and all enforcement keys.
- `docs/ESCALATION.md` — Layer 3: what happens after the gate returns `pass: false`.
