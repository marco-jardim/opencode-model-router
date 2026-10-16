import type { RunConfig } from "../../router/roles";
import { planRun, type RunHost } from "../../router/run-tools";
import type { RunResolver } from "./checks";

/** Router authorization and slot tool lookup, repeated against each prepared execution checkout by checks. */
export function createRunResolver(config: () => RunConfig, host: RunHost = { platform: process.platform, env: process.env }): RunResolver {
  return {
    async resolve(ref, cwd) {
      try {
        const plan = planRun({ script: ref.script, args: ref.args, cwd }, cwd, config(), host);
        return { ok: true, command: { label: ref.script, file: plan.executable, args: plan.argv,
          source: plan.kind === "script" ? "package-script" : "run-command", ref, resolution: { cwd: plan.cwd,
            env: Object.fromEntries(Object.entries(plan.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) } } };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
