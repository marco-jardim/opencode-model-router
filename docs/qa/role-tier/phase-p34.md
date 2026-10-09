# P3.4 — integration, owner enablement, release 2.4.0 (#84)

## Pre-flight

- P3.3 PASS (`global.md`); CI 17/17 on `a397d95`; capped suite on `a397d95`: 180 files passed / 3 skipped, 12978 tests
  passed; live host log: no plugin load error.

## T3.4.1 — version and merge

- `rta/p34-release` `0535c3f`: `package.json` and the two root entries of `package-lock.json` → 2.4.0 (no dependency
  moved); CHANGELOG `## [2.4.0] - 2026-10-09` with a summary and an empty `[Unreleased]`; docs-drift D16 now tracks the
  package version.
- Release review (heavy reviewer, read-only): PASS with 1 minor (SemVer: 2.4.0 carries behaviour changes, incl. #77
  `fast` read-only; kept at 2.4.0 per plan, upgrade notes at the top of the entry; owner informed before publishing) and
  3 nits, fixed in `rta/p34-fix-2` `e1e41c5` (changelog structure and upgrade notes, D16 pin, inner cleanup awaits gates).
- CI flakes on the PR head, all Windows, none in product code:
  - `router-verify-tool` (node 20, twice): `rmSync` raced a gate still reading files after a pre-aborted call
    (ENOTEMPTY after the 11 s retry budget) — fixed in the test (`rta/p34-fix-1` `f5cb472`: cleanup awaits in-flight gates);
  - `tree-kill` (EBUSY, node 20) and `slot` timing (node 24): passed on re-run without changes.
- CI 17/17 on head `92eff1d`; PR #85 merged with a merge commit `d3bc2e3` (R10(5)); 15/15 check runs green on the merge SHA.

## T3.4.2 — owner override

- Current roles-mode override and the kill switch validated in a temp HOME against the final code: zero notices, 7 roles
  registered; kill switch → tiers mode with the custom agents and `explore → fast`.
- At the owner's request `routing.exploration.rate: 0.05` was added after the restart: validated in a temp HOME (rate
  0.05, `requireDetection: deterministic`, zero notices); the rate is re-read per dispatch (`v2-hooks.ts:1498`,
  `runtime.ts:323`), no restart needed. Backup `opencode-model-router.overrides.jsonc.bak-2026-10-09_05-30-50`.

## T3.4.3 — sync and live probes

- Base checkout `master` @ `d3bc2e3` (tag `rta/sync-prev` = `ae67429`); owner restart at 08:26Z; `/router`:
  `build=2.4.0+d3bc2e3`; 7 role agents registered; no plugin load error after the restart.
- DF-2 probe set on the final code: all PASS, including the first live end-to-end authority ladder (fast + local grant →
  request → resume → `edit`, floor recomputed to medium → grader signal) and the `.git` edit refusal. Details in
  `dogfood.md`. Cosmetic finding filed as #86 (second of two parallel refusals names the first path).

## T3.4.4 — publish (owner answer: "retomar e publicar")

- Tag `v2.4.0` (annotated) on `d3bc2e3`; publish workflow run 37905686050: `npm ci`, `npm test`, `npm publish` with
  Trusted Publishing; provenance statement in the transparency log (sigstore log index 3161114651).
- `npm view opencode-model-router@2.4.0`: version 2.4.0, shasum `0c21b2fff019b9f3b66c252121970d8af9a5faec`,
  `dist-tags.latest` = 2.4.0, provenance predicate `https://slsa.dev/provenance/v1`; `npm audit signatures` verified.
- Clean install from the registry in an empty project (28 packages): the installed package's 112 files are
  byte-identical to `d3bc2e3`; the clean-install helper (2.3.0 helper, version bumped) imports the installed `server.ts`
  and loads/disposes the v2 factory with 0 plugin log lines.
- Isolated OpenCode 2.0.24 host (temp HOME/XDG, random server password, credential variables stripped, roles override):
  the registry-installed plugin loads with 0 load failures. The agent list stays empty without a working provider (no
  keys), so role registration on that host was not observed; it is covered by the byte-identity above, the real-host
  roles smoke (7/7 at `952de94`) and the live host on `d3bc2e3`.

## T3.4.5 — close-out

See the handover §2 for the final state (cleanup of worktrees, branches and tags; `routing.workRoots` removal).

## Verdict

PASS — released as 2.4.0, live for the owner in roles mode with exploration 0.05 and a verified rollback path.
