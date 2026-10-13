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
  | { action: "answer"; inboxId: string; text: string }
  | { action: "pause" | "resume" | "abort" | "land" | "adopt"; planId: string };

export type ParsedPlanCommand =
  | { kind: "call"; call: PlanCallArgs }
  | { kind: "help"; reason: string | null };

interface Token {
  value: string;
  /** Offset of the token's first character (the opening quote when quoted) and one past its last. */
  start: number;
  end: number;
  quoted: boolean;
}

/**
 * Whitespace-separated tokens. A `"…"` or `'…'` run is one token with the quotes removed and may hold spaces (a Windows path
 * such as `"C:\My Plans\x.md"`). Backslashes are literal: there are no escapes. An unterminated quote runs to the end.
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
    while (i < input.length && !/\s/.test(input[i] ?? "")) {
      const ch = input[i] as string;
      if (ch === '"' || ch === "'") {
        quoted = true;
        const close = input.indexOf(ch, i + 1);
        const stop = close === -1 ? input.length : close;
        value += input.slice(i + 1, stop);
        i = close === -1 ? input.length : close + 1;
      } else {
        value += ch;
        i++;
      }
    }
    out.push({ value, start, end: i, quoted });
  }
  return out;
}

function ids(raw: string): string[] {
  return raw.split(/[,\s]+/).filter((s) => s.length > 0);
}

const help = (reason: string | null = null): ParsedPlanCommand => ({ kind: "help", reason });

function parseRun(tokens: Token[]): ParsedPlanCommand {
  let path: string | undefined;
  let phases: string[] | undefined;
  let doneBefore: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const flag = t.quoted ? null : /^(--phases|--done-before)(?:=(.*))?$/.exec(t.value);
    if (flag === null) {
      if (!t.quoted && t.value.startsWith("--")) return help(`unknown option ${t.value}`);
      if (path !== undefined) return help(`unexpected argument ${t.value}`);
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
      const list = ids(value);
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

/** Parse the text after `/plan`. Pure: no I/O. */
export function parsePlanCommand(args: string): ParsedPlanCommand {
  const tokens = tokenize(args);
  const sub = tokens[0]?.value.toLowerCase();
  const rest = tokens.slice(1);
  switch (sub) {
    case "run":
      return parseRun(rest);
    case "status": {
      if (rest.length > 1) return help("/plan status takes at most one plan id");
      const planId = rest[0]?.value;
      return { kind: "call", call: planId === undefined ? { action: "status" } : { action: "status", planId } };
    }
    case "inbox":
      if (rest.length > 0) return help("/plan inbox takes no arguments");
      return { kind: "call", call: { action: "status", inbox: true } };
    case "answer": {
      const id = rest[0];
      const first = rest[1];
      if (id === undefined || first === undefined) return help("/plan answer needs an id and the answer text");
      const last = rest[rest.length - 1] as Token;
      // The text is kept as typed; a single quoted token is unwrapped.
      const text = rest.length === 2 && first.quoted ? first.value : args.slice(first.start, last.end);
      return { kind: "call", call: { action: "answer", inboxId: id.value, text } };
    }
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

/** The orchestrator instruction for one parsed call. */
export function planInstructions(call: PlanCallArgs): string {
  const intro =
    call.action === "compile"
      ? "Call the `router_plan` tool once with exactly these arguments to compile and start the plan:"
      : "Call the `router_plan` tool once with exactly these arguments:";
  return [
    intro,
    "",
    "```json",
    JSON.stringify(call),
    "```",
    "",
    "Then report the tool result to the user verbatim. Do nothing else for this command.",
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
