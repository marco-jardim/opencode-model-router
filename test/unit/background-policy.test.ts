import { describe, expect, it } from "vitest";
import {
  decideBackground,
  MAX_LIVE_ATTEMPTS,
  type BackgroundInput,
  type BackgroundMode,
  type VerificationMode,
} from "../../src/compat/background";
import type { DurationEstimate } from "../../src/routing/outcomes/durations";

const MIN = 45_000;
const SAMPLES = 5;

type Source = "observed" | "prior";

function est(source: Source, n: number, p50: number): DurationEstimate {
  const level = source === "prior" ? "prior" : "exact";
  return { p50, p90: p50, n, source: level, p90Source: level, p90N: n };
}

function input(over: Partial<BackgroundInput> = {}): BackgroundInput {
  return {
    mode: "auto",
    explicit: undefined,
    verifying: false,
    verificationMode: "none",
    roleRouted: false,
    estimate: undefined,
    minPredictedMs: MIN,
    minSamples: SAMPLES,
    acceptance: { testsPass: false, buildPasses: false },
    planTask: false,
    holdingAvailable: true,
    parentIsRoot: true,
    liveCount: 0,
    ...over,
  };
}

describe("decideBackground: off reproduces today's nativeArgs byte for byte", () => {
  const verifyingChoices = [false, true];
  const roleChoices = [false, true];
  const explicitChoices: Array<boolean | undefined> = [undefined, true, false];
  const modes: VerificationMode[] = ["required", "deferred", "none"];
  for (const verifying of verifyingChoices) {
    for (const roleRouted of roleChoices) {
      for (const explicit of explicitChoices) {
        for (const verificationMode of modes) {
          it(`off verifying=${verifying} role=${roleRouted} explicit=${String(explicit)} verification=${verificationMode}`, () => {
            const d = decideBackground(
              input({
                mode: "off",
                verifying,
                roleRouted,
                explicit,
                verificationMode,
                estimate: est("observed", 50, 600_000),
                acceptance: { testsPass: true, buildPasses: true },
                planTask: true,
              }),
            );
            const legacy = verifying || roleRouted ? false : undefined;
            expect(d).toEqual({ background: legacy, hold: false, reason: "off" });
            // The native-arguments object the adapter builds from it: identical keys to the pre-phase code.
            const nativeArgs = d.background === undefined ? {} : { background: d.background };
            expect(JSON.stringify(nativeArgs)).toBe(legacy === undefined ? "{}" : '{"background":false}');
          });
        }
      }
    }
  }
});

describe("decideBackground: rows before the mode switch", () => {
  it("a child parent never goes to the background", () => {
    expect(decideBackground(input({ parentIsRoot: false, explicit: true }))).toEqual({
      background: undefined,
      hold: false,
      reason: "child-parent",
    });
    expect(decideBackground(input({ parentIsRoot: false, roleRouted: true })).background).toBe(false);
  });

  it("the live cap keeps the legacy value", () => {
    const d = decideBackground(input({ liveCount: MAX_LIVE_ATTEMPTS, explicit: true, verifying: true }));
    expect(d).toEqual({ background: false, hold: false, reason: "cap" });
    expect(decideBackground(input({ liveCount: MAX_LIVE_ATTEMPTS - 1, explicit: true })).reason).toBe("explicit");
  });
});

describe("decideBackground: explicit argument", () => {
  const modes: BackgroundMode[] = ["auto", "model"];
  for (const mode of modes) {
    it(`${mode}: explicit true without verification is background and not held`, () => {
      expect(decideBackground(input({ mode, explicit: true }))).toEqual({ background: true, hold: false, reason: "explicit" });
    });
    it(`${mode}: explicit true with required verification holds when holding is available`, () => {
      expect(decideBackground(input({ mode, explicit: true, verificationMode: "required" }))).toEqual({
        background: true,
        hold: true,
        reason: "explicit",
      });
    });
    it(`${mode}: explicit true with required verification and no holding stays in the foreground`, () => {
      expect(
        decideBackground(input({ mode, explicit: true, verificationMode: "required", holdingAvailable: false })),
      ).toEqual({ background: false, hold: false, reason: "explicit-no-holding" });
    });
    it(`${mode}: explicit true with deferred verification does not need holding`, () => {
      expect(
        decideBackground(input({ mode, explicit: true, verificationMode: "deferred", holdingAvailable: false })),
      ).toEqual({ background: true, hold: false, reason: "explicit" });
    });
    it(`${mode}: explicit false forces the foreground`, () => {
      expect(
        decideBackground(input({ mode, explicit: false, estimate: est("observed", 9, 900_000), acceptance: { testsPass: true, buildPasses: false } })),
      ).toEqual({ background: false, hold: false, reason: "explicit" });
    });
  }
});

describe("decideBackground: model mode leaves the choice to the model", () => {
  it("unset sends no key, whatever the estimate says", () => {
    expect(decideBackground(input({ mode: "model", estimate: est("observed", 9, 900_000), planTask: true }))).toEqual({
      background: undefined,
      hold: false,
      reason: "model-unset",
    });
  });
  it("unset keeps the legacy false for verifying and role-routed calls", () => {
    expect(decideBackground(input({ mode: "model", verifying: true })).background).toBe(false);
    expect(decideBackground(input({ mode: "model", roleRouted: true })).background).toBe(false);
  });
});

describe("decideBackground: auto mode selection", () => {
  it("the estimate selects only from observed data with n >= minSamples", () => {
    expect(decideBackground(input({ estimate: est("observed", SAMPLES, MIN) }))).toEqual({
      background: true,
      hold: false,
      reason: "estimate",
    });
    expect(decideBackground(input({ estimate: est("observed", SAMPLES, MIN - 1) })).reason).toBe("short");
    expect(decideBackground(input({ estimate: est("observed", SAMPLES - 1, MIN * 4) })).reason).toBe("short");
    expect(decideBackground(input({ estimate: est("observed", SAMPLES + 20, MIN + 1) })).reason).toBe("estimate");
  });

  it("a prior estimate never selects, however large", () => {
    const d = decideBackground(input({ estimate: est("prior", 50, MIN * 10) }));
    expect(d).toEqual({ background: undefined, hold: false, reason: "prior" });
  });

  it("no estimate and no other signal is short", () => {
    expect(decideBackground(input())).toEqual({ background: undefined, hold: false, reason: "short" });
  });

  it("an acceptance of testsPass or buildPasses selects", () => {
    expect(decideBackground(input({ acceptance: { testsPass: true, buildPasses: false } })).reason).toBe("acceptance");
    expect(decideBackground(input({ acceptance: { testsPass: false, buildPasses: true } })).reason).toBe("acceptance");
    expect(decideBackground(input({ acceptance: { testsPass: true, buildPasses: true } })).background).toBe(true);
  });

  it("a plan task selects when nothing else does", () => {
    expect(decideBackground(input({ planTask: true }))).toEqual({ background: true, hold: false, reason: "plan-task" });
  });

  it("the estimate wins over acceptance and the plan task", () => {
    const d = decideBackground(
      input({ estimate: est("observed", 6, MIN * 2), acceptance: { testsPass: true, buildPasses: true }, planTask: true }),
    );
    expect(d.reason).toBe("estimate");
  });

  it("acceptance wins over the plan task", () => {
    expect(decideBackground(input({ acceptance: { testsPass: true, buildPasses: false }, planTask: true })).reason).toBe("acceptance");
  });

  const selectors: Array<[string, Partial<BackgroundInput>]> = [
    ["estimate", { estimate: est("observed", 9, MIN * 3) }],
    ["acceptance", { acceptance: { testsPass: true, buildPasses: false } }],
    ["plan-task", { planTask: true }],
  ];
  for (const [reason, over] of selectors) {
    it(`${reason} with required verification holds when holding is available`, () => {
      expect(decideBackground(input({ ...over, verificationMode: "required" }))).toEqual({
        background: true,
        hold: true,
        reason,
      });
    });
    it(`${reason} with required verification and no holding stays in the foreground`, () => {
      expect(decideBackground(input({ ...over, verificationMode: "required", holdingAvailable: false }))).toEqual({
        background: false,
        hold: false,
        reason: "no-holding",
      });
    });
    it(`${reason} with deferred or no verification does not need holding`, () => {
      for (const verificationMode of ["deferred", "none"] as const) {
        expect(decideBackground(input({ ...over, verificationMode, holdingAvailable: false }))).toEqual({
          background: true,
          hold: false,
          reason,
        });
      }
    });
  }

  it("an unselected call keeps false only when verifying; a role-routed one gets no key", () => {
    expect(decideBackground(input({ verifying: true })).background).toBe(false);
    expect(decideBackground(input({ roleRouted: true })).background).toBeUndefined();
    expect(decideBackground(input({ roleRouted: true, estimate: est("prior", 1, 1) }))).toEqual({
      background: undefined,
      hold: false,
      reason: "prior",
    });
  });

  it("holding availability does not matter when verification is not required and nothing selects", () => {
    expect(decideBackground(input({ holdingAvailable: false, verificationMode: "required" })).reason).toBe("short");
  });
});

describe("decideBackground: full table sweep", () => {
  it("every combination yields a coherent decision", () => {
    const modes: BackgroundMode[] = ["auto", "model", "off"];
    const explicits: Array<boolean | undefined> = [undefined, true, false];
    const estimates: Array<DurationEstimate | undefined> = [
      undefined,
      est("prior", 9, MIN * 2),
      est("observed", SAMPLES, MIN - 1),
      est("observed", SAMPLES, MIN),
      est("observed", SAMPLES, MIN + 1),
      est("observed", SAMPLES - 1, MIN * 2),
    ];
    const verificationModes: VerificationMode[] = ["required", "deferred", "none"];
    let rows = 0;
    for (const mode of modes) {
      for (const explicit of explicits) {
        for (const estimate of estimates) {
          for (const verificationMode of verificationModes) {
            for (const testsPass of [false, true]) {
              for (const planTask of [false, true]) {
                for (const holdingAvailable of [false, true]) {
                  const d = decideBackground(
                    input({ mode, explicit, estimate, verificationMode, planTask, holdingAvailable, acceptance: { testsPass, buildPasses: false } }),
                  );
                  rows += 1;
                  // A hold implies a background run with required verification and holding available.
                  if (d.hold) {
                    expect(d.background).toBe(true);
                    expect(verificationMode).toBe("required");
                    expect(holdingAvailable).toBe(true);
                  }
                  // A background run with required verification is always held.
                  if (d.background === true && verificationMode === "required") expect(d.hold).toBe(true);
                  if (mode === "off") expect(d.reason).toBe("off");
                }
              }
            }
          }
        }
      }
    }
    expect(rows).toBe(3 * 3 * 6 * 3 * 2 * 2 * 2);
  });
});
