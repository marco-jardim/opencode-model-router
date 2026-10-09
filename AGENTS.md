# AGENTS.md

opencode-model-router is an OpenCode plugin that routes delegated tasks to tiered subagents (`fast`/`medium`/`heavy`)
and, on OpenCode v2 with `routing.delegation: "roles"`, to role agents ([Roles mode](docs/ROLES.md)). OpenCode v2
loads `server.ts`, whose adapter is `src/compat/v2-hooks.ts`; OpenCode v1 loads the plugin function from
`src/index.ts` through the legacy hooks. Routing, tool guards and verification use the same engine on both hosts.

## Host support policy

OpenCode v1 support is in **feature freeze** (owner decision, 2026-10-09). v1 keeps working; every new feature
targets OpenCode v2 only.

- Allowed on v1: fixes for regressions, fixes for security issues, and keeping the existing tests green.
- Not allowed on v1: new features, new config keys with v1 behaviour, new v1-only code paths.
- A new feature is v2-only and inert on v1: no behaviour there, at most one notice per process, as roles mode does
  (`roles delegation requires OpenCode v2; using tiers`, see [OpenCode v1 fallback](docs/ROLES.md#opencode-v1-fallback)).
- Every change keeps the existing goldens (`test/golden/`) and `npm run smoke:v1` green (`smoke:v1` needs an
  OpenCode 1.x executable first on `PATH`).

## Before you change code

- `npm run typecheck` (`tsc --noEmit`) passes.
- Unit tests run with vitest: `npm test` (all), `npm test -- <file>` (one file).
- When docs change, the docs-drift pins in `test/unit/docs-drift.test.ts` stay green: fix the docs, never weaken a pin.
- User-visible changes get an entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog).
- Commits follow Conventional Commits, `type(scope): summary` (for example `docs(roles): …`, `test(verify): …`,
  `chore(release): …`), with a `Refs #<issue>` trailer when there is an issue.
