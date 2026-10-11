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
import type { HeadRead } from "./head";

export interface TreeSnapshot {
  cwd: string;
  /** Real path of `git rev-parse --show-toplevel` at capture time. */
  root?: string;
  head: string;
  /**
   * I7 (P0.2): the branch checked out at capture (`git symbolic-ref -q HEAD`): its short name (`feat/x`), or null for a
   * detached HEAD. Absent or undefined: unknown (the command failed, timed out or was aborted). branch.ts compares two.
   */
  branch?: string | null;
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
  /**
   * Cross-repo P2.6 (SD11): a content digest of the repository's ignored files (path, size and content; nothing under a
   * `node_modules` segment), so a linked package's ignored `dist/` can be pinned. "over-bounds": more files or bytes than the
   * bounds allow. Absent: not requested (SnapshotOptions.ignoredDigest) or unavailable (any error).
   */
  ignored?: string | "over-bounds";
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
  /**
   * The cheap head-state read (src/verify/head.ts readHead; "none": no repository or an unborn HEAD) the branch-switch rule
 * compares at the gate. Independent of
   * the snapshot: a snapshot that failed, timed out or was discarded does not lose it. Absent: no head baseline.
   */
  headState?: (cwd: string, signal: AbortSignal) => Promise<HeadRead>;
  /**
   * Cross-repo P1.8 (I13): the extra roots of the dispatch's perimeter P, each snapshotted with `snapshot` next to the change
   * baseline and bounded by `timeoutMs`. Absent: no perimeter, and nothing else is snapshotted (I9).
   */
  perimeter?: DispatchPerimeter;
  /** Cross-repo QA-1 F4 (I11): how an extra root of the perimeter is snapshotted (hardened git). Absent: `snapshot`. */
  perimeterSnapshot?: (cwd: string, signal: AbortSignal) => Promise<TreeSnapshot | undefined>;
  /** Bounds the snapshot, the head read and the capture, each (baselineTimeoutMs). */
  timeoutMs: number;
}

/** Cross-repo P1.8: one extra root of a perimeter, as planned at dispatch (perimeter.ts planPerimeter). */
export interface PerimeterSeed {
  /** Where it is snapshotted: a working-set worktree, or the real path of a package link of W. */
  readonly at: string;
  /** The repository's name when known (the working-set location's); else the basename of its git top level. */
  readonly name?: string;
  /** Link targets only: whether the git top level the snapshot names is admitted (checked at the gate). */
  readonly admit?: (root: string) => boolean;
  /**
   * Cross-repo QA-1: a root that is never snapshotted, and the status the gate reports for it. "unobserved": past PERIMETER_MAX
   * (F2), or the placeholder of a perimeter that could not be planned (F10); I4 refuses it when writers ran. "unadmitted" (F4):
   * a linked directory whose repository is not admitted (`routing.repoParents` / `repoDepth` / `repoExclude`) or that is not a
   * git repository; git never runs there (I11, I12), and I8 names it as not observed.
   */
  readonly fixed?: "unobserved" | "unadmitted";
  /** QA-1 F11: a worktree of W's own repository (the same git common directory): I4 suggests `branch=`, not `repo=`. */
  readonly sameRepository?: boolean;
  /**
   * Cross-repo P2b.3: where the root came from, set by `planPerimeter`: "working-set" (a working-set worktree other than W),
   * "link" (a package link target of W). Consumer discovery scans only the working-set roots.
   */
  readonly origin?: "w" | "working-set" | "link";
  /**
   * Cross-repo QA-1 #9a: a working-set root that is also a package link target of W (the link was de-duplicated into it). It
   * keeps its working-set semantics (consumer discovery, I13) and is pinned at dispatch like a link target.
   */
  readonly linked?: boolean;
}

/** Cross-repo P1.8: the perimeter P of a dispatch beyond W. */
export interface DispatchPerimeter {
  /** W's repository name when the grant's location names it. */
  readonly name?: string;
  readonly roots: readonly PerimeterSeed[];
}

/** Cross-repo P1.8: the dispatch-time state of one extra root of the perimeter. */
export interface PerimeterEntry {
  readonly seed: PerimeterSeed;
  /** Its dispatch snapshot is in flight. */
  pending: boolean;
  /** The first tool whose call may have written into this root while its snapshot was in flight: the snapshot is discarded. */
  contaminatedBy?: string;
  /** Settles once, never rejects; undefined when unavailable, timed out or discarded. */
  snapshot: Promise<TreeSnapshot | undefined>;
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
/**
 * P0.3: router tools that only read (copied, not imported: this module takes no plugin SDK; a pin
 * test compares them with the sources). Exact names: a `context7_*` prefix would also admit a
 * future write tool.
 */
const READ_ONLY_ROUTER_TOOLS = new Set([
  "router_git_status", "router_git_log", "router_git_diff", "router_git_show", "router_git_blame", "router_git_ls_files",
  "router_request_authority",
]);
const BRAVE_TOOLS = ["web_search", "local_search", "news_search", "image_search", "video_search", "summarizer", "llm_context"]
  .map(t => `brave_${t}`);
const READ_ONLY_MCP_TOOLS = new Set([
  "context7_resolve-library-id", "context7_query-docs", "context7_get-library-docs",
  // The server may be mounted as `brave` with tools already named `brave_*`.
  ...BRAVE_TOOLS, ...BRAVE_TOOLS.map(t => `brave_${t}`),
]);

/** Whether `tool` is known never to write the workspace (case-insensitive). */
export function isNonWritingTool(tool: string): boolean {
  const n = tool.toLowerCase();
  return NON_WRITING_TOOLS.has(n) || READ_ONLY_ROUTER_TOOLS.has(n) || READ_ONLY_MCP_TOOLS.has(n);
}

/**
 * P0.3 (invariant I5): a tool that may write but whose writes the router cannot attribute to files
 * (shells, `router_run`, `execute`, MCP and custom tools). An empty change set from a producer
 * that ran one of these is not proof that nothing changed.
 */
export function isUnattributedWriter(tool: string): boolean {
  const n = tool.toLowerCase();
  // F2: a nested child's own writes are attributed to the child's session, not to this producer's lineage, so delegating
  // tools count as writers here. They stay non-writing for observeEdit (they do not contaminate captures).
  if (DELEGATING_TOOLS.has(n)) return true;
  return !WRITE_TOOLS.has(n) && !isNonWritingTool(n);
}

/** F2: tools that start a child session whose writes are not in the caller's lineage. */
const DELEGATING_TOOLS = new Set(["task", "delegate", "subagent"]);

export interface ChangedFile {
  path: string;
  status: string;
  /** Rename/copy source (absolute) when git status reports R or C. */
  previousPath?: string;
}

/** Derive a {path,status} record from a write/edit tool call, or null. */
export function extractChangedFile(tool: string, args: unknown): ChangedFile | null {
  const name = tool.toLowerCase();
  if (!WRITE_TOOLS.has(name)) return null;
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
  const status = name === "write" ? "written" : "modified";
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
  /**
   * The head state read when the dispatch began (branch-switch baseline). Never discarded on contamination: a write does not
   * change what HEAD was. Resolves undefined when the read failed or timed out; never rejects.
   */
  head?: Promise<HeadRead>;
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
  /** P0.3: the unattributable writers (isUnattributedWriter) of every session in `producers`. */
  writers: Set<string>;
  /** Cross-repo P1.8 (I13): the extra roots of the dispatch's perimeter, by snapshot directory; absent: no perimeter. */
  perimeter?: { readonly name?: string; readonly entries: Map<string, PerimeterEntry> };
}

/**
 * Per-session changed-file tracker. We attribute changed files to a delegation
 * by observing that session's own edit/write tool calls (ADR 0002 D3 — NOT a
 * global git diff), which is concurrency-safe under interleaved subagents.
 */
export function createChangedFileStore(options: ChangedFileStoreOptions = {}) {
  const now = options.now ?? Date.now;
  const bySession = new Map<string, Map<string, string>>();
  /** P0.3: per session, the lowercased names of the unattributable writers it ran. */
  const writersBySession = new Map<string, Set<string>>();
  const lastTouch = new Map<string, number>();
  const dispatches = new Map<string, DispatchRecord>();

  /** Cross-repo QA-2 #9c: subscribers told when a call by an unattributable writer (isUnattributedWriter) is seen. */
  const unattributedWriterListeners = new Set<(tool: string, sessionID?: string) => void>();
  function onUnattributedWriter(listener: (tool: string, sessionID?: string) => void): () => void {
    unattributedWriterListeners.add(listener);
    return () => {
      unattributedWriterListeners.delete(listener);
    };
  }
  function notifyUnattributedWriter(tool: string, sessionID?: string): void {
    if (!isUnattributedWriter(tool)) return;
    for (const listener of [...unattributedWriterListeners]) {
      try {
        listener(tool, sessionID);
      } catch {
        // a subscriber never breaks the store
      }
    }
  }

  function observeEdit(tool: string, cwd?: string): void {
    notifyUnattributedWriter(tool);
    contaminateCaptures(tool, cwd);
  }

  function contaminateCaptures(tool: string, cwd?: string): void {
    // E2E-3: fail closed. Only a tool known not to write leaves an in-flight snapshot or capture alone.
    if (isNonWritingTool(tool)) return;
    // Unknown directory is conservatively treated as overlapping every capture.
    const overlaps = (other: string) => !cwd || pathKey(cwd) === pathKey(other)
      || pathKey(cwd).startsWith(pathKey(other) + "/") || pathKey(other).startsWith(pathKey(cwd) + "/");
    for (const d of dispatches.values()) {
      // Cross-repo P1.8: a write that may land in an extra root of the perimeter discards that root's in-flight snapshot.
      // QA-1 F1: an unattributable writer's directory says nothing about where it writes (router_run's cwd is always W), so it
      // discards every in-flight perimeter snapshot, whatever its cwd.
      for (const entry of d.perimeter?.entries.values() ?? []) {
        if (entry.pending && (isUnattributedWriter(tool) || overlaps(entry.seed.at))) entry.contaminatedBy ??= tool;
      }
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

  /**
   * F1: notes, before a call runs, that `sessionID` is about to run a tool whose writes the router cannot attribute. A call
   * that ends in error (or is bypassed) never reaches the after-hook's record(), so the tally is also kept here (a Set: idempotent).
   */
  function noteWriter(sessionID: string, tool: string): void {
    if (!isUnattributedWriter(tool)) return;
    const w = writersBySession.get(sessionID) ?? new Set<string>();
    w.add(tool.toLowerCase());
    writersBySession.set(sessionID, w);
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
    for (const tool of writersBySession.get(sessionID) ?? []) d.writers.add(tool);
  }

  function evict(sessionID: string): void {
    // A retry's session is cleared after its gate: keep its edits in every lineage it belongs to.
    for (const d of dispatches.values()) if (d.producers.has(sessionID)) fold(d, sessionID);
    bySession.delete(sessionID);
    writersBySession.delete(sessionID);
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
      writersBySession.delete(id);
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
        producers: new Set([id]), observed: new Map(), writers: new Set(),
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
      // Cross-repo P1.8 (I13): P is fixed now; each extra root is snapshotted like the change baseline, with the same bound.
      if (deps.perimeter !== undefined && deps.perimeter.roots.length > 0) {
        const entries = new Map<string, PerimeterEntry>();
        const snapshotRoot = deps.perimeterSnapshot ?? deps.snapshot;
        for (const seed of deps.perimeter.roots) {
          // QA-1 F2, F4, F10: a fixed root is kept (the gate reports it) but never snapshotted.
          if (seed.fixed !== undefined) {
            entries.set(seed.at, { seed, pending: false, snapshot: Promise.resolve(undefined) });
            continue;
          }
          const entry: PerimeterEntry = { seed, pending: true, snapshot: Promise.resolve(undefined) };
          entry.snapshot = (async (): Promise<TreeSnapshot | undefined> => {
            const controller = new AbortController();
            let snapshot: TreeSnapshot | undefined;
            try {
              snapshot = await withTimeout(snapshotRoot(seed.at, controller.signal), deps.timeoutMs, "perimeter fingerprint");
            } catch {
              snapshot = undefined; // Unavailable: the gate reports the root as not observed.
            } finally {
              entry.pending = false;
              controller.abort();
            }
            return entry.contaminatedBy === undefined ? snapshot : undefined;
          })();
          entries.set(seed.at, entry);
        }
        d.perimeter = { ...(deps.perimeter.name !== undefined ? { name: deps.perimeter.name } : {}), entries };
      }
      const readHead = deps.headState;
      if (readHead !== undefined) {
        d.head = (async (): Promise<HeadRead> => {
          const controller = new AbortController();
          try {
            return await withTimeout(readHead(cwd, controller.signal), deps.timeoutMs, "dispatch head");
          } catch {
            return undefined; // Unreadable at dispatch: the gate fails closed when the head is readable then.
          } finally {
            controller.abort();
          }
        })();
      }
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
      const perimeterSnapshots = [...(d.perimeter?.entries.values() ?? [])].map(entry => entry.snapshot);
      d.settled = Promise.all([d.ready, d.reference, d.head, ...perimeterSnapshots]).then(() => undefined);
      return d.settled;
    },
    observeEdit,
    /**
     * Cross-repo QA-2 #9c: subscribes `listener` to the calls of an unattributable writer (isUnattributedWriter): observeEdit
     * (before a call, no session) and record (after it, with its session). Returns the unsubscribe function.
     */
    onUnattributedWriter,
    noteWriter,
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
    ): { changedFiles: ChangedFile[]; changeBaseline: "available" | "unavailable"; unattributedWriters: string[] } {
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
      const writers = d ? d.writers : (writersBySession.get(childID) ?? new Set<string>());
      return {
        changedFiles: [...files.values()],
        changeBaseline: available ? "available" : "unavailable",
        unattributedWriters: [...writers].sort(),
      };
    },
    /** The dispatch-time snapshot (QA-2.1-2: the gate digests its listed paths); undefined until settled. */
    baselineSnapshot(id: string): TreeSnapshot | undefined {
      return dispatches.get(id)?.snapshot;
    },
    /** The head state read when the dispatch began; undefined when untracked or no head reader was given. */
    baselineHead(id: string): Promise<HeadRead> | undefined {
      return dispatches.get(id)?.head;
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
    /** Cross-repo P1.8: the dispatch's perimeter beyond W, planned at dispatch; undefined when it has none or is untracked. */
    perimeterOf(id: string): { readonly name?: string; readonly entries: ReadonlyMap<string, PerimeterEntry> } | undefined {
      return dispatches.get(id)?.perimeter;
    },
    record(sessionID: string, tool: string, args: unknown): void {
      notifyUnattributedWriter(tool, sessionID);
      touch(sessionID);
      contaminateCaptures(tool, dispatches.get(sessionID)?.cwd);
      if (isUnattributedWriter(tool)) {
        const w = writersBySession.get(sessionID) ?? new Set<string>();
        w.add(tool.toLowerCase());
        writersBySession.set(sessionID, w);
      }
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

/** QA-G-A3-5: the most reasons (caveats, notes) one rendered list shows; the rest are counted in one closing line. */
export const RENDERED_REASONS_MAX = 20;

/** QA-G-A3-2-1: one line break of any kind. */
const LINE_BREAK = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/;

/**
 * QA-G-A3-2-1: `text` on one line — every line break, with the blanks (space, tab) around it, becomes one space, and a run of
 * breaks (blank lines) one space too; every other character is kept. A text without a line break is returned as it is. Linear
 * (no backtracking regex on producer-derived text).
 */
function joinLines(text: string): string {
  const parts = text.split(LINE_BREAK);
  if (parts.length === 1) return text;
  const blank = (c: string | undefined): boolean => c === " " || c === "\t";
  const kept: string[] = [];
  parts.forEach((part, i) => {
    let start = 0;
    let end = part.length;
    if (i > 0) while (start < end && blank(part[start])) start++;
    if (i < parts.length - 1) while (end > start && blank(part[end - 1])) end--;
    if (end > start) kept.push(part.slice(start, end));
  });
  return kept.join(" ");
}

/**
 * QA-G-A3-5 / QA-G-A3-2-1: a list of reasons as `- ` lines: each reason on ONE line — its line breaks (with the blanks around them)
 * joined into one space, since a line of its own could pose as a router note — and nothing else changed: the router's own reasons
 * (baseline.ts failure-id lists, "suite is NOT green") are never cut; a grader's text was already cut to 500 characters where it
 * entered the verdict (checker.ts `graderReasons`). Directive keys lose their colons (QA-2.4-6); at most
 * {@link RENDERED_REASONS_MAX} lines plus a count of the rest. A list of at most that many one-line reasons renders as before.
 */
function reasonLines(reasons: readonly string[]): string {
  const shown = reasons.slice(0, RENDERED_REASONS_MAX).map((r) => `- ${neutralizeDirectives(joinLines(r))}`);
  const rest = reasons.length - shown.length;
  if (rest > 0) shown.push(`- (${rest} more not shown)`);
  return shown.join("\n");
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
      ? reasonLines(reasons)
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
    ? `\nVerification caveats — NOT verified (acceptance is not a passing check):\n${reasonLines(caveats)}`
    : "") + (notes.length ? `\nVerification notes:\n${reasonLines(notes)}` : "");
}
