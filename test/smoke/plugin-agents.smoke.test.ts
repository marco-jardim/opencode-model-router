/**
 * Real-host smoke for the plugin `agents` block (#81), on an isolated OpenCode v2 host (isolated HOME/XDG, never the
 * live config or store). The GLOBAL router override defines `reviewer` (readOnly) and `runner` (explicit permission).
 * Gated like the other routing smokes: RUN_OC_SMOKE_ROUTING=1. Writes no evidence files.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODELS, RoutingHost, arr, obj, stopAllHosts, type ModelRef, type Obj } from "./helpers/routing-host";

const RUN = process.env.RUN_OC_SMOKE_ROUTING === "1";
const d = RUN ? describe : describe.skip;

afterAll(async () => { await stopAllHosts(); }, 60_000);

const AGENTS = {
  reviewer: { tier: "heavy", description: "Reviews diffs read-only", readOnly: true, allowTools: ["router_git_*"] },
  runner: {
    tier: "fast", description: "Runs the tests, never edits",
    permission: { read: "allow", glob: "allow", grep: "allow", shell: { "*": "deny", "npm test*": "allow" }, edit: "deny" },
  },
};

const split = (model: string): { providerID: string; id: string } => {
  const [providerID, ...rest] = model.split("/");
  return { providerID: providerID!, id: rest.join("/") };
};
const sameModel = (m: ModelRef | undefined, want: string, variant: string) =>
  m?.providerID === split(want).providerID && m.id === split(want).id && m.variant === variant;

d("plugin agents on the real OpenCode v2 host (#81)", () => {
  it("registers reviewer and runner as protected subagents and refuses shell/edit at the host", async () => {
    const host = await RoutingHost.start("plugin-agents", { routing: null, overrides: { agents: AGENTS } });
    try {
      execFileSync("git", ["init", "-q", host.project], { shell: false, windowsHide: true });
      const target = path.join(host.project, "agents-probe.txt");
      await writeFile(target, "ORIGINAL\n");

      // ---- the host's agent list ----
      const list = (await host.client.agent.list()).data;
      const reviewer = list.find(a => a.id === "reviewer");
      const runner = list.find(a => a.id === "runner");
      expect(reviewer?.mode).toBe("subagent");
      expect(runner?.mode).toBe("subagent");
      expect(sameModel(reviewer?.model, MODELS.opus, "xhigh"), JSON.stringify(reviewer?.model)).toBe(true);
      expect(sameModel(runner?.model, MODELS.sonnet, "low"), JSON.stringify(runner?.model)).toBe(true);
      const rules = (agent: typeof reviewer) => arr(agent?.permissions).map(obj);
      for (const agent of [reviewer, runner]) {
        expect(rules(agent).some(r => r.action === "*" && r.resource === "*" && r.effect === "allow")).toBe(false);
        expect(rules(agent).some(r => r.action === "*" && r.resource === "*" && r.effect === "deny")).toBe(true);
      }
      expect(rules(reviewer).some(r => r.action === "router_git_*" && r.effect === "allow")).toBe(true);
      expect(rules(runner).some(r => r.action === "shell" && r.resource === "npm test*" && r.effect === "allow"), JSON.stringify(rules(runner))).toBe(true);
      expect(rules(runner).some(r => r.action === "edit" && r.effect === "deny")).toBe(true);

      // ---- children: the host refuses ----
      const probes: Array<{ agent: string; tool: string; input: Obj }> = [
        { agent: "reviewer", tool: "shell", input: { command: "echo WRITE_ATTEMPT > agents-probe.txt", workdir: host.project } },
        { agent: "reviewer", tool: "edit", input: { path: target, oldString: "ORIGINAL", newString: "WRITE_ATTEMPT" } },
        { agent: "runner", tool: "edit", input: { path: target, oldString: "ORIGINAL", newString: "WRITE_ATTEMPT" } },
        { agent: "runner", tool: "shell", input: { command: "echo WRITE_ATTEMPT > agents-probe.txt", workdir: host.project } },
      ];
      for (const probe of probes) {
        // The parent session allows everything: only the agent's own policy can refuse.
        const root = await host.newRoot(`agents ${probe.agent} ${probe.tool}`, undefined, host.project);
        const result = await host.dispatch(root, {
          agent: probe.agent, description: `agents ${probe.agent} ${probe.tool}`,
          prompt: `READ_ONLY_PROBE=${JSON.stringify({ tool: probe.tool, input: probe.input })}`, background: false,
        });
        const names = host.requestsOf(result.childID).filter(r => r.kind === "primary")[0]?.toolNames ?? [];
        const hooks = (await host.hooks()).filter(h => h.sessionID === result.childID && h.tool === probe.tool && h.hook === "after");
        const messages = await host.client.session.context({ sessionID: result.childID });
        const states = messages.flatMap(message => arr(obj(message).content).map(obj)).filter(part => part.type === "tool").map(part => obj(part.state));
        const context = JSON.stringify(states);
        const label = `${probe.agent}/${probe.tool}`;
        const absent = !names.includes(probe.tool);
        const denied = states.some(state => state.status === "error" && /Permission denied|BlockedError/i.test(String(obj(state.error).message)));
        const unavailable = states.some(state => state.status === "error"
          && [`No tool named "${probe.tool}"`, `Tool is not available for this request: ${probe.tool}`].some(m => String(obj(state.error).message).includes(m)));
        expect(absent || denied, `${label}: advertised=${JSON.stringify(names)} states=${context}`).toBe(true);
        if (absent) expect(denied || unavailable || states.length === 0, `${label}: ${context}`).toBe(true);
        expect(hooks.some(h => h.status === "completed"), `${label}: ${JSON.stringify(hooks)}`).toBe(false);
        expect(await readFile(target, "utf8")).toBe("ORIGINAL\n");
        expect(await host.children(result.childID)).toHaveLength(0);
      }
      expect(existsSync(path.join(host.project, "NOT_CREATED"))).toBe(false);
      expect(host.provider.errors).toEqual([]);
    } finally {
      const teardown = await host.stop();
      expect(teardown.hostPortClosed && teardown.providerStopped && teardown.rootRemoved).toBe(true);
    }
  }, 300_000);
});
