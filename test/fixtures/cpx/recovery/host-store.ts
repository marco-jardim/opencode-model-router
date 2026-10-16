// Disk-backed host session store shared by the host simulator (test process) and the plugin-side executor child process
// (restart-child.ts). Sessions live as one JSON file each, so they survive a killed executor process.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executorHostContext } from "../../../../src/compat/v2-hooks.js";
import type { HostSessionContext } from "../../../../src/executor/types.js";

/** QA-4.2-1: the v2 host's one line before every native subagent's first user message. */
export const HOST_SUBAGENT_PREAMBLE_LINE = "You are a subagent spawned by another session.\n";

/**
 * QA-4.2-2: one entry of the v2 host's own session history (`ctx.session.context`), the shape the executor's
 * `HostSessions.context` adapter reads: entries discriminated by `type`; an assistant step that ended carries `finish` and
 * `time.completed`, a failed one `error`; a tool turn is its own entry.
 */
export interface StoredMessage {
  type: "user" | "assistant" | "tool" | "synthetic";
  text?: string;
  finish?: string;
  time?: { created: number; completed?: number };
  error?: { name: string; message?: string };
  parts?: Array<{ type: "tool"; tool: string; state: { status: "running" | "completed" } }>;
}

/** The launch prompt as the v2 host stores a native subagent's first user message (with its preamble line). */
export function userPromptMessage(prompt: string): StoredMessage {
  return { type: "user", text: `${HOST_SUBAGENT_PREAMBLE_LINE}${prompt}` };
}

/** A child's answer step that ended (the v2 host's completion markers). */
export function finishedAnswer(text: string, at: number): StoredMessage {
  return { type: "assistant", text, finish: "stop", time: { created: at, completed: at } };
}

/** What the v2 host records when it interrupts a busy child: the step ends with an abort error. */
export function interruptedStep(at: number): StoredMessage {
  return { type: "assistant", error: { name: "MessageAbortedError", message: "aborted" }, time: { created: at, completed: at } };
}

/** A child cut mid-tool-call: its step asked for a tool (`tool-calls`), the tool turn still runs. */
export function midToolCall(at: number): StoredMessage[] {
  return [
    { type: "assistant", text: "", finish: "tool-calls", time: { created: at }, parts: [{ type: "tool", tool: "bash", state: { status: "running" } }] },
    { type: "tool" },
  ];
}

/** How a simulated child behaves (the test's scenario table). */
export type ChildScript = "normal" | "alive" | "dead" | "finish-while-down";

/** Kill points (memo phase-4.2 §10). */
export type KillPoint = "K1" | "K2" | "K3";

/** What the test hands the executor child process (one JSON file; argv[2] of restart-child). */
export interface ChildConfig {
  /** Executor home (ledger, markers), the repo toplevel, the slots dir, the repo-lock state root. */
  home: string;
  toplevel: string;
  slotsDir: string;
  lockRoot: string;
  /** Root of the disk-backed host session store. */
  hostRoot: string;
  planId: string;
  baseBranch: string;
  baseCommit: string;
  orchestrator: string;
  /** 0 for the first process, 1 for the restarted one. */
  run: number;
  /** Arms one kill point in this run (null: never park); `task` names the task whose commit (K3) is the point. */
  kill: { point: KillPoint; task: string } | null;
  /** Per task: what its first launched child does in this run (`normal` when absent). */
  scripts: Record<string, ChildScript>;
  /** Where scripted children pause (default: tool); the host simulator can advance them before the kill. */
  stopAt?: "tool" | "provider";
  /** Per task: the file the child writes in its slot and the text it writes. */
  work: Record<string, { file: string; content: string }>;
  /** R1a seams (memo §10: 1500 / 200). */
  livenessMs: number;
  pollMs: number;
  /**
   * `HostSessions.activity`: "unknown" for every session (v2 today: probation for every in-flight child), or "scripted"
   * (variant): "active" for a child scripted `alive`, "inactive" for one scripted `dead`, "unknown" otherwise.
   */
  activity: "unknown" | "scripted";
  /** Separate variant: simulated workers stop with their launcher; wire the v2 launcher-liveness dependency. */
  launcherLiveness?: boolean;
}

/** The `activity` a session reports under `mode`. */
export function activityOf(mode: ChildConfig["activity"], s: StoredSession | null): "active" | "inactive" | "unknown" {
  if (mode === "unknown" || s === null) return "unknown";
  if (s.status === "idle") return "inactive";
  return s.script === "alive" ? "active" : s.script === "dead" ? "inactive" : "unknown";
}

export interface StoredSession {
  id: string;
  parentID: string | null;
  /** "busy" while the simulated child works, "idle" once it answered or was interrupted. */
  status: "busy" | "idle";
  messages: StoredMessage[];
  script: ChildScript;
  /** The slot the child works in and the file it writes there (relative to the slot). */
  slotPath: string;
  file: string;
  content: string;
  /** The text the child answers with once it finishes. */
  answer: string;
  /** Interrupts the host received for this session. */
  interrupted: number;
  /** Which executor run (0 = first process) created it. */
  run: number;
  /** Only the launcher-liveness variant ties the simulated worker's lifetime to a process. */
  launcherPid?: number;
  /** The worker stopped without a terminal host-history entry (e.g. cut mid-tool-call). */
  stopped?: boolean;
}

export function sessionsDir(root: string): string {
  return join(root, "host", "sessions");
}

const codeOf = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String(Reflect.get(e, "code")) : "";

/** Windows: a rename over, or a read of, a file the other process has open fails transiently (EPERM/EBUSY/EACCES). */
async function retrying<T>(op: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await op();
    } catch (e) {
      if (i >= 100 || !["EPERM", "EBUSY", "EACCES"].includes(codeOf(e))) throw e;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

export async function writeSession(root: string, s: StoredSession): Promise<void> {
  const dir = sessionsDir(root);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${s.id}.json.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);
  await writeFile(tmp, JSON.stringify(s), "utf8");
  await retrying(() => rename(tmp, join(dir, `${s.id}.json`)));
}

/** null only when the session does not exist. */
export async function readSession(root: string, id: string): Promise<StoredSession | null> {
  try {
    return JSON.parse(await retrying(() => readFile(join(sessionsDir(root), `${id}.json`), "utf8"))) as StoredSession;
  } catch (e) {
    if (codeOf(e) === "ENOENT") return null;
    throw e;
  }
}

/** Appends messages to a stored session (the host simulator's and the scripted runner's only mutation besides status). */
export async function appendMessages(root: string, id: string, msgs: StoredMessage[], status?: StoredSession["status"]): Promise<StoredSession | null> {
  const s = await readSession(root, id);
  if (s === null) return null;
  const next: StoredSession = { ...s, messages: [...s.messages, ...msgs], status: status ?? s.status };
  await writeSession(root, next);
  return next;
}

/** Protocol line the test writes on the executor child's stdin for one host event. */
export function eventLine(e: unknown): string {
  return `EVENT ${JSON.stringify(e)}`;
}

/** The host's view of a stored session (`HostSessions.context`): the v2 adapter's real mapping of the stored history. */
export function contextOf(s: StoredSession): HostSessionContext {
  return executorHostContext(s.messages.map((m) => ({ ...m })));
}

export async function listSessions(root: string): Promise<StoredSession[]> {
  let names: string[] = [];
  try {
    names = await readdir(sessionsDir(root));
  } catch {
    return [];
  }
  const out: StoredSession[] = [];
  for (const n of names.filter((f) => f.endsWith(".json")).sort()) {
    const s = await readSession(root, n.slice(0, -".json".length));
    if (s !== null) out.push(s);
  }
  return out;
}
