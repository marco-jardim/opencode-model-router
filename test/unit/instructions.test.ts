import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateConfig, type RouterConfig } from "../../src/router/config";
import { stripDelegateInstructions, type InstructionFileReader } from "../../src/router/instructions";

const cfg: RouterConfig = {
  activePreset: "test",
  presets: { test: { fast: { model: "test/model" } } },
  rules: [],
  defaultTier: "fast",
};
const globalBlock = "Instructions from: C:\\Users\\user\\CLAUDE.md\nDelegate everything";
const localBlock = "Instructions from: D:\\git\\proj\\AGENTS.md\nCoding conventions";

/** Stub reader serving each block's embedded body as the contents of its marker path. */
function readerFor(...blocks: string[]): InstructionFileReader {
  const files = new Map<string, string>();
  for (const block of blocks) {
    const newline = block.indexOf("\n");
    files.set(block.slice("Instructions from: ".length, newline).trim(), block.slice(newline + 1));
  }
  return (path) => files.get(path);
}

describe("stripDelegateInstructions", () => {
  it("keep leaves the array and all contents identical", () => {
    const system = ["provider", globalBlock, localBlock, "unrelated"];
    const output = { system };
    stripDelegateInstructions(output, { ...cfg, delegateInstructions: "keep" }, "D:/git/proj");
    expect(output.system).toBe(system);
    expect(output.system).toEqual(["provider", globalBlock, localBlock, "unrelated"]);
  });

  it("removes standalone global entries but preserves unrelated entries", () => {
    const output = { system: ["provider", globalBlock, "unrelated"] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", readerFor(globalBlock));
    expect(output.system).toEqual(["provider", "unrelated"]);
  });

  it.each(["\n", "\r\n"])("filters embedded sections preserving surrounding retained text (%j)", (newline) => {
    const output = { system: [["provider", globalBlock, localBlock].join("\n").replace(/\n/g, newline)] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", readerFor(globalBlock, localBlock));
    expect(output.system).toEqual([`provider${newline}${localBlock.replace(/\n/g, newline)}`]);
  });

  it("strip-global keeps local blocks and removes outside blocks", () => {
    const output = { system: [globalBlock, localBlock] };
    stripDelegateInstructions(
      output,
      { ...cfg, delegateInstructions: "strip-global" },
      "D:/git/proj",
      readerFor(globalBlock, localBlock),
    );
    expect(output.system).toEqual([localBlock]);
  });

  it("strip-all removes local and global blocks and whitespace-only remnants", () => {
    const output = { system: [globalBlock, localBlock, ` \n${localBlock}`, "provider"] };
    stripDelegateInstructions(
      output,
      { ...cfg, delegateInstructions: "strip-all" },
      "D:/git/proj",
      readerFor(globalBlock, localBlock),
    );
    expect(output.system).toEqual(["provider"]);
  });

  it.each(["d:/GIT/PROJ", "D:\\git\\proj\\"])("normalizes case and separators (%s)", (project) => {
    const output = { system: [localBlock] };
    stripDelegateInstructions(output, cfg, project);
    expect(output.system).toEqual([localBlock]);
  });

  it("does not treat a sibling sharing the project prefix as local", () => {
    const sibling = "Instructions from: D:\\git\\project-other\\AGENTS.md\nOther";
    const output = { system: [sibling] };
    stripDelegateInstructions(output, cfg, "D:\\git\\project", readerFor(sibling));
    expect(output.system).toEqual([]);
  });

  it.each([undefined, ""])("strips all blocks without a project (%j)", (project) => {
    const output = { system: [globalBlock, localBlock] };
    stripDelegateInstructions(output, cfg, project, readerFor(globalBlock, localBlock));
    expect(output.system).toEqual([]);
  });

  it("leaves empty and pathless malformed entries alone without throwing", () => {
    const system = ["", "Instructions from: ", "Instructions from:\nnot a path"];
    const output = { system: [...system] };
    expect(() => stripDelegateInstructions(output, cfg, undefined)).not.toThrow();
    expect(output.system).toEqual(system);
  });
});

describe("delegateInstructions config validation", () => {
  it.each([undefined, "keep", "strip-global", "strip-all"])("accepts %j", (policy) => {
    expect(() => validateConfig({ ...cfg, delegateInstructions: policy })).not.toThrow();
  });
  it.each([null, "strip", "", true, 1, {}, []])("rejects %j", (policy) => {
    expect(() => validateConfig({ ...cfg, delegateInstructions: policy })).toThrow(
      "tiers.json: 'delegateInstructions' must be one of strip-global|strip-all|keep",
    );
  });
});

describe("stripDelegateInstructions trailing-slash normalization (js/polynomial-redos)", () => {
  const globalSlashes = "Instructions from: C:\\Users\\user\\\\\\\nDelegate everything";
  const localSlashes = "Instructions from: D:/git/proj/sub///\nCoding conventions";
  const projectRootSlashes = "Instructions from: D:\\git\\proj\\\\\\\nRoot conventions";
  const slashReader = readerFor(globalSlashes, localSlashes, projectRootSlashes);

  it.each([
    ["strip-global", [localSlashes, projectRootSlashes]],
    ["strip-all", []],
  ] as const)("matches paths with several trailing slashes under %s", (policy, expected) => {
    for (const project of ["D:/git/proj", "D:\\git\\proj\\\\\\", "D:/git/proj///"]) {
      const output = { system: [globalSlashes, localSlashes, projectRootSlashes] };
      stripDelegateInstructions(output, { ...cfg, delegateInstructions: policy }, project, slashReader);
      expect(output.system).toEqual(expected);
    }
  });

  it.each(["strip-global", "strip-all"] as const)(
    "does not treat a sibling sharing the project prefix as local with trailing slashes (%s)",
    (policy) => {
      const sibling = "Instructions from: D:\\git\\project-other\\\\\\\nOther";
      const output = { system: [sibling] };
      stripDelegateInstructions(
        output,
        { ...cfg, delegateInstructions: policy },
        "D:/git/project///",
        readerFor(sibling),
      );
      expect(output.system).toEqual([]);
    },
  );

  it.each(["", "x"])("handles a 50k-slash marker path in linear time (suffix %j)", (suffix) => {
    const block = `Instructions from: ${"/".repeat(50_000)}${suffix}\nBody`;
    const output = { system: [`provider\n${block}`] };
    const reader = readerFor(block);
    const started = Date.now();
    stripDelegateInstructions(output, cfg, `D:/git/proj${"/".repeat(50_000)}`, reader);
    const elapsed = Date.now() - started;
    expect(output.system).toEqual(["provider\n"]);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("stripDelegateInstructions bounded removal in the joined runtime blob", () => {
  const claudePath = "C:\\Users\\user\\CLAUDE.md";
  const agentsPath = "C:\\Users\\user\\AGENTS.md";
  const claude = "# Persona\nDelegate everything via Task.\n";
  const agents = "Global agent rules.\n";
  const mcp = "<mcp_instructions>\n  server docs\n</mcp_instructions>";
  const reader: InstructionFileReader = (path) =>
    path === claudePath ? claude : path === agentsPath ? agents : undefined;

  /** Mirrors the host: agent prompt, instruction blocks and trailing text joined into one string. */
  const blob = (newline: string, ...parts: string[]): string => parts.join("\n").replace(/\n/g, newline);

  it.each(["\n", "\r\n"])("removes only the file's own text and keeps trailing content (%j)", (newline) => {
    const entry = blob(newline, "provider text", `Instructions from: ${claudePath}\n${claude}`, mcp);
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", reader);
    expect(output.system).toEqual([blob(newline, "provider text", "", mcp)]);
    expect(output.system[0]).toContain("</mcp_instructions>");
    expect(output.system[0]).not.toContain("Delegate everything");
  });

  it("bounds consecutive blocks and keeps a local block and trailing text", () => {
    const entry = blob(
      "\n",
      "provider text",
      `Instructions from: ${agentsPath}\n${agents}`,
      `Instructions from: ${claudePath}\n${claude}`,
      localBlock,
      mcp,
    );
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", reader);
    expect(output.system).toEqual([blob("\n", "provider text", localBlock, mcp)]);
  });

  it("mutates the same array object instead of replacing it", () => {
    const system = [blob("\n", "provider text", `Instructions from: ${claudePath}\n${claude}`, mcp)];
    const output = { system };
    stripDelegateInstructions(output, cfg, "D:/git/proj", reader);
    expect(output.system).toBe(system);
    expect(system).toEqual([blob("\n", "provider text", "", mcp)]);
  });

  it("the host's retained reference observes a fully removed entry", () => {
    const hostReference = ["provider", `Instructions from: ${claudePath}\n${claude}`, "unrelated"];
    stripDelegateInstructions({ system: hostReference }, cfg, "D:/git/proj", reader);
    expect(hostReference).toEqual(["provider", "unrelated"]);
  });

  it("leaves the section untouched when the instruction path is unreadable", () => {
    const entry = blob("\n", "provider text", `Instructions from: C:\\missing\\CLAUDE.md\n${claude}`, mcp);
    const system = [entry];
    const output = { system };
    stripDelegateInstructions(output, cfg, "D:/git/proj", () => undefined);
    expect(output.system).toBe(system);
    expect(output.system).toEqual([entry]);
  });

  it("leaves the section untouched when the reader throws", () => {
    const entry = blob("\n", "provider text", `Instructions from: ${claudePath}\n${claude}`, mcp);
    const output = { system: [entry] };
    const throwing: InstructionFileReader = () => {
      throw new Error("EACCES");
    };
    expect(() => stripDelegateInstructions(output, cfg, "D:/git/proj", throwing)).not.toThrow();
    expect(output.system).toEqual([entry]);
  });

  it("leaves the section untouched when disk contents do not match the prompt", () => {
    const entry = blob("\n", "provider text", `Instructions from: ${claudePath}\n${claude}`, mcp);
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", () => "# Persona\nEdited since injection.\n");
    expect(output.system).toEqual([entry]);
  });

  it("keeps a mismatched section even when a following marker bounds it", () => {
    const entry = blob(
      "\n",
      `Instructions from: ${agentsPath}\nStale text`,
      `Instructions from: ${claudePath}\n${claude}`,
      mcp,
    );
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", reader);
    expect(output.system).toEqual([blob("\n", `Instructions from: ${agentsPath}\nStale text`, "", mcp)]);
  });

  it("matches contents that differ from the prompt only by trailing whitespace", () => {
    const entry = blob("\n", "provider text", `Instructions from: ${claudePath}\n# Persona`, mcp);
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, "D:/git/proj", () => "# Persona  \n\n");
    expect(output.system).toEqual([blob("\n", "provider text", "", mcp)]);
  });
});

describe("stripDelegateInstructions default filesystem reader", () => {
  let dir: string;

  beforeEach(() => {
    const root = join(tmpdir(), "opencode");
    mkdirSync(root, { recursive: true });
    dir = mkdtempSync(join(root, "instructions-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it("reads the named file and removes exactly its contents", () => {
    const file = join(dir, "CLAUDE.md");
    const contents = "# Persona\nDelegate everything via Task.\n";
    writeFileSync(file, contents);
    const trailing = "<mcp_instructions>\nkeep me\n</mcp_instructions>";
    const output = { system: [`provider\nInstructions from: ${file}\n${contents}\n${trailing}`] };
    stripDelegateInstructions(output, cfg, undefined);
    expect(output.system).toEqual([`provider\n\n${trailing}`]);
  });

  it("revalidates cached contents against the file's modification time", () => {
    const file = join(dir, "AGENTS.md");
    const trailing = "trailing system text";
    const entryFor = (body: string): string => `Instructions from: ${file}\n${body}\n${trailing}`;

    // Same length on purpose: only the mtime can reveal the change.
    writeFileSync(file, "Version one.\n");
    const first = { system: [entryFor("Version one.")] };
    stripDelegateInstructions(first, cfg, undefined);
    expect(first.system).toEqual([trailing]);

    writeFileSync(file, "Version two.\n");
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);
    const stale = { system: [entryFor("Version one.")] };
    stripDelegateInstructions(stale, cfg, undefined);
    expect(stale.system).toEqual([entryFor("Version one.")]);
    const fresh = { system: [entryFor("Version two.")] };
    stripDelegateInstructions(fresh, cfg, undefined);
    expect(fresh.system).toEqual([trailing]);
  });

  it("keeps a section whose file does not exist", () => {
    const entry = `provider\nInstructions from: ${join(dir, "missing.md")}\nBody\ntrailing`;
    const output = { system: [entry] };
    stripDelegateInstructions(output, cfg, undefined);
    expect(output.system).toEqual([entry]);
  });
});
