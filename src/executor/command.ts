/**
 * `/plan` slash command (v2 only, registered by Phase 5.1). The factory turns the typed subcommand into orchestrator
 * instructions: they name the `router_plan` action to call and its exact arguments. Unknown or malformed input prints
 * the `/plan` help instead.
 */
import { buildPlanHelp } from "../commands/output.js";
import type { ExecutorRuntime } from "./types.js";

/** Arguments of one `router_plan` call, as built from a `/plan` line. */
export type PlanCallArgs =
  | { action: "compile"; path: string; phases?: string[]; doneBefore?: string }
  | { action: "status"; planId?: string; inbox?: true }
  | { action: "answer"; planId?: string; inboxId: string; text: string }
  | { action: "approve" | "pause" | "resume" | "abort" | "land" | "adopt"; planId: string };

export type ParsedPlanCommand =
  | { kind: "call"; call: PlanCallArgs }
  | { kind: "help"; reason: string | null };

interface Token {
  value: string;
  /** Offset of the token's first character (the opening quote when quoted) and one past its last. */
  start: number;
  end: number;
  quoted: boolean;
  /** A quote in it has no closing quote: the token then runs to the end of the input (QA-4.1-11). */
  unterminated: boolean;
}

/**
 * Whitespace-separated tokens. A `"…"` or `'…'` run is one token with the quotes removed and may hold spaces (a Windows path
 * such as `"C:\My Plans\x.md"`). Backslashes are literal: there are no escapes. An unterminated quote runs to the end and
 * marks the token `unterminated`; every subcommand refuses such a token except in the free answer text.
 */
function tokenize(input: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i] ?? "")) {
      i++;
      continue;
    }
    const start = i;
    let value = "";
    let quoted = false;
    let unterminated = false;
    while (i < input.length && !/\s/.test(input[i] ?? "")) {
      const ch = input[i] as string;
      if (ch === '"' || ch === "'") {
        quoted = true;
        const close = input.indexOf(ch, i + 1);
        if (close === -1) unterminated = true;
        const stop = close === -1 ? input.length : close;
        value += input.slice(i + 1, stop);
        i = close === -1 ? input.length : close + 1;
      } else {
        value += ch;
        i++;
      }
    }
    out.push({ value, start, end: i, quoted, unterminated });
  }
  return out;
}

const help = (reason: string | null = null): ParsedPlanCommand => ({ kind: "help", reason });

const UNTERMINATED =
  "unterminated quote: a ' or \" starts a quoted argument and needs a closing quote (wrap a path that holds ' in \"…\")";

/** Help for the first unterminated token among `tokens`, or null when every quote is closed. */
function unterminated(tokens: readonly Token[]): ParsedPlanCommand | null {
  return tokens.some((t) => t.unterminated) ? help(UNTERMINATED) : null;
}

/**
 * `--phases` takes comma-separated phase ids (QA-4.1-15): `--phases 1.1,1.2`. A space between ids is refused (null), so
 * `--phases 1.1 1.2` never silently drops `1.2`.
 */
function phaseIds(raw: string): string[] | null {
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return list.some((s) => /\s/.test(s)) ? null : list;
}

const PHASES_FORMAT = "--phases takes comma-separated phase ids without spaces, for example --phases 1.1,1.2";

function parseRun(tokens: Token[]): ParsedPlanCommand {
  let path: string | undefined;
  let phases: string[] | undefined;
  let doneBefore: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const flag = t.quoted ? null : /^(--phases|--done-before)(?:=(.*))?$/.exec(t.value);
    if (flag === null) {
      if (!t.quoted && t.value.startsWith("--")) return help(`unknown option ${t.value}`);
      if (path !== undefined) {
        return help(`unexpected argument ${t.value}${phases !== undefined ? ` (${PHASES_FORMAT})` : ""}`);
      }
      path = t.value;
      continue;
    }
    let value = flag[2];
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined) return help(`${flag[1]} needs a value`);
      value = next.value;
      i++;
    }
    if (flag[1] === "--phases") {
      const list = phaseIds(value);
      if (list === null) return help(PHASES_FORMAT);
      if (list.length === 0) return help("--phases needs at least one phase id");
      phases = list;
    } else {
      const id = value.trim();
      if (id.length === 0) return help("--done-before needs a phase id");
      doneBefore = id;
    }
  }
  if (path === undefined || path.length === 0) return help("/plan run needs a plan path");
  const call: PlanCallArgs = { action: "compile", path };
  if (phases !== undefined) call.phases = phases;
  if (doneBefore !== undefined) call.doneBefore = doneBefore;
  return { kind: "call", call };
}

/**
 * A leading `--plan <planId>` (or `--plan=<planId>`) of `/plan inbox` and `/plan answer` (QA-4.1-5): the plan id and the
 * number of tokens it took; `used: 0` when absent; a help when it has no id.
 */
function planFlag(rest: readonly Token[]): { planId?: string; used: number } | ParsedPlanCommand {
  const t = rest[0];
  const m = t === undefined || t.quoted ? null : /^--plan(?:=(.*))?$/.exec(t.value);
  if (m === null) return { used: 0 };
  if (m[1] !== undefined) return m[1].length > 0 ? { planId: m[1], used: 1 } : help("--plan needs a plan id");
  const next = rest[1];
  if (next === undefined || next.value.length === 0) return help("--plan needs a plan id");
  return { planId: next.value, used: 2 };
}

/** Parse the text after `/plan`. Pure: no I/O. */
export function parsePlanCommand(args: string): ParsedPlanCommand {
  const tokens = tokenize(args);
  const sub = tokens[0]?.value.toLowerCase();
  const rest = tokens.slice(1);
  // The answer text is kept as typed (an apostrophe in it is fine); every other token must close its quotes.
  if (sub !== "answer") {
    const bad = unterminated(tokens);
    if (bad !== null) return bad;
  }
  switch (sub) {
    case "run":
      return parseRun(rest);
    case "status": {
      if (rest.length > 1) return help("/plan status takes at most one plan id");
      const planId = rest[0]?.value;
      return { kind: "call", call: planId === undefined ? { action: "status" } : { action: "status", planId } };
    }
    case "inbox": {
      const f = planFlag(rest);
      if ("kind" in f) return f;
      if (rest.length > f.used) return help("/plan inbox takes only --plan <planId>");
      const call: PlanCallArgs = { action: "status", inbox: true };
      if (f.planId !== undefined) call.planId = f.planId;
      return { kind: "call", call };
    }
    case "answer": {
      const f = planFlag(rest);
      if ("kind" in f) return f;
      // `--plan <planId>` and the item id must close their quotes; only the text after them is free.
      const bad = unterminated(rest.slice(0, f.used + 1));
      if (bad !== null) return bad;
      const id = rest[f.used];
      const first = rest[f.used + 1];
      if (id === undefined || first === undefined) return help("/plan answer needs an id and the answer text");
      const last = rest[rest.length - 1] as Token;
      // The text is kept as typed; a single, properly quoted token is unwrapped.
      const unwrap = rest.length === f.used + 2 && first.quoted && !first.unterminated;
      const text = unwrap ? first.value : args.slice(first.start, last.end);
      const call: PlanCallArgs = { action: "answer", inboxId: id.value, text };
      if (f.planId !== undefined) call.planId = f.planId;
      return { kind: "call", call };
    }
    case "approve":
    case "pause":
    case "resume":
    case "abort":
    case "land":
    case "adopt": {
      const planId = rest[0]?.value;
      if (planId === undefined || rest.length > 1) return help(`/plan ${sub} needs exactly one plan id`);
      return { kind: "call", call: { action: sub, planId } };
    }
    default:
      return help();
  }
}

/**
 * What to do with the `router_plan action=compile` result (QA-4.1-1, QA-4.1-7): compiling never starts a plan; a
 * residue step goes to an architect, and approval is the user's.
 */
const COMPILE_FOLLOW_UP: readonly string[] = [
  "Then act on the `status:` line of the result:",
  "- `awaiting-residue`: dispatch the residue prompt of the result, unchanged, to an architect subagent (architect role, " +
    "or heavy tier); then call `router_plan` with `action=residue`, the `planId` of the result and `text=<its complete " +
    "JSON reply>`, and act on that result's `status:` line the same way.",
  "- `awaiting-approval`: show the summary to the user and wait for their approval. Call `router_plan action=approve` " +
    "only after the user explicitly approves in this conversation, or when the user types `/plan approve <planId>`.",
  "- anything else (approved and running, or a refusal): report the tool result to the user verbatim.",
  "Do nothing else for this command.",
];

/** The orchestrator instruction for one parsed call. */
export function planInstructions(call: PlanCallArgs): string {
  const intro =
    call.action === "compile"
      ? "Call the `router_plan` tool once with exactly these arguments to compile the plan:"
      : "Call the `router_plan` tool once with exactly these arguments:";
  return [
    intro,
    "",
    "```json",
    JSON.stringify(call),
    "```",
    "",
    ...(call.action === "compile"
      ? COMPILE_FOLLOW_UP
      : ["Then report the tool result to the user verbatim. Do nothing else for this command."]),
  ].join("\n");
}

export interface PlanCommand {
  readonly name: "plan";
  readonly description: string;
  /** The command text for `/plan <args>`: orchestrator instructions, or the help text. */
  execute(args: string): string;
}

/** Factory of the `/plan` command; registration is Phase 5.1's job. */
export function createPlanCommand(_runtime: ExecutorRuntime): PlanCommand {
  return {
    name: "plan",
    description: "Run and manage a plan with the plan executor",
    execute(args: string): string {
      const parsed = parsePlanCommand(args);
      if (parsed.kind === "call") return planInstructions(parsed.call);
      const text = buildPlanHelp();
      return parsed.reason === null ? text : `${parsed.reason}\n\n${text}`;
    },
  };
}
