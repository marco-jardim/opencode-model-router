/**
 * #90 P2.1: real-host proof of the TUI status plugin (G1 footer, G2 child view, G3 running row) on OpenCode v2.0.24,
 * 2.0.25 and 2.0.26 (plan §3 P2.1, §8 A6/A7/A10/A11).
 *
 *   RUN_OC_SMOKE_TUI=1 npx vitest run --config vitest.smoke.config.ts test/smoke/tui-status.smoke.test.ts   (npm run smoke:tui)
 *
 * - Without RUN_OC_SMOKE_TUI=1 every test is skipped.
 * - OMR_TUI_SMOKE_BINS: `;`-separated OpenCode 2 executables (default: the three known local installs); a missing one is
 *   skipped with its path. OMR_TUI_SMOKE_OUT: evidence directory (screens, summary JSON); default `<real temp>/omr-tui-smoke`.
 *
 * Per version: one isolated HOME, a scripted Anthropic provider (`RoutingProvider`), the server config `opencode.json`
 * listing THIS checkout (local path) and a probe plugin, so the host loads the router's server entry and auto-loads its
 * TUI entry (A4, no `cli.json`). `opencode.exe --standalone --auto` runs in a 150x45 pty mirrored by a headless xterm
 * (helpers/tui-pty.ts). The versions run in parallel (one host each); every step has its own deadline (≤ 90 s).
 *
 *   S1  G1: the home prompt footer shows `effort default`; after ctrl+t (variant.cycle) the host row shows the variant and
 *       the footer shows no `effort` from the plugin; cycling back restores `effort default`.
 *   S2  G3: the root prompt makes the scripted model call `subagent` (agent `fast`); the provider holds the child's first
 *       response; a `fast · <model> · <effort>` row appears above the composer while the child runs and disappears after.
 *       A6: the row is on screen before the child's first token (the held response).
 *   S3  G2: a second held delegation; Down (session.child.first: subagent picker), Down, Enter navigates to the child;
 *       its view shows `fast · <model> · <effort>`.
 *   S4  the effort shown for the child equals the router's tier effort for the scripted model (preset below).
 *   Recorded (not asserted): the row with the sidebar toggled (<leader>b = ctrl+x b), and the lines above the composer
 *   when no delegate runs (empty-box gap).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  PROBE_PLUGIN, ROOT, ROOT_MODEL, RUN_ID, RoutingProvider, SMOKE_PRESET, delay, effectiveEffort, redactText, ref, type Obj,
} from "./helpers/routing-host";
import { KEY, TuiSession, isolatedTuiEnv, opencodePids, processTable, type TuiStop } from "./helpers/tui-pty";

const RUN = process.env.RUN_OC_SMOKE_TUI === "1";
const REAL_TMP = process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir();
const DEFAULT_BINS = [
  path.join(homedir(), "scoop", "apps", "opencode2", "2.0.24", "opencode.exe"),
  path.join(REAL_TMP, "Claude", "omr-a9", "oc-2.0.25", "package", "bin", "opencode.exe"),
  path.join(homedir(), "scoop", "apps", "opencode2", "2.0.26", "opencode.exe"),
];
const BINS = (process.env.OMR_TUI_SMOKE_BINS ?? DEFAULT_BINS.join(";")).split(";").map(s => s.trim()).filter(Boolean);
const OUT = process.env.OMR_TUI_SMOKE_OUT || path.join(REAL_TMP, "omr-tui-smoke");
const versionOf = (exe: string, index: number) => /(\d+\.\d+\.\d+)/.exec(exe)?.[1] ?? `bin${index}`;
const TARGETS = BINS.map((exe, i) => ({ version: versionOf(exe, i), exe, present: existsSync(exe) }));

/** The fast tier carries an effort different from its variant, so the screen shows which source it follows (A11d). */
const TUI_PRESET = { ...SMOKE_PRESET, fast: { ...SMOKE_PRESET.fast, effort: "medium" } };
/** What the child views must show for the fast tier: the plugin's `effortWithVariant` rule (A11d). */
const EXPECTED_CHILD_EFFORT = TUI_PRESET.fast.effort === TUI_PRESET.fast.variant ? TUI_PRESET.fast.effort : `${TUI_PRESET.fast.effort} (${TUI_PRESET.fast.variant})`;
const HOLD_MARKER = "TUI_SMOKE_HOLD";
const STEP_MS = 90_000;
const FLOW_MS = 330_000;

type CheckId = "boot" | "S1-default" | "S1-variant" | "S1-restore" | "S2-G3" | "A6" | "S3-G2" | "S4-effort" | "sidebar" | "gap";
interface Check { pass: boolean; detail: string; lines: string[]; data?: Obj }
interface Flow {
  version: string; exe: string; checks: Partial<Record<CheckId, Check>>; errors: string[];
  stop?: TuiStop; holds?: Obj[]; childWire?: Obj[]; requests?: Obj[]; notes?: string[]; logFile: string;
}
interface Row { index: number; line: string; model: string; effort: string }

/** `fast · <model> · <effort>` (the plugin's G2/G3 row for the fast tier), with its screen line index. */
const ROW_RE = /(?:^|[\s│┃|])fast · (.+?) · (\S+(?: \([^)]*\))?)/;
function findRow(lines: readonly string[]): Row | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i]!);
    if (m) return { index: i, line: lines[i]!.trim(), model: m[1]!.trim(), effort: m[2]!.trim() };
  }
  return undefined;
}
/** The plugin's G1 footer text (`effort <value>`), not any other "effort" word on screen. */
const FOOTER_RE = /(?:^|\s)effort ([\w-]+(?: \([^)]*\))?)(?=\s*(?:[│┃]|$|\s{2,}))/;
const footerOf = (lines: readonly string[]) => { for (const l of lines) { const m = FOOTER_RE.exec(l); if (m) return { line: l.trim(), value: m[1]! }; } return undefined; };
const footerIndex = (lines: readonly string[]) => lines.findIndex(l => FOOTER_RE.test(l));
/** The host's prompt metadata row of the root model inside the prompt box (`┃  Build auto · Claude Opus … · <variant>`),
 * the bottom-most one: a transcript line (`Build · Claude Opus 4.7 · 15.7s`) has no box border. -1 when there is no prompt. */
const ROOT_META_RE = /^\s*┃\s+\S.*·.*Opus/i;
const rootMetaIndex = (lines: readonly string[]) => { for (let i = lines.length - 1; i >= 0; i--) if (ROOT_META_RE.test(lines[i]!)) return i; return -1; };
const rootMetaOf = (lines: readonly string[]) => { const i = rootMetaIndex(lines); return i >= 0 ? lines[i]!.trim() : undefined; };
/** First line of the prompt box (the contiguous `┃` block that ends at the metadata row). */
const composerTop = (lines: readonly string[], meta: number) => { let i = meta; while (i > 0 && /^\s*┃/.test(lines[i - 1]!)) i--; return i; };
/** Right-hand panel content (the sidebar at 150 columns) on any line above the prompt box. */
const sidebarShown = (lines: readonly string[], until: number) => lines.slice(0, Math.max(0, until)).some(l => l.length > 112 && /\S/.test(l.slice(108)));
const notices = (lines: readonly string[]) => lines.filter(l => /model-router status|Solid owner|plugin failed|failed to load/i.test(l)).map(l => l.trim());
const around = (lines: readonly string[], index: number, before = 2, after = 3) => lines.slice(Math.max(0, index - before), index + after + 1);
const tail = (lines: readonly string[], n = 14) => lines.slice(-n);

async function writeHostFiles(root: string, home: string, baseURL: string): Promise<Record<string, string>> {
  const configDir = path.join(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const probe = path.join(root, "probe-plugin");
  await mkdir(probe, { recursive: true });
  await writeFile(path.join(probe, "package.json"), JSON.stringify({ name: "routing-smoke-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  await writeFile(path.join(probe, "server.mjs"), PROBE_PLUGIN);
  // Server config only: the router (local path = this checkout) and the probe; the host auto-loads the router's TUI entry (A4).
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: ref(ROOT_MODEL),
    plugins: [ROOT, probe],
    providers: { anthropic: { settings: { baseURL, apiKey: "keyless-smoke-fake" } } },
  }, null, 1));
  await writeFile(path.join(configDir, "opencode-model-router.overrides.jsonc"), JSON.stringify({
    activePreset: "smoke", defaultTier: "fast", presets: { smoke: TUI_PRESET },
    enforcement: { verify: { testBaseline: false } },
    routing: { engine: "shadow", outcomes: { path: path.join(root, "outcomes") } },
  }, null, 1));
  const logs = { SMOKE_HOOKS: path.join(root, "hooks.jsonl"), SMOKE_EVENTS: path.join(root, "events.jsonl"), SMOKE_DUMP: path.join(root, "dump.json") };
  for (const file of [logs.SMOKE_HOOKS, logs.SMOKE_EVENTS]) await writeFile(file, "");
  return { ...logs, OPENCODE_FILEWATCHER_DISABLE: "true" };
}

async function submit(tui: TuiSession, text: string): Promise<void> {
  await tui.type(text);
  await delay(400);
  tui.send(KEY.enter);
}

async function runFlow(version: string, exe: string): Promise<Flow> {
  const logFile = path.join(OUT, `${RUN_ID.slice(0, 8)}-${version}.screens.txt`);
  const flow: Flow = { version, exe, checks: {}, errors: [], logFile };
  writeFileSync(logFile, `# ${version} ${exe}\n`);
  const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), `omr-tui-${version}-`)));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(project, { recursive: true });
  const provider = new RoutingProvider();
  let tui: TuiSession | undefined;
  const set = (id: CheckId, check: Check) => { flow.checks[id] = check; tui?.note(`${id}: ${check.pass ? "PASS" : "FAIL"} ${check.detail}`); };
  const step = async (id: CheckId, body: () => Promise<void>) => {
    try { await body(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flow.errors.push(`${id}: ${message.slice(0, 4_000)}`);
      if (!flow.checks[id]) set(id, { pass: false, detail: `error: ${message.split("\n")[0]}`, lines: tui ? await tui.screen() : [] });
    }
  };
  const hardStop = setTimeout(() => { void tui?.stop(); }, FLOW_MS);
  try {
    const baseURL = await provider.start();
    const extra = await writeHostFiles(root, home, baseURL);
    const env = isolatedTuiEnv(home, extra);
    tui = await TuiSession.spawn({ label: version, executable: exe, args: ["--standalone", "--auto"], cwd: project, env, logFile });
    const t = tui;

    // ---- boot + S1 (G1) ----
    let bootLines: string[] = [];
    await step("boot", async () => {
      const hit = await t.waitScreen("boot: home footer", footerOf, STEP_MS);
      bootLines = hit.lines;
      set("boot", { pass: true, detail: `home footer after ${((hit.at - t.t0) / 1000).toFixed(1)} s`, lines: around(hit.lines, footerIndex(hit.lines), 6, 0) });
    });
    await step("S1-default", async () => {
      await delay(1_500);
      const lines = await t.snap("S1 home");
      const footer = footerOf(lines);
      set("S1-default", { pass: footer?.value === "default", detail: `footer ${JSON.stringify(footer?.line)}; host row ${JSON.stringify(rootMetaOf(lines))}; notices ${JSON.stringify(notices(lines))}`, lines: footer ? around(lines, footerIndex(lines), 6, 0) : tail(bootLines) });
    });
    await step("S1-variant", async () => {
      const before = rootMetaOf(await t.screen());
      t.send(KEY.ctrlT);
      const hit = await t.waitScreen("S1: variant selected", lines => {
        const meta = rootMetaOf(lines);
        return footerOf(lines) === undefined && meta !== undefined && meta !== before ? meta : undefined;
      }, 20_000);
      const variant = hit.value.split(" · ").at(-1)?.trim();
      set("S1-variant", { pass: true, detail: `host row ${JSON.stringify(before)} -> ${JSON.stringify(hit.value)} (variant ${JSON.stringify(variant)}); plugin footer absent`, lines: around(hit.lines, rootMetaIndex(hit.lines), 3, 2), data: { before, after: hit.value, variant } });
    });
    await step("S1-restore", async () => {
      const seen: string[] = [];
      for (let press = 1; press <= 8; press++) {
        t.send(KEY.ctrlT);
        await delay(1_200);
        const lines = await t.snap(`S1 restore ${press}`);
        seen.push(rootMetaOf(lines) ?? "?");
        const footer = footerOf(lines);
        if (footer?.value === "default") { set("S1-restore", { pass: true, detail: `\`effort default\` back after ${press} more ctrl+t; host rows ${JSON.stringify(seen)}`, lines: around(lines, footerIndex(lines), 2, 0) }); return; }
      }
      set("S1-restore", { pass: false, detail: `no \`effort default\` after 8 ctrl+t; host rows ${JSON.stringify(seen)}`, lines: tail(await t.screen()) });
    });

    // ---- S2 (G3 + A6 + sidebar + gap) ----
    await step("S2-G3", async () => {
      provider.holdMarked(HOLD_MARKER, 15_000);
      await submit(t, `SPIKE_CALL=${JSON.stringify({ agent: "fast", description: "tui smoke one", prompt: `${HOLD_MARKER} one`, background: false })}`);
      const sentAt = Date.now();
      const deadline = sentAt + STEP_MS;
      const changes: { at: number; row?: string }[] = [];
      let first: { at: number; row: Row; lines: string[] } | undefined;
      let last: { at: number; row: Row; lines: string[] } | undefined;
      let gone: { at: number; lines: string[] } | undefined;
      let sidebarDone = false;
      while (Date.now() < deadline) {
        const lines = await t.screen();
        const now = Date.now();
        const row = findRow(lines);
        if ((changes.at(-1)?.row) !== row?.line) { changes.push({ at: now, row: row?.line }); await t.snap(`S2 ${row ? "row" : "no row"}`); }
        if (row) {
          first ??= { at: now, row, lines };
          last = { at: now, row, lines };
          if (!sidebarDone && now - first.at > 1_500) {
            sidebarDone = true;
            const shownBefore = sidebarShown(lines, row.index + 1);
            t.send(KEY.ctrlX); await delay(200); t.send("b"); await delay(1_500);
            const toggled = await t.snap("S2 sidebar toggled");
            const sideRow = findRow(toggled);
            const shownAfter = sidebarShown(toggled, (sideRow?.index ?? toggled.length) + 1);
            const state = (shown: boolean) => (shown ? "open" : "closed");
            const below = (ls: readonly string[], r?: Row) => (r ? ls[r.index + 1]?.trim() ?? "" : "");
            const effortNow = row.effort;
            const whole = (r?: Row) => r !== undefined && r.effort === effortNow && /sonnet/i.test(r.model);
            set("sidebar", {
              pass: whole(row) && whole(sideRow),
              detail: `sidebar ${state(shownBefore)}: row ${JSON.stringify(row.line)} (next line ${JSON.stringify(below(lines, row))}); after <leader>b sidebar ${state(shownAfter)}: row ${JSON.stringify(sideRow?.line)} (next line ${JSON.stringify(below(toggled, sideRow))}); one line, all three parts, in both states: ${whole(row) && whole(sideRow)}`,
              lines: [...around(lines, row.index, 1, 1), "-- toggled --", ...(sideRow ? around(toggled, sideRow.index, 1, 1) : tail(toggled))],
            });
            t.send(KEY.ctrlX); await delay(200); t.send("b"); await delay(800);
            await t.snap("S2 sidebar toggled back");
          }
        }
        const hold = provider.holds[0];
        if (first && !row && hold?.releasedAt !== undefined && lines.some(l => l.includes("ROOT_DONE"))) { gone = { at: now, lines }; break; }
        await delay(100);
      }
      const hold = provider.holds[0];
      const rel = (at?: number) => at === undefined ? "n/a" : `${((at - sentAt) / 1000).toFixed(1)} s`;
      const meta = first ? rootMetaIndex(first.lines) : -1;
      const above = first !== undefined && meta >= 0 && first.row.index < meta;
      set("S2-G3", {
        pass: first !== undefined && gone !== undefined && hold?.releasedAt !== undefined && gone.at > hold.releasedAt && above,
        detail: `row ${JSON.stringify(last?.row.line)} first at ${rel(first?.at)}, last at ${rel(last?.at)}, gone at ${rel(gone?.at)} (child request held ${rel(hold?.arrivedAt)} -> ${rel(hold?.releasedAt)}); row line ${first?.row.index} above the root host row line ${meta}: ${above}`,
        lines: first ? around(first.lines, first.row.index, 3, 6) : tail(await t.screen()),
        data: { changes: changes.map(c => ({ t: rel(c.at), row: c.row })), goneScreen: gone ? tail(gone.lines) : undefined, footer: first ? footerOf(first.lines)?.line : undefined },
      });
      set("A6", {
        pass: first !== undefined && hold?.releasedAt !== undefined && first.at < hold.releasedAt,
        detail: `row first seen ${rel(first?.at)}; child's first request reached the provider ${rel(hold?.arrivedAt)}; its first token was released ${rel(hold?.releasedAt)} => row before the first token: ${first !== undefined && hold?.releasedAt !== undefined && first.at < hold.releasedAt}; before the request even arrived: ${first !== undefined && hold !== undefined && first.at < hold.arrivedAt}`,
        lines: first ? around(first.lines, first.row.index) : [],
        data: { firstRowEffort: first?.row.effort, lastRowEffort: last?.row.effort },
      });
      if (gone && first) {
        // Recorded only: the prompt box is bottom-anchored, so its top line with and without the row is the same and the
        // row takes the line above it; the transcript here is too short to show a blank line left by an empty box.
        const lines = gone.lines;
        const metaNow = rootMetaIndex(lines);
        const topNow = metaNow >= 0 ? composerTop(lines, metaNow) : -1;
        const topWithRow = meta >= 0 ? composerTop(first.lines, meta) : -1;
        set("gap", {
          pass: topNow === topWithRow && first.row.index === topWithRow - 1 && !findRow(lines),
          detail: `prompt box top line ${topWithRow} with the row (row on line ${first.row.index}) and ${topNow} without it; line above the box without the row: ${JSON.stringify(lines[topNow - 1]?.slice(0, 100).trim() ?? "")}`,
          lines: topNow >= 0 ? lines.slice(Math.max(0, topNow - 4), metaNow + 3) : tail(lines),
        });
      }
    });

    // ---- S3 (G2) + S4 ----
    await step("S3-G2", async () => {
      provider.holdMarked(HOLD_MARKER, 30_000);
      await submit(t, `SPIKE_CALL=${JSON.stringify({ agent: "fast", description: "tui smoke two", prompt: `${HOLD_MARKER} two`, background: false })}`);
      const g3 = await t.waitScreen("S3: G3 row of the second delegation", findRow, 30_000);
      await delay(800);
      t.send(KEY.down);
      const picker = await t.waitScreen("S3: subagent picker", lines => lines.some(l => /Subagents/.test(l)) ? true : undefined, 10_000);
      await delay(500);
      t.send(KEY.down);
      await delay(600);
      await t.snap("S3 picker moved");
      t.send(KEY.enter);
      const child = await t.waitScreen("S3: child view row", lines => rootMetaOf(lines) === undefined ? findRow(lines) : undefined, 15_000);
      const runningRow = child.value;
      const hold = provider.holds.at(-1);
      const running = hold?.releasedAt === undefined;
      // After the held answer: the child goes idle and its view keeps the row.
      const idle = await t.waitScreen("S3: child idle (CHILD_OK)", lines => lines.some(l => l.includes("CHILD_OK")) ? findRow(lines) ?? null : undefined, 45_000);
      set("S3-G2", {
        pass: runningRow.effort.length > 0 && /sonnet/i.test(runningRow.model) && idle.value !== null,
        detail: `child view row ${JSON.stringify(runningRow.line)} (child still held: ${running}); after the answer ${JSON.stringify(idle.value?.line)}; picker opened: ${picker.value}; G3 row before navigating ${JSON.stringify(g3.value.line)}`,
        lines: around(child.lines, runningRow.index, 3, 8),
        data: { idleScreen: idle.value ? around(idle.lines, idle.value.index, 3, 6) : tail(idle.lines) },
      });
      const g3Effort = (flow.checks["A6"]?.data?.lastRowEffort as string | undefined);
      set("S4-effort", {
        pass: g3Effort === EXPECTED_CHILD_EFFORT && runningRow.effort === EXPECTED_CHILD_EFFORT && idle.value?.effort === EXPECTED_CHILD_EFFORT,
        detail: `expected ${JSON.stringify(EXPECTED_CHILD_EFFORT)} (fast tier effort ${TUI_PRESET.fast.effort}, variant ${TUI_PRESET.fast.variant}); G3 ${JSON.stringify(g3Effort)}, G2 running ${JSON.stringify(runningRow.effort)}, G2 idle ${JSON.stringify(idle.value?.effort)}`,
        lines: [runningRow.line, idle.value?.line ?? ""],
      });
    });
  } catch (error) {
    flow.errors.push(`flow: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(hardStop);
    if (tui) flow.stop = await tui.stop();
    const childSessions = new Set(provider.holds.map(h => h.session).filter((s): s is string => typeof s === "string"));
    flow.holds = provider.holds.map(h => ({ ...h }));
    flow.childWire = provider.requests.filter(r => r.session !== undefined && childSessions.has(r.session)).map(r => ({ seq: r.seq, session: r.session, agent: r.agent, catalogModel: r.catalogModel, wireModel: r.model, effort: effectiveEffort(r) }));
    flow.requests = provider.requests.map(r => ({ seq: r.seq, session: r.session, agent: r.agent, kind: r.kind, catalogModel: r.catalogModel, tools: r.toolNames.length, reply: r.reply, lastText: r.lastText.slice(0, 60) }));
    // A tool-less auxiliary request (the host's session title) whose text quotes SPIKE_CALL makes the fixture refuse it (400):
    // expected noise of a TUI-created session, kept apart from real provider errors.
    const auxiliary = (e: string) => /carries no such tool \(\)/.test(e);
    flow.notes = provider.errors.filter(auxiliary).map(e => `auxiliary request refused by the fixture: ${e}`);
    const real = provider.errors.filter(e => !auxiliary(e));
    if (real.length > 0) flow.errors.push(`provider: ${real.join(" | ")}`);
    await provider.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(error => flow.errors.push(`cleanup: ${String(error)}`));
    writeFileSync(path.join(OUT, `${RUN_ID.slice(0, 8)}-${version}.summary.json`), redactText(JSON.stringify(flow, null, 2)));
  }
  return flow;
}

const d = RUN ? describe : describe.skip;
d("TUI status on real OpenCode v2 hosts (#90 P2.1)", () => {
  const flows = new Map<string, Promise<Flow>>();
  let pidsBefore: number[] = [];
  beforeAll(() => {
    mkdirSync(OUT, { recursive: true });
    pidsBefore = opencodePids(processTable());
    // Started here, awaited by the tests: the versions run in parallel (≤ 3 hosts, staggered spawns).
    TARGETS.filter(target => target.present).slice(0, 3).forEach((target, i) => {
      flows.set(target.version, delay(i * 4_000).then(() => runFlow(target.version, target.exe)));
    });
  });
  afterAll(async () => {
    const done = await Promise.all(flows.values());
    await delay(1_000);
    const pidsAfter = opencodePids(processTable());
    const own = done.flatMap(f => f.stop?.tree ?? []);
    const record = { runId: RUN_ID, pidsBefore, pidsAfter, ownTrees: own, newAfter: pidsAfter.filter(p => !pidsBefore.includes(p)), gone: pidsBefore.filter(p => !pidsAfter.includes(p)) };
    writeFileSync(path.join(OUT, `${RUN_ID.slice(0, 8)}-pids.json`), JSON.stringify(record, null, 2));
  }, FLOW_MS + 60_000);

  for (const target of TARGETS) {
    describe(`OpenCode ${target.version}`, () => {
      if (!target.present) {
        it.skip(`skipped: executable not found (${target.exe})`, () => undefined);
        return;
      }
      const check = async (id: CheckId) => {
        const flow = await flows.get(target.version)!;
        const c = flow.checks[id];
        expect(c, `${id} not reached; errors: ${flow.errors.join(" || ")}`).toBeDefined();
        expect(c!.pass, `${id}: ${c!.detail}\n${c!.lines.join("\n")}`).toBe(true);
        return c!;
      };
      const opts = { timeout: FLOW_MS + 30_000 };
      it("boots with the plugin's footer on the home screen", opts, async () => { await check("boot"); });
      it("S1 G1: home footer shows `effort default`", opts, async () => { await check("S1-default"); });
      it("S1 G1: a selected variant shows in the host row and the plugin shows no effort", opts, async () => { await check("S1-variant"); });
      it("S1 G1: cycling back to no variant restores `effort default`", opts, async () => { await check("S1-restore"); });
      it("S2 G3: a running-delegate row above the composer while the child runs, gone after", opts, async () => { await check("S2-G3"); });
      it("S2 A6: the row is on screen before the child's first token", opts, async () => { await check("A6"); });
      it("S3 G2: the child session view shows `fast · <model> · <effort>`", opts, async () => { await check("S3-G2"); });
      it(`S4: the child's effort is the fast tier's (${EXPECTED_CHILD_EFFORT})`, opts, async () => { await check("S4-effort"); });
      it("recorded: sidebar toggled and empty-box gap", opts, async () => {
        // Recorded for the report and DF-1, not asserted (the dispatch's "record, do not over-engineer").
        const flow = await flows.get(target.version)!;
        expect(flow.checks.sidebar, `sidebar not recorded; errors: ${flow.errors.join(" || ")}`).toBeDefined();
        expect(flow.checks.gap, `gap not recorded; errors: ${flow.errors.join(" || ")}`).toBeDefined();
      });
      it("teardown: every process this run spawned is gone", opts, async () => {
        const flow = await flows.get(target.version)!;
        expect(flow.stop, `no stop record; errors: ${flow.errors.join(" || ")}`).toBeDefined();
        expect(flow.stop!.survivors).toEqual([]);
      });
    });
  }
});
