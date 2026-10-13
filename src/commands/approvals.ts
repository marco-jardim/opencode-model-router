/**
 * Cross-repo Phase 4 (P4.7): `/router approve <path>`, `/router repos` and `/router revoke <path>`
 * (`docs/design/cross-repo-phase4-plan.md`, SD-P4-10..13, S1/S2).
 *
 * Only these commands write the approvals store (S1). What the human sees and what gets stored come from git at approve time
 * (`inspectCandidate`), never from the dispatch text or the refusal note (S2). `repos` reads the store only (no git). Every
 * repository-derived string passes through `displaySafe`. Whether the commands are available at all (v2 host, roles mode,
 * `routing.repoParents` non-empty, a top-level human session: SD-P4-10) is decided by the `/router` handler, not here.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  applyApproval,
  expiresAt,
  inspectCandidate,
  isApprovalValid,
  readApprovals,
  type ApprovalsEnv,
  type IdentityDeps,
  type InspectDeps,
  type RepoApproval,
} from "../routing/roles/approvals";
import { displaySafe } from "../routing/roles/read-set";
import { REPO_APPROVAL_CAP_DAYS } from "../router/roles-config";
import { dropFromWorkingSets } from "../routing/wire/working-set";

/** The `/router` subcommands of this module, in help order. */
export const ROUTER_APPROVAL_SUBCOMMANDS = ["approve", "repos", "revoke"] as const;
export type RouterApprovalSubcommand = (typeof ROUTER_APPROVAL_SUBCOMMANDS)[number];

/** Whether `sub` (lower-cased first word of the `/router` arguments) is one of {@link ROUTER_APPROVAL_SUBCOMMANDS}. */
export function isRouterApprovalSubcommand(sub: string): sub is RouterApprovalSubcommand {
  return (ROUTER_APPROVAL_SUBCOMMANDS as readonly string[]).includes(sub);
}

/** What an `approve` or `revoke` changed in the store; carried by the command output for the v2 adapter (SD-P4-11). */
export interface ApprovalsChange {
  readonly kind: "approve" | "revoke";
  /** The canonical path of the approved or revoked repository. */
  readonly path: string;
}

/**
 * Non-enumerable key on the `/router` command output (its `parts` array) after an `approve` or `revoke` that wrote the store
 * (SD-P4-11). The v2 command adapter then reloads the role agents before it sends the text on.
 */
export const APPROVALS_CHANGED: unique symbol = Symbol.for("opencode-model-router.approvals-changed");

/** Mark `target` (the command output's `parts`) with `change`, non-enumerable, so serialisation and copies never carry it. */
export function markApprovalsChanged(target: object, change: ApprovalsChange): void {
  Object.defineProperty(target, APPROVALS_CHANGED, { value: Object.freeze({ ...change }), enumerable: false, configurable: true, writable: false });
}

/** The change marked on `target` by {@link markApprovalsChanged}, or undefined. */
export function approvalsChangedOf(target: unknown): ApprovalsChange | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const value: unknown = Reflect.get(target, APPROVALS_CHANGED);
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  const where: unknown = Reflect.get(value, "path");
  if ((kind !== "approve" && kind !== "revoke") || typeof where !== "string") return undefined;
  return { kind, path: where };
}

/**
 * The line the v2 command adapter appends after it reloaded the role agents for `change` (SD-P4-11). `applies` is
 * `APPROVAL_RELOAD_APPLIES` (spike T6: a reload makes the host allow the approved directory); `reloadError` is set when the
 * reload failed, which gives the restart line too.
 */
export function approvalReloadLine(change: ApprovalsChange, applies: boolean, reloadError?: string): string {
  const repo = displaySafe(change.path);
  const failed = reloadError === undefined ? "" : `The role agents could not be reloaded (${displaySafe(reloadError)}). `;
  if (change.kind === "approve") {
    return reloadError === undefined && applies
      ? `Role agents reloaded; dispatch again with root=${repo}.`
      : `${failed}Restart OpenCode to use it.`;
  }
  return reloadError === undefined && applies
    ? `Role agents reloaded; root=${repo} is no longer allowed.`
    : `${failed}The router refuses root=${repo} now; restart OpenCode to remove its directory permission from the role agents.`;
}

/** Configuration and injectable I/O of {@link runRouterApprovals}. */
export interface RouterApprovalsOptions {
  /** `routing.repoParents` (resolved). */
  readonly parents: readonly string[];
  /** `routing.repoExclude` (resolved). */
  readonly exclude: readonly string[];
  /** `routing.repoApprovalDays` (resolved). */
  readonly days: number;
  /** Store environment (tests: the store directory and the clock). */
  readonly env?: ApprovalsEnv;
  /** Git and filesystem of the candidate inspection (tests). */
  readonly identity?: IdentityDeps;
  /** Default `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export interface RouterApprovalsResult {
  readonly text: string;
  /** Set when the store was written (approve, revoke). */
  readonly change?: ApprovalsChange;
}

const DAY_MS = 86_400_000;

/**
 * The path argument: the rest of the `/router` arguments, trimmed, with one pair of surrounding double or single quotes
 * removed (so a path with spaces can be quoted, or typed as is). Undefined when empty.
 */
export function parseApprovalPath(rest: string): string | undefined {
  let text = rest.trim();
  const q = text[0];
  if (text.length >= 2 && (q === "\"" || q === "'") && text.endsWith(q)) text = text.slice(1, -1).trim();
  return text === "" ? undefined : text;
}

function keyOf(p: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Normalized comparison form: resolved, no trailing separator except at a root, case-folded on win32. */
function cmpForm(p: string, platform: NodeJS.Platform): string {
  let r = path.resolve(p);
  const root = path.parse(r).root;
  while (r.length > root.length && (r.endsWith(path.sep) || r.endsWith("/"))) r = r.slice(0, -1);
  return keyOf(r, platform);
}

function realOrUndefined(p: string, realpath: (p: string) => string): string | undefined {
  try {
    const real = realpath(p);
    return typeof real === "string" && real !== "" ? real : undefined;
  } catch {
    return undefined;
  }
}

function realpathOf(opts: RouterApprovalsOptions): (p: string) => string {
  return opts.identity?.realpath ?? ((p: string) => fs.realpathSync.native(p));
}

/** The `routing.repoParents` entry that `canonical` is inside (text and canonical form of the parent), or undefined. No git. */
function parentHolding(canonical: string, opts: RouterApprovalsOptions, platform: NodeJS.Platform): string | undefined {
  const candidate = cmpForm(canonical, platform);
  const realpath = realpathOf(opts);
  for (const parent of opts.parents) {
    if (parent.trim() === "" || !path.isAbsolute(parent)) continue;
    const forms = new Set([cmpForm(parent, platform)]);
    const real = realOrUndefined(parent, realpath);
    if (real !== undefined) forms.add(cmpForm(real, platform));
    for (const form of forms) {
      const prefix = form.endsWith(path.sep) || form.endsWith("/") ? form : `${form}${path.sep}`;
      if (candidate !== form && candidate.startsWith(prefix)) return parent;
    }
  }
  return undefined;
}

/** A time for the human: `YYYY-MM-DD HH:MM UTC`. */
function when(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A date for the human: `YYYY-MM-DD` (UTC). */
function day(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
}

function usage(sub: "approve" | "revoke"): string {
  return `Usage: /router ${sub} <path>  (quote a path with spaces: /router ${sub} "D:\\my repo")`;
}

async function approve(rest: string, opts: RouterApprovalsOptions, platform: NodeJS.Platform): Promise<RouterApprovalsResult> {
  const typed = parseApprovalPath(rest);
  if (typed === undefined) return { text: usage("approve") };
  const shown = displaySafe(typed);
  const deps: InspectDeps = {
    ...(opts.identity ?? {}),
    exclude: opts.exclude,
    platform,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  };
  const found = await inspectCandidate(typed, deps);
  if (typeof found === "string") return { text: `Not approved: ${shown} ${displaySafe(found)}.\nNothing was stored.` };

  const repo = displaySafe(found.path);
  const parent = parentHolding(found.path, opts, platform);
  if (parent !== undefined) {
    return {
      text: `No approval needed: ${repo} is inside routing.repoParents (${displaySafe(parent)}); dispatch with root=${repo}.\nNothing was stored.`,
    };
  }

  const outcome = await applyApproval(
    { kind: "put", approval: { path: found.path, commonDir: found.commonDir, roots: found.roots, origin: found.origin }, days: opts.days },
    opts.env,
  );
  if (outcome.status !== "written" || outcome.entry === undefined) {
    const why = outcome.status === "refused"
      ? outcome.message
      : `the store was not changed (${outcome.status === "unchanged" ? outcome.reason : "no entry read back"})`;
    return { text: `Not approved: ${repo}: ${displaySafe(why)}.` };
  }
  const entry = outcome.entry;
  const roots = entry.roots.length;
  const cap = entry.approvedAt + REPO_APPROVAL_CAP_DAYS * DAY_MS;
  const lines = [
    `Approved repository ${displaySafe(entry.path)}`,
    `  origin:  ${displaySafe(entry.origin)}`,
    `  branch:  ${displaySafe(found.branch)} @ ${displaySafe(found.head.slice(0, 12))}`,
    `  roots:   ${String(roots)} root commit${roots === 1 ? "" : "s"}`,
    `  expires: ${day(expiresAt(entry, opts.days))} (${String(opts.days)} days after its last use; at the latest ${day(cap)})`,
    `Stored in ${displaySafe(outcome.file)}.`,
  ];
  return { text: lines.join("\n"), change: { kind: "approve", path: entry.path } };
}

/** The `routing.repoExclude` pattern matching the stored path text (as on registration: text only, no filesystem), or undefined. */
function excludedByText(p: string, exclude: readonly string[], platform: NodeJS.Platform, matches: (input: string, pattern: string) => boolean): string | undefined {
  const win = platform === "win32";
  const forms = win && p.includes("/") ? [p, p.replace(/\//g, "\\")] : [p];
  for (const form of forms) {
    const input = win ? form.toLowerCase() : form;
    const hit = exclude.find((pattern) => pattern.trim() !== "" && matches(input, win ? pattern.toLowerCase() : pattern));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function repos(opts: RouterApprovalsOptions, platform: NodeJS.Platform): Promise<RouterApprovalsResult> {
  const read = readApprovals(opts.env);
  const file = displaySafe(read.file);
  if (read.invalid !== undefined) {
    return { text: `The approvals file ${file} is invalid (${displaySafe(read.invalid)}); no approvals apply until it is fixed or removed.` };
  }
  const { permissionMatches } = await import("../router/read-only");
  const now = (opts.env?.now ?? Date.now)();
  const lines: string[] = [];
  if (read.approvals.length === 0) lines.push(`No approved repositories (${file}).`);
  else lines.push(`Approved repositories (${file}):`);
  for (const entry of read.approvals) {
    const marks: string[] = [];
    if (!isApprovalValid(entry, opts.days, now)) marks.push("expired");
    const excluded = excludedByText(entry.path, opts.exclude, platform, permissionMatches);
    if (excluded !== undefined) marks.push(`excluded by routing.repoExclude (${displaySafe(excluded)})`);
    lines.push(`- ${displaySafe(entry.path)}${marks.length === 0 ? "" : `  [${marks.join("; ")}]`}`);
    lines.push(`    origin: ${displaySafe(entry.origin)}`);
    lines.push(`    approved: ${when(entry.approvedAt)}; last used: ${when(entry.lastUsedAt)}; expires: ${when(expiresAt(entry, opts.days))}`);
  }
  if (read.dropped.length > 0) lines.push(`${String(read.dropped.length)} invalid entr${read.dropped.length === 1 ? "y was" : "ies were"} ignored.`);
  return { text: lines.join("\n") };
}

/** The stored approval that `typed` names: by text first (comparison form), then by its realpath. No git. */
function approvalNamed(approvals: readonly RepoApproval[], typed: string, opts: RouterApprovalsOptions, platform: NodeJS.Platform): RepoApproval | undefined {
  if (!path.isAbsolute(typed)) return undefined;
  const byText = cmpForm(typed, platform);
  const hit = approvals.find((a) => cmpForm(a.path, platform) === byText);
  if (hit !== undefined) return hit;
  const real = realOrUndefined(typed, realpathOf(opts));
  if (real === undefined) return undefined;
  const byReal = cmpForm(real, platform);
  return approvals.find((a) => cmpForm(a.path, platform) === byReal);
}

async function revoke(rest: string, opts: RouterApprovalsOptions, platform: NodeJS.Platform): Promise<RouterApprovalsResult> {
  const typed = parseApprovalPath(rest);
  if (typed === undefined) return { text: usage("revoke") };
  const shown = displaySafe(typed);
  const read = readApprovals(opts.env);
  if (read.invalid !== undefined) {
    return { text: `Not revoked: the approvals file ${displaySafe(read.file)} is invalid (${displaySafe(read.invalid)}); fix or remove it first.` };
  }
  const entry = approvalNamed(read.approvals, typed, opts, platform);
  if (entry === undefined) return { text: `No approval for ${shown}; nothing was changed. /router repos lists the approved repositories.` };
  const outcome = await applyApproval({ kind: "delete", path: entry.path }, opts.env);
  if (outcome.status === "refused") return { text: `Not revoked: ${displaySafe(outcome.message)}.` };
  if (outcome.status === "unchanged") return { text: `No approval for ${shown}; nothing was changed. /router repos lists the approved repositories.` };
  const removed = dropFromWorkingSets(entry.path, platform);
  const repo = displaySafe(entry.path);
  const lines = [
    `Revoked the approval of ${repo}.`,
    removed === 0 ? "It was not in any working set." : `Removed from the working sets (${String(removed)} binding${removed === 1 ? "" : "s"}).`,
    `A new dispatch with root=${repo} is refused.`,
  ];
  return { text: lines.join("\n"), change: { kind: "revoke", path: entry.path } };
}

/**
 * Run `/router approve <path>`, `/router repos` or `/router revoke <path>`; `rest` is the argument text after the subcommand.
 * Never throws: an unexpected error is reported and nothing is stored.
 */
export async function runRouterApprovals(sub: RouterApprovalSubcommand, rest: string, opts: RouterApprovalsOptions): Promise<RouterApprovalsResult> {
  const platform = opts.platform ?? process.platform;
  try {
    if (sub === "approve") return await approve(rest, opts, platform);
    if (sub === "revoke") return await revoke(rest, opts, platform);
    return await repos(opts, platform);
  } catch (e) {
    return { text: `/router ${sub} failed: ${displaySafe(e instanceof Error ? e.message : String(e))}` };
  }
}
