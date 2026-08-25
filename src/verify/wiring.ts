/**
 * The impure corner of Layer 2.
 *
 * Everything else under src/verify/ is pure: the gate, the DoD schema, the
 * deterministic checks and the grader protocol all take their side effects as
 * injected deps. This module is where those deps are actually built out of a
 * child_process, a filesystem and an opencode client, so the impurity lives in
 * one named place instead of spread through the plugin factory.
 *
 * Config is read through a getter rather than captured. `cfg` in index.ts is a
 * `let` that is reassigned whenever a command reloads it, so a snapshot taken
 * at construction would leave the grader pinned to the models and enforcement
 * settings that were active when the plugin loaded, and `/preset` would
 * silently stop applying to graded work.
 */
import { exec as nodeExec } from "node:child_process";
import { access, readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createMutexRegistry } from "./deterministic";
import { tierModel } from "./dispatch";
import {
  DEFAULT_GRADER_PROMPT_TIMEOUT_MS,
  timeoutMs,
  withTimeout,
} from "./timeout";
import type { RouterConfig } from "../router/config";
import type { GateDeps } from "./gate";
// The grader request shape is owned by checker.ts, which builds it. Re-exported
// here because this module is where it is consumed, and because keeping a
// second local copy is exactly how `cwd` got dropped: the checker set it, the
// wiring's narrower structural type silently discarded it, and the grader ran
// against the router's directory while claiming to check the producer's.
import type { GraderRequest } from "./checker";
export type { GraderRequest };

/**
 * Upper bound on the disposal memo. Far above the number of child sessions any
 * one delegation can have in flight, and small enough that the memo can never
 * become a meaningful retention for a long-lived plugin instance.
 */
export const DISPOSED_MEMO_MAX = 512;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Join the text parts of an opencode prompt response. Tolerant of a missing or
 * malformed body by design: every call site is fail-closed, and an empty string
 * reads downstream as "the grader said nothing", which is not a pass.
 */
export function extractAssistantText(res: any): string {
  const parts: any[] = res?.data?.parts ?? [];
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

export interface VerificationWiring {
  /** Session ids currently running a grader prompt, so hooks can skip them. */
  graderSessions: Set<string>;
  /** Abort then delete a plugin-created child session. Never throws. */
  disposeChildSession(sid: string): Promise<void>;
  /** Run one grader turn, parented to the caller's session when given. */
  dispatchGrader(
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }>;
  /**
   * Deps for the acceptance gate; graders are parented to parentSessionID.
   *
   * `inFlight`, when supplied, receives the id of every grader session this
   * gate invocation currently has open, and loses it again the moment that
   * grader finishes. A caller enforcing a gate budget aborts THAT set — never
   * the wiring-global one, which belongs to every concurrent delegation at
   * once.
   */
  buildGateDeps(parentSessionID?: string, inFlight?: Set<string>): GateDeps;
}

export function createVerificationWiring(deps: {
  client: any;
  /** Project root; relative paths in checks resolve against it. */
  directory: string;
  getConfig: () => RouterConfig;
}): VerificationWiring {
  const { client, directory, getConfig } = deps;
  const graderSessions = new Set<string>();
  /** Child sessions already torn down; see disposeChildSession. */
  const disposed = new Set<string>();
  const mutex = createMutexRegistry();

  const execSeam = (
    command: string,
    opts?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult> =>
    new Promise((resolve) => {
      try {
        nodeExec(
          command,
          {
            cwd: opts?.cwd ?? directory,
            timeout: opts?.timeoutMs ?? 120000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          },
          (err: any, stdout: any, stderr: any) => {
            const timedOut = !!(err && err.killed && err.signal === "SIGTERM");
            const code =
              err && typeof err.code === "number" ? err.code : err ? 1 : 0;
            resolve({
              code,
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              timedOut,
            });
          },
        );
      } catch {
        resolve({ code: 1, stdout: "", stderr: "exec failed", timedOut: false });
      }
    });

  const fsSeam = {
    async fileExists(p: string): Promise<boolean> {
      try {
        await access(isAbsolute(p) ? p : join(directory, p));
        return true;
      } catch {
        return false;
      }
    },
    async readFile(p: string): Promise<string> {
      return await fsReadFile(isAbsolute(p) ? p : join(directory, p), "utf-8");
    },
  };

  // Best-effort disposal of a plugin-created child session: abort any in-flight
  // work, then delete it so it does not linger forever as a top-level session in
  // the TUI. Fail-soft by contract — never throws, so it is safe to call from a
  // finally without masking the original error.
  const disposeChildSession = async (sid: string): Promise<void> => {
    // Idempotent, not merely fail-soft. Several paths legitimately dispose the
    // same session — the per-attempt teardown in the delegate ladder and the
    // end-of-execute safety net both do, and a timeout racing a late completion
    // can too. Re-issuing abort+delete was harmless but not free, and it made
    // "disposed exactly once" unassertable, which is precisely the property the
    // time-box work has to be able to prove.
    if (disposed.has(sid)) return;
    // Bounded: the memo only has to outlive the handful of callers that can
    // race over one session (per-attempt teardown, the end-of-execute safety
    // net, a timeout beaten by a late completion), all of which happen within a
    // single delegate call. A plugin instance lives for the whole editor
    // session, so an unbounded Set would be a slow leak. Insertion order is
    // specified for Set, so dropping from the front evicts the oldest ids.
    if (disposed.size >= DISPOSED_MEMO_MAX) {
      let toDrop = disposed.size - DISPOSED_MEMO_MAX + 1;
      for (const old of disposed) {
        disposed.delete(old);
        if (--toDrop <= 0) break;
      }
    }
    disposed.add(sid);
    try {
      await client.session.abort({ path: { id: sid } });
    } catch {
      // best-effort: the session may already have completed or been removed
    }
    try {
      await client.session.delete({ path: { id: sid } });
    } catch {
      // best-effort: cleanup must never break the run
    }
  };

  const dispatchGrader = async (
    req: GraderRequest,
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): Promise<{ sessionID: string; text: string }> => {
    // Scope the grader session to the producer's working directory when one was
    // declared. Naming the directory in the prompt is not enough: the grader
    // has real tools, and an unscoped session resolves every read and command
    // against the router's own cwd, so it would happily report "file not found"
    // for work that exists exactly where it was asked for.
    const created: any = await client.session.create({
      body: { ...(parentSessionID ? { parentID: parentSessionID } : {}) },
      ...(req.cwd ? { query: { directory: req.cwd } } : {}),
    });
    const sid: string | undefined = created?.data?.id;
    if (!sid) return { sessionID: "", text: "" };
    graderSessions.add(sid);
    inFlight?.add(sid);
    try {
      const cfg = getConfig();
      const model = tierModel(cfg, req.tier) ?? undefined;
      // Time-boxed for the same reason as the producer prompt, but with a
      // sharper edge: a grader that never answers must not be able to hold the
      // gate open. The RouterTimeoutError is deliberately allowed to propagate
      // to runChecker, whose fail-closed catch turns it into a non-passing
      // verdict naming the timeout. Explicitly NOT modelled as "inconclusive",
      // because an inconclusive grader that releases the gate is a fabricated
      // pass wearing a hedge.
      //
      // No abort is issued here: the finally below already calls
      // disposeChildSession, which aborts before it deletes, so a second abort
      // on this path would be a redundant round trip that cancels nothing extra.
      // (The gate-budget path in index.ts does issue a raw abort, deliberately:
      // it fires while this call is still suspended, before the finally has had
      // a chance to run at all.)
      const res: any = await withTimeout(
        client.session.prompt({
          path: { id: sid },
          body: {
            ...(model ? { model } : {}),
            system: req.system,
            parts: [{ type: "text", text: req.prompt }],
          },
        }),
        timeoutMs(
          cfg.enforcement?.verify?.graderTimeoutMs,
          DEFAULT_GRADER_PROMPT_TIMEOUT_MS,
        ),
        "grader prompt",
      );
      return { sessionID: sid, text: extractAssistantText(res) };
    } finally {
      graderSessions.delete(sid);
      inFlight?.delete(sid);
      await disposeChildSession(sid);
    }
  };

  const buildGateDeps = (
    parentSessionID?: string,
    inFlight?: Set<string>,
  ): GateDeps => {
    const cfg = getConfig();
    return {
      deterministic: {
        exec: execSeam,
        fs: fsSeam,
        cwd: directory,
        mutex,
      },
      checker: {
        dispatchGrader: (req: GraderRequest) =>
          dispatchGrader(req, parentSessionID, inFlight),
        ladder: ["fast", "medium", "heavy"],
        minGraderTier: cfg.enforcement?.verify?.minGraderTier ?? null,
      },
      require: cfg.enforcement?.verify?.require,
    };
  };

  return {
    graderSessions,
    disposeChildSession,
    dispatchGrader,
    buildGateDeps,
  };
}
