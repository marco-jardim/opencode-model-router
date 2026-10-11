import { describe, expect, it } from "vitest";
import { parseRouteLine } from "../../src/routing/classify/route-line";
import type { ClassifyTrace } from "../../src/routing/classify/types";

const parse = (text: string, positions: "first" | "any" = "first") => parseRouteLine(text, { positions });

describe("route line roles keys", () => {
  it("parses tier, budget and root", () => {
    const { line } = parse("[route tier=heavy budget=250 root=D:\\git\\omr-rta-p11]\nbody");
    expect(line?.tier).toBe("heavy");
    expect(line?.budget).toBe(250);
    expect(line?.root).toBe("D:\\git\\omr-rta-p11");
    expect(line?.ignored).toEqual([]);
  });

  it("keeps POSIX roots and the case of the path", () => {
    expect(parse("[route root=/Home/Me/Repo]").line?.root).toBe("/Home/Me/Repo");
  });

  it("accepts a quoted root with spaces", () => {
    const { line } = parse('[route class=debug root="D:\\My Work\\Repo" budget=5]');
    expect(line?.root).toBe("D:\\My Work\\Repo");
    expect(line?.budget).toBe(5);
    expect(line?.class).toBe("debug");
  });

  it("ignores invalid values", () => {
    for (const body of ["tier=giant", "tier", "budget=0", "budget=10001", "budget=1.5", "budget=-3", "root=rel\\dir", "root=./x", "root"]) {
      const { line } = parse(`[route ${body}]`);
      const key = body.split("=")[0]!;
      expect(line?.tier).toBeUndefined();
      expect(line?.budget).toBeUndefined();
      expect(line?.root).toBeUndefined();
      expect(line?.ignored).toContain(key);
    }
    expect(parse("[route budget=10000]").line?.budget).toBe(10000);
  });

  it("recognises the keys only on the first line (A22)", () => {
    const text = "hello\n[route tier=fast budget=3 root=/x]\n";
    const r = parse(text);
    expect(r.line).toBeNull();
    expect(r.stripped).toBe(text);
    expect(parse(text, "any").line?.root).toBe("/x");
  });

  it("treats differing roles keys as a conflict", () => {
    const r = parse("[route tier=fast]\n[route tier=heavy]", "any");
    expect(r.conflict).toBe(true);
    expect(r.line?.tier).toBeUndefined();
    expect(r.line?.ignored).toContain("conflict:tier");
  });
});

describe("route line cross-repo keys (repo, branch)", () => {
  it("parses repo and keeps its case", () => {
    expect(parse("[route repo=app-a]").line?.repo).toBe("app-a");
    const { line } = parse("[route repo=App-A.v2_x]");
    expect(line?.repo).toBe("App-A.v2_x");
    expect(line?.ignored).toEqual([]);
  });

  it("accepts a 100-char repo and ignores a 101-char one", () => {
    expect(parse(`[route repo=${"a".repeat(100)}]`).line?.repo).toBe("a".repeat(100));
    const { line } = parse(`[route repo=${"a".repeat(101)}]`);
    expect(line?.repo).toBeUndefined();
    expect(line?.ignored).toContain("repo");
  });

  it.each([["../x"], ["a/b"], ["-x"], ["."], [".."], ["a\\b"], [".x"], [""]])("ignores the invalid repo %j", (value) => {
    const { line } = parse(`[route repo=${value}]`);
    expect(line?.repo).toBeUndefined();
    expect(line?.ignored).toContain("repo");
  });

  it("ignores a bare repo key", () => {
    const { line } = parse("[route repo]");
    expect(line?.repo).toBeUndefined();
    expect(line?.ignored).toContain("repo");
  });

  it("parses branch and keeps its case", () => {
    const { line } = parse("[route branch=feat/Login-2]");
    expect(line?.branch).toBe("feat/Login-2");
    expect(line?.ignored).toEqual([]);
    expect(parse("[route branch=release_1.2.x]").line?.branch).toBe("release_1.2.x");
  });

  it("accepts a 200-char branch and ignores a 201-char one", () => {
    expect(parse(`[route branch=${"b".repeat(200)}]`).line?.branch).toBe("b".repeat(200));
    const { line } = parse(`[route branch=${"b".repeat(201)}]`);
    expect(line?.branch).toBeUndefined();
    expect(line?.ignored).toContain("branch");
  });

  it.each([["-x"], ["/x"], ["x/"], ["a..b"], ["a//b"], ["x.lock"], ["x."], ["a~b"], ["a:b"], ["a\\b"], [""]])(
    "ignores the invalid branch %j",
    (value) => {
      const { line } = parse(`[route branch=${value}]`);
      expect(line?.branch).toBeUndefined();
      expect(line?.ignored).toContain("branch");
    },
  );

  it.each([["renovate/foo+bar"], ["feat/ação"], ["a@b"], ["release/1.2+build#5"], ["wip{x}"]])(
    "accepts the git-valid branch %j",
    (value) => {
      const { line } = parse(`[route branch=${value}]`);
      expect(line?.branch).toBe(value);
      expect(line?.ignored).toEqual([]);
      expect(line?.invalidCrossRepo).toBeUndefined();
    },
  );

  it.each([["a..b"], ["x.lock"], ["@"], ["a@{b"], ["a\u0001b"], ["a/.hidden"], ["a.lock/b"], ["a?b"], ["a*b"], ["a[b"], ["a^b"], ["a\u007fb"]])(
    "ignores the git-invalid branch %j and marks it declared-but-invalid",
    (value) => {
      const { line } = parse(`[route branch=${value}]`);
      expect(line?.branch).toBeUndefined();
      expect(line?.ignored).toContain("branch");
      expect(line?.invalidCrossRepo).toEqual([{ key: "branch", value }]);
    },
  );

  it("marks an invalid repo, a bare repo / branch key, and keeps the value as written", () => {
    expect(parse("[route repo=.dotfiles branch=main]").line?.invalidCrossRepo).toEqual([{ key: "repo", value: ".dotfiles" }]);
    expect(parse("[route repo]").line?.invalidCrossRepo).toEqual([{ key: "repo", value: "" }]);
    expect(parse("[route branch]").line?.invalidCrossRepo).toEqual([{ key: "branch", value: "" }]);
    expect(parse("[route branch=A..B,]").line?.invalidCrossRepo).toEqual([{ key: "branch", value: "A..B" }]);
  });

  it("marks a duplicate repo / branch key (the first value is still kept)", () => {
    const { line } = parse("[route repo=a repo=b branch=x branch=y]");
    expect(line?.repo).toBe("a");
    expect(line?.invalidCrossRepo).toEqual([{ key: "repo", value: "b" }, { key: "branch", value: "y" }]);
  });

  it("marks a repo / branch the route lines contradict, so a conflict never binds the session directory", () => {
    const byBranch = parse("[route repo=a branch=x]\n[route repo=a branch=y]", "any");
    expect(byBranch.line?.invalidCrossRepo).toEqual([{ key: "branch", value: "x" }]);
    const byRepo = parse("[route repo=a]\n[route repo=b]", "any");
    expect(byRepo.line?.invalidCrossRepo).toEqual([{ key: "repo", value: "a" }]);
    expect(parse("[route repo=a branch=x]\n[route repo=a branch=x]", "any").line?.invalidCrossRepo).toBeUndefined();
  });

  it("splits a branch at whitespace: the first token is the value, the rest is an unknown key", () => {
    const { line } = parse("[route branch=has space]");
    expect(line?.branch).toBe("has");
    expect(line?.ignored).toEqual(["space"]);
  });

  it("strips a trailing comma or semicolon from the values", () => {
    const { line } = parse("[route repo=app-a, branch=feat/x;]");
    expect(line?.repo).toBe("app-a");
    expect(line?.branch).toBe("feat/x");
  });

  it("reports duplicates as dup:repo / dup:branch and keeps the first", () => {
    const { line } = parse("[route repo=a repo=b branch=x branch=y]");
    expect(line?.repo).toBe("a");
    expect(line?.branch).toBe("x");
    expect(line?.ignored).toEqual(["dup:repo", "dup:branch"]);
  });

  it("keeps root, repo and branch together", () => {
    const { line } = parse("[route tier=medium root=D:\\git\\wt\\feat repo=App-A branch=feat/Login-2]");
    expect(line?.root).toBe("D:\\git\\wt\\feat");
    expect(line?.repo).toBe("App-A");
    expect(line?.branch).toBe("feat/Login-2");
    expect(line?.tier).toBe("medium");
    expect(line?.ignored).toEqual([]);
  });

  it("treats route lines that differ only in repo or branch as a conflict", () => {
    const byBranch = parse("[route repo=a branch=x]\n[route repo=a branch=y]", "any");
    expect(byBranch.conflict).toBe(true);
    expect(byBranch.line?.branch).toBeUndefined();
    expect(byBranch.line?.repo).toBe("a");
    expect(byBranch.line?.ignored).toContain("conflict:branch");
    const byRepo = parse("[route repo=a]\n[route repo=b]", "any");
    expect(byRepo.conflict).toBe(true);
    expect(byRepo.line?.repo).toBeUndefined();
    expect(byRepo.line?.ignored).toContain("conflict:repo");
    expect(parse("[route repo=a branch=x]\n[route repo=a branch=x]", "any").conflict).toBe(false);
  });

  it("still applies the 500-char cap to a line carrying repo and branch", () => {
    const text = `[route repo=app-a branch=${"b".repeat(480)}]\nbody`;
    const r = parse(text);
    expect(r.line).toBeNull();
    expect(r.malformed).toBe(true);
    expect(r.stripped).toBe(text);
  });
});

describe("QA-P12-1-6: work roots are local paths; a malformed first route line is flagged", () => {
  it.each([
    ["UNC", "\\\\host\\share\\repo"],
    ["UNC with forward slashes", "//host/share/repo"],
    ["Win32 file namespace", "\\\\?\\D:\\git\\repo"],
    ["Win32 device namespace", "\\\\.\\D:\\git\\repo"],
    ["parent segment", "D:\\git\\..\\Windows"],
    ["trailing parent segment", "D:\\git\\repo\\.."],
    ["POSIX parent segment", "/home/me/../root"],
    ["POSIX double slash", "//etc/passwd"],
    ["drive-relative", "D:git\\repo"],
  ])("rejects a %s root", (_name, root) => {
    const { line } = parse(`[route root=${root}]`);
    expect(line?.root).toBeUndefined();
    expect(line?.ignored).toContain("root");
    expect(parse(`[route root="${root}"]`).line?.root).toBeUndefined();
  });

  it("keeps drive-absolute and POSIX roots, including dotted names that are not `..` segments", () => {
    for (const root of ["D:\\git\\omr-rta-p12", "D:/git/omr-rta-p12", "/x", "/home/me/repo..old", "D:\\git\\.hidden\\..x"]) {
      expect(parse(`[route root=${root}]`).line?.root).toBe(root);
    }
  });

  it("flags a first line that starts like a route line but does not parse; the line stays text", () => {
    for (const text of ["[route class=debug\nbody", "[route root=D:\\a]b]\nbody", `[route ${"x".repeat(600)}]\nbody`, "  [route tier=heavy\nbody"]) {
      const r = parse(text);
      expect(r.line).toBeNull();
      expect(r.count).toBe(0);
      expect(r.malformed).toBe(true);
      expect(r.stripped).toBe(text);
    }
  });

  it("QA-P12-2-2: a route line parsed elsewhere keeps its own ignored list; the flag is on the parse only", () => {
    const r = parse("[route class=debug\nbody\n[route tier=heavy]", "any");
    expect(r.line?.tier).toBe("heavy");
    expect(r.line?.ignored).toEqual([]);
    expect(r.malformed).toBe(true);
  });

  it("QA-P12-2-2: ClassifyTrace.routeLines has an optional malformed field (absent when not reported)", () => {
    const reported: ClassifyTrace["routeLines"] = { count: 0, conflict: false, edgeOnly: true, malformed: true };
    const legacy: ClassifyTrace["routeLines"] = { count: 0, conflict: false, edgeOnly: true };
    expect(reported.malformed).toBe(true);
    expect(legacy.malformed).toBeUndefined();
  });

  it("does not flag other tags, valid lines, fenced or indented text, or a [route mention after the first line", () => {
    for (const text of [
      "[router ✓ verified: ok]\nbody",
      "[routes are fun\nbody",
      "[route tier=fast]\nbody",
      "[route]\nbody",
      "```\n[route class=debug\n```",
      "    [route class=debug\nbody",
      "body\n[route class=debug",
      "no route here",
    ]) {
      expect(parse(text).malformed).toBeUndefined();
      expect(parse(text, "any").malformed).toBeUndefined();
    }
  });
});
