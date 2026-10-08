# Phase P3.1 — Real-host proof (v2.0.24) and v1 fallback proof (#84)

Branch `rta/p31` (worktree `D:\git\omr-rta-p31`). Plan §5 P3.1, tasks T3.1.1–T3.1.3. Handoffs come from
`docs/qa/role-tier/wave2-handoffs.md` (P3.1 list), `phase-p21.md` and `phase-p23.md`. The phase was run through role agents
(§0.10).

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p31` on `rta/p31`, from `origin/rta/main` @ `19b6fec` |
| `npm ci` | ok |
| Typecheck | exit 0 |
| Hosts | real-host smoke on an isolated OpenCode **2.0.24** host; v1 fallback with OpenCode **1.18.35** first on PATH |

## Implementation

### Commits (`rta/p31`)

| Commit | Purpose |
|---|---|
| `d5f2417` | T3.1.1: `test/smoke/roles.smoke.test.ts` (7 gated tests) and additive harness changes in `test/smoke/helpers/routing-host.ts` |
| `b9ee732` | Run-1 fixes: repository and worktree prepared before the host starts, enforced-mode budget host, tool error text in every status assertion |
| `9aa0d5c` | Run-2 fixes: the exact sibling's main-checkout read is refused; a 64 KiB `router_git_diff` forces host truncation; the missing grader signal pinned and reported |
| `83e00f6` | Run-3 updates: DF2-F1 fixed behaviour asserted (incl. the live shape and a `cwd:` outside the work root); grader rows expected; the 2.0.24 `outputPaths` observation made the only asserted branch |
| `20d4d2d` | Merge `origin/rta/main` into `rta/p31`: the DF2-F1 fix (`rta/p33-fix-1`, `verifyRoot`) and the grader-signal fix (`rta/p33-fix-2`) |
| uncommitted | T3.1.2 unit test `test/unit/roles.v1-fallback.test.ts`; scenario 6 of `test/smoke/routing-engine.smoke.test.ts` repinned; run-4 evidence and its `README.md` under `docs/qa/role-tier/evidence/` (T3.1.3); this report |

### Harness additions (`test/smoke/helpers/routing-host.ts`, additive; earlier smokes unchanged)

| Addition | Purpose |
|---|---|
| `scriptLine` / `CHILD_SCRIPT64` | A scripted child calls one step per request, even a tool its request does not advertise, then answers a final text. Base64 keeps tool names and paths out of the router's classifier; a resume with its own script starts over. |
| `HostOptions.prepare` | Runs before the host process starts. The repository and `wt-1` must exist when the router registers the role agents (worktrees are listed at plugin start). |
| `HostOptions.longPaths` | Long (non-8.3) spelling of the temp root: role work roots refuse 8.3 paths. |
| `HostOptions.routing` as a function | Root-dependent `routing.workRoots` globs. |
| `HostOptions.preProbe` / `PRE_PROBE_PLUGIN` | A plugin loaded before the router. It makes the router's own context hook fail once for one session (I9). |
| `probe.mixNonce` | After the router's `execute.before`, swaps a call's `OMR_NONCE=` line for another call's, so the child carries two dispatches' markers (I5). |

### T3.1.1 — real-host smoke (`RUN_OC_SMOKE_ROLES=1`)

| Test | Proves |
|---|---|
| I2 | For 11 role × class dispatches, the model the provider receives is inside `[floor, ceiling]` and the row's tier matches it. A `tier=heavy pin` reaches heavy. A resume never goes below the running rung. After a deterministic FAIL, the resume of the same session runs one tier up. |
| I3 + I4 | Under a parent without grants and under an allow-all parent, forbidden calls are attempted and refused or absent, and disk, sessions and provider stay unchanged. Covered calls: edit, `execute`, `subagent`, `shell`, reads outside the work root, `router_run` (incl. a foreign `cwd`). Researcher and implementer catalogs keep local/exec/write apart from egress, and so do the host's agent records. A non-role control proves the inputs are well-formed. |
| I5 + I9 | Identical parallel dispatches bind `exact` by their own nonces; a child with two dispatches' markers binds `unknown` (max ∩ local, `external_directory` denied). A router context-hook error empties that step's catalog and annotates the parent. |
| Ladder | `general` without an edit need: edit refused → `router_request_authority` → `ESCALATE: authority` annotation → resume of the same session → edit allowed. The floor is recomputed (medium or above), and the resume row records the widening. |
| Work roots / handoffs | Path resource formats, refusals thrown in `execute.before` reaching the child, glob/grep search roots, `router_git_status` on the bound root, and `router_run` in a worktree created after start (`workRoots` glob). A later worktree without a pattern is refused. DF2-F1 fixed. Own truncated outputs on 2.0.24 (see the observation below). |
| Budget + signals | Enforced role budget: `NEED MORE: budget` for the child, `[router budget]` for the parent, and the resume continues. Signal rows of all seven kinds (`verdict`, `run`, `grader`, `incomplete`, `budget`, `authority`, `redispatch`). A grader verdict is a `grader` row, never a `verdict` row. |
| Exploration | With rate 0.2: an exploration row (`explore: true`, propensity 0.2) for a fast dispatch inside the bounds, and exploit rows at propensity 0.8. |

Every test also asserts zero unknown bindings for normal dispatches.

### T3.1.2 — v1 fallback

- `npm run smoke:v1` (preflight + `smoke:keyless`) with OpenCode 1.18.35 first on PATH: exit 0 (run by the executor).
- `test/unit/roles.v1-fallback.test.ts` loads the plugin on the v1 host path twice, with the same HOME and directory. One override sets every roles key (`routing.delegation: "roles"`, `workRoots`, `exploration`, `run`, `roleAgents`); the other is the same config without them. It proves two things:
  - The roles config registers nothing: no role agent, no `router_run` / `router_request_authority`, the tiers protocol (no `Roles:`), and exactly one `roles delegation requires OpenCode v2; using tiers` notice (none for the base).
  - The SHA-256 of the v1 system prompt, the agent/command config from the `config` hook, the tool set (name, description, argument names) and the hook set are equal for both configs.
- The pre-existing smoke failure "6 v1 untouched" (stale Phase 3.2 pin `71815eb`) is repinned:
  - New base `V1_BASE_COMMIT = "bd1ecd1"`: master before #84 (`eeab36b`, the #83 merge) plus the one literal repair #83 had left stale in the v1 suite. That repair re-points `FAST_MODEL` in `subagent-tiers.smoke.test.ts` to Haiku 5.5 and changes no v1 behaviour.
  - Narrowed to the v1 entry points: the `smoke:keyless` suite files, `vitest.smoke.config.ts`, `scripts/smoke-v1-preflight.mjs`, and the `smoke:keyless` / `smoke:v1` scripts.
  - Every other `test/smoke` change since that base is recorded, not asserted.
  - The justification is a comment at the constant. Verified with `git diff bd1ecd1`: only `test/smoke/helpers/routing-host.ts` and `test/smoke/roles.smoke.test.ts` differ under `test/smoke`. Not yet re-run (needs `npm run smoke:routing`).

### T3.1.3 — evidence

`docs/qa/role-tier/evidence/` holds the seven redacted JSON files of run 4 and a `README.md` (what each file proves and how
to regenerate). They were checked for the user name, its 8.3 short form, `C:\Users`, `sk-`, API keys, tokens and Basic/Bearer
credentials: none. Temp paths carry the harness placeholders `<home>` / `<user>`.

## Tests

| Run | State | Result | Root causes (test vs product) |
|---|---|---|---|
| 1 | `d5f2417` | 1/7 passed | **Test.** (a) Repository and `wt-1` were created after the host started. Role max policies list worktrees at registration (`src/router/role-agents.ts:332-342`), so every worktree access was refused; now prepared before start. (b) The unpinned FAIL dispatch ran on medium, a legitimate pick inside the explorer's range; now pinned `tier=fast` so the raise is observable. (c) The default enforcement mode `advisory` never blocks (`src/guard/enforce.ts:241-248`); the budget host is `enforced`. |
| 2 | `b9ee732` | 4/7 passed | **Test**: the exact sibling's read of the main checkout was correctly refused (outside its work root); the host's grep caps at 100 matches, so nothing was truncated (now a 64 KiB `router_git_diff`). **Product**: no `grader` signal row — `graderSignal` had no call site and a role's grader verdict was written as a weight-1 `verdict` row (§2.6, I6); fixed in `rta/p33-fix-2`. |
| 3 | `9aa0d5c` | 5/7 passed | **Test**: the DF2-F1 observation pin did not reproduce with a scripted child that changes no files; the fix (`rta/p33-fix-1`) was then merged and the test asserts the fixed behaviour, incl. the live shape (child writes the file). The grader tier lookup missed the host's `opus#default` variant (now mapped by model). **Host 2.0.24 observation**: tool-success events carry no `outputPaths`, so a role child's own truncated outputs are unreadable (fail closed, R9(5)). |
| 4 | `20d4d2d` | **7/7 passed** | — |

| Other run | Result |
|---|---|
| `npm run smoke:v1` (OpenCode 1.18.35 first on PATH) | exit 0 (executor) |
| `test-files test/unit/docs-drift.test.ts test/unit/roles.v1-fallback.test.ts` | 2 files, 47/47 passed (docs-drift 45, v1 fallback 2) |
| `typecheck` | exit 0 |

Product defects found by this phase:

| Defect | Fix |
|---|---|
| Grader verdicts of role dispatches written as weight-1 `verdict` rows | `rta/p33-fix-2` |
| DF2-F1 (DF-2 self-test): role gate checks ran outside the work root; proven fixed on the real host | `rta/p33-fix-1` |

The host limitation (no `outputPaths` on 2.0.24) is recorded in R9(5).

## Findings

QA rounds pending (reviewer section).

## Handoffs

| To | Item |
|---|---|
| P3.2 | Document R9(5): on OpenCode 2.0.24 a role child cannot read its own truncated tool outputs (no `outputPaths` on `session.tool.success`; fails closed). |
| P3.2 | Document that role budgets stop a child only in enforcement mode `enforced`. In `advisory` the child gets a warning banner, the call runs, and the parent gets no `[router budget]` note. |
| P3.2 | Document that worktrees created after plugin start are covered only by `routing.workRoots` (role max policies list worktrees at registration). |
| P3.3 | Not covered by the smoke: the host's ripgrep link-following inside the work root (phase-p23 residual); the host budget observer's step-limit and context-overflow path (phase-p21 handoff; the smoke covers the guard budget). |
| P3.3 | wave2-handoffs P3.1 item 2: POSIX-only tests on Linux CI are not part of this phase. |
| Executor | Run `npm run smoke:routing` once to confirm the repinned scenario 6. |
| Executor | Commit the evidence files and this report; `smoke-run-*.log` files stay uncommitted. |

## Takeovers

None.

## Verdict

Pending QA.
