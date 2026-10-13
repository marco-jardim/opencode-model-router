/**
 * The `root` argument of `router_git_*` for role agents (`docs/design/cross-repo-phase3-plan.md`, item (b), "Contract:
 * resolution order and texts", SD-3b-2..SD-3b-9; Phase 3 task 3b.2). `root` names another repository the dispatch may read: its
 * absolute top-level path, or its bare name below `routing.repoParents` with the route-line `repo=` semantics (D20, no branch).
 *
 * Pure: every filesystem and git access goes through {@link GitRootDeps}. The session gates (step 1: a role session with an exact
 * binding, a local read action in the grant, parents configured) belong to the caller; this module starts at step 2.
 *
 * 2. Text checks, no call: surrounding whitespace, more than {@link GIT_ROOT_MAX_LENGTH} characters, `rootTextProblem` (a path)
 *    or `repoNameProblem` (a name), any `.git` segment.
 * 3. Text gate, no call on the value: equal to W → `{ ok: true, inWorkRoot: true }`; inside W → a `path=` hint; below a parent
 *    as configured, below a parent's canonical form (QA round 1 F1: a parent that is a junction, symlink or subst drive; the
 *    parents are trusted configuration, resolved once per call) or equal to a working-set worktree → continue; anything else is
 *    outside the read set. A junction from outside the parents into R is therefore refused without resolving it (SD-3b-3).
 * 4. `realpath` and a directory; the canonical path is re-checked against W.
 * 5. The canonical path must be in the read set R (filesystem only, no git: SD-3b-2).
 * 6. It must be the top level of its checkout (`nearestCheckout`), else a `root=<top> path=<rel>` hint.
 * 7. Admission (`admit`, with `known`; a path below a parent's canonical form is passed in the parent's configured form, the one
 *    admission's rule 1 knows); its reason keeps its text with `: no work root.` → `; nothing ran.` (SD-3b-9), control characters
 *    replaced, the leading value display-safe (N1) and every absolute path outside the read set replaced by
 *    {@link GIT_ROOT_OUTSIDE_PLACEHOLDER} (F6). The admitted worktree must be the canonical path (F6 of 3b: the git cwd is
 *    admission's `location.worktree`, never R's main worktree).
 * 8. A name goes through `admission.find(name, { eligible })` first (F4: `eligible` is the text gate and R, so git never runs on a
 *    candidate outside R): no match (with the cap note when the lookup was capped, N2), several repositories or several worktrees
 *    are refused; the one worktree then goes through steps 3–7. A single match in a capped lookup is kept, as `repo=` does.
 * 9. The deadline and the abort signal are checked before the filesystem steps and bound every admission call.
 *
 * Refusal reasons start at `root=<v> …`; the tool adds `[router_git] error: refused: ` (3b.3). Echoed values go through
 * `displaySafe`; an admission sentence (step 7) goes through {@link sanitiseReason} instead, its leading value through `displaySafe`. On success the provenance line has the format of the read-provenance line (`index.ts`), built here so that
 * `git-tools.ts` never imports `read-set.ts` (SD-3b-7). Nothing in `src/router/git-tools.ts` may import this module.
 */
import { normalizeRootText } from "../wire/dispatch";
import { LOOKUP_MAX_DIRS, repoNameProblem, rootTextProblem, type Admission, type AdmissionService, type RepoLocation, type WorktreeEntry } from "./admission";
import { displaySafe, gitMetadataSegment } from "./read-set";

/** Step 2: the longest `root` accepted, in UTF-16 code units. */
export const GIT_ROOT_MAX_LENGTH = 4096;

// ── Text fragments (pinned by the docs-drift test, 3b.6) ─────────────────────────────────────────────────────────────────
/** Step 1 (the caller's session gates, `index.ts`): not a role session (D21). */
export const GIT_ROOT_ROLE_ONLY = "root is only for role agents (roles mode); this session inspects its own repository: omit root";
/** Step 1: no exact binding, no work root or no `router_git` in the grant: the tool's existing I9 text (`git-tools.ts`). */
export const GIT_ROOT_NO_WORK_ROOT = "this role session has no bound work root (I9)";
/** Step 1: the grant has `router_git` but no local read action (SD-3b-5); `<actions>` goes between the two parts. */
export const GIT_ROOT_NEEDS_READ = "root reads another repository and needs read, glob or grep in this dispatch's grant";
export const GIT_ROOT_GIT_ALONE = "router_git alone stays in the work root";
/** Step 1: `routing.repoParents` emptied by a hot reload after start. */
export const GIT_ROOT_NO_PARENTS = "root needs routing.repoParents (cross-repo is not configured); nothing ran";

/** Step 1: the refusal for a grant without a local read action. */
export function gitRootNeedsRead(actions: readonly string[]): string {
  return `${GIT_ROOT_NEEDS_READ} (${actions.map(displaySafe).join(", ")}); ${GIT_ROOT_GIT_ALONE}`;
}

/** Step 2: closes every text refusal. */
export const GIT_ROOT_TEXT_HINT = "; pass the absolute top level of a repository or its name";
export const GIT_ROOT_WHITESPACE = "has leading or trailing whitespace";
export const GIT_ROOT_TOO_LONG = `is longer than ${String(GIT_ROOT_MAX_LENGTH)} characters`;
export const GIT_ROOT_GIT_SEGMENT = "names a .git directory";
/** Step 3. */
export const GIT_ROOT_INSIDE_WORK_ROOT = "is inside your work root";
export const GIT_ROOT_OMIT_ROOT = "omit root and pass path=";
export const GIT_ROOT_OUTSIDE_READ_SET = "is outside this dispatch's read set (the work root, the session's repositories and the repositories below";
/** Step 4. */
export const GIT_ROOT_NOT_DIRECTORY = "is not a directory; nothing ran";
/** Step 5. */
export const GIT_ROOT_RESOLVES_OUTSIDE = "outside this dispatch's read set; nothing ran";
/** Step 6. */
export const GIT_ROOT_INSIDE_REPOSITORY = "is inside the repository at";
/** Step 7: the admission phrase replaced, and its replacement. */
export const GIT_ROOT_ADMISSION_PHRASE = ": no work root.";
export const GIT_ROOT_NOTHING_RAN = "; nothing ran.";
export const GIT_ROOT_ADMITTED_WORKTREE = "the admitted worktree";
/** Step 8. */
export const GIT_ROOT_NO_MATCH = "matches no repository below routing.repoParents";
export const GIT_ROOT_PASS_ONE = "nothing ran. Pass root as one of these absolute paths";
/** Step 9. */
export const GIT_ROOT_TIMED_OUT = "resolving the repository timed out; nothing ran";
export const GIT_ROOT_ABORTED = "resolving the repository was aborted; nothing ran";
/** An admission call that rejected (it never should): fail closed. */
export const GIT_ROOT_FAILED = "resolving the repository failed; nothing ran";
/** Step 7 (QA round 1, F6): replaces an absolute path in an admission reason that is not in the read set. */
export const GIT_ROOT_OUTSIDE_PLACEHOLDER = "<outside the read set>";
/** Step 8 (QA round 1, N2): appended when the name lookup visited its maximum of directories (the route-line wording). */
export function gitRootCappedNote(maxDirs: number): string {
  return `The search stopped after ${String(maxDirs)} directories`;
}
/** Success: the read-provenance line's fixed parts. */
export const GIT_ROOT_PROVENANCE_PREFIX = "[router: read from ";
export const GIT_ROOT_PROVENANCE_SUFFIX = " — read-only in this dispatch]";

/** Every fragment above, for the docs-drift test. */
export const GIT_ROOT_TEXTS: readonly string[] = [
  GIT_ROOT_ROLE_ONLY,
  GIT_ROOT_NEEDS_READ,
  GIT_ROOT_GIT_ALONE,
  GIT_ROOT_NO_PARENTS,
  GIT_ROOT_TEXT_HINT,
  GIT_ROOT_WHITESPACE,
  GIT_ROOT_TOO_LONG,
  GIT_ROOT_GIT_SEGMENT,
  GIT_ROOT_INSIDE_WORK_ROOT,
  GIT_ROOT_OMIT_ROOT,
  GIT_ROOT_OUTSIDE_READ_SET,
  GIT_ROOT_NOT_DIRECTORY,
  GIT_ROOT_RESOLVES_OUTSIDE,
  GIT_ROOT_INSIDE_REPOSITORY,
  GIT_ROOT_NOTHING_RAN,
  GIT_ROOT_ADMITTED_WORKTREE,
  GIT_ROOT_NO_MATCH,
  GIT_ROOT_PASS_ONE,
  GIT_ROOT_TIMED_OUT,
  GIT_ROOT_ABORTED,
  GIT_ROOT_FAILED,
];

export interface GitRootContext {
  /** The dispatch's work root W. */
  readonly workRoot: string;
  /** `routing.repoParents`. */
  readonly parents: readonly string[];
  /** The worktrees of the orchestrator session's working set. */
  readonly workingSet: readonly string[];
}

export interface GitRootDeps {
  /** `realpathSync.native`; throws when the path does not resolve. */
  realpath(path: string): string;
  isDirectory(path: string): boolean;
  /** The top of the nearest checkout holding `path` (canonical), or undefined. Filesystem only, no git. */
  nearestCheckout(path: string): string | undefined;
  /** Whether the canonical `path` lies in the dispatch's read set R. Filesystem only, no git. */
  inReadSet(path: string): boolean;
  readonly admission: Pick<AdmissionService, "admit" | "find">;
  /** Repositories whose worktrees admission's rule 2 may admit: the session directory, the grant's repository, the working set. */
  readonly known: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly signal?: AbortSignal;
  /** `Date.now()` value after which resolution stops (SD-3b-8: one deadline per call). */
  readonly deadlineAt?: number;
}

export type GitRootResolution =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly inWorkRoot: true }
  | {
    readonly ok: true;
    readonly inWorkRoot: false;
    /** The git cwd: admission's `location.worktree`. */
    readonly root: string;
    readonly repository: string;
    readonly name: string;
    /** null: detached. */
    readonly branch: string | null;
    /** W, for the executable guards (`workRootGuards(root) ∪ workRootGuards(W)`). */
    readonly workRoot: string;
    /** The first line of the tool's output. */
    readonly provenance: string;
  };

const IN_WORK_ROOT: GitRootResolution = { ok: true, inWorkRoot: true };

/** The read-provenance line for an admitted location (same format as `read`, `glob` and `grep`). */
export function gitRootProvenance(location: Pick<RepoLocation, "name" | "branch" | "worktree">): string {
  return `${GIT_ROOT_PROVENANCE_PREFIX}${displaySafe(location.name)} (${displaySafe(location.branch ?? "detached")}) at ${displaySafe(location.worktree)}${GIT_ROOT_PROVENANCE_SUFFIX}`;
}

/** SD-3b-9: an admission reason with `: no work root.` replaced by `; nothing ran.`, or `; nothing ran.` appended. */
export function mapAdmissionReason(reason: string): string {
  if (reason.includes(GIT_ROOT_ADMISSION_PHRASE)) return reason.replace(GIT_ROOT_ADMISSION_PHRASE, GIT_ROOT_NOTHING_RAN);
  return `${reason.trimEnd().replace(/\.$/, "")}${GIT_ROOT_NOTHING_RAN}`;
}

/**
 * QA round 1 (N1): admission's reasons are router-authored sentences that echo raw values; quoting the whole sentence would wrap
 * it in `"…"` for one `[` in a path. Only the characters `displaySafe` treats as unsafe apart from `[` and `]` (control and format
 * characters, newlines and line separators included, unassigned, private-use and surrogate code points) are replaced, by `?`, so
 * the refusal stays one plain line.
 */
export function sanitiseReason(reason: string): string {
  return reason.replace(/[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\u2028\u2029]/gu, "?");
}

/** A value with no path separator and no drive is a name. */
function isName(value: string): boolean {
  return !/[\\/]/.test(value) && !/^[A-Za-z]:/.test(value);
}

/** Step 2: why `value` is refused on its text alone, or undefined. */
function textProblem(value: string, platform: NodeJS.Platform): string | undefined {
  if (value !== value.trim()) return GIT_ROOT_WHITESPACE;
  if (value.length > GIT_ROOT_MAX_LENGTH) return GIT_ROOT_TOO_LONG;
  if (isName(value)) return repoNameProblem(value) ?? (gitMetadataSegment(value) ? GIT_ROOT_GIT_SEGMENT : undefined);
  return rootTextProblem(value, platform) ?? (value.split(/[\\/]/).some(gitMetadataSegment) ? GIT_ROOT_GIT_SEGMENT : undefined);
}

/** Why step 9 stopped. */
export type GitRootStop = "timed out" | "aborted" | "failed";
type Stop = GitRootStop;

/** Step 9's refusal for `value` (shown as step 2 shows it). Also the caller's, for its own bounded calls (`index.ts`, QA F5). */
export function gitRootStopReason(value: string, stop: GitRootStop): string {
  const shown = value.length > GIT_ROOT_MAX_LENGTH ? `${displaySafe(value.slice(0, 80))}…` : displaySafe(value);
  return `root=${shown}: ${stop === "aborted" ? GIT_ROOT_ABORTED : stop === "timed out" ? GIT_ROOT_TIMED_OUT : GIT_ROOT_FAILED}`;
}

/**
 * Step 9: `work`, unless the deadline passes or the signal aborts first; a rejection (or a throw) fails closed as `failed`.
 * Exported for the caller's own asynchronous steps (`index.ts`: the orchestrator lookup, QA F5).
 */
export function gitRootBounded<T>(
  work: () => Promise<T>,
  limits: { readonly signal?: AbortSignal; readonly deadlineAt?: number },
): Promise<{ readonly value: T } | { readonly stop: GitRootStop }> {
  if (limits.signal?.aborted === true) return Promise.resolve({ stop: "aborted" });
  if (limits.deadlineAt !== undefined && Date.now() >= limits.deadlineAt) return Promise.resolve({ stop: "timed out" });
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: { readonly value: T } | { readonly stop: GitRootStop }): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      limits.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ stop: "aborted" });
    if (limits.deadlineAt !== undefined) timer = setTimeout(() => finish({ stop: "timed out" }), Math.max(0, limits.deadlineAt - Date.now()));
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    let started: Promise<T>;
    try {
      started = work();
    } catch (error) {
      started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    started.then((result) => finish({ value: result }), () => finish({ stop: "failed" }));
  });
}

export async function resolveGitRoot(value: string, ctx: GitRootContext, deps: GitRootDeps): Promise<GitRootResolution> {
  const platform = deps.platform;
  const win = platform === "win32";
  const sep = win ? "\\" : "/";
  const text = (path: string): string => normalizeRootText(path, platform);
  const show = (path: string): string => displaySafe(path);
  const refuse = (reason: string): GitRootResolution => ({ ok: false, reason });
  const sameName = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const native = (path: string): string => (win ? path.replace(/\//g, "\\") : path);
  /** The segments of a path's text, separators unified, empty and `.` segments dropped (as `normalizeRootText`, case kept). */
  const segments = (path: string): string[] => native(path.trim()).split(sep).filter((part) => part !== "" && part !== ".");
  /** Whether `child` lies strictly below `parent` (both normalised text). */
  const below = (child: string, parent: string): boolean =>
    child !== parent && child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  /** `child` relative to `parent` (native separators, `child`'s case), or undefined when it does not lie strictly below. */
  const relativeBelow = (child: string, parent: string): string | undefined =>
    below(text(child), text(parent)) ? segments(child).slice(segments(parent).length).join(sep) : undefined;

  // Step 2.
  const problem = textProblem(value, platform);
  if (problem !== undefined) {
    const shown = value.length > GIT_ROOT_MAX_LENGTH ? `${show(value.slice(0, 80))}…` : show(value);
    return refuse(`root=${shown} ${problem}${GIT_ROOT_TEXT_HINT}`);
  }
  const label = show(value);
  const stopped = (): Stop | undefined => {
    if (deps.signal?.aborted === true) return "aborted";
    if (deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt) return "timed out";
    return undefined;
  };
  const stopReason = (stop: Stop): GitRootResolution => refuse(gitRootStopReason(value, stop));
  /** Step 9: `work`, unless the deadline passes or the signal aborts first; a rejection fails closed. */
  const bounded = <T>(work: () => Promise<T>): Promise<{ readonly value: T } | { readonly stop: Stop }> =>
    gitRootBounded(work, {
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      ...(deps.deadlineAt === undefined ? {} : { deadlineAt: deps.deadlineAt }),
    });

  /** The configured parents whose text is a usable path. */
  const parents = ctx.parents.map((parent) => parent.trim()).filter((parent) => rootTextProblem(parent, platform) === undefined);
  /**
   * QA round 1 (F1): each parent's canonical form, when it differs from its text (a junction, symlink or subst drive). The parents
   * are trusted configuration: resolved once per call, on first need; a parent that does not resolve keeps its text form only.
   * The value itself is never resolved before the text gate.
   */
  let realParentsMemo: Array<{ readonly parent: string; readonly real: string }> | undefined;
  const realParents = (): ReadonlyArray<{ readonly parent: string; readonly real: string }> => {
    if (realParentsMemo !== undefined) return realParentsMemo;
    const resolved: Array<{ readonly parent: string; readonly real: string }> = [];
    for (const parent of parents) {
      try {
        const real = deps.realpath(parent);
        if (typeof real === "string" && real !== "" && text(real) !== text(parent)) resolved.push({ parent, real });
      } catch {
        // The parent does not resolve: its text form only.
      }
    }
    realParentsMemo = resolved;
    return resolved;
  };
  type Gate =
    | { readonly kind: "work-root" }
    | { readonly kind: "inside"; readonly rel: string }
    | { readonly kind: "outside" }
    /** `admitAs`: the form admission's rule 1 knows (below a parent as configured). */
    | { readonly kind: "member"; readonly admitAs: string };
  /** Step 3: text only for `path`; at most the parents are resolved (F1). */
  const textGate = (path: string): Gate => {
    const pathText = text(path);
    if (pathText === text(ctx.workRoot)) return { kind: "work-root" };
    const insideW = relativeBelow(path, ctx.workRoot);
    if (insideW !== undefined) return { kind: "inside", rel: insideW };
    if (parents.some((parent) => below(pathText, text(parent)))) return { kind: "member", admitAs: path };
    if (ctx.workingSet.some((worktree) => text(worktree) === pathText)) return { kind: "member", admitAs: path };
    for (const { parent, real } of realParents()) {
      const rel = relativeBelow(path, real);
      if (rel !== undefined) return { kind: "member", admitAs: `${native(parent).replace(/[\\/]+$/, "")}${sep}${rel}` };
    }
    return { kind: "outside" };
  };
  /**
   * QA round 1 (F4): the name lookup's `eligible`, asked before admission runs anything on a candidate: the text gate, then R on
   * the canonical path (filesystem only, as step 5). The work root and paths inside it stay eligible (steps 3–4 answer them).
   */
  const eligible = (candidate: string): boolean => {
    const gate = textGate(candidate);
    if (gate.kind === "outside") return false;
    if (gate.kind !== "member") return true;
    const real = deps.realpath(candidate);
    if (typeof real !== "string" || real === "") return false;
    if (text(real) === text(ctx.workRoot) || relativeBelow(real, ctx.workRoot) !== undefined) return true;
    return deps.inReadSet(real) === true;
  };
  /** QA round 1 (F6): absolute paths in a router-authored sentence (win32: drive or UNC; posix: rooted), after a boundary. */
  const ABSOLUTE = win ? /(?<![^\s(=,;"'])(?:[A-Za-z]:[\\/]|\\\\)[^\s,;()"'<>|]*/g : /(?<![^\s(=,;"'])\/[^\s,;()"'<>|]*/g;
  /** A following space-separated chunk that holds a separator continues a path with spaces. */
  const CONTINUED = /^ +[^\s,;()"'<>|]*[\\/][^\s,;()"'<>|]*/;
  /** F6: `body` with every absolute path that is not in `safe`, not W or inside it, and not in R replaced by the placeholder. */
  const redactOutside = (body: string, safe: readonly string[]): string => {
    const safeTexts = new Set([...safe, ...parents, ...realParents().map((entry) => entry.real), ...ctx.workingSet, ...deps.known].map(text));
    const keep = (path: string): boolean => {
      if (safeTexts.has(text(path))) return true;
      if (text(path) === text(ctx.workRoot) || relativeBelow(path, ctx.workRoot) !== undefined) return true;
      try {
        return deps.inReadSet(path) === true;
      } catch {
        return false;
      }
    };
    const pattern = new RegExp(ABSOLUTE.source, "g");
    let out = "";
    let last = 0;
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
      let end = match.index + match[0].length;
      for (let more = CONTINUED.exec(body.slice(end)); more !== null; more = CONTINUED.exec(body.slice(end))) end += more[0].length;
      const token = body.slice(match.index, end).replace(/[.:]+$/, "");
      end = match.index + token.length;
      pattern.lastIndex = Math.max(end, match.index + 1);
      if (token === "" || keep(token)) continue;
      out += `${body.slice(last, match.index)}${GIT_ROOT_OUTSIDE_PLACEHOLDER}`;
      last = end;
    }
    return `${out}${body.slice(last)}`;
  };
  /**
   * Step 7's refusal (SD-3b-9, QA round 1 N1/F6): the admission reason mapped, control characters replaced, its leading
   * `root=<the form admitted>` shown as the value passed (display-safe), every other absolute path outside R redacted.
   */
  const admissionRefusal = (reason: string, path: string, admitAs: string, real: string): string => {
    const mapped = sanitiseReason(mapAdmissionReason(reason));
    for (const form of admitAs === path ? [path] : [admitAs, path]) {
      const prefix = `root=${form}`;
      const next = mapped.charAt(prefix.length);
      if (mapped.startsWith(prefix) && (next === "" || /[\s:;,.]/.test(next))) {
        return `root=${show(path)}${redactOutside(mapped.slice(prefix.length), [path, admitAs, real])}`;
      }
    }
    return redactOutside(mapped, [path, admitAs, real]);
  };

  /** Steps 3–7 for an absolute path; `extraKnown` joins `deps.known` for admission. */
  const throughPath = async (path: string, extraKnown: readonly string[]): Promise<GitRootResolution> => {
    const shown = show(path);
    // Step 3: text only for the value (the parents may be resolved, F1).
    const gate = textGate(path);
    if (gate.kind === "work-root") return IN_WORK_ROOT;
    if (gate.kind === "inside") return refuse(`root=${shown} ${GIT_ROOT_INSIDE_WORK_ROOT} ${show(ctx.workRoot)}; ${GIT_ROOT_OMIT_ROOT}${show(gate.rel)}`);
    if (gate.kind === "outside") {
      const list = parents.length === 0 ? "routing.repoParents (none configured)" : parents.map(show).join(", ");
      return refuse(`root=${shown} ${GIT_ROOT_OUTSIDE_READ_SET} ${list}); nothing ran`);
    }
    const admitAs = gate.admitAs;

    // Step 4: the filesystem, from here on.
    const early = stopped();
    if (early !== undefined) return stopReason(early);
    let real: string;
    try {
      real = deps.realpath(path);
    } catch {
      return refuse(`root=${shown} ${GIT_ROOT_NOT_DIRECTORY}`);
    }
    let directory = false;
    try {
      directory = typeof real === "string" && real !== "" && deps.isDirectory(real);
    } catch {
      directory = false;
    }
    if (!directory) return refuse(`root=${shown} ${GIT_ROOT_NOT_DIRECTORY}`);
    const realText = text(real);
    const workForms = [ctx.workRoot];
    if (realText !== text(ctx.workRoot) && relativeBelow(real, ctx.workRoot) === undefined) {
      try {
        const workReal = deps.realpath(ctx.workRoot);
        if (typeof workReal === "string" && workReal !== "") workForms.push(workReal);
      } catch {
        // W does not resolve: its text form is the only one.
      }
    }
    for (const form of workForms) {
      if (realText === text(form)) return IN_WORK_ROOT;
      const inside = relativeBelow(real, form);
      if (inside !== undefined) return refuse(`root=${shown} ${GIT_ROOT_INSIDE_WORK_ROOT} ${show(ctx.workRoot)}; ${GIT_ROOT_OMIT_ROOT}${show(inside)}`);
    }

    // Step 5: R, filesystem only.
    let member = false;
    try {
      member = deps.inReadSet(real);
    } catch {
      member = false;
    }
    if (!member) return refuse(`root=${shown} resolves to ${show(real)}, ${GIT_ROOT_RESOLVES_OUTSIDE}`);

    // Step 6: the top level of its checkout.
    let top: string | undefined;
    try {
      top = deps.nearestCheckout(real);
    } catch {
      top = undefined;
    }
    if (top !== undefined && text(top) !== realText) {
      const rel = relativeBelow(real, top);
      if (rel !== undefined) return refuse(`root=${shown} ${GIT_ROOT_INSIDE_REPOSITORY} ${show(top)}; pass root=${show(top)} and path=${show(rel)}`);
    }

    // Step 7: admission (git), then the admitted worktree must be this directory.
    const known = [...deps.known];
    for (const repository of extraKnown) if (!known.some((entry) => text(entry) === text(repository))) known.push(repository);
    const answer = await bounded<Admission>(() => deps.admission.admit(admitAs, known));
    if ("stop" in answer) return stopReason(answer.stop);
    const admitted = answer.value;
    if (!admitted.ok) return refuse(admissionRefusal(admitted.reason, path, admitAs, real));
    const location = admitted.location;
    if (text(location.worktree) !== realText) {
      return refuse(`root=${shown}: ${GIT_ROOT_ADMITTED_WORKTREE} ${show(location.worktree)} resolves to ${show(real)}; nothing ran`);
    }
    return {
      ok: true,
      inWorkRoot: false,
      root: location.worktree,
      repository: location.repository,
      name: location.name,
      branch: location.branch,
      workRoot: ctx.workRoot,
      provenance: gitRootProvenance(location),
    };
  };

  if (!isName(value)) return throughPath(value, []);

  // Step 8: a name, through the `repo=` lookup.
  const answer = await bounded(() => deps.admission.find(value, { eligible }));
  if ("stop" in answer) return stopReason(answer.stop);
  const { found, searched, capped } = answer.value;
  if (found.length === 0) {
    const where = searched.length === 0 ? "nothing: none configured" : searched.map(show).join(", ");
    // QA round 1 (N2): the route line's cap note. A single match in a capped lookup is kept below, as `repo=` keeps it.
    const stoppedNote = capped === true ? `. ${gitRootCappedNote(LOOKUP_MAX_DIRS)}` : "";
    return refuse(`root=${label} ${GIT_ROOT_NO_MATCH} (searched ${where}); nothing ran${stoppedNote}`);
  }
  if (found.length > 1) {
    return refuse(`root=${label} matches ${String(found.length)} repositories: ${found.map((location) => show(location.worktree)).join(", ")}; ${GIT_ROOT_PASS_ONE}`);
  }
  const [location] = found;
  if (location === undefined) return refuse(`root=${label} ${GIT_ROOT_NO_MATCH}; nothing ran`);
  let target = location.worktree;
  // A repository named `value` (not the directory of one of its linked worktrees): its only usable worktree, or a refusal.
  if (sameName(location.name, value)) {
    const usable = location.worktrees.filter((entry) => !entry.bare && !entry.prunable);
    const describe = (entry: WorktreeEntry): string =>
      entry.branch !== null ? show(entry.branch) : entry.head === null ? "detached" : `detached at ${show(entry.head.slice(0, 7))}`;
    if (usable.length > 1) {
      const listing = usable.map((entry) => `${show(native(entry.path))} → ${describe(entry)}`).join("; ");
      return refuse(`root=${label} has ${String(usable.length)} worktrees: ${listing}; ${GIT_ROOT_PASS_ONE}`);
    }
    const [only] = usable;
    if (only !== undefined && text(only.path) !== text(location.worktree)) target = native(only.path);
  }
  return throughPath(target, [location.repository]);
}
