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
| `2d3eaa2` | T3.1.2 `test/unit/roles.v1-fallback.test.ts`; scenario 6 of `test/smoke/routing-engine.smoke.test.ts` repinned; run-4 evidence and its `README.md` (T3.1.3); this report |
| `a976569` | QA round 1 fixes: I9 host proofs, evidence scrub and guard (`test/unit/roles.evidence.test.ts`), v1 base wording, argument schemas, request-body checks |
| `07c3554` | Evidence regenerated from smoke run 5 (7/7) |
| uncommitted | QA round 2 nits: the README and this report for run 5; scenario 6 description; the evidence guard checks the real home and user name |

### Harness additions (`test/smoke/helpers/routing-host.ts`, additive; earlier smokes unchanged)

| Addition | Purpose |
|---|---|
| `scriptLine` / `CHILD_SCRIPT64` | A scripted child calls one step per request, even a tool its request does not advertise, then answers a final text. Base64 keeps tool names and paths out of the router's classifier; a resume with its own script starts over. |
| `decodeScriptsForEvidence` | QA-P31-1-1: the evidence writer replaces every `CHILD_SCRIPT64=<base64>` with the decoded script passed through the redaction, before clipping and redacting the whole. |
| `HostOptions.prepare` | Runs before the host process starts. The repository and its worktrees must exist when the router registers the role agents (worktrees are listed at plugin start). |
| `HostOptions.longPaths` | Long (non-8.3) spelling of the temp root: role work roots refuse 8.3 paths. |
| `HostOptions.routing` as a function | Root-dependent `routing.workRoots` globs. |
| `HostOptions.preProbe` / `PRE_PROBE_PLUGIN` | A plugin loaded before the router. It makes the router's own context hook (`breakSystemTitleContains`) or its permission evaluate hook (`breakEvaluateTitleContains`, QA-P31-1-2) fail once for one session; the trap fires only from the router's stack frames (I9). |
| `probe.mixNonce` | After the router's `execute.before`, swaps a call's `OMR_NONCE=` line for another call's, so the child carries two dispatches' markers (I5). |
| `probe.retarget` | QA-P31-1-2: after the router's `execute.before` approved a call, rewrites its `path` to another path. The host then asks its own permission (`external_directory`) for the new path, and the router's evaluate hook has to decide it. `$ROOT` in probe strings is the host's temp root. |
| lifecycle `messageIn` | The probe's evaluate record carries the message the router set. |

### T3.1.1 — real-host smoke (`RUN_OC_SMOKE_ROLES=1`)

| Test | Proves |
|---|---|
| I2 | For 11 role × class dispatches the model is inside `[floor, ceiling]`. The row's tier matches it, and the request body names that model and that variant's effort (QA-P31 N2). A `tier=heavy pin` reaches heavy. A resume never goes below the running rung. After a deterministic FAIL, the resume of the same session runs one tier up. |
| I3 + I4 | Under a parent without grants and under an allow-all parent, forbidden calls are attempted and refused or absent, and disk, sessions and provider stay unchanged. Covered calls: edit, `execute`, `subagent`, `shell`, reads outside the work root, `router_run` (its own `probe-marker`, absent on disk: QA-P31-1-3; a foreign `cwd` for the runner). Researcher and implementer catalogs keep local/exec/write apart from egress, and so do the host's agent records. A non-role control proves the inputs are well-formed. |
| I5 + I9 | Identical parallel dispatches bind `exact` by their own nonces. A child with two dispatches' markers binds `unknown`: max ∩ local, edit refused, and `router_run` refused with no marker on disk although its exact sibling holds `router_run`. Its `external_directory` of `wt-1`, reached through `retarget`, is denied by the router's evaluate hook with "binding unknown". An exact child of `wt-2` is denied `external_directory` of `wt-1` ("outside this dispatch's work root"). A router context-hook error empties that step's catalog and annotates the parent. A router evaluate-hook error is a deny with the router's "could not check" message. The `external_directory`, evaluate-error and other-root parts were added in QA round 1 and passed on the host in run 5. |
| Ladder | `general` without an edit need: edit refused → `router_request_authority` → `ESCALATE: authority` annotation → resume of the same session → edit allowed. The fresh dispatch runs exactly on its row's tier (QA-P31 N2); the floor is recomputed on resume (medium or above), and the resume row records the widening. |
| Work roots / handoffs | Path resource formats, refusals thrown in `execute.before` reaching the child, glob/grep search roots, `router_git_status` on the bound root, and `router_run` in a worktree created after start (`workRoots` glob). A later worktree without a pattern is refused. DF2-F1 fixed. Own truncated outputs on 2.0.24 (see the observation below). |
| Budget + signals | Enforced role budget: `NEED MORE: budget` for the child, `[router budget]` for the parent, and the resume continues. Signal rows of all seven kinds (`verdict`, `run`, `grader`, `incomplete`, `budget`, `authority`, `redispatch`). A grader verdict is a `grader` row, never a `verdict` row. |
| Exploration | With rate 0.2: an exploration row (`explore: true`, propensity 0.2) for a fast dispatch inside the bounds, and exploit rows at propensity 0.8. |

Every test also asserts zero unknown bindings for normal dispatches. The git fixture runs without user or system git config,
hooks or signing (QA-P31 N3).

### T3.1.2 — v1 fallback

- `npm run smoke:v1` (preflight + `smoke:keyless`) with OpenCode 1.18.35 first on PATH: exit 0 (run by the executor).
- `test/unit/roles.v1-fallback.test.ts` loads the plugin on the v1 host path twice, with the same HOME and directory. One override sets every roles key (`routing.delegation: "roles"`, `workRoots`, `exploration`, `run`, `roleAgents`). The other is the **base**: the same code (this HEAD) with the same configuration minus the roles keys. It proves two things:
  - The roles config registers nothing: no role agent, no `router_run` / `router_request_authority`, the tiers protocol (no `Roles:`), and exactly one `roles delegation requires OpenCode v2; using tiers` notice (none for the base).
  - The SHA-256 of these four is equal for both configs: the v1 system prompt, the agent/command config from the `config` hook, the tool set (name, description, argument names and the arguments' JSON schema, QA-P31-1-4), and the hook set.
- **Equality with the code before #84** is not this test's claim; the pinned goldens and hashes #84 left unchanged prove it. `git diff eeab36b -- test/golden` lists only the new `roles-protocol.golden.test.ts`. The unchanged files are:
  - `test/golden/{assembled-prompt, protocol, prompt-style, narration, tier-prompts, fable-effort-preset, banners}.golden.test.ts` and their `__snapshots__`;
  - `test/integration/v1-roles-line.test.ts`: the whole v1 `output.system` against the SHA-256 of `1fc94a3`, with only the documented #77/#83 deltas inverted;
  - `test/unit/prompt-measurement.test.ts`.
- **"6 v1 untouched"** (the stale Phase 3.2 pin `71815eb`) is repinned to `V1_BASE_COMMIT = "bd1ecd1"`:
  - Where that base comes from: `bd1ecd1` is a commit on the #84 rta line (parent `66dcdff`). For every guarded path it equals master before #84 (`eeab36b`, the #83 merge), except the `FAST_MODEL` literal of `subagent-tiers.smoke.test.ts` that #83 had left on the old Sonnet fast tier. That alignment changes no v1 behaviour.
  - Guarded paths: the `smoke:keyless` suite files, `vitest.smoke.config.ts`, `test/setup/smoke-tmp-guard.ts` (QA-P31-1-5), `scripts/smoke-v1-preflight.mjs`, and the `smoke:keyless` / `smoke:v1` scripts.
  - Every other `test/smoke` change since that base is recorded, not asserted: `routing-host.ts`, `roles.smoke.test.ts` and `routing-engine.smoke.test.ts` itself.
  - The executor's re-run after `2d3eaa2` passed.

### T3.1.3 — evidence

`docs/qa/role-tier/evidence/` holds the seven redacted JSON files of **run 5** (`07c3554`; 2.0.24, `rta/p31` @ `a976569`,
7/7) and a `README.md` (what each file proves and how to regenerate).
- **QA-P31-1-1:** run 4's files held 22 `CHILD_SCRIPT64=<base64>` runs in 5 files with unredacted temp paths inside the base64; they were scrubbed in place in `a976569`. Since then `save()` decodes and redacts every script (`CHILD_SCRIPT64(decoded)=…`), and run 5's files were written that way.
- **Guard:** `test/unit/roles.evidence.test.ts` checks every evidence file, and every base64 script in it decoded, for user paths, credentials, the real home and the user name. The real home comes from the test setup's `REAL_HOME`, its real path and the 8.3 home prefix of the real temp dir (QA round 2 N3). The guard would have failed on the files as committed in `2d3eaa2`. The README checklist says: decode base64, then grep, then run the guard.

## Tests

| Run | State | Result | Root causes (test vs product) |
|---|---|---|---|
| 1 | `d5f2417` | 1/7 passed | **Test.** (a) Repository and `wt-1` were created after the host started. Role max policies list worktrees at registration (`src/router/role-agents.ts:332-342`), so every worktree access was refused; now prepared before start. (b) The unpinned FAIL dispatch ran on medium, a legitimate pick inside the explorer's range; now pinned `tier=fast` so the raise is observable. (c) The default enforcement mode `advisory` never blocks (`src/guard/enforce.ts:241-248`); the budget host is `enforced`. |
| 2 | `b9ee732` | 4/7 passed | **Test**: the exact sibling's read of the main checkout was correctly refused (outside its work root); the host's grep caps at 100 matches, so nothing was truncated (now a 64 KiB `router_git_diff`). **Product**: no `grader` signal row — `graderSignal` had no call site and a role's grader verdict was written as a weight-1 `verdict` row (§2.6, I6); fixed in `rta/p33-fix-2`. |
| 3 | `9aa0d5c` | 5/7 passed | **Test**: the DF2-F1 observation pin did not reproduce with a scripted child that changes no files; the fix (`rta/p33-fix-1`) was then merged and the test asserts the fixed behaviour, incl. the live shape (child writes the file). The grader tier lookup missed the host's `opus#default` variant (now mapped by model). **Host 2.0.24 observation**: tool-success events carry no `outputPaths`, so a role child's own truncated outputs are unreadable (fail closed, R9(5)). |
| 4 | `20d4d2d` | **7/7 passed** | — |
| 5 | `a976569` | **7/7 passed** | — (QA round 1 additions included: the I9 host proofs (a) `external_directory` denied for the unknown binding and for an exact child of `wt-2`, (b) `router_run` refused for the unknown binding with no marker on disk, (c) the evaluate-hook error denied with the router's message; request-body checks; `probe-marker`) |

| Other run | Result |
|---|---|
| `npm run smoke:v1` (OpenCode 1.18.35 first on PATH) | exit 0 (executor) |
| `npm run smoke:routing` scenario 6, after `2d3eaa2` | passed (executor) |
| `test-files test/unit/roles.v1-fallback.test.ts test/unit/roles.evidence.test.ts` (QA round 1) | 2 files, 11/11 passed (v1 fallback 2, evidence guard 9) |
| `test-files test/unit/roles.evidence.test.ts test/unit/roles.v1-fallback.test.ts` (QA round 2, run-5 evidence) | 2 files, 12/12 passed (evidence guard 10, v1 fallback 2) |
| `test-files test/unit/docs-drift.test.ts test/unit/roles.v1-fallback.test.ts` (before QA) | 2 files, 47/47 passed |
| `typecheck` | exit 0 |

Product defects found by this phase:

| Defect | Fix |
|---|---|
| Grader verdicts of role dispatches written as weight-1 `verdict` rows | `rta/p33-fix-2` |
| DF2-F1 (DF-2 self-test): role gate checks ran outside the work root; proven fixed on the real host | `rta/p33-fix-1` |

The host limitation (no `outputPaths` on 2.0.24) is recorded in R9(5).

## Findings

| Id | Severity | Finding (short, round 1) | Fix (`a976569`) |
|---|---|---|---|
| QA-P31-1-1 | major | Evidence `firstUser` kept base64 scripts with `C:\Users\…` (22 lines, 5 files) | `save()` decodes + redacts every script; 22 runs scrubbed in place; unit guard `roles.evidence.test.ts`; README checklist |
| QA-P31-1-2 | major | I9 clauses claimed but not host-tested: unknown binding's `external_directory`, unknown binding's `router_run`, evaluate-hook error | `probe.retarget` + `messageIn`; the unknown child's retargeted read, its `router_run` (sibling holds `router_run`), an exact child of `wt-2`; the pre-probe evaluate trap. Asserted in the I5 + I9 test |
| QA-P31-1-3 | minor | The explorer's `router_run` attempt used the runner's marker | own `probe-marker` script, absent on disk |
| QA-P31-1-4 | minor | "Base" undefined; pre-#84 goldens not named; tool argument names only | v1 test header and this report; argument JSON schemas hashed |
| QA-P31-1-5 | minor | `smoke-tmp-guard.ts` unguarded; `bd1ecd1` comment inaccurate | added to `v1Paths`; comment corrected |
| QA-P31 N1 | nit | Stale lines in this report | refreshed |
| QA-P31 N2 | nit | I2 without the request body; ladder tier `>= fast` | body model + effective effort; exact row tier |
| QA-P31 N3 | nit | Fixture git used the user's config | `GIT_CONFIG_GLOBAL` = empty file, `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=`, `commit.gpgsign=false` |

| Id | Severity | Finding (short, round 2) | Fix (uncommitted) |
|---|---|---|---|
| QA-P31-2 N1 | nit | The evidence README and this report still described run 4 / a pending re-run | both refreshed for run 5 |
| QA-P31-2 N2 | nit | Scenario 6 description said "master before #84 plus the #83 literal repair" | matches the `V1_BASE_COMMIT` comment (rta-line commit, parent `66dcdff`; equals `eeab36b` for the guarded paths except the literal) |
| QA-P31-2 N3 | nit | The evidence guard checked the test's private `homedir()`, not the real home | checks `REAL_HOME` (test setup), its real path, the 8.3 home prefix of the real temp dir, and `os.userInfo().username` (as a path segment when the name is also a role or tier word, e.g. CI's `runner`) |

| Round | Verdict |
|---|---|
| 1 | FAIL — 2 major, 3 minor, 3 nit; all fixed (`a976569`), smoke run 5: 7/7 |
| 2 | PASS — 0 new defects; 3 nits, all fixed |

## Handoffs

| To | Item |
|---|---|
| P3.2 | Document R9(5): on OpenCode 2.0.24 a role child cannot read its own truncated tool outputs (no `outputPaths` on `session.tool.success`; fails closed). |
| P3.2 | Document that role budgets stop a child only in enforcement mode `enforced`. In `advisory` the child gets a warning banner, the call runs, and the parent gets no `[router budget]` note. |
| P3.2 | Document that worktrees created after plugin start are covered only by `routing.workRoots` (role max policies list worktrees at registration). |
| P3.3 (residual) | Host ripgrep link-following inside the work root is not exercised by the smoke (phase-p23 residual). |
| P3.3 (residual) | The host budget observer's step-limit and context-overflow path is not exercised (phase-p21 handoff; the smoke covers the guard's enforced budget). |
| P3.3 (residual) | POSIX-only tests run via Linux CI, not in this phase (wave2-handoffs P3.1 item 2). |

## Takeovers

None.

## Verdict

PASS — 0 open blocking, critical or major findings after QA round 2.
