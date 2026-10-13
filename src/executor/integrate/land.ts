// 3.2.5: landing and phase tags. `createLander` returns a structural `Lander` (queue.ts): this module imports types only
// from checks.ts and queue.ts and receives the instances by injection. Everything here is bounded to the owner checkout
// (`repo.toplevel`): every probe runs with `-C <toplevel>`, never against another worktree of the same repository.
// Never forces and never creates a non-fast-forward.

import { hardeningArgs } from "../../router/git-tools";
import { phaseTagName as gitPhaseTagName } from "../git";
import type { GitOps } from "../git";
import type { GitRunner, PhaseId, PlanId } from "../types";
import type { IntegrateGit, WriteGuard } from "./checks";
import type { LandInspection, LandOutcome, LandRefusal, LandRequest, TagOutcome } from "./queue";

const READ_TIMEOUT_MS = 60_000;

/** `omr/<planId>/phase/<encoded phaseId>` (3.2.5.a): the encoded, case-fold-safe name of git.ts. */
export function phaseTagName(planId: PlanId, phaseId: PhaseId): string {
  return gitPhaseTagName(planId, phaseId);
}

export interface LanderDeps {
  git: GitOps; igit: IntegrateGit; guard: WriteGuard;
  /** Hardened runner for the read-only owner-checkout probes (toplevel, HEAD, status); each call uses `-C <toplevel>`. */
  run: GitRunner;
  realpath: (p: string) => Promise<string>; platform: NodeJS.Platform;
}

export interface LanderApi {
  tagName(planId: PlanId, phaseId: PhaseId): string;
  tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome>;
  inspect(req: LandRequest): Promise<LandInspection>;
  fastForward(req: LandRequest): Promise<LandOutcome>;
  commands(req: LandRequest, refusal: LandRefusal): string[];
}

/** Path equality for the toplevel re-validation: separators folded, trailing separators dropped, case-folded on win32. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/\\/g, "/");
    const trimmed = s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, "") : s;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Paths of `status --porcelain=v1 -z`; a rename or copy entry carries its origin as the next NUL field. */
function parseStatusPaths(stdout: string): string[] {
  const fields = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    paths.push(field.slice(3));
    if (/[RC]/.test(xy)) i += 1;
  }
  return paths;
}

export function createLander(d: LanderDeps): LanderApi {
  async function probe(toplevel: string, args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
    // hardeningArgs() neutralises configured hooks/fsmonitor/pagers: `status` must not run a repo-configured program.
    const r = await d.run.run(["-C", toplevel, "--no-optional-locks", ...hardeningArgs(), ...args], { cwd: toplevel, timeoutMs: READ_TIMEOUT_MS });
    return { code: r.code, stdout: r.stdout };
  }

  async function inspect(req: LandRequest): Promise<LandInspection> {
    const { toplevel, baseBranch, candidate } = req;

    // 1. The directory is still the owner checkout recorded at compile time.
    const top = await probe(toplevel, ["rev-parse", "--show-toplevel"]);
    const reported = top.code === 0 ? top.stdout.trim() : "";
    let actual = reported;
    if (reported !== "") {
      try { actual = await d.realpath(reported); } catch { actual = reported; }
    }
    let expected = toplevel;
    try { expected = await d.realpath(toplevel); } catch { expected = toplevel; }
    if (reported === "" || !samePath(actual, expected, d.platform)) {
      return { ok: false, refusal: { reason: "toplevel-mismatch", actual }, baseTip: null };
    }

    const baseTip = await d.igit.readRef(toplevel, `refs/heads/${baseBranch}`);
    if (baseTip === null) return { ok: false, refusal: { reason: "base-missing" }, baseTip: null };

    // 2. The base branch is checked out in the owner checkout.
    const head = await probe(toplevel, ["symbolic-ref", "-q", "HEAD"]);
    const headRef = head.code === 0 ? head.stdout.trim() : null;
    if (headRef !== `refs/heads/${baseBranch}`) {
      return { ok: false, refusal: { reason: "not-checked-out", head: headRef === "" ? null : headRef }, baseTip };
    }

    // 3. The owner checkout is clean.
    const status = await probe(toplevel, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    if (status.code !== 0) throw new Error(`git status failed in the owner checkout (exit ${status.code ?? "unknown"})`);
    const dirty = parseStatusPaths(status.stdout);
    if (dirty.length > 0) return { ok: false, refusal: { reason: "dirty", paths: dirty }, baseTip };

    // 4. The base head is an ancestor of the integration head.
    if (baseTip === candidate) return { ok: true, baseTip, noop: true };
    if (!(await d.igit.isAncestor(toplevel, baseTip, candidate))) {
      // The owner moved on after landing: the base already contains the candidate, nothing to do.
      if (await d.igit.isAncestor(toplevel, candidate, baseTip)) return { ok: true, baseTip, noop: true };
      return { ok: false, refusal: { reason: "diverged", baseTip }, baseTip };
    }

    // 5. No ignored file sits where the fast-forward adds or changes a path (git overwrites ignored files silently).
    const changed = (await d.igit.diffNameStatus(toplevel, baseTip, candidate)).filter(e => e.status !== "D").map(e => e.path);
    if (changed.length > 0) {
      const ignored = await d.igit.ignoredAt(toplevel, changed);
      if (ignored.length > 0) return { ok: false, refusal: { reason: "ignored-overwrite", paths: ignored }, baseTip };
    }
    return { ok: true, baseTip, noop: false };
  }

  async function fastForward(req: LandRequest): Promise<LandOutcome> {
    try {
      await d.guard.assertWriteCwd(req.toplevel, "land");
      const i = await inspect(req);
      if (!i.ok) return { kind: "refused", refusal: i.refusal };
      if (i.noop) return { kind: "landed", from: i.baseTip, to: req.candidate };
      const merged = await d.git.mergeFfOnly(req.toplevel, req.candidate);
      if (!merged.ok) return { kind: "refused", refusal: { reason: "diverged", baseTip: merged.head } };
      if (merged.head !== req.candidate) {
        return { kind: "error", message: `fast-forward left HEAD at ${merged.head}, expected ${req.candidate}` };
      }
      return { kind: "landed", from: i.baseTip, to: merged.head };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  }

  async function tag(req: { cwd: string; name: string; commit: string }): Promise<TagOutcome> {
    try {
      // createRef asserts the "tag" write cwd itself; the create is compare-and-swap against the zero id.
      return await d.igit.createRef(req.cwd, `refs/tags/${req.name}`, req.commit);
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  }

  function commands(req: LandRequest, refusal: LandRefusal): string[] {
    const t = `git -C "${req.toplevel}"`;
    const merge = `${t} merge --ff-only ${req.candidate}`;
    switch (refusal.reason) {
      case "dirty":
        return [`${t} status --porcelain=v1 --untracked-files=all`, "# commit or stash the changes above, then:", merge];
      case "not-checked-out":
        return [`${t} switch ${req.baseBranch}`, merge];
      case "diverged":
        return [
          `${t} log --oneline ${req.candidate}..${req.baseBranch}`,
          "# the owner chooses; the executor never runs this:",
          `${t} merge refs/heads/${req.integrationBranch}`,
        ];
      case "ignored-overwrite":
        return [...refusal.paths.map(p => `# ignored file would be overwritten: ${p}`), "# move them, then:", merge];
      case "toplevel-mismatch":
      case "base-missing":
        return [];
    }
  }

  return {
    tagName: phaseTagName,
    tag,
    inspect,
    fastForward,
    commands,
  };
}
