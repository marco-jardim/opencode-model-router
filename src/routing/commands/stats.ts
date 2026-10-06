/**
 * `/router stats [--since <ISO>] [--until <ISO>] [--json] [--dir <path>]` and the checkpoint line of the bare `/router` (Phase 2.4.5, D18).
 *
 * The statistics are not re-implemented here: this runs the very `runStatsCli` that `scripts/routing-stats.ts` runs, over the same
 * persister, so for the same directory and window the in-session output is the script's stdout, byte for byte. The one difference is
 * that, while the engine is live, the rows still queued in memory are flushed to disk first (`flushNow`), so the table is current.
 *
 * Reading the directory lists it (it can hold thousands of scorecard logs, 1.3 QA-1.3-15), so this runs only from the user-invoked
 * command, never from a hook.
 *
 * Failure policy (§0.10.10): never throws. A usage error or an unreadable store comes back as text with a non-zero `exit`, exactly
 * as the script prints it on stderr; a failing flush is logged and the table is read from disk as it is.
 */

import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRouting, type RouterConfig } from "../../router/config";
import { acquireOutcomes, createPersister, nodePersistDeps, resolveOutcomesDir, runStatsCli } from "../outcomes";
import { ingestSettings } from "../outcomes/ingest";
import type { OutcomesBundle } from "../outcomes";

export interface StatsCommandDeps {
  readonly cfg: RouterConfig;
  readonly host: "v1" | "v2";
  readonly logger: { warn(message: string, extra?: Record<string, unknown>): void };
  /** Test seam: the directories `~` and the default location resolve against. */
  readonly env?: { readonly tmpdir: string; readonly homedir: string };
}

export interface StatsCommandResult {
  /** Exactly what `scripts/routing-stats.ts` writes to stdout for the same arguments. */
  readonly stdout: string;
  /** What it writes to stderr (notes and warnings, e.g. "no outcome data"). */
  readonly stderr: string;
  /** The script's exit code (0 ok, 1 corrupt store, 2 usage). */
  readonly exit: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The text `/router stats` shows: stdout as the script prints it, then the script's stderr notes after a blank line. */
export function formatStatsReply(result: StatsCommandResult): string {
  const notes = result.stderr.trim();
  const body = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  return notes === "" ? body : `${body}${body === "" ? "" : "\n\n"}${notes}`;
}

/**
 * Run the stats driver for `args` (the words after `stats`). The store directory is `routing.outcomes.path` (or the default); a
 * `--dir` argument overrides it exactly as it does for the script.
 */
export async function runStatsCommand(args: string, deps: StatsCommandDeps): Promise<StatsCommandResult> {
  const env = deps.env ?? { tmpdir: tmpdir(), homedir: homedir() };
  let stdout = "";
  let stderr = "";
  let bundle: OutcomesBundle | null = null;
  try {
    const routing = resolveRouting(deps.cfg, deps.host);
    const defaultDir = resolveOutcomesDir(routing.outcomes.path, env);
    // Only a live engine holds (or may hold) rows in memory; static never touches the store (§1.2).
    const live = deps.host === "v2" ? ingestSettings(deps.cfg, "v2") : null;
    if (live !== null) {
      try {
        bundle = acquireOutcomes({ dir: live.outcomesDir, tuning: live.tuning, logger: deps.logger });
        await bundle.ready;
        await bundle.flusher.flushNow();
      } catch (error) {
        deps.logger.warn("[router] /router stats: could not flush the queued rows; showing what is on disk", { error: describeError(error) });
      }
    }
    const persistDeps = nodePersistDeps({ warn: () => undefined }); // the driver reports through stderr, not the logger
    const exit = await runStatsCli(args.split(/\s+/).filter(Boolean), {
      defaultDir,
      open: (dir) => createPersister(resolveOutcomesDir(dir, env), persistDeps),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    return { stdout, stderr, exit };
  } catch (error) {
    deps.logger.warn("[router] /router stats failed", { error: describeError(error) });
    return { stdout, stderr: `${stderr}routing-stats: ${describeError(error)}\n`, exit: 1 };
  } finally {
    if (bundle !== null) {
      try {
        await bundle.release();
      } catch (error) {
        deps.logger.warn("[router] /router stats: releasing the outcome store failed", { error: describeError(error) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The checkpoint id of the bare `/router`
// ---------------------------------------------------------------------------

/** `<root>/docs/qa/cost-aware-routing/dogfood.md`: where the dogfood checkpoints are recorded (shipped with the checkout, not the package). */
export const DOGFOOD_PATH = join("docs", "qa", "cost-aware-routing", "dogfood.md");

function pluginRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * The id of the last checkpoint heading (`## DF<n> …`) of `dogfood.md`, e.g. `DF2`; `null` when the file is absent, unreadable
 * or has none (a published package ships without it). Never throws.
 */
export function readLastCheckpoint(root: () => string = pluginRoot): string | null {
  try {
    const text = readFileSync(join(root(), DOGFOOD_PATH), "utf-8");
    let last: string | null = null;
    for (const match of text.matchAll(/^##[ \t]+(DF\d+)\b/gm)) last = match[1] ?? last;
    return last;
  } catch {
    return null; // no dogfood record next to this code: the line is simply omitted
  }
}

/** `router: last checkpoint=DF2`, or `null` when there is none. */
export function checkpointLine(root?: () => string): string | null {
  const id = readLastCheckpoint(root);
  return id === null ? null : `router: last checkpoint=${id}`;
}
