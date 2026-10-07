# Phase 3.4 — DF5 and 2.3.0 release preparation

## Pre-flight

- Worktree: `D:\git\omr-car-p34`; branch `car/p34`; base **`e6c6d60`**. Initial `git status --short` was empty; dependencies were already installed.
- **Linear: not used.** Host: **OpenCode 2.0.24**. Live mode: **`enforce`** (dispatch handoff and copied decision rows).
- Scope: 3.4.1 and the reversible preparation half of 3.4.2 only. No base-checkout edits, live override/store writes, service operations, merge, tag, publication, PR creation or GitHub release.
- Read budget: `CAP:none`, release preparation spans dogfood statistics, ADR evidence, release metadata and packaging.

## DF5 and evidence

The fixed cutoff is **2026-10-07T04:13:39.877Z**. All routing-stat commands use a private copy at `C:\Users\Marquinho\AppData\Local\Temp\opencode\p34-1791346419`, never the live store. See [DF5 and Summary](dogfood.md#df5) and [ADR evidence](../../adr/0005-cost-aware-routing-engine.md#evidence).

Whole enforce period: 56 dispatch rows, agreement 24/24, zero switched, zero failed enforced switches. The CLI's D17 mode is `n/a (0 enforced switches)`; the literal D17 rule therefore retains **enforce**. This report does not apply the override; the orchestrator owns that action. Pre-/post-3.3 split: 53/3 rows. Post-3.3 never-down audit: 0 of 2 recorded. `pinned && switched`: 0 across all 247 decision rows in the copy.

Cache-read-share investigation and its qualifications are recorded in the dogfood report, not inferred from routing outcomes or estimated cost. A copy of the session DB/WAL passed SQLite `quick_check`; the plan root's usable records measure 91.55% shadow (25/25 records), 91.91% advise (52/55), and 94.18% enforce (33/34). Full advise/enforce shares are **unverifiable** because the remaining records have no tokens. Advise ran the old hint; post-3.3 enforce emits none. No causal cache improvement is claimed. The host-wide routing store also contains other projects; only the cache measurement is restricted to the plan orchestrator.

## Release metadata and PR

Ran `npm version 2.3.0 --no-git-tag-version`: package version and both lockfile root versions are **2.3.0**. Converted CHANGELOG's Unreleased section to **`## [2.3.0] - 2026-10-07`**, preserving its content and existing style. The D16 test now checks those versions, the release heading, the PR's two closing directives and credits, as well as the existing plan/ADR contract. The older changelog credit guard now targets the 2.3.0 section rather than Unreleased.

The English [PR body](pr-body.md) is a file only; no PR was created. It closes #74 and #73, credits #73 (@javizuurc) and TypeSafe's documentation, lists all four modes and the v1 limitation, links ADR/guide/evidence and includes the dogfood summary table. Default behaviour remains static without a routing block; v1 does not run the engine.

## Release process checklist

Discovery source: `.github/workflows/publish.yml` is authoritative. A push of any `v*` tag runs checkout, Node 24 setup against npmjs.org, `npm ci`, **the full `npm test`**, then `npm publish`. It has `id-token: write` and no token passed to npm: the owner must confirm npm trusted-publisher configuration. Neither the README, `docs/MIGRATION.md`, changelog history nor package scripts define an additional release command. The changelog follows Keep a Changelog/SemVer; the migration guide documents older enforcement adoption, not publication. There is no GitHub-release creation step in the workflow.

These are instructions for the owner/orchestrator **after approval**, not actions taken here:

- [ ] Finish scoped checks, inspect `npm pack` contents and clean-install evidence below; ensure the intended integration branch contains all plan work and the 2.3.0 metadata.
- [ ] Open the single release PR against `master` with `docs/qa/cost-aware-routing/pr-body.md`; obtain review/CI approval. **Not performed here** (including no `gh pr create`).
- [ ] **IRREVERSIBLE / approval gate — merge to master:** after the reviewed PR targets `master` and CI passes, use `gh pr merge <release-pr-number> --merge` if merge commits are permitted by repository policy (otherwise use the owner-approved method). Verify the resulting remote master SHA; do not tag a worktree-only preparation commit.
- [ ] In a release checkout, `git fetch origin master --tags`, `git switch master`, `git pull --ff-only origin master`; verify `git status --short` is empty, version is 2.3.0, and `git tag --list v2.3.0` is empty. Confirm npm publisher permissions before proceeding.
- [ ] Create the local release tag: `git tag -a v2.3.0 -m "Release 2.3.0"` at the verified merged master SHA. **Not performed here.**
- [ ] **IRREVERSIBLE — tag push (also starts publication):** `git push origin v2.3.0`. This triggers `Publish Package`; pushing the tag is not a harmless bookkeeping step.
- [ ] **IRREVERSIBLE — npm publish:** let `.github/workflows/publish.yml` run `npm ci`, `npm test`, `npm publish` on Node 24. Inspect its result and verify `npm view opencode-model-router@2.3.0 version`. Do **not** also run a duplicate local `npm publish`. If CI fails, investigate before any retry; an already published npm version cannot be overwritten.
- [ ] **IRREVERSIBLE — GitHub release (manual, not automated):** after confirming the tag and npm package, prepare release notes from CHANGELOG's 2.3.0 section, then `gh release create v2.3.0 --verify-tag --title "2.3.0" --notes-file <release-notes-file>`. This is a proposed explicit manual step; no workflow currently creates one.
- [ ] Verify npm install instructions and release links; record the PR, merged SHA, workflow URL, tag and GitHub-release URL. Leave the live mode decision to the orchestrator, using the D17 evidence above.

## Verification and clean install

Checkpoint verification: `npm run typecheck` passed; `npx vitest run test/unit/docs-drift.test.ts test/unit/routing-outcomes.stats.test.ts` passed **129 tests in 2 files** (default pool); `git diff --check` passed. D16/D17 are included in those files.

Release-preparation verification: `npm run typecheck` passed; `npx vitest run test/unit/docs-drift.test.ts test/unit/packaging.test.ts test/unit/routing-outcomes.stats.test.ts` passed **131 tests in 3 files**, default pool, **3.46 s**. This reuses packaging's Phase 3.3 transitive import-closure guard and includes D16/D17. `git diff --check` passed. No full suite, smoke host or thread pool was run.

**Real clean install: PASS.** Commands (PowerShell):

```powershell
$tmp = 'C:/Users/Marquinho/AppData/Local/Temp/opencode/p34-1791346419'
npm pack --pack-destination $tmp --json > "$tmp/pack.json"
New-Item -ItemType Directory "$tmp/clean-project"
Set-Content "$tmp/clean-project/package.json" '{"name":"routing-release-check","version":"1.0.0","private":true,"type":"module"}'
npm install --prefix "$tmp/clean-project" "$tmp/opencode-model-router-2.3.0.tgz" --ignore-scripts --no-audit --no-fund
node docs/qa/cost-aware-routing/clean-install.mjs "$tmp/clean-project"
```

Installed **28 packages**, including peer `@opencode-ai/plugin@1.18.35`. Tarball size **755,547 bytes**, unpacked **2,492,658 bytes**, SHA-256 **`2ebe5a0c841c410e2484917264efb71eac05f77539bea955ee7fe03870e5f6b7`**. Node **24.21.0** imported the **installed** `server.ts` and its shipped closure; no import redirects to checkout sources. Assertions confirmed version 2.3.0, shipped/loaded config without a routing block, resolved engine `static`, callable v2 setup, and the shared v2-host factory initializing and disposing with **0 plugin log lines**. This is a package-load/factory check, not a new real-host `setup`/dispatch smoke; existing Phase 3.2 evidence covers the host path separately.

The new [clean-install helper](clean-install.mjs) redirects HOME/USERPROFILE/XDG/APPDATA and temp paths to the clean project and clears router/OpenCode environment overrides before imports. Node cannot natively strip TS under `node_modules`, and the package uses extensionless imports, so the helper registers local resolution plus explicit TypeScript transformation. The first helper attempt used strip-only mode and failed on the existing `ResumeRejectedError` constructor parameter property (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`); switching the helper to `mode: "transform"` fixed it without changing shipped code. Final stdout: `PASS: installed 2.3.0 server.ts imports; shipped tiers.json has no routing block; v2 static factory loads/disposes; plugin log lines=0`. Node also prints its own `ExperimentalWarning` for `stripTypeScriptTypes`; this is not a plugin log and was not suppressed.

## Handoff and boundaries

Release preparation only: the engine's default remains unchanged, and no live state is changed here. D17 recommends **enforce** because failed switched dispatches = 0, not because savings or switching safety has been demonstrated. All models in these windows are unpriced; savings are ratio units, not measured dollars. The owner/orchestrator retains merge, tag, publication, GitHub release and live-override authority.

Checkpoint commit **`1114352`**, `docs(routing): record DF5 checkpoint and bounded dogfood evidence`, was pushed to `origin/car/p34` before beginning the version bump. Release preparation is committed separately as `chore(release): 2.3.0`, with `Refs #74`. Changed areas: dogfood/run log/ADR evidence, this six-section report, PR body, clean-install helper, package/lock/changelog and docs-drift guards. No runtime source changes, no tags, and no publication.
