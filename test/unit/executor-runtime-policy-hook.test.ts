import { afterEach, describe, expect, it, vi } from "vitest";
import * as qaLoop from "../../src/executor/qa-loop";
import * as unattended from "../../src/executor/unattended";
import { realCollaborators, type CollaboratorInput } from "../../src/executor/runtime";
import type { Clock, IntegrationQueue, QaLoop, UnattendedPolicy } from "../../src/executor/types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Ports realCollaborators only forwards; the policy and the QA loop factories are replaced, so nothing calls them. */
function input(patch: Partial<CollaboratorInput> = {}): CollaboratorInput {
  return {
    writer: {} as unknown as CollaboratorInput["writer"],
    leases: {} as unknown as CollaboratorInput["leases"],
    waker: {} as unknown as CollaboratorInput["waker"],
    listener: {} as unknown as CollaboratorInput["listener"],
    ...patch,
  };
}

function build() {
  const policy = {} as unknown as UnattendedPolicy;
  const qa = {} as unknown as QaLoop;
  const queue = {} as unknown as IntegrationQueue;
  const createPolicy = vi.spyOn(unattended, "createUnattendedPolicy").mockReturnValue(policy);
  vi.spyOn(qaLoop, "createQaLoop").mockReturnValue(qa);
  const seen: Array<Parameters<Parameters<typeof realCollaborators>[0]["queue"]>[0]> = [];
  const collaborators = realCollaborators({
    queue: (i) => { seen.push(i); return queue; },
    clock: {} as unknown as Clock,
    log() {},
  });
  return { collaborators, createPolicy, policy, qa, queue, seen };
}

// Regression (W4 A14): the real assembly (create.ts -> realCollaborators, fed by the runtime's `build`) must hand the
// runtime's save-before-release hook to the unattended policy, else a policy park releases the slot without saving its
// work to the task's WIP ref.
describe("executor real collaborators: unattended policy save-before-release hook", () => {
  it("passes the runtime's beforeSlotRelease and parkOptions to createUnattendedPolicy", () => {
    const h = build();
    const beforeSlotRelease: NonNullable<CollaboratorInput["beforeSlotRelease"]> = async () => true;
    const parkOptions: NonNullable<CollaboratorInput["parkOptions"]> = () => ["discard-wip", "keep-wip"];
    const c = h.collaborators(input({ beforeSlotRelease, parkOptions }));
    expect(h.createPolicy).toHaveBeenCalledTimes(1);
    const deps = h.createPolicy.mock.calls[0]?.[0];
    expect(deps?.beforeSlotRelease).toBe(beforeSlotRelease);
    expect(deps?.parkOptions).toBe(parkOptions);
    expect(deps?.qa).toBe(h.qa);
    expect(c).toEqual({ queue: h.queue, policy: h.policy, qa: h.qa });
    expect(h.seen[0]?.policy).toBe(h.policy);
    expect(h.seen[0]?.beforeSlotRelease).toBe(beforeSlotRelease);
  });

  it("builds a policy without the hook only when the caller gave none (the runtime always gives one)", () => {
    const h = build();
    h.collaborators(input());
    const deps = h.createPolicy.mock.calls[0]?.[0];
    expect(deps).toBeDefined();
    expect(deps !== undefined && "beforeSlotRelease" in deps).toBe(false);
  });
});
