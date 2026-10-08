/**
 * src/verify/dispatch.ts — shared helpers and TTL-managed dispatch state
 * (Option (i) verify-dispatch around the built-in `task` tool, and Option (ii)
 * the plugin-owned `delegate` tool). No network/SDK here, and no fs beyond the realpath
 * that canonicalises change-set keys (QA-2.1-8); bounded background
 * work uses the shared timeout primitive, and the live adapters
 * (exec/fs/grader) are built in index.ts from PluginInput and injected.
 */
import type { RouterConfig } from "../router/config";
import { getActiveTiers } from "../router/protocol";
import { parseDoDFromDispatch, inferDoD } from "./dod";
import type { DoD, InferHints } from "./dod";
import { isIncompleteReason } from "./checker";
import { stripDispatchHeader } from "../router/dispatch-header";
import { DEFAULT_IDLE_TTL_MS } from "../router/idle-sweep";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { ReferenceState, Verdict } from "./types";
import type { DispatchReference } from "./reference";
import { REFERENCE_NONE } from "./baseline";
import { neutralizeDirectives } from "./pending";
import { withTimeout } from "./timeout";

export interface TreeSnapshot {
  cwd: string;
  /** Real path of `git rev-parse --show-toplevel` at capture time. */
  root?: string;
  head: string;
  fingerprint: string;
  dirty: boolean;
  files: ChangedFile[];
  /**
   * QA-2.1-2: a content identity per digested path (absolute, as in `files`): FILE_DIGEST_PREFIX +
   * sha256, LINK_DIGEST_PREFIX + target, or ABSENT_DIGEST. A dispatch snapshot digests its listed
   * (dirty or untracked) paths; a gate snapshot digests the dispatch snapshot's paths.
   * "unavailable" (over the digest bounds, or unreadable) and absent both mean no per-file proof.
   */
  digests?: ReadonlyMap<string, string> | "unavailable";
}

/** QA-2.1-2: the digest of a path that does not exist. */
export const ABSENT_DIGEST = "absent";
export const FILE_DIGEST_PREFIX = "file:";
export const LINK_DIGEST_PREFIX = "link:";

/** What beginDispatch runs in the background for one dispatch (never a test command, G6). */
export interface DispatchCaptureDeps {
  /** The change baseline: the tree snapshot `delta` compares against. */
  snapshot(cwd: string, signal: AbortSignal): Promise<TreeSnapshot | undefined>;
  /**
   * The git-only dispatch reference (reference.ts captureReference); undefined = no reference.
   * Absent: nothing is captured and the dispatch's reference is `uncaptured`.
   */
  capture?: (cwd: string, signal: AbortSignal) => Promise<DispatchReference | undefined>;
  /** The reference when `capture` is absent. Default: none (REFERENCE_NONE.notRequested). */
  uncaptured?: ReferenceState;
  /** Bounds the snapshot and the capture, each (baselineTimeoutMs). */
  timeoutMs: number;
}

function none(reason: string): ReferenceState {
  return { kind: "none", reason };
}

/**
 * QA-2.1-8: the canonical spelling of `path`, so a Windows 8.3 short name (`C:\Users\MARQUI~1\…`),
 * a junction or symlink alias, and the long real path of one file key the same change-set entry.
 * The native realpath of the path, or of its nearest existing ancestor with the missing tail
 * appended (a deleted file keeps its directory's canonical spelling); lexical `resolve` when no
 * ancestor resolves.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let head = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** A change-set key: the canonical path with "/" separators, case-folded on win32. */
function pathKey(path: string): string {
  const normalized = canonicalPath(path).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface ChangedFileStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Tools that mutate the workspace (mirrors the guard taxonomy). */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);
/**
 * E2E-3: the tools known never to write the workspace themselves. observeEdit treats EVERY other
 * tool as a possible write: the shells (no command-level proof of read-onlyness), the write tools,
 * and any tool it does not know. opencode fires tool.execute.before for MCP tools too (named
 * `<server>_<tool>`) and for plugin and custom tools, so an MCP `write_file`, a custom editor or
 * `batch` reach the plugin under names no allowlist of writers can list. Such an edit landing
 * while a dispatch snapshot or capture is still in flight (VERIFY_WAIT:0s, or a snapshot slower
 * than the wait) would seed the change baseline, which then hides it ("no changed files": a clean
 * pass), or the reference, where the failure it causes looks pre-existing and is excused.
 * `task` and `delegate` start producer sessions whose own tool calls are observed; `router_verify`
 * only runs checks.
 */
const NON_WRITING_TOOLS = new Set([
  "read", "glob", "grep", "list", "ls", "codesearch", "webfetch", "websearch", "lsp",
  "todoread", "todowrite", "question", "skill", "plan_enter", "plan_exit", "invalid", "task",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  "delegate", "router_verify",
]);

export interface ChangedFile {
  path: string;
  status: string;
  /** Rename/copy source (absolute) when git status reports R or C. */
  previousPath?: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export function extractChangedFile(tool: string, args: unknown): ChangedFile | null {
  if (!WRITE_TOOLS.has(tool)) return null;
  const a = (args ?? {}) as Record<string, unknown>;
  const path =
    typeof a.filePath === "string"
      ? a.filePath
      : typeof a.path === "string"
        ? a.path
        : typeof a.file === "string"
          ? a.file
          : "";
  if (!path) return null;
  const status = tool === "write" ? "written" : "modified";
  return { path, status };
}

/**
 * QA-3.1-2: one dispatch's lifetime, from beginDispatch until its record is dropped. Two windows
 * overlap exactly when one dispatch begins while the other is live, so beginDispatch links the new
 * window with every live one, and a dropped window keeps being counted by the live ones it overlapped.
 */
interface DispatchWindow {
  readonly cwd: string;
  /** The git top-level (TreeSnapshot.root) once the dispatch snapshot settled with one. */
  root?: string;
  /** The other windows that overlapped this one; emptied when this dispatch is dropped. */
  readonly overlapping: Set<DispatchWindow>;
}

/**
 * QA-3.1-3: a tool name as router text names it: [A-Za-z0-9_.-] kept, anything else as "?".
 * QA-3.1-27: at most 64 characters in total; a longer name keeps 63 and ends in "…". Tool names
 * reach the plugin from MCP servers and custom tools.
 */
export function toolLabel(tool: string): string {
  const label = tool.replace(/[^A-Za-z0-9_.-]/g, "?");
  return label.length > 64 ? `${label.slice(0, 63)}…` : label;
}

/** QA-3.1-3: REFERENCE_NONE.contaminated, naming the tool whose call discarded the capture. */
export function contaminatedReferenceReason(tool: string): string {
  return `${REFERENCE_NONE.contaminated} (tool "${toolLabel(tool)}")`;
}

/** One tracked dispatch: its change baseline and its reference (T2 P0). */
interface DispatchRecord {
  cwd: string;
  snapshotPending: boolean;
  /** An overlapping edit was observed while the snapshot was in flight: the snapshot is discarded. */
  snapshotContaminated: boolean;
  /** QA-3.1-3: the first tool whose call discarded the snapshot. */
  snapshotContaminatedBy?: string;
  /** QA-3.1-3: the first tool whose call discarded the capture. */
  captureContaminatedBy?: string;
  /** QA-3.1-2: this dispatch's lifetime, for concurrentDispatches. */
  window: DispatchWindow;
  snapshot?: TreeSnapshot;
  capturePending: boolean;
  /** An overlapping edit was observed while the capture was in flight: the reference is none. */
  captureContaminated: boolean;
  captureController: AbortController;
  /** Settles once; never rejects. */
  reference: Promise<ReferenceState>;
  /** The snapshot settled. */
  ready: Promise<void>;
  /** The snapshot and the reference settled. */
  settled: Promise<void>;
  /**
   * QA-2.1-1: every producer session gated against this dispatch (its lineage: the first attempt,
   * then each retry or escalation, all judged against the one reference).
   */
  producers: Set<string>;
  /**
   * QA-2.1-1: the tool-observed files of every session in `producers`, keyed by pathKey. A retry
   * gate judges the cumulative change since the reference, not only its own attempt's edits.
   */
  observed: Map<string, ChangedFile>;
}

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export function createChangedFileStore(options: ChangedFileStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const bySession = new Map<string, Map<string, string>>();
  const lastTouch = new Map<string, number>();
  const dispatches = new Map<string, DispatchRecord>();

  function observeEdit(tool: string, cwd?: string): void {
    // E2E-3: fail closed. Only a tool known not to write leaves an in-flight snapshot or capture alone.
    if (NON_WRITING_TOOLS.has(tool.toLowerCase())) return;
    // Unknown directory is conservatively treated as overlapping every capture.
    const overlaps = (other: string) => !cwd || pathKey(cwd) === pathKey(other)
      || pathKey(cwd).startsWith(pathKey(other) + "/") || pathKey(other).startsWith(pathKey(cwd) + "/");
    for (const d of dispatches.values()) {
      if (!overlaps(d.cwd)) continue;
      if (d.snapshotPending) {
        d.snapshotContaminated = true;
        d.snapshotContaminatedBy ??= tool;
      }
      // The capture would describe a tree that already holds the edit: discard it, and stop it.
      if (d.capturePending && !d.captureContaminated) {
        d.captureContaminated = true;
        d.captureContaminatedBy = tool;
        d.captureController.abort();
      }
    }
  }

  /**
   * QA-3.1-2: whether `w`'s dispatch worked in the git tree at `at`. Two known git roots must be the
   * same; when either is unknown (a snapshot that found none: its cwd stands in), a directory that
   * is the other, inside it or above it counts. Over-counting only adds a caveat.
   */
  function onRoot(w: DispatchWindow, at: string, atIsRoot: boolean): boolean {
    const key = pathKey(at);
    if (w.root !== undefined && atIsRoot) return pathKey(w.root) === key;
    const its = pathKey(w.root ?? w.cwd);
    return its === key || its.startsWith(key + "/") || key.startsWith(its + "/");
  }

  function touch(sessionID: string): void {
    lastTouch.set(sessionID, now());
  }

  /** QA-2.1-1: folds one producer session's tool-observed files into its dispatch's lineage. */
  function fold(d: DispatchRecord, sessionID: string): void {
    for (const [path, status] of bySession.get(sessionID) ?? []) {
      const absolute = resolve(d.cwd, path);
      const key = pathKey(absolute);
      // "written" (created) stays stickier than a later attempt's "modified", as in record().
      const prev = d.observed.get(key);
      d.observed.set(key, { path: absolute, status: prev?.status === "written" ? "written" : status });
    }
  }

  function evict(sessionID: string): void {
    // A retry's session is cleared after its gate: keep its edits in every lineage it belongs to.
    for (const d of dispatches.values()) if (d.producers.has(sessionID)) fold(d, sessionID);
    bySession.delete(sessionID);
    lastTouch.delete(sessionID);
    const d = dispatches.get(sessionID);
    d?.captureController.abort();
    // QA-3.1-2: the live windows it overlapped keep counting it; its own list is no longer needed
    // (and would otherwise chain every dropped window to the next).
    d?.window.overlapping.clear();
    dispatches.delete(sessionID);
  }

  return {
    /**
     * Starts the bounded background work of one dispatch: the tree snapshot (change baseline) and,
     * when `deps.capture` is given, the git-only reference. Resolves once both settled; never
     * rejects. A dispatch id that is already tracked keeps its ORIGINAL snapshot and reference, so
     * a retry never turns a failed attempt into its own reference.
     */
    beginDispatch(id: string, cwd: string, deps: DispatchCaptureDeps): Promise<void> {
      touch(id);
      const existing = dispatches.get(id);
      if (existing) return existing.settled;
      bySession.delete(id);
      const window: DispatchWindow = { cwd, overlapping: new Set() };
      // QA-3.1-2: every live dispatch overlaps this one's window, and this one overlaps theirs.
      for (const other of dispatches.values()) {
        window.overlapping.add(other.window);
        other.window.overlapping.add(window);
      }
      const d: DispatchRecord = {
        cwd, snapshotPending: true, snapshotContaminated: false,
        capturePending: deps.capture !== undefined, captureContaminated: false,
        captureController: new AbortController(),
        reference: Promise.resolve(deps.uncaptured ?? none(REFERENCE_NONE.notRequested)),
        ready: Promise.resolve(), settled: Promise.resolve(),
        // The delegate ladder's dispatch id is its first producer session.
        producers: new Set([id]), observed: new Map(),
        window,
      };
      dispatches.set(id, d);
      d.ready = (async (): Promise<void> => {
        const controller = new AbortController();
        let snapshot: TreeSnapshot | undefined;
        try {
          snapshot = await withTimeout(deps.snapshot(cwd, controller.signal), deps.timeoutMs, "dispatch fingerprint");
        } catch {
          snapshot = undefined; // Fingerprinting unavailable: keep the explicit missing-snapshot state.
        } finally {
          d.snapshotPending = false;
          controller.abort();
        }
        // A discarded snapshot still tells which git tree the dispatch works in (QA-3.1-2).
        if (snapshot?.root !== undefined) window.root = snapshot.root;
        if (snapshot && !d.snapshotContaminated && dispatches.get(id) === d) d.snapshot = snapshot;
      })();
      const capture = deps.capture;
      if (capture !== undefined) {
        d.reference = (async (): Promise<ReferenceState> => {
          let captured: DispatchReference | undefined;
          try {
            captured = await withTimeout(capture(cwd, d.captureController.signal), deps.timeoutMs, "dispatch reference");
          } catch {
            captured = undefined; // Timed out or failed: "no reference", never a blocked dispatch.
          } finally {
            d.capturePending = false;
            d.captureController.abort();
          }
          if (d.captureContaminated) {
            return none(d.captureContaminatedBy !== undefined ? contaminatedReferenceReason(d.captureContaminatedBy) : REFERENCE_NONE.contaminated);
          }
          return captured ? { kind: "captured", reference: captured } : none(REFERENCE_NONE.failed);
        })();
      }
      d.settled = Promise.all([d.ready, d.reference]).then(() => undefined);
      return d.settled;
    },
    observeEdit,
    /**
     * The dispatch's ReferenceState. An untracked (or swept) dispatch has none. `signal` bounds the
     * wait for a capture still in flight: once it aborts, the reference is none (gate budget).
     */
    reference(id: string, signal?: AbortSignal): Promise<ReferenceState> {
      const d = dispatches.get(id);
      if (!d) return Promise.resolve(none(REFERENCE_NONE.untracked));
      touch(id);
      if (!signal || !d.capturePending) return d.reference;
      if (signal.aborted) return Promise.resolve(none(REFERENCE_NONE.gateBudget));
      return new Promise<ReferenceState>(settle => {
        const onAbort = (): void => settle(none(REFERENCE_NONE.gateBudget));
        signal.addEventListener("abort", onAbort, { once: true });
        void d.reference.then(state => {
          signal.removeEventListener("abort", onAbort);
          settle(state);
        });
      });
    },
    /**
     * The producer's change since the dispatch reference. `childID` joins the dispatch's lineage:
     * the tool-observed files are those of EVERY producer session gated against `id` so far
     * (QA-2.1-1), so a retry never drops a file an earlier attempt edited.
     *
     * `committed` (QA-2.1-12): the files of the commits made since the dispatch snapshot's head
     * (absolute paths), which `git status` no longer lists; "unavailable" when HEAD moved and they
     * could not be listed, which makes the whole change set unavailable. Absent: HEAD did not move.
     */
    delta(
      id: string,
      childID: string,
      current?: TreeSnapshot,
      fallbackCwd?: string,
      committed?: readonly ChangedFile[] | "unavailable",
    ): { changedFiles: ChangedFile[]; changeBaseline: "available" | "unavailable" } {
      const d = dispatches.get(id);
      const snapshot = d?.snapshot;
      const files = new Map<string, ChangedFile>();
      const listed = new Map((current?.files ?? []).map(f => [pathKey(f.path), f] as const));
      let observed: Iterable<[string, string]>;
      if (d) {
        d.producers.add(childID);
        for (const producer of d.producers) fold(d, producer);
        observed = [...d.observed.values()].map(f => [f.path, f.status] as [string, string]);
      } else {
        observed = bySession.get(childID) ?? [];
      }
      for (const [path, status] of observed) {
        const base = d?.cwd ?? current?.cwd ?? fallbackCwd;
        const absolute = base ? resolve(base, path) : path;
        const key = base ? pathKey(absolute) : path;
        // Tool-observed paths never carry deletions or rename sources: when the current snapshot
        // lists the path, its status letters and previousPath win.
        files.set(key, (base ? listed.get(key) : undefined) ?? { path: absolute, status });
      }
      let available = !!snapshot && !!current;
      if (snapshot && current) {
        const before = new Set(snapshot.files.map(f => pathKey(f.path)));
        for (const file of current.files) if (!before.has(pathKey(file.path))) files.set(pathKey(file.path), file);
        // QA-2.1-2: a path already dirty or untracked at dispatch is never "new" above, and a shell
        // edit to it (sed, a formatter, git checkout, git rm) records nothing. An unchanged
        // fingerprint proves no such edit; otherwise each dispatch-listed path whose content
        // identity changed, or which left the listing, is part of the change.
        if (snapshot.fingerprint !== current.fingerprint) {
          const was = snapshot.digests;
          const now = current.digests;
          if (was === undefined || was === "unavailable" || now === undefined || now === "unavailable") {
            // QA-2.1-14: no per-file proof (over the digest bounds). None of the dispatch-listed
            // paths can be proven unchanged, so each is included (wider scope, fails safe) and the
            // change set stays available: still listed, with its current status; left the listing
            // (restored, committed, deleted), as modified or deleted by what is on disk now.
            for (const file of snapshot.files) {
              const key = pathKey(file.path);
              files.set(key, listed.get(key) ?? files.get(key) ?? { path: file.path, status: existsSync(file.path) ? " M" : " D" });
            }
          } else {
            const nowByKey = new Map([...now].map(([path, digest]) => [pathKey(path), digest] as const));
            for (const [path, digest] of was) {
              const key = pathKey(path);
              const after = nowByKey.get(key);
              if (after === digest && listed.has(key)) continue;
              // An undigested path cannot be proven unchanged: it is included (wider scope).
              files.set(key, listed.get(key) ?? files.get(key) ?? { path, status: after === ABSENT_DIGEST ? " D" : " M" });
            }
          }
        }
      }
      // QA-2.1-12: a shell edit to a file clean at dispatch, then committed, leaves nothing in the
      // tree listing. A path the current listing also holds keeps its current status (the newer
      // state) and gains the commit's rename source when it has none.
      if (committed === "unavailable") available = false;
      else if (committed) {
        for (const file of committed) {
          const key = pathKey(file.path);
          const prev = files.get(key);
          if (!prev) files.set(key, file);
          else if (prev.previousPath === undefined && file.previousPath !== undefined) files.set(key, { ...prev, previousPath: file.previousPath });
        }
      }
      return { changedFiles: [...files.values()], changeBaseline: available ? "available" : "unavailable" };
    },
    /** The dispatch-time snapshot (QA-2.1-2: the gate digests its listed paths); undefined until settled. */
    baselineSnapshot(id: string): TreeSnapshot | undefined {
      return dispatches.get(id)?.snapshot;
    },
    /**
     * QA-3.1-2: how many other dispatches were live at some moment of this one's window so far and
     * work in the git tree at `root` (default: this dispatch's own root, else its cwd). Their edits
     * land in the same working tree, so they are part of this dispatch's tree delta. 0 when untracked.
     */
    concurrentDispatches(id: string, root?: string): number {
      const d = dispatches.get(id);
      if (!d) return 0;
      const known = root ?? d.window.root;
      let count = 0;
      for (const w of d.window.overlapping) if (onRoot(w, known ?? d.cwd, known !== undefined)) count += 1;
      return count;
    },
    /** QA-3.1-3: the tool whose call discarded this dispatch's snapshot (the change baseline), if one did. */
    snapshotContaminatedBy(id: string): string | undefined {
      return dispatches.get(id)?.snapshotContaminatedBy;
    },
    record(sessionID: string, tool: string, args: unknown): void {
      touch(sessionID);
      observeEdit(tool, dispatches.get(sessionID)?.cwd);
      if (tool.toLowerCase() === "apply_patch") {
        const a = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const patch = typeof a.patchText === "string" ? a.patchText : typeof a.patch === "string" ? a.patch : "";
        const files = bySession.get(sessionID) ?? new Map<string, string>();
        for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) files.set(match[1].trim(), "modified");
        bySession.set(sessionID, files);
      }
      const cf = extractChangedFile(tool, args);
      if (!cf) return;
      let m = bySession.get(sessionID);
      if (!m) {
        m = new Map();
        bySession.set(sessionID, m);
      }
      // "written" (created) is stickier than a later "modified".
      const prev = m.get(cf.path);
      m.set(cf.path, prev === "written" ? "written" : cf.status);
    },
    get(sessionID: string): ChangedFile[] {
      const m = bySession.get(sessionID);
      if (!m) return [];
      return [...m.entries()].map(([path, status]) => ({ path, status }));
    },
    clear(sessionID: string): void {
      evict(sessionID);
    },
    /** Evict every session idle for >= ttlMs. Future stamps are never evicted. */
    sweep(nowMs: number = now(), ttlMs: number = DEFAULT_IDLE_TTL_MS): void {
      // A dispatch's reference lives on its record, so it follows the same TTL.
      for (const [sessionID, stamp] of [...lastTouch.entries()]) {
        if (nowMs - stamp >= ttlMs) evict(sessionID);
      }
    },
  };
}

const TASK_RESULT_OPEN = "<task_result>";
const TASK_RESULT_CLOSE = "</task_result>";

/**
 * Linear-time extraction of the <task_result> body. Any regex scan here, even a
 * lazy one, backtracks polynomially on repeated open tags with no close
 * (CodeQL js/polynomial-redos), so this walks the string with indexOf instead.
 * Case-insensitive, like the regex it replaced: first open tag, then the first
 * close tag after it. Returns null when either tag is missing.
 */
function extractTaskResult(raw: string): string | null {
  const lower = raw.toLowerCase();
  const start = lower.indexOf(TASK_RESULT_OPEN);
  if (start === -1) return null;
  const end = lower.indexOf(TASK_RESULT_CLOSE, start + TASK_RESULT_OPEN.length);
  if (end === -1) return null;
  return raw.slice(start + TASK_RESULT_OPEN.length, end);
}

/**
 * Parse the built-in `task` tool's after-hook output: the child's final return
 * is wrapped in <task_result>...</task_result> and the child session id lives in
 * output.metadata.sessionId (spike capability C).
 */
export function parseTaskResult(output: unknown): {
  finalReturnText: string;
  childSessionID: string | null;
} {
  const o = (output ?? {}) as Record<string, unknown>;
  const raw = typeof o.output === "string" ? o.output : "";
  const inner = extractTaskResult(raw);
  const finalReturnText = (inner ?? raw).trim();
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const childSessionID =
    typeof meta.sessionId === "string"
      ? meta.sessionId
      : typeof meta.sessionID === "string"
        ? meta.sessionID
        : null;
  return { finalReturnText, childSessionID };
}

/**
 * Build the DoD for a delegation from its dispatch text: an explicit
 * [acceptance] block wins; otherwise auto-infer a minimal, non-vacuous DoD
 * (M2 default). `acceptance` (if provided) is parsed for the block first.
 */
export function buildDelegationDoD(
  args: { prompt?: string; description?: string; acceptance?: string },
  hints: InferHints = {},
): DoD {
  // R6/P-15 (§2.9 E8): the router's dispatch header is a directive, never a
  // criterion — parse and infer from the orchestrator's prompt behind it.
  const prompt = typeof args.prompt === "string" ? stripDispatchHeader(args.prompt) : args.prompt;
  const blockSource = args.acceptance ?? prompt ?? args.description ?? "";
  const explicit = parseDoDFromDispatch(blockSource);
  if (explicit) return explicit;
  const dispatch = prompt ?? args.description ?? "";
  return inferDoD(dispatch, "", hints);
}

/** Resolve a tier name to {providerID, modelID} for client.session.prompt. */
export function tierModel(
  cfg: RouterConfig,
  tierName: string,
): { providerID: string; modelID: string } | null {
  const tiers = getActiveTiers(cfg);
  const t = tiers[tierName];
  if (!t || typeof t.model !== "string") return null;
  const slash = t.model.indexOf("/");
  if (slash <= 0 || slash >= t.model.length - 1) return null;
  return {
    providerID: t.model.slice(0, slash),
    modelID: t.model.slice(slash + 1),
  };
}

/** Decide whether a built-in `task` tool call should be verify-dispatched (Option i). */
export function shouldVerifyTask(
  tool: string,
  mode: string,
  require: string | undefined,
): boolean {
  if (tool !== "task") return false;
  if (mode === "off") return false;
  if ((require ?? "whenDoDPresent") === "never") return false;
  return true;
}

/**
 * Build the advisory forcing note appended to a task result the gate did not accept.
 *
 * QA-2.4-6: the reasons quote producer-controlled text (failing test ids), and an orchestrator may
 * quote this note in its next dispatch before its own `VERIFY:` directive (the first valid one
 * wins). So every directive key loses its colons (pending.ts neutralizeDirectives).
 */
export function buildForcingNote(
  reasons: string[],
  escalation?: { producerTier?: string; nextTier?: string | null; incomplete?: boolean },
): string {
  const body =
    reasons.length > 0
      ? reasons.map((r) => `- ${neutralizeDirectives(r)}`).join("\n")
      : "- (no reasons provided)";
  // §2.9 E8 / I7: a progress note or a budget stop is incomplete, not a failed result.
  // QA-P15-2-4: the verdict's structured flag (`incomplete`); a caller that cannot
  // pass it is recognised by the router's own incomplete reason among the reasons,
  // matched exactly (QA-P15-1-6: a grader's "incomplete: …" stays a failure), so a
  // caveat appended after it does not change the rendering.
  if (escalation?.incomplete === true || reasons.some(isIncompleteReason)) {
    return (
      `[router \u26a0 INCOMPLETE] The delegate stopped before a final result:\n` +
      `${body}\n` +
      `NEXT: resume the same delegation so it can finish; do not treat the prior result as complete.`
    );
  }
  const next =
    escalation?.nextTier
      ? `NEXT: address the above, then re-run via \`Task(subagent_type="${escalation.nextTier}")\`` +
        `${escalation.producerTier ? ` (escalated from ${escalation.producerTier})` : ""}; ` +
        `do not treat the prior result as complete.`
      : `NEXT: address the above and re-run the delegation; do not treat the prior result as complete.`;
  return (
    `[router \u26a0 NOT ACCEPTED] The delegated result was not accepted by independent verification:\n` +
    `${body}\n` +
    next
  );
}

/**
 * Suffix appended to an accepted delegate-tool result. Caveats and notes can name producer test ids
 * ("no worse than before; pre-existing failures: <ids>"), so directive keys lose their colons as in
 * buildForcingNote (QA-2.4-6).
 *
 * Plan G2 (QA-3.1-21): only an outcome "pass" with no caveats reads `[router ✓ verified: <method>]`
 * (QA-3.1-18). Anything else the gate let through (unverifiable, a skipped check, a pass carrying
 * caveats) reads `[router ⚠ UNVERIFIED: <method>]` and is never labelled accepted or verified.
 */
export function buildAcceptedSuffix(
  method: string,
  outcome: Verdict["outcome"],
  caveats: string[] = [],
  notes: string[] = [],
): string {
  const verified = outcome === "pass" && caveats.length === 0;
  const label = verified ? `[router \u2713 verified: ${method}]` : `[router \u26a0 UNVERIFIED: ${method}]`;
  return `\n\n${label}` + (caveats.length
    ? `\nVerification caveats — NOT verified (acceptance is not a passing check):\n${caveats.map(r => `- ${neutralizeDirectives(r)}`).join("\n")}`
    : "") + (notes.length ? `\nVerification notes:\n${notes.map(r => `- ${neutralizeDirectives(r)}`).join("\n")}` : "");
}
