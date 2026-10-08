# Phase P2.3 — Authority enforcement end to end (#84)

Branch `rta/p23` (worktree `D:\git\omr-rta-p23`). Plan §5 P2.3, tasks T2.3.1–T2.3.4; handoffs from `docs/qa/role-tier/wave2-handoffs.md` (P2.3 list) and the P2.1 report (`phase-p21.md`).

## Pre-flight

| Step | Result |
|---|---|
| Worktree | `D:\git\omr-rta-p23` on `rta/p23`, from `origin/rta/main` @ `b7917bc` |
| `npm ci` | ok |
| Typecheck | exit 0 |
| Baseline | related run: 51 files / 1416 tests passed (medium pre-flight) |
| Ownership | `src/compat/v2-hooks.ts`, `src/routing/wire/dispatch.ts`, `src/index.ts`; `src/router/read-only.ts` for matcher reuse only (left unchanged) |

## Implementation

### Commits (`git log b7917bc..rta/p23`)

| Commit | Purpose |
|---|---|
| `1e2a0ea` | T2.3.1–T2.3.3: per-session `evaluate` narrowing, per-session catalog filter, `execute.before` check, plugin-tool resolvers refuse without the grant, ladder tool allow for dynamic roles, resume rows record the widening |
| `64bc7d8` | T2.3.4: `test/integration/roles-authority.test.ts`; P2.1 registration test binds its children exactly (I9) |
| `d4a7169` | QA round 1 (area A A1–A12, area B B1–B5, N1) |
| `1ae8cbe` | Tests for QA round 1; P2.1 runtime test delegate caller → tier `medium` (A7) |
| `a01646f` | QA round 2 (2-A1 own truncated outputs, 2-A2, 2-A3, 2-B1) |
| `255f06a` | Tests for QA round 2 (nits a–c) |
| `b607cbf` | QA round 3: own outputs from the host's structured `outputPaths` only (QA-P23-3-1) |

### Enforcement matrix (final)

A role session's view = its binding ∩ the role max of the agent the hook names ∩ the role max it was bound as. Checks only ever deny; the agent's max policy decides first.

| Action | Exact binding, work root | Exact, no work root | Unknown / absent binding (I9) |
|---|---|---|---|
| `read` | in grant; every path canonical and inside the root, or exactly one of the session's own outputs | inside the plugin directory, or an own output | `read`/`glob`/`grep` (max ∩ local) inside the plugin directory, or an own output |
| `grep` | in grant; search root (`metadata.path` / `path`, default the session Location) inside the root, or an own output; `include` must not leave its root | as `read` | as `read` |
| `glob` | in grant; search root inside the root; pattern not absolute, drive-qualified, UNC or with `..`; never own outputs | inside the plugin directory | inside the plugin directory |
| `edit` (`write`, `patch`, `apply_patch`) | in grant; every path (`filePath`, `path`, `file_path`, `edits[]`, patch headers) inside the root; none → refused; never own outputs | withheld by `grantFor` | not in max ∩ local → refused |
| `external_directory` | local action in grant; every resource inside the root and the root still a worktree (fresh `git worktree list`, prunable dropped, `.git` shape), or the directory of an own output | own-output directories only | refused |
| `router_run`, `router_git_*` | catalog keeps them only when granted; `execute.before` refuses otherwise; the tools' resolver answers "no root" without the action; `router_run` refuses a foreign `cwd` | `router_run` withheld | tools refuse (no root) |
| `webfetch`, `websearch`, `context7_*` | grant only (researcher) | grant only | not in max ∩ local |
| `router_request_authority` | dynamic roles only | dynamic roles only | dynamic roles only |
| `execute` (Code Mode) | never: removed from the catalog, refused in `execute.before` | never | never |
| any other tool (`subagent`, `shell`, todo, MCP, `router_verify`, …) | refused in `evaluate` and `execute.before`; removed from the catalog | same | same |

| Path rule | Behaviour |
|---|---|
| Canonical form | raw path to `realpathSync.native` (links resolved before `..`); only a truly missing tail is peeled; dangling links and `..` in a missing tail refused; win32 8.3, UNC/device, drive-relative and drive-less rooted paths refused before any filesystem call |
| Containment | `permissionMatches` of `read-only.ts` on `<root>` and `<root><sep>*` (win32 case folding); a wildcard root contains nothing |
| Own outputs | only `outputPaths` on the session's own tool-success event (`session.tool.success`, `session.next.tool.success`, optional `.<n>`); tool-output store shape; bounded; cleared on `session.deleted` |

| Failure | Behaviour |
|---|---|
| `evaluate` error, role agent | deny with an explicit message (P-3); other agents unchanged |
| Event without agent, lookup failed or session names no agent | known role session (dispatch record or binding) → deny |
| Context hook error, failed binding lookup, session without agent | catalog emptied, parent annotated ("had no tools for at least one step; …") once per attempt |
| Session with agent, no parent | unknown-binding view (max ∩ local), no notice |

### Host behaviour verified (`D:\git\opencode` @ `907b3bc51`, `packages/core/src` unless stated)

| Fact | Source |
|---|---|
| `read`/`edit`/`write`/`apply_patch` resources are Location-relative, or canonical absolute outside the Location | `location-mutation.ts:132-134` |
| `external_directory` resource is `<canonical dir>/*` | `location-mutation.ts:135-137` |
| `glob`/`grep` resource is the pattern; search directory in `metadata.path`; no `external_directory` asked | `tool/glob.ts:62-70`, `tool/grep.ts:81-95` |
| `apply_patch` input `patchText`; headers `*** Add/Update/Delete File:`, `*** Move to:`; moves refused | `tool/apply-patch.ts`, `patch.ts:35-57` |
| Truncated output saved to `<data>/tool-output/tool_<id>`; `outputPaths` on `SessionEvent.Tool.Success` (`session.next.tool.success`) | `tool-output-store.ts:118-171`, `tool/registry.ts:75-81`, `session/runner/publish-llm-event.ts:363-373`, `packages/schema/src/session-event.ts:342-350` |
| Host default rules allow `external_directory` for `<data>/tool-output/*` | `plugin/agent.ts:11`, `:101-110` |
| The router's plugin protocol (2.0.22) names the event `session.tool.success`, without `outputPaths` | `node_modules/@opencode/protocol/dist/groups/session.d.ts` |

## Tests

| Run (last on each state) | Result |
|---|---|
| `npx tsc --noEmit` before every commit | exit 0 |
| `vitest run test/integration/roles-authority.test.ts --maxWorkers=4 --testTimeout=30000` @ `b607cbf` | 1 file; 30 passed, 1 skipped (POSIX symlink test on win32) |
| `vitest related src/compat/v2-hooks.ts --run --maxWorkers=4 --testTimeout=30000 --hookTimeout=60000` @ `b607cbf` | 9 files; 443 passed, 1 skipped |
| `vitest run` roles-authority + roles.registration + roles.runtime (`--testTimeout=30000`) @ `255f06a` | 3 files; 100 passed, 1 skipped |
| `vitest related src/compat/v2-hooks.ts src/routing/wire/dispatch.ts src/index.ts --run --maxWorkers=4 --testTimeout=30000 --hookTimeout=60000` @ `1ae8cbe` | 50 files passed, 3 skipped; 1376 passed, 56 skipped |
| Same related run @ `64bc7d8` | 50 files passed, 3 skipped; 1365 passed, 55 skipped |

Existing tests changed (accepted by the executor):

| Test | Change | Reason |
|---|---|---|
| `test/unit/roles.registration.test.ts` 436-476 | each role child bound exactly before asserting the max policy through `evaluate`; max-policy messages asserted (A6) | I9: an unbound child is max ∩ local, `external_directory` denied |
| `test/unit/roles.runtime.test.ts` QA-P21-1-1 | delegate caller `general` → tier `medium` | A7: a role child may never call `subagent` (§2.2) |

Observed flake: in one no-`--testTimeout` run the existing registration test "aliases explore → explorer…" took 6.5 s (> 5 s default); it passed on rerun and in every run with `--testTimeout=30000`.

## Findings

| Id | Severity | Finding (short) | Fix |
|---|---|---|---|
| QA-P23-A1 | major | Lexical `..` before realpath; dangling links peeled | `d4a7169`, `1ae8cbe` |
| QA-P23-A2 | major | Only one of `filePath`/`path` checked | `d4a7169`, `1ae8cbe` |
| QA-P23-A3 | major | `apply_patch` paths unchecked | `d4a7169`, `1ae8cbe` |
| QA-P23-A4 | minor | Prunable worktrees and `.git` shape not checked | `d4a7169`, `1ae8cbe` |
| QA-P23-A5 | minor | `read`/`edit` evaluation without resources allowed | `d4a7169`, `1ae8cbe` |
| QA-P23-A6 | minor | Max-policy messages not asserted | `1ae8cbe` |
| QA-P23-A7 | minor | Tools outside role classes (and `subagent`) not refused in `execute.before` | `d4a7169`, `1ae8cbe` |
| QA-P23-A8 | minor | No agent + failed lookup not treated as a role session | `d4a7169`, `1ae8cbe` |
| QA-P23-A9 | minor | Escaping glob/grep patterns accepted | `d4a7169`, `1ae8cbe` |
| QA-P23-A10 | nit | Role agents skipped when not protected | `d4a7169` (unreachable; no own test, accepted) |
| QA-P23-A11 | nit | Failed plugin-root realpath cached | `d4a7169`, `1ae8cbe` |
| QA-P23-A12 | nit | Concurrent worktree checks not shared | `d4a7169`, `1ae8cbe` |
| QA-P23-B1 | major | Role child silently lost its catalog | `d4a7169`, `1ae8cbe` |
| QA-P23-B2 | minor | `noteBinding` for unstored bindings | `d4a7169`, `1ae8cbe` |
| QA-P23-B3 | minor | Evaluate-error test passed for the wrong reason | `1ae8cbe` |
| QA-P23-B4 | major | Ladder-tool allow untested | `1ae8cbe` |
| QA-P23-B5 | minor | `buildContext` declared after its hook | `d4a7169` |
| QA-P23-N1 | nit | Comment claimed `external_directory` covers glob/grep | `d4a7169` |
| QA-P23-N2 | nit | No concurrency test | `1ae8cbe` |
| QA-P23-N3 | nit | Re-annotation untested | `1ae8cbe` |
| QA-P23-2-A1 | minor | A role child could not read its own truncated output | `a01646f`, `255f06a` |
| QA-P23-2-A2 | nit | `knownRoleSession` only in the catch | `a01646f`, `255f06a` |
| QA-P23-2-A3 | nit | Main worktree with a `.git` file refused | `a01646f`, `255f06a` |
| QA-P23-2-B1 | low | Session with agent but no parent got an empty catalog; notice wording | `a01646f`, `255f06a` |
| QA-P23-2 nit a | nit | Test comment ("same tool map object") | `255f06a` |
| QA-P23-2 nit b | nit | Shared in-flight bind not exercised | `255f06a` |
| QA-P23-2 nit c | nit | Tier/grader agents not asserted defined | `255f06a` |
| QA-P23-3-1 | major | Own-output ownership built from free text | `b607cbf` |

| Round | Verdict |
|---|---|
| 1 | FAIL — area A 3 major, 6 minor, 3 nit; area B 2 major, 3 minor, 3 nit; all fixed |
| 2 | PASS — area A 1 minor, 2 nit; area B 1 low, 3 nit; all fixed |
| 3 (targeted) | FAIL — QA-P23-3-1 major; fixed in `b607cbf` |
| 4 (targeted) | PASS |

### Accepted (QA round limit)

| Item | Residual |
|---|---|
| Failed-call outputs | `outputPaths` of a failed tool call are not recorded (their truncated output stays unreadable) |
| Wildcard user rules | user-written wildcard rules are matched as raw text |
| `(bound role session)` label | deny message when the role name is unknown |
| Event-name trust | the tool-success alias (`session.tool.success` / `session.next.tool.success`) and numeric suffix are trusted as host names |

## Handoffs

| To | Item |
|---|---|
| P3.1 | Real-host proof (2.0.24) of the path resource formats (`read`/`edit` Location-relative or canonical; `external_directory` `<dir>/*`) |
| P3.1 | Refusal by throwing in `execute.before` on the real host |
| P3.1 | Which tool-success event form 2.0.24 emits with `outputPaths`; without it truncated-output reads stay refused |
| P3.1 | Host ripgrep link following inside the work root (residual) |
| P3.1 | Glob search roots (`metadata.path`) on the real host |
| Executor §9 | Residual: host grep may follow links inside the work root |
| Executor §9 | Residual: the host's tool-output folder rule is kept in reading roles' max policy, narrowed per session to host-reported `outputPaths` only |

## Takeovers

None.

## Verdict

PASS — 0 open blocking, critical or major findings after round 4.
