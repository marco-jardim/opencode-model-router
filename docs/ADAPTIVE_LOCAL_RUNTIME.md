# Adaptive Local Runtime (llama-server fast tier)

The local contour of adaptive routing: a locally-run `llama-server` may serve as the **fast** tier of a managed preset, admitted only while the GPU is demonstrably free, and — in a git project — working exclusively in an isolated throwaway worktree so the user's working tree is never touched by a local model.

> **Requires OpenCode v2 and the adaptive opt-in.** Like the rest of `adaptiveRouting`, the local contour runs only on OpenCode v2 hosts (`ctx.routerChildRunner`); on v1 the config stays inert. The weekly cloud review, the snapshot CAS and the selection rules are covered separately in the adaptive routing docs; this page is only the local runtime.
>
> **Status: prepared, not live.** Everything below is wired and tested against injected fakes. Connecting a real llama provider inside OpenCode, downloading weights and running generations are separate steps that need their own backup/config diff and the owner's explicit approval.

## Turning it on

Two things, both global (the project layer may not set `adaptiveRouting` — a repository cannot switch your hardware policy):

1. The opt-in flag in the **global** override file (`~/.config/opencode/opencode-model-router.overrides.jsonc`):

```jsonc
{ "adaptiveRouting": { "managedTiers": { "workstation": ["fast", "medium", "heavy"] }, "local": true } }
```

2. A valid `opencode-model-router.local.json` **next to the router state file** (the same directory `~/.config/opencode/` on most hosts). Without a valid file — or with `local: false` — every dispatch stays on its ordinary cloud model and nothing local ever runs.

## The config file

`opencode-model-router.local.json`, validated by shape only (whether `exe` and the weights file actually exist is deliberately not checked here):

| Key | Type | Default | Notes |
|---|---|---|---|
| `exe` | string | — (required) | The `llama-server` executable to run. |
| `model.ref` | string | — (required) | The model the tier will run, `provider/model` (`[A-Za-z0-9._-]+/[A-Za-z0-9._-]+`). |
| `model.path` | string | — (required) | Path to the weights file passed as `-m`. |
| `host` | string | `"127.0.0.1"` | Loopback by default; the server is a local single-user resource. |
| `port` | integer 1–65535 | `8080` | The port health probes and the server share. |
| `readinessTimeoutMs` | number > 0 | `120000` | How long a freshly spawned server may take to answer `/health`. |
| `admission.maxGpuUtilPct` | number 0–100 | `70` | GPU utilization ceiling for a local start. |
| `admission.minFreeVramMiB` | number > 0 | `10240` | Free-VRAM floor for a local start. |
| `extraArgs` | string[] | `[]` | Appended verbatim to the server command line. |

A missing file, broken JSON or an invalid schema reads as **null**: the local path is simply off. Nothing throws, no default silently patches a broken value, and delegation proceeds on the cloud model.

## Admission: the GPU must be free, twice

Rendering and any other external GPU load have priority over inference. Before anything local starts, the supervisor samples the GPU (`nvidia-smi --query-gpu=utilization.gpu,memory.free`, bounded to 5 s) **twice per acquire that intends to spawn**:

1. a fast first sample before the health probe, and
2. a second sample immediately before the spawn — between the two, the GPU may have been taken over.

A sample with a `null` field is an **UNKNOWN measurement and always denies**; it is never read as success. The bounds are inclusive: exactly `maxGpuUtilPct` utilization or exactly `minFreeVramMiB` free VRAM is admitted. Any deny leaves the cloud model in place and logs the reason; delegation never fails because of admission.

## Process lifecycle

One supervisor per plugin instance, created lazily on first use.

- **Health probe**: `GET http://host:port/health` (5 s timeout). `200` = up, anything else or a network error = down.
- **An already-live server is used as-is.** If the health probe answers up, the acquire succeeds without spawning: a foreign or previously started process is never spawned over and never killed.
- **Spawn**: `exe -m <model.path> --host <host> --port <port> <extraArgs…>`, `stdio: "ignore"`, not detached. Concurrent acquires share one in-flight promise, so exactly one spawn happens.
- **Readiness**: the health probe is polled every 500 ms until it answers up or `readinessTimeoutMs` elapses; on timeout the supervisor kills **its own** child and the acquire fails with a reason.
- **Orphan guard**: before a second spawn (the endpoint flapped down while our previous child may still be alive), the previous own child is killed first — a leaked server holding VRAM would starve rendering, and `release` could no longer reach it.
- **Release** (plugin `dispose`): kills only the supervisor's own live child, idempotently; no spawn, no-op.
- **Single-model server, no unload API.** `llama-server` serves one model and has no weights-unload endpoint: freeing VRAM means ending the process, which is exactly what `kill`/`release` do. Cancelling a request does **not** unload the weights — the process stays until `dispose` or a timeout kills it.

## Patch mode (git projects only)

A local fast task must not touch the working tree:

- The local binding requires the effective project to be a git work tree (bounded `git rev-parse --is-inside-work-tree`). In a non-git project the local path never activates and the cloud snapshot model runs.
- On binding, the router creates an isolated **candidate worktree**: `git worktree add --detach <system tmp>/router-local-<pid>-<timestamp>-<counter>`. A failed worktree creation falls back to the cloud model with a warning; delegation survives.
- The local child runs with its `cwd` in the candidate; cloud attempts (medium/heavy escalations) keep the ordinary working directory.
- When the delegation ends, the router extracts the artefact: `git diff --no-color` (unified patch) and `git status --porcelain` (changed files), digesting the patch to `sha256`. Both land on the dispatch attribution record as `localPatchDigest` and `localChangedFiles` (`lookupDispatch(<child>)`).
- The **working tree is never modified** by a local model, and the patch is **never auto-applied**. Integration of a local change happens only through the ordinary acceptance path — verified tests, independent review and integrity — and the owner's decision.
- Plugin `dispose` removes every candidate worktree (`git worktree remove --force`, `prune`, directory cleanup). Until then the candidate stays readable for inspection.

## Priorities

From strongest to weakest, for the fast tier of a managed preset:

1. an explicit model named by the caller;
2. a **project pin** — `model`/`variant` under `presets.<preset>.fast` in a project override file wins over everything adaptive (this is why pins are read from the original config object, before any adaptive copy is made);
3. the local binding above (opt-in + git + valid config + admitted GPU);
4. the adaptive weekly snapshot assignment;
5. the global preset's own model.

`local: false`, a missing or invalid local config, a non-git project, a busy or unknown GPU, or any failure along the way — each means: cloud model, no spawn, delegation unaffected.

## Constants, and what they are

All of these are **resource guards** — they bound time and memory on the host's behalf; none is a quality threshold on any model:

| Constant | Value | Bounds |
|---|---|---|
| Readiness poll interval | 500 ms | How often `/health` is polled while a fresh server warms up. |
| Health probe timeout | 5 s | One HTTP probe. |
| `nvidia-smi` timeout | 5 s | One GPU sample; a timeout is an UNKNOWN sample and denies. |
| Kill grace | 5 s | How long a killed child has to exit on its own before the promise resolves. |

## Rollback

Remove or rename `opencode-model-router.local.json` (or set `local: false`): the local path turns off immediately — the next dispatch re-reads the config and stays cloud. `dispose` stops the router's own server process. Nothing persistent is written to the user's environment: no state files, no provider registration, no downloaded weights.
