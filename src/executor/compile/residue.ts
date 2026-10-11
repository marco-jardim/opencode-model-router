// src/executor/compile/residue.ts
// Phase 2.3.5 — the architect residue: request, response validation and monotone merge (memo 2.3.1 §6).
// Pure: no I/O, no git, no clock. Paths are checked lexically against the ledger's roots.
// `index.mergeResidue` (2.3.6) recomputes `conflict` edges, runs `validate` and sets the status afterwards.

import { createHash } from "node:crypto";

import { parseRouteLine } from "../../routing/classify/route-line";
import type { Edge, JsonValue, LedgerV1, TaskId, TaskNode } from "../types";

/** Caps of one request (memo §6): anything over stays ⊤ (the caller warns `residue-capped`). */
export const RESIDUE_MAX_TASKS = 60;
export const RESIDUE_MAX_CANDIDATES = 120;
/** Per-task excerpt of the plan text sent to the architect. */
export const RESIDUE_EXCERPT_CHARS = 1500;
/** Maximum length of an `evidence` string in the response. */
export const RESIDUE_EVIDENCE_MAX = 300;

/** A candidate edge the compiler could not decide (unresolved phrase/graph ref, `merged first`, ownership, ...). */
export interface ResidueCandidate { from: string; to: string; why: string }

export interface ResidueFootprintEntry { taskId: TaskId; writes: string[]; reads: string[]; evidence: string }
export interface ResidueEdgeEntry { from: string; to: string; confidence: "medium" | "low"; evidence: string }
/** A validated response; paths are normalized repo-relative, `noChange` is always present. */
export interface ResidueResponse {
  requestDigest: string;
  footprints: ResidueFootprintEntry[];
  edges: ResidueEdgeEntry[];
  noChange: string[];
}

export type ResidueValidation =
  | { ok: true; value: ResidueResponse }
  | { ok: false; code: string; at: string; detail: JsonValue };

/** JSON Schema of the response (`additionalProperties: false` at every level). */
export const RESIDUE_SCHEMA: JsonValue = {
  type: "object",
  required: ["requestDigest", "footprints", "edges"],
  additionalProperties: false,
  properties: {
    requestDigest: { type: "string", pattern: "^[0-9a-f]{16}$" },
    footprints: {
      type: "array",
      items: {
        type: "object",
        required: ["taskId", "writes", "reads", "evidence"],
        additionalProperties: false,
        properties: {
          taskId: { type: "string" },
          writes: { type: "array", items: { type: "string", minLength: 1 } },
          reads: { type: "array", items: { type: "string", minLength: 1 } },
          evidence: { type: "string", minLength: 1, maxLength: RESIDUE_EVIDENCE_MAX },
        },
      },
    },
    edges: {
      type: "array",
      items: {
        type: "object",
        required: ["from", "to", "confidence", "evidence"],
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          confidence: { enum: ["medium", "low"] },
          evidence: { type: "string", minLength: 1, maxLength: RESIDUE_EVIDENCE_MAX },
        },
      },
    },
    noChange: { type: "array", items: { type: "string" } },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Task set and digest
// ---------------------------------------------------------------------------------------------------------------

/** Classes that read or think but do not edit (memo §4 "Editing"); `needs` decides first. */
const NON_EDITING_CLASSES: ReadonlySet<string> = new Set(["review", "design", "search", "recon"]);
const NON_EDITING_KINDS: ReadonlySet<string> = new Set(["manual", "preflight", "qa"]);

function has(o: object, key: string): boolean {
  return Object.hasOwn(o, key);
}

/** Editing task (memo §4): not manual/preflight/qa; any write, or `needs` has `edit`, or no `needs` and an editing class. */
function isEditing(t: TaskNode): boolean {
  if (NON_EDITING_KINDS.has(t.kind)) return false;
  if (t.footprint.writes.length > 0) return true;
  const fields = t.route.line === "" ? null : parseRouteLine(t.route.line, { positions: "any" }).line;
  if (fields?.needs !== undefined) return fields.needs.includes("edit");
  if (fields?.class === undefined) return true; // no information: an editing task writes ⊤, fail closed
  return !NON_EDITING_CLASSES.has(fields.class);
}

function residueTaskIdsUncapped(draft: LedgerV1): TaskId[] {
  const out: TaskId[] = [];
  for (const [id, t] of Object.entries(draft.tasks)) {
    if (!isEditing(t)) continue;
    const c = t.footprint.confidence;
    if (c === "unknown" || c === "inferred") out.push(id);
  }
  return out;
}

/**
 * Tasks the architect is asked about: editing tasks whose footprint is `unknown` or `inferred`, in plan order,
 * capped at `RESIDUE_MAX_TASKS`. Pure from the draft, so the digest is recomputable at validation time.
 * (Suffix/basename-mapped writes are not recorded in the ledger; they are `inferred` and so already included.)
 */
export function residueTaskIds(draft: LedgerV1): TaskId[] {
  return residueTaskIdsUncapped(draft).slice(0, RESIDUE_MAX_TASKS);
}

/** How many tasks are over the cap (they stay ⊤); the caller emits warning `residue-capped` when > 0. */
export function residueOverflow(draft: LedgerV1): number {
  return Math.max(0, residueTaskIdsUncapped(draft).length - RESIDUE_MAX_TASKS);
}

/** First 16 hex of `sha256(planDigest + "\n" + taskIds.join(","))`. */
export function residueDigestOf(planDigest: string, taskIds: readonly TaskId[]): string {
  return createHash("sha256").update(`${planDigest}\n${taskIds.join(",")}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------------------------

/** A role work root the route-line parser accepts (route-line.ts `isWorkRootPath`) and that can be written in `root=`. */
function routeRoot(toplevel: string): string | null {
  if (!/^(?:[A-Za-z]:[\\/]|\/(?![\\/]))/.test(toplevel)) return null;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(toplevel) || toplevel.includes("\0")) return null;
  if (/["\]\r\n]/.test(toplevel)) return null;
  return /\s/.test(toplevel) ? `root="${toplevel}"` : `root=${toplevel}`;
}

function cutExcerpt(text: string): string {
  if (text.length <= RESIDUE_EXCERPT_CHARS) return text;
  let end = RESIDUE_EXCERPT_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // do not split a surrogate pair
  return text.slice(0, end);
}

/**
 * The residue request, or `undefined` when there is nothing to ask. The prompt is one route line (so the router
 * sends it to a heavy, pinned design role), `Writes: none.`, the request JSON (one line), the schema and the rules.
 */
export function residueRequestOf(
  draft: LedgerV1,
  candidates: readonly ResidueCandidate[],
): { prompt: string; schema: JsonValue; taskIds: TaskId[] } | undefined {
  const taskIds = residueTaskIds(draft);
  const capped = candidates.slice(0, RESIDUE_MAX_CANDIDATES);
  if (taskIds.length === 0 && capped.length === 0) return undefined;

  const requestDigest = residueDigestOf(draft.planDigest, taskIds);
  const tasks: JsonValue[] = taskIds.map((id) => {
    const t = draft.tasks[id] as TaskNode;
    return {
      id,
      title: t.title,
      kind: t.kind,
      phase: t.phase,
      routeLine: t.route.line,
      footprint: {
        writes: [...t.footprint.writes],
        reads: [...t.footprint.reads],
        confidence: t.footprint.confidence,
        sources: [...t.footprint.sources],
      },
      excerpt: cutExcerpt(t.text),
    };
  });
  const request: JsonValue = {
    requestDigest,
    tasks,
    candidates: capped.map((c) => ({ from: c.from, to: c.to, why: c.why })),
  };

  const root = routeRoot(draft.repo.toplevel);
  const routeLine = `[route class=design risk=medium scope=multi d=none${root === null ? "" : ` ${root}`} tier=heavy pin]`;
  const prompt = [
    routeLine,
    "Writes: none.",
    "",
    "You are the architect for a plan compiler. For the tasks below the compiler could not decide the files they",
    "write or read, or the order between them. Read the repository (read-only) and answer with the missing facts.",
    "",
    "Request (JSON):",
    JSON.stringify(request),
    "",
    "Response schema (JSON Schema):",
    JSON.stringify(RESIDUE_SCHEMA),
    "",
    "Rules:",
    "- Paths are repo-relative, '/'-separated: no drive, no '..', no URL, no ':'. Use a directory path only for a whole directory.",
    "- For every task you list under `footprints`, restate its FULL footprint: every path already in `writes` and `reads`, plus the additions.",
    "  An entry that omits an existing path, or changes the write set of an `explicit` or `ownership` task, is rejected.",
    "- `edges` order two tasks (`from` runs before `to`); `from` may be `gate:<phase>`. Use `confidence` `medium` or `low`.",
    "  Edges must not create a cycle. You cannot remove or delete anything.",
    "- List in `noChange` the tasks that are confirmed to write nothing.",
    `- Copy \`requestDigest\` exactly: ${requestDigest}. Every \`evidence\` is one short sentence (at most ${RESIDUE_EVIDENCE_MAX} characters).`,
    "- Return `DONE:` followed by exactly one ```json block holding the response, nothing else.",
  ].join("\n");

  return { prompt, schema: RESIDUE_SCHEMA, taskIds };
}

// ---------------------------------------------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------------------------------------------

/** Last ```json block of `text`, else the whole text. `undefined` when it does not parse. */
export function parseResidue(text: string): unknown {
  const re = /```json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?[^\S\r\n]*```/gi;
  let last: string | undefined;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1];
  const source = last ?? text;
  try {
    return JSON.parse(source.trim()) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(code: string, at: string, extra: { [k: string]: JsonValue } = {}): ResidueValidation {
  return { ok: false, code, at, detail: { code, at, ...extra } };
}

const DELETE_KEY_RE = /^(remove|delete|drop)/i;

function childPath(at: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

/** JSON path of the first key that asks for a removal (`remove*`/`delete*`/`drop*` or `op`) anywhere, else null. */
function findDeleteKey(root: unknown): string | null {
  const stack: Array<{ v: unknown; at: string }> = [{ v: root, at: "$" }];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const cur = stack.pop() as { v: unknown; at: string };
    if (typeof cur.v !== "object" || cur.v === null || seen.has(cur.v)) continue;
    seen.add(cur.v);
    if (Array.isArray(cur.v)) {
      for (let i = cur.v.length - 1; i >= 0; i--) stack.push({ v: cur.v[i], at: `${cur.at}[${i}]` });
      continue;
    }
    const keys = Object.keys(cur.v);
    for (const k of keys) if (DELETE_KEY_RE.test(k) || k === "op") return childPath(cur.at, k);
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i] as string;
      stack.push({ v: (cur.v as Rec)[k], at: childPath(cur.at, k) });
    }
  }
  return null;
}

type SchemaResult = { ok: true; value: ResidueResponse } | { ok: false; at: string; why: string };

const DIGEST_RE = /^[0-9a-f]{16}$/;

function schemaFail(at: string, why: string): SchemaResult {
  return { ok: false, at, why };
}

function extraKey(o: Rec, allowed: readonly string[]): string | null {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return k;
  return null;
}

function stringArray(v: unknown, at: string, nonEmpty: boolean): { ok: true; value: string[] } | { ok: false; at: string; why: string } {
  if (!Array.isArray(v)) return { ok: false, at, why: "expected an array" };
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const s: unknown = v[i];
    if (typeof s !== "string") return { ok: false, at: `${at}[${i}]`, why: "expected a string" };
    if (nonEmpty && s.length === 0) return { ok: false, at: `${at}[${i}]`, why: "expected a non-empty string" };
    out.push(s);
  }
  return { ok: true, value: out };
}

function evidenceOf(o: Rec, at: string): { ok: true; value: string } | { ok: false; at: string; why: string } {
  const e = o.evidence;
  if (typeof e !== "string") return { ok: false, at: `${at}.evidence`, why: "expected a string" };
  if (e.length < 1 || e.length > RESIDUE_EVIDENCE_MAX) {
    return { ok: false, at: `${at}.evidence`, why: `expected 1..${RESIDUE_EVIDENCE_MAX} characters` };
  }
  return { ok: true, value: e };
}

/** Hand-written check of `RESIDUE_SCHEMA`; the first violation wins. */
function checkSchema(v: unknown): SchemaResult {
  if (!isRec(v)) return schemaFail("$", "expected an object");
  for (const k of ["requestDigest", "footprints", "edges"]) {
    if (!has(v, k)) return schemaFail(childPath("$", k), "required property is missing");
  }
  const extra = extraKey(v, ["requestDigest", "footprints", "edges", "noChange"]);
  if (extra !== null) return schemaFail(childPath("$", extra), "additional property");
  const digest = v.requestDigest;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    return schemaFail("$.requestDigest", "expected 16 lowercase hex characters");
  }

  const footprints: ResidueFootprintEntry[] = [];
  if (!Array.isArray(v.footprints)) return schemaFail("$.footprints", "expected an array");
  for (let i = 0; i < v.footprints.length; i++) {
    const at = `$.footprints[${i}]`;
    const e: unknown = v.footprints[i];
    if (!isRec(e)) return schemaFail(at, "expected an object");
    for (const k of ["taskId", "writes", "reads", "evidence"]) {
      if (!has(e, k)) return schemaFail(childPath(at, k), "required property is missing");
    }
    const x = extraKey(e, ["taskId", "writes", "reads", "evidence"]);
    if (x !== null) return schemaFail(childPath(at, x), "additional property");
    if (typeof e.taskId !== "string") return schemaFail(`${at}.taskId`, "expected a string");
    const writes = stringArray(e.writes, `${at}.writes`, true);
    if (!writes.ok) return schemaFail(writes.at, writes.why);
    const reads = stringArray(e.reads, `${at}.reads`, true);
    if (!reads.ok) return schemaFail(reads.at, reads.why);
    const ev = evidenceOf(e, at);
    if (!ev.ok) return schemaFail(ev.at, ev.why);
    footprints.push({ taskId: e.taskId, writes: writes.value, reads: reads.value, evidence: ev.value });
  }

  const edges: ResidueEdgeEntry[] = [];
  if (!Array.isArray(v.edges)) return schemaFail("$.edges", "expected an array");
  for (let i = 0; i < v.edges.length; i++) {
    const at = `$.edges[${i}]`;
    const e: unknown = v.edges[i];
    if (!isRec(e)) return schemaFail(at, "expected an object");
    for (const k of ["from", "to", "confidence", "evidence"]) {
      if (!has(e, k)) return schemaFail(childPath(at, k), "required property is missing");
    }
    const x = extraKey(e, ["from", "to", "confidence", "evidence"]);
    if (x !== null) return schemaFail(childPath(at, x), "additional property");
    if (typeof e.from !== "string") return schemaFail(`${at}.from`, "expected a string");
    if (typeof e.to !== "string") return schemaFail(`${at}.to`, "expected a string");
    if (e.confidence !== "medium" && e.confidence !== "low") {
      return schemaFail(`${at}.confidence`, "expected \"medium\" or \"low\"");
    }
    const ev = evidenceOf(e, at);
    if (!ev.ok) return schemaFail(ev.at, ev.why);
    edges.push({ from: e.from, to: e.to, confidence: e.confidence, evidence: ev.value });
  }

  let noChange: string[] = [];
  if (has(v, "noChange")) {
    const n = stringArray(v.noChange, "$.noChange", false);
    if (!n.ok) return schemaFail(n.at, n.why);
    noChange = n.value;
  }
  return { ok: true, value: { requestDigest: digest, footprints, edges, noChange } };
}

// --- paths -----------------------------------------------------------------------------------------------------

type PathResult = { ok: true; path: string } | { ok: false; reason: string };

/** `/`-separated root without trailing slash; `ci` for drive roots (win32). */
function rootKey(root: string): { text: string; ci: boolean } {
  const text = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return { text, ci: /^[A-Za-z]:/.test(text) };
}

/**
 * Lexical normalization of one response path against the roots (no git, no filesystem): repo-relative, `/`-separated,
 * no `.`/`..` segment, no trailing `/`, no `:` segment, no NUL. An absolute path is accepted only under a root.
 */
function normalizeResiduePath(raw: string, roots: ReadonlyArray<{ text: string; ci: boolean }>): PathResult {
  if (raw.includes("\0")) return { ok: false, reason: "nul" };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) || /^file:/i.test(raw)) return { ok: false, reason: "url" };
  let p = raw.replace(/\\/g, "/");
  if (p.startsWith("//")) return { ok: false, reason: /^\/\/[?.]\//.test(p) ? "device" : "unc" };
  if (/^\/\?\?\//.test(p)) return { ok: false, reason: "device" };
  const absolute = p.startsWith("/") || /^[A-Za-z]:/.test(p);
  if (absolute) {
    let rel: string | null = null;
    for (const r of roots) {
      if (r.text === "") continue;
      const head = p.slice(0, r.text.length);
      const same = r.ci ? head.toLowerCase() === r.text.toLowerCase() : head === r.text;
      if (same && p.charAt(r.text.length) === "/") {
        rel = p.slice(r.text.length + 1);
        break;
      }
    }
    if (rel === null) {
      if (/^[A-Za-z]:/.test(p)) return { ok: false, reason: p.charAt(2) === "/" ? "other-drive" : "drive-relative" };
      return { ok: false, reason: p.startsWith("/") && roots.some((r) => r.ci) ? "drive-less" : "outside" };
    }
    p = rel;
  }
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return { ok: false, reason: "escape" };
      out.pop();
      continue;
    }
    if (seg.includes(":")) return { ok: false, reason: "colon" };
    out.push(seg);
  }
  if (out.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, path: out.join("/") };
}

function normalizeList(
  list: readonly string[],
  at: string,
  roots: ReadonlyArray<{ text: string; ci: boolean }>,
): { ok: true; value: string[] } | { ok: false; at: string; path: string; reason: string } {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i] as string;
    const r = normalizeResiduePath(raw, roots);
    if (!r.ok) return { ok: false, at: `${at}[${i}]`, path: raw, reason: r.reason };
    if (!out.includes(r.path)) out.push(r.path);
  }
  return { ok: true, value: out };
}

// --- graph -----------------------------------------------------------------------------------------------------

function gateName(phase: string): string {
  return `gate:${phase}`;
}

/** Shortest cycle through the first non-trivial strongly connected component, or null. Iterative, O(V+E) to detect. */
function findMinimalCycle(nodes: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): string[] | null {
  const index = new Map<string, number>();
  nodes.forEach((n, i) => index.set(n, i));
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined) (adj[a] as number[]).push(b);
  }
  const n = nodes.length;
  // Tarjan, iterative.
  const idx: number[] = new Array<number>(n).fill(-1);
  const low: number[] = new Array<number>(n).fill(0);
  const onStack: boolean[] = new Array<boolean>(n).fill(false);
  const comp: number[] = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  let counter = 0;
  let comps = 0;
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const work: Array<{ v: number; i: number }> = [{ v: s, i: 0 }];
    idx[s] = low[s] = counter++;
    stack.push(s);
    onStack[s] = true;
    while (work.length > 0) {
      const top = work[work.length - 1] as { v: number; i: number };
      const outs = adj[top.v] as number[];
      if (top.i < outs.length) {
        const w = outs[top.i++] as number;
        if (idx[w] === -1) {
          idx[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push({ v: w, i: 0 });
        } else if (onStack[w]) {
          low[top.v] = Math.min(low[top.v] as number, idx[w] as number);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low[parent.v] = Math.min(low[parent.v] as number, low[top.v] as number);
      if (low[top.v] === idx[top.v]) {
        let size = 0;
        for (;;) {
          const w = stack.pop() as number;
          onStack[w] = false;
          comp[w] = comps;
          size++;
          if (w === top.v) break;
        }
        sizes.push(size);
        comps++;
      }
    }
  }
  // First component (by node order) that is non-trivial or has a self-loop.
  let target = -1;
  for (let v = 0; v < n && target === -1; v++) {
    const c = comp[v] as number;
    if ((sizes[c] as number) > 1 || (adj[v] as number[]).includes(v)) target = c;
  }
  if (target === -1) return null;
  const members: number[] = [];
  for (let v = 0; v < n; v++) if (comp[v] === target) members.push(v);

  let best: number[] | null = null;
  for (const start of members) {
    const prev = new Map<number, number>();
    const queue: number[] = [start];
    let found = false;
    for (let head = 0; head < queue.length && !found; head++) {
      const u = queue[head] as number;
      for (const w of adj[u] as number[]) {
        if (comp[w] !== target) continue;
        if (w === start) {
          const path: number[] = [u];
          while (path[path.length - 1] !== start) path.push(prev.get(path[path.length - 1] as number) as number);
          path.reverse();
          if (best === null || path.length < best.length) best = path;
          found = true;
          break;
        }
        if (!prev.has(w) && w !== start) {
          prev.set(w, u);
          queue.push(w);
        }
      }
    }
    if (best !== null && best.length <= 2) break;
  }
  return best === null ? null : best.map((i) => nodes[i] as string);
}

/** Existing edges plus the response's edges that are new pairs (the merge rule), as pairs. */
function newEdges(draft: LedgerV1, r: ResidueResponse): ResidueEdgeEntry[] {
  const seen = new Set<string>(draft.edges.map((e) => `${e.from}>${e.to}`));
  const out: ResidueEdgeEntry[] = [];
  for (const e of r.edges) {
    const key = `${e.from}>${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// --- validate --------------------------------------------------------------------------------------------------

function setEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
}

/**
 * Validates a parsed response against the draft. Order (first failure wins): `residue-json`, `residue-delete`,
 * `residue-schema`, `residue-digest`, `residue-unknown-task`, `residue-weaken`, `residue-path`, `residue-cycle`.
 * On success the value carries normalized repo-relative paths.
 */
export function validateResidue(draft: LedgerV1, v: unknown): ResidueValidation {
  if (v === undefined) return fail("residue-json", "$", { reason: "no parseable JSON" });

  const del = findDeleteKey(v);
  if (del !== null) return fail("residue-delete", del, { reason: "a residue can only add, never remove" });

  const sch = checkSchema(v);
  if (!sch.ok) return fail("residue-schema", sch.at, { reason: sch.why });
  const r = sch.value;

  const expected = residueDigestOf(draft.planDigest, residueTaskIds(draft));
  if (r.requestDigest !== expected) {
    return fail("residue-digest", "$.requestDigest", { expected, actual: r.requestDigest });
  }

  const phaseIds = new Set(draft.phases.map((p) => p.id));
  for (let i = 0; i < r.footprints.length; i++) {
    const id = (r.footprints[i] as ResidueFootprintEntry).taskId;
    if (!has(draft.tasks, id)) return fail("residue-unknown-task", `$.footprints[${i}].taskId`, { id });
  }
  for (let i = 0; i < r.edges.length; i++) {
    const e = r.edges[i] as ResidueEdgeEntry;
    const fromOk = has(draft.tasks, e.from) || (e.from.startsWith("gate:") && phaseIds.has(e.from.slice(5)));
    if (!fromOk) return fail("residue-unknown-task", `$.edges[${i}].from`, { id: e.from });
    if (!has(draft.tasks, e.to)) return fail("residue-unknown-task", `$.edges[${i}].to`, { id: e.to });
  }
  for (let i = 0; i < r.noChange.length; i++) {
    const id = r.noChange[i] as string;
    if (!has(draft.tasks, id)) return fail("residue-unknown-task", `$.noChange[${i}]`, { id });
  }

  for (let i = 0; i < r.footprints.length; i++) {
    const e = r.footprints[i] as ResidueFootprintEntry;
    const old = (draft.tasks[e.taskId] as TaskNode).footprint;
    const at = `$.footprints[${i}]`;
    if (old.confidence === "explicit" || old.confidence === "ownership") {
      if (!setEquals(e.writes, old.writes) || !setEquals(e.reads, old.reads)) {
        return fail("residue-weaken", at, {
          reason: `changes the footprint of a ${old.confidence} task`,
          taskId: e.taskId,
          confidence: old.confidence,
        });
      }
    }
    const missingWrites = old.writes.filter((p) => !e.writes.includes(p));
    const missingReads = old.reads.filter((p) => !e.reads.includes(p));
    if (missingWrites.length > 0 || missingReads.length > 0) {
      return fail("residue-weaken", at, {
        reason: "omits existing paths",
        taskId: e.taskId,
        missingWrites,
        missingReads,
      });
    }
  }

  const roots = [rootKey(draft.repo.toplevel), rootKey(draft.integration.worktree)];
  const value: ResidueResponse = { ...r, footprints: [] };
  for (let i = 0; i < r.footprints.length; i++) {
    const e = r.footprints[i] as ResidueFootprintEntry;
    const writes = normalizeList(e.writes, `$.footprints[${i}].writes`, roots);
    if (!writes.ok) return fail("residue-path", writes.at, { path: writes.path, reason: writes.reason });
    const reads = normalizeList(e.reads, `$.footprints[${i}].reads`, roots);
    if (!reads.ok) return fail("residue-path", reads.at, { path: reads.path, reason: reads.reason });
    value.footprints.push({ ...e, writes: writes.value, reads: reads.value });
  }

  const nodes: string[] = [...Object.keys(draft.tasks), ...draft.phases.map((p) => gateName(p.id))];
  const pairs: Array<{ from: string; to: string }> = [
    ...draft.edges.map((e) => ({ from: e.from as string, to: e.to })),
    ...newEdges(draft, value).map((e) => ({ from: e.from, to: e.to })),
  ];
  for (const [id, t] of Object.entries(draft.tasks)) {
    if (t.phase !== null) pairs.push({ from: id, to: gateName(t.phase) }); // implicit: a task is part of its phase gate
  }
  const cycle = findMinimalCycle(nodes, pairs);
  if (cycle !== null) return fail("residue-cycle", "$.edges", { cycle });

  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------------------------

function union(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const p of b) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * Monotone merge of a validated response: write/read sets only grow, `llm` is added to the sources, `unknown`
 * becomes `inferred` (never any other confidence change), `noChange` ids go `unknown` → `inferred` without paths.
 * New edges are `kind:"llm"` with at most `medium` confidence; existing pairs are skipped. Status, `seq` and the
 * `conflict` edges are the caller's (`index.mergeResidue`). The input is not modified.
 */
export function mergeResidueInto(draft: LedgerV1, r: ResidueResponse): LedgerV1 {
  const tasks: Record<TaskId, TaskNode> = { ...draft.tasks };
  for (const e of r.footprints) {
    const t = tasks[e.taskId];
    if (t === undefined || !has(tasks, e.taskId)) continue;
    const fp = t.footprint;
    tasks[e.taskId] = {
      ...t,
      footprint: {
        writes: union(fp.writes, e.writes),
        reads: union(fp.reads, e.reads),
        confidence: fp.confidence === "unknown" ? "inferred" : fp.confidence,
        sources: fp.sources.includes("llm") ? [...fp.sources] : [...fp.sources, "llm"],
      },
    };
  }
  for (const id of r.noChange) {
    const t = tasks[id];
    if (t === undefined || !has(tasks, id) || t.footprint.confidence !== "unknown") continue;
    tasks[id] = { ...t, footprint: { ...t.footprint, writes: [...t.footprint.writes], reads: [...t.footprint.reads],
      sources: [...t.footprint.sources], confidence: "inferred" } };
  }
  const added: Edge[] = newEdges(draft, r).map((e) => ({
    from: e.from as Edge["from"],
    to: e.to,
    kind: "llm" as const,
    confidence: e.confidence === "low" ? ("low" as const) : ("medium" as const),
    evidence: `residue: ${e.evidence}`,
  }));
  return { ...draft, tasks, edges: [...draft.edges, ...added] };
}
