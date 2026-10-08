import { describe, expect, it } from "vitest";
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
import { GRANT_NOTES, authorityFloor, grantFor, type DispatchGrant } from "../../src/routing/roles/policy";

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
      if (workRoot === null) expect(g.actions.has("router_run")).toBe(false);
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
