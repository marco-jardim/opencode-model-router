# Phase 3.4 — Release `2.1.0` and local sync

Review date: 2026-10-05. Scope: PR #69, merge commit `adb0343`, release commit `5afd91b`, tag
`v2.1.0`, Publish Package run `37326400918`, the npm registry state, and the main checkout after
the sync. Every statement below was re-checked during this review unless it is marked
**(from the sync report, not re-checked)**.

## Pre-flight

- **Phase 3.3 closed with zero findings.** There is no separate 3.3 file; `global.md` is the 3.3
  record. At `v2.1.0`, `docs/qa/depth-and-effort/global.md` has this verdict: "Open findings: 0
  (QA-G-1 and QA-G-2 were fixed in `f041a26` and confirmed in round 2; round 2 found nothing
  new)."
- **npm before the release:** `2.0.0`. In the registry, `time["2.0.0"]` is
  `2026-10-05T01:24:09.879Z` and no version lies between `2.0.0` and `2.1.0`. That is lower than
  `2.1.0`, so no rebase was needed.
- **PR #69 CI on head `9cf2977`:** all 17 checks from `gh pr checks 69` pass.
  - Test run `37323975320` is on attempt 2. On attempt 1, 11 of 12 jobs passed. Only
    `test (node 20, windows-latest)` failed:
    `FAIL test/integration/router-verify-tool.test.ts > verifyHandles (2.4.3a) > a cancelled call
    (the tool's abort) judges nothing and leaves the entry unverified` with
    `Error: ENOTEMPTY: directory not empty, rmdir 'C:\Users\runneradmin\AppData\Local\Temp\omr-rv-wZlFe5'`
    and `Test Files 1 failed | 107 passed | 3 skipped (111)`.
  - This is a temp-dir cleanup flake that was already there. The change does not touch that file:
    `git diff --stat 46f443f 5afd91b -- test/integration/router-verify-tool.test.ts` is empty, and so
    is `git log 46f443f..5afd91b` for that path. One rerun turned the job green.
  - One run was outside the PR checks and failed: the dynamic GitHub Advanced Security run "Code
    scanning AI findings on PR #69". See QA-3.4-3.
- **The 3.2 `package.json` handoff is applied in `a5a0e6c`**
  (`chore(test): run the depth and effort smoke in the keyless lane`, `Refs #66`/`Refs #67`). It
  changes one line, adding `test/smoke/depth-effort.smoke.test.ts` and
  `test/smoke/helpers/scripted-provider.test.ts` to `smoke:keyless`. `smoke-keyless` passed on the PR
  head (run `37323975247`) and on the `master` push of `5afd91b` (run `37326395008`).
- **PR review fixes.** The review sources (Codex P2, CodeQL) are as stated in the dispatch. The
  commits are verified:
  - `8aa90c8` `fix(router): release ancestor lookups when a walk is forgotten`
    (`src/router/depth.ts`, `test/unit/depth.test.ts`). It was merged through `2e9cf67`, and
    `9cf2977` updates the lookup bound recorded in `phase-1.2.md`.
  - `83b89c1` `test(smoke): keep error details out of the scripted provider's responses`.
  - `cf0491a` `test(escalate): compare the ladder golden fixtures independent of line endings`
    (`.gitattributes`, `test/unit/ladder.test.ts`).
- **Code-scanning alerts.** The query for `refs/pull/69/merge` returns no alerts. `master` has
  three open alerts (#5, #6, #7, at `test/unit/pending.test.ts:259` and
  `test/unit/batch.test.ts:3045`). All three were created 2026-09-28, already existed, and are
  outside this change.

## Implementation notes

### Merge and release

- PR #69 (`de/main` → `master`) was merged at 2026-10-05T14:38:14Z as merge commit `adb0343`, with
  parents `46f443f` (`v2.0.0`) and `9cf2977` (the PR head). The repo convention is a merge commit.
  `git diff --stat 9cf2977 adb0343` is empty, so the merged tree is the reviewed PR head.
- Merge message: `Merge pull request #69 from marco-jardim/de/main` / blank /
  `feat(router): delegation depth limit and effort bump before escalation`. It has no trailers.
- Release commit `5afd91b` `chore(release): 2.1.0` (parent `adb0343`) has an empty body. It changes
  only `CHANGELOG.md` (+2), `package.json` and `package-lock.json` (both `version` fields).
- The CHANGELOG keeps an empty `## [Unreleased]` and adds `## [2.1.0] - 2026-10-05` below it.
  `6b97699` (`chore(release): 2.0.0`) did the same, so the repo's 2.0.0 convention takes precedence
  over the plan's literal "rename". The CHANGELOG has no version compare link references, and
  none is expected.
- Tag `v2.1.0` is annotated (tag object `913d0fd`) and points at `5afd91b`. The tagger is
  `marco-jardim` at 2026-10-05 11:38:55 -0300, and the message is `v2.1.0`, the same shape as
  `v2.0.0`. On origin, `refs/tags/v2.1.0^{}` and `refs/heads/master` are both `5afd91b`.
- No workflow run is recorded for `adb0343` itself. The `master` push of `5afd91b`, which differs
  from it only in the three version/CHANGELOG files, is green: Test `37326395178`, smoke-keyless
  `37326395008`, CodeQL `37326397164`.
- No GitHub Release object exists. The latest is `v1.11.1`, and no Release exists for `v1.12.0` through
  `v2.0.0` either. That matches the repo's practice and is not a finding.

### Publish and registry

- Publish Package run `37326400918` ran on event `push`, ref `v2.1.0`, head `5afd91b`, with conclusion
  `success`. The log says:
  - `14:41:26Z npm notice publish Signed provenance statement with source and build information from GitHub Actions`
  - `npm notice publish Provenance statement published to transparency log: https://search.sigstore.dev/?logIndex=3089665377`
  - `14:41:28Z + opencode-model-router@2.1.0`
- Registry state:
  - `dist-tags` is `{ "latest": "2.1.0" }`, the only tag.
  - `npm view opencode-model-router@2.1.0 version` returns `2.1.0`.
  - `gitHead` is `5afd91beac13dcb40b7585acd5dbed0782d356c5`.
  - `dist`: `fileCount` 56, `shasum` `6666b845eae394336d8d23735f1a865744adbe10`, `integrity`
    `sha512-jPHvy6cy…SI3aFQ==`, two signatures, and `attestations.provenance.predicateType` =
    `https://slsa.dev/provenance/v1`.
  - `time["2.1.0"]` is `2026-10-05T14:44:39.104Z`, the registry's finalization time. That is
    about 3 minutes after the log line, and there is only one 2.1.0 entry.
- The attestations endpoint returns two bundles:
  - The npm publish attestation v0.1, in transparency log entry `3089715542`.
  - The SLSA provenance v1, in entry **`3089665377`**, the same entry as the log. Its workflow is
    `marco-jardim/opencode-model-router` with `ref=refs/tags/v2.1.0` and
    `path=.github/workflows/publish.yml`, and its resolved dependency is
    `…@refs/tags/v2.1.0@5afd91beac13dcb40b7585acd5dbed0782d356c5`.
  - Both subjects are `pkg:npm/opencode-model-router@2.1.0` with SHA-512 `8cf1efcb…488dda15`.
- **Tarball check.** The downloaded `opencode-model-router-2.1.0.tgz` has that SHA-512 (exact
  comparison: `True`) and the registry `shasum` as its SHA-1. It holds 56 files, and its
  `package.json` version is `2.1.0`. `git hash-object --no-filters` of every file equals its blob at
  `5afd91b`: 0 mismatches, 0 files outside git.

### Version match

| Source | Value |
| --- | --- |
| `package.json` `version` @ `5afd91b` | `2.1.0` |
| `package-lock.json` `version` | `2.1.0` |
| `package-lock.json` `packages[""].version` | `2.1.0` |
| Tag | `v2.1.0` → `5afd91b` (annotated) |
| CHANGELOG heading | `## [2.1.0] - 2026-10-05` |
| Registry `dist-tags.latest` / `npm view …@2.1.0 version` | `2.1.0` / `2.1.0` |
| Registry `gitHead` / provenance commit | `5afd91b` / `5afd91b` |
| Tarball `package/package.json` | `2.1.0` |

### Issues

- `closingIssuesReferences` of PR #69 is `[66, 67]`. #66 is `CLOSED`/`COMPLETED`
  (2026-10-05T14:38:16Z) and #67 is `CLOSED`/`COMPLETED` (14:38:17Z), both by PR #69. The body
  has `Closes #66` and `Closes #67`.
- Follow-up #68 is `OPEN`: `test(smoke): deferred-catalog smoke reads opencode logs under HOME but
  ignores XDG_DATA_HOME`, which is the QA-3.2-9 handoff.

### AI attribution

- The PR body has no AI attribution. It ends with the human credit line required by 3.4.1:
  "Observations by @MetalbolicX in opencode-smart-router (#17); implementation written from
  scratch."
- The `adb0343` message, the `5afd91b` message and the `v2.1.0` tag message are quoted above. None
  has a trailer.
- `git log 46f443f..5afd91b --format=%B | Select-String -Pattern "Co-authored|Generated with"` finds
  0 hits in 195 commits, and `--format='%(trailers:only)'` is empty for all 195.
- Authors are only `Marco Jardim` / `marco-jardim <marcoeojardim@gmail.com>`. Committers are the
  same or `GitHub <noreply@github.com>` (PR merges).
- A wider scan (`Claude|anthropic|opencode.ai|AI-assisted`) matches only two subjects about
  product content (`… preserve Anthropic protocol shapes`, `… clarify Claude effort ceiling`).

### CHANGELOG `[2.1.0]` vs PR #69 body

They agree on:
- the defaults: `maxDelegationDepth` 1 with `null` to opt out, `effortBump` true, `effortBumpMax`
  `"xhigh"` with per-family capping;
- advisory as the bundled default and refusal when enforced;
- the precedence: environment → caller-tier `perTier` → configured mode;
- `/bypass` disabling the depth guard;
- the effort bump conditions: explicit valid effort, no variant, family ceiling, no winning
  explicit option;
- no extra attempt, with attempt and cost limits respected;
- only `fable-effort` fast/medium eligible, and a run starting at fast stopping before medium's
  bump at the default cost limit;
- the intentional v1 native-key change and its opt-out;
- OpenCode 2's independent `experimental.subagent_depth`.

No statement contradicts the other side. Two differences are omissions or imprecisions
(QA-3.4-2).

### Local sync (main checkout)

- HEAD is `5afd91b` on `master`, and `origin/master` is `5afd91b`. Before this commit,
  `git status --porcelain` showed only ` M tiers.json`. `git status --ignored` adds only ignored
  build/tool directories (`.env`, `.opencode/`, `coverage/`, `dist/`, `node_modules/`, `tmp/`). The
  stash is empty.
- **Plan copies.** After the fast-forward, `docs/plans/delegation-depth-and-effort-bump-plan.md` on
  disk is `9258a1e`, the `v2.1.0` blob. The `174505d` blobs are `f6f69e1` (plan) and `1640b9c`
  (handover, unchanged through `v2.1.0`). That the deleted untracked copies hashed equal to these
  blobs **(from the sync report, not re-checked)** cannot be re-checked after deletion. Both files
  are now tracked and clean, so nothing unique could have been lost.
- **The two empty Phase 1.2 strays.** `src/router/depth.ts` and `test/unit/depth.test.ts` are now
  the tracked `v2.1.0` files (32,782 and 61,758 bytes) and clean against HEAD. Deleting the empty
  placeholders lost no content.
- **`tiers.json`.** The working tree is the owner's uncommitted change: `git diff --stat` shows
  `42 insertions(+)`, adding preset `hybrid-2`.
  - All 7 existing presets and all 10 other top-level keys are equal to HEAD.
  - The backup `C:\Users\Marquinho\AppData\Local\Temp\Claude\tiers.json.hybrid-2.bak` has the same
    SHA-256 as the working file (`EAE64839…8D274550`).
  - `v2.0.0:tiers.json` and `v2.1.0:tiers.json` are the same blob (`6869985`), so the
    fast-forward could not conflict with it. No data was lost (QA-3.4-4).
- **Worktrees, branches and tags.**
  - `git branch -a --list "*de/*"`, `git tag --list "de/*"` and
    `git ls-remote origin "refs/heads/de/*" "refs/tags/de/*"` are all empty.
  - `git worktree list` has no `omr-de-*` entry, and `git worktree prune --dry-run -v` reports
    nothing.
  - `D:\git\omr-de-p23` still exists as a directory with 0 items. It is not registered in
    `.git/worktrees` (QA-3.4-5).
  - The 12 other worktrees are not from this plan (QA-3.4-6).

## Findings

| ID | Severity | Where | Description | Resolution |
| --- | --- | --- | --- | --- |
| QA-3.4-1 | minor | PR #69 body, "Documentation and follow-up" | All six document links (ADR, QA folder, phase-3.2, global, run log, CHANGELOG) point at `../blob/de/main/…` or `../tree/de/main/…`. `de/main` was deleted in 3.4.5, so the links are dead: HTTP 404 for `blob/de/main/CHANGELOG.md` and `blob/de/main/docs/adr/0004-…md`, against 200 for `blob/v2.1.0/docs/adr/0004-…md`. The CHANGELOG link also anchors `#unreleased`, which is now empty. | **Open.** Edit the PR body (`gh pr edit 69 --body-file …`): replace `blob/de/main` and `tree/de/main` with `blob/v2.1.0` and `tree/v2.1.0`, and change the CHANGELOG anchor to `#210---2026-10-05`. This review was not authorised to edit the PR. |
| QA-3.4-2 | minor | PR #69 body vs CHANGELOG `[2.1.0]` | No contradiction, but two differences. (a) The CHANGELOG's user-visible OpenCode 2 change is missing from the PR body: router-modified `subagent` results keep the host `<subagent sessionID=…>` envelope (`474b0df`, part of PR #69). (b) The PR lists `effort` among the native keys that replace keys "v1 silently dropped". The CHANGELOG states it correctly: only OpenAI-family `effort` was dropped (now `reasoningEffort`), and Claude `effort` was already native. The published CHANGELOG is the accurate and complete record. | **Open.** Apply in the same PR-body edit as QA-3.4-1: add one bullet for the v2 `subagent` envelope change, and reword the v1 key sentence to match the CHANGELOG. |
| QA-3.4-3 | minor | PR #69 CI, "all green" | Besides the 17 green checks, the dynamic run "Code scanning AI findings on PR #69" (`37323975829`, GitHub Advanced Security) failed on the final head. The three earlier runs (14:14–14:20Z) failed the same way: `SessionModelError: You have exceeded your monthly quota … statusCode 402`. The last success (13:55:53Z) came before review fixes `cf0491a`, `83b89c1` and `8aa90c8`, so the AI scanner never saw them. | **Accepted residual, closed.** The cause is a billing quota, not a code result, and it is not a PR status check. CodeQL `Analyze` passed on the PR head (`37323966118`) and on `master` `5afd91b` (`37326397164`). No alert exists on `refs/pull/69/merge`. This file now records the pre-flight state accurately. |
| QA-3.4-4 | minor | Main checkout, DoD "clean tree" | `git status --porcelain` is ` M tiers.json`, not empty. | **Accepted deviation (owner decision), closed.** The plan's 3.4.5 / §0.1.2 stop was honoured, and the owner chose to preserve the change. The diff only adds preset `hybrid-2`; existing presets and keys are equal to HEAD. The backup equals the working file (same SHA-256). `tiers.json` is the same blob in `v2.0.0` and `v2.1.0`. No data was lost. This commit does not stage it. |
| QA-3.4-5 | minor | `D:\git\omr-de-p23` | An empty directory (0 items) is left behind. Another process holds it as its cwd, so it cannot be removed. It is not a git worktree: it is absent from `git worktree list` and from `.git/worktrees`. | **Deferred to the owner, closed for git state.** Delete `D:\git\omr-de-p23` after restarting the opencode sessions (the restart is already required by 3.4.5). It holds no data. |
| QA-3.4-6 | nit | `git worktree list` | 12 other worktrees remain: `C:\Users\Marquinho\AppData\Local\Temp\{omr-regress, opencode\gradew1, mr-chronos, mr-pr59, omr-old, p32old, p32verify, wt-qag1, wt21}` and `D:\git\opencode-model-router-{agent-options-gate, release, v2}`. All were created 2026-09-24 to 2026-10-03, before this plan's first commit (`174505d`, 2026-10-05). All except `mr-chronos` (`b2eec92`, an unmerged contributor commit) sit on commits already in `v2.0.0`. `p32*` and `wt-qag1` belong to the earlier verify plan, not to this Phase 3.2 or 3.3. | **Out of scope, closed.** This plan did not create them, and `omr-de-*` is the only pattern its DoD covers. Prune at the owner's discretion. |

Open findings: **2** (QA-3.4-1, QA-3.4-2). Both are minor, and both concern only the text of the
merged PR #69 description.

## Verdict

**Release accepted. The Phase 3.4 DoD is pending one PR-body edit.**

- **No critical or major findings.**
  - The versions match across `package.json`, both lock-file fields, the tag, the CHANGELOG
    heading, the registry (`latest` = `2.1.0`), `gitHead` and the provenance commit.
  - The provenance statement is in the publish log and on the registry (SLSA v1, transparency log
    entry `3089665377`, `refs/tags/v2.1.0` @ `5afd91b`).
  - The tarball is byte-identical to `5afd91b`.
  - No AI attribution or `Co-authored-by` appears in the PR body, the merge commit, the release
    commit, the tag message or any of the 195 commits of `46f443f..5afd91b`.
  - #66 and #67 are closed by PR #69.
  - No `de/*` branch or tag remains, locally or on the remote, and no `omr-de-*` worktree is
    registered.
  - The owner's `tiers.json` work is intact.
- **Acceptance criteria are met:** `2.1.0` is `latest` with provenance, `master` is tagged, and #66
  and #67 are closed by the PR.
- **The DoD's "zero open findings" is not yet met.** QA-3.4-1 and QA-3.4-2 need a single
  `gh pr edit 69`, which this review was not authorised to make. QA-3.4-4 (the `tiers.json`
  deviation) and QA-3.4-5 (the locked empty directory) are owner-sanctioned residuals.
- After the restart, the owner should delete `D:\git\omr-de-p23`.
