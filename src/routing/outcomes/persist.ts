// ---------------------------------------------------------------------------
// Persistence (M3): atomic outcomes.json, rotating decisions.jsonl, coalescing flusher (D15, A3).
//
// Design: docs/qa/cost-aware-routing/phase-1.3.md "Design (1.3.1)" §5.
// The only module of src/routing/outcomes/ that touches disk, and only through the injected PersistFs.
// The clock, the sleep function and the timers are injected too. It never opens, lists for processing,
// renames or deletes a `*.scorecard.log` file (it filters readdir by its own names).
// Runnable under Node type stripping (type-only imports use `import type`).
// ---------------------------------------------------------------------------

import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type {
  DecisionRow,
  FlusherDeps,
  FlusherOptions,
  FlushScheduler,
  LoadResult,
  LoadStatus,
  LogRow,
  OutcomeFlusher,
  OutcomeLogger,
  OutcomeKey,
  OutcomeSnapshot,
  OutcomeStore,
  OutcomesFile,
  PersistDeps,
  PersistFs,
  PersistStat,
  Persister,
  PersisterOptions,
  ReadRowsResult,
  RefusalRow,
  RouteChoice,
  VerdictRow,
  WriteResult,
} from "./types";
import {
  DECISIONS_FILE,
  DECISIONS_MAX_BYTES,
  DECISIONS_MAX_GENERATIONS,
  DECISIONS_ROTATED_RE,
  DEFAULT_OUTCOMES_DIRNAME,
  FLUSH_BATCH_ROWS,
  FLUSH_MIN_INTERVAL_MS,
  LADDER_STEP_KINDS,
  LOG_ROW_VERSION,
  MAX_QUEUED_ROWS,
  OUTCOMES_CORRUPT_FILE,
  OUTCOMES_FILE,
  OUTCOMES_SCHEMA_ID,
  OUTCOMES_SCHEMA_VERSION,
  OUTCOMES_TMP_PREFIX,
  RENAME_RETRY_DELAYS_MS,
  STALE_TMP_MS,
  parseKey,
} from "./types";
import { parseSnapshot } from "./store";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(x: unknown): x is Rec {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: unknown): WriteResult {
  const code = errorCode(error);
  return { ok: false, error: describeError(error), ...(code !== undefined ? { code } : {}) };
}

function emptySnapshot(): OutcomeSnapshot {
  return { version: OUTCOMES_SCHEMA_VERSION, entries: {} };
}

// ---------------------------------------------------------------------------
// Directory resolution
// ---------------------------------------------------------------------------

/**
 * `routing.outcomes.path` is a **directory** holding both files. Unset or blank → the scorecard
 * directory (`<tmpdir>/opencode-model-router-trajectory`). A leading `~` resolves against `homedir`, an
 * absolute path is normalised, and a relative path resolves against the default directory (never the
 * process cwd).
 */
export function resolveOutcomesDir(
  configured: string | null | undefined,
  env: { readonly tmpdir: string; readonly homedir: string },
): string {
  const fallback = join(env.tmpdir, DEFAULT_OUTCOMES_DIRNAME);
  const raw = typeof configured === "string" ? configured.trim() : "";
  if (raw === "") return fallback;
  if (raw === "~") return normalize(env.homedir);
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(env.homedir, raw.slice(2));
  if (isAbsolute(raw)) return normalize(raw);
  return join(fallback, raw);
}

// ---------------------------------------------------------------------------
// Node implementations of the injected dependencies
// ---------------------------------------------------------------------------

export function nodePersistFs(): PersistFs {
  return {
    async mkdirp(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true });
    },
    async readText(path: string): Promise<string | null> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async writeDurable(path: string, data: string): Promise<void> {
      const handle = await open(path, "w");
      try {
        await handle.writeFile(data, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async appendText(path: string, data: string): Promise<void> {
      await appendFile(path, data, "utf8");
    },
    async rename(from: string, to: string): Promise<void> {
      await rename(from, to);
    },
    async unlink(path: string): Promise<void> {
      try {
        await unlink(path);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    },
    async stat(path: string): Promise<PersistStat | null> {
      try {
        const s = await stat(path);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch (error) {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      }
    },
    async readdir(dir: string): Promise<string[]> {
      try {
        return await readdir(dir);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return [];
        throw error;
      }
    },
  };
}

/** `setTimeout` with `.unref()`: a pending flush never keeps the process alive. */
export function nodeScheduler(): FlushScheduler {
  return {
    setTimer(fn: () => void, ms: number): unknown {
      const handle = setTimeout(fn, ms);
      handle.unref();
      return handle;
    },
    clearTimer(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

export function nodePersistDeps(logger: OutcomeLogger): PersistDeps {
  return {
    fs: nodePersistFs(),
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    logger,
    pid: process.pid,
  };
}

// ---------------------------------------------------------------------------
// Windows-safe rename
// ---------------------------------------------------------------------------

const RETRYABLE_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

async function withRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  delays: readonly number[],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const code = errorCode(error);
      if (code === undefined || !RETRYABLE_CODES.has(code) || attempt >= delays.length) throw error;
      await sleep(delays[attempt] as number);
    }
  }
}

/**
 * `rename` that survives Windows sharing violations: `EPERM`/`EBUSY`/`EACCES` (the target or source is
 * held open by an antivirus, an indexer, a reader or another instance) are retried after each delay of
 * `delays`; any other code, or exhausted retries, is thrown. Always off the hot path.
 */
export async function renameWithRetry(
  fs: Pick<PersistFs, "rename">,
  from: string,
  to: string,
  sleep: (ms: number) => Promise<void>,
  delays: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  await withRetry(() => fs.rename(from, to), sleep, delays);
}

// ---------------------------------------------------------------------------
// Decision-log rows
// ---------------------------------------------------------------------------

const LOGGED_MODES: readonly string[] = ["shadow", "advise", "enforce"];
const COST_UNITS: readonly string[] = ["usd", "ratio"];
const VERDICT_VALUES: readonly string[] = ["pass", "fail", "unverifiable"];

function isOutcomeKey(x: unknown): x is OutcomeKey {
  return typeof x === "string" && parseKey(x) !== null;
}

function oneOf(list: readonly string[], x: unknown): x is string {
  return typeof x === "string" && list.includes(x);
}

function readChoice(x: unknown): RouteChoice | null {
  if (!isRec(x)) return null;
  const { key, agent, origin, model, variant } = x;
  if (!isOutcomeKey(key) || typeof agent !== "string" || typeof model !== "string" || typeof variant !== "string") return null;
  if (origin !== "router" && origin !== "host") return null;
  return { key, agent, origin, model, variant };
}

function readLadderStep(x: unknown): (typeof LADDER_STEP_KINDS)[number] | null {
  return LADDER_STEP_KINDS.find((kind) => kind === x) ?? null;
}

/**
 * Validate one JSONL line. A valid row comes back as a clean copy (unknown extra fields are ignored,
 * forward-compatible within v1; non-finite `costs` entries are dropped); anything else is `null`.
 */
export function parseLogLine(line: string): LogRow | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRec(json) || json.v !== LOG_ROW_VERSION) return null;
  const { kind, ts, sessionID } = json;
  if (typeof ts !== "string" || !Number.isFinite(Date.parse(ts)) || typeof sessionID !== "string") return null;
  const step = readLadderStep(json.step);
  if (step === null) return null;

  if (kind === "verdict" || kind === "refusal") {
    const { decisionID, childSessionID, attemptID, key } = json;
    if (decisionID !== null && typeof decisionID !== "string") return null;
    if (typeof childSessionID !== "string" || typeof attemptID !== "string" || !isOutcomeKey(key)) return null;
    if (kind === "refusal") {
      const row: RefusalRow = { v: LOG_ROW_VERSION, kind, ts, sessionID, decisionID, childSessionID, attemptID, key, step };
      return row;
    }
    const verdict = json.verdict;
    if (!oneOf(VERDICT_VALUES, verdict)) return null;
    const row: VerdictRow = {
      v: LOG_ROW_VERSION,
      kind,
      ts,
      sessionID,
      decisionID,
      childSessionID,
      attemptID,
      key,
      verdict: verdict as VerdictRow["verdict"],
      step,
    };
    return row;
  }

  if (kind !== "decision") return null;
  const { decisionID, mode, childSessionID, facts, switched, pinned, unit, costs, confidence, reason, resume } = json;
  if (typeof decisionID !== "string" || !oneOf(LOGGED_MODES, mode) || !oneOf(COST_UNITS, unit)) return null;
  if (childSessionID !== null && typeof childSessionID !== "string") return null;
  if (typeof switched !== "boolean" || typeof pinned !== "boolean" || typeof resume !== "boolean") return null;
  if (!isFiniteNum(confidence) || typeof reason !== "string") return null;

  if (!isRec(facts)) return null;
  const { class: cls, risk, scope, needs, confidence: factsConfidence, source } = facts;
  if (typeof cls !== "string" || typeof risk !== "string" || typeof scope !== "string" || typeof source !== "string") return null;
  if (!Array.isArray(needs) || !needs.every((n): n is string => typeof n === "string")) return null;
  if (!isFiniteNum(factsConfidence)) return null;

  const chosen = readChoice(json.chosen);
  if (chosen === null) return null;
  const best = json.best === null ? null : readChoice(json.best);
  if (json.best !== null && best === null) return null;

  if (!isRec(costs)) return null;
  const cleanCosts: Record<string, number> = Object.fromEntries(
    Object.entries(costs).filter((entry): entry is [string, number] => isFiniteNum(entry[1])),
  );

  const row: DecisionRow = {
    v: LOG_ROW_VERSION,
    kind,
    ts,
    sessionID,
    decisionID,
    mode: mode as DecisionRow["mode"],
    childSessionID,
    facts: { class: cls, risk, scope, needs: [...needs], confidence: factsConfidence, source },
    chosen,
    best,
    switched,
    pinned,
    unit: unit as DecisionRow["unit"],
    costs: cleanCosts,
    confidence,
    reason,
    step,
    resume,
  };
  return row;
}

/** `20261006T120000123Z` for the rotated generation names (`DECISIONS_ROTATED_RE`). */
export function compactStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, "");
}

function stampToMs(stamp: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (m === null) return null;
  const [, y, mo, d, h, mi, s, ms] = m.map(Number) as [number, number, number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

function rotatedNames(names: readonly string[]): string[] {
  return names.filter((name) => DECISIONS_ROTATED_RE.test(name)).sort();
}

// ---------------------------------------------------------------------------
// Persister
// ---------------------------------------------------------------------------

export function createPersister(dir: string, deps: PersistDeps, options: PersisterOptions = {}): Persister {
  const { fs, now, sleep, logger, pid } = deps;
  const outcomesPath = join(dir, OUTCOMES_FILE);
  const corruptPath = join(dir, OUTCOMES_CORRUPT_FILE);
  const decisionsPath = join(dir, DECISIONS_FILE);
  const maxBytes = options.maxBytes ?? DECISIONS_MAX_BYTES;
  const maxGenerations = Math.max(0, Math.floor(options.maxGenerations ?? DECISIONS_MAX_GENERATIONS));
  const delays = options.renameRetryDelaysMs ?? RENAME_RETRY_DELAYS_MS;

  let seq = 0;
  /** Set when the file on disk must not be overwritten (newer schema, or unreadable). */
  let readOnlyReason: string | null = null;
  /** mtime of outcomes.json at the last load/save; `undefined` until the first load (no foreign-writer check). */
  let lastKnownMtime: number | null | undefined;
  let warnedForeignWriter = false;

  async function statOrNull(path: string): Promise<PersistStat | null> {
    try {
      return await fs.stat(path);
    } catch (error) {
      logger.info?.("[router] outcome store stat failed", { path, error: describeError(error) });
      return null;
    }
  }

  async function cleanStaleTemps(): Promise<void> {
    try {
      const t = now();
      for (const name of await fs.readdir(dir)) {
        if (!name.startsWith(OUTCOMES_TMP_PREFIX)) continue;
        const path = join(dir, name);
        try {
          const st = await fs.stat(path);
          if (st !== null && t - st.mtimeMs > STALE_TMP_MS) await fs.unlink(path);
        } catch (error) {
          logger.info?.("[router] stale outcome temp file not removed", { path, error: describeError(error) });
        }
      }
    } catch (error) {
      logger.info?.("[router] outcome temp cleanup skipped", { dir, error: describeError(error) });
    }
  }

  function loadResult(
    status: LoadStatus,
    message: string | null,
    snapshot: OutcomeSnapshot = emptySnapshot(),
    dropped = 0,
    savedAt: string | null = null,
  ): LoadResult {
    return { status, snapshot, dropped, savedAt, message };
  }

  async function loadInner(quarantine: boolean): Promise<LoadResult> {
    readOnlyReason = null;
    const absPath = resolve(outcomesPath);
    let result: LoadResult;
    let text: string | null;
    try {
      text = await withRetry(() => fs.readText(outcomesPath), sleep, delays);
    } catch (error) {
      // Something exists but cannot be read: never overwrite it blindly.
      readOnlyReason = `outcome store at ${absPath} is unreadable`;
      const reason = describeError(error);
      logger.warn("[router] outcome store unreadable; persistence disabled for this process", { path: outcomesPath, reason });
      return loadResult("corrupt", `${absPath}: cannot read (${reason})`);
    }

    if (text === null) {
      result = loadResult("missing", null);
    } else {
      let json: unknown;
      let parseError: string | null = null;
      try {
        json = JSON.parse(text);
      } catch (error) {
        parseError = `invalid JSON: ${describeError(error)}`;
      }
      const parsed = parseError === null ? parseSnapshot(json) : null;

      if (parsed !== null && parsed.ok) {
        const savedAt = isRec(json) && typeof json.savedAt === "string" ? json.savedAt : null;
        let message: string | null = null;
        if (parsed.dropped > 0) {
          message = `${absPath}: ${parsed.dropped} invalid ${parsed.dropped === 1 ? "entry" : "entries"} dropped`;
          logger.warn("[router] outcome store had invalid entries; they were dropped", { path: outcomesPath, dropped: parsed.dropped });
        }
        result = loadResult("ok", message, parsed.snapshot, parsed.dropped, savedAt);
      } else if (parsed !== null && parsed.reason === "unsupported-version") {
        readOnlyReason = "unsupported outcome store version on disk";
        logger.warn("[router] outcome store was written by a newer version; leaving it untouched", {
          path: outcomesPath,
          reason: parsed.message,
        });
        result = loadResult("unsupported-version", `${absPath}: ${parsed.message}`);
      } else {
        const reason = parseError ?? (parsed !== null && !parsed.ok ? parsed.message : "unknown error");
        if (quarantine) {
          try {
            await renameWithRetry(fs, outcomesPath, corruptPath, sleep, delays);
          } catch (error) {
            logger.warn("[router] could not quarantine the corrupt outcome store; the next save overwrites it", {
              path: outcomesPath,
              error: describeError(error),
            });
          }
        }
        logger.warn("[router] outcome store corrupted; starting fresh", { path: outcomesPath, reason });
        result = loadResult("corrupt", `${absPath}: ${reason}`);
      }
    }

    lastKnownMtime = (await statOrNull(outcomesPath))?.mtimeMs ?? null;
    if (quarantine) await cleanStaleTemps();
    return result;
  }

  async function checkForeignWriter(): Promise<void> {
    if (lastKnownMtime === undefined || warnedForeignWriter) return;
    const current = (await statOrNull(outcomesPath))?.mtimeMs ?? null;
    if (current !== lastKnownMtime) {
      warnedForeignWriter = true;
      logger.warn("[router] another process wrote outcomes.json; the last writer wins", { path: outcomesPath });
    }
  }

  async function rotate(): Promise<void> {
    try {
      let ms = now();
      const newest = rotatedNames(await fs.readdir(dir)).at(-1);
      const match = newest === undefined ? null : DECISIONS_ROTATED_RE.exec(newest);
      const newestMs = match === null ? null : stampToMs(match[1] as string);
      if (newestMs !== null && ms <= newestMs) ms = newestMs + 1; // names stay unique and chronological
      const target = join(dir, `decisions.${compactStamp(ms)}-${pid}.jsonl`);
      try {
        await renameWithRetry(fs, decisionsPath, target, sleep, delays);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error; // ENOENT: another process rotated first
      }
      const generations = rotatedNames(await fs.readdir(dir));
      for (const name of generations.slice(0, Math.max(0, generations.length - maxGenerations))) {
        try {
          await fs.unlink(join(dir, name));
        } catch (error) {
          logger.warn("[router] could not prune a rotated decision log", { name, error: describeError(error) });
        }
      }
    } catch (error) {
      logger.warn("[router] decision log rotation failed; appending to the live file", { error: describeError(error) });
    }
  }

  return {
    dir,
    outcomesPath,
    decisionsPath,

    async load(opts?: { readonly quarantine?: boolean }): Promise<LoadResult> {
      try {
        return await loadInner(opts?.quarantine ?? true);
      } catch (error) {
        const reason = describeError(error);
        readOnlyReason = `outcome store at ${resolve(outcomesPath)} failed to load`;
        logger.warn("[router] outcome store failed to load; persistence disabled for this process", { path: outcomesPath, reason });
        return loadResult("corrupt", `${resolve(outcomesPath)}: ${reason}`);
      }
    },

    async saveSnapshot(snapshot: OutcomeSnapshot): Promise<WriteResult> {
      if (readOnlyReason !== null) return { ok: false, error: readOnlyReason };
      const tmp = join(dir, `${OUTCOMES_TMP_PREFIX}${pid}-${++seq}`);
      try {
        await fs.mkdirp(dir);
        await checkForeignWriter();
        const file: OutcomesFile = {
          schema: OUTCOMES_SCHEMA_ID,
          version: OUTCOMES_SCHEMA_VERSION,
          savedAt: new Date(now()).toISOString(),
          entries: snapshot.entries,
        };
        await fs.writeDurable(tmp, JSON.stringify(file, null, 2) + "\n");
        await renameWithRetry(fs, tmp, outcomesPath, sleep, delays);
        lastKnownMtime = (await statOrNull(outcomesPath))?.mtimeMs ?? null;
        return { ok: true };
      } catch (error) {
        try {
          await fs.unlink(tmp);
        } catch (cleanupError) {
          logger.info?.("[router] outcome temp file not removed", { tmp, error: describeError(cleanupError) });
        }
        return failure(error);
      }
    },

    async appendRows(rows: readonly LogRow[]): Promise<WriteResult> {
      if (rows.length === 0) return { ok: true };
      try {
        await fs.mkdirp(dir);
        const data = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        const bytes = Buffer.byteLength(data, "utf8");
        const size = (await statOrNull(decisionsPath))?.size ?? 0;
        if (size > 0 && size + bytes > maxBytes) await rotate();
        await fs.appendText(decisionsPath, data);
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },

    async readRows(): Promise<ReadRowsResult> {
      const rows: LogRow[] = [];
      const files: string[] = [];
      let skipped = 0;
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch (error) {
        logger.warn("[router] decision log directory unreadable", { dir, error: describeError(error) });
        return { rows, skipped, files };
      }
      for (const name of [...rotatedNames(names), DECISIONS_FILE]) {
        const path = join(dir, name);
        let text: string | null;
        try {
          text = await withRetry(() => fs.readText(path), sleep, delays);
        } catch (error) {
          logger.warn("[router] decision log unreadable; skipped", { path, error: describeError(error) });
          continue;
        }
        if (text === null) continue;
        files.push(path);
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() === "") continue;
          const row = parseLogLine(line);
          if (row === null) skipped += 1;
          else rows.push(row);
        }
      }
      return { rows, skipped, files };
    },
  };
}

// ---------------------------------------------------------------------------
// Flusher: coalescing, throttled, never on the hot path
// ---------------------------------------------------------------------------

export function createFlusher(
  store: Pick<OutcomeStore, "revision" | "snapshot">,
  persister: Pick<Persister, "saveSnapshot" | "appendRows">,
  deps: FlusherDeps,
  options: FlusherOptions = {},
): OutcomeFlusher {
  const { now, scheduler, logger } = deps;
  const minIntervalMs = options.minIntervalMs ?? FLUSH_MIN_INTERVAL_MS;
  const batchRows = Math.max(1, Math.floor(options.batchRows ?? FLUSH_BATCH_ROWS));
  const maxQueuedRows = Math.max(1, Math.floor(options.maxQueuedRows ?? MAX_QUEUED_ROWS));

  let queue: LogRow[] = [];
  let writtenRevision = store.revision;
  let inFlight: Promise<void> | null = null;
  let timer: { handle: unknown } | null = null;
  let again = false;
  let lastFlushEnd = Number.NEGATIVE_INFINITY;
  let disposed = false;
  let disposing: Promise<void> | null = null;
  let droppedRows = 0;
  let failing = false;
  let idleWaiters: Array<() => void> = [];

  const hasWork = (): boolean => store.revision !== writtenRevision || queue.length > 0;
  const quiescent = (): boolean => timer === null && inFlight === null;

  function releaseIdleWaiters(force = false): void {
    if (!force && !quiescent()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const release of waiters) release();
  }

  function whenIdle(): Promise<void> {
    if (quiescent()) return Promise.resolve();
    return new Promise<void>((done) => {
      idleWaiters.push(done);
    });
  }

  function trimQueue(): void {
    const over = queue.length - maxQueuedRows;
    if (over > 0) {
      queue.splice(0, over);
      droppedRows += over;
    }
  }

  function noteFailure(what: string, error: string): void {
    if (failing) return;
    failing = true;
    logger.warn(`[router] outcome ${what} write failed; will retry`, { error });
  }

  function schedule(ms: number): void {
    const slot: { handle: unknown } = { handle: undefined };
    timer = slot;
    try {
      slot.handle = scheduler.setTimer(() => {
        if (timer === slot) timer = null;
        void startFlush();
      }, ms);
    } catch (error) {
      if (timer === slot) timer = null;
      logger.warn("[router] outcome flush could not be scheduled", { error: describeError(error) });
    }
  }

  function cancelTimer(): void {
    const slot = timer;
    timer = null;
    if (slot === null) return;
    try {
      scheduler.clearTimer(slot.handle);
    } catch (error) {
      logger.warn("[router] outcome flush timer could not be cleared", { error: describeError(error) });
    }
  }

  async function doFlush(): Promise<void> {
    let ok = true;
    const revision = store.revision;
    if (revision !== writtenRevision) {
      const result = await persister.saveSnapshot(store.snapshot());
      if (result.ok) {
        writtenRevision = revision;
      } else {
        ok = false;
        noteFailure("snapshot", result.error);
      }
    }
    while (queue.length > 0) {
      const batch = queue.splice(0, batchRows);
      const result = await persister.appendRows(batch);
      if (!result.ok) {
        queue = batch.concat(queue);
        trimQueue();
        ok = false;
        noteFailure("decision log", result.error);
        break;
      }
    }
    if (droppedRows > 0) {
      logger.warn("[router] outcome decision rows were dropped (queue limit)", { dropped: droppedRows });
      droppedRows = 0;
    }
    if (ok && failing) {
      failing = false;
      logger.info?.("[router] outcome persistence recovered");
    }
  }

  function startFlush(): Promise<void> {
    const run: Promise<void> = doFlush()
      .catch((error: unknown) => {
        noteFailure("flush", describeError(error));
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
        lastFlushEnd = now();
        if (!disposed && (again || hasWork())) {
          again = false;
          if (timer === null) schedule(minIntervalMs);
        }
        releaseIdleWaiters();
      });
    inFlight = run;
    return run;
  }

  function requestFlush(): Promise<void> {
    if (disposed || !hasWork()) return Promise.resolve();
    if (inFlight !== null) {
      again = true;
      return whenIdle();
    }
    if (timer === null) schedule(Math.max(0, lastFlushEnd + minIntervalMs - now()));
    return whenIdle();
  }

  async function flushNow(): Promise<void> {
    while (inFlight !== null) await inFlight;
    cancelTimer();
    await startFlush();
  }

  function dispose(): Promise<void> {
    disposing ??= (async () => {
      await flushNow();
      cancelTimer();
      disposed = true;
      releaseIdleWaiters(true);
    })();
    return disposing;
  }

  return {
    get pendingRows(): number {
      return queue.length;
    },
    enqueue(row: LogRow): void {
      if (disposed) return;
      queue.push(row);
      trimQueue();
      void requestFlush();
    },
    requestFlush,
    flushNow,
    dispose,
  };
}
