import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTrivial, normTaskKw } from "../../src/router/sessions";
import { validateConfig } from "../../src/router/config";
import { analyzeRules, classifyByRules, shapeOf } from "../../src/routing/classify/rules";
import {
  HIGH_RISK_CASE_SENSITIVE_TERMS,
  HIGH_RISK_TERMS,
  KEYWORD_RULES,
  MEDIUM_RISK_TERMS,
  NEED_RULES,
  REPO_SCOPE_TERMS,
  type Need,
  type TaskClass,
} from "../../src/routing/classify/types";

const here = dirname(fileURLToPath(import.meta.url));
const tiersJson = JSON.parse(readFileSync(join(here, "../../tiers.json"), "utf-8")) as {
  taskPatterns: Record<string, string[]>;
};
const cfg = validateConfig(tiersJson);

type Row = readonly [text: string, expected: TaskClass, confidence?: number];

function check(rows: readonly Row[]): void {
  for (const [text, expected, confidence] of rows) {
    it(`${JSON.stringify(text)} -> ${expected}${confidence === undefined ? "" : ` ${confidence}`}`, () => {
      const facts = classifyByRules(text, cfg);
      expect(facts.class).toBe(expected);
      if (confidence !== undefined) expect(facts.confidence).toBe(confidence);
      expect(facts.source).toBe("rules");
    });
  }
}

describe("rules table integrity", () => {
  it("every shipped taskPatterns entry is an anchor with its tier", () => {
    for (const tier of ["fast", "medium", "heavy"] as const) {
      for (const entry of tiersJson.taskPatterns[tier]!) {
        expect(
          KEYWORD_RULES.some((rule) => rule.pattern === entry && rule.tier === tier),
          `${tier}:${entry}`,
        ).toBe(true);
      }
    }
  });

  it("no rule is anchored to a pattern the shipped config does not list", () => {
    for (const rule of KEYWORD_RULES) {
      expect(tiersJson.taskPatterns[rule.tier], `${rule.tier}:${rule.pattern}`).toContain(rule.pattern);
    }
  });

  it("every keyword term has flags exactly 'i'; no vocabulary regex is global or sticky", () => {
    for (const rule of KEYWORD_RULES) {
      for (const term of rule.terms) expect(term.flags, term.source).toBe("i");
    }
    const others = [
      ...NEED_RULES.flatMap((rule) => rule.terms),
      ...HIGH_RISK_TERMS,
      ...HIGH_RISK_CASE_SENSITIVE_TERMS,
      ...MEDIUM_RISK_TERMS,
      ...REPO_SCOPE_TERMS,
    ];
    for (const term of others) expect(term.flags, term.source).not.toMatch(/[gy]/);
  });
});

describe("classes: positives and adversarial negatives", () => {
  describe("search", () => {
    check([
      ["grep for classifyTrivial in src", "search", 0.8],
      ["read package.json and tell me the version", "search", 0.8],
      ["where is parseCapDirective defined?", "search", 0.8],
      ["grep then implement the parser in src/a.ts", "implement", 0.5],
      ["do not search, just rename foo to bar in a.ts", "mechanical", 0.8],
    ]);
  });

  describe("recon", () => {
    check([
      ["explore how the verification gate works across src/verify", "recon", 0.8],
      ["summarize every config file", "recon", 0.8],
      ["read src/a.ts, src/b.ts and src/c.ts and report the exports", "recon", 0.8],
      ["read package.json and tell me the version", "search"],
      ["investigate why the build fails", "debug"],
    ]);
  });

  describe("mechanical", () => {
    check([
      ["rename getFoo to fetchFoo in src/a.ts", "mechanical", 0.8],
      ["fix the typo in README.md", "mechanical", 0.8],
      ["bump the version in package.json", "mechanical", 0.8],
      ["refactor and rename the module", "implement"],
    ]);

    it("renaming an auth variable across the repo is mechanical but risky: risk high, confidence capped at 0.5", () => {
      const facts = classifyByRules("rename the auth token variable across the repo", cfg);
      expect(facts.class).toBe("mechanical");
      expect(facts.risk).toBe("high");
      expect(facts.scope).toBe("repo");
      expect(facts.confidence).toBe(0.5);
    });
  });

  describe("implement", () => {
    check([
      ["implement the route-line parser in src/routing/classify/route-line.ts", "implement", 0.8],
      ["add support for YAML configs", "implement", 0.8],
      ["write unit tests for shapeOf", "implement", 0.8],
      ["Review src/router/config.ts for validation gaps. Do not refactor anything.", "review", 0.8],
      ["do not implement anything, count the call sites of normTaskKw", "search"],
    ]);

    it("the design fixture with a semicolon is recon: `;` is a multi-step marker of the shared shape gates", () => {
      const analysis = analyzeRules("do not implement anything; count the call sites of normTaskKw", cfg);
      expect(analysis.shape.multiStep).toBe(true);
      expect(analysis.facts.class).toBe("recon");
      expect(analysis.facts.needs).not.toContain("edit");
    });
  });

  describe("debug", () => {
    check([
      ["the build fails with a type error in src/a.ts, fix it", "debug"],
      ["find the root cause of the flaky session test", "debug"],
      ["tests fail after the last commit; debug it", "debug"],
      ["fix the typo in the error message", "mechanical"],
      ["add unit tests for parseLabel", "implement"],
    ]);
  });

  describe("design", () => {
    check([
      ["design the outcome store schema and its persistence", "design", 0.8],
      ["security audit of the classifier backends", "design", 0.8],
      ["tradeoff analysis: JSONL vs SQLite for the decision log", "design", 0.8],
      ["rename designDoc to specDoc", "mechanical"],
      ["do not redesign anything; fix the failing test in a.test.ts", "debug"],
    ]);

    it("a security audit is high risk", () => {
      expect(classifyByRules("security audit of the classifier backends", cfg).risk).toBe("high");
    });
  });

  describe("review", () => {
    check([
      ["review the diff of car/p12 against car/main", "review"],
      ["code-review src/routing/classify/types.ts", "review"],
      ["QA the phase report adversarially", "review"],
      ["do not review; implement the parser", "implement"],
      ["review and fix the failing tests", "debug"],
    ]);
  });

  describe("other", () => {
    for (const text of ["hello", "", "   \n\t"]) {
      it(`${JSON.stringify(text)} -> other 0.2 (medium risk, single scope, no needs)`, () => {
        expect(classifyByRules(text, cfg)).toEqual({
          class: "other",
          risk: "medium",
          scope: "single",
          needs: [],
          confidence: 0.2,
          source: "rules",
        });
      });
    }

    it("a word that merely contains a keyword is not a hit ('read' inside 'already')", () => {
      expect(classifyByRules("the work is already done", cfg).class).toBe("other");
    });
  });

  it("two classes matched -> confidence 0.5, the higher cost class wins", () => {
    const analysis = analyzeRules("grep for the handler and refactor it", cfg);
    expect(analysis.facts.class).toBe("implement");
    expect(analysis.facts.confidence).toBe(0.5);
    expect(analysis.matched).toEqual(["implement", "search"]);
  });

  it("reports the anchors that produced a hit", () => {
    const analysis = analyzeRules("grep for foo", cfg);
    expect(analysis.anchors).toContain("grep");
    expect(analysis.templated).toBe(false);
  });
});

describe("user taskPatterns not in the table (R6)", () => {
  const custom = { fast: ["lookup-docs/types"], medium: ["frobnicate"], heavy: ["hyperplan(x)"] };

  it("a word-bounded stem hit credits the tier's default class", () => {
    expect(classifyByRules("frobnicate the widget", { taskPatterns: custom }).class).toBe("implement");
    expect(classifyByRules("hyperplan the cluster", { taskPatterns: custom }).class).toBe("design");
    const analysis = analyzeRules("frobnicate the widget", { taskPatterns: custom });
    expect(analysis.anchors).toContain("custom:medium:frobnicate");
  });

  it("is not a substring match and honours negation", () => {
    expect(classifyByRules("defrobnicated", { taskPatterns: custom }).class).toBe("other");
    expect(classifyByRules("do not frobnicate the widget", { taskPatterns: custom }).class).toBe("other");
  });

  it("the built-in vocabulary applies whatever taskPatterns holds", () => {
    expect(classifyByRules("grep for x", { taskPatterns: {} }).class).toBe("search");
    expect(classifyByRules("grep for x", { taskPatterns: undefined }).class).toBe("search");
  });

  it("ignores unknown tier names, short stems and non-string entries", () => {
    const weird = { extreme: ["zzzword"], fast: ["ab", 7 as unknown as string] };
    expect(classifyByRules("zzzword ab", { taskPatterns: weird }).class).toBe("other");
  });

  it("a shipped entry listed under another tier becomes a custom pattern of that tier", () => {
    // `search` is a built-in anchor of the fast tier only.
    const moved = { medium: ["search"] };
    const analysis = analyzeRules("search the codebase", { taskPatterns: moved });
    expect(analysis.anchors).toContain("custom:medium:search");
  });
});

describe("shape gates reproduce classifyTrivial (R4)", () => {
  const substringStem = (keywords: readonly string[], text: string): boolean =>
    keywords.some((kw) => {
      const n = normTaskKw(kw);
      return n.length >= 3 && text.toLowerCase().includes(n);
    });

  const long = "read the source and report back. " + "context filler. ".repeat(20);
  const fixtures: readonly string[] = [
    "search the codebase for X",
    "grep for the handler",
    "refactor the auth module",
    "search the codebase",
    "do the thing xyz",
    "",
    "read package.json and tell me the version",
    "read README.md, package.json, tsconfig.json, tiers.json, LICENSE.md and src/index.ts",
    "read package.json and tsconfig.json",
    "read package.json and recheck package.json",
    "read the config then summarise it",
    "read these files one at a time using the read tool",
    "search each module for the handler",
    "read the following:\n1. the config\n2. the manifest",
    "read the following:\n- the config\n- the manifest",
    long,
    "read package.json and tell me the version\n\nWorking directory: /home/u/proj\nPlatform: linux\nShell: bash",
    "Read these files ONE AT A TIME using the read tool, in this exact order, and after each give a " +
      "one-line summary: README.md, then package.json, then tsconfig.json, then tiers.json, then " +
      "LICENSE, then src/index.ts. Use the read tool separately for each file; do not skip any.",
    "search the src directory structure and report how router, guard and verify are organized",
    "read Makefile, LICENSE and Dockerfile and summarize the build",
    "read Makefile and tell me the default target",
    "read the license field in package.json",
    "grep for foo; grep for bar",
    "grep for foo && grep for bar",
    "Step 1: read the config. Step 2: report the value",
    "read the following:\n1: the config\n2: the manifest",
    "search for the handler\nreport what it returns",
    "search every config file",
    "read all guard modules and tell me what they export",
    "grep all the tests for the handler",
    "read every line of package.json",
    "read all of src/index.ts",
    "read all this and tell me what it means in tiers.json",
    "grep for the handler, quickly",
  ];

  it("classifyTrivial === not-empty && no medium/heavy substring && singleShot && fast substring", () => {
    const fast = cfg.taskPatterns?.fast ?? [];
    const slower = [...(cfg.taskPatterns?.medium ?? []), ...(cfg.taskPatterns?.heavy ?? [])];
    for (const text of fixtures) {
      const expected =
        text.trim() !== "" &&
        !substringStem(slower, text) &&
        shapeOf(text).singleShot &&
        substringStem(fast, text);
      expect(classifyTrivial(text, "fast", cfg), JSON.stringify(text)).toBe(expected);
    }
  });

  it("shapeOf reports the individual gates", () => {
    expect(shapeOf("read package.json and tell me the version")).toMatchObject({
      paths: 1,
      multiStep: false,
      enumeration: false,
      distributive: false,
      imperativeLines: 1,
      breadth: false,
      singleShot: true,
    });
    expect(shapeOf("read a.ts then b.ts")).toMatchObject({ multiStep: true, breadth: true, singleShot: false });
    expect(shapeOf("read a.json, b.json and c.json").paths).toBe(3);
    expect(shapeOf("search every config file").distributive).toBe(true);
    expect(shapeOf("search for x\nreport y").imperativeLines).toBe(2);
    expect(shapeOf("read Makefile and LICENSE").paths).toBe(2);
  });

  it("length alone never changes the class", () => {
    const filler = "context filler. ".repeat(40);
    expect(classifyByRules("grep for the handler. " + filler, cfg).class).toBe("search");
  });
});

describe("needs", () => {
  const needsOf = (text: string, cwd?: string): readonly Need[] =>
    classifyByRules(text, cfg, cwd === undefined ? undefined : { cwd }).needs;

  it("shell, network and web vocabularies", () => {
    expect(needsOf("rg --no-ignore foo src")).toEqual(["shell"]);
    expect(needsOf("git push the branch")).toEqual(["shell", "network"]);
    expect(needsOf("fetch https://example.com/docs")).toEqual(["web"]);
  });

  it("edit vocabulary and the implied edit of mechanical/implement/debug classes", () => {
    expect(needsOf("edit a.ts")).toEqual(["edit"]);
    expect(needsOf("rename foo to bar in a.ts")).toEqual(["edit"]);
    expect(classifyByRules("the build fails with a type error", cfg).needs).toEqual(["shell", "edit"]);
  });

  it("negation removes a need: 'do not edit anything; list the exports'", () => {
    expect(needsOf("do not edit anything; list the exports")).not.toContain("edit");
  });

  it("an absolute path outside the cwd adds external_dir; one inside does not", () => {
    const cwd = "D:\\work\\repo";
    expect(needsOf("write the log to C:\\Users\\me\\AppData\\x.log", cwd)).toEqual(["edit", "external_dir"]);
    expect(needsOf("write the log to D:\\work\\repo\\logs\\x.log", cwd)).toEqual(["edit"]);
    expect(needsOf("write the log to d:/work/repo/x.log.", cwd)).toEqual(["edit"]);
    expect(needsOf("write the log to D:\\work\\repo-other\\x.log", cwd)).toContain("external_dir");
  });

  it("the cwd comes from the 'Working directory:' line when the caller gives none", () => {
    const text = "Working directory: D:\\work\\repo\nwrite the log to C:\\tmp\\x.log";
    expect(needsOf(text)).toContain("external_dir");
    expect(needsOf("Working directory: C:\\tmp\nwrite the log to C:\\tmp\\x.log")).not.toContain("external_dir");
  });

  it("without a cwd only the external_dir vocabulary applies", () => {
    expect(needsOf("write the log to C:\\Users\\me\\x.log")).toEqual(["edit"]);
    expect(needsOf("write the log outside the repo")).toEqual(["edit", "external_dir"]);
  });

  it("needs are unique and in NEEDS order", () => {
    const needs = needsOf("git push, then edit a.ts and fetch https://x.dev, outside the repo");
    expect(needs).toEqual(["shell", "web", "edit", "network", "external_dir"]);
  });
});

describe("dispatch templates (R2)", () => {
  const dispatch = [
    "1. TASK: rename getFoo to fetchFoo in src/a.ts",
    "2. EXPECTED OUTCOME: the symbol is renamed everywhere it is used",
    "3. TOOLS: read/search/write, pwsh for tests",
    "4. MUST DO: keep the diff small",
    "5. MUST NOT DO: do not touch the lockfile, do not refactor",
    "6. CONTEXT: background about the repo and its history",
    "7. ENVIRONMENT: Working directory: D:\\git\\repo. Platform: win32. Shell: pwsh",
  ].join("\n");

  it("TOOLS, MUST NOT DO, CONTEXT and ENVIRONMENT do not feed the class", () => {
    const analysis = analyzeRules(dispatch, cfg);
    expect(analysis.templated).toBe(true);
    expect(analysis.facts.class).toBe("mechanical");
    expect(analysis.facts.confidence).toBe(0.8);
    expect(analysis.facts.risk).toBe("low");
  });

  it("the same words in flat prose do match (search from the tool list)", () => {
    const flat = "rename getFoo to fetchFoo in src/a.ts, tools: read/search/write";
    const facts = classifyByRules(flat, cfg);
    expect(facts.class).toBe("mechanical");
    expect(facts.confidence).toBe(0.5);
  });

  it("a shell mention only in ENVIRONMENT is not a shell need", () => {
    const text = "TASK: list the exports of src/a.ts\nENVIRONMENT: Platform: win32. Shell: pwsh";
    expect(classifyByRules(text, cfg).needs).not.toContain("shell");
    expect(classifyByRules("list the exports of src/a.ts using the shell", cfg).needs).toContain("shell");
  });

  it("text before the first header is kept; an unknown ALL-CAPS label is ordinary text", () => {
    const text = "grep for foo\nNOTE: refactor everything\nTASK: report";
    const analysis = analyzeRules(text, cfg);
    expect(analysis.templated).toBe(false);
    expect(analysis.facts.class).toBe("implement");
    const withPreamble = analyzeRules("grep for foo\nTASK: the handler\nTOOLS: rename", cfg);
    expect(withPreamble.templated).toBe(true);
    expect(withPreamble.facts.class).toBe("search");
  });

  it("one header is not a template", () => {
    expect(analyzeRules("TOOLS: rename things", cfg).templated).toBe(false);
  });
});

describe("directives, acceptance blocks, risk and scope", () => {
  it("lines carrying CAP:/VERIFY:/route directives never feed the classifier", () => {
    expect(classifyByRules("CAP:3 refactor everything", cfg).class).toBe("other");
    expect(classifyByRules("grep for foo\nVERIFY:required refactor", cfg).class).toBe("search");
    expect(classifyByRules("grep for foo\n[route class=design]", cfg).class).toBe("search");
  });

  it("[acceptance] blocks describe the check, not the task", () => {
    const text = "grep for foo\n[acceptance]\ncriteria: implement security fixes\n[/acceptance]";
    const facts = classifyByRules(text, cfg);
    expect(facts.class).toBe("search");
    expect(facts.risk).toBe("low");
  });

  it("high-risk vocabulary ignores negation; other negations apply", () => {
    expect(classifyByRules("list the exports. do not publish anything", cfg).risk).toBe("high");
    expect(classifyByRules("rename the secrets file", cfg).risk).toBe("high");
  });

  it("scope: repo phrasing, breadth, single", () => {
    expect(classifyByRules("rename x across the repo", cfg).scope).toBe("repo");
    expect(classifyByRules("rename x in a.ts", cfg).scope).toBe("single");
    expect(classifyByRules("rename x in a.ts then b.ts", cfg).scope).toBe("multi");
    expect(classifyByRules("do not touch the whole repo, rename x in a.ts", cfg).scope).toBe("single");
  });

  it("risk floor: repo-wide edits, external edits and network need at least medium", () => {
    expect(classifyByRules("rename x across the repo", cfg).risk).toBe("medium");
    expect(classifyByRules("git push the branch", cfg).risk).toBe("medium");
    expect(classifyByRules("grep for foo", cfg).risk).toBe("low");
  });
});

describe("language gate (R13)", () => {
  it("Portuguese: class still found, confidence capped at 0.5", () => {
    const text = "Faça o refactor do arquivo config.ts para que a validação use a nova função";
    const analysis = analyzeRules(text, cfg);
    expect(analysis.nonEnglish).toBe(true);
    expect(analysis.facts.class).toBe("implement");
    expect(analysis.facts.confidence).toBe(0.5);
  });

  it("a mostly non-ASCII text is non-English", () => {
    expect(analyzeRules("Реализуйте разбор конфигурационного файла проекта", cfg).nonEnglish).toBe(true);
  });

  it("short and plain English texts are English", () => {
    expect(analyzeRules("grep for classifyTrivial in src", cfg).nonEnglish).toBe(false);
    expect(
      analyzeRules("Review src/router/config.ts for validation gaps. Do not refactor anything.", cfg).nonEnglish,
    ).toBe(false);
  });
});

describe("determinism and budget (R14)", () => {
  it("the same input twice gives deep-equal output", () => {
    const text = "refactor the parser, then run vitest. Working directory: D:\\git\\repo";
    expect(analyzeRules(text, cfg)).toEqual(analyzeRules(text, cfg));
  });

  it("the facts are frozen values", () => {
    const facts = classifyByRules("rename x in a.ts", cfg);
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.needs)).toBe(true);
  });

  it("non-string input does not throw", () => {
    expect(classifyByRules(undefined as unknown as string, cfg).class).toBe("other");
    expect(classifyByRules(null as unknown as string, cfg).class).toBe("other");
  });

  const bestOf = (runs: number, fn: () => void): number => {
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  };

  it("a 2 kB prompt takes under 1 ms (warm, best of 20)", () => {
    const chunk = "Please implement the parser in src/a.ts and add support for the new option. ";
    const text = chunk.repeat(Math.ceil(2000 / chunk.length)).slice(0, 2000);
    classifyByRules(text, cfg);
    expect(bestOf(20, () => classifyByRules(text, cfg))).toBeLessThan(1);
  });

  it("a 10 kB prompt takes under 5 ms (warm, best of 10), deterministically", () => {
    const chunk = "Please implement the parser in src/a.ts, then review the output. TASK: details here.\n";
    const text = chunk.repeat(Math.ceil(10_000 / chunk.length)).slice(0, 10_000);
    const first = classifyByRules(text, cfg);
    expect(bestOf(10, () => classifyByRules(text, cfg))).toBeLessThan(5);
    expect(classifyByRules(text, cfg)).toEqual(first);
  });

  it("empty, whitespace and 100 kB inputs are handled (the rules read at most 20 000 chars)", () => {
    expect(classifyByRules("", cfg).confidence).toBe(0.2);
    const huge = "x ".repeat(50_000);
    expect(classifyByRules(huge, cfg).class).toBe("other");
  });
});

describe("destructive operations are high risk (QA-1.2-3)", () => {
  const destructive: readonly string[] = [
    "rm -rf node_modules",
    "rm -r build",
    "rm -f package-lock.json",
    "Remove-Item -Recurse -Force .\\dist",
    "git push origin main --force",
    "git push -f origin main",
    "git clean -fdx",
    "git checkout .",
    "git restore .",
    "git checkout -- .",
    "git rebase main",
    "git filter-repo --path secrets.txt",
    "git filter-branch --tree-filter x",
    "git branch -D old-feature",
    "commit with --no-verify",
    "delete from users where id = 1",
    "truncate table logs",
    "drop the users table",
    "drop table users",
    "drop the legacy column",
    "unpublish the package",
    "update the .env file",
    "rotate the ssh keys",
    "regenerate the private key",
    "export GITHUB_TOKEN before running",
    "set NPM_TOKEN in CI",
    "terraform destroy the staging stack",
    "kubectl delete the namespace",
  ];

  it.each(destructive)("%s -> risk high", (text) => {
    expect(classifyByRules(text, cfg).risk).toBe("high");
  });

  it.each(destructive)("a mechanical edit that also does '%s' is never low-risk, nor 0.8 confident", (text) => {
    const facts = classifyByRules(`rename foo to bar in src/a.ts and ${text}`, cfg);
    expect(facts.risk).toBe("high");
    if (facts.class === "mechanical") expect(facts.confidence).toBeLessThanOrEqual(0.5);
    expect(facts.class === "mechanical" && facts.risk === "low" && facts.confidence === 0.8).toBe(false);
  });

  it("negation does not hide a destructive term", () => {
    expect(classifyByRules("rename foo to bar; do not rm -rf anything", cfg).risk).toBe("high");
  });

  it("controls: ordinary uses stay low risk", () => {
    for (const text of [
      "list the files in src",
      "read process.env.NODE_ENV in a.ts",
      "git checkout .gitignore",
      "rename foo to bar in src/a.ts",
      "git status",
      "delete the unused import",
    ]) {
      expect(classifyByRules(text, cfg).risk, text).not.toBe("high");
    }
  });

  it("a column rename or an alter is at least medium", () => {
    for (const text of ["rename the column user_name to username", "rename column a to b in the users table", "alter the lookup order"]) {
      expect(classifyByRules(text, cfg).risk, text).not.toBe("low");
    }
    const facts = classifyByRules("rename the column user_name to username", cfg);
    expect(facts.class).toBe("mechanical");
    expect(facts.risk).toBe("medium");
  });
});
describe("risk scans the whole body; excluded sections end at a blank line (QA-1.2-4)", () => {
  it("CONTEXT that names production, billing or credentials still raises risk", () => {
    const text = [
      "TASK: rename getFoo to fetchFoo in src/a.ts",
      "CONTEXT: this service runs in production billing and handles credentials",
    ].join("\n");
    const analysis = analyzeRules(text, cfg);
    expect(analysis.templated).toBe(true);
    expect(analysis.facts.class).toBe("mechanical");
    expect(analysis.facts.risk).toBe("high");
    expect(analysis.facts.confidence).toBe(0.5);
  });

  it("text after the blank line that ends ENVIRONMENT is task text again", () => {
    const text = [
      "TASK: rename getFoo to fetchFoo in src/a.ts",
      "ENVIRONMENT: Platform: win32",
      "Shell: pwsh",
      "",
      "then deploy it to production and refactor the module",
    ].join("\n");
    const facts = classifyByRules(text, cfg);
    expect(facts.risk).toBe("high");
    expect(facts.class).toBe("implement"); // the refactor after the blank line counts
  });

  it("a TOOLS line followed by task text: risk is high even though the class stays with TASK", () => {
    const glued = [
      "TASK: report the current state",
      "TOOLS: read/search/write",
      "refactor the auth module and deploy it to production",
    ].join("\n");
    expect(classifyByRules(glued, cfg).risk).toBe("high");
    const separated = [
      "TASK: report the current state",
      "TOOLS: read/search/write",
      "",
      "refactor the auth module and deploy it to production",
    ].join("\n");
    const facts = classifyByRules(separated, cfg);
    expect(facts.risk).toBe("high");
    expect(facts.class).toBe("implement");
  });

  it("an excluded section's own paragraph still never feeds the class or the needs", () => {
    const text = [
      "TASK: list the exports of src/a.ts",
      "TOOLS: read, grep, refactor",
      "ENVIRONMENT: Shell: pwsh",
    ].join("\n");
    const facts = classifyByRules(text, cfg);
    expect(facts.class).toBe("search");
    expect(facts.needs).not.toContain("shell");
  });
});
describe("needs are path-aware (QA-1.2-5)", () => {
  const needsOf = (text: string): readonly Need[] => classifyByRules(text, cfg).needs;

  it("a path segment named like a tool is not that tool", () => {
    for (const text of [
      "list D:\\git\\repo",
      "list D:\\git\\repo\\src\\a.ts",
      "list ~/git/x",
      "read .github/workflows/ci.yml",
      "read src/git/hooks.ts",
      "read packages/npm/index.js",
      "read docker/compose.yml",
      "read C:\\tools\\bash\\notes.txt",
      "read git.exe",
    ]) {
      expect(needsOf(text), text).not.toContain("shell");
    }
  });

  it("the tools themselves are still a shell need", () => {
    for (const text of [
      "git status",
      "run git log -3",
      "run npm test",
      "docker compose up",
      "docker-compose up",
      "use bash to list the files",
      "rg foo src",
      "run the tests with vitest",
    ]) {
      expect(needsOf(text), text).toContain("shell");
    }
  });

  it("a tool named next to a path still counts", () => {
    expect(needsOf("git diff D:\\git\\repo\\src\\a.ts")).toContain("shell");
    expect(needsOf("cd ~/git/x && npm test")).toContain("shell");
  });

  it("verbs inside a slash list are not needs: 'read/search/write' is a list of tools", () => {
    expect(needsOf("tools: read/search/write")).not.toContain("edit");
  });

  it("URLs keep their web need; external_dir still reads paths", () => {
    expect(needsOf("fetch https://example.com/git/docs")).toEqual(["web"]);
    const facts = classifyByRules("write the log to C:\\Users\\me\\git\\x.log", cfg, { cwd: "D:\\work\\repo" });
    expect(facts.needs).toEqual(["edit", "external_dir"]);
    expect(classifyByRules("open ~/notes.txt", cfg).needs).toEqual(["external_dir"]);
  });
});