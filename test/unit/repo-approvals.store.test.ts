/**
 * Cross-repo Phase 4, P4.2: the approvals store (`src/routing/roles/approvals.ts`), no git.
 * Plan `docs/design/cross-repo-phase4-plan.md` SD-P4-1..3 (store, bad data, writes), SD-P4-8 (protected list),
 * SD-P4-9 (origin), QA cases 3, 5 and 6. Every test uses its own temp directory and an injected clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { configPath, overridePath, statePath } from "../../src/router/config";
import {
  APPROVALS_FILE_NAME,
  MAX_APPROVALS,
  MAX_APPROVALS_BYTES,
  applyApproval,
  approvalsPath,
  expiresAt,
  isApprovalValid,
  protectedLocations,
  protectedProblem,
  readApprovals,
  resetApprovalsState,
  sanitizeOrigin,
  type ApprovalsEnv,
  type NewRepoApproval,
} from "../../src/routing/roles/approvals";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const ROOT_A = "a".repeat(40);
const ROOT_B = "b".repeat(40);
const ROOT_C = "c".repeat(64);

let dir: string;
let now: number;
let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

function env(extra: Partial<ApprovalsEnv> = {}): ApprovalsEnv {
  return { dir, now: () => now, warn, ...extra };
}

function file(): string {
  return approvalsPath(env());
}

function repo(name: string): string {
  return join(dir, "repos", name);
}

function approval(name: string, roots: string[] = [ROOT_A], origin?: string): NewRepoApproval {
  return { path: repo(name), commonDir: join(repo(name), ".git"), roots, origin };
}

/** A valid raw stored entry. */
function raw(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: repo(name),
    commonDir: join(repo(name), ".git"),
    roots: [ROOT_A],
    origin: "none",
    approvedAt: T0 - DAY,
    lastUsedAt: T0 - DAY,
    ...over,
  };
}

function writeRaw(content: unknown): void {
  writeFileSync(file(), typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

function paths(): string[] {
  return readApprovals(env()).approvals.map((a) => a.path);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omr-approvals-"));
  now = T0;
  warn = vi.fn<(message: string) => void>();
  resetApprovalsState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("store path (SD-P4-1)", () => {
  it("lives next to the router state, or in the injected directory", () => {
    expect(approvalsPath()).toBe(join(dirname(statePath()), "opencode-model-router.repo-approvals.json"));
    expect(file()).toBe(join(dir, APPROVALS_FILE_NAME));
  });
});

describe("readApprovals", () => {
  it("a missing file is an empty store, without a notice", () => {
    const r = readApprovals(env());
    expect(r).toMatchObject({ file: file(), approvals: [], dropped: [] });
    expect(r.invalid).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("round trip: put, then read, gives the stored entry with sorted roots and a sanitized origin", async () => {
    const out = await applyApproval({ kind: "put", approval: approval("x", [ROOT_B, ROOT_A], "https://u:tok@example.invalid/x.git?t=1#f"), days: 14 }, env());
    expect(out.status).toBe("written");
    const r = readApprovals(env());
    expect(r.invalid).toBeUndefined();
    expect(r.approvals).toEqual([{
      path: repo("x"),
      commonDir: join(repo("x"), ".git"),
      roots: [ROOT_A, ROOT_B],
      origin: "https://example.invalid/x.git",
      approvedAt: T0,
      lastUsedAt: T0,
    }]);
    const disk = JSON.parse(readFileSync(file(), "utf8")) as { version: number; approvals: unknown[] };
    expect(disk.version).toBe(1);
    expect(disk.approvals).toHaveLength(1);
    expect(readFileSync(file(), "utf8")).not.toContain("tok");
  });

  it.each([
    ["not JSON", "{nope", "not valid JSON"],
    ["an unknown version", JSON.stringify({ version: 2, approvals: [] }), "unknown version"],
    ["a string version", JSON.stringify({ version: "1", approvals: [] }), "unknown version"],
    ["no approvals array", JSON.stringify({ version: 1 }), "no approvals array"],
    ["an array at the top", "[]", "not a JSON object"],
  ])("a file with %s gives no approvals and one notice", (_what, content, problem) => {
    writeRaw(content);
    const a = readApprovals(env());
    const b = readApprovals(env());
    expect(a.approvals).toEqual([]);
    expect(a.invalid).toContain(problem);
    expect(b.invalid).toBe(a.invalid);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(file());
  });

  it("a directory in place of the file is invalid", () => {
    mkdirSync(file());
    expect(readApprovals(env()).invalid).toContain("not a regular file");
  });

  it("checks the size first: exactly 256 KiB is read, one byte more is invalid", () => {
    const body = JSON.stringify({ version: 1, approvals: [raw("x")] });
    writeRaw(body + " ".repeat(MAX_APPROVALS_BYTES - Buffer.byteLength(body)));
    expect(readApprovals(env()).approvals.map((a) => a.path)).toEqual([repo("x")]);
    writeRaw(body + " ".repeat(MAX_APPROVALS_BYTES - Buffer.byteLength(body) + 1));
    const r = readApprovals(env());
    expect(r.approvals).toEqual([]);
    expect(r.invalid).toContain("larger than 256 KiB");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("32 entries are read; 33 make the file invalid", () => {
    const list = Array.from({ length: MAX_APPROVALS }, (_v, i) => raw(`r${i}`));
    writeRaw({ version: 1, approvals: list });
    expect(readApprovals(env()).approvals).toHaveLength(32);
    writeRaw({ version: 1, approvals: [...list, raw("r32")] });
    const r = readApprovals(env());
    expect(r.approvals).toEqual([]);
    expect(r.invalid).toContain("more than 32 entries");
  });

  it("drops each invalid entry and keeps the valid ones (strict validation)", () => {
    const bad: Record<string, unknown>[] = [
      raw("rel", { path: "repos/rel" }),
      raw("dots", { path: `${dir}${sep}repos${sep}..${sep}dots` }),
      raw("trail", { path: `${repo("trail")}${sep}` }),
      raw("glob", { path: `${repo("glob")}*` }),
      raw("ctrl", { path: `${repo("ctrl")}\u0007` }),
      raw("device", { path: `\\\\?\\${repo("device")}` }),
      raw("cdir", { commonDir: ".git" }),
      raw("hex", { roots: ["xyz"] }),
      raw("upper", { roots: ["A".repeat(40)] }),
      raw("short", { roots: ["a".repeat(39)] }),
      raw("noroots", { roots: [] }),
      raw("duproots", { roots: [ROOT_A, ROOT_A] }),
      raw("order", { approvedAt: T0 - DAY, lastUsedAt: T0 - 2 * DAY }),
      raw("future", { lastUsedAt: T0 + 5 * MIN + 1 }),
      raw("frac", { approvedAt: 1.5 }),
      raw("str", { lastUsedAt: String(T0) }),
      raw("neg", { approvedAt: -1 }),
      raw("cred", { origin: "https://u:tok@example.invalid/x.git" }),
      raw("long", { origin: "x".repeat(201) }),
      raw("extra", { approve: "yes" }),
      raw("noorigin", { origin: undefined }),
    ];
    const good = [
      raw("ok"),
      raw("edge", { lastUsedAt: T0 + 5 * MIN }),
      raw("sorted", { roots: [ROOT_C, ROOT_A] }),
    ];
    writeRaw({ version: 1, approvals: [...bad, 7, null, "x", ...good] });
    const r = readApprovals(env());
    expect(r.invalid).toBeUndefined();
    expect(r.approvals.map((a) => a.path)).toEqual([repo("ok"), repo("edge"), repo("sorted")]);
    expect(r.approvals[2]!.roots).toEqual([ROOT_A, ROOT_C]);
    expect(r.dropped).toHaveLength(bad.length + 3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops both copies of a duplicate path", () => {
    const twin = process.platform === "win32" ? repo("Twin").toUpperCase() : repo("twin");
    writeRaw({ version: 1, approvals: [raw("twin"), raw("keep"), raw("twin", { path: twin, commonDir: join(twin, ".git") })] });
    const r = readApprovals(env());
    expect(r.approvals.map((a) => a.path)).toEqual([repo("keep")]);
    expect(r.dropped.filter((d) => d.includes("duplicate"))).toHaveLength(2);
  });

  it("keeps expired entries (for /router repos); validity is the caller's check", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    now = T0 + 20 * DAY;
    const [entry] = readApprovals(env()).approvals;
    expect(entry).toBeDefined();
    expect(isApprovalValid(entry!, 14, now)).toBe(false);
  });

  it("drops an entry whose times are in the future after the clock moved back more than 5 minutes", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    now = T0 - 5 * MIN;
    expect(paths()).toEqual([repo("x")]);
    now = T0 - 5 * MIN - 1;
    expect(paths()).toEqual([]);
  });
});

describe("expiry: min(lastUsedAt + days, approvedAt + 90 days); valid iff now < expiresAt", () => {
  const fresh = { approvedAt: T0, lastUsedAt: T0 };
  it("exactly at expiry is expired, 1 ms before is valid", () => {
    expect(expiresAt(fresh, 14)).toBe(T0 + 14 * DAY);
    expect(isApprovalValid(fresh, 14, T0 + 14 * DAY - 1)).toBe(true);
    expect(isApprovalValid(fresh, 14, T0 + 14 * DAY)).toBe(false);
  });
  it("1 day and 90 days", () => {
    expect(expiresAt(fresh, 1)).toBe(T0 + DAY);
    expect(isApprovalValid(fresh, 1, T0 + DAY - 1)).toBe(true);
    expect(isApprovalValid(fresh, 1, T0 + DAY)).toBe(false);
    expect(expiresAt(fresh, 90)).toBe(T0 + 90 * DAY);
    expect(isApprovalValid(fresh, 90, T0 + 90 * DAY - 1)).toBe(true);
    expect(isApprovalValid(fresh, 90, T0 + 90 * DAY)).toBe(false);
  });
  it("the 90-day cap holds despite frequent use", () => {
    const used = { approvedAt: T0, lastUsedAt: T0 + 89 * DAY };
    expect(expiresAt(used, 14)).toBe(T0 + 90 * DAY);
    expect(isApprovalValid(used, 14, T0 + 90 * DAY - 1)).toBe(true);
    expect(isApprovalValid(used, 14, T0 + 90 * DAY)).toBe(false);
  });
  it("lowering the days later shortens an existing approval", () => {
    expect(isApprovalValid(fresh, 30, T0 + 20 * DAY)).toBe(true);
    expect(isApprovalValid(fresh, 14, T0 + 20 * DAY)).toBe(false);
  });
  it("days outside 1..90 are clamped", () => {
    expect(expiresAt(fresh, 0)).toBe(T0 + DAY);
    expect(expiresAt(fresh, 500)).toBe(T0 + 90 * DAY);
  });
  it("a use slightly in the future (within the 5 min a stored time may be ahead) counts from that time", () => {
    const ahead = { approvedAt: T0, lastUsedAt: T0 + 4 * MIN };
    expect(expiresAt(ahead, 1)).toBe(T0 + 4 * MIN + DAY);
  });
});

describe("applyApproval (SD-P4-3)", () => {
  it("put replaces the entry of the same path and resets approvedAt", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    now = T0 + 10 * DAY;
    const out = await applyApproval({ kind: "put", approval: approval("x", [ROOT_B]), days: 14 }, env());
    expect(out).toMatchObject({ status: "written", entry: { approvedAt: T0 + 10 * DAY, lastUsedAt: T0 + 10 * DAY, roots: [ROOT_B] } });
    expect(readApprovals(env()).approvals).toHaveLength(1);
  });

  it("put refuses an invalid entry and writes nothing", async () => {
    const out = await applyApproval({ kind: "put", approval: { path: "relative", commonDir: "relative/.git", roots: [ROOT_A] }, days: 14 }, env());
    expect(out).toMatchObject({ status: "refused", reason: "invalid-entry" });
    expect(existsSync(file())).toBe(false);
    const roots = await applyApproval({ kind: "put", approval: approval("x", ["nothex"]), days: 14 }, env());
    expect(roots).toMatchObject({ status: "refused", reason: "invalid-entry" });
  });

  it("put refuses at 32 live entries, replaces at 32, and drops expired entries to make room", async () => {
    for (let i = 0; i < MAX_APPROVALS; i++) {
      expect((await applyApproval({ kind: "put", approval: approval(`r${i}`), days: 14 }, env())).status).toBe("written");
    }
    const full = await applyApproval({ kind: "put", approval: approval("r32"), days: 14 }, env());
    expect(full).toMatchObject({ status: "refused", reason: "full" });
    if (full.status === "refused") expect(full.message).toContain(file());
    expect(readApprovals(env()).approvals).toHaveLength(32);
    expect((await applyApproval({ kind: "put", approval: approval("r5", [ROOT_B]), days: 14 }, env())).status).toBe("written");
    expect(readApprovals(env()).approvals).toHaveLength(32);
    now = T0 + 14 * DAY;
    expect((await applyApproval({ kind: "put", approval: approval("late"), days: 14 }, env())).status).toBe("written");
    expect(paths()).toEqual([repo("late")]);
  });

  it("delete removes the entry and reads back; an unknown path is absent", async () => {
    await applyApproval({ kind: "put", approval: approval("a"), days: 14 }, env());
    await applyApproval({ kind: "put", approval: approval("b"), days: 14 }, env());
    expect(await applyApproval({ kind: "delete", path: repo("a") }, env())).toMatchObject({ status: "written" });
    expect(paths()).toEqual([repo("b")]);
    expect(await applyApproval({ kind: "delete", path: repo("a") }, env())).toMatchObject({ status: "unchanged", reason: "absent" });
  });

  it("put and delete refuse on an invalid file and name it; touch leaves it alone", async () => {
    writeRaw("{corrupt");
    const put = await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    expect(put).toMatchObject({ status: "refused", reason: "invalid-store" });
    if (put.status === "refused") expect(put.message).toContain(file());
    expect(await applyApproval({ kind: "delete", path: repo("x") }, env())).toMatchObject({ status: "refused", reason: "invalid-store" });
    expect(await applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_A], days: 14 }, env())).toMatchObject({ status: "unchanged" });
    expect(readFileSync(file(), "utf8")).toBe("{corrupt");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("writes through a tmp file and a rename: a crash before the rename leaves the old file", async () => {
    await applyApproval({ kind: "put", approval: approval("a"), days: 14 }, env());
    const before = readFileSync(file(), "utf8");
    let tmp = "";
    let tmpExisted = false;
    let fileDuring = "";
    const out = await applyApproval({ kind: "put", approval: approval("b"), days: 14 }, env({
      beforeRename: (t) => {
        tmp = t;
        tmpExisted = existsSync(t);
        fileDuring = readFileSync(file(), "utf8");
        throw new Error("simulated crash");
      },
    }));
    expect(out).toMatchObject({ status: "refused", reason: "io" });
    expect(tmpExisted).toBe(true);
    expect(dirname(tmp)).toBe(dirname(file()));
    expect(tmp).not.toBe(file());
    expect(fileDuring).toBe(before);
    expect(readFileSync(file(), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((n) => n !== "repos")).toEqual([basename(file())]);
  });

  it("runs writes one at a time in the process: concurrent puts lose nothing", async () => {
    const outs = await Promise.all(["a", "b", "c", "d", "e"].map((n) => applyApproval({ kind: "put", approval: approval(n), days: 14 }, env())));
    expect(outs.every((o) => o.status === "written")).toBe(true);
    expect(paths().sort()).toEqual(["a", "b", "c", "d", "e"].map(repo).sort());
  });

  it("a touch racing a revoke never resurrects the entry (either order)", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    now = T0 + 2 * HOUR;
    const [del, touch] = await Promise.all([
      applyApproval({ kind: "delete", path: repo("x") }, env()),
      applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_A], days: 14 }, env()),
    ]);
    expect(del.status).toBe("written");
    expect(touch).toMatchObject({ status: "unchanged", reason: "absent" });
    expect(paths()).toEqual([]);

    resetApprovalsState();
    await applyApproval({ kind: "put", approval: approval("y"), days: 14 }, env());
    now += 2 * HOUR;
    const [touch2, del2] = await Promise.all([
      applyApproval({ kind: "touch", path: repo("y"), roots: [ROOT_A], days: 14 }, env()),
      applyApproval({ kind: "delete", path: repo("y") }, env()),
    ]);
    expect(touch2.status).toBe("written");
    expect(del2.status).toBe("written");
    expect(paths()).toEqual([]);
  });

  it("touch needs the same path and roots, and a valid entry", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    await applyApproval({ kind: "put", approval: approval("x", [ROOT_B]), days: 14 }, env());
    now = T0 + 2 * HOUR;
    expect(await applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_A], days: 14 }, env()))
      .toMatchObject({ status: "unchanged", reason: "mismatch" });
    expect(await applyApproval({ kind: "touch", path: repo("other"), roots: [ROOT_B], days: 14 }, env()))
      .toMatchObject({ status: "unchanged", reason: "absent" });
    now = T0 + 14 * DAY;
    expect(await applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_B], days: 14 }, env()))
      .toMatchObject({ status: "unchanged", reason: "expired" });
    expect(readApprovals(env()).approvals[0]!.lastUsedAt).toBe(T0);
  });

  it("touch writes at most once per hour per path", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    const touch = () => applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_A], days: 14 }, env());
    now = T0 + 30 * MIN;
    expect(await touch()).toMatchObject({ status: "unchanged", reason: "throttled" });
    now = T0 + HOUR - 1;
    expect(await touch()).toMatchObject({ status: "unchanged", reason: "throttled" });
    now = T0 + HOUR;
    expect(await touch()).toMatchObject({ status: "written", entry: { lastUsedAt: T0 + HOUR, approvedAt: T0 } });
    expect(readApprovals(env()).approvals[0]!.lastUsedAt).toBe(T0 + HOUR);
    // within the hour: no I/O at all (a corrupt file is not even read)
    writeRaw("{corrupt");
    now = T0 + HOUR + 59 * MIN;
    expect(await touch()).toMatchObject({ status: "unchanged", reason: "throttled" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("touch extends the use window but never past the 90-day cap", async () => {
    await applyApproval({ kind: "put", approval: approval("x"), days: 14 }, env());
    for (let d = 10; d <= 89; d += 10) {
      now = T0 + d * DAY;
      expect((await applyApproval({ kind: "touch", path: repo("x"), roots: [ROOT_A], days: 14 }, env())).status).toBe("written");
    }
    const [entry] = readApprovals(env()).approvals;
    expect(isApprovalValid(entry!, 14, T0 + 90 * DAY - 1)).toBe(true);
    expect(isApprovalValid(entry!, 14, T0 + 90 * DAY)).toBe(false);
  });
});

describe("protectedProblem (SD-P4-8)", () => {
  beforeEach(() => {
    for (const v of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) vi.stubEnv(v, "");
  });

  const config = () => join(homedir(), ".config", "opencode");

  it("lists the opencode dirs, the plugin install dir, the store dir and the user profile", () => {
    const locs = protectedLocations(env());
    const has = (label: string, d: string) => locs.some((l) => l.label === label && resolve(l.dir) === resolve(d));
    expect(has("the opencode config directory", dirname(overridePath()))).toBe(true);
    expect(has("the opencode data directory", join(homedir(), ".local", "share", "opencode"))).toBe(true);
    expect(has("the opencode state directory", join(homedir(), ".local", "state", "opencode"))).toBe(true);
    expect(has("the opencode cache directory", join(homedir(), ".cache", "opencode"))).toBe(true);
    expect(has("the plugin install directory", dirname(configPath()))).toBe(true);
    expect(has("the approvals store directory", dir)).toBe(true);
    expect(locs.find((l) => l.label === "the user profile")).toMatchObject({ dir: homedir(), mode: "equal-or-ancestor" });
  });

  it.each([
    ["config", () => config()],
    ["data", () => join(homedir(), ".local", "share", "opencode")],
    ["state", () => join(homedir(), ".local", "state", "opencode")],
    ["cache", () => join(homedir(), ".cache", "opencode")],
    ["plugin install", () => dirname(configPath())],
    ["store", () => dir],
    // Phase 4 QA (m4).
    ["~/.opencode", () => join(homedir(), ".opencode")],
  ])("the %s directory is refused equal, as an ancestor and inside", (_name, target) => {
    const t = target();
    expect(protectedProblem(t, t, env())).toMatch(/^is /);
    expect(protectedProblem(dirname(t), dirname(t), env())).toMatch(/^(contains|is) /);
    expect(protectedProblem(join(t, "sub", "repo"), join(t, "sub", "repo"), env())).toMatch(/^is (inside|the) /);
  });

  it("OPENCODE_CONFIG_DIR and the XDG dirs are protected when set", () => {
    const custom = join(dir, "occfg");
    const xdgData = join(dir, "xdg-data");
    vi.stubEnv("OPENCODE_CONFIG_DIR", custom);
    vi.stubEnv("XDG_DATA_HOME", xdgData);
    const other = { ...env(), dir: join(dir, "store") };
    expect(protectedProblem(custom, custom, other)).toContain("OPENCODE_CONFIG_DIR");
    expect(protectedProblem(join(custom, "x"), join(custom, "x"), other)).toContain("is inside OPENCODE_CONFIG_DIR");
    expect(protectedProblem(join(xdgData, "opencode"), join(xdgData, "opencode"), other)).toContain("data directory");
    expect(protectedProblem(xdgData, xdgData, other)).toContain("contains the opencode data directory");
  });

  it("the directory of the OPENCODE_CONFIG file is protected (equal, ancestor, inside) when set (Phase 4 QA m4)", () => {
    const cfgDir = join(dir, "cfgfile");
    const other = { ...env(), dir: join(dir, "store") };
    expect(protectedLocations(other).some((l) => l.label === "the directory of OPENCODE_CONFIG")).toBe(false);
    vi.stubEnv("OPENCODE_CONFIG", join(cfgDir, "opencode.json"));
    expect(protectedLocations(other).find((l) => l.label === "the directory of OPENCODE_CONFIG")).toMatchObject({ dir: cfgDir, mode: "any" });
    expect(protectedProblem(cfgDir, cfgDir, other)).toContain("is the directory of OPENCODE_CONFIG");
    expect(protectedProblem(join(cfgDir, "x"), join(cfgDir, "x"), other)).toContain("is inside the directory of OPENCODE_CONFIG");
    expect(protectedProblem(dir, dir, other)).toMatch(/^contains /);
    // The canonical form alone is enough (a link to it).
    const unrelated = join(parse(process.cwd()).root, "omr-p4-unrelated-candidate");
    expect(protectedProblem(unrelated, cfgDir, other)).toContain("is the directory of OPENCODE_CONFIG");
    // A relative file name resolves against the working directory, as opencode reads it.
    vi.stubEnv("OPENCODE_CONFIG", "opencode.json");
    expect(protectedLocations(other).find((l) => l.label === "the directory of OPENCODE_CONFIG")?.dir).toBe(resolve(process.cwd()));
  });

  it("~/.opencode is protected in mode any (Phase 4 QA m4)", () => {
    const dotOpencode = join(homedir(), ".opencode");
    expect(protectedLocations(env()).find((l) => l.label === "the ~/.opencode directory")).toMatchObject({ dir: dotOpencode, mode: "any" });
    expect(protectedProblem(dotOpencode, dotOpencode, env())).toContain("is the ~/.opencode directory");
    expect(protectedProblem(join(dotOpencode, "plugin"), join(dotOpencode, "plugin"), env())).toContain("is inside the ~/.opencode directory");
  });

  it("the user profile is refused equal or as an ancestor, but not inside", () => {
    const home = homedir();
    expect(protectedProblem(home, home, env())).toContain("is the user profile");
    expect(protectedProblem(dirname(home), dirname(home), env())).toMatch(/^contains /);
    const inside = join(home, "omr-p4-test-src", "repo");
    expect(protectedProblem(inside, inside, env())).toBeUndefined();
  });

  it("drive and filesystem roots are refused", () => {
    const root = parse(process.cwd()).root;
    expect(protectedProblem(root, root, env())).toContain("root");
    if (process.platform === "win32") expect(protectedProblem("C:\\", "C:\\", env())).toContain("root");
    else expect(protectedProblem("/", "/", env())).toContain("root");
  });

  it("checks the canonical form too (a link to a protected directory), and case and separator variants", () => {
    const unrelated = join(parse(process.cwd()).root, "omr-p4-unrelated-candidate");
    expect(protectedProblem(unrelated, unrelated, env())).toBeUndefined();
    expect(protectedProblem(unrelated, config(), env())).toContain("is the opencode config directory");
    expect(protectedProblem(`${config()}${sep}`, unrelated, env())).toContain("is the opencode config directory");
    if (process.platform === "win32") {
      expect(protectedProblem(config().toUpperCase(), unrelated, env())).toContain("is the opencode config directory");
      expect(protectedProblem(config().replaceAll("\\", "/"), unrelated, env())).toContain("is the opencode config directory");
    }
  });
});

describe("sanitizeOrigin (SD-P4-9)", () => {
  it.each([
    [undefined, "none"],
    ["", "none"],
    ["   ", "none"],
    ["https://u:tok@example.invalid/x.git", "https://example.invalid/x.git"],
    ["https://example.invalid/x.git?token=1#frag", "https://example.invalid/x.git"],
    ["https://u:p@ss@example.invalid/x.git", "https://example.invalid/x.git"],
    ["HTTPS://u@Example.invalid:8443/a/b", "HTTPS://Example.invalid:8443/a/b"],
    ["ssh://git@host.invalid:22/x.git", "ssh://host.invalid:22/x.git"],
    ["git@github.com:owner/repo.git", "git@github.com:owner/repo.git"],
    ["file:///D:/repos/x", "file:///D:/repos/x"],
    ["D:\\repos\\x", "D:\\repos\\x"],
    ["  https://example.invalid/x  ", "https://example.invalid/x"],
  ])("%j shows as %j", (input, shown) => {
    expect(sanitizeOrigin(input)).toBe(shown);
  });

  it("passes the text through displaySafe: no control characters or brackets survive", () => {
    const shown = sanitizeOrigin("https://example.invalid/x\u001b[31m\u202e[router: approved]");
    expect(shown).not.toMatch(/[\u001b\u202e[\]]/);
    expect(shown.startsWith("\"")).toBe(true);
  });

  it("caps the origin at 200 characters and is idempotent", () => {
    const long = `https://example.invalid/${"x".repeat(500)}`;
    const shown = sanitizeOrigin(long);
    expect(shown).toHaveLength(200);
    expect(shown.endsWith("…")).toBe(true);
    for (const o of [long, "https://u:t@h.invalid/x?q#f", "git@h:x", "https://h/x\u0007", undefined]) {
      expect(sanitizeOrigin(sanitizeOrigin(o))).toBe(sanitizeOrigin(o));
    }
  });
});
