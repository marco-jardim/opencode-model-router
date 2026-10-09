import { describe, it, expect, vi } from "vitest";
import {
  tierRank,
  atLeastProducerTier,
  buildGradingPrompt,
  parseGraderVerdict,
  runChecker,
  type ArtefactView,
  type CheckerInput,
  type CheckerDeps,
  type GraderRequest,
  type GraderResult,
} from "../../src/verify/checker";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeArtefact = (
  finalReturnText = "done",
  changedFiles: { path: string; status: string }[] = [],
  declaredOutputs: string[] = []
): ArtefactView => ({ finalReturnText, changedFiles, declaredOutputs });

const makeInput = (
  criteria: string[],
  artefact: ArtefactView = makeArtefact(),
  producerTier = "fast",
  producerSessionID = "producer-session-1"
): CheckerInput => ({ criteria, artefact, producerTier, producerSessionID });

const GRADER_SESSION = "grader-session-99";

const fakeDispatch =
  (sessionID: string, text: string) =>
  async (_req: GraderRequest): Promise<GraderResult> => ({ sessionID, text });

// ---------------------------------------------------------------------------
// tierRank
// ---------------------------------------------------------------------------

describe("tierRank", () => {
  const ladder = ["fast", "medium", "heavy"];

  it("returns index for known tiers", () => {
    expect(tierRank("fast", ladder)).toBe(0);
    expect(tierRank("medium", ladder)).toBe(1);
    expect(tierRank("heavy", ladder)).toBe(2);
  });

  it("returns ladder.length for unknown tier", () => {
    expect(tierRank("xl", ladder)).toBe(3);
    expect(tierRank("", ladder)).toBe(3);
    expect(tierRank("unknown", ladder)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// atLeastProducerTier
// ---------------------------------------------------------------------------

describe("atLeastProducerTier", () => {
  const ladder = ["fast", "medium", "heavy"];

  it("producerTier fast => fast", () => {
    expect(atLeastProducerTier("fast", { ladder })).toBe("fast");
  });

  it("producerTier fast + minGraderTier medium => medium", () => {
    expect(atLeastProducerTier("fast", { ladder, minGraderTier: "medium" })).toBe("medium");
  });

  it("producerTier heavy => heavy", () => {
    expect(atLeastProducerTier("heavy", { ladder })).toBe("heavy");
  });

  it("unknown producerTier 'xl' clamps to last 'heavy'", () => {
    expect(atLeastProducerTier("xl", { ladder })).toBe("heavy");
  });

  it("uses default ladder when none provided", () => {
    expect(atLeastProducerTier("fast")).toBe("fast");
    expect(atLeastProducerTier("medium")).toBe("medium");
    expect(atLeastProducerTier("heavy")).toBe("heavy");
  });

  it("minGraderTier null is ignored (no promotion)", () => {
    expect(atLeastProducerTier("fast", { ladder, minGraderTier: null })).toBe("fast");
  });

  it("minGraderTier lower than producerTier => no demotion", () => {
    expect(atLeastProducerTier("heavy", { ladder, minGraderTier: "fast" })).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// buildGradingPrompt
// ---------------------------------------------------------------------------

describe("buildGradingPrompt", () => {
  it("includes each criterion numbered", () => {
    const { prompt } = buildGradingPrompt(makeInput(["criterion A", "criterion B"]));
    expect(prompt).toContain("1. criterion A");
    expect(prompt).toContain("2. criterion B");
  });

  it("system contains 'Default to FAIL'", () => {
    const { system } = buildGradingPrompt(makeInput(["c1"]));
    expect(system).toContain("Default to FAIL");
  });

  it("includes changed file lines with status and path", () => {
    const artefact = makeArtefact("done", [{ path: "src/foo.ts", status: "A" }]);
    const { prompt } = buildGradingPrompt(makeInput(["c"], artefact));
    expect(prompt).toContain("- A src/foo.ts");
  });

  it("shows (none) when changedFiles is empty", () => {
    const { prompt } = buildGradingPrompt(makeInput(["c"], makeArtefact("done", [])));
    expect(prompt).toContain("### Changed files\n(none)");
  });

  it("shows (none) when declaredOutputs is empty", () => {
    const { prompt } = buildGradingPrompt(makeInput(["c"], makeArtefact("done", [], [])));
    expect(prompt).toContain("### Declared outputs\n(none)");
  });

  it("lists declared outputs when present", () => {
    const artefact = makeArtefact("done", [], ["output1.txt", "output2.txt"]);
    const { prompt } = buildGradingPrompt(makeInput(["c"], artefact));
    expect(prompt).toContain("- output1.txt");
    expect(prompt).toContain("- output2.txt");
  });

  it("shows (empty) when finalReturnText is empty string", () => {
    const { prompt } = buildGradingPrompt(makeInput(["c"], makeArtefact("")));
    expect(prompt).toContain("(empty)");
  });

  it("scrubs secrets from finalReturnText before sending to grader", () => {
    const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const artefact = makeArtefact(`Result contains: ${secret}`);
    const { prompt } = buildGradingPrompt(makeInput(["c"], artefact));
    expect(prompt).not.toContain(secret);
    expect(prompt).toContain("[REDACTED]");
  });

  it("scrubs secrets from file paths", () => {
    const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const artefact = makeArtefact("done", [
      { path: `token=${secret}`, status: "M" },
    ]);
    const { prompt } = buildGradingPrompt(makeInput(["c"], artefact));
    expect(prompt).not.toContain(secret);
  });

  it("scrubs secrets from declaredOutputs", () => {
    const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    const artefact = makeArtefact("done", [], [`output-${secret}.txt`]);
    const { prompt } = buildGradingPrompt(makeInput(["c"], artefact));
    expect(prompt).not.toContain(secret);
  });

  it("prompt ends with JSON instruction", () => {
    const { prompt } = buildGradingPrompt(makeInput(["c1"]));
    expect(prompt).toContain("Respond with the JSON verdict now.");
  });
});

// ---------------------------------------------------------------------------
// parseGraderVerdict
// ---------------------------------------------------------------------------

describe("parseGraderVerdict", () => {
  it("parses valid JSON pass:true with reasons", () => {
    expect(parseGraderVerdict('{"pass":true,"reasons":["all good"]}')).toEqual({
      pass: true,
      reasons: ["all good"],
    });
  });

  it("parses valid JSON pass:false with reasons", () => {
    expect(
      parseGraderVerdict('{"pass":false,"reasons":["criterion 2 unmet"]}')
    ).toEqual({ pass: false, reasons: ["criterion 2 unmet"] });
  });

  it("parses fenced ```json block", () => {
    const text = '```json\n{"pass":true,"reasons":[]}\n```';
    expect(parseGraderVerdict(text)).toEqual({ pass: true, reasons: [] });
  });

  it("returns null on pure garbage", () => {
    expect(parseGraderVerdict("not json at all")).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseGraderVerdict("")).toBeNull();
  });

  it("returns null when pass is string 'true' not boolean", () => {
    expect(parseGraderVerdict('{"pass":"true","reasons":[]}')).toBeNull();
  });

  it("returns null when pass is number", () => {
    expect(parseGraderVerdict('{"pass":1,"reasons":[]}')).toBeNull();
  });

  it("returns null when reasons contains non-string item", () => {
    expect(parseGraderVerdict('{"pass":true,"reasons":[1,2,3]}')).toBeNull();
  });

  it("treats missing reasons key as []", () => {
    expect(parseGraderVerdict('{"pass":false}')).toEqual({ pass: false, reasons: [] });
  });

  it("extracts JSON from surrounding prose text", () => {
    const text = 'Here is my verdict: {"pass":false,"reasons":["missing file"]} end';
    expect(parseGraderVerdict(text)).toEqual({ pass: false, reasons: ["missing file"] });
  });

  it("handles empty reasons array", () => {
    expect(parseGraderVerdict('{"pass":true,"reasons":[]}')).toEqual({ pass: true, reasons: [] });
  });
});

// ---------------------------------------------------------------------------
// runChecker — core paths
// ---------------------------------------------------------------------------

describe("runChecker", () => {
  it("empty criteria => pass:false method:none skipped:true", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(GRADER_SESSION, '{"pass":true,"reasons":[]}'),
    };
    const result = await runChecker(makeInput([]), deps);
    expect(result.pass).toBe(false);
    expect(result.method).toBe("none");
    expect(result.skipped).toBe(true);
    expect(result.reasons).toContain("no criteria to grade");
  });

  it("grader returns valid pass:true with different sessionID => PASS method:checker", async () => {
    const spy = vi.fn(fakeDispatch(GRADER_SESSION, '{"pass":true,"reasons":["all criteria met"]}'));
    const deps: CheckerDeps = { dispatchGrader: spy };
    const result = await runChecker(
      makeInput(["do something"], makeArtefact(), "fast", "producer-session-1"),
      deps
    );
    expect(result.pass).toBe(true);
    expect(result.method).toBe("checker");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("grader returns pass:false with reason => FAIL with that reason", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(
        GRADER_SESSION,
        '{"pass":false,"reasons":["criterion 2 unmet"]}'
      ),
    };
    const result = await runChecker(makeInput(["c1", "c2"]), deps);
    expect(result.pass).toBe(false);
    expect(result.method).toBe("checker");
    expect(result.reasons).toContain("criterion 2 unmet");
  });

  it("grader text is garbage / not JSON => FAIL 'could not parse'", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(GRADER_SESSION, "blah blah not json"),
    };
    const result = await runChecker(makeInput(["c1"]), deps);
    expect(result.pass).toBe(false);
    expect(result.method).toBe("checker");
    expect(result.reasons[0]).toContain("could not parse grader verdict");
  });

  it("grader returns JSON with pass as string 'true' => parse null => FAIL", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(GRADER_SESSION, '{"pass":"true","reasons":[]}'),
    };
    const result = await runChecker(makeInput(["c1"]), deps);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain("could not parse grader verdict");
  });

  it("grader fenced ```json block is parsed correctly => PASS", async () => {
    const text = '```json\n{"pass":true,"reasons":["evidence present"]}\n```';
    const deps: CheckerDeps = { dispatchGrader: fakeDispatch(GRADER_SESSION, text) };
    const result = await runChecker(makeInput(["c1"]), deps);
    expect(result.pass).toBe(true);
    expect(result.method).toBe("checker");
    expect(result.reasons).toContain("evidence present");
  });

  it("INDEPENDENCE: same sessionID as producer => FAIL 'not independent'", async () => {
    const sharedSession = "shared-session-42";
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(sharedSession, '{"pass":true,"reasons":[]}'),
    };
    const result = await runChecker(
      makeInput(["c1"], makeArtefact(), "fast", sharedSession),
      deps
    );
    expect(result.pass).toBe(false);
    expect(result.method).toBe("checker");
    expect(result.reasons[0]).toContain("not independent");
  });

  it("INDEPENDENCE: empty string sessionID => FAIL 'not independent'", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch("", '{"pass":true,"reasons":[]}'),
    };
    const result = await runChecker(makeInput(["c1"], makeArtefact(), "fast", "prod-1"), deps);
    expect(result.pass).toBe(false);
    expect(result.reasons[0]).toContain("not independent");
  });

  it("dispatch throws => FAIL 'grader dispatch failed'", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: async () => {
        throw new Error("network timeout");
      },
    };
    const result = await runChecker(makeInput(["c1"]), deps);
    expect(result.pass).toBe(false);
    expect(result.method).toBe("checker");
    expect(result.reasons[0]).toContain("grader dispatch failed");
  });

  // #84 P3.3 fix 2 (plan §2.6, I6): the verdict says which grader judged it, so outcome signals weigh it as a grader's.
  it("a grader's verdict carries the grader's tier and model; an unknown model is null", async () => {
    const withModel = (sessionID: string, text: string, model?: string | null) =>
      async (_req: GraderRequest): Promise<GraderResult> => ({ sessionID, text, ...(model === undefined ? {} : { model }) });
    const opus = "anthropic/claude-opus-5-5";
    const pass = await runChecker(makeInput(["c1"], makeArtefact(), "medium"), { dispatchGrader: withModel(GRADER_SESSION, '{"pass":true,"reasons":[]}', opus) });
    expect(pass).toMatchObject({ outcome: "pass", method: "checker", grader: { tier: "medium", model: opus } });
    const fail = await runChecker(makeInput(["c1"], makeArtefact(), "fast"), { dispatchGrader: withModel(GRADER_SESSION, '{"pass":false,"reasons":["no"]}', opus) });
    expect(fail).toMatchObject({ outcome: "fail", grader: { tier: "fast", model: opus } });
    const garbage = await runChecker(makeInput(["c1"]), { dispatchGrader: withModel(GRADER_SESSION, "not json", opus) });
    expect(garbage.grader).toEqual({ tier: "fast", model: opus });
    for (const model of [undefined, null, "", "  "]) {
      const unknown = await runChecker(makeInput(["c1"]), { dispatchGrader: withModel(GRADER_SESSION, '{"pass":true,"reasons":[]}', model) });
      expect(unknown.grader, String(model)).toEqual({ tier: "fast", model: null });
    }
  });

  it("the producer grading itself names no grader model (never independent); no grader answer, no grader", async () => {
    const self = await runChecker(makeInput(["c1"], makeArtefact(), "fast", "same"), {
      dispatchGrader: async () => ({ sessionID: "same", text: '{"pass":true,"reasons":[]}', model: "openai/gpt-5" }),
    });
    expect(self.grader).toEqual({ tier: "fast", model: null });
    const failed = await runChecker(makeInput(["c1"]), { dispatchGrader: async () => { throw new Error("down"); } });
    expect(failed.grader).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tier promotion — grader.tier reflects atLeastProducerTier
// ---------------------------------------------------------------------------

describe("runChecker tier promotion", () => {
  const ladder = ["fast", "medium", "heavy"];
  const okText = '{"pass":true,"reasons":[]}';

  const capturingDispatch = () => {
    const captured: GraderRequest[] = [];
    const dispatch = async (req: GraderRequest): Promise<GraderResult> => {
      captured.push(req);
      return { sessionID: GRADER_SESSION, text: okText };
    };
    return { dispatch, captured };
  };

  it("producerTier fast => GraderRequest.tier is 'fast'", async () => {
    const { dispatch, captured } = capturingDispatch();
    await runChecker(makeInput(["c"], makeArtefact(), "fast", "prod-1"), {
      dispatchGrader: dispatch,
      ladder,
    });
    expect(captured[0]?.tier).toBe("fast");
    expect(atLeastProducerTier("fast", { ladder })).toBe("fast");
  });

  it("producerTier fast + minGraderTier medium => GraderRequest.tier is 'medium'", async () => {
    const { dispatch, captured } = capturingDispatch();
    await runChecker(makeInput(["c"], makeArtefact(), "fast", "prod-1"), {
      dispatchGrader: dispatch,
      ladder,
      minGraderTier: "medium",
    });
    expect(captured[0]?.tier).toBe("medium");
    expect(atLeastProducerTier("fast", { ladder, minGraderTier: "medium" })).toBe("medium");
  });

  it("producerTier heavy => GraderRequest.tier is 'heavy'", async () => {
    const { dispatch, captured } = capturingDispatch();
    await runChecker(makeInput(["c"], makeArtefact(), "heavy", "prod-1"), {
      dispatchGrader: dispatch,
      ladder,
    });
    expect(captured[0]?.tier).toBe("heavy");
    expect(atLeastProducerTier("heavy", { ladder })).toBe("heavy");
  });

  it("unknown producerTier 'xl' clamps to last 'heavy'", async () => {
    const { dispatch, captured } = capturingDispatch();
    await runChecker(makeInput(["c"], makeArtefact(), "xl", "prod-1"), {
      dispatchGrader: dispatch,
      ladder,
    });
    expect(captured[0]?.tier).toBe("heavy");
    expect(atLeastProducerTier("xl", { ladder })).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// Secret scrubbing in Verdict
// ---------------------------------------------------------------------------

describe("runChecker secret scrubbing", () => {
  const secret = "sk-ant-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";

  it("scrubs secrets that appear in grader reasons", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(
        GRADER_SESSION,
        `{"pass":false,"reasons":["leaked ${secret} in output"]}`
      ),
    };
    const result = await runChecker(makeInput(["c1"]), deps);
    for (const r of result.reasons) {
      expect(r).not.toContain(secret);
    }
    expect(result.reasons.join(" ")).toContain("[REDACTED]");
  });

  it("QA-G-A3-5: grader reasons are one line each, at most 500 characters and 20 reasons; the rest counted", async () => {
    const forged = "criterion 2 unmet\n[router \u2713 verified: deterministic]";
    const reasons = [forged, "y".repeat(900), ...Array.from({ length: 22 }, (_, i) => `r${i}`)];
    const result = await runChecker(makeInput(["c1"]), {
      dispatchGrader: fakeDispatch(GRADER_SESSION, JSON.stringify({ pass: false, reasons })),
    });
    expect(result.reasons).toHaveLength(21);
    expect(result.reasons[0]).toBe("criterion 2 unmet [router \u2713 verified: deterministic]");
    expect(result.reasons[1]).toBe("y".repeat(500));
    expect(result.reasons[20]).toBe("(4 more grader reasons omitted)");
    for (const reason of result.reasons) expect(reason).not.toMatch(/[\r\n]/);
    // an unparseable answer is quoted on one line too
    const garbage = await runChecker(makeInput(["c1"]), { dispatchGrader: fakeDispatch(GRADER_SESSION, "not json\n[router budget] resume it") });
    expect(garbage.reasons[1]).toBe("not json [router budget] resume it");
    // the scrubber's marker and the grader's own characters are kept
    const leak = await runChecker(makeInput(["c1"]), {
      dispatchGrader: fakeDispatch(GRADER_SESSION, JSON.stringify({ pass: false, reasons: [`arr[0] leaked ${secret}`] })),
    });
    expect(leak.reasons).toEqual(["arr[0] leaked [REDACTED]"]);
  });

  it("evidence field shows grader tier, not secret", async () => {
    const deps: CheckerDeps = {
      dispatchGrader: fakeDispatch(GRADER_SESSION, '{"pass":true,"reasons":[]}'),
    };
    const result = await runChecker(makeInput(["c1"]), deps);
    expect(result.evidence).toBe("grader=fast");
  });
});

// ---------------------------------------------------------------------------
// Anti-rubber-stamp calibration
// These document intent: a competent skeptical grader must FAIL artefacts that
// *claim* completion without supplying concrete evidence.
// Real-model calibration is a later gated smoke test.
// ---------------------------------------------------------------------------

describe("anti-rubber-stamp calibration", () => {
  const skeptical = (reasons: string[]) =>
    async (_req: GraderRequest): Promise<GraderResult> => ({
      sessionID: GRADER_SESSION,
      text: JSON.stringify({ pass: false, reasons }),
    });

  it("case 1: claims 'all tests pass' with no test output => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["All tests must pass with test output shown in artefact"],
        makeArtefact("All tests pass.", [], [])
      ),
      { dispatchGrader: skeptical(["No test output in artefact; cannot verify"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("case 2: claims 'file created' but changedFiles empty => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["File src/new.ts must be created"],
        makeArtefact("I created src/new.ts.", [], [])
      ),
      { dispatchGrader: skeptical(["changedFiles is empty; no file creation evidence"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("case 3: claims 'build passes' with no build output => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["Build must pass with zero errors shown in output"],
        makeArtefact("Build is clean.", [], [])
      ),
      { dispatchGrader: skeptical(["No build output; cannot verify build passes"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("case 4: claims 'refactoring complete' but no changed files => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["Refactoring must be reflected in changedFiles"],
        makeArtefact("Refactoring complete!", [], [])
      ),
      { dispatchGrader: skeptical(["No changed files listed; refactoring unverifiable"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("case 5: claims 'linter clean' with no lint output => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["Linter must show 0 errors and 0 warnings in artefact"],
        makeArtefact("Linter passed.", [], [])
      ),
      { dispatchGrader: skeptical(["Linter output absent; cannot verify 0 warnings"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("case 6: claims 'API documented' but no docs file in evidence => FAIL", async () => {
    const result = await runChecker(
      makeInput(
        ["API documentation file must appear in changedFiles or declaredOutputs"],
        makeArtefact("API is fully documented.", [], [])
      ),
      { dispatchGrader: skeptical(["No docs file in changedFiles or declaredOutputs"]) }
    );
    expect(result.pass).toBe(false);
  });

  it("contrasting: genuine evidence present => PASS", async () => {
    const result = await runChecker(
      makeInput(
        ["File src/feature.ts must be created", "All tests must pass"],
        makeArtefact(
          "52 tests pass.\nErrors: 0",
          [{ path: "src/feature.ts", status: "A" }],
          ["src/feature.ts"]
        )
      ),
      {
        dispatchGrader: async () => ({
          sessionID: GRADER_SESSION,
          text: JSON.stringify({
            pass: true,
            reasons: [
              "src/feature.ts listed as Added in changedFiles",
              "52 tests pass in finalReturnText with 0 errors",
            ],
          }),
        }),
      }
    );
    expect(result.pass).toBe(true);
    expect(result.method).toBe("checker");
  });
});
