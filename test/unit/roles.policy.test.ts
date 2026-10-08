import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { AuthorityAction, RoleKind, RoleSpec } from "../../src/router/roles";
import {
  DETECTIONS,
  NEEDS,
  RISKS,
  SCOPES,
  type Detection,
  type Need,
  type Risk,
  type Scope,
  type TaskFacts,
} from "../../src/routing/classify/types";
import {
  GRANT_NOTES,
  authorityFloor,
  effectiveDetection,
  grantFor,
  tierBounds as tierBoundsOf,
  type DispatchGrant,
  type EffectiveFactsSources,
  type TierBoundsOptions,
} from "../../src/routing/roles/policy";
import type { RouteLine } from "../../src/routing/classify/types";

type BoundsOptions = TierBoundsOptions & EffectiveFactsSources;

/**
 * QA-P12-2-1: a plain depth as the A34 inputs that yield it — `deterministic` = the router's own gate runs the checks;
 * otherwise the route-line claim and the `[acceptance]` block agree on `d`.
 */
function eff(d: Detection) {
  return effectiveDetection(d === "deterministic"
    ? { routerGate: true, claim: null, acceptance: null }
    : { routerGate: false, claim: d, acceptance: d });
}

/**
 * QA-P12-1-1 (R7): `tierBounds` takes the classify shape and an EFFECTIVE detection. This adapter keeps the
 * tables below readable: `o.classifier` becomes `trace.rules` (over `facts`), `o.routeLine` becomes `trace.routeLine`.
 */
function tierBounds(spec: RoleSpec, grant: DispatchGrant, f: TaskFacts, d: Detection, o: BoundsOptions) {
  const rules: TaskFacts = o.classifier ? { ...f, ...o.classifier } : f;
  const routeLine = o.routeLine ? ({ pin: false, ignored: [], ...o.routeLine } as RouteLine) : null;
  return tierBoundsOf(spec, grant, { facts: f, trace: { rules, routeLine } }, eff(d), o);
}

// ---------------------------------------------------------------------------
// Fixtures: the §2.2 classes and the shipped role table, written independently of policy.ts
// ---------------------------------------------------------------------------

const LOCAL: readonly AuthorityAction[] = ["read", "glob", "grep", "router_git"];
const EGRESS: readonly AuthorityAction[] = ["webfetch", "websearch", "context7", "execute"];
const ALL: readonly AuthorityAction[] = [...LOCAL, "router_run", "edit", ...EGRESS];
const ROOT = "D:\\git\\omr-rta-p12";

function role(
  agent: string,
  kind: RoleKind,
  mode: "fixed" | "dynamic",
  allow: readonly AuthorityAction[],
  floor: string,
  ceiling: string,
  deny: readonly AuthorityAction[] = [],
): RoleSpec {
  return {
    agent,
    kind,
    description: agent,
    prompt: "",
    authority: { mode, allow, deny },
    tierRange: { floor, ceiling },
    assurance: "none",
    guard: kind === "implement" || kind === "general" ? "producer" : "reader",
    budget: {},
    enabled: true,
  };
}

const ROLES = {
  explorer: role("explorer", "explore", "fixed", LOCAL, "fast", "medium"),
  researcher: role("researcher", "research", "fixed", ["webfetch", "websearch", "context7"], "fast", "medium"),
  runner: role("runner", "run", "fixed", [...LOCAL, "router_run"], "fast", "medium"),
  implementer: role("implementer", "implement", "dynamic", [...LOCAL, "edit", "router_run"], "fast", "heavy"),
  reviewer: role("reviewer", "review", "fixed", [...LOCAL, "router_run"], "heavy", "heavy"),
  architect: role("architect", "design", "fixed", LOCAL, "medium", "heavy"),
  general: role("general", "general", "dynamic", [...LOCAL, "edit", "router_run"], "fast", "heavy"),
} as const;

function facts(needs: readonly Need[] = [], risk: Risk = "low", scope: Scope = "single"): TaskFacts {
  return { class: "other", risk, scope, needs, confidence: 0.9, source: "rules" };
}

function grantOf(...actions: AuthorityAction[]): DispatchGrant {
  return { actions: new Set(actions), notes: [], workRoot: ROOT };
}

const sorted = (g: DispatchGrant): AuthorityAction[] => [...g.actions].sort();
const set = (...a: AuthorityAction[]): AuthorityAction[] => [...a].sort();

function violatesSeparation(actions: ReadonlySet<AuthorityAction>): boolean {
  const egress = [...actions].some((a) => EGRESS.includes(a));
  const other = [...actions].some((a) => !EGRESS.includes(a));
  return egress && other;
}

/** Seeded PRNG (mulberry32): the property tests are reproducible without a new dependency. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)]!;
}

function subset<T>(r: () => number, xs: readonly T[], p = 0.5): T[] {
  return xs.filter(() => r() < p);
}

// ---------------------------------------------------------------------------
// grantFor
// ---------------------------------------------------------------------------

describe("grantFor — fixed roles", () => {
  it("grants allow minus deny, whatever the needs", () => {
    const r = role("x", "explore", "fixed", [...LOCAL, "router_run"], "fast", "medium", ["grep", "router_run"]);
    const g = grantFor(r, facts(["edit"]), [], ROOT);
    expect(sorted(g)).toEqual(set("read", "glob", "router_git"));
    expect(g.workRoot).toBe(ROOT);
  });

  it("returns actions in canonical order", () => {
    const g = grantFor(ROLES.runner, facts(), [], ROOT);
    expect([...g.actions]).toEqual(["read", "glob", "grep", "router_git", "router_run"]);
    expect(g.notes).toEqual([]);
  });

  it("ignores widening (the authority ladder is for dynamic roles)", () => {
    const g = grantFor(ROLES.explorer, facts(), ["edit", "router_run"], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL));
  });

  it("drops unknown action names from the max (configuration never widens authority)", () => {
    const r = role("x", "explore", "fixed", ["read", "bash" as AuthorityAction], "fast", "medium");
    expect(sorted(grantFor(r, facts(), [], ROOT))).toEqual(["read"]);
  });

  it("needs=web,edit on a local role: local grant + `researcher` and `implementer` notes", () => {
    const g = grantFor(ROLES.explorer, facts(["web", "edit"]), [], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL));
    expect(g.notes).toEqual([GRANT_NOTES.web, GRANT_NOTES.edit]);
    expect(GRANT_NOTES.web).toContain("use `researcher`");
  });

  it("needs=web on the researcher is satisfied without a note", () => {
    const g = grantFor(ROLES.researcher, facts(["web"]), [], ROOT);
    expect(sorted(g)).toEqual(set("webfetch", "websearch", "context7"));
    expect(g.notes).toEqual([]);
  });

  it("needs=shell on the runner keeps router_run and adds the raw-shell note", () => {
    const g = grantFor(ROLES.runner, facts(["shell"]), [], ROOT);
    expect(g.actions.has("router_run")).toBe(true);
    expect(g.notes).toEqual([GRANT_NOTES.shell]);
    expect(GRANT_NOTES.shell).toBe("raw shell is outside roles mode — dispatch a tier agent explicitly");
  });

  it("needs=shell on a role without router_run: note only", () => {
    const g = grantFor(ROLES.explorer, facts(["shell"]), [], ROOT);
    expect(g.actions.has("router_run")).toBe(false);
    expect(g.notes).toEqual([GRANT_NOTES.shell]);
  });

  it("separation: a hand-built max mixing local and egress loses the egress", () => {
    const r = role("mixed", "explore", "fixed", ["read", "webfetch", "execute"], "fast", "medium");
    const g = grantFor(r, facts(), [], ROOT);
    expect(sorted(g)).toEqual(["read"]);
    expect(g.notes).toEqual([GRANT_NOTES.separation]);
    expect(violatesSeparation(g.actions)).toBe(false);
  });
});

describe("grantFor — dynamic roles", () => {
  it("empty needs: general gets local only, implementer local + edit", () => {
    expect(sorted(grantFor(ROLES.general, facts(), [], ROOT))).toEqual(set(...LOCAL));
    expect(sorted(grantFor(ROLES.implementer, facts(), [], ROOT))).toEqual(set(...LOCAL, "edit"));
  });

  it("needs=edit → edit; needs=shell → router_run + note; needs=network → router_run + note", () => {
    expect(sorted(grantFor(ROLES.general, facts(["edit"]), [], ROOT))).toEqual(set(...LOCAL, "edit"));
    const shell = grantFor(ROLES.general, facts(["shell"]), [], ROOT);
    expect(sorted(shell)).toEqual(set(...LOCAL, "router_run"));
    expect(shell.notes).toEqual([GRANT_NOTES.shell]);
    const network = grantFor(ROLES.implementer, facts(["network"]), [], ROOT);
    expect(sorted(network)).toEqual(set(...LOCAL, "edit", "router_run"));
    expect(network.notes).toEqual([GRANT_NOTES.shell]);
  });

  it("needs=web,edit on general: edit granted, web never (note)", () => {
    const g = grantFor(ROLES.general, facts(["web", "edit"]), [], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL, "edit"));
    expect(g.notes).toEqual([GRANT_NOTES.web]);
  });

  it("needs derived outside the max are not granted (deny wins) and say so", () => {
    const r = role("g", "general", "dynamic", [...LOCAL, "edit", "router_run"], "fast", "heavy", ["edit", "router_run"]);
    const g = grantFor(r, facts(["edit", "shell"]), [], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL));
    expect(g.notes).toEqual([GRANT_NOTES.shell, GRANT_NOTES.edit]);
  });

  it("route-line needs passed separately are unioned with the facts (idempotent with classify())", () => {
    const g = grantFor(ROLES.general, facts(["edit"]), [], ROOT, { needs: ["edit", "shell"] });
    expect(sorted(g)).toEqual(set(...LOCAL, "edit", "router_run"));
    expect(sorted(grantFor(ROLES.general, facts(), [], ROOT, null))).toEqual(set(...LOCAL));
    expect(sorted(grantFor(ROLES.general, facts(), [], ROOT, {}))).toEqual(set(...LOCAL));
  });

  it("unknown needs are ignored", () => {
    const g = grantFor(ROLES.general, facts(["gpu" as Need, "sudo" as Need]), [], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL));
    expect(g.notes).toEqual([]);
  });

  it("widened grants are applied inside the max only", () => {
    const g = grantFor(ROLES.general, facts(), ["edit", "router_run", "webfetch", "execute", "bogus" as AuthorityAction], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL, "edit", "router_run"));
  });

  it("separation: a widened egress action on a local dynamic role is dropped with a note", () => {
    const r = role("g", "general", "dynamic", [...LOCAL, "edit", "websearch"], "fast", "heavy");
    const g = grantFor(r, facts(), ["websearch"], ROOT);
    expect(sorted(g)).toEqual(set(...LOCAL));
    expect(g.notes).toEqual([GRANT_NOTES.separation]);
  });

  it("a mode other than fixed is treated as dynamic (fail-closed)", () => {
    const r = { ...ROLES.general, authority: { ...ROLES.general.authority, mode: "weird" as "dynamic" } };
    expect(sorted(grantFor(r, facts(), [], ROOT))).toEqual(set(...LOCAL));
  });
});

describe("grantFor — work root", () => {
  it("needs=external_dir with a work root is satisfied silently", () => {
    const g = grantFor(ROLES.general, facts(["external_dir"]), [], ROOT);
    expect(g.notes).toEqual([]);
    expect(g.workRoot).toBe(ROOT);
  });

  it("needs=external_dir without a work root adds the root= note", () => {
    const g = grantFor(ROLES.explorer, facts(["external_dir"]), [], null);
    expect(g.notes).toEqual([GRANT_NOTES.externalDir]);
    expect(g.workRoot).toBeNull();
  });

  it("no work root → router_run never granted (fixed and dynamic) + note", () => {
    const runner = grantFor(ROLES.runner, facts(), [], null);
    expect(runner.actions.has("router_run")).toBe(false);
    expect(runner.notes).toEqual([GRANT_NOTES.noWorkRoot]);
    const general = grantFor(ROLES.general, facts(["shell", "external_dir"]), ["router_run"], null);
    expect(sorted(general)).toEqual(set(...LOCAL));
    expect(general.notes).toEqual([GRANT_NOTES.shell, GRANT_NOTES.externalDir, GRANT_NOTES.noWorkRoot]);
  });

  it("QA-P12-1-2: no work root → local only: implementer/general with needs=edit,shell keep exactly the local actions", () => {
    expect(GRANT_NOTES.noWorkRoot).toBe("no valid work root: write and run withheld");
    for (const spec of [ROLES.implementer, ROLES.general]) {
      const g = grantFor(spec, facts(["shell", "edit"]), ["edit", "router_run"], null);
      expect(sorted(g)).toEqual(set("read", "glob", "grep", "router_git"));
      expect(g.notes).toEqual([GRANT_NOTES.shell, GRANT_NOTES.noWorkRoot]);
      expect(g.notes).not.toContain(GRANT_NOTES.edit);
      const rooted = grantFor(spec, facts(["shell", "edit"]), [], ROOT);
      expect(rooted.actions.has("edit")).toBe(true);
      expect(rooted.actions.has("router_run")).toBe(true);
    }
    // a fixed egress role touches no file: it keeps its egress without a root
    expect(sorted(grantFor(ROLES.researcher, facts(["web"]), [], null))).toEqual(set("webfetch", "websearch", "context7"));
  });

  it("QA-P12-2-3: grantFor(…, null) means 'no validated root' for a known binding — it is not the unknown-binding grant", () => {
    // An unknown binding is the role max ∩ LOCAL (P1.6): for the researcher that is nothing; grantFor(…, null) keeps egress,
    // so reusing it for an unknown binding would widen authority.
    const unknownBinding = new Set(ROLES.researcher.authority.allow.filter((a) => LOCAL.includes(a)));
    const noRoot = grantFor(ROLES.researcher, facts(["web"]), [], null);
    expect(unknownBinding.size).toBe(0);
    expect(noRoot.actions.size).toBeGreaterThan(0);
    expect([...noRoot.actions].some((a) => !unknownBinding.has(a))).toBe(true);
  });

  it("no work-root note when router_run was never in the grant", () => {
    expect(grantFor(ROLES.explorer, facts(), [], null).notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// authorityFloor — the full §2.3 matrix (grant rows × detections × risk × scope)
// ---------------------------------------------------------------------------

/** §2.3, cell by cell. `write` row: [deterministic, grader, none] as a function of (risk, scope). */
const WRITE_ROW: Record<Detection, Record<Risk, Record<Scope, string>>> = {
  deterministic: {
    low: { single: "fast", multi: "medium", repo: "medium" },
    medium: { single: "medium", multi: "medium", repo: "medium" },
    high: { single: "medium", multi: "medium", repo: "medium" },
  },
  grader: {
    low: { single: "medium", multi: "medium", repo: "medium" },
    medium: { single: "medium", multi: "medium", repo: "medium" },
    high: { single: "medium", multi: "medium", repo: "medium" },
  },
  none: {
    low: { single: "medium", multi: "medium", repo: "medium" },
    medium: { single: "medium", multi: "medium", repo: "medium" },
    high: { single: "heavy", multi: "heavy", repo: "heavy" },
  },
};
const WRITE_EXEC_ROW: Record<Detection, string> = { deterministic: "medium", grader: "heavy", none: "heavy" };

const READ_ROWS: Array<[string, AuthorityAction[]]> = [
  ["empty", []],
  ["local", [...LOCAL]],
  ["egress", [...EGRESS]],
  ["exec", ["router_run"]],
  ["local+exec", [...LOCAL, "router_run"]],
];
const WRITE_ROWS: Array<[string, AuthorityAction[]]> = [
  ["write", ["edit"]],
  ["local+write", [...LOCAL, "edit"]],
];
const WRITE_EXEC_ROWS: Array<[string, AuthorityAction[]]> = [
  ["write+exec", ["edit", "router_run"]],
  ["local+write+exec", [...LOCAL, "edit", "router_run"]],
];

describe("authorityFloor — §2.3 matrix", () => {
  for (const d of DETECTIONS) {
    for (const r of RISKS) {
      for (const s of SCOPES) {
        it(`d=${d} risk=${r} scope=${s}`, () => {
          for (const [, actions] of READ_ROWS) expect(authorityFloor(grantOf(...actions), d, r, s)).toBe("fast");
          for (const [, actions] of WRITE_ROWS) expect(authorityFloor(grantOf(...actions), d, r, s)).toBe(WRITE_ROW[d][r][s]);
          for (const [, actions] of WRITE_EXEC_ROWS) {
            expect(authorityFloor(grantOf(...actions), d, r, s)).toBe(WRITE_EXEC_ROW[d]);
          }
        });
      }
    }
  }

  it("write + exec is never below the write-only row (max over rows)", () => {
    const rank = (t: string): number => ["fast", "medium", "heavy"].indexOf(t);
    for (const d of DETECTIONS) for (const r of RISKS) for (const s of SCOPES) {
      expect(rank(WRITE_EXEC_ROW[d])).toBeGreaterThanOrEqual(rank(WRITE_ROW[d][r][s]));
    }
  });

  it("an unknown detection is treated as none", () => {
    expect(authorityFloor(grantOf("edit"), "maybe" as Detection, "high", "single")).toBe("heavy");
    expect(authorityFloor(grantOf("edit", "router_run"), "maybe" as Detection, "low", "single")).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// Property tests — grants (I4 and "never outside the role max")
// ---------------------------------------------------------------------------

describe("grantFor — properties", () => {
  const KINDS: readonly RoleKind[] = ["explore", "research", "run", "implement", "review", "design", "general"];

  it("no generated input yields a grant outside the role max, a separation violation or router_run without a root", () => {
    const r = rng(0x5eed84);
    for (let i = 0; i < 4000; i++) {
      const allow = subset(r, ALL);
      const deny = subset(r, ALL, 0.2);
      const mode = r() < 0.5 ? "fixed" : "dynamic";
      const spec = role("p", pick(r, KINDS), mode, allow, "fast", "heavy", deny);
      const needs = subset(r, [...NEEDS, "gpu" as Need]);
      const widened = subset(r, [...ALL, "bogus" as AuthorityAction], 0.3);
      const workRoot = r() < 0.5 ? ROOT : null;
      const routeLine = r() < 0.5 ? { needs: subset(r, NEEDS) } : null;
      const g = grantFor(spec, facts(needs), widened, workRoot, routeLine);
      const max = new Set(allow.filter((a) => !deny.includes(a)));
      for (const a of g.actions) expect(max.has(a)).toBe(true);
      expect(violatesSeparation(g.actions)).toBe(false);
      if (workRoot === null) {
        expect(g.actions.has("router_run")).toBe(false);
        expect(g.actions.has("edit")).toBe(false);
      }
      expect(g.workRoot).toBe(workRoot);
      expect(new Set(g.notes).size).toBe(g.notes.length);
      // A dynamic grant never exceeds the fixed grant of the same (valid, separated) max. With a max that
      // itself mixes classes, separation is resolved per grant: an egress-only dynamic grant may keep egress.
      const fixed = grantFor({ ...spec, authority: { ...spec.authority, mode: "fixed" } }, facts(needs), widened, workRoot, routeLine);
      if (mode === "dynamic" && !violatesSeparation(max)) for (const a of g.actions) expect(fixed.actions.has(a)).toBe(true);
    }
  });

  it("every shipped role, every needs combination: grant within max, separation holds", () => {
    const combos: Need[][] = [[]];
    for (const n of NEEDS) for (const c of [...combos]) combos.push([...c, n]);
    for (const spec of Object.values(ROLES)) {
      for (const needs of combos) {
        for (const workRoot of [ROOT, null]) {
          const g = grantFor(spec, facts(needs), [], workRoot);
          for (const a of g.actions) expect(spec.authority.allow).toContain(a);
          expect(violatesSeparation(g.actions)).toBe(false);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// tierBounds
// ---------------------------------------------------------------------------

const TIERS = ["fast", "medium", "heavy"] as const;

function opts(o: Partial<BoundsOptions> = {}): BoundsOptions {
  return { floorTier: null, runningTier: null, pinTier: null, tiers: TIERS, ...o };
}

describe("tierBounds — window", () => {
  it("a read-only grant keeps the role range", () => {
    expect(tierBounds(ROLES.implementer, grantOf(...LOCAL), facts(), "none", opts())).toEqual({
      floor: "fast",
      ceiling: "heavy",
      pinned: null,
      reasons: [],
    });
    expect(tierBounds(ROLES.architect, grantOf(...LOCAL), facts(), "none", opts())).toMatchObject({ floor: "medium", ceiling: "heavy" });
  });

  it("the authority floor raises the floor", () => {
    const b = tierBounds(ROLES.implementer, grantOf("edit"), facts([], "high"), "none", opts());
    expect(b).toMatchObject({ floor: "heavy", ceiling: "heavy", reasons: ["floor:authority"] });
  });

  it("empty tier list → built-in order; duplicates and invalid entries are dropped", () => {
    const g = grantOf("edit");
    expect(tierBounds(ROLES.implementer, g, facts(), "grader", opts({ tiers: [] }))).toMatchObject({ floor: "medium", ceiling: "heavy" });
    const messy = ["fast", "fast", "", 7 as unknown as string, "medium", "heavy"];
    expect(tierBounds(ROLES.implementer, g, facts(), "grader", opts({ tiers: messy }))).toMatchObject({ floor: "medium", ceiling: "heavy" });
  });
});

describe("tierBounds — risk and scope are raise-only", () => {
  const g = grantOf("edit");

  it("a route line lowering risk is ignored", () => {
    const b = tierBounds(ROLES.implementer, g, facts([], "high"), "none", opts({ routeLine: { risk: "low" } }));
    expect(b.floor).toBe("heavy");
  });

  it("a route line raising risk is applied", () => {
    const b = tierBounds(ROLES.implementer, g, facts([], "low"), "none", opts({ routeLine: { risk: "high" } }));
    expect(b.floor).toBe("heavy");
  });

  it("a route line raising scope is applied", () => {
    expect(tierBounds(ROLES.implementer, g, facts(), "deterministic", opts()).floor).toBe("fast");
    const b = tierBounds(ROLES.implementer, g, facts(), "deterministic", opts({ routeLine: { scope: "multi" } }));
    expect(b.floor).toBe("medium");
  });

  it("a scope the route line lowered inside classify() is restored from the classifier facts", () => {
    // classify() merged `[route scope=single]` over a rules scope of `repo`: facts.scope is single.
    const merged = facts([], "low", "single");
    const b = tierBounds(ROLES.implementer, g, merged, "deterministic", opts({
      classifier: { risk: "low", scope: "repo" },
      routeLine: { scope: "single" },
    }));
    expect(b.floor).toBe("medium");
    expect(tierBounds(ROLES.implementer, g, merged, "deterministic", opts({ classifier: null, routeLine: null })).floor).toBe("fast");
  });

  it("QA-P12-1-1: the classify shape is required — classifier scope multi + [route scope=single] + deterministic + write → medium", () => {
    // classify() lets the route line override scope: facts.scope is single, trace.rules.scope is multi.
    const classified = {
      facts: facts([], "low", "single"),
      trace: { rules: facts([], "low", "multi"), routeLine: { scope: "single", pin: false, ignored: [] } as RouteLine },
    };
    const b = tierBoundsOf(ROLES.implementer, g, classified, eff("deterministic"), opts());
    expect(b.floor).toBe("medium");
    expect(b.reasons).toContain("floor:authority");
  });

  it("QA-P12-2-1: effectiveDetection computes A34 — deterministic only from the router's gate, else the weaker, capped at grader", () => {
    const D: ReadonlyArray<Detection | null> = [null, "none", "grader", "deterministic"];
    const level = (d: Detection | null): number => (d === "grader" ? 1 : d === "deterministic" ? 2 : 0);
    for (const claim of D) {
      for (const acceptance of D) {
        expect(effectiveDetection({ routerGate: true, claim, acceptance })).toBe("deterministic");
        const want = Math.min(level(claim), level(acceptance), 1) === 1 ? "grader" : "none";
        expect(effectiveDetection({ routerGate: false, claim, acceptance })).toBe(want);
      }
    }
    // a claim alone is never deterministic, and an unknown value is none
    expect(effectiveDetection({ routerGate: false, claim: "deterministic", acceptance: "deterministic" })).toBe("grader");
    expect(effectiveDetection({ routerGate: false, claim: "maybe" as Detection, acceptance: "grader" })).toBe("none");
  });

  it("QA-P12-2-1: no module outside roles/policy.ts casts to EffectiveDetection", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const casting = files
      .filter((f) => /\bas\s+EffectiveDetection\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(root, f).replace(/\\/g, "/"));
    expect(casting).toEqual(["routing/roles/policy.ts"]);
  });
});

describe("tierBounds — pins", () => {
  it("a pin inside the window is honoured", () => {
    expect(tierBounds(ROLES.implementer, grantOf(...LOCAL), facts(), "none", opts({ pinTier: "medium" }))).toMatchObject({
      pinned: "medium",
      reasons: [],
    });
  });

  it("a pin above the ceiling is clamped", () => {
    const b = tierBounds(ROLES.explorer, grantOf(...LOCAL), facts(), "none", opts({ pinTier: "heavy" }));
    expect(b).toMatchObject({ floor: "fast", ceiling: "medium", pinned: "medium", reasons: ["clamp:ceiling"] });
  });

  it("a pin below the authority floor is lifted (lift:authority)", () => {
    const b = tierBounds(ROLES.implementer, grantOf("edit"), facts([], "medium"), "none", opts({ pinTier: "fast" }));
    expect(b).toMatchObject({ floor: "medium", pinned: "medium", reasons: ["floor:authority", "lift:authority"] });
  });

  it("a pin below the role floor is lifted (lift:floor)", () => {
    const b = tierBounds(ROLES.architect, grantOf(...LOCAL), facts(), "none", opts({ pinTier: "fast" }));
    expect(b).toMatchObject({ floor: "medium", pinned: "medium", reasons: ["lift:floor"] });
  });

  it("on a tie the authority floor names the lift", () => {
    const narrowed = role("implementer", "implement", "dynamic", [...LOCAL, "edit"], "medium", "heavy");
    const b = tierBounds(narrowed, grantOf("edit"), facts(), "grader", opts({ pinTier: "fast" }));
    expect(b).toMatchObject({ floor: "medium", pinned: "medium", reasons: ["lift:authority"] });
  });

  it("a pin to an unknown tier is ignored", () => {
    const b = tierBounds(ROLES.implementer, grantOf(...LOCAL), facts(), "none", opts({ pinTier: "giant" }));
    expect(b).toMatchObject({ pinned: null, reasons: ["ignore:pin:giant"] });
  });
});

describe("tierBounds — floors above the role range", () => {
  it("resume at heavy with a fast default never moves below the running rung", () => {
    const b = tierBounds(ROLES.implementer, grantOf(...LOCAL, "edit"), facts(), "deterministic", opts({ runningTier: "heavy", pinTier: "fast" }));
    expect(b).toMatchObject({ floor: "heavy", ceiling: "heavy", pinned: "heavy", reasons: ["floor:running", "lift:floor"] });
  });

  it("floorTier above the role ceiling: the floor wins, the range is widened upward only", () => {
    const b = tierBounds(ROLES.explorer, grantOf(...LOCAL), facts(), "none", opts({ floorTier: "heavy" }));
    expect(b).toMatchObject({ floor: "heavy", ceiling: "heavy", pinned: null, reasons: ["floor:floorTier", "lift:floor"] });
  });

  it("an authority floor above a narrowed ceiling raises the ceiling (lift:authority)", () => {
    const narrowed = role("implementer", "implement", "dynamic", [...LOCAL, "edit", "router_run"], "fast", "medium");
    const b = tierBounds(narrowed, grantOf("edit", "router_run"), facts(), "grader", opts());
    expect(b).toMatchObject({ floor: "heavy", ceiling: "heavy", reasons: ["floor:authority", "lift:authority"] });
  });

  it("an inverted role range keeps the floor and lifts the ceiling", () => {
    const inverted = role("x", "design", "fixed", LOCAL, "heavy", "fast");
    expect(tierBounds(inverted, grantOf(...LOCAL), facts(), "none", opts())).toMatchObject({
      floor: "heavy",
      ceiling: "heavy",
      reasons: ["lift:floor"],
    });
  });
});

describe("tierBounds — tier names off the order", () => {
  it("QA-P12-1-4: unknown floor names fail closed to the top of the order; an unknown ceiling is ignored", () => {
    const r = role("x", "general", "dynamic", LOCAL, "giant", "huge");
    const b = tierBounds(r, grantOf(...LOCAL), facts(), "none", opts({ floorTier: "giant", runningTier: "tiny" }));
    expect(b).toEqual({
      floor: "heavy",
      ceiling: "heavy",
      pinned: null,
      reasons: ["unknown:role:giant->heavy", "unknown:floorTier:giant->heavy", "unknown:running:tiny->heavy", "ignore:ceiling:huge"],
    });
    const onlyRunning = tierBounds(ROLES.explorer, grantOf(...LOCAL), facts(), "none", opts({ runningTier: "tiny" }));
    expect(onlyRunning).toMatchObject({ floor: "heavy", ceiling: "heavy", reasons: ["unknown:running:tiny->heavy", "floor:running", "lift:floor"] });
  });

  it("a built-in floor missing from the order rounds up (fail-closed)", () => {
    const b = tierBounds(ROLES.implementer, grantOf("edit"), facts(), "grader", opts({ tiers: ["fast", "heavy"] }));
    expect(b).toMatchObject({ floor: "heavy", ceiling: "heavy" });
    expect(b.reasons).toEqual(["round:authority:medium->heavy", "floor:authority"]);
  });

  it("a built-in ceiling missing from the order rounds down", () => {
    const b = tierBounds(ROLES.explorer, grantOf(...LOCAL), facts(), "none", opts({ tiers: ["fast", "heavy"], pinTier: "heavy" }));
    expect(b).toMatchObject({ floor: "fast", ceiling: "fast", pinned: "fast" });
    expect(b.reasons).toEqual(["round:ceiling:medium->fast", "clamp:ceiling"]);
  });

  it("with no built-in tier at or below the ceiling, the cheapest tier is the ceiling", () => {
    const fastOnly = role("x", "explore", "fixed", LOCAL, "fast", "fast");
    const b = tierBounds(fastOnly, grantOf(...LOCAL), facts(), "none", opts({ tiers: ["medium", "heavy"] }));
    expect(b).toMatchObject({ floor: "medium", ceiling: "medium" });
    expect(b.reasons).toEqual(["round:role:fast->medium", "round:authority:fast->medium", "round:ceiling:fast->medium"]);
  });

  it("a custom order: `fast` is vacuous, a higher built-in floor takes the top tier", () => {
    const custom = { tiers: ["small", "large"] };
    const low = tierBounds(ROLES.implementer, grantOf(...LOCAL), facts(), "none", opts(custom));
    expect(low).toMatchObject({ floor: "small", ceiling: "small" });
    const high = tierBounds(ROLES.implementer, grantOf("edit"), facts([], "high"), "none", opts(custom));
    expect(high).toMatchObject({ floor: "large", ceiling: "large" });
    expect(high.reasons).toContain("round:authority:heavy->large");
    expect(high.reasons).toContain("lift:authority");
  });
});

// ---------------------------------------------------------------------------
// Property tests — bounds (I2: never below the authority floor; raise-only route line)
// ---------------------------------------------------------------------------

describe("tierBounds — properties", () => {
  const ORDERS: ReadonlyArray<readonly string[]> = [
    TIERS,
    [],
    ["fast", "heavy"],
    ["medium", "heavy"],
    ["fast", "medium"],
    ["small", "large"],
  ];
  const NAMES: ReadonlyArray<string | null> = [null, ...TIERS, "giant", "small"];
  const rank = (t: string): number => (TIERS as readonly string[]).indexOf(t);
  const maxOf = <T extends string>(order: readonly T[], xs: ReadonlyArray<T | undefined | null>): T =>
    order[Math.max(...xs.map((x) => (x == null ? -1 : order.indexOf(x))))]!;

  /** `floor` is at least `want` on `order` (rounded up / fail-closed for built-in names off the order). */
  function atLeast(order: readonly string[], floor: string, want: string): boolean {
    const at = order.indexOf(want);
    if (at >= 0) return order.indexOf(floor) >= at;
    if (rank(want) <= 0) return true;
    return rank(floor) >= rank(want) || order.indexOf(floor) === order.length - 1;
  }

  it("every generated input: window ordered, floor ≥ every floor source, pin inside, route line raise-only", () => {
    const r = rng(0x7135);
    for (let i = 0; i < 6000; i++) {
      const tiers = pick(r, ORDERS);
      const order = tiers.length > 0 ? tiers : TIERS;
      const spec = role("p", "general", "dynamic", ALL, pick(r, NAMES) ?? "fast", pick(r, NAMES) ?? "heavy");
      const g = grantOf(...subset(r, ALL));
      const d = pick(r, DETECTIONS);
      const f = facts([], pick(r, RISKS), pick(r, SCOPES));
      const classifier = r() < 0.5 ? { risk: pick(r, RISKS), scope: pick(r, SCOPES) } : null;
      const routeLine = r() < 0.5 ? { risk: r() < 0.5 ? pick(r, RISKS) : undefined, scope: r() < 0.5 ? pick(r, SCOPES) : undefined } : null;
      const o = opts({ tiers, floorTier: pick(r, NAMES), runningTier: pick(r, NAMES), pinTier: pick(r, NAMES), classifier, routeLine });
      const b = tierBounds(spec, g, f, d, o);

      expect(order).toContain(b.floor);
      expect(order).toContain(b.ceiling);
      expect(order.indexOf(b.floor)).toBeLessThanOrEqual(order.indexOf(b.ceiling));
      expect(new Set(b.reasons).size).toBe(b.reasons.length);

      const risk = maxOf(RISKS, [f.risk, classifier?.risk, routeLine?.risk]);
      const scope = maxOf(SCOPES, [f.scope, classifier?.scope, routeLine?.scope]);
      expect(atLeast(order, b.floor, authorityFloor(g, d, risk, scope))).toBe(true);
      expect(atLeast(order, b.floor, authorityFloor(g, d, f.risk, f.scope))).toBe(true);
      for (const src of [spec.tierRange.floor, o.floorTier, o.runningTier]) {
        if (src !== null && rank(src) >= 0) expect(atLeast(order, b.floor, src)).toBe(true);
        if (src !== null && order.includes(src)) expect(order.indexOf(b.floor)).toBeGreaterThanOrEqual(order.indexOf(src));
      }

      if (o.pinTier === null || !order.includes(o.pinTier)) expect(b.pinned).toBeNull();
      else {
        const p = order.indexOf(b.pinned!);
        expect(p).toBeGreaterThanOrEqual(order.indexOf(b.floor));
        expect(p).toBeLessThanOrEqual(order.indexOf(b.ceiling));
      }

      const bare = tierBounds(spec, g, f, d, { ...o, classifier: null, routeLine: null });
      expect(order.indexOf(b.floor)).toBeGreaterThanOrEqual(order.indexOf(bare.floor));
    }
  });

  it("no generated (role, facts) yields a floor below authorityFloor or a grant outside the role max", () => {
    const r = rng(0x84);
    const KINDS: readonly RoleKind[] = ["explore", "research", "run", "implement", "review", "design", "general"];
    for (let i = 0; i < 4000; i++) {
      const allow = subset(r, ALL);
      const deny = subset(r, ALL, 0.2);
      const spec = role("p", pick(r, KINDS), r() < 0.5 ? "fixed" : "dynamic", allow, pick(r, TIERS), pick(r, TIERS), deny);
      const f = facts(subset(r, NEEDS), pick(r, RISKS), pick(r, SCOPES));
      const g = grantFor(spec, f, subset(r, ALL, 0.3), r() < 0.5 ? ROOT : null);
      const d = pick(r, DETECTIONS);
      const b = tierBounds(spec, g, f, d, opts({ floorTier: pick(r, NAMES), runningTier: pick(r, NAMES), pinTier: pick(r, NAMES) }));
      const max = new Set(allow.filter((a) => !deny.includes(a)));
      for (const a of g.actions) expect(max.has(a)).toBe(true);
      expect(violatesSeparation(g.actions)).toBe(false);
      expect(rank(b.floor)).toBeGreaterThanOrEqual(rank(authorityFloor(g, d, f.risk, f.scope)));
      if (b.pinned !== null) expect(rank(b.pinned)).toBeGreaterThanOrEqual(rank(b.floor));
    }
  });
});
