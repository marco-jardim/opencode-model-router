# QA — plugin-level `agents` block (#81)

## 1. Pre-flight

- Base: `master` @ `ceb343c` (worktree `D:\git\omr-agents`, branch `feat/plugin-agents`).
- Linear: not used.
- Host for the real-host smoke: OpenCode 2.0.24 (isolated HOME/XDG, never the live config or store).

## 2. Design

- Schema: `agents: Record<name, { tier, description, prompt?, steps?, readOnly?, allowTools?, permission? }>`.
- Validation runs on the merged config (tiers.json + global override) in `buildConfig`, after the persisted
  preset is applied. It never throws: an invalid entry is removed from `cfg.agents` and reported as a
  `router: config notice:` line naming `agents.<name>[.<field>]`. The layer, `routing` and every other entry
  are kept (#80).
- Reserved names: `fast`, `medium`, `heavy`, every tier of the active preset, the grader agents, and the host
  primary/hidden agents `build`, `plan`, `title`, `summary`, `compaction`.
- A `tier` the active preset does not define: the entry is skipped (notice) for this preset only; a `/preset`
  rebuild re-checks it.

## 3. Precedence and layer rules

- tiers.json and the global override may define `agents`. A project override may not (A18): a cloned
  repository must not be able to register agents with permissions. The block is stripped from the project
  layer with a notice; the rest of that layer still applies.
- (in progress)

## 4. Tests

(in progress)

## 5. Real-host smoke

(in progress)

## 6. Residual risks

(in progress)
