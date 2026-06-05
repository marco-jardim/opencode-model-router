// src/verify/dod.ts
// Pure DoD (Definition of Done) schema, parser, and auto-inference.
// PURE: no imports from Node fs/os/path, no network, no SDK, no other project modules.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckKind = "run" | "fileExists" | "schemaMatch" | "testsPass" | "buildPasses" | "lintClean";

export interface Check {
  kind: CheckKind;
  command?: string;   // run/testsPass/buildPasses/lintClean (optional; runner supplies a default later)
  expect?: string;    // run: expected substring in output (optional)
  path?: string;      // fileExists/schemaMatch
  schema?: string;    // schemaMatch: inline JSON or a path
}

export type DoDKind = "deterministic" | "checker" | "none";
export type DoDSource = "explicit" | "inferred" | "annotation" | "none";

export interface DoD {
  kind: DoDKind;
  checks: Check[];        // [] when none/checker-only
  criteria: string[];     // [] when none
  deliverable: string | null;
  source: DoDSource;
}

export interface InferHints {
  testCommand?: string | null;
  buildCommand?: string | null;
  lintCommand?: string | null;
  declaredPath?: string | null;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const VALID_CHECK_KINDS: ReadonlySet<string> = new Set<string>([
  "run", "fileExists", "schemaMatch", "testsPass", "buildPasses", "lintClean",
]);

const VALID_DOD_KINDS: ReadonlySet<string> = new Set<string>([
  "deterministic", "checker", "none",
]);

const OPEN_TAG_RE = /^\s*\[(acceptance|dod)\]\s*$/i;
const CLOSE_TAG_RE = /^\s*\[\/(acceptance|dod)\]\s*$/i;

// ---------------------------------------------------------------------------
// summarizeDispatch
// ---------------------------------------------------------------------------

export function summarizeDispatch(text: string): string {
  if (!text) return "";
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().replace(/\s+/g, " ");
    if (trimmed) return trimmed.slice(0, 120);
  }
  return "";
}

// ---------------------------------------------------------------------------
// normalizeDoD
// ---------------------------------------------------------------------------

export function normalizeDoD(d: DoD): DoD {
  const checks: Check[] = Array.isArray(d.checks) ? [...d.checks] : [];
  const criteria: string[] = Array.isArray(d.criteria) ? [...d.criteria] : [];

  let kind: DoDKind;
  if (checks.length > 0) kind = "deterministic";
  else if (criteria.length > 0) kind = "checker";
  else kind = "none";

  const rawDeliverable = typeof d.deliverable === "string" ? d.deliverable.trim() : "";
  const deliverable: string | null = rawDeliverable.length > 0 ? rawDeliverable : null;

  return { kind, checks, criteria, deliverable, source: d.source };
}

// ---------------------------------------------------------------------------
// parseKvPairs — internal helper
// ---------------------------------------------------------------------------

function parseKvPairs(s: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|([\S]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : (m[3] ?? "");
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// parseAcceptanceBlock
// ---------------------------------------------------------------------------

export function parseAcceptanceBlock(text: string, source: DoDSource = "explicit"): DoD | null {
  const lines = text.split("\n");

  let openIdx = -1;
  let closeIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (OPEN_TAG_RE.test(lines[i])) {
      openIdx = i;
      break;
    }
  }

  if (openIdx === -1) return null;

  for (let i = openIdx + 1; i < lines.length; i++) {
    if (CLOSE_TAG_RE.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) return null;

  const innerLines = lines.slice(openIdx + 1, closeIdx);
  const checks: Check[] = [];
  const criteria: string[] = [];
  let deliverable: string | null = null;
  let kindHint: DoDKind | null = null;

  for (const rawLine of innerLines) {
    const line = rawLine.trim();
    if (!line) continue;

    const lline = line.toLowerCase();

    if (lline.startsWith("check:")) {
      const rest = line.slice("check:".length).trim();
      const spaceIdx = rest.search(/\s/);
      const kindStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const remainder = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);

      if (!VALID_CHECK_KINDS.has(kindStr)) continue;

      const kvPairs = parseKvPairs(remainder);
      const check: Check = { kind: kindStr as CheckKind };
      if (kvPairs["command"] !== undefined) check.command = kvPairs["command"];
      if (kvPairs["expect"] !== undefined) check.expect = kvPairs["expect"];
      if (kvPairs["path"] !== undefined) check.path = kvPairs["path"];
      if (kvPairs["schema"] !== undefined) check.schema = kvPairs["schema"];
      checks.push(check);
    } else if (lline.startsWith("criteria:")) {
      const rest = line.slice("criteria:".length).trim();
      if (rest) criteria.push(rest);
    } else if (lline.startsWith("deliverable:")) {
      const rest = line.slice("deliverable:".length).trim();
      deliverable = rest.length > 0 ? rest : null;
    } else if (lline.startsWith("kind:")) {
      const rest = line.slice("kind:".length).trim().toLowerCase();
      if (VALID_DOD_KINDS.has(rest)) {
        kindHint = rest as DoDKind;
      }
    }
  }

  return normalizeDoD({
    kind: kindHint !== null ? kindHint : "none",
    checks,
    criteria,
    deliverable,
    source,
  });
}

// ---------------------------------------------------------------------------
// parseDoDFromDispatch / parseDoDFromAnnotation
// ---------------------------------------------------------------------------

export function parseDoDFromDispatch(dispatchText: string): DoD | null {
  return parseAcceptanceBlock(dispatchText, "explicit");
}

export function parseDoDFromAnnotation(annotationText: string): DoD | null {
  return parseAcceptanceBlock(annotationText, "annotation");
}

// ---------------------------------------------------------------------------
// inferDoD
// ---------------------------------------------------------------------------

export function inferDoD(dispatchText: string, tier: string, hints: InferHints): DoD {
  // tier accepted for forward-compat; not used in phase 2.1
  const lower = dispatchText.toLowerCase();

  // Classify by FIRST matching pattern
  let category: "bugfix" | "refactor" | "writeFile" | "impl" | "test" | "unknown";

  if (/\b(bug|fix|broken|regression|failing)\b/.test(lower)) {
    category = "bugfix";
  } else if (/\b(refactor|rename|extract|restructure|cleanup|clean up)\b/.test(lower)) {
    category = "refactor";
  } else if (
    /\b(write|generate|emit|scaffold)\b/.test(lower) &&
    hints.declaredPath != null &&
    hints.declaredPath.trim().length > 0
  ) {
    category = "writeFile";
  } else if (/\b(implement|add|feature|create|build|endpoint|function|component|fix)\b/.test(lower)) {
    category = "impl";
  } else if (/\b(test|spec|coverage)\b/.test(lower)) {
    category = "test";
  } else {
    category = "unknown";
  }

  const checks: Check[] = [];

  if (category === "bugfix" || category === "impl") {
    if (hints.buildCommand != null && hints.buildCommand.trim().length > 0) {
      checks.push({ kind: "buildPasses", command: hints.buildCommand });
    }
    if (hints.testCommand != null && hints.testCommand.trim().length > 0) {
      checks.push({ kind: "testsPass", command: hints.testCommand });
    }
  } else if (category === "refactor") {
    if (hints.buildCommand != null && hints.buildCommand.trim().length > 0) {
      checks.push({ kind: "buildPasses", command: hints.buildCommand });
    }
    if (hints.lintCommand != null && hints.lintCommand.trim().length > 0) {
      checks.push({ kind: "lintClean", command: hints.lintCommand });
    }
  } else if (category === "writeFile") {
    checks.push({ kind: "fileExists", path: hints.declaredPath!.trim() });
  } else if (category === "test") {
    if (hints.testCommand != null && hints.testCommand.trim().length > 0) {
      checks.push({ kind: "testsPass", command: hints.testCommand });
    }
  }
  // "unknown" and other fallthrough: checks stays empty

  const criteria: string[] = [];

  if (checks.length === 0) {
    const summary = summarizeDispatch(dispatchText);
    criteria.push(
      summary.length > 0
        ? summary
        : "the delegated task is completed as described in the dispatch",
    );
  }

  const rawPath = hints.declaredPath != null ? hints.declaredPath.trim() : "";
  const deliverable: string | null = rawPath.length > 0 ? rawPath : null;

  return normalizeDoD({
    kind: checks.length > 0 ? "deterministic" : "checker",
    checks,
    criteria,
    deliverable,
    source: "inferred",
  });
}

// ---------------------------------------------------------------------------
// isCheckable
// ---------------------------------------------------------------------------

export function isCheckable(d: DoD): boolean {
  return d.kind !== "none" && (d.checks.length > 0 || d.criteria.length > 0);
}
