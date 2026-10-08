/**
 * The roles-mode `R:` line (plan #84 T2.2.1): task class → role agent.
 *
 * A leaf module (QA-P22-1-11): it imports only `TASK_CLASSES` and types, so `src/router/protocol.ts` can build the
 * roles protocol without importing the routing engine (`protocol-line.ts` imports `protocol.ts`, which would make a
 * cycle). `protocol-line.ts` re-exports both names.
 *
 * Pure: no I/O, no clock, no randomness, no module state.
 */

import type { RoleKind, RoleSpec } from "../../router/roles";
import { TASK_CLASSES, type TaskClass } from "../classify/types";

/**
 * The role kind that does each task class in roles mode (plan §2.2). `runner` and `researcher` have no class of
 * their own: the orchestrator picks them by intent (running checks, web research) from the role menu.
 */
export const CLASS_ROLE_KIND: Readonly<Record<TaskClass, RoleKind>> = Object.freeze({
  search: "explore",
  recon: "explore",
  mechanical: "implement",
  implement: "implement",
  debug: "implement",
  design: "design",
  review: "review",
  other: "general",
});

/**
 * The roles-mode `R:` line: each class → the enabled role agent of {@link CLASS_ROLE_KIND}, else `general`, else
 * the class is left out. Classes sharing an agent are grouped (`search/recon→explorer`), in `TASK_CLASSES` order;
 * of two enabled agents of one kind the first by name wins. Depends on the table only (no tiers, no models, no
 * evidence), so the text is stable for the whole session. "" when no class has an agent.
 */
export function generateRolesTaxonomy(roles: ReadonlyMap<string, RoleSpec>): string {
  const byKind = new Map<RoleKind, string>();
  for (const spec of roles.values()) {
    if (spec.enabled !== true) continue;
    const held = byKind.get(spec.kind);
    if (held === undefined || spec.agent < held) byKind.set(spec.kind, spec.agent);
  }
  const groups = new Map<string, TaskClass[]>();
  for (const cls of TASK_CLASSES) {
    const agent = byKind.get(CLASS_ROLE_KIND[cls]) ?? byKind.get("general");
    if (agent === undefined) continue;
    const classes = groups.get(agent);
    if (classes === undefined) groups.set(agent, [cls]);
    else classes.push(cls);
  }
  if (groups.size === 0) return "";
  return `R: ${[...groups].map(([agent, classes]) => `${classes.join("/")}→${agent}`).join(" ")}`;
}
