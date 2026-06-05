/**
 * probe-plugin.js — THROWAWAY capability probe for opencode SDK.
 * Tests: (A) tool.execute.before throw aborts, (B) custom tool return, (C) event types.
 * Delete after spike.
 */

import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs";
import * as path from "node:path";

const LOG_DIR = "D:\\git\\opencode-model-router\\tmp\\probe";
const LOG_FILE = path.join(LOG_DIR, "probe-events.log");

function appendLog(obj) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + "\n", "utf8");
  } catch {
    /* best-effort: never crash */
  }
}

// Log at module load time
appendLog({ ev: "plugin_loaded", ts: Date.now() });

const z = tool.schema;

const probeEcho = tool({
  description:
    "Probe tool: echoes a value back. Returns the string PROBE_ECHO_OK:<value>.",
  args: {
    value: z.string().describe("The value to echo"),
  },
  async execute(args) {
    appendLog({ ev: "echo_execute", value: args.value });
    return `PROBE_ECHO_OK:${args.value}`;
  },
});

const probeBlockMe = tool({
  description:
    "Probe tool: SHOULD be blocked by the before-hook. If execute runs, the block failed.",
  args: {
    reason: z.string().describe("Why this tool is being called"),
  },
  async execute(args) {
    appendLog({ ev: "block_execute_REACHED", reason: args.reason });
    return "PROBE_BLOCK_REACHED";
  },
});

export const ProbePlugin = async () => {
  appendLog({ ev: "factory_called", ts: Date.now() });

  return {
    tool: {
      probe_echo: probeEcho,
      probe_block_me: probeBlockMe,
    },

    "tool.execute.before": async (input, output) => {
      appendLog({
        ev: "before",
        tool: input?.tool,
        sessionID: input?.sessionID,
        callID: input?.callID,
      });
      if (input?.tool === "probe_block_me") {
        appendLog({ ev: "before_throw" });
        throw new Error(
          "PROBE_BLOCKED: before-hook aborted this call (capability A)."
        );
      }
    },

    "tool.execute.after": async (input, output) => {
      appendLog({
        ev: "after",
        tool: input?.tool,
        sessionID: input?.sessionID,
      });
    },

    event: async ({ event }) => {
      try {
        const props = event?.properties ?? {};
        appendLog({
          ev: "event",
          type: event?.type,
          sessionID: props?.sessionID ?? null,
          parentID: props?.parentID ?? null,
          messageID: props?.messageID ?? null,
        });
      } catch {
        /* best-effort */
      }
    },
  };
};

export default ProbePlugin;
