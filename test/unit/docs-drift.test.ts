import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ROUTING_DEFAULTS,
  ROUTING_ENGINES,
  ROUTING_TASK_CLASSES,
  resolveRouting,
  validateConfig,
} from "../../src/router/config";
import { parseJsonc } from "../../src/router/jsonc";
import { FINDING_IDS } from "../../src/routing/advisor/findings";
import {
  assembleSystemPrompt,
  buildDelegationProtocol,
} from "../../src/router/protocol";
import type { RouterConfig } from "../../src/index";

/**
 * Documentation-drift guards.
 *
 * These assert that two things the docs claim stay true of the shipped code:
 * every top-level key of `tiers.json` and selected nested enforcement keys are
 * described in the config reference, and
 * the README quotes the prompt sizes that the golden snapshots actually produce.
 *
 * Both fail on ADDITION, which is the point. Adding a config key or growing the
 * protocol should force the corresponding doc edit in the same change, rather
 * than leaving the docs to rot until someone notices.
 */

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const undocumentedKeys = (doc: string, keys: readonly string[]) =>
  keys.filter((key) => !doc.includes(`\`${key}\``));
const nestedEnforcementKeys = [
  "enforcement.maxDelegationDepth",
  "enforcement.escalate.effortBump",
  "enforcement.escalate.effortBumpMax",
];

describe("docs drift", () => {
  it("documents every tiers.json top-level key in CONFIG_REFERENCE.md", () => {
    const tiers = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const doc = read("docs/CONFIG_REFERENCE.md");

    const keys = Object.keys(tiers);
    // Sanity: a tiers.json that parsed to nothing would make this vacuously green.
    expect(keys.length).toBeGreaterThan(0);

    const undocumented = undocumentedKeys(doc, keys);
    expect(undocumented).toEqual([]);
  });

  it("documents depth and effort bump key paths in CONFIG_REFERENCE.md", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    expect(undocumentedKeys(doc, nestedEnforcementKeys)).toEqual([]);
  });

  it.each(nestedEnforcementKeys)("detects missing nested key %s", (missingKey) => {
    const fixture = nestedEnforcementKeys
      .filter((key) => key !== missingKey)
      .map((key) => `\`${key}\``)
      .join("\n");

    expect(undocumentedKeys(fixture, nestedEnforcementKeys)).toEqual([missingKey]);
  });

  // 30s timeout: this test recomputes the assembled prompts live, which can
  // exceed the 5s default on a cold windows-latest runner (flaked in CI run
  // 32212281722 with a hard timeout, passed on the immediate rerun).
  it("quotes the measured prompt figures in README.md", { timeout: 30_000 }, () => {
    const readme = read("README.md");

    // Recomputed here rather than pinned to a literal, so that growing the
    // protocol fails this test instead of quietly making the README wrong.
    // `validateConfig(tiers.json)` unmodified IS the documented measurement
    // basis: the bundled anthropic preset in normal mode, i.e. the shipped
    // activePreset/activeMode defaults.
    const cfg = validateConfig(
      JSON.parse(read("tiers.json")),
    ) as unknown as RouterConfig;
    const claude = "anthropic/claude-sonnet-4-6";

    const figures = {
      "base protocol": buildDelegationProtocol(cfg).length,
      "Claude orchestrator": assembleSystemPrompt(cfg, claude).length,
      "Claude + enforcement": assembleSystemPrompt(cfg, claude, true).length,
    };

    // Thousands separator, matching how the README writes them.
    const missing = Object.entries(figures)
      .map(([label, chars]) => [label, chars.toLocaleString("en-US")] as const)
      .filter(([, formatted]) => !readme.includes(formatted));

    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cost-aware routing engine (#74): docs/ROUTING_ENGINE.md, ADR 0005 and the
// routing section of docs/CONFIG_REFERENCE.md must keep describing the code.
// ---------------------------------------------------------------------------

/** Repo-relative (posix) markdown files whose relative links must resolve. */
const ROUTING_DOCS = [
  "README.md",
  "docs/ROUTING_ENGINE.md",
  "docs/adr/0005-cost-aware-routing-engine.md",
  "docs/plans/README.md",
  "docs/CONFIG_REFERENCE.md",
] as const;

/** GitHub's heading slug: lower case, no backticks or punctuation, spaces become hyphens. */
function slugOf(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Lines of `text` outside fenced code blocks, with their 1-based numbers. */
function proseLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (opener !== null) {
      const mark = opener[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      return;
    }
    if (fence === null) out.push({ line: index + 1, text: raw });
  });
  return out;
}

function anchorsOf(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const { text: line } of proseLines(text)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const slug = slugOf(heading[1]!);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

/**
 * Relative markdown links (`[text](target)` outside code) of `files` that point at a missing file or,
 * for a `.md` target, at a heading that does not exist. `read` answers `undefined` for a missing file.
 */
function brokenLinks(files: readonly string[], read: (path: string) => string | undefined): string[] {
  const broken: string[] = [];
  for (const file of files) {
    const text = read(file);
    if (text === undefined) {
      broken.push(`${file}: file missing`);
      continue;
    }
    for (const { line, text: raw } of proseLines(text)) {
      const prose = raw.replace(/`[^`]*`/g, "");
      for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1]!;
        if (/^(?:https?:|mailto:)/i.test(target)) continue;
        const [pathPart, anchor] = target.split("#") as [string, string | undefined];
        const destination = pathPart === "" ? file : posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(pathPart)));
        const body = read(destination.replace(/\/$/, ""));
        if (body === undefined) {
          broken.push(`${file}:${line}: ${target} (missing)`);
        } else if (anchor !== undefined && destination.endsWith(".md") && !anchorsOf(body).has(anchor.toLowerCase())) {
          broken.push(`${file}:${line}: ${target} (no such heading)`);
        }
      }
    }
  }
  return broken;
}

/** Every file or directory under the repo, read lazily; a directory answers an empty string. */
function readRepo(path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf-8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "EISDIR" ? "" : undefined;
  }
}

/** Dotted paths of the leaves of a nested defaults object. */
function leafPaths(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === "object" && child !== null && !Array.isArray(child)
      ? leafPaths(child as Record<string, unknown>, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe("docs drift: cost-aware routing engine", () => {
  it("documents every routing key, with its default row, in CONFIG_REFERENCE.md", () => {
    const doc = read("docs/CONFIG_REFERENCE.md");
    // `roles` and `classifier.presets` have no fixed leaves; every other key is a leaf of the defaults.
    const { roles: _roles, ...defaults } = ROUTING_DEFAULTS as Record<string, unknown>;
    const keys = [...leafPaths(defaults), "classifier.presets", "roles"];
    expect(keys.length).toBeGreaterThan(10);
    const missing = keys.filter((key) => !doc.includes(`| \`${key}\` |`));
    expect(missing).toEqual([]);
  });

  it("names every engine mode, task class and cost-doctor finding in ROUTING_ENGINE.md", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    const names = [...ROUTING_ENGINES, ...ROUTING_TASK_CLASSES, ...FINDING_IDS];
    expect(names.length).toBeGreaterThan(20);
    expect(undocumentedKeys(doc, names)).toEqual([]);
  });

  it("keeps every engine-example block of ROUTING_ENGINE.md a valid configuration", () => {
    const doc = read("docs/ROUTING_ENGINE.md");
    const bundled = JSON.parse(read("tiers.json")) as Record<string, unknown>;
    const examples = [...doc.matchAll(/<!-- engine-example: ([\w-]+) -->\s*```jsonc\n([\s\S]*?)\n```/g)];
    // shadow, enforce, ollama, opencode-go-host, opencode-go-http, typesafe
    expect(examples.map((m) => m[1])).toEqual(
      expect.arrayContaining(["shadow", "enforce", "ollama", "opencode-go-host", "opencode-go-http", "typesafe"]),
    );
    for (const [, name, body] of examples) {
      const parsed = parseJsonc(body!) as Record<string, unknown>;
      const cfg = validateConfig({ ...bundled, ...parsed });
      const engine = resolveRouting(cfg, "v2").engine;
      expect(ROUTING_ENGINES, `example ${name}`).toContain(engine);
    }
  });

  it("links the guide and the ADR from the README and the plans index, and credits #73 in the changelog", () => {
    expect(read("README.md")).toContain("docs/ROUTING_ENGINE.md");
    expect(read("README.md")).toContain("docs/adr/0005-cost-aware-routing-engine.md");
    expect(read("docs/plans/README.md")).toContain("../adr/0005-cost-aware-routing-engine.md");
    expect(read("docs/plans/README.md")).toContain("../ROUTING_ENGINE.md");
    const unreleased = /## \[Unreleased\]([\s\S]*?)\n## \[/.exec(read("CHANGELOG.md"))?.[1] ?? "";
    expect(unreleased).toContain("#73");
    expect(unreleased).toContain("#74");
  });

  it("resolves every relative markdown link of the routing docs, anchors included", () => {
    expect(brokenLinks(ROUTING_DOCS, readRepo)).toEqual([]);
  });

  it("detects a missing file, a missing heading and a missing document", () => {
    const files: Record<string, string> = {
      "docs/a.md": "# A\n\n[ok](b.md) [file](nope.md) [heading](b.md#nothing) [good](b.md#hello-there) [self](#a)\n\n```\n[ignored](nope.md)\n```\n",
      "docs/b.md": "# Hello there\n",
    };
    const read = (path: string) => files[path];
    expect(brokenLinks(["docs/a.md"], read)).toEqual([
      "docs/a.md:3: nope.md (missing)",
      "docs/a.md:3: b.md#nothing (no such heading)",
    ]);
    expect(brokenLinks(["docs/missing.md"], read)).toEqual(["docs/missing.md: file missing"]);
  });
});
