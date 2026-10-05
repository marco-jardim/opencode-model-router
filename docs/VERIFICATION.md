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

`run` commands must be on the allowlist (`npm` / `npx` / `pnpm` / `yarn` / `bun` / `node` / `tsc` / `tsx` / `vitest` / `jest` / `eslint` / `prettier` / `pytest`, plus `uv run pytest …` only) and must not contain shell metacharacters. Per-check timeout applies to all `run` calls.

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
- Every command check (`testsPass`, `buildPasses`, `lintClean`, `run`) takes a machine-wide verification slot, runs at low priority and is bounded by the gate deadline. Checks of one gate run one after another and never hold two slots at once.
- `buildPasses` and `run` also keep the per-workspace mutex. `testsPass` does **not** use it, because that lock would serialize exactly the concurrent gates that [batching](#batching) merges.
- Empty checks array → SKIPPED (never PASS).

## `testsPass`: affected tests, not the whole suite

`testsPass` runs only the tests the change can affect. It then judges any failures against the tree as it was when the delegation was dispatched. The design lives in the `testsPass PIPELINE` header of `src/verify/deterministic.ts` (T1–T11). The flow diagrams are in `docs/FLOW_DIAGRAMS.md` §9–§11.

### Required path (the gate)

A `VERIFY:required` delegation, and every `router_verify` or background run, goes through these steps:

1. **Gate and deadline.** Each gate invocation, and each `router_verify` call, creates one deadline of `gateBudgetMs` with its own `AbortController`. Every later step is bounded by the time that remains. A step whose bound is 0 is not started.
2. **Changed files.** The files come from the tool edits the router observed for the producer session. On a retry or escalation this is the **union of every attempt** in the lineage, all judged against the one dispatch reference. The set also includes:
   - files that were already dirty at dispatch and whose per-file content digest has changed since then;
   - the files of commits made since the dispatch snapshot's head.

   When attribution fails, the set is `"unavailable"`, never `[]`, and the check is unverifiable.
3. **Static scoping.** `planScopedRun` turns the command and the changed files into a scoped spec (vitest `related <files>`, or the affected test files). If no test is affected, the check passes with a note. If scoping is impossible, the check is unverifiable. It never falls back to an unscoped run. Only an explicit `testScope: "full"` runs the resolved command as written.
4. **Slot.** `acquireSlot` waits for a machine-wide slot (`maxConcurrentVerifications`), for at most `slotWaitMs` capped by the deadline. One hold covers the scoped run **and** its recheck.
5. **Scoped run.** The spec runs as argv, never through a shell. It runs at low priority with the `maxWorkers` cap and the deadline's abort signal. Its result is read from the runner's report on every path, including timeout, abort and spawn errors.
6. **Recheck on failure.** If the run has failing tests, their test files are rerun in a temporary worktree materialized at the dispatch reference. The recheck is skipped with fewer than 10 s left (`RECHECK_MIN_REMAINING_MS`). GC, materialization and the rerun share one `recheckTimeoutMs` sub-deadline. A reference that is not **exact** (see [Unverifiable](#unverifiable)) is never rerun.
7. **Verdict.** `judgeScoped(scoped, recheck)` produces the verdict:

| outcome | when | gate result |
|---|---|---|
| **pass** | the scoped run is complete, has no collection error and no failing test; or no test is affected | accepted, labelled `[router ✓ verified: deterministic]` |
| **pass — "no worse than before"** | every failing test id also fails at an **exact** reference, and the scoped inventory is complete | accepted, labelled `[router ✓ verified: deterministic]` with the note `no worse than before; pre-existing failures: …; suite is NOT green` |
| **fail** | at least one failing id is **proven** introduced against an exact recheck: it fails now and passed at the reference, or its test file did not exist at dispatch | rejected; only the introduced ids are named |
| **unverifiable** | anything else (below) | returned **with a caveat** under `[router ⚠ UNVERIFIED: <method>]`, or rejected when `strictUnverifiable` is on |

A fail is always backed by a proven id. A result that cannot be decided either way is unverifiable, never fail and never pass.

8. **Escalation.** A rejection follows the existing `onFailure` handling and the escalation ladder (`docs/ESCALATION.md`). The `delegate` tool retries up the ladder. The native `task` path appends a forcing note.

Residual limits (JS runners, QA-G-7): `vitest related` and `jest --findRelatedTests` follow **static** imports only. A test that reaches the changed file only through a file read (a fixture, a JSON or data file loaded from disk), a dynamic `import()` or `require()` with a non-literal specifier, or a cross-package effect is not run, and the scope can pass without it, or report "no affected tests". Config and global-setup changes are reported as unverifiable. See ADR 0003, "Consequences".

### Deferred path (the default)

The mode is chosen by directives in the orchestrator's dispatch prompt. A subagent cannot select its own mode.

- `VERIFY:required`, or `VERIFY:deferred` (the default).
- `VERIFY_WAIT:<n>s` or `VERIFY_WAIT:<n>ms`: `0` is allowed, and the value is capped at `baselineTimeoutMs`. A malformed value falls back to `captureWaitMs` and is logged.

Deferral applies to delegations whose DoD has a `testsPass` check. Such a DoD defers **as a whole**: its build, lint, `run` and criteria checks are deferred too, also when the producer changed nothing (then with risk `low`). The one exception is a `testsPass`-only DoD whose producer provably changed nothing: it takes the required gate, which passes it ("no changed files") without running a process. A DoD **without** `testsPass` (for example `buildPasses` only) is gated synchronously in either mode, and its checks run before return. On the native `task` path, a dispatch made while the enforcement mode is `off` gets no gate at all. The full list of conditions is in `docs/CONFIG_REFERENCE.md` → "Which delegations defer".

1. **Dispatch.** When the DoD has `testsPass` and `failureRecheck` is on, the router starts a **git-only** reference capture of the working tree. It never runs the test command at dispatch time. The dispatch waits for the capture for at most `VERIFY_WAIT` (default `captureWaitMs`), then starts the producer anyway. The capture keeps running for up to `baselineTimeoutMs`. A capture that fails or times out means "no reference". It never blocks or fails the dispatch.
2. **Producer returns.** The deferred finish takes a git-only tree snapshot, bounded at 2 s (`DEFERRED_FINISH_MS`). From that snapshot it computes:
   - the changed files;
   - static scoping (no spawn);
   - a **risk** level (`low` / `medium` / `high`). Unattributed changes are `high`, and a capture still in flight raises the risk one step.

   It then **registers** a pending entry (TTL `pendingTtlMs`) and returns the producer's result **at once** with a footer shaped like `[router] unverified · vrf_<id> · risk <level>`. No tests run. A deferred result is never labelled verified or accepted.
3. **Later, `router_verify`** (`["vrf_<id>", …]` or `pending: true`), called only if the orchestrator decides to, runs the **same required path** on the **current** tree against the stored reference. It returns a verdict per handle and never dispatches a retry. Per-file digests taken right after the producer returned detect **drift**: when those files changed since then, a pass becomes `unverifiable` with a drift notice naming the drifted paths (a fail stays a fail). A settled verdict is cached: a second call replays it and runs nothing.
4. **`background: true`** (off by default; when off, no queue or timer exists) queues the same run automatically once the settle delay has passed. A fail or unverifiable result becomes a one-time late notice in the orchestrator's system prompt. A pass is silent.

Open handles are listed in the orchestrator's system prompt, newest first, capped at 5. Handles are scoped to the orchestrator session and live in memory: a restarted opencode process loses them (`unknown handle`).

**Lineage caveat.** A native `task` re-dispatch after a rejection captures a reference that already contains the failed attempt. A test that attempt broke would read as pre-existing. The router keeps a per-session ledger of proven-introduced ids and downgrades such a pass to **unverifiable**, with a caveat naming the earlier delegation. The ledger matches ids only, so a renamed test escapes it.

### Batching

Concurrent `testsPass` checks that would run the same program, in the same directory, with the same options and environment, share one **window** of `batchWindowMs`. The window is capped at `gateBudgetMs / 10`, and `0` disables batching.

- The window closes at its deadline, or at once when it holds `maxBatchSize` requests. Arrivals never extend it.
- It also closes **early** when nothing else could join, for example when the gate is alone. A lone request never waits.
- It also closes early before any member's reserve (recheck threshold plus a margin, scaled by the last measured run time) would be eaten.
- Members are **pooled** into one scoped run over the union of their files, one slot hold per batch, only when **every** member's remaining budget covers the batched schedule. Otherwise every member runs **solo**, exactly as it would without batching.
- Each member receives the verdict it would have had solo: failures are attributed back per request and each is rechecked for its own reference. The one exception is a flaky runner, which can turn a would-be pass into unverifiable in a batch. A batch never creates a pass.

### Unverifiable

Unverifiable means the router could not tell whether the change broke tests. It occurs when:

- **the slot is busy**: no verification slot within `slotWaitMs`, or the deadline ran out while waiting;
- **the budget is exhausted**: the scoped run timed out or was aborted, fewer than 10 s were left for the recheck, or the reference rerun timed out;
- **there is no reference**: the capture failed or timed out, had not resolved within the gate budget, the dispatch was not tracked, `failureRecheck` is off, or the reference vanished or could not be materialized;
- **the reference is approximate**: files differ from the dispatch state in a way the reference cannot reproduce. Only inert files such as `coverage/`, `*.log` and caches are ignored;
- **the tests are pytest failures**: a pytest reference rerun is never attempted (`runner-unsupported`), because an editable install imports the live tree's sources. Green pytest runs still pass;
- **a pytest module maps to no test, or a package `__init__.py` was deleted** (`unmapped-module`): see [pytest module mapping](#pytest-module-mapping);
- **an unknown tool ran during the dispatch capture**: see [Dispatch capture and unknown tools](#dispatch-capture-and-unknown-tools);
- **a run is incomplete**: a missing or partial report, a collection error without identifiable test files, a zero-test rerun, or failing ids that cannot be matched to a reference result;
- **scoping is impossible**: changed files are unavailable, or no planner exists for the command (S6);
- the command is not allowlisted, the check errored, or the lineage caveat applies.

By default an unverifiable result is **returned with a caveat** that names the reason. Set `verify.strictUnverifiable: true` to reject it instead. Unverifiable never counts as verified. It is not proof that the tests pass, and it is never labelled accepted or verified (plan G2). A gate that timed out, for example, renders:

```
[router ⚠ UNVERIFIED: none]
Verification caveats — NOT verified (acceptance is not a passing check):
- verification gate timed out after 6000ms
```

A clean pass renders the single line `[router ✓ verified: <method>]` (`deterministic` or `checker`), on the `delegate` tool and on a native `Task()` alike. A pass that carries a caveat (for example concurrent delegations in the same tree) is labelled `UNVERIFIED` too.

### pytest module mapping

pytest has no related-tests mode, so the planner maps changed files to test files itself (Phase 3.1, E2E-1):

- A changed test file is an input itself.
- A changed module maps to every test file that **names** it, joined with the tests named after it (`test_<stem>.py`, `<stem>_test.py`). The names come from one whole-word content search (`git grep -F -w`) for the module's name (its file name without `.py`; for a package's `__init__.py`, the package name) over the `python_files` patterns and `conftest.py`. Any import layout therefore selects the test: a name anywhere in a parenthesised, isort grid-wrapped or backslash-continued list, CRLF or CR line ends, `import app.mod02 as m`, relative imports, `importlib.import_module("app.mod02")`, `__import__`, and `app.mod02.f()`. A longer name such as `mod020` does not match, and a name with regex metacharacters (`mod+1`) is matched literally. The search over-includes (a comment or a string that names the module selects its file too) and never drops a file for its import layout (QA-G-10: the import-shaped `git grep -E` of QA-G-2 missed wrapped imports and passed over a failing importer).
- One exception keeps a module named like the regular package that holds it (`app/app.py` beside `app/__init__.py`) from mapping to every `from app.modNN import …` test (QA-G-2). For such a module only, each hit is read, and a file is dropped when every whole-word `app` in it heads a longer module path in a one-line import statement (`from app.mod01 import x`, `from ..app.mod01 import x`, `import app.mod01, app.mod03 as m`). Every other use keeps the file: `from app import x`, `import app`, `from app.mod01 import app`, `app.mod01.f()`, a string, a comment, a statement split over lines or joined with `;`. A file that cannot be read, is over 1 MiB, or no longer holds the name is kept too. Other modules read nothing, since a module can serve its own dotted names (`six.py` and `from six.moves import x`). A package's `__init__.py` keeps every hit: any import of the package or its submodules runs it.
- It fails closed. When no in-scope test maps to a changed module, or a `conftest.py` names it (its fixtures reach tests that never name the module), the check is unverifiable with S6 `unmapped-module`. More than 20 test files that name it (`STEM_MATCH_LIMIT`, counted after the `app/app.py` exception) give S6 `stem-too-common` rather than a near-full suite. One unmapped module makes the whole change unverifiable. A failed search is S6 `search-failed`.
- Test names are matched literally. Glob metacharacters in a stem (`app/mod0[1-2]_[1-3].py`) are bracketed in the `git ls-files` pathspec, so they never match other tests (QA-G-3).
- Deleted files fail closed too:
  - A deleted or renamed-away `__init__.py`, anywhere in the change set, makes the check unverifiable: S6 `unmapped-module` with `package structure changed: <path> deleted; pytest import paths may shift`. This is decided before any search, so static scoping reports it too, and it applies even when `python_files` matches `__init__.py` (on Windows the name is compared case-insensitively). Without its `__init__.py`, pytest's rootdir-based import (the default `prepend` mode) names and places every module under the directory differently. A relative import there (`from . import helper`) fails. Each test module becomes top-level and can collide with another of the same basename ("import file mismatch"). The directory also goes to the front of `sys.path`, so its modules shadow same-named modules that tests anywhere else import. No static mapping of that is trustworthy. The earlier directory listing ran the package's own tests, but missed the tests broken by shadowing (QA-G-22) and missed a directory whose case differed from the index (QA-G-23), so it was replaced (QA-G-21..23).
  - A deleted module is searched by its own Python name (`index` for `app/index.py`) as a substring (`git grep -F`) over the `python_files` patterns **and `conftest.py`**, joined with the tests named after its stem (QA-G-17). A `conftest.py` that names it gives S6 `unmapped-module`, as for a changed module, since its fixtures reach tests that never name the module (QA-G-19). No test at all gives S6 `deleted-no-tests`, and more than 20 give S6 `stem-too-common`.
  - When the deleted module's package `__init__.py` still exists and names it as a whole word (`from .index import VERSION`), every import of the package now fails, so the importers of the package name (a whole-word search, `conftest.py` included) join the inputs. An `__init__.py` that cannot be read counts as naming it (QA-G-18).
  - A deleted or renamed-away test file is not always a leaf: other tests may import it (`from test_base import Base`, `from .test_base import x`). Its module name is searched as a whole word over the test files and `conftest.py`. The tests that import it run, a `conftest.py` that names it gives S6 `unmapped-module`, and more than 20 give S6 `stem-too-common`. A test file that nothing names only adds the note `deleted test file not run: <path>`, as before (QA-G-20). Each deleted test file counts as one pending search, in static scoping and against the 50-search limit.
- When `testpaths` decides the collection (no path argument, pytest started in its rootdir, every config sets `testpaths`, no `-o testpaths=`, `--pyargs` or `--rootdir`, plain entries only), only tests under it are inputs. In any other case every test under the runner directory is a candidate: an extra input can add a failure, never hide one.

Residual limits: only tests that **name** the module run. A test that reaches the changed module only through another source module (`app/mod02.py` importing `app/mod01.py`), a package re-export (`from app import *`), or a dynamic import that never spells its name (`import_module("app." + n)`) is not run, and the scope can pass without it. For a deleted module, only its own package's `__init__.py` is followed (one level, and only when it names the module). The `app/app.py` exception assumes `app` in `from app.mod01 import x` is the package: it would drop an importer only if `app/app.py` served submodules itself (as `six.py` serves `six.moves`) and a test reached them as `app.<x>` with `app/` on `sys.path` ahead of its parent, or as `.app.<x>` from inside `app/`. A change to non-`.py` files alone (a data file a module reads, `.pyi`, `.pyx`, a binary extension) still gives "no affected tests".

### Dispatch capture and unknown tools

While a dispatch's tree snapshot or reference capture is still in flight (a `VERIFY_WAIT` shorter than the capture, or `VERIFY_WAIT:0s`), a write would land in the baseline and hide itself: "no changed files", or a failure that looks pre-existing at the reference. So the router fails closed (Phase 3.1, E2E-3):

- Only tools known not to write leave an in-flight snapshot or capture alone: `read`, `glob`, `grep`, `list`, `ls`, `codesearch`, `webfetch`, `websearch`, `lsp`, `todoread`, `todowrite`, `question`, `skill`, `plan_enter`, `plan_exit`, `invalid`, `task`, `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`, `delegate` and `router_verify` (`NON_WRITING_TOOLS` in `src/verify/dispatch.ts`).
- Any other tool that runs in an overlapping directory during that window counts as a write: the shells, the edit tools, and every tool the router does not know, **MCP tools** (named `<server>_<tool>`, even read-only ones) and custom or plugin tools included. A tool without a `cwd` argument overlaps every pending capture. That dispatch's change set becomes unavailable and its reference none, so its `testsPass` result is **unverifiable**, never a pass.
- `task` and `delegate` start sessions whose own tool calls are observed, so parallel dispatches do not contaminate each other by starting. Outside the capture window nothing changes.

Residual limits: a write with no tool event (an external editor, an MCP server that writes after its call returned, the user's own `!` shell) cannot be seen by any hook. A tool that writes under a non-writing name (for example a custom tool called `lsp`) is not caught.

Dispatches that start together share their snapshot and capture (one run per key: directory, priority, `baselineTimeoutMs`). A dispatch that arrives just after a run started waits for that run and then its own, while its timeout counts from its own request; when one snapshot or capture takes longer than half of `baselineTimeoutMs`, such an early arrival can time out first. That fails closed: no change baseline, reference none, verdict `unverifiable` (QA-3.1-24).

### Concurrent dispatches in one working tree

Delegations that run at the same time in one working tree share that tree. Their change sets overlap: each dispatch's changed files can include a sibling's edits, and a failure a sibling introduced reads as introduced by this one. A rejection that lists introduced failures while other delegations overlapped it carries the caveat `other delegations ran in this working tree concurrently (N); introduced failures may come from their edits`. This fails closed: a sibling's breakage can reject a delegation, never make a broken one pass. Use separate worktrees for delegations that must be judged in isolation (QA-3.1-2).

### Process limits (all platforms)

- **What a normal exit leaves running** (QA-G-5). When a verification command exits on its own, what it left in the background is ended with it on POSIX: the run's process group is killed when the run settles (`cmd &`, a child that was not waited for). A descendant that left the group (`setsid`, Node's `detached: true`) is not reached. On Windows nothing is swept after a normal exit: the orphan sweep (a PowerShell start, 0.2–6 s of CPU) runs only for a deadline or an abort, so a detached or background descendant of a passing command keeps running outside the verification slot, and repeated verifications can accumulate them.
- **Unhandled signals.** Runs still in flight when opencode exits are killed from a `process.once("exit")` hook. Death by an unhandled signal (SIGTERM, SIGHUP, Ctrl-C, per the host's policy) skips that hook on every platform, POSIX process groups included, so those runs are not killed by the router.

### Windows limits

- **Junction-based `node_modules` at the reference.** The reference worktree links the live tree's `node_modules` with directory junctions. A reference rerun therefore uses today's installed dependencies, not the dependencies from dispatch time. Cleanup takes care not to follow those junctions into the live tree.
- **8.3 short paths.** A project directory (`ctx.directory`) or `%TEMP%` spelled as an 8.3 short path (`C:\Users\ABCDEF~1\…`, the default `%TEMP%` spelling on many hosts) is supported. The recheck resolves the runner and maps paths with the native realpath (long form). Before Phase 3.1 (QA-2.4-23, E2E-2), every reference rerun on such a setup was unplannable (`runner not installed`), so introduced failures were accepted with a caveat.
- **Orphan processes.** Abort kills the process tree of the run. A descendant whose parent died before it was pinned, such as a detached grandchild of a short-lived middle process, cannot be attributed safely and is **not** killed. The run still resolves within the 2 s kill grace (`KILL_GRACE_MS`), and the report notes any force-closed output streams.
- **Orphan sweep needs FullLanguage PowerShell.** The sweeper runs Windows PowerShell 5.1 and needs FullLanguage mode. Under Constrained Language Mode (AppLocker/WDAC) it exits at once and kills nothing; the run appends `[orphan sweep unavailable: <reason>]` to stderr if it has not settled yet.
- **`taskkill` under CPU saturation.** A load that slows `taskkill /T` past its time limit can leave part of a tree running.
- **Low priority is applied after spawn.** On Windows, `lowPriority` lowers the direct child right after it is spawned; descendants inherit the class when created. Anything the child spawns before that call runs at normal priority. The window is tiny, but it is not a guarantee.

## Checker (Independent Grader) Verifier

Builds a skeptical grading prompt from the DoD criteria + assembled artefact and dispatches to a **fresh** grader session:

- Structural producer ≠ grader guarantee, plus a defensive sessionID-inequality check.
- Grader tier = `atLeastProducerTier(producer)`, raised to `verify.minGraderTier`, never below the producer.
- Grader temperature is configured via `graderTemperature` (default `0`). V1's
  `chat.params` hook skips it when the host sets `capabilities.temperature: false`.
  V2's context hook omits it unless the exact `providerID/modelID` is listed in
  `graderTemperatureModels`; v2 exposes no model temperature capability flag.
  Set `graderTemperature` to `null` to remove any temperature value from grader params,
  including one set earlier or on a v2 allowlisted model.
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

**Fail-closed, in both directions.** A gate that runs out of budget never passes: it is `unverifiable` with the reason `verification gate timed out after <n>ms`, rendered `[router ⚠ UNVERIFIED: none]` (returned with that caveat by default, rejected under `strictUnverifiable`), and a failure the gate had already observed before the timeout still rejects it — because the one thing worse than a slow verifier is a fast fabricated pass. And an unusable configured value (zero, negative, non-finite, non-numeric) falls back to the *default* ceiling, never to "no ceiling"; `validateEnforcement` already rejects those in `tiers.json`, so `timeoutMs()` is defence in depth for config that reaches the runtime through an override layer or a hand-built `RouterConfig`.

**A real cancellation, not an abandoned wait.** Every call site pairs the rejection with `session.abort` — directly, or via `disposeChildSession`, which aborts before it deletes. The abort is a genuine server-side call, so the underlying turn actually stops.

**The gate's abort is scoped to its own delegation.** Each `accept()` call tracks the grader sessions *it* opened and aborts only those. The wiring-global grader set is shared by every concurrent delegation, so aborting that here would kill a healthy grader belonging to someone else's work — reachable with the shipped config, where a deterministic check may run a command for up to 120 s against a 90 s gate budget.

**Producer failure is not a timeout special case.** A producer that throws (including on its own ceiling) short-circuits to `pass: false` with `producer failed: <message>`; the gate is not even opened. A non-timeout gate error reports `verification failed (fail-closed)`. `RouterTimeoutError` is a distinct class precisely so these three stay distinguishable instead of collapsing into one message.

## `cwd`-scoped verification

A delegation may declare a `cwd`. When it does, verification is scoped to that directory instead of the router's own:

The native `task` tool has no `cwd` argument: declare `cwd: <dir>` inside its `[acceptance]` block when the producer works elsewhere (for example, in a git worktree). Paths may be plain or surrounded by single or double quotes. A non-empty `args.cwd`, when a tool supplies one, wins over the block's `cwd`; the custom `delegate` tool follows the same rule, including deferred `router_verify` checks. No directory is inferred from free prompt text.

```text
[acceptance]
cwd: "/path/to/worktree"
check: testsPass
[/acceptance]
```

- **Deterministic checks.** `resolveBaseDir` (`src/verify/paths.ts`) resolves the effective base: no `cwd` → the router's directory (byte-identical to the previous behavior), an absolute `cwd` → that path, a relative one → joined onto the router directory. Every `fileExists`, `fileContains`, and command check then resolves through `resolveAgainst` and runs with `cwd` set to that base.
- **The grader session.** `req.cwd` is passed as `query: { directory: req.cwd }` when the grader session is created. Naming the directory in the prompt text is not enough: without the query parameter the grader's own tools resolve against the router's cwd, so it would report "file not found" for files that are plainly there.
- **The producer is deliberately NOT scoped.** Only the verification side takes the `cwd`. The producer runs where OpenCode put it.

An absolute check path bypasses the base directory entirely, and the failure reason says so — it names the path that was actually checked rather than claiming the file was missing "in `<cwd>`", a directory the check never looked in.

As a safety net, if the changed-file list is non-empty and **every** path is absolute and outside the effective base, the deterministic gate skips checks and returns **unverifiable**, with this reason (also a caveat): `the producer changed files only outside <base> (e.g. <firstPath>); checks run there cannot see them. Add "cwd: <dir>" to the [acceptance] block to verify where the work landed.` Any relative path or any path inside the base preserves normal checking; sibling-prefix directories are outside. Both sides are compared as canonical paths (`canonicalPath` in `src/verify/dispatch.ts`, injected through `GateDeps.canonicalPath`), so a Windows 8.3 short name, a symlink or a junction to the base is not mistaken for another directory. This does not apply to the grader branch. The usual `strictUnverifiable` policy applies: accepted with a caveat by default, rejected when strict.

## `verify` config keys

| key | default | notes |
|---|---|---|
| `require` | `"whenDoDPresent"` | `"never"` disables the gate entirely; `"always"` auto-infers when no block is present |
| `preferDeterministic` | `true` | — |
| `graderPolicy` | `"atLeastProducerTier"` | — |
| `minGraderTier` | — | Floor on grader tier regardless of producer |
| `graderTemperature` | `0` | Numeric values respect v1 host temperature capability and are sent on v2 only for listed models. `null` removes any temperature value, even if set earlier or allowlisted. |
| `graderTemperatureModels` | absent | `string[]`; v2-only exact `providerID/modelID` allowlist (absent means none). Override arrays replace rather than concatenate; `[]` clears it. |
| `requireExplicitDoD` | `false` | Mode A: `true` = demand explicit block, no inference |
| `delegateTimeoutMs` | `600000` | Producer turn ceiling — see [Time-boxes](#time-boxes) |
| `graderTimeoutMs` | `60000` | Grader turn ceiling |
| `gateBudgetMs` | `90000` | Whole-gate ceiling |
| `strictUnverifiable` | `false` | `true` rejects an unverifiable verdict instead of accepting it with a caveat |

Resource-budget keys used by `testsPass` and the deferred path: `failureRecheck`, `baselineTimeoutMs`, `captureWaitMs`, `recheckTimeoutMs`, `slotWaitMs`, `maxConcurrentVerifications`, `lowPriority`, `maxWorkers`, `batchWindowMs`, `pendingTtlMs` and `background`. Their defaults and bounds are in `docs/CONFIG_REFERENCE.md`.

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
