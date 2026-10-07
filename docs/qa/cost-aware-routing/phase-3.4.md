# Phase 3.4 — DF5 and 2.3.0 release preparation

## Pre-flight

- Worktree: `D:\git\omr-car-p34`; branch `car/p34`; base **`e6c6d60`**. Initial `git status --short` was empty; dependencies were already installed.
- **Linear: not used.** Host: **OpenCode 2.0.24**. Live mode: **`enforce`** (dispatch handoff and copied decision rows).
- Scope: 3.4.1 and the reversible preparation half of 3.4.2 only. No base-checkout edits, live override/store writes, service operations, merge, tag, publication, PR creation or GitHub release.
- Read budget: `CAP:none`, release preparation spans dogfood statistics, ADR evidence, release metadata and packaging.

## DF5 and evidence

The fixed cutoff is **2026-10-07T04:13:39.877Z**. All routing-stat commands use a private copy at `C:\Users\Marquinho\AppData\Local\Temp\opencode\p34-1791346419`, never the live store. See [DF5 and Summary](dogfood.md#df5) and [ADR evidence](../../adr/0005-cost-aware-routing-engine.md#evidence).

Whole enforce period: 56 dispatch rows, agreement 24/24, zero switched, zero failed enforced switches. The CLI's D17 mode is `n/a (0 enforced switches)`; the literal D17 rule therefore retains **enforce**. This report does not apply the override; the orchestrator owns that action. Pre-/post-3.3 split: 53/3 rows. Post-3.3 never-down audit: 0 of 2 recorded. `pinned && switched`: 0 across all 247 decision rows in the copy.

Cache-read-share investigation and its qualifications are recorded in the dogfood report, not inferred from routing outcomes or estimated cost.

## Release metadata and PR

Preparation target: `2.3.0`, changelog date `2026-10-07`, one PR closing #74 and #73. The English [PR body](pr-body.md) is a file only; no PR is created in this phase. Credits belong to #73 (@javizuurc) and TypeSafe's documentation. Default behaviour remains static without a routing block; v1 does not run the engine.

## Release process checklist

Discovery source: `.github/workflows/publish.yml` is authoritative. A push of any `v*` tag runs checkout, Node 24 setup against npmjs.org, `npm ci`, **the full `npm test`**, then `npm publish`. It has `id-token: write` and no token passed to npm: the owner must confirm npm trusted-publisher configuration. Neither the README, `docs/MIGRATION.md`, changelog history nor package scripts define an additional release command. The changelog follows Keep a Changelog/SemVer; the migration guide documents older enforcement adoption, not publication. There is no GitHub-release creation step in the workflow.

These are instructions for the owner/orchestrator **after approval**, not actions taken here:

- [ ] Finish scoped checks, inspect `npm pack` contents and clean-install evidence below; ensure the intended integration branch contains all plan work and the 2.3.0 metadata.
- [ ] Open the single release PR against `master` with `docs/qa/cost-aware-routing/pr-body.md`; obtain review/CI approval. **Not performed here** (including no `gh pr create`).
- [ ] **IRREVERSIBLE / approval gate — merge to master:** merge that reviewed PR into `master` using the repository's approved merge method. Verify the resulting remote master SHA; do not tag a worktree-only preparation commit.
- [ ] In a release checkout, `git fetch origin master --tags`, `git switch master`, `git pull --ff-only origin master`; verify `git status --short` is empty, version is 2.3.0, and `git tag --list v2.3.0` is empty. Confirm npm publisher permissions before proceeding.
- [ ] Create the local release tag: `git tag -a v2.3.0 -m "Release 2.3.0"` at the verified merged master SHA. **Not performed here.**
- [ ] **IRREVERSIBLE — tag push (also starts publication):** `git push origin v2.3.0`. This triggers `Publish Package`; pushing the tag is not a harmless bookkeeping step.
- [ ] **IRREVERSIBLE — npm publish:** let `.github/workflows/publish.yml` run `npm ci`, `npm test`, `npm publish` on Node 24. Inspect its result and verify `npm view opencode-model-router@2.3.0 version`. Do **not** also run a duplicate local `npm publish`. If CI fails, investigate before any retry; an already published npm version cannot be overwritten.
- [ ] **IRREVERSIBLE — GitHub release (manual, not automated):** after confirming the tag and npm package, prepare release notes from CHANGELOG's 2.3.0 section, then `gh release create v2.3.0 --verify-tag --title "2.3.0" --notes-file <release-notes-file>`. This is a proposed explicit manual step; no workflow currently creates one.
- [ ] Verify npm install instructions and release links; record the PR, merged SHA, workflow URL, tag and GitHub-release URL. Leave the live mode decision to the orchestrator, using the D17 evidence above.

## Verification and clean install

Checkpoint verification: `npm run typecheck` passed; `npx vitest run test/unit/docs-drift.test.ts test/unit/routing-outcomes.stats.test.ts` passed **129 tests in 2 files** (default pool); `git diff --check` passed. D16/D17 are included in those files.

Release-preparation checks still to run: packaging (including the Phase 3.3 import-closure guard), installed-tarball runtime check, repeated scoped tests and typecheck before the release-metadata commit. A real tarball install is required in addition to `npm pack --dry-run`; the import-closure test alone cannot prove installed runtime loading.

## Handoff and boundaries

Release preparation only: the engine's default remains unchanged, and no live state is changed here. D17 recommends **enforce** because failed switched dispatches = 0, not because savings or switching safety has been demonstrated. All models in these windows are unpriced; savings are ratio units, not measured dollars. The owner/orchestrator retains merge, tag, publication, GitHub release and live-override authority.
