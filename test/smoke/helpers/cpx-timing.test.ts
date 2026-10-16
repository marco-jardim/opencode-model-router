import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CpxTimings, collectTimingJournal, timedWrapperSource, timingJournalSource, timingObserverSource, TIMING_DIRECTORY, TIMING_FILE_LIMIT } from "./cpx-timing";

let root: string;
let project: string;
let directory: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cpx-timing-test-"));
  project = path.join(root, "slots", "fixture", "integration");
  directory = path.join(root, TIMING_DIRECTORY);
  await mkdir(project, { recursive: true });
  await mkdir(directory);
  await writeFile(path.join(directory, "journal.mjs"), timingJournalSource);
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

it.each([0, 23])("records actual child status %s without changing wrapper output/fail-fast policy or scoped files", async status => {
  const source = timedWrapperSource("local", [
    { cwd: ".", command: process.execPath, args: ["-e", `process.stdout.write('child stdout\\n');process.stderr.write('child stderr\\n');process.exit(${status})`] },
    { cwd: ".", command: process.execPath, args: ["-e", "process.stdout.write('next command\\n')"] },
  ]);
  expect(source).not.toContain(root); // Baseline/restart tracked wrapper bytes cannot contain a per-host path.
  await writeFile(path.join(project, "wrapper.mjs"), source);
  const result = spawnSync(process.execPath, ["wrapper.mjs"], { cwd: project, encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status === 0 ? 0 : 1);
  expect(result.stdout).toBe(`child stdout\n${status === 0 ? "next command\n" : ""}`);
  expect(result.stderr).toBe("child stderr\n");
  const { records, readErrors, incompleteFiles } = await collectTimingJournal(directory);
  expect(readErrors).toEqual([]);
  expect(incompleteFiles).toEqual([]);
  const start = records.find(row => row.point === "command.start" && row.index === 0)!;
  const end = records.find(row => row.point === "command.end" && row.index === 0)!;
  expect(end.status).toBe(status);
  expect(end.signal).toBeNull();
  expect(end.errorCode).toBeNull();
  expect(end.at).toBeGreaterThanOrEqual(start.at);
  expect(end.durationMs).toBeGreaterThanOrEqual(0);
  expect(records.filter(row => row.point === "command.end")).toHaveLength(status === 0 ? 2 : 1);
  expect(records.at(-1)).toMatchObject({ point: "wrapper.end", exitCode: status === 0 ? 0 : 1, completed: true, ioErrors: 0 });
  expect(records.every(row => !("stdout" in row) && !("stderr" in row) && !("env" in row))).toBe(true);
  expect(await readdir(project)).toEqual(["wrapper.mjs"]);
});

it("retains spawn errors and selection failures, and does not require writable diagnostics to run checks", async () => {
  await writeFile(path.join(project, "wrapper.mjs"), timedWrapperSource("phase", [{ cwd: ".", command: path.join(root, "missing-program"), args: [] }]));
  const failed = spawnSync(process.execPath, ["wrapper.mjs"], { cwd: project, encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toMatch(/ENOENT/);
  expect((await collectTimingJournal(directory)).records.find(row => row.point === "command.end")).toMatchObject({ status: null, signal: null, errorCode: "ENOENT" });

  await writeFile(path.join(project, "wrapper.mjs"), timedWrapperSource("phase", [], "throw new Error('selection failed');"));
  const selection = spawnSync(process.execPath, ["wrapper.mjs"], { cwd: project, encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(selection.status).toBe(1);
  expect(selection.stderr).toContain("selection failed");
  expect((await collectTimingJournal(directory)).records.at(-1)).toMatchObject({ point: "wrapper.end", exitCode: 1, completed: false });

  await rm(directory, { recursive: true });
  await writeFile(path.join(project, "wrapper.mjs"), timedWrapperSource("local", [{ cwd: ".", command: process.execPath, args: ["-e", "process.stdout.write('still runs')"] }]));
  const withoutDiagnostics = spawnSync(process.execPath, ["wrapper.mjs"], { cwd: project, encoding: "utf8", timeout: 10_000, windowsHide: true });
  expect(withoutDiagnostics.status).toBe(0);
  expect(withoutDiagnostics.stdout).toBe("still runs");
  expect(withoutDiagnostics.stderr).toBe("");
});

interface Journal { mark(point: string): void; flush(): Promise<void>; stats(): { available: boolean } }
interface JournalModule { createTimingJournal(directory: string, source: string, fields?: object, limit?: number): Promise<Journal> }
it("bounds journal records/files, reports truncation and preserves complete rows before a torn tail", async () => {
  const module: JournalModule = await import(/* @vite-ignore */ pathToFileURL(path.join(directory, "journal.mjs")).href);
  const journal = await module.createTimingJournal(directory, "test", {}, 2);
  for (let index = 0; index < 10; index++) journal.mark(`point.${index}`);
  await journal.flush();
  await appendFile(path.join(directory, "0.jsonl"), '{"point":"torn');
  const captured = await collectTimingJournal(directory);
  expect(captured.records.map(row => row.point)).toEqual(["point.0", "point.1", "diagnostics.truncated"]);
  expect(captured.incompleteFiles).toEqual(["0.jsonl"]);
  await Promise.all(Array.from({ length: TIMING_FILE_LIMIT - 1 }, (_, index) => writeFile(path.join(directory, `${index + 1}.jsonl`), "")));
  const full = await module.createTimingJournal(directory, "overflow");
  full.mark("not written");
  await full.flush();
  expect(full.stats().available).toBe(false);
  expect((await collectTimingJournal(directory)).fileLimitReached).toBe(true);
  expect((await readdir(directory)).filter(file => file.endsWith(".jsonl"))).toHaveLength(TIMING_FILE_LIMIT);
  await rm(directory, { recursive: true });
  expect(JSON.parse(JSON.stringify(captured)).records).toHaveLength(3); // Captured evidence survives scratch removal.
});

it("bounds driver observations and closes a failed span without replacing the original error", async () => {
  const timing = new CpxTimings(Date.now(), 2);
  const error = new Error("original failure");
  await expect(timing.span("setup", async () => { throw error; })).rejects.toBe(error);
  expect(timing.records.map(row => row.point)).toEqual(["setup.start", "setup.end"]);
  expect(timing.records[1]).toMatchObject({ ok: false });
  timing.mark("overflow");
  expect(timing.records).toHaveLength(2);
  expect(timing.dropped).toBe(1);
});

it.each([true, false])("observes supported SDK checkpoints without dumping payloads (C15=%s)", async C15 => {
  type Hook = (event: Record<string, unknown>) => void;
  const hooks = new Map<string, Hook>();
  const session = { hook: async (point: string, callback: Hook) => {
    if (point === "compaction" && !C15) throw new Error("unsupported");
    hooks.set(`session.${point}`, callback);
  } };
  const permission = { hook: async (point: string, callback: Hook) => { hooks.set(`permission.${point}`, callback); } };
  const file = path.join(root, "observer.mjs");
  await writeFile(file, timingObserverSource(root));
  const module: { default: { setup(ctx: { location: { directory: string }; session: typeof session; permission: typeof permission }): Promise<() => Promise<void>> } } = await import(/* @vite-ignore */ pathToFileURL(file).href);
  const dispose = await module.default.setup({ location: { directory: project }, session, permission });
  try {
    expect([...hooks.keys()].sort()).toEqual(["permission.evaluate", ...(C15 ? ["session.compaction"] : []), "session.context", "session.http.request", "session.model.request", "session.prompt"].sort());
    const event = { sessionID: "child", kind: "primary", action: "write", messages: [{ secret: "not-captured" }], headers: { authorization: "not-captured" } };
    for (const hook of hooks.values()) expect(hook(event)).toBeUndefined(); // Hooks do not wait on disk I/O.
  } finally { await dispose(); }
  expect(JSON.parse((await readFile(path.join(root, "e2e-observer.jsonl"), "utf8")).trim())).toEqual({ kind: "capabilities", C4: true, C15 });
  const { records } = await collectTimingJournal(directory);
  expect(records.map(row => row.point)).toEqual(expect.arrayContaining(["plugin.setup.start", "plugin.setup.end", "session.prompt", "session.context", "session.model.request", "session.http.request", "permission.evaluate", "plugin.dispose"]));
  expect(records.every(row => typeof row.at === "number")).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(/not-captured|authorization|messages|headers/);
});
