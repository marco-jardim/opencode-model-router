# Handover — v2 TUI model/effort status (#90)

Paste the prompt in §1 into a new OpenCode session started in `D:\git\opencode-model-router`.

## 1. Prompt for the next session

```
You are the executing orchestrator for plan #90 of opencode-model-router: show model and effort/variant in the
OpenCode v2 TUI (main-session footer, every delegated session's view, and a row of running delegates in the main
session). Read, in this order, and follow them exactly:
1. D:\git\opencode-model-router\docs\plans\v2-model-effort-status-plan.md   (the plan; §0 rules are binding)
2. D:\git\opencode-model-router\docs\plans\v2-model-effort-status-handover.md (this file: state, environment, troubleshooting)
3. D:\git\opencode-model-router\AGENTS.md (v1 is in feature freeze)
If the plan is not on master yet, read it from branch docs/status-display-plan (worktree D:\git\omr-plan-status).

Rules you must apply: iterate wave after wave without stopping, except for a human-only ambiguity, a blocking/critical
problem, an OpenCode restart, or the publish gate. Pre-flight before every phase (fix what you find; only record what the
plan schedules later). After every phase a heavy-tier senior QA (role `reviewer`, adversarial, never the producer); fix
everything in rounds 1-2, from round 3 only blocking/critical/major. QA is always heavy. Always delegate through
model-router with atomic tasks; heavy for complex coding, light dispatches (`runner`) to run and collect tests. Run only
the tests a change touches, in parallel. Commit often (Conventional Commits, body `Refs #90`, no AI attribution, no
Co-Authored-By). Full paths always. If a weaker delegate is repeatedly blocked or verbose on the same step, take that
read or edit over yourself, then resume delegating, and log the takeover. Talk to the user in Brazilian Portuguese;
code, docs and commits in English.

Start with P0.1 pre-flight. The first owner action you need is T0.1.1 (routing.workRoots + restart).
When you stop for a restart, end the message with: "Depois de reiniciar, rode `/router` e cole aqui a linha
`router: engine=… build=…` junto com 'retomar'."
```

## 2. State at handover (2026-10-09)

| Item | Value |
|---|---|
| Plan | `docs\plans\v2-model-effort-status-plan.md` on branch `docs/status-display-plan` (worktree `D:\git\omr-plan-status`, from `origin/master` `31c5687`), pushed; merge it into `msd/main` in T0.1.1 |
| Issue | #90 (open). Related: #86 (cosmetic parallel-refusal message), #88 (Windows CI timing flakes) |
| Pending PR | #89 `docs/v1-feature-freeze` → `master` (AGENTS.md + README + CHANGELOG v1 freeze, D16 pin fix). CI was 15/17 with two #88 flakes; failed jobs re-run. Pre-flight P0.1: if green, merge with a merge commit (`gh pr merge 89 --merge`), then fast-forward the base checkout; if still red only on #88 tests, re-run again |
| Released | `opencode-model-router@2.4.0` (npm, provenance), tag `v2.4.0` on `d3bc2e3`; `master` `31c5687` |
| Base checkout | `D:\git\opencode-model-router` on `master`, clean, loaded by the live host (build `2.4.0+d3bc2e3`) |
| Live host | OpenCode v2.0.24 (scoop `opencode2`), roles mode, `engine: enforce`, enforcement `advisory` |
| Owner override | `C:\Users\Marquinho\.config\opencode\opencode-model-router.overrides.jsonc` = `{"routing":{"engine":"enforce","profile":"balanced","margin":0.2,"delegation":"roles","exploration":{"rate":0.05}}}`, SHA-256 `5F5016CC…3FEF`. Backups: `…overrides.jsonc.bak-2026-10-09_06-46-08` (with workRoots), `…bak-2026-10-09_05-30-50`, kill switch to tiers mode `…bak-2026-10-08_16-10-50` |
| Worktrees of this plan | only `D:\git\omr-plan-status` (branch `docs/status-display-plan`). Integration worktree `D:\git\omr-msd-main` is created in T0.1.1. Also present and still open: `D:\git\omr-v1-freeze` (branch `docs/v1-feature-freeze`, PR #89) — remove it after #89 merges |
| Leftover | empty folder `D:\git\omr-rta-p34` (was held open by the host); delete it after the next restart |
| Other worktrees in the repo | Temp worktrees and `D:\git\opencode-model-router-*` are not ours: leave them |

## 3. Environment

- Platform win32, shell pwsh 7. Base repo `D:\git\opencode-model-router`. OpenCode source `D:\git\opencode` (may always be
  fetched and fast-forwarded on `dev`; read v2 host code at tags `v2.0.24`/`v2.0.25`/`v2.0.26` only).
- OpenCode executables: v2 `C:\Users\Marquinho\scoop\apps\opencode2\2.0.24\opencode.exe` (shim `opencode2`); v1
  `C:\Users\Marquinho\scoop\apps\opencode\1.18.35\opencode.exe` (put that directory first on PATH for `npm run smoke:v1`).
  `opencode` on PATH is the v2 shim.
- Isolated v2 host recipe (used in P3.4 of #84): temp HOME with `.config\opencode\opencode.json` using the v2 keys
  `plugins` and `providers`, env `HOME`, `USERPROFILE`, `XDG_*`, `APPDATA`, `LOCALAPPDATA` pointed at it,
  `OPENCODE_PASSWORD` random (HTTP API answers 401 without Basic auth `opencode:<password>`), strip every credential-like
  env var, `OPENCODE_DISABLE_MODELS_FETCH=true`, `OPENCODE_DISABLE_PROJECT_CONFIG=true`, `OPENCODE_TEST_HOME`. Without a
  working provider the agent list is empty. Prefer the smoke harness
  `D:\git\opencode-model-router\test\smoke\helpers\routing-host.ts` (scripted Anthropic provider, real host).
- Roles mode authority: role agents work only in the session directory or a worktree registered at plugin start or
  matched by `routing.workRoots`. That is why T0.1.1 adds `D:/git/omr-msd-*` and asks for a restart before any phase
  worktree is used. Put `root=<worktree>` on every route line and in ENVIRONMENT.
- `router_run` allowlist: script `typecheck`, scripts `test`/`lint`/`build`, command `test-files` (args `test/*`,
  `--maxWorkers=*`). No raw shell for role agents; the executor runs shell itself.

## 4. Troubleshooting (learned in #84)

- **Heavy subagent dies** with `Decode error … socket connection was closed` or `Overloaded`: the `opencode-anthropic-fix`
  plugin's v2 bridge. Keep ≤ 3 concurrent heavy dispatches; resume the same `sessionID` ("check router_git_status first,
  then continue").
- **"Provider blocked the response"** on large security-review prompts: split the review into smaller areas with neutral
  wording (A1 grants/binding, A2 run/git/paths, A3 guards/text worked).
- **After an OpenCode restart** an old child session resumes with an unknown binding and no work root (fails closed):
  start a fresh dispatch instead of resuming.
- **Resuming a reviewer** keeps the work root it was first bound to; to review another worktree, commit there (refs are
  shared) and use `router_git_diff`/`router_git_show` with refs, or dispatch a fresh reviewer with the other `root=`.
- **Router grader**: often times out (60 s) on long reports (`UNVERIFIED: checker`) and sometimes returns NOT ACCEPTED
  because it sees a truncated criterion. Re-verify yourself (typecheck + touched tests) and rely on the QA round.
- **Deterministic acceptance**: in roles mode a missing `d=` counts as `none`; write `d=deterministic` and an
  `[acceptance]` block with `cwd: <worktree>`. `testsPass` is "unverifiable" when `package-lock.json` changes.
- **Classifier needs**: words like "edit", "fix", "create", "write" in any section give `edit`; `needs=` on the route line
  replaces the text's needs for dynamic roles (implementer/general).
- **Explorer** may refuse to attempt reads outside its root; tell it the refusal is the thing being tested.
- **Delegates hallucinate tool lists** after a widened grant; trust the decision rows (copy
  `C:\Users\Marquinho\AppData\Local\Temp\opencode-model-router-trajectory\decisions.jsonl` before reading; never write it).
- **Windows CI flakes (#88)**: `test/unit/slot.test.ts` (:519, :1027, :1158), `test/integration/batch-wiring.test.ts:909`,
  `test/unit/tree-kill.test.ts` EBUSY, `test/integration/verify-resource-budget.bound.test.ts:785`,
  `test/integration/router-verify-tool.test.ts` cleanup. Re-run the failed jobs (`gh run rerun <id> --failed`); add new
  ones to #88; do not change those tests in this plan.
- **Deleting worktrees with node_modules** is slow; use `cmd /c "rd /s /q <dir>"` and `git worktree prune`. A folder the
  host still watches cannot be removed until the next restart.
- **Never** print `C:\Users\Marquinho\.config\opencode\opencode.json`; never write the router state file; never use .NET
  file APIs in delegations (one incident wrote the base checkout through a relative path).
- **CRLF**: `warning: … CRLF will be replaced by LF` on commit is expected.
- **pwsh**: no `&&` chaining in role prompts; the classifier treats `&&` as a shell need.

## 5. Facts already established (do not redo)
Plan §1.2 F1–F9 were verified at tags v2.0.24–v2.0.26 in `D:\git\opencode`. The open questions are exactly S1–S7 in P0.1.
