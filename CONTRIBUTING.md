# Contributing

Thanks for helping out. This is a small plugin with a large test suite, and the suite is
the contract. If it is green and the docs match, the change is basically done.

## Setup

```bash
npm ci
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

There is no build step — the plugin ships TypeScript sources directly. CI runs the same
two commands on Node 20, 22 and 24, across ubuntu-latest and windows-latest.

## Golden snapshots

The golden tests are parameterized over **every** preset in `tiers.json`. Any edit to
`tiers.json` — a new preset, a model swap, a changed description — will move snapshots.
Regenerate and commit them:

```bash
npx vitest run -u
```

Then read the snapshot diff before committing. A preset addition should only add
snapshot blocks for that preset. If unrelated presets moved, something else changed too,
and that is worth understanding before you push.

`test/unit/docs-drift.test.ts` pins the prompt-size figures quoted in the README against
the sizes the code actually produces. If it fails, the fix is to put the numbers the test
reports into the README, not to relax the test. The same file also asserts that every
top-level key of `tiers.json` appears in `docs/CONFIG_REFERENCE.md`.

## Model references

Model refs are `provider/model` and the format is validated at load. The *contents* are
not: a typo resolves to nothing at runtime. Before you add one, confirm the model exists
in the models.dev catalog **under that exact provider id**. Providers are not aliases of
each other — `glm-5.3` is published under `zai-coding-plan`, not under `zai`, and pointing
at the wrong one produces a preset that loads fine and then fails to route.

The per-tier `variant` field is not validated at load either. Check the model's
`reasoning_options` in models.dev before setting one.

## Adding a preset

A preset is not done when `tiers.json` parses. It is done when all of these are true:

- `fallback.global` has a chain for the new provider ids (keys are provider ids, values
  are preset names). Without it, a provider outage dead-ends instead of failing over.
- The preset table in the README's `### Presets` section lists it.
- The preset count is updated in both the README and `docs/CONFIG_REFERENCE.md`.
- `costRatio` is honest. If two tiers share the same model, the ratio is a token-spend
  multiplier and not a price difference — say so in the description, following the
  `fable-effort` precedent.
- Snapshots regenerated (see above).

## Changelog

Add an entry under `## [Unreleased]` in `CHANGELOG.md`. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); releases are SemVer. Write what
changed and why it matters, not just the file you touched.

## Commits

Conventional commits, lowercase subject: `fix(logging): ...`, `docs: ...`,
`test(golden): ...`. One logical change per commit.

## A note on CI for first-time contributors

If this is your first PR here, GitHub holds the workflows until I approve them. That is a
repository setting, not a problem with your PR. Ping me if it sits unapproved for a day.
