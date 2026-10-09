/**
 * #90 P2.1: real-host proof of the TUI status plugin (G1 footer, G2 child view, G3 running row) on OpenCode v2.0.24,
 * 2.0.25 and 2.0.26 (plan §3 P2.1, §8 A6/A7/A9/A10/A11).
 *
 *   RUN_OC_SMOKE_TUI=1 npx vitest run --config vitest.smoke.config.ts test/smoke/tui-status.smoke.test.ts   (npm run smoke:tui)
 *
 * - Without RUN_OC_SMOKE_TUI=1 every test is skipped; off Windows the suite is skipped (ConPTY, taskkill, Win32_Process).
 * - OMR_TUI_SMOKE_BINS: `;`-separated OpenCode 2 executables (default: the three known local installs; duplicates
 *   dropped); a missing one is skipped with its path. OMR_TUI_SMOKE_OUT: evidence directory (screens, summary JSON);
 *   default `<real temp>/omr-tui-smoke`.
 *
 * Per version, three flows, each with its own isolated HOME, scripted Anthropic provider (`RoutingProvider`) and server
 * config `opencode.json` listing the router package directory and a probe plugin (the host auto-loads the router's TUI
 * entry, A4/A9). G3 is opt-in since A12 (`runningRow` defaults to false), so the two G3 flows also write the TUI config
 * `cli.json` (A10) with `{"plugins":[{"package":"<the same package directory>","options":{"runningRow":true}}]}`, which
 * replaces the auto-loaded registration (A4):
 *   local  `plugins: [<this checkout>, <probe>]` + `cli.json` runningRow — S1, S2, S3, S4 below;
 *   npm    `plugins: [<root>/install/node_modules/opencode-model-router, <probe>]` + `cli.json` runningRow, the checkout
 *          `npm pack`ed once and installed with `npm install --no-save --ignore-scripts <tgz>` (peers included) — boot,
 *          S1 default, S2, S4;
 *   off    `plugins: [<this checkout>, <probe>]`, no `cli.json` (default options) — boot, S1 default, D below.
 * Both G3 flows and the off flow also assert one registration only (one footer text, one row).
 * `opencode.exe --standalone --auto` runs in a 150x45 pty mirrored by a headless xterm (helpers/tui-pty.ts); at most 3
 * hosts run at once; every step has its own deadline (≤ 90 s) and every key waits for its expected screen change.
 *
 *   S1  G1: the home prompt footer shows `effort default`; after ctrl+t (variant.cycle) the host row ends with a variant
 *       and the footer shows no `effort`; cycling back restores `effort default`.
 *   S2  G3: the root prompt makes the scripted model call `subagent` (agent `fast`); the provider holds the child's first
 *       response; a `fast · <model> · <effort>` row appears on the line directly above the prompt box while the child
 *       runs and disappears after. A6: the row is on screen before the child's first token.
 *   S3  G2: a second held delegation; Down (subagent picker, one running entry), Enter navigates to the child; its view
 *       (its own prompt text, no root marker) shows `fast · <model> · <effort>` while the child is still held.
 *   S4  the effort shown for the child equals the router's tier effort (preset below), and every child request on the
 *       wire carries that effort for the `#low` variant.
 *   D   A12 default: a held delegation; for at least 8 s after the child's request reaches the provider (the child still
 *       held, the host showing its running subagent) the root view shows no `fast · …` row and its footer still reads
 *       `effort default`; then the S3 navigation opens the child, whose view (G2) shows the row while it runs.
 *   Recorded: the row with the sidebar toggled and toggled back (<leader>b = ctrl+x b), and the lines above the prompt
 *   box when no delegate runs (empty-box gap).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  PROBE_PLUGIN, ROOT, ROOT_MODEL, RUN_ID, RoutingProvider, SMOKE_PRESET, delay, effectiveEffort, redactText, ref, type Obj,
} from "./helpers/routing-host";
import { KEY, TuiSession, identity, isolatedTuiEnv, opencodePids, processTable, type ProcessRow, type TuiStop } from "./helpers/tui-pty";

const execFileAsync = promisify(execFile);
const RUN = process.env.RUN_OC_SMOKE_TUI === "1";
const WINDOWS = process.platform === "win32";
const REAL_TMP = process.env.OMR_SMOKE_REAL_TMPDIR || tmpdir();
const DEFAULT_BINS = [
  path.join(homedir(), "scoop", "apps", "opencode2", "2.0.24", "opencode.exe"),
  path.join(REAL_TMP, "Claude", "omr-a9", "oc-2.0.25", "package", "bin", "opencode.exe"),
  path.join(homedir(), "scoop", "apps", "opencode2", "2.0.26", "opencode.exe"),
];
const OUT = process.env.OMR_TUI_SMOKE_OUT || path.join(REAL_TMP, "omr-tui-smoke");
const RUN8 = RUN_ID.slice(0, 8);

/** Binaries, de-duplicated by resolved path (case-insensitive), labelled by version (suffixed when two share one). */
const TARGETS = (() => {
  const seen = new Set<string>();
  const list: { label: string; exe: string; present: boolean }[] = [];
  for (const raw of (process.env.OMR_TUI_SMOKE_BINS ?? DEFAULT_BINS.join(";")).split(";").map(s => s.trim()).filter(Boolean)) {
    const key = path.resolve(raw).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const version = /(\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? `bin${list.length}`;
    const label = list.some(t => t.label === version) ? `${version}#${list.length}` : version;
    list.push({ label, exe: raw, present: existsSync(raw) });
  }
  return list;
})();
type FlowKind = "local" | "npm" | "off";
interface Job { index: number; label: string; exe: string; kind: FlowKind }
/** Flows keyed by index: per present binary, the local-path flow, the node_modules flow, then the default-options flow. */
const JOBS: Job[] = TARGETS.filter(t => t.present).flatMap(t => (["local", "npm", "off"] as const).map(kind => ({ label: t.label, exe: t.exe, kind }))).map((j, index) => ({ ...j, index }));
/** The TUI options the flow writes to `cli.json` (A12: G3 is opt-in); none for the default-options flow. */
const TUI_OPTIONS: Record<FlowKind, Obj | undefined> = { local: { runningRow: true }, npm: { runningRow: true }, off: undefined };
const FLOW_TITLES: Record<FlowKind, string> = {
  local: "local path (this checkout), cli.json runningRow: true",
  npm: "node_modules install (npm pack), cli.json runningRow: true",
  off: "local path, default options (server config only, no cli.json): runningRow off (A12)",
};
const MAX_HOSTS = 3;

/** The fast tier carries an effort different from its variant, so the screen shows which source it follows (A11d). */
const TUI_PRESET = { ...SMOKE_PRESET, fast: { ...SMOKE_PRESET.fast, effort: "medium" } };
/** What the child views must show for the fast tier: the plugin's `effortWithVariant` rule (A11d). */
const EXPECTED_CHILD_EFFORT = TUI_PRESET.fast.effort === TUI_PRESET.fast.variant ? TUI_PRESET.fast.effort : `${TUI_PRESET.fast.effort} (${TUI_PRESET.fast.variant})`;
const VARIANTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const HOLD_MARKER = "TUI_SMOKE_HOLD";
const STEP_MS = 90_000;
const FLOW_MS = 330_000;
const INSTALL_MS = 240_000;

type CheckId = "boot" | "S1-default" | "S1-variant" | "S1-restore" | "S2-G3" | "A6" | "S3-G2" | "S4-effort" | "sidebar" | "gap" | "A12-no-row" | "A12-G2";
interface Check { pass: boolean; detail: string; lines: string[]; data?: Obj }
interface Flow {
  index: number; label: string; kind: FlowKind; exe: string; plugin?: string; cliJson?: Obj; checks: Partial<Record<CheckId, Check>>; errors: string[];
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
/** How many plugin footer texts the footer line holds (2 would mean the TUI entry is registered twice). */
const footerCount = (lines: readonly string[]) => { const i = footerIndex(lines); return i < 0 ? 0 : (lines[i]!.match(/(?:^|\s)effort [\w-]+/g) ?? []).length; };
/** How many lines carry a `fast · …` row. */
const rowCount = (lines: readonly string[]) => lines.filter(l => ROW_RE.test(l)).length;
/** The host's own sign of a running delegation in the root view: its inline `… Subagent — <description>` line or the footer's `1 subagent`. */
const hostShowsSubagent = (lines: readonly string[], description: string) => lines.some(l => l.includes(`Subagent — ${description}`) || /\b1 subagent\b/.test(l));
/** The host's prompt metadata row of the root model inside the prompt box (`┃  Build auto · Claude Opus … · <variant>`),
 * the bottom-most one: a transcript line (`Build · Claude Opus 4.7 · 15.7s`) has no box border. -1 when there is no prompt. */
const ROOT_META_RE = /^\s*┃\s+\S.*·.*Opus/i;
const rootMetaIndex = (lines: readonly string[]) => { for (let i = lines.length - 1; i >= 0; i--) if (ROOT_META_RE.test(lines[i]!)) return i; return -1; };
const rootMetaOf = (lines: readonly string[]) => { const i = rootMetaIndex(lines); return i >= 0 ? lines[i]!.trim() : undefined; };
const lastSegment = (meta: string | undefined) => meta?.split(" · ").at(-1)?.trim();
/** First line of the prompt box (the contiguous `┃` block that ends at the metadata row). */
const composerTop = (lines: readonly string[], meta: number) => { let i = meta; while (i > 0 && /^\s*┃/.test(lines[i - 1]!)) i--; return i; };
/** The session sidebar (right of column 100 at 150 columns): its `Getting started` box or context figures. */
const sidebarOpen = (lines: readonly string[]) => lines.some(l => /Getting started|Context|tokens|spent/.test(l.slice(100)));
const notices = (lines: readonly string[]) => lines.filter(l => /model-router status|Solid owner|plugin failed|failed to load/i.test(l)).map(l => l.trim());
const around = (lines: readonly string[], index: number, before = 2, after = 3) => lines.slice(Math.max(0, index - before), index + after + 1);
const tail = (lines: readonly string[], n = 14) => lines.slice(-n);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ------------------------------------------------------------------ npm pack + install (P21-2) ----
/** npm's CLI script, run with this Node (no shell; `.cmd` shims need one). */
function npmCli(): string {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  const found = candidates.find((c): c is string => typeof c === "string" && c.endsWith(".js") && existsSync(c));
  if (!found) throw new Error(`npm-cli.js not found (${candidates.join(" | ")})`);
  return found;
}
/** One run's npm state (R2-1): a private cache shared by the run's installs and an empty user config (registry: npm's default). */
interface NpmRun { readonly cache: string; readonly userconfig: string }
function npmRun(): NpmRun {
  const dir = mkdtempSync(path.join(tmpdir(), "omr-tui-npm-"));
  const cache = path.join(dir, "npm-cache");
  mkdirSync(cache, { recursive: true });
  const userconfig = path.join(dir, "empty.npmrc");
  writeFileSync(userconfig, "");
  return { cache, userconfig };
}
/**
 * The caller's environment for npm without credential-shaped, OpenCode/router or npm_* (the outer `npm run` config,
 * e.g. its local prefix) variables, plus the run's own cache, no log files and an empty user config.
 */
function npmEnv(run: NpmRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) || /^(npm_|OPENCODE|MODEL_ROUTER|OMR_|SMOKE_|RUN_OC_)/i.test(name)) continue;
    env[name] = value;
  }
  return { ...env, npm_config_cache: run.cache, npm_config_logs_max: "0", npm_config_userconfig: run.userconfig };
}
async function npm(run: NpmRun, args: string[], cwd: string, timeout: number): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [npmCli(), ...args], { cwd, env: npmEnv(run), encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return `${stdout}${stderr}`;
}
/** `npm pack` of this checkout into a temp directory; resolves to the tarball. */
async function packOnce(run: NpmRun): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "omr-tui-pack-"));
  await npm(run, ["pack", "--ignore-scripts", "--pack-destination", dir], ROOT, 120_000);
  const tgz = (await readdir(dir)).find(n => n.endsWith(".tgz"));
  if (!tgz) throw new Error(`npm pack wrote no tarball in ${dir}`);
  return path.join(dir, tgz);
}
/** Installs the tarball (and its peers) into `<root>/install`; resolves to the installed package directory. */
async function installInto(run: NpmRun, root: string, tgz: string): Promise<string> {
  const dir = path.join(root, "install");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "omr-tui-smoke-install", version: "0.0.0", private: true }));
  const log = await npm(run, ["install", "--no-save", "--no-audit", "--no-fund", "--ignore-scripts", "--no-package-lock", "--prefix", dir, tgz], dir, INSTALL_MS);
  const pkg = path.join(dir, "node_modules", "opencode-model-router");
  for (const needed of [path.join(pkg, "tui.ts"), path.join(pkg, "server.ts"), path.join(dir, "node_modules", "@opencode-ai", "plugin", "package.json")]) {
    if (!existsSync(needed)) throw new Error(`npm install did not provide ${path.relative(dir, needed)}:\n${log.slice(-2_000)}`);
  }
  return pkg;
}

// --------------------------------------------------------------------------- the host flow ----
async function writeHostFiles(root: string, home: string, baseURL: string, plugin: string, tuiOptions: Obj | undefined): Promise<{ env: Record<string, string>; cliJson?: Obj }> {
  const configDir = path.join(home, ".config", "opencode");
  await mkdir(configDir, { recursive: true });
  const probe = path.join(root, "probe-plugin");
  await mkdir(probe, { recursive: true });
  await writeFile(path.join(probe, "package.json"), JSON.stringify({ name: "routing-smoke-probe", type: "module", exports: { ".": "./server.mjs", "./server": "./server.mjs" } }));
  await writeFile(path.join(probe, "server.mjs"), PROBE_PLUGIN);
  // Server config only: the router (local checkout or installed package) and the probe; the host auto-loads the TUI entry (A4).
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: ref(ROOT_MODEL),
    plugins: [plugin, probe],
    providers: { anthropic: { settings: { baseURL, apiKey: "keyless-smoke-fake" } } },
  }, null, 1));
  await writeFile(path.join(configDir, "opencode-model-router.overrides.jsonc"), JSON.stringify({
    activePreset: "smoke", defaultTier: "fast", presets: { smoke: TUI_PRESET },
    enforcement: { verify: { testBaseline: false } },
    routing: { engine: "shadow", outcomes: { path: path.join(root, "outcomes") } },
  }, null, 1));
  // A12: the TUI config (`cli.json`, A10) re-lists the SAME package directory with options; that entry replaces the
  // auto-loaded registration by id (A4). The package is the directory, never the plugin id or `tui.ts`.
  let cliJson: Obj | undefined;
  if (tuiOptions !== undefined) {
    cliJson = { plugins: [{ package: plugin, options: tuiOptions }] };
    await writeFile(path.join(configDir, "cli.json"), JSON.stringify(cliJson, null, 1));
  }
  const logs = { SMOKE_HOOKS: path.join(root, "hooks.jsonl"), SMOKE_EVENTS: path.join(root, "events.jsonl"), SMOKE_DUMP: path.join(root, "dump.json") };
  for (const file of [logs.SMOKE_HOOKS, logs.SMOKE_EVENTS]) await writeFile(file, "");
  return { env: { ...logs, OPENCODE_FILEWATCHER_DISABLE: "true" }, ...(cliJson ? { cliJson } : {}) };
}

interface ChildView { picker: string[]; running: boolean; child: { row: Row; lines: string[] }; idle: { row: Row | undefined; lines: string[] } }
/**
 * With a delegation running: Down (subagent picker; the child described `description` must be its only running entry),
 * Enter, then the child's own view (its prompt `childMarker`, no root-only `SPIKE_CALL`, not the picker screen) with a
 * `fast · …` row while the child is still held (`running`), and again once it answered (`CHILD_OK`).
 */
async function openChildView(t: TuiSession, provider: RoutingProvider, description: string, childMarker: string, label: string): Promise<ChildView> {
  t.send(KEY.down);
  const picker = await t.waitScreen(`${label}: subagent picker`, lines => {
    if (!lines.some(l => /Subagents\s+Shell/.test(l))) return undefined;
    const running = lines.filter(l => /┃\s+\S.*\s{2,}Running\b/.test(l)).map(l => (/┃\s+(\S.*?)\s{2,}Running\b/.exec(l)?.[1] ?? "").trim());
    return running.length > 0 ? running : undefined;
  }, 10_000);
  if (picker.value.length !== 1 || !picker.value[0]!.includes(description)) throw new Error(`the picker's running entries are ${JSON.stringify(picker.value)}, expected only ${JSON.stringify(description)}`);
  const pickerText = picker.lines.join("\n");
  t.send(KEY.enter);
  const isChildView = (lines: readonly string[]) => lines.join("\n") !== pickerText
    && lines.some(l => l.includes(childMarker) && !l.includes("SPIKE_CALL")) && !lines.some(l => l.includes("SPIKE_CALL"));
  const child = await t.waitScreen(`${label}: child view row`, lines => (isChildView(lines) ? findRow(lines) : undefined), 15_000);
  const held = provider.holds.at(-1);
  const running = held !== undefined && held.releasedAt === undefined;
  const idle = await t.waitScreen(`${label}: child idle (CHILD_OK)`, lines => (isChildView(lines) && lines.some(l => l.includes("CHILD_OK")) ? findRow(lines) ?? null : undefined), 45_000);
  return { picker: picker.value, running, child: { row: child.value, lines: child.lines }, idle: { row: idle.value ?? undefined, lines: idle.lines } };
}

/** Types a `SPIKE_CALL` for the fast tier, waits until the whole text is in the prompt box, submits it and waits for the root request. */
async function delegate(t: TuiSession, provider: RoutingProvider, description: string, prompt: string): Promise<number> {
  const desc = `"description":"${description}"`;
  await t.type(`SPIKE_CALL=${JSON.stringify({ agent: "fast", description, prompt, background: false })}`);
  await t.waitScreen(`typed ${description}`, lines => {
    let at = -1;
    lines.forEach((l, i) => { if (l.includes(desc)) at = i; });
    return at >= 0 && lines.slice(at, at + 3).some(l => l.includes("false}")) ? true : undefined;
  }, 10_000);
  const roots = () => provider.requests.filter(r => r.agent === "build").length;
  const before = roots();
  t.send(KEY.enter);
  const sentAt = Date.now();
  const deadline = sentAt + 15_000;
  while (roots() === before) {
    if (Date.now() > deadline) throw new Error(`no root request after submitting ${description}`);
    await delay(100);
  }
  return sentAt;
}

/** A prompt line holding only a stray `b` (the leader was not armed when `b` arrived). */
const strayB = (lines: readonly string[]) => lines.some(l => /^\s*┃\s+b\s*$/.test(l));
/**
 * `<leader>b` (ctrl+x, then b) until the sidebar is `open`: the leader has no screen effect of its own, so each attempt
 * waits for the sidebar state; when the leader was not armed, `b` lands in the prompt and is erased before the retry.
 */
async function toggleSidebar(t: TuiSession, open: boolean, label: string): Promise<{ lines: string[]; attempts: number }> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    t.send(KEY.ctrlX); await delay(300); t.send("b");
    try {
      const hit = await t.waitScreen(`${label} (attempt ${attempt})`, ls => (sidebarOpen(ls) === open ? ls : undefined), 3_000);
      return { lines: hit.lines, attempts: attempt };
    } catch (error) {
      if (attempt === 3) throw error;
      if (strayB(await t.screen())) {
        t.send("\x7f");
        await t.waitScreen(`${label}: stray b erased`, ls => (strayB(ls) ? undefined : true), 3_000);
      }
      await delay(1_000);
    }
  }
  throw new Error(`${label}: unreachable`);
}

async function runFlow(job: Job, root: string, plugin: Promise<string>): Promise<Flow> {
  const logFile = path.join(OUT, `${RUN8}-${job.label}-${job.kind}.screens.txt`);
  const flow: Flow = { index: job.index, label: job.label, kind: job.kind, exe: job.exe, checks: {}, errors: [], logFile };
  writeFileSync(logFile, `# ${job.label} ${job.kind} ${job.exe}\n`);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  mkdirSync(project, { recursive: true });
  const provider = new RoutingProvider();
  let tui: TuiSession | undefined;
  const set = (id: CheckId, check: Check) => { flow.checks[id] = check; tui?.note(`${id}: ${check.pass ? "PASS" : "FAIL"} ${check.detail}`); };
  const step = async (id: CheckId, body: () => Promise<void>) => {
    try { await body(); } catch (error) {
      flow.errors.push(`${id}: ${message(error).slice(0, 4_000)}`);
      if (!flow.checks[id]) set(id, { pass: false, detail: `error: ${message(error).split("\n")[0]}`, lines: tui ? await tui.screen() : [] });
    }
  };
  const attempt = async (what: string, body: () => Promise<unknown>) => { try { await body(); } catch (error) { flow.errors.push(`${what}: ${message(error)}`); } };
  const hardStop = setTimeout(() => { tui?.stop().catch(() => {}); }, FLOW_MS);
  try {
    flow.plugin = await plugin;
    const baseURL = await provider.start();
    const files = await writeHostFiles(root, home, baseURL, flow.plugin, TUI_OPTIONS[job.kind]);
    if (files.cliJson) flow.cliJson = files.cliJson;
    const env = isolatedTuiEnv(home, files.env);
    tui = await TuiSession.spawn({ label: `${job.label} ${job.kind}`, executable: job.exe, args: ["--standalone", "--auto"], cwd: project, env, logFile });
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
      const count = footerCount(lines);
      set("S1-default", { pass: footer?.value === "default" && count === 1 && notices(lines).length === 0, detail: `footer ${JSON.stringify(footer?.line)} (plugin footer texts: ${count}); host row ${JSON.stringify(rootMetaOf(lines))}; notices ${JSON.stringify(notices(lines))}; cli.json ${flow.cliJson ? "with options" : "absent"}`, lines: footer ? around(lines, footerIndex(lines), 6, 0) : tail(bootLines) });
    });
    if (job.kind === "local") {
      await step("S1-variant", async () => {
        const before = rootMetaOf(await t.screen());
        t.send(KEY.ctrlT);
        const hit = await t.waitScreen("S1: variant selected", lines => {
          const meta = rootMetaOf(lines);
          return footerOf(lines) === undefined && meta !== undefined && meta !== before && VARIANTS.has(lastSegment(meta) ?? "") ? meta : undefined;
        }, 20_000);
        const variant = lastSegment(hit.value);
        const wasVariant = VARIANTS.has(lastSegment(before) ?? "");
        set("S1-variant", { pass: !wasVariant && VARIANTS.has(variant ?? ""), detail: `host row ${JSON.stringify(before)} -> ${JSON.stringify(hit.value)} (variant ${JSON.stringify(variant)}, none before: ${!wasVariant}); plugin footer absent`, lines: around(hit.lines, rootMetaIndex(hit.lines), 3, 2), data: { before, after: hit.value, variant } });
      });
      await step("S1-restore", async () => {
        const seen: string[] = [];
        let previous = rootMetaOf(await t.screen());
        for (let press = 1; press <= 8; press++) {
          t.send(KEY.ctrlT);
          // Wait for the host row to change before judging (and before the next key).
          const changed = await t.waitScreen(`S1 restore ${press}`, lines => { const m = rootMetaOf(lines); return m !== undefined && m !== previous ? m : undefined; }, 5_000);
          previous = changed.value;
          seen.push(changed.value);
          if (!VARIANTS.has(lastSegment(changed.value) ?? "")) {
            const back = await t.waitScreen("S1: effort default back", lines => (footerOf(lines)?.value === "default" ? lines : undefined), 5_000);
            set("S1-restore", { pass: true, detail: `\`effort default\` back after ${press} more ctrl+t; host rows ${JSON.stringify(seen)}`, lines: around(back.lines, footerIndex(back.lines), 2, 0) });
            return;
          }
        }
        set("S1-restore", { pass: false, detail: `no variant-free host row after 8 ctrl+t; host rows ${JSON.stringify(seen)}`, lines: tail(await t.screen()) });
      });
    }

    // ---- D (A12 default: no G3 row, G1 and G2 unchanged), off flow only ----
    if (job.kind === "off") {
      const description = "tui smoke off";
      const childMarker = `${HOLD_MARKER} off`;
      await step("A12-no-row", async () => {
        provider.holdMarked(HOLD_MARKER, 30_000);
        const sentAt = await delegate(t, provider, description, childMarker);
        const rel = (at?: number) => at === undefined ? "n/a" : `${((at - sentAt) / 1000).toFixed(1)} s`;
        // Poll the root view from the submit until 8 s after the child's request reached the provider (still held).
        const deadline = sentAt + STEP_MS;
        let arrivedAt: number | undefined;
        let polls = 0;
        let rowSeen: { at: number; row: Row; lines: string[] } | undefined;
        let hostSeen = false;
        let footerBad: string | undefined;
        let lastLines: string[] = [];
        let releasedDuringWindow = false;
        while (Date.now() < deadline) {
          const lines = await t.screen();
          const now = Date.now();
          polls += 1;
          lastLines = lines;
          const row = findRow(lines);
          if (row && !rowSeen) { rowSeen = { at: now, row, lines }; await t.snap("A12 row seen (unexpected)"); }
          if (hostShowsSubagent(lines, description)) hostSeen = true;
          const footer = footerOf(lines);
          if (footer !== undefined && (footer.value !== "default" || footerCount(lines) !== 1)) footerBad ??= footer.line;
          arrivedAt ??= provider.holds.at(-1)?.arrivedAt;
          if (provider.holds.at(-1)?.releasedAt !== undefined) releasedDuringWindow = true;
          if (arrivedAt !== undefined && now >= arrivedAt + 8_000) break;
          await delay(100);
        }
        const window = await t.snap("A12 root view, child held");
        const footer = footerOf(window);
        const meta = rootMetaIndex(window);
        const top = meta >= 0 ? composerTop(window, meta) : -1;
        const windowMs = arrivedAt === undefined ? 0 : Date.now() - arrivedAt;
        set("A12-no-row", {
          pass: arrivedAt !== undefined && windowMs >= 6_000 && !releasedDuringWindow && rowSeen === undefined && hostSeen && footerBad === undefined && footer?.value === "default",
          detail: `child request reached the provider at ${rel(arrivedAt)} and stayed held for the ${(windowMs / 1000).toFixed(1)} s polled after it (released during the window: ${releasedDuringWindow}); ${polls} polls from the submit: fast row seen ${rowSeen ? `at ${rel(rowSeen.at)}: ${JSON.stringify(rowSeen.row.line)}` : "never"}; host shows the running subagent: ${hostSeen}; footer ${JSON.stringify(footer?.line)}${footerBad ? ` (bad footer seen: ${JSON.stringify(footerBad)})` : ""}; line above the prompt box: ${JSON.stringify(top > 0 ? window[top - 1]!.slice(0, 100).trim() : "")}`,
          lines: meta >= 0 ? window.slice(Math.max(0, top - 6), meta + 3) : tail(lastLines),
        });
      });
      await step("A12-G2", async () => {
        if (provider.holds.length === 0) throw new Error("no held delegation to open (A12-no-row did not start one)");
        const view = await openChildView(t, provider, description, childMarker, "A12");
        const wire = provider.requests.filter(r => r.agent === "fast");
        const wireOk = wire.length >= 1 && wire.every(r => effectiveEffort(r) === TUI_PRESET.fast.effort && (r.catalogModel ?? "").endsWith(`#${TUI_PRESET.fast.variant}`));
        set("A12-G2", {
          pass: view.running && /sonnet/i.test(view.child.row.model) && view.child.row.effort === EXPECTED_CHILD_EFFORT && view.idle.row?.effort === EXPECTED_CHILD_EFFORT && rowCount(view.child.lines) === 1 && wireOk,
          detail: `child view row ${JSON.stringify(view.child.row.line)} while the child is held (running: ${view.running}); after the answer ${JSON.stringify(view.idle.row?.line)}; expected effort ${JSON.stringify(EXPECTED_CHILD_EFFORT)}; picker running entries ${JSON.stringify(view.picker)}; wire ${JSON.stringify(wire.map(r => `${r.catalogModel} effort=${String(effectiveEffort(r))}`))}`,
          lines: around(view.child.lines, view.child.row.index, 8, 6),
          data: { idleScreen: view.idle.row ? around(view.idle.lines, view.idle.row.index, 6, 6) : tail(view.idle.lines) },
        });
      });
      return flow;
    }

    // ---- S2 (G3 + A6, sidebar + gap on the local flow) ----
    await step("S2-G3", async () => {
      provider.holdMarked(HOLD_MARKER, 15_000);
      const sentAt = await delegate(t, provider, "tui smoke one", `${HOLD_MARKER} one`);
      const deadline = sentAt + STEP_MS;
      const changes: { at: number; row?: string }[] = [];
      let first: { at: number; row: Row; lines: string[] } | undefined;
      let last: { at: number; row: Row; lines: string[] } | undefined;
      let gone: { at: number; lines: string[] } | undefined;
      let sidebarDone = job.kind !== "local";
      while (Date.now() < deadline) {
        const lines = await t.screen();
        const now = Date.now();
        const row = findRow(lines);
        if ((changes.at(-1)?.row) !== row?.line) { changes.push({ at: now, row: row?.line }); await t.snap(`S2 ${row ? "row" : "no row"}`); }
        if (row) {
          first ??= { at: now, row, lines };
          last = { at: now, row, lines };
          if (!sidebarDone && now - first.at > 1_000) {
            sidebarDone = true;
            await step("sidebar", async () => {
              const openBefore = sidebarOpen(lines);
              const toggled = await toggleSidebar(t, !openBefore, "S2 sidebar toggled");
              const sideRow = findRow(toggled.lines);
              await delay(1_000);
              const restored = await toggleSidebar(t, openBefore, "S2 sidebar toggled back");
              const backRow = findRow(restored.lines);
              const state = (open: boolean) => (open ? "open" : "closed");
              const below = (ls: readonly string[], r?: Row) => (r ? ls[r.index + 1]?.trim() ?? "" : "");
              const whole = (r?: Row) => r !== undefined && r.effort === row.effort && /sonnet/i.test(r.model);
              set("sidebar", {
                pass: whole(row) && whole(sideRow) && sidebarOpen(restored.lines) === openBefore,
                detail: `sidebar ${state(openBefore)}: row ${JSON.stringify(row.line)} (next line ${JSON.stringify(below(lines, row))}); after <leader>b ${state(!openBefore)}: row ${JSON.stringify(sideRow?.line)} (next line ${JSON.stringify(below(toggled.lines, sideRow))}); after <leader>b again ${state(sidebarOpen(restored.lines))} (restored: ${sidebarOpen(restored.lines) === openBefore}), row ${JSON.stringify(backRow?.line)}; one line, all three parts: ${whole(row) && whole(sideRow)}`,
                lines: [...around(lines, row.index, 1, 1), "-- toggled --", ...(sideRow ? around(toggled.lines, sideRow.index, 1, 1) : tail(toggled.lines))],
                data: { attempts: { toggle: toggled.attempts, back: restored.attempts } },
              });
            });
          }
        }
        const hold = provider.holds[0];
        if (first && !row && hold?.releasedAt !== undefined && lines.some(l => l.includes("ROOT_DONE"))) { gone = { at: now, lines }; break; }
        await delay(100);
      }
      const hold = provider.holds[0];
      const rel = (at?: number) => at === undefined ? "n/a" : `${((at - sentAt) / 1000).toFixed(1)} s`;
      const meta = first ? rootMetaIndex(first.lines) : -1;
      const top = first && meta >= 0 ? composerTop(first.lines, meta) : -1;
      const directlyAbove = first !== undefined && top >= 0 && first.row.index === top - 1;
      const rows = first ? rowCount(first.lines) : 0;
      set("S2-G3", {
        pass: first !== undefined && gone !== undefined && hold?.releasedAt !== undefined && gone.at > hold.releasedAt && directlyAbove && rows === 1,
        detail: `row ${JSON.stringify(last?.row.line)} first at ${rel(first?.at)}, last at ${rel(last?.at)}, gone at ${rel(gone?.at)} (child request held ${rel(hold?.arrivedAt)} -> ${rel(hold?.releasedAt)}); row on line ${first?.row.index}, prompt box top ${top} (directly above: ${directlyAbove}); rows on screen: ${rows}`,
        lines: first ? around(first.lines, first.row.index, 3, 6) : tail(await t.screen()),
        data: { changes: changes.map(c => ({ t: rel(c.at), row: c.row })), goneScreen: gone ? tail(gone.lines) : undefined, footer: first ? footerOf(first.lines)?.line : undefined },
      });
      set("A6", {
        pass: first !== undefined && hold?.releasedAt !== undefined && first.at < hold.releasedAt,
        detail: `row first seen ${rel(first?.at)}; child's first request reached the provider ${rel(hold?.arrivedAt)}; its first token was released ${rel(hold?.releasedAt)} => row before the first token: ${first !== undefined && hold?.releasedAt !== undefined && first.at < hold.releasedAt}; before the request even arrived: ${first !== undefined && hold !== undefined && first.at < hold.arrivedAt}`,
        lines: first ? around(first.lines, first.row.index) : [],
        data: { firstRowEffort: first?.row.effort, lastRowEffort: last?.row.effort },
      });
      if (job.kind === "local" && gone && first) {
        // Recorded only: the prompt box is bottom-anchored, so its top line with and without the row is the same and the
        // row takes the line above it; the transcript here is too short to show a blank line left by an empty box.
        const lines = gone.lines;
        const metaNow = rootMetaIndex(lines);
        const topNow = metaNow >= 0 ? composerTop(lines, metaNow) : -1;
        set("gap", {
          pass: topNow === top && first.row.index === top - 1 && !findRow(lines),
          detail: `prompt box top line ${top} with the row (row on line ${first.row.index}) and ${topNow} without it; line above the box without the row: ${JSON.stringify(lines[topNow - 1]?.slice(0, 100).trim() ?? "")}`,
          lines: topNow >= 0 ? lines.slice(Math.max(0, topNow - 4), metaNow + 3) : tail(lines),
        });
      }
    });

    // ---- S3 (G2), local flow only ----
    let g2: { running: Row; idle?: Row } | undefined;
    if (job.kind === "local") {
      await step("S3-G2", async () => {
        const childMarker = `${HOLD_MARKER} two`;
        provider.holdMarked(HOLD_MARKER, 30_000);
        await delegate(t, provider, "tui smoke two", childMarker);
        const g3 = await t.waitScreen("S3: G3 row of the second delegation", findRow, 30_000);
        const view = await openChildView(t, provider, "tui smoke two", childMarker, "S3");
        g2 = { running: view.child.row, idle: view.idle.row };
        set("S3-G2", {
          pass: view.running && view.child.row.effort.length > 0 && /sonnet/i.test(view.child.row.model) && view.idle.row !== undefined && rowCount(view.child.lines) === 1,
          detail: `child view row ${JSON.stringify(view.child.row.line)} while the child is held (running: ${view.running}); after the answer ${JSON.stringify(view.idle.row?.line)}; picker running entries ${JSON.stringify(view.picker)}; G3 row before navigating ${JSON.stringify(g3.value.line)}`,
          lines: around(view.child.lines, view.child.row.index, 8, 6),
          data: { idleScreen: view.idle.row ? around(view.idle.lines, view.idle.row.index, 6, 6) : tail(view.idle.lines) },
        });
      });
    }

    // ---- S4 (both flows) ----
    await step("S4-effort", async () => {
      const g3Effort = flow.checks["A6"]?.data?.lastRowEffort as string | undefined;
      const wire = provider.requests.filter(r => r.agent === "fast");
      const wireOk = wire.length >= (job.kind === "local" ? 2 : 1) && wire.every(r => effectiveEffort(r) === TUI_PRESET.fast.effort && (r.catalogModel ?? "").endsWith(`#${TUI_PRESET.fast.variant}`));
      const screens = job.kind === "local" ? [g3Effort, g2?.running.effort, g2?.idle?.effort] : [g3Effort];
      set("S4-effort", {
        pass: screens.every(e => e === EXPECTED_CHILD_EFFORT) && wireOk,
        detail: `expected ${JSON.stringify(EXPECTED_CHILD_EFFORT)} (fast tier effort ${TUI_PRESET.fast.effort}, variant ${TUI_PRESET.fast.variant}); G3 ${JSON.stringify(g3Effort)}${job.kind === "local" ? `, G2 running ${JSON.stringify(g2?.running.effort)}, G2 idle ${JSON.stringify(g2?.idle?.effort)}` : ""}; wire ${JSON.stringify(wire.map(r => `${r.catalogModel} effort=${String(effectiveEffort(r))}`))}`,
        lines: [g2?.running.line ?? "", g2?.idle?.line ?? ""].filter(Boolean),
      });
    });
  } catch (error) {
    flow.errors.push(`flow: ${message(error)}`);
  } finally {
    clearTimeout(hardStop);
    await attempt("stop", async () => { if (tui) flow.stop = await tui.stop(); });
    await attempt("provider records", async () => {
      const childSessions = new Set(provider.holds.map(h => h.session).filter((s): s is string => typeof s === "string"));
      flow.holds = provider.holds.map(h => ({ ...h }));
      flow.childWire = provider.requests.filter(r => r.agent === "fast" || (r.session !== undefined && childSessions.has(r.session))).map(r => ({ seq: r.seq, session: r.session, agent: r.agent, catalogModel: r.catalogModel, wireModel: r.model, effort: effectiveEffort(r) }));
      flow.requests = provider.requests.map(r => ({ seq: r.seq, session: r.session, agent: r.agent, kind: r.kind, catalogModel: r.catalogModel, tools: r.toolNames.length, reply: r.reply, lastText: r.lastText.slice(0, 60) }));
      // A tool-less auxiliary request (the host's session title) whose text quotes SPIKE_CALL makes the fixture refuse it (400):
      // expected noise of a TUI-created session, kept apart from real provider errors.
      const auxiliary = (e: string) => /carries no such tool \(\)/.test(e);
      flow.notes = provider.errors.filter(auxiliary).map(e => `auxiliary request refused by the fixture: ${e}`);
      const real = provider.errors.filter(e => !auxiliary(e));
      if (real.length > 0) flow.errors.push(`provider: ${real.join(" | ")}`);
    });
    await attempt("provider stop", () => provider.stop());
    await attempt("cleanup", () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
    await attempt("summary", async () => writeFileSync(path.join(OUT, `${RUN8}-${job.label}-${job.kind}.summary.json`), redactText(JSON.stringify(flow, null, 2))));
  }
  return flow;
}

/** At most `limit` holders at once (FIFO). */
class Slots {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async take(): Promise<void> { if (this.free > 0) { this.free -= 1; return; } await new Promise<void>(resolve => this.waiting.push(resolve)); }
  give(): void { const next = this.waiting.shift(); if (next) next(); else this.free += 1; }
}

const TITLE = `TUI status on real OpenCode v2 hosts (#90 P2.1)${WINDOWS ? "" : " — skipped: Windows only (ConPTY, taskkill, Win32_Process)"}`;
const d = RUN && WINDOWS ? describe : describe.skip;
d(TITLE, () => {
  const flows: Promise<Flow>[] = [];
  let startIdentities = new Set<string>();
  let pidsBefore: number[] = [];
  let batch: Obj | undefined;
  const settledFlows = async () => (await Promise.allSettled(flows)).map((r, i) => (r.status === "fulfilled" ? r.value : { index: i, label: JOBS[i]!.label, kind: JOBS[i]!.kind, exe: JOBS[i]!.exe, checks: {}, errors: [`flow rejected: ${message(r.reason)}`], logFile: "" } as Flow));
  const batchRecord = async (): Promise<Obj> => {
    if (batch) return batch;
    const done = await settledFlows();
    await delay(1_000);
    const after = await processTable();
    const pidsAfter = opencodePids(after);
    const own = done.flatMap(f => f.stop?.tree ?? []);
    const row = (p: ProcessRow) => ({ pid: p.ProcessId, parent: p.ParentProcessId, name: p.Name, created: p.CreationDate });
    batch = {
      runId: RUN_ID, worker: process.pid, tableAfterRead: after.length > 0,
      ownTrees: own.map(row),
      // R2-2: left behind = a child of this test worker (the pty hosts, npm, process queries) that was not present at the start.
      leftovers: after.filter(p => p.ParentProcessId === process.pid && !startIdentities.has(identity(p))).map(row),
      // Overlap by pid + creation time only (a bare pid can be reused).
      ownOverlapStartIdentities: own.filter(p => startIdentities.has(identity(p))).map(row),
      info: { opencodePidsBefore: pidsBefore, opencodePidsAfter: pidsAfter, opencodeNewAfter: pidsAfter.filter(p => !pidsBefore.includes(p)), opencodeGone: pidsBefore.filter(p => !pidsAfter.includes(p)) },
    };
    writeFileSync(path.join(OUT, `${RUN8}-pids.json`), JSON.stringify(batch, null, 2));
    return batch;
  };

  beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    const start = await processTable();
    if (start.length === 0) throw new Error("the start-of-run process table is empty: refusing to run hosts without a baseline");
    startIdentities = new Set(start.map(identity));
    pidsBefore = opencodePids(start);
    const run = JOBS.some(j => j.kind === "npm") ? npmRun() : undefined;
    const pack = run ? packOnce(run) : Promise.resolve("");
    pack.catch(() => {});
    const slots = new Slots(MAX_HOSTS);
    for (const job of JOBS) {
      const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), `omr-tui-${job.label}-${job.kind}-`)));
      // The install runs outside the host slots (no host yet); the flow waits for it after taking a slot.
      const plugin = job.kind === "npm" && run ? pack.then(tgz => installInto(run, root, tgz)) : Promise.resolve(ROOT);
      plugin.catch(() => {});
      flows[job.index] = (async () => {
        if (job.kind === "npm") await plugin.catch(() => undefined);
        await slots.take();
        try {
          await delay(job.index < MAX_HOSTS ? job.index * 3_000 : 1_000);
          return await runFlow(job, root, plugin);
        } finally { slots.give(); }
      })();
    }
  }, 60_000);
  // Three flows per version share at most MAX_HOSTS slots: a slot may run three flows back to back.
  afterAll(async () => { await batchRecord(); }, 3 * FLOW_MS + INSTALL_MS);

  const opts = { timeout: 3 * FLOW_MS + INSTALL_MS };
  for (const target of TARGETS) {
    describe(`OpenCode ${target.label}`, () => {
      if (!target.present) {
        it.skip(`skipped: executable not found (${target.exe})`, () => undefined);
        return;
      }
      for (const job of JOBS.filter(j => j.exe === target.exe)) {
        describe(FLOW_TITLES[job.kind], () => {
          const flowOf = () => flows[job.index]!;
          const check = async (id: CheckId) => {
            const flow = await flowOf();
            const c = flow.checks[id];
            expect(c, `${id} not reached; errors: ${flow.errors.join(" || ")}`).toBeDefined();
            expect(c!.pass, `${id}: ${c!.detail}\n${c!.lines.join("\n")}`).toBe(true);
          };
          it("boots with the plugin's footer on the home screen", opts, async () => { await check("boot"); });
          it("S1 G1: home footer shows `effort default` (one plugin registration)", opts, async () => { await check("S1-default"); });
          if (job.kind === "local") {
            it("S1 G1: a selected variant shows in the host row and the plugin shows no effort", opts, async () => { await check("S1-variant"); });
            it("S1 G1: cycling back to no variant restores `effort default`", opts, async () => { await check("S1-restore"); });
          }
          if (job.kind === "off") {
            it("A12 default: no running-delegate row in the root view while the held child runs; footer still `effort default`", opts, async () => { await check("A12-no-row"); });
            it(`A12 default: G2 still shows \`fast · <model> · ${EXPECTED_CHILD_EFFORT}\` in the child's own view while it runs`, opts, async () => { await check("A12-G2"); });
          } else {
            it("S2 G3: a running-delegate row directly above the prompt box while the child runs, gone after", opts, async () => { await check("S2-G3"); });
            it("S2 A6: the row is on screen before the child's first token", opts, async () => { await check("A6"); });
            if (job.kind === "local") it("S3 G2: the child's own view shows `fast · <model> · <effort>` while it runs", opts, async () => { await check("S3-G2"); });
            it(`S4: the child's effort is the fast tier's (${EXPECTED_CHILD_EFFORT}) on screen and on the wire`, opts, async () => { await check("S4-effort"); });
          }
          if (job.kind === "local") {
            it("recorded: sidebar toggled and back, empty-box gap", opts, async () => {
              const flow = await flowOf();
              expect(flow.checks.sidebar, `sidebar not recorded; errors: ${flow.errors.join(" || ")}`).toBeDefined();
              expect(flow.checks.sidebar!.pass, flow.checks.sidebar!.detail).toBe(true);
              expect(flow.checks.gap, `gap not recorded; errors: ${flow.errors.join(" || ")}`).toBeDefined();
            });
          }
          it("teardown: only this flow's processes were killed, children first, and none survive", opts, async () => {
            const flow = await flowOf();
            const stop = flow.stop;
            expect(stop, `no stop record; errors: ${flow.errors.join(" || ")}`).toBeDefined();
            expect(stop!.errors).toEqual([]);
            expect(stop!.pid).toBeGreaterThan(4);
            expect(stop!.tree[0]?.ProcessId).toBe(stop!.pid);
            const members = new Set(stop!.tree.map(identity));
            for (const k of stop!.kills) expect(members.has(`${k.pid}@${k.created}`), `kill record outside the tree: ${JSON.stringify(k)}`).toBe(true);
            const rootKills = stop!.kills.filter(k => k.role === "root" && k.action === "killed");
            expect(rootKills.length).toBe(1);
            // Children first: within the root's round, the root's record is the last one.
            const round = stop!.kills.filter(k => k.round === rootKills[0]!.round);
            expect(round.at(-1)?.role).toBe("root");
            expect(stop!.tree.filter(p => startIdentities.has(identity(p))).map(p => p.ProcessId)).toEqual([]);
            expect(stop!.survivors).toEqual([]);
            // R2-3: descendants found after the kill rounds are reported, never killed; any fails the teardown.
            expect(stop!.strays, `processes left by the tree: ${JSON.stringify(stop!.strays)}`).toEqual([]);
          });
        });
      }
    });
  }

  it("batch teardown: no new child of the test worker left behind, no own process (pid + creation time) present at the start", opts, async () => {
    const record = await batchRecord();
    expect(record.tableAfterRead).toBe(true);
    expect(record.leftovers).toEqual([]);
    expect(record.ownOverlapStartIdentities).toEqual([]);
  });
});
